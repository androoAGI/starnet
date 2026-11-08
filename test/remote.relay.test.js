/* node test/remote.relay.test.js — StarNet Remote over the RELAY (phase 3), in one process, on 127.0.0.1.

   The real relay (relay/server.js + its dependency-free WebSocket server), the real station side
   (sidecar/remote/relay-client.js over Node's built-in WebSocket, with the real devices/sessions/approvals/
   gateway) and the real WebCrypto phone client. What it proves:
     · a station signs in with its own key; a forged signature is refused; another key can't take its routing id
     · a phone pairs through the relay with the one-time code, then connects with its relay pass
     · a stranger without a pass can only send a pairing request; anything else is closed (4401)
     · sealed calls and live events flow end to end; the relay never holds anything it could open
     · approvals: the phone approves once; always/full are refused
     · revoke kicks the phone at the relay and its pass stops working
     · station offline -> phones get 4404; the station comes back by itself after a relay restart */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');

const C = require('../sidecar/remote/crypto.js');
const { makeSessions } = require('../sidecar/remote/session.js');
const { makeDevices } = require('../sidecar/remote/devices.js');
const { makeApprovals } = require('../sidecar/remote/approvals.js');
const { makeGateway } = require('../sidecar/remote/gateway.js');
const { makeRelayClient } = require('../sidecar/remote/relay-client.js');
const { makeRelay, ridOf, tokenHash, LABEL } = require('../relay/server.js');
const net = require('net');
const Phone = require('../relay/app/phone-client.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, ms, label) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return; await sleep(20); } throw new Error('timed out waiting for ' + label); }
function wsClose(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, deviceId: 'dev_x', eph: 'x', nonce: 'x' }));
    ws.onclose = (ev) => resolve(ev.code);
    setTimeout(() => { try { ws.close(); } catch (_) {} resolve('timeout'); }, 5000);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-relay-'));
  const newId = () => nodeCrypto.randomUUID();
  const devices = makeDevices({ fs, path, file: path.join(dir, '.secrets', 'remote.json'), crypto: C, now: () => Date.now(), newId });
  const sessions = makeSessions({ devices, crypto: C, now: () => Date.now(), newId });
  const approvals = makeApprovals({ now: () => Date.now() });
  const host = {
    status: async () => ({ station: 'TEST STATION', agents: [{ agentId: 'forge', name: 'FORGE', state: 'idle' }], runs: [] }),
    threads: async () => [], thread: async () => [], send: async () => ({ runId: 'r1', streamId: 's1' }), stop: async () => ({ ok: false }),
    files: async () => [], fetchFile: async () => ({ ok: false, error: 'unknown file' }), routines: async () => [], setRoutine: async () => ({ ok: true })
  };
  const gateway = makeGateway({ host, approvals, now: () => Date.now() });

  let relay = makeRelay({ log: () => {} });
  let port = await relay.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + port;
  let rc = null;
  try {
    // a forged station sign-in is refused
    {
      const ws = new WebSocket(base.replace('http', 'ws') + '/v1/station');
      const code = await new Promise((resolve) => {
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === 'challenge') ws.send(JSON.stringify({ t: 'auth', pub: devices.stationKeys().publicRaw, sig: C.b64u(Buffer.alloc(70, 1)) })); };
        ws.onclose = (ev) => resolve(ev.code);
      });
      A.eq(code, 4401, 'a station that cannot sign for its key is refused');
    }

    // ONE bad request must never take the relay down (it carries every station and phone)
    {
      // a relay that serves the phone app (the crash lived on that path)
      const appRelay = makeRelay({ appDir: path.join(__dirname, '..', 'relay', 'app'), log: () => {} });
      const appPort = await appRelay.listen(0, '127.0.0.1');
      const abase = 'http://127.0.0.1:' + appPort;
      A.eq((await fetch(abase + '/')).status, 200, 'the phone app is served');
      const r1 = await fetch(abase + '/%00');
      A.eq(r1.status, 400, 'a path with a NUL byte is refused, not crashed on');
      const r2 = await fetch(abase + '/' + 'a'.repeat(400));
      A.eq(r2.status, 400, 'an absurdly long path is refused');
      await new Promise((resolve) => {
        const s = net.connect(appPort, '127.0.0.1', () => s.write('GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
        s.on('close', resolve); s.on('error', resolve); setTimeout(() => { s.destroy(); resolve(); }, 1500);
      });
      const h = await fetch(abase + '/healthz').then(r => r.json());
      A.eq(h.ok, true, 'and the relay is still up afterwards');
      // the app is served compressed, with a validator, and its service worker is named after the shell's bytes
      {
        const raw = await new Promise((resolve) => require('http').get(abase + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } }, (res) => { const parts = []; res.on('data', d => parts.push(d)); res.on('end', () => resolve({ res, body: Buffer.concat(parts) })); }));
        A.eq(raw.res.headers['content-encoding'], 'gzip', 'the app script is sent gzipped to a browser that accepts it');
        const plain = fs.readFileSync(path.join(__dirname, '..', 'relay', 'app', 'app.js'));
        A.ok(raw.body.length < plain.length / 2, 'at well under half its size (' + raw.body.length + ' of ' + plain.length + ' bytes)');
        A.ok(require('zlib').gunzipSync(raw.body).equals(plain), 'and it unpacks to the exact file');
        const etag = raw.res.headers.etag;
        A.ok(!!etag, 'it carries an ETag');
        A.eq((await fetch(abase + '/app.js', { headers: { 'If-None-Match': etag } })).status, 304, 'a phone that has it already gets a 304, not the bytes again');
        const sw = await fetch(abase + '/sw.js').then(r => r.text());
        A.ok(/const CACHE = 'starnet-remote-[A-Za-z0-9_-]{12}'/.test(sw) && sw.indexOf('%SHELL%') < 0, 'the service worker is served with a fingerprint of the shell in its cache name');
        const sw2 = await fetch(abase + '/sw.js').then(r => r.text());
        A.eq(sw2, sw, 'the same shell gives the same name (no needless re-install)');
      }
      await appRelay.close();
    }

    // NOBODY CAN EXHAUST THE RELAY BEFORE PROVING ANYTHING. Raw WebSocket frames from an unauthenticated socket:
    // a flood of empty continuation frames (once grew a list forever and killed the process in about a second),
    // a big message before a station has signed in, and too many sockets from one address.
    {
      const capRelay = makeRelay({ log: () => {}, maxPerIp: 3 });
      const cport = await capRelay.listen(0, '127.0.0.1');
      const frameOf = (b0, payload) => {
        const body = Buffer.from(payload), len = body.length, mask = Buffer.from([7, 1, 9, 3]);
        let hdr;
        if (len < 126) hdr = Buffer.from([b0, 0x80 | len]);
        else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = b0; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
        else { hdr = Buffer.alloc(10); hdr[0] = b0; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        return Buffer.concat([hdr, mask, body]);
      };
      // opens a raw socket, completes the handshake, resolves { s, status, closed() } (closed = the relay hung up)
      const raw = (p) => new Promise((resolve) => {
        const s = net.connect(cport, '127.0.0.1', () => s.write('GET ' + p + ' HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
        let head = '', done = false, closed = false, closeCode = null;
        s.on('data', (d) => {
          if (!done) { head += d.toString('latin1'); if (head.indexOf('\r\n\r\n') >= 0) { done = true; resolve({ s, status: Number((/^HTTP\/1\.1 (\d+)/.exec(head) || [])[1]), closed: () => closed, code: () => closeCode }); } return; }
          if (d[0] === 0x88 && d.length >= 4) closeCode = d.readUInt16BE(2);
        });
        s.on('close', () => { closed = true; if (!done) { done = true; resolve({ s, status: 0, closed: () => true, code: () => null }); } });
        s.on('error', () => {});
      });
      const a = await raw('/v1/station');
      A.eq(a.status, 101, 'a station socket opens');
      const flood = [frameOf(0x01, 'x')];
      for (let i = 0; i < 4000; i++) flood.push(frameOf(0x00, ''));
      a.s.write(Buffer.concat(flood));
      await waitUntil(() => a.code() !== null || a.closed(), 3000, 'the flood is cut off');
      A.ok(a.code() === 1009 || a.code() === 1008 || a.closed(), 'a flood of empty continuation frames is cut off (close ' + a.code() + ')');
      A.eq((await fetch('http://127.0.0.1:' + cport + '/healthz').then(r => r.json())).ok, true, 'and the relay is still up');
      a.s.destroy();

      const b = await raw('/v1/station');
      b.s.write(frameOf(0x81, 'y'.repeat(64 * 1024)));
      await waitUntil(() => b.code() !== null || b.closed(), 3000, 'the big pre-auth frame is refused');
      A.eq(b.code(), 1009, 'a station that has not signed in may not send a big message');
      b.s.destroy();
      await sleep(150);

      const held = [await raw('/v1/station'), await raw('/v1/station'), await raw('/v1/station')];
      A.ok(held.every(x => x.status === 101), 'three sockets from one address are fine');
      const over = await raw('/v1/station');
      A.eq(over.status, 429, 'a fourth from the same address is refused at the door');
      for (const x of held.concat(over)) x.s.destroy();
      await sleep(150);
      A.eq((await raw('/v1/phone?rid=x')).status, 101, 'and once they close, the address may connect again');
      await capRelay.close();
    }

    // A phone that arrives while a station has just connected (its paired list not sent yet) WAITS for the list
    // instead of being told "not paired" (which used to make a healthy phone believe it was removed)
    {
      const keys = devices.stationKeys();
      const sws = new WebSocket(base.replace('http', 'ws') + '/v1/station');
      const got = [];
      let rid = null;
      await new Promise((resolve) => {
        sws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.t === 'challenge') sws.send(JSON.stringify({ t: 'auth', pub: keys.publicRaw, sig: C.b64u(nodeCrypto.sign('sha256', Buffer.from(LABEL + '|' + m.nonce), keys.privateKey)) }));
          else if (m.t === 'ready') { rid = m.rid; resolve(); }
          else got.push(m);
        };
      });
      const pws = new WebSocket(base.replace('http', 'ws') + '/v1/phone?rid=' + encodeURIComponent(rid) + '&tok=early-token');
      await new Promise(r => { pws.onopen = r; });
      pws.send(JSON.stringify({ t: 'hello', v: 1, deviceId: 'dev_early' }));
      await sleep(300);
      A.eq(got.filter(m => m.t === 'open').length, 0, 'the phone is held while the station has not said who is paired');
      sws.send(JSON.stringify({ t: 'tokens', hashes: [tokenHash('early-token')] }));
      await waitUntil(() => got.some(m => m.t === 'open') && got.some(m => m.t === 'from'), 3000, 'held phone admitted');
      A.eq(got.find(m => m.t === 'open').paired, true, 'then admitted as paired, its early hello delivered');
      try { pws.close(); sws.close(); } catch (_) {}
      await sleep(100);
    }

    rc = makeRelayClient({ url: base, devices, sessions, gateway, crypto: C, now: () => Date.now(), log: () => {} });
    rc.start();
    await waitUntil(() => rc.info().state === 'online', 5000, 'station online at the relay');
    const st = devices.stationKeys();
    A.eq(rc.info().rid, ridOf(st.publicRaw), 'the routing id is the hash of the station key');
    A.eq(await Phone.ridOf(st.publicRaw), rc.info().rid, 'the phone computes the same routing id from the QR');

    // a stranger (no pass) can't do anything but ask to pair
    A.eq(await wsClose(base.replace('http', 'ws') + '/v1/phone?rid=' + rc.info().rid), 4401, 'no relay pass: a hello is refused at the relay');
    A.eq(await wsClose(base.replace('http', 'ws') + '/v1/phone?rid=nope'), 4404, 'unknown station: 4404');

    // pair through the relay
    const p = devices.startPairing({});
    const key = await Phone.makeDeviceKey();
    let bad = null; try { await Phone.pairRelay({ relay: base, stationPub: st.publicRaw, pairingId: p.pairingId, code: 'WRONGCOD', name: 'Relay phone', key }); } catch (e) { bad = e.message; }
    A.ok(/wrong pairing code/.test(bad || ''), 'a wrong code over the relay is refused by the station: ' + bad);
    const paired = await Phone.pairRelay({ relay: base, stationPub: st.publicRaw, pairingId: p.pairingId, code: p.code, name: 'Relay phone', key });
    A.ok(/^dev_/.test(paired.deviceId), 'paired through the relay');
    A.ok(typeof paired.relayToken === 'string' && paired.relayToken.length >= 32, 'the phone got its relay pass');
    const raw = fs.readFileSync(path.join(dir, '.secrets', 'remote.json'), 'utf8');
    A.ok(raw.indexOf(paired.relayToken) < 0, 'the station stores only a hash of the pass');
    // GHSA-2hpj #7: a new phone has no session until the desk approves it (remote.core.test.js proves the refusal)
    A.eq([devices.list().find(d => d.id === paired.deviceId).pending, devices.activate(paired.deviceId).ok], [true, true], 'paired pending, then approved at the desk');

    // connect with the pass; sealed calls + events
    const c = Phone.connectRelay({ relay: base, stationPub: st.publicRaw, deviceId: paired.deviceId, relayToken: paired.relayToken, key });
    const states = []; c.onStatus((s) => states.push(s));
    const events = []; c.onEvent((e) => events.push(e));
    const s1 = await c.call('status');
    A.eq(s1.data.station, 'TEST STATION', 'status over the relay');
    A.ok(states.indexOf('open') >= 0, 'the link reports open only after the sealed handshake');
    sessions.broadcast({ type: 'hello.phone', n: 7 });
    await waitUntil(() => events.length > 0, 3000, 'event over the relay');
    A.eq(events[0], { type: 'hello.phone', n: 7 }, 'a station event arrives sealed and opens on the phone');

    const decided = [];
    const done = approvals.add({ runId: 'rR', promptId: 'pR', agentId: 'forge', surface: 'remote', tool: 'shell.exec', argsSummary: 'npm test', finish: (d) => decided.push(d) });
    A.eq((await c.call('approvals')).data.length, 1, 'the approval is listed over the relay');
    A.eq((await c.call('decide', { runId: 'rR', promptId: 'pR', decision: 'always' })).ok, false, 'no ALWAYS from a phone over the relay');
    A.eq((await c.call('decide', { runId: 'rR', promptId: 'pR', decision: 'once' })).ok, true, 'approve once over the relay');
    A.eq(decided, ['once'], 'the waiter got it');
    done();

    // the station drops the session (idle expiry, restart) while the socket stays up: the client recovers by itself
    for (const s of sessions.list()) sessions.end(s.id);
    const again = await c.call('status');
    A.eq(again.ok && again.data.station, 'TEST STATION', 'a dropped station session is re-established transparently');

    // parallel calls resolve to the right replies
    const [a1, a2, a3] = await Promise.all([c.call('ping'), c.call('status'), c.call('approvals')]);
    A.ok(a1.ok && a2.data.station === 'TEST STATION' && Array.isArray(a3.data), 'concurrent calls are matched to their own replies');

    // what the relay holds: routing only
    const rs = relay._stations.get(rc.info().rid);
    A.ok(rs && rs.tokens.size === 1 && !rs.tokens.has(paired.relayToken), 'the relay keeps only pass hashes');

    // revoke: kicked at the relay, pass dead
    devices.revoke(paired.deviceId); sessions.endDevice(paired.deviceId); rc.kickDevice(paired.deviceId);
    await waitUntil(() => states[states.length - 1] === 'closed', 3000, 'phone kicked');
    let refused = null; try { await c.call('status'); } catch (e) { refused = e.message; }
    A.ok(/not paired|removed|closed|refused|unknown/.test(refused || ''), 'a revoked phone cannot reconnect: ' + refused);

    // a second phone survives a relay restart
    const p2 = devices.startPairing({});
    const key2 = await Phone.makeDeviceKey();
    const paired2 = await Phone.pairRelay({ relay: base, stationPub: st.publicRaw, pairingId: p2.pairingId, code: p2.code, name: 'Tablet', key: key2 });
    devices.activate(paired2.deviceId);
    const c2 = Phone.connectRelay({ relay: base, stationPub: st.publicRaw, deviceId: paired2.deviceId, relayToken: paired2.relayToken, key: key2 });
    A.eq((await c2.call('ping')).ok, true, 'second phone linked');
    // a paired phone cannot say hello as ANOTHER paired phone (its relay pass belongs to its own device)
    {
      const rid = ridOf(st.publicRaw);
      const spoof = new WebSocket(base.replace('http', 'ws') + '/v1/phone?rid=' + encodeURIComponent(rid) + '&tok=' + encodeURIComponent(paired2.relayToken));
      const ans = await new Promise((resolve) => {
        spoof.onopen = () => spoof.send(JSON.stringify({ t: 'hello', v: 1, deviceId: paired.deviceId, eph: key2.publicRaw, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' }));
        spoof.onmessage = (ev) => resolve(JSON.parse(ev.data));
        setTimeout(() => resolve(null), 4000);
      });
      A.eq(ans && ans.t === 'error' && ans.error, 'unknown device', 'a phone using its own pass to speak as another phone is refused');
      try { spoof.close(); } catch (_) {}
    }
    const closed2 = [];
    c2.onStatus((s, d) => { if (s === 'closed') closed2.push(d && d.code); });
    await relay.close();
    await waitUntil(() => rc.info().state === 'offline', 5000, 'station notices the relay is gone');
    A.ok(closed2.length > 0, 'the phone sees the link drop');
    relay = makeRelay({ log: () => {} });
    port = await relay.listen(port, '127.0.0.1');
    await waitUntil(() => rc.info().state === 'online', 15000, 'station back online by itself');
    A.eq((await c2.call('status')).ok, true, 'the phone reconnects after the relay restart');

    // the station stops -> phones are told the station is offline
    const offline = [];
    c2.onStatus((s, d) => { if (s === 'closed') offline.push(d && d.code); });
    rc.stop();
    await waitUntil(() => offline.includes(4404), 5000, 'phone told station offline');
    A.ok(true, 'station stop -> phone gets 4404 station offline');
    c2.close();
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e));
  } finally {
    try { rc && rc.stop(); } catch (_) {}
    await relay.close().catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  // (sweep 2026-10-02) a link that is replaced right after 'ready' (two stations on one key: close 4410) keeps backing
  // off — the backoff used to reset on every 'ready', so they swapped once a second forever and dropped every phone
  {
    let clock = 1000;
    const socks = [];
    class FakeWS { constructor() { socks.push(this); setImmediate(() => { if (this.onopen) this.onopen(); this.onmessage({ data: JSON.stringify({ t: 'ready', rid: 'r1' }) }); setImmediate(() => this.onclose({ code: 4410, reason: 'replaced' })); }); } send() {} close() {} }
    const rc2 = makeRelayClient({ url: 'ws://relay.test', devices: { stationKeys() { return {}; }, relayTokenHashes() { return []; } }, sessions: {}, gateway: {}, crypto: C, WebSocketImpl: FakeWS, now: () => clock, log: () => {} });
    rc2.start();
    await new Promise(r => setTimeout(r, 30));
    const first = rc2.info().retryInMs;
    clock += 2000;   // reconnects before it ever held STABLE_MS
    await new Promise(r => setTimeout(r, first + 200));
    const second = rc2.info().retryInMs;
    A.ok(first === 1000 && second === 2000, 'a link replaced right after ready keeps backing off (1s then 2s), never a 1s loop: ' + first + ' then ' + second);
    rc2.stop();
  }
  // (2026-10-09) a dial that never opens (network lost mid-connect) is abandoned and retried, never 'connecting' forever
  {
    const socks = [];
    class HangWS { constructor() { this.closed = false; socks.push(this); } send() {} close() { this.closed = true; } }
    const rc3 = makeRelayClient({ url: 'ws://relay.test', devices: { stationKeys() { return {}; }, relayTokenHashes() { return []; } }, sessions: {}, gateway: {}, crypto: C, WebSocketImpl: HangWS, now: () => Date.now(), log: () => {}, connectTimeoutMs: 40 });
    rc3.start();
    A.eq(rc3.info().state, 'connecting', 'the first dial is connecting');
    await new Promise(r => setTimeout(r, 90));
    A.eq(rc3.info().state, 'offline', 'a dial that never opens is given up: ' + rc3.info().state);
    A.ok(/did not answer/.test(String(rc3.info().lastError)), 'and says why: ' + rc3.info().lastError);
    A.ok(socks[0].closed, 'the hung socket is closed');
    if (socks[0].onclose) socks[0].onclose({ code: 1006 });   // a late close from the abandoned socket changes nothing
    A.eq(rc3.info().state, 'offline', 'a late close from the abandoned dial is ignored');
    await new Promise(r => setTimeout(r, 1100));
    A.ok(socks.length >= 2, 'and the link dials again on the backoff (' + socks.length + ' dials)');
    rc3.stop();
    A.eq(rc3.info().state, 'off', 'stop clears the pending dial');
  }
  // (sweep 2026-10-02) per-address limits count an IPv6 host by its /64; a data frame is checked WITH the held fragments
  {
    const { addrKey } = require('../relay/server.js');
    A.eq([addrKey('2001:db8:85a3::8a2e:370:7334'), addrKey('2001:db8:85a3:0:ffff::1'), addrKey('::ffff:1.2.3.4'), addrKey('1.2.3.4')],
      ['2001:db8:85a3:0::/64', '2001:db8:85a3:0::/64', '1.2.3.4', '1.2.3.4'], 'one IPv6 /64 is one address; IPv4-mapped is its IPv4');
    const { makeWsServer } = require('../relay/ws-lite.js');
    const EventEmitter = require('events');
    const wss = makeWsServer({ maxPayload: 1000 });
    const sock = new EventEmitter(); const wrote = [];
    sock.write = (b) => { wrote.push(Buffer.from(b)); return true; }; sock.destroy = () => {}; sock.setNoDelay = () => {}; sock.end = () => {};
    const req = { method: 'GET', headers: { upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } };
    let ws = null; wss.handleUpgrade(req, sock, Buffer.alloc(0), (w) => { ws = w; });
    const frameHdr = (fin, op, len) => { const mask = Buffer.from([1, 2, 3, 4]);
      const h = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | len]) : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | 126]), Buffer.from([len >> 8, len & 255])]);
      return Buffer.concat([h, mask]); };
    sock.emit('data', Buffer.concat([frameHdr(false, 0x1, 600), Buffer.alloc(600)]));   // first fragment: 600 of 1000
    const before = wrote.length;
    sock.emit('data', frameHdr(true, 0x0, 600));   // a continuation that would take the message to 1200: header only
    A.ok(wrote.slice(before).some((b) => b[0] === 0x88), 'a fragment that would overflow the message is refused at its header, before its bytes are buffered');
    A.ok(ws && ws.readyState !== 1, 'and the socket is closed');
  }
  A.report('remote relay');
})();
