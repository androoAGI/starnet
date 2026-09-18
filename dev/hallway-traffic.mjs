// Reproduce the old head-on jam (--before), or verify the repaired steppers and
// normal animation loop on an isolated seeded station. No personal save is used.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {launchChrome,connectCDP,evalJS,capture,sleep} from '../scripts/lib/cdp.mjs';
import {materializeSeedWorkspace,bootSeededSidecar,waitUp,waitDevReady} from '../scripts/lib/seed.mjs';
const out=resolve('.dogfood/hallway');
const hook=`window.__hallwayProof = (width=2, natural=false) => {
  const st=WorldModel.create();
  st.addRoom({kind:'lab',rect:{x1:6,y1:20,x2:17,y2:32}});
  st.placeHallway({rect:{x1:10,y1:11,x2:9+width,y2:19}});
  loadStation(st); activity='idle'; awakeFrozen=false;chatFocusId=null;
  agent.skin='pikachu';
  const a=agent,b=makeCrewBody('traffic-fixture','PASSER','#ffffff',0,0,'astronaut');
  crew.splice(0,crew.length,b);
  const local=(x,y)=>({x:x-geo.origin.tx,y:y-geo.origin.ty});
  const starts=[local(10,15),local(10,19)],ends=[local(10,23),local(10,7)];
  [a,b].forEach((v,i)=>{seizeFromIdle(v);Object.assign(v,{...{px:footOf(starts[i].x,starts[i].y).x,py:footOf(starts[i].x,starts[i].y).y},target:null,pathPts:null,goal:'wander',state:'walk',sitting:false,seated:false,unplaced:false,pauseUntil:0,working:false,pers:{pace:1},idleUntil:1e12});startBodyPath(v,geo.path(starts[i].x,starts[i].y,ends[i].x,ends[i].y,blocked));crewNextWaypoint(v);});
  const destinations=ends.map(p=>footOf(p.x,p.y)),arrived=[false,false],abandoned=[false,false];
  const trace=[];let violations=0;let passed=false;
  const observe=()=>[a,b].forEach((v,i)=>{
    if(Math.hypot(v.px-destinations[i].x,v.py-destinations[i].y)<1.5)arrived[i]=true;
    if(!arrived[i]&&!v.target)abandoned[i]=true;
    if(arrived[i]||abandoned[i]){v.target=null;v.pathPts=null;v.goal='inspect';v.studyUntil=1e12;v.idleUntil=1e12;v.state='idle';}
  });
  if(natural)return new Promise(resolve=>{
    let frames=0;const started=performance.now(),previous=[a,b].map(v=>({x:v.px,y:v.py}));
    function sample(){
      frames++;[a,b].forEach((v,i)=>{if(!geo.clearFootSegment(previous[i].x,previous[i].y,v.px,v.py,blocked))violations++;previous[i]={x:v.px,y:v.py};});observe();
      if(a.py>b.py+24)passed=true;
      if(frames%30===0)trace.push([performance.now()-started,...[a,b].map(v=>({x:v.px,y:v.py,goal:v.goal}))]);
      if(arrived.every(Boolean)||abandoned.some(Boolean)||performance.now()-started>15000)resolve({width,natural,frames,elapsed:performance.now()-started,arrived,abandoned,violations,passed,trace});
      else requestAnimationFrame(sample);
    }requestAnimationFrame(sample);
  });
  for(let frame=0;frame<1200;frame++){
    const now=performance.now()+frame*16;fnow=now;
    for(const v of [a,b]){const x=v.px,y=v.py;self=v;crewEngineStep(16,now);if(!geo.clearFootSegment(x,y,v.px,v.py,blocked))violations++;}
    self=agent;separateBodies(now);for(const v of [a,b])finishGait(v);
    observe();if(a.py>b.py+24)passed=true; if(frame%30===0)trace.push([frame,...[a,b].map(v=>({x:v.px,y:v.py,target:v.target,goal:v.goal}))]);
    if(arrived.every(Boolean)||abandoned.some(Boolean))break;
  }
  return {width,violations,trace,passed,arrived,abandoned};
};`;
let side,chrome,cdp;const report={};
try{
 side=bootSeededSidecar({port:18987,scratchDir:materializeSeedWorkspace(resolve(out,'workspace')),key:'fixture-no-provider'});
 if(!await waitUp('http://127.0.0.1:18987/'))throw Error('boot failed');
 chrome=launchChrome({cdpPort:19387,profileDir:resolve(out,'profile-'+Date.now())}).proc;cdp=await connectCDP(19387);
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');
 const src=(process.argv.includes('--before')?execFileSync('git',['show','3ba5b8492:frontend/app/world.js'],{encoding:'utf8'}):readFileSync('frontend/app/world.js','utf8')).replace('  return {\n    init,', '  return {\n    init,');
 report.sourceSha256=createHash('sha256').update(src).digest('hex');
 const at=src.indexOf('    loadStation, spawn, spawnAgent');
 const ret=src.lastIndexOf('  return {',at);
 if(ret<0)throw Error('hook seam missing');
 const injected=src.slice(0,ret)+hook+'\n'+src.slice(ret);
 await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/app/world.js*',requestStage:'Request'}]});
 cdp.on('Fetch.requestPaused',p=>cdp.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/javascript'}],body:Buffer.from(injected).toString('base64')}));
 await cdp.send('Page.navigate',{url:'http://127.0.0.1:18987/'});
 if(!await waitDevReady(cdp,evalJS,{url:'http://127.0.0.1:18987/'}))throw Error('world not ready');
 report.results=[];
 for(const width of [1,2,4])report.results.push(await evalJS(cdp,'window.__hallwayProof('+width+')'));
 if(!process.argv.includes('--before')){
   [report.natural]=await Promise.all([evalJS(cdp,'window.__hallwayProof(2,true)'),(async()=>{await sleep(3500);await capture(cdp,out,'yielding');})()]);
   await capture(cdp,out,'completed');
 }
 report.canvas=await evalJS(cdp,"(()=>{const c=document.querySelector('#world');return c?{width:c.width,height:c.height}:Array.from(document.querySelectorAll('canvas')).map(c=>({width:c.width,height:c.height}));})()");
 report.pass=report.results.every(r=>r.arrived.every(Boolean)&&!r.abandoned.some(Boolean)&&r.violations===0)&&(!report.natural||(report.natural.arrived.every(Boolean)&&report.natural.violations===0));
 if(!process.argv.includes('--before')&&!report.pass)process.exitCode=1;
 console.log(JSON.stringify({pass:report.pass,results:report.results.map(({trace,...r})=>r),natural:report.natural&&(({trace,...r})=>r)(report.natural),canvas:report.canvas}));
}finally{writeFileSync(resolve(out,process.argv.includes('--before')?'before.json':'after.json'),JSON.stringify(report,null,2));cdp?.ws.close();chrome?.kill();side?.kill();}




