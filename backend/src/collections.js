/**
 * Versioned catalog collections, stored in Postgres.
 *
 * Every upload -- a full replace or an incremental append -- becomes its own
 * row in `collections` plus its own `books` and `chunks` rows, so a bad upload
 * cannot damage the catalog the chat side is currently serving and rolling back
 * is a one-line flip of app_state.active_collection_id.
 *
 * Only one collection is ever kept. Activating a new one prunes the rest:
 * nothing but the live collection is read at runtime, and each superseded
 * catalog would otherwise leave its whole vector set in the table forever. The
 * uploaded file is the source of truth, so a rollback is a re-upload.
 */

import crypto from 'node:crypto';
import { query, toVectorLiteral, withTransaction } from './db.js';

/**
 * Collection ids are generated here, never supplied by a caller -- but they do
 * arrive back as URL path segments and query params. Validating the shape keeps
 * a crafted id out of the queries and gives the routes a cheap 404 path.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/** Short digest of a chunk's text -- the "is this vector still valid" check. */
export function textHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** A short, sortable, human-readable id: col_20260908143012_a3f1 */
function newCollectionId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const salt = Math.random().toString(16).slice(2, 6);
  return `col_${stamp}_${salt}`;
}

// ---------------------------------------------------------------- registry

/**
 * The summary row the admin table renders -- cheap, no books, chunks or
 * vectors touched.
 */
const SUMMARY_COLUMNS = `
  id, name, format, chunk_strategy, status, created_at, counts, timings, model, dims
`;

function toSummary(row) {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    chunkStrategy: row.chunk_strategy,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    counts: row.counts,
    timings: row.timings,
    model: row.model ?? undefined,
    dims: row.dims ?? undefined,
  };
}

export async function listCollections() {
  const { rows } = await query(
    `SELECT ${SUMMARY_COLUMNS},
            id = (SELECT active_collection_id FROM app_state) AS active
       FROM collections
      ORDER BY created_at DESC, id DESC`
  );
  return rows.map((r) => ({ ...toSummary(r), active: r.active }));
}

export async function activeCollectionId() {
  const { rows } = await query('SELECT active_collection_id FROM app_state');
  return rows[0]?.active_collection_id ?? null;
}

export async function getCollection(id) {
  if (!isValidId(id)) return null;
  const { rows } = await query(
    `SELECT ${SUMMARY_COLUMNS},
            id = (SELECT active_collection_id FROM app_state) AS active
       FROM collections WHERE id = $1`,
    [id]
  );
  if (!rows.length) return null;
  return { ...toSummary(rows[0]), active: rows[0].active };
}

/**
 * The metadata for one collection -- its status, counts, timings and the rows
 * it rejected. The books are their own table, read with readBooks().
 *
 * Answers null for a malformed id rather than throwing, so a bad id from a URL
 * is a 404 to the caller instead of a 500.
 */
export async function readManifest(id) {
  if (!isValidId(id)) return null;
  const { rows } = await query(
    `SELECT ${SUMMARY_COLUMNS}, summary, rejected, duplicates, error
       FROM collections WHERE id = $1`,
    [id]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    ...toSummary(row),
    summary: row.summary ?? undefined,
    rejected: row.rejected,
    duplicates: row.duplicates,
    error: row.error ?? undefined,
  };
}

/** Create the collection row in a `building` state. Returns the id. */
export async function createCollection({ name, format, chunkStrategy }) {
  const id = newCollectionId();
  await query(
    `INSERT INTO collections (id, name, format, chunk_strategy, status, counts)
     VALUES ($1, $2, $3, $4, 'building', $5)`,
    [
      id,
      name || id,
      format,
      chunkStrategy,
      JSON.stringify({ rows: 0, books: 0, rejected: 0, chunks: 0 }),
    ]
  );
  return id;
}

/**
 * Merge fields into a collection's metadata.
 *
 * `books` is accepted here because the pipeline writes the books and the row
 * counts in one step: they go to the books table, everything else to columns
 * on the collection.
 */
export async function updateManifest(id, patch) {
  const { books, ...meta } = patch;

  const COLUMNS = {
    name: 'name',
    status: 'status',
    counts: 'counts',
    timings: 'timings',
    summary: 'summary',
    rejected: 'rejected',
    duplicates: 'duplicates',
    model: 'model',
    dims: 'dims',
    error: 'error',
  };
  const JSON_COLUMNS = new Set(['counts', 'timings', 'summary', 'rejected', 'duplicates']);

  await withTransaction(async (client) => {
    const { rowCount } = await client.query('SELECT 1 FROM collections WHERE id = $1', [id]);
    if (!rowCount) throw new Error(`Unknown collection: ${id}`);

    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(meta)) {
      const column = COLUMNS[key];
      if (!column) continue;
      values.push(JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length) {
      values.push(id);
      await client.query(
        `UPDATE collections SET ${sets.join(', ')} WHERE id = $${values.length}`,
        values
      );
    }

    if (books) await replaceBooks(client, id, books);
  });

  return readManifest(id);
}

