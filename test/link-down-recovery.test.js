/* node test/link-down-recovery.test.js — LINK DOWN says why and offers a way out (customer report 2026-10-07:
   "I tried quitting/restarting the application, but I could not find where I could do this").

   F2: after the game loaded, a crash-loop-held or hung station service showed only a red LINK DOWN — no reason,
   no restart, silent polling forever. The reason probe and the restart lived only on the boot SAVE-UNKNOWN screen.
   Now one shared reading (Harness.engineState: the sidecar's verbatim 503 'degraded: …' line or the guardian halt,
   bounded so a hung service cannot strand it) and one restart door (Harness.restartEngine, single-flight) serve both
   the boot screen and the in-game chip; COMMS names a degraded reason once instead of polling silently.
   F5: every pairing-start failure read "could not reach the link service". Friendly.linkStartFailure words it from
   facts: a dead LOCAL engine, the sidecar's classified cloud failure (tls / timeout / dns / unreachable / 5xx).

   harness.js and topbar.js are browser IIFEs: harness functions are lifted by fnBody and RUN against fakes (the
   house pattern, harness.cancel-truth.test.js); topbar.js runs in a vm with a stub DOM (commander-progression-ui). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', f), 'utf8');
const harnessSrc = read('app/harness.js');
const topbarSrc = read('app/topbar.js');
const chatSrc = read('app/chat.js');
const appSrc = read('app/app.js');
const stationuiSrc = read('app/stationui.js');
const Friendly = require('../frontend/app/friendlyerror.js');

const DEGRADED = 'degraded: crash-loop: 3 faults in 10m — last: TypeError: boom';

// ---- lift engineState / restartEngine out of the Harness IIFE, bound to a fake fetch + window ----
function liftHarness(fetchImpl, win) {
  const parts = ['function tauriCoreNow', 'async function engineState', 'function restartEngine'].map(h => {
    const b = A.fnBody(harnessSrc, h);
    A.ok(b.length > 40 && b.length < 4000, h + ' located (length guard)');
    return b;
  });
  return new Function('fetch', 'window', 'let restartInflight = null;\n' + parts.join('\n') + '\nreturn { engineState, restartEngine, tauriCoreNow };')(fetchImpl, win);
}
const textReply = (status, text) => async () => ({ ok: status === 200, status, text: async () => text });

(async () => {
  /* ---- Harness.engineState: the service's own words, bounded ---- */
  {
    const browser = {};
    let H = liftHarness(textReply(503, DEGRADED + '\n'), browser);
    A.eq(await H.engineState(200), { state: 'degraded', reason: DEGRADED }, 'a 503 degraded line is returned VERBATIM (trimmed), never reworded');
    H = liftHarness(textReply(200, 'ok'), browser);
    A.eq(await H.engineState(200), { state: 'ok', reason: '' }, 'a 200 is a live service — no invented reason');
    H = liftHarness(textReply(503, 'something else'), browser);
    A.eq((await H.engineState(200)).reason, '', 'a 503 that does not say degraded is not quoted as a reason');
    H = liftHarness(async () => { throw new TypeError('Failed to fetch'); }, browser);
    A.eq(await H.engineState(200), { state: 'down', reason: '' }, 'a refused request reads down');
    const hung = () => new Promise(() => {});   // a hung service never answers
    H = liftHarness(hung, browser);
    const t0 = Date.now();
    A.eq((await H.engineState(60)).state, 'silent', 'a hung service resolves silent inside the budget instead of pending forever');
    A.ok(Date.now() - t0 < 2000, 'the probe is bounded');
    // desktop: the guardian's halt names a dead service's reason
    const invoked = [];
    const desk = { __TAURI__: { core: { invoke: async (cmd) => { invoked.push(cmd); if (cmd === 'starnet_sidecar_status') return { halted: true, reason: 'sidecar crashed 5 times' }; return true; } } } };
    H = liftHarness(async () => { throw new TypeError('Failed to fetch'); }, desk);
    A.eq((await H.engineState(200)).reason, 'station service halted: sidecar crashed 5 times', 'a halted guardian is the reason for a dead service');
    H = liftHarness(textReply(200, 'ok'), desk);
    await H.engineState(200);
    A.ok(!invoked.slice(1).includes('starnet_sidecar_status'), 'a healthy service never consults the guardian');
  }

  /* ---- Harness.restartEngine: desktop only, single-flight ---- */
  {
    A.eq(await liftHarness(textReply(200, 'ok'), {}).restartEngine(), false, 'a browser has nothing to restart');
    let calls = 0, release;
    const desk = { __TAURI__: { core: { invoke: (cmd) => { if (cmd === 'starnet_restart_sidecar') { calls++; return new Promise(r => { release = r; }); } return Promise.resolve(null); } } } };
    const H = liftHarness(textReply(200, 'ok'), desk);
    const a = H.restartEngine(), b = H.restartEngine();
    A.ok(a === b, 'a double click shares one restart');
    await new Promise(r => setTimeout(r, 0));
    release(true);
    A.eq([await a, calls], [true, 1], 'exactly one starnet_restart_sidecar per click burst');
    const failing = liftHarness(textReply(200, 'ok'), { __TAURI__: { core: { invoke: async () => { throw new Error('StarNet is shutting down'); } } } });
    A.eq(await failing.restartEngine(), false, 'a refused restart is false, never a thrown page error');
  }

  /* ---- topbar LINK DOWN chip: reason after 15s, restart door on desktop only ---- */
  function mountTopbar(opts) {
    let now = 1000000;
    const listeners = {};
    const attrs = {};
    const cls = new Set(['tb-connection']);
    const box = {
      classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: c => cls.has(c) },
      setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: k => { delete attrs[k]; if (k === 'tabindex') delete box.tabIndex; },
      addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }
    };
    const sigCls = new Set();
    const bars = { textContent: '' };
    const sig = {
      title: '', childNodes: [{ nodeValue: 'UPLINK ' }], querySelector: () => bars,
      classList: { add: c => sigCls.add(c), remove: (...c) => c.forEach(x => sigCls.delete(x)) },
      closest: () => box
    };
    const restarts = [], notes = [];
    let link = { bridged: true, down: true, paused: false };
    let engine = opts.engine;
    const ctx = vm.createContext({
      module: { exports: {} }, setInterval() {}, Promise,
      Date: { now: () => now },
      document: { readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelector: s => (s === '#sig' ? sig : null) },
      World: { linkState: () => link },
      StationUI: { notify: (t, c) => notes.push([t, c]) },
      Harness: {
        canRestartEngine: () => !!opts.desktop,
        engineState: async () => engine,
        restartEngine: async () => { restarts.push(1); return opts.restartOk !== false; }
      }
    });
    vm.runInContext(topbarSrc, ctx);
    const T = ctx.module.exports.Topbar;
    return {
      T, sig, box, attrs, cls, listeners, restarts, notes,
      advance: ms => { now += ms; }, setLink: l => { link = l; }, setEngine: e => { engine = e; },
      settle: () => new Promise(r => setTimeout(r, 0))
    };
  }
  {
    const m = mountTopbar({ desktop: true, engine: { state: 'degraded', reason: DEGRADED } });
    m.T._paintSig();
    A.eq(m.sig.childNodes[0].nodeValue, 'LINK DOWN ', 'a fresh drop paints the plain LINK DOWN');
    A.ok(!m.cls.has('recoverable'), 'no restart door before the link has stayed down');
    m.advance(15000); m.T._paintSig(); await m.settle(); await m.settle();
    A.ok(m.sig.title.indexOf(DEGRADED) === 0, 'after 15s the tip carries the service\'s own reason verbatim: ' + m.sig.title);
    A.ok(/click to restart the station service/.test(m.sig.title), 'and, on the desktop, the way out');
    A.eq(m.sig.childNodes[0].nodeValue, 'LINK DOWN · RESTART ', 'the label itself shows the door (a tip alone is undiscoverable)');
    A.ok(m.cls.has('recoverable') && m.attrs.role === 'button', 'the connection box becomes a keyboard-reachable button');
    m.listeners.click[0](); m.listeners.click[0]();
    await m.settle(); await m.settle(); await m.settle();
    A.eq(m.restarts.length, 1, 'a double click restarts once');
    A.ok(m.notes.some(n => /restarting the station service/.test(n[0])), 'the restart is announced');
    A.ok(m.notes.some(n => /still reports: degraded: crash-loop/.test(n[0])), 'a respawn that comes back degraded is not claimed as healed');
    m.setEngine({ state: 'ok', reason: '' });
    m.setLink({ bridged: true, down: false, paused: false }); m.T._paintSig();
    A.ok(!m.cls.has('recoverable') && !m.attrs.role, 'a recovered link drops the door');
    A.eq(m.sig.childNodes[0].nodeValue, 'UPLINK ', 'and paints UPLINK');
  }
  {
    // a hung service: no reason came back, the door is still offered (the restart is not gated on a reason)
    const m = mountTopbar({ desktop: true, engine: { state: 'silent', reason: '' } });
    m.T._paintSig(); m.advance(16000); m.T._paintSig(); await m.settle(); await m.settle();
    A.ok(/isn’t answering \(it may be stuck\)/.test(m.sig.title) && m.cls.has('recoverable'), 'a hung service gets an honest tip and the restart door');
    const r = mountTopbar({ desktop: true, engine: { state: 'down', reason: '' }, restartOk: false });
    r.T._paintSig(); r.advance(16000); r.T._paintSig(); await r.settle(); await r.settle();
    r.listeners.click[0](); await r.settle(); await r.settle();
    A.ok(r.notes.some(n => /could not be restarted — quit StarNet fully/.test(n[0])), 'a failed restart names the last-resort step');
  }
  {
    // the service answers 200: the engine is fine, restarting it would kill live work — no door, a truthful tip
    const m = mountTopbar({ desktop: true, engine: { state: 'ok', reason: '' } });
    m.T._paintSig(); m.advance(16000); m.T._paintSig(); await m.settle(); await m.settle();
    A.ok(!m.cls.has('recoverable'), 'a healthy service is never offered for restart');
    A.ok(/service itself is answering/.test(m.sig.title), 'the tip says the service answered (measured), not "is the app running?"');
  }
  {
    // browser mode: nothing to restart — no button, the tip names where the service lives
    const m = mountTopbar({ desktop: false, engine: { state: 'down', reason: '' } });
    m.T._paintSig(); m.advance(16000); m.T._paintSig(); await m.settle(); await m.settle();
    A.ok(!m.cls.has('recoverable') && !m.attrs.role, 'browser mode never shows a restart door');
    A.ok(/npm start/.test(m.sig.title) && !/click to restart/.test(m.sig.title), 'browser mode names the honest next step');
    m.listeners.click[0](); await m.settle();
    A.eq(m.restarts.length, 0, 'a click in browser mode restarts nothing');
  }
  {
    // a deliberate pause / never-bridged link is standby, never a fault door
    const m = mountTopbar({ desktop: true, engine: { state: 'down', reason: '' } });
    m.setLink({ bridged: true, down: true, paused: true });
    m.T._paintSig(); m.advance(20000); m.T._paintSig(); await m.settle();
    A.ok(!m.cls.has('recoverable') && m.sig.childNodes[0].nodeValue === 'STANDBY ', 'paused reads STANDBY with no door');
  }

  /* ---- COMMS names a degraded reason once instead of polling silently; the boot screen shares the door ---- */
  {
    const body = A.fnBody(chatSrc, 'async function probeReconnect');
    A.ok(body.length > 100 && body.length < 4000, 'probeReconnect located (length guard)');
    A.ok(/r\.status === 503[\s\S]{0,120}\/\^degraded\/i/.test(body), 'probeReconnect reads the 503 degraded line');
    A.ok(/degraded !== lastDegradedLine[\s\S]{0,200}toolLine\(/.test(body), 'and writes it to COMMS once per reason');
    A.ok(/lastDegradedLine = ''/.test(body), 'a recovered service resets the once-guard');
    const gate = A.fnBody(appSrc, 'function showSaveUnreachableGate');
    A.ok(gate.length > 1000, 'boot gate located');
    A.ok(/Harness\.engineState\(\)/.test(gate) && /Harness\.restartEngine\(\)/.test(gate), 'the boot recovery screen uses the same reason probe and restart door');
    A.ok(!/core\.invoke\('starnet_restart_sidecar'\)/.test(gate), 'no second, unguarded restart path on the boot screen');
  }

  /* ---- F5: a pairing-start failure says which side failed ---- */
  {
    const L = Friendly.linkStartFailure;
    const local = L({ local: true });
    A.ok(/engine on this computer isn't answering/.test(local) && !/link service/.test(local), 'a dead local engine is named as local, never "the link service"');
    const held = L({ status: 503, j: { ok: false, degraded: true, code: 'EPROCESS_FAULT', error: DEGRADED } });
    A.ok(/stopped after an error/.test(held) && !/link service/.test(held), 'a degraded local engine (503 EPROCESS_FAULT) is local too');
    const tls = L({ status: 502, j: { reason: 'tls', detail: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY account.starnetos.com' } });
    A.ok(/security software/.test(tls) && /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/.test(tls) && !/link service/.test(tls), 'a TLS interception names the security software and the cause');
    A.ok(/check a VPN or firewall/.test(L({ status: 502, j: { reason: 'dns', detail: 'ENOTFOUND account.starnetos.com' } })), 'DNS failure → VPN/firewall step');
    A.ok(/ECONNREFUSED/.test(L({ status: 502, j: { reason: 'unreachable', detail: 'ECONNREFUSED 1.2.3.4' } })), 'the transport detail rides into the copy');
    A.ok(/did not answer in time/.test(L({ status: 502, j: { reason: 'timeout' } })), 'timeout is its own sentence');
    A.ok(/having trouble right now/.test(L({ status: 502, j: { reason: 'cloud_5xx', status: 503 } })), 'a cloud 5xx is the cloud\'s trouble');
    A.ok(/turned the link request down \(http 400\)/.test(L({ status: 502, j: { reason: 'cloud_400', status: 400 } })), 'a cloud 4xx is a refusal, not "could not reach"');
    A.ok(/isn't available in this build/.test(L({ status: 404, j: { error: 'linking_unavailable' } })), 'no cloud URL configured is not a network failure');
    A.eq(L(undefined), 'could not reach the link service — try again', 'unknown failures keep the old line');
    // both link doors route through it and keep the facts (rejection = local)
    for (const [name, src, fn] of [['app.js', appSrc, 'function startStarnetLink'], ['stationui.js', stationuiSrc, 'function startCreditsLink']]) {
      const b = A.fnBody(src, fn);
      A.ok(b.length > 200, name + ' ' + fn + ' located');
      A.ok(/\(\) => \{ throw startFail\(\{ local: true \}\); \}/.test(b), name + ': a rejected station POST is tagged local');
      A.ok(/Friendly\.linkStartFailure\(e && e\.linkStart\)/.test(b), name + ': the copy comes from Friendly.linkStartFailure');
      A.ok(/!r \|\| !r\.ok/.test(b), name + ': a null reply is guarded');
    }
  }

  A.report('link-down-recovery.test');
})().catch(e => { console.error(e); process.exit(1); });
