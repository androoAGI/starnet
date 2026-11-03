/* node test/trigger-sweep.test.js — LINE TRIGGER runner fixes from the conveyor sweep (2026-09-25), headless.

   Each block locks one defect the stranded-user sweep / the parallel review found:
     1. deleting a trigger MID-FIRE keeps its in-flight run reachable by E-STOP (inflights()) until the fire settles. */
'use strict';
const A = require('./_assert.js');
const T = require('../sidecar/routing/triggers.js');
const { makeTriggerRunner } = require('../sidecar/routing/trigger-runner.js');

const tick = (ms) => new Promise(r => setTimeout(r, ms || 10));

/* a controllable fake hub: each onInbound parks until release() — while parked, its run sits in _internals.inflight
   exactly like the real channel hub's record (what halt.js killAll aborts) */
function harness(opts) {
  opts = opts || {};
  let clock = Date.now(), n = 0;   // the folder watcher compares against REAL file mtimes
  const disk = { triggers: { triggers: [] }, seen: {} };
  const plan = opts.plan || { lines: [{ lineId: 'L1' }], reach: { 'agent-a': true }, lineOfAgent: { 'agent-a': 'L1' } };
  const parked = [];
  const hubs = [];
  let closed = 0;
  function fakeHub(hooks) {
    const inflight = new Map();
    const hub = {
      _internals: { inflight },
      onInbound(msg) {
        const routed = hooks.onRouted({ agentId: 'agent-a', dockId: 'b1' });
        hooks.onResolved({ chatId: msg.chatId, agentId: routed.agentId, isTask: true, lineId: 'L1', dockId: 'b1' });
        const sid = hooks.streamId();
        const rec = { runId: 'run-' + (++n), abort: { abort() { rec.aborted = true; } }, endReason: null };
        inflight.set(msg.chatId, rec);
        return new Promise(res => parked.push(() => { inflight.delete(msg.chatId); runs[sid] = [{ runId: rec.runId, agentId: 'agent-a', reason: 'done', usd: 0.01, streamId: sid }]; hooks.onLineOutcome({ agentId: 'agent-a', dockId: 'b1', outboxId: 'out1', stopped: null }); res(); }));
      },
      close() { closed++; }
    };
    hubs.push(hub);
    return hub;
  }
  const runs = {};
  const R = makeTriggerRunner({
    load: () => JSON.parse(JSON.stringify(disk.triggers)), save: v => { disk.triggers = JSON.parse(JSON.stringify(v)); },
    seen: { load: () => JSON.parse(JSON.stringify(disk.seen)), save: v => { disk.seen = JSON.parse(JSON.stringify(v)); } },
    makeHub: fakeHub, plan: () => plan, shipsToOutbox: () => true, dayCap: opts.dayCap || (() => ({ cap: null, spent: 0 })),
    halted: opts.halted || (() => false), faulted: opts.faulted,
    runsFor: sid => runs[sid] || [], emit: () => {},
    watcher: opts.watcher || null,
    now: () => clock, newId: () => 'id' + (++n) + 'abcdef0123456789'
  });
  return { R, disk, plan, parked, hubs, closedCount: () => closed, advance: ms => { clock += ms; }, now: () => clock };
}

