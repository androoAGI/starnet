'use strict';
/* test/helpers/forget-quotes.js — the rig the forget.tool-quotes http tests share (turn identity commit 11).

   One REAL sidecar (SidecarFixture) and a scripted model behind a local OpenRouter-shaped endpoint; nothing else is faked. The scripted model
   answers each tool-bearing call from `up.behave(ctx)`, which sees the whole request (the messages, the tools offered, the tool calls this turn
   has made so far) and returns { tool, args } | { text } | { hold, then } for it. The Task Brief gate that every task run opens with is
   answered here, so a script only describes the work. Calls with no tools (the station's own aux calls) get a canned NONE.

   `up.bodies` records every request the model received with the time it arrived: "no upstream body after the delete holds the word" is a
   scan of it. A held call is a call the script chose to leave open (`hold`), released by the test; closing the connection from the sidecar's
   side (a STOP) is how the test sees a run was aborted. */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./sidecar-fixture.js');
const { makeSegmentedTranscriptIo } = require('../../sidecar/transcript-history.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = c => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : (c == null ? '' : String(c))));
async function until(fn, label, ms) {
  const deadline = Date.now() + (ms || 20000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) throw new Error('timeout: ' + label); await sleep(25); }
}
const gate = () => {
  let open; const released = new Promise(r => { open = r; }); let enter; let isEntered = false; const entered = new Promise(r => { enter = r; });
  // wait(ms): resolves when the held call is reached, rejects (the test fails, it does not hang) when it never is
  return { released, release: () => open(), entered, enter: () => { isEntered = true; enter(); }, get isEntered() { return isEntered; },
    wait: (ms, what) => Promise.race([entered, sleep(ms || 45000).then(() => { throw new Error('never reached: ' + (what || 'the held call')); })]) };
};

function startUpstream() {
  const up = { bodies: [], behave: null, held: [] };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'tool_choice'] }] }));
      }
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      const messages = body.messages || [], tools = (body.tools || []).map(t => t.function && t.function.name).filter(Boolean);
      const main = tools.length > 0;
      const entry = { body, at: Date.now(), main, text: raw, closed: false };
      up.bodies.push(entry);
      res.on('close', () => { entry.closed = true; });   // the RESPONSE closing is the sidecar hanging up (a request's own 'close' fires once its body is read)
      const sse = (delta, finish) => { if (res.writableEnded || res.destroyed) return; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n'); };
      if (!main) return sse({ content: 'NONE' }, 'stop');
      const lastUserAt = messages.map(m => m.role).lastIndexOf('user');
      const turn = messages.slice(lastUserAt + 1);
      const made = name => turn.filter(m => (m.tool_calls || []).some(t => t.function && t.function.name === name)).length;
      const toolResults = turn.filter(m => m.role === 'tool').map(m => textOf(m.content));
      const ctx = { body, messages, tools, turn, made, toolResults, userText: messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n'), lastUser: textOf((messages[lastUserAt] || {}).content), system: textOf((messages[0] || {}).content), index: up.bodies.length - 1, entry };
      let act;
      if (tools.includes('brief_proceed') && !made('brief_proceed')) act = { tool: 'brief_proceed', args: { objective: 'Answer the Commander' } };
      else act = (typeof up.behave === 'function' && up.behave(ctx)) || { text: 'done.' };
      const send = a => {
        if (a.tool) sse({ tool_calls: [{ index: 0, id: 'c_' + up.bodies.length + '_' + Math.random().toString(36).slice(2, 7), type: 'function', function: { name: a.tool, arguments: JSON.stringify(a.args || {}) } }] }, 'tool_calls');
        else sse({ content: a.text == null ? 'done.' : a.text }, 'stop');
      };
      if (act.hold) {
        // the call is left open: the script's gate is entered, the test releases it (or the sidecar closes the connection first)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: act.partial || '' } }] }) + '\n\n');   // `partial`: words the model has already said when the call is left open
        up.held.push(entry);
        if (process.env.FQ_TRACE) console.log('[hold] ' + new Date().toISOString().slice(17, 23) + ' entered at request ' + (up.bodies.length - 1) + ': ' + JSON.stringify(ctx.userText.slice(-50)));
        act.hold.enter();
        act.hold.released.then(() => { if (!entry.closed && !res.destroyed && !res.writableEnded) { const a = act.then || { text: 'released.' }; if (a.tool) res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c_h' + up.bodies.length, type: 'function', function: { name: a.tool, arguments: JSON.stringify(a.args || {}) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n'); else res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: a.text }, finish_reason: 'stop' }] }) + '\n\n'); res.end('data: [DONE]\n\n'); } });
        return;
      }
      send(act);
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => {
    up.server = server; up.base = 'http://' + HOST + ':' + server.address().port + '/api/v1';
    up.close = () => { try { server.closeAllConnections(); } catch (_) {} return new Promise(r => server.close(() => r())); };
    resolve(up);
  }));
}

