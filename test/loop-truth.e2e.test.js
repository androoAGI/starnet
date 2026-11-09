/* node test/loop-truth.e2e.test.js — LOOP TRUTH through the REAL sidecar (cost plan W1.11).

   The unit invariant (loop-truth.invariant.test.js) pins the ledger, the premises and the counts on a stub registry. This
   drives the whole station path once: a hermetic SidecarFixture, the 'custom' provider pointed at a recording
   OpenAI-compatible mock on loopback (no inference), the real shell.exec running the real `node`, the real Task Brief gate,
   and the run row read back from GET /api/runs.

     wjrun      settle the brief + write hello.js, run `node hello.js`, answer   -> 3 model calls, no verify nudge, no counts
     writeonly  settle the brief + write src/app.js, answer (nothing run)       -> the one verify nudge, counted on the row
     heldend    write note.txt before the brief (the gate holds it), answer     -> ONE recovery note that says held, counted

   Each scenario's main-call count is the cost the lane is about: wjrun was 4 calls on e316231d7 (a false
   "ending without running anything" bought the 4th). */
'use strict';
const http = require('node:http');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const MARK = 'LOOP_TRUTH_E2E_LEAD';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '');
const BRIEF = { name: 'brief_proceed', args: { objective: 'do the task as asked', deliverable: 'the file', assumptions: ['use the workspace root'] } };
const PLANS = {
  SCEN_WJRUN: [[BRIEF, { name: 'fs_write', args: { path: 'hello.js', content: 'console.log("hello world");\n' } }], [{ name: 'shell_exec', args: { cmd: 'node hello.js' } }]],
  SCEN_WRITEONLY: [[BRIEF, { name: 'fs_write', args: { path: 'src/app.js', content: 'module.exports = 1;\n' } }]],
  SCEN_HELDEND: [[{ name: 'fs_write', args: { path: 'note.txt', content: 'note\n' } }]]
};

