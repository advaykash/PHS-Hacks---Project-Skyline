#!/usr/bin/env node
// Builds the single-page app from src/ into public/index.html. No dependencies; Node 20 or newer.
//
//   node tools/build-page.mjs                      public/index.html, loading three.js and satellite.js from public/vendor/
//   node tools/build-page.mjs out.html             same, to another file
//   node tools/build-page.mjs --artifact out.html  page body only, loading the libraries from their CDNs (for a Claude artifact)
//
// Inputs: src/template.html, src/app.js, src/earth.datauri, and src/snapshot.json if it exists. A snapshot is an
// optional offline fallback built into the page: node tools/fetch-celestrak.mjs --from-dir <saved CelesTrak JSON> --out src/snapshot.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const CDN = {
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js': 'vendor/three.min.js',
  'https://cdn.jsdelivr.net/npm/satellite.js@6.0.2/dist/satellite.min.js': 'vendor/satellite.min.js',
};

const read = f => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n');   // same output on Windows checkouts
const once = (text, find, what) => { if (text.split(find).length !== 2) throw new Error(`${what}: expected exactly one ${JSON.stringify(find)}`); return text; };

export function buildPage({ artifact = false } = {}) {
  let js = read('app.js'), page = read('template.html');
  const earth = read('earth.datauri').trim();
  const snapFile = path.join(SRC, 'snapshot.json');
  const snap = fs.existsSync(snapFile) ? JSON.stringify(JSON.parse(fs.readFileSync(snapFile, 'utf8'))) : 'null';
  once(js, "'__EARTH__'", 'src/app.js'); once(js, '__SNAPSHOT__', 'src/app.js'); once(page, '/*__APP_JS__*/', 'src/template.html');
  // split/join, not replace(): the inserted text contains "$" characters that replace() would interpret
  js = js.split("'__EARTH__'").join(JSON.stringify(earth)).split('__SNAPSHOT__').join(snap);
  page = page.split('/*__APP_JS__*/').join(js);
  if (artifact) return { html: page, snapshot: snap !== 'null' };
  for (const [url, local] of Object.entries(CDN)) page = once(page, url, 'src/template.html').split(url).join(local);
  // a full document for hosting; the artifact publisher adds its own
  page = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + once(page, '<canvas id="c"', 'src/template.html').replace('<canvas id="c"', () => '</head><body>\n<canvas id="c"') + '\n</body></html>\n';
  return { html: page, snapshot: snap !== 'null' };
}

// true when this file is the script Node was started with (case-insensitive on Windows, where drive letters vary)
const isMain = () => { try { const n = p => { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; }; return n(process.argv[1]) === n(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const args = process.argv.slice(2), artifact = args.includes('--artifact');
  const out = path.resolve(args.find(a => !a.startsWith('--')) || path.join(ROOT, 'public', 'index.html'));
  const { html, snapshot } = buildPage({ artifact });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  const shown = path.relative(process.cwd(), out);
  console.log(`wrote ${shown && !shown.startsWith('..') ? shown : out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${artifact ? 'artifact body, libraries from CDNs' : 'full page, libraries from public/vendor/'}, embedded snapshot: ${snapshot ? 'yes' : 'no'})`);
}
