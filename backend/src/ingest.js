/**
 * Standalone catalog import: `npm run ingest <file.csv|file.json> [strategy]`
 *
 * The same pipeline the admin console drives, for seeding a dev machine or
 * scripting a deploy. A file argument is required -- there is no implicit
 * dataset, and nothing is embedded unless you name a file to embed.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { getJob, startIngest } from './pipeline/run.js';
import { pruneExcept, setActive } from './collections.js';
import { DEFAULT_STRATEGY, STRATEGIES } from './pipeline/chunk.js';

const [file, strategy = DEFAULT_STRATEGY] = process.argv.slice(2);

const USAGE = `Usage: npm run ingest <file.csv|file.json> [${STRATEGIES.join('|')}]

The file is the catalog in full -- it replaces whatever is loaded now.
Example: npm run ingest fixtures/books-50.csv`;

async function main() {
  if (!file) throw new Error(USAGE);
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);

  const format = path.extname(file).slice(1).toLowerCase();
  if (format !== 'csv' && format !== 'json') throw new Error('file must be .csv or .json');
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`strategy must be one of: ${STRATEGIES.join(', ')}`);
  }

  const job = startIngest({
    name: path.basename(file),
    format,
    chunkStrategy: strategy,
    buffer: fs.readFileSync(file),
  });

  // Poll the same job object the admin console polls over HTTP.
  while (getJob(job.jobId).status === 'running') {
    await new Promise((r) => setTimeout(r, 250));
  }

  const done = getJob(job.jobId);
  if (done.status === 'failed') throw new Error(done.error);

  setActive(done.collectionId);
  const pruned = pruneExcept(done.collectionId);

  const stages = Object.entries(done.stages)
    .map(([name, s]) => `${name} ${s.count ?? 0} (${s.ms}ms)`)
    .join('  ');
  const { books, duplicates, rejected, embedded, reusedVectors } = done.summary;

  console.log(
    `Done. ${stages}\n` +
      `${books} books -- ${embedded} chunks embedded, ${reusedVectors} reused` +
      (duplicates ? `, ${duplicates} duplicate row(s) collapsed` : '') +
      (rejected ? `, ${rejected} row(s) rejected` : '') +
      `\nActivated ${done.collectionId}.` +
      (pruned.length ? ` Pruned ${pruned.length} superseded collection(s).` : '')
  );
}

main().catch((err) => {
  console.error('Ingest failed:', err.message);
  process.exit(1);
});
