/* STARNET — runoutcome.js : HOW A RUN ENDED, as ONE code every surface reads (typed-outcomes lane, 2026-10-29).

   THE FAMILY. COMMS, a channel reply, a routine's history, /v1, ACP, the terminal, the Live Doctor, the phone, the run
   history and the notifications each decided on its own, from the end reason and the error's WORDS, whether a run
   succeeded, failed, was refused, was stopped or ran out of budget. Each past fix patched one copy (the page re-read a
   ChatGPT 429 the station had classed as a rate limit as a spent plan, bug 38da5ee4's 403 ladder, a thrown run kept as
   'done', a cut-short reply exiting 0). The station now settles the outcome ONCE, from the facts it has, and the code
   travels: agent.run.end carries `outcome` + `failureCode`, agent.run.error carries `failureCode`, a run-history row
   carries `outcome`. Every surface reads it here; none re-derives it from text.

   OUTCOMES — the one vocabulary:
     succeeded      the run finished ('done') and the provider did not cut its reply
     asked          it ended by asking the Commander a question ('clarifying'): neither finished work nor a failure
     cut_short      'done', but the provider cut the reply (finishReason 'length' | 'content_filter')
     failed         it ended on an error (never said in the stop's word); failureCode says which
     refused        the model or its provider declined the request ('refusal', or a provider safety block)
     stopped        someone stopped it ('cancelled')
     out_of_budget  a spending limit or a token ceiling ended it ('budget')
     step_limit     it used every step it had ('max_iters')
     empty          the model sent back nothing ('empty')
     interrupted    the station stopped while it ran (the boot scan's 'interrupted' row)
     blocked        a reviewer's VERDICT: blocked held the work at a gate (a work line's outcome, never one run's: ofLine)

   failureCode (failed / refused only): the provider classifier's reason (sidecar/providers/errorClass.js: rate_limit,
   quota_exhausted, template_refusal, unreachable, …) or the loop's own stop code (spend_history_unavailable,
   incomplete_work, …). 'no_terminal_outcome' = nothing proves how the run ended (no agent.run.end, or a thrown run): it
   is recorded as failed, never as done.

   PURE + node-testable (no clock, no IO, no DOM): the browser gets a `RunOutcome` global; node (the sidecar, the CLI,
   tests) gets module.exports. Locked by test/outcome-roundtrip.table.test.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RunOutcome = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OUTCOMES = Object.freeze(['succeeded', 'asked', 'cut_short', 'failed', 'refused', 'stopped', 'out_of_budget', 'step_limit', 'empty', 'interrupted', 'blocked']);
  const KNOWN = new Set(OUTCOMES);
  // agent.run.end `reason` (plus the run history's 'interrupted') -> the outcome before the finer facts are read
  const BY_REASON = Object.freeze({
    done: 'succeeded', clarifying: 'asked', error: 'failed', refusal: 'refused', cancelled: 'stopped',
    budget: 'out_of_budget', max_iters: 'step_limit', empty: 'empty', interrupted: 'interrupted'
  });
  const NO_TERMINAL = 'no_terminal_outcome';
  // a failure the model's (or its provider's) own safety check raised declined the REQUEST: the run did not break
  const REFUSAL_CODES = new Set(['content_policy_blocked', 'model_refusal']);
  /* The provider classifier's reasons (sidecar/providers/errorClass.js REASONS — test/outcome-roundtrip.table.test.js
     keeps the two in step) and the loop's own provider stops. A code here means the MODEL PROVIDER failed the call, not
     StarNet: an ACP editor or a phone must never read "the run failed inside StarNet" for a provider's rate limit. */
  const PROVIDER_CODES = new Set(['auth', 'billing', 'rate_limit', 'quota_exhausted', 'overloaded', 'server_error', 'timeout',
    'context_overflow', 'output_cap', 'call_too_expensive', 'model_not_found', 'content_policy_blocked', 'format_error',
    'tls_certificate', 'local_error', 'local_memory', 'local_timeout', 'endpoint_mismatch', 'template_refusal', 'unreachable',
    'unknown', 'provider_stalled', 'provider_failure']);
  /* Did the provider ANSWER (and refuse) — or did nothing usable answer at all? The Live Doctor's two failure states
     ('refused' / 'unreachable') read this, so a rate limit is never "unreachable" and a refused connection never "refused". */
  const ANSWERED_CODES = new Set(['auth', 'billing', 'rate_limit', 'quota_exhausted', 'context_overflow', 'output_cap',
    'call_too_expensive', 'model_not_found', 'content_policy_blocked', 'format_error', 'endpoint_mismatch', 'template_refusal']);

  const str = v => (v == null ? '' : String(v));
  const codeOf = v => str(v).trim().slice(0, 80);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* resolve(facts) -> { outcome, failureCode, ok }. facts: { reason, failureCode, finishReason, clarifying }.
     A reason outside the vocabulary (or none) is not proof the run finished: failed / no_terminal_outcome. */
  function resolve(facts) {
    const f = facts || {};
    const reason = str(f.reason);
    let code = codeOf(f.failureCode);
    let outcome;
    if (!reason || !has(BY_REASON, reason)) { outcome = 'failed'; code = code || NO_TERMINAL; }
    else outcome = BY_REASON[reason];
    if (outcome === 'succeeded') {
      if (f.clarifying === true) outcome = 'asked';
      else if (f.finishReason === 'length' || f.finishReason === 'content_filter') outcome = 'cut_short';
    }
    if (outcome === 'failed' && REFUSAL_CODES.has(code)) outcome = 'refused';
    if (outcome === 'refused' && !code) code = 'model_refusal';
    if (outcome === 'failed' && !code) code = 'run_failure';
    if (outcome !== 'failed' && outcome !== 'refused') code = '';
    return { outcome, failureCode: code, ok: outcome === 'succeeded' };
  }

  // a stamp the station already put on an event or a row wins (it was settled by this same rule, from facts a reader
  // may not hold); an older station's payload has none and is resolved from its own fields
  function withStamp(out, stamp, stampCode) {
    if (!KNOWN.has(stamp)) return out;
    const code = codeOf(stampCode) || out.failureCode;
    const failing = stamp === 'failed' || stamp === 'refused';
    return { outcome: stamp, failureCode: failing ? (code || (stamp === 'refused' ? 'model_refusal' : 'run_failure')) : '', ok: stamp === 'succeeded' };
  }

  /* ofEnd(endPayload, errorPayload) -> the outcome a stream PROVED. endPayload: the run's own agent.run.end (null when
     the stream closed without one); errorPayload: its agent.run.error, if any. No end = no_terminal_outcome (or the
     error's own code), never done. */
  function ofEnd(end, err) {
    const e = end && typeof end === 'object' ? end : null;
    const errCode = err && typeof err === 'object' ? codeOf(err.failureCode) : '';
    if (!e) return resolve({ reason: '', failureCode: errCode });
    const out = withStamp(resolve({ reason: e.reason, failureCode: codeOf(e.failureCode) || errCode, finishReason: e.finishReason, clarifying: e.clarifying === true }), e.outcome, e.failureCode || errCode);
    // an error the run itself raised outranks an end that still says it finished (an image task's unmet completion: the
    // host emits the error, the loop's end stays 'done') — every reader treated that run as failed except the ones that
    // keyed on the reason alone
    if (err && typeof err === 'object' && (out.outcome === 'succeeded' || out.outcome === 'cut_short')) return { outcome: 'failed', failureCode: errCode || 'run_failure', ok: false };
    return out;
  }

  /* ofLine(runOutcome, lineFacts) -> the outcome of a FIRE whose work line ran after its entry run (a routine, Run Now). A line
     a reviewer's VERDICT: blocked held (sidecar/routing/line-fire.js lineFacts().blocked) delivered nothing, however cleanly
     its entry run finished: the fire is 'blocked'. This is the one producer of that outcome — a work line's, never one run's.
     Any other fire keeps its run's outcome. A line SOMEONE STOPPED (line.halted: a STOP or E-STOP on one of its hops, or on the
     line between stages — routing/chain.js) finished no job and failed none: the fire is 'stopped' (review r7: it read 'succeeded',
     was recorded ok and pinged "ran on its own" over stage one's draft). */
  function ofLine(o, line) {
    const x = o || resolve(null);
    if (!x.ok || !line || typeof line !== 'object') return x;
    if (line.blocked) return { outcome: 'blocked', failureCode: '', ok: false };
    if (line.halted) return { outcome: 'stopped', failureCode: '', ok: false };
    return x;
  }

  /* reasonOf(endPayloadOrRow) -> its reason as a REASON-keyed surface must read it (a word map, a recovery policy, a status
     label): 'done' only for a run that SUCCEEDED. A 'done' end that did not reads as what it was — 'cut_short', 'error' (an error
     the run raised outranks it), 'clarifying' (it asked a question), 'cancelled' (a FIRE whose work line someone stopped: ofLine,
     review r7 — a reason a reader resolves back to 'stopped') — and an end with no reason at all is 'error', never 'done'.
     Any other reason is its own WHILE it names the outcome the end proves. Review 9.2: an END-ONLY refusal ends 'error' stamped
     'refused' (or carrying a refusal code), and every reader keyed on this word (the HUD deck, the logbook, the desk screen, a recipe's
     last run, `starnet watch`, the MCP bridge, a routine's fire reason) said it as a failure. A word the end's outcome contradicts reads
     that outcome's own end word (END_WORD: a refusal 'refusal'); a word outside the end vocabulary on a record with no stamp proves
     nothing more (a fire's 'blocked', an older reader's 'cut_short') and stays as it is. */
  const END_WORD = Object.freeze({
    succeeded: 'done', asked: 'clarifying', failed: 'error', refused: 'refusal', stopped: 'cancelled', out_of_budget: 'budget',
    step_limit: 'max_iters', empty: 'empty', interrupted: 'interrupted', cut_short: 'cut_short', blocked: 'blocked'
  });
  function reasonOf(x) {
    const e = x && typeof x === 'object' ? x : null;
    const r = e ? str(e.reason) : '';
    if (r && r !== 'done' && !has(BY_REASON, r) && !KNOWN.has(e.outcome)) return r;
    const o = ofEnd(e, null).outcome;
    return r && r !== 'done' && o === ofWord(r).outcome ? r : END_WORD[o];
  }

  // ofRow(runHistoryRow) -> the outcome a run-history row records (sidecar/runstore.js)
  function ofRow(row) {
    const r = row && typeof row === 'object' ? row : {};
    const out = resolve({ reason: r.reason, failureCode: r.failureCode, finishReason: r.finishReason, clarifying: r.clarifying === true });
    return withStamp(out, r.outcome, r.failureCode);
  }

  /* stamp(endPayload, errorPayload) -> the agent.run.end payload with `outcome` (and, for a failed or refused run,
     `failureCode`) set — what the station emits. A payload that already carries an outcome is returned as is. */
  function stamp(end, err) {
    if (!end || typeof end !== 'object' || KNOWN.has(end.outcome)) return end;
    const o = ofEnd(end, err);
    const out = Object.assign({}, end, { outcome: o.outcome });
    if (o.failureCode) out.failureCode = o.failureCode;
    return out;
  }

  /* sink(emit, onOutcome?) -> an emit that stamps every agent.run.end it passes with that run's outcome, pairing it with
     the SAME run's agent.run.error (a forwarded worker's end never takes the lead's error). The station wraps a run's
     emitter once (sidecar/index.js runOnceCore), after every rewrite of the end (a Task Brief question re-emits it as
     'clarifying'), so the stamp is settled from the facts the end finally carries. onOutcome(runId, { outcome,
     failureCode }) lets the host hand the same outcome to the run-history row. */
  function sink(emit, onOutcome) {
    const errs = new Map();
    return function (name, payload) {
      if (payload && typeof payload === 'object') {
        if (name === 'agent.run.error') {
          errs.set(str(payload.runId), payload);
          if (errs.size > 64) errs.delete(errs.keys().next().value);
        } else if (name === 'agent.run.end') {
          const rid = str(payload.runId);
          payload = stamp(payload, errs.get(rid) || null);
          errs.delete(rid);
          if (typeof onOutcome === 'function') onOutcome(rid, { outcome: payload.outcome, failureCode: str(payload.failureCode) });
        }
      }
      return emit(name, payload);
    };
  }

  // short plain words for a surface that prints one line (the phone's row, a terminal receipt). A failed run names its
  // code: the words for a code are the page's (frontend/app/friendlyerror.js), keyed by the same code. Each outcome's own
  // verb: 'stopped' is the stop's alone (review 9.3: a spend cap read "stopped at a spending limit" on the phone push, the
  // HUD toast and the ROUTINES card — the stop's word on a limit, as stop-reason.js stopSentence says it: "hit").
  const PHRASE = Object.freeze({
    succeeded: 'finished', asked: 'asked a question', cut_short: 'the reply was cut short', failed: 'failed',
    refused: 'the model declined the request', stopped: 'stopped before it finished', out_of_budget: 'hit a spending limit',
    step_limit: 'reached the step limit', empty: 'the model sent back an empty reply', interrupted: 'interrupted when StarNet stopped',
    blocked: 'held: the work was not accepted'
  });
  function line(o) {
    const x = o || {};
    const p = PHRASE[x.outcome] || PHRASE.failed;
    return x.failureCode && x.failureCode !== 'model_refusal' ? p + ' (' + x.failureCode + ')' : p;
  }
  const isProviderCode = c => PROVIDER_CODES.has(codeOf(c));
  const providerAnswered = c => ANSWERED_CODES.has(codeOf(c));

  /* ofWord(word) -> the outcome a REASON-KEYED record names (review r8). A board card's lastRunReason, a terminal crew card's last end and a
     routine's fire reason keep ONE word for how a run ended: an end reason, RunOutcome.reasonOf's word ('cut_short', 'blocked') or an outcome
     kept where a reason was ('asked', 'stopped', 'out_of_budget'). A word in neither vocabulary proves no ending: failed / no_terminal_outcome. */
  function ofWord(w) {
    const s = str(w).trim();
    if (KNOWN.has(s)) return withStamp(resolve(null), s, '');
    return resolve({ reason: s });
  }
  /* ofWorker(ledgerRecord) -> the outcome a background WORKER's ledger record names (review 8.1), or null while it runs. The ledger (sidecar
     subagents.js, orchestration.js) folds every unsuccessful end into status 'error' and keeps the end in its reason (RunOutcome.reasonOf of
     the worker's own end): a worker that asked a question, hit a spend cap or a step limit, was cut short, sent back nothing or was refused
     is { status: 'error', reason: 'clarifying' | 'budget' | 'max_iters' | 'cut_short' | 'empty' | 'refusal' }, and NEEDS YOU, the HUD and
     the project home read every one of them as failed work. Status 'done' succeeded; a stop through the ledger (status 'interrupted', or a
     reason a stop leads: its lead's Stop is 'cancelled: its parent run … was cancelled') stopped; 'stale' (cut off by a restart, or stopped by
     the liveness check) interrupted; status 'refused' (it could not start: the ledger's own code, never the model's 'refusal') and every
     reason outside the end vocabulary failed. */
  function ofWorker(w) {
    const x = w && typeof w === 'object' ? w : null;
    const status = x ? str(x.status) : '', r = x ? str(x.reason).trim() : '';
    if (!status || status === 'running' || status === 'queued') return null;
    if (status === 'done') return { outcome: 'succeeded', failureCode: '', ok: true };
    if (status === 'interrupted' || /^(aborted|cancelled|stopped|interrupted)\b/.test(r)) return { outcome: 'stopped', failureCode: '', ok: false };
    if (status === 'stale') return { outcome: 'interrupted', failureCode: '', ok: false };
    if (status === 'error' && r && r !== 'done' && r !== 'error' && (has(BY_REASON, r) || KNOWN.has(r)) && r !== 'refused' && r !== 'succeeded') return ofWord(r);
    return { outcome: 'failed', failureCode: codeOf(x.failureCode) || 'run_failure', ok: false };
  }
  /* look(outcome) -> { word, tone }: ONE short word and ONE tone per outcome (review r8), for a surface that draws a run's end as a lamp, a tag
     or a chip. THE FAMILY LAW: a stop is never the failure tone, a question is never a stop, a failure is never a stop. The unfinished outcomes
     (cut short, a limit, an empty reply, a refusal, a hold, an interruption) share the warn tone, each with its own word. Tones: ok · ask ·
     stop · warn · bad. */
  const LOOK = Object.freeze({
    succeeded: Object.freeze({ word: 'done', tone: 'ok' }), asked: Object.freeze({ word: 'asked you', tone: 'ask' }),
    stopped: Object.freeze({ word: 'stopped', tone: 'stop' }), interrupted: Object.freeze({ word: 'interrupted', tone: 'warn' }),
    cut_short: Object.freeze({ word: 'cut short', tone: 'warn' }), out_of_budget: Object.freeze({ word: 'spend cap', tone: 'warn' }),
    step_limit: Object.freeze({ word: 'step limit', tone: 'warn' }), empty: Object.freeze({ word: 'empty reply', tone: 'warn' }),
    refused: Object.freeze({ word: 'refused', tone: 'warn' }), blocked: Object.freeze({ word: 'blocked', tone: 'warn' }),
    failed: Object.freeze({ word: 'failed', tone: 'bad' })
  });
  function look(o) { const k = typeof o === 'string' ? o : (o && o.outcome); return LOOK[k] || LOOK.failed; }

  /* HOW A WORK LINE'S JOB ENDED (line-job-runner, 2026-11-03) — the line's own vocabulary beside the run's above. A job is many runs
     (one per stage); where its walk stopped is ONE code, and the job's end is ONE outcome. sidecar/routing/line-fire.js lineStop(code,
     facts) says each code in one sentence; chain.js (out.stop) and the step-through test (session.stop) set them.
     LINE_STOPS — why a walk stopped:
       hop_limit / usd_limit / day_limit   the line's LINE BUDGET (stages, $ per message, $ per day) or the walk's own hop guard
       stage_incomplete                    a stage did not finish (cut short, a spending or step limit, a question, interrupted, no end)
       stage_failed / stage_empty          a stage failed, was refused or could not start / it handed on nothing
       loops_back / wrong_line             the walk came back to a bay outside a loop pass / the job belongs to another line
       no_outbox                           the walk ended at a bay whose belt reaches no OUTBOX
       partial_join / joiner_lost          a JOINER sent the job on without every branch / lost the branches it waited for
       stopped / station_fault             someone stopped it (STOP, E-STOP) / the station's own fault containment did
       blocked                             a reviewer's VERDICT: blocked held the work at a gate
       not_steppable / refused / restart   the step-through test cannot carry it / refused before it ran / StarNet restarted mid-step
     LINE_OUTCOMES — the job's end: running · paused (a step-through test waiting on you) · delivered (an OUTBOX reached, no stop) ·
     stopped_short · stopped · blocked · failed (it never ran) · interrupted.
       lineOutcomeOf(x)  a stop code -> the outcome it ends a job with (no code = delivered: the walk reached its OUTBOX); a job
                         record -> its stamped outcome, else its legacy status through LEGACY_LINE (a record written before the codes)
       lineStatus(o)     -> the LineJob status word every older reader knows ('problem' stays the stored and shown alias of
                         stopped_short and blocked; an older build reads 'paused' as interrupted)
       lineLook(o)       -> { word, tone } one short word and one tone per outcome, the WORKFLOWS chips' own. */
  const LINE_STOPS = Object.freeze(['hop_limit', 'usd_limit', 'day_limit', 'stage_incomplete', 'stage_failed', 'stage_empty', 'loops_back',
    'wrong_line', 'no_outbox', 'partial_join', 'joiner_lost', 'stopped', 'station_fault', 'blocked', 'not_steppable', 'refused', 'restart']);
  const LINE_OUTCOMES = Object.freeze(['running', 'paused', 'delivered', 'stopped_short', 'stopped', 'blocked', 'failed', 'interrupted']);
  const LINE_STOP_SET = new Set(LINE_STOPS), LINE_OUTCOME_SET = new Set(LINE_OUTCOMES);
  // a stop someone made, the station's fault containment, a reviewer's hold, a refusal and a restart are their own ends; every other
  // stop left the job short of its OUTBOX (the stages that ran stay real work)
  const STOP_OUTCOME = Object.freeze({ stopped: 'stopped', station_fault: 'stopped', blocked: 'blocked', refused: 'failed', restart: 'interrupted' });
  const LEGACY_LINE = Object.freeze({ running: 'running', paused: 'paused', delivered: 'delivered', problem: 'stopped_short', stopped: 'stopped', failed: 'failed', interrupted: 'interrupted' });
  const LINE_STATUS = Object.freeze({ running: 'running', paused: 'paused', delivered: 'delivered', stopped_short: 'problem', stopped: 'stopped', blocked: 'problem', failed: 'failed', interrupted: 'interrupted' });
  const LINE_LOOK = Object.freeze({
    running: Object.freeze({ word: 'running', tone: 'run' }), paused: Object.freeze({ word: 'paused', tone: 'ask' }),
    delivered: Object.freeze({ word: 'delivered', tone: 'ok' }), stopped_short: Object.freeze({ word: 'problem', tone: 'warn' }),
    stopped: Object.freeze({ word: 'stopped', tone: 'stop' }), blocked: Object.freeze({ word: 'blocked', tone: 'warn' }),
    failed: Object.freeze({ word: 'didn’t run', tone: 'warn' }), interrupted: Object.freeze({ word: 'interrupted', tone: 'warn' })
  });
  function lineOutcomeOf(x) {
    if (x && typeof x === 'object') {
      if (LINE_OUTCOME_SET.has(x.outcome)) return x.outcome;
      return LEGACY_LINE[str(x.status)] || 'failed';
    }
    const c = str(x).trim();
    if (!c) return 'delivered';
    if (LINE_STOP_SET.has(c)) return STOP_OUTCOME[c] || 'stopped_short';
    return LINE_OUTCOME_SET.has(c) ? c : (LEGACY_LINE[c] || 'failed');
  }
  function lineStatus(o) { return LINE_STATUS[lineOutcomeOf(o)] || 'failed'; }
  function lineLook(o) { return LINE_LOOK[lineOutcomeOf(o)] || LINE_LOOK.failed; }

  return { OUTCOMES, BY_REASON, NO_TERMINAL, PROVIDER_CODES, LOOK, resolve, ofEnd, ofRow, ofLine, ofWord, ofWorker, reasonOf, stamp, sink, line, look, isProviderCode, providerAnswered, isOutcome: v => KNOWN.has(v),
    LINE_STOPS, LINE_OUTCOMES, lineOutcomeOf, lineStatus, lineLook, isLineStop: v => LINE_STOP_SET.has(v) };
});
