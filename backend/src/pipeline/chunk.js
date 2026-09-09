/**
 * Stage 3: turn book records into the text units we actually embed.
 *
 * An embedding can only match on text it was shown, so whatever a reader might
 * ask about has to appear in some chunk. The two strategies differ in how much
 * they mix together in one vector:
 *
 *   whole-record  one chunk per book. Simple, and every vector carries full
 *                 context -- but mood and hard facts share one direction in
 *                 embedding space, so "cozy" gets diluted by page counts.
 *
 *   field-split   two chunks per book: a factual "profile" and a narrative
 *                 "vibe" chunk. A mood query matches the vibe chunk cleanly
 *                 while "books by Tolkien under 300 pages" matches the profile.
 *                 Retrieval then folds chunks back to one row per book.
 */

const list = (v) => (Array.isArray(v) && v.length ? v.join(', ') : 'unspecified');
const num = (v) => (v == null || v === '' ? 'unknown' : String(v));

/** The full flattened record -- also what gets pasted into the LLM prompt. */
export function toDocument(book) {
  return [
    `Title: ${book.title}`,
    `Author: ${book.author} (${num(book.year)})`,
    `Genres: ${list(book.genres)}`,
    `Reading level: ${book.readingLevel}`,
    `Length: ${num(book.pages)} pages`,
    `Themes: ${list(book.themes)}`,
    `Mood and style: ${book.mood}`,
    `Summary: ${book.description}`,
    `Readers who like this also like: ${list(book.similarTo)}`,
  ].join('\n');
}

function profileText(book) {
  return [
    `Title: ${book.title}`,
    `Author: ${book.author} (${num(book.year)})`,
    `Genres: ${list(book.genres)}`,
    `Reading level: ${book.readingLevel}`,
    `Length: ${num(book.pages)} pages`,
  ].join('\n');
}

function narrativeText(book) {
  return [
    `${book.title} by ${book.author}`,
    `Themes: ${list(book.themes)}`,
    `Mood and style: ${book.mood}`,
    `Summary: ${book.description}`,
    `Readers who like this also like: ${list(book.similarTo)}`,
  ].join('\n');
}

export const STRATEGIES = ['whole-record', 'field-split'];

export const DEFAULT_STRATEGY = STRATEGIES.includes(process.env.CHUNK_STRATEGY)
  ? process.env.CHUNK_STRATEGY
  : 'field-split';

/**
 * @param {object[]} books
 * @param {'whole-record'|'field-split'} strategy
 * @returns {{chunkId:string, bookId:string, kind:string, text:string}[]}
 */
export function chunkBooks(books, strategy = DEFAULT_STRATEGY) {
  const chunks = [];
  for (const book of books) {
    if (strategy === 'whole-record') {
      chunks.push({
        chunkId: `${book.id}#full`,
        bookId: book.id,
        kind: 'full',
        text: toDocument(book),
      });
    } else {
      chunks.push({
        chunkId: `${book.id}#profile`,
        bookId: book.id,
        kind: 'profile',
        text: profileText(book),
      });
      chunks.push({
        chunkId: `${book.id}#narrative`,
        bookId: book.id,
        kind: 'narrative',
        text: narrativeText(book),
      });
    }
  }
  return chunks;
}
