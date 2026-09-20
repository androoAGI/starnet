'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {SidecarFixture}=require('./helpers/sidecar-fixture');
(async()=>{
  let calls=0, hold=false;
  const server=http.createServer((req,res)=>{
    if(req.url.includes('/models'))return res.end(JSON.stringify({data:[{id:'test/spend',context_length:32000,pricing:{prompt:'0',completion:'0'}}]}));
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      calls++;if(hold)return;res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'A measured response.'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,cost:0.4}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port+'/api/v1';
  const f=SidecarFixture.create({entry:path.resolve(__dirname,'helpers/spend-fault-host.cjs'),timeoutMs:20000,env:{SKYNET_OPENROUTER_BASE:base,STARNET_OPENROUTER_BASE:base,SKYNET_OPENROUTER_KEY:'spend-fixture',SKYNET_DEFAULT_MODEL:'test/spend',SKYNET_BUDGET_PER_DAY:'2',SKYNET_AUX_BUDGET:'0'}});
  const ledger=path.join(f.workspace,'ledger.jsonl'),control=path.join(f.workspace,'spend-fault.json');
  const run=()=>f.json('POST','/api/run',{agentId:'agent',provider:'openrouter',model:'test/spend',key:'spend-fixture',baseUrl:base,isTask:false,messages:[{role:'user',content:'Say hello'}]});
  const status=()=>f.json('GET','/api/budget/status');
  try {
    fs.writeFileSync(ledger,JSON.stringify({runId:'prior',agentId:'agent',usd:0.5,ts:Date.now()})+'\n');
    fs.writeFileSync(control,JSON.stringify({mode:'read'}));
    await f.start();assert.equal((await status()).body.spentToday,null);
    const refused=await run();assert.match(refused.text,/spend_history_unavailable|Spend history/);assert.equal(calls,0);
    await f.stop();fs.writeFileSync(control,'{}');await f.start();
    assert.equal((await status()).body.spentToday,0.5);
    fs.writeFileSync(control,JSON.stringify({mode:'write'}));
    await run();assert.equal(calls,1);assert.equal((await status()).body.spentToday,null);
    await run();assert.equal(calls,1,'a failed durable append blocks subsequent capped dispatch');
    await f.stop();fs.writeFileSync(control,'{}');await f.start();
    const repaired=await status();assert.equal(repaired.status,200);assert.equal(repaired.body.spentToday,0.9,'pending completed charge recovered once');
    await f.restart();assert.equal((await status()).body.spentToday,0.9,'settlement replay is idempotent');
    await f.stop();
    const dir=path.join(f.workspace,'.spend-pending');fs.mkdirSync(dir,{recursive:true});
    for (const [entryId,usd] of [['aux-one',0.1],['aux-two',0.2]]) {
      const entry={entryId,runId:'same-parent',agentId:'agent',usd,ts:Date.now()};
      fs.writeFileSync(path.join(dir,'z-'+entryId+'.json'),JSON.stringify({runId:entry.runId,entry}));
    }
    fs.writeFileSync(path.join(dir,'000-dispatch.json'),JSON.stringify({runId:'same-parent'}));
    await f.start();assert.ok(Math.abs((await status()).body.spentToday-1.2)<1e-9,'distinct settlements for the same parent survive together, before dispatch-marker reconciliation');
    await f.restart();assert.ok(Math.abs((await status()).body.spentToday-1.2)<1e-9,'multiple settlements are not duplicated');
    await f.stop();
    fs.writeFileSync(path.join(dir,crypto.createHash('sha256').update('interrupted').digest('hex')+'.json'),JSON.stringify({runId:'interrupted',agentId:'agent'}));
    await f.start();assert.equal((await status()).body.spentToday,null);await run();assert.equal(calls,1,'unknown interrupted spend is not guessed zero after restart');
    await f.stop();
    fs.unlinkSync(path.join(dir,crypto.createHash('sha256').update('interrupted').digest('hex')+'.json'));
    await f.start();hold=true;
    const interrupted=run().catch(()=>null);
    for(let i=0;i<100&&calls<2;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(calls,2,'provider accepted the request before process termination');
    f.child.kill('SIGKILL');await f.stop();await interrupted;server.closeAllConnections();
    await f.start();assert.equal((await status()).body.spentToday,null,'a real hard crash cannot erase uncertain provider usage');
    await run();assert.equal(calls,2,'restart cannot dispatch again against unknown configured pools');
    console.log('spend HTTP: unreadable history, zero paid dispatch, failed append, restart settlement, exact-once replay uncertain receipt and real hard-crash recovery PASS');
  } finally {await f.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
