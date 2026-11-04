/* node test/line-hold.matrix.test.js — THE GH#122 MATRIX, DURABLE (line-hold lane, S3).

   THE CLASS (invariants gh122-matrix-holds-durably, held-job-never-spends, no-held-row-reads-as-delivered). A reviewer that answers
   VERDICT: BLOCKED (or gives no usable verdict) used to END its job: a terminal 'problem' record, no saved walk, nothing for anyone to
   decide about — and gone for good after a restart. The walk now PARKS: it is saved as a version 1 held continuation on its own LineJob,
   the job is 'held' (not finished, not delivered, endedAt null), and a restart finds it as it was left.

   Proven here through the REAL router, chain runner, LineRunner and LineJobs (every write goes through a JSON round trip and normalizeAll,
   like the host's store), with the STATION'S OWN hold proofs compiled out of sidecar/index.js (test/helpers/line-hold-rig.js):
     1. BLOCKED  x  {plain, UPPER, markdown, trailing line, quoted tail}  x  passes {0, 1, 5}: held, valid, zero hops after it, no
        line-output, no SHIPPED callback, no SEND TO, not delivered, ONE settle result and no durable finish;
     2. from the hold until a decision: provider calls, day-ledger notes, run rows, OUTBOX crates and finishes do not move across reload,
        boot, repeated reads and a fresh runner;
     3. every entry door names its origin (channel, schedule, manual, trigger webhook/folder, SEND TO, sample); a door that cannot, and the
        step-through test, end the OLD way with the reason said;
     4. the other two reasons (missing_verdict, spent), file receipts (exact digest and size), a file handed in from another job;
     5. everything that cannot be saved exactly ends the old way, never half-saved: no hold port, an oversized crate, an unreadable file,
        a floor edited while the job was out, E-STOP, and a full queue of jobs waiting for a decision. (A gate INSIDE a split or right
        after a join is not one of them any more: it is saved with its split, S5 — checked here through the real chain, and with a
        restart and the decisions in test/line-hold.split.test.js);
     6. retention and boot keep a held job; the store's readers never see it as delivered.
   Run against the S2 tip's chain.js / line-runner.js / linejobs.js / line-fire.js this goes RED at section 1: the job ends 'problem', with
   no continuation, and is still 'problem' after the restart. */
'use strict';
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const A = require('./_assert.js');
const C = require('../sidecar/routing/line-continuation.js');
const J = require('../sidecar/routing/linejobs.js');
const LineFire = require('../sidecar/routing/line-fire.js');
const LineHold = require('../sidecar/routing/line-hold.js');
const Verdict = require('../sidecar/routing/verdict.js');
const P = require('../frontend/app/pipeline.js');
const { makeRig, geometry, WIRINGS, FORMS, REVISE } = require('./helpers/line-hold-rig.js');   // (the reply forms are the rig's: the real-sidecar test reads the same table)

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// what a held job must look like, wherever it stopped. Returns the saved continuation.
function assertHeld(rig, ran, o, label) {
  const rec = rig.record(ran.job.id), seen = C.inspect(rec.continuation, rec), c = seen.value;
  A.ok(seen.ok, label + ': the saved hold is a valid version 1 continuation: ' + (seen.issue && seen.issue.message));
  if (!seen.ok) return null;
  A.eq([rec.status, rec.outcome, rec.endedAt, rec.stop && rec.stop.code], ['held', 'blocked', null, 'blocked'], label + ': the job is HELD, not finished');
  A.eq([c.version, c.revision, c.phase, c.activeDecision, c.terminal, c.publication, c.decisions.length], [1, 1, 'held', null, null, null, 0], label + ': first revision, no decision, no result');
  A.eq([c.hold.reason, c.hold.gateId, c.hold.pass], [o.reason || 'blocked', '12,4', o.pass], label + ': held at the gate, on the pass it stopped on');
  A.eq(c.hold.allowed, o.allowed || ['approve', 'send_back', 'stop'], label + ': what a person may decide');
  A.eq(rig.calls.length, o.hops, label + ': zero hops follow the hold (' + rig.calls.length + ' paid, ' + o.hops + ' before it)');
  A.eq(c.attempts.length, 1 + o.hops, label + ': the entry attempt plus one observed attempt per hop');
  A.ok(c.attempts.every(a => a.state === 'observed') && c.accounting.runIds.length === c.attempts.length, label + ': every attempt is an observed receipt');
  A.eq(c.accounting.dayReceipts, [], label + ': the day ledger counted the spend already, so the hold notes nothing again');
  A.eq(rig.notes.length, 1 + o.hops, label + ': the legacy day ledger heard of the entry and each hop, once');
  A.ok(Math.abs(c.accounting.entryUsd - 0.02) < 1e-9 && Math.abs(c.accounting.hopUsd - 0.01 * o.hops) < 1e-9 && Math.abs(rec.usd - (0.02 + 0.01 * o.hops)) < 1e-9, label + ': the saved spend is what was paid (' + rec.usd + ')');
  A.eq([c.accounting.limits.maxHops, c.accounting.limits.maxUsd], [6, 2], label + ': the original ceilings');
  A.eq([c.walk.current, c.walk.next.kind, c.walk.next.gateId], [{ agentId: 'reviewer', dockId: 'p3' }, 'gate', '12,4'], label + ': the cursor is the gate');
  A.eq([c.walk.product.text, c.walk.product.verdict], [o.reply, 'verdict' in o ? o.verdict : 'blocked'], label + ': the reviewer\'s word is kept whole');
  A.eq(c.walk.lastHanded, o.draft, label + ': the draft under review is kept');
  A.eq(c.walk.gates, [{ id: '12,4', count: o.pass, max: o.max || 6 }], label + ': the gate and its pass count');
  A.eq([c.restriction.entryUntrusted, c.restriction.hostPowerWithheld, c.restriction.taints], [false, false, []], label + ': the entry\'s restriction rides along');
  A.eq(c.binding.planHash, rig.plan.hash, label + ': bound to the floor plan the walk ran on');
  return c;
}

