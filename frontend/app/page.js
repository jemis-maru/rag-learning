'use client';

import { useEffect, useRef, useState } from 'react';

const GREETING = {
  role: 'model',
  text:
    "Hi, I'm **Bookworm**. Tell me what you're in the mood for — a genre, a vibe, a book you loved, how much time you have — and I'll dig through my catalog for something that fits.",
};

const STARTERS = [
  'Something funny and short to break a reading slump',
  'Cozy fantasy with no violence, please',
  'I loved Project Hail Mary — what next?',
  'A first novel for a 10-year-old who hates reading',
  'Nonfiction that reads like a thriller',
  'Literary fiction that will wreck me',
];

/**
 * Minimal markdown renderer for the subset Gemini actually emits here
 * (**bold**, *italic*, `code`, - lists). Escapes HTML first, so model output
 * can never inject markup.
 */
function renderMarkdown(src) {
  const escape = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inline = (s) =>
    escape(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const blocks = [];
  let list = null;

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);

    if (bullet) {
      list ??= [];
      list.push(inline(bullet[1]));
      continue;
    }
    if (list) {
      blocks.push(`<ul>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`);
      list = null;
    }
    if (line) blocks.push(`<p>${inline(line)}</p>`);
  }
  if (list) blocks.push(`<ul>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`);

  return blocks.join('');
}

function Sources({ sources, searchQuery, userMessage }) {
  if (!sources?.length) return null;
  const rewritten = searchQuery && searchQuery !== userMessage;

  return (
    <details className="retrieved">
      <summary>Retrieved {sources.length} catalog entries →</summary>
      {rewritten && <p className="rewrite">Search query used: “{searchQuery}”</p>}
      <ol>
        {sources.map((s) => {
          // pages and genres are optional columns, so build the detail list from
          // whatever this book actually has -- otherwise a sparse row renders as
          // "(intermediate, p, )".
          const detail = [
            s.readingLevel,
            s.pages ? `${s.pages}p` : null,
            s.genres?.slice(0, 2).join('/') || null,
          ].filter(Boolean);

          return (
            <li key={s.id}>
              <span className="sim">{s.similarity.toFixed(3)}</span> — {s.title}
              {detail.length ? ` (${detail.join(', ')})` : ''}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export default function Home() {
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState({ count: 0, genres: [], readingLevels: [] });
  const [genre, setGenre] = useState('');
  const [readingLevel, setReadingLevel] = useState('');
  const [health, setHealth] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    fetch('/api/catalog')
      .then((r) => r.json())
      .then(setCatalog)
      .catch(() => {});
    // The pipeline badges report the models actually in use rather than
    // hardcoded strings, which used to drift from backend/.env silently.
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  async function send(text) {
    const question = (text ?? input).trim();
    if (!question || busy) return;

    // Only the plain turns go back to the model; sources/errors stay UI-only.
    const history = messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, text: m.text }));

    setMessages((prev) => [...prev, { role: 'user', text: question }]);
    setInput('');
    setBusy(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: question,
          history,
          filters: { genre: genre || undefined, readingLevel: readingLevel || undefined },
        }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      setMessages((prev) => [
        ...prev,
        {
          role: 'model',
          text: data.answer,
          sources: data.sources,
          searchQuery: data.searchQuery,
          userMessage: question,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'model', error: true, text: `**Something went wrong.** ${err.message}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">📚</span>
          <div>
            <h1>Bookworm</h1>
            <p className="tagline">Retrieval-augmented book recommendations</p>
          </div>
        </div>
        <div className="pipeline">
          <span>Next.js</span>
          <span>→ Express</span>
          <span>→ {health?.embedModel ?? 'embeddings'}</span>
          <span>
            → {health?.chunks ?? 0} chunks
            {health?.collection?.chunkStrategy ? ` (${health.collection.chunkStrategy})` : ''}
          </span>
          <span>→ cosine top-{health?.retrieveK ?? 6}</span>
          <span>→ {health?.chatModel ?? 'gemini'}</span>
        </div>
        <p className="lede">
          {catalog.count ? (
            <>
              Every suggestion is grounded in a {catalog.count}-book catalog — open “Retrieved
              catalog entries” under any answer to see exactly what the model was given.
            </>
          ) : (
            <>No catalog is available yet, so recommendations are paused for the moment.</>
          )}
        </p>
      </header>

      <div className="layout">
        <main className="card chat">
          <div className="messages">
            {messages.map((m, i) => (
              <div key={i} className={`row ${m.role}`}>
                <div className="bubble">
                  <div className="who">{m.role === 'user' ? 'You' : 'Bookworm'}</div>
                  <div
                    className={m.error ? 'err' : undefined}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
                  />
                  <Sources
                    sources={m.sources}
                    searchQuery={m.searchQuery}
                    userMessage={m.userMessage}
                  />
                </div>
              </div>
            ))}

            {busy && (
              <div className="row model">
                <div className="bubble">
                  <div className="who">Bookworm</div>
                  <div className="typing">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="composer">
            <textarea
              rows={1}
              value={input}
              placeholder="What are you in the mood to read?"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
            <button className="send" onClick={() => send()} disabled={busy || !input.trim()}>
              Send
            </button>
          </div>
        </main>

        <aside className="sidebar">
          <section className="card">
            <h2>Narrow the search</h2>
            <div className="field">
              <label htmlFor="genre">Genre</label>
              <select id="genre" value={genre} onChange={(e) => setGenre(e.target.value)}>
                <option value="">Any genre</option>
                {catalog.genres.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="level">Reading level</label>
              <select
                id="level"
                value={readingLevel}
                onChange={(e) => setReadingLevel(e.target.value)}
              >
                <option value="">Any level</option>
                {catalog.readingLevels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="status">
              <span className={`dot ${catalog.count ? 'up' : 'down'}`} />
              {catalog.count ? `${catalog.count} books indexed` : 'No catalog available yet'}
            </div>
            {catalog.collection && (
              <div className="status collection-name">
                Serving <strong>{catalog.collection.name}</strong>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Try asking</h2>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s} onClick={() => send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </section>

          <section className="card">
            <button className="reset" onClick={() => setMessages([GREETING])} disabled={busy}>
              Start a new conversation
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}
