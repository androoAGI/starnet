'use strict';
const A = require('./_assert.js');
const Store = require('../sidecar/transcriptstore.js');
const View = require('../sidecar/turn-view.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const Learning = require('../sidecar/trusted-learning.js');
const Earlier = require('../sidecar/earlier-conversation.js');
const Dual = require('../sidecar/turn-dual.js');
const hash = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
const owner = { runId: 'owner', streamId: 's', agentId: 'agent', ownerDirective: true, internal: false };
const io = makeMemoryTranscriptIo();
const dual = Dual.make({ now: () => 10, hash, save() {} });
const live = new Set();
const store = Store.makeTranscriptStore({ io, clock: { now: () => 10 }, runOf: id => id === 'owner' ? owner : null,
  quotedMaterial: Learning.quotedMaterial, live, pick: dual.pick, hash, deletedAt: sid => sid === 'gone' ? 20 : 0 });
const add = extra => store.appendStrict(Object.assign({ streamId: 's', agentId: 'agent', sourceRunId: 'owner', role: 'user', content: 'question', kind: 'turn', taintKnown: true, ts: 10 }, extra));
const first = add({ content: 'same repeated question', typed: 'typed original' });
add({ role: 'assistant', content: 'answer' });
add({ kind: 'station', content: 'INTERNAL_SENTINEL' });
add({ kind: 'capture', content: 'CAPTURE_SENTINEL' });
add({ kind: 'hop', content: 'HOP_SENTINEL', line: 'line@dock' });
const last = add({ content: 'same repeated question' });
A.eq(store.view('model-replay', 's', { shape: 'pairs' }).length, 3, 'ordinary replay excludes station, capture and another line');
A.eq(store.view('model-replay', 's', { shape: 'prose', form: 'pre' })[0].content, 'typed original', 'pre replay uses original typed bytes');
A.eq(store.view('model-replay', 's', { shape: 'pairs', line: 'line@dock' }).length, 4, 'the hop is visible inside its own line');
A.eq(store.view('display', 's').length, 4, 'display preserves the agent-labelled hop but hides station and capture');
let error = null; try { store.view('model-replay', 's', {}); } catch (e) { error = e; }
A.ok(error && /shape/.test(error.message), 'public replay has no implicit shape');
const replay = store.view('model-replay', 's', { shape: 'pairs' });
A.eq(replay[View.ROW_IDS][0].rowId, first.rowId, 'message map names its actual source row');
A.ok(!JSON.stringify(replay).includes('rowId'), 'provider message bytes contain no internal identity');
const keyed = View.slice(replay, -1);
A.eq(Earlier.windowCut(store.view('model-replay', 's', { shape: 'pairs', rows: true }), keyed), 2, 'a repeated question cuts at the keyed occurrence');
const unknown = [{ role: 'user', content: 'same repeated question' }];
Object.defineProperty(unknown, View.ROW_IDS, { value: [{ streamId: 's', rowId: 9999 }] });
A.eq(Earlier.windowCut([first, last], unknown), -1, 'missing authoritative key never falls back to matching text');
const mixed = View.concat([{ role: 'assistant', content: 'unkeyed leading reply' }], keyed);
A.eq(Earlier.windowCut([first, last], mixed), -1, 'a later key cannot place an unkeyed leading conversational row');
A.eq(Earlier.windowCut([first, last], [{ role: 'user', content: last.content }]), 1, 'id-less legacy window retains its content fallback');
dual.setMode('replay', 'legacy');
A.eq(JSON.stringify(store.view('model-replay', 's', { shape: 'pairs', form: 'pre' })), JSON.stringify(store.reconstruct('s')), 'legacy replay preserves old reconstruct bytes, including old typed behavior');
add({ kind: 'retract', role: 'system', targets: [last.rowId], reason: 'undo', content: '' });
A.ok(!store.view('model-replay', 's', { shape: 'pairs' })[View.ROW_IDS].some(id => id.rowId === last.rowId), 'legacy replay still honors a later retract');
dual.setMode('replay', 'id');
A.ok(!store.view('model-replay', 's', { shape: 'pairs', limit: 1 })[View.ROW_IDS].some(id => id.rowId === last.rowId), 'ID replay honors a retract outside the selected dialogue tail');
add({ streamId: 'gone', content: 'FORGOTTEN_SENTINEL' });
for (const mode of ['legacy', 'id']) {
  dual.setMode('display', mode); dual.setMode('replay', mode);
  A.eq(store.view('display', 'gone').length, 0, 'display forget survives mode ' + mode);
  A.eq(store.view('model-replay', 'gone', { shape: 'pairs' }).length, 0, 'replay forget survives mode ' + mode);
}
A.eq(store.view('proof', 'gone').length, 1, 'proof retains durable forgotten rows');
live.add('owner');
A.eq(store.view('display', 's').length, 0, 'live run stays hidden by default');
A.eq(store.view('owner-evidence', 's').length, 0, 'live run cannot become owner evidence');
live.clear();
A.ok(store.view('recall', 's', { op: 'search', query: 'repeated' }).every(row => row.rowId > 0), 'RAM search retains durable IDs for projection');
A.ok(!store.view('recall', 's', { op: 'search', query: 'SENTINEL' }).some(row => /INTERNAL|CAPTURE/.test(row.content)), 'recall hides non-dialogue classes');
const summaries = store.view('recall', 's', { op: 'streams', limit: 20 });
A.ok(summaries.every(row => row.streamId !== 'gone'), 'browse summaries cannot resurface forgotten streams');
A.eq(store.view('model-replay', 's', { complete: true, shape: 'pairs' }).length, 2, 'whole-stream memory proof permits complete projection');
let diskReads = 0;
const raw = [{ rowId: 1, streamId: 'disk', role: 'user', content: 'disk first' }, { rowId: 2, streamId: 'disk', role: 'assistant', content: 'disk last' }];
const diskStore = Store.makeTranscriptStore({ io: { readAll: () => raw.slice(-1), append() {}, streamRows: () => 2,
  history(sid, o) { diskReads++; A.eq(o.strict, true, 'complete read requests strict disk bytes'); return raw; } } });
A.eq(diskStore.view('model-replay', 'disk', { shape: 'pairs', complete: true }).length, 2, 'incomplete RAM mirror reads full durable history');
A.eq(diskReads, 1, 'complete disk read happens once');
for (const [name, io] of [
  ['unknown count', { readAll: () => raw, append() {}, streamRows: () => -1 }],
  ['disk throws', { readAll: () => raw.slice(-1), append() {}, streamRows: () => 2, history() { throw new Error('disk unavailable'); } }],
  ['disk short', { readAll: () => [], append() {}, streamRows: () => 2, history: () => raw.slice(-1) }]
]) {
  let failed; try { Store.makeTranscriptStore({ io }).view('display', 'disk', { complete: true }); } catch (e) { failed = e; }
  A.eq(failed && failed.code, 'TRANSCRIPT_UNVOUCHED', name + ' cannot silently become a complete RAM view');
}
const empty = Store.makeTranscriptStore({ io: { readAll: () => [], append() {}, streamRows: () => 0 } });
A.eq(empty.view('display', 'empty', { complete: true }).length, 0, 'durable zero proves an empty complete stream');
const idless = Store.makeTranscriptStore({ io: { readAll: () => [{ streamId: 's', role: 'user', content: 'uncommitted' }], append() {} } });
A.eq(idless.view('proof', 's').length, 0, 'an id-less RAM row is not durable proof');
A.eq(idless.view('display', 's').length, 0, 'an id-less RAM row cannot be displayed as canonical history');
{
  const batchIo = makeMemoryTranscriptIo(), readContext = batchIo.retractionsFor.bind(batchIo);
  let contexts = 0;
  batchIo.retractionsFor = ids => { contexts++; return readContext(ids); };
  const batchStore = Store.makeTranscriptStore({ io: batchIo });
  const a = batchStore.appendStrict({ streamId: 'a', role: 'user', content: 'a question', taint: null });
  batchStore.appendStrict({ streamId: 'b', role: 'assistant', content: 'b reply', taint: null });
  const options = { limit: 6, shape: 'pairs' };
  const first = batchStore.viewMany('model-replay', ['a', 'b', 'a'], options);
  A.eq(contexts, 1, 'one batch obtains one fresh retract context across distinct streams');
  A.eq([...first.keys()], ['a', 'b'], 'duplicate stream requests share the same bounded projection');
  A.eq(first.get('a').map(row => row.content), ['a question'], 'batch retains the first stream dialogue');
  A.eq(first.get('b').map(row => row.content), ['b reply'], 'batch retains the second stream dialogue');
  batchStore.appendStrict({ streamId: 'b', role: 'system', kind: 'retract', targets: [a.rowId], reason: 'undo' });
  const second = batchStore.viewMany('model-replay', ['a', 'b'], options);
  A.eq(contexts, 2, 'a new assembly revalidates authority without a global cache');
  A.eq(second.get('a'), [], 'the next assembly sees a newly appended cross-stream retract');
  A.eq(first.get('a').length, 1, 'an earlier returned assembly remains its own immutable snapshot');
  A.throws(() => batchStore.viewMany('model-replay', Array(501).fill('a'), options), 'batch rejects more than 500 requested streams');
  A.throws(() => batchStore.viewMany('model-replay', ['a'], { limit: 6 }), 'batch requires a literal replay shape');
  A.throws(() => batchStore.viewMany('model-replay', ['a'], { shape: 'pairs', limit: 401 }), 'batch row assembly has an explicit bound');
  A.throws(() => batchStore.viewMany('model-replay', ['a'], { ...options, complete: true }), 'batch cannot request unbounded complete history');
  batchIo.retractionsFor = () => ({ proofComplete: false, retractions: new Map() });
  let error; try { batchStore.viewMany('model-replay', ['a', 'b'], options); } catch (e) { error = e; }
  A.eq(error && error.code, 'TRANSCRIPT_UNVOUCHED', 'an unknown shared context refuses the whole assembly instead of fabricating empty history');
}
A.report('transcript-view');
