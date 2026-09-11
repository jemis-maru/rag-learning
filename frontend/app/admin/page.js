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

/**
 * Sign-in failures are reported without detail on purpose: the exact reason
 * (bad token vs. auth not configured) is useful to an attacker and to nobody
 * else. Real diagnostics stay in the server log.
 */
const SIGN_IN_ERROR = 'Could not sign in. Check your token and try again.';

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
    '. Publish it below to serve it to readers.'
  );
}

export default function Admin() {
  const [token, setToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [authError, setAuthError] = useState('');

  const [collections, setCollections] = useState([]);
  const [active, setActive] = useState(null);

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
    const cols = await api('collections');
    setCollections(cols.collections);
    setActive(cols.active);
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
    refresh().catch(() => {
      setAuthError(SIGN_IN_ERROR);
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
      <div className="auth-wrap">
        <form className="auth-card" onSubmit={signIn}>
          <div className="auth-mark" aria-hidden="true">
            🔒
          </div>
          <h1>Sign in</h1>
          <p className="auth-sub">Bookworm catalog management</p>

          <div className="field">
            <label htmlFor="tok">Access token</label>
            <input
              id="tok"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="••••••••••••"
              autoComplete="current-password"
              autoFocus
            />
          </div>

          <button type="submit" className="primary" disabled={!tokenInput.trim()}>
            Continue
          </button>

          {authError && <p className="msg err">{authError}</p>}

          <p className="auth-foot">
            <a href="/">← Back to Bookworm</a>
          </p>
        </form>
      </div>
    );
  }

  // --------------------------------------------------------------- console

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            📚
          </span>
          <div>
            <h1>
              Bookworm <span className="badge">Admin</span>
            </h1>
            <p className="tagline">Catalog management</p>
          </div>
        </div>
        <div className="topbar-actions">
          <a href="/" className="ghost">
            <span className="long">View site →</span>
            <span className="short">Site →</span>
          </a>
          <button className="ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="admin-main">
        {active ? (
          <div className="live-bar">
            <span className="dot up" />
            <span>
              Live: <span className="live-name">{active.name}</span>
            </span>
            <span className="live-meta">
              <span className="chip">
                <b>{active.books}</b> books
              </span>
              <span className="chip">
                <b>{active.chunks}</b> chunks
              </span>
              <span className="chip">
                <code>{active.chunkStrategy}</code>
              </span>
            </span>
          </div>
        ) : (
          <div className="live-bar idle">
            <span className="dot down" />
            <span>Nothing is live yet — upload a catalog to get started.</span>
          </div>
        )}

        {notice && <div className={`msg ${notice.kind}`}>{notice.text}</div>}

        {/* ---------------------------------------------------------- upload */}
        <section className="card">
          <div className="section-title">
            <span className="step">1</span>
            <h2>Upload your stock</h2>
          </div>
          <p className="hint section-hint">
            Each upload is the whole catalog and replaces the live one once published. Repeated rows
            — same <code>id</code>, or the same title and author — collapse into one book, and
            unchanged books keep the vectors they already have, so a re-upload only pays to embed
            what actually changed.
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
                <span className="drop-icon" aria-hidden="true">
                  {file ? '📄' : '⬆️'}
                </span>
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
                <span className="field-label">Chunking strategy</span>
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
                Required: <code>title</code>, <code>author</code>, <code>description</code>.
                Optional: <code>id</code>, <code>year</code>, <code>genres</code>,{' '}
                <code>readingLevel</code>, <code>pages</code>, <code>themes</code>,{' '}
                <code>mood</code>, <code>similarTo</code>.
              </p>
              <p>
                List columns take semicolons: <code>Fantasy;Adventure</code>. Headers are
                case-insensitive and <code>reading level</code> / <code>reading_level</code> both
                work. Rows missing a required field are reported, not fatal.
              </p>
            </details>

            <div className="form-foot">
              <button type="submit" className="primary" disabled={!file || job?.status === 'running'}>
                {job?.status === 'running' ? 'Processing…' : 'Run the pipeline'}
              </button>
              {file && job?.status !== 'running' && (
                <span className="hint inline">
                  Readers keep seeing the live catalog until you publish this one.
                </span>
              )}
            </div>
          </form>
        </section>

        {/* -------------------------------------------------------- pipeline */}
        <section className="card">
          <div className="section-title">
            <span className="step">2</span>
            <h2>Pipeline</h2>
          </div>
          <p className="hint section-hint">
            Each stage reports its own counts and timing as the upload moves through.
          </p>
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
        </section>

        {/* ------------------------------------------------------ collections */}
        <section className="card">
          <div className="section-title">
            <span className="step">3</span>
            <h2>Catalog</h2>
          </div>
          <p className="hint section-hint">
            Only one catalog is kept. Publishing a new build makes it live and removes the one it
            replaces — your uploaded file is the backup.
          </p>

          {collections.length === 0 ? (
            <p className="empty">No catalog has been built yet.</p>
          ) : (
            <div className="versions">
              {collections.map((c) => (
                <article key={c.id} className={`version ${c.active ? 'is-live' : ''}`}>
                  <div className="version-main">
                    <div className="version-name">
                      <span className="label">{c.name}</span>
                      {c.active && <span className="badge live">Live</span>}
                      {!c.active && c.status === 'ready' && <span className="badge">Ready</span>}
                      {c.status !== 'ready' && <span className="badge warn">{c.status}</span>}
                    </div>
                    <div className="chips">
                      <span className="chip">
                        <b>{c.counts?.books ?? 0}</b> books
                      </span>
                      <span className="chip">
                        <b>{c.counts?.chunks ?? 0}</b> chunks
                      </span>
                      <span className="chip">
                        <code>{c.chunkStrategy}</code>
                      </span>
                      <span className="chip">{fmtDate(c.createdAt)}</span>
                      {c.counts?.rejected > 0 && (
                        <span className="chip warn">{c.counts.rejected} rejected</span>
                      )}
                      {c.counts?.duplicates > 0 && (
                        <span className="chip warn">{c.counts.duplicates} duplicate</span>
                      )}
                    </div>
                  </div>

                  <div className="version-actions">
                    <button className="tiny" onClick={() => openInspector(c.id)}>
                      Inspect chunks
                    </button>
                    {!c.active && c.status === 'ready' && (
                      <button
                        className="tiny go"
                        onClick={() =>
                          act(
                            () => api(`collections/${c.id}/activate`, { method: 'POST' }),
                            `“${c.name}” is now live. The catalog it replaced was removed.`
                          )
                        }
                      >
                        Publish
                      </button>
                    )}
                    {!c.active && (
                      <button
                        className="tiny danger"
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
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* ----------------------------------------------------------- stock */}
        <section className="card">
          <div className="card-head">
            <div className="section-title">
              <span className="step">4</span>
              <h2>Current stock</h2>
            </div>
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
            <p className="empty">Nothing on the shelf yet — upload a catalog above and publish it.</p>
          ) : (
            <>
              <p className="hint section-hint">
                What readers are being recommended from right now. This view is read-only: your
                uploaded file is the source of truth, so the way to change a book is to download the
                catalog, edit it, and upload it back.
              </p>

              <div className="search-wrap">
                <span className="icon" aria-hidden="true">
                  🔍
                </span>
                <input
                  className="input"
                  value={query}
                  placeholder="Search title, author, genre, theme or level…"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0);
                  }}
                />
              </div>

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
                        <td className="title-cell">{b.title}</td>
                        <td>{b.author}</td>
                        <td className="dim">{b.year ?? '—'}</td>
                        <td>
                          <code>{b.readingLevel}</code>
                        </td>
                        <td className="dim">{b.pages ?? '—'}</td>
                        <td className="dim">{(b.genres ?? []).join(', ') || '—'}</td>
                      </tr>
                    ))}
                    {stock.books.length === 0 && (
                      <tr>
                        <td colSpan={6} className="dim">
                          No book matches “{query}”.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="pager">
                <button
                  className="tiny"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  ← Previous
                </button>
                <span className="count">
                  {stock.matched === 0
                    ? '0 books'
                    : `${stock.offset + 1}–${Math.min(stock.offset + stock.limit, stock.matched)} of ${stock.matched}`}
                  {query && stock.matched !== stock.total ? ` (of ${stock.total} in stock)` : ''}
                </span>
                <button
                  className="tiny"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={stock.offset + stock.limit >= stock.matched}
                >
                  Next →
                </button>
              </div>
            </>
          )}
        </section>
      </main>

      {inspect && (
        <div className="drawer-backdrop" onClick={() => setInspect(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h2>Chunks</h2>
              <button className="ghost" onClick={() => setInspect(null)}>
                Close
              </button>
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
                    <li key={d.row}>
                      Row {d.row}: {d.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {inspect.rejected?.length > 0 && (
              <details className="rejected" open>
                <summary>{inspect.rejected.length} rejected row(s)</summary>
                <ul>
                  {inspect.rejected.slice(0, 30).map((r) => (
                    <li key={r.row}>
                      Row {r.row}: {r.reason}
                    </li>
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
    </>
  );
}
