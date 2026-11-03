'use strict';
/* Exact saved-source controls for the independent C5 authority review. */
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { runTurnId } = require('../frontend/app/turnkinds.js');
const { make } = require('../sidecar/turn-dual.js');
const Store = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const control = process.env.TURNMERGE_REVIEW_CONTROL_DIR;
function load(actual, saved) {
  const filename = require.resolve(actual);
  if (!control) return require(filename);
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(path.join(control, saved), 'utf8'), filename); return m.exports;
}
const mergePath = require.resolve('../frontend/app/turnmerge.js');
const M = load('../frontend/app/turnmerge.js', 'turn-identity-c5-turnmerge-pre-review.js.txt');
const prior = require.cache[mergePath];
let makeRemoteHost;
try {
  if (control) require.cache[mergePath] = { id: mergePath, filename: mergePath, loaded: true, exports: M };
  makeRemoteHost = load('../sidecar/remote/host.js', 'turn-identity-c5-phone-host-pre-review.js.txt').makeRemoteHost;
} finally { if (prior) require.cache[mergePath] = prior; else delete require.cache[mergePath]; }
const baseIdentity = { v: 2, streamId: 's', fromRowId: 1, liveRunIds: [], collided: [], retracted: [8], forgottenAt: 10,
  forgotten: { keys: [['s', 6]], runIds: ['forgot-run'] } };
const history = [
  { role: 'user', content: 'DELETED_TIME', ts: 5 },
  { streamId: 's', rowId: 6, role: 'user', content: 'DELETED_KEY', ts: 50 },
  { role: 'assistant', content: 'DELETED_RUN', sourceRunId: 'forgot-run', ts: 50 },
  { streamId: 's', rowId: 8, role: 'user', content: 'RETRACTED', ts: 50 },
  { role: 'user', content: 'NEWER_LOCAL', ts: 99 },
  { streamId: 'other', rowId: 6, role: 'user', content: 'FOREIGN_LOCAL', ts: 1 }
];
const contents = rows => rows.map(r => r.content).sort();
function dual(mode) { return make({ now: () => 1, hash: s => crypto.createHash('sha256').update(s).digest('hex'), read: () => ({ merge: mode }) }); }
function hostFor(stream, local, identity, mode) {
  const io = makeMemoryTranscriptIo();
  for (const row of local) if (row && (!row.streamId || row.streamId === stream) && Number.isSafeInteger(row.rowId) && row.rowId > 0)
    io.appendDurable(Object.assign({}, row, { streamId: stream }));
  if (Array.isArray(identity.retracted) && identity.retracted.length)
    io.appendDurable({ streamId: stream, role: 'system', kind: 'retract', targets: identity.retracted, reason: 'undo' });
  const proofStore = Store.makeTranscriptStore({ io, clock: { now: () => 1 } });
  return makeRemoteHost({ now: () => 1, roster: () => [], liveRuns: () => [],
    deskSessions: () => [{ id: stream, agentId: 'agent', history: local }], transcript: { view: () => [], history: () => [], streams: () => [], cacheRetractions: proofStore.cacheRetractions },
    turnDual: dual(mode), turnProjection: () => ({ turns: [], identity }), redact: s => s });
}
(async () => {
  // A revived stream can have a valid new tail while an old page still caches pre-delete rows.
  for (const mode of ['legacy', 'shadow', 'id', 'fallback']) {
    const identity = Object.assign({}, baseIdentity, { modes: { merge: mode === 'fallback' ? 'id' : mode } }, mode === 'fallback' ? { collided: {} } : null);
    const notes = [];
    const out = await M.reconcile(history, { stream: 's', turns: [], identity }, { note: e => notes.push(e) });
    A.eq(contents(out.rows), ['FOREIGN_LOCAL', 'NEWER_LOCAL'], mode + ': page honors every affirmative forget/retract proof and preserves newer/foreign rows');
    A.eq((out.report.healed || []).filter(p => p.reason === 'forgotten' || p.reason === 'retracted').length, 4, mode + ': each affirmative removal has a proof');
    if (mode === 'fallback') A.ok(notes.some(n => n && n.event === 'merge-fallback'), 'malformed unrelated collision metadata exercises actual merge fallback');
    const phone = hostFor('s', history, identity, mode === 'fallback' ? 'id' : mode);
    A.eq(contents(await phone.thread({ streamId: 's', limit: 100 })), ['FOREIGN_LOCAL', 'NEWER_LOCAL'], mode + ': phone fallback/selected merge cannot resurrect cached deleted rows');
  }

  // Collision authority must stay disavowed after a save/reload and a narrower next station read.
  const annotations = [
    { role: 'assistant', error: true, content: 'ERROR_A' }, { role: 'assistant', error: true, content: 'ERROR_B' },
    { role: 'assistant', stopped: true, content: 'STOPPED' }, { role: 'system', sys: true, content: 'SYSTEM' },
    { role: 'assistant', steerEcho: true, content: 'STEER' }, { role: 'assistant', foreign: true, content: 'FOREIGN_KIND' }
  ].map((r, i) => Object.assign({ streamId: 's', rowId: 5, sourceRunId: 'annotation-' + i }, r));
  const collided = [{ streamId: 's', rowId: 5, role: 'user', content: 'COLLISION_A' }, { streamId: 's', rowId: 5, role: 'assistant', content: 'COLLISION_B' }];
  const identity = { v: 2, streamId: 's', collided: [], forgotten: {}, modes: { merge: 'id' } };
  const first = M.merge(annotations, collided, { identity }).rows;
  A.ok(annotations.every(a => first.some(r => r.content === a.content && r.idFrom === 'collision' && r.rowId === undefined)), 'every collided local annotation loses its strong key');
  const second = M.merge(JSON.parse(JSON.stringify(first)), [], { identity }).rows;
  A.ok(annotations.every(a => second.some(r => r.content === a.content)), 'narrower next read cannot H2-collapse distinct collided annotations');
  const errors = second.filter(r => r.error);
  A.ok(errors.length === 2 && !M.sameTurn(errors[0], errors[1]), 'save comparison cannot regain authority from a disavowed collision key');

  // /branch copies source-keyed history. Its first visible row is not a cursor in the destination stream.
  const branch = Array.from({ length: 8 }, (_, i) => ({ streamId: 'source', rowId: i + 1, role: i % 2 ? 'assistant' : 'user', content: 'branch ' + i, turnId: runTurnId('branch-turn-' + i), sourceRunId: 'branch-run-' + i, ts: i + 1 }));
  const branchHost = hostFor('branch', branch, { v: 2, streamId: 'branch', collided: [], forgotten: {}, modes: { merge: 'id' } }, 'id');
  const p1 = await branchHost.thread({ streamId: 'branch', limit: 3, page: true });
  A.eq(p1.beforeRowId, null, 'foreign first row selects offset fallback');
  const p2 = await branchHost.thread({ streamId: 'branch', limit: 3, page: true, before: p1.turns.length, beforeRowId: p1.beforeRowId });
  const p3 = await branchHost.thread({ streamId: 'branch', limit: 3, page: true, before: p1.turns.length + p2.turns.length, beforeRowId: p2.beforeRowId });
  A.eq(p3.turns.concat(p2.turns, p1.turns).map(r => r.rowId), [1, 2, 3, 4, 5, 6, 7, 8], 'foreign-key branch paging neither repeats nor loops');
  A.eq(p3.earlier, 0, 'branch paging reaches its actual beginning');
  A.report('turnmerge independent-review regressions');
})().catch(e => { console.error(e); process.exit(1); });
