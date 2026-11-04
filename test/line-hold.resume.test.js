/* node test/line-hold.resume.test.js — A HELD JOB RESUMES FROM ITS CURSOR (line-hold lane, S4; invariant approve-resumes-from-the-cursor).

   The hold is the S3 one (the real router, chain and LineRunner over the station's own verified job writer); the resume is the station's
   one owner (routing/line-resume.js) over the same real store, the same authority the host builds (index.js holdAuthority) and the
   same hop executor. Only the provider and the clock are fakes.

     1. APPROVE on the floor whose done lane reaches the OUTBOX: the delivered text is the saved draft byte for byte, no stage runs and
        none is bought, the saved spend is not noted again, there is ONE OUTBOX delivery, and the saved record walks held -> held
        (claimed) -> ready -> terminal_pending -> complete in that order.
     2. APPROVE on a floor with a paid stage after the gate: that stage runs ONCE from the saved cursor (no earlier stage reruns), is
        handed the saved draft and nothing of the reviewer's block, is written down BEFORE the provider is called (the preminted run id)
        and AFTER it, and runs UNTRUSTED and POWER-WITHHELD although the job ran trusted. The original ceilings still bound the rest.
     3. SEND BACK carries the note, the pass count moves on by one (the gate's cap is not reset), and a second block saves a SECOND hold
        on the same job with every receipt and decision carried over; APPROVE of that hold delivers.
     4. STOP buys nothing: no provider call, no day-ledger note, finished 'stopped' with an owned stop, no delivery.
     5. A stage whose intent cannot be saved is never bought; a crash after an intent leaves the attempt UNCERTAIN and nothing runs it.
     6. The ceilings in the chain itself: a walk resumed under a saved $ limit it has already reached buys nothing, whatever the floor says. */
