// Real HTTP admission, attachment expansion, continued work, and durable receipts after restart.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {SidecarFixture}=require('./helpers/sidecar-fixture.js');
const {startProvider,environment}=require('./helpers/auto-steer-provider.js');
(async()=>{
 const provider=await startProvider(), fixture=SidecarFixture.create({prefix:'auto-steer-',timeoutMs:30000,env:environment(provider)});
 try {
  await fixture.start();
  await fixture.json('POST','/api/roster',{updatedAt:Date.now(),agents:[{agentId:'agent',name:'NOVA',provider:'openrouter',model:'test/auto-steer',approvalMode:'full'}]});
  const ref={id:'ref',path:'attachments/reference.txt',name:'reference.txt',mediaType:'text/plain',kind:'file'};
  fs.mkdirSync(path.join(fixture.workspace,'agent','attachments'),{recursive:true});
  fs.writeFileSync(path.join(fixture.workspace,'agent',ref.path),'reference evidence');
  const response=await fixture.request('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openrouter',key:'sk-or-v1-auto-steer-fixture',model:'test/auto-steer',agentId:'agent',streamId:'auto_steer_test',isTask:true,messages:[{role:'user',content:'Write AUTO_STEER_REPORT to auto-steer-report.md.'}]})});
  assert.equal(response.status,200);
  const events=[];let runId='';
  const reading=(async()=>{let buf='';for await(const bytes of response.body){buf+=Buffer.from(bytes).toString();let nl;while((nl=buf.indexOf('\n'))>=0){const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(!line.trim())continue;const ev=JSON.parse(line);events.push(ev);if(ev.name==='agent.run.start')runId=ev.payload.runId;}}})();
  await Promise.race([provider.waiting,new Promise((_,reject)=>setTimeout(()=>reject(Error('provider not reached')),20000).unref())]);
  assert(runId);
  const message={text:"How's it going?\nKeep working, and use this reference.",attachments:[ref]};
  const posted=await fixture.json('POST','/api/run/steer',{runId,noteId:'status_1',message});assert.equal(posted.status,200);assert.equal(posted.body.ok,true);
  const pending=await fixture.json('GET','/api/run/steer?runId='+runId);assert.equal(pending.body.notes.status_1,'pending');
  provider.release();await reading;
  assert(events.some(e=>e.name==='agent.token'&&e.payload.delta.includes('The outline is saved.')));
  assert(events.some(e=>e.name==='agent.run.end'&&e.payload.reason==='done'));
  const report=fs.readFileSync(path.join(fixture.workspace,'agent','auto-steer-report.md'),'utf8');assert(report.includes('Reference evidence incorporated.'));
  const got=provider.requests.find(r=>r.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes("How's it going?")));
  assert(got);assert(got.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('reference evidence')));
  const replay=await fixture.json('POST','/api/run/steer',{runId,noteId:'status_1',message});assert.equal(replay.body.applied,true,'lost acknowledgement after completion resolves to the original receipt');
  await fixture.restart();
  const saved=await fixture.json('GET','/api/run/steer?runId='+runId);assert.equal(saved.body.notes.status_1,'applied');assert.equal(saved.body.source,'record');
  console.log('auto-steer.e2e: PASS (same run answered status, wrote original report with attachment, receipt survived restart)');
 } finally {provider.release();await fixture.dispose();await provider.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
