/* node test/dormant-followups.e2e.test.js — DORMANT FOLLOW-UP CONTROLS through the REAL request assembly of a hermetic
   sidecar (cost audit W1.3, sidecar/capability/followups.js).

   A fresh station has no background process, no terminal session and no routine, loop or task card, so the 13 follow-up
   controls ride no task call: they are granted, NAMED in the [HARNESS] list and found by tool_search. This drives the real
   /api/run against a recording mock model and proves, from the bodies the sidecar actually sent:
     1. fresh: the controls are off the wire and named; their starters (shell_exec, terminal_start, routine_create,
        loop_create, task_create) and shell_bg_status stay advertised; GET /api/toolsets previews the same;
     2. a background shell_exec that starts a real process reveals shell_bg_read/write/kill/wait on the NEXT call of the
        same run (the tools array only grows; the terminal and manage controls stay off);
     3. the next run, with that process still alive, advertises them from its first call (host fact: a live handle);
     4. the model kills it with the revealed shell_bg_kill; the run after that holds them off the wire again;
     5. a routine record brings routine_manage back at run start (loop and task manage stay off);
     6. a chat turn (no tools on the wire) no longer carries the deliverable clause; a task call that carries
        deliverable_note still does.
   No external inference. The background child ends itself after 90 s if a kill ever failed. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';
const MARK = 'DORMANT_FOLLOWUPS_PROBE';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const BG = ['shell_bg_read', 'shell_bg_write', 'shell_bg_kill', 'shell_bg_wait'];
const TERMINAL = ['terminal_status', 'terminal_read', 'terminal_write', 'terminal_resize', 'terminal_interrupt', 'terminal_stop'];
const MANAGE = ['routine_manage', 'loop_manage', 'task_manage'];
const DORMANT = BG.concat(TERMINAL, MANAGE);
const STARTERS = ['shell_exec', 'shell_bg_status', 'terminal_start', 'routine_create', 'loop_create', 'task_create', 'routine_list', 'loop_list', 'task_list'];
const LONG = 'node -e "setTimeout(function(){},90000)"';
const CLAUSE = 'Deliverable naming is optional.';

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
const systemOf = body => (body.messages || []).filter(m => m.role === 'system').map(m => text(m.content)).join('\n');
const toolNames = body => (body.tools || []).map(t => t.function.name);
const lastUserIdx = body => { const m = body.messages || []; for (let i = m.length - 1; i >= 0; i--) if (m[i].role === 'user') return i; return -1; };
// the PARTIAL list of granted tools that are not loaded yet, as the [HARNESS] block names them
const namedDeferred = sys => { const m = /These exist and you CAN use them: ([^.]*)\./.exec(sys); return m ? m[1].split(', ') : []; };

function startUpstream(state) {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const probe = systemOf(body).indexOf(MARK) >= 0;
    if (probe) bodies.push(body);
    const msgs = body.messages || [];
    const at = lastUserIdx(body);
    const ask = userWords(msgs[at] || {});
    const results = msgs.slice(at + 1).filter(m => m.role === 'tool');
    for (const m of results) { const id = /Started background process (\S+) in your workspace/.exec(text(m.content)); if (id) state.bgId = id[1]; }
    // a COMMS task settles its Task Brief before consequential work (the brief gate), then acts, then answers
    const settle = { name: 'brief_proceed', args: { objective: 'do exactly what the Commander asked', deliverable: 'a one-line confirmation', assumptions: ['use the placed workbench'] } };
    let call = null;
    if (probe && /^BGSTART/.test(ask)) call = results.length === 0 ? settle : results.length === 1 ? { name: 'shell_exec', args: { cmd: LONG, background: true } } : null;
    if (probe && /^BGKILL/.test(ask)) call = results.length === 0 ? settle : results.length === 1 ? { name: 'shell_bg_kill', args: { id: state.bgId } } : null;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (call) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + bodies.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, bodies, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

function hermeticEnv() {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  // Full Access: shell_exec runs without an approval card (there is no page here to answer one)
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.0-dormant-followups' });
}

async function run(fixture, up, words, isTask) {
  const from = up.bodies.length;
  const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: 'custom', baseUrl: up.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: isTask !== false, streamId: 'dormant-comms',
    placed: FLOOR, stationPlaced: FLOOR, system: MARK + ': you are the lead.', messages: [{ role: 'user', content: words }] }) });
  A.eq(r.status, 200, words.slice(0, 24) + ': run accepted');
  const raw = await r.text();
  const events = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  return { bodies: up.bodies.slice(from), end: end && end.payload, events };
}

async function preview(fixture) {
  // no ?agent=: the default agent (the run's agentId) needs no roster row, which this fixture never pushes
  const placed = encodeURIComponent(FLOOR.map(o => encodeURIComponent(o.objectType)).join(','));
  const view = (await fixture.json('GET', '/api/toolsets?placed=' + placed)).body || {};
  A.ok(!view.error, 'GET /api/toolsets answered (' + (view.error || 'ok') + ')');
  return view.run || {};
}

(async () => {
  const state = { bgId: '' };
  const up = await startUpstream(state);
  const fixture = SidecarFixture.create({ prefix: 'starnet-dormant-followups-', timeoutMs: 30000, env: hermeticEnv() });
  try {
    await fixture.start();

    // ---- 1. fresh station: off the wire, named, previewed ----
    const p0 = await preview(fixture);
    for (const n of DORMANT) {
      const dotted = n.replace(/^shell_bg_/, 'shell.bg.').replace(/^(terminal|routine|loop|task)_/, '$1.');
      A.ok((p0.deferred || []).indexOf(dotted) >= 0 && p0.rows && p0.rows[dotted] && p0.rows[dotted].reason === 'dormant-followup',
        'GET /api/toolsets: ' + dotted + ' is previewed deferred as dormant-followup');
    }
    const r1 = await run(fixture, up, 'BGSTART: start the preview server in the background');
    A.eq(r1.end && r1.end.reason, 'done', 'the background-start run completes');
    A.ok(r1.bodies.length >= 3, 'the model was called after brief_proceed and again after shell_exec returned (' + r1.bodies.length + ' calls)');
    const [c1, cBrief, c2] = r1.bodies;
    for (const n of BG) A.ok(toolNames(cBrief || {}).indexOf(n) < 0, 'after brief_proceed alone: ' + n + ' is still off (nothing started yet)');
    const t1 = toolNames(c1 || {}), sys1 = systemOf(c1 || {});
    for (const n of STARTERS) A.ok(t1.indexOf(n) >= 0, 'fresh: ' + n + ' stays advertised');
    for (const n of DORMANT) A.ok(t1.indexOf(n) < 0, 'fresh: ' + n + ' is off the wire');
    const named = namedDeferred(sys1);
    for (const n of DORMANT) A.ok(named.indexOf(n) >= 0, 'fresh: ' + n + ' is NAMED in [HARNESS] (granted, usable through tool_search)');
    A.ok(t1.indexOf('deliverable_note') >= 0 && sys1.indexOf(CLAUSE) >= 0, 'a task call carrying deliverable_note keeps the deliverable clause');

    // ---- 2. the start reveals its controls on the next call ----
    A.ok(!!state.bgId, 'shell_exec started a real background process (' + state.bgId + ')');
    const t2 = toolNames(c2 || {});
    A.eq(t2.slice(0, t1.length), t1, 'the next call keeps every advertised tool in place (a reveal only appends)');
    for (const n of BG) A.ok(t2.indexOf(n) >= 0, 'after the background start: ' + n + ' is callable without a search');
    for (const n of TERMINAL.concat(MANAGE)) A.ok(t2.indexOf(n) < 0, 'after the background start: ' + n + ' stays off (nothing of its kind exists)');

    // ---- 3. a live handle: the next run advertises them from its first call ----
    const r2 = await run(fixture, up, 'how is the preview server doing?');
    const t3 = toolNames(r2.bodies[0] || {});
    for (const n of BG) A.ok(t3.indexOf(n) >= 0, 'next run, process alive: ' + n + ' is advertised at run start');
    for (const n of TERMINAL.concat(MANAGE)) A.ok(t3.indexOf(n) < 0, 'next run: ' + n + ' still off');
    A.ok(namedDeferred(systemOf(r2.bodies[0] || {})).indexOf('shell_bg_kill') < 0, 'next run: the advertised controls left the [HARNESS] not-loaded list');
    const p1 = await preview(fixture);
    A.ok((p1.advertised || []).indexOf('shell.bg.kill') >= 0, 'GET /api/toolsets previews the live handle the same way (advertised)');

    // ---- 4. kill it with the revealed control; dormant again afterwards ----
    const r3 = await run(fixture, up, 'BGKILL: stop the preview server');
    const last = r3.bodies[r3.bodies.length - 1] || {};
    const killed = ((last.messages || []).filter(m => m.role === 'tool').map(m => text(m.content)).pop()) || '';
    A.ok(r3.bodies.length >= 3 && killed.length > 0, 'shell_bg_kill ran and its result reached the model');
    A.ok(!/error|not found|no background process/i.test(killed), 'the kill succeeded: ' + killed.slice(0, 160));
    const r4 = await run(fixture, up, 'anything else running?');
    const t4 = toolNames(r4.bodies[0] || {});
    for (const n of BG) A.ok(t4.indexOf(n) < 0, 'after the kill: ' + n + ' is off the wire again');

    // ---- 5. a routine record brings routine_manage back ----
    const made = await fixture.json('POST', '/api/cron', { name: 'Hourly status', prompt: 'Report station status in one short paragraph.', schedule: 'every 1h', agentId: 'agent' });
    A.eq(made.status, 200, 'a routine is created through the ROUTINES route');
    const r5 = await run(fixture, up, 'what routines do I have?');
    const t5 = toolNames(r5.bodies[0] || {});
    A.ok(t5.indexOf('routine_manage') >= 0, 'with a routine on the station: routine_manage is advertised at run start');
    for (const n of ['loop_manage', 'task_manage']) A.ok(t5.indexOf(n) < 0, 'with only a routine: ' + n + ' stays off');

    // ---- 6. a chat turn: no tools, so no deliverable clause ----
    const r6 = await run(fixture, up, 'hi', false);
    const chat = r6.bodies[0] || {};
    A.eq(toolNames(chat).length, 0, 'a chat turn carries no tools');
    A.ok(systemOf(chat).length > 0 && systemOf(chat).indexOf(CLAUSE) < 0, 'a chat turn no longer asks for deliverable_note (it has nothing to call)');
  } finally {
    // the run above kills the child through shell_bg_kill (asserted); if that ever failed, the child ends itself at 90 s
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('dormant-followups.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
