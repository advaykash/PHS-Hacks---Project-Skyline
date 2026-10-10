// Tests for server/server.mjs against a local stand-in for CelesTrak. Run: npm test (Node 20+).
// The stand-in serves made-up TEST records; nothing here is real orbital data.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'server.mjs');

// ── stand-in for celestrak.org/NORAD/elements/gp.php
const rec = (name, id) => ({ OBJECT_NAME: name, OBJECT_ID: '1998-067A', EPOCH: new Date(Date.now() - 3600e3).toISOString().replace('Z', ''), MEAN_MOTION: 15.5, ECCENTRICITY: 0.0005,
  INCLINATION: 51.64, RA_OF_ASC_NODE: 120, ARG_OF_PERICENTER: 80, MEAN_ANOMALY: 10, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: id, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, BSTAR: 0.0002, MEAN_MOTION_DOT: 0.0001, MEAN_MOTION_DDOT: 0 });
const upstream = { mode: 'ok', hits: [], delay: 0 };
const up = http.createServer(async (req, res) => {
  const g = new URL(req.url, 'http://x').searchParams.get('GROUP'); upstream.hits.push(g);
  if (upstream.delay) await new Promise(r => setTimeout(r, upstream.delay));
  const m = upstream.mode;
  if (m === 'hang') return;   // never answers
  if (m === '403') { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end(`GP data has not updated since your last successful download of GROUP=${g}`); }
  if (m === '500') { res.writeHead(500); return res.end('oops'); }
  if (m === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>maintenance</html>'); }
  if (m === 'empty') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
  if (m === 'invalid') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify([{ OBJECT_NAME: 'BAD', NORAD_CAT_ID: 1, EPOCH: 'nope' }])); }
  const list = [rec('TEST STATION A', 25544), rec('TEST STATION B', 48274), { OBJECT_NAME: 'BROKEN', NORAD_CAT_ID: 9 }];
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(list));
});
await new Promise(r => up.listen(0, '127.0.0.1', r));
up.unref();   // never keep Node running for this stand-in (some Node 20 releases run the after() hook late)
const UPSTREAM = `http://127.0.0.1:${up.address().port}/gp.php`;
after(() => { up.closeAllConnections(); up.close(); });   // hanging test requests would otherwise keep Node running

// ── start the real server in a child process with test settings
async function start(env = {}, cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-cache-'))) {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-pub-'));
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>t</title>');
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', PUBLIC_DIR: pub, CACHE_DIR: cacheDir, CELESTRAK_URL: UPSTREAM, TIMEOUT_MS: '400', WAIT_MS: '200', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  for (let i = 0; i < 200 && !/listening on/.test(out); i++) await new Promise(r => setTimeout(r, 30));   // PORT=0: the system picks a free port
  const m = out.match(/listening on [^:]+:(\d+)/); if (!m) throw new Error('server did not start:\n' + out);
  const base = `http://127.0.0.1:${m[1]}`;
  const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { } return { r, text, json }; };
  return { get, base, cacheDir, stop: () => child.kill(), log: () => out };
}
const reset = (mode = 'ok') => { upstream.mode = mode; upstream.hits = []; upstream.delay = 0; };

test('downloads a group once, validates it and serves it from cache', async t => {
  reset(); const s = await start(); t.after(s.stop);
  const a = await s.get('/api/gp?group=stations');
  assert.equal(a.r.status, 200);
  assert.equal(a.json.group, 'stations');
  assert.equal(a.json.count, 2); assert.equal(a.json.skipped, 1);   // the BROKEN record is dropped
  assert.equal(a.json.fields[0], 'NORAD_CAT_ID'); assert.equal(a.json.rows[0][0], 25544);
  assert.equal(a.json.stale, false); assert.equal(a.json.lastError, null);
  assert.ok(Math.abs(a.json.fetchedAt - Date.now()) < 5000);
  const b = await s.get('/api/gp?group=stations');
  assert.equal(b.r.status, 200); assert.equal(b.json.fetchedAt, a.json.fetchedAt);
  assert.deepEqual(upstream.hits, ['stations'], 'second request must not reach CelesTrak');
  const c = await s.get('/api/gp?group=stations', { 'If-None-Match': a.r.headers.get('etag') });
  assert.equal(c.r.status, 304);
});

test('gzip-compresses responses for clients that accept it', async t => {
  reset(); const s = await start(); t.after(s.stop);
  const r = await new Promise((res, rej) => http.get(s.base + '/api/gp?group=stations', { headers: { 'Accept-Encoding': 'gzip' } }, res).on('error', rej));
  const chunks = []; for await (const c of r) chunks.push(c);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(Buffer.concat(chunks))).count, 2);
});

