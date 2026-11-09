/* node test/cross-run-replay.invariant.test.js — W1.8 CROSS-RUN REPLAY: earlier runs' tool results ride a follow-up as a head and a
   handle, through ONE resolver, on every path that replays them.

   Red on 9896a5c44 (the cost stack), green on the lane. Hermetic: one real sidecar (SidecarFixture), a fake Telegram Bot API and a
   recording mock model upstream; no network, no paid call, a temp workspace.

   A run that resumes a conversation replays its earlier runs in the transcript's 'pairs' shape. Every earlier tool result used to
   ride whole on every later message: the terminal CLI's resume seed (one user message + a streamId), the queued re-seed (a turn that
   waited behind its stream's run) and channel history (a Telegram chat, uncapped, so a tool-heavy chat grew quadratically).
   1. NO EARLIER BODY RIDES A FOLLOW-UP. On each path, no tool message of the follow-up is longer than STUB_MAX characters, and the
      marker each probe file carries at its END (past the 240-character head) appears nowhere in the request.
   2. THE FOLLOW-UP STAYS FLAT AS EARLIER TOOL OUTPUT GROWS. Two conversations alike but for the size of the file their first message
      read (2,000 vs 20,000 characters): their follow-ups' replayed history differs by at most FLAT_MAX characters (CLI and channel).
      A channel round that reads one more 20k file grows the next follow-up's history by at most GROWTH_MAX.
   3. EVERY HANDLE READS BACK BYTE-IDENTICAL. Each stub names an fs.read call; the file it names, in the agent's workspace, holds
      exactly the bytes the earlier run's model was handed, and the REAL fs.read tool, called by the model in a later run with the
      stub's own arguments, hands those same bytes back. The same body replayed again names the same file (written once).
   4. QUOTED WORDS ARE NEVER PARKED. A recall_conversation result (another session's words) is cut to the stub with no handle (the
      old "re-run the tool" wording), and no workspace file holds its words.
   5. TAINT SURVIVES. The result a tainted run made is parked as untrusted-*: a forwarded channel message's run (tainted from its
      start), and a clean CLI run that reads a saved attachment (latched mid-run by that very read, so only the row's own stamp can
      carry it). That CLI follow-up, which replays the result, still starts tainted (its run record says so).
   6. A FILE ON AN EARLIER TURN NEITHER TURNS THE WINDOW OFF NOR STRANDS ITS TURN (W1.8 review). Two Telegram chats of six rounds of
      MANY_CALLS reads each (over the 120-row cap), one with a document on its first round (the cut drops it), one with a document on
      a later round (the window keeps it): each follow-up's replay is inside the row cap and opens on a user turn, every replayed user
      turn holds exactly one round's words (no dropped turn merged into the next kept one), the cut rounds are gone from the replay,
      and the earlier-conversation note carries their words.
   7. A PHOTO NEITHER CUTS THE REPLAY NOR SWINGS THE WINDOW (W1.8 review r3). A Telegram chat of five file reads, then a 300 KB photo
      (its bytes ride the photo's own run and, re-sent, the next one), then two text turns: every follow-up replays every earlier
      round with its results stubbed, carries no earlier-conversation note, and each replay is the one before it plus the newest
      rounds, byte for byte (the window's first message, and the cached prefix behind it, never moves). Red on the lane before
      the fit measured an image by what the run is charged for it: the photo's base64 cut every round but the newest. */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const CHAT = '4242';
const STUB_MAX = 1024;     // a stub is the 240-char head, one header line and an fs.read call: well under this
const FLAT_MAX = 64;       // the stub's byte count gains a digit; nothing else in the replayed history may differ
const GROWTH_MAX = 3000;   // one more round: a user line, a call, a stub, a reply, a user line
const MANY_CALLS = 20;     // section 6: a round's parallel reads (23 replayed messages a round: six rounds are 138, over the row cap)
const ELIDED = '[tool result elided at compaction';
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await sleep(100); }
  throw new Error('timed out waiting for ' + label);
}

/* ---------------------------------------------------------------- the recording model
   A probe is the last user message: W18<id> <VERB> [arg]. READ/HOLD call fs_read on the path; RECALL calls recall_conversation;
   FOLLOW calls fs_read with the arguments the replayed stub names; MANY calls fs_read on MANY_CALLS numbered files at once
   (<arg>-<n>.txt); anything else answers. HOLD keeps its run's final answer until release(id). Every main request is recorded with
   its raw body. */
