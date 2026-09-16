'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

async function journey() {
  const original = 'User prefers rounded purple cards for Acme website design';
  const corrected = 'User does not prefer rounded purple cards for Acme website design';
  const approved = 'User prefers square blue cards for Acme website design; approved reference is acme/reference.png';
  let phase = 'create', sequence = 0, updateText = approved;
  const calls = [], proof = {};
  const server = http.createServer((req,res) => {
    let raw = ''; req.on('data',d=>raw+=d); req.on('end',()=> {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({data:[{id:'memory-fixture',context_length:32000,supported_parameters:['tools','tool_choice']}]}));
      }
      const body = JSON.parse(raw), messages = body.messages || [];
      const auxiliary = /agent reflecting right after/.test(String(messages[0]?.content));
      calls.push({phase,auxiliary,messages});
      let delta = {}, finish = 'stop';
      const tool = (name,args) => { delta={tool_calls:[{index:0,id:'memory_call_'+(++sequence),type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls'; };
      const lastUser = messages.map(m=>m.role).lastIndexOf('user');
      const since = messages.slice(lastUser+1);
      const did = name => since.some(m=>(m.tool_calls||[]).some(t=>t.function?.name===name));
      if (auxiliary) delta.content = phase === 'reflect' ? 'UPDATE note_1: '+updateText : 'NONE';
      else if (phase === 'create' || phase === 'correct') {
        if ((body.tools||[]).some(t=>t.function?.name==='brief_proceed') && !did('brief_proceed')) tool('brief_proceed',{objective:'Save the explicit Acme design preference in durable memory'});
        else if (!did('notebook_write')) tool('notebook_write',phase==='create'
          ? {title:'Acme design',body:original,pinned:true,scope:'stream'}
          : {title:'Acme design',body:corrected,replaceId:'note_1',previousBody:original,pinned:true});
        else delta.content = "I've saved your design preferences.";
      } else if (phase === 'stop') delta.content = "I'll work on that.";
      else if (phase === 'claim') delta.content = "I've saved your design preferences.";
      else delta.content = 'The request has been reviewed. '+ 'The approved design reference is available for the next iteration. '.repeat(4);
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const providerBase='http://127.0.0.1:'+server.address().port+'/v1';
  const live = process.env.STARNET_MEMORY_LIVE_URL;
  const fixture = live ? null : SidecarFixture.create({prefix:'memory-corrections-',timeoutMs:20000,env:{
    SKYNET_FULL_ACCESS:'1',STARNET_FULL_ACCESS:'1',SKYNET_AUX_BUDGET:'1',STARNET_AUX_BUDGET:'1',
    SKYNET_OPENROUTER_KEY:'memory-fixture',STARNET_OPENROUTER_KEY:'memory-fixture',
    SKYNET_OPENROUTER_BASE:providerBase,STARNET_OPENROUTER_BASE:providerBase,
    SKYNET_DEFAULT_MODEL:'memory-fixture',STARNET_DEFAULT_MODEL:'memory-fixture'
  }});
  if(fixture && process.argv.includes('--seeded')) {
    fixture.entry=path.resolve(__dirname,'../dev/seed.js'); fixture.args=['--keep']; fixture.timeoutMs=30000;
    fs.cpSync(path.resolve(__dirname,'../dev/fixtures/seed-workspace'),fixture.workspace,{recursive:true});
    // The seed owns a sidecar child. Reap only this fixture's process tree on Windows.
    const stop=fixture.stop.bind(fixture);
    fixture.stop=async()=>{if(process.platform==='win32'&&fixture.child){require('node:child_process').spawnSync('taskkill',['/PID',String(fixture.child.pid),'/T','/F'],{windowsHide:true});}await stop();};
  }
  let token = '';
  const request = async(route,options={}) => {
    if (fixture) return fixture.request(route,options);
    return fetch(live+route,{...options,headers:{...options.headers,Origin:live,'X-StarNet-Token':token}});
  };
  const json = async(method,route,body)=> {
    const r=await request(route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const run = async(text,streamId='acme',isTask=true)=> {
    const r=await request('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId:'agent',provider:'openrouter',model:'memory-fixture',key:'memory-fixture',baseUrl:providerBase,isTask,streamId,objects:['computer','notebook'],messages:[{role:'user',content:text}]})});
    const raw=await r.text(); assert.equal(r.status,200,raw);
    const events=raw.split('\n').filter(Boolean).map(l=>JSON.parse(l));
    return events;
  };
  const records=async()=> (await json('GET','/api/memory/records?agent=agent')).body.records;
  const pending=async()=> (await json('GET','/api/memory/pending?agent=agent')).body.pending;
  try {
    if(fixture) await fixture.start(); else token=await require('./_httpToken.js').bootToken(live,live);
    await json('POST','/api/memory/config',{reflectEnabled:false});
    proof.create=await run('Save this approved Acme design: '+original);
    assert.equal(proof.create.find(e=>e.name==='agent.run.end').payload.reason,'done','a real write permits the save claim');
    assert.equal((await records()).length,1,JSON.stringify(proof.create));
    phase='correct'; proof.correct=await run('Correct the saved Acme preference: '+corrected);
    assert.equal(proof.correct.find(e=>e.name==='agent.run.end').payload.reason,'done','a real update permits the save claim');
    assert.equal((await records()).length,1);
    assert.equal((await records())[0].body,corrected);
    assert.equal((await records())[0].revision,1);
    phase='followup'; const start=calls.length;
    await run('Make another one','acme',false);
    const recall=calls.slice(start).flatMap(c=>c.messages).filter(m=>String(m.content).includes('<recalled-memory>'));
    assert.ok(recall.some(m=>m.content.includes(corrected)));
    assert.ok(recall.every(m=>!m.content.includes('— '+original)));
    const other=calls.length; await run('Make another one','unrelated',false);
    assert.ok(calls.slice(other).every(c=>!c.messages.some(m=>String(m.content).includes('<recalled-memory>'))));
    await json('POST','/api/memory/config',{reflectEnabled:true,reflectCooldownMs:0});
    phase='reflect'; proof.reflect=await run('The approved Acme design is now square and blue. '+approved);
    let p;
    for(let i=0;i<80;i++){p=(await pending())?.[0];if(p)break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(p,'reflection must queue the changed preference');
    assert.equal(p.replaceId,'note_1'); assert.equal(p.previousBody,corrected);
    assert.equal((await records())[0].body,corrected,'proposal does not silently replace approved state');
    proof.pending=p;
    if(fixture){await fixture.restart();p=(await pending())[0];assert.equal(p.replaceId,'note_1');}
    if(process.env.STARNET_MEMORY_UI_READY) {
      fs.writeFileSync(process.env.STARNET_MEMORY_UI_READY,JSON.stringify({baseUrl:fixture?.baseUrl||live,pending:p}));
      const until=Date.now()+180000;
      while(Date.now()<until && (await records())[0].body!==approved)await new Promise(r=>setTimeout(r,250));
      assert.equal((await records())[0].body,approved,'the live UI must apply the reviewed correction');
      proof.uiKept=true;
    } else {
      const kept=await json('POST','/api/memory/turnin',{agentId:'agent',runId:p.runId,id:p.id,verdict:'keep'});
      assert.equal(kept.status,200,JSON.stringify(kept));
    }
    assert.equal((await records()).length,1);assert.equal((await records())[0].body,approved);
    if(fixture){await fixture.restart();assert.equal((await records())[0].body,approved);}
    // A delayed review cannot clobber a newer explicit edit.
    phase='reflect';updateText='User prefers square green cards for Acme website design';
    await run('Change the Acme cards to green. '+updateText,'acme_changed');
    for(let i=0;i<80;i++){p=(await pending())?.[0];if(p)break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(p);await json('POST','/api/memory/edit',{agentId:'agent',id:'note_1',content:'User explicitly selected monochrome Acme cards'});
    const stale=await json('POST','/api/memory/turnin',{agentId:'agent',runId:p.runId,id:p.id,verdict:'keep'});
    assert.equal(stale.status,409);assert.match((await records())[0].body,/monochrome/);
    assert.equal((await pending()).length,1,'failed correction stays available for review');
    await json('POST','/api/memory/turnin',{agentId:'agent',runId:p.runId,id:p.id,verdict:'discard'});
    phase='stop';proof.stop=await run('Inspect the station and report the result','stop');
    assert.equal(proof.stop.find(e=>e.name==='agent.run.end').payload.reason,'error');
    assert.ok(proof.stop.some(e=>e.name==='agent.run.error'&&/incomplete/.test(e.payload.message)));
    phase='claim';proof.claim=await run('Save my reply preference','claim');
    assert.equal(proof.claim.find(e=>e.name==='agent.run.end').payload.reason,'error');
    assert.ok(proof.claim.some(e=>e.name==='agent.run.error'&&/write receipt/.test(e.payload.message)));
    proof.records=await records();proof.calls=calls.map(c=>({phase:c.phase,auxiliary:c.auxiliary,recall:c.messages.filter(m=>String(m.content).includes('<recalled-memory>'))}));
    if(process.env.STARNET_MEMORY_PROOF){fs.mkdirSync(path.dirname(process.env.STARNET_MEMORY_PROOF),{recursive:true});fs.writeFileSync(process.env.STARNET_MEMORY_PROOF,JSON.stringify(proof,null,2));}
    console.log('memory-corrections.http.test: PASS (real writes, scoped recall, reviewed updates, restart, stale review, stops, save receipts)');
  } finally {if(fixture)await fixture.dispose();await new Promise(r=>server.close(r));}
}
journey().catch(e=>{console.error(e);process.exitCode=1;});
