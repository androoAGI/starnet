'use strict';
/* node test/managed-credit-refusal.e2e.test.js — a funded StarNet-credit station must never be told it is out of
   credits (customer report 2026-10-06: "$79.24 on my account, but it says I'm out of credits and must top up").
   Two seams told that lie before this test existed:
     • a balance check that FAILED (cloud slow / 5xx / timeout) left the cached balance null, the uncapped
       admission read Number(null) as a known $0 and refused with "Out of managed credit";
     • a positive per-run cap ABOVE the wallet (a $100 cap on a $79 wallet) was reserved verbatim, so admission
       refused it as exhausted instead of capping the run at what the wallet holds.
   Boots the REAL sidecar against a fake StarNet cloud and proves, per case, what the run error says AND what the
   COMMS copy (friendlyerror.js) turns it into:
     1. /v1/balance 503 -> "couldn't check your balance" (retryable), never "out of credits";
     2. /v1/balance 401 (revoked / other account) -> "relink", never "out of credits";
     3. a saved $50 per-run cap on a $10 wallet -> the run is admitted, reserving the $10 that is there;
     4. a real $0 wallet still says "Out of managed credit" (the honest refusal is unchanged).
   Hermetic: temp workspace + profile dirs (SidecarFixture). */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Friendly = require('../frontend/app/friendlyerror.js');

