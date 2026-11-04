/* node test/line-hold.split.test.js — A HOLD INSIDE A SPLIT SURVIVES (line-hold lane, S5; invariant hold-inside-a-split-survives).

   A work line that fans out into branches and meets a JOINER keeps its parked branches in a barrier in memory. Until now a job that stopped
   at a reviewer's gate INSIDE one branch (or right after the join) could not be saved: its siblings' work sat in that barrier, a restart
   dropped it ("join barrier lost on restart ... the line will not resume"), and the job ended the old terminal blocked stop. The hold now
   carries the split with it: the branch that stopped, the branches still to run (with the part of the job each was handed), the branches
   that failed, the barrier and every part already parked in it, each part tied to the branch and the exact run that made it.

   The hold and the resume are the real ones (the station's own store, authority and hop executor over the real router, chain and LineRunner;
   only the provider and the clock are fakes). A RESTART is a new chain and a new runner over the saved file: nothing of the first walk is
   left in memory but what the job record says.

     1. F2: A (the entry) parks at the joiner, B's gate holds the job. Saved: the barrier with A's part, B as the branch that stopped.
        After a restart APPROVE joins ONCE: A and B do not run again, only the stage past the joiner is bought, one OUTBOX delivery.
     2. F1: the gate holds the ENTRY branch while its sibling has not started. The sibling runs once after APPROVE, handed the original
        job (not the held branch's work), and the join is one.
     3. SEND BACK inside the split: the branch runs again, the barrier comes back with ITS part exactly once (never a second copy), a second
        hold is saved on the same job with the same barrier, and a restart and APPROVE then join once.
     4. STOP buys nothing and joins nothing; a repeated decision after the delivery buys nothing; a queued sibling that FAILS once the
        person has decided is the join's partial mark, as it always was, not a hang or a second join.
     5. F3: a gate right AFTER the joiner: the merged crate is the work under review, saved with the runs it came from; APPROVE delivers it.
        Two reviewers in series (the branch's gate, then the merged crate's) hold the same job twice; a gate after a PARALLEL join (two
        single-step branches run at once) is saved the same way.
     6. What cannot be saved exactly still ends the old way, the reason said, never half-saved (the validator's 512-part bound, a part with
        no recorded run, a batch of branches still out, a barrier with no split, E-STOP at the gate).
     7. The chain on its own: the same state from a hand-written fan of three (a failed sibling, a parked part, the dividing splitter's part
        of the job, a branch that ended at an OUTBOX of its own), put back into a new chain, a restored barrier is never opened twice, and a
        resumed walk that is stopped before the join leaves nothing parked.

   Run against the S4 tip (0554f37c6) this goes RED in every section: the walk cannot save a hold inside a split ("the gate sits inside a
   split that is still running, and a hold inside a split is not saved yet") or after a join, and the sibling's part stays in memory. */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/routing/line-continuation.js');
const LineHold = require('../sidecar/routing/line-hold.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig } = require('./helpers/line-hold-rig.js');

const belt = (x, y, dir) => ({ x, y, dir });
// INBOX -> SPLIT -> (A | B) -> JOINER -> D -> OUTBOX. A is the entry dock (the router's pick), B its sibling.
function splitFloor() {
  return { props: [{ id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'p2', t: 'splitter', x: 3, y: 0, w: 1, h: 1 }, { id: 'p3', t: 'bay', x: 6, y: 0, w: 2, h: 2, agentId: 'A' },
    { id: 'p4', t: 'bay', x: 2, y: 4, w: 2, h: 2, agentId: 'B' }, { id: 'p5', t: 'joiner', x: 9, y: 4, w: 1, h: 1 }, { id: 'p6', t: 'bay', x: 12, y: 4, w: 2, h: 2, agentId: 'D' },
    { id: 'p8', t: 'outbox', x: 15, y: 3, w: 2, h: 2 }],
  belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'), belt(3, 1, 'S'), belt(3, 2, 'S'), belt(3, 3, 'S'), belt(8, 0, 'S'), belt(8, 1, 'S'),
    belt(8, 2, 'S'), belt(8, 3, 'S'), belt(8, 4, 'E'), belt(4, 5, 'E'), belt(5, 5, 'E'), belt(6, 5, 'E'), belt(7, 5, 'E'), belt(8, 5, 'E'), belt(9, 5, 'N'), belt(9, 4, 'E'),
    belt(10, 4, 'E'), belt(11, 4, 'E'), belt(14, 4, 'E')] };
}
// F1: a gate INSIDE A's lane (a self-loop: back W into A). A is the entry branch; B has not started when the gate holds.
function F1(gate) { const g = splitFloor(); g.props.push(Object.assign({ id: 'p7', t: 'loop', x: 8, y: 2, w: 1, h: 1, done: 'S', when: 'approved', maxIter: 2 }, gate || {})); g.belts.push(belt(7, 2, 'W')); return g; }
// F2: a gate INSIDE B's lane (a self-loop). A (the entry) parks at the joiner first; B is the branch that stops.
function F2(gate) { const g = splitFloor(); g.props.push(Object.assign({ id: 'p7', t: 'loop', x: 6, y: 5, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 }, gate || {}));
  g.belts.push(belt(6, 6, 'W'), belt(5, 6, 'W'), belt(4, 6, 'W'), belt(3, 6, 'W')); return g; }
// F3: a gate right AFTER the joiner (done E to the OUTBOX, no back lane), no stage past it
function F3() { const g = splitFloor(); g.props = g.props.filter(p => p.id !== 'p6' && p.id !== 'p8');
  g.props.push({ id: 'p7', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 }, { id: 'p8', t: 'outbox', x: 15, y: 3, w: 2, h: 2 });
  g.belts = g.belts.filter(b => !(b.x === 14 && b.y === 4)); g.belts.push(belt(12, 4, 'E'), belt(13, 4, 'E'), belt(14, 4, 'E')); return g; }
