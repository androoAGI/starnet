/* node test/save-quota-writethrough.test.js — #121: station edits silently reverted after a reload.

   The whole save lives under ONE browser-storage key ('starnet.save'). Past the browser's per-site cap (WebView2 /
   WebKit, ~5 MB; weeks of session history get there) Save.write throws and returns null. persist() only queued the
   station file when that write succeeded, so BOTH copies froze at the first failure: the refit stayed visible, the
   cache and agent.save.json kept the old station, and every restart reverted it.

   Real modules, fake storage edges: the shipped Save, CloudSaveCore and CloudSave, the shipped persist/watch block
   (sliced from app.js exactly as station-autosave.test.js does), the shipped resumableSave/startCreation guards, and
   the shipped durable SaveStore (sidecar/savestore.js) over an in-memory fs. localStorage enforces a per-origin
   quota the way WebKit/WebView2 do: setItem throws once the origin's total would pass it.

   Scenarios: S1 clean stale cache, S2 dirty stale cache (the macOS report's cache carried _saveDirty:true), each:
   small station saves → history grows past the quota → the Commander refits the room → the page reloads.
   C1 control: an offline-only edit in the cache still wins over an older durable copy (no regression).
   G guards: re-entry and startCreation never read the stale/removed cache after the cache failed.
   B boot: a stale CLEAN cache plus a newer station file the cache cannot hold resumes the station file in memory.
   Q queued acknowledgement: a confirmation that lands while another autosave is queued still removes the older (dirty)
     cache entry, so no boot resumes it into a false conflict; a queued save the cache DID hold is never removed.
   E export: EXPORT AGENT (backup.js) carries the in-memory station, never the stale or removed cache entry.
   T truthful status: the notice and the shipped save light (stationui.js) say where the latest change really is —
     NOT saved yet / NOT saved (red) / confirmed in the station file — and say "full" only for the browser's quota. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const src = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const M = require('../frontend/app/worldmodel.js');

function memfs() {
  const files = new Map();
  const enoent = p => Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
  return {
    readFileSync(p) { if (!files.has(p)) throw enoent(p); return files.get(p); },
    writeFileSync(p, d) { files.set(p, String(d)); },
    renameSync(a, b) { if (!files.has(a)) throw enoent(a); files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {}
  };
}
function makeStore() {
  // no `require` in the context: savestore's fail-open note falls back to console.warn (hermetic, nothing on disk)
  const ctx = vm.createContext({ module: { exports: {} }, console: { warn() {}, log() {} }, Buffer });
  vm.runInContext(src('sidecar/savestore.js'), ctx);
  return ctx.module.exports.makeSaveStore({ fs: memfs(), pathMod: path.posix, root: '/ws', clock: { now: () => Date.now() } });
}
// per-origin quota: total chars across every key (WebKit counts the whole origin; Chromium too)
function quotaStorage(limitRef) {
  const m = new Map();
  const used = (k, v) => { let n = 0; for (const [kk, vv] of m) if (kk !== k) n += kk.length + vv.length; return n + k.length + v.length; };
  return {
    _map: m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      v = String(v);
      if (limitRef.limit && used(k, v) > limitRef.limit) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, v);
    },
    removeItem: k => { m.delete(k); },
    get length() { return m.size; },
    key: i => Array.from(m.keys())[i] || null
  };
}
function makeFetch(store, gate) {
  return async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    if (gate && gate.down) throw new Error('sidecar unreachable');
    if (method === 'POST' && u.startsWith('/api/save')) {
      const body = JSON.parse(opts.body);
      const result = store.save('agent', body, { compareRevision: true });
      if (gate && gate.hold) await gate.hold;             // the station file wrote it; the acknowledgement is still in transit
      return { ok: true, status: 200, json: async () => result };
    }
    if (method === 'GET' && u.startsWith('/api/save?')) return { ok: true, status: 200, json: async () => ({ save: store.load('agent') || null }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
function pageContext(localStorage, fetch, extra) {
  const c = vm.createContext(Object.assign({
    console: { warn() {}, info() {}, log() {} }, queueMicrotask, setTimeout, clearTimeout, AbortController, crypto: nodeCrypto,
    localStorage, fetch, JSON
  }, extra || {}));
  vm.runInContext(src('frontend/app/save.js'), c);
  vm.runInContext(src('frontend/app/cloudsavecore.js'), c);
  vm.runInContext(src('frontend/app/cloudsave.js'), c);
  return c;
}
const app = src('frontend/app/app.js');
const start = app.indexOf('  let unsubscribeStationSave = null;');
const end = app.indexOf('  /* ---------- connect screen', start);
A.ok(start > 0 && end > start, 'the shipped persist/watch block is found in app.js');
const tick = () => new Promise(r => setTimeout(r, 0));
const floorOf = (doc, room) => doc && doc.station && doc.station.rooms && doc.station.rooms[room] && doc.station.rooms[room].floorStyle;
const cachedFloor = (ls, room) => floorOf(JSON.parse(ls.getItem('starnet.save') || 'null'), room);

function livePage(localStorage, fetch, station, ws) {
  const notices = [];
  const ui = { flash: 0, refresh: 0 };   // the save light: a green flash means "the cache was written"; a refresh repaints its words
  const c = pageContext(localStorage, fetch, {
    station, agent: { id: 'agent', name: 'NOVA' }, agents: new Map(), liveAgents: () => [],
    Harness: { totals: () => ({}) }, Workstreams: { serialize: () => ws.slice }, rosterPushFailed: false, pushRoster() {},
    StationUI: { flashSave() { ui.flash++; }, refreshSave() { ui.refresh++; }, notify: (...a) => notices.push(a) }
  });
  vm.runInContext(app.slice(start, end), c);
  vm.runInContext('watchStationSave()', c);
  return { c, notices, ui };
}
async function reloadPage(localStorage, fetch) {
  const c = pageContext(localStorage, fetch);
  const doc = await vm.runInContext('CloudSave.reconcile(Save.load())', c);
  return { c, doc, revision: vm.runInContext('CloudSave.revision()', c) };
}
// the shipped re-entry source of truth, evaluated inside a page context
// (a build without resumableSave re-enters straight from the cache: model exactly that, so the behaviour is still judged)
const resumableSrc = A.fnBody(app, '  function resumableSave()') || 'function resumableSave() { return { doc: Save.has() ? Save.load() : null, memory: false }; }';
const startCreationSrc = A.fnBody(app, '  function startCreation()');
A.ok(app.indexOf('  function resumableSave()') > 0 && resumableSrc.length < 2000, 'resumableSave() is sliced from app.js');
A.ok(startCreationSrc.length > 50 && startCreationSrc.length < 2000, 'startCreation() is sliced from app.js');
function reentrySave(c) {
  vm.runInContext(resumableSrc, c);
  return vm.runInContext('resumableSave()', c);
}

async function scenario(label, opts) {
  const store = makeStore();
  const limitRef = { limit: 0 };
  const ls = quotaStorage(limitRef);
  const fetch = makeFetch(store);
  const station = M.create();
  const room = station.spawnRoomId();
  const ws = { slice: { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'hello' }] }], activeId: 'general', generalId: 'general' } };
  const page = livePage(ls, fetch, station, ws);

  station.setFloor(room, 'amber'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  const used = Array.from(ls._map).reduce((n, [k, v]) => n + k.length + v.length, 0);
  limitRef.limit = used + 4000;                                          // the origin is now near its quota
  if (opts.dirtyCache) {                                                  // the macOS report: the cached save carries _saveDirty:true
    const d = JSON.parse(ls.getItem('starnet.save')); d._saveDirty = true; ls._map.set('starnet.save', JSON.stringify(d));
  }
  // weeks of history push the save past the quota, then the refit lands
  ws.slice = { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'x'.repeat(20000) }] }], activeId: 'general', generalId: 'general' };
  const flashBefore = page.ui.flash, refreshBefore = page.ui.refresh;
  station.setFloor(room, 'verdant'); await tick();
  const writeFailed = page.notices.some(n => n[3] && n[3].key === 'save-failed');
  A.ok(station.serialize().rooms[room].floorStyle === 'verdant' && writeFailed && cachedFloor(ls, room) === 'amber',
    label + ' precondition: live room shows verdant, the cache write failed, the cache still holds amber');
  // L1 (live proof 10-15): the light used to keep "autosave" / "confirmed in the station file" for up to the 1 s tick
  // after a refused write. The refused write repaints it at once, and never flashes the green "cache written" pulse.
  A.ok(page.ui.refresh > refreshBefore, label + ' L1: a refused cache write repaints the save light at once (no 1 s window of a stale "saved")');
  A.ok(page.ui.flash === flashBefore, label + ' L1: a refused cache write never flashes the green "cache written" pulse');
  // G1: before the station file confirms, a re-entry must not read the stale cache
  const early = reentrySave(page.c);
  A.ok(early.memory === true && floorOf(early.doc, room) === 'verdant', label + ' G1: re-entry resumes the in-memory station, never the stale cache (got ' + floorOf(early.doc, room) + ')');

  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  const durable = store.load('agent');
  A.eq(floorOf(durable, room), 'verdant', label + ' A1: the station file receives the live refit despite the cache failure');
  A.eq(ls.getItem('starnet.save'), null, label + ' A1b: once the station file confirms it, the superseded cache entry is removed');
  const late = reentrySave(page.c);
  A.ok(late.memory === true && floorOf(late.doc, room) === 'verdant', label + ' G2: after the cache entry is removed, re-entry still resumes the station (never creation)');

  const reload = await reloadPage(ls, fetch);
  A.eq(floorOf(reload.doc, room), 'verdant', label + ' A2: the reload resumes the live refit, not the stale cache');
  A.ok(!!(reload.doc && reload.doc.agent && !reload.doc.__saveUnknown && !reload.doc.__futureSave), label + ' A3: the reload never falls to onboarding or the save-unreachable screen');
  const durableRev = Number((store.load('agent') || {})._saveRevision) || 0;
  A.eq(reload.revision, durableRev, label + ' A4: the resumed page carries the station file revision (its next autosave cannot conflict or clobber)');
  const reloadedReentry = reentrySave(reload.c);
  A.ok(reloadedReentry.memory === true && floorOf(reloadedReentry.doc, room) === 'verdant', label + ' G3: after a station-file resume, re-entry resumes it from memory');
  return { store, ls, fetch, room };
}

// I121-3: the save light (stationui.js) and the notice say where the latest change really is
const ui = src('frontend/app/stationui.js');
const dotStart = ui.indexOf('  let degradedNotified = false;');
const dotEnd = ui.indexOf('  // relative-time formatter', dotStart);
A.ok(dotStart > 0 && dotEnd > dotStart, 'the shipped save-light renderer is found in stationui.js');
function saveLight(c) {
  const dot = { title: '', cls: new Set() };
  dot.classList = { add: (...k) => k.forEach(x => dot.cls.add(x)), remove: (...k) => k.forEach(x => dot.cls.delete(x)) };
  Object.assign(c, { $: sel => (sel === '#save-dot' ? dot : null), document: { getElementById: () => null }, notify() {} });
  vm.runInContext('(function () {' + ui.slice(dotStart, dotEnd) + '\nreturn refreshSaveDurability; })()', c)(dot);
  return { cls: Array.from(dot.cls).join(' ') || 'plain', title: dot.title };
}
const healthOf = c => vm.runInContext('CloudSave.health()', c);

async function truthfulStatus() {
  const store = makeStore();
  const limitRef = { limit: 0 };
  const ls = quotaStorage(limitRef);
  const gate = { down: false };
  const fetch = makeFetch(store, gate);
  const station = M.create();
  const room = station.spawnRoomId();
  const ws = { slice: { workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' } };
  const page = livePage(ls, fetch, station, ws);
  station.setFloor(room, 'amber'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  A.eq(saveLight(page.c), { cls: 'plain', title: 'autosave' }, 'T0: a healthy save shows the plain autosave light');

  limitRef.limit = Array.from(ls._map).reduce((n, [k, v]) => n + k.length + v.length, 0) + 4000;
  ws.slice = { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'z'.repeat(20000) }] }], activeId: 'general', generalId: 'general' };
  gate.down = true;
  station.setFloor(room, 'verdant'); await tick();
  const notice = String((page.notices.find(n => n[3] && n[3].key === 'save-failed') || [])[0] || '');
  A.ok(/browser storage for this window is full/i.test(notice) && /station file/i.test(notice), 'T1: the notice names the full browser storage and the station file (got: ' + notice + ')');
  A.ok(!/free storage/i.test(notice), 'T1: the notice no longer asks the user to free storage (disk space cannot raise a browser cap)');
  let h = healthOf(page.c);
  A.ok(h.cacheFailed === true && h.cacheFailedConfirmed === false && /quota/i.test(String(h.cacheFailedReason)), 'T2: health carries the quota cache failure, not yet confirmed');
  let light = saveLight(page.c);
  A.ok(light.cls === 'stale' && /browser cache full/.test(light.title) && /NOT saved yet/.test(light.title), 'T2: while the change travels to the station file the light says NOT saved yet (got ' + light.cls + ': ' + light.title + ')');

  await vm.runInContext('CloudSave.flush({ force: true })', page.c);   // the station file is unreachable
  light = saveLight(page.c);
  A.ok(light.cls === 'degraded' && /NOT saved/.test(light.title) && /station file has not confirmed/.test(light.title), 'T3: a failed station-file write turns the light red: NOT saved (got ' + light.cls + ': ' + light.title + ')');
  A.eq(cachedFloor(ls, room), 'amber', 'T3: the stale cache is never dropped before the station file confirms');
  A.eq(floorOf(reentrySave(page.c).doc, room), 'verdant', 'T3: the live station is held in memory meanwhile');

  gate.down = false;
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  h = healthOf(page.c);
  A.ok(h.cacheFailed === true && h.cacheFailedConfirmed === true, 'T4: health records the station file confirmation');
  light = saveLight(page.c);
  A.ok(light.cls === 'stale' && /saving to the station file only/.test(light.title) && /confirmed in the station file/.test(light.title), 'T4: once confirmed the light says: browser cache full, saving to the station file only (got ' + light.title + ')');
  A.eq(ls.getItem('starnet.save'), null, 'T4: the superseded cache entry is removed only after that confirmation');

  const reload = await reloadPage(ls, fetch);
  light = saveLight(reload.c);
  A.ok(floorOf(reload.doc, room) === 'verdant' && /saving to the station file only/.test(light.title) && /confirmed/.test(light.title), 'T5: a station-file resume shows the confirmed station-file-only light from the first frame');

  // a refusal that is NOT the browser's quota is never called "full"
  const refusing = { getItem: () => null, setItem() { const e = new Error('denied'); e.name = 'SecurityError'; throw e; }, removeItem() {} };
  const other = livePage(refusing, makeFetch(makeStore()), M.create(), { slice: { workstreams: [], activeId: null, generalId: null } });
  vm.runInContext('persist()', other.c);
  const otherNotice = String((other.notices[0] || [])[0] || '');
  A.ok(/refused/i.test(otherNotice) && !/full/i.test(otherNotice), 'T6: a non-quota refusal is named as a refusal, not "full" (got: ' + otherNotice + ')');
  A.ok(/refused the save/.test(saveLight(other.c).title), 'T6: the light names a non-quota refusal as a refusal');
}

async function controlOfflineEdit() {
  // C1: an edit made while the sidecar was down lives only in the cache; it must still win at boot (no regression).
  const store = makeStore();
  const ls = quotaStorage({ limit: 0 });
  const gate = { down: false };
  const fetch = makeFetch(store, gate);
  const station = M.create();
  const room = station.spawnRoomId();
  const ws = { slice: { workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' } };
  const page = livePage(ls, fetch, station, ws);
  station.setFloor(room, 'amber'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  gate.down = true;
  station.setFloor(room, 'teal'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  gate.down = false;
  A.eq(cachedFloor(ls, room), 'teal', 'C1: an offline edit that fit in the cache is never removed from it');
  A.eq(reentrySave(page.c).memory, false, 'C1: with a healthy cache, re-entry reads the cache as before');
  const { doc } = await reloadPage(ls, fetch);
  A.eq(floorOf(doc, room), 'teal', 'C1 control: an offline-only cache edit still wins over an older durable copy');
}

async function bootFromStationFile() {
  // B: the station file holds a NEWER station than the clean cache, and the cache cannot take it (e.g. the page died
  // before it could drop its stale cache). The boot path alone is judged: the newer station is seeded straight into
  // the durable store, the way another window or the unload beacon lands it.
  const store = makeStore();
  const limitRef = { limit: 0 };
  const ls = quotaStorage(limitRef);
  const fetch = makeFetch(store);
  const station = M.create();
  const room = station.spawnRoomId();
  const ws = { slice: { workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' } };
  const page = livePage(ls, fetch, station, ws);
  station.setFloor(room, 'amber'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  const staleRaw = ls.getItem('starnet.save');
  A.eq(JSON.parse(staleRaw)._saveDirty, false, 'B precondition: the cached amber save is clean (acknowledged)');
  const newer = JSON.parse(staleRaw);
  newer.station.rooms[room].floorStyle = 'verdant';
  newer.workstreams = [{ id: 'general', history: [{ role: 'user', content: 'y'.repeat(20000) }] }];
  newer.updatedAt = Number(newer.updatedAt) + 1000;
  A.ok(store.save('agent', newer, { compareRevision: true }).ok, 'B precondition: the station file holds the newer verdant station');
  limitRef.limit = Array.from(ls._map).reduce((n, [k, v]) => n + k.length + v.length, 0) + 4000;   // the cache cannot take it
  const reload = await reloadPage(ls, fetch);
  A.eq(floorOf(reload.doc, room), 'verdant', 'B1: a station file the cache cannot hold is resumed from memory, not the stale clean cache');
  A.eq(ls.getItem('starnet.save'), null, 'B2: the superseded clean cache entry is dropped so the next boot cannot resume it');
  A.eq(reload.revision, Number(store.load('agent')._saveRevision), 'B3: the in-memory resume carries the station file revision');

  // a station-file resume is never replaced by a brand-new creation
  const calls = { reentry: 0, show: 0 };
  Object.assign(reload.c, { reentry: () => { calls.reentry++; }, SFX: { boot() {}, open() {} }, show: () => { calls.show++; }, initConnect() {}, resumingSaved: null });
  vm.runInContext(resumableSrc + '\n' + startCreationSrc, reload.c);
  vm.runInContext('startCreation()', reload.c);
  A.eq(calls, { reentry: 1, show: 0 }, 'B4: startCreation after a station-file resume re-enters the station instead of opening creation');

  // once the cache has room again, the cache is the source again (same page, same CloudSave)
  limitRef.limit = 0;
  Object.assign(reload.c, { station: M.deserialize(reload.doc.station), agent: reload.doc.agent, agents: new Map(), liveAgents: () => [],
    Harness: { totals: () => ({}) }, Workstreams: { serialize: () => ({ workstreams: reload.doc.workstreams, activeId: 'general', generalId: 'general' }) },
    rosterPushFailed: false, pushRoster() {}, StationUI: { flashSave() {}, notify() {} } });
  vm.runInContext(app.slice(start, end), reload.c);
  A.eq(vm.runInContext('persist()', reload.c), true, 'B5: a later save that fits is written to the cache');
  A.eq(cachedFloor(ls, room), 'verdant', 'B5: the cache holds the newest station again');
  A.eq(reentrySave(reload.c).memory, false, 'B5: with the newest save cached, re-entry reads the cache again');
}

async function queuedAcknowledgement() {
  // Q: the station file confirms the first cache-failed save while another autosave is already queued (an agent run
  // keeps autosaves coming). The superseded cache entry is DIRTY (a cache-ok edit replaced within the debounce never
  // gets its own flush). Left in place, every boot resumed that older edit, pushed it on its stale revision and showed
  // "Another window saved newer station changes" until the user pressed Reload current station.
  const store = makeStore();
  const limitRef = { limit: 0 };
  const ls = quotaStorage(limitRef);
  const gate = { hold: null };
  const fetch = makeFetch(store, gate);
  const station = M.create();
  const room = station.spawnRoomId();
  const ws = { slice: { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'hello' }] }], activeId: 'general', generalId: 'general' } };
  const page = livePage(ls, fetch, station, ws);
  station.setFloor(room, 'amber'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  limitRef.limit = Array.from(ls._map).reduce((n, [k, v]) => n + k.length + v.length, 0) + 4000;
  station.setFloor(room, 'teal'); await tick();                          // fits in the cache, superseded before its flush
  A.ok(cachedFloor(ls, room) === 'teal' && JSON.parse(ls.getItem('starnet.save'))._saveDirty === true, 'Q precondition: the cache holds a dirty teal edit');
  ws.slice = { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'x'.repeat(20000) }] }], activeId: 'general', generalId: 'general' };
  station.setFloor(room, 'verdant'); await tick();                       // the cache write fails
  let release;
  gate.hold = new Promise(r => { release = r; });
  const inFlight = vm.runInContext('CloudSave.flush({ force: true })', page.c);
  station.setFloor(room, 'cobalt'); await tick();                        // another autosave lands during the flight
  A.ok(floorOf(reentrySave(page.c).doc, room) === 'cobalt' && cachedFloor(ls, room) === 'teal', 'Q precondition: cobalt is queued (in memory) while the verdant acknowledgement is in transit');
  gate.hold = null; release();
  A.eq(await inFlight, true, 'Q precondition: the station file confirms verdant');
  A.eq(floorOf(store.load('agent'), room), 'verdant', 'Q precondition: the station file holds verdant');
  A.eq(ls.getItem('starnet.save'), null, 'Q1: the confirmation removes the superseded cache entry even with a newer autosave queued');
  A.eq(floorOf(reentrySave(page.c).doc, room), 'cobalt', 'Q1: re-entry resumes the queued newest station from memory');

  // the page dies before the queued cobalt save is flushed
  for (let boot = 1; boot <= 2; boot++) {
    const reload = await reloadPage(ls, fetch);
    await vm.runInContext('CloudSave.flush({ force: true })', reload.c);   // whatever the boot queued, settle it now
    A.eq(floorOf(reload.doc, room), 'verdant', 'Q2 boot ' + boot + ': the reload resumes the confirmed station file, not the older cache');
    A.ok(!healthOf(reload.c).conflict, 'Q2 boot ' + boot + ': no false "another window saved newer changes" conflict');
    A.eq(floorOf(store.load('agent'), room), 'verdant', 'Q2 boot ' + boot + ': the station file still holds verdant');
  }

  // Q3 guard: a cache-ok save queued during the flight IS the cache entry, newer than the confirmed one. It is never
  // removed, even when both saves carry the same millisecond stamp.
  const store3 = makeStore();
  const limit3 = { limit: 0 };
  const ls3 = quotaStorage(limit3);
  const gate3 = { hold: null };
  const fetch3 = makeFetch(store3, gate3);
  const station3 = M.create();
  const room3 = station3.spawnRoomId();
  const ws3 = { slice: { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'hello' }] }], activeId: 'general', generalId: 'general' } };
  const page3 = livePage(ls3, fetch3, station3, ws3);
  station3.setFloor(room3, 'amber'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page3.c);
  limit3.limit = Array.from(ls3._map).reduce((n, [k, v]) => n + k.length + v.length, 0) + 4000;
  ws3.slice = { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'x'.repeat(20000) }] }], activeId: 'general', generalId: 'general' };
  // the frozen stamp must be NEWER than the confirmed amber save: in the same millisecond the store's anti-clobber +1
  // bump (savestore compareRevision) writes verdant at stamp+1 and the precondition below flaked (~1 run in 8)
  const amberAt = store3.load('agent').updatedAt;
  while (Date.now() <= amberAt) { /* wait out the amber save's millisecond */ }
  const stamp = vm.runInContext('Date.now = (t => () => t)(Date.now()); Date.now()', page3.c);   // both saves below carry ONE stamp
  station3.setFloor(room3, 'verdant'); await tick();                      // the cache write fails
  let release3;
  gate3.hold = new Promise(r => { release3 = r; });
  const flight3 = vm.runInContext('CloudSave.flush({ force: true })', page3.c);
  ws3.slice = { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'hello' }] }], activeId: 'general', generalId: 'general' };
  station3.setFloor(room3, 'crimson'); await tick();                      // the history shrank: this save fits the cache
  A.ok(cachedFloor(ls3, room3) === 'crimson' && JSON.parse(ls3.getItem('starnet.save')).updatedAt === stamp && store3.load('agent').updatedAt === stamp,
    'Q3 precondition: the queued crimson save is in the cache with the same stamp as the verdant save in transit');
  gate3.hold = null; release3();
  A.eq(await flight3, true, 'Q3 precondition: the station file confirms verdant');
  A.eq(cachedFloor(ls3, room3), 'crimson', 'Q3: confirming the older cache-failed save never removes the newer cached one');
  A.eq(reentrySave(page3.c).memory, false, 'Q3: re-entry reads the cache, which holds the newest station');
  await vm.runInContext('CloudSave.flush({ force: true })', page3.c);
  const reload3 = await reloadPage(ls3, fetch3);
  A.ok(floorOf(reload3.doc, room3) === 'crimson' && !healthOf(reload3.c).conflict, 'Q3: the reload resumes crimson with no conflict');
}

