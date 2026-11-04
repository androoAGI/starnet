/* node test/routine-delivery.lifecycle.test.js — a routine's chat delivery never sends a part twice, whatever the cron does
   next (channel-delivery-ledger S4).

   A routine's result reached its chat through its own path: its own chunker call, its own in-memory per-chat FIFO, and
   no progress per part. A failed part made the cron's retry send the whole digest again; a crash after the last part
   landed but before cron.jobs.json recorded it made the next process send every part again (r5, with the real driver);
   the supersede could drop a digest that was half on the wire; a pause held a half-sent digest's last part for as long
   as the routine stayed paused. Now each target of a run is ONE durable record in the delivery ledger, driven part by
   part by its chat's lane, released by the cron only once its outcome is on disk.

   Built the way index.js builds it, with fakes only at the platform (a scripted transport) and the disk (in memory,
   with a generation fence, so a crash is real: the dead process can neither write nor send): the REAL cron driver over
   cron.jobs.json, the REAL channel store and its delivery ledger, a REAL hub attached as the channel's sender, the REAL
   ChannelOutbound and makeRoutineDelivery. A fire settles the way Run Now settles one (a lease, then settleRun), and
   each process ticks the driver's finalization recovery every 5 s, as index.js's tick does. Proves:
     (a) all parts land and the process dies before markDelivery reaches disk: the next process asks again and sends
         nothing — the record stayed 'done' until the cron released it, and it is released once the outcome is on disk;
     (b) parts 1-2 land, part 3 is refused, and a newer fire arrives: the supersede waits (the half-sent digest is busy),
         the half-sent digest finishes, and the newer one follows it, never interleaved;
     (c) the routine is paused mid-digest: the started digest finishes and its outcome is recorded while paused, and a
         result that had not started waits for the resume;
     (d) the station dies while a file is on its way: the next process sends the file, never the words again;
     (e) a target is in the receipt's deliveredTargets as soon as its first part landed (an older build after a
         downgrade skips it instead of sending its parts again);
     (f) a digest given up after its first part keeps that target in deliveredTargets, and is never sent again, not even
         once its tombstone is pruned, 30 days on, while the cron is still asking;
     (g) a record leaves only once the cron's receipt on disk names its target, even when it finished while the cron was
         asking (else the next ask finds nothing and sends it all again);
     (h) SUPERSEDE-TO-NEWEST survives a record: a chat that refuses from the first part gets the newest result naming the
         ones it replaced, never every result in a burst (nothing of an older one landed, so it is withdrawn), and a
         result that gained a count after it was queued is queued again saying so;
     (i) one failed first attempt and one landing are what a delivery reports: the cron's asks in between say nothing;
     (j) a file the platform refused for the moment waits on the lane's backoff, without resending a word; only a refusal
         that lasts is told in the note, and the chat's lane goes on.
   This file runs unchanged on trunk with only S1's pure moves cherry-picked (makeRoutineDelivery exists there; the ledger,
   its lanes and ChannelOutbound do not): (a)-(g), (i) and (j) are RED there. (h) holds there: it guards the supersede
   against the record this lane added. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeChannelReach } = require('../sidecar/channels/reach.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const Routine = require('../sidecar/routine-delivery.js');
function routineOwner() {
  if (!process.env.C9_ROUTINE_DELIVERY_SOURCE) return Routine;
  const Module = require('node:module'), crypto = require('node:crypto');
  const filename = require.resolve('../sidecar/routine-delivery.js');
  const code = fs.readFileSync(process.env.C9_ROUTINE_DELIVERY_SOURCE, 'utf8');
  console.log('CONTROL_SOURCE routine-delivery SHA256=' + crypto.createHash('sha256').update(code).digest('hex'));
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(code, filename); return loaded.exports;
}
const { makeRoutineDelivery } = routineOwner();
const CanonicalHistory = require('./helpers/channel-history.js');
const { readSidecarIndex, callRegion, liftValues } = require('./helpers/source.js');
/* THE HOOKS ARE INDEX.JS'S OWN. The driver's four delivery seams are lifted out of index.js's makeCronDriver call (its own
   structure is the subject, so the exact file) and evaluated over this world's routine delivery: a hook index.js stops
   passing is a hook this driver lacks, and the cases below that need it turn red. A bag written here kept all four while
   index.js lost them, and every case stayed green (review round 1, the 956fdecf class). */
