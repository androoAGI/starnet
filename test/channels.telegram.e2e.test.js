/* node test/channels.telegram.e2e.test.js - true sidecar proof for Telegram ingress.

   Boots the actual sidecar process with a fake Telegram Bot API and fake OpenRouter.
   A direct message enters through getUpdates, drives the real runOnce host, replies via
   sendMessage, mirrors lifecycle to SSE, and persists the headless transcript. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* The Telegram transport sends parse_mode:'HTML' (channels/telegram.format.js), so the WIRE text carries tags
   and entities while the phone renders plain prose. Every assertion about what the member READS must therefore
   run on the rendered form — otherwise "WEB & BROWSER" fails against the perfectly correct "WEB &amp; BROWSER".
   Decoding &amp; LAST is deliberate: doing it first would turn "&amp;lt;" into "<". */
function rendered(wireText) {
  return String(wireText == null ? '' : wireText)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

function startMockOpenRouter() {
  const requests = [];
  // gate lets the snapshot test HOLD a completion in-flight: when armed, the handler writes the first delta (so
  // agent.run.start has fired and the hub run is registered in inflight) then AWAITS release() before the finishing
  // chunk. Default = not armed (instant reply) so every other flow is unchanged. `started` resolves when a held
  // completion has emitted its first delta — the point at which the run is provably in-flight.
  const gate = { armed: false, _release: null, _startedResolve: null, started: null };
  gate.arm = () => { gate.armed = true; gate.started = new Promise(r => { gate._startedResolve = r; }); };
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
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          /* ONE scripted tool call, so a run can ask the harness what it can actually reach (channel.targets has
             no HTTP surface of its own). Only on the FIRST turn of such a run — once a tool result is in the
             messages the model answers plainly, or the run would loop forever. */
          const msgs = (parsed && parsed.messages) || [];
          const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
          const parityTask = /delegate telegram parity/i.test(String((lastUser && lastUser.content) || ''));
          const parityWorker = /return worker parity proof/i.test(String((lastUser && lastUser.content) || ''));
          if (parityTask) {
            const lastUserIndex = msgs.lastIndexOf(lastUser);
            const currentTools = msgs.slice(lastUserIndex + 1).filter(m => m && m.role === 'tool');
            const hasResult = currentTools.some(m => /WORKER_PARITY_OK/.test(JSON.stringify(m)));
            if (!hasResult) {
              const settle = currentTools.length === 0;
              const name = settle ? 'brief_proceed' : 'team_dispatch';
              const args = settle ? { objective: 'Delegate the parity task to the named specialist' }
                : { workers: [{ agentId: 'parity_worker', prompt: 'Return worker parity proof: WORKER_PARITY_OK' }] };
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'parity_' + currentTools.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
              res.end('data: [DONE]\n\n');
              return;
            }
          }
          if (/run telegram shell proof/i.test(String((lastUser && lastUser.content) || '')) && !msgs.some(m => m && m.role === 'tool')) {
            // A task-shaped request first settles the same Task Brief that a desktop run settles. This proves
            // owner parity through the genuine task pipeline rather than bypassing unrelated task semantics.
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_brief', type: 'function', function: { name: 'brief_proceed', arguments: '{"objective":"Run the requested Telegram shell proof"}' } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          if (/run telegram shell proof/i.test(String((lastUser && lastUser.content) || '')) && msgs.some(m => m && m.role === 'tool')
              && !msgs.some(m => m && m.role === 'tool' && /TELEGRAM_SHELL_OK/.test(JSON.stringify(m)))) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_shell', type: 'function', function: { name: 'shell_exec', arguments: '{"cmd":"echo TELEGRAM_SHELL_OK"}' } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          if (/who can you reach/i.test(String((lastUser && lastUser.content) || '')) && !msgs.some(m => m && m.role === 'tool')) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_t', type: 'function', function: { name: 'channel.targets', arguments: '{}' } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          const answer = parityWorker ? 'WORKER_PARITY_OK' : parityTask ? 'DELEGATION_PARITY_DONE' : 'Telegram answer';
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\n\n');
          if (gate.armed) {
            gate.armed = false;   // hold only the FIRST completion after arming
            await new Promise(r => { gate._release = r; if (gate._startedResolve) gate._startedResolve(); });
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
  const calls = [];
  const sends = [];
  const queued = [];
  const waiters = [];
  let updateId = 1000;
  let messageId = 2000;
  let fatal = false;
  let transientPollFailures = 0;
  let succeedNextPoll = false;

  function respond(res, obj) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    } catch (_) {}
  }

  function flush() {
    while (queued.length && waiters.length) {
      const w = waiters.shift();
      respond(w.res, { ok: true, result: [queued.shift()] });
    }
  }

  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop();
      const body = await readJsonBody(req);
      calls.push({ method, body });

      if (method === 'deleteWebhook') {
        respond(res, { ok: true, result: true });
        return;
      }
      if (method === 'getUpdates') {
        // REVOKED TOKEN. 401 is fatal in channels/adapter.js: it reports { state:'error' } and BREAKS the poll
        // loop, leaving the module-level handle alive — which is exactly the state that used to be reported to
        // an agent as "reachable now".
        if (fatal) { respond(res, { ok: false, error_code: 401, description: 'Unauthorized' }); return; }
        if (transientPollFailures > 0) {
          transientPollFailures--;
          respond(res, { ok: false, error_code: 503, description: 'temporary upstream reset' });
          return;
        }
        if (succeedNextPoll) { succeedNextPoll = false; respond(res, { ok: true, result: [] }); return; }
        if (body.offset === -1) {
          respond(res, { ok: true, result: [] });
          return;
        }
        if (queued.length) {
          respond(res, { ok: true, result: [queued.shift()] });
          return;
        }
        const waiter = { res };
        waiters.push(waiter);
        req.on('close', () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
        });
        return;
      }
      if (method === 'sendMessage') {
        sends.push(body);
        respond(res, { ok: true, result: { message_id: ++messageId } });
        return;
      }
      respond(res, { ok: false, error_code: 404, description: 'unknown method' });
    });
    server.listen(0, HOST, () => {
      resolve({
        calls,
        sends,
        base: 'http://' + HOST + ':' + server.address().port,
        pushText(chatId, userId, text) {
          queued.push({
            update_id: ++updateId,
            message: {
              message_id: ++messageId,
              date: Math.floor(Date.now() / 1000),
              chat: { id: chatId, type: 'private' },
              from: { id: userId, username: 'commander' },
              text
            }
          });
          flush();
        },
        revokeToken() { fatal = true; while (waiters.length) respond(waiters.shift().res, { ok: false, error_code: 401, description: 'Unauthorized' }); },
        failPolls(count) {
          transientPollFailures = Math.max(0, Number(count) || 0);
          while (waiters.length && transientPollFailures > 0) {
            transientPollFailures--;
            respond(waiters.shift().res, { ok: false, error_code: 503, description: 'temporary upstream reset' });
          }
        },
        recoverPoll() {
          if (waiters.length) while (waiters.length) respond(waiters.shift().res, { ok: true, result: [] });
          else succeedNextPoll = true;
        },
        close(done) {
          while (waiters.length) respond(waiters.shift().res, { ok: true, result: [] });
          server.close(done || (() => {}));
        }
      });
    });
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
      else if (!settled && /EADDRINUSE|Port \d+ is already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port; sidecar output:\n' + out));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function startSseCollector(url) {
  const ac = new AbortController();
  const events = [];
  const waiters = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'SSE feed opens with token');
  const reader = res.body.getReader();
  function notify() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      try {
        if (w.pred(events)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(events); }
      } catch (e) { waiters.splice(i, 1); clearTimeout(w.timer); w.reject(e); }
    }
  }
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
          if (!line || line[0] === ':') continue;
          if (line.indexOf('data:') === 0) {
            const raw = line.slice(5).trim();
            try { events.push(JSON.parse(raw)); notify(); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  })();
  return {
    events,
    waitFor(pred, ms, label) {
      if (pred(events)) return Promise.resolve(events);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
    close() { try { ac.abort(); } catch (_) {} }
  };
}

