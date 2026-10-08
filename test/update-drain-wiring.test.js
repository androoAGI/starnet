/* node test/update-drain-wiring.test.js — the pre-update barrier sees, stops and waits for EVERY live run (B10).

   The update preparation (sidecar/update-preparation.js) drains before it freezes durable writes, but it can only drain
   what the host tells it is live. index.js used to wire liveRuns to `runs.size` and abortRuns to `runs` alone — the
   browser registry. A scheduled routine fire, a routine/line hop, a line trigger, a channel-hub run, a /v1 call and a
   background worker never sit in `runs`, so a plain INSTALL UPDATE or INSTALL ANYWAY froze writes under them and their
   spend settlement threw (receipt stranded across the upgrade -> "Spend history is unavailable" on the next boot).

   index.js is not unit-loadable, so the two host helpers are LIFTED by fnBody and RUN against fake registries; the
   wiring and the background-launcher gates are source-locked. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { killAll } = require('../sidecar/halt.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

const countSrc = A.fnBody(src, 'function updateLiveRunCount(');
const abortSrc = A.fnBody(src, 'function updateAbortLiveRuns(');
A.ok(countSrc.length > 50 && countSrc.length < 3000, 'updateLiveRunCount located (length guard)');
A.ok(abortSrc.length > 50 && abortSrc.length < 3000, 'updateAbortLiveRuns located (length guard)');

function host() {
  const ac = () => { const c = new AbortController(); return c; };
  const h = {
    runs: new Map(), runsMeta: new Map(), hostLiveRuns: new Map(), runStopHandles: new Map(), coreRunsLive: 0,
    cronDriver: { leases: new Map(), aborted: 0, abortAllLeases() { this.aborted++; return 0; } },
    loopDriver: { aborted: 0, abortAllLeases() { this.aborted++; return 0; } },
    nightshiftDriver: { aborted: 0, abortBeat() { this.aborted++; return 0; } },
    subagents: { interrupted: 0, interruptAll() { this.interrupted++; return 0; } },
    stamps: [], notes: [], ac
  };
  const names = ['runs', 'runsMeta', 'hostLiveRuns', 'runStopHandles', 'cronDriver', 'loopDriver', 'nightshiftDriver', 'subagents', 'killAll', 'failNote',
    'saveCronHalted', 'saveLoopsHalted', 'saveNightshiftHalt', 'disarmCron', 'disarmLoops'];
  const make = new Function(...names, 'getCore',
    countSrc.replace(/\bcoreRunsLive\b/g, 'getCore()') + '\n' + abortSrc + '\nreturn { updateLiveRunCount, updateAbortLiveRuns };');
  const stamp = name => () => { h.stamps.push(name); };
  h.fns = make(h.runs, h.runsMeta, h.hostLiveRuns, h.runStopHandles, h.cronDriver, h.loopDriver, h.nightshiftDriver, h.subagents, killAll,
    (tag, e) => h.notes.push(tag + ':' + ((e && e.message) || e)),
    stamp('saveCronHalted'), stamp('saveLoopsHalted'), stamp('saveNightshiftHalt'), stamp('disarmCron'), stamp('disarmLoops'),
    () => h.coreRunsLive);
  return h;
}

/* ---- 1. the count: any live run anywhere holds the barrier; nothing live reads 0 ---- */
{
  const h = host();
  A.eq(h.fns.updateLiveRunCount(), 0, 'an idle station has no live runs');
  h.runsMeta.set('cron-run-1', { agentId: 'nova', source: 'cron' });
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a scheduled routine fire (runsMeta only) is a live run');
  h.runsMeta.clear();
  h.hostLiveRuns.set('line-run-1', { source: 'host' });
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a line run (hostLiveRuns only) is a live run');
  h.hostLiveRuns.clear();
  h.runStopHandles.set('chatcmpl-1', h.ac());
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a /v1 or channel-hub run (stop handle only) is a live run');
  h.runStopHandles.clear();
  h.coreRunsLive = 1;
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a background worker (runOnceCore in flight, no id registry) is a live run');
  h.coreRunsLive = 0;
  h.cronDriver.leases.set('job-1', { runId: 'r1', ac: h.ac() });
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a cron fire still settling its routine record (lease held) is live');
  h.cronDriver.leases.set('job-1', { runId: 'r1', ac: h.ac(), settlement: { at: 1 } });
  A.eq(h.fns.updateLiveRunCount(), 0, 'a finished fire waiting only on a disk retry is NOT a live run (it would hold the barrier forever)');
  h.runs.set('a', h.ac()); h.runsMeta.set('a', {}); h.runStopHandles.set('a', h.ac());
  A.eq(h.fns.updateLiveRunCount(), 1, 'one run listed in three registries counts once');
}

