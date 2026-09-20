'use strict';
const fs=require('node:fs');
const A=require('./_assert');
const WM=require('../frontend/app/worldmodel');
const src=fs.readFileSync(require('node:path').join(__dirname,'../frontend/app/world.js'),'utf8');
const traffic=src.slice(src.indexOf('  const trafficPlans ='),src.indexOf('  /* ---------- BODIES ARE SOLID'));
const separation=src.slice(src.indexOf('  const PERSONAL_TILES ='),src.indexOf('  /* ---------- crew movement helper'));
const gait=src.slice(src.indexOf('  const DIR_A ='),src.indexOf('  /* ================= furniture'));
const starts=src.slice(src.indexOf('  function startBodyPath('),src.indexOf('  function setPathTo('));
function fixture(width=2){
  const st=WM.create();
  st.addRoom({kind:'lab',rect:{x1:6,y1:20,x2:17,y2:32}});
  st.placeHallway({rect:{x1:10,y1:11,x2:9+width,y2:19}});
  const geo=st.projectGeometry(),bodies=[],blocked=new Set();let now=0,dropped=0;
  const tileOf=(x,y)=>({x:Math.floor(x/12),y:Math.floor(y/12)}),footOf=(x,y)=>geo.footPoint(x,y);
  const body=(x,y,tx,ty)=>{
    const p=footOf(x-geo.origin.tx,y-geo.origin.ty),end={x:tx-geo.origin.tx,y:ty-geo.origin.ty};
    const b={id:String(bodies.length),px:p.x,py:p.y,goal:'wander',working:false,state:'walk',dir:'south',target:null};
    bodies.push(b);runtime.startBodyPath(b,geo.path(x-geo.origin.tx,y-geo.origin.ty,end.x,end.y,blocked));next(b);return b;
  };
  function next(b){b.target=b.pathIdx<b.pathPts.length?footOf(b.pathPts[b.pathIdx].x,b.pathPts[b.pathIdx++].y):null;}
  const runtime=Function('geo','blocked','T','allBodies','footOf','tileOf','crewNextWaypoint','seizeFromIdle','U','performance','dirToward',
    'const agent=null,crew=allBodies();'+gait+starts+traffic+separation+';return {stepTraffic,separateBodies,startBodyPath,stepGait,finishGait,plans:trafficPlans};')(
    geo,blocked,12,()=>bodies,footOf,tileOf,next,b=>{b.goal=null;dropped++;},{irnd:()=>300},{now:()=>now},()=> 'north');
  const errors=[];
  function step(count=1){for(let i=0;i<count;i++){
    now+=16;
    for(const b of bodies){
      const x=b.px,y=b.py;
      if(!runtime.stepTraffic(b,16,now)&&b.target){
        const dx=b.target.x-b.px,dy=b.target.y-b.py,d=Math.hypot(dx,dy);
        if(d<.1)next(b);else{const s=runtime.stepGait(b,dx,dy,d,b.speed||28,b.pathIdx>=b.pathPts.length,16);b.px+=dx/d*s;b.py+=dy/d*s;b.state='walk';}
      }
      if(!geo.clearFootSegment(x,y,b.px,b.py,blocked))errors.push('wall');
    }
    runtime.separateBodies(now);for(const b of bodies)runtime.finishGait(b);
  }}
  return {body,step,runtime,geo,errors,bodies,get dropped(){return dropped;}};
}
for(const width of [1,2,3,4]){
  const f=fixture(width),a=f.body(10,15,10,23),b=f.body(10,19,10,7);
  f.step(1000);
  A.ok(a.py>b.py+100,`${width}-tile hall: opposing walkers pass and complete their routes`);
  A.eq(f.dropped,0,`${width}-tile hall: no destination abandoned by jam recovery`);
  A.eq(f.errors,[],`${width}-tile hall: every moving foot segment clears walls`);
}
{
  const f=fixture(),a=f.body(5,6,13,6),b=f.body(10,6,10,6);b.target=null;b.state='idle';
  f.step(700);A.ok(a.px>b.px+12,'standing roaming body steps aside for a passer');
  A.eq(f.dropped,0,'standing body does not make the passer abandon its goal');
}
{
  const f=fixture(),a=f.body(10,15,10,23),b=f.body(10,19,10,7);b.working=true;
  f.step(1000);A.ok(a.py>b.py+100,'workstation-bound traffic and roaming traffic both finish');
  A.eq(b.working,true,'right of way preserves working state');
}
{
  const f=fixture(),a=f.body(10,15,10,23),b=f.body(10,19,10,7);
  f.step(70);const plan=f.runtime.plans.get(a);A.ok(!!plan,'traffic notices the impending encounter');
  if(plan){plan.yielder.target=null;f.step();A.ok(f.runtime.plans.get(plan.yielder)!==plan&&f.runtime.plans.get(plan.passer)!==plan,'new command cancels both halves of the old agreement');}
}
{
  const f=fixture(4),a=f.body(10,14,10,25),b=f.body(10,19,10,7),c=f.body(11,12,11,25);
  f.step(1400);A.ok(!a.target&&!b.target&&!c.target,'three walkers clear a shared corridor');
  A.eq(f.errors,[],'crowded crossing preserves wall clearance');
}
{
  const f=fixture(),a=f.body(5,6,13,6),b=f.body(10,6,10,6);b.target=null;b.sitting=true;
  const start=[b.px,b.py];f.step(500);A.eq([b.px,b.py],start,'seated bodies retain their seat anchor');
  A.ok(!a.target&&a.px>b.px+12,'walker routes around an occupied seat');
}
for(const name of ['crewEngineStep','stepCrewToSeat','tick']){
  A.ok(A.fnBody(src,'function '+name+'(').includes('stepTraffic('),name+' uses the same right-of-way mechanism');
}
{
  const f=fixture(),a=f.body(5,6,15,6),b=f.body(7,6,15,7);a.speed=34;b.speed=14;
  let min=Infinity;for(let i=0;i<300;i++){f.step();min=Math.min(min,Math.hypot(a.px-b.px,a.py-b.py));}
  A.ok(min>=9.6,'faster follower preserves space behind a slower walker');
  A.eq(f.dropped,0,'following does not trigger jam abandonment');
}
A.report('hallway-traffic');
