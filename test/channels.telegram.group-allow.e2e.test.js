/* node test/channels.telegram.group-allow.e2e.test.js — LIVE proof that a paired owner can admit a group with /allow.

   Until 2026-10-19 the adapter's group allow-list (`allowedChats`) was plumbed through every channel module and
   never passed by sidecar/index.js, so admission() dropped every group message on every platform: the bot was
   silent in every group, and the unit tests hid it by passing an allow-list by hand. The station bot's factory
   also dropped `mentionPatterns` and `observeUnmentioned`, so wake words and /mention observe were dead.

   Boots the REAL sidecar against a fake Telegram Bot API + fake provider and drives the whole lifecycle:
     - the owner pairs in a DM through the real local pairing route
     - an @mention in group G is ignored before /allow (no reply, no model call)
     - the owner's /allow@bot in G is confirmed in G, and an @mention there is then answered by the model
     - calling the bot by its NAME (a wake word, from getMe) is answered; an unaddressed message is not
     - /mention observe files an unaddressed message without answering it
     - a non-owner's /allow in group H is refused with one line, and H stays silent
     - a sidecar restart keeps G admitted
     - /deny in G is confirmed, and G is silent again */
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
const BOT = 'halcyonbot';
const OWNER = 99, MEMBER = 55;
const G = -100777, H = -100888;
const BOOT_MS = process.platform === 'win32' ? 30000 : 9000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const sidecarLog = [];   // every booted sidecar's output, printed only when the test fails
const failDump = [];     // extra state to print when the test fails
function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

function startMockOpenRouter() {
  const runs = [];
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        const body = await readJsonBody(req);
        runs.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'GROUP ANSWER ' + runs.length } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ runs, server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

/* Like the real Bot API, an update stays pending until a getUpdates with a HIGHER offset confirms it. Handing it
   out does not consume it, so a long-poll answered into a dying sidecar (the restart below) cannot eat an update:
   the next poller is simply given it again. One update per response keeps the order of the scenario exact. */
