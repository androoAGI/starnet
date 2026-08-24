/* node test/channels.telegram.buttons.e2e.test.js — true sidecar proof for Telegram inline keyboards (C6).

   Boots the ACTUAL sidecar process against a fake Telegram Bot API and a fake OpenRouter, then walks the whole
   button round-trip the way a phone does:

     1. connect            -> setMyCommands publishes the SAME commands the hub implements
     2. a TASK_QUESTION    -> sendMessage carries reply_markup with one button per option
     3. a callback_query   -> answerCallbackQuery + editMessageText fire, and the chosen option's OWN TEXT
                              re-enters the model as the next user turn
     4. a stale second tap -> acknowledged, but starts no second run
     5. a stranger's tap   -> never reaches the hub at all (owner-only admission)

   Everything crosses the real composition root: real adapter, real hub, real registry, real runOnce. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

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

// A SCRIPTABLE provider: each queued step is either plain text or a real tool_call, so the test can drive the
// model into asking a TASK_QUESTION and (later) into an ungranted fs.write that must raise a consent prompt.
//
// Steps are keyed by `when` = the request's LAST USER MESSAGE, and matched in order. That keying is load-bearing:
// the station also fires background runs of its own (skill review, quest refresh) against this same endpoint, and
// a positional queue would let those runs eat the steps meant for the Telegram turn. Their last user message is
// their own long prompt, so they never match and always fall through to the default acknowledgement.
function startMockOpenRouter() {
  const requests = [], script = [];
  const lastUser = (msgs) => {
    for (let i = (msgs || []).length - 1; i >= 0; i--) if (msgs[i].role === 'user') return String(msgs[i].content || '');
    return '';
  };
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
        req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          const lu = lastUser(parsed.messages);
          const i = script.findIndex(s => s.when === lu);
          const step = i >= 0 ? script.splice(i, 1)[0] : { text: 'Acknowledged.' };
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (step.tool) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: step.text } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, script, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function startMockTelegram() {
  const calls = [], sends = [], edits = [], acks = [], menus = [];
  const queued = [], waiters = [];
  let updateId = 1000, messageId = 2000;

  function respond(res, obj) {
    try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {}
  }
  function flush() {
    while (queued.length && waiters.length) respond(waiters.shift().res, { ok: true, result: [queued.shift()] });
  }

  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop();
      const body = await readJsonBody(req);
      calls.push({ method, body });

      if (method === 'deleteWebhook') { respond(res, { ok: true, result: true }); return; }
      if (method === 'setMyCommands') { menus.push(body); respond(res, { ok: true, result: true }); return; }
      if (method === 'answerCallbackQuery') { acks.push(body); respond(res, { ok: true, result: true }); return; }
      if (method === 'editMessageText') { edits.push(body); respond(res, { ok: true, result: { message_id: body.message_id } }); return; }
      if (method === 'sendMessage') { sends.push(body); respond(res, { ok: true, result: { message_id: ++messageId } }); return; }
      if (method === 'getUpdates') {
        if (body.offset === -1) { respond(res, { ok: true, result: [] }); return; }
        if (queued.length) { respond(res, { ok: true, result: [queued.shift()] }); return; }
        const waiter = { res };
        waiters.push(waiter);
        req.on('close', () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      respond(res, { ok: false, error_code: 404, description: 'unknown method' });
    });
    server.listen(0, HOST, () => {
      resolve({
        calls, sends, edits, acks, menus,
        base: 'http://' + HOST + ':' + server.address().port,
        pushText(chatId, userId, text) {
          queued.push({
            update_id: ++updateId,
            message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text }
          });
          flush();
        },
        pushCallback(chatId, userId, data, msgId) {
          queued.push({
            update_id: ++updateId,
            callback_query: {
              id: 'cbq-' + updateId,
              from: { id: userId, username: 'commander' },
              message: { message_id: msgId, chat: { id: chatId, type: 'private' } },
              data
            }
          });
          flush();
        },
        close(done) { while (waiters.length) respond(waiters.shift().res, { ok: true, result: [] }); server.close(done || (() => {})); }
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
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port'));
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
  while (Date.now() < deadline) { if (await fn()) return; await sleep(25); }
  throw new Error('timed out waiting for ' + label);
}
// The station fires background runs (skill review, quest refresh) against the same mock, so "the most recent
// request" is NOT reliably the Telegram turn. Callers search ALL requests for the one they mean instead.
const lastUserTurn = (req) => {
  const m = (req && req.messages) || [];
  for (let i = m.length - 1; i >= 0; i--) if (m[i].role === 'user') return m[i].content;
  return null;
};

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegram();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tg-buttons-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-buttons-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-buttons-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: 'TESTTOKEN', STARNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    SKYNET_TELEGRAM_API_BASE: tg.base, STARNET_TELEGRAM_API_BASE: tg.base
  };
  const { child, port } = await boot(9040 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    await waitUntil(() => tg.calls.some(c => c.method === 'getUpdates' && c.body && c.body.offset === -1), 5000, 'telegram drop-pending poll');

    // Enrol the Telegram account through the same explicit local pairing flow as the desktop UI.
    const pair = await (await fetch(B + '/api/channels/telegram/owner/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: '{}'
    })).json();
    A.ok(/^[-A-Z0-9]{11}$/.test(String(pair.code || '')), 'local owner pairing issued a code');
    tg.pushText(4242, 99, '/pair ' + pair.code);
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '4242' && /Owner paired/i.test(String(s.text || ''))), 8000, 'owner pairing acknowledgement');

    // ---- 1. the "/" menu is published, and matches what the hub actually implements ----
    await waitUntil(() => tg.menus.length >= 1, 5000, 'setMyCommands');
    const names = tg.menus[0].commands.map(c => c.command);
    A.ok(names.indexOf('approvals') >= 0, 'the published menu includes /approvals');
    A.ok(names.indexOf('talk') >= 0 && names.indexOf('agents') >= 0, 'and the pre-existing commands');
    for (const c of tg.menus[0].commands) {
      A.ok(/^[a-z0-9_]{1,32}$/.test(c.command), 'menu name /' + c.command + ' is valid for Telegram');
      A.ok(!!c.description, 'menu name /' + c.command + ' carries a description');
    }

    // ---- 2. a TASK_QUESTION reply ships a real inline keyboard ----
    llm.script.push({ when: 'deploy the app', text: 'TASK_QUESTION: Which deployment target should I use? || staging | the production cluster' });
    llm.script.push({ when: 'the production cluster', text: 'Deploying now.' });
    tg.pushText(4242, 99, 'deploy the app');
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '4242' && s.reply_markup), 8000, 'question reply');
    const q = tg.sends.find(s => String(s.chat_id) === '4242' && s.reply_markup);
    A.eq(String(q.chat_id), '4242', 'reply goes to the inbound chat');
    A.ok(!!q.reply_markup && Array.isArray(q.reply_markup.inline_keyboard), 'the reply carries reply_markup.inline_keyboard');
    const kb = q.reply_markup.inline_keyboard;
    A.eq(kb.length, 2, 'one button per option');
    A.eq(kb[0].length, 1, 'one button per row');
    A.eq(kb[0][0].text, '1. staging', 'short numbered button label');
    // the whole reason for the token indirection — a long option must not widen callback_data
    for (const row of kb) A.ok(Buffer.byteLength(row[0].callback_data, 'utf8') <= 64, 'callback_data is within Telegram\'s 64-byte cap');
    A.ok(q.text.indexOf('the production cluster') >= 0, 'the FULL option text still rides in the message body');
    A.ok(/Tap a choice below/.test(q.text), 'and the copy points at the buttons');

    // ---- 3. tapping option 2 re-enters the run as that option's OWN text ----
    const questionMsgId = 2000 + tg.sends.length + 1;   // the id the mock assigned to that sendMessage
    const beforeRuns = llm.requests.length;
    tg.pushCallback(4242, 99, kb[1][0].callback_data, questionMsgId);

    await waitUntil(() => tg.acks.length >= 1, 8000, 'answerCallbackQuery');
    A.ok(/production/.test(String(tg.acks[0].text || '')), 'the tap is acknowledged with the chosen option');
    await waitUntil(() => tg.edits.length >= 1, 8000, 'editMessageText');
    A.ok(/▸ the production cluster/.test(String(tg.edits[0].text || '')), 'the question message is stamped with the choice');
    A.eq(tg.edits[0].reply_markup, undefined, 'and its keyboard is stripped (no reply_markup on the edit)');

    await waitUntil(() => llm.requests.length > beforeRuns, 8000, 'follow-up run');
    A.ok(llm.requests.some(r => lastUserTurn(r) === 'the production cluster'),
      'the model receives the option\'s OWN TEXT as the next user turn — identical to the Commander typing it');
    await waitUntil(() => tg.sends.some(s => /Deploying now\./.test(String(s.text || ''))), 8000, 'follow-up reply');
    A.ok(tg.sends.some(s => /Deploying now\./.test(String(s.text || ''))), 'the follow-up answer is delivered');

    // ---- 4. a stale second tap is acknowledged but starts nothing ----
    // Count the runs that carry THIS OPTION'S text, not every request the station makes. A raw total is moved
    // by anything the previous run still has in flight (an aux reflect/study pass, a late turn), which under
    // full-gate load lands inside the 400ms window below and turned the gate red for a dedupe that worked
    // perfectly (the stale tap was correctly acked 'no longer open' right above). The invariant under test is
    // "the tap did not re-enter the run" — measure exactly that: a genuine second run WOULD carry the
    // option text again and still fails here.
    const optionRuns = () => llm.requests.filter(r => lastUserTurn(r) === 'the production cluster').length;
    const runsAfter = optionRuns();
    tg.pushCallback(4242, 99, kb[1][0].callback_data, questionMsgId);
    await waitUntil(() => tg.acks.length >= 2, 8000, 'second ack');
    A.ok(/no longer open/i.test(String(tg.acks[1].text || '')), 'the stale tap is honestly reported as closed');
    await sleep(400);
    A.eq(optionRuns(), runsAfter, 'a double-tap never starts a second run');

    // ---- 5. owner-only: a stranger's tap never reaches the hub ----
    const acksBefore = tg.acks.length;
    tg.pushCallback(4242, 777, kb[0][0].callback_data, questionMsgId);
    await sleep(500);
    A.eq(tg.acks.length, acksBefore, 'a non-owner tap is dropped at admission — never acked, never acted on');

    // ---- 6. APPROVE/DENY: opt in, then let an ungranted fs.write raise a real consent prompt ----
    // This is the path that flips the run to surface:'interactive'. Everything below crosses the REAL broker
    // (permissions.js tier 4) and the REAL fail-closed waiter (consentwait.js) — only the network is faked.
    // Give this chat's agent a CABINET. Capability projection is what decides which tools exist at all, so
    // without a placed cabinet there is no fs.write for the broker to pause on, and a bay projects PURE room objects with no baseline, so it needs its own computer to run at all (a bare workspace offers only
    // the consent-free skill tools) and this would silently prove nothing.
    const rr = await fetch(B + '/api/routing', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ errors: [], hash: 'buttons-e2e', bays: [], dockBays: [{ agentId: 'tg_4242', objects: ['computer', 'cabinet'] }] })
    });
    A.eq(rr.status, 200, 'routing plan accepted (computer + cabinet projected onto tg_4242)');

    const sendsBeforeOptIn = tg.sends.length;
    tg.pushText(4242, 99, '/approvals on');
    await waitUntil(() => tg.sends.length > sendsBeforeOptIn, 8000, '/approvals confirmation');
    const optIn = tg.sends[tg.sends.length - 1].text;
    A.ok(/ON/.test(optIn), '/approvals on confirms it is ON');
    A.ok(/denied and the run moves on/.test(optIn), 'and states the cost of not answering, not just the benefit');

    const sendsBeforeWrite = tg.sends.length;
    // the Task Brief gate blocks consequential tools until the brief is settled — same as any real run
    llm.script.push({ when: 'write hello into notes.md', tool: 'brief_proceed', args: { objective: 'write hello into notes.md' } });
    llm.script.push({ when: 'write hello into notes.md', tool: 'fs_write', args: { path: 'notes.md', content: 'hello' } });
    llm.script.push({ when: 'write hello into notes.md', text: 'Wrote notes.md.' });
    tg.pushText(4242, 99, 'write hello into notes.md');

    // the consent keyboard must appear on its own message, mid-run
    await waitUntil(() => tg.sends.slice(sendsBeforeWrite).some(s => s.reply_markup), 12000, 'consent keyboard');
    const ask = tg.sends.slice(sendsBeforeWrite).find(s => s.reply_markup);
    A.ok(/Permission needed/.test(ask.text), 'the ask announces itself as a permission request');
    A.ok(/fs\.write/.test(ask.text), 'and names the actual tool the broker paused on');
    const ckb = ask.reply_markup.inline_keyboard;
    A.eq(ckb.map(r => r[0].text), ['✅ Allow once', '✅ Allow for this session', '♾️ Always allow', '❌ Deny'],
      'the four buttons are the broker\'s own decision vocabulary');
    for (const row of ckb) A.ok(Buffer.byteLength(row[0].callback_data, 'utf8') <= 64, 'consent callback_data is within the 64-byte cap');

    // tap "Allow once" -> the paused run resumes and the write actually happens
    const acksBeforeApprove = tg.acks.length;
    tg.pushCallback(4242, 99, ckb[0][0].callback_data, 2000 + tg.sends.length + 1);
    await waitUntil(() => tg.acks.length > acksBeforeApprove, 8000, 'approval ack');
    await waitUntil(() => tg.sends.some(s => /Wrote notes\.md/.test(String(s.text || ''))), 12000, 'run resumed after approval');
    A.ok(tg.edits.some(e => /▸ ✅ Allow once/.test(String(e.text || ''))), 'the consent message is stamped with the decision and its buttons stripped');

    // the write really landed on disk — the approval had teeth, it did not merely look approved
    await waitUntil(() => fs.existsSync(path.join(ws, 'agent', 'notes.md')) || fs.existsSync(path.join(ws, 'tg_4242', 'notes.md')), 8000, 'notes.md written');
    const wrote = fs.existsSync(path.join(ws, 'agent', 'notes.md'))
      ? fs.readFileSync(path.join(ws, 'agent', 'notes.md'), 'utf8')
      : fs.readFileSync(path.join(ws, 'tg_4242', 'notes.md'), 'utf8');
    A.eq(wrote, 'hello', 'the approved write actually reached the agent workspace');

  } finally {
    try { child.kill(); } catch (_) {}
    await new Promise(r => tg.close(r));
    await new Promise(r => llm.server.close(r));
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  // AFTER cleanup: report() exits the process, so it must not run before the child/servers are torn down.
  A.report('channels.telegram.buttons.e2e.test');
})().catch(e => { console.log('FAIL: channels.telegram.buttons.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
