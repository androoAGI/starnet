/* node test/outcome-roundtrip.table.test.js — ONE run outcome, read the same on EVERY surface (typed-outcomes lane, 2026-10-29).

   THE FAMILY. Whether a run succeeded, failed, was refused, was stopped, ran out of budget, was cut short, asked a question or
   never proved an ending was decided by each surface on its own, from the end reason and the error's WORDS: COMMS re-read a
   ChatGPT 429 the station classed as a rate limit as a spent plan and a refused chat template as "try again", a routine and
   its notification called a provider-cut reply a success, /v1 called it completed and an empty reply "interrupted", an ACP
   editor got end_turn for both, the terminal exited 0, the Live Doctor called a rate limit "unreachable", the phone printed
   raw reasons, a channel delivered a run that never ended as done, and the run history kept no outcome at all. Each past fix
   patched one copy (bugs 38da5ee4, 0ae69a26, 06331054, 812c3bfb; QW14; the codex-model-refused fix).

   THE INVARIANT. For each run ending below the test builds the station's REAL event stream — the real loop
   (sidecar/loop.js runAgentLoop) against a scripted provider that answers the way the real adapter's error does, passed
   through runOnceCore's own outcome sink (sliced from sidecar/index.js; absent before the lane, so the events then leave as
   the loop wrote them) — and feeds it to each surface's REAL code: the page's Harness.chat stream reader and COMMS's in-band
   failure branch and board chip (sliced from harness.js / chat.js) over the browser-shaped friendlyerror; the channel hub; the cron driver
   and the notifier fed by its cron.result; /v1 over HTTP; the ACP core fed by the bridge's own openRun (sidecar/acp/serve.js,
   reading the run's NDJSON off a stand-in /api/run); the terminal's run tracker and the exit-code call
   bin/starnet.js really makes; the Live Doctor's failureState on the provider's own error; the run-history row runOnceCore
   records (its fields lifted from the record call, the row stamp from the host's outcomeOf) and the phone's activity view of
   it, plus the track record that folds it; the ROUTINES window's card cell over the job the cron driver settled and its RUN
   HISTORY line over that row as GET /api/cron/history hands it over (sliced from windows/routines.js and handleCronHistory);
   Run Now's own tee sink, catch and finally (sliced from handleCronRun) settling through the real driver's settleRun, and the
   ROUTINES window over the job it settled, and the window's own Run Now button (its stream reader and verdict, sliced); the SLAG
   post-mortem's error kind and the floor's product crate (world.js's own run listeners, sliced); a build quest bound to the run
   (frontend/app/workqueststore.js in a page-shaped context); a group-chat participant's turn (sidecar/group-sessions.js); the
   away briefing over the run's history row (sidecar/away-briefing.js).
   Each surface's answer is checked against ONE oracle written out below — never against the resolver
   (frontend/app/runoutcome.js) itself. The `delegated` case (review r1) is a lead that finished after the worker it
   delegated to failed: the worker's forwarded error and end must never stand in for the lead's. The `delegatedNoEnd` case
   (review r4) is a lead whose stream closed without its own end after its worker ended 'done'. The `held` case (review r4) is a
   routine whose work line a reviewer BLOCKED: the 'blocked' outcome's one producer (RunOutcome.ofLine). The `stopped line` and
   `partial join` cases (review 4.3) are a routine whose entry run finished and whose work line then stopped short (a downstream hop
   failed) or whose joiner sent on without every branch: its record keeps the entry run's outcome, but its crate is no delivered job.

   It must FAIL on the commit before the lane (28541ff23) for every surface — see the per-surface summary it prints. Run against a
   `git archive 28541ff23` copy of the tree (review r4: it no longer dies there with "StopReason is not defined" — Run Now's slice is
   handed the StopReason the base's handleCronRun finally called, and a press that throws is one failed row, never the whole table)
   it printed 172 problems, 254 ok (re-run in review 4.3 with this file, on a `git archive 28541ff23` of sidecar/, frontend/app/,
   bin/, shared/ and test/; the counts grew with the rows reviews 4.1-4.3 added):
     COMMS 8/17           a ChatGPT 429 read as a spent plan, a refused template as the provider's servers, nothing answering as
                          "your internet"; the board chip read DONE for a cut reply, a question, a spending or step limit, an empty reply
     channels 15/20       a run that never ended (or whose worker ended for it) was delivered as done; a worker's 429 failed the lead
     routines 28/50       a provider-cut reply was recorded ok, no record kept an outcome, a worker's 429 was the routine's, a held
                          line was ok, the fire never settled its crate        notifications 12/16  ...and pinged "ran on its own"
     Run Now 27/50        the same, and it settled a cut reply's, a held line's and a stopped or partial line's crate 'done'
     /v1 14/19            cut = completed / stop, a policy block = failed, an empty reply = interrupted
     ACP 15/27            cut = end_turn with no note, a 429 "failed inside StarNet", a policy block = end_turn, empty unexplained
     CLI 12/15            cut exited 0 and ok, a policy block exited 1 as a run failure, a worker's end ended the lead's run
     run history 13/30    no row recorded an outcome; the track record counted a cut reply and a question as successes
     ROUTINES window 4/48 the card and RUN HISTORY read the bare reason: a cut reply "✓ ok", a 429 "✕ error", a question "✕ clarifying",
                          an unfireable schedule an earlier run's "✕ done"
     phone 16/21          cut = done; raw 'budget' / 'max_iters' / 'error' words
     Live Doctor 1/4      a rate limit, a refused template and a policy block all read "unreachable"
     SLAG post-mortem 1/5 a coded Codex 429 read quota_exhausted, a refused template the provider's servers, a coded stop with no
                          error event (capability_denied) "report it"
     floor crate 14/15    a cut reply rode to the OUTBOX as a product crate
     Run Now button 7/15  a cut, asked, budget, step-limit, empty or stopped run toasted "routine ran" in green
     build quest 14/17    a cut reply celebrated "built"        group turn 14/16  a cut reply was a completed turn, posted whole
     away briefing 13/15  a cut reply and a question nobody answered were briefed under Done as "ran"
   The per-review measurements of this table stay with the lane's history on agent/typed-outcomes-1029, frozen at bb0a62df0.
   NOT CLOSED HERE: a Deny followed by a finished reply stays 'succeeded' on every surface (the 10-17 rule e2e.run-truth-1017
   locks). GitHub androoAGI/starnet-releases#9 (rel#9: a Deny should end the run 'denied' or 'stopped by user') is NOT closed by
   this lane: it is deferred to the follow-up lane denied-outcome, which waits on the per-surface semantics.
   Nothing here boots a sidecar; /v1 and the ACP bridge's stand-in station bind loopback servers on OS-chosen ports
   (listen(0)); the group turn's store lives in an OS temp folder it removes. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { sidecarTopLevelFunction, readSidecarIndex, sidecarSourceFiles, functionSourceIn } = require('./helpers/source.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
// a module the lane adds is absent before it; anything else that fails to load is a real failure
function optional(rel) {
  try { return require(path.join(ROOT, rel)); }
  catch (e) { if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).indexOf(path.basename(rel)) >= 0) return null; throw e; }
}
const RunOutcome = optional('frontend/app/runoutcome.js');   // the page loads it before harness.js
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const { makeAutoNotifier } = require('../sidecar/autonotify.js');
const { makeOpenAiCompat } = require('../sidecar/openai-compat.js');
const { makeAcpCore } = require('../sidecar/acp/core.js');
const CliCore = require('../bin/lib/cli-core.js');
const LiveDoctor = require('../sidecar/live-doctor.js');
const { makeRunStore } = require('../sidecar/runstore.js');
const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');
const { makeRemoteHost } = require('../sidecar/remote/host.js');
const TrackRecord = require('../sidecar/outcomes.js');
const AwayBriefing = require('../sidecar/away-briefing.js');
const { makeGroupSessions } = require('../sidecar/group-sessions.js');
const os = require('os');
const StopReason = require('../sidecar/stop-reason.js');   // what handleCronRun's own finally called before the lane (28541ff23)

// ================================================= THE ORACLE ==========================================================
// [outcome, failureCode] per run ending, and what each surface must then show — written out, never computed.
const ORACLE = {
  done:        ['succeeded', ''],
  cut:         ['cut_short', ''],
  asked:       ['asked', ''],
  codex429:    ['failed', 'rate_limit'],
  template:    ['failed', 'template_refusal'],
  unreachable: ['failed', 'unreachable'],
  policy:      ['refused', 'content_policy_blocked'],
  budget:      ['out_of_budget', ''],
  steps:       ['step_limit', ''],
  empty:       ['empty', ''],
  stopped:     ['stopped', ''],
  noend:       ['failed', 'no_terminal_outcome'],   // the run resolved, but nothing ever said how it ended
  thrown:      ['failed', 'no_terminal_outcome'],   // the run threw before its loop returned
  // the lead finished; the worker it delegated to (team.dispatch) hit a 429, forwarded onto the lead's stream under ITS runId
  delegated:   ['succeeded', ''],
  // the lead's stream closed WITHOUT its own end, after the worker it delegated to ended 'done': the worker's end is never the lead's
  delegatedNoEnd: ['failed', 'no_terminal_outcome']
};
/* A DELEGATED worker's error and end are the worker's (review r1 for /v1; review r4 for the rest). Until r4 the channel hub (and
   its line-hop sink), the cron driver's sink, Run Now's tee and the terminal's end took any agent.run.error / .end on the stream as
   the lead's, and skipped the delegated case here. EMPTY now: every surface reads the lead's own run (the acceptance test). */
const LEAD_ONLY_DEFERRED = {};
const deferred = (surface, kind) => !!(LEAD_ONLY_DEFERRED[kind] && LEAD_ONLY_DEFERRED[kind].has(surface));
const CASES = Object.keys(ORACLE);
// COMMS: the kind of the error row the page shows (null: no error row — the run did not fail in-band)
const COMMS_KIND = { done: null, cut: null, asked: null, codex429: 'rate_limit', template: 'template_refusal', unreachable: 'unreachable',
  policy: 'content_policy_blocked', budget: null, steps: null, empty: null, stopped: null, noend: 'network', thrown: 'any', delegated: null, delegatedNoEnd: 'network' };
// COMMS' board chip for a run that completed in-band (Workstreams.noteRunEnd's ok): DONE only for a succeeded run; no verdict (null)
// for a question or a stop. Before review r4 COMMS marked EVERY completed run DONE (a cut reply, a spending or step limit, an empty one)
// review r8: lastRunOk false is a FAILED run's alone — a cut reply, a limit, an empty reply, a question or a stop is no verdict (null), its outcome
// the word the board reads (stationui boardEnd); none of these kinds reaches the chip as a failure
const CHIP = { done: true, cut: null, asked: null, budget: null, steps: null, empty: null, stopped: null, delegated: true };
// a channel's delivery record (the run's end, as delivered)
const CHANNEL_REASON = { done: 'done', cut: 'done', asked: 'clarifying', codex429: 'error', template: 'error', unreachable: 'error', policy: 'error',
  budget: 'budget', steps: 'max_iters', empty: 'empty', stopped: 'cancelled', noend: 'error', thrown: 'error', delegated: 'done', delegatedNoEnd: 'error' };
const CHANNEL_SAYS = { cut: /cut short/, empty: /empty reply/, noend: /without reporting how it finished/, thrown: /sidecar failure: boom/, delegatedNoEnd: /without reporting how it finished/ };
// a routine: only a succeeded run is ok (and only it pings "ran on its own")
const ROUTINE_OK = { done: true, delegated: true };
// review r7 (the family law): a fire someone STOPPED is its own outcome — its record says 'stopped' and so does cron.result, never 'error' /
// 'failed' (the HUD, the session, the delivery headline and the consecutive-failure count all read those words as a failure)
const ROUTINE_STOPPED = { stopped: true };
const routineStatus = kind => (ROUTINE_OK[kind] ? 'ok' : ROUTINE_STOPPED[kind] ? 'stopped' : 'error');
const routineResult = kind => (ROUTINE_OK[kind] ? 'ok' : ROUTINE_STOPPED[kind] ? 'stopped' : 'failed');
// the reason a routine's fire hands on — cron.result's (the HUD's "✕ routine failed — …", the routine's COMMS session) and its record's
// lastReason (routine.list): 'done' only for a fire that succeeded (review 5.1: a cut fire read "routine failed — done"; a held line too), and a
// refused fire's word is the refusal's own (review 9.2: RunOutcome.reasonOf kept its end's bare 'error', the failure's word, for a provider's safety block)
const ROUTINE_REASON = { done: 'done', cut: 'cut_short', asked: 'clarifying', codex429: 'error', template: 'error', unreachable: 'error', policy: 'refusal',
  budget: 'budget', steps: 'max_iters', empty: 'empty', stopped: 'cancelled', noend: 'error', thrown: 'error', delegated: 'done', delegatedNoEnd: 'error' };
// a group-chat turn: completed only when the participant's run succeeded (a question it asked is still its reply)
// review r8: a turn that did not finish (cut short, a limit, an empty reply) is 'unfinished', a stopped run's turn 'stopped' — never the crash's 'failed'
const GROUP_STATE = { done: 'completed', asked: 'completed', delegated: 'completed', cut: 'unfinished', budget: 'unfinished', steps: 'unfinished', empty: 'unfinished', stopped: 'stopped' };
// /v1: the run status, and the finish_reason of the runs that streamed text
const V1_STATUS = { done: 'completed', cut: 'limited', asked: 'awaiting_input', codex429: 'failed', template: 'failed', unreachable: 'failed',
  policy: 'refused', budget: 'limited', steps: 'limited', empty: 'failed', stopped: 'cancelled', noend: 'interrupted', thrown: 'failed', delegated: 'completed', delegatedNoEnd: 'interrupted' };