// EXPORT AGENT (backup.js) is the backup tool the RESUME screen offers. It must carry the station the user sees.
function loadBackup(c) { if (vm.runInContext('typeof Backup', c) === 'undefined') vm.runInContext(src('frontend/app/backup.js'), c); }
async function exported(c) {
  loadBackup(c);
  const bundle = await vm.runInContext('Backup.build()', c);
  let save = null;
  try { save = JSON.parse(bundle.store['starnet.save'] || 'null'); } catch (_) { save = null; }
  return { bundle, save, verdict: vm.runInContext('Backup.validate', c)(bundle) };
}
const exportSays = (e, room) => (e.verdict || 'valid') + ', floor ' + floorOf(e.save, room) + ', name ' + e.bundle.agentName;

async function exportCarriesTheStation() {
  // E: once the cache cannot hold the save, the station lives in this window's memory and the station file; the cache
  // entry is stale, then removed. EXPORT AGENT read only the cache: it saved the older station, then a file with no
  // save at all ("backup has no agent" on restore) while its status line still said it was saved.
  const store = makeStore();
  const limitRef = { limit: 0 };
  const ls = quotaStorage(limitRef);
  const gate = { down: false };
  const fetch = makeFetch(store, gate);
  const station = M.create();
  const room = station.spawnRoomId();
  const ws = { slice: { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'hello' }] }], activeId: 'general', generalId: 'general' } };
  const page = livePage(ls, fetch, station, ws);
  ls.setItem('starnet.theme', 'green');
  station.setFloor(room, 'amber'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  limitRef.limit = Array.from(ls._map).reduce((n, [k, v]) => n + k.length + v.length, 0) + 4000;
  ws.slice = { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'x'.repeat(20000) }] }], activeId: 'general', generalId: 'general' };
  gate.down = true;                                                      // the station file has not confirmed it yet
  station.setFloor(room, 'verdant'); await tick();
  A.eq(cachedFloor(ls, room), 'amber', 'E precondition: the cache still holds the older amber station');

  let e = await exported(page.c);
  A.ok(e.verdict === null && floorOf(e.save, room) === 'verdant' && e.bundle.agentName === 'NOVA', 'E1: before the station file confirms, the export carries the live verdant station, not the stale cache (got ' + exportSays(e, room) + ')');
  A.ok(!!e.save && !Object.prototype.hasOwnProperty.call(e.save, '_saveClient'), 'E1: the exported save carries no window transport id');
  A.eq(e.bundle.store['starnet.theme'], 'green', 'E1: other settings still ride along');

  gate.down = false;
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  A.eq(ls.getItem('starnet.save'), null, 'E precondition: the confirmed save removed the cache entry');
  e = await exported(page.c);
  A.ok(e.verdict === null && floorOf(e.save, room) === 'verdant' && e.bundle.agentName === 'NOVA', 'E2: after the cache entry is removed, the export still carries the station (got ' + exportSays(e, room) + ')');

  const reload = await reloadPage(ls, fetch);
  A.eq(floorOf(reload.doc, room), 'verdant', 'E precondition: the reload resumed the station file from memory');
  e = await exported(reload.c);
  A.ok(e.verdict === null && floorOf(e.save, room) === 'verdant' && e.bundle.agentName === 'NOVA', 'E3: after a station-file resume (the RESUME screen), the export carries the station (got ' + exportSays(e, room) + ')');
  Object.assign(reload.c, {
    Blob: function Blob() {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } }
  });
  const r = await vm.runInContext('Backup.exportAll()', reload.c);
  A.ok(r.ok && /^starnet-nova-/.test(r.file), 'E3: the saved file is named for the agent (got ' + r.file + ')');

  // the file restores the station on a browser with room for it
  const roomy = quotaStorage({ limit: 0 });
  const restore = pageContext(roomy, makeFetch(makeStore()));
  loadBackup(restore);
  const applied = vm.runInContext('Backup.applyBundle', restore)(JSON.parse(JSON.stringify(e.bundle)));
  A.ok(applied.ok && floorOf(vm.runInContext('Save.load()', restore), room) === 'verdant', 'E4: RESTORE BACKUP of that file brings back the verdant station');

  // control: with a healthy cache the export is the cache entry, byte for byte, as before
  const ls5 = quotaStorage({ limit: 0 });
  const station5 = M.create();
  const page5 = livePage(ls5, makeFetch(makeStore()), station5, { slice: { workstreams: [], activeId: null, generalId: null } });
  station5.setFloor(station5.spawnRoomId(), 'teal'); await tick();
  e = await exported(page5.c);
  A.ok(e.verdict === null && e.bundle.store['starnet.save'] === ls5.getItem('starnet.save'), 'E5 control: a healthy cache is exported exactly as stored');
}

