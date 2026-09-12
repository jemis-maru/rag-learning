/**
 * Admin API: upload a catalog, watch it build, activate it.
 * Every route here is behind requireAdmin (mounted in server.js).
 */

import express from 'express';
import {
  countChunks,
  deleteCollection,
  getCollection,
  listCollections,
  pruneExcept,
  readBooks,
  readChunks,
  readManifest,
  searchBooks,
  setActive,
} from './collections.js';
import { getJob, startIngest } from './pipeline/run.js';
import { STRATEGIES, DEFAULT_STRATEGY } from './pipeline/chunk.js';
import { stats } from './middleware.js';
import { activeInfo, swapIndex } from './vectorStore.js';

export const adminRouter = express.Router();

/**
 * Upload is sent as a raw body rather than multipart: the payload is a single
 * text file, so a Buffer plus two query params does the whole job without
 * pulling in a multipart parser. Content-Type must be octet-stream so the
 * global express.json() leaves a .json upload alone.
 */
adminRouter.post(
  '/upload',
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res, next) => {
    const { name, format, strategy = DEFAULT_STRATEGY } = req.query;

    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ error: 'format must be "csv" or "json"' });
    }
    if (!STRATEGIES.includes(strategy)) {
      return res.status(400).json({ error: `strategy must be one of: ${STRATEGIES.join(', ')}` });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'request body is empty -- send the file contents raw' });
    }

    try {
      const job = await startIngest({
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : null,
        format,
        chunkStrategy: strategy,
        buffer: req.body,
      });
      res.status(202).json({ jobId: job.jobId, collectionId: job.collectionId });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job (jobs are kept for one hour)' });
  res.json(job);
});

adminRouter.get('/collections', async (req, res, next) => {
  try {
    res.json({ active: activeInfo(), collections: await listCollections() });
  } catch (err) {
    next(err);
  }
});

/**
 * Activate a collection, then throw the others away.
 *
 * Order matters. swapIndex() runs BEFORE the prune, so a collection that turns
 * out to be unloadable throws while the previous catalog is still on disk and
 * still serving, instead of leaving the store with nothing.
 */
adminRouter.post('/collections/:id/activate', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await getCollection(id))) return res.status(404).json({ error: 'Unknown collection' });

    const info = await swapIndex(id); // hot swap, no restart -- and it validates the rows
    await setActive(id);
    const removed = await pruneExcept(id);
    if (removed.length) console.log(`[admin] pruned ${removed.length} superseded collection(s)`);

    res.json({ ok: true, active: info, pruned: removed.length });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/collections/:id', async (req, res, next) => {
  try {
    if (!(await getCollection(req.params.id))) {
      return res.status(404).json({ error: 'Unknown collection' });
    }
    await deleteCollection(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    next(err);
  }
});

/** Chunk inspector -- "show me exactly what chunking produced". */
adminRouter.get('/collections/:id/chunks', async (req, res, next) => {
  try {
    const { id } = req.params;
    const manifest = await readManifest(id);
    if (!manifest) return res.status(404).json({ error: 'Unknown collection' });

    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);
    const [total, chunks] = await Promise.all([
      countChunks(id),
      readChunks(id, { offset, limit }),
    ]);

    res.json({
      total,
      offset,
      limit,
      rejected: manifest.rejected ?? [],
      duplicates: manifest.duplicates ?? [],
      counts: manifest.counts,
      chunkStrategy: manifest.chunkStrategy,
      chunks,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------- stock

/** Fields exported to CSV, in a sensible column order for editing in a spreadsheet. */
const CSV_COLUMNS = [
  'id', 'title', 'author', 'year', 'genres', 'readingLevel',
  'pages', 'themes', 'mood', 'description', 'similarTo',
];

/** Semicolons join list fields -- the same separator the parser splits on. */
function csvCell(value) {
  const text = Array.isArray(value) ? value.join('; ') : value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(books) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const book of books) lines.push(CSV_COLUMNS.map((c) => csvCell(book[c])).join(','));
  return lines.join('\n');
}

/**
 * Browse the stock currently on the shelf. Read-only by design: the uploaded
 * file is the source of truth, so editing a row here would immediately be a
 * second version of the truth. Corrections go through a re-upload.
 */
adminRouter.get('/books', async (req, res, next) => {
  try {
    const id = activeInfo()?.id;
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 25), 200);
    if (!id) {
      return res.json({ collectionId: null, total: 0, matched: 0, offset: 0, limit, books: [] });
    }

    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = String(req.query.q ?? '');
    const { total, matched, books } = await searchBooks(id, { q, offset, limit });

    res.json({ collectionId: id, total, matched, offset, limit, books });
  } catch (err) {
    next(err);
  }
});

/**
 * Download the live stock as the same shape the uploader accepts, so the
 * round trip is: download, edit in a spreadsheet, upload the whole thing back.
 */
adminRouter.get('/books/export', async (req, res, next) => {
  try {
    const id = activeInfo()?.id;
    if (!id) return res.status(404).json({ error: 'No catalog is loaded yet' });

    const [books, manifest] = await Promise.all([readBooks(id), readManifest(id)]);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${(manifest?.name || 'catalog').replace(/[^a-z0-9._-]+/gi, '-')}-${stamp}`;

    if (req.query.format === 'json') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${base}.json"`);
      return res.send(JSON.stringify({ books }, null, 2));
    }

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${base}.csv"`);
    res.send(toCsv(books));
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/stats', (req, res) => {
  res.json({ ...stats(), active: activeInfo() });
});