// a quiet, hermetic station on the scripted model (aux calls on their own, no schedulers, no learning passes)
function stationEnv(base, extra) {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_AUX_BUDGET: '0', SKYNET_REFLECT: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0', SKYNET_SCOUT: '0', SKYNET_QUEST_REFRESH_MS: '0', SKYNET_EDGE_TTS: '0',
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-fixture', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model' }, extra || {});
}

async function station(prefix, options) {
  const o = options || {};
  const up = await startUpstream();
  const fx = SidecarFixture.create({ prefix: prefix || 'forget-quotes-', timeoutMs: 40000, env: stationEnv(up.base, o.env) });
  const rig = { up, fx };
  rig.pushRoster = async () => { if (o.crew) await rig.json('POST', '/api/roster', { agents: o.crew }); };   // the page pushes its crew on every connect; a restarted station has none until it does
  rig.start = async () => { await fx.start(); await rig.json('POST', '/api/memory/config', { reflectEnabled: false }); await rig.pushRoster(); return rig; };
  rig.stop = () => fx.stop();
  rig.crash = () => fx.crash();
  rig.resume = async () => { await fx.start(); await rig.pushRoster(); };
  rig.restart = async () => { await fx.restart(); await rig.pushRoster(); };
  rig.json = (method, route, body) => fx.json(method, route, body);
  rig.dispose = async () => { try { await fx.dispose(); } finally { await up.close(); } };
  // a station page over the real SSE feed: it acks every station.deliver the host asks (a routine's return into a session). -> { commands, close }
  rig.page = async () => {
    const { sseQuery } = require('../_httpToken.js');
    const ac = new AbortController(), commands = [];
    const res = await fetch(fx.baseUrl + '/api/channels/events?' + sseQuery(fx.token), { signal: ac.signal });
    const reader = res.body.getReader(), dec = new TextDecoder();
    (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (ev.name === 'station.command' && ev.payload && ev.payload.verb === 'station.deliver') { commands.push(ev.payload.args); await rig.json('POST', '/api/station/ack', { id: ev.payload.id, ok: true, result: { folded: true } }); }
          }
        }
      } catch (_) { /* closed */ }
    })();
    return { commands, close() { try { ac.abort(); } catch (_) {} } };
  };
  // a scheduled routine of the agent that returns its reply to session `sid`; resolves with the job once the delivery is recorded done
  rig.routine = async (name, prompt, sid) => {
    const made = await rig.json('POST', '/api/cron', { name, prompt, schedule: 'in 1s', agentId: 'agent', model: 'test/model', provider: 'openrouter', deliver: 'origin', origin: { sessionId: sid, streamId: sid, sessionTitle: name } });
    if (made.status !== 200) throw new Error('the routine was not created: ' + made.text.slice(0, 200));
    await rig.json('POST', '/api/cron/arm', { enabled: true });
    let job = null;
    for (let i = 0; i < 100; i++) { job = ((await rig.json('GET', '/api/cron')).body.jobs || []).find(j => j.id === made.body.job.id); if (job && job.lastDeliveryOk === true) break; await sleep(300); }
    await rig.json('POST', '/api/cron/arm', { enabled: false });
    if (!job || job.lastDeliveryOk !== true) throw new Error('the routine\'s delivery was not recorded done: ' + JSON.stringify({ ok: job && job.lastDeliveryOk, err: job && job.lastDeliveryError }));
    return job;
  };
  rig.sessions = [];   // the workstreams the page would still list (id, title)
  rig.revision = 0;    // the save revision the page last heard (a stale one is a conflict, and a conflict deletes nothing)
  // the page's save: the workstreams it still lists, the ids it deleted and (the Commander's Delete) the ids to forget
  rig.save = async (deleted, forget) => {
    const r = await rig.json('POST', '/api/save', { agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, updatedAt: Date.now(), _saveRevision: rig.revision,
      workstreams: rig.sessions.filter(w => !(deleted || []).includes(w.id)).map(w => ({ id: w.id, title: w.title, agentId: 'agent', history: [] })), deletedIds: deleted || [], forgetIds: forget || deleted || [] });
    if (r.body && r.body.ok === true && r.body.revision) rig.revision = r.body.revision;
    return r;
  };
  rig.list = (...sessions) => { rig.sessions = sessions.map(([id, title]) => ({ id, title })); return rig.save([], []); };
  rig.forget = async (...ids) => {
    const t0 = Date.now(); const r = await rig.save(ids, ids); rig.sessions = rig.sessions.filter(w => !ids.includes(w.id));
    if (!(r.body && r.body.ok === true)) throw new Error('the page\'s delete was not accepted: ' + JSON.stringify(r.body).slice(0, 200));
    return Object.assign(r, { at: Date.now(), t0 });
  };
  // POST /api/run, read to its end (or until `stopAfter` resolves); returns the events, the run id and the lead's end
  rig.run = async (streamId, words, extra, readOptions) => {
    const body = Object.assign({ provider: 'openrouter', model: 'test/model', agentId: 'agent', isTask: true, streamId, surface: 'interactive', system: 'You are NOVA.', messages: [{ role: 'user', content: words }] }, extra || {});
    const r = await fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = { status: r.status, events: [], runId: '', end: null, raw: '' };
    const reader = r.body.getReader(), decoder = new TextDecoder();
    const feed = () => { const lines = out.raw.split('\n'); out.events = lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); const start = out.events.find(e => e.name === 'agent.run.start' && e.payload && !e.payload.parentRunId); out.runId = start ? start.payload.runId : ''; const end = out.events.filter(e => e.name === 'agent.run.end' && e.payload && (!out.runId || e.payload.runId === out.runId)).pop(); out.end = end ? end.payload : null; };
    out.done = (async () => { try { for (;;) { const part = await reader.read(); if (part.done) break; out.raw += decoder.decode(part.value, { stream: true }); feed(); } } catch (_) {} feed(); return out; })();
    if (!(readOptions && readOptions.detach)) await out.done;
    return out;
  };
  rig.transcript = async (streamId, extra) => (await rig.json('GET', '/api/transcript?stream=' + encodeURIComponent(streamId) + '&limit=2000' + (extra || ''))).body;
  rig.runs = async () => { const r = (await rig.json('GET', '/api/runs?limit=200')).body; return Array.isArray(r) ? r : (r.runs || r.rows || []); };
  rig.mode = (surface, mode) => rig.json('POST', '/api/turn-identity/mode', { surface, mode });
  // every request the model has received since `since` (a time), as one text per request
  rig.bodiesSince = since => up.bodies.filter(b => b.at >= since).map(b => b.text);
  rig.mentionedSince = (since, word) => up.bodies.filter(b => b.at >= since && b.text.includes(word));
  // where the first hit sits (for a failure message): "request 3, message 5 (tool): ...the words around it..."
  rig.whereSince = (since, word) => {
    for (const [n, b] of up.bodies.entries()) {
      if (b.at < since) continue;
      const msgs = b.body.messages || [];
      for (let i = 0; i < msgs.length; i++) { const t = textOf(msgs[i].content) + JSON.stringify(msgs[i].tool_calls || ''); const at = t.indexOf(word); if (at >= 0) return 'request ' + n + ', message ' + i + ' (' + msgs[i].role + '): ' + JSON.stringify(t.slice(Math.max(0, at - 220), at + 60)) + ' | the request: ' + msgs.map((m, j) => j + ':' + m.role + ':' + textOf(m.content).replace(/\s+/g, ' ').slice(0, 28)).join(' / '); }
      if (b.text.includes(word)) return 'request ' + n + ' (outside the messages)';
    }
    return 'nowhere';
  };
  rig.journals = () => { const dir = path.join(fx.workspace, '.run-journal'); try { return fs.readdirSync(dir).filter(n => !n.includes('.corrupt')).map(n => ({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf8') })); } catch (_) { return []; } };
  return rig;
}

// rows written straight into the station's durable transcript while it is stopped: a fixture of sessions that already exist (45 of them, for the overflow)
async function seedRows(rig, rows) {
  await rig.fx.stop();
  const root = path.join(rig.fx.workspace, 'transcript-history-v2');
  const quick = Object.create(fs); quick.fsyncSync = () => {};
  const io = makeSegmentedTranscriptIo({ fs: quick, path, root });
  try { for (const row of rows) io.appendDurable(row); } finally { io.close(); }
  await rig.resume();
}
// a one-user-turn session of `word` as durable rows (the Commander typed it; the agent answered)
function sessionRows(streamId, word, at) {
  const turn = 'seed_' + streamId.replace(/[^A-Za-z0-9]/g, '').slice(-24) + '_01';
  return [
    { streamId, agentId: 'agent', role: 'user', content: 'tell me about ' + word, ts: at, turnId: turn, kind: 'turn', directive: true, taint: null, taintKnown: true },
    { streamId, agentId: 'agent', role: 'assistant', content: 'Here is what I know about ' + word + ' for session ' + streamId + '.', ts: at + 1, turnId: turn, kind: 'turn', taint: null, taintKnown: true }
  ];
}
// does any file under `dir` (recursively) hold `word`? Returns the relative names that do.
function filesHolding(dir, word, skip) {
  const hits = [];
  const walk = d => { let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const n of names) { const p = path.join(d, n.name); if (skip && skip(p)) continue; if (n.isDirectory()) walk(p); else { try { if (fs.readFileSync(p, 'utf8').includes(word)) hits.push(path.relative(dir, p)); } catch (_) {} } } };
  walk(dir);
  return hits;
}
const rowsText = rows => (rows || []).map(r => String(r.content || r.text || '')).join('\n');

module.exports = { station, startUpstream, stationEnv, seedRows, sessionRows, filesHolding, rowsText, gate, until, sleep, textOf, HOST, os };
