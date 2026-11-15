/* node test/cron-hop-token-liveness.test.js — a scheduled line stage that only streams text is alive (ops-1115 T1b, W9 N1/N2).

   T1 keeps a scheduled fire's lease alive while its run emits or a tool call is in flight, and hands a hop's events to the lease
   through the schedule profile's tee (onHopEvent). But the hop executor returns on agent.token BEFORE the tee (token deltas never
   reach the notify tee), so a scheduled stage that streams text for more than 8 minutes without a tool call (a slow local model,
   a very long report) renewed nothing past hop start and was reclaimed and fired again. Now a hop's tokens renew the fire's lease
   through the profile's lease renewal (beforeHop: the cron driver's onHop), at most once every 15 seconds of the injected clock,
   and never reach the tee. RUN NOW's manual profile already renews on every token through its emit (the host wires
   cronDriver.noteLeaseEvent there); it is covered here as a liveness sibling.

   N2: a ONE-SHOT inside a long tool call. Nothing refreshed its durable heartbeat while the call was open, so once the call had
   been silent past the window every tick planned the one-shot as due and the lease guard wrote an already-running skip (and its
   autonomy-ledger row) on every tick. The sweep now refreshes the durable heartbeat of a one-shot lease with a call in flight
   (throttled by durableHeartbeatMs), without touching the in-memory heartbeat, so toolStaleMs still bounds the run.

   Red at 23fb13fcb (cases 1 and 6); green after. The real cron-driver, cron-store and cron.planTick, the real line runner and its
   production schedule / manual profiles wired as index.js wires them, an injected clock, and run fakes that never resolve. */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const { makeLineRunner, profiles } = require('../sidecar/routing/line-runner.js');

const T0 = 1700000000000, MIN = 60000, SEC = 1000;
const flush = () => new Promise(r => setImmediate(r));
const flushAll = async () => { for (let i = 0; i < 6; i++) await flush(); };

// one routine due at T0 whose entry run finishes stage one at once; its line then runs ONE hop through the real line runner
// with the production schedule profile, wired exactly as index.js wires it (beforeHop: o.onHop; the tee hands each event to
// o.onHopEvent before the notify view). The hop's run never resolves: the test drives its stream.
function scheduledLine() {
  const clock = makeClock(T0);
  const job = cronStore.makeJob({ id: 'j', prompt: 'write the long report', agentId: 'agent', schedule: cron.parseSchedule('every 6h', T0), runsLine: true }, { id: 'j', now: T0 });
  let store = [Object.assign({}, job, { enabled: true, nextRunAt: new Date(T0).toISOString() })];
  const events = [], teed = [], hops = [];
  let idN = 0, beats = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; return true; },
    runOnce: (o) => {
      o.emit('agent.token', { runId: o.runId, delta: 'stage one' });
      o.emit('agent.run.end', { runId: o.runId, reason: 'done', outcome: 'succeeded' });
      return Promise.resolve({ text: 'stage one' });
    },
    emit: (name, payload) => events.push({ name, payload }),
    newId: () => 'run-' + (++idN), newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 8 * MIN,
    advanceChain: (o) => {
      const runner = makeLineRunner({ runOnce: (ho) => { hops.push(ho); return new Promise(() => {}); }, now: () => clock.now(), newId: () => 'hop-' + (++idN) });
      const profile = profiles.schedule({
        streamId: o.streamId, config: () => ({ key: 'k', model: 'm' }), routine: o, system: () => 'S', station: () => null,
        beforeHop: function () { beats++; if (typeof o.onHop === 'function') o.onHop(); },
        tee: (name, p) => { if (typeof o.onHopEvent === 'function') o.onHopEvent(name, p); teed.push({ name, p }); }
      });
      return runner.hopRunner(profile)({ agentId: 'editor', text: o.text, signal: o.signal, hop: 1, from: o.agentId });
    }
  });
  const reclaims = () => events.filter(e => e.name === 'cron.skipped' && e.payload.reason === 'stale-lock-reclaimed').length;
  return { driver, clock, events, teed, hops, reclaims, beats: () => beats, getJob: () => cronStore.getJob(store, 'j') };
}

