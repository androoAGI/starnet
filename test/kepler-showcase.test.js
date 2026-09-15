'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('Kepler preview has legal props, reachable rooms and an intake-to-outbox crew line',async()=>{
  global.IndustrialTextures={enabled:()=>true,isRemaster:()=>true,ready:Promise.resolve()};
  const P=require('../frontend/app/propsprites.js'),M=require('../frontend/app/worldmodel.js');
  await IndustrialTextures.ready;
  // Construction checks each footprint, mount, facing and belt against the placement model.
  const {doc,station}=require('../dev/kepler-showcase.cjs').createPreset(P,M);
  assert.equal(doc.order.filter(id=>doc.rooms[id].kind!=='corridor').length,3);
  const geo=station.projectGeometry();
  const plan=require('../frontend/app/pipeline.js').compileRoutingPlan(geo);
  assert.deepEqual(plan.errors,[]);
  assert.equal(plan.reach.agent,true);
  assert.equal(plan.chains.agent.outbox,true);
  assert.equal(plan.chains.agent.deadEnd,false);
  assert.deepEqual(plan.lines[0].intakes,['line-intake']);
  assert.deepEqual(plan.lines[0].outboxes,['line-outbox']);
  const local=([x,y])=>[x-geo.origin.tx,y-geo.origin.ty];
  const start=local([26,13]);
  for(const [name,tile]of [['fabrication',[12,23]],['lounge',[41,26]],['workbench',[18,26]],['lounge seating',[39,34]]]){
    const end=local(tile);
    assert.ok(geo.walkable(...end),name+' destination is walkable');
    assert.ok(geo.path(...start,...end)?.length,name+' reachable from command');
  }
});
