'use strict';
const A = require('./_assert.js'), fs = require('node:fs'), vm = require('node:vm');
const Fit = require('../frontend/app/historyfit.js'), Merge = require('../frontend/app/turnmerge.js'), Gauge = require('../frontend/app/ctxgauge.js');
const frozen = require('./fixtures/historyfit-3d581b9dd.js');
const { RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const chat = fs.readFileSync(require.resolve('../frontend/app/chat.js'), 'utf8');
const modelFns = ['windowModelOf', 'modelFitHistory'].map(name => A.fnBody(chat, 'function ' + name + '(')).join('\n');
const asks = Array.from({ length: 145 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: (i % 7 ? 'same words ' : '日本語 🌟 ') + 'x'.repeat(i * 30), rowId: i + 1, streamId: 's' }));
const variants = [[], asks, asks.concat([{ role: 'assistant', content: 'local stopped', stopped: true }, { role: 'user', content: 'newest'.repeat(15000) }]),
  [{ role: 'user', content: '', attachments: [{ id: 'image1', name: 'photo.png', type: 'image/png' }] }]];
const configs = [null, { limit: 128000 }, { limit: 5000, used: 1200, measured: true }, { limit: 8000, used: 9000, projected: true },
  { limit: 6000, used: 10000, measured: true, model: 'other' }, { limit: 5000, measuredLimit: 12000, used: 1400, measured: true }];
for (const mode of ['legacy', 'id']) for (const config of configs) for (const rows of variants) {
  const inputs = [], Harness = { getModel: () => 'selected', contextLimitOf: () => config && config.limit || 0,
    contextState: (_agent, _stream, fitted) => { inputs.push(JSON.stringify(fitted)); return config && { model: config.model || 'selected', limit: config.measuredLimit || config.limit, used: config.used || 0, measured: !!config.measured, projected: !!config.projected }; } };
  const ws = { id: 's', agentId: 'agent', history: rows }, old = frozen(Gauge, Merge, Harness, { window: mode });
  const expected = old.modelFitHistory(rows, ws), before = inputs.slice(); inputs.length = 0;
  const context = vm.createContext({ HistoryFit: Fit, Harness, CtxGauge: Gauge, stationModes: { window: mode } });
  vm.runInContext(modelFns + '\nthis.fit = modelFitHistory;', context);
  A.eq(context.fit(rows, ws), expected, mode + ': actual page delegation preserves the frozen fitted window');
  A.eq(inputs, before, mode + ': measured state receives the same preliminary fitted rows');
}
// A row that PUBLISHES where the server folds (context-budget-and-fold): the page fits to floor(runWindow x compactAt) less the measured
// overhead, not to 85% of the model's window. The frozen cases above stay the contract for every row that does not publish it (an older
// sidecar); the oracle here is the budget written out and fitted by the shared token fit, so it does not restate the code under test.
for (const mode of ['legacy', 'id']) for (const win of [{ limit: 128000, run: 128000 }, { limit: 1048576, run: 200000 }, { limit: 32000, run: 32000 }, { limit: 8000, run: 0 }])
  for (const rows of variants) for (const overhead of [null, 0, 13100]) {
    const Harness = { getModel: () => 'selected', contextLimitOf: () => win.limit, runWindowOf: () => win.run, compactAtOf: () => RUN_CONTEXT_DEFAULTS.compactAt,
      contextState: (_agent, _stream, fitted) => (overhead === null ? null : { model: 'selected', limit: win.limit, used: overhead + Fit.contextEstimateMessages(fitted), measured: true }) };
    const context = vm.createContext({ HistoryFit: Fit, Harness, CtxGauge: Gauge, stationModes: { window: mode } });
    vm.runInContext(modelFns + '\nthis.fit = modelFitHistory;', context);
    const window = win.run || win.limit, line = Math.floor(window * RUN_CONTEXT_DEFAULTS.compactAt);
    const budget = Math.max(1, line - (overhead === null ? Math.min(16000, Math.floor(window / 2)) : overhead));
    A.eq(context.fit(rows, { id: 's', agentId: 'agent', history: rows }), Fit.fitHistoryTokens(Fit.windowRows(rows, { window: mode }), budget),
      mode + ': actual page delegation fits a published row to the server fold line (window ' + window + ', overhead ' + overhead + ')');
  }
