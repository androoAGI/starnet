'use strict';
// E29 review (2026-10-08): a credits read that arrived while a link self-heal was already running did not wait for
// it — healRetryDue() is false while a heal is in flight, so the read answered "not linked" at once (GET
// /api/credits 404 → the STORE drew LINK STATION, WAKE said "link your StarNet account first") over a station the
// heal was seconds from linking. SETTINGS sends the provider-card read and the STORE read back to back, so the
// second one always met the first one's heal. Every read now joins the running heal (whoami AND its rebuild's
// balance read) and answers from its result.
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

// whoami: 'down' answers 502 (a transient refusal that arms the retry); 'hold' parks until release().
async function cloudFixture(firstMode) {
  const state = { mode: firstMode, whoamiCalls: 0, balanceCalls: 0 };
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const server = http.createServer(async (req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/whoami') {
      state.whoamiCalls++;
      if (state.mode === 'down') return json(502, { error: 'bad gateway' });
      entered(); await held;
      return json(200, { ok: true, accountId: 'acct-joined' });
    }
    if (req.url.startsWith('/v1/balance')) { state.balanceCalls++; return json(200, { balanceUsd: 22 }); }
    if (req.url.startsWith('/v1/history')) return json(200, { entries: [] });
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, waiting, release, url: 'http://127.0.0.1:' + server.address().port,
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

function makeFixture(cloud, prefix) {
  const fixture = SidecarFixture.create({ prefix, timeoutMs: 15000, env: {
    STARNET_CLOUD_URL: cloud.url, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    STARNET_CREDITS_TOKEN: 'fixture-keychain-token', STARNET_CREDITS_HEAL_RETRY_MS: '200',
    SKYNET_PROVIDER: 'replay', STARNET_PROVIDER: 'replay'
  } });
  fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
  return fixture;
}

// An open read the test may abandon (a failed assertion disposes the sidecar under it): never an unhandled rejection
// that hides the assertion's own message.
function open(promise) { promise.catch(() => {}); return promise; }
// Settled-or-not after `ms`: a read that skipped the heal answers in milliseconds; one that joined it is still open.
function settledWithin(promise, ms) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return new Promise(resolve => setTimeout(() => resolve(done), ms));
}

test('a credits read during the BOOT self-heal waits for it and answers linked, never a 404', { timeout: 30000 }, async () => {
  const cloud = await cloudFixture('hold');
  const fixture = makeFixture(cloud, 'credits-heal-join-boot-');
  try {
    await fixture.start();
    await cloud.waiting;   // the boot heal is parked on /v1/whoami
    const read = open(fixture.json('GET', '/api/credits?history=0'));
    const linkable = open(fixture.json('GET', '/api/credits/linkable'));
    assert.equal(await settledWithin(read, 600), false, 'the status read waits for the running heal instead of answering "not linked"');
    assert.equal(await settledWithin(linkable, 1), false, 'so does the LINK card check');
    cloud.release();
    const r = await read;
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.configured, true, 'the read reports the link the heal just restored');
    assert.equal(r.body.balanceUsd, 22, 'with the real balance');
    const l = await linkable;
    assert.equal(l.body.available, false, 'no LINK STATION card over a linked station');
    assert.equal(cloud.state.whoamiCalls, 1, 'joining readers never start a second whoami');
    assert.equal(cloud.state.balanceCalls, 1, "joining readers reuse the heal's own balance read");
  } finally {
    cloud.release();
    await fixture.dispose(); await cloud.close();
  }
});

test('two back-to-back reads during a RETRY heal both answer linked (SETTINGS provider card + STORE)', { timeout: 30000 }, async () => {
  const cloud = await cloudFixture('down');
  const fixture = makeFixture(cloud, 'credits-heal-join-retry-');
  try {
    await fixture.start();
    const until = Date.now() + 5000;
    while (!/credits link self-heal declined: whoami http 502/.test(fixture.output()) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    assert.match(fixture.output(), /self-heal declined: whoami http 502 \(will retry/, 'the boot heal met the outage and armed a retry');
    cloud.state.mode = 'hold';
    await new Promise(r => setTimeout(r, 250));   // past STARNET_CREDITS_HEAL_RETRY_MS
    cloud.state.balanceCalls = 0;
    const first = open(fixture.json('GET', '/api/credits?history=0'));   // takes the armed retry
    await cloud.waiting;
    const second = open(fixture.json('GET', '/api/credits'));            // the STORE's full read, a beat later
    assert.equal(await settledWithin(second, 600), false, 'the second read waits for the first read\'s heal');
    cloud.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200, a.text);
    assert.equal(a.body.configured, true);
    assert.equal(b.status, 200, b.text);
    assert.equal(b.body.configured, true, 'the second read reports the same restored link, not a 404');
    assert.equal(b.body.balanceUsd, 22);
    assert.equal(cloud.state.whoamiCalls, 2, 'one boot heal + one retry: the second reader joined, it did not heal again');
    assert.equal(cloud.state.balanceCalls, 1, "both readers answer from the heal's balance read");
  } finally {
    cloud.release();
    await fixture.dispose(); await cloud.close();
  }
});
