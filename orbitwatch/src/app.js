'use strict';
/* OrbitWatch · hackPHS 2026
   Data: CelesTrak GP elements (OMM JSON) → satellite.js SGP4 → three.js globe.
   Fallback order when live data is unavailable: browser cache → embedded snapshot → labelled demo data. */

// ───────────────────────── constants
const $ = id => document.getElementById(id);
const RS = 6371;          // scene unit = Earth mean radius, km
const REQ = 6378.137;     // equatorial radius, km (perigee/apogee altitudes)
const MU = 398600.4418;   // km³/s²
const D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2;
const HAS_SAT = typeof satellite !== 'undefined' && typeof satellite.json2satrec === 'function';
const HAS_THREE = typeof THREE !== 'undefined';
const EARTH_IMG = '__EARTH__';
const SNAPSHOT = __SNAPSHOT__;  // null, or {fetchedAt, groups:{key:{rows:[…]}}} in the cache format below
const CT = 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_KEY = 'orbitwatch.v3.cache', INTRO_KEY = 'orbitwatch.v3.introSeen', REFUSED_KEY = 'orbitwatch.v3.refusedAt';
const CACHE_TTL = 2 * 3600e3;   // CelesTrak updates GP data about every 2 hours; don't re-download sooner
// Data sources, in the order they are tried (see README):
//  1. this browser's cache, if younger than CACHE_TTL (skipped by Refresh)
//  2. API_BASE: this site's own server (server/server.mjs), which downloads from CelesTrak and caches it
//  3. HOSTED_DATA: a static copy on the same website (tools/fetch-celestrak.mjs), for hosts that cannot run a server
//  4. CelesTrak directly from the browser, only if BROWSER_FETCH is true (off: browsers behind one school or
//     hackathon network share an IP, and CelesTrak allows one download per IP per update)
//  5. the newest of: a stale copy from 2-4, a stale browser cache, the SNAPSHOT built into the page
//  6. labelled demo data
const API_BASE = 'api/gp';                   // '' to disable
const HOSTED_DATA = 'data/celestrak.json';   // '' to disable
const HOSTED_FRESH = 3 * 3600e3;
const STALE_AFTER = 3 * 3600e3;              // elements downloaded longer ago than this are flagged as stale
const BROWSER_FETCH = false;
const GROUPS = [
  { key: 'stations', label: 'Space stations and visiting vehicles' },
  { key: 'active', label: 'Active satellites' },
  { key: 'visual', label: 'Brightest objects (adds rocket bodies and inactive satellites)' },
  { key: 'fengyun-1c-debris', label: 'Fengyun-1C debris (2007 anti-satellite test)' },
  { key: 'iridium-33-debris', label: 'Iridium 33 debris (2009 collision)' },
  { key: 'cosmos-2251-debris', label: 'Cosmos 2251 debris (2009 collision)' },
];
const TYPES = {
  active:   { label: 'Active satellites',  one: 'Active satellite',   color: '#4cc3ff', shape: 'dot',     size: 4, tip: 'Payloads on CelesTrak’s list of active satellites' },
  inactive: { label: 'Inactive satellites', one: 'Inactive satellite', color: '#b4bfd4', shape: 'ring',    size: 7, tip: 'Payloads that are not on the active list (dead or retired)' },
  rocket:   { label: 'Rocket bodies',       one: 'Rocket body',        color: '#ffd166', shape: 'square',  size: 6, tip: 'Spent upper stages left in orbit after launch' },
  debris:   { label: 'Debris',              one: 'Debris',             color: '#ff7a45', shape: 'diamond', size: 5, tip: 'Fragments from breakups, tests and collisions' },
  sim:      { label: 'Simulated fragments', one: 'Simulated fragment', color: '#ff5fd2', shape: 'cross',   size: 6, tip: 'Created by the breakup simulator. Not real.' },
};
const TYPE_KEYS = ['active', 'inactive', 'rocket', 'debris', 'sim'];
const REGIMES = {
  LEO: { label: 'LEO · low Earth orbit', tip: 'Up to 2,000 km' },
  MEO: { label: 'MEO · medium Earth orbit', tip: '2,000 to 35,786 km, e.g. GPS' },
  GEO: { label: 'GEO · geostationary belt', tip: 'About 35,786 km over the equator' },
  HEO: { label: 'HEO · highly elliptical', tip: 'Very stretched orbits (eccentricity above 0.25)' },
};
const FEATURED = [
  { key: 'iss', ids: [25544], re: /^ISS \(ZARYA\)|^ISS\b/, label: 'ISS', why: 'Crewed space station' },
  { key: 'css', ids: [48274], re: /^CSS \(TIANHE\)|TIANHE/, label: 'Tiangong', why: 'China’s crewed space station' },
  { key: 'hst', ids: [20580], re: /^HST$/, label: 'Hubble', why: 'Space telescope, launched 1990' },
  { key: 'noaa', ids: [43013], re: /^NOAA 20/, label: 'NOAA-20', why: 'Polar weather satellite' },
  { key: 'gps', ids: [], re: /^GPS B/, label: 'GPS', why: 'Navigation, about 20,200 km up' },
  { key: 'goes', ids: [], re: /^GOES 1[6-9]/, label: 'GOES', why: 'Geostationary weather satellite' },
  { key: 'fy', ids: [], re: /^FENGYUN 1C DEB/, label: 'Fengyun-1C debris', why: 'Fragment from the 2007 test' },
  { key: 'van', ids: [5], re: /^VANGUARD 1$/, label: 'Vanguard 1', why: 'Oldest object still in orbit (1958)' },
];
const SIM_CAP = 1200;

// ───────────────────────── small helpers
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => Number(n).toLocaleString('en-US');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const jdOf = ms => ms / 864e5 + 2440587.5;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = a => Math.hypot(a[0], a[1], a[2]);
const utc = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const localT = ms => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
function dur(min) { min = Math.abs(min); if (min < 1) return Math.round(min * 60) + ' s'; if (min < 90) return Math.round(min) + ' min'; if (min < 48 * 60) return (min / 60).toFixed(1) + ' h'; return (min / 1440).toFixed(1) + ' days'; }
function age(ms) { const h = ms / 3600e3; return h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? h.toFixed(1) + ' h' : (h / 24).toFixed(1) + ' days'; }
let toastT = 0;
function toast(msg, ms = 3200) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', ms); }
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};

