/* node test/batch-hint.e2e.test.js — THE BATCHING SENTENCE (cost audit W2.3, 2026-11-14), on the wire.

   THE COST: every reply that carries one tool call re-sends the whole prompt for the next one. No line of the task prompt
   asked a model to put independent calls in one reply (on the station the audit measured, codex runs averaged 1.14 to 1.18
   calls per reply and todo rode alone in 519 of 531 calls).

   THE CHANGE UNDER TEST: one sentence at the end of the task doctrine (HOW TO WORK), behind STARNET_BATCH_HINT, off by
   default (sidecar/batch-hint.js; the pure half is test/batch-hint.test.js).

   Drives the REAL sidecar (/api/run, the real prompt assembly, the real loop and tools) against a recording
   OpenAI-compatible model on loopback. No inference, no keys. Three stations, one after the other, the same requests:
     OFF   the switch unset                  the request the base sends
     ZERO  STARNET_BATCH_HINT=0              the same bytes as OFF: system text, tool array, every message
     ON    STARNET_BATCH_HINT=1              OFF's system text with exactly the sentence added at one place (after the
                                             doctrine's last sentence), and nothing else in the request changed
   and on the ON station:
     - the system text is the same bytes on the second message of a conversation and on every request of a run (the
       sentence is static: it sits in the cached prefix);
     - WHAT A COMPLYING MODEL SAVES (the mechanism, scripted, not a measurement of any real model): the same three
       independent calls sent one per reply cost 4 requests, sent together 2; and a todo update, a read, brief_proceed and the
       first write in ONE reply still settle and write in that reply (the sentence composes with W1.2).

   RED on the base (agent/cand-0152 57c741da7): nothing reads the switch, so the ON station sends the OFF bytes.
   BATCH_HINT_DUMP=<file> writes the OFF station's normalized request (system text, tools, messages): run on the base and on
   the lane, the two files are byte-identical (the base-vs-lane evidence). */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords, runContextOf } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';
const MARK = 'BATCH_HINT_LEAD';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const WITH_TODO = 'When you need several independent things (file reads, searches, listings, a todo update alongside the next real call), request them together in one reply rather than one per reply; a call whose arguments depend on a result you have not seen yet waits for the next reply. ';
const NO_TODO = 'When you need several independent things (file reads, searches, listings), request them together in one reply rather than one per reply; a call whose arguments depend on a result you have not seen yet waits for the next reply. ';
const DOCTRINE_END = 'never narrate routine obstacles as failures, and never apologize for them. ';
const HELD = 'not run yet — waiting on the task brief';

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '');
const leadingSystem = body => { const m = (body.messages || [])[0]; return m && m.role === 'system' ? text(m.content) : ''; };
const sha = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const count = (hay, needle) => String(hay).split(needle).length - 1;

const LIST = { name: 'fs_list', args: { path: '.' } };
const READ = { name: 'fs_read', args: { path: 'batch-a.txt' } };
const SEARCH = { name: 'fs_search', args: { query: 'batch', path: '.' } };
const TODO = { name: 'todo', args: { todos: [{ id: 't1', content: 'read the note', status: 'in_progress' }, { id: 't2', content: 'save the summary', status: 'pending' }] } };
const BRIEF = { name: 'brief_proceed', args: { objective: 'save the summary the Commander asked for', deliverable: 'the summary file', assumptions: ['save it in the workspace root'] } };
const WRITE = { name: 'fs_write', args: { path: 'batch-summary.txt', content: 'summary\n' } };
// each step = the calls the scripted model makes IN ONE REPLY
const PLANS = {
  SCEN_PLAIN: [],                                   // answers at once: the request whose bytes are compared
  SCEN_SEED: [[{ name: 'fs_write', args: { path: 'batch-a.txt', content: 'batch note\n' } }]],   // the note the reads below open, written by the real fs.write
  SCEN_SERIAL: [[LIST], [READ], [SEARCH]],          // one call per reply
  SCEN_BATCHED: [[LIST, READ, SEARCH]],             // the same three calls in one reply
  SCEN_SETTLE: [[TODO, READ, BRIEF, WRITE]]         // a todo update, a read, the settle and the first write in one reply
};

