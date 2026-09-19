'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
let source=fs.readFileSync(path.join(__dirname,'../frontend/app/marketplace.js'),'utf8');
source=source.replace('return { open, close, refreshIfOpen };','return { loadSkillCatalog, loadCronJobs, loadRecipeRuns, loadFitProjects, loadFitChannels, invalidateFit };')+'\nglobalThis.api=Marketplace;';
let checks=0,failed=0;const check=fn=>{checks++;try{fn();}catch(e){failed++;console.error(e.message);}};
function context(replies){let calls=0;const fetch=async url=>{if(String(url).includes('/drift'))return {ok:true,json:async()=>({drift:{}})};const r=replies[Math.min(calls++,replies.length-1)];if(r instanceof Error)throw r;return {ok:r.status<400,status:r.status,json:async()=>{if(typeof r.body==='string')throw new Error('invalid JSON');return r.body;}};};const ctx=vm.createContext({fetch,Harness:{api:{get:async url=>{const r=await fetch(url);if(!r.ok)throw new Error('http '+r.status);return r.json();}}}});vm.runInContext(source,ctx);return {api:ctx.api,calls:()=>calls};}
(async()=>{
 const cases=[['loadSkillCatalog','skills',{slug:'proof',name:'Proof'}],['loadCronJobs','jobs',{id:'proof',enabled:true}],['loadRecipeRuns','runs',{recipeId:'proof',ts:1,reason:'done'}],['loadFitProjects','projects',{root:'/proof',name:'Proof'}],['loadFitChannels','connectors',{id:'proof',label:'Proof',state:'up',enabled:true}]];
 for(const [method,field,row] of cases)for(const bad of [{status:403,body:{}},{status:503,body:{}},{status:200,body:{}},{status:200,body:{ok:false,[field]:[]}},{status:200,body:'not JSON'},new Error('offline')]){
  const c=context([bad,{status:200,body:{[field]:[row],enabled:true}}]);
  await c.api[method]();const recovered=await c.api[method]();
  check(()=>assert.equal(c.calls(),2,method+' must retry '+JSON.stringify(bad)));
  check(()=>assert.ok(Array.isArray(recovered)?recovered.length===1:!!recovered.proof,method+' must recover real data'));
 }
 const c=context([{status:200,body:{connectors:[{id:'up',label:'up',state:'up'},{id:'cached',label:'cached',state:'cached'},{id:'down',label:'down',state:'down'},{id:'auth',label:'auth',state:'up',authRequired:true},{id:'disabled',label:'disabled',state:'up',enabled:false},{id:'unknown',label:'unknown'}]}}]);
 const channels=await c.api.loadFitChannels();check(()=>assert.deepEqual(Array.from(channels,x=>x.id),['up','cached'],'readiness requires actual connector state'));
 for(const [method,field,row] of cases){
  const empty=context([{status:200,body:{[field]:[]}}]);await empty.api[method]();await empty.api[method]();
  check(()=>assert.equal(empty.calls(),1,'a verified empty catalog is cacheable: '+method));
  if(method==='loadCronJobs'||method==='loadRecipeRuns'){
   const last=context([{status:200,body:{[field]:[row]}},{status:503,body:{}}]);const good=await last.api[method]();const fallback=await last.api[method](true);
   check(()=>assert.equal(JSON.stringify(fallback),JSON.stringify(good),'failed refresh retains last good '+method));
  }
 }
 console.log(`marketplace authority: ${checks-failed}/${checks} checks passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
