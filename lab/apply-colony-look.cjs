'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const WM = require('../frontend/app/worldmodel.js');
const { client, inspect } = require('./workflow.cjs');

async function apply() {
  const request = await client('http://127.0.0.1:8790');
  const save = (await request('/api/save')).save;
  const backup = path.resolve('.lab-state/before-colony-look-' + Date.now() + '.json');
  fs.writeFileSync(backup, JSON.stringify(save, null, 2), { mode: 0o600, flag: 'wx' });
  const st = WM.create(save.station);
  const before = st.serialize();
  const oldPlan = inspect(st).plan;
  const check = result => { if (!result.ok) throw new Error(JSON.stringify(result)); };
  for (const id of before.order) {
    check(st.setDeck(id, { style: 'oak', mat: 'parquet' }));
    check(st.setWalls(id, { style: 'bone', mat: 'courses' }));
    check(st.setHull(id, { style: 'ash', mat: 'stone' }));
  }
  const after = st.serialize();
  assert.deepEqual(after.props, before.props, 'Do not change objects or workstations');
  assert.deepEqual(after.belts, before.belts);
  assert.deepEqual(after.links, before.links);
  assert.deepEqual(after.order.map(id => after.rooms[id].rects), before.order.map(id => before.rooms[id].rects));
  const nextPlan = inspect(st).plan;
  assert.equal(inspect(st).valid, true);
  assert.deepEqual(Object.keys(nextPlan.dockChains), Object.keys(oldPlan.dockChains));
  save.station = after;
  save.updatedAt = Math.max(Date.now(), Number(save.updatedAt || 0) + 1);
  const stored = await request('/api/save', save);
  await request('/api/routing', nextPlan);
  return { ok: true, revision: stored.revision, backup, rooms: after.order.length, objectsPreserved: true, beltsPreserved: true, geometryPreserved: true, skin: 'unchanged' };
}
apply().then(result => console.log(JSON.stringify(result, null, 2))).catch(e => { console.error(e); process.exitCode = 1; });
