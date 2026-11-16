/* node test/taskbrief.held-answer.e2e.test.js — THE SETTLE DOES NOT ORDER PAST THE PERSON'S ANSWER (ops-1115 lane T3s).

   THE DEFECT (attack A4-F1 on the 0.15.2 candidate, verified by an independent skeptic): a write is held by the Task Brief,
   the agent asks "Should I replace the existing note file?", the person answers "No, keep it. Do not write anything.", the
   agent settles its brief, and the settle's reply said "Nothing has run yet: the call the brief held must be made again
   now, in this same turn, before you report any result: - fs_write". The host was ordering a call the person had just
   declined. The same order went out when the person answered with a different request, and (older than the lanes) when
   the "No" was given on the live question card in the same run.

   THE RULE UNDER TEST (sidecar/taskbrief-tools.js heldAgainNote): the settle's note states what the host knows. A call the
   brief held BEFORE an answer of the Commander is named as held and not run, and is owed once only if the task as it now
   stands still calls for it. Where no answer came between the hold and the settle (issue 187: held, settle, "done"), the
   model is still told plainly that nothing has run and the call must be made again.

   Drives the REAL sidecar (/api/run, the real Task Brief store, gate and question card, the real fs.write) against a
   scripted OpenAI-compatible model on loopback. One boot, five conversations. No inference, no keys.
   Red on 8ca33b1a6: NO, CHANGED, YES and LIVE-NO carry "must be made again now". The 187 control is green on both. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const MARK = 'HELD_ANSWER_LEAD';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const HELD = 'not run yet — waiting on the task brief';   // fork.js TaskIntent.GATE_HELD, the held-call stamp

const SETTLED = 'Task Brief settled. Consequential tools are unlocked.';
const ORDER = /must be made again|Nothing has run yet/;
const OWED = 'It is still owed, once, only if the task as it now stands, including what the Commander has answered since, still calls for it: then make it now, in this same turn, before you report any result. Otherwise it is not owed and stays not run.';
const BEFORE_QUESTION = SETTLED + '\nThis call was held by the brief before your question to the Commander, and did not run:\n- fs_write\n' + OWED;

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '');
const stripNote = s => String(s || '').replace(/<run_context>[\s\S]*?<\/run_context>\s*/g, '');

const BRIEF = { name: 'brief_proceed', args: { objective: 'do what the Commander decided', deliverable: 'a short answer', assumptions: ['follow the answer exactly'] } };
const ASK = { name: 'brief_ask', args: { dimension: 'safety', question: 'Should I replace the existing note file?', options: ['Yes, replace it', 'No, keep it'], recommended: 'No, keep it', reason: 'replacing it loses the old note', discoverable: false } };
const W = file => ({ name: 'fs_write', args: { path: file, content: 'NEW CONTENT\n' } });
const rowOf = file => '- fs_write ' + JSON.stringify(W(file).args);

/* each scenario = what the model does on its 1st, 2nd, ... request for that marker: an array is one response of tool
   calls, a string is its reply. Run 1 of a question case: the write is held, then the model asks (the run ends there). */
const SCENARIOS = {
  SCEN_NOA: [[W('t3s-no.txt')], [ASK], 'unused'], SCEN_NOB: [[BRIEF], 'Understood. I left the note alone.'],
  SCEN_CHA: [[W('t3s-changed.txt')], [ASK], 'unused'], SCEN_CHB: [[BRIEF], 'It is 4.'],
  SCEN_YESA: [[W('t3s-yes.txt')], [ASK], 'unused'], SCEN_YESB: [[BRIEF], [W('t3s-yes.txt')], 'Done. The note was replaced.'],
  SCEN_LIVE: [[W('t3s-live.txt')], [ASK], [BRIEF], 'Understood. I left the note alone.'],
  SCEN_PLAIN: [[W('t3s-187.txt')], [BRIEF], [W('t3s-187.txt')], 'Done. The note was saved.']
};

function startModel() {
  const seen = {};   // scen -> { main, toolResults }
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
      const mm = stripNote(text(msgs[i].content)).match(/\b(SCEN_[A-Z0-9]+)\b/);
      if (mm) { dirIdx = i; scen = mm[1]; break; }
    }
    const main = sys.indexOf(MARK) >= 0 && tools.length > 0 && dirIdx >= 0 && !!SCENARIOS[scen];
    let out = null, reply = 'NONE';
    if (main) {
      const rec = seen[scen] || (seen[scen] = { main: 0, toolResults: [] });
      // what the model has in front of it for this marker: every tool result since the person's words
      rec.toolResults = msgs.slice(dirIdx + 1).filter(m => m.role === 'tool').map(m => text(m.content));
      const seq = SCENARIOS[scen];
      const step = seq[Math.min(rec.main, seq.length - 1)];
      rec.main++;
      if (Array.isArray(step)) out = step; else reply = String(step);
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
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.2-held-answer',
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

/* one desk run over the real /api/run. o.live: the person's answer on the live question card; without it the person
   leaves the card, so the question ends the run (the path a channel, the phone and an unattended run always take). */
async function deskRun(fixture, model, o) {
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'custom', baseUrl: model.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent',
      streamId: o.streamId, isTask: true, placed: FLOOR, stationPlaced: FLOOR,
      system: MARK + ': you are the lead.', messages: o.messages
    })
  });
  A.eq(response.status, 200, o.streamId + ': the real /api/run admitted the run');
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
      if (ev.name === 'permission.prompt' && ev.payload && ev.payload.tool === 'brief.ask') {
        if (o.live) await fixture.json('POST', '/api/consent/answer', { runId, promptId: ev.payload.promptId, answer: o.live });
        else await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: 'deny' });
      }
    }
  }
  return {
    end: (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {},
    reply: events.filter(e => e.name === 'agent.token' && e.payload && typeof e.payload.delta === 'string').map(e => e.payload.delta).join(''),
    held: events.filter(e => e.name === 'agent.tool_result' && e.payload && e.payload.summary === HELD).length
  };
}

(async () => {
  const model = await startModel();
  const fixture = SidecarFixture.create({ prefix: 'sk-held-answer-', timeoutMs: 60000, env: hermeticEnv() });
  // what brief_proceed told the model: the last tool result of that marker that opens with the settle line
  const settleSaid = (scen) => ((model.seen[scen] || { toolResults: [] }).toolResults.filter(t => t.indexOf(SETTLED) === 0).pop()) || '';
  const briefOnDisk = (stream) => {
    const file = findFile(fixture.workspace, 'task-briefs.json', 3);
    if (!file) return null;
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const all = rec.briefs || (rec.value && rec.value.briefs) || [];
    return all.filter(b => b.key === 'stream:' + stream).pop() || null;
  };
  // a question case: run 1 (the write is held, the model asks, the person leaves the card), then the person's later reply
  async function questionCase(tag, stream, file, scenA, scenB, answer) {
    const first = 'Replace the note file with new content (' + scenA + ')';
    const a = await deskRun(fixture, model, { streamId: stream, messages: [{ role: 'user', content: first }] });
    A.eq(a.held, 1, tag + ': run 1 holds the write on the brief (one "not run yet" chip)');
    A.ok(/Should I replace the existing note file\?/.test(a.reply), tag + ': run 1 ends on the agent\'s question: ' + JSON.stringify(a.reply.slice(0, 120)));
    const kept = briefOnDisk(stream);
    A.eq(kept && [kept.status, kept.heldCalls], ['clarifying', ['fs_write']], tag + ': the held name is kept on the brief across the question');
    const b = await deskRun(fixture, model, { streamId: stream, messages: [{ role: 'user', content: first }, { role: 'assistant', content: a.reply }, { role: 'user', content: answer + ' (' + scenB + ')' }] });
    const said = settleSaid(scenB);
    console.log('[held-answer] ' + tag + ': end=' + b.end.reason + ' modelCalls=' + ((model.seen[scenB] || {}).main || 0) + ' written=' + (findFile(fixture.workspace, file, 4) ? 'yes' : 'no') + ' settleSaid=' + JSON.stringify(said));
    return { b, said, written: findFile(fixture.workspace, file, 4) };
  }
  try {
    await fixture.start();

    // ---- NO: "No, keep it. Do not write anything." The settle states the fact and orders nothing. ----
    {
      const r = await questionCase('NO', 'held-answer-no', 't3s-no.txt', 'SCEN_NOA', 'SCEN_NOB', 'No, keep it. Do not write anything.');
      A.ok(!!r.said, 'NO: the model settled its brief in the answer run');
      A.ok(!ORDER.test(r.said), 'NO: after "No, keep it" the settle\'s reply carries NO order to make the held call: ' + JSON.stringify(r.said));
      A.eq(r.said, BEFORE_QUESTION, 'NO: it states the fact (held before the question, did not run) and that the call is owed only if the task still calls for it');
      A.eq(r.b.end.reason, 'done', 'NO: the run ends as before');
      A.ok(/I left the note alone/.test(r.b.reply), 'NO: the model\'s reply is delivered');
      A.ok(!r.written, 'NO: the declined write never ran: ' + (r.written || 'no file'));
    }
    // ---- CHANGED: the person answers with a different request. Same fact, no order. ----
    {
      const r = await questionCase('CHANGED', 'held-answer-changed', 't3s-changed.txt', 'SCEN_CHA', 'SCEN_CHB', 'Actually just tell me what 2 plus 2 is.');
      A.ok(!ORDER.test(r.said), 'CHANGED: after a different request the settle\'s reply carries NO order to make the held call: ' + JSON.stringify(r.said));
      A.eq(r.said, BEFORE_QUESTION, 'CHANGED: the fact and the condition, as for "No"');
      A.eq(r.b.end.reason, 'done', 'CHANGED: the run ends as before');
      A.ok(!r.written, 'CHANGED: the write never ran: ' + (r.written || 'no file'));
    }
    // ---- YES (control): the model is still told the call has not run, makes it, and the file is written. ----
    {
      const r = await questionCase('YES', 'held-answer-yes', 't3s-yes.txt', 'SCEN_YESA', 'SCEN_YESB', 'Yes, replace it');
      A.ok(/held by the brief before your question to the Commander, and did not run:\n- fs_write\n/.test(r.said), 'YES: the model is still told the held call did not run: ' + JSON.stringify(r.said));
      A.ok(/still owed, once, only if the task as it now stands/.test(r.said) && /then make it now, in this same turn, before you report any result/.test(r.said),
        'YES: ...and that it is owed now, in this same turn, when the task still calls for it');
      A.eq(r.b.end.reason, 'done', 'YES: the run ends done');
      A.ok(!!r.written && fs.readFileSync(r.written, 'utf8') === 'NEW CONTENT\n', 'YES: the write the person agreed to ran: ' + (r.written || 'no file'));
    }
    // ---- LIVE-NO: the same "No" given on the live question card, in the same run (the desk's primary path). ----
    {
      const r = await deskRun(fixture, model, { streamId: 'held-answer-live', live: 'No, keep it', messages: [{ role: 'user', content: 'Replace the note file with new content (SCEN_LIVE)' }] });
      const said = settleSaid('SCEN_LIVE');
      console.log('[held-answer] LIVE-NO: end=' + r.end.reason + ' settleSaid=' + JSON.stringify(said));
      A.eq(r.held, 1, 'LIVE-NO: the write is held before the question');
      A.ok((model.seen.SCEN_LIVE || { toolResults: [] }).toolResults.some(t => /The Commander answered "No, keep it"/.test(t)), 'LIVE-NO: the answer came back on the live card, in the same run');
      A.ok(!ORDER.test(said), 'LIVE-NO: after a "No" on the live card the settle\'s reply carries NO order to make the held call: ' + JSON.stringify(said));
      A.eq(said, SETTLED + '\nThis call was held by the brief before the Commander answered your question, and did not run:\n' + rowOf('t3s-live.txt') + '\n' + OWED,
        'LIVE-NO: it states the fact with the call\'s own arguments, and the condition');
      A.eq(r.end.reason, 'done', 'LIVE-NO: the run ends as before');
      A.ok(!findFile(fixture.workspace, 't3s-live.txt', 4), 'LIVE-NO: the declined write never ran');
    }
    // ---- THE ISSUE 187 CONTROL: held, settle, no question. The model is told plainly that nothing has run. ----
    {
      const r = await deskRun(fixture, model, { streamId: 'held-answer-187', messages: [{ role: 'user', content: 'Save the note file (SCEN_PLAIN)' }] });
      const said = settleSaid('SCEN_PLAIN');
      console.log('[held-answer] 187: end=' + r.end.reason + ' settleSaid=' + JSON.stringify(said));
      A.eq(said, SETTLED + '\nNothing has run yet: the call the brief held must be made again now, in this same turn, before you report any result:\n' + rowOf('t3s-187.txt'),
        '187 control: with no answer between the hold and the settle the model is told plainly that nothing has run and the call must be made again');
      A.eq(r.end.reason, 'done', '187 control: the run ends done');
      const written = findFile(fixture.workspace, 't3s-187.txt', 4);
      A.ok(!!written && fs.readFileSync(written, 'utf8') === 'NEW CONTENT\n', '187 control: the model made the call again and the file is written');
    }
    const bad = fixture.output().split('\n').filter(l => /unhandled|UnhandledPromiseRejection|TypeError|ReferenceError|uncaught/i.test(l));
    A.eq(bad.slice(0, 5), [], 'the sidecar log carries no unhandled error');
  } finally {
    await fixture.dispose();
    model.server.close();
  }
  A.report('taskbrief.held-answer.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
