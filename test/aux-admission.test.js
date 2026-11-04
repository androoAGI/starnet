'use strict';
const assert = require('node:assert/strict');
const { makeAuxAdmission } = require('../sidecar/aux-admission.js');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
(async () => {
  let used = 0, entered = 0, skipped = 0;
  const held = defer(), firstStarted = defer();
  const q = makeAuxAdmission({ gate: route => ({ applies: route !== 'local', blocked: route === 'claude' && used >= 100 }) });
  const a = q.schedule('claude', async () => { entered++; firstStarted.resolve(); await held.promise; used = 150; });
  await firstStarted.promise;
  const b = q.schedule('claude', async () => { entered++; }, () => { skipped++; });
  let other = false;
  await q.schedule('codex', async () => { other = true; });
  assert.equal(other, true, 'another subscription route progresses independently');
  assert.equal(entered, 1, 'same-route work waits for complete settlement');
  held.resolve();
  assert.deepEqual(await Promise.all([a, b]), [true, false]);
  assert.deepEqual([entered, skipped, used], [1, 1, 150], 'completed response is never cut; next pass rechecks usage');
  used = 0;
  await assert.rejects(q.schedule('claude', async () => { throw Error('provider failed'); }), /provider failed/);
  assert.equal(await q.schedule('claude', async () => { entered++; }), true, 'a failed pass cannot wedge the route');
  const local = defer();
  const l1 = q.schedule('local', () => local.promise);
  assert.equal(await q.schedule('local', async () => {}), true, 'exempt/off routes do not wait');
  local.resolve(); await l1;
  const changed = defer();
  const c1 = q.schedule('claude', () => changed.promise);
  const c2 = q.schedule('claude', async () => { entered++; });
  await Promise.resolve(); used = 100; changed.resolve();
  assert.deepEqual(await Promise.all([c1, c2]), [true, false], 'a changed limit is read at dispatch, not enqueue');
  // Execute the real quest tick with a held admission: changing the default must not spend on an unadmitted route,
  // and switching autonomy off while waiting must cancel the look before it stamps a cycle or calls a model.
  const { sidecarTopLevelFunction } = require('./helpers/source.js');
  for (const pause of [false, true]) {
    let route = 'claude', enabled = true, queued, admitted, called, stamps = 0;
    const names = ['processFaultQuiesced', 'process', 'questRefreshingNow', 'commanderPosture', 'stationLife', 'QuestRefresh',
      'questRefreshState', 'questRefreshOpenCount', 'questContextKey', 'governor', 'cronProviderFor', 'questRefreshCeilingNoted',
      'questRefreshNote', 'automaticAux', 'persistQuestRefresh', 'runQuestRefreshCycle', 'swallow'];
    const tick = new Function(...names, sidecarTopLevelFunction('questRefreshTick') + '; return questRefreshTick;')(
      false, { env: {} }, false, { summary: () => ({ enabled }) }, { station: () => ({}) },
      { decide: () => ({ fire: true, why: 'due' }), stampCycle: () => { stamps++; return {}; } }, {}, () => 0, () => 'ctx',
      { admit: () => null }, () => route, false, () => {},
      (r, kind, agent, run, work) => { admitted = r; queued = work; return Promise.resolve(); }, () => {},
      (why, r) => { called = r; }, () => () => {});
    tick(); route = 'codex'; if (pause) enabled = false;
    await queued();
    assert.equal(admitted, 'claude');
    assert.equal(called, pause ? undefined : 'claude', 'queued quest uses its admitted route and honors a later pause');
    assert.equal(stamps, pause ? 0 : 1, 'a paused queued quest does not consume its cadence');
  }
  console.log('aux-admission: PASS (settlement, independent routes, failure release, exempt routes, live recheck)');
})().catch(e => { console.error(e); process.exitCode = 1; });
