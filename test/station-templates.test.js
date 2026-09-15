'use strict';
const assert=require('node:assert/strict');
const M=require('../frontend/app/worldmodel.js');
const legacySprites=require('../frontend/app/propsprites.js');
const remasterContext={module:{exports:{}},IndustrialTextures:{enabled:()=>true,ready:{then:fn=>fn()}}};
require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../frontend/app/propsprites.js'),'utf8'),remasterContext);
const T=require('../frontend/app/stationtemplates.js');
const approved=require('./fixtures/station-default-approved.json');
assert.equal(T.catalog.length,6); // default plus five additional builds
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
  for(const p of doc.props)assert.ok(g.path(origin[0],origin[1],p.x-g.origin.tx,p.y+p.h-g.origin.ty),item.id+': reachable front of '+p.t);
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
console.log('station-templates: six layouts, classic/remastered catalogs, approved home, clear entrances, prop access, ownership, undo/redo and persistence PASS');
