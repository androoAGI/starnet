/* node test/observer.e2e.test.js — the terminal's live feed (GET /api/observe) against a REAL sidecar.

   test/observer.test.js locks the view policy against fakes. This boots the real sidecar (hermetic profile, a
   content-driven mock OpenRouter, zero spend) and proves the seams in index.js:
     1. a run another client starts (POST /api/run, exactly as the page does) reaches a watcher: run.start with the
        asking prompt, the streamed tokens, the tool call with its one-line summary, the outcome, run.end{done};
     2. its approval reaches the watcher with the runId that answers it, and an answer FROM THE TERMINAL
        (POST /api/consent { via:'terminal' }) is told to the run's own stream (so the desk card lets go) AND to the
        watcher — and the approved write really lands;
     3. reason-only self-talk (internal:true) never reaches the watcher;
     4. rosterSystem:true runs the agent as its roster entry defines it (the model sees that persona), and a run
        without the flag is unchanged;
     5. the feed refuses a request without the station token. Part of test:http. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const apitickets = require('../sidecar/apitickets.js');
// the bus as a StarNet PAGE joins it: a single-use SSE ticket, no header (ApiTicket.sseUrl) — a header-token listener is a
// node client (the MCP bridge), never counted as an open app (review 10-24)
const pageFeed = fixture => '/api/channels/events?ticket=' + encodeURIComponent(apitickets.mint(fixture.token, 'sse', apitickets.SCOPE_SSE, { now: Date.now() }));

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startMockOpenRouter(script, seen) {
  function decide(body) {
    const msgs = (body && body.messages) || [];
    if (msgs.some(m => m && m.role === 'tool')) return { text: 'done' };
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const text = String((lastUser && lastUser.content) || '').toLowerCase();
    return script.find(r => text.indexOf(r.when) >= 0) || { text: 'nothing to do' };
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(body); } catch (_) {}
        if (parsed && Array.isArray(parsed.messages)) seen.push(parsed.messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n'));
        const turn = decide(parsed);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (turn.tool) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// a watcher: GET /api/observe with the header, every product frame collected as { name, payload }
function watch(fixture, headers, feedPath) {
  const events = [];
  let status = 0;
  const req = http.request({ host: HOST, port: fixture.port, path: feedPath || '/api/observe', method: 'GET', headers: Object.assign({ Accept: 'text/event-stream', Origin: fixture.baseUrl }, headers) }, res => {
    status = res.statusCode;
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').filter(l => l.indexOf('data: ') === 0).map(l => l.slice(6)).join('\n');
        if (!data) continue;
        try { const j = JSON.parse(data); if (j && j.name) events.push(j); else if (j && j.stream === 'ready') events.ready = true; } catch (_) {}
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return { events, status: () => status, close: () => { try { req.destroy(); } catch (_) {} } };
}

// POST /api/run exactly as the page does; NDJSON events collected, with a hook per event
function run(fixture, body, onEvent) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const events = [];
    const req = http.request({ host: HOST, port: fixture.port, path: '/api/run', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl } }, res => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          try { const ev = JSON.parse(line); events.push(ev); if (onEvent) onEvent(ev); } catch (_) {}
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', () => resolve(events));
    req.end(payload);
  });
}

async function until(fn, ms, label) {
  const deadline = Date.now() + (ms || 15000);
  while (Date.now() < deadline) { if (fn()) return true; await sleep(50); }
  A.ok(false, 'timed out waiting: ' + label);
  return false;
}

(async () => {
  const seenSystems = [];
  const mock = await startMockOpenRouter([
    { when: 'say hello', text: 'Hello from the station.' },
    { when: 'write the notes file', tool: { name: 'fs.write', args: { path: 'observe-notes.md', content: 'approved from the terminal' } } }
  ], seenSystems);
  const providerEnv = {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-observe-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-observe-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  };
  const fixture = SidecarFixture.create({ prefix: 'sk-observe-', env: providerEnv });
  await fixture.start();
  // the files cabinet on the floor, as the page grants it (World.heroCaps): without it fs.write is not offered at all
  const base = { model: 'test/model', provider: 'openrouter', agentId: 'agent', placed: [{ objectType: 'computer' }, { objectType: 'cabinet' }] };
  let w = null;
  try {
    /* ---- 5. the feed is token-gated ---------------------------------------------------------- */
    {
      const anon = watch(fixture, {});
      await until(() => anon.status() !== 0, 5000, 'an answer without a token');
      A.ok(anon.status() === 401 || anon.status() === 403, 'no token → refused (' + anon.status() + ')');
      anon.close();
    }

    w = watch(fixture, { 'X-StarNet-Token': fixture.token });
    await until(() => w.events.ready === true, 8000, 'the feed ready frame');

    /* ---- 1 + 2. another client's run, its approval, answered from the terminal ------------------ */
    {
      let consentReply = null;
      const ndjson = await run(fixture, Object.assign({ messages: [{ role: 'user', content: 'write the notes file' }] }, base), async (ev) => {
        if (ev.name !== 'permission.prompt') return;
        const p = ev.payload;
        // the watcher holds the same ask, with the run that answers it
        await until(() => w.events.some(e => e.name === 'permission.prompt' && e.payload.promptId === p.promptId), 5000, 'the ask on the feed');
        const onFeed = w.events.find(e => e.name === 'permission.prompt' && e.payload.promptId === p.promptId);
        const runId = onFeed && onFeed.payload.runId;
        A.ok(/^[0-9a-f-]{36}$/.test(String(runId)), 'the ask on the feed carries its runId: ' + runId);
        A.eq(onFeed && onFeed.payload.tool, 'fs.write', 'the ask names its tool');
        consentReply = await fixture.json('POST', '/api/consent', { runId, promptId: p.promptId, decision: 'once', via: 'terminal' });
      });
      A.ok(consentReply && consentReply.status === 200 && consentReply.body.ok === true, 'the terminal answer was applied: ' + JSON.stringify(consentReply && consentReply.body));
      const told = ndjson.find(e => e.name === 'permission.response');
      A.ok(told && told.payload.via === 'terminal' && told.payload.decision === 'once', "the run's own stream (the page) was told the terminal answered: " + JSON.stringify(told));
      const start = ndjson.find(e => e.name === 'agent.run.start');
      const runId = start && start.payload.runId;
      await until(() => w.events.some(e => e.name === 'agent.run.end' && e.payload.runId === runId), 15000, 'run.end on the feed');
      const mine = w.events.filter(e => e.payload && e.payload.runId === runId);
      const names = mine.map(e => e.name);
      const fstart = mine.find(e => e.name === 'agent.run.start');
      A.ok(fstart && fstart.payload.prompt === 'write the notes file' && fstart.payload.agentId === 'agent', 'run.start on the feed carries the asking prompt: ' + JSON.stringify(fstart && fstart.payload));
      const call = mine.find(e => e.name === 'agent.tool_call');
      A.ok(call && call.payload.name === 'fs.write' && /observe-notes\.md/.test(call.payload.argsSummary), 'the tool call with its one-line summary: ' + JSON.stringify(call && call.payload));
      const result = mine.find(e => e.name === 'agent.tool_result');
      A.ok(result && result.payload.ok === true, 'the approved call succeeded');
      A.ok(names.indexOf('agent.token') >= 0, 'the reply streamed onto the feed');
      const settled = mine.find(e => e.name === 'permission.response');
      A.ok(settled && settled.payload.via === 'terminal', 'the feed learned who answered: ' + JSON.stringify(settled && settled.payload));
      const end = mine.find(e => e.name === 'agent.run.end');
      A.eq(end && end.payload.reason, 'done', 'run.end{done} on the feed');
      A.ok(names.indexOf('agent.run.start') < names.indexOf('agent.run.end'), 'in order');
      A.ok(fs.existsSync(path.join(fixture.workspace, 'agent', 'observe-notes.md')), 'the write the terminal approved really landed');
    }

    /* ---- 3. self-talk never reaches the watcher ------------------------------------------------ */
    {
      const ev = await run(fixture, Object.assign({ internal: true, messages: [{ role: 'user', content: 'say hello' }] }, base));
      const rid = (ev.find(e => e.name === 'agent.run.start') || { payload: {} }).payload.runId;
      await sleep(400);
      A.ok(rid && !w.events.some(e => e.payload && e.payload.runId === rid), 'an internal run is not on the feed');
    }

    /* ---- 4. rosterSystem ------------------------------------------------------------------------ */
    {
      const roster = await fixture.json('POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'OVERSEER' }, { agentId: 'rook', name: 'ROOK', system: 'You are ROOK-OBSERVE-PERSONA.', model: 'test/model', provider: 'openrouter' }] });
      A.eq(roster.status, 200, 'roster accepted: ' + roster.text.slice(0, 120));
      seenSystems.length = 0;
      await run(fixture, { model: 'test/model', provider: 'openrouter', agentId: 'rook', rosterSystem: true, messages: [{ role: 'user', content: 'say hello' }] });
      A.ok(seenSystems.some(s => s.indexOf('ROOK-OBSERVE-PERSONA') >= 0), 'rosterSystem:true → the model saw the roster persona');
      seenSystems.length = 0;
      await run(fixture, { model: 'test/model', provider: 'openrouter', agentId: 'rook', messages: [{ role: 'user', content: 'say hello' }] });
      A.ok(!seenSystems.some(s => s.indexOf('ROOK-OBSERVE-PERSONA') >= 0), 'without the flag nothing changes (no persona injected)');
    }

    /* ---- 5. a TERMINAL run is told it is in the terminal, not shown the desktop manual ------------------------ */
    {
      const DESKTOP = 'shown as a living pixel-art floor';   // the desktop manual's ABOUT (both its inline and index forms)
      seenSystems.length = 0;
      await run(fixture, Object.assign({}, base, { agentId: 'rook', rosterSystem: true, client: 'terminal', isTask: true, messages: [{ role: 'user', content: 'how do I make this run every morning?' }] }));
      const sys = seenSystems.find(s => s.indexOf('ROOK-OBSERVE-PERSONA') >= 0) || '';
      A.ok(sys.indexOf('ROOK-OBSERVE-PERSONA') >= 0 && sys.indexOf('[TERMINAL]') > sys.indexOf('ROOK-OBSERVE-PERSONA'), 'the terminal note follows the persona, so it has the last word over its COMMS/button wording');
      A.ok(/\/model shows and switches your model/.test(sys) && /y \(allow once\), n \(deny\)/.test(sys), 'it names the terminal\'s real keys and commands');
      A.ok(sys.indexOf('TERMINAL CLI') >= 0 && sys.indexOf(DESKTOP) < 0, 'a terminal task run gets the terminal manual pointer, never the desktop manual');
      seenSystems.length = 0;
      await run(fixture, Object.assign({}, base, { agentId: 'rook', rosterSystem: true, isTask: true, messages: [{ role: 'user', content: 'how do I make this run every morning?' }] }));
      const desk = seenSystems.find(s => s.indexOf('ROOK-OBSERVE-PERSONA') >= 0) || '';
      A.ok(desk.indexOf('[TERMINAL]') < 0 && desk.indexOf(DESKTOP) >= 0, 'the same task run from the page keeps the desktop manual and no terminal note');
    }

    /* ---- 6. /model from the terminal: POST /api/agent/model ---------------------------------------------------- */
    {
      const rosterOf = async id => ((await fixture.json('GET', '/api/runtime/agent')).body.agents || []).find(a => a.agentId === id) || {};
      // no StarNet page connected: the roster takes it (a headless station is its own source of truth)
      const r1 = await fixture.json('POST', '/api/agent/model', { agentId: 'rook', model: 'test/other-model', provider: 'openrouter' });
      A.eq([r1.status, r1.body && r1.body.via], [200, 'roster'], 'headless: the roster takes the new model');
      A.eq((await rosterOf('rook')).model, 'test/other-model', 'and the station reads it back');
      const r1e = await fixture.json('POST', '/api/agent/model', { agentId: 'rook', model: 'test/other-model', provider: 'openrouter', effort: 'high' });
      A.eq([r1e.status, r1e.body && r1e.body.via, (await rosterOf('rook')).reasoningEffort], [200, 'roster', 'high'], 'headless: an effort set with it lands on the roster, and the runtime roster says it (the terminal reads it there)');
      A.eq((await fixture.json('POST', '/api/agent/model', { agentId: 'ghost', model: 'm', provider: 'openrouter' })).status, 404, 'an unknown agent is refused');
      A.eq((await fixture.json('POST', '/api/agent/model', { agentId: 'rook', model: 'claude-x', provider: 'anthropic' })).status, 409, 'a provider with no key or sign-in is refused (its next run would fail)');
      A.eq((await fixture.json('POST', '/api/agent/model', { agentId: 'rook', model: '', provider: 'openrouter' })).status, 400, 'no model named, nothing changes');
      A.eq((await rosterOf('rook')).model, 'test/other-model', 'the refused calls changed nothing');
      // a StarNet page connected: the PAGE applies it (it owns the crew; a roster-only write would be undone by its next push)
      const asked = [];
      const page = watch(fixture, {}, pageFeed(fixture));
      const answering = setInterval(() => {
        for (const e of page.events.splice(0)) {
          if (e.name !== 'station.command' || !e.payload) continue;
          asked.push(e.payload);
          fixture.json('POST', '/api/station/ack', { id: e.payload.id, ok: true, result: { agent: 'ROOK', model: e.payload.args.model } });
        }
      }, 25);
      await sleep(400);
      const r2 = await fixture.json('POST', '/api/agent/model', { agentId: 'rook', model: 'test/page-model', provider: 'openrouter', effort: 'high' });
      clearInterval(answering); page.close();
      A.eq([r2.status, r2.body && r2.body.via], [200, 'page'], 'with a page connected, the page applies it: ' + JSON.stringify(r2.body));
      const cmd = asked.find(c => c.verb === 'station.control') || {};
      A.eq([cmd.args && cmd.args.action, cmd.args && cmd.args.agent, cmd.args && cmd.args.model, cmd.args && cmd.args.provider, cmd.args && cmd.args.effort], ['agent.model', 'rook', 'test/page-model', 'openrouter', 'high'], 'as the same station.control agent.model the agent tool sends');
      const rk = await rosterOf('rook');
      A.eq([rk.reasoningEffort, rk.approvalMode], ['high', 'ask'], 'the runtime roster says each agent\'s effort and approval mode (the terminal reads them there); the page\'s change left the roster to the page');
    }

    /* ---- 7. /yolo and /personality from the terminal: POST /api/agent/approval, /api/agent/personality -------------------- */
    {
      const rosterOf = async id => ((await fixture.json('GET', '/api/runtime/agent')).body.agents || []).find(a => a.agentId === id) || {};
      // headless, giving Full Access is the desk's call (GHSA-2hpj #1): the key alone is refused, and the code this bare
      // station printed (what `starnet`'s /yolo reads over IPC, or the person types) lets it through
      const y1Refused = await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'full' });
      A.eq([y1Refused.status, y1Refused.body && y1Refused.body.code], [403, 'desk_confirm_required'], 'headless: /yolo on asks at the desk first');
      const y1 = await fixture.deskJson('POST', '/api/agent/approval', { agentId: 'rook', mode: 'full' });
      A.eq([y1.status, y1.body && y1.body.via, (await rosterOf('rook')).approvalMode], [200, 'roster', 'full'], 'headless: /yolo sets that one agent\'s approval mode on the roster, and the station reads it back');
      A.eq((await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'maybe' })).status, 400, 'approval is ask or full, nothing else');
      A.eq((await fixture.json('POST', '/api/agent/approval', { agentId: 'ghost', mode: 'ask' })).status, 404, 'an unknown agent is refused');
      await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'ask' });
      A.eq((await rosterOf('rook')).approvalMode, 'ask', 'and back to ask');
      A.eq((await fixture.json('POST', '/api/agent/personality', { agentId: 'rook', personality: 'blunt' })).status, 409, 'headless, a personality with no composed prompt is refused (only the app\'s composer writes one)');
      const p1 = await fixture.json('POST', '/api/agent/personality', { agentId: 'rook', personality: 'blunt', system: 'ROOK-BLUNT-PERSONA' });
      A.eq([p1.status, p1.body && p1.body.via, (await rosterOf('rook')).personaId], [200, 'roster', 'blunt'], 'with the prompt the caller composed: the roster keeps it and the personality');
      seenSystems.length = 0;
      await run(fixture, Object.assign({}, base, { agentId: 'rook', rosterSystem: true, client: 'terminal', messages: [{ role: 'user', content: 'hi' }] }));
      A.ok(seenSystems.some(s => s.indexOf('ROOK-BLUNT-PERSONA') >= 0), 'and the agent\'s next run speaks with it');
      A.eq((await fixture.json('POST', '/api/agent/personality', { agentId: 'rook', personality: 'Not A Persona!' })).status, 400, 'a malformed personality id is refused');
      // a StarNet page connected: the page applies both (its own controls save and recompose)
      const asked = [];
      const page = watch(fixture, {}, pageFeed(fixture));
      const answering = setInterval(() => {
        for (const e of page.events.splice(0)) {
          if (e.name !== 'station.command' || !e.payload) continue;
          asked.push(e.payload);
          fixture.json('POST', '/api/station/ack', { id: e.payload.id, ok: true, result: { agent: 'ROOK' } });
        }
      }, 25);
      await sleep(400);
      const y2 = await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'full' });
      const p2 = await fixture.json('POST', '/api/agent/personality', { agentId: 'rook', personality: 'warm' });
      clearInterval(answering); page.close();
      A.eq([y2.body && y2.body.via, p2.body && p2.body.via], ['page', 'page'], 'with a page connected, the page applies both');
      const acts = asked.filter(c => c.verb === 'station.control').map(c => [c.args.action, c.args.agent, c.args.mode || c.args.personality]);
      A.eq(acts, [['agent.approval', 'rook', 'full'], ['agent.personality', 'rook', 'warm']], 'as the same station.control the agent tool sends');
      A.eq((await rosterOf('rook')).approvalMode, 'ask', 'and the roster is left to the page (no second writer)');
    }
  } catch (e) {
    A.ok(false, 'observer e2e threw: ' + ((e && e.stack) || e));
  } finally {
    if (w) w.close();
    await fixture.dispose();
    mock.server.close();
  }
  A.report('observer.e2e.test');
})();
