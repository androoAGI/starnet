'use strict';
// Audit reproductions. Product source is loaded unchanged; no paid provider calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const S = require('../../sidecar/loopjob-store.js');
const {makeLoopDriver} = require('../../sidecar/loopjob-driver.js');
const Returns = require('../../frontend/app/returns.js');
const flush = () => new Promise(r=>setImmediate(r));
const results = [];
function sourceFunction(name, next) {
  const source=read('sidecar/index.js');
  return source.slice(source.indexOf('async function '+name+'('), source.indexOf('async function '+next+'('));
}
async function cancellation() {
  const now=1700006400000;
  let loops=S.createLoop([],{id:'auditloop',objective:'audit cancellation'},{now});
  let resolveRun;
  const driver=makeLoopDriver({getLoops:()=>loops,setLoops:n=>(loops=n,true),runOnce:()=>new Promise(r=>resolveRun=r),newId:()=> 'auditrun',newAbort:()=>new AbortController(),now:()=>now,defaultModel:'test',concurrencyFree:()=>true});
  driver.applyTick(now);
  const context=vm.createContext({loopJobs:loops,loopjobStore:S,loopReviewBusy:()=>false,Date,loopDriver:driver,commitLoops:n=>{loops=n;context.loopJobs=n;},armLoops:()=>{},modelLoopRow:()=>loops[0]});
  vm.runInContext(sourceFunction('modelControlLoop','modelRemoveLoop'),context);
  await context.modelControlLoop('auditloop','pause','audit');
  resolveRun({reason:'cancelled'}); await flush(); await flush();
  const after={state:loops[0].state,iteration:loops[0].iterations[0].outcome,leases:driver.leases.size,claim:loops[0].fireClaim};
  assert.equal(after.iteration,'running'); assert.equal(after.leases,1);
  results.push({id:'loop-agent-pause',evidence:after,kind:'unchanged-source reproduction'});
  driver.abortLease('auditloop','reference UI cancellation');
  assert.equal(loops[0].iterations[0].outcome,'cancelled');
  results.push({id:'loop-ui-cancellation-reference',iteration:loops[0].iterations[0].outcome,leases:driver.leases.size});
}
async function awayReadFailure() {
  let saved=JSON.stringify({lastSeenAt:1000,pending:[],digested:[]});
  let requests=0;
  const run={runId:'away-result',agentId:'agent',streamId:'away-stream',reason:'done',ts:2000,title:'Completed while away'};
  async function boot(at,fail) {
    const timers=[];
    class Clock extends Date { static now(){return at;} }
    const ctx=vm.createContext({Returns,Date:Clock,localStorage:{getItem:()=>saved,setItem:(k,v)=>saved=v},window:{addEventListener:()=>{}},setInterval:()=>1,clearInterval:()=>{},setTimeout:f=>(timers.push(f),1),XpStore:{loadRunHistory:async()=>{requests++;if(fail)throw Error('temporary outage');return {runs:[run]};}}});
    vm.runInContext(read('frontend/app/returnstore.js')+'\nthis.store=ReturnStore;',ctx);
    ctx.store.init({enabled:true});
    for(const f of timers) f(); await flush();await flush();
    return JSON.parse(saved);
  }
  const first=await boot(3000,true), second=await boot(4000,false);
  assert.equal(first.pending.length,0);assert.equal(second.pending.length,0);assert.equal(requests,2);
  results.push({id:'away-read-failure-loses-recovery-boundary',first,second,runTimestamp:run.ts,requests,kind:'unchanged-source two-boot reproduction'});
}
async function liveRoutine() {
  const base='http://127.0.0.1:19427';
  const html=await(await fetch(base)).text();
  const token=html.match(/window\.__STARNET_API_TOKEN__\s*=\s*"([^"]+)"/)[1];
  const j=await(await fetch(base+'/api/cron',{headers:{'X-StarNet-Token':token}})).json();
  const job=j.jobs.find(x=>x.name==='Audit follow-up enabled');assert.ok(job);
  const source=read('sidecar/index.js');
  const code=source.slice(source.indexOf('function cronReturnsToSession('),source.indexOf('async function deliverCronResult('));
  const ctx=vm.createContext({});vm.runInContext(code,ctx);
  const preflight=ctx.cronPreflightConfig(job);
  assert.equal(job.attachToSession,true);assert.equal(job.origin,null);assert.equal(preflight.code,'missing-session-origin');
  results.push({id:'routine-follow-up-without-origin',kind:'live UI save + live API read + actual preflight function',job:{id:job.id,name:job.name,deliver:job.deliver,attachToSession:job.attachToSession,origin:job.origin},preflight});
}
async function stuckQuery() {
  const {QuerySpine:Q}=require('../../frontend/app/queryspine.js');
  Q._resetForTest();let calls=0;
  Q._setGetForTest(()=>{calls++;return new Promise(()=>{});});
  Q.refresh('cron');await flush();
  Q.invalidate('cron');Q.refresh('cron');await flush();
  assert.equal(calls,1);assert.equal(Q.state('cron').pending,true);
  results.push({id:'query-refresh-waits-on-hung-predecessor',calls,pending:Q.state('cron').pending,kind:'unchanged-source stalled-transport reproduction; no wall-clock timeout in Harness.api.get'});
}
function outboxAttribution() {
  const source=read('frontend/app/windows/outbox.js');
  const block=source.slice(source.indexOf('        const users ='),source.indexOf('        // FILES —'));
  const ctx=vm.createContext({turns:[{role:'user',content:'RUN A request',sourceRunId:'A'},{role:'assistant',content:'RUN A answer',sourceRunId:'A'},{role:'user',content:'RUN B request',sourceRunId:'B'},{role:'assistant',content:'RUN B answer',sourceRunId:'B'}],rw:{runId:'A',streamId:'shared-session'},row:{querySelector:()=>({})},desc:{},ask:{},out:{},plain:s=>s,firstLine:(s,n)=>s.slice(0,n)});
  vm.runInContext(block,ctx);
  assert.equal(ctx.ask.textContent,'RUN A request');assert.equal(ctx.out.textContent,'RUN B answer');
  results.push({id:'outbox-output-attributed-to-wrong-run',run:'A',ask:ctx.ask.textContent,output:ctx.out.textContent,kind:'unchanged rendering block with two-run transcript fixture; not a live paid run'});
}
function saveFailure() {
  const source=read('frontend/app/stationui.js');
  const start=source.indexOf('  function save() {');
  const fn=source.slice(start,source.indexOf('\n',start));
  const ctx=vm.createContext({localStorage:{setItem:()=>{throw Error('QuotaExceededError');}},KEY:'audit',store:{settings:{sound:false}}});
  vm.runInContext(fn,ctx);
  let threw=false;try{ctx.save();}catch{threw=true;}
  assert.equal(threw,false);
  results.push({id:'settings-save-failure-swallowed',threw,kind:'unchanged save function with failed localStorage; callers flashSaved unconditionally (source inspection), not live disk-full proof'});
}
function routineProvider() {
  const source=read('sidecar/index.js');
  const code=source.slice(source.indexOf('function cronProviderFor('),source.indexOf('function cronKeyFor('));
  const ctx=vm.createContext({cronIdentityFor:()=>({provider:'codex',model:'codex-test-model'}),normalizeProviderId:s=>s});
  vm.runInContext(code,ctx);
  const inherited=ctx.cronProviderFor({agentId:'specialist'});
  const fromUi=ctx.cronProviderFor({agentId:'specialist',provider:'openrouter'});
  assert.equal(inherited,'codex');assert.equal(fromUi,'openrouter');
  results.push({id:'routine-station-provider-overrides-selected-agent',agentProvider:'codex',uiStationProvider:'openrouter',resolvedFromUi:fromUi,resolvedWithoutOverride:inherited,kind:'actual resolver + inspected UI request path; multi-provider live dispatch unverified'});
}
(async()=>{await cancellation();await awayReadFailure();await liveRoutine();await stuckQuery();outboxAttribution();saveFailure();routineProvider();fs.writeFileSync(path.join(__dirname,'probe-results.json'),JSON.stringify({source:'091d6e7f3',results},null,2)+'\n');console.log(JSON.stringify(results,null,2));})().catch(e=>{console.error(e);process.exitCode=1;});
