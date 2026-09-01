/**
 * A deliberately tiny in-memory vector store.
 *
 * 50 books x 768 dims is ~150KB of floats -- a brute-force cosine scan over that
 * is well under a millisecond, so Pinecone/Chroma/pgvector would add moving parts
 * without adding speed. Swap this file out once the catalog reaches ~100k rows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed, embedBatch } from './gemini.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BOOKS_PATH = path.join(DIR, 'data', 'books.json');
const CACHE_PATH = path.join(DIR, 'data', 'embeddings.json');

/**
 * Flatten a book record into the single string we embed.
 * Everything a user might ask about has to appear here -- an embedding can only
 * match on text it was shown, so genre, level and mood all go in.
 */
export function toDocument(book) {
  return [
    `Title: ${book.title}`,
    `Author: ${book.author} (${book.year})`,
    `Genres: ${book.genres.join(', ')}`,
    `Reading level: ${book.readingLevel}`,
    `Length: ${book.pages} pages`,
    `Themes: ${book.themes.join(', ')}`,
    `Mood and style: ${book.mood}`,
    `Summary: ${book.description}`,
    `Readers who like this also like: ${(book.similarTo || []).join(', ')}`,
  ].join('\n');
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

let store = null; // [{ book, document, vector }]

export function isReady() {
  return store !== null;
}

export function size() {
  return store?.length ?? 0;
}

export function allBooks() {
  return JSON.parse(fs.readFileSync(BOOKS_PATH, 'utf8'));
}

/**
 * Build the index: load the catalog, reuse cached vectors when the catalog and
 * embedding model are unchanged, otherwise call the embeddings API once.
 */
export async function buildIndex({ force = false } = {}) {
  const books = allBooks();
  const model = process.env.EMBED_MODEL || 'gemini-embedding-001';
  const dims = Number(process.env.EMBED_DIMS) || 768;
  const documents = books.map(toDocument);

  if (!force && fs.existsSync(CACHE_PATH)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      const stale =
        cache.model !== model ||
        cache.dims !== dims ||
        cache.entries?.length !== books.length ||
        cache.entries.some((e, i) => e.id !== books[i].id || e.document !== documents[i]);

      if (!stale) {
        store = books.map((book, i) => ({
          book,
          document: documents[i],
          vector: cache.entries[i].vector,
        }));
        console.log(`[rag] loaded ${store.length} cached embeddings (${model})`);
        return { built: false, count: store.length };
      }
      console.log('[rag] cache is stale (catalog, model or dimensions changed), re-embedding');
    } catch {
      console.log('[rag] cache unreadable, re-embedding');
    }
  }

  console.log(`[rag] embedding ${books.length} books with ${model}...`);
  const vectors = await embedBatch(documents, 'RETRIEVAL_DOCUMENT');

  store = books.map((book, i) => ({ book, document: documents[i], vector: vectors[i] }));

  fs.writeFileSync(
    CACHE_PATH,
    JSON.stringify(
      {
        model,
        dims,
        builtAt: new Date().toISOString(),
        entries: store.map((e) => ({ id: e.book.id, document: e.document, vector: e.vector })),
      },
      null,
      0
    )
  );
  console.log(`[rag] indexed ${store.length} books, cache written to data/embeddings.json`);
  return { built: true, count: store.length };
}

/**
 * Retrieve the top-k most relevant books for a query.
 *
 * Hybrid scoring: semantic similarity carries the result, with a small keyword
 * bonus so an explicit "cozy fantasy for a 10 year old" still surfaces the exact
 * genre/level match that pure embedding distance might rank third.
 */
export async function retrieve(query, { k = 6, filters = {} } = {}) {
  if (!store) throw new Error('Index not built yet. Call buildIndex() first.');

  const queryVector = await embed(query, 'RETRIEVAL_QUERY');
  const needle = query.toLowerCase();

  let candidates = store;

  // Optional hard filters from the UI (genre / reading level dropdowns).
  if (filters.genre) {
    const g = filters.genre.toLowerCase();
    const filtered = candidates.filter((e) =>
      e.book.genres.some((x) => x.toLowerCase() === g)
    );
    if (filtered.length) candidates = filtered; // never filter down to nothing
  }
  if (filters.readingLevel) {
    const lvl = filters.readingLevel.toLowerCase();
    const filtered = candidates.filter((e) => e.book.readingLevel.toLowerCase() === lvl);
    if (filtered.length) candidates = filtered;
  }

  const scored = candidates.map((entry) => {
    const semantic = cosineSimilarity(queryVector, entry.vector);

    let keyword = 0;
    for (const g of entry.book.genres) {
      if (needle.includes(g.toLowerCase())) keyword += 0.04;
    }
    for (const t of entry.book.themes) {
      if (needle.includes(t.toLowerCase())) keyword += 0.03;
    }
    if (needle.includes(entry.book.readingLevel.toLowerCase())) keyword += 0.04;
    if (needle.includes(entry.book.author.toLowerCase())) keyword += 0.06;
    if (needle.includes(entry.book.title.toLowerCase())) keyword += 0.08;

    return { ...entry, semantic, score: semantic + Math.min(keyword, 0.15) };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
