/* node test/save-cache-skip.test.js — #121 follow-up, part 2. A save UNDER the cache budget that the browser still refuses for
   its QUOTA is not retried on every persist; the WHOLE save keeps going to the station file; and whenever a save rides the
   station file alone (budget or quota), the station file's own acknowledgement decides the notice.

   Real modules, fake storage edges (the save-quota-writethrough.test.js harness): the shipped Save, CloudSaveCore,
   CloudSave and Backup, the shipped persist/watch block sliced from app.js, and the shipped durable SaveStore
   (sidecar/savestore.js) over an in-memory fs. localStorage enforces a per-origin quota the way WebKit/WebView2 do.

   K1 a quota refusal arms the skip; the next saves are not offered to the cache, and every one reaches the station file whole
   K2 no partial cache: while skipping, the cache holds a whole older save or nothing — never a newer or trimmed one
   K3 re-entry and a reload resume the newest station (memory / station file), never the stale cache
   K4 EXPORT AGENT carries the whole newest save
   K5 never "confirmed" on a push alone: a queued, unacknowledged save is waiting, and no informational notice shows
   K6 the station file failing -> the genuine warning; no acknowledgement for 30 s -> the genuine warning (uncertain)
   K7 another window saved past this one while skipping: its change is never overwritten, this window's change is never
      dropped (latched as a conflict, or merged three-way by the station — routed here like sidecar/save-merge.js), and the
      notice is "confirmed" only when the station file holds this window's change
   K8 a save that shrinks to fit is written to the cache at once, and the accepted write clears the skip
   K9 after the retry interval a still-too-big save is offered once more; the refusal re-arms the skip
   K10 the save version is unchanged (Save.CURRENT) and a non-quota refusal keeps its immediate warning
   K11 a save over the cache budget (#154) never reaches the cache and stays silent once confirmed; the station file
      failing still raises the genuine warning */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const src = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const M = require('../frontend/app/worldmodel.js');
const SaveMerge = require('../sidecar/save-merge.js');

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
  const ctx = vm.createContext({ module: { exports: {} }, console: { warn() {}, log() {} }, Buffer });
  vm.runInContext(src('sidecar/savestore.js'), ctx);
  return ctx.module.exports.makeSaveStore({ fs: memfs(), pathMod: path.posix, root: '/ws', clock: { now: () => Date.now() } });
}
// per-origin quota (total chars across every key); counts every attempt to write the save key
function quotaStorage(limitRef) {
  const m = new Map();
  const used = (k, v) => { let n = 0; for (const [kk, vv] of m) if (kk !== k) n += kk.length + vv.length; return n + k.length + v.length; };
  const s = {
    _map: m, saveAttempts: 0,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      v = String(v);
      if (k === 'starnet.save') s.saveAttempts++;
      if (limitRef.limit && used(k, v) > limitRef.limit) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, v);
    },
    removeItem: k => { m.delete(k); },
    get length() { return m.size; },
    key: i => Array.from(m.keys())[i] || null
  };
  return s;
}
function makeFetch(store, gate) {
  return async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    if (gate && gate.down) throw new Error('sidecar unreachable');
    if (method === 'POST' && u.startsWith('/api/save')) {
      const body = JSON.parse(opts.body);
      gate && gate.posts && gate.posts.push(body);
      // a window another window saved past sends its work as a three-way merge: routed like the sidecar does (index.js
      // handleSave -> sidecar/save-merge.js write), onto the station file as it is now
      if (body._saveMerge && typeof body._saveMerge === 'object') {
        const out = SaveMerge.write(body, { saveStore: store, agentId: 'agent', now: Date.now() });
        return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
      }
      const result = store.save('agent', body, { compareRevision: true });
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
const resumableSrc = A.fnBody(app, '  function resumableSave()');
A.ok(resumableSrc.length > 50 && resumableSrc.length < 2000, 'resumableSave() is sliced from app.js');
const tick = () => new Promise(r => setTimeout(r, 0));
const floorOf = (doc, room) => doc && doc.station && doc.station.rooms && doc.station.rooms[room] && doc.station.rooms[room].floorStyle;
const histLen = doc => (doc && doc.workstreams && doc.workstreams[0] && doc.workstreams[0].history && doc.workstreams[0].history[0]) ? String(doc.workstreams[0].history[0].content).length : -1;
const BIG = 20000;
const bigSlice = () => ({ workstreams: [{ id: 'general', history: [{ role: 'user', content: 'x'.repeat(BIG) }] }], activeId: 'general', generalId: 'general' });

function livePage(ls, fetch, station, ws) {
  const notices = [], settled = [];
  const c = pageContext(ls, fetch, {
    station, agent: { id: 'agent', name: 'NOVA' }, agents: new Map(), liveAgents: () => [],
    Harness: { totals: () => ({}) }, Workstreams: { serialize: () => ws.slice }, rosterPushFailed: false, pushRoster() {},
    StationUI: { flashSave() {}, refreshSave() {}, notify: (...a) => notices.push(a), settleNotifs: k => settled.push(k) }
  });
  vm.runInContext(app.slice(start, end), c);
  vm.runInContext('watchStationSave()', c);
  vm.runInContext(resumableSrc, c);
  return { c, notices, settled };
}
const run = (p, code) => vm.runInContext(code, p.c);
const warnings = p => p.notices.filter(n => n[3] && n[3].key === 'save-failed');
const infos = p => p.notices.filter(n => /station file instead/.test(String(n[0])));

// a station that saved once into a roomy cache, then grows past the origin's quota
async function fullCachePage(gate) {
  const store = makeStore();
  const limitRef = { limit: 0 };
  const ls = quotaStorage(limitRef);
  const g = gate || { down: false, posts: [] };
  const fetch = makeFetch(store, g);
  const station = M.create();
  const room = station.spawnRoomId();
  const ws = { slice: { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'hello' }] }], activeId: 'general', generalId: 'general' } };
  const page = livePage(ls, fetch, station, ws);
  station.setFloor(room, 'amber'); await tick();
  await run(page, 'CloudSave.flush({ force: true })');
  limitRef.limit = Array.from(ls._map).reduce((n, [k, v]) => n + k.length + v.length, 0) + 4000;
  ws.slice = bigSlice();
  return { store, limitRef, ls, gate: g, fetch, station, room, ws, page };
}

