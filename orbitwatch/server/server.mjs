#!/usr/bin/env node
// OrbitWatch web server. Serves the app from public/ and a same-origin, cached copy of CelesTrak's GP data:
//   GET /api/gp?group=stations   orbital elements (OMM fields as compact rows) for one CelesTrak group
//   GET /api/health              cache status of every group
// The browser never contacts CelesTrak; this server downloads each group at most once per CelesTrak update
// (every 2 hours), keeps the last good copy in memory and on disk, and keeps serving it if CelesTrak fails.
// No dependencies; Node 20 or newer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const PORT = Number(env('PORT', 8080));
const HOST = env('HOST', '0.0.0.0');   // all IPv4 interfaces, as container platforms such as DigitalOcean App Platform expect
const PUBLIC_DIR = path.resolve(env('PUBLIC_DIR', path.join(ROOT, 'public')));
const CACHE_DIR = path.resolve(env('CACHE_DIR', path.join(ROOT, '.cache')));
const UPSTREAM = env('CELESTRAK_URL', 'https://celestrak.org/NORAD/elements/gp.php');
const REFRESH_MS = Number(env('REFRESH_MS', 2 * 3600e3));     // CelesTrak updates GP data every 2 h and allows one download per update
const STALE_MS = Number(env('STALE_MS', 3 * 3600e3));         // older than this, responses say stale: true
const RETRY_MS = Number(env('RETRY_MS', 30 * 60e3));          // wait after a failed download before asking CelesTrak again
const TIMEOUT_MS = Number(env('TIMEOUT_MS', 20e3));           // per CelesTrak request
const WAIT_MS = Number(env('WAIT_MS', 8e3));                  // a request waits this long for a refresh, then gets the cached copy

export const GROUPS = ['stations', 'active', 'visual', 'fengyun-1c-debris', 'iridium-33-debris', 'cosmos-2251-debris'];
export const FIELDS = ['NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ───────────────────────── validation (same rules as the app's validOMM)
const isNum = v => v !== null && v !== '' && v !== undefined && Number.isFinite(+v);
const epochMs = s => (typeof s === 'string' ? Date.parse(s.endsWith('Z') ? s : s + 'Z') : NaN);
export function validOMM(m) {
  return !!m && typeof m === 'object' && isNum(m.NORAD_CAT_ID) && Number.isFinite(epochMs(m.EPOCH)) && isNum(m.MEAN_MOTION) && +m.MEAN_MOTION > 0
    && isNum(m.ECCENTRICITY) && +m.ECCENTRICITY >= 0 && +m.ECCENTRICITY < 1
    && ['INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'].every(f => isNum(m[f]));
}

