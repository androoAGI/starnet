'use strict';
const assert=require('node:assert/strict'),http=require('node:http');
const {makeOpenAiCompat}=require('../sidecar/openai-compat');
(async()=>{
 let calls=[],answer='prose';
 const api=makeOpenAiCompat({now:()=>1000,newId:()=> 'format',apiKey:()=> 'format-test-key-12345',readBody:async req=>{let s='';for await(const c of req)s+=c;return s;},runOnce:async o=>{
  calls.push(o);o.emit('agent.cost',{tokensIn:2,tokensOut:1});o.emit('agent.token',{delta:o.outputOnly ? answer : 'invalid initial prose'});o.emit('agent.run.end',{reason:'done'});
 }});
 const server=http.createServer((req,res)=>api.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=body=>fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer format-test-key-12345','Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Make JSON'}],...body})});
 try {
  answer='{"score":3}';let r=await post({response_format:{type:'json_schema',json_schema:{schema:{type:'object',properties:{score:{type:'integer',minimum:2}},required:['score']}}}});let j=await r.json();
  assert.equal(j.starnet.completed,true);assert.equal(j.choices[0].message.content,answer);assert.equal(j.usage.total_tokens,6);assert.equal(calls.length,2);assert.equal(calls[1].outputOnly,true);assert.equal(calls[1].reflect,false);assert.equal(calls[1].maxIters,1);assert.equal(calls[1].messages.at(-1).role,'user');
  answer='still prose';calls=[];j=await (await post({response_format:{type:'json_object'}})).json();assert.equal(j.starnet.completed,false);assert.equal(j.choices[0].finish_reason,'error');assert.equal(calls.length,2);assert.equal(j.usage.total_tokens,6);
  for(const body of [{response_format:{type:'unknown'}},{stream:true,response_format:{type:'json_object'}},{response_format:{type:'json_schema',json_schema:{schema:{$ref:'https://example.com'}}}}]){calls=[];r=await post(body);assert.equal(r.status,400);assert.equal(calls.length,0);}
  console.log('openai-formats: valid repair, failed repair, exact usage, tool-free repair flag and pre-dispatch format rejection passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
