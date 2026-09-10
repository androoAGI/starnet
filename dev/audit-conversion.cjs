'use strict';
// Live negative regression: the direct-to-group conversion drops attachment references.
const assert=require('node:assert/strict');const {auth,api}=require('./audit-api.cjs');
(async()=>{
 await auth();
 const uploaded=await api('/api/attachments',{agent:'agent',name:'conversion-audit.txt',dataUrl:'data:text/plain;base64,'+Buffer.from('AUDIT_ATTACHMENT_MUST_SURVIVE').toString('base64')});
 assert.equal(uploaded.ok,true);
 const attachment=Object.fromEntries(['id','name','path','mediaType','kind'].map(k=>[k,uploaded[k]]));
 const id='audit_conversion_'+Date.now();
 const response=await api('/api/groups',{op:'create',id,members:['agent'],originalAgentId:'agent',title:'Audit attachment conversion',history:[{role:'user',content:'Keep this document.',attachments:[attachment],ts:Date.now()}]});
 assert.equal(response.ok,true);const group=(await api('/api/groups?id='+id)).result;
 const receipt={groupId:id,beforeAttachmentCount:1,afterArtifactCount:group.artifacts.length,afterMessageHasAttachments:!!group.messages[0].attachments,afterMessageHasArtifactIds:!!group.messages[0].artifactIds};
 console.log(JSON.stringify(receipt,null,2));assert.equal(receipt.afterArtifactCount,0,'Expected the recorded pre-fix loss');assert.equal(receipt.afterMessageHasAttachments,false);
})().catch(e=>{console.error(e);process.exitCode=1});