function startModel() {
  const mains = [];   // every main request: { scen, raw, body }
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (req.method === 'GET' || !raw) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 200000 }] }));
    }
    let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    let dirIdx = -1, scen = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const mm = userWords(msgs[i]).match(/\b(SCEN_[A-Z]+)\b/);
      if (mm) { dirIdx = i; scen = mm[1]; break; }
    }
    const main = leadingSystem(body).indexOf(MARK) >= 0 && tools.length > 0 && dirIdx >= 0 && !!PLANS[scen];
    let out = null;
    if (main) {
      mains.push({ scen, raw, body });
      const after = msgs.slice(dirIdx + 1);
      const answered = new Set();
      for (const m of after) if (m.role === 'tool') answered.add(m.tool_call_id);
      const asked = [];
      for (const m of after) if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (answered.has(tc.id)) asked.push(tc.function.name);
      // the next step whose calls have not all been made yet (each plan names a tool at most once)
      const step = PLANS[scen].find(s => s.some(c => asked.indexOf(c.name) < 0));
      if (step && mains.filter(m => m.scen === scen).length <= 6) out = step;
    }
    const promptTok = Math.ceil(raw.length / 4);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (out) {
      const n = mains.length;
      const tcs = out.map((c, k) => ({ index: k, id: 'call_' + scen + '_' + n + '_' + k, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: tcs } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: promptTok, completion_tokens: 30, total_tokens: promptTok + 30 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: main ? 'Done: ' + scen + ' complete.' : 'NONE' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTok, completion_tokens: 8, total_tokens: promptTok + 8 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, mains, port: server.address().port, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

function hermeticEnv(extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  // the switch under test is ABSENT unless an arm sets it (a blank STARNET_ value is a value: ENV() would read it)
  delete env.STARNET_BATCH_HINT; delete env.SKYNET_BATCH_HINT;
  return Object.assign(env, {
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.2-batch-hint',
    SKYNET_CONSENT_TIMEOUT_MS: '8000', STARNET_CONSENT_TIMEOUT_MS: '8000'
  }, extra || {});
}

async function drive(fixture, model, scen, o) {
  const from = model.mains.length;
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'custom', baseUrl: model.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent',
      streamId: (o && o.streamId) || undefined, isTask: true, placed: FLOOR, stationPlaced: FLOOR,
      system: MARK + ': you are the lead.', messages: (o && o.messages) || [{ role: 'user', content: 'Look at the workspace (' + scen + ')' }]
    })
  });
  A.eq(response.status, 200, scen + ': the real /api/run admitted the task');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch (_) {}
    }
  }
  const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
  const mains = model.mains.slice(from).filter(m => m.scen === scen);
  return { mains, events, end, bytes: mains.reduce((n, m) => n + Buffer.byteLength(m.raw, 'utf8'), 0) };
}

/* One request with everything that differs between two stations on one machine taken out: the temp workspace and profile
   folders, the two loopback ports, and the per-run <run_context> note (run id, clock). What is left is every byte the
   station composes for the model. */
function normalizer(fixture, model) {
  const swaps = [];
  const add = (from, to) => { if (from && swaps.every(s => s[0] !== from)) swaps.push([from, to]); };
  for (const [dir, tag] of [[fixture.workspace, '<WORKSPACE>'], [fixture.profile, '<PROFILE>']]) {
    for (const d of [dir, (() => { try { return fs.realpathSync(dir); } catch (_) { return dir; } })()]) {
      add(d, tag); add(d.replace(/\\/g, '/'), tag); add(d.replace(/\\/g, '\\\\'), tag);
      add(d.toLowerCase(), tag); add(d.replace(/\\/g, '/').toLowerCase(), tag);
    }
  }
  swaps.sort((a, b) => b[0].length - a[0].length);
  return s => {
    let out = String(s);
    for (const [from, to] of swaps) out = out.split(from).join(to);
    return out.split(':' + fixture.port).join(':<STATION>').split(':' + model.port).join(':<MODEL>');
  };
}
function normalBody(body, norm) {
  const messages = (body.messages || []).map(m => {
    const c = text(m.content);
    return { role: m.role, content: norm(m.role === 'user' ? c.replace(/<run_context>[\s\S]*?<\/run_context>\s*/g, '<run_context/>') : c), tool_calls: m.tool_calls || undefined, tool_call_id: m.tool_call_id || undefined };
  });
  const rest = Object.assign({}, body); delete rest.messages; delete rest.tools;
  return { system: norm(leadingSystem(body)), tools: norm(JSON.stringify(body.tools || [])), messages: norm(JSON.stringify(messages.slice(1))), rest: norm(JSON.stringify(rest)) };
}

