/* node test/update-drain-newest-save.test.js — #121 (I121-4): an update never installs over an unsaved live station.

   The installer kills the app. Before #121 the pre-install drain only flushed what was ALREADY queued for the station
   file — and with the browser cache full, persist() queued nothing, so the drain proved an old save and the update
   wiped the newest edits. Now preInstallDrain() queues the live station first (App.persist) and refuses to install
   unless the station file confirms THAT newest save.

   Real modules: updates.js + UpdateCore, and the real Save/CloudSaveCore/CloudSave in the same page context. The
   station file is a fake /api/save that can be taken down; App.persist builds a live envelope the way persist() does
   when the browser cache is full (cache refused it, so it rides on the station file alone). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const UpdateCore = require('../frontend/app/updatecore.js');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function makeCase(o) {
  const calls = [], notices = [];
  const station = { posted: [], revision: 0, down: !!o.stationDown, tooLarge: !!o.stationTooLarge, errno: o.stationErrno || null };
  let installCalls = 0;
  const live = { floor: 'verdant' };
  class Channel { constructor(fn) { this.fn = fn; } }
  const invoke = async cmd => {
    calls.push(cmd);
    if (cmd === 'starnet_update_status') return { desktop: true, currentVersion: '1.0.0', pending: null };
    if (cmd === 'starnet_update_check') return { available: true, checkedAt: 10, update: { version: '2.0.0', body: '' } };
    if (cmd === 'starnet_update_install') { installCalls++; return {}; }
    return {};
  };
  const fetch = async (url, init) => {
    const u = String(url), method = ((init && init.method) || 'GET').toUpperCase();
    calls.push(method + ' ' + u.split('?')[0]);
    if (u.startsWith('/api/save') && method === 'POST') {
      if (station.down) throw new Error('station file unreachable');
      // the station's NAMED refusals (sidecar/save-wire.js): an over-cap body, a failed write with its errno
      if (station.tooLarge) return { ok: false, status: 413, json: async () => ({ ok: false, tooLarge: true, limitBytes: 16 << 20, error: 'too large' }) };
      if (station.errno) return { ok: false, status: 500, json: async () => ({ ok: false, code: station.errno, error: station.errno + ': write failed', ...(station.errno === 'ENOSPC' ? { cause: 'diskFull' } : {}) }) };
      const doc = JSON.parse(init.body);
      station.posted.push(doc);
      station.revision++;
      return { ok: true, status: 200, json: async () => ({ ok: true, revision: station.revision, updatedAt: doc.updatedAt }) };
    }
    if (u === '/api/update/prepare') return { ok: true, status: 200, json: async () => ({ ok: true, receipt: { id: 'receipt-1' } }) };
    if (u === '/api/update/cancel') return { ok: true, status: 200, json: async () => ({ ok: true, frozen: false }) };
    throw new Error('unexpected fetch ' + u);
  };
  const store = new Map();
  const context = {
    UpdateCore, console: { warn() {}, info() {}, log() {}, error() {} }, crypto: nodeCrypto, AbortController,
    window: { __TAURI__: { core: { invoke, Channel } }, open() {} },
    localStorage: {
      get length() { return store.size; }, key(i) { return Array.from(store.keys())[i] || null; },
      getItem(k) { return store.has(k) ? store.get(k) : null; }, setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }
    },
    Channels: { busyCount: () => 0 },
    fetch, setTimeout, clearTimeout, queueMicrotask,
    Date, JSON, Promise, Math, String, Number, Object, Array, RegExp, Error, encodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(read('frontend/app/save.js'), context);
  vm.runInContext(read('frontend/app/cloudsavecore.js'), context);
  vm.runInContext(read('frontend/app/cloudsave.js'), context);
  context.App = {
    // persist() with a full browser cache: the envelope is built and queued for the station file only
    persist() {
      calls.push('persist');
      if (o.persistThrows) throw new Error('serialize failed');
      const env = vm.runInContext('Save.envelope', context)({ agent: { id: 'agent', name: 'NOVA' }, station: { floor: live.floor } });
      vm.runInContext('CloudSave', context).push(env, { cacheFailed: true, cacheError: 'QuotaExceededError' });
      return false;
    },
    pushRoster: async () => { calls.push('roster'); return true; }
  };
  vm.runInContext(read('frontend/app/updates.js') + '\n;globalThis.__Updates = Updates;', context, { filename: 'updates.js' });
  const updates = context.__Updates;
  return {
    updates, calls, notices, station, live,
    installCalls: () => installCalls,
    ready: async () => { await updates.init({ notify: (...a) => notices.push(a) }); await updates.check(true, 'test'); }
  };
}

(async () => {
  {
    // the live refit was never queued (the cache refused it); the station file is down
    const c = makeCase({ stationDown: true });
    await c.ready();
    const state = await c.updates.install();
    A.ok(c.calls.indexOf('persist') >= 0, 'the drain queues the live station before proving it');
    A.eq(c.installCalls(), 0, 'an unconfirmed newest save blocks the native installer');
    A.eq(c.calls.includes('/api/update/prepare') || c.calls.includes('POST /api/update/prepare'), false, 'no recovery point is cut over an unconfirmed save');
    A.ok(/latest station changes are not confirmed in the station file/i.test(state.error), 'the refusal names the unconfirmed station changes (got: ' + state.error + ')');
    A.ok(/StarNet stays open/.test(state.error), 'the refusal says StarNet stays open');
    A.ok(c.notices.some(n => /not confirmed in the station file/.test(String(n[0]))), 'the notice names the unconfirmed save');
    // starnet-releases#4: the refusal names WHY (the cause the save recorded) and the way past it (the full installer)
    A.ok(/did not answer/.test(state.error), 'the refusal names the cause: the station did not answer (got: ' + state.error + ')');
    A.ok(!/disk/i.test(state.error), 'an unanswered save is never blamed on the disk');
    A.ok(/DOWNLOAD LATEST MANUALLY/.test(state.error), 'the refusal points at the full installer the card offers');
    A.ok(/try again in a moment/.test(state.error), 'an outage may clear: it says to try again');
    A.ok(c.notices.some(n => /did not answer/.test(String(n[0]))), 'the notice names the cause too');
  }
  {
    // a station too large for the station file (a named 413): the cause is named, and waiting is never offered as the fix
    const c = makeCase({ stationTooLarge: true });
    await c.ready();
    const state = await c.updates.install();
    A.eq(c.installCalls(), 0, 'a too-large save blocks the native installer');
    A.ok(/too large to save/.test(state.error) && /16 MiB/.test(state.error), 'the refusal says the station is too large (got: ' + state.error + ')');
    A.ok(!/try again in a moment/.test(state.error), 'retrying cannot land a too-large save: never "try again in a moment"');
    A.ok(/DOWNLOAD LATEST MANUALLY/.test(state.error) && /stays only in this window/.test(state.error), 'it points at the full installer and says what it cannot carry');
  }
  {
    // a full disk names the disk; a locked file (EBUSY) never does
    const full = makeCase({ stationErrno: 'ENOSPC' });
    await full.ready();
    const s1 = await full.updates.install();
    A.ok(/disk that holds the station file is full/.test(s1.error), 'ENOSPC: the refusal names the full disk (got: ' + s1.error + ')');
    const locked = makeCase({ stationErrno: 'EBUSY' });
    await locked.ready();
    const s2 = await locked.updates.install();
    A.ok(/could not be written/.test(s2.error) && !/disk/i.test(s2.error), 'EBUSY: a failed write, never the disk (got: ' + s2.error + ')');
  }
  {
    // the station file is up: the NEWEST live state must be what it confirms before the installer runs
    const c = makeCase({});
    await c.ready();
    await c.updates.install();
    const posted = c.station.posted[c.station.posted.length - 1];
    A.eq(posted && posted.station && posted.station.floor, 'verdant', 'the station file received the live station, not an older cached one');
    const order = ['persist', 'POST /api/save', 'POST /api/update/prepare', 'starnet_update_install'].map(x => c.calls.indexOf(x));
    A.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), 'persist, station-file confirmation, recovery point and install run in strict order (' + order.join(',') + ')');
    A.eq(c.installCalls(), 1, 'a confirmed newest save lets the install proceed');
  }
  {
    // a persist that throws leaves the newest state unqueued: unproven, so refused
    const c = makeCase({ persistThrows: true });
    await c.ready();
    const state = await c.updates.install();
    A.eq(c.installCalls(), 0, 'a persist that could not queue the live station blocks the installer');
    A.ok(/not confirmed in the station file/.test(state.error), 'and says the latest changes are not confirmed');
  }
  {
    // the drain result itself carries the verdict the quit guard and the install path read
    const c = makeCase({ stationDown: true });
    const drained = await c.updates.preInstallDrain(500);
    A.eq([drained.ok, drained.saveConfirmed], [false, false], 'preInstallDrain reports the unconfirmed save');
    c.station.down = false;
    const again = await c.updates.preInstallDrain(500);
    A.eq([again.ok, again.saveConfirmed], [true, true], 'once the station file confirms the newest save, the drain passes');
  }
  A.report('update-drain-newest-save');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
