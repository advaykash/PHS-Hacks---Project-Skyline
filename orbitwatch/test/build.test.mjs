// Checks that the project is complete and consistent: the built page matches src/, the bundled libraries are the
// expected versions, and the page, server and tools agree on the data source. Run: npm test (Node 20+).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPage } from '../tools/build-page.mjs';
import { GROUPS } from '../server/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('public/index.html');
// three.js r128 (npm three@0.128.0) and satellite.js 6.0.2, byte-identical to the npm packages
const VENDOR = {
  'public/vendor/three.min.js': '9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2',
  'public/vendor/satellite.min.js': '14488fc910920924e6616f07f950ba307586e08fbb837407d8fe04c939b2059f',
};

test('public/index.html is up to date with src/ (run "npm run build:page" after editing src/)', () => {
  assert.ok(buildPage().html === PAGE, 'public/index.html differs from a fresh build of src/');
});

test('the page loads its libraries from this site, and they are the expected versions', () => {
  const scripts = [...PAGE.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['vendor/three.min.js', 'vendor/satellite.min.js']);
  for (const [f, sha] of Object.entries(VENDOR))
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'), sha, f);
  for (const f of ['public/vendor/three.LICENSE.txt', 'public/vendor/satellite.js.LICENSE.txt']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('the page asks this site for data, never CelesTrak directly', () => {
  assert.match(PAGE, /const API_BASE = 'api\/gp';/);
  assert.match(PAGE, /const BROWSER_FETCH = false;/);
  assert.ok(PAGE.includes('data:image/'), 'the Earth texture is embedded in the page');
});

test('page, server and fetch tool use the same six CelesTrak groups', () => {
  const six = ['stations', 'active', 'visual', 'fengyun-1c-debris', 'iridium-33-debris', 'cosmos-2251-debris'];
  assert.deepEqual(GROUPS, six);
  const app = read('src/app.js'), block = app.slice(app.indexOf('const GROUPS = ['), app.indexOf('];', app.indexOf('const GROUPS = [')));
  assert.deepEqual([...block.matchAll(/key: '([^']+)'/g)].map(m => m[1]), six);
  assert.match(read('tools/fetch-celestrak.mjs'), new RegExp(`const GROUPS = \\[${six.map(g => `'${g}'`).join(', ')}\\];`));
  for (const f of ['src/app.js', 'server/server.mjs', 'tools/fetch-celestrak.mjs']) assert.ok(!read(f).includes('cosmos-1408'), f);
});

test('the real public/ folder is served: page, libraries and API from one origin', async t => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ow-build-')), CELESTRAK_URL: 'http://127.0.0.1:9/gp.php', TIMEOUT_MS: '300' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  for (let i = 0; i < 200 && !/listening on/.test(out); i++) await new Promise(r => setTimeout(r, 30));
  const port = (out.match(/listening on [^:]+:(\d+)/) || [])[1]; assert.ok(port, out);
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal((await page.text()).replace(/\r\n/g, '\n'), PAGE);
  for (const f of ['/vendor/three.min.js', '/vendor/satellite.min.js']) {
    const r = await fetch(base + f); assert.equal(r.status, 200, f); assert.match(r.headers.get('content-type'), /javascript/, f); await r.arrayBuffer();
  }
  const health = await (await fetch(base + '/api/health')).json();
  assert.deepEqual(Object.keys(health.groups), GROUPS);
  const gp = await fetch(base + '/api/gp?group=stations');   // CelesTrak unreachable in this test: a clear 503, not a crash
  assert.equal(gp.status, 503); assert.match((await gp.json()).error, /Could not connect|did not answer/);
});
