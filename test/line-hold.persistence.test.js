/* node test/line-hold.persistence.test.js — THE HOLD ON THE REAL STORE (line-hold lane, S3; invariant restart-keeps-the-hold).

   The hold is written by the station's own verified writer (index.js lineJobsHold: a fresh canonical read, the pure LineJobs.checkpoint, a
   strict write and its readback), compiled out of sidecar/index.js with the real domain store on a real temp directory, the real LineJobs
   and the real day ledger. Only the filesystem's faults are allocated (test/helpers/line-accounting-host.js). The walk is the real router,
   chain and LineRunner (test/helpers/line-hold-rig.js), wired to the host's job port exactly as index.js wires it.

     1. The hold lands; a restart (a fresh host over the same files) finds the job id, continuation revision, draft, cursor and taint
        byte for byte, boot rewrites NOTHING and never turns it into 'interrupted'; the spend ledger holds exactly what was paid, once.
     2. A hold write that CANNOT be saved: the job ends the old terminal blocked stop with the reason said; nothing half-saved.
     3. A hold write that LANDS but whose readback fails: the canonical store says held, the runner first believes it failed — and the next
        settle finds the landed hold instead of finishing over it. Never a silent loss, never a second spend, never a terminal record.
     4. Boot interrupts a running job beside it and leaves the held one alone. */
