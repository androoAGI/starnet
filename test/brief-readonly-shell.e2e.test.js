/* node test/brief-readonly-shell.e2e.test.js — A LOOK WITH THE SHELL IS NOT HELD BY THE TASK BRIEF (cost audit W3.12, 11-14).

   THE COST (StarNet credit-burn audit, vdigest L2 "Read-only shell is held by the gate"): shell.exec is scope 'execute',
   so the Task Brief gate held `ls`, `dir`, `rg` and `git status` until brief_proceed. A model that looks around with the
   shell first paid a whole full-context request for the held call, and settled its brief before it had looked.

   THE FIX UNDER TEST: behind STARNET_BRIEF_READONLY_SHELL (off by default), a shell.exec call that
   sidecar/readonly-shell.js can show only looks is not held (index.js briefHoldFor -> TaskBriefPolicy.looksOnly). It
   settles nothing: the first write still waits for the brief. Nothing but that gate changes.

   Drives the REAL sidecar twice (the switch off, then on): /api/run, the real Task Brief store and gate, the real
   shell.exec and fs.write, an agent in ASK (every consequential call asks its approval card), against a scripted
   OpenAI-compatible model on loopback. No inference, no keys.

     OFF  the gate as it was: every scenario below behaves as on 57c741da7 (the look is held first).
     ON   LOOKONLY  [ls] then the answer: 2 requests, not 3; no brief settled for a question that only looked.
          DOCTRINE  [ls], [git status], [brief_proceed, fs_write] (the prompt's own order): 4 requests, not 5; nothing held.
          NAIVE     [ls], [git status], [fs_write]: the two looks run, the WRITE is held until brief_proceed.
          NOTLOOK   a shell command that is not a look (a redirect) is held exactly as with the switch off.
          PROBE / DENY / FENCE / TAINT / TAINTNO: a look still gets the same approval card, the same "you said no", the
                    same workspace refusal and (on a run that carries an uploaded file's bytes) the same outside-content
                    card and denial as the same command gets with the switch off.
          HELDNOTE  a look and a write in one response, then the model stops: the host's held note names the write only.
          Every scenario's FIRST request is byte-identical off and on: the switch changes no prompt and no tool schema.

   RED on 57c741da7 (no switch there): the ON arm's looks are held. BRIEF_READONLY_SHELL_DUMP=<file> writes the OFF
   arm's normalized main request bodies: run it on 57c741da7's sources and on this lane's and compare the two files (the
   base-vs-lane byte-identity evidence; identical when this lane was cut, sha256 in the lane report). */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const MARK = 'BRIEF_READONLY_SHELL_LEAD';
const AGENT = 'looker';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const HELD = 'not run yet — waiting on the task brief';   // fork.js TaskIntent.GATE_HELD, the held-call stamp
const MAX_MAIN = 8;                                         // the scripted model never loops: past this it just answers

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '');
const stripNote = s => String(s || '').replace(/<run_context>[\s\S]*?<\/run_context>\s*/g, '');
const canon = (raw) => { try { return JSON.stringify(JSON.parse(raw || '{}')); } catch (_) { return String(raw || ''); } };
const sigOf = (name, argsRaw) => String(name) + ' ' + canon(argsRaw);
const sig = c => sigOf(c.name, JSON.stringify(c.args));
const gateHeld = r => /^ERROR: Task Brief gate/.test(String(r == null ? '' : r));

const BRIEF = { name: 'brief_proceed', args: { objective: 'save the note the Commander asked for', deliverable: 'the note file', assumptions: ['save it in the workspace root'] } };
const shell = cmd => ({ name: 'shell_exec', args: { cmd } });
const write = file => ({ name: 'fs_write', args: { path: file, content: 'note\n' } });
const LS = shell('ls'), GS = shell('git status');

