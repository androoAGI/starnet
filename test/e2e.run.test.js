/* node test/e2e.run.test.js — TRUE end-to-end: boot the ACTUAL sidecar process and drive a streaming run over
   HTTP through the real loop/provider/cost/SSE path, with the upstream LLM mocked via SKYNET_OPENROUTER_BASE.
   This is the gap the readiness sweep flagged: every other suite is unit/replay-level; nothing booted the real
   server AND streamed a run. Here we POST /api/run and assert the NDJSON carries agent.run.start, agent.token
   deltas, a reconciled agent.cost, and exactly one agent.run.end{reason:'done'} — no real key, no network. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const fs = require('fs');
const { spawn } = require('child_process');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// ---- a mock OpenRouter: /models -> a minimal catalog; /chat/completions -> a short SSE completion ----
function startMockOpenRouter() {
  const requests = [];   // H1.2: capture each request's messages so a test can assert what reached the provider
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let parsed = null; try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          // PAIRRECOVERY sentinel: enforce the provider's real tool-pair invariant so the full sidecar
          // regression below would 400 forever without the OpenRouter adapter's transcript repair.
          if (body.indexOf('PAIRRECOVERY') >= 0) {
            const open = new Set();
            let invalid = '';
            for (const msg of (parsed && parsed.messages) || []) {
              if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) open.add(String(tc && tc.id || ''));
              } else if (msg && msg.role === 'tool') {
                const id = String(msg.tool_call_id || '');
                if (!id || !open.delete(id)) invalid = 'No tool call found for tool result ' + id;
              } else if (open.size) invalid = 'Tool call has no result';
            }
            if (open.size) invalid = 'Tool call has no result';
            if (invalid) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: invalid, code: 400 } }));
              return;
            }
          }
          // KABOOM sentinel: a hard non-retryable provider failure (401 auth) whose message carries a
          // distinctive needle — used to provoke a REAL recorded run error for the diagnostics-tail tests.
          if (body.indexOf('KABOOM') >= 0) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'KABOOM-DIAG-NEEDLE: mock provider rejected this run', code: 401 } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          // DOMAINSTOP sentinel: one exact-host fetch; terminal evidence leaves only a final report turn.
          if (body.indexOf('DOMAINSTOP') >= 0) {
            const hasToolResult = !!(parsed && (parsed.messages || []).some(m => m && m.role === 'tool'));
            if (!hasToolResult) {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'domain_fetch', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://starnessos.invalid/docs' }) } }] } }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } }) + '\n\n');
            } else {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'The exact host does not resolve; please send the corrected URL.' } }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }) + '\n\n');
            }
            res.write('data: [DONE]\n\n'); res.end(); return;
          }
          // CODEMODE sentinel: actual tool call on turn one, final answer after its result on turn two.
          if (body.indexOf('CODEMODE') >= 0) {
            const hasToolResult = !!(parsed && (parsed.messages || []).some(m => m && m.role === 'tool'));
            if (!hasToolResult) {
              const code = "const raw = await tool('tool.search', {query:'browser screenshot'}); return {nestedBytes:String(raw).length};";
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'code_outer', type: 'function', function: { name: 'code_run', arguments: JSON.stringify({ code }) } }] } }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } }) + '\n\n');
            } else {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Code mode complete.' } }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) + '\n\n');
            }
            res.write('data: [DONE]\n\n'); res.end(); return;
          }
          const write = () => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ', world' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          };
          // DRIPFEED sentinel: a LONG slow stream (40 chunks × 150ms ≈ 6s) so a test can kill the client
          // socket mid-generation and observe the sidecar noticing. res 'close' stops the drip (req 'close'
          // fires at message completion on Node ≥15 — the very trap the F1 disconnect test guards).
          if (body.indexOf('DRIPFEED') >= 0) {
            let i = 0;
            const t = setInterval(() => {
              try {
                if (res.writableEnded || res.destroyed) { clearInterval(t); return; }
                if (i < 40) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'drip ' } }] }) + '\n\n'); i++; }
                else {
                  clearInterval(t);
                  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 40, total_tokens: 44 } }) + '\n\n');
                  res.write('data: [DONE]\n\n'); res.end();
                }
              } catch (_) { clearInterval(t); }
            }, 150);
            res.on('close', () => clearInterval(t));
            return;
          }
          // SLOWPOKE sentinel: stall before answering so the sidecar's run stream sits event-silent — the
          // window the NDJSON keep-alive heartbeat must cover.
          if (body.indexOf('SLOWPOKE') >= 0) setTimeout(write, 300); else write();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
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

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_STREAM_KA_MS: '40' };   // fast heartbeat so the KA test observes it in ms, not 20s
  const { child, port } = await boot(8840 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    // a bootstrapped API token is required for privileged /api routes (api-hardening).
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');

    // drive a real streaming run and collect the NDJSON event stream
    const res = await fetch(B + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e', messages: [{ role: 'user', content: 'hi' }] })
    });
    A.eq(res.status, 200, 'POST /api/run streams (200)');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', events = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line) { try { events.push(JSON.parse(line)); } catch (_) {} }
      }
    }
    const names = events.map(e => e.name);
    A.ok(names.indexOf('agent.run.start') >= 0, 'stream begins with agent.run.start');
    const tokens = events.filter(e => e.name === 'agent.token');
    A.ok(tokens.length >= 1, 'real token deltas streamed from the mocked provider');
    A.ok(tokens.map(t => t.payload.delta).join('').indexOf('Hello') >= 0, 'the streamed text is the mock completion');
    const cost = events.filter(e => e.name === 'agent.cost').pop();
    A.ok(cost && cost.payload.reconciled === true, 'a reconciled agent.cost is emitted');
    const ends = events.filter(e => e.name === 'agent.run.end');
    A.eq(ends.length, 1, 'exactly one agent.run.end');
    A.eq(ends[0].payload.reason, 'done', 'the run completes with reason done');
    const firstReq = mock.requests[0] || {};
    const firstSystem = (((firstReq.messages || [])[0] || {}).content) || '';
    A.ok(firstSystem.indexOf('[RUNTIME]') >= 0, 'runtime identity block reaches the provider system prompt');
    A.ok(firstSystem.indexOf('Provider: openrouter') >= 0, 'runtime block names the selected provider');
    A.ok(firstSystem.indexOf('Requested model at run start: test/model') >= 0, 'runtime block names the requested model');
    A.ok(firstSystem.indexOf('If the Commander asks what StarNet build, model, provider') >= 0, 'runtime block tells the agent to answer build/model/provider questions from host state');

    // CURRENT-RELEASE INCIDENT: an orphaned tool result used to pass straight through OpenRouter and make
    // every replay fail with the same provider 400. Drive the malformed history through the real HTTP route,
    // loop, adapter, and enforcing upstream; the adapter must preserve the result as labeled text and finish.
    {
      const before = mock.requests.length;
      const r = await fetch(B + '/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({
          key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'pair-recovery-e2e',
          messages: [
            { role: 'user', content: 'PAIRRECOVERY continue this interrupted run' },
            { role: 'tool', tool_call_id: 'orphan_live_1', content: 'PAIRRECOVERY preserved result' }
          ]
        })
      });
      const raw = await r.text();
      const evs = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      A.ok(evs.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'orphaned OpenRouter history completes through the real sidecar instead of provider 400');
      const wire = mock.requests.slice(before).find(q => JSON.stringify((q && q.messages) || []).indexOf('PAIRRECOVERY') >= 0) || {};
      A.ok(!(wire.messages || []).some(m => m && m.role === 'tool' && m.tool_call_id === 'orphan_live_1'), 'the invalid orphan never reaches the provider as a tool result');
      A.ok((wire.messages || []).some(m => m && m.role === 'user' && String(m.content).indexOf('[recovered tool result orphan_live_1') >= 0 && String(m.content).indexOf('preserved result') >= 0), 'the provider receives a truthful recovery label with the original result content');
    }

    // The managed StarNet route shares the generic adapter with custom endpoints. Exercise that adapter
    // through the real run loop too; direct OpenRouter coverage alone missed this recovery gap.
    {
      const before = mock.requests.length;
      const r = await fetch(B + '/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ provider: 'custom', baseUrl: mock.base, key: 'fixture-only', model: 'test/model', agentId: 'compatible-pair-e2e',
          messages: [{ role: 'user', content: 'PAIRRECOVERY compatible route' }, { role: 'tool', tool_call_id: '', content: 'PAIRRECOVERY evidence survives' }] })
      });
      const raw = await r.text();
      const evs = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      A.ok(evs.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'compatible route recovers malformed tool history through the real sidecar');
      const wire = mock.requests.slice(before).find(q => (q.messages || []).some(m => m.role === 'user' && m.content === 'PAIRRECOVERY compatible route'));
      A.ok(wire && wire.messages.some(m => m.role === 'user' && String(m.content).includes('[recovered tool result') && String(m.content).includes('evidence survives')), 'compatible wire retains orphan evidence as labeled recovery text');
      A.ok(evs.some(e => e.name === 'agent.cost' && e.payload.reconciled === true), 'compatible recovery still emits reconciled cost');
    }

    // TYPED COMPLETION CONTRACT: a clean provider stop without the requested mechanical proof must remain
    // incomplete on both the live event and the durable run row. Model prose cannot promote it.
    {
      const r = await fetch(B + '/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({
          key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'postcondition-e2e', isTask: true,
          messages: [{ role: 'user', content: 'Say hello, but this workflow requires an exact check.' }],
          postconditions: { requirements: [{ id: 'check', type: 'verification_passed', command: 'npm test' }] }
        })
      });
      const raw = await r.text();
      const evs = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      const end = evs.find(e => e.name === 'agent.run.end');
      A.eq(end && end.payload.completionVerdict, 'incomplete', 'live run end refuses completion without the contracted check');
      A.eq(end && end.payload.effectVerdict, 'no_observed_effects', 'live run end carries the bounded effect verdict');
      const runId = ((evs.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId;
      const rows = await (await fetch(B + '/api/runs?agent=postcondition-e2e&runId=' + encodeURIComponent(runId), { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      const saved = (rows.runs || [])[0];
      A.eq(saved && saved.completionEvidence.completionVerdict, 'incomplete', 'durable run history preserves the host assessment');
      A.eq(saved && saved.completionEvidence.checks[0].code, 'matching_verification_missing', 'durable history explains exactly which proof was missing');
    }

    // WAVE 3 LIVE PROOF: real sidecar -> provider tool call -> isolated worker -> parent-dispatched read.
    {
      const before = mock.requests.length;
      const r = await fetch(B + '/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'code-e2e', isTask: true, messages: [{ role: 'user', content: 'CODEMODE compose a read' }] })
      });
      // code.run is consent-gated (2026-09-23 security stopgap): stream the run and approve its prompt once,
      // over the SAME POST /api/consent the browser's consent card uses.
      const evs = [];
      {
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', runId = '';
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
            let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; }
            evs.push(ev);
            if (ev.name === 'agent.run.start') runId = ev.payload.runId;
            if (ev.name === 'permission.prompt') {
              fetch(B + '/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
                body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision: 'once' }) }).catch(() => {});
            }
          }
        }
      }
      A.ok(evs.some(e => e.name === 'permission.prompt' && ['code.run', 'code_run'].indexOf(e.payload.tool) >= 0),'code.run asked the Commander before running model code');
      const called = evs.filter(e => e.name === 'agent.tool_call').map(e => e.payload.name);
      A.ok(called.indexOf('code_run') >= 0, 'real sidecar executed model-facing code.run through its provider-safe wire name');
      A.ok(called.indexOf('tool.search') >= 0, 'the child nested read re-entered parent tool telemetry');
      A.ok(evs.some(e => e.name === 'agent.tool_result' && String(e.payload.callId).indexOf(':nested:1') >= 0 && e.payload.ok), 'nested result is independently visible and successful');
      A.ok(evs.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'code-composed run completed cleanly');
      const codeRequests = mock.requests.slice(before);
      const continuation = codeRequests.find(q => (q.messages || []).some(m => m && m.role === 'tool'));
      const outerResult = continuation && (continuation.messages || []).find(m => m && m.role === 'tool' && m.tool_call_id === 'code_outer');
      A.ok(outerResult && /^\{"nestedBytes":\d+\}$/.test(String(outerResult.content)), 'provider saw only the child final aggregation');
      A.ok(String(outerResult && outerResult.content).indexOf('browser.screenshot') < 0, 'intermediate tool.search output stayed out of model context');
    }

    // LIVE INCIDENT PROOF: a misspelled one-host docs request is local, one-fetch, terminal, and timed.
    {
      const before = mock.requests.length;
      const r = await fetch(B + '/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', reasoningEffort: 'medium', agentId: 'e2e-domain', isTask: true, placed: ['dish'], messages: [{ role: 'user', content: 'DOMAINSTOP Check starnessos.invalid and read its docs.' }] })
      });
      const raw = await r.text();
      const evs = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      const calls = evs.filter(e => e.name === 'agent.tool_call');
      A.eq(calls.map(e => e.payload.name), ['web_fetch'], 'direct-domain live run executes exactly one local fetch (no delegation/search cascade)');
      A.ok(evs.some(e => e.name === 'agent.tool_result' && e.payload.callId === 'domain_fetch'), 'real web_fetch returned terminal domain evidence');
      const domainMain = mock.requests.slice(before).filter(q => JSON.stringify((q && q.messages) || []).indexOf('[DIRECT DOMAIN CHECK') >= 0);
      A.eq(domainMain.length, 2, 'terminal domain evidence permits exactly one tool-free synthesis turn');
      const synthesisTools = ((domainMain[1] && domainMain[1].tools) || []).map(t => t && t.function && t.function.name);
      A.ok(synthesisTools.length === 0, 'the synthesis request exposes zero tools (saw: ' + synthesisTools.join(', ') + ')');
      const firstDomainReq = domainMain[0];
      const offered = ((firstDomainReq && firstDomainReq.tools) || []).map(t => t && t.function && t.function.name);
      A.ok(offered.indexOf('team_dispatch') < 0 && offered.indexOf('web_search') < 0, 'lead is not offered delegation or expansive search for a single-host check');
      A.ok(offered.indexOf('browser_navigate') >= 0, 'the placed DISH keeps the browser on a single-host check (saw: ' + offered.join(', ') + ')');
      const runId = ((evs.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId;
      const runs = await (await fetch(B + '/api/runs?agent=e2e-domain&runId=' + encodeURIComponent(runId), { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      const row = (runs.runs || [])[0];
      A.ok(row && row.model === 'test/model' && row.reasoningEffort === 'medium', 'run row persists actual model + reasoning effort');
      A.ok(row && row.durationMs > 0 && Array.isArray(row.toolTrace) && row.toolTrace.length === 1, 'run row persists elapsed time and one tool trace');
      A.ok(row.toolTrace[0].ms >= 0 && row.toolTrace[0].name === 'web_fetch', 'per-tool elapsed milliseconds survive the API persistence boundary');
    }

    // H1.1: the run's full dialogue was persisted to the durable transcript (not just title+final) — fetch it back.
    const tr = await (await fetch(B + '/api/transcript?stream=global&agent=e2e&limit=20', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const turns = (tr && tr.turns) || [];
    A.ok(turns.some(t => t.role === 'user' && t.content === 'hi'), 'transcript captured the user directive');
    A.ok(turns.some(t => t.role === 'assistant' && String(t.content).indexOf('Hello') >= 0), 'transcript captured the assistant reply turn');

    // H1.2: bulletproof resume — a 2nd run on the SAME stream with EMPTY history must seed the prior dialogue.
    async function drive(streamId, text) {
      const r = await fetch(B + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e', streamId, messages: [{ role: 'user', content: text }] }) });
      const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; }   // drain
    }
    await drive('s1', 'remember alpha-token-42');   // run A: establishes the s1 transcript
    await drive('s1', 'what was it');               // run B: EMPTY history, same stream -> must seed run A back
    const lastReq = mock.requests[mock.requests.length - 1];
    const seeded = JSON.stringify((lastReq && lastReq.messages) || []);
    A.ok(seeded.indexOf('alpha-token-42') >= 0, 'H1.2: run B (empty history) seeded the prior turn from the transcript');
    A.ok(seeded.indexOf('what was it') >= 0, 'run B still carries its own new directive last');

    // H3.2: the RUNS history rows carry their streamId — the join that lets a row open its transcript.
    const runsJson = await (await fetch(B + '/api/runs?agent=e2e&limit=20', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((runsJson.runs || []).some(r => r.streamId === 's1'), 'H3.2: a RUNS row records its streamId (joins outcome -> transcript)');

    // ---- NDJSON keep-alive heartbeat (2026-07-07 multi-agent escape): while the run produces no events
    //      (provider stalled / a long tool like team.dispatch), the stream must NOT go byte-silent — blank
    //      lines prove the socket is alive, and every consumer skips them. SLOWPOKE stalls the mock 300ms
    //      with KA at 40ms, so heartbeats MUST appear between events; the run must still parse clean. ----
    {
      const r = await fetch(B + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e-ka', messages: [{ role: 'user', content: 'SLOWPOKE say hi' }] }) });
      const rd = r.body.getReader(); const dc = new TextDecoder(); let raw = '';
      while (true) { const { value, done } = await rd.read(); if (done) break; raw += dc.decode(value, { stream: true }); }
      const kaLines = raw.split('\n').filter(l => l.trim() === '').length;
      A.ok(kaLines >= 2, 'blank keep-alive lines rode the stream during the silent provider stall (got ' + kaLines + ')');
      const evs = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      A.ok(evs.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'the heartbeated run still streams and completes clean');
    }

    // ---- CONCURRENT SAME-AGENT SESSIONS (2026-07-18 lane): the old admission mutex is GONE — two runs of
    //      one agent must now run side by side and BOTH complete clean (the workspace lease only engages on
    //      mutating tools, which neither of these chat runs uses). ----
    {
      const drive2 = (agentId, text, streamId) => fetch(B + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId, streamId, messages: [{ role: 'user', content: text }] }) });
      const slow = drive2('dup-agent', 'SLOWPOKE hold the desk', 'dup-session-a'); // in flight ~300ms
      await new Promise(r => setTimeout(r, 60));                            // let the first run be admitted
      const second = await drive2('dup-agent', 'concurrent question', 'dup-session-b');   // same agent, second session
      const secondText = await second.text(); const slowText = await (await slow).text();  // drain both
      A.ok(secondText.indexOf('already running a task') < 0, 'a second same-agent run is ADMITTED (no mutex refusal)');
      const endsOf = raw => raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(e => e && e.name === 'agent.run.end').map(e => e.payload.reason);
      A.eq(endsOf(secondText)[0], 'done', 'the second session\'s concurrent run completed clean');
      A.eq(endsOf(slowText)[0], 'done', 'the first session\'s run ALSO completed clean (undisturbed by the overlap)');
    }

    // ---- diagnostics error tail SURVIVES A RESTART (2026-07-07 escape: run failed -> user restarted ->
    //      "Recent errors: (none recorded this session)" — the one artifact that explained the failure was
    //      RAM-only). Provoke a recorded run error (KABOOM: a hard 401 from the mock provider), reboot on
    //      the same workspace, and the error must still be in the report. ----
    {
      const r = await fetch(B + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'diag-agent', messages: [{ role: 'user', content: 'KABOOM please' }] }) });
      const rawErr = await r.text();
      A.ok(rawErr.indexOf('KABOOM-DIAG-NEEDLE') >= 0, 'the provider failure surfaced on the run stream (agent.run.error carries the provider message)');
      const d1 = await (await fetch(B + '/api/diagnostics', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.ok(d1.text.indexOf('KABOOM-DIAG-NEEDLE') >= 0, 'the run error is in this session\'s diagnostics tail');
    }

    // ---- F1 escape (2026-07-14 adversarial sweep): a client that VANISHES mid-stream (reload / tab close /
    //      crash) must cancel the run PROMPTLY. Before the fix, handleRun attached req.on('close') AFTER
    //      readBody() had consumed the request — Node ≥15 emits req 'close' at message completion, so the
    //      listener never fired: the abandoned run streamed on unwatched (real-provider spend), held the
    //      same-agent mutex for minutes ("already running" with nothing visible), and the reloaded COMMS
    //      claimed the turn failed while the harness was still driving it. The fix listens on res 'close'. ----
    {
      const hdr = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
      // raw http.request so the CLIENT socket is destroyable mid-stream (fetch cannot half-kill a socket)
      const seen = await new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('no stream data before destroy')), 8000);
        const rq = http.request({ host: HOST, port: port, path: '/api/run', method: 'POST', headers: hdr }, (rs) => {
          let n = 0;
          rs.on('data', () => { n++; if (n >= 2) { clearTimeout(guard); rq.destroy(); resolve(n); } });
          rs.on('error', () => {});
        });
        rq.on('error', () => {});   // ECONNRESET after our own destroy is expected noise
        rq.end(JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e-dc', messages: [{ role: 'user', content: 'DRIPFEED long answer' }] }));
      });
      A.ok(seen >= 2, 'the doomed run really streamed to the client before the client vanished');
      // the abandoned run must settle into the durable log as CANCELLED within seconds (not minutes, not never)
      let settled = null;
      for (let i = 0; i < 40 && !settled; i++) {
        await new Promise(r => setTimeout(r, 250));
        const rows = (await (await fetch(B + '/api/runs?agent=e2e-dc&limit=10', { headers: { 'X-StarNet-Token': token, Origin: B } })).json()).runs || [];
        settled = rows.find(r => String(r.title || '').indexOf('DRIPFEED') >= 0) || null;
      }
      A.ok(!!settled, 'the abandoned run settled into runs.jsonl within 10s of the disconnect');
      A.eq(settled && settled.reason, 'cancelled', 'the abandoned run settled honestly as cancelled');
      // and the same-agent mutex is FREE: a new run on the same agent admits and completes immediately
      const r2 = await fetch(B + '/api/run', { method: 'POST', headers: hdr,
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e-dc', messages: [{ role: 'user', content: 'hi again' }] }) });
      const rd2 = r2.body.getReader(); const dc2 = new TextDecoder(); let raw2 = '';
      while (true) { const { value, done } = await rd2.read(); if (done) break; raw2 += dc2.decode(value, { stream: true }); }
      A.ok(raw2.indexOf('already running a task') < 0, 'no mutex ghost: the agent is not "already running" after its watcher died');
      const evs2 = raw2.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      A.ok(evs2.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'the follow-up run on the same agent completes clean');
    }
  } finally {
    try { child.kill(); } catch (_) {}
  }

  // reboot the sidecar on the SAME workspace: the persisted diag tail must come back.
  {
    const boot2 = await boot(8890 + (process.pid % 50), env, 20);
    const B2 = 'http://' + HOST + ':' + boot2.port;
    try {
      const token2 = await bootToken(B2, B2);
      const d2 = await (await fetch(B2 + '/api/diagnostics', { headers: { 'X-StarNet-Token': token2, Origin: B2 } })).json();
      A.ok(d2.text.indexOf('KABOOM-DIAG-NEEDLE') >= 0, 'RESTART-SAFE: the error tail survived the sidecar restart (diag.errors.json)');
      A.ok(d2.text.indexOf('(none recorded)') < 0, 'the report no longer claims an empty tail after restart');
    } finally {
      try { boot2.child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
    }
  }
  A.report('e2e.run.test');
})().catch(e => { console.error(e); process.exit(1); });
