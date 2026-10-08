'use strict';
/* node test/managed-run-cap.e2e.test.js — issue #53 "Credit Over Consumption On Simple Tasks".
   A StarNet-credit (managed, provider 'starnet') run on a fresh station used to reserve the WHOLE wallet as its
   per-run ceiling (the shipped per-run cap is 0 = off, and admission turned "no cap" into "the balance"), so one
   prompt on a busy model could spend every dollar the user had just added. This boots the REAL sidecar against a
   fake StarNet cloud (balance / debit / credit / metered chat completions — the relay charges each completion,
   the way the live proxy does) and a model that never stops calling tools, and proves:
     1. with no per-run cap chosen, a managed run reserves and spends at most the managed default ($2), then ends
        with reason 'budget' / scope 'run' and names the cap it hit (an honest stop, never a fake "done");
     2. a small balance below the default still runs (the reservation is clamped to what's there, not refused);
     3. a per-run cap the user SAVES in the Budget panel replaces the default, higher or lower;
     4. /api/budget/status tells the Budget panel which default governs StarNet-credit runs.
   Hermetic: temp workspace + APPDATA/LOCALAPPDATA/USERPROFILE/HOME all point at scratch dirs. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const CALL_USD = 0.75;   // what the relay charges per completion in this fixture

(async () => {
  let balance = 10;
  const debits = [], credits = [];
  let chatCalls = 0, charged = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/balance')) return res.end(JSON.stringify({ balanceUsd: balance }));
    if (req.url.includes('/history')) return res.end(JSON.stringify({ entries: [] }));
    if (req.url.includes('/models')) return res.end(JSON.stringify({ data: [{ id: 'test/model', supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000001' } }] }));
    const body = JSON.parse(raw || '{}');
    // the app's reserve/settle posts are ADVISORY on a proxy-metered cloud: record them, echo the true balance
    if (req.url.includes('/v1/debit')) { debits.push(body); return res.end(JSON.stringify({ ok: true, balanceUsd: balance })); }
    if (req.url.includes('/v1/credit')) { credits.push(body); return res.end(JSON.stringify({ ok: true, balanceUsd: balance })); }
    if (!req.url.includes('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
    // the relay's own floor: an empty wallet is a 402 (the real proxy's only per-call guard)
    if (balance <= 0) { res.statusCode = 402; return res.end(JSON.stringify({ error: { message: 'insufficient StarNet credits', type: 'billing', code: 'insufficient_credits' } })); }
    chatCalls += 1; balance = Math.round((balance - CALL_USD) * 1e6) / 1e6; charged += CALL_USD;
    // a model that never finishes: every turn writes one more distinct file (real progress, so no loop breaker)
    const call = { name: 'fs_write', args: { path: 'notes/n' + chatCalls + '.txt', content: 'note ' + chatCalls } };
    const delta = { tool_calls: [{ index: 0, id: 'c' + chatCalls, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 8, cost: CALL_USD } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'starnet-managed-cap-', timeoutMs: 30000, env: {
    STARNET_CLOUD_URL: base, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    SKYNET_BUDGET_PER_RUN: '', STARNET_BUDGET_PER_RUN: '', SKYNET_BUDGET_MANAGED_PER_RUN: '', STARNET_BUDGET_MANAGED_PER_RUN: '',
    STARNET_FULL_ACCESS: '1', SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0'
  } });
  // never let the sidecar resolve the real user profile (the fixture leaves USERPROFILE alone on Windows)
  fixture.env.USERPROFILE = fixture.profile; fixture.env.HOME = fixture.profile;
  const reset = (bal) => { balance = bal; debits.length = 0; credits.length = 0; chatCalls = 0; charged = 0; };
  const reserveOf = () => { const d = debits.find(x => x && x.meta && x.meta.kind === 'managed.reserve'); return d ? d.usd : null; };
  const run = async (label) => {
    const r = await fixture.json('POST', '/api/run', { provider: 'starnet', model: 'test/model', agentId: 'agent', messages: [{ role: 'user', content: 'dont do anything, just tell me why there were five dollar charges (' + label + ')' }] });
    const events = r.text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const end = events.filter(e => e.name === 'agent.run.end' && e.payload.agentId === 'agent').at(-1);
    assert.ok(end, label + ': the run ended with a terminal event\n' + r.text.slice(-2000));
    const p = end.payload;
    console.log('  ' + label + ': reserve=' + reserveOf() + ' completions=' + chatCalls + ' charged=' + charged.toFixed(2) +
      ' walletLeft=' + balance + ' end=' + p.reason + (p.budgetScope ? '/' + p.budgetScope + ' cap=' + p.budgetCapUsd : ''));
    return { end: p, events, text: r.text };
  };
  try {
    fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, '.secrets/credits.json'), JSON.stringify({ url: base, deviceToken: 'managed-fixture', accountId: 'fixture', linkedAt: Date.now() }));
    await fixture.start();
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', provider: 'starnet', model: 'test/model', approvalMode: 'full' }] });

    // ---- 1. $10 wallet, no per-run cap chosen: one prompt may spend ~$2, not the whole $10 ----
    reset(10);
    let r = await run('default');
    assert.equal(reserveOf(), 2, 'admission reserves the $2 managed default, not the whole $10 wallet (reserve=' + reserveOf() + ')');
    assert.equal(r.end.reason, 'budget', 'the run stops at the per-run ceiling with reason budget (got ' + r.end.reason + ')');
    assert.equal(r.end.budgetScope, 'run', 'the stop names the per-RUN cap');
    assert.equal(r.end.budgetCapUsd, 2, 'the stop carries the $2 cap it hit, so the chat line can say so');
    assert.equal(r.end.budgetCapIsBalance, undefined, 'a $2 ceiling under a $10 wallet is a cap, not the balance');
    assert.ok(charged <= 2 + CALL_USD + 1e-9, 'total charged stays within the cap plus one in-flight completion (charged $' + charged + ' over ' + chatCalls + ' calls)');
    assert.ok(balance >= 10 - 2 - CALL_USD - 1e-9, 'most of the wallet is left ($' + balance + ')');

    // ---- 4. the Budget panel can see the default that governs StarNet-credit runs ----
    const st0 = await fixture.json('GET', '/api/budget/status');
    assert.equal(st0.body && st0.body.caps && st0.body.caps.perRun, 0, 'the per-run cap itself still ships off (BYOK runs are unchanged)');
    assert.equal(st0.body && st0.body.managedRunDefaultUsd, 2, 'status names the $2 managed per-run default: ' + JSON.stringify(st0.body && st0.body.managedRunDefaultUsd));

    // ---- 2. a wallet smaller than the default still runs, capped at what is there ----
    reset(1.2);
    r = await run('small');
    assert.equal(reserveOf(), 1.2, 'a $1.20 wallet reserves $1.20 (clamped), it is not refused as out of credit');
    assert.equal(r.end.reason, 'budget', 'the small-wallet run ends at its ceiling, honestly (got ' + r.end.reason + ')');
    assert.ok(!/Out of managed credit/.test(r.text), 'a funded wallet is never told it is out of credit');
    // spend-truth B4: that ceiling WAS the wallet, so the stop says so (the COMMS line names the balance + top-up door)
    assert.equal(r.end.budgetScope, 'run'); assert.equal(r.end.budgetCapUsd, 1.2);
    assert.equal(r.end.budgetCapIsBalance, true, 'a ceiling clamped to the balance is marked as the balance on agent.run.end');

    // ---- 3. a SAVED per-run cap is authoritative: higher ($5) and lower ($1) both replace the default ----
    let save = await fixture.json('POST', '/api/budget/caps', { perRun: 5 });
    assert.equal(save.status, 200, 'saving a $5 per-run cap succeeds');
    reset(10);
    r = await run('saved-high');
    assert.equal(reserveOf(), 5, 'a saved $5 per-run cap reserves $5');
    assert.equal(r.end.reason, 'budget'); assert.equal(r.end.budgetCapUsd, 5, 'and stops at the user\'s $5, not the $2 default');
    assert.ok(chatCalls > Math.ceil(2 / CALL_USD), 'the higher saved cap really allowed more work than the default (' + chatCalls + ' calls)');
    assert.equal(r.end.budgetCapIsBalance, undefined, 'a chosen $5 cap under a $10 wallet is not the balance');
    // a saved cap ABOVE the wallet (customer report 2026-10-06: PER RUN $100 on $79) reserves the wallet and its stop
    // says it used the balance — "raise your $100 cap" would be advice that does nothing
    save = await fixture.json('POST', '/api/budget/caps', { perRun: 100 });
    assert.equal(save.status, 200, 'saving a $100 per-run cap succeeds');
    reset(4);
    r = await run('saved-above-wallet');
    assert.equal(reserveOf(), 4, 'a $100 cap on a $4 wallet reserves the $4 wallet');
    assert.equal(r.end.reason, 'budget'); assert.equal(r.end.budgetCapUsd, 4, 'and stops at the wallet');
    assert.equal(r.end.budgetCapIsBalance, true, 'and the stop is marked as the balance, not the $100 cap');
    save = await fixture.json('POST', '/api/budget/caps', { perRun: 1 });
    assert.equal(save.status, 200, 'saving a $1 per-run cap succeeds');
    reset(10);
    r = await run('saved-low');
    assert.equal(reserveOf(), 1, 'a saved $1 per-run cap reserves $1');
    assert.equal(r.end.budgetCapUsd, 1, 'and stops at $1');
    // 0 saved = "no cap": on StarNet credits the $2 default still stands between one prompt and the wallet
    save = await fixture.json('POST', '/api/budget/caps', { perRun: 0 });
    assert.equal(save.status, 200, 'saving 0 (no cap) succeeds');
    reset(10);
    r = await run('saved-zero');
    assert.equal(reserveOf(), 2, 'a saved 0 on a StarNet-credit run falls back to the $2 default, never the whole wallet');
    const st1 = await fixture.json('GET', '/api/budget/status');
    assert.equal(st1.body && st1.body.managedRunDefaultUsd, 2, 'status still reports the governing managed default with a saved 0');
    console.log('managed-run-cap: OK — $2 default reserve+stop, small wallet clamped, saved caps authoritative, status truthful');
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output tail ---\n' + String(fixture.output()).slice(-3000));
    process.exitCode = 1;
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
