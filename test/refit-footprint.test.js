'use strict';
const fs = require('fs');
const assert = require('node:assert/strict');
const W = require('../frontend/app/worldmodel.js');
const source = fs.readFileSync(require.resolve('../frontend/app/build.js'), 'utf8');
const pure = source.split('// REFIT-FOOTPRINT-BEGIN')[1].split('// REFIT-FOOTPRINT-END')[0];
const project = new Function(pure + '\nreturn projectFootprint;')();
function fixture() {
  const st = W.create(W.defaultDoc());
  st.rooms()[0].rects = [{x1:0,y1:0,x2:7,y2:7}];
  return st;
}
const rect = (x1,y1,x2,y2) => ({x1,y1,x2,y2});
const plan = (st,rects,kind='hab') => project(W,st.doc(),{rects,kind});
{
  const st=fixture(), before=JSON.stringify(st.doc()), seq=st.getSeq();let emitted=0;
  st.onChange(()=>emitted++);
  const p=plan(st,[rect(8,2,12,4)]);
  assert.ok(p.ok);assert.deepEqual(p.openings.map(e=>[e.side,e.x,e.y,e.length]),[['w',8,2,3]]);
  assert.ok(!p.runs.some(e=>e.side==='w'&&!e.open),'no wall is promised across a real join');
  assert.equal(JSON.stringify(st.doc()),before,'preview never changes the saved document');
  assert.equal(st.getSeq(),seq);assert.equal(emitted,0,'preview never emits a live edit or save');
  const committed=W.deserialize(st.doc());const edit=committed.addRoom({kind:'hab',rects:p.rects});assert.ok(edit.ok);
  const g=committed.projectGeometry(),o=g.origin;
  for(let y=2;y<=4;y++)assert.ok(g.canStep(7-o.tx,y-o.ty,8-o.tx,y-o.ty),'preview opening matches committed passage');
}
{
  const st=fixture();
  assert.equal(plan(st,[rect(9,2,13,4)]).openings.length,0,'one tile of void is not a connection');
  assert.equal(plan(st,[rect(8,8,10,10)]).openings.length,0,'diagonal contact is not a connection');
  for(const [r,side,length] of [[rect(2,-3,4,-1),'s',3],[rect(-3,2,-1,4),'e',3],[rect(2,8,4,10),'n',3]]) {
    const p=plan(st,[r]);assert.equal(p.openings.length,1);assert.equal(p.openings[0].side,side);assert.equal(p.openings[0].length,length);
  }
  assert.equal(plan(st,[rect(6,2,10,4)]).ok,false,'overlap cannot produce a connected green ghost');
}
{
  const p=plan(fixture(),[rect(8,2,11,3),rect(10,4,11,7)],'corridor');
  assert.ok(p.ok);assert.equal(p.openings.length,1);
  assert.ok(!p.runs.some(e=>(e.side==='n'||e.side==='s')&&e.y===4&&e.x>=10),'adjoining L footprint rectangles have no internal outline');
  const length=p.runs.reduce((n,e)=>n+e.length,0);assert.equal(length,20,'union perimeter has no duplicate internal edges');
}
{
  const st=fixture(), made=st.addRoom({kind:'hab',rect:rect(12,0,15,3)});assert.ok(made.ok);
  const before=JSON.stringify(st.doc());
  const moved=project(W,st.doc(),{moveId:made.id,dx:-4,dy:0});
  assert.ok(moved.ok);assert.deepEqual(moved.openings.map(e=>[e.side,e.length]),[['w',4]]);
  assert.equal(JSON.stringify(st.doc()),before,'moving preview leaves original room and its contents untouched');
  const airlock=st.addProp({t:'airlock',x:13,y:1,w:1,h:1,block:false});assert.ok(airlock.ok);assert.ok(st.setDoorState(airlock.id,'closed').ok);
  const sealedMove=project(W,st.doc(),{moveId:made.id,dx:-4,dy:0});
  assert.ok(sealedMove.ok);assert.equal(sealedMove.openings.length,0);assert.equal(sealedMove.sealed,true,'a carried closed airlock stays sealed in preview');
  assert.equal(plan(st,[rect(16,0,18,3)]).openings.length,0,'adjacent sealed neighbor never promises an opening');
  st.setDoorState(airlock.id,'open');assert.equal(plan(st,[rect(16,0,18,3)]).openings.length,1,'opening the real airlock restores the projected connection');
}
console.log('refit-footprint: real edit parity, four directions, void/diagonal rejection, union outlines, sealed and moved-room truth passed');
