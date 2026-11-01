'use strict';
const { readSidecarSource } = require('./helpers/source');
/* node test/overseer-busy-lock.test.js — ONE BUSY CONVERSATION NEVER HOLDS UP ANOTHER'S REPORT (idle-cpu piece 2, 2026-10-19).
   runOnce holds a conversation's overseer lock for its whole turn (tool loops, consent waits up to 900 s). The tick used to
   AWAIT that lock, then the review run itself, so while conversation A was mid-turn no other conversation's report started,
   collect() stopped and orphaned 'reviewing' rows stayed unsettled, station-wide.
   GENUINE: the REAL tickOverseer source (sliced out of sidecar/index.js, never required: that boots a sidecar) runs in strict
   mode against the REAL overseer (locks, reviews, overseer.json) with fake runs whose ends the test controls:
     • B's report runs and completes while A's lock is held, and A's report keeps its place in A's line (a turn A sends
       later still comes after it);
     • the tick never waits, never calls a running report interrupted, and still runs ONE paid report at a time;
     • a queued report whose turn comes while another runs stays pending and is queued again later;
     • after a restart (no task) a 'reviewing' row still settles by its proof. */
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeOverseer } = require('../sidecar/overseer.js');

const idx = readSidecarSource();
const tickSrc = A.fnBody(idx, 'async function tickOverseer');
const countSrc = A.fnBody(idx, 'function runningReviews');
const cap = (idx.match(/\nconst REVIEW_RUNS_AT_ONCE = (\d+);/) || [])[1];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-overseer-busy-'));
const page = { generalId: 'convA', deletedIds: [], workstreams: ['convA', 'convB', 'convC'].map(id => ({ id, title: 'Conversation ' + id.slice(4), agentId: 'agent' })) };
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// one station: the real overseer + the real tick, every other dependency a fake whose state the test reads
function station(file, opts) {
  const o = opts || {};
  let clock = 1000;
  const reads = { n: 0 };
  // o.stamped: the save read the way sidecar/index.js wires it (a clean read carries a stamp that holds while the save does)
  const overseer = makeOverseer(Object.assign({ fs, path, file: path.join(root, file), now: () => ++clock, newId: () => 'ws_' + (++clock),
    sessions: () => { reads.n++; return JSON.parse(JSON.stringify(page)); }, hasAgent: () => true },
    o.stamped ? { sessionsRead: () => { reads.n++; return { doc: JSON.parse(JSON.stringify(page)), stamp: 'save-1' }; }, sessionsStamp: () => 'save-1' } : {}));
  const workers = [];
  const proofs = [];
  const calls = [];           // the stream of every paid review run, in launch order
  const gates = new Map();    // streamId -> the deferred that ends its review run
  const order = [];           // what ran on a conversation's line, in order
  const runs = new Map(), runsMeta = new Map(), grantsSession = new Map();
  const reviewTasks = new Map();
  const deps = {
    workspaceDegraded: false, updateHolding: () => false, overseer,
    subagents: { list: () => workers.slice(), get: id => workers.find(w => w.id === id) },
    runStore: { all: () => proofs.slice() }, isBlessedRoot: () => true,
    agentRoster: new Map([['agent', { provider: 'openrouter', model: 'test/model', system: 'You coordinate work.' }]]),
    normalizeProvider: p => p, providerRuntimeKey: () => 'sk-test', providerRuntimeBaseUrl: () => '', providerHasCredential: () => o.credential !== false,
    crypto, runs, runsMeta,
    delegatedReportPrompt: () => 'Review the background work you delegated for this conversation.',
    runOnceCoreCounted: o => {
      calls.push(o.streamId); order.push('review:' + o.streamId);
      const d = deferred(); gates.set(o.streamId, d);
      return d.promise.then(() => { proofs.push({ runId: o.runId, reason: 'done' }); });
    },
    cronSystemFor: () => '', taintPolicy: { relayedTaint: () => undefined, firstTaint: () => '' }, chanEmit: () => {},
    transcriptStore: { reconstruct: () => [] }, grantsSession, reviewTasks, REVIEW_RUNS_AT_ONCE: Number(cap)
  };
  const names = Object.keys(deps);
  const tick = new Function(...names, "'use strict';\nlet overseerTickRunning = false;\n" + countSrc + '\n' + tickSrc + '\nreturn tickOverseer;')(...names.map(n => deps[n]));
  const settle = (id, conv) => workers.push({ id, runId: id + '_run', leadId: 'agent', agentId: 'researcher', parentStreamId: conv, parentRunId: 'lead_' + id,
    streamId: 'thread_' + id, status: 'done', completedAt: clock, generation: 1, prompt: 'work', result: 'found it' });
  const row = conv => overseer.reviews().find(r => r.parentStreamId === conv) || {};
  // a tick that must come back on its own: never awaited blind (the old tick hung on a busy lock)
  const tickReturns = async () => { let back = false; tick().then(() => { back = true; }); await flush(); return back; };
  const release = async conv => { gates.get(conv).resolve(); gates.delete(conv); await flush(); };
  return { overseer, tick, tickReturns, release, settle, row, workers, calls, gates, order, runs, reviewTasks, proofs, reads };
}

