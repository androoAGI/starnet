'use strict';
// Production HTTP adapter with deterministic host events; no provider or credentials.
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeOpenAiCompat } = require('../sidecar/openai-compat');
(async () => {
  let scenario; let serial = 0;
  const api = makeOpenAiCompat({ now: () => 1000, newId: () => String(++serial),
    apiKey: () => 'outcomes-test-key-123456', readBody: async req => { let s=''; for await (const c of req) s+=c; return s; },
    runOnce: o => {
      if (scenario === 'throw') throw new Error('synchronous dispatch failure');
      o.emit('agent.run.start', {runId:o.runId});
      o.emit('agent.token', {delta:'partial evidence'});
      o.emit('agent.cost', {tokensIn:7,tokensOut:3});
      o.emit('agent.run.error', {message:'provider failure'});
      if (scenario !== 'missing') o.emit('agent.run.end', {reason:scenario});
    }
  });
  const server=http.createServer((req,res)=>api.handle(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer outcomes-test-key-123456','Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  try {
    for (const [reason,status,finish] of [['done','completed','stop'],['error','failed','error'],['budget','limited','length'],['max_iters','limited','length'],['cancelled','cancelled','error'],['clarifying','awaiting_input','stop'],['refusal','refused','stop'],['missing','interrupted','error']]) {
      scenario=reason;
      for (const stream of [false,true]) {
        const res=await post('/v1/chat/completions',{stream,messages:[{role:'user',content:reason}]});
        assert.equal(res.status,200);
        const raw=await res.text();
        const result=stream ? raw.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))).at(-1) : JSON.parse(raw);
        assert.equal(result.starnet.status,status);
        assert.equal(result.starnet.completed,reason==='done');
        assert.equal(result.choices[0].finish_reason,finish);
        assert.equal(result.usage.total_tokens,10);
        assert.ok(raw.includes('partial evidence'));
        if (reason==='done') assert.equal(result.starnet.error,null,'recovered failures cannot poison successful end');
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
    console.log('openai-outcomes: all 8 terminal scenarios passed across sync, stream and run status; synchronous throw passed');
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
