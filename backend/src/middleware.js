/**
 * Cross-cutting request concerns: admin auth, request ids, structured logging
 * and a small in-memory metrics buffer.
 */

import crypto from 'node:crypto';

// ------------------------------------------------------------------- auth

/**
 * Timing-safe compare. Overkill for a demo token, but a plain `===` on a secret
 * is the kind of thing that gets copied into something that matters later.
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: 'Admin API is disabled. Set ADMIN_TOKEN in backend/.env to enable it.',
    });
  }
  const supplied = req.get('x-admin-token') ?? '';
  if (!supplied || !safeEqual(supplied, expected)) {
    return res.status(401).json({ error: 'Invalid or missing admin token' });
  }
  next();
}

// ---------------------------------------------------------------- metrics

const RING_SIZE = 500;
const ring = [];
let totalRequests = 0;

/** Counters for Gemini usage, incremented from the API wrapper. */
export const usage = { embedCalls: 0, chatCalls: 0, promptTokens: 0, outputTokens: 0 };

export function recordUsage(kind, tokens = {}) {
  if (kind === 'embed') usage.embedCalls++;
  if (kind === 'chat') usage.chatCalls++;
  usage.promptTokens += tokens.prompt ?? 0;
  usage.outputTokens += tokens.output ?? 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export function stats() {
  const durations = ring.map((r) => r.ms).sort((a, b) => a - b);
  const byPath = {};
  for (const r of ring) {
    const key = `${r.method} ${r.path}`;
    byPath[key] ??= { count: 0, errors: 0, totalMs: 0 };
    byPath[key].count++;
    byPath[key].totalMs += r.ms;
    if (r.status >= 400) byPath[key].errors++;
  }
  return {
    totalRequests,
    sampled: ring.length,
    latencyMs: {
      p50: Math.round(percentile(durations, 50)),
      p95: Math.round(percentile(durations, 95)),
      max: durations.length ? Math.round(durations[durations.length - 1]) : 0,
    },
    errors: ring.filter((r) => r.status >= 400).length,
    gemini: { ...usage },
    byPath: Object.entries(byPath)
      .map(([route, v]) => ({
        route,
        count: v.count,
        errors: v.errors,
        avgMs: Math.round(v.totalMs / v.count),
      }))
      .sort((a, b) => b.count - a.count),
    recent: ring.slice(-20).reverse(),
  };
}

// --------------------------------------------------------------- observability

/**
 * Tag every request with an id, time it, and emit one structured line. Being
 * able to grep a single reqId across the log is what makes a failed ingest
 * traceable through four pipeline stages.
 */
export function observe(req, res, next) {
  const reqId = req.get('x-request-id') || crypto.randomUUID().slice(0, 8);
  req.reqId = reqId;
  res.setHeader('x-request-id', reqId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const entry = {
      reqId,
      method: req.method,
      // req.route.path is router-relative, so prepend baseUrl or every admin
      // route logs as "/jobs/:id" with no hint of which router it came from.
      path: req.route ? `${req.baseUrl}${req.route.path}` : req.path,
      status: res.statusCode,
      ms: Number(ms.toFixed(1)),
      at: new Date().toISOString(),
    };

    totalRequests++;
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();

    // Health polling every second would otherwise drown the log.
    if (req.path !== '/api/health') console.log(JSON.stringify({ type: 'request', ...entry }));
  });

  next();
}