function startModel() {
  const state = { reqs: [], holds: new Map() };
  const server = http.createServer(async (req, res) => {
    if (String(req.url).indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [
        { id: 'test/model', object: 'model', context_length: 200000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
        { id: 'fixture-model', object: 'model', context_length: 200000 }] }));
    }
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    let lastUser = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; }
    // the Commander's own words: on a chat wire the host notes ride the same user turn (provider.js noteCarrier), and the
    // earlier-conversation note quotes earlier probes verbatim
    const ask = lastUser >= 0 ? text(msgs[lastUser].content).replace(/<(conversation_summary|run_context|recalled-memory|crew_call)>[\s\S]*?<\/\1>/g, '') : '';
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const m = /W18([A-Za-z0-9]+) (READ|HOLD|RECALL|FOLLOW|HI|SRC|MANY)(?: (\S+))?/.exec(ask);
    const main = tools.length > 0 && !!m;
    const answered = msgs.slice(lastUser + 1).some(x => x && x.role === 'tool');
    const toolName = re => { const t = tools.find(d => d && d.function && re.test(d.function.name)); return t ? t.function.name : ''; };
    if (main) state.reqs.push({ id: m[1], verb: m[2], answered, raw, msgs, tools: tools.map(d => d && d.function && d.function.name) });
    let call = null, calls = null;
    if (main && !answered) {
      if (m[2] === 'READ' || m[2] === 'HOLD') call = { name: toolName(/^fs[._]read$/), args: { path: m[3] } };
      else if (m[2] === 'RECALL') call = { name: toolName(/^recall_conversation$/), args: { query: m[3] } };
      else if (m[2] === 'MANY') calls = Array.from({ length: MANY_CALLS }, (_, n) => ({ name: toolName(/^fs[._]read$/), args: { path: String(m[3]).replace(/\.txt$/, '-' + n + '.txt') } }));
      else if (m[2] === 'FOLLOW') {
        // the model follows the handle its replayed history names (the newest stub that names one)
        for (let i = msgs.length - 1; i >= 0 && !call; i--) {
          const x = msgs[i];
          const h = x && x.role === 'tool' && /read it with fs\.read (\{[^\n]*?\})\]/.exec(text(x.content));
          if (h) call = { name: toolName(/^fs[._]read$/), args: JSON.parse(h[1]) };
        }
      }
      if (call) calls = [call];
      if (calls && !calls.every(c => c.name)) calls = null;
    }
    if (main && m[2] === 'HOLD' && answered) {
      let release; const held = new Promise(r => { release = r; });
      state.holds.set(m[1], { release, seen: true });
      await held;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const usage = { prompt_tokens: Math.ceil(raw.length / 3.6), completion_tokens: 20, total_tokens: Math.ceil(raw.length / 3.6) + 20 };
    if (calls) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((c, n) => ({ index: n, id: 'call_' + m[1] + '_' + state.reqs.length + (calls.length > 1 ? '_' + n : ''), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: main ? 'W18DONE ' + m[1] : 'NONE' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  return new Promise(r => server.listen(0, HOST, () => r({ state, server, port: server.address().port,
    release: id => { const h = state.holds.get(id); if (h) h.release(); },
    close: () => new Promise(done => { for (const h of state.holds.values()) h.release(); server.closeAllConnections && server.closeAllConnections(); server.close(done); }) })));
}

/* ---------------------------------------------------------------- the fake Bot API (test/channels.ledger-upgrade.e2e shape)
   A document is one small text file: getFile names it and /file/bot<token>/... serves its bytes (section 6). A photo (a file id
   starting "ph") is PHOTO, a 300 KB JPEG whose header names its pixels (SOF0: 1280 x 960), under photos/ (section 7). */
const DOC = Buffer.from('W18DOC a short attached note for the replay window\n');
const PHOTO = (() => {
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x11, 0x08, 0x03, 0xC0, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([head, require('node:crypto').randomBytes(300 * 1024 - head.length - 2), Buffer.from([0xFF, 0xD9])]);
})();
async function startTelegram() {
  const calls = [], queued = [], waiters = []; let nextId = 100, updateId = 0; const api = { calls, fileGets: 0 };
  const reply = (res, status, obj) => { try { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {} };
  const flush = () => { while (queued.length && waiters.length) { const w = waiters.shift(); clearTimeout(w.timer); reply(w.res, 200, { ok: true, result: [queued.shift()] }); } };
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const url = String(req.url || '').split('?')[0];
      if (url.indexOf('/file/bot') === 0) {
        api.fileGets++;
        const photo = url.indexOf('/photos/') > 0, bytes = photo ? PHOTO : DOC;
        res.writeHead(200, { 'Content-Type': photo ? 'image/jpeg' : 'text/plain', 'Content-Length': bytes.length });
        return res.end(bytes);
      }
      const method = url.split('/').pop();
      let fields = {}; try { fields = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (_) {}
      if (method === 'getFile') {
        const id = String(fields.file_id || ''), photo = /^ph/.test(id);
        return reply(res, 200, { ok: true, result: { file_id: id, file_unique_id: 'u_' + id, file_size: photo ? PHOTO.length : DOC.length,
          file_path: (photo ? 'photos/' : 'documents/') + (id || 'file') + (photo ? '.jpg' : '.txt') } });
      }
      if (method === 'getUpdates') {
        if (fields.offset === -1) return reply(res, 200, { ok: true, result: [] });
        if (queued.length) return reply(res, 200, { ok: true, result: [queued.shift()] });
        const w = { res, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reply(res, 200, { ok: true, result: [] }); }, 800) };
        waiters.push(w); return;
      }
      if (method === 'getMe') return reply(res, 200, { ok: true, result: { id: 42, is_bot: true, username: 'w18_bot', first_name: 'W18' } });
      calls.push({ method, fields });
      return reply(res, 200, { ok: true, result: /^send/.test(method) ? { message_id: nextId++, chat: { id: Number(fields.chat_id) || 0 } } : true });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  api.base = 'http://' + HOST + ':' + server.address().port;
  api.push = (t, extra) => {
    queued.push({ update_id: ++updateId, message: Object.assign({ message_id: 5000 + updateId, date: Math.floor(Date.now() / 1000),
      chat: { id: Number(CHAT), type: 'private' }, from: { id: Number(CHAT), is_bot: false, first_name: 'Ana', username: 'ana' }, text: t }, extra || {}) });
    flush();
  };
  api.close = () => new Promise(r => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); reply(w.res, 200, { ok: true, result: [] }); } server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return api;
}

function hermeticEnv(extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.15.0-w18-invariant',
    STARNET_MAX_UNPRICED_TOKENS: '0', SKYNET_AUX_BUDGET: '0' }, extra || {});
}

