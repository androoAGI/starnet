/* node test/cron-liveness-opencalls.test.js — ONE LIVENESS RULE for a scheduled fire (ops-1115 T1, W9).

   A fire's lease is alive while its run emits, OR while a tool call it started is still running. A tool emits
   agent.tool_call before it runs and agent.tool_result after, and nothing in between (shell.exec may run up to 600 s
   against the 8-minute stale window), so before this the sweep reclaimed a healthy long tool call, aborted it and fired the
   routine again (a repeated spend and possibly a repeated outside action). The same held for a work line's hop events,
   which were teed without renewing (only hop START renewed), and for a laptop that slept mid-run (the wall clock jumped
   past the window and the first tick after the wake reclaimed the live run).

   Red at 45e7ee302 (cases 1, 2, 3 and the source pins); green after. The real cron-driver with an injected clock, a
   runOnce fake that never resolves, and the real cron-store. */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const failopen = require('../sidecar/failopen.js');
const Source = require('./helpers/source.js');

const T0 = 1700000000000, MIN = 60000;
const flush = () => new Promise(r => setImmediate(r));

// one routine due at T0 (every `every`), a driver over it. runOnce records each launch and never resolves unless
// opts.resolveWith is given (then it resolves after emitting stage one's end, so a line can start).
function setup(opts) {
  opts = opts || {};
  const clock = makeClock(T0);
  const job = cronStore.makeJob({ id: 'j', prompt: 'do the long thing', agentId: 'agent', schedule: cron.parseSchedule(opts.every || 'every 6h', T0), runsLine: opts.runsLine }, { id: 'j', now: T0 });
  let store = [Object.assign({}, job, { enabled: true, nextRunAt: new Date(T0).toISOString() })];
  const events = [], runs = [];
  let idN = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; return true; },
    runOnce: (o) => {
      runs.push(o);
      if (opts.onRun) return opts.onRun(o);
      return new Promise(() => {});
    },
    emit: (name, payload) => events.push({ name, payload }),
    newId: () => 'run-' + (++idN), newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 8 * MIN,
    maxWallMs: opts.maxWallMs, tickMs: opts.tickMs, toolStaleMs: opts.toolStaleMs,
    advanceChain: opts.advanceChain
  });
  const reclaims = () => events.filter(e => e.name === 'cron.skipped' && e.payload.reason === 'stale-lock-reclaimed').length;
  const results = () => events.filter(e => e.name === 'cron.result').map(e => e.payload);
  return { driver, clock, events, runs, reclaims, results, getJob: () => cronStore.getJob(store, 'j') };
}

