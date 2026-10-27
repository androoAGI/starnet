'use strict';
const { readSidecarSource } = require('./helpers/source');
// autonotify.test.js — autonomy B4: the cron→channel notifier. Pings the agent's opted-in chats ONLY on a clean
// work-producing run (cron.result outcome 'ok'); routes by channel; never lists per-file deliverables (unsound to
// correlate without a runId on that event — see autonotify.js header). Plus wiring source-locks.
const assert = require('assert');
const { makeAutoNotifier, composeMessage } = require('../sidecar/autonotify.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const cronStore = require('../sidecar/cron-store.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// --- composeMessage ---
eq(composeMessage('Weekly digest'), '✦ "Weekly digest" ran on its own.', 'names the routine');
eq(composeMessage(''), '✦ "a routine" ran on its own.', 'empty name falls back');
eq(composeMessage(null), '✦ "a routine" ran on its own.', 'null name falls back');

// harness: jobId→{agent,name}; per-agent chats (as {chatId,channel}); records every send (chatId,text,channel).
function harness(jobs, chatsByAgent) {
  const sent = [];
  const nf = makeAutoNotifier({
    send: (chatId, text, channel) => { sent.push({ chatId, text, channel }); return Promise.resolve(); },
    chatsFor: (aid) => (chatsByAgent[aid] || []),
    jobName: (jid) => (jobs[jid] || {}).name || 'a routine',
    jobAgent: (jid) => (jobs[jid] || {}).agent || null
  });
  return { nf, sent };
}
const JOBS = { j1: { agent: 'agent', name: 'Weekly digest' }, j2: { agent: 'other', name: 'Other job' } };

// --- ok → pings the agent's opted-in chat, routed by channel ---
{
  const h = harness(JOBS, { agent: [{ chatId: '111', channel: 'telegram' }] });
  h.nf.onEvent('cron.result', { jobId: 'j1', runId: 'r1', outcome: 'ok' });
  eq(h.sent.length, 1, 'one ping on a clean ok run');
  eq([h.sent[0].chatId, h.sent[0].channel], ['111', 'telegram'], 'sent to the right chat + channel');
  ok(/Weekly digest/.test(h.sent[0].text), 'message names the routine');
}

// --- anti-spam: silent + failed never ping ---
{
  const h = harness(JOBS, { agent: [{ chatId: '111', channel: 'telegram' }] });
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'silent' });
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'failed' });
  h.nf.onEvent('cron.fire', { jobId: 'j1' });           // non-result events are ignored entirely
  h.nf.onEvent('deliverable', { agentId: 'agent', title: 'x.md' });
  eq(h.sent.length, 0, "only outcome 'ok' pings — silent/failed/other events never do");
}

// --- opt-in: no chats → no ping ---
{
  const h = harness(JOBS, {});
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
  eq(h.sent.length, 0, 'no opted-in chat → no ping');
}

// --- unknown job (no agent) → safe no-op ---
{
  const h = harness({}, { agent: [{ chatId: '111' }] });
  h.nf.onEvent('cron.result', { jobId: 'nope', outcome: 'ok' });
  eq(h.sent.length, 0, 'an unknown job is a safe no-op');
}

// --- cross-agent isolation: a result for agent X only pings X's chats (never another agent's) ---
{
  const h = harness(JOBS, { agent: [{ chatId: 'A1', channel: 'telegram' }], other: [{ chatId: 'B1', channel: 'discord' }] });
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });   // j1 belongs to 'agent'
  eq(h.sent.map(s => s.chatId), ['A1'], "only the run's own agent chats are pinged (no cross-agent leak)");
}

// --- fan-out: every opted-in chat for the agent gets it ---
{
  const h = harness(JOBS, { agent: [{ chatId: '111', channel: 'telegram' }, { chatId: '222', channel: 'discord' }] });
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
  eq(h.sent.map(s => [s.chatId, s.channel]).sort(), [['111', 'telegram'], ['222', 'discord']], 'pings every opted-in chat, each on its own channel');
}

// --- DELIVERY OUTCOME (2026-07-15 audit): every send attempt reports through onDelivery ---
// (async settle: the assertions run on a queued microtask-flush before the final report below.)
const deliveryOutcomes = [];
{
  let mode = 'ok';
  const nf = makeAutoNotifier({
    send: () => (mode === 'ok' ? Promise.resolve() : Promise.reject(new Error('rate limited'))),
    chatsFor: () => [{ chatId: '111', channel: 'telegram' }],
    jobName: () => 'x', jobAgent: () => 'agent',
    onDelivery: (jobId, r) => deliveryOutcomes.push({ jobId, r })
  });
  nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
  mode = 'fail';
  nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
}
// --- DELIVERY RETRY SEAM: real adapter resend -> one final, durable cron outcome ---
// Compose the production modules so their hand-off is locked, not merely each module in isolation.
const retrySeam = { attempts: 0, waits: [], outcomes: [] };
{
  const T = Date.UTC(2026, 6, 18, 12, 0, 0);
  let jobs = [cronStore.makeJob({
    id: 'retry-seam', name: 'Retry seam', agentId: 'agent',
    schedule: { kind: 'once', at: new Date(T + 60000).toISOString() }
  }, { now: T })];
  const adapter = makeChannelAdapter({
    name: 'telegram', clock: { now: () => T }, normalize: () => null,
    sleep: (ms) => { retrySeam.waits.push(ms); return Promise.resolve(); },
    transport: {
      getUpdates: async () => [],
      send: async () => (++retrySeam.attempts === 1
        ? { ok: false, error: 'rate limited', retryable: true, retryAfter: 2 }
        : { ok: true, messageId: 'delivered-after-retry' })
    }
  });
  const nf = makeAutoNotifier({
    send: (chatId, text, channel) => adapter.send(chatId, text, { channel }),
    chatsFor: () => [{ chatId: '111', channel: 'telegram' }],
    jobName: () => 'Retry seam', jobAgent: () => 'agent',
    onDelivery: (jobId, result) => {
      retrySeam.outcomes.push(result);
      jobs = cronStore.markDelivery(jobs, jobId, result, { now: T + 2000 });
      retrySeam.job = cronStore.getJob(jobs, jobId);
    }
  });
  nf.onEvent('cron.result', { jobId: 'retry-seam', runId: 'run-1', outcome: 'ok' });
}

