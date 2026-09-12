/**
 * Vector search over the active collection, run by Postgres.
 *
 * The chunk vectors live in a pgvector column and never travel into Node: a
 * query is embedded, handed to Postgres, and the database does the cosine
 * comparison and the ordering. What comes back is one row per book.
 *
 * The store searches CHUNKS but returns BOOKS: chunks are scored individually
 * and folded back to one row per book, keeping the best score. That way
 * splitting a book into a profile and a narrative chunk improves matching
 * without ever showing the same title twice -- the DISTINCT ON below is what
 * does the folding.
 *
 * The book records themselves are cached in memory when a collection is
 * activated. They are small, several endpoints want them synchronously, and
 * keeping them here means a search is one round trip rather than two.
 */

import { embed } from './gemini.js';
import { toDocument } from './pipeline/chunk.js';
import { query, toVectorLiteral } from './db.js';
import {
  activeCollectionId,
  countUsableEntries,
  readBooks,
  readManifest,
} from './collections.js';

/**
 * Below this score a "match" is noise. Without a floor, "how do I fix my car"
 * still hands the model six books and invites it to recommend one.
 *
 * Note that gemini-embedding-001 has a high similarity baseline -- unrelated
 * text does not score near zero. Measured on this catalog: genuine book queries
 * land at 0.63-0.78, off-topic ones ("capital of Peru", "pizza dough recipe")
 * at 0.49-0.54. 0.58 sits in the gap. Re-check this if you change embed model.
 */
const MIN_SCORE = () => Number(process.env.MIN_SCORE ?? 0.58);
export const DEFAULT_K = () => Number(process.env.RETRIEVE_K) || 6;

/** The largest keyword bonus retrieve() can add on top of the semantic score. */
const MAX_KEYWORD_BONUS = 0.15;

let state = null; // { collectionId, name, chunkStrategy, books:Map, chunks, model, dims }

export function isReady() {
  return state !== null;
}

export function size() {
  return state?.books.size ?? 0;
}

export function chunkCount() {
  return state?.chunks ?? 0;
}

/** In-memory, so the catalog endpoint no longer re-reads and re-parses on every hit. */
export function allBooks() {
  return state ? [...state.books.values()] : [];
}

export function activeInfo() {
  if (!state) return null;
  return {
    id: state.collectionId,
    name: state.name,
    books: state.books.size,
    chunks: state.chunks,
    chunkStrategy: state.chunkStrategy,
    model: state.model,
    dims: state.dims,
  };
}

/** Tag an error with the HTTP status it should surface as. */
function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Load a collection and make it live.
 * Called at boot and again on activation, so switching catalogs needs no restart.
 */
export async function swapIndex(collectionId) {
  const id = collectionId ?? (await activeCollectionId());
  if (!id) throw new Error('No catalog is currently loaded.');

  const manifest = await readManifest(id);
  if (!manifest) throw fail(`Collection ${id} not found`, 404);
  if (manifest.status !== 'ready') {
    throw fail(
      `Collection ${id} is "${manifest.status}", so there is nothing to serve yet`,
      409
    );
  }

  const { embedded, usable } = await countUsableEntries(id);
  if (!embedded) throw fail(`Collection ${id} has no embeddings`, 409);
  if (!usable) throw fail(`Collection ${id} produced no usable entries`, 409);

  const books = new Map((await readBooks(id)).map((b) => [b.id, b]));

  state = {
    collectionId: id,
    name: manifest.name,
    chunkStrategy: manifest.chunkStrategy,
    books,
    chunks: usable,
    model: manifest.model,
    dims: manifest.dims,
  };
  console.log(`[rag] active collection ${id} -- ${books.size} books, ${usable} chunks`);
  return activeInfo();
}

/**
 * Whole-word match. Plain `includes` matched the theme "war" inside "warm" and
 * the genre "romance" inside "romantic", quietly skewing the ranking.
 */
