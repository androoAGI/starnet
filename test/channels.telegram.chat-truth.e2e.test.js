/* node test/channels.telegram.chat-truth.e2e.test.js — LIVE proof of the 2026-10-23 channel fixes, through the REAL
   sidecar against a fake Telegram Bot API + fake provider (the group-allow e2e's harness):
     - the "/" menu: a stranger-visible scope never carries the Commander's own command descriptions; the owner's DM does
     - a desktop command typed on Telegram ("/version") is answered for free, never a paid model run
     - "/routine add" typed on Telegram makes a routine that delivers back to that chat, and says so
     - a closed group's "/allow @someone" (another bot's moderation command) admits nothing
     - /mention observe: what the bot overheard reaches the model on the next addressed message
     - a group that kicks the bot is no longer admitted: re-added, it stays silent until the owner's fresh /allow
     - "/deny @thisbot" closes an admitted room; any other /deny argument leaves it open and tells the owner so
     - "/steer <note>" typed while a task works joins that task, one line, and the phone gets no raw marker */
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
const G = -100777;
const BOOT_MS = process.platform === 'win32' ? 30000 : 9000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const sidecarLog = [];
function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

function startMockOpenRouter() {
  const runs = [];
  // HOLD: the first call whose prompt carries 'HOLD-ME' waits for release() — a run that is still working
  let held = null, releaseHeld = null;
  const hold = new Promise(r => { releaseHeld = r; });
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
        if (!held && JSON.stringify(body.messages || []).indexOf('HOLD-ME') >= 0) { held = body; await hold; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MODEL ANSWER ' + runs.length } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ runs, server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1', isHeld: () => !!held, release: () => releaseHeld() }));
  });
}

