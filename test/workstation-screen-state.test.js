
'use strict';
// Real seating/geometry seam plus the public prop-state API. Native pixel proof
// lives in dev/industrial-textures/verify-workstation-state.cjs.
const fs=require('fs'),vm=require('vm'),A=require('./_assert');
const WM=require('../frontend/app/worldmodel'),PropAnchor=require('../frontend/app/propanchor');
const source=fs.readFileSync(require.resolve('../frontend/app/world.js'),'utf8');
const helperNames=['isWorkstationProp','deskPropFor','deskSeat','seatCx','seatCy','seatFoot','bodyAtWorkstationSeat','workstationOccupied','workstationLit'];
const helpers=helperNames.map(name=>{
 const fn=A.fnBody(source,'function '+name+'(');
 A.ok(fn.length>30&&fn.length<2400,name+' is a bounded executable seam');
 return fn;
}).join('\n');
let mode=true;
const recorded=[];
const textures={isRemaster:()=>mode,enabled:()=>mode,ready:{then(){}},
 workstation(g,x,y,w,h,facing,state){if(!mode)return false;recorded.push({x,y,w,h,facing,state});return true;},
 workstationEmitter:(x,y,w,h,facing)=>facing==='n'?null:{x:x+w*.3,y:y-3}};
const noop=()=>{};
const painter=new Proxy({globalAlpha:1,createLinearGradient:()=>({addColorStop:noop}),measureText:()=>({width:1})},
 {get:(o,k)=>k in o?o[k]:noop});
const env={module:{exports:{}},IndustrialTextures:textures,console};
vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/app/propsprites.js'),'utf8'),env);
const props=env.module.exports;
props.setCtx(painter);WM.setPropRules(props.spec);
for(const r of [0,1,2,3]) for(const width of [2,3]) {
 const station=WM.create(), added=station.addProp({t:'desk',x:4,y:3,w:r%2?1:width,h:r%2?width:1,r,agentId:'hero'});
 A.ok(added.ok,'placed physical desk '+width+'/'+r);
 const geo=station.projectGeometry(),p=geo.props.find(p=>p.agentId==='hero');
 const hero={id:'hero',unplaced:false,sitting:true,state:'idle',working:false,target:null};
 const worker={agentId:'worker',id:'worker',sitting:true,state:'idle',working:false};
 const runtime=Function('station','geo','agent','crew','PropSprites','PropAnchor','IndustrialTextures',
  'const T=12,blocked=new Set();let compute=true;const computeOkFor=()=>compute;\n'+helpers+
  '\nreturn {seat:deskSeat,foot:seatFoot,occupied:workstationOccupied,lit:workstationLit,at:bodyAtWorkstationSeat,gate:v=>compute=v};')
  (station,geo,hero,[worker],props,PropAnchor,textures);
 const foot=runtime.foot(runtime.seat(p));Object.assign(hero,{px:foot.x,py:foot.y});
 A.ok(runtime.occupied(p),'seated hero wakes its glass '+width+'/'+r);
 A.eq(runtime.lit(p),false,'seating alone never claims work');
 hero.working=true;A.ok(runtime.lit(p),'actual hero work keeps existing signal');
 for(const patch of [{sitting:false},{state:'walk'},{target:{x:foot.x,y:foot.y}},{unplaced:true},{px:foot.x+12},{py:NaN}]) {
  const before={...hero};Object.assign(hero,patch);
  A.eq(runtime.occupied(p),false,'walking/stale/unplaced/remote body cannot wake desk '+JSON.stringify(patch));
  Object.assign(hero,before);
 }
 A.eq(runtime.occupied({...p,id:'duplicate'}),false,'another assigned prop is not the occupied home desk');
 A.eq(runtime.occupied({...p,agentId:null}),false,'empty desk stays off');
 A.eq(runtime.occupied({...p,t:'crate'}),false,'cosmetic prop is not a workstation');
 A.eq(runtime.at(hero,null),false,'absent synthetic seat stays off');
 A.ok(runtime.at(hero,runtime.seat(p)),'synthetic desk shares physical seating contract');
 p.agentId='worker';Object.assign(worker,{px:foot.x,py:foot.y});
 A.ok(runtime.occupied(p),'actual seated worker wakes its own screen');
 A.eq(runtime.lit(p),false,'seated worker does not mint backend work');
 worker.working=true;A.ok(runtime.lit(p),'running worker retains work flag');
 runtime.gate(false);A.eq(runtime.lit(p),false,'compute gate still suppresses work claim');
 A.ok(runtime.occupied(p),'compute denial does not erase physical occupancy');
 worker.sitting=false;A.eq(runtime.occupied(p),false,'worker departing extinguishes display');
}
for(const id of ['desk','desk2']) for(const r of [0,1,2,3]) for(const m of [false,true]) {
 const fp=props.footprintAt(id,r),p={t:id,x:2,y:4,w:fp.w,h:fp.h,r,m};
 for(const state of [{occupied:false,still:false,work:false},{occupied:false,still:false,work:true},
  {occupied:true,still:false,work:false},{occupied:true,still:false,work:true},{occupied:true,still:true,work:true}]) {
  props.setNow(1050);recorded.length=0;
  props.draw(p,state.work,{occupied:state.occupied,still:state.still,heat:state.work?.5:0,prog:null});
  const call=recorded[recorded.length-1];
  A.ok(call,'authoritative raster receives state '+id+'/'+r+'/'+m);
  A.eq([call.state.occupied,call.state.work,call.state.still,call.state.now],
   [state.occupied,state.work,state.still,1050],'independent occupancy/work/motion reach every source view');
  A.eq(call.facing,r===2?'n':r===0?'s':'e','source facing follows existing projection');
  const light=props.lightOf(p,state.work,state.still,{occupied:state.occupied});
  if(!state.occupied||r===2)A.eq(light,null,'empty and rear-facing screen emits nothing');
  else {A.ok(light&&light.a>0,'occupied visible screen emits cyan');A.eq(light.c,[70,185,200],'bounce matches authored phosphor');}
 }
}
mode=false;
A.eq(props.lightOf({t:'desk',x:2,y:4,w:2,h:1},false,true,{occupied:true}),null,'classic ignores new occupancy signal');
A.ok(props.lightOf({t:'desk',x:2,y:4,w:2,h:1},true,true,{occupied:false}),'classic keeps real work light behavior');
// Protect the two world entry points from silently dropping the independent bit.
A.ok(source.includes('occupied: workstationOccupied(p), still: reduceMotion()'),'placed frame feeds physical occupancy');
A.ok(source.includes('PropSprites.lightOf(dp, work, reduceMotion(), live)'),'placed raster and bounce receive same state');
A.ok(source.includes('occupied: bodyAtWorkstationSeat(agent, seat), still: reduceMotion()'),'synthetic frame feeds the same physical occupancy');
A.report('workstation-screen-state');

