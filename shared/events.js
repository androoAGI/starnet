/* shared/events.js — the FROZEN U.bus event contract.
   Every cross-boundary event the harness emits lives here with a payload schema.
   validate(name, payload) runs at the bus boundary in BOTH directions; the whole
   set is frozen up front (incl. tool / reasoning / budget events) so the loop,
   reasoning display, and budget UI never force a re-freeze. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./schema.js'));
  else { root.SK = root.SK || {}; root.SK.events = factory(root.SK.schema); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (schema) {
  'use strict';

  const SCHEMA_VERSION = 1;

  const str = { type: 'string' };
  const num = { type: 'number' };
  const int = { type: 'integer' };
  const bool = { type: 'boolean' };
  const any = {};
  const obj = (required, properties) => ({ type: 'object', required, properties });

  const EVENTS = {
    // ---- agent runtime (frozen) ----
    'agent.run.start': obj(['agentId', 'runId', 'trigger', 'model'], {
      // ADDITIVE WIDENING (2026-08-28, bug-sweep): 'loop' (loopjob-driver) and 'nightshift' (nightshift
      // beats) are triggers the sidecar has emitted for months, but the frozen enum rejected them — every
      // validating emitter (cronEmit tee, /api/nightshift/beat NDJSON) silently DROPPED those runs'
      // start events, so the floor saw a loop iteration's middle and end but never its beginning (no work
      // pose, no product crate). Enum values only added, never renamed/removed.
      // ADDITIVE WIDENING (2026-10-28, reliability wave 2): 'manual' is a run the Commander started by hand
      // (Run Now) on a routine's unattended path. Until it validated, Run Now had to borrow 'schedule', so a
      // pressed run read as one the clock fired.
      agentId: str, runId: str, trigger: { enum: ['directive', 'schedule', 'event', 'loop', 'nightshift', 'manual'] }, model: str,
      // ADDITIVE (optional, 2026-10-29, turn-identity lane, owner review requested): WHICH turn this run answers and the
      // durable transcript row holding its directive. turnId is minted by the surface that took the turn (desk page, phone
      // host, channel inbox) or by the station ('r' + runId) and echoed so that surface binds its pending row without
      // reading the transcript. directiveRowId is the station-global transcript rowId; absent while the write is held (a
      // pasted key), deferred (a failed first write), or when the run writes no directive (a synthetic trigger). Ids
      // only, never text. Old payloads stay valid.
      turnId: str, directiveRowId: int
    }),
    'agent.reasoning': obj(['agentId', 'runId', 'on'], { agentId: str, runId: str, on: bool }),
    'agent.token': obj(['agentId', 'runId', 'delta'], { agentId: str, runId: str, delta: str }),
    'agent.tool_call': obj(['agentId', 'runId', 'callId', 'name'], {
      agentId: str, runId: str, callId: str, name: str, argsSummary: str
    }),
    'agent.tool_result': obj(['agentId', 'runId', 'callId', 'ok', 'isError'], {
      agentId: str, runId: str, callId: str, ok: bool, ms: num, summary: str, isError: bool
    }),
    // L2: a non-Anthropic model's mechanically-broken tool-call args were repaired into valid JSON before use.
    'tool.args.repaired': obj(['agentId', 'runId', 'callId', 'name'], {
      agentId: str, runId: str, callId: str, name: str, before: str, after: str
    }),
    'cost.estimate': obj(['agentId', 'runId', 'usd', 'tokens'], { agentId: str, runId: str, usd: num, tokens: int }),
    'agent.cost': obj(['agentId', 'runId', 'usd', 'reconciled'], {
      agentId: str, runId: str, usd: num, tokensIn: int, tokensOut: int,
      reasoningTokens: int, cachedTokens: int, model: str, reconciled: { enum: [true] }
    }),
    'agent.run.end': obj(['agentId', 'runId', 'reason', 'turns', 'usd'], {
      agentId: str, runId: str,
      // ADDITIVE 2026-07-06 (audit 1.7, run-truth-quickies): 'empty' — the final model turn produced ZERO tools and
      // no text (a degraded provider streaming empty completions). Distinct from 'done' so it never reads as a clean
      // delivery (loop.js ends it 'empty'; the frontend renders "ended: empty", never a delivered crate). Enum VALUE
      // added, never renamed/removed — old payloads and consumers stay valid.
      // 'clarifying' (additive, 2026-07-16, Andrew-approved): the run ended by asking the Commander one
      // Task Brief question — a clean model turn that is neither completed work nor a cancellation. Every
      // consumer that keys success on reason === 'done' treats it as neutral, exactly like 'cancelled' did
      // while it overloaded that terminal.
      reason: { enum: ['done', 'max_iters', 'budget', 'cancelled', 'error', 'refusal', 'empty', 'clarifying'] },
      turns: int, usd: num,
      // ADDITIVE (optional, Lane 5): WHY the provider stopped when it was a truncation/policy cut. Present ONLY
      // for the non-clean stops so the frontend can render a "cut short" recap instead of a delivered crate; a
      // clean run omits it entirely (old payloads stay valid — not required, no additionalProperties:false).
      finishReason: { enum: ['length', 'content_filter'] },
      // ADDITIVE (optional, 2026-07-23, budget-stop legibility, Andrew-approved): WHICH spend cap ended a
      // 'budget' run — scope ('run' per-run hard cap / 'agent' lifetime / 'day' / 'global' pool) + the effective
      // $ cap at the moment it fired — so the frontend can say "hit the $3 per-run spend cap → BUDGET settings"
      // instead of an unexplained stop. Present ONLY when reason === 'budget'; old payloads stay valid.
      budgetScope: { enum: ['run', 'agent', 'day', 'global'] },
      budgetCapUsd: num,
      // ADDITIVE (optional, 2026-10-29, typed-outcomes lane, owner review requested): HOW the run ended, as ONE code every
      // surface reads (frontend/app/runoutcome.js resolves it from reason + finishReason + failureCode), and — for a
      // failed or refused run — WHY, as the classifier's or the loop's own code (rate_limit, template_refusal,
      // no_terminal_outcome…). Surfaces used to re-derive both from the error's words, each its own way. Old payloads
      // omit both and stay valid; nothing renamed or removed.
      outcome: { enum: ['succeeded', 'asked', 'cut_short', 'failed', 'refused', 'stopped', 'out_of_budget', 'step_limit', 'empty', 'interrupted', 'blocked'] },
      failureCode: str
    }),
    'agent.run.error': obj(['agentId', 'runId', 'message', 'transient'], {
      agentId: str, runId: str, message: str, transient: bool,
      // ADDITIVE (optional, 2026-10-29, typed-outcomes lane, owner review requested): the error's code (the same code
      // agent.run.end carries), so a reader maps it to words through one table instead of re-reading the message.
      failureCode: str
    }),
    // the loop advanced its failover chain mid-run: a fallback to an alternate model and/or a credential
    // rotation (P0.2/P3.1). Observable telemetry — the only prior signal was the switched agent.cost.model.
    // (additive, 2026-07-16, taste-extraction lane, Andrew-approved): a run's Task Brief settled —
    // the model's READ of the task (objective + correctable assumptions incl. taste guesses). The
    // COMMS announce-and-act card renders from this; corrections fold back via /api/run/steer.
    'taskbrief.settled': obj(['agentId', 'runId', 'objective'], {
      agentId: str, runId: str, objective: str, deliverable: str, audience: str, success: str,
      assumptions: { type: 'array' }
    }),
    /* ADDITIVE (2026-10-26, summon-lines fix for 0.14.1, orchestrator-approved): a delegated WORKER's tool step,
       forwarded onto its LEAD's stream under its OWN name. Forwarding it as agent.tool_call/tool_result made every
       lead-side sink (CLI tracker, /api/observe, Telegram/routine reply buffers, phone, ACP) take it for the lead's
       own step. A sink that does not know this name ignores it; the page translates it back for the floor. */
    'crew.tool_step': obj(['agentId', 'runId', 'parentRunId', 'callId', 'name', 'phase'], {
      agentId: str, runId: str, parentRunId: str, callId: str, name: str, phase: { enum: ['call', 'result'] },
      argsSummary: str, ok: bool, isError: bool, ms: num
    }),
    'provider.fallback': obj(['agentId', 'runId', 'fromModel', 'toModel', 'reason'], {
      agentId: str, runId: str, fromModel: str, toModel: str, reason: str,
      fromProvider: str, toProvider: str, rotate: bool
    }),
    /* ADDITIVE (2026-09-23, live-events lane, Andrew-approved): the retry ladder (~105 s of backoff) and the
       provider idle watchdog (up to 300 s per silent attempt) used to run SILENT — the Commander saw run start
       and then nothing until the end or the error. Two new events, nothing renamed or removed:
       provider.retry — the loop is about to re-send the SAME model turn after a transient failure; emitted
       BEFORE the backoff. `attempt` uses the numbering of the run's recorded recovery attempts (the ladder rung,
       counting retries an adapter already spent pre-stream); `delayMs` is the wait the loop will ACTUALLY sleep
       (0 when no sleep is wired); `maxAttempts` is this retry class's budget (ladder rungs, or the single
       truncation retry). stage: pre_stream = the failed attempt received no stream event, mid_stream = it had.
       retryAfterMs = a server-stated wait; waitedMs / patienceMs = local backoff spent before this rung / the
       ladder's total local patience. */
    'provider.retry': obj(['agentId', 'runId', 'attempt', 'reason', 'delayMs'], {
      agentId: str, runId: str, attempt: int, reason: str, delayMs: num,
      maxAttempts: int, model: str, stage: { enum: ['pre_stream', 'mid_stream'] },
      retryAfterMs: num, waitedMs: num, patienceMs: num
    }),
    /* agent.waiting — a liveness HEARTBEAT (host-injected ticker, ~15 s) while a model call has produced no
       token or tool event. phase: first_byte = the request is out and no stream event has arrived; streaming =
       the stream is open but carries no visible output yet (e.g. reasoning); retry_backoff = sleeping between
       ladder rungs after a provider.retry; connect = reserved for an adapter that can tell headers-pending
       apart. sinceMs = how long this wait has lasted (since the model call went out, or since the backoff
       began). It proves the run is alive and waiting — never that the task advanced. */
    'agent.waiting': obj(['agentId', 'runId', 'phase', 'sinceMs'], {
      agentId: str, runId: str, phase: { enum: ['connect', 'first_byte', 'streaming', 'retry_backoff'] },
      sinceMs: num, model: str
    }),
    // a no-op turn (no tool call + no NEW assistant content — an empty stream or a re-emitted prior turn, e.g. a
    // wasted failover/compaction retry) was REFUNDED from the iteration budget instead of counting against maxIters.
    // Bounded by a per-run floor (refundsUsed) so a pathological all-no-op run still terminates. Observability only.
    'iteration.refunded': obj(['agentId', 'runId', 'reason'], {
      agentId: str, runId: str, turn: int, reason: { enum: ['empty', 'duplicate'] }, refundsUsed: int
    }),
    'run.cancel': obj(['runId'], { runId: str }),
    // context was compacted mid-run (ref-style cache-aware compaction): tokens before/after + items removed.
    // ADDITIVE (optional, 2026-11-04, context-budget-and-fold): how much of the stream's history the new prompt stands on that
    // was SUMMARIZED BEFORE and how much this fold summarized. Both count canonical transcript rows. reused = rows a kept
    // (stored) summary served; new = rows this fold's paid summarizer call covered. reason 'reused' is a run-start event, not
    // a fold: a stored summary replaced the part of the chat it covers, with no summarizer call (reused > 0, new = 0).
    // Old payloads stay valid; no listener has to read them.
    'agent.compact': obj(['agentId', 'runId'], {
      agentId: str, runId: str, beforeTokens: int, afterTokens: int, removed: int, reason: str, reused: int, new: int
    }),

    // ---- memory / context (Cortex) ----
    // a recalled-memory fence was injected into this run's prompt (count = records included; chars = fence size).
    'memory.recall': obj(['agentId', 'runId', 'count'], { agentId: str, runId: str, count: int, chars: int }),
    // a memory record was committed — after the user approved a proposal, or via notebook.write. scope/streamId optional.
    'memory.write': obj(['agentId', 'runId', 'id', 'kind'], { agentId: str, runId: str, id: str, kind: str, scope: str, streamId: str }),
    // a memory record was removed — user pressed forget, or a proposal was discarded.
    'memory.forget': obj(['agentId', 'id'], { agentId: str, id: str, reason: str }),
    // reflection PROPOSED a record for Keep/Edit/Discard turn-in (not yet committed). scope/streamId optional.
    'memory.proposed': obj(['agentId', 'runId', 'id', 'kind'], { agentId: str, runId: str, id: str, kind: str, scope: str, streamId: str }),
    // a stored record was actually surfaced into a prompt this run — drives useCount/trust (one per included id).
    'memory.used': obj(['agentId', 'runId', 'id'], { agentId: str, runId: str, id: str }),
    // a signed trust adjustment for a record (Keep/Edit/Discard, pin, forget) — folded into computed trust.
    'memory.feedback': obj(['agentId', 'id', 'delta'], { agentId: str, id: str, delta: num, reason: str }),

    // ---- capability / permission ----
    'capdenied': obj(['agentId', 'need', 'reason'], { agentId: str, need: str, reason: str }),
    // ADDITIVE (beginner seam Lane 1, 2026-08-22): a tool call needed a connector that is not wired. Emitted by
    // the MCP manager ALONGSIDE its throw (the model still sees the error text); the frontend turns it into the
    // post-run "⇄ CONNECT <X>" chip. kind names the subsystem the fix lives in; runId is '' outside a run.
    'connector_required': obj(['runId', 'connectorId', 'kind', 'reason', 'toolName'], {
      runId: str, connectorId: str, kind: { enum: ['mcp', 'servicekey'] }, reason: str, toolName: str
    }),
    'permission.prompt': obj(['promptId', 'agentId', 'tool', 'scope'], {
      promptId: str, agentId: str, tool: str, scope: str, argsSummary: str
    }),
    // a backend->frontend COMMAND (mirrors permission.prompt): the orchestrator's team.summon tool asks the
    // LIVE station to create a new worker agent — the SAME action the Commander takes in the Recruitment Bay.
    // The browser runs the real summonAgent() and POSTs /api/summon/ack with the new agentId, resolving the
    // tool. agentId = the requesting LEAD (attribution); the new agent's id comes back on the ack, not here.
    'crew.summon.request': obj(['requestId', 'agentId'], {
      requestId: str, agentId: str, name: str, specId: str, persona: str, skin: str, purpose: str
    }),
    'permission.response': obj(['promptId', 'decision'], {
      promptId: str, decision: { enum: ['once', 'session', 'always', 'deny', 'full'] }
    }),
    'object.place': obj(['room', 'objectType', 'instanceId'], { room: str, objectType: str, instanceId: str }),
    'object.reclaim': obj(['room', 'objectType', 'instanceId'], { room: str, objectType: str, instanceId: str }),
    'budget.threshold': obj(['scope', 'usd', 'cap'], { scope: { enum: ['run', 'day', 'global'] }, usd: num, cap: num }),
    // ADDITIVE (2026-07-25, managed credits): the account's BALANCE fell to/below the warn threshold.
    // Deliberately NOT folded into budget.threshold — that event means "spend approached a cap you set"
    // and carries usd/cap; this means "the money you bought is running out" and carries balance/threshold.
    // Reusing it would have made `usd` mean two different things. Emitted once per crossing (the latch
    // lives in credits.js), re-armed only after a top-up clears the threshold with hysteresis.
    // `exhausted` true = balance <= 0, i.e. the next managed run WILL be refused, not merely warned about.
    // Inert on a BYOK station: nothing emits it unless managed credits are configured.
    'credits.low': obj(['balanceUsd', 'thresholdUsd'], {
      balanceUsd: num, thresholdUsd: num, purchaseUrl: str, exhausted: bool
    }),

    // ---- cron / scheduled routines (autonomous, unattended fires; producers in the index.js tick driver) ----
    // the scheduler tick ran: how many due jobs it planned / fired / skipped this pass (the war-room pulse).
    // ADDITIVE (NS-0, 2026-07-07): `deferred` — how many due jobs were HELD BACK past the concurrency cap this
    // tick (they stay due, drain on a later tick). Optional int; old payloads/consumers omit it and stay valid.
    'cron.tick': obj(['fired', 'skipped'], { fired: int, skipped: int, planned: int, deferred: int }),
    // a scheduled job fired a run — runId links to the agent.* run it launched; scheduledFor = ms it was due.
    'cron.fire': obj(['jobId', 'runId'], { jobId: str, runId: str, scheduledFor: num }),
    // a due job was NOT fired this tick (already running, disabled, stale-fast-forwarded, ungated, lease-reclaimed,
    // or at-capacity: deferred past the concurrency cap). ADDITIVE (NS-0, 2026-07-07): 'at-capacity' — the previously
    // silent concurrency-cap deferral is now emitted. Enum VALUE added, never renamed/removed; old payloads stay valid.
    'cron.skipped': obj(['jobId', 'reason'], {
      jobId: str, reason: { enum: ['already-running', 'disabled', 'caught-up', 'no-capability', 'stale-lock-reclaimed', 'at-capacity'] }
    }),
    // a fired job's run finished: ok / failed (always delivered) / silent ([SILENT] suppressed delivery, audit kept).
    // ADDITIVE (2026-10-30, typed-outcomes lane review r7, owner review requested): outcome VALUE 'stopped' — someone stopped the fire
    // (Stop, pausing the routine mid-run, deleting it, E-STOP, a STOP on its work line): no failure and no success, where 'failed' had
    // stood for it. Optional runOutcome (the fire's ONE outcome code, the agent.run.end vocabulary: cut_short / blocked / stopped …),
    // failureCode (a failed or refused fire's code) and pausedAfter (this settlement tripped the consecutive-failure auto-pause after N
    // failures — said apart from the free-text reason, whose suffix put a reader's reason outside the vocabulary). Enum value and fields
    // added, nothing renamed, removed or made required; old payloads stay valid.
    'cron.result': obj(['jobId', 'runId', 'outcome'], {
      jobId: str, runId: str, outcome: { enum: ['ok', 'failed', 'silent', 'stopped'] }, reason: str,
      runOutcome: { enum: ['succeeded', 'asked', 'cut_short', 'failed', 'refused', 'stopped', 'out_of_budget', 'step_limit', 'empty', 'interrupted', 'blocked'] },
      failureCode: str, pausedAfter: int
    }),

    // ---- away workshop (an agent builds a reviewable deliverable in its own jail while the Commander is away) ----
    // a workshop shift completed with a VALIDATED manifest (files proven to exist on disk). manifest is the
    // deliverable.json body (see docs/AWAY_WORKSHOP_PLAN.md §4) — carried as an opaque object so a manifest-schema
    // bump never re-freezes the bus contract. Emitted ONLY after validation; an invalid/missing manifest emits nothing.
    'workshop.built': obj(['agentId', 'runId', 'manifest'], { agentId: str, runId: str, manifest: any }),
    // the Commander decided a pending deliverable: keep (copied out to destPath under normal interactive consent),
    // discard (run dir wiped + backlogId denylisted so it isn't silently retried), or later (dismissed only).
    'workshop.decided': obj(['agentId', 'runId', 'decision'], {
      agentId: str, runId: str, decision: { enum: ['keep', 'discard', 'later'] }, destPath: str
    }),

    // ---- execution spine: checkpoints · shell · verification (producers in the exec-spine modules) ----
    // a shadow-git workspace snapshot was taken before a mutating turn (the rollback net). files/bytes = snapshot size.
    'checkpoint.created': obj(['agentId', 'runId', 'turn', 'snapshotId'], {
      agentId: str, runId: str, turn: int, snapshotId: str, files: int, bytes: int, label: str
    }),
    // the workspace was rolled back to a prior snapshot (manual rewind or a policy auto-restore).
    'checkpoint.restored': obj(['agentId', 'runId', 'toSnapshotId'], {
      agentId: str, runId: str, toSnapshotId: str, reason: str
    }),
    // a shell command ran (gated by consent + an auto-checkpoint). cmdSummary is redacted; cwd is the jail root.
    'shell.exec': obj(['agentId', 'runId', 'callId', 'exitCode'], {
      agentId: str, runId: str, callId: str, cmdSummary: str, cwd: str, exitCode: int, ms: num, truncated: bool
    }),
    // H2.2: a background/long-running shell process (shell.exec background:true) ended — fires AFTER the
    // originating run's stream closed, so it rides the durable SSE bus (chanEmit), not the per-run NDJSON.
    'shell.bg.exit': obj(['agentId', 'bgId', 'exitCode'], {
      agentId: str, bgId: str, exitCode: int, ms: num, killed: bool
    }),
    // post-edit verification: the project's own check, or an LSP lint-DELTA (only NEWLY-introduced diagnostics).
    'verify.result': obj(['agentId', 'runId', 'passed'], {
      agentId: str, runId: str, tool: str, passed: bool, added: int, removed: int, summary: str
    }),

    // ---- messaging-channel ingress (Telegram/Discord adapters; producers wired in C5) ----
    // a message arrived on a platform, was admitted, and was mapped to an agent (the trigger-source telemetry
    // that agent.run.start.trigger only labels). channel/chatId/userId are not secrets; the bot token never appears.
    'channel.inbound': obj(['channel', 'chatId', 'agentId'], {
      channel: str, chatId: str, agentId: str, userId: str, kind: { enum: ['dm', 'group'] }
    }),
    // the agent's reply was delivered back to the platform (chunk count + ok/why) — outbound delivery telemetry.
    // agentId (additive, optional 2026-07-06): WHICH roster agent produced the reply, so the floor pulses the
    // RIGHT agent's dish on a multi-agent station instead of any dish. Optional — absent on legacy/command sends.
    'channel.delivery': obj(['channel', 'chatId', 'runId', 'ok'], {
      channel: str, chatId: str, runId: str, ok: bool, chunks: int, reason: str, agentId: str
    }),
    // adapter transport health: poll up / network down / fatal token error (in-memory health state).
    'channel.connect': obj(['channel', 'state'], {
      channel: str, state: { enum: ['up', 'down', 'error'] }, detail: str
    }),

    // ---- logistics / work-item conveyor (boxes that carry REAL work along player-laid belts) ----
    // a real inbound work-item (e.g. an admitted Telegram message) was queued at a SOURCE — the start of
    // the belt journey. preview is a short, already-redacted text snippet; queueDepth is the per-agent backlog.
    'workitem.placed': obj(['workitemId', 'queueId'], {
      workitemId: str, queueId: str, agentId: str, kind: str, preview: str, queueDepth: int, ts: num
    }),
    // a work-item rode into a bay/sink and its payload was consumed (run-start for inbound; reply/file/memory
    // for outbound). box is an optional short JSON-string summary, not a deep object (keeps validation cheap).
    'workitem.delivered': obj(['workitemId', 'finalQueueId'], {
      workitemId: str, finalQueueId: str, agentId: str, box: str, ms: num, ts: num
    }),
    // a newer message for the same chat ABORTED this work-item's run (hub supersede) — its box should drop
    // off the belt instead of riding to the desk. Mirrors the hub's one-run-per-chat inflight behavior.
    'workitem.superseded': obj(['workitemId'], { workitemId: str, agentId: str, ts: num }),
    // queue-depth telemetry for the backpressure HUD — emitted whenever a per-agent queue depth changes.
    'queue.status': obj(['queueId'], { queueId: str, depth: int, maxCapacity: int, nextAdvanceAt: num }),
    /* STATION BRIDGE (additive, 2026-07-30): a sidecar tool asking the live page to perform a station action
       that only the page can do — open a session, switch agent, delegate. `id` correlates the page's reply on
       POST /api/station/ack. Carries no result: this is the REQUEST half only. */
    'station.command': obj(['id', 'verb'], { id: str, verb: str, args: any }),
    // ADDITIVE (STEP-IN, 2026-09-29): a browser HANDOFF changed state — the agent paused on a login/2FA/CAPTCHA and
    // asked the Commander to take its live browser (sidecar/browser-handoff.js). State-carrying and replayable: the
    // station renders exactly this record. `id` is the handoff's OWN id (never a consent promptId). `where` is
    // host + path only (no query string). Rides the station SSE bridge, not the /api/run socket.
    'browser.handoff': obj(['id', 'agentId', 'runId', 'state'], {
      id: str, agentId: str, runId: str,
      state: { enum: ['waiting', 'taken', 'returned', 'cancelled', 'expired', 'aborted'] },
      reason: { enum: ['login', '2fa', 'captcha', 'payment', 'other'] }, note: str, host: str, where: str, title: str,
      remembered: bool, requestedAt: num, takenAt: any, endedAt: any, expiresAt: num
    }),

    // ---- reserved (P3 mutation API) ----
    'worldChange': obj(['seq'], { seq: int, dirtyTiles: { type: 'array' } }),

    // ---- reused v7 names (re-emitted from REAL transitions; frontend listeners fire unchanged) ----
    // ADDITIVE (2026-10-30, typed-outcomes lane review 8.2, owner review requested): status VALUES 'stopped' (someone stopped the
    // worker: its Stop, a HUD / E-STOP stop, its lead's Stop), 'asked' (it ended asking a question) and 'unfinished' (a spend or
    // step limit, a cut reply, an empty reply, a refusal, a restart or a liveness stop: it did not finish) — 'failed' had stood for
    // every one of them, and the page's sound director plays the failure sting for 'failed'. Optional outcome (the worker's ONE
    // outcome code, the agent.run.end vocabulary) and failureCode (a failed or refused worker's code) ride beside the coarse word.
    // Enum values and fields added, nothing renamed, removed or made required; old payloads stay valid.
    'task': obj(['id', 'status'], {
      id: str, agentId: str, status: { enum: ['queued', 'running', 'done', 'failed', 'todo', 'stopped', 'asked', 'unfinished'] }, kind: str, title: str,
      outcome: { enum: ['succeeded', 'asked', 'cut_short', 'failed', 'refused', 'stopped', 'out_of_budget', 'step_limit', 'empty', 'interrupted', 'blocked'] },
      failureCode: str
    }),
    'chat': obj(['from', 'txt'], { from: str, txt: str }),
    'deliverable': obj(['id'], { id: str, agentId: str, room: str, kind: str, title: str }),
    'notify': str,                                  // payload is a bare string
    'stats': any, 'level': any, 'objectives': any,  // listeners read a snapshot the telemetry layer maintains

    // ---- retired (kept VALID/known, emitted only as optional cosmetics off real completions) ----
    'sale': any, 'parcel': any, 'intel': any, 'flagged': any, 'hazard': any, 'party': any, 'day': any
  };

  function deepFreeze(o) {
    Object.freeze(o);
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); }
    return o;
  }
  deepFreeze(EVENTS);

  function isKnown(name) { return Object.prototype.hasOwnProperty.call(EVENTS, name); }
  function names() { return Object.keys(EVENTS); }
  function validate(name, payload) {
    if (!isKnown(name)) return { ok: false, errors: ['unknown event: ' + name] };
    return schema.validate(EVENTS[name], payload);
  }

  return { EVENTS, SCHEMA_VERSION, validate, isKnown, names };
});