// each step = the calls the model makes IN ONE RESPONSE, in the order it lists them. A held call is made again with
// brief_proceed listed first, as the hold's own words ask. quitOnHold: the model stops instead, until the host says more.
const SCENARIOS = {
  SCEN_LOOKONLY: { words: 'What is in this folder?', plan: [[LS]] },
  SCEN_DOCTRINE: { words: 'Look around, then save a note to ro-doctrine.txt', file: 'ro-doctrine.txt', plan: [[LS], [GS], [BRIEF, write('ro-doctrine.txt')]] },
  SCEN_NAIVE: { words: 'Look around, then save a note to ro-naive.txt', file: 'ro-naive.txt', plan: [[LS], [GS], [write('ro-naive.txt')]] },
  SCEN_NOTLOOK: { words: 'Write the listing to a file', file: 'ro-notlook.txt', plan: [[shell('echo RO_NOT_A_LOOK > ro-notlook.txt')]] },
  SCEN_PROBE: { words: 'Print the probe', plan: [[shell('echo RO_PROBE_RAN')]] },
  SCEN_DENY: { words: 'Print the second probe', plan: [[shell('echo RO_DENIED_PROBE')]], decide: () => 'deny' },
  SCEN_FENCE: { words: 'Read the file above the workspace', plan: [[shell('cat ../ro-outside.txt')]] },
  // attach: a real uploaded file rides the message, so the run has outside bytes in its context from its first turn
  SCEN_TAINT: { words: 'Print the third probe', plan: [[shell('echo RO_TAINT_PROBE')]], attach: true },
  SCEN_TAINTNO: { words: 'Print the fifth probe', plan: [[shell('echo RO_TAINT_DENIED')]], attach: true, decide: () => 'deny' },
  SCEN_HELDNOTE: { words: 'Print the fourth probe and save a note to ro-heldnote.txt', file: 'ro-heldnote.txt', quitOnHold: true, plan: [[shell('echo RO_HELDNOTE_PROBE'), write('ro-heldnote.txt')]] }
};