async function skipAndStationFile() {
  const t = await fullCachePage();
  const { page, ls, station, room, store } = t;
  const amberRaw = ls.getItem('starnet.save');
  const base = ls.saveAttempts;                                          // (the setup's save and its acknowledgement wrote the cache)
  station.setFloor(room, 'verdant'); await tick();                      // the first refusal: the browser said quota
  A.eq(ls.saveAttempts, base + 1, 'K1 precondition: the first oversized save was offered to the cache once (and refused)');
  const hit = run(page, 'SaveCacheSkip.state().hit');
  A.ok(hit && hit.chars > BIG, 'K1: the quota refusal arms the cache skip with the refused save\'s length');
  for (const f of ['teal', 'cobalt', 'crimson']) { station.setFloor(room, f); await tick(); }
  A.eq(ls.saveAttempts, base + 1, 'K1: the next three same-size saves are not offered to the cache at all');
  await run(page, 'CloudSave.flush({ force: true })');
  const durable = store.load('agent');
  A.eq(floorOf(durable, room), 'crimson', 'K1: the station file receives the newest save while the cache is skipped');
  A.eq(histLen(durable), BIG, 'K1: the station file\'s save is whole (the full session history, untrimmed)');
  A.ok(durable.schema === 'starnet.save' && durable.agent && durable.agent.name === 'NOVA' && durable.station && Array.isArray(durable.workstreams),
    'K1: the station file\'s save is the complete envelope (schema, agent, station, sessions)');
  // K2: the cache holds a whole OLDER save until the station file confirms, then nothing — never a partial or newer one
  A.eq(ls.getItem('starnet.save'), null, 'K2: once the station file confirms, the superseded cache entry is removed (as #121)');
  A.ok(amberRaw && histLen(JSON.parse(amberRaw)) === 5 && floorOf(JSON.parse(amberRaw), room) === 'amber', 'K2 control: the only cache entry ever written was the whole amber save');
  // K3: re-entry and reload
  const re = run(page, 'resumableSave()');
  A.ok(re.memory === true && floorOf(re.doc, room) === 'crimson' && histLen(re.doc) === BIG, 'K3: re-entry resumes the whole newest station from memory');
  const reload = pageContext(ls, t.fetch);
  const doc = await vm.runInContext('CloudSave.reconcile(Save.load())', reload);
  A.ok(floorOf(doc, room) === 'crimson' && histLen(doc) === BIG, 'K3: a reload resumes the whole newest station from the station file');
  A.eq(vm.runInContext('CloudSave.revision()', reload), Number(store.load('agent')._saveRevision), 'K3: the reloaded page carries the station file revision');
  // K4: export
  vm.runInContext(src('frontend/app/backup.js'), page.c);
  const bundle = await run(page, 'Backup.build()');
  const saved = JSON.parse(bundle.store['starnet.save'] || 'null');
  A.ok(run(page, 'Backup.validate')(bundle) === null && floorOf(saved, room) === 'crimson' && histLen(saved) === BIG, 'K4: EXPORT AGENT carries the whole newest save');
  // the notice: one informational line once the station file confirmed, no warning
  A.eq(run(page, 'SaveCacheSkip.check(Date.now())'), 'confirmed', 'K1: the watcher reads the station file confirmation');
  A.ok(infos(page).length === 1 && warnings(page).length === 0, 'K1: one informational notice, no warning, for a confirmed station-file save');
}

