/* node test/line-hold.authority.test.js — A RESUME IS RE-CHECKED AGAINST NOW (line-hold lane, S4; invariant resume-rechecks-authority).

   The hold was vouched for when the walk stopped. Hours later a person says APPROVE: the station checks again, with its own authority
   (index.js holdAuthority, phase 'resume', compiled out of the host itself) and against the job as it was SAVED, never against what
   the record claims about trust. Each cause below refuses the decision BEFORE anything is bought, leaves the job HELD at the same gate,
   marks the decision refused and puts the reason on the record. A STOP is never refused. Clearing the cause never approves anything:
   only a NEW decision does.

     a floor changed (plan hash) · a stage's line changed · a deleted agent · E-STOP · the job's own $ limit reached · the line's day
     limit reached · a produced file altered · a produced file gone */
'use strict';
const fs = require('node:fs');
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig, geometry, AFTER } = require('./helpers/line-hold-rig.js');

const REVISE = 'not yet\nVERDICT: revise', BLOCKED = 'no\nVERDICT: blocked';
const get = (env, id) => J.get(env.host.jobs(), id);
async function held(env, o) {
  o = o || {};
  const rig = makeRig(Object.assign({ wiring: AFTER }, o.rig)).wire(env.host);
  const ran = await rig.run(Object.assign({ replies: [REVISE, BLOCKED] }, o.run));
  rig.settle(ran.job, ran.line);
  A.ok(ran.line.held && get(env, ran.job.id).status === 'held', 'the job is parked as a hold: ' + (ran.line.holdFailed || ''));
  return { rig, id: ran.job.id, owner: rig.owner(env.host), c: get(env, ran.job.id).continuation };
}
const say = (c, action, token) => ({ action, token, revision: c.revision, note: '' });

// one refusal: the decision is turned away with the reason, nothing is bought, the job is held exactly as it was, the record says why
async function refused(label, env, h, why, what) {
  const { rig, id, owner, c } = h, world = rig.world(), before = JSON.stringify([c.walk, c.attempts, c.accounting, c.files, c.hold, c.binding]);
  const r = owner.resume(id, say(c, 'approve', 'tok-1'));
  A.eq([r.code, r.ok, r.refused], [409, false, true], label + ': the decision is refused (409)');
  A.ok(why.test(r.error), label + ': it says why — ' + r.error);
  const job = get(env, id), k = job.continuation;
  A.eq([job.status, k.phase, k.hold.gateId, k.activeDecision, k.decisions.map(d => [d.token, d.state])], ['held', 'held', c.hold.gateId, null, [['tok-1', 'refused']]], label + ': the job stays HELD at the same gate, its decision marked refused');
  A.eq(JSON.stringify([k.walk, k.attempts, k.accounting, k.files, k.hold, k.binding]), before, label + ': the saved walk, receipts, spend and floor binding are untouched');
  A.ok(job.resumeRefused && why.test(job.resumeRefused.why) && job.resumeRefused.token === 'tok-1', label + ': the reason is on the job record: ' + JSON.stringify(job.resumeRefused));
  const row = J.summary(job);
  A.ok(row.hold && row.hold.refused && why.test(row.hold.refused.why) && row.hold.revision === k.revision, label + ': and in the list row the window reads');
  A.eq([rig.world(), rig.calls.length], [world, 2], label + ': zero provider calls, zero notes, no delivery, no finish');
  if (what) await what(r, job);
  return job;
}

