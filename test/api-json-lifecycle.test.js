'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../frontend/app/harness.js'),'utf8');
const start=source.includes('  async function requestJson(')?source.indexOf('  async function requestJson('):source.indexOf('  const api = {');
const code=source.slice(start,source.indexOf('\n  // ONE fold point',start))+'\nglobalThis.api=api;';
const tick=()=>new Promise(r=>setImmediate(r));
let checks=0,failed=0;const check=(f)=>{checks++;try{f();}catch(e){failed++;console.error(e.message);}};
(async()=>{
 for(const method of ['get','post','del'])for(const phase of ['headers','body']){
  const timers=new Map();let release,signal,settled=false,lateSuccess=false;
  const reply={ok:true,status:200,json:()=>phase==='body'?new Promise(r=>release=r):Promise.resolve({ok:true})};
  const ctx=vm.createContext({AbortController,setTimeout:(fn)=>{const id={};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),fetch:(_url,o)=>{signal=o.signal;return phase==='headers'?new Promise(r=>release=r):Promise.resolve(reply);}});
  vm.runInContext(code,ctx);
  const pending=ctx.api[method]('/api/example',{example:true}).then(()=>{settled=true;lateSuccess=true;},()=>{settled=true;});
  await tick();for(const fn of [...timers.values()])fn();await tick();
  check(()=>assert.equal(settled,true,method+' '+phase+' must have a finite deadline'));
  check(()=>assert.equal(signal?.aborted,true));
  release(phase==='headers'?reply:{ok:true});await pending;
  check(()=>assert.equal(lateSuccess,false,'late acknowledgement cannot resurrect timed-out mutation'));
  check(()=>assert.equal(timers.size,0));
 }
 for(const method of ['get','post','del'])for(const mode of ['success','http-error','bad-json','sync-throw']){
  const timers=new Map();
  const ctx=vm.createContext({AbortController,setTimeout:fn=>{const id={};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),fetch:()=>{if(mode==='sync-throw')throw new Error('offline');return Promise.resolve({ok:mode!=='http-error',status:mode==='http-error'?503:200,json:async()=>{if(mode==='bad-json')throw new Error('invalid JSON');return {ok:mode!=='http-error'};}});}});
  vm.runInContext(code,ctx);let result,error;
  try{result=await ctx.api[method]('/api/example');}catch(e){error=e;}
  check(()=>assert.equal(!!error,mode==='bad-json'||mode==='sync-throw'||(method==='get'&&mode==='http-error')));
  if(result)check(()=>assert.equal(result.ok,mode==='success'));
  check(()=>assert.equal(timers.size,0,'settled '+method+' clears its deadline'));
 }
 console.log(`JSON API lifecycle: ${checks-failed}/${checks} checks passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
