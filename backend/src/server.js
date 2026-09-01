import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { answer } from './rag.js';
import { buildIndex, isReady, size, allBooks, retrieve } from './vectorStore.js';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 4000;

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    indexReady: isReady(),
    books: size(),
    chatModel: process.env.CHAT_MODEL || 'gemini-3.6-flash',
    embedModel: process.env.EMBED_MODEL || 'gemini-embedding-001',
    embedDims: Number(process.env.EMBED_DIMS) || 768,
  });
});

/** Powers the genre / reading-level filter dropdowns in the UI. */
app.get('/api/catalog', (req, res) => {
  const books = allBooks();
  const genres = [...new Set(books.flatMap((b) => b.genres))].sort();
  const levels = ['beginner', 'middle-grade', 'young-adult', 'intermediate', 'advanced'].filter(
    (l) => books.some((b) => b.readingLevel === l)
  );
  res.json({ count: books.length, genres, readingLevels: levels });
});

/** Retrieval only -- handy for checking the vector search without burning chat tokens. */
app.post('/api/search', async (req, res, next) => {
  try {
    const { query, k = 6, filters = {} } = req.body ?? {};
    if (!query?.trim()) return res.status(400).json({ error: 'query is required' });
    const hits = await retrieve(query.trim(), { k: Math.min(Number(k) || 6, 20), filters });
    res.json({
      query,
      results: hits.map((h) => ({ ...h.book, score: Number(h.score.toFixed(4)) })),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const { message, history = [], filters = {} } = req.body ?? {};

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: 'message is too long (2000 char max)' });
    }

    // Keep only well-formed turns, and cap history so the prompt cannot grow unbounded.
    const cleanHistory = (Array.isArray(history) ? history : [])
      .filter((m) => (m?.role === 'user' || m?.role === 'model') && typeof m.text === 'string')
      .slice(-10)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));

    const result = await answer({ message: message.trim(), history: cleanHistory, filters });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  const missingKey = err.message.includes('GEMINI_API_KEY');
  res.status(missingKey ? 500 : 502).json({ error: err.message });
});

// Build the index before accepting traffic so the first user request is fast.
buildIndex()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`[server] http://localhost:${PORT} -- ${size()} books indexed`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `\n[fatal] port ${PORT} is already in use -- another copy of this server is ` +
            `probably still running.\n  Stop it, or set PORT=4001 in backend/.env.\n`
        );
        process.exit(1);
      }
      throw err;
    });
  })
  .catch((err) => {
    console.error('\n[fatal] could not build the index:\n  ' + err.message + '\n');
    process.exit(1);
  });
