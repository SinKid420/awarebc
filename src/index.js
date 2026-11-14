// AwareBC trail reports server (by Josh Singer). Free Cloudflare Worker + one KV namespace bound as REPORTS.
// Stores trail status reports (status, tags, short note, one photo, exact spot) and their comments.
// - Only answers the AwareBC website.  - Reports stay until cleared; cleared reports stay 7 more days, then go.  - Photos arrive already shrunk and cleaned by the app.
// - Limits per visitor: 6 reports, 40 comments, 30 clears an hour.  - 3 "report this" flags hide a post.  - Posters can delete their own.
// - Rider tags: each phone keeps a secret key; the server keeps only its fingerprint and shows a short tag (e.g. Boss #4K7Q) that can't be copied.
// - Danger reports (Caution / Blocked) need the poster, or 2 different riders, to clear them.  - 3+ reports earns a "trusted" tick.
// - Friends: add by rider tag, see accepted friends' spots (only while they share), chat 1-to-1 and in groups (class Hub below).
import relay from './relay.js'; // flight relay (was the separate skyrelay server)
const ORIGIN = 'https://sinkid420.github.io';
const MAX = 1000; // newest 1000 reports are kept
const WEEK = 7 * 86400000; // cleared reports stay this long
const ST = ['ok', 'warn', 'bad'];
const TAGS = ['snow', 'washout', 'tree', 'mud', 'gate', 'fire', 'wildlife'];
const hits = new Map();
function limited(ip, kind, max) {
  const k = kind + ip, w = Math.floor(Date.now() / 3600000), h = hits.get(k);
  if (!h || h.w !== w) { hits.set(k, { w, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > max;
}
// Limits are counted in one place (the Hub), so they hold across all of Cloudflare's servers, plus a daily cap for the whole app.
const GCAP = { r: 400, c: 2000, f: 600, x: 600 };
async function lim(env, ip, kind, max) {
  if (limited(ip, kind, max)) return true;
  if (!env.HUB) return false;
  try {
    const r = await env.HUB.get(env.HUB.idFromName('hub')).fetch(new Request('https://hub/_lim', { method: 'POST', body: JSON.stringify({ k: kind + ip, max, g: kind, gmax: GCAP[kind] || 1000 }) }));
    return !!(await r.json()).x;
  } catch (e) { return false; }
}
function hdr(extra) {
  return Object.assign({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, extra || {});
}
const json = (o, s, c) => new Response(JSON.stringify(o), { status: s || 200, headers: hdr({ 'Content-Type': 'application/json', 'Cache-Control': c || 'no-store' }) });
const err = (m, s) => json({ error: m }, s || 400);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v, a, b) => { v = +v; return isFinite(v) && v >= a && v <= b ? v : null; };
const rid = () => { const a = new Uint8Array(9); crypto.getRandomValues(a); return [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 14); };
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function b64bytes(s, max) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || '')); if (!m || m[1].length > max * 1.37) return null;
  const bin = atob(m[1]), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u[0] === 0xff && u[1] === 0xd8 ? u : null; // must be a real JPEG
}
const TA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
// rider id from the phone's secret key: fingerprint (kept) + 4-letter tag (shown). The key itself is never stored.
async function rider(b) { const k = clean(b && b.uid, 64); if (k.length < 16) return null; const h = await sha('awarebc-rider:' + k), t = await sha('awarebc-tag:' + k);
  let n = parseInt(t.slice(0, 5), 16), tag = ''; for (let i = 0; i < 4; i++) { tag = TA[n & 31] + tag; n >>= 5; } return { u: h.slice(0, 24), t: tag }; }
// Reports are saved in the Hub's database: Cloudflare's free KV only allows 1,000 saves a day (and 1 a second per key).
// Anything saved before the move is read from KV once and copied over; deleted keys are remembered so old copies never come back.
function store(env) {
  const KV = env.REPORTS, HUB = env.HUB; if (!HUB) return KV;
  const call = (op, k, b) => HUB.get(HUB.idFromName('hub')).fetch(new Request('https://hub/_kv?op=' + op + '&k=' + encodeURIComponent(k), { method: 'POST', body: b == null ? null : b }));
  const as = async (r, type) => { if (type === 'arrayBuffer') return await r.arrayBuffer(); const t = await r.text(); return type === 'json' ? JSON.parse(t) : t; };
  return {
    async get(k, type) {
      const r = await call('get', k); if (r.status === 200) return as(r, type); if (r.status === 410 || !KV) return null;
      const v = await KV.get(k, 'arrayBuffer'); if (v == null) return null; await call('put', k, v); return as(new Response(v), type);
    },
    async put(k, v) { await call('put', k, v); },
    async delete(k) { await call('del', k); }
  };
}
async function getIdx(env) { const v = await env.REPORTS.get('idx', 'json'); return Array.isArray(v) ? v : []; }
async function putIdx(env, a) { const old = Date.now() - WEEK, gone = a.filter(r => r.cl && r.cl < old); if (gone.length) { a = a.filter(r => !(r.cl && r.cl < old)); await Promise.all(gone.flatMap(r => ['p:', 't:', 'c:'].map(k => env.REPORTS.delete(k + r.id)))); }
  await env.REPORTS.put('idx', JSON.stringify(a.slice(-MAX))); try { await caches.default.delete(new Request('https://cache.local/idx')); } catch (e) {} }
async function body(req, max) { const t = await req.text(); if (t.length > max) throw new Error('too big'); return JSON.parse(t); }

// ---------- Google sign-in (optional): an account only lets a rider get their friends, chat and reports back on a new phone ----------
// The app sends Google's sign-in token; it is checked here against Google's public keys. Only a fingerprint of the Google account id is kept,
// never the email or name. The rider key is kept encrypted, and only handed back to the same Google account.
let GKEYS = null, GKT = 0;
function b64u(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
async function gkeys(force) {
  if (GKEYS && !force && Date.now() - GKT < 3600000) return GKEYS;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { cf: { cacheTtl: 3600 } }); const j = await r.json(), k = {};
  for (const x of j.keys || []) if (x.kty === 'RSA' && x.kid) k[x.kid] = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: x.n, e: x.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  GKEYS = k; GKT = Date.now(); return k;
}
export async function gverify(tok, aud, keys) {
  try {
    const p = String(tok || '').split('.'); if (p.length !== 3 || tok.length > 4096) return null;
    const dec = x => JSON.parse(new TextDecoder().decode(b64u(x))), h = dec(p[0]), c = dec(p[1]);
    if (h.alg !== 'RS256') return null; let K = keys[h.kid]; if (!K && !keys._t) { keys = await gkeys(true); K = keys[h.kid]; } if (!K) return null;
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', K, b64u(p[2]), new TextEncoder().encode(p[0] + '.' + p[1]))) return null;
    const now = Date.now() / 1000;
    if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') return null;
    if (!aud || c.aud !== aud || !(c.exp > now - 60) || c.iat > now + 300 || !c.sub) return null;
    return c;
  } catch (e) { return null; }
}
const KEYRX = /^[A-Za-z0-9_-]{16,64}$/;
async function auth(req, env, ip, p) {
  if (req.method !== 'POST') return err('POST only', 405);
  if (!env.GCLIENT) return err('Google sign-in is not set up yet', 503);
  if (await lim(env, ip, 'g', 30)) return err('Too many sign-ins from here. Try again later.', 429);
  const b = await body(req, 6000), hub = q => env.HUB.get(env.HUB.idFromName('hub')).fetch(new Request('https://hub/_acct', { method: 'POST', body: JSON.stringify(q) })).then(r => r.json());
  if (p === '/auth/redeem') { const c = clean(b.code, 40), k = clean(b.uid, 64), n = clean(b.n, 64); if (!c || !KEYRX.test(k) || n.length < 32) return err('bad request'); const r = await hub({ op: 'redeem', code: c, key: k, st: await sha('awarebc-st:' + n) }); return r.error ? err(r.error, 400) : json(r); }
  const c = await gverify(b.cred, env.GCLIENT, await gkeys()); if (!c) return err('Google sign-in could not be checked. Try again.', 401);
  const gh = (await sha('awarebc-g:' + c.sub)).slice(0, 40), first = clean(c.given_name || c.name || '', 24);
  if (p === '/auth/code') { const st = clean(b.st, 64); if (!/^[a-f0-9]{64}$/.test(st)) return err('bad request'); const code = rid() + rid(); await hub({ op: 'code', code, gh, st }); return json({ code, first }); } // for the Android app: sign in happens in the phone's browser
  if (p === '/auth/google') { const k = clean(b.uid, 64); if (!KEYRX.test(k)) return err('bad request'); const r = await hub({ op: 'link', gh, key: k }); return r.error ? err(r.error, 400) : json(Object.assign(r, { first })); }
  return err('not found', 404);
}

export default {
  async fetch(req, env, ctx) {
    if (env.HUB) env = Object.assign({}, env, { REPORTS: store(env) });
    // flight relay: https://<this server>/?u=<feed address>  (and ?phone=)
    { const q0 = new URL(req.url); if (q0.pathname === '/' && (q0.searchParams.has('u') || q0.searchParams.has('phone') || q0.searchParams.has('flood') || q0.searchParams.has('overture') || q0.searchParams.has('rad'))) return relay.fetch(req, env, ctx); }
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: origin === ORIGIN ? 204 : 403, headers: hdr() });
    if (origin !== ORIGIN && !(req.method === 'GET' && /^\/(photo|thumb|rlm)\//.test(new URL(req.url).pathname))) return err('not allowed', 403);
    if (!env.REPORTS && !new URL(req.url).pathname.startsWith('/s/')) return err('server not set up: add the KV binding named REPORTS', 503);
    const url = new URL(req.url), p = url.pathname, ip = req.headers.get('CF-Connecting-IP') || 'x';
    try {
      // list reports in a map box (cached 20 s at the edge)
      if (req.method === 'GET' && p === '/places') { // AwareBC's own places list (businesses people added), read by anyone using the app
        const s = num(url.searchParams.get('s'), -90, 90), n = num(url.searchParams.get('n'), -90, 90), w = num(url.searchParams.get('w'), -180, 180), e = num(url.searchParams.get('e'), -180, 180);
        if (s == null || n == null || w == null || e == null || n - s > 2 || e - w > 3) return err('bad box');
        const r = await env.HUB.get(env.HUB.idFromName('hub')).fetch(new Request('https://hub/_places', { method: 'POST', body: JSON.stringify({ s, n, w, e }) }));
        return json(await r.json(), 200, 'public, max-age=30');
      }
      if (req.method === 'GET' && p === '/list') {
        const s = num(url.searchParams.get('s'), -90, 90), n = num(url.searchParams.get('n'), -90, 90), w = num(url.searchParams.get('w'), -180, 180), e = num(url.searchParams.get('e'), -180, 180);
        if (s == null || n == null || w == null || e == null) return err('bad box');
        const cache = caches.default, ck = new Request('https://cache.local/idx');
        let a, hit = await cache.match(ck);
        if (hit) a = await hit.json(); else { a = await getIdx(env); ctx.waitUntil(cache.put(ck, new Response(JSON.stringify(a), { headers: { 'Cache-Control': 'max-age=20' } }))); }
        const old = Date.now() - WEEK, cnt = {}; a.forEach(r => { if (r.u && !r.hid) cnt[r.u] = (cnt[r.u] || 0) + 1; });
        return json({ r: a.filter(r => !r.hid && !(r.cl && r.cl < old) && r.lat >= s && r.lat <= n && r.lon >= w && r.lon <= e).map(r => ({ id: r.id, lat: r.lat, lon: r.lon, st: r.st, tg: r.tg, n: r.n, by: r.by, t: r.t, nc: r.nc || 0, ph: !!r.ph, cl: r.cl || 0, cb: r.cb || '', ut: r.ut || '', tr: !!(r.u && cnt[r.u] >= 3), cv: (r.cv || []).length })) }, 200, 'max-age=15');
      }
      const mr = /^\/rlm\/([a-z0-9]{16,40})$/.exec(p); // Rig Link photos and voice clips
      if (req.method === 'GET' && mr) { if (!env.HUB) return err('not found', 404); const r = await env.HUB.get(env.HUB.idFromName('hub')).fetch(new Request('https://hub/_rlm?id=' + mr[1]));
        if (r.status !== 200) return new Response('not found', { status: 404, headers: hdr() }); return new Response(r.body, { headers: hdr({ 'Content-Type': r.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'public, max-age=604800, immutable' }) }); }
      const mp = /^\/(photo|thumb)\/([a-z0-9]{8,20})$/.exec(p);
      if (req.method === 'GET' && mp) {
        const v = await env.REPORTS.get((mp[1] === 'photo' ? 'p:' : 't:') + mp[2], 'arrayBuffer');
        if (!v) return new Response('not found', { status: 404, headers: hdr() });
        return new Response(v, { headers: hdr({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800, immutable' }) });
      }
      // new report
      if (req.method === 'POST' && p === '/report') {
        if (await lim(env, ip, 'r', 6)) return err('Too many reports this hour. Try again later.', 429);
        const b = await body(req, 700000), me = await rider(b);
        if (me && await lim(env, me.u, 'r', 6)) return err('Too many reports this hour. Try again later.', 429);
        const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180), st = ST.includes(b.st) ? b.st : null;
        if (lat == null || lon == null || !st) return err('missing spot or status');
        const r = { id: rid(), lat: +lat.toFixed(5), lon: +lon.toFixed(5), st, tg: (Array.isArray(b.tg) ? b.tg : []).filter(t => TAGS.includes(t)).slice(0, 7),
          n: clean(b.note, 200), by: clean(b.by, 24) || 'Trail user', t: Date.now(), nc: 0, f: 0, ph: false, k: await sha(clean(b.key, 64) || rid()), u: me ? me.u : '', ut: me ? me.t : '' };
        const img = b.img ? b64bytes(b.img, 480000) : null, th = b.th ? b64bytes(b.th, 40000) : null;
        if (b.img && !img) return err('photo not accepted');
        if (img) { await env.REPORTS.put('p:' + r.id, img); if (th) await env.REPORTS.put('t:' + r.id, th); r.ph = true; }
        const a = await getIdx(env); a.push(r); await putIdx(env, a);
        return json({ id: r.id, t: r.t, ut: r.ut });
      }
      // comments
      const mc = /^\/c\/([a-z0-9]{8,20})$/.exec(p);
      if (mc) {
        const id = mc[1];
        if (req.method === 'GET') { const c = await env.REPORTS.get('c:' + id, 'json'); return json({ c: (c || []).filter(x => !x.hid).map(x => ({ by: x.by, x: x.x, t: x.t, ut: x.ut || '' })) }); }
        if (req.method === 'POST') {
          if (await lim(env, ip, 'c', 40)) return err('Too many comments this hour.', 429);
          const b = await body(req, 4000), x = clean(b.text, 300), me = await rider(b); if (!x) return err('empty comment');
          const a = await getIdx(env), r = a.find(q => q.id === id); if (!r || r.hid) return err('report not found', 404);
          const c = (await env.REPORTS.get('c:' + id, 'json')) || []; c.push({ by: clean(b.by, 24) || 'Trail user', x, t: Date.now(), u: me ? me.u : '', ut: me ? me.t : '' });
          await env.REPORTS.put('c:' + id, JSON.stringify(c.slice(-100))); r.nc = c.length; await putIdx(env, a);
          return json({ ok: true, nc: r.nc, ut: me ? me.t : '' });
        }
      }
      // flag a report (3 flags hides it)
      const mf = /^\/flag\/([a-z0-9]{8,20})$/.exec(p);
      if (req.method === 'POST' && mf) {
        if (await lim(env, ip, 'f', 20)) return err('Too many flags.', 429);
        const a = await getIdx(env), r = a.find(q => q.id === mf[1]); if (!r) return err('not found', 404);
        r.fl = r.fl || []; const who = (await sha(ip)).slice(0, 12); if (!r.fl.includes(who)) r.fl.push(who); if (r.fl.length >= 3) r.hid = true;
        await putIdx(env, a); return json({ ok: true });
      }
      // anyone can mark a report cleared (the problem is gone): it shows as cleared for a week, then goes
      const mx = /^\/clear\/([a-z0-9]{8,20})$/.exec(p);
      if (req.method === 'POST' && mx) {
        if (await lim(env, ip, 'x', 30)) return err('Too many clears this hour.', 429);
        const a = await getIdx(env), r = a.find(q => q.id === mx[1]); if (!r || r.cl) return err('already cleared', 404);
        let b = {}; try { b = await body(req, 500); } catch (e) {}
        const me = await rider(b), who = me ? me.u : 'ip' + (await sha(ip)).slice(0, 12), own = !!(me && r.u && me.u === r.u);
        // a danger report needs the poster, or 2 different riders, to clear it
        if (!own && r.st !== 'ok') { r.cv = r.cv || []; if (!r.cv.includes(who)) r.cv.push(who); if (r.cv.length < 2) { await putIdx(env, a); return json({ ok: true, need: 1, cv: r.cv.length }); } }
        r.cl = Date.now(); r.cb = (clean(b.by, 24) || 'Trail user') + (me ? ' #' + me.t : ''); await putIdx(env, a);
        return json({ ok: true, cl: r.cl, cb: r.cb });
      }
      // delete your own report (the app keeps a private key for each report you post)
      const md = /^\/del\/([a-z0-9]{8,20})$/.exec(p);
      if (req.method === 'POST' && md) {
        const b = await body(req, 500), a = await getIdx(env), i = a.findIndex(q => q.id === md[1]), me = await rider(b);
        if (i < 0) return err('not found', 404);
        if (a[i].k !== await sha(clean(b.key, 64)) && !(me && a[i].u && a[i].u === me.u)) return err('not your report', 403);
        a.splice(i, 1); await putIdx(env, a); ctx.waitUntil(Promise.all(['p:', 't:', 'c:'].map(k => env.REPORTS.delete(k + md[1]))));
        return json({ ok: true });
      }
      // friends, live spots and chat
      if (p.startsWith('/auth/')) { if (!env.HUB) return err('friends server not set up yet', 503); return await auth(req, env, ip, p); }
      if (req.method === 'POST' && p.startsWith('/s/')) { if (!env.HUB) return err('friends server not set up yet', 503); return env.HUB.get(env.HUB.idFromName('hub')).fetch(req); }
      return err('not found', 404);
    } catch (e) { return err('bad request'); }
  }
};

// ---------- Friends, live spots and chat (one Durable Object with its own small SQL database) ----------
// Only riders who accepted each other see each other's spot, and only while that rider has "Share my spot" on.
// Safety: block, report (3 different riders = chat paused 7 days), unsend, group owner can remove,
// limits per rider AND per network, spot sharing turns itself off, old data is cleaned every day.
const HOUR = 3600000, DAY = 24 * HOUR, ONLINE = 5 * 60000, SPOT_AGE = 6 * HOUR;
const RL_DAYS = 14, MSG_DAYS = 30, IDLE_DAYS = 365, FLAG_DAYS = 90, MUTE = 7 * DAY, MAX_FRIENDS = 500, MAX_GROUPS = 50;
const WHY = ['spam', 'harass', 'scam', 'unsafe', 'other'];
const ID = /^[0-9a-f]{24}$/, GID = /^[a-z0-9]{8,20}$/;
const dmId = (a, b) => 'd:' + [a, b].sort().join(':');
const RESERVED = /\b(admin|moderator|mod|awarebc|support|staff|official)\b/i;
export class Hub {
  constructor(state, env) {
    this.state = state; this.env = env || {}; this.sql = state.storage.sql; this.hits = new Map();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS riders (u TEXT PRIMARY KEY, t TEXT, n TEXT, seen INTEGER, share INTEGER DEFAULT 0, lat REAL, lon REAL, at INTEGER);
      CREATE INDEX IF NOT EXISTS riders_t ON riders(t);
      CREATE TABLE IF NOT EXISTS friends (a TEXT, b TEXT, st TEXT, t INTEGER, PRIMARY KEY (a, b));
      CREATE INDEX IF NOT EXISTS friends_b ON friends(b);
      CREATE TABLE IF NOT EXISTS groups (g TEXT PRIMARY KEY, name TEXT, owner TEXT, t INTEGER);
      CREATE TABLE IF NOT EXISTS gm (g TEXT, u TEXT, PRIMARY KEY (g, u));
      CREATE INDEX IF NOT EXISTS gm_u ON gm(u);
      CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT, u TEXT, n TEXT, tg TEXT, x TEXT, lat REAL, lon REAL, t INTEGER);
      CREATE INDEX IF NOT EXISTS msgs_chat ON msgs(chat, id);
      CREATE TABLE IF NOT EXISTS reads (u TEXT, chat TEXT, last INTEGER, PRIMARY KEY (u, chat));
      CREATE TABLE IF NOT EXISTS blocks (a TEXT, b TEXT, t INTEGER, PRIMARY KEY (a, b));
      CREATE INDEX IF NOT EXISTS blocks_b ON blocks(b);
      CREATE TABLE IF NOT EXISTS flags (u TEXT, by TEXT, ih TEXT, why TEXT, x TEXT, t INTEGER, PRIMARY KEY (u, by));
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB, d INTEGER DEFAULT 0, t INTEGER);
      CREATE TABLE IF NOT EXISTS acct (gh TEXT PRIMARY KEY, u TEXT, enc BLOB, t INTEGER);
      CREATE TABLE IF NOT EXISTS acode2 (c TEXT PRIMARY KEY, gh TEXT, st TEXT, t INTEGER);
      CREATE TABLE IF NOT EXISTS backups (u TEXT PRIMARY KEY, v TEXT, t INTEGER);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB);
      CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, lat REAL, lon REAL, n TEXT, ty TEXT, ad TEXT, ph TEXT, hr TEXT, ws TEXT, u TEXT, by TEXT, t INTEGER, up INTEGER, hid INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS places_ll ON places(lat, lon);
      CREATE TABLE IF NOT EXISTS pflags (id TEXT, by TEXT, t INTEGER, PRIMARY KEY (id, by));
      CREATE TABLE IF NOT EXISTS rlp (id TEXT PRIMARY KEY, t INTEGER, u TEXT, by TEXT, tg TEXT, k TEXT, kind TEXT, lat REAL, lon REAL, x TEXT, el INTEGER, tc REAL, st TEXT, rig TEXT, tags TEXT, parts TEXT, radio TEXT, img TEXT, au TEXT, aud INTEGER, likes INTEGER DEFAULT 0, ver INTEGER DEFAULT 0, nc INTEGER DEFAULT 0, hid INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS rlp_t ON rlp (t);
      CREATE TABLE IF NOT EXISTS rlr (id TEXT, u TEXT, kind TEXT, PRIMARY KEY (id, u, kind));
      CREATE TABLE IF NOT EXISTS rlc (cid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, u TEXT, by TEXT, tg TEXT, x TEXT, q INTEGER, ans INTEGER DEFAULT 0, re INTEGER, t INTEGER);
      CREATE TABLE IF NOT EXISTS rlk (k TEXT PRIMARY KEY, u TEXT, t INTEGER);
      CREATE TABLE IF NOT EXISTS rlg (k TEXT, u TEXT, by TEXT, tg TEXT, rig TEXT, lat REAL, lon REAL, at INTEGER, PRIMARY KEY (k, u));
      CREATE TABLE IF NOT EXISTS rlm (id TEXT PRIMARY KEY, ty TEXT, v BLOB, t INTEGER);`);
    for (const c of ['until INTEGER DEFAULT 0', 'mute INTEGER DEFAULT 0', 'ih TEXT']) try { this.sql.exec('ALTER TABLE riders ADD COLUMN ' + c); } catch (e) {}
    try { state.storage.getAlarm().then(a => { if (!a) state.storage.setAlarm(Date.now() + DAY); }).catch(() => {}); } catch (e) {}
  }
  q(s, ...a) { return this.sql.exec(s, ...a).toArray(); }
  lim(k, max, win) { const w = Math.floor(Date.now() / win), h = this.hits.get(k); if (!h || h.w !== w) { this.hits.set(k, { w, n: 1 }); if (this.hits.size > 20000) this.hits.clear(); return false; } return ++h.n > max; }
  friend(a, b) { return this.q("SELECT 1 FROM friends WHERE a=? AND b=? AND st='f'", a, b).length > 0; }
  blocked(a, b) { return this.q('SELECT 1 FROM blocks WHERE (a=? AND b=?) OR (a=? AND b=?)', a, b, b, a).length > 0; }
  admin(u) { return String(this.env.ADMINS || '').split(/[\s,]+/).includes(u); }
  canChat(me, chat) {
    if (/^d:[0-9a-f]{24}:[0-9a-f]{24}$/.test(chat)) { const [, x, y] = chat.split(':'); const o = x === me ? y : y === me ? x : null; return !!o && this.friend(me, o) && !this.blocked(me, o); }
    if (/^g:[a-z0-9]{8,20}$/.test(chat)) return this.q('SELECT 1 FROM gm WHERE g=? AND u=?', chat.slice(2), me).length > 0;
    return false;
  }
  shares(a, b) { return this.q('SELECT 1 FROM gm x JOIN gm y ON x.g=y.g WHERE x.u=? AND y.u=? LIMIT 1', a, b).length > 0; }
  known(a, b) { return this.q('SELECT 1 FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)', a, b, b, a).length > 0 || this.shares(a, b); }
  unfriend(a, b) { this.sql.exec('DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)', a, b, b, a); }
  async aes() { // this server's own random key for the stored rider keys (made once, never leaves the server)
    if (this._aes) return this._aes; let r = this.q("SELECT v FROM meta WHERE k='aes'")[0];
    if (!r) { const v = crypto.getRandomValues(new Uint8Array(32)); this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('aes', ?)", v); r = this.q("SELECT v FROM meta WHERE k='aes'")[0]; }
    return this._aes = await crypto.subtle.importKey('raw', new Uint8Array(r.v), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  wipe(u) {
    this.sql.exec('DELETE FROM acct WHERE u=?', u); this.sql.exec('DELETE FROM backups WHERE u=?', u);
    this.sql.exec('DELETE FROM friends WHERE a=? OR b=?', u, u); this.sql.exec('DELETE FROM reads WHERE u=?', u);
    this.sql.exec('DELETE FROM blocks WHERE a=?', u); this.sql.exec('DELETE FROM flags WHERE by=?', u);
    this.sql.exec("DELETE FROM msgs WHERE u=? OR chat LIKE ? OR chat LIKE ?", u, 'd:' + u + ':%', 'd:%:' + u);
    this.q('SELECT g FROM gm WHERE u=?', u).forEach(r => this.leave(r.g, u));
    this.q('SELECT id FROM rlp WHERE u=?', u).forEach(r => this.rlDel(r.id)); this.sql.exec('DELETE FROM rlc WHERE u=?', u); this.sql.exec('DELETE FROM rlg WHERE u=?', u); this.sql.exec('DELETE FROM rlr WHERE u=?', u);
    this.sql.exec('DELETE FROM riders WHERE u=?', u);
  }
  rlDel(id) { const r = this.q('SELECT img, au FROM rlp WHERE id=?', id)[0]; if (!r) return; [r.img, r.au, r.img ? r.img + 't' : ''].forEach(m => { if (m) this.sql.exec('DELETE FROM rlm WHERE id=?', m); });
    this.sql.exec('DELETE FROM rlp WHERE id=?', id); this.sql.exec('DELETE FROM rlr WHERE id=?', id); this.sql.exec('DELETE FROM rlc WHERE id=?', id); }
  leave(g, u) {
    this.sql.exec('DELETE FROM gm WHERE g=? AND u=?', g, u);
    const left = this.q('SELECT u FROM gm WHERE g=? LIMIT 1', g);
    if (!left.length) { this.sql.exec('DELETE FROM groups WHERE g=?', g); this.sql.exec('DELETE FROM msgs WHERE chat=?', 'g:' + g); }
    else this.sql.exec('UPDATE groups SET owner=? WHERE g=? AND owner=?', left[0].u, g, u); // owner left: next member takes over
  }
  // every day: old messages, riders gone a year, old reports and ended mutes are cleaned away
  async alarm() {
    const now = Date.now();
    try {
      this.sql.exec('DELETE FROM msgs WHERE t<?', now - MSG_DAYS * DAY);
      { const old = this.q('SELECT id FROM rlp WHERE t<? LIMIT 2000', now - RL_DAYS * DAY).map(r => r.id); old.forEach(id => this.rlDel(id)); }
      this.sql.exec('DELETE FROM rlg WHERE at<?', now - DAY);
      this.sql.exec('DELETE FROM flags WHERE t<?', now - FLAG_DAYS * DAY);
      this.sql.exec('UPDATE riders SET share=0, lat=NULL, lon=NULL WHERE share=1 AND ((until>0 AND until<?) OR at<?)', now, now - SPOT_AGE);
      this.sql.exec('UPDATE riders SET mute=0 WHERE mute>0 AND mute<?', now);
      this.q('SELECT u FROM riders WHERE seen<? LIMIT 500', now - IDLE_DAYS * DAY).forEach(r => this.wipe(r.u));
    } finally { await this.state.storage.setAlarm(now + DAY); }
  }
  async fetch(req) {
    const iu = new URL(req.url);
    if (iu.pathname === '/_rlm') { const r = this.q('SELECT ty, v FROM rlm WHERE id=?', iu.searchParams.get('id') || '')[0]; if (!r) return new Response('no', { status: 404 }); return new Response(new Uint8Array(r.v), { headers: { 'Content-Type': r.ty } }); }
    if (iu.pathname === '/_places') { const q = JSON.parse(await req.text());
      return new Response(JSON.stringify({ p: this.q('SELECT id, lat, lon, n, ty, ad, ph, hr, ws, by, t, up FROM places WHERE hid=0 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 800', q.s, q.n, q.w, q.e) })); }
    if (iu.pathname === '/_acct') { // Google sign-in links, only reachable from the worker above
      const q = JSON.parse(await req.text()), now = Date.now(), J = o => new Response(JSON.stringify(o));
      this.sql.exec('DELETE FROM acode2 WHERE t<?', now - 180000);
      let gh = q.gh;
      if (q.op === 'code') { this.sql.exec('INSERT OR REPLACE INTO acode2 (c, gh, st, t) VALUES (?, ?, ?, ?)', String(q.code), String(gh), String(q.st), now); return J({ ok: true }); }
      if (q.op === 'redeem') { const r = this.q('SELECT gh, st FROM acode2 WHERE c=?', String(q.code))[0]; if (!r) return J({ error: 'Sign-in code expired. Try again.' }); this.sql.exec('DELETE FROM acode2 WHERE c=?', String(q.code));
        if (!q.st || r.st !== q.st) return J({ error: 'This sign-in was not started on this phone.' }); gh = r.gh; } // the code only works on the phone that started the sign-in
      if (q.op === 'link' || q.op === 'redeem') {
        const ak = await this.aes(), row = this.q('SELECT enc FROM acct WHERE gh=?', gh)[0];
        if (row) { const e = new Uint8Array(row.enc), key = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: e.slice(0, 12) }, ak, e.slice(12))); this.sql.exec('UPDATE acct SET t=? WHERE gh=?', now, gh); return J({ key, existing: key !== q.key }); }
        const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ak, new TextEncoder().encode(q.key))), enc = new Uint8Array(12 + ct.length); enc.set(iv); enc.set(ct, 12);
        const me = await rider({ uid: q.key }); this.sql.exec('INSERT INTO acct (gh, u, enc, t) VALUES (?, ?, ?, ?)', gh, me ? me.u : '', enc, now); return J({ key: q.key, existing: false });
      }
      return J({ error: 'bad op' });
    }
    if (iu.pathname === '/_kv') { // trail reports storage, only reachable from the worker above
      const op = iu.searchParams.get('op'), k = String(iu.searchParams.get('k') || '').slice(0, 200), now = Date.now();
      if (op === 'get') { const r = this.q('SELECT v, d FROM kv WHERE k=?', k)[0]; if (!r) return new Response(null, { status: 404 }); if (r.d) return new Response(null, { status: 410 }); return new Response(r.v); }
      if (op === 'put') { const b = new Uint8Array(await req.arrayBuffer()); this.sql.exec('INSERT INTO kv (k, v, d, t) VALUES (?, ?, 0, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, d=0, t=excluded.t', k, b, now); return new Response('ok'); }
      if (op === 'del') { this.sql.exec('INSERT INTO kv (k, v, d, t) VALUES (?, NULL, 1, ?) ON CONFLICT(k) DO UPDATE SET v=NULL, d=1, t=excluded.t', k, now); return new Response('ok'); }
      return new Response(null, { status: 400 });
    }
    if (iu.pathname === '/_lim') { // only the worker above can reach this (public requests to the Hub must start with /s/)
      let q = {}; try { q = await req.json(); } catch (e) {}
      const x = this.lim('L' + String(q.k || '').slice(0, 90), +q.max || 1, HOUR) || this.lim('LG' + String(q.g || ''), +q.gmax || 1000, DAY);
      return new Response(JSON.stringify({ x }));
    }
    const p = new URL(req.url).pathname.slice(3), now = Date.now(), ip = req.headers.get('CF-Connecting-IP') || 'x';
    let b; try { b = await body(req, p === 'backup' ? 70000 : p === 'rl' ? 900000 : 8000); } catch (e) { return err('bad request'); }
    const me = await rider(b); if (!me) return err('rider key missing');
    const U = me.u, ih = (await sha('awarebc-ip:' + ip)).slice(0, 16), isAdmin = this.admin(U);
    let name = clean(b.name, 24) || 'Rider'; if (RESERVED.test(name) && !isAdmin) name = 'Rider';
    if (this.lim('a' + U, 600, HOUR) || this.lim('i' + ih, 3000, HOUR)) return err('Too many requests. Slow down a little.', 429);
    const row = this.q('SELECT mute FROM riders WHERE u=?', U)[0];
    if (!row) { // a brand-new rider: limit how many one network (or everyone) can make, so throw-away riders can't flood people
      if (this.lim('n' + ih, 15, DAY) || this.lim('N', 400, HOUR)) return err('Too many new riders from this network today. Try again tomorrow.', 429);
      this.sql.exec('INSERT INTO riders (u, t, n, seen, ih) VALUES (?, ?, ?, ?, ?)', U, me.t, name, now, ih);
    } else this.sql.exec('UPDATE riders SET t=?, n=?, seen=?, ih=? WHERE u=?', me.t, name, now, ih, U);
    const muted = row && row.mute > now ? row.mute : 0;
    const paused = () => err('Your chat is paused until ' + new Date(muted).toISOString().slice(0, 10) + ' after reports from other riders.', 403);
    const oid = () => { const o = String(b.id || ''); return ID.test(o) && o !== U ? o : null; };
    const gid = () => { const g = String(b.g || ''); return GID.test(g) ? g : null; };
    if (p === 'sync') {
      const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180), hrs = num(b.hours, 0, 24), until = hrs ? now + hrs * HOUR : 0;
      if (b.share === false) this.sql.exec('UPDATE riders SET share=0, lat=NULL, lon=NULL, until=0 WHERE u=?', U);
      else if (b.share === true) {
        if (lat != null && lon != null) this.sql.exec('UPDATE riders SET share=1, lat=?, lon=?, at=? WHERE u=?', +lat.toFixed(5), +lon.toFixed(5), now, U);
        else this.sql.exec('UPDATE riders SET share=1 WHERE u=?', U);
        if (b.hours != null) this.sql.exec('UPDATE riders SET until=? WHERE u=?', until, U);
      }
      this.sql.exec('UPDATE riders SET share=0, lat=NULL, lon=NULL, until=0 WHERE u=? AND until>0 AND until<?', U, now); // timer ran out
      const fr = this.q("SELECT r.u, r.t, r.n, r.seen, r.share, r.lat, r.lon, r.at, r.until FROM friends f JOIN riders r ON r.u=f.b WHERE f.a=? AND f.st='f' ORDER BY r.seen DESC", U)
        .map(r => ({ id: r.u, t: r.t, n: r.n, on: now - r.seen < ONLINE, seen: r.seen, chat: dmId(U, r.u), spot: r.share && r.at && now - r.at < SPOT_AGE && !(r.until > 0 && r.until < now) ? { lat: r.lat, lon: r.lon, at: r.at } : null }));
      const rq = this.q("SELECT r.u, r.t, r.n FROM friends f JOIN riders r ON r.u=f.a WHERE f.b=? AND f.st='p' AND f.a NOT IN (SELECT b FROM blocks WHERE a=?) ORDER BY f.t DESC LIMIT 20", U, U).map(r => ({ id: r.u, t: r.t, n: r.n }));
      const sent = this.q("SELECT r.u, r.t, r.n FROM friends f JOIN riders r ON r.u=f.b WHERE f.a=? AND f.st='p' ORDER BY f.t DESC LIMIT 20", U).map(r => ({ id: r.u, t: r.t, n: r.n }));
      const gr = this.q('SELECT g.g, g.name, g.owner, (SELECT count(*) FROM gm x WHERE x.g=g.g) AS c FROM gm JOIN groups g ON g.g=gm.g WHERE gm.u=? ORDER BY g.t DESC', U).map(g => ({ id: g.g, n: g.name, c: g.c, chat: 'g:' + g.g, own: g.owner === U }));
      const bl = this.q('SELECT r.u, r.t, r.n FROM blocks k JOIN riders r ON r.u=k.b WHERE k.a=? ORDER BY k.t DESC', U).map(r => ({ id: r.u, t: r.t, n: r.n }));
      const chats = fr.map(f => f.chat).concat(gr.map(g => g.chat)), un = {};
      if (chats.length) this.q('SELECT m.chat AS chat, count(*) AS c FROM msgs m LEFT JOIN reads r ON r.u=? AND r.chat=m.chat WHERE m.chat IN (' + chats.map(() => '?').join(',') + ') AND m.u<>? AND m.u NOT IN (SELECT b FROM blocks WHERE a=?) AND m.id>coalesce(r.last, 0) GROUP BY m.chat', U, ...chats, U, U).forEach(r => { un[r.chat] = r.c; });
      const mine = this.q('SELECT share, until FROM riders WHERE u=?', U)[0] || {};
      return json({ me: { t: me.t, n: name, id: U, share: !!mine.share, until: mine.until || 0, muted }, admin: isAdmin || undefined, friends: fr, req: rq, sent, groups: gr, blocked: bl, unread: un, now });
    }
    if (p === 'add') {
      if (muted) return paused();
      if (this.lim('f' + U, 30, HOUR) || this.lim('fi' + ih, 60, HOUR)) return err('Too many friend requests this hour.', 429);
      const t = String(b.tag || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); if (t.length !== 4) return err('Enter a 4-letter rider tag, like 7QHD.');
      let c = this.q('SELECT u, n FROM riders WHERE t=? AND u<>?', t, U);
      if (!c.length) return err('No rider with tag #' + t + ' yet. They need to open AwareBC once.', 404);
      if (c.length > 1) { const nm = clean(b.who, 24).toLowerCase(); c = nm ? c.filter(r => String(r.n).toLowerCase() === nm) : []; if (c.length !== 1) return json({ ask: 'More than one rider has #' + t + '. Type their name too.' }); }
      const o = c[0].u;
      if (this.q('SELECT 1 FROM blocks WHERE a=? AND b=?', U, o).length) return err('You blocked this rider. Unblock them first (Friends ▸ Blocked).');
      if (this.friend(U, o)) return json({ ok: true, msg: 'Already friends.' });
      const sentMsg = { ok: true, msg: 'Request sent to ' + c[0].n + ' #' + t + '.' };
      if (this.q('SELECT 1 FROM blocks WHERE a=? AND b=?', o, U).length) return json(sentMsg); // they blocked you: say nothing
      if (this.q("SELECT count(*) AS c FROM friends WHERE a=? AND st='f'", U)[0].c >= MAX_FRIENDS) return err('You have the most friends allowed (' + MAX_FRIENDS + ').');
      if (this.q("SELECT 1 FROM friends WHERE a=? AND b=? AND st='p'", o, U).length) { this.sql.exec("DELETE FROM friends WHERE a=? AND b=?", o, U); this.sql.exec("INSERT OR REPLACE INTO friends VALUES (?, ?, 'f', ?), (?, ?, 'f', ?)", U, o, now, o, U, now); return json({ ok: true, msg: 'You are now friends with ' + c[0].n + '.' }); }
      if (this.q("SELECT count(*) AS c FROM friends WHERE b=? AND st='p'", o)[0].c >= 50) return json(sentMsg); // their inbox is full: quietly drop
      this.sql.exec("INSERT OR IGNORE INTO friends VALUES (?, ?, 'p', ?)", U, o, now);
      return json(sentMsg);
    }
    if (p === 'answer') {
      const o = oid(); if (!o || !this.q("SELECT 1 FROM friends WHERE a=? AND b=? AND st='p'", o, U).length) return err('No request from that rider.', 404);
      this.sql.exec('DELETE FROM friends WHERE a=? AND b=?', o, U);
      if (b.ok) this.sql.exec("INSERT OR REPLACE INTO friends VALUES (?, ?, 'f', ?), (?, ?, 'f', ?)", U, o, now, o, U, now);
      return json({ ok: true });
    }
    if (p === 'remove') { const o = oid(); if (!o) return err('bad rider'); this.unfriend(U, o); return json({ ok: true }); }
    if (p === 'cancel') { const o = oid(); if (o) this.sql.exec("DELETE FROM friends WHERE a=? AND b=? AND st='p'", U, o); return json({ ok: true }); }
    if (p === 'block') { // they can't add you, message you, or see your spot; their messages are hidden for you
      const o = oid(); if (!o || !this.q('SELECT 1 FROM riders WHERE u=?', o).length) return err('bad rider');
      this.sql.exec('INSERT OR IGNORE INTO blocks VALUES (?, ?, ?)', U, o, now); this.unfriend(U, o); return json({ ok: true });
    }
    if (p === 'unblock') { const o = oid(); if (o) this.sql.exec('DELETE FROM blocks WHERE a=? AND b=?', U, o); return json({ ok: true }); }
    if (p === 'report') { // 3 different riders (on different networks) reporting someone pauses their chat for 7 days
      if (this.lim('r' + U, 20, DAY)) return err('Too many reports today.', 429);
      const o = oid(); if (!o) return err('bad rider');
      const why = WHY.includes(b.why) ? b.why : 'other';
      let x = clean(b.note, 200);
      if (b.mid != null) {
        const m = this.q('SELECT chat, u, x FROM msgs WHERE id=?', +b.mid || 0)[0];
        if (!m || m.u !== o || !this.canChat(U, m.chat)) return err('Message not found.', 404);
        x = (clean(m.x, 300) + (x ? ' | ' + x : '')).slice(0, 400);
      } else if (!this.known(U, o)) return err('You can only report riders you have been in contact with.', 403);
      this.sql.exec('INSERT OR REPLACE INTO flags VALUES (?, ?, ?, ?, ?, ?)', o, U, ih, why, x, now);
      const n = this.q('SELECT count(DISTINCT ih) AS c FROM flags WHERE u=? AND t>?', o, now - 30 * DAY)[0].c;
      if (n >= 3) this.sql.exec('UPDATE riders SET mute=? WHERE u=? AND mute<?', now + MUTE, o, now);
      if (b.block) { this.sql.exec('INSERT OR IGNORE INTO blocks VALUES (?, ?, ?)', U, o, now); this.unfriend(U, o); }
      return json({ ok: true });
    }
    if (p === 'msgs') {
      const chat = String(b.chat || ''); if (!this.canChat(U, chat)) return err('Not your chat.', 403);
      const since = Math.max(0, +b.since || 0), rows = this.q('SELECT id, u, n, tg, x, lat, lon, t FROM msgs WHERE chat=? AND id>? AND u NOT IN (SELECT b FROM blocks WHERE a=?) ORDER BY id DESC LIMIT 100', chat, since, U).reverse();
      const top = this.q('SELECT max(id) AS m FROM msgs WHERE chat=?', chat)[0].m;
      if (top) this.sql.exec('INSERT INTO reads (u, chat, last) VALUES (?, ?, ?) ON CONFLICT(u, chat) DO UPDATE SET last=max(last, excluded.last)', U, chat, top);
      let mem = null, own = false;
      if (chat[0] === 'g' && !since) { own = !!this.q('SELECT 1 FROM groups WHERE g=? AND owner=?', chat.slice(2), U).length;
        mem = this.q('SELECT r.u, r.n, r.t FROM gm JOIN riders r ON r.u=gm.u WHERE gm.g=?', chat.slice(2)).map(r => ({ id: r.u, n: r.n, t: r.t, me: r.u === U, fr: r.u !== U && this.friend(U, r.u) })); }
      // ids of messages still here, so a message its writer unsent disappears for everyone
      const keep = since ? this.q('SELECT id FROM msgs WHERE chat=? ORDER BY id DESC LIMIT 100', chat).map(r => r.id) : null;
      return json({ m: rows.map(r => ({ id: r.id, me: r.u === U, a: r.u === U ? undefined : r.u, n: r.n, tg: r.tg, x: r.x, lat: r.lat, lon: r.lon, t: r.t })), mem, own, keep });
    }
    if (p === 'send') {
      if (muted) return paused();
      const chat = String(b.chat || ''); if (!this.canChat(U, chat)) return err('Not your chat.', 403);
      if (this.lim('m' + U, 60, 10 * 60000) || this.lim('mi' + ih, 150, 10 * 60000)) return err('Too many messages. Wait a few minutes.', 429);
      const x = clean(b.text, 500), lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180); if (!x && lat == null) return err('Empty message.');
      const r = this.q('INSERT INTO msgs (chat, u, n, tg, x, lat, lon, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id', chat, U, name, me.t, x, lat == null ? null : +lat.toFixed(5), lon == null ? null : +lon.toFixed(5), now)[0];
      this.sql.exec('INSERT INTO reads (u, chat, last) VALUES (?, ?, ?) ON CONFLICT(u, chat) DO UPDATE SET last=excluded.last', U, chat, r.id);
      if (r.id % 50 === 0) this.sql.exec('DELETE FROM msgs WHERE chat=? AND id < (SELECT id FROM msgs WHERE chat=? ORDER BY id DESC LIMIT 1 OFFSET 499)', chat, chat);
      return json({ ok: true, id: r.id, t: now });
    }
    if (p === 'unsend') { this.sql.exec('DELETE FROM msgs WHERE id=? AND u=?', +b.mid || 0, U); return json({ ok: true }); }
    if (p === 'gnew') {
      if (muted) return paused();
      if (this.lim('g' + U, 10, HOUR)) return err('Too many new groups this hour.', 429);
      if (this.q('SELECT count(*) AS c FROM gm WHERE u=?', U)[0].c >= MAX_GROUPS) return err('You are in the most groups allowed (' + MAX_GROUPS + '). Leave one first.');
      const gname = clean(b.gname, 30) || 'Riding group', ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))].filter(o => ID.test(o) && this.friend(U, o)).slice(0, 29), g = rid();
      this.sql.exec('INSERT INTO groups VALUES (?, ?, ?, ?)', g, gname, U, now); [U].concat(ids).forEach(o => this.sql.exec('INSERT OR IGNORE INTO gm VALUES (?, ?)', g, o));
      return json({ ok: true, id: g, chat: 'g:' + g });
    }
    if (p === 'gadd') {
      if (muted) return paused();
      const g = gid(), o = oid(); if (!g || !o || !this.q('SELECT 1 FROM gm WHERE g=? AND u=?', g, U).length) return err('Not your group.', 403);
      if (!this.friend(U, o)) return err('You can only add your friends.', 403);
      if (this.q('SELECT count(*) AS c FROM gm WHERE g=?', g)[0].c >= 30) return err('Groups hold up to 30 riders.');
      if (this.q('SELECT count(*) AS c FROM gm WHERE u=?', o)[0].c >= MAX_GROUPS) return err('That rider is in too many groups.');
      this.sql.exec('INSERT OR IGNORE INTO gm VALUES (?, ?)', g, o); return json({ ok: true });
    }
    if (p === 'gkick') { // only the group's owner can remove someone
      const g = gid(), o = oid(); if (!g || !o || !this.q('SELECT 1 FROM groups WHERE g=? AND owner=?', g, U).length) return err('Only the group owner can remove riders.', 403);
      this.sql.exec('DELETE FROM gm WHERE g=? AND u=?', g, o); return json({ ok: true });
    }
    if (p === 'gleave') { const g = gid(); if (g) this.leave(g, U); return json({ ok: true }); }
    if (p === 'place') { // add or fix a place (name and spot needed; phone and address are what matter most)
      const PT = /^[+(\d][\d\s().\-]{5,24}$/, ws = clean(b.ws, 200), ph = clean(b.ph, 30), op = String(b.op || '');
      if (op === 'flag') { const id = clean(b.id, 20), r = this.q('SELECT u FROM places WHERE id=?', id)[0]; if (!r) return err('not found', 404); this.sql.exec('INSERT OR IGNORE INTO pflags (id, by, t) VALUES (?, ?, ?)', id, U, now);
        const nf = this.q('SELECT COUNT(*) AS c FROM pflags WHERE id=?', id)[0].c; if (nf >= 3) this.sql.exec('UPDATE places SET hid=1 WHERE id=?', id); return json({ ok: true }); }
      if (op === 'del') { const id = clean(b.id, 20), r = this.q('SELECT u FROM places WHERE id=?', id)[0]; if (!r) return err('not found', 404); if (r.u !== U && !isAdmin) return err('Only the person who added it can remove it.', 403); this.sql.exec('DELETE FROM places WHERE id=?', id); return json({ ok: true }); }
      const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180), nm = clean(b.n, 80); if (lat == null || lon == null || nm.length < 2) return err('A name and a spot are needed.');
      if (ph && !PT.test(ph)) return err('That phone number doesn\'t look right.'); if (ws && !/^https?:\/\/[^\s"<>]{3,200}$/i.test(ws)) return err('Website must start with https://');
      const by = isAdmin ? 'Josh Singer' : name, f = [nm, clean(b.ty, 40), clean(b.ad, 120), ph, clean(b.hr, 120), ws];
      if (op === 'edit') { const id = clean(b.id, 20), r = this.q('SELECT u FROM places WHERE id=?', id)[0]; if (!r) return err('not found', 404); if (r.u !== U && !isAdmin) return err('Only the person who added it can change it.', 403);
        this.sql.exec('UPDATE places SET lat=?, lon=?, n=?, ty=?, ad=?, ph=?, hr=?, ws=?, up=? WHERE id=?', +lat.toFixed(6), +lon.toFixed(6), ...f, now, id); return json({ ok: true, id }); }
      if (this.lim('pl' + U, isAdmin ? 500 : 20, DAY) || this.lim('pli' + ih, 40, DAY)) return err('That\'s a lot of new places today. Try again tomorrow.', 429);
      const id = rid(); this.sql.exec('INSERT INTO places (id, lat, lon, n, ty, ad, ph, hr, ws, u, by, t, up) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, +lat.toFixed(6), +lon.toFixed(6), ...f, U, by, now, now);
      return json({ ok: true, id, by }); }
    if (p === 'rl') { // ---------- Rig Link: regional off-road feed + key-locked convoys ----------
      const op = String(b.op || ''), KX = /^#?(\d{3})-?([A-Z]{3})$/;
      const keyOf = async v => { const m = KX.exec(String(v || '').toUpperCase().replace(/\s/g, '')); return m ? { txt: '#' + m[1] + '-' + m[2], h: (await sha('awarebc-rl:' + m[1] + m[2])).slice(0, 32) } : null; };
      const key = b.key ? await keyOf(b.key) : null; if (b.key && !key) return err('Keys look like #884-BCR');
      if (key && op !== 'mkkey' && !this.q('SELECT 1 FROM rlk WHERE k=?', key.h).length) { if (this.lim('rk' + ih, 30, HOUR)) return err('Too many tries. Wait an hour.', 429); return err('No convoy with that key.', 404); }
      const kh = key ? key.h : '';
      const post = id => { const r = this.q('SELECT * FROM rlp WHERE id=? AND hid=0', clean(id, 20))[0]; return r && r.k === kh ? r : null; };
      const media = (d, max, rx) => { const m = rx.exec(String(d || '')); if (!m || m[2].length > max * 1.37) return null; const bin = atob(m[2]), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return { ty: m[1], v: u }; };
      const JP = /^data:(image\/jpeg);base64,([A-Za-z0-9+/=]+)$/, AU = /^data:(audio\/(?:webm|ogg|mp4|aac|mpeg)(?:;codecs=[a-z0-9.]+)?);base64,([A-Za-z0-9+/=]+)$/;
      const out = r => { const mine = this.q('SELECT kind FROM rlr WHERE id=? AND u=?', r.id, U).map(x => x.kind);
        const cm = this.q('SELECT cid, by, tg, x, q, ans, t FROM rlc WHERE id=? ORDER BY (q=1 AND ans=0) DESC, cid DESC LIMIT 2', r.id);
        return { id: r.id, t: r.t, by: r.by, tg: r.tg, kind: r.kind, lat: r.lat, lon: r.lon, x: r.x, el: r.el, tc: r.tc, st: r.st, rig: r.rig, tags: JSON.parse(r.tags || '[]'), parts: r.parts || '', radio: r.radio || '',
          img: r.img || '', au: r.au || '', aud: r.aud || 0, likes: r.likes, ver: r.ver, nc: r.nc, me: r.u === U, liked: mine.includes('l'), verd: mine.includes('v'), cm }; };
      if (op === 'mkkey') { if (this.lim('mk' + U, 10, DAY)) return err('That\'s a lot of keys today.', 429); const L3 = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        for (let i = 0; i < 20; i++) { const a = crypto.getRandomValues(new Uint8Array(6)), txt = String(100 + a[0] * 4 % 900).padStart(3, '0') + L3[a[1] % 24] + L3[a[2] % 24] + L3[a[3] % 24], k = await keyOf(txt);
          if (!this.q('SELECT 1 FROM rlk WHERE k=?', k.h).length) { this.sql.exec('INSERT INTO rlk (k, u, t) VALUES (?, ?, ?)', k.h, U, now); return json({ key: k.txt }); } } return err('Try again'); }
      if (op === 'join') return json({ ok: true, key: key ? key.txt : '' });
      if (op === 'feed') { const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180); if (lat == null || lon == null) return err('No spot');
        if (b.here) this.sql.exec('INSERT OR REPLACE INTO rlg (k, u, by, tg, rig, lat, lon, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', kh, U, name, me.t, clean(b.rig, 40), key && b.share ? +lat.toFixed(5) : +lat.toFixed(2), key && b.share ? +lon.toFixed(5) : +lon.toFixed(2), b.share || !key ? now : now);
        const box = [lat - 1.2, lat + 1.2, lon - 2, lon + 2], K = ['c', 'r', 'h'].includes(b.f) ? b.f : '';
        const ps = this.q('SELECT * FROM rlp WHERE k=? AND hid=0 AND t>? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?' + (K ? ' AND kind=?' : '') + ' ORDER BY t DESC LIMIT 60', kh, now - RL_DAYS * DAY, ...box, ...(K ? [K] : []));
        const rigs = this.q('SELECT u, by, tg, rig, lat, lon, at FROM rlg WHERE k=? AND at>? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?', kh, now - 30 * 60000, ...box);
        return json({ p: ps.map(out), n: rigs.length, rigs: key ? rigs.filter(r => r.u !== U).map(r => ({ by: r.by, tg: r.tg, rig: r.rig, lat: r.lat, lon: r.lon, at: r.at })) : [], key: key ? key.txt : '' }); }
      if (op === 'post') { if (muted) return paused(); if (this.lim('rp' + U, isAdmin ? 300 : 25, DAY) || this.lim('rpi' + ih, 60, DAY)) return err('That\'s a lot of posts today. Try again tomorrow.', 429);
        const kind = ['c', 'r', 'h'].includes(b.kind) ? b.kind : null, lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180); if (!kind || lat == null || lon == null) return err('Missing spot');
        const x = clean(b.x, 500), hide = !!b.hide, id = rid(); let img = '', au = '';
        if (b.img) { const m = media(b.img, 320000, JP); if (!m || m.v[0] !== 0xff || m.v[1] !== 0xd8) return err('Photo not accepted'); img = rid() + rid(); this.sql.exec('INSERT INTO rlm (id, ty, v, t) VALUES (?, ?, ?, ?)', img, m.ty, m.v, now);
          const th = b.th ? media(b.th, 40000, JP) : null; if (th) this.sql.exec('INSERT INTO rlm (id, ty, v, t) VALUES (?, ?, ?, ?)', img + 't', th.ty, th.v, now); }
        if (b.au) { const m = media(b.au, 260000, AU); if (!m) return err('Voice clip not accepted'); au = rid() + rid(); this.sql.exec('INSERT INTO rlm (id, ty, v, t) VALUES (?, ?, ?, ?)', au, m.ty.split(';')[0], m.v, now); }
        if (!x && !img && !au && !clean(b.st, 20) && !(kind === 'r' && clean(b.rig, 40))) return err('Add a photo, a voice clip or some words.');
        const tags = (Array.isArray(b.tags) ? b.tags : []).map(t => clean(t, 24)).filter(Boolean).slice(0, 8);
        this.sql.exec('INSERT INTO rlp (id, t, u, by, tg, k, kind, lat, lon, x, el, tc, st, rig, tags, parts, radio, img, au, aud) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, now, U, isAdmin ? 'Josh Singer' : name, me.t, kh, kind, hide ? +lat.toFixed(2) : +lat.toFixed(5), hide ? +lon.toFixed(2) : +lon.toFixed(5), x, num(b.el, -500, 9000) != null ? Math.round(b.el) : null, num(b.tc, -60, 60),
          clean(b.st, 20), clean(b.rig, 40), JSON.stringify(tags), clean(b.parts, 1200), clean(b.radio, 40), img, au, num(b.aud, 0, 60) || 0);
        return json({ ok: true, p: out(this.q('SELECT * FROM rlp WHERE id=?', id)[0]) }); }
      const r = post(b.id); if (!r) return err('Post not found', 404);
      if (op === 'like' || op === 'verify') { const kd = op === 'like' ? 'l' : 'v', col = op === 'like' ? 'likes' : 'ver', has = this.q('SELECT 1 FROM rlr WHERE id=? AND u=? AND kind=?', r.id, U, kd).length;
        if (has && kd === 'l') this.sql.exec('DELETE FROM rlr WHERE id=? AND u=? AND kind=?', r.id, U, kd); else if (!has) this.sql.exec('INSERT INTO rlr (id, u, kind) VALUES (?, ?, ?)', r.id, U, kd);
        const c = this.q('SELECT count(*) AS c FROM rlr WHERE id=? AND kind=?', r.id, kd)[0].c; this.sql.exec('UPDATE rlp SET ' + col + '=? WHERE id=?', c, r.id); return json({ ok: true, c, on: !(has && kd === 'l') }); }
      if (op === 'flag') { this.sql.exec('INSERT OR IGNORE INTO rlr (id, u, kind) VALUES (?, ?, ?)', r.id, U, 'f'); if (this.q("SELECT count(*) AS c FROM rlr WHERE id=? AND kind='f'", r.id)[0].c >= 3) this.sql.exec('UPDATE rlp SET hid=1 WHERE id=?', r.id); return json({ ok: true }); }
      if (op === 'del') { if (r.u !== U && !isAdmin) return err('Only the poster can delete it.', 403); this.rlDel(r.id); return json({ ok: true }); }
      if (op === 'cmts') return json({ c: this.q('SELECT cid, by, tg, x, q, ans, re, t, u=? AS me FROM rlc WHERE id=? ORDER BY (q=1 AND ans=0) DESC, cid ASC LIMIT 100', U, r.id) });
      if (op === 'cmt') { if (muted) return paused(); if (this.lim('rc' + U, 120, DAY)) return err('Too many comments today.', 429); const x = clean(b.x, 300); if (!x) return err('Empty comment');
        const re = num(b.re, 1, 1e12); this.sql.exec('INSERT INTO rlc (id, u, by, tg, x, q, re, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.id, U, isAdmin ? 'Josh Singer' : name, me.t, x, b.q ? 1 : 0, re, now);
        if (re) this.sql.exec('UPDATE rlc SET ans=1 WHERE cid=? AND id=?', re, r.id);
        const nc = this.q('SELECT count(*) AS c FROM rlc WHERE id=?', r.id)[0].c; this.sql.exec('UPDATE rlp SET nc=? WHERE id=?', nc, r.id); return json({ ok: true, nc }); }
      return err('bad op'); }
    if (p === 'myplaces') return json({ ids: this.q('SELECT id FROM places WHERE u=?', U).map(r => r.id), admin: isAdmin });
    if (p === 'backup') { // settings backup for signed-in riders (home pin, map choices), max 60 KB
      if (b.op === 'put') { const v = String(b.v || ''); if (v.length > 60000) return err('backup too big'); try { JSON.parse(v); } catch (e) { return err('bad backup'); } this.sql.exec('INSERT OR REPLACE INTO backups (u, v, t) VALUES (?, ?, ?)', U, v, now); return json({ ok: true, t: now }); }
      const r = this.q('SELECT v, t FROM backups WHERE u=?', U)[0]; return json(r ? { v: r.v, t: r.t } : { v: null }); }
    if (p === 'wipe') { this.wipe(U); return json({ ok: true }); } // delete everything about this rider from the friends server
    if (p === 'mod') { // moderators only (their rider IDs are listed in ADMINS)
      if (!isAdmin) return err('not found', 404);
      if (b.op === 'list') {
        const r = this.q('SELECT f.u, r.n, r.t, r.mute, count(DISTINCT f.ih) AS c, max(f.t) AS last FROM flags f LEFT JOIN riders r ON r.u=f.u GROUP BY f.u ORDER BY last DESC LIMIT 50')
          .map(x => ({ id: x.u, n: x.n, t: x.t, mute: x.mute || 0, c: x.c, last: x.last, why: this.q('SELECT why, x, t FROM flags WHERE u=? ORDER BY t DESC LIMIT 5', x.u) }));
        const st = { riders: this.q('SELECT count(*) AS c FROM riders')[0].c, week: this.q('SELECT count(*) AS c FROM riders WHERE seen>?', now - 7 * DAY)[0].c, msgs: this.q('SELECT count(*) AS c FROM msgs WHERE t>?', now - DAY)[0].c };
        return json({ flags: r, st });
      }
      const o = String(b.id || ''); if (!ID.test(o)) return err('bad rider');
      if (b.op === 'mute') this.sql.exec('UPDATE riders SET mute=? WHERE u=?', now + (num(b.days, 1, 3650) || 7) * DAY, o);
      else if (b.op === 'unmute') this.sql.exec('UPDATE riders SET mute=0 WHERE u=?', o);
      else if (b.op === 'clear') this.sql.exec('DELETE FROM flags WHERE u=?', o);
      else if (b.op === 'wipe') this.wipe(o);
      else return err('bad op');
      return json({ ok: true });
    }
    return err('not found', 404);
  }
}
