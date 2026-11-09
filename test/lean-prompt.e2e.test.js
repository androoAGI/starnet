/* node test/lean-prompt.e2e.test.js — LEAN PROMPT (2026-10-12), through the REAL request assembly of a hermetic sidecar.

   1. ZERO-CREW DIET. A lead with no crew used to ship the whole crew kit on every task request (9 team_* schemas +
      a ~5 KB [ORCHESTRATION] briefing about a team that does not exist). With no crew: only team.dispatch and the
      background-worker controls are DEFERRED (granted, named in [HARNESS], revealed by tool_search); team.summon,
      team.spawn and team.config / team.configure stay advertised; the briefing is the recruit line + the SPAWN, CREW
      CONFIGURATION, [PROJECT WORKSPACE] and session rules; a summon reveals team.dispatch and a background spawn reveals
      its controls on their own. With crew, the full kit and briefing are back.
   2. CACHE-STABLE PREFIX. The per-run block ([RUNTIME], the Task Brief, quests …) rides a <run_context> note placed
      with the newest user message, so the leading system prompt + tools are byte-identical across a conversation's
      messages and its tool iterations, and the request still ends on the user turn.
   3. KILL SWITCHES. STARNET_LEAN_CREW=0 + STARNET_STABLE_PREFIX=0 restore the old request exactly in shape.
   No external inference: a mock Chat Completions upstream records every body. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { hostNotes, runContextOf, userWords } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';
const MARK = 'LEAN_PROMPT_PROBE';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
// review 2026-10-12: only what needs a crew or a running background worker is deferred; clones (team_spawn) and the
// lead's OWN Dossier (team_config / team_configure) need no crew and stay advertised with team_summon
const CREW_DEFERRED = ['team_dispatch', 'team_subagents', 'team_steer', 'team_interrupt', 'team_resume'];
const CREWLESS_KEPT = ['team_summon', 'team_spawn', 'team_config', 'team_configure'];
const CREW_KIT = CREW_DEFERRED.concat(CREWLESS_KEPT);

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
// THE system prompt: the first message. On this non-Claude chat wire it is the ONLY system message: the run-context note
// is the fenced leading text of the newest user message (provider.js userSideHostNotes — strict chat templates).
const leadingSystem = body => { const m = (body.messages || [])[0]; return m && m.role === 'system' ? text(m.content) : ''; };
const toolNames = body => (body.tools || []).map(t => t.function.name);
const lastUserIdx = body => { const m = body.messages || []; for (let i = m.length - 1; i >= 0; i--) if (m[i].role === 'user') return i; return -1; };

function startUpstream() {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const main = leadingSystem(body).indexOf(MARK) >= 0 && Array.isArray(body.tools) && body.tools.length > 0;
    if (main) bodies.push(body);
    const msgs = body.messages || [];
    const ask = userWords(msgs[lastUserIdx(body)] || {});
    const answered = msgs.slice(lastUserIdx(body) + 1).some(m => m.role === 'tool');
    let call = null;
    if (main && !answered && /^SEARCH/.test(ask)) call = { name: 'tool_search', args: { query: /dossier/i.test(ask) ? 'agent dossier' : 'delegate subtasks' } };
    if (main && !answered && /^SUMMON/.test(ask)) call = { name: 'team_summon', args: { name: 'RESEARCHER', specId: 'researcher' } };
    if (main && !answered && /^SPAWNBG/.test(ask)) call = { name: 'team_spawn', args: { tasks: [{ prompt: 'CLONE_TASK: say done', label: 'bg proof' }], background: true } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (call) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + bodies.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Here is a joke about orbital mechanics.' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, bodies, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

function hermeticEnv(extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.13.2-lean-prompt' }, extra || {});
}

// One /api/run, read as a stream so a summon can be acked mid-run exactly as the station page would.
async function run(fixture, up, stream, messages) {
  const from = up.bodies.length;
  const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: 'custom', baseUrl: up.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: true, streamId: stream || undefined,
    placed: FLOOR, stationPlaced: FLOOR, system: MARK + ': you are the lead.', messages }) });
  A.eq(r.status, 200, 'run accepted');
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', runId = '', end = null; const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      events.push(ev);
      if (ev.name === 'agent.run.start' && !runId) runId = ev.payload.runId;
      if (ev.name === 'agent.run.end') end = ev.payload;
      if (ev.name === 'crew.summon.request') {
        await fixture.json('POST', '/api/summon/ack', { runId, requestId: ev.payload.requestId, agentId: 'researcher-2', desk: 'BRIDGE' });
      }
    }
  }
  return { bodies: up.bodies.slice(from), end, events };
}

(async () => {
  const up = await startUpstream();
  let fixture = SidecarFixture.create({ prefix: 'starnet-lean-prompt-', timeoutMs: 30000, env: hermeticEnv() });
  try {
    await fixture.start();
    // ---- 1 + 2: zero crew, two messages of one conversation ----
    const S = 'lean-convo';
    const m1 = [{ role: 'user', content: 'tell me a joke' }];
    const r1 = await run(fixture, up, S, m1);
    A.eq(r1.end && r1.end.reason, 'done', 'message 1 completes');
    const m2 = m1.concat([{ role: 'assistant', content: 'Here is a joke about orbital mechanics.' }, { role: 'user', content: 'tell me another joke' }]);
    const r2 = await run(fixture, up, S, m2);
    A.eq(r2.end && r2.end.reason, 'done', 'message 2 completes');
    const [b1, b2] = [r1.bodies[0], r2.bodies[0]];
    A.ok(b1 && b2, 'both task requests reached the model');
    const names = toolNames(b1);
    for (const n of CREWLESS_KEPT) A.ok(names.indexOf(n) >= 0, 'zero crew: ' + n + ' stays advertised (needs no crew)');
    for (const n of CREW_DEFERRED) A.ok(names.indexOf(n) < 0, 'zero crew: ' + n + ' is not advertised');
    const sys1 = leadingSystem(b1), sys2 = leadingSystem(b2);
    A.ok(/These exist and you CAN use them: [^\n]*team_dispatch/.test(sys1), 'zero crew: the deferred crew kit is NAMED in [HARNESS] (granted, findable)');
    const orch = sys1.slice(sys1.indexOf('[ORCHESTRATION]'));
    A.ok(sys1.indexOf('[ORCHESTRATION]') >= 0 && orch.indexOf('You have no crew yet') >= 0, 'zero crew: the compact briefing rides');
    A.ok(orch.indexOf('YOUR TEAM') < 0, 'zero crew: no crew list');
    A.ok(orch.indexOf('\n• SPAWN temporary same-identity subagents with team.spawn') >= 0, 'zero crew: the SPAWN line rides (clones need no crew)');
    A.ok(orch.indexOf('\n• CREW CONFIGURATION: use team.config') >= 0, 'zero crew: the CREW CONFIGURATION rules ride (the lead\'s own Dossier)');
    A.ok(orch.indexOf('tool_search "station settings"') >= 0 && orch.indexOf('session_peek') >= 0, 'zero crew: the crew-independent station + session rules stay');
    // 2. cache-stable prefix
    A.eq(sys2, sys1, 'the leading system prompt is BYTE-IDENTICAL across two messages of one conversation');
    A.eq(JSON.stringify(b2.tools), JSON.stringify(b1.tools), 'the tool array is byte-identical across the two messages');
    A.ok(sys1.indexOf('[RUNTIME]') < 0 && sys1.indexOf('Run id:') < 0, 'no per-run id in the system prompt');
    for (const b of [b1, b2]) {
      const li = lastUserIdx(b);
      A.eq(li, b.messages.length - 1, 'the request ends on the user turn');
      A.eq(b.messages.filter(m => m.role === 'system').length, 1, 'exactly ONE system message on this chat wire (strict templates refuse a later one)');
      A.ok(text(b.messages[li].content).indexOf('<run_context>') === 0, 'the <run_context> note is the fenced leading text of the newest user message');
      const note = runContextOf(b.messages);
      A.ok(/Run id: \S+/.test(note) && note.indexOf('[RUNTIME]') >= 0, 'the note carries the runtime identity');
      A.eq(hostNotes(b.messages, 'run_context').length, 1, 'exactly one run-context note (history carries none)');
    }
    A.ok(runContextOf(b1.messages) !== runContextOf(b2.messages), 'each message gets its own run context');
    A.eq(text(b2.messages[1].content), 'tell me a joke', 'message 2 replays the history right after the system prompt (cacheable prefix)');
    A.eq(JSON.stringify(b2.messages[0]), JSON.stringify(b1.messages[0]), 'message 2\'s first message (the system prompt) is the same bytes message 1 sent');

    // tool_search finds the deferred kit; the system stays identical across the run's iterations
    const r3 = await run(fixture, up, 'lean-search', [{ role: 'user', content: 'SEARCH: split this into parallel subtasks' }]);
    A.eq(r3.bodies.length, 2, 'search run: two model calls (search, then answer)');
    const after = toolNames(r3.bodies[1]);
    A.ok(after.indexOf('team_dispatch') >= 0, 'tool_search "delegate subtasks" reveals team_dispatch');
    A.eq(leadingSystem(r3.bodies[1]), leadingSystem(r3.bodies[0]), 'within a run the system prompt is byte-identical across tool iterations');
    A.eq(leadingSystem(r3.bodies[0]), sys1, 'and identical to the other conversation\'s (the same lead, the same floor)');

    // a BACKGROUND spawn reveals its worker controls on its own (no streamId: no Task Brief gate on the spawn)
    const r3c = await run(fixture, up, null, [{ role: 'user', content: 'SPAWNBG: fan this out in the background' }]);
    const leadCalls = r3c.bodies.filter(b => /^SPAWNBG/.test(userWords((b.messages || [])[lastUserIdx(b)] || {})));
    A.ok(leadCalls.length >= 2, 'background spawn run: the lead was called again after team_spawn returned');
    A.ok(CREW_DEFERRED.slice(1).every(n => toolNames(leadCalls[0]).indexOf(n) < 0), 'before the spawn: the background controls are deferred');
    for (const n of CREW_DEFERRED.slice(1)) A.ok(toolNames(leadCalls[1]).indexOf(n) >= 0, 'after a background spawn: ' + n + ' is callable without a search');
    A.ok(toolNames(leadCalls[1]).indexOf('team_dispatch') < 0, 'a spawn reveals the controls, not team_dispatch');

    // [PROJECT WORKSPACE] rides the crewless briefing too
    const folder = require('node:path').join(fixture.workspace, 'lean-project'); require('node:fs').mkdirSync(folder);
    const blessed = await fixture.deskJson('POST', '/api/projects/bless', { path: folder });   // confirmed at the desk (GHSA-2hpj #1)
    A.eq(blessed.status, 200, 'project folder blessed');
    let root = blessed.body && (blessed.body.root || (blessed.body.project && blessed.body.project.root));
    if (!root) root = ((await fixture.json('GET', '/api/projects')).body.projects.find(p => /lean-project$/i.test(p.root)) || {}).root;
    const home = (await fixture.json('POST', '/api/projects/workspace', { root })).body.session;
    A.ok(home && home.id, 'project conversation opened');
    const from = up.bodies.length;
    const pr = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'custom', baseUrl: up.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: true, streamId: home.id, projectRoot: root,
      placed: FLOOR, stationPlaced: FLOOR, system: MARK + ': you are the lead.', messages: [{ role: 'user', content: 'tell me a joke' }] }) });
    await pr.text();
    const projSys = leadingSystem(up.bodies[from] || {});
    A.ok(projSys.indexOf('You have no crew yet') >= 0 && projSys.indexOf('\n[PROJECT WORKSPACE] This is the project\'s main conversation.') >= 0, 'zero crew in a project conversation: the [PROJECT WORKSPACE] paragraph rides');

    // a summon reveals team.dispatch on its own
    // no streamId: a streamed conversation opens a Task Brief, whose gate holds every mutation until brief_proceed
    const r4 = await run(fixture, up, null, [{ role: 'user', content: 'SUMMON a research agent for me' }]);
    A.ok(r4.bodies.length >= 2, 'summon run: the model was called after the summon returned');
    A.ok(toolNames(r4.bodies[0]).indexOf('team_dispatch') < 0, 'before the summon: team_dispatch deferred');
    A.ok(toolNames(r4.bodies[1]).indexOf('team_dispatch') >= 0, 'after a successful summon: team_dispatch is callable without a search');
    A.ok(JSON.stringify(r4.bodies[1].messages).indexOf('researcher-2') >= 0, 'the new agentId reached the model');

    // with crew, the full kit and briefing come back
    A.eq((await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
      { agentId: 'agent', name: 'NOVA', provider: 'custom', model: 'fixture-model' },
      { agentId: 'researcher', name: 'Ada', role: 'researcher', provider: 'custom', model: 'fixture-model' }] })).status, 200, 'crew roster saved');
    const r5 = await run(fixture, up, 'lean-crew', [{ role: 'user', content: 'tell me a joke' }]);
    const crewNames = toolNames(r5.bodies[0]);
    for (const n of CREW_KIT) A.ok(crewNames.indexOf(n) >= 0, 'with crew: ' + n + ' advertised');
    const crewSys = leadingSystem(r5.bodies[0]);
    A.ok(crewSys.indexOf('YOUR TEAM') >= 0 && crewSys.indexOf('researcher (Ada)') >= 0 && crewSys.indexOf('You have no crew yet') < 0, 'with crew: the full briefing with the team list');
    A.ok(crewSys.indexOf('\n• CREW CONFIGURATION: use team.config') >= 0 && crewSys.indexOf('\n• SESSIONS: session_list') >= 0, 'with crew: config + sessions paragraphs intact');
    A.ok(crewSys.indexOf('\n• SPAWN temporary') >= 0 && crewSys.indexOf('\n• SUMMON a NEW specialist') >= 0 && crewSys.indexOf('team.dispatch is granted but not loaded') < 0, 'with crew: the full SPAWN / SUMMON briefing, no crewless pointer');
    // CREW IN THIS CHAT (rc walk 10-14): seating crew here is group.add, never a dispatch — with crew and without
    const seat = '\n• CREW IN THIS CHAT ("bring X in", "add them into this chat"): station.control group.add (tool_search "group add"), never team.dispatch.';
    A.ok(crewSys.indexOf(seat) >= 0 && crewSys.indexOf(seat) < crewSys.indexOf('\n• SPAWN temporary'), 'with crew: the seat line rides right under the team list');
    A.ok(/It returns the new agentId: hand it work with team\.dispatch, or seat it in this chat with group\.add\./.test(crewSys), 'with crew: SUMMON names both next steps');
    A.ok(sys1.indexOf(seat) >= 0, 'zero crew: the seat line rides too (a summoned hire is seated the same way)');
    await fixture.dispose();

    // ---- 3: kill switches restore the old request shape ----
    fixture = SidecarFixture.create({ prefix: 'starnet-lean-prompt-off-', timeoutMs: 30000, env: hermeticEnv({ STARNET_LEAN_CREW: '0', STARNET_STABLE_PREFIX: '0' }) });
    await fixture.start();
    const k1 = await run(fixture, up, 'off', m1);
    const k2 = await run(fixture, up, 'off', m2);
    const [o1, o2] = [k1.bodies[0], k2.bodies[0]];
    for (const n of CREW_KIT) A.ok(toolNames(o1).indexOf(n) >= 0, 'STARNET_LEAN_CREW=0: ' + n + ' advertised with zero crew');
    A.ok(leadingSystem(o1).indexOf('You have no crew yet') < 0 && leadingSystem(o1).indexOf('SPAWN temporary') >= 0, 'STARNET_LEAN_CREW=0: the full briefing');
    A.ok(leadingSystem(o1).indexOf('Run id:') >= 0, 'STARNET_STABLE_PREFIX=0: the runtime block is back in the system prompt');
    A.ok(leadingSystem(o1) !== leadingSystem(o2), 'STARNET_STABLE_PREFIX=0: the system prompt differs per message again (the old behaviour)');
    A.eq(hostNotes(o1.messages, 'run_context').length, 0, 'STARNET_STABLE_PREFIX=0: no run-context note');
  } finally {
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('lean-prompt.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
