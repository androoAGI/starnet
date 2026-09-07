/* node test/loopjob-driver.test.js — the LOOP tick driver (standing objectives, S1).

   Drives makeLoopDriver with a fake clock, a fake runOnce and an in-memory store — no wall clock, no fs, no
   network — exactly like nightshift-driver.test.js. What it proves:

     1. ADVANCE-BEFORE-RUN: the fire-claim is persisted BEFORE the run host is ever called, and a failed
        persist fires NOTHING (the double-spend guard).
     2. THE VERDICT IS THE TRIGGER: a full review queue stops the tick from firing; a verdict releases it.
     3. Every settlement path lands exactly once — success, throw, abort, and a failed harvest.
     4. A deleted agent stops the loop instead of firing under a ghost.
     5. The fan-out cap DEFERS (still eligible next tick), never drops.
     6. The prompt actually carries the ledger digest, so the loop has memory. */
'use strict';
const A = require('./_assert.js');
const LJ = require('../sidecar/loopjob.js');
const S = require('../sidecar/loopjob-store.js');
const { makeLoopDriver } = require('../sidecar/loopjob-driver.js');

const T0 = 1700006400000;                 // UTC-midnight aligned (see loopjob.test.js for why)
const MIN = 60000, HOUR = 3600000;

// ---- a fake world: an in-memory store + a scriptable run host ------------------------------------------
function world(opts) {
  opts = opts || {};
  let loops = opts.loops || [];
  let clock = T0;
  const calls = [];          // every runOnce invocation
  const ledger = [];
  const persistFails = opts.persistFails || (() => false);
  let idN = 0;

  const pending = [];        // unresolved run promises, resolved by the test
  const deps = {
    getLoops: () => loops,
    setLoops: (next) => { if (persistFails()) return false; loops = next; return true; },
    runOnce: (o) => {
      calls.push(o);
      if (opts.runThrows) throw new Error('run host exploded');
      return new Promise((resolve, reject) => pending.push({ resolve, reject, opts: o }));
    },
    newId: () => 'run' + (++idN),
    newAbort: () => { const s = { aborted: false }; return { signal: s, abort() { s.aborted = true; } }; },
    now: () => clock,
    isHalted: () => !!opts.halted,
    concurrencyFree: () => opts.agentBusy !== true,
    agentExists: opts.agentExists,
    precheck: opts.precheck,
    defaultModel: 'test-model',
    persona: 'STATION PERSONA',
    harvest: opts.harvest,
    projectLine: opts.projectLine,
    context: opts.context,
    check: opts.check,
    onStopped: opts.onStopped,
    trackRun: opts.trackRun,
    untrackRun: opts.untrackRun,
    ledger: (e) => ledger.push(e),
    maxParallel: opts.maxParallel,
    maxRunMs: opts.maxRunMs
  };

  const drv = makeLoopDriver(deps);
  return {
    drv, ledger, calls, pending,
    get loops() { return loops; },
    loop: (id) => S.getLoop(loops, id || 'l1'),
    tick: (at) => { if (at != null) clock = at; return drv.applyTick(clock); },
    advance: (ms) => { clock += ms; },
    // let the driver's pre-run context hop settle (only project-shaped loops take it)
    flush: () => new Promise(r => setImmediate(() => setImmediate(r))),
    // resolve the oldest in-flight run, then let the settle microtasks drain
    finish: (res) => { const p = pending.shift(); p.resolve(Object.assign({ reason: 'done' }, res)); return new Promise(r => setImmediate(r)); },
    fail: (err) => { const p = pending.shift(); p.reject(err); return new Promise(r => setImmediate(r)); },
    seed: (spec) => { loops = S.createLoop(loops, Object.assign({ id: 'l1', objective: 'find bugs' }, spec), { now: T0 }); }
  };
}

