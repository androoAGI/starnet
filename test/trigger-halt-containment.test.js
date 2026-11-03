'use strict';
// Execute the complete production host stop functions with real hub stop primitives and RunTable.
// A queued persistence refusal must not hide a live hub owner, including one outside an entered core.
const A = require('./_assert.js');
const vm = require('node:vm');
const { sidecarFunctionSource } = require('./helpers/source.js');
const Halt = require('../sidecar/halt.js');
const { makeRunTable } = require('../sidecar/run-table.js');

const hostSource = ['handleHalt', 'quiesceForProcessFault'].map(name => {
  const source = sidecarFunctionSource(name);
  if (!source || source.length > 20000) throw new Error('missing or unbounded host function: ' + name);
  return source;
}).join('\n');
const noop = () => {};

function fixture(failQueue) {
  const notes = [], events = [], cleared = [];
  const table = makeRunTable();
  const core = table.admit({ runId: 'independent-core' }), coreSignal = core.join();
  function hubOwner(id, prior) {
    const abort = new AbortController();
    const rec = { runId: id, abort, endReason: prior || null, onEnd: why => events.push([id, 'end', why]) };
    abort.signal.addEventListener('abort', () => events.push([id, 'abort', Halt.endOf(rec)]));
    return rec;
  }
  // These hub owners deliberately have no RunTable entry: that independent fallback cannot replace their markers.
  const active = hubOwner('trigger-active'), prior = hubOwner('trigger-already-stopped', 'stopped');
  const late = { runId: 'trigger-late', abort: null, onEnd: why => events.push(['trigger-late', 'end', why]) };
  const unrelated = hubOwner('telegram-active');
  const triggerMap = new Map([['active-chat', active], ['late-chat', late], ['prior-chat', prior]]);
  let queueCalls = 0, mapReads = 0;
  const context = {
    console: { error: noop, warn: noop }, failNote: (tag, error) => notes.push([tag, error.message]),
    killAll: Halt.killAll, markFaulted: Halt.markFaulted, runTable: table,
    triggerRunner: {
      haltAll() { queueCalls++; if (failQueue) throw Object.assign(new Error('fixture queued terminal write refused'), { code: 'EIO' }); return 2; },
      inflights() { mapReads++; return [triggerMap]; }
    },
    telegram: { hub: { _internals: { inflight: new Map([['ordinary-chat', unrelated]]) } } },
    discord: null, genericChannels: {}, GENERIC_CHANNEL_IDS: [], telegramBots: new Map(), devHub: null,
    stepTest: null, sampleHub: null, sampleInFlight: null, handoffRunner: null,
    processFaultQuiesced: false, triggerPollTimer: 77, discoveryTimer: null, questRefreshTimer: null,
    executionCleanupTimer: null, connectorLifecycleTimer: null, livePricesRefreshTimer: null,
    clearInterval: id => cleared.push(id),
    disarmCron: noop, disarmNightshift: noop, disarmLoops: noop,
    groupSessions: { halt: () => Promise.resolve() }, pluginRuntime: { setJobsPaused: noop },
    stationOneShots: new Set(), remoteHost: { _remoteRuns: new Map() },
    cronDriver: { abortAllLeases: () => 0 }, nightshiftDriver: { abortBeat: () => 0 }, loopDriver: { abortAllLeases: () => 0 },
    nightshiftState: {}, nightshift: { engageHalt: state => Object.assign({}, state, { halted: true }) },
    saveNightshiftHalt: noop, saveCronHalted: noop, saveLoopsHalted: noop, cronHalted: false, loopsHalted: false,
    executionEnvironment: { killAllBackground: noop }, terminalSessions: { stopAll: () => 0 },
    inputGuard: { observe: () => Promise.resolve() }, subagents: { interruptAll: noop, list: () => [] },
    overseer: { stopReviews: noop }, cronLock: { release: noop }, haltStatus: () => ({}),
    shellBg: { killAll: noop }, lspManager: { closeAll: noop }, connectors: { close: noop },
    stopTelegram: noop, stopAllTelegramBots: noop, stopDiscord: noop, stopGenericChannel: noop
  };
  vm.createContext(context);
  vm.runInContext(hostSource, context);
  return { context, active, prior, late, unrelated, notes, events, cleared, coreSignal,
    counts: () => [queueCalls, mapReads], close: () => core.release() };
}

for (const kind of ['estop', 'fault']) for (const failQueue of [false, true]) {
  const f = fixture(failQueue), label = kind + (failQueue ? '/queue-write-refused' : '/normal');
  try {
    let response = null;
    if (kind === 'estop') {
      const res = { writeHead(status) { A.eq(status, 200, label + ': existing E-STOP HTTP contract remains'); },
        end(text) { response = JSON.parse(text); } };
      f.context.handleHalt({}, res);
    } else A.eq(f.context.quiesceForProcessFault(), true, label + ': first fault quiesces the process');
    const expected = kind === 'fault' ? 'faulted' : 'halted';
    A.eq(f.counts()[0], 1, label + ': queued withdrawal is attempted once');
    A.ok(f.counts()[1] > 0, label + ': queued write failure cannot hide the live hub maps');
    A.eq(Halt.endOf(f.active), expected, label + ': exact live trigger owner gets the correct end marker');
    A.ok(f.active.abort.signal.aborted, label + ': exact live trigger controller is aborted');
    A.ok(f.events.some(event => event[0] === 'trigger-active' && event[1] === 'abort' && event[2] === expected),
      label + ': withdrawal marker precedes controller abort');
    A.eq(Halt.endOf(f.late), expected, label + ': owner outside the entered core still loses late publication authority');
    A.eq(Halt.endOf(f.prior), 'stopped', label + ': an earlier owned STOP keeps its cause');
    A.ok(f.prior.abort.signal.aborted, label + ': already-marked owner is still aborted');
    A.ok(f.unrelated.abort.signal.aborted, label + ': another channel is contained independently');
    A.ok(f.coreSignal.aborted, label + ': independent RunTable fallback remains in force');
    A.eq(f.notes.length, failQueue ? 1 : 0, label + ': only the injected storage refusal is reported');
    if (failQueue) A.eq(f.notes[0] && f.notes[0][1], 'fixture queued terminal write refused', label + ': original failure is retained');
    if (kind === 'estop') {
      A.eq(response && response.halted, 5, label + ': counts include exact hub owners and the fresh independent core');
      A.eq([f.context.cronHalted, f.context.loopsHalted], [true, true], label + ': automation still stands down');
      A.ok(response.nightshiftHaltPersisted && response.cronHaltPersisted && response.loopsHaltPersisted,
        label + ': unrelated durable halt receipts retain their established meanings');
    } else {
      A.eq(f.cleared, [77], label + ': folder poll is stopped');
      A.eq(f.context.quiesceForProcessFault(), false, label + ': repeated fault remains idempotent');
      A.eq(f.counts()[0], 1, label + ': repeated fault does not retry unrelated work');
    }
  } finally { f.close(); }
}
A.report('trigger-halt-containment');
