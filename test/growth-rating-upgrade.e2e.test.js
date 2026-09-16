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
  child=spawn(process.execPath,['sidecar/index.js'],{cwd:root,env:{...process.env,SKYNET_WORKSPACES:workspace,SKYNET_PORT:String(port),SKYNET_OPENROUTER_BASE:'http://127.0.0.1:'+mock.address().port+'/api/v1',SKYNET_OPENROUTER_KEY:'sk-or-v1-rating-fixture',SKYNET_EDGE_TTS:'0'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('rating server boot timeout: '+out.slice(-1200))),30000);const read=d=>{out+=d;if(out.includes('Open in your browser:')){clearTimeout(timer);resolve();}};child.stdout.on('data',read);child.stderr.on('data',read);child.once('exit',c=>{clearTimeout(timer);reject(new Error('boot exit '+c+out.slice(-1200)));});});
  headers={'Content-Type':'application/json','X-StarNet-Token':await bootToken(base,base),Origin:base};
}
async function stop(){ if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;} }
async function api(url,body){const r=await fetch(base+url,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
async function run(agentId,extra={}){
  const r=await fetch(base+'/api/run',{method:'POST',headers,body:JSON.stringify({agentId,key:'sk-or-v1-rating-fixture',model:'test/model',messages:[{role:'user',content:'Write a brief welcome note.'}],...extra})});
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
    // Another window records work while this projection is still open. A later local acknowledgement
    // must not checkpoint over that unseen receipt, including when the station is saved and restarted.
    const remoteRun=await run('agent');
    const remoteRating=(await api('/api/growth/ratings',{runId:remoteRun,verdict:'great',epoch:1})).body.rating;
    const localRun=await run('agent');
    const beforeConcurrent=JSON.parse(JSON.stringify(live.hero.stats));
    const localRating=await XpStore.recordWorkRating({runId:localRun,verdict:'great'},transport);
    let expected=beforeConcurrent;
    for(const rating of [remoteRating,localRating.rating]) for(const entry of rating.entries) expected=Xp.applyEvent(expected,{name:'memory.feedback',payload:entry}).stats;
    const resumed=resume({...legacy,agent:JSON.parse(JSON.stringify(live.hero)),agents:[JSON.parse(JSON.stringify(live.agents.get('scribe')))],stationStats:JSON.parse(JSON.stringify(XpStore.stationStats()))});
    const checkpoint=XpStore.stationStats().ratingSyncAt;
    const savedProjection=JSON.parse(JSON.stringify(XpStore.stationStats()));
    await stop();await boot();
    await XpStore.init({getAgent:id=>resumed.agents.get(id||'agent'),agents:()=>Array.from(resumed.agents.values()),station:savedProjection,syncRatingsSince:checkpoint,loadRatings:since=>XpStore.loadRatingHistory(since,transport)});
    A.eq(resumed.hero.stats.xp,expected.xp,'restart recovers the other-window rating instead of checkpointing past it');
    A.eq(resumed.hero.stats.level,expected.level,'recovered ratings restore the earned level');
    A.eq(resumed.hero.stats.counters.positiveFeedback,expected.counters.positiveFeedback,'all five acknowledged ratings remain represented exactly once across both agents');
    const history=await api('/api/growth/ratings?epoch=1');A.eq(history.body.ratings.length,5,'legacy ratings survive a sidecar restart');
    const fresh={...legacy,_saveRevision:(await api('/api/save?agent=agent')).body.save._saveRevision,updatedAt:Date.now()+3600000,agent:{...legacy.agent,createdAt:1234567}};
    A.ok((await api('/api/save',fresh)).body.ok,'new station saves its explicit generation');
    A.eq(resume(fresh).hero.createdAt,1234567,'resume preserves a real creation timestamp');
    A.eq((await api('/api/growth/ratings',{runId:runIds[0],verdict:'great',epoch:1})).status,409,'stale station cannot rate into a new generation');
    const freshRun=await run('agent');A.ok((await api('/api/growth/ratings',{runId:freshRun,verdict:'great',epoch:1234567})).body.ok,'fresh station ratings still save');
    A.eq((await api('/api/growth/ratings?epoch=1234567')).body.ratings.length,1,'new generation does not inherit legacy ratings');
    // A conversation's scheduled origin must not poison later interactive run eligibility (#18).
    const routine=await api('/api/cron',{name:'Rating origin proof',prompt:'Write a brief welcome note.',schedule:'every 1h',agentId:'agent',model:'test/model',provider:'openrouter'});
    A.ok(routine.body.job?.id,'create a real routine for the continued conversation');
    const fired=await fetch(base+'/api/cron/run',{method:'POST',headers,body:JSON.stringify({id:routine.body.job.id})});
    const routineEvents=(await fired.text()).split('\n').filter(Boolean).map(s=>JSON.parse(s));
    const routineEnd=routineEvents.find(e=>e.name==='agent.run.end');
    A.eq(routineEnd?.payload.reason,'done','scheduled entry point produces a real completed reply');
    const scheduledId=routineEnd.payload.runId;
    const scheduled=(await api('/api/runs?agent=agent')).body.runs.find(r=>r.runId===scheduledId);
    A.eq(scheduled.surface,'autonomous','routine retains its actual origin');
    const scheduledRating=await api('/api/growth/ratings',{runId:scheduledId,verdict:'great',epoch:1234567});
    A.eq(scheduledRating.body.error,'non-interactive run cannot be rated','scheduled rating policy remains unchanged and accurately explained');
    const continued=[];
    for(const prefix of ['cron-','nightshift-','workshop-']) {
      const runId=await run('agent',{streamId:prefix==='cron-'?scheduled.streamId:prefix+'saved-conversation'});
      continued.push(runId);
      const row=(await api('/api/runs?agent=agent')).body.runs.find(r=>r.runId===runId);
      A.eq(row.internal,false,prefix+' continuation reports its actual interactive origin');
      const rated=await api('/api/growth/ratings',{runId,verdict:'great',epoch:1234567});
      A.ok(rated.body.ok,prefix+' interactive reply can be rated: '+JSON.stringify(rated.body));
    }
    const internalRun=await run('agent',{streamId:'cron-self-talk',internal:true});
    const denied=await api('/api/growth/ratings',{runId:internalRun,verdict:'great',epoch:1234567});
    A.eq(denied.status,409,'real internal self-talk remains ineligible');
    A.eq(denied.body.error,'internal run cannot be rated','existing ineligible work is not called missing');
    A.eq((await api('/api/growth/ratings',{runId:'nonexistent',verdict:'great',epoch:1234567})).status,404,'missing run still fails closed');
    await stop();
    // A historical row cannot acquire invented interactive provenance during an upgrade.
    const storedScheduled=fs.readFileSync(path.join(workspace,'runs.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).find(r=>r.runId===scheduledId);
    const legacyOrigin={...storedScheduled,runId:'legacy-origin-fixture'}; delete legacyOrigin.surface;
    fs.appendFileSync(path.join(workspace,'runs.jsonl'),JSON.stringify(legacyOrigin)+'\n');
    await boot();
    const unknownOrigin=await api('/api/growth/ratings',{runId:legacyOrigin.runId,verdict:'great',epoch:1234567});
    A.eq(unknownOrigin.status,409,'legacy ambiguous origin is not promoted to rateable work');
    A.eq(unknownOrigin.body.error,'run origin unavailable for rating','legacy origin gap is distinct from missing history');
    for(const runId of continued) {
      const rated=await api('/api/growth/ratings',{runId,verdict:'miss',epoch:1234567});
      A.ok(rated.body.ok&&rated.body.duplicate&&rated.body.rating.verdict==='great','continued reply rating survives restart without duplicate XP');
    }
  } finally {await stop();await new Promise(r=>mock.close(r));fs.rmSync(workspace,{recursive:true,force:true});}
  A.report('growth-rating-upgrade.e2e');
})().catch(e=>{console.error(e);process.exit(1);});
