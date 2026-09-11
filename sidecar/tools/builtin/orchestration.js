/* sidecar/tools/builtin/orchestration.js — team.dispatch: the LEAD delegates subtasks to its summoned
   WORKER crew. The Stage-2 moat: a lead decomposes a task and hands subtasks to specialist workers, each of
   which runs its OWN real, independent agent loop (web/files/memory), and returns its result for the lead to
   synthesize. CONTRACT-FREE: no shared/events.js change — children emit the SAME frozen agent.run.* events,
   forwarded (lifecycle + cost only) onto the lead's bus so the floor can ANIMATE the handoff.

   makeOrchestrationTools({ runOnce, roster, key, model, provider, reasoningEffort, perWorker, newId, maxWorkers })
     runOnce   : the SAME run host the browser/cron use (injected to avoid a require cycle) — async (o) -> result
     roster    : () -> Map(agentId -> { system, name, model }) — the live crew identities (pushed by the browser)
     key       : this run's API key (per-run)        model : the lead's model (worker fallback)
     perWorker : per-WORKER USD ceiling (a runaway worker can't blow the lead's per-run cap)
     workerMaxIters: optional per-WORKER iteration ceiling (0/omitted = unlimited)
     newId     : () -> a fresh runId for each child (crypto.randomUUID, injected so this UMD stays dep-free)
     maxWorkers: optional cap on workers per dispatch (0/omitted = unlimited)

   Safety (verified against the run host): each worker is a DISTINCT agentId so it takes its own concurrency
   slot + its own ledger/live-budget entry while the lead's slot stays held; ctx.signal is threaded into every
   child so cancelling the lead aborts all workers; the child runOnce returning undefined (concurrency refusal /
   up-front error) is null-guarded; only the worker's FINAL assistant message is returned (never the full
   transcript) to stay under the per-run tool-output cap. */
