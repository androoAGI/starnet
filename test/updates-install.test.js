/* node test/updates-install.test.js — native installer cannot run without drain + snapshot receipt. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const UpdateCore = require('../frontend/app/updatecore.js');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app/updates.js'), 'utf8') + '\n;globalThis.__Updates = Updates;';

function makeCase(opts) {
  const o = opts || {};
  const calls = [];
  const store = new Map([['starnet.save', '{"version":5,"updatedAt":99}']]);
  let installCalls = 0;
  class Channel { constructor(fn) { this.fn = fn; } }
  const invoke = async cmd => {
    calls.push(cmd);
    if (cmd === 'starnet_update_status') return { desktop: true, currentVersion: '1.0.0', pending: null };
    if (cmd === 'starnet_update_check') return { available: true, checkedAt: 10, update: { version: '2.0.0', body: '' } };
    if (cmd === 'starnet_update_install') { installCalls++; if (o.installFails) throw new Error('native failed'); return {}; }
    return {};
  };
  const fetch = async (url, init) => {
    calls.push(String(url));
    if (url === '/api/update/prepare') {
      const sent = JSON.parse(init.body);
      A.eq(sent.browserStore['starnet.save'], store.get('starnet.save'), 'prepare carries browser-owned save bytes');
      if (o.prepareFails) return { ok: false, status: 409, json: async () => ({ ok: false, code: 'UPDATE_SNAPSHOT_FAILED' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, receipt: { id: 'receipt-1' } }) };
    }
    if (url === '/api/update/cancel') {
      if (o.cancelFails) return { ok: false, status: 500, json: async () => ({ error: 'sidecar unwell' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  const context = {
    UpdateCore,
    window: { __TAURI__: { core: { invoke, Channel } }, open() {} },
    localStorage: {
      get length() { return store.size; }, key(i) { return Array.from(store.keys())[i] || null; },
      getItem(k) { return store.has(k) ? store.get(k) : null; }, setItem(k, v) { store.set(k, String(v)); }
    },
    CloudSave: { flushForUpdate: async () => { calls.push('save'); return { ok: o.saveOk !== false }; } },
    App: { pushRoster: async () => { calls.push('roster'); return o.rosterOk !== false; } },
    Channels: { busyCount: () => 0 },
    fetch, console,
    setTimeout: () => 1, clearTimeout: () => {},
    Date, JSON, Promise, Math, String, Number, Object, Array, RegExp, Error, encodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'updates.js' });
  return { updates: context.__Updates, calls, installCalls: () => installCalls };
}

async function ready(c) { await c.updates.init(); await c.updates.check(true, 'test'); }

(async () => {
  {
    const c = makeCase({ saveOk: false });
    await ready(c); await c.updates.install();
    A.eq(c.installCalls(), 0, 'failed newest-save flush blocks native installer');
    A.eq(c.calls.includes('/api/update/prepare'), false, 'snapshot is not attempted over an unverified drain');
  }
  {
    const c = makeCase({ prepareFails: true });
    await ready(c); await c.updates.install();
    A.eq(c.installCalls(), 0, 'failed recovery-point creation blocks native installer');
  }
  {
    const c = makeCase({});
    await ready(c); await c.updates.install();
    A.eq(c.installCalls(), 1, 'native installer runs after a verified receipt');
    const order = ['save', 'roster', '/api/update/prepare', 'starnet_update_install'].map(x => c.calls.indexOf(x));
    A.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), 'drain, receipt, and native install occur in strict order');
  }
  {
    const c = makeCase({ installFails: true });
    await ready(c); await c.updates.install();
    A.eq(c.calls.includes('/api/update/cancel'), true, 'native install failure explicitly unfreezes the sidecar');
    A.eq(c.updates.isInstalling(), false, 'quit guard is restored after native failure');
  }
  /* THE THAW CAN FAIL TOO, AND THEN THE STATION IS STUCK. /api/update/prepare sets an in-memory
     freeze on the sidecar that NOTHING clears but /api/update/cancel — no TTL. Verified against a
     live sidecar: after prepare, /api/activity answered 423 UPDATE_MUTATIONS_FROZEN at 1s, 3s and
     6s idle, and /api/update/status still said frozen:true. cancelPreparation used to be
     `.catch(() => null)` while the caller cleared its state unconditionally, so a failed thaw left
     the Commander on a station that refused every durable write in silence — and the two failures
     are CORRELATED, since a sidecar sick enough to fail the install fails the thaw too. */
  {
    const notices = [];
    const c = makeCase({ installFails: true, cancelFails: true });
    await c.updates.init({ notify: (message, kind) => notices.push({ message, kind }) });
    await c.updates.check(true, 'test');
    await c.updates.install();
    const cancels = c.calls.filter(x => x === '/api/update/cancel').length;
    A.ok(cancels > 1, 'a failed thaw is retried rather than abandoned on the first refusal (saw ' + cancels + ')');
    const last = notices[notices.length - 1] || {};
    A.ok(/still frozen/i.test(last.message || ''), 'the Commander is told the station is STILL FROZEN, not just that the install failed');
    A.ok(/restart/i.test(last.message || ''), 'the notice names the one remedy that actually clears an in-memory freeze');
    A.eq(last.kind, 'bad', 'a station left frozen is a fault, not routine warning chrome');
    A.eq(c.updates.isInstalling(), false, 'quit guard is still restored when the thaw fails');
  }
  A.report('updates-install.test');
})().catch(e => { console.error(e); process.exit(1); });
