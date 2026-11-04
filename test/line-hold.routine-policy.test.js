/* node test/line-hold.routine-policy.test.js — A RESUMED STAGE STAYS INSIDE THE LIMITS ITS JOB WAS ADMITTED UNDER (line-hold lane; invariant resume-never-widens).

   A scheduled or Run Now job runs its hops under the ROUTINE'S configuration: its tool families (enabledToolsets: a restriction-only list that
   also strips connector, MCP and plugin tools), its working folder and its skills. A job that parks at a reviewer's gate saves how it came in
   (the routine and a digest of that configuration), and a person's APPROVE resumed it under a plain channel profile that read none of it: the
   stage after the gate ran with every tool family back, no folder and no required skills — at exactly the stage where the work in front of
   the model was built from untrusted text. Dropping a restriction is a widening.

   The family, through the station's own code (resumeProfileFor and holdAuthority are compiled out of sidecar/index.js): for every way a job comes
   in (a chat, a scheduled fire, Run Now, a webhook, SEND TO, a sample), the options a resumed stage's run receives are at least as restrictive as
   the ones the original stages received — the tool families a subset, the same folder and skills, untrusted entry, no owner trust, power
   withheld — and a decision on a routine's job is refused when the routine is gone or no longer says what the job was admitted with (the
   job stays held; a STOP is never refused). */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const Source = require('./helpers/source.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig, AFTER } = require('./helpers/line-hold-rig.js');

const REVISE = 'not yet\nVERDICT: revise', BLOCKED = 'no\nVERDICT: blocked';
// a routine's job record (the cron store's), narrowed to what its hops run under
const ROUTINE = { id: 'cron_demo', skills: ['skill-a', 'skill-b'], workdir: 'C:/work/routine-dir', enabledToolsets: ['web'] };
const cfg = () => ({ ok: true, model: 'rig-model', key: 'k', configured: true });
const grab = x => ({ agentId: x.agentId, enabledToolsets: x.enabledToolsets, workdir: x.workdir, preloadSkills: x.preloadSkills, requiredPreloads: x.requiredPreloads,
  ownerTrusted: x.ownerTrusted, untrustedEntry: x.untrustedEntry, channelSender: x.channelSender, channelSenderOwner: x.channelSenderOwner });
const get = (env, id) => J.get(env.host.jobs(), id);
let restarts = 0;

// the profile each door's hub / seam really builds for its stages (line-runner.js profiles)
function profileFor(rig, kind, policy) {
  const P = rig.runner.profiles, base = { streamId: 's', config: cfg, system: () => 'routine system', station: () => null };
  if (kind === 'schedule') return P.schedule(Object.assign({ routine: policy }, base));
  if (kind === 'manual') return P.manual(Object.assign({ routine: policy }, base));
  // a chat's hub: the owner's own channel keeps the owner's trust; the other doors' hubs run the stages as channel senders
  return P.channel({ channel: kind, chatId: 'chat-1', streamId: 's', config: cfg, persona: () => 'a stage', station: () => null,
    ownerTrusted: kind === 'channel', untrustedEntry: kind !== 'channel', channelSender: kind !== 'channel', channelSenderOwner: false });
}

(async () => {
  /* ---- 1. the helper the resume reads a routine's configuration by is spelled exactly as the two seams that start a routine's job spell it ---- */
  {
    const rig = makeRig();
    const wanted = rig.ports.routinePolicyOf(ROUTINE);
    A.eq(wanted, { preloadSkills: ['skill-a', 'skill-b'], requiredPreloads: true, workdir: 'C:/work/routine-dir', enabledToolsets: ['web'] }, 'a routine\'s configuration: its skills, required preloads, folder and tool families');
    A.eq(rig.ports.routinePolicyOf({ id: 'x' }), { preloadSkills: [], requiredPreloads: true, workdir: null, enabledToolsets: null }, 'a routine with none of them runs unrestricted, as it always did');
    const cron = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'cron-driver.js'), 'utf8');
    const props = Source.objectProps(Source.callRegion(cron, 'Promise.resolve(advanceChain({', '})).then('));
    const scheduled = {};
    for (const k of ['preloadSkills', 'requiredPreloads', 'workdir', 'enabledToolsets']) {
      const p = props.find(x => x.key === k);
      A.ok(p, 'the scheduled fire passes ' + k);
      scheduled[k] = new Function('job', 'return (' + p.expr + ');')(ROUTINE);   // eslint-disable-line no-new-func
    }
    A.eq(scheduled, wanted, 'the scheduled fire hands its hops exactly that configuration');
    const index = Source.readSidecarIndex();
    const pressed = Source.liftProp(Source.callRegion(index, 'profile: LineRunner.profiles.manual({', '}) });'), 'routine');
    A.ok(pressed.length > 20, 'Run Now passes its routine configuration');
    A.eq(new Function('job', 'return (' + pressed + ');')(ROUTINE), wanted, 'and Run Now hands its hops exactly that configuration');   // eslint-disable-line no-new-func
    rig.dispose();
  }

  /* ---- 2. the class: for every door, a resumed stage's options are at least as restrictive as the original stages' ---- */
  const DOORS = [['channel', 'channel'], ['schedule', 'schedule'], ['manual', 'manual'], ['trigger', 'trigger'], ['sendto', 'sendto'], ['sample', 'sample']];
  for (const [label, entry] of DOORS) {
    await allocated(async env => {
      const routine = entry === 'schedule' || entry === 'manual';
      const rig = makeRig({ wiring: AFTER }).wire(env.host);
      rig.reply = x => x.agentId === 'publisher' ? 'PUBLISHED' : 'another draft';
      rig.cron.push(Object.assign({}, ROUTINE));
      const origin = routine ? { routineId: ROUTINE.id, fireRunId: 'fire-1', policy: rig.ports.routinePolicyOf(ROUTINE) } : undefined;
      const original = [];
      rig.beforeCall = x => original.push(grab(x));
      const ran = await rig.run({ entry, origin, replies: [REVISE, BLOCKED], profile: profileFor(rig, entry, rig.ports.routinePolicyOf(ROUTINE)) });
      rig.settle(ran.job, ran.line);
      const id = ran.job.id, c0 = get(env, id).continuation;
      A.ok(ran.line.held && !ran.line.holdFailed && c0 && c0.phase === 'held' && c0.origin.kind === entry, label + ': the job is held, admitted by the ' + entry + ' door: ' + (ran.line.holdFailed || ''));
      const hops = original.filter(o => o.agentId === 'drafter' || o.agentId === 'reviewer').slice(1);   // the stages after the entry run
      A.ok(hops.length >= 1, label + ': the original stages ran under the door\'s profile');

      restarts++;
      const host2 = env.loadHost(), rig2 = makeRig({ wiring: AFTER, idBase: 100000 * restarts, clockBase: 1000 + 1000000 * restarts }).wire(host2);
      rig2.reply = rig.reply;
      rig2.cron.push(Object.assign({}, ROUTINE));
      const resumed = [];
      rig2.beforeCall = x => resumed.push(grab(x));
      const r = rig2.owner(host2).resume(id, { action: 'approve', token: 'tok-1', revision: c0.revision, note: '' });
      A.eq([r.code, r.ok], [202, true], label + ': APPROVE is carried on');
      await r.done;
      A.eq([get({ host: host2 }, id).status, resumed.map(x => x.agentId)], ['delivered', ['publisher']], label + ': the stage after the gate ran once');
      const was = hops[0], now = resumed[0];
      // never trusted, never with power: whatever the job ran under
      A.eq([now.untrustedEntry, !!now.ownerTrusted, now.channelSender, !!now.channelSenderOwner], [true, false, true, false], label + ': the resumed stage is untrusted, owner-less and power-withheld');
      // the tool families can only narrow: unrestricted before = any; a list before = a subset now
      A.ok(was.enabledToolsets == null || (Array.isArray(now.enabledToolsets) && now.enabledToolsets.every(t => was.enabledToolsets.indexOf(t) >= 0)),
        label + ': the resumed stage\'s tool families ' + JSON.stringify(now.enabledToolsets) + ' are inside the original\'s ' + JSON.stringify(was.enabledToolsets));
      A.eq([now.workdir, now.preloadSkills, now.requiredPreloads], [was.workdir, was.preloadSkills, was.requiredPreloads], label + ': the same folder and the same required skills');
      if (routine) A.eq([now.enabledToolsets, now.workdir, now.preloadSkills, now.requiredPreloads], [['web'], 'C:/work/routine-dir', ['skill-a', 'skill-b'], true], label + ': the routine\'s own limits, not the defaults');
      rig.dispose(); rig2.dispose();
    });
  }

  /* ---- 3. a decision on a routine's job is refused when the routine is gone or changed; the job stays held ---- */
  for (const entry of ['schedule', 'manual']) {
    const held = async (env, rigOver) => {
      const rig = makeRig(Object.assign({ wiring: AFTER }, rigOver)).wire(env.host);
      rig.reply = x => x.agentId === 'publisher' ? 'PUBLISHED' : 'another draft';
      rig.cron.push(Object.assign({}, ROUTINE));
      const ran = await rig.run({ entry, origin: { routineId: ROUTINE.id, fireRunId: 'fire-1', policy: rig.ports.routinePolicyOf(ROUTINE) }, replies: [REVISE, BLOCKED], profile: profileFor(rig, entry, rig.ports.routinePolicyOf(ROUTINE)) });
      rig.settle(ran.job, ran.line);
      A.ok(ran.line.held && !ran.line.holdFailed, entry + ': the routine\'s job is held: ' + (ran.line.holdFailed || ''));
      return { rig, id: ran.job.id, owner: rig.owner(env.host) };
    };
    const refused = async (label, env, h, mutate, why) => {
      mutate(h.rig.cron);
      const c = get(env, h.id).continuation, calls = h.rig.calls.length, world = h.rig.world();
      const r = h.owner.resume(h.id, { action: 'approve', token: 'tok-1', revision: c.revision, note: '' });
      A.eq([r.code, r.ok, r.refused], [409, false, true], entry + ' / ' + label + ': the decision is refused (409)');
      A.ok(why.test(r.error), entry + ' / ' + label + ': it says why — ' + r.error);
      const k = get(env, h.id);
      A.eq([k.status, k.continuation.phase, k.continuation.decisions.map(d => [d.token, d.state])], ['held', 'held', [['tok-1', 'refused']]], entry + ' / ' + label + ': the job stays HELD, its decision marked refused');
      A.eq([h.rig.calls.length, h.rig.world()], [calls, world], entry + ' / ' + label + ': nothing was bought and nothing delivered');
      const stop = h.owner.resume(h.id, { action: 'stop', token: 'tok-2', revision: get(env, h.id).continuation.revision, note: '' });
      A.eq([stop.code, get(env, h.id).status, h.rig.calls.length], [200, 'stopped', calls], entry + ' / ' + label + ': STOP is never refused: it buys nothing');
    };
    await allocated(async env => {
      const h = await held(env);
      await refused('the routine\'s tool families were widened', env, h, cron => { cron[0].enabledToolsets = null; }, /routine .* was changed while it waited/);
      h.rig.dispose();
    });
    await allocated(async env => {
      const h = await held(env);
      await refused('its folder was changed', env, h, cron => { cron[0].workdir = 'C:/elsewhere'; }, /was changed while it waited/);
      h.rig.dispose();
    });
    await allocated(async env => {
      const h = await held(env);
      await refused('the routine was deleted', env, h, cron => { cron.length = 0; }, /routine .* is gone/);
      h.rig.dispose();
    });
    await allocated(async env => {   // control: a routine edited in a way its hops do not read (its prompt, its name) changes nothing
      const h = await held(env);
      h.rig.cron[0].prompt = 'a new prompt'; h.rig.cron[0].name = 'renamed';
      const c = get(env, h.id).continuation, r = h.owner.resume(h.id, { action: 'approve', token: 'tok-1', revision: c.revision, note: '' });
      A.eq([r.code, r.running], [202, true], entry + ' / control: a routine edited in a way its stages do not read still resumes');
      await r.done;
      A.eq(get(env, h.id).status, 'delivered', entry + ' / control: and delivers');
      h.rig.dispose();
    });
  }
  A.report('line-hold.routine-policy');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.routine-policy'); });
