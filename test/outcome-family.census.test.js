/* node test/outcome-family.census.test.js — THE FAMILY, CLOSED: no surface decides a run's success from its bare reason
   (typed-outcomes lane, review r4, 2026-10-29).

   THE FAMILY (the reliability audit's law: a fix in a known family closes the family). A surface decided whether a run
   succeeded, finished, was delivered or counted from `reason === 'done'` — the loop's "it ended" word — instead of the run's ONE
   outcome (frontend/app/runoutcome.js: RunOutcome.ofEnd / ofRow / resolve / reasonOf). A reply the provider cut ends 'done' too
   (finishReason 'length'), as does a run whose own error outranks its end, and a run that never reported an end defaulted to
   'done' in places. Review r4 found the copies outside the lane's ten surfaces: the build quest, the floor's product crate, the
   group-chat turn, the away briefing, the trust window, XP, the floor stats, the board chip, the crew's worker rows, line hand-offs,
   triggers and shipments, the HUD deck's view helper (HudMode.view, which no page mounts), the desk screen, the terminal dashboard, the phone's live run, …

   Review 4.1 found the copies the r4 census could not see, because they compare no reason with 'done': a REASON-KEYED word map
   (the HUD's finished cards `FINISH[row.reason] || FINISH.done`, the LOGBOOK's RUNS row, the recipe last-run helper (lastRunHTML, no caller), the floor crate card's
   DONE), a `|| 'done'` default for a run with no reason (the insights fold's "% success", the bay lamp, a line job's step record), a
   reason under another name (`why === 'done'`), a success rate keyed on the bare bucket, and copies whose reason was outcome-aware
   but whose INPUT dropped the outcome (XP's history catch-up, the sample route's step rows, a worker's live thread delivery), plus the
   routine crates and the line hops, whose success words fell back to the bare reason.

   1. THE CENSUS (static ratchet). Every line in sidecar/, frontend/app/, bin/ and shared/ that compares a reason with 'done', keys a
      map on a reason, defaults a missing reason to 'done', or compares a reason held under another name (why / ended / said) with
      'done' must either read the run's outcome on the same line (RunOutcome / fireOutcome / an `oc` the line computed from it) or be
      listed in ALLOWED below with why 'done' there means only "the loop ended" and claims no success, why the key is no run reason at
      all — or why it is deferred. A new copy fails this test; a listed line that no longer exists fails it too (the list stays true).
      Since review 4.3 the census also holds the REPORT family: a run's bare reason handed on AS how the run ended — a projection
      (`reason: run.reason`, `ended: x.reason || 'unknown'`, `result: d.reason`, `status: recent.reason`) or a printed line
      (`'■ ' + p.reason`, `${x.reason}`). The MCP bridge, station.test_line and station.layout / station.map told a client or the lead
      that a cut run ended 'done' through exactly such lines, and no comparison-shaped regex could see them. A REPORT line passes when
      it reads the outcome (RunOutcome …), carries the row's outcome beside the reason (`outcome:` on the same line, so a reader
      resolves it), or reads only a reason that is no run's end by its receiver's name (a classifier's cls / decision / policy /
      gate / risk …: NOT_RUN_REASON); every other hit is listed in REPORTED below with why.
   2. THE FOLDS (behavioural). The page's pure folds and the crew's worker rows, fed a provider-cut end the station stamped
      cut_short, never count it as a finished task — and a worker result that proves no ending is an error (gh#57). Since 4.1 also: the
      insights fold, the bay lamp and crate card, the HUD's finished cards, a line job's step record, a cut worker's live delivery to
      its thread, cronEmitNotify's crate settle (sliced from the sidecar), and a channel message's crate (the hub's onSettled: a
      Telegram / dev-channel crate rode to the OUTBOX for any reply that went out, a failed or provider-cut run's included).
      Since 4.2 (copies whose input or whose timing dropped the outcome, which no line-regex can see): the hub's settle reads its
      work line (a line a reviewer BLOCKED is no delivered crate — RunOutcome.ofLine, as a routine's fire); the hub's ENTRY stage
      hands its text down the line only when its run SUCCEEDED (a cut, limited, asking or endless entry bought every stage on its
      partial answer); the Telegram / dev-channel host delivers a crate only on the hub's proof (an unsettled message — no model, an
      E-STOP, a throw — rode to the OUTBOX); the trigger and SEND TO runners' run rows (index.js runsFor) and a hand-off's job record
      keep each row's outcome; the recipe run cache keeps the row's outcome for that helper, and the desk screen's idle view reads it; `starnet watch` prints
      the outcome-aware reason, and /api/observe carries the stamped outcome it reads.
      Since 4.3 (the REPORT copies, each driven with a cut and an error-outranked row): the MCP bridge's conversations_list /
      conversation_get carry the row's outcome and an outcome-aware reason; station.test_line labels each step by its run's outcome;
      line-stats' bay docks (station.layout / station.map's last run, and the bay lamp's seed after a reload) keep the outcome-aware
      reason and the outcome; the diagnostics bundle's last run; a background worker's settled record (the DELEGATED card's "failed ·
      done", /api/overseer, the subagent_stop hook); the `starnet run` receipt's headline; and ONE crate rule for a work line that
      stopped short or joined partial (routing/line-fire.js lineDelivered: the channel hub's crate rode to the OUTBOX for it, while the
      trigger / SEND TO runners and chain.js's own receipt refused it — the routine paths are held by the invariant table).
      Since 5.1 (the REASON a routine's fire hands on, which no line-regex saw: a local, a function argument, a `.lastReason`): a cut,
      raised or held fire's cron.result and record read cut_short / error / blocked on the scheduled path and through Run Now's settle
      (the HUD's "✕ routine failed — done"); routine.list carries the outcome-aware lastReason and the outcome; the routine's COMMS
      session marker, live and after a reload (the backfill and the busy reconcile); WorkView's last run; and team.resume, the third
      settle site of a background worker (its record, its durable delivery and team.subagents { runId }). The REPORT census now also
      reads a record's `lastReason` and a row's `x.error || x.reason` handed on as why it failed.
      Since 5.2 (a RIGHT resolver over the WRONG row, and a label inside a ternary, which no line-regex sees): a held fire's COMMS session
      after a reload and after a busy reconcile settles by its routine's record (the fire's outcome), never its entry run's 'succeeded' row,
      and the reconcile leaves a fire still in flight busy; a sequential team.dispatch hands a cut worker's partial answer on marked
      UNFINISHED by its outcome. (The two other readers of a fire's entry row, the routine's RUN HISTORY line and the away briefing, are
      held by the invariant table's held rows.)
      Since 5.3 (a right reader over the wrong FIELD, and a guard no REPORT regex saw): a routine record's lastStatus is no fire's outcome —
      a config block and an unfireable mark write 'error' beside the previous fire's lastRunId — so the page settles a fire by its record
      only when the record keeps the fire's outcome (lastOutcome: a clean fire stays ok after a block, a stop is no verdict); an older fire
      settled from its row fails for every unsuccessful row; a reload while a fire's work line runs leaves its session busy (GET /api/cron's
      inFlightRunId names the fire), the reconcile's poll outlives a long line, and a session a row settled ok says why once its fire's
      record holds it. The REPORT census reads a GUARDED reason too (`(x && x.reason) || 'unknown'`): the on_session_end hook's payload
      handed user hooks a cut run's bare 'done' through that shape — PARKED (runOnceCore freeze) then, closed by the unpark below.
      Since 6.1 (a right field that a mark which runs no fire clears): a config block and an unfireable mark clear lastOutcome beside the
      previous fire's lastRunId, so a HELD fire (its entry row 'succeeded') read ok after a reload or a busy reconcile once its routine was
      blocked — the fire's receipt (cron-store lastFire, written by markRun / markInterrupted only) keeps it failed. The REPORT census reads
      the `string(` wrapper and a guard with no opening paren (`reason: o && o.reason`): the skill review's evidence and input, and
      runOnceCore's learning-eligibility input, hand on the bare reason that way — PARKED then, closed by the unpark below.
      Since 6.2 (a coarse event word read as the outcome, a receipt kept for one fire only, and a predicate no pattern saw): a stopped fire's
      live cron.result ('failed' for every fire that did not succeed) settles its session by the fire's receipt, as a reload does — no
      verdict, never "⚠ Routine failed — cancelled" — and the HUD never toasts it as a failure; a held fire stays failed on the page once its
      routine fires again cleanly (the record keeps each unsucceeded fire's receipt: cron-store fireReceipts; RUN HISTORY and the away
      briefing are the table's). The decision census reads a reason PREDICATE (REVIEWABLE: `reviewableReason(result.reason)`): runOnceCore's
      _auxFail gate, the failure review's table and learning-eligibility's 'failed' kind — PARKED then, closed by the unpark below.
   Sidecar source is read only through test/helpers/source.js. The per-review measurements of this file stay with the lane's history on
   agent/typed-outcomes-1029, frozen at bb0a62df0.
   THE UNPARK (r7, 2026-10-30: runOnceCore is no longer frozen after the rebase onto run-wire-resolver). Every consumer parked above
   reads the run's outcome now, and its PARKED row is gone from ALLOWED / REPORTED: the quest sweep, the Task Brief settle, the
   postconditions' cleanTerminal and its input, the on_session_end hook's payload (reason outcome-aware, plus outcome / failure_code),
   the aux passes' gates (_auxDone, _auxFail) and their inputs (the failure review, the skill review, the verdict-review packet,
   learning-eligibility's base kind, failreview.js's table and prompt, learningevidence.js and verdictreview.js carry the outcome).
   Each decides from the LEAD's own facts (sidecar/lead-outcome.js: an own late error outranks the provider's cut, which outranks
   the end word), never the outcome sink's cache: the Task Brief / postcondition / hook decisions run before the buffered end
   reaches the sink, and runStore.record consumes endedOutcomes before the aux decisions. The buffer gate stays listed (it holds
   the lead's own end, cut short or not, until those assessments: no success claim). runOnceCore's up-front refusals and the image
   task's late error name their own failureCode (FriendlyError.CODE_TO_KIND words each), so none reads the sink's run_failure.
   Each is driven by test/outcome-unpark.test.js.
   THE STOP FAMILY and THE ERROR-FLAG FAMILY (review r7, 2026-10-30; the family law: a STOP is its own outcome — never reported or counted
   as a failure, and never as a success — and no surface takes a run's verdict from an error flag). The decision census reads three more
   shapes: ERROR_FLAG (a success word chosen by an error flag: the phone push titled every run "<agent> finished" unless evt.error was set),
   REPLY_GATE (a chat round trip's reply consumed on its error flag alone — Harness.chat / stationIO.chat hand back the run's outcome beside
   it, and a cut reply's lines became a goal's milestones, a pitch, an awakening's speech, a work-line stage's finished answer), and the
   AGGREGATE census (a failure COUNTER or RATE: every Stop counted toward the routine auto-pause, the briefing's "(K failed)", the "% success"
   denominator) — each hit reads the outcome on its line, names the stop apart, or is listed with why. The r7 folds drive the HUD's cron.result
   toast and ticker, the routine session's no-output stop, the phone push, a stopped worker's thread and batch lamp, the terminal floor, the
   counters (insights, recipe drift, the habit detector), the away briefing's loops / builds / delegated work / line stages, the work line's
   stop (halted), the build quest card, a stopped recommendation, the trigger / hand-off / sample / step-test jobs, an away build's attempt,
   DELIVERABLES' pill, the terminal's chat, Run Now's verdict and the routine's status word; the routine record, cron.result, the delivery
   headline, the auto-pause and a pause mid-run are the invariant table's r7 rows.
   Review 7.1 widened the reply gate to CHAT_RECEIVER (any name a file assigns a chat round trip's reply to: the page autopilot's cRes / dRes /
   qRes, the session starters' response) and drove the page autopilot (fold 22), the session starters (23), the night shift's review (24) and
   the habit detector's ok rule (13).
   Review 7.2 widened it again: the RELAY (a receiver handed on through `await Promise.race([name, …])` or `await until(name)` is a receiver)
   and the BARE GATE (`if (X.error || …`), for the page's wire preflight, which raced its Harness.chat from `call` into `res` and gated on
   `res.error || !text`: a cut, stopped, budget-ended or refused "OK" passed the wire, which its terminal twin (bin/lib/awaken.js) refuses.
   Fold 25 drives it.
   EACH OUTCOME ITS OWN WORD AND COLOUR, and THE MISSING OUTCOME (review r8, 2026-10-30; the family law: a stop is never a failure or a
   success, a question ('asked') never STOPPED and never failed, a failure never a stop, and a cut reply, a spend or step limit, an empty
   reply and a refusal each keep their own word; a reply or row with NO terminal outcome is never a success outside a documented
   compatibility fallback derived through RunOutcome). Review 7.3 found stationIO.chat resolving a stalled or end-less reply as a finished one
   (the census rows above that leaned on it were false), the Workshop's BUILD NOW toasting a stop as a failure, the task board filing a
   question under STOPPED and the terminal's crew card folding every unsuccessful end into one red "■ stopped"; the r8 sweep found the same
   folds across the terminal (the /goal pause, the floor, the FLOWS lamps, `starnet watch`, `starnet flow run`'s exit, the exit-code help),
   the page (the board, COMMS' presence card and stop toast, the delegated card, the routine session and NEEDS YOU, the HUD's routine toast,
   the ROUTINES card and RUN NOW, a loop pass, the build quest, a group turn, the desk screen, a recommendation's score, the summon link, the
   FINISH card and the step words) and the sidecar (the away briefing, a slash-command routine's hand-emitted 'done'). The census reads
   three more shapes across sidecar/, frontend/app/ and bin/: the OUTCOME MAP (a word / bucket / colour map keyed on the run-end vocabulary
   covers every outcome distinctly, or is listed in OUTCOME_MAPS with why), the OUTCOME FOLD (a one-kind ternary onto a literal bucket reads
   RunOutcome.look, or is listed in OUTCOME_FOLDS) and the MISSING OUTCOME (MISSING_OK lists the documented fallbacks). RunOutcome carries
   the one look per outcome (look / LOOK) and the word reader (ofWord). The r8 OUTCOME TABLE (folds r8.1 – r8.23) drives each fixed surface
   over the outcomes.
   REVIEW 8.2 (2026-10-30) found three copies no shape above saw. COMMS' presence card swapped a task run's own end word for 'done' when its
   reply carried a TASK_QUESTION marker (`taskQuestion ? 'done' : endWord`), so a run that ended asking read "■ RUN COMPLETE" under its own
   question card while the board read ASKED (a spend cap with the marker read RUN COMPLETE too). The worker ledger's bus 'task' event took its
   status from the bare ledger status (`r.status === 'done' ? 'done' : 'failed'`) and published every Stop as the literal 'failed' — the page's
   sound director played the failure sting for a stop, a question and a spend cap (shared/events.js widened the task status, additively) — and
   the subagent_stop hook carried no outcome. And the delegated card read the board's lastRunReason only as an END word, so an outcome word
   there ('asked', 'out_of_budget', 'step_limit', 'blocked', 'refused') read the red failed "ended · asked". The decision census reads three
   more shapes: DONE_OVER (an end word swapped for 'done'), STATUS_DONE (a ledger status read as the verdict) and FAILED_LITERAL (a terminal
   'failed' handed on as a literal); folds r8.27 – r8.29 drive the call site, the real worker manager with the page's task listener and the
   hook, and the delegated card.
   REVIEW 9 (2026-10-30; the 8.3 findings). COMMS' presence card, and the completed branch's else-if chain under it, read postconditionUnmet
   and the provider's cut BEFORE the run's outcome: a recipe run with acceptance rows read "■ VERIFICATION REQUIRED" when it asked, was
   stopped, hit a limit or was refused, a question whose reply was cut read "■ CUT SHORT", and a recipe run that asked toasted "finished but
   couldn't prove it worked"; the card gave every end but done the stop's 'stopped' class and gold, and an end-only failure 'stopped' after
   'err' (drawn gold). The card now reads ONE outcome table (chat.js PRESENCE_END: word, class, colour token) through presenceLook, the
   OUTCOME TABLES pin it (every outcome, each its own word, class and RunOutcome.look tone) and fold r9.1 drives the call site, the chain and
   the three stylesheets' cascade.
   A worker a restart or the liveness check cut off (the ledger's 'stale') was a stop in the failure red on the delegated card (cls 'stopped' with
   no halt, "stopped when the station restarted", a red "1 stopped" batch), the HUD's red fault "Lost when the station restarted" / "Stopped: made
   no progress" (an interrupted run the stop's lamp), NEEDS YOU's "Work stopped" and the project home's bare "stale", while RunOutcome.ofWorker
   and the bus said interrupted; and the delegated card read a 0.14.x thread's lastRunOk true (written then for every completed stream) as done.
   Each says INTERRUPTED in its own words and lamp now, a stop is never red, the page files a succeeded run's word beside its true, and the
   MISSING OUTCOME census reads a verdict flag taken as a success with no word (the board's and WorkView's are the listed compatibility
   fallback); law() reads an interruption too, and fold r9.2 drives the five surfaces.
   The 8.3 review also ran variant lines through the 8.2 shapes and found respellings they missed (a reversed `!x ? endWord : 'done'`, `?? 'done'`,
   `(r.outcome ?? 'succeeded') === 'succeeded'`, a double-quoted "failed", `emit('task', { status: 'failed' })`, a negated `status !== 'done' ?
   'failed'` and a tone else-branch), and OUTCOME_MAPS allowed a map by a substring needle, so a fold added inside an allowlisted map passed.
   Each shape reads its respellings (no live line spells them today), and a map row is the map's exact head line plus its content digest.
   The review 9 sweep found WorkView saying a FAILED run as "Run stopped or failed" and a question, a stop and every run that did not finish as
   one "Run outcome is unconfirmed"; fold r9.3 drives it over the board's verdict lines.
   REVIEW 9.2 (2026-10-30; the 9.1 findings). A failed run's stop line and toast said it "stopped on an error" (Friendly.stopLine and
   stop-reason.js stopSentence, in step), and fold r9.4 deleted the failed case before law(): it is under the law again. RunOutcome.reasonOf
   kept any reason but 'done' as it was, so an END-ONLY refusal (reason 'error', stamped 'refused') reached every reason-keyed reader as
   'error' — the HUD deck helper's FAULT, the logbook's "✕ error", the desk screen's FAILED lamp, the recipe helper's "errored", `starnet watch`, the MCP
   bridge, the bay docks, a routine's fire reason and runOnceCore's lead word (sidecar/lead-outcome.js); reasonOf reads the end's outcome
   now (a word the outcome contradicts reads the outcome's own end word), fold r9.6 drives the readers, r8.19 the desk screen and the
   recipe fixture its last run. The HUD deck helper's END_WORDS was still allowlisted with the reason 9.1 struck from FINISH ("one alarm colour":
   five unfinished ends in the failure's tone, an interrupted or held run in the stop's): it covers every outcome now, the unfinished ones
   warn, and fold r9.7 drives the helper (HudMode.view, which no page mounts). The recipe last-run helper (lastRunHTML, no caller yet) chose its class from the bare reason (a refusal and a cut reply the failure's
   red, a limit or an empty reply a success's plain look) under a word map no row allowed for colour: it says the row's outcome in its own
   word and RunOutcome.look's tone now, and fold r9.8 drives the helper with marketplace.css's cascade. COMMS' in-band background toast ("ROOK hit
   a problem", chosen by the error branch, never its stamp) and the phone push ("<agent> hit a problem" for a failed and a refused run alike,
   an error flag over any stamp) said a refusal in the failure's words: a refusal did not finish, a stop stopped, and fold r9.9 drives both.
   REVIEW 9.3 (2026-10-30; the 9.2 findings). routine.list invented a 'failed' stamp from a record's coarse lastStatus 'error', and since 9.2's
   reasonOf honours a stamp its reason contradicts, a PRE-LANE record's own end (a stop, a limit, a refusal, a question) listed as 'error'
   (B3-CD663-01): the status names the failure beside 'done' alone, and the routine.list block lists every pre-lane end word. The ROUTINES card
   drew such a record as the failure's red ✕ and /routine said "last error (…)" for any unsuccessful fire; both read the record's outcome
   (its stamp, else its own end word), fold r9.10. RunOutcome.PHRASE said a spend cap "stopped at a spending limit", the stop's word, on every
   RunOutcome.line surface: it hit one, and law() now fails an unfinished outcome worded or toned as the stop (and reads a hold against the
   failure). The bay lamp lit FAILED for a refusal and the two limits (UNFINISHED in its own word and the warn lamp now, counted apart: r9.11);
   the floor ticker tagged a run end with two tones (each run end carries its outcome's tone class now, its OUTCOME_FOLDS row gone: r9.12; `.cam-hud span`
   outranks those classes, so the colour on the page is follow-up B3-E01-01); the floor's two error beats said a refusal was a
   RUN FAULT, from the error event alone (r9.13, and THE ERROR BEAT census reads such a listener); COMMS' work log put the stop's ⏹ on every
   end (its outcome's mark now, live and replayed: r9.14); and the phone painted every unfinished run the failure red off the relay's state
   (the station sends RunOutcome.look's tone: r9.15, and the census walk reads relay/app). STATUS_DONE reads a negated test with a failure
   else branch again (B3-2C594-01).
   NOT CLOSED HERE: GitHub androoAGI/starnet-releases#9 (rel#9: a Deny should end the run 'denied' or 'stopped by user'). This lane
   adds no 'denied' outcome; rel#9 is deferred to the follow-up lane denied-outcome, which waits on the per-surface semantics
   (learning-eligibility.js's 'denied' kind moves with it; its base kind reads the outcome since the unpark). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { sidecarSourceFiles, sidecarTopLevelFunction } = require('./helpers/source.js');

const ROOT = path.join(__dirname, '..');
const RunOutcome = require('../frontend/app/runoutcome.js');

// ================================================= 1. THE CENSUS =====================================================
const BARE = /\b\w*[rR]eason\b\)?\s*(===|!==)\s*'done'|'done'\s*(===|!==)\s*[\w.()]*[rR]eason\b|\|\|\s*'done'\)\s*(===|!==)\s*'done'/;
// review 4.1: the same decision with no `=== 'done'` for BARE to see
const KEYED = /\[\s*(?:[A-Za-z_$][\w$]*\.)*(?:reason|ended)\s*\]/;      // a word map keyed on the reason: FINISH[row.reason]
const DEFAULT_DONE = /(?:\|\||\?\?)\s*(['"])done\1/;                        // a missing reason defaulted to 'done' (review 9: `?? 'done'`, either quote)
const ALIAS = /\b(?:why|ended|said)\s*(?:===|!==)\s*'done'/;               // the reason under another name
// review 6.2: a PREDICATE fed the bare reason — runOnceCore's _auxFail gate (`Failreview.reviewableReason(result.reason)`) decides from the
// end word alone whether a run failed in a way worth a failure review, the mirror of the parked _auxDone gate, and no pattern above saw it
const REVIEWABLE = /\breviewableReason\(\s*(?:[A-Za-z_$][\w$]*\.)*(?:reason|lastReason|why|ended)\b/;
// review r7, ERROR_FLAG: a SUCCESS word chosen by an error flag — the phone push titled a phone-started run `(evt.error ? ' hit a problem' :
// ' finished')`, so a cut, budget, step-limit, empty or never-ended run (none of which raise agent.run.error) pushed "<agent> finished"
const SUCCESS_WORD = '(?:finished|completed?|done|ran|succeeded|success(?:ful)?|delivered|shipped|COMPLETE|DONE|✓)';
const FLAG_WORD = '(?:[A-Za-z_$][\\w$]*\\.)*(?:error|err|errMsg|errorMessage|failed|threw)';
const ERROR_FLAG = new RegExp('\\b' + FLAG_WORD + '\\s*\\?\\s*([\'"`])[^\'"`]*\\1\\s*:\\s*([\'"`])[^\'"`]*\\b' + SUCCESS_WORD + '|!\\s*' + FLAG_WORD + '\\s*\\?\\s*([\'"`])[^\'"`]*\\b' + SUCCESS_WORD);
// review r7, REPLY_GATE: a chat round trip's reply consumed on its ERROR FLAG alone (`res && !res.error`, `!res || res.error`, a gate that ends
// `|| (res && res.error)) {`): Harness.chat and the terminal's stationIO.chat hand back the run's outcome beside the text, and a reply the provider
// cut (or a limit or a STOP ended) was taken whole. A gate line passes when it reads that outcome (`.outcome`) on the same line. (An error
// message read off a reply — `(result && result.error) || 'unknown'` — is no gate.)
// review 7.2, the BARE GATE: an `if` that opens on the reply's error flag (`if (res.error || !text)`) is the same gate — the page's wire preflight
// (app.js preflightWire) passed a cut or stopped "OK" on it and no shape above saw it (an error message read off a reply — `(wire.error ||
// wire.text)` — is still no gate)
const REPLY_GATE = /\b(res|result|reply)\s*&&\s*!\s*\1\.error\b|!\s*(res|result|reply)\s*\|\|\s*\2\.error\b|\|\|\s*\(\s*(res|result|reply)\s*&&\s*\3\.error\s*\)\s*\)\s*\{|\bif\s*\(\s*(res|result|reply)\.error\s*\|\|/;
// review 7.1, CHAT_RECEIVER: the same gate on ANY name a file assigns a chat round trip's reply to (`const dRes = await deps.chat(…)`,
// `const response = await generate(…)`, `const qRes = await nightshiftChat(…)`): REPLY_GATE read only receivers named res / result / reply, so
// the page autopilot's three replies (a cut draft became a finished desk draft, or a real file) and the session starters' never reached it
// (the round trips by name: Harness.chat / deps.chat / stationIO.chat / st.chat, deps.generate / generate, nightshiftChat — never a lookup
// such as resolveChat / peekChat / effectiveVoiceChat)
const CHAT_RECEIVER = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:until\(\s*)?(?:[A-Za-z_$][\w$]*\.)*(?:chat|generate|nightshiftChat)\s*\(/g;
// review 7.2, the RELAY: a receiver handed on through `await Promise.race([name, …])` or `await until(name)` is a receiver too (the wire
// preflight assigned its Harness.chat to `call` and raced it into the reply it gated; pitchstore.js's first move does the same), followed to
// its last receiver
const esc$ = s => s.replace(/\$/g, '\\$');
function replyGateIn(text) {
  const names = new Set();
  for (let m = CHAT_RECEIVER.exec(text); m; m = CHAT_RECEIVER.exec(text)) names.add(m[1]);
  CHAT_RECEIVER.lastIndex = 0;
  for (let grew = names.size > 0; grew;) {
    grew = false;
    const from = '(?:' + Array.from(names).map(esc$).join('|') + ')';
    const RELAY = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+(?:Promise\\.race\\(\\s*\\[\\s*' + from + '\\b|until\\(\\s*' + from + '\\s*[,)])', 'g');
    for (let m = RELAY.exec(text); m; m = RELAY.exec(text)) if (!names.has(m[1])) { names.add(m[1]); grew = true; }
  }
  if (!names.size) return null;
  const n = '(' + Array.from(names).map(esc$).join('|') + ')';
  return new RegExp('\\b' + n + '\\s*&&\\s*!\\s*\\1\\.error\\b|!\\s*' + n + '\\s*\\|\\|\\s*\\2\\.error\\b|\\|\\|\\s*\\(\\s*' + n + '\\s*&&\\s*\\3\\.error\\s*\\)\\s*\\)\\s*\\{|\\bif\\s*\\(\\s*' + n + '\\.error\\s*\\|\\|');
}
// the widening's own teeth (review 7.2): a relayed receiver's gate and a bare `if (X.error ||` gate are caught; a message read is not
{
  const relayed = replyGateIn("const call = Harness.chat({ internal: true }).catch(() => null);\nconst wireRes = await Promise.race([call, stall]);\nconst late = await until(wireRes);\n");
  A.ok(!!relayed && relayed.test('if (wireRes && !wireRes.error) go();') && relayed.test('if (late.error || !late.text) return;') && relayed.test('if (call.error || x) return;')
    && !relayed.test("const why = String((late && (late.error || late.text)) || 'no reply');"),
    'review 7.2: the reply-gate census follows a chat reply relayed through Promise.race / until to its last receiver and reads a bare `if (X.error ||` gate; an error message read off a reply is no gate');
  A.ok(REPLY_GATE.test("if (res.error || !String(res.text || '').trim()) return { ok: false };") && !REPLY_GATE.test("return (res.error || 'StarNet refused it.') + ' Nothing was shared.';"),
    'review 7.2: REPLY_GATE reads a bare `if (res.error ||` gate, never an error message read off a route result');
}
// review 8.2, DONE_OVER: a run's OWN end word swapped for the literal 'done' before it is reported (COMMS' presence card took `taskQuestion ?
// 'done' : endWord`, so a task run that ended asking read "■ RUN COMPLETE" while the board read ASKED), STATUS_DONE: a ledger STATUS read as
// the verdict (`r.status === 'done' ? 'done' : 'failed'`: the worker ledger published a question, a limit and a cut reply as failed work) and
// FAILED_LITERAL: a terminal 'failed' handed on as a literal (subagents.interrupt / cancelChildren published every Stop as `'failed'`)
// review 9 (the 8.3 review ran variant lines through these shapes): each also reads its common RESPELLINGS — DONE_OVER the reversed ternary
// (`!taskQuestion ? endWord : 'done'`), STATUS_DONE the negated test (`r.status !== 'done' ? 'failed' : 'done'`) and a TONE else-branch
// (`w.status === 'done' ? 'ok' : 'bad'`), FAILED_LITERAL either quote and a status key handed to an emitter (`emit('task', { status:
// 'failed' })`); DEFAULT_DONE above and MISSING_OUTCOME below read `??` and either quote
const REASONISH = "[A-Za-z_$][\\w$.]*(?:[rR]eason|[eE]nd[A-Z]?\\w*|Word|ended|why)\\b";
const DONE_OVER = new RegExp("\\?\\s*(['\"])done\\1\\s*:\\s*\\(?\\s*" + REASONISH + "|\\?\\s*\\(?\\s*" + REASONISH + "\\s*\\)?\\s*:\\s*(['\"])done\\2");
// (review 9.3, B3-2C594-01: the review 9 rewrite read only `===` before a failure ELSE branch and lost a spelling the 8.2 shape caught —
// `r.status !== 'done' ? 'done' : 'failed'`, a negated test with a failure else; either comparison reads it again)
const STATUS_DONE = /\bstatus\s*(?:===|!==)\s*(['"])done\1\s*\?\s*(?:'[^']*'|"[^"]*"|true|false|null)\s*:\s*(?:(['"])(?:failed|error|bad|fault|err)\2|false)|\bstatus\s*!==\s*(['"])done\3\s*\?\s*(?:(['"])(?:failed|error|bad|fault|err)\4|false)/;
const FAILED_LITERAL = /,\s*(['"])failed\1\s*\)|\b(?:emit|publish\w*|[\w$]+Emit)\s*\([^)]*\bstatus\s*:\s*(['"])failed\2/;
A.ok(DONE_OVER.test("resolvePresence(ws, { endReason: taskQuestion ? 'done' : endWord, cutShort: cutShort });") && !DONE_OVER.test("resolvePresence(ws, { endReason: endWord, cutShort: cutShort });")
  && STATUS_DONE.test("publishTask(r, r.status === 'done' ? 'done' : 'failed');") && !STATUS_DONE.test("publishTask(r);")
  && FAILED_LITERAL.test("publishTask(next || rec, 'failed');") && !FAILED_LITERAL.test("publishTask(next || rec);") && !FAILED_LITERAL.test("const w = kind === 'failed' ? 'failed' : 'did not finish';"),
  'review 8.2: the decision census reads an end word swapped for \'done\', a ledger status read as the verdict and a literal \'failed\' handed on; their replacements are not');
{
  const RESPELT = { DONE_OVER: [DONE_OVER, "resolvePresence(ws, { endReason: !taskQuestion ? endWord : 'done' });"], DEFAULT_DONE: [DEFAULT_DONE, "const r = p.reason ?? 'done';"],
    DEFAULT_DONE_DQ: [DEFAULT_DONE, 'const r = p.reason || "done";'], FAILED_LITERAL_DQ: [FAILED_LITERAL, 'publishTask(r, "failed");'],
    FAILED_LITERAL_KEY: [FAILED_LITERAL, "emit('task', { id: r.id, status: 'failed' });"], STATUS_DONE_NOT: [STATUS_DONE, "const s = r.status !== 'done' ? 'failed' : 'done';"],
    STATUS_DONE_TONE: [STATUS_DONE, "const tone = w.status === 'done' ? 'ok' : 'bad';"],
    // (review 9.3: the negated test with a failure ELSE branch, which the 8.2 shape caught and the review 9 rewrite dropped)
    STATUS_DONE_NOT_ELSE: [STATUS_DONE, "const word = r.status !== 'done' ? 'done' : 'failed';"], STATUS_DONE_NOT_ELSE_DQ: [STATUS_DONE, 'const word = r.status !== "done" ? "done" : "failed";'] };
  const missed = Object.entries(RESPELT).filter(([, [re, line]]) => !re.test(line)).map(([k]) => k);
  A.ok(!missed.length && !FAILED_LITERAL.test("job.status = 'failed';") && !FAILED_LITERAL.test("const row = { status: 'failed', at: now };") && !STATUS_DONE.test("const ok = r.status === 'done' ? 'shipped' : 'held';")
    && !STATUS_DONE.test("const ok = r.status !== 'done' ? 'held' : 'shipped';"),
    'review 9: the decision census reads the 8.3 review\'s respellings — a reversed ternary, `??`, either quote, a status key handed to an emitter, a negated status test (with a failure THEN or a failure ELSE, review 9.3) and a tone else-branch — and a record\'s own status is no hit (missed: ' + JSON.stringify(missed) + ')');
}
const FAMILY = [BARE, KEYED, DEFAULT_DONE, ALIAS, REVIEWABLE, ERROR_FLAG, DONE_OVER, STATUS_DONE, FAILED_LITERAL];
const READS_OUTCOME = /RunOutcome|fireOutcome\(|\bRO\.ofEnd\(|\boc \?|\(oc \?|&& oc\)/;
// review r7, AGGREGATE: a failure COUNTER or RATE — a Stop counted as a failure in each: the routine's consecutive-failure auto-pause (cron-store
// markRun), the away briefing's "(K failed)" / counts.failed, the "% success" denominator (insights `byReason.cancelled`). A hit passes when the
// line names the stop apart (NAMES_STOP) or is listed in AGGREGATED below with why a stop never reaches it.
const AGGREGATE = /\b[A-Za-z_$.]*(?:[fF]ailed|[fF]ailures|[fF]ailCount|[fF]ails)\s*(?:\+\+|\+=)|\bconsecutiveFailures\s*=(?!=)|\bbyReason\.(?:cancelled|stopped)\b/;
const NAMES_STOP = /\bstopped\b|'cancelled'|\blastRunOk\b/;
// review 4.3: the REPORT family — a run's bare reason handed on as how it ended (header, 1.)
// review 5.1: a routine record's last-run reason (job.lastReason) is a run's reason too — routine.list projected it bare
const RREF = '[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*\\.(?:reason|lastReason|lastRunReason)\\b(?!\\s*\\()';   // x.reason / run.dispatchDelivery.reason / job.lastReason, never x.reasonOf(…)
// review 5.3: or GUARDED — `(result && result.reason) || 'unknown'` (the on_session_end hook handed user hooks a cut run's bare 'done'
// through exactly that shape, and no WRAP saw it)
// review 6.1: and the `string(` wrapper (learningevidence.js) and a guard with no opening paren (`reason: o && o.reason`): the skill
// review's evidence and its input handed the model a provider-cut run's bare 'done' through those shapes, and the census printed OK
const WRAP = '(?:(?:\\(\\s*)?(?:str|String|string|text)\\()?(?:\\(*\\s*[\\w$.]+\\s*&&\\s*)?';   // the reason as is, wrapped: str(x.reason) / String(…) / string(…) / (text(job.lastReason) …, or guarded: (x && x.reason) / o && o.reason
const REPORT_KEY = new RegExp('\\b(?:reason|ended|end|result|status|state|said|why|lastReason|endReason|lastRunReason)\\s*:\\s*' + WRAP + '\\s*' + RREF);
const REPORT_CONCAT = new RegExp('\\+\\s*' + WRAP + RREF + '|' + RREF + '\\)?\\s*\\+\\s*[\'"`]');   // '■ ' + p.reason / x.reason + ' …'
const REPORT_TEMPLATE = new RegExp('\\$\\{\\s*' + WRAP + RREF);                                    // `${x.reason}`
const REPORT_LABEL = /\.reason\s*\)*\s*\|\|\s*'(?:unknown|ended|finished|ok|none)'/;                            // x.reason || 'unknown', (x && x.reason) || 'unknown'
// review 5.1: a row's error words, else its bare reason, handed on as why it failed (a routine session's "⚠ Routine failed — done" after a
// reload: a run-history row keeps no error field). A comparison (`run.error || run.reason === 'error'`) is the decision family's.
// The receiver is a run's by name (an HTTP answer's `j.error || j.reason` is a route's refusal, not a run's end).
const REPORT_ERR_OR_REASON = /\b(run|row|done|rec|recent|last|entry|res|result|job)\.error\s*\|\|\s*\1\.reason\b(?!\s*(?:===|!==|\())/;
const REPORT = [REPORT_KEY, REPORT_CONCAT, REPORT_TEMPLATE, REPORT_LABEL, REPORT_ERR_OR_REASON];
const CARRIES_OUTCOME = /\boutcome\s*:/;   // the projection carries the row's outcome beside its reason: its reader resolves it (RunOutcome.ofRow)
// receivers that by name hold a classifier's / policy's / gate's reason, never a run's end (the provider classifier, the recovery policy,
// a hook or consent decision, a safety gate, a sandbox / LSP / browser availability probe, a skill guard, a cron skip, a failover …)
const NOT_RUN_REASON = /\b(?:cls|decision|policy|gate|risk|safetyDeny|sel|avail|dec|fb|peer|plan|vr|voiceRoute|scanned|launchDown|marker|lastFailure|failure|configIssue|checked|sk|hit|pulledRow|tq|delta|sgg|fatal|initialFallback|startupWorkspaceRecovery|proposed)\.reason\b/;
const onlyNotRun = line => { const refs = line.match(/[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.(?:reason|lastReason|lastRunReason)\b/g) || []; return refs.length > 0 && refs.every(m => NOT_RUN_REASON.test(m)); };
/* file -> [[a substring of the line, why it is not a success decision (or why it is deferred)]] */
const ALLOWED = {
  'sidecar/channels/hub.js': [
    ["if (reason === 'done') {", "endNote: the stop note a 'done' end owes (StopReason names a provider cut); the delivery's outcome is decided by the lead's stamped end"]
  ],
  // (channel-delivery-ledger: a held reply is no longer replayed by the hub; the ledger's v1 migration takes it, below)
  'sidecar/channels/delivery-ledger.js': [
    ["reason: it.held.reason || 'done'", "the v1 migration of a HELD reply (inbox.json: a run that FINISHED and whose send the full outbox refused) keeps the delivery reason it was held with; a legacy receipt has none (delivery words, no success decision)"]
  ],
  'sidecar/channels/hub-delivery.js': [["if (EPHEMERAL[reason])", "not a run's end reason (the kind of hub message that is sent now and never queued: a command reply or a keyboard prompt)"]],
  'sidecar/billing.js': [["reason: str(o.reason || 'done')", "the managed spend ledger's receipt: read for dollars, never for success"]],
  'sidecar/browser-handoff-routes.js': [["[view.reason]", "not a run's end reason (a browser step-in's why: login / 2fa / captcha)"]],
  'sidecar/insights.js': [["byReason[reason] = (byReason[reason] || 0) + 1;", "reason is RunOutcome.reasonOf on the line above ('done' only for a SUCCEEDED run)"]],
  'sidecar/loop.js': [["return end(finalControl.reason || 'done');", "the loop PRODUCES its own 'it ended' word; the station stamps the outcome on that end (RunOutcome.sink)"]],
  'sidecar/mcp/transport.gmail-imap.js': [["AUTH_HELP[reason]", "not a run's end reason (an IMAP auth failure's kind)"]],
  'sidecar/outcomes.js': [
    ["k.failReasons[reason] = (k.failReasons[reason] || 0) + 1;", "the track record's fail tally, keyed on the reason the RunOutcome.ofRow check below re-decided"],
    ["let ok = SUCCESS[reason] === 1;", "the track record's first cut: a 'done' is re-decided by RunOutcome.ofRow a few lines below (asked / stopped skip, cut_short fails)"],
    ["if (!ok && FAILURE[reason] !== 1) continue;", "the track record's no-attempt skip (cancelled / clarifying / unknown)"]
  ],
  'sidecar/providers/errorClass.js': [["REASONS[reason] || REASONS.unknown", "not a run's end reason (the provider classifier's own reason)"]],
  'sidecar/recovery-policy.js': [["PRESTREAM_CONTINUABLE[cls.reason]", "not a run's end reason (the provider classifier's reason)"]],
  'sidecar/voice-chat-route.js': [["REASON_TEXT[reason]", "not a run's end reason (why the voice model was not used)"]],
  'sidecar/connector-continuation.js': [["row.reason !== 'done'", "a precondition to CONTINUE a connector task whose loop ended — a cut source is exactly what continue is for; no success claim"]],
  'sidecar/image-task.js': [["result.reason !== 'done' || input.clarifying", "it MAKES the failure: an image task whose loop ended 'done' without an image becomes an error"]],
  'sidecar/index.js': [
    ["if (reason === 'done') chanEmit('workitem.delivered'", "settleCronWorkitem's reason argument, 'done' only for a SUCCEEDED run (review 4.1 — the two event-driven callers fell back to the bare 'done'): cronEmitNotify passes RunOutcome.reasonOf (a cut reply 'cut_short'); a scheduled fire's crate is settled by the fire (cron-driver finishFire -> settleWorkitem: its outcome, its line included); Run Now passes fireOutcome's outcome; the backstops RunOutcome.resolve. FOLD below: cronEmitNotify, sliced"],
    ["AUTONOMY_SKIP_BINDING[p.reason]", "not a run's end reason (a cron.skipped event's skip reason)"],
    ["payload.runId === runId && payload.reason === 'done') {", "runOnceCore's BUFFER, no success claim: it holds the lead's own 'done' end (cut short or not — its finishReason rides the clone; a forwarded child's end never matches runId) until the image / Task Brief / postcondition assessment, and the re-emit settles its reason from the lead's facts (an image miss 'error', a question 'clarifying') before the outcome sink stamps it (the unpark; test/outcome-unpark.test.js drives the buffered end)"],
    ["if (imageTask && result && result.reason === 'done') {", "runOnceCore: it MAKES the image task's failure (image-task.js enforceCompletion); the late error names image_not_produced and outranks the apparent done (leadLateError, since the unpark)"],
    ["if (c && c.state === 'finished') return c.reason === 'done' ? 'completed'", "the continuation's reason is settled from its OUTCOME at the source (handleRun: a cut continuation is 'cut_short')"],
    ["(next.status === 'continued' && continuedReason === 'done') ? ''", "the same continuation reason, settled from its outcome at the source"],
    // review r7 REPLY_GATE: a route's own result, no chat reply
    ["if (!result || result.error) return json(400, { ok: false, error: (result && result.error) || 'rating failed' });", "no run's reply (the ratings route's own result: the rating store refused it)"],
    // review 7.1 CHAT_RECEIVER: the night shift's critique over nightshiftChat
    ["const crit = (qRes && !qRes.error) ? Autopilot.parseCritique(qRes.text", "the night shift's critique: nightshiftChat resolves a reply whose run did not SUCCEED as { error, outcome } (never parsed), and the line above stands the beat down for it (review 7.1: it shipped the draft as if reviewed); only a review whose run RAISED an error ships the finished draft unreviewed, as before (FOLD below)"]
  ],
  'sidecar/away-briefing.js': [["(dd ? (str(dd.reason) !== 'done' || (!str(dd.repairRunId) && failed(r))) : failed(r))", "the delivery's reason names a worker's non-success outcome (orchestration.js), and failed() is RunOutcome.ofRow; a worker stopped ('cancelled', halted on the line above) is said apart, never bad (review r7)"]],
  'sidecar/openai-compat.js': [
    ["if (contract.schema && acc.reason === 'done') {", "schema validation of a loop that ended; the response status is RunOutcome's (statusOf)"],
    ["if (repair.reason === 'done' && repaired.ok)", "the schema repair's own loop ended and validated"]
  ],
  'sidecar/skill-evaluation-runner.js': [["(result.reason === 'done' && streamAttempts.length === 0)", "accounting completeness, not success"]],
  'sidecar/skillevaluation.js': [["observation.reason !== 'done'", "the runner observes a provider-cut run as its outcome ('cut_short'), so 'done' here is a succeeded run"]],
  'sidecar/tools/builtin/orchestration.js': [
    ["if (row.reason === 'done' && !oc.ok)", "markWorkerOutcome: names a 'done' row's non-success outcome"],
    ["(row.reason === 'done' && row.outcome && row.outcome !== 'succeeded') ? row.outcome", "the delivery's reason names that outcome"],
    ["(r.reason === 'done' || r.reason === 'timeout')", "WHICH earlier workers' text a sequential dispatch hands on: a 'done' row that did not succeed (the provider cut it) left partial text, usable context as a timeout's is. The success claim is the block's label, which reads the row's outcome since review 5.2 (UNFINISHED — RunOutcome.line(ofRow); FOLD below): before, a cut worker went out unmarked under \"their finished output is your input\""]
  ],
  // (review 5.3: autosessions.js outcomeOfRun's `run.reason === 'done' ? 'failed' : null` was listed here as "a 'done' row that did not
  // succeed failed" — and that bare word left every other unsuccessful row (budget, step limit, refused, empty) with no verdict while it is
  // the older fire's fallback. It reads RunOutcome.ofRow now: ok only for a succeeded row, a stop no verdict, the rest failed; FOLD below.)
  'frontend/app/autosessions.js': [["return run.reason === 'done' ? 'ok' : null;", "outcomeOfRun's no-resolver fallback only (a node harness): the page loads runoutcome.js before autosessions.js (frontend/index.html), so on the page every row is settled by RunOutcome.ofRow on the line above"]],
  'frontend/app/delegated.js': [["if (reason === 'done') return { cls: 'done'", "fed by outcome-aware sources: the subagent's status, the delivery's reason (orchestration.js deliveryReasonOf on the LIVE station.deliver since review 4.1 — a cut worker's thread once arrived 'done' — and RunOutcome.reasonOf on the /api/runs reconcile), the board's noteRunEnd"]],
  'frontend/app/stationcommands.js': [
    ["indexOf(String(reason || 'done')) < 0) continue;", "the recovery policy for a delivery with no recorded reason (recover its text); noteOutcome never marks a missing reason ok"]
  ],
  'frontend/app/floorstats.js': [["else if (SLAG_REASONS[p.reason] || oc === 'failed')", "beside oc, the RunOutcome.ofEnd outcome computed on the line above: slag is a failed outcome or a slag reason"]],
  // (review 9.2: this row said x.reason is RunOutcome.reasonOf — but reasonOf kept any reason but 'done' as it was, so an end-only refusal reached the
  // deck as 'error', its FAULT; reasonOf reads the end's outcome now, FOLD r9.6)
  'frontend/app/hudmode.js': [["const w = END_WORDS[x.reason]", "x.reason is the recent row's RunOutcome.reasonOf (onRunEnd: the end's outcome decides it, an end-only refusal 'refusal' since review 9.2) or a run.error's own 'error' until the run's end supersedes it (onRunError)"]],
  'frontend/app/linewatch.js': [
    ["const endFailed = (x, reason) => {", "the lamp's FAILED test: a slag reason or a failed OUTCOME (ro.ofEnd), matching line-stats FAILED_OUTCOMES"],
    ["const endedFailed = !!ended && (row ? endFailed(row, ended)", "ended is endReason (RunOutcome.reasonOf) and endFailed reads the outcome"],
    ["state = endedFailed ? (unfinished ? 'unfinished' : 'failed') : ended === 'done' ? 'done' : 'ended';", "ended is RunOutcome.reasonOf: DONE only for a SUCCEEDED run (FOLD below); a dead run that did not fail is UNFINISHED by its outcome (deadOutcome, review 9.3, FOLD r9.11)"]
  ],
  'frontend/app/friendlyerror.js': [["REASON_TO_KIND[verdict.reason]", "not a run's end reason (the provider classifier's verdict)"]],
  'frontend/app/maintqueststore.js': [
    ["const c = t[reason];", "not a run's end reason (a maintenance jam's reason)"],
    ["JAM_REASON_WORD[jam.reason]", "not a run's end reason (a maintenance jam's reason)"],
    ["return !!(now[reason] && now[reason].count >= min);", "not a run's end reason (a maintenance jam's reason)"]
  ],
  'frontend/app/needsyou.js': [["STEPIN_WHY[h.reason]", "not a run's end reason (a browser step-in's why)"]],
  'frontend/app/stepin.js': [
    ["other: 'help with a page' }[p.reason]", "not a run's end reason (a browser step-in's why)"],
    ["(REASON[h.reason] || 'NEEDS YOU')", "not a run's end reason (a browser step-in's why)"]
  ],
  'frontend/app/xp.js': [
    ["if (RELIABILITY_ATTRIBUTED[p.reason]) {", "XP's S2 reliability BUCKET (who owns the run's ending), not its success: runsWon reads RunOutcome.ofEnd on the next line"],
    ["else if (RELIABILITY_EXCLUDED[p.reason] === 'faulted')", "the same reliability bucket (an error / empty run is excluded, never won)"],
    ["else if (RELIABILITY_EXCLUDED[p.reason] === 'neutral')", "the same reliability bucket (a stop / question is neutral, never won)"]
  ],
  // (frontend/app/deskscreen.js: its idle view read the history row's bare reason — listed here as rec.reason, which it never was. Review
  // 4.2: it reads lastRunRead's RunOutcome.reasonOf now, and the FOLD below drives it with a cut row.)
  // (review 9: chat.js's presence card `isStop = needsVerify || … opts.endReason !== 'done' || …` and the background notice's `(!endReason ||
  // endReason === 'done' || endReason === 'clarifying')` were listed here as "the outcome's own facts" / "words only" — the first put the
  // stop's class and the VERIFICATION / CUT SHORT words ahead of the run's outcome, the second took a reply with no end for a finished one.
  // presenceLook and the chain read the run's outcome (chipOc) now — FOLD r9.1)
  'frontend/app/chat.js': [
    ["if (!taskQuestion && (!endReason || endReason === 'done') && !cutShort && !postconditionUnmet", "COMMS' completed branch (reached only with no in-band error): cutShort + postconditionUnmet beside it are RunOutcome's facts"],
    ["if (endReason && endReason !== 'done' && endReason !== 'clarifying' && !taskQuestion) {", "COMMS' stop line for a non-'done' reason: its words read the end word (endWord, FOLD r9.4) and its mark and class the outcome's (endLogLine: RunOutcome.look, review 9.3, FOLD r9.14)"],
    ["if (!taskQuestion && (!endReason || endReason === 'done')) offerConnectorDoor", "the connector door offer after a reply (no success claim)"],
    ["if (wiPlaced && !taskQuestion && (!endReason || endReason === 'done') && !cutShort && !postconditionUnmet)", "the workitem delivery in COMMS' completed branch, with cutShort + postconditionUnmet beside it"],
    ["!VOICE_ROUTE_REASONS[vr.reason]", "not a run's end reason (why the voice route was not used)"],
    ["' not used — ' + VOICE_ROUTE_REASONS[vr.reason]", "not a run's end reason (why the voice route was not used)"]
  ],
  'bin/lib/cli-core.js': [["if (reason === 'done') return EXIT.OK;", "exitCodeForReason's legacy fallback when the caller passes no outcome (bin/starnet.js passes it)"]],
  // (review r8: the /goal step's pause read "the step stopped (<raw reason>)" off `if (reason && reason !== 'done')`; it words the step's outcome now —
  // goalStallOf, FOLD r8.6)
  'bin/lib/dashboard.js': [["raw = res && !res.error ? String(res.text || '') : '';", "the /goal judge over stationIO.chat, which resolves every reply whose run did not SUCCEED as { error, text, outcome } — an unfinished end (review r7) and, since review r8, a reply with NO end at all: a stall after some text, a stream that ended or closed before agent.run.end (no_terminal_outcome; FOLD r8.1). So !res.error is a succeeded verdict"]],
  // (review r8: bin/lib/floor.js's two \`why === 'done'\` lines folded every unsuccessful end into a red 'failed' flight, off the agent's LAST end; the
  // floor flies each ended run back by its own end through station-model endLook now — FOLD r8.4. bin/lib/station-io.js's reason-only end line
  // worded an unfinished reply with no text as "the run ended: <reason>", with no outcome; finish() words every one by RunOutcome — FOLD r8.1)
  // review r7 REPLY_GATE rows: a reply whose gate cannot read the outcome on its line because the outcome was settled where the reply was made
  'bin/lib/awaken.js': [
    // review r8: these claims were FALSE for a reply with no terminal outcome (review 7.3: a stall after one token resolved { text }); they hold now
    ["if (!res || res.error || !res.text) return null;", "stationIO.chat resolves every reply whose run did not SUCCEED as { error, text, outcome } (bin/lib/station-io.js): an unfinished end (review r7), and since review r8 a reply with no end at all — a stall past the time limit after some text, a stream that ended or closed before agent.run.end (no_terminal_outcome; FOLD r8.1). So !res.error is a succeeded reply"],
    ["if (res && !res.error && res.text) { try { ctx.birthLines = M.WakeMind.parseBirthScript(res.text); } catch (_) {} }", "the same stationIO.chat: an unfinished birth script — cut, limited, or cut off at the 90 s limit with no end (review r8) — is an error, never parsed"],
    // review 7.1 CHAT_RECEIVER
    ["if (wire && !wire.error && String(wire.text || '').trim()) return { provider: id, model };", "the wire test over the same stationIO.chat: a reply whose run did not succeed is { error, outcome } — a cut or stopped \"OK\", and since review r8 one streamed \"O\" that stalled past 30 s or a stream that closed with no end — so it never passes the wire (FOLD r8.1); the screen words a stop or a spending limit as itself (wireTestLine, FOLD r8.2)"]
  ],
  // (review r8: bin/lib/station-model.js's endRun log and statusOf compared the reason with 'done' and folded every other end into one red
  // "■ stopped"; both read the run's outcome through endLook now — FOLD r8.3)
};

/* review 4.3, the REPORT family: file -> [[a substring of the line, why handing that reason on reports no run's outcome (or why it is
   parked)]]. The lines review 4.3 fixed are gone from here: the MCP bridge's projection, station.test_line's steps, station.layout's
   last run, line-stats' docks, the diagnostics bundle's last run, a background worker's settled reason and the `starnet run` receipt
   all read RunOutcome now (FOLDS below). */
const NR = what => "not a run's end reason (" + what + ')';
const REPORTED = {
  'sidecar/acp/serve.js': [["(rt.readiness && rt.readiness.reason ?", NR("provider readiness, not a completed run")]],
  'sidecar/provider-readiness.js': [["reason: input.reason ||", NR("credential verification/readiness evidence")]],
  'frontend/app/keycta.js': [
    ["return { kind: 'reconnect', provider: p, reason: readiness.reason", NR("provider readiness prompt")],
    ["return { kind: 'notready', provider: p, reason: readiness.reason", NR("provider readiness prompt")],
    ["spokenLine = Chat.localLine(who + label + ': ' + gap.reason", NR("provider readiness prompt with cache disclosure")],
    ["return gap.provider.toUpperCase() + ': ' + gap.reason", NR("provider readiness prompt with cache disclosure")]
  ],
  'sidecar/browser-handoff.js': [["state: rec.state, reason: rec.reason, note: rec.note", NR("a browser step-in's why: login / 2fa / captcha")]],
  'sidecar/channels/hub.js': [
    ["could not be transcribed (' + ((tr && tr.reason)", NR('why a voice message could not be transcribed')],
    ["(q.reason ? ' — ' + q.reason : '')", NR("a Task Brief question's suggested-answer reason")]
  ],
  /* (channel-delivery-ledger: the OUTBOX and the held reply's receipt that store.js and hub.js kept are one delivery ledger,
     channels/delivery-ledger.js; what they listed here moved with them) */
  'sidecar/channels/delivery-ledger.js': [
    ["reason: str(d.reason, 60), runId: str(d.runId, 200)", "a delivery record read back from channels/delivery.json: the delivery reason its reply goes out with (the end note's word, or the send's own: 'command', 'note', 'routine'), never a success decision (the crate settled before the send)"],
    ["reason: str(t.reason, 60), error: str(t.error, 240)", "a tombstone: the delivery reason of a reply the platform refused for good (said once), never a success decision"],
    ["kind: str(x.kind || 'reply', 40), reason: str(x.reason, 60)", "a new delivery record: the delivery reason its reply goes out with, as above"],
    ["reason: it.reason, runId: it.runId, agentId: it.agentId, text: it.text, delayed: true", "the v1 migration of an OUTBOX item: the delivery reason its reply goes out with, as store.js kept it"]
  ],
  'sidecar/channels/outbound.js': [["kind: o.kind || 'notice', reason: String(o.reason || '')", NR("a send's path: 'routine', 'tool', 'notify', 'nudge', 'loop', 'note', 'offline'")]],
  // (sidecar/cron-driver.js: the routine record's reason was listed here as "the raw end word, its outcome code on the next line" — but
  // routine.list handed that word to the lead without the code, and cron.result carried the same bare 'done' to the HUD and the routine's
  // session. Review 5.1: finishFire settles ONE fireReason from the fire's outcome for both; the FOLD below drives a cut, raised and held fire.)
  'sidecar/cron-store.js': [["reason: String(info.reason || 'routine configuration is incomplete')", NR("a routine's configuration issue")]],
  'sidecar/dispatch-delivery.js': [["reason: String(value.reason || 'error'), repairRunId", "the dispatch delivery's reason: orchestration.js deliveryReasonOf (a worker's non-success outcome, never a bare 'done')"]],
  'sidecar/execution-router.js': [
    ["' but ' + res.reason + '. '", NR('why the sandbox profile is unavailable')],
    ["requested: res.requested, reason: res.reason", NR('why the sandbox profile is unavailable')]
  ],
  'sidecar/failreview.js': [
    ["(r.reason ? (' (' + String(r.reason)", NR("a recovery attempt's classifier reason")]
  ],
  'sidecar/group-sessions.js': [["sample: text(fields.sample, 2400), reason: text(fields.reason, 600),", NR("a participant's Task Brief question's suggested-answer reason")]],
  'sidecar/checkpoint-store.js': [
    ["restore point skipped: the folder could not be checked for links", NR("a restore point skipped because its folder could not be scanned for links")],
    ["reason: 'link_check_failed', detail:", NR("a rewind refused because the destination could not be scanned for links; a restore result")]
  ],
  'sidecar/index.js': [
    ["out.reason === 'link_in_path'", NR("a rewind refused for a link on its destination: the restore endpoint's answer")],
    ["out.reason === 'uncaptured_in_path'", NR("a rewind refused for a file no restore point holds: the restore endpoint's answer")],
    ["credits link self-heal declined: ' + r.reason", NR("the credits link's self-heal refusal")],
    ["'[subagents] worker ' + w.id", NR("a worker stall's receipt ('stalled: …')")],
    ["reason: e.reason || (e.kind === 'outcome' ? (e.delivered ? 'delivered' : 'stood-down')", NR("a night-shift autonomy event's skip / defer reason; its outcome rows say delivered or stood-down")],
    ["streamId: r.streamId, reason: r.reason, internal: !!r.internal", "nightshiftRecentRuns: the context pack and the readiness count read titles and streams only, never the reason (no outcome is claimed)"],
    ["canInterrupt: !!w.canInterrupt, reason: w.reason || '',", "/api/overseer workers: the worker record's reason, outcome-aware since review 4.3 (orchestration.js workerReason: the background starts; team.resume since review 5.1; FOLD below), beside its outcome-aware status"],
    ["reason: r.reason, usd: r.usd || 0, spendUnknown: !!r.spendUnknown", "the routine history route: each row carries its outcome / failureCode three lines below (the RUN HISTORY line reads RunOutcome.ofRow)"],
    ["'The library changed after preview. Preview cleanup again.', reason: out.reason", NR("the library cleanup's refusal")],
    ["reason: pd.reason || 'held by the skill guard'", NR("the skill guard's hold")],
    ["'- ' + w.name + ' -- ' + w.reason", NR("the skill guard's hold")],
    ["held: false, fired: false, reason: r.reason, feedbackMemory", NR('a verdict review\'s refusal ("nothing held for this run")')],
    ["reason: String(r.continuation.reason || '')", "the continuation's reason, settled from its OUTCOME at the source (handleRun: a cut continuation is 'cut_short')"],
    ["' reason=' + status.reason + ' saved='", NR("the learning status's own reason (owner_preference_saved …)")],
    ["reason: String(body.reason || 'user')", NR('why a memory was forgotten')],
    // the saved floor is the routing authority (routing/saved-authority.js): POST /api/routing answers whether the floor a page holds is the saved one
    ["unroutable: true, identity: r.identity, revision: r.revision, reason: r.reason", NR('why the saved floor routes nothing (the compiler refused it)')],
    ["pending: true, reason: r.reason", NR('why the floor a page posted is not the saved floor (yet)')],
    // (red at 4152883a1 + S2 before this lane touched it: the routine store's read-only publication note came in with the routine-history merge)
    ["readOnly: true, reason: cronDegraded.reason", NR('why the routine store publishes read-only, from its own degraded record')],
    // context-budget-and-fold (summary-ledger.js, summary-cover.js): the log tag a kept summary's refusal rides on. Each names the
    // LEDGER's own answer (why a stored summary was not served, not claimed or not written); none says how a run ended.
    ["failNote('summary.not-served.' + verdict.reason", NR("why the summary ledger would not serve a kept summary to this run: its validity check (model, window, voice, forgotten, digest …)")],
    ["failNote('summary.not-served.' + sub.reason", NR("why a valid kept summary could not stand in for this run's window messages: the substitution's placement check")],
    ["failNote('summary.no-claim.' + claim.reason", NR("why a fold's summary was not kept: the rows it stands for could not be proven")],
    ["failNote('summary.put.' + wrote.reason", NR("why the ledger refused to write a kept summary (tombstoned / too-large / invalid)")],
    // turn identity commit 14 (the dossier push): the answer to a pushed beliefs block says whether it was KEPT and, when not, why - the push named a run the delete reached
    ["reason: verdict.reason, forgotten: verdict.forgotten", NR("why the dossier store did not keep a pushed block: a run its beliefs were learned from was forgotten")],
    // the run-wire-resolver lane (this lane's base since the rebase): a wire resolution's reason is why a pair was chosen or passed over
    ["now: { provider: r.provider, model: r.model }, reason: r.reason", NR("why pairCronJobWires re-paired a routine's stored pair on load (its wireMigration note)")],
    ["') stored half a pair ') + JSON.stringify(note.was)", NR("the same re-pairing note, logged once")],
    ["(RunWire.SOURCE_LABELS[x.source] || x.source) + ': ' + x.reason", NR("why the Live Doctor's run-wire resolution passed a provider over")],
    ["ignored: (doctorWire.ignored || []).map(x => ({ source: x.source, provider: x.provider, reason: x.reason }))", NR("the same passed-over providers, in the Live Doctor report's wire block")],
    ["readOnly: true, reason: cronDegraded.reason", NR("why the routine store is held read-only: its saved publication metadata could not be confirmed (the degraded block of GET /api/cron), never a run's end")],
    // review 5.3 (the guarded shape `(x && x.reason) || …`, which WRAP / REPORT_LABEL did not see before):
    ["did not land (' + ((chained && chained.reason) || '?')", NR("an implement build's chain result ('built' / 'no-manifest' / 'run-failed' …: runImplementBuild), said in the shift's log")],
    ["autoBuildFailed: (chained && chained.reason) || 'unknown'", NR("the same implement build's chain result")],
    // (the step test's runDock sink, `st.err = st.err || ('no ' + …`, listed here for a capdenied's reason, moved into the ONE hop
    // executor with every other hop sink: sidecar/routing/line-runner.js, line-job-runner)
    // (review 5.3 listed the on_session_end hook's `reason: (result && result.reason) || 'unknown'` here, PARKED; since the unpark it hands
    // hooks the lead's outcome-aware reason beside outcome / failure_code — test/outcome-unpark.test.js)
    ["credits.finishRun({ runId, agentId, usd: finalUsd", "runOnceCore: the managed spend ledger's receipt (billing.js finishRun) — read for dollars, never for success"],
    ["runStore.record({ runId, parentRunId: o.parentRunId || ''", "runOnceCore: the run-history row's raw end word; the row's outcome is stamped beside it (runstore outcomeOf, fed by the run's RunOutcome.sink), and every reader asks RunOutcome.ofRow"],
    ["reason: (result && result.reason) || 'error', turns: finalTurns, tokens: finalTokens", "runOnceCore: the crash-recovery journal's finish record (run-journal.js finishAndRetire): it proves the run reached its end for retirement; nothing reads its reason as how the run ended"]
    // (review 6.1 listed the skill review's prompt input and runOnceCore's learning-eligibility input here, PARKED; since the unpark both
    // carry the lead's outcome beside its outcome-aware reason, as do learningevidence.js and verdictreview.js — test/outcome-unpark.test.js)
  ],
  'sidecar/loop.js': [["'blocked by your hook' + (pre.by", NR("a hook's block")],
    ["const refusalOf = r => (r && r.isError && typeof r.reason === 'string'", NR("a host tool refusal's reason, on the tool result")]],
  'frontend/app/backup.js': [["lines.push('  ' + String(g.path) + ': ' + String(g.reason));", NR("why a backup left a file out")]],
  'sidecar/loopjob-driver.js': [["String(extra.reason || '')", NR("a loop job's skip reason (its dedupe key)")]],
  'sidecar/lsp-manager.js': [
    ["server: descriptor.id, reason: got.reason", NR('why an LSP server is unavailable')],
    ["x.server ? x.server + ': ' + x.reason : x.reason", NR('why an LSP server is unavailable')]
  ],
  'sidecar/media-service.js': [
    ["lastReason = engine + ': ' + result.reason;", NR("a transcription provider's failure")]
  ],
  'sidecar/observer.js': [["reason: str(p.reason), turns: num(p.turns)", "the observer view of agent.run.end: it carries the stamped outcome / failureCode a few lines below (review 4.2); `starnet watch` reads RunOutcome.reasonOf off it"]],
  'sidecar/openai-compat.js': [["(s.reason ? { reason: s.reason } : null)", "an end built for RunOutcome.ofEnd on the next line (statusOf)"]],
  'sidecar/outcomes.js': [["' (top failure: ' + p.topFail.reason", "the track record's top failure: its tally is keyed on the outcome RunOutcome.ofRow re-decided (a cut 'done' counts as cut_short)"]],
  'sidecar/process-identity.js': [["return { verdict: 'unknown', reason: String(p.reason || 'unknown') };", NR("why a process's identity could not be read")]],
  'sidecar/remote/relay-client.js': [["(ev.reason ? ' ' + ev.reason : '')", NR("a websocket close's reason")]],
  'sidecar/remote/voice.js': [["'the station could not speak that (' + first.reason", NR('why speech synthesis failed')]],
  // (line-hold S2) a verdict gate's HOLD reason — blocked | missing_verdict | spent: why the walk stopped AT A GATE for a person, said by
  // line-fire.js lineStop('blocked') and routing/verdict.js heldWhy. The stop's code stays 'blocked' (a LINE_STOPS member, the run outcome's name
  // only by coincidence); no run ended here — the reviewer's reply was read, and nothing after it was bought
  'sidecar/routing/chain.js': [["lineStop('blocked', { loop: step.loop, reason: d.reason })", NR("a gate HOLD's reason (blocked | missing_verdict | spent): why the walk stopped at a gate for a person, never a run's end")]],
  'sidecar/routing/steptest.js': [["lineStop('blocked', { loop: step.loop, reason: d.reason })", NR("the same gate HOLD's reason, said in the step-through session's stop")]],
  'sidecar/routing/linejobs.js': [["reason: str(r.reason, 40) || 'error', usd: num(r.usd)", "a line job's step record: it keeps the row's outcome and (since review 4.3) failureCode on the lines below — the WORKFLOWS window reads RunOutcome.ofRow (FOLD below)"],
    ["s.hold = { reason: h.reason, why: h.why", NR("(line-hold S3) the WORKFLOWS row's view of a saved hold: why the walk stopped at a gate for a person (blocked | missing_verdict | spent), never a run's end")]],
  // (line-hold S3) the SAVED hold carries the same gate-hold reason as the stop (line-continuation.js holdRecord): the continuation the walk is parked
  // in, and the two handles the runner keeps of it (job.held, line.held) — a job waiting for a person, no run ended there
  'sidecar/routing/line-hold.js': [["hold: { gateId: String(hold.gateId), reason: hold.reason,", NR("a saved hold's reason (blocked | missing_verdict | spent): why the walk stopped at a gate for a person, never a run's end")]],
  'sidecar/routing/line-runner.js': [["reason: line.hold.reason, gateId: line.hold.gateId, pass: line.hold.pass", NR("a parked job's gate-hold reason (blocked | missing_verdict | spent), as the walk said it; never a run's end")]],
  'sidecar/run-execution-state.js': [["reason: String(row.reason || '').slice(0, 80), attempt:", NR("a recovery attempt's classifier reason")]],
  'sidecar/run-journal.js': [["reason: String(payload.reason || 'unknown'),", "the continuation_finish record: the host hands it the continuation's reason, settled from its outcome at the source (handleRun)"]],
  'sidecar/runstore.js': [
    ["reason: str(v.reason).trim().slice(0, 80) || 'error', repairRunId", "the dispatch delivery's reason (orchestration.js deliveryReasonOf: a worker's non-success outcome)"],
    ["action: str(x.action).slice(0, 40), reason: str(x.reason).slice(0, 80)", NR("a recovery attempt's classifier reason")]
  ],
  'sidecar/skills/market-format.js': [["reason: str(r.reason).replace(/\\s+/g, ' ')", NR('why a skill was pulled from the market')]],
  'sidecar/skills/market.js': [["rec.pulled = { reason: hit.reason", NR('why a skill was pulled from the market')]],
  'sidecar/skills/runtime.js': [["return { visible: d.visible !== false, reason: str(d.reason) };", NR("the skill guard's hold")]],
  'sidecar/slash-actions.js': [["'No away shift ran — ' + shiftReason(r.reason)", NR('why an away shift did not run')]],
  'sidecar/station-recovery.js': [["agg = { path: groupPath(key), reason: r.reason", NR('why station recovery skipped a file')]],
  'sidecar/subagents.js': [["reason: (result && result.reason) || (status === 'refused' ? 'refused'", "the worker's settled record: its runner hands it the outcome-aware reason (orchestration.js workerReason, RunOutcome.reasonOf since review 4.3; team.resume since 5.1), beside the status RunOutcome resolved on the line above"],
    ["result: r.result || '', reason: r.reason || '', usd: r.usd || 0,", "the worker record's view: its reason is outcome-aware since review 4.3 (orchestration.js workerReason; a team.resume generation since review 5.1), beside the outcome-aware status on the line above"]],
  'sidecar/taskbrief-tools.js': [["recommended: q.recommended || '', reason: q.reason || ''", NR("a Task Brief question's suggested-answer reason")]],
  'sidecar/terminal-sessions.js': [
    ["droppedChars: r.droppedChars || 0, reason: r.reason || '', outputPath", NR('why a terminal session ended')],
    ["droppedChars: r.droppedChars || 0, reason: r.reason || '', metadataPersisted", NR('why a terminal session ended')]
  ],
  'sidecar/tools/builtin/connectors.js': [["'- ' + x.id + ' — ' + x.reason", NR('why a connector is suggested')]],
  'sidecar/tools/builtin/orchestration.js': [
    ["text: userTextOf(row), reason: row.reason ? why : ''", "deliverToSession: why is deliveryReasonOf (a worker's non-success outcome, never a bare 'done')"],
    ["...(delivery ? { reason: delivery.reason, dispatchDelivery: delivery } : {})", "the delivery's reason is deliveryReasonOf's (outcome-aware)"],
    ["reason: effective.reason || 'error',", "the worker row's raw end word: markWorkerOutcome stamps a non-success outcome on the row (row.outcome) a few lines below, and workerOk / deliveryReasonOf / workerReason read it"],
    ["settle(r); return { status: 'error', reason: r.reason, result: r.result, usd: 0 };", "a worker whose run threw or the host stopped: status 'error' with the stop's own reason (hostStopRow), never 'done'"],
    ["settle(r); return { status: 'error', reason: r.reason, result: r.result, usd: r.usd, taintedBy", "the same host-stopped worker"],
    ["out.dispatchDelivery = { state: row.dispatchDelivery.state, reason: row.dispatchDelivery.reason", "the dispatch delivery's reason (deliveryReasonOf, outcome-aware); the row's outcome is picked beside it"]
  ],
  'sidecar/tools/builtin/browser.js': [
    ["'Could not select: ' + ((r && r.reason)", NR('why a browser select failed')],
    ["'Could not inspect: ' + ((r && r.reason)", NR('why a browser inspect failed')],
    ["host.request({ reason: a && a.reason, note: a && a.note", NR("a browser step-in's why (login / 2fa / captcha), the agent's own ask of the Commander")]
  ],
  'sidecar/tools/builtin/web.js': [["(r && r.reason === 'challenge' ?", NR("why a page fetch was held (a verification wall)")]],
  'sidecar/tools/builtin/resolve.js': [["': not probed (' + m.reason + ')", NR('why a media file was not probed')]],
  'sidecar/tools/builtin/station-control.js': [["disposition: d, reason: a.reason", NR("the lead's reason for a quest disposition")]],
  'sidecar/tools/builtin/terminal.js': [["(s.reason ? ' · ' + s.reason : '')", NR('why a terminal session ended')]],
  'sidecar/tools/builtin/voice.js': [["'speech synthesis failed' + (r && r.reason", NR('why speech synthesis failed')]],
  'sidecar/tools/registry.js': [
    ["'user-control denied: ' + ((authority && authority.reason)", NR("a user-control authority's refusal")],
    ["'capability denied: ' + ((g && g.reason)", NR("the capability gate's refusal")],
    ["'consent denied for ' + call.name + (c && c.reason", NR("a consent decision's reason")],
    ["return errResult('blocked by your hook' + (pre.by", NR("a hook's block")]
  ],
  'sidecar/workshop-store.js': [["reason: String((info && info.reason) || '').slice(0, 60),", NR("a workshop shift's outcome word ('built' / 'plan-fallback' / …: runWorkshopShift's noteShift)")]],
  'sidecar/workspace-owner.js': [["start time could not be read (' + String(v.reason || 'unknown')", NR("why a process's start time could not be read")]],
  'sidecar/workspace-recovery.js': [["if (block) return { code: block.code, reason: block.reason };", NR("why automatic recovery imported nothing: the station record's auto-import block (an erase, or a record or reset choice it cannot read)")]],
  'frontend/app/chat.js': [
    ["retry: { attempt: p.attempt, maxAttempts: p.maxAttempts, reason: String(p.reason || '')", NR("a provider retry's classifier reason")],
    ["recommended: q.recommended || '', reason: q.reason || ''", NR("a Task Brief question's suggested-answer reason")],
    ["resolveChip({ callId: e.callId, summary: e.summary, isError: e.isError, ms: e.ms, reason: e.reason }", NR("a host tool refusal's reason, on its chip")],
    ["isError: ev.isError, ms: ev.ms, reason: ev.reason }); presenceToolResult(ws);", NR("a host tool refusal's reason, on its saved chip")]
  ],
  'frontend/app/app.js': [["{ ok: false, reason: (r.j && r.j.reason) || '", NR("the permissions route's refusal (grant / revoke / bypass)")]],
  'frontend/app/build.js': [["return { ok: false, reason: (res && res.reason) || 'rejected' };", NR("a build route's rejection")]],
  'frontend/app/delegated.js': [["live: 'failed' + (w.reason && w.reason !== 'error'", "the DELEGATED card's failed words for a worker whose status is error / refused (the status decides): the worker record's reason, outcome-aware since review 4.3 (orchestration.js workerReason)"]],
  'frontend/app/deskscreen.js': [
    ["handoffs.set(p.agentId, { id: String(p.id), state: p.state, reason: p.reason || ''", NR("a browser step-in's why")],
    ["h = { id: String(r.id), state: r.state, reason: r.reason || ''", NR("a browser step-in's why")]
  ],
  'frontend/app/firstvalue.js': [["esc(ctx.reason || proposed.reason)", NR('why a first-value task is proposed')]],
  'frontend/app/floorstats.js': [["s.lastFailover = { fromModel:", NR("a model failover's classifier reason")]],
  'frontend/app/friendlyerror.js': [["/^cloud_\\d+$/.test(String(j.reason || ''))", NR("the account service's link refusal")]],
  'frontend/app/goalloop.js': [
    ["verdict: 'done', reason: j.reason,", NR("the session-goal judge's reason")],
    ["'✓ session goal: judge says done — ' + j.reason", NR("the session-goal judge's reason")],
    ["verdict: 'continue', reason: j.reason,", NR("the session-goal judge's reason")],
    ["' — judge: not yet, ' + j.reason", NR("the session-goal judge's reason")],
    ["lastVerdict: raw.lastVerdict || null, lastReason: raw.lastReason || null,", NR("the session-goal judge's last reason, restored from the page's save")]
  ],
  'frontend/app/harness.js': [["'station service halted: ' + String(g.reason)", NR('why the station service halted')]],
  // (review 9.3: the bay lamp's seed and its lit state carry the outcome beside the reason now — the lamp says it, FOLD r9.11)
  'frontend/app/maintqueststore.js': [["out.push({ jobId: job, reason: j.reason, skips: j.skips.length })", NR("a maintenance jam's reason")]],
  'frontend/app/marketplace.js': [["(e.reason ? ' <span class=\"mkt-lbl-hint\">— ' + esc(e.reason)", NR("a recipe intake question's hint")]],
  'frontend/app/questrefreshstore.js': [["reason: String(e.reason || ''),", NR("a quest refresh ledger entry's reason; its outcome rides the line above")]],
  'frontend/app/stationcommands.js': [["const said = delivery ? delivery.reason : row.reason;", "noteOutcome's reconcile: a 'done' said is re-read through RunOutcome.reasonOf on the next line"]],
  'frontend/app/stationui.js': [
    ["'the shift didn’t run (' + (p.reason || 'unknown')", NR('why an away shift did not run')],
    ["expired: !!(j && j.expired), reason: (j && j.reason) || ''", NR("an account link's status (a consumed refresh token's reason)")]
  ],
  'frontend/app/topbar.js': [["'restarted, but the station service still reports: ' + after.reason", NR("the station service's degraded reason")]],
  'frontend/app/voice.js': [
    ["return { kind: 'fail', reason: v.reason || v.code, verdict: v };", NR("a voice verdict's reason")],
    ["return { kind: 'fail', reason: v.reason, verdict: v };", NR("a voice verdict's reason")],
    ["return { text: (j && j.text) || '', reason: j && j.reason };", NR("the speech-to-text route's reason (why a transcript is empty)")]
  ],
  'frontend/app/workshopstore.js': [
    ["return { ok: true, reason: j.reason, agentId: aid, needsGrant: true,", NR("the workshop route's answer")],
    ["return { ok: true, reason: j.reason, agentId: aid };", NR("the workshop route's answer")]
  ],
  'frontend/app/world.js': [
    ["lineId: (w && w.lineId) || '', reason: (run && run.reason) || '' }", "the SLAG crate of a run the caller already judged dead (a slag reason or its failed outcome): the crate card reads the run's row through endReason (RunOutcome.reasonOf), never this field"],
    ["'FAILED · ' + String(s.reason || 'error').toUpperCase()", "the FAILED bay lamp's word: linewatch's outcome-aware reason (a raised 'done' seeded after a reload reads FAILED · ERROR since review 4.3, never FAILED · DONE)"]
    // (review r7: the HUD's "✕ routine failed — …" toast was listed here as cron.result's reason beside a failed outcome. It decides a STOP now
    // from cron.result's own 'stopped' / runOutcome (or the reason's leading word, an older station's) and says an auto-pause as itself
    // (pausedAfter); its words are no longer a bare `p.reason` concat, and the r7 FOLD drives the listener whole)
  ],
  'bin/lib/dashboard.js': [["'the folder was not trusted: ' + ((r.json && r.json.reason)", NR('why the trust route refused a folder')]],
  'bin/lib/cli-core.js': [["    reason: s.reason,", "jsonResult: the raw end word, with the run's outcome / failureCode on the next line and the exit code read from the outcome"]],
  'bin/starnet.js': [
    ["lastVerified: p.lastVerified || null, reason: p.reason || 'unverified'", NR("provider readiness status")],
    ["out.providerReadiness.filter(p =>", NR("provider readiness status")],
    ["' — reported as ' + summary.reason + ' (nothing proves the run finished)'", "an UNPROVEN run: the CLI's own fallback reason ('error' / 'cancelled'), said beside 'nothing proves the run finished'"],
    ["log('starnet: ' + ws + ' — ' + r.reason)", NR('why `starnet init` wrote no workspace')]
  ]
};

/* review r7, the AGGREGATE census: file -> [[a substring of the line, why a stop never reaches that failure counter]]. Counters of things that are
   no run's ending (a script, a frame, a send, a probe) are listed as such; a run counter is listed only when its predicate is stop-aware. */
const NOT_RUN = what => 'no run\'s ending (' + what + ')';
const AGGREGATED = {
  'frontend/app/bootguard.js': [["state.scriptFailures++;", NOT_RUN('a page script that failed to load')]],
  'frontend/app/build.js': [["frameFailures++;", NOT_RUN('a render frame that threw')]],
  'frontend/app/goalloop.js': [["if (j.parseFailed) s.parseFails += 1; else s.parseFails = 0;", NOT_RUN("the session-goal judge's unparseable verdicts")]],
  'frontend/app/propsprites.js': [
    ["try {image=responseOverlay(f,sample);} catch(_) {responseMetrics.failures++;return false;}", NOT_RUN('a sprite overlay that failed')],
    ["} catch(_) {responseMetrics.failures++;return false;", NOT_RUN('a sprite overlay that failed')]
  ],
  'frontend/app/voice.js': [["reply.fails++;", NOT_RUN("a spoken reply's sentence that failed to play: the reply's fail streak")]],
  'frontend/app/windows/connectors.js': [["catch (_) { fails++; }", NOT_RUN('a connector probe that failed')]],
  'sidecar/away-briefing.js': [
    ["if (bad) g.failed++;", "bad excludes a worker someone stopped (halted, the line above): its stop is g.stopped (review r7, FOLD below)"],
    ["f.failed = true; f.g.failed++;", "inside the failed(r) branch: failed() excludes a stop (review r7), which is the stopped branch below it"],
    ["if (failed(fire)) g.failed++;", "failed() is RunOutcome.ofRow's non-success EXCEPT a stop (review r7): a stopped fire is g.stopped (the invariant table's rows)"],
    ["if (failed(r)) g.failed++;", "the same stop-aware failed(): a stopped loop pass is g.stopped (FOLD below)"]
  ],
  'sidecar/channels/adapter.js': [["transientFailures++;", NOT_RUN('a channel send that failed')]],
  'sidecar/channels/delivery-ledger.js': [["l.fails++;", NOT_RUN("a chat lane's failed send (its backoff)")]],
  'sidecar/checkpoint-store.js': [["failures += r.failures;", NOT_RUN('a checkpoint write')]],
  'sidecar/index.js': [
    ["ledgerAppendFails++;", NOT_RUN('a ledger append that failed')]
  ],
  // (channel-delivery-ledger S1/S4: a routine's delivery left sidecar/index.js; one target that has not landed is one count)
  'sidecar/routine-delivery.js': [["failed++;", NOT_RUN("a routine delivery's chat target that has not landed")]],
  'sidecar/turn-soak.js': [["ledger.writeFailures++;", NOT_RUN('turn-identity soak ledger persistence; no agent execution outcome enters this counter')]],
  'sidecar/procledger.js': [
    ["if (failed) summary.killFailed++;", NOT_RUN('a process kill that failed')],
    ["summary.killFailed++; stale.push(r);", NOT_RUN('a process kill that failed')]
  ],
  'sidecar/providers/catalog-cache.js': [["const fail = () => { s.failAt = now(); s.fails++; };", NOT_RUN("a provider catalogue fetch")]],
  'sidecar/routing/line-stats.js': [["if (failedRow(r)) L.failed++;", "failedRow reads the FAILED reasons and FAILED_OUTCOMES (failed / refused / out_of_budget / step_limit) — never 'cancelled' / stopped"]]
};

function sourceFiles() {
  const out = sidecarSourceFiles().filter(f => /\.js$/.test(f.rel)).map(f => ({ rel: f.rel.replace(/\\/g, '/'), text: f.text }));
  const walk = dir => {
    for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + ent.name;
      if (ent.isDirectory()) { if (ent.name !== 'node_modules' && ent.name !== 'vendor') walk(rel); }
      else if (/\.js$/.test(ent.name)) out.push({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') });
    }
  };
  // (review 9.3: and the phone app — relay/app, a separate deploy — which painted every unfinished run the failure red off the relay's state)
  for (const d of ['frontend/app', 'bin', 'shared', 'relay/app']) walk(d);
  return out;
}
const files = sourceFiles();
A.ok(files.some(f => f.rel === 'sidecar/index.js') && files.some(f => f.rel === 'frontend/app/chat.js'), 'fixture: the census reads the sidecar (through the source helper) and the page');
const unlisted = [], unreported = [], unaggregated = [], used = new Set();
for (const f of files) {
  if (f.rel === 'frontend/app/runoutcome.js') continue;   // the resolver itself
  const chatGate = replyGateIn(f.text);   // review 7.1: this file's own chat-reply receivers
  f.text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (/^(\/\/|\*|\/\*)/.test(t)) return;   // a comment is not a decision
    const decides = FAMILY.some(re => re.test(line)) || ((REPLY_GATE.test(line) || (chatGate && chatGate.test(line))) && !/\.outcome\b/.test(line)), reports = REPORT.some(re => re.test(line));
    // review r7: a failure counter or rate — passes when it names the stop apart, or is listed in AGGREGATED with why a stop never reaches it
    if (!decides && !reports && AGGREGATE.test(line)) {
      if (NAMES_STOP.test(line)) return;
      const agg = (AGGREGATED[f.rel] || []).find(([needle]) => line.indexOf(needle) >= 0);
      if (agg) { used.add(f.rel + '::' + agg[0]); return; }
      unaggregated.push(f.rel + ':' + (i + 1) + '  ' + t.slice(0, 150));
      return;
    }
    if (!decides && !reports) return;
    if (READS_OUTCOME.test(line)) return;
    // a REPORT-only line that carries the row's outcome beside its reason, or reads only a classifier's / gate's reason, reports no run's end
    if (!decides && (CARRIES_OUTCOME.test(line) || onlyNotRun(line))) return;
    const allow = (ALLOWED[f.rel] || []).concat(REPORTED[f.rel] || []).find(([needle]) => line.indexOf(needle) >= 0);
    if (allow) { used.add(f.rel + '::' + allow[0]); return; }
    (decides ? unlisted : unreported).push(f.rel + ':' + (i + 1) + '  ' + t.slice(0, 150));
  });
}
A.ok(unlisted.length === 0, 'every bare-reason success decision reads the run\'s outcome, or is listed with why it claims no success (' + unlisted.length + ' unlisted):\n    ' + unlisted.slice(0, 40).join('\n    '));
A.ok(unreported.length === 0, 'every line that REPORTS a run\'s reason as how it ended reads the run\'s outcome, carries it, or is listed in REPORTED with why (' + unreported.length + ' unlisted):\n    ' + unreported.slice(0, 40).join('\n    '));
A.ok(unaggregated.length === 0, 'review r7: every failure COUNTER or RATE names the stop apart, or is listed in AGGREGATED with why a stop never reaches it (' + unaggregated.length + ' unlisted):\n    ' + unaggregated.slice(0, 40).join('\n    '));
for (const [rel, rows] of Object.entries(ALLOWED).concat(Object.entries(REPORTED), Object.entries(AGGREGATED))) for (const [needle] of rows) {
  A.ok(used.has(rel + '::' + needle), 'the census list stays true: ' + rel + ' still holds "' + needle.slice(0, 70) + '"');
}
/* review 9.3, THE ERROR BEAT: a listener on agent.run.error that SAYS a failure — a fault word, the failure's tone or its red — decided from the
   error EVENT alone. A provider safety block emits agent.run.error and ends the run refused, and the floor ticked "RUN FAULT" in red, strobed the
   desk red and had the agent say "something failed" (world.js): no line shape above reads a listener's body. A beat passes when its body reads
   the error's code (RunOutcome / failureCode); none is listed today. */
const ERROR_BEAT_HEAD = /\.on\(\s*(['"])agent\.run\.error\1\s*,\s*\(?\s*[\w$]*\s*\)?\s*=>\s*\{/g;
const ERROR_BEAT_SAYS = /FAULT|\bfail|\bbroke\b|['"]bad['"]|#ff4a3d|--bad\b/i;
function errorBeatsIn(text) {
  const out = [];
  for (let m = ERROR_BEAT_HEAD.exec(text); m; m = ERROR_BEAT_HEAD.exec(text)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1, lineEnd = text.indexOf('\n', m.index);
    const headLine = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    const indent = (/^\s*/.exec(headLine) || [''])[0];
    const close = text.indexOf('\n' + indent + '});', m.index);
    const body = /\}\);?\s*$/.test(headLine) ? headLine : text.slice(m.index, close < 0 ? text.length : close);
    if (ERROR_BEAT_SAYS.test(body) && !/RunOutcome|failureCode/.test(body)) out.push({ line: text.slice(0, m.index).split('\n').length, head: headLine.trim() });
  }
  ERROR_BEAT_HEAD.lastIndex = 0;
  return out;
}
A.ok(errorBeatsIn("    U.bus.on('agent.run.error', p => {\n      if (!p) return;\n      pushTicker(name + ' ▸ RUN FAULT · ' + msg, 'bad', suit);\n    });\n").length === 1
  && errorBeatsIn("    U.bus.on('agent.run.error', p => {\n      flashDesk(p && p.agentId, '#ff4a3d');\n    });\n").length === 1
  && errorBeatsIn("    U.bus.on('agent.run.error', p => {\n      const declined = RunOutcome.ofEnd(null, p).outcome === 'refused';\n      pushTicker(declined ? 'RUN DECLINED' : 'RUN FAULT', declined ? 'warn' : 'bad');\n    });\n").length === 0
  && errorBeatsIn("    U.bus.on('agent.run.error', p => { onRunError(S.feed, p, now()); if (S.active) render(); });\n").length === 0,
  'review 9.3: the error-beat census reads a failure said from the error event alone (a fault word, the failure\'s tone or red), and passes a beat that reads the error\'s code');
const beats = [];
for (const f of files) for (const b of errorBeatsIn(f.text)) beats.push(f.rel + ':' + b.line + '  ' + b.head.slice(0, 120));
A.ok(beats.length === 0, 'review 9.3: no agent.run.error listener says a failure from the error event alone — it reads the error\'s code (RunOutcome.ofEnd(null, error): a refusal is no fault) (' + beats.length + ' unread):\n    ' + beats.join('\n    '));

// =========================== 1b. review r8: THE OUTCOME MAPS, THE OUTCOME FOLDS and THE MISSING OUTCOME (static) ===========================
/* THE OUTCOME MAP (review r8, the family law: each outcome keeps its own word and colour). A word / bucket / colour map keyed on the run-end
   vocabulary (RunOutcome.OUTCOMES and the end reasons: an object literal with three or more of those keys) either covers EVERY outcome
   distinctly — its keys resolve (RunOutcome.ofWord) to all eleven outcomes, and no two outcomes share one value — or it is listed in
   OUTCOME_MAPS with why its fold is legitimate (a sub-map that only some outcomes reach, a protocol's coarser vocabulary, a posture key that is
   no outcome, …). The terminal's crew card, the delegated card, the board chip and the step words each folded distinct outcomes into one
   bucket ("■ stopped" for a failure, "1 stopped" for a spend cap, "✕ asked a question") and no census saw a map. */
const OUTCOME_VOCAB = new Set(RunOutcome.OUTCOMES.concat(Object.keys(RunOutcome.BY_REASON)));
// a vocabulary word -> its outcome (an outcome is itself; an end reason resolves): the census reads it from the resolver's own table
const wordOutcome = w => RunOutcome.isOutcome(w) ? w : RunOutcome.resolve({ reason: w }).outcome;
const MAP_LITERAL = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
/* EVERY BRACE PAIR (review 8.1). MAP_LITERAL alone is a CONSUMING one-level regex: a block whose inner braces nest one level deep (a whole
   function body) matched as one "literal" and swallowed every map inside it, so the presence card's endLabel map, the project home's worker
   words and the LOOPS window's binding words were never examined. objectSpans walks the source from every '{' to its matching '}' — strings,
   comments, template literals (and their ${…}) and regex literals skipped — and outcomeMapsIn reads every span (and every MAP_LITERAL match,
   so no map either way of reading finds is lost). */
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^}]/;
const REGEX_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|void|delete|throw|new|else|do|yield|await)$/;
function objectSpans(text) {
  const spans = [], stack = [];
  const n = text.length;
  let i = 0, inTpl = false, prev = '';
  while (i < n) {
    const c = text[i];
    if (inTpl) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { inTpl = false; prev = 'a'; i++; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push({ tpl: true }); inTpl = false; prev = '{'; i += 2; continue; }
      i++; continue;
    }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      i = j + 1; prev = 'a'; continue;
    }
    if (c === '`') { inTpl = true; i++; continue; }
    if (c === '/' && (!prev || REGEX_BEFORE.test(prev) || REGEX_KEYWORD.test(text.slice(Math.max(0, i - 12), i).trimEnd()))) {
      let j = i + 1, cls = false;
      while (j < n && text[j] !== '\n') { const d = text[j]; if (d === '\\') { j += 2; continue; } if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break; j++; }
      i = j + 1; prev = 'a'; continue;
    }
    if (c === '{') stack.push({ start: i });
    else if (c === '}') {
      const top = stack.pop();
      if (top && top.tpl) { inTpl = true; i++; continue; }
      if (top && top.start != null) spans.push([top.start, i + 1]);
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return spans;
}
// the top-level `key: value` entries of an object literal's source (strings, comments and nested brackets skipped)
function topEntries(src) {
  const body = src.slice(1, -1), parts = [];
  let depth = 0, q = '', cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === '\\') { cur += body[++i] || ''; continue; } if (c === q) q = ''; continue; }
    if (c === '/' && body[i + 1] === '/') { const nl = body.indexOf('\n', i); i = nl < 0 ? body.length : nl; continue; }
    if (c === '/' && body[i + 1] === '*') { const e = body.indexOf('*/', i + 2); i = e < 0 ? body.length : e + 1; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; cur += c; continue; }
    if ('([{'.indexOf(c) >= 0) depth++;
    else if (')]}'.indexOf(c) >= 0) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => /^\s*(?:'([A-Za-z_]+)'|"([A-Za-z_]+)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(p)).filter(Boolean)
    .map(m => ({ key: m[1] || m[2] || m[3], value: m[4].replace(/\s+/g, ' ').trim() }));
}
function outcomeMapsIn(text) {
  const out = [], cands = new Map();   // span start -> its source (a brace pair first; a MAP_LITERAL match only where no pair starts)
  for (const [a, b] of objectSpans(text)) if (b - a <= 20000) cands.set(a, text.slice(a, b));
  for (let m = MAP_LITERAL.exec(text); m; m = MAP_LITERAL.exec(text)) if (!cands.has(m.index)) cands.set(m.index, m[0]);
  MAP_LITERAL.lastIndex = 0;
  for (const [index, src] of [...cands.entries()].sort((x, y) => x[0] - y[0])) {
    const m = { 0: src, index };
    const entries = topEntries(m[0]).filter(e => OUTCOME_VOCAB.has(e.key));
    if (new Set(entries.map(e => e.key)).size < 3) continue;
    const byOutcome = new Map();
    for (const e of entries) { const o = wordOutcome(e.key); if (!byOutcome.has(o)) byOutcome.set(o, e.value); }
    const missing = RunOutcome.OUTCOMES.filter(o => !byOutcome.has(o));
    const shared = [];
    const seen = new Map();
    for (const [o, v] of byOutcome) { if (seen.has(v)) shared.push(seen.get(v) + '=' + o); else seen.set(v, o); }
    const lineNo = text.slice(0, m.index).split('\n').length;
    out.push({ line: lineNo, head: text.split('\n')[lineNo - 1], src: m[0], missing, shared });
  }
  MAP_LITERAL.lastIndex = 0;
  return out;
}
/* THE OUTCOME FOLD: a line that tests a run's OUTCOME against one or two kinds and sends every other to ONE literal bucket — `o.ok ? 'ok' :
   (o.outcome === 'stopped' ? 'stopped' : 'failed')` (the routine session: a question, a cut reply and a spend cap all 'failed'), `chipOk = … ?
   null : false` (the board: a cut reply FAILED). It passes when it reads RunOutcome.look (the one look per outcome); every other hit is listed in
   OUTCOME_FOLDS with why its catch-all is legitimate. (An if-chain fold — the CLI's exit codes, the HUD's routine toast — is driven by the r8
   OUTCOME TABLE below.) */
const FOLD_KIND = '(?:succeeded|asked|cut_short|failed|refused|stopped|out_of_budget|step_limit|empty|interrupted|blocked)';
// (review 8.1: the outcome under any name — chipOc, fireOc, errOc, a `kind` or `k` an outcome was read into — not only outcome / oc / runOc / ended)
const FOLD_TEST = new RegExp("(?:[oO]utcome|\\boc|[\\w$]Oc|\\bkind|[\\w$]Kind|\\bk)\\s*[!=]==\\s*'" + FOLD_KIND + "'|\\.test\\([\\w$.]*outcome\\b|\\b(?:oc|runOc|ended|outcome|[\\w$]*Oc|[\\w$]*Outcome)\\.ok\\s*\\?");
const FOLD_TAIL = /\?\s*(?:'[^']*'|"[^"]*"|true|false|null)\s*:\s*(?:'[^']*'|"[^"]*"|true|false|null)\s*\)*\s*(?:[;,}\]]|$)/;
/* THE MISSING OUTCOME (review r8): a reply or row with NO terminal outcome is never a success — `!res.outcome || res.outcome === 'succeeded'`,
   `!runOutcome ||`, `|| 'succeeded'`, `outcome == null ? true`, and a resolver SKIPPED for a missing end (`endP ? RunOutcome.ofEnd(endP) : null`:
   stationIO.chat resolved a stalled or end-less reply as a finished one). A hit is listed in MISSING_OK only as a DOCUMENTED compatibility
   fallback whose outcome is derived through RunOutcome from the facts it has; anything else fails. Review 8.1 widened it to the same rule in
   other words: `x.outcome == null ||` / `=== undefined ||`, `typeof x.outcome !== 'string' ||`, `x.outcome ? x.outcome === 'succeeded' : true`
   (or `: !x.error`), and a skipped resolver whose else branch is a success (`endP ? RunOutcome.ofEnd(endP) : { ok: true }`). */
const MISSING_OUTCOME = new RegExp([
  /!\s*[A-Za-z_$][\w$.]*\.outcome\s*\|\||!\s*runOutcome\s*\|\||(?:\|\||\?\?)\s*(?:'succeeded'|"succeeded")|[oO]utcome\s*==\s*null\s*\?\s*(?:true|'ok'|'done'|'succeeded')/.source,
  /\b([A-Za-z_$][\w$.]*)\s*\?\s*(?:RunOutcome|RO)\.of(?:End|Row)\(\s*\1\b[^)]*\)\s*:\s*(?:null|undefined|''|true|'ok'|'succeeded'|\{\s*(?:ok\s*:\s*true|outcome\s*:\s*'succeeded'))/.source,
  /\b[A-Za-z_$][\w$.]*\.outcome\s*===?\s*(?:null|undefined)\s*\|\||\b(?:runOutcome|outcome)\s*===?\s*(?:null|undefined)\s*\|\|/.source,
  /\btypeof\s+(?:[A-Za-z_$][\w$.]*\.outcome|runOutcome|outcome)\s*(?:!==?\s*'string'|===?\s*'undefined')\s*\|\|/.source,
  /[oO]utcome\s*\)?\s*\?[^:;?]*:\s*(?:true|'ok'|'done'|'succeeded'|!\s*[A-Za-z_$][\w$.]*\.(?:error|err)\b)\s*\)*\s*(?:[;,}\]]|$)/.source,
  // review 9: a thread's VERDICT flag read as a success with no outcome beside it — a 0.14.x save wrote lastRunOk true for every completed
  // stream (a question, a cut reply) with no word; a reader passes when the same line reads the filed word (RunOutcome.ofWord(…lastRunReason))
  /\blastRunOk\s*===\s*true\b(?![^;]*RunOutcome\.ofWord\([^)]*lastRunReason)/.source
].join('|'));
const FOLD_OK = 'its catch-all is legitimate: ';
/* OUTCOME_MAPS: file -> [[the map's EXACT head line (trimmed), its content's digest, why its fold is legitimate]]. Review 9 (8.3: a row matched by a
   SUBSTRING needle anywhere in the map — "const FINISH = {", "out_of_budget: 'budget limit reached'" — so a new fold added inside an allowlisted
   map still passed): a row allows ONE map, the one whose head line is exactly its anchor and whose source (whitespace collapsed) hashes to its
   digest. Any edit to an allowlisted map fails here until its row is re-justified; the failure prints the head and digest the map has now. */
const mapDigest = m => crypto.createHash('sha256').update(m.src.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
const mapRowFor = (table, rel, m) => (table[rel] || []).find(([head, digest]) => m.head.trim() === head && mapDigest(m) === digest);
const OUTCOME_MAPS = {
  'sidecar/acp/core.js': [
    ["const STOP_REASON = {", '2dd8f10a79a1', "the ACP protocol's stopReason vocabulary (end_turn · max_tokens · max_turn_requests · refusal · cancelled) is coarser than the run's outcomes by its spec: an editor gets the protocol's word, and the outcome rides beside it in _meta"],
    ["const STOP_REASON_OF = { succeeded: 'end_turn', asked: 'end_turn', step_limit: 'max_turn_requests', stopped: 'cancelled', refused: 'refusal',", 'cd872f8179f7', "the same ACP stopReason map, keyed on the outcome; cut_short is decided apart on the line below it (max_tokens / refusal by finishReason)"]
  ],
  'sidecar/failreview.js': [["const REVIEW_OUTCOMES = { failed: 1, refused: 1, step_limit: 1, out_of_budget: 1 };", '3c9777b6ca9c', "a SET (which outcomes earn a failure review), no word or colour map: a stop, a question, a cut reply and an empty reply earn none by design"]],
  'sidecar/openai-compat.js': [["const V1_STATUS = { succeeded: 'completed', asked: 'awaiting_input', cut_short: 'limited', out_of_budget: 'limited', step_limit: 'limited',", '95b19ab7529e', "the OpenAI Responses `status` vocabulary (completed · incomplete · failed · cancelled · …) is coarser by the API's spec — a cut reply and a spend cap are both 'incomplete' there, its incomplete_details.reason says which (statusOf / incompleteReasonOf)"]],
  'sidecar/outcomes.js': [["const FAILURE = { error: 1, max_iters: 1, budget: 1, refusal: 1, empty: 1 };", '885ad0ff5c9b', "a SET (the track record's FAILURE reasons), re-decided by RunOutcome.ofRow below it — no word or colour map"]],
  'sidecar/routing/linejobs.js': [["const STATUSES = Object.assign(Object.create(null), { running: 1, paused: 1, held: 1, delivered: 1, problem: 1, stopped: 1, failed: 1, interrupted: 1 });", 'f2ebff2adb06', "a SET of LINE JOB lifecycle statuses, never one run's outcome; held requires a validated continuation, while paused and terminal blocked keep their existing meanings"]],
  // (line-job-runner) a work line's typed stop: keyed by RunOutcome.LINE_STOPS, two of whose codes share a run outcome's name
  'sidecar/routing/line-fire.js': [["const STOP_WORDS = Object.freeze({", '52cbd8f3a64d', "the ONE sentence per LINE STOP code (RunOutcome.LINE_STOPS: where a work line's walk stopped, never one run's outcome) — 'stopped' and 'blocked' are line stop codes that share an outcome's name, and a hop's run outcome reaches these words only through line-runner.js hopVerdict's stopCode (stage_incomplete / stage_failed / stage_empty / stopped / station_fault)"]],
  // (review 8.2: publishTask published the bare ledger status — 'failed' for a stop, a question and a limit; FOLD r8.28 drives it)
  'sidecar/subagents.js': [["const TASK_STATUS = { succeeded: 'done', failed: 'failed', stopped: 'stopped', asked: 'asked' };", '9026e429bd1b', "the bus 'task' STATUS (publishTask): the v7 event's coarse lifecycle (queued · running · done · failed · stopped · asked · unfinished, shared/events.js) — a success, a failure, a stop and a question each their own, every other end that did not finish 'unfinished' with its outcome and failureCode riding beside it"]],
  'frontend/app/delegated.js': [
    ["const WHY = { refused: 'couldn\\'t start (too many running, or a sign-in is needed)', timeout: 'ran out of time', empty: 'the model sent an empty reply', refusal: 'the model declined the task',", '5c920a2a6b2f', "the subagent LEDGER's reason codes ('refused' = it couldn't start, timeout, output_limit, …), no run outcomes: words for a worker record's reason, read only after stateOf has settled its outcome"],
    ["const UNFINISHED_LIVE = { out_of_budget: 'budget limit reached', step_limit: 'step limit reached', cut_short: 'cut short by the provider', empty: 'the model sent an empty reply', refused: 'the model declined the task',", '9bdfab04cd00', "UNFINISHED_LIVE (review r8): the words for the unfinished outcomes ONLY — stateOf decides succeeded / stopped / asked / failed before it ever reads this map"],
    ["const WORD = { recorded: 'delivered', working: 'working', waiting: 'needs you', done: 'done', failed: 'failed', stopped: 'stopped', asked: 'asked a question', unfinished: 'did not finish', interrupted: 'interrupted', queued: 'starting', unknown: 'status unknown' };", '201b35df50bd', "the card's STATE words (cls: recorded / working / waiting / done / failed / stopped / asked / unfinished / interrupted …), keyed on stateOf's state, each distinct — not on a run's outcome"]
  ],
  'frontend/app/floorstats.js': [["const SLAG_REASONS = { max_iters: 1, budget: 1, error: 1, refusal: 1 };", '080269391c6f', "a SET (the floor's slag reasons, beside the failed outcome on its reader's line), no word or colour map"]],
  'frontend/app/group-chat.js': [["const VERB = { queued: 'queued', held: 'ready', connecting: 'connecting…', running: 'working', 'waiting for answer': 'waiting for your answer', 'waiting for approval': 'needs approval', stopping: 'stopping', failed: 'failed', unfinished: 'did not finish', interrupted: 'interrupted', stopped: 'stopped' };", 'b0b8a0e59cd8', "a group TURN's state words (queued / running / failed / unfinished / interrupted / stopped …), each distinct — a turn's state, not a run's outcome"]],
  'frontend/app/hudmode.js': [
    // (review 9.2: END_WORDS left this list — it was allowed with the reason 9.1 struck from FINISH, "one alarm colour": five unfinished ends in the
    // failure's 'bad' tone, and an interrupted or held run fell to the stop's 'dim'; each end has its own word and the unfinished ones warn, FOLD r9.7)
    // (review 9.1: FINISH left this list — it was allowed as "the HUD's one alarm lamp", five unfinished ends in the failure's fault red, two worded
    // "Stopped at …"; each outcome now has its own card word and the unfinished ones the warn card, FOLD r9.5)
    // (review 8.1: this row said "not a run outcome" while status 'error' WAS the fold of every unsuccessful end — a worker that asked or hit a
    // limit read a red "Needs attention". workerEnd reads such a worker's end back through RunOutcome.ofWorker first — FOLD r8.25)
    ["const WORKER_END = {", '9f58fe69b062', "a background WORKER's record STATUS words (done / interrupted / error / refused / stale), read only after workerEnd has said a worker whose 'error' status folds an unfinished end — a question, a limit, a cut reply (RunOutcome.ofWorker) — by its own end (FINISH): 'error' here is a FAILED worker's alone, 'refused' one that could not start, 'stale' (a restart) the interrupted card's own state (review 9: it was the fault red, FOLD r9.2)"]
  ],
  // (review 8.1: unseen until the census read every brace pair — FOLD r8.25 drives it)
  'frontend/app/project-home.js': [["return [{ done: 'Completed', interrupted: 'Stopped', error: 'Needs attention' }[worker.status] || worker.status, worker.status === 'interrupted' ? 'stopped' : worker.status];", '9eeb0b874b83', "a background WORKER's record STATUS words, read only after workerEnd has said a worker whose 'error' status folds a question, a limit or a cut reply (RunOutcome.ofWorker) by its own end: 'error' here is a FAILED worker's alone (review 9: a 'stale' worker is said as interrupted before it, never the bare word; FOLD r9.2)"]],
  'frontend/app/windows/loops.js': [["const map = {", 'f4e815e49325', "the LOOPS window's BINDING words (LJ.decide's binding: why a loop is not firing — queue-full · done · dormant · paused · stopped · budget · …), each distinct: a loop's state, never one run's outcome"]],
  // (review 8.1) NEEDS YOU's door labels, keyed on the row's END bucket (endOf: RunOutcome.look's tone), never on one run's outcome
  'frontend/app/needsyou.js': [
    ["const END_LABEL = { failed: { failed: 'Work failed', asked: 'Question', unfinished: 'Work did not finish', stopped: 'Work stopped' },", 'c65d8d25bb8f', "a worker row's door label per END bucket (endOf: failed · asked · unfinished · stopped, RunOutcome.look's tones), each distinct; the row's own words (reasonOf: RunOutcome.line) say which unfinished outcome it was"],
    ["routine: { failed: 'Routine failed', asked: 'Routine asked a question', unfinished: 'Routine did not finish', stopped: 'Routine stopped' } };", 'fbf135701235', "a routine row's door label per END bucket (endOf), each distinct; its line's verb names the unfinished outcome (routineVerb: RunOutcome.look's word)"]
  ],
  'frontend/app/linewatch.js': [
    ["const FAILED = { error: true, refusal: true, max_iters: true, budget: true };   // the floor's dead-run (slag) set", 'e30242af5bdd', "a SET (the floor's dead-run reasons, matching line-stats: which ends the bay holds), no word map — since review 9.3 the lamp's word and colour are the outcome's (deadOutcome: FAILED for a failure, UNFINISHED in its own word for a refusal or a limit, FOLD r9.11)"],
    ["const FAILED_OUTCOMES = { failed: true, refused: true, out_of_budget: true, step_limit: true };", '5a0759c83c90', "a SET (the dead-run outcomes, matching line-stats FAILED_OUTCOMES: which ends the bay holds), no word map — the lamp says each in its own word (review 9.3, FOLD r9.11)"]
  ],
  // (review 9.2: a recipe's last-run words, RUN_REASON_WORD, left this list — keyed on the bare reason, an end-only refusal read "errored", and its class
  // was the bare reason's too: a refusal and a cut reply the failure red, a limit or an empty reply a success's plain look. LAST_RUN_WORD covers every
  // outcome, the class is RunOutcome.look's tone, FOLD r9.8)
  'frontend/app/windows/logbook.js': [["const LB_REASON = { done: '✓ done', max_iters: '⟳ looped out', budget: 'over budget', cancelled: '⏹ cancelled', error: '✕ error', refusal: '⊘ refused', cut_short: '✂ cut short', clarifying: '? asked' };", '5dffdde902bb', "the LOGBOOK's RUNS words per REASON (each distinct); the row is read through RunOutcome.reasonOf, and an outcome with no word here prints its own reasonOf word"]],
  'frontend/app/windows/workflows.js': [
    ["const END ={ empty: 'gave no final answer', error: 'hit an error', max_iters: 'ran out of turns', budget: 'hit the spending cap', refusal: 'refused the work', interrupted: 'was interrupted', stopped: 'was stopped', cancelled: 'was stopped', clarifying: 'asked a question' };", '652c3249127e', "the words for a step that did NOT succeed, by its reason (each distinct; review r8 added 'cancelled' and 'clarifying'); a 'done' step that did not succeed reads RunOutcome.line (endOf)"],
    // (review 8.1: unseen until the census read every brace pair)
    ["const mark = s => ({ delivered: '<span class=\"wfw-st ok\">✓ DELIVERED</span>', running: '<span class=\"wfw-st run\">RUNNING</span>', stopped: '<span class=\"wfw-st\">STOPPED</span>',", '9502b0d61d69', "a LINE JOB's outcome/status badge: delivered, running, paused, blocked, stopped_short/problem, stopped, failed, interrupted; problem is the legacy stopped_short alias. Each is distinct, and none is one run's outcome"]
  ],
  'frontend/app/workflowpanel.js': [["const RUN_END = { empty: 'gave no final answer', error: 'hit an error', max_iters: 'ran out of turns', budget: 'hit the spending cap',", '49310d1a6382', "the same step-end words (RUN_END), each distinct; a 'done' step that did not succeed reads RunOutcome.line (stepEnd)"]],
  'frontend/app/workflowline.js': [["const TERMINAL = { done: 1, stopped: 1, failed: 1 };", '00a53a253cdf', "a SET of LINE JOB statuses that settle a job, not run outcomes"]],
  'frontend/app/workqueststore.js': [["const STALL_REASONS = { error: 1, budget: 1, max_iters: 1, refusal: 1 };", '479b8fd6dda0', "a SET (which ends earn the stall beat's warn), no word map: the card's words are workquests.js stallWord, each its own (review r8)"]],
  'frontend/app/xp.js': [
    ["const RELIABILITY_ATTRIBUTED = { done: 'done', max_iters: 'short', budget: 'short', refusal: 'short' };", 'ac067cc20082', "XP's S2 reliability BUCKET (who owns the run's ending: won / short / faulted / neutral), not its words or colour; runsWon reads RunOutcome.ofEnd"],
    ["const RELIABILITY_EXCLUDED = { error: 'faulted', empty: 'faulted', cancelled: 'neutral', clarifying: 'neutral' };", '113e9b6d8a7d', "the same reliability bucket: a stop and a question are neutral (never a fault, never a win)"]
  ],
  'bin/lib/floor.js': [
    ["const FLIGHT_OF = { done: 'result', stopped: 'stopped', asked: 'asked', unfinished: 'unfinished', failed: 'failed' };", 'a843a2f238b5', "keyed on station-model endLook's POSTURE (done · stopped · asked · unfinished · failed), which RunOutcome.look decides: the unfinished outcomes share one posture by design, each keeps its own word on the plate and in the LOG"],
    ["const LOG_STYLE = { done: 'ok', stopped: 'fg', asked: 'am', unfinished: 'am', failed: 'bad' };", '0ca5bd78996e', "the same endLook posture -> the LOG line's style"],
    ["const STATE_RGB = { needs: [255, 180, 58], done: [93, 255, 168], stopped: [70, 52, 56], asked: [255, 180, 58], unfinished: [217, 169, 91], failed: [255, 107, 61] };", '867a565b1aa8', "the floor's light per POSTURE (needs · done · stopped · asked · unfinished · failed): a question shares the live ask's amber by design (both wait on you)"],
    ["const ON_JOB = { working: 1, needs: 1, stopped: 1, asked: 1, unfinished: 1, failed: 1 };", '3b5fcfeb5f21', "a SET (which postures sit at the desk), no word map"],
    ["const MARK = { working: ['●', 'ph b'], needs: ['▲', 'am b'], done: ['✓', 'ok b'], stopped: ['■', 'dim'], asked: ['▲', 'am b'], unfinished: ['■', 'am'], failed: ['✗', 'bad'] };", '01b33b16117a', "the floor plate's mark per POSTURE, each distinct but asked = needs (both wait on you)"]
  ],
  'bin/lib/station-model.js': [["const JOB_LOOK = Object.freeze({ done: ['✓', 'ok', 'delivered'], problem: ['■', 'am', 'finished with a problem'], stopped: ['■', 'dim', 'stopped'],", '210066798d01', "JOB_LOOK: a LINE JOB's status (delivered · problem · stopped · interrupted · failed), never one run's outcome — the WORKFLOWS window's own words"]],
  'bin/lib/tui.js': [["const END_LAMP = Object.freeze({ asked: '▲', stopped: '■', unfinished: '■', failed: '✗' });", 'd06566778b68', "END_LAMP keyed on endLook's POSTURE: a stop and a run that did not finish share the ■ glyph, told apart by their tone (dim vs warn) and their word"]],
  // (review 9.3: the phone app joins the census; it loads no resolver — the station sends each row's and each end's RunOutcome.look tone)
  'relay/app/app.js': [["const STATE_TONE = { done: 'ok', stopped: 'stop', failed: 'bad' };", '3a705295f2c0', "the relay's three-state contract (done · stopped · failed) to a tone, for an OLDER station that sends neither a tone nor an outcome; a newer one sends RunOutcome.look's tone beside it (host.js; FOLD r9.15)"]]
};
const OUTCOME_FOLDS = {
  'sidecar/index.js': [["const status = runOc.ok ? 'produced' : (runOc.outcome === 'stopped' ? 'stopped' : 'failed');", FOLD_OK + "an away build's ATTEMPT record (produced / stopped / failed): a build that did not produce is a failed attempt to the retry ladder, a stop none (review r7)"]],
  // (review 9.3: the phone painted the state — every unfinished outcome 'failed', the failure red under "Did not finish" — so the outcome's tone rides beside it now)
  'sidecar/remote/host.js': [["const state = (oc.outcome === 'succeeded' || oc.outcome === 'asked') ? 'done' : oc.outcome === 'stopped' ? 'stopped' : 'failed';", FOLD_OK + "the phone's STATE (done / stopped / failed: the relay's three-state contract); the outcome, failureCode and RunOutcome.look's tone ride beside it, and the phone words and paints the row by that tone (relay/app endLook, FOLD r9.15)"]],
  'relay/app/app.js': [[": oc ? (oc === 'succeeded' ? 'ok' : oc === 'asked' ? 'ask' : oc === 'stopped' ? 'stop' : oc === 'failed' ? 'bad' : 'warn')", FOLD_OK + "the phone's fallback for an older station's run.ended (its outcome, no tone): RunOutcome.look's tones by hand, since the phone loads no resolver; a newer station sends the tone (FOLD r9.15)"]],
  'sidecar/openai-compat.js': [["if (status === 'limited') return (o.outcome === 'cut_short' && end.finishReason === 'content_filter') ? 'content_filter' : 'length';", FOLD_OK + "the OpenAI finish_reason vocabulary (length / content_filter) for a reply already decided limited"]],
  'sidecar/acp/core.js': [["if (o.outcome === 'cut_short') return finishReason === 'content_filter' ? 'refusal' : 'max_tokens';", FOLD_OK + "the ACP stopReason for a reply already decided cut short (the protocol's two words for it)"]],
  'frontend/app/autopilotstore.js': [["const unfinishedAct = r => ({ delivered: false, reason: r.outcome === 'stopped' ? 'stopped' : 'not-done' });", FOLD_OK + "the autopilot's act record for a reply that did NOT succeed: delivered false either way; 'not-done' is no failure word, a stop is said apart"]],
  'frontend/app/autosessions.js': [
    ["else if (Workstreams.noteRunEnd && outcome === 'failed') { const kind = unsucceededKind(why);", FOLD_OK + "the session's VERDICT (lastRunOk, review r8): a FAILED fire false, every other unsuccessful one no verdict (null) with its own outcome as the word"],
    ["function settledAs(o) { return o.ok ? 'ok' : (o.outcome === 'stopped' ? 'stopped' : 'failed'); }", FOLD_OK + "the routine session's SETTLE bucket (ok / stopped / unsuccessful): since review r8 every report reads the fire's own outcome from its reason (failedMarker, recordOutcome's unsucceededKind) — a question, a cut reply and a limit each say themselves and settle no verdict; only a FAILED fire is ok=false (FOLD r8.12)"]],
  'frontend/app/chat.js': [
    ["const endVerb = endReason === 'cancelled' ? 'stopped' :", FOLD_OK + "the COMMS stop toast's VERB (stopped · failed · did not finish, review r8); the outcome's own words ride after it (stopLine: Friendly.stopLine / budgetStopLine)"],
    // (review 8.1: unseen until FOLD_TEST read an outcome under any name)
    ["const chipOk = chipOc === 'succeeded' ? true : chipOc === 'failed' ? false : null;", FOLD_OK + "the board's VERDICT (lastRunOk, review r8): succeeded true, failed false, every other outcome no verdict — its own outcome (chipOc) is the word noteRunEnd records beside it, which boardEnd says (FOLD r8.8)"],
    ["Workstreams.noteRunEnd(ws.id, thisRunId, errOc ? null : false, errOc === 'refused' ? 'refusal' : (errOc || 'error'));", FOLD_OK + "the in-band error's VERDICT (review 8.1): a FAILED run false with its own word ('error'), a refused one (or any other non-failed stamp) no verdict with its outcome's end word (FOLD r8.26)"]
  ],
  // (review 9.3: the bay lamp lit FAILED for every dead end — "FAILED · BUDGET", "FAILED · REFUSAL" in the failure red, blinking)
  'frontend/app/linewatch.js': [["return { state: outcome === 'failed' ? 'failed' : 'unfinished', outcome: outcome,", FOLD_OK + "the bay lamp's STATE for a dead end the bay holds (failed / unfinished), the outcome beside it: its word and colour are that outcome's own (world.js bayGlanceText reads RunOutcome.look, FOLD r9.11)"]],
  'frontend/app/stationcommands.js': [["const verdict = oc === 'succeeded' ? true : oc === 'failed' ? false : null;", FOLD_OK + "a worker thread's VERDICT (lastRunOk, review r8): succeeded true, failed false, every other outcome no verdict with its own word (the board reads it)"]],
  'frontend/app/windows/routines.js': [["notify(failedPress ? 'routine run failed' : stoppedPress ?", FOLD_OK + "RUN NOW's toast verb per outcome (failed · stopped · asked · did not finish · ran, review r8), each followed by its RunOutcome.line words"]],
  'frontend/app/windows/workflows.js': [["const stepWarn = r => {", FOLD_OK + "the step chip's WARN predicate (review r8: a stopped step never warns), a decision with no words; the step's words are END / RunOutcome.line"],
    [": ok ? '<b class=\"ok\">\u2713 DELIVERED</b>' : outcome === 'stopped'", FOLD_OK + "the multiline LINE JOB header reads lineOutcomeOf, with distinct paused/running/blocked branches above and delivered/stopped/interrupted/failed/stopped_short here; it never folds a run outcome"]],
  'frontend/app/world.js': [
    ["const dead = (r === 'max_iters' || r === 'budget' || r === 'error' || r === 'refusal') ? r : ((oc && oc.outcome === 'failed') ? 'error' : '');", FOLD_OK + "the SLAG predicate (which ends are dead work for the floor's slag cell and its post-mortem), a decision, not a word: its lesson names the reason it caught"]]
    // (review 9.3: the HUD ticker's run-end tone left this list — "the ticker's tone only" was the 'one alarm colour' reason 9.1 struck from FINISH: a
    // refusal, a cut reply and every limit painted the failure's red, a stop and a question the success's plain line. It reads RunOutcome.look, FOLD r9.12)
};
const MISSING_OK = {};
const HARNESS_REPLY = "a Harness.chat reply: Harness.chat stamps res.outcome from the LEAD's own end through RunOutcome.ofEnd (an older station's unstamped end resolved from its reason + finishReason) and THROWS when no lead end arrived (transportLoss), so an empty outcome is never a missing END — only an older Harness or a page without the resolver, the documented compatibility fallback (since review r8 every page loads runoutcome.js before harness.js: agent-station-demo.html did not)";
for (const [rel, needle] of [['frontend/app/autojobstore.js', "(res && !res.error && (!res.outcome || res.outcome === 'succeeded'))"], ['frontend/app/autopilotstore.js', "const succeededReply = r => !!r && !r.error && (!r.outcome || r.outcome === 'succeeded');"],
  ['frontend/app/chat.js', "raw = (res && !res.error && (!res.outcome || res.outcome === 'succeeded')) ? (res.text || '') : '';"], ['frontend/app/onboarding.js', "if (res && !res.error && res.text && (!res.outcome || res.outcome === 'succeeded'))"],
  ['frontend/app/pitchstore.js', "const parsed = (res && !res.error && (!res.outcome || res.outcome === 'succeeded')) ? Pitch.parsePitch(res.text) : null;"], ['frontend/app/pitchstore.js', "const parsed = (res && !res.error && res.text && (!res.outcome || res.outcome === 'succeeded')) ? Pitch.parseStarter(res.text) : null;"],
  ['frontend/app/pitchstore.js', "const proposed = result && !result.error && (!result.outcome || result.outcome === 'succeeded') && Pitch.parseStarter(result.text);"], ['frontend/app/suggeststore.js', "const parsed = (res && !res.error && (!res.outcome || res.outcome === 'succeeded')) ? Pitch.parsePitch(res.text) : null;"]]) {
  (MISSING_OK[rel] = MISSING_OK[rel] || []).push([needle, HARNESS_REPLY]);
}
// review 9: a thread's lastRunOk true with no outcome word — the delegated card reads it as done only with its filed word now (FOLD r9.2); these
// keep the flag as the documented COMPATIBILITY fallback for a 0.14.x save (true for every completed stream, a question and a cut reply too)
const LEGACY_VERDICT = "the documented COMPATIBILITY fallback for a thread saved before outcomes were filed: since review 9 the page files a succeeded run's outcome word with its true (chat.js noteRunEnd: 'succeeded'; a delivery 'done'), so a true with no word is a 0.14.x save, which wrote true for every completed stream — its card reads finished as it did before the lane (the delegated card, whose 'delivered' state predates the lane, reads such a save as delivered)";
MISSING_OK['frontend/app/stationui.js'] = [["const k = s.lastRunOk === true ? 'succeeded' :", "boardEnd: " + LEGACY_VERDICT]];
MISSING_OK['frontend/app/workview.js'] = [["} else if (s.lastRunOk === true) {", "WorkView's finished bucket: " + LEGACY_VERDICT]];
MISSING_OK['frontend/app/workstreams.js'] = [["lastRunOk: opts.lastRunOk === true ? true : (opts.lastRunOk === false ? false : null),", "no success decision: the record's normalizer keeps the saved verdict as it was (true / false / null)"]];
A.ok(files.some(f => f.rel === 'bin/lib/station-model.js') && files.some(f => f.rel === 'bin/lib/station-io.js') && files.some(f => f.rel === 'sidecar/away-briefing.js') && files.some(f => f.rel === 'frontend/app/stationui.js'),
  'review r8 fixture: the outcome-map, fold and missing-outcome census read bin/ as well as sidecar/ (through the source helper) and frontend/app/');
// the widening's own teeth: a fold, a map and a skipped resolver the r8 fixes removed are caught; their replacements are not
{
  const foldHit = l => FOLD_TEST.test(l) && FOLD_TAIL.test(l) && !/RunOutcome\.look\(/.test(l);
  A.ok(foldHit("function settledAs(o) { return o.ok ? 'ok' : (o.outcome === 'stopped' ? 'stopped' : 'failed'); }") && foldHit("const chipOk = !runOutcome || runOutcome === 'succeeded' ? true : (runOutcome === 'asked' || runOutcome === 'stopped') ? null : false;")
    && !foldHit("if (L) L.endCol = oc ? SUMMON_END_COL[RunOutcome.look(oc).tone] : '#d9a95b';") && !foldHit("sfx(r.ok ? 'click' : 'bad');"),
    'review r8: the OUTCOME FOLD census reads a one-kind ternary fold onto a literal bucket, never a RunOutcome.look reader or an HTTP result');
  const maps = outcomeMapsIn("const A = { done: 'ok', cancelled: 'dim', error: 'bad' };\nconst B = " + JSON.stringify(Object.fromEntries(RunOutcome.OUTCOMES.map(o => [o, o.toUpperCase()]))) + ";\nconst C = " + JSON.stringify(Object.fromEntries(RunOutcome.OUTCOMES.map(o => [o, o === 'stopped' || o === 'failed' ? 'X' : o]))) + ';');
  A.ok(maps.length === 3 && maps[0].missing.length === 8 && !maps[1].missing.length && !maps[1].shared.length && maps[2].shared.join() === 'failed=stopped',
    'review r8: the OUTCOME MAP census reads a partial map, a whole distinct one and a whole map that folds two outcomes (got ' + JSON.stringify(maps.map(m => ({ missing: m.missing.length, shared: m.shared }))) + ')');
  A.ok(MISSING_OUTCOME.test("const unfinished = () => { const oc = endP ? RunOutcome.ofEnd(endP, null) : null; return oc && !oc.ok ? oc : null; };") && MISSING_OUTCOME.test("const chipOk = !runOutcome || runOutcome === 'succeeded' ? true : null;")
    && !MISSING_OUTCOME.test("const oc = RunOutcome.ofEnd(endP, errP);"),
    'review r8: the MISSING OUTCOME census reads a resolver skipped for a missing end and a missing outcome taken as success');
  // review 8.1: a map inside a SHALLOW block (a function body whose inner braces nest one level) was swallowed by the consuming MAP_LITERAL —
  // the presence card's endLabel, the project home's worker words; a quote inside a regex literal or a template's ${…} must not derail the walk
  const FOLDING = "{ succeeded: 'ok', asked: 'bad', stopped: 'bad', failed: 'bad', cut_short: 'bad', refused: 'bad', out_of_budget: 'bad', step_limit: 'bad', empty: 'bad', interrupted: 'bad', blocked: 'bad' }";
  const shallow = outcomeMapsIn("function f(oc) {\n  if (x) { y(); }\n  const W = " + FOLDING + ";\n  return W[oc.outcome];\n}\n");
  const tricky = outcomeMapsIn("const re = /'/g, q = `a ${ { b: 1 }.b } \"`;\nfunction g() { if (a) { b(); } const M = { done: 'x', error: 'y', cancelled: 'x' }; return M; }\n");
  const nested = outcomeMapsIn("const T = { a: { b: { c: 1 } }, M: { done: 'x', error: 'y', cancelled: 'z' } };");
  A.ok(shallow.length === 1 && shallow[0].shared.length === 9 && shallow[0].line === 3 && tricky.length === 1 && tricky[0].shared.join() === 'succeeded=stopped' && nested.length === 1,
    'review 8.1: the OUTCOME MAP census reads a map inside a shallow block, past a regex literal and a template, and inside a deep object (got ' + JSON.stringify({ shallow: shallow.map(m => m.shared.length), tricky: tricky.map(m => m.shared), nested: nested.length }) + ')');
  const missWiden = ["const ok = !res.error && (res.outcome == null || res.outcome === 'succeeded');", "const ok = !res.error && (res.outcome === undefined || res.outcome === 'succeeded');",
    "const ok = !res.error && (typeof res.outcome !== 'string' || res.outcome === 'succeeded');", "const ok = x.outcome ? x.outcome === 'succeeded' : true;",
    "const ok = (o && o.outcome) ? o.outcome === 'succeeded' : true;", "const ok = res.outcome ? res.outcome === 'succeeded' : !res.error;", "const oc = endP ? RunOutcome.ofEnd(endP, null) : { ok: true };"];
  A.ok(missWiden.every(l => MISSING_OUTCOME.test(l)) && !MISSING_OUTCOME.test("const oc = RunOutcome.ofEnd(endP, errP);") && !MISSING_OUTCOME.test("const ok = oc.outcome === 'succeeded';"),
    'review 8.1: the MISSING OUTCOME census reads == null / === undefined / typeof guards, an outcome ternary whose else is a success, and a resolver skipped for a success literal (missed: ' + JSON.stringify(missWiden.filter(l => !MISSING_OUTCOME.test(l))) + ')');
  A.ok(foldHit("const chipOk = chipOc === 'succeeded' ? true : chipOc === 'failed' ? false : null;") && foldHit("const w = kind === 'failed' ? 'failed' : 'did not finish';") && foldHit("const tone = fireOc.ok ? 'ok' : 'bad';"),
    'review 8.1: the OUTCOME FOLD census reads an outcome under any name (chipOc, kind, fireOc)');
  A.ok(MISSING_OUTCOME.test("if (!w && k.lastRunOk === true) return { cls: 'done', live: 'done', t: '' };") && MISSING_OUTCOME.test("const k = s.lastRunOk === true ? 'succeeded' : 'unknown';")
    && !MISSING_OUTCOME.test("if (!w && k.lastRunOk === true && RunOutcome.ofWord(k.lastRunReason).outcome === 'succeeded') return done;"),
    'review 9: the MISSING OUTCOME census reads a verdict flag taken as a success with no outcome word beside it, never one read with its filed word');
  A.ok(MISSING_OUTCOME.test("const ok = (r.outcome ?? 'succeeded') === 'succeeded';") && MISSING_OUTCOME.test('const ok = (r.outcome || "succeeded") === "succeeded";')
    && MISSING_OUTCOME.test("const unfinished = () => { const oc = endP ? RunOutcome.ofEnd(endP, null) : null; return oc; };"),
    'review 9: the MISSING OUTCOME census reads a missing outcome defaulted to success through `??` and either quote (and its skipped-resolver shape still holds its backreference)');
  // review 9: an OUTCOME_MAPS row allows its one map by exact head and digest — a fold added inside it, the same body under another head, or a
  // head the needle merely contains is no longer allowed
  const FIN = "const FINISH = {\n  done: ['done', 'Completed'], clarifying: ['ask', 'Asked you a question'], cancelled: ['stopped', 'Stopped'],\n  error: ['fault', 'Needs attention'], budget: ['fault', 'Stopped at the spend cap']\n};\n";
  const m0 = outcomeMapsIn(FIN)[0];
  const T = { 'x.js': [[m0.head.trim(), mapDigest(m0), 'why']] };
  const folded = outcomeMapsIn(FIN.replace("cancelled: ['stopped', 'Stopped']", "cancelled: ['fault', 'Stopped']"))[0];
  const renamed = outcomeMapsIn(FIN.replace('const FINISH = {', 'const FINISH_OLD = {'))[0];
  const needleOnly = { 'x.js': [['const FINISH', mapDigest(m0), 'why']] };
  A.ok(!!mapRowFor(T, 'x.js', m0) && !mapRowFor(T, 'x.js', folded) && !mapRowFor(T, 'x.js', renamed) && !mapRowFor(needleOnly, 'x.js', m0),
    'review 9: an OUTCOME_MAPS row allows its one map by its exact head line and content digest — a new fold inside it, its body under another head and a substring needle are not allowed');
}
/* review 9: THE OUTCOME TABLES — a surface's ONE outcome -> presentation table (its word, its own class, its colour token), pinned by the exact
   head line it starts on. It must be there, key EVERY RunOutcome outcome, give each its own value, its own word and its own class, and colour
   each by RunOutcome.look's tone (a stop the stop's alone, a question the ask's, a failure the failure's): the outcome-map census reads it complete
   and distinct, so no OUTCOME_MAPS row can excuse a fold inside it. */
const OUTCOME_TABLES = {
  'frontend/app/chat.js': [['const PRESENCE_END = Object.freeze({', "COMMS' presence card (presenceLook): the run's outcome decides the card's word, class and colour before any detail (review 8.3 majors)"]]
};
for (const [rel, rows] of Object.entries(OUTCOME_TABLES)) for (const [anchor, why] of rows) {
  const f = files.find(x => x.rel === rel);
  const m = f ? outcomeMapsIn(f.text).find(x => x.head.trim() === anchor) : null;
  const entries = m ? topEntries(m.src).filter(e => OUTCOME_VOCAB.has(e.key)) : [];
  const field = (e, k) => { const r = new RegExp('\\b' + k + "\\s*:\\s*'([^']*)'").exec(e.value); return r ? r[1] : ''; };
  const distinct = k => new Set(entries.map(e => field(e, k))).size === entries.length && entries.every(e => field(e, k));
  const offTone = entries.filter(e => field(e, 'tone') !== RunOutcome.look(e.key).tone).map(e => e.key + ':' + field(e, 'tone'));
  A.ok(!!m && !m.missing.length && !m.shared.length && entries.length === RunOutcome.OUTCOMES.length && entries.every(e => RunOutcome.isOutcome(e.key)) && distinct('word') && distinct('cls') && !offTone.length,
    'review 9: ' + rel + ' keeps its outcome table "' + anchor + '" (' + why + ') — every outcome its own word, class and RunOutcome.look tone (got ' + (m ? JSON.stringify({ missing: m.missing, shared: m.shared, keys: entries.map(e => e.key), offTone }) : 'no such table') + ')');
}
const unmapped = [], unfolded = [], unmissing = [], usedR8 = new Set();
for (const f of files) {
  if (f.rel === 'frontend/app/runoutcome.js') continue;   // the resolver itself
  for (const m of outcomeMapsIn(f.text)) {
    if (!m.missing.length && !m.shared.length) continue;   // covers every outcome, each its own value
    const row = mapRowFor(OUTCOME_MAPS, f.rel, m);
    if (row) { usedR8.add('map::' + f.rel + '::' + row[0] + '::' + row[1]); continue; }
    unmapped.push(f.rel + ':' + m.line + '  ' + (m.missing.length ? 'misses ' + m.missing.join(',') : '') + (m.shared.length ? ' folds ' + m.shared.join(',') : '') + '  ' + m.src.replace(/\s+/g, ' ').slice(0, 110)
      + '  [head ' + JSON.stringify(m.head.trim().slice(0, 90)) + ', digest ' + mapDigest(m) + ']');
  }
  f.text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (/^(\/\/|\*|\/\*)/.test(t)) return;
    if (FOLD_TEST.test(line) && FOLD_TAIL.test(line) && !/RunOutcome\.look\(/.test(line)) {
      const row = (OUTCOME_FOLDS[f.rel] || []).find(([needle]) => line.indexOf(needle) >= 0);
      if (row) usedR8.add('fold::' + f.rel + '::' + row[0]); else unfolded.push(f.rel + ':' + (i + 1) + '  ' + t.slice(0, 150));
    }
    if (MISSING_OUTCOME.test(line)) {
      const row = (MISSING_OK[f.rel] || []).find(([needle]) => line.indexOf(needle) >= 0);
      if (row) usedR8.add('miss::' + f.rel + '::' + row[0]); else unmissing.push(f.rel + ':' + (i + 1) + '  ' + t.slice(0, 150));
    }
  });
}
A.ok(unmapped.length === 0, 'review r8: every outcome -> word / bucket / colour map covers each outcome distinctly, or is listed in OUTCOME_MAPS with why its fold is legitimate (' + unmapped.length + ' unlisted):\n    ' + unmapped.slice(0, 40).join('\n    '));
A.ok(unfolded.length === 0, 'review r8: every one-kind outcome fold onto a literal bucket reads RunOutcome.look, or is listed in OUTCOME_FOLDS with why (' + unfolded.length + ' unlisted):\n    ' + unfolded.slice(0, 40).join('\n    '));
A.ok(unmissing.length === 0, 'review r8: no reply or row with NO terminal outcome is taken as a success outside a listed compatibility fallback (MISSING_OK) (' + unmissing.length + ' unlisted):\n    ' + unmissing.slice(0, 40).join('\n    '));
for (const [kind, table] of [['map', OUTCOME_MAPS], ['fold', OUTCOME_FOLDS], ['miss', MISSING_OK]]) for (const [rel, rows] of Object.entries(table)) for (const row of rows) {
  const key = kind === 'map' ? row[0] + '::' + row[1] : row[0];   // (review 9: a map row is its exact head line AND its content's digest)
  A.ok(usedR8.has(kind + '::' + rel + '::' + key), 'the r8 census list stays true: ' + rel + ' still holds the ' + kind + ' "' + row[0].slice(0, 70) + '"' + (kind === 'map' ? ' with the digest ' + row[1] : ''));
}

// ================================================= 2. THE FOLDS ======================================================
// the page loads runoutcome.js before every fold; a node fold sees it as the same global
global.RunOutcome = RunOutcome;
const CUT = { agentId: 'agent', runId: 'r-cut', reason: 'done', finishReason: 'length', outcome: 'cut_short', turns: 1, usd: 0.01 };
const DONE = { agentId: 'agent', runId: 'r-done', reason: 'done', outcome: 'succeeded', turns: 1, usd: 0.01 };
// a 'done' end an error the run raised outranks (an image task's unmet completion), stamped failed by the station's sink
const RAISED = { agentId: 'agent', runId: 'r-raised', reason: 'done', outcome: 'failed', failureCode: 'run_failure', turns: 1, usd: 0.01 };

(async () => {
  // the trust window: a clean positive only for a SUCCEEDED run; a raised error is a negative
  const Trust = require('../frontend/app/trust.js');
  const tCut = Trust.fold(Trust.fresh(), { name: 'agent.run.end', payload: CUT });
  const tDone = Trust.fold(Trust.fresh(), { name: 'agent.run.end', payload: DONE });
  const tRaised = Trust.fold(Trust.fresh(), { name: 'agent.run.end', payload: RAISED });
  A.ok(!tCut.window.some(x => x.ok), 'trust: a provider-cut reply is never a clean positive (got ' + JSON.stringify(tCut.window) + ')');
  A.ok(tDone.window.length === 1 && tDone.window[0].ok === true, 'trust: a succeeded run is a clean positive');
  A.ok(tRaised.window.length === 1 && tRaised.window[0].ok === false, 'trust: a \'done\' end the run\'s own error outranks is a negative (got ' + JSON.stringify(tRaised.window) + ')');

  // XP: tasksDone and runsWon count only a SUCCEEDED run
  const Xp = require('../frontend/app/xp.js');
  const xCut = Xp.applyEvent(Xp.fresh(), { name: 'agent.run.end', payload: CUT }).stats;
  const xDone = Xp.applyEvent(Xp.fresh(), { name: 'agent.run.end', payload: DONE }).stats;
  A.ok(!(xCut.counters.tasksDone > 0) && !(xCut.counters.runsWon > 0), 'xp: a provider-cut reply is no finished task and no won run (got ' + JSON.stringify(xCut.counters) + ')');
  A.ok(xDone.counters.tasksDone === 1, 'xp: a succeeded run is a finished task');

  // the floor stats: a product only for a SUCCEEDED run; a raised error is slag
  const FloorStats = require('../frontend/app/floorstats.js');
  const fs1 = FloorStats.create(); fs1.onEvent('agent.run.end', CUT, 1); fs1.onEvent('agent.run.end', RAISED, 2); fs1.onEvent('agent.run.end', DONE, 3);
  const snap = fs1.snapshot(4);
  A.ok(snap.products === 1 && snap.slag === 1, 'floor stats: one product (the succeeded run), the raised error slag, the cut reply neither (got ' + JSON.stringify({ products: snap.products, slag: snap.slag }) + ')');

  // Pride: the lifetime task count
  const Pride = require('../frontend/app/pride.js');
  const pCut = Pride.fold(Pride.hydrate({}), 'agent.run.end', CUT, 10);
  const pDone = Pride.fold(Pride.hydrate({}), 'agent.run.end', DONE, 10);
  A.ok(Pride.snapshot(pCut).tasks === 0 && Pride.snapshot(pDone).tasks === 1, 'pride: a provider-cut reply is never a banked task (got cut ' + Pride.snapshot(pCut).tasks + ', done ' + Pride.snapshot(pDone).tasks + ')');

  // the crew (gh#57 + review r2): a worker whose run proves no ending is an error, and a provider-cut worker is never "done"
  const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
  const { makeSubagentManager } = require('../sidecar/subagents.js');
  const roster = new Map([['researcher', { system: 'R', name: 'RESEARCHER', model: 'm' }]]);
  const counter = () => { let n = 0; return () => 'child_' + (++n); };
  async function dispatchWith(result) {
    const { dispatchTool } = makeOrchestrationTools({ runOnce: async () => result, roster: () => roster, key: 'k', model: 'lead', newId: counter() });
    const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }] }, { agentId: 'agent', signal: { aborted: false }, emit: () => {} });
    return { rows: JSON.parse(out.content), summary: out.summary };
  }
  const say = t => [{ role: 'assistant', content: t }];
  const noReason = await dispatchWith({ messages: say('maybe'), usd: 0 });
  A.eq(noReason.rows[0].reason, 'error', 'gh#57: a worker whose run reported no terminal reason is an error, never done');
  A.ok(/0 done/.test(noReason.summary), 'gh#57: ...and the dispatch never counts it done (got ' + noReason.summary + ')');
  const cut = await dispatchWith({ reason: 'done', finishReason: 'length', messages: say('half an answ'), usd: 0 });
  A.ok(cut.rows[0].outcome === 'cut_short' && /0 done/.test(cut.summary), 'a provider-cut worker reaches the lead as cut_short, never counted done (got ' + JSON.stringify({ outcome: cut.rows[0].outcome, summary: cut.summary }) + ')');
  const clean = await dispatchWith({ reason: 'done', messages: say('the answer'), usd: 0 });
  A.ok(clean.rows[0].outcome === undefined && /1 done/.test(clean.summary), 'a succeeded worker\'s row is unchanged and counted done (got ' + JSON.stringify({ outcome: clean.rows[0].outcome, summary: clean.summary }) + ')');

  // team.spawn (a foreground clone through the subagent manager) and a runner result that names no status
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-family-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const { spawnTool } = makeOrchestrationTools({ runOnce: async () => ({ messages: say('maybe'), usd: 0 }), roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    const sp = await spawnTool.run({ tasks: [{ prompt: 'check example.com' }] }, { agentId: 'lead', emit: () => {} });
    const spRows = JSON.parse(sp.content);
    A.ok(spRows[0] && spRows[0].reason === 'error' && /0 done/.test(sp.summary), 'gh#57: a spawned clone whose run reported no ending is an error, never done (got ' + JSON.stringify({ reason: spRows[0] && spRows[0].reason, summary: sp.summary }) + ')');
    const view = subagents.start({ leadId: 'lead', parentRunId: 'p', agentId: 'researcher', prompt: 'x', runId: 'w-run' }, async () => ({ result: 'something' }));
    for (let i = 0; i < 20 && subagents.get(view.id) && !subagents.get(view.id).completedAt; i++) await new Promise(r => setImmediate(r));
    const rec = subagents.get(view.id) || {};
    A.ok(rec.status === 'error' && rec.reason === 'error', 'a background worker whose runner names no status and no ending is an error, never done (got ' + rec.status + ' / ' + rec.reason + ')');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  // ---- review 4.1 ----
  // a cut worker's LIVE delivery to its thread (station.deliver): its board chip and CREW row read the outcome, never DONE
  {
    const seen = [];
    const station = { request: async (verb, args) => { seen.push({ verb, args }); return verb === 'station.sessions' ? { ok: true, result: { sessions: [{ id: 'ws_r1', title: 'research', agentId: 'researcher' }] } } : { ok: true, result: {} }; } };
    const { dispatchTool } = makeOrchestrationTools({ runOnce: async () => ({ reason: 'done', finishReason: 'length', messages: say('half an answ'), usd: 0 }), roster: () => roster, key: 'k', model: 'lead', newId: counter(), station });
    await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X', session: 'research' }] }, { agentId: 'agent', signal: { aborted: false }, emit: () => {} });
    const d = seen.find(x => x.verb === 'station.deliver');
    A.ok(d && d.args.reason === 'cut_short' && d.args.dispatchDelivery && d.args.dispatchDelivery.reason === 'cut_short',
      'a provider-cut worker\'s live delivery names cut_short (reason + dispatchDelivery), never done (got ' + JSON.stringify(d && { reason: d.args.reason, delivery: d.args.dispatchDelivery && d.args.dispatchDelivery.reason }) + ')');
  }

  // the insights fold behind "% success" (the LOGBOOK, COMMS /insights, the terminal dashboard)
  const { foldInsights } = require('../sidecar/insights.js');
  const ins = foldInsights([CUT, DONE], { nowMs: 1 });
  A.ok(ins.successPct === 50 && ins.byReason.cut_short === 1 && ins.byReason.done === 1, 'insights: a cut row beside a succeeded one is 50% success, never 100% (got ' + ins.successPct + '% ' + JSON.stringify(ins.byReason) + ')');
  A.ok(foldInsights([{ usd: 0 }], { nowMs: 1 }).successPct === 0, 'insights: a row with no reason proves no ending — never a success');

  // the bay lamp and the crate card (frontend/app/linewatch.js): a 'done' end the run's own error outranked FAILS the bay, as the server's
  // seed after a reload does (line-stats FAILED_OUTCOMES); a cut row's crate card never reads DONE
  {
    const LW = require('../frontend/app/linewatch.js');
    const w = LW.create({ entryDock: () => 'bA' });
    w.onEvent('workitem.placed', { workitemId: 'w1', agentId: 'agent', dockId: 'bA', lineId: 'L', kind: 'sample', preview: 'x' }, 1000);
    w.onEvent('agent.run.start', { agentId: 'agent', runId: 'r-raised', trigger: 'event' }, 1100);
    w.onEvent('agent.run.end', RAISED, 1200);
    A.eq(w.status('bA', 1300).state, 'failed', 'the bay lamp: a \'done\' end stamped failed lights FAILED, never IDLE');
    const names = { agentName: a => String(a).toUpperCase(), dockName: d => d, lineName: l => l, usd: n => '$' + n };
    for (const [why, row] of [['a cut row', CUT], ['a raised row', RAISED], ['a row with no reason', { agentId: 'agent', runId: 'r-bare' }]]) {
      const card = LW.crateCard({ outbound: true, box: 'product', agentId: 'agent', dockId: 'bA', runId: row.runId }, Object.assign({ run: null, row, nowMs: 0 }, names));
      const run = (card.rows.find(r => r[0] === 'RUN') || [])[1] || '';
      A.ok(card.state !== 'done' && !/· DONE/.test(run), 'the crate card: ' + why + ' never reads DONE (got ' + card.state + ' / ' + run + ')');
    }
    const okCard = LW.crateCard({ outbound: true, box: 'product', agentId: 'agent', dockId: 'bA', runId: DONE.runId }, Object.assign({ run: null, row: DONE, nowMs: 0 }, names));
    A.eq(okCard.state, 'done', 'the crate card: a succeeded row reads DONE');
  }

  // the HUD's finished-work cards (frontend/app/hudmode.js), fed from /api/runs: Completed only for a SUCCEEDED run
  {
    const H = require('../frontend/app/hudmode.js');
    const T0 = 1700000000000;
    const finished = [Object.assign({}, CUT, { endedAt: T0 - 1000, title: 'cut' }), { agentId: 'agent', runId: 'r-bare', endedAt: T0 - 2000, title: 'bare' }, Object.assign({}, DONE, { endedAt: T0 - 3000, title: 'ok' })];
    const items = H.workItems({ feed: H.createFeed(), finished, now: T0 });
    const said = id => { const x = items.find(i => i.runId === id); return x ? x.status : '(missing)'; };
    A.ok(said('r-cut') !== 'Completed' && said('r-bare') !== 'Completed' && said('r-done') === 'Completed', 'the HUD: a cut row and a reasonless row are never "Completed" (got ' + JSON.stringify([said('r-cut'), said('r-bare'), said('r-done')]) + ')');
  }

  // a line job's step record (sidecar/routing/linejobs.js) keeps its run's outcome: the WORKFLOWS window finds the step that did not finish
  {
    const LineJobs = require('../sidecar/routing/linejobs.js');
    let st = LineJobs.start({ jobs: [] }, { id: 'job-abcdefgh', line: 'L1', name: 'n', text: 't', streamId: 's1', at: 1 }).state;
    st = LineJobs.finish(st, 'job-abcdefgh', { at: 2, usd: 0, output: 'half', status: 'problem', runs: [{ runId: 'r-cut', agentId: 'agent', reason: 'done', outcome: 'cut_short', finishReason: 'length', usd: 0 }, { runId: 'r-bare', agentId: 'agent', usd: 0 }] }).state;
    const runs = (LineJobs.get(st, 'job-abcdefgh') || {}).runs || [];
    A.ok(runs.length === 2 && !RunOutcome.ofRow(runs[0]).ok && !RunOutcome.ofRow(runs[1]).ok, 'a line job\'s cut step and its reasonless step are never read as finished (got ' + JSON.stringify(runs) + ')');
    const idxSrc = sidecarSourceFiles().find(f => f.rel === 'sidecar/index.js').text;
    A.ok(/\.map\(r => \(\{ runId: r\.runId, agentId: r\.agentId, reason: r\.reason, outcome: r\.outcome, finishReason: r\.finishReason, failureCode: r\.failureCode, clarifying: r\.clarifying,/.test(idxSrc),
      'the sample route\'s step rows carry each row\'s outcome facts (its "completed" verdict reads RunOutcome.ofRow off them)');

    // cronEmitNotify's crate settle (sliced): 'done' only for a SUCCEEDED end; a scheduled fire's crate (byFire) waits for the fire
    const line = idxSrc.split('\n').find(l => /^const cronEmitNotify = \(name, payload\) => \{/.test(l)) || '';
    A.ok(line.length > 100, 'fixture: cronEmitNotify is sliced from the sidecar');
    const settles = [];
    const items = new Map([['r-cut', {}], ['r-raised', {}], ['r-done', {}], ['r-fire', { byFire: true }]]);
    const notify = new Function('cronEmit', 'ledgerFromCron', 'settleCronWorkitem', 'RunOutcome', 'cronItems', 'cronStore', 'cronJobs', 'autoNotifier', line + '\nreturn cronEmitNotify;')(
      () => true, () => {}, (rid, reason) => settles.push(rid + ':' + reason), RunOutcome, items, { getJob: () => null }, [], { onEvent() {} });
    for (const end of [CUT, RAISED, DONE, Object.assign({}, DONE, { runId: 'r-fire' })]) notify('agent.run.end', end);
    A.eq(settles.join(' '), 'r-cut:cut_short r-raised:error r-done:done', 'cronEmitNotify settles a crate \'done\' only for a SUCCEEDED end, and leaves a scheduled fire\'s crate to the fire (got ' + settles.join(' ') + ')');

    // a CHANNEL message's crate (Telegram / the dev channel): the hub settles the reply's LEAD run (intake.onSettled) and the host
    // delivers the crate to the OUTBOX only when it SUCCEEDED — before, any reply that went out was a delivered crate (floor
    // throughput, Pride's deliverables, XP's delivered), a failed or provider-cut run's included. COMMS' own emit was always guarded.
    const { makeChannelHub } = require('../sidecar/channels/hub.js');
    const hubStore = () => { const hist = new Map(); return { loadHistory: a => (hist.get(a) || []).slice(), appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; }, getChatRecord: () => undefined }; };
    const settledFor = async (end, raise) => {
      const seen = [];
      let n = 0;
      const hub = makeChannelHub({
        runOnce: async (o) => {
          o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
          o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'an answer' });
          if (raise) o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, message: 'the provider failed' });
          o.emit('agent.run.end', Object.assign({ agentId: o.agentId, runId: o.runId, turns: 1, usd: 0 }, end));
        },
        store: hubStore(), send: () => Promise.resolve({ ok: true, messageId: 'm1' }), secrets: () => ({ key: 'k', model: 'm' }),
        classify: () => false, emit: () => {}, newId: () => 'hub-run-' + (++n)
      });
      await hub.onInbound({ channel: 'telegram', chatId: '555', chatType: 'dm', userId: 'u1', text: 'write the summary', messageId: '1', ts: 1 }, { onSettled: s => seen.push(s && s.ok) });
      return seen.join(',') || '(never settled)';
    };
    A.eq(await settledFor({ reason: 'done' }), 'true', 'a channel reply whose lead run succeeded settles ok (its crate is delivered)');
    for (const [why, end, raise] of [['a provider-cut reply', { reason: 'done', finishReason: 'length' }], ['a raised error', { reason: 'error' }, true],
      ['a question it asked', { reason: 'clarifying' }], ['a spending limit', { reason: 'budget' }]]) {
      A.eq(await settledFor(end, raise), 'false', 'a channel reply after ' + why + ' settles NOT ok: its crate is never delivered to the OUTBOX');
    }
    // the host's own delivery rule, sliced from both intakes and evaluated: delivered ONLY on the hub's proof (review 4.2 — `replyOk !==
    // false` delivered a crate the hub never settled: the no-model reply, an E-STOP, a thrown onInbound)
    for (const [where, slice] of [['the Telegram intake', idxSrc.slice(idxSrc.indexOf('const recordResolved = (info) => {'), idxSrc.indexOf('const recordResolved = (info) => {') + 3200)],
      ['the dev channel', idxSrc.slice(idxSrc.indexOf('const inMsg = { chatId, userId:'), idxSrc.indexOf('const inMsg = { chatId, userId:') + 3200)]]) {
      const rule = /if \(jobResult\) lineRunner\.deliverCrate[^\n]*\n\s*else if \(replyOk === true\) chanEmit[^\n]*/.exec(slice);
      // the dev channel also reads a refusal for a held saved floor off the settlement (additive: heldRouting, saved-hold.js); the two delivery reads stay as pinned
      A.ok(/onSettled: \(s\) => \{ replyOk = !!\(s && s\.ok\); jobResult = s && s\.result;[^}]*\}/.test(slice) && !!rule, 'fixture: ' + where + '\'s shared-result and non-line delivery branches are sliced');
      const delivers = (replyOk, jobResult) => {
        const events = [], emit = (name, payload) => events.push({ name, payload });
        const book = require('../sidecar/routing/line-runner.js').makeLineRunner({ emit, runOnce: async () => { throw new Error('crate test must not start a run'); } });
        if (rule) new Function('replyOk', 'jobResult', 'lineRunner', 'chanEmit', 'workitemId', 'agentId', rule[0])(replyOk, jobResult, book, emit, 'crate', 'agent');
        return events.filter(e => e.name === 'workitem.delivered' && e.payload.finalQueueId === 'outbox').length;
      };
      A.eq([delivers(true, null), delivers(false, null), delivers(null, null)], [1, 0, 0], where + ': non-line reply requires actual settled success');
      A.eq([delivers(true, { delivered: false }), delivers(false, { delivered: true }), delivers(null, { delivered: false })], [0, 1, 0], where + ': a line crate reads only its shared job result, including stopped/unsettled work');
    }
  }

  // ---- review 4.2 ----
  {
    const { makeChannelHub } = require('../sidecar/channels/hub.js');
    const LineFire = require('../sidecar/routing/line-fire.js');
    const idxSrc = sidecarSourceFiles().find(f => f.rel === 'sidecar/index.js').text;
    const hubStore = () => { const hist = new Map(); return { loadHistory: a => (hist.get(a) || []).slice(), appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; }, getChatRecord: () => undefined }; };
    const hubWith = o => { let n = 0; return makeChannelHub(Object.assign({ store: hubStore(), send: () => Promise.resolve({ ok: true, messageId: 'm1' }), secrets: () => ({ key: 'k', model: 'm' }),
      classify: () => true, emit: () => {}, newId: () => 'hub-run-' + (++n) }, o)); };
    const entryRun = end => async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'half an answ' });
      if (end) o.emit('agent.run.end', Object.assign({ agentId: o.agentId, runId: o.runId, turns: 1, usd: 0 }, end));
    };
    const msg = () => ({ channel: 'telegram', chatId: '555', chatType: 'dm', userId: 'u1', text: 'write the summary', messageId: '1', ts: 1 });

    // a channel line a reviewer BLOCKED: the entry ran clean, the work is held at the gate — the crate is no delivered work. The hub settles
    // the reply on RunOutcome.ofLine, as a routine's fire does (cron finishFire, review 4.1): it read only the entry's end before.
    {
      const why = 'the reviewer at the gate g1 answered VERDICT: blocked, so the work is held there — not sent on, not shipped';
      const lineOf = blocked => ({ stopNote: r => LineFire.lineStopNote(r), advance: async () => Object.assign({ text: 'draft (held)', agentId: 'reviewer', hops: [{ agentId: 'reviewer', usd: 0, ms: 1 }], usd: 0, stopped: blocked ? why : null }, blocked ? { blocked: why } : {}) });
      for (const [said, blocked, want] of [['a line a reviewer blocked', true, 'false'], ['a line that ran clean', false, 'true']]) {
        const seen = [];
        await hubWith({ runOnce: entryRun({ reason: 'done', outcome: 'succeeded' }), chain: lineOf(blocked) }).onInbound(msg(), { onSettled: s => seen.push(s && s.ok) });
        A.eq(seen.join(',') || '(never settled)', want, 'a channel reply after ' + said + ' settles ' + (want === 'true' ? 'ok' : 'NOT ok: its crate is never delivered to the OUTBOX'));
      }
    }

    // the hub's ENTRY stage hands its text down the work line only when its own run SUCCEEDED (as the routine's cron-driver gate and Run
    // Now do): a provider-cut, budget-stopped, step-limited, asking or endless entry raised no agent.run.error and bought every stage
    // downstream on its partial answer
    for (const [said, end, want] of [['a succeeded entry', { reason: 'done', outcome: 'succeeded' }, 1], ['a provider-cut entry', { reason: 'done', finishReason: 'length', outcome: 'cut_short' }, 0],
      ['a budget-stopped entry', { reason: 'budget', outcome: 'out_of_budget' }, 0], ['a step-limited entry', { reason: 'max_iters', outcome: 'step_limit' }, 0],
      ['an entry that asked a question', { reason: 'clarifying', outcome: 'asked' }, 0], ['an entry that never reported its end', null, 0]]) {
      const advanced = [], sends = [];
      const chain = { stopNote: () => '', advance: async (seed) => { advanced.push(seed.text); return { text: 'EDITED: ' + seed.text, agentId: 'editor', hops: [{ agentId: 'editor', usd: 0, ms: 1 }], usd: 0, stopped: null }; } };
      await hubWith({ runOnce: entryRun(end), chain, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm1' }); } }).onInbound(msg());
      A.eq(advanced.length, want, said + (want ? ' hands its answer down the line' : ' never hands its partial answer down the line (got ' + JSON.stringify(advanced) + ')'));
      if (!want) A.ok(sends.length === 1 && !/EDITED:/.test(sends[0]), said + ': the reply is the entry\'s own, never a downstream stage\'s (got ' + JSON.stringify(sends) + ')');
    }

    // a message the hub NEVER settles — no model configured, an E-STOP mid-run — is no delivered crate (the host delivers only on proof, above)
    {
      const seen = [];
      await hubWith({ runOnce: async () => { throw new Error('never runs'); }, secrets: () => ({ key: '', model: '', error: 'No provider/model is configured yet.' }) })
        .onInbound(msg(), { onResolved: () => {}, onSettled: s => seen.push(s && s.ok) });
      A.ok(!seen.includes(true), 'a message with no model configured never settles ok (got ' + JSON.stringify(seen) + ')');
      const halted = [];
      let hub = null;
      hub = hubWith({ runOnce: async (o) => {
        o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
        const rec = hub._internals.inflight.get('555'); if (rec) { rec.superseded = true; rec.halted = true; }   // halt.js, as E-STOP marks it
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 1, usd: 0 });
      } });
      await hub.onInbound(msg(), { onSettled: s => halted.push(s && s.ok) });
      A.ok(!halted.includes(true), 'a message an E-STOP halted never settles ok (got ' + JSON.stringify(halted) + ')');
    }

    // the TRIGGER and SEND TO runners read each stage's run row through index.js runsFor: it dropped the row's outcome, so a stage the
    // provider cut ({reason:'done', outcome:'cut_short'} on disk — the runstore keeps no finishReason) read as finished and the job rode to
    // its OUTBOX. Every projection is sliced from the sidecar and fed the stored rows.
    {
      const stored = { s1: [{ runId: 'r-cut', agentId: 'agent-a', reason: 'done', outcome: 'cut_short', usd: 0.01, streamId: 's1', ts: 1 }, { runId: 'r-ok', agentId: 'agent-a', reason: 'done', outcome: 'succeeded', usd: 0.01, streamId: 's1', ts: 2 }] };
      const runStore = { list: (_a, o) => stored[o.streamId] || [] };
      const projections = [];
      for (let at = idxSrc.indexOf('runsFor: (streamId) =>'); at >= 0; at = idxSrc.indexOf('runsFor: (streamId) =>', at + 1)) {
        const end = idxSrc.indexOf('})),\n', at);
        projections.push(new Function('runStore', 'return ' + idxSrc.slice(at + 'runsFor: '.length, end + 3) + ';')(runStore));
      }
      A.eq(projections.length, 2, 'fixture: the trigger runner\'s and the SEND TO runner\'s runsFor are sliced from the sidecar');
      projections.forEach((runsFor, i) => {
        const rows = runsFor('s1'), cut = rows.find(r => r.runId === 'r-cut'), ok = rows.find(r => r.runId === 'r-ok');
        A.ok(cut && !RunOutcome.ofRow(cut).ok && ok && RunOutcome.ofRow(ok).ok, (i ? 'the SEND TO' : 'the trigger') + ' runner\'s run rows keep each row\'s outcome: a cut stage never reads finished (got ' + JSON.stringify(cut) + ')');
      });
      // …and the trigger runner, driven over the sliced runsFor, never records a cut single-stage job as reaching its OUTBOX
      const { makeTriggerRunner } = require('../sidecar/routing/trigger-runner.js');
      const T = require('../sidecar/routing/triggers.js');
      const emitted = []; let n = 0; const disk = { triggers: { triggers: [] } };
      const plan = { lines: [{ lineId: 'L1' }], reach: { 'agent-a': true }, lineOfAgent: { 'agent-a': 'L1' } };
      const R = makeTriggerRunner({
        load: () => JSON.parse(JSON.stringify(disk.triggers)), save: v => { disk.triggers = v; }, seen: { load: () => ({}), save: () => {} },
        makeHub: hooks => ({ onInbound(m) {
          hooks.onRouted({ agentId: 'agent-a', dockId: 'b1' });
          hooks.onResolved({ chatId: m.chatId, agentId: 'agent-a', isTask: true, lineId: 'L1', dockId: 'b1' });
          const sid = hooks.streamId();
          return Promise.resolve().then(() => { stored[sid] = [{ runId: 'r1', agentId: 'agent-a', reason: 'done', outcome: 'cut_short', usd: 0.01, streamId: sid }]; hooks.onLineOutcome({ agentId: 'agent-a', dockId: 'b1', stopped: null, hops: [] }); });
        }, close() {} }),
        plan: () => plan, shipsToOutbox: a => a === 'agent-a', dayCap: () => ({ cap: null, spent: 0 }), runsFor: projections[0],
        emit: (nm, p) => emitted.push({ nm, p }), watcher: { watch() {}, unwatch() {}, close() {} }, now: () => 1000, newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {}
      });
      const cw = R.create({ kind: 'webhook', lineId: 'L1', name: 'hook', maxPerHour: 3 }, { secretHash: T.hashSecret('k') });
      R.enqueue(cw.trigger.id, { text: 'job', preview: 'HOOK' });
      for (let i = 0; i < 40 && !(R.view(cw.trigger.id) || {}).lastOutcome; i++) await new Promise(r => setTimeout(r, 5));
      const v = R.view(cw.trigger.id) || {};
      A.ok(v.lastOutcome && v.lastOutcome.ok === false && !emitted.some(e => e.nm === 'workitem.delivered'), 'a trigger job whose stage the provider cut is never recorded ok, nor its crate delivered (got ' + JSON.stringify({ lastOutcome: v.lastOutcome, lastError: v.lastError }) + ')');
    }

    // the recipe last-run helper (marketplace.js lastRunHTML, no caller yet): the run-log cache kept only the bare reason, so its RunOutcome.reasonOf could
    // never see a cut or raised run (review 4.1's fix never took effect). The cache line and lastRunHTML are lifted from the page.
    {
      const mkt = fs.readFileSync(path.join(ROOT, 'frontend/app/marketplace.js'), 'utf8');
      const mapLine = (mkt.split(/\r?\n/).find(l => /map\[id\] = \{ ts: Number\(row\.ts\)/.test(l)) || '').trim();
      // (review 9.2: the word map is keyed on the row's outcome, LAST_RUN_WORD; the tip before it named it RUN_REASON_WORD)
      const a = ['  const LAST_RUN_WORD = ', '  const RUN_REASON_WORD = '].map(n => mkt.indexOf(n)).find(i => i > 0) || -1, fnAt = mkt.indexOf('function lastRunHTML(r)'), b = mkt.indexOf('\n  }\n', fnAt) + 4;
      A.ok(!!mapLine && a > 0 && fnAt > a && b > fnAt, 'fixture: the recipe run cache and lastRunHTML are lifted from marketplace.js');
      const rows = [{ recipeId: 'rc', ts: 1, reason: 'done', outcome: 'cut_short', artifacts: [] }, { recipeId: 'rr', ts: 1, reason: 'done', outcome: 'failed', failureCode: 'run_failure', artifacts: [] },
        { recipeId: 'ok', ts: 1, reason: 'done', outcome: 'succeeded', artifacts: [] }, { recipeId: 'rx', ts: 1, reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked', artifacts: [] }];
      const map = {};
      for (const row of rows) new Function('map', 'id', 'row', mapLine)(map, row.recipeId, row);
      const lastRunHTML = new Function('recipeRuns', 'scoutRelTime', 'artifactLabel', 'esc', 'recipeDrift', mkt.slice(a, b) + '\nreturn lastRunHTML;')(map, () => '', () => '', s => String(s), null);
      const said = id => lastRunHTML({ id });
      // (review 9.2: a cut reply did not finish — it wears the warn tone, never the failure's red)
      A.ok(/was cut short/.test(said('rc')) && /mkt-r-lastrun warn"/.test(said('rc')), 'a recipe whose last run the provider cut reads "was cut short" in the warn tone, never done nor the failure red (got ' + said('rc') + ')');
      A.ok(/errored/.test(said('rr')) && /mkt-r-lastrun bad"/.test(said('rr')), 'a recipe whose last run raised its own error reads "errored", never done (got ' + said('rr').replace(/<[^>]+>/g, '') + ')');
      A.ok(/· done/.test(said('ok')) && !/lastrun bad/.test(said('ok')), 'a recipe whose last run succeeded reads done');
      // review 9.2: an END-ONLY refusal (reason 'error', stamped 'refused') read "errored" — lastRunHTML's RunOutcome.reasonOf kept the bare 'error'
      A.ok(/· refused/.test(said('rx')) && !/errored/.test(said('rx')), 'a recipe whose last run was refused at its end only reads "refused", never "errored" (got ' + said('rx').replace(/<[^>]+>/g, '') + ')');
    }

    // the desk screen's idle view reads the agent's LAST history row (GET /api/runs): a cut reply is WAS CUT SHORT, a raised one FAILED
    {
      const D = require('../frontend/app/deskscreen.js');
      const read = row => (typeof D._lastRunRead === 'function' ? D._lastRunRead(row) : { state: '(no _lastRunRead)', word: '' });
      const cutRow = { runId: 'c', agentId: 'agent', reason: 'done', outcome: 'cut_short', streamId: 's' };
      const raisedRow = { runId: 'f', agentId: 'agent', reason: 'done', outcome: 'failed', failureCode: 'run_failure', streamId: 's' };
      const okRow = { runId: 'o', agentId: 'agent', reason: 'done', outcome: 'succeeded', streamId: 's' };
      // (review r8: a cut reply did not FINISH — no failure: the warn lamp, never the failed red nor IDLE)
      A.ok(read(cutRow).state === 'warn' && read(cutRow).word === 'WAS CUT SHORT', 'the desk screen: an agent whose last run was cut reads WAS CUT SHORT in the warn lamp, never IDLE nor FAILED (got ' + JSON.stringify(read(cutRow)) + ')');
      A.ok(read(raisedRow).state === 'failed' && read(raisedRow).word === 'FAILED', 'the desk screen: a last run its own error outranked reads FAILED (got ' + JSON.stringify(read(raisedRow)) + ')');
      A.ok(read(okRow).state === 'done' && read(okRow).word === 'IDLE', 'the desk screen: a last run that succeeded reads IDLE (done)');
    }

    // `starnet watch` (bin/lib/station-commands.js) prints a run's end off GET /api/observe: a cut reply printed '■ done'
    {
      const { observerView } = require('../sidecar/observer.js');
      const { makeWatchFormatter } = require('../bin/lib/station-commands.js');
      const fmt = makeWatchFormatter({ agent: 'NOVA' });
      const printed = end => fmt({ name: 'agent.run.end', payload: observerView('agent.run.end', end, {}) }, 0).join(' ');
      A.ok(!/■ done/.test(printed(CUT)) && /cut_short/.test(printed(CUT)), '`starnet watch`: a provider-cut end never prints "■ done" (got ' + printed(CUT) + ')');
      A.ok(!/■ done/.test(printed(RAISED)), '`starnet watch`: a \'done\' end its own error outranked never prints "■ done" (got ' + printed(RAISED) + ')');
      A.ok(/■ done/.test(printed(DONE)), '`starnet watch`: a succeeded end prints "■ done"');
    }
  }

  // ---- review 4.3: the REPORT copies (a run's bare reason handed on as how it ended) and the one crate rule for a line that stopped ----
  {
    // run-history rows as the runstore keeps them: the stamped outcome, never a finishReason
    const CUT_ROW = { runId: 'r-cut', agentId: 'agent', reason: 'done', outcome: 'cut_short', turns: 1, usd: 0.01 };
    const RAISED_ROW = { runId: 'r-raised', agentId: 'agent', reason: 'done', outcome: 'failed', failureCode: 'incomplete_work', turns: 1, usd: 0.01 };
    const OK_ROW = { runId: 'r-ok', agentId: 'agent', reason: 'done', outcome: 'succeeded', turns: 1, usd: 0.01 };
    const srcOf = rel => (sidecarSourceFiles().find(f => f.rel.replace(/\\/g, '/') === rel) || {}).text || '';

    // the MCP bridge (sidecar/mcp/bridge-core.js): conversations_list promises each run's outcome, and projected the bare reason — an MCP
    // client was told a cut run and a run its own error outranked ended 'done', exactly like a clean one
    {
      const { makeBridge, makeEventQueue } = require('../sidecar/mcp/bridge-core.js');
      const rows = [Object.assign({ title: 'cut', ts: 3, streamId: 's' }, CUT_ROW), Object.assign({ title: 'raised', ts: 2, streamId: 's' }, RAISED_ROW), Object.assign({ title: 'ok', ts: 1, streamId: 's' }, OK_ROW)];
      const bridge = makeBridge({ callSidecar: async () => ({ ok: true, status: 200, json: { runs: rows } }), queue: makeEventQueue({}) });
      const list = await bridge.callTool('conversations_list', {});
      const conv = id => ((list && list.conversations) || []).find(c => c.session_key === id) || {};
      A.ok(conv('r-cut').reason !== 'done' && conv('r-cut').outcome === 'cut_short', 'MCP conversations_list: a cut run never reads ended "done" and carries its outcome (got ' + JSON.stringify({ reason: conv('r-cut').reason, outcome: conv('r-cut').outcome }) + ')');
      A.ok(conv('r-raised').reason !== 'done' && conv('r-raised').outcome === 'failed' && conv('r-raised').failureCode === 'incomplete_work', 'MCP conversations_list: a run its own error outranked reads failed, with its code (got ' + JSON.stringify({ reason: conv('r-raised').reason, outcome: conv('r-raised').outcome, failureCode: conv('r-raised').failureCode }) + ')');
      A.ok(conv('r-ok').reason === 'done' && conv('r-ok').outcome === 'succeeded' && !('failureCode' in conv('r-ok')), 'MCP conversations_list: a succeeded run reads done / succeeded');
      const one = await bridge.callTool('conversation_get', { session_key: 'r-cut' });
      A.ok(one && one.reason !== 'done' && one.outcome === 'cut_short', 'MCP conversation_get: a cut run never reads ended "done" (got ' + JSON.stringify(one && { reason: one.reason, outcome: one.outcome }) + ')');
    }

    // station.test_line: the job's verdict said a step ended badly while every step read 'done' — each step is labelled by its outcome
    const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
    {
      const obj = { ok: false, error: 'a step did not finish cleanly', totalUsd: 0.03, replies: ['half'],
        runs: [Object.assign({ dockId: 'b3' }, RAISED_ROW), Object.assign({ dockId: 'b2' }, CUT_ROW), Object.assign({ dockId: 'b1' }, OK_ROW)] };   // newest first, as the route answers
      const station = { request: async verb => verb === 'station.line_ref'
        ? { ok: true, result: { lineId: 'L1', name: 'DRAFTS', crewed: true, steps: [{ id: 'b1', role: 'writer' }, { id: 'b2', role: 'editor' }, { id: 'b3', role: 'checker' }] } } : { ok: false, error: 'n/a' } };
      const out = await makeStationTools({ station, sampleLineJob: async () => ({ code: 200, obj }) }).testLineTool.run({ line: 'DRAFTS', job: 'write it' }, {});
      let J = {}; try { J = JSON.parse(String(out.content).split('\n')[0]); } catch (_) { J = {}; }
      const steps = J.steps || [];
      A.ok(J.status === 'problem' && steps.map(s => s.ended).join(',') === 'done,cut_short,error', 'station.test_line: a cut step and a step its own error outranked never read ended "done" (got ' + JSON.stringify(steps.map(s => s.ended)) + ')');
      A.ok(steps[2] && steps[2].failureCode === 'incomplete_work' && steps[0] && !('failureCode' in steps[0]), 'station.test_line: a failed step names its own code; a finished one names none');
    }

    // line-stats' bay docks feed station.layout / station.map (each bay's last run) and the bay lamp's seed after a reload: a cut bay read
    // `result: done, failed: false`, the same as a succeeded one, and a raised bay's lamp read FAILED · DONE
    {
      const { lineStats } = require('../sidecar/routing/line-stats.js');
      const today = lineStats({ rows: [Object.assign({ dockId: 'b-cut', lineId: 'L1', ts: 30 }, CUT_ROW), Object.assign({ dockId: 'b-raised', lineId: 'L1', ts: 20 }, RAISED_ROW),
        Object.assign({ dockId: 'b-ok', lineId: 'L1', ts: 10 }, OK_ROW)], lines: [{ lineId: 'L1' }], since: 0 });
      const d = today.docks || {}, dk = id => d[id] || {};
      A.ok(dk('b-cut').reason === 'cut_short' && dk('b-cut').outcome === 'cut_short' && dk('b-raised').reason === 'error' && dk('b-raised').outcome === 'failed' && dk('b-ok').reason === 'done' && dk('b-ok').outcome === 'succeeded',
        'line-stats docks: each bay\'s last run keeps its outcome-aware reason and its outcome (got ' + JSON.stringify(d) + ')');
      const station = { request: async verb => verb === 'station.layout' ? { ok: true, result: { routing: { state: 'live' }, lines: [{ lineId: 'L1', name: 'DRAFTS', status: 'ready',
        starts: { schedules: [], channels: [], events: [] }, steps: [{ step: 1, propId: 'b-ok', role: 'WRITER' }, { step: 2, propId: 'b-cut', role: 'EDITOR' }, { step: 3, propId: 'b-raised', role: 'CHECKER' }] }] } } : { ok: false, error: 'n/a' } };
      const tools = makeStationTools({ station, layoutFacts: { today: () => today }, now: null });
      let lay = {}; try { lay = JSON.parse((await tools.layoutTool.run({}, {})).content); } catch (_) { lay = {}; }
      const said = (((lay.lines || [])[0] || {}).steps || []).map(s => s.lastRun);
      A.eq(said.join(','), 'done,cut_short,error', 'station.layout: a cut bay\'s and an error-outranked bay\'s last run never read "done" (got ' + JSON.stringify(said) + ')');
      let one = {}; try { one = JSON.parse((await tools.layoutTool.run({ line: 'L1' }, {})).content); } catch (_) { one = {}; }
      const lr = (((one.line || {}).steps || [])[1] || {}).lastRun || {};
      A.ok(lr.result === 'cut_short' && lr.failed === false && lr.unfinished === undefined, 'station.layout { line }: a cut bay\'s last run is result cut_short, counted in neither line count (got ' + JSON.stringify(lr) + ')');
      // the layout says what the line counted: its unfinished number, and a dead run that did not fail as unfinished
      const counted = { lines: [{ lineId: 'L1', runs: 3, shipped: 0, failed: 1, unfinished: 2, tests: 0, usdToday: 0, capUsdPerDay: 5, medianMs: null, spendDay: 'utc' }],
        docks: { 'b-ok': { runId: 'a', reason: 'budget', outcome: 'out_of_budget', failed: true }, 'b-cut': { runId: 'b', reason: 'refusal', failed: true }, 'b-raised': { runId: 'c', reason: 'error', outcome: 'failed', failed: true } } };
      const countedTools = makeStationTools({ station, layoutFacts: { today: () => counted }, now: null });
      let two = {}; try { two = JSON.parse((await countedTools.layoutTool.run({ line: 'L1' }, {})).content); } catch (_) { two = {}; }
      const flags = (((two.line || {}).steps || [])).map(x => [(x.lastRun || {}).failed, (x.lastRun || {}).unfinished === true]);
      A.eq(((two.line || {}).today || {}).unfinished, 2, 'station.layout: today carries the line\'s unfinished count');
      A.eq(flags, [[false, true], [false, true], [true, false]], 'station.layout { line }: a spend cap and a refusal are unfinished, a failure failed, as line-stats counts them (got ' + JSON.stringify(flags) + ')');
      const LW = require('../frontend/app/linewatch.js');
      const w = LW.create({ entryDock: () => 'b-ok' });
      w.seedOutcomes(d);
      const raisedLamp = w.status('b-raised', 1);
      A.ok(raisedLamp.state === 'failed' && raisedLamp.reason === 'error' && w.status('b-cut', 1).state !== 'failed' && (w.lastOutcome('b-cut') || {}).reason === 'cut_short',
        'the bay lamp seeded after a reload: a raised bay reads FAILED · ERROR (never FAILED · DONE); a cut bay keeps cut_short (got ' + JSON.stringify({ raised: raisedLamp, cut: w.lastOutcome('b-cut') }) + ')');
    }

    // the diagnostics bundle's "Last run" (index.js collectDiagnosticsInput, sliced): a cut run's diagnostics said '— done'
    {
      const m = /lastRun: recent \? (\{[^\n]*?\}) : null,/.exec(srcOf('sidecar/index.js'));
      A.ok(!!m, 'fixture: the diagnostics bundle\'s last run is sliced from the sidecar');
      const lastRunOf = row => (m ? new Function('recent', 'RunOutcome', 'return ' + m[1] + ';')(row, RunOutcome) : {});
      A.eq([lastRunOf(CUT_ROW).status, lastRunOf(RAISED_ROW).status, lastRunOf(OK_ROW).status].join(','), 'cut_short,error,done', 'diagnostics: the last run\'s status is its outcome-aware end, never "done" for a cut or raised run');
    }

    // a BACKGROUND worker's settled record (team.dispatch / team.spawn background): its status read the outcome, its reason stayed the
    // loop's 'done' — the DELEGATED card said "failed · done", /api/overseer and the subagent_stop hook (child_reason) said it ended 'done'
    {
      const root43 = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-family-43-'));
      try {
        const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root43, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
        const { dispatchTool, spawnTool } = makeOrchestrationTools({ runOnce: async () => ({ reason: 'done', finishReason: 'length', messages: say('half an answ'), usd: 0 }), roster: () => roster,
          key: 'k', model: 'lead', selfSystem: 'S', newId: counter(), subagents });
        const settledRec = async id => { for (let i = 0; i < 40 && !((subagents.get(id) || {}).completedAt); i++) await new Promise(r => setImmediate(r)); return subagents.get(id) || {}; };
        const handleOf = out => { try { return JSON.parse(out.content)[0] || {}; } catch (_) { return {}; } };
        const dRec = await settledRec(handleOf(await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }], background: true }, { agentId: 'lead', emit: () => {} })).id);
        A.ok(dRec.status === 'error' && dRec.reason === 'cut_short', 'a background team.dispatch worker the provider cut settles error / cut_short, never reason "done" (got ' + JSON.stringify({ status: dRec.status, reason: dRec.reason }) + ')');
        const sRec = await settledRec(handleOf(await spawnTool.run({ tasks: [{ prompt: 'check example.com' }], background: true }, { agentId: 'lead', emit: () => {} })).id);
        A.ok(sRec.status === 'error' && sRec.reason === 'cut_short', 'a background team.spawn clone the provider cut settles error / cut_short, never reason "done" (got ' + JSON.stringify({ status: sRec.status, reason: sRec.reason }) + ')');
      } finally { fs.rmSync(root43, { recursive: true, force: true }); }
    }

    // the `starnet run` receipt (bin/starnet.js, its line lifted): a cut run printed "■ done · the reply was cut short"
    {
      const m = /if \(summary\.proven\) log\((.+)\);\s*$/m.exec(fs.readFileSync(path.join(ROOT, 'bin/starnet.js'), 'utf8'));
      A.ok(!!m, 'fixture: the `starnet run` receipt line is lifted from bin/starnet.js');
      const receipt = s => (m ? new Function('summary', 'said', 'spend', 'RO', 'return ' + m[1] + ';')(s, s.outcome ? ' · ' + RunOutcome.line(s) : '', '', RunOutcome) : '');
      const sum = o => Object.assign({ proven: true, turns: 1, toolCalls: [], runId: 'r' }, o);
      const cutSaid = receipt(sum({ reason: 'done', finishReason: 'length', outcome: 'cut_short' })), raisedSaid = receipt(sum({ reason: 'done', outcome: 'failed', failureCode: 'run_failure' }));
      A.ok(/^■ cut_short/.test(cutSaid) && /^■ error/.test(raisedSaid), '`starnet run`: a cut or error-outranked run\'s receipt never leads with "■ done" (got ' + JSON.stringify([cutSaid, raisedSaid]) + ')');
      A.ok(/^■ done/.test(receipt(sum({ reason: 'done', outcome: 'succeeded' }))), '`starnet run`: a succeeded run\'s receipt reads "■ done"');
    }

    // a SEND TO hand-off's shared result and a line job's stored step (linejobs normRun) keep
    // the step's own failureCode: the WORKFLOWS step label read "failed (run_failure)" for a step that failed with its own code
    {
      const hsrc = srcOf('sidecar/routing/handoff-runner.js');
      A.ok(/lineRunner\.settle\(job, \{ line: lo, runs,/.test(hsrc), 'the hand-off hands its exact run rows to the shared job settle');
      const projected = require('../sidecar/routing/line-runner.js').outcomeOf({ runs: [Object.assign({ dockId: 'b1', streamId: 's1' }, RAISED_ROW)] }).runs;
      A.ok(projected[0] && projected[0].failureCode === 'incomplete_work' && !('finishReason' in projected[0]), 'the shared job result keeps the step failureCode without inventing terminal evidence');
      const LineJobs = require('../sidecar/routing/linejobs.js');
      let st = LineJobs.start({ jobs: [] }, { id: 'job-43abcdef', line: 'L1', name: 'n', text: 't', streamId: 's1', at: 1 }).state;
      st = LineJobs.finish(st, 'job-43abcdef', { at: 2, usd: 0, output: '', status: 'problem', runs: projected.length ? projected : [Object.assign({ dockId: 'b1' }, RAISED_ROW)] }).state;
      const r0 = ((LineJobs.get(st, 'job-43abcdef') || {}).runs || [])[0] || {};
      A.eq(RunOutcome.line(RunOutcome.ofRow(r0)), 'failed (incomplete_work)', 'a line job\'s step record keeps the step\'s own failure code (got ' + JSON.stringify(r0) + ')');
    }

    // ONE crate rule for a work line that stopped short (a downstream hop failed, a ceiling, a refusal) or whose joiner sent on PARTIAL
    // (routing/line-fire.js lineDelivered): the channel hub settled such a reply ok and its crate rode to the OUTBOX, while the trigger and
    // SEND TO runners, the sample route and chain.js's own line-output receipt refused it. An UNAPPROVED loop still reached its OUTBOX.
    {
      const { makeChannelHub } = require('../sidecar/channels/hub.js');
      const LineFire = require('../sidecar/routing/line-fire.js');
      const hubStore = () => { const hist = new Map(); return { loadHistory: a => (hist.get(a) || []).slice(), appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; }, getChatRecord: () => undefined }; };
      const settledOver = async line => {
        const seen = []; let n = 0;
        const hub = makeChannelHub({ store: hubStore(), send: () => Promise.resolve({ ok: true, messageId: 'm1' }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, emit: () => {}, newId: () => 'hub-run-' + (++n),
          runOnce: async (o) => {
            o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
            o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'a draft' });
            o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', outcome: 'succeeded', turns: 1, usd: 0 });
          },
          chain: { stopNote: r => LineFire.lineStopNote(r), advance: async () => line } });
        await hub.onInbound({ channel: 'telegram', chatId: '555', chatType: 'dm', userId: 'u1', text: 'write the summary', messageId: '1', ts: 1 }, { onSettled: s => seen.push(s && s.ok) });
        return seen.join(',') || '(never settled)';
      };
      const hop = who => ({ agentId: who, usd: 0, ms: 1 });
      const LINES = [
        ['a line whose downstream hop failed', { text: 'draft', agentId: 'editor', hops: [hop('editor')], usd: 0, stopped: 'EDITOR failed: its run failed (rate_limit)' }, false],
        ['a line whose joiner sent on partial', { text: 'joined', agentId: 'joiner', hops: [hop('joiner')], usd: 0, stopped: null, partial: 'branch B never arrived' }, false],
        ['a line whose review loop ran out unapproved (it still reached its OUTBOX)', { text: 'final', agentId: 'pub', hops: [hop('pub')], usd: 0, stopped: null, unapproved: 'the reviewer never approved' }, true],
        ['a line that ran clean', { text: 'final', agentId: 'pub', hops: [hop('pub')], usd: 0, stopped: null }, true]];
      for (const [said, line, delivered] of LINES) {
        A.eq(await settledOver(line), String(delivered), 'a channel reply after ' + said + ' settles ' + (delivered ? 'ok' : 'NOT ok: its crate never rides to the OUTBOX'));
      }
      // the routine's two paths settle their crate through fireOutcome .crate (the invariant table drives the real scheduled fire and Run Now);
      // the fire's own RECORD is unchanged: a stopped line still records the entry run's outcome with its stop facts (quick win 25)
      const { fireOutcome } = require('../sidecar/cron-driver.js');
      const fired = line => fireOutcome({ reason: 'done', end: { reason: 'done', outcome: 'succeeded' }, buf: 'x', line: LineFire.lineFacts(line) }, null);
      const crates = LINES.map(([, line]) => fired(line).crate);
      A.eq(crates.join(' '), 'line_stopped line_stopped done done', 'a routine\'s fire settles its crate "done" only when its line delivered the whole job (got ' + crates.join(' ') + ')');
      A.ok(LINES.every(([, line]) => fired(line).errMsg === null && fired(line).outcome === 'succeeded'), 'a routine whose line stopped keeps its record as before: the entry run\'s outcome, the line\'s stop facts beside it');
    }
  }

  // ---- review 5.1: the REASON a routine's fire hands on (cron.result and its record), and the third worker settle site (team.resume) ----
  // No line-regex sees these: cron.result's reason was a local (baseReason), the page's session marker took it as a function argument,
  // routine.list read `.lastReason`, and team.resume's reason was a ternary over `(repaired || result).reason`.
  {
    const cron = require('../sidecar/cron.js');
    const cronStore = require('../sidecar/cron-store.js');
    const { makeCronDriver } = require('../sidecar/cron-driver.js');
    const LineFire = require('../sidecar/routing/line-fire.js');
    const HELD = 'the reviewer at the gate review answered VERDICT: blocked, so the work is held there';
    // run-history rows as the runstore keeps them (the stamped outcome, no error field)
    const CUT_ROW = { reason: 'done', outcome: 'cut_short', turns: 1, usd: 0.01 };
    const RAISED_ROW = { reason: 'done', outcome: 'failed', failureCode: 'incomplete_work', turns: 1, usd: 0.01 };
    const FIRES = {
      cut: [{ reason: 'done', finishReason: 'length', outcome: 'cut_short' }, null, null, 'cut_short'],
      raised: [{ reason: 'done', outcome: 'failed', failureCode: 'incomplete_work' }, { message: 'the image task is unmet', failureCode: 'incomplete_work' }, null, 'error'],
      held: [{ reason: 'done', outcome: 'succeeded' }, null, { text: 'All done.', hops: [{ agentId: 'reviewer', dockId: 'review' }], stopped: HELD, blocked: HELD, usd: 0 }, 'blocked'],
      ok: [{ reason: 'done', outcome: 'succeeded' }, null, null, 'done']
    };
    // a due routine through the REAL cron driver (its run ends as given, its work line after it); or the same run settled the way Run Now
    // settles it (sidecar/index.js handleCronRun: its tee's state, the line folded in, then cronDriver.settleRun — the invariant table
    // drives handleCronRun's own slices)
    async function fire(kind, viaRunNow) {
      const [end, err, line] = FIRES[kind];
      const T0 = 1700000000000;
      let store = [cronStore.makeJob({ id: 'j1', prompt: 'do it', agentId: 'cron_j1', schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 })];
      const events = []; let n = 0;
      const driver = makeCronDriver({ getJobs: () => store, setJobs: j => { store = j; return true; },
        runOnce: o => {
          o.emit('agent.token', { runId: o.runId, agentId: o.agentId, delta: 'half an answer' });
          if (err) o.emit('agent.run.error', Object.assign({ runId: o.runId, agentId: o.agentId }, err));
          o.emit('agent.run.end', Object.assign({ runId: o.runId, agentId: o.agentId, turns: 1, usd: 0 }, end));
          return Promise.resolve();
        },
        advanceChain: line ? () => Promise.resolve(line) : undefined, placeWorkitem: () => {}, settleWorkitem: () => {},
        emit: (name, payload) => events.push({ name, payload }), newId: () => 'cr-' + (++n), newAbort: () => new AbortController(),
        now: () => T0 + 60000, getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000 });
      if (viaRunNow) {
        const runId = 'rn-' + kind;
        driver.leases.set('j1', { runId, startedAt: T0, heartbeatAt: T0, ac: new AbortController(), isOnce: false });
        const state = { buf: 'half an answer', errMsg: err ? err.message : null, failureCode: err ? err.failureCode : '', reason: end.reason, end: Object.assign({ runId }, end), transient: false, usd: 0, toolsRan: 0 };
        if (line) LineFire.foldLineIntoFire(state, line);
        driver.settleRun('j1', runId, state, null);
      } else driver.applyTick(T0 + 60000);
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      return { result: events.filter(e => e.name === 'cron.result').map(e => e.payload).pop() || {}, job: cronStore.getJob(store, 'j1') || {} };
    }
    const worldSrc = fs.readFileSync(path.join(ROOT, 'frontend/app/world.js'), 'utf8');
    // (review r7: the toast's words are the cron.result listener's own — a stop is decided before it, an auto-pause rides beside it — so the
    // listener is sliced whole, as the 6.2 fold below slices it)
    const hudAt = worldSrc.indexOf("U.bus.on('cron.result', p => {");
    const hudSrc = hudAt < 0 ? '' : worldSrc.slice(hudAt, worldSrc.indexOf('\n    });', hudAt) + '\n    });'.length);
    A.ok(!!hudSrc, 'fixture: the HUD\'s cron.result listener is lifted from world.js');
    let hudOn = null; const hudSaid = [];
    if (hudSrc) new Function('U', 'hudNote', 'RunOutcome', hudSrc)({ bus: { on: (n, fn) => { if (n === 'cron.result') hudOn = fn; } } }, (txt, cls) => hudSaid.push([txt, cls]), RunOutcome);
    const toast = p => { hudSaid.length = 0; if (hudOn) hudOn(p); const w = hudSaid.find(x => x[1] === 'warn'); return w ? w[0] : ''; };
    const fired = {};
    for (const kind of Object.keys(FIRES)) {
      const want = FIRES[kind][3];
      for (const viaRunNow of [false, true]) {
        const path_ = viaRunNow ? 'Run Now' : 'the scheduled fire';
        const { result, job } = await fire(kind, viaRunNow);
        if (!viaRunNow) fired[kind] = { result, job };
        A.ok(result.outcome === (kind === 'ok' ? 'ok' : 'failed') && result.reason === want && job.lastReason === want,
          path_ + ': a ' + kind + ' fire\'s cron.result and record name its end as ' + want + (kind === 'ok' ? '' : ', never "done"') + ' (got ' + JSON.stringify({ outcome: result.outcome, reason: result.reason, lastReason: job.lastReason }) + ')');
        // (review r8: a cut or held fire did not FINISH — "⚠ routine did not finish — <its outcome's words>", never "✕ routine failed"; a raised one failed)
        const toastWant = kind === 'raised' ? '✕ routine failed — ' + want : '⚠ routine did not finish — ' + RunOutcome.line({ outcome: want === 'cut_short' ? 'cut_short' : 'blocked' });
        if (kind !== 'ok') A.eq(toast(result), toastWant, path_ + ': the HUD toast for a ' + kind + ' fire never reads "routine failed — done", and a cut or held fire is no failure');
      }
    }

    // routine.list / routine.manage (packJob) — the lead-facing record: lastStatus 'error' beside lastReason 'done', and no outcome
    {
      const { makeRoutineTools } = require('../sidecar/tools/builtin/routines.js');
      const base = { name: 'digest', agentId: 'cron_j1', enabled: true, lastRunAt: '2023-11-14T22:14:20.000Z' };
      const jobs = [Object.assign({}, fired.cut.job, { id: 'settled-cut' }),
        Object.assign({ id: 'stored-cut', lastStatus: 'error', lastReason: 'done', lastOutcome: 'cut_short', lastError: 'the reply was cut short before it finished' }, base),   // a record written before 5.1
        Object.assign({ id: 'older-raised', lastStatus: 'error', lastReason: 'done', lastError: 'the image task is unmet' }, base),   // a record older than the outcome code
        Object.assign({ id: 'clean', lastStatus: 'ok', lastReason: 'done', lastOutcome: 'succeeded' }, base)];
      let listed = [];
      try { listed = JSON.parse((await makeRoutineTools({ listJobs: () => jobs }).listTool.run({}, { agentId: 'agent' })).content).jobs || []; } catch (_) { listed = []; }
      const one = id => listed.find(j => j && j.id === id) || {};
      A.ok(one('settled-cut').lastReason === 'cut_short' && one('settled-cut').lastOutcome === 'cut_short' && one('stored-cut').lastReason === 'cut_short' && one('stored-cut').lastOutcome === 'cut_short',
        'routine.list: a routine whose last fire the provider cut reads lastReason cut_short with its outcome, never "done" (got ' + JSON.stringify(['settled-cut', 'stored-cut'].map(id => ({ lastReason: one(id).lastReason, lastOutcome: one(id).lastOutcome }))) + ')');
      A.ok(one('older-raised').lastReason === 'error' && one('clean').lastReason === 'done' && one('clean').lastOutcome === 'succeeded',
        'routine.list: a failed record older than the outcome code reads error; a clean one reads done (got ' + JSON.stringify([one('older-raised').lastReason, one('clean').lastReason]) + ')');
      // review 9.3 (B3-CD663-01): a record a PRE-LANE station settled — lastStatus 'error' beside the fire's own end word, no outcome (cron-driver
      // markRun and cron-store at d5024f5a2) — keeps that word. packJob invented a 'failed' stamp from the coarse status, and since RunOutcome.reasonOf
      // honours a stamp its reason contradicts, a stop, a limit, a refusal, a question and an empty reply each listed lastReason 'error'. Only a 'done'
      // beside 'error' is the failure the status names; a stamped record's outcome still decides
      const LEGACY = ['cancelled', 'budget', 'max_iters', 'refusal', 'clarifying', 'empty', 'interrupted', 'cut_short', 'blocked'];
      const olds = LEGACY.map(r => Object.assign({ id: 'legacy-' + r, lastStatus: 'error', lastReason: r, lastError: 'run ended without completion: ' + r }, base))
        .concat([Object.assign({ id: 'legacy-done', lastStatus: 'error', lastReason: 'done', lastError: 'the image task is unmet' }, base),
          Object.assign({ id: 'stamped-refused', lastStatus: 'error', lastReason: 'error', lastOutcome: 'refused', lastFailureCode: 'content_policy_blocked' }, base),
          Object.assign({ id: 'stamped-failed', lastStatus: 'error', lastReason: 'error', lastOutcome: 'failed', lastFailureCode: 'rate_limit' }, base),
          Object.assign({ id: 'stamped-stop', lastStatus: 'error', lastReason: 'cancelled', lastOutcome: 'stopped' }, base),
          Object.assign({ id: 'stamped-budget', lastStatus: 'error', lastReason: 'budget', lastOutcome: 'out_of_budget' }, base)]);
      let oldListed = [];
      try { oldListed = JSON.parse((await makeRoutineTools({ listJobs: () => olds }).listTool.run({}, { agentId: 'agent' })).content).jobs || []; } catch (_) { oldListed = []; }
      const old = id => oldListed.find(j => j && j.id === id) || {};
      const flattened = LEGACY.filter(r => old('legacy-' + r).lastReason !== r);
      A.ok(oldListed.length === olds.length && !flattened.length && old('legacy-cancelled').lastStatus === 'stopped' && old('legacy-done').lastReason === 'error'
        && old('stamped-refused').lastReason === 'refusal' && old('stamped-failed').lastReason === 'error' && old('stamped-stop').lastReason === 'cancelled'
        && old('stamped-stop').lastStatus === 'stopped' && old('stamped-budget').lastReason === 'budget',
        'review 9.3: routine.list says a pre-lane record\'s own end — a stop (lastStatus stopped), a limit, a refusal, a question, an empty reply — never the \'error\' its coarse status names; a done beside error still reads error and a stamped record its outcome (flattened: ' + JSON.stringify(flattened) + '; got ' + JSON.stringify(oldListed.map(j => [j.id, j.lastStatus, j.lastReason])) + ')');
      // the page's WorkView.routineView over the same stored record
      const WorkView = require('../frontend/app/workview.js');
      A.eq(WorkView.routineView(jobs[1], true).last, 'Last run: the reply was cut short', 'WorkView: a cut routine\'s last run never reads "Last run: done"');
    }

    // the routine's own COMMS session (frontend/app/autosessions.js): its failure marker for the LIVE cron.result, and for the run-history row
    // the boot backfill and the busy reconcile read after a reload (a row keeps no error field: `run.error || run.reason` wrote "— done")
    {
      const saved = { Workstreams: global.Workstreams, Channels: global.Channels, App: global.App, fetch: global.fetch };
      const sessions = new Map(); let busy = [];
      global.Workstreams = { get: id => sessions.get(id) || null, adopt: row => { if (!sessions.has(row.id)) sessions.set(row.id, Object.assign({ history: [] }, row)); return sessions.get(row.id); },
        appendRun: () => {}, noteRunEnd: () => {}, activeId: () => '' };
      global.Channels = { begin: id => { busy.push(id); }, end: id => { busy = busy.filter(x => x !== id); }, isBusy: id => busy.indexOf(id) >= 0, busyIds: () => busy.slice(), setStatus: () => {} };
      global.App = { persist: () => {}, refreshRail: () => {} };
      const rowOf = (runId, o) => Object.assign({ runId, streamId: 'cron-' + runId, agentId: 'agent', title: 'digest', ts: 5 }, o);
      const BOOT = [rowOf('bootcut', CUT_ROW), rowOf('bootraised', RAISED_ROW)];
      const BUSY = [rowOf('busycut', CUT_ROW)];
      global.fetch = async url => {
        if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: [] }) };
        if (url.indexOf('/api/runs?') === 0) { const m = /runId=([^&]+)/.exec(url); return { ok: true, json: async () => ({ runs: m ? BUSY.filter(r => r.runId === decodeURIComponent(m[1])) : BOOT }) }; }
        if (url.indexOf('/api/transcript?') === 0) return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'half an answ' }] }) };
        throw new Error('unexpected request: ' + url);
      };
      let AutoSessions = null;
      try {
        AutoSessions = require('../frontend/app/autosessions.js').AutoSessions;
        const I = AutoSessions._internals;
        const marker = id => ((sessions.get(id) || {}).history || []).filter(m => m && m.sys).map(m => m.content).join(' | ');
        await I.completeSession('livecut', fired.cut.result.outcome, fired.cut.result.reason);   // onResult(cron.result), as the driver emits it
        await I.backfill({ sleep: () => Promise.resolve() });
        sessions.set('cron-busycut', { id: 'cron-busycut', agentId: 'agent', history: [{ role: 'user', content: 'do it' }] }); busy = ['cron-busycut'];
        if (typeof I.reconcileBusy === 'function') await I.reconcileBusy();
        const said = { live: marker('cron-livecut'), boot: marker('cron-bootcut'), raised: marker('cron-bootraised'), busy: marker('cron-busycut') };
        const CUT_MARK = '⚠ Routine did not finish — the reply was cut short';   // review r8: a cut fire did not finish — never "Routine failed"
        A.ok(said.live === CUT_MARK && said.boot === CUT_MARK && said.raised === '⚠ Routine failed — error' && said.busy === CUT_MARK,
          'the routine\'s session: a cut or raised fire\'s marker never reads "Routine failed — done", live, after the boot backfill or after the busy reconcile (got ' + JSON.stringify(said) + ')');
      } finally {
        if (AutoSessions && AutoSessions.reset) AutoSessions.reset();   // stops the bounded reconcile poll a fire armed
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
      }
    }

    // team.resume (orchestration.js resumeRunnerFor) — the third settle site of a background worker: a resumed generation the provider cut
    // settled error / 'done' (the DELEGATED card's "failed · done"), and its durable delivery was finalized 'done', so team.subagents
    // { runId } answered "recorded: researcher done"
    {
      const rootR = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-family-51-'));
      try {
        let next = { reason: 'error', messages: say('boom'), usd: 0 };   // the first generation fails, so it can be resumed
        const finals = [];
        const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(rootR, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
        const tools = makeOrchestrationTools({ runOnce: async () => next, roster: () => roster, key: 'k', model: 'lead', selfSystem: 'S', newId: counter(), subagents,
          finalizeDispatchDelivery: async (runId, env) => { finals.push(env); } });
        const tool = name => Object.values(tools).find(t => t && t.name === name);
        let id = '';
        try { id = (JSON.parse((await tools.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }], background: true }, { agentId: 'lead', emit: () => {} })).content)[0] || {}).id || ''; } catch (_) { id = ''; }
        for (let i = 0; i < 60 && !((subagents.get(id) || {}).completedAt); i++) await new Promise(r => setImmediate(r));
        const first = subagents.get(id) || {};
        next = { reason: 'done', finishReason: 'length', messages: say('half an answ'), usd: 0 };   // the RESUMED run is cut by the provider
        await tool('team.resume').run({ id }, { agentId: 'lead', emit: () => {}, runId: 'lead-run' });
        for (let i = 0; i < 60; i++) { const c = subagents.get(id) || {}; if (c.completedAt && c.generation > first.generation) break; await new Promise(r => setImmediate(r)); }
        const again = subagents.get(id) || {};
        A.ok(again.generation > first.generation && again.status === 'error' && again.reason === 'cut_short', 'team.resume: a resumed worker the provider cut settles error / cut_short, never reason "done" (got ' + JSON.stringify({ generation: again.generation, status: again.status, reason: again.reason }) + ')');
        const env = finals[finals.length - 1] || {};
        A.eq(env.reason, 'cut_short', 'team.resume: the resumed worker\'s durable delivery is finalized cut_short, never "done"');
        const row = { runId: 'w-run-2', agentId: 'researcher', delegatedBy: 'lead', parentRunId: 'lead-run', reason: 'done', outcome: 'cut_short', dispatchDelivery: Object.assign({}, env) };
        const lookup = makeOrchestrationTools({ runOnce: async () => null, roster: () => new Map(), key: 'k', model: 'm', newId: () => 'x', runRecord: rid => (rid === row.runId ? row : null), subagents: { list: () => [] } });
        const verify = async r => { row.dispatchDelivery = r; const t = Object.values(lookup).find(x => x && x.name === 'team.subagents'); return (await t.run({ runId: 'w-run-2' }, { agentId: 'lead', runId: 'lead-run' })).summary; };
        const said = [await verify(Object.assign({}, env)), await verify({ state: 'final', reason: 'done', repairRunId: '' })];   // the resume's envelope; one finalized before 5.1
        A.ok(said.every(s => s === 'recorded: researcher cut_short'), 'team.subagents { runId }: a resumed worker the provider cut is never "recorded: researcher done" (got ' + JSON.stringify(said) + ')');
      } finally { fs.rmSync(rootR, { recursive: true, force: true }); }
    }

    // ---- review 5.2 (it reuses the real fires above) ----
    // a HELD fire's COMMS session after a reload and after a busy reconcile. The live cron.result says failed / blocked, but the fire's ENTRY
    // run ended clean, so its run-history row reads 'succeeded' (a hold is a work line's outcome, never one run's: RunOutcome.ofLine): the
    // backfill and the reconcile settled the session from that row, so it flipped back to a success. The fire's outcome is its routine's record.
    {
      const saved = { Workstreams: global.Workstreams, Channels: global.Channels, App: global.App, fetch: global.fetch };
      const WS = require('../frontend/app/workstreams.js');
      WS.reset();
      let busy = [];
      global.Workstreams = WS;
      global.Channels = { begin: id => { busy.push(id); }, end: id => { busy = busy.filter(x => x !== id); }, isBusy: id => busy.indexOf(id) >= 0, busyIds: () => busy.slice(), setStatus: () => {} };
      global.App = { persist: () => {}, refreshRail: () => {} };
      // each routine's record as the real driver settled it above (lastStatus / lastReason / lastOutcome), named after one fire here
      const recordOf = (id, kind, lastRunId, extra) => Object.assign({}, fired[kind].job, { id, name: 'digest', agentId: 'agent', prompt: 'do it', lastRunId }, extra || {});
      let JOBS = [recordOf('jlive', 'held', 'heldlive'), recordOf('jold', 'ok', 'newer'), recordOf('jaway', 'held', 'heldaway'), recordOf('jok', 'ok', 'okaway'),
        recordOf('jbusy', 'ok', 'prev', { inFlight: true })];   // jbusy: its held fire is still running its line (the entry run's row has landed)
      // the entry run's row, as the runstore keeps it: the run itself succeeded
      const entryRow = (runId, job) => ({ runId, streamId: 'cron-' + runId, agentId: 'agent', cronJobId: job, title: 'do it', reason: 'done', outcome: 'succeeded', turns: 1, usd: 0, ts: 5 });
      const BOOT = [entryRow('heldlive', 'jlive'), entryRow('heldold', 'jold'), entryRow('heldaway', 'jaway'), entryRow('okaway', 'jok')];
      const ALL = BOOT.concat([entryRow('heldbusy', 'jbusy')]);
      global.fetch = async url => {
        if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: JOBS }) };
        if (url.indexOf('/api/runs?') === 0) { const m = /runId=([^&]+)/.exec(url); return { ok: true, json: async () => ({ runs: m ? ALL.filter(r => r.runId === decodeURIComponent(m[1])) : BOOT }) }; }
        if (url.indexOf('/api/transcript?') === 0) return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'All done.' }] }) };
        throw new Error('unexpected request: ' + url);
      };
      let AutoSessions = null;
      try {
        AutoSessions = require('../frontend/app/autosessions.js').AutoSessions;
        const I = AutoSessions._internals;
        const view = runId => { const w = WS.get('cron-' + runId) || {}; return { ok: w.lastRunOk, marker: (w.history || []).filter(m => m && m.sys).map(m => m.content).join(' | '), busy: busy.indexOf('cron-' + runId) >= 0 }; };
        // live, the page open: the fire's own cron.result (the real driver's, above)
        await I.completeSession('heldlive', fired.held.result.outcome, fired.held.result.reason);
        await I.completeSession('heldold', fired.held.result.outcome, fired.held.result.reason);   // its routine has fired again since (jold: 'newer')
        const live = view('heldlive');
        await I.backfill({ sleep: () => Promise.resolve() });   // the reload; heldaway / okaway fired while the page was closed
        I.beginSession('heldbusy', { id: 'jbusy', name: 'digest', agentId: 'agent', prompt: 'do it' });   // cron.fire; its cron.result is then lost
        await I.reconcileBusy();
        const inFlight = view('heldbusy');
        JOBS = JOBS.map(j => (j.id === 'jbusy' ? recordOf('jbusy', 'held', 'heldbusy') : j));   // the line's reviewer held it: the fire settles
        await I.reconcileBusy();
        const got = { live, reload: view('heldlive'), older: view('heldold'), away: view('heldaway'), inFlight, reconciled: view('heldbusy'), clean: view('okaway') };
        const HELD_MARK = '⚠ Routine did not finish — held: the work was not accepted';   // review r8: a held fire is no failure — and never a success
        A.ok(live.ok == null && live.marker === HELD_MARK, 'fixture: a held fire\'s live cron.result fails its session (got ' + JSON.stringify(live) + ')');
        A.ok(got.reload.ok == null && got.older.ok == null && got.reload.marker === HELD_MARK && got.older.marker === HELD_MARK,
          'a held fire\'s session stays failed after a reload: its routine\'s record holds the fire\'s outcome, and an entry run\'s row (an older fire\'s) never clears it (got ' + JSON.stringify({ reload: got.reload, older: got.older }) + ')');
        A.ok(got.away.ok == null && got.away.marker === HELD_MARK, 'a held fire that ran while the page was closed reads "' + HELD_MARK + '" after the backfill, never a success (got ' + JSON.stringify(got.away) + ')');
        A.ok(inFlight.busy === true && inFlight.ok == null && !inFlight.marker, 'the busy reconcile leaves a fire whose routine is still in flight busy: its entry run\'s row is no settlement (got ' + JSON.stringify(inFlight) + ')');
        A.ok(got.reconciled.ok == null && got.reconciled.marker === HELD_MARK && !got.reconciled.busy, 'the busy reconcile settles a held fire by its record: "' + HELD_MARK + '", never a success (got ' + JSON.stringify(got.reconciled) + ')');
        A.ok(got.clean.ok === true && !got.clean.marker, 'a clean fire that ran while the page was closed settles ok, with no failure marker (got ' + JSON.stringify(got.clean) + ')');
      } finally {
        if (AutoSessions && AutoSessions.reset) AutoSessions.reset();   // stops the bounded reconcile poll the fire armed
        WS.reset();
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
      }
    }

    // the crew's hand-off (orchestration.js earlierHandoff): a later worker in a SEQUENTIAL team.dispatch opens with what the earlier ones
    // returned, under "their finished output is your input". Its UNFINISHED mark read the bare reason, so a worker the provider cut (reason
    // 'done', its row's outcome cut_short) was handed on as finished work; a timeout's said so.
    {
      const crew = new Map([['researcher', { system: 'R', name: 'RESEARCHER', model: 'm' }], ['writer', { system: 'W', name: 'WRITER', model: 'm' }]]);
      const opening = async first => {
        const asks = [];
        const { dispatchTool } = makeOrchestrationTools({ runOnce: async o => { asks.push(o); return asks.length === 1 ? Object.assign({ messages: say('half an answ'), usd: 0 }, first) : { reason: 'done', messages: say('the email'), usd: 0 }; },
          roster: () => crew, key: 'k', model: 'lead', newId: counter() });
        await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }, { agentId: 'writer', prompt: 'write Y' }] }, { agentId: 'agent', signal: { aborted: false }, emit: () => {} });
        const text = ((asks[1] && asks[1].messages) || []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
        const m = /— RESEARCHER[^\n]*:\n/.exec(text);
        return m ? m[0].trim() : '(no hand-off)';
      };
      const said = { cut: await opening({ reason: 'done', finishReason: 'length' }), clean: await opening({ reason: 'done' }) };
      A.ok(said.cut === '— RESEARCHER (UNFINISHED — the reply was cut short):' && said.clean === '— RESEARCHER:',
        'team.dispatch: a later worker is handed a cut worker\'s partial answer marked UNFINISHED (the reply was cut short), never as finished output; a succeeded worker\'s is unmarked (got ' + JSON.stringify(said) + ')');
    }

    // ---- review 5.3 (it reuses the real fires above, and the real cron-store reducers) ----
    // The 5.2 settle read a fire's outcome from its routine's lastStatus. A config block (markBlockedConfig: a missing model or credential,
    // a delivery channel not connected at tick time) and an unfireable mark (markUnfireable) run no fire, yet write lastStatus 'error' beside
    // the PREVIOUS fire's lastRunId — so a clean fire's session failed on the next reload ("⚠ Routine failed — blocked_config" when the page
    // was closed) and stayed failed after the routine's next good fire. A stopped fire read "⚠ Routine failed — cancelled" after a reload. An
    // older fire settled from its row gave no verdict for a step-limit / budget / refused / empty row. A reload while a fire's work line still
    // ran settled it ok from its entry row and cleared busy; the busy reconcile's bounded poll expired under a long line; and a session a row
    // had settled ok kept a red lamp over a clean-looking transcript once its fire's record said it was held.
    {
      const saved = { Workstreams: global.Workstreams, Channels: global.Channels, App: global.App, fetch: global.fetch, setInterval: global.setInterval, clearInterval: global.clearInterval };
      const WS = require('../frontend/app/workstreams.js');
      WS.reset();
      let busy = [], tick = null;
      global.Workstreams = WS;
      global.Channels = { begin: id => { busy.push(id); }, end: id => { busy = busy.filter(x => x !== id); }, isBusy: id => busy.indexOf(id) >= 0, busyIds: () => busy.slice(), setStatus: () => {} };
      global.App = { persist: () => {}, refreshRail: () => {} };
      global.setInterval = fn => { tick = fn; return 1; };   // the bounded reconcile poll, driven by hand below
      global.clearInterval = () => { tick = null; };
      const T = 1700000300000;
      const rec = (id, lastRunId, extra) => Object.assign({}, fired.ok.job, { id, name: 'digest', agentId: 'agent', prompt: 'do it', lastRunId }, extra || {});
      const after = (job, reduce) => cronStore.getJob(reduce([job]), job.id);
      const blockedAfter = (id, runId) => after(rec(id, runId), jobs => cronStore.markBlockedConfig(jobs, id, { fingerprint: 'no-model', reason: 'no model is configured', alerted: true }, { now: T }));
      const unfireableAfter = (id, runId) => after(rec(id, runId), jobs => cronStore.markUnfireable(jobs, id, { now: T }));
      // a fire someone STOPPED, settled as finishFire settles it (fireOutcome: outcome 'stopped'; the reason RunOutcome.reasonOf hands on)
      const stoppedAt = (id, runId) => after(rec(id, 'earlier'), jobs => cronStore.markRun(jobs, id, { runId, status: 'error', reason: 'cancelled', outcome: 'stopped', error: 'stopped before it finished', transient: false }, { now: T }));
      const row = (runId, job, o) => Object.assign({ runId, streamId: 'cron-' + runId, agentId: 'agent', cronJobId: job, title: 'do it', reason: 'done', outcome: 'succeeded', turns: 1, usd: 0, ts: 5 }, o || {});
      let JOBS = [rec('jblock', 'okblock'), rec('junfire', 'okunfire')];
      const BOOT = [row('okblock', 'jblock'), row('okunfire', 'junfire'), row('okblockaway', 'jblockaway'), row('okunfireaway', 'junfireaway'),
        row('stopaway', 'jstop', { reason: 'cancelled', outcome: 'stopped' }),
        row('oldlimit', 'jold3', { reason: 'max_iters', outcome: 'step_limit' }), row('oldbudget', 'jold3', { reason: 'budget', outcome: 'out_of_budget' }),
        row('oldrefused', 'jold3', { reason: 'refusal', outcome: 'refused', failureCode: 'model_refusal' }), row('oldempty', 'jold3', { reason: 'empty', outcome: 'empty' }),
        row('oldstop', 'jold3', { reason: 'cancelled', outcome: 'stopped' }),
        row('fly', 'jfly'), row('flyaway', 'jfly2'), row('flyold', 'jfly'), row('heldok', 'jheldok')];
      const ALL = BOOT.concat([row('okblockbusy', 'jblockbusy'), row('stopbusy', 'jstopbusy', { reason: 'cancelled', outcome: 'stopped' }), row('pollfly', 'jpoll')]);
      global.fetch = async url => {
        if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: JOBS }) };
        if (url.indexOf('/api/runs?') === 0) { const m = /runId=([^&]+)/.exec(url); return { ok: true, json: async () => ({ runs: m ? ALL.filter(r => r.runId === decodeURIComponent(m[1])) : BOOT }) }; }
        if (url.indexOf('/api/transcript?') === 0) return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'All done.' }] }) };
        throw new Error('unexpected request: ' + url);
      };
      const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
      let AutoSessions = null;
      try {
        AutoSessions = require('../frontend/app/autosessions.js').AutoSessions;
        AutoSessions.reset();
        const I = AutoSessions._internals;
        const view = runId => { const w = WS.get('cron-' + runId) || {}; return { ok: w.lastRunOk, marker: (w.history || []).filter(m => m && m.sys).map(m => m.content).join(' | '), busy: busy.indexOf('cron-' + runId) >= 0, exists: !!WS.get('cron-' + runId) }; };
        const job = id => ({ id, name: 'digest', agentId: 'agent', prompt: 'do it' });
        // the page open: two clean fires settle live (their cron.result), and three fires go busy (cron.fire), their results then lost
        await I.completeSession('okblock', fired.ok.result.outcome, fired.ok.result.reason);
        await I.completeSession('okunfire', fired.ok.result.outcome, fired.ok.result.reason);
        I.beginSession('okblockbusy', job('jblockbusy')); I.beginSession('stopbusy', job('jstopbusy')); I.beginSession('fly', job('jfly'));
        // a fire a row settled ok on an earlier page load, before its line's reviewer held it (the record now says blocked)
        const pre = WS.adopt({ id: 'cron-heldok', title: 'digest', agentId: 'agent', lane: 'active', history: [] });
        I.foldTurns(pre, [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'All done.' }], 'ok', 'done', true, 4);
        const preOk = view('heldok').ok;
        // then: each clean fire's routine is config-blocked or marked unfireable; one routine's fire is stopped; jold3 fired again since its
        // older rows; jfly's fire 'fly' (and jfly2's 'flyaway') still runs its work line, its entry run's row landed; jpoll's fire is in flight
        JOBS = [blockedAfter('jblock', 'okblock'), unfireableAfter('junfire', 'okunfire'), blockedAfter('jblockaway', 'okblockaway'), unfireableAfter('junfireaway', 'okunfireaway'),
          blockedAfter('jblockbusy', 'okblockbusy'), stoppedAt('jstop', 'stopaway'), stoppedAt('jstopbusy', 'stopbusy'), rec('jold3', 'newer3', { lastOutcome: 'succeeded' }),
          rec('jfly', 'prevfly', { inFlight: true, inFlightRunId: 'fly' }), rec('jfly2', 'prevfly2', { inFlight: true, inFlightRunId: 'flyaway' }),
          rec('jpoll', 'prevpoll', { inFlight: true, inFlightRunId: 'pollfly' }), Object.assign({}, fired.held.job, { id: 'jheldok', name: 'digest', agentId: 'agent', prompt: 'do it', lastRunId: 'heldok' })];
        const fixture = JOBS.filter(j => /^j(block|unfire)/.test(j.id)).every(j => j.lastStatus === 'error' && j.lastOutcome == null) && JOBS.find(j => j.id === 'jstop').lastOutcome === 'stopped';
        A.ok(fixture && preOk === true, 'fixture: the real reducers write lastStatus \'error\' with no outcome for a block / an unfireable mark, and \'stopped\' for a stopped fire; the pre-settled session reads ok');
        await I.backfill({ sleep: () => Promise.resolve() });   // the reload
        await I.reconcileBusy();
        const got = { block: view('okblock'), unfire: view('okunfire'), blockAway: view('okblockaway'), unfireAway: view('okunfireaway'), blockBusy: view('okblockbusy') };
        A.ok(Object.keys(got).every(k => got[k].ok === true && !got[k].marker && !got[k].busy),
          'a clean fire\'s session stays ok after its routine is config-blocked or marked unfireable — after a reload, a closed-page backfill and a busy reconcile (neither runs a fire; the record\'s lastStatus is no fire\'s outcome) (got ' + JSON.stringify(got) + ')');
        const stop = { away: view('stopaway'), busy: view('stopbusy') };
        A.ok(stop.away.ok == null && stop.busy.ok == null && !stop.away.marker && !stop.busy.marker && !stop.busy.busy,
          'a stopped fire is no verdict after a closed-page backfill and a busy reconcile, never "⚠ Routine failed — cancelled" (got ' + JSON.stringify(stop) + ')');
        const older = { limit: view('oldlimit'), budget: view('oldbudget'), refused: view('oldrefused'), empty: view('oldempty'), stopped: view('oldstop') };
        A.ok(older.limit.ok == null && older.limit.marker === '⚠ Routine did not finish — reached the step limit' && older.budget.ok == null && older.budget.marker === '⚠ Routine did not finish — hit a spending limit'
          && older.refused.ok == null && older.refused.marker === '⚠ Routine did not finish — the model declined the request' && older.empty.ok == null && older.empty.marker === '⚠ Routine did not finish — the model sent back an empty reply'
          && older.stopped.ok == null && !older.stopped.marker,
          'an older fire settled from its row (its routine fired again since): a step-limit, budget, refused or empty row fails its session with why, a stop is no verdict (got ' + JSON.stringify(older) + ')');
        const fly = { open: view('fly'), away: view('flyaway'), olderFire: view('flyold') };
        A.ok(fly.open.busy && fly.open.ok == null && !fly.open.marker && fly.away.exists && fly.away.busy && fly.away.ok == null && !fly.away.marker && fly.olderFire.ok === true && !fly.olderFire.busy,
          'a reload while a fire\'s work line still runs leaves its session busy (or forms it busy, the page closed) — its entry run\'s row is no settlement — while an older fire of that routine still settles (got ' + JSON.stringify(fly) + ')');
        const held = view('heldok');
        A.ok(held.ok == null && held.marker === '⚠ Routine did not finish — held: the work was not accepted', 'a session a row had settled ok says "⚠ Routine failed — blocked" once its fire\'s record holds it, never a red lamp over a clean-looking transcript (got ' + JSON.stringify(held) + ')');
        // the routine fires again, cleanly: the session the block failed stays ok (a row never clears a settled failure — so it must never be failed)
        JOBS = JOBS.map(j => (j.id === 'jblock' ? rec('jblock', 'nextblock', { lastOutcome: 'succeeded' }) : j));
        await I.backfill({ sleep: () => Promise.resolve() });
        A.ok(view('okblock').ok === true && !view('okblock').marker, 'a clean fire\'s session is still ok after the block clears and the routine fires again (got ' + JSON.stringify(view('okblock')) + ')');
        // the bounded reconcile poll: a line longer than the poll, its cron.result lost — the station still reports the fire running
        I.beginSession('pollfly', job('jpoll'));
        const armed = typeof tick === 'function';
        for (let i = 0; i < 45 && typeof tick === 'function'; i++) { tick(); await flush(); }
        const longLine = { armed, stillPolling: typeof tick === 'function', busy: view('pollfly').busy };
        JOBS = JOBS.map(j => (j.id === 'jpoll' ? rec('jpoll', 'pollfly', { lastOutcome: 'succeeded' }) : j));   // the line delivers; the fire settles
        if (typeof tick === 'function') { tick(); await flush(); }
        const settled = view('pollfly');
        A.ok(longLine.armed && longLine.stillPolling && longLine.busy && settled.ok === true && !settled.busy,
          'the busy reconcile keeps its bounded poll alive while the station reports the fire running (past its 40 ticks), and settles the fire once its record does (got ' + JSON.stringify({ longLine, settled }) + ')');
      } finally {
        if (AutoSessions && AutoSessions.reset) AutoSessions.reset();
        WS.reset();
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
      }
    }
    // ---- review 6.1 (the real cron-store reducers over the real driver's HELD record) ----
    // 5.3 settled a fire by its record only while the record's lastOutcome kept the fire's outcome. A config block (markBlockedConfig)
    // and an unfireable mark (markUnfireable) clear lastOutcome beside the PREVIOUS fire's lastRunId, so a HELD fire — its entry run's
    // row reads 'succeeded' (a hold is its line's, RunOutcome.ofLine) — fell back to that row and read ok once its routine was blocked:
    // after a closed-page backfill and a busy reconcile alike (5.2 and 5.3 drove a block only after a CLEAN fire). The fire's receipt
    // (cron-store lastFire: markRun / markInterrupted) stays bound to its runId; the away briefing and RUN HISTORY read it too (the table).
    {
      const saved = { Workstreams: global.Workstreams, Channels: global.Channels, App: global.App, fetch: global.fetch };
      const WS = require('../frontend/app/workstreams.js');
      WS.reset();
      let busy = [];
      global.Workstreams = WS;
      global.Channels = { begin: id => { busy.push(id); }, end: id => { busy = busy.filter(x => x !== id); }, isBusy: id => busy.indexOf(id) >= 0, busyIds: () => busy.slice(), setStatus: () => {} };
      global.App = { persist: () => {}, refreshRail: () => {} };
      const T = 1700000400000;
      const heldAs = fired.held.job;   // the real driver's settlement of a held fire (lastReason / lastOutcome 'blocked')
      const base = id => Object.assign({}, heldAs, { id, name: 'digest', agentId: 'agent', prompt: 'do it', lastRunAt: null });
      // a held fire settled as finishFire settles it (markRun with the held record's own reason / outcome / error), under its own runId
      const settleHeld = (id, runId) => cronStore.markRun([base(id)], id, { runId, status: 'error', reason: heldAs.lastReason, outcome: heldAs.lastOutcome,
        failureCode: heldAs.lastFailureCode || undefined, error: heldAs.lastError || undefined, transient: false }, { now: T });
      const MARK = { block: jobs => cronStore.markBlockedConfig(jobs, jobs[0].id, { fingerprint: 'no-model', reason: 'no model is configured', alerted: true }, { now: T + 1 }),
        unfire: jobs => cronStore.markUnfireable(jobs, jobs[0].id, { now: T + 1 }) };
      const heldThen = (id, runId, how) => cronStore.getJob(MARK[how](settleHeld(id, runId)), id);
      // a fire whose process died mid-line (markInterrupted names it), then its routine is config-blocked
      const interruptedThen = (id, runId) => cronStore.getJob(MARK.block(cronStore.markInterrupted([base(id)], id, { runId, startedAt: T })), id);
      const row = (runId, job) => ({ runId, streamId: 'cron-' + runId, agentId: 'agent', cronJobId: job, title: 'do it', reason: 'done', outcome: 'succeeded', turns: 1, usd: 0, ts: 5 });
      let JOBS = [cronStore.getJob(settleHeld('jbusyheld', 'prevheld'), 'jbusyheld')];
      const BOOT = [row('awayblock', 'jawayblock'), row('awayunfire', 'jawayunfire'), row('awayint', 'jawayint')];
      const ALL = BOOT.concat([row('busyheld', 'jbusyheld')]);
      global.fetch = async url => {
        if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: JOBS }) };
        if (url.indexOf('/api/runs?') === 0) { const m = /runId=([^&]+)/.exec(url); return { ok: true, json: async () => ({ runs: m ? ALL.filter(r => r.runId === decodeURIComponent(m[1])) : BOOT }) }; }
        if (url.indexOf('/api/transcript?') === 0) return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'All done.' }] }) };
        throw new Error('unexpected request: ' + url);
      };
      let AutoSessions = null;
      try {
        AutoSessions = require('../frontend/app/autosessions.js').AutoSessions;
        AutoSessions.reset();
        const I = AutoSessions._internals;
        const view = runId => { const w = WS.get('cron-' + runId) || {}; return { ok: w.lastRunOk, marker: (w.history || []).filter(m => m && m.sys).map(m => m.content).join(' | '), busy: busy.indexOf('cron-' + runId) >= 0 }; };
        // the page open: the held fire goes busy (cron.fire), its cron.result is then lost to an SSE drop
        I.beginSession('busyheld', { id: 'jbusyheld', name: 'digest', agentId: 'agent', prompt: 'do it' });
        // then each routine's held (or interrupted) fire is followed by a config block or an unfireable mark — no fire runs; the page is closed
        JOBS = [heldThen('jbusyheld', 'busyheld', 'block'), heldThen('jawayblock', 'awayblock', 'block'), heldThen('jawayunfire', 'awayunfire', 'unfire'), interruptedThen('jawayint', 'awayint')];
        const fixture = JOBS.every(j => j && j.lastStatus === 'error' && j.lastOutcome == null && /^(busyheld|awayblock|awayunfire|awayint)$/.test(j.lastRunId))
          && JOBS[0].lastReason === 'blocked_config' && JOBS[2].lastReason === cronStore.UNFIREABLE_ERROR && heldAs.lastOutcome === 'blocked';
        A.ok(fixture, 'fixture: after a held (or interrupted) fire, the real block / unfireable reducers clear lastOutcome beside that fire\'s lastRunId (got ' + JSON.stringify(JOBS.map(j => j && ({ id: j.id, lastRunId: j.lastRunId, lastOutcome: j.lastOutcome, lastReason: j.lastReason }))) + ')');
        await I.backfill({ sleep: () => Promise.resolve() });   // the reload: the closed page's fires form from their rows
        await I.reconcileBusy();                                // the busy session's lost cron.result
        const HELD_MARK = '⚠ Routine did not finish — held: the work was not accepted';   // review r8: a held fire is no failure — and never a success
        const got = { awayBlock: view('awayblock'), awayUnfire: view('awayunfire'), busyBlock: view('busyheld'), awayInterrupted: view('awayint') };
        A.ok(['awayBlock', 'awayUnfire', 'busyBlock'].every(k => got[k].ok == null && got[k].marker === HELD_MARK && !got[k].busy),
          'a held fire stays "' + HELD_MARK + '" after its routine is config-blocked or marked unfireable — after a closed-page backfill and a busy reconcile (its entry run\'s row reads \'succeeded\'; the fire\'s receipt keeps the hold) (got ' + JSON.stringify(got) + ')');
        A.ok(got.awayInterrupted.ok == null && got.awayInterrupted.marker === '⚠ Routine did not finish — interrupted when StarNet stopped',
          'an interrupted fire stays "⚠ Routine failed — interrupted" after its routine is config-blocked, never ok from its row (got ' + JSON.stringify(got.awayInterrupted) + ')');
      } finally {
        if (AutoSessions && AutoSessions.reset) AutoSessions.reset();
        WS.reset();
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
      }
    }
    // ---- review 6.2 (the real driver's stopped and held fires, the real cron-store reducers, the page's own cron.result handler) ----
    // A STOPPED FIRE, LIVE. cron-driver finishFire reports every fire that did not succeed as 'failed' — a stop someone made (Stop, pausing
    // the routine mid-run, E-STOP) included — and the page handed that coarse word straight to the session (onResult -> completeSession):
    // "⚠ Routine failed — cancelled" and a failed run end, which a reload kept (the saved session has readable output, so the backfill only
    // re-records the verdict, and no verdict leaves false), while a closed-page backfill of the same fire read it as no verdict. The HUD toast
    // said "✕ routine failed — cancelled". A live cron.result now settles by the fire's receipt, the rule a reload reads.
    // A HELD FIRE, THEN A CLEAN ONE — the routine's normal next event. The record's receipt kept only its LAST fire, so the held fire fell back
    // to its entry run's 'succeeded' row: a closed-page backfill and a busy reconcile read it ok (RUN HISTORY and the away briefing read it
    // as "✓ ok" and "ran": the invariant table). The record keeps the receipt of each recent fire that did not succeed (cron-store fireReceipts).
    {
      FIRES.stopped = [{ reason: 'cancelled', outcome: 'stopped' }, null, null, 'cancelled'];
      const stopped = await fire('stopped');
      const saved = { Workstreams: global.Workstreams, Channels: global.Channels, App: global.App, fetch: global.fetch };
      const WS = require('../frontend/app/workstreams.js');
      WS.reset();
      let busy = [];
      global.Workstreams = WS;
      global.Channels = { begin: id => { busy.push(id); }, end: id => { busy = busy.filter(x => x !== id); }, isBusy: id => busy.indexOf(id) >= 0, busyIds: () => busy.slice(), setStatus: () => {} };
      global.App = { persist: () => {}, refreshRail: () => {} };
      const T = 1700000500000;
      const named = j => Object.assign({}, j, { name: 'digest', agentId: 'agent', prompt: 'do it' });
      const row = (runId, o) => Object.assign({ runId, streamId: 'cron-' + runId, agentId: 'agent', cronJobId: 'j1', title: 'do it', reason: 'done', outcome: 'succeeded', turns: 1, usd: 0, ts: 5 }, o || {});
      let JOBS = [], BOOT = [];
      global.fetch = async url => {
        if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: JOBS }) };
        if (url.indexOf('/api/runs?') === 0) { const m = /runId=([^&]+)/.exec(url); return { ok: true, json: async () => ({ runs: m ? BOOT.filter(r => r.runId === decodeURIComponent(m[1])) : BOOT }) }; }
        if (url.indexOf('/api/transcript?') === 0) return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'half an answer' }] }) };
        throw new Error('unexpected request: ' + url);
      };
      let AutoSessions = null;
      try {
        AutoSessions = require('../frontend/app/autosessions.js').AutoSessions;
        AutoSessions.reset();
        const I = AutoSessions._internals;
        const view = runId => { const w = WS.get('cron-' + runId) || {}; return { ok: w.lastRunOk, marker: (w.history || []).filter(m => m && m.sys).map(m => m.content).join(' | '), busy: busy.indexOf('cron-' + runId) >= 0 }; };
        const job = { id: 'j1', name: 'digest', agentId: 'agent', prompt: 'do it' };
        const live = async (f, runId) => { I.beginSession(runId, job); await (I.onResult ? I.onResult(f.result) : I.completeSession(runId, f.result.outcome, f.result.reason)); return view(runId); };   // cron.fire, then its cron.result
        const stopId = String(stopped.result.runId), heldId = String(fired.held.result.runId);
        // (review r7: the real driver reports it 'stopped' now — it said 'failed' — beside runOutcome 'stopped'; the receipt path below still holds
        // for an older station's coarse 'failed')
        A.ok(stopped.result.outcome === 'stopped' && stopped.result.runOutcome === 'stopped' && stopped.result.reason === 'cancelled' && stopped.job.lastOutcome === 'stopped' && stopped.job.lastRunId === stopId,
          'fixture: the real driver reports a stopped fire\'s cron.result as stopped / cancelled and records it stopped (got ' + JSON.stringify({ result: stopped.result, lastOutcome: stopped.job.lastOutcome }) + ')');
        JOBS = [named(stopped.job)]; BOOT = [row(stopId, { reason: 'cancelled', outcome: 'stopped' })];
        const stopLive = await live(stopped, stopId);
        await I.backfill({ sleep: () => Promise.resolve() });   // a reload: the page saved the session
        const stopReload = view(stopId);
        A.ok(stopLive.ok == null && !stopLive.marker && !stopLive.busy && stopReload.ok == null && !stopReload.marker,
          'a stopped fire\'s live cron.result is no verdict, and stays none after a reload — never "⚠ Routine failed — cancelled" (got ' + JSON.stringify({ live: stopLive, reload: stopReload }) + ')');
        // the same receipt keeps a held fire's live session failed (its cron.result says failed / blocked; its record, blocked)
        WS.reset(); busy = [];
        JOBS = [named(fired.held.job)]; BOOT = [row(heldId)];
        const heldLive = await live(fired.held, heldId);
        A.ok(heldLive.ok == null && heldLive.marker === '⚠ Routine did not finish — held: the work was not accepted' && !heldLive.busy, 'a held fire\'s live cron.result still fails its session by its receipt (got ' + JSON.stringify(heldLive) + ')');
        // the HUD's toast for the same cron.result (world.js's cron.result listener, sliced whole)
        const at = worldSrc.indexOf("U.bus.on('cron.result', p => {");
        const listenerSrc = at < 0 ? '' : worldSrc.slice(at, worldSrc.indexOf('\n    });', at) + '\n    });'.length);
        let onCron = null;
        const toasts = [];
        if (listenerSrc) new Function('U', 'hudNote', 'RunOutcome', listenerSrc)({ bus: { on: (n, fn) => { if (n === 'cron.result') onCron = fn; } } }, (txt, cls) => toasts.push(txt + '|' + (cls || '')), RunOutcome);
        const toastOf = p => { toasts.length = 0; if (onCron) onCron(p); return toasts.join(' ; ') || '(none)'; };
        const said = { stopped: toastOf(stopped.result), held: toastOf(fired.held.result), ok: toastOf(fired.ok.result) };
        A.ok(!!onCron && !/failed/.test(said.stopped) && /stopped/.test(said.stopped) && !/\|warn$/.test(said.stopped) && said.held === '⚠ routine did not finish — held: the work was not accepted|warn' && said.ok === '◷ routine completed|good',
          'the HUD never toasts a stopped fire as "✕ routine failed — cancelled"; a held fire still warns, a clean one completes (got ' + JSON.stringify(said) + ')');
        // the held fire, then its routine's next fire runs clean (markRun as finishFire settles it): the record keeps the held fire's receipt
        WS.reset(); busy = [];
        const thenClean = cronStore.getJob(cronStore.markRun([fired.held.job], 'j1', { runId: 'cleannext', status: 'ok', reason: 'done', outcome: 'succeeded', output: 'All done.', transient: false }, { now: T }), 'j1');
        const receipt = cronStore.fireOf ? cronStore.fireOf(thenClean, heldId) : null;
        A.ok(thenClean.lastRunId === 'cleannext' && !!receipt && receipt.outcome === 'blocked' && receipt.reason === 'blocked' && cronStore.fireOf(thenClean, 'cleannext').outcome === 'succeeded',
          'a held fire\'s receipt outlives its routine\'s next, clean fire (cron-store fireOf) (got ' + JSON.stringify({ lastRunId: thenClean.lastRunId, receipt, ring: thenClean.fireReceipts }) + ')');
        JOBS = [named(thenClean)]; BOOT = [row(heldId), row('cleannext')];
        await I.backfill({ sleep: () => Promise.resolve() });   // the page was closed through both fires
        const closed = { held: view(heldId), clean: view('cleannext') };
        WS.reset(); busy = [];
        I.beginSession(heldId, job);   // the page open: the held fire went busy, its cron.result lost to an SSE drop; the routine has fired again since
        await I.reconcileBusy();
        const reconciled = view(heldId);
        A.ok(closed.held.ok == null && closed.held.marker === '⚠ Routine did not finish — held: the work was not accepted' && closed.clean.ok === true && !closed.clean.marker
          && reconciled.ok == null && reconciled.marker === '⚠ Routine did not finish — held: the work was not accepted' && !reconciled.busy,
          'a held fire stays "⚠ Routine failed — blocked" once its routine fires again cleanly — after a closed-page backfill and a busy reconcile; the clean fire settles ok (got ' + JSON.stringify({ closed, reconciled }) + ')');
        // the ring is bounded (RUN HISTORY's page): the oldest receipts go first, a succeeded fire writes none
        let many = [fired.held.job];
        const MAX = cronStore.MAX_FIRE_RECEIPTS || 0;
        for (let i = 0; i < MAX + 10; i++) many = cronStore.markRun(many, 'j1', { runId: 'f' + i, status: 'error', reason: 'error', outcome: 'failed', failureCode: 'rate_limit', error: 'rate limited', transient: true }, { now: T + i, maxRetries: 1000 });
        many = cronStore.markRun(many, 'j1', { runId: 'okmany', status: 'ok', reason: 'done', outcome: 'succeeded', output: 'ok', transient: false }, { now: T + 999 });
        const ring = (cronStore.getJob(many, 'j1') || {}).fireReceipts || [];
        A.ok(MAX === 50 && ring.length === MAX && ring[0].runId === 'f10' && ring[MAX - 1].runId === 'f' + (MAX + 9) && !ring.some(f => f.runId === 'okmany'),
          'the fire receipts are bounded at RUN HISTORY\'s page (50, oldest first out) and a succeeded fire writes none (got ' + JSON.stringify({ MAX, n: ring.length, first: ring[0] && ring[0].runId, last: ring.length && ring[ring.length - 1].runId }) + ')');
      } finally {
        if (AutoSessions && AutoSessions.reset) AutoSessions.reset();
        WS.reset();
        delete FIRES.stopped;
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
      }
    }
    // GET /api/cron names WHICH fire holds a routine's lease (inFlightRunId, a settlement still waiting to persist included): the page's
    // in-flight hold keys on it, so an older fire of a routine that runs again is never held busy (cronStateSnapshot, sliced from the sidecar)
    // — beside the run-wire lane's resolved wire row (routineWireRow), which every routine keeps, a lease or none
    {
      const src = sidecarTopLevelFunction('schedulerState') + '\n' + sidecarTopLevelFunction('cronStateSnapshot');
      const leases = new Map([['jrun', { runId: 'fx' }], ['jsettling', { runId: 'fy', settlement: { at: 1 } }]]);
      const routineWireRow = j => ({ provider: 'openrouter', model: 'm-' + j.id, source: 'routine' });
      let snap = null;
      try {
        snap = new Function('cronHealth', 'cronArmed', 'cronTimer', 'CRON_TICK_MS', 'cronJobs', 'cronDriver', 'cronHalted', 'cronArmSet', 'cronDegraded', 'CRON_MAX_CONSECUTIVE_FAILURES', 'cronStore', 'routineWireRow', 'SchedulerState',
          src + '\nreturn cronStateSnapshot(1000);')({ lastTickAt: 0, lastSuccessAt: 0, lastTickError: null }, true, 1, 60000, [{ id: 'jrun' }, { id: 'jsettling' }, { id: 'jidle' }], { leases }, false, true, null, 5, { MAX_PENDING_DELIVERIES: 9 }, routineWireRow, require('../sidecar/scheduler-state.js'));
      } catch (e) { snap = { error: String((e && e.message) || e) }; }
      const one = id => ((snap && snap.jobs) || []).find(x => x && x.id === id) || {};
      A.ok(!!src && one('jrun').inFlight === true && one('jrun').inFlightRunId === 'fx' && one('jsettling').inFlight !== true && one('jsettling').inFlightRunId === 'fy' && !one('jidle').inFlight && !one('jidle').inFlightRunId
        && ['jrun', 'jsettling', 'jidle'].every(id => !!one(id).wire && one(id).wire.model === 'm-' + id),
        'GET /api/cron names the fire that holds each routine\'s lease (inFlightRunId), its settlement still persisting included; inFlight keeps its RUN NOW meaning; every routine keeps its wire row (got ' + JSON.stringify(snap && snap.jobs ? snap.jobs : snap) + ')');
    }
  }

  // ================================ review r7: THE STOP FAMILY and THE ERROR-FLAG FAMILY (behavioural) ================================
  // A STOP IS ITS OWN OUTCOME (the family law): a run someone stopped is never reported or counted as a failure, and never as a success. And a
  // run's verdict is never taken from an error flag (a success word chosen by `x.error ? … : 'finished'`, a reply consumed on `!res.error`).
  // Each fold drives the surface's real code (a module, or the statements sliced from the sidecar / page) with a STOPPED run beside a failed
  // and a clean one; the routine record, cron.result, the delivery headline, the auto-pause and a pause mid-run are the invariant table's.
  {
    const { functionSourceIn } = require('./helpers/source.js');
    const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');   // the page's and the terminal's files
    const sidecarRead = rel => (sidecarSourceFiles().find(f => f.rel.replace(/\\/g, '/') === rel) || {}).text || '';   // the sidecar's, through the source helper
    const sliceListener = (src, head, must) => {
      let at = -1;
      for (let i = src.indexOf(head); i >= 0; i = src.indexOf(head, i + 1)) { const end = src.indexOf('\n    });', i); if (!must || src.slice(i, end).indexOf(must) >= 0) { at = i; break; } }
      return at < 0 ? '' : src.slice(at, src.indexOf('\n    });', at) + '\n    });'.length);
    };
    const worldSrc = read('frontend/app/world.js');

    // 1. THE HUD's cron.result toast (world.js, the listener sliced whole): a fire cron.result reports 'stopped' (or an older station's 'failed'
    //    beside a reason the stop's word LEADS — 'cancelled (stale-lease)') is "■ routine stopped", never "✕ routine failed"; a failure that
    //    tripped the auto-pause says the pause as itself (pausedAfter), never inside a reason no reader can resolve
    {
      const src = sliceListener(worldSrc, "U.bus.on('cron.result', p => {");
      let on = null; const said = [];
      if (src) new Function('U', 'hudNote', 'RunOutcome', src)({ bus: { on: (n, fn) => { if (n === 'cron.result') on = fn; } } }, (txt, cls) => said.push(txt + '|' + (cls || '')), RunOutcome);
      const toast = p => { said.length = 0; if (on) on(p); return said.join(' ; ') || '(none)'; };
      const got = {
        stopped: toast({ jobId: 'j', runId: 'r1', outcome: 'stopped', runOutcome: 'stopped', reason: 'cancelled' }),
        staleLease: toast({ jobId: 'j', runId: 'r2', outcome: 'failed', reason: 'cancelled (stale-lease)' }),
        olderPaused: toast({ jobId: 'j', runId: 'r3', outcome: 'failed', reason: 'cancelled (paused: consecutive-failures x5)' }),
        pausedFailure: toast({ jobId: 'j', runId: 'r4', outcome: 'failed', runOutcome: 'failed', failureCode: 'rate_limit', reason: 'error (paused: consecutive-failures x5)', pausedAfter: 5 })
      };
      A.ok(!!on && ['stopped', 'staleLease', 'olderPaused'].every(k => /^■ routine stopped before it finished\|$/.test(got[k]))
        && got.pausedFailure === '✕ routine failed — error — paused after 5 failures in a row|warn',
        'review r7: the HUD reads a stopped fire as a stop — cron.result\'s own \'stopped\', or a reason the stop leads — never "✕ routine failed"; an auto-pause is said as itself (got ' + JSON.stringify(got) + ')');
    }

    // 2. THE HUD TICKER (world.js's agent.run.end listener): RUN COMPLETE only for a run that SUCCEEDED — a stopped, cut or failed end raised
    //    no error event (a stop, a cut) or raised one (a failure) and read "RUN COMPLETE" either way
    {
      const src = sliceListener(worldSrc, "U.bus.on('agent.run.end', p => {", 'RUN COMPLETE');
      let on = null; const ticks = [];
      if (src) new Function('U', 'tickerName', 'runWorked', 'bumpShipped', 'pushTicker', 'tickerSuit', 'RunOutcome', src)(
        { bus: { on: (n, fn) => { if (n === 'agent.run.end') on = fn; } }, usd: v => '$' + v }, id => String(id).toUpperCase(), () => false, () => 1, (line, cls) => ticks.push(line + '|' + (cls || '')), () => '', RunOutcome);
      const tick = p => { ticks.length = 0; if (on) on(p); return ticks.join(' ; '); };
      const got = { done: tick(DONE), cut: tick(CUT), raised: tick(RAISED), stopped: tick({ agentId: 'agent', runId: 'r-s', reason: 'cancelled', outcome: 'stopped', turns: 1, usd: 0 }) };
      // (review 9.3: the stop in its own tone, 'stop' — never the failure's red, nor the success's plain line it shared before)
      A.ok(!!on && /RUN COMPLETE/.test(got.done) && ['cut', 'raised', 'stopped'].every(k => !/RUN COMPLETE/.test(got[k])) && /STOPPED BEFORE IT FINISHED[^|]*\|stop$/.test(got.stopped) && /CUT SHORT/.test(got.cut),
        'review r7: the HUD ticker says RUN COMPLETE only for a succeeded run — a stop, a cut reply and a failure each say how they ended (got ' + JSON.stringify(got) + ')');
    }

    // 3. THE ROUTINE'S COMMS SESSION (frontend/app/autosessions.js, the real module): a fire stopped before it said anything reads "■ routine
    //    stopped before it finished" — live, after a reload, and formed on a closed page — never the clean [SILENT] "routine ran, nothing to
    //    report"; with no receipt to read (the routine deleted mid-run, or an older station's 'failed'), the reason's leading 'cancelled' is the stop
    {
      const saved = { Workstreams: global.Workstreams, Channels: global.Channels, App: global.App, fetch: global.fetch };
      const WS = require('../frontend/app/workstreams.js');
      WS.reset();
      let busy = [];
      global.Workstreams = WS;
      global.Channels = { begin: id => { busy.push(id); }, end: id => { busy = busy.filter(x => x !== id); }, isBusy: id => busy.indexOf(id) >= 0, busyIds: () => busy.slice(), setStatus: () => {} };
      global.App = { persist: () => {}, refreshRail: () => {} };
      const stopRow = runId => ({ runId, streamId: 'cron-' + runId, agentId: 'agent', cronJobId: 'j1', title: 'do it', reason: 'cancelled', outcome: 'stopped', turns: 1, usd: 0, ts: 5 });
      const stoppedJob = runId => ({ id: 'j1', name: 'digest', agentId: 'agent', prompt: 'do it', lastRunId: runId, lastStatus: 'stopped', lastOutcome: 'stopped', lastReason: 'cancelled', lastFire: { runId, outcome: 'stopped', reason: 'cancelled' } });
      let JOBS = [], BOOT = [], cronOk = true;
      global.fetch = async url => {
        if (url === '/api/cron') return cronOk ? { ok: true, json: async () => ({ jobs: JOBS }) } : { ok: false, json: async () => ({}) };
        if (url.indexOf('/api/runs?') === 0) { const m = /runId=([^&]+)/.exec(url); return { ok: true, json: async () => ({ runs: m ? BOOT.filter(r => r.runId === decodeURIComponent(m[1])) : BOOT }) }; }
        if (url.indexOf('/api/transcript?') === 0) return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'do it' }] }) };   // the prompt only: stopped while thinking
        throw new Error('unexpected request: ' + url);
      };
      let AutoSessions = null;
      try {
        AutoSessions = require('../frontend/app/autosessions.js').AutoSessions;
        AutoSessions.reset();
        const I = AutoSessions._internals;
        const view = runId => { const w = WS.get('cron-' + runId) || {}; return { ok: w.lastRunOk, marker: (w.history || []).filter(m => m && m.sys).map(m => m.content).join(' | ') }; };
        const job = { id: 'j1', name: 'digest', agentId: 'agent', prompt: 'do it' };
        const STOP_MARK = '■ routine stopped before it finished';
        JOBS = [stoppedJob('live1')]; BOOT = [stopRow('live1')];
        I.beginSession('live1', job);
        await I.onResult({ jobId: 'j1', runId: 'live1', outcome: 'stopped', runOutcome: 'stopped', reason: 'cancelled' });
        const live = view('live1');
        await I.backfill({ sleep: () => Promise.resolve() });   // a reload of the same page
        const reload = view('live1');
        WS.reset(); AutoSessions.reset(); busy = [];
        JOBS = [stoppedJob('closed1')]; BOOT = [stopRow('closed1')];
        await I.backfill({ sleep: () => Promise.resolve() });   // the page was closed through the fire
        const closed = view('closed1');
        A.ok([live, reload, closed].every(v => v.ok == null && v.marker === STOP_MARK),
          'review r7: a fire stopped before it said anything reads "' + STOP_MARK + '" live, after a reload and on a closed page — no verdict, never "routine ran, nothing to report" (got ' + JSON.stringify({ live, reload, closed }) + ')');
        // no receipt: the routine was deleted mid-run (GET /api/cron no longer lists it), and an older station said 'failed' for the stop
        WS.reset(); AutoSessions.reset(); busy = [];
        JOBS = []; BOOT = [];
        I.beginSession('gone1', job);
        await I.onResult({ jobId: 'j1', runId: 'gone1', outcome: 'failed', reason: 'cancelled' });
        cronOk = false;
        I.beginSession('gone2', job);
        await I.onResult({ jobId: 'j1', runId: 'gone2', outcome: 'failed', reason: 'cancelled (stale-lease)' });
        const gone = { deleted: view('gone1'), fetchFailed: view('gone2') };
        A.ok([gone.deleted, gone.fetchFailed].every(v => v.ok == null && !/Routine failed/.test(v.marker)),
          'review r7: with no receipt to read (a routine deleted mid-run, GET /api/cron failing) a stop is still no verdict — never "⚠ Routine failed — cancelled" (got ' + JSON.stringify(gone) + ')');
      } finally {
        if (AutoSessions && AutoSessions.reset) AutoSessions.reset();
        WS.reset();
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
      }
    }

    // 4. THE PHONE PUSH (sidecar/index.js remoteNotify, sliced): "<agent> finished" only for a run that SUCCEEDED — it was chosen by the error
    //    field alone, so a cut, budget, step-limit, empty or never-ended run pushed "finished" over its partial reply. host.js carries the
    //    run's outcome on run.ended now; an older host's reason resolves to it.
    {
      const src = sidecarTopLevelFunction('remoteNotify');
      const pushes = [];
      let notify = null;
      try {
        notify = new Function('remotePush', 'remoteApprovals', 'REMOTE_ASK_GRACE_MS', 'remotePushSend', 'remoteAskMessage', 'transcriptStore', 'failNote', 'TaskIntent', 'ForkMarkers', 'remoteAgentName', 'RunOutcome',
          src + '\nreturn remoteNotify;')({ subscribed: () => [{}] }, { list: () => [] }, 0, m => { pushes.push(m); }, () => ({}),
          { history: () => [{ role: 'assistant', content: 'Here is the first half of the answ' }] }, () => {}, { parse: () => null }, { parse: () => null, stripMarkers: s => s }, () => 'RESEARCHER', RunOutcome);
      } catch (e) { notify = null; }
      const pushOf = evt => { pushes.length = 0; if (notify) notify(Object.assign({ type: 'run.ended', runId: 'r', agentId: 'researcher', streamId: 's', usd: 0, error: null }, evt)); return pushes.length ? pushes[0].title : '(no push)'; };
      const got = {
        done: pushOf({ reason: 'done', outcome: 'succeeded' }), cut: pushOf({ reason: 'cut_short', outcome: 'cut_short' }), budget: pushOf({ reason: 'budget', outcome: 'out_of_budget' }),
        steps: pushOf({ reason: 'max_iters', outcome: 'step_limit' }), empty: pushOf({ reason: 'empty', outcome: 'empty' }), noend: pushOf({ reason: 'error', outcome: 'failed', failureCode: 'no_terminal_outcome' }),
        olderCut: pushOf({ reason: 'cut_short' }), olderNoEnd: pushOf({ reason: 'error' }), stopped: pushOf({ reason: 'stopped', outcome: 'stopped' })
      };
      A.ok(!!notify && got.done === 'RESEARCHER finished' && ['cut', 'budget', 'steps', 'empty', 'noend', 'olderCut', 'olderNoEnd'].every(k => !/finished$/.test(got[k])) && got.stopped === '(no push)'
        && /cut short/.test(got.cut) && /hit a problem/.test(got.noend),
        'review r7: the phone pushes "<agent> finished" only for a run that succeeded — a cut, limited, empty or never-ended run says how it ended; a stop pushes nothing (got ' + JSON.stringify(got) + ')');
    }

    // 5. A STOPPED WORKER'S THREAD (frontend/app/stationcommands.js noteOutcome, sliced): a delivered worker whose reason is 'cancelled' (its lead
    //    was stopped) is no verdict — never ok=false, which painted its thread "last run failed" and counted it on the board's failed count
    {
      const src = functionSourceIn(read('frontend/app/stationcommands.js'), 'noteOutcome');
      const ends = [];
      const noteOutcome = src ? new Function('Workstreams', src + '\nreturn noteOutcome;')({ noteRunEnd: (id, runId, ok, why) => { ends.push([ok, why]); return true; } }) : null;
      if (noteOutcome) { noteOutcome({ id: 't1' }, 'w1', 'cancelled'); noteOutcome({ id: 't2' }, 'w2', 'error'); noteOutcome({ id: 't3' }, 'w3', 'done'); }
      A.ok(!!noteOutcome && JSON.stringify(ends) === JSON.stringify([[null, 'cancelled'], [false, 'error'], [true, 'done']]),
        'review r7: a stopped worker\'s delivery settles its thread with no verdict (null), a failed one false, a finished one true (got ' + JSON.stringify(ends) + ')');
    }

    // 6. THE DELEGATED BATCH LAMP (frontend/app/delegated.js lineHtml): one worker stopped and two done is no failed batch — the rows already
    //    said "stopped"; the lamp and the summary read the red failed tone
    {
      const saved = { Channels: global.Channels, Overseer: global.Overseer, App: global.App, document: global.document };
      global.Channels = { pendingOf: () => null, pendingAllOf: () => [], isBusy: () => false, elapsedOf: () => NaN, runIdOf: () => '' };
      global.Overseer = { snapshot: () => ({ workers: [], threads: [] }), fresh: () => true };
      global.App = { agentName: id => id };
      global.document = undefined;
      require('./helpers/frontend-esc.js').installEsc();   // delegated.js escapes with the production U.esc, as in the page
      try {
        const D = require('../frontend/app/delegated.js');
        const ws = o => Object.assign({ id: 'k', history: [], runIds: ['r'] }, o);
        D._internals.opened.add('stopb');
        const html = D._internals.lineHtml({ lead: 'stopb', rows: [{ ws: ws({ id: 'k1', agentId: 'a', title: 'One', lastRunReason: 'done' }), worker: null },
          { ws: ws({ id: 'k2', agentId: 'b', title: 'Two', lastRunReason: 'done' }), worker: null }, { ws: ws({ id: 'k3', agentId: 'c', title: 'Three', lastRunReason: 'cancelled' }), worker: null }] }, 'home');
        const head = /<span class="dg-lamp ([^"]+)"/.exec(html);
        A.ok(!!head && head[1] !== 'failed' && /2 done · 1 stopped|1 stopped · 2 done/.test(html) && !/dg-line-sum failed/.test(html),
          'review r7: a batch whose only unfinished worker was stopped is no failed batch (got lamp ' + (head && head[1]) + ': ' + JSON.stringify((/dg-line-sum[^>]*>[^<]*/.exec(html) || [''])[0]) + ')');
      } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; } }
    }

    // 7. THE TERMINAL FLOOR (bin/lib/floor.js): a worker someone stopped flies back to its lead as a stop, never a red failed result
    {
      const camfeed = require('../bin/lib/camfeed.js');
      const { makeFloor } = require('../bin/lib/floor.js');
      const fl = makeFloor(camfeed.makeCamFeed());
      const runs = new Map([['L', { runId: 'L', agentId: 'agent' }], ['w', { runId: 'w', agentId: 'forge', parentRunId: 'L', prompt: 'build it' }]]);
      fl.observe(runs, id => id.toUpperCase(), () => 'cancelled', 1000);
      runs.delete('w');
      fl.observe(runs, id => id.toUpperCase(), () => 'cancelled', 2000);
      const back = fl.log().slice(-1)[0] || {};
      A.ok(back.text === 'FORGE → AGENT  stopped' && back.style === 'fg', 'review r7: a stopped worker flies back as "stopped" in the plain style, never a red failed result (got ' + JSON.stringify(back) + ')');
    }

    // 8. THE COUNTERS: "% success" (sidecar/insights.js) — a Stop lowered it as if it were a failure; recipe drift (sidecar/recipe-drift.js) —
    //    a stopped latest run raised verdict_regressed ("⚠ recipe drift … latest run ended cancelled") and a red ✗ in the streak; the habit
    //    detector (sidecar/workflow-takeover.js candidates) — a stopped occasion broke the streak as a failure
    {
      const { foldInsights } = require('../sidecar/insights.js');
      const ins = foldInsights([DONE, DONE, DONE, { agentId: 'agent', runId: 'r-s', reason: 'cancelled', outcome: 'stopped', turns: 1, usd: 0 }], { nowMs: 1 });
      A.ok(ins.successPct === 100, 'review r7: insights — three succeeded runs and one Stop read 100% success, never 75% (got ' + ins.successPct + '%)');
      const Drift = require('../sidecar/recipe-drift.js');
      const good = i => ({ runId: 'g' + i, reason: 'done', outcome: 'succeeded', ts: 10 - i, usd: 0.01, model: 'm' });
      const d = Drift.assessDrift([{ runId: 's', reason: 'cancelled', outcome: 'stopped', ts: 20, usd: 0, model: 'm' }, good(1), good(2), good(3)]);
      A.ok(d.status !== 'drift' && !d.signals.some(s => s.code === 'verdict_regressed') && d.streak[0] === 'stop' && d.streak.indexOf('fail') < 0,
        'review r7: recipe drift — a stopped latest run is no drift and its streak mark is a stop, never a fail (got ' + JSON.stringify({ status: d.status, signals: d.signals, streak: d.streak }) + ')');
      const marketplace = read('frontend/app/marketplace.js');
      A.ok(/m === 'stop' \? '■'/.test(marketplace), 'review r7: the RECIPES card draws a stopped run\'s streak mark neutral (■), never the red ✗');
    }

    // 9. THE AWAY BRIEFING beyond routines (sidecar/away-briefing.js compose): a loop pass, a delegated worker and an away build someone stopped
    //    — each read as failed ("(1 failed)", "didn't finish: cancelled" under Waiting on you, counts.failed) — and a routine stage someone
    //    stopped ("failed: its work line stopped at a stage (cancelled)")
    {
      const B = require('../sidecar/away-briefing.js');
      const row = (runId, streamId, o) => Object.assign({ runId, streamId, agentId: 'agent', surface: 'autonomous', reason: 'done', outcome: 'succeeded', title: 'x', ts: 5, endedAt: 5 }, o || {});
      const STOP = { reason: 'cancelled', outcome: 'stopped' };
      const loop = B.compose({ since: 1, now: 99, runs: [row('l1', 'loop-tests', { ts: 2, endedAt: 2 }), row('l2', 'loop-tests', { ts: 3, endedAt: 3 }), row('l3', 'loop-tests', Object.assign({ ts: 4, endedAt: 4 }, STOP))], loops: [{ id: 'tests', name: 'tests' }], jobs: [], builds: [], drafts: [] });
      const build = B.compose({ since: 1, now: 99, runs: [row('b1', 'workshop-b1', Object.assign({ title: 'landing page' }, STOP))], jobs: [], builds: [], drafts: [] });
      const deleg = B.compose({ since: 1, now: 99, runs: [row('d1', 'ws_t1', { delegatedBy: 'lead', dispatchDelivery: { state: 'final', reason: 'cancelled' }, reason: 'cancelled', outcome: 'stopped' }), row('d2', 'ws_t2', { delegatedBy: 'lead', dispatchDelivery: { state: 'final', reason: 'cancelled' }, reason: 'cancelled', outcome: 'stopped' })],
        threads: [{ id: 'ws_t1', parentStreamId: 'conv' }, { id: 'ws_t2', parentStreamId: 'conv' }, { id: 'conv', title: 'Launch planning' }], jobs: [], builds: [], drafts: [] });
      const stage = B.compose({ since: 1, now: 99, runs: [row('f1', 'cron-f1', { cronJobId: 'j1' }), row('h1', 'cron-f1', Object.assign({ ts: 6, endedAt: 6, agentId: 'editor' }, STOP))], jobs: [{ id: 'j1', name: 'digest' }], builds: [], drafts: [] });
      const said = { loop: loop.text, build: build.text, deleg: deleg.text, stage: stage.text };
      const counts = { loop: loop.counts, build: build.counts, deleg: deleg.counts, stage: stage.counts };
      A.ok(Object.keys(counts).every(k => counts[k].failed === 0 && counts[k].stopped >= 1) && Object.keys(said).every(k => !/failed|didn’t finish/.test(said[k]))
        && /Loop “tests”: 3 passes \(1 stopped\)/.test(said.loop) && /An away build \(“landing page”\) was stopped before it finished/.test(said.build)
        && /2 delegated jobs in “Launch planning” were stopped before it finished|2 delegated jobs in “Launch planning” were stopped/.test(said.deleg) && /“digest” was stopped before it finished/.test(said.stage),
        'review r7: the away briefing says a stopped loop pass, away build, delegated worker and routine stage as stops — never failed, never under Waiting on you (got ' + JSON.stringify({ counts, said }) + ')');
    }

    // 10. THE WORK LINE (routing/chain.js + routing/line-fire.js): a hop someone stopped stops the line as a STOP — said "<agent> was stopped",
    //     never "<agent> failed: stopped by you" — and the line is HALTED, so its fire settles 'stopped' (RunOutcome.ofLine), never 'succeeded'
    //     with stage one's draft delivered as the routine's whole result (with no note at all for a stop before the first hop)
    {
      const { makeChainRunner } = require('../sidecar/routing/chain.js');
      const LineFire = require('../sidecar/routing/line-fire.js');
      let T = 0;
      const runner = makeChainRunner({ nextAgent: a => ({ writer: 'editor' })[a] || null, runAgent: async () => ({ text: 'half an edi', usd: 0, error: 'stopped by you', stopped: true }), now: () => (T += 10) });
      let out = null;
      try { out = await runner.advance({ agentId: 'writer', text: 'stage one draft', originalText: 'write it' }); } catch (e) { out = { error: String((e && e.message) || e) }; }
      const fold = LineFire.foldLineIntoFire({ buf: 'stage one draft', usd: 0 }, { text: '', hops: [], stopped: 'stopped', halted: true, usd: 0 });
      A.ok(!!out && out.halted === true && /editor was stopped/.test(String(out.stopped)) && !/failed/.test(String(out.stopped)) && !/failed/.test(LineFire.lineStopNote(out)),
        'review r7: a hop someone stopped stops its line as a stop (halted), never "<agent> failed: stopped by you" (got ' + JSON.stringify(out && { stopped: out.stopped, halted: out.halted, note: LineFire.lineStopNote(out) }) + ')');
      A.ok(fold.line && fold.line.halted === true && /stopped before it finished/.test(fold.buf) && RunOutcome.ofLine(RunOutcome.ofEnd(DONE, null), fold.line).outcome === 'stopped',
        'review r7: a line stopped before its first hop says so under stage one\'s draft, and its fire settles stopped (got ' + JSON.stringify({ line: fold.line, buf: fold.buf }) + ')');
    }

    // 11. THE BUILD QUEST card (frontend/app/workquests.js): a build stalled by a stop said "the run errored out"
    {
      const WQ = require('../frontend/app/workquests.js');
      let card = null;
      try {
        const st = { quests: { q1: { title: 'landing page', steps: [{ key: 'a', label: 'a', done: false }], firstSeenAt: 1, stalledAt: 5, stalledReason: 'cancelled', completedAt: null, runId: 'r' } } };
        card = (WQ.project(st) || [])[0] || null;
      } catch (e) { card = { threw: String((e && e.message) || e) }; }
      A.ok(!!card && /stopped before it finished/.test(String(card.desc)) && !/errored out/.test(String(card.desc)),
        'review r7: a build quest stalled by a stop says it was stopped, never "the run errored out" (got ' + JSON.stringify(card) + ')');
    }

    // 12. A STOPPED RECOMMENDATION (frontend/app/suggeststore.js onRunEnd, sliced): the Commander accepted an idea and stopped its run to change
    //     the brief; the ledger recorded the idea declined for bad quality (quality -1), which down-ranked that kind of idea
    {
      const src = functionSourceIn(read('frontend/app/suggeststore.js'), 'onRunEnd');
      const posts = [];
      let run = null;
      try {
        run = new Function('ready', 'acceptedRecommendationInit', 'ledgerPost', 'RunOutcome', 'state', 'pitchDone', 'familiarityNow', 'save',
          'let acceptedRecommendation = acceptedRecommendationInit, acceptedRunId = "r1";\n' + src + '\nreturn onRunEnd;')(() => true, 'rec1', p => posts.push(p), RunOutcome, { tasksSinceLast: 0 }, () => false, () => null, () => {});
        run({ runId: 'r1', agentId: 'agent', reason: 'cancelled', outcome: 'stopped' });
      } catch (e) { posts.push({ threw: String((e && e.message) || e) }); }
      A.ok(!!run && !posts.some(p => p.state === 'declined' || p.reason === 'bad_quality' || (p.outcome && p.outcome.quality < 0)),
        'review r7: an accepted idea whose run was stopped is no verdict on the idea — never declined for bad quality (got ' + JSON.stringify(posts) + ')');
    }

    // 13. THE HABIT DETECTOR (sidecar/workflow-takeover.js, the occasion's failed AND ok rules sliced): a stopped occasion is NEUTRAL, as a
    //     question is — never a failed occasion, and (review 7.1) never a completed one: the ok rule never read the outcome, so a stopped run
    //     that ran a tool counted as an occasion, was cited as takeover evidence ("each recorded run completed with tool work") and pushed a
    //     two-occasion habit over the three-occasion threshold. The real module's candidates() is driven with that habit too.
    {
      const src = sidecarRead('sidecar/workflow-takeover.js');
      const m = /const oc = RunOutcome\.ofRow\(r\);[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*(const failed = [^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*const ok = [\s\S]*?;)\n/.exec(src);
      const ruleOf = m ? new Function('RunOutcome', 'ratingMap', 'r', 'b', 'const oc = RunOutcome.ofRow(r);\nconst uncertain = false;\n' + m[1] + '\nreturn { failed, ok };') : null;
      const run = (row, brief) => { try { return ruleOf(RunOutcome, new Map(), row, brief); } catch (e) { return { threw: String((e && e.message) || e) }; } };
      const got = ruleOf ? {
        stopped: run({ runId: 'x', reason: 'cancelled', outcome: 'stopped', toolsOk: 3 }, { status: 'cancelled' }),
        stoppedDone: run({ runId: 'x2', reason: 'cancelled', outcome: 'stopped', toolsOk: 3 }, { status: 'done' }),
        failed: run({ runId: 'y', reason: 'error', outcome: 'failed', toolsOk: 3 }, { status: 'done' }),
        asked: run({ runId: 'z', reason: 'clarifying', outcome: 'asked' }, { status: 'done' }),
        clean: run({ runId: 'w', reason: 'done', outcome: 'succeeded', toolsOk: 3 }, { status: 'done' })
      } : null;
      A.ok(!!got && got.stopped.failed === false && got.stopped.ok === false && got.stoppedDone.failed === false && got.stoppedDone.ok === false
        && got.failed.failed === true && got.asked.failed === false && got.asked.ok === false && got.clean.failed === false && got.clean.ok === true,
        'review r7 / 7.1: the habit detector reads a stopped occasion as neutral (neither failed nor completed, tool work or not), a failed one as failed, a clean one as an occasion (got ' + JSON.stringify(got) + ')');
      // the real detector over a habit asked for three times, two days apart, its middle run stopped after three tool calls
      const W = require('../sidecar/workflow-takeover.js');
      const DAY = 86400000, now = Date.parse('2026-10-30T12:00:00Z');
      const text = 'Summarize the open pull requests in the starnet repo and post the summary to the team notes file';
      const occasion = (i, stopped) => {
        const at = now - (10 - i * 2) * DAY;
        return { b: { id: 'tb' + i, runId: 'r' + i, agentId: 'a1', source: 'interactive', originalDirective: text, status: stopped ? 'active' : 'done', completedAt: stopped ? undefined : at, updatedAt: at },
          r: { runId: 'r' + i, agentId: 'a1', streamId: 's' + i, reason: stopped ? 'cancelled' : 'done', outcome: stopped ? 'stopped' : 'succeeded', toolsOk: 3, artifacts: [] } };
      };
      const detect = stoppedAt => {
        const rows = [0, 1, 2, 3].filter(i => i < 3 || stoppedAt != null).map(i => occasion(i, i === stoppedAt));
        const c = W.candidates({ briefs: rows.map(x => x.b), runs: rows.map(x => x.r), ratings: [], now, jobs: [], state: null });
        return c.map(k => ({ count: k.count, runs: k.evidence.map(e => e.runId) }));
      };
      const three = detect(null), oneStopped = (() => { const rows = [0, 1, 2].map(i => occasion(i, i === 1)); return W.candidates({ briefs: rows.map(x => x.b), runs: rows.map(x => x.r), ratings: [], now, jobs: [], state: null }).length; })();
      const fourWithStop = detect(1);
      A.ok(three.length === 1 && three[0].count === 3 && oneStopped === 0 && fourWithStop.length === 1 && fourWithStop[0].count === 3 && fourWithStop[0].runs.indexOf('r1') < 0,
        'review 7.1: a stopped run is never a completed occasion — two clean runs and a stop propose nothing, and the stop is never cited as evidence (got ' + JSON.stringify({ three, oneStopped, fourWithStop }) + ')');
    }

    // 14. THE TRIGGER RUNNER (sidecar/routing/trigger-runner.js, the real runner over a fake hub): a webhook job whose stage someone stopped was
    //     recorded as an error ("✕ did not finish · last error: a stage (WRITER) ended \"cancelled\""); it records the stop, with no error
    {
      const { makeTriggerRunner } = require('../sidecar/routing/trigger-runner.js');
      const T = require('../sidecar/routing/triggers.js');
      const disk = { triggers: { triggers: [] }, seen: {} };
      const runsByStream = {};
      let mode = 'stopped';
      const fakeHub = hooks => ({
        onInbound(msg) {
          hooks.onRouted({ agentId: 'agent-a', dockId: 'b1' });
          hooks.onResolved({ chatId: msg.chatId, agentId: 'agent-a', isTask: true, lineId: 'L1', dockId: 'b1' });
          const sid = hooks.streamId();
          return Promise.resolve().then(() => {
            const second = mode === 'stopped' ? { reason: 'cancelled', outcome: 'stopped' } : { reason: 'error', outcome: 'failed', failureCode: 'rate_limit' };
            runsByStream[sid] = [{ runId: 'r1', agentId: 'agent-a', reason: 'done', outcome: 'succeeded', usd: 0, streamId: sid }, Object.assign({ runId: 'r2', agentId: 'agent-b', usd: 0, streamId: sid }, second)];
            hooks.onLineOutcome(Object.assign({ agentId: 'agent-a', dockId: 'b1', hops: [] }, mode === 'stopped' ? { stopped: 'agent-b was stopped', halted: true } : { stopped: 'agent-b failed: its run failed (rate_limit)' }));
          });
        }, close() {}
      });
      let n = 0;
      const R = makeTriggerRunner({ load: () => JSON.parse(JSON.stringify(disk.triggers)), save: v => { disk.triggers = JSON.parse(JSON.stringify(v)); },
        seen: { load: () => ({}), save: () => {} }, makeHub: fakeHub, plan: () => ({ lines: [{ lineId: 'L1' }], reach: { 'agent-a': true }, lineOfAgent: { 'agent-a': 'L1' } }),
        shipsToOutbox: a => a === 'agent-b', dayCap: () => ({ cap: null, spent: 0 }), runsFor: sid => runsByStream[sid] || [], emit: () => {},
        watcher: { watch: () => ({ close() {} }), close() {} }, now: () => Date.now(), newId: () => 'tr' + (++n) + 'abcdef0123456789' });
      const made = R.create({ kind: 'webhook', lineId: 'L1', name: 'hook', maxPerHour: 30 }, { secretHash: T.hashSecret('k') });
      const views = {};
      if (made.ok) {
        for (const m2 of ['stopped', 'failed']) { mode = m2; R.enqueue(made.trigger.id, { text: 'job ' + m2, preview: 'HOOK' }); await new Promise(r => setTimeout(r, 30)); const v = R.view(made.trigger.id); views[m2] = { lastOutcome: v.lastOutcome, lastError: v.lastError }; }
      }
      try { if (R.close) R.close(); } catch (_) { /* the fold's own runner */ }
      A.ok(!!views.stopped && views.stopped.lastOutcome && views.stopped.lastOutcome.ok === false && views.stopped.lastOutcome.stopped === true && views.stopped.lastError == null
        && views.failed && views.failed.lastOutcome && !views.failed.lastOutcome.stopped && /rate_limit|failed|ended/.test(String(views.failed.lastError)),
        'review r7: a trigger job someone stopped records the stop with no error; a failed one still names its error (got ' + JSON.stringify(views) + ')');
      const panel = read('frontend/app/workflowpanel.js');
      A.ok(/lo\.stopped \? ' · <span class="dim">■ stopped before it finished<\/span>'/.test(panel), 'review r7: the trigger row says a stopped job as a stop, never the warn "✕ did not finish"');
    }

    // 15. THE HAND-OFF and SAMPLE jobs (routing/handoff-runner.js and the sample route, their stop rule sliced): a desk / HUD STOP on a step
    //     recorded the job '⚠ PROBLEM — a step did not finish cleanly'; only E-STOP read as stopped
    {
      const hsrc = sidecarRead('sidecar/routing/handoff-runner.js'), idx = sidecarRead('sidecar/index.js');
      A.ok(/lineRunner\.settle\(job, \{ line: lo, runs,/.test(hsrc) && /stopped: halted\(\)/.test(hsrc), 'SEND TO uses the shared row verdict and explicit E-STOP');
      A.ok(/lineRunner\.settle\(sampleInFlight\.job, \{ line: sampleLineOutcome, runs,/.test(idx) && /stopped: !!sampleInFlight\.stopRequested/.test(idx), 'RUN ONE REAL JOB uses the same rows and explicit STOP');
      const of = require('../sidecar/routing/line-runner.js').outcomeOf;
      const stoppedRuns = [{ reason: 'done', outcome: 'succeeded' }, { reason: 'cancelled', outcome: 'stopped' }];
      const failedRuns = [{ reason: 'done', outcome: 'succeeded' }, { reason: 'error', outcome: 'failed' }];
      for (const entry of ['sendto', 'sample']) {
        const stopped = of({ runs: stoppedRuns, line: { outboxId: 'o' } });
        const failed = of({ runs: failedRuns, line: { outboxId: 'o' } });
        const estop = of({ runs: failedRuns, stopped: true });
        A.eq([stopped.status, stopped.outcome, stopped.stop.code], ['stopped', 'stopped', 'stopped'], entry + ': a desk/HUD stop stays a stop');
        A.eq([failed.status, failed.outcome, failed.stop.code], ['problem', 'stopped_short', 'stage_failed'], entry + ': failed work stays a problem');
        A.eq([estop.status, estop.outcome, estop.delivered], ['stopped', 'stopped', false], entry + ': E-STOP prevents OUTBOX delivery even with older failed rows');
      }
      A.ok(/const stepStopped = result\.outcome === 'stopped';/.test(idx), 'the sample surface reads the shared stop outcome');
    }

    // 16. THE STEP TEST (sidecar/routing/steptest.js, its stop rule sliced): a STOP that reached the step's run from the HUD or a desk screen
    //     read "Test failed" with "✕ writer failed: stopped by you"
    //     (channel-delivery-ledger: a withdrawn run carries one endReason, read through halt.js endOf; an E-STOP or fault is `killed`)
    {
      const ssrc = sidecarRead('sidecar/routing/steptest.js');
      const m = /(const end = endOf\(rec\);\n\s*const killed = [^\n]*\n\s*const hopStopped = [^\n]*\n\s*const stoppedBy = [^\n]*\n[^\n]*)/.exec(ssrc);
      const { endOf } = require('../sidecar/halt.js');
      const of = m ? new Function('r', 'rec', 's', 'endOf', m[1] + '\nreturn { hopStopped, stoppedBy };') : null;
      const got = of ? of({ stopped: true, error: 'stopped by you' }, {}, {}, endOf) : null;
      const estop = of ? of({ stopped: true, error: 'stopped by you' }, { endReason: 'halted' }, {}, endOf) : null;
      A.ok(!!got && got.hopStopped === true && got.stoppedBy === 'stopped by you mid-run' && /if \(s\._stop \|\| killed \|\| hopStopped \|\| s\.state !== 'running'\)/.test(ssrc)
        && !!estop && estop.hopStopped === false && /E-STOP/.test(estop.stoppedBy || ''),
        'review r7: a step test whose step someone stopped from outside the test finishes stopped, never failed, and an E-STOP stays one (got ' + JSON.stringify({ got, estop }) + ')');
    }

    // 17. AN AWAY BUILD SOMEONE STOPPED (sidecar/index.js: the workshop shift, the night-shift act, BUILD IT): it counted as a failed build
    //     attempt — PARKED "after repeated failures" at the second stop, a FAILED deliverable row, "produced nothing reviewable"
    {
      const idx = sidecarRead('sidecar/index.js');
      const src = sidecarTopLevelFunction('awayBuildStopped');
      const stoppedOf = src ? new Function('RunOutcome', src + '\nreturn awayBuildStopped;')(RunOutcome) : null;
      const aborted = new AbortController(); aborted.abort();
      const got = stoppedOf ? { cancelled: stoppedOf({ reason: 'cancelled' }, null, null), done: stoppedOf({ reason: 'done' }, null, null), thrownAborted: stoppedOf(null, new Error('aborted'), aborted.signal), thrown: stoppedOf(null, new Error('boom'), new AbortController().signal) } : null;
      const sites = (idx.match(/releaseClaim\([^)]*\{ failed: !stoppedBuild \}\)/g) || []).length + (/if \(!manifest && awayBuildStopped\(ran, threw, signal\)\) \{\n\s*await workshopStore\.releaseClaim\(id, runId, \{ failed: false \}\);/.test(idx) ? 1 : 0);
      A.ok(!!got && got.cancelled === true && got.done === false && got.thrownAborted === true && got.thrown === false && sites === 3,
        'review r7: an away build someone stopped is no failed attempt at all three build sites (got ' + JSON.stringify({ got, sites }) + ')');
    }

    // 18. MY WORK › DELIVERABLES (sidecar/index.js deliverableRows, sliced): a stopped run's files read under the red FAILED pill
    {
      const src = sidecarTopLevelFunction('deliverableRows');
      let rows = null;
      try {
        const runRow = { runId: 'rs', agentId: 'agent', streamId: 'web-1', reason: 'cancelled', outcome: 'stopped', title: 'write the report', ts: 5, artifacts: [{ kind: 'file', path: 'report.md' }] };
        const fn = new Function('workshopAgentIds', 'workshopStore', 'deliverableStore', 'deliverableFile', 'deliverableSize', 'validateWorkshopManifest', 'workshopBuiltAtOf', 'lineJobs', 'LineJobs', 'runStore', 'RunOutcome', 'lifecycleRow', 'path', 'makeProvenanceIndex', 'contextpack',
          src + '\nreturn deliverableRows;')(() => [], { read: () => ({ backlog: [] }) }, { list: () => [] }, (a, r, f) => ({ path: f.path }), () => 0, async () => null, () => 0,
          { jobs: [] }, { list: () => [], all: () => [] }, { list: () => [runRow], all: () => [runRow] }, RunOutcome, () => ({}), path,
          () => ({ projectOf: () => '', contributorsOf: () => [], factsOf: () => null }), { isInternalStream: () => false });
        rows = await fn();
      } catch (e) { rows = { threw: String((e && e.message) || e) }; }
      const r = Array.isArray(rows) ? rows.find(x => x && x.runId === 'rs') : null;
      const pills = read('frontend/app/deliverables.js');
      A.ok(!!r && r.status === 'stopped' && /stopped: \{ label: 'STOPPED', cls: 'off' \}/.test(pills),
        'review r7: a stopped run\'s deliverable reads STOPPED, never the red FAILED pill (got ' + JSON.stringify(r ? { status: r.status } : rows) + ')');
    }

    // 19. THE TERMINAL'S REASON-ONLY CHAT (bin/lib/station-io.js, over a loopback station): a reply the provider cut resolved { text }, and
    //     the awakening took the cut lines as its whole answer; it resolves an unfinished reply as { error, text, outcome }
    {
      const http = require('http');
      const { makeStationIO } = require('../bin/lib/station-io.js');
      let finish = 'length';
      const srv = http.createServer((req, res) => {
        req.resume(); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ name: 'agent.token', payload: { delta: 'Line one\nLine tw' } }) + '\n');
          res.end(JSON.stringify({ name: 'agent.run.end', payload: finish === 'length' ? { reason: 'done', finishReason: 'length', outcome: 'cut_short' } : { reason: 'done', outcome: 'succeeded' } }) + '\n');
        });
      });
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      const io = makeStationIO({ host: '127.0.0.1', port, base: 'http://127.0.0.1:' + port, token: () => 't', request: async () => ({}) });
      const cut = await io.chat({ directive: 'x', ms: 5000 });
      finish = 'stop';
      const clean = await io.chat({ directive: 'x', ms: 5000 });
      srv.closeAllConnections && srv.closeAllConnections(); await new Promise(r => srv.close(r));
      A.ok(!!cut.error && cut.outcome === 'cut_short' && !clean.error && /Line one/.test(clean.text || ''),
        'review r7: the terminal\'s chat resolves a cut reply as an error (its text beside it), a finished one as its text (got ' + JSON.stringify({ cut, clean }) + ')');
    }

    // 20. THE ROUTINES WINDOW'S RUN NOW (frontend/app/windows/routines.js, the press's stream reader and verdict sliced): a Stop toasted a red
    //     "routine did not finish" warn; a press whose WORK LINE someone stopped (its entry run clean) toasted green "routine ran" — the stream
    //     carries the entry run only, so the verdict reads the fire's receipt
    {
      const btnSrc = read('frontend/app/windows/routines.js');
      const at = btnSrc.indexOf('            const reader = resp.body.getReader()');
      const body = at < 0 ? '' : btnSrc.slice(at, btnSrc.indexOf('\n', btnSrc.indexOf('notify(', at)));
      async function press(events, receipt) {
        const bytes = new TextEncoder().encode(events.map(([name, payload]) => JSON.stringify({ name, payload })).join('\n') + '\n');
        let sent = false;
        const reader = { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } };
        const ob = { innerHTML: '' }, toasts = [];
        const Harness = { api: { get: async () => ({ jobs: [{ id: 'j1', lastFire: receipt }] }) } };
        await new Function('resp', 'TextDecoder', 'ob', 'esc', 'notify', 'RunOutcome', 'Harness', 'id', 'return (async () => {\n' + body + '\n})();')(
          { body: { getReader: () => reader } }, TextDecoder, ob, v => String(v == null ? '' : v), (m, k) => toasts.push([m, k]), RunOutcome, Harness, 'j1');
        return toasts.pop() || [];
      }
      const start = ['agent.run.start', { agentId: 'agent', runId: 'rn1', trigger: 'manual' }];
      const stopPress = body ? await press([start, ['agent.run.end', { agentId: 'agent', runId: 'rn1', reason: 'cancelled', outcome: 'stopped' }]], { runId: 'rn1', outcome: 'stopped' }) : [];
      const linePress = body ? await press([start, ['agent.token', { runId: 'rn1', delta: 'stage one draft' }], ['agent.run.end', { agentId: 'agent', runId: 'rn1', reason: 'done', outcome: 'succeeded' }]], { runId: 'rn1', outcome: 'stopped' }) : [];
      const cleanPress = body ? await press([start, ['agent.run.end', { agentId: 'agent', runId: 'rn1', reason: 'done', outcome: 'succeeded' }]], { runId: 'rn1', outcome: 'succeeded' }) : [];
      A.ok(stopPress[0] === 'routine stopped before it finished' && stopPress[1] === '' && linePress[0] === 'routine stopped before it finished' && cleanPress[0] === 'routine ran' && cleanPress[1] === 'good',
        'review r7: Run Now says a stop as a stop — its own, or its work line\'s by the fire\'s receipt — never a red warn or a green "routine ran" (got ' + JSON.stringify({ stopPress, linePress, cleanPress }) + ')');
    }

    // 21. THE ROUTINE'S STATUS WORD to a lead, a channel and an app (an older record kept lastStatus 'error' beside its stopped outcome):
    //     routine.list told the lead 'error', Telegram /routines "last error (…cancelled…)", an app "last refresh failed"
    {
      const { makeRoutineTools } = require('../sidecar/tools/builtin/routines.js');
      const older = { id: 'old-stop', name: 'digest', agentId: 'agent', enabled: true, lastRunAt: '2023-11-14T22:14:20.000Z', lastStatus: 'error', lastOutcome: 'stopped', lastReason: 'cancelled', lastError: 'run ended without completion — it was cancelled before it finished [cancelled]' };
      let listed = [];
      try { listed = JSON.parse((await makeRoutineTools({ listJobs: () => [older] }).listTool.run({}, { agentId: 'agent' })).content).jobs || []; } catch (_) { listed = []; }
      const lead = (listed[0] || {}).lastStatus;
      // (review 9.3: the real module's jobLine — it reads the record's outcome through the module's recordOutcome and RunOutcome)
      const { makeSlashActions } = require('../sidecar/slash-actions.js');
      const line = makeSlashActions({})._internals.jobLine(older, 0, 'agent');
      const appsSrc = read('frontend/app/apps.js');
      A.ok(lead === 'stopped' && /last run stopped before it finished/.test(line) && !/last error/.test(line) && /else if \(s\.lastStatus === 'stopped'\) parts\.push\('last refresh was stopped before it finished'\)/.test(appsSrc),
        'review r7: a stopped fire reads stopped to the lead, a channel\'s /routines and an app, never "error" / "last refresh failed" (got ' + JSON.stringify({ lead, line }) + ')');
    }

    // 22. THE PAGE AUTOPILOT (frontend/app/autopilotstore.js act, the real module; review 7.1, CHAT_RECEIVER): deps.chat is Harness.chat, which
    //     hands back a reply the provider cut, a limit or a STOP ended as { text, outcome } with no error. The act took each of its three replies
    //     on the error flag alone: a cut DO reply ("2. Tag the rel") was presented as a finished desk draft — and with cabinet:write granted,
    //     written as a real file — and a stopped review could swap in a truncated revision or default to 'ship'
    {
      const savedAutopilot = global.Autopilot;
      global.Autopilot = require('../frontend/app/autopilot.js');
      let presented = [], writes = [];
      let got = null;
      try {
        const { AutopilotStore } = require('../frontend/app/autopilotstore.js');
        const at = 1e6;
        const beliefs = { goals: [{ text: 'ship the StarNet beta to 100 users', updatedAt: at }], pain: [{ text: 'manual release notes eat my fridays', updatedAt: at }],
          stack: [{ text: 'node and plain js', updatedAt: at }], identity: [{ text: 'andro, solo builder', updatedAt: at }] };
        const PROPOSE = 'JOB: Beta launch checklist\nKIND: advance-goal\nGROUNDS: ship the StarNet beta to 100 users\nCONFIDENCE: high\nSPEC: a pre-launch checklist';
        const chatWith = (doReply, reviewReply) => async ({ messages }) => {
          const c = messages[0].content;
          if (/Propose up to/.test(c)) return { text: PROPOSE, outcome: 'succeeded' };
          if (/Do this ONE job/.test(c)) return doReply;
          if (/SELF-REVIEW/.test(c)) return reviewReply;
          return { text: '' };
        };
        const actWith = async chat => {
          presented = []; writes = [];
          AutopilotStore.init({ install: false, now: () => at, getPosture: () => ({ enabled: true, actsUnattended: true, leashPerDay: 5 }),
            getDossier: () => ({ known: ['goals', 'stack', 'pain', 'identity'], blank: [], familiarity: 4 / 7 }), getBeliefs: d => beliefs[d] || [],
            getSystem: () => 'S', getName: () => 'NOVA', offerCuriosity: () => true, chat, present: d => presented.push(d), idleMs: 120000,
            canWriteFiles: () => true, hasCabinet: () => true, writeFile: async o => { writes.push(o.path); return { ok: true, path: o.path }; } });
          AutopilotStore.reset();
          const r = await AutopilotStore.act();
          return { delivered: r.delivered, reason: r.reason || null, presented: presented.length, body: presented[0] ? presented[0].body : null, writes: writes.length };
        };
        const FULL = { text: 'TITLE: Beta launch checklist\n1. Freeze the build\n2. Tag the release\n3. Smoke test', outcome: 'succeeded' };
        const SHIP = { text: 'VERDICT: ship\nNOTE: solid', outcome: 'succeeded' };
        got = {
          cutDraft: await actWith(chatWith({ text: 'TITLE: Beta launch checklist\n1. Freeze the build\n2. Tag the rel', outcome: 'cut_short', finishReason: 'length', endReason: 'done' }, SHIP)),
          stoppedDraft: await actWith(chatWith({ text: 'TITLE: Beta launch checklist\n1. Freeze', outcome: 'stopped', endReason: 'cancelled' }, SHIP)),
          cutReview: await actWith(chatWith(FULL, { text: 'VERDICT: revise\nREVISED:\nTITLE: Beta launch checklist\n1. Fre', outcome: 'cut_short', finishReason: 'length' })),
          stoppedReview: await actWith(chatWith(FULL, { text: 'VERDICT: sh', outcome: 'stopped' })),
          clean: await actWith(chatWith(FULL, SHIP))
        };
      } catch (e) { got = { threw: String((e && e.stack) || e).slice(0, 300) }; }
      finally { global.Autopilot = savedAutopilot; }
      const stoodDown = (r, why) => !!r && r.delivered === false && r.reason === why && r.presented === 0 && r.writes === 0;
      A.ok(!!got && stoodDown(got.cutDraft, 'not-done') && stoodDown(got.stoppedDraft, 'stopped') && stoodDown(got.cutReview, 'not-done') && stoodDown(got.stoppedReview, 'stopped')
        && got.clean && got.clean.delivered === true && got.clean.presented === 1 && /3\. Smoke test/.test(String(got.clean.body)) && got.clean.writes === 1,
        'review 7.1: the page autopilot takes a reply only when its run SUCCEEDED — a cut or stopped draft or review is never a desk draft or a file, and an unfinished review is never \'ship\' (got ' + JSON.stringify(got) + ')');
    }

    // 23. THE SESSION STARTERS (frontend/app/starterstore.js request, the real module; review 7.1, CHAT_RECEIVER): a generation the provider cut
    //     was parsed as the session's idea list on its error flag alone
    {
      let got = null;
      try {
        const S = require('../frontend/app/starters.js'), { StarterStore: Store } = require('../frontend/app/starterstore.js');
        let time = 1800000000000;
        const memory = {}, storage = { getItem: k => memory[k] || null, setItem: (k, v) => { memory[k] = v; }, removeItem: k => { delete memory[k]; } };
        const ctx = S.context({ now: time, agentId: 'agent', goal: { id: 'g', text: 'Build a usable revenue dashboard for my subscription product', status: 'active' } });
        const row = { title: 'Build the subscription revenue dashboard', why: 'Your active goal is a usable revenue dashboard for your subscription product.', deliverable: 'A working revenue dashboard with tested calculations.', prompt: 'Build a revenue dashboard for the subscription product. Inspect the existing project, implement the main workflow, and test the calculations before reporting the result.', sourceIds: ['goal:g'], kind: 'build', sessionId: null, requiredCapabilities: [] };
        let reply = null;
        Store.init({ engine: S, storage, now: () => time, enabled: () => true, generate: async () => reply, fetch: async () => ({ ok: true }) });
        Store.reset();
        const ask = async r => { reply = r; time += Store.GAP + 1; const out = await Store.request(ctx, { force: true }); return { status: out.status, ideas: (out.ideas || []).length }; };
        got = {
          cut: await ask({ text: JSON.stringify({ suggestions: [row] }), outcome: 'cut_short', finishReason: 'length' }),
          stopped: await ask({ text: JSON.stringify({ suggestions: [row] }), outcome: 'stopped' }),
          clean: await ask({ text: JSON.stringify({ suggestions: [row] }), outcome: 'succeeded' })
        };
        Store.reset();
      } catch (e) { got = { threw: String((e && e.message) || e) }; }
      A.ok(!!got && got.cut && got.cut.status === 'error' && got.cut.ideas === 0 && got.stopped.status === 'error' && got.stopped.ideas === 0 && got.clean.status === 'ready' && got.clean.ideas === 1,
        'review 7.1: the session starters take a generation only when its run SUCCEEDED — a cut or stopped reply is no idea list (got ' + JSON.stringify(got) + ')');
    }

    // 24. THE NIGHT SHIFT'S REVIEW (sidecar/index.js: nightshiftChat sliced whole over a stand-in runOnce, and runNightshiftBeat's critique step
    //     sliced; review 7.1): nightshiftChat already resolved an unfinished reply as { error }, but the beat's critique read any error as "no review"
    //     and shipped the draft as if reviewed — a review the provider cut, or a STOP / E-STOP mid-review, still recorded and announced a draft.
    //     It stands down now; a review whose run RAISED an error ships the finished draft unreviewed, as before
    {
      let got = null;
      try {
        const chatSrc = sidecarTopLevelFunction('nightshiftChat');
        const ends = { cut: { reason: 'done', finishReason: 'length' }, stopped: { reason: 'cancelled' }, done: { reason: 'done', finishReason: 'stop' } };
        // (channel-delivery-ledger: nightshiftChat joins its reply through the one assembler, sidecar/reply-assembler.js)
        const { makeReplyAssembler } = require('../sidecar/reply-assembler.js');
        const chatOf = kind => new Function('NIGHTSHIFT_AGENT', 'cronIdentityFor', 'cronProviderFor', 'cronKeyFor', 'cronModelFor', 'cronHasCredential', 'crypto', 'runTable', 'runOnce', 'PromptScrub', 'cronSystemFor', 'RunOutcome', 'makeReplyAssembler',
          chatSrc + '\nreturn nightshiftChat;')('agent', () => ({}), () => 'openrouter', () => 'sk', () => 'test/model', () => true, { randomUUID: () => 'ns-r' }, require('../sidecar/run-table.js').makeRunTable(),
          async o => { if (kind === 'raised') { o.emit('agent.run.error', { runId: o.runId, message: 'rate limited' }); o.emit('agent.run.end', { runId: o.runId, reason: 'error' }); return; }
            o.emit('agent.token', { runId: o.runId, delta: 'VERDICT: sh' }); o.emit('agent.run.end', Object.assign({ runId: o.runId }, ends[kind])); },
          { scrubStored: s => s }, () => 'SYS', RunOutcome, makeReplyAssembler);
        const beatSrc = sidecarTopLevelFunction('runNightshiftBeat');
        const from = beatSrc.indexOf('  const qRes = await nightshiftChat('), to = beatSrc.indexOf("  if (crit.verdict === 'revise' && crit.revised) deliverable = crit.revised;");
        const step = from >= 0 && to > from ? beatSrc.slice(from, to) : '';
        const review = new Function('nightshiftChat', 'Autopilot', 'deliverable', 'sel', 'style', 'standingOrders', 'agentId', 'system', 'signal', 'opts',
          'return (async () => {\n' + step + '\nreturn { delivered: \'ships\', verdict: crit.verdict };\n})();');
        const Autopilot = require('../frontend/app/autopilot.js');
        const run = async kind => {
          const r = await review(chatOf(kind), Autopilot, { title: 'Beta launch checklist', body: '1. Freeze the build' }, { selected: { title: 'Beta launch checklist' } }, '', '', 'agent', 'S', undefined, {});
          return { delivered: r.delivered, reason: r.reason ? String(r.reason).slice(0, 60) : null };
        };
        got = { sliced: !!step, cut: await run('cut'), stopped: await run('stopped'), raised: await run('raised') };
      } catch (e) { got = { threw: String((e && e.message) || e) }; }
      A.ok(!!got && got.sliced && got.cut.delivered === false && /without completion/.test(String(got.cut.reason)) && got.stopped.delivered === false && /without completion/.test(String(got.stopped.reason))
        && got.raised.delivered === 'ships',
        'review 7.1: the night shift never ships a draft whose review was cut or stopped; a review that raised an error ships it unreviewed, as before (got ' + JSON.stringify(got) + ')');
    }

    // 25. THE PAGE'S WIRE PREFLIGHT (frontend/app/app.js preflightWire, sliced whole over a stand-in Harness; review 7.2, the RELAY and the BARE
    //     GATE): the awakening's one real "Reply with exactly: OK" round trip gated on `res.error || !text` alone, and Harness.chat hands back a
    //     reply the provider cut, a limit or a STOP ended, or a filter refused as { text, outcome } with no error — so a cut, stopped,
    //     budget-ended or refused "OK" passed the wire and the awakening began on it. The terminal's wire test (bin/lib/awaken.js) refused it
    {
      let got = null;
      try {
        const appSrc = fs.readFileSync(path.join(ROOT, 'frontend/app/app.js'), 'utf8');
        const from = appSrc.indexOf('  async function preflightWire() {'), to = from >= 0 ? appSrc.indexOf('\n  }\n', from) : -1;
        const fnSrc = from >= 0 && to > from ? appSrc.slice(from, to + 4) : '';
        let reply = null;
        const Harness = { chat: async () => reply };
        // the 30-second stall timer never fires here: every stand-in reply settles first, and the fold leaves no timer behind
        const preflight = new Function('Harness', 'RunOutcome', 'setTimeout', fnSrc + '\nreturn preflightWire;')(Harness, RunOutcome, () => 0);
        const wire = async r => { reply = r; return preflight(); };
        got = {
          sliced: !!fnSrc,
          cut: await wire({ text: 'OK', outcome: 'cut_short', finishReason: 'length' }),
          stopped: await wire({ text: 'OK', outcome: 'stopped' }),
          budget: await wire({ text: 'OK', outcome: 'out_of_budget' }),
          refused: await wire({ text: 'OK', outcome: 'refused' }),
          raised: await wire({ text: '', error: 'Your OpenRouter balance is empty.', outcome: 'failed' }),
          clean: await wire({ text: 'OK', outcome: 'succeeded' }),
          older: await wire({ text: 'OK', outcome: '' })
        };
      } catch (e) { got = { threw: String((e && e.message) || e) }; }
      const closed = (r, words) => !!r && r.ok === false && words.test(String(r.why));
      A.ok(!!got && got.sliced && closed(got.cut, /did not finish: the reply was cut short/) && closed(got.stopped, /did not finish: stopped before it finished/)
        && closed(got.budget, /did not finish: hit a spending limit/) && closed(got.refused, /did not finish: the model declined/)
        && closed(got.raised, /balance is empty/) && got.clean && got.clean.ok === true && got.older && got.older.ok === true,
        'review 7.2: the page\'s wire preflight passes only a reply whose run SUCCEEDED — a cut, stopped, budget-ended or refused "OK" closes the wire with the outcome\'s words, as the terminal\'s wire test does (got ' + JSON.stringify(got) + ')');
    }
  }

  // ===================== review r8: THE OUTCOME TABLE — every outcome keeps its own word and colour (behavioural) =====================
  // THE FAMILY LAW, per outcome: a stop is never reported or counted as a failure (nor a success); a question ('asked') is never STOPPED and never
  // failed; a failure is never a stop; a cut reply, a spend or step limit, an empty reply and a refusal each keep their own word; and a reply or row
  // with no terminal outcome is never a success. Each fold drives the surface's real code (a module, or the function sliced from the page, the
  // terminal or the sidecar) over the outcomes and checks the law on its words and tones.
  {
    const { functionSourceIn } = require('./helpers/source.js');
    const read8 = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const sidecarRead8 = rel => (sidecarSourceFiles().find(f => f.rel.replace(/\\/g, '/') === rel) || {}).text || '';   // the sidecar's, through the source helper
    const ENDS = {
      succeeded: { reason: 'done', outcome: 'succeeded' }, asked: { reason: 'clarifying', outcome: 'asked' }, stopped: { reason: 'cancelled', outcome: 'stopped' },
      cut_short: { reason: 'done', finishReason: 'length', outcome: 'cut_short' }, out_of_budget: { reason: 'budget', outcome: 'out_of_budget' },
      step_limit: { reason: 'max_iters', outcome: 'step_limit' }, empty: { reason: 'empty', outcome: 'empty' },
      refused: { reason: 'refusal', outcome: 'refused', failureCode: 'content_policy_blocked' }, failed: { reason: 'error', outcome: 'failed', failureCode: 'rate_limit' }
    };
    const law = (where, said, opts) => {   // said: outcome -> { word, tone }; tones: 'bad' (failure) · 'stop' · 'ask' · …
      const o = opts || {};
      const bad = [];
      const failTone = o.failTone || 'bad', stopTone = o.stopTone;
      if (said.stopped && said.stopped.tone === failTone) bad.push('a stop in the failure tone');
      if (said.stopped && /fail/i.test(said.stopped.word)) bad.push('a stop worded as a failure');
      if (said.asked && (/stop|fail|error/i.test(said.asked.word) || said.asked.tone === failTone || (stopTone && said.asked.tone === stopTone))) bad.push('a question worded or toned as a stop / failure (' + JSON.stringify(said.asked) + ')');
      if (said.failed && (/\bstop/i.test(said.failed.word) || (stopTone && said.failed.tone === stopTone))) bad.push('a failure worded or toned as a stop (' + JSON.stringify(said.failed) + ')');
      for (const k of ['cut_short', 'out_of_budget', 'step_limit', 'empty', 'refused', 'blocked']) if (said[k] && (said[k].tone === failTone || /\bfail/i.test(said[k].word))) bad.push(k + ' folded into failed (' + JSON.stringify(said[k]) + ')');
      // review 9.3: and never the STOP's — a spend cap said "stopped at a spending limit" (RunOutcome.PHRASE, the phone push, the HUD toast) and
      // passed, because this law read an unfinished outcome only against the failure; the stop's word and tone are the stop's alone
      for (const k of ['cut_short', 'out_of_budget', 'step_limit', 'empty', 'refused', 'blocked']) if (said[k] && (/\bstop/i.test(said[k].word) || (stopTone && said[k].tone === stopTone))) bad.push(k + ' worded or toned as a stop (' + JSON.stringify(said[k]) + ')');
      // review 9: an INTERRUPTED run (a restart, the liveness check) is its own outcome — never the failure's tone, never the stop's word or tone
      if (said.interrupted && (said.interrupted.tone === failTone || /^[^A-Za-z]*(?:stop|fail)/i.test(said.interrupted.word) || (stopTone && said.interrupted.tone === stopTone))) bad.push('an interruption worded or toned as a stop / failure (' + JSON.stringify(said.interrupted) + ')');
      const words =Object.entries(said).map(([k, v]) => [k, v.word]);
      for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) if (words[i][1] === words[j][1]) bad.push(words[i][0] + ' and ' + words[j][0] + ' share one word "' + words[i][1] + '"');
      A.ok(bad.length === 0, 'review r8: ' + where + ' — each outcome its own word and tone (' + bad.join('; ') + ') (got ' + JSON.stringify(said) + ')');
    };
    /* review 9: COMMS' PRESENCE CARD as the page draws it — its word and classes from the card's own decision (chat.js PRESENCE_END + presenceLook),
       its COLOUR from each stylesheet's cascade: the last `.resolved.<classes>` colour rule (every one the same specificity) whose classes the card
       carries. (The tip before review 9 decided inline in resolvePresence; that region is read the same way, so a fold fails there on what the
       card SAID, never on a missing name.) */
    const presenceCard = (() => {
      const chat = fs.readFileSync(path.join(ROOT, 'frontend/app/chat.js'), 'utf8');
      const t0 = chat.indexOf('  const PRESENCE_END = '), t1 = chat.indexOf('  function presenceLook(');
      const fn = functionSourceIn(chat, 'presenceLook');
      let decide = null;
      if (t0 >= 0 && t1 > t0 && fn) {
        const pl = new Function('RunOutcome', chat.slice(t0, t1) + fn + '\nreturn presenceLook;')(RunOutcome);
        decide = o => { const l = pl(o); return { word: l.word, classes: ['resolved', l.cls, 'tone-' + l.tone] }; };
      } else {
        const from = chat.indexOf('    const isErr = !!opts.error, needsVerify'), to = from < 0 ? -1 : chat.indexOf('\n', chat.indexOf('    let label = isErr ?', from));
        const legacy = from >= 0 && to > from ? new Function('opts', 'card', 'RunOutcome', chat.slice(from, to) + '\nreturn label;') : null;
        if (legacy) decide = o => { const classes = []; const word = legacy(o, { classList: { add: (...c) => classes.push(...c) } }, RunOutcome); return { word, classes }; };
      }
      const sheets = ['frontend/css/comms.css', 'frontend/css/comms-convo.css', 'frontend/css/pipglass.css'].map(rel => {
        const css = fs.readFileSync(path.join(ROOT, rel), 'utf8'), rules = [];
        const RULE = /(?:#comms-presence|\.comms-presence)\.resolved((?:\.[\w-]+)+)\s*\{([^}]*)\}/g;
        for (let m = RULE.exec(css); m; m = RULE.exec(css)) { const c = /(?:^|;)\s*color:\s*([^;]+)/.exec(m[2]); if (c) rules.push({ cls: m[1].slice(1).split('.'), color: c[1].trim() }); }
        return { rel, rules: rules.filter(r => !r.cls.some(c => c === 'has-fold' || c === 'open')) };
      });
      const colourIn = (sheet, classes) => { let c = 'default'; for (const r of sheet.rules) if (r.cls.every(x => classes.includes(x))) c = r.color; return c; };
      return decide ? { decide, sheets, colourIn } : null;
    })();

    // r8.1 THE TERMINAL'S CHAT (bin/lib/station-io.js, over a loopback station; review 7.3 major): a reply with NO terminal outcome resolved { text } —
    //      a stall past the time limit after one token, a stream that ended with no agent.run.end — and the awakening's wire test passed a dead wire;
    //      an unfinished end with no text was worded "the run ended: <reason>" with no outcome
    {
      const http = require('http');
      const { makeStationIO } = require('../bin/lib/station-io.js');
      let mode = 'stall';
      const srv = http.createServer((req, res) => {
        req.resume(); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          if (mode !== 'budget') res.write(JSON.stringify({ name: 'agent.token', payload: { delta: 'O' } }) + '\n');
          if (mode === 'noend') res.end();
          else if (mode === 'budget') res.end(JSON.stringify({ name: 'agent.run.end', payload: { reason: 'budget', outcome: 'out_of_budget' } }) + '\n');
          else if (mode === 'clean') res.end(JSON.stringify({ name: 'agent.run.end', payload: { reason: 'done', outcome: 'succeeded' } }) + '\n');
        });
      });
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      const io = makeStationIO({ host: '127.0.0.1', port, base: 'http://127.0.0.1:' + port, token: () => 't', request: async () => ({}) });
      const stall = await io.chat({ directive: 'x', ms: 300 });
      mode = 'noend'; const noend = await io.chat({ directive: 'x', ms: 5000 });
      mode = 'budget'; const budget = await io.chat({ directive: 'x', ms: 5000 });
      mode = 'clean'; const clean = await io.chat({ directive: 'x', ms: 5000 });
      srv.closeAllConnections && srv.closeAllConnections(); await new Promise(r => srv.close(r));
      A.ok(!!stall.error && stall.outcome === 'failed' && stall.failureCode === RunOutcome.NO_TERMINAL && !!noend.error && noend.outcome === 'failed'
        && budget.error === 'the reply did not finish: hit a spending limit' && budget.outcome === 'out_of_budget' && !clean.error && clean.text === 'O',
        'review r8: the terminal\'s chat never takes a reply with no terminal outcome for a finished one (a stall, an end-less stream), and words every unfinished end by its outcome, text or no text (got ' + JSON.stringify({ stall, noend, budget, clean }) + ')');
    }

    // r8.2 THE WIRE TEST'S HEADLINE (frontend/app/app.js and bin/lib/awaken.js wireTestLine, sliced; review 7.3 minor + nit): a STOP or a spending
    //      limit read "your model didn't answer … dead wire"; the page's preflight carries the outcome; Harness.chat's no-error reply its failureCode
    {
      // the page's headline lines are onWakeAttempt's own (sliced from the first outcome branch through the dead-wire line); the terminal's twin
      // is awaken.js wireTestLine
      const appWake = read8('frontend/app/app.js');
      const pFrom = appWake.indexOf("      if (wire.outcome === 'stopped') {"), pTo = pFrom >= 0 ? appWake.indexOf('\n', appWake.indexOf("msg.textContent = 'your model didn’t answer'", pFrom)) : -1;
      const page = pFrom >= 0 && pTo > pFrom ? appWake.slice(pFrom, pTo) : '', term = functionSourceIn(read8('bin/lib/awaken.js'), 'wireTestLine');
      const pageRun = page ? new Function('wire', 'msg', 'wireVia', page + '\nreturn false;') : null;
      const pageLine = pageRun ? (why, outcome) => { const msg = { textContent: '' }; pageRun({ why, outcome }, msg, ''); return msg.textContent; } : null;
      const termLine = term ? new Function(term + '\nreturn wireTestLine;')() : null;
      const W = 'the reply did not finish: stopped before it finished';
      const got = pageLine && termLine ? { stopped: [pageLine(W, 'stopped'), termLine(W, 'stopped')], budget: [pageLine('x', 'out_of_budget'), termLine('x', 'out_of_budget')],
        cut: [pageLine('the reply did not finish: the reply was cut short', 'cut_short'), termLine('the reply did not finish: the reply was cut short', 'cut_short')], dead: [pageLine('provider 500', 'failed'), termLine('provider 500', '')] } : null;
      const twins = got && Object.values(got).every(([p, t]) => p.replace(/WAKE again/g, 'try again').replace(/ \(via [^)]*\)/, '') === t);
      A.ok(!!got && twins && got.stopped.every(s => !/didn.t answer|dead wire/.test(s) && /stopped before it finished/.test(s)) && got.budget.every(s => /spending limit/.test(s) && !/didn.t answer/.test(s))
        && got.cut.every(s => /did not finish/.test(s) && !/didn.t answer/.test(s)) && got.dead.every(s => /didn.t answer/.test(s) && /dead wire/.test(s)),
        'review r8: the wire test says a stop, a spending limit and an unfinished "OK" as themselves — "your model didn\'t answer" only for a dead wire — the page and the terminal word for word (got ' + JSON.stringify(got) + ')');
      const appSrc = read8('frontend/app/app.js');
      const from = appSrc.indexOf('  async function preflightWire() {'), to = from >= 0 ? appSrc.indexOf('\n  }\n', from) : -1;
      let reply = null;
      const preflight = from >= 0 ? new Function('Harness', 'RunOutcome', 'setTimeout', appSrc.slice(from, to + 4) + '\nreturn preflightWire;')({ chat: async () => reply }, RunOutcome, () => 0) : null;
      reply = { text: 'OK', outcome: 'refused', errorCode: 'content_policy_blocked' };
      const refused = preflight ? await preflight() : null;
      A.ok(!!refused && refused.ok === false && refused.outcome === 'refused' && /content_policy_blocked/.test(refused.why)
        && /return \{ text: full, usage: lastUsage, runId, errorCode, outcome, endReason/.test(read8('frontend/app/harness.js')),
        'review r8: the page\'s preflight carries the unfinished reply\'s outcome and its failureCode (Harness.chat\'s no-error reply carries errorCode: the code read was dead) (got ' + JSON.stringify(refused) + ')');
    }

    // r8.3 THE TERMINAL'S CREW CARD (bin/lib/station-model.js statusOf / endRun / nowOf + bin/lib/tui.js lampOf · stateWords · tagOf + the floor
    //      plate; review 7.3 major): every unsuccessful end was key 'stopped' in the failure colour — a failure read "■ stopped", a stop the red
    //      of a crash, a question "■ stopped · clarifying" in red; endRun logged a question in red; the NOW text printed the bare reason word
    {
      const { makeStation } = require('../bin/lib/station-model.js');
      const tui = require('../bin/lib/tui.js');
      const camfeed = require('../bin/lib/camfeed.js');
      const { makeFloor } = require('../bin/lib/floor.js');
      const fl = makeFloor(camfeed.makeCamFeed());
      const TERM_TONE = { bad: 'bad', dim: 'stop', am: 'warn' };
      const card = {}, logs = {}, nows = {}, plates = {};
      for (const [k, e] of Object.entries(ENDS)) {
        const st = makeStation();
        st.setRoster({ agents: [{ agentId: 'agent', name: 'A', model: 'm' }] });
        st.apply('agent.run.start', { runId: 'r1', agentId: 'agent' }, 1000);
        st.apply('agent.run.end', Object.assign({ runId: 'r1', agentId: 'agent' }, e), 2000);
        const row = st.rows(2500)[0];
        const w = tui.stateWords(row.status, 2500, true), lamp = (tui.tagOf ? tui.tagOf(row.status, 2500) : null) || ['', ''];
        if (k !== 'succeeded') card[k] = { word: w[0] + (w[2] ? ' · ' + w[2] : ''), tone: k === 'asked' && w[1] === 'am' ? 'ask' : (TERM_TONE[w[1]] || w[1]), tag: lamp[0] + '|' + lamp[1] };
        const end = st.logOf('agent').filter(x => x.k !== 'start').pop();
        if (k !== 'succeeded') logs[k] = { word: end ? end.text : '(none)', tone: end ? ({ bad: 'bad', sys: 'stop', warn: 'warn' }[end.k] || end.k) : '' };
        nows[k] = st.rows(20000)[0].now;
        const pw = fl._stateWord ? fl._stateWord({ key: row.status.key, text: row.status.text }) : [['', '']];
        if (k !== 'succeeded') plates[k] = { word: pw[0][0], tone: { bad: 'bad', dim: 'stop', am: 'warn', 'am b': 'ask' }[pw[0][1]] || pw[0][1] };
      }
      law('the terminal crew card (statusOf + tui.stateWords)', card, { stopTone: 'stop' });
      law('the conversation\'s end line (endRun)', logs, { stopTone: 'stop' });
      law('the FLOOR name plate (floor.js stateWord over statusOf)', plates, { stopTone: 'stop' });
      A.ok(nows.failed === 'last run: failed (rate_limit)' && nows.stopped === 'last run: stopped before it finished' && nows.asked === 'last run: asked a question',
        'review r8: the crew card\'s NOW text says the last run in its outcome\'s words, its failureCode included — never the bare end word (got ' + JSON.stringify(nows) + ')');
    }

    // r8.4 THE TERMINAL FLOOR'S FLIGHTS (bin/lib/floor.js observe; review r8 sweep): every end but done / cancelled flew back as a red 'failed' flight,
    //      and the flight read the agent's LAST end, so two runs of one worker ending before a paint both flew with the later one's outcome
    {
      const camfeed = require('../bin/lib/camfeed.js');
      const { makeFloor } = require('../bin/lib/floor.js');
      const fl = makeFloor(camfeed.makeCamFeed());
      const ended = { wa: ENDS.asked, wb: ENDS.out_of_budget, wf: ENDS.failed, ws: ENDS.stopped, wc: ENDS.cut_short };
      const runs = new Map([['L', { runId: 'L', agentId: 'lead' }]]);
      for (const id of Object.keys(ended)) runs.set(id, { runId: id, agentId: 'worker', parentRunId: 'L' });
      fl.observe(runs, x => String(x).toUpperCase(), () => null, 1);
      for (const id of Object.keys(ended)) runs.delete(id);
      fl.observe(runs, x => String(x).toUpperCase(), runId => ended[runId] || null, 2);   // each run's OWN end (station-model endOf)
      const back = fl.log().filter(x => !/team\.dispatch/.test(x.text)).map(x => ({ word: x.text.replace(/^WORKER → LEAD\s+/, ''), tone: { bad: 'bad', fg: 'stop', am: 'warn' }[x.style] || x.style }));
      const said = {}; Object.keys(ended).forEach((id, i) => { said[ended[id].outcome] = back[i] || { word: '(none)', tone: '' }; });
      law('the terminal floor\'s flights back to the lead', said, { stopTone: 'stop' });
    }

    // r8.5 THE TERMINAL FLOWS strip and WORK page (bin/lib/station-model.js flows + tui.js): a job that finished with a problem and a stopped job
    //      read the idle ○ of a line that never ran, an interrupted one the failure ✗; the text printed the raw record word ("problem · 2m ago")
    {
      const { makeStation } = require('../bin/lib/station-model.js');
      const look = {};
      for (const status of ['problem', 'stopped', 'interrupted', 'failed', 'delivered']) {
        const st = makeStation();
        st.applyLines({ lines: [{ lineId: 'L1', name: 'Support' }] }, [{ id: 'j1', line: 'L1', status, startedAt: 1000, endedAt: 2000 }]);
        const f = st.flows(130000)[0] || {};
        look[status] = { lamp: f.lamp, style: f.lampStyle, text: f.text };
      }
      A.ok(look.problem.lamp !== '○' && look.problem.style === 'am' && /finished with a problem/.test(look.problem.text) && look.stopped.lamp === '■' && look.stopped.style === 'dim'
        && look.interrupted.style !== 'bad' && look.delivered.lamp === '✓' && !/^problem/.test(look.problem.text),
        'review r8: the FLOWS strip lamps each line job status as itself — a problem is no idle line, a stop the plain ■, an interruption no failure (got ' + JSON.stringify(look) + ')');
    }

    // r8.6 THE TERMINAL /goal PAUSE (bin/lib/dashboard.js goalStallOf, sliced): every unsuccessful step paused "the step stopped (<raw reason>)" —
    //      "the step stopped (clarifying)" for a question, "(error)" with no failureCode for a rate limit
    {
      const src = functionSourceIn(read8('bin/lib/dashboard.js'), 'goalStallOf');
      const stall = src ? new Function('RunOutcome', src + '\nreturn goalStallOf;')(RunOutcome) : null;
      const said = {};
      if (stall) for (const [k, e] of Object.entries(ENDS)) if (k !== 'succeeded') said[k] = { word: stall(RunOutcome.ofEnd(e, null)), tone: '' };
      A.ok(!!stall && /asked you a question/.test(said.asked.word) && /rate_limit/.test(said.failed.word) && !/stopped \(/.test(JSON.stringify(said)), 'review r8: the /goal pause words each step by its outcome — a question is no stop, a failure names its code (got ' + JSON.stringify(said) + ')');
      if (stall) law('the terminal /goal pause', said);
    }

    // r8.7 THE TERMINAL'S RECEIPTS (bin/lib/station-commands.js + cli-core.js): `starnet flow run` on a job someone STOPPED printed "did not deliver"
    //      and exited 1 ("1 run failed"); `starnet watch` printed "■ error" with no code where `starnet -p` says "failed (rate_limit)"; the help
    //      called code 5 "stopped early" while a stop exits 4
    {
      const { flowCommand, makeWatchFormatter } = require('../bin/lib/station-commands.js');
      const core = require('../bin/lib/cli-core.js');
      const err = [], outw = [];
      const client = { request: async (method, p) => p === '/api/routing/lines/stats' ? { ok: true, status: 200, json: { lines: [{ lineId: 'L1', name: 'support' }] } }
        : p.indexOf('/api/line-jobs') === 0 ? { ok: true, status: 200, json: { jobs: [] } }
        : { ok: true, status: 502, json: { ok: false, stopped: true, error: 'stopped — you stopped this job before it reached the OUTBOX' } } };
      let code = null;
      try { code = await flowCommand({ args: ['run', 'L1', 'triage'], json: false }, { client }, { err: t => err.push(t), out: t => outw.push(t) }); } catch (e) { err.push('threw ' + (e && e.message)); }
      const fmt = makeWatchFormatter({ agent: 'NOVA' });
      const watched = fmt({ name: 'agent.run.end', payload: { runId: 'r', agentId: 'nova', reason: 'error', outcome: 'failed', failureCode: 'rate_limit' } }, 0).join(' ');
      A.ok(code === core.EXIT.CANCELLED && /was stopped/.test(err.join('')) && !/did not deliver/.test(err.join('')) && /failed \(rate_limit\)/.test(watched)
        && /4 stopped/.test(core.USAGE) && /5 did not finish/.test(core.USAGE) && !/stopped early/.test(core.USAGE),
        'review r8: a stopped line job exits as a stop and says so; `starnet watch` words a failed end as `starnet -p` does; the help never calls an unfinished run "stopped early" (got ' + JSON.stringify({ code, err, watched }) + ')');
      const dash = read8('bin/lib/dashboard.js');
      const fs8 = functionSourceIn(dash, 'flowStopped');
      A.ok(!!fs8 && new Function(fs8 + '\nreturn flowStopped;')()({ json: { ok: false, stopped: true } }) === true && /else if \(flowStopped\(r\)\) flash\('■ '/.test(dash),
        'review r8: the dashboard\'s /flow run flashes a stopped job as a stop, never the failure flash');
    }

    // r8.8 THE TASK BOARD (chat.js's run-end verdict lines + noteStopReason, sliced; stationui.js stateChip / activeAggregate / boardEnd, sliced;
    //      review 7.3 major + r8 sweep): a run that ASKED read "■ STOPPED — REVIEW", a cut reply "✗ RUN FAILED — REVIEW" (and the rail's "last
    //      run failed"), a refusal, a limit and an end-only failure STOPPED; a run with no recorded outcome FINISHED
    {
      const chat = read8('frontend/app/chat.js'), ui = read8('frontend/app/stationui.js');
      const at = Math.min(...['const chipOc = ', 'const chipOk = '].map(k => chat.indexOf(k)).filter(i => i >= 0));
      const endAt = chat.indexOf('\n', chat.indexOf('Workstreams.noteRunEnd(ws.id, thisRunId, chipOk', at));
      const verdictSrc = at >= 0 && endAt > at ? chat.slice(at, endAt) : '';
      const stopSrc = functionSourceIn(chat, 'noteStopReason');
      const W = require('../frontend/app/workstreams.js');
      const chipFns = ['boardEnd', 'stateChip', 'activeAggregate'].map(n => functionSourceIn(ui, n)).filter(Boolean).join('\n');
      const board = new Function('Channels', 'RunOutcome', chipFns + '\nreturn { stateChip, activeAggregate };')({ isBusy: () => false }, RunOutcome);
      const verdict = verdictSrc ? new Function('runOutcome', 'endReason', 'finishReason', 'thisRunId', 'ws', 'Workstreams', 'RunOutcome', verdictSrc) : null;
      const noteStop = stopSrc ? new Function('Workstreams', 'RunOutcome', stopSrc + '\nreturn noteStopReason;')(W, RunOutcome) : null;
      const said = {}, rows = {};
      for (const [k, e] of Object.entries(ENDS)) {
        W.reset();
        const ws = W.create('t-' + k, { kind: 'task', activate: false });
        W.appendRun(ws.id, 'r-' + k, 1);
        const s = W.get(ws.id); s.lane = 'active';
        const end = Object.assign({}, e); if (k === 'failed') delete end.failureCode;   // an END-ONLY failure: reason 'error', no agent.run.error
        if (verdict) verdict(end.outcome, end.reason, end.finishReason, 'r-' + k, s, W, RunOutcome);
        if (noteStop && end.reason !== 'done' && end.reason !== 'clarifying') noteStop(s, 'stop line', 'r-' + k, end.reason);
        const chip = board.stateChip(s).replace(/<[^>]+>/g, '');
        rows[k] = { lastRunOk: s.lastRunOk, chip, head: board.activeAggregate([s]).replace(/<[^>]+>/g, '') };
        if (k !== 'succeeded') said[k] = { word: chip, tone: /FAILED/.test(chip) ? 'bad' : /STOPPED/.test(chip) ? 'stop' : 'other' };
      }
      W.reset();
      const legacy = W.create('legacy', { kind: 'task', activate: false }); W.appendRun(legacy.id, 'r-old', 1); W.get(legacy.id).lane = 'active';
      const legacyChip = board.stateChip(W.get(legacy.id)).replace(/<[^>]+>/g, '');
      law('the task board chip', said);
      A.ok(!!verdict && !!noteStop && /ASKED/.test(rows.asked.chip) && /1 ASKED/.test(rows.asked.head) && /STOPPED/.test(rows.stopped.chip) && /FINISHED/.test(rows.succeeded.chip)
        && rows.cut_short.lastRunOk !== false && rows.failed.lastRunOk === false && /FAILED/.test(rows.failed.chip) && !/FINISHED/.test(legacyChip),
        'review r8: the board says each run\'s outcome — a question ASKED, a cut reply or a limit its own state (never FAILED, never the rail\'s "last run failed"), only a failure FAILED, a run with no recorded outcome never FINISHED (got ' + JSON.stringify({ rows, legacyChip }) + ')');
      W.reset();
    }

    // r8.9 THE DELEGATED CARD (frontend/app/delegated.js stateOf / lineHtml; review r8 sweep): a worker someone stopped through the ledger
    //      (subagents.interrupt: { status: 'interrupted', reason: 'interrupted' }; cancelChildren: reason 'cancelled: its parent run … was cancelled')
    //      read red with a failed batch lamp; a budget-ended worker was "1 stopped" in red
    {
      const saved = { Channels: global.Channels, Overseer: global.Overseer, App: global.App, document: global.document };
      global.Channels = { pendingOf: () => null, pendingAllOf: () => [], isBusy: () => false, elapsedOf: () => NaN, runIdOf: () => '' };
      global.Overseer = { snapshot: () => ({ workers: [], threads: [] }), fresh: () => true };
      global.App = { agentName: id => id };
      global.document = undefined;
      require('./helpers/frontend-esc.js').installEsc();
      try {
        const D = require('../frontend/app/delegated.js');
        const ws = o => Object.assign({ id: 'k', history: [], runIds: ['r'] }, o);
        const got = {};
        for (const [name, rec] of Object.entries({ ownStop: { status: 'interrupted', reason: 'interrupted' }, leadStop: { status: 'interrupted', reason: 'cancelled: its parent run L was cancelled' }, budget: { status: 'error', reason: 'budget' } })) {
          const w = Object.assign({ id: 'w-' + name, runId: 'r', agentId: 'c', leadId: 'agent' }, rec);
          D._internals.opened.add('b-' + name);
          const html = D._internals.lineHtml({ lead: 'b-' + name, rows: [{ ws: ws({ id: 'k1' + name, agentId: 'a', title: 'One', lastRunReason: 'done' }), worker: null }, { ws: ws({ id: 'k-' + name, agentId: 'c', title: 'Three', lastRunReason: '' }), worker: w }] }, 'home');
          const st = D.stateOf({ ws: ws({ id: 'k-' + name, agentId: 'c', title: 'Three', lastRunReason: '' }), worker: w }, 'home', 'L');
          got[name] = { cls: st.cls, halted: !!st.halted, lamp: (/<span class="dg-lamp ([^"]+)"/.exec(html) || [])[1], sum: (/<span class="dg-line-sum ([^"]+)">([^<]*)/.exec(html) || []).slice(1).join(': ') };
        }
        A.ok(got.ownStop.halted && got.leadStop.halted && got.ownStop.lamp !== 'failed' && got.leadStop.lamp !== 'failed' && got.budget.cls !== 'stopped' && got.budget.cls !== 'failed'
          && got.budget.lamp !== 'failed' && !/stopped/.test(got.budget.sum),
          'review r8: a worker stopped through the ledger is a stop (halted, no failed batch); a budget-ended worker is no stop and no failure (got ' + JSON.stringify(got) + ')');
      } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; } }
    }

    // r8.10 COMMS' PRESENCE CARD and STOP TOAST (frontend/app/chat.js resolvePresence's label, sliced): every end but 'done' read "■ RUN STOPPED" — a
    //       refusal, a limit, an end-only failure and a question; the stop toast warned for the Commander's own stop
    {
      const chat = read8('frontend/app/chat.js');
      // (review 9: the card's decision is presenceLook now — presenceCard reads it, or the inline region before it)
      const labelOf = presenceCard ? opts => presenceCard.decide(opts).word : null;
      const said = {};
      if (labelOf) for (const [k, e] of Object.entries(ENDS)) if (k !== 'succeeded' && k !== 'cut_short') said[k] = { word: labelOf({ endReason: e.reason }), tone: '' };
      A.ok(!!labelOf && said.stopped.word === '■ RUN STOPPED' && !/STOPPED/.test(said.asked.word + said.refused.word + said.out_of_budget.word + said.failed.word),
        'review r8: COMMS\' presence card says RUN STOPPED for a stop alone — a question, a refusal, a limit and an end-only failure each say themselves (got ' + JSON.stringify(said) + ')');
      if (labelOf) law('COMMS\' presence card', said);
      A.ok(/endReason === 'cancelled' \? '' : 'warn', undefined, isActiveWs\(ws\) \|\| endReason === 'cancelled'/.test(chat) && /'run ' \+ endVerb \+ ': '/.test(chat),
        'review r8: COMMS\' stop toast is the plain tier for a stop and names a failure or an unfinished end as itself, never "run stopped"');
    }

    // r8.11 THE WORKSHOP's BUILD NOW (frontend/app/stationui.js, the shift result handler sliced; review 7.3 major): a shift someone STOPPED toasted
    //       "the shift ran but produced nothing reviewable — it will retry" at warn
    {
      const ui = read8('frontend/app/stationui.js');
      const from = ui.indexOf('            const p = res || {};\n            if (p.reason === \'built\')'), to = ui.indexOf('loadWsLive();', from);
      const handle = from >= 0 && to > from ? new Function('res', 'notify', ui.slice(from, to)) : null;
      const toasts = [];
      if (handle) handle({ fired: true, reason: 'stopped' }, (t, k) => toasts.push([t, k]));
      A.ok(!!handle && toasts.length === 1 && /stopped before it finished/.test(toasts[0][0]) && toasts[0][1] === '' && !/nothing reviewable/.test(toasts[0][0]),
        'review r8: BUILD NOW says a stopped shift as a stop in the plain tier, never "produced nothing reviewable" (got ' + JSON.stringify(toasts) + ')');
    }

    // r8.12 THE ROUTINE'S COMMS SESSION and NEEDS YOU (frontend/app/autosessions.js, the real module; review r8 sweep): a fire that ASKED or hit its
    //       spend cap read "⚠ Routine failed — clarifying" / "— budget" with ok=false — the rail's "last run failed", NEEDS YOU's 'routine "X" failed'
    {
      const saved = { Workstreams: global.Workstreams, Channels: global.Channels, App: global.App, fetch: global.fetch };
      const WS = require('../frontend/app/workstreams.js');
      WS.reset();
      global.Workstreams = WS;
      global.Channels = { begin: () => {}, end: () => {}, isBusy: () => false, busyIds: () => [], setStatus: () => {} };
      global.App = { persist: () => {}, refreshRail: () => {} };
      global.fetch = async url => {
        if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: [] }) };
        if (url.indexOf('/api/transcript?') === 0) return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'Which inbox?' }] }) };
        return { ok: true, json: async () => ({ runs: [] }) };
      };
      let AutoSessions = null;
      try {
        AutoSessions = require('../frontend/app/autosessions.js').AutoSessions;
        AutoSessions.reset();
        const I = AutoSessions._internals;
        const said = {}, lines = {};
        for (const [k, reason] of [['asked', 'clarifying'], ['out_of_budget', 'budget'], ['cut_short', 'cut_short'], ['failed', 'error']]) {
          I.beginSession('f-' + k, { id: 'j1', name: 'digest', agentId: 'agent', prompt: 'do it' });
          await I.completeSession('f-' + k, 'failed', reason);
          const w = WS.get('cron-f-' + k) || {};
          said[k] = { word: (w.history || []).filter(m => m && m.sys).map(m => m.content).join(' | '), tone: w.lastRunOk === false ? 'bad' : String(w.lastRunOk) };
          // review 8.1: how COMMS draws the marker line — the failure red (error: the .err line) or the outcome's own tone
          const m = (w.history || []).filter(x => x && x.sys).slice(-1)[0] || {};
          lines[k] = { word: m.content || '', tone: m.error ? 'bad' : m.tone || 'plain' };
          lines[k].reason = w.lastRunReason;   // (review 8.1: a failed fire files its own word, so the board never reads the fire before it's)
        }
        law('the routine session\'s marker and verdict', said);
        law('the routine session\'s marker LINE as COMMS draws it', lines);
        A.ok(lines.asked.tone === 'ask' && lines.cut_short.tone === 'warn' && lines.failed.tone === 'bad' && lines.failed.reason === 'error', 'review 8.1: a routine\'s question marker is drawn in the ask gold, an unfinished one in the warn tone, a failed one red (got ' + JSON.stringify(lines) + ')');
        A.ok(/sysLine\(m\.content, !!m\.error, m\.tone\)/.test(read8('frontend/app/chat.js')) && /\.cmsg\.system\.ask > \.body \{ color: var\(--gold\); \}/.test(read8('frontend/css/comms-convo.css')) && /\.cmsg\.system\.warn > \.body \{ color: var\(--warn\); \}/.test(read8('frontend/css/comms-convo.css')),
          'review 8.1: COMMS replays a marker\'s own tone (the ask gold, the warn tone), never the failure red for a question');
        A.ok(/asked a question/.test(said.asked.word) && said.failed.tone === 'bad' && /Routine failed — error/.test(said.failed.word),
          'review r8: a routine fire that asked or did not finish settles no failure, each in its own words; a failed one stays failed (got ' + JSON.stringify(said) + ')');
      } finally {
        if (AutoSessions && AutoSessions.reset) AutoSessions.reset();
        WS.reset();
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
      }
    }

    // r8.13 THE HUD's cron.result toast (frontend/app/world.js, the listener sliced whole; review r8 sweep): every fire that did not succeed and was
    //       no stop toasted "✕ routine failed — <machine word>" at warn — a question "— clarifying", a cut reply "— cut_short"
    {
      const worldSrc = read8('frontend/app/world.js');
      const at = worldSrc.indexOf("U.bus.on('cron.result', p => {");
      const src = at < 0 ? '' : worldSrc.slice(at, worldSrc.indexOf('\n    });', at) + '\n    });'.length);
      let on = null; const notes = [];
      if (src) new Function('U', 'hudNote', 'RunOutcome', src)({ bus: { on: (n, fn) => { if (n === 'cron.result') on = fn; } } }, (t, k) => notes.push([t, k]), RunOutcome);
      const toast = p => { notes.length = 0; if (on) on(p); return notes[0] || ['(none)', '']; };
      const said = {};
      for (const [k, reason] of [['asked', 'clarifying'], ['cut_short', 'cut_short'], ['out_of_budget', 'budget'], ['failed', 'error'], ['stopped', 'cancelled']]) {
        const t = toast({ jobId: 'j', runId: 'r-' + k, outcome: k === 'stopped' ? 'stopped' : 'failed', runOutcome: k, reason });
        said[k] = { word: t[0], tone: /^✕/.test(t[0]) ? 'bad' : t[1] || 'stop' };
      }
      law('the HUD\'s routine toast', said, { stopTone: undefined });
    }

    // r8.14 THE ROUTINES WINDOW (frontend/app/windows/routines.js endMark / failedAs, sliced, and RUN NOW's verdict; review r8 sweep): a question read
    //       "✕ asked a question" in red on the card and in RUN HISTORY; RUN NOW toasted a refusal the provider raised as an error "routine run failed"
    {
      const rt = read8('frontend/app/windows/routines.js');
      const mark = ['failedAs', 'endMark'].map(n => functionSourceIn(rt, n));
      const endMark = mark.every(Boolean) ? new Function('RunOutcome', 'esc', mark.join('\n') + '\nreturn endMark;')(RunOutcome, v => String(v)) : null;
      const said = {};
      if (endMark) for (const k of ['asked', 'stopped', 'cut_short', 'out_of_budget', 'failed', 'refused']) { const h = endMark(k, k === 'failed' ? 'rate_limit' : '', ''); said[k] = { word: h.replace(/<[^>]+>/g, ''), tone: /--bad/.test(h) ? 'bad' : /class="dim"/.test(h) ? 'stop' : /--gold/.test(h) ? 'ask' : 'warn' }; }
      A.ok(!!endMark && said.asked.tone === 'ask' && said.failed.tone === 'bad', 'review r8: the ROUTINES card draws each fire\'s outcome in its own glyph and colour (got ' + JSON.stringify(said) + ')');
      if (endMark) law('the ROUTINES card and RUN HISTORY', said);
      const at = rt.indexOf('            const reader = resp.body.getReader()');
      const body = at < 0 ? '' : rt.slice(at, rt.indexOf('\n', rt.indexOf('notify(', at)));
      const press = async events => {
        const bytes = new TextEncoder().encode(events.map(([name, payload]) => JSON.stringify({ name, payload })).join('\n') + '\n');
        let sent = false; const toasts = [];
        const reader = { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } };
        await new Function('resp', 'TextDecoder', 'ob', 'esc', 'notify', 'RunOutcome', 'Harness', 'id', 'return (async () => {\n' + body + '\n})();')(
          { body: { getReader: () => reader } }, TextDecoder, { innerHTML: '' }, v => String(v == null ? '' : v), (m, k) => toasts.push([m, k]), RunOutcome, { api: { get: async () => ({ jobs: [] }) } }, 'j1');
        return toasts.pop() || [];
      };
      const start = ['agent.run.start', { agentId: 'agent', runId: 'rn1', trigger: 'manual' }];
      const blocked = body ? await press([start, ['agent.run.error', { runId: 'rn1', message: 'the provider blocked this request', failureCode: 'content_policy_blocked' }], ['agent.run.end', { agentId: 'agent', runId: 'rn1', reason: 'error' }]]) : [];
      const asked = body ? await press([start, ['agent.run.end', { agentId: 'agent', runId: 'rn1', reason: 'clarifying', outcome: 'asked' }]]) : [];
      A.ok(!!body && !/routine run failed/.test(blocked[0] || '') && /declined/.test(blocked[0] || '') && /asked a question/.test(asked[0] || ''),
        'review r8: RUN NOW says a provider safety block as the refusal it is and a question as one, never "routine run failed" (got ' + JSON.stringify({ blocked, asked }) + ')');
    }

    // r8.15 A LOOP PASS (sidecar/loopjob-store.js settleIteration + loopjob-driver's unfinished hand-off + the LOOPS history; review r8 sweep): a pass
    //       whose run was cut short, asked or hit a limit settled 'failed' ("failed — run ended without completion — …") and raised failStreak
    {
      const S = require('../sidecar/loopjob-store.js');
      let loops = S.createLoop([], { id: 'l8', name: 'sweep', objective: 'find bugs' }, { now: 1000 });
      loops = S.startIteration(S.claimFire(loops, 'l8', { now: 1000 }), 'l8', { runId: 'r1', now: 1000 });
      loops = S.settleIteration(loops, 'l8', { runId: 'r1', status: 'error', unfinished: 'cut_short', error: 'run ended without completion — the reply was cut short' }, { now: 2000 });
      const l = S.getLoop(loops, 'l8') || {};
      const it = (l.iterations || []).slice(-1)[0] || {};
      const drv = sidecarRead8('sidecar/loopjob-driver.js');
      A.ok(it.outcome === 'unfinished' && it.unfinishedAs === 'cut_short' && !(l.failStreak > 0) && /const unfinished = terminalReason !== 'cancelled' && ended\.outcome !== 'failed'/.test(drv) && /cancelled: terminalReason === 'cancelled', unfinished,/.test(drv)
        && /r\.outcome === 'unfinished' \? \('did not finish — '/.test(read8('frontend/app/windows/loops.js')),
        'review r8: a loop pass whose run did not finish settles as that, never a failed pass toward the failure pause (got ' + JSON.stringify({ outcome: it.outcome, unfinishedAs: it.unfinishedAs, failStreak: l.failStreak }) + ')');
      // review 8.1: the unfinished streak was never reset — U,C,U,C,U parked a healthy loop "3 passes in a row did not finish"; and F,U,F,U,F
      // parked on the fifth pass as "3 iterations failed in a row". "In a row" is true now, and a mix says itself
      const play = seq => {
        let ls = S.createLoop([], { id: 'l9', name: 'sweep', objective: 'find bugs', queueCap: 9 }, { now: 1000 }), t = 1000;
        for (const [n, k] of seq.split('').entries()) {
          const runId = 'p' + n;
          ls = S.startIteration(S.claimFire(ls, 'l9', { now: t }), 'l9', { runId, now: t });
          ls = S.settleIteration(ls, 'l9', k === 'U' ? { runId, status: 'error', unfinished: 'out_of_budget', error: 'budget limit reached' }
            : k === 'F' ? { runId, status: 'error', error: 'provider 500' } : { runId, status: 'ok', text: 'found one', title: 'found one' }, { now: t + 10 });
          t += 1000;
        }
        const g = S.getLoop(ls, 'l9') || {};
        return { state: g.state, stop: g.stopReason || '', failStreak: g.failStreak, unfinishedStreak: g.unfinishedStreak };
      };
      const apart = play('UCUCUCU'), mixed = play('FUF'), broken = play('FUCFU'), three = play('UUU');
      A.ok(apart.state !== 'paused' && apart.unfinishedStreak === 1 && mixed.state === 'paused' && /^3 passes in a row did not succeed \(2 failed, 1 did not finish\)/.test(mixed.stop)
        && broken.state !== 'paused' && three.state === 'paused' && /^3 passes in a row did not finish/.test(three.stop),
        'review 8.1: a loop parks only on passes that did not succeed IN A ROW — a success between resets both counts, and a failed / unfinished mix says itself (got ' + JSON.stringify({ apart, mixed, broken, three }) + ')');
    }

    // r8.16 THE BUILD QUEST (frontend/app/workquests.js; review r8 sweep): a build whose run ASKED a question stalled as "the run errored out"
    {
      const WQ = require('../frontend/app/workquests.js');
      const cardOf = why => (WQ.project({ quests: { q1: { title: 'landing page', steps: [{ key: 'a', label: 'a', done: false }], firstSeenAt: 1, stalledAt: 5, stalledReason: why, completedAt: null, runId: 'r' } } }) || [])[0] || {};
      const asked = cardOf('clarifying'), askedOc = cardOf('asked'), empty = cardOf('empty');
      A.ok([asked, askedOc].every(c => /asked you a question/.test(c.desc) && !/errored out/.test(c.desc) && !/stalled/.test(c.title)) && !/errored out/.test(empty.desc),
        'review r8: a build quest whose run asked a question waits on you, never "errored out"; an empty reply says itself (got ' + JSON.stringify({ asked, empty }) + ')');
    }

    // r8.17 THE AWAY BRIEFING (sidecar/away-briefing.js compose; review r8 sweep): a routine fire that ASKED was briefed under Waiting on you as
    //       "“digest” failed: clarifying."; a spend-capped loop pass tallied "(1 failed)" with the raw word "budget"
    {
      const B = require('../sidecar/away-briefing.js');
      const row = (runId, streamId, o) => Object.assign({ runId, streamId, agentId: 'agent', surface: 'autonomous', reason: 'done', outcome: 'succeeded', title: 'x', ts: 5, endedAt: 5 }, o || {});
      const b = B.compose({ since: 1, now: 99, runs: [row('c1', 'cron-c1', { cronJobId: 'j1', reason: 'clarifying', outcome: 'asked' }), row('l1', 'loop-tests', { ts: 2, endedAt: 2 }), row('l2', 'loop-tests', { reason: 'budget', outcome: 'out_of_budget', ts: 3, endedAt: 3 })],
        jobs: [{ id: 'j1', name: 'digest' }], loops: [{ id: 'tests', name: 'tests' }], builds: [], drafts: [] });
      A.ok(/“digest” asked you a question/.test(b.text) && !/“digest” failed/.test(b.text) && !/\(1 failed\)/.test(b.text) && !/: budget\b/.test(b.text) && b.counts.failed === 0,
        'review r8: the away briefing says a question as a question and a spend cap as not finishing — never "failed", never the raw word (got ' + JSON.stringify({ text: b.text, counts: b.counts }) + ')');
      // review 8.1: a DELEGATED worker that asked or was cut short was counts.failed, and the model was told "2 delegated job(s) finished, 2 failed"
      const threads = [{ id: 't1', parentStreamId: 'p1', title: 'w' }, { id: 'p1', title: 'Launch' }];
      const w = (runId, o) => Object.assign({ runId, streamId: 't1', delegatedBy: 'agent', agentId: 'research', surface: 'autonomous', reason: 'done', outcome: 'succeeded', ts: 4, endedAt: 4 }, o || {});
      const d = B.compose({ since: 1, now: 99, runs: [w('w1', { reason: 'clarifying', outcome: 'asked' }), w('w2', { reason: 'done', finishReason: 'length', outcome: 'cut_short', ts: 5, endedAt: 5 }), w('w3', { reason: 'error', outcome: 'failed', failureCode: 'rate_limit', ts: 6, endedAt: 6 })],
        threads, jobs: [], loops: [], builds: [], drafts: [] });
      const ctx = B.contextBlock(d);
      A.ok(d.counts.failed === 1 && d.counts.unfinished === 2 && /1 delegated job in “Launch” asked you a question/.test(d.text) && /1 delegated job in “Launch” did not finish: the reply was cut short/.test(d.text)
        && /1 delegated job in “Launch” failed: rate limit/.test(d.text) && /3 delegated job\(s\), 1 failed, 1 did not finish, 1 asked a question;/.test(ctx),
        'review 8.1: a delegated worker that asked or did not finish is never counted, briefed or handed to the model as failed (got ' + JSON.stringify({ text: d.text, counts: d.counts, ctx }) + ')');
    }

    // r8.18 A GROUP TURN (sidecar/group-sessions.js, its settle lines sliced; review r8 sweep): a turn whose reply hit max_tokens, a limit, an empty
    //       reply or a refusal was state 'failed' — the red "failed" chip with RETRY, the same as a crash
    {
      const gs = sidecarRead8('sidecar/group-sessions.js');
      const from = gs.indexOf('          const turnOk = !error && (oc.ok');
      const reasonAt = [gs.indexOf('reason: halted ? (current.reason', from), gs.indexOf('reason: stopped ? (current.reason', from)].filter(i => i >= 0)[0];
      const to = reasonAt == null ? -1 : gs.indexOf('\n', reasonAt);
      const settle = from >= 0 && to > from ? new Function('error', 'oc', 'waiting', 'stopped', 'result', 'RunOutcome', 'current', 'd', 'usd', gs.slice(from, to) + '\nreturn current.state;') : null;
      const state = k => settle ? settle('', RunOutcome.ofEnd(ENDS[k], null), false, false, { reason: ENDS[k].reason, finishReason: ENDS[k].finishReason }, RunOutcome, {}, { now: () => 1 }, 0) : '(no slice)';
      const got = Object.fromEntries(['cut_short', 'out_of_budget', 'empty', 'refused', 'failed', 'succeeded', 'asked', 'stopped'].map(k => [k, state(k)]));
      A.ok(['cut_short', 'out_of_budget', 'empty', 'refused'].every(k => got[k] === 'unfinished') && got.failed === 'failed' && got.succeeded === 'completed' && got.asked === 'completed' && got.stopped === 'stopped'
        && /unfinished: 'did not finish'/.test(read8('frontend/app/group-chat.js')),
        'review r8: a group turn that did not finish is its own state, never the crash\'s red "failed" (got ' + JSON.stringify(got) + ')');
    }

    // r8.19 THE DESK SCREEN (frontend/app/deskscreen.js lastRunRead; review r8 sweep): an interrupted last job read "IDLE", as a clean finish does;
    //       a stop, a question and a limit shared the idle lamp, a refusal and a cut reply the failure red
    {
      const D = require('../frontend/app/deskscreen.js');
      const said = {};
      for (const [k, e] of Object.entries(ENDS)) if (k !== 'succeeded') { const r = D._lastRunRead(Object.assign({ runId: 'x', agentId: 'agent' }, e)); said[k] = { word: r.word, tone: r.state === 'failed' ? 'bad' : r.state === 'idle' ? 'stop' : r.state }; }
      const intr = D._lastRunRead({ runId: 'i', agentId: 'agent', reason: 'interrupted', outcome: 'interrupted' });
      law('the desk screen\'s idle view', said, { stopTone: 'stop' });
      A.ok(intr.word !== 'IDLE' && intr.state !== 'done', 'review r8: the desk screen says an interrupted last job as itself, never IDLE (got ' + JSON.stringify(intr) + ')');
      // review 9.2: an END-ONLY refusal (reason 'error', stamped 'refused': the row the runstore keeps) read FAILED on the failure lamp — lastRunRead
      // keyed on RunOutcome.reasonOf, which kept the bare 'error'; it reads as the refused row does now
      const endOnly = D._lastRunRead({ runId: 'e', agentId: 'agent', reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked' });
      A.ok(endOnly.word === said.refused.word && endOnly.state !== 'failed' && endOnly.state === D._lastRunRead(Object.assign({ runId: 'x', agentId: 'agent' }, ENDS.refused)).state,
        'review 9.2: the desk screen says an end-only refusal as a refusal (' + said.refused.word + '), never FAILED on the failure lamp (got ' + JSON.stringify(endOnly) + ')');
    }

    // r8.20 A RECOMMENDATION (frontend/app/suggeststore.js onRunEnd, sliced; review r8 sweep): an accepted idea whose run ASKED a question, was cut short
    //       or hit a limit was posted declined / bad_quality (quality -1), down-ranking that kind of idea before any answer
    {
      const src = functionSourceIn(read8('frontend/app/suggeststore.js'), 'onRunEnd');
      const posted = {};
      for (const k of ['asked', 'cut_short', 'out_of_budget', 'failed', 'succeeded']) {
        const posts = [];
        try {
          new Function('ready', 'acceptedRecommendationInit', 'ledgerPost', 'RunOutcome', 'state', 'pitchDone', 'familiarityNow', 'save',
            'let acceptedRecommendation = acceptedRecommendationInit, acceptedRunId = "r1";\n' + src + '\nreturn onRunEnd;')(() => true, 'rec1', p => posts.push(p), RunOutcome, { tasksSinceLast: 0 }, () => false, () => null, () => {})(Object.assign({ runId: 'r1', agentId: 'agent' }, ENDS[k]));
        } catch (e) { posts.push({ threw: String((e && e.message) || e) }); }
        posted[k] = posts.map(p => p.state || (p.outcome && p.outcome.quality) || p.threw).join(',');
      }
      A.ok(!posted.asked && !posted.cut_short && !posted.out_of_budget && /declined/.test(posted.failed) && /completed/.test(posted.succeeded),
        'review r8: only a FAILED run scores an accepted idea down; a question, a cut reply or a limit is no verdict on it (got ' + JSON.stringify(posted) + ')');
    }

    // r8.21 THE SUMMON LINK (frontend/app/world.js, the link's agent.run.end listener sliced; review r8 sweep): a question and a stop drew the same amber
    {
      const worldSrc = read8('frontend/app/world.js');
      let at = -1;
      for (let i = worldSrc.indexOf("U.bus.on('agent.run.end', p => {"); i >= 0; i = worldSrc.indexOf("U.bus.on('agent.run.end', p => {", i + 1)) { const e = worldSrc.indexOf('\n    });', i); if (worldSrc.slice(i, e).indexOf('summonLinks') >= 0) { at = i; break; } }
      const src = at < 0 ? '' : worldSrc.slice(at, worldSrc.indexOf('\n    });', at) + '\n    });'.length);
      const cols = {};
      for (const k of ['asked', 'stopped', 'cut_short', 'failed', 'succeeded']) {
        const links = [{ toId: 'w' }];
        let on = null;
        if (src) new Function('U', 'summonLinks', 'RunOutcome', src)({ bus: { on: (n, fn) => { on = fn; } } }, links, RunOutcome);
        if (on) on(Object.assign({ agentId: 'w', runId: 'r' }, ENDS[k]));
        cols[k] = links[0].endCol || '(none)';
      }
      A.ok(!!src && new Set(Object.values(cols)).size === 5, 'review r8: the summon link draws a question, a stop, an unfinished reply, a failure and a success each in its own colour (got ' + JSON.stringify(cols) + ')');
    }

    // r8.22 A LINE JOB SOMEONE STOPPED, on the page (build.js finSampleHTML sliced; the sample route's answer, the step words; review r8 sweep): a
    //       STOP on one of the job's steps answered stopped:false — the FINISH card said "REFUSED stopped — …" in red — and a step that was cut or
    //       limited read REFUSED too; the step words printed a stopped step as "cancelled" in warn
    {
      const b = read8('frontend/app/build.js');
      const fin = functionSourceIn(b, 'finSampleHTML');
      const html = fin ? new Function('esc', fin + '\nreturn finSampleHTML;')(v => String(v))({ ok: false, stopped: false, stages: ['WRITER', 'EDITOR'], reason: 'sample job did not complete cleanly', usd: 0.01 }) : '';
      const idx = sidecarRead8('sidecar/index.js');
      const wf = read8('frontend/app/windows/workflows.js'), panel = read8('frontend/app/workflowpanel.js');
      const mapOf = (src, head) => { const m = new RegExp(head + '\\s*=\\s*(\\{[^;]*\\});').exec(src); try { return m ? new Function('return ' + m[1])() : {}; } catch (_) { return {}; } };
      const END = mapOf(wf, 'const END ?'), RUN_END = mapOf(panel, 'const RUN_END');
      A.ok(/DID NOT FINISH/.test(html) && !/REFUSED/.test(html) && /const stopped = !!sampleInFlight\.stopRequested \|\| stepStopped;/.test(idx)
        && END.cancelled === 'was stopped' && RUN_END.cancelled === 'was stopped' && /asked/.test(END.clarifying || '') && /asked/.test(RUN_END.clarifying || '')
        && /fail\(String\(\(res\.j && res\.j\.error\) \|\| \('the station refused \(http ' \+ res\.status \+ '\)'\)\), !!\(res\.j && res\.j\.stopped === true\)\)/.test(read8('frontend/app/chat.js')),
        'review r8: a line job a step STOP stopped answers stopped; a job whose steps ran is "did not finish", never REFUSED; a stopped step says so (got ' + JSON.stringify({ html, END, RUN_END }) + ')');
    }

    // r8.23 A SLASH-COMMAND ROUTINE (sidecar/index.js runSlashRoutine, sliced, into cron-driver's fireOutcome; review r8 missing-outcome): a refused,
    //       unknown, client-only or timed-out command hand-emitted an unstamped 'done' end, and the fire settled SUCCEEDED (✓ ok, "routine completed",
    //       the streak reset, its crate to the OUTBOX) while Run Now's twin recorded it failed
    {
      const src = sidecarTopLevelFunction('runSlashRoutine');
      const { fireOutcome } = require('../sidecar/cron-driver.js');
      // review 8.1: every event it emits is checked against the CONTRACT (shared/events.js validate), as Run Now's makeEmitter and the scheduled
      // fire's cronEmitValidated check it — its agent.run.error left out the required `transient` and both dropped it as an invalid event
      const Events = require('../shared/events.js');
      const fireOf = async r => {
        const state = { buf: '', errMsg: null, reason: null, transient: false, usd: 0, toolsRan: 0 }, invalid = [];
        const emit = (name, p) => {
          const v = Events.validate(name, p);
          if (!v.ok) { invalid.push(name + ': ' + v.errors.join('; ')); return; }   // a validating emitter drops it
          if (name === 'agent.token') state.buf += p.delta || ''; else if (name === 'agent.run.error') state.errMsg = p.message; else if (name === 'agent.run.end') { state.reason = p.reason; state.end = p; }
        };
        // run-table S2: the command routine is admitted to the run table for the command's life (the REAL sidecar/run-table.js) and its
        // start and end go through its entry, stamped by the outcome sink
        const runTable = require('../sidecar/run-table.js').makeRunTable();
        const run = new Function('runSlashForChannel', 'runTable', 'RunOutcome', src + '\nreturn runSlashRoutine;')(async () => r, runTable, RunOutcome);
        const out = await run('/nightly-backup', { agentId: 'agent', runId: 'r1', emit });
        if (runTable.size() !== 0) invalid.push('the run table kept the command routine\'s entry');
        return { ok: out.ok, fire: fireOutcome(state, null).outcome, errMsg: state.errMsg, invalid };
      };
      const failed = src ? await fireOf({ ok: false, text: 'Unknown command.' }) : null, worked = src ? await fireOf({ ok: true, text: 'Backed up.' }) : null;
      A.ok(!!failed && failed.ok === false && failed.fire === 'failed' && worked.fire === 'succeeded', 'review r8: a failed slash-command routine fires FAILED by its own facts, as Run Now records it; a working one succeeds (got ' + JSON.stringify({ failed, worked }) + ')');
      A.ok(!!failed && !failed.invalid.length && !worked.invalid.length && failed.errMsg === 'Unknown command.',
        'review 8.1: every event a slash-command routine emits keeps the contract, so a validating emitter delivers its error (got ' + JSON.stringify({ failed, worked }) + ')');
    }

    // r8.24 NEEDS YOU, RENDERED (frontend/app/needsyou.js, the real module: items → html; review 8.1): r8 reworded a routine row's `what`, but the
    //       rail line read "routine failed · <name>" for every routine row, its door "Routine failed", its strip "Failed" and its key Retry — a
    //       question shown as a failure. A worker the ledger filed status 'error' with reason 'budget' / 'clarifying' read "failed: budget" under
    //       "Failed" ("Work failed"), while the delegated card said it did not finish / asked
    {
      const saved = { Workstreams: global.Workstreams, Channels: global.Channels, App: global.App, Overseer: global.Overseer, Delegated: global.Delegated, localStorage: global.localStorage, document: global.document, Chat: global.Chat, GroupChat: global.GroupChat, StationUI: global.StationUI };
      require('./helpers/frontend-esc.js').installEsc();
      const NOW = 50 * 86400000;
      const routine = (id, name, o) => Object.assign({ id: 'cron-' + id, title: name, automation: { kind: 'routine', name, id: 'j-' + id }, agentId: 'agent', lastActiveAt: NOW - 1000, runIds: [id], history: [] }, o);
      const all = [{ id: 'p1', title: 'Launch', history: [], runIds: ['r0'], agentId: 'agent' }, routine('f1', 'digest', { lastRunOk: null, lastRunReason: 'asked' }), routine('f2', 'news', { lastRunOk: null, lastRunReason: 'cut_short' }), routine('f3', 'backup', { lastRunOk: false, lastRunReason: 'error' })];
      try {
        global.document = undefined;
        global.localStorage = { getItem: () => null, setItem() {} };
        global.App = { agentName: id => id };
        global.Channels = { allPending: () => [], pendingOf: () => null, pendingAllOf: () => [], isBusy: () => false, elapsedOf: () => NaN, runIdOf: () => '' };
        global.Workstreams = { get: id => all.find(x => x.id === id) || null, list: () => all, unread: () => true, generalId: () => 'p1' };
        global.Overseer = { snapshot: () => ({ workers: [
          { runId: 'w1', agentId: 'research', status: 'error', reason: 'budget', parentStreamId: 'p1', completedAt: NOW - 500 },
          { runId: 'w2', agentId: 'copy', status: 'error', reason: 'clarifying', parentStreamId: 'p1', completedAt: NOW - 600 },
          { runId: 'w3', agentId: 'ops', status: 'error', reason: 'error', parentStreamId: 'p1', completedAt: NOW - 700 }
        ], threads: [] }), fresh: () => true };
        delete global.GroupChat; delete global.StationUI;
        global.Delegated = require('../frontend/app/delegated.js');
        const NY = require('../frontend/app/needsyou.js');
        const list = NY.items(NOW), I = NY._internals;
        const row = key => list.find(i => i.key === key) || {};
        const html = I.html(list, NOW);
        const lineOf = key => { const m = new RegExp('data-ny-key="' + key.replace(/[:.]/g, '\\$&') + '" data-ny-n[\\s\\S]*?<div class="ny-what"[^>]*>([\\s\\S]*?)</div>').exec(html); return m ? m[1].replace(/<[^>]+>/g, '') : '(none)'; };
        const doorOf = key => { const m = new RegExp('data-ny-act="open" data-ny-key="' + key.replace(/[:.]/g, '\\$&') + '" aria-label="([^"]*)"').exec(html); return m ? m[1].split(':')[0] : '(none)'; };
        const groups = I.byKind(list).map(g => g.f.id + ':' + g.label + ':' + g.rows.map(r => r.key).join(','));
        // a row's tone is what its door says it is (Failed → the failure red; a question → ask; did not finish → warn)
        const toneOf = key => { const d = doorOf(key); return /failed/i.test(d) ? 'bad' : /question/i.test(d) ? 'ask' : /did not finish/i.test(d) ? 'warn' : d; };
        const said = {
          asked: { word: lineOf('routine:cron-f1') + ' / ' + doorOf('routine:cron-f1'), tone: toneOf('routine:cron-f1') },
          cut_short: { word: lineOf('routine:cron-f2') + ' / ' + doorOf('routine:cron-f2'), tone: toneOf('routine:cron-f2') },
          failed: { word: lineOf('routine:cron-f3') + ' / ' + doorOf('routine:cron-f3'), tone: toneOf('routine:cron-f3') }
        };
        law('NEEDS YOU\'s routine rows, rendered', said);
        const workers = { out_of_budget: { word: row('worker:w1').what + ' / ' + doorOf('worker:w1'), tone: toneOf('worker:w1') },
          asked: { word: row('worker:w2').what + ' / ' + doorOf('worker:w2'), tone: toneOf('worker:w2') }, failed: { word: row('worker:w3').what + ' / ' + doorOf('worker:w3'), tone: toneOf('worker:w3') } };
        law('NEEDS YOU\'s worker rows, rendered', workers);
        A.ok(!/fail/i.test(said.asked.word + said.cut_short.word) && /routine failed/.test(said.failed.word) && I.familyOf(row('routine:cron-f1')) === 'questions'
          && !/data-ny-act="retry" data-ny-key="routine:cron-f1"/.test(html) && /data-ny-act="retry" data-ny-key="routine:cron-f3"/.test(html)
          && !/fail/i.test(workers.out_of_budget.word + workers.asked.word) && /^failed/.test(row('worker:w3').what) && workers.asked.tone === 'ask' && I.familyOf(row('worker:w2')) === 'questions'
          && groups.some(g => /^failed:Failed or did not finish|^failed:Failed, did not finish/.test(g)) && !groups.some(g => /^failed:Failed:/.test(g) && /routine:cron-f1|worker:w2/.test(g)),
          'review 8.1: NEEDS YOU renders a routine or a worker that asked a question under Questions with no Retry, one that did not finish as that, only a failure as failed (got ' + JSON.stringify({ said, workers, groups }) + ')');
      } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; } }
    }

    // r8.25 THE HUD's and THE PROJECT HOME's worker cards (frontend/app/hudmode.js workItems, the real module; project-home.js workerEnd, sliced;
    //       review 8.1): every worker the ledger filed status 'error' — one that asked a question, hit a spend cap or was cut short — was a red
    //       'fault' "Needs attention" card (WORKER_END, project-home's status words), while the delegated card said it asked / did not finish
    {
      const H = require('../frontend/app/hudmode.js');
      const T0 = 1700000000000;
      const wk = (id, reason) => ({ id, runId: 'r-' + id, agentId: 'agent', status: 'error', reason, completedAt: T0 - 1000, prompt: 'do ' + id });
      const items = H.workItems({ feed: H.createFeed(), workers: [wk('asked', 'clarifying'), wk('budget', 'budget'), wk('cut', 'cut_short'), wk('failed', 'error'), wk('lead', 'cancelled: its parent run L was cancelled')], now: T0 });
      const card = id => items.find(i => i.workerId === id) || {};
      // (review 9.1: a limit and a cut reply are the warn card in their own words — they kept the failure's fault red by FINISH's allowlist row; FOLD r9.5)
      const hud = {};
      for (const [k, id] of [['asked', 'asked'], ['failed', 'failed'], ['stopped', 'lead'], ['out_of_budget', 'budget'], ['cut_short', 'cut']]) hud[k] = { word: card(id).status, tone: card(id).state === 'fault' ? 'bad' : card(id).state };
      law('the HUD\'s worker cards', hud);
      const words = ['asked', 'budget', 'cut', 'failed', 'lead'].map(id => card(id).status);
      A.ok(card('asked').state === 'ask' && card('lead').state === 'stopped' && card('failed').state === 'fault' && card('failed').status === 'Needs attention' && new Set(words).size === 5,
        'review 8.1: the HUD says a worker that asked, hit a limit or was cut short by its own end, never "Needs attention" (got ' + JSON.stringify(items.map(i => [i.workerId, i.state, i.status])) + ')');
      const ph = functionSourceIn(read8('frontend/app/project-home.js'), 'workerEnd');
      const end = ph ? new Function('RunOutcome', ph + '\nreturn workerEnd;')(RunOutcome) : null;
      const home = {};
      if (end) for (const [k, reason] of [['asked', 'clarifying'], ['out_of_budget', 'budget'], ['cut_short', 'cut_short'], ['failed', 'error']]) { const e = end({ status: 'error', reason }); home[k] = { word: e[0], tone: e[1] === 'error' ? 'bad' : e[1] }; }
      if (end) law('the project home\'s worker cards', home);
      A.ok(!!end && home.asked.tone === 'asked' && home.failed.word === 'Needs attention' && end({ status: 'done', reason: 'done' })[0] === 'Completed',
        'review 8.1: the project home says a worker that asked or did not finish by its own end, never the red "Needs attention" (got ' + JSON.stringify(home) + ')');
    }

    // r8.26 A REFUSAL RAISED IN-BAND (frontend/app/chat.js's error branch, sliced, onto the task board; orchestration.js's worker reason helpers,
    //       sliced; review 8.1): the error branch recorded lastRunOk=false from the error flag alone, so a run the provider's safety check refused
    //       (agent.run.error content_policy_blocked + an end stamped 'refused') read "✗ RUN FAILED — REVIEW"; a failed run kept the run before it's
    //       word (lastRunReason), so after a cut reply the board read CUT SHORT for a failure. A refused worker's delivery and ledger reason were 'error'
    {
      const chat = read8('frontend/app/chat.js'), ui = read8('frontend/app/stationui.js');
      const from = chat.indexOf('        const errOc = (runOutcome'), to = from < 0 ? -1 : chat.indexOf('\n', chat.indexOf('Workstreams.noteRunEnd(ws.id, thisRunId, errOc', from));
      const verdict = from >= 0 && to > from ? new Function('runOutcome', 'thisRunId', 'ws', 'Workstreams', 'RunOutcome', chat.slice(from, to)) : null;
      const W = require('../frontend/app/workstreams.js');
      const chipFns = ['boardEnd', 'stateChip'].map(n => functionSourceIn(ui, n)).filter(Boolean).join('\n');
      const board = new Function('Channels', 'RunOutcome', chipFns + '\nreturn { stateChip };')({ isBusy: () => false }, RunOutcome);
      const chipOf = oc => {
        W.reset();
        const ws = W.create('t-' + (oc || 'none'), { kind: 'task', activate: false });
        W.appendRun(ws.id, 'r-prev', 1); W.noteRunEnd(ws.id, 'r-prev', null, 'cut_short');   // the run before: a cut reply
        W.appendRun(ws.id, 'r-err', 2);
        const s = W.get(ws.id); s.lane = 'active';
        if (verdict) verdict(oc, 'r-err', s, W, RunOutcome);
        return { ok: s.lastRunOk, chip: board.stateChip(s).replace(/<[^>]+>/g, '') };
      };
      const refused = chipOf('refused'), failed = chipOf('failed'), unstamped = chipOf('');
      W.reset();
      A.ok(!!verdict && refused.ok === null && /REFUSED/.test(refused.chip) && !/FAILED/.test(refused.chip) && failed.ok === false && /RUN FAILED/.test(failed.chip) && !/CUT SHORT/.test(failed.chip)
        && unstamped.ok === false && /RUN FAILED/.test(unstamped.chip),
        'review 8.1: an in-band error settles the board by the run\'s OUTCOME — a refusal REFUSED (no verdict), a failure FAILED by its own word, never the run before it (got ' + JSON.stringify({ refused, failed, unstamped }) + ')');
      A.ok(/resolvePresence\(ws, errOc \? \{ endReason: errOc \} : \{ error: true \}\)/.test(chat), 'review 8.1: COMMS\' presence card says a refusal raised in-band as REFUSED, never RUN FAILED');
      // an END-ONLY refusal (no agent.run.error: the end itself 'error' + the refusal's code) — the completed branch's stop line and presence card
      // read the refusal's word; a reply whose end never arrived (the transport catch) is failed by its own word, never the run before it's
      const endAt = chat.indexOf('        const endWord = ');
      const endWordOf = endAt < 0 ? null : new Function('endReason', 'chipOc', chat.slice(endAt, chat.indexOf('\n', endAt)) + '\nreturn endWord;');
      A.ok(!!endWordOf && endWordOf('error', 'refused') === 'refusal' && endWordOf('error', 'failed') === 'error' && RunOutcome.ofWord(endWordOf('error', 'refused')).outcome === 'refused'
        && /noteStopReason\(ws, stopLine, thisRunId, endWord\)/.test(chat) && /resolvePresence\(ws, \{ outcome: chipOc, endReason: endWord,/.test(chat)
        && /Workstreams\.noteRunEnd\(ws\.id, thisRunId, false, 'error'\);/.test(chat),
        'review 8.1: an end-only refusal is said and filed as the refusal (never re-filed failed by its stop line); a lost reply is failed by its own word');
      const orch = sidecarRead8('sidecar/tools/builtin/orchestration.js');
      const helpers = ['workerOutcome', 'markWorkerOutcome', 'workerReason', 'deliveryReasonOf'].map(n => functionSourceIn(orch, n));
      const H8 = helpers.every(Boolean) ? new Function('RunOutcome', helpers.join('\n') + '\nreturn { markWorkerOutcome, workerReason, deliveryReasonOf };')(RunOutcome) : null;
      const row = H8 ? H8.markWorkerOutcome({ reason: 'error' }, { reason: 'error', failureCode: 'content_policy_blocked' }) : {};
      const plain = H8 ? H8.markWorkerOutcome({ reason: 'error' }, { reason: 'error', failureCode: 'rate_limit' }) : {};
      const got = H8 ? { outcome: row.outcome, ledger: H8.workerReason(row), delivery: H8.deliveryReasonOf(row), plain: [plain.outcome || '', H8.workerReason(plain), H8.deliveryReasonOf(plain)] } : null;
      A.ok(!!got && got.outcome === 'refused' && got.ledger === 'refusal' && got.delivery === 'refusal' && RunOutcome.ofWord(got.delivery).outcome === 'refused'
        && typeof RunOutcome.ofWorker === 'function' && RunOutcome.ofWorker({ status: 'error', reason: got.ledger }).outcome === 'refused' && got.plain.join() === ',error,error',
        'review 8.1: a refused worker\'s row, ledger reason and delivery say the refusal (its own end word), a failed one stays failed (got ' + JSON.stringify(got) + ')');
    }

    // r8.27 COMMS' PRESENCE CARD AT ITS CALL SITE (frontend/app/chat.js's completed branch, sliced — the board's outcome, the end word and the
    //       presence call — into resolvePresence's label; review 8.2): the call took `taskQuestion ? 'done' : endWord`, so a task run that ended
    //       asking (its TASK_QUESTION marker parsed, the station's end 'clarifying', stamped asked) read "■ RUN COMPLETE" under its own question
    //       card while the board and the rail read ASKED, and a spend cap whose reply carried the marker read RUN COMPLETE too
    {
      const chat = read8('frontend/app/chat.js');
      const lineAt = needle => { const a = chat.indexOf(needle); return a < 0 ? '' : chat.slice(a, chat.indexOf('\n', a)); };
      const chipLine = lineAt('        const chipOc = runOutcome ||'), wordLine = lineAt('        const endWord = '), callLine = lineAt('        if (isActiveWs(ws)) resolvePresence(ws, { ');
      const labelOf = presenceCard ? presenceCard.decide : null;
      const site = chipLine && wordLine && callLine ? new Function('runOutcome', 'endReason', 'finishReason', 'taskQuestion', 'RunOutcome', 'resolvePresence',
        chipLine + '\n' + wordLine + '\nconst isActiveWs = () => true, ws = {}, cutShort = false, postconditionUnmet = false, runToolsOk = 1, runCost = 0, presenceStoppedBy = null;\n' + callLine + '\nreturn chipOc;') : null;
      // review 9 (8.3: the tone model read only 'err' and law() ran without a stop tone, so a question in the stop's gold passed): every class the
      // card carries, and its colour as the conversation's stylesheet draws it (comms-convo.css: #chat-log's own rules)
      const convo = presenceCard && presenceCard.sheets.find(x => x.rel === 'frontend/css/comms-convo.css');
      const runOf = (runOutcome, endReason, taskQuestion) => {
        let opts = null;
        const chipOc = site(runOutcome, endReason, '', taskQuestion, RunOutcome, (w, o) => { opts = o; });
        const card = opts && labelOf ? labelOf(opts) : { word: '', classes: [] };
        return { chipOc, word: card.word, classes: card.classes.join(' '), tone: convo ? presenceCard.colourIn(convo, card.classes) : '' };
      };
      const Q = { question: 'Which file?' };
      const got = site && labelOf ? {
        taskAsked: runOf('asked', 'clarifying', Q), chatAsked: runOf('asked', 'clarifying', null), succeeded: runOf('succeeded', 'done', null), markerDone: runOf('succeeded', 'done', Q),
        markerBudget: runOf('out_of_budget', 'budget', Q), failed: runOf('failed', 'error', null), stopped: runOf('stopped', 'cancelled', null)
      } : null;
      if (got) law('COMMS\' presence card at its call site', { asked: got.taskAsked, succeeded: got.succeeded, out_of_budget: got.markerBudget, stopped: got.stopped, failed: got.failed }, { failTone: 'var(--bad)', stopTone: got.stopped.tone });
      A.ok(!!got && got.taskAsked.word === '▲ ASKED YOU' && got.chatAsked.word === '▲ ASKED YOU' && got.succeeded.word === '■ RUN COMPLETE' && got.markerDone.word === '■ RUN COMPLETE'
        && got.markerBudget.word === '■ SPEND CAP' && Object.values(got).every(r => (r.chipOc === 'succeeded') === /COMPLETE/.test(r.word)),
        'review 8.2: COMMS\' presence card names the run\'s own end at its call site — a task run that asked says ASKED YOU, as the board does; RUN COMPLETE is a succeeded run\'s alone (got ' + JSON.stringify(got) + ')');
    }

    // r8.28 THE WORKER LEDGER's BUS EVENT and HOOK (sidecar/subagents.js, the real manager; frontend/js/audio.js's task listener, sliced; review
    //       8.2): publishTask took the bus 'task' status from the bare ledger status — a worker someone stopped (interrupt: the card's Stop, HUD /
    //       LIVE HELPERS STOP, E-STOP; cancelChildren: its lead's Stop), one that asked a question and one that hit a spend cap each published
    //       'failed', and the page's sound director played the failure sting for each; the subagent_stop hook handed user hooks child_status
    //       'error' for a question or a limit, with no outcome
    {
      const { makeSubagentManager } = require('../sidecar/subagents.js');
      const Events = require('../shared/events.js');
      const audio = read8('frontend/js/audio.js');
      const a0 = audio.indexOf("on('task', p => {"), a1 = a0 < 0 ? -1 : audio.indexOf('});', a0);
      const sounds = [];
      let onTask = null;
      if (a0 >= 0 && a1 > a0) new Function('on', 'SFX', audio.slice(a0, a1 + 3))((ev, fn) => { onTask = fn; }, { ship: () => sounds.push('ship'), alarm: () => sounds.push('alarm') });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-r82-'));
      const tasks = [], hooks = [], invalid = [];
      let T = 1000, n = 0;
      try {
        const mgr = makeSubagentManager({ fs, pathMod: path, file: path.join(dir, 'subagents.json'), clock: { now: () => T++ }, newId: () => 'w_' + (++n),
          emit: (name, p) => { if (name !== 'task') return; const v = Events.validate(name, p); if (v.ok) tasks.push(p); else invalid.push(v.errors.join('; ')); },
          hooks: { invoke: (name, p) => { if (name === 'subagent_stop') hooks.push(p.extra); } } });
        const tick = () => new Promise(r => setImmediate(r));
        const hang = () => new Promise(() => {});
        const settles = (status, reason) => async () => ({ status, reason, result: reason });
        const ids = {
          ownStop: mgr.start({ leadId: 'agent', agentId: 'r', prompt: 'own stop' }, hang).id,
          leadStop: mgr.start({ leadId: 'agent', agentId: 'r', prompt: 'lead stop', parentRunId: 'lead1' }, hang).id,
          asked: mgr.start({ leadId: 'agent', agentId: 'r', prompt: 'asked' }, settles('error', 'clarifying')).id,
          budget: mgr.start({ leadId: 'agent', agentId: 'r', prompt: 'budget' }, settles('error', 'budget')).id,
          failed: mgr.start({ leadId: 'agent', agentId: 'r', prompt: 'failed' }, settles('error', 'error')).id,
          succeeded: mgr.start({ leadId: 'agent', agentId: 'r', prompt: 'succeeded' }, settles('done', 'done')).id
        };
        await tick(); await tick();
        mgr.interrupt(ids.ownStop, 'agent'); mgr.cancelChildren('lead1');
        await tick(); await tick();
        const got = {};
        for (const [k, id] of Object.entries(ids)) {
          const t = tasks.filter(x => x.id === id && x.status !== 'running').pop() || {};
          sounds.length = 0;
          if (onTask) onTask(t);
          const h = hooks.find(x => x.subagent_id === id) || {};
          got[k] = { status: t.status || '(none)', outcome: t.outcome || '', sound: sounds.join() || '-', hook: h.child_outcome || '', hookCode: h.child_failure_code || '' };
        }
        const tone = g => g.sound === 'alarm' ? 'bad' : '';
        law('the worker ledger\'s bus task event', { stopped: { word: got.ownStop.status, tone: tone(got.ownStop) }, asked: { word: got.asked.status, tone: tone(got.asked) },
          out_of_budget: { word: got.budget.status, tone: tone(got.budget) }, failed: { word: got.failed.status, tone: tone(got.failed) }, succeeded: { word: got.succeeded.status, tone: tone(got.succeeded) } });
        A.ok(!!onTask && !invalid.length && got.ownStop.status === 'stopped' && got.leadStop.status === 'stopped' && got.ownStop.outcome === 'stopped' && got.leadStop.outcome === 'stopped'
          && got.asked.status === 'asked' && got.asked.outcome === 'asked' && got.budget.status === 'unfinished' && got.budget.outcome === 'out_of_budget'
          && got.failed.status === 'failed' && got.failed.outcome === 'failed' && got.succeeded.status === 'done'
          && ['ownStop', 'leadStop', 'asked', 'budget'].every(k => got[k].sound === '-') && got.failed.sound === 'alarm' && got.succeeded.sound === 'ship',
          'review 8.2: the bus task event says a stopped worker stopped, a question asked, a limit unfinished — each with its outcome, only a failure failed (the failure sting is a failure\'s alone) — and keeps the contract (got ' + JSON.stringify({ got, invalid }) + ')');
        A.ok(got.asked.hook === 'asked' && got.budget.hook === 'out_of_budget' && got.failed.hook === 'failed' && got.failed.hookCode === 'run_failure' && got.succeeded.hook === 'succeeded' && got.asked.hookCode === '',
          'review 8.2: the subagent_stop hook hands user hooks the worker\'s outcome (child_outcome, child_failure_code) beside the ledger status, so a hook that pages on failure never pages for a question (got ' + JSON.stringify(got) + ')');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // r8.29 THE DELEGATED CARD OVER THE BOARD's WORD (frontend/app/delegated.js stateOf, the real module; review 8.2): a worker thread with no current
    //       ledger record (a foreground worker, or the NEEDS YOU flow — the worker asked, the Commander answered in its thread, a newer run there)
    //       reads the board's lastRunReason, which keeps an OUTCOME word (chat.js files the run's outcome: 'asked', 'out_of_budget', 'step_limit',
    //       'blocked', 'refused'); stateOf read only end words, so each fell through to the red failed "ended · asked"; a thread whose last run
    //       SUCCEEDED (noteRunEnd files no word for it, so the run before it's stays) read that older word
    {
      const saved = { Channels: global.Channels, Overseer: global.Overseer, App: global.App, document: global.document };
      global.Channels = { pendingOf: () => null, pendingAllOf: () => [], isBusy: () => false, elapsedOf: () => NaN, runIdOf: () => '' };
      global.Overseer = { snapshot: () => ({ workers: [], threads: [] }), fresh: () => true };
      global.App = { agentName: id => id };
      global.document = undefined;
      require('./helpers/frontend-esc.js').installEsc();
      try {
        const D = require('../frontend/app/delegated.js');
        const ws = o => Object.assign({ id: 'k', history: [], runIds: ['r'] }, o);
        const st = (word, ok, extra) => D.stateOf(Object.assign({ ws: ws({ id: 'k-' + word + (ok === true ? '-ok' : ''), agentId: 'a', lastRunReason: word, lastRunOk: ok }), worker: null }, extra || {}), 'p', 'lead');
        const toneOf = s => s.cls === 'failed' ? 'bad' : s.cls === 'stopped' ? 'stop' : s.cls;
        const said = {}, cls = {};
        for (const word of ['asked', 'out_of_budget', 'step_limit', 'refused', 'cut_short', 'empty', 'blocked', 'cancelled', 'error']) {
          const s = st(word, word === 'error' ? false : null);
          const k = word === 'cancelled' ? 'stopped' : word === 'error' ? 'failed' : word;
          said[k] = { word: s.live, tone: toneOf(s) }; cls[k] = s.cls;
        }
        // the NEEDS YOU flow: the worker's ledger record is an older run of its thread (it asked); the Commander answered there and it asked again
        const answeredWs = D.stateOf({ ws: ws({ id: 'k-thread', agentId: 'a', runIds: ['r1', 'r2'], lastRunReason: 'asked', lastRunOk: null }), worker: { id: 'w1', runId: 'r1', status: 'error', reason: 'clarifying', agentId: 'a', leadId: 'agent' } }, 'p', 'lead');
        // (review 9: a succeeded run files its own word with its true — 'succeeded' — so the run before it's no longer stays; FOLD r9.2)
        const after = st('succeeded', true), ledgerRefused = st('', null, { worker: { id: 'w2', runId: 'r', status: 'refused', reason: 'refused', agentId: 'a', leadId: 'agent' } });
        law('the delegated card over the board\'s word', said, { stopTone: 'stop' });
        A.ok(cls.asked === 'asked' && ['out_of_budget', 'step_limit', 'refused', 'cut_short', 'empty', 'blocked'].every(k => cls[k] === 'unfinished') && cls.stopped === 'stopped' && cls.failed === 'failed'
          && answeredWs.cls === 'asked' && after.cls === 'done' && ledgerRefused.cls === 'failed' && /couldn't start/.test(ledgerRefused.live),
          'review 8.2: the delegated card reads the board\'s outcome word as that outcome — a question asked, a limit, a refusal or a hold unfinished, never the red failed — a thread whose last run succeeded done, and the ledger\'s own \'refused\' (it could not start) failed (got ' + JSON.stringify({ said, cls, answeredWs: answeredWs.cls, after: after.cls, ledgerRefused }) + ')');
      } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; } }
    }

    // r9.1 COMMS' PRESENCE CARD, THE OUTCOME FIRST (frontend/app/chat.js: the completed branch's chipOc / endWord / cutShort / postconditionUnmet and
    //      its presence call, sliced, into the card's decision; the branch's else-if chain, sliced; the three stylesheets' cascade; review 8.3
    //      majors): the card read postconditionUnmet and the provider's cut BEFORE the run's outcome — a recipe run with acceptance rows read
    //      "■ VERIFICATION REQUIRED" when it asked, was stopped (never STOPPED BY YOU), hit a spend cap or a step limit or was refused, and a
    //      question whose reply was cut read "■ CUT SHORT"; the chain toasted a recipe run's question as "finished but couldn't prove it worked"
    //      and an asked, cut reply as "reply cut short"; and every end but done wore the stop's 'stopped' class and gold (an end-only failure
    //      'stopped' after 'err', drawn gold)
    {
      const chat = read8('frontend/app/chat.js');
      const lineAt = needle => { const a = chat.indexOf(needle); return a < 0 ? '' : chat.slice(a, chat.indexOf('\n', a)); };
      const pre = ['        const chipOc = runOutcome ||', '        const endWord = ', '        const cutShort = finishReason ===', '        const postconditionUnmet = '].map(lineAt);
      const callLine = lineAt('        if (isActiveWs(ws)) resolvePresence(ws, { ');
      const site = pre.every(Boolean) && callLine ? new Function('runOutcome', 'endReason', 'finishReason', 'opts', 'completionVerdict', 'presenceStoppedBy', 'RunOutcome', 'resolvePresence',
        pre.join('\n') + '\nconst isActiveWs = () => true, ws = {}, runToolsOk = 1, runCost = 0;\n' + callLine + '\nreturn chipOc;') : null;
      const RECIPE = { postconditions: [{ id: 'p1', kind: 'file_exists', path: 'out.md' }] };
      const C = {   // [stamp, end reason, finishReason, opts, completionVerdict (the station's: not_assessed for a question, incomplete for an unfinished run), stoppedBy]
        asked: ['asked', 'clarifying', '', RECIPE, 'not_assessed', null], stopped: ['stopped', 'cancelled', '', RECIPE, 'incomplete', 'you'],
        out_of_budget: ['out_of_budget', 'budget', '', RECIPE, 'incomplete', null], step_limit: ['step_limit', 'max_iters', '', RECIPE, 'incomplete', null],
        refused: ['refused', 'refusal', '', RECIPE, 'incomplete', null], empty: ['empty', 'empty', '', RECIPE, 'incomplete', null],
        failed: ['failed', 'error', '', RECIPE, 'incomplete', null], cut_short: ['cut_short', 'done', 'length', null, 'not_assessed', null],
        succeeded: ['succeeded', 'done', '', RECIPE, 'completed_verified', null], unproven: ['succeeded', 'done', '', RECIPE, 'incomplete', null],
        askedCut: ['asked', 'clarifying', 'length', null, 'not_assessed', null], budgetCut: ['out_of_budget', 'budget', 'length', null, 'not_assessed', null]
      };
      const WORD = { asked: '▲ ASKED YOU', stopped: '■ STOPPED BY YOU', out_of_budget: '■ SPEND CAP', step_limit: '■ STEP LIMIT', refused: '■ REFUSED', empty: '■ EMPTY REPLY',
        failed: '■ RUN FAILED', cut_short: '■ CUT SHORT', succeeded: '■ RUN COMPLETE', unproven: '■ RUN COMPLETE', askedCut: '▲ ASKED YOU', budgetCut: '■ SPEND CAP' };
      const got = {};
      if (site && presenceCard) for (const [k, c] of Object.entries(C)) {
        let opts = null;
        const chipOc = site(c[0], c[1], c[2], c[3], c[4], c[5], RunOutcome, (w, o) => { opts = o; });
        const card = presenceCard.decide(opts || {});
        got[k] = { chipOc, word: card.word, classes: card.classes, colour: presenceCard.sheets.map(sh => presenceCard.colourIn(sh, card.classes)) };
      }
      const ok = !!site && !!presenceCard && Object.keys(C).every(k => got[k] && got[k].word.indexOf(WORD[k]) === 0);
      A.ok(ok && got.succeeded.word === '■ RUN COMPLETE' && /VERIFICATION REQUIRED/.test(got.unproven.word) && !/VERIFICATION|CUT SHORT/.test(got.asked.word + got.stopped.word + got.out_of_budget.word + got.step_limit.word + got.refused.word),
        'review 9: COMMS\' presence card says the run\'s OUTCOME first — a recipe run that asked, was stopped, hit a limit or was refused says so (never VERIFICATION REQUIRED), a question or a limit whose reply was cut says itself (never CUT SHORT); only a finished run is told its work is unproven (got ' + JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.word]))) + ')');
      if (ok) {
        const classOf = k => got[k].classes.filter(c => c !== 'resolved' && !/^tone-/.test(c));
        A.ok(Object.keys(C).every(k => got[k].classes.includes('stopped') === (got[k].chipOc === 'stopped') && got[k].classes.includes('err') === (got[k].chipOc === 'failed'))
          && new Set(['asked', 'stopped', 'out_of_budget', 'step_limit', 'refused', 'empty', 'failed', 'cut_short', 'succeeded'].map(k => classOf(k).join('.'))).size === 9,
          'review 9: every outcome its own class on the card — \'stopped\' a stop\'s alone, \'err\' a failure\'s alone (got ' + JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.classes.join(' ')]))) + ')');
        presenceCard.sheets.forEach((sh, i) => {
          const said = {};
          for (const k of ['asked', 'stopped', 'out_of_budget', 'step_limit', 'refused', 'empty', 'failed', 'cut_short', 'succeeded']) said[k] = { word: got[k].word, tone: got[k].colour[i] };
          law('COMMS\' presence card as ' + sh.rel + ' draws it', said, { failTone: 'var(--bad)', stopTone: said.stopped.tone });
          A.ok(said.failed.tone === 'var(--bad)' && said.asked.tone === 'var(--gold)' && said.stopped.tone !== said.succeeded.tone && said.stopped.tone !== said.asked.tone,
            'review 9: ' + sh.rel + ' draws a failure red (no stop class outranks it), a question gold, a stop apart from a question and a finished run (got ' + JSON.stringify(said) + ')');
        });
      }
      // THE ELSE-IF CHAIN under it (the stop line, the cut reply, the unproven work, the background notice), sliced with the same four facts
      const c0 = chat.indexOf("        if (endReason && endReason !== 'done' && endReason !== 'clarifying' && !taskQuestion) {"), c1 = chat.indexOf('        // a CLEAN end that hit an unwired connector mid-run');
      const env = { unpricedModel: '', unpricedCapTokens: 0, subscriptionModel: '', subscriptionCapTokens: 0, budgetScope: 'run', budgetCapUsd: 1, budgetCapIsBalance: false, budgetProjected: false,
        stopSource: new Map(), runPressedEstop: false, callNames: {}, budgetStopLine: () => 'hit a spending limit', stoppedByLine: () => 'stopped by you', Friendly: { stopLine: r => 'ended: ' + r },
        breakLive() {}, markStoppedTurn() {}, replyText: 'Which file should I edit?', noteStopReason() {}, thisRunId: 'r1', offerUnpricedDoor() {}, offerBudgetDoor() {}, offerTryAgain() {},
        brief: x => String(x), whoOf: () => 'ROOK', sessionNote: () => '', notedRuns: new Set(), effectVerdict: 'no_observed_effects', RunOutcome };
      const names = Object.keys(env).concat(['runOutcome', 'endReason', 'finishReason', 'opts', 'completionVerdict', 'taskQuestion', 'interrupted', 'ws', 'isActiveWs', 'toolLine', 'StationUI', 'goalStall', 'presenceStoppedBy']);
      // (review 9.3: the work log's end line is endLogLine, sliced beside the chain)
      const chain = c0 >= 0 && c1 > c0 && pre.every(Boolean) ? new Function(...names, pre.join('\n') + '\n' + (functionSourceIn(chat, 'endLogLine') || '') + '\n' + chat.slice(c0, c1) + '\nreturn goalStall;') : null;
      const drive = (k, active, question) => {
        const c = C[k], lines = [], toasts = [];
        const goal = chain ? chain(...Object.values(env), c[0], c[1], c[2], c[3], c[4], question ? { question: 'Which file?' } : null, new Set(), { id: 'w' }, () => active, t => lines.push(t),
          { notify: t => toasts.push(t) }, question ? 'it asked you a question — answer it first' : null, null) : null;
        return { goal, lines: lines.join(' | '), toasts: toasts.join(' | ') };
      };
      const bgAsked = drive('asked', false, true), fgAskedCut = drive('askedCut', true, true), bgUnproven = drive('unproven', false, false), fgCut = drive('cut_short', true, false), bgDone = drive('succeeded', false, false);
      A.ok(!!chain && /has a question for you/.test(bgAsked.toasts) && !/prove|finished/.test(bgAsked.toasts) && /asked you a question/.test(bgAsked.goal)
        && !/cut short/.test(fgAskedCut.lines + fgAskedCut.toasts) && /asked you a question/.test(fgAskedCut.goal)
        && /couldn’t prove it worked/.test(bgUnproven.toasts) && /reply cut short/.test(fgCut.lines) && /ROOK finished/.test(bgDone.toasts),
        'review 9: the completed branch\'s chain is picked by the run\'s outcome — a recipe run that asked is "has a question for you", never "finished but couldn\'t prove it worked"; a question whose reply was cut keeps its question, never "reply cut short"; a cut reply and an unproven finished run keep theirs (got ' + JSON.stringify({ bgAsked, fgAskedCut, bgUnproven, fgCut, bgDone }) + ')');
    }

    // r9.2 A WORKER A RESTART OR THE LIVENESS CHECK CUT OFF, and A THREAD WITH NO OUTCOME (frontend/app/delegated.js stateOf / lineHtml with
    //      beat-cards.css's lamp cascade; hudmode.js workItems; needsyou.js, rendered; project-home.js workerEnd, sliced; chat.js's verdict lines,
    //      sliced; review 8.3): a stale worker ('sidecar restarted before this worker finished', or the liveness check's 'stalled: …') was cls
    //      'stopped' with no halt on the delegated card — the red lamp, "stopped when the station restarted", a red "1 stopped" batch — the HUD's
    //      red fault "Lost when the station restarted" / "Stopped: made no progress" (and an interrupted run the stop's lamp), NEEDS YOU's "Work
    //      stopped" and the project home's bare "stale", while RunOutcome.ofWorker and the bus said interrupted; and the delegated card read a
    //      0.14.x thread's lastRunOk true (written for every completed stream, a question's and a cut reply's too) as done
    {
      const saved = { Channels: global.Channels, Overseer: global.Overseer, App: global.App, document: global.document, Workstreams: global.Workstreams, Delegated: global.Delegated,
        localStorage: global.localStorage, Chat: global.Chat, GroupChat: global.GroupChat, StationUI: global.StationUI };
      const NOW = 60 * 86400000;
      global.Channels = { allPending: () => [], pendingOf: () => null, pendingAllOf: () => [], isBusy: () => false, elapsedOf: () => NaN, runIdOf: () => '' };
      global.App = { agentName: id => id };
      global.document = undefined;
      global.localStorage = { getItem: () => null, setItem() {} };
      require('./helpers/frontend-esc.js').installEsc();
      const RESTART = { status: 'stale', reason: 'sidecar restarted before this worker finished' };
      const STALLED = { status: 'stale', reason: 'stalled: no progress for 450s — the liveness check stopped this worker (threshold 420s)' };
      const LEDGER = { restart: RESTART, stalled: STALLED, stopped: { status: 'interrupted', reason: 'interrupted' }, failed: { status: 'error', reason: 'error' }, out_of_budget: { status: 'error', reason: 'budget' } };
      try {
        global.Overseer = { snapshot: () => ({ workers: [], threads: [] }), fresh: () => true };
        const D = require('../frontend/app/delegated.js');
        // the delegated lamp's colour as beat-cards.css's cascade draws it: the most specific `.dg-lamp…` background rule (an :is() counts one
        // class) whose classes the lamp carries, the later one on a tie
        const css = read8('frontend/css/beat-cards.css'), lampRules = [];
        const LAMP = /\.dg-line \.dg-lamp((?:\.[\w-]+|:is\([^)]*\))+)\s*\{([^}]*)\}/g;
        for (let m = LAMP.exec(css); m; m = LAMP.exec(css)) {
          const bg = /background:\s*([^;]+)/.exec(m[2]); if (!bg) continue;
          const parts = m[1].match(/\.[\w-]+|:is\([^)]*\)/g);
          let alts = [[]];
          for (const p of parts) { const opts = /^:is/.test(p) ? p.slice(4, -1).split(',').map(x => x.trim().replace(/^\./, '')) : [p.slice(1)]; alts = alts.flatMap(a => opts.map(o => a.concat(o))); }
          lampRules.push({ alts, spec: parts.length, bg: bg[1].trim(), at: lampRules.length });
        }
        const lampOf = classes => { let best = null; for (const r of lampRules) if (r.alts.some(a => a.every(c => classes.includes(c))) && (!best || r.spec >= best.spec)) best = r; return best ? best.bg : 'default'; };
        const ws = o => Object.assign({ id: 'k', history: [], runIds: ['r'], agentId: 'a' }, o);
        const card = {};
        for (const [k, rec] of Object.entries(LEDGER)) {
          const w = Object.assign({ id: 'w-' + k, runId: 'r', agentId: 'c', leadId: 'agent' }, rec);
          D._internals.opened.add('b9-' + k);
          const html = D._internals.lineHtml({ lead: 'b9-' + k, rows: [{ ws: ws({ id: 'k9-' + k, title: 'Task' }), worker: w }] }, 'home');
          const st = D.stateOf({ ws: ws({ id: 'k9-' + k, title: 'Task' }), worker: w }, 'home', 'L');
          const rowLamp = (/<span class="dg-lamp ([^"]+)" aria-hidden="true"><\/span><span class="dg-li-who"/.exec(html) || [])[1] || '';
          card[k] = { cls: st.cls, word: st.live, tone: lampOf(rowLamp.split(/\s+/)), batch: (/<span class="dg-line-sum ([^"]+)">([^<]*)/.exec(html) || []).slice(1).join(': ') };
        }
        law('the delegated card over the ledger', { stopped: card.stopped, interrupted: card.restart, failed: card.failed, out_of_budget: card.out_of_budget }, { failTone: 'var(--bad)', stopTone: card.stopped.tone });
        law('the delegated card over the ledger (the liveness check)', { stopped: card.stopped, interrupted: card.stalled, failed: card.failed }, { failTone: 'var(--bad)', stopTone: card.stopped.tone });
        A.ok(card.restart.cls === 'interrupted' && card.stalled.cls === 'interrupted' && /restarted/.test(card.restart.word) && /no progress/.test(card.stalled.word)
          && ['restart', 'stalled'].every(k => !/^failed/.test(card[k].batch) && !/stopped/.test(card[k].batch)) && card.failed.tone === 'var(--bad)' && card.stopped.tone !== 'var(--bad)',
          'review 9: the delegated card says a worker a restart or the liveness check cut off as INTERRUPTED (its own lamp, never the failed red, never "1 stopped"); a stop is never red (got ' + JSON.stringify(card) + ')');
        // the HUD's worker and finished cards
        const H = require('../frontend/app/hudmode.js');
        const wk = (id, rec) => Object.assign({ id, runId: 'r-' + id, agentId: 'agent', completedAt: NOW - 1000, prompt: 'do ' + id }, rec);
        const items = H.workItems({ feed: H.createFeed(), now: NOW, workers: Object.entries(LEDGER).map(([k, rec]) => wk(k, rec)).concat([wk('weird', { status: 'weird' })]),
          finished: [{ runId: 'run-int', agentId: 'agent', reason: 'interrupted', outcome: 'interrupted', endedAt: NOW - 2000, title: 'cut off' }] });
        const hud = id => { const i = items.find(x => x.workerId === id || x.runId === id) || {}; return { word: i.status, tone: i.state === 'fault' ? 'bad' : i.state }; };
        law('the HUD\'s worker cards', { stopped: hud('stopped'), interrupted: hud('restart'), failed: hud('failed') }, { stopTone: 'stopped' });
        law('the HUD\'s worker cards (the liveness check)', { stopped: hud('stopped'), interrupted: hud('stalled'), failed: hud('failed') }, { stopTone: 'stopped' });
        law('the HUD\'s finished cards', { stopped: hud('stopped'), interrupted: hud('run-int'), failed: hud('failed') }, { stopTone: 'stopped' });
        A.ok(['restart', 'stalled', 'run-int'].every(id => hud(id).tone === 'interrupted') && hud('weird').tone !== 'stopped',
          'review 9: the HUD says a run or a worker a restart or the liveness check cut off as INTERRUPTED, never the fault red nor the stop\'s lamp; an ending it does not know is no stop (got ' + JSON.stringify(['restart', 'stalled', 'run-int', 'weird'].map(hud)) + ')');
        // NEEDS YOU, rendered over the same ledger
        const all = [{ id: 'p9', title: 'Launch', history: [], runIds: ['r0'], agentId: 'agent' }];
        global.Workstreams = { get: id => all.find(x => x.id === id) || null, list: () => all, unread: () => true, generalId: () => 'p9' };
        global.Overseer = { snapshot: () => ({ workers: [Object.assign({ runId: 'wr-restart', agentId: 'ops', parentStreamId: 'p9', completedAt: NOW - 500 }, RESTART),
          Object.assign({ runId: 'wr-stalled', agentId: 'ops', parentStreamId: 'p9', completedAt: NOW - 600 }, STALLED),
          Object.assign({ runId: 'wr-failed', agentId: 'ops', parentStreamId: 'p9', completedAt: NOW - 700 }, LEDGER.failed)], threads: [] }), fresh: () => true };
        delete global.GroupChat; delete global.StationUI; delete global.Chat;
        global.Delegated = D;
        const NY = require('../frontend/app/needsyou.js');
        const list = NY.items(NOW), html = NY._internals.html(list, NOW);
        const doorOf = key => { const m = new RegExp('data-ny-act="open" data-ny-key="' + key.replace(/[:.]/g, '\\$&') + '" aria-label="([^"]*)"').exec(html); return m ? m[1].split(':')[0] : '(none)'; };
        const row = key => list.find(i => i.key === key) || {};
        const ny = key => ({ word: row(key).what + ' / ' + doorOf(key), tone: /failed/i.test(doorOf(key)) ? 'bad' : /stopped/i.test(doorOf(key)) ? 'stop' : /did not finish/i.test(doorOf(key)) ? 'warn' : doorOf(key) });
        law('NEEDS YOU\'s worker rows over the ledger', { interrupted: ny('worker:wr-restart'), failed: ny('worker:wr-failed') }, { stopTone: 'stop' });
        law('NEEDS YOU\'s worker rows over the ledger (the liveness check)', { interrupted: ny('worker:wr-stalled'), failed: ny('worker:wr-failed') }, { stopTone: 'stop' });
        // the project home's worker cards
        const ph = functionSourceIn(read8('frontend/app/project-home.js'), 'workerEnd');
        const end = ph ? new Function('RunOutcome', ph + '\nreturn workerEnd;')(RunOutcome) : null;
        const home = {};
        if (end) for (const [k, rec] of Object.entries(LEDGER)) { const e = end(Object.assign({ id: k }, rec)); home[k] = { word: e[0], tone: e[1] === 'error' ? 'bad' : e[1] }; }
        if (end) law('the project home\'s worker cards over the ledger', { stopped: home.stopped, interrupted: home.restart, failed: home.failed }, { stopTone: 'stopped' });
        A.ok(!!end && home.restart.tone === 'interrupted' && home.stalled.tone === 'interrupted' && !/stale/i.test(home.restart.word + home.stalled.word) && home.stopped.tone === 'stopped',
          'review 9: the project home says a worker a restart or the liveness check cut off as interrupted in its own words, never the bare "stale"; a stop wears the stop\'s class (got ' + JSON.stringify(home) + ')');
        // A THREAD WITH NO OUTCOME: a 0.14.x save's lastRunOk true (no word) is the legacy delivered state; a run the page settles files its word
        const legacy = D.stateOf({ ws: ws({ id: 'k9-legacy', lastRunOk: true, lastRunReason: '' }), worker: null }, 'home', 'L');
        const W = require('../frontend/app/workstreams.js');
        const chat = read8('frontend/app/chat.js');
        const at = chat.indexOf('        const chipOc = '), endAt = at < 0 ? -1 : chat.indexOf('\n', chat.indexOf('Workstreams.noteRunEnd(ws.id, thisRunId, chipOk', at));
        const verdict = at >= 0 && endAt > at ? new Function('runOutcome', 'endReason', 'finishReason', 'thisRunId', 'ws', 'Workstreams', 'RunOutcome', chat.slice(at, endAt)) : null;
        const filed = {};
        for (const [k, e] of [['succeeded', ['succeeded', 'done', '']], ['asked', ['asked', 'clarifying', '']], ['cut_short', ['cut_short', 'done', 'length']]]) {
          W.reset();
          const t = W.create('t9-' + k, { kind: 'task', activate: false, worker: true }); W.appendRun(t.id, 'r9-' + k, 1);
          const s = W.get(t.id);
          if (verdict) verdict(e[0], e[1], e[2], 'r9-' + k, s, W, RunOutcome);
          filed[k] = D.stateOf({ ws: s, worker: null }, 'home', 'L').cls;
        }
        W.reset();
        A.ok(legacy.cls === 'recorded' && legacy.live === 'delivered' && !!verdict && filed.succeeded === 'done' && filed.asked === 'asked' && filed.cut_short === 'unfinished',
          'review 9: the delegated card reads lastRunOk true as done only when its outcome was filed with it — a 0.14.x thread (true for a question and a cut reply too, no word) is "delivered", never done; a run the page settles reads its outcome (got ' + JSON.stringify({ legacy, filed }) + ')');
      } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; } }
    }

    // r9.3 WORKVIEW (frontend/app/workview.js project, the real module, over the board's verdict lines — chat.js's, sliced, and noteStopReason;
    //      review 9 sweep): a FAILED run (lastRunOk false, a failure's alone since review r8) read "Run stopped or failed — review the
    //      conversation", and a question, a stop and every run that did not finish (no verdict, its outcome the word) read the same "Run outcome
    //      is unconfirmed"
    {
      const V = require('../frontend/app/workview.js');
      const W = require('../frontend/app/workstreams.js');
      const chat = read8('frontend/app/chat.js');
      const at = chat.indexOf('        const chipOc = '), endAt = at < 0 ? -1 : chat.indexOf('\n', chat.indexOf('Workstreams.noteRunEnd(ws.id, thisRunId, chipOk', at));
      const verdict = at >= 0 && endAt > at ? new Function('runOutcome', 'endReason', 'finishReason', 'thisRunId', 'ws', 'Workstreams', 'RunOutcome', chat.slice(at, endAt)) : null;
      const stopSrc = functionSourceIn(chat, 'noteStopReason');
      const noteStop = stopSrc ? new Function('Workstreams', 'RunOutcome', stopSrc + '\nreturn noteStopReason;')(W, RunOutcome) : null;
      const said = {};
      if (verdict && noteStop) for (const [k, e] of Object.entries(ENDS)) {
        W.reset();
        const t = W.create('wv-' + k, { kind: 'task', activate: false }); W.appendRun(t.id, 'r-' + k, 1);
        const s = W.get(t.id); s.lane = 'active';
        const end = Object.assign({}, e); if (k === 'failed') delete end.failureCode;
        verdict(end.outcome, end.reason, end.finishReason, 'r-' + k, s, W, RunOutcome);
        if (end.reason !== 'done' && end.reason !== 'clarifying') noteStop(s, 'stop line', 'r-' + k, end.reason);
        const row = V.project({ streams: [s] }).items[0] || {};
        said[k] = { word: row.status, tone: row.bucket };
      }
      W.reset();
      if (verdict && noteStop) law('WorkView over the board\'s verdict', said);
      A.ok(!!verdict && !!noteStop && /^Run failed/.test(said.failed.word) && /question/.test(said.asked.word) && /^Stopped/.test(said.stopped.word) && /spend cap/.test(said.out_of_budget.word)
        && said.succeeded.tone === 'finished' && Object.entries(said).every(([k, v]) => k === 'succeeded' || v.tone === 'needs-you'),
        'review 9: WorkView says a failed run failed (never "stopped or failed"), a question, a stop and a run that did not finish each as itself (never one "unconfirmed") (got ' + JSON.stringify(said) + ')');
    }

    // r9.4 COMMS' STOP LINE AND TOAST FOR AN END-ONLY REFUSAL (frontend/app/chat.js: the completed branch's chipOc / endWord and its stop block, sliced,
    //      with the real Friendly.stopLine; review 9.1 major): only noteStopReason read endWord — an end-only refusal (agent.run.end reason 'error',
    //      stamped 'refused') printed "⏹ it stopped on an error before it finished — try again" and toasted "run failed: …" / "ROOK failed — …" while
    //      the card said ■ REFUSED and the board filed 'refusal'
    {
      const chat = read8('frontend/app/chat.js');
      const Fr = require('../frontend/app/friendlyerror.js');
      const lineAt = needle => { const a = chat.indexOf(needle); return a < 0 ? '' : chat.slice(a, chat.indexOf('\n', a)); };
      const pre = ['        const chipOc = runOutcome ||', '        const endWord = '].map(lineAt);
      const c0 = chat.indexOf("        if (endReason && endReason !== 'done' && endReason !== 'clarifying' && !taskQuestion) {"), c1 = chat.indexOf("        } else if (chipOc === 'cut_short') {", c0);
      const block = c0 >= 0 && c1 > c0 ? chat.slice(c0, c1) + '        }\n' : '';
      const env = { unpricedModel: '', unpricedCapTokens: 0, subscriptionModel: '', subscriptionCapTokens: 0, budgetScope: 'run', budgetCapUsd: 1, budgetCapIsBalance: false, budgetProjected: false,
        stopSource: new Map(), interrupted: new Set(), runPressedEstop: false, callNames: {}, budgetStopLine: () => 'hit a spending limit', stoppedByLine: () => 'stopped by you', Friendly: Fr,
        breakLive() {}, markStoppedTurn() {}, replyText: 'partial', noteStopReason() {}, thisRunId: 'r1', offerUnpricedDoor() {}, offerBudgetDoor() {}, offerTryAgain() {},
        brief: x => String(x), whoOf: () => 'ROOK', sessionNote: () => '', taskQuestion: null, ws: { id: 'w' }, RunOutcome, presenceStoppedBy: null, goalStall: null };
      const names = Object.keys(env).concat(['runOutcome', 'endReason', 'finishReason', 'isActiveWs', 'toolLine', 'StationUI']);
      // (review 9.3: the stop line is endLogLine, sliced beside the block)
      const run = pre.every(Boolean) && block ? new Function(...names, pre.join('\n') + '\n' + (functionSourceIn(chat, 'endLogLine') || '') + '\n' + block + 'return goalStall;') : null;
      const drive = (stamp, reason, active) => {
        const lines = [], toasts = [];
        const goal = run ? run(...Object.values(env), stamp, reason, '', () => active, t => lines.push(t), { notify: t => toasts.push(t) }) : null;
        return { goal, lines: lines.join(' | '), toasts: toasts.join(' | ') };
      };
      const C = { refused: ['refused', 'error'], refusedEnd: ['refused', 'refusal'], failed: ['failed', 'error'], stopped: ['stopped', 'cancelled'], out_of_budget: ['out_of_budget', 'budget'],
        step_limit: ['step_limit', 'max_iters'], empty: ['empty', 'empty'] };
      const verbOf = t => (/^run (stopped|failed|did not finish)\b/.exec(t) || /^ROOK (stopped|failed|did not finish)\b/.exec(t) || [])[1] || '(none)';
      const fg = {}, bg = {};
      for (const [k, c] of Object.entries(C)) { const f = drive(c[0], c[1], true), b = drive(c[0], c[1], false); fg[k] = { word: f.toasts + ' / ' + f.lines, tone: verbOf(f.toasts) }; bg[k] = { word: b.toasts, tone: verbOf(b.toasts) }; }
      const refusalLine = Fr.stopLine('refusal');
      // (review 9.2: a FAILED run is under the law too — its line, Friendly.stopLine('error') in step with sidecar/stop-reason.js, read "it stopped on
      // an error before it finished", the stop's word, and this fold left it out. refusedEnd is the refused outcome over its other end word: it is
      // checked equal to the refused case below, never as an outcome of its own)
      for (const [where, said] of [['in the foreground', fg], ['in the background', bg]]) {
        const lawSaid = Object.assign({}, said); delete lawSaid.refusedEnd;
        if (run) law('COMMS\' stop toast ' + where, lawSaid, { failTone: 'failed', stopTone: 'stopped' });
      }
      A.ok(!!run && fg.refused.word.indexOf(refusalLine) >= 0 && !/on an error/.test(fg.refused.word + bg.refused.word) && fg.refused.tone === 'did not finish' && bg.refused.tone === 'did not finish'
        && fg.refused.word === fg.refusedEnd.word && fg.failed.tone === 'failed' && bg.failed.tone === 'failed' && !/\bstop/i.test(fg.failed.word + bg.failed.word) && fg.stopped.tone === 'stopped',
        'review 9.1: COMMS says an END-ONLY refusal as a refusal in its stop line and its toast ("the model declined…", "did not finish"), never "run failed: it stopped on an error"; a failure stays failed and is never said in the stop\'s word (review 9.2), a stop stopped (got ' + JSON.stringify({ fg, bg }) + ')');
      // the census's own check: in the completed branch, once endWord is decided, no stop line, verb or stop record reads the bare end reason through
      // RunOutcome, Friendly.stopLine or noteStopReason (a new reader of endReason there folds an end-only refusal into a failure again)
      const after = chat.slice(chat.indexOf('        const endWord = '), c1);
      const bare = after.match(/(?:RunOutcome\.(?:ofWord|resolve|look)|Friendly\.stopLine|noteStopReason)\([^)]*\bendReason\b[^)]*\)/g) || [];
      A.ok(c1 > 0 && bare.length === 0, 'review 9.1: the completed branch reads its END WORD (endWord), never the bare end reason, through RunOutcome / Friendly.stopLine / noteStopReason (got ' + JSON.stringify(bare) + ')');
    }
    // r9.5 THE HUD's FINISHED-RUN CARDS (frontend/app/hudmode.js workItems, the real module, over run-history rows; hudmode.css's card state; review
    //      9.1 majors): the card was keyed on RunOutcome.reasonOf — the bare reason whenever it was not 'done' — so an END-ONLY refusal (reason
    //      'error', stamped 'refused') was the red "Needs attention" fault; and a spend cap, a step limit, a refusal, an empty and a cut reply all
    //      wore the failure's fault red, two of them worded "Stopped at …" (the stop's word)
    {
      const H = require('../frontend/app/hudmode.js');
      const css = read8('frontend/css/hudmode.css');
      // the card's status colour as hudmode.css draws it: the last `.ph-card[data-state=…] .ph-status` colour rule (or :is() list) naming the state
      const colourOf = state => {
        let c = 'default';
        const RE = /#hud-activity \.ph-card(\[data-state="[\w-]+"\]|:is\([^)]*\)) \.ph-status \{([^}]*)\}/g;
        for (let m = RE.exec(css); m; m = RE.exec(css)) {
          const st = (m[1].match(/data-state="[\w-]+"/g) || []).map(x => x.slice(12, -1));
          const col = /(?:^|;)\s*color:\s*([^;]+)/.exec(m[2]);
          if (col && st.includes(state)) c = col[1].trim();
        }
        return c;
      };
      const T0 = 1700000000000;
      const rows = Object.entries(ENDS).map(([k, e], i) => Object.assign({ runId: 'f-' + k, agentId: 'agent', endedAt: T0 - 1000 - i, title: k }, e))
        .concat([{ runId: 'f-refusedEnd', agentId: 'agent', reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked', endedAt: T0 - 50, title: 'end-only refusal' },
          { runId: 'f-int', agentId: 'agent', reason: 'interrupted', outcome: 'interrupted', endedAt: T0 - 60, title: 'cut off' }]);
      // (in two feeds: the deck shows at most FINISHED_MAX finished cards)
      const items = [rows.slice(0, 6), rows.slice(6)].flatMap(finished => H.workItems({ feed: H.createFeed(), finished, now: T0 }));
      const card = id => { const i = items.find(x => x.runId === id) || {}; return { word: i.status, tone: i.state === 'fault' ? 'bad' : i.state, colour: colourOf(i.state) }; };
      const said = {}, drawn = {};
      for (const k of Object.keys(ENDS)) { said[k] = card('f-' + k); drawn[k] = { word: said[k].word, tone: said[k].colour }; }
      said.interrupted = card('f-int'); drawn.interrupted = { word: said.interrupted.word, tone: said.interrupted.colour };
      law('the HUD\'s finished cards', said, { stopTone: 'stopped' });
      law('the HUD\'s finished cards as hudmode.css draws them', drawn, { failTone: drawn.failed.tone, stopTone: drawn.stopped.tone });
      const endOnly = card('f-refusedEnd');
      A.ok(endOnly.word === said.refused.word && endOnly.tone !== 'bad' && said.failed.tone === 'bad' && said.failed.word === 'Needs attention'
        && ['out_of_budget', 'step_limit', 'refused', 'empty', 'cut_short'].every(k => !/^stopped/i.test(said[k].word) && drawn[k].tone !== drawn.failed.tone && drawn[k].tone !== 'default'),
        'review 9.1: the HUD says a run by its OUTCOME — an end-only refusal is "Refused", never the red "Needs attention"; a limit, a refusal, an empty and a cut reply are the warn card in their own words, never "Stopped at …" nor the failure red (got ' + JSON.stringify({ said, drawn, endOnly }) + ')');
    }
    // r9.6 AN END-ONLY REFUSAL AT EVERY READER OF RunOutcome.reasonOf (review 9.2 majors): reasonOf kept any reason but 'done' as it was, so an end-only
    //      refusal (agent.run.end reason 'error', stamped 'refused') reached every reason-keyed reader as 'error' — the HUD deck's FAULT, the logbook's
    //      "✕ error", `starnet watch`'s "■ error", the MCP bridge's and the bay docks' 'error' (the desk screen: r8.19; a recipe's last run: its fixture
    //      above; a routine's fire reason: the round-trip table's policy row) — while COMMS said ■ REFUSED and the board filed the refusal
    {
      const REFUSED_END = { reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked' };
      const words = Object.fromEntries(Object.entries(ENDS).map(([k, e]) => [k, RunOutcome.reasonOf(e)]));
      const resolver = { endOnly: RunOutcome.reasonOf(REFUSED_END), unstamped: RunOutcome.reasonOf({ reason: 'error', failureCode: 'model_refusal' }), stampedFailed: RunOutcome.reasonOf({ reason: 'error', outcome: 'failed' }),
        foreign: RunOutcome.reasonOf({ reason: 'cut_short' }), unknown: RunOutcome.reasonOf({ reason: 'timeout', outcome: 'failed' }) };
      A.ok(resolver.endOnly === 'refusal' && resolver.unstamped === 'refusal' && resolver.stampedFailed === 'error' && resolver.foreign === 'cut_short' && resolver.unknown === 'timeout'
        && words.refused === 'refusal' && words.failed === 'error' && words.succeeded === 'done' && words.cut_short === 'cut_short' && new Set(Object.values(words)).size === Object.keys(words).length,
        'review 9.2: RunOutcome.reasonOf says an end-only refusal (stamped, or carrying a refusal code) in the refusal\'s own end word, never \'error\'; every other end keeps its own word (got ' + JSON.stringify({ words, resolver }) + ')');
      // the HUD deck helper's recent row (hudmode.js onRunEnd + view, which no page mounts: a refusal's agent.run.error arrives first, then its end)
      const H = require('../frontend/app/hudmode.js');
      const deck = end => { const f = H.createFeed(); H.onRunError(f, { runId: 'r', agentId: 'agent' }, 1); H.onRunEnd(f, Object.assign({ runId: 'r', agentId: 'agent' }, end), 2); return (H.view(f, () => null, 3).recent[0] || {}).text; };
      // the logbook's RUNS word (windows/logbook.js runRow: its LB_REASON and its two word lines, sliced)
      const lb = read8('frontend/app/windows/logbook.js').split(/\r?\n/);
      const lbSrc = [/^\s*const LB_REASON = \{/, /^\s*const rk = .*RunOutcome\.reasonOf\(r\)/, /^\s*const rl = LB_REASON\[rk\]/].map(re => (lb.find(l => re.test(l)) || '').trim());
      const logbook = r => (lbSrc.every(Boolean) ? new Function('RunOutcome', 'esc', 'r', lbSrc.join('\n') + '\nreturn rl;')(RunOutcome, s => String(s), r) : '(no slice)');
      // `starnet watch` (bin/lib/station-commands.js, off /api/observe's view of the end)
      const { observerView } = require('../sidecar/observer.js');
      const { makeWatchFormatter } = require('../bin/lib/station-commands.js');
      const watch = end => makeWatchFormatter({ agent: 'NOVA' })({ name: 'agent.run.end', payload: observerView('agent.run.end', Object.assign({ runId: 'r', agentId: 'agent' }, end), {}) }, 0).join(' ');
      // the MCP bridge's conversations_list (sidecar/mcp/bridge-core.js), the bay docks (sidecar/routing/line-stats.js) and the insights tally
      // (sidecar/insights.js byReason: the logbook's OUTCOMES line), over run-history rows
      const { makeBridge, makeEventQueue } = require('../sidecar/mcp/bridge-core.js');
      const { lineStats } = require('../sidecar/routing/line-stats.js');
      const { foldInsights } = require('../sidecar/insights.js');
      const rowOf = (id, end) => Object.assign({ runId: id, agentId: 'agent', title: id, ts: 1, streamId: 's', dockId: 'b-' + id, lineId: 'L1', turns: 1, usd: 0 }, end);
      const rows = [rowOf('endOnly', REFUSED_END), rowOf('refused', ENDS.refused), rowOf('failed', ENDS.failed)];
      const bridge = makeBridge({ callSidecar: async () => ({ ok: true, status: 200, json: { runs: rows } }), queue: makeEventQueue({}) });
      const conv = ((await bridge.callTool('conversations_list', {})) || {}).conversations || [];
      const docks = lineStats({ rows, lines: [{ lineId: 'L1' }], since: 0 }).docks || {};
      const at = (k, e) => ({ deck: deck(e), logbook: logbook(e), watch: watch(e), bridge: (conv.find(c => c.session_key === k) || {}).reason, dock: (docks['b-' + k] || {}).reason,
        insights: Object.keys(foldInsights([rowOf(k, e)], { nowMs: 2 }).byReason || {}).join() });
      const got = { endOnly: at('endOnly', REFUSED_END), refused: at('refused', ENDS.refused), failed: at('failed', ENDS.failed) };
      const wrong = Object.keys(got.endOnly).filter(s => !got.endOnly[s] || got.endOnly[s] !== got.refused[s] || got.endOnly[s] === got.failed[s]);
      A.ok(!wrong.length && /■ refusal/.test(got.endOnly.watch) && got.endOnly.deck === 'REFUSED' && got.endOnly.bridge === 'refusal' && got.endOnly.dock === 'refusal',
        'review 9.2: every reader of RunOutcome.reasonOf says an end-only refusal as the refused run, never as the failed one — the HUD deck helper, the logbook, `starnet watch`, the MCP bridge, the bay docks and the insights tally (wrong: ' + JSON.stringify(wrong) + '; got ' + JSON.stringify(got) + ')');
    }
    // r9.7 THE HUD DECK HELPER's RECENT ROW (frontend/app/hudmode.js onRunEnd + view, the real module; no page mounts view; review 9.2 major): END_WORDS gave a spend cap, a turn
    //      limit, a refusal, an empty and a cut reply the failure's 'bad' tone ("one alarm colour", allowlisted with the reason 9.1 struck from FINISH),
    //      and an interrupted or held run — and any word it had none for — fell to the stop's 'dim'
    {
      const H = require('../frontend/app/hudmode.js');
      const row = end => { const f = H.createFeed(); H.onRunEnd(f, Object.assign({ runId: 'r', agentId: 'agent' }, end), 1); const r = H.view(f, () => null, 2).recent[0] || {}; return { word: r.text, tone: r.tone }; };
      const said = Object.fromEntries(Object.entries(ENDS).map(([k, e]) => [k, row(e)]));
      said.interrupted = row({ reason: 'interrupted', outcome: 'interrupted' });
      said.blocked = row({ reason: 'done', outcome: 'blocked' });
      const endOnly = row({ reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked' }), unknown = row({ reason: 'timeout' });
      law('the HUD deck helper\'s recent row (HudMode.view, not mounted)', said, { stopTone: 'dim' });
      A.ok(said.failed.tone === 'bad' && said.stopped.tone === 'dim' && ['cut_short', 'out_of_budget', 'step_limit', 'empty', 'refused', 'interrupted', 'blocked'].every(k => said[k].tone === 'warn')
        && endOnly.word === said.refused.word && endOnly.tone === 'warn' && unknown.tone !== 'dim' && unknown.tone !== 'ok',
        'review 9.2: the HUD deck helper (HudMode.view, not mounted) says a run that did not finish in the warn tone, each in its own word — never the failure\'s \'bad\'; the stop\'s dim is a stop\'s alone, and an end word the deck has none for is never a stop (got ' + JSON.stringify({ said, endOnly, unknown }) + ')');
    }
    // r9.8 THE RECIPE LAST-RUN HELPER (frontend/app/marketplace.js: the run cache line and lastRunHTML, sliced, no caller yet; marketplace.css's cascade; review 9.2 majors): the
    //      line's class came from the bare reason — a refusal and a cut reply the failure's red (.mkt-r-lastrun.bad), a spend cap, a step limit and an empty
    //      reply no class at all, the plain look of a success — and its word too (an end-only refusal "errored")
    {
      const mkt = read8('frontend/app/marketplace.js'), css = read8('frontend/css/marketplace.css');
      const mapLine = (mkt.split(/\r?\n/).find(l => /map\[id\] = \{ ts: Number\(row\.ts\)/.test(l)) || '').trim();
      const a = ['  const LAST_RUN_WORD = ', '  const RUN_REASON_WORD = '].map(n => mkt.indexOf(n)).find(i => i > 0) || -1, fnAt = mkt.indexOf('function lastRunHTML(r)'), b = mkt.indexOf('\n  }\n', fnAt) + 4;
      // the line's colour as marketplace.css draws it: the last `.mkt-r-lastrun(.<class>)*` colour rule whose classes the line carries
      const colourOf = cls => {
        let c = 'default';
        const RE = /^\s*\.mkt-r-lastrun((?:\.[\w-]+)*)\s*\{([^}]*)\}/gm;   // each rule opens its own line
        for (let m = RE.exec(css); m; m = RE.exec(css)) { const need = m[1].split('.').filter(Boolean), col = /(?:^|;)\s*color:\s*([^;]+)/.exec(m[2]); if (col && need.every(x => cls.includes(x))) c = col[1].trim(); }
        return c;
      };
      const rows = Object.entries(ENDS).map(([k, e]) => Object.assign({ recipeId: k, ts: 1, artifacts: [] }, e))
        .concat([{ recipeId: 'interrupted', ts: 1, reason: 'interrupted', outcome: 'interrupted', artifacts: [] }, { recipeId: 'blocked', ts: 1, reason: 'done', outcome: 'blocked', artifacts: [] },
          { recipeId: 'endOnly', ts: 1, reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked', artifacts: [] }]);
      const map = {};
      if (mapLine) for (const row of rows) new Function('map', 'id', 'row', mapLine)(map, row.recipeId, row);
      const lastRunHTML = (a > 0 && fnAt > a && b > fnAt) ? new Function('recipeRuns', 'scoutRelTime', 'artifactLabel', 'esc', 'recipeDrift', mkt.slice(a, b) + '\nreturn lastRunHTML;')(map, () => '', () => '', s => String(s), null) : null;
      const line = id => {
        const h = lastRunHTML ? lastRunHTML({ id }) : '';
        const cls = ((/class="mkt-r-lastrun([^"]*)"/.exec(h) || [])[1] || '').trim().split(/\s+/).filter(Boolean);
        return { word: h.replace(/<[^>]+>/g, '').split(' · ')[1] || '', cls: cls.join('.') || 'none', colour: colourOf(cls) };
      };
      const said = {}, drawn = {};
      for (const k of Object.keys(ENDS).concat(['interrupted', 'blocked'])) { const l = line(k); said[k] = { word: l.word, tone: l.cls }; drawn[k] = { word: l.word, tone: l.colour }; }
      const endOnly = line('endOnly');
      law('the recipe last-run helper (lastRunHTML, no caller)', said, { stopTone: said.stopped.tone });
      law('the recipe last-run helper as marketplace.css draws it', drawn, { failTone: drawn.failed.tone, stopTone: drawn.stopped.tone });
      const offLook = Object.keys(said).filter(k => said[k].tone !== RunOutcome.look(k).tone);
      A.ok(!!lastRunHTML && !offLook.length && endOnly.word === said.refused.word && endOnly.cls === said.refused.tone
        && ['cut_short', 'out_of_budget', 'step_limit', 'empty', 'refused', 'interrupted', 'blocked'].every(k => drawn[k].tone !== drawn.failed.tone && drawn[k].tone !== drawn.succeeded.tone),
        'review 9.2: the recipe last-run helper (lastRunHTML, no caller yet) wears its outcome\'s own word and RunOutcome.look\'s tone — a cut reply or a refusal never the failure\'s red, a limit or an empty reply never a success\'s plain look, an end-only refusal "refused" (off the look: ' + JSON.stringify(offLook) + '; got ' + JSON.stringify({ said, drawn, endOnly }) + ')');
    }
    // r9.9 AN IN-BAND REFUSAL's BACKGROUND TOAST AND ITS PHONE PUSH (frontend/app/chat.js send()'s in-band error branch, sliced; sidecar/index.js
    //      remoteNotify, sliced; review 9.2 major): both said a refused run in the failure's words — the toast "ROOK hit a problem: …" whatever the stamp
    //      (errOc) said, the push titled "<agent> hit a problem" for a failed and a refused run alike, an error flag over any stamped outcome — while the
    //      board filed the refusal
    {
      const chat = read8('frontend/app/chat.js');
      const i0 = chat.indexOf('        const errOc = (runOutcome'), nAt = chat.indexOf("StationUI.notify(isActiveWs(ws) ? brief(v.userMessage) : whoOf(ws) + ", i0), i1 = nAt < 0 ? -1 : chat.indexOf('\n', nAt);
      const inband = i0 >= 0 && i1 > i0 ? new Function('runOutcome', 'RunOutcome', 'thisRunId', 'Workstreams', 'StationUI', 'isActiveWs', 'whoOf', 'sessionNote', 'brief', 'v', 'ws', chat.slice(i0, i1)) : null;
      const toast = (stamp, k) => {
        const t = [];
        if (inband) inband(stamp, RunOutcome, '', undefined, { notify: (text, tone, cat, o) => t.push({ text, tone, alert: !!(o && o.kind === 'alert') }) }, () => false, () => 'ROOK', () => '', x => String(x), { userMessage: 'the ' + k + ' words' }, { id: 'w' });
        return t[0] || {};
      };
      const verbOf = t => (/^ROOK (hit a problem|stopped|did not finish)\b/.exec(t || '') || [])[1] || '(none)';
      const bg = {}, raw = {};
      for (const k of ['failed', 'refused', 'stopped', 'cut_short', 'out_of_budget', 'step_limit', 'empty']) { raw[k] = toast(k, k); bg[k] = { word: raw[k].text, tone: verbOf(raw[k].text) }; }
      const unstamped = toast('', 'unstamped');
      if (inband) law('COMMS\' in-band background toast', bg, { failTone: 'hit a problem', stopTone: 'stopped' });
      A.ok(!!inband && verbOf(unstamped.text) === 'hit a problem' && bg.failed.tone === 'hit a problem' && bg.refused.tone === 'did not finish' && raw.refused.tone === 'warn'
        && bg.stopped.tone === 'stopped' && raw.stopped.tone === '' && !raw.stopped.alert,
        'review 9.2: COMMS\' in-band background toast says a refused run "did not finish" and a stop "stopped" in the plain tone, never the failure\'s "hit a problem" (got ' + JSON.stringify({ raw, unstamped }) + ')');
      // the phone push (sidecar/index.js remoteNotify, sliced, as fold 4 above drives it)
      const src = sidecarTopLevelFunction('remoteNotify');
      const pushes = [];
      let notify = null;
      try {
        notify = new Function('remotePush', 'remoteApprovals', 'REMOTE_ASK_GRACE_MS', 'remotePushSend', 'remoteAskMessage', 'transcriptStore', 'failNote', 'TaskIntent', 'ForkMarkers', 'remoteAgentName', 'RunOutcome',
          src + '\nreturn remoteNotify;')({ subscribed: () => [{}] }, { list: () => [] }, 0, m => { pushes.push(m); }, () => ({}),
          { history: () => [{ role: 'assistant', content: 'Here is the first half of the answ' }] }, () => {}, { parse: () => null }, { parse: () => null, stripMarkers: s => s }, () => 'RESEARCHER', RunOutcome);
      } catch (e) { notify = null; }
      const titleOf = evt => { pushes.length = 0; if (notify) notify(Object.assign({ type: 'run.ended', runId: 'r', agentId: 'researcher', streamId: 's', usd: 0, error: null }, evt)); return pushes.length ? pushes[0].title : '(no push)'; };
      const toneOf = t => (/ hit a problem$/.test(t) ? 'problem' : / finished$/.test(t) ? 'finished' : 'its own');
      const EVT = { succeeded: { reason: 'done', outcome: 'succeeded' }, asked: { reason: 'clarifying', outcome: 'asked' }, cut_short: { reason: 'cut_short', outcome: 'cut_short' },
        out_of_budget: { reason: 'budget', outcome: 'out_of_budget' }, step_limit: { reason: 'max_iters', outcome: 'step_limit' }, empty: { reason: 'empty', outcome: 'empty' },
        refused: { reason: 'refusal', outcome: 'refused', failureCode: 'content_policy_blocked', error: 'the provider\'s safety system blocked this request' },
        failed: { reason: 'error', outcome: 'failed', failureCode: 'rate_limit', error: 'rate limited' } };
      const push = {};
      for (const [k, e] of Object.entries(EVT)) { const t = titleOf(e); push[k] = { word: t, tone: toneOf(t) }; }
      const budgetErr = titleOf({ reason: 'budget', outcome: 'out_of_budget', error: 'the spend cap was reached' }), olderFail = titleOf({ reason: 'error', error: 'boom' });
      if (notify) law('the phone push', push, { failTone: 'problem' });
      A.ok(!!notify && push.failed.tone === 'problem' && push.refused.tone === 'its own' && /declined/.test(push.refused.word) && push.succeeded.tone === 'finished'
        && toneOf(budgetErr) === 'its own' && /spending limit/.test(budgetErr) && toneOf(olderFail) === 'problem',
        'review 9.2: the phone push titles only a failed run "hit a problem" — a refused run says it was declined, and an error flag never overrides a stamped outcome that is no failure (got ' + JSON.stringify({ push, budgetErr, olderFail }) + ')');
    }
    // r9.10 A PRE-LANE ROUTINE RECORD ON THE ROUTINES CARD AND IN /routine (frontend/app/windows/routines.js lastResult, sliced with the card's own
    //       helpers; sidecar/slash-actions.js `/routine list`, the real module; review 9.3 major): a record a pre-lane station settled keeps no outcome,
    //       only lastStatus 'error' beside the fire's own end word (GET /api/cron sends it as stored). The card drew every such fire as the failure's
    //       red ✕ with the bare word ("✕ cancelled", "✕ budget", "✕ clarifying", a done+error "✕ done"), and /routine said "last error (…)" for a
    //       stamped or pre-lane spend cap, refusal or question alike
    {
      const LEGACY = { stopped: 'cancelled', asked: 'clarifying', cut_short: 'cut_short', out_of_budget: 'budget', step_limit: 'max_iters', empty: 'empty',
        refused: 'refusal', interrupted: 'interrupted', failed: 'done' };
      const rec = (id, o) => Object.assign({ id, name: id, agentId: 'agent', enabled: true, scheduleDisplay: 'every day', lastRunAt: '2023-11-14T22:14:20.000Z', lastStatus: 'error', lastError: 'run ended without completion [' + id + ']' }, o);
      const rt = read8('frontend/app/windows/routines.js');
      const fns = ['failedAs', 'endMark', 'recordOutcome', 'lastResult'].map(n => functionSourceIn(rt, n)).filter(Boolean);
      const lastResult = fns.some(f => /^\s*function lastResult\(/.test(f)) ? new Function('RunOutcome', 'esc', 'fmtRel', fns.join('\n') + '\nreturn lastResult;')(RunOutcome, v => String(v == null ? '' : v), () => '') : null;
      const toneOf = h => /--bad/.test(h) ? 'bad' : /class="dim"/.test(h) ? 'stop' : /--gold/.test(h) ? 'ask' : /--warn/.test(h) ? 'warn' : /class="pos"/.test(h) ? 'ok' : '?';
      const card = r => { const h = lastResult ? lastResult(r) : ''; const mark = (/^<span[^>]*>[^<]*<\/span>/.exec(h) || [''])[0]; return { word: mark.replace(/<[^>]+>/g, ''), tone: toneOf(mark) }; };
      const said = {};
      for (const [k, w] of Object.entries(LEGACY)) said[k] = card(rec(k, { lastReason: w }));
      // a reviewer's hold is always stamped. A bare 'blocked' is a security scan's refusal (cron-driver: status 'error', no outcome): a failure in its own word
      said.blocked = card(rec('hold', { lastReason: 'blocked', lastOutcome: 'blocked' }));
      const scanBlock = card(rec('scan', { lastReason: 'blocked', lastError: 'blocked by the security scan' }));
      const off = Object.keys(said).filter(k => said[k].tone !== RunOutcome.look(k).tone);
      const configBlock = card(rec('block', { lastReason: 'blocked_config', lastError: 'the agent has no model' }));
      if (lastResult) law('the ROUTINES card over a pre-lane record', said, { stopTone: 'stop' });
      A.ok(scanBlock.tone === 'bad' && /^✕ blocked$/.test(scanBlock.word), 'a security scan\'s block keeps the failure red "✕ blocked" on the ROUTINES card, never a reviewer\'s hold (got ' + JSON.stringify(scanBlock) + ')');
      A.ok(!!lastResult && !off.length && !/done/.test(said.failed.word) && configBlock.tone === 'bad' && /blocked_config/.test(configBlock.word),
        'review 9.3: the ROUTINES card draws a pre-lane record\'s fire by the outcome its own end word names (RunOutcome.look\'s glyph and tone), never the failure\'s red ✕ for a stop, a limit, a refusal or a question; a done beside error reads failed, never "done", and a config block keeps its words in the failure\'s mark (off the look: ' + JSON.stringify(off) + '; got ' + JSON.stringify({ said, configBlock }) + ')');
      // /routine list (the channel's and COMMS' readout): the same records, and the stamped ones beside them
      const { makeSlashActions } = require('../sidecar/slash-actions.js');
      const recs = Object.entries(LEGACY).map(([k, w]) => rec('legacy-' + k, { lastReason: w }))
        .concat(Object.keys(LEGACY).concat('blocked').map(k => rec('stamped-' + k, { lastReason: RunOutcome.reasonOf({ reason: 'done', outcome: k }), lastOutcome: k, lastFailureCode: k === 'failed' ? 'rate_limit' : '' })))
        .concat([rec('scan-block', { lastReason: 'blocked', lastError: 'blocked by the security scan' })]);
      const listed = await makeSlashActions({ cron: { jobs: () => recs, armed: () => true } }).run('routine', 'list', { agentId: 'agent' });
      const lineOf = id => ((listed && listed.lines) || []).find(l => l.indexOf('. ' + id + ' — ') > 0) || '';
      const tail = l => (/\]; (last .*)$/.exec(l) || [])[1] || '(none)';
      const toneOfLine = l => (/^last error\b/.test(l) ? 'failed' : /^last run stopped\b/.test(l) ? 'stop' : /^last run did not finish\b/.test(l) ? 'unfinished' : /^last run asked\b/.test(l) ? 'ask' : '?');
      const slash = {}, stamped = {};
      for (const k of Object.keys(LEGACY)) { const t = tail(lineOf('legacy-' + k)); slash[k] = { word: t, tone: toneOfLine(t) }; const s = tail(lineOf('stamped-' + k)); stamped[k] = { word: s, tone: toneOfLine(s) }; }
      { const s = tail(lineOf('stamped-blocked')); stamped.blocked = { word: s, tone: toneOfLine(s) }; slash.blocked = stamped.blocked; }   // a hold is stamped, so its row is the stamped one
      A.ok(/^last error \(/.test(tail(lineOf('scan-block'))), '/routine says a security scan\'s block as "last error (…)", never a reviewer\'s hold (got ' + tail(lineOf('scan-block')) + ')');
      law('/routine list over a pre-lane record', slash, { failTone: 'failed', stopTone: 'stop' });
      law('/routine list over a stamped record', stamped, { failTone: 'failed', stopTone: 'stop' });
      const posture = k => (k === 'failed' ? 'failed' : k === 'stopped' ? 'stop' : k === 'asked' ? 'ask' : 'unfinished');
      const wrong = Object.keys(LEGACY).concat('blocked').filter(k => slash[k].tone !== posture(k) || stamped[k].tone !== posture(k));
      A.ok(!wrong.length && /spending limit/.test(slash.out_of_budget.word) && /declined/.test(stamped.refused.word) && /rate_limit|run ended without completion/.test(stamped.failed.word),
        'review 9.3: /routine says a stop as stopped, a question as asked and every other unfinished fire as "did not finish" in its outcome\'s words — pre-lane or stamped — and only a failed fire "last error (…)" (wrong: ' + JSON.stringify(wrong) + '; got ' + JSON.stringify({ slash, stamped }) + ')');
    }
    // r9.11 THE BAY LAMP, ITS CRATE CARD AND THE LINE's COUNT (frontend/app/linewatch.js and sidecar/routing/line-stats.js, the real modules; world.js's
    //       LAMP and bayGlanceText, sliced; review 9.3 major): a refusal, a spend cap and a step limit lit the bay's FAILED lamp — "FAILED · BUDGET — CLICK
    //       TO CLEAR" in the failure red, blinking — live and after a reload, the crate card said "FAILED (refusal)" and the line plate counted each FAILED
    {
      const LW = require('../frontend/app/linewatch.js');
      const { lineStats } = require('../sidecar/routing/line-stats.js');
      const worldSrc = read8('frontend/app/world.js');
      const lampLine = (worldSrc.split(/\r?\n/).find(l => /^\s*const LAMP = \{ idle:/.test(l)) || '').trim();
      const glanceFn = functionSourceIn(worldSrc, 'bayGlanceText');
      const LAMP = lampLine ? new Function(lampLine + '\nreturn LAMP;')() : {};
      const END = Object.assign({}, ENDS, { endOnly: { reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked' } });
      // live: one bay per end, each run confirmed at its bay
      const live = LW.create();
      let t = 1000;
      for (const [k, e] of Object.entries(END)) {
        live.onEvent('workitem.placed', { workitemId: 'w-' + k, agentId: 'a-' + k, dockId: 'b-' + k, lineId: 'L1', kind: 'chain' }, t++);
        live.onEvent('agent.run.start', { agentId: 'a-' + k, runId: 'r-' + k }, t++);
        live.onEvent('agent.run.end', Object.assign({ agentId: 'a-' + k, runId: 'r-' + k }, e), t++);
      }
      // after a reload: the server's docks (line-stats over the same ends' rows) seed a fresh watch
      const rows = Object.entries(END).map(([k, e], i) => Object.assign({ runId: 'r-' + k, agentId: 'a-' + k, dockId: 'b-' + k, lineId: 'L1', ts: 5000 - i, durationMs: 1000 }, e));
      const stats = lineStats({ rows, lines: [{ lineId: 'L1' }], since: 0 });
      const seeded = LW.create();
      seeded.seedOutcomes(stats.docks);
      const glanceOf = w => (lampLine && glanceFn) ? new Function('lineWatch', 'lwNow', 'lwSecs', 'U', 'RunOutcome', lampLine + '\n' + glanceFn + '\nreturn bayGlanceText;')(() => w, () => t + 10, ms => ms + 'ms', { usd: n => '$' + n }, RunOutcome) : null;
      const lampsOf = w => { const g = glanceOf(w); return k => { const x = g ? g({ propId: 'b-' + k }) : null; return x ? { word: x.text, tone: x.col } : { word: '(none)', tone: '?' }; }; };
      const DEAD = ['failed', 'refused', 'out_of_budget', 'step_limit'];
      const said = {};
      for (const [where, lamp] of [['live', lampsOf(live)], ['seeded', lampsOf(seeded)]]) {
        const lit = Object.fromEntries(DEAD.map(k => [k, lamp(k)]));
        if (lampLine && glanceFn) law('the bay lamp (' + where + ')', lit, { failTone: LAMP.failed });
        said[where] = { lit, endOnly: lamp('endOnly'), dark: ['succeeded', 'asked', 'stopped', 'cut_short', 'empty'].filter(k => lamp(k).word !== 'IDLE') };
      }
      const steady = DEAD.filter(k => k !== 'failed').every(k => said.live.lit[k].tone === LAMP.unfinished && said.seeded.lit[k].tone === LAMP.unfinished
        && /CLICK TO CLEAR/.test(said.live.lit[k].word) && said.live.lit[k].word === said.seeded.lit[k].word && /SPEND CAP|STEP LIMIT|REFUSED/.test(said.live.lit[k].word));
      A.ok(!!(lampLine && glanceFn) && steady && said.live.lit.failed.tone === LAMP.failed && /^FAILED · ERROR/.test(said.live.lit.failed.word) && said.seeded.lit.failed.word === said.live.lit.failed.word
        && said.live.endOnly.word === said.live.lit.refused.word && said.seeded.endOnly.word === said.live.lit.refused.word && !said.live.dark.length && !said.seeded.dark.length,
        'review 9.3: the bay lamp lights FAILED only for a failed run — a refusal (an end-only one too), a spend cap and a step limit hold the bay in the warn lamp in their own word, live and after a reload; a stop, a question, a cut and an empty reply light nothing (got ' + JSON.stringify(said) + ')');
      // the line's count and plate, and the crate card of a dead run's slag crate
      const L1 = stats.lines[0] || {};
      const plate = (LW.plateLines(L1) || [])[0] || '';
      const names = { agentName: a => String(a).toUpperCase(), dockName: d => d, lineName: l => l, usd: n => '$' + n };
      const card = k => { const r = rows.find(x => x.runId === 'r-' + k); const c = LW.crateCard({ outbound: true, box: 'slag', agentId: r.agentId, dockId: r.dockId, runId: r.runId, reason: r.reason }, Object.assign({ run: null, row: r, nowMs: 0 }, names)); return { kind: c.kind, state: c.state, run: (c.rows.find(x => x[0] === 'RUN') || [])[1] || '' }; };
      const cards = Object.fromEntries(DEAD.concat(['endOnly']).map(k => [k, card(k)]));
      const lwCss = read8('frontend/css/linewatch.css');
      A.ok(L1.failed === 1 && L1.unfinished === 4 && /· 1 FAILED · 4 UNFINISHED$/.test(plate)
        && cards.failed.kind === 'FAILED RUN' && cards.failed.state === 'failed' && /FAILED \(error\)/.test(cards.failed.run)
        && ['refused', 'out_of_budget', 'step_limit', 'endOnly'].every(k => cards[k].kind === 'UNFINISHED RUN' && cards[k].state === 'unfinished' && /DID NOT FINISH \(/.test(cards[k].run) && !/FAILED/.test(cards[k].run))
        && /\.lw-card\[data-state="unfinished"\]\s*\{\s*--lw-accent:\s*var\(--warn/.test(lwCss),
        'review 9.3: the line counts a failed run FAILED and a refused or limited one UNFINISHED, and the crate card says a refusal or a limit did not finish in the warn accent, never "FAILED (refusal)" (got ' + JSON.stringify({ line: L1, plate, cards }) + ')');
    }
    // r9.12 THE FLOOR TICKER's RUN-END TONE CLASS (frontend/app/world.js: the agent.run.end listener and paintTicker, sliced; style.css's .cam-ticker rules; review
    //       9.3 major): the ticker had two tones, so a refusal, a cut reply, every limit, an empty reply, an interruption and a hold painted the failure's
    //       red (.cam-ticker--bad), and a stop and a question painted the success's plain line — allowlisted as "the HUD ticker's tone only", the reason
    //       9.1 struck from FINISH. This proves each run end carries its outcome's tone class and that class's own rule. It does not prove the colour on the
    //       page: `.cam-hud span` outranks `.cam-ticker--*`, so those rules lose today (B3-E01-01, follow-up)
    {
      const worldSrc = read8('frontend/app/world.js'), css = read8('frontend/css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');   // (rules only: a comment names colours too)
      const head = "U.bus.on('agent.run.end', p => {";
      let at = -1;
      for (let i = worldSrc.indexOf(head); i >= 0; i = worldSrc.indexOf(head, i + 1)) { const end = worldSrc.indexOf('\n    });', i); if (worldSrc.slice(i, end).indexOf('RUN COMPLETE') >= 0) { at = i; break; } }
      const src = at < 0 ? '' : worldSrc.slice(at, worldSrc.indexOf('\n    });', at) + '\n    });'.length);
      let on = null; const ticks = [];
      if (src) new Function('U', 'tickerName', 'runWorked', 'bumpShipped', 'pushTicker', 'tickerSuit', 'RunOutcome', src)(
        { bus: { on: (n, fn) => { if (n === 'agent.run.end') on = fn; } }, usd: v => '$' + v }, id => String(id).toUpperCase(), () => false, () => 1, (line, cls) => ticks.push([line, cls]), () => '', RunOutcome);
      // the classes paintTicker puts on the ticker for that tone (sliced, over a stand-in element; no timers, no motion)
      const paintFn = functionSourceIn(worldSrc, 'paintTicker');
      const tonesLine = (worldSrc.split(/\r?\n/).find(l => /^\s*const TICKER_TONES = /.test(l)) || '').trim();
      const paint = paintFn ? new Function('tickerEl', 'U', 'reduceMotion', 'performance', 'setTimeout', 'clearTimeout', 'TICKER_IDLE_MS',
        'let tickerLastPaint = 0, tickerFadeT = 0;\n' + tonesLine + '\n' + paintFn + '\nreturn paintTicker;') : null;
      const classesOf = cls => {
        const on2 = new Set();
        const el = { innerHTML: '', offsetWidth: 0, classList: { toggle: (c, f) => { if (f) on2.add(c); else on2.delete(c); }, add: (...c) => c.forEach(x => on2.add(x)), remove: (...c) => c.forEach(x => on2.delete(x)) } };
        if (paint) paint(el, { esc: v => String(v) }, () => true, { now: () => 0 }, () => 0, () => {}, 7000)('ROOK ▸ X', cls, '');
        return Array.from(on2).filter(c => c !== 'cam-ticker--on' && c !== 'cam-ticker--blip');
      };
      // the line's colour as style.css draws it: the base .cam-ticker rule, then the last .cam-ticker--<x> colour rule whose class the line carries
      const base = ((/^\.cam-ticker\s*\{([^}]*)\}/m.exec(css) || [])[1] || '');
      const baseColour = ((/(?:^|;|\n)\s*color:\s*([^;\n]+)/.exec(base) || [])[1] || 'none').trim();
      const colourOf = classes => {
        let c = baseColour;
        const RE = /^\.(cam-ticker--[\w-]+)\s*\{([^}]*)\}/gm;
        for (let m = RE.exec(css); m; m = RE.exec(css)) { const col = /(?:^|;)\s*color:\s*([^;]+)/.exec(m[2]); if (col && classes.includes(m[1])) c = col[1].trim(); }
        return c;
      };
      const tick = e => { ticks.length = 0; if (on) on(Object.assign({ agentId: 'rook', runId: 'r', turns: 0, usd: 0 }, e)); const t = ticks[ticks.length - 1] || ['(none)', '?']; return { word: t[0], cls: t[1], colour: colourOf(classesOf(t[1])) }; };
      const END = Object.assign({}, ENDS, { interrupted: { reason: 'interrupted', outcome: 'interrupted' }, blocked: { reason: 'done', outcome: 'blocked' } });
      const got = Object.fromEntries(Object.entries(END).map(([k, e]) => [k, tick(e)]));
      const said = Object.fromEntries(Object.entries(got).map(([k, g]) => [k, { word: g.word, tone: g.colour }]));
      law('the floor ticker\'s run-end tone class, by its own .cam-ticker rule', said, { failTone: said.failed.tone, stopTone: said.stopped.tone });
      const offLook = Object.keys(got).filter(k => got[k].cls !== RunOutcome.look(k).tone);
      const endOnly = tick({ reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked' });
      A.ok(!!on && !!paint && !offLook.length && said.succeeded.tone !== said.stopped.tone && said.asked.tone !== said.succeeded.tone && endOnly.colour === said.refused.tone
        && ['cut_short', 'out_of_budget', 'step_limit', 'empty', 'refused', 'interrupted', 'blocked'].every(k => said[k].tone !== said.failed.tone && said[k].tone !== said.stopped.tone && said[k].tone !== said.succeeded.tone),
        'review 9.3: each floor ticker run end carries its outcome\'s own tone class (RunOutcome.look) — a refusal, a cut reply or a limit never the failure\'s red, a stop and a question never the success\'s line (off the look: ' + JSON.stringify(offLook) + '; got ' + JSON.stringify({ got, endOnly }) + ')');
    }
    // r9.13 THE FLOOR's ERROR BEATS (frontend/app/world.js: the two agent.run.error listeners, sliced; review 9.3 major): keyed on the error event alone,
    //       never its code — a provider safety block (agent.run.error failureCode content_policy_blocked; the run ends refused) ticked "ROOK ▸ RUN FAULT · …"
    //       in red, strobed the desk red and had the agent say "something failed", while COMMS read ■ REFUSED in the warn tone
    {
      const worldSrc = read8('frontend/app/world.js');
      const slice = (head, must) => {
        let at = -1;
        for (let i = worldSrc.indexOf(head); i >= 0; i = worldSrc.indexOf(head, i + 1)) { const end = worldSrc.indexOf('\n    });', i); if (worldSrc.slice(i, end).indexOf(must) >= 0) { at = i; break; } }
        return at < 0 ? '' : worldSrc.slice(at, worldSrc.indexOf('\n    });', at) + '\n    });'.length);
      };
      const tickSrc = slice("U.bus.on('agent.run.error', p => {", 'RUN FAULT'), deskSrc = slice("U.bus.on('agent.run.error', p => {", 'flashDesk(');
      const quipLines = worldSrc.split(/\r?\n/).filter(l => /^\s*const (?:ERROR_LINE|DECLINED_LINE) = \[/.test(l)).map(l => l.trim()).join('\n');
      let onTick = null, onDesk = null; const ticks = [], flashes = [], says = [];
      const bus = set => ({ bus: { on: (n, fn) => { if (n === 'agent.run.error') set(fn); } }, pick: a => a[0] });
      if (tickSrc) new Function('U', 'pushTicker', 'tickerName', 'tickerClip', 'tickerSuit', 'RunOutcome', tickSrc)(bus(fn => { onTick = fn; }), (line, cls) => ticks.push([line, cls]), id => String(id).toUpperCase(), (s, n) => String(s).slice(0, n), () => '', RunOutcome);
      if (deskSrc) new Function('U', 'flashDesk', 'bodyForAgent', 'sayAt', 'performance', 'RunOutcome', quipLines + '\n' + deskSrc)(bus(fn => { onDesk = fn; }), (aid, col) => flashes.push(col), () => ({ say: null }), (b, text) => says.push(text), { now: () => 0 }, RunOutcome);
      const ERRS = { failed: { failureCode: 'rate_limit', message: 'rate limited' }, refused: { failureCode: 'content_policy_blocked', message: 'the provider\'s safety system blocked this request' },
        modelRefusal: { failureCode: 'model_refusal', message: 'the model declined' }, uncoded: { message: 'boom' } };
      const beat = e => { ticks.length = 0; flashes.length = 0; says.length = 0; const p = Object.assign({ agentId: 'rook', runId: 'r' }, e); if (onTick) onTick(p); if (onDesk) onDesk(p);
        const t = ticks[0] || ['(none)', '?']; return { tick: t[0], tone: t[1], flash: flashes[0] || '(none)', said: says[0] || '(none)' }; };
      const got = Object.fromEntries(Object.entries(ERRS).map(([k, e]) => [k, beat(e)]));
      law('the floor ticker\'s error beat', { failed: { word: got.failed.tick, tone: got.failed.tone }, refused: { word: got.refused.tick, tone: got.refused.tone } });
      law('the desk\'s error beat', { failed: { word: got.failed.said, tone: got.failed.flash }, refused: { word: got.refused.said, tone: got.refused.flash } }, { failTone: got.failed.flash });
      const quips = (/const ERROR_LINE = (\[[^\]]*\])/.exec(quipLines) || [])[1];
      const failQuips = quips ? new Function('return ' + quips)() : [];
      A.ok(!!onTick && !!onDesk && /RUN FAULT/.test(got.failed.tick) && got.failed.tone === 'bad' && got.uncoded.tone === 'bad' && failQuips.includes(got.failed.said)
        && ['refused', 'modelRefusal'].every(k => !/FAULT/.test(got[k].tick) && got[k].tone === RunOutcome.look('refused').tone && got[k].flash !== got.failed.flash && !failQuips.includes(got[k].said)),
        'review 9.3: the floor says a refusal it declined — the warn tone, no "RUN FAULT", no red desk strobe, no failure quip — reading the error\'s code, never the error event alone; a failure keeps its fault beat (got ' + JSON.stringify(got) + ')');
    }
    // r9.14 COMMS' WORK-LOG END LINE, LIVE AND AFTER A RELOAD (frontend/app/chat.js: the completed branch's chain with endLogLine, sliced; noteStopReason
    //       and endLogLine, sliced, for the replay; review 9.3 major): every end but done and a question printed "⏹ " + its line in one plain class — a
    //       failure "⏹ it hit an error before it finished" (9.2-1's own sentence), a spend cap, a refusal, a step limit, an empty and a cut reply the
    //       same — and a reload replayed each as "⏹ …": the Stop control's glyph on a failure, told apart by words alone
    {
      const chat = read8('frontend/app/chat.js');
      const Fr = require('../frontend/app/friendlyerror.js');
      const lineAt = needle => { const a = chat.indexOf(needle); return a < 0 ? '' : chat.slice(a, chat.indexOf('\n', a)); };
      const pre = ['        const chipOc = runOutcome ||', '        const endWord = ', '        const cutShort = finishReason ===', '        const postconditionUnmet = '].map(lineAt);
      const c0 = chat.indexOf("        if (endReason && endReason !== 'done' && endReason !== 'clarifying' && !taskQuestion) {"), c1 = chat.indexOf('        // a CLEAN end that hit an unwired connector mid-run');
      const helper = functionSourceIn(chat, 'endLogLine') || '';
      const env = { unpricedModel: '', unpricedCapTokens: 0, subscriptionModel: '', subscriptionCapTokens: 0, budgetScope: 'run', budgetCapUsd: 1, budgetCapIsBalance: false, budgetProjected: false,
        stopSource: new Map(), runPressedEstop: false, callNames: {}, budgetStopLine: () => 'hit the $1 per-run spend cap', stoppedByLine: () => 'stopped by you', Friendly: Fr,
        breakLive() {}, markStoppedTurn() {}, replyText: 'partial', noteStopReason() {}, thisRunId: 'r1', offerUnpricedDoor() {}, offerBudgetDoor() {}, offerTryAgain() {},
        brief: x => String(x), whoOf: () => 'ROOK', sessionNote: () => '', notedRuns: new Set(), effectVerdict: 'no_observed_effects', RunOutcome };
      const names = Object.keys(env).concat(['runOutcome', 'endReason', 'finishReason', 'opts', 'completionVerdict', 'taskQuestion', 'interrupted', 'ws', 'isActiveWs', 'toolLine', 'StationUI', 'goalStall', 'presenceStoppedBy']);
      const chain = c0 >= 0 && c1 > c0 && pre.every(Boolean) ? new Function(...names, pre.join('\n') + '\n' + helper + '\n' + chat.slice(c0, c1) + '\nreturn goalStall;') : null;
      // what the line shows: its mark (the first glyph) and its class (toolLine: err, ask, warn, or the plain dim line)
      const shown = (t, err, tone) => ({ word: t, tone: String(t).slice(0, 1) + '/' + (err ? 'err' : (tone === 'ask' || tone === 'warn') ? tone : 'plain') });
      const C = { failed: ['failed', 'error', ''], stopped: ['stopped', 'cancelled', ''], cut_short: ['cut_short', 'done', 'length'], out_of_budget: ['out_of_budget', 'budget', ''],
        step_limit: ['step_limit', 'max_iters', ''], empty: ['empty', 'empty', ''], refused: ['refused', 'refusal', ''], endOnly: ['refused', 'error', ''] };
      const live = k => { const c = C[k], out = []; if (chain) chain(...Object.values(env), c[0], c[1], c[2], null, 'incomplete', null, new Set(), { id: 'w' }, () => true, (t, err, tone) => out.push(shown(t, err, tone)), { notify() {} }, null, null); return out[0] || { word: '(none)', tone: '?' }; };
      const said = Object.fromEntries(Object.keys(C).map(k => [k, live(k)]));
      const endOnly = said.endOnly; delete said.endOnly;
      if (chain) law('COMMS\' work-log end line', said, { failTone: said.failed.tone, stopTone: said.stopped.tone });
      // after a reload: noteStopReason keeps the end word on the stopped turn, and renderHistory replays the line through endLogLine
      const nsr = functionSourceIn(chat, 'noteStopReason');
      const replay = (note, word) => {
        const out = [];
        if (!nsr || !helper) return { word: '(no slice)', tone: '?' };
        const ws = { id: 'w', history: [{ role: 'assistant', content: 'partial', stopped: true }] };
        new Function('RunOutcome', 'Workstreams', 'toolLine', nsr + '\n' + helper + '\nreturn { noteStopReason, endLogLine };')(RunOutcome, undefined, (t, err, tone) => out.push(shown(t, err, tone))).noteStopReason(ws, note, '', word);
        const m = ws.history[0];
        new Function('RunOutcome', 'toolLine', helper + '\nreturn endLogLine;')(RunOutcome, (t, err, tone) => out.push(shown(t, err, tone)))(m.stopNote, m.stopWord);
        return out[0] || { word: '(none)', tone: '?' };
      };
      const again = { failed: replay(said.failed.word.slice(2), 'error'), stopped: replay(said.stopped.word.slice(2), 'cancelled'), out_of_budget: replay(said.out_of_budget.word.slice(2), 'budget'), refused: replay(said.refused.word.slice(2), 'refusal') };
      const replaySites = (chat.match(/endLogLine\(m\.stopNote, m\.stopWord\)/g) || []).length;
      const unmarked = (chat.match(/toolLine\('⏹ '/g) || []).length;
      A.ok(!!chain && said.failed.tone === '✕/err' && said.stopped.tone === '⏹/plain' && ['cut_short', 'out_of_budget', 'step_limit', 'empty', 'refused'].every(k => said[k].tone === '⚠/warn')
        && endOnly.tone === said.refused.tone && Object.keys(again).every(k => again[k].tone === said[k].tone && again[k].word === said[k].word) && replaySites === 2 && unmarked === 0,
        'review 9.3: COMMS\' work log marks each end by its outcome — ⏹ a stop\'s alone, ✕ a failure in the failure red, ⚠ a refusal, a limit, an empty or a cut reply in the warn tone — and a reload replays the same mark (got ' + JSON.stringify({ said, endOnly, again, replaySites, unmarked }) + ')');
    }
    // r9.15 THE PHONE's FINISHED WORK AND ITS END TOAST (sidecar/remote/host.js activity(), the real module; relay/app/app.js endLook and the run.ended
    //       toast, sliced; relay/app/app.css's cascade; review 9.3 major): host.js folds a row's outcome into the relay's three states, and the phone read
    //       the state alone — every unfinished outcome (a spend cap, a refusal, a cut reply) the failure red under "Did not finish", the words a failed
    //       run read too ("Did not finish · rate_limit"), and a refusal's safety message toasted red
    {
      const { makeRemoteHost } = require('../sidecar/remote/host.js');
      const phone = read8('relay/app/app.js'), pcss = read8('relay/app/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
      const END = Object.assign({}, ENDS, { interrupted: { reason: 'interrupted', outcome: 'interrupted' }, endOnly: { reason: 'error', outcome: 'refused', failureCode: 'content_policy_blocked' } });
      const rows = Object.entries(END).map(([k, e], i) => Object.assign({ runId: 'h-' + k, agentId: 'forge', title: k, deliveryText: k === 'succeeded' ? 'Here is the plan' : k === 'asked' ? 'Which file should I edit?' : '',
        startedAt: 10, endedAt: 1000 - i }, e));
      const host = makeRemoteHost({ now: () => 2000, newId: () => 'x', broadcast: () => {}, roster: () => [{ agentId: 'forge', name: 'FORGE' }], liveRuns: () => [],
        transcript: { streams: () => [], history: () => [] }, deskSessions: () => [], runHistory: () => rows });
      let act = {}; try { act = await host.activity({ limit: 30 }); } catch (_) { act = {}; }
      const done = (act && act.done) || [];
      const consts = phone.split(/\r?\n/).filter(l => /^\s*const (?:STATE_TONE|TONES) = \{/.test(l)).map(l => l.trim()).join('\n');
      const fn = functionSourceIn(phone, 'endLook');
      const endLook = fn ? new Function(consts + '\n' + fn + '\nreturn endLook;')() : null;
      // the row as the phone draws it: endLook's line (else the result line) and the `why <tone>` class through app.css (colour + opacity)
      const lookOf = cls => { let col = 'inherit', op = '1'; const RE = /^\.act \.row \.t span\.why\.([\w-]+)\s*\{([^}]*)\}/gm;
        for (let m = RE.exec(pcss); m; m = RE.exec(pcss)) if (m[1] === cls) { const c = /color:\s*([^;]+)/.exec(m[2]), o = /opacity:\s*([^;]+)/.exec(m[2]); if (c) col = c[1].trim(); if (o) op = o[1].trim(); }
        return col + '@' + op; };
      const said = {}, cls = {};
      for (const k of Object.keys(END)) {
        const w = done.find(r => r.runId === 'h-' + k) || {};
        const look = endLook ? endLook(w) : { tone: w.state, line: '' };
        said[k] = { word: look.line || w.result || '(none)', tone: lookOf(look.tone) };
        cls[k] = look.tone;
      }
      const endOnly = said.endOnly; delete said.endOnly;
      law('the phone\'s finished work as app.css draws it', said, { failTone: said.failed.tone, stopTone: said.stopped.tone });
      // a v0.14.x station sends no tone and no outcome: its state keeps the words the phone always read, in the old red for a failure
      const older = st => (endLook ? endLook({ state: st, error: 'rate_limit' }) : {});
      A.eq([older('failed').line, older('failed').tone, older('stopped').line, older('stopped').tone, older('done').line, older('done').tone],
        ['Did not finish · rate_limit', 'bad', 'Stopped', 'stop', '', 'ok'], 'an older station\'s run keeps the phone\'s old words: "Did not finish" in red, "Stopped", and a finished run its result line');
      // the run.ended toast (its own line, sliced) over the station's run.ended: the tone host.js sends, an older station's outcome, none at all
      const tl = (phone.split(/\r?\n/).find(l => /^\s*if \(e\.error\) .*toast\(agentName\(e\.agentId\)/.test(l)) || '').trim();
      const toastOf = e => { let got = '(none)'; if (tl && endLook) new Function('e', 'toast', 'agentName', 'endLook', tl)(e, (m, bad) => { got = bad === 'warn' ? 'warn' : bad ? 'bad' : 'plain'; }, () => 'FORGE', endLook); return got; };
      const ended = (outcome, extra) => Object.assign({ type: 'run.ended', agentId: 'forge', error: 'the provider\'s safety system blocked this request', outcome, tone: RunOutcome.look(outcome).tone }, extra);
      const toasts = { refused: toastOf(ended('refused')), failed: toastOf(ended('failed')), stopped: toastOf(ended('stopped')), out_of_budget: toastOf(ended('out_of_budget')),
        olderRefused: toastOf({ type: 'run.ended', agentId: 'forge', error: 'blocked', outcome: 'refused' }), oldest: toastOf({ type: 'run.ended', agentId: 'forge', error: 'boom' }) };
      const hostSends = /tone: RunOutcome\.look\(oc\)\.tone \}/.test(sidecarRead8('sidecar/remote/host.js')) && /outcome: oc\.outcome, tone: RunOutcome\.look\(oc\)\.tone/.test(sidecarRead8('sidecar/remote/host.js'));
      const offLook = Object.keys(cls).filter(k => k !== 'endOnly' && cls[k] !== RunOutcome.look(k).tone);
      A.ok(!!endLook && done.length === Object.keys(END).length && !offLook.length && cls.endOnly === 'warn' && /^Failed/.test(said.failed.word) && /^Did not finish · hit a spending limit/.test(said.out_of_budget.word)
        && !/^Did not finish/.test(said.failed.word) && toasts.refused === 'warn' && toasts.failed === 'bad' && toasts.stopped === 'plain' && toasts.out_of_budget === 'warn'
        && toasts.olderRefused === 'warn' && toasts.oldest === 'bad' && hostSends,
        'review 9.3: the phone says each finished run in its outcome\'s own words and tone (the station sends RunOutcome.look\'s tone) — a failure "Failed" in red, a spend cap, a refusal or a cut reply "Did not finish" in the warn tone, a stop dim — and toasts a refusal in the warn tone, never the failure red (off the look: ' + JSON.stringify(offLook) + '; got ' + JSON.stringify({ said, cls, endOnly, toasts, hostSends }) + ')');
    }
  }

  // the page's step-test panel parses a reviewer step's verdict with its own pattern: BLOCKED must read as a hold, never flow on
  const panel = fs.readFileSync(path.join(ROOT, 'frontend/app/workflowpanel.js'), 'utf8');
  const vm = /const v = (\/VERDICT:[^\n]*?\/i)\.exec\(t\.output/.exec(panel);
  const verdictRe = vm ? new Function('return ' + vm[1])() : null;
  const got = verdictRe ? verdictRe.exec('Not shippable: it deletes the backup.\n\nVERDICT: BLOCKED') : null;
  A.ok(!!got && /^blocked$/i.test(got[1]), 'the step-test panel reads VERDICT: BLOCKED (the third canonical verdict), never as no verdict');
  A.ok(/A reviewer BLOCKED this: on the line the work would be HELD here/.test(panel), 'a BLOCKED step test says the line would hold the work, never that it flows on');

  A.report('outcome-family.census.test');
})().catch(e => { console.log('FAIL: unexpected throw — ' + (e && e.stack || e)); process.exit(1); });
