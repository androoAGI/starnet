/* node test/sidecar.http.test.js — boot-level end-to-end test of the real Node host (sidecar/index.js).
   Spawns the actual server as a child process against an ISOLATED temp workspace (SKYNET_WORKSPACES) on an
   ephemeral port, then drives the cost-spine HTTP surface over real sockets:
     - GET  /api/health
     - GET  /api/budget/status        (reads a PRE-SEEDED ledger -> pools reflect persisted spend)
     - POST /api/budget/resume        (valid scope lifts the cap; bad scope 400s)
     - POST /api/run                  (missing key/model 400s — the guard path, zero spend)
   Zero network dependence (the catalog warm fails closed offline) and ZERO model spend — it never sends a key.
   This is the one test that proves the server actually BOOTS and the new routes are wired, not just the units.

   NOT in test:fast (a child-process boot test shouldn't gate ~25 other agents' merges); run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const edge = require('../sidecar/edgetts.js');   // V-EDGE: exported WS codec + secMsGec for offline unit + loopback tests
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const IPC_TOKEN = 'ipc-provider-config-test-token';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// spawn the host on a candidate port; resolve once it logs "listening", retry the next port on EADDRINUSE.
function boot(port, workspaces, attemptsLeft, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, {
        SKYNET_PORT: String(port),
        SKYNET_WORKSPACES: workspaces,
        // keep the managed-credits path OFF for the default boot so /api/credits proves the unconfigured 404 path
        // deterministically (a dev machine with these set in the ambient env would otherwise flip the assertion).
        STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
        STARNET_CREDITS_API_KEY: '', SKYNET_CREDITS_API_KEY: '',
        STARNET_CREDITS_ACCOUNT: '', SKYNET_CREDITS_ACCOUNT: '',
        SKYNET_IPC_TOKEN: IPC_TOKEN,
        // clear the OpenRouter key so the voice routes' no-key fallback path is deterministic (a dev machine
        // with the key in its ambient env would otherwise hit the network and flip the {text:''} assertions).
        OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
        OPENROUTER_API_KEY: '', STARNET_OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_API_KEY: '',
        ELEVENLABS_API_KEY: '',   // same determinism for the ElevenLabs TTS branch's no-key degrade
        // V-EDGE: disable the free Edge neural floor in the DEFAULT boot so the no-key TTS test degrades to
        // {fallback:true} deterministically without any network attempt. The dedicated edge-loopback boot below
        // re-enables it (SKYNET_EDGE_TTS + host/port overrides) to prove the round-trip offline.
        SKYNET_EDGE_TTS: '0', STARNET_EDGE_TTS: '0',
        // /api/tts now resolves a CHAIN of credentials (openrouter → gemini → openai) — clear the Gemini
        // keys too, or an ambient dev key would hit the network and flip the no-key degrade assertions.
        GEMINI_API_KEY: '', STARNET_GEMINI_API_KEY: '', SKYNET_GEMINI_API_KEY: '',
        GOOGLE_API_KEY: '', STARNET_GOOGLE_API_KEY: '', SKYNET_GOOGLE_API_KEY: '',
        GOOGLE_AI_API_KEY: '', STARNET_GOOGLE_AI_API_KEY: '', SKYNET_GOOGLE_AI_API_KEY: '',
        OPENAI_API_KEY: '',
        STARNET_OPENAI_API_KEY: '',
        SKYNET_OPENAI_API_KEY: '',
        CUSTOM_OPENAI_KEY: '',
        STARNET_CUSTOM_OPENAI_KEY: '',
        SKYNET_CUSTOM_OPENAI_KEY: '',
        XAI_API_KEY: '',
        STARNET_XAI_API_KEY: '',
        SKYNET_XAI_API_KEY: '',
        X_AI_API_KEY: '',
        STARNET_X_AI_API_KEY: '',
        SKYNET_X_AI_API_KEY: '',
        GROQ_API_KEY: '',
        STARNET_GROQ_API_KEY: '',
        SKYNET_GROQ_API_KEY: '',
        MISTRAL_API_KEY: '',
        STARNET_MISTRAL_API_KEY: '',
        SKYNET_MISTRAL_API_KEY: '',
        DEEPSEEK_API_KEY: '',
        STARNET_DEEPSEEK_API_KEY: '',
        SKYNET_DEEPSEEK_API_KEY: '',
        TOGETHER_API_KEY: '',
        STARNET_TOGETHER_API_KEY: '',
        SKYNET_TOGETHER_API_KEY: '',
        FIREWORKS_API_KEY: '',
        STARNET_FIREWORKS_API_KEY: '',
        SKYNET_FIREWORKS_API_KEY: '',
        PERPLEXITY_API_KEY: '',
        STARNET_PERPLEXITY_API_KEY: '',
        SKYNET_PERPLEXITY_API_KEY: '',
        CEREBRAS_API_KEY: '',
        STARNET_CEREBRAS_API_KEY: '',
        SKYNET_CEREBRAS_API_KEY: '',
        CUSTOM_OPENAI_BASE_URL: '',
        STARNET_CUSTOM_OPENAI_BASE_URL: '',
        SKYNET_CUSTOM_OPENAI_BASE_URL: '',
        // GROUND_UP_AUDIT P2: the packaged app injects its version via STARNET_APP_VERSION (src-tauri/ isn't a
        // bundled resource, so /api/version's conf lookup returns blank there). Set it so /api/version proves the
        // Budget-legibility pass (2026-07-23): the SHIPPED defaults are now perRun $10 with every cross-run pool
        // UNGOVERNED (0). This suite's budget assertions prove ENFORCEMENT mechanics (status pools, one-click
        // resume), so pin the old governed caps via env — deterministic regardless of shipped defaults or a dev
        // machine's ambient SKYNET_BUDGET_* values.
        SKYNET_BUDGET_PER_RUN: '3', SKYNET_BUDGET_PER_AGENT: '5', SKYNET_BUDGET_PER_DAY: '40', SKYNET_BUDGET_GLOBAL: '100',
        // env-first fallback + honest appSource='env' below.
        STARNET_APP_VERSION: '9.9.9-http-test',
        // Clear any ambient build stamp so the DEFAULT boot deterministically exercises the harness git-describe
        // fallback (harnessSource='git'); a per-boot `extraEnv` (below) sets it to prove the env override wins.
        STARNET_BUILD_DESCRIBE: '', SKYNET_BUILD_DESCRIBE: ''
      }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, output: () => out }); }
      if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, workspaces, attemptsLeft - 1, extraEnv));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

(async () => {
  // isolated workspace, PRE-SEEDED with two finished runs inside the trailing-day window (ts ~ now)
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-http-'));
  const now = Date.now();
  const seed = [
    { runId: 'r1', agentId: 'alice', turns: 3, usd: 1.25, tokens: 1200, ts: now - 1000 },
    { runId: 'r2', agentId: 'bob', turns: 1, usd: 0.75, tokens: 400, ts: now - 500 }
  ];
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), seed.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.mkdirSync(path.join(ws, 'channels'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'channels', 'secrets.json'), JSON.stringify({
    version: 1,
    discord: {
      enabled: true,
      token: 'discord-token',
      key: 'sk-or-v1-fake-discord',
      model: 'anthropic/claude-sonnet-4.6',
      provider: 'openrouter',
      agentId: 'agent',
      ownerId: 'discord-owner-42'
    }
  }));

  const booted = await boot(8820 + (process.pid % 60), ws, 20);
  const { child, port } = booted;
  const B = 'http://' + HOST + ':' + port;
  let apiToken = '';
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;   // hardened: GET data routes need the token too now
    const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };

  try {
    // ---- health ----
    const health = await j('GET', '/api/health');
    A.eq(health.status, 200, 'GET /api/health -> 200');
    A.eq(health.body, 'ok', 'health body is ok');

    // the served page injects the token for browser mode (the primary delivery path)
    const injected = await (await fetch(B + '/')).text();
    A.ok(/__STARNET_API_TOKEN__/.test(injected), 'served index.html bootstraps the API token for browser mode');
    apiToken = await bootToken(B, B);
    A.ok(apiToken.length >= 32, 'served index.html carries a high-entropy API token');
    const tok = { 'X-StarNet-Token': apiToken };
    const tauriOrigin = 'http://tauri.localhost';

    const sessNoToken = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: B } });
    A.eq(sessNoToken.status, 403, 'POST /api/session without X-StarNet-Token -> 403');
    const sess = await fetch(B + '/api/session', { method: 'POST', headers: Object.assign({ Origin: B }, tok) });
    A.eq(sess.status, 200, 'POST /api/session with token -> 200');
    const sessBody = await sess.json();
    A.eq(sessBody.token, undefined, 'POST /api/session never echoes the API token');

    // ---- localhost API hardening: CORS mirrors only trusted origins; foreign origins rejected ----
    const sameOriginNoToken = await fetch(B + '/api/budget/status', { headers: { Origin: B } });
    A.eq(sameOriginNoToken.status, 403, 'same-origin sensitive GET without token -> 403');
    const sameOrigin = await fetch(B + '/api/budget/status', { headers: Object.assign({ Origin: B }, tok) });
    A.eq(sameOrigin.status, 200, 'same-origin API request (with token) -> 200');
    A.eq(sameOrigin.headers.get('access-control-allow-origin'), B, 'same-origin CORS mirrors the exact loopback origin');

    const tauri = await fetch(B + '/api/budget/status', { headers: Object.assign({ Origin: tauriOrigin }, tok) });
    A.eq(tauri.status, 200, 'Tauri app origin API request -> 200');
    A.eq(tauri.headers.get('access-control-allow-origin'), tauriOrigin, 'Tauri CORS mirrors the trusted app origin');

    const badOrigin = await fetch(B + '/api/budget/status', { headers: { Origin: 'https://evil.example' } });
    A.eq(badOrigin.status, 403, 'foreign web origin API request -> 403');
    A.eq(badOrigin.headers.get('access-control-allow-origin'), null, 'foreign origin gets no CORS read access');
    const badOriginWithToken = await fetch(B + '/api/budget/status', { headers: Object.assign({ Origin: 'https://evil.example' }, tok) });
    A.eq(badOriginWithToken.status, 403, 'foreign web origin with a valid token is still blocked');

    const preflight = await fetch(B + '/api/run', { method: 'OPTIONS', headers: { Origin: B, 'Access-Control-Request-Method': 'POST' } });
    A.eq(preflight.status, 204, 'trusted API preflight -> 204');
    A.eq(preflight.headers.get('access-control-allow-origin'), B, 'trusted preflight mirrors loopback origin');
    const preflightMethods = preflight.headers.get('access-control-allow-methods') || '';
    A.ok(preflightMethods.split(',').map(s => s.trim()).indexOf('DELETE') >= 0, 'trusted preflight advertises the DELETE routes the API actually serves');
    const badPreflight = await fetch(B + '/api/run', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    A.eq(badPreflight.status, 403, 'foreign API preflight -> 403');

    // ---- C2 hole closed: GET DATA routes now require the token, not just POSTs ----
    const getNoTok = await fetch(B + '/api/budget/status');
    A.eq(getNoTok.status, 403, 'GET /api/budget/status WITHOUT a token -> 403 (GET data routes are gated now)');
    const getWithTok = await fetch(B + '/api/budget/status', { headers: tok });
    A.eq(getWithTok.status, 200, 'GET /api/budget/status WITH the token -> 200');

    // ---- T3.9 DIAGNOSTICS: token-gated, assembled server-side from real state, and SECRET-FREE ----
    const diagNoTok = await fetch(B + '/api/diagnostics');
    A.eq(diagNoTok.status, 403, 'GET /api/diagnostics WITHOUT a token -> 403 (gated like other data routes)');
    const diag = await j('GET', '/api/diagnostics');
    A.eq(diag.status, 200, 'GET /api/diagnostics WITH the token -> 200');
    A.ok(diag.body && typeof diag.body.text === 'string' && diag.body.text.length > 0, 'diagnostics returns a paste-ready text block');
    A.ok(diag.body.report && typeof diag.body.report === 'object', 'diagnostics returns a structured report too');
    const desktopDiagResponse = await fetch(B + '/api/diagnostics', { headers: Object.assign({ Origin: tauriOrigin }, tok) });
    const desktopDiag = await desktopDiagResponse.json();
    A.eq(desktopDiag.report.mode, 'desktop', 'http://tauri.localhost is classified as the packaged desktop origin');
    A.ok(/StarNet diagnostics/.test(diag.body.text), 'the block is clearly fenced');
    A.ok(/no keys, tokens, or message content/.test(diag.body.text), 'the block states it carries no secrets');
    A.eq(typeof diag.body.report.keyPresent, 'boolean', 'keyPresent is a boolean, never the key itself');
    // the pre-seeded discord channel carries a fake OpenRouter key (sk-or-v1-fake-discord) + a bot token — NEITHER
    // may ever appear in the diagnostics payload (the whole point of the sanitization law).
    const diagBlob = JSON.stringify(diag.body);
    A.ok(diagBlob.indexOf('sk-or-v1-fake-discord') < 0, 'diagnostics never leaks the seeded provider key');
    A.ok(diagBlob.indexOf('discord-token') < 0, 'diagnostics never leaks the seeded channel token');
    // LIVE doctor is never an accidental GET/background action: token + explicit second consent are both
    // required before any provider/execution/connector/channel probe can start.
    const doctorNoToken = await fetch(B + '/api/diagnostics/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    A.eq(doctorNoToken.status, 403, 'POST /api/diagnostics/live WITHOUT a token -> 403');
    const doctorNoConsent = await j('POST', '/api/diagnostics/live', {});
    A.eq(doctorNoConsent.status, 409, 'POST /api/diagnostics/live without explicit consent -> 409 before any probe');
    A.eq(doctorNoConsent.body.code, 'LIVE_DOCTOR_CONSENT_REQUIRED', 'live doctor refusal names the missing consent gate');

    // ---- managed credits: UNCONFIGURED boot exposes ZERO surface (honesty law — no dead STORE, no fake balance) ----
    // This boot sets no STARNET_CREDITS_URL, so /api/credits must 404 with { configured: false } — the frontend
    // reads that and renders no STORE card at all.
    const creditsNoTok = await fetch(B + '/api/credits');
    A.eq(creditsNoTok.status, 403, 'GET /api/credits WITHOUT a token -> 403 (gated like other data routes)');
    const creditsUnconf = await j('GET', '/api/credits');
    A.eq(creditsUnconf.status, 404, 'GET /api/credits with no credits backend configured -> 404 (no surface)');
    A.eq(creditsUnconf.body.configured, false, 'the 404 body honestly reports configured:false');

    // ---- managed credits: ACCOUNT-SIDE UNLINK INVALIDATES THE LOCAL "LINKED" CLAIM -----------------
    // Reproduce the 0.10.8 field escape over real sockets: the station first caches a valid $0, then the
    // account page removes its device and the same bearer starts returning 401. The customer actually has
    // $22 on the account, but that money is deliberately unreachable until this station pairs to it again.
    // The app must discard cached $0, stop claiming LINKED, and expose LINK STATION — no local UNLINK ritual.
    {
      let revoked = false;
      const cloud = http.createServer((rq, rs) => {
        const auth = String(rq.headers.authorization || '');
        if (auth !== 'Bearer snd_revoked_after_zero' || revoked) {
          rs.writeHead(401, { 'Content-Type': 'application/json' });
          return rs.end(JSON.stringify({ error: 'unauthorized' }));
        }
        if (String(rq.url || '').indexOf('/v1/balance') === 0) {
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          return rs.end(JSON.stringify({ balanceUsd: 0 }));
        }
        if (String(rq.url || '').indexOf('/v1/history') === 0) {
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          return rs.end(JSON.stringify({ entries: [] }));
        }
        rs.writeHead(404, { 'Content-Type': 'application/json' }); rs.end('{}');
      });
      await new Promise(r => cloud.listen(0, HOST, r));
      const cloudUrl = 'http://' + HOST + ':' + cloud.address().port;
      const revokedWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-credits-revoked-'));
      fs.mkdirSync(path.join(revokedWs, '.secrets'), { recursive: true });
      fs.writeFileSync(path.join(revokedWs, '.secrets', 'credits.json'), JSON.stringify({
        url: cloudUrl, accountId: 'acct_paid_22', linkedAt: now - 1000
      }));
      const rb = await boot(port + 120, revokedWs, 20, {
        STARNET_CLOUD_URL: cloudUrl,
        STARNET_CREDITS_TOKEN: 'snd_revoked_after_zero'
      });
      const RB = 'http://' + HOST + ':' + rb.port;
      try {
        const rtok = await bootToken(RB, RB);
        const rh = { 'Content-Type': 'application/json', 'X-StarNet-Token': rtok, Origin: RB };
        const read = async p => {
          const rr = await fetch(RB + p, { headers: rh });
          return { status: rr.status, body: await rr.json() };
        };
        const before = await read('/api/credits');
        A.eq(before.status, 200, 'precondition: linked credits route answers before account-side unlink');
        A.eq(before.body.configured, true, 'precondition: accepted bearer is configured');
        A.eq(before.body.linked, true, 'precondition: accepted bearer is server-proven linked');
        A.eq(before.body.balanceUsd, 0, 'precondition: the exact stale $0 from the field report is cached');

        revoked = true;   // account page DELETEs the device row; all later bearer reads are 401
        const after = await read('/api/credits');
        A.eq(after.status, 200, 'revocation remains a readable state payload for both UI consumers');
        A.eq(after.body.configured, false, 'a cloud-rejected device is no longer configured');
        A.eq(after.body.linked, false, 'local file/keychain presence cannot keep claiming LINKED');
        A.eq(after.body.reason, 'link_revoked', 'the route names the authoritative account-side revocation');
        A.eq(after.body.balanceUsd, undefined, 'the stale cached $0 is not emitted as the paid account balance');
        const linkable = await read('/api/credits/linkable');
        A.eq(linkable.body.available, true, 'the revoked station can pair again without manually unlinking locally');
        A.eq(linkable.body.reason, 'link_revoked', 'the relink card receives the recovery reason');
      } finally {
        try { rb.child.kill(); } catch (_) {}
        try { if (cloud.closeAllConnections) cloud.closeAllConnections(); } catch (_) {}
        await new Promise(r => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; try { cloud.close(fin); } catch (_) { fin(); } setTimeout(fin, 1000); });
        await sleep(150);
        try { fs.rmSync(revokedWs, { recursive: true, force: true }); } catch (_) {}
      }
    }

    // ---- managed credits: WRONG AUTO-LINK -> SWITCH ACCOUNT -> FUNDED WAKE -----------------------
    // Real host, sockets, filesystem, pairing, balance authority, billing admission, and provider stream.
    // This is Brandon's exact shape: launch-time keychain/env still carries the old $0 account, the paid
    // account owns $22, and the user switches accounts from genesis. The newly confirmed identity must own
    // every balance/debit/inference call and the run must reach the model instead of being denied at WAKE.
    {
      const calls = [];
      const readReq = rq => new Promise(resolve => { let s = ''; rq.on('data', c => { s += c; }); rq.on('end', () => resolve(s)); });
      const cloud = http.createServer(async (rq, rs) => {
        const raw = await readReq(rq);
        let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
        const auth = String(rq.headers.authorization || '');
        const u = new URL(String(rq.url || '/'), 'http://cloud.local');
        calls.push({ path: u.pathname, account: u.searchParams.get('account') || body.account || '', auth });
        const json = (code, value) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(value)); };
        if (u.pathname === '/v1/link/start') return json(200, {
          code: 'STAR-PAID', pollSecret: 'poll-paid', verifyUrl: 'https://account.example/link', expiresAt: Date.now() + 60000
        });
        if (u.pathname === '/v1/link/poll') return json(200, {
          status: 'confirmed', deviceToken: 'snd_paid_22', accountId: 'acct_paid_22'
        });
        if (u.pathname === '/v1/models') return json(200, { data: [{ id: 'test/model', name: 'Test Model' }] });
        if (u.pathname === '/v1/balance') {
          if (auth === 'Bearer snd_old_zero' && u.searchParams.get('account') === 'acct_wrong_zero') return json(200, { balanceUsd: 0 });
          if (auth === 'Bearer snd_paid_22' && u.searchParams.get('account') === 'acct_paid_22') return json(200, { balanceUsd: 22 });
          return json(401, { error: 'wrong identity' });
        }
        if (u.pathname === '/v1/history') return json(200, { entries: [] });
        if (u.pathname === '/v1/debit') {
          if (auth !== 'Bearer snd_paid_22' || body.account !== 'acct_paid_22') return json(401, { error: 'wrong identity' });
          return json(200, { ok: true, balanceUsd: 12 });
        }
        if (u.pathname === '/v1/credit') {
          if (auth !== 'Bearer snd_paid_22' || body.account !== 'acct_paid_22') return json(401, { error: 'wrong identity' });
          return json(200, { ok: true, balanceUsd: 22 });
        }
        if (u.pathname === '/v1/chat/completions') {
          if (auth !== 'Bearer snd_paid_22') return json(401, { error: 'wrong identity' });
          rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
          rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
          rs.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
          rs.end('data: [DONE]\n\n');
          return;
        }
        return json(404, {});
      });
      await new Promise(r => cloud.listen(0, HOST, r));
      const cloudUrl = 'http://' + HOST + ':' + cloud.address().port;
      const paidWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-credits-paid-switch-'));
      fs.mkdirSync(path.join(paidWs, '.secrets'), { recursive: true });
      fs.writeFileSync(path.join(paidWs, '.secrets', 'credits.json'), JSON.stringify({
        url: cloudUrl, accountId: 'acct_wrong_zero', linkedAt: now - 1000
      }));
      const pb = await boot(port + 121, paidWs, 20, {
        STARNET_CLOUD_URL: cloudUrl,
        STARNET_CREDITS_TOKEN: 'snd_old_zero',
        STARNET_CREDITS_ACCOUNT: 'acct_env_stale',
        STARNET_FULL_ACCESS: '1'
      });
      const PB = 'http://' + HOST + ':' + pb.port;
      try {
        const ptok = await bootToken(PB, PB);
        const ph = { 'Content-Type': 'application/json', 'X-StarNet-Token': ptok, Origin: PB };
        const request = async (method, p, value) => {
          const rr = await fetch(PB + p, { method, headers: ph, body: value == null ? undefined : JSON.stringify(value) });
          const text = await rr.text(); let parsed = null; try { parsed = JSON.parse(text); } catch (_) {}
          return { status: rr.status, body: parsed, text };
        };
        const wrong = await request('GET', '/api/credits?history=0');
        A.eq(wrong.body.balanceUsd, 0, 'precondition: launch-time linked account is authoritatively $0');
        A.eq(wrong.body.accountId, 'acct_wrong_zero', 'precondition: $0 belongs to the wrong linked account, not the paid account');

        const unlinked = await request('POST', '/api/credits/unlink', {});
        A.eq(unlinked.body.unlinked, true, 'genesis switch-account action clears the old sidecar link');
        const start = await request('POST', '/api/credits/link/start', { deviceName: 'StarNet Station' });
        A.eq(start.body.code, 'STAR-PAID', 'switch account starts the ordinary one-code pairing flow');
        const paired = await request('POST', '/api/credits/link/poll', { code: start.body.code });
        A.eq(paired.body.linked, true, 'newly confirmed paid account is accepted as linked');
        A.eq(paired.body.accountId, 'acct_paid_22', 'active adapter identity is the account that was just confirmed');
        A.eq(paired.body.balanceUsd, 22, 'link confirmation carries the paid account authoritative $22 balance');

        // Simulate desktop adoption: the shell moved the fresh bearer into Keychain and stripped the file.
        // The already-running sidecar must keep using the fresh linked identity, never its stale launch env.
        fs.writeFileSync(path.join(paidWs, '.secrets', 'credits.json'), JSON.stringify({
          url: cloudUrl, accountId: 'acct_paid_22', linkedAt: now
        }));
        const funded = await request('GET', '/api/credits?history=0');
        A.eq(funded.body.balanceUsd, 22, 'after token adoption the running station still reads $22, never the old $0');
        A.eq(funded.body.accountId, 'acct_paid_22', 'after token adoption the paid account remains the active identity');

        const run = await request('POST', '/api/run', {
          provider: 'starnet', model: 'test/model', agentId: 'paid-wake', internal: true,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }]
        });
        A.eq(run.status, 200, 'funded StarNet WAKE enters the real streaming run route');
        A.ok(run.text.indexOf('agent.token') >= 0, 'funded WAKE reaches the managed model and streams its reply');
        A.ok(run.text.indexOf('Out of managed credit') < 0, 'funded WAKE is never denied as out of credits');
        const paidCalls = calls.filter(c => ['/v1/balance', '/v1/debit', '/v1/credit', '/v1/chat/completions'].includes(c.path) && c.account !== 'acct_wrong_zero');
        A.ok(paidCalls.length >= 3 && paidCalls.every(c => c.auth === 'Bearer snd_paid_22'),
          'balance, billing, and inference all use the newly linked paid bearer after the switch');
      } finally {
        try { pb.child.kill(); } catch (_) {}
        try { if (cloud.closeAllConnections) cloud.closeAllConnections(); } catch (_) {}
        await new Promise(r => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; try { cloud.close(fin); } catch (_) { fin(); } setTimeout(fin, 1000); });
        await sleep(150);
        try { fs.rmSync(paidWs, { recursive: true, force: true }); } catch (_) {}
      }
    }

    // ---- provider registry/catalog routes: dynamic provider surface boots and remains token-gated ----
    const providersNoTok = await fetch(B + '/api/providers');
    A.eq(providersNoTok.status, 403, 'GET /api/providers WITHOUT a token -> 403');
    const providers = await j('GET', '/api/providers');
    A.eq(providers.status, 200, 'GET /api/providers -> 200');
    A.ok(Array.isArray(providers.body.providers), 'providers route returns a list');
    A.ok(providers.body.providers.some(p => p.id === 'openrouter'), 'providers include openrouter');
    A.ok(providers.body.providers.some(p => p.id === 'anthropic'), 'providers include anthropic');
    A.ok(providers.body.providers.some(p => p.id === 'gemini'), 'providers include gemini');
    for (const id of ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras']) {
      A.ok(providers.body.providers.some(p => p.id === id), 'providers include ' + id);
    }
    A.ok(providers.body.providers.some(p => p.id === 'custom'), 'providers include custom OpenAI-compatible');
    const models = await j('GET', '/api/models/openrouter');
    A.eq(models.status, 200, 'GET /api/models/openrouter -> 200');
    A.ok(Array.isArray(models.body.models), 'provider model route returns a models array');

    // PU-07: provider probes distinguish a configured endpoint from a reachable/catalog-backed endpoint.
    const offlineProbe = await j('POST', '/api/providers/probe', { provider: 'custom', baseUrl: 'http://127.0.0.1:65530/v1' });
    A.eq(offlineProbe.status, 200, 'POST /api/providers/probe returns a fact payload even when the endpoint is offline');
    A.eq(offlineProbe.body.reachable, false, 'offline custom endpoint is not reachable');
    A.eq(offlineProbe.body.catalogAvailable, false, 'offline custom endpoint has no proven catalog');
    const probeServer = http.createServer((rq, rs) => {
      if (rq.url.indexOf('/chat/completions') >= 0) {
        if (rq.headers.authorization !== 'Bearer probe-good-key') { rs.writeHead(401); return rs.end('rejected'); }
        rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
        rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
        rs.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        rs.write('data: [DONE]\n\n'); return rs.end();
      }
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ data: [{ id: 'local/proven-model' }] }));
    });
    await new Promise(resolve => probeServer.listen(0, HOST, resolve));
    try {
      const liveBase = 'http://' + HOST + ':' + probeServer.address().port + '/v1';
      const liveProbe = await j('POST', '/api/providers/probe', { provider: 'custom', baseUrl: liveBase });
      A.eq(liveProbe.body.reachable, true, 'reachable custom endpoint is proven by a real model-catalog round-trip');
      A.eq(liveProbe.body.catalogAvailable, true, 'reachable custom endpoint reports its real non-empty catalog');
      A.eq(liveProbe.body.credentialVerified, true, 'keyless custom endpoint needs no fabricated credential proof');
      const wrongCandidate = await j('POST', '/api/providers/validate', { provider: 'custom', baseUrl: liveBase, key: 'probe-wrong-key', model: 'local/proven-model' });
      A.eq(wrongCandidate.body.credentialVerified, false, 'candidate-key validation rejects a key that fails the inference wire');
      const goodCandidate = await j('POST', '/api/providers/validate', { provider: 'custom', baseUrl: liveBase, key: 'probe-good-key', model: 'local/proven-model' });
      A.eq(goodCandidate.body.credentialVerified, true, 'candidate-key validation proves the exact key on the inference wire');
    } finally { await new Promise(resolve => probeServer.close(resolve)); }

    const pushOpenAi = await fetch(B + '/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skynet-Token': IPC_TOKEN },
      body: JSON.stringify({ provider: 'openai', key: 'sk-provider-http-test-secret' })
    });
    A.eq(pushOpenAi.status, 200, 'POST /api/key can push an OpenAI provider key with the IPC token');
    const openAiAck = await pushOpenAi.json();
    A.eq(openAiAck.provider, 'openai', 'provider key ack names the configured provider');
    A.eq(openAiAck.configured, true, 'provider key ack reports configured');
    A.ok(JSON.stringify(openAiAck).indexOf('sk-provider-http-test-secret') < 0, 'provider key ack never echoes the secret');

    const pushOpenAiPool = await fetch(B + '/api/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skynet-Token': IPC_TOKEN },
      body: JSON.stringify({ provider: 'openai', keyPool: ['openai-backup-a', 'openai-backup-b'] })
    });
    const openAiPoolAck = await pushOpenAiPool.json();
    A.eq(openAiPoolAck.alternateCount, 2, 'OpenAI alternate pool is accepted only under the OpenAI provider id');
    A.ok(JSON.stringify(openAiPoolAck).indexOf('openai-backup') < 0, 'alternate-pool acknowledgement never echoes a secret');

    const pushAnthropic = await fetch(B + '/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skynet-Token': IPC_TOKEN },
      body: JSON.stringify({ provider: 'anthropic', key: 'sk-ant-provider-http-test-secret' })
    });
    A.eq(pushAnthropic.status, 200, 'POST /api/key can push an Anthropic provider key with the IPC token');
    const anthropicAck = await pushAnthropic.json();
    A.eq(anthropicAck.provider, 'anthropic', 'Anthropic provider key ack names the configured provider');
    A.eq(anthropicAck.configured, true, 'Anthropic provider key ack reports configured');

    const pushXai = await fetch(B + '/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skynet-Token': IPC_TOKEN },
      body: JSON.stringify({ provider: 'x-ai', key: 'xai-provider-http-test-secret' })
    });
    A.eq(pushXai.status, 200, 'POST /api/key can push an xAI provider key by alias with the IPC token');
    const xaiAck = await pushXai.json();
    A.eq(xaiAck.provider, 'xai', 'xAI provider key ack names the canonical provider');
    A.eq(xaiAck.configured, true, 'xAI provider key ack reports configured');

    const pushCustomBase = await fetch(B + '/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skynet-Token': IPC_TOKEN },
      body: JSON.stringify({ provider: 'custom', baseUrl: 'http://127.0.0.1:65530/v1' })
    });
    A.eq(pushCustomBase.status, 200, 'POST /api/key can push custom provider base URL with the IPC token');
    const configuredProviders = await j('GET', '/api/providers');
    const openaiProvider = configuredProviders.body.providers.find(p => p.id === 'openai');
    const xaiProvider = configuredProviders.body.providers.find(p => p.id === 'xai');
    const customProvider = configuredProviders.body.providers.find(p => p.id === 'custom');
    A.eq(!!(openaiProvider && openaiProvider.configured), true, 'OpenAI provider is configured after scoped key push');
    A.eq(!!(xaiProvider && xaiProvider.configured), true, 'xAI provider is configured after scoped key push');
    A.eq(!!(customProvider && customProvider.configured), true, 'Custom provider is configured after scoped base URL push');
    A.ok(JSON.stringify(configuredProviders.body).indexOf('sk-provider-http-test-secret') < 0, 'provider list never leaks the pushed secret');
    A.ok(JSON.stringify(configuredProviders.body).indexOf('xai-provider-http-test-secret') < 0, 'provider list never leaks the pushed xAI secret');

    // PU-06: Signal is tokenless. Removing it destroys endpoint/account configuration, not a fictional token.
    const signalConnect = await j('POST', '/api/channels/signal/connect', {
      endpoint: 'http://127.0.0.1:65529', account: '+15551234567', model: 'local/proven-model',
      provider: 'custom', baseUrl: 'http://127.0.0.1:65530/v1', agentId: 'agent', agentName: 'Ultron'
    });
    A.eq(signalConnect.status, 200, 'Signal accepts endpoint/account configuration against an offline bridge');
    const signalSaved = await j('GET', '/api/channels/signal/status');
    A.eq(signalSaved.body.configured, true, 'Signal status is configured from saved endpoint/account');
    const channelsFile = path.join(ws, 'channels', 'secrets.json');
    const signalBeforeMalformed = fs.readFileSync(channelsFile, 'utf8');
    const signalBadJson = await fetch(B + '/api/channels/signal/disconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': apiToken }, body: '{bad'
    });
    A.eq(signalBadJson.status, 400, 'Signal disconnect with malformed JSON -> 400');
    A.eq(fs.readFileSync(channelsFile, 'utf8'), signalBeforeMalformed, 'malformed Signal disconnect leaves durable configuration byte-identical');
    const signalStillSaved = await j('GET', '/api/channels/signal/status');
    A.eq(signalStillSaved.body.configured, true, 'malformed Signal disconnect does not stop or deconfigure the channel');
    const signalRemove = await j('POST', '/api/channels/signal/disconnect', { purge: true });
    A.eq(signalRemove.body.removedConfiguration, true, 'Signal removal is read-back-proven');
    A.eq(signalRemove.body.purged, false, 'Signal removal never claims token purging');
    const signalGone = await j('GET', '/api/channels/signal/status');
    A.eq(signalGone.body.configured, false, 'Signal becomes unconfigured immediately after removal');
    A.eq(signalGone.body.endpoint, '', 'removed Signal status exposes no stale endpoint');
    A.eq(signalGone.body.account, '', 'removed Signal status exposes no stale account');
    const signalDisk = JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'secrets.json'), 'utf8'));
    A.eq(Object.prototype.hasOwnProperty.call(signalDisk, 'signal'), false, 'Signal record is absent from durable channel configuration');
    const sensitiveGets = [
      ['/api/connectors', 'connectors'],
      ['/api/cron', 'cron'],
      ['/api/checkpoint?agent=agent', 'checkpoint'],
      ['/api/notebook?agent=agent', 'notebook'],
      ['/api/save?agent=agent', 'save'],
      ['/api/runs?agent=agent&limit=5', 'runs'],
      ['/api/transcript?stream=global&agent=agent&limit=5', 'transcript'],
      ['/api/memory/proposals?agent=agent', 'memory proposals'],
      ['/api/memory/records?agent=agent', 'memory records'],
      ['/api/insights?agent=agent', 'insights']
    ];
    for (const [p, label] of sensitiveGets) {
      const noTok = await fetch(B + p);
      A.eq(noTok.status, 403, 'GET ' + label + ' WITHOUT a token -> 403');
      const withTok = await fetch(B + p, { headers: Object.assign({ Origin: B }, tok) });
      A.eq(withTok.status, 200, 'GET ' + label + ' WITH trusted browser token -> 200');
    }
    // Prefix families stop only at a URL segment boundary. Sibling aliases must not inherit a real handler,
    // while the exact/query forms above and the real /api/models/<provider> child route remain live.
    for (const p of ['/api/toolsets-typo', '/api/saveXYZ', '/api/runsXYZ', '/api/subagentsXYZ', '/api/skillsXYZ', '/api/connectors/oauth/callbackevil']) {
      const alias = await fetch(B + p, { headers: tok });
      A.eq(alias.status, 404, 'segment-unsafe route alias ' + p + ' -> 404');
    }

    // ---- GROUND_UP_AUDIT P2: /api/version env-first fallback is HONEST (never a silent blank) ----
    // src-tauri/tauri.conf.json isn't a bundled resource in the packaged app, so the desktop shell exports
    // STARNET_APP_VERSION (set in the boot env above). /api/version must surface it with an honest appSource.
    const ver = await j('GET', '/api/version');
    A.eq(ver.status, 200, 'GET /api/version -> 200');
    A.eq(ver.body.app, '9.9.9-http-test', '/api/version app comes from STARNET_APP_VERSION (env-first fallback)');
    A.eq(ver.body.appSource, 'env', '/api/version reports appSource=env — honest about WHERE the version came from');
    A.ok(typeof ver.body.harness === 'string', '/api/version keeps the byte-compatible {harness} field');
    A.ok(typeof ver.body.node === 'string' && ver.body.node.length > 0, '/api/version keeps the node field');
    // LANE V: the harness build id must NOT be the intentional '0.0.0' package placeholder — running from a git
    // checkout it resolves via `git describe` (harnessSource='git'), and harnessSource always names WHERE it came from.
    A.ok(ver.body.harness !== '0.0.0', '/api/version harness is NOT the 0.0.0 placeholder (git-describe truth in a checkout)');
    A.ok(['env', 'git', 'pkg'].includes(ver.body.harnessSource), '/api/version reports an honest harnessSource (env|git|pkg)');
    A.eq(ver.body.harnessSource, 'git', "/api/version resolves harness via git-describe when no build stamp is set");

    // LANE V: env override wins — a boot with STARNET_BUILD_DESCRIBE set reports that exact string + harnessSource='env'
    // (the release pipeline stamps the real build id this way). Dedicated second boot: the value is fixed at spawn time.
    {
      const bd = 'lane-v-build-2f3a9c1';
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-http-bd-'));
      const b2 = await boot(port + 200, ws2, 20, { STARNET_BUILD_DESCRIBE: bd });
      const B2 = 'http://' + HOST + ':' + b2.port;
      try {
        const tok2 = await bootToken(B2, B2);
        const r2 = await fetch(B2 + '/api/version', { headers: { 'X-StarNet-Token': tok2, Origin: B2 } });
        const v2 = await r2.json();
        A.eq(r2.status, 200, 'GET /api/version (BUILD_DESCRIBE boot) -> 200');
        A.eq(v2.harness, bd, '/api/version harness = STARNET_BUILD_DESCRIBE (env override wins over git/pkg)');
        A.eq(v2.harnessSource, 'env', '/api/version reports harnessSource=env when the build stamp is set');
        A.eq(v2.app, '9.9.9-http-test', '/api/version app still resolves independently of the harness stamp');
      } finally {
        try { b2.child.kill(); } catch (_) {}
        await sleep(150);
        try { fs.rmSync(ws2, { recursive: true, force: true }); } catch (_) {}
      }
    }

    // ---- GROUND_UP_AUDIT P2: a THROWN store read reports 500 {error}, not a 200-empty ----
    // Happy path already proven above (GET /api/runs -> 200 with {runs:[...]}). Force the runStore.list read to
    // THROW by feeding a runId query far past the internal length guard is NOT possible over HTTP; instead we prove
    // the CONTRACT the frontend relies on: the route JSON always carries {runs} on 200, and the source uses
    // json(500,{error}) on a real failure (verified structurally so we don't have to corrupt the live store here).
    const runsOk = await j('GET', '/api/runs?agent=agent&limit=5');
    A.eq(runsOk.status, 200, 'GET /api/runs happy path stays 200');
    A.ok(Array.isArray(runsOk.body.runs), '/api/runs 200 body carries {runs:[...]} (shape byte-compatible)');
    const ckOk = await j('GET', '/api/checkpoint?agent=agent');
    A.eq(ckOk.status, 200, 'GET /api/checkpoint happy path stays 200');
    A.ok(Array.isArray(ckOk.body.snapshots), '/api/checkpoint 200 body carries {snapshots:[...]}');
    A.eq(ckOk.body.enabled, true, 'checkpoints are ON by default (no STARNET_/SKYNET_CHECKPOINTS set) — Lane C5');
    // the truthful-failure branch itself (structural: the catch now reports 500, never a masking 200-empty)
    const idxSrcHonesty = fs.readFileSync(INDEX, 'utf8');
    const serveRunsSrc = idxSrcHonesty.slice(idxSrcHonesty.indexOf('function serveRuns'), idxSrcHonesty.indexOf('function serveInsights'));
    A.ok(/catch\s*\(e\)\s*\{[\s\S]*?json\(500,\s*\{\s*error/.test(serveRunsSrc), 'serveRuns reports json(500,{error}) on a thrown read, not a 200-empty');
    const ckStart = idxSrcHonesty.indexOf('function handleCheckpointList');
    const serveCkSrc = idxSrcHonesty.slice(ckStart, idxSrcHonesty.indexOf('function ', ckStart + 20));
    A.ok(/catch\s*\(e\)\s*\{[\s\S]*?json\(500,\s*\{\s*error/.test(serveCkSrc), 'handleCheckpointList reports json(500,{error}) on a thrown read, not a 200-empty');

    // ---- GROUND_UP_AUDIT P2: three more sidecar honesty/reliability fixes (internal behaviors — asserted
    // structurally against the live source, since none is deterministically triggerable over the HTTP surface) ----
    // #3 on-demand model-catalog re-warm: the boot warm's rejection handler no longer no-ops the session; the
    // channel modelCatalog accessor kicks a throttled re-warm when the snapshot is empty.
    A.ok(/function maybeRewarmModelCatalog\(\)/.test(idxSrcHonesty), '#3 maybeRewarmModelCatalog exists (on-demand catalog re-warm)');
    A.ok(/modelCatalog:\s*\(\)\s*=>\s*\{\s*maybeRewarmModelCatalog\(\)/.test(idxSrcHonesty), '#3 channel modelCatalog accessor triggers the re-warm');
    A.ok(!/listModels\(\)\.then\([\s\S]{0,120}\(\)\s*=>\s*\{\}\s*\)/.test(idxSrcHonesty.slice(idxSrcHonesty.indexOf('server.listen'))), '#3 boot warm no longer has an empty rejection handler');
    // #4 aux-run unmetered parity: skill-review + curator now stamp the ledger with the unmetered flag like
    // reflection/study, so a Codex-only user is not billed phantom metered spend.
    const reviewSrc = idxSrcHonesty.slice(idxSrcHonesty.indexOf('function runBackgroundSkillReview'), idxSrcHonesty.indexOf('async function runSkillCurator'));
    A.ok(/ledger\.record\(\{[^}]*unmetered\s*\}\)/.test(reviewSrc), '#4 runBackgroundSkillReview ledger.record carries unmetered');
    const curatorSrc = idxSrcHonesty.slice(idxSrcHonesty.indexOf('async function runSkillCurator'), idxSrcHonesty.indexOf('async function runSkillCurator') + 4000);
    A.ok(/ledger\.record\(\{[^}]*unmetered\s*\}\)/.test(curatorSrc), '#4 runSkillCurator ledger.record carries unmetered');
    A.ok(/runBackgroundSkillReview\(\{[\s\S]*?unmetered:\s*providerUnmetered/.test(idxSrcHonesty), '#4 skill-review invocation threads providerUnmetered');
    A.ok(/runSkillCurator\(\{[\s\S]*?unmetered:\s*providerUnmetered/.test(idxSrcHonesty), '#4 skill-curator invocation threads providerUnmetered');
    // #5 steer-drop diagnostics: a non-empty steer buffer discarded at teardown logs a one-line count.
    A.ok(/function dropSteer\(runId, ctx\)/.test(idxSrcHonesty), '#5 dropSteer helper exists');
    A.ok(/\[steer\] dropped '\s*\+\s*b\.length/.test(idxSrcHonesty), '#5 dropSteer logs the dropped count');
    A.ok((idxSrcHonesty.match(/dropSteer\(runId,/g) || []).length >= 3, '#5 all three teardown sites route through dropSteer');
    // #6 _procDiagSeen TTL eviction: the dedupe map now evicts stale entries on every insert (2x the window),
    // not only once it grows past 64 — so a slow trickle of distinct one-shot messages no longer leaks forever.
    const surfaceSrc = idxSrcHonesty.slice(idxSrcHonesty.indexOf('function surfaceProcessError'), idxSrcHonesty.indexOf('function surfaceProcessError') + 1400);
    A.ok(/const ttl = 2 \* PROC_DIAG_WINDOW_MS/.test(surfaceSrc), '#6 _procDiagSeen uses a 2x-window TTL');
    A.ok(!/_procDiagSeen\.size > 64/.test(surfaceSrc), '#6 eviction is no longer gated behind size > 64 (runs every insert)');

    // ---- SSE telemetry requires the ?token= query (EventSource cannot send a header) ----
    const sseNoTok = await fetch(B + '/api/channels/events');
    A.eq(sseNoTok.status, 403, 'GET /api/channels/events WITHOUT ?token -> 403');
    const sseBadTok = await fetch(B + '/api/channels/events?token=nope');
    A.eq(sseBadTok.status, 403, 'GET /api/channels/events with a WRONG ?token -> 403');
    const sseWithTok = await fetch(B + '/api/channels/events?token=' + encodeURIComponent(apiToken), { headers: { Origin: B } });
    A.eq(sseWithTok.status, 200, 'GET /api/channels/events with the token query -> 200');
    try { if (sseWithTok.body && sseWithTok.body.cancel) await sseWithTok.body.cancel(); } catch (_) {}

    // ---- slash command catalog + dispatch seam ----
    const slashCat = await j('GET', '/api/slash/catalog');
    A.eq(slashCat.status, 200, 'GET /api/slash/catalog -> 200');
    A.ok(Array.isArray(slashCat.body.commands), 'slash catalog returns commands');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'retry'), 'slash catalog includes /retry');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'new'), 'slash catalog includes /new');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'branch' && c.aliases && c.aliases.indexOf('fork') >= 0), 'slash catalog includes /branch with /fork alias');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'queue' && c.aliases && c.aliases.indexOf('q') >= 0), 'slash catalog includes /queue with /q alias');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'model'), 'slash catalog includes /model');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'skills'), 'slash catalog includes /skills');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'resume' && c.aliases && c.aliases.indexOf('sessions') >= 0), 'slash catalog includes /resume with /sessions alias');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'background' && c.aliases && c.aliases.indexOf('bg') >= 0), 'slash catalog includes /background with /bg alias');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'cron'), 'slash catalog includes /cron');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'memory'), 'slash catalog includes /memory');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'reload-mcp' && c.aliases && c.aliases.indexOf('reload_mcp') >= 0), 'slash catalog includes /reload-mcp alias');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'version' && c.aliases && c.aliases.indexOf('v') >= 0), 'slash catalog includes /version alias');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'reload-skills' && c.aliases && c.aliases.indexOf('reload_skills') >= 0), 'slash catalog includes /reload-skills alias');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'morning-brief'), 'slash catalog includes built-in recipe commands');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'plan' && c.source === 'skill'), 'slash catalog includes available compute-only skill commands');
    A.ok(!slashCat.body.commands.some(c => c && c.name === 'test-driven-development'), 'slash catalog omits unavailable workbench skill without placed workbench');

    const slashBench = await j('GET', '/api/slash/catalog?placed=workbench');
    A.ok(slashBench.body.commands.some(c => c && c.name === 'test-driven-development'), 'slash catalog includes workbench skill when workbench is placed');

    const slashRun = await j('POST', '/api/slash/dispatch', { input: '/retry' });
    A.eq(slashRun.status, 200, 'POST /api/slash/dispatch /retry -> 200');
    A.eq(slashRun.body.directive, { type: 'client', action: 'retry', args: '' }, 'slash dispatch returns a client retry directive');

    const slashFork = await j('POST', '/api/slash/dispatch', { input: '/fork copy this' });
    A.eq(slashFork.status, 200, 'POST /api/slash/dispatch /fork -> 200');
    A.eq(slashFork.body.command.name, 'branch', '/fork dispatch canonicalizes to branch');
    A.eq(slashFork.body.directive, { type: 'client', action: 'branch', args: 'copy this' }, 'fork dispatch returns branch client directive');

    const slashModel = await j('POST', '/api/slash/dispatch', { input: '/model openai/gpt-5' });
    A.eq(slashModel.status, 200, 'POST /api/slash/dispatch /model -> 200');
    A.eq(slashModel.body.directive, { type: 'client', action: 'model', args: 'openai/gpt-5' }, 'model dispatch returns client directive with model id');

    const slashReload = await j('POST', '/api/slash/dispatch', { input: '/reload_skills' });
    A.eq(slashReload.status, 200, 'POST /api/slash/dispatch /reload_skills -> 200');
    A.eq(slashReload.body.command.name, 'reload-skills', 'reload_skills dispatch canonicalizes');

    const slashSessions = await j('POST', '/api/slash/dispatch', { input: '/sessions 1' });
    A.eq(slashSessions.status, 200, 'POST /api/slash/dispatch /sessions -> 200');
    A.eq(slashSessions.body.directive, { type: 'client', action: 'resume', args: '1' }, 'sessions dispatch returns resume directive');

    const slashMcp = await j('POST', '/api/slash/dispatch', { input: '/reload_mcp github' });
    A.eq(slashMcp.status, 200, 'POST /api/slash/dispatch /reload_mcp -> 200');
    A.eq(slashMcp.body.directive, { type: 'client', action: 'reload-mcp', args: 'github' }, 'reload_mcp dispatch returns reload-mcp directive');

    const slashRecipe = await j('POST', '/api/slash/dispatch', { input: '/summarize launch notes' });
    A.eq(slashRecipe.status, 200, 'POST /api/slash/dispatch recipe -> 200');
    A.eq(slashRecipe.body.directive.type, 'insert', 'recipe slash dispatch returns insert directive');
    A.ok(String(slashRecipe.body.directive.text || '').indexOf('launch notes') >= 0, 'recipe slash dispatch carries typed args into the draft');

    const slashSkill = await j('POST', '/api/slash/dispatch', { input: '/plan refactor commands' });
    A.eq(slashSkill.status, 200, 'POST /api/slash/dispatch skill -> 200');
    A.eq(slashSkill.body.directive.source, 'skill', 'skill slash dispatch returns a skill directive');
    A.ok(String(slashSkill.body.directive.text || '').indexOf('refactor commands') >= 0, 'skill slash dispatch carries typed args into the task');

    const slashUnknown = await j('POST', '/api/slash/dispatch', { input: '/unknown' });
    A.eq(slashUnknown.status, 404, 'POST /api/slash/dispatch unknown -> 404');

    const noApiToken = await fetch(B + '/api/budget/resume', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: JSON.stringify({ scope: 'day' }) });
    A.eq(noApiToken.status, 403, 'privileged POST without X-StarNet-Token -> 403');

    // ---- budget status reflects the PRE-SEEDED ledger (persisted spend survived a fresh boot) ----
    const st = await j('GET', '/api/budget/status');
    A.eq(st.status, 200, 'GET /api/budget/status -> 200');
    A.eq(st.body.runs, 2, 'status counts the two seeded runs');
    A.ok(Math.abs(st.body.totalUsd - 2.0) < 1e-9, 'totalUsd = seeded $1.25 + $0.75');
    A.eq(st.body.perRun, 3, 'perRun cap exposed (Balanced $3)');
    A.ok(st.body.day && Math.abs(st.body.day.cap - 40) < 1e-9, 'day pool base cap is $40');
    A.ok(st.body.global && Math.abs(st.body.global.cap - 100) < 1e-9, 'global pool base cap is $100');
    A.ok(Math.abs(st.body.day.usd - 2.0) < 1e-9, 'day pool reflects seeded spend inside the 24h window');
    A.ok(Math.abs(st.body.global.usd - 2.0) < 1e-9, 'global pool reflects seeded spend');
    A.ok(JSON.stringify(st.body).indexOf('sk-') < 0, 'status leaks no key-shaped secret');

    // ---- Discord saved-owner restart guard: a boot from persisted config must restore owner lock
    //      before the adapter sees any DM, so the first post-reboot stranger cannot claim the bot.
    for (let i = 0; i < 15 && booted.output().indexOf('discord auto-started from saved config') < 0; i++) await sleep(100);
    A.ok(booted.output().indexOf('discord auto-started from saved config') >= 0, 'Discord auto-started from saved config on boot');
    const dcStatus = await j('GET', '/api/channels/discord/status');
    A.eq(dcStatus.status, 200, 'GET /api/channels/discord/status -> 200');
    A.eq(dcStatus.body.configured, true, 'Discord status sees saved config');
    // `connected` is now the LIVE gateway truth (real WS to Discord), which a sandboxed test can
    // never reach — auto-start itself is proven by the boot log line above. Assert the gateway
    // reported a real state instead of the old adapter-started=connected fiction.
    A.eq(typeof dcStatus.body.connected, 'boolean', 'Discord status reports a truthful gateway connected flag');
    A.ok(typeof dcStatus.body.state === 'string' && dcStatus.body.state.length > 0, 'Discord status reports a gateway state');
    A.eq(dcStatus.body.ownerLocked, true, 'Discord owner lock survived restart');
    A.ok(JSON.stringify(dcStatus.body).indexOf('discord-owner-42') < 0, 'Discord status does not expose ownerId');
    A.ok(JSON.stringify(dcStatus.body).indexOf('discord-token') < 0, 'Discord status does not expose token');
    const savedChannels = JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'secrets.json'), 'utf8'));
    A.eq(savedChannels.discord.ownerId, 'discord-owner-42', 'Discord auto-start preserved saved ownerId on disk');

    // ---- resume lifts a pool for the session ----
    const rs = await j('POST', '/api/budget/resume', { scope: 'day' });
    A.eq(rs.status, 200, 'POST /api/budget/resume{day} -> 200');
    A.eq(rs.body.resumed, 'day', 'resume names the scope');
    A.ok(Math.abs(rs.body.cap - 80) < 1e-9, 'resume lifts the day cap to $80 (base + base)');

    const st2 = await j('GET', '/api/budget/status');
    A.ok(Math.abs(st2.body.day.cap - 80) < 1e-9, 'status reflects the lifted day cap after resume');
    A.ok(Math.abs(st2.body.overrides.day - 40) < 1e-9, 'override headroom exposed');

    // ---- resume rejects an ungoverned / bogus scope ----
    const bad = await j('POST', '/api/budget/resume', { scope: 'bogus' });
    A.eq(bad.status, 400, 'resume of a bogus scope -> 400');
    const runScope = await j('POST', '/api/budget/resume', { scope: 'run' });
    A.eq(runScope.status, 400, 'resume of the per-run scope -> 400 (run is the loop hard cap, not a pool)');

    // ---- /api/run guard path (no key -> 400, zero spend) ----
    const noKey = await j('POST', '/api/run', { model: 'anthropic/claude-sonnet-4.6' });
    A.eq(noKey.status, 400, 'POST /api/run without a key -> 400');
    const noModel = await j('POST', '/api/run', { key: 'sk-or-v1-fake' });
    A.eq(noModel.status, 400, 'POST /api/run without a model -> 400');
    const badJson = await fetch(B + '/api/run', { method: 'POST', headers: { 'X-StarNet-Token': apiToken }, body: '{not json' });
    A.eq(badJson.status, 400, 'POST /api/run with malformed JSON -> 400');
    const cancelBadJson = await fetch(B + '/api/cancel', { method: 'POST', headers: { 'X-StarNet-Token': apiToken }, body: '{not json' });
    A.eq(cancelBadJson.status, 400, 'POST /api/cancel with malformed JSON -> 400');

    const spotifyStart = await j('POST', '/api/spotify/auth/start', { clientId: 'spotify-http-test-client' });
    A.eq(spotifyStart.status, 200, 'Spotify auth start accepts a valid client id without network I/O');
    const spotifyFile = path.join(ws, '.secrets', 'spotify.json');
    const spotifyBeforeMalformed = fs.readFileSync(spotifyFile, 'utf8');
    const spotifyBadJson = await fetch(B + '/api/spotify/auth/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': apiToken }, body: '{not json'
    });
    A.eq(spotifyBadJson.status, 400, 'Spotify auth start with malformed JSON -> 400 even when a client id is already saved');
    A.eq(fs.readFileSync(spotifyFile, 'utf8'), spotifyBeforeMalformed, 'malformed Spotify auth start leaves durable OAuth configuration byte-identical');

    // ---- /api/file media serving: typed content-type + HTTP Range (so COMMS <video>/<audio> can seek) ----
    // write a known-size clip into the agent's jailed workspace (<ws>/agent/clips/clip.webm)
    const N = 1000;
    fs.mkdirSync(path.join(ws, 'agent', 'clips'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', 'clips', 'clip.webm'), Buffer.alloc(N, 7));
    const fileUrl = B + '/api/file?agent=agent&path=' + encodeURIComponent('clips/clip.webm');

    // the deliverable-read route is token-gated too (audit C2: GET data routes were readable without a token)
    const fileNoTok = await fetch(fileUrl);
    A.eq(fileNoTok.status, 403, 'GET /api/file WITHOUT a token -> 403');

    const full = await fetch(fileUrl, { headers: tok });
    A.eq(full.status, 200, 'GET /api/file (with token) -> 200');
    A.eq(full.headers.get('content-type'), 'video/webm', 'webm served with a video content-type');
    A.ok(/^inline\b/.test(full.headers.get('content-disposition') || ''), 'video deliverable is still served inline');
    A.eq(full.headers.get('accept-ranges'), 'bytes', 'full response advertises byte-range support');
    A.eq(full.headers.get('content-length'), String(N), 'full Content-Length is the file size');
    A.eq((await full.arrayBuffer()).byteLength, N, 'full body is the whole file');

    const ranged = await fetch(fileUrl, { headers: Object.assign({ Range: 'bytes=100-199' }, tok) });
    A.eq(ranged.status, 206, 'ranged GET -> 206 Partial Content');
    A.eq(ranged.headers.get('content-range'), 'bytes 100-199/' + N, 'Content-Range names the served slice + total');
    A.eq(ranged.headers.get('content-length'), '100', 'partial Content-Length is the slice size');
    A.eq((await ranged.arrayBuffer()).byteLength, 100, 'partial body is exactly the requested 100 bytes');

    const suffix = await fetch(fileUrl, { headers: Object.assign({ Range: 'bytes=-50' }, tok) });
    A.eq(suffix.status, 206, 'suffix range -> 206');
    A.eq(suffix.headers.get('content-range'), 'bytes 950-999/' + N, 'suffix range resolves to the last N bytes');

    const unsat = await fetch(fileUrl, { headers: Object.assign({ Range: 'bytes=99999-' }, tok) });
    A.eq(unsat.status, 416, 'unsatisfiable range -> 416');
    A.eq(unsat.headers.get('content-range'), 'bytes */' + N, '416 reports the full size');

    const head = await fetch(fileUrl, { method: 'HEAD', headers: tok });
    A.eq(head.status, 200, 'HEAD /api/file -> 200');
    A.eq(head.headers.get('content-length'), String(N), 'HEAD reports the size with no body');
    A.eq((await head.arrayBuffer()).byteLength, 0, 'HEAD carries no body');

    const nativeUrl = fileUrl + '&token=' + encodeURIComponent(apiToken);
    const nativeMedia = await fetch(nativeUrl, { headers: { Range: 'bytes=0-9' } });
    A.eq(nativeMedia.status, 206, 'GET /api/file with ?token supports native media loads');
    A.eq(nativeMedia.headers.get('content-range'), 'bytes 0-9/' + N, 'query-token media load still supports Range');

    const escape = await fetch(B + '/api/file?agent=agent&path=' + encodeURIComponent('../../etc/passwd'), { headers: tok });
    A.ok(escape.status === 403 || escape.status === 404, 'a jail-escape path is refused (403/404), never served');

    // ---- /api/file active deliverables: script-capable files download with a sandbox CSP instead of executing
    //      on the app's origin with API-token authority. Media UX above stays inline/range-capable.
    fs.mkdirSync(path.join(ws, 'agent', 'active'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', 'active', 'page.html'), '<script>fetch("/api/budget/status")</script>');
    fs.writeFileSync(path.join(ws, 'agent', 'active', 'app.js'), 'fetch("/api/budget/status")');
    fs.writeFileSync(path.join(ws, 'agent', 'active', 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const f of ['page.html', 'app.js', 'vector.svg']) {
      const activeNoTok = await fetch(B + '/api/file?agent=agent&path=' + encodeURIComponent('active/' + f));
      A.eq(activeNoTok.status, 403, f + ' active deliverable without token is blocked');
      const active = await fetch(B + '/api/file?agent=agent&path=' + encodeURIComponent('active/' + f) + '&token=' + encodeURIComponent(apiToken));
      A.eq(active.status, 200, f + ' served for download');
      A.eq(active.headers.get('content-type'), 'application/octet-stream', f + ' loses executable content-type');
      A.ok(/^attachment\b/.test(active.headers.get('content-disposition') || ''), f + ' is an attachment, not inline');
      A.ok(/sandbox/.test(active.headers.get('content-security-policy') || ''), f + ' carries a sandbox CSP');
      A.ok(/script-src 'none'/.test(active.headers.get('content-security-policy') || ''), f + ' explicitly denies script');
    }

    // ---- /api/summon/ack: the team.summon round-trip's reply leg. A stale runId/requestId is a harmless 200
    //      no-op (the run already ended or auto-settled), exactly like /api/consent; malformed JSON 400s. ----
    const ackStale = await j('POST', '/api/summon/ack', { runId: 'nope', requestId: 'nope', agentId: 'researcher-2' });
    A.eq(ackStale.status, 200, 'POST /api/summon/ack with an unknown run -> 200 no-op');
    const ackBadJson = await fetch(B + '/api/summon/ack', { method: 'POST', headers: { 'X-StarNet-Token': apiToken }, body: '{not json' });
    A.eq(ackBadJson.status, 400, 'POST /api/summon/ack with malformed JSON -> 400');

    // ---- memory observability + new-hero reset: the declined reject-list GET, the undo-a-discard restore, and the
    //      server-side memory wipe are all token-gated, agent-validated, and wired through the real router. ----
    const declNoTok = await fetch(B + '/api/memory/declined?agent=agent');
    A.eq(declNoTok.status, 403, 'GET /api/memory/declined WITHOUT a token -> 403 (gated data route)');
    const decl = await j('GET', '/api/memory/declined?agent=agent');
    A.eq(decl.status, 200, 'GET /api/memory/declined (with token) -> 200');
    A.ok(Array.isArray(decl.body.declined), 'declined is an array (empty for a fresh agent)');
    const declBadAgent = await j('GET', '/api/memory/declined?agent=' + encodeURIComponent('../evil'));
    A.eq(declBadAgent.status, 403, 'a path-traversal agent id on the declined route -> 403');

    const restoreNoTok = await fetch(B + '/api/memory/declined/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: JSON.stringify({ agent: 'agent', text: 'x' }) });
    A.eq(restoreNoTok.status, 403, 'POST /api/memory/declined/restore WITHOUT a token -> 403');
    const restoreNoText = await j('POST', '/api/memory/declined/restore', { agent: 'agent' });
    A.eq(restoreNoText.status, 400, 'restore without text -> 400');
    const restoreMiss = await j('POST', '/api/memory/declined/restore', { agent: 'agent', text: 'never declined' });
    A.eq(restoreMiss.status, 200, 'restore of an absent belief -> 200 (no-op)');
    A.eq(restoreMiss.body.removed, false, 'restore reports removed=false when nothing matched');

    // ---- silent-save UX: the one-tap VETO on an auto-saved memory. Seed a real notebook record on disk (the
    //      sidecar's durable store reads through to the file on every get), then undo it: the record is removed
    //      AND its text lands on the permanent declined denylist, and a repeat veto is an idempotent no-op. ----
    const vetoNoTok = await fetch(B + '/api/memory/turnin', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: JSON.stringify({ agentId: 'agent', id: 'note_1', verdict: 'veto' }) });
    A.eq(vetoNoTok.status, 403, 'POST /api/memory/turnin veto WITHOUT a token -> 403');
    const vetoBadVerdict = await j('POST', '/api/memory/turnin', { agentId: 'agent', id: 'note_1', verdict: 'nonsense' });
    A.eq(vetoBadVerdict.status, 400, 'an unknown verdict -> 400');
    const vetoNoId = await j('POST', '/api/memory/turnin', { agentId: 'agent', verdict: 'veto' });
    A.eq(vetoNoId.status, 400, 'veto without an id -> 400');
    // seed one saved record + a distinct one that must survive the veto
    fs.writeFileSync(path.join(ws, 'agent.notebook.json'), JSON.stringify([
      { id: 'note_1', kind: 'fact', title: 'Fact', body: 'deploys the alpha service with npm publish', content: 'deploys the alpha service with npm publish', scope: 'global', createdAt: 1, ts: 1, useCount: 0, trust: 0, pinned: false },
      { id: 'note_2', kind: 'profile', title: 'Preference', body: 'prefers terse answers', content: 'prefers terse answers', scope: 'global', createdAt: 2, ts: 2, useCount: 0, trust: 0, pinned: false }
    ]));
    const veto = await j('POST', '/api/memory/turnin', { agentId: 'agent', id: 'note_1', verdict: 'veto', content: 'deploys the alpha service with npm publish' });
    A.eq(veto.status, 200, 'veto of a saved record -> 200');
    A.eq(veto.body.ok, true, 'veto reports ok');
    const recsAfter = await j('GET', '/api/memory/records?agent=agent');
    const ids = (recsAfter.body.records || []).map(r => r.id);
    A.ok(ids.indexOf('note_1') < 0, 'the vetoed record was removed from the notebook');
    A.ok(ids.indexOf('note_2') >= 0, 'the distinct record beside it survived');
    const declVeto = await j('GET', '/api/memory/declined?agent=agent');
    A.ok((declVeto.body.declined || []).indexOf('deploys the alpha service with npm publish') >= 0, 'the vetoed belief joined the permanent declined denylist');
    // idempotent: vetoing an already-gone record still succeeds (no 404, no double-append)
    const vetoAgain = await j('POST', '/api/memory/turnin', { agentId: 'agent', id: 'note_1', verdict: 'veto', content: 'deploys the alpha service with npm publish' });
    A.eq(vetoAgain.status, 200, 'a repeat veto of an already-removed record is an idempotent 200 no-op');
    const declAgain = await j('GET', '/api/memory/declined?agent=agent');
    A.eq((declAgain.body.declined || []).filter(t => t === 'deploys the alpha service with npm publish').length, 1, 'the denylist has no duplicate after a repeat veto');
    // SOURCE LOCK — auto-saved (saved:true) stash items carry a REAL record id; a keep/edit on one would mint a
    // DUPLICATE note and a discard would denylist while the record survives. The handler must 409 them before the
    // write path (the stash is in-memory + LLM-fed, so this guarantee is locked at the source seam).
    const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
    const iTurnin = idxSrc.indexOf('async function handleMemoryTurnin');
    const iWrite = idxSrc.indexOf('writeMemoryRecord(agentId, prop', iTurnin);
    // needle pins the GUARANTEE (a .saved item 409s before the write), not the local variable name that holds it —
    // the durable pending queue renamed the batch lookup to `live`, and a lock that breaks on a rename teaches
    // nothing about whether the guarantee survived.
    const guard = idxSrc.indexOf('.saved) return json(409', iTurnin);
    A.ok(iTurnin > 0 && iWrite > iTurnin, 'handleMemoryTurnin routes keep/edit through writeMemoryRecord');
    A.ok(guard > iTurnin && guard < iWrite, 'a saved:true stash item is 409-rejected BEFORE the keep/edit write path (no duplicate mint)');

    // PENDING QUEUE (durable, cross-run): unattended runs reflect now, so a high-stakes deck can be raised with
    // nobody watching. The route is the surface that keeps it answerable — it must exist, be agent-gated, and
    // report an EMPTY deck honestly rather than 404-ing or inventing rows.
    const pend = await j('GET', '/api/memory/pending?agent=agent');
    A.eq(pend.status, 200, 'GET /api/memory/pending -> 200');
    A.eq(pend.body.agentId, 'agent', 'the pending deck is reported per agent');
    A.eq(pend.body.pending, [], 'a station with nothing awaiting a verdict reports an empty deck');
    const pendBad = await j('GET', '/api/memory/pending?agent=..%2Fetc');
    A.eq(pendBad.status, 403, 'a bad agent id is refused, not path-joined');

    // ---- FORGET = NEVER AGAIN (2026-07-16 resurrect audit): Memory Core's Forget must be as durable as a
    //      veto/discard — the removed belief's text joins the SAME permanent declined denylist, or reflection
    //      re-mints the deleted fact on a later run and the silent-save writes it straight back. ----
    const forgetNoTok = await fetch(B + '/api/memory/forget', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: JSON.stringify({ agentId: 'agent', id: 'note_2' }) });
    A.eq(forgetNoTok.status, 403, 'POST /api/memory/forget WITHOUT a token -> 403');
    const forget = await j('POST', '/api/memory/forget', { agentId: 'agent', id: 'note_2' });
    A.eq(forget.status, 200, 'forget of a saved record -> 200');
    const recsPostForget = await j('GET', '/api/memory/records?agent=agent');
    A.ok((recsPostForget.body.records || []).every(r => r.id !== 'note_2'), 'the forgotten record was removed from the notebook');
    const declForget = await j('GET', '/api/memory/declined?agent=agent');
    A.ok((declForget.body.declined || []).indexOf('prefers terse answers') >= 0, 'the FORGOTTEN belief joined the permanent declined denylist (forget = never re-minted)');
    const forgetMiss = await j('POST', '/api/memory/forget', { agentId: 'agent', id: 'note_2' });
    A.eq(forgetMiss.status, 404, 'a repeat forget of a gone record -> 404 (nothing to remove)');
    const declForget2 = await j('GET', '/api/memory/declined?agent=agent');
    A.eq((declForget2.body.declined || []).filter(t => t === 'prefers terse answers').length, 1, 'a repeat forget appends no duplicate denylist entry');

    const resetNoTok = await fetch(B + '/api/memory/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: JSON.stringify({ agent: 'agent' }) });
    A.eq(resetNoTok.status, 403, 'POST /api/memory/reset WITHOUT a token -> 403');
    const resetBad = await j('POST', '/api/memory/reset', { agent: '../evil' });
    A.eq(resetBad.status, 403, 'reset with a path-traversal agent id -> 403');
    const reset = await j('POST', '/api/memory/reset', { agent: 'agent' });
    A.eq(reset.status, 200, 'POST /api/memory/reset (with token) -> 200');
    A.eq(reset.body.ok, true, 'reset reports ok');
    A.eq(reset.body.agent, 'agent', 'reset echoes the agent it cleared');
    const declAfter = await j('GET', '/api/memory/declined?agent=agent');
    A.eq(JSON.stringify(declAfter.body.declined), '[]', 'the declined list reads empty after a reset');

    // ================= P1 SETTINGS ROWS =================

    // ---- P1-9 ADVANCED runtime knobs: token-gated, persist an override, report env-precedence, reset ----
    const knobsNoTok = await fetch(B + '/api/runtime/knobs');
    A.eq(knobsNoTok.status, 403, 'GET /api/runtime/knobs WITHOUT a token -> 403');
    const knobs = await j('GET', '/api/runtime/knobs');
    A.eq(knobs.status, 200, 'GET /api/runtime/knobs -> 200');
    A.ok(knobs.body.fields && knobs.body.fields.maxIters, 'knobs report the maxIters field');
    A.eq(knobs.body.fields.maxIters.default, 0, 'maxIters defaults to unlimited');
    A.eq(knobs.body.fields.maxConcurrentAgents.default, 0, 'agent concurrency defaults to unlimited');
    A.eq(knobs.body.fields.maxIters.saved, null, 'no saved override before any POST');
    const knobsSet = await j('POST', '/api/runtime/knobs', { maxIters: 55, cronTickMs: 30000 });
    A.eq(knobsSet.status, 200, 'POST /api/runtime/knobs -> 200');
    A.eq(knobsSet.body.fields.maxIters.saved, 55, 'the saved override is recorded');
    A.eq(knobsSet.body.fields.maxIters.effective, 55, 'the saved override becomes effective');
    const knobsBad = await j('POST', '/api/runtime/knobs', { maxIters: 9999 });
    A.eq(knobsBad.status, 400, 'an out-of-range knob value -> 400');
    A.ok(fs.existsSync(path.join(ws, 'runtime.knobs.json')), 'the knobs override persisted to disk');
    const knobsReset = await j('POST', '/api/runtime/knobs', { maxIters: null, cronTickMs: null });
    A.eq(knobsReset.body.fields.maxIters.saved, null, 'a null clears the override');

    // ---- P1-10 memory controls: reflection on/off + cooldown, persisted + validated ----
    const memCfg = await j('GET', '/api/memory/config');
    A.eq(memCfg.status, 200, 'GET /api/memory/config -> 200');
    A.eq(memCfg.body.reflectEnabled, true, 'reflection defaults ON');
    A.ok(typeof memCfg.body.scopeNote === 'string' && memCfg.body.scopeNote.length > 0, 'a scope note is returned');
    const memSet = await j('POST', '/api/memory/config', { reflectEnabled: false, reflectCooldownMs: 300000 });
    A.eq(memSet.status, 200, 'POST /api/memory/config -> 200');
    A.eq(memSet.body.reflectEnabled, false, 'reflection can be turned off');
    A.eq(memSet.body.reflectCooldownMs, 300000, 'the cooldown persists');
    const memBad = await j('POST', '/api/memory/config', { reflectCooldownMs: 99999999 });
    A.eq(memBad.status, 400, 'an over-range cooldown -> 400');
    A.ok(fs.existsSync(path.join(ws, 'memory.config.json')), 'the memory config persisted to disk');

    // ---- P1-7 STATION BACKUP: export excludes secrets; import round-trips + reset ----
    // first seed a real budget override so the export has something server-side to carry.
    await j('POST', '/api/budget/caps', { perRun: 7 });
    const exp = await j('POST', '/api/config/export', { sections: { settings: { theme: 'blue' }, autonomy: { initiative: 'wait', reach: 'sandbox' } } });
    A.eq(exp.status, 200, 'POST /api/config/export -> 200');
    A.eq(exp.body.starnetExport, 1, 'the export carries the schema-version pivot');
    A.eq(exp.body.sections.budget.perRun, 7, 'the export carries the saved budget override');
    A.eq(exp.body.sections.settings.theme, 'blue', 'the export carries the browser-owned settings slice');
    // SECURITY: the seeded Discord token / provider keys must NOT appear anywhere in the export.
    A.ok(JSON.stringify(exp.body).indexOf('discord-token') < 0, 'the export never contains the Discord bot token');
    A.ok(JSON.stringify(exp.body).indexOf('sk-') < 0, 'the export never contains a key-shaped secret');

    // now reset the budget, then import the envelope back and prove the value is restored.
    const rst = await j('POST', '/api/config/reset', { section: 'budget' });
    A.eq(rst.status, 200, 'POST /api/config/reset{budget} -> 200');
    const afterReset = await j('GET', '/api/budget/status');
    A.ok(!Object.prototype.hasOwnProperty.call(afterReset.body.saved, 'perRun'), 'budget override cleared by reset');
    const imp = await j('POST', '/api/config/import', { envelope: exp.body });
    A.eq(imp.status, 200, 'POST /api/config/import -> 200');
    A.ok(imp.body.applied.indexOf('budget') >= 0, 'import reports budget applied');
    A.ok(imp.body.browser && imp.body.browser.settings && imp.body.browser.settings.theme === 'blue', 'import echoes the browser settings slice for local restore');
    const afterImport = await j('GET', '/api/budget/status');
    A.eq(afterImport.body.saved.perRun, 7, 'the imported budget override is restored (round-trip)');
    const impBad = await j('POST', '/api/config/import', { envelope: { not: 'a backup' } });
    A.eq(impBad.status, 400, 'import of a file with no version marker -> 400');
    const rstBad = await j('POST', '/api/config/reset', { section: 'nonsense' });
    A.eq(rstBad.status, 400, 'reset of an unknown section -> 400');
    const expNoTok = await fetch(B + '/api/config/export', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: '{}' });
    A.eq(expNoTok.status, 403, 'POST /api/config/export WITHOUT a token -> 403');

    // ---- voice: /api/tts + /api/stt graceful degradation (no key in this boot → no network) ----
    // Both routes must ALWAYS answer 200 with a degrade envelope rather than a hard error, so the client's
    // voice path never wedges. With the env keys cleared at spawn, we exercise exactly that path — but
    // /api/tts resolves a credential CHAIN (openrouter → gemini → openai), so first clear the fake OpenAI
    // runtime key the /api/key tests pushed above, or the chain would pick it up and hit the network.
    await fetch(B + '/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skynet-Token': IPC_TOKEN },
      body: JSON.stringify({ provider: 'openai', key: '' })
    });
    const ttsNoKey = await j('POST', '/api/tts', { text: 'station check', voice: 'Umbriel', style: 'a low, detached transmission' });
    A.eq(ttsNoKey.status, 200, 'POST /api/tts with no key -> 200 (never a hard error)');
    A.eq(ttsNoKey.body.fallback, true, 'no-key TTS returns the {fallback:true} envelope so the client uses speechSynthesis');
    A.ok(/no key/i.test(ttsNoKey.body.reason || ''), 'the TTS fallback names the no-key reason');
    const ttsNoText = await j('POST', '/api/tts', { text: '   ' });
    A.eq(ttsNoText.body.fallback, true, 'empty-text TTS also degrades cleanly');
    // ElevenLabs branch: same 200-degrade contract, its own key + validation (no network with the env cleared).
    const elBadVoice = await j('POST', '/api/tts', { provider: 'elevenlabs', text: 'station check', voiceId: 'not/a/valid/id!' });
    A.eq(elBadVoice.status, 200, 'POST /api/tts elevenlabs with a malformed voiceId -> 200');
    A.eq(elBadVoice.body.fallback, true, 'malformed voiceId degrades to the fallback envelope');
    A.ok(/bad voiceId/i.test(elBadVoice.body.reason || ''), 'the degrade names the bad-voiceId reason');
    const elNoKey = await j('POST', '/api/tts', { provider: 'elevenlabs', text: 'station check', voiceId: 'AbCdEf012345678901234' });
    A.eq(elNoKey.status, 200, 'POST /api/tts elevenlabs with no key -> 200 (never a hard error)');
    A.eq(elNoKey.body.fallback, true, 'no-key ElevenLabs TTS returns the {fallback:true} envelope');
    A.ok(/no elevenlabs key/i.test(elNoKey.body.reason || ''), 'the degrade names the missing ElevenLabs key specifically');

    // STT JSON shape: no audio -> {text:'',reason}; audio present but no key -> {text:'',reason:'no key'}.
    const sttNoAudio = await j('POST', '/api/stt', { format: 'wav' });
    A.eq(sttNoAudio.status, 200, 'POST /api/stt with no audio -> 200 (degrades, never 4xx into the loop)');
    A.eq(sttNoAudio.body.text, '', 'no-audio STT returns an empty transcript');
    A.ok(typeof sttNoAudio.body.reason === 'string' && sttNoAudio.body.reason.length > 0, 'no-audio STT surfaces a reason for the console.warn');
    const sttNoKey = await j('POST', '/api/stt', { audio: Buffer.from('not real audio').toString('base64'), format: 'wav' });
    A.eq(sttNoKey.status, 200, 'POST /api/stt with audio but no key -> 200');
    A.eq(sttNoKey.body.text, '', 'no-key STT returns an empty transcript');
    /* ⛔ "no key" IS ONLY THE TRUTH WHEN THERE IS ALSO NO KEYLESS ENGINE. The STT ladder gained a LOCAL floor
       (tier 4) so a station whose brain is a ChatGPT/Codex or Anthropic subscription is not simply deaf — none
       of those credentials is a transcription key. Where that floor is installed, answering "no key" would name
       the wrong cause: the station HAS ears, this clip was just undecodable. So ask the station what it can
       actually do and hold it to the matching truth — asserting one fixed string would force a lie in whichever
       world it was not written for, and dropping to "some reason exists" would guard nothing. */
    const sttStatus = await j('GET', '/api/stt/status');
    A.eq(sttStatus.status, 200, 'GET /api/stt/status -> 200');
    A.ok(['cloud', 'local', 'native', 'none'].includes(sttStatus.body.preferred), 'STT status names one supported classic provider leg');
    A.eq(sttStatus.body.available, sttStatus.body.preferred !== 'none', 'STT status availability agrees with its preferred leg');
    A.ok(['cloud', 'local', 'native'].every(k => typeof sttStatus.body[k] === 'boolean'), 'STT status exposes capability booleans without credentials');
    const localVoice = await j('GET', '/api/local-voice/status');
    const canHearKeyless = !!(localVoice.body && localVoice.body.available);
    if (canHearKeyless) {
      A.ok(/local/i.test(sttNoKey.body.reason || ''), 'with a keyless local engine the degrade names THAT tier failing, not a missing key');
      A.ok(!/no key/i.test(sttNoKey.body.reason || ''), 'and never blames a key on a station that can transcribe without one');
    } else {
      A.ok(/no key/i.test(sttNoKey.body.reason || ''), 'with no engine and no key the STT degrade names the no-key reason');
    }
    // raw-bytes shape (the recorder-provider default): a webm content-type body, still no key -> clean degrade.
    const sttRaw = await fetch(B + '/api/stt', { method: 'POST', headers: Object.assign({ 'Content-Type': 'audio/webm' }, apiToken ? { 'X-StarNet-Token': apiToken } : {}), body: Buffer.from('fake opus bytes') });
    A.eq(sttRaw.status, 200, 'POST /api/stt raw audio bytes -> 200');
    const sttRawBody = await sttRaw.json();
    A.eq(sttRawBody.text, '', 'raw-bytes STT with no key returns an empty transcript');

    // ---- P1-2 ROSTER GUARD: a malformed /api/roster body must NEVER wipe the persisted crew (data-loss bug). ----
    // Establish a real persisted roster first (valid push -> 200 + on-disk file), then fire every malformed shape
    // and prove each is a 400 that leaves the roster file on disk BYTE-FOR-BYTE unchanged (non-destruction).
    const rosterFile = path.join(ws, 'agent.roster.json');
    const validPush = await j('POST', '/api/roster', { agents: [
      { agentId: 'agent', system: 'hero', name: 'Ultron', model: 'anthropic/claude-sonnet-4.6', provider: 'openrouter', role: 'orchestrator' },
      { agentId: 'researcher-2', system: 'worker', name: 'Scout', model: '', provider: 'openrouter', role: 'research' }
    ] });
    A.eq(validPush.status, 200, 'POST /api/roster with a valid crew -> 200');
    A.eq(validPush.body.count, 2, 'the valid push persisted both agents');
    A.ok(fs.existsSync(rosterFile), 'the roster round-tripped to disk');
    const rosterBefore = fs.readFileSync(rosterFile, 'utf8');
    A.ok(rosterBefore.indexOf('researcher-2') >= 0, 'the persisted roster names the summoned worker');

    // every malformed body -> 400 AND the on-disk roster is untouched (prove by reading the store back)
    const malformed = [
      ['missing agents field', {}],
      ['agents is null', { agents: null }],
      ['agents is a string', { agents: 'agent' }],
      ['agents is an object', { agents: { agentId: 'x' } }],
      ['agents is empty (would clear the crew)', { agents: [] }],
      ['an agent entry is null', { agents: [null] }],
      ['an agent entry is a string', { agents: ['agent'] }],
      ['an agent entry is an array', { agents: [[]] }],
      ['an agent has a numeric agentId (coercion class)', { agents: [{ agentId: 123, name: 'x' }] }],
      ['an agent has no agentId', { agents: [{ name: 'x' }] }],
      ['an agent has an out-of-charset agentId', { agents: [{ agentId: '../evil', name: 'x' }] }]
    ];
    for (const [label, badBody] of malformed) {
      const r = await j('POST', '/api/roster', badBody);
      A.eq(r.status, 400, 'malformed /api/roster (' + label + ') -> 400, not a silent wipe');
      A.ok(r.body && typeof r.body.error === 'string', 'the ' + label + ' rejection carries a JSON error envelope');
      A.eq(fs.readFileSync(rosterFile, 'utf8'), rosterBefore, 'the persisted roster is UNCHANGED after the ' + label + ' rejection (no data loss)');
    }
    // a top-level array body (not an object) is also refused without clobbering
    const arrBody = await fetch(B + '/api/roster', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, tok), body: JSON.stringify([{ agentId: 'agent' }]) });
    A.eq(arrBody.status, 400, 'a top-level array roster body -> 400');
    A.eq(fs.readFileSync(rosterFile, 'utf8'), rosterBefore, 'a top-level array body leaves the roster unchanged');
    // a malformed-JSON body is a 400 too and never touches the store
    const rosterBadJson = await fetch(B + '/api/roster', { method: 'POST', headers: tok, body: '{not json' });
    A.eq(rosterBadJson.status, 400, 'POST /api/roster with malformed JSON -> 400');
    A.eq(fs.readFileSync(rosterFile, 'utf8'), rosterBefore, 'malformed JSON leaves the roster unchanged');
    // and a fresh VALID push still works after all the rejections (the guard did not wedge the route)
    const revalid = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'solo', name: 'Ultron', provider: 'openrouter' }] });
    A.eq(revalid.status, 200, 'a valid push after the rejections still succeeds');
    A.eq(revalid.body.count, 1, 'the follow-up valid push replaced the roster as intended');
    A.ok(fs.readFileSync(rosterFile, 'utf8').indexOf('researcher-2') < 0, 'the legitimate replacement dropped the old worker (clear-and-set still works)');

    // ---- P1.1 ROSTER ENVELOPE + ANTI-CLOBBER (UPDATE_STATE_SAFETY_AUDIT): { version, updatedAt, agents } + refuse a stale push ----
    // Stamps are anchored to a real-clock base ABOVE any prior stamp-less host-clock save this test already made
    // (the earlier P1-2 guard block's unstamped pushes advance the baseline off Date.now()), so these are genuinely
    // fresher / staler relative to the LIVE baseline rather than to fixed small numbers.
    const eBase = Date.now() + 100000;
    // 1) a stamped push round-trips into an envelope on disk (version + updatedAt) and echoes the accepted stamp.
    const envPush = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'solo', name: 'Ultron', provider: 'openrouter' }], updatedAt: eBase });
    A.eq(envPush.status, 200, 'a stamped roster push -> 200');
    A.eq(envPush.body.updatedAt, eBase, 'the accepted push echoes its own updatedAt stamp');
    const env = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    A.eq(env.version, 1, 'the on-disk roster carries version:1');
    A.eq(env.updatedAt, eBase, 'the on-disk envelope records the accepted updatedAt (anti-clobber baseline)');
    A.ok(Array.isArray(env.agents) && env.agents.length === 1, 'the envelope holds the agents array');
    // 2) a STALE push (older updatedAt) is refused with 200 { ok:false, stale:true } and does NOT mutate the store.
    const envBefore = fs.readFileSync(rosterFile, 'utf8');
    const stale = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'STALE', name: 'Ghost', provider: 'openrouter' }], updatedAt: eBase - 1000 });
    A.eq(stale.status, 200, 'a stale roster push -> 200 (behind, not malformed)');
    A.eq(stale.body.ok, false, 'the stale push is refused (ok:false)');
    A.eq(stale.body.stale, true, 'the stale push is flagged stale:true');
    A.eq(stale.body.updatedAt, eBase, 'the stale rejection reports the authoritative on-disk updatedAt');
    A.eq(fs.readFileSync(rosterFile, 'utf8'), envBefore, 'the stale push left the roster BYTE-FOR-BYTE unchanged (no clobber)');
    // 3) a NEWER push wins and advances the baseline.
    const fresh = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'fresh', name: 'Ultron', provider: 'openrouter' }], updatedAt: eBase + 1000 });
    A.eq(fresh.status, 200, 'a newer roster push -> 200');
    A.eq(fresh.body.ok, true, 'the newer push is accepted');
    A.eq(JSON.parse(fs.readFileSync(rosterFile, 'utf8')).updatedAt, eBase + 1000, 'the newer stamp is now the on-disk baseline');
    // 4) BACKWARD COMPAT: a stamp-less push (legacy frontend) skips the gate and still writes as today.
    const noStamp = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'legacy-client', name: 'Ultron', provider: 'openrouter' }] });
    A.eq(noStamp.status, 200, 'a stamp-less (legacy) push -> 200');
    A.eq(noStamp.body.ok, true, 'a stamp-less push is accepted (backward compatible)');
    A.ok(fs.readFileSync(rosterFile, 'utf8').indexOf('legacy-client') >= 0, 'the stamp-less push persisted');

    // ---- P1.1 UNKNOWN-FIELD PRESERVATION: a field a NEWER frontend adds must survive an older sidecar's re-save ----
    // Push an agent carrying a field this sidecar's schema does NOT model (futureField). On re-save saveAgentRoster
    // rebuilds each row from a fixed known-field list — WITHOUT preservation that field would be silently dropped
    // (the exact reshape-on-save data-loss class P1.1 flags). Prove it round-trips onto disk under the known fields.
    // Stamp above the current baseline (the stamp-less push above advanced it off the host clock).
    const fwPush = await j('POST', '/api/roster', { agents: [
      { agentId: 'agent', system: 'hero', name: 'Ultron', provider: 'openrouter', futureField: 'keep-me-42', nested: { a: 1 } }
    ], updatedAt: Date.now() + 200000 });
    A.eq(fwPush.status, 200, 'a push with an unknown per-agent field -> 200');
    const fwDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const fwRec = fwDisk.agents.find(a => a.agentId === 'agent');
    A.ok(fwRec, 'the agent persisted');
    A.eq(fwRec.futureField, 'keep-me-42', 'an UNKNOWN scalar field is preserved through re-save (no reshape drop)');
    A.ok(fwRec.nested && fwRec.nested.a === 1, 'an UNKNOWN nested field is preserved through re-save');
    A.eq(fwRec.name, 'Ultron', 'the KNOWN fields still win / persist alongside the preserved ones');
    A.eq(fwRec.provider, 'openrouter', 'the known provider field is intact next to the preserved unknowns');

    // ---- DELETE AGENT ⇒ ITS AUTOMATION DIES TOO (2026-07-16 resurrect audit): a deleted agent's cron
    //      routines (incl. its away-workshop shift) kept firing forever — spend + ghost sessions under the
    //      dead agentId. handleAgentDelete must drop every job bound to the agent; the hero's jobs survive. ----
    {
      // roster the doomed specialist so the create paths accept it as a real agent
      const dPush = await j('POST', '/api/roster', { agents: [
        { agentId: 'agent', system: 'hero', name: 'Ultron', provider: 'openrouter' },
        { agentId: 'doomed-7', system: 'worker', name: 'Doomed', provider: 'openrouter', role: 'research' }
      ], updatedAt: Date.now() + 300000 });
      A.eq(dPush.status, 200, 'rostered the doomed specialist');
      const mkJob = await j('POST', '/api/cron', { name: 'Doomed digest', prompt: 'summarize', schedule: 'every 60m', agentId: 'doomed-7' });
      A.eq(mkJob.status, 200, 'created a routine bound to the doomed agent');
      const mkHero = await j('POST', '/api/cron', { name: 'Hero digest', prompt: 'summarize', schedule: 'every 60m', agentId: 'agent' });
      A.eq(mkHero.status, 200, 'created a routine bound to the hero');
      const grant = await j('POST', '/api/workshop/grant', { agentId: 'doomed-7', on: true });
      A.eq(grant.status, 200, 'armed the doomed agent\'s away-workshop shift (a second cron job, meta.workshop)');
      const cronBefore = await j('GET', '/api/cron');
      A.eq((cronBefore.body.jobs || []).filter(x => x.agentId === 'doomed-7').length, 2, 'the doomed agent owns 2 jobs (routine + workshop shift)');
      const del = await j('POST', '/api/agent/delete', { agentId: 'doomed-7' });
      A.eq(del.status, 200, 'POST /api/agent/delete -> 200');
      A.eq(del.body.cronRemoved, 2, 'the delete reports BOTH of the agent\'s cron jobs removed');
      const cronAfter = await j('GET', '/api/cron');
      A.eq((cronAfter.body.jobs || []).filter(x => x.agentId === 'doomed-7').length, 0, 'no cron job survives for the deleted agent (nothing left to fire/resurrect)');
      A.eq((cronAfter.body.jobs || []).filter(x => x.agentId === 'agent' && x.name === 'Hero digest').length, 1, 'the hero\'s routine is untouched');
      // cleanup so later sections see the state they expect
      const heroJob = (cronAfter.body.jobs || []).find(x => x.agentId === 'agent' && x.name === 'Hero digest');
      if (heroJob) await j('POST', '/api/cron/remove', { id: heroJob.id });
      await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'hero', name: 'Ultron', provider: 'openrouter', futureField: 'keep-me-42', nested: { a: 1 } }], updatedAt: Date.now() + 400000 });
    }

    // ---- reconnect reconciliation snapshot: GET /api/state/snapshot returns the documented shape, token-gated ----
    const snapNoTok = await fetch(B + '/api/state/snapshot');
    A.eq(snapNoTok.status, 403, 'GET /api/state/snapshot WITHOUT a token -> 403 (gated like sibling GETs)');
    const snap = await j('GET', '/api/state/snapshot');
    A.eq(snap.status, 200, 'GET /api/state/snapshot -> 200');
    A.ok(snap.body && typeof snap.body.ts === 'number', 'snapshot carries a numeric server ts');
    A.ok(Array.isArray(snap.body.runs), 'snapshot.runs is an array');
    A.ok(Array.isArray(snap.body.prompts), 'snapshot.prompts is an array');
    A.ok(Array.isArray(snap.body.summons), 'snapshot.summons is an array');
    A.ok(Array.isArray(snap.body.queues), 'snapshot.queues is an array');
    // an idle boot has no live runs — the endpoint must report EMPTY, not a fabricated placeholder (truthful telemetry).
    A.eq(snap.body.runs.length, 0, 'an idle boot reports zero live runs (honest, not fabricated)');
    A.eq(JSON.stringify(snap.body).indexOf(apiToken), -1, 'the snapshot never echoes the API token');

    // ---- V-EDGE unit: secMsGec shape + the exported WS codec round-trips (fragmentation + ping) offline ----
    // fixed injected clock (determinism law: secMsGec takes nowMs), aligned to a 300s-window START so the
    // +stable/+roll offsets below are unambiguous. (windows are on (unix+11644473600) seconds boundaries)
    const gecT = (1784000000 - ((1784000000 + 11644473600) % 300)) * 1000;
    const gec = edge.secMsGec(gecT);
    A.ok(/^[0-9A-F]{64}$/.test(gec), 'secMsGec(nowMs) returns 64 uppercase hex chars');
    A.eq(edge.secMsGec(gecT + 299000), gec, 'secMsGec is stable within the same 300s window');
    A.ok(edge.secMsGec(gecT + 300000) !== gec, 'secMsGec rolls to a new token in the next 300s window');
    {
      // simple masked (client-style) round-trip: one text frame encodes and parses back unchanged
      const frames = [];
      const parse = edge.makeWsParser((op, payload) => frames.push({ op, text: payload.toString('utf8') }), () => {});
      parse(edge.wsEncode(0x1, Buffer.from('hello station', 'utf8')));
      A.eq(frames.length, 1, 'one full masked frame parsed');
      A.eq(frames[0].op, 0x1, 'opcode preserved (text)');
      A.eq(frames[0].text, 'hello station', 'masked payload decodes back to the original bytes');
    }
    {
      // a fragmented message (fin=0 first frame + final continuation) with an interleaved ping, fed ONE byte at
      // a time to exercise the parser's incremental buffering. Server-style unmasked frames (mask:false).
      const got = [], pings = [];
      const parse = edge.makeWsParser((op, payload) => { if (op === 0x9) pings.push(payload.toString('utf8')); else got.push({ op, text: payload.toString('utf8') }); }, () => {});
      const first = edge.wsEncode(0x1, Buffer.from('frag-', 'utf8'), { mask: false }); first[0] &= 0x7f;   // clear FIN → not final
      const cont = edge.wsEncode(0x0, Buffer.from('part2', 'utf8'), { mask: false });                       // final continuation
      const ping = edge.wsEncode(0x9, Buffer.from('png', 'utf8'), { mask: false });
      const stream = Buffer.concat([ping, first, cont]);
      for (const byte of stream) parse(Buffer.from([byte]));
      A.eq(pings.length, 1, 'the ping frame surfaced to the caller (so it can pong)');
      A.eq(got.length, 1, 'the fragmented message reassembles into exactly one delivered frame');
      A.eq(got[0].op, 0x1, 'reassembled opcode is the initiating text opcode, not the continuation');
      A.eq(got[0].text, 'frag-part2', 'fragmented payload halves are concatenated in order');
    }

    // ---- V-EDGE loopback: the free Edge TTS floor round-trips OUR chosen bytes through a local WS server that
    //      speaks the same hand-rolled protocol (exported codec), proving handleTts serves neural audio no-key ----
    {
      const audioPayload = Buffer.from([0xff, 0xf3, 0x64, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);   // fake mp3 bytes we choose
      const ssmlSeen = [];   // every SSML request the loopback served — carries the <voice name='…'> actually asked for
      const wsServer = http.createServer((rq, rs) => { rs.writeHead(426); rs.end(); });
      wsServer.on('upgrade', (rq, socket) => {
        const wskey = rq.headers['sec-websocket-key'] || '';
        const accept = crypto.createHash('sha1').update(wskey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        let sent = false;
        const respond = () => {
          if (sent) return; sent = true;
          socket.write(edge.wsEncode(0x1, Buffer.from('X-RequestId:mock\r\nPath:turn.start\r\n\r\n{}', 'utf8'), { mask: false }));
          const hdr = Buffer.from('X-RequestId:mock\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
          const hl = Buffer.alloc(2); hl.writeUInt16BE(hdr.length, 0);
          socket.write(edge.wsEncode(0x2, Buffer.concat([hl, hdr, audioPayload]), { mask: false }));
          socket.write(edge.wsEncode(0x1, Buffer.from('X-RequestId:mock\r\nPath:turn.end\r\n\r\n{}', 'utf8'), { mask: false }));
        };
        const parse = edge.makeWsParser((op, payload) => { const t = payload.toString('utf8'); if (op === 0x1 && t.includes('Path:ssml')) { ssmlSeen.push(t); respond(); } }, () => {});
        socket.on('data', parse);
        socket.on('error', () => {});
      });
      await new Promise(r => wsServer.listen(0, '127.0.0.1', r));
      const wsPort = wsServer.address().port;
      const edgeWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-edge-'));
      const eb = await boot(port + 300, edgeWs, 20, {
        // re-enable the Edge floor (the base env disabled it) and aim it at our loopback WS server over plain http
        SKYNET_EDGE_TTS: '1', STARNET_EDGE_TTS: '1',
        SKYNET_EDGE_TTS_HOST: '127.0.0.1', SKYNET_EDGE_TTS_PORT: String(wsPort), SKYNET_EDGE_TTS_INSECURE: '1'
      });
      const EB = 'http://' + HOST + ':' + eb.port;
      try {
        const etok = await bootToken(EB, EB);
        const post = (t) => fetch(EB + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': etok, Origin: EB }, body: JSON.stringify({ text: t }) });
        const r1 = await post('edge floor round trip');
        A.eq(r1.status, 200, 'edge-floor /api/tts (no key) -> 200');
        A.eq(r1.headers.get('x-voice-cache'), 'miss', 'first edge synth is a cache miss');
        A.ok(/audio\/mpeg/.test(r1.headers.get('content-type') || ''), 'edge audio is served as audio/mpeg');
        const b1 = Buffer.from(await r1.arrayBuffer());
        A.eq(b1.equals(audioPayload), true, 'the sidecar returned exactly the audio bytes our loopback WS server sent');
        const r2 = await post('edge floor round trip');
        A.eq(r2.status, 200, 'the identical second edge /api/tts -> 200');
        A.eq(r2.headers.get('x-voice-cache'), 'hit', 'an identical second edge request is served from the disk cache');
        const b2 = Buffer.from(await r2.arrayBuffer());
        A.eq(b2.equals(audioPayload), true, 'the cached edge clip is byte-identical');
        A.ok(/^edge:/.test(r2.headers.get('x-voice-provider') || ''), 'the serving tier names itself (X-Voice-Provider: edge:…)');

        /* ---- THE DEGRADED SHAPE: local:true where the staged offline engine cannot load (a damaged/custom
           build, reproduced here with the STARNET_LOCAL_VOICE=0 kill-switch).
           ⛔ THE BUG THIS LOCKS OUT (2026-07-30, found by ear): this request used to fall through into the
           KEYED provider chain, so live voice silently spoke with a different provider's identity and the
           voice picker adjusted an engine that was not there. Now the picked voice maps onto the nearest
           Edge neural — the SSML the loopback captures is the proof of which voice was actually requested,
           and the mapped name differing from Edge's own default (Christopher) is what discriminates the fix
           from the old fallthrough, with no key and no network. */
        {
          const shipWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ship-'));
          const sb = await boot(port + 350, shipWs, 20, {
            STARNET_LOCAL_VOICE: '0', SKYNET_LOCAL_VOICE: '0',
            SKYNET_EDGE_TTS: '1', STARNET_EDGE_TTS: '1',
            SKYNET_EDGE_TTS_HOST: '127.0.0.1', SKYNET_EDGE_TTS_PORT: String(wsPort), SKYNET_EDGE_TTS_INSECURE: '1'
          });
          const SB = 'http://' + HOST + ':' + sb.port;
          try {
            const stok = await bootToken(SB, SB);
            const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': stok, Origin: SB };
            const lvs = await (await fetch(SB + '/api/local-voice/status', { headers: H })).json();
            A.eq(lvs.available, false, 'the kill-switch presents the installed-build truth through the route');
            const postLocal = (t, v) => fetch(SB + '/api/tts', { method: 'POST', headers: H, body: JSON.stringify({ text: t, local: true, localVoice: v }) });
            const g = await postLocal('shipped george check', 'bm_george');
            A.eq(g.status, 200, 'local:true with the engine absent still serves (200)');
            A.eq(g.headers.get('x-voice-provider'), 'edge:en-GB-RyanNeural', 'the PICKED voice maps to its Edge neural — never the keyed chain, never Edge\'s own default');
            A.eq(Buffer.from(await g.arrayBuffer()).equals(audioPayload), true, 'and the audio really came from the Edge floor');
            A.ok(ssmlSeen.some(s => s.indexOf("name='en-GB-RyanNeural'") >= 0), 'the wire asked Edge for the mapped voice by name');
            const b = await postLocal('shipped bella check', 'af_bella');
            A.eq(b.headers.get('x-voice-provider'), 'edge:en-US-AriaNeural', 'a different pick maps differently — the picker is LIVE on an installed build, not decorative');
            const u = await postLocal('shipped unknown check', 'not-a-voice');
            A.eq(u.headers.get('x-voice-provider'), 'edge:en-US-ChristopherNeural', 'an unknown pick maps through the default voice, never to another provider');
          } finally {
            try { sb.child.kill(); } catch (_) {}
            await sleep(150);
            try { fs.rmSync(shipWs, { recursive: true, force: true }); } catch (_) {}
          }
        }
      } finally {
        try { eb.child.kill(); } catch (_) {}
        // bounded teardown: force any lingering (keep-alive/upgrade) sockets shut so close() can't stall the test.
        try { if (wsServer.closeAllConnections) wsServer.closeAllConnections(); } catch (_) {}
        await new Promise(r => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; try { wsServer.close(fin); } catch (_) { fin(); } setTimeout(fin, 1000); });
        await sleep(150);
        try { fs.rmSync(edgeWs, { recursive: true, force: true }); } catch (_) {}
      }
    }

    // ---- V-STT: the dedicated Groq Whisper ASR branch. A local mock stands in for api.groq.com; the sidecar
    //      must POST a multipart body carrying OUR audio bytes + model=whisper-large-v3-turbo, return the text ----
    {
      let seenBody = null, seenCt = '';
      const groqMock = http.createServer((rq, rs) => {
        const chunks = [];
        rq.on('data', c => chunks.push(c));
        rq.on('end', () => {
          seenBody = Buffer.concat(chunks); seenCt = String(rq.headers['content-type'] || '');
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({ text: 'station systems nominal' }));
        });
      });
      await new Promise(r => groqMock.listen(0, '127.0.0.1', r));
      const groqPort = groqMock.address().port;
      const gWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-groq-'));
      const gb = await boot(port + 400, gWs, 20, { GROQ_API_KEY: 'test', SKYNET_GROQ_BASE: 'http://127.0.0.1:' + groqPort });
      const GB = 'http://' + HOST + ':' + gb.port;
      try {
        const gtok = await bootToken(GB, GB);
        const audioBytes = Buffer.from('OPUSFAKEAUDIO-abc123');
        const r = await fetch(GB + '/api/stt', { method: 'POST', headers: { 'Content-Type': 'audio/webm', 'X-StarNet-Token': gtok, Origin: GB }, body: audioBytes });
        A.eq(r.status, 200, 'groq-keyed /api/stt -> 200');
        const body = await r.json();
        A.eq(body.text, 'station systems nominal', 'the transcript comes from the dedicated Groq Whisper branch');
        A.ok(/multipart\/form-data/.test(seenCt), 'the sidecar sent a multipart/form-data body to Groq');
        A.ok(seenBody && seenBody.includes('whisper-large-v3-turbo'), 'the multipart body carries model=whisper-large-v3-turbo');
        A.ok(seenBody && seenBody.includes('name="file"'), 'the multipart body has a file part named "file"');
        A.ok(seenBody && seenBody.indexOf(audioBytes) >= 0, 'the multipart body contains our raw audio bytes verbatim');
      } finally {
        try { gb.child.kill(); } catch (_) {}
        // bounded teardown: the sidecar's keep-alive pool may hold the mock socket open — force it shut so
        // close() returns promptly instead of waiting out the keep-alive timeout.
        try { if (groqMock.closeAllConnections) groqMock.closeAllConnections(); } catch (_) {}
        await new Promise(r => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; try { groqMock.close(fin); } catch (_) { fin(); } setTimeout(fin, 1000); });
        await sleep(150);
        try { fs.rmSync(gWs, { recursive: true, force: true }); } catch (_) {}
      }
    }

  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('sidecar.http.test');
})().catch(e => { console.log('FAIL: sidecar.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