// a planner P (the entry) before the splitter: its two branches are each ONE step into the joiner, so they run AT ONCE (the chain's parallel batch), then a gate
function parallelFloor() {
  const b = splitFloor(), dx = 4;
  // the split floor moved right by 4 without its INBOX, D and D's exit; the planner is fed by a new INBOX, and a gate and an OUTBOX follow the joiner
  const props = b.props.filter(p => !['p1', 'p6', 'p8'].includes(p.id)).map(p => Object.assign({}, p, { x: p.x + dx }));
  const belts = b.belts.filter(x => !(x.x === 14 && x.y === 4)).map(x => Object.assign({}, x, { x: x.x + dx }));
  props.push({ id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'p0', t: 'bay', x: 2, y: 0, w: 2, h: 2, agentId: 'P' },
    { id: 'p7', t: 'loop', x: 16, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 }, { id: 'p8', t: 'outbox', x: 19, y: 3, w: 2, h: 2 });
  belts.push(belt(1, 0, 'E'), belt(4, 0, 'E'), belt(16, 4, 'E'), belt(17, 4, 'E'), belt(18, 4, 'E'));
  return { props, belts };
}
const ENTRY = { agentId: 'A', dockId: 'p3' }, CREW = ['A', 'B', 'D'];

const get = (env, id) => J.get(env.host.jobs(), id);
const cont = (env, id) => get(env, id).continuation;
const decide = (owner, id, c, action, token, note) => owner.resume(id, { action, token, revision: c.revision, note: note || '' });
const joins = rig => rig.events.filter(e => e.n === 'workitem.delivered' && /^join:/.test(String(e.p.box || '')));
const outputs = rig => rig.events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output');
const REPLIES = { B: 'B draft', D: 'D final' };

// a floor to its hold, settled the way the hub settles it, with the real store under the runner. `reply` answers every stage past the entry.
async function held(env, floor, o) {
  const opts = Object.assign({ floor, entry: ENTRY, agents: CREW }, o && o.rig);
  const rig = makeRig(opts).wire(env.host);
  rig.reply = (o && o.reply) || (x => REPLIES[x.agentId] || x.agentId + ' out');
  const ran = await rig.run({ replies: (o && o.replies) || ['A out'] });
  rig.settle(ran.job, ran.line);
  A.ok(ran.line.held && !ran.line.holdFailed && get(env, ran.job.id).status === 'held', 'the job is parked as a hold: ' + (ran.line.holdFailed || ''));
  return { rig, ran, id: ran.job.id, opts };
}
// the station restarted: the saved file is read again, and a NEW chain and runner (nothing in memory) carry the decision
let restarts = 0;
function restarted(env, opts, reply) {
  restarts++;   // (a restarted station mints its own ids and reads its own clock — never the first station's again)
  const host = env.loadHost(), rig = makeRig(Object.assign({}, opts, { idBase: 100000 * restarts, clockBase: 1000 + 1000000 * restarts })).wire(host);
  rig.reply = reply || (x => REPLIES[x.agentId] || x.agentId + ' out');
  return { host, rig, owner: rig.owner(host) };
}
const getFrom = (host, id) => J.get(host.jobs(), id);

