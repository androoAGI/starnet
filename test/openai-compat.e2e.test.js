/* node test/openai-compat.e2e.test.js — TRUE end-to-end for the OpenAI-compatible /v1 surface: boot the ACTUAL
   sidecar process and drive /v1/* over real HTTP through runOnce → loop → mocked provider → cost → SSE.

   Asserts:
     (a) NO key configured                       -> every /v1/* answers 403 (api_disabled)
     (b) bad bearer                              -> 401 (invalid_api_key)
     (c) good key                                -> GET /v1/models lists starnet-agent
     (d) POST /v1/chat/completions (sync)        -> a real completion + REAL usage numbers from the mock provider
     (e) POST /v1/chat/completions stream:true   -> chat.completion.chunk deltas then a final chunk then [DONE]
     (f) POST /v1/runs                           -> 202 {run_id,status:started}; events SSE reaches run.completed
     (g) concurrency cap                         -> a 2nd run while one is in flight answers 429 (rate_limit_exceeded)

   The upstream LLM is mocked via SKYNET_OPENROUTER_BASE (no real key, no network). Modeled on e2e.run.test.js. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const KEY = 'e2e-strong-key-0123456789abcdef';   // >=16 chars so /v1 is allowed to enable

// ---- a mock OpenRouter: /models -> a minimal catalog; /chat/completions -> a short SSE completion ----
function startMockOpenRouter() {
  const toolsByPrompt = [];   // issue #96: the tool names each main-run request ADVERTISED, keyed by the last user turn
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          try { const pb = JSON.parse(body); const msgs = pb.messages || []; const lu = [...msgs].reverse().find(m => m && m.role === 'user');
            toolsByPrompt.push({ user: String((lu && lu.content) || ''), tools: (pb.tools || []).map(t => t && t.function && t.function.name) }); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          // DRIPFEED sentinel: a long slow stream so the concurrency test can hold a run in flight.
          if (body.indexOf('DRIPFEED') >= 0) {
            let i = 0;
            const t = setInterval(() => {
              try {
                if (res.writableEnded || res.destroyed) { clearInterval(t); return; }
                if (i < 40) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'drip ' } }] }) + '\n\n'); i++; }
                else { clearInterval(t); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 40, total_tokens: 44 } }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); }
              } catch (_) { clearInterval(t); }
            }, 150);
            res.on('close', () => clearInterval(t));
            return;
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ', world' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, toolsByPrompt, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// spawn the real sidecar; resolve once it logs its listen URL. Retries the next port on EADDRINUSE.
function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

// read an SSE/NDJSON-ish response fully into a string.
async function drain(res) {
  const rd = res.body.getReader(); const dec = new TextDecoder(); let raw = '';
  while (true) { const { value, done } = await rd.read(); if (done) break; raw += dec.decode(value, { stream: true }); }
  return raw;
}

(async () => {
  const mock = await startMockOpenRouter();
  const baseEnv = { SKYNET_OPENROUTER_BASE: mock.base, OPENROUTER_KEY: 'sk-or-e2e-fake', STARNET_DEFAULT_MODEL: 'test/model' };

  // ---- (a) NO key configured -> /v1/* is disabled (403) ----------------------------------------------------
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-v1-nokey-'));
    const { child, port } = await boot(8940 + (process.pid % 40), Object.assign({ SKYNET_WORKSPACES: ws }, baseEnv), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const models = await fetch(B + '/v1/models');
      A.eq(models.status, 403, '(a) /v1/models is 403 when no API key is configured');
      const mj = await models.json();
      A.eq(mj.error.code, 'api_disabled', '(a) the 403 body explains the API is disabled');
      const cc = await fetch(B + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
      A.eq(cc.status, 403, '(a) /v1/chat/completions is 403 with no key');
      // /health stays open (liveness probe, no auth)
      const h = await fetch(B + '/health');
      A.eq(h.status, 200, '(a) /health answers 200 without auth');
      A.eq((await h.json()).status, 'ok', '(a) /health reports ok');
    } finally { try { child.kill(); } catch (_) {} }
  }

  // ---- keyed sidecar for (b)-(g). max-concurrent 1 so the 429 path is cheap to induce. ---------------------
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-v1-'));
  const env = Object.assign({ SKYNET_WORKSPACES: ws, STARNET_API_KEY: KEY, STARNET_V1_MAX_CONCURRENT: '1' }, baseEnv);
  const { child, port } = await boot(8970 + (process.pid % 40), env, 20);
  const B = 'http://' + HOST + ':' + port;
  const auth = { Authorization: 'Bearer ' + KEY };
  try {
    // ---- (b) bad bearer -> 401 -----------------------------------------------------------------------------
    const bad = await fetch(B + '/v1/models', { headers: { Authorization: 'Bearer wrong-key-wrong-key-000' } });
    A.eq(bad.status, 401, '(b) a bad bearer key is rejected 401');
    A.eq((await bad.json()).error.code, 'invalid_api_key', '(b) the 401 body names invalid_api_key');

    // ---- (c) good key -> /v1/models lists ------------------------------------------------------------------
    const models = await fetch(B + '/v1/models', { headers: auth });
    A.eq(models.status, 200, '(c) /v1/models is 200 with the right bearer');
    const mj = await models.json();
    A.eq(mj.object, 'list', '(c) /v1/models returns an OpenAI list');
    A.ok((mj.data || []).some(m => m.id === 'starnet-agent'), '(c) the advertised model starnet-agent is listed');

    // ---- (d) sync chat/completions -> real completion + REAL usage ----------------------------------------
    const ccRes = await fetch(B + '/v1/chat/completions', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify({ model: 'starnet-agent', messages: [{ role: 'user', content: 'hi' }] }) });
    A.eq(ccRes.status, 200, '(d) sync chat/completions returns 200');
    const cc = await ccRes.json();
    A.eq(cc.object, 'chat.completion', '(d) response is a chat.completion');
    A.ok(String(cc.choices[0].message.content).indexOf('Hello') >= 0, '(d) the reply is the mock provider completion');
    A.eq(cc.choices[0].finish_reason, 'stop', '(d) finish_reason is stop');
    A.ok(cc.usage && cc.usage.total_tokens > 0, '(d) usage carries real (non-zero) token counts');
    A.eq(cc.usage.prompt_tokens + cc.usage.completion_tokens, cc.usage.total_tokens, '(d) usage totals are internally consistent (real, not synthesized)');
    A.eq(cc.usage.total_tokens, 6, '(d) usage matches the mock provider numbers exactly (prompt 4 + completion 2)');
    // issue #96: /v1's own prompt says "use your REAL tools" — the provider request must actually carry them
    const hiCall = mock.toolsByPrompt.find(r => r.user === 'hi');
    A.ok(hiCall && hiCall.tools.length > 0, '(d) the /v1 run advertised tools to the model: ' + JSON.stringify(hiCall && hiCall.tools.slice(0, 8)));
    A.ok(hiCall && hiCall.tools.some(n => /^fs_(read|write)$/.test(n)), '(d) including a real file tool (fs_read/fs_write)');

    // ---- (e) stream:true -> chat.completion.chunk deltas then [DONE] --------------------------------------
    const stRes = await fetch(B + '/v1/chat/completions', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify({ model: 'starnet-agent', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    A.eq(stRes.status, 200, '(e) streaming chat/completions returns 200');
    A.ok(String(stRes.headers.get('content-type') || '').indexOf('text/event-stream') >= 0, '(e) the stream is an SSE response');
    const raw = await drain(stRes);
    A.ok(raw.indexOf('data: [DONE]') >= 0, '(e) the stream terminates with the [DONE] sentinel');
    const chunks = raw.split('\n').map(l => l.trim()).filter(l => l.indexOf('data: ') === 0 && l.indexOf('[DONE]') < 0).map(l => { try { return JSON.parse(l.slice(6)); } catch (_) { return null; } }).filter(Boolean);
    A.ok(chunks.length >= 2, '(e) multiple chat.completion.chunk frames streamed');
    A.ok(chunks.every(c => c.object === 'chat.completion.chunk'), '(e) every frame is a chat.completion.chunk');
    A.eq(chunks[0].choices[0].delta.role, 'assistant', '(e) the first chunk carries the assistant role delta');
    A.ok(chunks.map(c => (c.choices[0].delta && c.choices[0].delta.content) || '').join('').indexOf('Hello') >= 0, '(e) the streamed deltas reassemble the real completion');
    const finish = chunks.filter(c => c.choices[0].finish_reason).pop();
    A.eq(finish.choices[0].finish_reason, 'stop', '(e) a terminal chunk carries finish_reason stop');
    A.ok(finish.usage && finish.usage.total_tokens === 6, '(e) the terminal chunk carries the real usage numbers');

    // ---- (f) /v1/runs -> 202, then events SSE reaches run.completed ---------------------------------------
    const runRes = await fetch(B + '/v1/runs', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify({ model: 'starnet-agent', input: 'do a small thing' }) });
    A.eq(runRes.status, 202, '(f) POST /v1/runs answers 202');
    const rj = await runRes.json();
    A.eq(rj.status, 'started', '(f) the 202 body says status started');
    A.ok(/^run_/.test(rj.run_id), '(f) a run_id is returned');
    // stream the lifecycle events until run.completed
    const evRes = await fetch(B + '/v1/runs/' + rj.run_id + '/events', { headers: auth });
    A.eq(evRes.status, 200, '(f) the events endpoint streams (200)');
    const evRaw = await drain(evRes);
    const evs = evRaw.split('\n').map(l => l.trim()).filter(l => l.indexOf('data: ') === 0).map(l => { try { return JSON.parse(l.slice(6)); } catch (_) { return null; } }).filter(Boolean);
    const names = evs.map(e => e.event);
    A.ok(names.indexOf('run.started') >= 0, '(f) a run.started lifecycle event was emitted');
    A.ok(names.indexOf('run.completed') >= 0, '(f) the run reached run.completed');
    const completed = evs.find(e => e.event === 'run.completed');
    A.ok(completed.usage && completed.usage.total_tokens > 0, '(f) run.completed carries real usage numbers');
    // poll status shows terminal completed
    const stat = await (await fetch(B + '/v1/runs/' + rj.run_id, { headers: auth })).json();
    A.eq(stat.status, 'completed', '(f) GET /v1/runs/{id} reports completed');

    // ---- (g) concurrency cap -> 429 while a run is in flight ----------------------------------------------
    {
      // hold one run in flight with a raw socket (so we can destroy it) driving the DRIPFEED slow stream.
      const held = await new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('no stream data before the cap test')), 8000);
        const rq = http.request({ host: HOST, port, path: '/v1/chat/completions', method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth) }, (rs) => {
          let n = 0; rs.on('data', () => { n++; if (n >= 1) { clearTimeout(guard); resolve(rq); } }); rs.on('error', () => {});
        });
        rq.on('error', () => {});
        rq.end(JSON.stringify({ model: 'starnet-agent', stream: true, messages: [{ role: 'user', content: 'DRIPFEED please stream slowly' }] }));
      });
      // a 2nd request now exceeds the max-concurrent=1 cap -> 429
      const over = await fetch(B + '/v1/chat/completions', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify({ model: 'starnet-agent', messages: [{ role: 'user', content: 'hi' }] }) });
      A.eq(over.status, 429, '(g) a run over the concurrency cap answers 429');
      A.eq((await over.json()).error.code, 'rate_limit_exceeded', '(g) the 429 body names rate_limit_exceeded');
      try { held.destroy(); } catch (_) {}   // free the in-flight run (client-disconnect interrupts it)
    }
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }
  // #96 follow-up: tools ride /v1, but a model the catalog KNOWS is tool-less still answers in text (pre-#96), never refused
  {
    const compat = fs.readFileSync(path.resolve(__dirname, '..', 'sidecar', 'openai-compat.js'), 'utf8');
    const core = fs.readFileSync(INDEX, 'utf8');
    A.ok(/isTask: !o\.outputOnly, toolsOptional: true/.test(compat), '/v1 runs are tasks with tools OPTIONAL');
    A.ok(/if \(isTask && o\.toolsOptional && provider\.supportsTools\(model\) === false\) isTask = false;/.test(core), 'a tools-optional run on a known tool-less model drops to text instead of the "can\'t run tasks" refusal');
    A.ok(core.indexOf('o.toolsOptional && provider.supportsTools(model) === false') < core.indexOf('fallbackChain.promoteToolCapable('), 'the text downgrade happens before any fallback promotion (the caller named its model)');
    // review findings: /v1 keeps its pre-#96 admission and never shares a per-agent durable brief or fires paid aux passes
    A.ok(/const imageTask = isTask && !o\.toolsOptional \?/.test(core) && /const directDomainTask = isTask && !o\.toolsOptional \?/.test(core), 'a /v1 request is never classified as an image/domain task ("Image task blocked: no STUDIO" on a text model)');
    A.ok(/if \(isTask && o\.taskKey && !o\.toolsOptional\) \{/.test(core), 'a /v1 request never prepares the per-agent durable brief (one client\'s open question cannot swallow the next client\'s request)');
    A.ok(/isTask && !o\.toolsOptional && !internal && _skillToolsOn/.test(core) && /SKYNET_SCOUT !== '0' && isTask && !o\.toolsOptional && _auxDone/.test(core), 'external /v1 traffic never fires skill review or scout on the user\'s key');
  }
  A.report('openai-compat.e2e');
})().catch(e => { console.error(e); process.exit(1); });
