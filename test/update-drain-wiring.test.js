/* node test/update-drain-wiring.test.js — the pre-update barrier sees, stops and waits for EVERY live run (B10).

   The update preparation (sidecar/update-preparation.js) drains before it freezes durable writes, but it can only drain
   what the host tells it is live. index.js used to wire liveRuns to `runs.size` and abortRuns to `runs` alone — the
   browser registry. A scheduled routine fire, a routine/line hop, a line trigger, a channel-hub run, a /v1 call and a
   background worker never sit in `runs`, so a plain INSTALL UPDATE or INSTALL ANYWAY froze writes under them and their
   spend settlement threw (receipt stranded across the upgrade -> "Spend history is unavailable" on the next boot).

   index.js is not unit-loadable, so the two host helpers are LIFTED by fnBody and RUN against fake registries and a real
   run table (sidecar/run-table.js: since run-table S3 the drain reads the table, where every run runOnce drives sits from
   its admission, and stops it with runTable.stopAll); the wiring and the background-launcher gates are source-locked. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const RunTable = require('../sidecar/run-table.js');

const src = readSidecarSource();
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

const countSrc = A.fnBody(src, 'function updateLiveRunCount(');
const abortSrc = A.fnBody(src, 'function updateAbortLiveRuns(');
A.ok(countSrc.length > 50 && countSrc.length < 3000, 'updateLiveRunCount located (length guard)');
A.ok(abortSrc.length > 50 && abortSrc.length < 3000, 'updateAbortLiveRuns located (length guard)');

function host() {
  const ac = () => { const c = new AbortController(); return c; };
  const h = {
    cronDriver: { leases: new Map(), aborted: 0, abortAllLeases() { this.aborted++; return 0; } },
    loopDriver: { aborted: 0, abortAllLeases() { this.aborted++; return 0; } },
    nightshiftDriver: { aborted: 0, abortBeat() { this.aborted++; return 0; } },
    subagents: { interrupted: 0, interruptAll() { this.interrupted++; return 0; } },
    stamps: [], notes: [], ac
  };
  h.runTable = RunTable.makeRunTable({ now: () => 0, note: (tag, e) => h.notes.push(tag + ':' + ((e && e.message) || e)) });
  const names = ['runTable', 'cronDriver', 'loopDriver', 'nightshiftDriver', 'subagents', 'failNote',
    'saveCronHalted', 'saveLoopsHalted', 'saveNightshiftHalt', 'disarmCron', 'disarmLoops'];
  const make = new Function(...names,
    countSrc + '\n' + abortSrc + '\nreturn { updateLiveRunCount, updateAbortLiveRuns };');
  const stamp = name => () => { h.stamps.push(name); };
  h.fns = make(h.runTable, h.cronDriver, h.loopDriver, h.nightshiftDriver, h.subagents,
    (tag, e) => h.notes.push(tag + ':' + ((e && e.message) || e)),
    stamp('saveCronHalted'), stamp('saveLoopsHalted'), stamp('saveNightshiftHalt'), stamp('disarmCron'), stamp('disarmLoops'));
  return h;
}

/* ---- 1. the count: any live run anywhere holds the barrier; nothing live reads 0 ---- */
{
  const h = host();
  A.eq(h.fns.updateLiveRunCount(), 0, 'an idle station has no live runs');
  const scheduled = h.runTable.admit({ runId: 'cron-run-1', agentId: 'nova', source: 'cron' });
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a scheduled routine admission is a live run');
  scheduled.release();
  let r = h.runTable.admit(RunTable.metaOf({ runId: 'line-run-1', lineId: 'L1' }));
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a line run (the run table only) is a live run');
  r.release();
  r = h.runTable.admit(RunTable.metaOf({ runId: 'chatcmpl-1', taskSource: 'api' }));
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a /v1 or channel-hub run (the run table only) is a live run');
  r.release();
  r = h.runTable.admit(RunTable.metaOf({ runId: 'queued-1', streamId: 'home' }));
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a turn still queued behind its conversation is a live run');
  r.release();
  r = h.runTable.admit(RunTable.metaOf({ agentId: 'nightly' }));
  A.eq(h.fns.updateLiveRunCount(), 1, 'an id-less run (an anonymous table entry, never listed) is a live run');
  r.release();
  h.cronDriver.leases.set('job-1', { runId: 'r1', ac: h.ac() });
  A.eq(h.fns.updateLiveRunCount() > 0, true, 'a cron fire still settling its routine record (lease held) is live');
  h.cronDriver.leases.set('job-1', { runId: 'r1', ac: h.ac(), settlement: { at: 1 } });
  A.eq(h.fns.updateLiveRunCount(), 0, 'a finished fire waiting only on a disk retry is NOT a live run (it would hold the barrier forever)');
  h.cronDriver.leases.clear();
  const owner = h.ac();
  const outer = h.runTable.admit({ runId: 'a', source: 'interactive' }, { signal: owner.signal, stop: () => owner.abort() });
  const a = h.runTable.admit(RunTable.metaOf({ runId: 'a' })); a.join(owner.signal);
  A.eq(h.fns.updateLiveRunCount(), 1, 'host ownership and its joined core admission count as one live run');
  const early = h.runTable.admit({ runId: 'b', source: 'loop' }, { stop() {} });
  A.eq(h.fns.updateLiveRunCount(), 2, 'a host still before runOnce also holds the barrier once');
  a.release(); outer.release(); early.release();
}