function startUpstream() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (req.method === 'GET' || !raw) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 200000 }] }));
    }
    let body; try { body = JSON.parse(raw); } catch (_) { body = {}; }
    const msgs = body.messages || [];
    const sys = msgs.filter(m => m.role === 'system').map(m => text(m.content)).join('\n');
    const tools = (body.tools || []).map(t => (t.function && t.function.name) || t.name);
    let dirIdx = -1, scen = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const mm = text(msgs[i].content).match(/\b(SCEN_[A-Z]+)\b/);
      if (mm) { dirIdx = i; scen = mm[1]; break; }
    }
    const main = sys.indexOf(MARK) >= 0 && tools.length > 0 && dirIdx >= 0;
    const after = dirIdx >= 0 ? msgs.slice(dirIdx + 1) : [];
    // every host note the loop added since the directive (system-role, or riding user-side on this wire)
    const hostNotes = after.filter(m => m.role === 'system' || m.role === 'user').map(m => text(m.content));
    const rec = { scen, main, hostNotes, toolResults: after.filter(m => m.role === 'tool').map(m => text(m.content)) };
    calls.push(rec);
    let out = null, reply = main ? 'Done: ' + scen + ' complete.' : (/title/i.test(sys) ? 'Loop Truth Probe' : 'NONE');
    if (main) {
      const steps = after.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length).length;
      const plan = PLANS[scen] || [];
      if (steps < plan.length) out = plan[steps].filter(c => tools.indexOf(c.name) >= 0);
      if (out && !out.length) out = null;
    }
    const promptTok = Math.ceil(raw.length / 4);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (out) {
      const tcs = out.map((c, k) => ({ index: k, id: 'call_' + calls.length + '_' + k, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: tcs } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: promptTok, completion_tokens: 30, total_tokens: promptTok + 30 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTok, completion_tokens: 8, total_tokens: promptTok + 8 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, calls, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

function hermeticEnv() {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.0-loop-truth' });
}

(async () => {
  const up = await startUpstream();
  const fixture = SidecarFixture.create({ prefix: 'loop-truth-e2e-', timeoutMs: 60000, env: hermeticEnv() });
  try {
    await fixture.start();
    async function scenario(name, words) {
      const from = up.calls.length;
      const streamId = 'loop-truth-' + name.toLowerCase();
      const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        provider: 'custom', baseUrl: up.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: true, placed: FLOOR, stationPlaced: FLOOR,
        system: MARK + ': you are the lead.', streamId, messages: [{ role: 'user', content: words + ' (' + name + ')' }] }) });
      A.eq(r.status, 200, name + ': run accepted');
      const events = (await r.text()).split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
      const main = up.calls.slice(from).filter(c => c.main && c.scen === name);
      const runs = await fixture.json('GET', '/api/runs?agent=agent&limit=20');
      const row = ((runs.body && runs.body.runs) || []).find(x => x.streamId === streamId) || null;
      const notes = main.length ? main[main.length - 1].hostNotes : [];
      return { end, main, row, notes, tagged: tag => notes.filter(t => t.indexOf('<' + tag + '>') >= 0) };
    }

    // ---- DONE MEANS: `node hello.js` ends without a nudge ----
    const wj = await scenario('SCEN_WJRUN', 'Create hello.js that prints hello world and run it');
    const ran = wj.main.length >= 3 ? wj.main[2].toolResults.join('\n') : '';
    A.ok(/hello world/.test(ran) && /\[exit 0\]\s*$/.test(ran.trim()), 'wjrun: the real shell ran the real `node hello.js` and the host stamped [exit 0]: ' + JSON.stringify(ran.slice(-120)));
    A.eq(wj.main.length, 3, 'wjrun: write, run, answer = 3 model calls (e316231d7 made 4: a false verify nudge bought one)');
    A.eq(wj.tagged('verify_before_done').length, 0, 'wjrun: no verify-on-stop nudge after a run that exited 0');
    A.eq(wj.end.reason, 'done', 'wjrun: the run ends done');
    A.ok(wj.row && wj.row.reason === 'done', 'wjrun: the run row is recorded');
    A.eq(wj.row && Object.prototype.hasOwnProperty.call(wj.row, 'nudges'), false, 'wjrun: a run no nudge touched keeps the row shape (no nudges field)');

    // ---- anti-fake-done still fires, and the row now counts it ----
    const wo = await scenario('SCEN_WRITEONLY', 'Create src/app.js that exports 1');
    A.eq(wo.tagged('verify_before_done').length, 1, 'writeonly: a code write with nothing run still gets its verify nudge');
    A.ok(wo.tagged('verify_before_done').every(t => t.indexOf('without running anything against it') >= 0), 'writeonly: ...with the premise that is true here (nothing ran)');
    A.eq(wo.main.length, 3, 'writeonly: write, answer, nudged answer = 3 model calls');
    A.eq(wo.row && wo.row.nudges, { verify_before_done: 1 }, 'writeonly: GET /api/runs shows the nudge count on the run row');

    // ---- a held call is reported as held, once, and counted ----
    const he = await scenario('SCEN_HELDEND', 'Save a note to note.txt');
    const fr = he.tagged('failure_recovery');
    A.eq(fr.length, 1, 'heldend: a call the Task Brief held buys one recovery note');
    A.ok(fr.length === 1 && !/The previous path failed/.test(fr[0]) && /\bheld\b/.test(fr[0]) && /nothing ran/.test(fr[0]), 'heldend: the note says held and nothing ran, never failed: ' + JSON.stringify(String(fr[0] || '').slice(0, 200)));
    A.eq(he.main.length, 3, 'heldend: held write, answer, noted answer = 3 model calls (e316231d7 made 4: two "failed" notes)');
    A.eq(he.row && he.row.nudges, { failure_recovery: 1 }, 'heldend: the run row counts the recovery note');
  } finally {
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('loop-truth.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
