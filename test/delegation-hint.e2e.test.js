/* node test/delegation-hint.e2e.test.js — WHAT A WORKER COSTS (cost audit W2.9, 2026-11-14), on the wire.

   THE COST: a worker a lead dispatches or spawns is a whole run of its own (3.2x to 4.4x the request bytes of the same turn
   done alone, on the audit's rig). The team note tells every run that holds team.dispatch to DELEGATE; only the Overseer's
   variant adds "Handle simple work directly", and a crew agent the Commander chats with directly (a lead too) gets no
   counterweight at all. Neither variant says a worker is paid for.

   THE CHANGE UNDER TEST: one bullet in the team note, the same bytes in both variants, behind STARNET_DELEGATION_HINT, off
   by default (sidecar/delegation-hint.js; the pure half is test/delegation-hint.test.js).

   Drives the REAL sidecar (/api/run, the real prompt assembly, the real team.dispatch) against a recording
   OpenAI-compatible model on loopback. No inference, no keys. Three stations, one after the other, the same requests:
     OFF   the switch unset                  the requests the base sends
     ZERO  STARNET_DELEGATION_HINT=0         the same bytes as OFF: system text, tool array, every message
     ON    STARNET_DELEGATION_HINT=1         OFF's bytes plus exactly the line, where a run holds team.dispatch with crew
   Four runs on each: a lead with NO crew (the crewless note), the Overseer with a crew of one (the coordinator variant), that
   crew agent chatted with directly (the other variant: it leads its own chat), and a worker the Overseer dispatches.
   With the switch on:
     - the Overseer's and the crew agent's system text is OFF's with the line added once, right after the SPAWN bullet and
       before SUMMON: the same bytes in both, and nothing else in either request changed;
     - the crewless lead and the dispatched worker are sent OFF's bytes (no crew to dispatch to; a worker cannot delegate);
     - a foreground dispatch still runs: the line is a hint, nothing is withheld or refused.

   RED on the base (agent/cand-0152 57c741da7): nothing reads the switch, so the ON station sends the OFF bytes.
   DELEGATION_HINT_DUMP=<file> writes the OFF station's four normalized requests: run on the base and on the lane, the two
   files are byte-identical (the base-vs-lane evidence). */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';
const LEAD_MARK = 'DELEG_HINT_OVERSEER';
const CREW_MARK = 'DELEG_HINT_CREW_CHAT';
const WORKER_MARK = 'DELEG_HINT_ROSTER_ADA';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const LINE = '\n• WHAT A WORKER COSTS: each worker you dispatch or spawn is a separate full run billed on top of yours, so do a simple or single-step part of your own job yourself. '
  + 'Still delegate whenever the Commander, your standing orders or your bay\'s brief ask for it, and for parallel, long-running or specialist work; a line\'s other bays keep their own part.';
const SPAWN_END = 'instead of restarting it.';       // the SPAWN bullet's last words
const SUMMON = '\n• SUMMON a NEW specialist with team.summon';
const COORDINATOR = 'Coordinate the Commander\'s existing station crew from this conversation. Handle simple work directly. ';

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '');
const leadingSystem = body => { const m = (body.messages || [])[0]; return m && m.role === 'system' ? text(m.content) : ''; };
const toolNames = body => (body.tools || []).map(t => t.function.name);
const sha = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const count = (hay, needle) => String(hay).split(needle).length - 1;

function startModel() {
  const seen = [];   // every request that carries tools: { kind: 'lead' | 'crew' | 'worker', scen, raw, body }
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (req.method === 'GET' || !raw) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 200000 }] }));
    }
    let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const sys = leadingSystem(body);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const kind = !tools.length ? '' : sys.indexOf(LEAD_MARK) >= 0 ? 'lead' : sys.indexOf(CREW_MARK) >= 0 ? 'crew' : sys.indexOf(WORKER_MARK) >= 0 ? 'worker' : '';
    let scen = '', dirIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const mm = userWords(msgs[i]).match(/\b(SCEN_[A-Z]+)\b/);
      if (mm) { dirIdx = i; scen = mm[1]; break; }
    }
    let call = null;
    if (kind && scen) {
      seen.push({ kind, scen, raw, body });
      const answered = msgs.slice(dirIdx + 1).some(m => m.role === 'tool');
      if (kind === 'lead' && scen === 'SCEN_DISPATCH' && !answered) call = { name: 'team_dispatch', args: { workers: [{ agentId: 'researcher', prompt: 'Say the word done. (SCEN_WORKER)' }] } };
    }
    const promptTok = Math.ceil(raw.length / 4);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (call) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_dispatch_' + seen.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: promptTok, completion_tokens: 30, total_tokens: promptTok + 30 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: kind ? 'Done: ' + scen + ' complete.' : 'NONE' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTok, completion_tokens: 8, total_tokens: promptTok + 8 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, seen, port: server.address().port, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

