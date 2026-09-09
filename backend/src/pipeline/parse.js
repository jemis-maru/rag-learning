/**
 * Stage 1 + 2 of the pipeline: parse an uploaded file into rows, then normalise
 * and validate those rows into book records.
 *
 * The hard rule here is that this module NEVER throws on bad data. A catalog of
 * 500 rows with 3 broken ones should import 497 books and report 3 problems --
 * not abort the whole upload. Only a file we cannot read at all is fatal.
 */

/** Fields that hold a list. In CSV these arrive as "a; b; c" (or comma-separated). */
const LIST_FIELDS = ['genres', 'themes', 'similarTo'];
const NUMBER_FIELDS = ['year', 'pages'];

const READING_LEVELS = ['beginner', 'middle-grade', 'young-adult', 'intermediate', 'advanced'];

/** Accept camelCase, snake_case, kebab-case and spaced CSV headers alike. */
const HEADER_ALIASES = {
  reading_level: 'readingLevel',
  'reading level': 'readingLevel',
  readinglevel: 'readingLevel',
  similar_to: 'similarTo',
  'similar to': 'similarTo',
  similarto: 'similarTo',
  genre: 'genres',
  theme: 'themes',
  summary: 'description',
  blurb: 'description',
  page_count: 'pages',
  'page count': 'pages',
  published: 'year',
  publication_year: 'year',
};

function canonicalKey(raw) {
  const key = String(raw).trim();
  const lower = key.toLowerCase();
  return HEADER_ALIASES[lower] ?? key;
}

// ------------------------------------------------------------------- CSV

/**
 * RFC4180-ish CSV reader: handles quoted fields, commas and newlines inside
 * quotes, "" as an escaped quote, and both \n and \r\n line endings.
 * Hand-rolled to keep the dependency list at three packages.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Trailing field / row, unless the file ended on a clean newline.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (!nonEmpty.length) return [];

  const headers = nonEmpty[0].map(canonicalKey);
  return nonEmpty.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? '';
    });
    return obj;
  });
}

function parseJson(text) {
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : (data.books ?? data.items ?? data.data);
  if (!Array.isArray(rows)) {
    throw new Error('JSON must be an array of books, or an object with a "books" array');
  }
  return rows.map((row) => {
    const obj = {};
    for (const [k, v] of Object.entries(row ?? {})) obj[canonicalKey(k)] = v;
    return obj;
  });
}

// ------------------------------------------------------- normalise + validate

function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value == null) return [];
  // Semicolons first so "Fantasy, Adventure" in a quoted CSV cell still splits.
  const raw = String(value);
  const parts = raw.includes(';') ? raw.split(';') : raw.split(',');
  return parts.map((v) => v.trim()).filter(Boolean);
}

function toNumber(value) {
  if (value === '' || value == null) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeLevel(value) {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (READING_LEVELS.includes(v)) return v;
  const alias = { kids: 'beginner', children: 'beginner', ya: 'young-adult', adult: 'advanced' };
  return alias[v] ?? null;
}

// ------------------------------------------------------------------ identity

/** Lowercase, punctuation-free, single-dashed. Used to build a stable fallback id. */
function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The keys a book is deduplicated on, most specific first.
 *
 * A row's own `id` is authoritative when present. Failing that, the same title
 * by the same author IS the same book, however the columns are capitalised --
 * which is what catches the copy-pasted row in a hand-maintained spreadsheet.
 */
function bookKeys(book) {
  const keys = [];
  if (book.id) keys.push(`id:${String(book.id).trim().toLowerCase()}`);
  const ta = `${slug(book.title)}|${slug(book.author)}`;
  if (ta !== '|') keys.push(`ta:${ta}`);
  return keys;
}

/**
 * Normalise one raw row into a book record.
 * @returns {{ book: object } | { reason: string }}
 */
function normalizeRow(row) {
  const get = (k) => (typeof row[k] === 'string' ? row[k].trim() : row[k]);

  const title = get('title');
  const author = get('author');
  const description = get('description');

  const missing = [];
  if (!title) missing.push('title');
  if (!author) missing.push('author');
  if (!description) missing.push('description');
  if (missing.length) return { reason: `missing required field(s): ${missing.join(', ')}` };

  const book = {
    // A derived id is deterministic, so a book keeps the same id across
    // re-uploads of the catalog. A row counter would renumber every book the
    // moment a row was inserted above it, invalidating every cached vector.
    id: String(get('id') || '').trim() || slug(`${title}-${author}`) || 'book',
    title: String(title),
    author: String(author),
    description: String(description),
    mood: String(get('mood') ?? '').trim() || 'unspecified',
  };

  for (const f of LIST_FIELDS) book[f] = toList(row[f]);
  for (const f of NUMBER_FIELDS) book[f] = toNumber(row[f]);

  book.readingLevel = normalizeLevel(row.readingLevel) ?? 'intermediate';

  return { book };
}

/**
 * Parse a whole upload.
 *
 * Duplicates WITHIN the file collapse to one book, last row winning, and are
 * reported rather than silently kept. The previous behaviour suffixed a
 * repeated id (`b001` -> `b001_7`), which quietly turned a copy-paste mistake
 * into two catalog entries for the same title.
 *
 * @param {string} text     raw file contents
 * @param {'csv'|'json'} format
 * @returns {{ books: object[], rejected: {row:number, reason:string}[],
 *             duplicates: {row:number, title:string, reason:string}[], rowCount:number }}
 */
export function parseCatalog(text, format) {
  const rows = format === 'csv' ? parseCsv(text) : parseJson(text);

  const books = [];
  const rejected = [];
  const duplicates = [];
  const seen = new Map(); // key -> index into books

  rows.forEach((row, i) => {
    const rowNumber = i + 1;
    let result;
    try {
      result = normalizeRow(row);
    } catch (err) {
      result = { reason: `could not read row (${err.message})` };
    }
    if (!result.book) {
      rejected.push({ row: rowNumber, reason: result.reason });
      return;
    }

    const keys = bookKeys(result.book);
    const hit = keys.map((k) => seen.get(k)).find((v) => v !== undefined);

    if (hit !== undefined) {
      const previous = books[hit];
      duplicates.push({
        row: rowNumber,
        title: result.book.title,
        reason: `duplicate of "${previous.title}" by ${previous.author} -- kept this later row`,
      });
      // Keep the earlier book's id so any existing reference to it still resolves.
      books[hit] = { ...result.book, id: previous.id };
      for (const k of bookKeys(books[hit])) seen.set(k, hit);
      return;
    }

    const index = books.push(result.book) - 1;
    for (const k of keys) seen.set(k, index);
  });

  return { books, rejected, duplicates, rowCount: rows.length };
}

export { READING_LEVELS };
