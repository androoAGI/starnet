'use strict';
/* test/helpers/seal-rig.js — the production page and the production station routes, wired the way the app wires them, for the tests of
   save-history-by-reference step S5 (test/save-envelope-budget.test.js, test/history-seal.property.test.js).

   THE STATION is the REAL transcript store (over whatever io the test gives it) behind the REAL route handlers sliced out of
   sidecar/index.js (serveTranscript, handleTranscriptRows, handleTurnIdentityRetractions, handleTurnIdentityRetract,
   transcriptProjection); the only fake is the sandbox those handlers run in and the transport (fetch) that hands each request to the
   handler the sidecar would route it to.

   THE PAGE is the REAL Workstreams / HistoryRef / TurnMerge / HistoryFit, the REAL Harness.api client, chat.js's read seam
   (hydrateHistory, reconcileServerHistory, ensureHistoryReady, the seal pass and the seal sweep's read) and app.js's idle passes
   (hydration and seal sweep) lifted by name, the way test/history-hydrate.seam.test.js lifts them.

   `root` is the frontend tree the page is made of ('frontend/app' or 'website/app/app'); SEAL_CONTROL_ROOT names another tree (an
   older build's files, for the RED proof of a test: node test/<file> with SEAL_CONTROL_ROOT=<dir holding that build's frontend/app *.js>). */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const A = require('../_assert.js');
const { readSidecarSource } = require('./source');
const { harnessApi, answer } = require('./harness-api');
const Dual = require('../../sidecar/turn-dual.js');

const REPO = path.join(__dirname, '..', '..');
const SOURCE = readSidecarSource();
const ROUTES = ['async function handleTranscriptRows(req, res)', 'function serveTranscript(req, res)', 'function transcriptProjection(stream, rows, extra)',
  'async function handleTurnIdentityRetractions(req, res)', 'async function handleTurnIdentityRetract(req, res)'].map(h => {
  const body = A.fnBody(SOURCE, h); A.ok(body.length > 200 && body.length < 6000, 'the route slice is bounded: ' + h); return body; }).join('\n');

const clone = v => JSON.parse(JSON.stringify(v));
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* the frontend tree: the page's modules and the text of chat.js / app.js */
function tree(root) {
  const base = process.env.SEAL_CONTROL_ROOT ? path.resolve(process.env.SEAL_CONTROL_ROOT) : path.join(REPO, root);
  const load = f => require(path.join(base, f));
  return { base, W: load('workstreams.js'), HR: load('historyref.js'), TM: load('turnmerge.js'), Fit: load('historyfit.js'), Save: load('save.js'),
    chat: fs.readFileSync(path.join(base, 'chat.js'), 'utf8'), app: fs.readFileSync(path.join(base, 'app.js'), 'utf8') };
}

/* the station's routes over a transcript store. o: { store, dual?, live?, deleted? (Map streamId -> deletedAt) } */
function routes(o) {
  const live = o.live || new Set(), deleted = o.deleted || new Map();
  const dual = o.dual || Dual.make({ now: () => 1, hash: s => crypto.createHash('sha256').update(s).digest('hex') });
  // forgetStreamSummaries is the host's hook the retract routes call (context-budget-and-fold: a retracted row drops the stream's kept summaries); the ledger is not under test here, so it is a no-op
  const sandbox = { transcriptStore: o.store, turnDual: dual, transcriptLiveRuns: live, transcriptIo: { isCollided: id => (o.isCollided ? o.isCollided(id) : false) },
    sessionTombstones: { deletedAt: sid => deleted.get(sid) || 0 }, readBody: async req => req.body, respondJson: (res, code, obj) => { res.code = code; res.body = obj; },
    forgetStreamSummaries: () => {}, refuseBadAgentId: () => false, readRouteFailure: (name, e) => ({ error: String(e && e.message || e) }), failNote() {}, transcriptRunSince: () => 0, URL };
  vm.runInNewContext(ROUTES + '\nthis.routes = { handleTranscriptRows, serveTranscript, handleTurnIdentityRetractions, handleTurnIdentityRetract, transcriptProjection };', sandbox,
    { filename: 'sidecar/index.js (transcript routes)' });
  return Object.assign({ dual, live, deleted }, sandbox.routes);
}

