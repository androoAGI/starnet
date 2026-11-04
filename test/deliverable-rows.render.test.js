'use strict';
/* node test/deliverable-rows.render.test.js — the readers of a canonical file row (turn identity, commit 10).

   The station writes one kind:'deliverable' row per file a run wrote (test/turn-delivery.files.test.js, test/deliverable-rows.e2e.test.js).
   Here the page and the phone read them back:
     1. the page's REAL renderHistory / replayFileRow / chip functions run in a vm over the real TurnMerge, TurnKinds and Workstreams: after
        a cache and save wipe (an empty ledger) every file row draws exactly one chip, with the exact path, the writing agent's workspace and
        the project root; a file the ledger already holds draws once (the ledger's copy, which takes the row's workspace, root and id);
        the live event and a re-filing never add a second record; a malformed row draws nothing;
     2. the project root reaches every chip's open path (wireFileOpen, fileBlobUrl, the folder and copy-path buttons);
     3. the REAL phone host's thread carries the file rows (role system, kind deliverable, a `deliverable` field, redacted prose) while the
        history a phone send hands the model never does;
     4. one adapter: chat.js, workstreams.js and host.js read a file row's address only through TurnMerge.deliverableOf / TurnKinds.
   RED at 4152883a1: a canonical file row draws nothing and is dropped from the thread. */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const A = require('./_assert.js');
const TurnKinds = require('../frontend/app/turnkinds.js');
const TurnMerge = require('../frontend/app/turnmerge.js');
const Workstreams = require('../frontend/app/workstreams.js');
const Store = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const Delivery = require('../sidecar/turn-delivery.js');
const { makeRemoteHost } = require('../sidecar/remote/host.js');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const chat = read('frontend/app/chat.js');

/* ---- 1 and 2: the page's real functions ---- */
const RUN = 'run-00000001', OTHER_RUN = 'run-00000002', PROJECT = 'C:\\Users\\me\\proj';
const fileRow = (rowId, p, media, extra) => Object.assign({ rowId, streamId: 'ws1', role: 'system', kind: 'deliverable', content: 'saved ' + p, sourceRunId: RUN, turnId: TurnKinds.runTurnId(RUN), ts: 100 + rowId,
  deliverable: { path: p, media, workspace: 'agent', root: '', name: p, artifactId: 'file_' + p.replace(/[^A-Za-z0-9_.-]/g, '_') } }, extra);