function hermeticEnv(extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  // the switch under test is ABSENT unless an arm sets it (a blank STARNET_ value is a value: ENV() would read it)
  delete env.STARNET_DELEGATION_HINT; delete env.SKYNET_DELEGATION_HINT;
  return Object.assign(env, {
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.2-delegation-hint',
    SKYNET_CONSENT_TIMEOUT_MS: '8000', STARNET_CONSENT_TIMEOUT_MS: '8000'
  }, extra || {});
}

// One /api/run as the station page sends it. No streamId: no Task Brief gate in front of team.dispatch.
async function drive(fixture, model, o) {
  const from = model.seen.length;
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'custom', baseUrl: model.base, key: 'fixture-key', model: 'fixture-model', agentId: o.agentId, isTask: true,
      placed: FLOOR, stationPlaced: FLOOR, system: o.system, messages: o.messages || [{ role: 'user', content: 'Tell me what is on the station. (' + o.scen + ')' }]
    })
  });
  A.eq(response.status, 200, o.label + ': the real /api/run admitted the task');
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
      if (ev.name === 'agent.run.start' && !runId) runId = ev.payload.runId;
      if (ev.name === 'permission.prompt') await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: 'once' });
    }
  }
  const ends = events.filter(e => e.name === 'agent.run.end').map(e => e.payload || {});
  return { seen: model.seen.slice(from), events, ends, end: ends.filter(p => p.agentId === o.agentId).pop() || ends.pop() || {} };
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
const same = (a, b) => !!a && !!b && a.system === b.system && a.tools === b.tools && a.messages === b.messages && a.rest === b.rest;

async function arm(name, extraEnv) {
  const model = await startModel();
  const fixture = SidecarFixture.create({ prefix: 'sk-deleg-hint-' + name + '-', timeoutMs: 60000, env: hermeticEnv(extraEnv) });
  const out = { name };
  const t0 = Date.now();
  try {
    await fixture.start();
    const norm = normalizer(fixture, model);
    const first = (run, kind, scen) => { const hit = run.seen.find(s => s.kind === kind && s.scen === scen); return hit ? Object.assign(normalBody(hit.body, norm), { names: toolNames(hit.body), bytes: Buffer.byteLength(hit.raw, 'utf8') }) : null; };

    // 1. a lead with no crew: the crewless note
    const crewless = await drive(fixture, model, { label: name + ' crewless', agentId: 'agent', system: LEAD_MARK + ': you are the Overseer.', scen: 'SCEN_PLAIN' });
    A.eq(crewless.end.reason, 'done', name + ': the crewless run finishes');
    out.crewless = first(crewless, 'lead', 'SCEN_PLAIN');

    // a crew of one
    const roster = await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
      { agentId: 'agent', name: 'NOVA', provider: 'custom', model: 'fixture-model' },
      { agentId: 'researcher', name: 'Ada', role: 'researcher', provider: 'custom', model: 'fixture-model', system: WORKER_MARK + ': you research for the station.' }] });
    A.eq(roster.status, 200, name + ': the crew roster is saved');

    // 2. the Overseer with crew: the coordinator variant
    const lead = await drive(fixture, model, { label: name + ' overseer', agentId: 'agent', system: LEAD_MARK + ': you are the Overseer.', scen: 'SCEN_PLAIN' });
    A.eq(lead.end.reason, 'done', name + ': the Overseer\'s run finishes');
    out.lead = first(lead, 'lead', 'SCEN_PLAIN');

    // 3. the crew agent chatted with directly: it leads its own chat (the other variant of the note)
    const crew = await drive(fixture, model, { label: name + ' crew chat', agentId: 'researcher', system: CREW_MARK + ': you research for the station.', scen: 'SCEN_PLAIN' });
    A.eq(crew.end.reason, 'done', name + ': the crew agent\'s own chat finishes');
    out.crew = first(crew, 'crew', 'SCEN_PLAIN');

    // 4. the Overseer dispatches that crew agent (foreground): the worker's own request
    const dispatch = await drive(fixture, model, { label: name + ' dispatch', agentId: 'agent', system: LEAD_MARK + ': you are the Overseer.', scen: 'SCEN_DISPATCH' });
    out.dispatchEnd = dispatch.end.reason;
    out.workerEnd = (dispatch.ends.find(p => p.agentId === 'researcher') || {}).reason || '';
    out.leadRequests = dispatch.seen.filter(s => s.kind === 'lead').length;
    out.dispatchRequests = dispatch.seen.length;
    out.dispatchBytes = dispatch.seen.reduce((n, s) => n + Buffer.byteLength(s.raw, 'utf8'), 0);
    out.worker = first(dispatch, 'worker', 'SCEN_WORKER');
    out.dispatchResult = (() => {
      const last = dispatch.seen.filter(s => s.kind === 'lead').pop();
      const tool = last ? (last.body.messages || []).filter(m => m.role === 'tool').map(m => text(m.content)).pop() : '';
      return String(tool || '');
    })();
    if (process.env.DELEGATION_HINT_TIMING) console.log('[delegation-hint.e2e] ' + name + ': ' + (Date.now() - t0) + ' ms');
    return out;
  } finally {
    await fixture.dispose();
    model.server.close();
  }
}

