'use strict';
/* Returned registration owns the physical iteration, independently of its durable retry receipt. */
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const S = require('../sidecar/loopjob-store.js');
const { makeRunTable } = require('../sidecar/run-table.js');
let { makeLoopDriver } = require('../sidecar/loopjob-driver.js');
if (process.env.LOOP_DRIVER_OWNED_CONTROL) {
  const filename = require.resolve('../sidecar/loopjob-driver.js');
  const old = new Module(filename, module); old.filename = filename; old.paths = Module._nodeModulePaths(path.dirname(filename));
  old._compile(fs.readFileSync(process.env.LOOP_DRIVER_OWNED_CONTROL, 'utf8'), filename);
  makeLoopDriver = old.exports.makeLoopDriver;
}
const T0 = 1700006400000;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

function world(options) {
  const o = options || {}, pending = [], releases = [], legacy = [], ledger = [], calls = [];
  const fault = { persist: false, read: false };
  let loops = S.createLoop([], { id: 'loop', objective: 'prove owned admission', queueCap: 5 }, { now: T0 });
  let time = T0, seq = 0;
  const table = makeRunTable({ now: () => time, note: (tag, error) => ledger.push({ tag, error }) });
  const drv = makeLoopDriver({
    getLoops: () => { if (fault.read) throw Error('settlement read failed'); return loops; },
    setLoops: next => { if (fault.persist) return false; loops = next; return true; },
    newId: () => 'owned-' + (++seq), newAbort: () => new AbortController(), now: () => time,
    defaultModel: 'fixture-model', persona: 'fixture', context: o.context, snapshot: o.snapshot, check: o.check, harvest: o.harvest,
    ledger: item => ledger.push(item),
    trackRun: (runId, agentId, ac) => {
      if (o.legacy) return undefined;
      const run = table.admit({ runId, agentId, source: 'loop' }, { signal: ac.signal, stop: () => ac.abort() });
      return () => { releases.push(runId); run.release(); };
    },
    untrackRun: runId => legacy.push(runId),
    runOnce: opts => {
      calls.push(opts);
      if (o.runThrows) { if (o.settlementThrows) fault.read = true; throw Error('run host threw'); }
      const p = deferred(); pending.push({ opts, ...p }); return p.promise;
    }
  });
  return { drv, table, pending, releases, legacy, ledger, calls, fault,
    tick: () => drv.applyTick(time),
    resume: () => { time += 60000; loops = S.resumeLoop(loops, 'loop', { now: time }); },
    loop: () => S.getLoop(loops, 'loop'),
    finish: (p, text) => { p.opts.emit('agent.run.end', { runId: p.opts.runId, reason: 'done', outcome: 'succeeded' }); p.resolve({ reason: 'done', text: text || 'Completed fixture work.' }); }
  };
}

