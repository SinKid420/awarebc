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
