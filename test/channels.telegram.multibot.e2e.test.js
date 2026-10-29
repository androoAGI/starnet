/* node test/channels.telegram.multibot.e2e.test.js - true sidecar proof for MULTI-BOT Telegram.

   Boots the actual sidecar with a TOKEN-AWARE fake Bot API (each /bot<TOKEN>/<method> is a separate bot
   with its own getMe identity, update queue and send log) plus a fake OpenRouter. Drives the REAL routes:
   a bad token is refused by the getMe probe, two extra bots are added and poll side by side with the
   station bot, each DM runs the bound agent (hard-lock) and replies + typing-indicates through its OWN
   token only, per-bot owner claim refuses a stranger, and disconnect stops exactly that bot's poller. */
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

function startMockOpenRouter() {
  return new Promise(resolve => {
    const calls = [];
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch (_) {}
          calls.push({ model: parsed.model || '', authorization: String(req.headers.authorization || '') });
          if (parsed.model === 'reject/model') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provided OAuth credential is invalid', code: 'invalid_api_key' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Bound answer begins with enough unstable partial text to exceed the old streaming threshold. ' } }] }) + '\n\n');
          setTimeout(() => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'This final sentence must arrive in the same completed Telegram message.' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 80);
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, calls, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// token-aware fake Bot API: bots = { TOKEN: { id, username } }. Unknown token -> 401 (like real Telegram).
function startMockTelegramMulti(bots) {
  const perToken = {};   // TOKEN -> { calls, sends, edits, actions, queued, waiters }
  for (const t of Object.keys(bots)) perToken[t] = { calls: [], sends: [], edits: [], actions: [], queued: [], waiters: [] };
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
      if (method === 'editMessageText') { st.edits.push(body); respond(res, { ok: true, result: { message_id: body.message_id } }); return; }
      if (method === 'deleteMessage' || method === 'setMessageReaction') { respond(res, { ok: true, result: true }); return; }
      if (method === 'getUpdates') {
        if (body.offset === -1) { respond(res, { ok: true, result: [] }); return; }
        if (st.queued.length) { respond(res, { ok: true, result: [st.queued.shift()] }); return; }
        // park like the real long-poll, but resolve EMPTY after a short timeout (the real API returns [] after
        // `timeout` seconds) — the adapter's honest-connect needs a completed round-trip to prove 'up'.
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
      // a GROUP message: a leading /command or an @mention carries the entity Telegram would attach
      pushGroup(token, chatId, userId, text) {
        const st = perToken[token];
        const msg = { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'supergroup', title: 'Crew' }, from: { id: userId, is_bot: false, username: 'u' + userId }, text };
        const at = text.indexOf('@');
        if (text[0] === '/') msg.entities = [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }];
        else if (at >= 0) msg.entities = [{ type: 'mention', offset: at, length: text.slice(at).split(/\s/)[0].length }];
        st.queued.push({ update_id: ++updateId, message: msg });
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

const STATION = 'STATIONTOKEN', TOK_A = 'TOKAAA', TOK_B = 'TOKBBB';

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegramMulti({
    [STATION]: { id: 100, username: 'StationBot' },
    [TOK_A]: { id: 111, username: 'NovaBot' },
    [TOK_B]: { id: 222, username: 'ScoutBot' }
  });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tg-multibot-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-multibot-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-multibot-fake',
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

    // Agent bots are roster identities. Give the sidecar two runnable agents plus one deliberately rejected model;
    // setup must use these records even when the caller submits a different globally focused provider/model.
    const roster = await api('POST', '/api/roster', { updatedAt: Date.now(), agents: [
      { agentId: 'agent', name: 'NOVA', system: 'nova system', model: 'test/model', provider: 'openrouter' },
      { agentId: 'scout_1', name: 'SCOUT', system: 'scout system', model: 'test/model', provider: 'openrouter' },
      { agentId: 'bad_agent', name: 'BROKEN', system: 'broken system', model: 'reject/model', provider: 'openrouter' }
    ] });
    A.eq(roster.status, 200, 'test roster synchronized before agent-bot setup');

    // station bot polling (auto-started from env)
    await waitUntil(() => tg.perToken[STATION].calls.some(c => c.method === 'getUpdates'), 5000, 'station bot polls');

    // ---- 1. bad token: the getMe probe refuses it with a clean 400; nothing persists ----
    const bad = await api('POST', '/api/channels/telegram/bots/connect', { token: 'NOTREAL', agentId: 'agent', model: 'test/model' });
    A.eq(bad.status, 400, 'unknown token -> 400');
    A.ok(/Telegram rejected/.test(bad.j.error || ''), 'refusal names the getMe failure');

    // ---- 2. the station bot token cannot double as an agent bot (one poller per token) ----
    const dupe = await api('POST', '/api/channels/telegram/bots/connect', { token: STATION, agentId: 'agent', model: 'test/model' });
    A.eq(dupe.status, 400, 'station token as agent bot -> 400');
    A.ok(/station bot/.test(dupe.j.error || ''), 'refusal explains it IS the station bot');

    // ---- 2b. a valid Telegram token with a broken bound-agent credential/model fails BEFORE persistence ----
    const badProvider = await api('POST', '/api/channels/telegram/bots/connect', { token: TOK_A, agentId: 'bad_agent', provider: 'openrouter', model: 'wrong/global-model' });
    A.eq(badProvider.status, 400, 'agent provider/model authentication failure is a setup error');
    A.ok(/agent provider\/model check failed.*Provided OAuth credential is invalid/i.test(badProvider.j.error || ''), 'setup names the bound-agent authentication failure immediately');
    const afterBadProvider = (await api('GET', '/api/channels/telegram/status')).j;
    A.eq((afterBadProvider.bots || []).length, 0, 'failed agent-model proof persists no bot record and starts no poller');

    // ---- 3. add TWO agent bots; each starts polling with its OWN token ----
    const addA = await api('POST', '/api/channels/telegram/bots/connect', {
      token: TOK_A, agentId: 'agent', agentName: 'WRONG CLIENT NAME', provider: 'codex', model: 'wrong/global-model'
    });
    A.eq(addA.status, 200, 'bot A added');
    A.eq(addA.j.botId, '111', 'bot A keyed by its getMe id');
    A.eq(addA.j.username, 'NovaBot', 'bot A username surfaced');
    A.eq(addA.j.pairingRequired, true, 'bot A add response says owner pairing is still required');
    A.ok(/^[-A-Z0-9]{11}$/.test(String(addA.j.pairingCode || '')), 'bot A add response immediately carries its pairing command');
    A.ok(addA.j.providerVerified === true && addA.j.provider === 'openrouter' && addA.j.model === 'test/model', 'backend ignores stale focused config and proves the bound roster agent tuple');
    const addB = await api('POST', '/api/channels/telegram/bots/connect', { token: TOK_B, agentId: 'scout_1', agentName: 'SCOUT', model: 'test/model' });
    A.eq(addB.status, 200, 'bot B added');
    A.eq(addB.j.botId, '222', 'bot B keyed by its getMe id');
    A.eq(addB.j.pairingRequired, true, 'bot B add response says owner pairing is still required');
    A.ok(/^[-A-Z0-9]{11}$/.test(String(addB.j.pairingCode || '')), 'bot B add response immediately carries its pairing command');
    await waitUntil(() => tg.perToken[TOK_A].calls.some(c => c.method === 'getUpdates'), 5000, 'bot A polls');
    await waitUntil(() => tg.perToken[TOK_B].calls.some(c => c.method === 'getUpdates'), 5000, 'bot B polls');

    // status: both listed, connected (first poll round-trip proves 'up')
    await waitUntil(async () => {
      const st = (await api('GET', '/api/channels/telegram/status')).j;
      const bots = st.bots || [];
      return bots.length === 2 && bots.every(b => b.connected === true);
    }, 5000, 'both bots CONNECTED in status');

    // Polling is not DM readiness: an ordinary pre-pair DM is intentionally silent, but the add response already
    // gave the Commander the exact enrollment command instead of leaving them to discover a second control.
    const prePairSends = tg.perToken[TOK_A].sends.length;
    tg.pushText(TOK_A, 900, 77, 'why are you not answering?');
    await sleep(1200);
    A.eq(tg.perToken[TOK_A].sends.length, prePairSends, 'ordinary pre-pair DM is refused before model work or delivery');

    // Each bot has its own explicit local-to-Telegram owner enrollment. First DM is not authority.
    const pairBot = async (botId, botToken, pairingCode) => {
      tg.pushText(botToken, 900, 77, '/pair ' + pairingCode);
      await waitUntil(() => tg.perToken[botToken].sends.some(s => String(s.chat_id) === '900' && /Owner paired/i.test(String(s.text || ''))), 8000, 'bot ' + botId + ' pairing acknowledgement');
    };
    await pairBot('111', TOK_A, addA.j.pairingCode);
    // The explicit PAIR button remains the recovery path for an expired/lost command and rotates it safely.
    const repairB = await api('POST', '/api/channels/telegram/bots/222/owner/pair', {});
    A.eq(repairB.status, 200, 'bot B can rotate its automatically issued code through the recovery route');
    A.ok(/^[-A-Z0-9]{11}$/.test(String(repairB.j.code || '')), 'bot B recovery pairing code shape');
    await pairBot('222', TOK_B, repairB.j.code);
    const botBSendsBeforeA = tg.perToken[TOK_B].sends.length;
    const stationSendsBeforeA = tg.perToken[STATION].sends.length;

    // ---- 4. DM bot A: hard-locked run as its bound agent; typing + reply through TOKEN A ONLY ----
    tg.pushText(TOK_A, 900, 77, 'do a thing');
    await waitUntil(() => tg.perToken[TOK_A].sends.some(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Bound answer') >= 0), 8000, 'bot A replies');
    const botAReply = tg.perToken[TOK_A].sends.find(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Bound answer') >= 0);
    A.ok(String(botAReply.text || '').indexOf('Bound answer') >= 0, 'bot A reply came from the provider');
    A.ok(String(botAReply.text || '').indexOf('This final sentence') >= 0, 'the first visible provider reply is already complete');
    A.eq(tg.perToken[TOK_A].edits.length, 0, 'agent bot exposes no token-by-token edit stream');
    A.eq(String(botAReply.chat_id), '900', 'bot A replied to its own chat');
    A.ok(tg.perToken[TOK_A].actions.some(a => a.action === 'typing' && String(a.chat_id) === '900'), 'bot A showed the typing indicator during the run');
    A.eq(tg.perToken[TOK_B].sends.length, botBSendsBeforeA, 'bot B sent NOTHING for bot A\'s chat (no cross-talk)');
    A.eq(tg.perToken[STATION].sends.length, stationSendsBeforeA, 'the station bot sent NOTHING for bot A\'s chat');
    // hard-lock: the durable CHANNEL history landed under the BOUND agent, not a tg_<chatId> fallback.
    // (read the channel store straight from disk — /api/transcript serves per-STREAM history, not per-agent.)
    const chanHist = (agentId) => {
      try { return (JSON.parse(fs.readFileSync(path.join(ws, 'channels', agentId + '.history.json'), 'utf8')).messages || []); }
      catch (_) { return []; }
    };
    A.ok(chanHist('agent').some(t => t.role === 'user' && String(t.content || '').indexOf('do a thing') >= 0), 'bot A turn persisted under the BOUND agent (hard-lock)');
    A.eq(chanHist('tg_900').length, 0, 'no tg_<chatId> fallback agent was created for bot A\'s chat');

    // ---- 5. DM bot B — SAME chatId (Telegram private chatId == userId, identical across bots): isolated ----
    tg.pushText(TOK_B, 900, 77, 'scout task here');
    await waitUntil(() => tg.perToken[TOK_B].sends.some(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Bound answer') >= 0), 8000, 'bot B replies');
    const botBReply = tg.perToken[TOK_B].sends.find(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Bound answer') >= 0);
    A.eq(String(botBReply.chat_id), '900', 'bot B replied in its own chat');
    A.ok(tg.perToken[TOK_B].actions.some(a => a.action === 'typing'), 'bot B typing indicator fired too');
    A.ok(chanHist('scout_1').some(t => t.role === 'user' && String(t.content || '').indexOf('scout task here') >= 0), 'bot B turn persisted under ITS bound agent');
    A.ok(!chanHist('scout_1').some(t => String(t.content || '').indexOf('do a thing') >= 0), 'bot A\'s chat never bled into bot B\'s agent');

    // ---- 6. per-bot owner claim: user 77 claimed bot A above; a STRANGER's DM is refused before any run ----
    const aSendsBefore = tg.perToken[TOK_A].sends.length;
    tg.pushText(TOK_A, 999, 88, 'stranger trying to use the bot');
    await sleep(1200);   // enough for a poll cycle; an admitted message would have replied well within this
    A.eq(tg.perToken[TOK_A].sends.length, aSendsBefore, 'a non-owner DM to bot A got NO reply (owner-locked)');
    // ...while the owner still works
    tg.pushText(TOK_A, 900, 77, 'owner again');
    await waitUntil(() => tg.perToken[TOK_A].sends.length > aSendsBefore, 8000, 'owner still gets replies after the stranger');

    // ---- 6b. GROUPS: bot A's own owner admits a group with /allow; admission is per BOT (2026-10-19) ----
    const GRP = -100900;
    const inGroup = (tok, from) => tg.perToken[tok].sends.slice(from).filter(s => String(s.chat_id) === String(GRP));
    let gA = tg.perToken[TOK_A].sends.length;
    tg.pushGroup(TOK_A, GRP, 77, '@NovaBot are you here?');
    await sleep(1200);
    A.eq(inGroup(TOK_A, gA).length, 0, 'bot A is silent in a group its owner never admitted');
    gA = tg.perToken[TOK_A].sends.length;
    tg.pushGroup(TOK_A, GRP, 77, '/allow@NovaBot');
    await waitUntil(() => inGroup(TOK_A, gA).some(s => /admitted/i.test(String(s.text || ''))), 8000, 'bot A confirms /allow in the group');
    const scoped = JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'chatmap.json'), 'utf8')).chats || {};
    A.eq((scoped['111|' + GRP] || {}).admittedOn, 'telegram:111', 'the admission is stored in bot A\'s OWN scoped chat record, under its own channel');
    A.ok(!(scoped[String(GRP)] || {}).admittedOn, 'the station bot\'s record for the same chat id is untouched');
    gA = tg.perToken[TOK_A].sends.length;
    const gStation = tg.perToken[STATION].sends.length;
    tg.pushGroup(TOK_A, GRP, 88, '@NovaBot what do you think?');
    await waitUntil(() => inGroup(TOK_A, gA).some(s => String(s.text || '').indexOf('Bound answer') >= 0), 15000, 'bot A answers an @mention in the admitted group');
    A.eq(tg.perToken[STATION].sends.length, gStation, 'the station bot said nothing for bot A\'s group');
    const gB = tg.perToken[TOK_B].sends.length;
    tg.pushGroup(TOK_B, GRP, 77, '@ScoutBot and you?');
    await sleep(1200);
    A.eq(inGroup(TOK_B, gB).length, 0, 'bot B stays silent in the same group: bot A\'s /allow admitted only bot A');

    // ---- 7. malformed disconnect is inert; then a valid disconnect stops exactly bot A ----
    const botsBeforeMalformed = fs.readFileSync(path.join(ws, 'channels', 'secrets.json'), 'utf8');
    const badDisconnect = await fetch(B + '/api/channels/telegram/bots/111/disconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, body: '{bad'
    });
    A.eq(badDisconnect.status, 400, 'malformed per-bot disconnect -> 400');
    A.eq(fs.readFileSync(path.join(ws, 'channels', 'secrets.json'), 'utf8'), botsBeforeMalformed, 'malformed per-bot disconnect leaves durable bot configuration byte-identical');
    A.ok((await api('GET', '/api/channels/telegram/status')).j.bots.find(b => b.botId === '111').connected, 'malformed per-bot disconnect leaves its poller connected');

    const off = await api('POST', '/api/channels/telegram/bots/111/disconnect', {});
    A.eq(off.status, 200, 'bot A disconnect 200');
    await sleep(400);
    const aPollsAfterOff = tg.perToken[TOK_A].calls.filter(c => c.method === 'getUpdates').length;
    const bPollsAtOff = tg.perToken[TOK_B].calls.filter(c => c.method === 'getUpdates').length;
    await sleep(1200);
    A.eq(tg.perToken[TOK_A].calls.filter(c => c.method === 'getUpdates').length, aPollsAfterOff, 'bot A stopped polling after disconnect');
    await waitUntil(() => tg.perToken[TOK_B].calls.filter(c => c.method === 'getUpdates').length >= bPollsAtOff, 2000, 'bot B unaffected');
    const stAfter = (await api('GET', '/api/channels/telegram/status')).j;
    const rowA = (stAfter.bots || []).find(b => b.botId === '111');
    const rowB = (stAfter.bots || []).find(b => b.botId === '222');
    A.ok(rowA && rowA.enabled === false && rowA.connected === false && rowA.configured === true, 'bot A: off but token kept (RESUME-able)');
    A.ok(rowB && rowB.connected === true, 'bot B still connected in status');

    // ---- 8. forget bot B: record purged from the durable secrets file (read straight from disk) ----
    const forget = await api('POST', '/api/channels/telegram/bots/222/disconnect', { purge: true });
    A.eq(forget.j.purged, true, 'forget claims purged only with read-back proof');
    const onDisk = JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'secrets.json'), 'utf8'));
    A.ok(!(onDisk.telegramBots && onDisk.telegramBots['222']), 'bot B record is GONE from disk');
    A.ok(onDisk.telegramBots && onDisk.telegramBots['111'] && onDisk.telegramBots['111'].token === TOK_A, 'bot A record (disconnected, not forgotten) still on disk with its token');
    const backup = JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'secrets.json.bak'), 'utf8'));
    A.ok(!(backup.telegramBots && backup.telegramBots['222']), 'bot B record is GONE from the last-known-good backup too');
    A.ok(backup.telegramBots && backup.telegramBots['111'] && backup.telegramBots['111'].token === TOK_A, 'forget preserves the unrelated bot record in the recovery backup');

    // ---- 9. desktop restart: a token-free agent-bot record resolves from the per-bot keychain env payload ----
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tg-keychain-restart-'));
    let child2 = null;
    try {
      fs.mkdirSync(path.join(ws2, 'channels'), { recursive: true });
      fs.writeFileSync(path.join(ws2, 'channels', 'secrets.json'), JSON.stringify({
        telegramBots: { '111': { username: 'NovaBot', agentId: 'agent', name: 'NOVA', model: 'test/model', provider: 'openrouter', enabled: true, ownerId: '77' } }
      }));
      fs.writeFileSync(path.join(ws2, 'agent.roster.json'), JSON.stringify({
        version: 1, updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'NOVA', system: 'nova system', model: 'test/model', provider: 'openrouter' }]
      }));
      const beforeRestartPolls = tg.perToken[TOK_A].calls.filter(c => c.method === 'getUpdates').length;
      const keychainEnv = Object.assign({}, env, {
        SKYNET_WORKSPACES: ws2, STARNET_WORKSPACES: ws2,
        STARNET_DESKTOP_SHELL: '1', SKYNET_DESKTOP_SHELL: '1',
        SKYNET_TELEGRAM_BOT_TOKENS: JSON.stringify({ '111': TOK_A }),
        STARNET_TELEGRAM_BOT_TOKENS: JSON.stringify({ '111': TOK_A })
      });
      const second = await boot(await allocatePort(), keychainEnv, 20); child2 = second.child;
      const B2 = 'http://' + HOST + ':' + second.port;
      const token2 = await bootToken(B2, B2);
      await waitUntil(() => tg.perToken[TOK_A].calls.filter(c => c.method === 'getUpdates').length > beforeRestartPolls, 5000, 'keychain-backed bot polls after restart');
      const status2 = await fetch(B2 + '/api/channels/telegram/status', { headers: { 'X-StarNet-Token': token2, Origin: B2 } }).then(r => r.json());
      const restarted = (status2.bots || []).find(b => b.botId === '111');
      A.ok(restarted && restarted.configured && restarted.durable && restarted.runReady, 'token-free saved bot is configured durably and its roster provider remains runnable after restart');
      const disk2 = JSON.parse(fs.readFileSync(path.join(ws2, 'channels', 'secrets.json'), 'utf8'));
      A.ok(!('token' in disk2.telegramBots['111']), 'desktop restart does not recreate a plaintext agent-bot token');
    } finally {
      try { if (child2) child2.kill(); } catch (_) {}
      try { fs.rmSync(ws2, { recursive: true, force: true }); } catch (_) {}
    }
  } finally {
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => tg.close(resolve));
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('channels.telegram.multibot.e2e.test');
})().catch(e => { console.log('FAIL: channels.telegram.multibot.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