function startModel() {
  const seen = {};   // key (arm + scen) -> record
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
    let dirIdx = -1, scen = '', arm = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const mm = stripNote(text(msgs[i].content)).match(/\((SCEN_[A-Z]+) (off|on)\)/);
      if (mm) { dirIdx = i; scen = mm[1]; arm = mm[2]; break; }
    }
    const main = sys.indexOf(MARK) >= 0 && tools.length > 0 && dirIdx >= 0 && !!SCENARIOS[scen];
    let out = null, reply = 'NONE';
    if (main) {
      const sc = SCENARIOS[scen];
      const key = arm + ' ' + scen;
      const rec = seen[key] || (seen[key] = { main: 0, bytes: 0, held: 0, replies: [], bodies: [], notes: [], results: {}, first: {}, toolNames: tools.map(t => t && t.function && t.function.name) });
      rec.main++; rec.bytes += Buffer.byteLength(raw); rec.bodies.push(raw);
      const after = msgs.slice(dirIdx + 1);
      const results = new Map();
      for (const m of after) if (m.role === 'tool') results.set(m.tool_call_id, text(m.content));
      const state = new Map();   // call signature -> 'held' | 'done'
      let held = 0;
      for (const m of after) {
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
          const r = results.get(tc.id);
          if (r == null) continue;
          const s = sigOf(tc.function.name, tc.function.arguments);
          if (!(s in rec.first)) rec.first[s] = r;
          rec.results[s] = r;
          if (gateHeld(r)) { held++; if (state.get(s) !== 'done') state.set(s, 'held'); } else state.set(s, 'done');
        }
      }
      rec.held = Math.max(rec.held, held);
      // what the host said after a stop: the held note (loop.js nudgePremise) rides a later non-tool message
      rec.notes = after.filter(m => m.role !== 'tool' && m.role !== 'assistant').map(m => text(m.content)).filter(t => /held by the Task Brief gate, not failed/.test(t));
      const step = sc.plan.find(s => s.some(c => state.get(sig(c)) !== 'done'));
      if (step && rec.main < MAX_MAIN) {
        let calls = step.filter(c => state.get(sig(c)) !== 'done');
        const anyHeld = calls.some(c => state.get(sig(c)) === 'held');
        if (anyHeld && sc.quitOnHold && !rec.notes.length) reply = 'Stopping here.';
        else {
          if (anyHeld && state.get(sig(BRIEF)) !== 'done' && !calls.some(c => c.name === 'brief_proceed')) calls = [BRIEF].concat(calls);
          out = calls;
        }
      } else reply = 'Done: ' + scen + ' complete.';
      rec.replies.push(out ? out.map(c => c.name).join('+') : 'text');
    }
    const promptTok = Math.ceil(raw.length / 4);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (out) {
      const n = seen[arm + ' ' + scen].main;
      const tcs = out.map((c, k) => ({ index: k, id: 'call_' + scen + '_' + arm + '_' + n + '_' + k, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
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

function hermeticEnv(on) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  Object.assign(env, {
    SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.2-brief-readonly-shell',
    SKYNET_CONSENT_TIMEOUT_MS: '8000', STARNET_CONSENT_TIMEOUT_MS: '8000'
  });
  // off = the variable is not set at all (the default), exactly as an installed station runs
  if (on) env.STARNET_BRIEF_READONLY_SHELL = '1'; else { delete env.STARNET_BRIEF_READONLY_SHELL; delete env.SKYNET_BRIEF_READONLY_SHELL; }
  return env;
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

const fileText = p => { try { return p ? fs.readFileSync(p, 'utf8') : null; } catch (_) { return null; } };

async function drive(fixture, model, scen, arm) {
  const sc = SCENARIOS[scen];
  const message = { role: 'user', content: sc.words + ' (' + scen + ' ' + arm + ')' };
  if (sc.attach) {
    const up = await fixture.json('POST', '/api/attachments', { agent: AGENT, name: 'notes.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('OUTSIDE NOTES for ' + scen + ': nothing to do here.\n').toString('base64') });
    A.ok(up.body && up.body.ok === true && /^\.attachments\//.test(String(up.body.path)), arm + ' ' + scen + ': the outside file was uploaded: ' + JSON.stringify(up.body).slice(0, 160));
    message.attachments = [{ id: up.body.id, name: 'notes.txt', path: up.body.path, mediaType: 'text/plain', kind: 'file' }];
  }
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'custom', baseUrl: model.base, key: 'fixture-key', model: 'fixture-model', agentId: AGENT,
      streamId: 'brief-readonly-shell-' + arm + '-' + scen.toLowerCase(), isTask: true, placed: FLOOR, stationPlaced: FLOOR,
      system: MARK + ': you are the lead.', messages: [message]
    })
  });
  A.eq(response.status, 200, arm + ' ' + scen + ': the real /api/run admitted the task');
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
      // the Commander answers every card: once, unless the scenario says no
      if (ev.name === 'permission.prompt') await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: sc.decide ? sc.decide(ev.payload) : 'once' });
    }
  }
  const rec = model.seen[arm + ' ' + scen] || { main: 0, bytes: 0, held: 0, replies: [], bodies: [], notes: [], results: {}, first: {}, toolNames: [] };
  const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
  const cards = events.filter(e => e.name === 'permission.prompt' && e.payload).map(e => e.payload);
  const at = name => events.findIndex(e => e.name === name);
  return {
    rec, events, end, cards,
    shellCards: cards.filter(c => c.tool === 'shell.exec'),
    cardShape: cards.filter(c => c.tool === 'shell.exec').map(c => ({ tool: c.tool, scope: c.scope, argsSummary: c.argsSummary, exactCommand: c.exactCommand === true, outsideContent: c.outsideContent === true, fresh: c.fresh === true })),
    settled: events.filter(e => e.name === 'taskbrief.settled').length,
    settledAt: at('taskbrief.settled'),
    firstShellCardAt: events.findIndex(e => e.name === 'permission.prompt' && e.payload && e.payload.tool === 'shell.exec'),
    heldChips: events.filter(e => e.name === 'agent.tool_result' && e.payload && e.payload.summary === HELD).length,
    written: sc.file ? fileText(findFile(fixture.workspace, sc.file, 4)) : null,   // read now: the workspace is gone when the arm ends
    first: c => rec.first[sig(c)], last: c => rec.results[sig(c)]
  };
}