const CRON_HOOKS = ['deliverResult', 'deliveryStarted', 'deliveryWithdrawn', 'deliveryRecorded'];
const CRON_CALL = callRegion(readSidecarIndex(), 'const cronDriver = makeCronDriver({', '\n});');
const cronHooks = (rd) => liftValues(CRON_CALL, CRON_HOOKS, { deliverCronResult: rd.deliverCronResult, routineDelivery: rd });
// the one outbound contract (S4); a tree from before it has none, and the routine delivery then sends on its own
const OUTBOUND = path.join(__dirname, '..', 'sidecar', 'channels', 'outbound.js');
const Outbound = fs.existsSync(OUTBOUND) ? require(OUTBOUND) : null;

const T0 = Date.parse('2026-10-31T09:00:00.000Z');
const ROOT = '/ws/channels';
const JOBS = '/ws/cron.jobs.json';
const LIMIT = 300;            // the channel's message limit: each digest below is three parts
const CHAT = '4242';
const settle = async (n) => { for (let i = 0; i < (n || 40); i++) await new Promise(r => setImmediate(r)); };
const hang = () => new Promise(() => {});
// '✦ Digest\n\n<tag>-P1 AAA…', '<tag>-P2 BBB…', '<tag>-P3 CCC…' at a 300-character limit
const digest = (tag) => ['A', 'B', 'C'].map((c, i) => tag + '-P' + (i + 1) + ' ' + c.repeat(230)).join('\n');

function routineJob(id, over) {
  return cronStore.makeJob(Object.assign({ id: id, name: 'Digest', prompt: 'the overnight digest', agentId: 'agent', schedule: cron.parseSchedule('every 24h', T0),
    deliver: 'origin', origin: { channel: 'telegram', chatId: CHAT } }, over || {}), { id: id, now: T0 });
}