function startMockTelegram() {
  const calls = [], sends = [], log = [], waiters = [];
  let updateId = 1000, messageId = 2000, confirmed = 0;
  const respond = (res, obj) => { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {} };
  const next = (offset) => log.find(u => u.update_id > confirmed && u.update_id >= offset);
  const flush = () => {
    for (const w of waiters.slice()) {
      const u = next(w.offset);
      if (!u) continue;
      waiters.splice(waiters.indexOf(w), 1);
      respond(w.res, { ok: true, result: [u] });
    }
  };
  const push = (message) => { log.push({ update_id: ++updateId, message: Object.assign({ message_id: ++messageId, date: Math.floor(Date.now() / 1000) }, message) }); flush(); };
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop();
      const body = await readJsonBody(req);
      calls.push({ method, body });
      if (method === 'getUpdates') {
        // offset -1 asks for the LAST still-pending update only (the adapter's drop-pending probe at connect)
        if (body.offset === -1) { const pend = log.filter(u => u.update_id > confirmed); respond(res, { ok: true, result: pend.length ? [pend[pend.length - 1]] : [] }); return; }
        const offset = Number(body.offset) || 0;
        if (offset > 0) confirmed = Math.max(confirmed, offset - 1);
        const u = next(offset);
        if (u) { respond(res, { ok: true, result: [u] }); return; }
        const waiter = { res, offset };
        waiters.push(waiter);
        // the RESPONSE closing is the poller going away (a killed sidecar); the request stream has already ended
        res.on('close', () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      if (method === 'sendMessage') { sends.push(body); respond(res, { ok: true, result: { message_id: ++messageId } }); return; }
      if (method === 'getMe') { respond(res, { ok: true, result: { id: 1, is_bot: true, username: BOT, first_name: 'Halcyon', can_read_all_group_messages: true } }); return; }
      respond(res, { ok: true, result: true });
    });
    server.listen(0, HOST, () => resolve({
      calls, sends, server, base: 'http://' + HOST + ':' + server.address().port, _w: () => [waiters.length, log.length, confirmed],
      dm(userId, text) { push({ chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, username: 'u' + userId, first_name: 'U' + userId }, text }); },
      group(chatId, userId, text) {
        const msg = { chat: { id: chatId, type: 'supergroup', title: 'Ops ' + chatId }, from: { id: userId, is_bot: false, username: 'u' + userId, first_name: 'U' + userId }, text };
        const at = text.indexOf('@' + BOT);
        if (text[0] === '/') msg.entities = [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }];
        else if (at >= 0) msg.entities = [{ type: 'mention', offset: at, length: BOT.length + 1 }];
        push(msg);
      },
      close() { while (waiters.length) respond(waiters.shift().res, { ok: true, result: [] }); server.close(() => {}); }
    }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      sidecarLog.push(d.toString());
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port; sidecar output:\n' + out));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    // the same startup window helpers/sidecar-fixture.js grants: a cold 28k-line index.js on a loaded Windows box
    // can take well over 9s before its first log line, and this test boots it twice
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, BOOT_MS);
  });
}
function stop(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    try { child.kill(); } catch (_) { resolve(); }
  });
}
async function waitUntil(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(25); }
  throw new Error('timed out waiting for ' + label);
}
function filesUnder(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegram();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-group-allow-'));
  const home = path.join(ws, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    // never let a test sidecar see (or recover into) the real user profile
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), HERMES_HOME: path.join(home, '.hermes'),
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-group-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-group-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: 'TESTTOKEN', STARNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    SKYNET_TELEGRAM_API_BASE: tg.base, STARNET_TELEGRAM_API_BASE: tg.base
  };
  const sentTo = (chatId, from) => tg.sends.slice(from || 0).filter(s => String(s.chat_id) === String(chatId));
  const polling = (from) => waitUntil(() => tg.calls.slice(from).some(c => c.method === 'getUpdates' && c.body && c.body.offset !== -1), 8000, 'telegram poll loop');
  // A BARRIER, so "the bot said nothing" is a measurement and not a race: the owner's DM /status is queued AFTER
  // the message under test, so once its answer lands the adapter has already taken its verdict on that message.
  // The extra pause covers a run that WAS admitted and is still on its way to the model.
  async function settled() {
    const from = tg.sends.length;
    tg.dm(OWNER, '/status');
    await waitUntil(() => sentTo(OWNER, from).some(s => /Idle|Working/.test(String(s.text || ''))), 8000, 'barrier /status');
    await sleep(900);
  }
  // "Spends no model call" is a claim about THAT message, so it is measured by what reached the model, not by a raw
  // request count: the station's own background passes (the quest master's slate refresh, live-caught 2026-10-19)
  // hit the same mock endpoint on their own schedule and landed inside the window under load.
  const callsCarrying = (text, from) => llm.runs.slice(from).filter(r => JSON.stringify(r.messages || []).indexOf(text) >= 0);
  let child = null;
  try {
    let live = await boot(await allocatePort(), env, 20);
    child = live.child;
    let B = 'http://' + HOST + ':' + live.port;
    let token = await bootToken(B, B);
    await polling(0);

    // ---- 1. the owner pairs in a DM -------------------------------------------------------------------
    const pair = await (await fetch(B + '/api/channels/telegram/owner/pair', { method: 'POST', headers: { 'X-StarNet-Token': token, Origin: B, 'Content-Type': 'application/json' }, body: '{}' })).json();
    A.ok(pair && /^[-A-Z0-9]{11}$/.test(String(pair.code || '')), 'local owner pairing issued a one-time code');
    tg.dm(OWNER, '/pair ' + pair.code);
    await waitUntil(() => sentTo(OWNER).some(s => /Owner paired/i.test(String(s.text || ''))), 8000, 'owner-pair acknowledgement');

    // ---- 2. before /allow, the group is silent — even to the owner, even @mentioned --------------------
    let mark = tg.sends.length, runs0 = llm.runs.length;
    tg.group(G, OWNER, '@' + BOT + ' what is two plus two?');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'before /allow an @mention in the group gets no reply');
    A.eq(callsCarrying('what is two plus two?', runs0).length, 0, 'before /allow an @mention in the group spends no model call');

    // ---- 3. the owner admits the group ----------------------------------------------------------------
    mark = tg.sends.length;
    tg.group(G, OWNER, '/allow@' + BOT);
    await waitUntil(() => sentTo(G, mark).length > 0, 8000, 'the /allow confirmation in the group');
    const allowReply = String(sentTo(G, mark)[0].text || '');
    A.ok(/admitted/i.test(allowReply), 'the owner\'s /allow is confirmed in the group: ' + allowReply.slice(0, 120));
    A.ok(/\/deny/.test(allowReply), 'the confirmation names the way back out (/deny)');

    // ---- 4. an admitted group: an @mention is answered by the model ------------------------------------
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, '@' + BOT + ' what is two plus two?');
    await waitUntil(() => sentTo(G, mark).some(s => /GROUP ANSWER/.test(String(s.text || ''))), 15000, 'the model answer to an @mention in the admitted group');
    A.ok(llm.runs.length > runs0, 'the @mention in the admitted group ran the model');
    A.ok(callsCarrying('what is two plus two?', runs0).length > 0, 'that message reached the model (the no-call checks measure by this same match, so they can see a leak)');

    // ---- 5. wake word: calling the bot by its getMe NAME is being addressed ----------------------------
    mark = tg.sends.length;
    tg.group(G, MEMBER, 'Halcyon, are you there?');
    await waitUntil(() => sentTo(G, mark).some(s => /GROUP ANSWER/.test(String(s.text || ''))), 15000, 'the model answer to the wake word');
    A.ok(true, 'calling the bot by name in the admitted group is answered (mentionPatterns reach the adapter)');

    // …while a message that addresses nobody is somebody else's conversation
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, 'lunch at noon, everyone?');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'an unaddressed group message gets no reply');
    A.eq(callsCarrying('lunch at noon, everyone?', runs0).length, 0, 'an unaddressed group message spends no model call');

    // ---- 6. /mention observe: heard and filed, never answered ------------------------------------------
    mark = tg.sends.length;
    tg.group(G, OWNER, '/mention@' + BOT + ' observe');
    await waitUntil(() => sentTo(G, mark).some(s => /read the rest of the room/i.test(String(s.text || ''))), 8000, '/mention observe confirmation');
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, 'the hangar code is 4471-OBSERVED');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'an observed message gets no reply');
    A.eq(callsCarrying('4471-OBSERVED', runs0).length, 0, 'an observed message spends no model call');
    const filed = filesUnder(path.join(ws, 'channels')).some(f => { try { return fs.readFileSync(f, 'utf8').indexOf('4471-OBSERVED') >= 0; } catch (_) { return false; } });
    A.ok(filed, 'the observed message was filed in the chat history (observeUnmentioned reaches the adapter)');
    mark = tg.sends.length;
    tg.group(G, OWNER, '/mention@' + BOT + ' on');
    await waitUntil(() => sentTo(G, mark).some(s => /only when addressed/i.test(String(s.text || ''))), 8000, '/mention on confirmation');

    // ---- 7. a non-owner cannot admit another group ------------------------------------------------------
    mark = tg.sends.length;
    tg.group(H, MEMBER, '/allow@' + BOT);
    await waitUntil(() => sentTo(H, mark).length > 0, 8000, 'the non-owner /allow refusal');
    const refusals = sentTo(H, mark);
    A.eq(refusals.length, 1, 'the non-owner /allow gets exactly one reply');
    A.ok(/owner/i.test(String(refusals[0].text || '')) && String(refusals[0].text || '').split('\n').length === 1,
      'the refusal is one line naming the owner rule: ' + String(refusals[0].text || '').slice(0, 120));
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(H, MEMBER, '@' + BOT + ' hello?');
    await settled();
    A.eq(sentTo(H, mark).length, 0, 'the group a non-owner tried to admit stays silent');
    A.eq(llm.runs.length, runs0, 'and spends nothing');
    // a non-owner /deny in the ADMITTED group changes nothing either
    mark = tg.sends.length;
    tg.group(G, MEMBER, '/deny@' + BOT);
    await waitUntil(() => sentTo(G, mark).length > 0, 8000, 'the non-owner /deny refusal');
    A.ok(/owner/i.test(String(sentTo(G, mark)[0].text || '')), 'a non-owner /deny in the admitted group is refused');

    // ---- 8. a restart keeps G admitted -------------------------------------------------------------------
    // Restart a QUIET station: a kill while the refusal above is still between send and its durable-inbox removal
    // makes the next boot (correctly) replay it, which is the durability contract and not what this step tests.
    await settled();
    await stop(child); child = null;
    const callsAt = tg.calls.length;
    const sendsAt = tg.sends.length;
    live = await boot(await allocatePort(), env, 20);
    child = live.child;
    B = 'http://' + HOST + ':' + live.port;
    token = await bootToken(B, B);
    await polling(callsAt);
    failDump.push(() => 'mock Bot API after the restart: ' + JSON.stringify(tg.calls.slice(callsAt).map(c => [c.method, c.body && c.body.offset, c.body && c.body.chat_id])) + ' waiters/log/confirmed=' + JSON.stringify(tg._w())
      + '\nsent after the restart: ' + JSON.stringify(tg.sends.slice(sendsAt).map(x => [x.chat_id, String(x.text || '').slice(0, 200)])));
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, '@' + BOT + ' still with us after the restart?');
    // the FIRST run of a just-booted sidecar competes with its boot-time work; on a loaded box that alone has
    // taken longer than the other steps' 15s window
    const askedAt = Date.now();
    await waitUntil(() => sentTo(G, mark).some(s => /GROUP ANSWER/.test(String(s.text || ''))), 45000, 'an answer in G after the restart');
    console.log('  first answer after the restart took ' + (Date.now() - askedAt) + 'ms');
    A.ok(llm.runs.length > runs0, 'after a sidecar restart the admitted group is still answered');
    A.ok(!sentTo(G, mark).some(s => /owner-only/.test(String(s.text || ''))), 'the restart replayed nothing into G');

    // ---- 9. /deny makes it silent again -------------------------------------------------------------------
    mark = tg.sends.length;
    tg.group(G, OWNER, '/deny@' + BOT);
    await waitUntil(() => sentTo(G, mark).length > 0, 8000, 'the /deny confirmation');
    A.ok(/\/allow/.test(String(sentTo(G, mark)[0].text || '')), 'the /deny confirmation names the way back in (/allow): ' + String(sentTo(G, mark)[0].text || '').slice(0, 120));
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, OWNER, '@' + BOT + ' are you still listening?');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'after /deny an @mention in the group gets no reply');
    A.eq(llm.runs.length, runs0, 'after /deny the group spends nothing');
  } finally {
    await stop(child);
    try { tg.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('channels.telegram.group-allow.e2e.test');
})().catch(e => {
  console.log('FAIL: threw ' + (e && e.stack || e));
  for (const f of failDump) { try { console.log(f()); } catch (_) {} }
  console.log('--- sidecar output (tail) ---\n' + sidecarLog.join('').split('\n').slice(-60).join('\n'));
  process.exit(1);
});
