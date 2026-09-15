'use strict';
const assert=require('node:assert/strict');
const M=require('../frontend/app/worldmodel.js');
const P=require('../frontend/app/propsprites.js');
const T=require('../frontend/app/stationtemplates.js');
assert.equal(T.catalog.length,6); // default plus five additional builds
for(const item of T.catalog) {
  const doc=T.build(item.id,M,P,1000),s=M.create(doc);
  assert.equal(s.rooms().filter(r=>r.kind!=='corridor').length,item.rooms);
  for(const t of P.STARTER)assert.equal(doc.props.filter(p=>p.t===t).length,1);
  const validate=M.create({...structuredClone(doc),props:[]});
  for(const p of doc.props){assert.equal(validate.addProp(p).ok,true,p.t+' placement');assert.equal(p.w,P.spec(p.t).w);}
  const g=s.projectGeometry();
  // Every room is reachable from the central room through the real projected graph.
  const origin=[8-g.origin.tx,5-g.origin.ty];
  for(const r of s.rooms().filter(r=>r.kind!=='corridor')){
    const rect=r.rects[0],x=Math.floor((rect.x1+rect.x2)/2)-g.origin.tx,y=Math.floor((rect.y1+rect.y2)/2)-g.origin.ty;
    assert.ok(g.path(origin[0],origin[1],x,y),item.id+': reachable '+r.name);
  }
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
console.log('station-templates: six layouts, reachable rooms, five essentials, desk ownership, undo/redo and persistence PASS');