test('rejects unknown groups without contacting CelesTrak', async t => {
  reset(); const s = await start(); t.after(s.stop);
  for (const q of ['?group=cosmos-1408-debris', '?group=../../etc', '']) {
    const r = await s.get('/api/gp' + q);
    assert.equal(r.r.status, 400); assert.match(r.json.error, /Unknown group/);
  }
  assert.equal(upstream.hits.length, 0);
});

test('a refusal (403) with no cached copy gives 503 and is not retried during the back-off', async t => {
  reset('403'); const s = await start(); t.after(s.stop);
  const a = await s.get('/api/gp?group=active');
  assert.equal(a.r.status, 503); assert.match(a.json.error, /refused the request \(HTTP 403\)/);
  assert.ok(+a.r.headers.get('retry-after') > 3000, 'back-off should be about 2 hours');
  await s.get('/api/gp?group=active'); await s.get('/api/gp?group=active');
  assert.deepEqual(upstream.hits, ['active']);
});

test('an HTTP error on one group pauses every group, but "not updated" refusals affect only their group', async t => {
  reset('500'); const s = await start(); t.after(s.stop);
  const a = await s.get('/api/gp?group=stations');
  assert.equal(a.r.status, 503); assert.match(a.json.error, /HTTP 500/);
  const b = await s.get('/api/gp?group=active');
  assert.equal(b.r.status, 503); assert.match(b.json.error, /Not asking CelesTrak until .* after an error on stations: CelesTrak answered HTTP 500/);
  assert.deepEqual(upstream.hits, ['stations'], 'other groups must not contact CelesTrak during the pause');
  reset('403'); const s2 = await start(); t.after(s2.stop);   // the stand-in's 403 says "GP data has not updated since…"
  await s2.get('/api/gp?group=stations'); await s2.get('/api/gp?group=active');
  assert.deepEqual(upstream.hits, ['stations', 'active']);
});

test('timeouts, HTML, empty and invalid replies are errors that never replace the last good copy', async t => {
  reset(); const s = await start({ REFRESH_MS: '0', RETRY_MS: '0', STALE_MS: '0' }); t.after(s.stop);
  const good = await s.get('/api/gp?group=stations');
  assert.equal(good.json.count, 2);
  for (const [mode, re] of [['hang', /did not answer within 0.4 s/], ['html', /not JSON/], ['empty', /no objects/], ['invalid', /None of the 1 records/], ['500', /HTTP 500/], ['403', /HTTP 403/]]) {
    reset(mode);
    const r = await s.get('/api/gp?group=stations');
    // the request waits briefly for the refresh, then gets the cached copy
    assert.equal(r.r.status, 200, mode);
    assert.equal(r.json.fetchedAt, good.json.fetchedAt, `${mode}: the cached copy must be kept`);
    assert.equal(r.json.count, 2);
    assert.equal(r.json.stale, true);
    if (mode !== 'hang') assert.match(r.json.lastError, re, mode);
    await new Promise(res => setTimeout(res, mode === 'hang' ? 500 : 20));
  }
  reset('hang');
  const h = await s.get('/api/health');
  assert.equal(h.json.ok, true);
  assert.match(h.json.groups.stations.lastError, /did not answer|HTTP 403/);
});

test('with no cached copy, a hanging CelesTrak gives 503 after the timeout', async t => {
  reset('hang'); const s = await start(); t.after(s.stop);
  const t0 = Date.now(); const r = await s.get('/api/gp?group=visual');
  assert.equal(r.r.status, 503); assert.match(r.json.error, /did not answer within/);
  assert.ok(Date.now() - t0 < 3000);
});

test('the disk cache survives a restart, so a restart does not re-download', async t => {
  reset(); const s1 = await start();
  await s1.get('/api/gp?group=stations'); s1.stop();
  reset('403'); const s2 = await start({}, s1.cacheDir); t.after(s2.stop);
  const r = await s2.get('/api/gp?group=stations');
  assert.equal(r.r.status, 200); assert.equal(r.json.count, 2);
  assert.equal(upstream.hits.length, 0);
});

test('serves the app with a CSP that only allows same-origin connections, and nothing outside public/', async t => {
  reset(); const s = await start(); t.after(s.stop);
  const a = await s.get('/');
  assert.equal(a.r.status, 200); assert.match(a.r.headers.get('content-type'), /text\/html/);
  assert.match(a.r.headers.get('content-security-policy'), /connect-src 'self'/);
  for (const p of ['/../server/server.mjs', '/%2e%2e/server/server.mjs', '/.cache/stations.data.json', '/.git/HEAD', '/nope.html', '/%E0%A4%A']) {
    const r = await s.get(p); assert.ok(r.r.status === 404 || r.r.status === 400, `${p} -> ${r.r.status}`);
  }
  const post = await fetch(s.base + '/api/gp?group=stations', { method: 'POST' });
  assert.equal(post.status, 405);
});