// ------------------------------------------------------------------- books

/** Multi-row INSERT in slices, so one upload is a handful of round trips. */
async function insertRows(client, sql, rows, columnsPerRow, batchSize = 200) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const values = [];
    const tuples = slice.map((row, r) => {
      const placeholders = row.map((_, c) => `$${r * columnsPerRow + c + 1}`);
      values.push(...row);
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`${sql} ${tuples.join(', ')}`, values);
  }
}

async function replaceBooks(client, id, books) {
  await client.query('DELETE FROM books WHERE collection_id = $1', [id]);
  await insertRows(
    client,
    'INSERT INTO books (collection_id, book_id, ord, data) VALUES',
    books.map((book, i) => [id, book.id, i, JSON.stringify(book)]),
    4
  );
}

/** The books of a collection, in upload order. */
export async function readBooks(id) {
  if (!isValidId(id)) return [];
  const { rows } = await query(
    'SELECT data FROM books WHERE collection_id = $1 ORDER BY ord',
    [id]
  );
  return rows.map((r) => r.data);
}

/**
 * The haystack the admin stock search matches against: title, author, reading
 * level, then every genre and theme, space-joined -- the same string the
 * previous in-memory filter built.
 */
const BOOK_HAYSTACK = `
  lower(
    coalesce(data->>'title', '') || ' ' ||
    coalesce(data->>'author', '') || ' ' ||
    coalesce(data->>'readingLevel', '') ||
    coalesce((SELECT ' ' || string_agg(value, ' ')
                FROM jsonb_array_elements_text(jsonb_list(data, 'genres'))), '') ||
    coalesce((SELECT ' ' || string_agg(value, ' ')
                FROM jsonb_array_elements_text(jsonb_list(data, 'themes'))), '')
  )
`;

/**
 * One page of the stock table, with both the unfiltered total and the number
 * the search matched -- the two numbers the admin UI shows side by side.
 *
 * position() rather than LIKE: a reader's query can contain % or _ and those
 * are plain characters here, not wildcards.
 */
