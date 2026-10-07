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
  if(mode==='unknown'){assert.match(node('#budget-spend').textContent,/unavailable/);assert.doesNotMatch(node('#budget-spend').textContent,/Restore the ledger/);assert.equal(node('#bg-perDay').value,'3');node('#bg-perRun').value='9';node('#bg-save').click();await tick();assert.equal(posts,1);assert.match(node('#budget-msg').textContent,/saved/);}
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
 // ---- SPEND-1/2: the copy names the cause; interrupted runs are listed and settled only by the Commander ----
 {
  const base={caps:{perRun:0,perAgent:0,perDay:75,global:0},saved:{perDay:75},envDefaults:{perRun:0,perAgent:0,perDay:25,global:0},spentToday:null,lifetime:null,runs:null};
  const settledReply={...base,spentToday:1.62,lifetime:3,runs:4,unsettled:[],atLeast:null,accounting:{complete:true,durable:true,readError:null,writeError:null}};
  const st={...base,accounting:{complete:false,durable:true,readError:'UNSETTLED_SPEND',writeError:null,unsettledRuns:2},atLeast:{today:1.2,lifetime:2.6,runs:3},
   unsettled:[{runId:'r1',agentId:'agent',ts:Date.now(),title:'Fix the build',provider:'openrouter',model:'test/m',runCapUsd:0.5},{runId:'r2',agentId:'scout',ts:null,title:'',provider:null,model:null,runCapUsd:null}]};
  const {node,posts}=harness(st,(u)=>u==='/api/budget/settle'?settledReply:st);await tick();
  const line=node('#budget-spend').textContent;
  assert.match(line,/unavailable/);assert.match(line,/2 interrupted runs/);assert.match(line,/At least \$1\.2 today/);
  assert.doesNotMatch(line,/Restore the ledger|Restart StarNet|\$0(?!\.)/,'never the old advice, never a guessed $0');
  const rows=node('#budget-unsettled').children;assert.equal(rows.length,2,'one row per interrupted run');
  const [r1,r2]=rows;
  assert.equal(r1.className,'set-row bg-unsettled');assert.match(r1.textContent,/INTERRUPTED — Fix the build/);assert.match(r1.attrs['data-tip'],/openrouter · test\/m/);
  assert.match(r2.textContent,/scout · time unknown/,'no title falls back to the agent; no time is said plainly');
  const [,usd1,settle1,count1]=r1.children;
  assert.equal(r2.children.length,3,'no recorded per-run limit -> no COUNT AS key');
  assert.equal(count1.textContent,'COUNT AS $0.5');assert.ok(count1.attrs['data-tip']&&!count1.title,'explanation in data-tip, no title=');
  assert.match(usd1.className,/key-input/);assert.match(settle1.className,/\bbb\b/);
  usd1.value='-1';settle1.click();await tick();assert.equal(posts.length,0,'a negative charge is refused before posting');assert.match(node('#budget-msg').textContent,/number/);
  usd1.value='';settle1.click();await tick();assert.equal(posts.length,0,'a blank is not $0');
  count1.click();await tick();
  assert.deepEqual(posts[0],['/api/budget/settle',{runId:'r1',mode:'limit'}],'COUNT AS posts the limit mode, never a client-computed figure');
  assert.equal(node('#budget-unsettled').children.length,0,'the server truth repaints: settled rows vanish');assert.match(node('#budget-msg').textContent,/settled/);
  const h2=harness(st,()=>settledReply);await tick();
  const [, usd, settle]=h2.node('#budget-unsettled').children[1].children;
  usd.value='0.42';settle.click();await tick();
  assert.deepEqual(h2.posts[0],['/api/budget/settle',{runId:'r2',usd:0.42}],'SETTLE posts exactly what the Commander entered');
 }
 for(const [acc,re,not] of [[{complete:true,durable:false,writeError:'ENOSPC'},/Restart StarNet/,/Settle/],[{complete:false,durable:true,readError:'SPEND_RECEIPT_CONFLICT'},/could not be read/,/Settle/]]){
  const {node}=harness({caps:{perRun:0,perAgent:0,perDay:25,global:0},saved:{},envDefaults:{perRun:0,perAgent:0,perDay:25,global:0},spentToday:null,accounting:acc,unsettled:[]});await tick();
  assert.match(node('#budget-spend').textContent,/unavailable/);assert.match(node('#budget-spend').textContent,re);assert.doesNotMatch(node('#budget-spend').textContent,not);
  assert.equal(node('#budget-unsettled').children.length,0);
 }
 console.log('budget limits: SAVE posts only changes, default-retype clears, cause-specific copy, interrupted-run SETTLE and COUNT AS PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