// the volatile bytes of a request body (ids, clocks, paths, ports), so the OFF arm's bodies compare across two trees
function normalized(raw, f) {
  let s = String(raw || '');
  for (const p of [f.workspace, f.workspace.replace(/\\/g, '\\\\'), f.workspace.replace(/\\/g, '/'), f.workspace.replace(/\\/g, '\\\\\\\\')]) if (p) s = s.split(p).join('<WS>');
  // the TRACK RECORD evidence lines are a 30-second wall-clock memo of run history (stationTrackRecord): an arm that
  // runs past 30s on a loaded box re-folds mid-arm and grows them, the other arm does not. A clock, not the switch.
  s = s.replace(/(?:\\n)*- TRACK RECORD: [^"\\]*/g, '');
  return s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?\b/g, '<TS>').replace(/\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?\b/gi, '<CLOCK>')
    .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? [A-Z][a-z]+ \d{1,2},? \d{4}\b/g, '<DATE>').replace(/\b\d{10,}\b/g, '<N>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>').replace(/\b(job|run|smp|sub|wi|sess)[-_][A-Za-z0-9_-]{6,}/g, '$1-<ID>').replace(/\b[0-9a-f]{12,}\b/g, '<HEX>');
}

// where two lists of bodies first differ (for a failure message)
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = String(a[i] == null ? '' : a[i]), y = String(b[i] == null ? '' : b[i]);
    if (x === y) continue;
    let k = 0; while (k < x.length && k < y.length && x[k] === y[k]) k++;
    return 'request ' + i + ' at ' + k + ': ' + JSON.stringify(x.slice(Math.max(0, k - 60), k + 100)) + ' vs ' + JSON.stringify(y.slice(Math.max(0, k - 60), k + 100));
  }
  return 'no difference';
}

async function arm(model, name) {
  const on = name === 'on';
  const fixture = SidecarFixture.create({ prefix: 'sk-brief-ro-' + name + '-', timeoutMs: 90000, env: hermeticEnv(on) });
  const out = {};
  try {
    await fixture.start();
    const seeded = await fixture.json('POST', '/api/roster', {
      updatedAt: 100,
      agents: [{ agentId: AGENT, system: MARK + ': you are the lead.', name: 'LOOKER', provider: 'custom', model: 'fixture-model', approvalMode: 'ask' }]
    });
    A.ok(seeded.body && seeded.body.ok === true, name + ': LOOKER runs in ASK (every consequential call asks its card)');
    for (const scen of Object.keys(SCENARIOS)) {
      const r = await drive(fixture, model, scen, name);
      out[scen] = r;
      console.log('[brief-readonly-shell] ' + name + ' ' + scen + ': main=' + r.rec.main + ' bytes=' + r.rec.bytes + ' held=' + r.rec.held + ' heldChips=' + r.heldChips
        + ' settled=' + r.settled + ' shellCards=' + r.shellCards.length + ' cards=' + r.cards.length + ' end=' + r.end.reason + ' replies=' + r.rec.replies.join(' | '));
    }
    out.bodies = {};
    for (const scen of Object.keys(SCENARIOS)) out.bodies[scen] = out[scen].rec.bodies.map(b => normalized(b, fixture));
  } finally {
    await fixture.dispose();
  }
  return out;
}