/* ---- 2. INSTALL ANYWAY stops every live run — and only stops it (no E-STOP stand-down) ---- */
{
  const h = host();
  const browser = h.ac(), remote = { stopped: 0, abort() { this.stopped++; } };
  const browserRun = h.runTable.admit({ runId: 'browser' }, { signal: browser.signal, stop: () => browser.abort() });
  const phoneRun = h.runTable.admit({ runId: 'remote' }, { stop: () => remote.abort() });
  const routine = h.runTable.admit(RunTable.metaOf({ runId: 'routine', trigger: 'schedule' }));
  const routineSignal = routine.join(h.ac().signal);
  h.fns.updateAbortLiveRuns();
  A.eq(browser.signal.aborted, true, 'a browser run is aborted');
  A.eq(remote.stopped, 1, 'a phone/remote run is stopped through its own abort');
  A.eq(routineSignal.aborted, true, 'a routine/hop/hub/v1 run is aborted through its run-table stop');
  routine.release(); browserRun.release(); phoneRun.release();
  A.eq(h.cronDriver.aborted, 1, 'cron fires are aborted (a slash routine has no run-table stop)');
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
  const calls = strip(src).match(/\brunOnceCore\(/g) || [];
  A.eq(calls.length, 3, 'only the declared core, admitted review, and admitted runOnce belt mention the core call');
  const review = A.fnBody(src, 'async function tickOverseer(');
  const run = A.fnBody(src, 'async function runOnce(');
  A.ok(review.includes('const reviewRun = runTable.admit(') && review.includes('reviewRun.release();'), 'the direct review caller holds its table admission through core settlement');
  A.ok(run.includes('const run = runTable.admit(') && run.includes('return await runOnceQueued(o, run);') && run.includes('finally { settleRun(run, threw, o && o.emit, o || {}); run.release(); }'), 'every other core caller is covered through the whole awaited queue/core and spend settlement');
  A.eq(/\bcoreRunsLive\b/.test(strip(src)), false, 'no separate count can drift from the admitted runs');
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

// a DELEGATED foreground worker (parentRunId) is a live run too: without it the snapshot never listed the worker and the
// 30 s reconcile painted its CREW card "idle" through its whole run (live walkthrough 2026-10-13)
{
  const h = host();
  const foreground = h.runTable.admit(RunTable.metaOf({ runId: 'fg-worker', agentId: 'research', parentRunId: 'lead' }));
  A.eq(h.runTable.live().map(r => [r.runId, r.source, r.delegated]), [['fg-worker', 'delegated', true]], 'the table lists the foreground delegated worker with its owner facts');
  A.eq(h.fns.updateLiveRunCount(), 1, 'the foreground worker holds the update barrier without a second host registry');
  foreground.release();
  const background = h.runTable.admit(RunTable.metaOf({ runId: 'bg-worker', agentId: 'research', parentRunId: 'lead', steer() {} }));
  A.eq(h.runTable.live().map(r => [r.runId, r.source, r.delegated]), [['bg-worker', 'subagent', true]], 'a background worker keeps its manager-owned source');
  A.eq(h.runTable.stoppable('bg-worker'), false, 'the table never offers a stop that bypasses the delegated manager');
  background.release();
  A.eq(h.fns.updateLiveRunCount(), 0, 'both workers release their update barrier admissions');
}

A.report('update-drain-wiring.test');
