'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {SidecarFixture}=require('./helpers/sidecar-fixture.js');
test('real file approvals show entire edits and patches; deny leaves bytes unchanged; approve survives restart',async()=>{
 let steps=[];
 const server=http.createServer(async(req,res)=>{
  if(req.url.includes('/models')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'fixture/model',context_length:32000,supported_parameters:['tools'],pricing:{prompt:'0',completion:'0'}}]}));}
  let raw='';for await(const d of req)raw+=d;const body=JSON.parse(raw||'{}');
  const n=(body.messages||[]).filter(m=>m.role==='tool').length, step=steps[n];
  res.setHeader('Content-Type','text/event-stream');
  const delta=step?{tool_calls:[{index:0,id:'call_'+n,type:'function',function:{name:step.name,arguments:JSON.stringify(step.args)}}]}:{content:'Completed requested operation.'};
  res.write('data: '+JSON.stringify({choices:[{delta}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:step?'tool_calls':'stop'}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}})+'\n\n');res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const fixture=SidecarFixture.create({prefix:'starnet-payload-',timeoutMs:20000,env:{SKYNET_FULL_ACCESS:'0',STARNET_FULL_ACCESS:'0',SKYNET_OPENROUTER_BASE:base,STARNET_OPENROUTER_BASE:base,SKYNET_OPENROUTER_KEY:'fixture-key',STARNET_OPENROUTER_KEY:'fixture-key'}});
 const target=path.join(fixture.workspace,'agent','sample.txt');
 async function run(toolSteps,decision){
  steps=[{name:'brief_proceed',args:{objective:'Perform the controlled operation.'}},...toolSteps];
  const response=await fixture.request('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId:'agent',provider:'openrouter',model:'fixture/model',isTask:true,messages:[{role:'user',content:'Perform the controlled operation.'}],placed:[{objectType:'computer'},{objectType:'cabinet'}]})});
  assert.equal(response.status,200);let buf='',runId='',prompts=[],events=[];
  for await(const chunk of response.body){buf+=Buffer.from(chunk).toString();let idx;while((idx=buf.indexOf('\n'))>=0){let ev;try{ev=JSON.parse(buf.slice(0,idx));}catch{}buf=buf.slice(idx+1);if(!ev)continue;events.push(ev);
   if(ev.name==='agent.run.start')runId=ev.payload.runId;
   if(ev.name==='permission.prompt'){prompts.push(ev.payload);await fixture.json('POST','/api/consent',{runId,promptId:ev.payload.promptId,decision});}
  }}
  assert.ok(events.some(e=>e.name==='agent.run.end'),'terminal run event');return prompts;
 }
 try{
  await fixture.start();
  await fixture.json('POST','/api/roster',{updatedAt:Date.now(),agents:[{agentId:'agent',name:'NOVA',provider:'openrouter',model:'fixture/model',executionProfile:'trusted-project',approvalMode:'ask'}]});
  const initial='original\n'+'a'.repeat(6000)+'\n';
  const write={name:'fs_write',args:{path:'sample.txt',content:initial}};
  let prompts=await run([write],'once');assert.equal(prompts.length,1);assert.deepEqual(JSON.parse(prompts[0].argsSummary),write.args);assert.equal(fs.readFileSync(target,'utf8'),initial);
  const edit={name:'fs_edit',args:{path:'sample.txt',find:'a'.repeat(6000),replace:'b'.repeat(6000)}};
  prompts=await run([{name:'fs_read',args:{path:'sample.txt'}},edit],'deny');assert.deepEqual(JSON.parse(prompts.at(-1).argsSummary),edit.args);assert.equal(fs.readFileSync(target,'utf8'),initial);
  prompts=await run([{name:'fs_read',args:{path:'sample.txt'}},edit],'once');assert.deepEqual(JSON.parse(prompts.at(-1).argsSummary),edit.args);assert.equal(fs.readFileSync(target,'utf8'),initial.replace('a'.repeat(6000),'b'.repeat(6000)));
  const patch={name:'fs_patch',args:{patch:'*** Begin Patch\n*** Add File: patch.txt\n+'+'tail'.repeat(2000)+'\n*** End Patch'}};
  prompts=await run([patch],'deny');assert.deepEqual(JSON.parse(prompts.at(-1).argsSummary),patch.args);assert.equal(fs.existsSync(path.join(fixture.workspace,'agent','patch.txt')),false);
  await fixture.stop();await fixture.start();assert.equal(fs.readFileSync(target,'utf8'),initial.replace('a'.repeat(6000),'b'.repeat(6000)));
 }finally{await fixture.dispose();await new Promise(r=>server.close(r));}
});
