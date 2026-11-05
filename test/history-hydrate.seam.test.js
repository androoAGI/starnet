'use strict';
/* node test/history-hydrate.seam.test.js — INVARIANT packed-history-hydrates-every-turn (save-history-by-reference, step S4).

   Save v7 lets a session's saved history NAME a run of rows the station's transcript holds ({ "$ref": … }) instead of repeating
   them. The page must read such a save as faithfully as it reads an inline one: the rail must tell the truth before any row
   is read, the open session must come back row for row, the sessions nobody opens must come back in the background, a persist before
   that must not rewrite what it has not read, and a row the station cannot return must never be guessed or dropped.

   Production wiring, fakes only at the transport: the REAL transcript store over the REAL segmented io (small segments, so a long
   stream needs more than one rows-by-id request), the REAL route handlers (handleTranscriptRows, serveTranscript,
   handleTurnIdentityRetractions, transcriptProjection) sliced out of sidecar/index.js, the REAL Harness.api client, the REAL
   Workstreams / HistoryRef / TurnMerge / HistoryFit, chat.js's reconcile seam lifted the way history-restore-boot-race.test.js
   lifts it (hydrateHistory, reconcileServerHistory, ensureHistoryReady), and app.js's idle pass and rail receipt lifted by name.
   The only fake is fetch(): it hands each request to the handler the sidecar would route it to. Both shipped trees run.

     · BEFORE any row is read: the rail's count, preview and blank test are the truth (a packed session is not "No messages yet",
       is not a blank line, names a newest message only when its inline tail proves it), a persist re-emits the packed history
       verbatim, with the rows pushed since after it, and no second copy of it, and search/export/archive never judge from half;
     · the open session reads back to exactly its original rows (page-only fields included), once, in place, with a row pushed
       meanwhile after them; reconcile then merges the station over them and asks the retraction proof only about rows it did not
       just read;
     · the idle pass reads the rest newest first, twenty a tick, nothing while a run is live, and backs off a session it cannot
       finish; a long stream takes more than one request; an undone row leaves, a forgotten session's rows leave;
     · a row the station cannot return (and cannot prove undone or forgotten) stays packed — the existing 'history-unavailable'
       note, a held send, the reference still in the next persist; a silent station changes nothing;
     · a read that was out when the Commander cleared the session (or deleted it, or cleared and undid) puts nothing back;
     · every clear path nulls the packed form; sourceIdsOf reads the rows first. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const A = require('./_assert.js');
const { readSidecarSource } = require('./helpers/source');
const { harnessApi, answer } = require('./helpers/harness-api');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js'), Dual = require('../sidecar/turn-dual.js');

const ROOTS = ['frontend/app', 'website/app/app'];
const clone = v => JSON.parse(JSON.stringify(v));
const deepEq = (a, b, msg) => { try { assert.deepStrictEqual(a, b); A.ok(true); } catch (e) { A.ok(false, msg + ' — ' + String(e.message).split('\n').slice(0, 6).join(' | ')); } };
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- the station: the real store over the real segmented io, the real routes ---------------------------------------------------
const SOURCE = readSidecarSource();
const ROUTES = ['async function handleTranscriptRows(req, res)', 'function serveTranscript(req, res)', 'function transcriptProjection(stream, rows, extra)',
  'async function handleTurnIdentityRetractions(req, res)'].map(h => { const body = A.fnBody(SOURCE, h); A.ok(body.length > 200 && body.length < 6000, 'the route slice is bounded: ' + h); return body; }).join('\n');

const STREAMS = ['open', 'tail', 'gone', 'undone', 'forgot', 'long', 'files', 'kinds', 'quoted'];
const MANY = Array.from({ length: 25 }, (_, i) => 'm' + String(i).padStart(2, '0'));   // 25 sessions: the idle pass reads 20, then 5
const LOST_ID = 9999999;                                                                  // a row the page sealed once and the station no longer returns

function station(dir) {
  let ts = 1700000000000;
  const open = () => History.makeSegmentedTranscriptIo({ fs, path, root: dir, segmentBytes: 700, schedule() {}, onWarning() {} });
  const put = (io, stream, role, content, extra) => io.appendDurable(Object.assign({ streamId: stream, agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: ++ts, content },
    role === 'assistant' ? { sourceRunId: 'run-' + stream + '-' + ts } : null, extra || null));
  const counts = { open: 6, tail: 4, gone: 5, undone: 4, forgot: 4, long: 60, files: 0, kinds: 0, quoted: 4 };   // (files and kinds are seeded by hand below: an attachment turn, the row kinds of turn identity)
  for (const m of MANY) counts[m] = 2 + (Number(m.slice(1)) % 3);
  const seed = open();
  for (let round = 0; round < 70; round++) {            // interleaved, as a station writes them
    for (const s of Object.keys(counts)) if (round < counts[s]) put(seed, s, round % 2 ? 'assistant' : 'user', (round % 2 ? 'reply ' : 'ask ') + s + ' ' + round + ' needle-' + s + '-' + round + ' ' + 'x'.repeat(40),
      s === 'quoted' && round === 1 ? { quotes: ['forgot'], quotesAt: [ts] } : null);   // a reply composed from the 'forgot' session, read before that session is deleted
  }
  // AN ATTACHMENT TURN (attachment-rows-and-taint): the directive keeps the file's references, the file is a role-system 'attachment' row of its own
  // (a name, a path, a size and a hash: provenance, no bytes) and the answer follows. The route hands the page the turns, never the attachment row.
  const file = { id: 'att-files1', name: 'notes.txt', path: '.attachments/att-files1.txt', mediaType: 'text/plain', kind: 'file' }, turnId = 'tr' + 'a'.repeat(23);
  put(seed, 'files', 'user', 'look at this file needle-files-0', { directive: true, turnId, attachments: [file] });
  put(seed, 'files', 'system', '[attached: notes.txt]', { kind: 'attachment', turnId, taint: 'user attachment', attachment: Object.assign({ size: 12, sha256: 'ab'.repeat(32) }, file) });
  put(seed, 'files', 'assistant', 'it is a notes file needle-files-1', { turnId, taint: 'user attachment' });
  /* THE ROW KINDS OF TURN IDENTITY (commit 10): a turn that made a file (kind deliverable, role system), took a steering note (kind steer, role
     system) and was followed by a routine's return (kind delivery, an assistant row of its own run). The route hands the page all of them as turns. */
  const kturn = 'tr' + 'b'.repeat(23), kret = 'run-kinds-ret';
  put(seed, 'kinds', 'user', 'make the files needle-kinds-0', { directive: true, turnId: kturn, sourceRunId: 'run-kinds' });
  put(seed, 'kinds', 'system', 'saved r.md', { kind: 'deliverable', turnId: kturn, sourceRunId: 'run-kinds', deliverable: { path: 'out/r.md', media: 'file', workspace: 'agent', root: '', name: 'r.md', artifactId: 'file_out_r.md' } });
  put(seed, 'kinds', 'system', 'make it shorter needle-kinds-1', { kind: 'steer', turnId: kturn, sourceRunId: 'run-kinds', noteId: 'sn-kinds' });
  put(seed, 'kinds', 'assistant', 'done needle-kinds-2', { turnId: kturn, sourceRunId: 'run-kinds' });
  put(seed, 'kinds', 'assistant', 'Property routine result needle-kinds-3', { kind: 'delivery', turnId: 'r' + kret, sourceRunId: kret });
  seed.close();
  // the page reads each stream the way it reconciles (the display view, through the route's projection) and keeps that copy as the SEAL
  const io1 = open(), live = new Set(), deleted = new Map();
  const store1 = Store.makeTranscriptStore({ io: io1, live, deletedAt: sid => deleted.get(sid) || 0 });
  const dual = Dual.make({ now: () => 1, hash: s => crypto.createHash('sha256').update(s).digest('hex') });
  const turnsOf = s => dual.project(s, store1.view('display', s, { limit: 5000 }), { isCollided: () => false }).turns;
  const sealed = new Map(Object.keys(counts).map(s => [s, turnsOf(s)]));
  // after the page packed: another window undoes the second turn of 'undone', and the Commander deletes 'forgot' (its rows are forgotten from then on)
  const undoneRow = sealed.get('undone')[1];
  put(io1, 'undone', 'system', '', { kind: 'retract', targets: [undoneRow.rowId], reason: 'undo' });
  const afterwards = ts + 1000;
  deleted.set('forgot', afterwards);
  io1.close();
  const io2 = open();
  const store = Store.makeTranscriptStore({ io: io2, live, deletedAt: sid => deleted.get(sid) || 0 });
  const sandbox = { transcriptStore: store, turnDual: dual, transcriptLiveRuns: live, transcriptIo: { isCollided: () => false },
    sessionTombstones: { deletedAt: sid => deleted.get(sid) || 0 }, readBody: async req => req.body, respondJson: (res, code, obj) => { res.code = code; res.body = obj; },
    refuseBadAgentId: () => false, readRouteFailure: (name, e) => ({ error: String(e && e.message || e) }), transcriptRunSince: () => 0, URL };
  vm.runInNewContext(ROUTES + '\nthis.routes = { handleTranscriptRows, serveTranscript, handleTurnIdentityRetractions };', sandbox, { filename: 'sidecar/index.js (transcript routes)' });
  return { sealed, undoneRow, routes: sandbox.routes, close: () => io2.close(), lastTs: () => ts };
}

