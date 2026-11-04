'use strict';
const A = require('./_assert.js');
const { J } = require('./helpers/line-accounting-host.js');
const { P, C, clone, straight, split, boundChain, data } = require('./helpers/line-entry-adoption.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const f = data(), walk = f.chain.initializeEntry(f.entry);
const next = C.seedEntryContinuation(f.entry, f.job, walk);
const metadata = { version: 1, ledgerId: f.entry.ledgerId, state: 'confirmed' };
const state = () => J.normalizeAll({ jobs: [Object.assign(clone(f.job), { entryAdmission: clone(f.entry) })], continuationAccounting: metadata });
const paired = () => J.normalizeAll({ jobs: [Object.assign(clone(f.job), { entryAdmission: clone(f.entry), continuation: clone(next) })], continuationAccounting: metadata });
const attempt = fn => { try { return { value: fn() }; } catch (error) { return { error }; } };
A.ok(P.ok(f.plan), 'actual drawn straight line compiles');
A.eq(P.agentOfDock(f.plan, 'dock-reviewer'), 'reviewer', 'actual compiled dock carries its exact agent');
A.eq(P.lineOfDock(f.plan, 'dock-reviewer'), f.job.line, 'actual compiled dock carries its original intake line');
A.eq(walk.visited, ['dock-reviewer'], 'initial cursor retains exact dock identity');
A.eq([walk.lastHanded, walk.producerVerdict, walk.hop, walk.loopHops], [f.entry.observation.product.draft, 'blocked', 0, 0], 'initial cursor carries real draft/verdict without inventing a hold or iteration');
A.ok(C.inspectEntryPair(f.entry, next, f.job).ok, 'exact retained pair validates');
for (const edit of [e => { e.observation.usageMissing = true; }, e => { e.observation.outcome = 'cancelled'; },
  e => { e.observation.unpriced = true; }, e => { e.state = 'uncertain'; e.observation = null; }]) {
  const e = clone(f.entry); edit(e);
  A.throws(() => C.seedEntryContinuation(e, f.job, walk), 'unresolved/non-success/unpriced entry cannot become a ready cursor');
}
for (const edit of [c => { c.walk.originalText = 'another input'; }, c => { c.walk.entryOutput.text = 'another output'; },
  c => { c.attempts[0].workitemId = 'foreign'; }, c => { c.accounting.limits.maxUsd = 100; },
  c => { c.accounting.dayReceipts = []; }, c => { c.binding.entryNode.agentId = 'foreign'; },
  c => { c.restriction.hostPowerWithheld = false; }]) {
  const c = clone(next); edit(c);
  A.ok(!C.inspectEntryPair(f.entry, c, f.job).ok, 'pair cannot substitute work, receipt, identity or original authority');
}
const zero = clone(f.entry); zero.observation.usd = 0;
A.eq(C.seedEntryContinuation(zero, f.job, walk).accounting.dayReceipts[0].usd, 0, 'completed zero USD still requires an exact receipt');
const largeEntry = clone(f.entry), largeCursor = clone(next);
largeEntry.input.text = 'x'.repeat(C.MAX_BYTES / 2 + 100); largeEntry.inputDigest = C.entryInputDigest(largeEntry.input);
largeCursor.walk.originalText = largeEntry.input.text; largeCursor.attempts[0].inputDigest = largeEntry.inputDigest;
A.ok(C.inspectEntry(largeEntry, f.job).ok && C.inspect(largeCursor, f.job).ok, 'oversize-pair control uses individually valid bounded envelopes');
A.ok(!C.inspectEntryPair(largeEntry, largeCursor, f.job).ok, 'combined retained authority refuses its full executable byte overflow');
const largeState = J.normalizeAll({ jobs: [Object.assign(clone(f.job), { entryAdmission: largeEntry, continuation: largeCursor })], continuationAccounting: metadata });
A.eq(largeState.jobs[0].entryAdmission.input.text.length, largeEntry.input.text.length, 'oversized pair is preserved losslessly rather than truncated');
A.throws(() => J.assertWritable(largeState), 'oversized pair refuses whole-store erasing writes');
const fanPlan = P.compileRoutingPlan(split()), fan = clone(f.entry);
fan.binding.entryNode = { agentId: 'A', dockId: 'p3' }; fan.binding.intakeId = 'p1'; fan.binding.lineId = P.lineOfDock(fanPlan, 'p3');
A.ok(P.ok(fanPlan), 'actual drawn fan/join compiles');
A.ok(P.fanSiblingsDock(fanPlan, 'p3').some(n => n.dockId === 'p4'), 'compiled geometry independently proves the other paid sibling');
A.throws(() => boundChain(fanPlan).initializeEntry(fan), 'private straight initializer refuses actual drawn entry siblings');
const missing = straight(); missing.props = missing.props.filter(p => p.id !== 'dock-reviewer');
A.throws(() => boundChain(P.compileRoutingPlan(missing)).initializeEntry(f.entry), 'deleted dock cannot borrow empty siblings as membership');
const foreign = clone(f.entry); foreign.binding.entryNode.dockId = 'not-the-dock';
A.throws(() => boundChain(f.plan, { lineOfAgent: () => f.job.line }).initializeEntry(foreign), 'legacy agent fallback cannot vouch a missing exact dock');
for (const seam of [undefined, () => null, () => { throw new Error('unknown plan'); }]) {
  A.throws(() => boundChain(f.plan, { fanSiblingsDock: seam }).initializeEntry(f.entry), 'missing or unknown sibling authority refuses');
}
A.throws(() => makeChainRunner({}).initializeEntry(f.entry), 'an unbound chain cannot initialize saved work');
const prior = state(), invoke = typeof J.adoptEntry === 'function'
  ? () => J.adoptEntry(prior, f.job.id, f.entry.revision, next)
  : () => J.checkpoint(prior, f.job.id, 0, next);
const adopted = attempt(invoke);
A.ok(!adopted.error, 'existing owner accepts the exact paired adoption without deleting entry');
A.notThrows(() => J.assertWritable(paired()), 'paired job remains writable through its existing owner');
A.eq(J.get(paired(), f.job.id).entryAdmission, f.entry, 'normalization retains exact original entry');
if (adopted.value) {
  A.eq(adopted.value.job.entryAdmission, f.entry, 'first adoption retains original complete evidence');
  A.eq(J.adoptEntry(adopted.value.state, f.job.id, f.entry.revision, next).replayed, true, 'exact repeated adoption is a saved receipt');
  A.throws(() => J.checkpointEntry(adopted.value.state, f.job.id, f.entry.revision, clone(f.entry)), 'paired entry cannot return to an entry mutation');
  A.throws(() => J.adoptEntry(prior, f.job.id, 999, next), 'stale entry revision refuses');
  const moved = clone(next); moved.walk.hop = 1;
  A.throws(() => J.adoptEntry(prior, f.job.id, f.entry.revision, moved), 'adoption cannot invent an already advanced cursor');
}
const booted = J.boot(paired(), 500, new Set([f.job.id]));
A.eq(booted.changed, true, 'boot reconciles a valid paired live continuation');
A.eq(J.get(booted.state, f.job.id).entryAdmission, f.entry, 'boot never rewrites the original observed entry');
A.eq(J.get(booted.state, f.job.id).status, 'interrupted', 'boot reports the saved cursor without resuming it');
A.eq(J.boot(paired(), 500, new Set(['job-other0001'])).changed, false, 'later boot retry does not interrupt a new unowned admission');
for (const edit of [j => { j.continuation.version = 99; }, j => { j.entryAdmission.observation.product.text = 'changed'; },
  j => { j.continuation.walk.entryOutput.text = 'changed'; }]) {
  const raw = { jobs: [Object.assign(clone(f.job), { entryAdmission: clone(f.entry), continuation: clone(next) })], continuationAccounting: metadata };
  edit(raw.jobs[0]); const loaded = J.normalizeAll(raw);
  A.eq(loaded.jobs[0].entryAdmission, raw.jobs[0].entryAdmission, 'invalid pair preserves original entry bytes');
  A.eq(loaded.jobs[0].continuation, raw.jobs[0].continuation, 'invalid/future pair preserves original continuation bytes');
  A.throws(() => J.assertWritable(loaded), 'invalid pair refuses erasing rewrites');
}
const stop = { code: 'stopped', why: 'fixture owned stop', agentId: 'reviewer', dockId: 'dock-reviewer' };
const terminal = clone(next); terminal.revision = 2; terminal.phase = 'terminal_pending';
terminal.terminal = { outcome: 'stopped', output: f.entry.observation.product.text, usd: f.entry.observation.usd, runIds: ['run-entry'], stop };
const terminalResult = attempt(() => J.checkpoint(paired(), f.job.id, 1, terminal));
A.ok(!terminalResult.error, 'existing checkpoint can settle a paired cursor through its typed stop');
if (terminalResult.value) {
  const finished = J.finish(terminalResult.value.state, f.job.id, { status: RunOutcome.lineStatus('stopped'), outcome: 'stopped',
    output: terminal.terminal.output, usd: terminal.terminal.usd, stop, at: 500,
    runs: [{ runId: 'run-entry', agentId: 'reviewer', dockId: 'dock-reviewer', usd: terminal.terminal.usd, reason: 'done', outcome: 'succeeded' }] });
  const done = clone(terminal); done.revision = 3; done.phase = 'complete';
  const closed = J.checkpoint(finished.state, f.job.id, 2, done).job;
  const history = Array.from({ length: 120 }, (_, i) => Object.assign(clone(f.job), { id: 'job-prune' + String(i).padStart(8, '0'), startedAt: 1000 + i, endedAt: 2000 + i, status: 'stopped' }));
  A.ok(!J.retain([closed].concat(history)).some(j => j.id === f.job.id), 'fully settled valid pair follows existing finished-job retention');
  A.ok(J.retain([paired().jobs[0]].concat(history)).some(j => j.id === f.job.id), 'incomplete pair survives retention without hidden eviction');
}
(async () => {
  const notes = [], normal = boundChain(f.plan, { daySpend: { spentToday: () => 0, note: (line, usd) => notes.push([line, usd]) },
    runAgent: () => { throw new Error('straight terminal should buy no downstream work'); } });
  const out = await normal.advance({ agentId: 'reviewer', dockId: 'dock-reviewer', lineId: f.job.line, text: f.entry.observation.product.text,
    product: f.entry.observation.product, originalText: f.entry.input.text, entryUsd: f.entry.observation.usd, runId: 'run-entry' });
  A.eq([out.text, out.usd, out.hops.length], [f.entry.observation.product.text, 0, 0], 'existing ordinary walk keeps entry output and hop-only accounting after shared initializer extraction');
  A.eq(notes, [[f.job.line, f.entry.observation.usd]], 'legacy ordinary entry booking remains exactly once');
  A.report('line-entry.adoption');
})().catch(error => { console.error(error); process.exitCode = 1; });
