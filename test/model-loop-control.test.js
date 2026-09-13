'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const S = require('../sidecar/loopjob-store.js');
const { makeLoopDriver } = require('../sidecar/loopjob-driver.js');
const source = fs.readFileSync(require.resolve('../sidecar/index.js'), 'utf8');
const code = source.slice(source.indexOf('async function modelControlLoop('), source.indexOf('async function modelVerdictLoop('));
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  for (const action of ['pause', 'stop', 'remove']) for (const late of ['resolve', 'reject']) {
    const now = 1700006400000;
    let loops = S.createLoop([], { id: 'loop', objective: 'test cancellation' }, { now });
    let finish, fail, ctx;
    const save = next => { loops = next; if (ctx) ctx.loopJobs = next; return true; };
    const driver = makeLoopDriver({ getLoops: () => loops, setLoops: save,
      runOnce: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }),
      newId: () => 'run', newAbort: () => new AbortController(), now: () => now,
      defaultModel: 'test', concurrencyFree: () => true });
    driver.applyTick(now);
    ctx = vm.createContext({ loopJobs: loops, loopjobStore: S, loopReviewBusy: () => false, Date,
      loopDriver: driver, commitLoops: save, armLoops() {}, disarmLoops() {}, anyLiveLoop: () => false,
      modelLoopRow: () => loops[0] });
    vm.runInContext(code, ctx);
    if (action === 'remove') await ctx.modelRemoveLoop('loop');
    else await ctx.modelControlLoop('loop', action, 'test');
    assert.equal(driver.leases.size, 0, action + ' releases lease before provider responds');
    if (late === 'resolve') finish({ reason: 'done', text: 'late work' });
    else fail(new Error('late failure'));
    await flush(); await flush();
    if (action === 'remove') assert.equal(loops.length, 0);
    else {
      assert.equal(loops[0].iterations[0].outcome, 'cancelled');
      assert.equal(loops[0].state, action === 'pause' ? 'paused' : 'stopped');
      assert.equal(loops[0].fireClaim, null);
    }
  }
  console.log('model loop controls: pause, stop, remove survive late resolution and rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });
