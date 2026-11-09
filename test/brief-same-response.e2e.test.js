/* node test/brief-same-response.e2e.test.js — THE TASK BRIEF SETTLES IN THE SAME RESPONSE (cost audit W1.2, 11-08).

   THE COST (StarNet credit-burn audit on trunk e316231d7): a consequential task message made one extra full-context request
   to settle the Task Brief. The prompts said to call brief_proceed "immediately before" the first write, and the gate read
   the brief at the moment each call ran, in the order the model happened to list them. So a model that sent
   [fs_write, brief_proceed] in one response had its write held, settled the brief, and paid a whole request to make the
   same write again (3 main calls, 1 held); [brief_proceed, fs_write] passed in 2. Station evidence: gated runs carry about
   +1 request (mode exactly +1), about 8% of a median gated run and a third of a 3-request task.

   THE FIX UNDER TEST: brief calls run first in a sequential batch (taskbrief-policy.js settleFirst, wired by index.js
   briefFirstOrder into loop.js), so the order inside one response no longer matters, and the prompts tell the model to send
   brief_proceed in the same response as its first write. A batch that carries brief_ask keeps its order: the question
   still pauses the run and the write is still held.

   Drives the REAL sidecar (/api/run, the real Task Brief store and gate, the real fs.write) against a scripted
   OpenAI-compatible model on loopback. No inference, no keys. On e316231d7 the [fs_write, brief_proceed] run makes 3 main
   calls with 1 held; with the fix it makes 2 with nothing held. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const MARK = 'BRIEF_SAME_RESPONSE_LEAD';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const HELD = 'not run yet — waiting on the task brief';   // fork.js TaskIntent.GATE_HELD, the held-call stamp
const MAX_MAIN = 5;                                         // the scripted model never loops: past this it just answers

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '');
const stripNote = s => String(s || '').replace(/<run_context>[\s\S]*?<\/run_context>\s*/g, '');
const canon = (raw) => { try { return JSON.stringify(JSON.parse(raw || '{}')); } catch (_) { return String(raw || ''); } };
const sigOf = (name, argsRaw) => String(name) + ' ' + canon(argsRaw);
const sig = c => sigOf(c.name, JSON.stringify(c.args));

const BRIEF = { name: 'brief_proceed', args: { objective: 'save the note the Commander asked for', deliverable: 'the note file', assumptions: ['save it in the workspace root'] } };
const ASK = { name: 'brief_ask', args: { dimension: 'audience', question: 'Who will read this note?', options: ['the whole team', 'only me'], recommended: 'the whole team', reason: 'it decides how much context the note needs', discoverable: false } };
const write = file => ({ name: 'fs_write', args: { path: file, content: 'note\n' } });

// each step = the calls the model makes IN ONE RESPONSE, in the order it lists them
const SCENARIOS = {
  SCEN_REVPAR: { words: 'Save a note to brief-revpar.txt', file: 'brief-revpar.txt', plan: [[write('brief-revpar.txt'), BRIEF]] },
  SCEN_FWDPAR: { words: 'Save a note to brief-fwdpar.txt', file: 'brief-fwdpar.txt', plan: [[BRIEF, write('brief-fwdpar.txt')]] },
  // brief_ask in the batch: the question must still pause the run BEFORE the write, even with brief_proceed listed too
  SCEN_ASKHOLD: { words: 'Save a note to brief-askhold.txt', file: 'brief-askhold.txt', plan: [[write('brief-askhold.txt'), ASK, BRIEF]] }
};

function startModel() {
  const seen = {};   // scen -> { main, held, firstTools, firstSystem, replies }
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (req.method === 'GET' || !raw) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 200000 }] }));
    }
    let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const sys = msgs.filter(m => m.role === 'system').map(m => text(m.content)).join('\n');
    const tools = Array.isArray(body.tools) ? body.tools : [];
    let dirIdx = -1, scen = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const mm = stripNote(text(msgs[i].content)).match(/\b(SCEN_[A-Z]+)\b/);
      if (mm) { dirIdx = i; scen = mm[1]; break; }
    }
    const main = sys.indexOf(MARK) >= 0 && tools.length > 0 && dirIdx >= 0 && !!SCENARIOS[scen];
    let out = null, reply = 'NONE';
    if (main) {
      const rec = seen[scen] || (seen[scen] = { main: 0, held: 0, firstTools: tools, firstSystem: sys, replies: [] });
      rec.main++;
      const after = msgs.slice(dirIdx + 1);
      const results = new Map();
      for (const m of after) if (m.role === 'tool') results.set(m.tool_call_id, text(m.content));
      const done = new Set();
      let held = 0;
      for (const m of after) {
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
          const r = results.get(tc.id);
          if (r != null && !/^ERROR/.test(r)) done.add(sigOf(tc.function.name, tc.function.arguments));
          if (r != null && /^ERROR: Task Brief gate/.test(r)) held++;
        }
      }
      rec.held = Math.max(rec.held, held);
      const step = SCENARIOS[scen].plan.find(s => s.some(c => !done.has(sig(c))));
      if (step && rec.main < MAX_MAIN) out = step.filter(c => !done.has(sig(c)));
      else reply = 'Done: ' + scen + ' complete.';
      rec.replies.push(out ? out.map(c => c.name).join('+') : 'text');
    }
    const promptTok = Math.ceil(raw.length / 4);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (out) {
      const tcs = out.map((c, k) => ({ index: k, id: 'call_' + scen + '_' + seen[scen].main + '_' + k, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: tcs } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: promptTok, completion_tokens: 30, total_tokens: promptTok + 30 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTok, completion_tokens: 8, total_tokens: promptTok + 8 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, seen, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

function hermeticEnv() {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, {
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.0-brief-same-response',
    SKYNET_CONSENT_TIMEOUT_MS: '8000', STARNET_CONSENT_TIMEOUT_MS: '8000'
  });
}

function findFile(root, name, depth) {
  if (depth < 0) return '';
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return ''; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const hit = findFile(p, name, depth - 1); if (hit) return hit; }
  }
  return '';
}

async function drive(fixture, model, scen) {
  const sc = SCENARIOS[scen];
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'custom', baseUrl: model.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent',
      streamId: 'brief-same-response-' + scen.toLowerCase(), isTask: true, placed: FLOOR, stationPlaced: FLOOR,
      system: MARK + ': you are the lead.', messages: [{ role: 'user', content: sc.words + ' (' + scen + ')' }]
    })
  });
  A.eq(response.status, 200, scen + ': the real /api/run admitted the task');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', runId = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      events.push(ev);
      if (ev.name === 'agent.run.start') runId = ev.payload.runId;
      // the Commander walks away from the question card: brief_ask falls back to the durable end-run question
      if (ev.name === 'permission.prompt' && ev.payload && ev.payload.tool === 'brief.ask') {
        await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: 'deny' });
      }
    }
  }
  const rec = model.seen[scen] || { main: 0, held: 0, replies: [], firstTools: [], firstSystem: '' };
  const visible = events.filter(e => e.name === 'agent.tool_result' && e.payload);
  const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
  return {
    rec, events, end,
    settled: events.filter(e => e.name === 'taskbrief.settled').length,
    heldEvents: visible.filter(e => e.payload.summary === HELD).length,
    written: findFile(fixture.workspace, sc.file, 4)
  };
}

(async () => {
  const model = await startModel();
  const fixture = SidecarFixture.create({ prefix: 'sk-brief-same-', timeoutMs: 60000, env: hermeticEnv() });
  const line = (scen, r) => console.log('[brief-same-response] ' + scen + ': main=' + r.rec.main + ' held=' + r.rec.held + ' heldChips=' + r.heldEvents
    + ' settled=' + r.settled + ' written=' + (r.written ? 'yes' : 'no') + ' end=' + r.end.reason + ' replies=' + r.rec.replies.join(' | '));
  try {
    await fixture.start();

    // ---- 1. THE COST: write listed BEFORE brief_proceed in one response. e316231d7: 3 main calls, 1 held. ----
    {
      const r = await drive(fixture, model, 'SCEN_REVPAR');
      line('SCEN_REVPAR', r);
      A.eq(r.end.reason, 'done', 'revpar: the run finishes normally');
      A.eq(r.rec.main, 2, 'revpar: [fs_write, brief_proceed] in one response costs 2 main calls, not 3 (the settle runs first, no retry turn)');
      A.eq(r.rec.held, 0, 'revpar: the model never sees a held result (nothing waits on the brief)');
      A.eq(r.heldEvents, 0, 'revpar: no write draws a "not run yet" chip');
      A.eq(r.settled, 1, 'revpar: exactly one taskbrief.settled (one read card) for the run');
      A.ok(!!r.written && fs.readFileSync(r.written, 'utf8') === 'note\n', 'revpar: the write ran in the first response: ' + (r.written || 'no file'));
      // what the model is told reaches the wire
      const proceed = (r.rec.firstTools || []).map(t => t && t.function).find(f => f && f.name === 'brief_proceed');
      A.ok(!!proceed && /same response/i.test(String(proceed.description)) && /listed first/i.test(String(proceed.description)),
        'revpar: brief_proceed\'s description on the wire says to send it in the same response, listed first: ' + JSON.stringify(proceed && proceed.description));
      A.ok(/brief_ask/.test(String(proceed && proceed.description)), 'revpar: ...and still points a material question at brief_ask');
      A.ok(/brief_proceed in the SAME response as your first consequential tool call/.test(r.rec.firstSystem),
        'revpar: the Task Brief doctrine on the wire says the same');
      A.ok(!/Call brief_proceed immediately before the first consequential tool/.test(r.rec.firstSystem), 'revpar: the old "immediately before" line is gone');
    }

    // ---- 2. The order that already worked keeps working: brief_proceed listed first. ----
    {
      const r = await drive(fixture, model, 'SCEN_FWDPAR');
      line('SCEN_FWDPAR', r);
      A.eq(r.end.reason, 'done', 'fwdpar: the run finishes normally');
      A.eq(r.rec.main, 2, 'fwdpar: [brief_proceed, fs_write] stays at 2 main calls');
      A.eq(r.rec.held, 0, 'fwdpar: nothing held');
      A.eq(r.settled, 1, 'fwdpar: exactly one taskbrief.settled');
      A.ok(!!r.written, 'fwdpar: the write ran');
    }

    // ---- 3. brief_ask in the batch keeps the batch's order: the write is still HELD and the question still pauses. ----
    {
      const r = await drive(fixture, model, 'SCEN_ASKHOLD');
      line('SCEN_ASKHOLD', r);
      A.eq(r.rec.main, 1, 'askhold: the question ends the run in its first response (nothing settled ahead of it)');
      A.eq(r.heldEvents, 1, 'askhold: the write listed with brief_ask is held ("not run yet"), exactly as before');
      A.ok(!r.written, 'askhold: the held write never ran: ' + (r.written || 'no file'));
      A.eq(r.settled, 0, 'askhold: brief_proceed did NOT jump ahead of the question (no read card while a question is open)');
      const asked = r.events.some(e => e.name === 'agent.token' && /TASK_QUESTION:\s*Who will read this note\?/.test(String(e.payload && e.payload.delta)))
        || /TASK_QUESTION:\s*Who will read this note\?/.test(JSON.stringify(r.events.filter(e => /agent\.(token|run\.end)/.test(e.name)).map(e => e.payload)));
      A.ok(asked, 'askhold: the run ends on the Commander\'s question (the durable TASK_QUESTION fallback)');
    }
  } finally {
    await fixture.dispose();
    model.server.close();
  }
  A.report('brief-same-response.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