const V1_FINISH = { done: 'stop', cut: 'length', asked: 'stop', delegated: 'stop', stopped: 'cancelled' };   // review r7: a stop is never finish_reason 'error'
// an ACP editor's stopReason, and the note a lossy one owes
const ACP_STOP = { done: 'end_turn', cut: 'max_tokens', asked: 'end_turn', codex429: 'end_turn', template: 'end_turn', unreachable: 'end_turn',
  policy: 'refusal', budget: 'end_turn', steps: 'max_turn_requests', empty: 'end_turn', stopped: 'cancelled', noend: 'end_turn', thrown: 'end_turn', delegated: 'end_turn', delegatedNoEnd: 'end_turn' };
const ACP_SAYS = { cut: /cut short/, codex429: /model provider failed this turn \(rate_limit\)/, empty: /empty reply/, steps: /step limit/, budget: /spend cap/,
  policy: /safety filter declined this request/,
  // a lead that never ended is told so — never "failed inside StarNet", and never a clean end_turn because its WORKER ended 'done'
  // (review 4.1: the bridge took any agent.run.end on the stream as the lead's, so delegatedNoEnd read as a clean finish)
  noend: /never reported how this run ended/, delegatedNoEnd: /never reported how this run ended/ };
// the terminal: its exit code (EXIT: 0 ok, 1 run failed, 4 cancelled, 5 stopped short of done)
const CLI_EXIT = { done: 0, cut: 5, asked: 5, codex429: 1, template: 1, unreachable: 1, policy: 5, budget: 5, steps: 5, empty: 5, stopped: 4, noend: 1, thrown: 1, delegated: 0, delegatedNoEnd: 1 };
// the Live Doctor, on the provider's own error: did the provider ANSWER (and refuse), or did nothing answer?
const DOCTOR = { codex429: 'refused', template: 'refused', unreachable: 'unreachable', policy: 'refused' };
// the phone's activity row
const PHONE_STATE = { done: 'done', cut: 'failed', asked: 'done', codex429: 'failed', template: 'failed', unreachable: 'failed', policy: 'failed',
  budget: 'failed', steps: 'failed', empty: 'failed', stopped: 'stopped', noend: 'failed', thrown: 'failed', delegated: 'done', delegatedNoEnd: 'failed' };
const PHONE_SAYS = { codex429: /^rate_limit$/, template: /^template_refusal$/, steps: /step limit/, budget: /spending limit/, cut: /cut short/, thrown: /^no_terminal_outcome$/ };
// the track record: a decided success, a decided failure, or no attempt at all
const TRACK = { done: 'ok', cut: 'fail', asked: 'skip', codex429: 'fail', template: 'fail', unreachable: 'fail', policy: 'fail',
  budget: 'fail', steps: 'fail', empty: 'fail', stopped: 'skip', noend: 'fail', thrown: 'fail', delegated: 'ok', delegatedNoEnd: 'fail' };
// the ROUTINES window: what its card's last-run cell and the run's RUN HISTORY line both say (only a succeeded run is ok)
// review r8: each in its outcome's glyph (routines.js endMark): a question ▲, a run that did not finish ⚠, only a failure the red ✕
const WINDOW_SAYS = { done: '✓ ok', cut: '⚠ the reply was cut short', asked: '▲ asked a question', codex429: '✕ failed (rate_limit)',
  template: '✕ failed (template_refusal)', unreachable: '✕ failed (unreachable)', policy: '⚠ the model declined the request (content_policy_blocked)',
  budget: '⚠ hit a spending limit', steps: '⚠ reached the step limit', empty: '⚠ the model sent back an empty reply',
  stopped: '■ stopped before it finished', noend: '✕ failed (no_terminal_outcome)', thrown: '✕ failed (no_terminal_outcome)',   // review r7: a stop is never the red ✕
  delegated: '✓ ok', delegatedNoEnd: '✕ failed (no_terminal_outcome)' };
// a work line a reviewer BLOCKED: the routine's card (the 'blocked' outcome's one producer, RunOutcome.ofLine)
const HELD_WHY = 'the reviewer at the gate review answered VERDICT: blocked, so the work is held there — not sent on, not shipped';
const HELD_SAYS = '⚠ held: the work was not accepted';   // review r8: a hold is no failure

