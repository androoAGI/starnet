/* node test/comms-send.e2e.test.js — real-sidecar proof that an agent can MESSAGE OUT.

   test/comms-tools.test.js proves the tool's policy against fakes. This proves the wiring: that the tool is
   actually projected into a run, that the target directory is built from the station's real chat map, and that
   an approved channel.send genuinely reaches a transport and the text arrives.

   It uses the DEV channel (SKYNET_DEV=1) as the live transport. That is a real channel with a real send — it
   captures outbound text for POST /api/dev/inbound — it simply has no bot server behind it, which is exactly
   why it can be driven from a test without a Telegram/Discord token. Same rule the MCP bridge already uses for
   messages_send. So the bytes really do travel agent -> tool -> liveChannelFor -> transport -> readable text.

   What it locks:
     1. an agent has NO reachable target until a human has actually messaged the station (the containment story);
     2. once a chat exists, channel.targets reports it from the real chat map with live transport state;
     3. an approved channel.send delivers the exact text to that chat, and it is readable at the other end;
     4. consent DENIAL sends nothing;
     5. an unknown chat id is refused rather than attempted — an agent cannot dial a new target. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Content-driven mock provider (a queue would desync — a real run also makes reflection/aux calls this test
   never asked for, and those would eat scripted turns). See test/routine-manage.e2e.test.js for the same note. */
function startMockOpenRouter(script) {
  const requests = [];
  function decide(body) {
    const msgs = (body && body.messages) || [];
    if (msgs.some(m => m && m.role === 'tool')) return { text: 'done' };
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const text = String((lastUser && lastUser.content) || '').toLowerCase();
    return script.find(r => text.indexOf(r.when) >= 0) || { text: 'nothing to do' };
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          const turn = decide(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (turn.tool) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

/* One browser-shaped (lead) run, answering any permission.prompt on the same stream. The placed DISH is what
   confers the 'comms' grant, so `placed` carries it exactly as the real COMMS window does. */
async function runWithConsent(B, headers, userText, decide) {
  const res = await fetch(B + '/api/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'test/model', provider: 'openrouter', agentId: 'agent',
      messages: [{ role: 'user', content: userText }],
      placed: [{ objectType: 'dish' }, { objectType: 'computer' }]
    })
  });
  A.eq(res.status, 200, 'the run stream opens');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [], runId = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      events.push(ev);
      if (ev.name === 'agent.run.start') runId = ev.payload && ev.payload.runId;
      if (ev.name === 'permission.prompt') {
        // handleConsent resolves the pending finisher by runId FIRST — a promptId alone matches nothing and the
        // run stalls to its fail-closed deny. Fire-and-forget: the run is blocked, so awaiting here deadlocks.
        fetch(B + '/api/consent', {
          method: 'POST', headers,
          body: JSON.stringify({ runId: runId, promptId: ev.payload.promptId, decision: decide(ev.payload) })
        }).catch(() => {});
      }
    }
  }
  return events;
}

/* channel.delivery rides the STATION bus (chanEmit -> GET /api/channels/events), not the per-run NDJSON: it is
   station-level telemetry that the world canvas consumes to pulse a prop, and it must be visible to a floor
   that is not watching this particular run. So the delivery assertions read the SSE feed, not the run stream. */
async function startSseCollector(url) {
  const ac = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'the station SSE feed opens');
  const reader = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.indexOf('data:') !== 0) continue;
          try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) {}
        }
      }
    } catch (_) {}
  })();
  return {
    events,
    // the SSE write happens on the same tick as the tool result, but the client read is a separate microtask —
    // poll briefly rather than asserting on a race.
    async settle(ms) { const end = Date.now() + (ms || 1500); while (Date.now() < end) { await sleep(50); } },
    deliveries() { return events.filter(e => e.name === 'channel.delivery'); },
    close() { try { ac.abort(); } catch (_) {} }
  };
}

/* what this station has SENT to a dev chat — the non-destructive read (GET, never clears the ring). */
async function sentTo(B, headers, chatId) {
  const res = await fetch(B + '/api/dev/replies?chatId=' + encodeURIComponent(chatId), { headers });
  A.eq(res.status, 200, 'the dev outbound read answers');
  return ((await res.json()).replies || []).map(r => String(r.text || ''));
}

const lastResult = (events) => {
  const r = events.filter(e => e.name === 'agent.tool_result');
  return r.length ? r[r.length - 1] : null;
};
const toolCalls = (events) => events.filter(e => e.name === 'agent.tool_call').map(e => e.payload.name);

