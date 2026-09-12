/**
 * The ingestion pipeline runner, plus the in-memory job registry the admin
 * console polls.
 *
 * Stages: parse -> validate -> chunk -> embed. Each one records a duration and
 * a count so the console can show where the time actually went.
 *
 * Every upload is the WHOLE catalog: the file the admin sends is the store's
 * current stock in full, and it replaces whatever came before. Adding a title,
 * fixing a blurb and removing a sold-out book are all the same operation --
 * edit the spreadsheet, upload it again. There is no partial-update path to get
 * out of sync with.
 *
 * A run only ever writes rows belonging to its own new collection, so a failed
 * or half-finished upload can never damage the catalog the chat side is serving.
 * The previous collection is not discarded until the new one is activated.
 */

import { embedBatch } from '../gemini.js';
import { parseCatalog } from './parse.js';
import { chunkBooks, DEFAULT_STRATEGY } from './chunk.js';
import {
  activeCollectionId,
  copyReusableEmbeddings,
  createCollection,
  readUnembeddedChunks,
  saveChunks,
  saveEmbeddings,
  saveRaw,
  updateManifest,
} from '../collections.js';

const STAGES = ['parse', 'validate', 'chunk', 'embed'];

const embedModel = () => process.env.EMBED_MODEL || 'gemini-embedding-001';
const embedDims = () => Number(process.env.EMBED_DIMS) || 768;

// ------------------------------------------------------------------ jobs