function mentions(haystack, phrase) {
  const p = String(phrase ?? '').trim().toLowerCase();
  if (p.length < 3) return false;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * The optional hard filters from the UI (genre / reading level dropdowns),
 * as SQL fragments over the book's JSON record. `sql` takes the placeholder to
 * bind against, because the same clause is used by queries that carry a
 * different number of leading parameters.
 */
function filterSpecs(filters) {
  const specs = [];
  if (typeof filters.genre === 'string' && filters.genre) {
    specs.push({
      value: filters.genre.toLowerCase(),
      sql: (p) =>
        `EXISTS (SELECT 1 FROM jsonb_array_elements_text(jsonb_list(b.data, 'genres')) g
                  WHERE lower(g) = ${p})`,
    });
  }
  if (typeof filters.readingLevel === 'string' && filters.readingLevel) {
    specs.push({
      value: filters.readingLevel.toLowerCase(),
      sql: (p) => `lower(coalesce(b.data->>'readingLevel', '')) = ${p}`,
    });
  }
  return specs;
}

/**
 * Narrow by one filter at a time, keeping each only if the catalog still has
 * something in it afterwards -- the dropdowns narrow the catalog, they never
 * empty it. Dropping just the filter that went too far (rather than all of
 * them) is what keeps "Humor" honoured when the reading level alongside it
 * happens to match no Humor title.
 */
async function keepUsableFilters(collectionId, specs) {
  const kept = [];
  for (const spec of specs) {
    const candidate = [...kept, spec];
    const clauses = candidate.map((s, i) => s.sql(`$${i + 2}`));
    const { rows } = await query(
      `SELECT 1 FROM books b
        WHERE b.collection_id = $1 AND ${clauses.join(' AND ')} LIMIT 1`,
      [collectionId, ...candidate.map((s) => s.value)]
    );
    if (rows.length) kept.push(spec);
  }
  return kept;
}

/**
 * Retrieve the top-k most relevant BOOKS for a query.
 *
 * Hybrid scoring: semantic similarity carries the result, with a small keyword
 * bonus so an explicit "cozy fantasy for a 10 year old" still surfaces the exact
 * genre/level match that pure embedding distance might rank third.
 *
 * The semantic half happens in Postgres; the keyword half stays here, because
 * it is a whole-word regex over the query string rather than over the row.
 * Postgres is asked for every book within MAX_KEYWORD_BONUS of the floor, which
 * is exactly the set the bonus could still lift above it -- no candidate that
 * could make the final list is dropped before the bonus is applied.
 */
export async function retrieve(queryText, { k = DEFAULT_K(), filters = {} } = {}) {
  if (!state) throw new Error('Index not loaded yet.');

  const queryVector = await embed(queryText, 'RETRIEVAL_QUERY');
  const needle = queryText.toLowerCase();
  const vector = toVectorLiteral(queryVector);
  const floor = MIN_SCORE();

  const kept = await keepUsableFilters(state.collectionId, filterSpecs(filters));
  const filterSql = kept.length
    ? `AND ${kept.map((s, i) => s.sql(`$${i + 4}`)).join(' AND ')}`
    : '';
  const params = [
    state.collectionId,
    vector,
    floor - MAX_KEYWORD_BONUS,
    ...kept.map((s) => s.value),
  ];

  // DISTINCT ON keeps each book's single best-matching chunk. The vectors are
  // unit-normalised at embed time, so 1 - cosine_distance is the cosine
  // similarity the old in-process dot product computed.
  const { rows } = await query(
    `SELECT book_id, kind, semantic FROM (
       SELECT DISTINCT ON (c.book_id)
              c.book_id,
              c.kind,
              1 - (c.embedding <=> $2::vector) AS semantic
         FROM chunks c
         JOIN books b ON b.collection_id = c.collection_id AND b.book_id = c.book_id
        WHERE c.collection_id = $1
          AND c.embedding IS NOT NULL
          ${filterSql}
        ORDER BY c.book_id, c.embedding <=> $2::vector
     ) best
     WHERE semantic >= $3
     ORDER BY semantic DESC`,
    params
  );

  const scored = [];
  for (const row of rows) {
    const book = state.books.get(row.book_id);
    if (!book) continue;

    let keyword = 0;
    for (const g of book.genres ?? []) if (mentions(needle, g)) keyword += 0.04;
    for (const t of book.themes ?? []) if (mentions(needle, t)) keyword += 0.03;
    if (mentions(needle, book.readingLevel)) keyword += 0.04;
    if (mentions(needle, book.author)) keyword += 0.06;
    if (mentions(needle, book.title)) keyword += 0.08;

    scored.push({
      book,
      semantic: row.semantic,
      matchedChunk: row.kind,
      // The prompt always gets the FULL record, never just the chunk that
      // matched -- otherwise a mood-chunk hit would omit the page count.
      document: toDocument(book),
      score: row.semantic + Math.min(keyword, MAX_KEYWORD_BONUS),
    });
  }

  return scored
    .filter((h) => h.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
