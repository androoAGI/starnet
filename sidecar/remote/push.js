/* sidecar/remote/push.js — the station taps a paired phone on the shoulder, even with the app closed.

   Standard Web Push, sent by THIS station straight to the phone's own push service (Apple, Google, Mozilla):
     · VAPID (RFC 8292): the station signs a short ES256 token with its own push key, so the push service knows
       every message for this subscription comes from the same sender. The key is made on first use and kept in
       WORKSPACES/.secrets/remote-push.json next to the subscriptions.
     · Message encryption (RFC 8291, aes128gcm): every payload is sealed to the keys the phone's browser made for
       the subscription. The push service carries it and cannot read it. The relay is not involved at all.

   What is sent is deliberately small: a title ("SCOUT needs your OK"), one line, and which screen to open. The
   phone then reads the details over the sealed channel like everything else.

     const push = makePush({ fs, path, file, crypto, now, fetch, subject })
     push.publicKey()                          -> the VAPID public key the phone subscribes with (base64url, raw P-256)
     push.subscribe(deviceId, sub)             -> { ok } | { ok:false, error }    sub = { endpoint, keys:{ p256dh, auth } }
     push.unsubscribe(deviceId)                -> { ok }
     push.has(deviceId)                        -> bool
     push.forget(deviceId)                     same as unsubscribe (a revoked phone)
     await push.send(deviceIds, { title, body, tag, url }) -> [{ deviceId, ok, status }]
   A push service that answers 410 (or 404 on a subscription over an hour old) has dropped it: removed here too. */
'use strict';

const nodeCrypto = require('crypto');
const { note } = require('../failopen.js');
const { readJsonResilient, writeJsonResilient, saveJsonVerified } = require('../durable-store.js');

const TTL_S = 12 * 60 * 60;              // a push service may hold a message this long for a phone that is off
const JWT_LIFE_S = 12 * 60 * 60;
const RECORD_SIZE = 4096;
const SETTLE_MS = 60 * 60 * 1000;          // a 404 on a subscription younger than this is not trusted to mean "gone"
const MAX_PAYLOAD = 3000;                 // well under the 4 KB push services accept, after encryption overhead
const ENDPOINT_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/\S{1,2000}$/;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { const str = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); return Buffer.from(str + '==='.slice((str.length + 3) % 4), 'base64'); };

function rawPublic(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
}
function publicFromRaw(raw) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('not an uncompressed P-256 point');
  return nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' });
}
function hkdf(salt, ikm, info, len) { return Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, info, len)); }

