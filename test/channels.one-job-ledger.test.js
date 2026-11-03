/* node test/channels.one-job-ledger.test.js — a one-job hub's replies never reach the shared delivery ledger (a guard).

   A line trigger, a SEND TO hand-off and a sample job (RUN ONE REAL JOB) each run one standalone job through a hub whose
   send captures the reply into THAT job's record, in this process: the job record is their durability. Their chat ids
   are fixed ('trg-<id>', 'hof-<line>', 'sample'), so on the shared ledger (channels/delivery.json) a reply of theirs
   that a dying process left queued would be drained, by the next process, into ANOTHER job's capture. perFireStore
   (channels/fire-store.js) therefore answers store.ledger with an in-memory ledger of its own.

   A guard, not a red invariant: trunk leaves these hubs no durable footprint at all, so it is green there by
   construction. Real store, real hub, real perFireStore, as index.js builds the trigger and sample hubs. Proves:
     A. index.js builds the sample hub and makeTriggerHub (line triggers and SEND TO hand-offs) over perFireStore
     B. a fire that dies after its answer (the send never returns) leaves nothing in delivery.json, and neither does
        one whose send failed; the next process's fire captures only its own reply
     C. the sample hub (one hub, many jobs): the next job's capture holds only its own reply */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path').posix;
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { perFireStore } = require('../sidecar/channels/fire-store.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');

const ROOT = '/ws/channels';
function memDisk() {
  const files = new Map();
  return {
    files,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {}
  };
}
const settle = async (n) => { for (let i = 0; i < (n || 40); i++) await new Promise(r => setImmediate(r)); };
const ledgerOnDisk = (disk) => { const raw = disk.files.get(ROOT + '/delivery.json'); return raw ? JSON.parse(raw) : null; };
const owed = (disk) => { const d = ledgerOnDisk(disk); return d ? d.deliveries.map(x => x.chat) : []; };
const timers = { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} };   // no retry ever fires here
const store = (disk) => makeChannelStore({ fs: disk, pathMod, root: ROOT, clock: { now: () => 1 }, timers });

// a hub built like index.js makeTriggerHub: the channel store wrapped per fire, the reply captured into the fire's job
function oneJobHub(channel, base, fire, send) {
  let n = 0;
  return makeChannelHub({
    channel: channel, agentPrefix: channel === 'sample' ? 'smp_' : 'trg_', textBatchWaitMs: 0, bindChats: false, ownerSurface: channel === 'sample',
    untrustedSenders: channel === 'sample' ? undefined : false,
    store: perFireStore(base, (agentId) => (fire.turns[agentId] || (fire.turns[agentId] = []))),
    runOnce: async (o) => { const w = String(o.messages[o.messages.length - 1].content); o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'answer to ' + w }); o.emit('agent.run.end', { reason: 'done' }); },
    send: send, secrets: () => ({ key: 'k', model: 'm', configured: true }), classify: () => true,
    newId: () => channel + '-run-' + (++n), sleep: () => Promise.resolve(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
  });
}

(async () => {
  // ---- A. index.js builds the one-job hubs over perFireStore ----
  {
    const sample = sidecarTopLevelFunction('getSampleHub');
    const trigger = sidecarTopLevelFunction('makeTriggerHub');
    A.ok(/store: perFireStore\(channelStore, /.test(sample), 'the sample hub\'s store is perFireStore(channelStore, …)');
    A.ok(/store: perFireStore\(channelStore, hooks\.turns\)/.test(trigger), 'makeTriggerHub (line triggers and SEND TO hand-offs) builds over perFireStore(channelStore, …)');
  }

  // ---- B. a trigger fire that dies after its answer leaves nothing durable; the next fire captures only its own ----
  {
    const disk = memDisk();
    const capture1 = [];
    const fire1 = { turns: {} };
    const hub1 = oneJobHub('trigger', store(disk), fire1, () => new Promise(() => {}));   // the process dies with the send in flight
    hub1.onInbound({ chatId: 'trg-7', userId: 'trigger', text: 'job one', chatType: 'dm' });
    await settle();
    A.eq(capture1, [], 'fixture: fire one\'s answer never reached its capture (the process died)');
    A.eq(owed(disk).filter(c => /trg-7/.test(c)), [], 'fire one\'s answer is in no durable ledger (delivery.json)');
    // the same fire with a send that FAILS keeps its retry in memory too, never on disk
    const hubF = oneJobHub('trigger', store(disk), { turns: {} }, () => Promise.resolve({ ok: false, error: 'down', retryable: true }));
    await hubF.onInbound({ chatId: 'trg-7', userId: 'trigger', text: 'job one, again', chatType: 'dm' });
    A.eq(owed(disk), [], 'a failed one-job reply is kept by its own job, never in delivery.json');
    hubF.close();
    // the next process: a fresh store over the same disk, the trigger's next fire
    const capture2 = [];
    const hub2 = oneJobHub('trigger', store(disk), { turns: {} }, (chatId, text) => { capture2.push(text); return Promise.resolve({ ok: true }); });
    hub2.onStatus({ state: 'up' });
    await hub2.onInbound({ chatId: 'trg-7', userId: 'trigger', text: 'job two', chatType: 'dm' });
    await settle();
    A.eq(capture2, ['answer to job two'], 'the next fire\'s capture holds only its own reply');
    hub2.close();
  }

  // ---- C. the sample hub: one hub, many jobs ----
  {
    const disk = memDisk();
    const base = store(disk);
    let capture = [], dying = true;
    const fire = { turns: {} };
    const hub = oneJobHub('sample', base, fire, (chatId, text) => (dying ? new Promise(() => {}) : (capture.push(text), Promise.resolve({ ok: true }))));
    hub.onInbound({ chatId: 'sample', userId: 'commander', text: 'sample one', chatType: 'dm' });
    await settle();
    A.eq(owed(disk), [], 'a sample job left mid-send leaves nothing in delivery.json');
    const capture2 = [];
    const next = oneJobHub('sample', store(disk), { turns: {} }, (chatId, text) => { capture2.push(text); return Promise.resolve({ ok: true }); });
    next.onStatus({ state: 'up' });
    await next.onInbound({ chatId: 'sample', userId: 'commander', text: 'sample two', chatType: 'dm' });
    await settle();
    A.eq(capture2, ['answer to sample two'], 'the next sample job\'s capture holds only its own reply');
    dying = false; void capture;
    next.close();
  }

  A.report('channels.one-job-ledger.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
