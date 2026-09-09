/**
 * The RAG pipeline: rewrite -> retrieve -> augment -> generate.
 */

import { generate } from './gemini.js';
import { DEFAULT_K, retrieve } from './vectorStore.js';

/**
 * Turn a follow-up like "something shorter?" into a standalone search query,
 * because embedding "something shorter?" on its own retrieves nothing useful.
 * Cheap heuristic first, one small LLM call only when the message really is
 * context-dependent.
 */
async function buildSearchQuery(message, history) {
  if (history.length === 0) return message;
  if (message.split(/\s+/).length > 12) return message; // already self-contained

  // Rewriting costs a second chat call per turn. On the free tier that halves how
  // many questions you can ask before hitting the quota, so allow turning it off.
  if (process.env.ENABLE_QUERY_REWRITE === 'false') return message;

  const transcript = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Reader' : 'Bot'}: ${m.text}`)
    .join('\n');

  try {
    const rewritten = await generate({
      system:
        'You rewrite a reader\'s latest message into a single standalone book-search query. ' +
        'Fold in any genre, mood, reading level or length constraints implied by the conversation. ' +
        'Reply with the query only -- no quotes, no preamble, no explanation.',
      message: `Conversation so far:\n${transcript}\n\nLatest message: ${message}\n\nStandalone search query:`,
      temperature: 0,
    });
    const clean = rewritten.trim().split('\n')[0].slice(0, 300);
    return clean || message;
  } catch {
    return message; // rewriting is an optimisation, never a hard dependency
  }
}

const SYSTEM_RULES = `You are Bookworm, a warm and knowledgeable book recommendation assistant.

HOW TO ANSWER
- Recommend ONLY books from the CATALOG below. Never invent a title, author, or detail.
- Normally suggest 2-4 books, best match first. If the reader asks for one, give one.
- For each: **Title** by Author, then 2-3 sentences on why it fits THEIR stated interests, plus genre, reading level and page count.
- Tie every recommendation back to what they actually asked for ("you wanted funny and short, so...").
- Mention relevant content warnings when the catalog notes heavy material.
- Ask one short follow-up question at the end to narrow things down further.

WHEN THE CATALOG FALLS SHORT
- If nothing is a good fit, say so plainly and offer the closest options as "not exactly what you asked for, but...".
- If a reader names a book that is not in the catalog, say you do not have it, then recommend catalog books that are similar in feel.
- Never pad an answer with books you were not given.

STYLE
- Conversational and enthusiastic, never a sales pitch. Use markdown. Keep it under ~250 words.`;

function formatContext(hits) {
  return hits
    .map(
      (h, i) =>
        `--- CATALOG ENTRY ${i + 1} (relevance ${h.semantic.toFixed(3)}) ---\n${h.document}`
    )
    .join('\n\n');
}

/**
 * Answer one chat turn.
 * @param {string} message
 * @param {{role:'user'|'model',text:string}[]} history
 * @param {{genre?:string, readingLevel?:string}} filters
 */
export async function answer({ message, history = [], filters = {} }) {
  const searchQuery = await buildSearchQuery(message, history);
  const hits = await retrieve(searchQuery, { k: DEFAULT_K(), filters });

  // Retrieval applies a relevance floor, so an off-topic question legitimately
  // returns nothing. Say so explicitly rather than sending an empty CATALOG
  // block, which reads to the model like a formatting glitch.
  const catalogBlock = hits.length
    ? formatContext(hits)
    : '(No catalog entry was a close enough match for this request.)';

  const system = `${SYSTEM_RULES}

=========================
CATALOG (the only books you may recommend)
=========================
${catalogBlock}`;

  const text = await generate({ system, history, message });

  return {
    answer: text,
    searchQuery,
    // Sent to the UI so the user can see what retrieval actually pulled --
    // the single most useful thing to expose when debugging a RAG app.
    sources: hits.map((h) => ({
      id: h.book.id,
      title: h.book.title,
      author: h.book.author,
      genres: h.book.genres,
      readingLevel: h.book.readingLevel,
      pages: h.book.pages,
      score: Number(h.score.toFixed(4)),
      similarity: Number(h.semantic.toFixed(4)),
    })),
  };
}
