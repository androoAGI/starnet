/* sidecar/remote/devices.js — this station's remote identity and the phones allowed to reach it.

   One protected file, WORKSPACES/.secrets/remote.json (a sibling of the fs jail, 0600 where the OS has modes):
     { v:1, station:{ id, privateKey, publicKey, createdAt },
       devices:[ { id, name, publicKey, createdAt, lastSeenAt } ],
       enabled: false }
   Pairing codes live in MEMORY only: a restart forgets an unused code, which is the safe direction.

     const d = makeDevices({ fs, path, file, crypto, now, newId, tighten })
     d.stationKeys()                          -> { id, privateKey:KeyObject, publicRaw }   (made on first use, persisted)
     d.list() / d.get(id)                     -> public device rows (never a private key; phones have none here)
     d.startPairing({ name? })                -> { pairingId, code, stationId, stationPub, fingerprint, expiresAt }
     d.completePairing({ pairingId, publicKey, name, proof }) -> { ok, device } | { ok:false, error }
     d.revoke(id) -> bool     d.touch(id)     d.setEnabled(bool) / d.enabled()
     d.activate(id)                           -> { ok } | { ok:false, error }   the desk approved a pending phone
     d.issueRelayToken(id)                    -> { ok, token }   the phone's pass to knock at the relay (only its hash is kept)
     d.relayTokenHashes()                     -> [hash]          what the station tells the relay to admit

   Laws:
     · A pairing code is single use, expires in 10 minutes, and burns after 5 wrong proofs.
     · The code itself never crosses the wire: the phone proves it with an HMAC bound to the key it registers
       (crypto.pairingProof), so a sniffed completion can't be replayed to register a different key.
     · Every write is read back before it counts (saveJsonVerified). A pairing that didn't reach disk is
       reported as failed, never as "paired".
     · Revoke deletes the row. A revoked-but-present row is one forgotten check away from working again.
     · A NEW phone is pending and asks first (GHSA-2hpj #7). Knowing the code is not enough: the phone gets no session
       until someone at the desk approves it there, seeing its fingerprint (activate). A row from before this rule has
       no `pending` and stays as it was. */
'use strict';

const { note } = require('../failopen.js');

const { readJsonResilient, writeJsonResilient, saveJsonVerified } = require('../durable-store.js');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O/1/I/L: it may be typed from a screen
const CODE_LEN = 8;
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_TRIES = 5;
const MAX_DEVICES = 16;
const NAME_MAX = 40;

// cut by code point (fix-sec2, review 12): a name cut through an emoji left a lone surrogate the desktop's confirmation
// dialog could never be handed, so that phone could never be approved
function cleanName(s) { return require('../deskproof.js').cutPoints(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim(), NAME_MAX).trim() || 'Phone'; }

