'use strict';
// Production HTTP adapter with deterministic host events; no provider or credentials.
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeOpenAiCompat } = require('../sidecar/openai-compat');
const RunOutcome = require('../frontend/app/runoutcome.js');
(async () => {
  let scenario; let serial = 0;
  const api = makeOpenAiCompat({ now: () => 1000, newId: () => String(++serial),
    apiKey: () => 'outcomes-test-key-123456', readBody: async req => { let s=''; for await (const c of req) s+=c; return s; },
    runOnce: o => {
      if (scenario === 'throw') throw new Error('synchronous dispatch failure');
      // a DELEGATED run leaves through the station's own outcome sink (runOnceCore wraps the run's emit in RunOutcome.sink), and
      // team.dispatch forwards its worker's run.start / run.error / run.end onto the lead's stream under the WORKER's runId
      const delegated = scenario === 'delegated' || scenario === 'delegated-noend';
      const emit = delegated ? RunOutcome.sink(o.emit) : o.emit;
      emit('agent.run.start', {runId:o.runId});
      if (delegated) {
        emit('agent.run.start', {runId:'w1',agentId:'worker'});
        emit('agent.run.error', {runId:'w1',agentId:'worker',message:'openrouter http 429: rate limited',transient:true,failureCode:'rate_limit'});
        emit('agent.run.end', {runId:'w1',agentId:'worker',reason:'error',turns:1,usd:0});
      }
      emit('agent.token', {delta:'partial evidence'});
      emit('agent.cost', {tokensIn:7,tokensOut:3});
      // typed-outcomes (2026-10-29): a clean run raises no error of its own (the station has no recoverable agent.run.error — every
      // one ends its run, and an image task's unmet completion is a failure); 'done-after-error' is that case and settles failed
      if (!['done','cut','empty','delegated','delegated-noend'].includes(scenario)) emit('agent.run.error', {message:'provider failure', ...(scenario === 'policy' ? {failureCode:'content_policy_blocked'} : {})});
      const end = { done:{reason:'done'}, 'done-after-error':{reason:'done'}, cut:{reason:'done',finishReason:'length'}, policy:{reason:'error',failureCode:'content_policy_blocked'}, delegated:{runId:o.runId,reason:'done',turns:2,usd:0} }[scenario] || {reason:scenario};
      if (scenario !== 'missing' && scenario !== 'delegated-noend') emit('agent.run.end', end);
    }
  });
  const server=http.createServer((req,res)=>api.handle(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer outcomes-test-key-123456','Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  try {
    for (const [reason,status,finish] of [['done','completed','stop'],['error','failed','error'],['budget','limited','length'],['max_iters','limited','length'],['cancelled','cancelled','cancelled'],['clarifying','awaiting_input','stop'],['refusal','refused','stop'],['missing','interrupted','error'],
      // the run's own outcome (RunOutcome): a provider-cut reply is limited, a safety block is refused, an error outranks a done end
      ['cut','limited','length'],['policy','refused','content_filter'],['done-after-error','failed','error'],
      // a delegated worker's failure is the worker's: the lead that recovered and finished is completed, and a lead that never
      // ended is interrupted — the worker's error and end never stand in for the lead's
      ['delegated','completed','stop'],['delegated-noend','interrupted','error']]) {
      scenario=reason;
      for (const stream of [false,true]) {
        const res=await post('/v1/chat/completions',{stream,messages:[{role:'user',content:reason}]});
        assert.equal(res.status,200);
        const raw=await res.text();
        const result=stream ? raw.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))).at(-1) : JSON.parse(raw);
        assert.equal(result.starnet.status,status);
        assert.equal(result.starnet.completed,status==='completed');
        assert.equal(result.choices[0].finish_reason,finish);
        assert.equal(result.usage.total_tokens,10);
        assert.ok(raw.includes('partial evidence'));
        if (status==='completed') { assert.equal(result.starnet.error,null,'a clean end carries no error, and never the error of a delegated worker'); assert.equal(result.starnet.failure_code,null); assert.equal(result.error,undefined); }
        // review r7: a run someone STOPPED is no error — finish_reason says 'cancelled' and no OpenAI `error` object rides it (a client read
        // finish_reason 'error' + agent_error as a failure, and retried)
        if (status==='cancelled') { assert.equal(result.error,undefined,'a stopped run carries no agent_error'); assert.equal(result.starnet.failed,false); }
        assert.equal(result.starnet.outcome,{done:'succeeded',error:'failed',budget:'out_of_budget',max_iters:'step_limit',cancelled:'stopped',clarifying:'asked',refusal:'refused',missing:'failed',cut:'cut_short',policy:'refused','done-after-error':'failed',delegated:'succeeded','delegated-noend':'failed'}[reason],'the station outcome rides along');
        if(stream) assert.ok(raw.endsWith('data: [DONE]\n\n'));
      }
      const run=await (await post('/v1/runs',{input:reason})).json();
      const events=await (await fetch(base+'/v1/runs/'+run.run_id+'/events',{headers})).text();
      assert.ok(events.includes('run.'+status));
      const state=await (await fetch(base+'/v1/runs/'+run.run_id,{headers})).json();
      assert.equal(state.status,status); assert.equal(state.output,'partial evidence'); assert.equal(state.usage.total_tokens,10);
    }
    scenario='throw';
    const failed=await post('/v1/chat/completions',{messages:[{role:'user',content:'throw'}]});
    assert.equal(failed.status,502); assert.match((await failed.json()).error.message,/synchronous dispatch failure/);
    // an EMPTY reply is a failure that says so (it read "interrupted … without a successful terminal event")
    scenario='empty';
    const empty=await (await post('/v1/chat/completions',{messages:[{role:'user',content:'empty'}]}));
    assert.equal(empty.status,200,'the partial evidence keeps the 200');
    const ej=await empty.json();
    assert.equal(ej.starnet.status,'failed'); assert.equal(ej.starnet.outcome,'empty'); assert.match(ej.starnet.error,/empty reply/);
    console.log('openai-outcomes: all 13 terminal scenarios passed across sync, stream and run status; empty and synchronous throw passed');
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