/* ---- 2. INSTALL ANYWAY stops every live run — and only stops it (no E-STOP stand-down) ---- */
{
  const h = host();
  const browser = h.ac(), routine = h.ac(), remote = { stopped: 0, abort() { this.stopped++; } };
  h.runs.set('browser', browser); h.runs.set('remote', remote);
  h.runStopHandles.set('routine', routine);
  h.fns.updateAbortLiveRuns();
  A.eq(browser.signal.aborted, true, 'a browser run is aborted');
  A.eq(remote.stopped, 1, 'a phone/remote run is stopped through its own abort');
  A.eq(routine.signal.aborted, true, 'a routine/hop/hub/v1 run is aborted through its stop handle');
  A.eq(h.cronDriver.aborted, 1, 'cron fires are aborted (a slash routine has no stop handle)');
  A.eq(h.loopDriver.aborted, 1, 'loop iterations are aborted');
  A.eq(h.nightshiftDriver.aborted, 1, 'a night-shift beat is aborted');
  A.eq(h.subagents.interrupted, 1, 'background workers are interrupted (their manager owns their stop)');
  A.eq(h.stamps, [], 'no durable E-STOP stand-down is stamped: after the upgrade or a cancel the station carries on');
  const g = host();
  g.cronDriver.abortAllLeases = () => { throw new Error('boom'); };
  A.notThrows(() => g.fns.updateAbortLiveRuns(), 'one failing lane never stops the rest of the abort');
  A.eq(g.subagents.interrupted, 1, 'the lanes after it still run');
  A.ok(g.notes.some(n => /boom/.test(n)), 'and the failure is noted, not swallowed');
}

/* ---- 3. the wiring: the barrier is built on those helpers, and every runOnceCore call is counted ---- */
{
  const wire = src.slice(src.indexOf('updatePreparation = makeUpdatePreparation({'), src.indexOf('const server = http.createServer('));
  A.ok(wire.length > 200 && wire.length < 4000, 'updatePreparation wiring located (length guard)');
  A.ok(/liveRuns: \(\) => updateLiveRunCount\(\)/.test(wire), 'liveRuns counts every registry, not runs.size');
  A.ok(/abortRuns: \(\) => updateAbortLiveRuns\(\)/.test(wire), 'abortRuns stops every lane, not runs alone');
  A.ok(!/runs\.size/.test(strip(wire)), 'no browser-registry-only count is left in the wiring');
  const calls = strip(src).match(/\brunOnceCore(Counted)?\(/g) || [];
  const bare = calls.filter(c => c === 'runOnceCore(').length;
  // two bare mentions are allowed: the declaration `async function runOnceCore(o)` and the counted wrapper's own call
  A.eq(bare, 2, 'every runOnceCore caller goes through runOnceCoreCounted (only the declaration + the wrapper are bare)');
  A.ok(calls.filter(c => c === 'runOnceCoreCounted(').length >= 4, 'the overseer review and both runOnceTrackedInner paths are counted');
  const wrap = A.fnBody(src, 'async function runOnceCoreCounted(');
  A.ok(/coreRunsLive\+\+/.test(wrap) && /finally \{ coreRunsLive--; \}/.test(wrap), 'the counter covers the whole runOnceCore lifetime, finalizer included');
}

/* ---- 4. background launchers stand down for the WHOLE barrier (drain window included), not only once writes freeze ---- */
{
  const holding = A.fnBody(src, 'function updateHolding(');
  A.ok(/updateWritesFrozen/.test(holding) && /updatePreparation\.isFrozen\(\)/.test(holding), 'updateHolding = frozen writes OR a raised barrier');
  const overseer = strip(A.fnBody(src, 'async function tickOverseer('));
  A.ok(overseer.length > 500, 'tickOverseer located');
  A.eq(/\bupdateWritesFrozen\b/.test(overseer), false, 'tickOverseer no longer gates on the durable-write flag alone');
  A.eq((overseer.match(/updateHolding\(\)/g) || []).length, 2, 'both overseer gates (tick entry + per-review) read updateHolding()');
  A.ok(/^\s*if \(updateHolding\(\)\) return/m.test(A.fnBody(src, 'function cronTickHealthy(')), 'a cron tick launches no fire (and persists no advance) under the barrier');
  A.ok(/^\s*if \(updateHolding\(\)\) return/m.test(A.fnBody(src, 'function loopTick(')), 'a loop tick launches no iteration under the barrier');
  const nsArm = A.fnBody(src, 'function armNightshift(');
  A.ok(/setInterval\(\(\) => \{ if \(updateHolding\(\)\) return;/.test(nsArm), 'a night-shift tick launches no beat under the barrier');
}

A.report('update-drain-wiring.test');