(async () => {
  A.ok(tickSrc.length > 1000 && tickSrc.length < 20000, 'tickOverseer located (' + tickSrc.length + ' chars)');
  A.ok(/^function runningReviews\(\) \{/.test(countSrc), 'runningReviews located');
  A.eq(cap, '1', 'one paid report runs at a time, as before');
  A.ok(/\nconst reviewTasks = new Map\(\);/.test(idx), 'reviewTasks is a declared module Map (index.js is strict)');
  const guard = tickSrc.indexOf('if (reviewTasks.has(review.id)) continue;');
  A.ok(guard > 0 && guard < tickSrc.indexOf("review.status === 'reviewing'"), 'the tick skips a row with a live task BEFORE it could settle a reviewing row as orphaned');

  // ── 1. B's report completes while A's lock is held; A's report keeps its place in A's line ──
  {
    const s = station('one.json');
    const turnA1 = deferred();
    s.overseer.withThread('convA', async () => { s.order.push('turnA1'); await turnA1.promise; });
    s.settle('wA', 'convA'); s.settle('wB', 'convB');
    A.ok(await s.tickReturns(), 'the tick comes back while conversation A is mid-turn (it used to wait on A\'s lock)');
    A.eq(s.calls, ['convB'], 'B\'s report starts while A is busy');
    A.eq([s.row('convA').status, s.row('convB').status], ['pending', 'reviewing'], 'A\'s report waits its turn, B\'s runs');
    A.eq(s.reviewTasks.size, 2, 'both reports have a task: A\'s queued on its conversation, B\'s running');
    // later ticks while B runs and A is busy: nothing is called interrupted, nothing runs twice, the tick never waits
    for (let i = 0; i < 3; i++) A.ok(await s.tickReturns(), 'tick ' + (i + 2) + ' comes back too');
    A.eq(s.row('convB').status, 'reviewing', 'a report that is running is never settled as orphaned by a later tick');
    A.eq(s.calls, ['convB'], 'and never launched twice');
    s.settle('wC', 'convC');
    A.ok(await s.tickReturns(), 'collect() still runs while A is busy and B reports');
    A.eq([s.row('convC').status, s.calls], ['pending', ['convB']], 'C\'s report is filed but waits: one paid report at a time');
    await s.release('convB');
    A.eq(s.row('convB').status, 'done', 'B\'S REPORT COMPLETED WHILE A\'S LOCK IS STILL HELD');
    A.eq(s.row('convA').status, 'pending', 'A\'s report is still waiting on A');
    A.ok(!s.reviewTasks.has(s.row('convB').id) && s.runs.size === 0, 'B\'s task and run are gone');
    A.ok(await s.tickReturns(), 'next tick');
    A.eq(s.calls, ['convB', 'convC'], 'C\'s report starts once B\'s is done, A still busy');
    await s.release('convC');
    A.eq(s.row('convC').status, 'done', 'C\'s report completed too, A still busy');
    // A sends another turn: it queues behind A's report, which queued before it
    s.overseer.withThread('convA', async () => { s.order.push('turnA2'); });
    turnA1.resolve(); await flush();
    A.eq(s.calls, ['convB', 'convC', 'convA'], 'A\'s report runs as soon as A\'s turn ends');
    A.eq(s.row('convA').status, 'reviewing', 'A reviewing');
    A.eq(s.order.filter(x => x === 'turnA2').length, 0, 'the turn A sent later waits behind the report');
    await s.release('convA');
    A.eq(s.order, ['turnA1', 'review:convB', 'review:convC', 'review:convA', 'turnA2'], 'A\'s line: its turn, its report, then its later turn');
    A.eq(s.overseer.reviews().map(r => r.status), ['done', 'done', 'done'], 'every report done');
    A.eq([s.reviewTasks.size, s.runs.size], [0, 0], 'no task or run left behind');
    A.ok(await s.tickReturns(), 'a settled station ticks');
    A.eq(s.calls.length, 3, 'and runs nothing again');
  }

  // ── 2. a queued report whose turn comes while another runs stays pending and is queued again ──
  {
    const s = station('two.json');
    const turnA = deferred();
    s.overseer.withThread('convA', async () => { await turnA.promise; });
    s.settle('wA', 'convA'); s.settle('wB', 'convB');
    await s.tickReturns();
    A.eq(s.calls, ['convB'], 'fixture: B runs, A queued behind its busy turn');
    turnA.resolve(); await flush();
    A.eq(s.calls, ['convB'], 'A\'s turn ended while B runs: A\'s report does not start a second paid run');
    A.eq(s.row('convA').status, 'pending', 'it stays pending');
    A.ok(!s.reviewTasks.has(s.row('convA').id), 'and gives up its task');
    await s.tickReturns();
    A.eq(s.calls, ['convB'], 'a tick while B still runs does not start it either');
    await s.release('convB');
    await s.tickReturns();
    A.eq(s.calls, ['convB', 'convA'], 'once B is done, the next tick runs A\'s report');
    await s.release('convA');
    A.eq([s.row('convA').status, s.row('convB').status], ['done', 'done'], 'both done');
  }

  // ── 3. after a restart (no tasks) a reviewing row still settles by its proof ──
  {
    const s = station('three.json');
    s.settle('wA', 'convA');
    s.overseer.collect(s.workers);
    const id = s.overseer.reviews()[0].id;
    s.overseer.patchReview(id, { status: 'reviewing', reviewRunId: 'run-from-a-dead-process' });
    await s.tickReturns();
    A.eq([s.row('convA').status, s.calls], ['interrupted', []], 'a reviewing row with no task and no proof reads interrupted, nothing is re-run');
  }
  // ── 4. a report waiting for a provider credential costs no save parse per tick (it re-resolved its parent every 2 s) ──
  {
    const s = station('four.json', { stamped: true, credential: false });
    s.settle('wA', 'convA');
    for (let i = 0; i < 10; i++) await s.tickReturns();
    A.eq([s.row('convA').status, s.row('convA').error], ['pending', 'Connect the overseer provider to review this result.'], 'no credential: the report waits, saying why');
    A.eq(s.calls, [], 'and nothing runs');
    A.ok(s.reads.n <= 2, 'ten ticks parse the save at most twice (the first look, and once after the error note changed the state): ' + s.reads.n);
  }
  fs.rmSync(root, { recursive: true, force: true });
  A.report('overseer-busy-lock');
})().catch(e => { console.error(e); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });
