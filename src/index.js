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
async function getIdx(env) { const v = await env.REPORTS.get('idx', 'json'); return Array.isArray(v) ? v : []; }
async function putIdx(env, a) { const old = Date.now() - WEEK, gone = a.filter(r => r.cl && r.cl < old); if (gone.length) { a = a.filter(r => !(r.cl && r.cl < old)); await Promise.all(gone.flatMap(r => ['p:', 't:', 'c:'].map(k => env.REPORTS.delete(k + r.id)))); }
  await env.REPORTS.put('idx', JSON.stringify(a.slice(-MAX))); try { await caches.default.delete(new Request('https://cache.local/idx')); } catch (e) {} }
async function body(req, max) { const t = await req.text(); if (t.length > max) throw new Error('too big'); return JSON.parse(t); }

export default {
  async fetch(req, env, ctx) {
    // flight relay: https://<this server>/?u=<feed address>  (and ?phone=)
    { const q0 = new URL(req.url); if (q0.pathname === '/' && (q0.searchParams.has('u') || q0.searchParams.has('phone'))) return relay.fetch(req, env, ctx); }
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: origin === ORIGIN ? 204 : 403, headers: hdr() });
    if (origin !== ORIGIN && !(req.method === 'GET' && /^\/(photo|thumb)\//.test(new URL(req.url).pathname))) return err('not allowed', 403);
    if (!env.REPORTS && !new URL(req.url).pathname.startsWith('/s/')) return err('server not set up: add the KV binding named REPORTS', 503);
    const url = new URL(req.url), p = url.pathname, ip = req.headers.get('CF-Connecting-IP') || 'x';
    try {
      // list reports in a map box (cached 20 s at the edge)
      if (req.method === 'GET' && p === '/list') {
        const s = num(url.searchParams.get('s'), -90, 90), n = num(url.searchParams.get('n'), -90, 90), w = num(url.searchParams.get('w'), -180, 180), e = num(url.searchParams.get('e'), -180, 180);
        if (s == null || n == null || w == null || e == null) return err('bad box');
        const cache = caches.default, ck = new Request('https://cache.local/idx');
        let a, hit = await cache.match(ck);
        if (hit) a = await hit.json(); else { a = await getIdx(env); ctx.waitUntil(cache.put(ck, new Response(JSON.stringify(a), { headers: { 'Cache-Control': 'max-age=20' } }))); }
        const old = Date.now() - WEEK, cnt = {}; a.forEach(r => { if (r.u && !r.hid) cnt[r.u] = (cnt[r.u] || 0) + 1; });
        return json({ r: a.filter(r => !r.hid && !(r.cl && r.cl < old) && r.lat >= s && r.lat <= n && r.lon >= w && r.lon <= e).map(r => ({ id: r.id, lat: r.lat, lon: r.lon, st: r.st, tg: r.tg, n: r.n, by: r.by, t: r.t, nc: r.nc || 0, ph: !!r.ph, cl: r.cl || 0, cb: r.cb || '', ut: r.ut || '', tr: !!(r.u && cnt[r.u] >= 3), cv: (r.cv || []).length })) }, 200, 'max-age=15');
      }
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
const MSG_DAYS = 30, IDLE_DAYS = 365, FLAG_DAYS = 90, MUTE = 7 * DAY, MAX_FRIENDS = 500, MAX_GROUPS = 50;
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
      CREATE TABLE IF NOT EXISTS flags (u TEXT, by TEXT, ih TEXT, why TEXT, x TEXT, t INTEGER, PRIMARY KEY (u, by));`);
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
  wipe(u) {
    this.sql.exec('DELETE FROM friends WHERE a=? OR b=?', u, u); this.sql.exec('DELETE FROM reads WHERE u=?', u);
    this.sql.exec('DELETE FROM blocks WHERE a=?', u); this.sql.exec('DELETE FROM flags WHERE by=?', u);
    this.sql.exec("DELETE FROM msgs WHERE u=? OR chat LIKE ? OR chat LIKE ?", u, 'd:' + u + ':%', 'd:%:' + u);
    this.q('SELECT g FROM gm WHERE u=?', u).forEach(r => this.leave(r.g, u));
    this.sql.exec('DELETE FROM riders WHERE u=?', u);
  }
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
      this.sql.exec('DELETE FROM flags WHERE t<?', now - FLAG_DAYS * DAY);
      this.sql.exec('UPDATE riders SET share=0, lat=NULL, lon=NULL WHERE share=1 AND ((until>0 AND until<?) OR at<?)', now, now - SPOT_AGE);
      this.sql.exec('UPDATE riders SET mute=0 WHERE mute>0 AND mute<?', now);
      this.q('SELECT u FROM riders WHERE seen<? LIMIT 500', now - IDLE_DAYS * DAY).forEach(r => this.wipe(r.u));
    } finally { await this.state.storage.setAlarm(now + DAY); }
  }
  async fetch(req) {
    if (new URL(req.url).pathname === '/_lim') { // only the worker above can reach this (public requests to the Hub must start with /s/)
      let q = {}; try { q = await req.json(); } catch (e) {}
      const x = this.lim('L' + String(q.k || '').slice(0, 90), +q.max || 1, HOUR) || this.lim('LG' + String(q.g || ''), +q.gmax || 1000, DAY);
      return new Response(JSON.stringify({ x }));
    }
    const p = new URL(req.url).pathname.slice(3), now = Date.now(), ip = req.headers.get('CF-Connecting-IP') || 'x';
    let b; try { b = await body(req, 8000); } catch (e) { return err('bad request'); }
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