// a probe file: a neutral head, filler, and a marker at its END (past any 240-character head)
function probeFile(dir, name, chars, tail) {
  const file = path.join(dir, name).replace(/\\/g, '/');
  let s = 'probe file ' + name + '\n'; let i = 0;
  while (s.length < chars - 40) s += 'line ' + (i++) + ' of the replay probe, plain filler text.\n';
  s = s.slice(0, chars - 40) + '\n' + tail + '\n';
  fs.writeFileSync(file, s);
  return file;
}

const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
function runBody(up, extra) {
  return Object.assign({ provider: 'custom', baseUrl: 'http://' + HOST + ':' + up.port + '/v1', key: 'fixture-key', model: 'fixture-model',
    agentId: 'agent', placed: FLOOR, stationPlaced: FLOOR, isTask: true }, extra);
}
async function post(fixture, body) {
  const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status !== 200) throw new Error('run refused ' + r.status + ' ' + (await r.text()).slice(0, 400));
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', end = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.name === 'agent.run.end' && (!body.runId || ev.payload.runId === body.runId)) end = ev.payload;
    }
  }
  return end;
}
const cliTurn = (fixture, up, streamId, content) => post(fixture, runBody(up, { streamId, client: 'terminal', messages: [{ role: 'user', content }] }));

/* ---------------------------------------------------------------- what a request says */
const reqOf = (state, id, answered) => state.reqs.filter(r => r.id === id && (answered === undefined || r.answered === answered));
const firstReq = (state, id) => reqOf(state, id)[0] || null;
// the replayed history of a request: every non-system message before its newest user message, as it went on the wire
function historyChars(req) {
  let last = -1; for (let i = req.msgs.length - 1; i >= 0; i--) if (req.msgs[i].role === 'user') { last = i; break; }
  return JSON.stringify(req.msgs.slice(0, Math.max(0, last)).filter(m => m.role !== 'system')).length;
}
// the body the earlier run's model was handed for a READ probe: the tool message of its answered request
function handedBody(state, id) {
  const r = reqOf(state, id, true)[0];
  const tool = r && r.msgs.filter(m => m.role === 'tool').pop();
  return tool ? text(tool.content) : null;
}
function toolsOf(req) { return req ? req.msgs.filter(m => m.role === 'tool') : []; }
function pairsValid(req) {
  const open = new Set();
  for (const m of req.msgs) {
    if (m.role === 'assistant') { open.clear(); for (const c of (m.tool_calls || [])) open.add(c.id); }
    else if (m.role === 'tool') { if (!open.has(m.tool_call_id)) return false; }
    else if (m.role === 'user') open.clear();
  }
  return true;
}
const handleOf = content => { const h = /read it with fs\.read (\{[^\n]*?\})\]/.exec(String(content)); return h ? JSON.parse(h[1]) : null; };

