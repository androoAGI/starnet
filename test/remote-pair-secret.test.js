/* node test/remote-pair-secret.test.js — A PHONE PAIRS WITH A 128-BIT LINK SECRET (GHSA-2hpj #7, the rest).

   The pairing proof was HMAC(code, …) over the 8-character code (31 symbols, about 40 bits). The proof crosses the relay
   in plain text, so a relay that kept it could try every code within the 10-minute window and pair its own key. Now:
     - startPairing makes a 128-bit secret (16 random bytes, base64url) beside the code, and the proof is HMAC(secret, …).
       The code is a lookup only: completePairing finds a pairing by its id or by its code, and never takes a proof made
       with the code;
     - the secret rides in the link the phone already opens (the blob's `c`), so a phone app of any version proves with it,
       the relay needs no change, and the LAN door is the same;
     - the fingerprint confirmation stays: a new phone is pending and asks first until the desk approves it;
     - a phone paired before keeps working: it never used the code again (its key is its identity).
   Unit-level here (the real devices module and the real phone client); remote.e2e drives the route and the LAN door. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');

const C = require('../sidecar/remote/crypto.js');
const { makeDevices, PAIR_MAX_TRIES, SECRET_BYTES } = require('../sidecar/remote/devices.js');
const Phone = require('../relay/app/phone-client.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');

const newId = () => nodeCrypto.randomUUID();

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-pairsecret-'));
  try {
    const file = path.join(dir, '.secrets', 'remote.json');
    let clock = 1_000_000;
    const now = () => clock;
    const devices = makeDevices({ fs, path, file, crypto: C, now, newId });
    devices.stationKeys();

    // ---- the secret ----
    A.eq(SECRET_BYTES, 16, 'the link secret is 128 bits');
    const p = devices.startPairing({ name: 'Pixel' });
    A.ok(/^[A-Za-z0-9_-]{22}$/.test(p.secret) && C.unb64u(p.secret).length === 16, 'startPairing hands out a 16-byte base64url secret: ' + p.secret.length + ' chars');
    A.ok(/^[A-Z2-9]{8}$/.test(p.code), 'and still a short human code (a lookup)');
    A.ok(p.secret !== p.code && p.secret.indexOf(p.code) < 0, 'the secret is not the code');
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(devices.startPairing({}).secret);
    A.eq(seen.size, 40, 'every pairing gets its own secret');

    // ---- the proof: made with the secret, never with the code ----
    const k = await Phone.makeDeviceKey();
    const withCode = await Phone.pairingProof(p.code, k.publicRaw, 'Pixel');
    let r = devices.completePairing({ pairingId: p.pairingId, publicKey: k.publicRaw, name: 'Pixel', proof: withCode });
    A.eq([r.ok, /wrong pairing/.test(r.error || '')], [false, true], 'a proof made with the human code is refused (' + r.error + ')');
    const withSecret = await Phone.pairingProof(p.secret, k.publicRaw, 'Pixel');
    A.eq(withSecret, C.pairingProof(p.secret, k.publicRaw, 'Pixel'), 'the phone (WebCrypto) and the station (node) agree on the secret\'s proof');
    r = devices.completePairing({ pairingId: p.pairingId, publicKey: k.publicRaw, name: 'Pixel', proof: withSecret });
    A.eq(r.ok, true, 'a proof made with the secret pairs');
    A.eq([r.device.pending, r.device.askFirst, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(r.device.fingerprint)], [true, true, true], 'the new phone is pending, asks first, and has the fingerprint the desk confirms');
    A.eq(devices.completePairing({ pairingId: p.pairingId, publicKey: k.publicRaw, name: 'Pixel', proof: withSecret }).ok, false, 'single use');
    A.eq(devices.activate(r.device.id).ok, true, 'the desk approves it (fingerprint confirmation, unchanged)');
    A.eq(devices.list().find(d => d.id === r.device.id).pending, false, 'and only then is it active');

    // ---- the code as a lookup ----
    const p2 = devices.startPairing({ name: 'Tablet' });
    const k2 = await Phone.makeDeviceKey();
    r = devices.completePairing({ code: p2.code, publicKey: k2.publicRaw, name: 'Tablet', proof: await Phone.pairingProof(p2.code, k2.publicRaw, 'Tablet') });
    A.eq(r.ok, false, 'found by its code, a proof made with that code is still refused');
    r = devices.completePairing({ code: p2.code.toLowerCase().replace(/^(.{4})/, '$1-'), publicKey: k2.publicRaw, name: 'Tablet', proof: await Phone.pairingProof(p2.secret, k2.publicRaw, 'Tablet') });
    A.eq(r.ok, true, 'found by its code as a person types it (any case, a dash), the secret\'s proof pairs');
    A.eq(devices.completePairing({ code: 'ZZZZZZZZ', publicKey: k2.publicRaw, name: 'x', proof: 'x' }).ok, false, 'an unknown code finds nothing');
    A.eq(devices.completePairing({ publicKey: k2.publicRaw, name: 'x', proof: 'x' }).ok, false, 'no id and no code finds nothing');

    // ---- the old limits still hold, now over the secret ----
    const p3 = devices.startPairing({});
    const k3 = await Phone.makeDeviceKey();
    for (let i = 0; i < PAIR_MAX_TRIES; i++) devices.completePairing({ pairingId: p3.pairingId, publicKey: k3.publicRaw, name: 'x', proof: 'nope' });
    A.eq(devices.completePairing({ pairingId: p3.pairingId, publicKey: k3.publicRaw, name: 'x', proof: await Phone.pairingProof(p3.secret, k3.publicRaw, 'x') }).ok, false, 'it burns after ' + PAIR_MAX_TRIES + ' wrong proofs');
    const p4 = devices.startPairing({});
    clock += 11 * 60 * 1000;
    A.eq(devices.completePairing({ pairingId: p4.pairingId, publicKey: k3.publicRaw, name: 'x', proof: await Phone.pairingProof(p4.secret, k3.publicRaw, 'x') }).ok, false, 'and expires after 10 minutes');

    // ---- a phone paired before keeps working: its row and key are untouched by the change ----
    const before = makeDevices({ fs, path, file, crypto: C, now, newId }).list();
    A.ok(before.some(d => d.id === r.device.id && d.pending === true) && before.some(d => d.name === 'Pixel' && d.pending === false), 'paired phones survive a restart as they were');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    A.ok(JSON.stringify(stored).indexOf(p2.secret) < 0 && JSON.stringify(stored).indexOf(p2.code) < 0, 'no secret or code is ever written to remote.json (pairings live in memory)');

    // ---- the phone client: the app passes the link's `c`; a caller may name it secret ----
    const src = fs.readFileSync(path.join(__dirname, '..', 'relay', 'app', 'phone-client.js'), 'utf8');
    A.ok((src.match(/pairingProof\(o\.secret != null \? o\.secret : o\.code,/g) || []).length === 2, 'pair and pairRelay prove with the secret (the link\'s `c`; `code` stays accepted from an older caller)');
    A.ok(/PhoneClient\.pairRelay\(\{ relay, stationPub: p\.s, pairingId: p\.p, secret: p\.c,/.test(fs.readFileSync(path.join(__dirname, '..', 'relay', 'app', 'app.js'), 'utf8')), 'the phone app passes the link\'s secret');

    // ---- the host route: the link carries the secret, never the code ----
    const route = sidecarTopLevelFunction('handleRemotePair');
    A.ok(/p: p\.pairingId, c: p\.secret \}/.test(route), 'the pairing link (QR) carries the secret as `c`');
    A.ok(!/c: p\.code/.test(route), 'and not the code');
    A.ok(/secret: p\.secret/.test(route), 'the desk-gated route answers with the secret too');
    A.ok(/if \(!deskGate\(req, res, 'remote-pair'/.test(route), 'making a pairing is still desk-confirmed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  A.report('remote-pair-secret.test');
})().catch((e) => { console.error(e); process.exit(1); });
