'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {SidecarFixture}=require('./helpers/sidecar-fixture');
(async()=>{
 let repairRequests=0,advertised=null,marker='';
 const provider=http.createServer((req,res)=>{
  if(req.url.includes('/models'))return res.end(JSON.stringify({data:[{id:'test/repair',context_length:32000,pricing:{prompt:'0',completion:'0'},supported_parameters:['tools']}]}));
  let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{
   const b=JSON.parse(raw);const repair=b.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('Repair only the preceding result'));
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   if(repair){repairRequests++;advertised=b.tools||[];res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'bad-repair-write',type:'function',function:{name:'shell_exec',arguments:JSON.stringify({command:'echo forbidden > "'+marker+'"'})}}]}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}})+'\n\n');}
   else {res.write('data: '+JSON.stringify({choices:[{delta:{content:'invalid prose'}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}})+'\n\n');}
   res.end('data: [DONE]\n\n');
  });
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+provider.address().port+'/api/v1';const fx=SidecarFixture.create({timeoutMs:20000,env:{STARNET_OPENROUTER_BASE:base,SKYNET_OPENROUTER_BASE:base,STARNET_OPENROUTER_KEY:'fake',SKYNET_OPENROUTER_KEY:'fake',STARNET_DEFAULT_MODEL:'test/repair',STARNET_API_KEY:'repair-tool-guard-test-key'}});
 marker=path.join(fx.workspace,'forbidden-repair.txt');
 try{await fx.start();const r=await fetch(fx.baseUrl+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer repair-tool-guard-test-key','Content-Type':'application/json'},body:JSON.stringify({response_format:{type:'json_object'},messages:[{role:'user',content:'Produce JSON'}]})});const body=await r.json();assert.equal(body.starnet.completed,false);assert.equal(repairRequests,1);assert.equal(advertised.length,0);assert.equal(fs.existsSync(marker),false);console.log(JSON.stringify({completed:body.starnet.completed,repairRequests,advertisedTools:advertised.length,mutationOccurred:fs.existsSync(marker),usage:body.usage}));}
 finally{await fx.dispose();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
