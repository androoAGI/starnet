/* Webhook replay protection must survive a sidecar restart. The nonce cache used to be an
   in-memory Map only, while the ingress comment claimed exactly-once delivery — after a reboot
   the same signed request inside the skew window was accepted twice. The verifier now takes an
   injected durable store: nonces are appended (fail closed) before a delivery is admitted and
   reloaded at construction, so a NEW verifier over the SAME store refuses the replay. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeWebhookVerifier } = require('../sidecar/channels/webhook-auth.js');

const SECRET = 's'.repeat(32);
let now = 1700000000000;
const clock = () => now;

function signedRequest(auth, nonce, body) {
  const ts = String(now);
  return { timestamp: ts, nonce, signature: auth.sign(ts, nonce, body), body };
}

(function restartReplayIsRefused() {
  const rows = [];   // the shared durable inbox, as the composition root would wire it
  const store = { load: () => rows.slice(), append: r => rows.push(r) };
  const v1 = makeWebhookVerifier({ secret: SECRET, now: clock, store });
  const req = signedRequest(v1, 'nonce_1234567890abcdef', '{"chatId":"c","text":"hi"}');
  A.ok(v1.verify(req).ok, 'valid signed request is admitted and its nonce recorded');
  A.eq(rows.length, 1, 'the accepted nonce landed in the durable store');
  A.eq(rows[0].nonce, 'nonce_1234567890abcdef', 'the stored row carries the nonce');
  A.eq(v1.verify(req).code, 409, 'same-process replay is still refused');

  // simulated restart: a NEW verifier instance over the SAME store (empty RAM, same disk).
  const v2 = makeWebhookVerifier({ secret: SECRET, now: clock, store });
  A.eq(v2.verify(req).code, 409, 'replay of the same signed request is refused AFTER a restart');
  A.eq(rows.length, 1, 'a refused replay never appends a second row');
})();

(function expiredRowsArePrunedAtLoad() {
  const rows = [
    { nonce: 'nonce_expired0000000000', expiry: now - 1, at: now - 600000 },       // already expired
    { nonce: 'nonce_live000000000000', expiry: now + 60000, at: now - 1000 },      // still live
    { bogus: true },                                                                // junk row tolerated
    { nonce: 'nonce_nanexpiry0000000', expiry: 'not-a-number' }
  ];
  const store = { load: () => rows.slice(), append: () => {} };
  const v = makeWebhookVerifier({ secret: SECRET, now: clock, store });
  A.eq(Array.from(v._seen.keys()), ['nonce_live000000000000'], 'boot load keeps only unexpired well-formed nonces');

  let broken = true;
  const recovering = { load: () => { if (broken) throw new Error('disk gone'); return rows.slice(); }, append: () => {} };
  const guarded = makeWebhookVerifier({ secret: SECRET, now: clock, store: recovering });
  const guardedReq = signedRequest(guarded, 'nonce_loadguard0000000', '{"chatId":"c","text":"hi"}');
  A.eq(guarded.verify(guardedReq).code, 503, 'an unreadable durable inbox fails admission closed instead of pretending it is empty');
  broken = false;
  A.ok(guarded.verify(guardedReq).ok, 'admission recovers after the durable inbox can be loaded safely');
})();

(function futureTimestampReplayStaysBlockedForItsWholeValidityWindow() {
  const rows = [];
  const store = { load: () => rows.slice(), append: row => rows.push(row) };
  const start = now;
  const v = makeWebhookVerifier({ secret: SECRET, now: clock, store, maxSkewMs: 300000 });
  const timestamp = String(start + 300000);
  const nonce = 'nonce_futureclock00000';
  const body = '{"chatId":"c","text":"hi"}';
  const req = { timestamp, nonce, body, signature: v.sign(timestamp, nonce, body) };
  A.ok(v.verify(req).ok, 'a request at the positive skew boundary is initially admitted');
  now = start + 300001;
  A.eq(v.verify(req).code, 409, 'the nonce remains blocked until the request timestamp itself leaves the validity window');
  now = start;
})();

(function capacityFailsClosedWithoutEvictingLiveReplayReceipts() {
  const rows = [];
  const store = { load: () => rows.slice(), append: row => rows.push(row) };
  const v = makeWebhookVerifier({ secret: SECRET, now: clock, store, maxNonces: 100 });
  let first = null;
  for (let i = 0; i < 100; i++) {
    const nonce = 'nonce_capacity_' + String(i).padStart(4, '0');
    const req = signedRequest(v, nonce, '{}');
    if (!first) first = req;
    A.ok(v.verify(req).ok, 'live replay receipt ' + i + ' is admitted within capacity');
  }
  const overflow = signedRequest(v, 'nonce_capacity_overflow', '{}');
  A.eq(v.verify(overflow).code, 503, 'a full live nonce set refuses new admission instead of evicting replay protection');
  A.eq(v.verify(first).code, 409, 'the oldest still-live receipt remains replay-protected at capacity');
})();

(function appendFailureFailsClosed() {
  let disk = 'down';
  const rows = [];
  const store = { load: () => rows.slice(), append: r => { if (disk === 'down') throw new Error('EIO'); rows.push(r); } };
  const v = makeWebhookVerifier({ secret: SECRET, now: clock, store });
  const req = signedRequest(v, 'nonce_failclosed000000', '{"chatId":"c","text":"hi"}');
  const verdict = v.verify(req);
  A.eq(verdict.code, 503, 'a nonce that cannot be recorded refuses the delivery (503, never accept-without-record)');
  A.eq(rows.length, 0, 'nothing was persisted for the refused delivery');
  A.eq(v._seen.size, 0, 'the refused nonce is NOT cached — the sender may retry the same request');
  disk = 'up';
  A.ok(v.verify(req).ok, 'the retry of the SAME signed request succeeds once the store recovers');
  A.eq(rows.length, 1, 'the retry recorded its nonce');
})();

(function malformedStoreDepIsRefused() {
  A.throws(() => makeWebhookVerifier({ secret: SECRET, now: clock, store: { load: () => [] } }), 'a store without append() is refused at construction');
})();

(function jsonlRoundTripAcrossRestart() {
  // The composition-root shape: append+fsync JSONL on real disk, reloaded by a fresh verifier.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-webhook-nonces-'));
  const file = path.join(dir, 'webhook-nonces.jsonl');
  const io = {
    load() {
      try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }
      catch (_) { return []; }
    },
    append(entry) {
      let fd = null;
      try { fd = fs.openSync(file, 'a'); fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); }
      finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
    }
  };
  try {
    const v1 = makeWebhookVerifier({ secret: SECRET, now: clock, store: io });
    const req = signedRequest(v1, 'nonce_diskdiskdisk0000', '{"chatId":"c","text":"hi"}');
    A.ok(v1.verify(req).ok, 'disk-backed verifier admits the first delivery');
    const v2 = makeWebhookVerifier({ secret: SECRET, now: clock, store: io });
    A.eq(v2.verify(req).code, 409, 'the JSONL round-trips a restart: the replay is refused from disk state');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
})();

(function compositionRootIsWired() {
  const index = readSidecarSource();
  A.ok(/store:\s*webhookNonceIo/.test(index), 'index.js composes the verifier over the durable nonce inbox');
  A.ok(/webhook-nonces\.jsonl/.test(index), 'the nonce inbox lives beside the other WORKSPACES ledgers');
  const ingressComment = index.slice(index.indexOf('Authenticated relay ingress'), index.indexOf('async function handleChannelWebhook') + 200);
  A.ok(!/exactly-once/i.test(ingressComment), 'the ingress contract does not overclaim transactional exactly-once delivery');
})();

A.report('channels.webhook-durability.test');
