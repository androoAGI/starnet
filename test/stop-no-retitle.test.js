/* node test/stop-no-retitle.test.js — a STOPPED first turn starts no title call (J2a journey, ledger 8e709dce / 06604d70, 2026-10-30).

   The journey's conversation Stop sometimes left one run listed in the station and one provider stream open after the page
   went idle. It was not the stopped run: that one was cancelled. It was a NEW internal title call, started after the Stop.
   Stop (stopActive) asks the station to cancel and aborts the page's fetch only once the station confirms. The station
   cancels at once, and the run's own agent.run.end {reason:'cancelled'} can reach the page BEFORE that confirmation.
   Harness.chat then keeps the run's end and returns normally (the later AbortError is swallowed), so send() took its
   COMPLETED branch: the partial reply ("working") made the turn eligible for a title, and the teardown's TITLE UPGRADE
   ran maybeRetitle on the stopped first turn. That call is internal, has no streamId and no AbortSignal, so the
   conversation's Stop cannot reach it, and the session was renamed after the Commander stopped it ("working released").
   When the abort won the race, send() threw, took the stopped catch path, and made no title call.

   This drives the REAL send(), maybeRetitle(), cleanTitle() and stopActive() from chat.js, with the REAL Workstreams and
   Channels modules, in a sandbox. Harness is a stub whose lead call streams "working" and waits for the test. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const Channels = require('../frontend/app/channels.js');
const Workstreams = require('../frontend/app/workstreams.js');

// one function's source, from its declaration to the next named anchor (send() holds regexes with quotes in a character
// class, which fnBody's brace scan cannot skip, so it is sliced between its own header and the next function's)
function part(from, to) {
  const i = src.indexOf(from);
  const j = i < 0 ? -1 : src.indexOf(to, i + from.length);
  return i >= 0 && j > i ? src.slice(i, j) : '';
}
const SEND = part('  async function send(text, opts) {', '  async function maybeRetitle(');
const RETITLE = part('  async function maybeRetitle(', '  /* scrub a model title reply');
const CLEAN = part('  function cleanTitle(raw) {', '  /* DISCONNECT');
const STOP = A.fnBody(src, '  function stopActive(how) {');
const BUSY = part('  function isBusy() {', '  function isActiveWs(');
const ACTIVE = part('  function isActiveWs(ws) {', '\n');
A.ok(SEND.length > 20000 && SEND.length < src.length / 4, 'send() sliced (' + SEND.length + ' chars)');
A.ok(RETITLE.length > 500 && RETITLE.length < 6000 && /internal: true/.test(RETITLE), 'maybeRetitle sliced');
A.ok(CLEAN.length > 200 && CLEAN.length < 3000, 'cleanTitle sliced');
A.ok(STOP.length > 500 && STOP.length < 12000 && /Harness\.cancel\(rid\)/.test(STOP), 'stopActive sliced');
A.ok(BUSY.length > 50 && BUSY.length < 600 && ACTIVE.length > 20 && ACTIVE.length < 300, 'isBusy and isActiveWs sliced');

const tick = () => new Promise(res => setTimeout(res, 0));
const settle = async (n) => { for (let i = 0; i < (n || 6); i++) await tick(); };
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
// Harness.chat's real return shape (frontend/app/harness.js) for a lead run whose agent.run.end arrived
const endOf = (endReason, text, runId) => ({ text, usage: null, runId, endReason, finishReason: null, completionVerdict: 'not_assessed', effectVerdict: 'no_observed_effects',
  budgetScope: null, budgetCapUsd: null, budgetCapIsBalance: false, unpricedModel: null, unpricedCapTokens: 0, subscriptionModel: null, subscriptionCapTokens: 0, budgetProjected: false });

function rig() {
  Channels.reset();
  Workstreams.reset();
  const ws = Workstreams.create(null, { agentId: 'agent' });   // a fresh session, not General: its first turn is a first turn
  const chats = [], retitled = [], cancels = [], recaps = [], stopReasons = [], stoppedTurns = [], faults = [];
  let lead = null, cancelResolve = null, runSeq = 0;
  const harness = {
    totals: () => ({ tokens: 0, cost: 0, calls: 0 }),
    chat(o) {
      chats.push({ internal: o.internal === true, streamId: o.streamId, signal: !!o.signal });
      if (o.internal) return Promise.resolve(endOf('done', 'Bakery Landing Page Draft', 'run-title'));
      // the lead run: confirmed, streams its first words, then waits for the test (or for the page's abort)
      const runId = 'run-' + (++runSeq);
      o.onRunId(runId);
      o.onToken('working');
      return new Promise((resolve, reject) => {
        lead = { runId, resolve, reject, onAbort: null };
        if (o.signal) o.signal.addEventListener('abort', () => { if (lead && lead.onAbort) lead.onAbort(); else reject(abortError()); });
      });
    },
    cancel: (rid) => { cancels.push(rid); return new Promise(res => { cancelResolve = res; }); },
    // the not-a-STOP throw path pings the engine: a sandbox fault inside send()'s try would land here
    pingEngine: () => { faults.push('pingEngine'); return Promise.resolve(true); },
    consentAck: () => Promise.resolve({ ok: true }), summonAck: () => Promise.resolve({ ok: true })
  };
  const noop = () => {};
  const liveRow = { append: noop, done: noop, error: noop, breakSeg: noop, cleanTaskIntent: noop };
  const ctx = vm.createContext({
    console, Promise, setTimeout, clearTimeout, Date, JSON, AbortController, encodeURIComponent,
    Channels, Harness: harness,
    Workstreams: Object.assign({}, Workstreams, { retitle: (id, t, strong) => { retitled.push({ id, t, strong }); return Workstreams.retitle(id, t, strong); } }),
    App: { refreshRail: noop, refreshUsage: noop },
    World: { setActivityFor: noop, setActivity: noop, say: noop, focusAgent: noop, dropRun: noop, agentRunsLive: () => 0 },
    Classify: { isTaskDirective: () => true, isAffirmation: () => false },
    activeWs: ws, interview: null, focusVersion: 0, pendingTaskQuestion: null, lastShortVerdict: null, CORRECTION_WINDOW_MS: 600000,
    wiSeq: 0, stick: false, log: null, input: null, activeLiveRow: null, system: 'You are NOVA.', onTurn: null,
    interrupted: new Set(), stopSource: new Map(), aborters: new Map(), liveRunRoots: new Map(), queued: new Map(),
    RUN_META: new Map(), clarificationRuns: new Set(), notedRuns: new Set(), runWork: new Map(), runCrew: new Map(), interruptedStreams: new Set(),
    warmChat: noop, clearChoices: noop, stepOfferAside: noop, addUser: noop, capHistory: noop, goalStepLine: noop, goalStepOf: () => null, goalOf: () => null,
    postCorrection: noop, wiBump: () => 0, wiEmit: noop, liveVoiceCall: () => false, liveVoiceOwns: () => false,
    syncStatus: noop, ensureElapsedTimer: noop, startPresence: noop, renderPresence: noop, updateControls: noop, voiceModeRules: () => '',
    streamingAgent: () => liveRow, ensureHistoryReady: async () => ({ repaint: false }), renderHistory: noop,
    historyWindow: w => w.history.slice(), endOnUserTurn: m => m,
    retirePriorRatings: noop, recClaimRun: () => null, steerEchoesOf: () => [], markSentNowLanded: noop, fileRunSteers: noop,
    presenceToolCall: noop, presenceToolResult: noop, toolChip: noop, resolveChip: noop, skillFlavor: () => false, recentInRunSkill: 0,
    breakLive: noop, toolLine: noop, budgetStopLine: () => '', stoppedByLine: by => 'stopped by ' + by,
    markStoppedTurn: (w, t) => stoppedTurns.push(t),
    noteStopReason: (w, line, runId, endReason) => stopReasons.push({ runId, endReason }),
    offerUnpricedDoor: noop, offerBudgetDoor: noop, offerTryAgain: noop, offerRetry: () => faults.push('offerRetry'),
    offerConnectorDoor: noop, holdConnectorDoor: noop, presentTaskQuestion: noop, restoreTaskQuestion: noop, offerFork: noop,
    settleRunNeeds: noop, retireOpenConsents: noop, runWorkLine: async () => ({ hops: 0 }), claimCrew: () => [],
    renderRunRecap: (w, runId) => recaps.push(runId), resolvePresence: noop,
    persistPartial: () => faults.push('persistPartial'), errorHistoryLine: () => 'error', armReconnectWatch: noop,
    brief: s => String(s), sessionNote: () => '', whoOf: () => 'NOVA',
    releaseSentNow: noop, settleSentNow: noop, reconcileSentNow: noop, busyPeerFor: () => null, renderAgentBusy: noop, load: noop,
    flushQueued: noop, judgeGoalTurn: noop, kickGoal: noop,
    // stopActive's own helpers
    loopStop: () => false, localLine: noop, restoreQueued: noop, status: noop, settleStoppedAsks: noop, restoreSentNow: noop,
    stopFailed: () => faults.push('stopFailed'), stopReportHolding: noop
  });
  vm.runInContext(BUSY + ACTIVE + '\n' + SEND + RETITLE + CLEAN + STOP + '\n;this.__send = send; this.__stop = stopActive;', ctx);
  return {
    ctx, ws, chats, retitled, cancels, recaps, stopReasons, stoppedTurns, faults,
    lead: () => lead,
    confirmCancel: v => cancelResolve(v),
    // send one turn and wait until its lead call is streaming (the turn is handed back wrapped: an async function would adopt it)
    async start(text) {
      lead = null;
      const done = ctx.__send(text);
      for (let i = 0; i < 20 && !lead; i++) await tick();
      A.ok(!!lead, 'the lead call is streaming');
      return { done };
    }
  };
}
const leadCalls = r => r.chats.filter(c => !c.internal);
const titleCalls = r => r.chats.filter(c => c.internal);

(async () => {
  const TEXT = 'Draft the landing page for my bakery';

  // ── 1. THE DEFECT: Stop, then the run's own cancelled end arrives while the station's cancel reply is still on its way ──
  {
    const r = rig();
    const { done } = await r.start(TEXT);
    A.eq(leadCalls(r)[0], { internal: false, streamId: r.ws.id, signal: true }, 'the lead call carries the session and the abort signal');
    r.ctx.__stop('click');
    A.eq(r.cancels, ['run-1'], 'Stop asks the station to cancel the run');
    A.ok(r.ctx.interrupted.has(r.ws.id), 'the session is marked stopped by you');
    r.lead().resolve(endOf('cancelled', 'working', 'run-1'));   // the stream ends on the run's agent.run.end; the cancel reply is still pending
    await done; await settle();
    A.eq(r.recaps, ['run-1'], 'send() took its completed branch (the in-band order this test is about)');
    A.eq(r.stopReasons.map(s => s.endReason), ['cancelled'], 'and filed the run as cancelled');
    A.eq(r.stoppedTurns, ['working'], 'the partial reply is kept, marked stopped');
    A.eq(r.chats.length, 1, 'Harness.chat ran once: no title call follows a stopped turn (got ' + JSON.stringify(r.chats) + ')');
    A.eq(titleCalls(r).length, 0, 'no internal:true call was started');
    A.eq(r.retitled, [], 'the session is not renamed after the Commander stopped it');
    A.eq(Workstreams.get(r.ws.id).title, 'Draft the landing page for my bakery', 'it keeps its first-message placeholder');
    r.confirmCancel({ ok: true });   // the station's confirmation lands after the turn ended
    await settle();
    A.eq(r.chats.length, 1, 'the late confirmation starts nothing either');
    A.eq(r.faults, [], 'no fault path ran: ' + JSON.stringify(r.faults));
  }

  // ── 1b. same race, other ending: the confirmation lands first and aborts the fetch, but Harness.chat had already read the
  //        run's end, so it swallows the AbortError and returns the cancelled end (harness.js sawLeadEnd) ──
  {
    const r = rig();
    const { done } = await r.start(TEXT);
    r.lead().onAbort = () => r.lead().resolve(endOf('cancelled', 'working', 'run-1'));
    r.ctx.__stop('click');
    r.confirmCancel({ ok: true });
    await done; await settle();
    A.eq(r.recaps, ['run-1'], 'send() took its completed branch');
    A.eq(r.chats.length, 1, 'no title call after the stop (got ' + JSON.stringify(r.chats) + ')');
    A.eq(r.retitled, [], 'and no rename');
    A.eq(r.faults, [], 'no fault path ran: ' + JSON.stringify(r.faults));
  }

  // ── 1c. the teardown's own guard: a turn the Commander stopped makes no title call even when its run reports 'done'
  //        (the run finished as the Stop landed, before the station's confirmation) ──
  {
    const r = rig();
    const { done } = await r.start(TEXT);
    r.ctx.__stop('click');
    r.lead().resolve(endOf('done', 'working on it, done', 'run-1'));
    await done; await settle();
    A.eq(r.recaps, ['run-1'], 'send() took its completed branch');
    A.eq(r.chats.length, 1, 'no title call on a turn the Commander stopped (got ' + JSON.stringify(r.chats) + ')');
    A.eq(r.retitled, [], 'and no rename');
    A.eq(Workstreams.needsModelTitle(r.ws.id), true, 'it stays eligible for the next completed turn');
  }

  // ── 2. CONTROL: the other order — the confirmation aborts the fetch before the run's end is read, so send() throws ──
  {
    const r = rig();
    const { done } = await r.start(TEXT);
    r.ctx.__stop('click');
    r.confirmCancel({ ok: true });   // localAbort → the signal fires → the lead rejects with an AbortError
    await done; await settle();
    A.eq(r.recaps, [], 'send() took the stopped catch path, not the completed branch');
    A.eq(r.stoppedTurns, ['working'], 'the partial reply is kept, marked stopped');
    A.eq(r.chats.length, 1, 'no title call on the catch path either');
    A.eq(r.retitled, [], 'and no rename');
    A.eq(r.faults, [], 'the stop is not treated as a fault: ' + JSON.stringify(r.faults));
  }

  // ── 3. CONTROL: a first turn that completes still gets its model-written title, exactly once ──
  {
    const r = rig();
    const { done } = await r.start(TEXT);
    r.lead().resolve(endOf('done', 'Here is a first draft of the landing page.', 'run-1'));
    await done; await settle();
    A.eq(leadCalls(r).length, 1, 'one lead call');
    A.eq(titleCalls(r).length, 1, 'one internal title call after a completed first turn');
    A.eq(r.retitled, [{ id: r.ws.id, t: 'Bakery Landing Page Draft', strong: true }], 'the session takes the model title');
    A.eq(Workstreams.get(r.ws.id).title, 'Bakery Landing Page Draft', 'and wears it');
    A.eq(r.faults, [], 'no fault path ran: ' + JSON.stringify(r.faults));
  }

  // ── 4. a cancel the Commander's Stop did not make (E-STOP or HALT ALL: the run ends 'cancelled', the session is not
  //       marked interrupted) is still a stopped turn: no title call ──
  {
    const r = rig();
    const { done } = await r.start(TEXT);
    A.ok(!r.ctx.interrupted.has(r.ws.id), 'no Stop was pressed in this session');
    r.lead().resolve(endOf('cancelled', 'working', 'run-1'));
    await done; await settle();
    A.eq(r.recaps, ['run-1'], 'send() took its completed branch');
    A.eq(r.stopReasons.map(s => s.endReason), ['cancelled'], 'the run is filed as cancelled');
    A.eq(r.chats.length, 1, 'no title call after a cancelled run (got ' + JSON.stringify(r.chats) + ')');
    A.eq(r.retitled, [], 'and no rename');
  }

  // ── 5. the title still comes: a stopped first turn keeps its placeholder, and the next COMPLETED turn upgrades it
  //       (needsModelTitle: the session still wears the title derived from its first message) ──
  {
    const r = rig();
    const { done: first } = await r.start(TEXT);
    r.ctx.__stop('click');
    r.lead().resolve(endOf('cancelled', 'working', 'run-1'));
    await first; await settle();
    r.confirmCancel({ ok: true }); await settle();
    A.eq(titleCalls(r).length, 0, 'the stopped first turn made no title call');
    A.eq(Workstreams.needsModelTitle(r.ws.id), true, 'the session still wears its placeholder, so it stays eligible');
    const titlesBefore = titleCalls(r).length, renamesBefore = r.retitled.length;
    const { done: second } = await r.start('Use a warm palette and add the opening hours');
    r.lead().resolve(endOf('done', 'Updated: warm palette, opening hours in the footer.', 'run-2'));
    await second; await settle();
    A.eq(leadCalls(r).length, 2, 'two lead calls');
    A.eq(titleCalls(r).length - titlesBefore, 1, 'the completed second turn makes the one title call');
    A.eq(r.retitled.slice(renamesBefore), [{ id: r.ws.id, t: 'Bakery Landing Page Draft', strong: true }], 'and the session takes the model title then');
    A.eq(Workstreams.needsModelTitle(r.ws.id), false, 'the title ladder ends there');
    A.eq(r.faults, [], 'no fault path ran: ' + JSON.stringify(r.faults));
  }

  A.report('stop-no-retitle.test');
})().catch(e => { console.error(e); process.exit(1); });
