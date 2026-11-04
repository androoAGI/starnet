/* node test/line-hold.decision.test.js — ONE DECISION WINS (line-hold lane, S4; invariant one-decision-wins).

   A held job takes exactly one person's word. The decision is claimed with a verified write (the token and the checkpoint revision make
   it exactly-once); everything after the claim is idempotent on that same claim. Over the real store (temp directory, the station's own
   writer) and the station's one resume owner:

     1. two requests with the SAME decision, one after the other without waiting for the walk: one runs, the other is the saved receipt;
     2. the same token for a DIFFERENT decision is refused; two DIFFERENT decisions: the first wins, the second is refused — never both;
     3. a stale revision, an action the hold does not offer, a job that is not held, an unknown job, malformed input: refused, with the
        right code, and nothing runs;
     4. a LOST ACKNOWLEDGEMENT on the claim (it landed, the readback failed): the retry with the same token finds it and carries it out
        ONCE — a 503 in between bought nothing;
     5. a RESTART between the claim and the rest: the same decision, replayed, carries on once; any other decision is refused meanwhile;
     6. every one of these buys no provider call and no delivery beyond the one decision's own. */
'use strict';
const A = require('./_assert.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig, AFTER } = require('./helpers/line-hold-rig.js');

const REVISE = 'not yet\nVERDICT: revise', BLOCKED = 'no\nVERDICT: blocked';
const get = (env, id) => J.get(env.host.jobs(), id);
async function held(env, o) {
  const rig = makeRig(Object.assign({ wiring: AFTER }, o)).wire(env.host);
  const ran = await rig.run({ replies: [REVISE, BLOCKED] });
  rig.settle(ran.job, ran.line);
  A.ok(ran.line.held && get(env, ran.job.id).status === 'held', 'the job is parked as a hold');
  return { rig, id: ran.job.id, owner: rig.owner(env.host), c: get(env, ran.job.id).continuation };
}
const say = (id, c, action, token, note) => ({ action, token, revision: c.revision, note: note || '' });
const outputs = rig => JSON.parse(rig.world()).lineOutputs;

(async () => {
  /* ---- 1. the same decision twice, at once: one carries on, the other is the saved receipt ---- */
  await allocated(async env => {
    const { rig, id, owner, c } = await held(env);
    const first = owner.resume(id, say(id, c, 'approve', 'tok-1')), second = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([first.code, second.code, second.replayed, second.receipt.token, second.done], [202, 200, true, 'tok-1', null], 'the first is claimed and carried on; the second is the saved receipt, running nothing');
    A.ok(['adopted', 'complete'].includes(second.receipt.state), 'and it names the decision already carried on (adopted, or complete once its first stage was written down): ' + second.receipt.state);
    await first.done;
    A.eq([rig.calls.filter(x => x === 'publisher').length, outputs(rig), get(env, id).status], [1, 1, 'delivered'], 'exactly one stage bought and one OUTBOX delivery');
    const third = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([third.code, third.replayed, third.receipt.state, rig.calls.length, outputs(rig)], [200, true, 'complete', 3, 1], 'and long after: still the saved receipt, nothing more');
    rig.dispose();
  });

  /* ---- 2. the same token for another decision; two different decisions ---- */
  await allocated(async env => {
    const { rig, id, owner, c } = await held(env);
    const a = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    const swapped = owner.resume(id, say(id, c, 'stop', 'tok-1'));
    A.eq([swapped.code, /different decision/.test(swapped.error)], [409, true], 'the same token for a different decision is refused: ' + swapped.error);
    const rival = owner.resume(id, say(id, c, 'stop', 'tok-2'));
    A.eq([rival.code, rival.ok, /no longer waiting/.test(rival.error)], [409, false, true], 'a different decision on a checkpoint that is claimed is refused: ' + rival.error);
    await a.done;
    A.eq([get(env, id).status, get(env, id).continuation.decisions.map(d => d.token), outputs(rig)], ['delivered', ['tok-1'], 1], 'only the first decision exists, and it delivered');
    rig.dispose();
  });
  await allocated(async env => {
    const { rig, id, owner, c } = await held(env);
    const stop = owner.resume(id, say(id, c, 'stop', 'tok-1')), approve = owner.resume(id, say(id, c, 'approve', 'tok-2'));
    A.eq([stop.code, approve.code, get(env, id).status, rig.calls.length, outputs(rig)], [200, 409, 'stopped', 2, 0], 'STOP first: the later APPROVE is refused, nothing was bought or delivered');
    rig.dispose();
  });

  /* ---- 3. refusals: stale, not offered, not held, unknown, malformed ---- */
  await allocated(async env => {
    const { rig, id, owner, c } = await held(env, { gate: { maxIter: 1 } });
    const hold = c.hold;
    A.ok(!hold.allowed.includes('send_back') && hold.allowed.includes('approve'), 'a gate whose passes are spent offers no SEND BACK: ' + JSON.stringify(hold.allowed));
    const back = owner.resume(id, say(id, c, 'send_back', 'tok-1', 'again'));
    const stale = owner.resume(id, { action: 'approve', token: 'tok-2', revision: c.revision + 1, note: '' });
    const old = owner.resume(id, { action: 'approve', token: 'tok-3', revision: c.revision - 1 || 99, note: '' });
    A.eq([back.code, stale.code, old.code], [409, 409, 409], 'SEND BACK where it is not offered, and a decision made on another revision: 409');
    const bad = [{ action: 'maybe', token: 't', revision: 1 }, { action: 'approve', token: 'no spaces allowed', revision: 1 }, { action: 'approve', token: 't', revision: 0 },
      { action: 'approve', token: 't', revision: 1, note: 'x'.repeat(2001) }, null, 'approve'].map(x => owner.resume(id, x).code);
    A.eq(bad, [400, 400, 400, 400, 400, 400], 'malformed decisions: 400');
    A.eq([owner.resume('job-doesnotexist1', say(id, c, 'stop', 'tok-9')).code, rig.calls.length, get(env, id).status, get(env, id).continuation.decisions.length], [404, 2, 'held', 0], 'an unknown job: 404. None of it claimed anything: the job is held, no decision exists, no stage ran');
    const ok = owner.resume(id, say(id, c, 'approve', 'tok-ok'));
    A.eq(ok.code, 202, 'control: the offered decision on the right revision is taken');
    await ok.done;
    const late = owner.resume(id, { action: 'approve', token: 'tok-late', revision: c.revision, note: '' });
    A.eq([late.code, rig.calls.filter(x => x === 'publisher').length, outputs(rig)], [409, 1, 1], 'a NEW decision on a job that is not held any more: 409, nothing ran');
    rig.dispose();
  });

  /* ---- 4. a lost acknowledgement on the claim ---- */
  await allocated(async env => {
    const { rig, id, owner, c } = await held(env);
    const writes = env.f.writes.filter(w => w.file === env.jobFile).length;
    env.f.after = env.jobFile; env.f.atWrite = writes + 1;   // the claim lands; the canonical file then cannot be read back
    const lost = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([lost.code, lost.ok, rig.calls.length], [503, false, 2], 'the claim could not be confirmed: 503, and nothing was bought');
    A.eq(env.raw(env.jobFile).jobs.find(j => j.id === id).continuation.activeDecision, 'tok-1', 'but the claim did land on disk');
    env.f.readsBlocked.clear(); env.f.after = ''; env.f.atWrite = 0;   // storage comes back
    const retry = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([retry.code, retry.running], [202, true], 'the same decision again finds its claim and carries it out');
    await retry.done;
    A.eq([get(env, id).status, rig.calls.filter(x => x === 'publisher').length, outputs(rig), get(env, id).continuation.decisions.length], ['delivered', 1, 1, 1], 'once: one stage, one delivery, one decision');
    rig.dispose();
  });

  /* ---- 4b. a lost acknowledgement on the ADOPTION: it landed, the walk never started; the same decision starts it, once ---- */
  await allocated(async env => {
    const { rig, id, owner, c } = await held(env);
    const writes = env.f.writes.filter(w => w.file === env.jobFile).length;
    env.f.after = env.jobFile; env.f.atWrite = writes + 2;   // the claim lands (write 1); the adoption lands (write 2) and cannot be read back
    const lost = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([lost.code, rig.calls.length], [503, 2], 'the adoption could not be confirmed: 503, nothing was bought');
    const on = env.raw(env.jobFile).jobs.find(j => j.id === id).continuation;
    A.eq([on.phase, on.decisions[0].state], ['ready', 'adopted'], 'but it did land: adopted, the walk never started');
    env.f.readsBlocked.clear(); env.f.after = ''; env.f.atWrite = 0;
    const retry = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([retry.code, retry.running], [202, true], 'the same decision again starts the walk it never started');
    await retry.done;
    A.eq([get(env, id).status, rig.calls.filter(x => x === 'publisher').length, outputs(rig)], ['delivered', 1, 1], 'once: one stage, one delivery');
    const late = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([late.code, late.replayed, rig.calls.length], [200, true, 3], 'and after that it is only the saved receipt');
    rig.dispose();
  });

  /* ---- 5. a restart between the claim and the rest ---- */
  await allocated(async env => {
    const { rig, id, c } = await held(env);
    const claimed = env.host.store.claim(id, Object.assign(say(id, c, 'approve', 'tok-1'), { at: 5 }));   // the claim is written; the station dies before anything else
    A.eq([claimed.replayed, claimed.receipt.state, get(env, id).status], [false, 'accepted', 'held'], 'claimed, not carried out: the job is still held');
    const bytes = JSON.stringify(env.raw(env.jobFile).jobs.find(j => j.id === id));
    const again = env.loadHost();   // the restart: boot reads the store
    A.eq([JSON.stringify(env.raw(env.jobFile).jobs.find(j => j.id === id)) === bytes, J.get(again.jobs(), id).status, J.get(again.jobs(), id).continuation.activeDecision], [true, 'held', 'tok-1'], 'boot left the claim alone and never turned the job into interrupted');
    rig.wire(again);
    const owner = rig.owner(again);
    const other = owner.resume(id, say(id, c, 'stop', 'tok-2'));
    A.eq([other.code, rig.calls.length], [409, 2], 'meanwhile no other decision can take the checkpoint');
    const mine = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([mine.code, mine.running], [202, true], 'the same decision, replayed after the restart, carries on');
    await mine.done;
    const job = J.get(again.jobs(), id);
    A.eq([job.status, rig.calls.filter(x => x === 'publisher').length, outputs(rig), job.continuation.decisions.map(d => [d.token, d.state])], ['delivered', 1, 1, [['tok-1', 'complete']]], 'exactly one continuation: one stage, one delivery');
    rig.dispose();
  });

  /* ---- 5b. a restart between the adoption and the first stage: the job is interrupted, the same decision starts it, once ---- */
  await allocated(async env => {
    const { rig, id, c } = await held(env);
    const Resume = require('../sidecar/routing/line-resume.js');
    env.host.store.claim(id, Object.assign(say(id, c, 'approve', 'tok-1'), { at: 5 }));
    env.host.store.advance(id, x => Resume.adopted(x, 'tok-1'), () => false);   // adopted; the station dies before any stage is written down
    const again = env.loadHost(), job = J.get(again.jobs(), id);
    A.eq([job.status, job.continuation.phase, job.continuation.decisions[0].state, rig.calls.length], ['interrupted', 'ready', 'adopted', 2], 'after the restart: interrupted, nothing bought since the adoption');
    rig.wire(again);
    const owner = rig.owner(again), other = owner.resume(id, { action: 'approve', token: 'tok-2', revision: job.continuation.revision, note: '' });
    A.eq([other.code, rig.calls.length], [409, 2], 'a different decision cannot take it');
    rig.halted = true;
    const refused = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([refused.code, refused.refused, /E-STOP/.test(refused.error), J.get(again.jobs(), id).status, rig.calls.length], [409, true, true, 'interrupted', 2], 'E-STOP refuses it and leaves it as it was, to be asked for again');
    rig.halted = false;
    const mine = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    A.eq([mine.code, mine.running], [202, true], 'the same decision starts the walk it never started');
    await mine.done;
    const done = J.get(again.jobs(), id);
    A.eq([done.status, rig.calls.filter(x => x === 'publisher').length, outputs(rig), done.continuation.decisions.map(d => d.state)], ['delivered', 1, 1, ['complete']], 'once: one stage, one delivery');
    rig.dispose();
  });

  /* ---- 6. the walk is running: a second claim of the same token or any other buys and delivers nothing ---- */
  await allocated(async env => {
    const { rig, id, owner, c } = await held(env);
    const run = owner.resume(id, say(id, c, 'approve', 'tok-1'));
    const dup = owner.resume(id, say(id, c, 'approve', 'tok-1')), rival = owner.resume(id, { action: 'stop', token: 'tok-2', revision: c.revision + 2, note: '' });
    A.eq([dup.code, dup.replayed, rival.code, rig.calls.length], [200, true, 409, 3], 'while the stage is out (the third provider call): the repeat is the receipt, a rival is refused, no second stage');
    await run.done;
    A.eq([rig.calls.filter(x => x === 'publisher').length, outputs(rig), get(env, id).status], [1, 1, 'delivered'], 'and the one walk delivered once');
    rig.dispose();
  });
  A.report('line-hold.decision');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.decision'); });
