/* node test/channels.telegram.media.test.js — OUTBOUND media + bot-token redaction (2026-07-29).

   P1 of docs/TELEGRAM_PARITY_PLAN.md and the biggest functional hole in the channel: the agent could RECEIVE a
   file and could not send one back. It would generate an image or write a report and then describe it in prose.
   The Bot API takes uploads as multipart/form-data ONLY and this transport was JSON-only, so the real lift is a
   small dependency-free multipart encoder — asserted here against exact bytes, because a framing bug in a
   hand-rolled encoder produces a 400 that reads like a server problem.

   Also covers the secret-leak class it shipped alongside: fetch renders a transport failure as
   "request to https://api.telegram.org/bot<TOKEN>/sendMessage failed", and every catch in the transport used to
   pass that straight into console.error AND into a SendResult the panel shows.

   Fake fetch throughout; no network, no clock, no rng. */
'use strict';
const A = require('./_assert.js');
const { makeTelegramTransport, MAX_CAPTION_LENGTH, MAX_ALBUM_ITEMS } = require('../sidecar/channels/telegram.transport.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeCommsTools } = require('../sidecar/tools/builtin/comms.js');

const TOKEN = '7654321:AAH-ThisLooksLikeARealBotTokenXYZ';
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// records every call; handler(url, opts, n) decides the response
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body });
    const r = handler ? handler(url, opts, calls.length) : resp(200, { ok: true, result: { message_id: 5 } });
    if (r && r.__throw) throw r.__throw;
    return r;
  };
  f.calls = calls;
  return f;
}
const bodyText = (c) => Buffer.isBuffer(c.body) ? c.body.toString('latin1') : String(c.body);
const methodOf = (c) => String(c.url).split('/').pop();

