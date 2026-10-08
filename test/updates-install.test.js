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
  let cancelCalls = 0;
  let preparedFrozen = false;
  const opened = [];
  class Channel { constructor(fn) { this.fn = fn; } }
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'open_external_url') { opened.push(args && args.url); return {}; }
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
      if (o.prepareBody) return { ok: false, status: 409, json: async () => o.prepareBody };
      if (o.prepareFails) return { ok: false, status: 409, json: async () => ({ ok: false, code: 'UPDATE_SNAPSHOT_FAILED' }) };
      preparedFrozen = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, receipt: { id: 'receipt-1' } }) };
    }
    if (url === '/api/update/cancel') {
      cancelCalls++;
      if (o.cancelFailsAlways || (o.cancelFailsOnce && cancelCalls === 1)) {
        return { ok: false, status: 503, json: async () => ({ ok: false }) };
      }
      preparedFrozen = false;
      return { ok: true, status: 200, json: async () => ({ ok: true, frozen: false }) };
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
  return {
    updates: context.__Updates, calls, opened,
    installCalls: () => installCalls,
    cancelCalls: () => cancelCalls,
    isPreparedFrozen: () => preparedFrozen
  };
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
  {
    const c = makeCase({ installFails: true, cancelFailsOnce: true });
    await ready(c); await c.updates.install();
    A.eq(c.cancelCalls(), 2, 'a rejected thaw response is retried instead of being treated as success');
    A.eq(c.isPreparedFrozen(), false, 'native failure leaves the sidecar writable after a transient thaw failure');
  }
  {
    const c = makeCase({ installFails: true, cancelFailsAlways: true });
    await ready(c); const state = await c.updates.install();
    A.ok(/writes may still be paused/i.test(state.error), 'persistent thaw failure is disclosed instead of reporting only the installer error');
    A.eq(c.isPreparedFrozen(), true, 'persistent thaw failure remains truthfully represented by the frozen fixture');
  }
  {
    // #91: a capture failure is a dead end only if the panel offers nothing — the Update Center error must carry the
    // manual installer door (RELEASES_PAGE), because retrying the in-app update re-runs the same capture.
    const c = makeCase({ prepareBody: { ok: false, frozen: false, code: 'ENOENT', error: "ENOENT: no such file or directory, lstat 'C:\\WORKSPACES\\.checkpoints\\auditor\\git\\tw40mZg'" } });
    await ready(c); const state = await c.updates.install();
    A.eq(c.installCalls(), 0, 'a failed recovery point still blocks the native installer');
    A.ok(/^Pre-update recovery point failed - ENOENT/.test(state.error), 'the capture failure is named on the panel');
    const handlers = {};
    const body = { innerHTML: '', querySelector(sel) {
      const id = sel.replace(/^#/, '');
      if (body.innerHTML.indexOf('id="' + id + '"') < 0) return null;
      return { addEventListener(type, fn) { handlers[id + ':' + type] = fn; } };
    } };
    c.updates.render(body);
    A.ok(body.innerHTML.indexOf('Pre-update recovery point failed') >= 0, 'the error renders in the Update Center');
    A.ok(/class="up-error"[\s\S]*id="up-manual-err"/.test(body.innerHTML), 'the error card carries the manual installer button');
    A.ok(typeof handlers['up-manual-err:click'] === 'function', 'the installer button is wired');
    if (handlers['up-manual-err:click']) handlers['up-manual-err:click']({ preventDefault() {} });
    const page = (fs.readFileSync(path.join(__dirname, '../frontend/app/updates.js'), 'utf8').match(/RELEASES_PAGE = '([^']+)'/) || [])[1];
    A.ok(!!page, 'updates.js declares RELEASES_PAGE');
    A.eq(c.opened, [page], 'the button opens the public releases page (the full installer), nothing invented');
  }
  A.report('updates-install.test');
})().catch(e => { console.error(e); process.exit(1); });
