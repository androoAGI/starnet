'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const fx=require('../frontend/app/projection-prop-effects.js');
const manifest=require('../frontend/assets/industrial/projection-correction/manifest.json');
const coverage=require('../docs/station-remaster/projection-effects/coverage.json');
let reads=0,allocations=0;
function record(id,state={},overrides={},view='s'){
 const binding=fx.classify(id,view)?.binding;
 const calls=[],stack=[];let context={globalAlpha:.61,globalCompositeOperation:'source-atop'};
 const ctx=new Proxy({}, {get(_,key){if(key==='globalAlpha'||key==='globalCompositeOperation')return context[key];if(key==='getImageData'){reads++;throw Error('Frame readback');}return(...args)=>{if(key==='save')stack.push({...context});if(key==='restore'){assert(stack.length);context=stack.pop();}for(const a of args)if(typeof a==='number')assert(Number.isFinite(a));calls.push([key,...args]);};},set(_,key,value){context[key]=value;calls.push([key,value]);return true;}});
 const box={x:10,y:20,width:24,height:30,sourceWidth:binding?.width,sourceHeight:binding?.height,crop:{x:4,y:5,width:binding?.width-8,height:binding?.height-10},...overrides};
 const ok=fx.draw(ctx,id,view,box,state);assert.equal(stack.length,0);assert.equal(context.globalAlpha,.61);assert.equal(context.globalCompositeOperation,'source-atop');return {ok,calls,box};
}
assert.equal(Object.keys(fx.coverage()).length,Object.keys(manifest.props).length);
assert.equal(coverage.records.length,Object.values(manifest.props).reduce((n,p)=>n+Object.keys(p.views).length,0));
for(const[id,p]of Object.entries(manifest.props))for(const[view,v]of Object.entries(p.views)){
 const c=fx.classify(id,view);assert(c?.reason,id+':'+view+' explicit classification');
 assert(['effects','none'].includes(c.classification));
 assert.equal(fx.matches(id,view,v),c.classification==='effects');
 assert.equal(fx.matches(id,view,{...v,image:'wrong.png'}),false);
 assert.equal(fx.matches(id,view,{...v,sourceWidth:v.sourceWidth+1}),false);
 const saved=coverage.records.find(r=>r.id===id&&r.view===view);assert(saved);
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync('frontend/'+saved.image.replace('frontend/',''))).digest('hex'),saved.sha256,id+' source unchanged since review');
 if(c.classification==='none'){assert.equal(record(id,{}, {},view).ok,false);assert.equal(record(id,{work:true,fired:1}, {},view).calls.length,0);}
}
for(const id of fx.ids){
 assert(record(id).ok,id+' valid geometry');
 assert.deepEqual(record(id,{now:17,still:true}),record(id,{now:91831,still:true}),id+' reduced motion freezes time');
 assert.equal(record(id,{}, {sourceWidth:1}).ok,false,id+' wrong source rejected');
 assert.equal(record(id,{}, {crop:{x:-1,y:0,width:1,height:1}}).ok,false);
 assert.equal(record(id,{}, {width:NaN}).ok,false);
 const c=fx.classify(id),b=fx.frameBounds(id);assert(b&&b.width>0&&b.height>0);
 for(const e of c.effects)for(const p of e.region){assert(p.every(Number.isFinite));assert(p[0]>=b.x-1e-8&&p[0]<=b.x+b.width+1e-8);assert(p[1]>=b.y-1e-8&&p[1]<=b.y+b.height+1e-8);}
}
for(const id of ['intake','bay','merger','rack','fabricator','comms_beacon','pub_publishpress']){
 assert.deepEqual(record(id,{now:100}),record(id,{now:3100}),id+' idle never clocks work');
 assert.notDeepEqual(record(id,{now:1300}),record(id,{now:1300,work:true}),id+' actual work changes its own region');
}
assert.deepEqual(record('filter',{now:900,work:true}),record('filter',{now:900}), 'generic work cannot fake parcel scan');
assert.notDeepEqual(record('filter',{now:900,scanning:true}),record('filter',{now:900}));
assert.deepEqual(record('console',{now:500,occupied:false,work:true}),record('console',{now:500,occupied:false}), 'vacant workstation stays off');
assert.notDeepEqual(record('console',{now:500,occupied:true}),record('console',{now:500,occupied:false}));
assert.deepEqual(record('jukebox',{now:500,work:true}),record('jukebox',{now:500}), 'work cannot invent a music connection');
assert.notDeepEqual(record('jukebox',{now:500,live:true}),record('jukebox',{now:500}));
assert.deepEqual(record('workbench',{now:200,bad:true}),record('workbench',{now:200,bad:false}));
assert.notDeepEqual(record('workbench',{now:200,fired:.5,bad:true}),record('workbench',{now:200,fired:.5,bad:false}));
assert.deepEqual(record('workbench',{fired:Infinity}),record('workbench',{fired:0}));
assert.deepEqual(record('workbench',{fired:true}),record('workbench',{fired:0}), 'truthy nonnumeric is not a result amplitude');
assert.notDeepEqual(record('connector_portal',{bound:true,state:'online'}),record('connector_portal',{bound:true,state:'offline'}));
assert.deepEqual(record('connector_portal',{bound:false,state:'online'}),record('connector_portal',{bound:false,state:'error'}),'unbound never implies connection');
for(const id of ['coffee','steamvent','fishtank','lavalamp','incubator','plasmaglobe','cryopod'])assert.deepEqual(record(id,{now:600}),record(id,{now:600,work:true,fired:1,bad:true}),id+' ambience ignores task telemetry');
assert.deepEqual(record('trophycase',{trophies:0}),record('trophycase',{trophies:-2}));
assert.notDeepEqual(record('trophycase',{trophies:0}),record('trophycase',{trophies:2}));
assert.notDeepEqual(record('missionboard',{pins:0}),record('missionboard',{pins:2}));
assert.notDeepEqual(record('airlock',{door:'closed'}),record('airlock',{door:'open'}));
assert.notDeepEqual(record('airlock',{door:'closed'}),record('airlock',{door:'jammed'}));
const r=record('filter'),b=r.box;
assert.deepEqual(r.calls.find(x=>x[0]==='translate'),['translate',10-4/b.crop.width*24,20-5/b.crop.height*30]);
assert.deepEqual(r.calls.find(x=>x[0]==='scale'),['scale',b.sourceWidth/b.crop.width*24,b.sourceHeight/b.crop.height*30]);
assert.equal(record('unknown').ok,false);assert.equal(fx.classify('filter','e'),null);assert.equal(fx.frameBounds('unknown'),null);assert.equal(reads,0);
assert(fx.frameBounds('steamvent').y<0);assert(fx.frameBounds('treasury_pnl_holo').y<0);
// Preparation caches only the three source motion bodies, at <=256px maximum.
global.OffscreenCanvas=class{constructor(w,h){allocations++;this.width=w;this.height=h;}getContext(){return {drawImage(){}};}};
for(const id of ['fishtank','lavalamp','incubator']){const spec=manifest.props[id].views.s,p=fx.prepare(id,'s',{width:spec.sourceWidth,height:spec.sourceHeight},spec);assert(p?.image);assert(Math.max(p.width,p.height)<=256);fx.dispose(p);assert.equal(p.image,null);}
assert.equal(allocations,3);delete global.OffscreenCanvas;
console.log('PASS projection effects: 160 types/184 views, image bindings, source hashes, idle/occupied/work/scan/connection/result/count truth, crop mapping, reduced motion, frame bounds, context restore, bounded preparation.');
