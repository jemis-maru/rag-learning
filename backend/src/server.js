import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { answer } from './rag.js';
import {
  activeInfo,
  allBooks,
  chunkCount,
  DEFAULT_K,
  isReady,
  retrieve,
  size,
  swapIndex,
} from './vectorStore.js';
import { adminRouter } from './adminRoutes.js';
import { observe, requireAdmin } from './middleware.js';
import { READING_LEVELS } from './pipeline/parse.js';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(observe);
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 4000;

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    indexReady: isReady(),
    books: size(),
    chunks: chunkCount(),
    collection: activeInfo(),
    adminEnabled: Boolean(process.env.ADMIN_TOKEN),
    chatModel: process.env.CHAT_MODEL || 'gemini-3.6-flash',
    embedModel: process.env.EMBED_MODEL || 'gemini-embedding-001',
    embedDims: Number(process.env.EMBED_DIMS) || 768,
    retrieveK: DEFAULT_K(),
    minScore: Number(process.env.MIN_SCORE ?? 0.58),
  });
});

/** Powers the genre / reading-level filter dropdowns in the UI. */
app.get('/api/catalog', (req, res) => {
  const books = allBooks();
  const genres = [...new Set(books.flatMap((b) => b.genres ?? []))].sort();
  const levels = READING_LEVELS.filter((l) => books.some((b) => b.readingLevel === l));
  res.json({
    count: books.length,
    genres,
    readingLevels: levels,
    collection: activeInfo(),
  });
});

// Reader-facing, so it says what happened and nothing about how the catalog
// gets there -- no console path, no operator instructions.
const NO_CATALOG = 'No catalog is available yet, so recommendations are unavailable right now.';

/** Retrieval only -- handy for checking the vector search without burning chat tokens. */
app.post('/api/search', async (req, res, next) => {
  try {
    if (!isReady()) return res.status(503).json({ error: NO_CATALOG });
    const { query, k = 6, filters = {} } = req.body ?? {};
    if (!query?.trim()) return res.status(400).json({ error: 'query is required' });
    const requested = Math.floor(Number(k));
    const safeK = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 6, 20);
    const hits = await retrieve(query.trim(), { k: safeK, filters });
    res.json({
      query,
      results: hits.map((h) => ({
        ...h.book,
        matchedChunk: h.matchedChunk,
        score: Number(h.score.toFixed(4)),
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/chat', async (req, res, next) => {
  try {
    if (!isReady()) return res.status(503).json({ error: NO_CATALOG });
    const { message, history = [], filters = {} } = req.body ?? {};

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: 'message is too long (2000 char max)' });
    }

    // Keep only well-formed turns, and cap history so the prompt cannot grow unbounded.
    const cleanHistory = (Array.isArray(history) ? history : [])
      .filter((m) => (m?.role === 'user' || m?.role === 'model') && typeof m.text === 'string')
      .slice(-10)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));

    const result = await answer({ message: message.trim(), history: cleanHistory, filters });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.use('/api/admin', requireAdmin, adminRouter);

app.use((err, req, res, next) => {
  const message = String(err?.message ?? 'Unexpected error');
  console.error(JSON.stringify({ type: 'error', reqId: req.reqId, message }));

  // 502 is the right default -- most failures here are Gemini refusing us --
  // but a route that already worked out the status (a 404 for an unknown
  // collection, a 409 for a busy one) should keep it rather than have every
  // client see "bad gateway" for a plain client mistake.
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
    ? err.status
    : message.includes('GEMINI_API_KEY')
      ? 500
      : 502;

  res.status(status).json({ error: message, reqId: req.reqId });
});

/**
 * Boot: load whichever collection is active, if there is one.
 *
 * Startup never embeds anything. A fresh install comes up with an empty index
 * and stays that way until an admin uploads a catalog -- the chat side reports
 * "no catalog" and the admin console still accepts an upload, rather than the
 * process refusing to start or quietly spending money on a demo dataset.
 */
async function boot() {
  try {
    swapIndex();
  } catch (err) {
    console.warn(`[server] no catalog loaded: ${err.message}`);
  }

  const server = app.listen(PORT, () => {
    const info = activeInfo();
    console.log(
      `[server] http://localhost:${PORT} -- ` +
        (info ? `${info.books} books, ${info.chunks} chunks (${info.name})` : 'no catalog yet')
    );
    if (!process.env.ADMIN_TOKEN) {
      console.log('[server] ADMIN_TOKEN not set -- the /admin console is disabled');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n[fatal] port ${PORT} is already in use -- another copy of this server is ` +
          `probably still running.\n  Stop it, or set PORT=4001 in backend/.env.\n`
      );
      process.exit(1);
    }
    throw err;
  });

  // Let in-flight requests finish instead of dropping them on redeploy.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n[server] ${signal} received, shutting down`);
      server.close(() => process.exit(0));
    });
  }
}

boot().catch((err) => {
  console.error('\n[fatal] could not start:\n  ' + err.message + '\n');
  process.exit(1);
});
