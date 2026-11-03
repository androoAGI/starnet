/* node test/full-access.e2e.test.js — FULL ACCESS is one durable, zero-prompt per-agent authority.

   Drives the exact reported path through the real sidecar:
     ASK agent -> shell.exec raises permission.prompt -> POST /api/consent {decision:'full'}
     -> current shell runs -> later shell runs with ZERO prompts -> sidecar restart -> shell still runs with ZERO prompts.
   The mock provider is local and deterministic; shell.exec is the real workbench tool and child process. */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');   // a crew lives on a founded station: before one, the roster is held, never written

function startMockProvider() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        const toolResults = (body.messages || []).filter(m => m && m.role === 'tool');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (toolResults.length === 0) {
          const args = { objective: 'run the requested shell command', deliverable: 'the command output', assumptions: ['Use the placed workbench'] };
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'brief_1', type: 'function', function: { name: 'brief_proceed', arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        } else if (toolResults.length === 1) {
          const args = { cmd: 'node -e "console.log(\'FULL_ACCESS_SHELL_OK\')"' };
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'shell_1', type: 'function', function: { name: 'shell_exec', arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Shell completed.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

async function driveShell(fixture, decision) {
  const response = await fixture.request('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'sk-or-v1-full-access-fake', provider: 'openrouter', model: 'test/model',
      agentId: 'david', streamId: 'full-access-' + Date.now(), isTask: true,
      placed: [], messages: [{ role: 'user', content: 'FULL_ACCESS_SHELL run the command' }]
    })
  });
  A.eq(response.status, 200, 'real /api/run admitted the shell task');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buf = '', runId = ''; const events = [];
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      events.push(ev);
      if (ev.name === 'agent.run.start') runId = ev.payload.runId;
      if (ev.name === 'permission.prompt' && decision !== 'unanswered') {
        await fixture.json('POST', '/api/consent', {
          runId, promptId: ev.payload.promptId, decision: decision || 'deny'
        });
      }
    }
  }
  return events;
}

(async () => {
  const provider = await startMockProvider();
  const fixture = SidecarFixture.create({
    prefix: 'sk-full-access-',
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-full-access-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-full-access-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
      SKYNET_CONSENT_TIMEOUT_MS: '1000', STARNET_CONSENT_TIMEOUT_MS: '1000'
    }
  });
  try {
    // A connected (synthetic) Spotify account: this test is about Full Power projecting every capability FAMILY, and
    // a jukebox tool is only "available" when Spotify is connected — without a token the run defers spotify_* as
    // certainly unavailable (named in the prompt, revealable via tool_search). No Spotify call is made here.
    fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, '.secrets', 'spotify.json'), JSON.stringify({
      clientId: 'full-access-test', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600e3, scope: ''
    }));
    seedActiveStation(fixture.workspace);
    await fixture.start();
    const seeded = await fixture.json('POST', '/api/roster', {
      updatedAt: 100,
      agents: [{ agentId: 'david', system: 'You are DAVID.', name: 'DAVID', provider: 'openrouter', model: 'test/model', approvalMode: 'ask', executionProfile: 'trusted-project' }]
    });
    A.ok(seeded.body && seeded.body.ok === true, 'DAVID starts in ASK mode');

    // threads-backend-06 / sidecar-index-10: nobody answers the COMMS card. The consent timer fail-closes, but the model
    // must read "timed out", never "denied" (it used to tell the Commander "since you declined…").
    const before = provider.requests.length;
    const unanswered = await driveShell(fixture, 'unanswered');
    A.eq(unanswered.filter(e => e.name === 'permission.prompt').length, 1, 'ASK mode raises the shell card');
    A.ok(unanswered.some(e => e.name === 'permission.response' && e.payload && e.payload.expired === true), 'the card is told the prompt expired');
    const shellResult = provider.requests.slice(before).flatMap(req => req.messages || []).find(m => m && m.role === 'tool' && m.tool_call_id === 'shell_1');
    A.ok(shellResult && /approval timed out/.test(String(shellResult.content)) && /not a refusal/.test(String(shellResult.content)),
      'a COMMS approval nobody answered reaches the model as a timeout, not a denial: ' + JSON.stringify(shellResult && shellResult.content));

    const first = await driveShell(fixture, 'full');
    const firstDiag = JSON.stringify(first.map(e => ({ name: e.name, payload: e.payload })));
    A.eq(first.filter(e => e.name === 'permission.prompt').length, 1, 'ASK mode raises the first real shell permission card; events=' + firstDiag);
    A.ok(first.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === 'shell_1' && e.payload.ok === true), 'Trusted Project projects the real shell without a placed workbench, then the call succeeds after approval');
    const rosterFile = path.join(fixture.workspace, 'agent.roster.json');
    const disk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    A.eq(((disk.agents || []).find(a => a.agentId === 'david') || {}).approvalMode, 'full', 'the permission-card answer durably writes DAVID approvalMode:full');
    A.eq(((disk.agents || []).find(a => a.agentId === 'david') || {}).executionProfile, 'trusted-project', 'approval escalation does not rewrite the execution profile');

    const later = await driveShell(fixture);
    A.eq(later.filter(e => e.name === 'permission.prompt').length, 0, 'a later shell task emits ZERO permission prompts');
    A.ok(later.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === 'shell_1' && e.payload.ok === true), 'the later shell call executes successfully');

    const narrowedProfile = await fixture.json('POST', '/api/roster', {
      updatedAt: Date.now() + 10000,
      agents: [{ agentId: 'david', system: 'You are DAVID.', name: 'DAVID', provider: 'openrouter', model: 'test/model', approvalMode: 'full', executionProfile: 'station-gear' }]
    });
    A.ok(narrowedProfile.body && narrowedProfile.body.ok === true, 'the stored execution profile can remain narrow while Full Power is explicit');
    const broad = await driveShell(fixture);
    A.eq(broad.filter(e => e.name === 'permission.prompt').length, 0, 'Full Power still emits zero prompts under a formerly capability-limited profile');
    A.ok(broad.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === 'shell_1' && e.payload.ok === true),
      'Full Power projects and executes the general host shell without a placed workbench');
    const latestRequests = provider.requests.slice(-3);
    const projected = new Set(latestRequests.flatMap(req => (req.tools || []).map(t => t && t.function && t.function.name).filter(Boolean)));
    // ORCHESTRATION family: DAVID is the only roster agent, so he leads with ZERO crew — the lean-prompt diet (2026-10-12)
    // keeps team_summon advertised and defers the rest of the crew kit (granted, named in the prompt, tool_search finds it).
    for (const name of ['shell_exec', 'fs_read', 'web_search', 'image_generate', 'spotify_search', 'team_summon']) {
      A.ok(projected.has(name), 'Full Power projects available capability family tool ' + name);
    }
    A.ok(latestRequests.some(req => /These exist and you CAN use them: [^\n]*team_dispatch/.test(String(((req.messages || [])[0] || {}).content || ''))),
      'Full Power still GRANTS team_dispatch to a crewless lead (deferred: named in the prompt, revealed by tool_search)');

    await fixture.restart();
    const afterRestart = await driveShell(fixture);
    A.eq(afterRestart.filter(e => e.name === 'permission.prompt').length, 0, 'after a real sidecar restart, shell still emits ZERO permission prompts');
    A.ok(afterRestart.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === 'shell_1' && e.payload.ok === true), 'after restart, the shell call still executes successfully');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => provider.server.close(resolve));
  }
  A.report('full-access.e2e.test');
})().catch(e => { console.log('FAIL: full-access.e2e.test threw — ' + (e && e.stack || e)); process.exit(1); });