/* ONE WORLD: a disk, a clock, timers and a platform that outlive any one process; a process boots over them */
function makeWorld(jobIds, overrides) {
  const w = { gen: 0, now: T0, files: new Map(), timers: [], wire: [], attempts: [], events: [], rules: [], media: {}, msg: 0, ids: 0, proc: null,
    health: { telegram: { connected: true, state: 'up' } }, refuse: null };
  w.files.set(JOBS, JSON.stringify({ version: 1, jobs: (jobIds || ['daily']).map(id => routineJob(id, (overrides || {})[id])) }));
  const err = (code) => Object.assign(new Error(code + ': simulated'), { code: code });
  const fsFor = (gen) => ({
    readFileSync(p) { if (gen !== w.gen) throw err('EDEAD'); if (!w.files.has(p)) throw err('ENOENT'); return w.files.get(p); },
    writeFileSync(p, d) { if (gen !== w.gen) throw err('EDEAD'); w.files.set(p, String(d)); },
    renameSync(a, b) { if (gen !== w.gen) throw err('EDEAD'); if (!w.files.has(a)) throw err('ENOENT'); w.files.set(b, w.files.get(a)); w.files.delete(a); },
    mkdirSync() {}
  });
  const setT = (fn, ms) => { const t = { at: w.now + Math.max(0, Number(ms) || 0), fn: fn, gen: w.gen, unref() { return t; } }; w.timers.push(t); return t; };
  const clearT = (t) => { const i = w.timers.indexOf(t); if (i >= 0) w.timers.splice(i, 1); };
  w.advance = async (ms) => {
    const end = w.now + ms;
    for (;;) {
      await settle(8);
      w.timers.sort((a, b) => a.at - b.at);
      const t = w.timers[0];
      if (!t || t.at > end) break;
      w.timers.shift();
      w.now = Math.max(w.now, t.at);
      if (t.gen === w.gen) t.fn();   // a dead process's timer dies with it
    }
    w.now = end;
    await settle(30);
  };
  // THE PLATFORM: every call recorded; a rule answers the calls it matches (refused, or the station dies mid-call)
  w.rule = (match, times, result) => { w.rules.push({ match: match, times: times, result: result }); };
  function decide(call) {
    for (const r of w.rules) if (r.times > 0 && r.match(call)) { r.times--; return r.result; }
    return 'ok';
  }
  function platform(gen) {
    const answer = (call) => {
      if (gen !== w.gen) return hang();
      w.attempts.push(call);
      const f = decide(call);
      if (f === 'crash') { w.crash(); return hang(); }
      if (f === 'fail') return Promise.resolve({ ok: false, error: '502: Bad Gateway', retryable: true });
      if (f === 'refuse') return Promise.resolve({ ok: false, error: '400: Bad Request: chat not found', retryable: false });
      w.wire.push(call);
      return Promise.resolve({ ok: true, messageId: 'm' + (++w.msg) });
    };
    return {
      send: (chatId, text, opts) => answer({ op: 'send', chatId: String(chatId), text: String(text), threadId: String((opts && opts.threadId) || ''), at: w.now, gen: gen }),
      sendMedia: (chatId, item, opts) => answer({ op: 'media', chatId: String(chatId), filename: String(item && item.filename), bytes: (item && item.buffer && item.buffer.length) || 0, threadId: String((opts && opts.threadId) || ''), at: w.now, gen: gen })
    };
  }
  w.crash = () => { w.gen++; };
  w.loadJobs = () => cronStore.loadEnvelope(w.files.get(JOBS) || '').jobs;
  /* A PROCESS, built the way index.js builds it: the store and its ledger, the station hub over it (its send is the
     platform; it attaches itself as the channel's sender), the reach gate, the one outbound contract, the routine
     delivery, and the real cron driver over cron.jobs.json with the routine delivery's hooks. */
  w.boot = async () => {
    const gen = w.gen;
    for (const t of w.timers.slice()) if (t.gen !== gen) clearT(t);
    const store = makeChannelStore({ fs: fsFor(gen), pathMod: path.posix, root: ROOT, clock: { now: () => w.now }, bootId: 'boot-' + gen, timers: { setTimeout: setT, clearTimeout: clearT } });
    const canonical = CanonicalHistory.make(store, { io: w.transcriptIo, now: () => w.now });
    w.transcriptIo = canonical.io;
    const history = Object.assign({}, canonical.history, { async deliver(ctx) {
      if (w.publicationGate) {
        const held = w.publicationGate; w.publicationGate = null;
        w.publicationWaiting = { runId: ctx.runId, streamId: ctx.chat.streamId };
        try { await held; } finally { w.publicationWaiting = null; }
      }
      return canonical.history.deliver(ctx);
    } });
    const adapter = platform(gen);
    const emit = (name, payload) => { if (name === 'channel.delivery' && gen === w.gen) w.events.push(Object.assign({ gen: gen }, payload)); };
    const hub = makeChannelHub({
      channel: 'telegram', store: store, history, send: (c, t, o) => adapter.send(c, t, o), emit: emit, runOnce: async () => {},
      secrets: () => ({ key: 'k', model: 'm', configured: true }), classify: () => true, newId: () => 'hubrun-' + (++w.ids), now: () => w.now,
      setTimeout: setT, clearTimeout: clearT, maxMessageLength: LIMIT
    });
    const live = { adapter: adapter, hub: hub };
    const liveFor = (c) => (String(c || 'telegram') === 'telegram' ? live : null);
    const channelReach = makeChannelReach({ liveChannelFor: liveFor, channelLiveHealth: (c) => w.health[String(c || 'telegram')] || { connected: false, state: 'down' } }).reach;
    const registry = { get: (id) => (id === 'telegram' ? { id: 'telegram', label: 'Telegram', maxMessageLength: LIMIT } : null) };
    const outbound = (Outbound && store.ledger) ? Outbound.makeChannelOutbound({ ledger: store.ledger, registry: registry, reach: channelReach,
      chatRecord: (k) => store.getChatRecord(k), liveChannelFor: liveFor, scrub: (t) => t, redact: (t) => t, emit: emit }) : null;
    const read = async (agentId, rel) => {
      return w.media[rel] ? { ok: true, buffer: Buffer.from(w.media[rel]), name: rel.split('/').pop(), mime: 'image/png' } : { ok: false, notFound: true, error: 'not found' };
    };
    const rd = makeRoutineDelivery({
      channelStore: store, channelOutbound: outbound, channelReach: channelReach, channelRegistry: registry, scrubOutbound: (t) => t, redact: (t) => t,
      history, historyContext: (channel, chatId) => channel === 'telegram' ? hub.historyContext(chatId) : null,
      runStore: { list: () => [] }, egressReader: { fireReader: () => read, shownName: (paths, p) => String(p), pathsFor: () => ({}) }, readChannelUpload: read,
      transcriptStore: canonical.transcript, stationBridge: { request: async () => ({ ok: true }) }, now: () => w.now, setTimeout: setT
    });
    let jobs = w.loadJobs();
    const hooks = cronHooks(rd);
    const driver = makeCronDriver({
      getJobs: () => jobs,
      setJobs: (next) => {
        if (gen !== w.gen || (w.refuse && w.refuse(next))) return false;
        jobs = next;
        w.files.set(JOBS, JSON.stringify({ version: 1, jobs: next }));
        return true;
      },
      runOnce: async () => {}, emit: () => {}, newId: () => 'x-' + (++w.ids), newAbort: () => new AbortController(), now: () => w.now,
      getKey: () => 'k', defaultModel: 'm', persona: 'P', warn: () => {},
      // index.js's own four (CRON_HOOKS above)
      deliverResult: hooks.deliverResult, deliveryStarted: hooks.deliveryStarted, deliveryWithdrawn: hooks.deliveryWithdrawn, deliveryRecorded: hooks.deliveryRecorded
    });
    hub.onStatus({ state: 'up' });
    w.proc = { gen: gen, store: store, hub: hub, transcript: canonical.transcript, driver: driver, jobs: () => jobs, edit: (fn) => { jobs = fn(jobs); w.files.set(JOBS, JSON.stringify({ version: 1, jobs: jobs })); } };
    // index.js: pending receipts are asked again at boot, then on every tick
    const tick = () => { if (gen !== w.gen) return; Promise.resolve(driver.recoverFinalizations()).catch(() => {}); setT(tick, 5000); };
    setT(tick, 5000);
    await driver.recoverFinalizations();
    await settle(30);
  };
  // a fire, settled the way Run Now settles one (index.js: a lease, then the driver's settleRun)
  w.fire = async (jobId, runId, text) => {
    const d = w.proc.driver;
    d.leases.set(jobId, { runId: runId, startedAt: w.now, heartbeatAt: w.now, ac: new AbortController(), isOnce: false });
    d.settleRun(jobId, runId, { reason: 'done', buf: text }, null);
    await settle(40);
  };
  w.count = (marker) => w.wire.filter(c => c.op === 'send' && c.text.indexOf(marker) >= 0).length;
  w.parts = (tag) => [1, 2, 3].map(i => w.count(tag + '-P' + i + ' '));
  w.receipt = (jobId, runId) => {
    const j = cronStore.getJob(w.proc.jobs(), jobId);
    if (!j) return null;
    return [].concat(j.deliveryBacklog || [], j.finalization ? [j.finalization] : []).find(f => String(f.runId) === runId) || null;
  };
  w.record = (id) => (w.proc.store.ledger && typeof w.proc.store.ledger.delivery === 'function') ? w.proc.store.ledger.delivery(id) : null;
  return w;
}
const recId = (jobId, runId) => 'routine:' + jobId + ':' + runId + ':@origin';

