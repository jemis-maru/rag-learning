/**
 * Postgres connection pool and schema.
 *
 * The collection registry, the parsed books, and the chunks with their vectors
 * are four tables here. The uploaded file is still the source of truth for a
 * catalog; Postgres is where the processed form of it lives.
 *
 * The vectors are stored in a pgvector column and compared by the database, so
 * the similarity scan is a query rather than a loop in Node.
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool, types } = pg;

/**
 * node-postgres hands back bigint/numeric as strings to avoid precision loss.
 * count(*) is a bigint and every caller here wants a number, so parse int8.
 */
types.setTypeParser(20, (v) => Number(v));

const CONNECTION =
  process.env.DATABASE_URL || 'postgres://bacancy:devpass@localhost:5432/bookbot';

export const pool = new Pool({ connectionString: CONNECTION });

pool.on('error', (err) => {
  // An idle client dying (a server restart, a dropped connection) must not take
  // the process with it -- the pool opens a fresh one on the next query.
  console.error(`[db] idle client error: ${err.message}`);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Run fn inside a transaction, rolling back if it throws. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** pgvector's text input format: [0.1,0.2,...]. */
export function toVectorLiteral(values) {
  return `[${values.join(',')}]`;
}

/**
 * The schema.
 *
 * `embedding` is declared as a bare `vector` rather than `vector(768)` on
 * purpose: EMBED_DIMS is configurable, and a fixed-width column would reject a
 * catalog built at a different dimensionality. The cost is that an ANN index
 * (hnsw/ivfflat) cannot be built, so searches are an exact scan -- which is
 * what we want anyway. An approximate index returns approximate neighbours,
 * and at this catalog size an exact scan in Postgres is already sub-millisecond.
 * Revisit both decisions together somewhere north of ~100k chunks.
 */
const SCHEMA = `
-- A book's genres/themes are JSON arrays, but a hand-edited catalog can leave
-- one holding a scalar or nothing at all. jsonb_array_elements_text() errors on
-- those, so every query that expands a list field goes through this instead and
-- gets an empty array for anything that is not one.
CREATE OR REPLACE FUNCTION jsonb_list(doc jsonb, key text) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN jsonb_typeof(doc -> key) = 'array' THEN doc -> key ELSE '[]'::jsonb END
$fn$;

CREATE TABLE IF NOT EXISTS collections (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  format              text NOT NULL,
  chunk_strategy      text NOT NULL,
  status              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  counts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  timings             jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary             jsonb,
  rejected            jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicates          jsonb NOT NULL DEFAULT '[]'::jsonb,
  model               text,
  dims                integer,
  error               text,
  embeddings_built_at timestamptz,
  raw_filename        text,
  raw_bytes           bytea
);

CREATE TABLE IF NOT EXISTS books (
  collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  book_id       text NOT NULL,
  ord           integer NOT NULL,
  data          jsonb NOT NULL,
  PRIMARY KEY (collection_id, book_id)
);

CREATE INDEX IF NOT EXISTS books_order_idx ON books (collection_id, ord);

CREATE TABLE IF NOT EXISTS chunks (
  collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chunk_id      text NOT NULL,
  book_id       text NOT NULL,
  ord           integer NOT NULL,
  kind          text NOT NULL,
  text          text NOT NULL,
  hash          text NOT NULL,
  embedding     vector,
  PRIMARY KEY (collection_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS chunks_order_idx ON chunks (collection_id, ord);
CREATE INDEX IF NOT EXISTS chunks_book_idx  ON chunks (collection_id, book_id);

-- One row, holding which collection is currently serving readers. The CHECK
-- plus the boolean primary key is the standard way to pin a table to a single
-- row, so "the active collection" can never become ambiguous.
CREATE TABLE IF NOT EXISTS app_state (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  active_collection_id text REFERENCES collections(id) ON DELETE SET NULL
);

INSERT INTO app_state (id, active_collection_id)
VALUES (true, NULL)
ON CONFLICT (id) DO NOTHING;
`;

let ready = null;

/**
 * Create the schema if it is not there yet. Idempotent, and memoised so the
 * concurrent callers at boot share one round trip.
 */
export function initDb() {
  ready ??= (async () => {
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (err) {
      // Creating an extension needs superuser. If it is already installed (the
      // documented setup step) this failure is harmless, so only complain when
      // the type really is missing.
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'vector'`
      );
      if (!rows.length) {
        throw new Error(
          'The pgvector extension is not installed in this database. Run:\n' +
            `  sudo -u postgres psql -d bookbot -c "CREATE EXTENSION vector;"\n` +
            `  (original error: ${err.message})`
        );
      }
    }
    await pool.query(SCHEMA);
  })().catch((err) => {
    ready = null; // let a later call retry rather than caching the failure
    throw err;
  });
  return ready;
}

export async function closeDb() {
  await pool.end();
}
