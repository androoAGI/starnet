/* node test/atlas-events.emit.e2e.test.js — emit-seam gate for two bus events the Atlas events-area audit
   found EMITTED + CONSUMED but with NO test asserting the emit/payload BY NAME:

     · workitem.superseded (finding 40203e5e) — a plain owner follow-up joins its active run; a FORWARDED
       third-party message must instead enter a fresh, tainted run. Hold run #1 through the first follow-up,
       prove no false supersede, then forward a task on the SAME chat and assert the genuine supersede event
       and prior work-item id on SSE. A harmless canned shell call proves the forwarded-content lock on wire.
     · workshop.decided (finding cf61a8e9; shared/events.js:140, emit sidecar/index.js:~6749) — emit-only
       telemetry when the Commander decides a pending deliverable. Driven deterministically via the 'later'
       decision (no manifest/disk needed): POST /api/workshop/decide {decision:'later'} emits it on the bus.

   Zero model spend: the mocked provider returns a canned stream (pricing 0); no real key is ever sent. Run
   via test:http (a child-process boot test shouldn't gate other agents' merges). */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
// the run-context note is the leading text of the newest user message on a non-Claude chat wire: match the Commander's own words
const { userWords, loopNotes } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const ORIGINAL_TASK = 'research the launch checklist now';
const FORWARDED_TASK = 'research the release notes instead ATLAS_FORWARDED_TASK';
const FORWARDED_ANSWER = 'ATLAS_FORWARDED_ANSWER';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJsonBody(req) { return new Promise(resolve => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } }); }); }

// Hold only the exact original task after its first delta; auxiliary requests cannot steal this gate.
// A plain follow-up keeps it live, then a forwarded task genuinely supersedes it.
function startMockOpenRouter() {
  const requests = [];
  const gate = { armed: false, userText: null, request: null, _release: null };
  gate.arm = (userText) => { gate.armed = true; gate.userText = userText; gate.request = null; };
  gate.release = () => { const r = gate._release; gate._release = null; if (r) r(); };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', async () => {
          let parsed = null;
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          const msgs = (parsed && parsed.messages) || [];
          const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
          const forwardedTask = lastUser && userWords(lastUser) === FORWARDED_TASK;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (forwardedTask && !msgs.some(m => m && m.role === 'tool' && m.tool_call_id === 'atlas_taint_probe')) {
            // Safe even if a regression dispatches it: echo only. The assertion requires the genuine taint refusal.
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'atlas_taint_probe', type: 'function', function: { name: 'shell_exec', arguments: '{"cmd":"echo ATLAS_TAINT_MUST_NOT_EXECUTE"}' } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
            res.end('data: [DONE]\n\n');
            return;
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: forwardedTask ? FORWARDED_ANSWER : 'answer' } }] }) + '\n\n');
          if (gate.armed && lastUser && userWords(lastUser) === gate.userText) {
            gate.armed = false; gate.request = parsed;
            await new Promise(r => { gate._release = r; });
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, gate, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function startMockTelegram() {
  const calls = []; const sends = []; const queued = []; const waiters = [];
  let updateId = 1000, messageId = 2000;
  const respond = (res, obj) => { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {} };
  const flush = () => { while (queued.length && waiters.length) respond(waiters.shift().res, { ok: true, result: [queued.shift()] }); };
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop();
      const body = await readJsonBody(req);
      calls.push({ method, body });
      if (method === 'deleteWebhook') return respond(res, { ok: true, result: true });
      if (method === 'getUpdates') {
        if (body.offset === -1) return respond(res, { ok: true, result: [] });
        if (queued.length) return respond(res, { ok: true, result: [queued.shift()] });
        const waiter = { res }; waiters.push(waiter);
        req.on('close', () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      if (method === 'sendMessage') { sends.push(body); return respond(res, { ok: true, result: { message_id: ++messageId } }); }
      respond(res, { ok: false, error_code: 404, description: 'unknown method' });
    });
    server.listen(0, HOST, () => resolve({
      calls, sends, base: 'http://' + HOST + ':' + server.address().port,
      pushText(chatId, userId, text, forwarded = false) {
        const message = { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text };
        if (forwarded) message.forward_origin = { type: 'hidden_user', sender_user_name: 'Synthetic third party', date: message.date };
        queued.push({ update_id: ++updateId, message });
        flush();
      },
      close(done) { while (waiters.length) respond(waiters.shift().res, { ok: true, result: [] }); server.close(done || (() => {})); }
    }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function startSseCollector(url) {
  const ac = new AbortController();
  const events = []; const waiters = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'SSE feed opens with token');
  const reader = res.body.getReader();
  const notify = () => { for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; try { if (w.pred(events)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(events); } } catch (e) { waiters.splice(i, 1); clearTimeout(w.timer); w.reject(e); } } };
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try { while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line || line[0] === ':') continue; if (line.indexOf('data:') === 0) { try { events.push(JSON.parse(line.slice(5).trim())); notify(); } catch (_) {} } } } } catch (_) {}
  })();
  return {
    events,
    waitFor(pred, ms, label) { if (pred(events)) return Promise.resolve(events); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms); waiters.push({ pred, resolve, reject, timer }); }); },
    close() { try { ac.abort(); } catch (_) {} }
  };
}