// --- a SYNCHRONOUSLY-throwing send also reports a failed delivery (and a hostile onDelivery never escapes) ---
{
  const outcomes = [];
  const nf = makeAutoNotifier({
    send: () => { throw new Error('boom'); },
    chatsFor: () => [{ chatId: '1', channel: 'discord' }],
    jobName: () => 'x', jobAgent: () => 'agent',
    onDelivery: (jobId, r) => { outcomes.push(r); throw new Error('hostile'); }
  });
  nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });   // must not throw
  eq([outcomes.length, outcomes[0].ok], [1, false], 'a throwing send reports ok:false; a throwing onDelivery is contained');
}

// --- never throws even if send is hostile ---
{
  const nf = makeAutoNotifier({ send: () => { throw new Error('boom'); }, chatsFor: () => [{ chatId: '1' }], jobName: () => 'x', jobAgent: () => 'agent' });
  nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });   // must not throw
  ok(true, 'a throwing send never escapes onEvent (cron pipeline stays safe)');
}

// --- source-locks for the (non-node-loadable) wiring ---
const fs = require('fs'); const path = require('path');
const idx = readSidecarSource();
// The notifier's wiring is one block, `const autoNotifier = makeAutoNotifier({ ... });`. Its locks read that block
// wherever it lives: makeAutoNotifier is DEFINED in autonotify.js, and `r.ok === false` / `redact(text)` appear in a
// dozen other modules, so a whole-sidecar match would stay green with the wiring gone.
const notifierAt = idx.indexOf('= makeAutoNotifier({');
const notifier = notifierAt < 0 ? '' : idx.slice(notifierAt, idx.indexOf('\n});', notifierAt) + 4);
ok(notifier.length > 200 && notifier.length < 20000, 'the notifier wiring block is found (' + notifier.length + ' chars)');
ok(/require\('\.\/autonotify\.js'\)/.test(idx), 'index.js requires the autonotify engine');
ok(/makeAutoNotifier\(/.test(notifier), 'index.js instantiates the notifier');
ok(/emit:\s*cronEmitNotify/.test(idx), 'the cron driver emit is wrapped (cronEmitNotify) to feed the notifier');
ok(/exact: '\/api\/channels\/notify', h: handleChannelNotify \}/.test(idx) && /function handleChannelNotify/.test(idx), '/api/channels/notify route + handler wired');
ok(/notifyAutonomous/.test(notifier), 'index.js persists/reads the global opt-in flag');
ok(/redact\(text\)/.test(notifier), 'the outbound notification text is redacted before send (no secret egress)');
const hub = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'channels', 'hub.js'), 'utf8');
ok(/saveChatRecord\(/.test(hub), 'the inbound hub persists the chat→agent binding (so the notifier can find chats)');
const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'messaging.js'), 'utf8');   // CHANNELS window extracted from stationui.js (BUILDERS split)
ok(/id="ch-notify"/.test(ui) && /\/api\/channels\/notify/.test(ui), 'the Messaging panel has the (now ONE shared) opt-in toggle + posts it');

ok(/onDelivery:/.test(notifier), 'index.js wires the per-send delivery-outcome recorder (onDelivery)');
ok(/markDelivery\(/.test(notifier), 'index.js persists delivery outcomes via the cron-store markDelivery reducer');
ok(/r\.ok === false/.test(notifier), 'index.js normalizes a resolved {ok:false} SendResult into a real failure');

// the async delivery-outcome assertions settle after the send promises flush.
setImmediate(() => {
  eq(deliveryOutcomes.length, 2, 'every send attempt reported an outcome');
  eq([deliveryOutcomes[0].r.ok, deliveryOutcomes[0].r.channel], [true, 'telegram'], 'a delivered ping reports ok:true');
  eq(deliveryOutcomes[1].r.ok, false, 'a rejected send reports ok:false — never swallowed');
  ok(/rate limited/.test(deliveryOutcomes[1].r.error), 'the failure carries the transport error');
  eq(retrySeam.attempts, 2, 'retryable autonomous delivery gets one bounded resend');
  eq(retrySeam.waits, [2000], 'autonomous resend honors the transport retry_after window');
  eq(retrySeam.outcomes.length, 1, 'cron bookkeeping receives one final outcome, not an intermediate failure');
  eq([retrySeam.outcomes[0].ok, retrySeam.outcomes[0].channel], [true, 'telegram'], 'final retry success keeps its channel identity');
  eq([retrySeam.job.lastDeliveryOk, retrySeam.job.lastDeliveryError], [true, null], 'successful retry is durably reducible on the routine record');
  console.log('autonotify.test.js OK —', n, 'assertions');
});