'use strict';
const A = require('./_assert.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig, AFTER } = require('./helpers/line-hold-rig.js');
const Verdict = require('../frontend/app/line-verdict.js');

const REVISE = 'not yet\nVERDICT: revise', BLOCKED = 'no\nVERDICT: blocked', DRAFT = 'another draft';
const get = (env, id) => J.get(env.host.jobs(), id);
const cont = (env, id) => get(env, id).continuation;
// the steps of a saved job as the file shows them, one per verified write: job status : phase[:publication][+ the active decision's state]
function watch(env, id) {
  const steps = [];
  env.f.onWrite = (file, value) => {
    if (file !== env.jobFile) return;
    const j = value.jobs.find(x => x.id === id), c = j && j.continuation;
    if (c) steps.push(j.status + ':' + c.phase + (c.publication ? ':' + c.publication.state : '') + (c.activeDecision ? '+' + c.decisions.find(d => d.token === c.activeDecision).state : ''));
  };
  return steps;
}
// the job down the line to its hold, settled the way the hub settles it, with the real store under the runner
async function held(env, o) {
  const rig = makeRig(Object.assign({}, o)).wire(env.host);
  const ran = await rig.run({ replies: (o && o.replies) || [REVISE, BLOCKED] });
  rig.settle(ran.job, ran.line);
  const id = ran.job.id;
  A.ok(ran.line.held && !ran.line.holdFailed && get(env, id).status === 'held', 'the job is parked as a hold: ' + (ran.line.holdFailed || ''));
  return { rig, id, owner: rig.owner(env.host) };
}
const decide = (owner, id, c, action, token, note) => owner.resume(id, { action, token, revision: c.revision, note: note || '' });

(async () => {
  /* ---- 1. APPROVE, the done lane straight to the OUTBOX: the saved draft, byte for byte ---- */
  await allocated(async env => {
    const { rig, id, owner } = await held(env), c0 = cont(env, id);
    A.eq([c0.revision, c0.hold.pass, c0.walk.lastHanded, c0.walk.product.text, c0.restriction.entryUntrusted, c0.restriction.hostPowerWithheld], [1, 1, DRAFT, BLOCKED, false, false],
      'held at pass 1 on the draft under review; the saved restriction says the job ran trusted and with power kept');
    const steps = watch(env, id), world = rig.world(), spent = c0.accounting.entryUsd + c0.accounting.hopUsd, notes = rig.notes.slice();
    const r = decide(owner, id, c0, 'approve', 'tok-1', '');
    A.eq([r.code, r.ok, r.running], [202, true, true], 'APPROVE is claimed and carried on');
    const out = await r.done, job = get(env, id), c = job.continuation;
    A.eq([job.status, job.outcome, out.delivered, job.output], ['delivered', 'delivered', true, DRAFT], 'the job DELIVERED, and the delivered text is the saved draft byte for byte');
    A.eq(rig.calls.length, 2, 'no stage ran again and none was bought: the two provider calls are the ones before the hold');
    A.eq(rig.notes, notes, 'the saved spend was not noted again (the legacy day ledger counted it when it was spent)');
    A.eq([rig.world() === world, JSON.parse(rig.world()).lineOutputs, JSON.parse(rig.world()).shipped, JSON.parse(rig.world()).finish, JSON.parse(world).finish],
      [false, 1, 1, 1, 0], 'ONE OUTBOX delivery: one line-output, one shipment, one finish');
    A.ok(Math.abs(job.usd - spent) < 1e-12 && c.accounting.entryUsd + c.accounting.hopUsd === spent, 'the job costs what it cost: the saved spend, once');
    A.eq(steps, ['held:held+accepted', 'running:ready+adopted', 'running:terminal_pending:pending', 'delivered:terminal_pending:pending', 'delivered:terminal_pending:uncertain', 'delivered:complete:confirmed'],
      'the saved record walks claimed -> ready (adopted) -> terminal_pending -> the strict finish of the job itself -> publication uncertain BEFORE the release -> complete (confirmed)');
    A.eq([c.phase, c.activeDecision, c.decisions.map(d => [d.token, d.action, d.state]), c.publication.state, c.terminal.outcome, c.terminal.output], ['complete', null, [['tok-1', 'approve', 'complete']], 'confirmed', 'delivered', DRAFT],
      'complete: the decision done, the publication confirmed, the terminal result the saved draft');
    A.eq([c.walk.product.text, c.walk.lastHanded, c.hold, c.accounting.limits.maxHops], [BLOCKED, DRAFT, null, c0.accounting.limits.maxHops], 'the walk the person approved was never rewritten');
    // a replay of the same decision, after it finished, is the SAVED receipt: nothing runs, nothing is delivered twice
    const again = decide(owner, id, c0, 'approve', 'tok-1', '');
    A.eq([again.code, again.replayed, again.receipt.state, rig.calls.length, JSON.parse(rig.world()).lineOutputs], [200, true, 'complete', 2, 1], 'the same decision again answers the saved receipt and buys nothing');
    rig.dispose();
  });

  /* ---- 2. APPROVE with a paid stage after the gate: it runs once, from the cursor, untrusted and withheld ---- */
  await allocated(async env => {
    const { rig, id, owner } = await held(env, { wiring: AFTER });
    rig.reply = x => x.agentId === 'publisher' ? 'PUBLISHED: ' + x.messages[x.messages.length - 1].content : DRAFT;
    const c0 = cont(env, id), calls0 = rig.calls.slice(), notes0 = rig.notes.length, usd0 = c0.accounting.hopUsd;
    const seen = {};
    rig.beforeCall = x => {   // the world at the moment the provider is called: the saved record already says this stage is coming
      const c = cont(env, id), last = c.attempts[c.attempts.length - 1];
      seen.phase = c.phase; seen.attempt = last; seen.runId = x.runId; seen.revision = c.revision;
    };
    const steps = watch(env, id);
    const out = await decide(owner, id, c0, 'approve', 'tok-1').done, job = get(env, id), c = job.continuation;
    A.eq(rig.calls, calls0.concat(['publisher']), 'the next stage ran ONCE from the saved cursor: no earlier stage reran');
    A.eq([seen.phase, seen.attempt.runId === seen.runId, seen.attempt.state, seen.attempt.usd, seen.attempt.node], ['intent', true, 'intent', null, { agentId: 'publisher', dockId: 'p6' }],
      'its INTENT was saved before the provider was called, under the run id the provider got');
    const att = c.attempts[c.attempts.length - 1];
    A.eq([att.runId, att.state, att.usd, att.outcome, att.ordinal, c.attempts.length], [seen.runId, 'observed', 0.01, 'succeeded', 4, 4], 'and its result after: observed, what it cost, how it ended');
    A.ok(Math.abs(c.accounting.hopUsd - (usd0 + 0.01)) < 1e-12 && rig.notes.length === notes0 + 1, 'only the new stage was added to the spend and the day ledger');
    const call = rig.seen[rig.seen.length - 1];
    A.ok(call.prompt.includes(DRAFT) && !call.prompt.includes('VERDICT: blocked') && !call.prompt.includes(BLOCKED), 'it was handed the saved draft, not the reviewer\'s block');
    A.eq([call.untrustedEntry, call.ownerTrusted, call.channelSender, call.channelSenderOwner, call.surface, call.unattendedGrants],
      [true, false, true, false, 'autonomous', []], 'it ran UNTRUSTED and POWER-WITHHELD with no grants — the saved "trusted, power kept" was a record, not an authority');
    A.eq([job.status, out.delivered, job.output.startsWith('PUBLISHED: '), c.publication.outboxId], ['delivered', true, true, 'p8'], 'delivered at the OUTBOX past the stage');
    A.eq(steps, ['held:held+accepted', 'running:ready+adopted', 'running:intent', 'running:ready', 'running:terminal_pending:pending', 'delivered:terminal_pending:pending', 'delivered:terminal_pending:uncertain', 'delivered:complete:confirmed'],
      'the record around the paid stage: ready -> intent -> ready, the decision completed by the first step after it');
    A.eq(c.decisions[0].state, 'complete', 'the decision is done');
    rig.dispose();
  });

  /* ---- 3. SEND BACK: the note goes round, the pass count moves on (never a reset), a second block is a SECOND hold ---- */
  await allocated(async env => {
    const { rig, id, owner } = await held(env, { replies: [REVISE, BLOCKED, BLOCKED, 'Looks good.\nVERDICT: approved'] });
    rig.reply = x => x.agentId === 'drafter' ? 'revised draft after: ' + (x.messages[x.messages.length - 1].content.includes('cut the second paragraph') ? 'the note' : 'nothing') : DRAFT;
    const c0 = cont(env, id), g0 = c0.walk.gates[0];
    A.eq([g0.count, g0.max], [1, 6], 'the first hold is on pass 1 of a gate of 6');
    const out = await decide(owner, id, c0, 'send_back', 'tok-1', 'cut the second paragraph').done;
    const job = get(env, id), c = job.continuation, g = c.walk.gates[0];
    A.eq([out.held, job.status, c.phase], [true, 'held', 'held'], 'the reviewer blocked the next pass too: the job is HELD again, on the same job');
    const drafter = rig.seen.filter(s => s.agentId === 'drafter').pop();
    A.ok(drafter.prompt.includes('cut the second paragraph') && drafter.prompt.includes(DRAFT) && drafter.prompt.includes('pass 2 of 6'), 'the drafter was handed the person\'s note, the work under review and "pass 2 of 6"');
    A.eq([g.count, g.max, c.hold.pass, c.hold.gateId], [2, 6, 2, g0.id], 'the pass count moved ON by one and the gate\'s cap was not reset');
    A.eq([c.revision, c.attempts.length, c.attempts.every(a => a.state === 'observed'), c.walk.lastHanded], [8, 5, true, 'revised draft after: the note'], 'the second hold is the next revision, every stage recorded, the revised draft under review');
    A.eq(JSON.stringify([c.binding, c.origin, c.restriction, c.accounting.limits]), JSON.stringify([c0.binding, c0.origin, c0.restriction, c0.accounting.limits]), 'the admission and the original ceilings carried over exactly');
    A.eq(JSON.stringify(c.attempts.slice(0, 3)), JSON.stringify(c0.attempts), 'the saved receipts of the first walk are untouched');
    A.eq([c.decisions.map(d => [d.token, d.action, d.state]), c.activeDecision], [[['tok-1', 'send_back', 'complete']], null], 'the first decision is complete and nothing is active');
    A.ok(Math.abs(c.accounting.hopUsd - 0.04) < 1e-12 && c.accounting.dayReceipts.length === 0, 'the spend is the receipts\' sum: two stages before, two after');
    const world = rig.world();
    // a decision on the second hold: APPROVE delivers its revised draft
    const fin = await decide(owner, id, c, 'approve', 'tok-2').done, done = get(env, id);
    A.eq([done.status, fin.delivered, done.output, rig.world() !== world, rig.calls.length], ['delivered', true, 'revised draft after: the note', true, 4], 'APPROVE of the second hold delivers the revised draft; no stage ran again');
    A.eq(done.continuation.decisions.map(d => d.state), ['complete', 'complete'], 'both decisions are complete');
    rig.dispose();
  });

  /* ---- 4. STOP buys nothing ---- */
  await allocated(async env => {
    const { rig, id, owner } = await held(env, { wiring: AFTER });
    const c0 = cont(env, id), world = rig.world(), notes = rig.notes.slice(), steps = watch(env, id);
    const r = decide(owner, id, c0, 'stop', 'tok-1', 'not this one');
    const job = get(env, id), c = job.continuation;
    A.eq([r.code, r.ok, r.stopped], [200, true, true], 'STOP answers at once (nothing to wait for)');
    A.eq([job.status, job.outcome, job.endedAt !== null, job.stop.code, job.output, c.phase], ['stopped', 'stopped', true, 'stopped', '', 'complete'], 'the job finished STOPPED, delivering nothing');
    A.ok(/a person stopped this job at the gate/.test(job.stop.why), 'and says who: ' + job.stop.why);
    A.eq([rig.calls.length, rig.notes, JSON.parse(rig.world()).lineOutputs, JSON.parse(rig.world()).shipped, JSON.parse(rig.world()).crates], [2, notes, 0, 0, 0], 'no provider call, no day-ledger note, no OUTBOX delivery, no shipment');
    A.eq(JSON.parse(rig.world()).finish - JSON.parse(world).finish, 1, 'finished exactly once');
    A.eq([c.terminal.outcome, c.terminal.stop.code, c.publication, c.decisions.map(d => [d.action, d.state]), c.activeDecision], ['stopped', 'stopped', null, [['stop', 'complete']], null], 'the saved terminal result is the owned stop');
    A.eq(steps, ['held:held+accepted', 'running:terminal_pending', 'stopped:terminal_pending', 'stopped:complete'], 'held -> terminal_pending (the owned stop) -> the strict finish -> complete');
    A.ok(Math.abs(job.usd - (c0.accounting.entryUsd + c0.accounting.hopUsd)) < 1e-12, 'the job costs what it had already cost');
    const again = decide(owner, id, c0, 'stop', 'tok-1', 'not this one');
    A.eq([again.code, again.replayed, rig.calls.length], [200, true, 2], 'a repeated STOP is the saved receipt');
    rig.dispose();
  });

  /* ---- 5. a stage whose intent cannot be saved is never bought; a crash after an intent leaves it UNCERTAIN ---- */
  await allocated(async env => {
    const { rig, id } = await held(env, { wiring: AFTER });
    let n = 0;
    const store = Object.assign({}, env.host.store, { advance: (...a) => { if (++n === 2) throw new Error('fixture: the intent cannot be saved'); return env.host.store.advance(...a); } });   // 1 = the adoption, 2 = the intent
    const owner = rig.owner(env.host, { store }), c0 = cont(env, id);
    const out = await decide(owner, id, c0, 'approve', 'tok-1').done, job = get(env, id);
    A.eq(rig.calls.length, 2, 'no intent, no purchase: the provider was never called');
    A.eq([job.status, job.outcome, job.stop.code], ['stopped', 'stopped', 'station_fault'], 'the job ended on the station\'s own fault, said as one');
    A.ok(/could not save this stage before it ran/.test(job.stop.why), job.stop.why);
    A.eq([out.delivered, JSON.parse(rig.world()).lineOutputs, job.continuation.attempts.length], [false, 0, 3], 'nothing delivered, no attempt invented');
    rig.dispose();
  });
  await allocated(async env => {
    const { rig, id } = await held(env, { wiring: AFTER });
    let crashed = false;
    const store = Object.assign({}, env.host.store, { advance: (...a) => { if (crashed) throw new Error('fixture: the process is gone'); return env.host.store.advance(...a); } });
    const owner = rig.owner(env.host, { store }), c0 = cont(env, id);
    rig.beforeCall = () => { crashed = true; };   // the station dies with the stage in flight: nothing it writes after this reaches the disk
    await decide(owner, id, c0, 'approve', 'tok-1').done;
    const restarted = env.loadHost(), job = J.get(restarted.jobs(), id), c = job.continuation;
    A.eq([job.status, job.outcome, c.phase, c.attempts.map(a => a.state)], ['interrupted', 'interrupted', 'uncertain', ['observed', 'observed', 'observed', 'intent']], 'after the restart the unrecorded stage is UNCERTAIN — whether it was bought is not known');
    const calls = rig.calls.length, again = rig.owner(restarted).resume(id, { action: 'approve', token: 'tok-1', revision: c0.revision, note: '' });
    A.eq([again.code, again.replayed, rig.calls.length], [200, true, calls], 'the decision again buys nothing: it is the saved receipt');
    const other = rig.owner(restarted).resume(id, { action: 'approve', token: 'tok-2', revision: c.revision, note: '' });
    A.eq([other.code, rig.calls.length, J.get(restarted.jobs(), id).continuation.phase], [409, calls, 'uncertain'], 'a new decision is refused: no run touches an uncertain stage until a person reconciles it');
    rig.dispose();
  });

  /* ---- 6. the ceilings in the chain itself: the SAVED $ limit binds the rest, whatever the floor says ---- */
  await allocated(async env => {
    const { rig, id } = await held(env, { wiring: AFTER });
    const c = cont(env, id), spent = c.accounting.entryUsd + c.accounting.hopUsd;
    const run = limits => rig.chain.advance({ agentId: 'reviewer', dockId: 'p3', text: c.walk.product.text, originalText: c.walk.originalText, runId: c.binding.entryRunId, entryUsd: spent,
      lineId: c.binding.lineId, streamId: c.binding.streamId, signal: null, runAgent: async h => { rig.calls.push('chain:' + h.agentId); return { text: 'x', usd: 0.01, runId: 'r-chain', outcome: 'succeeded' }; },
      resume: { walk: c.walk, files: c.files, accounting: Object.assign({}, c.accounting, { limits }), dockMode: true, decision: { action: 'approve', note: '' } } });
    const n = rig.calls.length;
    const tight = await run({ maxHops: 24, maxUsd: spent, maxUsdPerDay: null });
    A.eq([tight.stop && tight.stop.code, rig.calls.length], ['usd_limit', n], 'a job resumed with the $ limit it was saved under, already reached, buys nothing');
    const wide = await run({ maxHops: 24, maxUsd: spent + 5, maxUsdPerDay: null });
    A.eq([wide.stopped, rig.calls[n]], [null, 'chain:publisher'], 'control: the same walk under a wider saved limit runs the next stage');
    A.ok(Verdict.VERDICT_WORDS.includes('approved'), 'the verdict channel is the shared one');
    rig.dispose();
  });
  /* ---- 7. a second hold that cannot be saved ends the old way, the reason said ---- */
  await allocated(async env => {
    const { rig, id } = await held(env, { replies: [REVISE, BLOCKED, BLOCKED] });
    let n = 0;
    const store = Object.assign({}, env.host.store, { advance: (...a) => { if (++n === 6) throw new Error('fixture: the second hold cannot be saved'); return env.host.store.advance(...a); } });   // 1 adoption, 2-5 two stages, 6 = the second hold
    const owner = rig.owner(env.host, { store }), c0 = cont(env, id);
    const out = await decide(owner, id, c0, 'send_back', 'tok-1', 'again').done, job = get(env, id);
    A.eq([out.held, job.status, job.outcome, job.stop.code, job.endedAt !== null, rig.calls.length], [undefined, 'problem', 'blocked', 'blocked', true, 4], 'the job ended the old terminal blocked stop');
    A.ok(/could not be saved as a hold/.test(job.stop.why) && /second hold cannot be saved/.test(job.stop.why), 'and its record says why it was not held again: ' + job.stop.why);
    A.eq([job.continuation.phase, job.continuation.decisions.map(d => d.state), job.continuation.publication, JSON.parse(rig.world()).lineOutputs, JSON.parse(rig.world()).shipped], ['complete', ['complete'], null, 0, 0], 'finished and complete, nothing delivered, nothing shipped');
    rig.dispose();
  });

  /* ---- 8. no entry takes a handle on a held job but the resume owner, and only for a decision it has claimed ---- */
  await allocated(async env => {
    const { rig, id } = await held(env), job = get(env, id), where = { id, line: job.line, streamId: job.streamId, entry: 'channel' };
    A.throws(() => rig.runner.open(where), 'an ordinary entry cannot take a handle on a held job (it is not running)');
    A.throws(() => rig.runner.openResumed(where), 'nor can the resume owner, until a decision on it is claimed');
    env.host.store.claim(id, { token: 'tok-1', revision: job.continuation.revision, action: 'stop', note: '', at: 5 });
    A.eq(typeof rig.runner.openResumed(where).id, 'string', 'with a claimed decision the owner takes its handle');
    A.throws(() => rig.runner.openResumed(where), 'and only one handle at a time');
    rig.dispose();
  });
  /* ---- 9. the end: a publication that cannot be written down is never replayed ---- */
  for (const [failAt, what, expect] of [[5, 'the publication marker', ['complete', 'confirmed']], [6, 'the confirmation', ['terminal_pending', 'uncertain']]]) {
    await allocated(async env => {
      const { rig, id } = await held(env, { wiring: AFTER });
      let n = 0;
      const store = Object.assign({}, env.host.store, { advance: (...a) => { if (++n === failAt) throw new Error('fixture: ' + what + ' cannot be written'); return env.host.store.advance(...a); } });   // 1 adoption, 2-3 the stage, 4 terminal_pending, 5 publication marker, 6 complete
      const owner = rig.owner(env.host, { store }), c0 = cont(env, id);
      await decide(owner, id, c0, 'approve', 'tok-1').done;
      const job = get(env, id), c = job.continuation;
      A.eq([job.status, JSON.parse(rig.world()).lineOutputs, JSON.parse(rig.world()).shipped, [c.phase, c.publication.state]], ['delivered', 1, 1, expect], 'if ' + what + ' cannot be written: delivered once, never twice; the saved publication says ' + expect.join('/'));
      const world = rig.world(), again = decide(rig.owner(env.host), id, c0, 'approve', 'tok-1');
      A.eq([again.code, again.replayed, rig.world()], [200, true, world], 'and the decision again is the saved receipt: nothing is published a second time');
      rig.dispose();
    });
  }

  /* ---- 10. a STOP or E-STOP between or during stages buys nothing more ---- */
  await allocated(async env => {
    const { rig, id, owner } = await held(env, { replies: [REVISE, BLOCKED, 'Looks good.\nVERDICT: approved'] }), c0 = cont(env, id);
    rig.beforeCall = x => { if (x.agentId === 'drafter') rig.halted = true; };   // E-STOP is pressed while the first stage is out
    await decide(owner, id, c0, 'send_back', 'tok-1', 'again').done;
    const job = get(env, id), c = job.continuation;
    A.eq([rig.calls.slice(2), job.status, job.outcome, c.terminal.stop.code, c.attempts.length, c.attempts[c.attempts.length - 1].state], [['drafter'], 'stopped', 'stopped', 'stopped', 4, 'observed'],
      'E-STOP between stages: the next stage (the reviewer) was never bought; the stage that ran is counted; the job ended STOPPED');
    A.eq([JSON.parse(rig.world()).lineOutputs, owner.inflight.size], [0, 0], 'nothing delivered, and the live walk is gone from the E-STOP registry');
    rig.dispose();
  });
  await allocated(async env => {
    const { rig, id, owner } = await held(env, { wiring: AFTER }), c0 = cont(env, id);
    rig.beforeCall = () => { A.ok(owner.inflight.has(id) && rig.runner.stop(id, 'user'), 'the live walk is in the E-STOP registry and the job has a stop owner'); };
    await decide(owner, id, c0, 'approve', 'tok-1').done;
    const job = get(env, id);
    A.eq([job.status, job.outcome, job.continuation.attempts.length, JSON.parse(rig.world()).lineOutputs, job.stop.code], ['stopped', 'stopped', 4, 0, 'stopped'], 'a STOP while the stage is out: the stage is counted, nothing is delivered, the job ended STOPPED');
    // …and the STOP decision (the key WORKFLOWS shows on a running walk) asks the same owner: nothing live, nothing to stop
    const late = decide(owner, id, job.continuation, 'stop', 'tok-late');
    A.eq([late.code, rig.calls.length], [409, 3], 'a STOP decision on a job that is no longer out is refused (it is finished), buying nothing');
    rig.dispose();
  });
  A.report('line-hold.resume');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-hold.resume'); });
