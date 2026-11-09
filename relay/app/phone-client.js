/* relay/app/phone-client.js — the PHONE side of the sealed channel, written against WebCrypto only.

   This exact file is what the phone app will load (phase 2) and what the tests drive under Node, whose
   globalThis.crypto.subtle is the same WebCrypto API a phone browser has. So every test that passes here
   proves the station speaks to a real browser's crypto, not to a Node-only twin of itself.

   Uses only: crypto.subtle (P-256 ECDH, HKDF-SHA256, AES-GCM, HMAC), crypto.getRandomValues, TextEncoder,
   fetch, and optionally a stream reader for events. No Node modules.

     const kp = await PhoneClient.makeDeviceKey()                 // { privateKey:CryptoKey, publicRaw }
     const p  = await PhoneClient.pair({ base, pairingId, secret, name, key: kp })
     const c  = PhoneClient.connect({ base, deviceId, stationPub, key: kp })          LAN door (HTTP; tests, local tools)
     await c.open();  await c.call('status');  c.onEvent(fn);  await c.listen();  c.close()
     const p2 = await PhoneClient.pairRelay({ relay, stationPub, pairingId, secret, name, key: kp })
     const r  = PhoneClient.connectRelay({ relay, stationPub, deviceId, relayToken, key: kp })   the product path
     await r.open(); await r.call('status'); r.onEvent(fn); r.onStatus(fn); r.close()
   secret = the pairing link's `c`: the station's 128-bit secret for that one pairing (GHSA-2hpj #7). An older caller's
   `code` is taken in its place; the station refuses a proof made with the short code itself. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhoneClient = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LABEL = 'starnet-remote/1';
  const VERSION = 1;
  const subtle = () => globalThis.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();

  function b64u(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function randomB64u(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b64u(b); }

  const EC = { name: 'ECDH', namedCurve: 'P-256' };

  async function makeKeyPair(extractable) {
    const kp = await subtle().generateKey(EC, !!extractable, ['deriveBits']);
    const raw = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
    return { privateKey: kp.privateKey, publicRaw: b64u(raw) };
  }
  // The device key is made once at pairing. Non-extractable: the phone can use it but script can't read it out.
  function makeDeviceKey() { return makeKeyPair(false); }
  async function importPub(raw) { return subtle().importKey('raw', unb64u(raw), EC, false, []); }
  async function ecdh(priv, pubRaw) { return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: await importPub(pubRaw) }, priv, 256)); }

  async function deriveKeys(o) {
    const ee = await ecdh(o.ephPrivate, o.stationEph);
    const ss = await ecdh(o.devicePrivate, o.stationPub);
    const salt = new Uint8Array(await subtle().digest('SHA-256', concat([
      enc.encode(LABEL), unb64u(o.stationPub), unb64u(o.devicePub), unb64u(o.stationEph), unb64u(o.phoneEph),
      unb64u(o.phoneNonce), unb64u(o.stationNonce)
    ])));
    const ikm = await subtle().importKey('raw', concat([ee, ss]), 'HKDF', false, ['deriveKey']);
    const key = (info, usage) => subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, ikm, { name: 'AES-GCM', length: 256 }, false, usage);
    return { p2s: await key('p2s', ['encrypt']), s2p: await key('s2p', ['decrypt']) };
  }

  async function seal(key, dir, seq, obj) {
    const iv = new Uint8Array(12); globalThis.crypto.getRandomValues(iv);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(dir + ':' + seq) }, key, enc.encode(JSON.stringify(obj))));
    return { seq, iv: b64u(iv), ct: b64u(ct) };
  }
  async function open(key, dir, frame) {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64u(frame.iv), additionalData: enc.encode(dir + ':' + frame.seq) }, key, unb64u(frame.ct));
    return JSON.parse(dec.decode(pt));
  }

  const open_ = open;   // the relay transport below has its own open(); keep a name for the decrypt

  // "A1B2-C3D4-E5F6": the same short code the desk shows for its station key, so a person can compare them
  async function fingerprint(publicRaw) {
    const h = new Uint8Array(await subtle().digest('SHA-256', unb64u(publicRaw)));
    let hex = ''; for (let i = 0; i < 6; i++) hex += h[i].toString(16).padStart(2, '0');
    hex = hex.toUpperCase();
    return hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12);
  }

  async function pairingProof(code, devicePub, name) {
    const k = await subtle().importKey('raw', enc.encode(String(code)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64u(new Uint8Array(await subtle().sign('HMAC', k, enc.encode(LABEL + '|pair|' + devicePub + '|' + (name == null ? '' : name)))));
  }

  async function postJson(fetchFn, url, body) {
    const r = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j || {} };
  }

  async function pair(o) {
    const fetchFn = o.fetch || fetch;
    const name = String(o.name || 'Phone');
    const proof = await pairingProof(o.secret != null ? o.secret : o.code, o.key.publicRaw, name);   // the link's secret (GHSA-2hpj #7); `code` from an older caller
    const r = await postJson(fetchFn, o.base + '/remote/v1/pair', { pairingId: o.pairingId, publicKey: o.key.publicRaw, name, proof });
    if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error || ('pairing failed (' + r.status + ')'));
    return r.body;
  }

  function connect(o) {
    const fetchFn = o.fetch || fetch;
    const state = { sid: null, keys: null, seq: 0, lastRes: 0, lastEv: 0, nextId: 1, handlers: [], abort: null };

    async function openSession() {
      const eph = await makeKeyPair(false);
      const nonce = randomB64u(16);
      const r = await postJson(fetchFn, o.base + '/remote/v1/hello', { v: VERSION, deviceId: o.deviceId, eph: eph.publicRaw, nonce });
      if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error || ('hello refused (' + r.status + ')'));
      const w = r.body.welcome;
      state.keys = await deriveKeys({
        ephPrivate: eph.privateKey, devicePrivate: o.key.privateKey,
        stationPub: o.stationPub, devicePub: o.key.publicRaw,
        stationEph: w.eph, phoneEph: eph.publicRaw, phoneNonce: nonce, stationNonce: w.nonce
      });
      state.sid = w.sessionId; state.seq = 0; state.lastRes = 0; state.lastEv = 0;
      return w.sessionId;
    }

    async function call(verb, args) {
      if (!state.sid) await openSession();
      const id = state.nextId++;
      state.seq += 1;
      const frame = await seal(state.keys.p2s, 'p2s', state.seq, { id, verb, args: args || {} });
      const r = await postJson(fetchFn, o.base + '/remote/v1/call', { sessionId: state.sid, frame });
      if (r.status === 401) { state.sid = null; throw new Error('session expired'); }
      if (r.status !== 200 || !r.body.ok) throw new Error(r.body.error || ('call failed (' + r.status + ')'));
      const f = r.body.frame;
      if (!f || f.seq <= state.lastRes) throw new Error('stale reply');
      const reply = await open(state.keys.s2p, 's2p', f);   // throws if anything in the middle touched it
      state.lastRes = f.seq;
      if (reply.id !== id) throw new Error('reply for a different request');
      return reply;
    }

    function onEvent(fn) { state.handlers.push(fn); }

    // Reads the sealed event stream until closed. Resolves when the stream ends.
    async function listen() {
      if (!state.sid) await openSession();
      state.abort = new AbortController();
      const r = await fetchFn(o.base + '/remote/v1/events?sid=' + encodeURIComponent(state.sid), { signal: state.abort.signal });
      if (r.status !== 200) throw new Error('events refused (' + r.status + ')');
      const reader = r.body.getReader();
      let buf = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split('\n').find(l => l.indexOf('data:') === 0);
            if (!line) continue;
            let f; try { f = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (!f || f.seq <= state.lastEv) continue;           // replayed or reordered: refuse
            let ev; try { ev = await open(state.keys.s2p, 's2e', f); } catch (_) { continue; }   // tampered: drop
            state.lastEv = f.seq;
            for (const h of state.handlers) { try { h(ev); } catch (_) {} }
          }
        }
      } catch (_) { /* aborted or dropped */ }
    }

    function close() { try { state.abort && state.abort.abort(); } catch (_) {} }

    return { open: openSession, call, onEvent, listen, close, _state: state };
  }


  /* ---- RELAY transport (the product path): one WebSocket to the relay, which switches sealed frames to the
     station. Works from anywhere; the page must be HTTPS (or localhost) because WebCrypto needs a secure
     context. The relay never sees inside a frame. */
  function wsUrlOf(relay) {
    const u = String(relay || '').replace(/\/+$/, '');
    return u.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  }
  async function ridOf(stationPub) {
    const h = new Uint8Array(await subtle().digest('SHA-256', unb64u(stationPub)));
    return b64u(h).slice(0, 22);
  }

  // Pair over the relay: no relay token yet, so the relay lets exactly this one kind of message through.
  async function pairRelay(o) {
    const WS = o.WebSocket || globalThis.WebSocket;
    const name = String(o.name || 'Phone');
    const proof = await pairingProof(o.secret != null ? o.secret : o.code, o.key.publicRaw, name);   // the link's secret (GHSA-2hpj #7); `code` from an older caller
    const rid = await ridOf(o.stationPub);
    return new Promise((resolve, reject) => {
      const ws = new WS(wsUrlOf(o.relay) + '/v1/phone?rid=' + encodeURIComponent(rid));
      let done = false;
      const finish = (err, val) => { if (done) return; done = true; try { ws.close(); } catch (_) {} if (err) reject(err); else resolve(val); };
      const timer = setTimeout(() => finish(new Error('the station did not answer the pairing request')), 20000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'pair', pairingId: o.pairingId, publicKey: o.key.publicRaw, name, proof }));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        clearTimeout(timer);
        if (m && m.t === 'paired') finish(null, m);
        else finish(new Error((m && m.error) || 'pairing failed'));
      };
      ws.onclose = (ev) => { clearTimeout(timer); finish(new Error(closeReason(ev))); };
    });
  }

  function closeReason(ev) {
    const c = ev && ev.code;
    if (c === 4404) return 'station offline';
    if (c === 4401) return 'this phone is not paired with that station (or was removed)';
    if (c === 4429) return 'too many requests — wait a moment';
    if (c === 4410) return 'the station reconnected';
    return 'connection closed' + (c ? ' (' + c + ')' : '');
  }

  function connectRelay(o) {
    const WS = o.WebSocket || globalThis.WebSocket;
    const st = { ws: null, sid: null, keys: null, seq: 0, lastRes: 0, lastEv: 0, nextId: 1, pending: new Map(), bySeq: new Map(),
      handlers: [], statusHandlers: [], opening: null, openState: 'closed' };
    const status = (s, detail) => { st.openState = s; for (const h of st.statusHandlers) { try { h(s, detail); } catch (_) {} } };

    function failAll(err) {
      for (const p of st.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      st.pending.clear(); st.bySeq.clear();
    }

    function open() {
      if (st.opening) return st.opening;
      st.opening = (async () => {
        const rid = await ridOf(o.stationPub);
        const eph = await makeKeyPair(false);
        const nonce = randomB64u(16);
        status('connecting');
        const ws = new WS(wsUrlOf(o.relay) + '/v1/phone?rid=' + encodeURIComponent(rid) + '&tok=' + encodeURIComponent(o.relayToken || ''));
        st.ws = ws;
        await new Promise((resolve, reject) => {
          let welcomed = false, deriving = false;
          const early = [];   // frames that arrive while the keys are still being derived (events never wait for us)
          const timer = setTimeout(() => reject(new Error('the station did not answer')), 20000);
          ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: VERSION, deviceId: o.deviceId, eph: eph.publicRaw, nonce }));
          ws.onmessage = async (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
            if (deriving) { if (early.length < 64) early.push(m); return; }
            if (!welcomed) {
              if (m && m.t === 'welcome') {
                deriving = true;
                const w = m.welcome;
                try {
                  st.keys = await deriveKeys({ ephPrivate: eph.privateKey, devicePrivate: o.key.privateKey, stationPub: o.stationPub, devicePub: o.key.publicRaw,
                    stationEph: w.eph, phoneEph: eph.publicRaw, phoneNonce: nonce, stationNonce: w.nonce });
                } catch (e) { clearTimeout(timer); return reject(e); }
                st.sid = w.sessionId; st.seq = 0; st.lastRes = 0; st.lastEv = 0; welcomed = true; deriving = false;
                clearTimeout(timer); resolve();
                for (const f of early.splice(0)) onFrame(f);
              } else { clearTimeout(timer); reject(new Error((m && m.error) || 'hello refused')); }
              return;
            }
            onFrame(m);
          };
          ws.onclose = (ev) => {
            clearTimeout(timer);
            const why = closeReason(ev);
            st.ws = null; st.sid = null; st.keys = null; st.opening = null;
            failAll(new Error(why));
            status('closed', { code: ev && ev.code, reason: why });
            if (!welcomed) reject(new Error(why));
          };
        });
        status('open');
      })();
      st.opening.catch(() => { st.opening = null; });
      return st.opening;
    }

    async function onFrame(m) {
      if (!m) return;
      if (m.t === 'res' && m.frame) {
        const f = m.frame;
        if (f.seq <= st.lastRes) return;                                   // replay: refuse
        let reply; try { reply = await open_(st.keys.s2p, 's2p', f); } catch (_) { return; }   // tampered: drop
        st.lastRes = f.seq;
        const p = st.pending.get(reply.id);
        if (p) { st.pending.delete(reply.id); st.bySeq.delete(p.seq); clearTimeout(p.timer); p.resolve(reply); }
        return;
      }
      if (m.t === 'ev' && m.frame) {
        const f = m.frame;
        if (f.seq <= st.lastEv) return;
        let ev; try { ev = await open_(st.keys.s2p, 's2e', f); } catch (_) { return; }
        st.lastEv = f.seq;
        for (const h of st.handlers) { try { h(ev); } catch (_) {} }
        return;
      }
      if (m.t === 'error') {
        const id = st.bySeq.get(m.seq);
        const p = id != null ? st.pending.get(id) : null;
        if (p) { st.pending.delete(id); st.bySeq.delete(m.seq); clearTimeout(p.timer); p.reject(new Error(m.error || 'request refused')); }
      }
    }

    // The station forgets an idle session after ten minutes (and any session when it restarts) while the socket to
    // the relay can stay up. That answers 'no session'. Shake hands again on a fresh socket and send the call once
    // more, so the person never sees it.
    function reopen() {
      const ws = st.ws;
      st.ws = null; st.sid = null; st.keys = null; st.opening = null;
      failAll(new Error('reconnecting'));
      if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch (_) {} }
      return open();
    }
    async function call(verb, args, timeoutMs) {
      try { return await callOnce(verb, args, timeoutMs); }
      catch (e) {
        if (!/no session|stale frame|bad frame/.test(String(e && e.message))) throw e;
        await reopen();
        return callOnce(verb, args, timeoutMs);
      }
    }
    // sealing is async: chain it, so frame n always leaves before frame n+1 (the station refuses an older seq)
    let sendChain = Promise.resolve();
    async function callOnce(verb, args, timeoutMs) {
      await open();
      const id = st.nextId++;
      let seq, frame;
      const turn = sendChain.then(async () => { st.seq += 1; seq = st.seq; frame = await seal(st.keys.p2s, 'p2s', seq, { id, verb, args: args || {} }); });
      sendChain = turn.catch(() => {});
      await turn;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { st.pending.delete(id); st.bySeq.delete(seq); reject(new Error('the station took too long to answer')); }, timeoutMs || 30000);
        st.pending.set(id, { resolve, reject, timer, seq });
        st.bySeq.set(seq, id);
        try { st.ws.send(JSON.stringify({ t: 'call', frame })); } catch (e) { clearTimeout(timer); st.pending.delete(id); st.bySeq.delete(seq); reject(e); }
      });
    }

    function close() { const ws = st.ws; if (ws) { try { ws.close(); } catch (_) {} } }

    return { open, call, close, onEvent: (fn) => st.handlers.push(fn), onStatus: (fn) => st.statusHandlers.push(fn), state: () => st.openState, _state: st };
  }

  return { VERSION, LABEL, makeDeviceKey, pair, connect, pairRelay, connectRelay, ridOf, fingerprint, pairingProof, _b64u: b64u, _unb64u: unb64u, _seal: seal, _open: open, _deriveKeys: deriveKeys, _makeKeyPair: makeKeyPair };
}));