(async () => {
  /* ---- 1. THE MATRIX: BLOCKED x forms x passes ---- */
  let cases = 0;
  for (const [form, reply] of FORMS) for (const k of [0, 1, 5]) {
    const rig = makeRig(), label = form + ' / pass ' + k;
    const ran = await rig.run({ replies: [...Array(k).fill(REVISE), reply] });
    cases++;
    A.eq([!!ran.line.hold, ran.line.hold && ran.line.hold.reason, ran.line.hold && ran.line.hold.pass], [true, 'blocked', k], label + ': the walk stopped at the gate as a hold');
    A.ok(ran.line.held && ran.line.held.jobId === ran.job.id && !ran.line.holdFailed, label + ': the hold was saved (line.held), not refused');
    const c = assertHeld(rig, ran, { pass: k, hops: 2 * k, reply, draft: k ? 'another draft' : 'write a post' }, label);
    A.eq([rig.events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output').length, rig.shipped.length, rig.counts.finish], [0, 0, 0], label + ': no line-output, no SHIPPED / SEND TO callback, no durable finish');
    // the entry settles the job: one result, not delivered, nothing finished, nothing released
    const res = rig.settle(ran.job, ran.line);
    A.eq([res.held, res.delivered, res.status, res.outcome, res.stop && res.stop.code, res.outboxId, res.unapproved], [true, false, 'held', 'blocked', 'blocked', null, ''], label + ': settle says HELD and NOT DELIVERED');
    A.ok(rig.settle(ran.job, ran.line, { stopped: true }) === res && rig.counts.finish === 0, label + ': a second settle is the same result and finishes nothing');
    A.ok(!rig.runner.deliverCrate(res, { workitemId: 'w1' }) && rig.runner.get(ran.job.id) === null, label + ': no OUTBOX crate, and the live handle is forgotten');
    A.ok(/paused/.test(rig.runner.stopNote(ran.line)) && rig.runner.stopNote(ran.line).includes(ran.job.id) && /WORKFLOWS/.test(rig.runner.stopNote(ran.line)), label + ': the reader is told the job is held and where to decide');
    // 2. HELD-JOB-NEVER-SPENDS: nothing moves across reload, boot, repeated reads and a fresh runner
    const world = rig.world(), saved = JSON.stringify(rig.record(ran.job.id));
    rig.reload(); rig.boot(); rig.reload(); rig.boot();
    for (let i = 0; i < 3; i++) { J.list(rig.state(), {}); J.get(rig.state(), ran.job.id); J.byStream(rig.state(), ran.streamId); J.latest(rig.state(), rig.lineId); }
    rig.runner.reap([]);
    A.eq(rig.world(), world, label + ': provider calls, ledger notes, run rows, crates and finishes did not move');
    A.eq(JSON.stringify(rig.record(ran.job.id)), saved, label + ': after a restart the job id, revision, draft, cursor and taint are byte for byte the saved ones');
    const after = rig.record(ran.job.id);
    A.eq([after.status, after.endedAt, after.outcome], ['held', null, 'blocked'], label + ': boot did not interrupt, finish or reopen it');
    A.eq(JSON.stringify(c), JSON.stringify(after.continuation), label + ': the continuation is the one that was built');
    rig.dispose();
  }
  A.eq(cases, 15, 'the matrix really is 5 forms x 3 passes');

  /* ---- 3. EVERY ENTRY DOOR names its origin ---- */
  const DOORS = [['channel', 'channel'], ['schedule', 'schedule'], ['manual', 'manual'], ['trigger', 'trigger'], ['folder', 'trigger'], ['sendto', 'sendto'], ['sample', 'sample']];
  const policyDigests = {};
  for (const [name, entry] of DOORS) {
    const rig = makeRig(), label = name + ' door';
    const ran = await rig.run({ entry, origin: typeof rig.facts[name] === 'function' ? rig.facts[name]('run-entry-1') : rig.facts[name], replies: ['no\nVERDICT: blocked'] });
    const c = assertHeld(rig, ran, { pass: 0, hops: 0, reply: 'no\nVERDICT: blocked', draft: 'write a post' }, label);
    A.eq(c && c.origin.kind, entry, label + ': the saved origin is the door the job came in by');
    if (name === 'folder') {
      A.eq(c.origin.sourceDigest, sha('a new file landed'), label + ': a folder file is kept as its digest');
      A.ok(!JSON.stringify(rig.record(ran.job.id)).includes('a new file landed'), label + ': never as its text');
    }
    if (name === 'schedule' || name === 'manual') policyDigests[name] = c.origin.policyDigest;
    if (name === 'channel') A.eq(c.origin, { kind: 'channel', instanceId: 'telegram', chatId: 'chat-1', senderId: 'user-1', chatType: 'dm', threadId: null, boundAgentId: null }, label + ': the chat, sender and thread');
    if (name === 'sendto') A.eq([c.origin.sourceJobId, c.origin.depth, c.origin.lineage], ['job-aaaaaaaaaaaa', 1, ['L1', 'L2']], label + ': the job it came from and its lineage');
    rig.settle(ran.job, ran.line);
    A.eq(rig.counts.finish, 0, label + ': settled without a finish');
    rig.dispose();
  }
  {   // the routine's configuration is kept as a digest: the same configuration is the same digest on both cron seams, another is another
    const rig = makeRig(), other = Object.assign({}, rig.facts.schedule('run-entry-1'), { policy: { preloadSkills: ['skill-a'], requiredPreloads: true, workdir: '/elsewhere', enabledToolsets: null } });
    const ran = await rig.run({ entry: 'schedule', origin: other, replies: ['no\nVERDICT: blocked'] });
    const c = rig.record(ran.job.id).continuation;
    A.ok(/^[a-f0-9]{64}$/.test(policyDigests.schedule) && policyDigests.schedule === policyDigests.manual && c.origin.policyDigest !== policyDigests.schedule, 'a routine\'s policy: one digest for one configuration (schedule = Run Now), another for another');
    A.ok(!JSON.stringify(rig.record(ran.job.id)).includes('/elsewhere'), 'the routine\'s configuration is never kept as itself');
    rig.dispose();
  }
  // a door that cannot name its origin, and the step-through test, end the OLD way — never half-saved — and say why
  const factsRig = makeRig();   // only for the facts it names (the doors' sample facts); nothing runs on it
  const UNNAMED = [['step-through test', 'steptest', {}], ['a chat message with no sender', 'channel', Object.assign({}, factsRig.facts.channel, { senderId: '' })],
    ['a webhook with no delivery receipt', 'trigger', { triggerId: 'trg_demo12345', triggerKind: 'webhook' }], ['a SEND TO with no source job', 'sendto', Object.assign({}, factsRig.facts.sendto, { sourceJobId: null })]];
  factsRig.dispose();
  for (const [label, entry, origin] of UNNAMED) {
    const rig = makeRig();
    const ran = await rig.run({ entry, origin });
    const res = rig.settle(ran.job, ran.line), rec = rig.record(ran.job.id);
    A.ok(!ran.line.held && /could not be saved as a hold/.test(ran.line.holdFailed || ''), label + ': refused, and says so: ' + ran.line.holdFailed);
    A.eq([rec.status, rec.outcome, rec.continuation === undefined, rec.endedAt !== null, rig.counts.finish, rig.counts.hold], ['problem', 'blocked', true, true, 1, 0], label + ': ended the old way, finished once, nothing written');
    A.ok(res.held === undefined && res.delivered === false && /answered VERDICT: blocked/.test(res.stop.why) && /could not be saved as a hold/.test(res.stop.why), label + ': the stop keeps its blocked words and adds why: ' + res.stop.why);
    rig.dispose();
  }

  {   /* the facts each door REALLY hands over. The expressions the cron seams, the trigger runner and the SEND TO runner pass as `origin` are lifted
         out of sidecar source (test/helpers/source.js) and evaluated, and the station's own mapping must name an origin from them — a typo in a
         door (a missing routine id) would otherwise turn every hold at that door into the old stop, silently. */
    const Source = require('./helpers/source.js'), index = Source.readSidecarIndex(), rig = makeRig(), hex = c => c.repeat(64);
    const lift = (region, label) => { const expr = Source.liftProp(region, 'origin'); A.ok(expr.length > 20, label + ': the door passes its origin facts'); return expr; };
    const run = (expr, scope) => new Function(...Object.keys(scope), 'return (' + expr + ');')(...Object.values(scope));
    const scheduled = lift(Source.callRegion(index, 'advanceChain: (o) => lineRunner.runLineJob({', 'profile: LineRunner.profiles.schedule({'), 'the scheduled fire');
    const pressed = lift(Source.callRegion(index, 'const line = await lineRunner.runLineJob({ job: (cronItems.get(runId) || {}).job, seed: {', 'profile: LineRunner.profiles.manual({'), 'Run Now');
    const a = rig.ports.holdOriginOf({ id: 'job-x', entry: 'schedule' }, run(scheduled, { o: { jobId: 'cron_demo', runId: 'run-1', preloadSkills: ['skill-a'], requiredPreloads: true, workdir: null, enabledToolsets: null } }));
    const b = rig.ports.holdOriginOf({ id: 'job-x', entry: 'manual' }, run(pressed, { job: { id: 'cron_demo', skills: ['skill-a'], workdir: null, enabledToolsets: null }, runId: 'run-1' }));
    A.ok(a && b && a.kind === 'schedule' && b.kind === 'manual' && a.routineId === 'cron_demo' && a.fireRunId === 'run-1' && b.fireRunId === 'run-1' && /^[a-f0-9]{64}$/.test(a.policyDigest) && a.policyDigest === b.policyDigest,
      'the scheduled fire and Run Now name the same routine, fire and configuration digest: ' + JSON.stringify([a, b]));
    const trigger = lift(Source.sidecarFunctionSource('makeTriggerRunner'), 'the trigger runner');
    const hook = rig.ports.holdOriginOf({ id: 'job-x', entry: 'trigger' }, run(trigger, { t: { id: 'trg_demo12345', kind: 'webhook' }, item: { text: 'payload', delivery: { reservationId: hex('c'), fingerprint: hex('d') } } }));
    const folder = rig.ports.holdOriginOf({ id: 'job-x', entry: 'trigger' }, run(trigger, { t: { id: 'trg_demo12345', kind: 'folder' }, item: { text: 'a new file landed' } }));
    A.eq([hook && hook.triggerKind, hook && hook.reservationId, folder && folder.triggerKind, folder && folder.sourceDigest], ['webhook', hex('c'), 'folder', sha('a new file landed')], 'the trigger runner names a webhook by its delivery receipt and a folder file by its digest');
    const handoff = lift(Source.sidecarFunctionSource('makeHandoffRunner'), 'the SEND TO runner');
    const sent = rig.ports.holdOriginOf({ id: 'job-x', entry: 'sendto' }, run(handoff, { item: { fromJobId: 'job-aaaaaaaaaaaa', fromLine: 'L1', fromOutbox: 'o1', toIntake: 'i1', lines: ['L1'], toLine: 'L2', depth: 1 } }));
    A.eq(sent && [sent.sourceJobId, sent.sourceLineId, sent.sourceOutboxId, sent.targetIntakeId, sent.lineage, sent.depth], ['job-aaaaaaaaaaaa', 'L1', 'o1', 'i1', ['L1', 'L2'], 1], 'the SEND TO runner names the job it came from, its outbox, the target inbox and the lineage');
    rig.dispose();
  }

  /* ---- 4. the other reasons, file receipts, a file handed in ---- */
  {
    const rig = makeRig(), ran = await rig.run({ replies: ['looks fine to me, ship it'] });
    assertHeld(rig, ran, { pass: 0, hops: 0, reason: 'missing_verdict', reply: 'looks fine to me, ship it', draft: 'write a post', verdict: null }, 'a silent reviewer');
    rig.dispose();
  }
  {
    const rig = makeRig({ gate: { onSpent: 'hold', maxIter: 1 } }), ran = await rig.run({ replies: [REVISE, REVISE] });
    assertHeld(rig, ran, { pass: 1, hops: 2, reason: 'spent', reply: REVISE, draft: 'another draft', verdict: 'revise', max: 1, allowed: ['approve', 'stop'] }, 'a spent gate that holds');
    rig.dispose();
  }
  {
    const rig = makeRig({ files: true }), ran = await rig.run({ replies: [REVISE, 'no\nVERDICT: blocked'] });
    const c = assertHeld(rig, ran, { pass: 1, hops: 2, reply: 'no\nVERDICT: blocked', draft: 'another draft' }, 'files');
    const drafter = c.attempts.find(a => a.node.agentId === 'drafter'), f = c.files[0];
    A.eq(c.files.length, 1, 'files: the one file the work carries has a receipt');
    const body = 'the file ' + drafter.runId;
    A.eq([f.producerRunId, f.digest, f.size, f.path, f.ref === C.fileRef(f)], [drafter.runId, sha(body), Buffer.byteLength(body), path.join(rig.dir, 'draft-' + drafter.runId + '.md'), true], 'files: exact producer, digest, size and path');
    fs.writeFileSync(f.path, 'changed after the hold');
    rig.reload();
    A.eq(rig.record(ran.job.id).continuation.files[0].digest, sha(body), 'files: the receipt keeps the digest of what was held, whatever the file becomes');
    rig.dispose();
  }
  {
    const rig = makeRig(), handed = rig.dir + '/handed-in.md';
    fs.writeFileSync(handed, 'from the sending job');
    const ran = await rig.run({ entry: 'sendto', replies: ['no\nVERDICT: blocked'], seed: { handoffReads: [handed] } });
    const c = assertHeld(rig, ran, { pass: 0, hops: 0, reply: 'no\nVERDICT: blocked', draft: 'write a post' }, 'a file handed in');
    A.eq(c && c.files.map(f => [f.path, f.producerRunId, f.digest]), [[handed, ran.runId, sha('from the sending job')]], 'a file handed in rides on the entry run\'s receipt, with its exact digest');
    rig.dispose();
  }

  /* ---- 4b. THE NO-VERDICT FAMILY, DURABLE (invariant no-verdict-holds-with-zero-spend: S2 held it in process, S3 holds it on the job) ----
     verdict-keyed gate (approved | revise) x reply (missing, malformed, empty) x pass x lane wiring: held with reason missing_verdict at any
     pass, zero paid hops after it, nothing delivered, nothing finished — saved, not just stopped */
  {
    const SILENT = [['missing', 'looks fine to me, ship it'], ['malformed', 'hmm\nVERDICT: maybe'], ['empty', '']];
    let family = 0;
    for (const wiring of WIRINGS) for (const when of ['approved', 'revise']) for (const [kind, reply] of SILENT) for (const k of [0, 1, 5]) {
      if (kind === 'empty' && k > 0) continue;   // an empty reply from a HOP is a failed stage (stage_empty), not a verdict question
      const word = when === 'approved' ? 'revise' : 'approved';   // the verdict that sends the work round this gate
      const rig = makeRig({ gate: { when, maxIter: 6 }, wiring }), label = [wiring, when + ' gate', kind + ' reply', 'after ' + k + ' pass' + (k === 1 ? '' : 'es')].join(' / ');
      const ran = await rig.run({ replies: [...Array(k).fill('not yet\nVERDICT: ' + word), reply] });
      family++;
      assertHeld(rig, ran, { pass: k, hops: 2 * k, reason: 'missing_verdict', reply, verdict: null, draft: k ? 'another draft' : 'write a post' }, label);
      A.eq([rig.events.filter(e => e.n === 'workitem.delivered' && (e.p.box === 'line-output' || e.p.finalQueueId === 'outbox')).length, rig.shipped.length, rig.counts.finish], [0, 0, 0], label + ': nothing delivered, nothing finished');
      rig.dispose();
    }
    A.eq(family, WIRINGS.length * 2 * 7, 'the durable family is the whole S2 family (' + family + ' cases)');
    const rig = makeRig({ gate: { onSpent: 'escalate', maxIter: 1 } }), ran = await rig.run({ replies: [REVISE, REVISE] });
    assertHeld(rig, ran, { pass: 1, hops: 2, reason: 'spent', reply: REVISE, draft: 'another draft', verdict: 'revise', max: 1, allowed: ['approve', 'stop'] }, 'a spent gate that escalates to a lane that is not there');
    rig.dispose();
  }

  /* ---- 5. WHAT CANNOT BE SAVED EXACTLY ENDS THE OLD WAY, NEVER HALF-SAVED ---- */
  const oldWay = async (label, why, setup, o) => {
    const rig = makeRig(o);
    if (setup) setup(rig);
    const ran = await rig.run({ replies: [REVISE, 'no\nVERDICT: blocked'] });
    const res = rig.settle(ran.job, ran.line), rec = rig.record(ran.job.id);
    A.ok(!ran.line.held && why.test(ran.line.holdFailed || ''), label + ': refused with the reason said: ' + ran.line.holdFailed);
    A.eq([rec.status, rec.continuation === undefined, rec.endedAt !== null, rig.counts.finish, rig.counts.hold], ['problem', true, true, 1, 0], label + ': ended the old terminal blocked stop, finished once, nothing written');
    A.ok(res.delivered === false && res.held === undefined && why.test(res.stop.why) && /answered VERDICT: blocked/.test(res.stop.why), label + ': the stop sentence says both: ' + res.stop.why);
    A.eq(rig.events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output').length + rig.shipped.length, 0, label + ': nothing delivered');
    rig.dispose();
  };
  {   // the runner of before this lane: no port, no attempt, the old record exactly
    const rig = makeRig({ hold: false }), ran = await rig.run({ replies: [REVISE, 'no\nVERDICT: blocked'] });
    const res = rig.settle(ran.job, ran.line), rec = rig.record(ran.job.id);
    A.eq([ran.line.holdFailed, rec.status, rec.continuation === undefined, rig.counts.finish, res.stop.why], [undefined, 'problem', true, 1, ran.line.stop.why], 'a host with no hold port: the old terminal stop, untouched');
    rig.dispose();
  }
  await oldWay('an unreadable file', /cannot be read/, rig => { rig.beforeCall = (x, n) => { if (n === 2) for (const f of fs.readdirSync(rig.dir)) if (f.startsWith('draft-')) fs.unlinkSync(path.join(rig.dir, f)); }; }, { files: true });
  await oldWay('a floor edited while the job was out', /floor was changed/, rig => { rig.beforeCall = (x, n) => { if (n === 2) rig.router.setPlan(P.compileRoutingPlan(geometry({ maxIter: 5 }))); }; });
  await oldWay('E-STOP engaged when the walk reaches the gate', /E-STOP is engaged/, rig => { rig.beforeCall = (x, n) => { if (n === 2) rig.halted = true; }; });
  {   // an oversized crate (the validator's 2 MiB bound): refused before anything is written
    const rig = makeRig(), huge = 'x'.repeat(C.MAX_BYTES) + '\nVERDICT: blocked';
    const ran = await rig.run({ replies: [REVISE, huge] });
    rig.settle(ran.job, ran.line);
    A.ok(!ran.line.held && /exceeds the executable size bound/.test(ran.line.holdFailed || ''), 'an oversized crate: refused, says so: ' + String(ran.line.holdFailed).slice(0, 160));
    A.eq([rig.record(ran.job.id).status, rig.counts.hold, rig.counts.finish], ['problem', 0, 1], 'an oversized crate: nothing was written to the job, it finished the old way once');
    rig.dispose();
  }
  {   /* a hold INSIDE a running split, and a hold AFTER a join, through the real chain. They USED to end the old way (the saver refused them in
         words: a hold could not keep its branches and barrier); since the split step of the lane (S5) they are SAVED with the split — the
         full cases, a restart and the decisions are test/line-hold.split.test.js. Here: they are held, nothing is finished, nothing is
         delivered, and the saved record carries the split. */
    const belt = (x, y, dir) => ({ x, y, dir });
    const joinFloor = () => ({ props: [{ id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'p2', t: 'splitter', x: 3, y: 0, w: 1, h: 1 }, { id: 'p3', t: 'bay', x: 6, y: 0, w: 2, h: 2, agentId: 'A' },
      { id: 'p4', t: 'bay', x: 2, y: 4, w: 2, h: 2, agentId: 'B' }, { id: 'p5', t: 'joiner', x: 9, y: 4, w: 1, h: 1 }, { id: 'p6', t: 'bay', x: 12, y: 4, w: 2, h: 2, agentId: 'D' }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'), belt(3, 1, 'S'), belt(3, 2, 'S'), belt(3, 3, 'S'), belt(8, 0, 'S'), belt(8, 1, 'S'),
        belt(8, 2, 'S'), belt(8, 3, 'S'), belt(8, 4, 'E'), belt(4, 5, 'E'), belt(5, 5, 'E'), belt(6, 5, 'E'), belt(7, 5, 'E'), belt(8, 5, 'E'), belt(9, 5, 'N'), belt(9, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E')] });
    const joinGate = () => {   // INBOX -> SPLIT -> (A | B) -> JOINER -> LOOP gate -> OUTBOX
      const g = joinFloor(); g.props = g.props.filter(p => p.id !== 'p6');
      g.props.push({ id: 'p7', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 }, { id: 'p8', t: 'outbox', x: 15, y: 3, w: 2, h: 2 });
      g.belts.push(belt(12, 4, 'E'), belt(13, 4, 'E'), belt(14, 4, 'E')); return g;
    };
    const branchGate = () => {   // the gate INSIDE branch A
      const g = joinFloor(); g.props = g.props.filter(p => p.id !== 'p6'); g.belts = g.belts.filter(b => !(b.x === 8 && b.y === 2));
      g.props.push({ id: 'p7', t: 'loop', x: 8, y: 2, w: 1, h: 1, done: 'S', esc: 'E', when: 'approved', maxIter: 1 }, { id: 'p9', t: 'outbox', x: 11, y: 1, w: 2, h: 2 });
      g.belts.push(belt(8, 2, 'S'), belt(7, 2, 'W'), belt(9, 2, 'E'), belt(10, 2, 'E')); return g;
    };
    const splitWalk = async (floor, script) => {
      const { makeRouter } = require('../sidecar/routing/router.js'), { makeChainRunner } = require('../sidecar/routing/chain.js'), { makeLineRunner } = require('../sidecar/routing/line-runner.js');
      const { hostPorts } = require('./helpers/line-hold-rig.js');
      const router = makeRouter(), plan = P.compileRoutingPlan(floor);
      A.ok(router.setPlan(plan).ok, 'split fixture: the floor deploys');
      let state = { jobs: [] }, seq = 0, clock = 100, held = 0;
      const rows = new Map(), finishes = [], now = () => ++clock, newId = () => (++seq).toString(16).padStart(12, '0');
      const put = r => { state = J.normalizeAll(JSON.parse(JSON.stringify(r.state))); return r.job ? J.get(state, r.job.id) : null; };
      const jobs = { start: o => put(J.start(state, o)), get: id => J.get(state, id), finish: (id, o) => { finishes.push(id); return put(J.finish(state, id, o)); },
        mark: (id, s) => put(J.mark(state, id, s)), all: () => state.jobs, hold: (id, rev, c) => { held++; return put(J.checkpoint(state, id, rev, c)); } };
      const ports = hostPorts({ router, nightshift: { isHalted: () => false } });
      const chain = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x), peekDock: (d, x) => router.chainPeekDock(d, x),
        entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d),
        loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), getTag: () => 'general', now, newId, setTimer: () => 0 });
      const runOnce = async o => { const row = { runId: o.runId, streamId: o.streamId, agentId: o.agentId, dockId: o.dockId, reason: 'done', outcome: 'succeeded', usd: 0.01, startedAt: now() };
        rows.set(o.runId, row); o.emit('agent.run.end', row); return Object.assign({ text: script[o.agentId] }, row); };
      const runner = makeLineRunner({ chain, runOnce, jobs, runRow: id => rows.get(id), now, newId,
        hold: { originOf: ports.holdOriginOf, planHash: ports.holdPlanHash, receiptFor: ports.holdFileReceipt, authority: ports.holdAuthority } });
      const e = router.resolveDock({ tag: 'general' }), lineId = router.lineOriginFor(e.agentId, e.dockId), runId = 'run-split', streamId = 'split-stream';
      rows.set(runId, { runId, streamId, agentId: e.agentId, dockId: e.dockId, reason: 'done', outcome: 'succeeded', usd: 0.02, startedAt: now() });
      const job = runner.open({ line: lineId, entry: 'sample', text: 'job', streamId });
      const line = await runner.runLineJob({ job, seed: { agentId: e.agentId, dockId: e.dockId, lineId, runId, streamId, since: 101, entryUsd: 0.02, text: script[e.agentId], originalText: 'job', origin: {}, taints: [] }, profile: runner.profiles.channel({}) });
      const res = runner.settle(job, { line, output: line.text });
      return { line, res, rec: J.get(state, job.id), finishes, held };
    };
    const inside = await splitWalk(branchGate(), { A: 'A out', B: 'B out' });
    A.ok(inside.line.hold && inside.line.hold.reason === 'missing_verdict' && inside.line.held && !inside.line.holdFailed, 'a gate inside a running split: saved with its split, not refused: ' + inside.line.holdFailed);
    const ic = inside.rec.continuation;
    A.eq([inside.rec.status, inside.rec.endedAt, inside.finishes.length, inside.held, inside.res.delivered, ic && ic.walk.pending.map(b => b.id), ic && ic.walk.fan.branchIds, ic && ic.barriers.length],
      ['held', null, 0, 1, false, ['p4'], ['p3', 'p4'], 0], 'a gate inside a running split: HELD, nothing finished, one write; the sibling that had not started is queued in the saved split');
    const joined = await splitWalk(joinGate(), { A: 'A out', B: 'B out' });
    A.ok(joined.line.hold && joined.line.held && !joined.line.holdFailed, 'a gate after a join: saved, not refused: ' + joined.line.holdFailed);
    const jc = joined.rec.continuation;
    A.eq([joined.rec.status, joined.finishes.length, joined.held, jc && jc.walk.product.producer.kind, jc && jc.walk.product.producer.runIds.length, jc && jc.walk.fan, jc && jc.barriers.length],
      ['held', 0, 1, 'join', 2, null, 0], 'a gate after a join: HELD, the crate under review is the join\'s merge of two runs, no split is left to save');
    const clean = await splitWalk(joinGate(), { A: 'A out', B: 'B out\nVERDICT: approved' });
    A.eq([clean.res.delivered, clean.line.hold, clean.line.holdFailed], [true, undefined, undefined], 'control: the same joined line with an approving tail is delivered, no hold attempted');
  }
  {   // the pure builder refuses every state it cannot save exactly, in words — it never throws
    const rig = makeRig(), ran = await rig.run({ replies: [REVISE, 'no\nVERDICT: blocked'] });
    const rec = rig.record(ran.job.id), line = ran.line, st = line.holdState;
    const host = { planHash: rig.plan.hash, receiptFor: rig.ports.holdFileReceipt };
    const seed = { runId: ran.runId, entryTrusted: true, hostPowerKept: true, taints: [] };
    const origin = rig.ports.holdOriginOf(rec, rig.facts.channel);
    const build = (mut, o) => { const l = Object.assign({}, line, { holdState: JSON.parse(JSON.stringify(st)) }); Object.defineProperty(l, 'hold', { value: line.hold }); mut(l.holdState); return LineHold.buildHeld(seed, l, o === undefined ? rec : o, origin, host); };
    const again = LineHold.buildHeld(seed, line, rec, origin, host);
    A.ok(!!st && again.ok === true && JSON.stringify(again.continuation) === JSON.stringify(rec.continuation), 'the pure builder is deterministic: the same walk builds the very continuation that was saved');
    for (const [label, mut, why] of [['a split the walk cannot account for', s => { s.open.refuse = 'a branch of the split ended apart from its joiner, so the split cannot be rebuilt exactly'; }, /ended apart from its joiner/],
      ['a parallel batch still out', s => { s.barriers = [{ inFlight: ['p4'] }]; }, /still out/],
      ['queued branches with no split', s => { s.walk.pending = [{ id: 'p4', node: { agentId: 'x', dockId: null }, product: { text: 't', draft: 'd', verdict: null, files: [], producer: { kind: 'run', runId: 'r' } } }]; }, /no split to account for/],
      ['no attempts', s => { s.attempts = []; }, /no run receipt/],
      ['an attempt with no run id', s => { s.attempts[1].runId = null; }, /no run receipt/], ['no state at all', s => { delete s.walk; }, /left no state/]]) {
      const r = build(mut);
      A.ok(r.ok === false && why.test(r.reason), label + ': refused in words: ' + r.reason);
    }
    A.ok(/no saved record/.test(LineHold.buildHeld(seed, line, null, origin, host).reason), 'no job record: refused');
    A.ok(/cannot be named/.test(LineHold.buildHeld(seed, line, rec, null, host).reason), 'no origin: refused');
    A.ok(/no hash/.test(LineHold.buildHeld(seed, line, rec, origin, { receiptFor: host.receiptFor }).reason), 'no floor hash: refused');
    A.ok(LineHold.buildHeld(null, null, null, null, null).ok === false, 'nothing at all: a refusal, not a throw');
    rig.dispose();
  }

  /* ---- 6. RETENTION, BOOT AND THE QUEUE OF HELD JOBS ---- */
  {
    const rig = makeRig(), first = await rig.run({ replies: ['no\nVERDICT: blocked'] });
    // a running job beside it: boot interrupts the running one and leaves the held one alone
    A.eq([J.boot(rig.state(), 5000).changed, J.boot(rig.state(), 5000).state === undefined], [false, false], 'boot of a store holding only a held job changes nothing (it is not a job that was out)');
    const running = rig.runner.open({ line: rig.lineId, entry: 'channel', text: 'still out', streamId: 'running-one' });
    A.eq(J.boot(rig.state(), 5000).changed, true, 'boot does change the store beside a running job');
    rig.boot();
    A.eq([rig.record(first.job.id).status, rig.record(running.id).status], ['held', 'interrupted'], 'boot: the running job is interrupted, the held one is kept');
    // 130 finished jobs after it: the store trims the oldest FINISHED record of the busiest line, never a held one
    let state = rig.state();
    for (let i = 0; i < J.MAX_JOBS + 10; i++) {
      const id = 'job-fill' + String(i).padStart(8, '0');
      state = J.finish(J.start(state, { id, line: rig.lineId, entry: 'channel', streamId: 'fill-' + i, at: 2000 + i, text: 'fill' }).state, id, { status: 'delivered', at: 3000 + i, usd: 0, output: 'x', runs: [], outcome: 'delivered', stop: null }).state;
    }
    const kept = J.normalizeAll(JSON.parse(JSON.stringify(state)));
    A.ok(kept.jobs.length <= J.MAX_JOBS + 1 && kept.jobs.some(j => j.id === first.job.id && j.status === 'held'), 'retention: past ' + J.MAX_JOBS + ' records the oldest finished ones go, the held job stays (' + kept.jobs.length + ' kept)');
    rig.dispose();
  }
  {
    const rig = makeRig(), held = [];
    for (let i = 0; i < J.MAX_HELD; i++) held.push(await rig.run({ replies: ['no\nVERDICT: blocked'] }));
    A.ok(held.every(r => rig.record(r.job.id).status === 'held'), 'the queue: ' + J.MAX_HELD + ' jobs wait for a decision at once');
    const over = await rig.run({ replies: ['no\nVERDICT: blocked'] });
    rig.settle(over.job, over.line);
    A.ok(!over.line.held && /already waiting for a decision/.test(over.line.holdFailed || ''), 'the queue: the next one is refused, and says so: ' + over.line.holdFailed);
    A.eq([rig.record(over.job.id).status, rig.record(held[0].job.id).status], ['problem', 'held'], 'the queue: it ended the old way; the waiting ones are untouched');
    rig.dispose();
  }

  /* ---- 6b. the store's readers never see a held job as delivered ---- */
  {
    const rig = makeRig(), ran = await rig.run({ replies: [REVISE, 'no\nVERDICT: blocked'] });
    const list = J.list(rig.state(), {}), s = list[0];
    A.eq([list.length, s.status, s.outcome, s.endedAt, s.steps, s.continuation.phase], [1, 'held', 'blocked', null, 3, 'held'], 'WORKFLOWS: the summary row says held, blocked, not ended');
    A.eq(s.hold, { reason: 'blocked', why: Verdict.heldWhy('12,4', 'blocked'), gateId: '12,4', pass: 1, allowed: ['approve', 'send_back', 'stop'], revision: 1 }, 'WORKFLOWS: the row carries why, where and what may be decided');
    A.ok(JSON.stringify(s).length < 2000 && !JSON.stringify(s.hold).includes('another draft') && !('walk' in s.continuation), 'WORKFLOWS: the row is bounded and the hold projection never carries the work itself');
    A.eq(rig.state().jobs.filter(j => j.status === 'delivered').length + list.filter(r => r.status === 'delivered' || r.unapproved).length, 0, 'no reader counts it as a delivered job');
    A.eq(J.get(rig.state(), ran.job.id).output, '', 'the record shows NO output (the draft under review is the continuation\'s, never delivered output)');
    rig.dispose();
  }
  A.ok(LineFire.lineStopNote({ stopped: 'x', stop: { code: 'blocked', why: 'held there' }, held: { jobId: 'job-abc12345' } }).includes('job job-abc12345'), 'the stop note names the held job');
  A.report('line-hold.matrix');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.matrix'); });