// ================================================= THE STATION =========================================================
// the provider's own errors, shaped as the adapters throw them
const PROVIDER_ERROR = {
  codex429: () => Object.assign(new Error('codex http 429 — Codex quota exceeded'),
    { status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'Codex quota exceeded' } }, ownMessage: true }),
  template: () => Object.assign(new Error('ollama http 500 - {"error":"Jinja Exception: System message must be at the beginning."}'), { status: 500, requestHost: 'localhost' }),
  unreachable: () => Object.assign(new TypeError('fetch failed'),
    { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 11434 }) }),
  policy: () => Object.assign(new Error('openrouter http 400 — Your request was flagged by the content policy'), { status: 400 })
};
const scripted = gen => ({ stream: gen, priceOf: () => null, contextLimit: () => 0 });
const says = (t, finish) => scripted(async function* () { yield { type: 'text', delta: t }; yield { type: 'done', finishReason: finish || 'stop' }; });
async function loopRun(kind) {
  const events = [];
  const opts = { messages: [{ role: 'user', content: 'go' }], emit: (n, p) => events.push([n, p]), model: 'm', agentId: 'agent', runId: 'r-' + kind };
  if (kind === 'done' || kind === 'delegated') opts.provider = says('All done.');
  else if (kind === 'cut') opts.provider = says('Part one of the essay', 'length');
  else if (PROVIDER_ERROR[kind]) opts.provider = scripted(async function* () { throw PROVIDER_ERROR[kind](); });   // eslint-disable-line require-yield
  else if (kind === 'budget') { opts.provider = says('never sent'); opts.budget = { check: () => ({ scope: 'run', usd: 3, cap: 3 }) }; }
  else if (kind === 'steps') {
    const reg = makeRegistry();
    reg.register({ name: 'probe', description: 'probe', capability: 'compute', scope: 'read', impact: 'none', schema: { type: 'object', properties: {} }, run: async () => 'probed' });
    opts.provider = scripted(async function* () { yield { type: 'tool_start', index: 0, id: 'c' + Math.floor(events.length), name: 'probe' }; yield { type: 'tool_args', index: 0, chunk: '{}' }; yield { type: 'done', finishReason: 'tool_calls' }; });
    opts.tools = reg.wireFormat(); opts.dispatch = (c, ctx) => reg.dispatch(c, ctx); opts.limits = { maxIters: 1, grace: false };
  } else if (kind === 'empty') opts.provider = scripted(async function* () { yield { type: 'done', finishReason: 'stop' }; });
  else if (kind === 'stopped') { const ac = new AbortController(); ac.abort(); opts.signal = ac.signal; opts.provider = says('never sent'); }
  const result = await runAgentLoop(opts);
  return { events, result };
}
const CORE = sidecarTopLevelFunction('runOnceCore');
A.ok(CORE.length > 100000, 'fixture: runOnceCore is sliced from the sidecar source');
// runOnceCore's own outcome sink, when the station has one (sliced, with the map it hands the history row's stamp through)
// (run-table S2: the sink sits under the run table's guard, so the chain's head is `const chainEmit = outcomeSink(`)
const SINK_SRC = /const (emit|chainEmit) = outcomeSink\(/.test(CORE) ? sidecarTopLevelFunction('outcomeSink') : '';
function stationEmit(collect, endedOutcomes) {
  if (!SINK_SRC) return collect;
  return new Function('RunOutcome', 'endedOutcomes', SINK_SRC + '\nreturn outcomeSink;')(RunOutcome, endedOutcomes)(collect);
}
// THE RUN: its events as they leave runOnceCore, whether its runOnce throws, and the loop result its history row is built from
// THE RUN TABLE heads that chain (run-table S2: the REAL sidecar/run-table.js guard, as runOnceCore wires it), and its BELT ends a run whose
// runOnce threw before the throw reaches any surface (runOnce's finally: the run's error words and one end, through the chain)
const RunTableMod = require('../sidecar/run-table.js');
async function stationRun(kind) {
  const endedOutcomes = new Map();
  const out = [];
  const runId = 'r-' + kind;
  const tableRun = RunTableMod.makeRunTable().admit({ runId, agentId: 'agent' });
  const emit = tableRun.entry.guard(stationEmit((n, p) => out.push([n, p]), endedOutcomes));
  let result, throws = false, taskQuestionAsked = false;
  if (kind === 'asked') {
    // the loop ended 'done' on a Task Brief question; runOnceCore re-emits its buffered end as 'clarifying'
    emit('agent.run.start', { agentId: 'agent', runId, trigger: 'directive', model: 'm' });
    emit('agent.token', { agentId: 'agent', runId, delta: 'Which folder should I write it to?' });
    emit('agent.run.end', { agentId: 'agent', runId, reason: 'clarifying', turns: 1, usd: 0 });
    result = { reason: 'done', turns: 1, messages: [] }; taskQuestionAsked = true;
  } else if (kind === 'noend' || kind === 'thrown' || kind === 'delegatedNoEnd') {
    emit('agent.run.start', { agentId: 'agent', runId, trigger: 'directive', model: 'm' });
    emit('agent.token', { agentId: 'agent', runId, delta: 'A partial answer' });
    if (kind === 'delegatedNoEnd') {
      // the worker ran and ENDED (stamped by its own runOnceCore, as it reaches the lead's emit); the lead's stream then closed
      const wEnd = { agentId: 'worker', runId: 'w-1', reason: 'done', turns: 1, usd: 0 };
      emit('agent.run.start', { agentId: 'worker', runId: 'w-1', trigger: 'delegated', model: 'm' });
      emit('agent.run.end', RunOutcome ? RunOutcome.stamp(wEnd, null) : wEnd);
    }
    // a thrown run is ended by the belt before its throw reaches a surface; a run that RESOLVED without its end (noend) is left as it
    // is, so every surface's own reader of a stream without an end stays pinned (the belt's own case is test/run-lifecycle.invariants)
    if (kind === 'thrown') { throws = true; result = undefined; tableRun.entry.settle(new Error('boom'), null); } else result = { turns: 1, messages: [] };
  } else {
    const r = await loopRun(kind);
    for (const [n, p] of r.events) {
      emit(n, p);
      // team.dispatch's worker: its run.start / run.error / run.end reach the lead's emit (orchestration.js FORWARD); the lead's
      // outcome sink pairs each end with its own run's error
      if (kind === 'delegated' && n === 'agent.run.start') {
        emit('agent.run.start', { agentId: 'worker', runId: 'w-1', trigger: 'delegated', model: 'm' });
        emit('agent.run.error', { agentId: 'worker', runId: 'w-1', message: 'openrouter http 429: rate limited', transient: true, failureCode: 'rate_limit' });
        emit('agent.run.end', { agentId: 'worker', runId: 'w-1', reason: 'error', turns: 1, usd: 0 });
      }
    }
    result = r.result;
  }
  tableRun.release();
  return { kind, runId, events: out, throws, result, taskQuestionAsked, endedOutcomes };
}
// replay a run's events onto a surface's own sink under that surface's run id (a forwarded worker's keep the worker's)
function replay(run, emit, runId, agentId) {
  for (const [n, p] of run.events) {
    const lead = !!p && p.runId === run.runId;
    emit(n, Object.assign({}, p, lead ? { runId: runId || p.runId } : {}, lead && agentId && p.agentId ? { agentId } : {}));
  }
}
// what /api/run streams: the run's events, and — when its runOnce threw — what handleRun's OWN catch adds (sliced): since run-table S2
// nothing for a run runOnce's belt ended (its bus saw that end), the balanced receipt for a throw before runOnce began
const HANDLE_RUN_SRC = sidecarTopLevelFunction('handleRun');
const runCatchAt = HANDLE_RUN_SRC.indexOf("    if (recovery) settleRunRecoveryContinuation(recovery, runId, 'error');");
const RUN_CATCH = runCatchAt < 0 ? '' : HANDLE_RUN_SRC.slice(runCatchAt, HANDLE_RUN_SRC.indexOf('  } finally {', runCatchAt));
A.ok(/RunTable\.thrownReceipt\(/.test(RUN_CATCH) && /if \(!leadEnded\)/.test(RUN_CATCH), 'fixture: handleRun\'s catch (the receipt of a throw its belt did not end) is sliced');
function wireOf(run) {
  const w = run.events.slice();
  if (run.throws) {
    // handleRun's bus marks what reached the page under the run's own id, exactly as the route does
    const seen = name => w.some(([n, p]) => n === name && p && p.runId === run.runId);
    new Function('e', 'recovery', 'leadStarted', 'leadEnded', 'agentId', 'runId', 'model', 'emit', 'failNote', 'settleRunRecoveryContinuation', 'RunOutcome', 'RunTable', RUN_CATCH)(
      new Error('boom'), null, seen('agent.run.start'), seen('agent.run.end'), 'agent', run.runId, 'm', (n, p) => w.push([n, p]), () => {}, () => {}, RunOutcome || undefined, RunTableMod);
  }
  return w;
}

// ================================================= THE SURFACES ========================================================
// ---- COMMS: the real Harness.chat stream reader + the real in-band failure branch of chat.js, browser-shaped Friendly ----
const harnessSrc = read('frontend/app/harness.js');
const chatSrc = read('frontend/app/chat.js');
const BrowserFriendly = (() => { const sb = { console }; sb.globalThis = sb; vm.createContext(sb); vm.runInContext(read('frontend/app/friendlyerror.js') + '\nthis.__F = Friendly;', sb); return sb.__F; })();
const chatFnAt = harnessSrc.indexOf('  async function chat('), chatFnEnd = harnessSrc.indexOf('  /* Read-only fetch of an agent', chatFnAt);
A.ok(chatFnAt > 0 && chatFnEnd > chatFnAt, 'fixture: Harness.chat is sliced whole');
const inbandAt = chatSrc.indexOf('      if (error) {\n        // PLAIN-LANGUAGE'), inbandEnd = chatSrc.indexOf('      } else {\n        // the run COMPLETED', inbandAt + 1);
A.ok(inbandAt > 0 && inbandEnd > inbandAt, 'fixture: the COMMS in-band failure branch is sliced');
const INBAND = chatSrc.slice(inbandAt, inbandEnd) + '}';
// the completed branch's FIRST act: the workstream board's chip for the run (Workstreams.noteRunEnd) — what COMMS shows for a run
// that did not fail in-band, read from what Harness.chat returned (review r1: the rows checked a field COMMS never read)
const chipAt = chatSrc.indexOf("        // settle the outcome so the board's DONE chip is anchored to a real finished run.\n", inbandEnd);
const CHIP_SRC = chipAt < 0 ? '' : chatSrc.slice(chipAt, chatSrc.indexOf('\n', chatSrc.indexOf('Workstreams.noteRunEnd(', chipAt)));
A.ok(/Workstreams\.noteRunEnd\(ws\.id, thisRunId/.test(CHIP_SRC), 'fixture: COMMS\' board chip (its completed branch) is sliced');
function commsChip(res, runId) {
  const marks = [];
  new Function('runOutcome', 'endReason', 'thisRunId', 'ws', 'Workstreams', CHIP_SRC)(res.outcome, res.endReason, runId, { id: 'w' },
    { noteRunEnd: (id, rid, ok, why) => { marks.push({ ok, why }); return true; } });
  return marks.length ? marks[0].ok : '(no chip)';
}
async function viaComms(run) {
  const bytes = new TextEncoder().encode(wireOf(run).map(([name, payload]) => JSON.stringify({ name, payload })).join('\n') + '\n');
  let sent = false;
  const reader = { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; }, releaseLock() {} };
  const scope = {
    TextDecoder, console, DESKTOP: false, DEVMODE: true, RunOutcome: RunOutcome || undefined,
    getModel: () => 'm', getProv: () => 'openrouter', getKey: () => '', getReasoningEffort: () => '', getBaseUrl: () => '', providerNeedsKey: () => false,
    sidecarErrorDetail: t => String(t || ''), fetch: async () => ({ ok: true, body: { getReader: () => reader } }),
    U: { bus: { emit() {} } }, totals: { calls: 0, tokens: 0, cost: 0 }, runModels: {}, internalRuns: new Set(), delegatedRuns: new Set(), registerRun() {}, foldContextCost() {}
  };
  const chat = vm.runInNewContext(harnessSrc.slice(chatFnAt, chatFnEnd) + '\nchat', scope);
  let res;
  try { res = await chat({ messages: [], agentId: 'agent', onRunId() {} }); }
  catch (e) { return { errorKind: BrowserFriendly.friendlyError(e, null, { engineAlive: true }).kind, threw: true }; }   // the page's catch reads the drop
  if (!res.error) return { errorKind: null, outcome: res.outcome, chip: commsChip(res, run.runId) };
  const shown = [];
  const sb = {
    // (review 8.1: the branch settles the board by the run's OUTCOME — Harness.chat's stamp — never the error flag alone)
    runOutcome: res.outcome, RunOutcome: RunOutcome || undefined,
    TurnMerge: require('../frontend/app/turnmerge.js'),
    liveRunTurns: new Map([['w', { sourceRunId: run.runId, turnId: require('../frontend/app/turnkinds.js').runTurnId(run.runId) }]]), retryDirectiveTurn: null,
    error: res.error, errorCode: res.errorCode, ws: { id: 'w', agentId: 'agent', history: [] }, acc: '', thisRunId: run.runId, runRoot: null, retry: false,
    text: 'go', input: null, busyRefusal: '', Friendly: BrowserFriendly, persistPartial() {}, Workstreams: { noteRunEnd() {} },
    StationUI: { notify() {} }, isActiveWs: () => true, activeLiveRow: { error: m => shown.push(m) }, resolvePresence() {},
    offerRetry: v => shown.push('kind:' + v.kind), errorHistoryLine: v => v.userMessage, settleRunNeeds() {}, autoGrowInput() {},
    whoOf: () => 'Agent', sessionNote: () => '', brief: s => s, goalStall: ''
  };
  vm.runInNewContext('(function() {' + INBAND + '\n})', sb)();
  const k = shown.find(s => /^kind:/.test(s));
  return { errorKind: k ? k.slice(5) : 'none', words: shown.filter(s => !/^kind:/.test(s)).join(' | ') };
}

// ---- the SLAG post-mortem: world.js's own agent.run.error / agent.run.end listeners (sliced), browser-shaped Friendly, and the
//      error it hands slaglog.record for the notifications panel's post-mortem. Review r2: it kept only the error's words, so the
//      page's words ladder re-read a Codex 429 the station classed as a rate limit as a spent ChatGPT plan ----
const worldSrc = read('frontend/app/world.js');
const slagAt = worldSrc.indexOf("    U.bus.on('agent.run.error', p => {\n      if (!p || !p.runId) return;\n      slagErrText");
const SLAG_LISTENERS = slagAt < 0 ? '' : worldSrc.slice(slagAt, worldSrc.indexOf('    // Stage 2: WATCH the lead delegate.', slagAt));
A.ok(/slaglog\.record\((r|dead), /.test(SLAG_LISTENERS), 'fixture: world.js\'s SLAG post-mortem listeners are sliced');
// ...and the same listener's PRODUCT CRATE: a run that provably worked (runWorked) ships one to the OUTBOX only when it succeeded
function viaSlag(run) {
  const on = {}, recorded = [], shipped = [];
  const sb = {
    U: { bus: { on: (n, fn) => { on[n] = fn; } } }, floor: null, slagErrText: new Map(), runWork: new Map(), liveRunOrder: new Map(), runUsdRecon: new Map(),
    runKey: p => p.runId, runWorked: () => true, shipProductCrate: p => shipped.push(p.runId), dockWorkForRun: () => null, lineOfWork: () => null, lineNeedsRelease: () => false, RunOutcome: RunOutcome || undefined,
    holdJoinedProduct() {}, productCrateSpec: () => ({}), performance: { now: () => 0 }, lastSlagAt: 0, lastCacheFrac: 0, Friendly: BrowserFriendly,
    slaglog: { record: (reason, info) => { recorded.push({ reason, error: info && info.error }); return {}; } },
    StationUI: { notify() {} }, SlagLog: { line: () => '' }, enqueueSlag() {}
  };
  vm.runInNewContext(SLAG_LISTENERS, sb);
  for (const [name, payload] of wireOf(run)) if (on[name]) on[name](payload);
  const last = recorded.pop();
  return { recorded: !!last, kind: last && last.error ? last.error.kind : null, shipped: shipped.indexOf(run.runId) >= 0 };
}

// ---- the ROUTINES window's own Run Now button: its stream reader and verdict (sliced from the click handler), over the stream the
//      press returns. Review r3: it read only agent.run.error, so a cut, budget or step-limit run toasted "routine ran" in green ----
const btnSrc = read('frontend/app/windows/routines.js');
const btnAt = btnSrc.indexOf('            const reader = resp.body.getReader()');
const BUTTON_SRC = btnAt < 0 ? '' : btnSrc.slice(btnAt, btnSrc.indexOf('\n', btnSrc.indexOf('notify(', btnAt)));
A.ok(/agent\.run\.error/.test(BUTTON_SRC) && /notify\(/.test(BUTTON_SRC), 'fixture: the Run Now button\'s stream reader and verdict are sliced');
async function viaRunNowButton(run) {
  const wire = run.events.slice();
  // (handleCronRun's catch emitted the thrown run's error here before run-table S2; runOnce's belt now ends it on the stream itself)
  const bytes = new TextEncoder().encode(wire.map(([name, payload]) => JSON.stringify({ name, payload })).join('\n') + '\n');
  let sent = false;
  const reader = { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } };
  const ob = { innerHTML: '' }, toasts = [];
  await new Function('resp', 'TextDecoder', 'ob', 'esc', 'notify', 'RunOutcome', 'return (async () => {\n' + BUTTON_SRC + '\n})();')(
    { body: { getReader: () => reader } }, TextDecoder, ob, v => String(v == null ? '' : v), (m, k) => toasts.push([m, k]), RunOutcome || undefined);
  const t = toasts.pop() || [];
  return { toast: t[0], kind: t[1], html: ob.innerHTML };
}

// ---- a BUILD QUEST (frontend/app/workqueststore.js, in a page-shaped context): a bound build completes only on a succeeded run ----
const BUILD_SRC = ['frontend/app/workquests.js', 'frontend/app/slaglog.js', 'frontend/app/workqueststore.js'].map(read).join('\n;\n') + '\nthis.__S = WorkQuestStore;';
function viaBuildQuest(run) {
  const on = {}, notes = [], kept = {};
  const sb = { console, Date, Math, JSON,
    localStorage: { getItem: k => (k in kept ? kept[k] : null), setItem: (k, v) => { kept[k] = String(v); }, removeItem: k => { delete kept[k]; } },
    Recipes: { get: () => null, requiredMissing: () => [] }, Xp: { applyEvent() {} }, XpStore: { onEvent() {} },
    U: { bus: { emit() {}, on: (n, fn) => { (on[n] = on[n] || []).push(fn); } } }, StationUI: { rerender() {}, notify: (t, c) => notes.push([t, c]) },
    Friendly: BrowserFriendly, RunOutcome: RunOutcome || undefined };
  sb.globalThis = sb; vm.createContext(sb);
  vm.runInContext(BUILD_SRC, sb);
  const S = sb.__S;
  S.init();
  const id = S.accept({ title: 'the price watcher', build: { kind: 'workflow', recipeId: null } });
  for (const [name, payload] of wireOf(run)) for (const fn of (on[name] || [])) fn(payload);
  const q = S.quests().find(x => x.id === id) || {};
  return { status: q.status, beat: notes.map(n => n[0]).join(' | ') };
}

// ---- the AWAY BRIEFING (sidecar/away-briefing.js): the routine run's own history row, briefed as a routine that ran while away ----
// the routine records the host hands the briefing (sliced from index.js awayBriefingInputs; review 5.2: with its last fire's outcome)
const AWAY_JOBS = (readSidecarIndex().replace(/\r\n/g, '\n').split('\n').find(l => /^\s*const jobs = \(cronJobs \|\| \[\]\)\.map\(j => \(\{ id: j && j\.id, name: j && j\.name/.test(l)) || '').trim();
A.ok(AWAY_JOBS.length > 0, 'fixture: the away briefing\'s routine records are sliced from awayBriefingInputs');
// review 5.3: `hops` are the fire's work-line stages, as the runstore keeps them — on the fire's own stream ('cron-<its runId>'), with no
// cronJobId (index.js's hop runOnce passes none), each with its own handoff prompt as its title
function viaAway(row, job, hops) {
  const r = Object.assign({}, row, { streamId: 'cron-' + (row.runId || 'x'), cronJobId: 'j1', surface: 'autonomous', ts: 5, endedAt: 5, title: 'do it' });
  const stages = (hops || []).map((h, i) => Object.assign({ turns: 1, usd: 0 }, h, { streamId: r.streamId, surface: 'autonomous', ts: 6 + i, endedAt: 6 + i }));
  const jobs = new Function('cronJobs', AWAY_JOBS + '\nreturn jobs;')([Object.assign({}, job || {}, { id: 'j1', name: 'digest' })]);
  const out = AwayBriefing.compose({ since: 1, now: 9, tzOffsetMin: 0, runs: [r].concat(stages), builds: [], drafts: [], jobs, loops: [] });
  return { failed: out.counts ? out.counts.failed : null, unfinished: out.counts ? out.counts.unfinished : null, stopped: out.counts ? out.counts.stopped : null, routines: out.counts ? out.counts.routines : null, text: out.text };
}
// review 6.2: the briefing over SEVERAL fires of the routine (each its own entry row on its own stream), oldest first
function viaAwayFires(rows, job) {
  const runs = rows.map((row, i) => Object.assign({}, row, { streamId: 'cron-' + (row.runId || 'x'), cronJobId: 'j1', surface: 'autonomous', ts: 5 + i, endedAt: 5 + i, title: 'do it' }));
  const jobs = new Function('cronJobs', AWAY_JOBS + '\nreturn jobs;')([Object.assign({}, job || {}, { id: 'j1', name: 'digest' })]);
  const out = AwayBriefing.compose({ since: 1, now: 9 + rows.length, tzOffsetMin: 0, runs, builds: [], drafts: [], jobs, loops: [] });
  return { failed: out.counts ? out.counts.failed : null, unfinished: out.counts ? out.counts.unfinished : null, stopped: out.counts ? out.counts.stopped : null, routines: out.counts ? out.counts.routines : null, text: out.text };
}

// ---- a GROUP-CHAT TURN (sidecar/group-sessions.js): a participant's run replays the station's run ----
async function viaGroup(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-group-'));
  let seq = 0;
  try {
    const api = makeGroupSessions({ fs, path, root, now: () => ++seq, id: () => 'g' + (++seq), log: () => {},
      roster: () => [{ id: 'agent', name: 'Lead' }, { id: 'research', name: 'Researcher' }],
      execute: async o => { replay(run, o.emit, o.runId, 'agent'); if (run.throws) throw new Error('boom'); return run.result; },
      readFile: async () => null, decodeFile: () => null, uploadFile: () => null });
    await api.ready;
    const g = await api.create({ members: ['agent', 'research'] });
    await api.send(g.id, { key: 'k', text: 'go' });
    await api.idle(g.id);
    const st = await api.get(g.id);
    const turn = (st.turns || []).at(-1) || {};
    const said = (st.messages || []).filter(m => m.author !== 'user').at(-1);
    return { state: turn.state, partial: !!(said && said.partial) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---- channels: the real hub, with a runOnce that replays the station's run ----
async function viaChannel(run) {
  const sends = [], events = [];
  const hist = new Map();
  const store = { loadHistory: a => (hist.get(a) || []).slice(), appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; }, getChatRecord() { return undefined; } };
  let n = 0;
  const hub = makeChannelHub({
    runOnce: async o => { replay(run, o.emit, o.runId, o.agentId); if (run.throws) throw new Error('boom'); },
    store, send: (chatId, text) => { sends.push(text); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); },
    secrets: () => ({ key: 'k', model: 'x/y' }), classify: () => false, emit: (name, p) => events.push({ name, p }), newId: () => 'run' + (++n)
  });
  await hub.onInbound({ channel: 'telegram', chatId: '555', chatType: 'dm', userId: 'u1', text: 'go', messageId: '1', ts: 1 });
  const d = events.find(e => e.name === 'channel.delivery');
  return { reason: d ? d.p.reason : '(no delivery)', text: sends.join('\n') };
}

// ---- routines: the real cron driver (one due job), and the real notifier fed by its cron.result ----
async function viaRoutine(run, line) {
  const T0 = 1700000000000;
  let now = T0;
  // a routine that ran fine an hour ago: this fire's record must replace that ok (a transient failure backs off to retry and
  // leaves lastRunAt at the earlier run, so a first-ever fire's card would read "never run")
  const job = Object.assign(cronStore.makeJob({ id: 'j1', prompt: 'do it', agentId: 'cron_j1', schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 }),
    { lastRunAt: new Date(T0 - 3600000).toISOString(), lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded' });
  let store = [job];
  const events = [];
  const crates = [];   // the reason the fire settles its conveyor crate with (index.js settleCronWorkitem: 'done' = delivered to the OUTBOX)
  let n = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: j => { store = j; return true; },
    runOnce: o => new Promise((resolve, reject) => { replay(run, o.emit, o.runId, o.agentId); if (run.throws) reject(new Error('boom')); else resolve(); }),
    advanceChain: line ? () => Promise.resolve(line) : undefined,   // the routine's work line, when the case gives one
    placeWorkitem: () => {}, settleWorkitem: (rid, reason) => crates.push(reason),
    emit: (name, payload) => events.push({ name, payload }), newId: () => 'cr-' + (++n), newAbort: () => new AbortController(),
    now: () => now, getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000
  });
  now = T0 + 60000;
  driver.applyTick(now);
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  const settled = cronStore.getJob(store, 'j1');
  const result = events.filter(e => e.name === 'cron.result').map(e => e.payload).pop() || null;
  const pings = [];
  const notifier = makeAutoNotifier({ send: (chatId, text) => { pings.push(text); return Promise.resolve(); }, chatsFor: () => [{ chatId: 'c', channel: 'telegram' }], jobName: () => 'do it', jobAgent: () => 'cron_j1' });
  if (result) notifier.onEvent('cron.result', result);
  return { status: settled && settled.lastStatus, cronOutcome: result && result.outcome, cronReason: result && result.reason, runOutcome: result && result.runOutcome, pinged: pings.length > 0, job: settled, crate: crates.length ? crates[0] : '(never settled)', result };
}

// ---- Run Now: the button's own settlement (sidecar/index.js handleCronRun) — its tee sink, and the catch + finally it runs after
//      runOnce (its pre-settle over cron-driver fireOutcome, the work-line gate, the shared durable settlement through the real
//      driver's settleRun), sliced whole; its runOnce replays the run. Review r2: it once wrote its own incomplete-run sentence
//      back as the run's error, so the settlement read a provider-cut reply as failed / run_failure ----
const RUN_NOW_SRC = sidecarTopLevelFunction('handleCronRun');
const runNowSinkAt = RUN_NOW_SRC.indexOf("  const state = { buf: '', errMsg: null");
const RUN_NOW_SINK = runNowSinkAt < 0 ? '' : RUN_NOW_SRC.slice(runNowSinkAt, RUN_NOW_SRC.indexOf("  try { cronEmit('cron.fire'", runNowSinkAt));
const runNowSettleAt = RUN_NOW_SRC.indexOf("  } catch (e) {\n    state.errMsg = state.errMsg || ('sidecar failure: '");
const RUN_NOW_SETTLE = runNowSettleAt < 0 ? '' : RUN_NOW_SRC.slice(runNowSettleAt, RUN_NOW_SRC.lastIndexOf('}'));
A.ok(/const teeEmit = \(name, payload\) => \{/.test(RUN_NOW_SINK), 'fixture: Run Now\'s tee sink is sliced from handleCronRun');
A.ok(/\} finally \{/.test(RUN_NOW_SETTLE) && /cronDriver\.settleRun\(job\.id, runId, state, null\)/.test(RUN_NOW_SETTLE), 'fixture: Run Now\'s catch and finally are sliced, through the shared settlement');
const cronDriverMod = require('../sidecar/cron-driver.js');
const { foldLineIntoFire } = require('../sidecar/routing/line-fire.js');
// Run Now's tee joins its reply the way every reply sink does (channel-delivery-ledger: sidecar/reply-assembler.js)
const { makeReplyAssembler } = require('../sidecar/reply-assembler.js');
const LineRunner = require('../sidecar/routing/line-runner.js');
async function viaRunNow(run, line) {
  const T0 = 1700000000000;
  // the same routine as the scheduled fire's, with an earlier ok run the button's record must replace
  const job = Object.assign(cronStore.makeJob({ id: 'j1', prompt: 'do it', agentId: 'cron_j1', schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 }),
    { lastRunAt: new Date(T0 - 3600000).toISOString(), lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded' });
  let store = [job];
  const events = [], crates = [];   // the shared driver settles the whole fire, including its crate
  const cronDriver = makeCronDriver({
    getJobs: () => store, setJobs: j => { store = j; return true; }, runOnce: () => Promise.resolve(),
    settleWorkitem: (rid, reason) => crates.push(reason),
    emit: (name, payload) => events.push({ name, payload }), newId: () => 'cr-x', newAbort: () => new AbortController(),
    now: () => T0 + 60000, getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000
  });
  const runId = 'rn-' + run.kind, ac = new AbortController();
  cronDriver.leases.set(job.id, { runId, startedAt: T0, heartbeatAt: T0, ac, isOnce: false });   // handleCronRun's manual lease
  const runReplay = async emit => { replay(run, emit, runId, job.agentId); if (run.throws) throw new Error('boom'); };
  const table = require('../sidecar/run-table.js').makeRunTable();
  // the line runs through the ONE hop executor (line-job-runner): its runLineJob answers the line; the profile's seams are stubs
  const press = new Function('job', 'runId', 'ac', 'emit', 'cronDriver', 'cronDriverMod', 'lineRunner', 'LineRunner', 'cronHopConfigFor', 'cronSystemFor', 'hopStoppedSaid', 'hopStoppedByYou', 'foldLineIntoFire', 'router', 'assembledPrompt',
    'runs', 'settleCronWorkitem', 'failNote', 'dropSteer', 'kaOff', 'lines', 'runReplay', 'StopReason', 'RunOutcome', 'makeReplyAssembler', 'runNowRun', 'cronItems',
    'return async function () {\n' + RUN_NOW_SINK + '  try {\n    await runReplay(teeEmit);\n' + RUN_NOW_SETTLE + '};');
  await press(job, runId, ac, () => {}, cronDriver, cronDriverMod, { runLineJob: async () => line || null }, LineRunner, () => ({}), () => '', () => 'stopped by you', () => false, foldLineIntoFire, {}, 'do it',
    new Map(), (rid, reason) => crates.push(reason), () => {}, () => {}, () => {}, { end() {} }, runReplay, StopReason, RunOutcome || undefined, makeReplyAssembler, table.admit({ runId, agentId: job.agentId, source: 'cron' }), new Map())();
  A.eq(table.size(), 0, 'Run Now releases its exact admission');
  const settled = cronStore.getJob(store, 'j1');
  const result = events.filter(e => e.name === 'cron.result').map(e => e.payload).pop() || null;
  return { status: settled && settled.lastStatus, cronOutcome: result && result.outcome, cronReason: result && result.reason, job: settled, crate: crates.length ? crates[0] : '(never settled)' };
}

// ---- review r7: a routine the Commander PAUSES while its fire runs — the real driver and the real store, the pause landing mid-run
//      exactly as handleCronUpdate / remote setRoutine write it (pauseJob first, then the lease's abort), and the driver's own delivery
//      captured. priorFailures seeds the routine's streak (four in a row: the next counted failure auto-pauses it) ----
async function viaPausedMidRun(run, priorFailures) {
  const T0 = 1700000000000;
  let now = T0;
  const job = Object.assign(cronStore.makeJob({ id: 'j1', name: 'digest', prompt: 'do it', agentId: 'cron_j1', schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 }),
    { lastRunAt: new Date(T0 - 3600000).toISOString(), lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded', consecutiveFailures: priorFailures || 0 });
  let store = [job];
  const events = [], delivered = [];
  let n = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: j => { store = j; return true; },
    runOnce: o => new Promise(resolve => { store = cronStore.pauseJob(store, 'j1'); replay(run, o.emit, o.runId, o.agentId); resolve(); }),
    placeWorkitem: () => {}, settleWorkitem: () => {}, deliverResult: (j, r) => { delivered.push(r); return Promise.resolve({ ok: true }); },
    emit: (name, payload) => events.push({ name, payload }), newId: () => 'pm-' + (++n), newAbort: () => new AbortController(),
    now: () => now, getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000
  });
  now = T0 + 60000;
  driver.applyTick(now);
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  const settled = cronStore.getJob(store, 'j1');
  return { job: settled, held: cronStore.deliveriesHeld(settled), delivered, result: events.filter(e => e.name === 'cron.result').map(e => e.payload).pop() || null };
}
// ---- review 7.1: RUN NOW on a routine the Commander had ALREADY paused (the ROUTINES button stays live on a paused routine) — handleCronRun's
//      own manual lease (sliced: what the press records about the routine it started on), its tee sink and its catch + finally through the
//      real driver's settleRun, and the driver's own delivery captured. pausedBefore false: a press on a live routine that the Commander
//      pauses while it runs (pauseJob lands first, as the panel writes it) — that one's result waits for the resume ----
const RUN_NOW_LEASE = (/\n  cronDriver\.leases\.set\(job\.id, \{ runId: runId,[^\n]*\);/.exec(RUN_NOW_SRC) || [''])[0];
A.ok(/cronDriver\.leases\.set\(job\.id, \{ runId: runId,/.test(RUN_NOW_LEASE), 'fixture: Run Now\'s manual lease is sliced from handleCronRun');
async function viaPausedRunNow(run, pausedBefore) {
  const T0 = 1700000000000;
  const job0 = Object.assign(cronStore.makeJob({ id: 'j1', name: 'digest', prompt: 'do it', agentId: 'cron_j1', schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 }),
    { lastRunAt: new Date(T0 - 3600000).toISOString(), lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded' });
  let store = pausedBefore ? cronStore.pauseJob([job0], 'j1') : [job0];
  const events = [], delivered = [];
  const cronDriver = makeCronDriver({
    getJobs: () => store, setJobs: j => { store = j; return true; }, runOnce: () => Promise.resolve(),
    deliverResult: (j, r) => { delivered.push(r); return Promise.resolve({ ok: true }); },
    emit: (name, payload) => events.push({ name, payload }), newId: () => 'cr-x', newAbort: () => new AbortController(),
    now: () => T0 + 60000, getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000
  });
  const job = cronStore.getJob(store, 'j1');
  const runId = 'rnp-' + run.kind, ac = new AbortController();
  try { new Function('cronDriver', 'cronStore', 'job', 'runId', 'ac', RUN_NOW_LEASE)(cronDriver, cronStore, job, runId, ac); }
  catch (e) { return { job: cronStore.getJob(store, 'j1'), delivered, result: null, threw: String((e && e.message) || e) }; }
  const runReplay = async emit => { if (!pausedBefore) store = cronStore.pauseJob(store, 'j1'); replay(run, emit, runId, job.agentId); };
  const table = require('../sidecar/run-table.js').makeRunTable();
  const press = new Function('job', 'runId', 'ac', 'emit', 'cronDriver', 'cronDriverMod', 'lineRunner', 'LineRunner', 'cronHopConfigFor', 'cronSystemFor', 'hopStoppedSaid', 'hopStoppedByYou', 'foldLineIntoFire', 'router', 'assembledPrompt',
    'runs', 'settleCronWorkitem', 'failNote', 'dropSteer', 'kaOff', 'lines', 'runReplay', 'StopReason', 'RunOutcome', 'makeReplyAssembler', 'runNowRun', 'cronItems',
    'return async function () {\n' + RUN_NOW_SINK + '  try {\n    await runReplay(teeEmit);\n' + RUN_NOW_SETTLE + '};');
  await press(job, runId, ac, () => {}, cronDriver, cronDriverMod, { runLineJob: async () => null }, LineRunner, () => ({}), () => '', () => 'stopped by you', () => false, foldLineIntoFire, {}, 'do it',
    new Map(), () => {}, () => {}, () => {}, () => {}, { end() {} }, runReplay, StopReason, RunOutcome || undefined, makeReplyAssembler, table.admit({ runId, agentId: job.agentId, source: 'cron' }), new Map())();
  A.eq(table.size(), 0, 'Run Now releases its exact admission');
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  const settled = cronStore.getJob(store, 'j1');
  return { job: settled, delivered, result: events.filter(e => e.name === 'cron.result').map(e => e.payload).pop() || null };
}
// ---- review r7: the routine's DELIVERY headline (deliverCronResult, sliced: sidecar/routine-delivery.js since channel-delivery-ledger S1
//      moved it out of sidecar/index.js) over the result its finalization hands on, to a routine that returns to its origin session
//      (station.deliver) ----
const DELIVER_SRC = functionSourceIn(read('sidecar/routine-delivery.js'), 'deliverCronResult') || sidecarTopLevelFunction('deliverCronResult');
A.ok(/station\.deliver/.test(DELIVER_SRC), 'fixture: deliverCronResult is sliced from the sidecar');
async function viaDelivery(job, result) {
  let said = null;
  const deliver = new Function('cronSupersededNote', 'transcriptStore', 'failNote', 'cronReturnsToSession', 'stationBridge', 'redact', 'RunOutcome', 'TurnKinds', 'now',
    DELIVER_SRC + '\nreturn deliverCronResult;')(() => '', { view: () => [], append: () => {} }, () => {}, () => true,
    { request: (name, p) => { said = p.text; return Promise.resolve({ ok: true }); } }, x => x, RunOutcome || undefined, require('../frontend/app/turnkinds.js'), () => 1700000000000);
  await deliver(Object.assign({}, job, { name: 'digest', deliver: 'local', origin: { sessionId: 's1', streamId: 's1' } }), result);
  return said;
}

// ---- the ROUTINES window: its card's last-run cell over the job the driver settled, and the RUN HISTORY line over the run's
//      history row as GET /api/cron/history hands it over (frontend/app/windows/routines.js; handleCronHistory from the sidecar) ----
const routinesSrc = read('frontend/app/windows/routines.js');
// (review 9.3: recordOutcome, the card's reading of a record a pre-lane station settled)
const WINDOW_FNS = ['failedAs', 'endMark', 'recordOutcome', 'lastResult', 'historyLine'].map(n => functionSourceIn(routinesSrc, n)).filter(Boolean).join('\n');
A.ok(/function lastResult/.test(WINDOW_FNS) && /function historyLine/.test(WINDOW_FNS), 'fixture: the ROUTINES card cell and RUN HISTORY line are sliced');
const HISTORY_SRC = sidecarTopLevelFunction('handleCronHistory');
A.ok(/runStore\.all\(\)/.test(HISTORY_SRC), 'fixture: handleCronHistory is sliced from the sidecar');
const statusText = html => { const m = /<span[^>]*>([^<]*)<\/span>/.exec(String(html || '')); return m ? m[1] : '(none)'; };
function viaWindow(job, row) {
  const fns = new Function('esc', 'fmtRel', 'RunOutcome', WINDOW_FNS + '\nreturn { lastResult, historyLine };')(v => String(v == null ? '' : v), () => 'just now', RunOutcome || undefined);
  let body = '';
  const history = new Function('cronStore', 'cronJobs', 'runStore', HISTORY_SRC + '\nreturn handleCronHistory;')(cronStore, [job], { all: () => [Object.assign({}, row, { cronJobId: job.id })] });
  history({ url: '/api/cron/history?id=' + job.id }, { writeHead() {}, end(b) { body = b; } });
  const runs = (JSON.parse(body || '{}').runs) || [];
  return { card: statusText(fns.lastResult(job)), history: runs.length ? statusText(fns.historyLine(runs[0])) : '(no history row)' };
}
// review 6.2: a routine's RUN HISTORY over SEVERAL fires' rows (oldest first, as the runstore keeps them), each line by its runId
function viaHistory(job, rows) {
  const fns = new Function('esc', 'fmtRel', 'RunOutcome', WINDOW_FNS + '\nreturn { lastResult, historyLine };')(v => String(v == null ? '' : v), () => 'just now', RunOutcome || undefined);
  let body = '';
  const history = new Function('cronStore', 'cronJobs', 'runStore', HISTORY_SRC + '\nreturn handleCronHistory;')(cronStore, [job], { all: () => rows.map(r => Object.assign({}, r, { cronJobId: job.id })) });
  history({ url: '/api/cron/history?id=' + job.id }, { writeHead() {}, end(b) { body = b; } });
  const out = {};
  for (const r of (JSON.parse(body || '{}').runs) || []) out[r.runId] = statusText(fns.historyLine(r));
  return out;
}
// review 6.2: the routine's NEXT fire — the real driver over the same record, the run replayed as its entry run
async function fireAgain(job, run) {
  const at = Math.max(Date.parse(job.nextRunAt || '') || 0, 1700000180000);
  let store = [job];
  let n = 0;
  const driver = makeCronDriver({ getJobs: () => store, setJobs: j => { store = j; return true; },
    runOnce: o => new Promise(resolve => { replay(run, o.emit, o.runId, o.agentId); resolve(); }),
    placeWorkitem: () => {}, settleWorkitem: () => {}, emit: () => {}, newId: () => 'again-' + (++n), newAbort: () => new AbortController(),
    now: () => at, getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000 });
  driver.applyTick(at);
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  return cronStore.getJob(store, job.id);
}

// ---- /v1: the real OpenAI-compatible surface over HTTP ----
let v1Scenario = null;
const v1 = makeOpenAiCompat({ now: () => 1000, newId: (() => { let i = 0; return () => 'v' + (++i); })(), apiKey: () => 'outcome-roundtrip-key-123456',
  readBody: async req => { let s = ''; for await (const c of req) s += c; return s; },
  runOnce: o => { const run = v1Scenario; replay(run, o.emit, o.runId); if (run.throws) return Promise.reject(new Error('boom')); return Promise.resolve(); } });
const v1Server = http.createServer((req, res) => v1.handle(req, res));
const v1Headers = { Authorization: 'Bearer outcome-roundtrip-key-123456', 'Content-Type': 'application/json' };
async function viaV1(run, base) {
  v1Scenario = run;
  const started = await (await fetch(base + '/v1/runs', { method: 'POST', headers: v1Headers, body: JSON.stringify({ input: 'go' }) })).json();
  await (await fetch(base + '/v1/runs/' + started.run_id + '/events', { headers: v1Headers })).text();   // the stream closes on the terminal event
  const state = await (await fetch(base + '/v1/runs/' + started.run_id, { headers: v1Headers })).json();
  let finish = null;
  if (V1_FINISH[run.kind]) {
    const res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: v1Headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }) });
    const j = await res.json();
    finish = res.status === 200 ? j.choices[0].finish_reason : 'http ' + res.status;
  }
  return { status: state.status, finish };
}

// ---- ACP: the real core, fed by the bridge's REAL openRun (sidecar/acp/serve.js) reading /api/run off a loopback station ----
// serve.js is the bridge's stdio composition root: required in-process it would take this test's stdin (and exit 0 when that
// closes), so it is evaluated with a stand-in process — its own code, its own openRun, a station at the port given here.
const SERVE_SRC = (sidecarSourceFiles().find(f => f.rel === 'sidecar/acp/serve.js') || {}).text || '';
A.ok(/_internals: \{[^}]*openRun/.test(SERVE_SRC), 'fixture: sidecar/acp/serve.js exports its openRun');
let acpScenario = null;
const acpStation = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* drain the request body */ }
  if (req.method === 'GET' && req.url === '/api/runtime/agent') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ configured: true, model: 'm', provider: 'openrouter' })); return; }
  if (req.method === 'POST' && req.url === '/api/run') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(wireOf(acpScenario).map(([name, payload]) => JSON.stringify({ name, payload })).join('\n') + '\n');
    return;
  }
  res.writeHead(404); res.end();
});
let bridgeOpenRun = null;
function loadBridge(port) {
  const mod = { exports: {} };
  const standIn = { argv: ['node', 'serve.js', '--host=127.0.0.1', '--port=' + port, '--token=outcome-roundtrip'], env: {},
    stdin: { setEncoding() {}, on() {} }, stdout: { write: () => true }, stderr: { write: () => true }, exit() {} };
  const dir = path.join(ROOT, 'sidecar', 'acp');
  const req = rel => (rel.startsWith('./') ? require(path.join(dir, rel)) : require(rel));
  new Function('require', 'module', 'exports', 'process', '__dirname', '__filename', SERVE_SRC.replace(/^#![^\n]*/, ''))(req, mod, mod.exports, standIn, dir, path.join(dir, 'serve.js'));
  return mod.exports._internals.openRun;
}
async function viaAcp(run) {
  const notes = [];
  acpScenario = run;
  const core = makeAcpCore({
    callSidecar: () => Promise.resolve({ ok: true, status: 200, json: {} }),
    openRun: o => bridgeOpenRun(o),
    notify: (method, params) => { if (params && params.update && params.update.content && params.update.content.text) notes.push(params.update.content.text); },
    request: () => Promise.resolve({ outcome: { outcome: 'selected', optionId: 'once' } }),
    newId: (() => { let i = 0; return () => 'id' + (++i); })(), version: () => '9.9.9', log: () => {}
  });
  const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  await core.handleRpc(rpc(1, 'initialize', { protocolVersion: 1 }));
  const s = await core.handleRpc(rpc(2, 'session/new', { cwd: ROOT, mcpServers: [] }));
  const r = await core.handleRpc(rpc(3, 'session/prompt', { sessionId: s.result.sessionId, prompt: [{ type: 'text', text: 'go' }] }));
  return { stopReason: r.result && r.result.stopReason, text: notes.join('') };
}

// ---- the terminal: the real run tracker, and the exit-code call bin/starnet.js really makes ----
const starnetSrc = read('bin/starnet.js');
const exitCall = /core\.exitCodeForReason\(summary\.reason, (\{[^}]*\})\)/.exec(starnetSrc);
A.ok(!!exitCall, 'fixture: bin/starnet.js decides the exit code with core.exitCodeForReason(summary.reason, …)');
function viaCli(run) {
  const t = CliCore.makeRunTracker();
  const wire = wireOf(run);
  for (const [name, payload] of wire) t.feed({ name, payload });
  const summary = t.summary();
  const opts = new Function('summary', 'return (' + exitCall[1] + ');')(summary);
  return { ok: summary.ok, exit: CliCore.exitCodeForReason(summary.reason, opts) };
}

// ---- the run history: the row runOnceCore records (fields lifted from its record call), the phone, the track record ----
function liftProp(src, name) {
  const m = new RegExp('[{,]\\s*' + name + ': ').exec(src);
  if (!m) return '';
  let i = m.index + m[0].length, depth = 0, quote = '';
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ('([{'.indexOf(c) >= 0) depth++;
    else if (')]}'.indexOf(c) >= 0) { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return src.slice(start, i).trim();
}
const recordAt = CORE.indexOf('runStore.record({ runId, parentRunId');
A.ok(recordAt > 0, 'fixture: runOnceCore records the run-history row');
const RECORD_CALL = CORE.slice(recordAt, CORE.indexOf('\n', recordAt));
const ROW_FIELDS = ['reason', 'clarifying', 'failureStage', 'failureCode', 'finishReason', 'outcome'].map(k => [k, liftProp(RECORD_CALL, k)]).filter(x => x[1]);
// the statements that record the run's failure before the row is written (each one runOnceCore holds)
const FAILURE_LINES = (CORE.match(/^\s*if \([^\n]*\) execution\.recordFailure\([^\n]*\);[^\n]*$/gm) || []).map(l => l.replace(/\/\/[^\n]*$/, '').trim());
A.ok(FAILURE_LINES.length >= 1, 'fixture: runOnceCore records a failing run\'s stage and code (' + FAILURE_LINES.length + ' statements)');
const indexSrc = readSidecarIndex().replace(/\r\n/g, '\n');
const storeAt = indexSrc.indexOf('const runStore = makeRunStore({');
const STORE_CALL = indexSrc.slice(storeAt, indexSrc.indexOf('});', storeAt) + 3);
const OUTCOME_OF = liftProp(STORE_CALL, 'outcomeOf');
function historyRow(run) {
  const execution = makeRunExecutionState({});
  const result = run.result;
  for (const line of FAILURE_LINES) new Function('result', 'execution', 'RunOutcome', line)(result, execution, RunOutcome);
  const scope = { result, execution, taskQuestionAsked: run.taskQuestionAsked };
  const fields = { runId: run.runId, agentId: 'agent', ts: 5 };
  for (const [k, expr] of ROW_FIELDS) fields[k] = new Function(...Object.keys(scope), 'return (' + expr + ');')(...Object.values(scope));
  const outcomeOf = OUTCOME_OF ? new Function('endedOutcomes', 'return (' + OUTCOME_OF + ');')(run.endedOutcomes) : undefined;
  const store = makeRunStore({ io: { readAll: () => [], append() {} }, clock: { now: () => 5 }, outcomeOf });
  return store.record(fields);
}
async function viaPhone(row) {
  const host = makeRemoteHost({ now: () => 10, liveRuns: () => [], roster: () => [], runHistory: () => [row], transcript: { history: () => [] }, broadcast() {} });
  const a = await host.activity({ limit: 5 });
  const r = a.done[0] || {};
  return { state: r.state, error: r.error };
}
function viaTrack(row) {
  const f = TrackRecord.fold([Object.assign({}, row, { ts: 5, streamId: 'cron-x' })], { now: 10 });
  const k = f.keys && f.keys['lane:scheduled'];
  return !k ? 'skip' : (k.ok ? 'ok' : 'fail');
}

// ================================================= THE LEDGER ==========================================================
const ledger = new Map();   // surface -> [{ ok, why }]
function check(surface, kind, ok, why) {
  if (!ledger.has(surface)) ledger.set(surface, []);
  ledger.get(surface).push({ ok: !!ok, why: kind + ': ' + why });
  A.ok(ok, surface + ' / ' + kind + ': ' + why);
}

(async () => {
  await new Promise(r => v1Server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + v1Server.address().port;
  await new Promise(r => acpStation.listen(0, '127.0.0.1', r));
  bridgeOpenRun = loadBridge(acpStation.address().port);
  try {
    for (const kind of CASES) {
      const [outcome, code] = ORACLE[kind];
      const run = await stationRun(kind);
      if (!run.throws && kind !== 'asked' && kind !== 'noend' && kind !== 'delegatedNoEnd') A.ok(run.result && typeof run.result.reason === 'string', 'fixture: the real loop ended ' + kind + ' (' + (run.result && run.result.reason) + ')');

      // COMMS
      const comms = await viaComms(run);
      if (COMMS_KIND[kind] === null) {
        check('COMMS', kind, comms.errorKind === null && comms.chip === CHIP[kind], 'no error row, and the board chip reads ' + JSON.stringify(CHIP[kind]) + ' (DONE only for a succeeded run; got ' + JSON.stringify(comms) + ')');
      } else if (COMMS_KIND[kind] === 'any') {
        check('COMMS', kind, !!comms.errorKind && comms.errorKind !== 'none', 'the page shows an error row (got ' + comms.errorKind + ')');
      } else {
        check('COMMS', kind, comms.errorKind === COMMS_KIND[kind], 'the error row reads as ' + COMMS_KIND[kind] + ' (got ' + comms.errorKind + (comms.words ? ': ' + comms.words.slice(0, 120) : '') + ')');
        if (kind === 'template' || kind === 'unreachable') check('COMMS', kind, !/try again\.?$|went wrong/i.test(comms.words || ''), 'never "Something went wrong — try again"');
      }

      // the SLAG post-mortem names the same cause COMMS does, for a run that failed on the provider's own error; the same listener
      // ships a product crate to the OUTBOX only for a run that SUCCEEDED (a cut reply is never a delivered product)
      const slag = viaSlag(run);
      if (PROVIDER_ERROR[kind]) check('SLAG post-mortem', kind, slag.recorded && slag.kind === COMMS_KIND[kind], 'the post-mortem reads ' + COMMS_KIND[kind] + ', as COMMS does (got ' + (slag.recorded ? slag.kind : 'no post-mortem') + ')');
      check('floor crate', kind, slag.shipped === (outcome === 'succeeded'), (outcome === 'succeeded' ? 'ships its product crate' : 'never ships a product crate') + ' (got ' + (slag.shipped ? 'a crate' : 'none') + ')');

      // the ROUTINES window's own Run Now button: its verdict toast reads the run's outcome, as the card it repaints does
      const btn = await viaRunNowButton(run);
      check('Run Now button', kind, (btn.kind === 'good') === (outcome === 'succeeded'), (outcome === 'succeeded' ? 'toasts "routine ran"' : 'never toasts "routine ran" in green') + ' (got ' + JSON.stringify([btn.toast, btn.kind]) + ')');

      // a build quest bound to the run completes only when it succeeded; any other end stalls it
      const bq = viaBuildQuest(run);
      check('build quest', kind, (bq.status === 'done') === (outcome === 'succeeded'), (outcome === 'succeeded' ? 'the build completes' : 'the build never completes') + ' (got ' + bq.status + ')');
      if (kind === 'cut') check('build quest', kind, /cut short/.test(bq.beat), 'the stalled build says the reply was cut short (got ' + JSON.stringify(bq.beat) + ')');

      // a group-chat participant's turn completes only when its run succeeded (a question it asked is still its reply)
      const gt = await viaGroup(run);
      check('group turn', kind, gt.state === (GROUP_STATE[kind] || 'failed'), 'the turn is ' + (GROUP_STATE[kind] || 'failed') + ' (got ' + gt.state + ')');
      if (kind === 'cut') check('group turn', kind, gt.partial === true, 'a cut-short reply is posted as partial (got partial=' + gt.partial + ')');

      // channels
      if (!deferred('channels', kind)) {
      const ch = await viaChannel(run);
      check('channels', kind, ch.reason === CHANNEL_REASON[kind], 'the delivery records ' + CHANNEL_REASON[kind] + ' (got ' + ch.reason + ')');
      if (CHANNEL_SAYS[kind]) check('channels', kind, CHANNEL_SAYS[kind].test(ch.text), 'the reply says ' + CHANNEL_SAYS[kind] + ' (got ' + JSON.stringify(ch.text.slice(-160)) + ')');
      }

      // routines + notifications
      const rt = deferred('routines', kind) ? null : await viaRoutine(run);
      if (rt) {
      const ok = ROUTINE_OK[kind] === true;
      check('routines', kind, rt.status === routineStatus(kind) && rt.cronOutcome === routineResult(kind), 'the routine records ' + (ok ? 'ok' : ROUTINE_STOPPED[kind] ? 'a stop (never a failure)' : 'a failure') + ' (got ' + rt.status + ' / ' + rt.cronOutcome + ')');
      check('routines', kind, (rt.runOutcome || '') === (RunOutcome ? outcome : ''), 'cron.result carries the fire\'s own outcome code ' + outcome + ' (got ' + rt.runOutcome + ')');
      check('routines', kind, rt.cronReason === ROUTINE_REASON[kind] && rt.job.lastReason === ROUTINE_REASON[kind], 'cron.result and the record name its end ' + ROUTINE_REASON[kind] + ' (got ' + rt.cronReason + ' / ' + rt.job.lastReason + ')');
      check('notifications', kind, rt.pinged === ok, ok ? 'pings "ran on its own"' : 'never pings "ran on its own" (got a ping)');
      check('routines', kind, rt.job.lastOutcome === outcome && (rt.job.lastFailureCode || '') === code, 'the record keeps the run\'s outcome ' + outcome + (code ? ' / ' + code : '') + ' (got ' + rt.job.lastOutcome + ' / ' + (rt.job.lastFailureCode || '-') + ')');
      // the conveyor crate (review 4.1): delivered to the OUTBOX only for a fire that succeeded — a cut, raised or endless run drains
      check('routines', kind, (rt.crate === 'done') === ok, 'its crate is ' + (ok ? 'delivered' : 'drained, never delivered') + ' (settled with ' + JSON.stringify(rt.crate) + ')');
      }

      // Run Now: the button settles the run exactly as the schedule does
      // a slice that throws (a free identifier a rebase adds to handleCronRun's finally) is one failed row, never the whole table
      let rn = null;
      if (!deferred('Run Now', kind)) { try { rn = await viaRunNow(run); } catch (e) { check('Run Now', kind, false, 'the press threw: ' + ((e && e.message) || e)); } }
      if (rn) {
        const ok = ROUTINE_OK[kind] === true;
        check('Run Now', kind, rn.status === routineStatus(kind) && rn.cronOutcome === routineResult(kind), 'the routine records ' + (ok ? 'ok' : ROUTINE_STOPPED[kind] ? 'a stop (never a failure)' : 'a failure') + ' (got ' + rn.status + ' / ' + rn.cronOutcome + ')');
        check('Run Now', kind, rn.cronReason === ROUTINE_REASON[kind] && rn.job.lastReason === ROUTINE_REASON[kind], 'cron.result and the record name its end ' + ROUTINE_REASON[kind] + ' (got ' + rn.cronReason + ' / ' + rn.job.lastReason + ')');
        check('Run Now', kind, rn.job.lastOutcome === outcome && (rn.job.lastFailureCode || '') === code, 'the record keeps the run\'s outcome ' + outcome + (code ? ' / ' + code : '') + ' (got ' + rn.job.lastOutcome + ' / ' + (rn.job.lastFailureCode || '-') + ')');
        check('Run Now', kind, (rn.crate === 'done') === ok, 'its crate is ' + (ok ? 'delivered' : 'drained, never delivered') + ' (settled with ' + JSON.stringify(rn.crate) + ')');
      }

      // /v1
      const v = await viaV1(run, base);
      check('/v1', kind, v.status === V1_STATUS[kind], 'status ' + V1_STATUS[kind] + ' (got ' + v.status + ')');
      if (V1_FINISH[kind]) check('/v1', kind, v.finish === V1_FINISH[kind], 'finish_reason ' + V1_FINISH[kind] + ' (got ' + v.finish + ')');

      // ACP
      const acp = await viaAcp(run);
      check('ACP', kind, acp.stopReason === ACP_STOP[kind], 'stopReason ' + ACP_STOP[kind] + ' (got ' + acp.stopReason + ')');
      if (ACP_SAYS[kind]) check('ACP', kind, ACP_SAYS[kind].test(acp.text), 'the editor is told ' + ACP_SAYS[kind] + ' (got ' + JSON.stringify(acp.text.slice(-160)) + ')');
      if (code && code !== 'no_terminal_outcome') check('ACP', kind, !/inside StarNet/.test(acp.text), 'a provider failure (a safety block included) is never "a failure inside StarNet"');

      // the terminal
      const cli = viaCli(run);
      check('CLI', kind, cli.exit === CLI_EXIT[kind] && cli.ok === (outcome === 'succeeded'), 'exit ' + CLI_EXIT[kind] + ', ok=' + (outcome === 'succeeded') + ' (got exit ' + cli.exit + ', ok=' + cli.ok + ')');

      // the Live Doctor (provider failures only: it probes the provider)
      if (DOCTOR[kind]) {
        const st = LiveDoctor.failureState(PROVIDER_ERROR[kind]());
        check('Live Doctor', kind, st === DOCTOR[kind], 'the probe reads ' + DOCTOR[kind] + ' (got ' + st + ')');
      }

      // the run history, the phone, the track record
      const row = historyRow(run);
      const rowCode = row.failureCode || '';
      check('run history', kind, row.outcome === outcome && (!code || rowCode === code), 'the row records ' + outcome + (code ? ' / ' + code : '') + ' (got ' + row.outcome + ' / ' + (rowCode || '-') + ', reason ' + row.reason + ')');
      check('run history', kind, viaTrack(row) === TRACK[kind], 'the track record counts it ' + TRACK[kind] + ' (got ' + viaTrack(row) + ')');
      // the away briefing lists that routine run under Done only when it succeeded
      const away = viaAway(row);
      // review r7: a STOPPED run is briefed as a stop — never a failure (counts.failed, "Waiting on you … failed"), never under Done as "ran"
      if (outcome === 'stopped') check('away briefing', kind, away.failed === 0 && away.stopped === 1 && /“digest” was stopped before it finished/.test(String(away.text || '')) && !/\bran\b|failed/.test(String(away.text || '')),
        'briefed as a stop under Stopped, never as a failure and never as "ran" (got failed=' + away.failed + ', stopped=' + away.stopped + ': ' + JSON.stringify(String(away.text || '').slice(-120)) + ')');
      // review r8: a run that did not FINISH (asked, cut short, a limit, an empty reply, a refusal) is counted and said apart — never a failure, never "ran"
      else if (outcome === 'succeeded') check('away briefing', kind, away.failed === 0 && !away.unfinished, 'briefed as ran (got failed=' + away.failed + ', unfinished=' + away.unfinished + ')');
      else if (outcome === 'failed') check('away briefing', kind, away.failed === 1, 'briefed as a failure, never under Done as "ran" (got failed=' + away.failed + ': ' + JSON.stringify(String(away.text || '').slice(-120)) + ')');
      else check('away briefing', kind, away.failed === 0 && away.unfinished === 1 && !/“digest” (failed|ran)\b/.test(String(away.text || '')), 'briefed as not finishing, never a failure and never "ran" (got failed=' + away.failed + ', unfinished=' + away.unfinished + ': ' + JSON.stringify(String(away.text || '').slice(-120)) + ')');
      // the ROUTINES window: the routine's card and that run's RUN HISTORY line say the same thing
      if (rt && WINDOW_SAYS[kind]) {
        const w = viaWindow(rt.job, row);
        check('ROUTINES window', kind, w.card === WINDOW_SAYS[kind], 'the card reads "' + WINDOW_SAYS[kind] + '" (got "' + w.card + '")');
        check('ROUTINES window', kind, w.history === WINDOW_SAYS[kind], 'the RUN HISTORY line reads "' + WINDOW_SAYS[kind] + '" (got "' + w.history + '")');
      }
      if (rn && WINDOW_SAYS[kind]) {
        const w = viaWindow(rn.job, row);
        check('ROUTINES window', kind, w.card === WINDOW_SAYS[kind] && w.history === WINDOW_SAYS[kind], 'after Run Now the card and that run\'s RUN HISTORY line both read "' + WINDOW_SAYS[kind] + '" (got "' + w.card + '" / "' + w.history + '")');
      }
      const ph = await viaPhone(row);
      check('phone', kind, ph.state === PHONE_STATE[kind], 'state ' + PHONE_STATE[kind] + ' (got ' + ph.state + ')');
      if (PHONE_SAYS[kind]) check('phone', kind, PHONE_SAYS[kind].test(String(ph.error || '')), 'it says ' + PHONE_SAYS[kind] + ' (got ' + JSON.stringify(ph.error) + ')');
    }
    // THE HELD LINE — the 'blocked' outcome's one producer (RunOutcome.ofLine). The entry run finished; its work line reached a reviewer
    // that answered VERDICT: BLOCKED, so the line held the work (chain.js). Review r2: the routine was recorded ok / succeeded, pinged
    // "ran on its own" and its card read "✓ ok". Scheduled and Run Now settle it the same way.
    {
      const run = await stationRun('done');
      const held = { text: 'All done.', hops: [{ agentId: 'reviewer', dockId: 'review' }], stopped: HELD_WHY, blocked: HELD_WHY, usd: 0 };
      const rt = await viaRoutine(run, held);
      let rn = null;
      try { rn = await viaRunNow(run, held); } catch (e) { check('Run Now', 'held', false, 'the press threw: ' + ((e && e.message) || e)); }
      for (const [surface, x] of [['routines', rt], ['Run Now', rn]]) {
        if (!x) continue;
        check(surface, 'held', x.status === 'error' && x.cronOutcome === 'failed', 'a held line is never recorded ok (got ' + x.status + ' / ' + x.cronOutcome + ')');
        check(surface, 'held', x.cronReason === 'blocked' && x.job.lastReason === 'blocked', 'cron.result and the record name a held line blocked, never "done" (got ' + x.cronReason + ' / ' + x.job.lastReason + ')');
        check(surface, 'held', x.job.lastOutcome === 'blocked', 'the record keeps the outcome blocked (got ' + x.job.lastOutcome + ')');
        check(surface, 'held', x.crate !== 'done', 'a held line\'s crate is drained, never delivered to the OUTBOX (settled with ' + JSON.stringify(x.crate) + ')');
        // the fire's entry run carries the fire's runId; it ended clean, so its row reads 'succeeded' (review 5.2: its RUN HISTORY line read
        // "✓ ok", and the away briefing listed the held fire under Done as "ran")
        const entry = Object.assign(historyRow(run), { runId: x.job.lastRunId });
        const w = viaWindow(x.job, entry);
        check('ROUTINES window', 'held', w.card === HELD_SAYS, 'after ' + surface + ' the card reads "' + HELD_SAYS + '" (got "' + w.card + '")');
        check('ROUTINES window', 'held', w.history === HELD_SAYS, 'after ' + surface + ' that fire\'s RUN HISTORY line reads "' + HELD_SAYS + '", as the card does, never "✓ ok" (got "' + w.history + '")');
        const away = viaAway(entry, x.job);
        check('away briefing', 'held', away.failed === 0 && away.unfinished === 1 && /held: the work was not accepted/.test(String(away.text || '')), 'after ' + surface + ' a held fire is briefed as held, never under Done as "ran" (got failed=' + away.failed + ': ' + JSON.stringify(String(away.text || '').slice(-120)) + ')');
        // (review r8: a held fire did not finish — counted unfinished, never failed, never ran)
        // review 5.3: with the line's reviewer hop beside it (its own run succeeded) — the hop grouped as a separate "routine" under Done
        const withHop = viaAway(entry, x.job, [{ runId: 'hop-review', agentId: 'reviewer', reason: 'done', outcome: 'succeeded', title: '[PIPELINE HANDOFF] review the digest', deliveryText: 'VERDICT: blocked - the digest cites no sources.' }]);
        check('away briefing', 'held', withHop.routines === 1 && withHop.failed === 0 && withHop.unfinished === 1 && /held: the work was not accepted/.test(String(withHop.text || '')) && !/\bran\b/.test(String(withHop.text || '')) && !/PIPELINE HANDOFF/.test(String(withHop.text || '')),
          'after ' + surface + ' a held fire\'s reviewer hop is a stage of that fire, never a routine of its own briefed under Done (got routines=' + withHop.routines + ', failed=' + withHop.failed + ': ' + JSON.stringify(String(withHop.text || '').slice(-160)) + ')');
        // review 6.1: then its routine is config-blocked (a missing credential, a channel not connected at tick time) or its schedule marked
        // unfireable. Neither runs a fire, but both cleared lastOutcome beside the held fire's lastRunId, and RUN HISTORY and the briefing
        // fell back to the entry run's 'succeeded' row: "✓ ok" and "ran". The card still names the block (its status is the routine's).
        for (const [mark, card, aMark] of [['block', '✕ blocked_config', 'a block'], ['unfireable', '✕ ' + cronStore.UNFIREABLE_ERROR, 'an unfireable']]) {
          const marked = cronStore.getJob(mark === 'block'
            ? cronStore.markBlockedConfig([x.job], x.job.id, { fingerprint: 'no-model', reason: 'no model is configured', alerted: true }, { now: 1700000120000 })
            : cronStore.markUnfireable([x.job], x.job.id, { now: 1700000120000 }), x.job.id);
          const wm = viaWindow(marked, entry);
          check('ROUTINES window', 'held then ' + mark, marked.lastOutcome == null && wm.card === card && wm.history === HELD_SAYS,
            'after ' + surface + ' and ' + aMark + ' mark the card names the ' + mark + ' ("' + card + '") and the held fire\'s RUN HISTORY line still reads "' + HELD_SAYS + '", never "✓ ok" (got "' + wm.card + '" / "' + wm.history + '")');
          const am = viaAway(entry, marked);
          check('away briefing', 'held then ' + mark, am.failed === 0 && am.unfinished === 1 && /held: the work was not accepted/.test(String(am.text || '')) && !/\bran\b/.test(String(am.text || '')),
            'after ' + surface + ' and ' + aMark + ' mark the held fire is still briefed as held, never under Done as "ran" (got failed=' + am.failed + ': ' + JSON.stringify(String(am.text || '').slice(-120)) + ')');
        }
        // review 6.2: then the routine's NEXT fire runs clean — its normal next event, no block. The record's receipt kept only its LAST fire,
        // so the held fire fell back to its entry run's 'succeeded' row: its RUN HISTORY line read "✓ ok" from the next fire on, and the
        // briefing counted no failure ("“digest” ran 2×."). The record keeps the receipt of each fire that did not succeed (fireReceipts).
        const again = await fireAgain(x.job, run);
        const next = Object.assign(historyRow(run), { runId: again && again.lastRunId });
        const hl = viaHistory(again, [entry, next]);
        check('ROUTINES window', 'held then clean', !!again && again.lastRunId !== x.job.lastRunId && again.lastOutcome === 'succeeded' && hl[x.job.lastRunId] === HELD_SAYS && hl[again.lastRunId] === WINDOW_SAYS.done,
          'after ' + surface + ' and the routine\'s next, clean fire the held fire\'s RUN HISTORY line still reads "' + HELD_SAYS + '" and the clean one "' + WINDOW_SAYS.done + '" (got ' + JSON.stringify(hl) + ')');
        const af = viaAwayFires([entry, next], again);
        // review r8: a held fire did not finish — it is no failure, and never a clean run: "(1 did not finish)"
        check('away briefing', 'held then clean', af.routines === 1 && af.failed === 0 && af.unfinished === 1 && /“digest” ran 2× \(1 did not finish\)/.test(String(af.text || '')),
          'after ' + surface + ' and the routine\'s next, clean fire the held fire is still briefed as unfinished beside the clean one, never as two clean runs (got failed=' + af.failed + ', unfinished=' + af.unfinished + ': ' + JSON.stringify(String(af.text || '').slice(-120)) + ')');
      }
      check('notifications', 'held', !rt.pinged, 'a held line never pings "ran on its own" (got a ping)');
    }
    // A LINE THAT STOPPED SHORT (review 4.3): the entry run finished, then a downstream hop failed — or the joiner sent on without every
    // branch. The routine's record keeps the entry run's outcome with the line's stop facts (quick win 25), but its crate is no delivered
    // job: the channel hub, chain.js's own line-output receipt and the trigger / SEND TO runners all refuse it (routing/line-fire.js
    // lineDelivered). Both routine paths settled it 'done' — a crate rode to the OUTBOX for a line that never reached it.
    // (line-job-runner) a chain result carries its stop TYPED beside the words (chain.js out.stop): the fire's record keeps the code, and a
    // stage that ran out of budget is a stage that did not finish — never "failed" (routing/line-fire.js lineStop)
    const STAGE_FAILED = 'EDITOR failed: its run failed (rate_limit)', STAGE_UNFINISHED = 'EDITOR did not finish: hit a spending limit';
    for (const [kind, line] of [['stopped line', { text: 'draft', hops: [{ agentId: 'editor', dockId: 'edit' }], stopped: STAGE_FAILED, stop: { code: 'stage_failed', why: STAGE_FAILED, agentId: 'editor', dockId: 'edit' }, usd: 0 }],
      ['unfinished line', { text: 'draft', hops: [{ agentId: 'editor', dockId: 'edit' }], stopped: STAGE_UNFINISHED, stop: { code: 'stage_incomplete', why: STAGE_UNFINISHED, agentId: 'editor', dockId: 'edit' }, usd: 0 }],
      ['partial join', { text: 'joined', hops: [{ agentId: 'joiner', dockId: 'join' }], stopped: null, partial: 'branch B never arrived', usd: 0 }]]) {
      const run = await stationRun('done');
      const rt = await viaRoutine(run, line);
      let rn = null;
      try { rn = await viaRunNow(run, line); } catch (e) { check('Run Now', kind, false, 'the press threw: ' + ((e && e.message) || e)); }
      for (const [surface, x] of [['routines', rt], ['Run Now', rn]]) {
        if (!x) continue;
        check(surface, kind, x.crate !== 'done' && x.crate !== '(never settled)', 'a ' + kind + '\'s crate is drained, never delivered to the OUTBOX (settled with ' + JSON.stringify(x.crate) + ')');
        if (line.stop) {
          const ll = x.job.lastLine || {};
          check(surface, kind, ll.stopCode === line.stop.code && ll.stopped === line.stop.why, 'the fire\'s record keeps the line\'s stop code beside its words (got ' + JSON.stringify(ll) + ')');
          const said = String((x.job.finalization && (x.job.finalization.result || '')) || '') + ' ' + String((x.job.finalization && x.job.finalization.error) || '');
          if (kind === 'unfinished line') check(surface, kind, /did not finish: hit a spending limit/.test(said) && !/EDITOR failed/.test(said), 'the fire says the stage did not finish, never that it failed (got ' + JSON.stringify(said.slice(-160)) + ')');
        }
        // review 5.3: the briefing reads the failed stage as its fire's (its line stopped there), never as a routine of its own
        if (kind === 'stopped line') {
          const entry = Object.assign(historyRow(run), { runId: x.job.lastRunId });
          const away = viaAway(entry, x.job, [{ runId: 'hop-edit', agentId: 'editor', reason: 'error', outcome: 'failed', failureCode: 'rate_limit', title: '[PIPELINE HANDOFF] edit the draft' }]);
          check('away briefing', kind, away.routines === 1 && away.failed === 1 && /“digest” failed: its work line stopped at a stage \(rate limit\)/.test(String(away.text || '')) && !/PIPELINE HANDOFF/.test(String(away.text || '')),
            'after ' + surface + ' a ' + kind + '\'s failed stage is briefed as its fire\'s line stopping, never as a separate routine (got routines=' + away.routines + ', failed=' + away.failed + ': ' + JSON.stringify(String(away.text || '').slice(-160)) + ')');
        }
      }
    }
    // A STOP IS ITS OWN OUTCOME (review r7, the family law: never reported or counted as a failure, never as a success).
    // 1. A LINE SOMEONE STOPPED: the entry run finished, then a STOP / E-STOP landed on a hop (chain.js: '<agent> was stopped', halted) or
    //    between stages ('stopped', halted, no hop yet). Both routine paths recorded the fire ok / succeeded, reset the failure streak,
    //    pinged "ran on its own" and delivered stage one's draft as the routine's normal result (no note at all for a stop before the first
    //    hop) — while the away briefing failed the same fire.
    for (const [kind, line] of [['line stopped at a hop', { text: 'stage one draft', hops: [{ agentId: 'editor', dockId: 'edit' }], stopped: 'editor was stopped', halted: true, usd: 0 }],
      ['line stopped before its first hop', { text: '', hops: [], stopped: 'stopped', halted: true, usd: 0 }]]) {
      const run = await stationRun('done');
      const rt = await viaRoutine(run, line);
      let rn = null;
      try { rn = await viaRunNow(run, line); } catch (e) { check('Run Now', kind, false, 'the press threw: ' + ((e && e.message) || e)); }
      for (const [surface, x] of [['routines', rt], ['Run Now', rn]]) {
        if (!x) continue;
        check(surface, kind, x.status === 'stopped' && x.cronOutcome === 'stopped' && x.job.lastOutcome === 'stopped' && x.cronReason === 'cancelled',
          'a fire whose line someone stopped is recorded and announced stopped — never ok, never a failure (got ' + JSON.stringify([x.status, x.cronOutcome, x.job.lastOutcome, x.cronReason]) + ')');
        check(surface, kind, x.crate !== 'done' && (Number(x.job.consecutiveFailures) || 0) === 0, 'its crate is drained and the stop counts toward no failure streak (got ' + JSON.stringify([x.crate, x.job.consecutiveFailures]) + ')');
        const f = x.job.finalization || {};
        check(surface, kind, f.runOutcome === 'stopped' && /the work line was stopped before it finished/.test(String(f.error || '')),
          'its finalization keeps the stop (runOutcome) and says the line was stopped, never stage one\'s draft as the whole result (got ' + JSON.stringify([f.runOutcome, f.error, f.result]) + ')');
        const text = await viaDelivery(x.job, { runId: f.runId, outcome: f.outcome, runOutcome: f.runOutcome, text: f.result, error: f.error });
        check(surface, kind, /^✦ digest — stopped before it finished/.test(String(text || '')) && !/\bfailed\b/.test(String(text || '').split('\n')[0]),
          'the delivery headline says the fire was stopped, never "✦ digest failed" (got ' + JSON.stringify(String(text || '').slice(0, 120)) + ')');
      }
      check('notifications', kind, !rt.pinged, 'a fire whose line someone stopped never pings "ran on its own" (got a ping)');
    }
    // 2. A STOP AFTER FOUR FAILURES: it counted as the fifth failure in a row, auto-paused a routine nobody broke ("paused after 5
    //    consecutive failures") and toasted "✕ routine failed — cancelled (paused: consecutive-failures x5)". The streak stands as it was.
    {
      const run = await stationRun('stopped');
      const T0 = 1700000000000;
      const failing = Object.assign(cronStore.makeJob({ id: 'j1', prompt: 'do it', agentId: 'cron_j1', schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 }), { consecutiveFailures: 4 });
      const settled = cronStore.getJob(cronStore.markRun([failing], 'j1', { runId: 'stop5', status: 'stopped', reason: 'cancelled', outcome: 'stopped', error: 'run ended without completion — it was cancelled before it finished [cancelled]', transient: false }, { now: T0 + 60000, maxConsecutiveFailures: 5 }), 'j1');
      check('routines', 'stop after four failures', settled.consecutiveFailures === 4 && settled.enabled !== false && settled.state === 'scheduled' && !settled.disabledReason && !/consecutive failures/.test(String(settled.finalization && settled.finalization.error)),
        'a stop leaves the failure streak as it was and never auto-pauses the routine (got ' + JSON.stringify({ n: settled.consecutiveFailures, enabled: settled.enabled, state: settled.state, why: settled.disabledReason }) + ')');
      const rt = await viaRoutine(run);
      check('routines', 'stop after four failures', rt.result && rt.result.pausedAfter == null && !/paused/.test(String(rt.cronReason)), 'cron.result names no auto-pause for a stop (got ' + JSON.stringify(rt.result) + ')');
    }
    // 3. PAUSED WHILE IT RAN: pauseJob lands first, then the fire's abort. The settlement rewrote 'paused' to 'error', re-armed it, and its
    //    result went out at once as "✦ digest failed" (deliveriesHeld read false) instead of waiting for the resume; with four failures behind
    //    it, the Commander's own pause was relabelled 'consecutive-failures'.
    for (const prior of [0, 4]) {
      const pm = await viaPausedMidRun(await stationRun('stopped'), prior);
      const kind = 'paused mid-run' + (prior ? ' after four failures' : '');
      check('routines', kind, pm.job.enabled === false && pm.job.state === 'paused' && pm.job.disabledReason === 'paused' && pm.held === true && pm.delivered.length === 0,
        'the Commander\'s pause stands and the stopped fire\'s result is held until the resume (got ' + JSON.stringify({ enabled: pm.job.enabled, state: pm.job.state, why: pm.job.disabledReason, held: pm.held, delivered: pm.delivered.length }) + ')');
      check('routines', kind, pm.job.lastStatus === 'stopped' && (Number(pm.job.consecutiveFailures) || 0) === prior && pm.result && pm.result.outcome === 'stopped' && !/paused: consecutive/.test(String(pm.result.reason)),
        'the fire is recorded and announced stopped, the streak unchanged (got ' + JSON.stringify({ status: pm.job.lastStatus, n: pm.job.consecutiveFailures, result: pm.result }) + ')');
    }
    // 3b. RUN NOW ON A ROUTINE ALREADY PAUSED (review 7.1): the button stays live on a paused routine, and r7's hold caught that press too — the
    //     result the Commander asked for (a clean reply, or the failure notice) waited for a resume that might never come, and a later result
    //     could collapse it ("N earlier results … will not be resent"); a transient failure (a 429, an unreachable provider) backed off to a
    //     retry a paused routine never fires, so it settled nothing at all. The pause stands and the result goes out at once; a press the
    //     Commander pauses WHILE it runs is still held.
    for (const kind of ['done', 'template', 'codex429', 'unreachable', 'cut', 'budget']) {
      const rn = await viaPausedRunNow(await stationRun(kind), true);
      const want = ORACLE[kind][0];
      check('Run Now', 'pressed while paused (' + kind + ')', rn.job.enabled === false && rn.job.state === 'paused' && rn.job.disabledReason === 'paused' && rn.job.lastOutcome === want,
        'the Commander\'s pause stands and the press is recorded ' + want + ' (got ' + JSON.stringify({ enabled: rn.job.enabled, state: rn.job.state, why: rn.job.disabledReason, outcome: rn.job.lastOutcome, threw: rn.threw }) + ')');
      check('Run Now', 'pressed while paused (' + kind + ')', rn.delivered.length === 1 && rn.job.finalization && rn.job.finalization.state === 'delivered' && !cronStore.deliveriesHeld(rn.job, rn.job.finalization),
        'the result the Commander asked for goes out at once, never held for a resume (got ' + JSON.stringify({ delivered: rn.delivered.length, finalization: rn.job.finalization && rn.job.finalization.state }) + ')');
    }
    {
      const rn = await viaPausedRunNow(await stationRun('stopped'), false);
      check('Run Now', 'paused while pressed', rn.job.enabled === false && rn.job.state === 'paused' && rn.delivered.length === 0 && rn.job.finalization && rn.job.finalization.state === 'pending' && cronStore.deliveriesHeld(rn.job, rn.job.finalization) === true,
        'a press the Commander pauses while it runs keeps its result until the resume (got ' + JSON.stringify({ enabled: rn.job.enabled, state: rn.job.state, delivered: rn.delivered.length, finalization: rn.job.finalization && rn.job.finalization.state }) + ')');
    }
    // 4. A STOP, THEN A CLEAN FIRE — the briefing's "(K failed)" count (review 6.2) counted the stop: "“digest” ran 2× (1 failed)" and
    //    counts.failed 1, while the page and the HUD settle the same fire as no verdict
    {
      const run = await stationRun('stopped');
      const rt = await viaRoutine(run);
      const again = await fireAgain(rt.job, await stationRun('done'));
      const rows = [Object.assign(historyRow(run), { runId: rt.job.lastRunId }), Object.assign(historyRow(await stationRun('done')), { runId: again && again.lastRunId })];
      const af = viaAwayFires(rows, again);
      check('away briefing', 'stopped then clean', af.failed === 0 && af.stopped === 1 && /“digest” ran 2× \(1 stopped\)/.test(String(af.text || '')) && !/failed/.test(String(af.text || '')),
        'a stop before a clean fire is said as a stop beside the count, never "(1 failed)" (got failed=' + af.failed + ', stopped=' + af.stopped + ': ' + JSON.stringify(String(af.text || '').slice(-120)) + ')');
    }
    // AN UNFIREABLE SCHEDULE (review r2): a routine whose last run succeeded gets a schedule that can never fire. No run ended, so
    // neither that run's outcome nor its reason may speak for the record: the card read "✕ done" next to the earlier run's time
    {
      const run = await stationRun('done');
      const rt = await viaRoutine(run);
      const marked = cronStore.getJob(cronStore.markUnfireable([rt.job], rt.job.id, { now: 1700000120000 }), rt.job.id);
      const w = viaWindow(marked, historyRow(run));
      check('ROUTINES window', 'unfireable', marked.lastStatus === 'error' && w.card === '✕ schedule-unfireable', 'an unfireable routine\'s card names the schedule, never an earlier run\'s "done" (got "' + w.card + '")');
    }
    // A STOP THAT RAISED NO ERROR EVENT (review r3): the loop's compute gate emits capdenied and ends 'error' with the code on its END
    // (failureCode capability_denied). COMMS reads that code; the SLAG post-mortem and a bound build's stall beat took the kind only
    // from an agent.run.error, and fell back to "send it again, report it"
    {
      const runId = 'r-capdenied';
      const end = { agentId: 'agent', runId, reason: 'error', turns: 1, usd: 0, failureCode: 'capability_denied' };
      const run = { kind: 'capdenied', runId, throws: false, result: { reason: 'error' }, events: [
        ['agent.run.start', { agentId: 'agent', runId, trigger: 'directive', model: 'm' }],
        ['capdenied', { agentId: 'agent', runId, need: 'compute', reason: 'no compute here' }],
        ['agent.run.end', RunOutcome ? RunOutcome.stamp(end, null) : end]] };
      const expect = BrowserFriendly.friendlyError(new Error('capability_denied'), null, { code: 'capability_denied' }).kind;
      const slag = viaSlag(run);
      check('SLAG post-mortem', 'capdenied', slag.recorded && slag.kind === expect && expect === 'capdenied', 'a coded stop with no error event reads ' + expect + ', as COMMS does (got ' + (slag.recorded ? slag.kind : 'no post-mortem') + ')');
      const bq = viaBuildQuest(run);
      check('build quest', 'capdenied', bq.status !== 'done' && !/report it/i.test(bq.beat), 'the stalled build names the capability door, never "report it" (got ' + JSON.stringify(bq.beat) + ')');
    }
    /* HOW A LINE'S JOB ENDED (line-job-runner): a line's typed stop and an older job record's status read through ONE map, the WORKFLOWS
       chips' words and tones. Written out here, never computed by frontend/app/runoutcome.js. A stop that left the job short of its
       OUTBOX is stored as the 'problem' every older build reads; someone's STOP and the station's fault containment are stops; a hold
       is its own; a refusal never ran; a restart interrupted it. */
    {
      const R = RunOutcome || {};
      const SHORT = ['stopped_short', 'problem', 'problem', 'warn'];
      const LINE_ORACLE = {   // code -> [outcome, the record's status, its chip word, its tone]
        hop_limit: SHORT, usd_limit: SHORT, day_limit: SHORT, stage_incomplete: SHORT, stage_failed: SHORT, stage_empty: SHORT, loops_back: SHORT,
        wrong_line: SHORT, no_outbox: SHORT, partial_join: SHORT, joiner_lost: SHORT, not_steppable: SHORT,
        stopped: ['stopped', 'stopped', 'stopped', 'stop'], station_fault: ['stopped', 'stopped', 'stopped', 'stop'],
        blocked: ['blocked', 'problem', 'blocked', 'warn'], refused: ['failed', 'failed', 'didn’t run', 'warn'], restart: ['interrupted', 'interrupted', 'interrupted', 'warn']
      };
      check('line outcomes', 'vocabulary', Array.isArray(R.LINE_STOPS) && R.LINE_STOPS.slice().sort().join() === Object.keys(LINE_ORACLE).sort().join()
        && Array.isArray(R.LINE_OUTCOMES) && R.LINE_OUTCOMES.join() === 'running,paused,delivered,stopped_short,stopped,blocked,failed,interrupted',
      'the line\'s stop codes and job outcomes are exactly these (got ' + JSON.stringify([R.LINE_STOPS, R.LINE_OUTCOMES]) + ')');
      const read = x => (typeof R.lineOutcomeOf === 'function' ? [R.lineOutcomeOf(x), R.lineStatus(x), R.lineLook(x).word, R.lineLook(x).tone].join('|') : '(no line outcomes before the lane)');
      for (const code of Object.keys(LINE_ORACLE)) check('line outcomes', code, read(code) === LINE_ORACLE[code].join('|'), 'ends the job ' + LINE_ORACLE[code][0] + ', stored "' + LINE_ORACLE[code][1] + '", shown "' + LINE_ORACLE[code][2] + '" (got ' + read(code) + ')');
      check('line outcomes', 'no stop', read(null) === 'delivered|delivered|delivered|ok', 'a walk that reached its OUTBOX with no stop delivered (got ' + read(null) + ')');
      // a record written before the codes carries neither field: its status says it, exactly as every older reader shows it
      for (const [status, o, word, tone] of [['delivered', 'delivered', 'delivered', 'ok'], ['problem', 'stopped_short', 'problem', 'warn'], ['stopped', 'stopped', 'stopped', 'stop'],
        ['failed', 'failed', 'didn’t run', 'warn'], ['interrupted', 'interrupted', 'interrupted', 'warn'], ['running', 'running', 'running', 'run'], ['paused', 'paused', 'paused', 'ask']]) {
        check('line outcomes', 'record ' + status, read({ status }) === [o, status, word, tone].join('|'), 'an older "' + status + '" record reads ' + o + ' (got ' + read({ status }) + ')');
      }
      check('line outcomes', 'stamped record', read({ status: 'problem', outcome: 'blocked' }) === 'blocked|problem|blocked|warn', 'a stamped outcome outranks the status it is stored beside (got ' + read({ status: 'problem', outcome: 'blocked' }) + ')');
    }
  } finally {
    v1Server.closeAllConnections(); await new Promise(r => v1Server.close(r));
    acpStation.closeAllConnections(); await new Promise(r => acpStation.close(r));
  }

  // THE SUMMARY: every surface agrees on every case. Before the lane each surface failed at least one (the header lists them).
  console.log('\noutcome-roundtrip — per surface:');
  for (const [surface, rows] of ledger) {
    const bad = rows.filter(r => !r.ok);
    console.log('  ' + (bad.length ? 'FAIL ' : 'ok   ') + surface.padEnd(17) + (rows.length - bad.length) + '/' + rows.length + (bad.length ? '  — ' + bad.map(b => b.why).slice(0, 4).join(' ; ') : ''));
  }
  A.report('outcome-roundtrip.table.test');
})().catch(e => { console.error(e); process.exit(1); });
