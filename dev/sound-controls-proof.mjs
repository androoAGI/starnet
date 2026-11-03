import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';
const out='.worldshots/sound-controls'; mkdirSync(out,{recursive:true});
let proc,cdp; const checks=[];
try {
 ({proc}=launchChrome({cdpPort:9437,profileDir:out+'/profile'}));
 cdp=await connectCDP(9437); await cdp.send('Page.enable');
 const load=async()=>{
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:9327/'});
  for(let i=0;i<150;i++) { if(await evalJS(cdp,"typeof StationUI !== 'undefined' && typeof World !== 'undefined' && !!World.stationDoc()")) return; await sleep(200); }
  throw Error('app did not load');
 };
 const open=async()=>{
  await evalJS(cdp,"StationUI.openTerm('settings', 'appearance'); true");
  for(let i=0;i<80;i++) { if(await evalJS(cdp,"!!document.querySelector('#set-sound-hum')")) return; await sleep(150); }
  throw Error('sound settings did not open');
 };
 const toggle=async(id,on)=>{await evalJS(cdp,`(()=>{const e=document.querySelector('#${id}'); if(e.checked!==${on})e.click();return e.checked;})()`);};
 const state=()=>evalJS(cdp,"({master:SFX.on,hum:SFX._ambience.hum,heartbeat:SFX._ambience.heartbeat,controls:['set-sound','set-sound-hum','set-sound-heartbeat'].map(id=>({id,checked:document.getElementById(id).checked,bg:getComputedStyle(document.getElementById(id)).backgroundColor}))})");
 await load();await open();
 if(process.argv.includes('--restart')) {
  const saved=await state();assert.equal(saved.master,true);assert.equal(saved.hum,false);assert.equal(saved.heartbeat,false);
  console.log(JSON.stringify({test:'sidecar restart persistence',...saved}));
 }
 await toggle('set-sound',true);await toggle('set-sound-hum',true);await toggle('set-sound-heartbeat',true);
 await cdp.send('Runtime.evaluate',{expression:'SFX.boot(); SFX.ctx.resume()',userGesture:true,awaitPromise:true});
 await evalJS(cdp,"window.soundProbe=SFX.ctx.createAnalyser();soundProbe.fftSize=2048;SFX.master.connect(soundProbe);window.rms=()=>{const a=new Float32Array(soundProbe.fftSize);soundProbe.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length)};true");
 await sleep(1000);
 await evalJS(cdp,"SFX.env(110,{channel:'hum',attack:.01,hold:8,release:1,vol:.3});SFX.env(55,{channel:'heartbeat',attack:.01,hold:8,release:1,vol:.3});true");
 await sleep(300);const before=await evalJS(cdp,'rms()');assert.ok(before>.001,'ambience renders measurable audio');
 await toggle('set-sound-hum',false);await toggle('set-sound-heartbeat',false);await sleep(500);
 const silent=await evalJS(cdp,'rms()');assert.ok(silent<.00001,'live toggles silence existing sustained tones');
 // Exercise the real Director completion path with a synthetic done task (no provider work claimed).
 await evalJS(cdp,"U.bus.emit('task',{status:'done'});true");await sleep(70);
 const chime=await evalJS(cdp,'rms()');assert.ok(chime>.00001,'completion chime still renders audio');
 checks.push({test:'real Web Audio output',before,silent,chime});
 let s=await state();assert.equal(s.master,true);assert.equal(s.hum,false);assert.equal(s.heartbeat,false);
 for(const c of s.controls)assert.ok(!['rgb(255, 255, 255)','rgb(239, 239, 239)'].includes(c.bg));
 checks.push({test:'live controls and theme',...s});
 await load();await open();s=await state();assert.equal(s.master,true);assert.equal(s.hum,false);assert.equal(s.heartbeat,false);
 checks.push({test:'reload persistence',...s});
 await toggle('set-sound-heartbeat',true);s=await state();assert.equal(s.hum,false);assert.equal(s.heartbeat,true);
 await toggle('set-sound',false);assert.equal((await state()).master,false);
 await toggle('set-sound',true);s=await state();assert.equal(s.hum,false);assert.equal(s.heartbeat,true);
 await toggle('set-sound-heartbeat',false);
 checks.push({test:'independent toggles and master restoration',...s});
 writeFileSync(out+'/proof.json',JSON.stringify({checks,acousticListening:false},null,2));console.log(JSON.stringify(checks));
} finally { if(cdp){await cdp.send('Browser.close').catch(()=>{});cdp.ws.close();}proc?.kill(); }