(async () => {
  /* ---- the floor changed ---- */
  await allocated(async env => {
    const h = await held(env);
    h.rig.router.setPlan(P.compileRoutingPlan(geometry({ maxIter: 5 }, AFTER)));   // the floor was edited while the job waited
    await refused('a changed floor', env, h, /floor was changed/);
    h.rig.dispose();
  });
  await allocated(async env => {
    const h = await held(env);
    h.rig.router.lineOfAgent = () => 'another-line';   // the stage the job went through now belongs to another line
    await refused('a stage on another line', env, h, /no longer on its line/);
    h.rig.dispose();
  });
  /* ---- a deleted agent ---- */
  await allocated(async env => {
    const h = await held(env);
    h.rig.roster.delete('reviewer');
    await refused('a deleted agent', env, h, /agent reviewer cannot run now \(target agent reviewer is not in the live roster\)/);
    h.rig.roster.set('reviewer', {}); h.rig.roster.delete('publisher');   // the agent AFTER the gate, the one the approved work goes to next
    const next = h.owner.resume(h.id, { action: 'approve', token: 'tok-2', revision: get(env, h.id).continuation.revision, note: '' });
    A.eq([next.code, /agent publisher cannot run now/.test(next.error), h.rig.calls.length], [409, true, 2], 'an agent the job has not met yet but will run next counts too — refused before the stage is bought');
    h.rig.dispose();
  });
  /* ---- E-STOP: engaged refuses; clearing it never approves; STOP works through it ---- */
  await allocated(async env => {
    const h = await held(env), { rig, id, owner, c } = h;
    rig.halted = true;
    const job = await refused('E-STOP', env, h, /E-STOP is engaged/);
    const k = job.continuation;
    rig.halted = false;   // the Commander resumes the station
    A.eq([get(env, id).status, rig.calls.length, JSON.stringify(get(env, id).continuation)], ['held', 2, JSON.stringify(k)], 'clearing E-STOP changed nothing: the job is still held, nothing ran by itself');
    const replay = owner.resume(id, say(c, 'approve', 'tok-1'));
    A.eq([replay.code, replay.refused, replay.replayed, replay.error === job.resumeRefused.why, rig.calls.length], [409, true, true, true, 2], 'the refused decision again is the SAVED refusal — it is not re-checked and never turns into an approval');
    const fresh = owner.resume(id, { action: 'approve', token: 'tok-2', revision: k.revision, note: '' });
    A.eq([fresh.code, fresh.running], [202, true], 'only a NEW decision on the current revision goes on');
    await fresh.done;
    const done = get(env, id);
    A.eq([done.status, rig.calls.filter(x => x === 'publisher').length, done.resumeRefused, done.continuation.decisions.map(d => [d.token, d.state])], ['delivered', 1, undefined, [['tok-1', 'refused'], ['tok-2', 'complete']]], 'it delivered, once; the old refusal is history, not a state');
    rig.dispose();
  });
  await allocated(async env => {
    const { rig, id, owner, c } = await held(env);
    rig.halted = true;
    const r = owner.resume(id, say(c, 'stop', 'tok-1'));
    A.eq([r.code, r.stopped, get(env, id).status, rig.calls.length], [200, true, 'stopped', 2], 'STOP is never refused: it buys nothing, so E-STOP does not stand in its way');
    rig.dispose();
  });
  /* ---- the job's own $ limit and the line's day limit, against the SAVED ceilings ---- */
  await allocated(async env => {
    const h = await held(env, { run: { seed: { limits: { maxHops: 8, maxUsdPerMessage: 0.04 } } } });   // entry .02 + two stages .01 = the $0.04 limit it was admitted with
    A.eq([h.c.accounting.limits.maxUsd, h.c.accounting.entryUsd + h.c.accounting.hopUsd], [0.04, 0.04], 'the job held with its limit exactly reached');
    await refused('the job\'s $ limit', env, h, /already spent its \$0\.04 limit/);
    h.rig.dispose();
  });
  await allocated(async env => {
    const h = await held(env, { run: { seed: { limits: { maxHops: 8, maxUsdPerMessage: 2, maxUsdPerDay: 5 } } } });
    h.rig.day.spent = () => 5;   // today the line has spent its $5
    await refused('the line\'s day limit', env, h, /already spent its \$5\.00 for today/);
    h.rig.dispose();
  });
  await allocated(async env => {
    const h = await held(env, { run: { seed: { limits: { maxHops: 8, maxUsdPerMessage: 2, maxUsdPerDay: 5 } } } });
    h.rig.day.spent = () => 4.99;
    const r = h.owner.resume(h.id, say(h.c, 'approve', 'tok-1'));
    A.eq([r.code, r.running], [202, true], 'control: just under the day limit, the same decision goes on');
    await r.done;
    h.rig.dispose();
  });
  /* ---- the files the work carries: altered, then gone ---- */
  await allocated(async env => {
    const h = await held(env, { rig: { files: true } });
    A.ok(h.c.files.length > 0 && h.c.files.every(f => f.digest && f.size >= 0), 'the held work carries files with exact receipts: ' + h.c.files.map(f => f.path.split(/[\\/]/).pop()).join(', '));
    fs.appendFileSync(h.c.files[0].path, ' — edited by someone else');
    await refused('an altered file', env, h, /file the work carries was changed while this job waited/);
    h.rig.dispose();
  });
  await allocated(async env => {
    const h = await held(env, { rig: { files: true } });
    fs.rmSync(h.c.files[0].path);
    await refused('a missing file', env, h, /file the work carries cannot be read any more/);
    h.rig.dispose();
  });
  await allocated(async env => {   // control: untouched files resume
    const h = await held(env, { rig: { files: true } });
    const r = h.owner.resume(h.id, say(h.c, 'approve', 'tok-1'));
    A.eq([r.code, r.running], [202, true], 'control: files exactly as saved — the decision goes on');
    await r.done;
    A.eq(get(env, h.id).status, 'delivered', 'and delivers');
    h.rig.dispose();
  });
  A.report('line-hold.authority');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.authority'); });
