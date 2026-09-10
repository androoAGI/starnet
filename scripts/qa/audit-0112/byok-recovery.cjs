const fs=require('node:fs');
const {SidecarFixture}=require('../../../test/helpers/sidecar-fixture.js');
(async()=>{
const f=new SidecarFixture({timeoutMs:20000,env:{STARNET_FULL_ACCESS:'1',SKYNET_FULL_ACCESS:'1',STARNET_CREDITS_TOKEN:'',SKYNET_CREDITS_TOKEN:'',STARNET_OPENROUTER_KEY:'',SKYNET_OPENROUTER_KEY:'',OPENROUTER_API_KEY:'',OPENROUTER_KEY:''}});
try{await f.start();const r=await f.json('POST','/api/run',{provider:'custom',model:'test/model',key:'fixture-custom-key',baseUrl:'http://127.0.0.1:1/v1',agentId:'byok-audit',placed:['studio'],isTask:true,messages:[{role:'user',content:'Generate an image of a blue cube'}]});fs.writeFileSync('qa/evidence/0.11.2-audit/audit-byok-recovery.json',JSON.stringify({status:r.status,events:r.text.split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(e=>/error|run.end/.test(e.name))},null,2));}finally{await f.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});
