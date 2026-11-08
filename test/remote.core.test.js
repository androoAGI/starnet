/* node test/remote.core.test.js — StarNet Remote phase 1: the sealed channel, pairing, sessions, the shared
   approvals registry, the verb gateway and the LAN listener, driven end to end with the REAL phone client
   (relay/app/phone-client.js, WebCrypto only) against the REAL station modules. No sidecar boot, no
   model, no network beyond 127.0.0.1. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');

const C = require('../sidecar/remote/crypto.js');
const { makeSessions } = require('../sidecar/remote/session.js');
const { makeDevices, PAIR_MAX_TRIES } = require('../sidecar/remote/devices.js');
const { makeApprovals } = require('../sidecar/remote/approvals.js');
const { makeGateway } = require('../sidecar/remote/gateway.js');
const { makeLanListener } = require('../sidecar/remote/lan.js');
const Phone = require('../relay/app/phone-client.js');

const newId = () => nodeCrypto.randomUUID();

async function rejects(p, re, msg) {
  try { await p; A.ok(false, msg + ' — expected a rejection'); }
  catch (e) { A.ok(!re || re.test(String(e && e.message)), msg + ' — got: ' + (e && e.message)); }
}

(async () => {
  /* ---------- 1. crypto: Node station <-> WebCrypto phone derive identical keys ---------- */
  {
    const station = C.generateKeyPair();
    const phone = await Phone._makeKeyPair(false);
    const sEph = C.generateKeyPair();
    const pEph = await Phone._makeKeyPair(false);
    const nP = C.newNonce(), nS = C.newNonce();
    const sk = C.deriveSessionKeys({ side: 'station', myStaticPrivate: station.privateKey, myStaticPublic: station.publicRaw,
      myEphPrivate: sEph.privateKey, myEphPublic: sEph.publicRaw, peerStaticPublic: phone.publicRaw, peerEphPublic: pEph.publicRaw,
      phoneNonce: nP, stationNonce: nS });
    const pk = await Phone._deriveKeys({ ephPrivate: pEph.privateKey, devicePrivate: phone.privateKey, stationPub: station.publicRaw,
      devicePub: phone.publicRaw, stationEph: sEph.publicRaw, phoneEph: pEph.publicRaw, phoneNonce: nP, stationNonce: nS });

    const up = await Phone._seal(pk.p2s, 'p2s', 1, { hello: 'station', n: 42 });
    A.eq(C.open(sk.p2s, 'p2s', up), { hello: 'station', n: 42 }, 'station opens a frame sealed by WebCrypto');
    const down = C.seal(sk.s2p, 's2p', 1, { hi: 'phone' });
    A.eq(await Phone._open(pk.s2p, 's2p', down), { hi: 'phone' }, 'WebCrypto opens a frame sealed by the station');

    const bad = Object.assign({}, up, { ct: up.ct.slice(0, -2) + (up.ct.slice(-2) === 'AA' ? 'AB' : 'AA') });
    A.throws(() => C.open(sk.p2s, 'p2s', bad), 'a tampered frame fails GCM');
    A.throws(() => C.open(sk.p2s, 's2p', up), 'a frame is bound to its direction');
    A.throws(() => C.open(sk.p2s, 'p2s', Object.assign({}, up, { seq: 2 })), 'a frame is bound to its seq');

    // a middle box that swaps the station ephemeral cannot produce matching keys
    const evil = C.generateKeyPair();
    const pk2 = await Phone._deriveKeys({ ephPrivate: pEph.privateKey, devicePrivate: phone.privateKey, stationPub: station.publicRaw,
      devicePub: phone.publicRaw, stationEph: evil.publicRaw, phoneEph: pEph.publicRaw, phoneNonce: nP, stationNonce: nS });
    const up2 = await Phone._seal(pk2.p2s, 'p2s', 1, { x: 1 });
    A.throws(() => C.open(sk.p2s, 'p2s', up2), 'a swapped ephemeral yields keys the station rejects');

    A.eq(C.pairingProof('ABCD2345', phone.publicRaw, 'Pixel'), await Phone.pairingProof('ABCD2345', phone.publicRaw, 'Pixel'), 'pairing proof matches across Node and WebCrypto');
    A.ok(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(C.fingerprint(station.publicRaw)), 'fingerprint is short and readable');
    A.throws(() => C.importPublicRaw(C.b64u(Buffer.alloc(65, 4))), 'an off-curve point is refused');
  }

  /* ---------- 2. devices: pairing, persistence round-trip, burn after wrong proofs, revoke ---------- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-remote-'));
  const file = path.join(dir, '.secrets', 'remote.json');
  let clock = 1_000_000;
  const now = () => clock;
  let devices = makeDevices({ fs, path, file, crypto: C, now, newId });
  const st1 = devices.stationKeys();
  A.ok(/^stn_/.test(st1.id), 'station id minted');
  {
    const again = makeDevices({ fs, path, file, crypto: C, now, newId }).stationKeys();
    A.eq(again.publicRaw, st1.publicRaw, 'station key survives a restart (same public key read back)');
    A.eq(again.id, st1.id, 'station id survives a restart');
  }
  const phoneKey = await Phone.makeDeviceKey();
  {
    const p = devices.startPairing({ name: 'Andrew phone' });
    A.ok(/^[A-Z2-9]{8}$/.test(p.code), 'pairing code is 8 unambiguous characters');
    A.eq(p.stationPub, st1.publicRaw, 'pairing hands out the station public key');
    const wrong = await Phone.pairingProof('WRONGCOD', phoneKey.publicRaw, 'Andrew phone');
    const r1 = devices.completePairing({ pairingId: p.pairingId, publicKey: phoneKey.publicRaw, name: 'Andrew phone', proof: wrong });
    A.eq(r1.ok, false, 'a wrong proof is refused');
    const proof = await Phone.pairingProof(p.code, phoneKey.publicRaw, 'Andrew phone');
    const r2 = devices.completePairing({ pairingId: p.pairingId, publicKey: phoneKey.publicRaw, name: 'Andrew phone', proof });
    A.eq(r2.ok, true, 'the right proof pairs');
    const r3 = devices.completePairing({ pairingId: p.pairingId, publicKey: phoneKey.publicRaw, name: 'Andrew phone', proof });
    A.eq(r3.ok, false, 'a pairing code is single use');
    const reread = makeDevices({ fs, path, file, crypto: C, now, newId }).list();
    A.eq(reread.length, 1, 'the paired device survives a restart');
    A.eq(reread[0].name, 'Andrew phone', 'device name persisted');
    A.ok(!('publicKey' in reread[0]) && !('privateKey' in reread[0]), 'list() never carries key material');
    const raw = fs.readFileSync(file, 'utf8');
    A.ok(raw.indexOf(phoneKey.publicRaw) >= 0 && raw.indexOf('privateKey') >= 0, 'station private key + device public key are on disk in the protected file');
  }
  {
    const p = devices.startPairing({});
    const k = await Phone.makeDeviceKey();
    for (let i = 0; i < PAIR_MAX_TRIES; i++) devices.completePairing({ pairingId: p.pairingId, publicKey: k.publicRaw, name: 'x', proof: 'nope' });
    const proof = await Phone.pairingProof(p.code, k.publicRaw, 'x');
    A.eq(devices.completePairing({ pairingId: p.pairingId, publicKey: k.publicRaw, name: 'x', proof }).ok, false, 'a code burns after too many wrong proofs');
    const p2 = devices.startPairing({});
    clock += 11 * 60 * 1000;
    const proof2 = await Phone.pairingProof(p2.code, k.publicRaw, 'x');
    A.eq(devices.completePairing({ pairingId: p2.pairingId, publicKey: k.publicRaw, name: 'x', proof: proof2 }).ok, false, 'a code expires after 10 minutes');
  }
  const deviceId = devices.list()[0].id;
  // GHSA-2hpj #7: a new phone is PENDING (no session until the desk approves it) and asks first
  A.eq([devices.list()[0].pending, devices.askFirst(deviceId)], [true, true], 'a new phone is pending and asks first');
  {
    const sessions = makeSessions({ devices, crypto: C, now, newId });
    const r = sessions.hello({ v: C.VERSION, deviceId, eph: phoneKey.publicRaw, nonce: C.newNonce() });
    A.ok(!r.ok && /waiting for approval/.test(r.error) && !r.welcome, 'a pending phone gets no welcome, and is told to ask at the desk');
  }
  A.eq(devices.activate('dev_nobody').ok, false, 'an unknown phone cannot be approved');
  A.eq(devices.activate(deviceId).ok, true, 'the desk approves it');
  A.eq(devices.list()[0].pending, false, 'and it is no longer pending');
  A.eq(makeDevices({ fs, path, file, crypto: C, now, newId }).list()[0].pending, false, 'the approval survives a restart');
  A.eq(devices.activate(deviceId).ok, true, 'approving twice is harmless');
  A.eq(devices.askFirst(deviceId), true, 'an approved phone still asks first until the desk says otherwise');
  // a phone works with the desk's permissions once ALWAYS ASK is unticked (kept across restarts)
  A.eq(devices.setAskFirst(deviceId, false).ok && devices.askFirst(deviceId), false, 'a phone can be set to work with the desk permissions');
  A.eq(devices.setAskFirst(deviceId, true).ok, true, 'a phone can be set to always ask');
  A.eq(devices.askFirst(deviceId) && devices.list()[0].askFirst, true, 'and the device list says so');
  A.eq(devices.setAskFirst(deviceId, false).ok && devices.askFirst(deviceId), false, 'and back');
  A.eq(devices.setAskFirst('dev_nobody', true).ok, false, 'an unknown phone cannot be set');
  {
    // a phone paired before this rule (no `pending` on its row) stays as it was
    const legacyFile = path.join(path.dirname(file), 'legacy-remote.json');
    const legacyRaw = JSON.parse(fs.readFileSync(file, 'utf8'));
    legacyRaw.devices = legacyRaw.devices.map(d => { const o = Object.assign({}, d); delete o.pending; delete o.askFirst; return o; });
    fs.writeFileSync(legacyFile, JSON.stringify(legacyRaw));
    const legacy = makeDevices({ fs, path, file: legacyFile, crypto: C, now, newId });
    A.eq([legacy.list()[0].pending, legacy.askFirst(deviceId)], [false, false], 'an existing phone is not made pending by the upgrade');
    A.ok(makeSessions({ devices: legacy, crypto: C, now, newId }).hello({ v: C.VERSION, deviceId, eph: phoneKey.publicRaw, nonce: C.newNonce() }).ok === true, 'an existing phone can still say hello');
  }

  /* ---------- 3. sessions: stranger refused, replay refused, revoke ends sessions ---------- */
  {
    const sessions = makeSessions({ devices, crypto: C, now, newId });
    A.eq(sessions.hello({ v: 1, deviceId: 'dev_nobody', eph: phoneKey.publicRaw, nonce: C.newNonce() }).ok, false, 'an unpaired device gets no welcome');
    A.eq(sessions.hello({ v: 99, deviceId, eph: phoneKey.publicRaw, nonce: C.newNonce() }).ok, false, 'an unknown protocol version is refused');
  }

  /* ---------- 4. approvals registry ---------- */
  {
    const seen = [];
    const reg = makeApprovals({ now, onChange: (k, r) => seen.push(k) });
    const decided = [];
    const fin = (d) => decided.push(d); fin.extend = () => true;
    const done = reg.add({ runId: 'r1', promptId: 'p1', agentId: 'forge', surface: 'desk', tool: 'fs.write', scope: 'write', argsSummary: 'site/index.html', finish: fin });
    A.eq(reg.list().length, 1, 'an open approval is listed');
    A.ok(!('finish' in reg.list()[0]), 'the public row never carries the finisher');
    A.eq(reg.answer('r1', 'p1', 'always').ok, false, 'a phone cannot grant ALWAYS');
    A.eq(reg.answer('r1', 'p1', 'full').ok, false, 'a phone cannot grant FULL ACCESS');
    A.eq(reg.extend('r1', 'p1'), true, 'seen earns the waiter extension');
    A.eq(reg.answer('r1', 'p1', 'once').ok, true, 'approve once');
    A.eq(decided, ['once'], 'the original finisher received the decision');
    A.eq(reg.answer('r1', 'p1', 'deny').ok, false, 'a second answer is a no-op (first answer wins)');
    done();
    A.eq(reg.list().length, 0, 'answered approval is gone');
    const done2 = reg.add({ runId: 'r2', promptId: 'p2', agentId: 'scout', surface: 'remote', tool: 'brief.ask', argsSummary: '{}', finish: (v) => decided.push(v) });
    A.eq(reg.answer('r2', 'p2', 'once').ok, false, 'a question is not approved, it is answered');
    A.eq(reg.reply('r2', 'p2', '  use the blue one ').ok, true, 'a question takes a text reply');
    A.eq(decided[1], { __clarify: true, text: 'use the blue one' }, 'the clarify waiter gets the text shape the desk sends');
    done2();
    const done3 = reg.add({ runId: 'r3', promptId: 'p3', agentId: 'a', finish: () => {} });
    done3();
    A.eq(reg.list().length, 0, 'a waiter that settles elsewhere (desk answer, timeout) leaves the list');
    A.ok(seen.indexOf('opened') >= 0 && seen.indexOf('closed') >= 0, 'changes are announced');
  }

  /* ---------- 5. gateway + LAN listener, over real HTTP, with the real phone client ---------- */
  const approvals = makeApprovals({ now: () => Date.now() });
  const sent = [];
  const host = {
    status: async () => ({ agents: [{ agentId: 'forge', name: 'FORGE', state: 'idle' }], runs: [] }),
    threads: async () => [], thread: async () => [],
    send: async (o) => { sent.push(o); return { runId: 'run_1', streamId: 'remote_forge_1' }; },
    stop: async ({ runId }) => runId === 'run_1' ? { ok: true } : { ok: false, error: 'that run is not running' },
    files: async () => [], fetchFile: async () => ({ ok: false, error: 'unknown file' }),
    routines: async () => [], setRoutine: async () => ({ ok: true })
  };
  const gateway = makeGateway({ host, approvals, now: () => Date.now() });
  A.eq((await gateway.call({ verb: 'forward', args: { url: '/api/key' } }, {})).ok, false, 'there is no forwarding verb');
  A.eq((await gateway.call({ verb: 'send', args: { agentId: 'forge', text: '' } }, {})).ok, false, 'empty task refused');
  A.eq((await gateway.call({ verb: 'send', args: { agentId: '../x', text: 'hi' } }, {})).ok, false, 'a bad agent id is refused before the host');
  A.eq((await gateway.call({ verb: 'thread', args: { streamId: '../../etc' } }, {})).ok, false, 'a bad stream id is refused');

  const sessions = makeSessions({ devices, crypto: C, now: () => Date.now(), newId });
  const lan = makeLanListener({ sessions, devices, gateway, crypto: C, now: () => Date.now() });
  const bound = await lan.start({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + bound.port;
  try {
    // pair a second phone over HTTP
    const k2 = await Phone.makeDeviceKey();
    const p = devices.startPairing({});
    const paired = await Phone.pair({ base, pairingId: p.pairingId, code: p.code, name: 'Tablet', key: k2 });
    A.ok(/^dev_/.test(paired.deviceId), 'pairing over HTTP returns a device id');
    await rejects(Phone.pair({ base, pairingId: p.pairingId, code: p.code, name: 'Tablet', key: k2 }), /expired|already/, 'the same code cannot pair twice over HTTP');
    // GHSA-2hpj #7: until the desk approves it, the paired phone gets no session over HTTP either
    await rejects(Phone.connect({ base, deviceId: paired.deviceId, stationPub: p.stationPub, key: k2 }).call('status'), /waiting for approval/, 'a pending phone cannot open a session over HTTP');
    A.eq(devices.activate(paired.deviceId).ok, true, 'the desk approves the tablet');

    const client = Phone.connect({ base, deviceId: paired.deviceId, stationPub: p.stationPub, key: k2 });
    const s1 = await client.call('status');
    A.eq(s1.ok, true, 'status over the sealed channel');
    A.eq(s1.data.agents[0].agentId, 'forge', 'status carries the crew');
    const snd = await client.call('send', { agentId: 'forge', text: 'tighten the hero copy' });
    A.eq(snd.data.runId, 'run_1', 'send returns the station run id');
    A.eq(sent[0].deviceId, paired.deviceId, 'the host learns which device sent the task');
    A.eq((await client.call('stop', { runId: 'nope' })).ok, false, 'stop on a dead run explains itself');

    // live events arrive sealed and open on the phone
    const got = [];
    client.onEvent((e) => got.push(e));
    const listening = client.listen();
    for (let i = 0; i < 50 && !sessions.list().some(s => s.sink); i++) await new Promise(r => setTimeout(r, 10));
    sessions.broadcast({ type: 'approvals.changed', count: 1 });
    for (let i = 0; i < 100 && !got.length; i++) await new Promise(r => setTimeout(r, 10));
    A.eq(got[0], { type: 'approvals.changed', count: 1 }, 'a broadcast event reaches the phone and decrypts');

    // an approval opened on the station is answered from the phone
    const decided = [];
    const done = approvals.add({ runId: 'rX', promptId: 'pX', agentId: 'forge', surface: 'desk', tool: 'shell.exec', argsSummary: 'npm run deploy', finish: (d) => decided.push(d) });
    const list = await client.call('approvals');
    A.eq(list.data.length, 1, 'the phone sees the desk approval');
    A.eq((await client.call('decide', { runId: 'rX', promptId: 'pX', decision: 'full' })).ok, false, 'full access from the phone is refused over the wire too');
    A.eq((await client.call('decide', { runId: 'rX', promptId: 'pX', decision: 'once' })).ok, true, 'approve once from the phone');
    A.eq(decided, ['once'], 'the desk waiter received the phone decision');
    done();

    // replay: re-send an old frame verbatim -> refused
    const st = client._state;
    st.seq += 1;
    const frame = await Phone._seal(st.keys.p2s, 'p2s', st.seq, { id: 999, verb: 'ping', args: {} });
    const first = await fetch(base + '/remote/v1/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: st.sid, frame }) });
    A.eq(first.status, 200, 'a fresh frame is accepted');
    const replay = await fetch(base + '/remote/v1/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: st.sid, frame }) });
    A.eq(replay.status, 400, 'the same frame replayed is refused');
    // tamper: flip a byte in a fresh frame -> refused
    st.seq += 1;
    const f2 = await Phone._seal(st.keys.p2s, 'p2s', st.seq, { id: 1000, verb: 'ping', args: {} });
    f2.ct = f2.ct.slice(0, 10) + (f2.ct[10] === 'A' ? 'B' : 'A') + f2.ct.slice(11);
    const tam = await fetch(base + '/remote/v1/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: st.sid, frame: f2 }) });
    A.eq(tam.status, 400, 'a tampered frame is refused');

    // revoke: the device's next call has no session
    A.eq(devices.revoke(paired.deviceId).ok, true, 'revoke');
    sessions.endDevice(paired.deviceId);
    await rejects(client.call('status'), /expired|no session|unknown device|refused/, 'a revoked phone is cut off immediately');
    await rejects(Phone.connect({ base, deviceId: paired.deviceId, stationPub: p.stationPub, key: k2 }).call('status'), /unknown device/, 'a revoked phone cannot say hello again');
    A.eq(makeDevices({ fs, path, file, crypto: C, now, newId }).get(paired.deviceId), null, 'revoke survives a restart');

    // nothing else is served
    const r404 = await fetch(base + '/api/key');
    A.eq(r404.status, 404, 'the LAN door serves no /api route');
    const info = await (await fetch(base + '/remote/v1/info')).json();
    A.eq(info.stationId, st1.id, 'info names the station and nothing else');
    A.ok(JSON.stringify(info).indexOf('privateKey') < 0, 'info carries no key material');

    client.close();
    await Promise.race([listening, new Promise(r => setTimeout(r, 500))]);
  } finally {
    await lan.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // one phone cannot crowd the others off: its own sessions are capped, oldest first
  {
    const stationKp = C.generateKeyPair(), phoneKp = C.generateKeyPair();
    const dv2 = { get: (id) => ({ id, publicKey: phoneKp.publicRaw }), stationKeys: () => ({ id: 'stn', privateKey: stationKp.privateKey, publicRaw: stationKp.publicRaw }), touch: () => {} };
    const ss2 = makeSessions({ devices: dv2, crypto: C, now: () => Date.now(), newId, perDevice: 4 });
    for (let i = 0; i < 4; i++) ss2._live.set('other-' + i, { id: 'other-' + i, deviceId: 'phone-b', keys: {}, lastAt: Date.now(), inSeq: 0, outSeq: 0 });
    let made = 0;
    for (let i = 0; i < 7; i++) { const eph = C.generateKeyPair(); if (ss2.hello({ v: C.VERSION, deviceId: 'phone-a', eph: eph.publicRaw, nonce: C.newNonce() }).ok) made++; }
    const byDev = {}; for (const x of ss2._live.values()) byDev[x.deviceId] = (byDev[x.deviceId] || 0) + 1;
    A.eq(made, 7, 'every hello from the phone is answered');
    A.eq(byDev['phone-a'], 4, 'but one phone holds at most four sessions');
    A.eq(byDev['phone-b'], 4, 'and another phone keeps all of its own');
  }

  // the crew stream is sealed only for the phones that are looking
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-bc-'));
    const dv = { get: (id) => ({ id }), touch: () => {} };   // every device exists for this check
    const ss = makeSessions({ devices: dv, crypto: C, now: () => Date.now(), newId });
    const sent = [];
    // two fake sessions with sinks (the broadcast path only needs id, deviceId, keys and a sink)
    for (const dev of ['d-look', 'd-away']) {
      const s = { id: 's-' + dev, deviceId: dev, keys: { s2p: nodeCrypto.randomBytes(32) }, outSeq: 0, lastAt: Date.now(), sink: (f) => sent.push(dev) };
      ss._live.set(s.id, s);
    }
    A.eq(ss.broadcast({ type: 'view.crew' }, ['d-look']), 1, 'sealed once');
    A.eq(sent, ['d-look'], 'only the looking phone gets it');
    sent.length = 0;
    A.eq(ss.broadcast({ type: 'approval.opened' }), 2, 'an ordinary event still reaches every phone');
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('remote core');
})().catch((e) => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
