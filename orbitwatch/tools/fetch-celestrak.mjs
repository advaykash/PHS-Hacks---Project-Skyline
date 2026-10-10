#!/usr/bin/env node
// Downloads OrbitWatch's CelesTrak groups once and writes them to one same-origin file (default data/celestrak.json).
// The app reads that file first, so visitors' browsers don't each have to contact CelesTrak.
// No dependencies; needs Node 20 or newer.
//
//   node tools/fetch-celestrak.mjs                     download, unless the existing file is under 2 hours old
//   node tools/fetch-celestrak.mjs --force             download even if the file is recent
//   node tools/fetch-celestrak.mjs --from-dir saved/   build the file from CelesTrak JSON files saved by hand (active.json, …)
//   options: --out <file>  --strict (exit 1 if nothing could be downloaded)  --base <url> (testing only)
//
// CelesTrak updates GP data about every 2 hours and blocks clients that download the same data too often,
// so this script never downloads more than once per 2 hours and stops at the first refusal (HTTP 403/429).
import fs from 'node:fs';
import path from 'node:path';

const GROUPS = ['stations', 'active', 'visual', 'fengyun-1c-debris', 'iridium-33-debris', 'cosmos-2251-debris'];
const FIELDS = ['NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
const MIN_INTERVAL = 2 * 3600e3;

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = opt('--out') || 'data/celestrak.json';
const BASE = opt('--base') || 'https://celestrak.org/NORAD/elements/gp.php';
const FROM = opt('--from-dir');
const FORCE = argv.includes('--force'), STRICT = argv.includes('--strict');
const log = (...a) => console.log('[fetch-celestrak]', ...a);

const isNum = v => v !== null && v !== '' && v !== undefined && Number.isFinite(+v);
const epochMs = s => typeof s === 'string' ? Date.parse(s.endsWith('Z') ? s : s + 'Z') : NaN;
function valid(m) {
  return m && isNum(m.NORAD_CAT_ID) && Number.isFinite(epochMs(m.EPOCH)) && isNum(m.MEAN_MOTION) && +m.MEAN_MOTION > 0
    && isNum(m.ECCENTRICITY) && +m.ECCENTRICITY >= 0 && +m.ECCENTRICITY < 1
    && ['INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'].every(f => isNum(m[f]));
}
function compact(list) {
  const rows = [], bad = [];
  for (const m of list) (valid(m) ? rows.push(FIELDS.map(f => m[f] ?? null)) : bad.push(m && m.NORAD_CAT_ID));
  return { rows, skipped: bad.length };
}
function readExisting() {
  try { const d = JSON.parse(fs.readFileSync(OUT, 'utf8')); return d && Number.isFinite(d.fetchedAt) && d.groups ? d : null; } catch { return null; }
}
function write(ds) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ds));
  fs.renameSync(tmp, OUT);
  const n = Object.values(ds.groups).reduce((a, g) => a + g.rows.length, 0);
  const epochs = Object.values(ds.groups).flatMap(g => g.rows.map(r => epochMs(r[3]))).sort((a, b) => a - b);
  log(`wrote ${OUT}: ${n} records in ${Object.keys(ds.groups).length} groups, ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
  if (epochs.length) log(`element epochs: oldest ${new Date(epochs[0]).toISOString()}, newest ${new Date(epochs[epochs.length - 1]).toISOString()}`);
  for (const [k, why] of Object.entries(ds.failed)) log(`  not included: ${k}: ${why}`);
}

async function download() {
  const prev = readExisting();
  if (prev && !FORCE && Date.now() - prev.fetchedAt < MIN_INTERVAL) {
    log(`${OUT} was downloaded ${((Date.now() - prev.fetchedAt) / 60e3).toFixed(0)} min ago; CelesTrak updates about every 2 hours, so skipping. Use --force to override.`);
    return 0;
  }
  const ds = { format: 'orbitwatch-gp/1', source: 'CelesTrak GP API', fetchedAt: Date.now(), fetchedBy: 'server', fields: FIELDS, groups: {}, failed: {} };
  for (let k = 0; k < GROUPS.length; k++) {
    const g = GROUPS[k], url = `${BASE}?GROUP=${encodeURIComponent(g)}&FORMAT=json`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'OrbitWatch data refresher (student project; one download per group per 2 h)' }, signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      if (res.status === 403 || res.status === 429) {
        ds.failed[g] = `CelesTrak refused the request (HTTP ${res.status}): ${text.slice(0, 120).trim()}`;
        for (const g2 of GROUPS.slice(k + 1)) ds.failed[g2] = 'Skipped after CelesTrak refused a request.';
        log(`refused on ${g} (HTTP ${res.status}); stopping without further requests.`);
        break;
      }
      if (!res.ok) {   // CelesTrak asks clients to stop at the first error
        ds.failed[g] = `HTTP ${res.status}`;
        for (const g2 of GROUPS.slice(k + 1)) ds.failed[g2] = 'Skipped after the previous request failed.';
        log(`${g}: HTTP ${res.status}; stopping without further requests.`);
        break;
      }
      let list; try { list = JSON.parse(text); } catch { ds.failed[g] = `Not JSON: ${text.slice(0, 80).trim()}`; log(`${g}: not JSON (${text.slice(0, 80).trim()})`); continue; }
      if (!Array.isArray(list) || !list.length) { ds.failed[g] = 'No objects returned.'; log(`${g}: no objects`); continue; }
      const { rows, skipped } = compact(list);
      ds.groups[g] = { rows };
      log(`${g}: ${rows.length} objects${skipped ? `, ${skipped} invalid records skipped` : ''}`);
    } catch (e) {
      ds.failed[g] = `Could not connect: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`;
      log(`${g}: ${ds.failed[g]}`);
      if (k === 0) { for (const g2 of GROUPS.slice(1)) ds.failed[g2] = 'Skipped: CelesTrak was unreachable.'; break; }
    }
  }
  if (!Object.keys(ds.groups).length) {
    log(prev ? `nothing downloaded; keeping the existing ${OUT} from ${new Date(prev.fetchedAt).toISOString()}.` : 'nothing downloaded and no existing file; the app will fall back to its built-in snapshot or demo data.');
    return STRICT ? 1 : 0;
  }
  write(ds);
  return 0;
}

function fromDir(dir) {
  const ds = { format: 'orbitwatch-gp/1', source: 'CelesTrak GP API (files saved by hand)', fetchedAt: 0, fetchedBy: 'files', fields: FIELDS, groups: {}, failed: {} };
  let newest = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json'))) {
    const g = [...GROUPS].sort((a, b) => b.length - a.length).find(k => f.toLowerCase().includes(k));
    if (!g) { log(`${f}: name does not contain a group name (${GROUPS.join(', ')}); skipped`); continue; }
    let list; try { list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { log(`${f}: not valid JSON (${e.message}); skipped`); continue; }
    if (!Array.isArray(list) || !list.length || !('MEAN_MOTION' in list[0])) { log(`${f}: not CelesTrak GP JSON; skipped`); continue; }
    const { rows, skipped } = compact(list);
    ds.groups[g] = { rows };
    for (const r of rows) newest = Math.max(newest, epochMs(r[3]));
    log(`${f}: ${rows.length} objects -> ${g}${skipped ? `, ${skipped} invalid skipped` : ''}`);
  }
  if (!Object.keys(ds.groups).length) { log('no usable files'); return 1; }
  // The download time of hand-saved files is unknown; use the newest element epoch and say so.
  ds.fetchedAt = newest; ds.fetchedAtKind = 'newest-epoch';
  for (const g of GROUPS) if (!ds.groups[g]) ds.failed[g] = 'Not included in the saved files.';
  write(ds);
  return 0;
}

process.exitCode = FROM ? fromDir(FROM) : await download();
