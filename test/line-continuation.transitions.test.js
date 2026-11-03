/* Independent-review controls: load the exact saved old owner without swapping files.
   Synthetic saved run facts; no provider, host route or real publication is invoked. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const A = require('./_assert.js');
const owner = require.resolve('../sidecar/routing/line-continuation.js');
if (process.env.LINE_CONTINUATION_CONTROL) {
  const old = new Module(owner, module); old.filename = owner; old.paths = Module._nodeModulePaths(path.dirname(owner));
  old._compile(fs.readFileSync(process.env.LINE_CONTINUATION_CONTROL, 'utf8'), owner);
  require.cache[owner] = old;
}
const C = require(owner);
const J = require('../sidecar/routing/linejobs.js');
const { fixture, clone, digest } = require('./helpers/line-continuation.js');
const { job, continuation: held } = fixture();
for (const [name, change] of [
  ['per-message ceiling', c => { c.accounting.limits.maxUsd = 1000; }],
  ['day ceiling removed', c => { c.accounting.limits.maxUsdPerDay = null; }],
  ['saved hop ceiling changed', c => { c.accounting.limits.maxHops = 23; }]
]) { const c = clone(held); c.revision++; change(c); A.throws(() => C.checkpoint(held, job, 1, c), name + ' cannot rewrite original upper bounds'); }
const order = clone(held); order.revision++;
order.accounting.limits = { maxUsdPerDay: 10, maxUsd: 2, maxHops: 24 };
A.ok(C.checkpoint(held, job, 1, order).revision === 2, 'limits are immutable semantically, not by JSON property order');
const request = { token: 'approve-1', revision: 1, action: 'approve', note: 'approve this exact draft', at: 200 };
const claimed = C.claimDecision(held, job, request).continuation;
for (const [name, change] of [
  ['different saved draft', c => { c.walk.product.text = 'a different draft'; }],
  ['different reviewed draft', c => { c.walk.lastHanded = 'different review input'; }],
  ['different hold explanation', c => { c.hold.why = 'another hold'; }],
  ['different saved cursor', c => { c.walk.next = Object.assign({}, c.walk.next, { kind: 'outbox', outboxId: 'other-outbox' }); }]
]) { const c = clone(claimed); c.revision++; change(c); A.throws(() => C.checkpoint(claimed, job, 2, c), name + ' cannot reuse pending acceptance'); }
const tampered = clone(claimed); tampered.walk.product.text = 'substituted before adoption'; tampered.walk.lastHanded = 'another review';
const adoptTampered = clone(tampered); adoptTampered.revision++; adoptTampered.phase = 'ready'; adoptTampered.hold = null; adoptTampered.decisions[0].state = 'adopted';
A.throws(() => C.checkpoint(tampered, job, 2, adoptTampered), 'adoption independently checks the accepted checkpoint digest');
const directSwap = clone(claimed); directSwap.revision++; directSwap.phase = 'ready'; directSwap.hold = null;
directSwap.decisions[0].state = 'adopted'; directSwap.walk.product.text = 'substituted at adoption';
A.throws(() => C.checkpoint(claimed, job, 2, directSwap), 'approval cannot substitute work at the consumption boundary');
const back = C.claimDecision(held, job, Object.assign({}, request, { token: 'back-1', action: 'send_back' })).continuation;
const backReady = clone(back); backReady.revision++; backReady.phase = 'ready'; backReady.hold = null; backReady.decisions[0].state = 'adopted';
backReady.walk.lastHanded = 'construct the next revision input after consuming this exact decision';
A.ok(C.checkpoint(back, job, 2, backReady).phase === 'ready', 'send-back can construct its next input only after exact decision consumption');

const ready = clone(claimed); ready.revision++; ready.phase = 'ready'; ready.hold = null; ready.decisions[0].state = 'adopted';
const observedWithoutIntent = clone(ready); observedWithoutIntent.revision++;
const spontaneous = Object.assign({}, observedWithoutIntent.attempts[0], { ordinal: 2, runId: 'run-spontaneous', workitemId: 'crate-spontaneous', usd: 0 });
observedWithoutIntent.attempts.push(spontaneous); observedWithoutIntent.accounting.runIds.push(spontaneous.runId);
A.throws(() => C.checkpoint(ready, job, 3, observedWithoutIntent), 'a new observed paid result cannot appear without a preceding saved intent');

const terminal = clone(ready); terminal.revision++; terminal.phase = 'terminal_pending';
terminal.terminal = { outcome: 'delivered', output: terminal.walk.product.text, usd: 0.125, runIds: ['run-entry'], stop: null };
terminal.publication = { outboxId: 'outbox-a', entryRunId: 'run-entry', terminalRunId: 'run-entry', state: 'pending', shipmentId: null, sentToJobId: null };
const pending = C.checkpoint(ready, job, 3, terminal);
const confirmed = clone(pending); confirmed.revision++; confirmed.publication.state = 'confirmed'; confirmed.publication.shipmentId = 'existing-shipment-1';
A.ok(C.checkpoint(pending, job, 4, confirmed).publication.state === 'confirmed', 'a proven receipt may confirm the original pending publication');
for (const [name, change] of [
  ['confirmed to pending', c => { c.publication.state = 'pending'; }],
  ['confirmed to uncertain', c => { c.publication.state = 'uncertain'; }],
  ['outbox retarget', c => { c.publication.outboxId = 'other-outbox'; }],
  ['shipment identity replacement', c => { c.publication.shipmentId = 'different-shipment'; }],
  ['shipment acknowledgement erased', c => { c.publication.shipmentId = null; }]
]) { const c = clone(confirmed); c.revision++; change(c); A.throws(() => C.checkpoint(confirmed, job, 5, c), name + ' cannot rewind accepted publication'); }
// Source02 can represent every case above. Its schema has no suppressed state;
// the new ordering/suppression positives below are current-owner tests only.
if (process.env.LINE_CONTINUATION_CONTROL) A.report('line-continuation.transitions source02 representable control');
const suppression = clone(pending); suppression.revision++; suppression.terminal.outcome = 'stopped';
suppression.terminal.stop = { code: 'station_fault', why: 'station fault stopped this pending release', agentId: 'reviewer', dockId: 'dock-reviewer' };
suppression.publication.state = 'suppressed';
A.ok(C.checkpoint(pending, job, 4, suppression).publication.outboxId === 'outbox-a', 'owned fault suppresses an unconfirmed release while retaining its identity');

// Prove pure job lifecycle ordering: result acceptance precedes publication receipt,
// and recording the latter never reopens a settled job or reuses stale blocked facts.
const initial = J.start({ jobs: [] }, Object.assign({}, job, { at: 100 }));
const saved = J.checkpoint(initial.state, job.id, 0, held);
const accepted = J.claimDecision(saved.state, job.id, request);
const adopted = J.checkpoint(accepted.state, job.id, 2, ready);
const awaiting = J.checkpoint(adopted.state, job.id, 3, pending);
A.throws(() => J.checkpoint(awaiting.state, job.id, 4, confirmed), 'publication cannot confirm before its terminal job is accepted');
const result = { status: 'delivered', outcome: 'delivered', stop: null, output: pending.terminal.output, usd: 0.125, at: 300,
  runs: [{ runId: 'run-entry', agentId: 'reviewer', dockId: 'dock-reviewer', reason: 'done', outcome: 'succeeded', usd: 0.125 }] };
const settled = J.finish(awaiting.state, job.id, result);
A.eq([settled.job.status, settled.job.outcome, settled.job.endedAt, settled.job.continuation.publication.state], ['delivered', 'delivered', 300, 'pending'], 'job result may be durably accepted before publication is confirmed');
const complete = clone(pending); complete.revision++; complete.phase = 'complete'; complete.publication.state = 'confirmed';
complete.publication.shipmentId = 'existing-shipment-1'; complete.activeDecision = null; complete.decisions[0].state = 'complete';
const completed = J.checkpoint(settled.state, job.id, 4, complete);
A.eq([completed.job.status, completed.job.outcome, completed.job.endedAt], ['delivered', 'delivered', 300], 'publication confirmation does not resurrect running state');
A.eq(digest(completed.job.output), digest(settled.job.output), 'terminal output stays exact');
A.ok(J.claimDecision(completed.state, job.id, request).replayed, 'lost decision response after completion returns its original receipt');
A.throws(() => C.checkpoint(pending, settled.job, 4, suppression), 'an already accepted terminal result cannot be relabeled by a later stop');
A.report('line-continuation.transitions');
