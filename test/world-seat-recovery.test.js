'use strict';
const fs=require('fs'),path=require('path'),A=require('./_assert');
const src=fs.readFileSync(process.env.WORLD_TEST_SOURCE || path.join(__dirname,'../frontend/app/world.js'),'utf8');
const fn=name=>A.fnBody(src,'function '+name+'(');
const WM=require('../frontend/app/worldmodel');
const footOf=(x,y)=>({x:x*12+6,y:y*12+11}),tileOf=(x,y)=>({x:Math.floor(x/12),y:Math.floor(y/12)});
function runtime(g){return Function('geo','blocked','footOf','tileOf',`
const T=12, CORNER_LOOK=2.5, movementBlockers=(b,v)=>v, beltUnion=()=>blocked, tileBlockedFor=(v,x,y)=>v.has(x+','+y);
const stepGait=(b,dx,dy,d,sp,last,dt)=>Math.min(d,sp*dt/1000);
${['seatFoot','startBodyPath','canRoundCorner','crewNextWaypoint','stepCrewToSeat'].map(fn).join('\n')}
return stepCrewToSeat;`)(g,new Set(),footOf,tileOf);}
const st=WM.create();st.addRoom({kind:'lab',rect:{x1:24,y1:0,x2:36,y2:12}});let g=st.projectGeometry(),step=runtime(g);
let b={px:90,py:95,working:true},seat={tx:32,ty:8,cx:31.5,face:'north'};
A.eq(g.path(7,7,32,8,null),null,'fixture desk is unreachable');
step(b,seat,16,0);A.eq([b.px,b.py],[90,95],'unreachable worker stays in place');A.eq(b.sitting,false,'unreachable worker does not sit in empty space');A.eq(b.working,true,'real work stays active while route is unavailable');
st.placeHallway({rect:{x1:18,y1:3,x2:23,y2:4}});g=st.projectGeometry();step=runtime(g);
let maxJump=0;for(let n=0;n<5000&&!b.sitting;n++){const x=b.px,y=b.py;step(b,seat,16,1000+n*16);maxJump=Math.max(maxJump,Math.hypot(b.px-x,b.py-y));}
A.ok(b.sitting,'worker recovers when a hallway opens');A.ok(maxJump<1.2,'recovered trip walks rather than teleports');A.eq([b.px,b.py],[384,107],'even-width desk uses centred foot');
for(const face of ['north','south','east','west']){const s={tx:8,ty:9,face};const c={px:102,py:119};step(c,s,16,10000);A.eq(c.dir,face,'desk arrival faces '+face);}
const same={px:102,py:119};step(same,{tx:8,ty:9,cx:7.5,face:'east'},16,10000);A.ok(Math.abs(same.px-102)<1,'same-tile centring does not jump six pixels');
let reachable=false,arrived=0;const hero={px:90,py:95};
const go=Function('agent','seat','setPathTo','arrive','deskFace',fn('goToSeat')+';return goToSeat;')(hero,seat,()=>reachable,()=>arrived++,'north');
go(1000);A.eq([hero.px,hero.py],[90,95],'hero cannot teleport to an unreachable desk');A.eq(hero.sitting,false,'hero stands while route is blocked');A.eq(hero.working,true,'hero work indicator remains truthful');reachable=true;go(2000);A.eq(arrived,1,'hero already-at-seat arrival still settles');
if(src.includes('function invalidateRefitLeisure(')){
 const occupiedSeats=new Set(['p1:0']);const reset=Function('occupiedSeats','setTalking',`let chaseId=null;${fn('seizeFromIdle')}\n${fn('invalidateRefitLeisure')}\nreturn invalidateRefitLeisure;`)(occupiedSeats,()=>{});
 const prop={id:'p1',t:'couch',x:8,y:5,w:3,h:1},before={origin:{tx:-3,ty:-3},props:[prop]};
 const body=()=>({seatKey:'p1:0',seated:true,sitting:true,usingProp:'p1',goal:'use',pendSeat:{px:100,py:100},working:false});
 const c=body();reset(c,before,{...before,props:[]});A.eq([c.seated,c.sitting,c.usingProp,c.seatKey,c.pendSeat],[false,false,null,null,null],'deleted furniture releases pose, reference and reservation');A.eq(occupiedSeats.size,0,'deleted seat releases shared occupancy');
 const keep=body();reset(keep,before,{origin:{tx:-8,ty:-7},props:[{...prop,x:13,y:9}]});A.eq(keep.seated,true,'unchanged couch survives station-origin shift');
 const moved=body();reset(moved,before,{...before,props:[{...prop,x:9}]});A.eq(moved.seated,false,'moving couch releases stale cushion');
 const rotated=body();reset(rotated,before,{...before,props:[{...prop,r:1}]});A.eq(rotated.seated,false,'rotating couch releases old seat anchor');
 const trip={...body(),seated:false,target:{x:90,y:90}};reset(trip,before,before);A.eq(trip.goal,null,'interrupted trip releases goal so crew can replan');
 const worker={working:true,goal:null,sitting:true};reset(worker,before,{...before,props:[]});A.eq(worker.working,true,'furniture cleanup preserves unrelated work');
}else A.ok(false,'refit invalidation exists');
/* Remastered workstation art, approach, fractional seating and save coordinates agree. */
{
 const PA=require('../frontend/app/propanchor');
 const helper=['seatCx','seatCy','deskSeat','seatFoot'].map(fn).join('\n');
 const seats=(clean,walkable=()=>true,facings=()=>[0,1,2,3])=>Function('PropAnchor','geo','IndustrialTextures','PropSprites',
  'const T=12,blocked=new Set();'+helper+';return {deskSeat,seatFoot};')(PA,{walkable},{isRemaster:()=>clean},{facings});
 const rt=seats(true);
 const expected=[['north',6,6],['east',4,6],['south',6,4],['west',6,6]];
 for(let r=0;r<4;r++){
  const prop={t:'desk',id:'desk',x:5,y:5,w:r%2?1:3,h:r%2?3:1,r};
  const a=rt.deskSeat(prop),e=expected[r];
  A.eq([a.face,a.tx,a.ty],e,'remastered desk r='+r+' approaches its authored front');
  A.eq(a.cx,a.tx,'odd-sized desk r='+r+' keeps a centred horizontal anchor');
  if(r%2)A.eq(a.cy,6,'side-facing three-tile desk centres its chair along depth');
 }
 const side={t:'desk2',x:5,y:5,w:1,h:2,r:3};
 const centred=rt.deskSeat(side);
 A.eq([centred.tx,centred.ty,centred.cx,centred.cy],[6,6,6,5.5],'even-depth side desk keeps a walkable whole tile and fractional chair centre');
 A.eq(rt.seatFoot(centred),{x:78,y:77},'body foot shares the chair fractional y anchor');
 const offcentre=seats(true,(x,y)=>x===6&&y===5).deskSeat({...side,h:4});
 A.eq(offcentre.cy,5,'blocked central approach never pulls a chair away from its reachable edge tile');
 for(const clean of [false,true]){
  const legacy=seats(clean,()=>true,()=>[0]).deskSeat(side);
  A.eq([legacy.tx,legacy.ty,legacy.face,legacy.cy],[5,7,'north',undefined],(clean?'unavailable view':'classic mode')+' ignores an unsupported saved remaster rotation');
 }
 A.eq(seats(true,()=>true,()=>[0,1,2,3]).deskSeat({...side,t:'console'}).face,'north','other functional workstations retain their existing south-front approach');
 A.eq(seats(true,()=>false).deskSeat(side),null,'a sealed-in workstation invents no chair');
 const heroSeat=Function('PropAnchor','geo','IndustrialTextures','PropSprites','home',
  'const T=12,agent={id:"agent"},deskPropFor=()=>home;let blocked,desk,seat,deskPropId,deskFace;'+helper+'\n'+fn('placeDesk')+';placeDesk();return {seat,deskFace};')
  (PA,{walkable:()=>true},{isRemaster:()=>true},{facings:()=>[0,1,2,3]},side);
 A.eq([heroSeat.seat.cy,heroSeat.deskFace],[5.5,'west'],'hero desk adoption preserves fractional y and assigned facing');
 const newBody={px:78,py:83};let largestStep=0;
 for(let i=0;i<200&&!newBody.sitting;i++){const y=newBody.py;step(newBody,centred,16,20000+i*16);largestStep=Math.max(largestStep,Math.abs(newBody.py-y));}
 A.eq([newBody.px,newBody.py,newBody.dir],[78,77,'west'],'crew settles onto the same side chair centre and facing');
 A.ok(newBody.sitting&&largestStep<1.1,'fractional side centring walks smoothly without a half-tile jump');
 const chairDraw=(clean,face)=>{
  let painted=null;const ps={has:()=>true,setCtx:()=>{},setNow:()=>{}};
  const draw=Function('PropSprites','IndustrialTextures','ctx','now','drawLitProp',fn('drawSeatChair')+';return drawSeatChair;')
   (ps,{isRemaster:()=>clean},{},0,p=>painted=p);
  draw(6,6,6,5.5,face);return painted;
 };
 for(const [face,r] of [['south',0],['west',1],['north',2],['east',3]]){
  const p=chairDraw(true,face);A.eq([p.x,p.y,p.r],[6,5.5,r],'remastered generated chair faces '+face+' on its actual centre');
 }
 A.eq(chairDraw(false,'west').r,undefined,'classic generated chair art remains unturned');
 // An in-memory round trip exercises the real save boundary without touching a user save.
 const st=WM.create(),added=st.addProp({...side,x:5,y:3,agentId:'agent'});
 A.ok(added.ok,'turned assigned desk is valid model geometry');
 const store=require('../sidecar/station-store').makeStationStore();
 A.ok(store.setSaveDoc({station:st.serialize()}).ok,'station save accepts the turned workstation');
 const restored=WM.deserialize(store.getStation()).projectGeometry().props.find(p=>p.id===added.id);
 A.eq([restored.r,restored.w,restored.h,restored.agentId],[3,1,2,'agent'],'facing, effective footprint and assignment survive the real station save/model seam');
}
/* A doorway re-enters entity depth order using its detailed art when available. */
{
 const start=src.lastIndexOf('for (const d of cache.doorOccluders || [])');
 const end=src.indexOf('// THE FLOOR PASS',start),block=src.slice(start,end);
 const draw=(pack)=>{
  let fallback=0,detailed=0,coords=null;const ctx={drawImage:(...a)=>{fallback++;coords=a;}};
  const p=pack==null?undefined:{drawBase:(...a)=>{detailed++;coords=a.slice(1);return pack;}};
  const d={image:'door-image',x:10,y:12,w:20,h:20,sortY:27};
  const items=Function('ctx','IndustrialTextures','cache', 'const items=[],scale=1,panX=0,panY=0,cv={width:100,height:100};'+fn('drawDoorSurface')+'\n'+block+';return items;')(ctx,p,{doorOccluders:[d]});
  items[0].draw();return {fallback,detailed,coords,sortY:items[0].y};
 };
 A.eq(draw(true),{fallback:0,detailed:1,coords:['door-image',10,12],sortY:27},'detailed doorway uses the same image anchor and y-sort key');
 A.eq(draw(false).fallback,1,'missing detail plate falls back to the original doorway canvas');
 A.eq(draw(null).fallback,1,'classic doorway draw remains available without a texture module');
}
// An authored sofa perch changes only the displayed sitter height, never floor/sort contact.
{
 const run=remaster=>Function('PropRemaster','geo',`
 const self={},T=12,U={irnd:()=>0},occupiedSeats=new Set(),blocked=new Set(),SEAT_NB=[[0,1]],sideSeat=()=>null;
 const releaseSeat=()=>{},tileInZone=()=>true,setPathTo=()=>{self.target={};return true;},arrive=()=>{};
 ${fn('planCouchSit')}
 const p={id:'c',t:'couch',x:4,y:5,w:5,h:1};planCouchSit(0,p,null,'north',{});return self;
 `)(remaster,{walkable:()=>true});
 const native=run({enabled:()=>false}),authored=run({enabled:()=>true,viewGeometry:()=>({spec:{seatLift:6}})});
 A.eq(authored.pendSeat.py,native.pendSeat.py,'authored couch retains its floor/sort anchor');
 A.eq(authored.pendSeat.px,native.pendSeat.px,'authored couch retains its cushion claim');
 A.eq(authored.pendSeat.lift,6,'authored cushion lifts the sitter above the taller back');
 A.eq(native.pendSeat.lift,0,'classic couch retains its original perch');
}
A.report('world-seat-recovery');
