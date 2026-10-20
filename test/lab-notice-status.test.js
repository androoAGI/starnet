/* node test/lab-notice-status.test.js — the lab banner must tell the TRUTH about the station.

   What happened (2026-10-20): the banner at the bottom of the lab page said
   "Testbetrieb · Status nicht erreichbar — Seite neu laden" while the station answered
   /api/lab/status with 200 and the models ran. The cause was a scoping bug, not an outage:
   `const GO_BASE` was declared INSIDE the try-block that pins the OpenCode endpoint, and the
   status line below reads it. A `const` in a block is invisible outside it, so the status
   handler threw a ReferenceError — and the catch, which is meant for a broken station, painted
   "the station does not answer".

   Locks: a healthy station says "KI aktiv"; a station that really cannot be reached says
   "Status nicht erreichbar"; the endpoint constant is visible where the status line uses it. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'frontend', 'js', 'lab-theme.js');

/* run the banner script against a stub page; opts.fetch decides what the station answers */
function runBanner(opts) {
  const o = opts || {};
  const notice = { textContent: 'Testbetrieb · Status wird geprüft …', title: '' };
  const listeners = {};
  const store = new Map();
  const document = {
    documentElement: { dataset: {} },
    body: { classList: { add() {} } },
    querySelector: () => null,
    getElementById: id => (id === 'lab-notice' ? notice : null),
    addEventListener: (name, cb) => { listeners[name] = cb; },
    createElement: () => ({ style: {}, setAttribute() {}, insertAdjacentElement() {} })
  };
  const context = {
    document,
    console: { log() {}, warn() {}, error() {} },
    location: { search: o.search || '' },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); }
    },
    URLSearchParams,
    fetch: o.fetch || (async () => ({ ok: true, status: 200, json: async () => ({ lab: true, live: true, hosts: ['a', 'b'] }) })),
    setTimeout, clearTimeout, Promise, JSON
  };
  context.window = context;
  context.addEventListener = () => {};   // the script only registers a 'load' listener on the window
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), context, { filename: 'lab-theme.js' });
  return { notice, listeners, store };
}

(async () => {
  // --- a healthy station says so ---
  {
    const { notice, listeners } = runBanner({});
    A.ok(!!listeners.DOMContentLoaded, 'the banner script waits for the DOM');
    listeners.DOMContentLoaded();
    await new Promise(r => setTimeout(r, 30));
    A.ok(/KI aktiv/.test(notice.textContent), 'a reachable station says the AI is active (got: ' + notice.textContent + ')');
    A.ok(!/nicht erreichbar/.test(notice.textContent), 'and never the false "not reachable" alarm');
  }

  // --- a station that really cannot be reached says THAT ---
  {
    const { notice, listeners } = runBanner({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
    listeners.DOMContentLoaded();
    await new Promise(r => setTimeout(r, 30));
    A.ok(/nicht erreichbar/.test(notice.textContent), 'a broken station says so (got: ' + notice.textContent + ')');
  }

  // --- and an answer that is not ok is a broken station, not a healthy one ---
  {
    const { notice, listeners } = runBanner({ fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    listeners.DOMContentLoaded();
    await new Promise(r => setTimeout(r, 30));
    A.ok(/nicht erreichbar/.test(notice.textContent), 'a 503 says "not reachable" (got: ' + notice.textContent + ')');
  }

  A.report('lab-notice-status.test');
})().catch(e => { console.error(e); A.report('lab-notice-status.test'); });
