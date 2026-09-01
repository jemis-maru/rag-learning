/**
 * Thin wrapper over the Google Generative Language REST API.
 * We call REST directly with fetch instead of an SDK so the two moving parts of
 * RAG -- embedding text and generating an answer -- stay visible and debuggable.
 */

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'paste_your_key_here') {
    throw new Error(
      'GEMINI_API_KEY is missing. Copy backend/.env.example to backend/.env and paste your key from https://aistudio.google.com/apikey'
    );
  }
  return key;
}

async function callGemini(path, body) {
  const res = await fetch(`${API_ROOT}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    // Gemini puts a useful message in error.message -- surface it, don't swallow it.
    let detail = text;
    try {
      detail = JSON.parse(text)?.error?.message ?? text;
    } catch {}
    throw new Error(`Gemini ${res.status} on ${path}: ${detail}`);
  }
  return JSON.parse(text);
}

const EMBED_MODEL = () => process.env.EMBED_MODEL || 'gemini-embedding-001';
const CHAT_MODEL = () => process.env.CHAT_MODEL || 'gemini-3.6-flash';

/**
 * gemini-embedding-001 returns 3072 dims by default. 768 is plenty for a 50-book
 * catalog and keeps the cache file ~4x smaller, with no measurable retrieval loss.
 */
const EMBED_DIMS = () => Number(process.env.EMBED_DIMS) || 768;

/**
 * Google truncates rather than re-normalizes when outputDimensionality < 3072,
 * so unit-normalize here. Cosine similarity would divide the norms out anyway,
 * but this keeps the cached vectors correct for plain dot-product use too.
 */
function normalize(v) {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm === 0 ? v : v.map((x) => x / norm);
}

/**
 * Embed a single string.
 * taskType matters: catalog entries are RETRIEVAL_DOCUMENT, user questions are
 * RETRIEVAL_QUERY. Using the right one measurably improves retrieval quality.
 */
export async function embed(text, taskType = 'RETRIEVAL_QUERY') {
  const model = EMBED_MODEL();
  const data = await callGemini(`${model}:embedContent`, {
    model: `models/${model}`,
    content: { parts: [{ text }] },
    taskType,
    outputDimensionality: EMBED_DIMS(),
  });
  return normalize(data.embedding.values);
}

/** Embed many strings in one round trip (max ~100 per request). */
export async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const model = EMBED_MODEL();
  const out = [];
  for (let i = 0; i < texts.length; i += 90) {
    const slice = texts.slice(i, i + 90);
    const data = await callGemini(`${model}:batchEmbedContents`, {
      requests: slice.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBED_DIMS(),
      })),
    });
    out.push(...data.embeddings.map((e) => normalize(e.values)));
  }
  return out;
}

/**
 * Generate an answer.
 * @param {object} p
 * @param {string} p.system          system instruction (role + rules + retrieved context)
 * @param {{role:'user'|'model',text:string}[]} p.history  prior turns
 * @param {string} p.message         the current user message
 */
export async function generate({ system, history = [], message, temperature = 0.7 }) {
  const contents = [
    ...history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const model = CHAT_MODEL();

  const generationConfig = {
    temperature,
    // Reasoning tokens are billed against maxOutputTokens on thinking models, and
    // they routinely run 500-800 for a prompt this size. A 1200 cap therefore
    // truncates the visible answer mid-sentence -- leave plenty of headroom.
    maxOutputTokens: 4096,
  };

  // Gemini 3 takes thinkingLevel; 2.5 took a thinkingBudget integer instead, so
  // only send this to the family that accepts it or the API returns 400.
  if (/gemini-3/.test(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  }

  const data = await callGemini(`${model}:generateContent`, {
    contents,
    systemInstruction: { parts: [{ text: system }] },
    generationConfig,
  });

  const candidate = data.candidates?.[0];
  const answer = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('') ?? '';

  if (!answer) {
    const reason = candidate?.finishReason ?? data.promptFeedback?.blockReason ?? 'unknown';
    throw new Error(`Gemini returned no text (finishReason: ${reason})`);
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    console.warn('[gemini] answer hit the output cap and may be truncated');
  }
  return answer;
}