async function arm(name, extraEnv, each) {
  const model = await startModel();
  const fixture = SidecarFixture.create({ prefix: 'sk-batch-hint-' + name + '-', timeoutMs: 60000, env: hermeticEnv(extraEnv) });
  const t0 = Date.now();
  try {
    await fixture.start();
    const booted = Date.now();
    const plain = await drive(fixture, model, 'SCEN_PLAIN');
    if (process.env.BATCH_HINT_TIMING) console.log('[batch-hint.e2e] ' + name + ': boot ' + (booted - t0) + ' ms, first run ' + (Date.now() - booted) + ' ms');
    A.eq(plain.end.reason, 'done', name + ': the plain task run finishes');
    A.eq(plain.mains.length, 1, name + ': the plain task run is one request');
    const norm = normalizer(fixture, model);
    const out = { name, plain: plain.mains[0] ? normalBody(plain.mains[0].body, norm) : null, raw: plain.mains[0] ? plain.mains[0].raw : '' };
    if (each) await each(fixture, model, out, norm);
    return out;
  } finally {
    await fixture.dispose();
    model.server.close();
  }
}

(async () => {
  // ---- OFF: the switch unset. This is the request the base sends (BATCH_HINT_DUMP writes it for the base-vs-lane diff). ----
  const off = await arm('off', null);
  A.ok(!!off.plain && off.plain.system.indexOf(DOCTRINE_END) > 0, 'off: the task doctrine is on the wire');
  if (off.plain) {
    A.eq(count(off.plain.system, 'request them together in one reply'), 0, 'off: no batching sentence');
    A.eq(count(off.plain.system, DOCTRINE_END), 1, 'off: the doctrine\'s last sentence appears once');
    console.log('[batch-hint.e2e] OFF  system ' + Buffer.byteLength(off.plain.system, 'utf8') + ' B sha256 ' + sha(off.plain.system).slice(0, 16)
      + ' | tools ' + Buffer.byteLength(off.plain.tools, 'utf8') + ' B sha256 ' + sha(off.plain.tools).slice(0, 16));
    if (process.env.BATCH_HINT_DUMP) fs.writeFileSync(process.env.BATCH_HINT_DUMP, JSON.stringify(off.plain, null, 1));
  }

  // ---- ZERO: STARNET_BATCH_HINT=0 is OFF, byte for byte. ----
  const zero = await arm('zero', { STARNET_BATCH_HINT: '0' });
  if (off.plain && zero.plain) {
    A.ok(zero.plain.system === off.plain.system, 'zero: STARNET_BATCH_HINT=0 sends the same system text as the switch unset, byte for byte');
    A.ok(zero.plain.tools === off.plain.tools, 'zero: the same tool array');
    A.ok(zero.plain.messages === off.plain.messages && zero.plain.rest === off.plain.rest, 'zero: the same messages and request fields');
  }

  // ---- ON: exactly the sentence, at one place, and nothing else. ----
  let serial = null, batched = null, settle = null, second = null;
  const on = await arm('on', { STARNET_BATCH_HINT: '1' }, async (fixture, model, out, norm) => {
    // the second message of the same conversation, and every request of a multi-request run: the same system bytes
    const m2 = [{ role: 'user', content: 'Look at the workspace (SCEN_PLAIN)' }, { role: 'assistant', content: 'Done: SCEN_PLAIN complete.' }, { role: 'user', content: 'Look again (SCEN_PLAIN)' }];
    second = await drive(fixture, model, 'SCEN_PLAIN', { messages: m2 });
    const seed = await drive(fixture, model, 'SCEN_SEED');
    A.eq(seed.end.reason, 'done', 'seed: the note the reads open is written');
    serial = await drive(fixture, model, 'SCEN_SERIAL');
    batched = await drive(fixture, model, 'SCEN_BATCHED');
    settle = await drive(fixture, model, 'SCEN_SETTLE', { streamId: 'batch-hint-settle', messages: [{ role: 'user', content: 'Read batch-a.txt and save a summary to batch-summary.txt (SCEN_SETTLE)' }] });
    settle.written = fs.existsSync(path.join(fixture.workspace, 'batch-summary.txt')) || findFile(fixture.workspace, 'batch-summary.txt', 4);
    out.norm = norm;
  });
  if (off.plain && on.plain) {
    const at = off.plain.system.indexOf(DOCTRINE_END) + DOCTRINE_END.length;
    const expected = off.plain.system.slice(0, at) + WITH_TODO + off.plain.system.slice(at);
    A.ok(on.plain.system === expected, 'on: the system text is OFF\'s with exactly the sentence added right after the doctrine\'s last sentence'
      + (on.plain.system === expected ? '' : ' (on ' + on.plain.system.length + ' chars, expected ' + expected.length + '; sentence present ' + count(on.plain.system, WITH_TODO) + 'x)'));
    A.eq(count(on.plain.system, WITH_TODO), 1, 'on: the sentence appears once');
    A.ok(on.plain.system.split(WITH_TODO).join('') === off.plain.system, 'on: take the sentence out and the system text is OFF\'s, byte for byte');
    A.ok(on.plain.tools === off.plain.tools, 'on: the tool array is unchanged (no description moved)');
    A.ok(on.plain.messages === off.plain.messages && on.plain.rest === off.plain.rest, 'on: the messages and every other request field are unchanged');
    const cost = Buffer.byteLength(on.plain.system, 'utf8') - Buffer.byteLength(off.plain.system, 'utf8');
    A.eq(cost, Buffer.byteLength(WITH_TODO, 'utf8'), 'on: the request grows by the sentence\'s own bytes');
    A.eq(cost, 271, 'on: 271 bytes, in the cached prefix');
    console.log('[batch-hint.e2e] ON   system ' + Buffer.byteLength(on.plain.system, 'utf8') + ' B (+' + cost + ' B = the sentence) | tools unchanged | request '
      + Buffer.byteLength(off.raw, 'utf8') + ' -> ' + Buffer.byteLength(on.raw, 'utf8') + ' B');
  }
  if (on.plain && second && serial && batched && settle) {
    // static: the same bytes on a later message and on every request of a run
    A.ok(second.mains.length === 1 && on.norm(leadingSystem(second.mains[0].body)) === on.plain.system, 'on: the second message of the conversation carries the same system bytes');
    A.ok(serial.mains.length > 1 && serial.mains.every(m => on.norm(leadingSystem(m.body)) === on.plain.system), 'on: every request of a multi-request run carries the same system bytes');

    // the tools the sentence speaks of are on this run's wire (the todo clause rides because todo does; a run without the
    // todo tool gets the sentence without that clause: test/batch-hint.test.js, the module and the one site that asks it)
    const plainTools = JSON.parse(on.plain.tools).map(t => t.function.name);
    A.ok(plainTools.indexOf('todo') >= 0 && plainTools.indexOf('fs_read') >= 0 && plainTools.indexOf('fs_list') >= 0 && plainTools.indexOf('fs_search') >= 0,
      'starter floor: todo and the file reads the sentence speaks of are on the wire');
    A.eq(count(on.plain.system, NO_TODO), 0, 'starter floor: the variant without the todo clause is not what this run got');

    // WHAT A COMPLYING MODEL SAVES (scripted): three independent reads, one per reply vs together
    A.eq([serial.end.reason, batched.end.reason], ['done', 'done'], 'mechanism: both runs finish');
    A.eq(serial.mains.length, 4, 'mechanism: three calls sent one per reply cost 4 requests');
    A.eq(batched.mains.length, 2, 'mechanism: the same three calls in one reply cost 2 requests');
    const results = b => (b.mains[b.mains.length - 1].body.messages || []).filter(m => m.role === 'tool').map(m => text(m.content));
    A.eq(results(batched).length, 3, 'mechanism: the batched reply got all three results back');
    A.ok(results(batched).every(r => !/^ERROR/.test(r)) && results(serial).every(r => !/^ERROR/.test(r)), 'mechanism: every call ran in both runs');
    A.eq(results(batched).slice().sort(), results(serial).slice().sort(), 'mechanism: the batched run read exactly what the serial run read');
    A.ok(batched.bytes < serial.bytes, 'mechanism: the batched run sent fewer request bytes');
    console.log('[batch-hint.e2e] mechanism (scripted model, 3 independent reads): one per reply ' + serial.mains.length + ' requests / ' + serial.bytes
      + ' B sent; together ' + batched.mains.length + ' requests / ' + batched.bytes + ' B sent (' + (100 * (1 - batched.bytes / serial.bytes)).toFixed(1) + '% fewer bytes)');

    // W1.2 holds under the sentence: a todo update, a read, the settle and the first write in ONE reply
    const held = settle.events.filter(e => e.name === 'agent.tool_result' && e.payload && e.payload.summary === HELD).length;
    A.eq(settle.end.reason, 'done', 'settle: the run finishes');
    A.eq(settle.mains.length, 2, 'settle: [todo, fs_read, brief_proceed, fs_write] in one reply costs 2 requests');
    A.eq(held, 0, 'settle: nothing was held for the brief (the settle ran first, W1.2)');
    A.eq(settle.events.filter(e => e.name === 'taskbrief.settled').length, 1, 'settle: exactly one read card');
    A.ok(!!settle.written, 'settle: the write ran in that same reply');
    const settleResults = results(settle);
    A.ok(settleResults.length === 4 && settleResults.every(r => !/^ERROR/.test(r)), 'settle: all four calls answered without an error: ' + JSON.stringify(settleResults.map(r => r.slice(0, 40))));
  } else {
    A.ok(false, 'on: the follow-up runs were recorded');
  }
  A.report('batch-hint.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });

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