async function waitUntil(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;   // await so an async predicate (e.g. a snapshot fetch) is honored, not truthy-Promise-passed
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegram();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-telegram-e2e-'));
  fs.writeFileSync(path.join(ws, 'usercommands.json'), JSON.stringify({ commands: [
    { name: 'telegramproof', type: 'exec', command: 'echo TELEGRAM_COMMAND_OK' }
  ] }));
  const env = {
    SKYNET_WORKSPACES: ws,
    STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base,
    STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-telegram-fake',
    STARNET_OPENROUTER_KEY: 'sk-or-v1-telegram-fake',
    SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    STARNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    SKYNET_TELEGRAM_API_BASE: tg.base,
    STARNET_TELEGRAM_API_BASE: tg.base
  };
  const live = await boot(await allocatePort(), env, 20);
  let child = live.child;
  const port = live.port;
  let B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    let token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    sse = await startSseCollector(B + '/api/channels/events?token=' + encodeURIComponent(token));

    await waitUntil(() => tg.calls.some(c => c.method === 'getUpdates' && c.body && c.body.offset === -1), 5000, 'telegram drop-pending poll');
    tg.recoverPoll();
    await sse.waitFor(events => events.some(e => e.name === 'channel.connect' && e.payload && e.payload.channel === 'telegram' && e.payload.state === 'up'), 5000, 'initial Telegram up proof');

    // A brief failure is retried silently; a sustained one is reported once and then self-heals without token
    // input or a connect call. Drive the REAL sidecar poll loop against the local Bot API fault seam.
    tg.failPolls(2);
    await sse.waitFor(events => events.some(e => e.name === 'channel.connect' && e.payload && e.payload.channel === 'telegram' && e.payload.state === 'down'), 7000, 'sustained Telegram outage');
    tg.recoverPoll();
    await sse.waitFor(events => events.filter(e => e.name === 'channel.connect' && e.payload && e.payload.channel === 'telegram' && e.payload.state === 'up').length >= 2, 7000, 'automatic Telegram recovery');
    A.eq(sse.events.filter(e => e.name === 'channel.connect' && e.payload && e.payload.channel === 'telegram' && e.payload.state === 'down').length, 1,
      'sustained poll fault emits one down state, not one alert per retry');
    // Telegram is deliberately no longer trust-on-first-DM. Enrol this test account through the same local,
    // authenticated pairing route a desktop owner uses, then prove the one-time code is consumed by Telegram
    // before asking it to run anything.
    const pair = await (await fetch(B + '/api/channels/telegram/owner/pair', {
      method: 'POST',
      headers: { 'X-StarNet-Token': token, Origin: B, 'Content-Type': 'application/json' },
      body: '{}'
    })).json();
    A.ok(pair && /^[-A-Z0-9]{11}$/.test(String(pair.code || '')), 'local owner pairing issued a one-time code');
    tg.pushText(4242, 99, '/pair ' + pair.code);
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '4242' && /Owner paired/i.test(String(s.text || ''))), 8000, 'Telegram owner-pair acknowledgement');

    const channelFile = path.join(ws, 'channels', 'secrets.json');
    const stationBeforeMalformed = fs.existsSync(channelFile) ? fs.readFileSync(channelFile, 'utf8') : null;
    const stationStatusBefore = await (await fetch(B + '/api/channels/telegram/status', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const stationBadDisconnect = await fetch(B + '/api/channels/telegram/disconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, body: '{bad'
    });
    A.eq(stationBadDisconnect.status, 400, 'malformed station Telegram disconnect -> 400');
    if (stationBeforeMalformed !== null) A.eq(fs.readFileSync(channelFile, 'utf8'), stationBeforeMalformed, 'malformed station disconnect leaves durable configuration byte-identical');
    const stationStatus = await (await fetch(B + '/api/channels/telegram/status', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.eq(stationStatus.connected, stationStatusBefore.connected, 'malformed station disconnect does not change the connected flag');
    A.eq(stationStatus.state, stationStatusBefore.state, 'malformed station disconnect does not change the poll state');
    tg.pushText(4242, 99, 'research AI trend now');

    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '4242' && String(s.text || '').indexOf('Telegram answer') >= 0), 8000, 'telegram sendMessage reply');
    const initialReply = tg.sends.find(s => String(s.chat_id) === '4242' && String(s.text || '').indexOf('Telegram answer') >= 0);
    A.eq(initialReply.chat_id, '4242', 'reply sent to the inbound chat');
    A.ok(String(initialReply.text || '').indexOf('Telegram answer') >= 0, 'reply text came from the mocked provider');
    A.ok(llm.requests.length >= 1, 'mock provider was called from Telegram ingress');

    await sse.waitFor(events => events.some(e => e.name === 'workitem.placed' && e.payload && e.payload.kind === 'telegram' && e.payload.agentId === 'tg_4242'), 5000, 'telegram workitem');
    await sse.waitFor(events => events.some(e => e.name === 'channel.inbound' && e.payload && e.payload.channel === 'telegram' && e.payload.chatId === '4242' && e.payload.agentId === 'tg_4242'), 5000, 'channel inbound');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'tg_4242' && e.payload.trigger === 'event'), 5000, 'SSE run start');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'tg_4242'), 5000, 'SSE run end');
    await sse.waitFor(events => events.some(e => e.name === 'channel.delivery' && e.payload && e.payload.channel === 'telegram' && e.payload.chatId === '4242' && e.payload.ok === true), 5000, 'channel delivery');

    const tr = await (await fetch(B + '/api/transcript?stream=global&agent=tg_4242&limit=20', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const turns = (tr && tr.turns) || [];
    A.ok(turns.some(t => t.role === 'user' && String(t.content || '').indexOf('research AI trend now') >= 0), 'transcript captured Telegram user turn');
    A.ok(turns.some(t => t.role === 'assistant' && String(t.content || '').indexOf('Telegram answer') >= 0), 'transcript captured Telegram assistant reply');

    // ---- authenticated owner DM: real agent shell execution + defined command execution ------------------
    const shellChat = 4244;
    const beforeShell = llm.requests.length;
    tg.pushText(shellChat, 99, 'run telegram shell proof');
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === String(shellChat) && String(s.text || '').indexOf('Telegram answer') >= 0), 8000, 'owner Telegram shell reply');
    const shellReqs = llm.requests.slice(beforeShell);
    const shellWire = ((shellReqs[0] && shellReqs[0].tools) || []).map(t => String((t && t.function && t.function.name) || (t && t.name) || ''));
    A.ok(shellWire.indexOf('shell_exec') >= 0, 'owner Telegram run advertises shell_exec to the provider');
    A.ok(shellWire.indexOf('verify_run') >= 0, 'owner Telegram run advertises verify_run to the provider');
    A.ok(shellWire.indexOf('spotify_play') >= 0, 'owner Telegram run advertises media control to the provider');
    A.ok(shellWire.indexOf('team_dispatch') >= 0, 'owner Telegram run advertises task delegation to the provider');
    const shellSystem = String((shellReqs[0].messages.find(m => m.role === 'system') || {}).content || '');
    A.ok(shellSystem.includes('[ORCHESTRATION]'), 'owner Telegram task receives the crew briefing for its advertised delegation tools');
    const shellToolMessages = shellReqs.flatMap(r => (r.messages || []).filter(m => m && m.role === 'tool'));
    A.ok(shellToolMessages.some(m => /TELEGRAM_SHELL_OK/.test(JSON.stringify(m))),
      'the shell output returns through the real tool loop before the agent replies: ' + JSON.stringify(shellToolMessages));

    // Same named lead and specialist through desktop and owner Telegram; a wire tool
    // alone is not proof that the worker ran or that its result reached the parent.
    const parityHeaders = () => ({ 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B });
    const parityRoster = await fetch(B + '/api/roster', { method: 'POST', headers: parityHeaders(), body: JSON.stringify({ agents: [
      { agentId: 'parity_lead', system: 'Lead parity crew', name: 'Parity Lead', model: 'test/model' },
      { agentId: 'parity_worker', system: 'Return the requested marker.', name: 'Parity Worker', model: 'test/model' }
    ] }) });
    A.eq(parityRoster.status, 200, 'parity lead and specialist roster saved');
    const checkParity = (start, label) => {
      const reqs = llm.requests.slice(start);
      const leads = reqs.filter(r => String((r.messages.find(m => m.role === 'system') || {}).content || '').includes('[ORCHESTRATION]'));
      A.ok(leads.some(r => String(r.messages[0].content).includes('Agent id: parity_lead')), label + ': the same saved lead identity handles the task');
      A.ok(leads.some(r => JSON.stringify(r.messages[0]).includes('parity_worker (Parity Worker)')), label + ': briefing names the saved specialist');
      A.ok(reqs.some(r => (r.messages || []).some(m => m.role === 'tool' && /WORKER_PARITY_OK/.test(JSON.stringify(m)))), label + ': worker result returned through the real tool loop');
      const worker = reqs.find(r => (r.messages || []).some(m => m.role === 'user' && /return worker parity proof/i.test(String(m.content))));
      A.ok(!!worker, label + ': specialist made a real provider call');
      A.ok(worker && !(worker.tools || []).some(t => t.function?.name === 'team_dispatch'), label + ': worker cannot recursively delegate');
      A.ok(worker && !String(worker.messages[0].content).includes('[ORCHESTRATION]'), label + ': worker gets no lead briefing');
    };
    const desktopStart = llm.requests.length;
    const desktopParity = await fetch(B + '/api/run', { method: 'POST', headers: parityHeaders(), signal: AbortSignal.timeout(30000), body: JSON.stringify({
      key: 'sk-or-v1-test', model: 'test/model', agentId: 'parity_lead', isTask: true,
      messages: [{ role: 'user', content: 'delegate telegram parity' }]
    }) });
    const parityReader = desktopParity.body.getReader(), parityDecoder = new TextDecoder();
    let desktopParityStream = '', parityBuffer = '', parityRunId = null;
    for (;;) {
      const { value, done } = await parityReader.read();
      if (done) break;
      const text = parityDecoder.decode(value, { stream: true });
      desktopParityStream += text; parityBuffer += text;
      let newline;
      while ((newline = parityBuffer.indexOf('\n')) >= 0) {
        const line = parityBuffer.slice(0, newline).trim(); parityBuffer = parityBuffer.slice(newline + 1);
        let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev.name === 'agent.run.start') parityRunId = ev.payload.runId;
        if (ev.name === 'permission.prompt') {
          const approved = await fetch(B + '/api/consent', { method: 'POST', headers: parityHeaders(),
            body: JSON.stringify({ runId: parityRunId, promptId: ev.payload.promptId, decision: 'once' }) });
          A.eq(approved.status, 200, 'desktop parity dispatch receives explicit test approval');
        }
      }
    }
    A.ok(desktopParityStream.includes('DELEGATION_PARITY_DONE'), 'desktop delegation completes');
    checkParity(desktopStart, 'desktop');
    tg.pushText(4246, 99, '/talk parity_lead');
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '4246'), 8000, 'Telegram lead binding');
    const telegramParity = async label => {
      const start = llm.requests.length, sent = tg.sends.length;
      tg.pushText(4246, 99, 'delegate telegram parity');
      await waitUntil(() => tg.sends.slice(sent).some(s => String(s.chat_id) === '4246' && /DELEGATION_PARITY_DONE/.test(String(s.text))), 15000, label);
      checkParity(start, label);
    };
    await telegramParity('owner Telegram');

    const proofChat = 4245;
    tg.pushText(proofChat, 99, '/telegramproof');
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === String(proofChat) && /TELEGRAM_COMMAND_OK/.test(String(s.text || ''))), 8000,
      'owner Commander-defined exec command');
    A.ok(tg.sends.some(s => String(s.chat_id) === String(proofChat) && /TELEGRAM_COMMAND_OK/.test(String(s.text || ''))),
      'a Commander-defined shell command runs over the admitted owner DM');

    // ---- /tools must describe the office this channel's runs ACTUALLY get -------------------------------
    // THE BUG (2026-07-28, reported off a v0.6.8 install): runSlashForChannel read `placed` ONLY from
    // router.stationFor(agentId), which is null for every agent NOT docked in a conveyor bay — i.e. essentially
    // every main agent. So /tools computed placed=[] and answered "This agent has no tools yet", while the very
    // same agent's Telegram RUNS were handed the full autonomous office all along. The readout lied about a
    // grant that was working. No routing plan is posted in this test, so stationFor is null here exactly as it
    // is on a real station — which is what makes this a true reproduction rather than a mocked one.
    const llmCallsBeforeTools = llm.requests.length;
    tg.pushText(7777, 99, '/tools');
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '7777'), 8000, '/tools reply to chat 7777');
    const toolsReply = rendered((tg.sends.find(s => String(s.chat_id) === '7777') || {}).text);
    A.ok(!/no tools yet/.test(toolsReply), '/tools over Telegram does NOT claim the agent has no tools');
    A.ok(/Tools for this agent/.test(toolsReply), '/tools returns the card, not the empty-state sentence');
    // the autonomous office (capability/office.js fullOffice) — the objects hub.js's runs resolve against.
    A.ok(/WEB & BROWSER/.test(toolsReply), '/tools lists WEB & BROWSER (dish is in the autonomous office)');
    A.ok(/FILE CABINET/.test(toolsReply), '/tools lists FILE CABINET (cabinet is in the autonomous office)');
    A.ok(/MEMORY NOTEBOOK/.test(toolsReply), '/tools lists MEMORY NOTEBOOK (notebook is in the autonomous office)');
    // An admitted owner DM extends the headless office with the same non-physical workbench and orchestration
    // objects the desktop Commander receives, so this card must agree with the provider wire above.
    const activeLines = toolsReply.split('\n').filter(l => l.indexOf('✓') === 0);
    A.ok(activeLines.some(l => /WORKBENCH/.test(l)), '/tools lists terminal authority for the admitted owner DM');
    A.ok(activeLines.some(l => /TASK DELEGATION/.test(l)), '/tools lists delegation authority for the admitted owner DM');
    // a slash command must not spend a model turn — it is answered by the registry, not the provider.
    A.eq(llm.requests.length, llmCallsBeforeTools, '/tools was answered by the registry without calling the provider');

    /* ---- "/start" is answered for FREE, not by the model ---------------------------------------------------
       Telegram shows a START button on every fresh chat and sends this literal text when it is pressed — the
       first thing a new member ever transmits. It was in no command table, so it fell through parseCommand as
       an ordinary message and SPENT A PAID MODEL RUN on an agent puzzling over the word "/start". Asserted
       through the real ingress, and the provider-call count is what proves it never reached the model. */
    const llmBeforeStart = llm.requests.length;
    tg.pushText(7778, 99, '/start');
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '7778'), 8000, '/start reply');
    const startReply = rendered((tg.sends.find(s => String(s.chat_id) === '7778') || {}).text);
    A.eq(llm.requests.length, llmBeforeStart, '/start is answered by the hub without spending a model turn');
    A.ok(/STARNET online/.test(startReply), '/start greets the newcomer instead of answering "/start" as a question');
    A.ok(/\/help/.test(startReply), '/start tells a first-time member what they can actually say');

    /* ---- /approvals ON must not COST the agent its office --------------------------------------------------
       THE BUG (2026-07-28, reported by a user off the v0.7.0 install that shipped the /tools fix above): the hub
       runs `surface: wantApprovals ? 'interactive' : 'autonomous'`, and runOnce fed that same word to
       composeOffice. `interactive` means THE MOAT — the floor is real, so the office starts COMPUTE-ONLY and the
       browser appends the agent's actually-placed props via extraObjects. A phone never sends extraObjects and
       has no floor at all, so turning on approve/deny buttons silently cut the chat from the 59-tool autonomous
       office to THREE tools (quest.update, station.inspect, tool.search) — while /tools, fixed just above to quote the autonomous
       office, went on describing the 59 the run no longer had. That is exactly the "/tools work and they don't"
       the user saw: the agent truthfully reported no web capability (its tool.search even answered "every tool
       you have been granted is already listed", which is only reachable with an EMPTY deferred set), and the
       readout truthfully described the grant the chat was supposed to have. Both halves honest, one of them fed
       by the wrong surface.
       ASSERTED AT THE WIRE. The tool list that reaches the PROVIDER is the only thing that proves what the model
       could actually call; a readout is what lied here in the first place. */
    const approvalsChat = 6161;
    tg.pushText(approvalsChat, 99, '/approvals on');
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === String(approvalsChat)), 8000, '/approvals on reply');
    const approvalsReply = String((tg.sends.find(s => String(s.chat_id) === String(approvalsChat)) || {}).text || '');
    A.ok(/buttons are ON/.test(approvalsReply), '/approvals on took effect for this chat (' + approvalsReply.slice(0, 80) + ')');

    const llmCallsBeforeApproved = llm.requests.length;
    tg.pushText(approvalsChat, 99, 'find me something on the web');
    // Reflection from an earlier run may reach the same mock provider concurrently. Bind this proof to the
    // request carrying THIS chat's exact user text instead of assuming the next array slot belongs to it.
    const approvedRequest = () => llm.requests.slice(llmCallsBeforeApproved).find(r =>
      ((r && r.messages) || []).some(m => m && m.role === 'user' && /find me something on the web/i.test(JSON.stringify(m.content || ''))));
    await waitUntil(() => !!approvedRequest(), 8000, 'approvals-ON run reached the provider');
    const approvedReq = approvedRequest();
    const advertised = ((approvedReq && approvedReq.tools) || [])
      .map(t => String((t && t.function && t.function.name) || (t && t.name) || ''));
    // NOTE: the wire spells a dotted tool with an underscore (fs.read -> fs_read), so these are the PROVIDER's
    // names, not the registry's. Asserting the registry spelling here would pass vacuously forever.
    const wire = advertised.join(' ');
    A.ok(advertised.indexOf('web_search') >= 0, 'an approvals-ON channel run still gets web_search (dish is in the headless office) — wire was: ' + wire);
    A.ok(advertised.indexOf('browser_navigate') >= 0, 'an approvals-ON channel run still gets the browser — the exact capability the user was told it lacked');
    A.ok(advertised.indexOf('fs_read') >= 0, 'an approvals-ON channel run still gets fs_read (cabinet is in the headless office)');
    A.ok(advertised.indexOf('notebook_write') >= 0, 'an approvals-ON channel run still gets notebook_write (notebook is in the headless office)');
    // The owner authority survives an approvals-on choice; buttons alter consent UX, not the control surface.
    A.ok(advertised.indexOf('shell_exec') >= 0, 'approvals ON retains the owner DM terminal');
    A.ok(advertised.indexOf('team_dispatch') >= 0, 'approvals ON retains the owner DM delegation tools');

    // Let that exact run settle before asking /tools. Under a loaded full-suite run, sending the slash command
    // while the model reply was still in flight let the generic "three sends" count wake on the late model
    // reply and inspect it as if it were the /tools card.
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === String(approvalsChat)
      && String(s.text || '').indexOf('Telegram answer') >= 0), 8000, 'approvals-ON model reply');

    // and the readout AGREES with that wire, which is the whole point of the pair of fixes.
    const sendsBeforeApprovedTools = tg.sends.filter(s => String(s.chat_id) === String(approvalsChat)).length;
    tg.pushText(approvalsChat, 99, '/tools');
    await waitUntil(() => tg.sends.filter(s => String(s.chat_id) === String(approvalsChat)).length > sendsBeforeApprovedTools, 8000, '/tools reply in the approvals-ON chat');
    const approvedTools = rendered((tg.sends.filter(s => String(s.chat_id) === String(approvalsChat)).pop() || {}).text);
    A.ok(/WEB & BROWSER/.test(approvedTools), '/tools in an approvals-ON chat lists the same WEB & BROWSER the run was handed');
    A.ok(!/no tools yet/.test(approvedTools), '/tools in an approvals-ON chat does not claim the agent has no tools');

    // ---- P1 1.2: a live channel run must appear in GET /api/state/snapshot so an SSE reconnect keeps its agent's
    // floor/HUD state (reconcileFromSnapshot clears any agent NOT listed). Drive a SECOND message on a fresh chat,
    // HOLD it in-flight via the mock gate, prove the snapshot lists it (attributed + sourced 'telegram'), then
    // release and prove it's gone once the run ends — exactly tracking the hub's inflight lifecycle. ----
    const snapshot = async () => {
      const r = await fetch(B + '/api/state/snapshot', { headers: { 'X-StarNet-Token': token, Origin: B } });
      A.eq(r.status, 200, 'GET /api/state/snapshot -> 200');
      return r.json();
    };
    // baseline: with the first run long settled, no channel run is listed.
    const base = await snapshot();
    A.ok(Array.isArray(base.runs) && !base.runs.some(x => x && x.agentId === 'tg_4243'), 'snapshot has no tg_4243 run before the second message');

    llm.gate.arm();                                  // the NEXT completion holds after its first delta
    tg.pushText(4243, 99, 'hold this run please');   // a fresh chat -> agentId tg_4243, its own run
    await llm.gate.started;                           // resolves once the held completion emitted its first delta (run is provably in-flight)
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'tg_4243'), 5000, 'second SSE run start');

    // WHILE HELD: the snapshot lists this live channel run, attributed to the acting agent and sourced 'telegram'.
    const during = await snapshot();
    const live = (during.runs || []).find(x => x && x.agentId === 'tg_4243');
    A.ok(!!live, 'a live Telegram hub run IS listed in the snapshot while in-flight');
    A.eq(live.source, 'telegram', "the channel run's source is 'telegram'");
    A.ok(typeof live.runId === 'string' && live.runId.length > 0, 'the listed channel run carries a runId');
    A.ok(typeof live.startedAt === 'number' && during.ts >= live.startedAt, "the run's startedAt is a real server timestamp (<= snapshot ts)");

    llm.gate.release();                              // let the held completion finish
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'tg_4243'), 5000, 'second SSE run end');
    // AFTER IT ENDS: the run drops out of the snapshot (inflight cleared in the hub's finally) — no phantom clock.
    await waitUntil(async () => { const s = await snapshot(); return !(s.runs || []).some(x => x && x.agentId === 'tg_4243'); }, 5000, 'tg_4243 run leaves the snapshot after it ends');

    // ---- P2 supersede race: a SECOND message to the SAME busy chat must NOT be silently dropped on the transient
    // "already running a task" refusal. Repro: HOLD run #1 for chat 5555 in-flight (slot held), then send message #2
    // to 5555 — the hub aborts #1 and immediately starts #2, which loses the same-agent workspace-mutex race in the
    // host (index.js concurrencyGate.inFlight>0) and is refused TRANSIENTLY. The hub must RETRY with backoff until
    // #1's aborted run releases the slot, then deliver #2's real answer — never the raw mutex refusal to the user. --
    const sendsToChatBefore = tg.sends.filter(s => String(s.chat_id) === '5555').length;
    A.eq(sendsToChatBefore, 0, 'no prior reply to chat 5555');

    llm.gate.arm();                                  // run #1 will HOLD after its first delta (keeps its slot)
    tg.pushText(5555, 99, 'first message — will be held and superseded');
    await llm.gate.started;                           // run #1 is provably in-flight (slot held) now
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'tg_5555'), 5000, 'run #1 start (tg_5555)');

    // SECOND message to the SAME chat: aborts #1, then races the still-held workspace slot -> transient refusal ->
    // the hub's bounded retry recovers once #1's abort frees the slot.
    tg.pushText(5555, 99, 'second message — should supersede and still get answered');

    // the user's SECOND message must EVENTUALLY get a real answer delivered to chat 5555 (the whole point of the fix).
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '5555' && String(s.text || '').indexOf('Telegram answer') >= 0), 12000, 'chat 5555 eventually gets the real answer for message #2');

    // TRUTHFUL TELEMETRY: the raw internal mutex message ("already running a task") must NEVER be delivered to the
    // user on ANY reply to chat 5555 — the fix converts that transient refusal into a retry (or, if it truly never
    // frees, an honest "still busy" reply), never a leaked internal string.
    const chat5555Replies = tg.sends.filter(s => String(s.chat_id) === '5555');
    A.ok(chat5555Replies.length >= 1, 'chat 5555 received at least one reply');
    A.ok(chat5555Replies.every(s => String(s.text || '').indexOf('already running a task') === -1), 'no reply to chat 5555 leaked the internal "already running a task" mutex message');

    // Prove the RETRY PATH actually engaged (not merely that the race happened not to fire): the transient
    // "already running a task" refusal is teed whole to the channels SSE feed (sse.js runTeeView), and it must be
    // FOLLOWED by a successful run.end for the same agent — i.e. the hub retried and recovered rather than giving up.
    const sawTransientRefusal = sse.events.some(e => e.name === 'agent.run.error' && e.payload
      && e.payload.agentId === 'tg_5555' && e.payload.transient === true
      && String(e.payload.message || '').indexOf('already running a task') >= 0);
    if (sawTransientRefusal) {
      await sse.waitFor(events => {
        // a run.end for tg_5555 that is NOT the aborted/error one: the recovered retry's clean finish.
        return events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'tg_5555' && e.payload.reason && e.payload.reason !== 'error');
      }, 8000, 'tg_5555 recovered with a successful run after the transient refusal (retry worked)');
      console.log('  · supersede race reproduced AND recovered (transient refusal -> retry -> real answer)');
    } else {
      // The race is timing-sensitive; if the slot happened to free before #2's admission, the message still got its
      // real answer above (the invariant that matters). Note it so the run log is honest about what was exercised.
      console.log('  · supersede race did not fire this run; #2 still delivered its real answer (invariant holds)');
    }
    /* ---- ONE CONNECT SURVIVES A PROCESS RESTART -----------------------------------------------------
       Remove BOTH token env aliases before reboot. The only possible source is the durable channel record the
       first process wrote. A successful poll and configured+durable status prove the user is not asked again. */
    if (sse) { sse.close(); sse = null; }
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      try { child.kill(); } catch (_) { resolve(); }
    });
    const pollsBeforeRestart = tg.calls.filter(c => c.method === 'getUpdates').length;
    const restartEnv = Object.assign({}, env);
    delete restartEnv.SKYNET_TELEGRAM_TOKEN;
    delete restartEnv.STARNET_TELEGRAM_TOKEN;
    // Concurrent suites can claim the old address during shutdown. This proves
    // credential persistence in the same workspace, independently of its HTTP port.
    const restarted = await boot(await allocatePort(), restartEnv, 20);
    child = restarted.child;
    B = 'http://' + HOST + ':' + restarted.port;
    token = await bootToken(B, B);
    await waitUntil(() => tg.calls.filter(c => c.method === 'getUpdates').length >= pollsBeforeRestart + 2, 7000, 'saved Telegram auto-start after restart');
    tg.pushText(9898, 99, '/start');   // a real post-restart update proves the restored poller can receive
    tg.recoverPoll();                  // also release any stale long-poll socket left by the killed process
    let restartStatusSeen = null;
    try {
      await waitUntil(async () => {
        restartStatusSeen = await (await fetch(B + '/api/channels/telegram/status', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
        return restartStatusSeen && restartStatusSeen.connected === true && restartStatusSeen.state === 'up';
      }, 7000, 'saved Telegram status up after restart');
    } catch (e) {
      e.message += ': ' + JSON.stringify(restartStatusSeen);
      throw e;
    }
    const restartedStatus = await (await fetch(B + '/api/channels/telegram/status', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.eq(restartedStatus.configured, true, 'restart resolves the saved Telegram token without user input');
    A.eq(restartedStatus.durable, true, 'restart reports the saved Telegram token has a durable home');
    await telegramParity('owner Telegram after restart');

    /* ---- REACHABILITY IS A HEARTBEAT, NOT A HANDLE -------------------------------------------------
       listTargets derived `connected` from the mere existence of the composition-root handle, and that handle
       is nulled ONLY by an explicit teardown (start / shutdown / the disconnect route). A revoked token is
       fatal in adapter.js: it reports { state:'error' } and BREAKS the poll loop, leaving the object alive. So
       the CHANNELS panel showed the channel errored while an agent asking "can you reach me on Telegram?" was
       told "1 of 1 known chat(s) reachable now" — and channel.send's own honest refusal was unreachable.
       Driven over /api/run because channel.targets has no HTTP surface of its own. */
    {
      const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
      const runTargets = async () => {
        const res = await fetch(B + '/api/run', {
          method: 'POST', headers,
          body: JSON.stringify({
            model: 'test/model', provider: 'openrouter', agentId: 'agent',
            messages: [{ role: 'user', content: 'who can you reach' }],
            placed: [{ objectType: 'dish' }, { objectType: 'computer' }]
          })
        });
        A.eq(res.status, 200, 'the targets run stream opens');
        const reader = res.body.getReader(); const dec = new TextDecoder();
        let buf = '', last = null, runId = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
            if (ev.name === 'agent.run.start') runId = ev.payload && ev.payload.runId;
            if (ev.name === 'agent.tool_result') last = ev.payload;
            // Fire-and-forget: the run is BLOCKED on this answer, so awaiting here deadlocks.
            if (ev.name === 'permission.prompt') {
              fetch(B + '/api/consent', {
                method: 'POST', headers,
                body: JSON.stringify({ runId: runId, promptId: ev.payload.promptId, decision: 'once' })
              }).catch(() => {});
            }
          }
        }
        return last;
      };

      // Control: the token still works and a human really has messaged this station, so the chat IS reachable.
      const up = await runTargets();
      A.ok(up && /reachable now/.test(String(up.summary || '')), 'while the token works the chat is reported reachable: ' + (up && up.summary));
      A.ok(!/0 of/.test(String(up.summary || '')), 'and not as zero-of-N');

      // Now revoke the token, exactly as @BotFather would.
      tg.revokeToken();
      await waitUntil(async () => {
        const st = await (await fetch(B + '/api/channels/status', { headers })).json();
        const t = (st && (st.telegram || (st.channels || []).find(c => c && c.id === 'telegram'))) || {};
        return t.state === 'error' || t.connected === false;
      }, 12000, 'the sidecar noticed the revoked token (status error)');

      const st = await (await fetch(B + '/api/channels/status', { headers })).json();
      const tstat = (st && (st.telegram || (st.channels || []).find(c => c && c.id === 'telegram'))) || {};
      A.eq(!!tstat.connected, false, 'GET /api/channels/status honestly reports the channel as not connected');

      const down = await runTargets();
      A.ok(down, 'channel.targets still answers after the token was revoked');
      // "N of N reachable" for any nonzero N is the lie — assert on the SHAPE, not on one chat count, or the
      // assertion goes vacuous the moment the fixture holds a different number of chats.
      const claimsAllReachable = /(\d+) of (\d+) known chat/.exec(String(down.summary || ''));
      A.ok(!(claimsAllReachable && claimsAllReachable[1] !== '0'),
        'an ERRORED channel is NOT counted as reachable to the agent: ' + (down && down.summary));
      A.ok(/0 of|not connected|none reachable/i.test(String(down.summary || '')),
        'and the readout says so plainly: ' + (down && down.summary));
    }
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => tg.close(resolve));
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('channels.telegram.e2e.test');
})().catch(e => { console.log('FAIL: channels.telegram.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