function boot(history, ledger) {
  const events = [];
  const made = Workstreams.create({ agentId: 'agent', title: 'files' });
  const ws = Workstreams.get(made.id);
  ws.history = history;
  for (const record of ledger || []) Workstreams.recordDeliverable(ws.id, record);
  const names = ['function mediaKindOf(title)', 'function replayableDeliverables(ws)', 'function replayDeliverableRow(d, agentId)', 'function replayFileRow(ws, row, agentId, teachOnly)', 'function renderHistory(onlyTurns)'];
  const code = names.map(header => A.fnBody(chat, header)).join('\n');
  const c = vm.createContext({ TurnKinds, TurnMerge, Workstreams, activeWs: ws, renderingHistory: false,
    deliverableLine: (title, owner, root) => events.push(['file', title, owner, root]),
    imageDeliverableLine: (title, owner, root) => events.push(['image', title, owner, root]),
    mediaPlayerLine: (title, owner, kind, root) => events.push([kind, title, owner, root]),
    addUser: text => events.push(['user', text]), toolLine() {}, trimMarkerLine() {}, goalStepOf: () => null, goalStepLine() {},
    row: () => ({ d: { classList: { add() {} } }, body: {} }), turnFileRefs: agent => ({ agent }),
    renderProse: (_body, text) => events.push(['reply', text]), isBusy: () => false, offerTryAgain() {}, offerRetry() {} });
  vm.runInContext(code, c);
  return { c, ws, events };
}
{
  const rows = [{ role: 'user', content: 'make the files', ts: 50, rowId: 1, streamId: 'ws1', sourceRunId: RUN },
    fileRow(2, 'report \u00b7 v2.md', 'file'), fileRow(3, 'a \u00b7 b.png', 'image'), fileRow(4, 'clip.mp3', 'audio'), fileRow(5, 'clip.mp4', 'video'),
    { role: 'assistant', content: 'Wrote the files.', ts: 120, rowId: 6, streamId: 'ws1', sourceRunId: RUN }];
  const { c, ws, events } = boot(rows, []);
  c.renderHistory();
  A.eq(events, [['user', 'make the files'], ['file', 'report \u00b7 v2.md', 'agent', ''], ['image', 'a \u00b7 b.png', 'agent', ''], ['audio', 'clip.mp3', 'agent', ''], ['video', 'clip.mp4', 'agent', ''], ['reply', 'Wrote the files.']],
    'after a cache and save wipe (an empty ledger) each file row draws exactly one chip, in place, with the exact path and its media');
  A.eq(ws.deliverables, [], 'drawing a canonical row files nothing in the ledger (an undone row must stay gone)');
  events.length = 0; c.renderHistory();
  A.eq(events.filter(e => e[0] !== 'user' && e[0] !== 'reply').length, 4, 'a second render draws the same four chips, not more');
  events.length = 0; c.renderHistory(rows.slice(1, 3));
  A.eq(events, [['file', 'report \u00b7 v2.md', 'agent', ''], ['image', 'a \u00b7 b.png', 'agent', '']], 'an incremental render draws just the rows it was given');
}
{
  // a worker's file and a project file: the chip's owner is the row's workspace, its root the row's root
  const rows = [fileRow(2, 'worker-note.md', 'file', { deliverable: { path: 'worker-note.md', media: 'file', workspace: 'vex', root: '', name: 'worker-note.md', artifactId: 'file_worker-note.md' } }),
    fileRow(3, 'src/a.md', 'file', { deliverable: { path: 'src/a.md', media: 'file', workspace: 'agent', root: PROJECT, name: 'a.md', artifactId: 'file_src_a.md' } }),
    fileRow(4, 'src/pic.png', 'image', { deliverable: { path: 'src/pic.png', media: 'image', workspace: 'agent', root: PROJECT, name: 'pic.png', artifactId: 'file_src_pic.png' } }),
    fileRow(5, 'src/clip.mp4', 'video', { deliverable: { path: 'src/clip.mp4', media: 'video', workspace: 'agent', root: PROJECT, name: 'clip.mp4', artifactId: 'file_src_clip.mp4' } })];
  const { c, events } = boot(rows, []);
  c.renderHistory();
  A.eq(events, [['file', 'worker-note.md', 'vex', ''], ['file', 'src/a.md', 'agent', PROJECT], ['image', 'src/pic.png', 'agent', PROJECT], ['video', 'src/clip.mp4', 'agent', PROJECT]],
    'a worker\'s file draws in the worker\'s workspace and a project file with its project root (also for images and players)');
}
{
  // the ledger already holds the live chip: one chip, drawn from the ledger, taught the row's workspace, root and id
  const rows = [fileRow(2, 'src/a.md', 'file', { deliverable: { path: 'src/a.md', media: 'file', workspace: 'vex', root: PROJECT, name: 'a.md', artifactId: 'file_src_a.md' } }), fileRow(3, 'other.md', 'file'),
    { role: 'assistant', content: 'Done.', ts: 500, rowId: 4, streamId: 'ws1', sourceRunId: RUN }];
  const { c, ws, events } = boot(rows, [{ title: 'src/a.md', kind: 'file', runId: RUN, t: 90 }]);
  c.renderHistory();
  A.eq(events, [['file', 'other.md', 'agent', ''], ['file', 'src/a.md', 'vex', PROJECT], ['reply', 'Done.']],
    'a file the ledger holds draws once, from the ledger, in the writing agent\'s workspace and the project root the row taught it');
  A.eq(ws.deliverables, [{ title: 'src/a.md', kind: 'file', runId: RUN, t: 90, agentId: 'vex', root: PROJECT, rowId: 2 }], 'the ledger record took the row\'s agent, root and id, and nothing else changed');
  A.eq(Workstreams.recordDeliverable(ws.id, { title: 'src/a.md', kind: 'file', runId: RUN, t: 91 }), false, 'a re-filing of the same run and path is not a second record');
  A.eq(Workstreams.recordDeliverable(ws.id, { title: 'src/a.md', kind: 'file', runId: OTHER_RUN, t: 92 }), true, 'the same path in another run is another file');
  A.eq(Workstreams.recordDeliverable(ws.id, { title: 'x.md', kind: 'file', runId: null, t: 93 }) && Workstreams.recordDeliverable(ws.id, { title: 'x.md', kind: 'file', runId: null, t: 94 }), true, 'a record with no run keeps its old behaviour (nothing to match on)');
  A.eq(Workstreams.recordDeliverable(ws.id, { title: PROJECT + '\\src\\a.md', kind: 'file', runId: RUN, t: 95 }), false, 'an absolute live title is the same file as its converted row (root + path)');
}
{
  // a malformed row, a row of another kind and a row with no field draw nothing and never throw
  const bad = [fileRow(2, '../escape.md', 'file'), fileRow(3, 'ok.md', 'file', { deliverable: null }), { role: 'system', kind: 'retract', content: '', rowId: 4, targets: [2] }, { role: 'system', kind: 'deliverable', content: 'saved nothing', rowId: 5 }];   // (a steer row is drawn since commit 10b: test/steer-rows.test.js)
  const { c, events } = boot(bad, []);
  c.renderHistory();
  A.eq(events, [], 'nothing is drawn for a row that is not a well-formed file row (and nothing is repaired)');
}
{
  // source locks: one adapter, and the chips carry the root all the way to the open path
  A.ok(!/\.deliverable\.(path|media|workspace|root)\b/.test(chat), 'chat.js never reads a file row\'s address directly: only TurnMerge.deliverableOf does');
  A.ok(/Workstreams\.knownDeliverable\(ws\.id, d\)/.test(A.fnBody(chat, 'function replayFileRow(ws, row, agentId, teachOnly)')), 'the page asks the ledger before it draws a canonical row');
  const wk = read('frontend/app/workstreams.js');
  A.ok(!/\.deliverable\b/.test(A.fnBody(wk, 'function recordDeliverable(id, d)') + A.fnBody(wk, 'function knownDeliverable(id, d)')), 'workstreams.js files adapted records and never reads a station row');
  const host = read('sidecar/remote/host.js');
  A.ok(/TurnMerge\.deliverableOf\(m\)/.test(host) && !/m\.deliverable\.path|r\.deliverable\.path/.test(host), 'the phone host admits a file row only through the adapter');
  const lines = ['function inRoot(projectRoot, p)', 'function deliverableLine(title, agentId, projectRoot)', 'function imageDeliverableLine(title, agentId, projectRoot)', 'function mediaPlayerLine(title, agentId, kind, projectRoot)', 'function openFallback(parent, label, title, agentId, projectRoot)', 'function wireLightbox(a, rel, aid, name, projectRoot)', 'function fileBlobUrl(title, agentId, projectRoot)']
    .map(header => A.fnBody(chat, header)).join('\n');
  const calls = [];
  const el = () => ({ classList: { add() {} }, appendChild(n) { return n; }, addEventListener() {}, setAttribute() {}, querySelector() { return null; }, style: {} });
  const c = vm.createContext({ calls, noteDeliveryLanding() {}, autoscroll() {}, tauriCore: () => ({}), String, URL, Promise,
    row: () => { const r = { d: el(), body: el() }; return r; },
    document: { createElement: () => Object.assign(el(), { appendChild(n) { return n; } }), createTextNode: () => ({}) },
    wireFileOpen: (a, title, agent, root) => calls.push(['open', title, agent, root]), folderButton: (agent, p) => { calls.push(['folder', agent, p]); return el(); }, copyPathButton: (agent, p) => { calls.push(['copy', agent, p]); return el(); },
    fileUrl: (title, agent, root) => { calls.push(['url', title, agent, root]); return '/api/file'; }, fetch: () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) }),
    openLightbox: open => { open(); }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, glyphSpan: () => el(), SVG_FOLDER: '' });
  vm.runInContext(lines, c);
  c.deliverableLine('src/a.md', 'agent', PROJECT);
  A.eq(calls.filter(x => x[0] !== 'url'), [['open', 'src/a.md', 'agent', PROJECT], ['folder', 'agent', PROJECT + '/src/a.md'], ['copy', 'agent', PROJECT + '/src/a.md']], 'a project file\'s chip opens it under the root, and its folder and copy-path keys carry the full address');
  calls.length = 0; c.deliverableLine('plain.md', 'agent');
  A.eq(calls.filter(x => x[0] !== 'url'), [['open', 'plain.md', 'agent', undefined], ['folder', 'agent', 'plain.md'], ['copy', 'agent', 'plain.md']], 'with no root nothing changes');
  calls.length = 0; c.deliverableLine('C:\\abs\\x.md', 'agent', PROJECT);
  A.eq(calls.filter(x => x[0] === 'folder').map(x => x[2]), ['C:\\abs\\x.md'], 'an absolute path is never re-rooted');
}

