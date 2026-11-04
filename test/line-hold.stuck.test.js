/* node test/line-hold.stuck.test.js — A WALK THE STATION DIED IN HAS A WAY OUT (line-hold lane; invariant a-crash-never-strands-a-job).

   After a person decides a held job, it runs as a chain of verified writes: the decision adopted, a stage's intent, its observed result, the
   accepted end, the job's own finish, the release. A death between any two used to leave a job that nothing could move: not held (a decision
   claims a held checkpoint, once), not running, not trimmed (retention keeps every open walk, so each one held a slot for good and kept its
   chat-derived draft), and its only button was SEND IT AGAIN, which buys the whole job again. The same decision again answered "replayed" and
   did nothing; a STOP was refused; DELETE answered stopRequested: false.

   The family, on the station's own code (the real router, chain, runner, store and resume owner, and the real route handler compiled out of
   sidecar/index.js; only the provider and the clock are fakes): kill the owner between each pair of verified writes of a resumed walk, restart
   the station, and press STOP (DELETE on the job). After the restart the record is the open walk it was; STOP reaches a FINISHED job, buys
   nothing (no provider call, no spend noted), counts what ran (a stage whose result was never written is written down as what is known of it),
   leaves nothing active, and the finished record is one retention can drop. A held job, a finished job and a walk something still carries are
   never touched by it. */