function makeDevices(deps) {
  const fs = deps.fs, pathMod = deps.path, file = deps.file, C = deps.crypto;
  const now = deps.now;
  if (typeof now !== 'function') throw new Error('makeDevices needs an injected clock (deps.now)');
  const newId = deps.newId;
  const randomBytes = deps.randomBytes || require('crypto').randomBytes;
  const tighten = typeof deps.tighten === 'function' ? deps.tighten : () => {};
  let state = null;          // loaded lazily
  let stationCache = null;   // { id, privateKey:KeyObject, publicRaw }
  const pairings = new Map();

  function load() {
    if (state) return state;
    const r = readJsonResilient({ fs }, file);
    if (r.status === 'unreadable') throw new Error('remote devices file is unreadable — refusing to replace it');
    const v = (r.value && typeof r.value === 'object') ? r.value : {};
    state = {
      v: 1,
      station: v.station && v.station.privateKey ? v.station : null,
      devices: Array.isArray(v.devices) ? v.devices.filter(d => d && d.id && d.publicKey) : [],
      enabled: v.enabled === true
    };
    return state;
  }

  function persist(next) {
    const res = saveJsonVerified({
      mkdir: () => fs.mkdirSync(pathMod.dirname(file), { recursive: true }),
      save: () => writeJsonResilient({ fs, path: pathMod }, file, next),
      load: () => readJsonResilient({ fs }, file).value,
      proof: (rb) => !!rb && JSON.stringify(rb.devices || []) === JSON.stringify(next.devices)
        && ((rb.station && rb.station.publicKey) || null) === ((next.station && next.station.publicKey) || null)
        && (rb.enabled === true) === (next.enabled === true)
    });
    if (res.ok) { state = next; try { tighten(); } catch (e) { note('remote.devices.tighten', e); } }
    return res;
  }

  function stationKeys() {
    if (stationCache) return stationCache;
    const s = load();
    if (s.station) {
      stationCache = { id: s.station.id, privateKey: C.importPrivate(s.station.privateKey), publicRaw: s.station.publicKey };
      return stationCache;
    }
    const kp = C.generateKeyPair();
    const station = { id: 'stn_' + newId().replace(/-/g, '').slice(0, 20), privateKey: C.exportPrivate(kp.privateKey), publicKey: kp.publicRaw, createdAt: now() };
    const res = persist(Object.assign({}, s, { station }));
    if (!res.ok) throw new Error('could not save the station key: ' + res.error);
    stationCache = { id: station.id, privateKey: kp.privateKey, publicRaw: kp.publicRaw };
    return stationCache;
  }

  function publicRow(d) { return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt || null, fingerprint: C.fingerprint(d.publicKey), askFirst: d.askFirst === true, pending: d.pending === true }; }
  function list() { return load().devices.map(publicRow); }
  function get(id) { const d = load().devices.find(x => x.id === String(id || '')); return d ? { id: d.id, name: d.name, publicKey: d.publicKey, pending: d.pending === true } : null; }

  function sweepPairings() { const t = now(); for (const [k, p] of pairings) if (p.expiresAt <= t || p.used) pairings.delete(k); }

  function startPairing(o) {
    sweepPairings();
    const st = stationKeys();
    const bytes = randomBytes(CODE_LEN);
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    const p = { pairingId: 'pr_' + newId().replace(/-/g, '').slice(0, 16), code, name: cleanName(o && o.name), expiresAt: now() + PAIR_TTL_MS, tries: 0, used: false };
    pairings.set(p.pairingId, p);
    return { pairingId: p.pairingId, code, stationId: st.id, stationPub: st.publicRaw, fingerprint: C.fingerprint(st.publicRaw), expiresAt: p.expiresAt };
  }

  function completePairing(o) {
    sweepPairings();
    const p = pairings.get(String((o && o.pairingId) || ''));
    if (!p) return { ok: false, error: 'this pairing code expired or was already used — make a new one on the desktop' };
    const pub = String((o && o.publicKey) || '');
    try { C.importPublicRaw(pub); } catch (_) { return { ok: false, error: 'the phone sent an invalid key' }; }
    const name = cleanName((o && o.name) || p.name);
    const want = C.pairingProof(p.code, pub, name);
    if (!C.safeEqual(want, String((o && o.proof) || ''))) {
      p.tries += 1;
      if (p.tries >= PAIR_MAX_TRIES) pairings.delete(p.pairingId);
      return { ok: false, error: 'wrong pairing code' };
    }
    const s = load();
    if (s.devices.some(d => d.publicKey === pub)) { p.used = true; return { ok: false, error: 'this phone is already paired' }; }
    if (s.devices.length >= MAX_DEVICES) return { ok: false, error: 'too many paired devices — remove one on the desktop first' };
    // pending + askFirst: switched off until the desk approves it, and then asking before every gated step (GHSA-2hpj #7)
    const device = { id: 'dev_' + newId().replace(/-/g, '').slice(0, 16), name, publicKey: pub, createdAt: now(), lastSeenAt: null, askFirst: true, pending: true };
    const res = persist(Object.assign({}, s, { devices: s.devices.concat([device]) }));
    if (!res.ok) return { ok: false, error: 'the pairing could not be saved on this computer (' + res.error + ') — nothing was paired' };
    p.used = true;
    pairings.delete(p.pairingId);
    return { ok: true, device: publicRow(device) };
  }

  /* PERMISSIONS FROM A PHONE (Andrew 10-02: "I want full access so I can vibe code on the go"): a phone works with
     the desk's own permissions — an agent on Full Access acts without asking from the phone too. A phone marked
     askFirst (set at the desk, per phone) asks before every gated step instead, whatever the agent's setting. */
  function askFirst(id) { const d = load().devices.find(x => x.id === String(id || '')); return !!(d && d.askFirst === true); }
  function setAskFirst(id, on) {
    const s = load();
    if (!s.devices.some(d => d.id === String(id || ''))) return { ok: false, error: 'no such device' };
    const devices = s.devices.map(d => d.id === String(id) ? Object.assign({}, d, { askFirst: on === true }) : d);
    const res = persist(Object.assign({}, s, { devices }));
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  // The desk approved this phone (index.js gates the route with a desk confirmation that shows its fingerprint).
  function activate(id) {
    const s = load();
    const d = s.devices.find(x => x.id === String(id || ''));
    if (!d) return { ok: false, error: 'no such device' };
    if (d.pending !== true) return { ok: true };
    const devices = s.devices.map(x => {
      if (x.id !== d.id) return x;
      const out = Object.assign({}, x);
      delete out.pending;
      return out;
    });
    const res = persist(Object.assign({}, s, { devices }));
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  function revoke(id) {
    const s = load();
    const next = s.devices.filter(d => d.id !== String(id || ''));
    if (next.length === s.devices.length) return { ok: false, error: 'no such device' };
    const res = persist(Object.assign({}, s, { devices: next }));
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  // lastSeenAt is a convenience stamp: a failed write here must never break a live session.
  function touch(id) {
    const s = load();
    const t = now();
    const d = s.devices.find(x => x.id === id);
    if (!d || (d.lastSeenAt && t - d.lastSeenAt < 60 * 1000)) return;
    const devices = s.devices.map(x => x.id === id ? Object.assign({}, x, { lastSeenAt: t }) : x);
    persist(Object.assign({}, s, { devices }));
  }

  // A relay pass is not a key: it only lets a phone reach the relay's switchboard for this station. The sealed
  // channel still needs the phone's private key. The station keeps a SHA-256 of it, the relay a copy of that hash.
  function tokenHash(token) { return C.b64u(require('crypto').createHash('sha256').update(String(token)).digest()); }
  function issueRelayToken(id) {
    const s = load();
    if (!s.devices.some(d => d.id === id)) return { ok: false, error: 'no such device' };
    const token = C.b64u(randomBytes(32));
    const devices = s.devices.map(d => d.id === id ? Object.assign({}, d, { relayTokenHash: tokenHash(token) }) : d);
    const res = persist(Object.assign({}, s, { devices }));
    return res.ok ? { ok: true, token } : { ok: false, error: res.error };
  }
  function relayTokenHashes() { return load().devices.map(d => d.relayTokenHash).filter(Boolean); }
  function tokenHashOf(id) { const d = load().devices.find(x => x.id === String(id || '')); return (d && d.relayTokenHash) || ''; }

  function enabled() { return load().enabled === true; }
  function setEnabled(on) { const s = load(); const res = persist(Object.assign({}, s, { enabled: on === true })); return res.ok ? { ok: true } : { ok: false, error: res.error }; }

  return { stationKeys, list, get, startPairing, completePairing, activate, revoke, askFirst, setAskFirst, touch, enabled, setEnabled, issueRelayToken, relayTokenHashes, tokenHashOf, _pairings: pairings };
}

module.exports = { makeDevices, CODE_ALPHABET, PAIR_TTL_MS, PAIR_MAX_TRIES };