'use strict';
const fs = require('node:fs');
const A = require('./_assert.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig } = require('./helpers/line-hold-rig.js');

const REVISE = 'not yet\nVERDICT: revise', BLOCKED = 'no\nVERDICT: blocked';

// the rig's runner, wired to the HOST's production job port and day ledger exactly as index.js wires them (the lineRunner `jobs:` block)
function wire(rig, host) {
  Object.assign(rig.jobs, {
    start: o => host.mutate(s => J.start(s, o)),
    finish: (id, o) => { rig.counts.finish++; return host.mutate(s => J.finish(s, id, o)); },
    get: id => J.get(host.jobs(), id), mark: (id, st) => host.mutate(s => J.mark(s, id, st)), all: () => host.jobs().jobs,
    hold: (id, rev, c) => { rig.counts.hold++; return host.hold(id, rev, c); }
  });
  rig.day = { spent: l => host.ledger.spentToday(l), note: (l, usd) => { rig.notes.push(usd); host.ledger.note(l, usd); } };
  return rig;
}
const jobWrites = env => env.f.writes.filter(w => w.file === env.jobFile).length;
// what a DELIVERED job leaves on the floor: the OUTBOX crate and the line-output receipt (the chain's per-hop crates are not deliveries)
const crates = rig => rig.events.filter(e => e.n === 'workitem.delivered' && (e.p.finalQueueId === 'outbox' || e.p.box === 'line-output')).length;
const paid = (env, rig) => (env.raw(env.spendFile).lines[rig.lineId] || {}).usd;

(async () => {
  A.ok(typeof allocated === 'function', 'the real-store harness is there');
  let host0 = null;
  allocated(env => { host0 = env.host; });
  A.ok(host0 && typeof host0.hold === 'function', 'index.js has the durable hold writer (lineJobsHold)');
  if (!host0 || typeof host0.hold !== 'function') return A.report('line-hold.persistence');

  /* ---- 1. THE HOLD LANDS AND SURVIVES A RESTART ---- */
  await allocated(async env => {
    const rig = wire(makeRig(), env.host), id0 = () => ran.job.id;
    let ran = await rig.run({ replies: [REVISE, BLOCKED] });
    const id = id0(), rec = J.get(env.host.jobs(), id), onDisk = env.raw(env.jobFile).jobs.find(j => j.id === id);
    A.ok(ran.line.held && !ran.line.holdFailed, 'the verified writer saved the hold');
    A.eq([onDisk.status, onDisk.outcome, onDisk.endedAt, onDisk.continuation.phase, onDisk.continuation.revision, onDisk.continuation.hold.pass], ['held', 'blocked', null, 'held', 1, 1], 'the canonical file says HELD, revision 1, pass 1');
    A.eq(JSON.stringify(rec), JSON.stringify(J.normJob(onDisk)), 'what the host reads back is what is on disk');
    const res = rig.settle(ran.job, ran.line);
    A.eq([res.held, res.delivered, res.status, rig.counts.finish, jobWrites(env)], [true, false, 'held', 0, 2], 'settle says HELD: no finish, no terminal write (the job start and the hold are the only two)');
    A.ok(Math.abs(paid(env, rig) - 0.04) < 1e-9 && rig.notes.length === 3, 'the day ledger holds exactly what was paid, once (entry 0.02 + two hops 0.01): ' + paid(env, rig));
    // a restart: a fresh host over the same files
    const bytes = fs.readFileSync(env.jobFile, 'utf8'), spendBytes = fs.readFileSync(env.spendFile, 'utf8'), writes = env.f.writes.length, world = rig.world();
    const again = env.loadHost(), back = J.get(again.jobs(), id);
    A.eq([back.status, back.outcome, back.endedAt, back.stop && back.stop.code], ['held', 'blocked', null, 'blocked'], 'after a restart the job is still HELD (never interrupted)');
    A.eq(JSON.stringify(back), JSON.stringify(rec), 'the job id, continuation revision, draft, cursor and taint are byte for byte the saved ones');
    A.eq([fs.readFileSync(env.jobFile, 'utf8') === bytes, fs.readFileSync(env.spendFile, 'utf8') === spendBytes, env.f.writes.length], [true, true, writes], 'boot rewrote nothing: not the jobs file, not the spend ledger');
    A.eq(rig.world(), world, 'boot made zero provider calls and noted nothing');
    A.eq([back.continuation.walk.lastHanded, back.continuation.walk.current, back.continuation.walk.next.gateId, back.continuation.restriction.taints], ['another draft', { agentId: 'reviewer', dockId: 'p3' }, '12,4', []], 'the draft, the cursor and the taint are the saved ones');
    // 4. a running job beside it: boot interrupts the running one only
    again.mutate(s => J.start(s, { id: 'job-runningone01', line: rig.lineId, entry: 'channel', streamId: 'running', at: 5, text: 'still out' }));
    const third = env.loadHost();
    A.eq([J.get(third.jobs(), id).status, J.get(third.jobs(), 'job-runningone01').status], ['held', 'interrupted'], 'boot: the running job is interrupted, the held one is kept');
    A.eq(JSON.stringify(J.get(third.jobs(), id)), JSON.stringify(rec), 'and the held job is still byte for byte the saved one');
    A.ok(Math.abs(paid(env, rig) - 0.04) < 1e-9, 'three boots later the ledger still says what was paid');
    rig.dispose();
  });

  /* ---- 2. A HOLD THAT CANNOT BE SAVED ENDS THE OLD WAY, THE REASON SAID ---- */
  await allocated(async env => {
    const rig = wire(makeRig(), env.host);
    env.f.before = env.jobFile; env.f.atWrite = 2;   // the job's start is write 1; the hold is write 2, and it is refused
    const ran = await rig.run({ replies: [REVISE, BLOCKED] });
    const id = ran.job.id;
    A.ok(!ran.line.held && /could not be saved as a hold/.test(ran.line.holdFailed || '') && /fixture canonical write refused/.test(ran.line.holdFailed), 'a refused hold write is said: ' + ran.line.holdFailed);
    A.eq([rig.counts.hold, J.get(env.host.jobs(), id).status, 'continuation' in env.raw(env.jobFile).jobs.find(j => j.id === id)], [1, 'running', false], 'nothing half-saved: the job is still just running, with no continuation');
    env.f.before = '';   // storage comes back (a refused write never advances the fixture's write count, so the fault would stay armed)
    const res = rig.settle(ran.job, ran.line), rec = J.get(env.host.jobs(), id);
    A.eq([res.held, res.delivered, rec.status, rec.outcome, rec.continuation === undefined, rec.endedAt !== null], [undefined, false, 'problem', 'blocked', true, true], 'the job ended the old terminal blocked stop');
    A.ok(/answered VERDICT: blocked/.test(rec.stop.why) && /could not be saved as a hold/.test(rec.stop.why) && rec.error === rec.stop.why, 'and its record says why it was not held: ' + rec.stop.why);
    A.eq([rig.counts.finish, crates(rig), rig.shipped.length], [1, 0, 0], 'finished once, delivered nothing (no OUTBOX crate, no line-output, no shipment)');
    A.ok(Math.abs(paid(env, rig) - 0.04) < 1e-9, 'the spend is in the ledger once');
    const again = env.loadHost();
    A.eq([J.get(again.jobs(), id).status, J.get(again.jobs(), id).continuation === undefined], ['problem', true], 'a restart changes nothing');
    rig.dispose();
  });

  /* ---- 3. A HOLD THAT LANDS BUT WHOSE READBACK FAILS IS FOUND, NEVER FINISHED OVER ---- */
  await allocated(async env => {
    const rig = wire(makeRig(), env.host);
    env.f.after = env.jobFile; env.f.atWrite = 2;   // the hold lands, and the canonical file cannot be read back afterwards
    const ran = await rig.run({ replies: [REVISE, BLOCKED] });
    const id = ran.job.id, landed = env.raw(env.jobFile).jobs.find(j => j.id === id);
    A.eq([landed.status, landed.continuation && landed.continuation.phase], ['held', 'held'], 'the hold really did land on disk');
    A.ok(!ran.line.held && /could not be saved as a hold/.test(ran.line.holdFailed || ''), 'the runner could not confirm it, and says so: ' + ran.line.holdFailed);
    A.throws(() => rig.settle(ran.job, ran.line), 'while the canonical file cannot be read, nothing is finished or published (settle refuses, as any refused finish does)');
    A.eq([crates(rig), rig.shipped.length, jobWrites(env)], [0, 0, 2], 'no crate, no shipment, no terminal write');
    env.f.readsBlocked.clear();   // storage comes back
    const res = rig.settle(ran.job, ran.line), rec = J.get(env.host.jobs(), id);
    A.eq([res.held, res.delivered, res.status, rec.status, rec.outcome, rec.endedAt], [true, false, 'held', 'held', 'blocked', null], 'the next settle FINDS the landed hold: the job is held');
    A.eq([jobWrites(env), crates(rig), rig.shipped.length], [2, 0, 0], 'it wrote nothing over it, delivered nothing');
    A.eq(JSON.stringify(rec.continuation), JSON.stringify(landed.continuation), 'the continuation is exactly the one that landed');
    A.ok(Math.abs(paid(env, rig) - 0.04) < 1e-9 && rig.notes.length === 3, 'no second spend: the ledger is what was paid, once');
    const again = env.loadHost();
    A.eq(JSON.stringify(J.get(again.jobs(), id)), JSON.stringify(rec), 'and a restart finds it unchanged');
    rig.dispose();
  });
  A.report('line-hold.persistence');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.persistence'); });