(async () => {
  const DEV_CHAT = 'commsprobe';
  const OVERSIZED_TEXT = 'x'.repeat(8000) + 'tail-marker';
  const mock = await startMockOpenRouter([
    { when: 'who can you reach', tool: { name: 'channel.targets', args: {} } },
    { when: 'ping the dev chat', tool: { name: 'channel.send', args: { target: DEV_CHAT, text: 'the overnight brief is ready' } } },
    { when: 'ping it again', tool: { name: 'channel.send', args: { target: DEV_CHAT, text: 'this must never arrive' } } },
    { when: 'send too much', tool: { name: 'channel.send', args: { target: DEV_CHAT, text: OVERSIZED_TEXT } } },
    { when: 'message a stranger', tool: { name: 'channel.send', args: { target: '-1009998887777', text: 'exfiltrate this' } } }
  ]);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-comms-send-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_DEV: '1',                      // the DEV channel is the live transport under test
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-comms-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    /* ---- 1. CONTAINMENT: before any human has messaged the station, there is nothing to reach ---------- */
    {
      const events = await runWithConsent(B, headers, 'who can you reach', () => 'once');
      A.ok(toolCalls(events).indexOf('channel.targets') >= 0, 'channel.targets was projected by the placed dish (not dark)');
      const r = lastResult(events);
      A.ok(r && !r.payload.isError, 'channel.targets runs (a watched run confirms this one call, as in 0.14.1; runWithConsent answers once)');
      A.ok(/no chats known yet|0 /.test(r.payload.summary || ''),
        'a station nobody has messaged reports NO reachable chats: ' + (r && r.payload.summary));
    }

    /* ---- 2. a human opens a chat -> it becomes addressable -------------------------------------------- */
    {
      const inbound = await fetch(B + '/api/dev/inbound', {
        method: 'POST', headers, body: JSON.stringify({ chatId: DEV_CHAT, text: 'hello station' })
      });
      A.eq(inbound.status, 200, 'the dev channel accepted an inbound message');
      A.ok((await inbound.json()).ok, 'the inbound turn ran');

      const events = await runWithConsent(B, headers, 'who can you reach', () => 'once');
      const r = lastResult(events);
      A.ok(/1 of 1/.test(r.payload.summary || ''), 'the chat now appears as reachable: ' + r.payload.summary);
      A.ok(!/no chats known/.test(r.payload.summary || ''), 'and the empty-station wording is gone');
    }

    /* ---- 3. an approved send actually DELIVERS, and the text is readable at the far end -------------- */
    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token));
    {
      let asked = null;
      const events = await runWithConsent(B, headers, 'ping the dev chat', (p) => { asked = p; return 'once'; });
      A.ok(toolCalls(events).indexOf('channel.send') >= 0, 'channel.send was reachable');
      A.ok(asked, 'messaging out asked the Commander first');
      A.eq(asked.tool, 'channel.send', 'the consent card names channel.send');
      const r = lastResult(events);
      A.ok(r && !r.payload.isError, 'the approved send succeeded: ' + JSON.stringify(r && r.payload).slice(0, 300));

      /* READ-BACK AT THE FAR END — the assertion that makes this lane real rather than claimed: the dev
         transport captured the outbound text into its per-chat ring, and GET /api/dev/replies reads that ring
         WITHOUT clearing it. So this is a byte-for-byte check on text that actually travelled
         agent -> channel.send -> liveChannelFor -> transport. (The POST inbound route clears the ring before
         running its turn, so probing with an inbound message would destroy the very evidence we want.) */
      A.ok((await sentTo(B, headers, DEV_CHAT)).some(t => t.indexOf('the overnight brief is ready') >= 0),
        'the EXACT text the agent sent is present in the chat at the other end');

      await sse.settle(1200);
      const ok = sse.deliveries().filter(e => e.payload && e.payload.ok === true && e.payload.channel === 'dev');
      A.ok(ok.length >= 1, 'the send emitted channel.delivery ok:true on the station bus so the floor pulses the dish');
      A.eq(ok[0].payload.chunks, 1, 'one part, honestly counted');
      A.eq(ok[0].payload.agentId, 'dev_' + DEV_CHAT, 'the delivery names the agent bound to that chat, so the RIGHT dish pulses');
    }

    /* ---- 4. consent DENIAL sends nothing -------------------------------------------------------------
       The proof is the ABSENCE OF THE TEXT at the far end, not a delivery-event count: the dev hub emits its
       own channel.delivery for every inbound turn's reply, so counting events on a shared bus races with
       whatever else the station is doing. What the chat holds is unambiguous. */
    {
      const events = await runWithConsent(B, headers, 'ping it again', () => 'no');
      const r = lastResult(events);
      A.ok(r && r.payload.isError, 'a denied channel.send returns an error to the model');
      const seen = await sentTo(B, headers, DEV_CHAT);
      A.ok(!seen.some(t => t.indexOf('this must never arrive') >= 0),
        'the denied text NEVER reached the chat: ' + JSON.stringify(seen).slice(0, 200));
      A.ok(seen.some(t => t.indexOf('the overnight brief is ready') >= 0),
        'while the earlier approved message is still there (the read is non-destructive)');
    }

    /* ---- 5. oversized text is refused whole, never silently clipped and reported as sent ------------- */
    {
      const before = await sentTo(B, headers, DEV_CHAT);
      const events = await runWithConsent(B, headers, 'send too much', () => 'once');
      const r = lastResult(events);
      A.ok(r && r.payload.isError, 'an oversized channel.send is refused instead of reporting a partial message as sent');
      const after = await sentTo(B, headers, DEV_CHAT);
      A.eq(after.length, before.length, 'an oversized send delivers ZERO chunks — no silent 8,000-character prefix');
      A.ok(!after.some(t => t.indexOf('tail-marker') >= 0), 'the rejected tail marker never reached the chat');
    }

    /* ---- 6. an agent cannot dial a target nobody opened --------------------------------------------- */
    {
      const events = await runWithConsent(B, headers, 'message a stranger', () => 'once');
      const r = lastResult(events);
      A.ok(r && r.payload.isError, 'an arbitrary chat id is refused (exact wording pinned in comms-tools.test.js)');
      const seen = await sentTo(B, headers, DEV_CHAT);
      A.ok(!seen.some(t => t.indexOf('exfiltrate this') >= 0),
        'the exfiltration text went nowhere — not even to the one chat this station CAN reach');
    }
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('comms-send.e2e.test');
})().catch(e => { console.log('FAIL: comms-send.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