'use strict';
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('../../domain-task.js') : (root.SK && root.SK.domainTask),
    typeof require === 'function' ? require('../../result-contract.js') : (root.SK && root.SK.resultContract)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).orchestration = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (domainTask, schemaLib) {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  // events forwarded from a child run onto the LEAD's bus — ENOUGH to animate the handoff + keep cost honest,
  // but NOT the child's tokens/tool-calls (those would clutter the lead's COMMS). The lead reads the worker's
  // actual output from the tool RESULT, not the stream.
  // 'deliverable' forwards too (2026-07-07 escape): a worker's saved image/file was INVISIBLE — no COMMS card,
  // no crate, no notify — because the event died here. The payload already carries the OWNING agentId and its
  // jail-relative path, and the frontend card opens /api/file?agent=<owner>, so forwarding is the whole fix.
  const FORWARD = { 'agent.run.start': 1, 'agent.run.end': 1, 'agent.run.error': 1, 'agent.cost': 1, 'deliverable': 1 };
  // a delegated worker's added kit, on top of the autonomous full office (compute/web/files/memory/studio/jukebox):
  // the WORKBENCH (terminal). Paired with the SHARED lead consent broker, shell/writes follow the lead's APPROVAL
  // posture — so a worker has the same reach as the orchestrator, gated by the same approvals.
  const WORKER_KIT = [{ instanceId: 'wb_worker', objectType: 'workbench' }];
  const boundedDomainTask = (text) => {
    try { return domainTask && typeof domainTask.classify === 'function' ? domainTask.classify(text) : null; }
    catch (_) { return null; }
  };

  // abort without ever throwing out of a timer callback (AbortController.abort(reason) is not universal).
  function abort(ac) { try { ac.abort(new Error('worker wall clock')); } catch (_) { try { ac.abort(); } catch (_) {} } }
  /* A fresh AbortController CHAINED to a parent signal: aborting the parent (E-STOP, the lead's run ending, the
     registry's own per-call timeout) still cascades down, but aborting the child stops ONE worker without
     touching its siblings or the lead. Mirrors registry.js's childAbort; kept local because this file is a
     dep-free UMD. Tolerates a non-AbortSignal parent (unit stubs) by simply not chaining. */
  function childAbort(parent) {
    const ac = new AbortController();
    let detach = function () {};
    if (parent) {
      if (parent.aborted) abort(ac);
      else if (typeof parent.addEventListener === 'function') {
        const onAbort = () => abort(ac);
        try {
          parent.addEventListener('abort', onAbort, { once: true });
          detach = () => { try { parent.removeEventListener('abort', onAbort); } catch (_) {} };
        } catch (_) {}
      }
    }
    return { ac, detach };
  }

  function lastAssistant(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
    }
    return '';
  }

  function resultSchemaOf(raw) {
    if (raw == null) return {ok:true,schema:null};
    if (!schemaLib) return {ok:false,error:'Result contract validator is unavailable'};
    return schemaLib.prepare(raw);
  }
  function inspectStructured(schema,text) {
    if (!schema) return {ok:true,value:null,errors:[]};
    if (!schemaLib) return {ok:false,value:null,errors:['Result contract validator is unavailable']};
    return schemaLib.inspect(schema,text);
  }
  async function enforceStructured(schema, text, repair) {
    const first = inspectStructured(schema, text);
    if (!schema || first.ok) return { ok: true, text: text, value: first.value, validation: schema ? { state: 'valid', attempts: [{ ok: true, errors: [] }] } : null };
    let repaired = null;
    try { repaired = typeof repair === 'function' ? await repair(first.errors) : null; } catch (_) { repaired = null; }
    const repairedText = repaired && repaired.text != null ? String(repaired.text) : '';
    const second = inspectStructured(schema, repairedText);
    return {
      ok: !!(repaired && second.ok), text: repaired ? repairedText : String(text || ''), value: second.value,
      validation: { state: repaired && second.ok ? 'repaired' : 'invalid', attempts: [
        { ok: false, errors: first.errors.slice(0, 20) },
        { ok: !!(repaired && second.ok), errors: (repaired ? second.errors : ['repair run did not return a result']).slice(0, 20) }
      ] },
      repairResult: repaired && repaired.result, repairRunId: repaired && repaired.runId || ''
    };
  }
  function markBatchQuality(rows) {
    const seen = new Map();
    for (const row of rows) {
      if (row.error) continue;
      const prompt = String(row.prompt || '').trim();
      if (!prompt) { row.error = 'batch task rejected before spawn: prompt is empty'; continue; }
      // The same focused prompt can be intentionally sent to two distinct named specialists for independent
      // perspectives. Anonymous spawn rows have no agentId, so exact duplicate clone tasks are still rejected.
      const key = String(row.agentId || '') + '\n' + prompt.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) {
        row.error = 'batch task rejected before spawn: duplicate of task ' + (seen.get(key) + 1);
        const first = rows[seen.get(key)];
        if (first && !first.error) first.error = 'batch task rejected before spawn: duplicate task prompt';
      } else seen.set(key, rows.indexOf(row));
    }
    return rows;
  }

  // Only host context or a durable host-created worker record supplies project scope.
  // Tool arguments cannot choose a new filesystem root.
  function projectOptions(ctx, record) {
    const source = record && Object.prototype.hasOwnProperty.call(record, 'projectRoot') ? record : (ctx || {});
    return { projectRoot: source.projectRoot || undefined, workdir: source.workdir || source.projectCwd || undefined };
  }

  function connectorOptions(ctx) {
    // Functions are supplied by the host context, never by tool arguments or a persisted worker record.
    const authority = ctx && ctx.connectorAuthority;
    return authority ? { connectorAuthority: authority, initialTaint: typeof authority.taintedBy === 'function' ? authority.taintedBy() : null } : {};
  }

  function makeOrchestrationTools(deps) {
    deps = deps || {};
    const runOnce = deps.runOnce;
    const roster = (typeof deps.roster === 'function') ? deps.roster : (() => new Map());
    const key = deps.key;
    const model = deps.model;
    const provider = deps.provider || null;
    const baseUrl = deps.baseUrl || deps.base_url || '';
    const reasoningEffort = deps.reasoningEffort || 'medium';
    const subagents = deps.subagents || null;
    // the LEAD's OWN base identity (system prompt), threaded from the run host so team.spawn can clone it. Empty
    // string when absent → a spawned subagent still runs, just without an inherited persona.
    const selfSystem = (typeof deps.selfSystem === 'string') ? deps.selfSystem : '';
    const taskContext = (typeof deps.taskContext === 'string') ? deps.taskContext.trim() : '';
    // The EFFECTIVE approval posture of a delegated run — 'full' | 'ask' — read from the host as a thunk so it
    // reflects the live roster at dispatch time. A worker SHARES the lead's consent broker (see runWorker), so the
    // posture baked into its own roster identity ("APPROVAL — FULL ACCESS…" / "ASK FIRST…") is the WRONG one
    // whenever the two differ: an engineer the Commander granted full access, dispatched by an ask-mode overseer,
    // was told "never wait for a go-ahead" while every write actually paused for a prompt. Truthful telemetry
    // applies to the prompt too, so the effective posture is appended LAST and explicitly supersedes it.
    const approvalPosture = () => {
      const v = (typeof deps.approvalPosture === 'function') ? deps.approvalPosture() : deps.approvalPosture;
      return v === 'full' ? 'full' : (v === 'ask' ? 'ask' : '');
    };
    function postureNote() {
      const p = approvalPosture();
      if (!p) return '';   // host wired no posture -> byte-identical to the pre-2026-07-26 prompt
      return '\n\n[DELEGATED APPROVAL — THIS SUPERSEDES ANY APPROVAL SECTION ABOVE] You are running as a delegated '
        + 'worker, so you inherit the LEAD agent\'s approval posture, not your own: '
        + (p === 'full'
          ? 'FULL ACCESS. Run your tools directly — do not pause to ask, and never request approval in text.'
          : 'ASK FIRST. Writes, commands, and network calls are shown to the Commander for approval when you call the '
            + 'tool — so still just make the tool call, but expect a pause, and carry on without it if it is declined.');
    }
    function workerSystem(base) {
      const identity = String(base || '') + postureNote();
      const liveContext = typeof deps.getTaskContext==='function' ? String(deps.getTaskContext() || '') : taskContext;
      if (!liveContext) return identity;
      return identity + '\n\n' + liveContext
        + '\n\n[DELEGATED EXECUTION] Treat the task context above as settled input from the Commander. Do not ask the Commander another discovery question. If a truly blocking gap remains, report that gap to the lead agent.';
    }
    /* LEAD CONTEXT HANDOFF (G6 closure). A worker's opening message was ONLY the prompt string: whatever the
       lead had already established — discovered file paths, findings, constraints, decisions — was lost unless
       hand-woven into the prompt prose, and the worker re-derived it at full cost (or worse, guessed). `context`
       is an explicit, bounded handoff block. It rides FIRST in the worker's opening user message so the ask
       itself stays last (recency); the structured-result REPAIR run replays the same opening message verbatim
       (it reuses this composed string), and restart-resume rebuilds it from the durable record's own `context`
       field — a resumed worker never silently loses its handoff. Distinct from `taskContext` above: that block
       is the HOST-assembled Commander evidence in the system prompt; this one is the LEAD-authored, per-worker
       working state. */
    const HANDOFF_CONTEXT_MAX = 8000;
    function handoffContext(raw) { return String(raw == null ? '' : raw).trim().slice(0, HANDOFF_CONTEXT_MAX); }
    function openingMessage(prompt, context, resultSchema) {
      const ask = resultSchema
        ? String(prompt || '') + '\n\n[STRUCTURED RESULT CONTRACT] Return ONLY strict JSON matching this schema: ' + JSON.stringify(resultSchema)
        : String(prompt || '');
      if (!context) return ask;
      return '[LEAD CONTEXT — what your lead already established for this task. Treat it as settled starting knowledge; do not re-derive it, and re-verify it only where it contradicts what you observe.]\n'
        + context + '\n\n[YOUR SUBTASK]\n' + ask;
    }
    const perWorker = (typeof deps.perWorker === 'number' && isFinite(deps.perWorker) && deps.perWorker > 0) ? deps.perWorker : 0;
    // Zero means no user-work quota. Narrow task contracts and structured-output repair
    // still impose their own local ceilings below; those are correctness safeguards.
    const workerMaxIters = (typeof deps.workerMaxIters === 'number' && isFinite(deps.workerMaxIters) && deps.workerMaxIters > 0) ? Math.floor(deps.workerMaxIters) : 0;
    const lowerPositive = (a, b) => {
      const aa = (typeof a === 'number' && isFinite(a) && a > 0) ? Math.floor(a) : 0;
      const bb = (typeof b === 'number' && isFinite(b) && b > 0) ? Math.floor(b) : 0;
      if (aa && bb) return Math.min(aa, bb);
      return aa || bb || 0;
    };
    let _seq = 0;
    const newId = (typeof deps.newId === 'function') ? deps.newId : (() => 'child_' + (++_seq));
    // Cross-provider dispatch: a roster identity carries its OWN mirrored provider (model is a roster
    // property). Sending a worker's model down the LEAD's wire when they differ is an instant 400 (e.g. an
    // anthropic slug at the codex backend), so the host injects providerAuth(providerId) -> { provider, key,
    // baseUrl } | null to resolve the worker's own server-held credential. No resolver / no credential ->
    // the worker runs on the LEAD's provider+model (never a foreign model on the lead's wire) with an honest
    // note in the dispatch result.
    const providerAuth = (typeof deps.providerAuth === 'function') ? deps.providerAuth : null;
    /* THE STATION BRIDGE (optional) — { request(verb, args) -> {ok, result|error} }. Sessions are PAGE state, so
       resolving "the research session" to a stream id, and folding a worker's answer into that session's thread,
       both have to ask the live page. Absent (headless run, bare unit caller) -> session targeting is refused
       honestly rather than silently ignored. See sidecar/station-bridge.js. */
    const station = (deps.station && typeof deps.station.request === 'function') ? deps.station : null;
    function workerWire(ident) {
      const wanted = (ident && ident.provider) ? String(ident.provider) : '';
      const ownModel = (ident && ident.model) ? String(ident.model) : '';
      if (!wanted || wanted === provider || !ownModel) {
        return { provider, key, baseUrl, model: ownModel || model, note: '' };
      }
      const auth = providerAuth ? providerAuth(wanted) : null;
      if (auth) return { provider: auth.provider || wanted, key: auth.key || '', baseUrl: auth.baseUrl || '', model: ownModel, note: '' };
      return { provider, key, baseUrl, model, note: 'worker provider "' + wanted + '" has no credential on this station — ran on the lead\'s model instead' };
    }
    // Opt-in ceiling only. Omitted/zero means dispatch every requested worker.
    const maxWorkers = (typeof deps.maxWorkers === 'number' && isFinite(deps.maxWorkers) && deps.maxWorkers > 0) ? Math.floor(deps.maxWorkers) : 0;
    // A dispatch AWAITS one or more full worker agent-loops (each web-searching + multi-turn), which routinely
    // run for minutes. The host wraps every tool call in CAPS.toolTimeoutMs (30s — sized for fast web/file
    // tools), so WITHOUT this override team.dispatch is guaranteed to time out before any real worker returns:
    // the lead then abandons delegation and does the job solo while the orphaned worker keeps spending. So the
    // dispatch tool carries its OWN generous wall-clock backstop. Real runaway is already bounded per-worker by
    // the cost cap (perWorker) + the worker's own maxIters/per-tool timeouts; this is just the outer ceiling.
    const dispatchBudgetMs = (typeof deps.dispatchTimeoutMs === 'number' && deps.dispatchTimeoutMs > 0) ? deps.dispatchTimeoutMs : 600000;
    // injected clock (lint-determinism: no ambient Date.now in backend logic) — only used to divide the wall clock.
    // Without one (bare unit callers) elapsed time is UNKNOWABLE, so the sequential path falls back to fixed even
    // shares; that keeps the shares summing to the budget instead of each worker seeing a full, never-shrinking one.
    const hasClock = (typeof deps.now === 'function');
    const now = hasClock ? deps.now : (() => 0);
    /* freeSlots() -> how many NEW distinct agents the station's admission gate can accept right now, or null for
       "no cap wired". A parallel dispatch runs in WAVES of this size instead of firing everything at once and
       letting the gate refuse the excess (2026-07-26 audit finding B). Read fresh per dispatch: the free capacity
       depends on what else is running (another COMMS session, a cron beat) at that moment. */
    const freeSlots = (typeof deps.freeSlots === 'function') ? deps.freeSlots : null;
    function waveSize(n) {
      if (!freeSlots) return n;                        // no gate wired -> fan out all at once (pre-2026-07-26 shape)
      let f = null;
      try { f = freeSlots(); } catch (_) { f = null; }
      if (f == null || !isFinite(f)) return n;         // unbounded gate
      return Math.max(1, Math.min(n, Math.floor(f))); // at least 1 (a full gate still tries, then the retry pass)
    }

    /* SESSION TARGETING (2026-07-30). Delegation used to be agent-addressed only: the lead could say WHO, never
       WHERE, so a worker's run was filed under whatever session the LEAD was in. The Commander asked for a session
       called "research", got the researcher, and watched the work land somewhere else while the lead reported
       success. `session` on a worker closes that: it resolves to a real workstream id, which rides into runOnce as
       streamId (so runStore + transcriptStore file the run there for real) and back to the page as a delivery.

       ⛔ AN UNMATCHED NAME NEVER FALLS BACK TO THE CURRENT SESSION. Unknown or ambiguous => that worker does NOT
       run, and the row says why. Defaulting is the exact behaviour this closes: a wrong-but-plausible destination
       is worse than a refusal, because the lead then truthfully reports work it cannot see was misfiled. A refusal
       is legible — the model can create the session, or ask which one, and try again.

       Mutates jobs in place: sets streamId + sessionTitle on success, or `error` (which runWorker returns as a row
       without ever starting the worker). One bridge call for the whole dispatch, not one per worker. */
    async function resolveSessions(jobs) {
      const wanted = jobs.filter(j => !j.error && j.session);
      if (!wanted.length) return;
      const refuseAll = (why) => { for (const j of wanted) j.error = why(j); };
      if (!station) {
        return refuseAll(j => 'this run cannot target sessions — no live station page is attached to resolve "'
          + j.session + '". Dispatch without `session` and the work runs in the current one.');
      }
      let list = null, why = '';
      try {
        const out = await station.request('station.sessions', {});
        if (out && out.ok && out.result && Array.isArray(out.result.sessions)) list = out.result.sessions;
        else why = String((out && out.error) || 'the station did not answer');
      } catch (e) { why = String((e && e.message) || e); }
      if (!list) return refuseAll(j => 'could not read this station\'s session list, so "' + j.session + '" could not be resolved — ' + why);
      const named = list.filter(s => s && String(s.title || '').trim());
      const nameList = named.map(s => String(s.title).trim());
      for (const j of wanted) {
        const want = String(j.session).trim();
        const lower = want.toLowerCase();
        // Three explicit tiers, each requiring a UNIQUE hit. Substring is last and still refuses when it matches
        // two sessions — so "research" can find "Research plan" without ever silently picking between two.
        const byId = list.filter(s => s && String(s.id) === want);
        const byTitle = named.filter(s => String(s.title).trim().toLowerCase() === lower);
        const byPart = lower ? named.filter(s => String(s.title).trim().toLowerCase().indexOf(lower) >= 0) : [];
        const hits = byId.length ? byId : (byTitle.length ? byTitle : byPart);
        if (hits.length === 1) { j.streamId = String(hits[0].id); j.sessionTitle = String(hits[0].title || want); continue; }
        j.error = hits.length > 1
          ? 'more than one session matches "' + want + '" (' + hits.map(h => String(h.title || h.id)).join(', ')
            + ') — name it exactly, or pass the session id. This worker did NOT run.'
          : 'there is no session called "' + want + '" on this station'
            + (nameList.length ? '. Open sessions: ' + nameList.join(', ') : '')
            + '. Create it first, or dispatch without `session` to run in the current one. This worker did NOT run.';
      }
    }

    /* THE VISIBLE HALF. runOnce already filed the run under this streamId (runStore + transcriptStore), so the
       durable record is true either way; this is what puts the worker's answer in front of the Commander, in the
       session they named. Failure is REPORTED on the row, never swallowed: a lead that says "it's in research"
       when the fold failed is the same lie as misfiling it. */
    async function deliverToSession(job, row) {
      if (!station || !job.streamId) return;
      let out = null;
      const args = {
        streamId: job.streamId, sessionTitle: job.sessionTitle || job.session || '',
        agentId: job.agentId, runId: row.runId || '', prompt: job.prompt, text: row.result
      };
      try { out = await station.request('station.deliver', args); }
      catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
      if (out && out.ok) row.session = job.sessionTitle || job.streamId;
      else row.sessionNote = 'the work ran and is filed under the "' + (job.sessionTitle || job.streamId)
        + '" session, but the station could not show it there: ' + String((out && out.error) || 'no answer')
        + '. The completed run is durable and will be reconciled when that session is opened.';
    }

    // Busy state belongs to the TARGET session, not whichever session the Commander is currently viewing.
    // This is intentionally best-effort: a missing page must never delay or cancel paid worker work.
    function noteSessionActivity(verb, job, runId) {
      if (!station || !job.streamId) return;
      try {
        const pending = station.request(verb, {
          streamId: job.streamId, sessionTitle: job.sessionTitle || job.session || '',
          agentId: job.agentId, runId: runId || ''
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (_) {}
    }

    const dispatchTool = {
      // The registry timeout is now only a BACKSTOP: it sits a minute above the dispatch's own budget so the
      // in-tool wall clock (which returns partial rows) always fires first. Letting the registry's timeout be the
      // primary mechanism is what threw away every completed worker's result (2026-07-26 audit finding A).
      timeoutMs: dispatchBudgetMs + 60000,
      // CONSENT-GATED (2026-07-14, closes the parked P1): delegation fans out REAL autonomous agent loops that
      // spend budget — if untrusted content in the lead's context (a fetched page, a channel message) injects
      // "dispatch a worker to do X", the human must get a say first. Same semantics as team.summon: the APPROVAL
      // beat in 'ask' mode (a session grant stops per-call fatigue), bypassed by Full Access — so a trusting
      // user keeps the frictionless flow by choosing it. Lead-only conferral + budget caps + the concurrency
      // ceiling + autonomous workers (default-deny) all still stand underneath.
      name: 'team.dispatch', capability: 'orchestrator', scope: 'execute', requiresConsent: true,
      description: 'Delegate subtasks to your specialist crew. Each worker runs its OWN real agent loop (live web search/read, files, memory) and returns its result for you to synthesize into the final answer. Address workers by the agentId listed under YOUR TEAM. Runs sequentially by default; pass parallel:true to run them at once. Pass background:true to start watchable workers and keep working. SESSIONS: pass `session` on a worker (the session\'s NAME, as the Commander says it) to make that subtask run in — and be filed under — that session instead of this one. Only pass it when the Commander named a session; a name that does not match one on this station is REFUSED, not guessed, and that worker does not run. FILES: each worker saves into its OWN private workspace — you cannot fs.read another agent\'s files, so never "verify" a worker\'s file with your own file tools (absence in YOUR workspace proves nothing). The result\'s artifacts list is the proof of what each worker saved, and the Commander is shown those files as cards automatically — reference them as "<workerId>\'s workspace: <path>".',
      schema: {
        type: 'object', required: ['workers'], properties: {
          workers: {
            type: 'array', items: {
              type: 'object', required: ['agentId', 'prompt'],
              properties: {
                agentId: { type: 'string' }, prompt: { type: 'string' },
                resultSchema: { type: 'object', description: 'Optional strict JSON result contract. The host validates the final result and allows one bounded repair; invalid output is never accepted as done.' },
                context: { type: 'string', description: 'Optional handoff of what YOU already established that this worker needs: discovered file paths, findings, constraints, decisions. It is placed before the prompt as settled starting knowledge, so the worker does not re-derive it. Do not restate the subtask here.' },
                // WHERE the work lands. A session NAME (what the Commander calls it) or its exact id. Omit to run
                // in the current session — see resolveSessions for why an unmatched name never falls back to that.
                session: { type: 'string' }
              }
            }
          },
          parallel: { type: 'boolean' },
          background: { type: 'boolean' }
        }
      },
      run: async (args, ctx) => {
        if (typeof runOnce !== 'function') return { content: 'orchestration unavailable (no run host)', summary: 'error' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        const crew = roster() || new Map();
        // NO SILENT CAPS (2026-07-26 orchestration audit): the cap used to `slice(0, maxWorkers)` and say nothing,
        // so a 6-worker decomposition became a 4-worker dispatch reporting "4 done" — and the lead then wrote the
        // Commander a confident final answer covering two subtasks that never ran. The overflow now comes BACK as
        // explicit not-dispatched rows (see overflowRows) so the model can see, and re-dispatch, exactly what it lost.
        const asked = Array.isArray(args.workers) ? args.workers : [];
        const reqs = maxWorkers ? asked.slice(0, maxWorkers) : asked.slice();
        const overflow = maxWorkers ? asked.slice(maxWorkers) : [];
        if (!reqs.length) return { content: 'No workers specified.', summary: 'noop' };
        const overflowRows = () => overflow.map(w => ({
          agentId: String((w && w.agentId) || '(unnamed)'),
          reason: 'not-dispatched',
          result: 'NOT RUN — one team.dispatch call carries at most ' + maxWorkers + ' workers. This subtask was not started; dispatch it in a follow-up call before you report.',
          usd: 0
        }));
        const overflowNote = overflow.length ? ' — ' + overflow.length + ' NOT dispatched (max ' + maxWorkers + ' per call; dispatch the rest in a follow-up call)' : '';

        // forward ONLY lifecycle/cost from children onto the lead's bus (the floor animation reads agent.run.start).
        const childEmit = (name, payload) => { if (FORWARD[name] && ctx && typeof ctx.emit === 'function') { try { ctx.emit(name, payload); } catch (_) {} } };

        // validate every target up front: a real, live, OTHER worker (never self, never an unknown agentId).
        const jobs = reqs.map(w => {
          const aid = w && String(w.agentId || '');
          const session = String((w && w.session) || '').trim().slice(0, 80);
          if (!ID_RE.test(aid)) return { agentId: aid, error: 'invalid agentId' };
          if (aid === leadId) return { agentId: aid, error: 'cannot delegate to yourself' };
          if (!crew.has(aid)) return { agentId: aid, error: 'no such live worker — summon them first, or check the agentId against YOUR TEAM' };
          const contract = resultSchemaOf(w && w.resultSchema);
          if (!contract.ok) return { agentId: aid, error: 'invalid result contract: ' + contract.error };
          return { agentId: aid, prompt: String((w && w.prompt) || ''), context: handoffContext(w && w.context), ident: crew.get(aid), session: session, resultSchema: contract.schema };
        });
        markBatchQuality(jobs);
        // WHERE before WHO does the work: an unresolvable session marks its job failed here, so that worker is
        // never started in the wrong place (see resolveSessions). One bridge round-trip for the whole dispatch.
        await resolveSessions(jobs);

        const runWorker = async (job, o2) => {
          o2 = o2 || {};
          if (job.error) return { agentId: job.agentId, reason: 'error', result: job.error, usd: 0 };
          const wire = workerWire(job.ident);   // the worker's OWN provider+model when resolvable (see workerWire)
          // PER-WORKER WALL CLOCK (2026-07-26 audit finding A). Before this, the ONLY clock was the registry's
          // tool timeout over the WHOLE dispatch: one slow worker ate the shared budget, the registry rejected, and
          // every ALREADY-COMPLETED worker's result was thrown away — the lead received the string "team.dispatch
          // timed out" and nothing else, after the Commander had paid for all of them. Each foreground worker now
          // gets its own slice on its OWN abort controller (chained to the parent, so E-STOP still cascades), so a
          // straggler is stopped ALONE and comes back as one honest `timeout` row while its siblings' work survives.
          // Background workers pass no wallMs — outliving the tool call is the whole point of background:true.
          const parentSignal = o2.signal || (ctx && ctx.signal);
          const bounded = boundedDomainTask(job.prompt);
          // minted up front (not inline in the runOnce call) so the row can carry the SAME id the run was filed
          // under — the page's delivery uses it to append the run to the session and to stay idempotent.
          const workerRunId = o2.runId || newId();
          const allottedWallMs = (typeof o2.wallMs === 'number' && isFinite(o2.wallMs) && o2.wallMs > 0) ? o2.wallMs : 0;
          // A one-host inspection is never a ten-minute autonomous research job. Even if a lead explicitly
          // delegates one (non-interactive callers can still do so), bind all three dimensions: turns, tools,
          // and wall clock. The worker still gets a final synthesis turn after its direct fetch.
          const wallMs = bounded
            ? Math.min(allottedWallMs || bounded.workerMaxMs, bounded.workerMaxMs)
            : allottedWallMs;
          const child = wallMs ? childAbort(parentSignal) : null;
          const ac = child && child.ac;
          let timedOut = false, timer = null;
          if (ac) timer = setTimeout(() => { timedOut = true; abort(ac); }, wallMs);
          const timeoutRow = (res) => {
            const partial = res ? (lastAssistant(res.messages) || '') : '';
            return {
              agentId: job.agentId, reason: 'timeout',
              result: (partial ? partial + '\n\n' : '')
                + '[STOPPED — this worker used up its ' + Math.round(wallMs / 1000) + 's slice of the dispatch wall clock'
                + (partial ? '; the text above is its PARTIAL work' : ' before returning any text')
                + '. Do not present it as complete: either re-dispatch this subtask alone, or tell the Commander this part is unfinished.]',
              usd: (res && res.usd) || 0
            };
          };
          let result;
          const contractedPrompt = openingMessage(job.prompt, job.context, job.resultSchema);
          noteSessionActivity('station.dispatch_start', job, workerRunId);
          try {
            result = await runOnce({
              ...projectOptions(ctx), ...connectorOptions(ctx),
              key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
              // Class Loadouts S1: the WORKER runs at its OWN class-applied reasoning effort (roster record), not the
              // lead's — a dispatched specialist honors its loadout. Falls back to the lead's effort when unset.
              reasoningEffort: (job.ident && job.ident.reasoningEffort) || reasoningEffort,
              model: wire.model,
              system: workerSystem((job.ident && job.ident.system) || ''),
              messages: [{ role: 'user', content: contractedPrompt }],
              agentId: job.agentId, isTask: true,
              emit: o2.emit || childEmit,      // lifecycle/cost ride the lead/global stream -> the floor lights the worker
              signal: ac ? ac.signal : parentSignal,   // own controller when this worker has a wall clock (see above)
              runId: workerRunId, trigger: 'directive', surface: 'autonomous',
              parentRunId: ctx && ctx.runId,
              // SESSION TARGETING: the run host files a run under its streamId (runStore.record + the durable
              // transcript) and scopes its working memory to that stream. Absent -> undefined, byte-identical to
              // the pre-2026-07-30 call. This is the DURABLE half; deliverToSession is the visible one.
              streamId: job.streamId || undefined,
              sessionTitle: job.streamId ? (job.sessionTitle || job.session || '') : undefined,
              sessionPrompt: job.streamId ? job.prompt : undefined,
              // Share the lead's consent broker so a worker's WRITES follow the lead's APPROVAL posture
              // (full-auto bypass, or a prompt forwarded to the watched lead) instead of the headless default-deny.
              // NOT "same access as the orchestrator" — a worker runs surface:'autonomous' (below), and
              // enforceRunAuthority strips WORKSPACE_PROCESS tools on any non-interactive surface *before* consent is
              // ever consulted. So of the WORKBENCH grant a worker receives, shell.exec and verify.run never reach the
              // model at all; only its background-shell and browser-test tools survive. Widening that is a deliberate
              // permissions-surface decision, not something to fix by editing this comment.
              consent: ctx && ctx.consent,
              extraObjects: WORKER_KIT,
              maxCostUsd: perWorker,           // a runaway worker can't blow the lead's per-run ceiling
              maxIters: bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters,
              maxToolCalls: bounded ? bounded.workerMaxTools : undefined,
              steer: typeof o2.steer === 'function' ? o2.steer : undefined
            });
          } catch (e) {
            noteSessionActivity('station.dispatch_end', job, workerRunId);
            if (timedOut) return timeoutRow(null);   // the abort we fired surfaced as a throw — still an honest timeout
            return { agentId: job.agentId, reason: 'error', result: 'worker run failed: ' + ((e && e.message) || e), usd: 0 };
          } finally {
            if (timer) clearTimeout(timer);
            if (child) child.detach();
          }
          noteSessionActivity('station.dispatch_end', job, workerRunId);
          if (timedOut) return timeoutRow(result);   // keep whatever partial text the aborted run did produce
          if (!result) return { agentId: job.agentId, reason: 'refused', result: 'worker could not start — the station\'s concurrent-agent cap was full at that instant, or a provider sign-in is needed. A parallel dispatch already runs in waves sized to the free capacity and retries a refusal once, so a refusal that survives means the cap is genuinely saturated: raise MAX_CONCURRENT_AGENTS in SETTINGS, or dispatch these workers in a follow-up call.', usd: 0 };
          const firstText = lastAssistant(result.messages) || '(the worker returned no text)';
          const contract = await enforceStructured(job.resultSchema, firstText, async (errors) => {
            const spent = Number(result.usd) || 0;
            const remaining = perWorker > 0 ? Math.max(0, perWorker - spent) : 0;
            if (perWorker > 0 && remaining <= 0) return null;
            const repairRunId = newId();
            const repair = await runOnce({
              outputOnly: true,
              ...projectOptions(ctx), ...connectorOptions(ctx),
              key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
              reasoningEffort: (job.ident && job.ident.reasoningEffort) || reasoningEffort,
              model: wire.model, system: workerSystem((job.ident && job.ident.system) || ''),
              messages: [{ role: 'user', content: contractedPrompt }, { role: 'assistant', content: firstText },
                { role: 'user', content: '[STRUCTURED RESULT REPAIR] The prior result failed host validation:\n- ' + errors.slice(0, 20).join('\n- ') + '\nReturn ONLY strict JSON matching: ' + JSON.stringify(job.resultSchema) }],
              agentId: job.agentId, isTask: true, emit: o2.emit || childEmit,
              signal: ac ? ac.signal : parentSignal, runId: repairRunId, trigger: 'directive', surface: 'autonomous',
              parentRunId: ctx && ctx.runId, streamId: job.streamId || undefined,
              sessionTitle: job.streamId ? (job.sessionTitle || job.session || '') : undefined,
              consent: ctx && ctx.consent, extraObjects: WORKER_KIT,
              maxCostUsd: perWorker > 0 ? remaining : 0,
              maxIters: lowerPositive(4, bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters),
              maxToolCalls: bounded ? bounded.workerMaxTools : undefined,
              steer: typeof o2.steer === 'function' ? o2.steer : undefined
            });
            return repair ? { text: lastAssistant(repair.messages), result: repair, runId: repairRunId } : null;
          });
          const repaired = contract.repairResult || null;
          const totalUsd = (Number(result.usd) || 0) + (Number(repaired && repaired.usd) || 0);
          const artifacts = [].concat(Array.isArray(result.artifacts) ? result.artifacts : [], Array.isArray(repaired && repaired.artifacts) ? repaired.artifacts : []);
          if (job.resultSchema && !contract.ok) return {
            agentId: job.agentId, reason: 'invalid-result',
            result: 'Worker output failed its result schema after one bounded repair attempt. No completion was accepted.',
            usd: totalUsd, runId: workerRunId, repairRunId: contract.repairRunId || '', validation: contract.validation,
            artifacts: artifacts.map(a => Object.assign({}, a, { agentId: job.agentId, workspace: job.agentId }))
          };
          const effective = repaired || result;
          const row = {
            agentId: job.agentId,
            reason: effective.reason || 'done',
            result: contract.text,
            structuredResult: job.resultSchema ? contract.value : null,
            validation: contract.validation,
            repairRunId: contract.repairRunId || '',
            usd: totalUsd,
            runId: workerRunId,
            model: effective.model || wire.model,
            reasoningEffort: effective.reasoningEffort || ((job.ident && job.ident.reasoningEffort) || reasoningEffort),
            toolsOk: (Number(result.toolsOk) || 0) + (Number(repaired && repaired.toolsOk) || 0),
            durationMs: (Number(result.durationMs) || 0) + (Number(repaired && repaired.durationMs) || 0),
            tokens: (Number(result.tokens) || 0) + (Number(repaired && repaired.tokens) || 0)
          };
          if (wire.note) row.note = wire.note;   // honest credential-fallback disclosure (never silent)
          /* Show it where the Commander asked for it. Only a COMPLETED worker delivers: every other outcome
             (error / refused / timeout) returned above, so a partial or failed run is reported to the lead but
             never folded into a session as though it were finished work. */
          await deliverToSession(job, row);
          // WORK VISIBILITY (ghost-file fix): what the worker PROVABLY produced (its runOnce artifact ledger),
          // stamped with the OWNING agentId. Files live in the WORKER's private workspace — the lead cannot
          // fs.read them and must reference them as the worker's (they are already shown to the Commander as
          // cards via the forwarded deliverable events). Never invent paths beyond this list.
          if (artifacts.length) {
            row.artifacts = artifacts.map(a => Object.assign({}, a, { agentId: job.agentId, workspace: job.agentId }));
          }
          return row;
        };

        if (args.background) {
          if (!subagents || typeof subagents.start !== 'function') return { content: 'background subagents unavailable (no subagent manager)', summary: 'error' };
          const started = jobs.map(job => {
            if (job.error) return { agentId: job.agentId, reason: 'error', result: job.error };
            return subagents.start({ ...projectOptions(ctx), leadId, agentId: job.agentId, prompt: job.prompt, context: job.context, runId: newId(), resultSchema: job.resultSchema }, async (h) => {
              const r = await runWorker(job, { runId: h.runId, signal: h.signal, emit: h.emit, steer: h.steer });
              return { status: r.reason === 'done' ? 'done' : 'error', reason: r.reason, result: r.result, usd: r.usd || 0,
                structuredResult: r.structuredResult, validation: r.validation, repairRunId: r.repairRunId, artifacts: r.artifacts };
            });
          });
          const startedRows = started.concat(overflowRows());
          return { content: JSON.stringify(startedRows), summary: 'started ' + started.filter(r => r && r.id).length + ' background worker(s)' + overflowNote };
        }

        /* WAVES — one code path for both modes (2026-07-26 audit findings A + B).
           SEQUENTIAL is waves of 1: legible, one box at a time (the default).
           PARALLEL is waves sized to the station's REAL free fan-out capacity. It used to fan out all at once and
           let an explicitly configured concurrency gate REFUSE the excess: with MAX_CONCURRENT_AGENTS 3, and the
           lead holds a slot for the whole dispatch) a 4-worker parallel dispatch ran 2 and handed the lead two
           'refused' rows that nothing ever retried — half the crew silently didn't work. Waves run every worker,
           just not all in the same instant.
           THE WALL CLOCK divides across waves the same way it divides across sequential workers: each wave gets a
           fair share of what is LEFT, so an early fast wave donates its unused time to the ones behind it. */
        const startedAt = now();
        const size = args.parallel ? waveSize(jobs.length) : 1;
        const waves = [];
        for (let i = 0; i < jobs.length; i += size) waves.push(jobs.slice(i, i + size));
        const leftAt = (w) => hasClock
          ? dispatchBudgetMs - (now() - startedAt)
          : dispatchBudgetMs - Math.floor(dispatchBudgetMs * w / waves.length);   // no clock: fixed even shares
        const notStartedRow = (job) => ({
          agentId: job.agentId, reason: 'not-dispatched', usd: 0,
          result: 'NOT RUN — this dispatch ran out of wall clock before reaching this worker. The results above are real; '
            + 'dispatch this subtask in a follow-up call, and do not report it as done.'
        });
        let out = [];
        for (let w = 0; w < waves.length; w++) {
          const left = leftAt(w);
          if (left <= 0) { for (const j of waves[w]) out.push(notStartedRow(j)); continue; }
          const share = Math.max(1, Math.floor(left / (waves.length - w)));
          const done = await Promise.all(waves[w].map(j => runWorker(j, { wallMs: share })));
          for (const r of done) out.push(r);
        }
        /* ONE RETRY PASS for a refusal. A 'refused' row means the admission gate was full at that instant — a
           sibling wave, another agent's run, or a cron beat holding the last slot. Waves make that rare instead of
           systematic, but a race can still lose one, and a refused worker did NO work and cost NOTHING, so
           retrying it is free. `out` is built in job order, so out[i] pairs with jobs[i] (overflow is appended after). */
        for (let i = 0; i < out.length && i < jobs.length; i++) {
          if (out[i].reason !== 'refused') continue;
          const left = hasClock ? dispatchBudgetMs - (now() - startedAt) : Math.floor(dispatchBudgetMs / jobs.length);
          if (left <= 0) break;
          const retried = await runWorker(jobs[i], { wallMs: left });
          out[i] = (retried.reason === 'refused') ? Object.assign(retried, { retried: true }) : retried;
        }
        out = out.concat(overflowRows());

        const ok = out.filter(r => r.reason === 'done').length;
        const late = out.filter(r => r.reason === 'timeout').length;
        const unrun = out.filter(r => r.reason === 'not-dispatched').length - overflow.length;
        return {
          content: JSON.stringify(out),
          summary: 'dispatched ' + jobs.length + ' worker(s), ' + ok + ' done'
            + (late ? ', ' + late + ' out of time' : '')
            + (unrun > 0 ? ', ' + unrun + ' never started (wall clock)' : '')
            + overflowNote
        };
      }
    };

    // team.spawn: the LEAD spawns EPHEMERAL sub-agents — anonymous CLONES OF ITSELF — to work subtasks in PARALLEL.
    // The "Meeseeks": a throwaway worker that does its one task, returns its result, then vanishes. UNLIKE
    // team.dispatch (which delegates to NAMED roster crew with their own persistent identity), these have NO roster
    // identity — each is a clone of the lead (the lead's OWN base system + model), narrowed to a focused subtask with
    // its own cost budget and a fresh ephemeral id. Routed through the durable subagent registry so each emits
    // task{kind:'subagent'} + the frozen agent.run.* — the floor's Meeseeks-sprite feed, CONTRACT-FREE. FLAT DEPTH:
    // a clone is handed the WORKBENCH but NOT the orchestrator object, so team.spawn/dispatch are never EXPOSED to it
    // → it cannot spawn its own sub-agents. The SAME gating that already stops a delegated worker re-delegating.
    const spawnTool = {
      // Spawn's foreground clones run in PARALLEL and are each bounded by workerMaxIters, so this budget applies to
      // the slowest single clone rather than a sum — it keeps the registry timeout it always had. (The per-worker
      // wall clock that saves partial results was added to team.dispatch, whose sequential default shares one budget.)
      timeoutMs: dispatchBudgetMs,
      // CONSENT-GATED like team.dispatch (see its note): spawning clones fans out autonomous budget-spending
      // loops off text in the lead's context — 'ask' mode gets the APPROVAL beat, Full Access bypasses.
      name: 'team.spawn', capability: 'orchestrator', scope: 'execute', requiresConsent: true,
      description: 'Spawn EPHEMERAL sub-agents — clones of yourself — to work subtasks in parallel. Each runs its OWN agent loop on the one subtask you give it, returns its result, then vanishes (it is NOT added to your roster, and it cannot spawn its own sub-agents). Use this to decompose a task or fan out parallel work without summoning named crew first. Each task takes a prompt (the focused subtask) and an optional label. Pass background:true to spawn watchable workers and keep working while they run.',
      schema: {
        type: 'object', required: ['tasks'], properties: {
          tasks: {
            type: 'array', items: {
              type: 'object', required: ['prompt'],
              properties: {
                prompt: { type: 'string' }, label: { type: 'string' },
                resultSchema: { type: 'object', description: 'Optional strict JSON result contract. Invalid output gets one bounded repair and is never accepted as done.' },
                context: { type: 'string', description: 'Optional handoff of what YOU already established that this clone needs: discovered file paths, findings, constraints, decisions. Placed before the prompt as settled starting knowledge. Do not restate the subtask here.' }
              }
            }
          },
          background: { type: 'boolean' }
        }
      },
      run: async (args, ctx) => {
        if (typeof runOnce !== 'function') return { content: 'orchestration unavailable (no run host)', summary: 'error' };
        if (!subagents || typeof subagents.start !== 'function') return { content: 'ephemeral subagents unavailable (no subagent manager)', summary: 'unavailable' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        // NO SILENT CAPS — same rule as team.dispatch (see its note): the tasks past the cap come back as
        // explicit not-spawned rows instead of vanishing from a "N done" summary.
        const askedTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const reqs = (maxWorkers ? askedTasks.slice(0, maxWorkers) : askedTasks).map((task, i) => {
          const contract = resultSchemaOf(task && task.resultSchema);
          return {
            prompt: String((task && task.prompt) || ''),
            context: handoffContext(task && task.context),
            label: String((task && task.label) || ('subagent ' + (i + 1))).slice(0, 60),
            resultSchema: contract.ok ? contract.schema : null,
            error: contract.ok ? '' : 'invalid result contract: ' + contract.error
          };
        });
        markBatchQuality(reqs);
        const overflow = maxWorkers ? askedTasks.slice(maxWorkers) : [];
        if (!reqs.length) return { content: 'No tasks specified.', summary: 'noop' };
        const overflowRows = () => overflow.map((t, i) => ({
          label: String((t && t.label) || ('subagent ' + (maxWorkers + i + 1))).slice(0, 60),
          reason: 'not-spawned',
          result: 'NOT RUN — one team.spawn call carries at most ' + maxWorkers + ' subtasks. This one was not started; spawn it in a follow-up call before you report.',
          usd: 0
        }));
        const overflowNote = overflow.length ? ' — ' + overflow.length + ' NOT spawned (max ' + maxWorkers + ' per call; spawn the rest in a follow-up call)' : '';

        // forward ONLY lifecycle/cost onto the lead's bus so the floor materializes/pops the Meeseeks live; the
        // durable record (via h.emit) keeps the full watch tail for team.subagents/interrupt/resume.
        const childEmit = (name, payload) => { if (FORWARD[name] && ctx && typeof ctx.emit === 'function') { try { ctx.emit(name, payload); } catch (_) {} } };

        const spawnOne = (task, i) => {
          const label = task.label;
          const prompt = task.prompt;
          if (task.error) {
            const row = { label, reason: 'not-spawned', result: task.error, usd: 0 };
            return { label, view: row, done: Promise.resolve(row), started: false };
          }
          const ephemeralId = ('sub-' + newId()).slice(0, 40);   // anonymous, ID_RE-valid; NEVER a roster agentId
          let settle; const done = new Promise(res => { settle = res; });
          const runner = async (h) => {
            let result;
            const bounded = boundedDomainTask(prompt);
            const contractedPrompt = openingMessage(prompt, task.context, task.resultSchema);
            try {
              result = await runOnce({
              ...projectOptions(ctx), ...connectorOptions(ctx),
                key, provider, baseUrl, reasoningEffort, model,      // the lead's OWN model - a clone of self
                system: workerSystem(selfSystem),           // the lead's OWN identity plus settled task context
                                                            // composes its own caps for its (narrowed) toolset
                messages: [{ role: 'user', content: contractedPrompt }],
                agentId: ephemeralId, isTask: true,
                emit: (n, p) => { try { h.emit(n, p); } catch (_) {} childEmit(n, p); },   // durable record + lead stream
                signal: h.signal, runId: h.runId,
                parentRunId: ctx && ctx.runId,
                trigger: 'directive', surface: 'autonomous',
                consent: ctx && ctx.consent,                // same approval posture as the orchestrator
                extraObjects: WORKER_KIT,                   // WORKBENCH only — NO 'lead' → no orchestrator object →
                                                            // team.spawn never exposed to it → FLAT DEPTH (no re-spawn)
                maxCostUsd: perWorker,                       // a runaway clone can't blow the lead's per-run ceiling
                maxIters: bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters,
                maxToolCalls: bounded ? bounded.workerMaxTools : undefined,
                steer: h.steer
              });
            } catch (e) {
              const r = { label, agentId: ephemeralId, reason: 'error', result: 'subagent run failed: ' + ((e && e.message) || e), usd: 0 };
              settle(r); return { status: 'error', reason: 'error', result: r.result, usd: 0 };
            }
            if (!result) {
              const r = { label, agentId: ephemeralId, reason: 'refused', result: 'subagent could not start — the concurrency cap (STARNET_MAX_CONCURRENT_AGENTS) is full or a sign-in is needed. Try fewer at once.', usd: 0 };
              settle(r); return { status: 'error', reason: 'refused', result: r.result, usd: 0 };
            }
            const firstText = lastAssistant(result.messages) || '(the subagent returned no text)';
            const contract = await enforceStructured(task.resultSchema, firstText, async (errors) => {
              const spent = Number(result.usd) || 0;
              const remaining = perWorker > 0 ? Math.max(0, perWorker - spent) : 0;
              if (perWorker > 0 && remaining <= 0) return null;
              const repairRunId = newId();
              const repair = await runOnce({
              outputOnly: true,
              ...projectOptions(ctx), ...connectorOptions(ctx),
                key, provider, baseUrl, reasoningEffort, model, system: workerSystem(selfSystem),
                messages: [{ role: 'user', content: contractedPrompt }, { role: 'assistant', content: firstText },
                  { role: 'user', content: '[STRUCTURED RESULT REPAIR] The prior result failed host validation:\n- ' + errors.slice(0, 20).join('\n- ') + '\nReturn ONLY strict JSON matching: ' + JSON.stringify(task.resultSchema) }],
                agentId: ephemeralId, isTask: true,
                emit: (n, p) => { try { h.emit(n, p); } catch (_) {} childEmit(n, p); },
                signal: h.signal, runId: repairRunId, parentRunId: ctx && ctx.runId,
                trigger: 'directive', surface: 'autonomous', consent: ctx && ctx.consent,
                extraObjects: WORKER_KIT, maxCostUsd: perWorker > 0 ? remaining : 0,
                maxIters: lowerPositive(4, bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters),
                maxToolCalls: bounded ? bounded.workerMaxTools : undefined, steer: h.steer
              });
              return repair ? { text: lastAssistant(repair.messages), result: repair, runId: repairRunId } : null;
            });
            const repaired = contract.repairResult || null;
            const artifacts = [].concat(Array.isArray(result.artifacts) ? result.artifacts : [], Array.isArray(repaired && repaired.artifacts) ? repaired.artifacts : []);
            const r = {
              label, agentId: ephemeralId,
              reason: task.resultSchema && !contract.ok ? 'invalid-result' : ((repaired || result).reason || 'done'),
              result: task.resultSchema && !contract.ok ? 'Subagent output failed its result schema after one bounded repair attempt. No completion was accepted.' : contract.text,
              structuredResult: task.resultSchema && contract.ok ? contract.value : null,
              validation: contract.validation, repairRunId: contract.repairRunId || '',
              usd: (Number(result.usd) || 0) + (Number(repaired && repaired.usd) || 0)
            };
            // ghost-file fix (same as runWorker): the clone's proven outputs, stamped with the owning workspace.
            if (artifacts.length) r.artifacts = artifacts.map(a => Object.assign({}, a, { agentId: ephemeralId, workspace: ephemeralId }));
            settle(r);
            return { status: r.reason === 'done' ? 'done' : 'error', reason: r.reason, result: r.result, usd: r.usd,
              structuredResult: r.structuredResult, validation: r.validation, repairRunId: r.repairRunId, artifacts: r.artifacts };
          };
          const view = subagents.start({ ...projectOptions(ctx), leadId, agentId: ephemeralId, prompt: prompt, context: task.context, runId: newId(), resultSchema: task.resultSchema }, runner);
          return { label, view, done, started: true };
        };

        const spawned = reqs.map(spawnOne);
        if (args.background) {
          const rows = spawned.map(s => Object.assign({ label: s.label }, s.view)).concat(overflowRows());
          return { content: JSON.stringify(rows), summary: 'spawned ' + spawned.filter(s => s.started).length + ' subagent(s)' + overflowNote };
        }
        const results = (await Promise.all(spawned.map(s => s.done))).concat(overflowRows());
        const ok = results.filter(r => r.reason === 'done').length;
        return { content: JSON.stringify(results), summary: 'spawned ' + spawned.filter(s => s.started).length + ' subagent(s), ' + ok + ' done' + overflowNote };
      }
    };

    // team.summon: the LEAD creates a NEW worker on the crew, LIVE, for the Commander — the same action the
    // Commander takes in the Recruitment Bay. CONTRACT: emits crew.summon.request down the run stream (added to
    // shared/events.js); the browser runs the real summonAgent() and POSTs /api/summon/ack with the new agentId,
    // which resolves ctx.summon (mirroring the consent round-trip). The new id is returned so the lead can hand it
    // work with team.dispatch in the SAME run. consent-gated (APPROVAL beat); ctx.summon is only present on a
    // live interactive lead run, so a headless/worker call degrades to a clear "not available" message.
    // THE DESK RIDES ALONG: an agent created because the Commander asked for one is useless standing on bare
    // deck, so the browser's summon seeds that agent's workstation too and reports WHERE on the ack. That is the
    // only prop this path places, and only for the agent being created — team.summon is not a build tool.
    // Class Loadouts S1: the specialist class list is composed from the SHARED catalog (deps.classes =
    // [{id, tagline}]), NOT hardcoded here, so it never drifts from the Recruitment Bay. Falls back to a
    // static list only if no catalog was injected (keeps the tool self-describing under a bare unit test).
    const SPEC_IDS = (Array.isArray(deps.classes) && deps.classes.length)
      ? deps.classes.map(c => c && c.id).filter(Boolean).join(', ')
      : 'researcher, engineer, operator, scribe, analyst, reviewer, scout, archivist, designer, chief, liaison';
    const summonTool = {
      // own wall-clock above the summon's 120s browser-ack backstop, so a stalled ack returns a clean "not
      // completed" instead of tripping the 30s fast-tool default mid-wait. The happy path acks in well under a second.
      timeoutMs: 180000,
      name: 'team.summon', capability: 'orchestrator', scope: 'write', requiresConsent: true,
      description: 'Summon a NEW specialist agent onto the crew for the Commander, live — the same thing they would do in the Recruitment Bay. Use this when a specialist you need does not exist yet; if it is already listed under YOUR TEAM, delegate to it with team.dispatch instead. Pick a class with specId (one of: ' + SPEC_IDS + ') or describe a custom one with name + purpose. The station places the new agent\'s workstation with it, so never tell the Commander to go build it a desk. Returns the new agentId, which you can immediately delegate to. In APPROVAL mode the Commander confirms the summon first.',
      schema: {
        type: 'object', required: ['name'], properties: {
          name: { type: 'string' },        // the new agent's display name (e.g. "RESEARCHER")
          specId: { type: 'string' },       // optional built-in class to base it on (see SPEC_IDS)
          purpose: { type: 'string' },      // optional standing orders for a custom class
          persona: { type: 'string' },      // optional voice/persona id
          skin: { type: 'string' }          // optional sprite skin id
        }
      },
      run: async (args, ctx) => {
        if (!ctx || typeof ctx.summon !== 'function') return { content: 'Summoning is only available on the live station (an interactive run). Ask the Commander to summon this agent from the Recruitment Bay.', summary: 'unavailable' };
        const a = args || {};
        const spec = {
          name: String(a.name || '').trim().slice(0, 40),
          specId: String(a.specId || '').trim().slice(0, 40),
          purpose: String(a.purpose || '').trim().slice(0, 400),
          persona: String(a.persona || '').trim().slice(0, 40),
          skin: String(a.skin || '').trim().slice(0, 40)
        };
        if (!spec.name && !spec.specId) return { content: 'Provide a name or a specId for the new agent.', summary: 'noop' };
        let ack;
        try { ack = await ctx.summon(spec); }
        catch (e) { return { content: 'summon failed: ' + ((e && e.message) || e), summary: 'error' }; }
        // the station resolves { agentId, desk }; a bare id string is still accepted (older stubs/callers).
        const newId = (ack && typeof ack === 'object') ? ack.agentId : ack;
        const desk = (ack && typeof ack === 'object' && ack.desk) ? String(ack.desk) : '';
        if (!newId) return { content: 'The summon was not completed — the Commander declined it, or the station did not respond. No agent was created.', summary: 'declined' };
        // DESK: a summoned specialist needs a workstation to sit and work at, so the station sorts its desk as
        // part of THIS summon. Reported only when the station named a room — never assumed, so the reply can't
        // promise furniture the floor doesn't have (and can't tell the Commander to go build a second one).
        // Worded "workstation is in X", not "placed": the station may have bound a free desk it already had.
        const out = { agentId: newId, name: spec.name || spec.specId };
        if (desk) out.workstation = desk;
        return { content: JSON.stringify(out), summary: 'summoned ' + newId + (desk ? ' (workstation in ' + desk + ')' : '') + ' — now delegate work to it with team.dispatch' };
      }
    };

    const subagentsTool = {
      name: 'team.subagents', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'List or inspect your background subagents. Pass id for one worker, or omit id to list recent workers for this lead. Returned records include the current generation, status, event tail, result, steering history, and whether they can be interrupted or resumed. Use the returned id + generation for team.steer.',
      schema: { type: 'object', properties: { id: { type: 'string' }, agentId: { type: 'string' }, status: { type: 'string' } } },
      run: async (args, ctx) => {
        if (!subagents) return { content: 'background subagents unavailable', summary: 'unavailable' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        if (args && args.id) {
          const r = subagents.get(String(args.id));
          if (!r || r.leadId !== leadId) return { content: 'No such background subagent for this lead.', summary: 'not found' };
          return { content: JSON.stringify(r), summary: r.status };
        }
        const rows = subagents.list({ leadId, agentId: args && args.agentId, status: args && args.status });
        return { content: JSON.stringify(rows), summary: rows.length + ' background subagent(s)' };
      }
    };

    const steerTool = {
      name: 'team.steer', capability: 'orchestrator', scope: 'write', requiresConsent: false,
      description: 'Send a follow-up instruction to one CURRENTLY RUNNING background subagent. First inspect it with team.subagents, then pass the exact id and generation shown there. The host durably queues the instruction for that generation only; a stale generation is rejected and can never land on a resumed worker.',
      schema: {
        type: 'object', required: ['id', 'generation', 'text'],
        properties: { id: { type: 'string' }, generation: { type: 'integer' }, text: { type: 'string' } }
      },
      run: async (args, ctx) => {
        if (!subagents || typeof subagents.steer !== 'function') return { content: 'background steering unavailable', summary: 'unavailable' };
        const r = subagents.steer(String(args.id || ''), (ctx && ctx.agentId) || 'agent', args.generation, args.text);
        return { content: JSON.stringify(r), summary: r.ok ? ('queued for generation ' + r.generation) : 'not queued' };
      }
    };

    function resumeRunnerFor(ctx) {
      return async function (h) {
        const rec = h.record || {};
        const crew = roster() || new Map();
        const ident = crew.get(rec.agentId);
        if (!ident) return { status: 'error', reason: 'error', result: 'worker is no longer in the live roster', usd: 0 };
        const wire = workerWire(ident);   // same cross-provider resolution as a fresh dispatch
        let result;
        const bounded = boundedDomainTask(rec.prompt || '');
        // The durable record carries the lead's handoff `context`, so a resumed worker rebuilds the SAME
        // opening message a fresh dispatch would have — a restart never silently drops the handoff.
        const contractedPrompt = openingMessage(rec.prompt || '', handoffContext(rec.context), rec.resultSchema);
        try {
          result = await runOnce({
            ...projectOptions(ctx, rec), ...connectorOptions(ctx),
            key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
            reasoningEffort: (ident && ident.reasoningEffort) || reasoningEffort,   // Class Loadouts S1: worker's own class effort (see runWorker)
            model: wire.model,
            system: workerSystem((ident && ident.system) || ''),
            messages: [{ role: 'user', content: contractedPrompt }],
            agentId: rec.agentId, isTask: true,
            emit: h.emit, signal: h.signal, runId: h.runId,
            parentRunId: ctx && ctx.runId,
            trigger: 'directive', surface: 'autonomous',
            consent: ctx && ctx.consent,
            extraObjects: WORKER_KIT,
            maxCostUsd: perWorker,
            maxIters: bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters,
            maxToolCalls: bounded ? bounded.workerMaxTools : undefined,
            steer: h.steer
          });
        } catch (e) {
          return { status: 'error', reason: 'error', result: 'worker run failed: ' + ((e && e.message) || e), usd: 0 };
        }
        if (!result) return { status: 'error', reason: 'refused', result: 'worker could not restart', usd: 0 };
        const firstText = lastAssistant(result.messages) || '(the worker returned no text)';
        const contract = await enforceStructured(rec.resultSchema, firstText, async (errors) => {
          const spent = Number(result.usd) || 0;
          const remaining = perWorker > 0 ? Math.max(0, perWorker - spent) : 0;
          if (perWorker > 0 && remaining <= 0) return null;
          const repairRunId = newId();
          const repair = await runOnce({
              outputOnly: true,
            ...projectOptions(ctx, rec), ...connectorOptions(ctx),
            key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
            reasoningEffort: (ident && ident.reasoningEffort) || reasoningEffort,
            model: wire.model, system: workerSystem((ident && ident.system) || ''),
            messages: [{ role: 'user', content: contractedPrompt }, { role: 'assistant', content: firstText },
              { role: 'user', content: '[STRUCTURED RESULT REPAIR] The prior result failed host validation:\n- ' + errors.slice(0, 20).join('\n- ') + '\nReturn ONLY strict JSON matching: ' + JSON.stringify(rec.resultSchema) }],
            agentId: rec.agentId, isTask: true, emit: h.emit, signal: h.signal, runId: repairRunId,
            parentRunId: ctx && ctx.runId, trigger: 'directive', surface: 'autonomous',
            consent: ctx && ctx.consent, extraObjects: WORKER_KIT,
            maxCostUsd: perWorker > 0 ? remaining : 0,
            maxIters: lowerPositive(4, bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters),
            maxToolCalls: bounded ? bounded.workerMaxTools : undefined, steer: h.steer
          });
          return repair ? { text: lastAssistant(repair.messages), result: repair, runId: repairRunId } : null;
        });
        const repaired = contract.repairResult || null;
        const artifacts = [].concat(Array.isArray(result.artifacts) ? result.artifacts : [], Array.isArray(repaired && repaired.artifacts) ? repaired.artifacts : []);
        const invalid = !!(rec.resultSchema && !contract.ok);
        return {
          status: invalid ? 'error' : (((repaired || result).reason || 'done') === 'done' ? 'done' : 'error'),
          reason: invalid ? 'invalid-result' : ((repaired || result).reason || 'done'),
          result: invalid ? 'Worker output failed its result schema after one bounded repair attempt. No completion was accepted.' : contract.text,
          structuredResult: rec.resultSchema && contract.ok ? contract.value : null,
          validation: contract.validation, repairRunId: contract.repairRunId || '',
          usd: (Number(result.usd) || 0) + (Number(repaired && repaired.usd) || 0),
          artifacts: artifacts.map(a => Object.assign({}, a, { agentId: rec.agentId, workspace: rec.agentId }))
        };
      };
    }

    const interruptTool = {
      name: 'team.interrupt', capability: 'orchestrator', scope: 'write', requiresConsent: false,
      description: 'Interrupt one of your running background subagents by id. This aborts its run and keeps its event/result record for inspection or resume.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async (args, ctx) => {
        if (!subagents) return { content: 'background subagents unavailable', summary: 'unavailable' };
        const r = subagents.interrupt(String(args.id || ''), (ctx && ctx.agentId) || 'agent');
        return { content: JSON.stringify(r), summary: r.ok ? (r.alreadyDone ? 'already done' : 'interrupted') : 'not interrupted' };
      }
    };

    const resumeTool = {
      name: 'team.resume', capability: 'orchestrator', scope: 'execute', requiresConsent: false,
      description: 'Resume a stale/interrupted/failed background subagent by id. The worker restarts with the same prompt and appends to the same durable record.',
      preconditions: [{ code: 'inspect_before_resume', requiredTool: 'team.subagents', requiredState: 'stale_or_interrupted_or_failed' }],
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async (args, ctx) => {
        if (!subagents) return { content: 'background subagents unavailable', summary: 'unavailable' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        const rec = subagents.get(String(args.id || ''));
        if (!rec || rec.leadId !== leadId) {
          const error = new Error('No such background subagent for this lead. Inspect the current subagent list before choosing an id.');
          error.precondition = { code: 'inspect_before_resume', requiredTool: 'team.subagents', requiredState: 'owned_subagent_identified' };
          throw error;
        }
        const r = subagents.resume(rec.id, resumeRunnerFor(ctx));
        if (!r.ok) {
          const error = new Error(String(r.error || 'background subagent is not resumable'));
          error.precondition = { code: 'subagent_not_resumable', requiredTool: 'team.subagents', requiredState: 'stale_or_interrupted_or_failed' };
          throw error;
        }
        return { content: JSON.stringify(r), summary: 'resumed' };
      }
    };

    return {
      dispatchTool, spawnTool, summonTool, subagentsTool, steerTool, interruptTool, resumeTool,
      register(reg) { [dispatchTool, spawnTool, summonTool, subagentsTool, steerTool, interruptTool, resumeTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeOrchestrationTools };
});
