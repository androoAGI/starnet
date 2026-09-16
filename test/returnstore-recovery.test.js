'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Returns = require('../frontend/app/returns.js');
const code = fs.readFileSync(require.resolve('../frontend/app/returnstore.js'), 'utf8') + '\nthis.store = ReturnStore;';
const flush = () => new Promise(resolve => setImmediate(resolve));
const run = (runId, ts) => ({ runId, ts, reason: 'done', agentId: 'agent', title: runId });
(async () => {
  let saved = JSON.stringify({ lastSeenAt: 1000 }), failSave = false;
  function boot(at, loader) {
    const timers = new Map(); let nextTimer = 0, heartbeat;
    class Clock extends Date { static now() { return at; } }
    const ctx = vm.createContext({ Returns, Date: Clock,
      localStorage: { getItem: () => saved, setItem: (_, value) => { if (failSave) throw new Error('quota'); saved = value; }, removeItem: () => { saved = null; } },
      XpStore: { loadRunHistory: loader }, window: { addEventListener() {} },
      setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
      clearTimeout: id => timers.delete(id), setInterval: fn => { heartbeat = fn; return 1; }, clearInterval() {} });
    vm.runInContext(code, ctx); ctx.store.init({ enabled: true });
    return { store: ctx.store, beat(now) { at = now; heartbeat(); }, async tick(ms) {
      for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); }
      await flush(); await flush();
    } };
  }
  const first = boot(3000, async () => { throw new Error('offline'); });
  await first.tick(1600);
  assert.equal(JSON.parse(saved).lastSeenAt, 3000);
  assert.deepEqual(JSON.parse(saved).awayRanges, [{ since: 1000, until: 3000 }]);
  first.beat(4000);
  const second = boot(5000, async () => ({ runs: [run('away', 2000), run('attended', 3500), run('second-away', 4500), run('now-attended', 5500)] }));
  // The 4000 heartbeat excludes attended work at 3500 without erasing the earlier unread interval.
  await second.tick(1600);
  assert.deepEqual(JSON.parse(saved).pending.map(r => r.runId), ['away', 'second-away']);
  assert.deepEqual(JSON.parse(saved).awayRanges, []);
  assert.equal(second.store.pendingCount(), 2);
  // A later restart does not duplicate already crated work, even when the API repeats rows.
  const third = boot(6000, async () => ({ runs: [run('away', 2000), run('new', 5500)] }));
  await third.tick(1600);
  assert.deepEqual(JSON.parse(saved).pending.map(r => r.runId), ['away', 'second-away', 'new']);
  // Storage failure cannot acknowledge an unread/durably uncrated interval.
  saved = JSON.stringify({ lastSeenAt: 1000 }); failSave = true;
  const quota = boot(3000, async () => ({ runs: [run('quota-result', 2000)] }));
  await quota.tick(1600);
  assert.equal(JSON.parse(saved).lastSeenAt, 1000);
  failSave = false; await quota.tick(30000);
  assert.equal(JSON.parse(saved).pending[0].runId, 'quota-result');
  assert.deepEqual(JSON.parse(saved).awayRanges, []);
  // Reset fences a delayed old-account response and removes its timers.
  saved = JSON.stringify({ lastSeenAt: 1000 }); let release;
  const delayed = boot(3000, () => new Promise(resolve => { release = resolve; }));
  await delayed.tick(1600); delayed.store.reset(); release({ runs: [run('old-account', 2000)] });
  await flush(); await flush();
  assert.equal(saved, null); assert.equal(delayed.store.pendingCount(), 0);
  console.log('returnstore recovery: outage, restart, storage retry, attendance horizon, and reset fencing passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
