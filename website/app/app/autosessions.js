/* STARNET — autosessions.js : surface an UNATTENDED cron/routine run as a readable SESSION.

   THE BUG THIS CLOSES. A cron routine fires headless (cron-driver.js fireJob → runOnce with
   surface:'autonomous', trigger:'schedule'; RUN NOW — POST /api/cron/run — runs the same unattended
   path and stream, labelled trigger:'manual'). Its reply text is buffered server-side and only an
   OUTCOME enum escapes on cron.result — so the Commander hears the HUD chime + the away-digest
   toast but can never READ what the routine actually produced. There was no session, no thread,
   no output. This module makes an unattended run appear as a real workstream the instant it fires
   (rail row, marked busy) and folds its durable transcript into that session when it completes —
   Claude-Code / reference-harness session-list parity.

   HOW IT WORKS (no new events; the contract is OWNED). The sidecar now runs every cron fire under
   a PER-RUN stream id 'cron-<runId>' (cron-driver.js), so its dialogue persists durably via the
   same transcriptStore every attended run uses. This layer is a READ-ONLY citizen of U.bus:
     · cron.fire {jobId, runId}  → ADOPT a workstream id 'cron-<runId>' (title = routine name from
       the /api/cron catalogue, agentId = the job's agent, lane 'active', history seeded with the
       routine's prompt as the user turn) and mark it busy — WITHOUT stealing the Commander's
       focus. The rail row appears immediately.
     · cron.result {jobId, runId, outcome} → GET /api/transcript?stream=cron-<runId>, fold the
       assistant turns into that session's history in chat.js's exact shape, clear busy, persist,
       re-render. A 'failed' outcome appends an honest error line; a bare '[SILENT]' reply is
       shown as a quiet marker (truthful telemetry — never fake content, never hidden real content).
     · BOOT BACKFILL: on init, read /api/runs?agent=*, and for every run whose streamId starts
       'cron-' with no live session, adopt + backfill it — so routines that ran while the browser
       was CLOSED are also readable. Bounded + fail-open (a route error → no crash, no fake rows).

   Follows the *store.js wiring pattern (returnstore/autojobstore): a plain init()/reset() surface,
   never .emit()s (lint-emits stays green), self-contained, reads the same /api routes the return
   ritual reads. Depends on the Workstreams / Channels / Chat / App globals loaded before it. */
'use strict';
const AutoSessions = ((TurnMerge) => {
  const STREAM_PREFIX = 'cron-';
  let routines = null;         // jobId -> { name, agentId, prompt } cache from /api/cron (lazy)
  let wired = false;           // U.bus subscriptions installed once
  let backfilling = false;     // in-flight boot backfill guard (idempotent)
  let catalogueRead = false;   // the last loadRoutines read /api/cron (its inFlight / record are the station's now, not a stale cache)

  // presence guards use `typeof X` (bare identifier) — App/Chat are top-level `const`s, NOT window props,
  // so `window.App` is undefined even though the `App` binding resolves. Match how chat.js probes App.
  const hasWS = () => typeof Workstreams !== 'undefined' && Workstreams;
  const hasCh = () => typeof Channels !== 'undefined' && Channels;
  const hasChat = () => typeof Chat !== 'undefined' && Chat;
  const hasApp = () => typeof App !== 'undefined' && App;
  const hasU = () => typeof U !== 'undefined' && U && U.bus && U.bus.on;
  const streamOf = (runId) => STREAM_PREFIX + String(runId);
  // 'cron-' + a runId (crypto.randomUUID: hex + hyphens) fits the workstream/stream grammar (/^[A-Za-z0-9_-]{1,64}$/).
  function validStream(id) { return /^cron-[A-Za-z0-9_-]{1,58}$/.test(String(id || '')); }
  /* how a run-history row settles its routine's session (review 5.3): the row's ONE outcome, the rule a fire's record keeps (fireOfRecord)
     — only a SUCCEEDED run is ok; a cut, budget, step-limit, refused, empty, asking or unproven row failed (cron-driver fireOutcome fails
     every fire that did not succeed, so the live cron.result did); a stop someone made (Stop / E-STOP) is no verdict, as Workstreams keeps it
     — carried as 'stopped' (review r7), so a fire stopped before it said anything says so, never the clean "nothing to report" marker */
  function settledAs(o) { return o.ok ? 'ok' : (o.outcome === 'stopped' ? 'stopped' : 'failed'); }
  function outcomeOfRun(run) {
    if (!run) return null;
    if (run.error || run.reason === 'error' || run.reason === 'failed') return 'failed';
    if (typeof RunOutcome !== 'undefined') return settledAs(RunOutcome.ofRow(run));
    return run.reason === 'done' ? 'ok' : null;   // no resolver loaded (a node harness; the page loads runoutcome.js before this file)
  }
  // why a run-history row's routine failed, for its session's marker (review 5.1): the row's error, else its outcome-aware end word
  // (RunOutcome.reasonOf) — a row keeps no error field, so a cut row's reload marker read "⚠ Routine failed — done"
  function whyOfRun(run) { return (run && run.error) || (typeof RunOutcome !== 'undefined' ? RunOutcome.reasonOf(run) : (run && run.reason)); }
  /* THE FIRE'S OWN OUTCOME (review 5.2). A routine's session is named after its FIRE, and a fire's outcome is its routine's record
     (cron-driver finishFire -> markRun: lastRunId / lastStatus / the outcome-aware lastReason), not its entry run's history row: a
     line a reviewer held (VERDICT: blocked) ends its entry run 'succeeded', so a reload or a busy reconcile read the held fire as a
     success after the live cron.result had said "⚠ Routine failed — blocked". A record holds only its routine's LAST fire; an older
     fire falls back to its row, which on its own never clears a failure the session already settled for that run (settleOf).
     ONLY A RECORD THAT KEEPS ITS FIRE'S OUTCOME SPEAKS FOR IT (review 5.3), the rule GET /api/cron/history and the away briefing read: a
     config block (cron-store markBlockedConfig) or an unfireable mark (markUnfireable) runs no fire, yet writes lastStatus 'error' beside
     the PREVIOUS fire's lastRunId — keyed on lastStatus, a routine blocked after a clean fire failed that fire's session on the next reload.
     Both null lastOutcome; a record with none falls back to the fire's row.
     THE FIRE'S RECEIPT (review 6.1): both marks null lastOutcome beside the previous fire's lastRunId, so a HELD fire (whose row reads
     'succeeded') fell back to its row and read ok once its routine was blocked. The record's lastFire (cron-store markRun /
     markInterrupted; the sidecar's lastFireOf, which the away briefing and RUN HISTORY read) keeps the fire's outcome and reason bound to
     its runId; a record settled before the receipt keeps them in lastOutcome / lastReason.
     THE FIRES' RECEIPTS (review 6.2): lastFire is the LAST fire's only, so a held fire fell back to its row and read ok once its routine
     fired again — the routine's normal next event (a daily digest held on Monday read ok from Tuesday on). The record also keeps the
     receipt of each recent fire that did not succeed (cron-store fireReceipts / firesOf, which RUN HISTORY and the away briefing read);
     a fire with none succeeded, or is older than the record keeps, and reads its row. */
  function receiptOf(j) {
    if (!j || !j.lastRunId) return null;
    const f = j.lastFire;
    if (f && typeof f === 'object' && String(f.runId || '') === String(j.lastRunId)) return f;
    return { runId: j.lastRunId, outcome: j.lastOutcome, reason: j.lastReason };
  }
  function receiptsOf(j) {
    const last = receiptOf(j);
    const ring = (j && Array.isArray(j.fireReceipts) ? j.fireReceipts : [])
      .filter(f => f && typeof f === 'object' && f.runId != null && String(f.runId) && (!last || String(f.runId) !== String(last.runId)));
    return last ? ring.concat([last]) : ring;
  }
  function settledFire(f) {
    if (!f || typeof RunOutcome === 'undefined' || !RunOutcome.isOutcome(f.outcome)) return null;
    // a record written before review 5.1 kept lastReason 'done' beside a cut outcome (routines.js packJob reads it the same way)
    const why = RunOutcome.reasonOf({ reason: f.reason, outcome: f.outcome });
    return { runId: String(f.runId), outcome: settledAs({ ok: f.outcome === 'succeeded', outcome: f.outcome }), why: why, byFire: true };
  }
  function firesOfRecord(j) { return receiptsOf(j).map(settledFire).filter(Boolean); }
  /* is this run the fire its routine runs RIGHT NOW (review 5.3)? GET /api/cron names the fire holding the routine's lease (inFlightRunId:
     a settlement still waiting to persist included, which is not on the record yet); an older station says only inFlight. The entry run's
     row lands before its work line has run, so for that fire the row is no settlement. */
  function stillFiring(job, runId) {
    if (!job) return false;
    if (job.inFlightRunId) return job.inFlightRunId === String(runId);
    return job.inFlight === true;
  }
  function fireOf(runId) {
    const id = String(runId || '');
    if (!id || !routines) return null;
    for (const k of Object.keys(routines)) { const fires = (routines[k] && routines[k].fires) || []; for (const f of fires) if (f.runId === id) return f; }
    return null;
  }
  // how a cron session's defining run settles: its fire's outcome, else its run-history row's (null row: no verdict)
  function settleOf(ws, runId, run) {
    const fire = fireOf(runId);
    if (fire) return fire;
    const outcome = outcomeOfRun(run);
    const ids = (ws && Array.isArray(ws.runIds)) ? ws.runIds : [];
    const last = ids[ids.length - 1];
    // (review r8: a fire that did not finish settles no verdict with its outcome's word — lastRunReason — and is as unsuccessful as a failure)
    const settledFailed = !!ws && (ws.lastRunOk === false || (ws.lastRunOk == null && !!ws.lastRunReason)) && (last === runId || last === ws.id);
    return { outcome: (outcome === 'ok' && settledFailed) ? null : outcome, why: whyOfRun(run), byFire: false };
  }
  // A cron stream is named after ONE real run. Repair legacy stream-as-run ids, but never settle a
  // later attended follow-up using the earlier scheduled run's outcome.
  function recordOutcome(ws, outcome, endedAt, why) {
    if (!ws || !validStream(ws.id) || !hasWS()) return;
    const runId = ws.id.slice(STREAM_PREFIX.length);
    const ids = Array.isArray(ws.runIds) ? ws.runIds : [];
    if (ids.includes(ws.id)) ws.runIds = ids.map(id => id === ws.id ? runId : id).filter((id, i, all) => all.indexOf(id) === i);
    const current = ws.runIds || ids;
    if (current.length && current[current.length - 1] !== runId) return;
    if (Workstreams.appendRun) Workstreams.appendRun(ws.id, runId, endedAt);
    // noteRunEnd accepts a boolean, so unknown must never be passed through as false (or true).
    if (Workstreams.noteRunEnd && (outcome === 'ok' || outcome === 'silent')) Workstreams.noteRunEnd(ws.id, runId, true);
    // review r8: only a FAILED fire is ok=false ("last run failed", NEEDS YOU's 'routine "X" failed'); a fire that asked a question, was cut
    // short, hit a limit, sent back nothing, was refused or held is no verdict with its outcome's own word (they all read failed)
    else if (Workstreams.noteRunEnd && outcome === 'failed') { const kind = unsucceededKind(why); Workstreams.noteRunEnd(ws.id, runId, kind === 'failed' ? false : null, kind === 'failed' ? 'error' : kind); }   // (review 8.1: a failed fire records its own word, never the fire before it's)
  }
  // which unsuccessful outcome a settled 'failed' fire was (review r8): its outcome-aware reason's LEADING word (a fire reason, a row's
  // RunOutcome.reasonOf, cron.result's reason — '(paused: …)' rides after it); a row's error words are a failure's
  function unsucceededKind(why) {
    if (typeof RunOutcome === 'undefined') return 'failed';
    return RunOutcome.ofWord(String(why == null ? '' : why).trim().split(' (')[0]).outcome;
  }
  // Blank assistant envelopes can carry tool calls, but they are not visible output. Settled status markers count;
  // a pending-transcript marker deliberately does not, so a later open/backfill remains eligible to heal it.
  // a session whose saved history names rows the station holds, not read back yet (save v7): it has output, the page just has not read it
  function packedRows(ws) { return !!(ws && typeof Workstreams !== 'undefined' && Workstreams.needsHydration && Workstreams.needsHydration(ws)); }
  function hasReadableOutput(history) {
    return (Array.isArray(history) ? history : []).some(m => m && (
      (m.role === 'assistant' && String(m.content == null ? '' : m.content).trim()) ||
      (m.sys && !m.transcriptPending && String(m.content == null ? '' : m.content).trim())
    ));
  }
  // the honest error line a FAILED routine's session ends on (foldTurns; the backfill for a session that never said so)
  // review r8: in the fire's OUTCOME's words — a question is no failure ("⚠ Routine failed — clarifying"), a cut reply or a limit did not
  // finish; only a failed fire says "Routine failed". What rides after the leading word (an auto-pause) is kept
  function failedMarker(reason) {
    const said = String(reason || 'run failed').trim(), kind = unsucceededKind(said), rest = said.slice(said.split(' (')[0].length);
    const content = kind === 'asked' ? '▲ Routine asked a question — answer it here' + rest
      : kind !== 'failed' ? '⚠ Routine did not finish — ' + RunOutcome.line({ outcome: kind }) + rest
      : '⚠ Routine failed — ' + said;
    // review 8.1: the failure red (error, COMMS' .err line) is a FAILED fire's alone; a question is drawn in the ask gold and an unfinished
    // fire in the warn tone (tone). `marker` names the fire's end line whatever its outcome, so saysFailed still finds it
    return kind === 'failed' ? { role: 'system', sys: true, content, error: true, marker: 'fire-end' }
      : { role: 'system', sys: true, content, tone: RunOutcome.look(kind).tone, marker: 'fire-end' };
  }
  const saysFailed = history => (Array.isArray(history) ? history : []).some(m => m && m.sys && (m.error || m.marker === 'fire-end') && !m.transcriptPending);
  function transcriptHasReadableOutput(turns) {
    return (Array.isArray(turns) ? turns : []).some(t => t && t.role === 'assistant' && String(t.content == null ? '' : t.content).trim());
  }

  // cron.result can beat the final transcript append. Retry only that short persistence window and remember whether
  // any complete HTTP read succeeded, so foldTurns can distinguish an empty transcript from an unreachable one.
  async function fetchTranscript(agentId, streamId, options) {
    const opts = options || {};
    const waits = Array.isArray(opts.waits) ? opts.waits : [120, 400];
    const sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let turns = [], fetchOk = false;
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      fetchOk = false;
      try {
        const r = await fetch('/api/transcript?agent=' + encodeURIComponent(agentId || 'agent') + '&stream=' + encodeURIComponent(streamId) + '&limit=200', { cache: 'no-store' });
        if (r.ok) {
          const body = (await r.json()) || {};
          turns = Array.isArray(body.turns) ? body.turns : [];
          fetchOk = true;
          if (transcriptHasReadableOutput(turns)) break;
        }
      } catch (_) { /* retry below; fetchOk preserves the truthful final state */ }
      if (attempt < waits.length) await sleep(waits[attempt]);
    }
    return { turns, fetchOk };
  }

  // ---- routine catalogue (names + prompts) ----------------------------------------------------
  async function loadRoutines() {
    catalogueRead = false;
    try {
      const r = await fetch('/api/cron', { cache: 'no-store' });
      if (!r.ok) return (routines = routines || {});
      const jobs = ((await r.json()) || {}).jobs || [];
      const map = Object.create(null);
      for (const j of jobs) {
        if (!j || !j.id) continue;
        map[j.id] = { id: j.id, name: String(j.name || '').trim(), agentId: String(j.agentId || 'agent'), prompt: String(j.prompt || ''),
          fires: firesOfRecord(j), inFlight: j.inFlight === true, inFlightRunId: j.inFlightRunId ? String(j.inFlightRunId) : '' };   // its fires' outcomes (settleOf), and the fire running now (stillFiring)
      }
      routines = map;
      catalogueRead = true;
    } catch (_) { routines = routines || {}; }   // fail-open: names are cosmetic, a session still forms
    return routines;
  }
  function routineFor(jobId) { return (routines && routines[jobId]) || null; }

  // ---- session lifecycle ----------------------------------------------------------------------
  // Adopt (idempotent) the session for one cron run and mark it busy WITHOUT stealing focus. `job`
  // (optional) supplies the human title / agent / seeding prompt; absent, the row still forms honestly.
  // the session's seed row (the routine's prompt) names its turn the way the station named the fire's directive ('r' + the cron
  // runId, TurnKinds.runTurnId) and the run that answered it, so the page binds it to that directive by id (turn identity)
  function seedRow(runId, prompt) {
    const row = { role: 'user', content: String(prompt), sourceRunId: String(runId) };
    const turnId = typeof TurnKinds !== 'undefined' ? TurnKinds.runTurnId(runId) : '';
    if (turnId) row.turnId = turnId;
    return row;
  }
  function beginSession(runId, job) {
    if (!hasWS()) return null;
    const id = streamOf(runId);
    if (!validStream(id)) return null;
    const title = (job && job.name) || 'Routine';
    const agentId = (job && job.agentId) || 'agent';
    const seed = (job && job.prompt) ? [seedRow(runId, job.prompt)] : [];
    const ws = Workstreams.adopt({ id: id, title: title, agentId: agentId, lane: 'active', history: seed,
      automation: { kind: 'routine', id: (job && job.id) || '', name: title } });
    if (!ws) return null;   // a session the Commander DELETED stays deleted (adopt refused the tombstoned id)
    // mark the row busy via the SAME per-workstream channel state chat.js drives (Channels.begin) so the
    // rail's railRowState paints the pulsing "running" dot — reused, not a bespoke busy flag.
    if (hasCh() && !Channels.isBusy(id)) { Channels.begin(id, Date.now()); Channels.setStatus(id, 'thinking…'); }   // cron.fire IS server truth — skip the 'connecting…' unconfirmed state
    armReconcilePoll();   // a live cron run → keep a bounded poll ready to heal it if the result event is lost
    refreshRail();
    persist();
    return ws;
  }

  // Fold a completed run's durable transcript into its session, clear busy, persist, re-render.
  // `endedAt` (optional, epoch ms): the run record's REAL end time — passed by the heal/backfill paths that
  // learn about a run after the fact, so the session's "last worked" stamp is the run's, not the poll's.
  async function completeSession(runId, outcome, reason, endedAt) {
    if (!hasWS()) return;
    const id = streamOf(runId);
    if (!validStream(id)) return;
    // event-ordering safety: result may arrive before we processed fire (or after a backfill miss) — ensure
    // the session exists, seeding from the routine cache when we have it.
    let ws = Workstreams.get(id);
    if (!ws) ws = beginSession(runId, routineFor(/* jobId unknown here */ '') || null);
    if (!ws) return;

    const loaded = await fetchTranscript(ws.agentId, id);

    foldTurns(ws, loaded.turns, outcome, reason, loaded.fetchOk, endedAt);
    if (hasCh()) Channels.end(id);   // clear the busy/running channel state
    // if this session is the one on screen, re-render it so the folded output is visible immediately.
    if (hasChat() && Workstreams.activeId && Workstreams.activeId() === id) Chat.load(ws);
    refreshRail();
    persist();
  }

  // Fold server transcript rows into ws.history in chat.js's native shape. REAL dialogue is user/assistant prose;
  // our own framing lines (silent / failed / couldn't-load / nothing-to-report) are STATUS markers — role:'system'
  // with sys:true — NOT role:'assistant'. That matters twice (Lane 5): chat.js renders a sys marker as a system-
  // styled line (not agent speech), and historyWindow() EXCLUDES sys markers so a frontend-authored string is never
  // replayed back to the model as a prior assistant turn. `fetchOk` distinguishes a transcript-fetch FAILURE (say
  // so honestly) from a run that genuinely produced no readable output. Idempotent-ish — replaces history.
  function foldTurns(ws, turns, outcome, reason, fetchOk, endedAt) {
    const sysMarker = (text, error, pending) => { const m = { role: 'system', sys: true, content: String(text) }; if (error) m.error = true; if (pending) m.transcriptPending = true; return m; };
    const next = [];
    for (const t of (turns || [])) {
      if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;   // mechanics (tool/system) stay out of COMMS
      const content = String(t.content == null ? '' : t.content);
      if (t.role === 'user') { next.push(TurnMerge.stationRow(t)); continue; }
      // assistant: a bare '[SILENT]' reply is a REAL, honest outcome (the routine chose to stay quiet) — mark it as
      // a status line rather than dropping it to a blank thread. Empty prose (tool-only turn) is skipped.
      if (content.trim() === '[SILENT]') { next.push(sysMarker('— routine ran, nothing to report —')); continue; }
      if (content.trim()) next.push(TurnMerge.stationRow(t));
    }
    // "said something" = a real assistant reply OR an honest sys status line we already added (e.g. a [SILENT]
    // marker). Only when NEITHER exists do we need the settled/couldn't-load fallback — so a silent run shows ONE
    // marker, not two.
    const saidSomething = next.some(m => m.role === 'assistant' || m.sys);
    // a FAILED run must never look like it produced nothing: append an honest error line from the outcome.
    if (outcome === 'failed') {
      next.push(failedMarker(reason));
    } else if (outcome === 'stopped') {
      // a STOPPED fire (review r7): no verdict, and no clean "routine ran, nothing to report" either — a stop usually lands while the run is
      // still thinking, before any reply, and that marker is what a succeeded [SILENT] run says. Said as the HUD says it.
      if (!next.some(m => m.role === 'assistant')) next.push(fetchOk ? sysMarker('■ routine stopped before it finished') : sysMarker('⚠ couldn\'t load the output yet — StarNet will retry automatically when this session opens', true, true));
    } else if (!saidSomething) {
      // no assistant prose AND not failed. Be precise about WHY there's nothing: a FAILED transcript fetch is NOT
      // the same as a run that settled quietly — never claim "nothing to report" when we simply couldn't read it.
      next.push(fetchOk
        ? sysMarker('— routine ran, nothing to report —')
        : sysMarker('⚠ couldn\'t load the output yet — StarNet will retry automatically when this session opens', true, true));
    }
    // the transcript IS this session's history (it replaces it): a saved history that named rows is replaced with it, never kept beside it
    if (typeof Workstreams !== 'undefined' && Workstreams.setHistory) Workstreams.setHistory(ws, next); else ws.history = next;
    // hybrid-honest: a real run fired → todo advances to active. `endedAt` (heal/backfill paths) = the run
    // record's REAL end time, so the rail stamp is the run's, never this poll/boot moment.
    recordOutcome(ws, outcome, endedAt, reason);
  }

  // ---- busy reconciliation: heal a session wedged 'RUNNING' after a mid-run SSE drop -----------
  // The busy state a cron fire sets (Channels.begin) is cleared ONLY by cron.result. If the SSE bridge drops
  // between fire and result, that event is LOST and the session stays RUNNING forever — which also blocks the
  // Commander from typing into it (chat.js: `if (Channels.isBusy(ws.id)) return`). A run is recorded in the
  // runStore ONLY when it finishes, so: for each busy cron session, ask /api/runs whether its runId is now done;
  // if so, complete it (fold transcript + Channels.end). Fail-open, self-contained, no new events.
  let reconcilePoll = null;
  const POLL_TICKS = 40;   // ~10 min at 15s — long enough for any real cron run; boot backfill is the backstop past that
  let pollLeft = 0;
  async function reconcileBusy() {
    if (!hasWS() || !hasCh() || !Channels.busyIds) return;
    const busy = Channels.busyIds().filter(id => String(id).indexOf(STREAM_PREFIX) === 0 && validStream(id));
    if (!busy.length) { stopReconcilePoll(); return; }
    let fresh = false, holding = false;
    for (const sid of busy) {
      const ws = Workstreams.get(sid);
      const runId = String(sid).slice(STREAM_PREFIX.length);
      let done = null;
      try {
        const r = await fetch('/api/runs?agent=' + encodeURIComponent((ws && ws.agentId) || 'agent') + '&runId=' + encodeURIComponent(runId), { cache: 'no-store' });
        if (r.ok) { const rows = ((await r.json()) || {}).runs || []; done = rows.find(x => x && x.runId === runId) || null; }
      } catch (_) { done = null; }   // offline / bridge still down → leave it busy, retry next tick
      if (done) {
        if (!fresh) { fresh = true; await loadRoutines(); }   // the fire's outcome is its routine's record, read now (settleOf)
        // the entry run's row lands before its work line has run: a routine still in flight with no record of this fire has not settled it
        const job = routineFor(done.cronJobId || (ws && ws.automation && ws.automation.id) || '');
        if (!fireOf(runId) && stillFiring(job, runId)) { holding = holding || catalogueRead; continue; }
        const settle = settleOf(ws, runId, done);
        await completeSession(runId, settle.outcome, settle.why, done.ts);   // folds transcript + Channels.end; done.ts = the run's REAL end time
      }
    }
    // a fire the station still reports running keeps the bounded poll alive (review 5.3: a line longer than the poll, its cron.result lost
    // to an SSE drop, stayed RUNNING until a reload) — its lease bounds it; only a fresh /api/cron read extends it, never a stale cache
    if (holding) pollLeft = POLL_TICKS;
    if (!Channels.busyIds().some(id => String(id).indexOf(STREAM_PREFIX) === 0)) stopReconcilePoll();
  }
  // a bounded self-poll: armed whenever a cron session goes busy, it retries reconcileBusy on a slow cadence
  // (covers an SSE drop with no reconnect event to hook) and self-stops once no cron session is busy. Bounded so
  // a genuinely long run doesn't poll forever — it caps out, then boot backfill / the next fire re-arms it.
  function armReconcilePoll() {
    if (reconcilePoll) return;
    if (!hasCh() || !Channels.busyIds || !Channels.busyIds().some(id => String(id).indexOf(STREAM_PREFIX) === 0)) return;   // nothing busy → nothing to poll
    pollLeft = POLL_TICKS;
    reconcilePoll = setInterval(() => { if (--pollLeft <= 0) { stopReconcilePoll(); return; } reconcileBusy(); }, 15000);
  }
  function stopReconcilePoll() { if (reconcilePoll) { clearInterval(reconcilePoll); reconcilePoll = null; } }

  // ---- boot backfill: sessions for cron runs that finished while the browser was CLOSED ---------
  async function backfill(options) {
    if (backfilling || !hasWS()) return;
    backfilling = true;
    try {
      await loadRoutines();   // names first so backfilled rows are titled
      let runs = [];
      try {
        const r = await fetch('/api/runs?agent=*&limit=100', { cache: 'no-store' });
        if (r.ok) runs = ((await r.json()) || {}).runs || [];
      } catch (_) { return; }   // route error → nothing to backfill, never crash
      /* THE RUN THAT DEFINES A SESSION IS THE ONE IT IS NAMED AFTER. A stream can now hold SEVERAL runs — a
         routine that fires a WORK LINE records one row per stage, all under 'cron-<runId>' so the session shows
         the whole line. Taking whichever row the list happened to yield first therefore titled the routine's
         session with the internal PIPELINE HANDOFF prompt and attributed it to the LAST stage's agent. The
         session id carries its defining runId, so pick that row exactly rather than by list order. */
      const byStream = Object.create(null);
      for (const run of runs) {
        const sid = run && run.streamId;
        if (!sid || String(sid).indexOf(STREAM_PREFIX) !== 0) continue;
        const want = String(sid).slice(STREAM_PREFIX.length);
        if (!byStream[sid] || String(run.runId || '') === want) byStream[sid] = run;
      }
      const seen = Object.create(null);
      for (const run of Object.keys(byStream).map(k => byStream[k])) {
        const sid = run && run.streamId;
        if (!sid || String(sid).indexOf(STREAM_PREFIX) !== 0 || !validStream(sid)) continue;
        if (seen[sid]) continue;
        seen[sid] = 1;
        // ORPHAN FIX (Lane 5): a reload MID-RUN leaves an ADOPTED busy session in Workstreams with the user seed
        // but NO assistant reply. The old dedupe skipped ANY existing session, permanently orphaning that output.
        // Now: skip only a session that has ALREADY folded a reply (a real dedupe); an existing session with no
        // assistant turn yet is folded from its (now-complete) durable transcript. A run only appears in this
        // /api/runs list once it's DONE, so backfilling it here is correct — and it also clears the wedged busy
        // state (foldTurns → completeSession-style, plus Channels.end below).
        const existing = Workstreams.get(sid);
        // the GROUP name is the routine's own name from the catalogue (a run row carries no name — its title is the
        // prompt, which used to rename every routine group header to its raw instructions on each boot)
        const job = run.cronJobId ? routineFor(run.cronJobId) : null;
        const jobName = (job && job.name) || run.cronJobName || '';
        if (existing && run.cronJobId) Workstreams.adopt({ id: sid, automation: { kind: 'routine', id: run.cronJobId, name: jobName || (existing.automation && existing.automation.name) || run.title || 'Routine' } });
        // a fire that landed before the catalogue loaded (a boot catch-up) was adopted as the placeholder 'Routine' —
        // heal it to the routine's real name (only the placeholder; a Commander rename is theirs)
        if (existing && jobName && existing.title === 'Routine' && existing.titleAuto !== false) existing.title = jobName;
        const runId = String(sid).slice(STREAM_PREFIX.length);
        // A FIRE WHOSE WORK LINE STILL RUNS (review 5.3, the rule reconcileBusy keeps): its entry run's row lands before the line has run, and
        // its routine's record still names an earlier fire, so the row is no settlement — a reload mid-line settled it ok and cleared busy.
        // Its session stays (or, the page closed, forms) busy; the live cron.result or the busy reconcile settles it.
        const fireJob = job || routineFor((existing && existing.automation && existing.automation.id) || '');   // a line hop's row names no routine
        if (!fireOf(runId) && stillFiring(fireJob, runId)) {
          if (!existing || !(hasReadableOutput(existing.history) || packedRows(existing))) beginSession(runId, fireJob);
          continue;
        }
        const defining = String(run.runId || '') === runId;
        const settle = settleOf(existing, runId, defining ? run : null);   // the fire's outcome, else the defining row's
        if (existing && (hasReadableOutput(existing.history) || packedRows(existing))) {
          // Transcript dedupe is not metadata dedupe: upgrade saved cron streams with real provenance/outcome.
          if (defining || settle.byFire) {
            // a fire its record settled FAILED says why, as foldTurns writes it, when its session never did (review 5.3: one a row settled
            // ok before the fire's line was held kept a red lamp over a clean-looking transcript) — only while that fire is its last run
            const ids = Array.isArray(existing.runIds) ? existing.runIds : [];
            const last = ids[ids.length - 1];
            if (settle.byFire && settle.outcome === 'failed' && (!ids.length || last === runId || last === sid) && !saysFailed(existing.history)) existing.history = existing.history.concat([failedMarker(settle.why)]);
            recordOutcome(existing, settle.outcome, run.ts, settle.why);
          }
          if (hasCh()) Channels.end(sid);
          continue;
        }
        // adopt (idempotent) — an existing seed-only session is preserved by adopt; a while-away run is already DONE.
        // A run that finished while the station was CLOSED arrives UNREAD (lastReadAt 0: the Commander has never
        // opened it), so the rail lamp shows what ran while you were gone. A session already on this page keeps its own.
        Workstreams.adopt({ id: sid, title: jobName || String(run.title || 'Routine').split('\n')[0].slice(0, 80) || 'Routine', agentId: String(run.agentId || 'agent'), lane: 'active', history: (existing && existing.history) || [], automation: { kind: 'routine', id: run.cronJobId || '', name: jobName || run.title || 'Routine' }, lastReadAt: existing ? undefined : 0 });
        const ws = Workstreams.get(sid);
        if (!ws) continue;
        const loaded = await fetchTranscript(ws.agentId, sid, options);
        foldTurns(ws, loaded.turns, settle.outcome, settle.why, loaded.fetchOk, run.ts);   // run.ts = real end time, never boot time
        if (hasCh()) Channels.end(sid);   // a backfilled run is DONE → clear any wedged busy/running state
      }
      refreshRail();
      persist();
    } finally { backfilling = false; }
  }

  // ---- App bridges (fail-soft: the module still forms sessions even if a bridge is missing) -----
  function refreshRail() { try { if (hasApp() && App.refreshRail) App.refreshRail(); } catch (_) {} }
  function persist() { try { if (hasApp() && App.persist) App.persist(); } catch (_) {} }

  // ---- U.bus wiring (read-only) ----------------------------------------------------------------
  function onFire(p) {
    if (!p || !p.runId) return;
    let job = routineFor(p.jobId);
    if (!job && p.jobId) {
      // unknown routine → refresh the catalogue, then (re)seed the session's title once names arrive.
      loadRoutines().then(() => { const j = routineFor(p.jobId); const ws = Workstreams.get && Workstreams.get(streamOf(p.runId)); if (j && ws && (ws.title === 'Routine' || !ws.title)) { ws.title = j.name || 'Routine'; if (ws.agentId === 'agent' && j.agentId) ws.agentId = j.agentId; if (!ws.history.length && !packedRows(ws) && j.prompt) ws.history.push(seedRow(p.runId, j.prompt)); refreshRail(); persist(); } });
    }
    beginSession(p.runId, Object.assign({ id: p.jobId || '' }, job || {}));
  }
  /* A LIVE cron.result SETTLES BY ITS FIRE'S RECEIPT (review 6.2), the rule a reload reads. cron.result says only ok / silent / failed, and
     'failed' for every fire that did not succeed (cron-driver finishFire) — a stop someone made (Stop, pausing the routine mid-run, E-STOP)
     included: live, a stopped fire's session read "⚠ Routine failed — cancelled" and kept it across a reload, while a closed-page backfill
     read the same fire as no verdict. finishFire emits cron.result only once the fire's record is committed, so GET /api/cron already holds
     its receipt: a stop is no verdict (settledAs), a fire that failed stays failed. The live reason is kept (it names an auto-pause). */
  async function onResult(p) {
    if (!p || !p.runId) return;
    let outcome = p.outcome;
    // review r7: cron.result says 'stopped' for a stop and carries the fire's own code (runOutcome); an older station said 'failed'
    if (outcome === 'stopped' || p.runOutcome === 'stopped') outcome = 'stopped';
    else if (outcome === 'failed') {
      await loadRoutines();
      const fire = fireOf(p.runId);
      if (fire) outcome = fire.outcome;
      // NO RECEIPT (the routine was deleted mid-run, GET /api/cron failed, an older station): the reason's LEADING word still says how
      // the fire ended — 'cancelled' is a stop ('cancelled (stale-lease)' / '(paused: …)' ride after it), never "⚠ Routine failed — cancelled"
      else if (!p.runOutcome && typeof RunOutcome !== 'undefined' && RunOutcome.resolve({ reason: String(p.reason || '').split(' (')[0] }).outcome === 'stopped') outcome = 'stopped';
    }
    return completeSession(p.runId, outcome, p.reason);
  }

  function init() {
    if (!wired && hasU()) {
      wired = true;
      U.bus.on('cron.fire', onFire);
      U.bus.on('cron.result', onResult);
    }
    // backfill after boot; delayed so the save load + rail have settled (mirrors ReturnStore's digest delay).
    // After backfill, reconcile any session the restored save left marked busy (a mid-run reload/SSE drop) — a
    // finished run gets folded + un-wedged; a still-live one arms the bounded poll.
    setTimeout(() => { backfill().then(() => { reconcileBusy(); armReconcilePoll(); }); }, 1400);
  }
  function reset() { routines = null; stopReconcilePoll(); }   // a fresh Commander re-reads the catalogue; sessions are cleared by Workstreams.reset()

  return { init, reset, _internals: { onResult, beginSession, completeSession, foldTurns, recordOutcome, outcomeOfRun, whyOfRun, fireOf, settleOf, backfill, reconcileBusy, fetchTranscript, hasReadableOutput, loadRoutines, routineFor, validStream, streamOf } };
})(typeof module !== 'undefined' && module.exports ? require('./turnmerge.js') : globalThis.TurnMerge);

if (typeof module !== 'undefined' && module.exports) module.exports = { AutoSessions };