export async function searchBooks(id, { q = '', offset = 0, limit = 25 } = {}) {
  if (!isValidId(id)) return { total: 0, matched: 0, books: [] };

  const needle = q.trim().toLowerCase();
  const where = needle
    ? `collection_id = $1 AND position($2 IN ${BOOK_HAYSTACK}) > 0`
    : 'collection_id = $1';
  const params = needle ? [id, needle] : [id];

  const [totals, page] = await Promise.all([
    query(
      `SELECT (SELECT count(*) FROM books WHERE collection_id = $1) AS total,
              (SELECT count(*) FROM books WHERE ${where}) AS matched`,
      params
    ),
    query(
      `SELECT data FROM books WHERE ${where}
        ORDER BY ord LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);

  return {
    total: totals.rows[0].total,
    matched: totals.rows[0].matched,
    books: page.rows.map((r) => r.data),
  };
}

// ------------------------------------------------------------------ chunks

/**
 * Store the chunk text for a collection. The hash is computed here because it
 * is purely a function of the text, and the embed stage needs it to decide
 * which vectors it can carry over from the live catalog.
 */
export async function saveChunks(id, chunks) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM chunks WHERE collection_id = $1', [id]);
    await insertRows(
      client,
      'INSERT INTO chunks (collection_id, chunk_id, book_id, ord, kind, text, hash) VALUES',
      chunks.map((c, i) => [id, c.chunkId, c.bookId, i, c.kind, c.text, textHash(c.text)]),
      7
    );
  });
}

export async function countChunks(id) {
  if (!isValidId(id)) return 0;
  const { rows } = await query('SELECT count(*) AS n FROM chunks WHERE collection_id = $1', [id]);
  return rows[0].n;
}

/** One page of chunks, in the order chunking produced them. */
export async function readChunks(id, { offset = 0, limit = 20 } = {}) {
  if (!isValidId(id)) return [];
  const { rows } = await query(
    `SELECT chunk_id, book_id, kind, text FROM chunks
      WHERE collection_id = $1 ORDER BY ord LIMIT $2 OFFSET $3`,
    [id, limit, offset]
  );
  return rows.map((r) => ({
    chunkId: r.chunk_id,
    bookId: r.book_id,
    kind: r.kind,
    text: r.text,
  }));
}

// -------------------------------------------------------------- embeddings

/**
 * Carry vectors over from `fromId` to `toId` wherever the same chunk id still
 * hashes to the same text.
 *
 * This is what keeps re-uploading the full catalog cheap. A store that adds ten
 * titles to a five-thousand-book spreadsheet and uploads the whole thing again
 * pays to embed twenty chunks, not ten thousand -- the other rows hash the same
 * and their vectors carry straight over.
 *
 * Hashing the text is the load-bearing part: a chunk id is derived from the
 * book id, so an edited description keeps its chunk id while very much needing
 * a fresh vector. Matching on ids alone would silently serve a stale embedding.
 * The source collection must also have been built with the same model and
 * dimensionality, or its vectors are not comparable with the new ones.
 *
 * @returns {number} how many vectors were reused
 */
export async function copyReusableEmbeddings(toId, fromId, { model, dims }) {
  if (!fromId || !isValidId(fromId) || !isValidId(toId)) return 0;

  const { rowCount } = await query(
    `UPDATE chunks AS target
        SET embedding = source.embedding
       FROM chunks AS source, collections AS c
      WHERE target.collection_id = $1
        AND source.collection_id = $2
        AND c.id = $2
        AND c.model = $3
        AND c.dims = $4
        AND source.chunk_id = target.chunk_id
        AND source.hash = target.hash
        AND source.embedding IS NOT NULL`,
    [toId, fromId, model, dims]
  );
  return rowCount;
}

/** The chunks of a collection that still need a vector, in chunking order. */
export async function readUnembeddedChunks(id) {
  const { rows } = await query(
    `SELECT chunk_id, text FROM chunks
      WHERE collection_id = $1 AND embedding IS NULL ORDER BY ord`,
    [id]
  );
  return rows.map((r) => ({ chunkId: r.chunk_id, text: r.text }));
}

/**
 * Write freshly computed vectors.
 * @param {{chunkId:string, vector:number[]}[]} vectors
 */
export async function saveEmbeddings(id, vectors, { model, dims }) {
  await withTransaction(async (client) => {
    for (let i = 0; i < vectors.length; i += 200) {
      const slice = vectors.slice(i, i + 200);
      const values = [id];
      const tuples = slice.map(({ chunkId, vector }) => {
        values.push(chunkId, toVectorLiteral(vector));
        return `($${values.length - 1}::text, $${values.length}::vector)`;
      });
      await client.query(
        `UPDATE chunks AS target SET embedding = v.embedding
           FROM (VALUES ${tuples.join(', ')}) AS v(chunk_id, embedding)
          WHERE target.collection_id = $1 AND target.chunk_id = v.chunk_id`,
        values
      );
    }
    await client.query(
      'UPDATE collections SET model = $2, dims = $3, embeddings_built_at = now() WHERE id = $1',
      [id, model, dims]
    );
  });
}

/** How many chunks of a collection carry a usable vector AND a matching book. */
export async function countUsableEntries(id) {
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE c.embedding IS NOT NULL) AS embedded,
            count(*) FILTER (WHERE c.embedding IS NOT NULL AND b.book_id IS NOT NULL) AS usable
       FROM chunks c
       LEFT JOIN books b ON b.collection_id = c.collection_id AND b.book_id = c.book_id
      WHERE c.collection_id = $1`,
    [id]
  );
  return { embedded: rows[0].embedded, usable: rows[0].usable };
}

// ----------------------------------------------------------------- raw file

export async function saveRaw(id, filename, buffer) {
  await query('UPDATE collections SET raw_filename = $2, raw_bytes = $3 WHERE id = $1', [
    id,
    filename,
    buffer,
  ]);
}

// --------------------------------------------------------- activate / prune

export async function setActive(id) {
  const manifest = await readManifest(id);
  if (!manifest) throw new Error(`Unknown collection: ${id}`);
  if (manifest.status !== 'ready') {
    throw new Error(`Collection ${id} is "${manifest.status}", not ready to activate`);
  }
  await query('UPDATE app_state SET active_collection_id = $1 WHERE id = true', [id]);
}

/**
 * Delete every finished collection except `keepId`.
 *
 * Called right after an activation succeeds. Deliberately not called before:
 * the outgoing collection is the vector cache a rebuild reads from, and it has
 * to stay intact until the replacement is proven loadable.
 *
 * A collection that is still `building` is skipped. Activating one catalog
 * while another upload is mid-embed is entirely normal, and deleting its rows
 * out from under that job would fail its next write for reasons that look
 * nothing like the actual cause.
 *
 * @returns {string[]} the ids that were removed
 */
export async function pruneExcept(keepId) {
  const { rows } = await query(
    `DELETE FROM collections
      WHERE id <> $1 AND status <> 'building'
      RETURNING id`,
    [keepId]
  );
  return rows.map((r) => r.id);
}

export async function deleteCollection(id) {
  const manifest = await readManifest(id);
  if (manifest?.status === 'building') {
    const err = new Error('That upload is still building -- wait for it to finish or fail');
    err.status = 409;
    throw err;
  }
  if ((await activeCollectionId()) === id) {
    const err = new Error(
      'Cannot delete the catalog that is currently serving readers. Upload a ' +
        'replacement and activate it -- that removes this one for you.'
    );
    err.status = 409;
    throw err;
  }
  await query('DELETE FROM collections WHERE id = $1', [id]);
}
