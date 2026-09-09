'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const STAGES = [
  { key: 'parse', label: 'Parsing', hint: 'read rows from the file' },
  { key: 'validate', label: 'Validation', hint: 'normalise fields, reject bad rows' },
  { key: 'chunk', label: 'Chunking', hint: 'split records into embeddable text' },
  { key: 'embed', label: 'Embeddings', hint: 'one vector per chunk' },
];

const STRATEGIES = [
  {
    id: 'field-split',
    label: 'Field split',
    blurb: 'Two chunks per book: a factual profile and a themes/mood/summary chunk. Matches mood queries better.',
  },
  {
    id: 'whole-record',
    label: 'Whole record',
    blurb: 'One chunk per book. Simpler, but mood and hard facts share a single vector.',
  },
];

const PAGE_SIZE = 25;

function fmtMs(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Plain-language summary of a finished ingest, including anything it dropped. */
function doneText(job) {
  const s = job.summary ?? {};
  const notes = [];
  if (s.duplicates) notes.push(`${s.duplicates} duplicate row(s) collapsed`);
  if (s.rejected) notes.push(`${s.rejected} row(s) rejected`);
  if (s.reusedVectors) notes.push(`${s.reusedVectors} vector(s) reused from the live catalog`);
  return (
    `Built ${s.books ?? 0} books` +
    (notes.length ? ` — ${notes.join(', ')}` : '') +
    '. Activate it below to serve it to readers.'
  );
}

export default function Admin() {
  const [token, setToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [authError, setAuthError] = useState('');

  const [collections, setCollections] = useState([]);
  const [active, setActive] = useState(null);
  const [stats, setStats] = useState(null);

  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState('field-split');
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);

  const [job, setJob] = useState(null);
  const [notice, setNotice] = useState(null);
  const [inspect, setInspect] = useState(null);

  const [stock, setStock] = useState(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const pollRef = useRef(null);

  // Restore the token across reloads, but only for the tab -- sessionStorage,
  // not localStorage, so closing the tab drops it.
  useEffect(() => {
    const saved = sessionStorage.getItem('bookworm_admin_token');
    if (saved) setToken(saved);
  }, []);

  const api = useCallback(
    async (path, options = {}) => {
      const res = await fetch(`/api/admin/${path}`, {
        ...options,
        headers: { 'x-admin-token': token, ...(options.headers ?? {}) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    },
    [token]
  );

  const activeId = active?.id ?? null;

  const refresh = useCallback(async () => {
    const [cols, s] = await Promise.all([api('collections'), api('stats')]);
    setCollections(cols.collections);
    setActive(cols.active);
    setStats(s);
  }, [api]);

  const loadStock = useCallback(
    async (isCurrent) => {
      const params = new URLSearchParams({
        offset: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE),
      });
      if (query.trim()) params.set('q', query.trim());
      const data = await api(`books?${params}`);
      // Typing fast can leave an earlier request in flight; without this guard
      // its late reply overwrites the results for what was actually typed.
      if (isCurrent()) setStock(data);
    },
    [api, page, query]
  );

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    if (!token) return;
    let live = true;
    const isCurrent = () => live;
    const t = setTimeout(() => {
      loadStock(isCurrent).catch(() => {
        if (live) setStock(null);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [token, loadStock, activeId]);

  // A new catalog is a different set of books, so page 3 of the old one is
  // meaningless -- go back to the start rather than showing an empty table.
  useEffect(() => {
    setPage(0);
  }, [activeId]);

  /**
   * The export is an authenticated request, so it cannot be a plain <a href>:
   * the admin token lives in a header, not the URL. Fetch it and hand the
   * browser a blob instead.
   */
  async function download(format) {
    try {
      const res = await fetch(`/api/admin/books/export?format=${format}`, {
        headers: { 'x-admin-token': token },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');

      const name =
        /filename="?([^"]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        `catalog.${format}`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      // Anchored in the document and revoked on a later tick: some browsers
      // ignore a click on a detached node, and revoking synchronously can
      // cancel the download before it starts.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      setNotice({ kind: 'err', text: err.message });
    }
  }

  useEffect(() => {
    if (!token) return;
    refresh().catch((err) => {
      setAuthError(err.message);
      setToken('');
      sessionStorage.removeItem('bookworm_admin_token');
    });
  }, [token, refresh]);

  // Poll the running job. Cleared as soon as it settles so we stop hitting the
  // backend once there is nothing left to watch.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    pollRef.current = setInterval(async () => {
      try {
        const next = await api(`jobs/${job.jobId}`);
        setJob(next);
        if (next.status !== 'running') {
          clearInterval(pollRef.current);
          refresh();
          setNotice(
            next.status === 'done'
              ? { kind: 'ok', text: doneText(next) }
              : { kind: 'err', text: `Ingest failed: ${next.error}` }
          );
        }
      } catch (err) {
        clearInterval(pollRef.current);
        setNotice({ kind: 'err', text: err.message });
      }
    }, 700);
    return () => clearInterval(pollRef.current);
  }, [job, api, refresh]);

  function signIn(e) {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setAuthError('');
    sessionStorage.setItem('bookworm_admin_token', tokenInput.trim());
    setToken(tokenInput.trim());
    setTokenInput('');
  }

  function signOut() {
    sessionStorage.removeItem('bookworm_admin_token');
    setToken('');
    setCollections([]);
    setActive(null);
    setStats(null);
    setStock(null);
  }

  function pickFile(f) {
    if (!f) return;
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext !== 'csv' && ext !== 'json') {
      setNotice({ kind: 'err', text: 'Only .csv and .json catalogs are supported.' });
      return;
    }
    setNotice(null);
    setFile(f);
    if (!name) setName(f.name.replace(/\.(csv|json)$/i, ''));
  }

  async function upload(e) {
    e.preventDefault();
    if (!file) return;
    const format = file.name.split('.').pop().toLowerCase();
    const params = new URLSearchParams({ name: name || file.name, format, strategy });

    setNotice(null);
    try {
      const body = await file.arrayBuffer();
      const started = await api(`upload?${params}`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/octet-stream' },
      });
      setJob({ ...started, status: 'running', stages: {} });
    } catch (err) {
      setNotice({ kind: 'err', text: err.message });
    }
  }

  async function act(fn, successText) {
    try {
      await fn();
      await refresh();
      setNotice({ kind: 'ok', text: successText });
    } catch (err) {
      setNotice({ kind: 'err', text: err.message });
    }
  }

  async function openInspector(id) {
    try {
      const data = await api(`collections/${id}/chunks?limit=40`);
      setInspect({ id, ...data });
    } catch (err) {
      setNotice({ kind: 'err', text: err.message });
    }
  }

  // ------------------------------------------------------------------ gate

  if (!token) {
    return (
      <div className="shell">
        <header className="masthead">
          <h1>🔐 Bookworm admin</h1>
          <p>Enter the admin token from <code>backend/.env</code> to manage catalogs.</p>
        </header>
        <form className="card gate" onSubmit={signIn}>
          <label htmlFor="tok">Admin token</label>
          <input
            id="tok"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="ADMIN_TOKEN"
            autoFocus
          />
          <button type="submit" className="primary" disabled={!tokenInput.trim()}>
            Unlock
          </button>
          {authError && <p className="msg err">{authError}</p>}
          <p className="hint">
            The token is held in this tab only and is attached to requests server-side — it never
            reaches the browser bundle.
          </p>
        </form>
        <p className="backlink"><a href="/">← Back to chat</a></p>
      </div>
    );
  }

  // --------------------------------------------------------------- console

  return (
    <div className="shell">
      <header className="masthead admin-head">
        <div>
          <h1>📚 Bookworm admin</h1>
          <p>
            Upload your full stock and watch it move through the pipeline. Each upload is the whole
            catalog — to add, correct or remove a book, edit your file and upload it again. Nothing
            affects readers until you activate it.
          </p>
        </div>
        <div className="head-actions">
          <a href="/" className="ghost">Chat →</a>
          <button className="ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {active && (
        <div className="active-bar">
          <span className="dot up" />
          Serving <strong>{active.name}</strong> — {active.books} books, {active.chunks} chunks,{' '}
          <code>{active.chunkStrategy}</code>
        </div>
      )}

      {notice && <div className={`msg ${notice.kind}`}>{notice.text}</div>}

      <section className="card">
        <h2>1 · Upload your stock</h2>
        <p className="hint section-hint">
          This file replaces the live catalog entirely. Repeated rows — same <code>id</code>, or the
          same title and author — collapse into one book, and unchanged books keep the vectors they
          already have, so a re-upload only pays to embed what actually changed.
        </p>
        <form onSubmit={upload}>
          <div
            className={`drop ${dragging ? 'over' : ''} ${file ? 'has-file' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pickFile(e.dataTransfer.files?.[0]);
            }}
          >
            <input
              id="file"
              type="file"
              accept=".csv,.json"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            <label htmlFor="file">
              {file ? (
                <>
                  <strong>{file.name}</strong>
                  <span>{(file.size / 1024).toFixed(1)} KB — click to replace</span>
                </>
              ) : (
                <>
                  <strong>Drop a .csv or .json catalog here</strong>
                  <span>or click to browse</span>
                </>
              )}
            </label>
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="cname">Collection name</label>
              <input
                id="cname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Autumn 2026 catalog"
              />
            </div>
            <div className="field">
              <label>Chunking strategy</label>
              <div className="strategies">
                {STRATEGIES.map((s) => (
                  <label key={s.id} className={`strategy ${strategy === s.id ? 'on' : ''}`}>
                    <input
                      type="radio"
                      name="strategy"
                      value={s.id}
                      checked={strategy === s.id}
                      onChange={() => setStrategy(s.id)}
                    />
                    <span className="s-label">{s.label}</span>
                    <span className="s-blurb">{s.blurb}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <details className="schema">
            <summary>Expected columns</summary>
            <p>
              Required: <code>title</code>, <code>author</code>, <code>description</code>. Optional:{' '}
              <code>id</code>, <code>year</code>, <code>genres</code>, <code>readingLevel</code>,{' '}
              <code>pages</code>, <code>themes</code>, <code>mood</code>, <code>similarTo</code>.
            </p>
            <p>
              List columns take semicolons: <code>Fantasy;Adventure</code>. Headers are
              case-insensitive and <code>reading level</code> / <code>reading_level</code> both
              work. Rows missing a required field are reported, not fatal.
            </p>
          </details>

          <button
            type="submit"
            className="primary"
            disabled={!file || job?.status === 'running'}
          >
            {job?.status === 'running' ? 'Processing…' : 'Run the pipeline'}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>2 · Pipeline</h2>
        <div className="stages">
          {STAGES.map((s, i) => {
            const st = job?.stages?.[s.key];
            const status = st?.status ?? 'idle';
            return (
              <div key={s.key} className={`stage ${status}`}>
                <div className="s-top">
                  <span className="s-num">{i + 1}</span>
                  <span className="s-name">{s.label}</span>
                </div>
                <div className="s-count">
                  {status === 'running' && s.key === 'embed' && st.total
                    ? `${st.count ?? 0} / ${st.total}`
                    : st?.count != null
                      ? st.count
                      : '—'}
                </div>
                <div className="s-meta">
                  {status === 'running' && <span className="pulse">working…</span>}
                  {status === 'done' && <span>{fmtMs(st.ms)}</span>}
                  {status === 'failed' && <span className="fail">{st.error}</span>}
                  {status === 'idle' && <span>{s.hint}</span>}
                </div>
                {s.key === 'validate' && (st?.rejected > 0 || st?.duplicates > 0) && (
                  <div className="s-warn">
                    {[
                      st.rejected > 0 && `${st.rejected} rejected`,
                      st.duplicates > 0 && `${st.duplicates} duplicate`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
                {s.key === 'embed' && st?.status === 'done' && st.reused > 0 && (
                  <div className="s-warn ok">
                    {st.embedded} embedded · {st.reused} reused
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {!job && <p className="hint">Upload a file to watch each stage report its counts and timing.</p>}
      </section>

      <section className="card">
        <h2>3 · Collections</h2>
        <p className="hint section-hint">
          Activating a catalog makes it live and deletes the ones it supersedes — only the serving
          catalog is kept. Your uploaded file is the backup.
        </p>
        {collections.length === 0 ? (
          <p className="hint">No collections yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Books</th>
                  <th>Chunks</th>
                  <th>Rejected</th>
                  <th>Dupes</th>
                  <th>Strategy</th>
                  <th>Built</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {collections.map((c) => (
                  <tr key={c.id} className={c.active ? 'is-active' : undefined}>
                    <td>
                      {c.name}
                      {c.active && <span className="badge">active</span>}
                      {c.status !== 'ready' && <span className="badge warn">{c.status}</span>}
                    </td>
                    <td>{c.counts?.books ?? 0}</td>
                    <td>{c.counts?.chunks ?? 0}</td>
                    <td>{c.counts?.rejected ?? 0}</td>
                    <td>{c.counts?.duplicates ?? 0}</td>
                    <td><code>{c.chunkStrategy}</code></td>
                    <td className="dim">{fmtDate(c.createdAt)}</td>
                    <td className="actions">
                      <button onClick={() => openInspector(c.id)}>Inspect</button>
                      {!c.active && c.status === 'ready' && (
                        <button
                          onClick={() =>
                            act(
                              () => api(`collections/${c.id}/activate`, { method: 'POST' }),
                              `“${c.name}” is now live. Superseded catalogs were removed.`
                            )
                          }
                        >
                          Activate
                        </button>
                      )}
                      {!c.active && (
                        <button
                          className="danger"
                          onClick={() =>
                            act(
                              () => api(`collections/${c.id}`, { method: 'DELETE' }),
                              `Deleted “${c.name}”.`
                            )
                          }
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="stock-head">
          <h2>4 · Current stock</h2>
          <div className="head-actions">
            <button className="ghost" onClick={() => download('csv')} disabled={!stock?.total}>
              Download CSV
            </button>
            <button className="ghost" onClick={() => download('json')} disabled={!stock?.total}>
              Download JSON
            </button>
          </div>
        </div>

        {!stock?.total ? (
          <p className="hint">
            Nothing on the shelf yet — upload a catalog above and activate it.
          </p>
        ) : (
          <>
            <p className="hint section-hint">
              What readers are being recommended from right now. This view is read-only: your
              uploaded file is the source of truth, so the way to change a book is to download the
              catalog, edit it, and upload it back.
            </p>

            <input
              className="stock-search"
              value={query}
              placeholder="Search title, author, genre, theme or level…"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Author</th>
                    <th>Year</th>
                    <th>Level</th>
                    <th>Pages</th>
                    <th>Genres</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.books.map((b) => (
                    <tr key={b.id}>
                      <td>{b.title}</td>
                      <td>{b.author}</td>
                      <td className="dim">{b.year ?? '—'}</td>
                      <td><code>{b.readingLevel}</code></td>
                      <td className="dim">{b.pages ?? '—'}</td>
                      <td className="dim">{(b.genres ?? []).join(', ') || '—'}</td>
                    </tr>
                  ))}
                  {stock.books.length === 0 && (
                    <tr>
                      <td colSpan={6} className="dim">No book matches “{query}”.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="pager">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                ← Previous
              </button>
              <span className="dim">
                {stock.matched === 0
                  ? '0 books'
                  : `${stock.offset + 1}–${Math.min(stock.offset + stock.limit, stock.matched)} of ${stock.matched}`}
                {query && stock.matched !== stock.total ? ` (of ${stock.total} in stock)` : ''}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={stock.offset + stock.limit >= stock.matched}
              >
                Next →
              </button>
            </div>
          </>
        )}
      </section>

      {stats && (
        <section className="card">
          <h2>5 · Traffic</h2>
          <div className="stat-strip">
            <div><b>{stats.totalRequests}</b><span>requests</span></div>
            <div><b>{stats.latencyMs.p50}ms</b><span>p50</span></div>
            <div><b>{stats.latencyMs.p95}ms</b><span>p95</span></div>
            <div><b>{stats.errors}</b><span>errors (last {stats.sampled})</span></div>
            <div><b>{stats.gemini.chatCalls}</b><span>chat calls</span></div>
            <div><b>{stats.gemini.embedCalls}</b><span>embed calls</span></div>
            <div>
              <b>{(stats.gemini.promptTokens + stats.gemini.outputTokens).toLocaleString()}</b>
              <span>tokens</span>
            </div>
          </div>
          {stats.byPath.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Route</th><th>Calls</th><th>Errors</th><th>Avg</th></tr>
                </thead>
                <tbody>
                  {stats.byPath.slice(0, 8).map((r) => (
                    <tr key={r.route}>
                      <td><code>{r.route}</code></td>
                      <td>{r.count}</td>
                      <td>{r.errors}</td>
                      <td>{fmtMs(r.avgMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {inspect && (
        <div className="drawer-backdrop" onClick={() => setInspect(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h2>Chunks</h2>
              <button className="ghost" onClick={() => setInspect(null)}>Close</button>
            </div>
            <p className="hint">
              {inspect.total} chunks from {inspect.counts?.books ?? 0} books using{' '}
              <code>{inspect.chunkStrategy}</code>. Showing the first {inspect.chunks.length}.
            </p>

            {inspect.duplicates?.length > 0 && (
              <details className="rejected" open>
                <summary>{inspect.duplicates.length} duplicate row(s) collapsed</summary>
                <ul>
                  {inspect.duplicates.slice(0, 30).map((d) => (
                    <li key={d.row}>Row {d.row}: {d.reason}</li>
                  ))}
                </ul>
              </details>
            )}

            {inspect.rejected?.length > 0 && (
              <details className="rejected" open>
                <summary>{inspect.rejected.length} rejected row(s)</summary>
                <ul>
                  {inspect.rejected.slice(0, 30).map((r) => (
                    <li key={r.row}>Row {r.row}: {r.reason}</li>
                  ))}
                </ul>
              </details>
            )}

            <ol className="chunk-list">
              {inspect.chunks.map((c) => (
                <li key={c.chunkId}>
                  <div className="c-head">
                    <code>{c.chunkId}</code>
                    <span className="kind">{c.kind}</span>
                    <span className="dim">{c.text.length} chars</span>
                  </div>
                  <pre>{c.text}</pre>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      )}
    </div>
  );
}