(async function run() {

  // ---- 1. a plain fire: claim persisted before the run host is called -----------------------------------
  {
    const w = world(); w.seed({});
    const res = w.tick(T0);
    A.eq(res.fired, 1, 'one enabled loop fires one iteration');
    A.eq(w.calls.length, 1, 'the run host was called exactly once');
    A.eq(w.loop().iterationCount, 1, 'the iteration slot was taken at start');
    A.eq(w.loop().iterations[0].outcome, 'running', 'and recorded as running');
    A.eq(w.loop().iterations[0].runId, 'run1', 'carrying the runId that was launched');
    A.ok(w.loop().fireClaim != null, 'the durable fire-claim is held while in flight');
    A.eq(w.drv.leases.size, 1, 'the in-memory lease is held too');

    const o = w.calls[0];
    A.eq(o.agentId, 'agent', 'the run is attributed to the loop agent');
    A.eq(o.isTask, true, 'a loop iteration is a TASK run');
    A.eq(o.surface, 'autonomous', 'and an autonomous one');
    A.eq(o.trigger, 'loop', 'tagged with the loop trigger, distinct from schedule/nightshift');
    A.eq(o.streamId, 'loop-l1', 'iterations of one loop share one durable stream');
    A.eq(o.model, 'test-model', 'the host default model is used when the loop pins none');
    A.eq(o.system, 'STATION PERSONA', 'the autonomous persona is the system prompt');
    A.ok(/find bugs/.test(o.messages[0].content), 'the objective is the directive');

    // a second tick while in flight must NOT double-fire
    A.eq(w.tick(T0 + MIN).fired, 0, 'a tick during an in-flight iteration fires nothing');
    A.eq(w.calls.length, 1, 'and never re-enters the run host');

    await w.finish({ text: 'Fixed the null deref in auth.js', usd: 0.12 });
    A.eq(w.loop().iterations[0].outcome, 'candidate', 'the settled iteration is a review candidate');
    A.eq(w.loop().iterations[0].title, 'Fixed the null deref in auth.js', 'the title is the model\'s own first line');
    A.eq(w.loop().iterations[0].usd, 0.12, 'the real cost is recorded');
    A.eq(w.loop().iterations[0].commit, null, 'and NO commit is claimed — this layer performed no git');
    A.eq(w.loop().fireClaim, null, 'settlement releases the durable claim');
    A.eq(w.drv.leases.size, 0, 'and the lease');
    A.ok(w.ledger.some(e => e.kind === 'fire' && e.source === 'loop'), 'the fire is ledgered under source:loop');
    A.ok(w.ledger.some(e => e.kind === 'act' && e.reason === 'candidate'), 'and so is the outcome');
  }

  // ---- 2. INVARIANT: a failed persist fires NOTHING (the double-spend guard) -----------------------------
  {
    let failing = true;
    const w = world({ persistFails: () => failing });
    // seed BEFORE arming the failure so the loop exists
    failing = false; w.seed({}); failing = true;

    const res = w.tick(T0);
    A.eq(res.fired, 0, 'a store that cannot persist the claim fires nothing');
    A.eq(w.calls.length, 0, 'the run host is never reached — no spend over an unpersisted claim');
    A.ok(w.ledger.some(e => e.kind === 'defer' && e.reason === 'claim-persist-failed'),
      'and the refusal is ledgered, not silent');

    failing = false;
    A.eq(w.tick(T0 + MIN).fired, 1, 'once the store recovers, the loop fires normally');
  }

  // ---- 2b. a failed SETTLEMENT persist stays fenced and retries without repeating the run ----------------
  {
    let failing = false;
    const w = world({ persistFails: () => failing });
    w.seed({});
    w.tick(T0);
    A.eq(w.calls.length, 1, 'the persistence-boundary fixture launches one real iteration');

    failing = true;
    await w.finish({ text: 'completed before the disk write failed', usd: 0.01 });
    A.eq(w.loop().iterations[0].outcome, 'running', 'a rejected settlement write never pretends the outcome persisted');
    A.eq(w.drv.leases.size, 1, 'the lease remains as a duplicate-execution fence while settlement is pending');
    A.ok(w.ledger.some(e => e.kind === 'defer' && e.reason === 'settlement-persist-failed'),
      'the persistence failure is visible in the autonomy ledger');

    failing = false;
    A.eq(w.tick(T0 + MIN).fired, 0, 'the recovery tick persists the pending result without starting another run');
    A.eq(w.calls.length, 1, 'settlement recovery never repeats the provider/tool side effects');
    A.eq(w.loop().iterations[0].outcome, 'candidate', 'the originally completed result becomes durable after recovery');
    A.eq(w.drv.leases.size, 0, 'the duplicate fence releases only after the settlement write succeeds');
  }

  // ---- 3. INVARIANT: the VERDICT is the trigger ----------------------------------------------------------
  {
    const w = world(); w.seed({ queueCap: 1 });
    w.tick(T0);
    await w.finish({ text: 'did a thing', usd: 0 });
    A.eq(w.loop().state, 'waiting', 'one candidate at queueCap 1 parks the loop');

    A.eq(w.tick(T0 + HOUR).fired, 0, 'and NO amount of ticking fires it — a clock cannot advance a loop');
    A.eq(w.tick(T0 + 5 * HOUR).fired, 0, 'still nothing hours later');
    A.eq(LJ.decide(w.loop(), {}, { now: T0 + 5 * HOUR }).binding, 'queue-full', 'the reason is nameable');

    // the Commander rules on it — THIS is the trigger. The verdict lands through the store (exactly what the
    // /api/loops/verdict route does), then the next ordinary tick picks it up.
    const ruled = S.recordVerdict(w.loops, 'l1', 1, 'approved', { now: T0 + 6 * HOUR });
    const after = world({ loops: ruled });
    A.eq(after.loop().state, 'idle', 'the verdict released the queue');
    A.eq(after.tick(T0 + 6 * HOUR).fired, 1, 'and the very next tick fires the next iteration');
    A.eq(after.loop().iterationCount, 2, 'iteration 2 is under way');
  }

  // ---- 4. the ledger digest actually reaches the prompt (the loop has MEMORY) ----------------------------
  {
    let loops = S.createLoop([], { id: 'l1', objective: 'find bugs', queueCap: 5 }, { now: T0 });
    loops = S.startIteration(S.claimFire(loops, 'l1', { now: T0 }), 'l1', { runId: 'r1', now: T0 });
    loops = S.settleIteration(loops, 'l1', { runId: 'r1', status: 'ok', text: 'w', title: 'rewrote the CI config' }, { now: T0 + MIN });
    loops = S.recordVerdict(loops, 'l1', 1, 'rejected', { now: T0 + HOUR, note: 'never touch CI' });

    const w = world({ loops: loops });
    w.tick(T0 + 2 * HOUR);
    const prompt = w.calls[0].messages[0].content;
    A.ok(/find bugs/.test(prompt), 'the standing objective leads the prompt');
    A.ok(/never touch CI/.test(prompt), 'the REJECTION REASON is carried into the next iteration');
    A.ok(/NOTHING-TO-DO/.test(prompt), 'and the convergence escape hatch is offered');
  }

  // ---- 5. every failure path settles exactly once --------------------------------------------------------
  {
    // a rejected run promise
    const w = world(); w.seed({});
    w.tick(T0);
    await w.fail(new Error('provider 500'));
    A.eq(w.loop().iterations[0].outcome, 'failed', 'a rejected run settles as failed');
    A.ok(/provider 500/.test(w.loop().iterations[0].error), 'carrying the real error');
    A.eq(w.drv.leases.size, 0, 'and releases the lease');

    // an aborted run (E-STOP) is CANCELLED, not failed
    const w2 = world(); w2.seed({});
    w2.tick(T0);
    const aborted = w2.drv.abortAllLeases();
    A.eq(aborted, 1, 'abortAllLeases reports what it aborted');
    const e = new Error('aborted'); e.name = 'AbortError';
    await w2.fail(e);
    A.eq(w2.loop().iterations[0].outcome, 'cancelled', 'an aborted iteration is cancelled, not a failure');
    A.eq(w2.loop().failStreak, 0, 'so it costs no failure streak');

    // a resolved run can still be incomplete (budget/max_iters/refusal/empty); only done is a candidate
    const wb = world(); wb.seed({}); wb.tick(T0);
    await wb.finish({ reason: 'budget', text: 'partial work' });
    A.eq(wb.loop().iterations[0].outcome, 'failed', 'a budget-ended run is not parked as an approvable candidate');
    A.ok(/budget/.test(wb.loop().iterations[0].error || ''), 'the failed iteration names its terminal reason');

    // a run host that throws synchronously
    const w3 = world({ runThrows: true }); w3.seed({});
    w3.tick(T0);
    A.eq(w3.loop().iterations[0].outcome, 'failed', 'a synchronous run-host throw still settles the iteration');
    A.eq(w3.drv.leases.size, 0, 'and never strands the lease');

    // a harvest that fails = the work did NOT land, so the iteration failed
    const w4 = world({ harvest: () => { throw new Error('git refused: dirty tree'); } }); w4.seed({});
    w4.tick(T0);
    await w4.finish({ text: 'I fixed everything' });
    A.eq(w4.loop().iterations[0].outcome, 'failed', 'a failed harvest is a failed iteration, not a silent success');
    A.ok(/dirty tree/.test(w4.loop().iterations[0].error), 'and names why the work could not land');
  }

  // ---- 5b. a failed settlement persist retries the receipt, never the completed iteration ----------------
  {
    let failing = false;
    const w = world({ persistFails: () => failing });
    w.seed({ queueCap: 1 }); w.tick(T0);
    failing = true;
    await w.finish({ text: 'completed once' });
    A.eq(w.loop().iterations[0].outcome, 'running', 'an unpersisted settlement is not exposed as completed');
    A.eq(w.drv.leases.size, 1, 'the lease retains the pending settlement');
    failing = false;
    w.tick(T0 + MIN);
    A.eq(w.calls.length, 1, 'settlement recovery does not execute the iteration again');
    A.eq(w.loop().iterations[0].outcome, 'candidate', 'the original outcome lands after persistence recovers');
    A.eq(w.drv.leases.size, 0, 'the lease releases only after durable settlement');
  }

  // ---- 6. a deleted agent stops the loop instead of firing under a ghost ---------------------------------
  {
    const w = world({ agentExists: () => false }); w.seed({});
    const res = w.tick(T0);
    A.eq(res.fired, 0, 'nothing fires for a missing agent');
    A.eq(w.loop().state, 'stopped', 'the loop is STOPPED, not left quietly spinning');
    A.ok(/no longer exists/.test(w.loop().stopReason), 'and says so');
    A.eq(w.tick(T0 + HOUR).fired, 0, 'it stays stopped');
  }

  // ---- 7. gates that must cost nothing --------------------------------------------------------------------
  {
    const w = world({ halted: true }); w.seed({});
    A.eq(w.tick(T0).fired, 0, 'the station E-STOP blocks every loop');
    A.eq(w.calls.length, 0, 'with zero spend');

    const w2 = world({ agentBusy: true }); w2.seed({});
    A.eq(w2.tick(T0).fired, 0, 'a busy agent blocks its loop');

    const w3 = world({ precheck: () => ({ ok: false, reason: 'no credential' }) }); w3.seed({});
    A.eq(w3.tick(T0).fired, 0, 'a local precheck failure blocks BEFORE the model call');
    A.ok(w3.ledger.some(e => e.kind === 'skip' && e.binding === 'precheck'), 'and is ledgered');
    A.eq(w3.loop().iterationCount, 0, 'and costs no iteration slot');
  }

  // ---- 8. no default fan-out quota: twenty standing loops may start together -----------------------------
  {
    let loops = [];
    for (let i = 1; i <= 20; i++) loops = S.createLoop(loops, { id: 'u' + i, objective: 'o' + i, agentId: 'a' + i }, { now: T0 });
    const w = world({ loops: loops });
    const res = w.tick(T0);
    A.eq(res.fired, 20, 'the default standing-loop driver starts all twenty eligible loops');
    A.eq(res.deferred, 0, 'no hidden standing-loop concurrency ceiling defers work');
  }

  // ---- 8b. an opt-in fan-out cap DEFERS, never drops ------------------------------------------------------
  {
    let loops = [];
    for (let i = 1; i <= 4; i++) loops = S.createLoop(loops, { id: 'l' + i, objective: 'o' + i }, { now: T0 });
    const w = world({ loops: loops, maxParallel: 2 });
    const res = w.tick(T0);
    A.eq(res.fired, 2, 'only maxParallel loops fire at once');
    A.eq(res.deferred, 2, 'the rest are DEFERRED');
    A.eq(res.planned, 4, 'all four were eligible');
    A.ok(w.ledger.some(e => e.kind === 'defer' && e.reason === 'at-capacity'), 'the deferral is ledgered');

    // deferred loops advanced nothing, so they are still eligible
    A.eq(S.getLoop(w.loops, 'l3').iterationCount, 0, 'a deferred loop burned no iteration');
    A.eq(S.getLoop(w.loops, 'l3').fireClaim, null, 'and holds no claim');
    await w.finish({ text: 'done a' });
    await w.finish({ text: 'done b' });
    A.eq(w.tick(T0 + MIN).fired, 2, 'they drain on the next tick');
  }

  // ---- 9. a zombie claim is reclaimed (a crash cannot wedge a loop forever) -------------------------------
  {
    let loops = S.claimFire(S.createLoop([], { id: 'l1', objective: 'o' }, { now: T0 }), 'l1', { now: T0 });
    const w = world({ loops: loops, maxRunMs: 10 * MIN });
    A.eq(w.tick(T0 + 2 * MIN).fired, 0, 'a fresh claim from a previous process suppresses re-fire');
    A.eq(w.tick(T0 + 30 * MIN).fired, 1, 'a claim past the ceiling is reclaimed and the loop resumes');
  }

  // ---- 10. convergence through the driver: NOTHING-TO-DO parks it dormant ---------------------------------
  {
    const w = world(); w.seed({ dryStopAfter: 2, queueCap: 5 });
    w.tick(T0);
    await w.finish({ text: 'I checked everything. NOTHING-TO-DO' });
    A.eq(w.loop().iterations[0].outcome, 'noop', 'the declared convergence is read');
    A.eq(w.loop().state, 'idle', 'one dry pass is not convergence');
    w.tick(T0 + HOUR);
    await w.finish({ text: 'NOTHING-TO-DO' });
    A.eq(w.loop().state, 'dormant', 'two in a row parks it DORMANT');
    A.eq(w.tick(T0 + 2 * HOUR).fired, 0, 'and it stops spending');
    A.eq(w.calls.length, 2, 'exactly two runs were ever paid for');
    A.ok(w.ledger.some(e => e.detail && e.detail.converged === true), 'convergence is ledgered as such');
  }

  // ---- 11. gate:'auto' never queues and keeps going --------------------------------------------------------
  {
    const w = world({ harvest: (loop, res) => ({ text: res.text, title: 'auto fix', commit: 'deadbee', files: [{ path: 'a.js' }], usd: 0.05 }) });
    w.seed({ gate: 'auto', queueCap: 1 });
    w.tick(T0);
    await w.finish({ text: 'merged it' });
    A.eq(w.loop().iterations[0].verdict, 'approved', 'an auto iteration is self-approved at settle');
    A.eq(w.loop().iterations[0].commit, 'deadbee', 'the harvest commit IS recorded when a harvest proves one');
    A.eq(w.loop().state, 'idle', 'and nothing queues');
    A.eq(w.tick(T0 + MIN).fired, 1, 'so an auto loop keeps going without a review');
  }

  // ---- 12. THE PROJECT ANCHOR: a project-shaped loop must TELL the agent where the project is -------------
  // REGRESSION from a real dogfood run: three passes burned $0.33 replying "the workspace is empty — no
  // src/cart.js". The loop knew its workdir and the path grant allowed it; the agent was simply never told the
  // path existed, and relative paths resolve inside its own jail.
  {
    const w = world({ projectLine: (l) => l.workdir ? '\n\nPROJECT FOLDER: ' + l.workdir : '' });
    w.seed({ workdir: 'C:/proj/cart', checkCmd: 'node test/run.js' });
    w.tick(T0);
    const sys = w.calls[0].system;
    A.ok(/PROJECT FOLDER: C:\/proj\/cart/.test(sys), 'the project folder is injected into the system prompt');
    A.ok(/STATION PERSONA/.test(sys), 'and it is APPENDED to the persona, never replacing it');

    // a loop with no folder must inject nothing — never assert access we cannot prove
    const w2 = world({ projectLine: (l) => l.workdir ? '\n\nPROJECT FOLDER: ' + l.workdir : '' });
    w2.seed({});
    w2.tick(T0);
    A.eq(w2.calls[0].system, 'STATION PERSONA', 'a folderless loop gets the bare persona, no phantom anchor');

    // and with no projectLine dep wired at all the driver still runs (older hosts)
    const w3 = world(); w3.seed({ workdir: 'C:/proj' });
    w3.tick(T0);
    A.eq(w3.calls[0].system, 'STATION PERSONA', 'the dep is optional');
  }

  /* ---- 13. THE PROJECT SNAPSHOT: anchor the agent, and NEVER converge on a project we could not read ------
     THE DOGFOOD FAILURE THIS LOCKS: a sweep loop pointed at a real repo listed only its own empty jail,
     honestly filed "DIGEST: 0 findings", and the loop counted that as CONVERGENCE — the system asserting
     "nothing left to do" about a project it never opened. The agent was truthful; the conclusion was false. */
  {
    // (a) a readable project puts its snapshot in front of the agent, ahead of the ledger
    const w = world({ context: () => Promise.resolve({ text: 'PROJECT SNAPSHOT — C:/proj\nsrc/cart.js\ntest/cart.test.js', reachable: true }) });
    w.seed({ workdir: 'C:/proj', queueCap: 5 });
    w.tick(T0);
    await w.flush();
    const prompt = w.calls[0].messages[0].content;
    A.ok(/PROJECT SNAPSHOT/.test(prompt), 'the snapshot reaches the prompt');
    A.ok(/src\/cart\.js/.test(prompt), 'carrying what is really in the folder');
    A.ok(prompt.indexOf('find bugs') < prompt.indexOf('PROJECT SNAPSHOT'), 'the objective still leads');

    // (b) AN UNREADABLE PROJECT SPENDS NOTHING AND CANNOT CONVERGE
    const w2 = world({ context: () => Promise.resolve({ reachable: false, why: 'the project folder looks empty from here' }) });
    w2.seed({ workdir: 'C:/gone', exitOn: 'empty-digests', dryStopAfter: 1, queueCap: 5 });
    w2.tick(T0);
    await w2.flush();
    A.eq(w2.calls.length, 0, 'the model is NEVER called for a pass that cannot see the project — zero spend');
    const it = w2.loop().iterations[0];
    A.eq(it.outcome, 'failed', 'the pass is a FAILURE, not a finding-free success');
    A.ok(/could not read the project folder/.test(it.error), 'and says exactly that: ' + it.error);
    A.ok(/looks empty from here/.test(it.error), 'including the underlying reason');
    A.eq(w2.loop().dryStreak, 0, 'it contributes NOTHING to the convergence counter');
    A.ok(w2.loop().state !== 'dormant', 'so a blind loop can never declare "nothing left to do"');

    // (c) a context that THROWS is the same class of refusal, never a silent success
    const w3 = world({ context: () => { throw new Error('scan exploded'); } });
    w3.seed({ workdir: 'C:/proj', queueCap: 5 });
    w3.tick(T0);
    await w3.flush();
    A.eq(w3.calls.length, 0, 'a throwing scan also spends nothing');
    A.eq(w3.loop().iterations[0].outcome, 'failed', 'and fails the pass honestly');
    A.ok(/scan exploded/.test(w3.loop().iterations[0].error || ''), 'quoting the real error');

    // (d) repeated blindness parks the loop rather than grinding
    const w4 = world({ context: () => Promise.resolve({ reachable: false, why: 'not readable' }) });
    w4.seed({ workdir: 'C:/gone', queueCap: 5 });
    for (let i = 0; i < 3; i++) { w4.tick(T0 + i * MIN); await w4.flush(); }
    A.eq(w4.loop().state, 'paused', 'three blind passes park the loop');
    A.ok(/could not read the project folder/.test(w4.loop().stopReason || ''), 'with the real reason on the record');

    // (e) a THROW between context and launch (projectLine/stationFor/buildMessages) SETTLES the iteration.
    // The old catch only deleted the in-memory lease: the persisted fireClaim read in-flight for the full
    // staleMs, the iteration row stayed 'running' forever, and the tracked run kept the agent posed at its
    // desk — then reconcileBoot paused the loop for an iteration that never launched.
    const w5 = world({
      context: () => Promise.resolve({ text: 'ok', reachable: true }),
      projectLine: () => { throw new Error('projectLine exploded'); }
    });
    w5.seed({ workdir: 'C:/proj', queueCap: 5 });
    w5.tick(T0);
    await w5.flush();
    A.eq(w5.calls.length, 0, 'the model was never called');
    const it5 = w5.loop().iterations[0];
    A.eq(it5 && it5.outcome, 'failed', 'the pre-launch throw settles the iteration as failed, never running-forever');
    A.ok(/projectLine exploded/.test((it5 && it5.error) || ''), 'quoting the real error');
    w5.tick(T0 + MIN);
    await w5.flush();
    A.eq(w5.loop().iterations.length >= 2 || w5.loop().state === 'paused', true, 'the next tick is free to act — no zombie fire-claim blocks it');
  }

  /* ---- 14. THE DESK STAYS LIT: a loop pass is a REAL run in the host registry ---------------------------
     The world shows a loop by animating the agent at its desk, and it rebuilds that from
     GET /api/state/snapshot on every reconnect — a snapshot built from the host's run registry, which
     "clears any agent absent here". A loop pass that never registers therefore darkens a genuinely-working
     agent the moment the app reloads. */
  {
    const tracked = new Map();
    const w = world({
      trackRun: (runId, agentId, ac) => tracked.set(runId, { agentId, ac }),
      untrackRun: (runId) => tracked.delete(runId)
    });
    w.seed({});
    w.tick(T0);
    A.eq(tracked.size, 1, 'a live pass is registered with the host');
    A.eq([...tracked.values()][0].agentId, 'agent', 'under the agent that is actually working');
    A.ok([...tracked.values()][0].ac && typeof [...tracked.values()][0].ac.abort === 'function',
      'with its abort handle, so /api/cancel and E-STOP can reach a single pass');

    await w.finish({ text: 'did a thing', usd: 0 });
    A.eq(tracked.size, 0, 'and it is released when the pass genuinely ends — the desk goes quiet only then');

    // every terminal path must release it, or an agent stays falsely lit forever
    const w2 = world({ trackRun: (r, a, ac) => tracked.set(r, { a, ac }), untrackRun: (r) => tracked.delete(r) });
    w2.seed({}); w2.tick(T0);
    await w2.fail(new Error('provider 500'));
    A.eq(tracked.size, 0, 'a FAILED pass releases the desk too');

    const w3 = world({ runThrows: true, trackRun: (r, a, ac) => tracked.set(r, { a, ac }), untrackRun: (r) => tracked.delete(r) });
    w3.seed({}); w3.tick(T0);
    A.eq(tracked.size, 0, 'and so does a run host that throws outright');

    // the deps are optional — an older host without them still runs
    const w4 = world(); w4.seed({});
    A.eq(w4.tick(T0).fired, 1, 'tracking is optional; the driver works without it');
  }

  /* ---- 15. THE NEEDS-YOU EDGE: announced once, on the transition, and never while still working -------
     A loop that stops for a human is the one moment worth interrupting them for. Announcing every candidate
     would be noise while the loop is still working; re-announcing on every poll would be spam. */
  {
    const stops = [];
    const w = world({ onStopped: (l, prev) => stops.push({ state: l.state, prev: prev, pending: LJ.pendingReviews(l).length }) });
    w.seed({ queueCap: 2 });

    w.tick(T0); await w.finish({ text: "one", title: "one" });
    A.eq(stops.length, 0, "a candidate while the loop can still work announces NOTHING");

    w.tick(T0 + MIN); await w.finish({ text: "two", title: "two" });
    A.eq(stops.length, 1, "filling the review queue announces exactly once");
    A.eq(stops[0].state, "waiting", "and reports the state it stopped in");
    A.eq(stops[0].pending, 2, "with how much is waiting");

    w.tick(T0 + 2 * MIN);
    A.eq(stops.length, 1, "ticking a parked loop never re-announces — it is edge-triggered, not level");
  }

  // convergence and completion are announced too, with their own true reason
  {
    const stops = [];
    const w = world({ onStopped: (l) => stops.push(l.state) });
    w.seed({ exitOn: "empty-digests", dryStopAfter: 1, queueCap: 5 });
    w.tick(T0); await w.finish({ text: "DIGEST: 0 findings — nothing new" });
    A.eq(stops, ["dormant"], "converging announces as dormant, not as work waiting");

    const stops2 = [];
    const w2 = world({ onStopped: (l) => stops2.push(l.state), check: () => Promise.resolve({ ran: true, passed: true, trusted: true, tampered: false, tamperedPaths: [], gitProven: true, mustReview: false, summary: "7 passing" }) });
    w2.seed({ exitOn: "check-green", checkCmd: "npm test", workdir: "C:/p", queueCap: 5 });
    // a checked loop settles through the async check chain, so let it drain before asserting the announcement
    w2.tick(T0); await w2.flush(); await w2.finish({ text: "fixed" }); await w2.flush();
    A.eq(stops2, ["done"], "meeting the objective announces as done");
  }

  /* ---- 16. ENDURANCE: E-STOP is a durable terminal even when the run host ignores AbortSignal ---------
     A provider/tool can wedge after receiving abort. Cancellation authority belongs to the host, so the
     loop must release its claim and truthful RUNNING telemetry immediately; a late provider resolution must
     not harvest or rewrite the already-cancelled iteration. */
  {
    let harvests = 0;
    const tracked = new Map();
    const w = world({
      harvest: () => { harvests++; return { text: 'late work', title: 'late work' }; },
      trackRun: (runId, agentId, ac) => tracked.set(runId, { agentId, ac }),
      untrackRun: (runId) => tracked.delete(runId)
    });
    w.seed({});
    w.tick(T0);
    A.eq(w.drv.abortAllLeases(), 1, 'E-STOP reaches the hung iteration');
    A.eq(w.loop().iterations[0].outcome, 'cancelled', 'E-STOP durably settles immediately even while the provider promise is still hung');
    A.eq(w.loop().fireClaim, null, 'the durable claim is released immediately on E-STOP');
    A.eq(w.drv.leases.size, 0, 'the in-memory lease is released immediately on E-STOP');
    A.eq(tracked.size, 0, 'host RUNNING telemetry clears immediately on E-STOP');

    await w.finish({ text: 'provider ignored abort and returned late' });
    A.eq(w.loop().iterations[0].outcome, 'cancelled', 'a late provider resolution cannot rewrite the cancelled outcome');
    A.eq(harvests, 0, 'late work is never harvested after cancellation');
  }

  /* ---- 17. ENDURANCE: a pre-restart running pass never auto-replays uncertain side effects ------------
     The durable fire claim proves that a pass existed, not whether its last tool effect happened. On a new
     driver there is no live lease that can own that claim. The first tick must reconcile it into an explicit
     recovery pause; only the Commander's existing RESUME action may start a fresh pass. */
  {
    let loops = S.createLoop([], { id: 'l1', objective: 'multi-step work', queueCap: 5 }, { now: T0 });
    loops = S.startIteration(S.claimFire(loops, 'l1', { now: T0 }), 'l1', { runId: 'pre-restart', now: T0 });
    const restarted = world({ loops, maxRunMs: 10 * MIN });

    const first = restarted.tick(T0 + 30 * MIN);
    A.eq(first.fired, 0, 'restart reconciliation never auto-replays a pass with an unknown side-effect boundary');
    A.eq(restarted.calls.length, 0, 'no provider/tool work is duplicated during restart reconciliation');
    A.eq(restarted.loop().iterations[0].outcome, 'cancelled', 'the abandoned ledger row no longer lies RUNNING');
    A.eq(restarted.loop().state, 'paused', 'the loop pauses for explicit recovery review');
    A.ok(/restart|interrupted/i.test(restarted.loop().stopReason || ''), 'the pause names the restart interruption');

    const resumedLoops = S.resumeLoop(restarted.loops, 'l1', { now: T0 + 31 * MIN });
    const resumed = world({ loops: resumedLoops, maxRunMs: 10 * MIN });
    A.eq(resumed.tick(T0 + 31 * MIN).fired, 1, 'the existing explicit RESUME action starts exactly one fresh pass');
    A.eq(resumed.calls.length, 1, 'resume produces one replacement run, not a replay storm');
    A.eq(resumed.loop().iterations.filter(it => it.outcome === 'running').length, 1, 'only the replacement pass is RUNNING');
  }

  /* ---- 18. ENDURANCE: cancelling one standing loop cannot kill siblings or revive after PAUSE ---------- */
  {
    let loops = S.createLoop([], { id: 'l1', objective: 'first' }, { now: T0 });
    loops = S.createLoop(loops, { id: 'l2', objective: 'second' }, { now: T0 });
    const w = world({ loops, maxParallel: 2 });
    w.tick(T0);
    A.eq(w.drv.abortLease('l1', 'paused by the Commander'), true, 'the targeted loop cancellation is accepted');
    A.eq(S.getLoop(w.loops, 'l1').iterations[0].outcome, 'cancelled', 'the targeted pass settles cancelled immediately');
    A.eq(S.getLoop(w.loops, 'l2').iterations[0].outcome, 'running', 'a sibling pass remains live');
    A.eq(w.drv.leases.size, 1, 'only the sibling lease remains');

    await w.finish({ text: 'late first result' });
    A.eq(S.getLoop(w.loops, 'l1').iterations[0].outcome, 'cancelled', 'the targeted pass cannot revive on a late result');
    await w.finish({ text: 'second completed' });
    A.eq(S.getLoop(w.loops, 'l2').iterations[0].outcome, 'candidate', 'the sibling still completes normally');
    A.eq(w.drv.abortLease('missing'), false, 'targeted cancellation is idempotent for an absent lease');
  }

  // Cancellation can arrive after the provider finished, while check/harvest is
  // still pending. A late result belongs to that cancelled generation only.
  for (const seam of ['check', 'harvest', 'harvest-reject']) {
    let releaseOld, rejectOld, checks = 0, harvests = 0;
    const delayed = new Promise((resolve, reject) => { releaseOld = resolve; rejectOld = reject; });
    const w = world({
      check: () => ++checks === 1 && seam === 'check' ? delayed : null,
      harvest: () => {
        harvests++;
        return harvests === 1 && seam !== 'check' ? delayed : { text: 'new work', title: 'new work' };
      }
    });
    w.seed({});
    w.tick(T0);
    await w.finish({ text: 'old provider completed' });
    await w.flush();
    A.eq(w.drv.abortLease('l1', 'paused by the Commander'), true, seam + ': cancel during pending host work');
    A.eq(w.tick(T0 + MIN).fired, 1, seam + ': resume starts a replacement');
    const replacement = w.drv.leases.get('l1');
    A.eq(replacement.runId, 'run2', seam + ': replacement owns its lease');
    if (seam === 'harvest-reject') rejectOld(new Error('late old harvest failed'));
    else releaseOld({ text: 'late old result', title: 'late old result' });
    await w.flush();
    A.eq(w.drv.leases.get('l1'), replacement, seam + ': late completion must not delete replacement ownership');
    A.eq(w.loop().iterations[0].outcome, 'cancelled', seam + ': cancellation remains terminal');
    if (seam === 'check') A.eq(harvests, 0, 'late check cannot start harvest after cancellation');
    await w.finish({ text: 'replacement completes' });
    await w.flush();
    A.eq(w.loop().iterations[1].outcome, 'candidate', seam + ': replacement completes instead of stranding RUNNING');
    A.eq(w.drv.leases.size, 0, seam + ': replacement releases its own lease');
  }

  A.report('loopjob-driver (LOOP tick driver)');
})().catch(e => { console.log('FAIL: unexpected throw — ' + (e && e.stack || e)); process.exit(1); });