(async () => {
  const model = await startModel();
  let off = null, on = null;
  try {
    off = await arm(model, 'off');
    if (process.env.BRIEF_READONLY_SHELL_DUMP) fs.writeFileSync(process.env.BRIEF_READONLY_SHELL_DUMP, JSON.stringify(off.bodies, null, 1));
    on = await arm(model, 'on');
  } finally {
    model.server.close();
  }
  const ran = r => r != null && !gateHeld(r) && /\[exit /.test(String(r));

  /* ---- OFF: the gate as it was (57c741da7). Every look is held first; nothing else differs from before. ---- */
  {
    const r = off.SCEN_LOOKONLY;
    A.eq([r.rec.main, r.rec.held, r.settled, r.end.reason], [3, 1, 1, 'done'], 'off lookonly: the look is held, settled, made again, answered: 3 requests, 1 held');
    A.ok(gateHeld(r.first(LS)) && /make this same call again/.test(r.first(LS)), 'off lookonly: `ls` is held with the gate\'s usual words: ' + String(r.first(LS)).slice(0, 160));
    A.ok(off.SCEN_LOOKONLY.rec.toolNames.indexOf('shell_exec') >= 0 && off.SCEN_LOOKONLY.rec.toolNames.indexOf('brief_proceed') >= 0, 'off: the run carries shell_exec and brief_proceed');
  }
  A.eq([off.SCEN_DOCTRINE.rec.main, off.SCEN_DOCTRINE.rec.held, off.SCEN_DOCTRINE.settled, off.SCEN_DOCTRINE.written], [5, 1, 1, 'note\n'], 'off doctrine: 5 requests, 1 held (the first look), the note is written');
  A.eq([off.SCEN_NAIVE.rec.main, off.SCEN_NAIVE.rec.held, off.SCEN_NAIVE.settled, off.SCEN_NAIVE.written], [5, 1, 1, 'note\n'], 'off naive: 5 requests, 1 held (the first look), the note is written');
  A.ok(gateHeld(off.SCEN_NAIVE.first(LS)) && !gateHeld(off.SCEN_NAIVE.first(write('ro-naive.txt'))), 'off naive: the look was the held call; by the time the write came the brief was settled');
  A.eq([off.SCEN_PROBE.rec.held, off.SCEN_DENY.rec.held, off.SCEN_FENCE.rec.held, off.SCEN_TAINT.rec.held, off.SCEN_TAINTNO.rec.held, off.SCEN_NOTLOOK.rec.held, off.SCEN_HELDNOTE.rec.held], [1, 1, 1, 1, 1, 1, 2], 'off: every shell call is held once before the brief is settled');

  /* ---- ON 0. WHAT THE MODEL IS SENT: the first request of every scenario is the same bytes off and on (no prompt, tool
     schema or doctrine line moves with the switch). Only the arm word this test writes into its own message differs. ---- */
  {
    const armless = s => String(s).replace(/ (off|on)\)/g, ' ARM)').replace(/_(off|on)_/g, '_ARM_').replace(/-(off|on)-/g, '-ARM-');
    for (const scen of Object.keys(SCENARIOS)) {
      // an uploaded file's id is minted per upload: the two arms name two files
      const idless = s => armless(s).replace(/\.attachments\/[A-Za-z0-9_.-]+/g, '.attachments/<FILE>');
      A.ok(on.bodies[scen].length > 0 && idless(on.bodies[scen][0]) === idless(off.bodies[scen][0]),
        'on ' + scen + ': the first request is byte-identical to the switch off: ' + firstDiff([idless(on.bodies[scen][0])], [idless(off.bodies[scen][0])]));
    }
  }

  /* ---- ON 1. A QUESTION THAT ONLY LOOKS: 2 requests, not 3, and no brief is settled for it. ---- */
  {
    const r = on.SCEN_LOOKONLY;
    A.eq(r.end.reason, 'done', 'on lookonly: the run finishes normally');
    A.eq(r.rec.main, 2, 'on lookonly: [ls] then the answer costs 2 requests (off: ' + off.SCEN_LOOKONLY.rec.main + ')');
    A.eq([r.rec.held, r.heldChips], [0, 0], 'on lookonly: nothing is held, no "not run yet" chip');
    A.ok(ran(r.first(LS)), 'on lookonly: `ls` ran: ' + String(r.first(LS)).slice(0, 120));
    A.eq(r.settled, 0, 'on lookonly: looking settles nothing (no read card for a question that only looked)');
    A.eq(r.shellCards.length, 1, 'on lookonly: the look still asked its approval card');
    A.ok(r.rec.bytes < off.SCEN_LOOKONLY.rec.bytes, 'on lookonly: fewer request bytes (' + r.rec.bytes + ' < ' + off.SCEN_LOOKONLY.rec.bytes + ')');
  }
  /* ---- ON 2. THE PROMPT'S OWN ORDER: look, look, then brief_proceed with the first write. 4 requests, not 5. ---- */
  {
    const r = on.SCEN_DOCTRINE;
    A.eq(r.end.reason, 'done', 'on doctrine: the run finishes normally');
    A.eq(r.rec.main, 4, 'on doctrine: [ls], [git status], [brief_proceed, fs_write], answer = 4 requests (off: ' + off.SCEN_DOCTRINE.rec.main + ')');
    A.eq([r.rec.held, r.heldChips], [0, 0], 'on doctrine: nothing is held');
    A.ok(ran(r.first(LS)) && ran(r.first(GS)), 'on doctrine: both looks ran before the brief was settled');
    A.eq(r.settled, 1, 'on doctrine: exactly one taskbrief.settled, with the write');
    A.eq(r.written, 'note\n', 'on doctrine: the note is written');
    A.ok(r.rec.bytes < off.SCEN_DOCTRINE.rec.bytes, 'on doctrine: fewer request bytes (' + r.rec.bytes + ' < ' + off.SCEN_DOCTRINE.rec.bytes + ')');
  }
  /* ---- ON 3. THE WRITE STILL WAITS: [ls], [git status], [fs_write] with no brief. The looks run; the write is held. ---- */
  {
    const r = on.SCEN_NAIVE, w = write('ro-naive.txt');
    A.eq(r.end.reason, 'done', 'on naive: the run finishes normally');
    A.ok(ran(r.first(LS)) && ran(r.first(GS)), 'on naive: `ls` and `git status` ran without the brief: ' + String(r.first(GS)).slice(0, 120));
    A.ok(gateHeld(r.first(w)) && /make this same call again/.test(r.first(w)), 'on naive: the write is HELD until the brief is settled (a look does not settle it): ' + String(r.first(w)).slice(0, 160));
    A.eq(r.first(w), off.SCEN_NAIVE.first(LS), 'on naive: ...with the same words a held call always got');
    A.eq([r.rec.held, r.heldChips], [1, 1], 'on naive: exactly one held call, the write');
    A.eq(r.settled, 1, 'on naive: the brief is settled once, before the write runs');
    A.eq(r.written, 'note\n', 'on naive: the write ran after brief_proceed');
    A.eq(r.rec.main, 5, 'on naive: a model that never settles until held pays the hold once either way (off: ' + off.SCEN_NAIVE.rec.main + ')');
    A.eq(r.rec.replies.join(' | '), 'shell_exec | shell_exec | fs_write | brief_proceed+fs_write | text', 'on naive: the request sequence');
  }
  /* ---- ON 4. NOT A LOOK: a redirect is held exactly as with the switch off. ---- */
  {
    const r = on.SCEN_NOTLOOK, c = SCENARIOS.SCEN_NOTLOOK.plan[0][0];
    A.ok(gateHeld(r.first(c)), 'on notlook: `echo … > file` is held');
    A.eq(r.first(c), off.SCEN_NOTLOOK.first(c), 'on notlook: the held words are byte-identical to the switch off');
    A.eq([r.rec.main, r.rec.held, r.settled, r.rec.replies.join(' | ')], [off.SCEN_NOTLOOK.rec.main, off.SCEN_NOTLOOK.rec.held, off.SCEN_NOTLOOK.settled, off.SCEN_NOTLOOK.rec.replies.join(' | ')], 'on notlook: the same requests as off');
    // every request of this run, byte for byte, but for the arm word this test puts in its own message, ids and stream name
    const armless = s => String(s).replace(/ (off|on)\)/g, ' ARM)').replace(/_(off|on)_/g, '_ARM_').replace(/-(off|on)-/g, '-ARM-');
    const same = on.bodies.SCEN_NOTLOOK.length === off.bodies.SCEN_NOTLOOK.length && on.bodies.SCEN_NOTLOOK.every((b, i) => armless(b) === armless(off.bodies.SCEN_NOTLOOK[i]));
    A.ok(same, 'on notlook: every request body is byte-identical to the switch off (normalized): ' + firstDiff(on.bodies.SCEN_NOTLOOK.map(armless), off.bodies.SCEN_NOTLOOK.map(armless)));
    A.ok(/RO_NOT_A_LOOK/.test(String(r.written)), 'on notlook: it ran after the brief was settled: ' + JSON.stringify(r.written));
  }
  /* ---- ON 5. EVERY OTHER PROTECTION, FOR THE SAME COMMAND: the approval card. ---- */
  {
    const r = on.SCEN_PROBE, c = SCENARIOS.SCEN_PROBE.plan[0][0];
    A.eq(r.shellCards.length, 1, 'on probe: the look asked ONE shell.exec approval card');
    A.eq(r.cardShape, off.SCEN_PROBE.cardShape, 'on probe: the card is the one the same command gets with the switch off: ' + JSON.stringify(r.cardShape));
    A.ok(r.cardShape[0] && r.cardShape[0].exactCommand === true && /RO_PROBE_RAN/.test(r.cardShape[0].argsSummary), 'on probe: ...an exact-command card that shows the command');
    A.ok(/RO_PROBE_RAN/.test(String(r.first(c))) && ran(r.first(c)), 'on probe: approved once, it ran: ' + String(r.first(c)).slice(0, 120));
    A.eq(r.last(c), off.SCEN_PROBE.last(c), 'on probe: the result is the one off gives after its brief');
    A.eq([r.settled, r.rec.main], [0, 2], 'on probe: no brief was settled to get there (off: ' + off.SCEN_PROBE.rec.main + ' requests)');
    A.ok(off.SCEN_PROBE.firstShellCardAt > off.SCEN_PROBE.settledAt && off.SCEN_PROBE.settledAt >= 0, 'off probe: the card opened only after the brief was settled');
  }
  /* ---- ON 6. ...the Commander's No. ---- */
  {
    const r = on.SCEN_DENY, c = SCENARIOS.SCEN_DENY.plan[0][0];
    A.eq(r.shellCards.length, 1, 'on deny: the look asked its card');
    A.ok(/^ERROR: consent denied for shell\.exec/.test(String(r.last(c))), 'on deny: the Commander said no, so it did not run: ' + String(r.last(c)).slice(0, 140));
    A.eq(r.last(c), off.SCEN_DENY.last(c), 'on deny: the same denial as with the switch off');
    A.ok(!/RO_DENIED_PROBE\r?\n/.test(JSON.stringify(r.rec.results)) && !/\[exit /.test(String(r.last(c))), 'on deny: nothing ran');
    A.eq(r.cardShape, off.SCEN_DENY.cardShape, 'on deny: the same card as off');
  }
  /* ---- ON 7. ...the workspace fence. ---- */
  {
    const r = on.SCEN_FENCE, c = SCENARIOS.SCEN_FENCE.plan[0][0];
    A.ok(/refused: parent-directory \(\.\.\) paths are not allowed/.test(String(r.last(c))), 'on fence: a look that leaves the workspace is refused by the shell\'s floor: ' + String(r.last(c)).slice(0, 200));
    A.eq(r.last(c), off.SCEN_FENCE.last(c), 'on fence: the same refusal, word for word, as with the switch off');
    A.eq(r.cardShape, off.SCEN_FENCE.cardShape, 'on fence: the same card as off');
  }
  /* ---- ON 8. ...the outside-content lock: a run that started with outside bytes asks its exact-call card. ---- */
  {
    const r = on.SCEN_TAINT, c = SCENARIOS.SCEN_TAINT.plan[0][0];
    A.eq(r.shellCards.length, 1, 'on taint: ONE shell.exec card for the look');
    A.ok(r.cardShape[0] && r.cardShape[0].outsideContent === true, 'on taint: it is the outside-content card (no Always): ' + JSON.stringify(r.cardShape));
    A.eq(r.cardShape, off.SCEN_TAINT.cardShape, 'on taint: the same card as with the switch off');
    A.ok(/RO_TAINT_PROBE/.test(String(r.last(c))) && ran(r.last(c)), 'on taint: approved once, it ran');
    A.eq(r.last(c), off.SCEN_TAINT.last(c), 'on taint: the same result as off');
    A.ok(/OUTSIDE NOTES for SCEN_TAINT/.test(r.rec.bodies[0] || ''), 'on taint: the outside bytes really were in the run\'s context');
    const n = on.SCEN_TAINTNO, nc = SCENARIOS.SCEN_TAINTNO.plan[0][0];
    A.eq([n.shellCards.length, n.cardShape[0] && n.cardShape[0].outsideContent], [1, true], 'on taint, denied: the outside-content card was asked');
    A.ok(/^ERROR: consent denied for shell\.exec: the Commander said no on the approval card, so it was NOT run/.test(String(n.last(nc))), 'on taint, denied: the Commander\'s No stops the look: ' + String(n.last(nc)).slice(0, 160));
    A.eq(n.last(nc), off.SCEN_TAINTNO.last(nc), 'on taint, denied: the same words as with the switch off');
    A.ok(!/\[exit /.test(String(n.last(nc))), 'on taint, denied: nothing ran');
  }
  /* ---- ON 9. HELD-CALL ACCOUNTING: a look and a write in one response; the model stops. The note names the write only. ---- */
  {
    const r = on.SCEN_HELDNOTE, e = SCENARIOS.SCEN_HELDNOTE.plan[0][0], w = SCENARIOS.SCEN_HELDNOTE.plan[0][1];
    A.ok(ran(r.first(e)) && /RO_HELDNOTE_PROBE/.test(String(r.first(e))), 'on heldnote: the look in the batch ran');
    A.ok(gateHeld(r.first(w)), 'on heldnote: the write in the same batch was held');
    A.eq(r.rec.notes.length, 1, 'on heldnote: the host said so once after the model stopped (FR_HELD_MAX)');
    A.ok(/The previous call \(fs_write\) was held by the Task Brief gate, not failed: it did not run\./.test(r.rec.notes[0] || ''), 'on heldnote: the note names the write, and only the write: ' + String(r.rec.notes[0]).slice(0, 200));
    A.ok(!/shell_exec/.test(r.rec.notes[0] || ''), 'on heldnote: the look that ran is not called held');
    A.ok(/The previous calls \(shell_exec, fs_write\) were held by the Task Brief gate, not failed/.test(off.SCEN_HELDNOTE.rec.notes[0] || ''), 'off heldnote: both were held, and the note says both: ' + String(off.SCEN_HELDNOTE.rec.notes[0]).slice(0, 200));
    A.eq([r.settled, r.written, r.end.reason], [1, 'note\n', 'done'], 'on heldnote: the model then settles the brief and the write runs');
    const nudges = (r.end && r.end.nudges) || null;
    if (nudges) A.eq(nudges.failure_recovery, 1, 'on heldnote: one failure_recovery note counted on the run (W1.11)');
  }

  /* ---- THE SAVING, in one line each (requests and request bytes, off -> on). ---- */
  for (const scen of ['SCEN_LOOKONLY', 'SCEN_DOCTRINE', 'SCEN_NAIVE', 'SCEN_PROBE']) {
    console.log('[brief-readonly-shell] saving ' + scen + ': requests ' + off[scen].rec.main + ' -> ' + on[scen].rec.main + ', request bytes ' + off[scen].rec.bytes + ' -> ' + on[scen].rec.bytes
      + ' (' + (off[scen].rec.bytes - on[scen].rec.bytes) + ' fewer)');
  }
  A.report('brief-readonly-shell.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
