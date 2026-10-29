/* node test/channels.telegram.botchain.e2e.test.js - a PER-AGENT Telegram bot advances the work line.

   Surface-parity proof (2026-08-04): the same drawn floor must do the same work whichever surface carries
   the message. The station bot, cron and COMMS all ran the belts drawn past a dock, but the per-agent bot
   hub shipped without the chain seam — a DM to a dedicated agent bot ran ONE stage while the identical
   message through the station bot ran the whole line. This boots the real sidecar with a token-aware fake
   Bot API + fake OpenRouter (multibot e2e pattern), adds one agent-bound bot, deploys a two-stage floor
   (research-agent -> writer-agent), DMs the bot, and proves the downstream stage really ran: two provider
   calls, the handoff prompt carried the upstream output, the reply delivered is the LAST stage's, and the
   hop persisted under the downstream agent's own channel history. The hard-lock stays intact: stage ONE is
   the bound agent, never a floor-rerouted one. */
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
function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

/* fake OpenRouter that tells the two stages apart: a request whose latest user turn is the PIPELINE
   HANDOFF is the downstream stage and answers differently — so the reply text proves WHICH stage spoke. */
function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [
          { id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
          { id: 'writer/distinct-model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }
        ] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = {}; try { parsed = JSON.parse(body); } catch (_) {}
          requests.push(parsed);
          const isHandoff = (parsed.messages || []).some(m => m && m.role === 'user' && String(m.content || '').indexOf('PIPELINE HANDOFF') >= 0);
          const text = isHandoff ? 'Final line answer' : 'Stage one findings';
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
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

// token-aware fake Bot API (multibot e2e pattern, trimmed to what this proof needs)
function startMockTelegramMulti(bots) {
  const perToken = {};
  for (const t of Object.keys(bots)) perToken[t] = { calls: [], sends: [], actions: [], queued: [], waiters: [] };
  let updateId = 1000, messageId = 2000;
  function respond(res, obj) { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {} }
  function flush(st) {
    while (st.queued.length && st.waiters.length) respond(st.waiters.shift().res, { ok: true, result: [st.queued.shift()] });
  }
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      const m = /^\/bot([^/]+)\/([^/?]+)/.exec(String(req.url || ''));
      if (!m) { res.writeHead(404); res.end(); return; }
      const token = m[1], method = m[2];
      const body = await readJsonBody(req);
      const known = bots[token];
      if (!known) { respond(res, { ok: false, error_code: 401, description: 'Unauthorized' }); return; }
      const st = perToken[token];
      st.calls.push({ method, body });
      if (method === 'getMe') { respond(res, { ok: true, result: { id: known.id, is_bot: true, first_name: known.username + ' Bot', username: known.username } }); return; }
      if (method === 'deleteWebhook') { respond(res, { ok: true, result: true }); return; }
      if (method === 'sendChatAction') { st.actions.push(body); respond(res, { ok: true, result: true }); return; }
      if (method === 'sendMessage') { st.sends.push(body); respond(res, { ok: true, result: { message_id: ++messageId } }); return; }
      if (method === 'getUpdates') {
        if (body.offset === -1) { respond(res, { ok: true, result: [] }); return; }
        if (st.queued.length) { respond(res, { ok: true, result: [st.queued.shift()] }); return; }
        const waiter = { res };
        st.waiters.push(waiter);
        const timer = setTimeout(() => { const i = st.waiters.indexOf(waiter); if (i >= 0) { st.waiters.splice(i, 1); respond(res, { ok: true, result: [] }); } }, 400);
        req.on('close', () => { clearTimeout(timer); const i = st.waiters.indexOf(waiter); if (i >= 0) st.waiters.splice(i, 1); });
        return;
      }
      respond(res, { ok: false, error_code: 404, description: 'unknown method' });
    });
    server.listen(0, HOST, () => resolve({
      perToken,
      base: 'http://' + HOST + ':' + server.address().port,
      pushText(token, chatId, userId, text) {
        const st = perToken[token];
        st.queued.push({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text } });
        flush(st);
      },
      close(done) {
        for (const t of Object.keys(perToken)) while (perToken[t].waiters.length) respond(perToken[t].waiters.shift().res, { ok: true, result: [] });
        server.close(done || (() => {}));
      }
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

async function waitUntil(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + label);
}

const STATION = 'STATIONTOKEN', TOK_A = 'TOKCHAIN';

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegramMulti({
    [STATION]: { id: 100, username: 'StationBot' },
    [TOK_A]: { id: 333, username: 'ResearchBot' }
  });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tg-botchain-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-botchain-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-botchain-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: STATION, STARNET_TELEGRAM_TOKEN: STATION,
    SKYNET_TELEGRAM_API_BASE: tg.base, STARNET_TELEGRAM_API_BASE: tg.base
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const api = (method, url, body) => fetch(B + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));

    const roster = await api('POST', '/api/roster', { agents: [
      { agentId: 'research-agent', name: 'RESEARCH', model: 'test/model', provider: 'openrouter', reasoningEffort: 'low' },
      { agentId: 'writer-agent', name: 'WRITER', model: 'writer/distinct-model', provider: 'openrouter', reasoningEffort: 'high' }
    ], updatedAt: Date.now() });
    A.eq(roster.status, 200, 'the two agents have distinct live roster identities');

    // ---- 1. add the agent-bound bot and enroll its owner (multibot pattern) ----
    const add = await api('POST', '/api/channels/telegram/bots/connect', { token: TOK_A, agentId: 'research-agent', agentName: 'RESEARCH', model: 'test/model' });
    A.eq(add.status, 200, 'agent bot added');
    A.eq(add.j.botId, '333', 'bot keyed by its getMe id');
    await waitUntil(() => tg.perToken[TOK_A].calls.some(c => c.method === 'getUpdates'), 5000, 'agent bot polls');
    const pair = await api('POST', '/api/channels/telegram/bots/333/owner/pair', {});
    A.eq(pair.status, 200, 'owner pairing code issued');
    tg.pushText(TOK_A, 900, 77, '/pair ' + pair.j.code);
    await waitUntil(() => tg.perToken[TOK_A].sends.some(s => String(s.chat_id) === '900' && /Owner paired/i.test(String(s.text || ''))), 8000, 'owner paired');

    // ---- 2. deploy a two-stage floor: research-agent (the bot's bound agent) chains into writer-agent ----
    const Pipeline = require('../frontend/app/pipeline.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' },
              { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    });
    A.eq(plan.chains['research-agent'].next, ['writer-agent'], 'the drawn floor chains the two docks');
    for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];
    const posted = await api('POST', '/api/routing', plan);
    A.eq(posted.status, 200, 'the two-stage floor deploys');

    // ---- 3. DM the AGENT BOT: the whole line must run, and the reply must be the LAST stage's ----
    const callsBefore = llm.requests.length;
    tg.pushText(TOK_A, 900, 77, 'research the market and hand it down the line');
    await waitUntil(() => tg.perToken[TOK_A].sends.some(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Final line answer') >= 0), 15000, 'the bot delivers the DOWNSTREAM stage\'s answer');
    A.ok(llm.requests.length >= callsBefore + 2, 'two provider calls — the line really bought both runs');
    const handoffReq = llm.requests.slice(callsBefore).find(r => (r.messages || []).some(m => m && m.role === 'user' && String(m.content || '').indexOf('PIPELINE HANDOFF') >= 0));
    A.ok(handoffReq, 'the downstream stage was handed the PIPELINE HANDOFF turn');
    A.eq(handoffReq.model, 'writer/distinct-model', 'the downstream hop uses the target agent\'s roster model');
    const handoffTurn = (handoffReq.messages || []).map(m => String((m && m.content) || '')).find(c => c.indexOf('PIPELINE HANDOFF') >= 0) || '';
    A.ok(handoffTurn.indexOf('research-agent') >= 0, 'the handoff names the upstream stage (the bot\'s bound agent — the hard-lock held)');
    A.ok(handoffTurn.indexOf('Stage one findings') >= 0, 'the handoff carries the upstream OUTPUT, not the raw DM');

    // ---- 4. the hop persisted under the DOWNSTREAM agent's own channel history ----
    const chanHist = (agentId) => {
      try { return (JSON.parse(fs.readFileSync(path.join(ws, 'channels', agentId + '.history.json'), 'utf8')).messages || []); }
      catch (_) { return []; }
    };
    A.ok(chanHist('research-agent').some(t => t.role === 'user' && String(t.content || '').indexOf('research the market') >= 0), 'stage one (the bound agent) owns the DM turn');
    // sec-taint 09-25: a hop's history is keyed by THIS chat's line lineage (hop_<digest>), never the downstream
    // agent's shared file — so another chat of writer-agent can never replay this chat's handoff
    const hopFiles = fs.readdirSync(path.join(ws, 'channels')).filter(f => /^hop_[0-9a-f]{32}\.history\.json$/.test(f)).map(f => f.replace(/\.history\.json$/, ''));
    const hopHist = [].concat(...hopFiles.map(chanHist));
    A.ok(hopHist.some(t => t.role === 'user' && String(t.content || '').indexOf('PIPELINE HANDOFF') >= 0), 'the downstream stage owns its handoff turn (per-chat hop history)');
    A.ok(hopHist.some(t => t.role === 'assistant' && String(t.content || '').indexOf('Final line answer') >= 0), 'the downstream stage owns its answer (per-chat hop history)');
    A.ok(!chanHist('writer-agent').some(t => String(t.content || '').indexOf('PIPELINE HANDOFF') >= 0), 'the handoff never lands in the downstream agent\'s SHARED history');
  } finally {
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => tg.close(resolve));
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('channels.telegram.botchain.e2e.test');
})().catch(e => { console.log('FAIL: channels.telegram.botchain.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
