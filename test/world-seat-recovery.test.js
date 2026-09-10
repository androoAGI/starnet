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
A.report('world-seat-recovery');
