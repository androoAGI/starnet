import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../lib/seed.mjs';
import { launchChrome, connectCDP, evalJS, sleep, capture } from '../lib/cdp.mjs';
import { openSel, closeOnly, dismissRefitGuide } from '../lib/states.mjs';
const out = resolve('.dogfood/release-0112-pointer/crowded-closeout');
mkdirSync(out, { recursive: true });
const source = readFileSync('frontend/app/world.js', 'utf8');
const signature = 'function glanceAt(self_, otherBody, dur, now) {';
if (source.split(signature).length !== 2) throw Error('glance seam changed');
const wrapper = `
  const gazeProof = { calls: 0, violations: [], forced: 0 };
  const movementProof = () => JSON.stringify(allBodies().map(b => ({id:b.id,px:b.px,py:b.py,target:b.target,path:b.pathPts,pathIdx:b.pathIdx,goal:b.goal,state:b.state})));
  function glanceAt(self_, otherBody, dur, now) {
    const before = movementProof();
    const result = originalGlanceAt(self_, otherBody, dur, now);
    gazeProof.calls++;
    if (before !== movementProof()) gazeProof.violations.push({observer:self_?.id,other:otherBody?.id});
    return result;
  }
  window.__RELEASE_GAZE_PROOF__ = {
    read: () => JSON.parse(JSON.stringify(gazeProof)),
    exercise: () => {
      const list = allBodies().filter(b => !b.unplaced);
      for (const a of list) for (const b of list) if (a !== b) { glanceAt(a,b,800,performance.now()); gazeProof.forced++; }
      return JSON.parse(JSON.stringify(gazeProof));
    },
    negativeControl: () => {
      const [a,b] = allBodies().filter(b => !b.unplaced);
      const original = originalGlanceAt, px = a.px, before = movementProof(), count = gazeProof.violations.length;
      try {
        originalGlanceAt = (...args) => { original(...args); args[0].px += 1; };
        glanceAt(a,b,800,performance.now());
      } finally { originalGlanceAt = original; a.px = px; }
      return {detected:gazeProof.violations.length === count+1, movementRestored:before === movementProof()};
    }
  };
  function originalGlanceAt(self_, otherBody, dur, now) {`;
const instrumented = source.replace(signature, wrapper);
const report = { ranAt:new Date().toISOString(), sourceSha256:createHash('sha256').update(source).digest('hex'), instrumentation:'Read movement state immediately before/after original glanceAt; preserve original function and arguments.', samples:[], crossings:[], errors:[] };
let side, chrome, cdp;
try {
  const scratch = materializeSeedWorkspace(join(out,'workspace'));
  side = bootSeededSidecar({port:18984,scratchDir:scratch,key:'release-local-no-provider',env:{SKYNET_QUEST_REFRESH:'0',SKYNET_SCOUT:'0',SKYNET_OPENROUTER_BASE:'http://127.0.0.1:1'}});
  if (!await waitUp('http://127.0.0.1:18984/')) throw Error('sidecar boot failed');
  chrome = launchChrome({cdpPort:19384,profileDir:join(out,'profile')}).proc;
  cdp = await connectCDP(19384);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/app/world.js*',requestStage:'Request'}]});
  cdp.on('Fetch.requestPaused', p => { cdp.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/javascript'}],body:Buffer.from(instrumented).toString('base64')}).catch(e=>report.errors.push(e.message)); });
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:18984/'});
  if (!await waitDevReady(cdp,evalJS,{url:'http://127.0.0.1:18984/'})) throw Error('floor not ready');
  await evalJS(cdp,dismissRefitGuide);
  await evalJS(cdp,closeOnly);
  for (let i=0;i<19;i++) {
    await evalJS(cdp,openSel('#bb-recruit','RECRUIT'));
    let recruited = false;
    for (let attempt=0;attempt<20;attempt++) {
      recruited = await evalJS(cdp,"(() => {const b=document.querySelector('.mkt-cta-main.mkt-deploy');if(!b)return false;b.click();return true;})()");
      if(recruited)break;
      await sleep(200);
    }
    if(!recruited)throw Error('recruit button unavailable');
    await sleep(350);
  }
  await evalJS(cdp,closeOnly);
  report.initial = await evalJS(cdp,'window.__SKYNET_TEST__.bodies()');
  if(report.initial.length!==20)throw Error('expected 20 bodies, got '+report.initial.length);
  console.log('20-body floor ready; sampling natural movement and glances');
  for(let i=0;i<180;i++) {
    const bodies=await evalJS(cdp,'window.__SKYNET_TEST__.bodies()');
    const occupied=new Set(bodies.map(b=>`${b.tile.x},${b.tile.y}`));
    const crossings=bodies.filter(b=>b.moving&&b.target&&occupied.has(`${b.target.tile.x},${b.target.tile.y}`)&&`${b.target.tile.x},${b.target.tile.y}`!==`${b.tile.x},${b.tile.y}`);
    report.samples.push({at:Date.now(),bodies});
    if(crossings.length)report.crossings.push({sample:i,bodies:crossings});
    await sleep(500);
  }
  report.naturalGazes=await evalJS(cdp,'window.__RELEASE_GAZE_PROOF__.read()');
  report.exercisedGazes=await evalJS(cdp,'window.__RELEASE_GAZE_PROOF__.exercise()');
  report.negativeControl=await evalJS(cdp,'window.__RELEASE_GAZE_PROOF__.negativeControl()');
  report.containmentViolations=report.samples.flatMap(s=>s.bodies.filter(b=>b.zone&&b.inOwnZone===false));
  report.pass=report.errors.length===0&&report.containmentViolations.length===0&&report.exercisedGazes.violations.length===0&&report.exercisedGazes.forced===380&&report.negativeControl.detected&&report.negativeControl.movementRestored;
  await capture(cdp,out,'crowded-floor');
  console.log(JSON.stringify({pass:report.pass,bodies:20,samples:report.samples.length,occupiedWaypointSnapshots:report.crossings.length,naturalGazes:report.naturalGazes,exercisedGazes:report.exercisedGazes,negativeControl:report.negativeControl,containmentViolations:report.containmentViolations.length}));
  if(!report.pass)process.exitCode=1;
} catch(e) {report.errors.push(e.stack);process.exitCode=1;console.error(e.stack);}
finally {writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));try{cdp?.ws.close();}catch{}chrome?.kill();side?.kill();}