(async () => {
  const section = async (label, fn) => { try { await fn(); } catch (e) { A.ok(false, label + ' threw: ' + (e && e.message) + (e && e.stack ? ' @ ' + String(e.stack).split('\n')[1].trim() : '')); } };
  /* ---- 1. F2: A parked at the joiner, B's gate holds. Restart. APPROVE joins ONCE ---- */
  await section('F2: A parked, B held, restart, APPROVE', () => allocated(async env => {
    const { rig, ran, id, opts } = await held(env, F2());
    const c0 = cont(env, id), seen = C.inspect(c0, get(env, id));
    A.ok(seen.ok, 'the saved hold is a valid version 1 continuation: ' + (seen.issue && seen.issue.message));
    A.eq([ran.line.hold.reason, ran.line.hold.gateId, ran.line.hold.pass, rig.calls], ['missing_verdict', '6,5', 0, ['B']], 'B said nothing the gate can read: held at its gate, the entry A and one stage B ran');
    A.eq([get(env, id).status, c0.phase, c0.walk.current], ['held', 'held', { agentId: 'B', dockId: 'p4' }], 'the job is HELD at the stage that stopped');
    const b = c0.barriers[0];
    A.eq(c0.barriers.length, 1, 'the barrier A parked at is saved');
    A.eq([b.joinId, b.entryRunId, b.branchIds, b.failed, b.pending, b.inFlight, b.timeoutMs], ['9,4', ran.runId, ['p3', 'p4'], [], ['p4'], [], 600000],
      'the barrier: the joiner, both branches, B still owing its part, no batch out, the joiner\'s 10 minutes');
    A.eq(b.parts.map(p => [p.branchId, p.runId, p.product.text, p.product.producer]), [['p3', ran.runId, 'A out', { kind: 'run', runId: ran.runId }]], 'A\'s part is there with the run that made it');
    A.eq(c0.walk.fan, { branchIds: ['p3', 'p4'], width: 2, failed: [], joinKey: '9,4|' + ran.runId, joinStep: { join: '9,4', expect: 2, timeoutMin: 10, next: { agentId: 'D', dockId: 'p6' } }, handed: 'write a post' },
      'the split the walk is inside: both branches, the joiner it meets, what the branches were handed');
    A.eq([c0.walk.pending, c0.walk.forced, c0.walk.branchMode], [[], null, true], 'no branch is queued (B started), and the walk is marked as inside a queued branch');
    A.eq(c0.attempts.map(a => [a.node.agentId, a.branchId, a.state]), [['A', 'p3', 'observed'], ['B', 'p4', 'observed']], 'each stage is an observed attempt of its branch (the entry run is A\'s branch)');
    A.eq(rig.chain._barrier.size(), 0, 'the hold took the barrier out of the chain\'s memory: nothing waits there for a join that cannot come');
    A.eq([joins(rig).length, outputs(rig).length, rig.shipped.length], [0, 0, 0], 'nothing joined, nothing delivered');

    // RESTART: a new chain, a new runner, the job as the file says it. Boot leaves the hold alone.
    const r2 = restarted(env, opts), saved = JSON.stringify(getFrom(r2.host, id));
    A.eq([getFrom(r2.host, id).status, JSON.stringify(getFrom(r2.host, id).continuation) === JSON.stringify(c0), r2.rig.chain._barrier.size(), r2.rig.calls.length], ['held', true, 0, 0],
      'after the restart the job is still held, revision, barrier and draft as they were; nothing in memory; no provider call');
    const world = r2.rig.world(), r = decide(r2.owner, id, c0, 'approve', 'tok-1');
    A.eq([r.code, r.ok, r.running], [202, true, true], 'APPROVE is claimed and carried on');
    const out = await r.done, job = getFrom(r2.host, id), c = job.continuation;
    A.eq(r2.rig.calls, ['D'], 'only the stage past the joiner was bought: the finished sibling A and the held branch B did not run again');
    A.eq([job.status, job.outcome, out.delivered, job.output], ['delivered', 'delivered', true, 'D final'], 'the job DELIVERED the stage past the joiner\'s answer');
    A.eq([joins(r2.rig).length, outputs(r2.rig).length, r2.rig.shipped.length, JSON.parse(r2.rig.world()).finish - JSON.parse(world).finish], [1, 1, 1, 1], 'the join happened ONCE; ONE OUTBOX delivery; one finish');
    const prompt = r2.rig.seen[0].prompt;
    A.ok(/JOINED OUTPUT — 2 of 2 branches delivered/.test(prompt) && !/PARTIAL/.test(prompt) && prompt.indexOf('A out') < prompt.indexOf('B draft'),
      'the stage past the joiner was handed BOTH branches, A\'s saved part first and B\'s approved work: ' + prompt.slice(0, 220).replace(/\n/g, '|'));
    A.ok(!/VERDICT/.test(prompt), 'and no VERDICT line (the gate\'s control signal never moves on)');
    A.eq([job.unapproved, c.terminal.outcome, c.walk.unapproved, r2.rig.timers.length, r2.rig.chain._barrier.size()], [undefined, 'delivered', null, 0, 0], 'nothing was sent on unapproved, no joiner timer was armed, nothing is left at the barrier');
    const last = c.attempts[c.attempts.length - 1];
    A.eq([c.attempts.length, last.node.agentId, last.state, last.branchId, c.attempts.slice(0, 2).every(a => a.state === 'observed')], [3, 'D', 'observed', null, true], 'D is the one new attempt; the join ended the split (no branch)');
    A.eq([c.phase, c.publication.state, c.decisions.map(d => [d.action, d.state])], ['complete', 'confirmed', [['approve', 'complete']]], 'the saved record is complete');
    // the decision again, after the delivery: the saved receipt, nothing runs
    const w2 = r2.rig.world(), again = decide(r2.owner, id, c0, 'approve', 'tok-1');
    A.eq([again.code, again.replayed, r2.rig.world() === w2], [200, true, true], 'the same decision again answers the saved receipt and buys nothing');
    rig.dispose(); r2.rig.dispose();
  }));

  /* ---- 2. F1: the gate holds the ENTRY branch, its sibling has not started ---- */
  await section('F1: the entry branch held, its sibling queued', () => allocated(async env => {
    const { rig, ran, id, opts } = await held(env, F1(), { replies: ['A draft'] });
    const c0 = cont(env, id);
    A.eq([ran.line.hold.reason, ran.line.hold.gateId, rig.calls, c0.walk.current], ['missing_verdict', '8,2', [], { agentId: 'A', dockId: 'p3' }], 'A (the entry) was not clear: held at its gate before any stage was bought');
    A.eq([c0.barriers, c0.walk.branchMode], [[], false], 'nothing is parked yet (A has not reached the joiner), and no queued branch has started');
    A.eq(c0.walk.pending.map(b => [b.id, b.node, b.from, b.entry, b.part, b.product.text, b.product.producer]), [['p4', { agentId: 'B', dockId: 'p4' }, null, true, null, 'write a post', { kind: 'run', runId: ran.runId }]],
      'B is queued: an entry branch, handed the ORIGINAL job, its work traced to the entry run');
    A.eq([c0.walk.fan.branchIds, c0.walk.fan.joinKey, c0.walk.fan.joinStep, c0.walk.fan.width], [['p3', 'p4'], null, null, 2], 'the split: two branches, no joiner met yet');
    A.eq(c0.attempts.map(a => [a.node.agentId, a.branchId]), [['A', 'p3']], 'the entry attempt belongs to A\'s branch');
    const r2 = restarted(env, opts, x => ({ B: 'B out', D: 'D final' })[x.agentId]);
    const out = await decide(r2.owner, id, c0, 'approve', 'tok-1').done, job = getFrom(r2.host, id), c = job.continuation;
    A.eq(r2.rig.calls, ['B', 'D'], 'B ran ONCE after APPROVE (it had not run), then the stage past the joiner; A did not run again');
    A.ok(r2.rig.seen[0].prompt === 'write a post', 'B was handed the original job, not A\'s work: ' + r2.rig.seen[0].prompt.slice(0, 80));
    A.ok(/JOINED OUTPUT — 2 of 2 branches delivered/.test(r2.rig.seen[1].prompt) && r2.rig.seen[1].prompt.indexOf('A draft') < r2.rig.seen[1].prompt.indexOf('B out'), 'D was handed A\'s approved work, then B\'s');
    A.eq([job.status, out.delivered, job.output, joins(r2.rig).length, outputs(r2.rig).length], ['delivered', true, 'D final', 1, 1], 'delivered once, joined once');
    A.eq(c.attempts.map(a => [a.node.agentId, a.branchId, a.state]), [['A', 'p3', 'observed'], ['B', 'p4', 'observed'], ['D', null, 'observed']], 'B\'s attempt belongs to its own branch, D\'s to none');
    rig.dispose(); r2.rig.dispose();
  }));

  /* ---- 3. SEND BACK inside the split: the barrier comes back with its part ONCE, a second hold, a restart, APPROVE ---- */
  await section('SEND BACK inside the split', () => allocated(async env => {
    const { rig, ran, id, opts } = await held(env, F2());
    const c0 = cont(env, id), part0 = c0.barriers[0].parts[0];
    const r2 = restarted(env, opts, x => x.agentId === 'D' ? 'D final' : 'B again');
    const out = await decide(r2.owner, id, c0, 'send_back', 'tok-1', 'tighten the second paragraph').done, job = getFrom(r2.host, id), c1 = job.continuation;
    A.eq(r2.rig.calls, ['B'], 'SEND BACK ran B once more and nothing else (A is parked, D is past the gate)');
    A.ok(r2.rig.seen[0].prompt.includes('tighten the second paragraph') && r2.rig.seen[0].prompt.includes('pass 1 of 2'), 'B was handed the person\'s note and the next pass number');
    A.eq([out.held, job.status, c1.phase, c1.hold.reason, c1.hold.pass, c1.hold.gateId], [true, 'held', 'held', 'missing_verdict', 1, '6,5'], 'B said nothing readable again: HELD a second time, on the same job, one pass further');
    A.eq(c1.barriers.length, 1, 'the barrier is saved again');
    A.eq(JSON.stringify(c1.barriers[0].parts), JSON.stringify([part0]), 'with A\'s part exactly as it was — one copy, the same part id, never a second delivery');
    A.eq([c1.barriers[0].pending, c1.barriers[0].branchIds, c1.walk.fan.joinKey, c1.walk.branchMode], [['p4'], ['p3', 'p4'], '9,4|' + ran.runId, true], 'B still owes its part, in the same split');
    A.eq(c1.attempts.map(a => [a.node.agentId, a.branchId, a.state]), [['A', 'p3', 'observed'], ['B', 'p4', 'observed'], ['B', 'p4', 'observed']], 'the second B run is an observed attempt of B\'s branch (the resumed stage knows its branch)');
    A.eq([r2.rig.chain._barrier.size(), joins(r2.rig).length, outputs(r2.rig).length], [0, 0, 0], 'nothing waits in memory, nothing joined or delivered');
    // restart again, APPROVE the second hold: one join, A and B not run again
    const r3 = restarted(env, opts, x => x.agentId === 'D' ? 'D final' : 'B again');
    const fin = await decide(r3.owner, id, c1, 'approve', 'tok-2').done, done = getFrom(r3.host, id);
    A.eq(r3.rig.calls, ['D'], 'APPROVE of the second hold bought only the stage past the joiner');
    A.eq([done.status, fin.delivered, joins(r3.rig).length, outputs(r3.rig).length, done.continuation.decisions.map(d => d.state)], ['delivered', true, 1, 1, ['complete', 'complete']], 'delivered, joined once, both decisions complete');
    A.ok(/=== BRANCH 1 of 2 — A ===\nA out\n\n=== BRANCH 2 of 2 — B ===\nB again/.test(r3.rig.seen[0].prompt), 'the joined crate: A\'s saved part, then B\'s latest word');
    rig.dispose(); r2.rig.dispose(); r3.rig.dispose();
  }));

  /* ---- 4. STOP buys nothing and joins nothing ---- */
  await section('STOP', () => allocated(async env => {
    const { rig, id, opts } = await held(env, F2());
    const c0 = cont(env, id), r2 = restarted(env, opts), notes = r2.rig.notes.length;
    const r = decide(r2.owner, id, c0, 'stop', 'tok-1', 'not this one'), job = getFrom(r2.host, id);
    A.eq([r.code, r.stopped, job.status, job.outcome, job.output, job.stop.code], [200, true, 'stopped', 'stopped', '', 'stopped'], 'STOP finished the job stopped, delivering nothing');
    A.eq([r2.rig.calls.length, r2.rig.notes.length - notes, joins(r2.rig).length, outputs(r2.rig).length, r2.rig.shipped.length, r2.rig.chain._barrier.size()], [0, 0, 0, 0, 0, 0],
      'no provider call, no day-ledger note, nothing joined, nothing delivered, nothing at the barrier');
    A.eq(job.continuation.barriers.length, 1, 'the sibling\'s part stays on the job\'s record (it was never delivered anywhere)');
    rig.dispose(); r2.rig.dispose();
  }));

  /* ---- 4b. a queued sibling that FAILS once the person has decided: the join sends on what arrived, marked partial, once ---- */
  await section('a queued sibling fails after APPROVE', () => allocated(async env => {
    const { rig, id, opts } = await held(env, F1(), { replies: ['A draft'] });
    const c0 = cont(env, id);
    const r2 = restarted(env, opts, x => x.agentId === 'B' ? '' : 'D final');   // B returns nothing: a failed stage
    const out = await decide(r2.owner, id, c0, 'approve', 'tok-1').done, job = getFrom(r2.host, id), c = job.continuation;
    A.eq(r2.rig.calls, ['B', 'D'], 'B was tried once, the stage past the joiner still ran with what arrived');
    A.ok(/JOINED OUTPUT — 1 of 2 branches delivered/.test(r2.rig.seen[1].prompt) && /PARTIAL: 1 branch failed and sent nothing/.test(r2.rig.seen[1].prompt) && r2.rig.seen[1].prompt.includes('A draft'),
      'it was handed A\'s approved work and told one branch failed and sent nothing: ' + r2.rig.seen[1].prompt.slice(0, 260).replace(/\n/g, '|'));
    A.eq([joins(r2.rig).length, outputs(r2.rig).length, job.status === 'delivered'], [1, 0, false], 'one join, and a partial job is never put at the OUTBOX as a clean product');
    A.eq([c.attempts.map(a => [a.node.agentId, a.branchId]), c.phase, c.walk.partial === null || typeof c.walk.partial === 'string'], [[['A', 'p3'], ['B', 'p4'], ['D', null]], 'complete', true], 'B\'s failed attempt belongs to its branch and is a recorded stage; the record is complete');
    rig.dispose(); r2.rig.dispose();
  }));

  /* ---- 5. F3: a gate right AFTER the joiner ---- */
  await section('F3: a gate after the joiner', () => allocated(async env => {
    const opts = { floor: F3(), entry: ENTRY, agents: ['A', 'B'] };
    const rig = makeRig(opts).wire(env.host);
    rig.reply = x => x.agentId + ' out';
    const ran = await rig.run({ replies: ['A out'] });
    rig.settle(ran.job, ran.line);
    const id = ran.job.id, c0 = cont(env, id);
    A.ok(ran.line.held && !ran.line.holdFailed, 'a gate after the join is saved: ' + (ran.line.holdFailed || ''));
    A.eq([ran.line.hold.reason, ran.line.hold.gateId, rig.calls, c0.hold.allowed], ['missing_verdict', '12,4', ['B'], ['approve', 'stop']], 'the merged crate carried no verdict: held at the gate after the join (it has no back lane to send work round)');
    const p = c0.walk.product;
    A.eq([p.producer.kind, p.producer.joinId, p.producer.runIds.length, p.producer.runIds[0] === ran.runId, p.text.startsWith('JOINED OUTPUT — 2 of 2 branches delivered')], ['join', '9,4', 2, true, true],
      'the work under review is the JOINER\'s merge, traced to the two runs it came from');
    A.eq([c0.barriers, c0.walk.fan, c0.walk.branchMode, c0.walk.fromTile], [[], null, false, { x: 9, y: 4 }], 'the split is over: no barrier, no branch, the walk resumes from the joiner\'s exit');
    const r2 = restarted(env, opts, x => x.agentId + ' out');
    const out = await decide(r2.owner, id, c0, 'approve', 'tok-1').done, job = getFrom(r2.host, id);
    A.eq([r2.rig.calls.length, job.status, out.delivered, job.continuation.publication.outboxId], [0, 'delivered', true, 'p8'], 'APPROVE bought nothing (the done lane reaches the OUTBOX) and delivered');
    A.ok(job.output === p.text, 'the delivered text is the merged crate the person approved, byte for byte: ' + job.output.slice(0, 80).replace(/\n/g, '|'));
    A.eq([outputs(r2.rig).length, joins(r2.rig).length, r2.rig.shipped.length], [1, 0, 1], 'one OUTBOX delivery; the walk did not join a second time');
    rig.dispose(); r2.rig.dispose();
  }));

  /* ---- 5a. two reviewers in series: the branch's gate holds, a person approves, the join happens, and the MERGED crate's gate holds again ---- */
  await section('a second hold after the join the first decision released', () => allocated(async env => {
    const floor = F2(); floor.props.push({ id: 'p9', t: 'loop', x: 10, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 });   // a gate between the joiner and D
    const { rig, ran, id, opts } = await held(env, floor);
    const c0 = cont(env, id), partOfA = c0.barriers[0].parts[0];
    const r2 = restarted(env, opts);
    const out2 = await decide(r2.owner, id, c0, 'approve', 'tok-1').done, job = getFrom(r2.host, id), c1 = job.continuation;
    A.eq([out2.held, job.status, c1.phase, c1.hold.gateId, c1.hold.reason, r2.rig.calls], [true, 'held', 'held', '10,4', 'missing_verdict', []],
      'APPROVE released the join and the merged crate stopped at the second gate: HELD again, on the same job, nothing bought');
    A.eq([c1.barriers, c1.walk.fan, c1.walk.pending, c1.walk.branchMode, c1.walk.product.producer.kind, c1.walk.product.producer.runIds[0] === ran.runId, c1.walk.product.producer.runIds.length],
      [[], null, [], false, 'join', true, 2], 'the second hold has no split left (the join released it) and holds the merge of the two runs');
    A.ok(c1.walk.product.text.includes(partOfA.product.text) && joins(r2.rig).length === 1, 'the merged crate holds A\'s saved part, and the join happened once');
    A.eq(c1.decisions.map(d => [d.action, d.state]), [['approve', 'complete']], 'the first decision is complete');
    const r3 = restarted(env, opts), w3 = r3.rig.world();
    const out3 = await decide(r3.owner, id, c1, 'approve', 'tok-2').done, done = getFrom(r3.host, id);
    A.eq([r3.rig.calls, done.status, out3.delivered, joins(r3.rig).length, outputs(r3.rig).length, r3.rig.world() !== w3], [['D'], 'delivered', true, 0, 1, true], 'the second APPROVE runs D once on the approved merge: no second join, one delivery');
    A.ok(/JOINED OUTPUT — 2 of 2 branches delivered/.test(r3.rig.seen[0].prompt) && r3.rig.seen[0].prompt.indexOf('A out') < r3.rig.seen[0].prompt.indexOf('B draft'), 'D was handed both branches, A first');
    A.eq(done.continuation.decisions.map(d => d.state), ['complete', 'complete'], 'both decisions are complete');
    rig.dispose(); r2.rig.dispose(); r3.rig.dispose();
  }));

  /* ---- 5b. a gate after a PARALLEL join: a planner, two single-step branches run AT ONCE into the joiner, then the gate ---- */
  await section('a gate after a parallel join', () => allocated(async env => {
    const opts = { floor: parallelFloor(), entry: { agentId: 'P', dockId: 'p0' }, agents: ['P', 'A', 'B'], peek: true };
    const rig = makeRig(opts).wire(env.host);
    rig.reply = x => x.agentId + ' out';
    const ran = await rig.run({ replies: ['the plan'] });
    rig.settle(ran.job, ran.line);
    const id = ran.job.id, c0 = cont(env, id);
    A.ok(ran.line.held && !ran.line.holdFailed, 'a gate after a parallel join is saved: ' + (ran.line.holdFailed || ''));
    A.eq(rig.seen.map(s => [s.agentId, s.dockId]), [['A', 'p3'], ['B', 'p4']], 'the two branches ran (at once, each one step)');
    A.eq([ran.line.hold.gateId, c0.walk.product.producer.kind, c0.walk.product.producer.joinId, c0.walk.product.producer.runIds.length, c0.barriers, c0.walk.fan, c0.walk.pending],
      ['16,4', 'join', '13,4', 2, [], null, []], 'held at the gate; the crate under review is the join of the two runs; no barrier, no branch and nothing queued is left to save');
    A.eq(c0.attempts.map(a => [a.node.agentId, a.branchId]), [['P', null], ['A', 'p3'], ['B', 'p4']], 'each branch\'s stage is tied to its branch');
    const r2 = restarted(env, opts, x => x.agentId + ' out');
    const out = await decide(r2.owner, id, c0, 'approve', 'tok-1').done, job = getFrom(r2.host, id);
    A.eq([r2.rig.calls.length, job.status, out.delivered, job.output === c0.walk.product.text, joins(r2.rig).length, outputs(r2.rig).length], [0, 'delivered', true, true, 0, 1],
      'APPROVE delivers the merged crate once, buying nothing, joining nothing again');
    rig.dispose(); r2.rig.dispose();
  }));

  /* ---- 6. what cannot be saved exactly ends the old way, the reason said — never half-saved ---- */
  await section('the builder refuses what it cannot save', () => allocated(async env => {
    const { rig, ran, id } = await held(env, F2());
    const rec = get(env, id), line = ran.line, st = line.holdState;
    const host = { planHash: rig.plan.hash, receiptFor: rig.ports.holdFileReceipt }, seed = { runId: ran.runId, entryTrusted: true, hostPowerKept: true, taints: [] };
    const origin = rig.ports.holdOriginOf(rec, rig.facts.channel);
    const build = mut => { const l = Object.assign({}, line, { holdState: JSON.parse(JSON.stringify(st)) }); Object.defineProperty(l, 'hold', { value: line.hold }); mut(l.holdState); return LineHold.buildHeld(seed, l, rec, origin, host); };
    A.eq(JSON.stringify(LineHold.buildHeld(seed, line, rec, origin, host).continuation), JSON.stringify(rec.continuation), 'the pure builder is deterministic: the same walk builds the very split that was saved');
    const refused = [
      ['the walk says why it cannot be rebuilt', s2 => { s2.open.refuse = 'a branch of the split ended apart from its joiner, so the split cannot be rebuilt exactly'; }, /ended apart from its joiner/],
      ['a batch of branches still out', s2 => { s2.barriers[0].inFlight = ['p4']; }, /still out/],
      ['a part made by a run nobody recorded', s2 => { s2.barriers[0].parts[0].runId = 'run-nobody-knows'; }, /exact observed branch run/],
      ['a part that names a branch the split does not have', s2 => { s2.barriers[0].parts[0].branchId = 'p9'; }, /incomplete or contains unsupported fields|does not say which of its branches/],
      ['a split too wide for one record (600 branches, past the validator\'s 512 parts)', s2 => {
        // 600 branches: one parked, 598 failed, one still owing — the split is exact, only too wide to be one record
        const ids = Array.from({ length: 600 }, (_, i2) => 'br' + i2), failed = ids.slice(1, 599);
        s2.walk.fan.branchIds = ids; s2.walk.fan.width = 600; s2.walk.fan.failed = failed.map(id => ({ branchId: id, why: 'failed' }));
        s2.barriers[0].branchIds = ids.slice(); s2.barriers[0].failed = failed; s2.barriers[0].pending = ['br599']; s2.barriers[0].parts[0].branchId = 'br0';
      }, /incomplete or contains unsupported fields|exceeds its bound/],
      ['a barrier saved without the split it belongs to', s2 => { s2.walk.fan = null; }, /no split to account for/],
      ['a split that does not say which branch the walk is in', s2 => { s2.barriers[0].parts.length = 0; s2.barriers[0].pending = ['p3', 'p4']; }, /does not say which of its branches/]
    ];
    for (const [label, mut, why] of refused) { const r = build(mut); A.ok(r.ok === false && why.test(r.reason), label + ': refused in words, never thrown: ' + r.reason); }
    rig.dispose();
  }));
  await section('a split the station will not vouch for', () => allocated(async env => {   // a split whose hold the station will not vouch for ends the old terminal blocked stop, the reason said
    const rig = makeRig({ floor: F2(), entry: ENTRY, agents: CREW }).wire(env.host);
    rig.reply = x => REPLIES[x.agentId];
    rig.beforeCall = () => { rig.halted = true; };   // E-STOP is pressed while B's stage is out
    const ran = await rig.run({ replies: ['A out'] }), res = rig.settle(ran.job, ran.line), rec = get(env, ran.job.id);
    A.ok(!ran.line.held && /E-STOP is engaged/.test(ran.line.holdFailed || ''), 'E-STOP at the gate: the hold is refused in words: ' + ran.line.holdFailed);
    A.eq([rec.status, rec.continuation === undefined, rec.endedAt !== null, rig.counts.finish, rig.counts.hold, res.delivered], ['problem', true, true, 1, 0, false], 'it ended the old terminal blocked stop, finished once, nothing was written');
    A.eq([joins(rig).length, outputs(rig).length, rig.shipped.length, rig.chain._barrier.size()], [0, 0, 0, 0], 'nothing joined, nothing delivered, and the sibling\'s part does not sit in memory for a join that cannot come');
    rig.dispose();
  }));

  /* ---- 7. THE CHAIN ON ITS OWN: a hand-written fan of three (agent-keyed), its state, and a new chain that carries it on ---- */
  const SPLIT = '3,0', JOIN = '5,5';
  const fanChain = (gateOn, store) => {
    let n = 0, id = 0;
    const steps = (a, ctx) => {
      if (ctx.fromTile) return { agentId: 'D' };
      if (a === 'P') return { branches: ['A', 'B', 'C'], split: SPLIT, divide: true };
      if (a === gateOn) return { loop: '8,2', max: 2, backTo: a, when: 'approved', next: null, afterJoin: { join: JOIN, expect: 3, timeoutMin: 7, next: 'D' } };
      if (a === 'A' || a === 'B' || a === 'C') return { join: JOIN, expect: 3, timeoutMin: 7, next: 'D' };
      return null;
    };
    const timers = [], runs = [], texts = {};
    const chain = makeChainRunner(Object.assign({ nextAgent: () => null, stepAgent: steps, fanSiblings: () => [], now: () => (n += 10), newId: () => 'w' + (++id), setTimer: (fn, ms) => { timers.push(ms); return 0; } },
      store ? { barrierStore: store } : null));
    const agent = reply => async h => { runs.push(h.agentId); texts[h.agentId] = h.text; return Object.assign({ usd: 0.01, runId: 'r-' + h.agentId + '-' + runs.length }, reply(h)); };
    return { chain, timers, runs, texts, agent, at: k => { id = k; } };
  };
  const PLAN = 'plan:\nPART 1: write the intro\nPART 2: write the middle\nPART 3: write the end';
  const jobRec = { id: 'job-aaaaaaaa1', line: 'L1', intakeId: null, streamId: 's1', entry: 'sample' };
  const buildFrom = res => LineHold.buildHeld({ runId: 'run1', entryTrusted: true, hostPowerKept: true, taints: [] }, res, jobRec, { kind: 'sample' }, { planHash: 'abcdef12', receiptFor: () => { throw new Error('no files'); } });
  const resumeSeed = (c, decision, over) => ({ agentId: c.walk.current.agentId, text: c.walk.product.text, originalText: c.walk.originalText, runId: c.binding.entryRunId, entryUsd: c.accounting.entryUsd + c.accounting.hopUsd,
    lineId: c.binding.lineId, resume: Object.assign({ walk: c.walk, files: c.files, accounting: c.accounting, dockMode: false, barriers: c.barriers, attempts: c.attempts, entryNode: c.binding.entryNode, decision }, over) });
  await section('chain: the last branch held', async () => {   // 7a. the gate holds the LAST branch: A parked, B failed, C stopped
    const store = { saves: [], load: () => null, save: v => store.saves.push(JSON.stringify(v)) };
    const one = fanChain('C', store);
    const res = await one.chain.advance({ agentId: 'P', text: PLAN, originalText: 'write three parts', lineId: 'L1', runId: 'run1', entryUsd: 0.02,
      runAgent: one.agent(h => h.agentId === 'B' ? { error: 'B went wrong' } : { text: h.agentId + ' out' }) });
    A.ok(res.hold && res.hold.reason === 'missing_verdict' && res.hold.gateId === '8,2' && res.holdState, 'the divided job: branch C stopped at its gate: ' + JSON.stringify(res.hold));
    A.eq(one.runs, ['A', 'B', 'C'], 'A ran and parked, B failed, C reached the gate');
    const st = res.holdState;
    A.eq(st.open.refuse || null, null, 'the walk can say all of it');
    A.eq(st.walk.fan.branchIds, ['A', 'B', 'C'], 'the split\'s branches, by the node each started at');
    A.eq(st.walk.fan.failed.map(f => f.branchId), ['B'], 'B is the branch that failed (and sent nothing)');
    A.ok(/B failed/.test(st.walk.fan.failed[0].why), 'with the words it failed in: ' + st.walk.fan.failed[0].why);
    A.eq([st.walk.pending, st.walk.branchMode, st.walk.fan.joinKey, st.walk.fan.joinStep.expect, st.walk.fan.joinStep.timeoutMin], [[], true, JOIN + '|run1', 3, 7], 'no branch left to start; the barrier\'s key and the joiner\'s count and timeout are carried');
    A.eq(st.barriers.map(b => [b.joinId, b.branchIds, b.failed, b.pending, b.inFlight, b.timeoutMs, b.parts.map(p => [p.branchId, p.runId, p.product.text])]),
      [[JOIN, ['A', 'B', 'C'], ['B'], ['C'], [], 7 * 60000, [['A', 'r-A-1', 'A out']]]], 'the barrier: A\'s part with its branch and run, B failed, C owed, the joiner\'s 7 minutes');
    A.eq([one.chain._barrier.size(), store.saves[store.saves.length - 1]], [0, '{}'], 'the hold took the barrier out of memory and out of the barrier file (a restart reports nothing "lost")');
    const built = buildFrom(res);
    A.ok(built.ok, 'the validator accepts the three-branch split: ' + (built.reason || ''));
    const c = built.continuation;
    A.eq([c.barriers.length, c.walk.fan.width, c.walk.fan.failed.length, c.attempts.map(a => [a.node.agentId, a.branchId])], [1, 3, 1, [['P', null], ['A', 'A'], ['B', 'B'], ['C', 'C']]], 'it is a continuation: three branches, one failed, every stage tied to its branch');
    // a NEW chain (nothing in memory) carries the person's word on from the saved state
    const two = fanChain('C'); two.at(50);
    const fin = await two.chain.advance(Object.assign(resumeSeed(c, { action: 'approve', note: '' }), { runAgent: two.agent(h => ({ text: h.agentId + ' final' })) }));
    A.eq(two.runs, ['D'], 'APPROVE: only the stage past the joiner ran — A did not run again, B was not retried, C did not run again');
    A.ok(fin.stopped === null && fin.text === 'D final', 'the job ran to its end');
    A.ok(/B failed/.test(fin.partial || '') && /=== PARTIAL: 1 branch failed and sent nothing \(B failed/.test(two.texts.D) && /JOINED OUTPUT — 2 of 3 branches delivered/.test(two.texts.D), 'the failed sibling is named as missing, as it always was: ' + fin.partial);
    A.ok(two.texts.D.indexOf('A out') >= 0 && two.texts.D.indexOf('A out') < two.texts.D.indexOf('C out'), 'A\'s saved part first, then C\'s approved work');
    A.eq([two.chain._barrier.size(), two.timers.length], [0, 0], 'the barrier was released and cleared; no timer was armed');
    // a barrier already open for that join is never opened a second time, and its parts are never delivered twice
    const three = fanChain('C'); three.at(70);
    three.chain._barrier.deliver(JOIN + '|run1', 3, 'X', 'a stray part', 7);
    const refusal = await three.chain.advance(Object.assign(resumeSeed(c, { action: 'approve', note: '' }), { runAgent: three.agent(h => ({ text: h.agentId + ' final' })) }));
    A.ok(refusal.stop && refusal.stop.code === 'station_fault' && /already open/.test(refusal.stopped) && three.runs.length === 0, 'a barrier already open for that join: the resumed walk stops and says so, nothing ran: ' + refusal.stopped);
    A.eq(three.chain._barrier.release(JOIN + '|run1').parts.map(p => p.text), ['a stray part'], 'and the open barrier was left exactly as it was (no part delivered into it, none removed)');
    // a resumed walk stopped before the join (a STOP between the decision and its first stage) leaves nothing parked in memory or in the barrier file
    const storeSix = { saves: [], load: () => null, save: v => storeSix.saves.push(JSON.stringify(v)) };
    const six = fanChain('C', storeSix); six.at(110);
    const ac = new AbortController(); ac.abort();
    const halted = await six.chain.advance(Object.assign(resumeSeed(c, { action: 'approve', note: '' }), { signal: ac.signal, runAgent: six.agent(h => ({ text: h.agentId + ' final' })) }));
    A.ok(halted.stop && halted.stop.code === 'stopped' && six.runs.length === 0, 'a STOP before the first stage: the walk stops, nothing is bought');
    A.eq([six.chain._barrier.size(), storeSix.saves.length, storeSix.saves[storeSix.saves.length - 1]], [0, 2, '{}'], 'the barrier it had put back is gone again, from memory and from the barrier file (put back, then taken out)');
    // the restore of a record whose split cannot say which branch the walk was in does not guess
    const bad = JSON.parse(JSON.stringify(c)); bad.walk.fan.failed = [];
    const five = fanChain('C'); five.at(90);
    const broken = await five.chain.advance(Object.assign(resumeSeed(bad, { action: 'approve', note: '' }), { runAgent: five.agent(() => ({ text: 'x' })) }));
    A.ok(broken.stop && broken.stop.code === 'station_fault' && /which of its branches/.test(broken.stopped) && five.runs.length === 0 && five.chain._barrier.size() === 0, 'an inconsistent saved split is not guessed at: nothing ran, nothing was rebuilt: ' + broken.stopped);
  });
  await section('chain: the first branch held', async () => {   // 7b. the gate holds the FIRST branch: B and C are queued, each with its own part of the divided job
    const one = fanChain('A');
    const res = await one.chain.advance({ agentId: 'P', text: PLAN, originalText: 'write three parts', lineId: 'L1', runId: 'run1', entryUsd: 0.02, runAgent: one.agent(h => ({ text: h.agentId + ' out' })) });
    A.ok(res.hold && res.hold.gateId === '8,2' && one.runs.join() === 'A', 'A (the first branch) stopped at its gate; B and C have not started');
    const built = buildFrom(res);
    A.ok(built.ok, 'saved: ' + (built.reason || ''));
    const c = built.continuation;
    A.eq(c.walk.pending.map(b => [b.id, b.entry, b.part && [b.part.i, b.part.k], b.from, b.product.producer.runId]), [['B', false, [1, 3], { agentId: 'P', dockId: null }, 'run1'], ['C', false, [2, 3], { agentId: 'P', dockId: null }, 'run1']],
      'B and C are queued with the part of the job each was handed (2 of 3 and 3 of 3), the stage whose work they come from, and that stage\'s run');
    A.eq([c.walk.fan.joinKey, c.walk.fan.joinStep, c.barriers, c.walk.branchMode, c.walk.fan.handed], [null, null, [], false, PLAN], 'no part is parked yet; the branches were handed the planner\'s plan');
    const two = fanChain('A'); two.at(50);
    const fin = await two.chain.advance(Object.assign(resumeSeed(c, { action: 'approve', note: '' }), { runAgent: two.agent(h => ({ text: h.agentId + ' final' })) }));
    A.eq(two.runs, ['B', 'C', 'D'], 'APPROVE: the two queued branches ran once each, in order, then the stage past the joiner');
    A.ok(/write the middle/.test(two.texts.B) && !/write the end/.test(two.texts.B) && /write the end/.test(two.texts.C) && !/write the middle/.test(two.texts.C), 'each queued branch was handed ITS part of the job, and only that');
    A.ok(fin.stopped === null && fin.text === 'D final' && /JOINED OUTPUT — 3 of 3 branches delivered/.test(two.texts.D) && !fin.partial, 'all three branches reached the joiner: A\'s approved work and the two that ran after');
    A.eq([two.chain._barrier.size(), two.timers.length], [0, 0], 'nothing left at the barrier, no timer');
  });
  await section('chain: a branch that ended apart from its joiner', async () => {   // 7c. branch A ends at an OUTBOX of its own; branch B's gate holds
    const timers = [];
    const chain = makeChainRunner({ nextAgent: () => null, fanSiblings: () => ['B'], now: () => 5, newId: (() => { let i = 0; return () => 'w' + (++i); })(), setTimer: (fn, ms) => { timers.push(ms); return 0; },
      stepAgent: (a, ctx) => (a === 'B' ? { loop: '8,2', max: 2, backTo: 'B', when: 'approved', next: null, afterJoin: { join: JOIN, expect: 2, timeoutMin: 7, next: 'D' } } : null) });
    const res = await chain.advance({ agentId: 'A', text: 'A out', originalText: 'two lanes', lineId: 'L1', runId: 'run1', entryUsd: 0.02, runAgent: async h => ({ text: h.agentId + ' out', usd: 0.01, runId: 'r-' + h.agentId }) });
    A.ok(res.hold && res.hold.reason === 'missing_verdict' && res.holdState, 'branch B stopped at its gate after branch A ended at an OUTBOX of its own');
    A.ok(/ended apart from its joiner/.test(res.holdState.open.refuse || ''), 'the walk says in words it cannot save that split exactly: ' + res.holdState.open.refuse);
    const built = buildFrom(res);
    A.ok(built.ok === false && /ended apart from its joiner/.test(built.reason), 'so the job is not held half-saved; the saver refuses with those words: ' + built.reason);
  });
  A.report('line-hold.split');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.split'); });
