// Run against an already booted, isolated seeded app or installed canary CDP target.
// Uses Appearance, Cinema, mouse drag and wheel input; never sends a provider task.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectCDP, evalJS, sleep } from '../lib/cdp.mjs';
const port = Number(process.argv[2] || 19463), out = resolve(process.argv[3] || '.dogfood/backdrop-performance/live');
mkdirSync(out, { recursive: true });
const c = await connectCDP(port), rows = [];
await c.send('Page.reload', { ignoreCache: true }); await sleep(3000);
await evalJS(c, `(()=>{
 window.__backdropProof={errors:[],frames:[],longTasks:[],sky:[],ground:[]};const p=window.__backdropProof;
 addEventListener('error',e=>p.errors.push(e.message));addEventListener('unhandledrejection',e=>p.errors.push(String(e.reason)));
 let last=performance.now();function tick(now){if(p.frames.length<50000)p.frames.push({at:now,ms:now-last});last=now;requestAnimationFrame(tick)}requestAnimationFrame(tick);
 new PerformanceObserver(list=>{for(const e of list.getEntries())p.longTasks.push({at:e.startTime,ms:e.duration})}).observe({type:'longtask'});
 for(const [api,key]of [[SpaceBG,'sky'],[Terrain,'ground']]){const original=api.draw;api.draw=function(...args){const t=performance.now();try{return original.apply(this,args)}finally{if(p[key].length<50000)p[key].push({at:t,ms:performance.now()-t})}}}
 if(!document.querySelector('#screen-game').classList.contains('cinema'))document.querySelector('.cam-cine').click();
 })()`);
await sleep(1000);
for (const id of ['nursery', 'city', 'ocean', 'belt', 'moon', 'forest']) {
  await evalJS(c, `StationUI.openTerm('settings','appearance')`); await sleep(500);
  const start = await evalJS(c, `(()=>{const b=document.querySelector('#set-backdrop [data-bd="${id}"]');if(!b)throw Error('Missing backdrop control');const t=performance.now();b.click();StationUI.closeTerm('settings');return t})()`);
  let ready = false;
  for (let i = 0; i < 240; i++) {
    ready = await evalJS(c, `(()=>{const s=${['moon','forest'].includes(id)?'Terrain':'SpaceBG'}._dbgBakeState();return s.ready&&s.id==='${id}'})()`);
    if (ready) break; await sleep(100);
  }
  if (!ready) throw Error('Scene did not finish: ' + id);
  await sleep(600);
  const box = await evalJS(c, `(()=>{const r=document.querySelector('#stage').getBoundingClientRect();return{x:r.x+r.width*.5,y:r.y+r.height*.55}})()`);
  const movingAt = await evalJS(c, 'performance.now()');
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
  for (let i=0; i<80; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x:box.x+Math.sin(i/12)*160, y:box.y+Math.cos(i/12)*70, button:'left', buttons:1 });
    await sleep(20);
  }
  await c.send('Input.dispatchMouseEvent', { type:'mouseReleased', ...box, button:'left', clickCount:1 });
  for (let i=0;i<36;i++) {
    await c.send('Input.dispatchMouseEvent', { type:'mouseWheel', ...box, deltaX:0, deltaY:i<18?35:-35 });await sleep(30);
  }
  await sleep(1500);
  const result = await evalJS(c, `(()=>{const p=window.__backdropProof,stats=(items,since)=>{const a=items.filter(x=>x.at>=since).map(x=>x.ms).sort((a,b)=>a-b);return{count:a.length,p50:a[Math.floor(a.length*.5)]||0,p95:a[Math.floor(a.length*.95)]||0,max:a.at(-1)||0}};return{
   id:'${id}',viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},stage:{width:document.querySelector('#stage').width,height:document.querySelector('#stage').height},
   switchAndMove:{frames:stats(p.frames,${start}),longTasks:stats(p.longTasks,${start})},moving:{frames:stats(p.frames,${movingAt}),sky:stats(p.sky,${movingAt}),ground:stats(p.ground,${movingAt}),longTasks:stats(p.longTasks,${movingAt})},
   camera:World.cameraDbg(),curve:World._dbgCurveState(),cache:World._dbgCanvasLoss(),workers:BackdropBake._dbgState(),sky:SpaceBG._dbgBakeState(),ground:Terrain._dbgBakeState(),errors:p.errors.slice()}})()`);
  if(result.errors.length || result.cache.blank || !result.curve.frameSum || result.workers.some(w=>w.failed)) throw Error('Render failure: '+JSON.stringify(result));
  const shot=await c.send('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(out,id+'.png'),Buffer.from(shot.data,'base64'));
  rows.push(result);writeFileSync(resolve(out,'receipt.json'),JSON.stringify({at:new Date().toISOString(),port,scope:'Live full Cinema UI: six Appearance selections, real mouse pans and wheel zoom, renderer submission and whole-app timing reported separately. Hardware performance and initial artwork wait are not equated with UI-thread blocking.',rows},null,2));
  console.log(JSON.stringify({id,moving:result.moving,workers:result.workers}));
}
process.exit(0);
