'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const A=require('./_assert.js');
const {fnBody}=A;
const appSrc=fs.readFileSync('frontend/app/app.js','utf8');
const source=fnBody(appSrc,'function showSaveUnreachableGate');
const escAlias=(/^  const esc = [^\n]*;$/m.exec(appSrc)||[])[0];   // production alias, app.js module level
A.ok(escAlias&&escAlias.includes('U.esc('),'app.js still defines the module-level esc alias over the one U.esc owner');
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const nodes=new Map(),el=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',hidden:false,disabled:false});return nodes.get(id)};
 let next={unknown:true,reason:'unreachable'},degraded='',reloads=0,report;
 const ctx={el,gateActive:false,World:{stop(){}},SFX:{click(){}},tauriCore:()=>null,show(){},setInterval:()=>1,clearInterval(){},setTimeout(){},Save:{load:()=>null},location:{reload(){reloads++}},Harness:{engineState:async()=>({reason:degraded})},CloudSave:{reconcile:async()=>next,isUnknownSentinel:r=>!!r?.unknown},Diag:{copy(o){report=o.context;o.onDone(true,'fixture')}}};
 require('./helpers/frontend-esc.js').installEsc(ctx);   // the real U.esc from util.js, as updates-install and update-center-truth do
 vm.runInNewContext(escAlias+'\n'+source+';showSaveUnreachableGate("unreachable")',ctx);await tick();
 // review app-shell-ui-09: in browser mode (no desktop shell) the subtitle keeps saying so after a retry repaints it
 assert.equal(el('unreachable-sub').textContent,'station service not answering (browser mode)','the first paint names browser mode');
 el('btn-unreachable-retry').onclick();await tick();await tick();
 assert.equal(el('unreachable-sub').textContent,'station service not answering (browser mode)','a retry keeps the browser-mode subtitle');
 for(const [reason,code] of [['unreadable','SAVE-READ'],['forbidden','SAVE-403'],['cache','SAVE-CACHE'],['unreachable','SAVE-NET']]){
  next={unknown:true,reason};el('btn-unreachable-retry').onclick();await tick();await tick();
  assert.match(el('unreachable-code').innerHTML,new RegExp(code),'latest response updates displayed recovery code');
  el('btn-unreachable-report').onclick();assert.match(report.kind,new RegExp(code),'copied report uses latest response');assert.equal(reloads,0,'unknown state never resumes');
 }
 degraded='degraded: crash-loop';next={unknown:true,reason:'unreadable'};
 for(let i=0;i<2;i++){el('btn-unreachable-retry').onclick();await tick();await tick();assert.match(el('unreachable-code').innerHTML,/SAVE-LOOP/,'unchanged authoritative degraded reason still overrides refreshed request diagnosis');}
 for(const [reason,code,shown] of [['degraded: crash-loop <probe> &lt; literal','SAVE-LOOP','degraded: crash-loop &lt;probe&gt; &amp;lt; literal'],['degraded: owner unavailable <workspace>','SAVE-OWNER','degraded: owner unavailable &lt;workspace&gt;'],['degraded: fixture hold','SAVE-DEGRADED','degraded: fixture hold']]){
 degraded=reason;el('btn-unreachable-retry').onclick();await tick();await tick();el('btn-unreachable-report').onclick();assert.match(report.kind,new RegExp(code));assert.equal(report.error,reason,'copy receives exact measured reason');A.ok(!el('unreachable-code').innerHTML.includes('<probe>'),'reason is not interpreted as markup');A.ok(el('unreachable-code').innerHTML.includes(shown),'HTML entities remain literal');
 }
 degraded='';el('btn-unreachable-retry').onclick();await tick();await tick();assert.match(el('unreachable-code').innerHTML,/SAVE-READ/,'cleared degradation reveals latest save result');el('btn-unreachable-report').onclick();assert.match(report.kind,/SAVE-READ/,'copy clears prior degraded diagnosis');
 next={schema:'starnet.save'};el('btn-unreachable-retry').onclick();await tick();assert.equal(reloads,1,'definitive recovered save reloads once');
 A.report('save recovery diagnosis: retry codes, report context, degraded precedence and successful recovery');
})().catch(e=>{console.error(e);process.exitCode=1});
