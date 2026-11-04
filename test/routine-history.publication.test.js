'use strict';
/* Actual routine/outbound/ledger/HistoryPort/Store/cron owners. Only external transport,
   transcript IO, clock and filesystem faults are controlled. The same fixture accepts
   the exact saved pre-consumer sources through C9_PUBLICATION_CONSUMER_ROOT. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module'), crypto = require('node:crypto');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const HistoryPort = require('../sidecar/channels/history-port.js');
const History = require('./helpers/channel-history.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const cron = require('../sidecar/cron.js');
const clone = x => JSON.parse(JSON.stringify(x));
function source(rel, deps) {
  const filename = require.resolve('../' + rel), root = process.env.C9_PUBLICATION_CONSUMER_ROOT;
  const selected = root ? path.join(root, rel) : filename;
  const code = fs.readFileSync(selected, 'utf8');
  if (root) console.log('CONTROL_SOURCE ' + rel + ' SHA256=' + crypto.createHash('sha256').update(code).digest('hex'));
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => deps && Object.prototype.hasOwnProperty.call(deps, name) ? deps[name] : original(name);
  loaded._compile(code, filename); return loaded.exports;
}
const Ledger = source('sidecar/channels/delivery-ledger.js');
const Store = source('sidecar/channels/store.js', { './delivery-ledger.js': Ledger });
const Outbound = source('sidecar/channels/outbound.js');
const Routine = source('sidecar/routine-delivery.js');
const CronStore = source('sidecar/cron-store.js');
const Driver = source('sidecar/cron-driver.js', { './cron-store.js': CronStore });
const runId = 'routine-publication-0001', at = Date.parse('2026-11-03T12:00:00Z');
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };
async function scenario(name, action, options) {
  const opts = options || {}, root = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-history-'));
  const deliveryFile = path.join(root, 'delivery.json'), io = makeMemoryTranscriptIo();
  const w = { now: at, sends: [], appendFault: false, ledgerFault: null, cronFault: null, onSend: null, gen: 0, instances: [], records: [], plans: 0, io, blockChatRead: false };
  const baseAppend = io.appendDurable.bind(io);
  io.appendDurable = row => { if (w.appendFault && row.kind === 'delivery') throw Object.assign(new Error('canonical publication disk fault'), { code: 'EIO' }); return baseAppend(row); };
  const job = CronStore.makeJob({ id: 'daily', name: 'Digest', prompt: 'user routine instruction', agentId: 'agent', attachToSession: true,
    deliver: opts.one ? 'targets:target-a' : 'targets:target-a,target-b', schedule: cron.parseSchedule('every 24h', at) }, { id: 'daily', now: at });
  w.jobsBytes = JSON.stringify(CronStore.markRun([job], 'daily', { status: 'ok', runId, output: 'Delivered answer', reason: 'done' }, { now: at }));
  w.open = () => {
    const gen = ++w.gen, proxy = Object.create(fs), timers = new Set();
    proxy.readFileSync = (file, ...args) => {
      if (w.blockChatRead && path.resolve(String(file)) === path.join(root, 'chatmap.json')) throw Object.assign(new Error('chat mapping unavailable'), { code: 'EACCES' });
      return fs.readFileSync(file, ...args);
    };
    proxy.renameSync = (from, to) => {
      if (gen !== w.gen) throw Object.assign(new Error('retired process'), { code: 'EIO' });
      const isLedger = path.resolve(String(to)) === deliveryFile;
      const next = isLedger ? JSON.parse(fs.readFileSync(from, 'utf8')) : null;
      const fault = isLedger && w.ledgerFault && w.ledgerFault(next);
      if (fault === 'before') throw Object.assign(new Error('delivery write refused'), { code: 'EIO' });
      fs.renameSync(from, to);
      if (fault === 'after') throw Object.assign(new Error('delivery write acknowledgement lost'), { code: 'EIO' });
    };
    const timerApi = { setTimeout(fn) { const token = { fn, unref() {} }; timers.add(token); return token; }, clearTimeout(t) { timers.delete(t); } };
    const store = Store.makeChannelStore({ fs: proxy, pathMod: path, root, clock: { now: () => w.now }, timers: timerApi, bootId: 'publication-' + gen });
    const owner = History.make(store, { io, now: () => w.now, redact: text => text.replaceAll('private-token', '[redacted]') });
    const send = async (chatId, text) => {
      const rows = fs.existsSync(deliveryFile) ? JSON.parse(fs.readFileSync(deliveryFile, 'utf8')).deliveries : [];
      w.sends.push({ chatId, text, records: clone(rows), imported: store.getChatRecord(chatId, { readOnly: true })?.legacyImport?.state });
      if (w.onSend) return await w.onSend(chatId, text, rows);
      return { ok: true, messageId: 'message-' + w.sends.length };
    };
    const hub = makeChannelHub({ channel: 'telegram', store, history: owner.history, send, runOnce: async () => {}, emit() {},
      secrets: () => ({ key: 'k', model: 'm', configured: true }), classify: () => true, newId: () => 'unused-run-123', now: () => w.now,
      setTimeout: timerApi.setTimeout, clearTimeout: timerApi.clearTimeout });
    const adapter = { send }, registry = { get: () => ({ id: 'telegram', maxMessageLength: 300 }) };
    const outbound = Outbound.makeChannelOutbound({ ledger: store.ledger, registry, reach: () => ({ ok: true }), chatRecord: key => store.getChatRecord(key),
      liveChannelFor: () => ({ adapter, hub }), scrub: text => text, redact: text => text.replaceAll('private-token', '[redacted]'), emit() {} });
    const rd = Routine.makeRoutineDelivery({ channelStore: store, channelOutbound: outbound, channelReach: () => ({ ok: true }), channelRegistry: registry,
      history: owner.history, historyContext: (channel, chatId) => channel === 'telegram' ? hub.historyContext(chatId) : null,
      redact: text => text.replaceAll('private-token', '[redacted]'), runStore: { list: () => [] },
      egressReader: { fireReader: () => async () => ({ ok: false, notFound: true }), pathsFor: () => ({}), shownName: (_, p) => p },
      transcriptStore: owner.transcript, stationBridge: { request: async () => ({ ok: true }) }, now: () => w.now });
    let jobs = JSON.parse(w.jobsBytes);
    const driver = Driver.makeCronDriver({ getJobs: () => jobs, setJobs: next => {
      const fault = w.cronFault && w.cronFault(next);
      if (fault === 'before') return false;
      w.jobsBytes = JSON.stringify(next); jobs = next;
      return fault !== 'after';
    }, runOnce: async () => { w.plans++; }, emit() {}, newId: () => 'unused-run-456', newAbort: () => new AbortController(), now: () => w.now,
    deliverResult: rd.deliverCronResult, deliveryRecorded: rd.deliveryRecorded, deliveryStarted: rd.deliveryStarted, deliveryWithdrawn: rd.deliveryWithdrawn });
    const p = { store, owner, hub, rd, driver, jobs: () => jobs, timers,
      close() { hub.close(); store.ledger.close(); } };
    w.instances.push(p); w.proc = p; return p;
  };
  w.restart = () => { w.proc.close(); return w.open(); };
  w.raw = () => JSON.parse(fs.readFileSync(deliveryFile, 'utf8'));
  w.row = stream => w.proc.owner.transcript.view('proof', stream, { complete: true }).filter(r => r.kind === 'delivery');
  w.final = () => JSON.parse(w.jobsBytes)[0].finalization;
  w.direct = (extra) => w.proc.rd.deliverCronResult(job, Object.assign({ runId, outcome: 'ok', text: 'Delivered answer' }, extra));
  try {
    const p = w.open();
    for (const [target, chatId, streamId] of [['target-a', 'room-a', 'stream_a'], ['target-b', 'room-b', opts.shared ? 'stream_a' : 'stream_b']]) {
      p.store.saveChatRecord(target, { channel: 'telegram', chatId });
      p.store.saveChatRecord(chatId, { channel: 'telegram', chatId, streamId, agentId: 'agent' });
      p.store.appendTurn(HistoryPort.keyFor(chatId, 'tg_'), 'user', 'legacy ' + chatId);
    }
    await action(w);
  } catch (error) { A.ok(false, name + ': unexpected fixture exception ' + (error && error.stack || error)); }
  finally {
    for (const p of w.instances) p.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('routine-history-')) throw new Error('fixture cleanup escaped temporary parent');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
(async () => {
  for (const shared of [false, true]) await scenario('destinations ' + shared, async w => {
    const out = await w.direct();
    A.ok(out.ok, 'complete two-target transport is acknowledged');
    A.eq(w.sends.length, 2, 'each transport sends once');
    A.eq(w.sends.map(s => s.imported), ['done', 'done'], 'canonical import finishes before each external send');
    A.eq(w.sends.map(s => s.records.find(r => r.chatId === s.chatId).historyDestination), [
      { v: 1, streamId: 'stream_a', jobId: 'daily', target: 'target-a' },
      { v: 1, streamId: shared ? 'stream_a' : 'stream_b', jobId: 'daily', target: 'target-b' }
    ], 'captured binding is on disk before either transport');
    A.eq(w.row('stream_a').length, 1, 'first target has exactly one canonical delivery');
    A.eq(w.row('stream_b').length, shared ? 0 : 1, 'second target uses its original stream');
    A.eq((out.historyPublications || []).length, 2, 'both targets have independently acknowledged canonical publication');
    A.eq(w.row('stream_a').map(r => r.content), ['✦ Digest\n\nDelivered answer'], 'published text is the actual queued title and answer');
    A.ok(w.row('stream_a').every(r => r.taintKnown !== true), 'unproved routine provenance is not manufactured clean');
    if (shared) A.eq((out.historyPublications || []).map(p => p.rowId), [w.row('stream_a')[0]?.rowId, w.row('stream_a')[0]?.rowId], 'shared stream reuses one row for both acknowledgements');
    A.eq(w.proc.store.loadHistory('agent'), [], 'no fabricated prompt or result is appended to the legacy agent history');
    await w.proc.rd.deliveryRecorded('daily', runId, out);
    A.eq(w.raw().deliveries.length, 0, 'verified publication receipts release exact records');
    w.restart();
    const again = await w.direct(out);
    A.ok(again.ok, 'released publication re-proves after restart');
    A.eq(w.sends.length, 2, 'restart reconciliation performs no transport');
    A.eq(w.row('stream_a').length, 1, 'restart never duplicates canonical publication');
  }, { shared });

  await scenario('rotation', async w => {
    w.onSend = async (chatId) => { w.proc.store.saveChatRecord(chatId, { streamId: 'rotated' }); return { ok: true }; };
    const out = await w.direct();
    A.ok(out.ok, 'rotation after capture does not redirect publication');
    A.eq(w.row('stream_a').length, 1, 'publication goes to captured first stream');
    A.eq(w.row('stream_b').length, 1, 'publication goes to captured second stream');
    A.eq(w.row('rotated'), [], 'current rotated stream receives no old routine');
  });

  await scenario('strict append failure', async w => {
    w.appendFault = true;
    const out = await w.direct();
    A.ok(out.ok === false, 'failed canonical write cannot claim completed routine delivery');
    A.eq(w.sends.length, 1, 'transport already completed exactly once');
    A.eq(w.raw().deliveries.length, 1, 'failed publication retains its done record');
    // A failed append deliberately invalidates Store's RAM proof. The memory adapter has no disk
    // history() fallback, so inspect its actual durable rows here; restart below restores Store proof.
    A.eq(w.io.readRecent({ perStream: w.io.streamRows('stream_a') + 1 }).filter(r => r.streamId === 'stream_a' && r.kind === 'delivery'), [], 'failed publication creates no canonical row');
    w.appendFault = false; w.restart();
    const fixed = await w.direct(out);
    A.ok(fixed.ok, 'restart retries only canonical publication');
    A.eq(w.sends.length, 1, 'canonical retry never resends transport');
    A.eq(w.row('stream_a').length, 1, 'canonical retry writes once');
  }, { one: true });

  for (const landed of [false, true]) await scenario('ack failure ' + landed, async w => {
    w.ledgerFault = next => next.deliveries.some(r => r.sessionTurns && r.sessionTurns.v === 2) ? (landed ? 'after' : 'before') : null;
    const out = await w.direct();
    A.ok(out.ok === false, 'failed publication ACK remains unsuccessful');
    A.eq(w.row('stream_a').length, 1, 'canonical row exists before marker fault');
    A.eq(w.proc.store.ledger.deliveries().length, 1, 'marker failure retains caller record');
    w.ledgerFault = null; w.restart();
    const fixed = await w.direct(out);
    A.ok(fixed.ok, 'same-ID marker retry recovers failed or lost acknowledgement');
    A.eq(w.sends.length, 1, 'marker retry sends nothing');
    A.eq(w.row('stream_a').length, 1, 'marker retry does not duplicate canonical row');
  }, { one: true });

  await scenario('unknown old release', async w => {
    const out = await w.direct({ deliveredTargets: ['target-a'] });
    A.ok(out.ok === false, 'legacy released target without a canonical receipt stays unknown');
    A.eq(w.sends.length, 0, 'unknown prior destination never resends');
    A.eq(w.row('stream_a'), [], 'unknown original stream cannot be guessed from current chat');
  }, { one: true });

  await scenario('capture failure', async w => {
    w.blockChatRead = true;
    const out = await w.direct();
    A.ok(out.ok === false, 'unreadable destination refuses before queueing');
    A.eq(w.sends.length, 0, 'capture failure performs zero transport calls');
    A.eq(w.proc.store.ledger.deliveries().length, 0, 'capture failure creates no delivery record');
    A.eq(w.row('stream_a'), [], 'capture failure cannot mint canonical history');
  }, { one: true });

  await scenario('partial then given up', async w => {
    w.onSend = async () => w.sends.length === 1 ? { ok: true } : { ok: false, retryable: false, error: 'permanent second-part refusal' };
    const out = await w.direct({ text: 'long answer '.repeat(80) });
    A.ok(out.ok === false, 'partial transport remains incomplete');
    A.ok(out.deliveredTargets.includes('target-a'), 'first landed part retains legacy transport progress');
    A.eq(out.historyPublications || [], [], 'first-part progress is not publication authority');
    A.eq(w.row('stream_a'), [], 'partially delivered result creates no public canonical row');
  }, { one: true });

  await scenario('global collision on retry', async w => {
    const out = await w.direct(), row = w.row('stream_a')[0];
    if (row) w.io.appendDurable({ ...row, streamId: 'foreign_stream' });
    const retry = await w.direct(out);
    A.ok(retry.ok === false, 'globally collided publication identity refuses retry acknowledgement');
    A.eq(w.sends.length, 1, 'global collision never causes transport replay');
    A.eq(w.row('stream_a').length, 1, 'global collision never appends replacement history');
  }, { one: true });

  await scenario('given up', async w => {
    w.onSend = async () => ({ ok: false, retryable: false, error: 'permanent destination refusal' });
    const out = await w.direct();
    A.ok(out.ok === false, 'given-up target remains failed');
    A.eq(out.givenUpTargets, ['target-a'], 'transport bookkeeping preserves given-up target');
    A.eq(out.historyPublications || [], [], 'given-up transport cannot mint publication proof');
    A.eq(w.row('stream_a'), [], 'given-up transport never publishes');
  }, { one: true });

  await scenario('cron mark before release', async w => {
    w.cronFault = next => next[0].finalization.state === 'delivered' ? 'before' : null;
    await w.proc.driver.recoverFinalizations();
    A.eq(w.final().state, 'pending', 'failed cron persistence leaves its finalization pending');
    A.eq(w.raw().deliveries.length, 1, 'cron failure cannot release the done transport record');
    A.eq(w.row('stream_a').length, 1, 'canonical publication completed before cron failure');
    w.cronFault = null; w.restart();
    await w.proc.driver.recoverFinalizations();
    A.eq(w.final().state, 'delivered', 'restart persists complete delivery result');
    A.eq(w.final().historyReleased, true, 'release confirmation is persisted separately');
    A.eq(w.raw().deliveries.length, 0, 'release follows persisted canonical receipt');
    A.eq(w.sends.length, 1, 'failed cron mark never duplicates transport');
  }, { one: true });

  for (const fault of ['before', 'after']) await scenario('release write ' + fault, async w => {
    w.ledgerFault = next => next.deliveries.length === 0 ? fault : null;
    await w.proc.driver.recoverFinalizations();
    A.eq(w.final().state, 'delivered', 'cron result is persisted before attempted release');
    A.ok(w.final().historyReleased !== true, 'failed removal cannot claim confirmed release');
    A.eq(w.proc.store.ledger.deliveries().length, 1, 'failed removal retains exact caller record in memory');
    w.now += 9 * 86400000; w.ledgerFault = null; w.restart();
    await w.proc.driver.recoverFinalizations();
    A.eq(w.final().historyReleased, true, 'completed receipt retries release after restart and old TTL');
    A.eq(w.raw().deliveries.length, 0, 'retry confirms saved removal or performs it once');
    A.eq(w.sends.length, 1, 'release maintenance never resends');
    A.eq(w.plans, 0, 'release maintenance never dispatches paid work');
  }, { one: true });

  await scenario('cron release acknowledgement lost', async w => {
    w.cronFault = next => next[0].finalization.historyReleased === true ? 'before' : null;
    await w.proc.driver.recoverFinalizations();
    A.eq(w.raw().deliveries.length, 0, 'ledger release completed before cron removal fault');
    A.ok(w.final().historyReleased !== true, 'unconfirmed cron cleanup retains original publication receipt');
    w.cronFault = null; w.restart();
    await w.proc.driver.recoverFinalizations();
    A.eq(w.final().historyReleased, true, 'durable canonical proof plus fresh ledger absence closes cleanup after restart');
    A.eq(w.sends.length, 1, 'cleanup acknowledgement retry cannot resend');
  }, { one: true });

  await scenario('completed receipt survives later result', async w => {
    w.ledgerFault = next => next.deliveries.length === 0 ? 'before' : null;
    await w.proc.driver.recoverFinalizations();
    const jobs = JSON.parse(w.jobsBytes); jobs[0].deliver = 'local'; jobs[0].attachToSession = false;
    w.jobsBytes = JSON.stringify(CronStore.markRun(jobs, 'daily', { runId: 'next-result-1234', status: 'ok', output: 'later local result', reason: 'done' }, { now: w.now + 1 }));
    A.ok(JSON.parse(w.jobsBytes)[0].deliveryBacklog.some(f => f.runId === runId && f.state === 'delivered'), 'later result retains the original completed publication receipt');
    w.ledgerFault = null; w.restart();
    await w.proc.driver.recoverFinalizations();
    A.ok(!JSON.parse(w.jobsBytes)[0].deliveryBacklog.some(f => f.runId === runId), 'confirmed release removes the retained completed backlog receipt');
    A.eq(w.sends.length, 1, 'later-result cleanup does not resend the prior transport');
    A.eq(w.raw().deliveries.length, 0, 'retained receipt releases the original bound record');
  }, { one: true });
  A.report('routine canonical publication');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
