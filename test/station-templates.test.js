'use strict';
const assert=require('node:assert/strict');
const M=require('../frontend/app/worldmodel.js');
const legacySprites=require('../frontend/app/propsprites.js');
const remasterContext={module:{exports:{}},IndustrialTextures:{enabled:()=>true,ready:{then:fn=>fn()}}};
require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../frontend/app/propsprites.js'),'utf8'),remasterContext);
const T=require('../frontend/app/stationtemplates.js');
const approved=require('./fixtures/station-default-approved.json');
assert.equal(T.catalog.length,7); // default, five purpose builds, and cozy workshop
for(const P of [legacySprites,remasterContext.module.exports])for(const item of T.catalog) {
  const doc=T.build(item.id,M,P,1000),s=M.create(doc);
  assert.equal(s.rooms().filter(r=>r.kind!=='corridor').length,item.rooms);
  const home=doc.rooms[doc.meta.spawnRoomId];
  for(const [key,value] of Object.entries(approved.room))assert.deepEqual(home[key],value,item.id+': approved home '+key);
  assert.deepEqual(doc.props.filter(p=>p.x>=0&&p.x<=17&&p.y>=0&&p.y<=10).map(({t,x,y,w,h})=>({t,x,y,w,h})),approved.props,item.id+': approved home furniture');
  for(const t of P.STARTER)assert.equal(doc.props.filter(p=>p.t===t).length,1);
  const validate=M.create({...structuredClone(doc),props:[]});
  for(const p of doc.props){
    assert.equal(validate.addProp(p).ok,true,p.t+' placement');
    // Preserve the approved existing desk; newly added desks use the active art's width.
    if(p.x<0||p.x>17||p.y<0||p.y>10)assert.equal(p.w,P.spec(p.t).w);
  }
  const g=s.projectGeometry();
  if(item.id==='cozy') {
    const pipeline=require('../frontend/app/pipeline.js');
    assert.equal(s.belts().length,6,'cozy: both conveyor runs are installed');
    const fresh=pipeline.compileRoutingPlan(g);
    assert.deepEqual(fresh.errors.map(e=>e.code),['UNBOUND_BAY'],'cozy: only agent assignment remains');
    const bay=s.props().find(p=>p.t==='bay');
    assert.equal(s.assignPropAgent(bay.id,'test-agent').ok,true);
    const bound=pipeline.compileRoutingPlan(s.projectGeometry());
    assert.deepEqual(bound.errors,[],'cozy: connected routing plan');
    assert.equal(bound.reach['test-agent'],true,'cozy: inbox reaches assigned bay');
    assert.equal(Object.keys(pipeline.liveTiles(bound)).length,6,'cozy: both runs energized');
  }
  if(item.id==='creative') {
    const pipeline=require('../frontend/app/pipeline.js');
    const untouched=JSON.stringify(doc);
    const guide=T.example(doc,M,pipeline);
    assert.equal(JSON.stringify(doc),untouched,'guide inspection never assigns agents or changes the input document');
    assert.equal(guide.ready,false); assert.equal(guide.roles.length,2);
    assert.deepEqual(guide.roles.map(r=>r.agentId),['','']);
    assert.match(guide.sample,/fictional community garden/);
    const bays=s.props().filter(p=>p.t==='bay');
    assert.equal(bays.length,2);
    assert.match(bays[0].brief,/^Draft a response/);
    assert.match(bays[1].brief,/^Review the incoming draft/);
    assert.deepEqual(pipeline.compileRoutingPlan(g).errors.map(e=>e.code),['UNBOUND_BAY','UNBOUND_BAY']);
    bays.forEach((bay,i)=>assert.equal(s.assignPropAgent(bay.id,'creative'+i).ok,true));
    const plan=pipeline.compileRoutingPlan(s.projectGeometry());
    assert.deepEqual(plan.errors,[],'creative: configured line compiles cleanly');
    assert.equal(plan.reach.creative0,true,'creative: inbox feeds drafter');
    assert.deepEqual(plan.chains.creative0.next,['creative1'],'creative: draft hands off to review');
    assert.equal(plan.chains.creative1.outbox,true,'creative: reviewer sends to outbox');
    const noComputer=T.example(s.serialize(),M,pipeline);
    assert.equal(noComputer.ready,false,'two agents cannot share an unassigned computer');
    assert.match(noComputer.issue,/computer access/);
    const desks=s.props().filter(p=>p.t==='desk');
    for (let i=0;i<2;i++) s.assignPropAgent(desks[i].id,'creative'+i);
    const configured=T.example(s.serialize(),M,pipeline);
    assert.equal(configured.ready,true,'guide readiness requires the actual compiled route');
    assert.deepEqual(configured.roles.map(r=>r.agentId),['creative0','creative1']);
    const duplicate=M.create(structuredClone(s.serialize()));
    duplicate.assignPropAgent(bays[1].id,'creative0');
    assert.equal(T.example(duplicate.serialize(),M,pipeline).ready,false,'one agent cannot impersonate both workflow stages');
    const reordered=structuredClone(s.serialize()); reordered.props.reverse();
    assert.deepEqual(T.example(reordered,M,pipeline).roles.map(r=>r.agentId),['creative0','creative1'],'role order follows directed routing, not saved array order');
    const broken=M.create(structuredClone(s.serialize()));
    broken.setBelt(28,2,'W'); broken.setBelt(29,2,'W'); broken.setBelt(30,2,'W');
    assert.equal(T.example(broken.serialize(),M,pipeline).ready,false,'broken or reversed conveyor never claims ready');
    assert.equal(Object.keys(pipeline.liveTiles(plan)).length,8,'creative: all conveyor segments connected');
  }
  // Every room is reachable from the central room through the real projected graph.
  const origin=[8-g.origin.tx,5-g.origin.ty];
  for(const r of s.rooms().filter(r=>r.kind!=='corridor')){
    const rect=r.rects[0],x=Math.floor((rect.x1+rect.x2)/2)-g.origin.tx,y=Math.floor((rect.y1+rect.y2)/2)-g.origin.ty;
    assert.equal(rect.x2-rect.x1+1,18,item.id+': normal room width');
    assert.equal(rect.y2-rect.y1+1,11,item.id+': normal room depth');
    assert.ok(g.path(origin[0],origin[1],x,y),item.id+': reachable '+r.name);
    // A path around furniture is insufficient: added rooms need clear entrances.
    if(r.id!==doc.meta.spawnRoomId)for(const hall of s.rooms().filter(h=>h.kind==='corridor'))for(const h of hall.rects){
      let landing=null;
      const overlapX=h.x1<=rect.x2&&h.x2>=rect.x1,overlapY=h.y1<=rect.y2&&h.y2>=rect.y1;
      if(overlapX&&h.y2===rect.y1-1)landing={x1:Math.max(h.x1,rect.x1),x2:Math.min(h.x2,rect.x2),y1:rect.y1,y2:rect.y1+2};
      if(overlapX&&h.y1===rect.y2+1)landing={x1:Math.max(h.x1,rect.x1),x2:Math.min(h.x2,rect.x2),y1:rect.y2-2,y2:rect.y2};
      if(overlapY&&h.x2===rect.x1-1)landing={x1:rect.x1,x2:rect.x1+2,y1:Math.max(h.y1,rect.y1),y2:Math.min(h.y2,rect.y2)};
      if(overlapY&&h.x1===rect.x2+1)landing={x1:rect.x2-2,x2:rect.x2,y1:Math.max(h.y1,rect.y1),y2:Math.min(h.y2,rect.y2)};
      if(landing)for(const p of doc.props)assert.ok(!M.rectsHit(landing,{x1:p.x,y1:p.y,x2:p.x+p.w-1,y2:p.y+p.h-1}),item.id+': '+p.t+' clear of '+r.name+' doorway');
    }
  }
  // Floor decals are walkable; they do not have a furniture interaction edge.
  for(const p of doc.props.filter(p=>!P.spec(p.t).flat))assert.ok(g.path(origin[0],origin[1],p.x-g.origin.tx,p.y+p.h-g.origin.ty),item.id+': reachable front of '+p.t);
  const current=M.create(M.starterDoc());current.ensureWorkstation('agent');current.ensureWorkstation('crew');
  const before=current.serialize(),identity=before.meta.createdAt;
  assert.equal(current.replaceLayout(doc).ok,true);
  assert.equal(current.doc().meta.createdAt,identity);
  for(const id of ['agent','crew'])assert.equal(current.props().filter(p=>p.agentId===id).length,1);
  assert.equal(current.undo().ok,true);assert.deepEqual(current.serialize(),before);
  assert.equal(current.redo().ok,true);
  const restored=M.deserialize(current.serialize());
  assert.deepEqual(restored.serialize(),current.serialize());
  const invalid=structuredClone(doc);invalid.props[0].x=999;
  const snapshot=current.serialize();assert.equal(current.replaceLayout(invalid).ok,false);assert.deepEqual(current.serialize(),snapshot);
}
console.log('station-templates: seven layouts, classic/remastered catalogs, approved home, cozy and creative conveyor routing, clear entrances, prop access, ownership, undo/redo and persistence PASS');
