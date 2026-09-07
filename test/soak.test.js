/* node test/soak.test.js
   Locks the scripted soak harness's PURE core (scripts/qa/soak.mjs) with fake tick streams — no sidecar,
   no clock, no OS probes. Proves:
     - CLI arg parsing (defaults, overrides, the restart-interval clamp, rejection of bad numbers)
     - statistics helpers (percentile, least-squares slope, bounded downsampling)
     - a flat RSS series PASSES; a monotonically leaking series FAILS the rss rule
     - a sustained swallowed-error slope in the last third FAILS; a one-off blip does not
     - a restart cycle that loses a persisted entity FAILS the restart rule; a clean cycle passes
     - an unplanned exit / orphan child FAILS the process rule
     - a p95 health stall FAILS the latency rule
     - unobtainable metrics stay null WITH a reason (never a reassuring 0)
     - receipt shape lock + the summary renders every rule
     - the orchestrator, driven by a scripted fake world, completes a full soak and produces a PASS */
'use strict';
const A = require('./_assert.js');

function series(n, fn, opts) {
  const o = opts || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = (o.t0 || 1_000_000) + i * (o.stepMs || 15_000);
    out.push(Object.assign({ at, tick: i + 1, epoch: o.epoch == null ? 0 : (typeof o.epoch === 'function' ? o.epoch(i) : o.epoch), rssBytes: 100 * 1048576, healthMs: { median: 3, max: 8 }, swallowedTotal: 0, swallowedTags: {}, errorRingSeen: 0, workspaceBytes: 1000 + i, runs: { ok: i, failed: 0 }, routineFires: 1 }, fn ? fn(i) : {}));
  }
  return out;
}

function healthyInput(samples, extra) {
  return Object.assign({
    samples, completed: true, runs: { ok: 10, failed: 0, errors: [] }, routineFires: 2,
    restarts: [{ at: samples[Math.floor(samples.length / 2)].at, epoch: 0, before: { agents: ['a'], routines: ['r1'], runs: ['x', 'y'], turns: ['0|1|user'] }, after: { agents: ['a'], routines: ['r1'], runs: ['x', 'y', 'z'], turns: ['0|1|user', '1|2|assistant'] }, bootMs: 900, stopMode: 'SIGTERM' }],
    process: { unexpectedExits: 0, orphans: [], orphanCheck: 'enumerated after stop' },
    startedAt: samples[0].at, endedAt: samples[samples.length - 1].at, plannedMinutes: 10, options: { minutes: 10 }, meta: { sidecarHead: 'abc' },
  }, extra || {});
}