/* the transport: every request the page makes goes to the handler the sidecar would route it to. t.down = the station does not answer */
function transport(r) {
  const calls = [], t = { calls, gate: null, gateGet: null, down: false, status: 0 };
  t.fetch = async (url, init) => {
    const u = new URL(url, 'http://station.test'), method = (init && init.method) || 'GET', res = { code: 0, body: null };
    calls.push({ method, path: u.pathname, search: u.search, body: init && init.body ? JSON.parse(init.body) : null });
    if (t.down) throw new TypeError('Failed to fetch');
    if (t.gate && u.pathname === '/api/transcript/rows') await t.gate.promise;
    if (t.gateGet && method === 'GET' && u.pathname === '/api/transcript') await t.gateGet.promise;
    if (t.status && u.pathname === '/api/transcript/rows') return answer(t.status, { error: 'down' });
    if (method === 'GET' && u.pathname === '/api/transcript') r.serveTranscript({ url: u.pathname + u.search }, res);
    else if (method === 'POST' && u.pathname === '/api/transcript/rows') await r.handleTranscriptRows({ body: init.body }, res);
    else if (method === 'POST' && u.pathname === '/api/turn-identity/retractions') await r.handleTurnIdentityRetractions({ body: init.body }, res);
    else if (method === 'POST' && u.pathname === '/api/turn-identity/retract') await r.handleTurnIdentityRetract({ body: init.body }, res);
    else { res.code = 404; res.body = { error: 'no route' }; }
    return answer(res.code, res.body);
  };
  t.rowsCalls = () => calls.filter(c => c.path === '/api/transcript/rows');
  return t;
}

/* THE PAGE. o: { tree|root, tp (a transport), init (a saved slice for Workstreams.init, optional), persisted (an array: each App.persist pushes the JSON of
   Workstreams.serialize(), as App.persist hands it to Save.write), activeWs, onPersist (called with that JSON), beforePersist (called just before
   it is built), fakeTimers (the page's timers never fire by themselves: page.fire() runs the pending ones) } */
