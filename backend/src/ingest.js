/**
 * Standalone re-index: `npm run ingest`
 * Run this after editing data/books.json to refresh the embedding cache.
 */
import 'dotenv/config';
import { buildIndex } from './vectorStore.js';

buildIndex({ force: true })
  .then((r) => console.log(`Done. ${r.count} books embedded.`))
  .catch((err) => {
    console.error('Ingest failed:', err.message);
    process.exit(1);
  });