const identity = { v: 2, caps: { window: 'id', windowRequired: true } }, caps = Fit.capsOf(identity);
const ws = { id: 's', history: [{ role: 'user', content: 'typed' }] };
A.eq(caps, { v: 2, window: 'id', windowRequired: true }, 'caps shape is explicit');
A.eq(Fit.capsOf({ v: 1, caps: identity.caps }), null, 'an old station never advertises the degraded protocol');
A.eq(Fit.capsOf({ v: 2, modes: { window: 'id' } }), null, 'mode alone is not a capability proof');
A.eq(Fit.skipWait(ws, caps, {}), true, 'ID station can assemble an owned history window without waiting');
A.eq(Fit.skipWait(ws, caps, { recovery: true }), false, 'recovery keeps its existing wait contract');
A.eq(Fit.skipWait(ws, Object.assign({}, caps, { window: 'shadow' }), {}), false, 'shadow keeps the normal page wait');
A.eq(Fit.stationWindowFallback(ws, { v: 2, window: 'shadow', windowRequired: true }), true, 'shadow can serve an explicitly required degraded window');
A.eq(Fit.stationWindowFallback(ws, { v: 2, window: 'shadow', windowRequired: false }), false, 'mode without required-window support cannot degrade');
const branch = { id: 's', history: ws.history.concat([{ streamId: 'other', role: 'assistant', content: 'branch history' }]) };
A.eq([Fit.skipWait(branch, caps, {}), Fit.stationWindowFallback(branch, caps)], [false, false], 'foreign branch context keeps both decisions on the page');
const last = { role: 'user', content: 'CURRENT_TYPED', turnId: 'historyfit_turn_001', attachments: [{ id: 'attachment1' }] };
const rows = [{ role: 'user', content: 'older' }, { role: 'assistant', content: 'reply' }, last];
const opts = { ids: { turnId: last.turnId }, model: { limit: 128000, selected: 'selected', window: 'id' } };
const normal = Fit.sendPlan(rows, opts), skipped = Fit.sendPlan(rows, Object.assign({}, opts, { historyRead: { skipped: true } }));
A.eq(normal.messages, rows, 'normal send keeps its full fitted window');
A.eq(normal.post.windowTokens, 92800, 'request carries the same uncalibrated budget used by the fit');
const published = { limit: 128000, runWindow: 128000, compactAt: RUN_CONTEXT_DEFAULTS.compactAt, selected: 'selected', window: 'id' };
const folding = Fit.sendPlan(rows, Object.assign({}, opts, { model: published }));
A.eq(folding.messages, rows, 'a row that publishes the fold share still keeps a short chat whole');
A.eq(folding.post.windowTokens, Math.floor(128000 * RUN_CONTEXT_DEFAULTS.compactAt) - 16000, 'and the request carries the budget fitted to the server fold line');
A.eq(Fit.sendPlan(rows, Object.assign({}, opts, { model: Object.assign({}, published, { limit: 1048576, runWindow: 200000 }) })).post.windowTokens,
  Math.floor(200000 * RUN_CONTEXT_DEFAULTS.compactAt) - 16000, 'a price-tier row fits to the window its run works in, not the model window');
A.eq(Fit.sendPlan(rows, Object.assign({}, opts, { model: Object.assign({}, opts.model, { runWindow: 50000 }) })).post.windowTokens, 92800,
  'a runWindow with no compactAt (an older sidecar) changes nothing: the former budget');