(async () => {
  const KINDS = ['crewless', 'lead', 'crew', 'worker'];
  // ---- OFF: the switch unset. These are the requests the base sends. ----
  const off = await arm('off', null);
  for (const k of KINDS) A.ok(!!off[k], 'off: the ' + k + ' request was recorded');
  if (KINDS.every(k => off[k])) {
    A.ok(off.crewless.system.indexOf('You have no crew yet') > 0 && off.crewless.system.indexOf('YOUR TEAM') < 0, 'off: a lead with no crew gets the crewless note');
    A.ok(off.lead.system.indexOf(COORDINATOR) > 0 && off.lead.system.indexOf('• YOUR TEAM — DELEGATE') > 0 && off.lead.names.indexOf('team_dispatch') >= 0,
      'off: the Overseer with crew gets the coordinator variant ("Handle simple work directly") and the DELEGATE bullet');
    A.ok(off.crew.system.indexOf('[ORCHESTRATION] You are the lead orchestrator.') > 0 && off.crew.system.indexOf('• YOUR TEAM — DELEGATE') > 0 && off.crew.names.indexOf('team_dispatch') >= 0,
      'off: a crew agent chatted with directly is a lead too: it gets the DELEGATE bullet and team_dispatch');
    A.ok(off.crew.system.indexOf('Handle simple work directly') < 0 && off.crew.system.indexOf('Coordinate the Commander') < 0,
      'off: ...with no counterweight at all (the case the audit found)');
    A.ok(off.worker.system.indexOf('[ORCHESTRATION]') < 0 && off.worker.names.indexOf('team_dispatch') < 0 && off.worker.names.indexOf('team_spawn') < 0,
      'off: a dispatched worker gets no team note and cannot delegate');
    for (const k of KINDS) A.eq(count(off[k].system, 'WHAT A WORKER COSTS'), 0, 'off: no line in the ' + k + ' request');
    A.eq([off.dispatchEnd, off.workerEnd, off.leadRequests], ['done', 'done', 2], 'off: the dispatch runs (the worker finishes, the Overseer answers on its second request)');
    // WHAT ONE WORKER COSTS HERE (the fact the line states; scripted, a worker that answers in one request): the turn the
    // Overseer answers directly is one request, the same turn handed to a worker is the Overseer's two and the worker's one
    A.eq(off.dispatchRequests, 3, 'off: a foreground dispatch of one single-request worker is three model requests');
    A.ok(off.dispatchBytes > 2 * off.lead.bytes, 'off: ...and more than twice the request bytes of the turn answered directly');
    console.log('[delegation-hint.e2e] one foreground dispatch on this station: ' + off.dispatchRequests + ' requests / ' + off.dispatchBytes + ' B sent, against 1 request / '
      + off.lead.bytes + ' B for the turn answered directly (' + (off.dispatchBytes / off.lead.bytes).toFixed(2) + 'x)');
    for (const k of KINDS) console.log('[delegation-hint.e2e] OFF  ' + (k + '        ').slice(0, 8) + ' system ' + Buffer.byteLength(off[k].system, 'utf8') + ' B sha256 ' + sha(off[k].system).slice(0, 16)
      + ' | tools ' + off[k].names.length + ' / ' + Buffer.byteLength(off[k].tools, 'utf8') + ' B sha256 ' + sha(off[k].tools).slice(0, 16));
    if (process.env.DELEGATION_HINT_DUMP) {
      const dump = {}; for (const k of KINDS) dump[k] = { system: off[k].system, tools: off[k].tools, messages: off[k].messages, rest: off[k].rest };
      fs.writeFileSync(process.env.DELEGATION_HINT_DUMP, JSON.stringify(dump, null, 1));
    }
  }

  // ---- ZERO: STARNET_DELEGATION_HINT=0 is OFF, byte for byte. ----
  const zero = await arm('zero', { STARNET_DELEGATION_HINT: '0' });
  for (const k of KINDS) A.ok(same(zero[k], off[k]), 'zero: STARNET_DELEGATION_HINT=0 sends the ' + k + ' request the switch unset sends, byte for byte (system text, tools, messages, fields)');

  // ---- ON: exactly the line, in both variants, and nothing else. ----
  const on = await arm('on', { STARNET_DELEGATION_HINT: '1' });
  for (const k of KINDS) A.ok(!!on[k], 'on: the ' + k + ' request was recorded');
  if (KINDS.every(k => off[k] && on[k])) {
    for (const k of ['lead', 'crew']) {
      const who = k === 'lead' ? 'the Overseer' : 'the crew agent\'s own chat';
      const at = off[k].system.indexOf(SUMMON);
      A.ok(at > 0 && off[k].system.slice(at - SPAWN_END.length, at) === SPAWN_END, 'off: ' + who + ': the SPAWN bullet is followed by SUMMON');
      const expected = off[k].system.slice(0, at) + LINE + off[k].system.slice(at);
      A.ok(on[k].system === expected, 'on: ' + who + ': the system text is OFF\'s with exactly the line added after the SPAWN bullet, before SUMMON'
        + (on[k].system === expected ? '' : ' (on ' + on[k].system.length + ' chars, expected ' + expected.length + '; line present ' + count(on[k].system, LINE) + 'x)'));
      A.eq(count(on[k].system, LINE), 1, 'on: ' + who + ': the line appears once');
      A.ok(on[k].system.split(LINE).join('') === off[k].system, 'on: ' + who + ': take the line out and the system text is OFF\'s, byte for byte');
      A.ok(on[k].tools === off[k].tools, 'on: ' + who + ': the tool array is unchanged (team_dispatch and team_spawn are as granted and as described)');
      A.ok(on[k].messages === off[k].messages && on[k].rest === off[k].rest, 'on: ' + who + ': the messages and every other request field are unchanged');
      const cost = Buffer.byteLength(on[k].system, 'utf8') - Buffer.byteLength(off[k].system, 'utf8');
      A.eq(cost, Buffer.byteLength(LINE, 'utf8'), 'on: ' + who + ': the request grows by the line\'s own bytes');
      A.eq(cost, 351, 'on: ' + who + ': 351 bytes, in the cached prefix');
      console.log('[delegation-hint.e2e] ON   ' + (k + '        ').slice(0, 8) + ' system ' + Buffer.byteLength(on[k].system, 'utf8') + ' B (+' + cost + ' B = the line) | tools unchanged | request ' + off[k].bytes + ' -> ' + on[k].bytes + ' B');
    }
    // the Overseer keeps its own sentence; the crew agent's chat now has a counterweight where it had none
    A.ok(on.lead.system.indexOf(COORDINATOR) > 0, 'on: the Overseer keeps "Handle simple work directly"');
    A.ok(on.crew.system.indexOf('Handle simple work directly') < 0 && count(on.crew.system, 'do a simple or single-step part of your own job yourself') === 1,
      'on: the crew agent\'s own chat carries the counterweight it never had');
    // where there is no one to dispatch to, and where delegating is not possible, nothing is added
    A.ok(same(on.crewless, off.crewless), 'on: a lead with no crew is sent OFF\'s bytes (the crewless note does not carry the line)');
    A.ok(same(on.worker, off.worker), 'on: a dispatched worker is sent OFF\'s bytes (a worker cannot delegate: no team note, no line)');
    // a hint, not a gate: the dispatch still runs
    A.eq([on.dispatchEnd, on.workerEnd, on.leadRequests], ['done', 'done', 2], 'on: the dispatch still runs (the worker finishes, the Overseer answers on its second request)');
    // (the result names the worker's run, so it is compared by what it reports, not byte for byte)
    const reported = r => { try { return JSON.parse(r).map(w => [w.agentId, w.reason, w.result]); } catch (_) { return 'unreadable: ' + String(r).slice(0, 80); } };
    A.eq(reported(on.dispatchResult), [['researcher', 'done', 'Done: SCEN_WORKER complete.']], 'on: team_dispatch hands the worker\'s answer back to the Overseer');
    A.eq(reported(on.dispatchResult), reported(off.dispatchResult), 'on: ...the same answer it handed back with the switch off');
  }
  A.report('delegation-hint.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
