'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ui=fs.readFileSync(path.join(__dirname,'../frontend/app/stationui.js'),'utf8');
const messaging=fs.readFileSync(path.join(__dirname,'../frontend/app/windows/messaging.js'),'utf8');
const handlers=[...ui.matchAll(/Harness\.api\.post\('\/api\/execution\/(?:policy|ssh|sync|cleanup)'[\s\S]*?\.catch\(\(\) => \{[^\n]*\}\);/g)].map(m=>m[0]);
assert.equal(handlers.length,5,'all execution mutation handlers must be exercised');
const disconnect=messaging.slice(messaging.indexOf("          try { await Harness.api.post('/api/channels/'"),messaging.indexOf('          refreshAll();',messaging.indexOf("          try { await Harness.api.post('/api/channels/'"))+'          refreshAll();'.length);
const disconnectNewStart=messaging.indexOf("          try {\n            const r = await Harness.api.post('/api/channels/'");
const disconnectCode=disconnectNewStart>=0?messaging.slice(disconnectNewStart,messaging.indexOf('          refreshAll();',disconnectNewStart)+'          refreshAll();'.length):disconnect;
let checks=0,failed=0;const check=fn=>{checks++;try{fn();}catch(e){failed++;console.error(e.message);}};
(async()=>{
 for(const code of handlers){
  for(const reply of [{ok:false,status:503,j:{error:'refused'}},{ok:true,j:{ok:false,error:'refused'}},{ok:true,j:{}},{ok:true,j:null},{ok:true,j:{ok:true,saved:true,ready:true}}]){
   const notices=[];const ctx={Harness:{api:{post:async()=>reply}},payload:{},button:{getAttribute:()=> 'push'},box:{getAttribute:()=> 'audit'},input:{value:5},notify:(text,tone)=>notices.push({text,tone}),refreshExecutionProfiles:()=>{}};
   vm.runInNewContext(code,ctx);await new Promise(r=>setImmediate(r));
   check(()=>assert.equal(notices.length,1));
   check(()=>assert.equal(notices[0]?.tone,reply.j?.ok===true?'good':'bad','execution outcome must match acknowledged result: '+code.slice(0,70)));
  }
 }
 for(const reply of [{ok:false,j:{}},{ok:true,j:{}},{ok:true,j:{connected:false,persisted:false}},{ok:true,j:{connected:true,persisted:true}},{ok:true,j:{connected:false,persisted:true}}]){
  const notices=[];await vm.runInNewContext('(async()=>{'+disconnectCode+'})()', {Harness:{api:{post:async()=>reply}},c:{id:'telegram'},msgEl:{},setMsg:(_el,text)=>notices.push(text),sfx:()=>{},refreshAll:()=>{}});
  check(()=>assert.equal(notices.some(x=>x.startsWith('disconnected — token kept')),reply.ok&&reply.j.connected===false&&reply.j.persisted===true,'disconnect must be confirmed and durable'));
 }
 console.log(`control acknowledgements: ${checks-failed}/${checks} checks passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
