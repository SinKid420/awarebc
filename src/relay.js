// AwareBC flight relay (by Josh Singer): lets the app read feeds that do not allow web pages to call them directly. Same checks as relay v6.
const ALLOWED_ORIGINS = ['https://sinkid420.github.io'];
const LIMIT_PER_MIN = 60;
const ADSB = /^\/v2\/point\/(-?\d{1,2}(?:\.\d{1,6})?)\/(-?\d{1,3}(?:\.\d{1,6})?)\/(\d{1,3})$/;
const NUM = /^-?\d{1,3}(?:\.\d{1,4})?$/;
const hits = new Map(); // per-visitor counter, kept in memory only
const phoneHits = new Map();
const PHONE_PER_MIN = 15;
function cors(origin) {
return {
'Access-Control-Allow-Origin': origin,
'Access-Control-Allow-Methods': 'GET, OPTIONS',
'Access-Control-Max-Age': '86400',
'Vary': 'Origin',
'X-Content-Type-Options': 'nosniff',
'Referrer-Policy': 'no-referrer'
};
}
function reply(body, status, origin, extra) {
return new Response(body, { status, headers: { ...cors(origin), 'Content-Type': 'text/plain; charset=utf-8', ...(extra || {}) } });
}
function tooMany(ip, map = hits, limit = LIMIT_PER_MIN) {
const win = Math.floor(Date.now() / 60000);
const h = map.get(ip);
if (!h || h.win !== win) { map.set(ip, { win, n: 1 }); }
else if (++h.n > limit) return true;
if (map.size > 5000) map.clear();
return false;
}
function publicUrl(s) {
let u; try { u = new URL(s); } catch (e) { return null; }
if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
const h = u.hostname.toLowerCase();
if (!/^[a-z0-9.-]{3,253}$/.test(h) || !h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':')) return null;
if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa|test|invalid|example)$/.test(h)) return null;
if (/(^|\.)workers\.dev$/.test(h)) return null;
u.hash = '';
return u;
}
async function getPage(u) {
for (let i = 0; i < 4; i++) {
const r = await fetch(u.toString(), { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; singers-flight-tracker/5.0; airport phone lookup)', 'Accept': 'text/html,application/xhtml+xml' }, cf: { cacheTtl: 86400 } });
if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('Location'); const n = loc && publicUrl(new URL(loc, u).toString()); if (!n) return null; u = n; continue; }
if (!r.ok || !/text\/html|xhtml/i.test(r.headers.get('Content-Type') || '')) return null;
const reader = r.body.getReader(); let got = 0, parts = [];
while (got < 1500000) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; }
try { reader.cancel(); } catch (e) {}
const buf = new Uint8Array(Math.min(got, 1500000)); let o = 0; for (const p of parts) { const take = Math.min(p.length, buf.length - o); buf.set(p.subarray(0, take), o); o += take; if (o >= buf.length) break; }
return { url: u, html: new TextDecoder().decode(buf) };
}
return null;
}
const NANP = /(?:\+?1[\s.\-]?)?\(?\b([2-9]\d{2})\)?[\s.\-]?([2-9]\d{2})[\s.\-]?(\d{4})\b/g;
const INTL = /\+(?!1\b)\d{1,3}[\s.\-]?(?:\(\d{1,4}\)[\s.\-]?)?\d{1,4}(?:[\s.\-]?\d{2,4}){2,4}/g;
function fmtNanp(a, b, c) { return '(' + a + ') ' + b + '-' + c; }
function findPhones(html) {
const score = new Map();
const add = (num, pts) => { if (num) score.set(num, (score.get(num) || 0) + pts); };
for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']{6,40})["']/gi)) {
const raw = decodeURIComponent(m[1].replace(/%(?![0-9a-f]{2})/gi, '')).replace(/[^\d+]/g, '');
const d = raw.replace(/^\+?1(?=\d{10}$)/, '');
if (/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) add(fmtNanp(d.slice(0, 3), d.slice(3, 6), d.slice(6)), 10);
else if (/^\+\d{8,15}$/.test(raw)) add(raw, 8);
}
const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&[nm]dash;/g, '–').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ');
const near = (i) => text.slice(Math.max(0, i - 60), i).toLowerCase();
for (const m of text.matchAll(NANP)) {
const ctx = near(m.index); if (/fax/.test(ctx.slice(-25))) continue;
let pts = 1; if (/phone|tel|call|office|contact|ph\b|main|airport|manager|terminal|admin/.test(ctx)) pts += 4;
add(fmtNanp(m[1], m[2], m[3]), pts);
}
for (const m of text.matchAll(INTL)) {
const ctx = near(m.index); if (/fax/.test(ctx.slice(-25))) continue;
const n = m[0].replace(/[^\d+]/g, ''); if (n.length < 9 || n.length > 16) continue;
let pts = 1; if (/phone|tel|call|office|contact|ph\b|main|airport/.test(ctx)) pts += 4;
add(m[0].trim().replace(/\s+/g, ' '), pts);
}
return [...score.entries()].sort((a, b) => b[1] - a[1]).filter(e => e[1] >= 2).slice(0, 3).map(e => e[0]);
}
async function phoneLookup(site) {
const u = publicUrl(site); if (!u) return { phones: [] };
const p = await getPage(u); if (!p) return { phones: [] };
let phones = findPhones(p.html);
if (!phones.length) {
const base = p.url.hostname.replace(/^www\./, '');
for (const m of p.html.matchAll(/href\s*=\s*["']([^"'#]{1,300})["'][^>]*>([^<]{0,60})/gi)) {
if (!/contact|about|info/i.test(m[1] + ' ' + m[2])) continue;
let c; try { c = publicUrl(new URL(m[1], p.url).toString()); } catch (e) { c = null; }
if (!c || c.hostname.replace(/^www\./, '') !== base) continue;
const q = await getPage(c); if (q) phones = findPhones(q.html);
break;
}
}
return { phones };
}
function route(t) {
if (t.protocol !== 'https:' || t.port || t.username || t.password || t.hash) return null;
if (t.hostname === 'api.adsb.lol') {
const m = ADSB.exec(t.pathname);
if (!m || t.search) return null;
const lat = +m[1], lon = +m[2], r = +m[3];
if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || r < 1 || r > 250) return null;
const qLat = (Math.round(lat * 10) / 10).toFixed(1), qLon = (Math.round(lon * 10) / 10).toFixed(1), qR = Math.min(250, Math.ceil((r + 3) / 25) * 25);
return { url: 'https://api.adsb.lol/v2/point/' + qLat + '/' + qLon + '/' + qR, fresh: 6, stale: 300 };
}
if (t.hostname === 'aviationweather.gov') {
const p = t.searchParams, keys = [...p.keys()].sort().join(',');
if (t.pathname === '/api/data/metar' && keys === 'bbox,format' && p.get('format') === 'json') {
const b = (p.get('bbox') || '').split(',');
if (b.length !== 4 || !b.every(v => NUM.test(v))) return null;
const [a, o, c, d] = b.map(Number);
if (Math.abs(a) > 90 || Math.abs(c) > 90 || Math.abs(o) > 180 || Math.abs(d) > 180 || c <= a || d <= o || c - a > 12 || d - o > 20) return null;
const s = v => (Math.round(v * 2) / 2).toFixed(1), lo = v => (Math.floor(v * 2) / 2).toFixed(1), hi = v => (Math.ceil(v * 2) / 2).toFixed(1);
return { url: 'https://aviationweather.gov/api/data/metar?bbox=' + lo(a) + ',' + lo(o) + ',' + hi(c) + ',' + hi(d) + '&format=json', fresh: 120, stale: 1800 };
}
if (t.pathname === '/api/data/taf' && keys === 'format,ids' && p.get('format') === 'json') {
const ids = (p.get('ids') || '').toUpperCase().split(',');
if (ids.length < 1 || ids.length > 10 || !ids.every(i => /^[A-Z0-9]{3,4}$/.test(i))) return null;
return { url: 'https://aviationweather.gov/api/data/taf?ids=' + ids.join(',') + '&format=json', fresh: 300, stale: 3600 };
}
}
if (t.hostname === 'www.env.gov.bc.ca') {
if (!t.search && /^\/wsd\/data_searches\/snow\/asws\/data\/(SD|TA)\.csv$/.test(t.pathname)) return { url: t.toString(), fresh: 1800, stale: 43200, accept: 'text/csv,*/*' };
return null;
}
if (t.hostname === 'api.gdeltproject.org' && t.pathname === '/api/v2/doc/doc') {
const p = t.searchParams, keys = [...p.keys()].sort().join(',');
if (keys !== 'format,maxrecords,mode,query,sort,timespan') return null;
const q = p.get('query') || '';
if (q.length < 3 || q.length > 300 || /[<>{}\\]/.test(q)) return null;
if (p.get('mode') !== 'artlist' || p.get('format') !== 'json' || p.get('sort') !== 'datedesc') return null;
if (!/^(24h|48h|72h|1w)$/.test(p.get('timespan') || '') || !/^([1-9]|1\d|2[0-5])$/.test(p.get('maxrecords') || '')) return null;
const u = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
['query', 'mode', 'format', 'sort', 'timespan', 'maxrecords'].forEach(k => u.searchParams.set(k, p.get(k)));
return { url: u.toString(), fresh: 900, stale: 21600 };
}
if (t.hostname === 'api.safecast.org' && t.pathname === '/measurements.json') {
const p = t.searchParams, keys = [...p.keys()].sort().join(',');
if (keys !== 'distance,latitude,longitude,order,per_page') return null;
if (!NUM.test(p.get('latitude') || '') || !NUM.test(p.get('longitude') || '')) return null;
const lat = +p.get('latitude'), lon = +p.get('longitude'), d = +p.get('distance'), n = +p.get('per_page');
if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || !(d >= 1000 && d <= 500000) || !(n >= 1 && n <= 50) || p.get('order') !== 'captured_at desc') return null;
const u = new URL('https://api.safecast.org/measurements.json');
u.searchParams.set('latitude', (Math.round(lat * 10) / 10).toFixed(1)); u.searchParams.set('longitude', (Math.round(lon * 10) / 10).toFixed(1));
u.searchParams.set('distance', String(Math.round(d))); u.searchParams.set('per_page', String(Math.round(n))); u.searchParams.set('order', 'captured_at desc');
return { url: u.toString(), fresh: 3600, stale: 86400 };
}
return null;
}
export default {
async fetch(request, env, ctx) {
const origin = request.headers.get('Origin') || '';
const okOrigin = ALLOWED_ORIGINS.includes(origin);
const allowOrigin = okOrigin ? origin : ALLOWED_ORIGINS[0];
if (request.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors(allowOrigin) });
if (request.method !== 'GET') return reply('GET only', 405, allowOrigin);
if (!okOrigin) return reply('Not allowed', 403, allowOrigin);
const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
const q = new URL(request.url).searchParams;
if (q.has('flood')) { // BC River Forecast Centre: flood warnings, watches and high streamflow advisories in effect
if (tooMany(ip, phoneHits, PHONE_PER_MIN)) return reply('Slow down', 429, allowOrigin, { 'Retry-After': '30' });
const key = new Request('https://flood.cache/bc');
let hit = await caches.default.match(key), body;
if (hit) body = await hit.text();
else {
let out = { at: Date.now(), items: [] };
try {
const r = await fetch('https://bcrfc.env.gov.bc.ca/warnings/index.htm', { headers: { 'User-Agent': 'AwareBC/1.0 (flood advisories)', 'Accept': 'text/html' } });
if (r.ok) { const html = (await r.text()).slice(0, 800000), seen = new Set();
for (const m of html.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{3,400}?)<\/a>/gi)) {
const t = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const lv = /flood warning/i.test(t) ? 3 : /flood watch/i.test(t) ? 2 : /high streamflow/i.test(t) ? 1 : 0;
if (!lv || seen.has(t)) continue; seen.add(t);
let u = ''; try { const x = new URL(m[1], 'https://bcrfc.env.gov.bc.ca/warnings/'); if (x.hostname === 'bcrfc.env.gov.bc.ca') u = x.toString(); } catch (e) {}
out.items.push({ level: lv, title: t.slice(0, 300), url: u });
if (out.items.length >= 40) break; } }
} catch (e) {}
body = JSON.stringify(out);
ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' } })));
}
return new Response(body, { status: 200, headers: { ...cors(allowOrigin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
if (q.has('phone')) {
if (tooMany(ip, phoneHits, PHONE_PER_MIN)) return reply('Slow down', 429, allowOrigin, { 'Retry-After': '30' });
const site = publicUrl(q.get('phone') || '');
if (!site) return reply('That request is not allowed', 403, allowOrigin);
const key = new Request('https://phone.cache/' + encodeURIComponent(site.toString()));
let hit = await caches.default.match(key), body;
if (hit) body = await hit.text();
else {
let out = { phones: [] };
try { out = await phoneLookup(site.toString()); } catch (e) {}
body = JSON.stringify(out);
ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800' } })));
}
return new Response(body, { status: 200, headers: { ...cors(allowOrigin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
if (tooMany(ip)) return reply('Slow down', 429, allowOrigin, { 'Retry-After': '20' });
let target;
try { target = new URL(new URL(request.url).searchParams.get('u') || ''); }
catch (e) { return reply('Missing or bad ?u= address', 400, allowOrigin); }
const r = route(target);
if (!r) return reply('That request is not allowed', 403, allowOrigin);
const cache = caches.default, key = new Request(r.url), staleKey = new Request(r.url + (r.url.includes('?') ? '&' : '?') + 'stale=1');
let res = await cache.match(key);
if (!res) {
let upstream = null, body = '';
try {
upstream = await fetch(r.url, { headers: { 'User-Agent': 'singers-flight-tracker-relay/6.0', 'Accept': r.accept || 'application/json' } });
body = await upstream.text();
} catch (e) { upstream = null; }
if (upstream && upstream.ok && body.length < 3000000) {
res = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + r.fresh } });
ctx.waitUntil(cache.put(key, res.clone()));
ctx.waitUntil(cache.put(staleKey, new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + r.stale } })));
} else {
const stale = await cache.match(staleKey);
if (stale) res = stale;
else if (upstream) res = new Response(body.slice(0, 200), { status: upstream.status, headers: { 'Content-Type': 'text/plain' } });
else return reply('Feed unreachable', 502, allowOrigin);
}
}
const out = new Response(res.body, res);
Object.entries(cors(allowOrigin)).forEach(([k, v]) => out.headers.set(k, v));
out.headers.set('Content-Type', 'application/json');
out.headers.set('Cache-Control', 'no-store');
return out;
}
};