// ───────────────────────── orbital mechanics
function gmstAt(ms) {
  if (HAS_SAT) return satellite.gstime(new Date(ms));
  const T = (jdOf(ms) - 2451545) / 36525;
  const s = 67310.54841 + (876600 * 3600 + 8640184.812866) * T + 0.093104 * T * T - 6.2e-6 * T * T * T;
  return (((s % 86400) / 240 * D2R) % TAU + TAU) % TAU;
}
// two-body propagation with universal variables (demo objects and simulated fragments)
function stumpC(z) { if (z > 1e-8) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; } if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / -z; } return 0.5; }
function stumpS(z) { if (z > 1e-8) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); } if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); } return 1 / 6; }
function kepler(r0v, v0v, dt) {
  const r0 = len3(r0v), v0 = len3(v0v), vr0 = dot3(r0v, v0v) / r0, alpha = 2 / r0 - v0 * v0 / MU, sm = Math.sqrt(MU);
  if (alpha > 0) { const T = TAU * Math.sqrt(1 / (alpha * alpha * alpha) / MU); dt = ((dt % T) + T) % T; }
  let x = sm * Math.abs(alpha) * dt;
  for (let n = 0; n < 60; n++) {
    const z = alpha * x * x, C = stumpC(z), S = stumpS(z);
    const F = r0 * vr0 / sm * x * x * C + (1 - alpha * r0) * x * x * x * S + r0 * x - sm * dt;
    const dF = r0 * vr0 / sm * x * (1 - alpha * x * x * S) + (1 - alpha * r0) * x * x * C + r0;
    const step = F / dF; x -= step; if (Math.abs(step) < 1e-9) break;
  }
  const z = alpha * x * x, C = stumpC(z), S = stumpS(z);
  const f = 1 - x * x / r0 * C, g = dt - x * x * x / sm * S;
  const r = [f * r0v[0] + g * v0v[0], f * r0v[1] + g * v0v[1], f * r0v[2] + g * v0v[2]], rn = len3(r);
  const fd = sm / (rn * r0) * (alpha * x * x * x * S - x), gd = 1 - x * x / rn * C;
  return { r, v: [fd * r0v[0] + gd * v0v[0], fd * r0v[1] + gd * v0v[1], fd * r0v[2] + gd * v0v[2]] };
}
function circState(altKm, incDeg, raanDeg, uDeg) {
  const a = RS + altKm, i = incDeg * D2R, W = raanDeg * D2R, u = uDeg * D2R, vc = Math.sqrt(MU / a);
  const cW = Math.cos(W), sW = Math.sin(W), ci = Math.cos(i), si = Math.sin(i), cu = Math.cos(u), su = Math.sin(u);
  return { r: [a * (cW * cu - sW * su * ci), a * (sW * cu + cW * su * ci), a * su * si], v: [vc * (-cW * su - sW * cu * ci), vc * (-sW * su + cW * cu * ci), vc * cu * si] };
}
// ECI state (km, km/s) of object o at time ms, or null if it cannot be computed
function eciAt(o, ms) {
  if (o.satrec) {
    let p; try { p = satellite.sgp4(o.satrec, (jdOf(ms) - o.satrec.jdsatepoch) * 1440); } catch (e) { return null; }
    if (!p || !p.position || !isFinite(p.position.x)) return null;
    const r = [p.position.x, p.position.y, p.position.z];
    if (len3(r) < RS - 10) return null;
    return { r, v: [p.velocity.x, p.velocity.y, p.velocity.z] };
  }
  return kepler(o.r0, o.v0, (ms - o.t0) / 1000);
}
const toScene = (r, out, k) => { out[k] = r[0] / RS; out[k + 1] = r[2] / RS; out[k + 2] = -r[1] / RS; };
function geodetic(r, gmst) {
  if (HAS_SAT) { const g = satellite.eciToGeodetic({ x: r[0], y: r[1], z: r[2] }, gmst); return { lat: g.latitude * R2D, lon: g.longitude * R2D, h: g.height }; }
  let lon = Math.atan2(r[1], r[0]) - gmst; lon = ((lon + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return { lat: Math.atan2(r[2], Math.hypot(r[0], r[1])) * R2D, lon: lon * R2D, h: len3(r) - RS };
}
function elevationFrom(obs, r, gmst) {  // spherical-Earth approximation, degrees
  const f = obs.lat * D2R, l = obs.lon * D2R + gmst, o = [RS * Math.cos(f) * Math.cos(l), RS * Math.cos(f) * Math.sin(l), RS * Math.sin(f)];
  const d = [r[0] - o[0], r[1] - o[1], r[2] - o[2]], dn = len3(d);
  return { el: Math.asin(dot3(d, o) / (dn * RS)) * R2D, range: dn };
}
function regimeOf(o) {
  if (o.ecc > 0.25) return 'HEO';
  const h = o.meanAlt;
  if (h < 2000) return 'LEO';
  if (Math.abs(h - 35786) < 600 && o.inc < 20) return 'GEO';
  return 'MEO';
}
// SGP4 self-test against Vallado et al. (2006) verification case, catalog 00005
let selfTest = null;
function runSelfTest() {
  if (!HAS_SAT) return (selfTest = { ok: false, msg: 'satellite.js did not load, so SGP4 could not be checked.' });
  try {
    const s = satellite.twoline2satrec('1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753', '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667');
    const ref = [[0, 7022.46529266, -1400.08296755, 0.03995155], [360, -7154.03120202, -3783.17682504, -3536.19412294]];
    let worst = 0;
    for (const [t, x, y, z] of ref) { const p = satellite.sgp4(s, t).position; worst = Math.max(worst, Math.hypot(p.x - x, p.y - y, p.z - z) * 1000); }
    selfTest = { ok: worst < 1, msg: worst < 1 ? `SGP4 matches the Vallado reference case (catalog 00005, 0 and 360 min) to within ${worst < 0.01 ? '1 cm' : worst.toFixed(2) + ' m'}.` : `SGP4 differs from the reference case by ${worst.toFixed(1)} m. Treat positions with caution.` };
  } catch (e) { selfTest = { ok: false, msg: 'SGP4 self-test failed to run: ' + e.message }; }
  return selfTest;
}

// ───────────────────────── data: fetch, cache, snapshot, demo
const OMM_FIELDS = ['NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
const toRow = m => OMM_FIELDS.map(f => m[f] ?? null);
const fromRow = r => Object.fromEntries(OMM_FIELDS.map((f, i) => [f, r[i]]));
let loadPromise = null;

// A page whose Content-Security-Policy forbids connecting to celestrak.org (a claude.ai artifact, for one) reports it here.
let cspBlock = null;
document.addEventListener('securitypolicyviolation', e => {
  if (/celestrak\.(org|com)/i.test(e.blockedURI || '')) cspBlock = e.effectiveDirective || e.violatedDirective || 'connect-src';
});
const tick = ms => new Promise(r => setTimeout(r, ms));
// A signal that aborts when `parent` aborts or after `ms`; call done() when finished.
function timed(parent, ms) {
  const c = new AbortController(), t = setTimeout(() => { c.timedOut = true; c.abort(); }, ms), on = () => c.abort();
  parent.addEventListener('abort', on);
  return { signal: c.signal, timedOut: () => !!c.timedOut, done() { clearTimeout(t); parent.removeEventListener('abort', on); } };
}

async function fetchGroup(key, signal) {
  const t = timed(signal, 15000);
  try {
    const res = await fetch(`${CT}?GROUP=${encodeURIComponent(key)}&FORMAT=json`, { signal: t.signal, cache: 'no-cache' });
    if (res.status === 403 || res.status === 429) return { ok: false, http: true, refused: true, reason: `CelesTrak refused the request (HTTP ${res.status}), usually a download limit. Try again in a couple of hours.` };
    if (!res.ok) return { ok: false, http: true, reason: `CelesTrak answered HTTP ${res.status}.` };
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { return { ok: false, http: true, reason: `CelesTrak sent a non-JSON reply: "${text.slice(0, 60).trim()}"` }; }
    if (!Array.isArray(data) || !data.length) return { ok: false, http: true, reason: 'CelesTrak returned no objects for this group.' };
    return { ok: true, rows: data.map(toRow) };
  } catch (e) {
    if (signal.aborted) return { ok: false, http: false, reason: 'You chose demo data while loading.' };
    if (t.timedOut()) return { ok: false, http: false, reason: 'Timed out after 15 s.' };
    await tick(120);   // the policy-violation event arrives just after the failed fetch
    if (cspBlock) return { ok: false, http: false, blocked: true, reason: `This page’s security policy (${cspBlock}) does not allow downloads from celestrak.org. Claude artifacts block all outside downloads; the exported app is not affected.` };
    if (navigator.onLine === false) return { ok: false, http: false, reason: 'This device is offline.' };
    return { ok: false, http: false, reason: 'The browser got no usable reply from celestrak.org. It may be offline, blocked by a network filter, or not allowed for this website (CORS).' };
  } finally { t.done(); }
}
async function fetchAll(signal, onStep) {
  const ds = { fetchedAt: 0, fetchedBy: 'browser', groups: {}, failed: {} };
  for (let k = 0; k < GROUPS.length; k++) {
    const g = GROUPS[k]; onStep(k, g);
    const r = await fetchGroup(g.key, signal);
    if (r.ok) ds.groups[g.key] = { rows: r.rows }; else ds.failed[g.key] = r.reason;
    if (signal.aborted) break;
    if (r.refused) {  // CelesTrak is refusing us: stop instead of hammering it, and don't ask again for a while
      refusedAtMem = Date.now(); store.set(REFUSED_KEY, String(refusedAtMem));
      for (const g2 of GROUPS.slice(k + 1)) ds.failed[g2.key] = 'Skipped after CelesTrak refused a request.';
      break;
    }
    if (!r.ok) {  // CelesTrak asks clients to stop at the first non-200 reply
      for (const g2 of GROUPS.slice(k + 1)) ds.failed[g2.key] = r.blocked ? 'Skipped: this page may not contact celestrak.org.' : 'Skipped after the previous request failed.';
      break;
    }
  }
  ds.fetchedAt = Date.now();   // after the downloads, so the 2-hour wait counts from the last one
  return ds;
}
// This site's own data server (server/server.mjs). Returns {none, reason} when the site has no such server.
async function fetchApi(signal, onStep) {
  const ds = { fetchedAt: 0, fetchedBy: 'server', src: 'api', groups: {}, failed: {} };
  for (let k = 0; k < GROUPS.length; k++) {
    const g = GROUPS[k]; onStep(k, g);
    let res = null, body = null; const t = timed(signal, 45000);
    try { res = await fetch(`${API_BASE}?group=${encodeURIComponent(g.key)}`, { signal: t.signal, cache: 'no-cache', headers: { Accept: 'application/json' } }); } catch (e) { }
    if (signal.aborted) { t.done(); break; }
    const isJson = res && /json/.test(res.headers.get('content-type') || '');
    if (k === 0 && (!res || !isJson || res.status === 404 || res.status === 405)) return t.done(), { none: true, reason: res && !res.ok ? `This site has no data server (HTTP ${res.status}).` : res ? 'This site has no data server.' : 'This site has no data server, or it did not answer.' };
    if (isJson) try { body = await res.json(); } catch (e) { }
    t.done();
    if (!res || !res.ok || !body) { ds.failed[g.key] = (body && body.error) || (res ? `The data server answered HTTP ${res.status}.` : 'The data server did not answer.'); continue; }
    const d = normDataset({ fetchedAt: body.fetchedAt, fields: body.fields, groups: { [g.key]: { rows: body.rows } } });
    const rows = d && d.groups[g.key] ? d.groups[g.key].rows : [];
    if (!rows.length) { ds.failed[g.key] = 'The data server returned no objects for this group.'; continue; }
    ds.groups[g.key] = { rows, fetchedAt: body.fetchedAt, stale: !!body.stale, lastError: body.lastError || null };
  }
  const got = Object.values(ds.groups);
  ds.fetchedAt = got.length ? Math.min(...got.map(g => g.fetchedAt)) : Date.now();   // the oldest group decides how fresh the set is
  ds.stale = got.some(g => g.stale);
  return ds;
}
// Accepts the cache/snapshot/hosted format {fetchedAt, groups:{key:{rows}}, fields?}. Rows are re-ordered if `fields` differs.
function normDataset(d) {
  if (!d || typeof d !== 'object' || !d.groups || typeof d.groups !== 'object' || !isFinite(d.fetchedAt)) return null;
  if (Array.isArray(d.fields) && d.fields.join() !== OMM_FIELDS.join()) {
    const idx = OMM_FIELDS.map(f => d.fields.indexOf(f));
    if (idx[0] < 0 || idx[3] < 0 || idx[4] < 0) return null;
    for (const g of Object.values(d.groups)) if (g && Array.isArray(g.rows)) g.rows = g.rows.map(r => idx.map(i => i < 0 ? null : r[i]));
    d.fields = OMM_FIELDS.slice();
  }
  for (const k of Object.keys(d.groups)) if (!d.groups[k] || !Array.isArray(d.groups[k].rows)) delete d.groups[k];
  return d;
}
function embeddedSnapshot() { const d = normDataset(SNAPSHOT); if (d) d.src = 'embedded'; return d; }
function readCache() { const s = store.get(CACHE_KEY); if (!s) return null; try { const d = normDataset(JSON.parse(s)); if (d) d.fromCache = true; return d; } catch (e) { return null; } }
// A static copy on this website (written by tools/fetch-celestrak.mjs). Same-origin, so it works wherever the page itself loads.
async function fetchHosted(signal) {
  if (!HOSTED_DATA || location.protocol === 'file:') return { ds: null, reason: 'No hosted copy (page opened as a file).' };
  const t = timed(signal, 20000);
  try {
    const res = await fetch(HOSTED_DATA, { signal: t.signal, cache: 'no-cache' });
    if (!res.ok) return { ds: null, reason: `No hosted copy (HTTP ${res.status}).` };
    const ds = normDataset(await res.json());
    if (ds) ds.src = 'hosted';
    return ds && Object.keys(ds.groups).length ? { ds } : { ds: null, reason: 'The hosted copy is not in the expected format.' };
  } catch (e) { return { ds: null, reason: t.timedOut() ? 'The hosted copy took too long.' : 'No hosted copy could be read.' }; }
  finally { t.done(); }
}

let loadCtl = null, userChoseDemo = false, refusedAtMem = 0, lastBrowserFetch = 0;
function loadData(opts = {}) {
  if (opts.demo && loadCtl) { userChoseDemo = true; loadCtl.abort(); }   // "use demo data" while a load is running
  if (loadPromise) return loadPromise;   // no duplicate downloads
  loadPromise = (async () => {
    showLoading(true); userChoseDemo = false;
    if (!HAS_SAT) return useDemo('The orbit library (satellite.js) did not load, so real positions cannot be calculated.');
    if (opts.demo) return useDemo('You switched to demo data.');
    loadCtl = new AbortController(); const signal = loadCtl.signal;
    const chose = () => userChoseDemo || signal.aborted;
    const now = Date.now(), cache = readCache(), fresh = (d, ttl) => d && d.fetchedAtKind !== 'newest-epoch' && now - d.fetchedAt < ttl && d.fetchedAt <= now + 6e5;
    if (fresh(cache, CACHE_TTL) && !opts.force) return useDataset(cache, 'cached', 'Loaded from this browser’s cache to avoid re-downloading data that has not changed.');
    const notes = [];
    // 1. this site's data server
    let api = { none: true };
    if (API_BASE && location.protocol !== 'file:') {
      setLoading('Asking this site’s data server for orbital elements…', 0.04);
      api = await fetchApi(signal, (k, g) => setLoading(`Loading ${g.label} from this site’s data server (${k + 1} of ${GROUPS.length})`, (k + 0.5) / GROUPS.length));
      if (chose()) return useDemo('You chose demo data while loading.');
      if (!api.none) {
        if (Object.keys(api.groups).length) {
          if (!store.set(CACHE_KEY, JSON.stringify(api))) console.info('OrbitWatch: data too large for browser cache.');
          const failed = Object.keys(api.failed).length;
          return useDataset(api, api.stale || now - api.fetchedAt > STALE_AFTER ? 'stale' : 'live', failed ? `${failed} group(s) could not be loaded. See the list below.` : '');
        }
        const reasons = [...new Set(Object.values(api.failed))];
        notes.push('The data server has no data yet: ' + reasons[0]);
      }
    }
    // 2. a static copy on this website
    setLoading('Looking for a stored copy of the data on this website…', 0.5);
    const hosted = await fetchHosted(signal);
    if (chose()) return useDemo('You chose demo data while loading.');
    if (fresh(hosted.ds, HOSTED_FRESH)) return useDataset(hosted.ds, 'hosted', notes.join(' '));
    // 3. CelesTrak directly (off by default)
    let ds = null;
    const refusedAt = Math.max(+store.get(REFUSED_KEY) || 0, refusedAtMem);
    if (!BROWSER_FETCH) { if (api.none && !hosted.ds) notes.push(api.reason || 'This site has no data server.'); }
    else if (now - refusedAt < CACHE_TTL) notes.push(`CelesTrak refused a request from this browser at ${utc(refusedAt)}. Not asking again until ${utc(refusedAt + CACHE_TTL)}.`);
    else if (fresh(cache, CACHE_TTL)) {   // Refresh within 2 h of a download: CelesTrak has nothing newer and would refuse
      toast(`Data is ${age(now - cache.fetchedAt)} old. CelesTrak updates about every 2 hours, so no new download is needed yet.`, 5000);
      return useDataset(cache, 'cached', 'Kept the cached copy: CelesTrak has probably not updated yet.');
    }
    else if (now - lastBrowserFetch < CACHE_TTL) notes.push('This browser already downloaded from CelesTrak in the last 2 hours but could not store it, so it is not asking again yet.');
    else {
      ds = await fetchAll(signal, (k, g) => setLoading(`Downloading ${g.label} from CelesTrak (${k + 1} of ${GROUPS.length})`, (k + 0.5) / GROUPS.length));
      if (chose()) return useDemo('You chose demo data while loading.');
      if (Object.keys(ds.groups).length) {
        lastBrowserFetch = Date.now();
        const failed = Object.keys(ds.failed).length;
        if (!store.set(CACHE_KEY, JSON.stringify(ds))) console.info('OrbitWatch: data too large for browser cache.');
        return useDataset(ds, 'live', failed ? `${failed} group(s) could not be loaded. See the list below.` : '');
      }
      notes.push('Live download failed: ' + (Object.values(ds.failed)[0] || 'unknown error.'));
    }
    // 4. the newest copy available
    const fallbacks = [hosted.ds && { d: hosted.ds, m: hosted.ds.fetchedAtKind === 'newest-epoch' ? 'snapshot' : 'stale' }, cache && { d: cache, m: now - cache.fetchedAt > STALE_AFTER ? 'stale' : 'cached' }, SNAPSHOT && { d: embeddedSnapshot(), m: 'snapshot' }]
      .filter(f => f && f.d).sort((a, b) => b.d.fetchedAt - a.d.fetchedAt);
    if (fallbacks.length) return useDataset(fallbacks[0].d, fallbacks[0].m, notes.join(' '), true);
    return useDemo('Real orbital data could not be loaded. ' + notes.join(' '));
  })().finally(() => { loadPromise = null; loadCtl = null; showLoading(false); });
  return loadPromise;
}

// ───────────────────────── object store
let objs = [], N = 0, CAP = 0;
let base, vel, stamp, pos, bad, vis, fu, fp;
let data = { mode: 'loading' };
let simCount = 0;

function classify(m, groupKey, activeIds) {
  const n = String(m.OBJECT_NAME || '').toUpperCase();
  if (/\bR\/B\b/.test(n)) return 'rocket';
  if (/\bDEB\b|DEBRIS|\bCOOLANT\b/.test(n) || groupKey.endsWith('-debris')) return 'debris';
  if (activeIds.has(+m.NORAD_CAT_ID) || groupKey === 'stations') return 'active';
  return 'inactive';
}
function validOMM(m) {
  const num = f => m[f] !== null && m[f] !== '' && isFinite(+m[f]);
  return num('NORAD_CAT_ID') && typeof m.EPOCH === 'string' && !isNaN(Date.parse(m.EPOCH.endsWith('Z') ? m.EPOCH : m.EPOCH + 'Z')) && num('MEAN_MOTION') && +m.MEAN_MOTION > 0
    && num('ECCENTRICITY') && +m.ECCENTRICITY >= 0 && +m.ECCENTRICITY < 1 && ['INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'].every(num);
}
function derive(o, n_revday, ecc, inc) {
  o.period = 1440 / n_revday;
  const a = Math.cbrt(MU * Math.pow(o.period * 60 / TAU, 2));
  o.ecc = ecc; o.inc = inc;
  o.perigee = a * (1 - ecc) - REQ; o.apogee = a * (1 + ecc) - REQ; o.meanAlt = a - REQ;
  o.regime = regimeOf(o);
}
function useDataset(ds, mode, note, fallback) {
  setLoading('Computing orbits with SGP4…', 0.95);
  const activeIds = new Set(((ds.groups.active || {}).rows || []).map(r => +r[0]));
  const byId = new Map(); let skipped = 0, filled = 0;
  for (const g of GROUPS) {
    const grp = ds.groups[g.key]; if (!grp) continue;
    for (const row of grp.rows) {
      const m = fromRow(row);
      if (!validOMM(m)) { skipped++; continue; }
      const id = +m.NORAD_CAT_ID;
      if (byId.has(id)) { byId.get(id).groups.push(g.key); continue; }
      for (const f of ['BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT']) if (m[f] === null || m[f] === '' || !isFinite(+m[f])) { m[f] = 0; filled++; }
      let satrec; try { satrec = satellite.json2satrec(m); } catch (e) { skipped++; continue; }
      if (!satrec || satrec.error) { skipped++; continue; }
      const o = { id, cat: String(id).padStart(5, '0'), name: String(m.OBJECT_NAME || 'UNKNOWN').trim(), intl: m.OBJECT_ID || '', type: classify(m, g.key, activeIds), groups: [g.key],
        epoch: Date.parse(m.EPOCH.endsWith('Z') ? m.EPOCH : m.EPOCH + 'Z'), satrec };
      derive(o, +m.MEAN_MOTION, +m.ECCENTRICITY, +m.INCLINATION);
      byId.set(id, o);
    }
  }
  const list = [...byId.values()];
  if (!list.length) return useDemo('The data that loaded contained no usable orbital elements.');
  if (!ds.groups.active && list.some(o => o.type === 'inactive'))
    note = (note ? note + ' ' : '') + 'The active-satellite list did not load, so only space stations are marked active; other payloads show as inactive and may be wrong.';
  const epochs = list.map(o => o.epoch).sort((a, b) => a - b);
  setObjects(list, {
    mode, note, fetchedAt: ds.fetchedAt, skipped, filled, fallback: !!fallback,
    src: ds.fromCache ? 'browser-cache' : ds.src || (mode === 'live' ? 'browser' : 'embedded'),
    fetchedAtIsEpoch: ds.fetchedAtKind === 'newest-epoch',
    groupsOk: GROUPS.filter(g => ds.groups[g.key]).map(g => { const x = ds.groups[g.key]; return { ...g, n: list.filter(o => o.groups.includes(g.key)).length, at: x.fetchedAt || ds.fetchedAt, stale: !!x.stale, err: x.lastError || null }; }),
    groupsFailed: GROUPS.filter(g => !ds.groups[g.key]).map(g => ({ ...g, reason: (ds.failed || {})[g.key] || (mode === 'live' ? 'Not loaded.' : 'Not included in this copy.') })),
    newestEpoch: epochs[epochs.length - 1], oldestEpoch: epochs[0], medianEpoch: epochs[epochs.length >> 1],
  });
}
function useDemo(reason) {
  let seed = 7; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const list = [], t0 = Date.now();
  const add = (name, type, alt, inc, raan, u, feat) => {
    const s = circState(alt, inc, raan, u), o = { id: 'D' + (list.length + 1), cat: 'demo', name, intl: '', type, groups: ['demo'], epoch: t0, r0: s.r, v0: s.v, t0, feat };
    derive(o, 1440 / (TAU * Math.sqrt(Math.pow(RS + alt, 3) / MU) / 60) , 0, inc);
    o.perigee = o.apogee = o.meanAlt = alt; o.regime = regimeOf(o); list.push(o);
  };
  add('ISS (demo orbit)', 'active', 420, 51.6, 0, 0, 'iss'); add('Tiangong (demo orbit)', 'active', 390, 41.5, 50, 60, 'css');
  add('Hubble (demo orbit)', 'active', 535, 28.5, 100, 120, 'hst'); add('Polar weather satellite (demo)', 'active', 824, 98.7, 150, 180, 'noaa');
  for (let k = 0; k < 300; k++) add('Broadband constellation sat ' + (k + 1) + ' (demo)', 'active', 545 + rnd() * 15, 53, k % 24 * 15, rnd() * 360);
  for (let k = 0; k < 60; k++) add('High LEO constellation sat ' + (k + 1) + ' (demo)', 'active', 1200, 87.9, k % 12 * 15, k * 37 % 360);
  for (let k = 0; k < 24; k++) add('Navigation sat ' + (k + 1) + ' (demo)', 'active', 20200, 55, k % 6 * 60, (k / 6 | 0) * 90 + k % 6 * 15, k ? undefined : 'gps');
  for (let k = 0; k < 30; k++) add('Geostationary sat ' + (k + 1) + ' (demo)', 'active', 35786, 0.1 + rnd() * 0.5, 0, k * 12, k ? undefined : 'goes');
  for (let k = 0; k < 40; k++) add('Earth imaging sat ' + (k + 1) + ' (demo)', 'active', 690 + rnd() * 120, 98.2, rnd() * 360, rnd() * 360);
  for (let k = 0; k < 30; k++) add('Retired satellite ' + (k + 1) + ' (demo)', 'inactive', 600 + rnd() * 900, 50 + rnd() * 50, rnd() * 360, rnd() * 360);
  for (let k = 0; k < 120; k++) add('Fengyun-1C-like debris ' + (k + 1) + ' (demo)', 'debris', 780 + rnd() * 120, 98.8 + (rnd() - 0.5) * 0.8, 150 + rnd() * 60, rnd() * 360, k ? undefined : 'fy');
  for (let k = 0; k < 100; k++) add('Collision debris ' + (k + 1) + ' (demo)', 'debris', 770 + rnd() * 40, k % 2 ? 74 : 86.4, rnd() * 360, rnd() * 360);
  for (let k = 0; k < 60; k++) add('Test debris ' + (k + 1) + ' (demo)', 'debris', 450 + rnd() * 70, 82.6, rnd() * 360, rnd() * 360);
  for (let k = 0; k < 25; k++) add('Rocket body ' + (k + 1) + ' (demo)', 'rocket', 500 + rnd() * 1500, 20 + rnd() * 80, rnd() * 360, rnd() * 360);
  setObjects(list, { mode: 'demo', note: reason, fetchedAt: t0, skipped: 0, filled: 0, groupsOk: [], groupsFailed: [], newestEpoch: t0, oldestEpoch: t0, medianEpoch: t0 });
}

function setObjects(list, info) {
  clearSim(true);
  objs = list; N = list.length; CAP = N + SIM_CAP;
  objs.forEach((o, i) => { o.i = i; o.nameU = o.name.toUpperCase(); });
  base = new Float64Array(CAP * 3); vel = new Float64Array(CAP * 3); stamp = new Float64Array(CAP);
  pos = new Float32Array(CAP * 3); bad = new Uint8Array(CAP); vis = new Uint8Array(CAP); fu = new Float64Array(CAP); fp = new Float64Array(CAP);
  data = info; cursor = 0; issCache = null; passCache = null; cmpResult = null;
  resolveFeatured();
  buildBuffers();
  computeVisibility();
  refreshAll(simMs);
  sel = -1; cmpA = cmpB = -1;
  buildStats(); renderLayers(); renderBadge(); renderSuggestions(); renderSources(); renderCompare();
  const start = featured.iss != null ? featured.iss : objs.findIndex(o => o.type === 'active');
  if (start >= 0) select(start, { quiet: true });
  if (obs) renderSky(true);
  if (!introShown && !store.get(INTRO_KEY)) openIntro();
}

// featured objects (educational highlights + suggestions)
let featured = {};
function resolveFeatured() {
  featured = {};
  for (const f of FEATURED) {
    let i = -1;
    if (data.mode === 'demo') i = objs.findIndex(o => o.feat === f.key);
    else { for (const id of f.ids) { i = objs.findIndex(o => o.id === id); if (i >= 0) break; } if (i < 0) i = objs.findIndex(o => f.re.test(o.nameU)); }
    if (i >= 0) featured[f.key] = i;
  }
}

// ───────────────────────── propagation scheduler
let cursor = 0, budget = 3000;
function refreshOne(i, ms) {
  const s = eciAt(objs[i], ms);
  if (!s) { bad[i] = 1; return; }
  bad[i] = 0; const k = i * 3;
  base[k] = s.r[0]; base[k + 1] = s.r[1]; base[k + 2] = s.r[2];
  vel[k] = s.v[0]; vel[k + 1] = s.v[1]; vel[k + 2] = s.v[2]; stamp[i] = ms;
  const r2 = dot3(s.r, s.r); fu[i] = MU / (r2 * Math.sqrt(r2)); fp[i] = dot3(s.r, s.v) / r2;
}
function refreshAll(ms) { const n = N + simCount; for (let i = 0; i < n; i++) refreshOne(i, ms); extrapolate(ms); }
function stepPositions(ms) {
  const n = N + simCount; if (!n) return;
  if (cursor >= n) cursor = 0;
  const t0 = performance.now(), b = Math.min(budget, n);
  for (let k = 0; k < b; k++) { refreshOne(cursor, ms); cursor = (cursor + 1) % n; }
  const took = performance.now() - t0;
  budget = clamp(Math.round(budget * (took > 0.05 ? 4 / took : 2)), 400, Math.max(400, n));
  extrapolate(ms);
}
function extrapolate(ms) {
  const n = N + simCount;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    if (bad[i]) { pos[k] = pos[k + 1] = pos[k + 2] = 0; continue; }
    // between SGP4 refreshes: Lagrange f and g series (keeps the dot on its curved path, unlike a straight line)
    const dt = (ms - stamp[i]) / 1000, d2 = dt * dt, u = fu[i], f = 1 - 0.5 * u * d2 + 0.5 * u * fp[i] * d2 * dt, g = dt - u * d2 * dt / 6;
    pos[k] = (f * base[k] + g * vel[k]) / RS; pos[k + 1] = (f * base[k + 2] + g * vel[k + 2]) / RS; pos[k + 2] = -(f * base[k + 1] + g * vel[k + 1]) / RS;
  }
}

// ───────────────────────── filters
const typeOn = { active: true, inactive: true, rocket: true, debris: true, sim: true };
const regOn = { LEO: true, MEO: true, GEO: true, HEO: true };
let band = null;   // [lo, hi] km mean altitude
function computeVisibility() {
  const n = N + simCount;
  for (let i = 0; i < n; i++) {
    const o = objs[i];
    vis[i] = typeOn[o.type] && regOn[o.regime] && (!band || (o.meanAlt >= band[0] && o.meanAlt < band[1])) ? 1 : 0;
  }
  renderFilterPill();
}
function renderFilterPill() {
  const parts = [];
  const offT = TYPE_KEYS.filter(t => !typeOn[t] && (t !== 'sim' || simCount)).map(t => TYPES[t].label.toLowerCase());
  if (offT.length) parts.push('hiding ' + offT.join(', '));
  const offR = Object.keys(regOn).filter(k => !regOn[k]);
  if (offR.length) parts.push('hiding ' + offR.join(', '));
  if (band) parts.push(`only ${band[0]}–${band[1]} km`);
  $('filt').hidden = !parts.length; $('filtTxt').textContent = 'Filters: ' + parts.join('; ');
}

// ───────────────────────── 3D scene
let rd = null, sc, cam, earth, clouds, orbitSel, orbitA, orbitB, linkAB, obsM, caM;
const layers = {};
let glOK = false;
function spriteTex(shape) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.fillStyle = g.strokeStyle = '#fff'; g.lineWidth = 9;
  if (shape === 'dot') { g.beginPath(); g.arc(32, 32, 26, 0, TAU); g.fill(); }
  else if (shape === 'ring') { g.beginPath(); g.arc(32, 32, 24, 0, TAU); g.stroke(); }
  else if (shape === 'square') g.fillRect(10, 10, 44, 44);
  else if (shape === 'diamond') { g.beginPath(); g.moveTo(32, 3); g.lineTo(61, 32); g.lineTo(32, 61); g.lineTo(3, 32); g.closePath(); g.fill(); }
  else if (shape === 'cross') { g.lineWidth = 12; g.beginPath(); g.moveTo(10, 10); g.lineTo(54, 54); g.moveTo(54, 10); g.lineTo(10, 54); g.stroke(); }
  return c;
}
function legendIcon(shape, color) {
  const c = spriteTex(shape); const g = c.getContext('2d'); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, 64, 64);
  return `<img class="dot" alt="" src="${c.toDataURL()}" style="width:12px;height:12px">`;
}
function initScene() {
  if (!HAS_THREE) return glFail('The 3D library (three.js) did not load. Check your connection and reload.');
  try {
    rd = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
  } catch (e) { return glFail('Your browser could not start WebGL, so the 3D globe cannot be drawn.'); }
  if (!rd.getContext()) return glFail('WebGL is not available on this device.');
  glOK = true;
  rd.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  sc = new THREE.Scene(); cam = new THREE.PerspectiveCamera(45, 1, 0.01, 400);
  // Earth: canvas map first, then the photographic texture once it decodes
  const W = 1024, H = 512, tc = document.createElement('canvas'); tc.width = W; tc.height = H;
  { const g = tc.getContext('2d'); g.fillStyle = '#0e3a6b'; g.fillRect(0, 0, W, H); }
  const tex = new THREE.CanvasTexture(tc);
  earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshLambertMaterial({ map: tex })); sc.add(earth);
  earthImg.then(img => { tex.image = img; tex.anisotropy = 8; tex.needsUpdate = true; }).catch(() => {});
  // decorative clouds (not real weather)
  const cc = document.createElement('canvas'); cc.width = 1024; cc.height = 512;
  { const g = cc.getContext('2d'); let seed = 11; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    for (let k = 0; k < 600; k++) { const x = rnd() * 1024, y = (0.12 + 0.76 * rnd()) * 512, r = 10 + rnd() * 40, gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,.13)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); } }
  clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 48, 32), new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(cc), transparent: true, depthWrite: false })); sc.add(clouds);
  sc.add(new THREE.AmbientLight(0x8899bb, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(5, 1.5, 2.5); sc.add(sun);
  sc.add(new THREE.Mesh(new THREE.SphereGeometry(1.05, 48, 32), new THREE.ShaderMaterial({ transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec3 n;void main(){n=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'varying vec3 n;void main(){float i=pow(max(.62-dot(n,vec3(0,0,1.)),0.),3.);gl_FragColor=vec4(.25,.6,1.,1.)*i*1.6;}' })));
  { let seed = 3; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647; const s = new Float32Array(1800);
    for (let k = 0; k < 1800; k += 3) { const a = rnd() * TAU, b = Math.acos(2 * rnd() - 1); s[k] = 150 * Math.sin(b) * Math.cos(a); s[k + 1] = 150 * Math.cos(b); s[k + 2] = 150 * Math.sin(b) * Math.sin(a); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(s, 3)); sc.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.2, sizeAttenuation: false, color: 0x9fb4ff }))); }
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  orbitSel = new THREE.Line(new THREE.BufferGeometry(), lineMat(0xffffff, 0.7)); orbitSel.frustumCulled = false; sc.add(orbitSel);
  orbitA = new THREE.Line(new THREE.BufferGeometry(), lineMat(0x36e0d0, 0.8)); orbitA.frustumCulled = false; sc.add(orbitA);
  orbitB = new THREE.Line(new THREE.BufferGeometry(), lineMat(0xffb547, 0.8)); orbitB.frustumCulled = false; sc.add(orbitB);
  linkAB = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.03, gapSize: 0.02 }));
  linkAB.frustumCulled = false; linkAB.visible = false; sc.add(linkAB);
  caM = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: 0xffffff, map: new THREE.CanvasTexture(spriteTex('ring')), transparent: true, alphaTest: 0.3 }));
  caM.frustumCulled = false; caM.visible = false; sc.add(caM);
  obsM = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff5d73 })); obsM.visible = false; earth.add(obsM);
}
function buildBuffers() {
  for (const t of TYPE_KEYS) {
    const members = [];
    for (let i = 0; i < N; i++) if (objs[i].type === t) members.push(i);
    const cap = t === 'sim' ? SIM_CAP : members.length;
    const L = layers[t] = layers[t] || {};
    L.members = members; L.buf = new Float32Array(Math.max(cap, 1) * 3); L.dirty = true;
    if (!glOK) continue;
    if (!L.pts) {
      L.mat = new THREE.PointsMaterial({ size: TYPES[t].size * pointScale(), sizeAttenuation: false, color: new THREE.Color(TYPES[t].color), map: new THREE.CanvasTexture(spriteTex(TYPES[t].shape)), transparent: true, alphaTest: 0.35 });
      L.pts = new THREE.Points(new THREE.BufferGeometry(), L.mat); L.pts.frustumCulled = false; sc.add(L.pts);
    }
    L.attr = new THREE.BufferAttribute(L.buf, 3); L.attr.setUsage(THREE.DynamicDrawUsage);
    L.pts.geometry.setAttribute('position', L.attr); L.pts.geometry.setDrawRange(0, members.length);
  }
}
function writeBuffers() {
  for (const t of TYPE_KEYS) {
    const L = layers[t]; if (!L || !L.attr) continue;
    const m = L.members, b = L.buf;
    for (let k = 0; k < m.length; k++) {
      const i = m[k], j = k * 3, s = i * 3;
      if (vis[i] && !bad[i]) { b[j] = pos[s]; b[j + 1] = pos[s + 1]; b[j + 2] = pos[s + 2]; } else b[j] = b[j + 1] = b[j + 2] = 0;
    }
    L.pts.geometry.setDrawRange(0, m.length); L.attr.needsUpdate = true;
  }
}
function pointScale() { return clamp(Math.min(freeRect.w, freeRect.h) / 640, 0.55, 1); }
function glFail(msg) { $('glfail').hidden = false; $('glfailTxt').textContent = msg + ' Search, statistics, passes and the ground-track map still work.'; $('c').style.display = 'none'; }

