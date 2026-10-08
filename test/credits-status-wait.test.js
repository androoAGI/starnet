'use strict';
/* node test/credits-status-wait.test.js — the WAKE and STORE credit reads wait out the sidecar's own worst case
   (customer report E29, 2026-10-07: "couldn't confirm credit balance… try WAKE again" on a slow account service).

   GET /api/credits can take ~16s when the link self-heals: /v1/whoami (8s) + one /v1/balance read (8s). WAKE wrapped the
   read in a 20s race, but Harness.api.get carries its OWN 15s default deadline, so the inner deadline always fired first
   and the 20s race never mattered — a funded, healing account still read "couldn't confirm". The STORE read had the same
   15s inner deadline. This RUNS the production code against a fake clock: harness.js requestJson (the real deadline),
   app.js refreshStarnetGenesisStatus (WAKE) and stationui.js wireCredits (STORE), with a fetch that answers at 16s. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const harnessSrc = read('harness.js'), appSrc = read('app.js'), stationuiSrc = read('stationui.js');
const slice = (src, from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'slice anchors found: ' + from.trim().slice(0, 40));
  return src.slice(a, b);
};
const apiCode = slice(harnessSrc, '  async function requestJson(', '\n  // ONE fold point') + '\nthis.api = api;';
const wakeCode = slice(appSrc, '  let starnetLinked = false;', '  // A station can be linked to a DIFFERENT StarNet login') + '\nthis.wake = { refreshStarnetGenesisStatus };';
const storeCode = slice(stationuiSrc, '  let _creditsLinkPoll =', '  // BUDGET panel') + '\nthis.store = { wireCredits };';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
// a virtual clock shared by every lifted module: timers fire in due order, microtasks drain between them
function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    setInterval: () => 0, clearInterval: () => {},
    pending: () => timers.size,
    async advanceTo(t) {
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= t && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush();
      }
      now = t; await flush();
    }
  };
}
// the station's /api/credits: answers `body` after `delayMs` of virtual time (Infinity = never), aborts like a real fetch
function makeApi(clock, delayMs, body) {
  const seen = { aborted: 0, routes: [] };
  const fetch = (route, init) => new Promise((resolve, reject) => {
    seen.routes.push(route);
    const id = isFinite(delayMs) ? clock.setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), delayMs) : null;
    init.signal.addEventListener('abort', () => { seen.aborted++; if (id) clock.clearTimeout(id); reject(new Error('aborted')); }, { once: true });
  });
  const ctx = vm.createContext({ AbortController, fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  vm.runInContext(apiCode, ctx);
  return { api: ctx.api, seen };
}
function node() {
  const classes = new Set();
  return { textContent: '', innerHTML: '', className: '', onclick: null,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) } };
}
const FUNDED = { configured: true, linked: true, linkSaved: true, linkStatus: 'linked', accountId: 'acct', balanceUsd: 79.24, purchaseUrl: 'https://starnetos.com/credits' };

async function wake(delayMs) {
  const clock = makeClock(), { api, seen } = makeApi(clock, delayMs, FUNDED);
  const els = {};
  const ctx = vm.createContext({ Harness: { api }, el: id => (els[id] = els[id] || node()), document: { querySelector: () => null },
    pickedProvider: 'starnet', userPickedProvider: false, selectProviderUI() {}, SFX: { click() {} }, openExternalUrl() {},
    esc: s => String(s), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval });
  vm.runInContext(wakeCode, ctx);
  let result = null;
  ctx.wake.refreshStarnetGenesisStatus().then(r => { result = r; });
  await clock.advanceTo(60000);
  return { result, status: els['starnet-status'], seen, timersLeft: clock.pending() };
}
async function store(delayMs) {
  const clock = makeClock(), { api, seen } = makeApi(clock, delayMs, FUNDED);
  const painted = [];
  const host = { isConnected: true, innerHTML: '' };
  const body = { querySelector: s => (s === '#credits-store' ? host : null) };
  const ctx = vm.createContext({ console, Promise, Harness: { api }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval, esc: s => String(s), fmtUsd: n => '$' + n,
    sfx() {}, openExternal() {}, scheduleSettingsRepaint() {}, tauriInvoke: () => null, H: () => ({}), refreshCreditsProvider: async () => {},
    document: { body: { contains: () => true } }, ArmConfirm: { wire() {} } });
  vm.runInContext(storeCode, ctx);
  // the painters are the STORE's real outcomes: record which one the read ends in
  vm.runInContext('renderCreditsConfigured = (b, h, j) => { this.__out("configured", j); }; renderCreditsUnavailable = () => { this.__out("unavailable"); }; renderCreditsLinkCard = () => { this.__out("link"); };', ctx);
  ctx.__out = (what, j) => painted.push({ what, balanceUsd: j && j.balanceUsd });
  ctx.store.wireCredits(body);
  await clock.advanceTo(60000);
  return { painted, seen };
}

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

(async () => {
  // 1. the sidecar's worst case (heal whoami 8s + balance 8s = 16s) lands on WAKE
  {
    const w = await wake(16000);
    ok(w.result && w.result.answered === true, 'WAKE: a 16s healing credits answer is ANSWERED, not "couldn\'t confirm" (got ' + JSON.stringify(w.result) + ')');
    ok(w.result && w.result.balanceUsd === 79.24, 'WAKE: the funded balance the sidecar reported reaches the WAKE gate');
    ok(/\$79\.24 available/.test(w.status.innerHTML), 'WAKE: the genesis line shows the real balance: ' + (w.status.innerHTML || w.status.textContent));
    ok(!/could not verify/.test(w.status.textContent), 'WAKE: a slow-but-answered link is never painted as "could not verify"');
    ok(w.seen.aborted === 0, 'WAKE: the request was not aborted under the sidecar\'s own budget');
    ok(w.seen.routes[0] === '/api/credits?history=0', 'WAKE: still the bounded balance-only summary read');
  }
  // 2. still bounded: a credits service that never answers resolves UNKNOWN (never $0) inside the WAKE wait
  {
    const w = await wake(Infinity);
    ok(w.result && w.result.answered === false && w.result.balanceUsd === null, 'WAKE: an unanswered read is unknown, never a $0 balance');
    ok(w.seen.aborted === 1, 'WAKE: the hung request is aborted, not left open');
    ok(w.timersLeft === 0, 'WAKE: no deadline timer outlives the read');
  }
  // 3. the STORE reads /api/credits through the same heal path: a 16s answer paints the account, not "could not check"
  {
    const s = await store(16000);
    ok(s.painted.length === 1 && s.painted[0].what === 'configured' && s.painted[0].balanceUsd === 79.24,
      'STORE: a 16s healing credits answer paints the linked account (got ' + JSON.stringify(s.painted) + ')');
    ok(s.seen.aborted === 0, 'STORE: the request was not aborted under the sidecar\'s own budget');
  }
  {
    const s = await store(Infinity);
    ok(s.painted.length === 1 && s.painted[0].what === 'unavailable', 'STORE: a read that never answers still ends in the honest "could not check" card');
    ok(s.seen.aborted === 1, 'STORE: the hung request is aborted');
  }
  console.log('credits-status-wait.test.js OK -', n, 'assertions');
})().catch(e => { console.error(e); process.exitCode = 1; });