'use strict';
const vm = require('node:vm');
const A = require('./_assert.js');
const Source = require('./helpers/source.js');
const LineResume = require('../sidecar/routing/line-resume.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig, AFTER } = require('./helpers/line-hold-rig.js');

const REVISE = 'not yet\nVERDICT: revise', BLOCKED = 'no\nVERDICT: blocked';
const get = (host, id) => J.get(host.jobs(), id);

// the station's own route handler for /api/line-jobs/<id> (index.js handleLineJobId), compiled out of the host over the real owner and store
function routeOf(host, rig, owner) {
  const index = Source.readSidecarIndex();
  const a = index.indexOf('function resumeBody(r) {'), b = index.indexOf("const SAMPLE_CHAT = 'sample';", a);
  if (a < 0 || b <= a) throw new Error('the line-job route block is missing from sidecar/index.js');
  const scope = { LineJobs: J, LineResume, lineResume: owner, lineRunner: rig.runner, lineJobsRefreshForRead: () => {}, lineJobsStorageStatus: () => ({}),
    respondJson: (res, code, body) => { res.out = { code, body }; }, readBody: async () => '', failNote: () => {} };
  const make = vm.compileFunction('let lineJobs = null, lineJobsStorageIssue = null;\n' + index.slice(a, b) + '\nreturn { handleLineJobId, set: v => { lineJobs = v; } };', Object.keys(scope));
  const route = make(...Object.values(scope));
  return async (method, id, suffix) => { route.set(host.jobs()); const res = {}; await route.handleLineJobId({ method, url: '/api/line-jobs/' + id + (suffix || '') }, res, [null, id, suffix]); return res.out; };
}

/* One crash: the job held, APPROVE pressed, and the owner dies as it is asked for its K-th verified write of the walk (1 the adoption, 2 a stage's intent,
   3 its result, 4 the accepted end) so the record is left as write K-1 made it, or (5) when the job's own finish is asked for, after the accepted end was
   written. Then a RESTART: a new station over the saved file. */
async function crashed(env, kill) {
  const rig = makeRig({ wiring: AFTER }).wire(env.host);
  rig.reply = x => x.agentId === 'publisher' ? 'PUBLISHED' : 'another draft';
  const ran = await rig.run({ replies: [REVISE, BLOCKED] });
  rig.settle(ran.job, ran.line);
  const id = ran.job.id, c0 = get(env.host, id).continuation;
  A.ok(ran.line.held && get(env.host, id).status === 'held', 'the job is parked as a hold');
  let n = 0, dead = false;
  const die = () => { dead = true; throw new Error('fixture: the process is gone'); };
  const store = Object.assign({}, env.host.store, { advance: (...a) => { if (dead || ++n === kill) die(); return env.host.store.advance(...a); } });
  if (kill === 5) { const was = rig.jobs.finish; rig.jobs.finish = (...a) => { if (n >= 4) die(); return was(...a); }; }
  const owner = rig.owner(env.host, { store });
  const r = owner.resume(id, { action: 'approve', token: 'tok-1', revision: c0.revision, note: '' });
  if (r.done) await r.done;
  const callsBefore = rig.calls.length;
  // THE RESTART: the saved file is read again (the station's boot pass turns a stage that was written down and never recorded into an uncertain one)
  const host2 = env.loadHost(), rig2 = makeRig({ wiring: AFTER, idBase: 100000 * kill, clockBase: 1000 + 1000000 * kill }).wire(host2);
  rig2.reply = rig.reply;
  const owner2 = rig2.owner(host2);
  return { rig, rig2, host2, owner2, id, c0, callsBefore, route: routeOf(host2, rig2, owner2) };
}

(async () => {
  const KILLS = [[2, 'after the decision was adopted, before the first stage was written down'], [3, 'after a stage\'s intent, before its result'],
    [4, 'after a stage\'s result, before the accepted end'], [5, 'after the accepted end, before the job finished']];
  for (const [kill, label] of KILLS) {
    await allocated(async env => {
      const h = await crashed(env, kill), { host2, id } = h;
      const before = get(host2, id), c = before.continuation;
      A.ok(!['delivered', 'stopped', 'held'].includes(before.status) && before.endedAt === null && c.phase !== 'complete' && c.phase !== 'held',
        label + ': after the restart the job is an open walk nothing carries: ' + JSON.stringify([before.status, before.endedAt, c.phase, c.activeDecision]));
      A.ok(LineResume.stuck(before), label + ': the resume owner knows it for one');
      // the old failure, named: the same decision again does nothing, a new APPROVE is refused, a STOP decision is refused
      if (kill > 2) {   // (a decision adopted and never started is the one the same decision carries on: the existing CARRY IT OUT; STOP is the other way out)
        A.eq([h.owner2.resume(id, { action: 'approve', token: 'tok-1', revision: h.c0.revision, note: '' }).code, h.owner2.resume(id, { action: 'stop', token: 'tok-9', revision: c.revision, note: '' }).code], [200, 409],
          label + ': the same decision again answers "replayed" and a STOP decision is refused: neither moves it');
      }
      const spent = c.attempts.filter(a => a.state === 'observed').reduce((n, a) => n + a.usd, 0), world = h.rig2.world();
      // STOP: DELETE on the job, through the station's own route
      const out = await h.route('DELETE', id);
      A.eq([out.code, out.body.stopRequested, out.body.stopped], [200, true, true], label + ': DELETE on the job is accepted: ' + JSON.stringify(out.body).slice(0, 200));
      const job = get(host2, id), k = job.continuation;
      A.eq([job.status, job.outcome, job.endedAt !== null, k.phase, k.activeDecision, k.terminal && k.terminal.outcome, k.terminal && k.terminal.stop && k.terminal.stop.code], ['stopped', 'stopped', true, 'complete', null, 'stopped', 'stopped'],
        label + ': it reaches a FINISHED job: stopped, complete, nothing active');
      A.ok(k.attempts.every(a => a.state === 'observed') && k.decisions.every(d => d.state === 'complete' || d.state === 'refused'), label + ': every stage and every decision is closed');
      A.ok(k.publication === null || k.publication.state === 'suppressed', label + ': nothing was published' + (k.publication ? ' (suppressed)' : ''));
      // (the job's own finish is the one write the close makes: the world's fingerprint is otherwise as it was)
      const moved = JSON.parse(h.rig2.world()), was = JSON.parse(world);
      A.eq([h.rig2.calls.length, h.rig2.notes.length, Object.assign({}, moved, { finish: 0 }), moved.finish - was.finish], [0, 0, Object.assign({}, was, { finish: 0 }), 1], label + ': nothing was bought, nothing noted, nothing delivered; the job finished once');
      A.ok(Math.abs(job.usd - spent) < 1e-9, label + ': what already ran is counted: $' + job.usd + ' (the observed stages\' own ' + spent + ')');
      if (kill === 3) A.ok(k.attempts.some(a => a.usageMissing === true && a.usd === 0 && a.outcome === 'interrupted'), label + ': the stage whose result was never written is written down as unknown cost, no spend');
      // it is done: a second STOP asks for nothing, and the finished record is an ordinary one that retention can drop
      const again = await h.route('DELETE', id);
      A.eq([again.code, again.body.stopRequested], [200, false], label + ': a second STOP asks for nothing');
      const fillers = [];
      for (let i = 0; i < 125; i++) fillers.push({ id: 'job-f' + String(i).padStart(11, '0'), line: job.line, text: 't', streamId: 's' + i, status: 'delivered', outcome: 'delivered', startedAt: 5e12 + i, endedAt: 5e12 + i + 1, usd: 0, output: 'x', runs: [] });
      const fresh = J.normalizeAll(JSON.parse(JSON.stringify({ jobs: [JSON.parse(JSON.stringify(job))].concat(fillers) })));
      const open = J.normalizeAll(JSON.parse(JSON.stringify({ jobs: [JSON.parse(JSON.stringify(before))].concat(fillers) })));
      A.eq([fresh.jobs.length, fresh.jobs.some(j => j.id === id), open.jobs.some(j => j.id === id)], [J.MAX_JOBS, false, true],
        label + ': once closed retention drops it with the rest of the oldest history (left open it kept its slot for good)');
      h.rig.dispose(); h.rig2.dispose();
    });
  }

  /* ---- what STOP never touches ---- */
  await allocated(async env => {
    const h = await crashed(env, 3), { host2, id } = h;
    h.owner2.inflight.set(id, { runId: 'r', abort: new AbortController() });   // a walk something still carries
    const out = await h.route('DELETE', id);
    A.eq([out.code, get(host2, id).status, h.rig2.calls.length], [409, get(host2, id).status, 0], 'a walk something still carries is never closed from under it');
    A.ok(get(host2, id).endedAt === null, '…it stays open');
    h.owner2.inflight.delete(id);
    h.rig.dispose(); h.rig2.dispose();
  });
  await allocated(async env => {
    const rig = makeRig({ wiring: AFTER }).wire(env.host);
    rig.reply = x => x.agentId === 'publisher' ? 'PUBLISHED' : 'another draft';
    const ran = await rig.run({ replies: [REVISE, BLOCKED] });
    rig.settle(ran.job, ran.line);
    const owner = rig.owner(env.host), route = routeOf(env.host, rig, owner), id = ran.job.id;
    A.eq(owner.closeStuck(id).code, 409, 'a HELD job is not a walk the station died in: closeStuck refuses it (its STOP is the decision)');
    A.eq(get(env.host, id).status, 'held', '…and it is still held');
    const done = await route('DELETE', id);
    A.eq([done.code, get(env.host, id).status, get(env.host, id).continuation.terminal && get(env.host, id).continuation.terminal.stop.code], [200, 'stopped', 'stopped'], 'control: DELETE on a held job is still the STOP decision');
    A.eq(owner.closeStuck(id).code, 409, 'and a finished job is not one either');
    rig.dispose();
  });
  A.report('line-hold.stuck');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.stuck'); });