/* ---- 3: the phone's thread ---- */
(async () => {
  const io = makeMemoryTranscriptIo(), store = Store.makeTranscriptStore({ io, clock: { now: () => 1000 } }), STREAM = 'phone_files', runId = 'run-00000009';
  const user = store.appendStrict({ streamId: STREAM, agentId: 'forge', role: 'user', content: 'make the files', sourceRunId: runId, turnId: TurnKinds.runTurnId(runId), directive: true });
  const files = Delivery.fileRows(store, { streamId: STREAM, agentId: 'forge', runId, root: '', artifacts: [{ kind: 'file', path: 'report \u00b7 v2.md' }, { kind: 'image', path: 'a \u00b7 b.png' }] });
  const reply = store.appendStrict({ streamId: STREAM, agentId: 'forge', role: 'assistant', content: 'Wrote the files.', sourceRunId: runId, turnId: TurnKinds.runTurnId(runId) });
  let ran = null;
  const dual = { pick: (_surface, _legacy, current) => current(), record() {} };
  const host = makeRemoteHost({ now: () => 2000, newId: () => 'followup', broadcast: () => {}, roster: () => [{ agentId: 'forge' }], liveRuns: () => [], credentials: () => ({ ok: true }),
    classify: () => true, runOnce: async options => { ran = options; }, transcript: store, deskSessions: () => [], turnDual: dual,
    turnProjection: (stream, rows) => ({ turns: rows, identity: { v: 2, streamId: stream } }), redact: text => String(text).replace(/report/g, '[r]') });
  const thread = await host.thread({ streamId: STREAM, limit: 60 });
  A.eq(thread.map(r => [r.rowId, r.role, r.kind, r.content]), [[user.rowId, 'user', undefined, 'make the files'], [files.rows[0].rowId, 'system', 'deliverable', 'saved [r] · v2.md'], [files.rows[1].rowId, 'system', 'deliverable', 'made a · b.png'], [reply.rowId, 'assistant', undefined, 'Wrote the files.']],
    'the phone thread carries the file rows in order, between the directive and the reply, as system rows (prose redacted)');
  A.eq(thread.filter(r => r.kind === 'deliverable').map(r => r.deliverable), [
    { path: 'report \u00b7 v2.md', media: 'file', workspace: 'forge', root: '', name: 'report \u00b7 v2.md', artifactId: 'file_report___v2.md' },
    { path: 'a \u00b7 b.png', media: 'image', workspace: 'forge', root: '', name: 'a \u00b7 b.png', artifactId: 'img_a___b.png' }], 'each carries its `deliverable` field: exact path, media, workspace and root');
  A.ok(thread.every(r => r.kind === 'deliverable' ? r.deliverable && !('typed' in r) : !('deliverable' in r)), 'and only a file row has one');
  await host.send({ streamId: STREAM, agentId: 'forge', text: 'and now?' });
  for (let i = 0; i < 5 && !ran; i++) await new Promise(resolve => setImmediate(resolve));
  A.eq(ran && ran.messages.map(m => m.content), ['make the files', 'Wrote the files.', 'and now?'], 'the history a phone send hands the model holds the directive and the reply, never a file row');
  A.report('deliverable-rows.render');
})().catch(error => { A.ok(false, (error && error.stack) || String(error)); A.report('deliverable-rows.render'); });