function page(o) {
  const T = o.tree || tree(o.root), { W, HR, TM, Fit } = T;
  if (o.init) W.init(clone(o.init));
  const busy = new Set(), persisted = o.persisted || [], renders = { n: 0 }, polls = [], notes = [];
  const api = harnessApi(o.tp.fetch);
  // o.fakeTimers: the page's timers never fire by themselves (the seal pass waits 2 s after a run); fire() runs the pending ones
  const timers = new Map();
  let timerSeq = 0;
  const fake = !!o.fakeTimers, setT = fake ? ((fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; }) : setTimeout, clearT = fake ? (id => { timers.delete(id); }) : clearTimeout;
  let persistCount = 0;
  const persistFn = () => { persistCount++; if (o.beforePersist) o.beforePersist(); const json = JSON.stringify(W.serialize()); persisted.push(json); if (o.onPersist) o.onPersist(json); return true; };
  const ctx = vm.createContext({ TurnMerge: TM, HistoryFit: Fit, HistoryRef: HR, stationModes: {}, stationCaps: {}, Workstreams: W, Harness: { api },
    fetch: o.tp.fetch, Channels: { isBusy: id => busy.has(id), anyBusy: () => busy.size > 0 }, App: { persist: persistFn },
    setTimeout: setT, clearTimeout: clearT, AbortController, Date, WeakMap, WeakSet, Map, Set, Promise, URL, JSON,
    renderHistory() { renders.n++; }, replayChannel() {}, syncStatus() {}, maybeEmptyState() {}, pinLoadedHistoryAfterLayout() {},
    localLine(line) { notes.push(line); }, isBusy: () => false, load() {}, refreshWorkflowViews() {},
    log: { innerHTML: '' }, activeWs: o.activeWs || null, historyPinSeq: 3, historyPinPending: 0, revealKey: '', stick: true });
  ctx.isActiveWs = ws => !!(ws && ctx.activeWs && ctx.activeWs.id === ws.id);
  const chat = T.chat;
  const merge = require('./turnmerge').source('mergeCanonicalHistory') + '\n' + A.fnBody(chat, 'function placeSteerNotes(rows)');
  const start = chat.indexOf('  const historyLoads = new WeakMap();'), seam = chat.slice(start, chat.indexOf('\n  // swap the rendered conversation', start));
  A.ok(start > 0 && seam.length > 1000, 'the chat.js read seam was found');
  const sealAt = chat.indexOf('  /* THE SEAL PASS (save v7'), sealEnd = chat.indexOf('\n  async function restoreTaskQuestion(ws) {', sealAt);
  const sealSeam = sealAt > 0 && sealEnd > sealAt ? chat.slice(sealAt, sealEnd) : '';   // (absent in a build that predates the seal pass)
  const commands = ['function afterHydration(ws, run)', 'async function undoCommand()'].map(h => A.fnBody(chat, h)).join('\n');
  vm.runInContext(merge + '\n' + seam + '\n' + sealSeam + '\n' + commands + '\nthis.api={loadServerHistory,ensureHistoryReady,hydrateHistory,continuityDiagnostics,undoCommand'
    + (sealSeam ? ',sealRows,sealSoon,sealPass,sealLeft' : '') + '};', ctx);
  if (typeof W.setHydrator === 'function') W.setHydrator(ws => ctx.api.hydrateHistory(ws, { windowMs: 20000 }));
  // app.js: the idle passes (hydration, then the seal sweep)
  const app = T.app;
  const passAt = app.indexOf('  const HYDRATE_PER_TICK'), passEnd = app.indexOf('  let unsubscribeStationSave', passAt);
  const pass = vm.createContext({ Workstreams: W, Chat: { hydrateHistory: (ws, op) => ctx.api.hydrateHistory(ws, op), sealRows: b => ctx.api.sealRows ? ctx.api.sealRows(b) : Promise.resolve({ asked: 0, sealed: 0 }) },
    Channels: { anyBusy: () => busy.size > 0 }, renderRail() { renders.n++; }, persist: persistFn,
    PollGate: { every(fn, op) { const loop = { fn, op, stopped: false, stop() { loop.stopped = true; } }; polls.push(loop); return loop; } }, Date, Map, Promise, setInterval, clearInterval });
  if (passAt > 0 && passEnd > passAt) vm.runInContext(app.slice(passAt, passEnd) + '\nthis.arm = armHistoryHydration; this.tick = hydrateTick; this.sweep = typeof sealSweepTick === "function" ? sealSweepTick : null; this.armSweep = typeof armSealSweep === "function" ? armSealSweep : null;', pass);
  const open = id => { const ws = W.get(id); ctx.activeWs = ws; return ws; };
  const fire = () => { const due = Array.from(timers.values()); timers.clear(); for (const t of due) t.fn(); return due.length; };
  return { W, HR, TM, Fit, T, api: ctx.api, ctx, busy, fire, persisted, renders, polls, notes, persistCount: () => persistCount, persist: persistFn,
    arm: () => pass.arm && pass.arm(), tick: () => pass.tick && pass.tick(), sweep: () => pass.sweep ? pass.sweep() : Promise.resolve(false), armSweep: () => pass.armSweep && pass.armSweep(),
    hasSweep: !!pass.sweep, hasSeal: !!sealSeam, open, load: id => { const ws = open(id); return ctx.api.loadServerHistory(ws, 3); },
    events: () => Array.from(ctx.api.continuityDiagnostics(), e => e.event) };
}

module.exports = { clone, flush, deferred, rng, tree, routes, transport, page, REPO };
