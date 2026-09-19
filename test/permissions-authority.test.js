'use strict';
const assert = require('node:assert/strict');
global.Permissions=require('../frontend/app/permissions.js');
const {PermissionsStore:S}=require('../frontend/app/permissionsstore.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));
let checks=0,failed=0;
function check(fn){checks++;try{fn();}catch(e){failed++;console.error(e.message);}}
(async()=>{
  for(const operation of ['grant','revoke','bypass'])for(const reply of [null,{},[],{ok:true},{ok:false},{error:'disk failed'}, {ok:true,error:'refused'}]){
    S.init({load:false,api:{load:async()=>({grants:['cabinet:write'],masterBypass:true}),[operation]:async()=>reply}});
    await S.refresh();
    const after=await S[operation==='bypass'?'setBypass':operation](operation==='bypass'?false:'cabinet:write');
    check(()=>assert.ok(after.error,operation+' must reject '+JSON.stringify(reply)));
    check(()=>assert.deepEqual(after.grants,['cabinet:write']));
    check(()=>assert.equal(after.masterBypass,true));
  }
  for(const terminal of ['resolve','reject']){
    const old=deferred();let reads=0;
    S.init({load:false,api:{load:()=>++reads===1?Promise.resolve({grants:['cabinet:write']}):old.promise,revoke:async()=>({ok:true,grants:[]})}});
    await S.refresh();const pending=S.refresh();await S.revoke('cabinet:write');
    if(terminal==='resolve')old.resolve({grants:['cabinet:write']});else old.reject(new Error('obsolete failure'));
    await pending;
    check(()=>assert.deepEqual(S.snapshot().grants,[],'old reads cannot resurrect revoked authority'));
    check(()=>assert.equal(S.snapshot().error,'','old errors cannot replace current proof'));
  }
  const old=deferred();S.init({load:false,api:{load:()=>old.promise}});const pending=S.refresh();
  S.init({load:false,api:{load:async()=>({grants:[]})}});await S.refresh();old.resolve({grants:['cabinet:write'],masterBypass:true});await pending;
  check(()=>assert.deepEqual(S.snapshot().grants,[],'old instance cannot mutate reinitialized store'));
  const first=deferred();const calls=[];
  S.init({load:false,api:{bypass:on=>{calls.push(on);return calls.length===1?first.promise:Promise.resolve({ok:true,masterBypass:on});}}});
  const a=S.setBypass(true),b=S.setBypass(false);await tick();
  check(()=>assert.deepEqual(calls,[true],'mutations reach host in submission order'));
  first.resolve({ok:true,masterBypass:true});await Promise.all([a,b]);
  check(()=>assert.deepEqual(calls,[true,false]));check(()=>assert.equal(S.snapshot().masterBypass,false));
  S.init({load:false,api:{load:async()=>({grants:['cabinet:write'],masterBypass:true}),revoke:async()=>({}),bypass:async()=>({})}});
  await S.refresh();let error;try{await S.reset();}catch(e){error=e;}
  check(()=>assert.ok(error,'new station lockdown must reject ambiguous replies'));
  for(const op of ['grant','revoke','bypass']){
    S.init({load:false,api:{[op]:async()=>op==='bypass'?{ok:true,masterBypass:true}:{ok:true,grants:op==='grant'?[]:['cabinet:write']}}});
    const snap=await S[op==='bypass'?'setBypass':op](op==='bypass'?false:'cabinet:write');
    check(()=>assert.ok(snap.error,'an acknowledgement must prove the requested effect: '+op));
  }
  const oldRead=deferred();let reads=0;
  S.init({load:false,api:{load:()=>++reads===1?oldRead.promise:Promise.resolve({grants:[]})}});
  const older=S.refresh();await S.refresh();oldRead.resolve({grants:['cabinet:write']});await older;
  check(()=>assert.deepEqual(S.snapshot().grants,[],'newer successful read wins'));
  const oldWrite=deferred();S.init({load:false,api:{bypass:()=>oldWrite.promise}});
  const writing=S.setBypass(true);S.init({load:false});oldWrite.resolve({ok:true,masterBypass:true});await writing;
  check(()=>assert.equal(S.snapshot().masterBypass,false,'old mutation cannot write through init'));
  let attempts=0;S.init({load:false,api:{bypass:async on=>{if(++attempts===1)throw new Error('offline');return {ok:true,masterBypass:on};}}});
  await Promise.all([S.setBypass(true),S.setBypass(false)]);
  check(()=>assert.equal(attempts,2,'one rejected mutation cannot wedge its successors'));
  check(()=>assert.equal(S.snapshot().error,''));
  console.log(`permissions authority: ${checks-failed}/${checks} checks passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