async function cacheBudget() {
  // LB: a station far past the browser cap (the live one: ~4.3M chars, 10-23). #121 kept it saving to the station file,
  // but every persist still serialized it into one localStorage write that could only fail, and every boot raised the
  // "browser storage full" notice again. A save over Save.CACHE_MAX_CHARS is never offered to the cache: no write
  // attempt, no quota error, no notice; the station file is its store of record and the light follows its confirmation.
  // The origin quota is the real one (5 MiB counted as UTF-16 = 2,621,440 code units) and holds the real UI keys.
  const store = makeStore();
  const ls = quotaStorage({ limit: 2621440 });
  const saveWrites = { attempts: 0, quotaErrors: 0 };
  const setItem = ls.setItem;
  ls.setItem = (k, v) => {
    if (k === 'starnet.save') saveWrites.attempts++;
    try { setItem(k, v); } catch (e) { if (k === 'starnet.save') saveWrites.quotaErrors++; throw e; }
  };
  const prefs = {
    'starnet.widgets.v1': '{"v":1,"top":["feed:finance-today"],"bot":[]}',
    'starnet.hud': '{"pinned":true,"rect":{"x":0,"y":60,"w":3840,"h":2100},"widget":null}',
    'starnet.station.v1': JSON.stringify({ v: 1, notifs: [], pad: 'p'.repeat(400000) })   // ~0.4M chars of UI state, as live
  };
  for (const k of Object.keys(prefs)) ls.setItem(k, prefs[k]);
  const prefsIntact = () => Object.keys(prefs).every(k => ls.getItem(k) === prefs[k]);
  const gate = { down: false };
  const fetch = makeFetch(store, gate);
  const station = M.create();
  const room = station.spawnRoomId();
  const big = { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'h'.repeat(4300000) }] }], activeId: 'general', generalId: 'general' };
  const ws = { slice: big };
  const page = livePage(ls, fetch, station, ws);
  const skipped = vm.runInContext('Save.CACHE_SKIPPED', page.c);
  // (guarded with typeof so a build without the budget fails these lines and is still judged on the behaviour below)
  const budget = vm.runInContext('typeof Save.CACHE_MAX_CHARS === "number" ? Save.CACHE_MAX_CHARS : 0', page.c);
  A.ok(budget > 0 && budget < 2621440 - JSON.stringify(prefs).length, 'LB0: the cache budget leaves room for the UI state inside the origin quota');
  A.ok(vm.runInContext('typeof Save.fitsCache === "function" && Save.fitsCache("x".repeat(Save.CACHE_MAX_CHARS)) && !Save.fitsCache("x".repeat(Save.CACHE_MAX_CHARS + 1))', page.c), 'LB0: the budget boundary is inclusive');

  // repeated saves of the oversized station
  const floors = ['amber', 'teal', 'verdant', 'cobalt', 'crimson'];
  for (const f of floors) { station.setFloor(room, f); await tick(); }
  A.eq(saveWrites, { attempts: 0, quotaErrors: 0 }, 'LB1: five saves of an oversized station never attempt the browser cache (no quota error)');
  A.eq(page.notices.filter(n => n[3] && n[3].key === 'save-failed').length, 0, 'LB1: no "browser storage full" notice for a station that is simply too large to cache');
  A.eq(page.ui.flash, 0, 'LB1: no green "cache written" flash for a save the cache never held');
  let h = healthOf(page.c);
  A.ok(h.cacheFailed === true && h.cacheFailedReason === skipped && h.cacheFailedConfirmed === false, 'LB2: health records the skip, not yet confirmed by the station file');
  let light = saveLight(page.c);
  A.ok(light.cls === 'stale' && /NOT saved yet/.test(light.title), 'LB2: before the station file confirms, the light says NOT saved yet (got ' + light.cls + ': ' + light.title + ')');

  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  A.eq(floorOf(store.load('agent'), room), 'crimson', 'LB3: the station file holds the newest of the repeated saves');
  A.eq(store.load('agent').workstreams[0].history[0].content.length, 4300000, 'LB3: the station file holds the whole large history');
  light = saveLight(page.c);
  A.ok(light.cls === 'plain' && /^saved/.test(light.title) && /confirmed in the station file/.test(light.title), 'LB3: once confirmed the light is the healthy saved state, not a warning (got ' + light.cls + ': ' + light.title + ')');

  // a failed station-file write is reported and the change is kept
  gate.down = true;
  station.setFloor(room, 'onyx'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  light = saveLight(page.c);
  A.ok(light.cls === 'degraded' && /NOT saved/.test(light.title), 'LB4: a failed station-file write turns the light red: NOT saved (got ' + light.cls + ': ' + light.title + ')');
  A.eq(floorOf(store.load('agent'), room), 'crimson', 'LB4 precondition: the station file did not receive onyx');
  A.eq(floorOf(reentrySave(page.c).doc, room), 'onyx', 'LB4: the unsaved change is held in this window, never dropped');
  gate.down = false;
  await vm.runInContext('CloudSave.flush({ force: true })', page.c);
  A.eq(floorOf(store.load('agent'), room), 'onyx', 'LB5: the retry lands the held change in the station file');
  A.ok(/^saved/.test(saveLight(page.c).title), 'LB5: and the light returns to saved');

  // restart: the station file is restored without a cache write and without the notice
  const attemptsBefore = saveWrites.attempts;
  const reload = await reloadPage(ls, fetch);
  A.eq(floorOf(reload.doc, room), 'onyx', 'LB6: a restart restores the latest confirmed station from the station file');
  A.eq(reload.doc.workstreams[0].history[0].content.length, 4300000, 'LB6: with its whole history');
  A.eq(saveWrites.attempts, attemptsBefore, 'LB6: the boot never tries to copy the oversized station into the cache');
  A.eq(reload.revision, Number(store.load('agent')._saveRevision), 'LB6: the restored page carries the station file revision');
  A.ok(/^saved/.test(saveLight(reload.c).title), 'LB6: the restored page shows the saved light from the first frame');
  const notices2 = [];
  Object.assign(reload.c, { station: M.deserialize(reload.doc.station), agent: reload.doc.agent, agents: new Map(), liveAgents: () => [],
    Harness: { totals: () => ({}) }, Workstreams: { serialize: () => ({ workstreams: reload.doc.workstreams, activeId: 'general', generalId: 'general' }) },
    rosterPushFailed: false, pushRoster() {}, StationUI: { flashSave() {}, refreshSave() {}, notify: (...a) => notices2.push(a) } });
  vm.runInContext(app.slice(start, end), reload.c);
  vm.runInContext('persist()', reload.c);
  A.eq(notices2.length, 0, 'LB7: the first save after a restart raises no notice (the warning no longer returns every launch)');
  A.eq(saveWrites, { attempts: attemptsBefore, quotaErrors: 0 }, 'LB7: and attempts no cache write');

  // the dashboard's own preferences are untouched and still writable
  A.ok(prefsIntact(), 'LB8: dashboard pins, layout and station UI keys are byte-for-byte intact');
  ls.setItem('starnet.widgets.v1', '{"v":1,"top":["feed:fin-portfolio"],"bot":[]}');
  A.eq(ls.getItem('starnet.widgets.v1'), '{"v":1,"top":["feed:fin-portfolio"],"bot":[]}', 'LB8: a dashboard pin change still saves to browser storage');

  // upgrade from 0.13.5 with an older small save still cached: the station file wins, the old entry goes only after confirmation
  const store9 = makeStore();
  const ls9 = quotaStorage({ limit: 2621440 });
  const fetch9 = makeFetch(store9);
  const station9 = M.create();
  const room9 = station9.spawnRoomId();
  const ws9 = { slice: { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'hello' }] }], activeId: 'general', generalId: 'general' } };
  const page9 = livePage(ls9, fetch9, station9, ws9);
  station9.setFloor(room9, 'amber'); await tick();
  await vm.runInContext('CloudSave.flush({ force: true })', page9.c);
  A.eq(cachedFloor(ls9, room9), 'amber', 'LB9 precondition: a small station is cached exactly as before');
  ws9.slice = big;
  station9.setFloor(room9, 'verdant'); await tick();
  A.eq(cachedFloor(ls9, room9), 'amber', 'LB9: the older cache entry stays until the station file confirms the larger save');
  await vm.runInContext('CloudSave.flush({ force: true })', page9.c);
  A.eq(ls9.getItem('starnet.save'), null, 'LB9: after confirmation the superseded cache entry is removed');
  const reload9 = await reloadPage(ls9, fetch9);
  A.eq(floorOf(reload9.doc, room9), 'verdant', 'LB9: the restart resumes the larger station, not the older cache');
}

(async () => {
  await cacheBudget();
  await scenario('S1 clean stale cache', { dirtyCache: false });
  await scenario('S2 dirty stale cache', { dirtyCache: true });
  await controlOfflineEdit();
  await bootFromStationFile();
  await queuedAcknowledgement();
  await exportCarriesTheStation();
  await truthfulStatus();
  A.report('save-quota-writethrough');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