// RFC 8291 + RFC 8188: one aes128gcm record, sealed to the subscription's p256dh key and auth secret
function encrypt(plaintext, uaPublicRaw, authSecret, opts) {
  const o = opts || {};
  const eph = o.ephemeral || nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const asPublic = rawPublic(eph.publicKey);
  const shared = nodeCrypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(uaPublicRaw) });
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublicRaw, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const salt = o.salt || nodeCrypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = nodeCrypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(RECORD_SIZE, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// a phone's push address must belong to a real browser push service (Google, Apple, Mozilla, Microsoft): the station
// never POSTs to an address a phone made up
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
function pushHostOk(endpoint, extra) {
  let host = '';
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch (_) { return false; }
  return PUSH_HOSTS.concat(extra || []).some(h => h && (host === h || host.endsWith('.' + h)));
}

function makePush(deps) {
  const fs = deps.fs, pathMod = deps.path, file = deps.file;
  const now = deps.now;
  if (typeof now !== 'function') throw new Error('makePush needs an injected clock (deps.now)');
  const doFetch = deps.fetch;
  const subject = deps.subject || 'https://starnetos.com';
  const extraHosts = Array.isArray(deps.extraHosts) ? deps.extraHosts.map(h => String(h).trim().toLowerCase()).filter(Boolean) : [];
  let state = null;

  function load() {
    if (state) return state;
    const r = readJsonResilient({ fs }, file);
    if (r.status === 'unreadable') throw new Error('remote push file is unreadable — refusing to replace it');
    const v = (r.value && typeof r.value === 'object') ? r.value : {};
    state = { v: 1, vapid: v.vapid && v.vapid.privateKey ? v.vapid : null, subs: (v.subs && typeof v.subs === 'object') ? v.subs : {} };
    return state;
  }
  function persist(next) {
    const res = saveJsonVerified({
      mkdir: () => fs.mkdirSync(pathMod.dirname(file), { recursive: true }),
      save: () => writeJsonResilient({ fs, path: pathMod }, file, next),
      load: () => readJsonResilient({ fs }, file).value,
      proof: (rb) => !!rb && JSON.stringify(rb.subs || {}) === JSON.stringify(next.subs) && JSON.stringify(rb.vapid || null) === JSON.stringify(next.vapid)
    });
    if (res.ok) state = next;
    return res;
  }

  let vapidCache = null;
  function vapid() {
    if (vapidCache) return vapidCache;
    const s = load();
    if (!s.vapid) {
      const kp = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const next = Object.assign({}, s, { vapid: { privateKey: b64u(kp.privateKey.export({ format: 'der', type: 'pkcs8' })), createdAt: now() } });
      const res = persist(next);
      if (!res.ok) throw new Error('could not save the push key (' + res.error + ')');
    }
    const priv = nodeCrypto.createPrivateKey({ key: unb64u(load().vapid.privateKey), format: 'der', type: 'pkcs8' });
    vapidCache = { priv, publicRaw: rawPublic(nodeCrypto.createPublicKey(priv)) };
    return vapidCache;
  }
  function publicKey() { return b64u(vapid().publicRaw); }

  function jwtFor(endpoint) {
    const v = vapid();
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now() / 1000) + JWT_LIFE_S, sub: subject }));
    const sig = nodeCrypto.sign('sha256', Buffer.from(head + '.' + claims), { key: v.priv, dsaEncoding: 'ieee-p1363' });
    return head + '.' + claims + '.' + b64u(sig);
  }

  function subscribe(deviceId, sub) {
    const id = String(deviceId || '');
    if (!id) return { ok: false, error: 'unknown phone' };
    const endpoint = String((sub && sub.endpoint) || '');
    const keys = (sub && sub.keys) || {};
    if (!ENDPOINT_RE.test(endpoint) || !pushHostOk(endpoint, extraHosts)) return { ok: false, error: 'that is not a push address this station can use' };
    let p256dh, auth;
    try { p256dh = unb64u(keys.p256dh); auth = unb64u(keys.auth); publicFromRaw(p256dh); }
    catch (_) { return { ok: false, error: 'the phone sent unusable push keys' }; }
    if (auth.length !== 16) return { ok: false, error: 'the phone sent unusable push keys' };
    const s = load();
    const subs = Object.assign({}, s.subs, { [id]: { endpoint, p256dh: b64u(p256dh), auth: b64u(auth), at: now() } });
    const res = persist(Object.assign({}, s, { subs }));
    return res.ok ? { ok: true } : { ok: false, error: 'could not save the subscription (' + res.error + ')' };
  }
  function unsubscribe(deviceId) {
    const s = load(), id = String(deviceId || '');
    if (!s.subs[id]) return { ok: true };
    const subs = Object.assign({}, s.subs); delete subs[id];
    const res = persist(Object.assign({}, s, { subs }));
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  const has = (deviceId) => !!load().subs[String(deviceId || '')];
  const subscribed = () => Object.keys(load().subs);

  async function sendOne(deviceId, payload) {
    const sub = load().subs[deviceId];
    if (!sub) return { deviceId, ok: false, status: 0 };
    // the push-service check runs at SEND too: a subscription saved by an older build (before the subscribe check)
    // must not make the station POST to an address a phone made up (sweep 2026-10-02)
    if (!ENDPOINT_RE.test(String(sub.endpoint || '')) || !pushHostOk(sub.endpoint, extraHosts)) { unsubscribe(deviceId); return { deviceId, ok: false, status: 0 }; }
    let body;
    try { body = encrypt(Buffer.from(payload), unb64u(sub.p256dh), unb64u(sub.auth)); }
    catch (e) { note('remote.push.encrypt', e); return { deviceId, ok: false, status: 0 }; }
    let status = 0;
    try {
      const r = await doFetch(sub.endpoint, { method: 'POST', body, redirect: 'manual',   // never followed to another host
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(TTL_S), Urgency: 'high',
          Authorization: 'vapid t=' + jwtFor(sub.endpoint) + ', k=' + publicKey() } });
      status = r.status;
    } catch (e) { note('remote.push.fetch', e); return { deviceId, ok: false, status: 0 }; }
    // the push service forgot this subscription: 410 says so outright; a 404 counts only once the subscription is
    // old enough that it cannot be a push service still settling a brand-new one
    if (status === 410 || (status === 404 && now() - (Number(sub.at) || 0) > SETTLE_MS)) unsubscribe(deviceId);
    return { deviceId, ok: status >= 200 && status < 300, status };
  }

  async function send(deviceIds, msg) {
    const m = msg || {};
    const payload = JSON.stringify({ title: String(m.title || 'Agent OS').slice(0, 80), body: String(m.body || '').slice(0, 240),
      tag: String(m.tag || '').slice(0, 80), url: String(m.url || '').slice(0, 200) });
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) return [];
    const ids = (Array.isArray(deviceIds) ? deviceIds : subscribed()).filter(has);
    return Promise.all(ids.map(id => sendOne(id, payload)));
  }

  return { publicKey, subscribe, unsubscribe, forget: unsubscribe, has, subscribed, send, _jwtFor: jwtFor };
}

module.exports = { makePush, encrypt, _b64u: b64u, _unb64u: unb64u };
