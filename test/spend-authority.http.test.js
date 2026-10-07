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
    // ---- the Commander's way out: SETTINGS › SPENDING LIMITS lists the interrupted run and books what the provider charged ----
    const settle=b=>f.json('POST','/api/budget/settle',b);
    let st=(await status()).body;
    assert.equal(st.unsettled.length,1,'the interrupted run is listed for the Commander');
    const crashed=st.unsettled[0];
    assert.equal(crashed.agentId,'agent');assert.equal(crashed.provider,'openrouter');assert.equal(crashed.model,'test/spend');assert.equal(typeof crashed.ts,'number');
    assert.equal(crashed.runCapUsd,null,'no per-run limit was set, so none is claimed');
    assert.ok(st.atLeast&&Math.abs(st.atLeast.today-1.2)<1e-9,'the booked rows are kept as a floor (an unsettled receipt no longer wipes history)');
    assert.equal(st.spentToday,null,'the exact total stays unknown until it is settled');
    const resumeRefused=await f.json('POST','/api/budget/resume',{scope:'day'});
    assert.equal(resumeRefused.status,409);assert.equal(resumeRefused.body.code,'spend_history_unavailable','resume names the real reason, not "not governed"');
    assert.equal((await settle({runId:crashed.runId,usd:-1})).status,400,'a negative charge is refused');
    assert.equal((await settle({runId:crashed.runId,usd:'abc'})).status,400,'a non-number is refused');
    assert.equal((await settle({runId:crashed.runId,mode:'limit'})).status,400,'no recorded limit -> nothing to count it at');
    assert.equal((await settle({runId:'nope',usd:0})).status,404,'only a run found unsettled can be settled');
    assert.equal(fs.readdirSync(dir).length,1,'refusals keep the receipt');
    const settled=await settle({runId:crashed.runId,usd:0.3});
    assert.equal(settled.status,200);assert.ok(Math.abs(settled.body.spentToday-1.5)<1e-9,'the entered charge joins the history');
    assert.equal(settled.body.unsettled.length,0);assert.equal(settled.body.atLeast,null);assert.equal(fs.readdirSync(dir).length,0,'the receipt is removed');
    const row=fs.readFileSync(ledger,'utf8').trim().split('\n').map(l=>JSON.parse(l)).find(r=>r.runId===crashed.runId);
    assert.ok(row&&row.usd===0.3&&row.attested===true&&row.ts===crashed.ts,'one attested row at the dispatch time');
    assert.equal(row.attestedAs,'entered','the row says the Commander entered that charge');
    assert.equal((await settle({runId:crashed.runId,usd:0.3})).status,404,'a second settle cannot double-book');
    hold=false;await run();assert.equal(calls,3,'the chosen limit works again: the next run dispatches');
    await f.restart();st=(await status()).body;
    assert.ok(Math.abs(st.spentToday-1.9)<1e-9,'settlement survives restart exactly once');assert.equal(st.unsettled.length,0);
    // ---- a run that started under a per-run limit can be counted at that limit, one click (SPEND-4 receipt) ----
    await f.stop();await f.start({SKYNET_BUDGET_PER_RUN:'0.75',SKYNET_BUDGET_PER_DAY:'10'});hold=true;
    const limited=run().catch(()=>null);
    for(let i=0;i<100&&calls<4;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(calls,4,'provider accepted the limited run before the crash');
    f.child.kill('SIGKILL');await f.stop();await limited;server.closeAllConnections();hold=false;
    await f.start({SKYNET_BUDGET_PER_DAY:'10'});st=(await status()).body;
    assert.equal(st.unsettled.length,1);assert.equal(st.unsettled[0].runCapUsd,0.75,'the receipt recorded the run\'s own per-run limit');
    const limitedId=st.unsettled[0].runId;
    const counted=await settle({runId:limitedId,mode:'limit'});
    assert.equal(counted.status,200);assert.ok(Math.abs(counted.body.spentToday-2.65)<1e-9,'counted at its limit');assert.equal(counted.body.unsettled.length,0);
    const limitRow=fs.readFileSync(ledger,'utf8').trim().split('\n').map(l=>JSON.parse(l)).find(r=>r.runId===limitedId);
    assert.ok(limitRow&&limitRow.usd===0.75&&limitRow.attested===true&&limitRow.attestedAs==='limit','the row says it was counted at its limit, not entered');
    await f.restart({SKYNET_BUDGET_PER_DAY:'10'});assert.ok(Math.abs((await status()).body.spentToday-2.65)<1e-9,'and that survives restart');
    console.log('spend HTTP: unreadable history, zero paid dispatch, failed append, restart settlement, exact-once replay uncertain receipt and real hard-crash recovery PASS');
    console.log('spend HTTP: interrupted run listed, refused bad settles, Commander settle + limit settle, idempotent across restart PASS');
    // ---- a graceful Quit waits for the aborted run to book its spend (SPEND-9): no receipt is stranded ----
    hold=true;const quitRun=run().catch(()=>null);
    for(let i=0;i<100&&calls<5;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(calls,5,'provider accepted the request before Quit');
    const exited=new Promise(r=>f.child.once('exit',r));
    assert.equal((await f.json('POST','/api/lifecycle/quit')).status,202);
    await exited;await f.stop();await quitRun;server.closeAllConnections();hold=false;
    assert.equal(fs.existsSync(dir)?fs.readdirSync(dir).length:0,0,'a graceful Quit leaves no unsettled receipt');
    await f.start({SKYNET_BUDGET_PER_DAY:'10'});st=(await status()).body;
    assert.equal(st.unsettled.length,0);assert.ok(Math.abs(st.spentToday-2.65)<1e-9,'history stays known after a graceful Quit');
    console.log('spend HTTP: a graceful Quit books the aborted run before exit PASS');
  } finally {await f.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