(async () => {
  // ---- the driver below is built with index.js's own delivery hooks, each a call into the routine delivery ----
  {
    const probe = makeRoutineDelivery({ channelStore: { ledger: null, getChatRecord: () => null }, channelOutbound: { provide() {}, send: async () => ({}) }, channelReach: () => ({ ok: true }),
      channelRegistry: { get: () => null }, redact: (t) => t, runStore: { list: () => [] }, egressReader: { fireReader: () => null }, transcriptStore: {}, stationBridge: {}, now: () => T0 });
    const lifted = cronHooks(probe);
    A.eq(CRON_HOOKS.filter(k => typeof lifted[k] !== 'function'), [], 'index.js passes the cron driver all four delivery hooks (deliverResult, deliveryStarted, deliveryWithdrawn, deliveryRecorded)');
  }

  // ---- (a) all parts land; the process dies before markDelivery reaches disk; the next one sends nothing ----
  {
    const w = makeWorld(['daily']);
    await w.boot();
    // the outcome's write is refused (the station is about to die): markDelivery never reaches disk
    w.refuse = (next) => { const j = cronStore.getJob(next, 'daily'); return !!(j && j.finalization && j.finalization.runId === 'run-1' && j.finalization.state === 'delivered'); };
    await w.fire('daily', 'run-1', digest('R1'));
    A.eq(w.parts('R1'), [1, 1, 1], '(a) the digest lands, each of its three parts once');
    const kept = w.record(recId('daily', 'run-1'));
    A.ok(!!kept && kept.state === 'done', '(a) its record stays, done, until the cron releases it: ' + JSON.stringify(kept && kept.state));
    w.crash(); w.refuse = null;
    await w.boot();
    await w.advance(6000);
    A.eq(w.parts('R1'), [1, 1, 1], '(a) the next process asks again and sends nothing (was: every part again)');
    const r = w.receipt('daily', 'run-1');
    A.eq(r && r.state, 'delivered', '(a) and the delivery is recorded as landed');
    A.eq(w.record(recId('daily', 'run-1')), null, '(a) the record is released once that outcome is on disk');
  }

  // ---- (b) a newer fire while a digest is half sent: the supersede waits, the half-sent digest finishes first ----
  {
    const w = makeWorld(['daily']);
    await w.boot();
    w.rule((c) => c.op === 'send' && c.text.indexOf('R1-P3 ') >= 0, 2, 'fail');   // part 3 is refused twice
    await w.fire('daily', 'run-1', digest('R1'));
    A.eq(w.parts('R1'), [1, 1, 0], '(b) parts 1 and 2 landed, part 3 was refused');
    await w.fire('daily', 'run-2', digest('R2'));   // a newer result for the same chat
    const r1 = w.receipt('daily', 'run-1');
    A.ok(!!r1 && r1.state === 'pending', '(b) the supersede did not drop the half-sent digest (it is on the wire): ' + JSON.stringify(r1 && r1.state));
    await w.advance(70000);
    A.eq(w.parts('R1'), [1, 1, 1], '(b) the half-sent digest finishes, each part once (was: superseded, its part 3 never sent)');
    A.eq(w.parts('R2'), [1, 1, 1], '(b) and the newer one lands whole');
    const seq = w.wire.filter(c => c.op === 'send').map(c => /^.*?(R\d)-P\d /s.exec(c.text)).filter(Boolean).map(m => m[1]).join(',');
    A.eq(seq, 'R1,R1,R1,R2,R2,R2', '(b) the newer digest follows the half-sent one, never interleaved');
    const daily = cronStore.getJob(w.proc.jobs(), 'daily');
    A.eq([cronStore.pendingDeliveries(daily).length, daily.lastDeliveryOk], [0, true], '(b) both are recorded as landed: nothing is left pending');
    const r2 = w.receipt('daily', 'run-2');
    A.ok(!!r2 && r2.state === 'delivered' && !(Number(r2.superseded) > 0) && w.wire.every(c => String(c.text || '').indexOf('will not be resent') < 0),
      '(b) the newer result superseded nothing: the half-sent one was not counted as "not delivered"');
  }

  // ---- (c) paused mid-digest: the started digest finishes; a result not started yet waits for the resume ----
  {
    const w = makeWorld(['daily', 'weekly']);
    await w.boot();
    // the weekly routine's result is refused at the reach gate (its channel was down): pending, not started
    w.health.telegram = { connected: false, state: 'down' };
    await w.fire('weekly', 'run-w1', digest('W1'));
    w.health.telegram = { connected: true, state: 'up' };
    A.eq(w.parts('W1'), [0, 0, 0], '(c) the weekly result was refused before any part went');
    w.rule((c) => c.op === 'send' && c.text.indexOf('R1-P3 ') >= 0, 1, 'fail');
    await w.fire('daily', 'run-1', digest('R1'));
    A.eq(w.parts('R1'), [1, 1, 0], '(c) the daily digest is half sent');
    // the Commander pauses both routines
    w.proc.edit((jobs) => cronStore.pauseJob(cronStore.pauseJob(jobs, 'daily'), 'weekly'));
    await w.advance(70000);
    A.eq(w.parts('R1'), [1, 1, 1], '(c) the started digest finishes while its routine is paused (was: its last part held until the resume)');
    A.eq(w.receipt('daily', 'run-1') && w.receipt('daily', 'run-1').state, 'delivered', '(c) and its outcome is recorded while paused');
    A.eq(w.parts('W1'), [0, 0, 0], '(c) a result that had not started waits while its routine is paused');
    w.proc.edit((jobs) => cronStore.resumeJob(jobs, 'weekly', { now: w.now }));
    await w.advance(10000);
    A.eq(w.parts('W1'), [1, 1, 1], '(c) resumed, it goes, each part once');
  }

  // ---- (d) the station dies while a file is on its way: the next process sends the file, never the words again ----
  {
    const w = makeWorld(['daily']);
    w.media['charts/today.png'] = 'PNG-BYTES';
    await w.boot();
    w.rule((c) => c.op === 'media', 1, 'crash');   // the platform never got the file
    await w.fire('daily', 'run-1', digest('R1') + '\nATTACH: charts/today.png');
    A.eq(w.parts('R1'), [1, 1, 1], '(d) the words landed before the file');
    A.eq(w.wire.filter(c => c.op === 'media').length, 0, '(d) the file had not');
    await w.boot();
    await w.advance(6000);
    const files = w.wire.filter(c => c.op === 'media');
    A.eq(files.map(c => c.filename), ['today.png'], '(d) the next process sends the file');
    A.eq(w.parts('R1'), [1, 1, 1], '(d) and never the words again (was: the whole digest again)');
    A.ok(w.wire.every(c => c.op !== 'send' || c.text.indexOf('ATTACH:') < 0), '(d) the ATTACH line itself is not delivered');
    A.eq(w.receipt('daily', 'run-1') && w.receipt('daily', 'run-1').state, 'delivered', '(d) the delivery is recorded as landed');
  }

  // ---- (e) a target is in deliveredTargets as soon as its first part landed ----
  {
    const w = makeWorld(['daily']);
    await w.boot();
    w.rule((c) => c.op === 'send' && c.text.indexOf('R1-P2 ') >= 0, 99, 'fail');   // part 2 keeps failing
    await w.fire('daily', 'run-1', digest('R1'));
    A.eq(w.parts('R1'), [1, 0, 0], '(e) part 1 landed, part 2 was refused');
    const r = w.receipt('daily', 'run-1');
    A.eq(r && r.state, 'pending', '(e) the delivery is pending');
    A.ok(!!r && Array.isArray(r.deliveredTargets) && r.deliveredTargets.indexOf('@origin') >= 0,
      '(e) the started target is in the receipt\'s deliveredTargets, so an older build skips it (was: only once every part landed): ' + JSON.stringify(r && r.deliveredTargets));
    A.ok(!!r && /still being delivered/.test(String(r.lastError || '')), '(e) and the receipt says the delivery is still going: ' + JSON.stringify(r && r.lastError));
  }

  // ---- (f) a digest given up after its first part: its target stays listed, and it is never sent again ----
  {
    const w = makeWorld(['daily']);
    await w.boot();
    w.rule((c) => c.op === 'send' && c.text.indexOf('R1-P2 ') >= 0, 1, 'refuse');   // part 2 is refused for good
    await w.fire('daily', 'run-1', digest('R1'));
    A.eq(w.parts('R1'), [1, 0, 0], '(f) part 1 landed, part 2 was refused for good');
    const r = w.receipt('daily', 'run-1');
    A.ok(!!r && Array.isArray(r.deliveredTargets) && r.deliveredTargets.indexOf('@origin') >= 0,
      '(f) a target whose first part landed is listed though it was given up, so an older build skips it: ' + JSON.stringify(r && r.deliveredTargets));
    A.ok(!!r && r.state === 'pending' && /chat not found/.test(String(r.lastError || '')), '(f) and the receipt says why it did not finish: ' + JSON.stringify(r && r.lastError));
    await w.advance(200000);
    A.eq(w.parts('R1'), [1, 0, 0], '(f) the cron asks again and nothing is sent');
    // 31 days on the tombstone is pruned (a load prunes), and the cron is still asking
    w.crash();
    w.now += 31 * 24 * 60 * 60 * 1000;
    await w.boot();
    A.eq(w.proc.store.ledger ? w.proc.store.ledger.tombstones().length : 0, 0, '(f) the tombstone is gone');
    await w.advance(6000);
    A.eq(w.parts('R1'), [1, 0, 0], '(f) and its landed part is still never sent again (was: the digest again from part 1)');
  }

  // ---- (f2) a digest refused for good on its FIRST part: never sent again, once its tombstone is pruned either ----
  for (const how of ['31 days', '50 newer tombstones']) {
    const w = makeWorld(['daily']);
    await w.boot();
    w.rule((c) => c.op === 'send' && c.text.indexOf('R1-P1 ') >= 0, 1, 'refuse');   // the chat refuses part 1 for good, once
    await w.fire('daily', 'run-1', digest('R1'));
    const tries = () => w.attempts.filter(c => c.op === 'send' && c.text.indexOf('R1-P1 ') >= 0).length;
    const told = () => w.events.filter(e => e.runId === 'run-1' && e.reason === 'undeliverable').length;
    A.eq([tries(), told()], [1, 1], '(f2 ' + how + ') part 1 was refused for good and said once');
    const r = w.receipt('daily', 'run-1');
    A.ok(!!r && r.state === 'pending' && /chat not found/.test(String(r.lastError || '')), '(f2 ' + how + ') the receipt says why it did not land: ' + JSON.stringify(r && [r.state, r.lastError]));
    await w.advance(200000);
    A.eq(tries(), 1, '(f2 ' + how + ') the cron asks again and nothing is sent');
    if (how === '31 days') {
      w.crash();
      w.now += 31 * 24 * 60 * 60 * 1000;
      await w.boot();
    } else {
      // fifty newer refusals on the same channel: the ledger keeps the last 50 tombstones per channel
      w.rule((c) => c.op === 'send' && /^7\d{3}$/.test(c.chatId), 9999, 'refuse');
      for (let i = 0; i < 50; i++) {
        const d = w.proc.store.ledger.enqueue({ id: 'filler:' + i, channel: 'telegram', chatId: String(7000 + i), kind: 'notice', parts: ['filler ' + i] });
        await w.proc.store.ledger.drive(d.chat);
      }
    }
    A.ok(!w.proc.store.ledger.tombstones().some(t => t.id === recId('daily', 'run-1')), '(f2 ' + how + ') its tombstone is gone');
    await w.advance(2000000);   // the cron asks again, more than once (its backoff tops out at 15 minutes)
    A.eq(tries(), 1, '(f2 ' + how + ') and the digest is never sent again (was: once the tombstone was pruned, the whole digest again to the chat that refused it)');
    A.eq(told(), 1, '(f2 ' + how + ') nor said undeliverable a second time');
  }

  // ---- (g) a record leaves only once the cron's receipt on disk names its target ----
  {
    const w = makeWorld(['daily'], { daily: { deliver: 'targets:4242,5151', origin: null, attachToSession: true } });
    w.media['charts/today.png'] = 'PNG-BYTES';
    await w.boot();
    for (const id of ['4242', '5151']) w.proc.store.saveChatRecord(id, { agentId: 'agent', channel: 'telegram', chatId: id, streamId: 'stream_' + id });
    w.rule((c) => c.op === 'send' && c.chatId === '4242', 1, 'fail');     // 4242 has one failed send
    w.rule((c) => c.op === 'send' && c.chatId === '5151', 9999, 'fail');  // 5151 keeps failing
    await w.fire('daily', 'run-publication-1', digest('R1') + '\nATTACH: charts/today.png');
    await w.advance(6000);
    const to = (chatId) => [1, 2, 3].map(i => w.wire.filter(c => c.op === 'send' && c.chatId === chatId && c.text.indexOf('R1-P' + i + ' ') >= 0).length);
    A.eq(to('4242'), [1, 1, 1], '(g) one target landed on its lane\'s retry');
    // The cron's next ask reaches actual canonical publication and is held there. C9 publishes
    // the durable queued parts, so it no longer reads the fire's files a second time here.
    let open;
    w.publicationGate = new Promise((r) => { open = r; });
    await w.advance(60000);
    A.eq(w.publicationWaiting, { runId: 'run-publication-1', streamId: 'stream_4242' }, '(g) the exact first target is parked at actual canonical publication');
    A.eq(to('5151'), [0, 0, 0], '(g) the other has not landed yet');
    // ...while the other target's lane lands it whole
    w.rules.length = 0;
    await w.advance(61000);
    A.eq(to('5151'), [1, 1, 1], '(g) now it has, while the cron is still asking');
    A.eq(JSON.parse(w.files.get(path.posix.join(ROOT, 'delivery.json'))).deliveries.filter(row => row.runId === 'run-publication-1').map(row => [row.chatId, row.state]).sort(), [['4242', 'done'], ['5151', 'done']], '(g) both done records remain on durable disk while canonical publication is parked');
    A.eq(w.receipt('daily', 'run-publication-1').state, 'pending', '(g) the cron cannot claim completion before the parked publication');
    open();
    await settle(40);
    await w.advance(200000);
    A.eq(to('5151'), [1, 1, 1], '(g) the cron asks again and nothing is sent twice (was: its record released unnamed, every part again)');
    const daily = cronStore.getJob(w.proc.jobs(), 'daily');
    A.eq([cronStore.pendingDeliveries(daily).length, daily.lastDeliveryOk], [0, true], '(g) both are recorded as landed');
    A.eq(w.proc.store.ledger ? w.proc.store.ledger.deliveries().length : 0, 0, '(g) and both records are released');
    A.eq(['4242', '5151'].map(id => w.proc.transcript.view('proof', 'stream_' + id, { complete: true }).filter(row => row.kind === 'delivery').length), [1, 1], '(g) both exact destination streams contain one canonical publication');
  }

  // ---- (h) a chat that refuses from the first part: a result nothing of which landed is still superseded ----
  {
    const w = makeWorld(['daily']);
    await w.boot();
    w.rule((c) => c.op === 'send', 9999, 'fail');   // the chat refuses everything for a while; the channel stays up
    await w.fire('daily', 'run-1', digest('R1'));
    await w.advance(30000);
    await w.fire('daily', 'run-2', digest('R2'));
    await w.advance(30000);
    await w.fire('daily', 'run-3', digest('R3'));
    A.eq(w.wire.length, 0, '(h) nothing has landed');
    w.rules.length = 0;                             // the chat takes messages again
    await w.advance(200000);
    A.eq([w.parts('R1'), w.parts('R2')], [[0, 0, 0], [0, 0, 0]], '(h) the older results never land: one current result per chat, never a burst of stale ones (was: each digest, whole, one after the other)');
    A.eq(w.parts('R3'), [1, 1, 1], '(h) the newest lands whole');
    A.ok(w.wire.some(c => String(c.text || '').indexOf('(2 earlier results of this routine were not delivered and will not be resent.)') >= 0), '(h) and it names the two it replaced');
    A.eq(cronStore.pendingDeliveries(cronStore.getJob(w.proc.jobs(), 'daily')).length, 0, '(h) nothing is left pending');
    A.eq(w.proc.store.ledger ? w.proc.store.ledger.deliveries().length : 0, 0, '(h) nothing is left in the ledger');

    // a result that gains a count after its record was queued: the words in the record cannot change, so it is queued again
    const w2 = makeWorld(['daily']);
    w2.media['charts/today.png'] = 'PNG-BYTES';
    await w2.boot();
    w2.rule((c) => c.op === 'send', 9999, 'fail');
    let open;
    w2.readGate = new Promise((r) => { open = r; });   // run-1's ask is held reading its file, so it is busy...
    await w2.fire('daily', 'run-1', digest('R1') + '\nATTACH: charts/today.png');
    await w2.fire('daily', 'run-2', digest('R2'));     // ...and run-2 has nothing to replace, and queues
    open();
    await settle(40);
    await w2.advance(70000);                           // the tick collapses them; run-2 is asked again, with its count
    w2.rules.length = 0;
    await w2.advance(200000);
    A.eq([w2.parts('R1'), w2.parts('R2')], [[0, 0, 0], [1, 1, 1]], '(h) the newest lands once, the one it replaced never');
    A.ok(w2.wire.some(c => String(c.text || '').indexOf('(1 earlier result of this routine was not delivered and will not be resent.)') >= 0), '(h) and its words carry the count it gained after it was queued');
    A.eq(cronStore.pendingDeliveries(cronStore.getJob(w2.proc.jobs(), 'daily')).length, 0, '(h) nothing is left pending');
  }

  // ---- (i) a delivery reports its failed first attempt and its landing; the cron's asks in between report nothing ----
  {
    const w = makeWorld(['daily']);
    await w.boot();
    w.rule((c) => c.op === 'send' && c.text.indexOf('R1-P2 ') >= 0, 9999, 'fail');
    await w.fire('daily', 'run-1', digest('R1'));
    await w.advance(200000);                        // the lane backs off; the cron asks at +60 s and +180 s
    A.ok(w.record(recId('daily', 'run-1')) != null, '(i) the delivery is still going');
    w.rules.length = 0;
    await w.advance(130000);
    A.eq(w.parts('R1'), [1, 1, 1], '(i) it lands');
    const told = w.events.filter(e => e.runId === 'run-1' && e.reason !== 'redelivery-delayed').map(e => e.ok);
    A.eq(told, [false, true], '(i) one channel.delivery for the failed first attempt, one for the landing: the cron\'s asks report nothing ' + JSON.stringify(w.events.filter(e => e.runId === 'run-1').map(e => [e.ok, e.reason])));
  }

  // ---- (j) a file refused for the moment waits on the lane's backoff; a refusal that lasts is told, and the lane goes on ----
  {
    const w = makeWorld(['daily']);
    w.media['charts/today.png'] = 'PNG-BYTES';
    await w.boot();
    w.rule((c) => c.op === 'media', 1, 'fail');     // a 502 on the upload, right after the words
    await w.fire('daily', 'run-1', digest('R1') + '\nATTACH: charts/today.png');
    A.eq(w.parts('R1'), [1, 1, 1], '(j) the words landed');
    A.eq(w.wire.filter(c => c.op === 'media').length, 0, '(j) the file was refused for the moment');
    await w.advance(6000);
    A.eq(w.wire.filter(c => c.op === 'media').map(c => c.filename), ['today.png'], '(j) it goes on the lane\'s retry (was: lost, with a note)');
    A.eq(w.parts('R1'), [1, 1, 1], '(j) and never the words again');
    A.ok(w.wire.every(c => c.text === undefined || !/could not be attached/.test(c.text)), '(j) and the chat is not told it could not come');

    const w2 = makeWorld(['daily']);
    w2.media['charts/today.png'] = 'PNG-BYTES';
    await w2.boot();
    w2.rule((c) => c.op === 'media', 9999, 'fail');  // this upload never goes
    await w2.fire('daily', 'run-1', digest('R1') + '\nATTACH: charts/today.png');
    await w2.advance(200000);
    A.ok(w2.attempts.filter(c => c.op === 'media').length >= 2, '(j) an upload that keeps failing is tried on the lane\'s backoff');
    A.ok(w2.wire.some(c => c.op === 'send' && /could not be attached/.test(c.text)), '(j) a refusal that lasts is told: the chat is not left waiting for a picture');
    A.eq(w2.parts('R1'), [1, 1, 1], '(j) and the words were not resent');
    A.eq(cronStore.pendingDeliveries(cronStore.getJob(w2.proc.jobs(), 'daily')).length, 0, '(j) the delivery is recorded: a file never holds its chat\'s lane for good');
  }

  A.report('routine-delivery.lifecycle.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