// earth image for both the globe and the 2D map
const earthImg = new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = EARTH_IMG; });

// ───────────────────────── camera and input
let az = 0.6, el = 0.35, dist = 4.2, follow = false; const target = [0, 0, 0];
let freeRect = { cx: innerWidth / 2, cy: innerHeight / 2, w: innerWidth, h: innerHeight };
function layout() {
  const barH = $('bar').offsetHeight; document.documentElement.style.setProperty('--bar-top', barH + 'px');
  const side = $('side').getBoundingClientRect(), W = innerWidth, H = innerHeight;
  if (W <= 720) freeRect = { cx: W / 2, cy: (barH + side.top) / 2, w: W, h: side.top - barH };
  else freeRect = { cx: (side.right + W) / 2, cy: (barH + H) / 2, w: W - side.right, h: H - barH };
  if (!glOK) return;
  rd.setSize(W, H); cam.aspect = W / H;
  cam.setViewOffset(W, H, W / 2 - freeRect.cx, H / 2 - freeRect.cy, W, H);
  cam.updateProjectionMatrix();
  for (const t of TYPE_KEYS) if (layers[t] && layers[t].mat) layers[t].mat.size = TYPES[t].size * pointScale();
  renderBadge();
}
function fitDist() { const m = Math.max(160, Math.min(freeRect.w, freeRect.h)); return clamp((innerHeight / 2) / (Math.tan(22.5 * D2R) * 0.36 * m), 2.6, 14); }
function camUpdate() {
  if (!glOK) return;
  cam.position.set(target[0] + dist * Math.cos(el) * Math.sin(az), target[1] + dist * Math.sin(el), target[2] + dist * Math.cos(el) * Math.cos(az));
  cam.lookAt(target[0], target[1], target[2]);
}
function pan(dx, dy) {
  const k = dist * 0.0012, rx = Math.cos(az), rz = -Math.sin(az);
  target[0] -= dx * k * rx; target[2] -= dx * k * rz; target[1] += dy * k;
  const L = len3(target); if (L > 1.5) for (let j = 0; j < 3; j++) target[j] *= 1.5 / L;
}
const ptr = new Map(); let down = null, pinch = 0, mid = null, dragging = false;
function initInput() {
  const cv = $('c');
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); ptr.set(e.pointerId, [e.clientX, e.clientY]); down = [e.clientX, e.clientY, e.shiftKey || e.button === 2]; dragging = false;
    if (ptr.size === 2) { const a = [...ptr.values()]; pinch = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]); mid = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2]; down = null; }
  });
  cv.addEventListener('pointermove', e => {
    if (!ptr.has(e.pointerId)) { hoverAt(e.clientX, e.clientY); return; }
    const p = ptr.get(e.pointerId), dx = e.clientX - p[0], dy = e.clientY - p[1];
    ptr.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptr.size === 1) {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) dragging = true;
      if (!dragging) return;
      if (down && down[2]) pan(dx, dy);
      else { az -= dx * 0.005 * dist / 4; el = clamp(el + dy * 0.005 * dist / 4, -1.45, 1.45); setFollow(false); }
      hideTip();
    } else if (ptr.size === 2) {
      const a = [...ptr.values()], d = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]), m = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2];
      if (pinch) dist = clamp(dist * pinch / d, 1.4, 16); pinch = d;
      if (mid) pan(m[0] - mid[0], m[1] - mid[1]); mid = m;
    }
  });
  const up = e => {
    ptr.delete(e.pointerId);
    if (down && !dragging && ptr.size === 0) clickAt(e.clientX, e.clientY);
    if (ptr.size < 2) { pinch = 0; mid = null; }
    if (ptr.size === 0) down = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', e => { ptr.delete(e.pointerId); down = null; });
  cv.addEventListener('pointerleave', hideTip);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => { e.preventDefault(); dist = clamp(dist * Math.exp(e.deltaY * 0.001), 1.4, 16); }, { passive: false });
  cv.addEventListener('keydown', e => {
    const k = e.key, step = 0.08;
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      if (e.shiftKey) pan(-dx * 40, -dy * 40); else { az -= dx * step; el = clamp(el - dy * step, -1.45, 1.45); setFollow(false); }
    } else if (k === '+' || k === '=') dist = clamp(dist * 0.88, 1.4, 16);
    else if (k === '-' || k === '_') dist = clamp(dist / 0.88, 1.4, 16);
  });
}
const vv = HAS_THREE ? new THREE.Vector3() : null;
function hiddenBehindEarth(x, y, z) {
  const c = cam.position, dx = x - c.x, dy = y - c.y, dz = z - c.z, L = dx * dx + dy * dy + dz * dz;
  const t = clamp(-(c.x * dx + c.y * dy + c.z * dz) / L, 0, 1), px = c.x + t * dx, py = c.y + t * dy, pz = c.z + t * dz;
  return px * px + py * py + pz * pz < 1;
}
function screenOf(i) {
  const k = i * 3; vv.set(pos[k], pos[k + 1], pos[k + 2]);
  if (hiddenBehindEarth(vv.x, vv.y, vv.z)) return null;
  vv.project(cam); if (vv.z > 1) return null;
  return [(vv.x + 1) / 2 * innerWidth, (1 - vv.y) / 2 * innerHeight];
}
function pickAt(mx, my, radius) {
  if (!glOK) return -1;
  cam.updateMatrixWorld();
  let best = -1, bd = radius; const n = N + simCount;
  for (let i = 0; i < n; i++) {
    if (!vis[i] || bad[i]) continue;
    const s = screenOf(i); if (!s) continue;
    const d = Math.hypot(s[0] - mx, s[1] - my); if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function clickAt(mx, my) {
  const j = pickAt(mx, my, 14);
  if (j >= 0) { select(j); openTab('obj'); return; }
  if (activeTab !== 'sky' || !glOK) return;
  const rc = new THREE.Raycaster(); rc.setFromCamera({ x: mx / innerWidth * 2 - 1, y: -(my / innerHeight * 2 - 1) }, cam);
  const h = rc.intersectObject(earth)[0];
  if (h) { const l = earth.worldToLocal(h.point.clone()); setObserver(Math.asin(clamp(l.y, -1, 1)) * R2D, Math.atan2(-l.z, l.x) * R2D, 'clicked on the globe'); }
}
let hoverReq = 0;
function hoverAt(mx, my) {
  if (hoverReq || !glOK || !N) return;
  hoverReq = requestAnimationFrame(() => {
    hoverReq = 0;
    const j = pickAt(mx, my, 10), tip = $('tip');
    if (j < 0) return hideTip();
    const o = objs[j];
    tip.innerHTML = `<b>${esc(o.name)}</b>${TYPES[o.type].one} · ${o.cat === 'demo' || o.type === 'sim' ? 'no catalog number' : 'catalog #' + o.id} · ~${fmtN(Math.round(o.meanAlt))} km`;
    tip.style.display = 'block';
    tip.style.left = Math.min(mx + 14, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = Math.min(my + 14, innerHeight - tip.offsetHeight - 8) + 'px';
  });
}
function hideTip() { $('tip').style.display = 'none'; }

// ───────────────────────── time
let simMs = Date.now(), speed = 60, lastFrame = performance.now();
const SPEEDS = [[0, '⏸', 'Pause'], [1, '1×', 'Real time'], [60, '60×', 'One minute per second'], [300, '300×', 'Five minutes per second'], [1200, '1200×', 'Twenty minutes per second']];
function renderSpeeds() {
  $('spd').innerHTML = SPEEDS.map(([s, l, t]) => `<button class="btn sm" data-s="${s}" title="${t}" aria-pressed="${s === speed}">${l}</button>`).join('') + '<button class="btn sm" data-now title="Jump to the current time">Now</button>';
}
function setSpeed(s) { speed = s; [...$('spd').querySelectorAll('[data-s]')].forEach(b => b.setAttribute('aria-pressed', +b.dataset.s === s)); }
function jumpNow() { simMs = Date.now(); if (N) refreshAll(simMs); passCache = null; }

// ───────────────────────── selection and object panel
let sel = -1, cmpA = -1, cmpB = -1, obs = null, orbitT = 0, passCache = null;
function select(i, opt = {}) {
  sel = i; passCache = null; orbitT = 0;
  renderSelected();
  drawGroundTrack();
}
function setFollow(on) { follow = on; const b = $('fol'); if (b) b.setAttribute('aria-pressed', on); }
function orbitPoints(o, ms, n = 160) {
  const T = o.period * 60e3, arr = new Float32Array((n + 1) * 3); let ok = 0;
  for (let k = 0; k <= n; k++) { const s = eciAt(o, ms + T * k / n); if (!s) { arr.set(arr.subarray((k - 1) * 3, k * 3), k * 3); continue; } toScene(s.r, arr, k * 3); ok++; }
  return ok > 1 ? arr : null;
}
function setLine(line, arr) { if (!line) return; if (!arr) { line.visible = false; return; } line.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3)); line.geometry.computeBoundingSphere(); line.visible = true; }
function statusOf(o) {
  if (o.type === 'sim') return 'Simulated. Not a real object.';
  if (data.mode === 'demo') return 'Demo object. Not a real satellite.';
  if (o.type === 'active') return 'On CelesTrak’s active satellite list';
  if (o.type === 'inactive') return 'Not on the active list (likely retired)';
  if (o.type === 'rocket') return 'Spent rocket stage (never active as a satellite)';
  return 'Debris, no longer controlled';
}
function groupLabel(k) { const g = GROUPS.find(g => g.key === k); return g ? g.label : k === 'demo' ? 'Demo data' : k === 'sim' ? 'Breakup simulator' : k; }
function renderSelected() {
  const box = $('sel');
  if (sel < 0 || !objs[sel]) { box.innerHTML = '<p class="note">Click any dot on the globe, or search above, to inspect an object.</p>'; return; }
  const o = objs[sel], T = TYPES[o.type], ageMs = simMs - o.epoch;
  const ageWarn = o.satrec && Math.abs(ageMs) > 7 * 864e5 ? `<div class="warnbox" style="margin-top:8px">These elements are ${age(Math.abs(ageMs))} ${ageMs > 0 ? 'old' : 'ahead of the shown time'}. The position may be off by tens of kilometres or more.</div>` : '';
  const kind = o.type === 'sim' ? '<span class="tag sim">simulated</span>' : data.mode === 'demo' ? '<span class="tag sim">demo</span>' : '';
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">${legendIcon(T.shape, T.color)}<h3 style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(o.name)}</h3>${kind}</div>
    <div class="kv">
      <span>Catalog number</span><b>${o.cat === 'demo' || o.type === 'sim' ? '–' : o.id}</b>
      <span>Int'l designator</span><b>${esc(o.intl || '–')}</b>
      <span>Type</span><b style="font-family:var(--sans)">${T.one}</b>
      <span>Status</span><b style="font-family:var(--sans);font-weight:400">${statusOf(o)}</b>
      <span>Altitude now</span><b id="sAlt">–</b>
      <span>Speed now</span><b id="sSpd">–</b>
      <span>Sub-point</span><b id="sLL">–</b>
      <span>Perigee / apogee</span><b>${fmtN(Math.round(o.perigee))} / ${fmtN(Math.round(o.apogee))} km</b>
      <span>Inclination</span><b>${o.inc.toFixed(2)}°</b>
      <span>Orbital period</span><b>${o.period.toFixed(1)} min</b>
      <span>Orbit regime</span><b>${o.regime}</b>
      <span>Elements epoch</span><b>${o.satrec ? utc(o.epoch) : '–'}</b>
      <span>Source</span><b style="font-family:var(--sans);font-weight:400">${o.groups.map(groupLabel).map(esc).join('; ')}</b>
    </div>${ageWarn}
    <div class="row-btns">
      <button class="btn" id="fol" aria-pressed="${follow}" title="Keep the camera on this object">Follow</button>
      <button class="btn" id="setA" title="Use as object A in the Safety tab comparison">Compare as A</button>
      <button class="btn" id="setB" title="Use as object B in the Safety tab comparison">Compare as B</button>
    </div>
    <h2>Nearest objects right now <span class="tag approx">approx.</span></h2>
    <div class="list" id="near"></div>
    <p class="note">Distance at the shown time only. This is not a prediction of a future approach.</p>
    <h2>Passes over you</h2><div id="pas" class="note"></div>`;
  $('fol').onclick = () => setFollow(!follow);
  $('setA').onclick = () => { cmpA = sel; renderCompare(); openTab('saf'); };
  $('setB').onclick = () => { cmpB = sel; renderCompare(); openTab('saf'); };
  $('near').onclick = e => { const b = e.target.closest('[data-j]'); if (b) select(+b.dataset.j); };
  liveSelected(true);
}
function liveSelected(force) {
  if (sel < 0 || !objs[sel]) return;
  const o = objs[sel], s = eciAt(o, simMs), g = gmstAt(simMs);
  if (!s) { $('sAlt').textContent = 'cannot compute (decayed?)'; $('sSpd').textContent = '–'; $('sLL').textContent = '–'; $('near').innerHTML = '<span class="note">Position cannot be computed at this time.</span>'; return; }
  const geo = geodetic(s.r, g);
  $('sAlt').textContent = fmtN(Math.round(geo.h)) + ' km'; $('sSpd').textContent = len3(s.v).toFixed(2) + ' km/s';
  $('sLL').textContent = `${geo.lat.toFixed(1)}°, ${geo.lon.toFixed(1)}°`;
  // nearest objects now
  const k = sel * 3, list = [], n = N + simCount;
  for (let i = 0; i < n; i++) { if (i === sel || bad[i] || !vis[i]) continue; const j = i * 3, d = Math.hypot(pos[j] - pos[k], pos[j + 1] - pos[k + 1], pos[j + 2] - pos[k + 2]) * RS; if (list.length < 5 || d < list[4].d) { list.push({ i, d }); list.sort((a, b) => a.d - b.d); if (list.length > 5) list.pop(); } }
  $('near').innerHTML = list.length ? list.map(h => `<button class="item" data-j="${h.i}"><span>${esc(objs[h.i].name)}<br><small>${TYPES[objs[h.i].type].one}</small></span><span class="r">${fmtN(Math.round(h.d))} km</span></button>`).join('') : '<span class="note">No other visible objects.</span>';
  renderPasses(force);
}
function passesFor(o, fromMs, hours = 24) {
  const r = []; let c = null;
  for (let t = 0; t <= hours * 60; t += 0.5) {
    const ms = fromMs + t * 60e3, s = eciAt(o, ms); if (!s) break;
    const e = elevationFrom(obs, s.r, gmstAt(ms)).el;
    if (e > 10) { if (!c) c = { t0: ms, max: e, t1: ms }; c.max = Math.max(c.max, e); c.t1 = ms; }
    else if (c) { r.push(c); c = null; if (r.length >= 3) break; }
  }
  if (c) r.push(c);
  return r;
}
function renderPasses(force) {
  const box = $('pas'); if (!box) return;
  if (!obs) { box.innerHTML = 'Set a location in the <a href="#" data-tab="sky">Your sky</a> tab to predict passes.'; return; }
  const o = objs[sel];
  if (force || !passCache || passCache.sel !== sel || simMs > passCache.until || simMs < passCache.from) {
    passCache = { sel, from: simMs, list: passesFor(o, simMs) }; passCache.until = passCache.list.length ? passCache.list[0].t1 : simMs + 3600e3;
  }
  const p = passCache.list.filter(x => x.t1 >= simMs);
  box.innerHTML = '<div style="margin-bottom:4px">Next passes above 10° elevation <span class="tag approx">approx.</span></div>' + (p.length ? p.map(x => `<div class="item" style="cursor:default"><span>${x.t0 <= simMs ? '<b style="color:var(--ok)">Overhead now</b>' : 'in ' + dur((x.t0 - simMs) / 60e3)}<br><small>${localT(x.t0)} your time</small></span><span class="r">${Math.max(1, Math.round((x.t1 - x.t0) / 60e3))} min · peak ${Math.round(x.max)}°</span></div>`).join('') : 'No passes above 10° in the next 24 hours.') + '<p class="note">Does not check whether the object is sunlit or visible to the eye.</p>';
}

// ───────────────────────── compare two objects
let cmpResult = null;
function renderCompare() {
  const box = $('cmp'), A = objs[cmpA], B = objs[cmpB];
  const slot = (o, k, cls) => `<div class="item" style="cursor:default;border-left:3px solid var(--c-${cls})"><span><small>Object ${k}</small><br>${o ? esc(o.name) : '<span class="note">Not set</span>'}</span>${o ? `<button class="btn sm" data-goto="${o.i}">Show</button>` : ''}</div>`;
  let html = `<div class="list">${slot(A, 'A', 'a')}${slot(B, 'B', 'b')}</div>
    <div class="row-btns"><button class="btn sm" id="cUseA" ${sel < 0 ? 'disabled' : ''}>Selected → A</button><button class="btn sm" id="cUseB" ${sel < 0 ? 'disabled' : ''}>Selected → B</button><button class="btn sm" id="cSwap">Swap</button><button class="btn sm" id="cClear">Clear</button></div>`;
  if (!A || !B) {
    const iss = featured.iss, css = featured.css;
    html += `<p class="note">Pick two objects to draw both orbits and find their closest geometric pass in the next 24 hours.</p>` + (iss != null && css != null ? `<button class="btn sm" id="cTry">Try the ISS and Tiangong</button>` : '');
  } else if (cmpA === cmpB) html += '<p class="note">Pick two different objects.</p>';
  else {
    if (!cmpResult || cmpResult.a !== cmpA || cmpResult.b !== cmpB || Math.abs(cmpResult.from - simMs) > 6 * 3600e3) cmpResult = closestPass(A, B, simMs);
    const r = cmpResult;
    html += `<div class="card" style="margin-top:10px">
      <div class="kv" style="margin-top:0"><span>Distance now</span><b id="cNow">–</b>
      <span>Closest pass, next 24 h</span><b>${r ? fmtN(r.d < 10 ? +r.d.toFixed(1) : Math.round(r.d)) + ' km' : 'could not compute'}</b>
      ${r ? `<span>When</span><b>${utc(r.t)}<br><small style="font-family:var(--sans)">${r.t > simMs ? 'in ' + dur((r.t - simMs) / 60e3) : 'now'}</small></b><span>Relative speed then</span><b>${r.vrel.toFixed(2)} km/s</b>` : ''}</div>
      <p class="note">Geometric estimate from public orbital elements, with no uncertainty data. Real positions can differ by kilometres, so this is <b>not</b> a collision prediction. Small rings on the globe mark both objects at that moment.</p></div>`;
  }
  box.innerHTML = html;
  $('cUseA').onclick = () => { cmpA = sel; renderCompare(); };
  $('cUseB').onclick = () => { cmpB = sel; renderCompare(); };
  $('cSwap').onclick = () => { [cmpA, cmpB] = [cmpB, cmpA]; renderCompare(); };
  $('cClear').onclick = () => { cmpA = cmpB = -1; cmpResult = null; renderCompare(); };
  const t = $('cTry'); if (t) t.onclick = () => { cmpA = featured.iss; cmpB = featured.css; renderCompare(); };
  box.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { select(+b.dataset.goto); openTab('obj'); });
  updateCompareScene();
}
function closestPass(A, B, from) {
  const step = 30e3, n = 2880, d = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) { const a = eciAt(A, from + k * step), b = eciAt(B, from + k * step); d[k] = a && b ? Math.hypot(a.r[0] - b.r[0], a.r[1] - b.r[1], a.r[2] - b.r[2]) : Infinity; }
  const cands = [];
  for (let k = 0; k <= n; k++) if ((k === 0 || d[k] <= d[k - 1]) && (k === n || d[k] < d[k + 1])) cands.push(k);
  cands.sort((x, y) => d[x] - d[y]);
  let best = null;
  for (const k of cands.slice(0, 6)) {
    for (let t = Math.max(0, (k - 1) * step); t <= Math.min(n * step, (k + 1) * step); t += 1000) {
      const a = eciAt(A, from + t), b = eciAt(B, from + t); if (!a || !b) continue;
      const dd = Math.hypot(a.r[0] - b.r[0], a.r[1] - b.r[1], a.r[2] - b.r[2]);
      if (!best || dd < best.d) best = { d: dd, t: from + t, vrel: Math.hypot(a.v[0] - b.v[0], a.v[1] - b.v[1], a.v[2] - b.v[2]), ra: a.r, rb: b.r };
    }
  }
  return best && { ...best, a: A.i, b: B.i, from };
}
function updateCompareScene() {
  if (!glOK) return;
  const A = objs[cmpA], B = objs[cmpB];
  setLine(orbitA, A ? orbitPoints(A, simMs) : null); setLine(orbitB, B ? orbitPoints(B, simMs) : null);
  const r = cmpResult && A && B && cmpResult.a === cmpA && cmpResult.b === cmpB ? cmpResult : null;
  caM.visible = !!r;
  if (r) { const a = caM.geometry.attributes.position; toScene(r.ra, a.array, 0); toScene(r.rb, a.array, 3); a.needsUpdate = true; }
}

// ───────────────────────── breakup simulator (simulated fragments, two-body)
let seedSim = 99; const rndSim = () => (seedSim = seedSim * 16807 % 2147483647) / 2147483647;
function boom() {
  if (sel < 0) return toast('Select an object first.');
  if (simCount + 60 > SIM_CAP) return toast(`Simulation limit reached (${SIM_CAP} fragments). Clear the simulation to start again.`);
  const p = objs[sel], s = eciAt(p, simMs); if (!s) return toast('Cannot compute this object’s position.');
  for (let k = 0; k < 60; k++) {
    const dv = 0.02 + rndSim() * 0.13, th = rndSim() * TAU, ph = Math.acos(2 * rndSim() - 1);
    const v = [s.v[0] + dv * Math.sin(ph) * Math.cos(th), s.v[1] + dv * Math.sin(ph) * Math.sin(th), s.v[2] + dv * Math.cos(ph)];
    const i = N + simCount, o = { i, id: 'S' + (simCount + 1), cat: 'demo', name: `Simulated fragment ${simCount + 1} of ${p.name}`, nameU: '', intl: '', type: 'sim', groups: ['sim'], epoch: simMs, r0: s.r.slice(), v0: v, t0: simMs };
    const rn = len3(s.r), vn = len3(v), a = 1 / (2 / rn - vn * vn / MU), hv = [s.r[1] * v[2] - s.r[2] * v[1], s.r[2] * v[0] - s.r[0] * v[2], s.r[0] * v[1] - s.r[1] * v[0]];
    const e = Math.sqrt(Math.max(0, 1 - dot3(hv, hv) / (MU * a)));
    o.period = TAU * Math.sqrt(a * a * a / MU) / 60; o.ecc = e; o.inc = Math.acos(hv[2] / len3(hv)) * R2D; o.perigee = a * (1 - e) - REQ; o.apogee = a * (1 + e) - REQ; o.meanAlt = a - REQ; o.regime = regimeOf(o);
    objs[i] = o; simCount++; layers.sim.members.push(i); refreshOne(i, simMs); vis[i] = typeOn.sim ? 1 : 0;
  }
  extrapolate(simMs); renderLayers();
  $('bBoomClear').disabled = false;
  $('boomInfo').innerHTML = `<span class="tag sim">simulated</span> ${simCount} fragments in the simulation. Speed up time to watch them spread out: fragments with slightly different speeds get different orbital periods, so the cloud stretches into a ring around Earth. That is how one breakup threatens a whole orbital shell.`;
  toast('Simulated breakup: 60 pretend fragments added.');
}
function clearSim(silent) {
  if (!simCount) return;
  objs.length = N; simCount = 0; cursor = 0; if (layers.sim) layers.sim.members = [];
  $('bBoomClear').disabled = true; $('boomInfo').textContent = '';
  if (sel >= N) sel = -1; if (cmpA >= N) cmpA = -1; if (cmpB >= N) cmpB = -1;
  if (!silent) { renderSelected(); renderCompare(); renderLayers(); toast('Simulation cleared.'); }
}

// ───────────────────────── observer
function setObserver(lat, lon, how) {
  obs = { lat, lon }; passCache = null; issCache = null;
  if (obsM) { const f = lat * D2R, l = lon * D2R; obsM.position.set(Math.cos(f) * Math.cos(l), Math.sin(f), -Math.cos(f) * Math.sin(l)).multiplyScalar(1.006); obsM.visible = true; }
  $('where').textContent = `${lat.toFixed(2)}°, ${lon.toFixed(2)}° (${how})`;
  renderSky(true); renderPasses(true); drawGroundTrack();
}
let issCache = null;
function renderSky(force) {
  if (!obs) return;
  const g = gmstAt(simMs), list = [], n = N + simCount;
  for (let i = 0; i < n; i++) {
    if (!vis[i] || bad[i]) continue;
    const k = i * 3, r = [pos[k] * RS, -pos[k + 2] * RS, pos[k + 1] * RS];
    const e = elevationFrom(obs, r, g); if (e.el > 10) list.push({ i, el: e.el, range: e.range });
  }
  list.sort((a, b) => b.el - a.el);
  $('over').innerHTML = `<div style="margin-bottom:4px">${fmtN(list.length)} of the objects shown are more than 10° above your horizon right now.</div><div class="list">` + list.slice(0, 8).map(h => `<button class="item" data-j="${h.i}"><span>${esc(objs[h.i].name)}<br><small>${TYPES[objs[h.i].type].one}</small></span><span class="r">${Math.round(h.el)}° up · ${fmtN(Math.round(h.range))} km</span></button>`).join('') + '</div>';
  const iss = featured.iss;
  if (iss == null) { $('issPass').textContent = 'The ISS is not in the loaded data.'; return; }
  if (force || !issCache || simMs > issCache.until || simMs < issCache.from) { const l = passesFor(objs[iss], simMs); issCache = { from: simMs, list: l, until: l.length ? l[0].t1 : simMs + 3600e3 }; }
  const p = issCache.list.find(x => x.t1 >= simMs);
  $('issPass').innerHTML = p ? `<button class="item" data-j="${iss}"><span>${p.t0 <= simMs ? '<b style="color:var(--ok)">Overhead now</b>' : 'In ' + dur((p.t0 - simMs) / 60e3)}<br><small>${localT(p.t0)} your time · peak ${Math.round(p.max)}°</small></span><span class="r">${Math.max(1, Math.round((p.t1 - p.t0) / 60e3))} min</span></button>` : 'No ISS pass above 10° in the next 24 hours.';
}

// ───────────────────────── ground track (2D, works without WebGL)
function drawGroundTrack() {
  const cv = $('gt'), g = cv.getContext('2d'), W = cv.width, H = cv.height, X = l => (l + 180) / 360 * W, Y = l => (90 - l) / 180 * H;
  g.fillStyle = '#0b2a52'; g.fillRect(0, 0, W, H);
  if (earthReady) g.drawImage(earthReady, 0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
  for (let l = -150; l <= 150; l += 30) { g.beginPath(); g.moveTo(X(l), 0); g.lineTo(X(l), H); g.stroke(); }
  for (let l = -60; l <= 60; l += 30) { g.beginPath(); g.moveTo(0, Y(l)); g.lineTo(W, Y(l)); g.stroke(); }
  if (obs) { g.fillStyle = '#ff5d73'; g.beginPath(); g.arc(X(obs.lon), Y(obs.lat), 6, 0, TAU); g.fill(); }
  const o = objs[sel]; if (!o) return;
  let prev = null, cur = null;
  for (let m = -45; m <= 135; m++) {
    const ms = simMs + m * 60e3, s = eciAt(o, ms); if (!s) { prev = null; continue; }
    const p = geodetic(s.r, gmstAt(ms));
    if (prev && Math.abs(p.lon - prev.lon) < 180) { g.strokeStyle = m <= 0 ? 'rgba(255,255,255,.35)' : '#fff'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(X(prev.lon), Y(prev.lat)); g.lineTo(X(p.lon), Y(p.lat)); g.stroke(); }
    prev = p; if (m === 0) cur = p;
  }
  if (cur) { g.fillStyle = '#fff'; g.strokeStyle = '#ff7a45'; g.lineWidth = 3; g.beginPath(); g.arc(X(cur.lon), Y(cur.lat), 7, 0, TAU); g.fill(); g.stroke(); }
}
let earthReady = null; earthImg.then(im => { earthReady = im; drawGroundTrack(); }).catch(() => {});

// ───────────────────────── stats
let hist = null;
function buildStats() {
  const real = objs.slice(0, N), cnt = t => real.filter(o => o.type === t).length, demo = data.mode === 'demo';
  $('tiles').innerHTML = [[N, 'loaded objects'], [cnt('active'), 'active satellites'], [cnt('inactive'), 'inactive satellites'], [cnt('rocket'), 'rocket bodies'], [cnt('debris'), 'debris']].map(([n, l]) => `<div class="st"><b>${fmtN(n)}</b><span>${l}</span></div>`).join('');
  const failed = (data.groupsFailed || []).length;
  $('countDef').innerHTML = demo
    ? '<span class="tag sim">demo</span> These are generated demo objects, not real counts.'
    : `Counted: every object whose orbital elements loaded from the ${data.groupsOk.length} CelesTrak group${data.groupsOk.length === 1 ? '' : 's'} listed under Data source${failed ? ` (${failed} group${failed === 1 ? '' : 's'} failed)` : ''}, counted once even if it appears in several groups. <b>This is a subset of the catalog:</b> most inactive satellites, rocket bodies and debris are not in these groups.` + (data.skipped ? ` ${fmtN(data.skipped)} record${data.skipped === 1 ? '' : 's'} with missing or invalid fields ${data.skipped === 1 ? 'was' : 'were'} skipped.` : '');
  // histogram: 0–2000 km, 50 km bins, stacked by type
  const B = 40, bins = Array.from({ length: B }, () => ({ active: 0, inactive: 0, rocket: 0, debris: 0 }));
  for (const o of real) { const b = Math.floor(o.meanAlt / 50); if (b >= 0 && b < B && o.regime === 'LEO') bins[b][o.type]++; }
  hist = { bins, B, focus: -1, hover: -1 };
  $('histKey').innerHTML = ['active', 'inactive', 'rocket', 'debris'].map(t => `<span><span class="dot" style="background:${TYPES[t].color};border-radius:2px"></span> ${TYPES[t].label}</span>`).join('');
  drawHist();
  // regimes
  const rc = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 }; real.forEach(o => rc[o.regime]++);
  const mx = Math.max(1, ...Object.values(rc));
  $('regBars').innerHTML = Object.keys(rc).map(k => `<div class="bar-row" title="${REGIMES[k].tip}"><span>${k}</span><div class="track"><div class="fill" style="width:${rc[k] / mx * 100}%"></div></div><span class="n">${fmtN(rc[k])}</span></div>`).join('') +
    '<p class="note">LEO: up to 2,000 km. MEO: 2,000 to 35,786 km (GPS). GEO: the belt at 35,786 km over the equator, where a satellite keeps pace with Earth’s spin. HEO: very stretched orbits. Grouped by each object’s average altitude.</p>';
  // insights derived from the loaded data
  const ins = [];
  let pk = 0; const tot = b => b.active + b.inactive + b.rocket + b.debris;
  bins.forEach((b, i) => { if (tot(b) > tot(bins[pk])) pk = i; });
  const leo = real.filter(o => o.regime === 'LEO').length;
  if (leo) {
    const inBand = real.filter(o => o.regime === 'LEO' && Math.floor(o.meanAlt / 50) === pk), fam = {};
    inBand.forEach(o => { const f = o.nameU.split(/[\s\-(]/)[0]; fam[f] = (fam[f] || 0) + 1; });
    const top = Object.entries(fam).sort((a, b) => b[1] - a[1])[0];
    ins.push(`The most crowded 50 km band is <b>${pk * 50}–${pk * 50 + 50} km</b>, with ${fmtN(tot(bins[pk]))} objects, ${Math.round(tot(bins[pk]) / leo * 100)}% of the low-orbit objects loaded.` + (top && top[1] / inBand.length > 0.5 ? ` ${Math.round(top[1] / inBand.length * 100)}% of them are named ${esc(top[0])}, so one constellation dominates it.` : ''));
  }
  const junk = cnt('debris') + cnt('rocket');
  if (N) ins.push(`<b>${Math.round(junk / N * 100)}%</b> of the loaded objects are debris or rocket bodies: ${fmtN(junk)} pieces of junk next to ${fmtN(cnt('active'))} working satellites.`);
  if (!demo) {
    const fy = real.filter(o => o.groups.includes('fengyun-1c-debris')).length, irid = real.filter(o => o.groups.includes('iridium-33-debris') || o.groups.includes('cosmos-2251-debris')).length;
    if (fy) ins.push(`<b>${fmtN(fy)}</b> tracked fragments from the 2007 Fengyun-1C anti-satellite test are still in orbit in this data, nearly two decades later.`);
    if (irid) ins.push(`<b>${fmtN(irid)}</b> fragments from the 2009 Iridium 33 and Cosmos 2251 collision are still tracked here.`);
    const old = real.filter(o => simMs - o.epoch > 7 * 864e5).length;
    if (old) ins.push(`${fmtN(old)} objects have elements more than a week old, so their positions are less certain.`);
  }
  $('insights').innerHTML = (demo ? '<p class="note"><span class="tag sim">demo</span> These describe the demo set, not the real sky.</p>' : '') + ins.map(t => `<div class="insight">${t}</div>`).join('');
  // freshness
  const now = Date.now();
  $('fresh').innerHTML = demo ? '<span>Data</span><b style="font-family:var(--sans)">Demo, generated in your browser</b>' :
    `<span>${fetchedLabel()}</span><b>${utc(data.fetchedAt)}<br><small style="font-family:var(--sans)">${age(now - data.fetchedAt)} ago</small></b>
     <span>Newest elements</span><b>${utc(data.newestEpoch)}</b><span>Median element age</span><b>${age(now - data.medianEpoch)}</b><span>Oldest elements</span><b>${utc(data.oldestEpoch)}</b>
     <span>Could not propagate</span><b id="badCnt">–</b>`;
}
function histGeom() { const cv = $('hist'), r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); return { cv, W: Math.max(200, r.width), H: 150, dpr }; }
function drawHist() {
  if (!hist) return;
  const { cv, W, H, dpr } = histGeom(); cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const { bins, B } = hist, padL = 34, padB = 18, pw = W - padL - 4, ph = H - padB - 8;
  const tot = b => b.active + b.inactive + b.rocket + b.debris, mx = Math.max(1, ...bins.map(tot));
  const nice = Math.pow(10, Math.floor(Math.log10(mx))), top = Math.ceil(mx / nice) * nice;
  g.strokeStyle = 'rgba(122,162,255,.14)'; g.fillStyle = '#97a6c4'; g.font = '10px "IBM Plex Mono",monospace'; g.textAlign = 'right';
  for (let k = 0; k <= 2; k++) { const v = top * k / 2, y = 8 + ph - v / top * ph; g.beginPath(); g.moveTo(padL, y); g.lineTo(W - 4, y); g.stroke(); g.fillText(v >= 1000 ? (v / 1000) + 'k' : v, padL - 4, y + 3); }
  const bw = pw / B;
  bins.forEach((b, i) => {
    let y = 8 + ph; const x = padL + i * bw + 1, w = Math.max(1, bw - 2);
    for (const t of ['active', 'inactive', 'rocket', 'debris']) { const h = b[t] / top * ph; g.fillStyle = TYPES[t].color; g.globalAlpha = band && (i * 50 < band[0] || i * 50 >= band[1]) ? 0.3 : 1; g.fillRect(x, y - h, w, h); y -= h; }
    g.globalAlpha = 1;
    if (i === hist.hover || i === hist.focus) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(x - 0.5, 8, w + 1, ph); g.strokeStyle = 'rgba(122,162,255,.14)'; }
  });
  g.fillStyle = '#97a6c4'; g.textAlign = 'center';
  for (const km of [0, 500, 1000, 1500, 2000]) g.fillText(km + (km === 2000 ? ' km' : ''), clamp(padL + km / 50 * bw, padL + 6, W - 22), H - 4);
}
function histInfo(i) {
  const b = hist.bins[i], t = b.active + b.inactive + b.rocket + b.debris;
  $('histInfo').innerHTML = `<b>${i * 50}–${i * 50 + 50} km:</b> ${fmtN(t)} objects (${fmtN(b.active)} active, ${fmtN(b.inactive)} inactive, ${fmtN(b.rocket)} rocket bodies, ${fmtN(b.debris)} debris). ${band && band[0] === i * 50 ? 'Click again to clear the filter.' : 'Click to show only this band.'}`;
}
function histBin(e) { const { cv, W } = histGeom(), r = cv.getBoundingClientRect(), x = e.clientX - r.left, i = Math.floor((x - 34) / ((W - 38) / hist.B)); return i >= 0 && i < hist.B ? i : -1; }
function setBand(i) {
  band = i < 0 || (band && band[0] === i * 50) ? null : [i * 50, i * 50 + 50];
  $('bandChip').style.display = band ? 'flex' : 'none'; if (band) $('bandTxt').textContent = `Showing only ${band[0]}–${band[1]} km (average altitude)`;
  computeVisibility(); drawHist(); if (i >= 0) histInfo(i);
}

// ───────────────────────── layers / legend
function renderLayers() {
  const real = objs.slice(0, N), c = t => real.filter(o => o.type === t).length;
  $('types').innerHTML = TYPE_KEYS.map(t => `<label title="${TYPES[t].tip}"><input type="checkbox" data-t="${t}" ${typeOn[t] ? 'checked' : ''}>${legendIcon(TYPES[t].shape, TYPES[t].color)}<span>${TYPES[t].label}${t === 'sim' ? ' <span class="tag sim">sim</span>' : ''}</span><span class="cnt">${t === 'sim' ? simCount : fmtN(c(t))}</span></label>`).join('');
  const rc = k => real.filter(o => o.regime === k).length;
  $('regimes').innerHTML = Object.keys(REGIMES).map(k => `<label title="${REGIMES[k].tip}"><input type="checkbox" data-r="${k}" ${regOn[k] ? 'checked' : ''}><span>${REGIMES[k].label}</span><span class="cnt">${fmtN(rc(k))}</span></label>`).join('');
  $('lines').innerHTML = [['#ffffff', 'Orbit of the selected object (white ring marks it)'], ['#36e0d0', 'Comparison object A'], ['#ffb547', 'Comparison object B'], ['#ff5d73', 'Your location']].map(([c, l]) => `<div style="display:flex;gap:8px;align-items:center"><span class="sw" style="background:${c}"></span>${l}</div>`).join('');
}

// ───────────────────────── data badge + sources
const isStale = () => data.mode === 'stale' || (['live', 'cached', 'hosted'].includes(data.mode) && Date.now() - data.fetchedAt > STALE_AFTER);
const when = ms => new Date(ms).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? new Date(ms).toISOString().slice(11, 16) + ' UTC' : utc(ms);
function renderBadge() {
  const b = $('badge'), m = data.mode, stale = isStale(); b.dataset.mode = stale ? 'stale' : m;
  const short = innerWidth <= 720, at = () => when(data.fetchedAt), a = () => age(Date.now() - data.fetchedAt);
  const name = { live: 'LIVE', cached: 'CACHED', hosted: 'SERVER COPY' }[m];
  const t = m === 'demo' ? (short ? 'DEMO DATA' : 'DEMO DATA · simulated orbits')
    : m === 'snapshot' ? (short ? `SNAPSHOT · ${utc(data.fetchedAt).slice(0, 10)}` : `SNAPSHOT · ${utc(data.fetchedAt)}`)
    : stale ? (short ? `STALE · ${a()} old` : `STALE · last update ${at()} (${a()} ago)`)
    : name ? (short ? `${name} · ${at()}` : `${name} · CelesTrak · updated ${at()}`) : 'LOADING DATA';
  $('badgeTxt').textContent = t;
  b.title = m === 'demo' || m === 'loading' ? 'Data source and freshness. Click for details.' : `Last successful data update: ${utc(data.fetchedAt)} (${a()} ago). Click for details.`;
  renderDataStatus();
}
// One line under the time controls for the states that need attention: stale, fallback, empty and error.
function renderDataStatus() {
  const el = $('dstat'); if (!el) return;
  const m = data.mode, err = ((data.groupsOk || []).find(g => g.err) || {}).err;
  let t = '';
  if (m === 'demo' && data.note && !/^You (switched|chose)/.test(data.note)) t = data.note + ' Showing labelled demo orbits instead.';
  else if (isStale()) t = `Showing the last good data, updated ${utc(data.fetchedAt)} (${age(Date.now() - data.fetchedAt)} ago). Positions are less certain as the elements age.` + (err ? ` Latest refresh failed: ${err}` : data.fallback && data.note ? ' ' + data.note : '');
  else if (data.fallback && (m === 'snapshot' || m === 'cached')) t = `Showing ${m === 'snapshot' ? 'a dated snapshot' : 'data cached in this browser'} from ${utc(data.fetchedAt)}. ${data.note || ''}`;
  el.hidden = !t; $('dstatTxt').textContent = t;
}
const fetchedLabel = () => data.fetchedAtIsEpoch ? 'Snapshot date (newest element)' : data.src === 'hosted' || data.src === 'api' ? 'Last successful update (server)' : 'Last successful update';
function renderSources() {
  const m = data.mode, modeTxt = {
    live: data.src === 'api'
      ? 'Positions are calculated live in your browser with SGP4 from CelesTrak orbital elements that this site’s server downloaded. The server refreshes them every 2 hours; your browser does not contact CelesTrak.'
      : `Positions are calculated live in your browser with SGP4 from orbital elements this browser downloaded from CelesTrak at ${utc(data.fetchedAt)}.`,
    cached: data.fallback
      ? `Live data could not be loaded, so the copy cached in this browser (downloaded ${utc(data.fetchedAt)}) is shown. Accuracy drops as it ages.`
      : 'Positions are calculated live with SGP4 from CelesTrak elements cached in this browser. They were not downloaded again because CelesTrak updates about every 2 hours.',
    stale: data.src === 'api'
      ? 'This site’s data server could not refresh the elements from CelesTrak, so it is serving the last good copy. Positions are still calculated with SGP4, but they are less certain as the elements age.'
      : 'Live data could not be loaded, so the newest copy available is shown. It is more than 3 hours old, so positions are less certain.',
    hosted: 'Positions are calculated live in your browser with SGP4 from CelesTrak elements that this website’s server downloaded (see the time below). Your browser did not contact CelesTrak.',
    snapshot: data.src === 'hosted'
      ? `Positions are calculated live with SGP4 from a copy of CelesTrak elements stored on this website. ${data.fetchedAtIsEpoch ? 'Its download time is unknown, so it is dated by its newest element' : 'The copy is more than 3 hours old, so it is treated as a dated snapshot'}. Accuracy drops as it ages.`
      : 'Positions are calculated live with SGP4 from a snapshot of CelesTrak elements built into this page. The snapshot ages, so accuracy drops over time.',
    demo: 'Demo mode: no real orbital data loaded. Objects are generated in circular orbits that roughly match real populations (stations, a broadband constellation, debris clouds, GPS, GEO). Positions, names and counts are not real.',
  }[m];
  const ok = (data.groupsOk || []).map(g => `<tr><td>${esc(g.label)}${g.err ? `<br><small style="color:var(--warn)">Refresh failed: ${esc(g.err)}</small>` : ''}</td><td class="num">${fmtN(g.n)}</td><td>${data.fetchedAtIsEpoch ? '–' : when(g.at)}${g.stale ? ' <span class="tag approx">stale</span>' : ''}</td><td><a href="${CT}?GROUP=${g.key}&amp;FORMAT=json" target="_blank" rel="noopener">${g.key}</a></td></tr>`).join('');
  const bad_ = (data.groupsFailed || []).map(g => `<tr><td>${esc(g.label)}</td><td colspan="3" style="color:var(--warn)">${esc(g.reason)}</td></tr>`).join('');
  const stale = isStale(), tag = m === 'demo' ? 'sim' : stale ? 'approx' : m === 'live' || m === 'hosted' ? 'real' : 'approx';
  $('srcBody').innerHTML = `<p><span class="tag ${tag}">${m === 'hosted' ? 'server copy' : stale && m !== 'stale' ? m + ', stale' : m}</span> ${modeTxt}</p>` + (data.note ? `<p class="note">${esc(data.note)}</p>` : '') +
    (m !== 'demo' ? `<div class="kv"><span>${fetchedLabel()}</span><b>${utc(data.fetchedAt)}</b><span>Newest elements</span><b>${utc(data.newestEpoch)}</b></div>` : '') +
    (ok || bad_ ? `<h2>CelesTrak groups</h2><div class="tablewrap"><table><tr><th>Group</th><th>Objects</th><th>Updated</th><th>Source</th></tr>${ok}${bad_}</table></div>` : '') +
    `<h2>Checks</h2><p class="note">${esc((selfTest || runSelfTest()).msg)}</p>` +
    (m === 'demo' ? '<p class="note">Real data comes from this site’s data server (server/server.mjs), a stored copy on the site, or a snapshot built into the page. A claude.ai artifact cannot run the server or contact CelesTrak, so it shows a snapshot or demo data.</p>' : '');
  $('bDemo').textContent = m === 'demo' ? 'Try live data again' : 'Switch to demo data';
  $('srcList').innerHTML = `<ul>
    <li><b>Orbital elements:</b> <a href="https://celestrak.org/NORAD/elements/" target="_blank" rel="noopener">CelesTrak GP data</a> (Dr T.S. Kelso), OMM JSON, groups: ${GROUPS.map(g => g.key).join(', ')}. Your browser downloads them at most once every 2 hours and caches them, or uses a recent copy stored on this website. After a refusal from CelesTrak it waits 2 hours before asking again.</li>
    <li><b>Propagation:</b> SGP4 from <a href="https://github.com/shashwatak/satellite-js" target="_blank" rel="noopener">satellite.js</a> 6.0.2. Checked at load against the published verification case from Vallado et al. (2006), "Revisiting Spacetrack Report #3". ${esc((selfTest || runSelfTest()).msg)}</li>
    <li><b>Frames:</b> SGP4 outputs positions in the TEME frame. The globe is turned by Greenwich sidereal time, which ignores precession and polar motion, a small error at this scale.</li>
    <li><b>Object type:</b> names containing R/B count as rocket bodies, names with DEB and the debris groups count as debris, objects in the active group count as active satellites, and everything else counts as inactive.</li>
    <li><b>Altitudes:</b> the average altitude comes from mean motion (semi-major axis minus Earth’s equatorial radius). Live altitude and sub-point come from the SGP4 position.</li>
    <li><b>Passes and overhead lists:</b> spherical Earth, 10° minimum elevation, no check for sunlight.</li>
    <li><b>3D rendering:</b> <a href="https://threejs.org" target="_blank" rel="noopener">three.js</a> r128. The Earth texture is illustrative and the clouds are decorative.</li></ul>`;
  const rows = [
    ['Object names, catalog numbers, orbital elements', m === 'demo' ? ['sim', 'demo'] : ['real', 'real'], 'From CelesTrak.'],
    ['Positions on the globe, altitude, speed', m === 'demo' ? ['sim', 'demo'] : ['approx', 'approx.'], 'SGP4 from public elements. Typically within a few km when fresh.'],
    ['Counts and statistics', m === 'demo' ? ['sim', 'demo'] : ['real', 'real, subset'], 'Only the groups loaded, not the full catalog.'],
    ['Active / inactive status', m === 'demo' ? ['sim', 'demo'] : ['approx', 'approx.'], 'Based on CelesTrak’s active list and object names.'],
    ['Closest pass between two objects', ['approx', 'approx.'], 'Geometric only, with no uncertainty. Not a collision prediction.'],
    ['Passes over you', ['approx', 'approx.'], 'Elevation above 10°, ignores sunlight.'],
    ['Collision probability or risk score', ['no', 'not implemented'], 'Needs validated conjunction data, which is not loaded.'],
    ['Breakup simulator fragments', ['sim', 'simulated'], 'Two-body physics, no drag. Not real objects.'],
    ['Clouds on the globe', ['sim', 'decorative'], 'Not real weather.'],
  ];
  $('realTbl').innerHTML = '<tr><th>Feature</th><th>Status</th><th>Notes</th></tr>' + rows.map(([f, [c, l], n]) => `<tr><td>${f}</td><td><span class="tag ${c}">${l}</span></td><td>${n}</td></tr>`).join('');
}

// ───────────────────────── suggestions + intro + tour
function suggestionChips() {
  return FEATURED.filter(f => featured[f.key] != null).map(f => `<button class="btn sm" data-j="${featured[f.key]}" title="${esc(f.why)}">${esc(f.label)}</button>`).join('') || '<span class="note">None of the suggested objects are in the loaded data.</span>';
}
function renderSuggestions() { $('sugg').innerHTML = suggestionChips(); }
let introShown = false;
function openIntro() {
  introShown = true;
  $('introData').innerHTML = data.mode === 'demo' ? `<span class="tag sim">demo</span> Live data is not available here, so you are seeing demo data. ${esc(data.note || '')}` : data.mode === 'snapshot' ? `<span class="tag approx">snapshot</span> ${fmtN(N)} objects from a CelesTrak snapshot dated ${utc(data.fetchedAt)}, with positions calculated in your browser.` : data.mode === 'stale' ? `<span class="tag approx">stale</span> ${fmtN(N)} objects from CelesTrak, last updated ${utc(data.fetchedAt)}. Fresh data could not be loaded, so positions are less certain.` : `<span class="tag real">${data.mode === 'hosted' ? 'server copy' : data.mode}</span> ${fmtN(N)} objects loaded from CelesTrak, with positions calculated in your browser.`;
  $('introSugg').innerHTML = suggestionChips();
  openOverlay('intro');
}
function openOverlay(id) { const el = $(id); el.hidden = false; lastFocus = document.activeElement; const f = el.querySelector('button'); if (f) f.focus(); }
function closeOverlay(id) { $(id).hidden = true; if (id === 'intro') store.set(INTRO_KEY, '1'); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
let lastFocus = null;

let tourI = -1;
const TOUR = [
  { t: 'Welcome to OrbitWatch', run() { resetView(true); setSpeed(60); }, txt: () => `Each dot is a tracked object. ${data.mode === 'demo' ? 'This is demo data, so the dots are simulated.' : `${fmtN(N)} objects are loaded from CelesTrak, and each position is calculated with the SGP4 orbit model.`} Time runs 60× faster so you can see them move. Drag to rotate and scroll or pinch to zoom.` },
  { t: 'Meet the International Space Station', need: () => featured.iss != null, run() { select(featured.iss); setFollow(true); dist = clamp(fitDist() * 0.75, 2, 16); openTab('obj'); },
    txt: () => { const o = objs[featured.iss]; return `The camera is following the ISS. It orbits about ${fmtN(Math.round(o.meanAlt))} km up and goes around Earth every ${o.period.toFixed(0)} minutes, which is about ${(1440 / o.period).toFixed(1)} times a day.`; } },
  { t: 'How to inspect a satellite', need: () => sel >= 0, run() { openTab('obj'); flash('p-obj'); }, txt: () => `The Object panel shows its catalog number (its ID in the public catalog), live altitude and speed, and inclination, the tilt of the orbit against the equator. Elements epoch shows when the orbit was last measured: the older it is, the less certain the position.` },
  { t: 'The most crowded orbits', need: () => hist && N, run() { setFollow(false); let pk = 0; const tt = b => b.active + b.inactive + b.rocket + b.debris; hist.bins.forEach((b, i) => { if (tt(b) > tt(hist.bins[pk])) pk = i; }); this.pk = pk; setBand(pk); dist = fitDist(); openTab('sta'); flash('hist'); },
    txt() { const b = hist.bins[this.pk || 0]; return `The globe now shows only objects averaging ${(this.pk || 0) * 50}–${(this.pk || 0) * 50 + 50} km up: ${fmtN(b.active + b.inactive + b.rocket + b.debris)} of them in one thin shell. The chart shows how low orbit is shared out. Click any bar to filter.`; } },
  { t: 'A debris cloud', need: () => featured.fy != null, run() { setBand(-1); for (const t of TYPE_KEYS) typeOn[t] = t === 'debris'; computeVisibility(); renderLayers(); select(featured.fy); dist = fitDist() * 1.1; },
    txt: () => { const n = objs.slice(0, N).filter(o => o.groups.includes('fengyun-1c-debris')).length; return data.mode === 'demo' ? 'Only debris is shown. In 2007 an anti-satellite missile test destroyed the Fengyun-1C weather satellite at about 865 km. The orange cloud here is a demo version of its debris.' : `Only debris is shown. In 2007 an anti-satellite missile test destroyed the Fengyun-1C weather satellite at about 865 km. ${n ? fmtN(n) + ' of its fragments are in this data, still orbiting.' : ''} Each one is a hazard for decades.`; } },
  { t: 'Higher orbits: navigation and weather', need: () => featured.gps != null || featured.goes != null, run() { for (const t of TYPE_KEYS) typeOn[t] = true; computeVisibility(); renderLayers(); select(featured.gps != null ? featured.gps : featured.goes); dist = 12; },
    txt: () => 'Zoomed out to medium Earth orbit. GPS satellites circle about 20,200 km up, twice a day. Further out, the ring at 35,786 km is the geostationary belt, where weather and TV satellites keep pace with Earth’s spin.' },
  { t: 'Your turn', run() { resetView(true); setTimeout(() => $('q').focus(), 50); }, txt: () => 'Search for any satellite by name or catalog number, or click a dot. Try the Safety tab to compare two objects, or Your sky to see what is above you. Learn explains the science and the data.' },
];
function flash(id) { const el = $(id); if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
function tourGo(i) {
  const steps = TOUR.map((s, k) => k).filter(k => !TOUR[k].need || TOUR[k].need());
  if (i < 0 || i >= TOUR.length) return endTour();
  if (!steps.includes(i)) { const next = steps.find(k => k > i); return next == null ? endTour() : tourGo(next); }
  tourI = i; const s = TOUR[i];
  try { s.run(); } catch (e) { console.warn('tour step', e); }
  $('tour').hidden = false;
  $('tourSteps').innerHTML = steps.map(k => `<i class="${k <= i ? 'on' : ''}"></i>`).join('');
  $('tourH').textContent = s.t; $('tourTxt').textContent = s.txt.call(s);
  $('tPrev').disabled = steps[0] === i; $('tNext').textContent = steps[steps.length - 1] === i ? 'Finish' : 'Next';
}
function tourStep(d) { const steps = TOUR.map((s, k) => k).filter(k => !TOUR[k].need || TOUR[k].need()); const p = steps.indexOf(tourI) + d; if (p >= steps.length) return endTour(); tourGo(steps[Math.max(0, p)]); }
function endTour() { tourI = -1; $('tour').hidden = true; }

// ───────────────────────── search
let qItems = [], qSel = -1;
function runSearch() {
  const raw = $('q').value.trim(), box = $('qres');
  if (!raw) { box.hidden = true; $('q').setAttribute('aria-expanded', 'false'); return; }
  const q = raw.toUpperCase(), digits = /^\d{1,9}$/.test(raw), real = objs.slice(0, N + simCount);
  let res = [];
  if (digits) { const o = real.find(o => o.id === +raw); if (o) res = [o]; }
  if (!res.length) {
    for (const o of real) { const k = o.nameU.indexOf(q); if (k >= 0 || (o.intl && o.intl.toUpperCase().startsWith(q))) res.push({ o, k: k < 0 ? 99 : k }); }
    res = res.sort((a, b) => a.k - b.k || a.o.name.length - b.o.name.length).slice(0, 8).map(r => r.o);
  }
  qItems = res; qSel = res.length ? 0 : -1;
  if (!res.length) {
    box.innerHTML = `<li class="empty" role="option" aria-disabled="true">${digits ? `Catalog number ${esc(raw)} is not in the ${fmtN(N)} loaded objects. It may have re-entered, be classified, or belong to a group OrbitWatch does not load.` : `No loaded object matches "${esc(raw)}". Try a shorter name, such as ISS, STARLINK or NOAA.`}</li>`;
  } else box.innerHTML = res.map((o, k) => `<li role="option" id="qo${k}" aria-selected="${k === qSel}" data-j="${o.i}"><span>${esc(o.name)}</span><small>${o.cat === 'demo' ? TYPES[o.type].one : '#' + o.id + ' · ' + TYPES[o.type].one}</small></li>`).join('');
  box.hidden = false; $('q').setAttribute('aria-expanded', 'true');
}
function pickSearch(k) { const o = qItems[k]; if (!o) return; $('qres').hidden = true; $('q').value = o.name; $('q').blur(); select(o.i); openTab('obj'); flyTo(o.i); }
function flyTo(i) {
  if (!glOK) return; const k = i * 3, x = pos[k], y = pos[k + 1], z = pos[k + 2], r = Math.hypot(x, y, z) || 1;
  az = Math.atan2(x, z); el = Math.asin(clamp(y / r, -1, 1)); target[0] = target[1] = target[2] = 0; dist = Math.max(fitDist() * 0.85, r + 1.6);
}

// ───────────────────────── tabs
let activeTab = 'obj';
function openTab(t) {
  activeTab = t;
  for (const k of ['obj', 'lay', 'sta', 'saf', 'sky']) { $('t-' + k).setAttribute('aria-selected', k === t); $('p-' + k).hidden = k !== t; }
  if (t === 'sta') requestAnimationFrame(drawHist);
  if (t === 'sky') { renderSky(); drawGroundTrack(); }
  if (t === 'saf') renderCompare();
}

// ───────────────────────── reset
function resetView(keepTour) {
  az = 0.6; el = 0.35; target[0] = target[1] = target[2] = 0; dist = fitDist(); setFollow(false);
  for (const t of TYPE_KEYS) typeOn[t] = true; for (const k in regOn) regOn[k] = true;
  band = null; $('bandChip').style.display = 'none'; computeVisibility(); renderLayers(); drawHist();
  setSpeed(60); jumpNow();
  if (!keepTour) endTour();
}

// ───────────────────────── loading UI
let skipTimer = 0;
function showLoading(on) {
  $('loading').hidden = !on;
  if (on) { setLoading('Starting…', 0.02); $('ldSkip').hidden = true; clearTimeout(skipTimer); skipTimer = setTimeout(() => $('ldSkip').hidden = false, 4000); }
  else clearTimeout(skipTimer);
}
function setLoading(txt, f) { $('ldText').textContent = txt; $('ldBar').style.width = Math.round(f * 100) + '%'; }

// ───────────────────────── main loop
let acc = 0, slowAcc = 0;
function frameBody(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1); lastFrame = now;
  simMs += dt * 1000 * speed; acc += dt; slowAcc += dt;
  const pf0 = performance.now();
  if (N) stepPositions(simMs);
  const g = gmstAt(simMs);
  if (glOK) {
    earth.rotation.y = g; clouds.rotation.y = g * 1.02 + 0.4;
    if (N) writeBuffers();
    if (follow && sel >= 0 && !bad[sel]) {
      const k = sel * 3, x = pos[k], y = pos[k + 1], z = pos[k + 2], r = Math.hypot(x, y, z);
      const ta = Math.atan2(x, z), te = Math.asin(clamp(y / r, -1, 1)), d = ((ta - az + Math.PI) % TAU + TAU) % TAU - Math.PI, f = reduceMotion ? 1 : 0.08;
      az += d * f; el += (te - el) * f;
    }
    camUpdate(); cam.updateMatrixWorld();
    placeMarker($('ring'), sel, sel >= 0 ? objs[sel].name : '');
    placeMarker($('mkA'), cmpA, 'A'); placeMarker($('mkB'), cmpB, 'B');
    if (cmpA >= 0 && cmpB >= 0 && cmpA !== cmpB && !bad[cmpA] && !bad[cmpB]) { const a = linkAB.geometry.attributes.position; a.array.set(pos.subarray(cmpA * 3, cmpA * 3 + 3), 0); a.array.set(pos.subarray(cmpB * 3, cmpB * 3 + 3), 3); a.needsUpdate = true; linkAB.computeLineDistances(); linkAB.visible = true; } else linkAB.visible = false;
    placeHighlights();
    if (now - orbitT > 2000 && sel >= 0) { orbitT = now; setLine(orbitSel, orbitPoints(objs[sel], simMs)); if (cmpA >= 0 || cmpB >= 0) updateCompareScene(); }
    const pf1 = performance.now(); rd.render(sc, cam); prof.js = prof.js * 0.95 + (pf1 - pf0) * 0.05; prof.gl = prof.gl * 0.95 + (performance.now() - pf1) * 0.05;
  }
  if (acc > 0.5) {
    acc = 0;
    const live = speed === 1 && Math.abs(simMs - Date.now()) < 5000, tm = $('tmode');
    tm.className = speed === 0 ? 'paused' : live ? 'live' : 'lapse';
    tm.textContent = speed === 0 ? 'PAUSED' : live ? 'LIVE' : `TIME-LAPSE ${speed}×`;
    const off = (simMs - Date.now()) / 60e3;
    const iso = new Date(simMs).toISOString(), narrow = innerWidth <= 720;
    if (narrow) tm.textContent = speed === 0 ? 'PAUSED' : live ? 'LIVE' : `${speed}×`;
    $('clk').textContent = (narrow ? iso.slice(11, 16) : iso.slice(0, 19).replace('T', ' ')) + ' UTC' + (live || Math.abs(off) < 1 ? '' : ` ${off > 0 ? '+' : '−'}${dur(off)}`);
    if (sel >= 0 && activeTab === 'obj') liveSelected(false);
    if (activeTab === 'sky') { renderSky(); drawGroundTrack(); }
    if (cmpA >= 0 && cmpB >= 0 && $('cNow')) { const a = cmpA * 3, b = cmpB * 3; $('cNow').textContent = bad[cmpA] || bad[cmpB] ? 'cannot compute' : fmtN(Math.round(Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]) * RS)) + ' km'; }
  }
  if (slowAcc > 5) { slowAcc = 0; renderBadge(); const bc = $('badCnt'); if (bc) { let n = 0; for (let i = 0; i < N; i++) n += bad[i]; bc.textContent = n ? `${fmtN(n)} objects (likely re-entered)` : 'none'; } if (activeTab === 'saf' && cmpA >= 0 && cmpB >= 0 && cmpResult && Math.abs(cmpResult.from - simMs) > 6 * 3600e3) renderCompare(); }
}
let frameErr = false;
function frame(now) {   // one failing frame must not stop the animation loop
  try { frameBody(now); } catch (e) { if (!frameErr) { frameErr = true; console.error('OrbitWatch frame error:', e); } }
  requestAnimationFrame(frame);
}
const prof = { js: 0, gl: 0 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function placeMarker(el, i, label) {
  if (i < 0 || !objs[i] || bad[i] || !vis[i]) { el.style.display = 'none'; return; }
  const s = screenOf(i); if (!s) { el.style.display = 'none'; return; }
  el.style.display = 'block'; el.style.left = s[0] + 'px'; el.style.top = s[1] + 'px'; if (el.firstChild.textContent !== label) el.firstChild.textContent = label;
  el.classList.toggle('left', s[0] > innerWidth - el.firstChild.offsetWidth - 40);
}
const hlEls = {};
function placeHighlights() {
  const on = $('hlOn').checked;
  for (const f of FEATURED) {
    const i = featured[f.key]; let el = hlEls[f.key];
    if (!el) { el = hlEls[f.key] = document.createElement('button'); el.className = 'hl'; el.textContent = f.label; el.title = f.why; el.onclick = () => { select(featured[f.key]); openTab('obj'); }; $('hls').appendChild(el); }
    if (!on || i == null || i === sel || bad[i] || !vis[i]) { el.style.display = 'none'; continue; }
    const s = screenOf(i); if (!s) { el.style.display = 'none'; continue; }
    el.style.display = 'block'; el.style.left = Math.min(s[0], innerWidth - el.offsetWidth - 12) + 'px'; el.style.top = s[1] + 'px';
  }
}

// ───────────────────────── wire up UI
function wire() {
  renderSpeeds();
  $('spd').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.now !== undefined) { jumpNow(); toast('Jumped to the current time.'); return; } setSpeed(+b.dataset.s); if (+b.dataset.s === 1 && Math.abs(simMs - Date.now()) > 5000) jumpNow(); };
  $('tabs').onclick = e => { const b = e.target.closest('[role=tab]'); if (b) openTab(b.id.slice(2)); };
  $('tabs').onkeydown = e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; const ks = ['obj', 'lay', 'sta', 'saf', 'sky'], i = (ks.indexOf(activeTab) + (e.key === 'ArrowRight' ? 1 : 4)) % 5; openTab(ks[i]); $('t-' + ks[i]).focus(); };
  document.addEventListener('click', e => {
    const j = e.target.closest('[data-j]'); if (j && !j.closest('#qres')) { select(+j.dataset.j); openTab('obj'); if (j.closest('#intro')) { closeOverlay('intro'); flyTo(+j.dataset.j); } else if (j.closest('#sugg')) flyTo(+j.dataset.j); }
    const tl = e.target.closest('[data-tab]'); if (tl) { e.preventDefault(); openTab(tl.dataset.tab); }
    const c = e.target.closest('[data-close]'); if (c) closeOverlay(c.closest('.overlay').id);
    if (!e.target.closest('.search')) $('qres').hidden = true;
  });
  document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeOverlay(o.id); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { const o = [...document.querySelectorAll('.overlay')].find(o => !o.hidden); if (o) closeOverlay(o.id); else if (!$('tour').hidden) endTour(); } });
  $('types').onchange = e => { const t = e.target.dataset.t; if (t) { typeOn[t] = e.target.checked; computeVisibility(); } };
  $('regimes').onchange = e => { const r = e.target.dataset.r; if (r) { regOn[r] = e.target.checked; computeVisibility(); } };
  $('bandClear').onclick = () => setBand(-1);
  $('filtClear').onclick = () => { for (const t of TYPE_KEYS) typeOn[t] = true; for (const k in regOn) regOn[k] = true; band = null; $('bandChip').style.display = 'none'; computeVisibility(); renderLayers(); drawHist(); };
  $('q').addEventListener('input', runSearch);
  $('q').addEventListener('focus', () => { if ($('q').value.trim()) runSearch(); });
  $('q').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!qItems.length) return; qSel = (qSel + (e.key === 'ArrowDown' ? 1 : qItems.length - 1)) % qItems.length; [...$('qres').children].forEach((li, k) => li.setAttribute('aria-selected', k === qSel)); $('q').setAttribute('aria-activedescendant', 'qo' + qSel); }
    else if (e.key === 'Enter') { e.preventDefault(); if (qSel >= 0) pickSearch(qSel); }
    else if (e.key === 'Escape') { $('qres').hidden = true; }
  });
  $('qres').onclick = e => { const li = e.target.closest('li[data-j]'); if (li) pickSearch(qItems.findIndex(o => o.i === +li.dataset.j)); };
  $('bTour').onclick = () => { closeOverlay('intro'); tourGo(0); };
  $('iTour').onclick = () => { closeOverlay('intro'); tourGo(0); };
  $('iClose').onclick = () => closeOverlay('intro');
  $('tNext').onclick = () => tourStep(1); $('tPrev').onclick = () => tourStep(-1); $('tEnd').onclick = endTour;
  $('bLearn').onclick = () => openOverlay('learn');
  $('bMethod').onclick = () => { closeOverlay('sources'); openOverlay('learn'); setTimeout(() => $('l-src').scrollIntoView(), 30); };
  $('badge').onclick = () => { renderSources(); openOverlay('sources'); };
  $('bReset').onclick = () => { resetView(); toast('View reset.'); };
  $('bRefresh').onclick = () => { closeOverlay('sources'); loadData({ force: true }); };
  $('dstatRetry').onclick = () => loadData({ force: true });
  $('dstatInfo').onclick = () => { renderSources(); openOverlay('sources'); };
  $('bDemo').onclick = () => { closeOverlay('sources'); loadData({ demo: data.mode !== 'demo' }); };
  $('bSkip').onclick = () => loadData({ demo: true });
  $('bBoom').onclick = boom; $('bBoomClear').onclick = () => clearSim(false);
  $('hlOn').onchange = () => {};
  $('geo').onclick = () => {
    if (!navigator.geolocation) return toast('Location is not available here. Click the globe instead.');
    navigator.geolocation.getCurrentPosition(p => setObserver(p.coords.latitude, p.coords.longitude, 'from your device'), () => toast('Location was blocked. Click the globe to set it instead.', 4500), { timeout: 8000 });
  };
  const hc = $('hist');
  hc.addEventListener('pointermove', e => { if (!hist) return; const i = histBin(e); if (i !== hist.hover) { hist.hover = i; drawHist(); if (i >= 0) histInfo(i); } });
  hc.addEventListener('pointerleave', () => { if (hist) { hist.hover = -1; drawHist(); } });
  hc.addEventListener('click', e => { const i = histBin(e); if (i >= 0) setBand(i); });
  hc.addEventListener('keydown', e => { if (!hist) return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); hist.focus = clamp((hist.focus < 0 ? 9 : hist.focus) + (e.key === 'ArrowRight' ? 1 : -1), 0, hist.B - 1); drawHist(); histInfo(hist.focus); } else if (e.key === 'Enter' && hist.focus >= 0) setBand(hist.focus); });
  addEventListener('resize', () => { layout(); drawHist(); });
}

// ───────────────────────── boot
runSelfTest();
initScene();
wire();
layout(); dist = fitDist();
if (glOK) initInput();
requestAnimationFrame(t => { lastFrame = t; requestAnimationFrame(frame); });
loadData();
