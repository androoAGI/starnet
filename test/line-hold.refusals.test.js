/* node test/line-hold.refusals.test.js — A REFUSED DECISION NEVER FILLS THE RECEIPT LIST (line-hold lane; invariant stop-is-never-refused).

   Every decision keeps a receipt, and the validator caps the receipt list. A refused APPROVE used to keep its receipt for good, so a UI or a
   script that retried APPROVE with a new token after each refusal (the crew was not back) filled the list; the next claim, a STOP included,
   could not be written, and the held job could never be closed. The family: refuse a claimed decision again and again on the real store, far
   past the cap; the list stays bounded to the newest refusals, every refusal stays a refusal, and a STOP still claims the held job. */
'use strict';
const A = require('./_assert.js');
const J = require('../sidecar/routing/linejobs.js');
const C = require('../sidecar/routing/line-continuation.js');
const { fixture } = require('./helpers/line-continuation.js');

const { job, continuation } = fixture();
let state = J.checkpoint(J.start({ jobs: [] }, Object.assign({}, job, { at: 100 })).state, job.id, 0, continuation).state;
const ROUNDS = C.MAX_ATTEMPTS + 76;
for (let n = 0; n < ROUNDS; n++) {
  const rev = J.get(state, job.id).continuation.revision, token = 'tok-' + n;
  state = J.claimDecision(state, job.id, { token, revision: rev, action: 'approve', note: '', at: 200 + n }).state;
  state = J.refuseDecision(state, job.id, { token, why: 'the agent drafter cannot run now', at: 300 + n }).state;
}
const held = J.get(state, job.id);
A.ok(held.status === 'held' && held.continuation.phase === 'held' && held.continuation.activeDecision === null, 'still held after ' + ROUNDS + ' refusals');
A.ok(held.continuation.decisions.length <= C.MAX_REFUSED, 'the receipt list is bounded to the newest refusals, not ' + held.continuation.decisions.length);
A.ok(held.continuation.decisions.every(d => d.state === 'refused'), 'what is kept is still refused');
A.eq(held.continuation.decisions[held.continuation.decisions.length - 1].token, 'tok-' + (ROUNDS - 1), 'the newest refusal is kept');
A.throws(() => J.claimDecision(state, job.id, { token: 'tok-0', revision: 1, action: 'approve', note: '', at: 1 }), 'a refusal dropped from the list cannot be replayed into an approval (its revision is spent)');
const stop = J.claimDecision(state, job.id, { token: 'stop-1', revision: held.continuation.revision, action: 'stop', note: '', at: 9000 });
A.eq(stop.job.continuation.activeDecision, 'stop-1', 'STOP is still accepted on the held job');
A.report('line-hold.refusals');
