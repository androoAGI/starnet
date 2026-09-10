'use strict';
const assert=require('node:assert/strict'), http=require('node:http');
const {SidecarFixture}=require('./helpers/sidecar-fixture');
(async()=>{
 let calls=0;
 const provider=http.createServer((req,res)=>{
  if(req.url.includes('/models'))return res.end(JSON.stringify({data:[{id:'test/retry',context_length:32000,pricing:{prompt:'0',completion:'0'}}]}));
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   const body=JSON.parse(raw);const last=body.messages.filter(m=>m.role==='user').at(-1);
   if(last && /^RETRY_PROBE/.test(last.content))calls++;
   setTimeout(()=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'Retry evidence'},finish_reason:null}]})+'\n\n');res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}})+'\n\ndata: [DONE]\n\n');},100);
  });
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+provider.address().port+'/api/v1';
 const fx=SidecarFixture.create({timeoutMs:20000,env:{STARNET_OPENROUTER_BASE:base,SKYNET_OPENROUTER_BASE:base,STARNET_OPENROUTER_KEY:'fake-retry',SKYNET_OPENROUTER_KEY:'fake-retry',STARNET_DEFAULT_MODEL:'test/retry',STARNET_API_KEY:'retry-probe-long-test-key'}});
 const post=(key,stream=false,content='RETRY_PROBE same task')=>fetch(fx.baseUrl+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer retry-probe-long-test-key','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({stream,messages:[{role:'user',content}]})});
 try {
  await fx.start();
  const responses=await Promise.all([post('same'),post('same'),post('same')]);
  const texts=await Promise.all(responses.map(r=>r.text()));
  assert.ok(responses.every(r=>r.status===200));assert.ok(texts.every(t=>t===texts[0]));assert.equal(calls,1);
  assert.equal((await post('same',false,'RETRY_PROBE changed task')).status,409);assert.equal(calls,1);
  await fx.restart();assert.equal(await (await post('same')).text(),texts[0]);assert.equal(calls,1);
  const streams=await Promise.all([post('stream',true),post('stream',true)]);
  const frames=await Promise.all(streams.map(r=>r.text()));assert.equal(frames[0],frames[1]);assert.match(frames[0],/\[DONE\]/);assert.equal(calls,2);
  console.log('request-idempotency.e2e: 3 concurrent requests = 1 primary call; conflict rejected; exact replay after sidecar restart; 2 streaming retries = 1 primary call');
 }finally{await fx.dispose();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
