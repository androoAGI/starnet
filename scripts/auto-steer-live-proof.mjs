// Optional attended-surface proof: dev-seeded station + real COMMS + local scripted provider.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {launchChrome,connectCDP,evalJS,sleep,collectDiagnostics} from './lib/cdp.mjs';
const require=createRequire(import.meta.url);
const {SidecarFixture}=require('../test/helpers/sidecar-fixture.js');
const {allocatePort}=require('../test/helpers/ports.js');
const {startProvider,environment}=require('../test/helpers/auto-steer-provider.js');
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'qa/evidence/auto-steer-1103');mkdirSync(out,{recursive:true});
const provider=await startProvider();
const fixture=SidecarFixture.create({prefix:'auto-steer-live-',entry:path.join(root,'dev/seed.js'),timeoutMs:45000,env:environment(provider)});
fixture.args=['--keep','--workspace',fixture.workspace];
let chrome,cdp;
const waitFor=async(expression,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await evalJS(cdp,expression);if(value)return value;await sleep(150);}throw Error('Timed out: '+expression);};
const kill=pid=>{if(!pid)return;try{if(process.platform==='win32')execFileSync('taskkill',['/pid',String(pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else process.kill(pid);}catch{}};
try{
 await fixture.start();
 const cdpPort=await allocatePort();chrome=launchChrome({cdpPort,profileDir:path.join(fixture.profile,'chrome')});cdp=await connectCDP(cdpPort);
 await cdp.send('Runtime.enable'); await cdp.send('Page.enable');const diagnostics=collectDiagnostics(cdp);
 await cdp.send('Page.navigate',{url:fixture.baseUrl});
 await waitFor("typeof Chat !== 'undefined' && typeof App !== 'undefined' && document.querySelector('#chat-input') && document.body.innerText.includes('What would you like to work on?')",20000).catch(async()=>{
   console.log('BOOT STATE',await evalJS(cdp,"JSON.stringify({body:document.body.className,text:document.body.innerText.slice(-3000),app:typeof App,chat:typeof Chat})"));
   throw Error('Station did not auto-enter');
 });
 console.log('Live station entered');
 await evalJS(cdp,"window.__autoSteerEvents=[]; for(const n of ['agent.run.start','agent.run.end','agent.token','agent.tool_call','agent.tool_result']) U.bus.on(n,p=>window.__autoSteerEvents.push({name:n,payload:p}));").catch(async()=>{
   // load is normally already done by the seeded boot; only a station window needs opening.
   await evalJS(cdp,"document.querySelector('#chat-input').focus()");
 });
 await evalJS(cdp,"document.querySelector('#chat-input').value='Write AUTO_STEER_REPORT to auto-steer-report.md.'; document.querySelector('#chat-send').click();");
 await Promise.race([provider.waiting,sleep(30000).then(()=>{throw Error('Task did not reach held provider step');})]);
 const run=await waitFor("window.__autoSteerEvents.find(e=>e.name==='agent.run.start')?.payload.runId");
 await evalJS(cdp,"document.querySelector('#chat-input').value=\"How's it going?\"; document.querySelector('#chat-send').click();");
 await waitFor("document.querySelector('#chat-queued')?.textContent.includes('received')");
 await evalJS(cdp,"const dt=new DataTransfer(); dt.items.add(new File(['reference evidence'],'reference.txt',{type:'text/plain'})); const file=document.querySelector('#chat-attach-input'); file.files=dt.files; file.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#chat-input').value='Use this reference.\\nKeep the original report objective.'; document.querySelector('#chat-send').click();");
 await waitFor("document.querySelectorAll('#chat-queued .queued-pill.sent').length===2 && Array.from(document.querySelectorAll('#chat-queued .queued-tag')).every(e=>e.textContent==='received')");
 const before=await evalJS(cdp,"({busy:Chat.isBusy(),buttons:document.querySelectorAll('.queued-now').length,received:document.querySelector('#chat-queued').innerText})");
 assert(before.busy);assert.equal(before.buttons,0);
 provider.release();
 await waitFor("window.__autoSteerEvents.some(e=>e.name==='agent.run.end') && !Chat.isBusy()",45000);
 const after=await evalJS(cdp,"({events:window.__autoSteerEvents,rows:Array.from(document.querySelectorAll('.steer-echo .body')).map(e=>e.textContent),log:document.querySelector('#chat-log')?.innerText||'',queued:document.querySelector('#chat-queued').innerText})");
 assert.equal(after.events.filter(e=>e.name==='agent.run.start').length,1,'all messages stayed in one run');
 assert(after.events.some(e=>e.name==='agent.token'&&e.payload.delta.includes('The outline is saved.')));
 assert(after.events.some(e=>e.name==='agent.run.end'&&e.payload.reason==='done'));
 const report=readFileSync(path.join(fixture.workspace,'agent','auto-steer-report.md'),'utf8');assert(report.includes('Reference evidence incorporated.'));
 const loaded=new Promise(resolve=>cdp.on('Page.loadEventFired',resolve));
 await cdp.send('Page.reload',{ignoreCache:true});
 await Promise.race([loaded,sleep(20000).then(()=>{throw Error('Reload did not load');})]);
 await waitFor("typeof Chat!=='undefined' && document.querySelectorAll('.steer-echo').length>=2",30000);
 const reloaded=await evalJS(cdp,"Array.from(document.querySelectorAll('.steer-echo .body')).map(e=>e.textContent)");
 console.log('RELOADED ROWS',JSON.stringify(reloaded));
 assert.equal(reloaded.filter(t=>t==="How's it going?").length,1);
 assert.equal(reloaded.filter(t=>t.includes('Use this reference.'+String.fromCharCode(10)+'Keep the original report objective.')).length,1);
 assert(!reloaded.some(t=>t.includes('@starnet-message-v1:')));
 const nextContext=await evalJS(cdp,"Chat.contextRef().messages");
 assert(nextContext.some(m=>m.role==='user'&&m.content==="How's it going?"));
 assert(nextContext.some(m=>m.role==='user'&&m.content.includes('Keep the original report objective.')));
 const receipt={provider:'local scripted fixture; no live model inference tested',runId:run,before,after:{runStarts:1,reason:'done',report,rows:after.rows},reloaded,exceptions:diagnostics.exceptions};
 writeFileSync(path.join(out,'live-proof.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log('AUTO-STEER LIVE PASS',JSON.stringify(receipt));
}catch(error){
 if(cdp)try{writeFileSync(path.join(out,'live-failure.json'),JSON.stringify({error:String(error),state:await evalJS(cdp,"({body:document.body.className,text:document.body.innerText.slice(-8000),events:window.__autoSteerEvents||[]})"),requestCount:provider.requests.length},null,2));}catch(e){console.error('failure receipt error',String(e));}
 throw error;
}finally{provider.release();if(cdp)try{cdp.ws.close();}catch{}kill(chrome?.proc?.pid);kill(fixture.child?.pid);await fixture.dispose();await provider.close();}
