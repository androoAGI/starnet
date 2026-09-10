'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {makeOpenAiCompat}=require('../sidecar/openai-compat');const {makeRequestReservations}=require('../sidecar/request-reservations');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'starnet-rotation-'));let key='old-principal-test-key',calls=0,release,started;
 const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 const api=makeOpenAiCompat({now:()=>1000,newId:()=>String(calls),apiKey:()=>key,requestReservations:makeRequestReservations({fs,path,workspaces:root,now:()=>1000}),readBody:async req=>{let s='';for await(const c of req)s+=c;return s;},runOnce:async o=>{calls++;started();await hold;o.emit('agent.token',{delta:'PRIVATE_RESULT'});o.emit('agent.run.end',{reason:'done'});}});
 const server=http.createServer((req,res)=>api.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=token=>fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+token,'Idempotency-Key':'same','Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'private task'}]})});
 try{const pending=post(key);await ready;key='new-principal-test-key';release();const denied=await pending;assert.equal(denied.status,401);assert.ok(!(await denied.text()).includes('PRIVATE_RESULT'));assert.equal((await post('old-principal-test-key')).status,401);const fresh=await post(key);assert.equal(fresh.status,200);assert.equal(calls,2,'new principal did not receive old principal cached result');console.log('auth rotation: old waiter denied before result delivery; stale credential denied; new principal executes independently');}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
