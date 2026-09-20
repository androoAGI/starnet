'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {SidecarFixture}=require('./helpers/sidecar-fixture');
(async()=>{
 for(const code of ['EACCES','EIO','ENOSYS']){
  const f=SidecarFixture.create({timeoutMs:10000});
  const lock=path.join(f.workspace,'.starnet-workspace-owner.json');
  const raw=JSON.stringify({version:1,pid:process.pid,nonce:'live-owner',startedAt:Date.now()});
  fs.writeFileSync(lock,raw);
  f.entry=path.join(f.workspace,'fault-host.cjs');
  fs.writeFileSync(f.entry,"const kill=process.kill;process.kill=function(pid,signal){if(signal===0)throw Object.assign(Error('probe unavailable'),{code:"+JSON.stringify(code)+"});return kill.call(process,pid,signal);};require("+JSON.stringify(path.resolve(__dirname,'../sidecar/index.js'))+");");
  const dispose=f.dispose.bind(f);let observed=false;
  f.dispose=async()=>{if(observed)return dispose();observed=true;try{assert.equal(fs.readFileSync(lock,'utf8'),raw,'uncertain process probe must preserve the actual owner');}finally{await dispose();}};
  try{await assert.rejects(f.start(),/WORKSPACE_BUSY/);assert.equal(observed,true);}
  finally{await f.dispose();}
 }
 console.log('workspace HTTP: real sidecar refuses uncertain PID probes and preserves the live owner PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
