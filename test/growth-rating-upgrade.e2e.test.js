'use strict';
// Real run -> production resume + XP adapter -> real durable rating endpoint -> process restart.
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {bootToken} = require('./_httpToken.js');
const resume = require('./_rating-resume.js');
global.Xp = require('../frontend/app/xp.js');
const {XpStore} = require('../frontend/app/xpstore.js');
const root = path.resolve(__dirname,'..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(),'starnet-rating-upgrade-'));
let child, base, headers;
const mock = http.createServer((req,res) => {
  if (req.url.includes('/models')) { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({data:[{id:'test/model',context_length:128000,pricing:{prompt:'0',completion:'0'},supported_parameters:['tools']}]})); }
  req.resume(); req.on('end', () => {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'The requested welcome note is complete.'}}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:5,total_tokens:10}})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
});
async function boot() {
  const socket=http.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  base='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['sidecar/index.js'],{cwd:root,env:{...process.env,SKYNET_WORKSPACES:workspace,SKYNET_PORT:String(port),SKYNET_OPENROUTER_BASE:'http://127.0.0.1:'+mock.address().port+'/api/v1',SKYNET_EDGE_TTS:'0'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('rating server boot timeout: '+out.slice(-1200))),30000);const read=d=>{out+=d;if(out.includes('Open in your browser:')){clearTimeout(timer);resolve();}};child.stdout.on('data',read);child.stderr.on('data',read);child.once('exit',c=>{clearTimeout(timer);reject(new Error('boot exit '+c+out.slice(-1200)));});});
  headers={'Content-Type':'application/json','X-StarNet-Token':await bootToken(base,base),Origin:base};
}
async function stop(){ if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;} }
async function api(url,body){const r=await fetch(base+url,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
async function run(agentId){
  const r=await fetch(base+'/api/run',{method:'POST',headers,body:JSON.stringify({agentId,key:'sk-or-v1-rating-fixture',model:'test/model',messages:[{role:'user',content:'Write a brief welcome note.'}]})});
  const events=(await r.text()).split('\n').filter(Boolean).map(s=>JSON.parse(s));
  const end=events.find(e=>e.name==='agent.run.end'); A.eq(end&&end.payload.reason,'done',agentId+' completed a real local-provider run');
  const history=await api('/api/runs?agent='+agentId);
  const row=history.body.runs.find(r=>r.runId===end.payload.runId);
  A.ok(row && row.identityFallback === false,agentId+' ran as its persistent roster identity, not a fallback');
  return end.payload.runId;
}
(async()=>{
  mock.listen(0,'127.0.0.1');await once(mock,'listening');
  try {
    await boot();
    const legacy={schema:'starnet.save',version:6,updatedAt:Date.now()+1800000,agent:{id:'agent',name:'Legacy hero',onboarded:true,model:'test/model',stats:Xp.fresh()},agents:[{id:'scribe',name:'Scribe',createdAt:123,stats:Xp.fresh()}],stationStats:Xp.fresh()};
    A.ok((await api('/api/save',legacy)).body.ok,'store the pre-update legacy save; future stamp models a held background sync');
    A.ok((await api('/api/roster',{agents:[{agentId:'agent',name:'Legacy hero',model:'test/model',provider:'openrouter'},{agentId:'scribe',name:'Scribe',model:'test/model',provider:'openrouter'}]})).body.ok,'persist the actual hero and specialist roster');
    const priorRun=await run('agent');
    A.ok((await api('/api/growth/ratings',{runId:priorRun,verdict:'great',epoch:1})).body.ok,'legacy feedback exists before the update');
    const runIds=[await run('agent'),await run('scribe')];
    const live=resume(legacy);
    await XpStore.init({getAgent:id=>live.agents.get(id||'agent'),agents:()=>Array.from(live.agents.values()),station:Xp.fresh(),syncRatingsSince:1,loadRatings:async()=> (await api('/api/growth/ratings?epoch='+Math.max(1,Number(live.hero.createdAt)||1))).body});
    A.eq(live.hero.stats.xp,30,'resume replays existing legacy feedback instead of stranding it in a different generation');
    const delayed=await api('/api/save',{...legacy,agent:live.hero,stationStats:XpStore.stationStats(),updatedAt:Date.now()});
    A.ok(delayed.body.stale,'background save remains pending; rating must not depend on it');
    const transport=(url,opts)=>fetch(base+url,{...opts,headers:{...headers,...opts.headers}});
    for(const runId of runIds){const result=await XpStore.recordWorkRating({runId,verdict:'great'},transport);A.ok(result.ok&&result.applied,'legacy run '+runId+' rates before background save succeeds: '+JSON.stringify(result));}
    A.eq(live.hero.createdAt,undefined,'resume does not invent a creation date or replace legacy ledger identity');
    A.eq((await api('/api/growth/ratings?epoch=1')).body.ratings.length,3,'both agents have durable ratings in the original generation');
    const duplicate=await XpStore.recordWorkRating({runId:runIds[0],verdict:'miss'},transport);
    A.ok(duplicate.ok&&duplicate.duplicate&&!duplicate.applied,'retry is idempotent and retains the first verdict');
    await stop();await boot();
    const history=await api('/api/growth/ratings?epoch=1');A.eq(history.body.ratings.length,3,'legacy ratings survive a sidecar restart');
    const fresh={...legacy,updatedAt:Date.now()+3600000,agent:{...legacy.agent,createdAt:1234567}};
    A.ok((await api('/api/save',fresh)).body.ok,'new station saves its explicit generation');
    A.eq(resume(fresh).hero.createdAt,1234567,'resume preserves a real creation timestamp');
    A.eq((await api('/api/growth/ratings',{runId:runIds[0],verdict:'great',epoch:1})).status,409,'stale station cannot rate into a new generation');
    const freshRun=await run('agent');A.ok((await api('/api/growth/ratings',{runId:freshRun,verdict:'great',epoch:1234567})).body.ok,'fresh station ratings still save');
    A.eq((await api('/api/growth/ratings?epoch=1234567')).body.ratings.length,1,'new generation does not inherit legacy ratings');
  } finally {await stop();await new Promise(r=>mock.close(r));fs.rmSync(workspace,{recursive:true,force:true});}
  A.report('growth-rating-upgrade.e2e');
})().catch(e=>{console.error(e);process.exit(1);});
