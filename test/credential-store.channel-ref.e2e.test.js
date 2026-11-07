/* node test/credential-store.channel-ref.e2e.test.js — channel records hold references: a channel's own key lives in one store,
   follows rotations, and survives in no other file (credential-store lane, step S8; family B1, credential sources; channels TODOs
   1-3; bug 3195ab5a's channel row).

   THE BUG. A channel record kept its bot's provider key and endpoint. In a browser, an own key K1 sat in channels/secrets.json and
   its .bak after the station's copy rotated and after a restart, and the bot went on resolving K1 (probe-channel-key). A key a
   sync replaced stayed in secrets.json.bak until the next channel save (probe-channel-sync). A bot's own key the page later saved
   as its copy stayed on the record, so the page's next rotation stranded it (probe-todo3 row A). On the desktop the key was kept
   nowhere, and after a restart the bot quietly ran on the station's key, or stopped.

   THE FIX (credential-store.js CHANNELS). A record holds credential: { ref, bind }. A bot's own credential lives in
   .secrets/channel-credentials.json, bound to its provider and its record. A key the station comes to hold turns its channel into
   a station reference at once. On the desktop an own key lasts for the session (decision 3), and after a restart the bot is
   refused with a sentence that names the exit, never moved onto the station's key (state 5).

   REAL sidecars, a recording upstream at one path per endpoint, and a fake Bot API: each row sends a real message through a real
   hub and reads the key and the endpoint the provider received. Every row reads the whole workspace for the key. Rows:
     1. A browser station: connect with an own key and endpoint; the station's copy rotates; restart; a sync hands the station's key;
        a provider switch (state 4); a forget, main and .bak.
     2. TODO 3: an own key the page saves as its copy, then rotates, with and without a restart: the bot resolves the new key.
     3. The desktop: an own key answers keyPersisted: false and stays off the disk, serves the session, and is refused after a
        restart, in the bot's reply and on the status line, beside a station key that is never sent. Reconnecting with none is the exit.
     4. R4, a guard: a desktop bot on a keyless endpoint of its own keeps it across a restart, as it does at trunk.
     5. Boot migration: a pre-seeded older-build file with its .bak; a half-migrated record (the key in both files); a main rewritten
        with a .bak not swept; an endpoint-only record; a record trunk purged, and a bot trunk forgot, each beside an entry.
     6. A record in the exact shape trunk's auto-start writes (probe R2) beside an entry: the bot follows the station, as it did.
     7. A torn main, an older key in the .bak, and an entry holding the newer one: the newer key stands.
     8. 3195ab5a: a starnet Telegram record with a stale endpoint delivers through a real hub to the linked URL with the device token.
     9. A sync and a forget on every other kind of record, through its own route: Discord (a sync replaces its own key, a disconnect
        keeps the credential, a purge destroys it, which trunk ignored), a generic channel and an agent-bound bot. Each seeded as trunk
        writes it; a replaced key and everything forgotten end in no file at all, .bak files included, and a restart brings none back.
    10. Review r1: a bot given a key the station keeps as a BACKUP keeps it as its own, before and after the page REMOVEs its copy,
        and the station's primary is never sent for it (RED at 86ff765db: the connect followed the station, the bot ran on the
        station's primary, and after the REMOVE it was refused).
    11. Review r1: a forget while .secrets/channel-credentials.json cannot be read answers purged:false, the status line says the key
        could not be read (not "no longer saved"), and a retry once the file reads again leaves the key in no file (RED at
        86ff765db: purged:true twice, and the key stayed in both copies).
    12. Review r1: an agent-bound bot's re-add whose record cannot be saved (secrets.json read-only) changes nothing, on the same
        provider and on a provider switch, before and after a restart (RED at e1d54e4be: the 500 said "nothing was started", but
        K2 replaced K1, and after the switch's restart the bot ran on neither).

   RED at trunk a3af8dafd, with this file copied into a scratch checkout: 54 problems, 51 ok. The first failures are row 1's: the
   connect's answer, then K1 in channels/secrets.json and its .bak, there after the rotation and the restart too, and K1 still in
   secrets.json.bak after the sync. Row 2 fails at the stranded key: the bot sends K1 after the page rotates to K2. Row 3 fails at
   the answer and at the restart, where the status line stays silent. Row 7 sends the older key. Rows 5 and 6 use the new file, so
   they read as shape failures there. Row 9 leaves each replaced key in its .bak; Discord ignores the purge, and a generic forget
   drops the token and leaves the key on the record. Row 4's and row 8's deliveries, and the agent-bound bot's forget, pass there:
   they are guards. Rows 10 to 12 came with review round 1: row 10's deliveries pass at trunk, whose record kept the key, and
   rows 11 and 12 need the channel file, which trunk does not have. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');

const IPC = 'credential-store-channel-ref-ipc-0123456789abcdef';
const K = {
  own: 'sk-or-v1-BOT-OWN-KEY-K1-0123456789abcdef0123456789',
  page: 'sk-or-v1-PAGE-COPY-KEY-K2-0123456789abcdef0123456',
  next: 'sk-or-v1-ROTATED-PAGE-KEY-K3-0123456789abcdef0123',
  older: 'sk-or-v1-OLDER-KEY-IN-THE-BAK-0123456789abcdef012',
  newer: 'sk-or-v1-NEWER-KEY-IN-THE-ENTRY-0123456789abcdef0',
  half: 'sk-or-v1-KEY-IN-BOTH-FILES-0123456789abcdef012345',
  kc: 'sk-or-v1-DESKTOP-KEYCHAIN-KEY-0123456789abcdef012',
  device: 'starnet-device-token-0123456789abcdefghijklmnop',
  dcOwn: 'sk-or-v1-DISCORD-OWN-KEY-0123456789abcdef0123456',
  dcNext: 'sk-or-v1-DISCORD-NEXT-KEY-0123456789abcdef012345',
  slOwn: 'sk-or-v1-SLACK-OWN-KEY-0123456789abcdef012345678',
  slNext: 'sk-or-v1-SLACK-NEXT-KEY-0123456789abcdef01234567',
  botOwn: 'sk-or-v1-AGENT-BOT-OWN-KEY-0123456789abcdef01234',
  poolBot: 'sk-or-v1-BOT-OWN-KEY-ALSO-A-STATION-BACKUP-0123',
  lockOwn: 'sk-or-v1-BOT-OWN-KEY-IN-A-LOCKED-FILE-0123456789',
  addOne: 'sk-or-v1-AGENT-BOT-FIRST-ADD-KEY-0123456789abcdef',
  addTwo: 'sk-or-v1-AGENT-BOT-FAILED-RE-ADD-KEY-0123456789ab'
};
const TOKEN = '123456:CHANNEL-REF-BOT-TOKEN', MODEL = 'test/model', LOCAL = 'local-model';
const OWN_FILES = ['.secrets/channel-credentials.json', '.secrets/channel-credentials.json.bak'];
// a record that cannot be replaced: on POSIX a rename ignores the file's own mode, so its folder is read-only too
const lockRecord = f => { fs.chmodSync(f, 0o444); if (process.platform !== 'win32') fs.chmodSync(path.dirname(f), 0o555); };
const unlockRecord = f => { if (process.platform !== 'win32') fs.chmodSync(path.dirname(f), 0o755); fs.chmodSync(f, 0o644); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, label, ms) {
  const until = Date.now() + (ms || 30000);
  while (Date.now() < until) { if (await pred()) return true; await sleep(100); }
  A.ok(false, 'timed out waiting: ' + label);
  return false;
}
// every file in the workspace that holds this value, .bak files included
function holders(dir, needle) {
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }   // a store's temp file, gone since the listing
      if (text.includes(needle)) hits.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  })(dir);
  return hits.sort();
}
const once = list => Array.from(new Set(list.map(x => JSON.stringify(x)))).map(x => JSON.parse(x));

// ---- the recording upstream: one path per endpoint, so each request's endpoint is on record beside its key ----
function recorder() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      seen.push({ path: req.url, key, body: raw });
      if (/^\/cloud\//.test(req.url) && /\/balance/.test(req.url)) return json({ balanceUsd: 50 });
      if (/^\/cloud\//.test(req.url) && /\/(?:debit|credit)$/.test(req.url)) return json({ ok: true, balanceUsd: 50 });
      if (/^\/cloud\//.test(req.url) && !/\/chat\/completions|\/models/.test(req.url)) return json({ entries: [] });
      if (/\/models(?:\?|$)/.test(req.url)) return json({ data: [MODEL, LOCAL].map(id => ({ id, context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] })) });
      if (!/\/chat\/completions/.test(req.url)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, base: 'http://127.0.0.1:' + server.address().port })));
}
// the chat requests one message sent, by the marker in its text: [endpoint path prefix, key]
const sentFor = (up, marker) => up.seen.filter(s => /\/chat\/completions/.test(s.path) && s.body.includes(marker)).map(s => [(/^\/[a-z0-9-]+\//.exec(s.path) || [s.path])[0], s.key]);

// ---- the fake Bot API: long polls, and what the bot said ----
function fakeTelegram() {
  const sends = [], queued = [], waiters = [];
  let updateId = 1000, messageId = 2000;
  const answer = (res, value) => { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); } catch (_) {} };
  const flush = () => { while (queued.length && waiters.length) answer(waiters.shift(), { ok: true, result: [queued.shift()] }); };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const method = String(req.url || '').split('/').pop();
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
      if (method === 'getUpdates') {
        if (body.offset === -1) return answer(res, { ok: true, result: [] });
        if (queued.length) return answer(res, { ok: true, result: [queued.shift()] });
        waiters.push(res);
        res.on('close', () => { const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      if (method === 'sendMessage') { sends.push(body); return answer(res, { ok: true, result: { message_id: ++messageId } }); }
      if (method === 'getMe') return answer(res, { ok: true, result: { id: 777, is_bot: true, username: 'ref_bot', first_name: 'Ref' } });
      answer(res, { ok: true, result: true });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, sends, polling: () => waiters.length > 0, base: 'http://127.0.0.1:' + server.address().port,
    pushText(chatId, userId, text) {
      queued.push({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text } });
      flush();
    } })));
}

// nothing the test runner exports may stand in for a key, an endpoint or a link
const AMBIENT = ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE', 'CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY', 'CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'DESKTOP_SHELL', 'IPC_TOKEN', 'CREDITS_URL', 'CREDITS_TOKEN', 'CLOUD_URL', 'TELEGRAM_TOKEN', 'API_KEY', 'DEFAULT_MODEL', 'FALLBACK_MODELS'];
const pair = (name, value) => ({ ['SKYNET_' + name]: value, ['STARNET_' + name]: value });
function station(label, up, tg, env) {
  const blank = {};
  for (const n of AMBIENT) { blank[n] = ''; blank['STARNET_' + n] = ''; blank['SKYNET_' + n] = ''; }
  const fx = SidecarFixture.create({ prefix: 'cs-channel-ref-' + label + '-', timeoutMs: 45000, env: Object.assign(blank, {
    STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_AUX_BUDGET: '0',
    STARNET_OPENROUTER_BASE: up.base + '/or/api/v1',   // the station's own OpenRouter endpoint: never the real one
    STARNET_TELEGRAM_API_BASE: tg.base, SKYNET_TELEGRAM_API_BASE: tg.base
  }, env) });
  const ws = fx.workspace;
  const api = {
    fx, ws,
    seed(rel, value) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), typeof value === 'string' ? value : JSON.stringify(value));
    },
    record: id => { try { return JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'secrets.json'), 'utf8'))[id]; } catch (_) { return null; } },
    entry: id => { try { return JSON.parse(fs.readFileSync(path.join(ws, OWN_FILES[0]), 'utf8')).channels[id]; } catch (_) { return null; } },
    roster: agents => fx.json('POST', '/api/roster', { agents: Object.keys(agents).map(id => ({ agentId: id, name: id.toUpperCase(), system: 'x', provider: agents[id], model: agents[id] === 'custom' ? LOCAL : MODEL })), updatedAt: Date.now() }),
    engineKey: body => fx.json('POST', '/api/providers/engine-key', body),
    async connect(body) {
      const c = await fx.json('POST', '/api/channels/telegram/connect', Object.assign({ token: TOKEN, agentId: 'bot', provider: 'openrouter', model: MODEL }, body));
      A.eq(c.status, 200, label + ': the bot connects: ' + c.text.slice(0, 240));
      await waitFor(() => tg.polling(), label + ': the bot polls');
      if (c.body && c.body.pairingCode) {
        const seen = tg.sends.length;
        tg.pushText(4242, 99, '/pair ' + c.body.pairingCode);
        await waitFor(() => tg.sends.slice(seen).some(m => /Owner paired/i.test(String(m.text || ''))), label + ': the owner pairs');
      }
      return c;
    },
    // one message through the real hub: what the provider received. It waits for the bot's answer: a restart while a run is open
    // has the station replay the message, which is another story
    async dm(marker) {
      const from = tg.sends.length;
      await waitFor(() => tg.polling(), label + ': the bot polls');
      tg.pushText(4242, 99, marker + ' say done');
      await waitFor(() => sentFor(up, marker).length > 0, label + ': ' + marker + ' reaches an upstream');
      await waitFor(() => tg.sends.slice(from).some(m => /\bdone\b/.test(String(m.text || ''))), label + ': the bot answers ' + marker);
      if (!sentFor(up, marker).length) console.error('CHANNEL_REF_ADMISSION ' + JSON.stringify({ marker,
        replies: tg.sends.slice(from).map(m => String(m.text || '')), output: fx.output().slice(-2000) }));
      return once(sentFor(up, marker));
    },
    // one message the bot refuses: what it says back
    async refused(marker) {
      const from = tg.sends.length;
      await waitFor(() => tg.polling(), label + ': the bot polls');
      tg.pushText(4242, 99, marker + ' say done');
      await waitFor(() => tg.sends.length > from, label + ': the bot answers ' + marker);
      return tg.sends.slice(from).map(m => String(m.text || '')).join('\n');
    },
    // a restart that names no window and hands nothing over
    async restart() { await fx.restart(); await waitFor(() => /telegram auto-started/.test(fx.output()), label + ': the bot auto-starts'); }
  };
  return api;
}

(async () => {
  const up = await recorder();
  const tg = await fakeTelegram();
  const live = [];
  const open = async (label, env, seed) => {
    while (live.length) await live.pop().fx.dispose().catch(() => {});
    await waitFor(() => !tg.polling(), 'the last station stops polling');
    const s = station(label, up, tg, env);
    live.push(s);
    if (seed) seed(s);
    await s.fx.start();
    return s;
  };
  // a row that throws stops itself, not the rows after it
  const row = async (label, fn) => {
    try { await fn(); }
    catch (e) { A.ok(false, 'row ' + label + ' threw: ' + ((e && e.stack) || e) + '\n' + live.map(s => s.fx.output().slice(-1500)).join('\n----\n')); }
  };
  try {
    /* ================= 1. a browser station: connect, rotate, restart, sync, switch, forget ================= */
    await row('1', async () => {
      const U = up.base + '/own/v1';
      const s = await open('browser');
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'the roster is saved');
      const first = await s.connect({ key: K.own, baseUrl: U });
      A.eq(first.body.keyPersisted, true, 'connect: the answer says the bot\'s own key is kept');
      const onlyOwnFiles = tag => {
        A.eq(holders(s.ws, K.own), OWN_FILES, tag + ': the own key is in the channel file, both copies, and no other file in the workspace');
        A.eq(holders(s.ws, U), OWN_FILES, tag + ': ...and its endpoint with it');
      };
      onlyOwnFiles('connect');
      const rec = s.record('telegram');
      A.ok(rec && rec.credential && rec.credential.ref === 'channel' && !!rec.credential.bind && !('key' in rec) && !('baseUrl' in rec), 'connect: the record holds a reference: ' + JSON.stringify(rec));
      A.eq([(s.entry('telegram') || {}).provider, (s.entry('telegram') || {}).bind], ['openrouter', (rec.credential || {}).bind], 'connect: the entry is bound to its provider and its record');
      A.eq(await s.dm('OWN-CONNECT'), [['/own/', K.own]], 'connect: the bot runs on its own key at its own endpoint');

      A.eq((await s.engineKey({ provider: 'openrouter', key: K.page })).status, 200, 'the station\'s copy changes');
      onlyOwnFiles('rotation');
      A.eq(await s.dm('OWN-ROTATED'), [['/own/', K.own]], 'rotation: the bot\'s own key is its own: it stays on it');

      await s.restart();
      onlyOwnFiles('restart');
      A.eq(await s.dm('OWN-RESTART'), [['/own/', K.own]], 'restart: the bot resolves its own key, with no page');

      const synced = await s.fx.json('POST', '/api/channels/telegram/sync', { key: K.page, provider: 'openrouter', model: MODEL, agentId: 'bot' });
      A.eq([synced.status, synced.body.persisted], [200, true], 'the page syncs the station\'s key');
      A.eq(holders(s.ws, K.own), [], 'sync: the replaced key is in no file at all, .bak files included (trunk kept it in secrets.json.bak)');
      A.eq(holders(s.ws, U), [], 'sync: ...nor is its endpoint');
      A.eq(s.record('telegram').credential, { ref: 'station' }, 'sync: the record follows the station');
      A.eq(await s.dm('SYNCED'), [['/or/', K.page]], 'sync: the bot runs the station\'s key');
      await s.restart();
      A.eq([holders(s.ws, K.own), await s.dm('SYNCED-RESTART')], [[], [['/or/', K.page]]], 'sync: ...after a restart too');

      // state 4: a provider switch drops the bot's own key
      await s.connect({ key: K.own, baseUrl: U });
      onlyOwnFiles('reconnect');
      A.eq((await s.roster({ bot: 'custom', other: 'openrouter' })).status, 200, 'the agent moves to CUSTOM');
      const switched = await s.fx.json('POST', '/api/channels/telegram/sync', { provider: 'custom', model: LOCAL, agentId: 'bot' });
      A.eq(switched.status, 200, 'the sync switches provider');
      A.eq([holders(s.ws, K.own), holders(s.ws, U)], [[], []], 'state 4: a switch of provider drops the own key and endpoint from every file');
      const noCustom = await s.refused('SWITCHED');
      A.ok(/CUSTOM/.test(noCustom) && !up.seen.some(r => /\/chat\/completions/.test(r.path) && r.body.includes('SWITCHED')), 'state 4: the bot is refused for the new provider, and its old key goes nowhere: ' + noCustom);
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'the agent moves back');

      // a forget: main and .bak
      await s.connect({ key: K.own, baseUrl: U, provider: 'openrouter', model: MODEL });
      onlyOwnFiles('connect again');
      const forgot = await s.fx.json('POST', '/api/channels/telegram/disconnect', { purge: true });
      A.eq([forgot.status, forgot.body.purged], [200, true], 'forget: the answer claims it');
      A.eq([holders(s.ws, K.own), holders(s.ws, U)], [[], []], 'forget: the key and the endpoint are in no file at all, the channel file\'s .bak included');
      A.eq(s.entry('telegram'), undefined, 'forget: the entry is gone');
      A.ok(!s.fx.output().includes(K.own) && !s.fx.output().includes(K.page), 'the sidecar log carries neither key');
    });

    /* ================= 2. TODO 3: a bot's own key the page saves as its copy ================= */
    await row('2', async () => {
      const s = await open('todo3');
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'TODO 3: the roster is saved');
      // row A: no restart
      await s.connect({ key: K.own });
      A.eq((await s.engineKey({ provider: 'openrouter', key: K.own })).status, 200, 'TODO 3: the page saves the bot\'s key as its copy');
      A.eq(s.record('telegram').credential, { ref: 'station' }, 'TODO 3: the channel turns into a station reference at once, with no sync and no restart');
      A.eq(holders(s.ws, K.own), ['.secrets/provider-keys.json', '.secrets/provider-keys.json.bak'], 'TODO 3: the key has one home, the page copy (trunk kept it on the record)');
      A.eq((await s.engineKey({ provider: 'openrouter', key: K.page })).status, 200, 'TODO 3: the page rotates its copy');
      A.eq(holders(s.ws, K.own), [], 'TODO 3: the rotated key is stranded nowhere');
      A.eq(await s.dm('TODO3-A'), [['/or/', K.page]], 'TODO 3: the rotation reaches the bot with no sync and no restart');
      // row B: a restart between the save and the rotation
      await s.connect({ key: K.next });
      A.eq((s.record('telegram').credential || {}).ref, 'channel', 'TODO 3: the bot has an own key again');
      A.eq((await s.engineKey({ provider: 'openrouter', key: K.next })).status, 200, 'TODO 3: the page saves it');
      await s.restart();
      A.eq((await s.engineKey({ provider: 'openrouter', key: K.older })).status, 200, 'TODO 3: the page rotates after a restart');
      A.eq(await s.dm('TODO3-B'), [['/or/', K.older]], 'TODO 3: with a restart between, the bot resolves the rotated key too');
      A.eq(holders(s.ws, K.next), [], 'TODO 3: ...and the old one is in no file');
    });

    /* ================= 3. the desktop: an own key lasts for the session (decision 3, state 5) ================= */
    await row('3', async () => {
      const desktop = { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC), ...pair('OPENROUTER_KEY', K.kc) };
      const s = await open('desktop', desktop);
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'desktop: the roster is saved');
      const c = await s.connect({ key: K.own });
      A.eq(c.body.keyPersisted, false, 'desktop: the connect answers keyPersisted: false');
      A.eq(holders(s.ws, K.own), [], 'desktop: the own key is on no disk');
      A.eq([(s.entry('telegram') || {}).ownKey, 'key' in (s.entry('telegram') || {})], [true, false], 'desktop: the entry records that the bot was given one, and holds no key');
      A.eq(await s.dm('DESKTOP-SESSION'), [['/or/', K.own]], 'desktop: it serves for the session');
      await s.restart();
      const said = await s.refused('DESKTOP-REFUSED');
      const SENTENCE = 'this bot\'s own OPENROUTER key was kept for that session only — reconnect it with its key, or with none to use the station\'s';
      A.ok(said.includes(SENTENCE), 'desktop: after a restart the bot is refused with the sentence: ' + said);
      A.eq(sentFor(up, 'DESKTOP-REFUSED'), [], 'desktop: ...and nothing goes out: it never moves onto the station\'s key (trunk sent it)');
      A.eq((await s.fx.json('GET', '/api/channels/status')).body.telegram.warning, SENTENCE, 'desktop: the channel\'s status line says so');
      await s.connect({ provider: 'openrouter', model: MODEL });
      A.eq(s.record('telegram').credential, { ref: 'station' }, 'exit: reconnected with none, the bot follows the station');
      A.eq(await s.dm('DESKTOP-EXIT'), [['/or/', K.kc]], 'exit: ...and runs the keychain key');
      A.eq(s.entry('telegram'), undefined, 'exit: the entry is gone');
      A.ok(!up.seen.some(r => r.key === K.own && r.body.includes('DESKTOP-REFUSED')), 'desktop: the own key was not sent either');
    });

    /* ================= 4. R4, a guard: a desktop bot on a keyless endpoint of its own ================= */
    await row('4', async () => {
      const Ubot = up.base + '/bot/v1';
      const s = await open('r4', { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC) });
      A.eq((await s.roster({ bot: 'custom' })).status, 200, 'R4: the roster is saved');
      await s.connect({ provider: 'custom', model: LOCAL, baseUrl: Ubot });
      A.eq(await s.dm('R4-CONNECT'), [['/bot/', '']], 'R4: the bot runs keyless at its own endpoint');
      await s.restart();
      A.eq(await s.dm('R4-RESTART'), [['/bot/', '']], 'R4: ...across a restart');
      A.eq(holders(s.ws, Ubot).filter(f => /secrets\.json/.test(f)), [], 'R4: its endpoint left secrets.json and its .bak');
      A.eq(holders(s.ws, Ubot), OWN_FILES, 'R4: ...and is kept in the channel file, on the desktop too (a URL is not a key)');
    });

    /* ================= 5. boot migration of an older build's file ================= */
    await row('5', async () => {
      const U = up.base + '/own/v1', Uend = up.base + '/matrix-bot/v1';
      const ref = bind => ({ ref: 'channel', bind });
      const entry = (bind, extra) => Object.assign({ provider: 'openrouter', bind, ownKey: true, rev: 1 }, extra);
      const base = { provider: 'openrouter', model: MODEL, enabled: false, agentId: 'bot' };
      const s = await open('migration', {}, x => {
        x.seed('channels/secrets.json', {
          telegram: { token: TOKEN, key: K.own, baseUrl: U, provider: 'openrouter', model: MODEL, reasoningEffort: 'medium', enabled: true, agentId: 'bot', ownerId: '99' },   // 1c, with an older copy in its .bak
          discord: Object.assign({ token: 'dc', credential: ref('d1') }, base),     // main rewritten, .bak not swept
          slack: Object.assign({ token: 'xoxb-1 xapp-1', key: K.half }, base),      // half-migrated: the key in both files
          matrix: Object.assign({ endpoint: 'http://127.0.0.1:9', baseUrl: Uend }, base),   // an endpoint of its own, no key
          signal: Object.assign({ endpoint: 'http://127.0.0.1:9', account: '+15550001111' }, base, { token: undefined }),   // what a forget on trunk leaves
          notifyAutonomous: true
        });
        x.seed('channels/secrets.json.bak', { telegram: { token: TOKEN, key: K.older, provider: 'openrouter', model: MODEL, enabled: true }, discord: Object.assign({ key: K.newer, baseUrl: Uend }, base) });
        const channels = { discord: entry('d1', { key: K.next }), slack: entry('s0', { key: K.older }), signal: entry('g1', { key: K.next.replace('K3', 'K4') }), 'telegramBots:42': entry('b1', { key: K.next.replace('K3', 'K5') }) };
        x.seed(OWN_FILES[0], { version: 1, channels });
        x.seed(OWN_FILES[1], { version: 1, channels });
      });
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'migration: the roster is saved');
      A.eq(holders(s.ws, K.own), OWN_FILES, 'migration: an older build\'s own key moved to the channel file, both copies, and left every other');
      A.eq(holders(s.ws, K.older), [], 'migration: the older key in the .bak is gone, the half-migrated entry\'s too');
      A.eq(holders(s.ws, K.newer), [], 'migration: a .bak not swept: its key goes');
      A.eq(holders(s.ws, K.half), OWN_FILES, 'migration: half-migrated: the key read from main replaces the entry');
      A.eq(holders(s.ws, K.next), OWN_FILES, 'migration: an entry that matches its record stays');
      A.eq([holders(s.ws, K.next.replace('K3', 'K4')), holders(s.ws, K.next.replace('K3', 'K5'))], [[], []], 'migration: the entries of a record trunk purged and a bot trunk forgot are deleted');
      A.ok(!holders(s.ws, U).concat(holders(s.ws, Uend)).some(f => !OWN_FILES.includes(f)), 'migration: no endpoint is left outside the channel file');
      const main = JSON.parse(fs.readFileSync(path.join(s.ws, 'channels', 'secrets.json'), 'utf8')), bak = JSON.parse(fs.readFileSync(path.join(s.ws, 'channels', 'secrets.json.bak'), 'utf8'));
      A.eq(['telegram', 'discord', 'slack', 'matrix'].map(id => main[id].credential.ref).concat(main.signal.credential.ref), ['channel', 'channel', 'channel', 'channel', 'station'], 'migration: each record holds a reference');
      A.ok(['telegram', 'discord', 'slack', 'matrix', 'signal'].every(id => !['key', 'baseUrl', 'base_url', 'keyPool'].some(f => f in main[id] || f in (bak[id] || {}))), 'migration: no record keeps a key or an endpoint, in main or .bak');
      A.eq([main.notifyAutonomous, main.telegram.token, bak.telegram.token, main.telegram.ownerId], [true, TOKEN, TOKEN, '99'], 'migration: the rest stands, and a browser\'s bot token stays in both');
      A.eq(s.entry('matrix').ownKey, false, 'migration: an endpoint-only record becomes an endpoint-only entry');
      A.eq(await s.dm('MIGRATED'), [['/own/', K.own]], 'migration: the bot resolves the same key after it as before it, at the same endpoint');
      const before = fs.readFileSync(path.join(s.ws, OWN_FILES[0]), 'utf8'), mainBefore = fs.readFileSync(path.join(s.ws, 'channels', 'secrets.json'), 'utf8');
      await s.restart();
      A.eq(fs.readFileSync(path.join(s.ws, OWN_FILES[0]), 'utf8'), before, 'migration: running it again leaves the channel file as it is');
      A.eq(fs.readFileSync(path.join(s.ws, 'channels', 'secrets.json'), 'utf8').length, mainBefore.length, '...and the records');
      A.eq(await s.dm('MIGRATED-RESTART'), [['/own/', K.own]], 'migration: ...and the bot runs on');
    });

    /* ================= 6. the exact shape trunk's auto-start writes (probe R2), beside an entry ================= */
    await row('6', async () => {
      const s = await open('r2', {}, x => {
        x.seed('.secrets/provider-keys.json', { version: 1, providers: { openrouter: { key: K.page, rev: 'a1' } } });
        x.seed('.secrets/provider-keys.json.bak', { version: 1, providers: { openrouter: { key: K.page, rev: 'a1' } } });
        x.seed('channels/secrets.json', { telegram: { baseUrl: '', enabled: true, key: '', model: MODEL, provider: 'openrouter', reasoningEffort: 'medium', token: TOKEN, agentId: 'bot', ownerId: '99' } });
        const channels = { telegram: { provider: 'openrouter', bind: 'b1', ownKey: true, key: K.own, rev: 1 } };
        x.seed(OWN_FILES[0], { version: 1, channels });
        x.seed(OWN_FILES[1], { version: 1, channels });
      });
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'R2: the roster is saved');
      A.eq([s.record('telegram').credential, holders(s.ws, K.own)], [{ ref: 'station' }, []], 'R2: a record an older build rewrote follows the station, as it did there, and leaves no orphan');
      A.eq(await s.dm('R2-REWRITE'), [['/or/', K.page]], 'R2: the bot runs the station\'s key');
    });

    /* ================= 7. a torn main: the entry holds the newer key ================= */
    await row('7', async () => {
      const s = await open('torn', {}, x => {
        x.seed('channels/secrets.json', '{"telegram":{"tok');
        x.seed('channels/secrets.json.bak', { telegram: { token: TOKEN, key: K.older, provider: 'openrouter', model: MODEL, enabled: true, agentId: 'bot', ownerId: '99' } });
        const channels = { telegram: { provider: 'openrouter', bind: 'b1', ownKey: true, key: K.newer, rev: 2 } };
        x.seed(OWN_FILES[0], { version: 1, channels });
        x.seed(OWN_FILES[1], { version: 1, channels });
      });
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'torn: the roster is saved');
      A.eq(await s.dm('TORN-MAIN'), [['/or/', K.newer]], 'torn: a .bak recovery never rolls the newer entry back');
      A.eq([holders(s.ws, K.older), holders(s.ws, K.newer)], [[], OWN_FILES], 'torn: the older key leaves main and .bak');
    });

    /* ================= 8. 3195ab5a: a starnet Telegram record with a stale endpoint, through a real hub ================= */
    await row('8', async () => {
      const stale = up.base + '/stale/v1', cloud = up.base + '/cloud';
      const s = await open('starnet', { STARNET_CLOUD_URL: cloud }, x => {
        x.seed('.secrets/credits.json', { url: cloud, deviceToken: K.device, accountId: 'fixture-account', linkedAt: Date.now() });
        x.seed('channels/secrets.json', { telegram: { token: TOKEN, key: 'stale-record-key-0123456789', baseUrl: stale, provider: 'starnet', model: MODEL, enabled: true, agentId: 'bot', ownerId: '99' } });
      });
      A.eq((await s.roster({ bot: 'starnet' })).status, 200, '3195ab5a: the roster is saved');
      A.eq(await s.dm('LINKED-TELEGRAM'), [['/cloud/', K.device]], '3195ab5a: a Telegram message on a starnet record with a stale endpoint goes to the linked URL with the device token');
      A.eq(up.seen.filter(r => /^\/stale\//.test(r.path)).map(r => r.path), [], '3195ab5a: nothing reached the stale endpoint');
      A.ok(!up.seen.some(r => r.key === 'stale-record-key-0123456789'), '3195ab5a: ...and the stale key went nowhere');
    });

    /* ================= 9. a sync and a forget on every other kind of record: Discord, a generic channel, an agent-bound bot ================= */
    await row('9', async () => {
      const Ud = up.base + '/forget-discord/v1', Us = up.base + '/forget-slack/v1', Ub = up.base + '/forget-bot/v1';
      const base = { provider: 'openrouter', model: MODEL, enabled: false, agentId: 'bot' };   // disabled: nothing here dials a gateway
      const s = await open('forget', {}, x => {
        const records = {
          discord: Object.assign({ token: 'DISCORD-FORGET-TOKEN', key: K.dcOwn, baseUrl: Ud }, base),
          slack: Object.assign({ token: 'xoxb-FORGET-TOKEN xapp-FORGET-TOKEN', key: K.slOwn, baseUrl: Us }, base),
          telegramBots: { 42: Object.assign({ token: '42:FORGET-BOT-TOKEN', username: 'forget_bot', key: K.botOwn, baseUrl: Ub }, base) }
        };
        x.seed('channels/secrets.json', records);
        x.seed('channels/secrets.json.bak', records);
      });
      const inNoFile = (tag, values) => A.eq(values.map(v => holders(s.ws, v)), values.map(() => []), tag + ': neither the key, the endpoint nor the bot token is in any file, .bak files included');
      A.eq([K.dcOwn, K.slOwn, K.botOwn].map(k => holders(s.ws, k)), [OWN_FILES, OWN_FILES, OWN_FILES], 'forget: each own key moved to the channel file at boot');

      // a sync with a new key of the bot's own: the old key, and the endpoint that went with it, are in no file at all (trunk kept them in the .bak)
      for (const [id, oldKey, newKey, oldBase] of [['discord', K.dcOwn, K.dcNext, Ud], ['slack', K.slOwn, K.slNext, Us]]) {
        const re = await s.fx.json('POST', '/api/channels/' + id + '/sync', { key: newKey, provider: 'openrouter', model: MODEL, agentId: 'bot' });
        A.eq([re.status, re.body.persisted, re.body.keyPersisted], [200, true, true], id + ': the sync says the new key is kept');
        A.eq([holders(s.ws, oldKey), holders(s.ws, oldBase), holders(s.ws, newKey)], [[], [], OWN_FILES], id + ': the replaced key and its endpoint are in no file, .bak files included; the new key is in the channel file alone');
      }

      // DISCONNECT keeps what a reconnect needs: only FORGET destroys it
      const off = await s.fx.json('POST', '/api/channels/discord/disconnect', {});
      A.eq([off.status, off.body.purged, holders(s.ws, K.dcNext), (s.record('discord').credential || {}).ref], [200, false, OWN_FILES, 'channel'], 'Discord: a disconnect keeps the bot\'s own credential');
      const dc = await s.fx.json('POST', '/api/channels/discord/disconnect', { purge: true });
      A.eq([dc.status, dc.body.purged], [200, true], 'Discord: the forget claims it (the panel always sent purge, and trunk ignored it)');
      inNoFile('Discord forget', [K.dcNext, 'DISCORD-FORGET-TOKEN']);
      A.eq(s.entry('discord'), undefined, 'Discord forget: the entry is gone');
      A.eq([K.slNext, K.botOwn].map(k => holders(s.ws, k)), [OWN_FILES, OWN_FILES], 'Discord forget: ...and only its own: the other bots keep theirs');

      const sl = await s.fx.json('POST', '/api/channels/slack/disconnect', { purge: true });
      A.eq([sl.status, sl.body.purged], [200, true], 'Slack: the forget claims it');
      inNoFile('Slack forget', [K.slNext, 'xoxb-FORGET-TOKEN']);

      const bot = await s.fx.json('POST', '/api/channels/telegram/bots/42/disconnect', { purge: true });
      A.eq([bot.status, bot.body.purged], [200, true], 'an agent-bound bot: the forget claims it');
      inNoFile('agent-bound bot forget', [K.botOwn, Ub, '42:FORGET-BOT-TOKEN']);
      A.ok(!s.entry('telegramBots:42'), 'agent-bound bot forget: no entry is left');

      await s.fx.restart();
      inNoFile('after a restart', [K.dcNext, K.slNext, K.botOwn, Ud, Us, Ub]);
    });

    /* ================= 10. a bot given a key that is also one of the station's backup keys keeps it ================= */
    await row('10', async () => {
      const s = await open('pool-key');
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'pool key: the roster is saved');
      const saved = await s.engineKey({ provider: 'openrouter', key: K.page, keyPool: [K.poolBot] });
      A.eq([saved.status, saved.body.saved && saved.body.saved.alternates], [200, 1], 'pool key: the page saves its copy, with the bot\'s key among its backups');
      const c = await s.connect({ key: K.poolBot });
      A.eq([c.body.keyPersisted, (s.record('telegram').credential || {}).ref, (s.entry('telegram') || {}).key === K.poolBot], [true, 'channel', true],
        'pool key: the connect keeps the key it was handed as the bot\'s own (the gate judged it the bot\'s; a backup key is not the station\'s)');
      A.eq(await s.dm('POOL-KEY-OWN'), [['/or/', K.poolBot]], 'pool key: the bot runs on the key it was given, never the station\'s primary (another account)');
      A.eq((await s.engineKey({ provider: 'openrouter', key: '', keyPool: [], baseUrl: '' })).status, 200, 'pool key: the page REMOVEs its copy');
      A.eq(await s.dm('POOL-KEY-AFTER-REMOVE'), [['/or/', K.poolBot]], 'pool key: ...and the bot keeps running on its own key, as it did before the store');
      A.ok(!up.seen.some(r => r.key === K.page && /POOL-KEY-/.test(r.body)), 'pool key: the station\'s primary is never sent for the bot');
    });

    /* ================= 11. a forget while the channel file cannot be read ================= */
    await row('11', async () => {
      const s = await open('unreadable', {}, x => {
        x.seed('channels/secrets.json', { telegram: { token: TOKEN, key: K.lockOwn, provider: 'openrouter', model: MODEL, enabled: false, agentId: 'bot', ownerId: '99' } });
      });
      A.eq(holders(s.ws, K.lockOwn), OWN_FILES, 'unreadable: the boot moved the bot\'s own key into the channel file, both copies');
      await s.fx.stop();
      // the file is closed to the station, as when an antivirus scan or a backup agent holds it open with no sharing (EBUSY): a
      // directory stands where it was (EISDIR), and the two copies wait outside the workspace
      const chanFile = path.join(s.ws, OWN_FILES[0]);
      const aside = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-channel-ref-aside-'));
      fs.renameSync(chanFile, path.join(aside, 'main'));
      fs.renameSync(chanFile + '.bak', path.join(aside, 'bak'));
      fs.mkdirSync(chanFile);
      try {
        await s.fx.start();
        const UNREADABLE = 'this bot\'s own OPENROUTER key could not be read on this station just now (.secrets/channel-credentials.json is locked or unreadable) — it is read again with the next message; if that keeps failing, close whatever holds the file open, or reconnect the bot with its key';
        A.eq((await s.fx.json('GET', '/api/channels/telegram/status')).body.warning, UNREADABLE, 'unreadable: the status line says the key could not be read, never that it is no longer saved');
        const forgot = await s.fx.json('POST', '/api/channels/telegram/disconnect', { purge: true });
        A.eq([forgot.status, forgot.body.purged, forgot.body.persisted], [200, false, false], 'unreadable: a forget cannot prove the key left the file, and its answer says so (86ff765db answered purged:true)');
        A.ok(/channel-credentials\.json could not be read/.test(s.fx.output()), 'unreadable: the log says the file could not be read');
      } finally {
        // the lock clears while the station runs
        fs.rmdirSync(chanFile);
        fs.renameSync(path.join(aside, 'main'), chanFile);
        fs.renameSync(path.join(aside, 'bak'), chanFile + '.bak');
        fs.rmdirSync(aside);
      }
      A.eq(holders(s.ws, K.lockOwn), OWN_FILES, 'unreadable: the key is still in both copies once the file is back: nothing claimed otherwise');
      const retried = await s.fx.json('POST', '/api/channels/telegram/disconnect', { purge: true });
      A.eq([retried.status, retried.body.purged], [200, true], 'the file reads again: the Commander\'s retried forget claims it');
      A.eq(holders(s.ws, K.lockOwn), [], '...and the key is in no file at all, the channel file\'s .bak included');
    });

    /* ================= 12. an agent-bound bot's re-add whose record cannot be saved changes nothing ================= */
    await row('12', async () => {
      // A non-hero bot must survive a real restart. Before founding, roster pushes are deliberately
      // live-only; that stationless policy is not a credential-store persistence failure.
      const s = await open('read-only', {}, x => seedActiveStation(x.ws));
      const rosterSaved = await s.roster({ bot: 'openrouter' });
      A.eq([rosterSaved.status, rosterSaved.body.held === true], [200, false], 'read-only: the founded station persists its roster');
      A.ok(JSON.parse(fs.readFileSync(path.join(s.ws, 'agent.roster.json'), 'utf8')).agents.some(a => a.agentId === 'bot'),
        'read-only: the non-hero bot is actually on the durable roster before restart');
      const add = body => s.fx.json('POST', '/api/channels/telegram/bots/connect', Object.assign({ token: '777:CHANNEL-REF-AGENT-BOT', agentId: 'bot', provider: 'openrouter', model: MODEL }, body));
      const first = await add({ key: K.addOne });
      A.eq([first.status, first.body.keyPersisted], [200, true], 'read-only: the agent-bound bot is added with its own key K1: ' + first.text.slice(0, 200));
      await waitFor(() => tg.polling(), 'read-only: the agent-bound bot polls');
      if (first.body.pairingCode) {
        const seen = tg.sends.length;
        tg.pushText(4242, 99, '/pair ' + first.body.pairingCode);
        await waitFor(() => tg.sends.slice(seen).some(m => /Owner paired/i.test(String(m.text || ''))), 'read-only: the owner pairs');
      }
      A.eq(await s.dm('READ-ONLY-FIRST'), [['/or/', K.addOne]], 'read-only: the bot runs on K1');
      // the agent's identity moves on, so a re-add's record differs from the saved one (as a fresh owner-pairing state makes it before pairing)
      A.eq((await s.fx.json('POST', '/api/roster', { agents: [{ agentId: 'bot', name: 'BOT', system: 'a new identity', provider: 'openrouter', model: MODEL }], updatedAt: Date.now() })).status, 200,
        'read-only: the agent\'s identity is edited');
      const secrets = path.join(s.ws, 'channels', 'secrets.json');
      lockRecord(secrets);   // secrets.json cannot be written, as a read-only file, an antivirus lock or a full disk leaves it
      try {
        const same = await add({ key: K.addTwo });
        A.eq([same.status, same.body.error], [500, 'could not prove the agent bot configuration was saved; nothing was started'], 'read-only: a re-add with K2 cannot prove its record saved, and says nothing was started');
        A.eq([holders(s.ws, K.addOne), holders(s.ws, K.addTwo)], [OWN_FILES, []], 'read-only, the same provider: K1 is still in the channel file, both copies, and K2 is in no file (86ff765db: K2 replaced K1)');
        // POSIX: a bot's run writes in that folder, so it opens for the message (on Windows only the record's own file is locked)
        if (process.platform !== 'win32') fs.chmodSync(path.dirname(secrets), 0o755);
        A.eq(await s.dm('READ-ONLY-SAME'), [['/or/', K.addOne]], 'read-only, the same provider: the bot still runs on K1');
        if (process.platform !== 'win32') fs.chmodSync(path.dirname(secrets), 0o555);
        // a provider switch: the agent moves to CUSTOM, and the re-add names CUSTOM, K2 and an endpoint
        A.eq((await s.roster({ bot: 'custom' })).status, 200, 'read-only: the agent moves to CUSTOM');
        const switched = await add({ provider: 'custom', model: LOCAL, key: K.addTwo, baseUrl: up.base + '/switch/v1' });
        A.eq(switched.status, 500, 'read-only: a re-add that switches provider cannot prove its record saved either: ' + switched.text.slice(0, 200));
        A.eq([holders(s.ws, K.addOne), holders(s.ws, K.addTwo)], [OWN_FILES, []], 'read-only, a provider switch: K1 is still in the channel file, both copies, and K2 is in no file (86ff765db: a restart then left neither)');
      } finally { unlockRecord(secrets); }
      A.eq((await s.roster({ bot: 'openrouter' })).status, 200, 'read-only: the agent moves back');
      await s.fx.restart();
      await waitFor(() => /telegram bot @ref_bot auto-started/.test(s.fx.output()), 'read-only: the agent-bound bot auto-starts');
      A.eq(await s.dm('READ-ONLY-RESTART'), [['/or/', K.addOne]], 'read-only: after a restart the bot runs on K1, the key its saved record names');
      A.eq(holders(s.ws, K.addTwo), [], '...and K2 is in no file');
    });
  } catch (e) {
    A.ok(false, 'e2e threw: ' + ((e && e.stack) || e) + '\n' + live.map(s => s.fx.output().slice(-2500)).join('\n----\n'));
  } finally {
    for (const s of live) await s.fx.dispose().catch(() => {});
    for (const server of [up.server, tg.server]) {
      server.closeAllConnections && server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  }
  A.report('credential-store.channel-ref.e2e');
})();
