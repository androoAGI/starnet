/* node test/credential-store.endpoint-pair.e2e.test.js — doneMeans 3: every unattended surface runs on the saved pair after a
   restart, before any page connects (credential-store lane, step S7; family B1, credential sources; golden deltas D3 and D4;
   gh#137, gh#113, channels TODO 4).

   THE BUG (probes P3b and P3c). key(id, '') and baseUrl(id, '') were two answers. An operator's CUSTOM_OPENAI_KEY=E with no env
   URL, beside the pair {K, U} a page saved under SETTINGS → AI & MODELS, resolved {E, ''}: Run Now, the scheduled fire, a line hop
   and a bot were all refused "no CUSTOM base URL is saved on this station" with U sitting saved. E plus a URL saved with no key
   got the same sentence, whose exit led back to it. Sending E to U (PR #141) is the crossing this lane forbids: U was saved for
   K, or for no key at all.

   THE FIX (credential-store.js stationChoice, resolve). The station's own choice is ONE pair: the first layer, in key order,
   whose key has a usable endpoint, used whole. key(id, '') and baseUrl(id, '') read that one choice, so a gate and the run it
   admits agree on every surface that hands a key on. A keyless lower pair replaces nobody's key: E beside a keyless URL is
   refused with a sentence that names E and both exits (decision 5).

   REAL sidecars, a recording upstream at one path per endpoint, and a fake Bot API. No page connects after a restart. Rows:
     1. P3b, headless: env CUSTOM_OPENAI_KEY=E, an env KEY_POOL_CUSTOM, no env URL; a page saves {K, U}. Run Now, the scheduled
        fire, a line hop on a live roster, a Telegram bot that keeps no key of its own (a station reference) and /v1 each reach U
        with K, before and after a restart, and a routine that came due while the station was down fires there in the boot's
        own catch-up, before anything could connect. U refusing K never rotates onto the env pool. U never sees E, or any env key.
        P3a, the same catch-up and the next scheduled fire on the page's pair with no env key at all: doneMeans 3 as it reads.
     2. P3c: the same env key beside a URL a page saved with no key, at an upstream that requires a key. Run Now and the scheduled
        fire are refused with the sentence, a bot's connect and /v1 are refused, and U sees no request. Each exit works: the key
        saved next to that URL runs {K, U}; with the page copy removed the env key alone is told both exits; and
        CUSTOM_OPENAI_BASE_URL gives E an endpoint of its own, over the keyless page URL.
     3. GUARDS. A keyless station on a keyless page URL runs keyless. An OpenRouter env URL with a page key: the key goes to the
        env URL. The desktop's keychain key on its kept endpoint, after a restart with no window. A StarNet routine under a
        stale endpoint (the 3195ab5a rows that record calls blocked): Run Now and the scheduled fire on the linked URL with the
        device token, a stale CUSTOM page URL, a stale starnet record in the page file and a stale request endpoint beside them. A
        sign-in's bearer goes to the sign-in's own endpoint under a stale one a run names, on record at the outbound edge
        (test/helpers/outbound-edge.js), which also keeps this row off the network.

   RED at trunk a3af8dafd, with this file copied into a scratch checkout: 37 problems, 64 ok. The first failure is row 1's page
   save, whose answer says the env key serves and is not ready. Run Now then answers 400 "no CUSTOM base URL is saved on this
   station" with U saved, and the fire, the hop and the bot are refused with it, before and after the restart; /v1 answers 503;
   the launch catch-up beside the env key is refused too; and row 2 says that same sentence beside the keyless URL, with exit 1
   going nowhere. P3a, exit 2 and every guard pass there. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

const EDGE = path.join(__dirname, 'helpers', 'outbound-edge.js');
const IPC = 'credential-store-endpoint-pair-ipc-0123456789abcdef';
const V1 = 'credential-store-endpoint-pair-v1-bearer-0123456789';
const K = {
  env: 'custom-OPERATOR-ENV-key-E-0123456789abcdefghij',
  envPool: 'custom-OPERATOR-ENV-POOL-key-E2-0123456789ab',
  page: 'custom-PAGE-COPY-key-K-0123456789abcdefghijkl',
  saved: 'custom-SAVED-NEXT-TO-URL-key-0123456789abcdef',
  kc: 'custom-KEYCHAIN-key-0123456789abcdefghijklmnop',
  or: 'sk-or-v1-PAGE-COPY-openrouter-0123456789abcdef012',
  device: 'starnet-device-token-0123456789abcdefghijklmnop',
  grok: 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE5MDAwMDAwMDB9.ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Q'
};
const MODELS = { custom: 'local-model', openrouter: 'test/model', starnet: 'test/model', grok: 'grok-4' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Opt-in evidence for an intermittent routine-store refusal. Read only fixture-owned state;
// never remove or repair a lock here, and never dump the process environment.
const DIAGNOSTICS = process.env.STARNET_ENDPOINT_PAIR_DIAGNOSTICS || '';
function diagnostic(label, fx, phase, details) {
  if (!DIAGNOSTICS) return;
  const lock = { path: path.join(fx.workspace, 'cron.lock') };
  try {
    const stat = fs.statSync(lock.path);
    lock.size = stat.size;
    lock.mtimeMs = stat.mtimeMs;
    const bytes = fs.readFileSync(lock.path);
    lock.readSize = bytes.length;
    lock.hex = bytes.subarray(0, 128).toString('hex');
    const match = /^(\d+):/.exec(bytes.toString('utf8'));
    if (match) {
      lock.holderPid = Number(match[1]);
      try { process.kill(lock.holderPid, 0); lock.holderProbe = 'alive'; }
      catch (e) { lock.holderProbe = e && e.code || String(e); }
    }
  } catch (e) { lock.readError = e && e.code || String(e); }
  const child = fx.child;
  try {
    fs.appendFileSync(DIAGNOSTICS, JSON.stringify({ at: new Date().toISOString(), label, phase,
      child: child && { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }, lock,
      details: details || null, output: fx.output().slice(-6000) }) + '\n');
  } catch (e) { A.ok(false, 'could not write endpoint-pair diagnostic: ' + (e && e.code || String(e))); }
}
async function waitFor(pred, label, ms) {
  const until = Date.now() + (ms || 30000);
  while (Date.now() < until) { if (await pred()) return true; await sleep(100); }
  A.ok(false, 'timed out waiting: ' + label);
  return false;
}
// word for word: what a Commander reads, each naming the key that has no endpoint and both ways out (decision 5)
const P3C_SENTENCE = 'CUSTOM_OPENAI_KEY is set in the environment that starts StarNet, but no CUSTOM base URL goes with it: the URL saved under SETTINGS → AI & MODELS was saved without a key, and an environment key is never sent to a URL saved in the page. Save the key next to that URL in Settings, or set CUSTOM_OPENAI_BASE_URL.';
const STATE2_SENTENCE = 'CUSTOM_OPENAI_KEY is set in the environment that starts StarNet, but no CUSTOM base URL goes with it: set CUSTOM_OPENAI_BASE_URL, or save the key next to the URL under SETTINGS → AI & MODELS';

// ---- the recording upstream: one path per endpoint, so each request's endpoint is on record beside its key ----
function recorder() {
  const seen = [];
  const refuse = new Set();     // a marker in a request's body: answered 401
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const json = (value, status) => { res.writeHead(status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      seen.push({ path: req.url, key, body: raw });
      if (/^\/cloud\//.test(req.url) && /\/balance/.test(req.url)) return json({ balanceUsd: 50 });
      if (/^\/cloud\//.test(req.url) && /\/(?:debit|credit)$/.test(req.url)) return json({ ok: true, balanceUsd: 50 });
      if (/^\/cloud\//.test(req.url) && !/\/chat\/completions|\/models/.test(req.url)) return json({ entries: [] });
      if (/\/models(?:\?|$)/.test(req.url)) return json({ data: Object.values(MODELS).map(id => ({ id, context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] })) });
      if (!/\/chat\/completions/.test(req.url)) { res.writeHead(404); return res.end(); }
      // the endpoint at /needs-key/ requires a key, as a hosted server does
      if ((/^\/needs-key\//.test(req.url) && !key) || [...refuse].some(m => raw.includes(m))) return json({ error: { message: 'invalid api key', code: 401 } }, 401);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, refuse, base: 'http://127.0.0.1:' + server.address().port })));
}
// the chat requests a surface sent, by the marker in its prompt: [endpoint path prefix, key]
const sentFor = (up, marker) => up.seen.filter(s => /\/chat\/completions/.test(s.path) && s.body.includes(marker)).map(s => [(/^\/[a-z0-9-]+\//.exec(s.path) || [s.path])[0], s.key]);
const once = list => Array.from(new Set(list.map(x => JSON.stringify(x)))).map(x => JSON.parse(x));

// ---- the fake Bot API: long polls, and what the bot said ----
function fakeTelegram() {
  const calls = [], sends = [], queued = [], waiters = [];
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
      calls.push({ method, body });
      if (method === 'getUpdates') {
        if (body.offset === -1) return answer(res, { ok: true, result: [] });
        if (queued.length) return answer(res, { ok: true, result: [queued.shift()] });
        waiters.push(res);
        res.on('close', () => { const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      if (method === 'sendMessage') { sends.push(body); return answer(res, { ok: true, result: { message_id: ++messageId } }); }
      if (method === 'getMe') return answer(res, { ok: true, result: { id: 777, is_bot: true, username: 'pair_bot', first_name: 'Pair' } });
      if (method === 'deleteWebhook') return answer(res, { ok: true, result: true });
      answer(res, { ok: true, result: true });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, sends, polling: () => waiters.length > 0, base: 'http://127.0.0.1:' + server.address().port,
    pushText(chatId, userId, text) {
      queued.push({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text } });
      flush();
    } })));
}

// nothing the test runner exports may stand in for a key, an endpoint or a link
const AMBIENT = ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE', 'CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY', 'CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL', 'KEY_POOL_CUSTOM',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'DESKTOP_SHELL', 'IPC_TOKEN', 'CREDITS_URL', 'CREDITS_TOKEN', 'CLOUD_URL', 'TELEGRAM_TOKEN', 'API_KEY', 'V1_KEY', 'DEFAULT_MODEL', 'FALLBACK_MODELS'];
const pair = (name, value) => ({ ['SKYNET_' + name]: value, ['STARNET_' + name]: value });
function station(label, up, env) {
  const blank = {};
  for (const n of AMBIENT) { blank[n] = ''; blank['STARNET_' + n] = ''; blank['SKYNET_' + n] = ''; }
  const fx = SidecarFixture.create({ prefix: 'cs-endpoint-pair-' + label + '-', timeoutMs: 45000, env: Object.assign(blank, {
    STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_AUX_BUDGET: '0',
    STARNET_CRON_TICK_MS: '400', SKYNET_CRON_TICK_MS: '400', STARNET_API_KEY: V1,
    STARNET_TELEGRAM_API_BASE: 'http://127.0.0.1:9', SKYNET_TELEGRAM_API_BASE: 'http://127.0.0.1:9'
  }, env) });
  // the scheduler is armed before boot, so a routine due in a second really fires
  fs.writeFileSync(path.join(fx.workspace, 'cron.armed.json'), JSON.stringify({ version: 1, armed: true }));
  const api = {
    fx,
    // This proves saved credentials/endpoints across a normal station restart. Sampling an absent
    // cron.lock cannot fence the next 400 ms tick before a Windows force-kill. Ask the real shutdown
    // owner to stop admission/timers and release locks, then observe THIS child's exit before restart.
    // Abrupt-kill recovery remains covered separately; the shared fixture's stop() is unchanged.
    async stopForRestart(phase) {
      const child = fx.child;
      if (!child || child.exitCode !== null || child.signalCode) throw new Error(label + ': no live owned child to quit');
      diagnostic(label, fx, phase + ':before');
      let timer, onExit;
      const exited = new Promise((resolve, reject) => {
        onExit = (code, signal) => resolve({ code, signal });
        child.once('exit', onExit);
        timer = setTimeout(() => reject(new Error(label + ': graceful shutdown did not exit within the fixture deadline')), fx.timeoutMs);
      });
      try {
        const quitting = fx.json('POST', '/api/lifecycle/quit', undefined, { signal: AbortSignal.timeout(fx.timeoutMs) }).then(reply => {
          const accepted = reply.status === 202 && reply.body && reply.body.ok === true && reply.body.shuttingDown === true;
          A.ok(accepted, label + ': graceful quit accepted: ' + reply.status + ' ' + reply.text);
          if (!accepted) throw new Error(label + ': graceful quit refused; do not restart');
        });
        const [, exit] = await Promise.all([quitting, exited]);
        diagnostic(label, fx, phase + ':exit', { exitedPid: child.pid, code: exit.code, signal: exit.signal });
        A.eq([exit.code, exit.signal], [0, null], label + ': the owned child exits normally before restart');
        if (exit.code !== 0 || exit.signal !== null) throw new Error(label + ': abnormal shutdown; do not restart');
        const released = !fs.existsSync(path.join(fx.workspace, 'cron.lock'));
        A.ok(released, label + ': graceful shutdown released cron.lock');
        if (!released) throw new Error(label + ': shutdown left cron.lock; do not restart');
      } finally {
        clearTimeout(timer);
        child.removeListener('exit', onExit);
      }
      await fx.stop(); // clears the already-exited handle; it cannot signal a replacement child
    },
    async restart(extra) {
      await api.stopForRestart('restart');
      await fx.start(extra);
      diagnostic(label, fx, 'restart:ready');
    },
    // the routine came due while the station was down: its next fire is in the past when it boots, so the boot's own catch-up fires
    // it, before anything could connect. Nothing is pushed, saved or asked here: the proof is the request the upstream gets
    async dueWhileDown(id) {
      await api.stopForRestart('due-while-down');
      const file = path.join(fx.workspace, 'cron.jobs.json');
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const job = (Array.isArray(doc.jobs) ? doc.jobs : doc).find(j => j && j.id === id);
      A.ok(!!job, label + ': the routine is in cron.jobs.json');
      if (job) job.nextRunAt = new Date(Date.now() - 3 * 3600e3).toISOString();
      fs.writeFileSync(file, JSON.stringify(doc));
      fs.rmSync(file + '.bak', { force: true });
      await fx.start();
      diagnostic(label, fx, 'due-while-down:ready');
    },
    push: body => fx.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) })),
    engineKey: body => fx.json('POST', '/api/providers/engine-key', body),
    providers: async () => { const r = await fx.json('GET', '/api/providers'); const m = {}; for (const p of (r.body.providers || [])) m[p.id] = p; return m; },
    runNow: id => fx.json('POST', '/api/cron/run', { id }),
    roster: agents => fx.json('POST', '/api/roster', { agents: Object.keys(agents).map(id => ({ agentId: id, name: id.toUpperCase(), system: agents[id].system || 'x', provider: agents[id].provider, model: MODELS[agents[id].provider] })), updatedAt: Date.now() }),
    async routine(agentId, provider, marker, opts) {
      let made;
      for (let tries = 0; tries < 40; tries++) {   // the routine store answers "busy, retry" while a run that just ended still writes it
        made = await fx.json('POST', '/api/cron', Object.assign({ name: 'pair ' + marker, prompt: marker + ' say done', schedule: 'every 1h', agentId, provider, model: MODELS[provider], runsLine: false }, opts));
        if (!/routine store is busy/.test(made.text)) break;
        if (tries === 0 || tries === 39) diagnostic(label, fx, 'routine:busy', { marker, attempt: tries + 1, status: made.status, reply: made.text.slice(0, 400) });
        await sleep(150);
      }
      const id = made.body && made.body.job && made.body.job.id;
      // the mint gate answers a near-same name with the routine that holds it: each marker here must name its own
      A.ok(!!id && !made.body.duplicate, label + ': routine ' + marker + ' created: ' + made.text.slice(0, 200));
      return id;
    },
    v1: (model, marker) => fetch(fx.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + V1 },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: marker + ' say done' }] }) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) })),
    // a routine due in a second: the upstream request it sent, or its blocked record
    async scheduled(agentId, provider, marker) {
      const id = await api.routine(agentId, provider, marker, { schedule: 'in 1s' });
      for (let i = 0; i < 160; i++) {
        await sleep(250);
        const sent = sentFor(up, marker);
        if (sent.length) return { sent };
        const job = ((await fx.json('GET', '/api/cron')).body.jobs || []).find(j => j.id === id);
        if (job && job.lastReason === 'blocked_config') return { blocked: job };
      }
      return { timedOut: true };
    }
  };
  return api;
}
const endOf = text => (String(text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
  .filter(e => e && e.name === 'agent.run.end').pop() || {}).payload || {};
const ranDone = r => r.status === 200 && endOf(r.text).reason === 'done';

(async () => {
  const up = await recorder();
  const tg = await fakeTelegram();
  const stations = [];
  try {
    /* ================= 1. P3b: an env key with no endpoint, beside the page's saved pair ================= */
    {
      const U = up.base + '/u/v1';
      const s = station('p3b', up, { CUSTOM_OPENAI_KEY: K.env, STARNET_KEY_POOL_CUSTOM: K.envPool, STARNET_TELEGRAM_API_BASE: tg.base, SKYNET_TELEGRAM_API_BASE: tg.base });
      stations.push(s);
      await s.fx.start();
      const saved = await s.engineKey({ provider: 'custom', key: K.page, keyPool: [], baseUrl: U });
      A.eq(saved.body && [saved.status, saved.body.keySource, saved.body.unattendedReady], [200, 'station', true], 'P3b: the page saves {K, U}, and the answer says routines run on it (trunk: the env key, not ready): ' + saved.text);
      const prov = (await s.providers()).custom;
      A.eq([prov.configured, prov.credentialSource, prov.currentBaseUrl], [true, 'page', U], 'P3b: /api/providers says CUSTOM runs on the page copy, at U');

      A.eq((await s.roster({ cus: { provider: 'custom' }, hop: { provider: 'custom', system: 'HOP-PERSONA answers briefly' } })).status, 200, 'P3b: the roster is saved');
      const belt = (x, y, dir) => ({ x, y, dir });
      await publishFloor(s.fx, floorOf({
        props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'cus' }, { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'hop' }, { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
        belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
      }), { label: 'P3b: the two-stage line' });

      const routine = await s.routine('cus', 'custom', 'PAIR-RUN-NOW');
      const line = await s.routine('cus', 'custom', 'PAIR-LINE', { runsLine: true });
      // a bot that keeps no key of its own: it follows the station (a station reference)
      const connected = await s.fx.json('POST', '/api/channels/telegram/connect', { token: '123456:ENDPOINT-PAIR-TOKEN', agentId: 'cus', provider: 'custom', model: MODELS.custom });
      A.eq(connected.status, 200, 'P3b: the bot connects: the connect gate proves the pair its messages run (trunk refused it): ' + connected.text.slice(0, 300));
      await waitFor(() => tg.polling(), 'the bot polls');
      if (connected.body && connected.body.pairingCode) {
        tg.pushText(4242, 99, '/pair ' + connected.body.pairingCode);
        await waitFor(() => tg.sends.some(m => /Owner paired/i.test(String(m.text || ''))), 'the owner pairs');
      }
      const onlyPagePair = [['/u/', K.page]];
      const surfaces = async tag => {
        const ran = await s.runNow(routine);
        A.ok(ranDone(ran), tag + ': Run Now runs: ' + ran.status + ' ' + String(ran.text).slice(-240));
        A.eq(once(sentFor(up, 'PAIR-RUN-NOW')), onlyPagePair, tag + ': Run Now reaches U with K');

        const marker = 'PAIR-FIRE-' + tag.toUpperCase().replace(/\W+/g, '-');
        const fire = await s.scheduled('cus', 'custom', marker);
        A.eq(once(fire.sent || []), onlyPagePair, tag + ': the scheduled fire reaches U with K: ' + JSON.stringify(fire.blocked ? fire.blocked.lastError : fire.timedOut || 'sent'));

        const hopBefore = sentFor(up, 'HOP-PERSONA').length;
        const hopRun = await s.runNow(line);
        A.ok(hopRun.status === 200, tag + ': Run Now of the line starts: ' + String(hopRun.text).slice(-240));
        await waitFor(() => sentFor(up, 'HOP-PERSONA').length > hopBefore, tag + ': the line hop reaches an upstream');
        A.eq(once(sentFor(up, 'HOP-PERSONA')), onlyPagePair, tag + ': a line hop, on a live roster, reaches U with K');

        const dm = 'PAIR-TELEGRAM-' + tag.toUpperCase().replace(/\W+/g, '-');
        await waitFor(() => tg.polling(), tag + ': the bot polls');
        tg.pushText(4242, 99, dm + ' say done');
        await waitFor(() => sentFor(up, dm).length > 0, tag + ': the Telegram message reaches an upstream');
        A.eq(once(sentFor(up, dm)), onlyPagePair, tag + ': the bot\'s message reaches U with K');

        const v1Marker = 'PAIR-V1-' + tag.toUpperCase().replace(/\W+/g, '-');
        const v1 = await s.v1('cus', v1Marker);
        A.eq([v1.status, once(sentFor(up, v1Marker))], [200, onlyPagePair], tag + ': /v1 reaches U with K: ' + JSON.stringify(v1.body).slice(0, 200));
      };
      await surfaces('before the restart');
      const secrets = path.join(s.fx.workspace, 'channels', 'secrets.json');
      const record = fs.existsSync(secrets) ? fs.readFileSync(secrets, 'utf8') : '';
      A.ok(record.includes('"provider":"custom"') && ![K.page, K.env, U].some(v => record.includes(v)), 'P3b: the bot\'s record keeps no key and no endpoint: it follows the station');
      await s.restart();
      await surfaces('after a restart with no page');

      // doneMeans 3 as it reads: a routine that came due while the station was down fires on the saved pair before any page connects
      const caughtUp = await s.routine('cus', 'custom', 'PAIR-CAUGHT-UP');
      await s.dueWhileDown(caughtUp);
      await waitFor(() => sentFor(up, 'PAIR-CAUGHT-UP').length > 0, 'P3b: the launch catch-up reaches an upstream');
      A.eq(once(sentFor(up, 'PAIR-CAUGHT-UP')), onlyPagePair, 'P3b: a routine that came due while the station was down fires in the launch catch-up at U with K, before any page connects');

      // U refuses K: the env pool beside the chosen pair is not K's to rotate onto
      up.refuse.add('PAIR-REFUSED');
      const refused = await s.runNow(await s.routine('cus', 'custom', 'PAIR-REFUSED'));
      A.eq([refused.status, endOf(refused.text).reason, once(sentFor(up, 'PAIR-REFUSED'))], [200, 'error', onlyPagePair], 'P3b: U refusing K never rotates onto the operator\'s env pool');

      const strays = up.seen.filter(r => r.key === K.env || r.key === K.envPool);
      A.eq(strays.map(r => r.path), [], 'P3b: U NEVER SEES E, nor its pool, on any surface, before or after the restart (' + up.seen.length + ' requests)');
      A.ok(!s.fx.output().includes(K.env) && !s.fx.output().includes(K.page), 'P3b: the sidecar log carries neither key');
    }

    /* ================= P3a: doneMeans 3 as it reads, the page's pair and no env key at all (a guard: this one worked at trunk) ================= */
    {
      const U = up.base + '/alone/v1';
      const s = station('p3a', up, {});
      stations.push(s);
      await s.fx.start();
      const saved = await s.engineKey({ provider: 'custom', key: K.saved, keyPool: [], baseUrl: U });
      A.eq(saved.body && [saved.status, saved.body.keySource, saved.body.unattendedReady], [200, 'station', true], 'P3a: the page saves {K, U}');
      A.eq((await s.roster({ cus: { provider: 'custom' } })).status, 200, 'P3a: the roster is saved');
      const id = await s.routine('cus', 'custom', 'P3A-CAUGHT-UP');
      await s.dueWhileDown(id);
      await waitFor(() => sentFor(up, 'P3A-CAUGHT-UP').length > 0, 'P3a: the launch catch-up reaches an upstream');
      A.eq(once(sentFor(up, 'P3A-CAUGHT-UP')), [['/alone/', K.saved]], 'P3a: a CUSTOM routine that came due while the station was down fires on the saved base URL, before any page connects');
      const fire = await s.scheduled('cus', 'custom', 'P3A-SCHEDULED');
      A.eq(once(fire.sent || []), [['/alone/', K.saved]], 'P3a: ...and so does the next scheduled fire, with no page: ' + JSON.stringify(fire.blocked ? fire.blocked.lastError : fire.timedOut || 'sent'));
    }

    /* ================= 2. P3c: the env key beside a URL saved with no key ================= */
    {
      const U = up.base + '/needs-key/v1';
      const s = station('p3c', up, { CUSTOM_OPENAI_KEY: K.env, STARNET_KEY_POOL_CUSTOM: '' });
      stations.push(s);
      await s.fx.start();
      const saved = await s.engineKey({ provider: 'custom', baseUrl: U, keyPool: [], key: '' });
      A.eq(saved.body && [saved.status, saved.body.keySource, saved.body.unattendedReady], [200, 'environment', false], 'P3c: the keyless URL is saved; the env key stays the choice, not ready');
      A.eq((await s.roster({ cus: { provider: 'custom' } })).status, 200, 'P3c: the roster is saved');
      const id = await s.routine('cus', 'custom', 'P3C-RUN-NOW');
      const refused = await s.runNow(id);
      A.eq([refused.status, refused.body && refused.body.error], [400, P3C_SENTENCE], 'P3c: Run Now is refused with the sentence that names the env key and both exits (trunk said no URL is saved)');
      const fire = await s.scheduled('cus', 'custom', 'P3C-FIRE');
      A.ok(!!fire.blocked && fire.blocked.lastError === P3C_SENTENCE, 'P3c: the scheduled fire is blocked with the same sentence: ' + JSON.stringify(fire.blocked ? fire.blocked.lastError : fire));
      const v1 = await s.v1('cus', 'P3C-V1');
      A.ok(v1.status === 503 && /CUSTOM_OPENAI_KEY/.test(JSON.stringify(v1.body)) && /CUSTOM_OPENAI_BASE_URL/.test(JSON.stringify(v1.body)), '/v1 refuses, naming the key and an exit: ' + JSON.stringify(v1.body));
      const bot = await s.fx.json('POST', '/api/channels/telegram/connect', { token: '123456:P3C-TOKEN', agentId: 'cus', provider: 'custom', model: MODELS.custom });
      A.ok(bot.status === 400 && /CUSTOM_OPENAI_KEY/.test(String(bot.body && bot.body.error)), 'a bot\'s connect refuses, naming the key: ' + bot.text.slice(0, 260));
      const providers = await s.providers();
      A.eq([providers.custom.configured, providers.custom.credentialSource, providers.custom.envName], [false, 'environment', 'CUSTOM_OPENAI_KEY'], 'P3c: /api/providers says the env key is what the station holds, and it cannot run');
      A.eq(up.seen.filter(r => /^\/needs-key\//.test(r.path) && /\/chat\/completions/.test(r.path)), [], 'P3c: U sees no request');
      A.ok(!up.seen.some(r => r.key === K.env), 'P3c: the env key was sent nowhere');

      // exit 1: save the key next to that URL
      const paired = await s.engineKey({ provider: 'custom', key: K.saved, keyPool: [], baseUrl: U });
      A.eq(paired.body && [paired.status, paired.body.keySource, paired.body.unattendedReady], [200, 'station', true], 'exit 1: the key saved next to that URL: the pair runs');
      A.ok(ranDone(await s.runNow(id)), 'exit 1: Run Now runs');
      A.eq(once(sentFor(up, 'P3C-RUN-NOW')), [['/needs-key/', K.saved]], 'exit 1: U receives the key saved beside it, never the env key');

      // the page copy removed: the env key alone. Its refusal names both exits, not "set it under Settings" alone
      const removed = await s.engineKey({ provider: 'custom', key: '', keyPool: [], baseUrl: '' });
      A.eq(removed.status, 200, 'the page copy is removed');
      const alone = await s.runNow(id);
      A.eq([alone.status, alone.body && alone.body.error], [400, STATE2_SENTENCE], 'an env key with no URL anywhere is told both exits');

      // exit 2: the operator's URL gives the env key an endpoint of its own, over a keyless page URL
      A.eq((await s.engineKey({ provider: 'custom', baseUrl: U, keyPool: [], key: '' })).status, 200, 'the keyless URL is back');
      await s.restart({ CUSTOM_OPENAI_BASE_URL: up.base + '/env/v1' });
      const mark = up.seen.length;
      A.ok(ranDone(await s.runNow(id)), 'exit 2: with CUSTOM_OPENAI_BASE_URL set, Run Now runs');
      A.eq(once(up.seen.slice(mark).filter(r => /\/chat\/completions/.test(r.path)).map(r => [(/^\/[a-z-]+\//.exec(r.path) || [''])[0], r.key])), [['/env/', K.env]], 'exit 2: the env key goes to the env URL, never the keyless page URL');
    }

    /* ================= 3. guards ================= */
    // a keyless station on a keyless page URL, and a page key beside the operator's OpenRouter URL
    {
      const s = station('keyless', up, { STARNET_OPENROUTER_BASE: up.base + '/orenv/api/v1' });
      stations.push(s);
      await s.fx.start();
      A.eq((await s.engineKey({ provider: 'custom', baseUrl: up.base + '/local/v1', keyPool: [], key: '' })).status, 200, 'guard: a keyless page URL is saved');
      const savedOr = await s.engineKey({ provider: 'openrouter', key: K.or, keyPool: [], baseUrl: '' });
      A.eq(savedOr.body && [savedOr.status, savedOr.body.keySource, savedOr.body.unattendedReady], [200, 'station', true], 'guard: a page OpenRouter key beside the operator\'s URL');
      A.eq((await s.roster({ cus: { provider: 'custom' }, orr: { provider: 'openrouter' } })).status, 200, 'guard: the roster is saved');
      const id = await s.routine('cus', 'custom', 'GUARD-KEYLESS'), orr = await s.routine('orr', 'openrouter', 'GUARD-OR-URL');
      for (const tag of ['', ' after a restart']) {
        A.ok(ranDone(await s.runNow(id)), 'guard: a keyless station runs keyless' + tag);
        A.eq(once(sentFor(up, 'GUARD-KEYLESS')), [['/local/', '']], 'guard: ...at its keyless URL, with no key' + tag);
        A.ok(ranDone(await s.runNow(orr)), 'guard: the OpenRouter routine runs' + tag);
        A.eq(once(sentFor(up, 'GUARD-OR-URL')), [['/orenv/', K.or]], 'guard: a page key with no endpoint of its own goes to the operator\'s URL' + tag);
        if (!tag) await s.restart();
      }
    }
    // the desktop: the keychain key on its kept endpoint, after a restart with no window
    {
      const kept = up.base + '/kept/v1';
      const s = station('desktop', up, { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC), ...pair('CUSTOM_OPENAI_KEY', K.kc) });
      stations.push(s);
      await s.fx.start();
      A.eq((await s.roster({ cus: { provider: 'custom' } })).status, 200, 'desktop: the roster is saved');
      const id = await s.routine('cus', 'custom', 'GUARD-KEPT');
      const before = await s.runNow(id);
      A.eq(before.status, 400, 'desktop: no endpoint handed over yet: the routine is refused');
      A.ok(/^no CUSTOM base URL is saved on this station/.test(String(before.body && before.body.error)), 'desktop: ...with the #137 sentence: a keychain key takes the URL saved in Settings, station-wide: ' + before.text);
      A.eq((await s.push({ provider: 'custom', baseUrl: kept })).status, 200, 'desktop: the window hands the endpoint over');
      A.ok(ranDone(await s.runNow(id)), 'desktop: Run Now runs');
      await s.restart();   // the shell's spawn again, and no window: nothing is pushed
      A.ok(ranDone(await s.runNow(id)), 'desktop: after a restart with no window Run Now runs on the kept endpoint');
      const fire = await s.scheduled('cus', 'custom', 'SCHEDULED-AFTER-RESTART');
      A.eq(once(fire.sent || []), [['/kept/', K.kc]], 'desktop: ...and so does the scheduled fire: ' + JSON.stringify(fire.blocked ? fire.blocked.lastError : fire.timedOut || 'sent'));
      A.eq(once(sentFor(up, 'GUARD-KEPT')), [['/kept/', K.kc]], 'desktop: the keychain key only ever reached its kept endpoint');
      const file = fs.readFileSync(path.join(s.fx.workspace, '.secrets', 'provider-endpoints.json'), 'utf8');
      A.ok(file.includes(kept) && !file.includes(K.kc), 'desktop: the file keeps the URL, never the key');
    }
    // StarNet's linked account under a stale endpoint, and a sign-in under a stale one, on record at the outbound edge
    {
      const stale = up.base + '/stale/v1', cloud = up.base + '/cloud';
      const edgeOut = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-endpoint-pair-edge-')), 'edge.jsonl');
      const prior = String(process.env.NODE_OPTIONS || '').trim();
      const s = station('accounts', up, { STARNET_CLOUD_URL: cloud, NODE_OPTIONS: (prior ? prior + ' ' : '') + '--require=' + EDGE, STARNET_TEST_EDGE_OUT: edgeOut });
      stations.push(s);
      s.edgeDir = path.dirname(edgeOut);
      const ws = s.fx.workspace;
      fs.mkdirSync(path.join(ws, '.secrets'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.secrets', 'credits.json'), JSON.stringify({ url: cloud, deviceToken: K.device, accountId: 'fixture-account', linkedAt: Date.now() }));
      // an older build's page file with a stale starnet record, and a stale CUSTOM page endpoint beside it
      fs.writeFileSync(path.join(ws, '.secrets', 'provider-keys.json'), JSON.stringify({ version: 1, providers: { starnet: { key: 'stale-key-0123456789', baseUrl: stale, rev: 'a1' }, custom: { baseUrl: stale, rev: 'a2' } } }));
      fs.mkdirSync(path.join(ws, 'grok'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'grok', 'tokens.json'), JSON.stringify({ access_token: K.grok, refresh_token: 'rf-endpoint-pair-0123456789', expires_at: 1900000000000, last_refresh: '2026-10-31T01:00:00.000Z' }));
      await s.fx.start();
      A.ok(fs.existsSync(edgeOut) && /"edge":"ready"/.test(fs.readFileSync(edgeOut, 'utf8')), 'accounts: the outbound edge is up (this station must never reach the network)');
      A.eq((await s.roster({ net: { provider: 'starnet' }, grk: { provider: 'grok' } })).status, 200, 'accounts: the roster is saved');
      const id = await s.routine('net', 'starnet', 'GUARD-STARNET');
      const ran = await s.runNow(id);
      A.ok(ranDone(ran), '3195ab5a: Run Now of a StarNet routine runs under the stale endpoints: ' + String(ran.text).slice(-240));
      A.eq(once(sentFor(up, 'GUARD-STARNET')), [['/cloud/', K.device]], '3195ab5a: ...on the linked URL, with the device token');
      const fire = await s.scheduled('net', 'starnet', 'LINKED-SCHEDULED');
      A.eq(once(fire.sent || []), [['/cloud/', K.device]], '3195ab5a: the scheduled fire too: ' + JSON.stringify(fire.blocked ? fire.blocked.lastError : fire.timedOut || 'sent'));
      const body = await s.fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'starnet', model: MODELS.starnet, baseUrl: stale, agentId: 'net', messages: [{ role: 'user', content: 'LINKED-BODY-RUN say done' }] }) });
      A.ok(ranDone({ status: body.status, text: await body.text() }), '3195ab5a: a run naming the stale endpoint runs too');
      A.eq(once(sentFor(up, 'LINKED-BODY-RUN')), [['/cloud/', K.device]], '3195ab5a: ...on the linked URL');

      // a sign-in's bearer under a stale endpoint a run names. The edge answers 503, so the run retries on: its dial is the row, and
      // the station's disposal ends it, so nothing here waits for its end
      const dials = () => fs.readFileSync(edgeOut, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => /\/chat\/completions/.test(String(l.path)));
      s.fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'grok', model: MODELS.grok, baseUrl: stale, agentId: 'grk',
        messages: [{ role: 'user', content: 'BEARER-BODY-RUN say done' }] }) }).then(r => r.text()).catch(() => null);
      await waitFor(() => dials().length > 0, 'the sign-in run dials');
      A.ok(dials().every(l => l.host === 'api.x.ai' && l.authorization === 'Bearer ' + K.grok), 'sign-in: its bearer goes to the sign-in\'s own endpoint, never the one the run named: ' + JSON.stringify(dials().map(l => l.host)));
      A.eq(up.seen.filter(r => /^\/stale\//.test(r.path)).map(r => r.path), [], 'NO request reached the stale endpoint, from any row');
      A.ok(!up.seen.some(r => r.key === K.grok || r.key === 'stale-key-0123456789'), '...and no stale key or bearer went anywhere on loopback');
    }
  } catch (e) {
    A.ok(false, 'e2e threw: ' + ((e && e.stack) || e) + '\n' + stations.map(s => s.fx.output().slice(-2500)).join('\n----\n'));
  } finally {
    for (const s of stations) {
      diagnostic('cleanup', s.fx, 'dispose:before');
      await s.fx.dispose().catch(() => {});
      if (s.edgeDir) try { fs.rmSync(s.edgeDir, { recursive: true, force: true }); } catch (_) {}
    }
    for (const server of [up.server, tg.server]) {
      server.closeAllConnections && server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  }
  A.report('credential-store.endpoint-pair.e2e');
})();