// the transport: every request the page makes goes to the handler the sidecar would route it to
function transport(st) {
  const calls = [], t = { calls, gate: null, down: false, status: 0 };
  t.fetch = async (url, init) => {
    const u = new URL(url, 'http://station.test'), method = (init && init.method) || 'GET', res = { code: 0, body: null };
    const call = { method, path: u.pathname, search: u.search, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (t.down) throw new TypeError('Failed to fetch');
    if (t.gate && u.pathname === '/api/transcript/rows') await t.gate.promise;
    if (t.gateGet && method === 'GET' && u.pathname === '/api/transcript') await t.gateGet.promise;
    if (t.status && u.pathname === '/api/transcript/rows') return answer(t.status, { error: 'down' });
    if (method === 'GET' && u.pathname === '/api/transcript') st.routes.serveTranscript({ url: u.pathname + u.search }, res);
    else if (method === 'POST' && u.pathname === '/api/transcript/rows') await st.routes.handleTranscriptRows({ body: init.body }, res);
    else if (method === 'POST' && u.pathname === '/api/turn-identity/retractions') await st.routes.handleTurnIdentityRetractions({ body: init.body }, res);
    else { res.code = 404; res.body = { error: 'no route' }; }
    return answer(res.code, res.body);
  };
  t.rowsCalls = () => calls.filter(c => c.path === '/api/transcript/rows');
  return t;
}

// ---- the page's own rows, packed the way S5 will pack them ----------------------------------------------------------------------
const mintRng = rng(7);
function pageRows(env, stream) {
  const { HR, TM } = env.m, turns = env.st.sealed.get(stream);
  const rows = turns.map((t, k) => Object.assign({}, t, k % 3 === 1 ? { typedText: 'typed ' + stream + ' ' + k } : null, k === 2 ? { attachments: [{ id: 'att-' + k, name: 'p' + k + '.png' }] } : null, k === 3 ? { projectRoot: '/work/' + stream } : null));
  if (stream === 'tail') {
    rows.push(TM.pendingRow({ role: 'user', content: 'follow-up question', ts: env.st.lastTs() + 10 }, mintRng));
    rows.push({ role: 'system', sys: true, content: '— a note the page wrote —', ts: env.st.lastTs() + 11 });
  }
  if (stream === 'gone') rows.push({ streamId: 'gone', agentId: 'agent', role: 'assistant', kind: 'turn', taintKnown: true, ts: env.st.lastTs() + 12, content: 'a reply the station no longer holds', rowId: LOST_ID, sourceRunId: 'run-lost' });
  return rows;
}
function packedRecord(env, stream, at) {
  const { HR } = env.m, rows = pageRows(env, stream);
  const seals = new Map(env.st.sealed.get(stream).map(t => [HR.keyOf(stream, t.rowId), clone(t)]));
  if (stream === 'gone') seals.set(HR.keyOf(stream, LOST_ID), clone(rows[rows.length - 1]));
  const history = HR.pack(rows, { streamId: stream, seal: k => seals.get(k) || null });
  return { rows, record: { id: stream, title: 'session ' + stream, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: ['run-' + stream], createdAt: at, lastActiveAt: at, lastReadAt: at + 1 } };
}

async function makeEnv(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-hydrate-seam-'));
  const m = { W: require('../' + root + '/workstreams.js'), HR: require('../' + root + '/historyref.js'), TM: require('../' + root + '/turnmerge.js'), Fit: require('../' + root + '/historyfit.js') };
  const st = station(dir), tp = transport(st);
  const env = { root, m, st, tp, dir };
  const records = {}, originals = {};
  let at = 1800000000000;
  for (const s of STREAMS.concat(MANY)) { at += 1000; const p = packedRecord(env, s, at); records[s] = p.record; originals[s] = p.rows; }
  // a blank line (the control for the untouched test), and an ordinary inline session (the control for everything else)
  records.blank = { id: 'blank', title: null, agentId: 'agent', kind: 'chat', lane: 'todo', history: [], runIds: [], createdAt: 1, lastActiveAt: 1, lastReadAt: 1 };
  records.inline = { id: 'inline', title: null, agentId: 'agent', kind: 'chat', lane: 'active', history: [{ role: 'user', content: 'plain question', ts: 5 }, { role: 'assistant', content: 'plain answer', ts: 6 }], runIds: [], createdAt: 2, lastActiveAt: 2, lastReadAt: 2 };
  env.doc = clone({ workstreams: Object.keys(records).map(k => records[k]), activeId: 'inline', generalId: 'inline' });
  env.original = originals;
  env.close = () => { st.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return env;
}

// ---- the page: the real modules, chat.js's reconcile seam and app.js's idle pass lifted by name ---------------------------------
function page(env, opts) {
  const o = opts || {}, { W, HR, TM, Fit } = env.m, root = env.root;
  W.init(clone(env.doc));
  const busy = new Set(), persisted = [], renders = { n: 0 }, polls = [], notes = [], copied = [];
  const api = harnessApi(env.tp.fetch);
  const ctx = vm.createContext({ TurnMerge: TM, HistoryFit: Fit, HistoryRef: HR, stationModes: {}, stationCaps: {}, Workstreams: W, Harness: { api },
    fetch: env.tp.fetch, Channels: { isBusy: id => busy.has(id), anyBusy: () => busy.size > 0 }, App: { persist() { persisted.push(clone(W.serialize().workstreams)); } },
    setTimeout, clearTimeout, AbortController, Date, WeakMap, Map, Set, Promise, URL, JSON,
    renderHistory() { renders.n++; }, replayChannel() {}, syncStatus() {}, maybeEmptyState() {}, pinLoadedHistoryAfterLayout() {},
    localLine(line) { notes.push(line); }, copyText(text) { copied.push(text); return Promise.resolve(true); }, isBusy: () => false, load() {}, refreshWorkflowViews() {},
    log: { innerHTML: '' }, activeWs: null, historyPinSeq: 3, historyPinPending: 0, revealKey: '', stick: true });
  const chat = fs.readFileSync(root + '/chat.js', 'utf8');
  const merge = require('./helpers/turnmerge').source('mergeCanonicalHistory') + '\n' + A.fnBody(chat, 'function placeSteerNotes(rows)');
  const start = chat.indexOf('  const historyLoads = new WeakMap();'), seam = chat.slice(start, chat.indexOf('\n  // swap the rendered conversation', start));
  assert.ok(start > 0 && seam.length > 1000, root + ': the chat.js seam was found');
  // the commands that act on the open conversation, lifted by name with the seam (they wait for its rows: afterHydration)
  const commands = ['function afterHydration(ws, run)', 'function copyLastReply()', 'async function undoCommand()'].map(h => A.fnBody(chat, h)).join('\n');
  vm.runInContext(merge + '\n' + seam + '\n' + commands + '\nthis.api={loadServerHistory,ensureHistoryReady,hydrateHistory,continuityDiagnostics,copyLastReply,undoCommand};', ctx);
  // the registration chat.js makes at load (the store asks for a conversation's packed rows through the same reader)
  if (typeof W.setHydrator === 'function') W.setHydrator(ws => ctx.api.hydrateHistory(ws, { windowMs: 20000 }));
  // app.js: the rail receipt and the idle pass
  const app = fs.readFileSync(root + '/app.js', 'utf8');
  const receiptAt = app.indexOf('  const railExcerpts = new WeakMap();'), receiptEnd = app.indexOf('  function railModelFull(w)', receiptAt);
  const rail = vm.createContext({ Workstreams: W, GoalLoop: undefined, WeakMap });
  vm.runInContext(app.slice(receiptAt, receiptEnd) + '\nthis.railReceipt = railReceipt;', rail);
  const passAt = app.indexOf('  const HYDRATE_PER_TICK'), passEnd = app.indexOf('  let unsubscribeStationSave', passAt);
  const pass = vm.createContext({ Workstreams: W, Chat: { hydrateHistory: (ws, op) => ctx.api.hydrateHistory(ws, op) }, Channels: { anyBusy: () => busy.size > 0 }, renderRail() { renders.n++; },
    PollGate: { every(fn, op) { const loop = { fn, op, stopped: false, stop() { loop.stopped = true; } }; polls.push(loop); return loop; } }, Date, Map, Promise });
  if (passAt > 0 && passEnd > passAt) vm.runInContext(app.slice(passAt, passEnd) + '\nthis.arm = armHistoryHydration; this.tick = hydrateTick;', pass);
  const open = id => { const ws = W.get(id); ctx.activeWs = ws; return ws; };
  return { W, HR, api: ctx.api, ctx, busy, persisted, renders, polls, notes, copied, receipt: w => rail.railReceipt(w), arm: () => pass.arm && pass.arm(), tick: () => pass.tick && pass.tick(), hasPass: !!pass.arm, open,
    load: (id) => { const ws = open(id); return ctx.api.loadServerHistory(ws, 3); }, events: () => Array.from(ctx.api.continuityDiagnostics(), e => e.event) };
}

const proj = rows => rows.map(r => [r.role, r.content, r.rowId === undefined ? null : r.rowId]);
const names = ws => ws.history.map(r => r.content);
const has = (W, name) => typeof W[name] === 'function';

async function scenarios(root) {
  const env = await makeEnv(root);
  const run = async (name, fn) => { env.tp.calls.length = 0; env.tp.gate = null; env.tp.gateGet = null; env.tp.down = false; env.tp.status = 0; try { await fn(); A.ok(true, root + ': ' + name); } catch (e) { A.ok(false, root + ': ' + name + ' — ' + String(e && e.stack || e).split('\n').slice(0, 5).join(' | ')); } };
  try {
    // ================================================================================================================
    await run('BEFORE any row is read: the rail tells the truth (count, preview, blank test), nothing is asked of the station', async () => {
      const p = page(env), W = p.W;
      assert.ok(has(W, 'needsHydration') && has(W, 'turnCount') && has(W, 'pendingHydration'), 'Workstreams knows a session whose rows are packed');
      const open = W.get('open'), tail = W.get('tail');
      assert.equal(W.needsHydration(open), true, 'the open session is packed');
      assert.equal(W.needsHydration(W.get('inline')), false, 'an inline session is not');
      assert.equal(W.isUntouched(open), false, 'a session whose rows are packed is not a blank line');
      assert.equal(W.isUntouched(W.get('blank')), true, '(control) a really blank line still is');
      assert.equal(W.turnCount(open), env.original.open.length, 'the count names every packed row');
      assert.equal(W.turnCount(tail), env.original.tail.length, 'the count of a packed run with an inline tail: the run plus the tail');
      assert.equal(W.turnCount(W.get('inline')), 2, '(control) an inline session counts its rows');
      assert.equal(W.hasHistory(open), true); assert.equal(W.hasUserTurn(open), true);
      // the preview: never a stale line, never "No messages yet"
      assert.equal(W.latestVisibleMessage(open), null, 'a fully packed session names no newest message (it cannot know it)');
      assert.equal(p.receipt(open), '', 'and the rail prints no line rather than "No messages yet"');
      assert.equal(p.receipt(W.get('blank')), 'No messages yet', '(control) a blank line still says so');
      assert.equal(W.latestVisibleMessage(tail).content, 'follow-up question', 'an inline tail after the packed run IS provably the newest message');
      assert.equal(p.receipt(tail), 'You: follow-up question');
      assert.equal(W.latestVisibleMessage(W.get('inline')).content, 'plain answer', '(control) an inline session reads as it always did');
      // nothing inline can masquerade as the conversation
      assert.equal(open.history.length, 0, 'the rows the page holds are only the inline ones');
      assert.equal(tail.history.length, 2, 'the tail: the pending row and the note');
      assert.equal(W.exportConversation('open', 'json'), null, 'no export is made of half a conversation');
      assert.equal(W.titleBasis('open', 'a substantive first message'), null, 'and no title is made of half of it');
      const empties = W.previewArchive({ empty: true }).ids;
      assert.ok(empties.includes('blank') && !empties.includes('open') && !empties.includes('tail'), 'archive-empty never takes a session whose rows are packed (' + empties + ')');
      assert.equal(W.search('needle-open-1').length, 0, 'search sees only title and inline rows until the rows are read');
      assert.equal(W.search('follow-up').map(h => h.id).join(), 'tail');
      assert.equal(env.tp.calls.length, 0, 'booting asked the station for nothing');
      // newest first
      const order = W.pendingHydration();
      assert.equal(order[0], 'm24'); assert.equal(order[order.length - 1], 'open', 'the idle pass will read the most recently active first (' + order.slice(0, 3) + ' … ' + order.slice(-2) + ')');
      assert.equal(order.length, STREAMS.length + MANY.length);
    });

    // ================================================================================================================
    await run('an ATTACHMENT TURN reads back: the directive keeps its references, no attachment row reaches the page, the page-only fields lie over it', async () => {
      const p = page(env), W = p.W, ws = W.get('files');
      assert.equal(W.needsHydration(ws), true, 'the attachment turn is packed in the save');
      assert.deepEqual(env.st.sealed.get('files').map(r => [r.role, r.kind]), [['user', 'turn'], ['assistant', 'turn']], 'the station hands the page the turns of it, never the attachment row');
      const got = await p.api.hydrateHistory(ws, { windowMs: 8000 });
      assert.equal(got.complete, true, 'nothing is left packed');
      deepEq(ws.history, env.original.files, 'the session holds exactly the rows the page held when it saved');
      assert.deepEqual(ws.history[0].attachments.map(a => a.id), ['att-files1'], 'the directive row comes back with the file\'s references');
      assert.equal(ws.history[1].typedText, 'typed files 1', 'and the page-only field over the answer');
      assert.ok(!ws.history.some(r => r.kind === 'attachment' || r.attachment), 'no attachment row is among them');
      assert.equal(env.tp.rowsCalls().length, 1, 'one request read them');
      deepEq(W.serialize().workstreams.find(w => w.id === 'files').history, env.doc.workstreams.find(w => w.id === 'files').history, 'a persist now names the rows it has just read again');
    });

    // ================================================================================================================
    await run('the ROW KINDS of turn identity read back: a routine return is packed and comes back with its page-only fields; a file row and a steering note stay inline', async () => {
      const p = page(env), W = p.W, ws = W.get('kinds');
      assert.equal(W.needsHydration(ws), true, 'the session is packed in the save');
      assert.deepEqual(env.st.sealed.get('kinds').map(r => r.kind), ['turn', 'deliverable', 'steer', 'turn', 'delivery'], 'the station hands the page every kind the matrix displays, in order');
      const saved = env.doc.workstreams.find(w => w.id === 'kinds').history, packedIds = new Set(p.HR.idsOf(saved));
      const byKind = Object.fromEntries(env.original.kinds.map(r => [r.kind + ':' + r.role, r]));
      assert.ok(packedIds.has(byKind['delivery:assistant'].rowId), 'the routine return is named by a reference in the save');
      assert.ok(!packedIds.has(byKind['deliverable:system'].rowId) && !packedIds.has(byKind['steer:system'].rowId), 'the file row and the steering note are saved inline (system rows are never named by a reference)');
      assert.ok(saved.some(el => el && el.kind === 'steer' && el.noteId === 'sn-kinds') && saved.some(el => el && el.kind === 'deliverable' && el.deliverable && el.deliverable.path === 'out/r.md'), 'and they are the rows themselves, residue and all');
      const got = await p.api.hydrateHistory(ws, { windowMs: 8000 });
      assert.equal(got.complete, true, 'nothing is left packed');
      deepEq(ws.history, env.original.kinds, 'the session holds exactly the rows the page held when it saved: the return with its residue, the file row, the note');
      assert.equal(ws.history.find(r => r.kind === 'delivery').role, 'assistant', 'the return comes back as an assistant row');
      assert.equal(env.tp.rowsCalls().length, 1, 'one request read them');
      deepEq(W.serialize().workstreams.find(w => w.id === 'kinds').history, saved, 'a persist now names the rows it has just read again');
    });

    // ================================================================================================================
    await run('a persist before any row is read re-emits the packed runs verbatim; a row pushed since follows them; no second copy of the history is saved', async () => {
      const p = page(env), W = p.W;
      const saved = JSON.stringify(W.serialize());
      assert.ok(!/historyRef|historyDigest/.test(saved), 'the packed form is never written beside the history it is');
      const written = JSON.parse(saved).workstreams;
      assert.equal(written.length, env.doc.workstreams.length, 'every session is saved');
      deepEq(Object.fromEntries(written.map(w => [w.id, w.history])), Object.fromEntries(env.doc.workstreams.map(w => [w.id, w.history])),
        'a persist of a save nobody has read writes every history back as it was read: packed runs, inline rows, order (and nothing else of it)');
      W.get('open').history.push({ role: 'user', content: 'pushed after boot', ts: 1 });
      const after = W.serialize().workstreams.find(w => w.id === 'open').history;
      deepEq(after.slice(0, -1), env.doc.workstreams.find(w => w.id === 'open').history, 'the packed history first…');
      assert.equal(after[after.length - 1].content, 'pushed after boot', '…then the row pushed since');
      assert.equal(after.length, env.doc.workstreams.find(w => w.id === 'open').history.length + 1);
      // an inline row the page dropped stays dropped; the rest of the packed form is untouched
      const t = W.get('tail'); t.history.splice(t.history.findIndex(r => r.sys), 1);
      const tailSaved = W.serialize().workstreams.find(w => w.id === 'tail').history;
      assert.ok(!tailSaved.some(r => r.sys), 'a note the page removed is not saved back');
      assert.ok(tailSaved.some(r => r.$ref), 'the packed run still is');
      // a hydrated session hands out the live record, as before
      assert.equal(W.serialize().workstreams.includes(W.get('inline')), true, '(control) a session with all its rows is the live record');
    });

    // ================================================================================================================
    await run('the open session reads back to exactly its original rows: once, in place, page-only fields on them', async () => {
      const p = page(env), W = p.W, ws = W.get('open');
      const got = await p.api.hydrateHistory(ws, { windowMs: 8000 });
      assert.equal(got.complete, true, 'nothing is left packed');
      assert.equal(W.needsHydration(ws), false);
      deepEq(ws.history, env.original.open, 'the session holds exactly the rows the page held when it saved');
      assert.equal(env.tp.rowsCalls().length, 1, 'one request read them');
      const asked = env.tp.rowsCalls()[0].body;
      assert.deepEqual(Object.keys(asked.streams[0]).sort(), ['rowIds', 'streamId']); assert.equal(asked.streams[0].streamId, 'open');
      assert.equal(asked.streams[0].rowIds.length, env.original.open.length, 'it named the ids the save held, nothing else');
      deepEq(W.serialize().workstreams.find(w => w.id === 'open').history, env.doc.workstreams.find(w => w.id === 'open').history, 'a persist now names the rows it has just read again: the very references (and page-only fields) the save it came from held (step S5 packs what the page has proved)');
      assert.equal((await p.api.hydrateHistory(ws)).complete, true); assert.equal(env.tp.rowsCalls().length, 1, 'a second read of a whole history asks nothing');
    });

    // ================================================================================================================
    await run('a packed run with an inline tail comes back in the original order; a row pushed while the read was out follows it, once', async () => {
      const p = page(env), W = p.W, ws = W.get('tail');
      env.tp.gate = deferred();
      const reading = p.api.hydrateHistory(ws);
      await flush();
      ws.history.push({ role: 'user', content: 'typed while the rows were being read', ts: 99 });
      env.tp.gate.resolve(); env.tp.gate = null;
      assert.equal((await reading).complete, true);
      deepEq(ws.history.slice(0, -1), env.original.tail, 'the original rows, the inline tail and the note where they were');
      assert.equal(ws.history[ws.history.length - 1].content, 'typed while the rows were being read');
      assert.equal(ws.history.filter(r => r.content === 'typed while the rows were being read').length, 1, 'exactly once');
      assert.equal(ws.history.length, env.original.tail.length + 1);
    });

    // ================================================================================================================
    await run('opening a session (the production reconcile) reads it back, merges the station over it, repaints, and asks the retraction proof only about rows it did not just read', async () => {
      const p = page(env), W = p.W;
      const ok = await p.load('open');
      assert.equal(ok, true, 'the open-time read answered');
      assert.equal(W.needsHydration('open'), false);
      deepEq(proj(W.get('open').history), proj(env.original.open), 'the conversation after the merge: same turns, same ids, same order');
      assert.ok(p.events().includes('history-loaded') && !p.events().includes('history-unavailable'), 'the diagnostics say it loaded (' + p.events() + ')');
      assert.ok(p.renders.n >= 1 && p.persisted.length >= 1, 'it repainted the open conversation and persisted it');
      assert.equal(env.tp.calls.filter(c => c.path === '/api/turn-identity/retractions').length, 0, 'rows it has just read from the station are not asked about again');
      assert.equal(env.tp.calls.filter(c => c.path === '/api/transcript').length, 1, 'one GET merged the station\'s newest turns over them');
      // an inline session is read exactly as before: its cached rows ARE asked about (the existing proof)
      const q = page(env);
      await q.load('long'); // packed; hydrate first
      assert.equal(q.W.needsHydration('long'), false);
    });

    // ================================================================================================================
    await run('a long stream (more segments than one request reads) comes back whole, in order, over more than one request', async () => {
      const p = page(env), W = p.W, ws = W.get('long');
      const got = await p.api.hydrateHistory(ws, { windowMs: 20000 });
      assert.equal(got.complete, true, 'complete');
      deepEq(ws.history, env.original.long, 'all 60 rows, in order');
      assert.ok(env.tp.rowsCalls().length >= 2, 'the station answers a request from at most eight segments, so the rest was asked again (' + env.tp.rowsCalls().length + ' requests)');
      assert.ok(env.tp.rowsCalls().every(c => c.body.streams[0].rowIds.length <= 1000), 'no request names more ids than the route takes');
    });

    // ================================================================================================================
    await run('an undone row leaves the history, a forgotten session\'s rows leave it; neither is "unproven"', async () => {
      const p = page(env), W = p.W;
      const u = await p.api.hydrateHistory(W.get('undone'));
      assert.equal(u.complete, true, 'a proven undo is not a missing row');
      const kept = env.original.undone.filter(r => r.rowId !== env.st.undoneRow.rowId);
      deepEq(W.get('undone').history, kept, 'every row but the one another window undid, which is not brought back');
      const f = await p.api.hydrateHistory(W.get('forgot'));
      assert.equal(f.complete, true); assert.equal(W.get('forgot').history.length, 0, 'a forgotten session\'s rows are not brought back'); assert.equal(W.needsHydration('forgot'), false);
    });

    // ================================================================================================================
    await run('a row the QUOTE rule hides is answered forgotten by rows-by-id and dropped by hydration, with no unavailable note (the shared visibility projection)', async () => {
      const p = page(env), W = p.W, quoted = env.st.sealed.get('quoted')[1];
      assert.ok(quoted && quoted.rowId > 0, 'the sealed history holds the reply composed from the session deleted since');
      const ask = await env.tp.fetch('/api/transcript/rows', { method: 'POST', body: JSON.stringify({ streams: [{ streamId: 'quoted', rowIds: env.st.sealed.get('quoted').map(t => t.rowId) }] }) });
      const body = await ask.json(), answered = (body.streams && body.streams[0] && body.streams[0].forgotten) || [];
      assert.ok(answered.includes(quoted.rowId), 'rows-by-id names the quote-hidden row as forgotten, not missing (' + JSON.stringify(body).slice(0, 200) + ')');
      const out = await p.api.hydrateHistory(W.get('quoted'));
      assert.equal(out.complete, true, 'a forgotten row is proven gone, not unproven');
      deepEq(W.get('quoted').history.map(r => r.rowId), env.original.quoted.map(r => r.rowId).filter(id => id !== quoted.rowId), 'every row but the one the quote rule hides');
      assert.ok(!p.events().includes('history-unavailable'), 'no continuity note for a row that was forgotten (' + p.events() + ')');
      assert.equal(W.needsHydration('quoted'), false);
    });

    // ================================================================================================================
    await run('a row the station cannot return stays packed: the existing note, a held send, the reference in the next persist; the rows it can return come back', async () => {
      const p = page(env), W = p.W, ws = W.get('gone');
      const before = W.serialize().workstreams.find(w => w.id === 'gone').history;
      const ok = await p.load('gone');
      assert.equal(ok, false, 'the history is not restored');
      assert.ok(p.events().includes('history-unavailable'), 'the existing continuity note, no new one (' + p.events() + ')');
      assert.equal(W.needsHydration(ws), true, 'the lost row is still named');
      const packed = W.serialize().workstreams.find(w => w.id === 'gone').history;
      const refs = packed.filter(r => r.$ref);
      assert.equal(refs.length, 1, 'exactly the run that holds the unproven id stays packed');
      assert.deepEqual(p.HR.idsOf(packed), [LOST_ID], 'and it names only that id; the proven rows come back (' + JSON.stringify(refs) + ')');
      assert.ok(ws.history.length >= env.original.gone.length - 1, 'the rows the station returned are in the conversation');
      assert.ok(names(ws).includes(env.original.gone[0].content), 'including the first');
      deepEq(packed.filter(r => !r.$ref), env.original.gone.slice(0, -1), 'a persist writes the proven rows inline and the lost one as a reference');
      assert.ok(JSON.stringify(before).includes('"$ref"'), '(the save it came from held the run packed)');
      // the send is held exactly as for any history that cannot be read
      const ac = new AbortController();
      let refused = null;
      await p.api.ensureHistoryReady(ws, ac.signal).catch(e => { refused = e; });
      assert.ok(refused && refused.code === 'HISTORY_UNAVAILABLE', 'a send on it is refused with the existing words (' + (refused && refused.message) + ')');
      assert.match(refused.message, /history could not be restored/);
      assert.ok(p.events().includes('send-held-history-unavailable'));
      assert.equal(W.titleBasis('gone', 'anything substantive here'), null, 'and no title is made of it');
    });

    // ================================================================================================================
    await run('a station that does not answer changes nothing: the session stays as it was, packed, and a send asks again rather than refuse at once', async () => {
      const p = page(env), W = p.W, ws = W.get('open');
      env.tp.down = true;
      const ok = await p.load('open');
      assert.equal(ok, false); assert.equal(W.needsHydration(ws), true); assert.equal(ws.history.length, 0, 'nothing was invented');
      assert.ok(p.events().includes('history-unavailable'));
      deepEq(W.serialize().workstreams.find(w => w.id === 'open').history, env.doc.workstreams.find(w => w.id === 'open').history, 'and a persist still writes the packed run as it was');
      env.tp.down = false;
      assert.equal(await p.load('open'), true, 'it reads back when the station answers again');
      assert.equal(W.needsHydration(ws), false); deepEq(proj(ws.history), proj(env.original.open));
    });

    // ================================================================================================================
    await run('a refusal (4xx) and a server error (5xx) leave it packed with the existing note', async () => {
      for (const status of [403, 503]) {
        const p = page(env), W = p.W;
        env.tp.status = status;
        assert.equal(await p.load('open'), false, 'HTTP ' + status);
        assert.equal(W.needsHydration('open'), true); assert.ok(p.events().includes('history-unavailable'));
        env.tp.status = 0;
      }
    });

    // ================================================================================================================
    await run('the idle pass reads the unopened sessions newest first, twenty a tick, nothing while a run is live, and backs off a session it cannot finish', async () => {
      const p = page(env), W = p.W;
      assert.ok(p.hasPass, 'app.js has the idle hydration pass');
      assert.equal(p.arm(), true, 'it arms when sessions are packed');
      assert.equal(p.polls.length, 1);
      p.busy.add('inline');                                   // a run is live somewhere
      assert.equal(await p.tick(), false, 'no read while a run is live'); assert.equal(env.tp.rowsCalls().length, 0);
      p.busy.clear();
      assert.equal(await p.tick(), true);
      const readNow = STREAMS.concat(MANY).filter(id => !W.needsHydration(id));
      assert.deepEqual(readNow.slice().sort(), MANY.slice(-20).sort(), 'exactly twenty sessions were taken, the twenty most recently active (m05…m24)');
      assert.ok(W.needsHydration('m00') && W.needsHydration('m04') && STREAMS.every(id => W.needsHydration(id)), 'the older ones wait for the next tick');
      assert.ok(W.search('needle-m24-0').length === 1, 'search finds what the pass has read');
      assert.equal(p.polls[0].stopped, false);
      let ticks = 0; while (await p.tick() && ticks++ < 5);
      assert.ok(MANY.concat(['open', 'tail', 'undone', 'forgot', 'long']).every(id => !W.needsHydration(id)), 'every session the station can return is read');
      assert.deepEqual(W.pendingHydration(), ['gone'], 'only the one the station cannot finish is left');
      const asked = env.tp.rowsCalls().filter(c => c.body.streams[0].streamId === 'gone').length;
      await p.tick(); assert.equal(env.tp.rowsCalls().filter(c => c.body.streams[0].streamId === 'gone').length, asked, 'it is not asked again at once (a backoff), so it cannot starve the others');
      // a run that begins mid-tick ends the tick after the session in hand
      const q = page(env); q.arm();
      const before = env.tp.rowsCalls().length;
      const pass = q.tick(); q.busy.add('inline');
      await pass;
      assert.ok(env.tp.rowsCalls().length - before < 20, 'a run that began during the tick stopped it before the twentieth session (' + (env.tp.rowsCalls().length - before) + ' read)');
    });

    // ================================================================================================================
    await run('a slow tick is never joined by a second (PollGate abandons a beat past its deadline and starts the next)', async () => {
      const p = page(env); p.arm();
      env.tp.gate = deferred();
      const first = p.tick();
      await flush();
      const asked = env.tp.rowsCalls().length;
      assert.equal(asked, 1, 'the first tick has its first read out (held at the station)');
      assert.equal(await p.tick(), false, 'a second beat while one is out does nothing');
      assert.equal(env.tp.rowsCalls().length, asked, 'and asks the station for nothing');
      env.tp.gate.resolve(); env.tp.gate = null;
      assert.equal(await first, true, 'the first tick finishes its work');
      assert.equal(await p.tick(), true, 'and the pass goes on with the next');
    });

    // ================================================================================================================
    await run('the local cap trims only a history that is whole', async () => {
      const chat = fs.readFileSync(root + '/chat.js', 'utf8'), c = vm.createContext({ HISTORY_CAP: 3 });
      vm.runInContext(A.fnBody(chat, 'function capHistory(ws)') + '\nthis.cap = capHistory;', c);
      const rows = () => Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'row ' + i }));
      const whole = { history: rows() }, packed = { history: rows(), historyRef: [{ $ref: '1,1' }] };
      c.cap(whole); c.cap(packed);
      assert.equal(whole.history.length, 4, '(control) a whole history is cut to the cap and marked'); assert.ok(whole.history[0].truncated);
      assert.equal(packed.history.length, 6, 'a history with packed rows is not cut by a count of the few rows it holds'); assert.ok(!packed.history.some(r => r.truncated));
    });

    // ================================================================================================================
    await run('the shipped files wire the pieces the lifted seam relies on', async () => {
      const app = fs.readFileSync(root + '/app.js', 'utf8'), chat = fs.readFileSync(root + '/chat.js', 'utf8');
      assert.match(A.fnBody(app, 'function resumeInto('), /Workstreams\.init\([\s\S]*armHistoryHydration\(\)/, 'a resumed station arms the idle pass once its sessions are in');
      assert.match(chat, /Workstreams\.setHydrator\(ws => hydrateHistory\(ws, \{ windowMs: \d+ \}\)\)/, 'the store reads a purge\'s packed rows through chat.js\'s reader');
      assert.match(chat, /hydrateHistory,? contextRef|getHistory, hydrateHistory/, 'chat.js hands the reader out (the idle pass, the writers and the commands call it)');
    });

    // ================================================================================================================
    await run('a silent station pauses the whole pass', async () => {
      const p = page(env); p.arm();
      env.tp.down = true;
      assert.equal(await p.tick(), true);
      const asked = env.tp.rowsCalls().length;
      assert.equal(asked, 1, 'one session was tried, the station did not answer, the rest of the tick was not attempted (' + asked + ')');
      env.tp.down = false;
      assert.equal(await p.tick(), false, 'and the pass waits before it asks again');
    });

    // ================================================================================================================
    await run('a read that was out when the Commander cleared the session puts nothing back; cleared and undone, it is read again once, not doubled', async () => {
      const p = page(env), W = p.W, ws = W.get('open');
      env.tp.gate = deferred();
      const reading = p.api.hydrateHistory(ws);
      await flush();
      const cleared = W.clearConversation('open', { at: 5 });
      assert.ok(cleared && cleared.kind === 'clear', 'the clear took the packed history into its checkpoint');
      assert.equal(W.needsHydration(ws), false, 'clearing nulls the packed form');
      env.tp.gate.resolve(); env.tp.gate = null;
      const got = await reading;
      assert.equal(got.stale, true, 'the read is stale'); assert.equal(ws.history.length, 0, 'nothing is resurrected'); assert.equal(W.needsHydration(ws), false);
      assert.equal(W.serialize().workstreams.find(w => w.id === 'open').history.length, 0, 'and nothing is saved back');
      // undo puts the history back as it was cleared: packed, not duplicated
      assert.equal(W.undoLast(), true);
      assert.equal(W.needsHydration(ws), true, 'the undo restores the packed run');
      deepEq(W.serialize().workstreams.find(w => w.id === 'open').history, env.doc.workstreams.find(w => w.id === 'open').history, 'exactly the history that was cleared');
      assert.equal((await p.api.hydrateHistory(ws)).complete, true);
      deepEq(ws.history, env.original.open, 'and it reads back once, whole');
    });

    // ================================================================================================================
    await run('cleared AND undone while a read is out: that read is stale too (the undo put a new packed form back), nothing is doubled, and the next read is the one that counts', async () => {
      const p = page(env), W = p.W, ws = W.get('open');
      env.tp.gate = deferred();
      const reading = p.api.hydrateHistory(ws);
      await flush();
      W.clearConversation('open', { at: 5 }); W.undoLast();
      assert.equal(W.needsHydration(ws), true, 'the undo restored the packed history');
      env.tp.gate.resolve(); env.tp.gate = null;
      const got = await reading;
      assert.equal(got.stale, true, 'the read that started before the clear is discarded');
      assert.equal(ws.history.length, 0, 'it put nothing back'); assert.equal(W.needsHydration(ws), true);
      const again = await p.api.hydrateHistory(ws);
      assert.equal(again.complete, true);
      deepEq(ws.history, env.original.open, 'the next read puts the rows back once, whole');
    });

    // ================================================================================================================
    await run('an undo that puts a packed history back while the open-time read is out discards that read (the merge never lands on a session that is packed again)', async () => {
      const p = page(env), W = p.W, ws = W.get('tail');
      assert.ok(W.clearConversation('tail', { at: 5 }), 'the Commander clears a packed conversation: its packed form goes into the undo');
      assert.equal(W.needsHydration(ws), false); assert.equal(ws.history.length, 0);
      env.tp.gateGet = deferred();
      const loading = p.load('tail');
      await flush();
      assert.equal(W.undoLast(), true); assert.equal(W.needsHydration(ws), true, 'the undo put the packed history back while the read was out');
      const inline = ws.history.slice();
      env.tp.gateGet.resolve(); env.tp.gateGet = null;
      assert.equal(await loading, false, 'the late answer is not merged');
      assert.ok(p.events().includes('history-stale-discarded'), 'the existing note (' + p.events() + ')');
      assert.equal(W.needsHydration(ws), true); assert.deepEqual(ws.history, inline, 'the rows the session holds are exactly the ones the undo gave it: no station turn was merged beside the packed run');
      assert.equal(p.persisted.length, 0, 'and nothing was saved over it');
      assert.equal((await p.api.hydrateHistory(ws)).complete, true); deepEq(proj(ws.history.filter(r => r.rowId)), proj(env.original.tail.filter(r => r.rowId)), 'the next read puts the rows back once');
    });

    // ================================================================================================================
    await run('the open-time reconcile discards a read the Commander cleared meanwhile (the existing stale guard), and a deleted session is not resurrected', async () => {
      const p = page(env), W = p.W, ws = W.get('open');
      env.tp.gate = deferred();
      const loading = p.load('open');
      await flush();
      W.clearConversation('open', { at: 5 });
      env.tp.gate.resolve(); env.tp.gate = null;
      assert.equal(await loading, false);
      assert.ok(p.events().includes('history-stale-discarded'), 'discarded by the existing note (' + p.events() + ')');
      assert.equal(ws.history.length, 0); assert.equal(W.needsHydration(ws), false);
      const q = page(env), gone = q.W.get('tail');
      env.tp.gate = deferred();
      const reading = q.api.hydrateHistory(gone);
      await flush();
      q.W.del('tail');
      env.tp.gate.resolve(); env.tp.gate = null;
      assert.equal((await reading).stale, true); assert.equal(q.W.get('tail'), null, 'the deleted session stays deleted');
    });

    // ================================================================================================================
    await run('every clear path nulls the packed form; sourceIdsOf reads the rows first and names every run and row', async () => {
      const p = page(env), W = p.W;
      assert.ok(has(W, 'sourceIdsOf'), 'Workstreams.sourceIdsOf exists');
      const ids = await W.sourceIdsOf(W.get('open'));
      assert.equal(ids.complete, true, 'it read the rows');
      assert.equal(W.needsHydration('open'), false, 'it hydrated first');
      assert.ok(ids.runIds.includes('run-open') && env.original.open.filter(r => r.sourceRunId).every(r => ids.runIds.includes(r.sourceRunId)), 'every run the packed rows came from (' + ids.runIds.length + ')');
      deepEq(ids.rowIds, env.original.open.map(r => r.rowId).sort((a, b) => a - b), 'and every row id');
      env.tp.down = true;
      const q = page(env), partial = await q.W.sourceIdsOf('long');
      assert.equal(partial.complete, false, 'a session it could not read says so');
      assert.equal(partial.rowIds.length, env.original.long.length, 'and still names every row by id');
      env.tp.down = false;
      const r = page(env);
      r.W.clearConversation('tail', { at: 1 }); assert.ok(!r.W.get('tail').historyRef, 'clearConversation');
      r.W.reset(); assert.equal(r.W.all().some(w => w.historyRef), false, 'reset');
    });

    // ================================================================================================================
    await run('a command that reads or rewrites the open conversation waits for all of its rows, and says so when it cannot have them', async () => {
      const p = page(env), W = p.W, ws = p.open('open');
      const lastReply = env.original.open.filter(r => r.role === 'assistant').pop().content;
      p.api.copyLastReply();
      assert.equal(p.copied.length, 0, 'nothing is copied from the rows the page held before it read the rest');
      await flush();
      assert.deepEqual(p.copied, [lastReply], 'it copied the real last reply once the rows were back');
      assert.equal(W.needsHydration(ws), false);
      // /undo on a conversation the station cannot give back: refused in the existing words, no turn is picked from the rows held
      const q = page(env), blocked = q.open('gone');
      q.api.undoCommand(); await flush();
      assert.ok(q.notes.includes('Conversation history could not be restored.'), 'the existing words (' + q.notes + ')');
      assert.equal(env.tp.calls.filter(c => /retract$/.test(c.path)).length, 0, 'and no retraction was asked for');
      assert.equal(q.W.needsHydration(blocked), true);
      // the same call on a whole conversation does not wait
      const r = page(env); r.open('inline'); const before = env.tp.calls.length;
      r.api.copyLastReply(); await flush();
      assert.deepEqual(r.copied, ['plain answer'], 'an ordinary conversation copies at once'); assert.equal(env.tp.calls.length, before, 'asking the station for nothing');
    });

    // ================================================================================================================
    await run('a session read back is exported whole; the archive-empty test and a rail count follow the rows', async () => {
      const p = page(env), W = p.W;
      await p.api.hydrateHistory(W.get('open'));
      const bundle = W.exportConversation('open', 'json');
      assert.ok(bundle && bundle.doc.messages.length === env.original.open.length, 'the export holds every turn (' + (bundle && bundle.doc.messages.length) + ')');
      assert.ok(!W.previewArchive({ empty: true }).ids.includes('open'));
      assert.equal(W.search('needle-open-1').map(h => h.id).join(), 'open', 'search finds a turn that was packed');
      assert.equal(W.titleBasis('open', 'a new substantive message about the roadmap') !== null, true, 'a title may be made of the whole conversation again');
    });
  } finally { env.close(); }
}

(async () => {
  for (const root of ROOTS) await scenarios(root);
  A.report('history-hydrate.seam (a packed history boots truthfully, reads back every turn, never drops or guesses one; both shipped trees)');
})().catch(e => { console.error(e); process.exitCode = 1; });
