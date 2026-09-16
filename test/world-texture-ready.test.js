/* Async texture activation must refresh the saved desk front without a floor refit.
   Real model/save/anchor functions; image readiness and canvas calls are bounded stubs. */
'use strict';
const fs=require('fs'),path=require('path'),A=require('./_assert');
const WM=require('../frontend/app/worldmodel'),PA=require('../frontend/app/propanchor');
const src=fs.readFileSync(process.env.WORLD_TEST_SOURCE||path.join(__dirname,'../frontend/app/world.js'),'utf8');
const names=['isWorkstationProp','deskPropFor','deskSeat','seatCx','seatCy','seatFoot','placeDesk','refreshWorkstationSeats','drawSeatChair'];
const helpers=names.map(n=>{
 const body=A.fnBody(src,'function '+n+'(');
 A.ok(body.length>30&&body.length<3500,n+' has a bounded executable source slice');
 return body;
}).join('\n');
const init=A.fnBody(src,'function init('),start=init.indexOf("if (typeof IndustrialTextures !== 'undefined') IndustrialTextures.ready.then("),end=init.indexOf("window.addEventListener('resize', resize)",start);
const readyHook=init.slice(start,end);
A.ok(start>=0&&end>start&&readyHook.length<900,'test executes the actual init readiness subscription');
function setup({r=3,goal='work',sitting=false,failed=false,unloaded=false}={}){
 const draft=WM.create(),added=draft.addProp({t:'desk2',x:6,y:3,w:r%2?1:2,h:r%2?2:1,r,agentId:'hero'});
 A.ok(added.ok,'saved rotated compact desk fits real station geometry');
 const station=WM.deserialize(draft.serialize()),geo=station.projectGeometry();
 let derivations=0;const project=station.projectGeometry;station.projectGeometry=(...a)=>{derivations++;return project(...a);};
 let finish,available=false;
 const textures={ready:new Promise(resolve=>finish=()=>{available=!failed;resolve();}),isRemaster:()=>available,enabled:()=>available};
 const draws=[],ps={facings:()=>available?[0,1,2,3]:[0],has:()=>true,setCtx(){},setNow(){}};
 const hero={id:'hero',goal,px:90,py:83,dir:'north',state:sitting?'idle':'walk',sitting,working:true,
  target:{x:90,y:83},pathPts:[{x:7,y:6}],pathIdx:1,workRetryAt:9000,seatKey:goal==='use'?'couch:0':null,seated:goal==='use'};
 const crew={agentId:'crew',px:54,py:47,state:'walk',target:{x:66,y:47},pathPts:[{x:5,y:3}],working:true};
 const runtime=Function('station','geo','agent','crew','IndustrialTextures','PropSprites','PropAnchor','draws',`
  const T=12,ctx={},now=0,CRT={};let blocked=new Set(),desk=null,seat=null,deskPropId=null,deskFace='north',bakeDirty=false,redraws=0;
  const redrawNow=()=>{redraws++;},drawLitProp=p=>draws.push(p);
  ${helpers}
  if(geo&&station)placeDesk();
  ${readyHook}
  return {state:()=>({seat,deskFace,blocked,geo,bakeDirty,redraws}),
   direct:()=>{const p=deskPropFor(agent.id);return p&&deskSeat(p);},
   chair:()=>{const s=deskSeat(deskPropFor(agent.id));drawSeatChair(s.tx,s.ty,s.cx,s.cy,s.face);return draws.pop();},
   refresh:refreshWorkstationSeats};`)
  (unloaded?null:station,unloaded?null:geo,hero,[crew],textures,ps,PA,draws);
 return {runtime,hero,crew,station,geo,finish:async()=>{finish();await textures.ready;await Promise.resolve();},derivations:()=>derivations};
}
async function main(){
 for(const sitting of [false,true]){
  const t=setup({sitting}),before=t.runtime.state(),originalDoc=t.station.serialize();
  const heroXY=[t.hero.px,t.hero.py],crewJson=JSON.stringify(t.crew),oldPath=t.hero.pathPts;
  A.eq(before.seat.face,'north','loading uses the native south-front chair');
  A.eq([t.runtime.chair().x,t.runtime.chair().y],[before.seat.cx,before.seat.ty],'pending generated chair uses the same native seat');
  await t.finish();
  const after=t.runtime.state(),direct=t.runtime.direct(),chair=t.runtime.chair();
  A.eq(['tx','ty','cx','cy','face'].map(k=>after.seat[k]),['tx','ty','cx','cy','face'].map(k=>direct[k]),'texture activation refreshes cached hero seat to the current authored front');
  A.eq([after.deskFace,after.seat.face,chair.r],['west','west',1],'saved east-side front and generated chair agree after loading');
  A.eq([chair.x,chair.y],[after.seat.cx,after.seat.cy],'generated chair uses the same fractional side centre');
  A.eq([t.hero.px,t.hero.py],heroXY,'ready callback never teleports the '+(sitting?'seated':'walking')+' hero');
  A.eq([t.hero.target,t.hero.pathPts,t.hero.sitting,t.hero.workRetryAt],[null,null,false,0],'changed workstation seat permits existing work loop to replan');
  A.eq([t.hero.goal,t.hero.working],['work',true],'real work state survives the seating refresh');
  A.ok(oldPath!==t.hero.pathPts,'old-front trip is invalidated');
  A.eq(JSON.stringify(t.crew),crewJson,'crew retains its position and in-flight route');
  A.eq([...after.blocked],[...before.blocked],'workstation blocking footprint does not change on readiness');
  A.ok(after.geo===before.geo,'ready callback keeps the same geometry projection');
  A.eq(t.derivations(),0,'ready callback never rederives geometry');
  A.eq(t.station.serialize(),originalDoc,'saved placement, facing and proportions remain unchanged');
  A.eq([after.bakeDirty,after.redraws],[true,1],'ready art requests one bake and redraw');
  const stablePath=[{x:2,y:2}];t.hero.pathPts=stablePath;t.hero.target={x:30,y:35};t.hero.sitting=true;
  t.runtime.refresh();A.ok(t.hero.pathPts===stablePath&&t.hero.sitting,'repeated refresh with unchanged seat preserves the current trip/pose');
 }
 for(const goal of [null,'use','fetch','lounge']){
  const t=setup({goal}),body=JSON.stringify(t.hero),route=t.hero.pathPts;await t.finish();
  A.eq(t.runtime.state().seat.face,'west','cached home updates during '+goal);
  A.eq(JSON.stringify(t.hero),body,'texture readiness preserves all '+goal+' body state');
  A.ok(t.hero.pathPts===route,'texture readiness preserves '+goal+' route identity');
 }
 const stable=setup({r:0,sitting:true}),body=JSON.stringify(stable.hero),route=stable.hero.pathPts;await stable.finish();
 A.eq(JSON.stringify(stable.hero),body,'unchanged front never disturbs an active sitter');
 A.ok(stable.hero.pathPts===route,'unchanged front retains the original route');
 const failed=setup({failed:true}),native=failed.runtime.state(),failedBody=JSON.stringify(failed.hero);await failed.finish();
 A.ok(failed.runtime.state().seat===native.seat,'failed/native pack retains cached native seat');
 A.eq(JSON.stringify(failed.hero),failedBody,'failed pack leaves the current activity untouched');
 A.eq([failed.runtime.state().bakeDirty,failed.runtime.state().redraws],[false,0],'failed pack does not activate a remaster redraw');
 const early=setup({unloaded:true});await early.finish();
 A.eq(early.runtime.state().seat,null,'readiness before station load is safe; later placeDesk owns initial seating');
 A.report('world-texture-ready');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
