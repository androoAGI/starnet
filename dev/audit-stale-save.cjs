'use strict';
// Live negative regression: the currently broken save path accepts a stale snapshot.
const assert=require('node:assert/strict');
const {auth,api,sleep}=require('./audit-api.cjs');
(async()=>{
 await auth();
 const id='audit_save_'+Date.now();
 const baseline=structuredClone((await api('/api/save')).save);
 assert.ok(baseline,'Use an onboarded disposable station');
 baseline.agentId=id;baseline.agent.id=id;baseline.updatedAt=Date.now();
 baseline.workstreams=[{id:'audit-thread',agentId:id,title:'Audit stale save',history:[],runIds:[],kind:'chat',lane:'active'}];
 assert.equal((await api('/api/save',baseline)).ok,true);
 const a=structuredClone((await api('/api/save?agent='+id)).save);
 const b=structuredClone((await api('/api/save?agent='+id)).save);
 a.workstreams[0].history.push({role:'user',content:'CLIENT_A_SAVED_MESSAGE'});a.updatedAt=Date.now();
 const first=await api('/api/save',a);await sleep(10);
 b.workstreams[0].history.push({role:'user',content:'CLIENT_B_LATER_WRITE'});b.updatedAt=Date.now();
 const second=await api('/api/save',b);const result=(await api('/api/save?agent='+id)).save;
 const receipt={agentId:id,firstAccepted:first.ok,staleSnapshotAccepted:second.ok,clientAStillPresent:JSON.stringify(result).includes('CLIENT_A_SAVED_MESSAGE'),clientBPresent:JSON.stringify(result).includes('CLIENT_B_LATER_WRITE')};
 console.log(JSON.stringify(receipt,null,2));
 assert.equal(receipt.staleSnapshotAccepted,true,'Expected the recorded pre-fix failure');
 assert.equal(receipt.clientAStillPresent,false,'Expected the recorded pre-fix loss');
})().catch(e=>{console.error(e);process.exitCode=1});