A.eq(skipped.messages, normal.messages, 'ID skip still posts the full compatibility window');
A.eq(skipped.post.windowFrom, 'station', 'ID skip explicitly requires the station window');
const degraded = Fit.sendPlan(rows, Object.assign({}, opts, { historyRead: { degraded: true } }));
A.eq(degraded.messages, [last], 'degraded send keeps only the newest user and its attachment references');
A.eq(degraded.post.windowFrom, 'station', 'newest-only send explicitly requires canonical history');
A.eq(Fit.sendPlan(rows, Object.assign({}, opts, { recovery: true, historyRead: { degraded: true } })).post, {}, 'recovery sends no turn or window selectors');
A.eq(Fit.sendPlan(rows, { ids: opts.ids }).post, opts.ids, 'unknown model limit does not invent a token ceiling');
A.eq(Fit.sendPlan(rows.concat([{ role: 'assistant', content: 'replaced' }]), Object.assign({}, opts, { retry: true })).messages, rows, 'retry ends at the original user after fitting');
const waitFns = ['changedBeforeSending', 'untilAborted', 'ensureHistoryReady'].map(name => A.fnBody(chat, (name === 'ensureHistoryReady' ? 'async ' : '') + 'function ' + name + '(')).join('\n');
const constants = ['HISTORY_SEND_READ_MS', 'HISTORY_SEND_WAIT_MS'].map(name => chat.match(new RegExp('const ' + name + ' = [^;]+;'))[0]).join('\n');
function waiting(record, probe, extra) {
  const current = { id: 's', history: [] }, loads = new WeakMap(), notes = [], ac = new AbortController();
  let probes = 0; loads.set(current, { promise: Promise.resolve(false), retryable: false, serverFailed: false });
  const context = vm.createContext({ HistoryFit: Fit, Date, setTimeout, historyLoads: loads, historyPinSeq: 1,
    Workstreams: { get: () => current }, noteContinuity: (_ws, note) => notes.push(note), loadServerHistory: () => { throw Error('unexpected history reload'); },
    Harness: { turnIdentityCaps: () => { probes++; return Promise.resolve().then(probe); } } });
  vm.runInContext(constants + '\n' + waitFns + '\nthis.wait = ensureHistoryReady;', context);
  return { current, notes, ac, probes: () => probes, run: () => context.wait(current, ac.signal, Object.assign({ caps: record, degradedOk: true }, extra)) };
}
(async () => {
  const skip = waiting(caps, () => { throw Error('skip must not probe'); });
  A.eq(await skip.run(), { skipped: true }, 'actual production wait delegates the skip decision');
  A.eq(skip.probes(), 0, 'successful skip makes no network probe');
  const fallback = waiting(null, () => identity);
  A.eq(await fallback.run(), { degraded: true }, 'actual failed read probes and takes the proved degraded path');
  A.eq([fallback.probes(), fallback.notes], [1, ['send-station-window']], 'one fresh probe records the actual degraded decision');
  const old = waiting(null, () => ({ v: 1 }));
  let oldError; try { await old.run(); } catch (error) { oldError = error; }
  A.eq(oldError && oldError.code, 'HISTORY_UNAVAILABLE', 'actual wait preserves old-station refusal');
  const recovery = waiting(caps, () => identity, { degradedOk: false });
  let recoveryError; try { await recovery.run(); } catch (error) { recoveryError = error; }
  A.eq(recoveryError && recoveryError.code, 'HISTORY_UNAVAILABLE', 'recovery never degrades after a failed read');
  A.eq(recovery.probes(), 0, 'recovery never performs the degraded probe');
  let reached, release;
  const entered = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const canceled = waiting(null, () => { reached(); return gate; });
  const pending = canceled.run().then(() => 'accepted', error => error.message); await entered;
  canceled.ac.abort();
  A.eq(await pending, 'Conversation changed before sending.', 'Stop cancels the actual capability wait without accepting a send');
  release(identity);
  A.eq(canceled.notes, [], 'a delayed probe cannot publish degraded acceptance after Stop');
  A.report('historyfit.gate');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