async function neverConfirmOnPush() {
  const t = await fullCachePage();
  const { page, station, room } = t;
  station.setFloor(room, 'verdant'); await tick();                      // queued for the station file, not flushed
  A.ok(run(page, 'CloudSave.health()').cacheFailedConfirmed === false, 'K5 precondition: the save is queued, not acknowledged');
  A.eq(run(page, 'SaveCacheSkip.check(Date.now())'), 'waiting', 'K5: a pushed but unacknowledged save is never read as confirmed');
  A.eq(infos(page).length + warnings(page).length, 0, 'K5: no informational notice and no warning yet');
  // K6b: no acknowledgement at all for 30 s is uncertain, and uncertain is a warning
  A.eq(run(page, 'SaveCacheSkip.check(Date.now() + 31000)'), 'warned', 'K6: no station-file acknowledgement for 30 s raises the warning');
  A.ok(warnings(page).length === 1 && warnings(page)[0][3].kind === 'alert', 'K6: the timeout warning is a bell alert');
  await run(page, 'CloudSave.flush({ force: true })');
  A.eq(run(page, 'SaveCacheSkip.check(Date.now())'), 'confirmed', 'K6: the late acknowledgement is read');
  A.ok(page.settled.indexOf('save-failed') >= 0 && infos(page).length === 1, 'K6: the warning is settled and the informational line follows');
}

async function stationFileFails() {
  const t = await fullCachePage();
  const { page, station, room, gate } = t;
  gate.down = true;
  station.setFloor(room, 'verdant'); await tick();
  await run(page, 'CloudSave.flush({ force: true })');
  A.eq(run(page, 'SaveCacheSkip.check(Date.now())'), 'warned', 'K6: a failed station-file write raises the warning');
  const w = warnings(page);
  A.ok(w.length === 1 && w[0][1] === 'warn' && /NOT saved/.test(String(w[0][0])), 'K6: one genuine warning that says the change is NOT saved');
  A.eq(infos(page).length, 0, 'K6: no informational "confirmed" line while the station file fails');
  station.setFloor(room, 'teal'); await tick();
  await run(page, 'CloudSave.flush({ force: true })');
  run(page, 'SaveCacheSkip.check(Date.now())');
  A.eq(warnings(page).length, 1, 'K6: the warning is not repeated while the failure stands');
  gate.down = false;
  await run(page, 'CloudSave.flush({ force: true })');
  A.eq(floorOf(t.store.load('agent'), room), 'teal', 'K6: the station file receives the held change once reachable');
  A.eq(run(page, 'SaveCacheSkip.check(Date.now())'), 'confirmed', 'K6: recovery is read as confirmed');
}

