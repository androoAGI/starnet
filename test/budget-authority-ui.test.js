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
  if(mode==='unknown'){assert.match(node('#budget-spend').textContent,/unavailable/);assert.equal(node('#bg-perDay').value,'3');node('#bg-perRun').value='9';node('#bg-save').click();await tick();assert.equal(posts,1);assert.match(node('#budget-msg').textContent,/saved/);}
 }
 console.log('budget display: loading, unavailable totals, preserved caps, failed and malformed reads PASS');
 // ---- a harness with real-ish nodes: rows the panel builds, every POST body captured ----
 const harness=(status,reply)=>{
  const mkNode=tag=>{const n={tag,children:[],attrs:{},style:{},classList:{toggle(){}},value:'',_t:'',
   get textContent(){return this._t+this.children.map(c=>c.textContent).join('');},set textContent(v){this._t=String(v);this.children=[];},
   appendChild(c){this.children.push(c);return c;},setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,fn){this[k]=fn;},focus(){}};return n;};
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,mkNode(id));return nodes.get(id);};
  const posts=[];
  vm.runInNewContext(code+';wireBudget(body)',{body:{querySelector:node},Harness:{api:{get:async()=>status,post:async(u,b)=>{posts.push([u,JSON.parse(JSON.stringify(b))]);return {ok:true,j:reply?reply(u,b):status};}}},
   fmtUsd:n=>'$'+n,sfx(){},document:{createElement:mkNode,createTextNode:t=>({textContent:String(t)})}});
  return {node,posts};
 };
 // ---- SPEND-3: SAVE posts only what the Commander changed; typing the default back into a saved limit clears it ----
 {
  const envDefaults={perRun:0,perAgent:0,perDay:25,global:0};
  const st={caps:{...envDefaults},saved:{},envDefaults,spentToday:0,lifetime:0,runs:0,accounting:{complete:true,durable:true}};
  const {node,posts}=harness(st);await tick();
  node('#bg-save').click();await tick();
  assert.equal(posts.length,0,'an untouched form posts nothing (the shipped day rail stays soft)');assert.match(node('#budget-msg').textContent,/no changes/);
  node('#bg-perDay').value='25.0';node('#bg-global').value='';node('#bg-save').click();await tick();
  assert.equal(posts.length,0,'a retyped identical value or a blank over a painted 0 is not a change');
  node('#bg-perRun').value='2';node('#bg-save').click();await tick();
  assert.deepEqual(posts[0],['/api/budget/caps',{perRun:2}],'only the edited key is posted — no perDay');
  const savedDay={caps:{...envDefaults,perDay:50},saved:{perDay:50},envDefaults,spentToday:0,lifetime:0,runs:0,accounting:{complete:true,durable:true}};
  const h2=harness(savedDay);await tick();
  h2.node('#bg-perDay').value='25';h2.node('#bg-save').click();await tick();
  assert.deepEqual(h2.posts[0],['/api/budget/caps',{perDay:null}],'typing the default back into a saved limit clears the override');
  h2.node('#bg-perDay').value='30';h2.node('#bg-save').click();await tick();
  assert.deepEqual(h2.posts[1],['/api/budget/caps',{perDay:30}],'a real new value is saved');
 }
 console.log('budget limits: SAVE posts only changes, default-retype clears PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
