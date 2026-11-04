'use strict';
/* Actual station.read_session caller + real recall store + real readSessionTurns: empty is not missing. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { sidecarFunctionSource, functionSourceIn } = require('./helpers/source.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const overseer = require('../sidecar/overseer.js');
const store = makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => 10 }, deletedAt: id => id === 'forgotten' ? 20 : 0 });
const add = (streamId, content, extra) => store.appendStrict(Object.assign({ streamId, agentId: 'agent', sourceRunId: 'run-' + streamId,
  role: 'user', kind: 'turn', content, ts: 10, taint: null }, extra));
add('forgotten', 'FORGOTTEN_CACHE_SENTINEL');
add('internal', 'INTERNAL_CACHE_SENTINEL', { kind: 'station' });
const target = add('retracted', 'RETRACTED_CACHE_SENTINEL');
add('retracted', '', { role: 'system', kind: 'retract', targets: [target.rowId], reason: 'undo' });
add('visible', 'Visible canonical question');
const source = process.env.TURN_OVERSEER_RECALL_CONTROL
  ? functionSourceIn(fs.readFileSync(path.join(process.env.TURN_OVERSEER_RECALL_CONTROL, 'turn-identity-c6-index-pre-recall-fallback.js.txt'), 'utf8'), 'overseerStation')
  : sidecarFunctionSource('overseerStation');
const sandbox = { require: id => { if (id === './overseer.js') return overseer; throw new Error('Unexpected dependency ' + id); },
  transcriptStore: store, overseer: { resolve: id => ({ id, title: id, history: [{ role: 'user', content: id.toUpperCase() + '_CACHE_SENTINEL' }] }) },
  subagents: { list: () => [] }, stationBridge: { request: () => { throw new Error('Unexpected page fallback'); } } };
vm.createContext(sandbox); vm.runInContext(source, sandbox);
const station = sandbox.overseerStation('parent', 'parent-run');
(async () => {
  for (const id of ['forgotten', 'internal', 'retracted', 'empty']) {
    const reply = await station.request('station.read_session', { session: id });
    A.eq(reply.ok, true, id + ': a successfully empty projection is a successful read');
    A.eq(reply.result && reply.result.turns, [], id + ': saved history cannot resurrect absent canonical dialogue');
  }
  const visible = await station.request('station.read_session', { session: 'visible' });
  A.eq(visible.result && visible.result.turns, [{ speaker: 'user', text: 'Visible canonical question' }], 'visible canonical dialogue retains its speaker and text');
  sandbox.transcriptStore = { view() { throw new Error('TRANSCRIPT_UNVOUCHED'); } };
  const unvouched = await station.request('station.read_session', { session: 'unknown' });
  A.eq(unvouched, { ok: false, error: 'TRANSCRIPT_UNVOUCHED' }, 'unvouched projection is an error, never cached text or successful empty');
  sandbox.transcriptStore = { view() { return undefined; } };
  const missing = await station.request('station.read_session', { session: 'missing' });
  A.ok(missing.ok === false && /projection unavailable/.test(missing.error), 'missing projection is distinct from authoritative empty');
  A.eq(overseer.readSessionTurns([], [{ role: 'user', content: 'Explicit legacy helper input' }]),
    [{ speaker: 'user', text: 'Explicit legacy helper input' }], 'explicit helper legacy behavior remains separate from the canonical caller');
  A.report('overseer-recall');
})().catch(error => { console.error(error); process.exitCode = 1; });