/** Jobs are deliberately in-process: they are progress UI, not durable state. */
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function newJob(collectionId) {
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 6)}`;
  jobs.set(jobId, {
    jobId,
    collectionId,
    status: 'running',
    stage: null,
    startedAt: Date.now(),
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: 'pending' }])),
    summary: null,
    error: null,
  });
  return jobs.get(jobId);
}

export function getJob(jobId) {
  return jobs.get(jobId) ?? null;
}

function sweepJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.startedAt < cutoff) jobs.delete(id);
}

/** Run one stage, timing it and recording the outcome on the job. */
async function stage(job, name, fn) {
  job.stage = name;
  const entry = job.stages[name];
  entry.status = 'running';
  entry.startedAt = Date.now();
  try {
    const result = await fn(entry);
    entry.status = 'done';
    entry.ms = Date.now() - entry.startedAt;
    return result;
  } catch (err) {
    entry.status = 'failed';
    entry.ms = Date.now() - entry.startedAt;
    entry.error = err.message;
    throw err;
  }
}

// ------------------------------------------------------------- embedding

/**
 * Give every chunk of `collectionId` a vector.
 *
 * The reuse half is a single UPDATE: Postgres copies across any vector whose
 * chunk id and text hash still match the collection we are building on top of,
 * so unchanged rows never leave the database, let alone go to Gemini. Only what
 * is left without a vector afterwards is actually embedded.
 *
 * See copyReusableEmbeddings() for why the hash, not the chunk id, is the thing
 * that decides reusability.
 */
async function resolveVectors(collectionId, baseId, total, onProgress) {
  const model = embedModel();
  const dims = embedDims();

  const reused = await copyReusableEmbeddings(collectionId, baseId, { model, dims });
  onProgress?.({ done: reused, total, reused });

  const todo = await readUnembeddedChunks(collectionId);

  let vectors = [];
  if (todo.length) {
    const fresh = await embedBatch(
      todo.map((c) => c.text),
      'RETRIEVAL_DOCUMENT',
      ({ done }) => onProgress?.({ done: reused + done, total, reused })
    );
    vectors = todo.map((c, i) => ({ chunkId: c.chunkId, vector: fresh[i] }));
  }

  // Called even with nothing fresh to write: it also stamps the model and
  // dimensionality the collection was built at, which is what a later upload
  // checks before reusing any of these vectors.
  await saveEmbeddings(collectionId, vectors, { model, dims });

  return { model, dims, embedded: todo.length, reused };
}

// -------------------------------------------------------------- the pipeline

/**
 * Kick off an ingest. Returns immediately with the job -- the work continues in
 * the background so the upload request does not sit open for the whole embed.
 */
export async function startIngest({ name, format, chunkStrategy = DEFAULT_STRATEGY, buffer }) {
  sweepJobs();

  // The live collection is the vector cache for this build. It stays untouched
  // and readable until the admin activates the replacement.
  const baseId = await activeCollectionId();

  const collectionId = await createCollection({ name, format, chunkStrategy });
  const job = newJob(collectionId);

  runIngest({ job, collectionId, format, chunkStrategy, baseId, buffer }).catch((err) => {
    job.status = 'failed';
    job.error = err.message;
    console.error(`[ingest] ${collectionId} failed: ${err.message}`);
    // Recording the failure must not itself throw: this runs in a detached
    // promise, so an exception here would surface as an unhandled rejection and
    // take the whole server down instead of failing one upload.
    updateManifest(collectionId, { status: 'failed', error: err.message }).catch((writeErr) => {
      console.error(`[ingest] could not mark ${collectionId} failed: ${writeErr.message}`);
    });
  });

  return job;
}

async function runIngest({ job, collectionId, format, chunkStrategy, baseId, buffer }) {
  await saveRaw(collectionId, `raw.${format}`, buffer);

  const parsed = await stage(job, 'parse', (entry) => {
    const result = parseCatalog(buffer.toString('utf8'), format);
    entry.count = result.rowCount;
    return result;
  });

  await stage(job, 'validate', (entry) => {
    entry.count = parsed.books.length;
    entry.rejected = parsed.rejected.length;
    entry.duplicates = parsed.duplicates.length;
    if (!parsed.books.length) {
      throw new Error(
        parsed.rejected.length
          ? `every row was rejected (first reason: ${parsed.rejected[0].reason})`
          : 'the file contained no rows'
      );
    }
  });

  const chunks = await stage(job, 'chunk', (entry) => {
    const result = chunkBooks(parsed.books, chunkStrategy);
    entry.count = result.length;
    return result;
  });

  const summary = {
    rows: parsed.rowCount,
    books: parsed.books.length,
    rejected: parsed.rejected.length,
    duplicates: parsed.duplicates.length,
  };

  // Books are their own rows; chunks carry the text retrieval scores against.
  await updateManifest(collectionId, {
    books: parsed.books,
    // Cap both: a broken file could reject or duplicate thousands of rows, and
    // the manifest is read on every admin page load.
    rejected: parsed.rejected.slice(0, 200),
    duplicates: parsed.duplicates.slice(0, 200),
    summary,
    counts: {
      rows: parsed.rowCount,
      books: parsed.books.length,
      rejected: parsed.rejected.length,
      duplicates: parsed.duplicates.length,
      chunks: chunks.length,
    },
  });
  await saveChunks(collectionId, chunks);

  const { model, dims } = await stage(job, 'embed', async (entry) => {
    entry.count = 0;
    entry.total = chunks.length;
    const result = await resolveVectors(collectionId, baseId, chunks.length, (p) => {
      entry.count = p.done;
      entry.reused = p.reused;
    });
    entry.count = chunks.length;
    entry.embedded = result.embedded;
    entry.reused = result.reused;
    summary.embedded = result.embedded;
    summary.reusedVectors = result.reused;
    return result;
  });

  const timings = Object.fromEntries(STAGES.map((s) => [s, job.stages[s].ms]));
  await updateManifest(collectionId, { status: 'ready', model, dims, timings, summary });

  job.summary = summary;
  job.status = 'done';
  job.stage = null;
  console.log(
    `[ingest] ${collectionId} ready -- ${parsed.books.length} books, ${chunks.length} chunks ` +
      `(${summary.embedded} embedded, ${summary.reusedVectors} reused)`
  );
}
