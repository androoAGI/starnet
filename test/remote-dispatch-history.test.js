'use strict';
// Exact run authority reconciles old desktop saves before phone reads and continuation context.
const A = require('./_assert.js');
const fs = require('fs');
const vm = require('vm');
const { makeRemoteHost } = require('../sidecar/remote/host.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const source = fs.readFileSync(require.resolve('../sidecar/remote/host.js'), 'utf8');
const body = require('./helpers/turnmerge').source('mergeCanonical');
A.ok(body.length > 1000 && body.length < 10000, 'read only the production merge function for metadata assertions');
const merge = vm.runInNewContext('(' + body + ')');
const final = { role: 'assistant', content: '{"answer":"accepted"}', sourceRunId: 'original', streamId: 's', agentId: 'forge',
  dispatchState: 'final', dispatchReason: 'done', textLength: 21, textSha256: 'canonical-digest', rowId: 12, ts: 101, taint: 'accepted-source' };
const question = { role: 'user', content: 'Visible request', sourceRunId: 'original', ts: 99 };
const status = { role: 'system', sys: true, content: 'Run finished' };
const local = [question,
  { role: 'assistant', content: 'RAW_REJECTED', sourceRunId: 'original', streamId: 's', agentId: 'forge', rowId: 1, ts: 100,
    dispatchState: 'pending', textLength: 12, textSha256: 'stale', ownerLabel: 'saved owner', taint: 'saved-source', attachments: [{ path: 'report.txt' }] },
  status,
  { role: 'assistant', content: 'RAW_DUPLICATE', sourceRunId: 'original', attachments: [{ path: 'report.txt' }, { path: 'data.csv' }] },
  { role: 'assistant', content: final.content },
  { role: 'assistant', content: 'UNKNOWN_LEGACY' },
  { role: 'assistant', content: 'OTHER_RUN', sourceRunId: 'ordinary' },
  { role: 'assistant', content: 'STILL_PENDING', sourceRunId: 'pending' },
  { role: 'assistant', content: 'FOREIGN_AGENT', sourceRunId: 'original', agentId: 'other' },
  { role: 'assistant', content: 'FOREIGN_STREAM', sourceRunId: 'original', streamId: 'elsewhere' }];
const canonical = [Object.assign({}, question, { rowId: 11 }), final];
const original = JSON.stringify(local);
const merged = merge(local, canonical);
A.eq(merged.map(r => r.content), ['Visible request', final.content, 'Run finished', final.content, 'UNKNOWN_LEGACY', 'OTHER_RUN', 'STILL_PENDING', 'FOREIGN_AGENT', 'FOREIGN_STREAM'], 'replace only explicit same-run saved prose at its original position');
const accepted = merged[1];
for (const field of ['sourceRunId', 'streamId', 'agentId', 'dispatchState', 'dispatchReason', 'textLength', 'textSha256', 'rowId', 'ts', 'taint']) A.eq(accepted[field], final[field], 'canonical ' + field + ' wins');
A.eq(accepted.ownerLabel, 'saved owner', 'local ownership context survives when canonical has no replacement');
A.eq(accepted.attachments.map(a => a.path).sort(), ['data.csv', 'report.txt'], 'attachments from all superseded copies survive once');
A.eq(merged[2], status, 'system status row is unchanged');
A.eq(JSON.stringify(local), original, 'merging does not mutate the saved desktop history');
A.eq(merged.filter(r => r.dispatchState === 'final').length, 1, 'same-text ordinary row cannot consume or duplicate final identity');
const noTaint = Object.assign({}, final); delete noTaint.taint;
A.eq(merge(local, [question, noTaint])[1].taint, 'saved-source', 'saved taint survives when canonical adds none');
const healedFailure = merge([question, { ...local[1], error: true, stopped: true, stopNote: 'original failed' }], canonical)[1];
A.ok(!healedFailure.error && !healedFailure.stopped && !healedFailure.stopNote, 'accepted answer does not inherit obsolete failure flags');
A.eq(healedFailure.supersededStatus, { error: true, stopped: true, stopNote: 'original failed' }, 'superseded status remains available as separate evidence');
A.eq(merge([{ role: 'assistant', content: 'unfinalized', sourceRunId: 'p' }], [{ role: 'assistant', content: 'raw', sourceRunId: 'p', dispatchState: 'pending' }]).map(r => r.content), ['raw', 'unfinalized'], 'unfinalized canonical rows do not gain replacement authority');
const collision = merge([{ role: 'assistant', content: final.content, sourceRunId: 'ordinary' }, local[1]], [{ role: 'assistant', content: final.content, sourceRunId: 'ordinary' }, final]);
A.eq(collision.map(r => r.sourceRunId), ['ordinary', 'original'], 'ordinary canonical text cannot consume the reserved final slot');
(async () => {
  let ran = null, priorAgentTurn = null;
  const proofIo = makeMemoryTranscriptIo();
  for (const row of local.concat(canonical)) if (Number.isSafeInteger(row.rowId) && row.rowId > 0) proofIo.appendDurable(Object.assign({ streamId: 's' }, row));
  const proofStore = makeTranscriptStore({ io: proofIo, clock: { now: () => 1000 } });
  const host = makeRemoteHost({ now: () => 1000, newId: () => 'followup', broadcast: () => {}, roster: () => [{ agentId: 'forge' }], liveRuns: () => [],
    credentials: () => ({ ok: true }), classify: (_text, context) => { priorAgentTurn = context.priorAgentTurn; return true; },
    runOnce: async options => { ran = options; }, transcript: { view: (_name, _stream, options) => options.op === 'streams' ? [] : canonical, cacheRetractions: proofStore.cacheRetractions },
    deskSessions: () => [{ id: 's', agentId: 'forge', history: local.slice(0, 4) }] });
  A.eq((await host.thread({ streamId: 's', limit: 60 })).map(r => r.content), ['Visible request', final.content], 'actual phone thread shows only accepted same-run answer');
  await host.send({ streamId: 's', agentId: 'forge', text: 'continue' });
  for (let i = 0; i < 4 && !ran; i++) await new Promise(resolve => setImmediate(resolve));
  A.eq(ran && ran.messages.map(r => r.content), ['Visible request', final.content, 'continue'], 'actual phone send receives accepted context once');
  A.eq(priorAgentTurn, final.content, 'task classification receives accepted last assistant');
  A.report('remote dispatch history');
})().catch(error => { A.ok(false, error.stack); A.report('remote dispatch history'); });