async function run() {
  // ---- A. MULTIPART FRAMING: the exact bytes, because a framing bug reads as a server error ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: { message_id: 42 } }));
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const r = await t.sendMedia('555', { kind: 'photo', buffer: png, filename: 'chart.png', mime: 'image/png', caption: 'here it is' });
    A.eq(r.ok, true, 'sendMedia reports ok');
    A.eq(r.messageId, '42', 'the new message id comes back');

    const c = f.calls[0];
    A.eq(methodOf(c), 'sendPhoto', 'kind:photo -> sendPhoto (renders inline)');
    const ct = c.opts.headers['content-type'];
    A.ok(/^multipart\/form-data; boundary=/.test(ct), 'content-type declares multipart with a boundary');
    const boundary = ct.split('boundary=')[1];
    const raw = bodyText(c);
    A.ok(raw.indexOf('--' + boundary + '\r\n') === 0, 'body opens with the declared boundary');
    A.ok(raw.indexOf('--' + boundary + '--\r\n') === raw.length - (boundary.length + 6), 'body closes with the terminating boundary');
    A.ok(/Content-Disposition: form-data; name="chat_id"\r\n\r\n555\r\n/.test(raw), 'chat_id rides as a scalar field');
    A.ok(/Content-Disposition: form-data; name="photo"; filename="chart\.png"\r\nContent-Type: image\/png\r\n\r\n/.test(raw), 'the file part carries the field, filename AND content-type');
    A.ok(raw.indexOf(png.toString('latin1')) !== -1, 'the RAW bytes are in the body, unmangled');
    A.ok(Buffer.isBuffer(c.opts.body), 'the body is a Buffer, not a string (a string would corrupt binary)');

    // an object-valued field is JSON-stringified — that is exactly what reply_markup / media[] need
    await t.sendMedia('555', { kind: 'photo', buffer: png, filename: 'a.png' }, { reply_markup: { inline_keyboard: [] } });
    A.ok(/name="reply_markup"\r\n\r\n\{"inline_keyboard":\[\]\}\r\n/.test(bodyText(f.calls[1])), 'an object field is JSON-encoded');
  }

  // ---- A2. a filename cannot break out of its own header ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: { message_id: 1 } }));
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });
    await t.sendMedia('1', { kind: 'document', buffer: Buffer.from('x'), filename: 'ev"il\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n999' });
    const raw = bodyText(f.calls[0]);
    A.eq((raw.match(/name="chat_id"/g) || []).length, 1, 'an injected header in a filename cannot forge a second chat_id field');
    A.eq(/filename="ev_il_/.test(raw), true, 'quotes and newlines in a filename are stripped, not escaped');
  }

  // ---- B. kind -> method, and an UNKNOWN kind degrades to document (never a refusal) ----
  {
    const seen = [];
    const f = fakeFetch((url) => { seen.push(String(url).split('/').pop()); return resp(200, { ok: true, result: { message_id: 1 } }); });
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });
    for (const kind of ['photo', 'document', 'video', 'audio', 'voice', 'animation', 'holograph'])
      await t.sendMedia('1', { kind: kind, buffer: Buffer.from('b'), filename: 'f' });
    A.eq(seen, ['sendPhoto', 'sendDocument', 'sendVideo', 'sendAudio', 'sendVoice', 'sendAnimation', 'sendDocument'],
      'each kind picks its method; an unknown kind falls back to sendDocument — the form that carries any bytes');
  }

  // ---- C. the caption gets the SAME markdown->HTML treatment as a message, with the same plain-text floor ----
  {
    const f = fakeFetch((url, opts, n) => n === 1
      ? resp(200, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed start tag" })
      : resp(200, { ok: true, result: { message_id: 9 } }));
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });
    const r = await t.sendMedia('1', { kind: 'photo', buffer: Buffer.from('b'), filename: 'f.png', caption: '**Q3 revenue** is up' });
    A.eq(r.ok, true, 'a rejected caption entity string RESENDS as plain text — the file is never lost over formatting');
    A.ok(/name="parse_mode"\r\n\r\nHTML/.test(bodyText(f.calls[0])), 'first attempt sent HTML');
    A.ok(/<b>Q3 revenue<\/b>/.test(bodyText(f.calls[0])), 'the caption was converted');
    A.eq(/name="parse_mode"/.test(bodyText(f.calls[1])), false, 'the resend carries no parse_mode');
    A.ok(/Q3 revenue is up/.test(bodyText(f.calls[1])), 'and the resend is stripped of the markdown punctuation');
  }

  // ---- C2. the caption is capped at the MEDIA limit (1024), not the message limit (4096) ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: { message_id: 1 } }));
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });
    await t.sendMedia('1', { kind: 'photo', buffer: Buffer.from('b'), filename: 'f', caption: 'z'.repeat(4000) });
    const cap = /name="caption"\r\n\r\n(z+)\r\n/.exec(bodyText(f.calls[0]));
    A.ok(cap, 'a caption was sent');
    A.eq(cap[1].length, MAX_CAPTION_LENGTH, 'capped at the 1024 media-caption limit — over it is a 400 and the file is lost');
  }

  // ---- D. refusals that must NOT reach the network ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: { message_id: 1 } }));
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });
    A.eq((await t.sendMedia('1', { kind: 'photo', buffer: Buffer.alloc(0) })).ok, false, 'zero bytes is refused');
    const big = await t.sendMedia('1', { kind: 'document', buffer: Buffer.alloc(51 * 1024 * 1024), filename: 'big' });
    A.eq(big.ok, false, 'over the Bot API 50MB upload cap is refused');
    A.eq(big.retryable, false, 'and refused NON-retryably — retrying an oversize file just wastes the window');
    A.ok(/too large/i.test(big.error), 'the refusal says why');
    A.eq(f.calls.length, 0, 'neither refusal touched the network');
  }

  // ---- E. ALBUMS: the attach:// indirection, the first caption only, and the 2..10 bounds ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: [{ message_id: 7 }, { message_id: 8 }] }));
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });
    A.eq((await t.sendMediaGroup('1', [{ kind: 'photo', buffer: Buffer.from('a') }])).ok, false, 'an album of 1 is refused (Telegram needs 2..10)');
    A.eq(f.calls.length, 0, 'and never hit the network');

    const r = await t.sendMediaGroup('1', [
      { kind: 'photo', buffer: Buffer.from('AAA'), filename: 'a.png', mime: 'image/png', caption: 'the set' },
      { kind: 'photo', buffer: Buffer.from('BBB'), filename: 'b.png', mime: 'image/png', caption: 'ignored' }
    ]);
    A.eq(r.ok, true, 'a 2-item album sends');
    A.eq(r.count, 2, 'and reports how many messages it became');
    const raw = bodyText(f.calls[0]);
    A.ok(/"media":"attach:\/\/file0"/.test(raw) && /"media":"attach:\/\/file1"/.test(raw), 'each item points at its own attached part');
    A.ok(/name="file0"; filename="a\.png"/.test(raw) && /name="file1"; filename="b\.png"/.test(raw), 'both files ride under the field names the media array names');
    A.eq((raw.match(/"caption"/g) || []).length, 1, 'only the FIRST caption is sent — Telegram shows one per album');

    const many = Array.from({ length: 14 }, (_, i) => ({ kind: 'photo', buffer: Buffer.from('x'), filename: i + '.png' }));
    await t.sendMediaGroup('1', many);
    A.eq((bodyText(f.calls[1]).match(/attach:\/\//g) || []).length, MAX_ALBUM_ITEMS, 'an over-long album is trimmed to Telegram\'s 10, not rejected');
  }

  // ---- F. BOT TOKEN REDACTION — the secret-leak class ----
  {
    // undici's real shape: the failing URL, token and all, inside the message
    const leak = new Error('request to https://api.telegram.org/bot' + TOKEN + '/sendMessage failed, reason: getaddrinfo ENOTFOUND');
    const f = fakeFetch(() => ({ __throw: leak }));
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });

    const r = await t.send('1', 'hi');
    A.eq(r.ok, false, 'a network failure is still a SendResult, not a throw');
    A.eq(r.error.indexOf(TOKEN), -1, 'THE TOKEN IS NOT IN THE ERROR — this string reaches console.error and the panel');
    A.ok(/redacted-bot-token/.test(r.error), 'and the redaction is visible, so nobody mistakes it for a truncated message');
    A.ok(/ENOTFOUND/.test(r.error), 'the DIAGNOSTIC half survives — redaction must not cost debuggability');

    A.eq((await t.sendMedia('1', { kind: 'photo', buffer: Buffer.from('b') })).error.indexOf(TOKEN), -1, 'sendMedia redacts too');
    A.eq((await t.getFile('f1')).error.indexOf(TOKEN), -1, 'getFile redacts too');
    A.eq((await t.getMe()).error.indexOf(TOKEN), -1, 'getMe redacts too');
    A.eq((await t.answerCallback('c1')).error.indexOf(TOKEN), -1, 'answerCallback redacts too');
    A.eq((await t.editMessage('1', '2', 'x')).error.indexOf(TOKEN), -1, 'editMessage redacts too');
    let thrown = null;
    try { await t.getUpdates({ offset: 0, timeoutSec: 1 }); } catch (e) { thrown = e; }
    A.ok(thrown, 'getUpdates still THROWS (the poll loop governs backoff off the throw)');

    // a DIFFERENT token — e.g. echoed by a proxy or a self-hosted api server — is struck by shape alone
    const f2 = fakeFetch(() => ({ __throw: new Error('proxy error for https://tg.example/bot999888777:OtherSecretTokenHere/sendMessage') }));
    const t2 = makeTelegramTransport({ fetch: f2, token: TOKEN });
    const r2 = await t2.send('1', 'hi');
    A.eq(r2.error.indexOf('OtherSecretTokenHere'), -1, 'a token this transport does NOT own is redacted by shape — a redactor that only knows its own secret sails past it');
  }

  // ---- G. the generic adapter degrades honestly for a transport that cannot upload ----
  {
    const bare = makeChannelAdapter({
      transport: { getUpdates: async () => [], send: async () => ({ ok: true }) },
      normalize: (r) => r, name: 'signal', clock: { now: () => 1 }
    });
    const r = await bare.sendMedia('1', { kind: 'photo', buffer: Buffer.from('b') });
    A.eq(r.ok, false, 'a transport without sendMedia answers ok:false instead of throwing');
    A.eq(r.retryable, false, 'NON-retryable — the channel will never grow the ability mid-run');
    A.ok(/not supported on this channel/.test(r.error), 'and says so in words the hub can pass to a human');
    A.eq((await bare.sendMediaGroup('1', [])).ok, false, 'same for albums');
  }

  // ---- H. channel.send `files`: the floor is DELIVERY — the text lands even when every upload fails ----
  {
    const sends = [], uploads = [];
    const targets = [{ target: 'tg|555', channel: 'telegram', chatId: '555', agentId: 'a1', connected: true }];
    const mk = (opts) => makeCommsTools(Object.assign({
      listTargets: () => targets,
      sendTo: (tgt, text) => { sends.push(text); return Promise.resolve({ ok: true }); },
      maxLenFor: () => 1900,
      // the host reader's contract (sidecar/egress-files.js read): a name with nothing behind it is ok:false + notFound;
      // a refusal is ok:false with its chat-safe reason and no notFound
      readFile: async (aid, rel) => rel === 'missing.png'
        ? { ok: false, error: '"missing.png" is not in your workspace', shown: 'missing.png', notFound: true }
        : rel === '../../channels/secrets.json'
          ? { ok: false, error: '"../../channels/secrets.json" climbs out of your workspace (..); only a file in your workspace can be sent', shown: '../../channels/secrets.json' }
          : { ok: true, buffer: Buffer.from('BYTES'), name: rel.split('/').pop(), mime: /\.png$/.test(rel) ? 'image/png' : 'application/pdf' },
      sendMediaTo: (tgt, item) => { uploads.push(item); return Promise.resolve({ ok: true }); }
    }, opts || {})).sendTool;

    const okRes = await mk().run({ target: 'tg|555', text: 'here is the chart', files: ['out/chart.png', 'out/report.pdf'] }, { agentId: 'a1' });
    A.eq(sends[0], 'here is the chart', 'THE TEXT GOES FIRST — a channel that cannot upload must never swallow the words');
    A.eq(uploads.map(u => u.kind), ['photo', 'document'], 'mime picks the rendering: an image is a photo, everything else a document');
    A.eq(uploads[0].filename, 'chart.png', 'the basename is what the recipient sees, not the workspace path');
    A.eq(JSON.parse(okRes.content).filesAttached, ['out/chart.png', 'out/report.pdf'], 'the result names exactly what was attached');

    // a failed upload: the text still landed, the human is TOLD in the chat, and the tool result is honest
    sends.length = 0; uploads.length = 0;
    const failRes = await mk({ sendMediaTo: () => Promise.resolve({ ok: false, error: 'telegram cannot carry files' }) })
      .run({ target: 'tg|555', text: 'the report', files: ['out/report.pdf'] }, { agentId: 'a1' });
    A.eq(sends[0], 'the report', 'the message still landed');
    A.ok(/could not be attached/.test(sends[1] || ''), 'the human is told IN THE CHAT, not just in the tool result');
    A.ok(/saved in the workspace/.test(sends[1] || ''), 'and told where the file actually is, so it is still reachable');
    A.eq(JSON.parse(failRes.content).filesAttached.length, 0, 'the model is not told it attached something it did not');
    A.ok(/NOT attached/.test(failRes.summary), 'the summary distinguishes "sent with files" from "sent, files failed"');

    // an unreadable path is refused by name, and never becomes a silent success
    sends.length = 0;
    const missRes = await mk().run({ target: 'tg|555', text: 'see attached', files: ['missing.png'] }, { agentId: 'a1' });
    A.eq(JSON.parse(missRes.content).filesAttached.length, 0, 'a file that could not be read is not reported as attached');
    A.ok(/could not be read/.test(JSON.parse(missRes.content).filesFailed.join(' ')), 'and the reason is named');
    // live-caught 2026-10-20 (sweep/channels): the in-chat note told the Commander a file that does not exist — or a
    // refused "../../channels/secrets.json" — "is saved in the workspace on the station". Only a file that was READ and
    // then failed to upload is on the station; an unreadable one must say it was not found.
    A.ok(/missing\.png/.test(sends[1] || '') && !/saved in the workspace/.test(sends[1] || ''), 'an unreadable file is never claimed to be saved on the station: ' + JSON.stringify(sends[1]));
    A.ok(/could not be found/.test(sends[1] || ''), 'the chat is told it could not be found');

    // 0.14.2 review: the 10-20 fix then told every REFUSED file "could not be found in the workspace" — a hard link or a
    // protected file is there, and a climbing name was never looked for. The station knows only that its send rules
    // refused the file, and the reader's reason, so that is what the chat is told.
    sends.length = 0;
    const refRes = await mk().run({ target: 'tg|555', text: 'see attached', files: ['../../channels/secrets.json'] }, { agentId: 'a1' });
    A.eq(JSON.parse(refRes.content).filesAttached.length, 0, 'a refused file is not reported as attached');
    A.ok(!/could not be found/.test(sends[1] || '') && !/saved in the workspace/.test(sends[1] || ''), 'a refused file is never told missing, nor saved on the station: ' + JSON.stringify(sends[1]));
    A.ok(/^Note: this file was refused by the station's send rules and was not attached — "\.\.\/\.\.\/channels\/secrets\.json" climbs out of your workspace/.test(sends[1] || ''),
      'the chat is told the send rules refused it, with the reader\'s reason: ' + JSON.stringify(sends[1]));
    sends.length = 0;
    await mk().run({ target: 'tg|555', text: 'all three', files: ['missing.png', '../../channels/secrets.json', 'out/a.png'] }, { agentId: 'a1' });
    A.eq(sends.length, 2, 'one message, then one note for the files that did not go');
    A.ok(/could not be found in the workspace, so nothing was attached — "missing\.png"\./.test(sends[1] || '') && /refused by the station's send rules/.test(sends[1] || '') && !/a\.png/.test(sends[1] || ''),
      'a missing and a refused file are each told what is known of them, and the attached one is not named: ' + JSON.stringify(sends[1]));

    // no host wiring at all -> honest refusal, message still delivered
    sends.length = 0;
    const bareRes = await makeCommsTools({
      listTargets: () => targets, sendTo: (tgt, text) => { sends.push(text); return Promise.resolve({ ok: true }); }, maxLenFor: () => 1900
    }).sendTool.run({ target: 'tg|555', text: 'hello', files: ['a.png'] }, { agentId: 'a1' });
    A.eq(sends[0], 'hello', 'unwired host still delivers the message');
    A.ok(/not wired/.test(JSON.parse(bareRes.content).filesFailed.join(' ')), 'and says attaching is not wired rather than pretending');
  }

  // ---- I. forum command scopes and Bot API-backed chat lookup are explicit and truthful ----
  {
    const f = fakeFetch((url) => {
      const method = String(url).split('/').pop();
      if (method === 'getChat') return resp(200, { ok: true, result: { id: -10042, type: 'supergroup', title: 'Build forum' } });
      return resp(200, { ok: true, result: true });
    });
    const t = makeTelegramTransport({ fetch: f, token: TOKEN });
    const menu = [{ command: 'status', description: 'Show status' }];
    const set = await t.setCommands(menu, { scope: { type: 'all_group_chats' } });
    A.eq(set.ok, true, 'forum/group command menu publishes');
    const commandPayload = JSON.parse(f.calls[0].body);
    A.eq(commandPayload.scope, { type: 'all_group_chats' }, 'Bot API receives an explicit all-group scope, which includes forum supergroups');
    A.eq(commandPayload.commands, menu, 'scope does not change the command table');
    const found = await t.chatInfo('-10042');
    A.eq(found, { ok: true, id: '-10042', type: 'supergroup', name: 'Build forum' }, 'numeric Telegram chat lookup returns the actual Bot API identity');
    const unsupported = await t.chatInfo('a_person');
    A.eq(unsupported.ok, false, 'a bare arbitrary user handle is not claimed to be a reachable chat');
    A.ok(/not arbitrary user handles/.test(unsupported.error), 'the Bot API limitation is named to the caller');
  }

  A.report('channels.telegram.media');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