// the group-allow e2e's Bot API: an update stays pending until a later getUpdates offset confirms it; one per response
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
  const pushUpdate = (u) => { log.push(Object.assign({ update_id: ++updateId }, u)); flush(); };
  const push = (message) => pushUpdate({ message: Object.assign({ message_id: ++messageId, date: Math.floor(Date.now() / 1000) }, message) });
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop();
      const body = await readJsonBody(req);
      calls.push({ method, body });
      if (method === 'getUpdates') {
        if (body.offset === -1) { const pend = log.filter(u => u.update_id > confirmed); respond(res, { ok: true, result: pend.length ? [pend[pend.length - 1]] : [] }); return; }
        const offset = Number(body.offset) || 0;
        if (offset > 0) confirmed = Math.max(confirmed, offset - 1);
        const u = next(offset);
        if (u) { respond(res, { ok: true, result: [u] }); return; }
        const waiter = { res, offset };
        waiters.push(waiter);
        res.on('close', () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      if (method === 'sendMessage') { sends.push(body); respond(res, { ok: true, result: { message_id: ++messageId } }); return; }
      if (method === 'getMe') { respond(res, { ok: true, result: { id: 1, is_bot: true, username: BOT, first_name: 'Halcyon', can_read_all_group_messages: true } }); return; }
      respond(res, { ok: true, result: true });
    });
    server.listen(0, HOST, () => resolve({
      calls, sends, server, base: 'http://' + HOST + ':' + server.address().port,
      dm(userId, text) { push({ chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, username: 'u' + userId, first_name: 'U' + userId }, text }); },
      group(chatId, userId, text) {
        const msg = { chat: { id: chatId, type: 'supergroup', title: 'Ops ' + chatId }, from: { id: userId, is_bot: false, username: 'u' + userId, first_name: 'U' + userId }, text };
        const at = text.indexOf('@' + BOT);
        if (text[0] === '/') msg.entities = [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }];
        else if (at >= 0) msg.entities = [{ type: 'mention', offset: at, length: BOT.length + 1 }];
        push(msg);
      },
      membership(chatId, status, byUserId) {
        pushUpdate({ my_chat_member: { chat: { id: chatId, type: 'supergroup', title: 'Ops ' + chatId }, from: { id: byUserId, is_bot: false, first_name: 'Admin' },
          date: Math.floor(Date.now() / 1000), old_chat_member: { user: { id: 1, is_bot: true }, status: 'member' }, new_chat_member: { user: { id: 1, is_bot: true }, status: status } } });
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

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegram();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-chat-truth-'));
  const home = path.join(ws, 'home');
  fs.mkdirSync(home, { recursive: true });
  // the Commander's own command, with a private note as its description
  fs.writeFileSync(path.join(ws, 'usercommands.json'), JSON.stringify({ commands: [
    { name: 'deploy_prod', type: 'alias', target: '/usage', desc: 'deploy main to 10.0.0.5' }
  ] }));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), HERMES_HOME: path.join(home, '.hermes'),
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-chat-truth-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-chat-truth-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: 'TESTTOKEN', STARNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    SKYNET_TELEGRAM_API_BASE: tg.base, STARNET_TELEGRAM_API_BASE: tg.base
  };
  const sentTo = (chatId, from) => tg.sends.slice(from || 0).filter(s => String(s.chat_id) === String(chatId));
  const textOf = (s) => String((s && s.text) || '');
  const callsCarrying = (text, from) => llm.runs.slice(from).filter(r => JSON.stringify(r.messages || []).indexOf(text) >= 0);
  const menus = () => tg.calls.filter(c => c.method === 'setMyCommands').map(c => c.body);
  async function settled() {
    const from = tg.sends.length;
    tg.dm(OWNER, '/status');
    await waitUntil(() => sentTo(OWNER, from).some(s => /Idle|Working/.test(textOf(s))), 8000, 'barrier /status');
    await sleep(900);
  }
  let child = null;
  try {
    const live = await boot(await allocatePort(), env, 20);
    child = live.child;
    const B = 'http://' + HOST + ':' + live.port;
    const token = await bootToken(B, B);
    const H = { 'X-StarNet-Token': token, Origin: B, 'Content-Type': 'application/json' };
    await waitUntil(() => tg.calls.some(c => c.method === 'getUpdates' && c.body && c.body.offset !== -1), 8000, 'telegram poll loop');

    // ---- 1. the "/" menu before pairing: nothing the Commander wrote is in a scope a stranger can read ----
    await waitUntil(() => menus().length >= 2, 8000, 'the connect-time menu publish');
    const atConnect = menus();
    const dflt = atConnect.find(b => !b.scope);
    const groups = atConnect.find(b => b.scope && b.scope.type === 'all_group_chats');
    A.ok(dflt && groups, 'default + all-groups menus published at connect');
    A.ok(!JSON.stringify(dflt).includes('deploy_prod'), 'the default (any DM) menu lists only the built-ins');
    A.ok(groups.commands.some(c => c.command === 'deploy_prod'), 'groups can still tap the Commander\'s command by name');
    A.ok(!JSON.stringify(atConnect).includes('10.0.0.5'), 'no stranger-visible menu carries the Commander\'s own description');
    A.ok(!atConnect.some(b => b.scope && b.scope.type === 'chat'), 'no owner scope before an owner exists');

    // ---- 2. pairing publishes the owner's own menu into the owner's DM only ----
    const pair = await (await fetch(B + '/api/channels/telegram/owner/pair', { method: 'POST', headers: H, body: '{}' })).json();
    tg.dm(OWNER, '/pair ' + pair.code);
    await waitUntil(() => sentTo(OWNER).some(s => /Owner paired/i.test(textOf(s))), 8000, 'owner-pair acknowledgement');
    await waitUntil(() => menus().some(b => b.scope && b.scope.type === 'chat'), 8000, 'the owner-DM menu publish');
    const mine = menus().find(b => b.scope && b.scope.type === 'chat');
    A.eq(String(mine.scope.chat_id), String(OWNER), 'scoped to the owner\'s own chat');
    A.ok(mine.commands.some(c => c.command === 'deploy_prod' && /10\.0\.0\.5/.test(c.description)), 'the owner sees their own description there');

    // ---- 3. a desktop command is answered for free ----
    let mark = tg.sends.length, runs0 = llm.runs.length;
    tg.dm(OWNER, '/version');
    await waitUntil(() => sentTo(OWNER, mark).length > 0, 8000, 'the /version answer');
    A.ok(/only works in the StarNet desktop app/.test(textOf(sentTo(OWNER, mark)[0])), '/version answers from the registry: ' + textOf(sentTo(OWNER, mark)[0]));
    mark = tg.sends.length;
    tg.dm(OWNER, '/routines');
    await waitUntil(() => sentTo(OWNER, mark).length > 0, 8000, 'the /routines answer');
    A.ok(/routine/i.test(textOf(sentTo(OWNER, mark)[0])) && !/MODEL ANSWER/.test(textOf(sentTo(OWNER, mark)[0])), '/routines runs /routine: ' + textOf(sentTo(OWNER, mark)[0]).slice(0, 120));
    await settled();
    A.eq(callsCarrying('/version', runs0).length + callsCarrying('/routines', runs0).length, 0, 'neither reached the model');

    // ---- 4. /routine add delivers back to this chat, and says so ----
    mark = tg.sends.length;
    tg.dm(OWNER, '/routine add every day at 9am | morning digest for the phone');
    await waitUntil(() => sentTo(OWNER, mark).length > 0, 8000, 'the /routine add answer');
    const addReply = textOf(sentTo(OWNER, mark)[0]);
    A.ok(/Routine created/.test(addReply) && /Results will come back to this chat\./.test(addReply), 'the reply says where results go: ' + addReply);
    const cron = await (await fetch(B + '/api/cron', { headers: H })).json();
    const job = ((cron && cron.jobs) || []).find(j => /morning digest for the phone/.test(String(j.prompt || j.name || '')));
    A.ok(job, 'the routine is on the station');
    A.eq(job && job.deliver, 'origin', 'it delivers to its origin');
    A.eq(job && job.origin && String(job.origin.chatId), String(OWNER), 'which is this chat');
    A.eq(job && job.origin && job.origin.channel, 'telegram', 'on this channel');

    // ---- 5. a closed group: another bot's "/allow @someone" admits nothing; the owner's own /allow does ----
    mark = tg.sends.length;
    tg.group(G, OWNER, '/allow @newmember');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'the moderation command got no reply from us');
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, '@' + BOT + ' are you here?');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'and the room is still closed');
    mark = tg.sends.length;
    tg.group(G, OWNER, '/allow@' + BOT);
    await waitUntil(() => sentTo(G, mark).some(s => /admitted/i.test(textOf(s))), 8000, 'the /allow confirmation');

    // ---- 6. /mention observe: the next addressed run SEES what was overheard ----
    mark = tg.sends.length;
    tg.group(G, OWNER, '/mention@' + BOT + ' observe');
    await waitUntil(() => sentTo(G, mark).some(s => /read the rest of the room/i.test(textOf(s))), 8000, '/mention observe confirmation');
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, 'the hangar code is 4471-OBSERVED');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'an observed message gets no reply');
    A.eq(callsCarrying('4471-OBSERVED', runs0).length, 0, 'and spends no model call');
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, '@' + BOT + ' what was the hangar code?');
    await waitUntil(() => sentTo(G, mark).some(s => /MODEL ANSWER/.test(textOf(s))), 15000, 'the answer to the addressed question');
    A.ok(callsCarrying('4471-OBSERVED', runs0).length > 0, 'THE MODEL SAW WHAT IT OVERHEARD (the observed line rode the addressed run\'s history)');

    // ---- 7. kicked, then re-added: silent until the owner admits it again ----
    tg.membership(G, 'kicked', 777);
    await settled();
    tg.membership(G, 'member', 777);
    await settled();
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, '@' + BOT + ' hello again?');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'a re-added room is not answered');
    A.eq(callsCarrying('hello again?', runs0).length, 0, 'and spends nothing');
    mark = tg.sends.length;
    tg.group(G, OWNER, '/allow@' + BOT);
    await waitUntil(() => sentTo(G, mark).some(s => /admitted/i.test(textOf(s))), 8000, 'the fresh /allow');
    A.ok(true, 'the owner\'s fresh /allow re-admits it');

    // ---- 8. the owner closes the room by NAMING this bot ("/deny @halcyonbot"); a /deny with anything else after it
    //         is left alone, and the owner is told the room is still open ----
    mark = tg.sends.length;
    tg.group(G, OWNER, '/deny @spammer');
    await waitUntil(() => sentTo(G, mark).length > 0, 8000, 'the still-admitted line');
    A.ok(/still admitted/.test(textOf(sentTo(G, mark)[0])) && /\/deny on its own/.test(textOf(sentTo(G, mark)[0])), 'an ignored close is never silent to the owner: ' + textOf(sentTo(G, mark)[0]));
    mark = tg.sends.length;
    tg.group(G, OWNER, '/deny @' + BOT);
    await waitUntil(() => sentTo(G, mark).some(s => /^Removed\./.test(textOf(s))), 8000, 'the /deny @bot confirmation');
    mark = tg.sends.length; runs0 = llm.runs.length;
    tg.group(G, MEMBER, '@' + BOT + ' still there?');
    await settled();
    A.eq(sentTo(G, mark).length, 0, 'the room "/deny @' + BOT + '" closed is closed');
    A.eq(callsCarrying('still there?', runs0).length, 0, 'and spends nothing');

    // ---- 9. /steer typed while a task is working: the note (two lines, one bubble) joins THAT task — the model's next
    //         call carries it on one line, the phone gets both answers with the note between them, never the marker ----
    mark = tg.sends.length; runs0 = llm.runs.length;
    const callsMark = tg.calls.length;
    tg.dm(OWNER, 'write a short poem HOLD-ME');
    await waitUntil(() => llm.isHeld(), 15000, 'the held model call');
    tg.dm(OWNER, '/steer make it about the sea\nand make it rhyme');
    await waitUntil(() => sentTo(OWNER, mark).some(s => /^↪ Added to the task/.test(textOf(s))), 8000, 'the steer acknowledgement');
    llm.release();
    const answered = () => tg.calls.slice(callsMark).filter(c => (c.method === 'sendMessage' || c.method === 'editMessageText')
      && String(c.body && c.body.chat_id) === String(OWNER) && /MODEL ANSWER/.test(String(c.body.text || '')));
    await waitUntil(() => answered().some(c => /↪ make it about the sea/.test(String(c.body.text))), 20000, 'the steered reply');
    const finalText = String(answered().pop().body.text);
    A.ok(callsCarrying('<steering_note>make it about the sea and make it rhyme</steering_note>', runs0).length > 0, 'the model got the note, command word stripped, on one line');
    // ('/steer make' — a bare '/steer' also matches the note's own closing '</steering_note>' tag)
    A.eq(callsCarrying('/steer make', runs0).length, 0, 'the command word never reached the model');
    A.ok(!/\[steering\]/.test(finalText), 'no raw marker on the phone: ' + JSON.stringify(finalText));
    A.ok(/MODEL ANSWER \d+\n\n↪ make it about the sea and make it rhyme\n\nMODEL ANSWER \d+/.test(finalText), 'both answers, the note on its own line between them: ' + JSON.stringify(finalText));
    A.ok(!sentTo(OWNER, mark).some(s => /only works in the StarNet desktop app/.test(textOf(s))), 'never the desktop-only refusal');
  } finally {
    await stop(child);
    try { tg.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('channels.telegram.chat-truth.e2e.test');
})().catch(e => {
  console.log('FAIL: threw ' + (e && e.stack || e));
  console.log('--- sidecar output (tail) ---\n' + sidecarLog.join('').split('\n').slice(-60).join('\n'));
  process.exit(1);
});
