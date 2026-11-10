// AwareBC trail reports server (by Josh Singer). Free Cloudflare Worker + one KV namespace bound as REPORTS.
// Stores trail status reports (status, tags, short note, one photo, exact spot) and their comments.
// - Only answers the AwareBC website.  - Reports stay until cleared; cleared reports stay 7 more days, then go.  - Photos arrive already shrunk and cleaned by the app.
// - Limits per visitor: 6 reports, 40 comments, 30 clears an hour.  - 3 "report this" flags hide a post.  - Posters can delete their own.
// - Rider tags: each phone keeps a secret key; the server keeps only its fingerprint and shows a short tag (e.g. Boss #4K7Q) that can't be copied.
// - Danger reports (Caution / Blocked) need the poster, or 2 different riders, to clear them.  - 3+ reports earns a "trusted" tick.
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
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: origin === ORIGIN ? 204 : 403, headers: hdr() });
    if (origin !== ORIGIN && !(req.method === 'GET' && /^\/(photo|thumb)\//.test(new URL(req.url).pathname))) return err('not allowed', 403);
    if (!env.REPORTS) return err('server not set up: add the KV binding named REPORTS', 503);
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
        if (limited(ip, 'r', 6)) return err('Too many reports this hour. Try again later.', 429);
        const b = await body(req, 700000), me = await rider(b);
        if (me && limited(me.u, 'r', 6)) return err('Too many reports this hour. Try again later.', 429);
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
          if (limited(ip, 'c', 40)) return err('Too many comments this hour.', 429);
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
        if (limited(ip, 'f', 20)) return err('Too many flags.', 429);
        const a = await getIdx(env), r = a.find(q => q.id === mf[1]); if (!r) return err('not found', 404);
        r.fl = r.fl || []; const who = (await sha(ip)).slice(0, 12); if (!r.fl.includes(who)) r.fl.push(who); if (r.fl.length >= 3) r.hid = true;
        await putIdx(env, a); return json({ ok: true });
      }
      // anyone can mark a report cleared (the problem is gone): it shows as cleared for a week, then goes
      const mx = /^\/clear\/([a-z0-9]{8,20})$/.exec(p);
      if (req.method === 'POST' && mx) {
        if (limited(ip, 'x', 30)) return err('Too many clears this hour.', 429);
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
      return err('not found', 404);
    } catch (e) { return err('bad request'); }
  }
};
