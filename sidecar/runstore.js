/* sidecar/runstore.js — the append-only run-history logbook (M-save P4).

   The spend ledger records the COST of each run; this records the OUTCOME — one immutable line per finished
   run ({ runId, agentId, reason, turns, tokens, usd, title, ts }). The full message log is discarded once the
   SSE stream closes, so without this a finished run leaves no durable trace of WHAT happened, only what it
   cost. This is the substrate the plan's "drill any fact to the run that earned it" vision needs, and what a
   future autopsy/replay view reads. It does NOT learn or propose memories — that is the cortex's job, fed by
   the live message array at run end; this is purely the durable record.

   Same split as the ledger: PURE given an injected `io` (readAll/append — the host owns the fsync'd disk
   append) and `clock`. No ambient time/IO, so it passes lint-determinism and tests headlessly with an
   in-memory io. A missing/corrupt file -> empty history (fail-open; a run is never crashed by an unreadable log).

   makeRunStore({ io, clock, limit? }) -> {
     record({ runId, agentId, reason, turns, tokens, usd, title, artifacts? }) -> entry,   // stamps ts, appends, returns it
     list(agentId?, { limit }?) -> entry[]   // newest-first; filtered to agentId when given; capped
     all() -> entry[],   count() -> int
   }

   Work-visibility slice 1 (ADDITIVE): `artifacts` — what the run PRODUCED, as small sanitized records
   ({ kind:'file'|'image'|'message', path?, target?, bytes? }, max 50, strings cut at 260). Collected by
   sidecar/artifacts.js during the run; defaults to []. Rows persisted before the field existed simply
   lack it and still parse/list fine (fail-open — proven in runstore.test.js).

   Roster-honesty P1.2 (ADDITIVE): `identityFallback` — TRUE when the run's agentId was missing from the roster so
   the run executed on the station-persona/default-model FALLBACK rather than the named specialist. An honest
   durable marker (never impersonate silently). Defaults false; old rows lack it and parse fine.

   Deliverable organization (ADDITIVE): `projectRoot` — the blessed project folder this run was scoped to, so the
   work a run PRODUCES can be filed under the thing the Commander was working ON. Same additive-provenance shape as
   `recipeId`: old rows lack it and default ''. The caller records it ONLY when the root is still a standing path
   grant — an unblessed/revoked root files nothing, because the station must never assert a project relationship the
   grant layer can't prove. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).runstore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  // Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
  const REASONS = new Set(['done', 'max_iters', 'budget', 'cancelled', 'error', 'empty', 'refusal', 'clarifying']);
  const DEFAULT_LIMIT = 200;        // a sane cap so list() never returns an unbounded history
  const TITLE_MAX = 120;
  const UNKNOWN_MODEL = '(unknown)';
  const ARTIFACT_KINDS = new Set(['file', 'image', 'message']);
  const ARTIFACTS_MAX = 50;         // a run that writes 500 files still records a bounded row
  const ARTIFACT_STR_MAX = 260;     // classic MAX_PATH — a path/target is a display label, not a blob
  const SESSION_TITLE_MAX = 80;
  const PROJECT_ROOT_MAX = 4096;    // matches handleRun's own clamp on the incoming projectRoot
  const DELIVERABLE_KINDS = new Set(['doc', 'data', 'page', 'patch', 'image', 'files']);   // mirrors tools/builtin/deliverable.js
  const DELIVERY_PROMPT_MAX = 4000;
  const DELIVERY_TEXT_MAX = 24000;
  const TOOL_TRACE_MAX = 200;
  const TOOL_SUMMARY_MAX = 240;
  const FAILURE_FIELD_MAX = 80;
  const UNCERTAIN_MUTATIONS_MAX = 200;
  const COMPLETION_ROWS_MAX = 100;
  const RECOVERY_ATTEMPTS_MAX = 100;
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function nonnegative(v) { return Math.max(0, num(v)); }
  function str(v) { return v == null ? '' : String(v); }
  function modelName(v) { const s = str(v).trim(); return (s || UNKNOWN_MODEL).slice(0, 80); }
  // sanitize the collector's artifact records at the persistence boundary (defense in depth: the collector
  // already caps, but a foreign caller can't write an unbounded/garbage blob into the append-only log).
  function artifactList(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const a of v) {
      if (out.length >= ARTIFACTS_MAX) break;
      if (!a || typeof a !== 'object' || !ARTIFACT_KINDS.has(a.kind)) continue;
      const rec = { kind: a.kind };
      if (a.path != null && str(a.path)) rec.path = str(a.path).slice(0, ARTIFACT_STR_MAX);
      if (a.target != null && str(a.target)) rec.target = str(a.target).slice(0, ARTIFACT_STR_MAX);
      if (typeof a.bytes === 'number' && isFinite(a.bytes) && a.bytes >= 0) rec.bytes = Math.floor(a.bytes);
      if (rec.path || rec.target) out.push(rec);
    }
    return out;
  }

  /* The agent's own prose name for what the run produced (the deliverable_note tool). Sanitized AGAIN here at the
     persistence boundary, the same defense-in-depth the artifact list gets: the tool already allowlists its four
     keys, but this log must stay safe against any other caller. Note what is NOT here — no status, no crew, no
     bytes, no "verified". Those are harness facts derived from this very row; a model-supplied copy of them could
     only ever be a competing claim. Absent/garbage -> null, and the row simply has no authored name. */
  function deliverableNote(v) {
    if (!v || typeof v !== 'object') return null;
    const title = str(v.title).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title) return null;
    const kind = str(v.kind).trim().toLowerCase();
    return {
      title: title,
      summary: str(v.summary).replace(/\s+/g, ' ').trim().slice(0, 240),
      kind: DELIVERABLE_KINDS.has(kind) ? kind : 'files',
      main: str(v.main).trim().slice(0, ARTIFACT_STR_MAX)
    };
  }

  function toolTraceList(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const t of v) {
      if (out.length >= TOOL_TRACE_MAX) break;
      if (!t || typeof t !== 'object') continue;
      const callId = str(t.callId).slice(0, 100);
      const name = str(t.name).slice(0, 80);
      if (!callId || !name) continue;
      out.push({
        callId, name, ok: !!t.ok, isError: !!t.isError,
        ms: nonnegative(t.ms), summary: str(t.summary).slice(0, TOOL_SUMMARY_MAX),
        startedAt: nonnegative(t.startedAt), endedAt: nonnegative(t.endedAt)
      });
    }
    return out;
  }

  function uncertainMutationList(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const item of v) {
      if (out.length >= UNCERTAIN_MUTATIONS_MAX) break;
      if (!item || typeof item !== 'object') continue;
      const callId = str(item.callId).slice(0, 100);
      const name = str(item.name).slice(0, 80);
      if (!callId || item.mutating !== true) continue;
      out.push({ callId, name, mutating: true, state: 'dispatched' });
    }
    return out;
  }

  function completionEvidence(v, authority) {
    const allowedEffects = new Set(['no_observed_effects', 'unverified_effects', 'judgment_required', 'mechanically_verified']);
    const allowedStates = new Set(['unverified', 'judgment_required', 'mechanically_verified']);
    const allowedVerdicts = new Set(['not_assessed', 'verification_required', 'incomplete', 'completed_verified']);
    const src = v && typeof v === 'object' ? v : {};
    const effects = [];
    for (const item of (Array.isArray(src.effects) ? src.effects : [])) {
      if (effects.length >= COMPLETION_ROWS_MAX) break;
      if (!item || typeof item !== 'object') continue;
      const callId = str(item.callId).slice(0, 100), tool = str(item.tool).slice(0, 80);
      if (!callId || !tool || !allowedStates.has(item.state)) continue;
      effects.push({
        callId, tool, domain: str(item.domain).slice(0, 20), target: str(item.target).slice(0, ARTIFACT_STR_MAX),
        state: item.state, evidence: (Array.isArray(item.evidence) ? item.evidence : []).slice(0, 20).map(x => str(x).slice(0, 40))
      });
    }
    const contract = src.contract && src.contract.schemaVersion === 'starnet.task-postconditions.v1'
      && src.contract.authority === 'commander' && Array.isArray(src.contract.requirements)
      ? {
          schemaVersion: src.contract.schemaVersion, authority: 'commander',
          requirements: src.contract.requirements.slice(0, 20).filter(x => x && typeof x === 'object').map(x => ({
            id: str(x.id).slice(0, 80), type: str(x.type).slice(0, 40), path: str(x.path).slice(0, ARTIFACT_STR_MAX),
            text: str(x.text).slice(0, 500), command: str(x.command).slice(0, 1000), sha256: str(x.sha256).slice(0, 64),
            // typed connector read-back (2026-08-22): the durable row names WHAT was read back, never the args
            // payload (it may carry user data) and never the observed text.
            connector: str(x.connector).slice(0, 80), tool: str(x.tool).slice(0, 80), contains: str(x.contains).slice(0, 500), regex: str(x.regex).slice(0, 500)
          }))
        } : null;
    const checks = (Array.isArray(src.checks) ? src.checks : []).slice(0, 20).filter(x => x && typeof x === 'object').map(x => ({
      id: str(x.id).slice(0, 80), type: str(x.type).slice(0, 40),
      status: x.status === 'passed' ? 'passed' : 'failed', code: str(x.code).slice(0, 80)
    }));
    let completionVerdict = allowedVerdicts.has(src.completionVerdict) ? src.completionVerdict : 'not_assessed';
    const hostAssessed = !!authority && src._completionAuthority === authority;
    const structurallyVerified = !!contract && checks.length === contract.requirements.length && checks.length > 0
      && checks.every(x => x.status === 'passed') && src.effectVerdict !== 'unverified_effects' && src.effectVerdict !== 'judgment_required';
    if (!hostAssessed) completionVerdict = 'not_assessed';
    else if (completionVerdict === 'completed_verified' && !structurallyVerified) completionVerdict = 'verification_required';
    const out = {
      schemaVersion: 'starnet.completion-evidence.v1',
      completionVerdict,
      effectVerdict: allowedEffects.has(src.effectVerdict) ? src.effectVerdict : 'no_observed_effects',
      effects
    };
    if (hostAssessed) {
      out.contract = contract;
      out.contractErrors = (Array.isArray(src.contractErrors) ? src.contractErrors : []).slice(0, 20).map(x => str(x).slice(0, 200));
      out.checks = checks;
    }
    return out;
  }

  function recoveryAttemptList(v) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, RECOVERY_ATTEMPTS_MAX).filter(x => x && typeof x === 'object').map((x, index) => ({
      sequence: nonnegative(x.sequence) || index + 1,
      stage: str(x.stage).slice(0, 80), action: str(x.action).slice(0, 40), reason: str(x.reason).slice(0, 80),
      attempt: nonnegative(x.attempt), model: str(x.model).slice(0, 80), delayMs: nonnegative(x.delayMs)
    }));
  }

  // RAM mirror ceiling: the largest served query is list({ limit: 1000 }) (insights) / 500 (run list), so keep
  // generous headroom (~3x) and splice the oldest off when the in-process mirror grows past it. On-disk history
  // stays complete (the append-only log + its rotated segment); only the RAM mirror is bounded so a 24/7 process
  // can't grow it without limit. Disk boot-load is already bounded (readBoundedJsonl), so this matches behavior:
  // the whole-station insights fold already reads only the most-recent bounded window, never lifetime history.
  const RAM_ROWS_MAX = 10000;       // matches the browser progression catch-up's bounded replay horizon

  function makeRunStore(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const cap = num(opts.limit) || DEFAULT_LIMIT;
    const ramMax = num(opts.ramMax) > 0 ? num(opts.ramMax) : RAM_ROWS_MAX;

    // in-memory mirror loaded once; append keeps RAM + disk in lockstep so list() is O(n) over RAM.
    let rows = [];
    try { const raw = io.readAll(); if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object'); }
    catch (e) { rows = []; }
    if (rows.length > ramMax) rows = rows.slice(rows.length - ramMax);   // bound even a large bounded-boot load

    function record(e) {
      e = e || {};
      const entry = {
        runId: str(e.runId), parentRunId: str(e.parentRunId).slice(0, 100), agentId: str(e.agentId),
        provider: str(e.provider).trim().slice(0, 60),
        reason: REASONS.has(e.reason) ? e.reason : 'done',     // clamp to the known enum (matches agent.run.end)
        turns: num(e.turns), tokens: num(e.tokens), usd: num(e.usd),
        title: str(e.title).slice(0, TITLE_MAX),
        streamId: str(e.streamId),     // H3.2: the run's workstream — joins this outcome row to its transcript (GET /api/transcript?stream=)
        // Durable session-delivery envelope. The page bridge is best-effort (and multiple open pages may disagree
        // about local session ids), so a later page can reconcile a completed worker by its stable title + runId.
        sessionTitle: str(e.sessionTitle).trim().slice(0, SESSION_TITLE_MAX),
        deliveryPrompt: str(e.deliveryPrompt).slice(0, DELIVERY_PROMPT_MAX),
        deliveryText: str(e.deliveryText).slice(0, DELIVERY_TEXT_MAX),
        recipeId: str(e.recipeId).slice(0, 60),   // provenance spine (additive): WHICH recipe launched this run ('' for non-recipe runs; old rows lack it and default '')
        projectRoot: str(e.projectRoot).slice(0, PROJECT_ROOT_MAX),   // deliverable organization (additive): the BLESSED project folder this run was scoped to ('' when unscoped/unblessed)
        deliverable: deliverableNote(e.deliverable),                  // deliverable organization (additive): the agent's own PROSE name for the work (null when it never named it)
        reasoningEffort: str(e.reasoningEffort).trim().slice(0, 20),
        model: modelName(e.model),   // H3.3/G6: actual model used, or explicit (unknown) as a last resort
        unmetered: !!e.unmetered,    // G6.2: subscription usage is counted, not summed as $0 spend
        artifacts: artifactList(e.artifacts),   // work-visibility: what the run PRODUCED (additive; [] default)
        toolsOk: num(e.toolsOk),                // crate-honesty (additive): successful tool results — proven work, not just talk. Old rows default 0.
        identityFallback: !!e.identityFallback, // P1.2 (additive): TRUE when this run's agentId was MISSING from the roster and it ran on the station-persona/default-model fallback — an honest marker that it was NOT the named specialist. Old rows lack it and default false.
        internal: !!e.internal,                 // progression catch-up excludes harness self-talk from agent work
        clarifying: !!e.clarifying,             // additive outcome truth; `reason` remains the execution terminal
        toolTrace: toolTraceList(e.toolTrace),
        failureStage: str(e.failureStage).trim().slice(0, FAILURE_FIELD_MAX),
        failureCode: str(e.failureCode).trim().slice(0, FAILURE_FIELD_MAX),
        uncertainMutations: uncertainMutationList(e.uncertainMutations),
        completionEvidence: completionEvidence(e.completionEvidence, opts.completionAuthority),
        recoveryAttempts: recoveryAttemptList(e.recoveryAttempts),
        startedAt: nonnegative(e.startedAt), endedAt: nonnegative(e.endedAt), durationMs: nonnegative(e.durationMs),
        ts: num(e.ts) || clock.now()
      };
      rows.push(entry);
      // bound the RAM mirror: splice the oldest off past the ceiling. Disk keeps the full append-only log; only
      // this in-process array is capped so a long-lived process doesn't leak. The cap is well above every served
      // query horizon (≤1000), so no list()/insights query is ever short-changed within the window it reads.
      if (rows.length > ramMax) rows.splice(0, rows.length - ramMax);
      try { io.append(entry); } catch (e) { failNote('runstore.append', e); }
      return entry;
    }

    function list(agentId, o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? num(o.limit) : cap;
      const want = agentId == null ? null : str(agentId);
      const beforeRunId = o.beforeRunId == null ? '' : str(o.beforeRunId);
      const since = num(o.since);
      const through = num(o.through);
      const out = [];
      let afterCursor = !beforeRunId;
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {   // newest-first
        const row = rows[i];
        if (!afterCursor) {
          if (row.runId === beforeRunId) afterCursor = true;
          continue;
        }
        if (want != null && row.agentId !== want) continue;
        if (since > 0 && num(row.ts) <= since) continue;
        if (through > 0 && num(row.ts) > through) continue;
        out.push(Object.assign({}, row));
      }
      return out;
    }

    return {
      record, list,
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; }
    };
  }

  return { makeRunStore };
});