(async () => {
  let balance = 10, balanceStatus = 200;
  const debits = [];
  let chatCalls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/balance')) {
      if (balanceStatus !== 200) { res.statusCode = balanceStatus; return res.end(JSON.stringify({ error: 'fixture' })); }
      return res.end(JSON.stringify({ balanceUsd: balance }));
    }
    if (req.url.includes('/history')) return res.end(JSON.stringify({ entries: [] }));
    if (req.url.includes('/models')) return res.end(JSON.stringify({ data: [{ id: 'test/model', supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000001' } }] }));
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('/v1/debit')) { debits.push(body); return res.end(JSON.stringify({ ok: true, balanceUsd: balance })); }
    if (req.url.includes('/v1/credit')) return res.end(JSON.stringify({ ok: true, balanceUsd: balance }));
    if (!req.url.includes('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
    chatCalls += 1;
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'starnet-credit-refusal-', timeoutMs: 30000, env: {
    STARNET_CLOUD_URL: base, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    SKYNET_BUDGET_PER_RUN: '', STARNET_BUDGET_PER_RUN: '', SKYNET_BUDGET_MANAGED_PER_RUN: '', STARNET_BUDGET_MANAGED_PER_RUN: '',
    STARNET_FULL_ACCESS: '1', SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0'
  } });
  fixture.env.USERPROFILE = fixture.profile; fixture.env.HOME = fixture.profile;
  const reset = (bal, status) => { balance = bal; balanceStatus = status || 200; debits.length = 0; chatCalls = 0; };
  const reserveOf = () => { const d = debits.find(x => x && x.meta && x.meta.kind === 'managed.reserve'); return d ? d.usd : null; };
  const run = async (label) => {
    const r = await fixture.json('POST', '/api/run', { provider: 'starnet', model: 'test/model', agentId: 'agent', messages: [{ role: 'user', content: 'say hello (' + label + ')' }] });
    const events = r.text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const end = events.filter(e => e.name === 'agent.run.end' && e.payload.agentId === 'agent').at(-1);
    const err = events.filter(e => e.name === 'agent.run.error' && e.payload.agentId === 'agent').at(-1);
    assert.ok(end, label + ': the run ended with a terminal event\n' + r.text.slice(-2000));
    const message = err ? String(err.payload.message || '') : '';
    const copy = message ? Friendly.friendlyError(message, null, { engineAlive: true }) : null;
    console.log('  ' + label + ': end=' + end.payload.reason + ' reserve=' + reserveOf() + ' completions=' + chatCalls +
      (message ? '\n    sidecar: ' + message + '\n    COMMS:   [' + copy.kind + (copy.retryable ? ', retry' : '') + '] ' + copy.userMessage : ''));
    return { end: end.payload, err: err && err.payload, message, copy };
  };
  const OUT_OF_CREDITS = /out of (?:managed |starnet )?credit/i;
  try {
    fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, '.secrets/credits.json'), JSON.stringify({ url: base, deviceToken: 'refusal-fixture', accountId: 'fixture', linkedAt: Date.now() }));
    await fixture.start();
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', provider: 'starnet', model: 'test/model', approvalMode: 'full' }] });

    // ---- 1. the cloud cannot answer the balance check: say so, never "out of credits" ----
    reset(79.24, 503);
    let r = await run('balance-503');
    assert.equal(r.end.reason, 'error', 'a run with an unreadable balance is refused (fail closed)');
    assert.equal(chatCalls, 0, 'no model call is made against an unknown balance');
    assert.ok(!OUT_OF_CREDITS.test(r.message), 'the sidecar never calls an unreadable balance "out of credit": ' + r.message);
    assert.ok(/couldn.t (?:check|read)|did not answer|unavailable/i.test(r.message), 'the sidecar names the failed balance check: ' + r.message);
    assert.equal(r.err.transient, true, 'the refusal is marked transient (a retry can work)');
    assert.ok(!OUT_OF_CREDITS.test(r.copy.userMessage) && !/top up/i.test(r.copy.userMessage), 'COMMS never tells a funded user to top up: ' + r.copy.userMessage);
    assert.ok(/credits are safe/i.test(r.copy.userMessage), 'COMMS says the credits are safe: ' + r.copy.userMessage);
    assert.equal(r.copy.retryable, true, 'COMMS offers a retry for a failed balance check');

    // ---- 2. the cloud refuses this station's token (revoked / another account): relink, never top up ----
    reset(79.24, 401);
    r = await run('balance-401');
    assert.equal(r.end.reason, 'error', 'a refused link is refused (fail closed)');
    assert.ok(!OUT_OF_CREDITS.test(r.message), 'a refused link is not "out of credit": ' + r.message);
    assert.ok(/relink|link/i.test(r.message), 'the sidecar names the refused link: ' + r.message);
    assert.ok(!OUT_OF_CREDITS.test(r.copy.userMessage) && !/top up/i.test(r.copy.userMessage), 'COMMS never tells a refused link to top up: ' + r.copy.userMessage);
    assert.ok(/relink|link/i.test(r.copy.userMessage), 'COMMS points at relinking: ' + r.copy.userMessage);

    // ---- 3. a per-run cap above the wallet is capped at the wallet, not refused ----
    const save = await fixture.json('POST', '/api/budget/caps', { perRun: 50 });
    assert.equal(save.status, 200, 'saving a $50 per-run cap succeeds');
    reset(10);
    r = await run('cap-above-wallet');
    assert.ok(!OUT_OF_CREDITS.test(r.message), 'a $10 wallet with a $50 cap is not "out of credit": ' + r.message);
    assert.equal(r.end.reason, 'done', 'the run is admitted and finishes (got ' + r.end.reason + ')');
    assert.equal(reserveOf(), 10, 'it reserves what the wallet holds ($10), not the $50 cap (reserve=' + reserveOf() + ')');
    assert.ok(chatCalls >= 1, 'the model was actually called');
    await fixture.json('POST', '/api/budget/caps', { perRun: null });

    // ---- 4. a real $0 wallet keeps the honest refusal ----
    reset(0);
    r = await run('empty-wallet');
    assert.equal(r.end.reason, 'error', 'an empty wallet is refused');
    assert.ok(/Out of managed credit/.test(r.message), 'a real $0 wallet still says "Out of managed credit": ' + r.message);
    assert.equal(r.copy.kind, 'managed_credit', 'and COMMS still shows the top-up copy for it');
    assert.equal(chatCalls, 0, 'no model call on an empty wallet');

    console.log('managed-credit-refusal: OK — failed check / refused link / cap above wallet never read as "out of credits"; real $0 unchanged');
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output tail ---\n' + String(fixture.output()).slice(-3000));
    process.exitCode = 1;
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