// ───────────────────────── per-group cache
// `all`: CelesTrak asks clients to stop at the first error, so HTTP errors and connection failures pause every group.
class UpstreamError extends Error { constructor(msg, backoff, all) { super(msg); this.backoff = backoff; this.all = all; } }
const state = new Map();
let pausedUntil = 0, pauseReason = null;   // all groups wait after a connection failure or an HTTP error from CelesTrak
const file = (g, kind) => path.join(CACHE_DIR, `${g}.${kind}.json`);
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeAtomic(p, text) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(p + '.tmp', text); fs.renameSync(p + '.tmp', p); }
  catch (e) { log(`cache write failed for ${path.basename(p)}: ${e.message}`); }
}
function st(g) {
  if (!state.has(g)) {
    const d = readJson(file(g, 'data')), meta = readJson(file(g, 'status')) || {};
    const data = d && d.group === g && Number.isFinite(d.fetchedAt) && Array.isArray(d.rows) && d.rows.length ? d : null;
    state.set(g, { data, lastAttemptAt: meta.lastAttemptAt || 0, lastError: meta.lastError || null,
      nextAttemptAt: Math.max(meta.nextAttemptAt || 0, data ? data.fetchedAt + REFRESH_MS : 0), inflight: null, key: '', body: null, gz: null });
  }
  return state.get(g);
}
function refresh(g) {
  const s = st(g);
  if (s.inflight) return s.inflight;   // one download at a time per group
  s.inflight = (async () => {
    s.lastAttemptAt = Date.now();
    try {
      let res;
      try {
        res = await fetch(`${UPSTREAM}?GROUP=${encodeURIComponent(g)}&FORMAT=json`, {
          headers: { Accept: 'application/json', 'User-Agent': 'OrbitWatch (student project; caches each group for 2 h)' },
          signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual',
        });
      } catch (e) {
        throw new UpstreamError(e.name === 'TimeoutError' ? `CelesTrak did not answer within ${TIMEOUT_MS / 1000} s.` : `Could not connect to CelesTrak (${(e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code) || e.cause.message)) || e.message}).`, RETRY_MS, true);
      }
      const text = await res.text();
      const snip = text.replace(/\s+/g, ' ').trim().slice(0, 160);
      // "GP data has not updated since your last successful download" concerns only this group; other refusals concern this server
      if (res.status === 403 || res.status === 429) throw new UpstreamError(`CelesTrak refused the request (HTTP ${res.status}): ${snip}`, REFRESH_MS, !/not updated/i.test(text));
      if (res.status !== 200) throw new UpstreamError(`CelesTrak answered HTTP ${res.status}${snip ? ': ' + snip : ''}`, RETRY_MS, true);
      let list; try { list = JSON.parse(text); } catch { throw new UpstreamError(`CelesTrak sent a reply that is not JSON: "${snip}"`, RETRY_MS); }
      if (!Array.isArray(list)) throw new UpstreamError('CelesTrak sent JSON that is not a list of objects.', RETRY_MS);
      const rows = []; let skipped = 0;
      for (const m of list) validOMM(m) ? rows.push(FIELDS.map(f => m[f] ?? null)) : skipped++;
      if (!rows.length) throw new UpstreamError(list.length ? `None of the ${list.length} records CelesTrak sent were valid.` : `CelesTrak returned no objects for GROUP=${g}.`, RETRY_MS);
      s.data = { group: g, fetchedAt: Date.now(), count: rows.length, skipped, rows };
      s.lastError = null; s.nextAttemptAt = s.data.fetchedAt + REFRESH_MS;
      writeAtomic(file(g, 'data'), JSON.stringify(s.data));
      log(`${g}: downloaded ${rows.length} objects${skipped ? `, skipped ${skipped} invalid` : ''}`);
    } catch (e) {
      s.lastError = e instanceof UpstreamError ? e.message : `Unexpected error: ${e.message}`;
      s.nextAttemptAt = Date.now() + (e.backoff || RETRY_MS);
      if (e.all) { pausedUntil = Math.max(pausedUntil, s.nextAttemptAt); pauseReason = `Not asking CelesTrak until ${new Date(pausedUntil).toISOString()} after an error on ${g}: ${s.lastError}`; }
      log(`${g}: ${s.lastError} Keeping ${s.data ? `the copy from ${new Date(s.data.fetchedAt).toISOString()}` : 'no data'}; next try after ${new Date(s.nextAttemptAt).toISOString()}.`);
    } finally {
      s.inflight = null;
      writeAtomic(file(g, 'status'), JSON.stringify({ lastAttemptAt: s.lastAttemptAt, lastError: s.lastError, nextAttemptAt: s.nextAttemptAt }));
    }
  })();
  return s.inflight;
}
const due = s => { const now = Date.now(); return now >= Math.max(s.nextAttemptAt, pausedUntil) && (!s.data || now - s.data.fetchedAt >= REFRESH_MS); };
const sleep = ms => new Promise(r => setTimeout(r, ms).unref());

// ───────────────────────── HTTP
const compressible = (buf, type) => buf.length > 1024 && /json|html|javascript|css|text|svg/.test(type);
function send(req, res, status, body, type, extra = {}, gzBody = null) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && (gzBody || compressible(buf, type));
  const out = gz ? gzBody || zlib.gzipSync(buf) : buf;
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': out.length, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}), ...extra });
  res.end(req.method === 'HEAD' ? undefined : out);
}
const sendJson = (req, res, status, obj, extra = {}) => send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });

async function handleGp(req, res, url) {
  const g = url.searchParams.get('group');
  if (!GROUPS.includes(g)) return sendJson(req, res, 400, { error: `Unknown group. Use one of: ${GROUPS.join(', ')}.` });
  const s = st(g);
  if (due(s)) { const p = refresh(g); await (s.data ? Promise.race([p, sleep(WAIT_MS)]) : p); }
  if (!s.data) {
    const wait = Math.max(1, Math.ceil((Math.max(s.nextAttemptAt, pausedUntil) - Date.now()) / 1000));
    return sendJson(req, res, 503, { group: g, error: s.lastError || (Date.now() < pausedUntil && pauseReason) || 'No data has been downloaded yet.', lastAttemptAt: s.lastAttemptAt || null, retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
  }
  const stale = Date.now() - s.data.fetchedAt > STALE_MS;
  const meta = { group: g, fetchedAt: s.data.fetchedAt, count: s.data.count, skipped: s.data.skipped || 0, stale, lastError: s.lastError, lastAttemptAt: s.lastAttemptAt || null, refreshMinutes: REFRESH_MS / 60e3 };
  const key = JSON.stringify(meta);
  if (s.key !== key) {   // build the (large) body once per data version, not per request
    s.key = key; s.body = Buffer.from(JSON.stringify({ ...meta, fields: FIELDS, rows: s.data.rows }));
    s.gz = zlib.gzipSync(s.body); s.etag = `"${g}-${s.data.fetchedAt}-${stale ? 1 : 0}-${s.lastAttemptAt || 0}"`;
  }
  const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: s.etag, 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === s.etag) { res.writeHead(304, head); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || ''), out = gz ? s.gz : s.body;
  res.writeHead(200, { ...head, 'Content-Length': out.length, ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(req.method === 'HEAD' ? undefined : out);
}
function handleHealth(req, res) {
  const groups = {};
  for (const g of GROUPS) {
    const s = st(g);
    groups[g] = { fetchedAt: s.data ? new Date(s.data.fetchedAt).toISOString() : null, count: s.data ? s.data.count : 0,
      lastAttemptAt: s.lastAttemptAt ? new Date(s.lastAttemptAt).toISOString() : null, lastError: s.lastError,
      nextAttemptAt: s.nextAttemptAt ? new Date(Math.max(s.nextAttemptAt, pausedUntil)).toISOString() : 'on first request' };
  }
  sendJson(req, res, 200, { ok: true, time: new Date().toISOString(), groups });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp' };
const files = new Map();   // path -> {mtimeMs, size, body, gz}
function handleStatic(req, res, url) {
  let rel; try { rel = decodeURIComponent(url.pathname); } catch { return send(req, res, 400, 'Bad request', 'text/plain; charset=utf-8'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const p = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!p.startsWith(PUBLIC_DIR + path.sep) || path.relative(PUBLIC_DIR, p).split(path.sep).some(seg => seg.startsWith('.'))) return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
  const type = TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
  let f = files.get(p);
  try {
    const info = fs.statSync(p); if (!info.isFile()) throw 0;
    if (!f || f.mtimeMs !== info.mtimeMs || f.size !== info.size) {   // read and compress each file once, not per request
      const body = fs.readFileSync(p);
      f = { mtimeMs: info.mtimeMs, size: info.size, body, gz: compressible(body, type) ? zlib.gzipSync(body) : null }; files.set(p, f);
    }
  } catch { return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8'); }
  send(req, res, 200, f.body, type, { 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600', ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}) }, f.gz);
}
export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/gp') return await handleGp(req, res, url);
      if (url.pathname === '/api/health') return handleHealth(req, res);
      if (url.pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'Unknown API path.' });
      return handleStatic(req, res, url);
    } catch (e) {
      log('request failed:', e);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'Internal error.' }); else res.destroy();
    }
  });
}
// Start only when run directly (node server/server.mjs), not when imported. Case-insensitive on Windows, where drive letters vary.
const isMain = () => { try { const n = p => { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; }; return n(process.argv[1]) === n(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) {
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) log(`warning: ${path.join(PUBLIC_DIR, 'index.html')} is missing, so the site will answer 404. Run: npm run build:page`);
  const server = createServer();
  server.on('error', e => { log(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the other program or choose another port (see README).` : `Could not start: ${e.message}`); process.exit(1); });
  server.listen(PORT, HOST, () => {
    const { port } = server.address();
    log(`OrbitWatch listening on ${HOST}:${port}. Open http://localhost:${port}/ (public: ${PUBLIC_DIR}, cache: ${CACHE_DIR}, upstream: ${UPSTREAM})`);
  });
}
