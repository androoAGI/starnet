import {launchChrome,connectCDP,evalJS} from '../scripts/lib/cdp.mjs';
import {waitDevReady} from '../scripts/lib/seed.mjs';
import {writeFileSync} from 'node:fs';
const browser=launchChrome({cdpPort:9443,profileDir:'.worldshots/movement-chrome'}).proc;
const cdp=await connectCDP(9443);
try {
 await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Page.navigate',{url:'http://127.0.0.1:9241/'});
 await waitDevReady(cdp,evalJS,{url:'http://127.0.0.1:9241/',tries:24});
 console.log(await evalJS(cdp,`(()=>{window.motionBodies=new Map();const orig=SPRITES.drawBody;SPRITES.drawBody=function(c,b,...args){motionBodies.set(b.id,b);return orig.call(this,c,b,...args)};return World.bodies()})()`));
 await new Promise(r=>setTimeout(r,2000));
 console.log(await evalJS(cdp,`(()=>{const b=[...motionBodies.values()].find(b=>b.id===World.bodies().find(b=>b.hero).id);if(!b)throw Error('no hero'); b.goal=null;b.pathPts=null;b.target={x:b.px+32,y:b.py};b.pauseUntil=performance.now()+1200;b.pauseLook='back';b.pauseDir='west';b.dir='east';window.motionTrace=[];let n=0;const sample=()=>{motionTrace.push({dir:b.dir,x:b.px,y:b.py,state:b.state});if(++n<30)requestAnimationFrame(sample)};requestAnimationFrame(sample);return {id:b.id}})()`));
 await new Promise(r=>setTimeout(r,650));
 const trace=await evalJS(cdp,'motionTrace');writeFileSync('.worldshots/movement-after.json',JSON.stringify(trace,null,2));console.log(JSON.stringify(trace));if(trace.length<15||new Set(trace.map(r=>r.dir)).size!==1)throw Error('look-back flickers');
 console.log(await evalJS(cdp,`(()=>{const b=[...motionBodies.values()][0];b.goal='stare';b.pauseUntil=0;b.glance=null;b.pathPts=[{x:9,y:7},{x:12,y:7}];b.pathIdx=1;b.target={x:114,y:95};b.px=113;b.py=95;b.state='walk';b.spd=28;b.odoAt=performance.now();window.motionTrace=[];let n=0;const sample=()=>{motionTrace.push({x:b.px,y:b.py,dir:b.dir,target:b.target&&{...b.target}});if(++n<50)requestAnimationFrame(sample)};requestAnimationFrame(sample);return {start:b.px}})()`));
 await new Promise(r=>setTimeout(r,1000));const route=await evalJS(cdp,'motionTrace');writeFileSync('.worldshots/movement-route-after.json',JSON.stringify(route,null,2));if(route[0].x<=113)throw Error('handoff consumed a frame');console.log('PASS live held look-back and uninterrupted waypoint: '+JSON.stringify({samples:route.length,firstX:route[0].x,lastX:route.at(-1).x}));
}finally{cdp.ws.close();browser.kill();}
