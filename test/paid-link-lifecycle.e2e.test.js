'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

async function cloudFixture() {
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/link/start') return json({ code: 'STAR-RACE', pollSecret: 'fixture-poll-secret', verifyUrl: 'https://example.invalid/link', expiresAt: Date.now() + 60000 });
    if (req.url === '/v1/link/poll' || req.url === '/v1/whoami') {
      entered(); await held;
      return json({ status: 'confirmed', accountId: 'fixture-account', deviceToken: 'fixture-device-token' });
    }
    if (req.url.startsWith('/v1/balance')) return json({ balanceUsd: 22 });
    if (req.url.startsWith('/v1/history')) return json({ entries: [] });
    if (req.url === '/v1/link/revoke') return json({ ok: true });
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, waiting, release,
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

for (const mode of ['pairing', 'keychain-recovery']) {
  test('unlink wins over an unfinished ' + mode + ' response and survives restart', { timeout: 30000 }, async () => {
    const cloud = await cloudFixture();
    const fixture = SidecarFixture.create({ prefix: 'paid-link-race-', timeoutMs: 15000, env: {
      STARNET_CLOUD_URL: cloud.url, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
      STARNET_CREDITS_TOKEN: mode === 'keychain-recovery' ? 'fixture-device-token' : '',
      SKYNET_PROVIDER: 'replay', STARNET_PROVIDER: 'replay'
    } });
    fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
    let poll;
    try {
      await fixture.start();
      if (mode === 'pairing') {
        assert.equal((await fixture.json('POST', '/api/credits/link/start', {})).status, 200);
        poll = fixture.json('POST', '/api/credits/link/poll', { code: 'STAR-RACE' });
      }
      await cloud.waiting;
      const unlink = await fixture.json('POST', '/api/credits/unlink', {});
      assert.equal(unlink.body.ok, true, unlink.text);
      cloud.release();
      if (poll) assert.equal((await poll).body.linked, false, 'late pairing must not undo unlink');
      // Drain the delayed boot heal by observing its completion in the real host log.
      if (mode === 'keychain-recovery') {
        const until = Date.now() + 3000;
        while (!/credits link self-heal/.test(fixture.output()) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
      }
      const current = await fixture.json('GET', '/api/credits?history=0');
      assert.equal(current.body.configured, false, 'the running station stays unlinked');
      await fixture.stop(); await fixture.start();
      assert.equal((await fixture.json('GET', '/api/credits?history=0')).body.configured, false, 'restart respects unlink');
    } finally {
      cloud.release();
      if (poll) await poll.catch(() => {});
      await fixture.dispose(); await cloud.close();
    }
  });
}

test('an old account response cannot return its zero balance after unlink', { timeout: 30000 }, async () => {
  let releaseHistory, enteredHistory;
  const waiting = new Promise(resolve => { enteredHistory = resolve; });
  const held = new Promise(resolve => { releaseHistory = resolve; });
  const server = http.createServer(async (req, res) => {
    let body = { ok: true };
    if (req.url.startsWith('/v1/balance')) body = { balanceUsd: 0 };
    if (req.url.startsWith('/v1/history')) { enteredHistory(); await held; body = { entries: [] }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'paid-balance-switch-', env: {
    STARNET_CLOUD_URL: url, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: ''
  } });
  fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(fixture.workspace, '.secrets', 'credits.json'), JSON.stringify({ url, deviceToken: 'fixture-old-token', accountId: 'old-account' }));
  let old;
  try {
    await fixture.start();
    old = fixture.json('GET', '/api/credits');
    await waiting;
    assert.equal((await fixture.json('POST', '/api/credits/unlink', {})).body.ok, true);
    releaseHistory();
    const result = await old;
    assert.notEqual(result.body.balanceUsd, 0, 'old account cannot paint a zero after account change');
    assert.notEqual(result.body.accountId, 'old-account', 'old identity cannot be mixed into new account state');
  } finally {
    releaseHistory(); if (old) await old.catch(() => {});
    await fixture.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('funded link diagnostics survive restart without exposing account or token', { timeout: 30000 }, async () => {
  const cloud = await cloudFixture(); cloud.release();
  const fixture = SidecarFixture.create({ prefix: 'paid-link-receipt-', env: {
    STARNET_CLOUD_URL: cloud.url, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: ''
  } });
  try {
    await fixture.start();
    await fixture.json('POST', '/api/credits/link/start', {});
    assert.equal((await fixture.json('POST', '/api/credits/link/poll', { code: 'STAR-RACE' })).body.linked, true);
    let fingerprint;
    for (let boot = 0; boot < 2; boot++) {
      const status = await fixture.json('GET', '/api/credits?history=0');
      assert.equal(status.body.balanceUsd, 22);
      assert.equal(status.body.balanceStatus, 'funded');
      const receipt = (await fixture.json('GET', '/api/diagnostics')).body;
      assert.equal(receipt.report.paidAccount.balance, 'funded');
      assert.equal(receipt.report.paidAccount.link, 'saved');
      assert.equal(receipt.report.paidAccount.credential, 'file');
      assert.match(receipt.report.paidAccount.fingerprint, /^[a-f0-9]{16}$/);
      assert.ok(!JSON.stringify(receipt).includes('fixture-account'));
      assert.ok(!JSON.stringify(receipt).includes('fixture-device-token'));
      if (boot === 0) {
        fingerprint = receipt.report.paidAccount.fingerprint;
        assert.equal(receipt.report.paidAccount.transition.state, 'pairing_saved');
        await fixture.stop(); await fixture.start();
      } else assert.equal(receipt.report.paidAccount.fingerprint, fingerprint);
    }
  } finally { await fixture.dispose(); await cloud.close(); }
});

test('a late first-link balance check cannot clear a newer funded link', { timeout: 30000 }, async () => {
  let next = 0, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    let body = { ok: true };
    if (req.url === '/v1/link/start') { next++; body = { code: 'STAR-' + next, pollSecret: 'fixture-secret', verifyUrl: 'https://example.invalid/' }; }
    if (req.url === '/v1/link/poll') body = { status: 'confirmed', accountId: 'account-' + next, deviceToken: 'device-' + next };
    if (req.url.startsWith('/v1/balance')) {
      if (req.url.includes('account-1')) { entered(); await held; }
      body = { balanceUsd: req.url.includes('account-1') ? 0 : 22 };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixture = SidecarFixture.create({ prefix: 'paid-link-replaced-', env: {
    STARNET_CLOUD_URL: 'http://127.0.0.1:' + server.address().port,
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: ''
  } });
  let first;
  try {
    await fixture.start();
    await fixture.json('POST', '/api/credits/link/start', {});
    first = fixture.json('POST', '/api/credits/link/poll', { code: 'STAR-1' });
    await waiting;
    await fixture.json('POST', '/api/credits/unlink', {});
    await fixture.json('POST', '/api/credits/link/start', {});
    assert.equal((await fixture.json('POST', '/api/credits/link/poll', { code: 'STAR-2' })).body.linked, true);
    release();
    assert.equal((await first).body.status, 'superseded');
    const status = await fixture.json('GET', '/api/credits?history=0');
    assert.equal(status.body.accountId, 'account-2');
    assert.equal(status.body.balanceUsd, 22);
    await fixture.stop(); await fixture.start();
    assert.equal((await fixture.json('GET', '/api/credits?history=0')).body.accountId, 'account-2');
  } finally {
    release(); if (first) await first.catch(() => {});
    await fixture.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('managed HTTP 400 keeps local, relay and upstream correlation through restart', { timeout: 30000 }, async () => {
  const model = 'anthropic/claude-sonnet-5';
  const server = http.createServer((req, res) => {
    if (req.url.includes('/chat/completions')) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-StarNet-Request-Id': 'relay-fixture-123' });
      res.end(JSON.stringify({ error: { message: 'Provider returned error. '.repeat(35),
        request_id: 'relay-fixture-123', upstream_request_id: 'upstream-fixture-456',
        metadata: { raw: 'PRIVATE PROMPT MUST NOT LEAK' } } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ balanceUsd: 22, entries: [], data: [{ id: model, context_length: 8000 }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'paid-error-receipt-', env: {
    STARNET_CLOUD_URL: url, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: ''
  } });
  fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(fixture.workspace, '.secrets', 'credits.json'), JSON.stringify({ url, deviceToken: 'fixture-managed-token', accountId: 'fixture-managed-account' }));
  try {
    await fixture.start();
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'paid-proof', name: 'Proof', model, provider: 'starnet' }] });
    const run = await fixture.json('POST', '/api/run', { agentId: 'paid-proof', provider: 'starnet', model,
      internal: true, isTask: false, messages: [{ role: 'user', content: 'Fixture request' }] });
    assert.equal(run.status, 200, run.text);
    const events = run.text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const failure = events.find(e => e.name === 'agent.run.error');
    assert.ok(failure, run.text);
    assert.match(failure.payload.message, /relay-fixture-123/);
    for (let boot = 0; boot < 2; boot++) {
      const receipt = (await fixture.json('GET', '/api/diagnostics')).body;
      const error = receipt.report.errors.find(e => e.runId === failure.payload.runId);
      assert.ok(error, 'error remains associated with the failing local run');
      assert.match(error.message, /relay-fixture-123/);
      assert.match(error.message, /upstream-fixture-456/);
      assert.ok(!JSON.stringify(receipt).includes('PRIVATE PROMPT'));
      assert.ok(!JSON.stringify(receipt).includes('fixture-managed-token'));
      if (boot === 0) { await fixture.stop(); await fixture.start(); }
    }
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

// Issue #76 (2026-10-06): the boot self-heal met a degraded account service (502/timeouts) and gave up for the whole
// session — a keychain-authorized station stayed "not linked" on the RESUME screen until the app was restarted, even
// after the cloud recovered. The credits status read now takes a spaced retry of a TRANSIENT heal failure.
test('a boot self-heal that met a down cloud retries on the next credits read once the cloud is back', { timeout: 30000 }, async () => {
  let healthy = false, whoamiCalls = 0;
  const server = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/whoami') { whoamiCalls++; return healthy ? json(200, { ok: true, accountId: 'acct-recovered' }) : json(502, { error: 'bad gateway' }); }
    if (req.url.startsWith('/v1/balance')) return json(200, { balanceUsd: 12.5 });
    if (req.url.startsWith('/v1/history')) return json(200, { entries: [] });
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'paid-heal-retry-', timeoutMs: 15000, env: {
    STARNET_CLOUD_URL: url, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    STARNET_CREDITS_TOKEN: 'fixture-keychain-token', STARNET_CREDITS_HEAL_RETRY_MS: '200'
  } });
  fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
  try {
    await fixture.start();
    const until = Date.now() + 5000;
    while (!/credits link self-heal declined: whoami http 502/.test(fixture.output()) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    assert.match(fixture.output(), /self-heal declined: whoami http 502 \(will retry/, 'the boot heal met the outage and armed a retry');
    const during = await fixture.json('GET', '/api/credits?history=0');
    assert.equal(during.status, 404, 'still unlinked while the cloud is down');
    healthy = true;
    await new Promise(r => setTimeout(r, 250));
    const after = await fixture.json('GET', '/api/credits?history=0');
    assert.equal(after.status, 200, after.text);
    assert.equal(after.body.configured, true, 'the station relinked itself without a restart');
    assert.equal(after.body.balanceUsd, 12.5, 'and reads the real balance');
    const calls = whoamiCalls;
    await fixture.json('GET', '/api/credits?history=0');
    assert.equal(whoamiCalls, calls, 'a healed station never asks whoami again');
  } finally {
    await fixture.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
