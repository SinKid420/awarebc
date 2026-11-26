// AwareBC push alerts (by Josh Singer): standard Web Push (RFC 8030 / 8291 / 8292), no paid service.
// The server makes its own VAPID key pair once and keeps it in its database. Each alert is encrypted for that one phone.
const te = new TextEncoder();
export function b64u(u) { u = new Uint8Array(u); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function ub64u(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function cat(...a) { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; }
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }
// push services phones actually use (Chrome/Android, Firefox, Safari/Apple, Edge)
export const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]*\.push\.apple\.com|[a-z0-9.-]*\.notify\.windows\.com)$/;

// RFC 8291 aes128gcm: encrypt one message for one subscription
export async function encrypt(p256dh, auth, payload) {
  const ua = ub64u(p256dh), au = ub64u(auth); if (ua.length !== 65 || au.length !== 16) throw new Error('bad subscription keys');
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const as = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));
  const prkKey = await hmac(au, shared);
  const ikm = (await hmac(prkKey, cat(te.encode('WebPush: info\0'), ua, as, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16)), prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, cat(te.encode(payload), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return cat(head, as, ct);
}
// RFC 8292 VAPID: a short signed note saying this server sent it
export async function vapidAuth(endpoint, jwk, pubRaw) {
  const aud = new URL(endpoint).origin, h = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))),
    p = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://sinkid420.github.io/Singer-Flight-Tracker/' })));
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(h + '.' + p)));
  return 'vapid t=' + h + '.' + p + '.' + b64u(sig) + ', k=' + b64u(pubRaw);
}
export async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}
// send one alert; returns the push service's status (404/410 = that phone unsubscribed)
export async function send(sub, msg, jwk, pubB64, fetchFn) {
  const body = await encrypt(sub.p256dh, sub.auth, JSON.stringify(msg));
  const r = await (fetchFn || fetch)(sub.ep, { method: 'POST', body, headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(msg.ttl || 86400), Urgency: msg.urg || 'high', Topic: String(msg.tag || 'aw').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'aw', Authorization: await vapidAuth(sub.ep, jwk, ub64u(pubB64)) } });
  return r.status;
}

// ---- Android app alerts through Firebase Cloud Messaging (HTTP v1). Needs the FCM_SA secret (the Firebase service account JSON) in Cloudflare. ----
let fcmTok = null;
function pem2der(p) { const b = atob(String(p).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
async function fcmAccess(sa, fetchFn) {
  if (fcmTok && fcmTok.exp > Date.now() + 60000) return fcmTok.t;
  const now = Math.floor(Date.now() / 1000), enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: 'RS256', typ: 'JWT' }), body = enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const key = await crypto.subtle.importKey('pkcs8', pem2der(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body)));
  const r = await (fetchFn || fetch)('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + body + '.' + sig });
  const j = await r.json(); if (!j.access_token) throw new Error('fcm auth'); fcmTok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return fcmTok.t;
}
// returns the HTTP status; 404 means the phone's token is gone
export async function fcmSend(saJson, token, msg, fetchFn) {
  let sa; try { sa = JSON.parse(saJson); } catch (e) { return 0; } if (!sa.private_key || !sa.client_email || !sa.project_id) return 0;
  const at = await fcmAccess(sa, fetchFn), tag = String(msg.tag || 'aw').slice(0, 60);
  const r = await (fetchFn || fetch)('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(sa.project_id) + '/messages:send', { method: 'POST', headers: { 'Authorization': 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title: String(msg.title || 'AwareBC').slice(0, 120), body: String(msg.body || '').slice(0, 400) }, data: { url: String(msg.url || './'), tag },
      android: { priority: msg.urg === 'normal' ? 'NORMAL' : 'HIGH', notification: { tag, channel_id: msg.urg === 'normal' ? 'chat' : 'danger', icon: 'ic_tracking' } } } }) });
  return r.status;
}