(async () => {
  const M = await import('../scripts/qa/soak.mjs');

  // Full, anchored history must survive capped-page rollover; genuine deletion still fails.
  {
    const assert = require('node:assert/strict');
    const original = Array.from({ length: 1001 }, (_, i) => ({ runId: 'run-' + (1000 - i), ts: 1000 - i }));
    let rows = original.slice();
    const json = async (_, route) => {
      const q = new URL(route, 'http://fixture').searchParams;
      const through = Number(q.get('through') || 2000);
      const visible = rows.filter(r => r.ts <= through);
      const start = q.has('beforeRunId') ? visible.findIndex(r => r.runId === q.get('beforeRunId')) + 1 : 0;
      const page = visible.slice(start, start + 500);
      return { status: 200, body: { runs: page, snapshotAt: through, nextCursor: start + 500 < visible.length ? page.at(-1).runId : '' } };
    };
    const before = await M.readRunHistory(json);
    A.eq(before.ids.length, 1001, 'restart snapshot reads beyond two capped pages');
    rows.unshift({ runId: 'new-after-snapshot', ts: 2001 });
    A.eq((await M.readRunHistory(json, before.through)).ids, before.ids, 'new run does not roll an old row out of anchored comparison');
    rows = rows.filter(r => r.runId !== 'run-0');
    const after = await M.readRunHistory(json, before.through);
    A.eq(before.ids.filter(id => !after.ids.includes(id)), ['run-0'], 'genuine loss beyond first 500 rows remains detectable');
    await assert.rejects(() => M.readRunHistory(async () => ({ status: 500, body: {} })), /unreadable/);
    await assert.rejects(() => M.readRunHistory(async () => ({ status: 200, body: { runs: [], snapshotAt: 2001 } }), 2000), /watermark changed/);
    await assert.rejects(() => M.readRunHistory(async () => ({ status: 200, body: { runs: [{ runId: 'repeat' }], snapshotAt: 2000, nextCursor: 'repeat' } })), /duplicate|advance/);
    A.ok(true, 'unreadable, unstable and looping history fail loudly');
  }

  {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-soak-preservation-test-'));
    try {
      const fixture = { workspace: path.join(root, 'workspace'), profile: path.join(root, 'profile') };
      for (const dir of Object.values(fixture)) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(fixture.workspace, 'runs.jsonl'), '{"runId":"retained"}\n');
      fs.writeFileSync(path.join(fixture.profile, 'state.json'), '{"kept":true}');
      const saved = M.preserveSoakState(fixture, path.join(root, 'out'));
      fs.rmSync(fixture.workspace, { recursive: true }); fs.rmSync(fixture.profile, { recursive: true });
      A.eq(fs.readFileSync(path.join(saved.workspace, 'runs.jsonl'), 'utf8'), '{"runId":"retained"}\n', 'history remains after fixture disposal');
      A.eq(fs.readFileSync(path.join(saved.profile, 'state.json'), 'utf8'), '{"kept":true}', 'profile remains after fixture disposal');
      A.throws(() => M.preserveSoakState(fixture, path.join(root, 'out')), 'forensic evidence cannot be overwritten');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  // ---- parseArgs
  {
    const d = M.parseArgs([]);
    A.eq(d.minutes, M.DEFAULTS.minutes, 'default minutes');
    A.eq(d.restartEvery, Math.min(M.DEFAULTS.restartEvery, Math.floor(M.DEFAULTS.minutes / 2)), 'restart interval clamps to half the soak');
    const s = M.parseArgs(['--minutes=6', '--tick-seconds=10', '--restart-every=30', '--out=/tmp/x', '--aux']);
    A.eq([s.minutes, s.tickSeconds, s.restartEvery, s.out, s.aux], [6, 10, 3, '/tmp/x', true], 'overrides + clamp (30 → 3 for a 6-minute soak)');
    A.eq(M.parseArgs(['--minutes=720']).restartEvery, M.DEFAULTS.restartEvery, 'a long soak keeps the default restart interval');
    A.throws(() => M.parseArgs(['--minutes=0']), 'minutes must be ≥ 1');
    A.throws(() => M.parseArgs(['--tick-seconds=abc']), 'non-numeric tick rejected');
    A.eq(M.parseArgs(['--help']).help, true, '--help flag');
  }

  // ---- statistics
  {
    A.eq(M.percentile([], 95), null, 'percentile of nothing is null');
    A.eq(M.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10, 'p95 of 1..10');
    A.eq(M.percentile([5, 1, 3], 50), 3, 'median sorts');
    A.eq(M.linearSlope([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }]), 2, 'slope of y=2x');
    A.eq(M.linearSlope([{ x: 1, y: 5 }]), null, 'one point has no slope');
    A.eq(M.linearSlope([{ x: 1, y: 5 }, { x: 1, y: 9 }]), null, 'vertical has no slope');
    const b = M.boundSamples(series(100), 10);
    A.eq(b.length, 10, 'downsampled to 10');
    A.eq([b[0].tick, b[9].tick], [1, 100], 'keeps first and last');
    A.eq(M.boundSamples(series(5), 10).length, 5, 'short series untouched');
  }

  // ---- flat series PASSES
  {
    const r = M.evaluate(healthyInput(series(40)));
    A.eq(r.verdict, 'PASS', 'flat healthy series passes: ' + JSON.stringify(r.failedRules));
    A.eq(r.rules.rss.actual.slopeMBPerMin, 0, 'flat RSS slope is 0');
    A.eq(r.rules.swallowed.actual.count, 0, 'no swallowed growth');
  }

  // ---- leak FAILS
  {
    const leak = series(40, (i) => ({ rssBytes: (100 + i * 3) * 1048576 }));   // +3 MB per 15s tick = 12 MB/min, +60% over the half
    const r = M.evaluate(healthyInput(leak));
    A.eq(r.verdict, 'FAIL', 'leaking series fails');
    A.eq(r.failedRules, ['rss'], 'only the rss rule fails');
    A.ok(r.rules.rss.actual.slopeMBPerMin > M.RULES.rss.maxSlopeMBPerMin, 'slope reported above threshold: ' + r.rules.rss.actual.slopeMBPerMin);
    // GC sawtooth: big swings, no net growth → passes
    const saw = series(40, (i) => ({ rssBytes: (100 + (i % 4) * 30) * 1048576 }));
    A.eq(M.evaluate(healthyInput(saw)).rules.rss.pass, true, 'a GC sawtooth with no net growth passes');
    // steep slope but under the growth floor → passes (both conditions are required)
    const tiny = series(40, (i) => ({ rssBytes: (1000 + i * 1) * 1048576 }));   // 4 MB/min on a 1 GB base = 2% growth
    A.eq(M.evaluate(healthyInput(tiny)).rules.rss.pass, true, 'slope over threshold but growth under 20% passes');
    // restart mid-series: each epoch judged separately; a post-restart epoch that leaks fails
    const epochLeak = series(40, (i) => ({ epoch: i < 20 ? 0 : 1, rssBytes: (i < 20 ? 100 : 100 + (i - 20) * 5) * 1048576 }));
    const er = M.evaluate(healthyInput(epochLeak));
    A.eq([er.rules.rss.pass, er.rules.rss.actual.epoch], [false, 1], 'the leaking post-restart epoch is the one judged');
  }

  // ---- swallowed pressure
  {
    const sustained = series(30, (i) => ({ swallowedTotal: i }));   // +1 per 15s tick = 4/min for the whole soak
    const r = M.evaluate(healthyInput(sustained));
    A.eq(r.rules.swallowed.pass, false, 'a sustained swallow rate fails');
    A.ok(r.rules.swallowed.actual.ratePerMin > M.RULES.swallowed.maxRatePerMin, 'rate reported');
    const blip = series(30, (i) => ({ swallowedTotal: i >= 25 ? 1 : 0 }));
    A.eq(M.evaluate(healthyInput(blip)).rules.swallowed.pass, true, 'a single blip in the last third does not fail (count < 3)');
    const early = series(30, (i) => ({ swallowedTotal: i < 10 ? i : 10 }));
    A.eq(M.evaluate(healthyInput(early)).rules.swallowed.pass, true, 'growth that stopped before the last third passes');
    // restart resets the tally: a drop across an epoch boundary is not negative growth and not counted
    const reset = series(30, (i) => ({ epoch: i < 20 ? 0 : 1, swallowedTotal: i < 20 ? 2 : 0 }));
    const rr = M.evaluate(healthyInput(reset));
    A.eq([rr.rules.swallowed.pass, rr.rules.swallowed.actual.count], [true, 0], 'tally reset at restart is not growth');
  }

  // ---- latency
  {
    const stall = series(40, (i) => ({ healthMs: { median: 5, max: i >= 20 ? 900 : 8 } }));
    const r = M.evaluate(healthyInput(stall));
    A.eq(r.rules.latency.pass, false, 'p95 stall in the last half fails');
    A.eq(r.rules.latency.actual.p95Ms, 900, 'p95 reported');
    const early = series(40, (i) => ({ healthMs: { median: 5, max: i < 5 ? 900 : 8 } }));
    A.eq(M.evaluate(healthyInput(early)).rules.latency.pass, true, 'a boot-time spike outside the last half passes');
  }

  // ---- restart entity loss
  {
    const lost = healthyInput(series(40));
    lost.restarts = [{ at: 1, epoch: 0, before: { agents: ['a'], routines: ['r1', 'r2'], runs: ['x', 'y'], turns: ['0|1|user'] }, after: { agents: ['a'], routines: ['r1'], runs: ['x', 'y'], turns: ['0|1|user'] }, bootMs: 800 }];
    const r = M.evaluate(lost);
    A.eq(r.rules.restart.pass, false, 'a lost routine fails the restart rule');
    A.eq(r.rules.restart.actual.detail[0].lost, { routines: ['r2'] }, 'names the lost id by kind');
    const none = healthyInput(series(40), { restarts: [] });
    A.eq(M.evaluate(none).rules.restart.pass, false, 'zero restart cycles is a FAIL, not a pass by absence');
    const errored = healthyInput(series(40)); errored.restarts = [{ at: 1, epoch: 0, before: { agents: ['a'] }, after: null, error: 'boot timed out' }];
    A.eq(M.evaluate(errored).rules.restart.pass, false, 'a restart that errored fails');
    const unreadable = healthyInput(series(40)); unreadable.restarts = [{ at: 1, epoch: 0, before: { agents: ['a'] }, after: { agents: ['a'], routines: ['r9'] } }];
    A.eq(M.evaluate(unreadable).rules.restart.pass, true, 'an entity kind unreadable BEFORE is not judged (cannot be "lost")');
  }

  // ---- process + runs + routine + completed
  {
    A.eq(M.evaluate(healthyInput(series(40), { process: { unexpectedExits: 1, orphans: [] } })).failedRules, ['process'], 'unexpected exit fails process');
    A.eq(M.evaluate(healthyInput(series(40), { process: { unexpectedExits: 0, orphans: [{ pid: 4242, name: 'node.exe' }] } })).failedRules, ['process'], 'an orphan child fails process');
    A.eq(M.evaluate(healthyInput(series(40), { process: { unexpectedExits: 0, orphans: [], transientChildren: [{ pid: 4243, name: 'conhost.exe' }] } })).rules.process.pass, true, 'a transient child (gone within the grace) is a measurement, not a failure');
    A.eq(M.evaluate(healthyInput(series(40), { runs: { ok: 9, failed: 1, errors: [{ reason: 'error' }] } })).failedRules, ['runs'], 'one run error fails (tolerance 0)');
    A.eq(M.evaluate(healthyInput(series(40), { runs: { ok: 0, failed: 0, errors: [] } })).failedRules, ['runs'], 'zero runs measured nothing → FAIL');
    A.eq(M.evaluate(healthyInput(series(40), { routineFires: 0 })).failedRules, ['routine'], 'no routine fire fails');
    A.eq(M.evaluate(healthyInput(series(40), { completed: false, stopReason: 'interrupted' })).failedRules, ['completed'], 'an interrupted soak fails completed');
  }

  // ---- null metrics stay null with a reason
  {
    const blind = series(40, () => ({ rssBytes: null, rssReason: 'OS memory probe returned nothing for pid 1', healthMs: null, swallowedTotal: null, swallowedReason: 'diagnostics.swallowed not present' }));
    const r = M.evaluate(healthyInput(blind));
    A.eq(r.rules.rss.actual.slopeMBPerMin, null, 'rss slope null when unsampled');
    A.ok(/OS memory probe/.test(r.rules.rss.actual.reason), 'rss carries the probe reason');
    A.eq(r.rules.latency.actual.p95Ms, null, 'latency null when unsampled');
    A.ok(!!r.rules.latency.actual.reason, 'latency null carries a reason');
    A.eq(r.rules.swallowed.actual.ratePerMin, null, 'swallowed null when unsampled');
    A.ok(!!r.rules.swallowed.actual.reason, 'swallowed null carries a reason');
    A.eq(r.verdict, 'PASS', 'null metrics are not failures (they are honest unknowns)');
    const rec = M.buildReceipt(healthyInput(blind));
    A.eq(rec.measurements.heapBytes, null, 'heap is null'); A.ok(!!rec.measurements.heapReason, 'heap null has a reason');
    A.eq(rec.measurements.openHandles, null, 'open handles null'); A.ok(!!rec.measurements.openHandlesReason, 'open handles null has a reason');
  }

  // ---- receipt shape lock + summary
  {
    const input = healthyInput(series(1000), { maxSamples: 50 });
    const rec = M.buildReceipt(input);
    A.eq(rec.schema, M.RECEIPT_SCHEMA, 'schema id');
    A.eq(Object.keys(rec).sort(), ['actualMinutes', 'endedAt', 'failedRules', 'measurements', 'meta', 'options', 'plannedMinutes', 'processSnapshots', 'rules', 'samples', 'schema', 'sidecarHead', 'startedAt', 'verdict'].sort(), 'receipt top-level keys');
    A.eq(Object.keys(rec.rules).sort(), Object.keys(M.RULES).sort(), 'every RULE has a verdict row');
    for (const [k, v] of Object.entries(rec.rules)) {
      A.eq(typeof v.pass, 'boolean', k + ' has a boolean pass');
      A.ok(v.actual && typeof v.actual === 'object', k + ' has actual numbers');
      A.ok(v.expected && typeof v.expected === 'object', k + ' has an expected threshold');
      A.ok(typeof v.why === 'string' && v.why.length > 20, k + ' states why');
    }
    A.eq(rec.samples.length, 50, 'samples bounded to maxSamples');
    A.eq(rec.sidecarHead, 'abc', 'head sha carried');
    A.eq(rec.verdict, 'PASS', 'receipt verdict');
    A.ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.startedAt), 'ISO start');
    const md = M.renderSummary(rec);
    A.ok(/# StarNet soak — PASS/.test(md), 'summary headline');
    for (const k of Object.keys(M.RULES)) A.ok(new RegExp('\\| ' + k + ' \\|').test(md), 'summary row for ' + k);
    A.ok(/does not replace the attended packaged-desktop soak/.test(md), 'summary never claims to replace the packaged soak');
  }

  // ---- orchestrator with a scripted fake world (virtual clock, no sleeping)
  {
    let t = 1_000_000;
    let pid = 100, alive = false, stopped = 0, bootCount = 0;
    const routineRuns = [];
    let runCount = 0;
    const jsonRoutes = {
      'POST /api/roster': () => ({ status: 200, body: { ok: true } }),
      'POST /api/cron': () => ({ status: 200, body: { ok: true, job: { id: 'r1' } } }),
      'POST /api/cron/arm': () => ({ status: 200, body: { ok: true } }),
      'GET /api/health': () => { t += 2; return { status: 200, body: 'ok' }; },
      'GET /api/diagnostics': () => ({ status: 200, body: { report: { agentCount: 1, swallowed: { present: true, total: 0, tags: [] }, errors: [] } } }),
      'GET /api/state/snapshot': () => ({ status: 200, body: { runs: [] } }),
      'GET /api/cron': () => { if (Math.floor((t - 1_000_000) / 60_000) > routineRuns.length) routineRuns.push('cron-' + routineRuns.length); return { status: 200, body: { jobs: [{ id: 'r1', lastRunId: routineRuns[routineRuns.length - 1] || null, lastStatus: 'ok', lastReason: 'done' }] } }; },
    };
    const drivers = {
      stopMode: 'fake',
      pid: () => pid,
      async boot() { alive = true; bootCount++; return { pid }; },
      async restart() { alive = true; pid++; bootCount++; t += 800; return { pid }; },
      async stop() { alive = false; stopped++; },
      isAlive: () => alive,
      childrenOf: async () => [],
      async json(m, r) { const key = m + ' ' + r.split('?')[0]; if (r.startsWith('/api/runs')) return { status: 200, body: { runs: Array.from({ length: runCount }, (_, i) => ({ runId: 'run' + i })), snapshotAt: Number(new URL(r, 'http://fixture').searchParams.get('through') || t), nextCursor: '' } }; if (r.startsWith('/api/transcript')) return { status: 200, body: { turns: Array.from({ length: runCount * 2 }, (_, i) => ({ ts: i, role: i % 2 ? 'assistant' : 'user' })) } }; const h = jsonRoutes[key]; if (!h) throw new Error('no fake route ' + key); return h(); },
      async runConversation() { runCount++; t += 300; return { reason: 'done', toolOk: true }; },
      rss: async () => 90 * 1048576,
      workspaceBytes: () => 5000 + runCount,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      log: () => {},
    };
    const opts = M.parseArgs(['--minutes=6', '--tick-seconds=15', '--restart-every=2']);
    const result = await M.runSoak(drivers, opts);
    const rec = M.buildReceipt(Object.assign({}, result, { meta: { sidecarHead: 'fake' } }));
    A.eq(rec.verdict, 'PASS', 'scripted healthy world passes: ' + JSON.stringify(rec.failedRules) + ' ' + JSON.stringify(rec.rules.restart.actual.detail));
    A.ok(result.restarts.length >= 2, 'two restart cycles in 6 minutes at every 2: ' + result.restarts.length);
    A.ok(result.samples.length >= 20, 'one sample per tick: ' + result.samples.length);
    A.ok(result.runs.ok > 0 && result.runs.failed === 0, 'runs counted');
    A.ok(result.routineFires >= 1, 'routine fires counted: ' + result.routineFires);
    A.eq(alive, false, 'sidecar stopped at the end');
    A.eq(stopped, result.restarts.length + 1, 'one stop per restart plus the final stop');
    A.eq(result.completed, true, 'completed');

    // the same world, but the sidecar dies mid-soak → process rule fails, soak ends early, still a receipt
    let t2 = 1_000_000; let alive2 = true;
    const dying = Object.assign({}, drivers, { now: () => t2, sleep: async (ms) => { t2 += ms; if (t2 > 1_000_000 + 90_000) alive2 = false; }, isAlive: () => alive2, async boot() { alive2 = true; return { pid: 1 }; }, async restart() { alive2 = true; return { pid: 2 }; }, async stop() { alive2 = false; }, async json(m, r) { if (m === 'GET' && r === '/api/health') t2 += 2; return drivers.json(m, r); } });
    const dead = await M.runSoak(dying, M.parseArgs(['--minutes=6', '--tick-seconds=15']));
    const deadRec = M.buildReceipt(dead);
    A.eq(deadRec.verdict, 'FAIL', 'a dying sidecar fails');
    A.ok(deadRec.failedRules.includes('process') && deadRec.failedRules.includes('completed'), 'process + completed both fail: ' + JSON.stringify(deadRec.failedRules));
    A.eq(deadRec.rules.process.actual.unexpectedExits, 1, 'the unexpected exit is counted');

    // a world whose restart loses the routine → restart rule fails
    let t3 = 1_000_000;
    let lostOnce = false;
    const lossy = Object.assign({}, drivers, { now: () => t3, sleep: async (ms) => { t3 += ms; }, async restart() { lostOnce = true; t3 += 800; return { pid: 9 }; }, async json(m, r) { if (m === 'GET' && r === '/api/health') t3 += 2; if (m === 'GET' && r === '/api/cron' && lostOnce) return { status: 200, body: { jobs: [] } }; return drivers.json(m, r); } });
    const lost = await M.runSoak(lossy, M.parseArgs(['--minutes=4', '--tick-seconds=15', '--restart-every=2']));
    const lostRec = M.buildReceipt(lost);
    A.ok(lostRec.failedRules.includes('restart'), 'a restart that drops the routine fails: ' + JSON.stringify(lostRec.failedRules));
    A.eq(lostRec.rules.restart.actual.detail[0].lost, { routines: ['r1'] }, 'the lost routine id is named');

    // orphan probe: a child alive at stop but gone after the grace is transient; one that stays is an orphan (named)
    let t4 = 1_000_000; let probes = 0;
    const zombie = Object.assign({}, drivers, { now: () => t4, sleep: async (ms) => { t4 += ms; }, async json(m, r) { if (m === 'GET' && r === '/api/health') t4 += 2; return drivers.json(m, r); },
      childrenOf: async () => { probes++; return probes === 1 ? [{ pid: 77, name: 'conhost.exe', cmd: null }, { pid: 78, name: 'node.exe', cmd: 'node dev-server.js' }] : [{ pid: 78, name: 'node.exe', cmd: 'node dev-server.js' }]; } });
    const z = await M.runSoak(zombie, M.parseArgs(['--minutes=4', '--tick-seconds=15', '--restart-every=2']));
    const zRec = M.buildReceipt(z);
    A.ok(zRec.failedRules.includes('process'), 'a child that survives the grace fails process: ' + JSON.stringify(zRec.failedRules));
    A.eq(zRec.rules.process.actual.orphans[0].name, 'node.exe', 'the orphan is named');
    A.eq(zRec.rules.process.actual.transientChildren[0].pid, 77, 'the transient child is recorded separately');
    A.ok(/grace/.test(zRec.rules.process.actual.orphanCheck), 'the receipt says a grace re-check happened');
  }

  // ---- ROUTINE SCALE: plan, cron-log parsing, occurrence math, the per-routine accounting verdict
  {
    const cronLib = require('../sidecar/cron.js');
    const iso = (ms) => new Date(ms).toISOString();
    const MIN = 60_000;
    const T0 = Date.UTC(2026, 7, 22, 12, 0, 0);           // 12:00:00Z — a whole minute so cron patterns line up

    // buildRoutinePlan
    {
      A.eq(M.buildRoutinePlan(1).map((p) => p.role), ['fireable'], 'n=1 is the single heartbeat');
      A.eq(M.buildRoutinePlan(1)[0].schedule, 'every 1 minute', 'heartbeat cadence unchanged');
      const p50 = M.buildRoutinePlan(50);
      const roles = p50.reduce((m, p) => { m[p.role] = (m[p.role] || 0) + 1; return m; }, {});
      A.eq(roles, { disabled: 1, unfireable: 2, slow: 3, fireable: 44 }, 'n=50 roles: 1 disabled, 2 unfireable, 3 slow, rest fireable');
      A.eq(new Set(p50.map((p) => p.label)).size, 50, 'labels unique');
      const scheds = new Set(p50.filter((p) => p.role === 'fireable').map((p) => p.schedule));
      A.ok(scheds.has('every 1 minute') && scheds.has('every 2 minutes') && [...scheds].some((s) => /^\*\/2 /.test(s)), 'overlapping cadences: intervals + cron minute patterns');
      for (const p of p50) A.ok(cronLib.parseSchedule(p.schedule, T0), 'every planned schedule parses: ' + p.schedule);
      A.ok(p50.some((p) => p.misfire === 'skip') && p50.some((p) => p.misfire === 'fire_once'), 'both misfire policies are seeded');
      A.eq(M.buildRoutinePlan(3).map((p) => p.role), ['disabled', 'fireable', 'fireable'], 'a tiny plan has no unfireable/slow roles');
    }

    // parseCronLog
    {
      const log = 'boot\n[cron] cron.fire {"jobId":"a","runId":"r1","scheduledFor":1000}\r\nnoise [cron] x\n[cron] cron.skipped {"jobId":"a","reason":"already-running"}\n[cron] cron.tick {"fired":1}\n[cron] cron.result {"jobId":"a","runId":"r1","outcome":"ok","reason":"done"}\n[cron] cron.fire not-json\n';
      const ev = M.parseCronLog(log);
      A.eq(ev.map((e) => e.name), ['cron.fire', 'cron.skipped', 'cron.tick', 'cron.result'], 'only well-formed [cron] lines parse, in order');
      A.eq(ev[0].payload.scheduledFor, 1000, 'payload parsed');
      A.eq(ev.map((e) => e.seq), [0, 1, 2, 3], 'sequence numbers');
      A.eq(M.parseCronLog(''), [], 'empty log');
    }

    // occurrencesBetween — the scheduler's own math
    {
      const every1 = cronLib.parseSchedule('every 1 minute', T0);
      A.eq(M.occurrencesBetween(cronLib, every1, T0, T0 + 3 * MIN, 'UTC'), [T0, T0 + MIN, T0 + 2 * MIN], 'interval occurrences from..to (to exclusive)');
      const star2 = cronLib.parseSchedule('*/2 * * * *', T0);
      A.eq(M.occurrencesBetween(cronLib, star2, T0, T0 + 5 * MIN, 'UTC'), [T0, T0 + 2 * MIN, T0 + 4 * MIN], 'cron */2 occurrences');
      A.eq(M.occurrencesBetween(cronLib, every1, T0, T0, 'UTC'), [], 'empty window');
    }

    // accountRoutines — synthetic event streams → verdict
    const every1 = cronLib.parseSchedule('every 1 minute', T0);
    const fire = (id, at, runId) => ({ name: 'cron.fire', payload: { jobId: id, runId: runId || ('run' + at), scheduledFor: at } });
    const skip = (id, reason) => ({ name: 'cron.skipped', payload: { jobId: id, reason } });
    const result = (id, reason) => ({ name: 'cron.result', payload: { jobId: id, runId: 'x', outcome: 'failed', reason } });
    const snap = (at, jobs) => ({ at, jobs });
    const job = (nextAt, extra) => Object.assign({ nextRunAt: iso(nextAt), enabled: true, lastError: null }, extra || {});
    const routine = (id, role, sched, first) => ({ id, label: id + '-' + role, role, schedule: sched || every1, misfire: 'fire_once', firstNextRunAt: iso(first == null ? T0 + MIN : first) });
    const account = (routines, events, trail, endAt) => M.accountRoutines({ routines, events, trail, endAt: endAt || (T0 + 10 * MIN), cronLib, defaultTz: 'UTC' });
    // a 1-min routine armed for T0+1m, observed advancing three times (polls every 15s) — the store trail
    const trail3 = [snap(T0 + 70_000, { a: job(T0 + 2 * MIN) }), snap(T0 + 85_000, { a: job(T0 + 2 * MIN) }), snap(T0 + 130_000, { a: job(T0 + 3 * MIN) }), snap(T0 + 190_000, { a: job(T0 + 4 * MIN) })];

    {
      const r = account([routine('a', 'fireable')], [fire('a', T0 + MIN), fire('a', T0 + 2 * MIN), fire('a', T0 + 3 * MIN)], trail3);
      A.eq(r.pass, true, 'clean: three owed, three fired → PASS ' + JSON.stringify(r.problems));
      A.eq([r.totals.owed, r.totals.fired, r.totals.lost, r.totals.collapsed], [3, 3, 0, 0], 'clean totals');
    }
    {
      const r = account([routine('a', 'slow')], [fire('a', T0 + MIN), skip('a', 'already-running'), fire('a', T0 + 3 * MIN)], trail3);
      A.eq(r.pass, true, 'an already-running skip is the terminal for the unfired head: ' + JSON.stringify(r.problems));
      A.eq([r.totals.fired, r.totals.alreadyRunning, r.totals.lost], [2, 1, 0], 'skip accounted');
    }
    {
      const r = account([routine('a', 'fireable')], [fire('a', T0 + MIN), fire('a', T0 + 3 * MIN)], trail3);
      A.eq(r.pass, false, 'an advanced occurrence with no terminal is LOST');
      A.eq(r.routines[0].lost, [iso(T0 + 2 * MIN)], 'the lost occurrence is named');
    }
    {
      const r = account([routine('a', 'fireable')], [fire('a', T0 + MIN, 'r1'), fire('a', T0 + MIN, 'r2'), fire('a', T0 + 2 * MIN), fire('a', T0 + 3 * MIN)], trail3);
      A.eq(r.pass, false, 'two fires for one occurrence is a DOUBLE-FIRE');
      A.eq(r.routines[0].doubled, [iso(T0 + MIN)], 'the doubled occurrence is named');
    }
    {
      const r = account([routine('a', 'fireable')], [fire('a', T0 + MIN), fire('a', T0 + 2 * MIN), fire('a', T0 + 3 * MIN), fire('a', T0 + 90_000)], trail3);
      A.eq(r.pass, false, 'a fire at an instant the schedule never owed is UNEXPECTED');
      A.eq(r.routines[0].unexpected, [iso(T0 + 90_000)], 'named');
    }
    {
      // misfire collapse: the store jumps T0+1m → T0+4m in one advance (outage), one catch-up fire for the head
      const trailJump = [snap(T0 + 200_000, { a: job(T0 + 4 * MIN) })];
      const r = account([routine('a', 'fireable')], [fire('a', T0 + MIN)], trailJump);
      A.eq(r.pass, true, 'fire_once catch-up: one fire, the rest collapsed: ' + JSON.stringify(r.problems));
      A.eq([r.totals.owed, r.totals.fired, r.totals.collapsed], [3, 1, 2], 'owed 3 = 1 head + 2 collapsed');
      const rs = account([routine('a', 'fireable')], [skip('a', 'caught-up')], trailJump);
      A.eq(rs.pass, true, 'misfire=skip catch-up: a caught-up skip is the terminal');
      A.eq([rs.totals.caughtUp, rs.totals.collapsed], [1, 2], 'caught-up + collapsed');
      const rb = account([routine('a', 'fireable')], [fire('a', T0 + MIN), fire('a', T0 + 2 * MIN)], trailJump);
      A.eq(rb.pass, false, 'a burst (firing a collapsed occurrence) is UNEXPECTED — the policy promises ONE catch-up');
      const rn = account([routine('a', 'fireable')], [], trailJump);
      A.eq(rn.pass, false, 'a jump with no terminal at all is LOST');
    }
    {
      const trailOff = [snap(T0 + 70_000, { a: job(T0 + 150_000) })];
      const r = account([routine('a', 'fireable')], [fire('a', T0 + MIN)], trailOff);
      A.eq(r.pass, false, 'a nextRunAt the schedule math does not predict is OFF-SCHEDULE');
      A.ok(/predicts/.test(r.routines[0].offSchedule[0]), 'the prediction is in the message: ' + r.routines[0].offSchedule[0]);
      const back = account([routine('a', 'fireable')], [], [snap(T0 + 70_000, { a: job(T0) })]);
      A.eq(back.pass, false, 'a nextRunAt that moves backwards fails');
    }
    {
      const r = account([routine('a', 'fireable')], [skip('a', 'at-capacity'), skip('a', 'at-capacity'), fire('a', T0 + MIN), fire('a', T0 + 2 * MIN), fire('a', T0 + 3 * MIN)], trail3);
      A.eq(r.pass, true, 'at-capacity deferrals are transient: the occurrence still fires');
      A.eq(r.totals.deferred, 2, 'deferrals counted');
    }
    {
      const flat = [snap(T0 + 70_000, { d: job(T0 + MIN, { enabled: false }) }), snap(T0 + 200_000, { d: job(T0 + MIN, { enabled: false }) })];
      A.eq(account([routine('d', 'disabled')], [skip('d', 'disabled')], flat).pass, true, 'paused + due + reported once → ok');
      A.eq(account([routine('d', 'disabled')], [], flat).pass, false, 'paused + due but never reported → FAIL');
      A.eq(account([routine('d', 'disabled')], [skip('d', 'disabled'), fire('d', T0 + MIN)], flat).pass, false, 'a paused routine that fires → FAIL');
    }
    {
      const marked = [snap(T0 + 70_000, { u: job(T0 + MIN) }), snap(T0 + 200_000, { u: job(T0 + MIN, { lastError: M.UNFIREABLE_ERROR }) })];
      A.eq(account([routine('u', 'unfireable')], [result('u', M.UNFIREABLE_ERROR)], marked).pass, true, 'corrupt schedule marked once + lastError set → ok');
      A.eq(account([routine('u', 'unfireable')], [], marked).pass, false, 'never marked → FAIL');
      A.eq(account([routine('u', 'unfireable')], [result('u', M.UNFIREABLE_ERROR), fire('u', T0 + MIN)], marked).pass, false, 'fired AFTER the mark → FAIL');
      A.eq(account([routine('u', 'unfireable')], [result('u', M.UNFIREABLE_ERROR), result('u', M.UNFIREABLE_ERROR)], marked).pass, false, 'marked twice → FAIL (the mark must dedupe)');
      const unmarkedStore = [snap(T0 + 200_000, { u: job(T0 + MIN) })];
      A.eq(account([routine('u', 'unfireable')], [result('u', M.UNFIREABLE_ERROR)], unmarkedStore).pass, false, 'event without the durable lastError → FAIL');
    }
    {
      const r = account([routine('a', 'fireable')], [], [snap(T0 + 70_000, { a: job(T0 + MIN) })]);
      A.eq(r.pass, false, 'a fireable routine owed nothing in the window is inconclusive → FAIL');
      A.ok(/owed nothing/.test(r.problems[0]), 'says so: ' + r.problems[0]);
      A.eq(account([], [], []).pass, false, 'zero routines never passes');
    }
    {
      // the open tail: a fire for the pending (last-seen) nextRunAt after the final store read is not unexpected
      const r = account([routine('a', 'fireable')], [fire('a', T0 + MIN), fire('a', T0 + 2 * MIN), fire('a', T0 + 3 * MIN), fire('a', T0 + 4 * MIN)], trail3);
      A.eq(r.pass, true, 'tail fire accepted: ' + JSON.stringify(r.problems));
      A.eq(r.totals.tail, 1, 'tail counted');
      // a surplus skip likewise lands in the tail, never as a loss
      const s = account([routine('a', 'slow')], [fire('a', T0 + MIN), fire('a', T0 + 2 * MIN), fire('a', T0 + 3 * MIN), skip('a', 'already-running')], trail3);
      A.eq([s.pass, s.totals.tail], [true, 1], 'surplus skip → tail');
    }
    {
      // cron minute pattern: */2 from 12:02, advancing two minutes at a time — exact schedule math, no tolerance
      const star2 = cronLib.parseSchedule('*/2 * * * *', T0);
      const first = T0 + 2 * MIN;
      const trail2 = [snap(first + 10_000, { c: job(first + 2 * MIN) }), snap(first + 130_000, { c: job(first + 4 * MIN) })];
      const r = account([routine('c', 'fireable', star2, first)], [fire('c', first), fire('c', first + 2 * MIN)], trail2);
      A.eq(r.pass, true, 'cron */2 accounts exactly: ' + JSON.stringify(r.problems));
      const bad = account([routine('c', 'fireable', star2, first)], [fire('c', first), fire('c', first + MIN)], trail2);
      A.eq(bad.pass, false, 'a */2 fire on an odd minute is unexpected');
    }
    {
      // many routines: one bad row fails the whole ledger and is named; totals aggregate
      const rs = [routine('a', 'fireable'), routine('b', 'fireable')];
      const trailAB = trail3.map((s) => snap(s.at, { a: s.jobs.a, b: s.jobs.a }));
      const r = account(rs, [fire('a', T0 + MIN), fire('a', T0 + 2 * MIN), fire('a', T0 + 3 * MIN), fire('b', T0 + MIN), fire('b', T0 + 3 * MIN)], trailAB);
      A.eq(r.pass, false, 'one lost occurrence anywhere fails');
      A.eq(r.problems.length, 1, 'exactly the bad routine is a problem');
      A.ok(/^b-fireable: lost 1/.test(r.problems[0]), 'named: ' + r.problems[0]);
      A.eq([r.totals.owed, r.totals.fired, r.totals.lost], [6, 5, 1], 'totals aggregate across routines');
    }

    // evaluate: the accounting + tick rules ride the receipt like every other rule
    {
      const s = series(40);
      const accOk = account([routine('a', 'fireable')], [fire('a', T0 + MIN), fire('a', T0 + 2 * MIN), fire('a', T0 + 3 * MIN)], trail3);
      const ok = M.evaluate(healthyInput(s, { accounting: accOk }));
      A.eq(ok.rules.accounting.pass, true, 'accounting rule passes on a clean ledger');
      A.eq(ok.rules.accounting.actual.owed, 3, 'the receipt carries the totals');
      const accBad = account([routine('a', 'fireable')], [fire('a', T0 + MIN)], trail3);
      const bad = M.evaluate(healthyInput(s, { accounting: accBad }));
      A.eq(bad.verdict, 'FAIL', 'a lost occurrence fails the soak');
      A.ok(bad.failedRules.includes('accounting') && bad.rules.accounting.actual.problems.length === 1, 'accounting is the failed rule with its problem list');
      const none = M.evaluate(healthyInput(s, { accounting: { reason: 'log unreadable' } }));
      A.eq([none.rules.accounting.pass, none.rules.accounting.actual.reason, none.rules.accounting.actual.routines], [true, 'log unreadable', null], 'no ledger → null with the reason, never a fake PASS count');
      A.eq(M.evaluate(healthyInput(s)).rules.accounting.actual.routines, null, 'absent accounting → null');
      // tick latency
      const slowTicks = M.evaluate(healthyInput(series(40, (i) => ({ tickMs: i >= 20 ? 450 : 20 }))));
      A.eq(slowTicks.rules.tick.pass, false, 'a 450 ms scheduler tick p95 in the last half fails the tick rule');
      A.eq(slowTicks.rules.tick.actual.p95Ms, 450, 'p95 reported');
      const fastTicks = M.evaluate(healthyInput(series(40, (i) => ({ tickMs: i === 25 ? 900 : 15 }))));
      A.eq(fastTicks.rules.tick.pass, true, 'one boot-spike tick does not fail p95');
      A.eq(fastTicks.rules.tick.actual.maxMs, 900, 'but the max is reported');
      const boot = M.evaluate(healthyInput(series(40, (i) => ({ tickMs: i === 30 ? 800 : 20 }), { epoch: (i) => (i >= 30 ? 1 : 0) })));
      A.eq([boot.rules.tick.pass, boot.rules.tick.actual.catchUpMs, boot.rules.tick.actual.maxMs], [true, 800, 20], 'the first tick after a restart is the catch-up burst: reported, excluded from p95');
      const noTicks = M.evaluate(healthyInput(s));
      A.eq([noTicks.rules.tick.pass, noTicks.rules.tick.actual.p95Ms], [true, null], 'no tick samples → null with reason');
      A.ok(/tick samples/.test(noTicks.rules.tick.actual.reason), 'reason given');
      // summary renders the per-routine table
      const rec = M.buildReceipt(healthyInput(s, { accounting: accOk, options: { minutes: 10, routines: 1 } }));
      const md = M.renderSummary(rec);
      A.ok(md.indexOf('## Routine accounting') >= 0 && md.indexOf('| a-fireable |') >= 0, 'summary has the routine ledger table');
      A.ok(/\| accounting \| PASS/.test(md) && /\| tick \| PASS/.test(md), 'both new rules are rows in the summary');
    }

    // parseArgs: the scale knobs
    {
      const d = M.parseArgs([]);
      A.eq([d.routines, d.maxParallel, d.outageSeconds, d.slowRunMs], [1, 0, 0, M.DEFAULTS.slowRunMs], 'scale knobs default off (the 20-min run is unchanged)');
      const sc = M.parseArgs(['--minutes=10', '--routines=50', '--max-parallel=8', '--outage-seconds=150']);
      A.eq([sc.routines, sc.maxParallel, sc.outageSeconds], [50, 8, 150], 'scale overrides');
      A.throws(() => M.parseArgs(['--routines=0']), 'routines must be ≥ 1');
    }

    // the orchestrator seeds N routines through the fake world (create + pause + arm), reads the store every tick
    {
      let t = 1_000_000; const created = [];
      const world = {
        stopMode: 'fake', pid: () => 1, async boot() { return { pid: 1 }; }, async restart() { t += 500; return { pid: 2 }; }, async stop() {}, isAlive: () => true, childrenOf: async () => [],
        async json(m, r, body) {
          const key = m + ' ' + r.split('?')[0];
          if (key === 'POST /api/cron') { created.push(body); return { status: 200, body: { ok: true, job: { id: 'j' + created.length, schedule: { kind: 'interval', minutes: 1, display: 'every 1m' }, nextRunAt: new Date(t + 60_000).toISOString() } } }; }
          if (key === 'POST /api/cron/update') return { status: 200, body: { ok: true } };
          if (key === 'POST /api/roster' || key === 'POST /api/cron/arm') return { status: 200, body: { ok: true } };
          if (key === 'GET /api/health') { t += 1; return { status: 200, body: 'ok' }; }
          if (key === 'GET /api/diagnostics') return { status: 200, body: { report: { agentCount: 1, swallowed: { present: true, total: 0, tags: [] }, errors: [] } } };
          if (key === 'GET /api/state/snapshot') return { status: 200, body: {} };
          if (key === 'GET /api/cron') return { status: 200, body: { jobs: created.map((c, i) => ({ id: 'j' + (i + 1), nextRunAt: new Date(t + 60_000).toISOString(), enabled: i !== 0 })), health: { lastTickAt: t - 40, lastSuccessAt: t - 10 } } };
          if (r.startsWith('/api/runs')) return { status: 200, body: { runs: [] } };
          if (r.startsWith('/api/transcript')) return { status: 200, body: { turns: [] } };
          throw new Error('no fake route ' + key);
        },
        async runConversation() { t += 100; return { reason: 'done', toolOk: true }; },
        rss: async () => 90 * 1048576, workspaceBytes: () => 1, now: () => t, sleep: async (ms) => { t += ms; }, log: () => {},
      };
      const res = await M.runSoak(world, M.parseArgs(['--minutes=2', '--tick-seconds=15', '--routines=12']));
      A.eq(created.length, 12, 'twelve routines created');
      A.eq(new Set(created.map((c) => c.name)).size, 12, 'distinct names (the mint gate near-dups similar names)');
      A.ok(created.some((c) => c.prompt.indexOf(M.SLOW_MARKER) === 0), 'slow routines carry the slow marker');
      A.eq(res.routines.length, 12, 'the result carries the seeded routine specs');
      A.eq(res.routines[0].role, 'disabled', 'first is the paused one');
      A.ok(res.samples.every((s) => s.tickMs === 30), 'tick duration sampled from GET /api/cron health: ' + JSON.stringify(res.samples.map((s) => s.tickMs)));
      A.ok(/cronEvents/.test(res.accounting.reason), 'no cron log driver in this world → accounting null with reason');
    }
  }

  A.report('soak.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