// a ONE-SHOT due now, a driver with its lease sweep and planTick; counts durable writes
function oneShot() {
  const clock = makeClock(T0);
  const job = cronStore.makeJob({ id: 'o', prompt: 'build it', agentId: 'agent', schedule: cron.parseSchedule('in 1m', T0) }, { id: 'o', now: T0 });
  let store = [job];
  const events = [], runs = [];
  let idN = 0, writes = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; writes++; return true; },
    runOnce: (o) => { runs.push(o); return new Promise(() => {}); },
    emit: (name, payload) => events.push({ name, payload }),
    newId: () => 'r' + (++idN), newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'k', defaultModel: 'm', persona: 'P', maxRunMs: 8 * MIN, tickMs: MIN
  });
  const count = (reason) => events.filter(e => e.name === 'cron.skipped' && e.payload.reason === reason).length;
  return { driver, clock, events, runs, count, writes: () => writes, getJob: () => cronStore.getJob(store, 'o') };
}

(async () => {
  /* ---- (1) RED: a scheduled hop streams text for 20 minutes with no tool call — the fire is not reclaimed ---- */
  {
    const s = scheduledLine();
    s.driver.applyTick(s.clock.now());
    await flushAll();
    A.eq(s.hops.length, 1, '(1) stage one settled and the line started its hop');
    const hop = s.hops[0], sig = s.hops[0].signal;
    const beatsAtStart = s.beats();
    A.eq(beatsAtStart, 1, '(1) the hop start renewed the lease once (beforeHop, as before)');
    hop.emit('agent.run.start', { runId: hop.runId });
    let tokens = 0;
    for (let m = 0; m < 20; m++) {
      for (let k = 0; k < 12; k++) { s.clock.advance(5 * SEC); hop.emit('agent.token', { runId: hop.runId, delta: 'SECRET-PROSE-' + (tokens++) + ' ' }); }
      s.driver.applyTick(s.clock.now());
    }
    A.eq(sig.aborted, false, '(1) a hop streaming only text for 20 minutes is not aborted');
    A.eq(s.reclaims(), 0, '(1) and the fire is not stale-lock-reclaimed');
    A.ok(!!s.driver.leases.get('j'), '(1) the fire still holds its lease');
    // CHEAP: one renewal per 15 s of the hop's clock at most, whatever the token rate (240 tokens here)
    const renewals = s.beats() - beatsAtStart;
    A.ok(renewals >= 60 && renewals <= 81, '(1) tokens renew at most once per 15 s (240 tokens, 20 min -> ~80 renewals): ' + renewals);
    // the token stream never reaches the notify tee (no new event, no text forwarded)
    A.eq(s.teed.filter(e => e.name === 'agent.token').length, 0, '(1) no token event reaches the notify tee');
    A.ok(!JSON.stringify(s.teed).includes('SECRET-PROSE'), '(1) no token text reaches the notify tee');
    A.ok(s.teed.some(e => e.name === 'agent.run.start'), '(1) the hop\'s other events still reach the tee');
  }

  /* ---- (2) LIVENESS: a truly silent hop (no tokens, no call in flight) is still reclaimed past 8 minutes ---- */
  {
    const s = scheduledLine();
    s.driver.applyTick(s.clock.now());
    await flushAll();
    A.eq(s.hops.length, 1, '(2) the hop started');
    s.clock.advance(8 * MIN);
    s.driver.applyTick(s.clock.now());
    A.eq(s.reclaims(), 0, '(2) 8 minutes of hop silence is still inside the window');
    s.clock.advance(1000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.hops[0].signal.aborted, true, '(2) a silent hop is aborted past 8 minutes');
    A.eq(s.reclaims(), 1, '(2) and the fire is reclaimed once, exactly as before');
  }

  /* ---- (3) LIVENESS: tokens that stop do not keep a hop alive — 8 minutes after the last renewal it is reclaimed ---- */
  {
    const s = scheduledLine();
    s.driver.applyTick(s.clock.now());
    await flushAll();
    const hop = s.hops[0];
    for (let k = 0; k < 60; k++) { s.clock.advance(5 * SEC); hop.emit('agent.token', { runId: hop.runId, delta: '.' }); }   // 5 minutes of text
    s.driver.applyTick(s.clock.now());
    A.eq(s.reclaims(), 0, '(3) streaming for 5 minutes');
    s.clock.advance(8 * MIN);
    s.driver.applyTick(s.clock.now());
    A.eq(s.reclaims(), 0, '(3) 8 minutes after the last renewal is still inside the window');
    s.clock.advance(15 * SEC + 1000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.reclaims(), 1, '(3) the stream stopped: the fire is reclaimed once the window passes');
  }

  /* ---- (4) LIVENESS: RUN NOW's manual profile — every token reaches its emit (the watcher's stream and the press's lease) ---- */
  {
    const clock = makeClock(T0);
    const job = cronStore.makeJob({ id: 'j', prompt: 'p', agentId: 'agent', schedule: cron.parseSchedule('every 1d', T0) }, { id: 'j', now: T0 });
    let store = [Object.assign({}, job, { enabled: true, nextRunAt: new Date(T0 + 24 * 60 * MIN).toISOString() })];
    const events = [];
    const driver = makeCronDriver({
      getJobs: () => store, setJobs: (j) => { store = j; return true; }, runOnce: () => new Promise(() => {}),
      emit: (name, payload) => events.push({ name, payload }), newId: () => 'x', newAbort: () => new AbortController(), now: () => clock.now(),
      getKey: () => 'k', defaultModel: 'm', persona: 'P', maxRunMs: 8 * MIN
    });
    const ac = new AbortController();
    driver.leases.set('j', { runId: 'press', startedAt: T0, heartbeatAt: T0, ac, isOnce: false, pausedAtStart: false });   // the host's Run Now lease shape
    const streamed = [], hops = [];
    const runner = makeLineRunner({ runOnce: (ho) => { hops.push(ho); return new Promise(() => {}); }, now: () => clock.now(), newId: () => 'mhop' });
    const profile = profiles.manual({
      streamId: 'cron-press', config: () => ({ key: 'k', model: 'm' }), routine: {}, system: () => 'S', station: () => null,
      emit: (n, p) => { driver.noteLeaseEvent('j', 'press', n, p); streamed.push(n); }   // as index.js wires the RUN NOW line profile
    });
    runner.hopRunner(profile)({ agentId: 'editor', text: 'go', signal: ac.signal, hop: 1, from: 'agent' });
    await flushAll();
    A.eq(hops.length, 1, '(4) the RUN NOW hop started');
    for (let m = 0; m < 20; m++) {
      for (let k = 0; k < 12; k++) { clock.advance(5 * SEC); hops[0].emit('agent.token', { runId: hops[0].runId, delta: 'x' }); }
      driver.applyTick(clock.now());
    }
    A.eq(ac.signal.aborted, false, '(4) a RUN NOW hop streaming text for 20 minutes is not reclaimed');
    A.eq(streamed.filter(n => n === 'agent.token').length, 240, '(4) every token still reaches the watcher\'s stream (unchanged)');
  }

  /* ---- (5) BY CONSTRUCTION: a channel hop has no lease renewal; its tokens call nothing new and the hop still settles ---- */
  {
    let teeCalls = 0;
    const runner = makeLineRunner({
      runOnce: async (o) => {
        for (let k = 0; k < 5; k++) o.emit('agent.token', { runId: o.runId, delta: 'w' });
        o.emit('agent.run.end', { runId: o.runId, reason: 'done', outcome: 'succeeded' });
        return { reason: 'done', outcome: 'succeeded', text: 'done work' };
      },
      now: (() => { let t = T0; return () => (t += 20 * SEC); })(), newId: () => 'chop', runRow: () => null
    });
    const profile = Object.assign(profiles.channel({ channel: 'telegram', chatId: '42', config: () => ({ key: 'k', model: 'm' }), persona: () => 'P' }), { tee: () => { teeCalls++; } });
    const r = await runner.hopRunner(profile)({ agentId: 'editor', text: 'go' });
    A.eq([r.text, r.stopCode || null], ['done work', null], '(5) a channel hop with tokens settles as before');
    A.eq(teeCalls, 1, '(5) only the run end reached its tee (tokens never do)');
  }

  /* ---- (6) RED (N2): a one-shot 20 minutes into a tool call is not planned again on every tick ---- */
  {
    const s = oneShot();
    s.clock.advance(MIN);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, '(6) the one-shot fired');
    const o = s.runs[0];
    o.emit('agent.run.start', { runId: o.runId });
    o.emit('agent.tool_call', { runId: o.runId, callId: 'c1', name: 'shell.exec' });
    const writesBefore = s.writes();
    for (let k = 1; k <= 20; k++) { s.clock.advance(MIN); s.driver.applyTick(s.clock.now()); }
    A.eq(s.count('already-running'), 0, '(6) no already-running skip is written while the call is in flight: ' + s.count('already-running'));
    A.eq([s.runs.length, o.signal.aborted, s.count('stale-lock-reclaimed')], [1, false, 0], '(6) one start, the run alive, no reclaim');
    const durable = s.writes() - writesBefore;
    A.ok(durable <= 12, '(6) the durable heartbeat is refreshed at most once per durableHeartbeatMs (2 min): ' + durable + ' writes in 20 min');
    A.ok(s.getJob().heartbeatAt >= s.clock.now() - 2 * MIN - MIN, '(6) the durable heartbeat is fresh: ' + (s.clock.now() - s.getJob().heartbeatAt) + ' ms old');
    // the in-memory heartbeat is not touched: toolStaleMs (24 min) still bounds the call
    for (let k = 0; k < 4; k++) { s.clock.advance(MIN); s.driver.applyTick(s.clock.now()); }   // ticks on time (no suspend rebase)
    A.eq(o.signal.aborted, false, '(6) exactly 24 minutes into the call it is still alive');
    s.clock.advance(1000);
    s.driver.applyTick(s.clock.now());
    A.eq(o.signal.aborted, true, '(6) the call silent past 24 minutes is still aborted (toolStaleMs bounds it)');
    A.eq(s.count('stale-lock-reclaimed'), 1, '(6) and reclaimed once');
    A.eq(s.getJob().heartbeatAt, null, '(6) the reclaim clears the durable heartbeat (markRun)');
  }

  /* ---- (7) LIVENESS (N2): a one-shot with NO call in flight gets no durable refresh from the sweep ---- */
  {
    const s = oneShot();
    s.clock.advance(MIN);
    s.driver.applyTick(s.clock.now());
    const o = s.runs[0];
    o.emit('agent.run.start', { runId: o.runId });
    const stamped = s.getJob().heartbeatAt;
    for (let k = 1; k <= 7; k++) { s.clock.advance(MIN); s.driver.applyTick(s.clock.now()); }
    A.eq(s.getJob().heartbeatAt, stamped, '(7) a silent one-shot\'s durable heartbeat is not refreshed by the sweep');
    s.clock.advance(MIN + 1000);
    s.driver.applyTick(s.clock.now());
    A.eq([o.signal.aborted, s.count('stale-lock-reclaimed')], [true, 1], '(7) and it is reclaimed past 8 minutes, as before');
  }

  A.report('cron-hop-token-liveness');
})().catch(e => { console.error(e); process.exitCode = 1; A.report('cron-hop-token-liveness'); });