async function conflictWhileSkipping() {
  const t = await fullCachePage();
  const { page, station, room, store } = t;
  station.setFloor(room, 'verdant'); await tick();
  await run(page, 'CloudSave.flush({ force: true })');
  // another window writes the station file first (it renames the room): this page's next save (a new floor) is behind it
  const other = JSON.parse(JSON.stringify(store.load('agent')));
  other.station.rooms[room].name = 'OTHER WINDOW'; other.updatedAt = Number(other.updatedAt) + 5000; other._saveClient = 'other-window-1';
  A.ok(store.save('agent', other, { compareRevision: true }).ok, 'K7 precondition: another window advanced the station file');
  station.setFloor(room, 'teal'); await tick();
  await run(page, 'CloudSave.flush({ force: true })');
  const h = run(page, 'CloudSave.health()'), durable = store.load('agent');
  // the station resolves the conflict one of two ways: it LATCHES it (this window's save preserved beside the station
  // file, the conflict banner), or — the newer behavior — it MERGES this window's work three-way onto the station file.
  // Either way the protection is the same, and it is what this checks:
  const latched = !!h.conflict, merged = floorOf(durable, room) === 'teal';
  A.eq(durable.station.rooms[room].name, 'OTHER WINDOW', 'K7: the other window\'s change in the station file is never overwritten');
  A.ok(latched || merged, 'K7: this window\'s change is never silently dropped — merged into the station file, or held as a conflict (latched ' + latched + ', merged ' + merged + ')');
  const s = run(page, 'SaveCacheSkip.check(Date.now())');
  // a merged result must come from the station's three-way merge of THIS window's delta, never from a plain overwrite
  if (merged) A.ok(t.gate.posts.some(p => p._saveMerge && typeof p._saveMerge === 'object'), 'K7: the merge landed through the station\'s three-way merge (_saveMerge), not a plain overwrite');
  if (latched) A.eq(s, 'warned', 'K7: a standing conflict is a genuine warning');
  // "confirmed" only when the station file acknowledged this window's newest save — here, the merge that holds it
  A.ok(s !== 'confirmed' || (merged && run(page, 'CloudSave.health()').cacheFailedConfirmed === true), 'K7: never "confirmed" unless the station file holds this window\'s change (got ' + s + ')');
  A.ok(s === 'confirmed' || s === 'warned', 'K7: the conflict ends in a definite state — confirmed (merged, acknowledged) or a warning (got ' + s + ')');
}

async function shrinkAndRetry() {
  const t = await fullCachePage();
  const { page, ls, station, room, ws } = t;
  station.setFloor(room, 'verdant'); await tick();
  station.setFloor(room, 'teal'); await tick();
  const attempts = ls.saveAttempts;
  // K8: the history shrinks (e.g. a session cleared): the save now fits and is offered — and accepted — at once
  ws.slice = { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'short' }] }], activeId: 'general', generalId: 'general' };
  station.setFloor(room, 'crimson'); await tick();
  A.eq(ls.saveAttempts, attempts + 1, 'K8: a materially smaller save is offered to the cache right away');
  const cached = JSON.parse(ls.getItem('starnet.save') || 'null');
  A.ok(floorOf(cached, room) === 'crimson' && cached.workstreams[0].history[0].content === 'short', 'K8: the cache holds the whole newest save');
  A.eq(run(page, 'SaveCacheSkip.state().hit'), null, 'K8: the accepted write clears the skip');
  A.eq(run(page, 'resumableSave()').memory, false, 'K8: with the newest save cached, re-entry reads the cache again');
  A.eq(run(page, 'CloudSave.health()').cacheFailed, false, 'K8: CloudSave records the cache as holding the newest save');

  // K9: grow again, then let the retry interval pass with the save still too big
  ws.slice = bigSlice();
  station.setFloor(room, 'amber'); await tick();
  const first = run(page, 'SaveCacheSkip.state().hit');
  A.ok(!!first, 'K9 precondition: the oversized save re-armed the skip');
  const before = ls.saveAttempts;
  station.setFloor(room, 'verdant'); await tick();
  A.eq(ls.saveAttempts, before, 'K9: inside the retry interval the oversized save is skipped');
  run(page, 'Date.now = (t => () => t)(Date.now() + 10 * 60 * 1000 + 1)');
  station.setFloor(room, 'teal'); await tick();
  A.eq(ls.saveAttempts, before + 1, 'K9: after the retry interval the cache is offered the save once more');
  const again = run(page, 'SaveCacheSkip.state().hit');
  A.ok(again && again.at > first.at, 'K9: the renewed refusal re-arms the skip from now');
  await run(page, 'CloudSave.flush({ force: true })');
  A.eq(floorOf(t.store.load('agent'), room), 'teal', 'K9: the station file still receives every save');
}