(async () => {
  /* ---- 1. delete mid-fire: the run stays reachable by E-STOP until it settles ---- */
  {
    const H = harness();
    const c = H.R.create({ kind: 'webhook', lineId: 'L1', maxPerHour: 10 }, { secretHash: T.hashSecret('k') });
    const id = c.trigger.id;
    A.ok(H.R.enqueue(id, { text: 'job' }).ok, 'a fire is admitted');
    await tick();
    A.eq(H.parked.length, 1, 'the fire is in flight (parked in the hub)');
    const before = H.R.inflights();
    A.ok(before.length === 1 && before[0].size === 1, 'E-STOP can see the in-flight run before the delete');
    A.ok(H.R.remove(id).ok, 'the trigger is deleted while its fire runs');
    const during = H.R.inflights();
    A.ok(during.length === 1 && during[0].size === 1, 'AFTER the delete the in-flight run is still reachable by E-STOP');
    A.eq(H.closedCount(), 0, 'the hub is not closed under a live run');
    A.eq(H.R.list().length, 0, 'the deleted trigger is gone from the list at once');
    H.parked[0]();
    await tick(20);
    A.eq(H.R.inflights().length, 0, 'once the fire settles the deleted trigger\'s state is retired');
    A.eq(H.closedCount(), 1, 'and its hub is closed');
  }
  {
    const H = harness();
    const c = H.R.create({ kind: 'webhook', lineId: 'L1', maxPerHour: 10 }, { secretHash: T.hashSecret('k') });
    A.ok(H.R.remove(c.trigger.id).ok, 'an idle trigger deletes');
    A.eq(H.R.inflights().length, 0, 'an idle deleted trigger leaves nothing behind');
  }

  /* ---- 4. a QUEUED item meets the pre-fire checks again at dispatch ---- */
  {
    let cap = { cap: null, spent: 0 };
    const H = harness({ dayCap: () => cap });
    const c = H.R.create({ kind: 'webhook', lineId: 'L1', maxPerHour: 10 }, { secretHash: T.hashSecret('k') });
    const id = c.trigger.id;
    A.ok(H.R.enqueue(id, { text: 'one' }).ok && H.R.enqueue(id, { text: 'two' }).ok, 'two items admitted (one runs, one waits)');
    await tick();
    A.eq(H.parked.length, 1, 'only the first is running');
    cap = { cap: 1, spent: 1.5 };   // the first fire spent the line past its daily cap
    H.parked[0]();
    await tick(20);
    A.eq(H.parked.length, 1, 'the waiting item did NOT run past the daily cap');
    const v = H.R.view(id);
    A.ok(/1 waiting item was dropped before running: .*daily limit/.test(v.lastError || ''), 'the drop and its reason are on record: ' + v.lastError);
    A.eq(v.queued, 0, 'nothing is left waiting');
    // plan disarmed while an item waits
    cap = { cap: null, spent: 0 };
    H.advance(1000);
    A.ok(H.R.enqueue(id, { text: 'three' }).ok && H.R.enqueue(id, { text: 'four' }).ok, 'two more admitted');
    await tick();
    const lines = H.plan.lines; H.plan.lines = [];
    H.parked[1]();
    await tick(20);
    A.eq(H.parked.length, 2, 'a waiting item does not run once its line left the floor');
    A.ok(/dropped before running: its line is no longer on the floor/.test(H.R.view(id).lastError || ''), 'with that reason');
    H.plan.lines = lines;
  }

  /* ---- 5. ADMITTED IS NOT FIRED: a waiting folder file dropped by E-STOP / pause / restart fires later ---- */
  {
    const fs = require('fs'), fsp = require('fs/promises'), os = require('os'), path = require('path');
    const { makeFolderWatcher } = require('../sidecar/routing/trigger-folder.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-trg-sweep5-'));
    const H = harness({ watcher: makeFolderWatcher({ fsp, pathMod: path, settleMs: 0 }) });
    const c = H.R.create({ kind: 'folder', lineId: 'L1', maxPerHour: 50, config: { path: root } }, { baselineKeys: [] });
    const id = c.trigger.id;
    const back = Date.now() - 60000;
    for (const n of ['a.txt', 'b.txt']) { fs.writeFileSync(path.join(root, n), 'job ' + n); fs.utimesSync(path.join(root, n), back / 1000, back / 1000); }
    await H.R.tickFolders(); await H.R.tickFolders();
    await tick();
    A.eq(H.parked.length, 1, 'a.txt runs, b.txt waits behind it');
    const seenNow = H.disk.seen[id] || {};
    A.eq(Object.keys(seenNow).length, 1, 'only the DISPATCHED file is recorded as fired (the waiting one is not)');
    await H.R.tickFolders(); await H.R.tickFolders();
    A.eq(H.R.view(id).queued, 1, 'a later scan does not admit the waiting file twice');
    A.eq(H.R.haltAll(), 1, 'E-STOP drops the waiting item');
    H.parked[0]();
    await tick(20);
    A.eq(Object.keys(H.disk.seen[id] || {}).length, 1, 'the dropped file is still unfired on disk');
    await H.R.tickFolders(); await H.R.tickFolders();
    await tick();
    A.eq(H.parked.length, 2, 'after the stop, a later scan fires the dropped file — it was never silently lost');
    // restart with an item waiting: the new runner over the same disk fires it
    fs.writeFileSync(path.join(root, 'c.txt'), 'job c'); fs.utimesSync(path.join(root, 'c.txt'), back / 1000, back / 1000);
    await H.R.tickFolders(); await H.R.tickFolders();
    A.eq(H.R.view(id).queued, 1, 'c.txt waits behind b.txt');
    const disk = JSON.parse(JSON.stringify(H.disk));
    const R2 = require('../sidecar/routing/trigger-runner.js').makeTriggerRunner({
      load: () => disk.triggers, save: () => {}, seen: { load: () => disk.seen, save: () => {} },
      makeHub: (hooks) => ({ onInbound: (m) => { hooks.onRouted({ agentId: 'agent-a', dockId: 'b1' }); hooks.onResolved({ agentId: 'agent-a', lineId: 'L1', dockId: 'b1' }); fired2.push(m.text); return Promise.resolve(); }, close() {} }),
      plan: () => H.plan, now: () => H.now() + 5000, newId: () => 'restart0123456789abcdef',
      watcher: makeFolderWatcher({ fsp, pathMod: path, settleMs: 0 }) });
    const fired2 = [];
    await R2.tickFolders(); await R2.tickFolders();
    await tick(20);
    A.ok(fired2.length === 1 && /c\.txt/.test(fired2[0]), 'after a restart the file that was only WAITING fires (and nothing already run refires): ' + fired2.length);
    // a pause drops the waiting item without marking it
    H.parked[1]();
    await tick(20);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  /* ---- 6. a new fire clears the previous outcome (a fire that dies never leaves a stale ✓) ---- */
  {
    const H = harness();
    const c = H.R.create({ kind: 'webhook', lineId: 'L1', maxPerHour: 10 }, { secretHash: T.hashSecret('k') });
    const id = c.trigger.id;
    H.R.enqueue(id, { text: 'one' }); await tick(); H.parked[0](); await tick(20);
    A.ok(H.R.view(id).lastOutcome && H.R.view(id).lastOutcome.ok === true, 'fire one reached the OUTBOX');
    H.advance(1000);
    H.R.enqueue(id, { text: 'two' }); await tick();
    const mid = H.R.view(id);
    A.eq(mid.lastOutcome, null, 'while fire two runs there is no outcome claimed');
    A.ok(mid.running === true, 'the row says it is running');
    // the process dies here: a new runner over the same disk must not show fire one's ✓ for fire two
    const R2 = require('../sidecar/routing/trigger-runner.js').makeTriggerRunner({ load: () => JSON.parse(JSON.stringify(H.disk.triggers)), save: () => {},
      makeHub: () => ({ onInbound: () => Promise.resolve(), close() {} }), plan: () => H.plan, now: () => H.now(), newId: () => 'x0123456789abcdef0000' });
    const after = R2.view(id);
    A.ok(after.lastFiredAt && after.lastOutcome === null, 'after a restart mid-fire: last fired is stated, no stale outcome');
    H.parked[1](); await tick(20);
  }

  /* ---- 11. lastError names a failed stage by its display name (live: "a stage (agent) ended error") ---- */
  {
    const R = require('../sidecar/routing/trigger-runner.js').makeTriggerRunner({
      load: () => ({ triggers: [] }), save: () => {}, plan: () => ({ lines: [{ lineId: 'L1' }], reach: { 'agent-a': true }, lineOfAgent: { 'agent-a': 'L1' } }),
      makeHub: (hooks) => ({ onInbound: (m) => { const r = hooks.onRouted({ agentId: 'agent-a', dockId: 'b1' }); hooks.onResolved({ agentId: r.agentId, lineId: 'L1', dockId: 'b1' }); runs[hooks.streamId()] = [{ runId: 'x', agentId: 'agent-a', reason: 'error', streamId: hooks.streamId() }]; hooks.onLineOutcome({ agentId: 'agent-a', dockId: 'b1' }); return Promise.resolve(); }, close() {} }),
      runsFor: sid => runs[sid] || [], shipsToOutbox: () => true, label: id => id === 'agent-a' ? 'NOVA' : null,
      now: () => 1e12, newId: () => 'lbl0123456789abcdef0000' });
    const runs = {};
    const c = R.create({ kind: 'webhook', lineId: 'L1' }, { secretHash: T.hashSecret('k') });
    R.enqueue(c.trigger.id, { text: 'x' });
    await tick(20);
    A.ok(/NOVA failed/.test(R.view(c.trigger.id).lastError || '') && !/agent-a/.test(R.view(c.trigger.id).lastError || ''), 'the failed stage is named NOVA, not agent-a: ' + R.view(c.trigger.id).lastError);
    A.eq(R.view(c.trigger.id).lastOutcome.agentId, 'agent-a', 'the display label never replaces the recorded agent identity');
  }

  /* ---- 10. an UNREADABLE file backs off instead of churning every poll ---- */
  {
    let reads = 0, fail = true;
    const watcher = {
      scan: async (dir, seen, pending) => ({ ok: true, pending, ready: (seen && seen['k1']) ? [] : [{ name: 'locked.txt', abs: dir + '/locked.txt', size: 3, mtimeMs: 1, key: 'k1' }] }),
      readItem: async () => { reads++; return fail ? { ok: false, error: 'cannot read locked.txt: EBUSY' } : { ok: true, binary: false, content: 'hi', truncated: false }; }
    };
    const H = harness({ watcher });
    let seenWrites = 0;
    const c = H.R.create({ kind: 'folder', lineId: 'L1', maxPerHour: 50, config: { path: 'C:/drops' } }, { baselineKeys: [] });
    const id = c.trigger.id;
    const before = JSON.stringify(H.disk.seen);
    for (let i = 0; i < 10; i++) { await H.R.tickFolders(); H.advance(3000); }   // 30 s of 3 s polls
    A.ok(reads >= 2 && reads <= 3, 'a file that stays unreadable is retried with backoff, not on all 10 polls: ' + reads + ' reads');
    A.eq(JSON.stringify(H.disk.seen), before, 'a read failure writes nothing to the fired-file record (no mark/unmark churn)');
    A.ok(/EBUSY — retrying it later/.test(H.R.view(id).lastError || ''), 'the failure is on record: ' + H.R.view(id).lastError);
    for (let i = 0; i < 60; i++) { await H.R.tickFolders(); H.advance(10000); }   // 10 minutes
    A.ok(reads <= 9, 'the backoff keeps doubling (capped) — ' + reads + ' reads in ~10.5 min');
    fail = false;
    H.advance(10 * 60 * 1000);
    await H.R.tickFolders();
    await tick();
    A.eq(H.parked.length, 1, 'once the file reads, it fires');
    A.ok(H.disk.seen[id] && H.disk.seen[id].k1, 'and is recorded as fired as it dispatches');
    H.parked[0]();
    await tick(20);
    void seenWrites;
  }

  /* ---- 3. a folder inside a line's working folder is refused (create AND every fire) ---- */
  {
    const fs = require('fs'), fsp = require('fs/promises'), os = require('os'), path = require('path');
    const { makeFolderPolicy, lineOutputError } = require('../sidecar/routing/trigger-folder.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-trg-sweep-'));
    const home = path.join(root, 'home');
    const project = path.join(home, 'proj'); fs.mkdirSync(path.join(project, 'drops'), { recursive: true });
    const elsewhere = path.join(home, 'inbox'); fs.mkdirSync(elsewhere, { recursive: true });
    let lineRoots = [project];
    const policy = makeFolderPolicy({ fsp, pathMod: path, winish: path.sep === '\\', homeRoots: () => [home], blessedRoots: () => [project],
      forbiddenRoots: () => [], systemRoots: () => [], lineRoots: () => lineRoots });
    const inProj = await policy.check(project);
    A.ok(!inProj.ok && inProj.code === 'lineoutput', 'the line\'s own working folder is refused: ' + JSON.stringify(inProj));
    const sub = await policy.check(path.join(project, 'drops'));
    A.ok(!sub.ok && sub.code === 'lineoutput' && /feed on its own output/.test(sub.error), 'a folder INSIDE it is refused with the reason');
    A.ok((await policy.check(elsewhere)).ok, 'a folder outside every line\'s working folder is allowed');
    lineRoots = null;
    const pol2 = makeFolderPolicy({ fsp, pathMod: path, homeRoots: () => [home], forbiddenRoots: () => [], systemRoots: () => [], lineRoots: () => { throw new Error('plan unreadable'); } });
    A.ok(!(await pol2.check(elsewhere)).ok, 'an unreadable line list fails CLOSED');

    // the runner re-asks at every fire: a line whose project later moves over the folder blocks the trigger
    let conflict = null;
    const H = harness();
    const H2 = { R: require('../sidecar/routing/trigger-runner.js').makeTriggerRunner({
      load: () => ({ triggers: [] }), save: () => {}, makeHub: () => ({ onInbound: () => Promise.resolve(), close() {} }),
      plan: () => H.plan, now: () => 1e12, newId: () => 'fixed0123456789abcdef', folderConflict: () => conflict }) };
    const cf = H2.R.create({ kind: 'folder', lineId: 'L1', config: { path: elsewhere } }, { baselineKeys: [] });
    A.ok(cf.ok && cf.trigger.blockedBy === null, 'a folder trigger with no conflict is not blocked');
    conflict = lineOutputError(elsewhere);
    A.ok(/feed on its own output/.test(H2.R.view(cf.trigger.id).blockedBy || ''), 'once a line works in that folder the trigger shows blockedBy');
    const e = H2.R.enqueue(cf.trigger.id, { text: 'x' });
    A.ok(!e.ok && e.code === 'refused', 'and a file landing there is refused, not fired');
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  /* ---- the station's own fault containment is not the Commander's E-STOP (wave 2 review, conveyor-backend-08) ---- */
  {
    const H = harness({ halted: () => true, faulted: () => true });
    const c = H.R.create({ kind: 'webhook', lineId: 'L1', maxPerHour: 10 }, { secretHash: T.hashSecret('k') });
    const why = H.R.view(c.trigger.id).blockedBy || '';
    A.ok(/internal fault/.test(why) && !/E-STOP/.test(why), 'a fault-quiesced station blocks the trigger in its own words, never E-STOP — ' + why);
    const H2 = harness({ halted: () => true });
    const c2 = H2.R.create({ kind: 'webhook', lineId: 'L1', maxPerHour: 10 }, { secretHash: T.hashSecret('k') });
    A.ok(/E-STOP/.test(H2.R.view(c2.trigger.id).blockedBy || ''), 'the Commander’s E-STOP still says E-STOP');
  }

  A.report('trigger-sweep.test');
})().catch(e => { console.log('FAIL: trigger-sweep.test threw - ' + (e && e.stack || e)); process.exit(1); });