(async () => {
  // The real pipeline stays registered through each independent async boundary, not launch()'s true return.
  {
    const context = deferred(), snapshot = deferred(), check = deferred(), harvest = deferred();
    const w = world({ context: () => context.promise, snapshot: () => snapshot.promise,
      check: () => check.promise, harvest: () => harvest.promise });
    A.eq(w.tick().fired, 1, 'context work takes the existing iteration slot');
    A.ok(w.table.owned('owned-1') && w.table.stoppable('owned-1'), 'pre-core context is registered and stoppable');
    A.eq(w.calls.length, 0, 'provider waits for context');
    context.resolve({ text: 'fixture', reachable: true }); await flush();
    A.eq(w.calls.length, 1, 'context launches exactly one model call');
    A.eq(w.table.size(), 1, 'launch returning does not release physical model work');
    w.finish(w.pending[0]); await flush();
    A.eq(w.table.size(), 1, 'snapshot/check wait remains live after model completion');
    snapshot.resolve({ files: [] }); await flush();
    A.eq(w.table.size(), 1, 'pending check retains registration');
    check.resolve({ ran: true, passed: false, trusted: false }); await flush();
    A.eq(w.table.size(), 1, 'pending harvest retains registration');
    harvest.resolve({ title: 'fixture result', files: ['fixture.js'] }); await flush();
    A.eq(w.releases, ['owned-1'], 'physical pipeline releases exactly its admission once');
    A.eq([w.table.size(), w.drv.leases.size, w.legacy.length], [0, 0, 0], 'new callback substitutes for legacy untrack without stranding work');
  }
  // A completed process is not live merely because its settlement receipt needs another disk write.
  {
    const w = world(); w.tick(); w.fault.persist = true;
    w.finish(w.pending[0]); await flush();
    A.eq(w.table.size(), 0, 'failed settlement write cannot strand physical registration');
    A.ok(w.drv.leases.get('loop').settlement, 'durable retry receipt retains the concurrency lease');
    A.eq(w.tick().fired, 0, 'pending settlement does not re-execute the iteration');
    w.fault.persist = false; w.tick(); await flush();
    A.eq(w.drv.leases.size, 0, 'later persistence clears only the existing receipt');
    A.eq([w.calls.length, w.releases], [1, ['owned-1']], 'retry neither runs work nor releases twice');
  }
  // Abort before launch: durable cancellation happens now, physical context remains counted until it unwinds.
  {
    const context = deferred(); const w = world({ context: () => context.promise }); w.tick();
    A.eq(w.drv.abortAllLeases(), 1, 'pre-core cancellation keeps its existing result');
    A.eq(w.drv.leases.size, 0, 'cancellation durably settles without waiting for context');
    A.ok(w.table.owned('owned-1') && !w.table.ownerLive('owned-1'), 'aborted owner remains registered during physical unwind');
    context.resolve({ reachable: true, text: 'late context' }); await flush();
    A.eq([w.calls.length, w.table.size(), w.releases], [0, 0, ['owned-1']], 'late context cannot launch and releases its exact token');
  }
  // Old completion after explicit resume must never release the replacement generation.
  {
    let harvests = 0; const w = world({ harvest: () => { harvests++; return { title: 'new result' }; } }); w.tick();
    const old = w.pending[0]; w.drv.abortAllLeases(); w.resume(); w.tick();
    const replacement = w.pending[1];
    A.eq(w.table.size(), 2, 'unwinding old work and replacement have independent admissions');
    old.resolve({ reason: 'done', text: 'stale result' }); await flush();
    A.ok(!w.table.has('owned-1') && w.table.ownerLive('owned-2'), 'old callback cannot release the replacement');
    A.eq(harvests, 0, 'existing stale-generation fence still prevents old harvest');
    w.finish(replacement); await flush();
    A.eq([w.table.size(), w.releases, harvests], [0, ['owned-1', 'owned-2'], 1], 'replacement settles once through its own callback');
  }
  for (const o of [{ context: () => ({ reachable: false, why: 'fixture unavailable' }) },
    { context: () => { throw Error('context failed'); } }, { runThrows: true }]) {
    const w = world(o); w.tick(); await flush();
    A.eq([w.table.size(), w.releases], [0, ['owned-1']], 'no-launch/error path releases returned registration');
  }
  {
    const w = world({ runThrows: true, settlementThrows: true });
    A.throws(() => w.tick(), 'existing synchronous settlement exception still propagates');
    await flush();
    A.eq([w.table.size(), w.releases], [0, ['owned-1']], 'settlement throwing during sync launch failure still releases in finally');
  }
  {
    const snapshot = deferred(); const w = world({ context: () => ({ reachable: false }), snapshot: () => snapshot.promise });
    w.tick(); await flush();
    A.eq(w.drv.leases.size, 0, 'unreachable context settles immediately');
    A.eq(w.table.size(), 1, 'independent snapshot work remains counted after context failure');
    snapshot.resolve({}); await flush();
    A.eq([w.table.size(), w.releases], [0, ['owned-1']], 'last snapshot completion releases the original registration');
  }
  {
    const w = world({ legacy: true }); w.tick();
    w.drv.abortAllLeases();
    A.eq(w.legacy, ['owned-1'], 'older host retains immediate successful-settlement untrack timing');
    w.pending[0].resolve({ reason: 'done' }); await flush();
    A.eq(w.legacy, ['owned-1'], 'old-host late completion does not untrack twice');
  }
  A.report('loopjob-driver owned admission');
})().catch(e => { console.error(e); process.exit(1); });