(async () => {
  const up = await startModel();
  const telegram = await startTelegram();
  const orBase = 'http://' + HOST + ':' + up.port + '/api/v1';
  const fixture = SidecarFixture.create({ prefix: 'w18-replay-', timeoutMs: 60000, env: hermeticEnv({
    SKYNET_TELEGRAM_API_BASE: telegram.base, STARNET_TELEGRAM_API_BASE: telegram.base,
    SKYNET_OPENROUTER_BASE: orBase, STARNET_OPENROUTER_BASE: orBase,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-w18-replay-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-w18-replay-fake', SKYNET_DEFAULT_MODEL: 'test/model' }) });
  const S = up.state;
  const stubs = [];   // every stub a follow-up carried: { where, content, body }
  try {
    const ws = fixture.workspace;
    const f = {
      cli02: probeFile(ws, 'f02k-cli.txt', 2000, 'W18TAIL_CLI02'), cli20: probeFile(ws, 'f20k-cli.txt', 20000, 'W18TAIL_CLI20'),
      que20: probeFile(ws, 'f20k-que.txt', 20000, 'W18TAIL_QUE20'), ch02: probeFile(ws, 'f02k-chn.txt', 2000, 'W18TAIL_CH02'),
      ch20: probeFile(ws, 'f20k-chn.txt', 20000, 'W18TAIL_CH20'), ch20b: probeFile(ws, 'f20k-chb.txt', 20000, 'W18TAIL_CH20B'),
      chT: probeFile(ws, 'f20k-cht.txt', 20000, 'W18TAIL_CHT')
    };
    await fixture.start();

    // ============ 1. the terminal CLI's resume seed (one user message + a streamId, bin/lib/dashboard.js) ============
    await cliTurn(fixture, up, 'cli02k', 'W18cli02k READ ' + f.cli02);
    await cliTurn(fixture, up, 'cli02k', 'W18cli02kH HI');
    await cliTurn(fixture, up, 'cli20k', 'W18cli20k READ ' + f.cli20);
    await cliTurn(fixture, up, 'cli20k', 'W18cli20kH HI');
    const c2 = firstReq(S, 'cli02kH'), c20 = firstReq(S, 'cli20kH');
    A.ok(!!c2 && !!c20, 'cli: both follow-ups reached the model');
    if (c2 && c20) {
      A.ok(toolsOf(c20).length === 1 && toolsOf(c2).length === 1, 'cli: the resume seed replays the earlier call and its result (' + toolsOf(c20).length + ')');
      A.ok(toolsOf(c20).every(m => text(m.content).length <= STUB_MAX), 'cli: no earlier tool body over ' + STUB_MAX + ' chars rides the follow-up (' + toolsOf(c20).map(m => text(m.content).length).join(',') + ')');
      A.ok(c20.raw.indexOf('W18TAIL_CLI20') < 0, 'cli: the 20k file\'s end is not in the follow-up');
      const flat = historyChars(c20) - historyChars(c2);
      A.ok(Math.abs(flat) <= FLAT_MAX, 'cli: the follow-up stays flat as the earlier output grows 2k -> 20k (history ' + historyChars(c2) + ' -> ' + historyChars(c20) + ', ' + (flat >= 0 ? '+' : '') + flat + '; whole request ' + c2.raw.length + ' -> ' + c20.raw.length + ')');
      A.ok(pairsValid(c20) && pairsValid(c2), 'cli: every replayed result still follows its call');
      for (const [req, id] of [[c2, 'cli02k'], [c20, 'cli20k']]) for (const m of toolsOf(req)) stubs.push({ where: 'cli ' + id, content: text(m.content), body: handedBody(S, id) });
    }
    // the model follows the handle in a LATER run: the REAL fs.read hands the earlier body back
    await cliTurn(fixture, up, 'cli20k', 'W18cli20kF FOLLOW');
    const followed = reqOf(S, 'cli20kF', true)[0];
    const back = followed ? text(toolsOf(followed).pop().content) : null;
    A.ok(back !== null && back === handedBody(S, 'cli20k'), 'cli: the model followed the stub\'s handle and the REAL fs.read returned the earlier body byte for byte (' + (back === null ? 'no call: no handle to follow' : back.length + ' vs ' + String(handedBody(S, 'cli20k') || '').length) + ')');
    // and that later run's own replay names the SAME file for the same body (written once, never once per message)
    const again = firstReq(S, 'cli20kF');
    const firstStub = c20 && toolsOf(c20)[0], againStub = again && toolsOf(again)[0];
    A.ok(!!(firstStub && againStub && handleOf(text(firstStub.content)) && JSON.stringify(handleOf(text(firstStub.content))) === JSON.stringify(handleOf(text(againStub.content)))),
      'cli: a body replayed again names the same saved file');

    // ============ 2. the queued re-seed (a turn that waited behind its stream's run, index.js runOnceQueued) ============
    const held = post(fixture, runBody(up, { streamId: 'que20k', messages: [{ role: 'user', content: 'W18que20k HOLD ' + f.que20 }] }));
    await waitFor(() => S.holds.has('que20k'), 30000, 'the held run to reach its final answer');
    const queuedTurn = post(fixture, runBody(up, { streamId: 'que20k', messages: [
      { role: 'user', content: 'W18que20k HOLD ' + f.que20 }, { role: 'assistant', content: 'W18DONE que20k' }, { role: 'user', content: 'W18queH HI' }] }));
    await sleep(1500);
    A.ok(!firstReq(S, 'queH'), 'queue: the follow-up waited behind its stream\'s run');
    up.release('que20k');
    await held; await queuedTurn;
    const q = firstReq(S, 'queH');
    A.ok(!!q, 'queue: the queued follow-up reached the model');
    if (q) {
      A.ok(q.msgs.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length), 'queue: the follow-up was re-seeded from the transcript (pairs), not the posted prose window');
      A.ok(toolsOf(q).length >= 1 && toolsOf(q).every(m => text(m.content).length <= STUB_MAX), 'queue: no earlier tool body over ' + STUB_MAX + ' chars rides the re-seeded follow-up (' + toolsOf(q).map(m => text(m.content).length).join(',') + ')');
      A.ok(q.raw.indexOf('W18TAIL_QUE20') < 0, 'queue: the 20k file\'s end is not in the re-seeded follow-up');
      A.ok(pairsValid(q), 'queue: every replayed result still follows its call');
      for (const m of toolsOf(q)) stubs.push({ where: 'queue', content: text(m.content), body: handedBody(S, 'que20k') });
    }

    // ============ 3. channel history (a Telegram DM: hub.js history.replay, uncapped before) ============
    const sends = () => telegram.calls.filter(c => c.method === 'sendMessage' && String(c.fields.chat_id) === CHAT);
    const landed = mark => sends().some(c => String(c.fields.text || '').indexOf(mark) >= 0);
    const say = async (t, mark, extra) => { telegram.push(t, extra); await waitFor(() => landed(mark), 40000, mark); await sleep(400); };
    const connected = await fixture.json('POST', '/api/channels/telegram/connect', { token: '123456:TESTTOKEN', key: 'sk-or-v1-w18-replay-fake', model: 'test/model', provider: 'openrouter', agentId: 'agent', agentName: 'ULTRON', system: 'You are ULTRON.' });
    A.eq(connected.status, 200, 'channel: telegram connects');
    await waitFor(async () => { const s = await fixture.json('GET', '/api/channels/telegram/status'); return !!(s.body && s.body.connected && s.body.state === 'up'); }, 20000, 'telegram up');
    const pair = await fixture.json('POST', '/api/channels/telegram/owner/pair', {});
    telegram.push('/pair ' + pair.body.code);
    await waitFor(() => sends().some(c => /Owner paired/i.test(String(c.fields.text || ''))), 15000, 'owner paired');
    await say('W18ch02k READ ' + f.ch02, 'W18DONE ch02k');
    await say('W18ch02kH HI', 'W18DONE ch02kH');
    await say('/new', 'starts fresh');
    await say('W18ch20k READ ' + f.ch20, 'W18DONE ch20k');
    await say('W18ch20kH HI', 'W18DONE ch20kH');
    await say('W18ch20kB READ ' + f.ch20b, 'W18DONE ch20kB');
    await say('W18ch20kG HI', 'W18DONE ch20kG');
    const h2 = firstReq(S, 'ch02kH'), h20 = firstReq(S, 'ch20kH'), hg = firstReq(S, 'ch20kG');
    A.ok(!!h2 && !!h20 && !!hg, 'channel: every follow-up reached the model');
    if (h2 && h20 && hg) {
      A.ok(toolsOf(h20).length === 1 && toolsOf(hg).length === 2, 'channel: the chat replays its earlier calls and results (' + toolsOf(h20).length + ', ' + toolsOf(hg).length + ')');
      A.ok(toolsOf(hg).concat(toolsOf(h20)).every(m => text(m.content).length <= STUB_MAX), 'channel: no earlier tool body over ' + STUB_MAX + ' chars rides a follow-up (' + toolsOf(hg).map(m => text(m.content).length).join(',') + ')');
      A.ok(hg.raw.indexOf('W18TAIL_CH20') < 0 && hg.raw.indexOf('W18TAIL_CH20B') < 0, 'channel: no earlier file\'s end is in the follow-up');
      const flat = historyChars(h20) - historyChars(h2);
      A.ok(Math.abs(flat) <= FLAT_MAX, 'channel: the follow-up stays flat as the earlier output grows 2k -> 20k (history ' + historyChars(h2) + ' -> ' + historyChars(h20) + ', ' + (flat >= 0 ? '+' : '') + flat + '; whole request ' + h2.raw.length + ' -> ' + h20.raw.length + ')');
      const grew = historyChars(hg) - historyChars(h20);
      A.ok(grew <= GROWTH_MAX, 'channel: one more round with a 20k read grows the next follow-up by at most ' + GROWTH_MAX + ' chars, not by the read (+' + grew + ')');
      A.ok(pairsValid(hg) && pairsValid(h20), 'channel: every replayed result still follows its call');
      for (const m of toolsOf(h2)) stubs.push({ where: 'channel ch02k', content: text(m.content), body: handedBody(S, 'ch02k') });
      const order = [handedBody(S, 'ch20k'), handedBody(S, 'ch20kB')];
      toolsOf(hg).forEach((m, i) => stubs.push({ where: 'channel ch20k#' + i, content: text(m.content), body: order[i] }));
    }

    // ============ 5. taint survives: a forwarded message's run is tainted, and so is the park of its result ============
    await say('/new', 'starts fresh');
    await say('W18chT READ ' + f.chT, 'W18DONE chT', { forward_date: Math.floor(Date.now() / 1000) - 60, forward_from: { id: 777, is_bot: false, first_name: 'Stranger' } });
    await say('W18chTH HI', 'W18DONE chTH');
    const ht = firstReq(S, 'chTH');
    const tStub = ht && toolsOf(ht)[0];
    const tHandle = tStub && handleOf(text(tStub.content));
    A.ok(!!tHandle && /^untrusted-/.test(path.basename(String(tHandle.path))), 'taint: the result a tainted run made is parked as untrusted-* (' + (tHandle ? tHandle.path : 'no handle') + ')');
    if (tStub) stubs.push({ where: 'channel tainted', content: text(tStub.content), body: handedBody(S, 'chT') });
    // ...and a taint latched MID-RUN: a clean CLI run reads a saved attachment (taint.js: fs.read under .attachments/ is a source)
    const runRecord = async end => {
      if (!end || !end.runId) return null;
      const r = await fixture.json('GET', '/api/runs?agent=agent&runId=' + encodeURIComponent(end.runId));
      return r.body && Array.isArray(r.body.runs) && r.body.runs[0] || null;
    };
    const attDir = path.join(ws, '.attachments'); fs.mkdirSync(attDir, { recursive: true });
    const fAtt = probeFile(attDir, 'f20k-att.txt', 20000, 'W18TAIL_ATT');
    const attRun = await runRecord(await cliTurn(fixture, up, 'cliatt', 'W18cliatt READ ' + fAtt));
    A.ok(!!(attRun && attRun.taintedBy), 'taint: reading a saved attachment latched the clean run mid-run (' + (attRun ? JSON.stringify(attRun.taintedBy) : 'no run record') + ')');
    const attFollow = await runRecord(await cliTurn(fixture, up, 'cliatt', 'W18cliattH HI'));
    const ha = firstReq(S, 'cliattH');
    const aStub = ha && toolsOf(ha)[0];
    const aHandle = aStub && handleOf(text(aStub.content));
    A.ok(!!aHandle && /^untrusted-/.test(path.basename(String(aHandle.path))), 'taint: a result whose own read latched its run is parked as untrusted-* (' + (aHandle ? aHandle.path : 'no handle') + ')');
    A.ok(!!(ha && ha.raw.indexOf('W18TAIL_ATT') < 0), 'taint: the attachment\'s end is not in the follow-up');
    A.ok(!!(attFollow && attFollow.taintedBy), 'taint: the follow-up that replays it starts tainted (' + (attFollow ? JSON.stringify(attFollow.taintedBy) : 'no run record') + ')');
    if (aStub) stubs.push({ where: 'cli attachment', content: text(aStub.content), body: handedBody(S, 'cliatt') });

    // ============ 4. quoted words are never parked ============
    const QUOTED = 'W18QUOTEDWORDS';
    let words = 'Notes about the zanzibarquill rollout: ' + QUOTED + ' ';
    while (words.length < 1400) words += 'the zanzibarquill rollout needs a careful plan for every station and every crew member. ';
    await cliTurn(fixture, up, 'notessrc', 'W18src SRC ' + words);
    await cliTurn(fixture, up, 'cliq', 'W18cliq RECALL zanzibarquill');
    const rq = reqOf(S, 'cliq', true)[0];
    const recalled = rq ? text(toolsOf(rq).pop().content) : '';
    A.ok(recalled.indexOf(QUOTED) >= 0 && recalled.length > 240, 'quote: the recall read another session\'s words (' + recalled.length + ' chars)');
    await cliTurn(fixture, up, 'cliq', 'W18cliqH HI');
    const qh = firstReq(S, 'cliqH');
    const qStub = qh && toolsOf(qh)[0];
    const qText = qStub ? text(qStub.content) : '';
    A.ok(qText.indexOf(ELIDED) === 0 && qText.indexOf('re-run the tool for the full output') > 0 && !handleOf(qText),
      'quote: the recall result rides as the stub with no handle (' + qText.slice(0, 160).replace(/\n/g, ' ') + ')');
    const parkDir = path.join(ws, 'agent', '.output');
    const parked = fs.existsSync(parkDir) ? fs.readdirSync(parkDir) : [];
    A.ok(parked.every(n => fs.readFileSync(path.join(parkDir, n), 'utf8').indexOf(QUOTED) < 0), 'quote: no workspace file holds the quoted words (' + parked.length + ' parked file(s))');

    // ============ 3. every handle reads back byte-identical ============
    A.ok(stubs.length >= 8, 'handles: the follow-ups carried the stubs to check (' + stubs.length + ')');
    for (const s of stubs) {
      const h = handleOf(s.content);
      A.ok(s.content.indexOf(ELIDED) === 0 && !!h, s.where + ': the replayed result is the stub and names a handle (' + s.content.slice(0, 140).replace(/\n/g, ' ') + ')');
      if (!h || typeof s.body !== 'string') continue;
      const abs = path.isAbsolute(h.path) ? h.path : path.join(ws, 'agent', h.path);
      let bytes = null; try { bytes = fs.readFileSync(abs); } catch (_) { bytes = null; }
      A.ok(!!bytes && bytes.equals(Buffer.from(s.body, 'utf8')), s.where + ': the handle reads back BYTE-IDENTICAL to the body the earlier run was handed (' + (bytes ? bytes.length : 'missing') + ' vs ' + Buffer.byteLength(s.body, 'utf8') + ' bytes)');
      A.ok(s.content.indexOf(s.body.slice(0, 200)) > 0, s.where + ': the stub keeps the head of that body');
    }

    // ============ 6. a file on an earlier turn neither turns the window off nor strands its turn (W1.8 review) ============
    // The run host expands a turn's files (attachments.expandForRun) before the replay is resolved: a replayed turn that carried a
    // file must keep its tag and the list its row ids, or the window is lost (a file on a later turn) or the file turn is left
    // stranded in front of the cut and merged into the next kept turn, with no note for what was cut (a file on the first turn).
    const manyBase = path.join(ws, 'many.txt').replace(/\\/g, '/');
    for (let n = 0; n < MANY_CALLS; n++) fs.writeFileSync(manyBase.replace(/\.txt$/, '-' + n + '.txt'), 'many file ' + n + ': a short read for the window.\n');
    const freshSends = () => sends().filter(c => /starts fresh|Nothing to clear/i.test(String(c.fields.text || ''))).length;
    for (const [chat, fileOn] of [['fa', 1], ['fb', 4]]) {
      const label = 'file on round ' + fileOn;
      const before = freshSends();
      telegram.push('/new');
      await waitFor(() => freshSends() > before, 40000, label + ': /new');
      const gets = telegram.fileGets;
      for (let k = 1; k <= 6; k++) {
        const words = 'W18' + chat + 'R' + k + ' MANY ' + manyBase;
        if (k !== fileOn) { await say(words, 'W18DONE ' + chat + 'R' + k); continue; }
        await say('', 'W18DONE ' + chat + 'R' + k, { text: undefined, caption: words,
          document: { file_id: 'doc' + chat, file_unique_id: 'u' + chat, file_name: 'note.txt', mime_type: 'text/plain', file_size: DOC.length } });
      }
      A.ok(telegram.fileGets > gets && reqOf(S, chat + 'R' + fileOn).some(r => r.raw.indexOf('W18DOC') >= 0), label + ': the document reached the run that answered it');
      await say('W18' + chat + 'H HI', 'W18DONE ' + chat + 'H');
      const f = firstReq(S, chat + 'H');
      A.ok(!!f, label + ': the follow-up reached the model');
      if (!f) continue;
      let last = -1; for (let i = f.msgs.length - 1; i >= 0; i--) if (f.msgs[i].role === 'user') { last = i; break; }
      const replayed = f.msgs.slice(0, Math.max(0, last)).filter(m => m.role !== 'system');
      const roundRe = new RegExp('(?:W18|W18DONE |call_)' + chat + 'R(\\d)', 'g');
      const roundsOf = m => [...new Set([...(text(m.content) + JSON.stringify(m.tool_calls || []) + String(m.tool_call_id || '')).matchAll(roundRe)].map(x => Number(x[1])))];
      const users = replayed.filter(m => m.role === 'user');
      const kept = [...new Set(replayed.flatMap(roundsOf))].sort((a, b) => a - b);
      A.ok(replayed.length > 0 && replayed.length <= 120 && replayed[0].role === 'user', label + ': the replay is inside the 120-row cap and opens on a user turn (' + replayed.length + ' messages, the first a ' + (replayed[0] && replayed[0].role) + ')');
      A.ok(users.length > 0 && users.every(m => roundsOf(m).length === 1), label + ': every replayed user turn holds exactly one round\'s words, no cut turn merged into a kept one (' + users.map(m => roundsOf(m).join('+')).join(' ') + ')');
      A.eq(kept, [3, 4, 5, 6], label + ': the cut drops the oldest rounds whole and keeps the newest four');
      A.ok(pairsValid(f), label + ': every replayed result still follows its call');
      if (fileOn >= 3) A.ok(users.some(m => roundsOf(m)[0] === fileOn && /note\.txt/.test(text(m.content))), label + ': the kept round that carried the file rides with its file note');
      const note = (/<conversation_summary>[\s\S]*?<\/conversation_summary>/.exec(f.msgs.map(m => text(m.content)).join('\n')) || [''])[0];
      A.ok(note.indexOf('W18' + chat + 'R1 MANY') >= 0 && note.indexOf('W18' + chat + 'R2 MANY') >= 0, label + ': the earlier-conversation note carries the cut rounds\' words (' + (note ? note.length + ' chars' : 'no note') + ')');
    }

    // ============ 7. a photo neither cuts the replay nor swings the window (W1.8 review r3) ============
    // The run host expands a photo into a data URL of its whole base64 before the replay is resolved. Measured by those bytes, one
    // 300 KB photo on the directive (or on the turn before it, which re-sends it) counted ~205k tokens against a 114k budget and cut
    // every earlier round into the note, and the window sprang back once the photo stopped riding. Measured as the run is charged
    // for it (~1,500 tokens), nothing moves.
    {
      const before = freshSends();
      telegram.push('/new');
      await waitFor(() => freshSends() > before, 40000, 'photo chat: /new');
      const reads = [1, 2, 3, 4, 5].map(k => probeFile(ws, 'ph-r' + k + '.txt', 3000, 'W18TAIL_PHR' + k));
      for (let k = 1; k <= 5; k++) await say('W18phR' + k + ' READ ' + reads[k - 1], 'W18DONE phR' + k);
      const gets = telegram.fileGets;
      await say('', 'W18DONE phR6', { text: undefined, caption: 'W18phR6 HI',
        photo: [{ file_id: 'ph_small', file_unique_id: 'u_ph_small', width: 90, height: 67, file_size: 1200 },
                { file_id: 'ph_big', file_unique_id: 'u_ph_big', width: 1280, height: 960, file_size: PHOTO.length }] });
      await say('W18phR7 HI', 'W18DONE phR7');
      await say('W18phR8 HI', 'W18DONE phR8');
      const reqs = [5, 6, 7, 8].map(k => firstReq(S, 'phR' + k));
      A.ok(reqs.every(Boolean), 'photo chat: every turn reached the model');
      const replayOf = req => {
        if (!req) return [];
        let last = -1; for (let i = req.msgs.length - 1; i >= 0; i--) if (req.msgs[i].role === 'user') { last = i; break; }
        return req.msgs.slice(0, Math.max(0, last)).filter(m => m.role !== 'system');
      };
      const roundsOf = list => [...new Set(list.flatMap(m => [...(text(m.content) + JSON.stringify(m.tool_calls || []) + String(m.tool_call_id || '')).matchAll(/(?:W18|W18DONE |call_)phR(\d)/g)].map(x => Number(x[1]))))].sort((a, b) => a - b);
      const [q5, q6, q7, q8] = reqs.map(replayOf);
      A.ok(!!reqs[1] && reqs[1].raw.indexOf('data:image/jpeg;base64,') >= 0 && telegram.fileGets > gets, 'photo chat: the photo reached the run it was sent with (R6) as image bytes');
      A.ok(!!reqs[2] && reqs[2].raw.indexOf('data:image/jpeg;base64,') >= 0, 'photo chat: the next turn re-sent it (R7: the photo on the previous round)');
      for (const [k, q, req] of [[6, q6, reqs[1]], [7, q7, reqs[2]], [8, q8, reqs[3]]]) {
        if (!req) continue;
        A.eq(roundsOf(q), Array.from({ length: k - 1 }, (_, i) => i + 1), 'photo chat R' + k + ': every earlier round is replayed');
        const tools = q.filter(m => m.role === 'tool');
        A.ok(tools.length === 5 && tools.every(m => text(m.content).indexOf(ELIDED) === 0 && text(m.content).length <= STUB_MAX),
          'photo chat R' + k + ': the five earlier reads ride as stubs (' + tools.map(m => text(m.content).length).join(',') + ')');
        const note = (/<conversation_summary>[\s\S]*?<\/conversation_summary>/.exec(req.msgs.map(m => text(m.content)).join('\n')) || [''])[0];
        A.ok(!note, 'photo chat R' + k + ': no earlier-conversation note, nothing was cut (' + (note ? note.length + ' chars' : 'none') + ')');
        A.ok(pairsValid(req), 'photo chat R' + k + ': every replayed result still follows its call');
      }
      // the window never swings: each replay starts as the one before it did, byte for byte (up to the photo's own turn, whose
      // bytes ride two turns and then become a marker)
      const extends_ = (a, b) => a.length > 0 && b.length > a.length && JSON.stringify(b.slice(0, a.length)) === JSON.stringify(a);
      A.ok(extends_(q5, q6) && extends_(q6, q7) && extends_(q6, q8), 'photo chat: every replay starts as the one before it did, byte for byte (' + [q5, q6, q7, q8].map(q => q.length).join(' -> ') + ' replayed messages)');
    }
  } catch (e) {
    A.ok(false, 'rig error: ' + ((e && e.stack) || e));
    console.log('model requests: ' + S.reqs.map(r => r.id + '/' + r.verb + (r.answered ? '+' : '')).join(' '));
    console.log('bot calls: ' + telegram.calls.slice(-12).map(c => c.method + ' ' + String(c.fields.text || '').slice(0, 100).replace(/\n/g, ' ')).join(' | '));
    try { console.log(fixture.output().slice(-3000)); } catch (_) {}
  } finally {
    await fixture.dispose(); await telegram.close(); await up.close();
  }
  A.report('cross-run-replay.invariant.test');
})();