(async () => {
  /* ---- (1) RED: a tool call in flight is silent by nature — 9 minutes into it, the run is not reclaimed ---- */
  {
    const s = setup();
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, '(1) the routine fired once');
    const o = s.runs[0];
    o.emit('agent.run.start', { agentId: 'agent', runId: o.runId });
    o.emit('agent.tool_call', { agentId: 'agent', runId: o.runId, callId: 'c1', name: 'shell.exec' });   // a 10-minute build starts
    s.clock.advance(9 * MIN);                                                                          // and runs silently
    s.driver.applyTick(s.clock.now());
    A.eq(o.signal.aborted, false, '(1) a run with a tool call in flight is not aborted at +9 min');
    A.eq(s.reclaims(), 0, '(1) and is not stale-lock-reclaimed');
    A.eq(s.runs.length, 1, '(1) one start, no re-fire');
    // the tool returns: the run is back to the ordinary rule (8 minutes of silence reclaims it)
    o.emit('agent.tool_result', { agentId: 'agent', runId: o.runId, callId: 'c1', ok: true });
    s.clock.advance(8 * MIN + 1000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.reclaims(), 1, '(1) once the call returned, 8 minutes of silence reclaims the run exactly as before');
  }

  /* ---- (2) RED: a work line's hop is running a tool — the hop's events reach the lease through onHopEvent ---- */
  {
    let hopAt = null;
    const s = setup({
      runsLine: true,
      onRun: (o) => { o.emit('agent.token', { delta: 'stage one' }); o.emit('agent.run.end', { runId: o.runId, reason: 'done', outcome: 'succeeded' }); return Promise.resolve({ text: 'stage one' }); },
      advanceChain: (o) => {
        if (typeof o.onHop === 'function') o.onHop();
        if (typeof o.onHopEvent === 'function') o.onHopEvent('agent.tool_call', { runId: 'hop-1', callId: 'h1', name: 'shell.exec' });
        hopAt = 'started';
        return new Promise(() => {});   // the hop's tool keeps running
      }
    });
    s.driver.applyTick(s.clock.now());
    await flush(); await flush(); await flush();
    A.eq(hopAt, 'started', '(2) stage one settled and the line started its hop');
    const sig = s.runs[0].signal;
    s.clock.advance(20 * MIN);
    s.driver.applyTick(s.clock.now());
    A.eq(sig.aborted, false, '(2) a hop 20 minutes into a tool call is not aborted');
    A.eq(s.reclaims(), 0, '(2) and the fire is not reclaimed');
  }

  /* ---- (3) RED: a laptop sleeps four times for 30 minutes during one healthy run ---- */
  {
    failopen.resetForTests && failopen.resetForTests();
    const s = setup({ tickMs: MIN, maxWallMs: 0 });
    s.driver.applyTick(s.clock.now());
    const pulse = () => { const o = s.runs[s.runs.length - 1]; o.emit('agent.token', { runId: o.runId, delta: '.' }); };
    pulse();
    for (let sleep = 1; sleep <= 4; sleep++) {
      s.clock.advance(30 * MIN);              // asleep: no tick, no event
      s.driver.applyTick(s.clock.now());      // the first tick after the wake
      for (let k = 0; k < 45; k++) {          // awake: the run keeps working, ticks come on time
        s.clock.advance(MIN);
        pulse();
        s.driver.applyTick(s.clock.now());
      }
    }
    A.eq(s.reclaims(), 0, '(3) four 30-minute sleeps reclaim the healthy run zero times');
    A.eq(s.runs.length, 1, '(3) it started exactly once');
    A.ok((failopen.counts()['cron.suspend-rebase'] || 0) >= 4, '(3) each wake is noted as cron.suspend-rebase: ' + JSON.stringify(failopen.counts()));
  }

  /* ---- LIVENESS: no open call and silent past 8 minutes is reclaimed exactly as before ---- */
  {
    const s = setup({ tickMs: MIN });
    s.driver.applyTick(s.clock.now());
    const o = s.runs[0];
    o.emit('agent.run.start', { agentId: 'agent', runId: o.runId });
    for (let k = 0; k < 8; k++) { s.clock.advance(MIN); s.driver.applyTick(s.clock.now()); }
    A.eq(s.reclaims(), 0, 'liveness: 8 minutes of silence is still inside the window');
    s.clock.advance(1000);
    s.driver.applyTick(s.clock.now());
    A.eq(o.signal.aborted, true, 'liveness: a silent run with no open call is aborted past 8 minutes');
    A.eq(s.reclaims(), 1, 'liveness: and reclaimed once');
    A.ok(/no progress for 480s/.test(String(s.getJob().lastError || '')), 'liveness: its reason still names the 8-minute window: ' + s.getJob().lastError);
  }

  /* ---- LIVENESS: an open call silent past 24 minutes (3 x the window) is reclaimed ---- */
  {
    const s = setup();
    s.driver.applyTick(s.clock.now());
    const o = s.runs[0];
    o.emit('agent.tool_call', { agentId: 'agent', runId: o.runId, callId: 'c9', name: 'shell.exec' });
    s.clock.advance(24 * MIN);
    s.driver.applyTick(s.clock.now());
    A.eq(s.reclaims(), 0, 'liveness: exactly 24 minutes into a tool call is still alive');
    s.clock.advance(1000);
    s.driver.applyTick(s.clock.now());
    A.eq(o.signal.aborted, true, 'liveness: a tool call silent past 24 minutes is aborted');
    A.eq(s.reclaims(), 1, 'liveness: and reclaimed');
    A.ok(/no progress for 1440s/.test(String(s.getJob().lastError || '')), 'liveness: its reason names the window that applied: ' + s.getJob().lastError);
  }

  /* ---- LIVENESS: toolStaleMs is injectable; a lead run's end clears its open calls ---- */
  {
    const s = setup({ toolStaleMs: 12 * MIN });
    s.driver.applyTick(s.clock.now());
    const o = s.runs[0];
    o.emit('agent.tool_call', { agentId: 'agent', runId: o.runId, callId: 'c1', name: 'shell.exec' });
    o.emit('agent.tool_call', { agentId: 'worker', runId: 'worker-1', callId: 'w1', name: 'shell.exec' });
    o.emit('agent.run.end', { agentId: 'worker', runId: 'worker-1', reason: 'done' });   // a worker's end clears nothing
    s.clock.advance(12 * MIN + 1000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.reclaims(), 1, 'liveness: an injected toolStaleMs of 12 min reclaims a 12-minute silent tool call');
    const s2 = setup();
    s2.driver.applyTick(s2.clock.now());
    const o2 = s2.runs[0];
    o2.emit('agent.tool_call', { agentId: 'agent', runId: o2.runId, callId: 'c1', name: 'shell.exec' });
    o2.emit('agent.run.end', { agentId: 'agent', runId: o2.runId, reason: 'cancelled' });   // the lead ended; nothing is in flight
    s2.clock.advance(8 * MIN + 1000);
    s2.driver.applyTick(s2.clock.now());
    A.eq(s2.reclaims(), 1, 'liveness: after the lead\'s own end, the 8-minute window applies again');
  }

  /* ---- LIVENESS: maxWallMs still ends a chatty run ---- */
  {
    const s = setup({ maxWallMs: 30 * MIN, tickMs: MIN });
    s.driver.applyTick(s.clock.now());
    const o = s.runs[0];
    o.emit('agent.tool_call', { agentId: 'agent', runId: o.runId, callId: 'c1', name: 'shell.exec' });
    for (let k = 0; k < 31; k++) { s.clock.advance(MIN); o.emit('agent.token', { runId: o.runId, delta: '.' }); s.driver.applyTick(s.clock.now()); }
    A.eq(o.signal.aborted, true, 'liveness: a run past maxWallMs is stopped even with a tool call open and events flowing');
    A.ok(s.results().some(r => /wall-clock-exceeded/.test(String(r.reason || ''))) || s.getJob().lastReason === 'wall-clock-exceeded', 'liveness: settled wall-clock-exceeded: ' + JSON.stringify(s.results()) + ' ' + s.getJob().lastReason);
  }

  /* ---- LIVENESS: a sleep never moves startedAt, so maxWallMs still counts the sleep ---- */
  {
    const s = setup({ maxWallMs: 90 * MIN, tickMs: MIN });
    s.driver.applyTick(s.clock.now());
    const started = s.driver.leases.get('j').startedAt;
    s.clock.advance(60 * MIN);
    s.driver.applyTick(s.clock.now());
    A.eq(s.driver.leases.get('j') && s.driver.leases.get('j').startedAt, started, 'liveness: the rebase leaves startedAt alone');
    s.clock.advance(31 * MIN);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs[0].signal.aborted, true, 'liveness: a run slept past maxWallMs in total is ended as before (owner decision 14)');
  }

  /* ---- LIVENESS: deps tickMs absent — a clock jump reclaims exactly as before (no rebase) ---- */
  {
    const s = setup();
    s.driver.applyTick(s.clock.now());
    s.clock.advance(9 * MIN);
    s.driver.applyTick(s.clock.now());
    A.eq(s.reclaims(), 1, 'liveness: without tickMs a 9-minute gap with no event reclaims as base');
  }

  /* ---- LIVENESS: hand-built leases without openCalls (host Run Now shape, recovery fixtures) sweep as base ---- */
  {
    const s = setup({ every: 'every 1d' });
    const ac = new AbortController();
    s.driver.leases.set('j', { runId: 'press1', startedAt: T0, heartbeatAt: T0, ac, isOnce: false, pausedAtStart: false });
    s.driver.noteLeaseEvent && s.driver.noteLeaseEvent('j', 'other-run', 'agent.tool_call', { callId: 'x' });   // not this lease's run: ignored
    s.clock.advance(8 * MIN + 1000);
    s.driver.applyTick(s.clock.now());
    A.eq(ac.signal.aborted, true, 'liveness: a hand-built lease with no openCalls is reclaimed past 8 minutes');
    A.eq(typeof s.driver.noteLeaseEvent, 'function', 'the driver exposes noteLeaseEvent for the host seams');
    let threw = null;
    try { s.driver.noteLeaseEvent('missing', 'r', 'agent.tool_call', null); s.driver.noteLeaseEvent('j', 'press1', 'agent.tool_result', undefined); }
    catch (e) { threw = e; }
    A.eq(threw, null, 'noteLeaseEvent never throws (absent lease, absent payload)');
  }

  /* ---- SOURCE PINS: the host wires every seam ---- */
  {
    const index = Source.readSidecarIndex();
    const sched = Source.objectProps(Source.callRegion(index, 'profile: LineRunner.profiles.schedule({', '}) })'));
    const tee = (sched.find(p => p.key === 'tee') || {}).expr || '';
    A.ok(/o\.onHopEvent\(name, p\)/.test(tee), 'pin: the schedule profile\'s tee hands each hop event to o.onHopEvent: ' + tee.slice(0, 160));
    const manual = Source.objectProps(Source.callRegion(index, 'profile: LineRunner.profiles.manual({', '}) });'));
    const memit = (manual.find(p => p.key === 'emit') || {}).expr || '';
    A.ok(/cronDriver\.noteLeaseEvent\(job\.id, runId,/.test(memit), 'pin: the RUN NOW line profile\'s emit renews the press\'s lease: ' + memit.slice(0, 160));
    const runNow = Source.sidecarTopLevelFunction('handleCronRun');
    const teeAt = runNow.indexOf('const teeEmit = (name, payload) => {');
    const teeSrc = teeAt < 0 ? '' : runNow.slice(teeAt, runNow.indexOf("try { cronEmit('cron.fire'", teeAt));
    A.ok(teeAt > 0 && /cronDriver\.noteLeaseEvent\(job\.id, runId, name, payload\)/.test(teeSrc), 'pin: handleCronRun\'s teeEmit reaches the lease through noteLeaseEvent');
    const deps = Source.objectProps(Source.callRegion(index, 'const cronDriver = makeCronDriver({', '\n});'));
    const tick = deps.find(p => p.key === 'tickMs');
    A.ok(!!tick && /CRON_TICK_MS/.test(tick.expr), 'pin: the makeCronDriver deps include tickMs: CRON_TICK_MS');
  }

  A.report('cron-liveness-opencalls');
})().catch(e => { console.error(e); process.exitCode = 1; A.report('cron-liveness-opencalls'); });
