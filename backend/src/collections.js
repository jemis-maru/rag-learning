/**
 * Versioned catalog collections on disk.
 *
 * Every upload -- a full replace or an incremental append -- becomes its own
 * directory under data/collections/, so a bad upload cannot damage the catalog
 * the chat side is currently serving and rolling back is a one-line flip of
 * activeCollectionId in index.json.
 *
 * Only one collection is ever kept. Activating a new one prunes the rest:
 * nothing but the live collection is read at runtime, and each superseded
 * catalog would otherwise leave its whole vector set on disk forever. The
 * uploaded file is the source of truth, so a rollback is a re-upload.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(DIR, 'data');
const COLLECTIONS_DIR = path.join(DATA_DIR, 'collections');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');

/**
 * Write JSON via a temp file + rename. rename() is atomic within a filesystem,
 * so a crash mid-write leaves the previous file intact rather than a half-written
 * one that fails to parse on the next boot.
 */
export function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Collection ids are generated here, never supplied by a caller -- but they do
 * arrive back as URL path segments and query params. Validating the shape means
 * a crafted id like `../../etc` cannot walk out of the collections directory.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function collectionDir(id) {
  if (!isValidId(id)) throw new Error(`Invalid collection id: ${id}`);
  return path.join(COLLECTIONS_DIR, id);
}

// The readers answer "not found" for a malformed id rather than throwing, so a
// bad id from a URL is a 404 to the caller instead of a 500.
export function readManifest(id) {
  if (!isValidId(id)) return null;
  return readJson(path.join(collectionDir(id), 'manifest.json'));
}

export function readChunks(id) {
  if (!isValidId(id)) return [];
  return readJson(path.join(collectionDir(id), 'chunks.json'), []);
}

export function readEmbeddings(id) {
  if (!isValidId(id)) return null;
  return readJson(path.join(collectionDir(id), 'embeddings.json'));
}

/** A short, sortable, human-readable id: col_20260908_143012_a3f1 */
function newCollectionId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const salt = Math.random().toString(16).slice(2, 6);
  return `col_${stamp}_${salt}`;
}

// ---------------------------------------------------------------- registry

function readIndex() {
  return readJson(INDEX_PATH, { activeCollectionId: null, collections: [] });
}

function writeIndex(index) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(INDEX_PATH, index);
}

/** Summary rows for the admin table -- cheap, no chunk or vector files touched. */
export function listCollections() {
  const index = readIndex();
  return index.collections.map((c) => ({ ...c, active: c.id === index.activeCollectionId }));
}

export function activeCollectionId() {
  return readIndex().activeCollectionId;
}

export function getCollection(id) {
  return listCollections().find((c) => c.id === id) ?? null;
}

/** Create the directory and a `building` manifest. Returns the id. */
export function createCollection({ name, format, chunkStrategy }) {
  const id = newCollectionId();
  fs.mkdirSync(collectionDir(id), { recursive: true });

  const manifest = {
    id,
    name: name || id,
    format,
    chunkStrategy,
    status: 'building',
    createdAt: new Date().toISOString(),
    counts: { rows: 0, books: 0, rejected: 0, chunks: 0 },
    timings: {},
    rejected: [],
  };
  writeJsonAtomic(path.join(collectionDir(id), 'manifest.json'), manifest);

  const index = readIndex();
  index.collections.unshift(summarize(manifest));
  writeIndex(index);
  return id;
}

function summarize(m) {
  return {
    id: m.id,
    name: m.name,
    format: m.format,
    chunkStrategy: m.chunkStrategy,
    status: m.status,
    createdAt: m.createdAt,
    counts: m.counts,
    timings: m.timings,
    model: m.model,
    dims: m.dims,
  };
}

/** Merge fields into a manifest and mirror the summary into index.json. */
export function updateManifest(id, patch) {
  const current = readManifest(id);
  if (!current) throw new Error(`Unknown collection: ${id}`);
  const next = { ...current, ...patch };
  writeJsonAtomic(path.join(collectionDir(id), 'manifest.json'), next);

  const index = readIndex();
  const i = index.collections.findIndex((c) => c.id === id);
  if (i !== -1) index.collections[i] = summarize(next);
  writeIndex(index);
  return next;
}

export function saveRaw(id, filename, buffer) {
  fs.writeFileSync(path.join(collectionDir(id), filename), buffer);
}

export function saveChunks(id, chunks) {
  writeJsonAtomic(path.join(collectionDir(id), 'chunks.json'), chunks);
}

/**
 * `hashes` maps chunkId -> a digest of the text that produced the vector.
 * Without it an incremental upload could not tell a reusable vector from a
 * stale one: chunk ids are derived from the book id, so an edited description
 * keeps its chunk id while needing a fresh embedding.
 */
export function saveEmbeddings(id, { model, dims, vectors, hashes = {} }) {
  writeJsonAtomic(path.join(collectionDir(id), 'embeddings.json'), {
    model,
    dims,
    builtAt: new Date().toISOString(),
    hashes,
    vectors,
  });
}

/** The books of a collection, straight off its manifest. */
export function readBooks(id) {
  return readManifest(id)?.books ?? [];
}

export function setActive(id) {
  const manifest = readManifest(id);
  if (!manifest) throw new Error(`Unknown collection: ${id}`);
  if (manifest.status !== 'ready') {
    throw new Error(`Collection ${id} is "${manifest.status}", not ready to activate`);
  }
  const index = readIndex();
  index.activeCollectionId = id;
  writeIndex(index);
}

/**
 * Delete every finished collection except `keepId`.
 *
 * Called right after an activation succeeds. Deliberately not called before:
 * the outgoing collection is the vector cache a rebuild reads from, and it has
 * to stay intact until the replacement is proven loadable.
 *
 * A collection that is still `building` is skipped. Activating one catalog
 * while another upload is mid-embed is entirely normal, and deleting the
 * directory out from under that job would fail its next write for reasons that
 * look nothing like the actual cause.
 *
 * @returns {string[]} the ids that were removed
 */
export function pruneExcept(keepId) {
  const index = readIndex();
  const keep = new Set([keepId]);
  for (const c of index.collections) if (c.status === 'building') keep.add(c.id);

  const doomed = index.collections.filter((c) => !keep.has(c.id)).map((c) => c.id);
  for (const id of doomed) fs.rmSync(collectionDir(id), { recursive: true, force: true });
  index.collections = index.collections.filter((c) => keep.has(c.id));
  writeIndex(index);
  return doomed;
}

export function deleteCollection(id) {
  const index = readIndex();
  const manifest = readManifest(id);
  if (manifest?.status === 'building') {
    const err = new Error('That upload is still building -- wait for it to finish or fail');
    err.status = 409;
    throw err;
  }
  if (index.activeCollectionId === id) {
    const err = new Error(
      'Cannot delete the catalog that is currently serving readers. Upload a ' +
        'replacement and activate it -- that removes this one for you.'
    );
    err.status = 409;
    throw err;
  }
  fs.rmSync(collectionDir(id), { recursive: true, force: true });
  index.collections = index.collections.filter((c) => c.id !== id);
  writeIndex(index);
}
