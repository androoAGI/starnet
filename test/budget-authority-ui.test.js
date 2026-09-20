'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const text=fs.readFileSync('frontend/app/stationui.js','utf8');
const code=text.slice(text.indexOf('  const BG_KEYS ='),text.indexOf('  // MODELS panel'));
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 for(const mode of ['healthy','unknown','failed','malformed']){
  const nodes=new Map(); const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',style:{},classList:{toggle(){}},addEventListener(k,fn){this[k]=fn;}});return nodes.get(id);};
  let resolve, reject, posts=0;
  const ready=new Promise((a,b)=>{resolve=a;reject=b});
  const caps={perRun:1,perAgent:2,perDay:3,global:4};
  const status={caps,saved:caps,envDefaults:caps,spentToday:0.5,lifetime:1,runs:2,accounting:{complete:true,durable:true}};
  if(mode==='unknown'){status.accounting.complete=false;status.spentToday=status.lifetime=null;}
  vm.runInNewContext(code+';wireBudget(body)',{body:{querySelector:node},Harness:{api:{get:()=>ready,post:async()=>{posts++;return {ok:true,j:status};}}},fmtUsd:n=>'$'+n,sfx(){},document:{}});
  assert.equal(node('#bg-save').disabled,true);node('#bg-save').click();assert.equal(posts,0);
  if(mode==='failed')reject(new Error('offline'));else resolve(mode==='malformed'?{}:status);
  await tick();
  assert.equal(node('#bg-save').disabled,mode==='failed'||mode==='malformed');
  if(mode==='unknown'){assert.match(node('#budget-spend').textContent,/unavailable/);assert.equal(node('#bg-perDay').value,'3');node('#bg-save').click();await tick();assert.equal(posts,1);assert.match(node('#budget-msg').textContent,/saved/);}
 }
 console.log('budget display: loading, unavailable totals, preserved caps, failed and malformed reads PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
