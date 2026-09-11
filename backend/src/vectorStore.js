/**
 * A deliberately tiny in-memory vector store over the active collection.
 *
 * A few hundred chunks x 768 dims is well under a megabyte of floats -- a
 * brute-force cosine scan over that is sub-millisecond, so Pinecone/pgvector
 * would add moving parts without adding speed. Swap this file out once the
 * catalog reaches ~100k rows.
 *
 * The store holds CHUNKS, but retrieval returns BOOKS: chunks are scored
 * individually and then folded back to one row per book, keeping the best
 * score. That way splitting a book into a profile and a narrative chunk
 * improves matching without ever showing the same title twice.
 */

import { embed } from './gemini.js';
import { toDocument } from './pipeline/chunk.js';
import {
  activeCollectionId,
  readChunks,
  readEmbeddings,
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

let state = null; // { collectionId, name, books:Map, entries:[{chunk,book,vector}], model, dims }

export function isReady() {
  return state !== null;
}

export function size() {
  return state?.books.size ?? 0;
}

export function chunkCount() {
  return state?.entries.length ?? 0;
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
    chunks: state.entries.length,
    chunkStrategy: state.chunkStrategy,
    model: state.model,
    dims: state.dims,
  };
}

/**
 * Load a collection into memory and make it live.
 * Called at boot and again on activation, so switching catalogs needs no restart.
 */
/** Tag an error with the HTTP status it should surface as. */
function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function swapIndex(collectionId) {
  const id = collectionId ?? activeCollectionId();
  if (!id) throw new Error('No catalog is currently loaded.');

  const manifest = readManifest(id);
  if (!manifest) throw fail(`Collection ${id} not found on disk`, 404);
  if (manifest.status !== 'ready') {
    throw fail(
      `Collection ${id} is "${manifest.status}", so there is nothing to serve yet`,
      409
    );
  }

  const chunks = readChunks(id);
  const embeddings = readEmbeddings(id);
  if (!embeddings?.vectors) throw fail(`Collection ${id} has no embeddings`, 409);

  const books = new Map((manifest.books ?? []).map((b) => [b.id, b]));
  const entries = [];
  for (const chunk of chunks) {
    const vector = embeddings.vectors[chunk.chunkId];
    const book = books.get(chunk.bookId);
    if (vector && book) entries.push({ chunk, book, vector });
  }
  if (!entries.length) throw fail(`Collection ${id} produced no usable entries`, 409);

  state = {
    collectionId: id,
    name: manifest.name,
    chunkStrategy: manifest.chunkStrategy,
    books,
    entries,
    model: embeddings.model,
    dims: embeddings.dims,
  };
  console.log(`[rag] active collection ${id} -- ${books.size} books, ${entries.length} chunks`);
  return activeInfo();
}

/** Vectors are unit-normalised at embed time, so a dot product is the cosine. */
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
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
 * Retrieve the top-k most relevant BOOKS for a query.
 *
 * Hybrid scoring: semantic similarity carries the result, with a small keyword
 * bonus so an explicit "cozy fantasy for a 10 year old" still surfaces the exact
 * genre/level match that pure embedding distance might rank third.
 */
export async function retrieve(query, { k = DEFAULT_K(), filters = {} } = {}) {
  if (!state) throw new Error('Index not loaded yet.');

  const queryVector = await embed(query, 'RETRIEVAL_QUERY');
  const needle = query.toLowerCase();

  let candidates = state.entries;

  // Optional hard filters from the UI (genre / reading level dropdowns).
  if (typeof filters.genre === 'string' && filters.genre) {
    const g = filters.genre.toLowerCase();
    const filtered = candidates.filter((e) =>
      (e.book.genres ?? []).some((x) => String(x).toLowerCase() === g)
    );
    if (filtered.length) candidates = filtered; // never filter down to nothing
  }
  if (typeof filters.readingLevel === 'string' && filters.readingLevel) {
    const lvl = filters.readingLevel.toLowerCase();
    const filtered = candidates.filter(
      (e) => String(e.book.readingLevel ?? '').toLowerCase() === lvl
    );
    if (filtered.length) candidates = filtered;
  }

  // Score every chunk, then keep only each book's best-matching chunk.
  const best = new Map();
  for (const entry of candidates) {
    const semantic = dot(queryVector, entry.vector);
    const previous = best.get(entry.book.id);
    if (!previous || semantic > previous.semantic) {
      best.set(entry.book.id, { book: entry.book, semantic, matchedChunk: entry.chunk.kind });
    }
  }

  const scored = [...best.values()].map((hit) => {
    const { book } = hit;
    let keyword = 0;
    for (const g of book.genres ?? []) if (mentions(needle, g)) keyword += 0.04;
    for (const t of book.themes ?? []) if (mentions(needle, t)) keyword += 0.03;
    if (mentions(needle, book.readingLevel)) keyword += 0.04;
    if (mentions(needle, book.author)) keyword += 0.06;
    if (mentions(needle, book.title)) keyword += 0.08;

    return {
      ...hit,
      // The prompt always gets the FULL record, never just the chunk that
      // matched -- otherwise a mood-chunk hit would omit the page count.
      document: toDocument(book),
      score: hit.semantic + Math.min(keyword, 0.15),
    };
  });

  const floor = MIN_SCORE();
  return scored
    .filter((h) => h.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
