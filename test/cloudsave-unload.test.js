/* node test/cloudsave-unload.test.js — the July-22 desktop data-loss fix (unload beacon).

   Before the fix, installUnloadFlush() treated navigator.sendBeacon's `true` ("queued for dispatch") as a
   confirmed write: it posted to the RELATIVE /api/save (which on desktop resolves into the tauri.localhost
   bundled-asset protocol and never reaches the sidecar, and carries no token so it would 403 anyway), then
   nulled `pending` and stamped health OK. The newest debounced save silently evaporated on every desktop
   close/minimize while the save-dot claimed "backed up" — the exact loss a member reported on v0.6.5.

   This locks the fixed contract:
     1. the beacon aims at the ABSOLUTE sidecar URL (window.__STARNET_API__) with the ?token= query credential;
     2. the blob is text/plain (CORS-simple — a cross-origin application/json beacon would demand a preflight
        sendBeacon never performs, i.e. it would be silently dropped);
     3. dispatch is NEVER success: `pending` survives the beacon and health is untouched — only the
        confirmable fetch flush may claim the write landed;
     4. the hide handler still force-flushes via fetch so a surviving page (minimize/tray) confirms honestly.

   Runs cloudsave.js in Node with stubbed window/document/navigator/fetch. A.report() process.exit()s, so
   timers armed by failure paths never hang the run. */
'use strict';
const A = require('./_assert.js');

// ---- browser-global stubs, installed BEFORE requiring cloudsave.js ----
const listeners = { window: {}, document: {} };
global.window = {
  __STARNET_API__: 'http://127.0.0.1:9999',
  __STARNET_API_TOKEN__: 't0ken/with+specials',
  addEventListener: (ev, fn) => { listeners.window[ev] = fn; }
};
global.document = {
  visibilityState: 'hidden',
  addEventListener: (ev, fn) => { listeners.document[ev] = fn; }
};
const beaconCalls = [];
// Node 22 exposes `navigator` as a getter-only global — defineProperty, not assignment.
Object.defineProperty(globalThis, 'navigator', {
  value: { sendBeacon: (url, blob) => { beaconCalls.push({ url, blob }); return true; } },
  configurable: true
});

// fetch stub: programmable outcomes, records every POST body so the flush path is observable.
let fetchMode = 'ok';           // 'ok' | 'fail'
const fetchCalls = [];
global.fetch = (url, init) => {
  fetchCalls.push({ url, init });
  if (fetchMode === 'fail') return Promise.reject(new Error('network down'));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
};

const CloudSave = require('../frontend/app/cloudsave.js');
const doc = (updatedAt) => ({ schema: 'starnet.save', version: 3, updatedAt, agent: { id: 'agent', name: 'NOVA' } });

(async () => {
  CloudSave.installUnloadFlush();
  A.ok(typeof listeners.window.pagehide === 'function', 'pagehide listener wired');
  A.ok(typeof listeners.document.visibilitychange === 'function', 'visibilitychange listener wired');

  // ---- 1. beacon aims at the ABSOLUTE sidecar endpoint with the query token (the desktop fix) ----
  CloudSave.push(doc(10));                 // arms the debounce; pending now holds the doc
  listeners.window.pagehide();             // simulate the close
  A.eq(beaconCalls.length, 1, 'sendBeacon fired for the pending doc');
  A.eq(beaconCalls[0].url,
    'http://127.0.0.1:9999/api/save?token=' + encodeURIComponent('t0ken/with+specials'),
    'beacon URL is ABSOLUTE (window.__STARNET_API__) and carries the ?token= credential');
  A.ok(/^text\/plain/.test(String(beaconCalls[0].blob && beaconCalls[0].blob.type)),
    'beacon blob is text/plain (CORS-simple; an application/json beacon is silently preflight-dropped cross-origin)');

  // ---- 2. dispatch is NOT success: the confirmable fetch flush also ran and is what stamps health ----
  await CloudSave.flushForUpdate(); // wait for the acknowledged write, not a fixed microtask count
  A.eq(fetchCalls.length, 1, 'the hide handler also force-flushes via fetch (the confirmable path)');
  let h = CloudSave.health();
  A.ok(h.lastPushOkAt > 0, 'health OK was stamped by the CONFIRMED fetch flush');
  A.eq(h.consecutiveFailures, 0, 'no failures recorded on the healthy path');

  // ---- 3. when fetch DIES (the page is being torn down / sidecar gone), pending is NOT destroyed ----
  fetchMode = 'fail';
  const before = beaconCalls.length;
  CloudSave.push(doc(20));
  listeners.document.visibilitychange();   // hidden -> beacon path again
  A.eq(beaconCalls.length, before + 1, 'beacon fired again for the new pending doc');
  await new Promise(r => setTimeout(r, 5));   // let the failing fetch settle
  h = CloudSave.health();
  A.ok(h.consecutiveFailures >= 1, 'the failed fetch flush is honestly recorded as a failure');
  A.ok(h.lastPushFailAt > 0, 'lastPushFailAt stamped — the beacon dispatch did NOT launder health to OK');

  // ---- 4. the surviving-page retry can still deliver the SAME doc (pending was preserved, not nulled) ----
  fetchMode = 'ok';
  const posted = await CloudSave.flush({ force: true });
  A.eq(posted, true, 'the preserved pending doc lands once the sidecar is reachable again');
  const lastBody = JSON.parse(fetchCalls[fetchCalls.length - 1].init.body);
  A.eq(lastBody.updatedAt, 20, 'what landed is the doc the beacon path previously would have destroyed');
  h = CloudSave.health();
  A.eq(h.consecutiveFailures, 0, 'recovery clears the streak');

  // ---- 5. no pending doc -> the hide handler is a no-op (no beacon spam on idle hides) ----
  const b2 = beaconCalls.length, f2 = fetchCalls.length;
  listeners.window.pagehide();
  A.eq(beaconCalls.length, b2, 'no beacon without a pending doc');
  A.eq(fetchCalls.length, f2, 'no fetch without a pending doc');

  A.report('cloudsave-unload');
})().catch(e => { console.log('FAIL: unhandled — ' + (e && e.stack || e)); process.exit(1); });