async function versionAndRefusal() {
  const t = await fullCachePage();
  const { page, station, room, store } = t;
  station.setFloor(room, 'verdant'); await tick();
  await run(page, 'CloudSave.flush({ force: true })');
  A.eq(store.load('agent').version, run(page, 'Save.CURRENT'), 'K10: the station file save carries this build\'s save version, unchanged');
  // a refusal that is NOT the browser's quota keeps its immediate warning and is retried on every save (no skip)
  const refusing = { saveAttempts: 0, getItem: () => null, setItem(k) { if (k === 'starnet.save') refusing.saveAttempts++; const e = new Error('denied'); e.name = 'SecurityError'; throw e; }, removeItem() {} };
  const st2 = M.create();
  const p2 = livePage(refusing, makeFetch(makeStore()), st2, { slice: { workstreams: [], activeId: null, generalId: null } });
  const r2 = st2.spawnRoomId();
  st2.setFloor(r2, 'amber'); await tick();
  st2.setFloor(r2, 'teal'); await tick();
  A.ok(/refused/i.test(String((p2.notices[0] || [])[0])) && p2.notices[0][1] === 'warn', 'K10: a non-quota refusal warns at once, as before');
  A.eq(refusing.saveAttempts, 2, 'K10: a non-quota refusal is retried on every save (it never arms the skip)');
  A.eq(vm.runInContext('SaveCacheSkip.state().hit', p2.c), null, 'K10: no skip is armed for a non-quota refusal');
}

async function overBudget() {
  // K11: a station over the cache budget (save.js CACHE_MAX_CHARS) is never offered to the cache — #154's behavior, kept:
  // a confirmed station-file save is silent (no informational line), and only the station file failing warns.
  const store = makeStore();
  const ls = quotaStorage({ limit: 0 });                                  // a roomy cache: only the budget can keep the save out
  const gate = { down: false, posts: [] };
  const station = M.create();
  const room = station.spawnRoomId();
  const max = (() => { const c = pageContext(ls, makeFetch(store, gate)); return vm.runInContext('Save.CACHE_MAX_CHARS', c); })();
  A.ok(max > 0, 'K11 precondition: the build carries the cache budget');
  const ws = { slice: { workstreams: [{ id: 'general', history: [{ role: 'user', content: 'y'.repeat(max + 1000) }] }], activeId: 'general', generalId: 'general' } };
  const page = livePage(ls, makeFetch(store, gate), station, ws);
  station.setFloor(room, 'amber'); await tick();
  A.eq(ls.saveAttempts, 0, 'K11: a save over the budget is never offered to the cache');
  A.eq(run(page, 'SaveCacheSkip.state().hit'), null, 'K11: the budget skip is not a quota refusal (no quota skip armed)');
  await run(page, 'CloudSave.flush({ force: true })');
  A.eq(floorOf(store.load('agent'), room), 'amber', 'K11: the station file receives the whole over-budget save');
  A.eq(run(page, 'SaveCacheSkip.check(Date.now())'), 'confirmed', 'K11: the watcher reads the station file confirmation');
  A.eq(page.notices.length, 0, 'K11: a confirmed over-budget save raises no notice at all (the budget is the expected home)');
  gate.down = true;
  station.setFloor(room, 'teal'); await tick();
  await run(page, 'CloudSave.flush({ force: true })');
  A.eq(run(page, 'SaveCacheSkip.check(Date.now())'), 'warned', 'K11: an over-budget save the station file fails to take raises the genuine warning');
  A.ok(warnings(page).length === 1 && /NOT saved/.test(String(warnings(page)[0][0])), 'K11: one warning, saying the change is NOT saved');
  gate.down = false;
  await run(page, 'CloudSave.flush({ force: true })');
  A.eq(run(page, 'SaveCacheSkip.check(Date.now())'), 'confirmed', 'K11: recovery is read as confirmed');
  A.ok(page.settled.indexOf('save-failed') >= 0 && infos(page).length === 0, 'K11: the warning is settled, and still no informational line for the budget');
}

(async () => {
  await overBudget();
  await skipAndStationFile();
  await neverConfirmOnPush();
  await stationFileFails();
  await conflictWhileSkipping();
  await shrinkAndRetry();
  await versionAndRefusal();
  A.report('save-cache-skip');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