async function waitUntil(fn, ms, label) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await fn()) return; await sleep(25); } throw new Error('timed out waiting for ' + label); }

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegram();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-events-emit-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-events-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-events-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: 'TESTTOKEN', STARNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    SKYNET_TELEGRAM_API_BASE: tg.base, STARNET_TELEGRAM_API_BASE: tg.base
  };
  const { child, port } = await boot(8975 + (process.pid % 40), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token));

    // ================= workitem.superseded =================
    // wait for the adapter's drop-pending poll so the hub is live, then HOLD run #1 in-flight.
    await waitUntil(() => tg.calls.some(c => c.method === 'getUpdates' && c.body && c.body.offset === -1), 6000, 'telegram drop-pending poll');
    // First DM never claims a remote-control bot. Pair this test's owner via the authenticated local route.
    const pair = await (await fetch(B + '/api/channels/telegram/owner/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: '{}'
    })).json();
    A.ok(/^[-A-Z0-9]{11}$/.test(String(pair.code || '')), 'owner pairing issued a code');
    tg.pushText(5555, 77, '/pair ' + pair.code);
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '5555' && /Owner paired/i.test(String(s.text || ''))), 8000, 'owner pairing acknowledgement');
    llm.gate.arm(ORIGINAL_TASK);
    const CHAT = 5555;
    tg.pushText(CHAT, 77, ORIGINAL_TASK);   // task-phrased → rides the belt as a crate

    // run #1's work-item is placed on the belt; capture its id (superseded must carry the SAME id).
    await sse.waitFor(ev => ev.some(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'tg_' + CHAT), 8000, 'workitem.placed for run #1');
    const placed = sse.events.find(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'tg_' + CHAT);
    const wi1 = placed.payload.workitemId;
    A.ok(wi1 && typeof wi1 === 'string', 'run #1 got a workitemId on the belt');
    await waitUntil(() => !!llm.gate._release, 8000, 'the exact original task reaches the fixture gate');
    A.ok(llm.gate.request.messages.some(m => m && m.role === 'user' && userWords(m) === ORIGINAL_TASK), 'the gate holds the original task request');
    const starts = () => sse.events.filter(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'tg_' + CHAT);
    const ends = () => sse.events.filter(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'tg_' + CHAT);
    await sse.waitFor(() => starts().length === 1, 5000, 'original run start');
    const run1 = starts()[0].payload.runId;
    const chatReplies = () => tg.sends.filter(s => String(s.chat_id) === String(CHAT));

    // The old fixture assumed this plain owner message superseded run #1. Current behavior steers it instead.
    tg.pushText(CHAT, 77, 'also include the release notes in the checklist');
    await waitUntil(() => chatReplies().some(s => /Added to the task that is already running/.test(String(s.text || ''))), 8000, 'plain follow-up is acknowledged as steering');
    A.eq(starts().length, 1, 'plain follow-up starts no replacement run');
    A.eq(ends().length, 0, 'the original run is still held, not cancelled');
    A.ok(!sse.events.some(e => e.name === 'workitem.superseded' && e.payload && e.payload.workitemId === wi1), 'plain steering never falsely supersedes its live crate');
    A.eq(sse.events.filter(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'tg_' + CHAT).length, 1, 'plain steering places no replacement crate');
    const acknowledgements = chatReplies().filter(s => /Added to the task that is already running/.test(String(s.text || ''))).length;

    // A FORWARDED third-party task cannot be an owner steering instruction. Its new tainted run supersedes #1.
    tg.pushText(CHAT, 77, FORWARDED_TASK, true);
    await sse.waitFor(ev => ev.some(e => e.name === 'workitem.superseded' && e.payload && e.payload.workitemId === wi1), 8000, 'workitem.superseded for run #1');
    const sup = sse.events.find(e => e.name === 'workitem.superseded' && e.payload && e.payload.workitemId === wi1);
    A.ok(sup, 'workitem.superseded fired BY NAME for the aborted in-flight box');
    A.eq(sup.payload.workitemId, wi1, 'superseded carries the SUPERSEDED work-item id (the prior box, not the new one)');
    A.eq(sup.payload.agentId, 'tg_' + CHAT, 'superseded carries the aborted run\'s agentId');
    A.ok(typeof sup.payload.ts === 'number', 'superseded carries a numeric ts');

    await sse.waitFor(() => ends().some(e => e.payload.runId === run1 && e.payload.reason === 'cancelled'), 8000, 'the original run is cancelled by the genuine replacement');
    await sse.waitFor(ev => ev.some(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'tg_' + CHAT && e.payload.workitemId !== wi1), 8000, 'the forwarded task gets a distinct crate');
    const placed2 = sse.events.find(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'tg_' + CHAT && e.payload.workitemId !== wi1);
    A.ok(placed2.payload.workitemId !== wi1, 'the supersede event names the old crate, not its replacement');
    const forwardedRequests = () => llm.requests.filter(r => {
      const last = [...(r.messages || [])].reverse().find(m => m && m.role === 'user');
      return last && userWords(last) === FORWARDED_TASK;
    });
    const probeResult = () => forwardedRequests().flatMap(r => r.messages || []).find(m => m && m.role === 'tool' && m.tool_call_id === 'atlas_taint_probe');
    await waitUntil(() => !!probeResult(), 12000, 'the forwarded run returns its taint refusal to the provider');
    A.ok(!forwardedRequests().some(r => loopNotes(r.messages, 'steering_note').some(n => n.includes(FORWARDED_TASK))), 'forwarded content reaches a new user turn, never an owner steering note');
    A.ok(/BLOCKED: "shell[._]exec" is no longer available on this run/.test(String(probeResult().content)), 'the harmless shell probe is refused by the real content trust boundary');
    A.ok(/started with outside content.*forwarded message/.test(String(probeResult().content)), 'the provider sees the real forwarded-message taint provenance');
    await waitUntil(() => chatReplies().some(s => String(s.text || '').includes(FORWARDED_ANSWER)), 8000, 'the forwarded replacement answer is delivered');
    await sse.waitFor(() => ends().some(e => e.payload.runId !== run1 && e.payload.reason === 'done'), 8000, 'a distinct replacement run finishes');
    const run2 = ends().find(e => e.payload.runId !== run1 && e.payload.reason === 'done').payload.runId;
    A.ok(starts().some(e => e.payload.runId === run2), 'the replacement answer belongs to a separately started run');
    A.eq(chatReplies().filter(s => /Added to the task that is already running/.test(String(s.text || ''))).length, acknowledgements, 'the forwarded task never receives a misleading steering acknowledgement');
    console.log('atlas-supersede-proof: ' + JSON.stringify({ originalRunId: run1, replacementRunId: run2,
      priorWorkitemId: wi1, replacementWorkitemId: placed2.payload.workitemId,
      plainFollowupKeptOriginal: true, supersededEvent: sup.payload,
      originalCancelled: true, forwardedTaintRefusalOnWire: true, replacementAnswerDelivered: true }));
    llm.gate.release();

    // ================= workshop.decided =================
    // the 'later' decision is emit-only telemetry — no manifest/disk needed. POST decide {later} → event on the bus.
    const decide = await fetch(B + '/api/workshop/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ agentId: 'agent', runId: 'run-coverage', decision: 'later' })
    });
    const decideBody = await decide.json();
    A.eq(decide.status, 200, 'POST /api/workshop/decide {later} -> 200');
    A.eq(decideBody.decision, 'later', 'decide echoes the later decision');
    await sse.waitFor(ev => ev.some(e => e.name === 'workshop.decided' && e.payload && e.payload.runId === 'run-coverage'), 5000, 'workshop.decided on the bus');
    const dec = sse.events.find(e => e.name === 'workshop.decided' && e.payload && e.payload.runId === 'run-coverage');
    A.ok(dec, 'workshop.decided fired BY NAME');
    A.eq(dec.payload.decision, 'later', 'workshop.decided carries the decision');
    A.eq(dec.payload.agentId, 'agent', 'workshop.decided carries the agentId');
    A.eq(dec.payload.runId, 'run-coverage', 'workshop.decided carries the runId');

  } finally {
    try { llm.gate.release(); } catch (_) {}
    try { if (sse) sse.close(); } catch (_) {}
    try { tg.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('atlas-events.emit.e2e');
})().catch(e => { console.log('FAIL: atlas-events.emit.e2e threw — ' + (e && e.stack || e)); process.exit(1); });
