'use strict';
const assert=require('node:assert/strict');
const effects=require('../../frontend/app/approved-sheet-effects.js');
let reads=0;
function record(id,state={},box={x:10,y:20,width:24,height:30,sourceWidth:80,sourceHeight:100,crop:{x:4,y:5,width:72,height:90}}) {
 const calls=[];let depth=0;
 const ctx=new Proxy({}, {get(_,key){if(key==='getImageData'){reads++;throw Error('per-frame readback');}return(...args)=>{for(const a of args)if(typeof a==='number')assert(Number.isFinite(a));if(key==='save')depth++;if(key==='restore')assert(--depth>=0);calls.push([key,...args]);};},set(_,key,value){calls.push([key,value]);return true;}});
 const ok=effects.draw(ctx,id,box,state);assert.equal(depth,0);return {ok,calls};
}
for(const id of effects.ids){
 assert(record(id,{now:1200}).ok);
 assert.deepEqual(record(id,{now:100,still:true}),record(id,{now:10000,still:true}),id+' freezes');
 assert.equal(effects.frameBounds(id).width,1);
 if(!['studio','jukebox'].includes(id))assert.deepEqual(record(id,{now:1200}),record(id,{now:1200,fired:1,bad:true}),id+' ignores result telemetry');
}
for(const id of ['etsy_kiln','etsy_dyevat','research_samplecart','studio'])assert.notDeepEqual(record(id,{now:1300}),record(id,{now:1300,work:true}),id+' preserves work gain');
for(const id of ['coffee','steamvent','incubator','cryopod','fishtank','lavalamp','plasmaglobe','terrarium'])assert.deepEqual(record(id,{now:1300}),record(id,{now:1300,work:true}),id+' ambiance is not invented work response');
for(const id of ['studio','jukebox']){
 assert.notDeepEqual(record(id,{fired:1,bad:true}),record(id,{fired:1,bad:false}));
 assert.deepEqual(record(id,{fired:0,bad:true}),record(id,{fired:0,bad:false}));
}
for(const id of ['fishtank','lavalamp','incubator']){
 const prepared=effects.prepare(id,{width:80,height:100});assert(prepared);
 const a=record(id,{now:100,prepared}),b=record(id,{now:6000,prepared});
 assert(a.calls.some(c=>c[0]==='drawImage'));assert.notDeepEqual(a,b,id+' moves actual source patches');
 assert(!record(id,{prepared:{...prepared,id:'wrong'}}).calls.some(c=>c[0]==='drawImage'));
}
const c=record('coffee').calls;
assert.deepEqual(c.find(x=>x[0]==='translate'),['translate',10-4/72*24,20-5/90*30]);
assert.deepEqual(c.find(x=>x[0]==='scale'),['scale',80/72*24,100/90*30]);
assert.equal(record('unknown').ok,false);assert.equal(effects.frameBounds('unknown'),null);assert.equal(reads,0);
console.log('PASS 13 approved-sheet effects: crop mapping, source patches, deterministic still, result/failure truth, ambient/work distinction, balanced context, no readbacks.');
