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
    typeof require === 'function' ? require('../../result-contract.js') : (root.SK && root.SK.resultContract),
    typeof require === 'function' ? require('../../run-spend-pool.js') : (root.SK && root.SK.runSpendPool)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).orchestration = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (domainTask, schemaLib, runSpendPool) {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  // The background-worker controls a BACKGROUND team.spawn / team.dispatch result reveals: a crewless lead holds them
  // deferred (index.js ZERO-CREW DIET), so the workers it just started must be one call away, not one search away.
  const BACKGROUND_CONTROLS = Object.freeze(['team.subagents', 'team.steer', 'team.interrupt', 'team.resume']);
  /* WHAT THE LEAD READS of a background start (rc walk 10-14: "The task is running under runId 8b7d03a9-2b85-…" — the lead
     quoted the start row's internals to the Commander). The handle it needs to watch, steer or stop the worker (id +
     generation), who it is and its state — nothing else. The run ids, the prompt it just wrote and the empty event log stay
     in the durable record, where team.subagents reads them when they are asked for. A row with no id (a refused worker)
     passes through whole: its reason is the message. */
  const startedHandle = v => (v && v.id) ? { id: v.id, agentId: v.agentId, status: v.status, generation: v.generation } : v;
  /* A worker the way the briefing SHOWS it: the crew list prints "id (Name) — role", and small local models
     (2026-10-11 report: a Qwen lead that "would not delegate") answer with "Researcher" or "researcher (Ada)"
     and got a bare "no such live worker" back, so they gave up and did the work themselves. An UNAMBIGUOUS
     id-in-any-case or exact display-name match resolves to the real agentId; anything else still fails. */
  function resolveWorkerId(raw, crew, leadId) {
    const asked = String(raw || '').trim();
    if (crew.has(asked)) return asked;
    const key = asked.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
    if (!key) return asked;
    const hits = [];
    for (const [aid, ident] of crew) {
      if (aid === leadId) continue;
      const name = String((ident && ident.name) || '').trim().toLowerCase();
      if (aid.toLowerCase() === key || (name && name === key)) hits.push(aid);
    }
    return hits.length === 1 ? hits[0] : asked;
  }
  const crewIdsHint = (crew, leadId) => {
    const ids = [...crew.keys()].filter(id => id !== leadId);
    return ids.length ? ' Valid agentIds: ' + ids.slice(0, 12).join(', ') + (ids.length > 12 ? ', …' : '') + '.' : ' This station has no other crew yet; use team.summon to create one.';
  };
  // events forwarded from a child run onto the LEAD's bus — ENOUGH to animate the handoff + keep cost honest,
  // but NOT the child's tokens/tool-calls (those would clutter the lead's COMMS). The lead reads the worker's
  // actual output from the tool RESULT, not the stream.
  // 'deliverable' forwards too (2026-07-07 escape): a worker's saved image/file was INVISIBLE — no COMMS card,
  // no crate, no notify — because the event died here. The payload already carries the OWNING agentId and its
  // jail-relative path, and the frontend card opens /api/file?agent=<owner>, so forwarding is the whole fix.
  const FORWARD = { 'agent.run.start': 1, 'agent.run.end': 1, 'agent.run.error': 1, 'agent.cost': 1, 'deliverable': 1 };
  /* A worker's TOOL STEPS reach the lead's stream too (SUMMON LINES, 2026-10-19) — the floor's activity tag, the CREW
     card's step and the DELEGATED row read them — but ONLY as the additive crew.tool_step event (2026-10-26 fix), never
     under agent.tool_call/tool_result: every lead-side sink (CLI tracker + receipt, /api/observe, Telegram/routine/
     line-hop reply buffers, phone remote, ACP, /v1) keys on those names and took a worker's step for the lead's own
     (doubled dashboard rows, wiped replies, miscounted receipts). Those sinks ignore an unknown name; the page's
     harness translates crew.tool_step back for the floor. */
  function makeChildEmit(ctx) {
    const names = new Map();   // callId -> tool name, so a result step carries the name its call had
    return (name, payload) => {
      if (!ctx || typeof ctx.emit !== 'function') return;
      if (FORWARD[name]) { try { ctx.emit(name, payload); } catch (_) {} return; }
      if (name !== 'agent.tool_call' && name !== 'agent.tool_result') return;
      const p = payload || {}, callId = String(p.callId == null ? '' : p.callId);
      const step = { agentId: String(p.agentId || ''), runId: String(p.runId || ''), parentRunId: String(ctx.runId || ''), callId, phase: name === 'agent.tool_call' ? 'call' : 'result' };
      if (step.phase === 'call') {
        step.name = String(p.name || ''); if (callId) names.set(callId, step.name);
        if (typeof p.argsSummary === 'string') step.argsSummary = p.argsSummary;
      } else {
        step.name = names.get(callId) || ''; names.delete(callId);
        if (typeof p.ok === 'boolean') step.ok = p.ok;
        if (typeof p.isError === 'boolean') step.isError = p.isError;
        if (typeof p.ms === 'number' && isFinite(p.ms)) step.ms = p.ms;
      }
      try { ctx.emit('crew.tool_step', step); } catch (_) {}
    };
  }
  // a delegated worker's added kit, on top of the autonomous full office (compute/web/files/memory/studio/jukebox):
  // the WORKBENCH (terminal). Paired with the SHARED lead consent broker, writes follow the lead's APPROVAL posture.
  // Commands do NOT in ASK mode: a worker runs surface:'autonomous', so the run authority withholds shell.exec /
  // verify.run unless the worker (or the station) is Full Access — see the runOnce call below. The worker is told
  // that plainly, with the step that works (sidecar/capability/withheld.js, issue #77).
  const WORKER_KIT = [{ instanceId: 'wb_worker', objectType: 'workbench' }];
  /* THE LENT BUILDER (2026-10-11, the delegated Build Manager): a lead that holds the station builder may lend a
     SLICE of it (station.map / station.plan / station.build — CAP_REGISTRY.builder) to one worker for one job with
     builder:true. Every build goes through the lead's shared consent broker: a card per build in ASK, none under Full
     Access or an existing orchestrator:write grant; recruiting crew and binding services are refused in station.plan for a delegated run, and making props,
     testing and starting lines stay the lead's. Only for a lead whose own run can build: a lend never widens. */
  const BUILDER_KIT = [{ instanceId: 'builder_lent', objectType: 'builder' }];
  const kitFor = lent => (lent ? WORKER_KIT.concat(BUILDER_KIT) : WORKER_KIT);
  const canLendBuilder = ctx => { try { const r = ctx && typeof ctx.canUse === 'function' ? ctx.canUse({ name: 'station.build' }) : null; return !!(r && r.ok); } catch (_) { return false; } };
  // isFile: the worker run's own file probe (deps.fileProbe) — the dispatcher and the worker's run answer ONE way.
  // Only a PURE one-host read is bounded (starnet-releases#5): a brief that also asks the worker to write, fix, test,
  // run, save, build or implement keeps the ordinary worker budgets — 3 tools and 45s cut engineering work off mid-job.
  const boundedDomainTask = (text, isFile) => {
    try {
      const policy = domainTask && typeof domainTask.classify === 'function' ? domainTask.classify(text, isFile ? { isFile } : undefined) : null;
      return policy && policy.pureRead ? policy : null;
    } catch (_) { return null; }
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

  /* EVERY WORKER STAYS VISIBLE (Step 2 wave 2, Hermes audit 2026-09-22). team.dispatch returned every worker's full
     text as ONE JSON array, and the registry's per-result cap then cut that string head+tail: probed with 4 workers
     x 30k characters, worker 3's row — its agentId, its status, all of it — was simply gone from what the lead saw,
     so the lead could not even tell a worker had run. The fit now happens HERE, row-aware, before the registry ever
     sees the string: every row keeps all of its identity/status fields, and only the long text field is shortened,
     each row offered a FAIR SHARE of the result budget (water-filled: a short answer keeps all of its text and hands
     the surplus to the long ones), head + tail with a marker in the middle. A shortened text is first saved WHOLE
     through the host parker (ctx.parkOutput, the same one the registry uses) into a per-worker file, and the row
     names it: additive fields `resultChars` (full length), `resultTruncated: true`, `resultPath` (null if the save
     failed — the marker then says the text was NOT saved). The budget is ctx.outputMax (the registry hands every
     tool the per-result cap it will enforce, window-scaled by the host), else the registry's 80k default. A result
     that already fits is returned untouched (byte-identical). If identity alone would crowd the texts out, bulky
     metadata (validation detail, long artifact lists, event tails, prompts) is compacted first and says so. */
  const AGG_DEFAULT_BUDGET = 80000;   // tools/registry.js OUTPUT_MAX's default: the budget when no host figure arrives
  const AGG_SHORT_ROOM = 200;         // below this much kept text a shortened row carries the SHORT marker
  const { note: failNote } = (typeof require === 'function') ? require('../../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  function aggregateBudget(ctx) {
    const n = Number(ctx && ctx.outputMax);
    return (Number.isFinite(n) && n > 0) ? Math.floor(n) : AGG_DEFAULT_BUDGET;
  }
  function escLen(s) { return JSON.stringify(String(s)).length - 2; }   // the text's length INSIDE the JSON result
  function cutMarker(fullChars, keptChars, path, what, short) {
    const dropped = fullChars - keptChars;
    if (short) return '\n[... ' + dropped + ' of ' + fullChars + ' chars elided' + (path ? '; full text saved to ' + path : '; full text NOT saved') + ' ...]\n';
    return '\n\n[... ' + dropped + ' of ' + fullChars + ' characters of ' + what + ' elided so every row fits in this result. '
      + (path ? 'THE FULL TEXT WAS SAVED to ' + path + ' — read that file for the missing part; do not re-run the work to recover it.'
        : 'The full text could NOT be saved; do not present the elided part as something you saw.')
      + ' The end follows ...]\n\n';
  }
  // One text -> head + marker + tail within `allowEsc` JSON-escaped characters (best effort; fitAggregate verifies).
  function cutText(text, allowEsc, path, what) {
    const ratio = text.length / Math.max(1, escLen(text));   // raw chars per escaped char (<= 1)
    const short = allowEsc - escLen(cutMarker(text.length, 0, path, what, false)) < AGG_SHORT_ROOM;
    const draft = cutMarker(text.length, 0, path, what, short);
    const room = Math.min(text.length, Math.max(0, Math.floor((allowEsc - escLen(draft) - 8) * ratio)));
    const head = Math.floor(room * 0.7), tail = room - head;
    return text.slice(0, head) + cutMarker(text.length, room, path, what, short) + text.slice(text.length - tail);
  }
  // Bulky, non-identity metadata, trimmed only when identity alone would crowd the texts out. Says what it dropped.
  function compactRow(r) {
    const c = Object.assign({}, r);
    if (c.validation && typeof c.validation === 'object' && c.validation.attempts) c.validation = { state: c.validation.state };
    if (Array.isArray(c.artifacts) && c.artifacts.length > 8) { c.artifactsOmitted = c.artifacts.length - 8; c.artifacts = c.artifacts.slice(0, 8); }
    if (c.structuredResult != null && JSON.stringify(c.structuredResult).length > 2000) { c.structuredResult = null; c.structuredResultOmitted = true; }
    for (const k of ['prompt', 'context']) if (typeof c[k] === 'string' && c[k].length > 400) c[k] = c[k].slice(0, 400) + '…';
    for (const k of ['events', 'steerHistory']) if (Array.isArray(c[k]) && c[k].length > 5) c[k] = c[k].slice(-5);
    return c;
  }
  // rows -> { rows, cut, saved }. opts: { budget, what(row) -> label, park(text, row) -> Promise<path|null> }.
  async function fitAggregate(rows, opts) {
    const o = opts || {};
    const budget = Number(o.budget) > 0 ? Math.floor(Number(o.budget)) : AGG_DEFAULT_BUDGET;
    if (!Array.isArray(rows) || !rows.length || JSON.stringify(rows).length <= budget) return { rows: rows, cut: 0, saved: 0 };
    const isRow = r => r && typeof r === 'object';
    let work = rows.map(r => isRow(r) ? Object.assign({}, r) : r);
    const texts = work.map(r => (isRow(r) && typeof r.result === 'string') ? r.result : null);
    const emptied = () => work.map((r, i) => texts[i] != null ? Object.assign({}, r, { result: '' }) : r);
    let overhead = JSON.stringify(emptied()).length;
    if (overhead > budget / 2) { work = work.map(r => isRow(r) ? compactRow(r) : r); overhead = JSON.stringify(emptied()).length; }
    const idx = [];
    for (let i = 0; i < work.length; i++) if (texts[i]) idx.push(i);
    const lens = idx.map(i => escLen(texts[i]));
    const parked = new Map();
    async function parkFor(i) {
      if (parked.has(i)) return parked.get(i);
      let p = null;
      if (typeof o.park === 'function') {
        try { p = await o.park(texts[i], work[i]); } catch (e) { failNote('orchestration.fit.park', e); p = null; }
      }
      p = p ? String(p) : null;
      parked.set(i, p);
      return p;
    }
    // Per-row additions (resultChars/resultTruncated/resultPath) and markers are not in `overhead`: the first pass
    // measures them and each retry shrinks the text pool by the overshoot, so the result converges UNDER budget.
    let pool = Math.max(0, budget - overhead - idx.length * 64);
    let out = work, cut = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const order = idx.map((_, k) => k).sort((a, b) => lens[a] - lens[b]);
      const allow = new Array(idx.length);
      let remaining = pool, left = order.length;
      for (const k of order) { const share = Math.floor(remaining / left); allow[k] = Math.min(lens[k], share); remaining -= allow[k]; left--; }
      out = work.slice(); cut = 0;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        if (allow[k] >= lens[k]) { out[i] = Object.assign({}, work[i], { result: texts[i] }); continue; }
        const path = await parkFor(i);
        const what = typeof o.what === 'function' ? o.what(work[i]) : 'this row\'s result';
        out[i] = Object.assign({}, work[i], { result: cutText(texts[i], allow[k], path, what), resultChars: texts[i].length, resultTruncated: true, resultPath: path });
        cut++;
      }
      const total = JSON.stringify(out).length;
      if (total <= budget || pool === 0) break;
      pool = Math.max(0, pool - (total - budget) - 32);
    }
    let saved = 0;
    for (const p of parked.values()) if (p) saved++;
    return { rows: out, cut: cut, saved: saved };
  }
  // The per-worker spill: the host parker (ctx.parkOutput) writes the worker's WHOLE text into the lead's own
  // workspace (.output/<tool>-<worker>-…txt), where fs.read can page it back. No parker = no file, said plainly.
  /* IDEMPOTENT PARKING. team.subagents is a read the lead POLLS: every list call re-parked every long worker result,
     so a lead checking on its crew each turn wrote a fresh .output file per worker per poll — identical copies piling
     up in its workspace. The same text for the same worker now reuses the file it was already saved to. Scoped to
     the host parker (one per run: capCtx.parkOutput), keyed by tool + worker id + a digest of the text, bounded. */
  const parkedByParker = (typeof WeakMap === 'function') ? new WeakMap() : null;
  const PARK_MEMO_MAX = 256;
  function textDigest(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;   // two FNV-1a lanes (different seeds) + the length: ~2^-64 collisions
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
    }
    return h1.toString(16) + h2.toString(16) + ':' + s.length;
  }
  function workerParker(ctx, tool) {
    if (!ctx || typeof ctx.parkOutput !== 'function') return null;
    let memo = parkedByParker ? parkedByParker.get(ctx.parkOutput) : null;
    if (parkedByParker && !memo) { memo = new Map(); parkedByParker.set(ctx.parkOutput, memo); }
    return async (text, row) => {
      const who = String((row && (row.agentId || row.label)) || 'worker').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 24);
      const key = tool + '\u0000' + String((row && (row.id || row.agentId || row.label)) || 'worker') + '\u0000' + textDigest(String(text));
      if (memo && memo.has(key)) return memo.get(key);
      const meta = { tool: tool + '-' + who, reason: 'aggregate-fair-share' };
      if (row && typeof row.taintedBy === 'string' && row.taintedBy) meta.taintedBy = row.taintedBy;   // parked as untrusted-*
      const p = await ctx.parkOutput(text, meta);
      const path = p && p.path ? String(p.path) : null;
      if (memo && path) {   // a failed save is not remembered: the next call may succeed
        if (memo.size >= PARK_MEMO_MAX) memo.delete(memo.keys().next().value);
        memo.set(key, path);
      }
      return path;
    };
  }
  function fitNote(fit) {
    return fit && fit.cut ? ' — ' + fit.cut + ' result(s) shortened to fit (' + fit.saved + ' saved in full, see resultPath)' : '';
  }

  /* WHY THE HOST STOPPED A REGISTRY WORKER (Step 2 F2/F3). subagents.js aborts a worker's own controller with a
     coded reason: 'parent_cancelled' (the run that started it was cancelled) or 'worker_stalled' (the liveness
     check saw no progress). The run itself only knows it was cancelled; the row the lead receives must say which,
     so a stalled worker never reads as a Commander stop and neither reads as finished work. '' = not a host stop. */
  function hostStopCode(signal) {
    const r = signal && signal.aborted ? signal.reason : null;
    const code = r && typeof r === 'object' ? String(r.code || '') : '';
    return (code === 'parent_cancelled' || code === 'worker_stalled') ? code : '';
  }
  function hostStopRow(code, partial) {
    return {
      reason: code === 'worker_stalled' ? 'stalled' : 'cancelled',
      result: (partial ? partial + '\n\n' : '')
        + (code === 'worker_stalled'
          ? '[STOPPED — this worker made no progress (no tokens, tool activity or cost) for longer than the liveness threshold, so the host stopped it'
          : '[STOPPED — the run that started this worker was cancelled, so the host stopped the worker too')
        + (partial ? '; the text above is its PARTIAL work' : ' before it returned any text')
        + '. Do not present it as complete.]'
    };
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

  // the host-minted restrictions a worker starts under, saved on its durable record (subagents originLimits)
  function originLimitsOf(ctx) {
    const a = ctx && ctx.connectorAuthority;
    if (!a || typeof a !== 'object') return null;
    let t = ''; try { t = typeof a.taintedBy === 'function' ? String(a.taintedBy() || '') : ''; } catch (_) { t = ''; }
    return { withholdHostPower: a.withholdHostPower === true, untrustedEntry: a.untrustedEntry === true, withholdTaste: a.withholdTaste === true, taintedBy: t };
  }
  /* THE LEAD RUN'S PER RUN CAP COVERS ITS WORKERS (bug d3a76db3: a $0.05 cap ran $0.24 through four team.spawn clones,
     each started with its own full ceiling). The host mints a spend pool on the lead's tool ctx; every worker, clone,
     structured-result repair and resumed worker run is handed it and JOINS it (index.js runOnce, run-spend-pool.js),
     so the lead and its crew draw from one cap and are stopped by it. Host context only — never a tool argument. */
  function spendPoolOptions(ctx) {
    const pool = ctx && ctx.spendPool;
    return (pool && typeof pool.admit === 'function' && typeof pool.join === 'function') ? { spendPool: pool } : {};
  }
  /* RESUME NEVER WIDENS (sweep 2026-10-02): team.resume re-runs a stored worker prompt under the RESUMING run's authority.
     The worker's own origin limits are ORed in, so a prompt written in a phone / non-owner / payload-started run keeps
     its restrictions however unrestricted the lead that resumes it is. */
  function resumeConnectorOptions(ctx, rec) {
    const base = connectorOptions(ctx);
    const lim = rec && rec.originLimits;
    if (!lim || !(lim.withholdHostPower || lim.untrustedEntry || lim.withholdTaste || lim.taintedBy)) return base;
    const a = Object.assign({}, base.connectorAuthority || {});
    if (lim.withholdHostPower) { a.withholdHostPower = true; a.fullAccess = () => false; }
    if (lim.untrustedEntry) a.untrustedEntry = true;
    if (lim.withholdTaste) a.withholdTaste = true;
    if (lim.taintedBy) { const prev = a.taintedBy; a.taintedBy = () => (typeof prev === 'function' && prev()) || lim.taintedBy; }
    // resumedTaint: the STORED task's own taint, so a refusal can say the lock rides the task (any session that
    // resumes it), not the resuming lead's chat — a clean lead resuming it has nothing to fix in its own session.
    return { connectorAuthority: a, initialTaint: base.initialTaint || lim.taintedBy || null, resumedTaint: lim.taintedBy || null };
  }
  function connectorOptions(ctx) {
    // Functions are supplied by the host context, never by tool arguments or a persisted worker record.
    const authority = ctx && ctx.connectorAuthority;
    return authority ? { connectorAuthority: authority, initialTaint: typeof authority.taintedBy === 'function' ? authority.taintedBy() : null } : {};
  }

  /* RELAYED TAINT (sec-taint 09-25). A worker's text is only as trustworthy as what the worker read. runOnce reports
     the worker run's host-proven latch as result.taintedBy; every row / record that carries worker text carries it
     too, and every tool result that relays such rows reports the first one — registry.js passes it through and the
     run host latches the LEAD (taint.relayedTaint). Rows are host-built, never model-authored. */
  function taintOfRun() {
    for (let i = 0; i < arguments.length; i++) {
      const r = arguments[i];
      const t = r && typeof r.taintedBy === 'string' ? r.taintedBy.trim() : '';
      if (t) return t.slice(0, 200);
    }
    return '';
  }
  function taintOfRows(rows) {
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const t = r && typeof r.taintedBy === 'string' ? r.taintedBy.trim() : '';
      if (t) return t.slice(0, 200);
    }
    return '';
  }
  function withTaint(res, taint) { if (taint) res.taintedBy = taint; return res; }

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
    /* runRecord(runId) -> the station's durable run-history row, or null (host injects runStore.latest). It is how a
       lead VERIFIES a foreground team.dispatch: that path never enters the background registry, so team.subagents
       used to answer [] for real, recorded worker runs and the lead reported them as never having happened (#57). */
    const runRecord = (typeof deps.runRecord === 'function') ? deps.runRecord : null;
    /* ONE BRIEF, ONE ANSWER (review 10-15). The worker's own run classifies its brief with the host's file probe (index.js
       runFileExists: that worker's workspace + the project it runs in), so "check about.me" with about.me in its
       workspace is not a one-host check there. The dispatcher classified the same brief on text alone and still capped
       that worker at 3 turns / 3 tools / 45s. fileProbe(agentId, projectRoot) -> (name) -> boolean, asked with the
       SAME agent id and project the worker run gets. No probe wired (bare/legacy host) -> text-only, as before. */
    const fileProbeFor = (aid, projectRoot) => {
      if (typeof deps.fileProbe !== 'function') return null;
      try { const probe = deps.fileProbe(aid, projectRoot); return typeof probe === 'function' ? probe : null; }
      catch (e) { failNote('dispatch.file-probe', e); return null; }
    };
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
          : 'ASK FIRST. Writes and network calls (and commands, when shell_exec is in your tool list) are shown to the Commander for approval when you call the '
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
    function openingMessage(prompt, context, resultSchema, earlier) {
      const ask = resultSchema
        ? String(prompt || '') + '\n\n[STRUCTURED RESULT CONTRACT] Return ONLY strict JSON matching this schema: ' + JSON.stringify(resultSchema)
        : String(prompt || '');
      const parts = [];
      if (context) parts.push('[LEAD CONTEXT — what your lead already established for this task. Treat it as settled starting knowledge; do not re-derive it, and re-verify it only where it contradicts what you observe.]\n' + context);
      if (earlier) parts.push(EARLIER_HEADER + '\n' + earlier);
      if (!parts.length) return ask;
      return parts.join('\n\n') + '\n\n[YOUR SUBTASK]\n' + ask;
    }
    /* THE HAND-OFF BETWEEN WORKERS (2026-10-13 live walkthrough). A sequential dispatch ran its workers one after
       another but told each one NOTHING about the ones before it: asked for "a researcher finds 3 launch emails, a
       copywriter drafts ours from them", the copywriter re-did the research from scratch (25 web steps), ran out of
       its slice, and the Commander got no email after paying for both. Each later worker in a SEQUENTIAL dispatch now
       opens with what the earlier workers returned (bounded) plus the exact files they saved, and may READ those
       exact files (host-resolved, read-only, this run only — see pathtrust readGrants). A worker that read outside
       content passes that taint on: the next worker starts under the same limits. Parallel workers run at the same
       time, so nothing is handed between them. */
    const EARLIER_HEADER = '[EARLIER WORKERS IN THIS HAND-OFF — their finished output is your input. Build on it; do not redo their work. You can fs_read the files listed under each one at those exact paths.]';
    const EARLIER_EACH_MAX = 3000, EARLIER_MAX = 8000;
    // user-visible text for a row whose `result` carries a model-directed note (the timeout row): never shown to the Commander
    const shownText = new WeakMap();
    const userTextOf = (row) => shownText.has(row) ? shownText.get(row) : String((row && row.result) || '');
    const workerName = (aid) => { const id = (crewNow && crewNow.get && crewNow.get(aid)) || null; return String((id && id.name) || aid || 'worker').toUpperCase(); };
    let crewNow = null;
    async function resolveHandoffFiles(aid, artifacts) {
      if (typeof deps.handoffFiles !== 'function' || !Array.isArray(artifacts) || !artifacts.length) return [];
      try { const got = await deps.handoffFiles(aid, artifacts); return Array.isArray(got) ? got.filter(f => f && f.abs) : []; }
      catch (e) { failNote('dispatch.handoff-files', e); return []; }
    }
    async function earlierHandoff(rows) {
      const usable = (rows || []).filter(r => r && (r.reason === 'done' || r.reason === 'timeout'));
      if (!usable.length) return null;
      const reads = [], blocks = [];
      for (const r of usable) {
        const files = await resolveHandoffFiles(r.agentId, r.artifacts);
        for (const f of files) reads.push(String(f.abs));
        const text = userTextOf(r).trim();
        const clipped = text.length > EARLIER_EACH_MAX ? text.slice(0, EARLIER_EACH_MAX) + ' …(cut — read the file for the rest)' : text;
        blocks.push('— ' + workerName(r.agentId) + (r.reason === 'timeout' ? ' (UNFINISHED — ran out of time)' : '') + ':\n'
          + (clipped || '(returned no text)') + (files.length ? '\nFiles: ' + files.map(f => f.abs).join(', ') : ''));
      }
      return { text: blocks.join('\n\n').slice(0, EARLIER_MAX), reads, taint: taintOfRows(usable) || '' };
    }
    /* A WORKER'S CLOCK STOPS WHILE IT WAITS ON THE COMMANDER. The slice is for the worker's work: an fs_write approval
       sitting unanswered (the Commander was in BUILD MODE) used to drain it, and the worker was cut off with its draft
       unsaved. hold()/release() pause the slice around every consent prompt; the dispatch credits the held time back to
       the whole wall clock (bounded, so a prompt nobody answers can't hold a dispatch open forever). Needs the host
       clock — without one (bare unit callers) the slice runs as before. */
    const APPROVAL_HOLD_MAX_MS = (typeof deps.approvalHoldMaxMs === 'number' && deps.approvalHoldMaxMs >= 0) ? deps.approvalHoldMaxMs : 900000;
    function pausableSlice(ms, onExpire, clockNow, onHeld) {
      let left = ms, startedAt = clockNow(), timer = setTimeout(onExpire, ms), holds = 0, heldAt = 0;
      return {
        hold() {
          if (holds++ > 0 || !timer) return;
          clearTimeout(timer); timer = null;
          const t = clockNow(); left -= Math.max(0, t - startedAt); heldAt = t;
        },
        // credit false: a spend-pool hold (its time is credited by poolHoldClock), never the approval allowance
        release(credit) {
          if (holds === 0 || --holds > 0) return;
          const t = clockNow(); if (onHeld && credit !== false) onHeld(Math.max(0, t - heldAt));
          startedAt = t; timer = setTimeout(onExpire, Math.max(1, left));
        },
        clear() { if (timer) clearTimeout(timer); timer = null; holds = 0; }
      };
    }
    function holdDuringConsent(consent, slice) {
      if (typeof consent !== 'function' || !slice) return consent;
      const held = async function () { slice.hold(); try { return await consent.apply(this, arguments); } finally { slice.release(); } };
      return Object.assign(held, consent);
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
    /* A WORKER HELD BY THE RUN'S SPEND POOL IS NOT WORKING (bug d3a76db3, review of 32fc352e4). The PER RUN pool
       (run-spend-pool.js) trades time for its bound: near the cap, or on a model whose calls it must reserve high (or
       cannot price at all), a worker's call waits until a call in flight settles. That wait must not run down the
       clocks that bound the work, or a family that finishes in parallel on its own time is timed out by the holds
       alone — team.spawn's registry timeout aborted every clone and returned only "timed out". So while a foreground
       worker's call is held, its own slice (team.dispatch) pauses, and while ANY worker this call started is held, the
       tool's registry timeout pauses (ctx.holdTimeout, tools/registry.js) and the dispatch's wall clock does not count
       the time (heldMs). Every hold waits on a call that is in flight, so it ends; the clocks still bound each
       worker's own time. A background worker outlives the call, so the call's clocks never watch it.
       THE LIVENESS SWEEP TOO (review of 8f4267c08): every worker the subagent manager runs — a team.spawn clone,
       foreground or background, a background team.dispatch worker, a resumed worker — is swept for no progress
       (subagents.js checkStalls), and a held call emits nothing. Its holds stop that worker's stall clock as well
       (the handle's holdStall/releaseStall), or a clone held behind a fellow's long call was stopped as "stalled". */
    function poolHoldClock(ctx) {
      let held = 0, since = 0, total = 0, release = null;
      return {
        hold() {
          if (held++ > 0) return;
          since = now();
          release = (ctx && typeof ctx.holdTimeout === 'function') ? ctx.holdTimeout() : null;
        },
        release() {
          if (held === 0 || --held > 0) return;
          total += Math.max(0, now() - since);
          const r = release; release = null;
          if (typeof r === 'function') r();
        },
        heldMs() { return total + (held > 0 ? Math.max(0, now() - since) : 0); }
      };
    }
    /* the pool one worker run joins, seen through its holds (run-spend-pool.js watchHolds); end() in its finally.
       family: the call's poolHoldClock (foreground only); slice: the worker's own wall clock; stall: the subagent
       manager's handle (h) of a worker it runs, whose stall clock a hold stops. */
    function watchedPool(ctx, family, slice, stall) {
      const base = spendPoolOptions(ctx);
      const sweep = (stall && typeof stall.holdStall === 'function' && typeof stall.releaseStall === 'function') ? stall : null;
      if (!base.spendPool || !(family || slice || sweep) || !runSpendPool || typeof runSpendPool.watchHolds !== 'function') return { options: base, end: () => {} };
      const view = runSpendPool.watchHolds(base.spendPool, {
        hold() { if (family) family.hold(); if (slice) slice.hold(); if (sweep) sweep.holdStall(); },
        release() { if (family) family.release(); if (slice) slice.release(false); if (sweep) sweep.releaseStall(); }
      });
      return { options: { spendPool: view }, end: view.end };
    }
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
        if (hits.length === 1 && hits[0].group) {
          j.error = '"' + String(hits[0].title || want) + '" is a group chat: a group takes work through its members, not dispatched workers. '
            + 'Bring the agent into that chat (station.control group.add) and hand it the work there (group.handoff). This worker did NOT run.';
          continue;
        }
        if (hits.length === 1) { j.streamId = String(hits[0].id); j.sessionTitle = String(hits[0].title || want); continue; }
        j.error = hits.length > 1
          ? 'more than one session matches "' + want + '" (' + hits.map(h => String(h.title || h.id)).join(', ')
            + ') — name it exactly, or pass the session id. This worker did NOT run.'
          : 'there is no session called "' + want + '" on this station'
            + (nameList.length ? '. Open sessions: ' + nameList.join(', ') : '')
            + '. Create it first, or dispatch without `session` to run in the current one. This worker did NOT run.';
      }
    }

    /* EVERY WORKER GETS ITS OWN THREAD (2026-10-09, Andrew: managing agents and their threads must be the easiest
       thing in the app). A coordinator's worker with no named `session` used to run inside the lead's own stream:
       its turns had nowhere of their own to live and there was nothing to open. Now each one gets a child thread
       filed under the conversation that asked (the rail folds it under that parent). Best-effort: a thread that
       cannot be created leaves the worker running exactly as before — this never blocks or refuses work. */
    // The first line that says something: markdown markers, a label-only header ("## Task") and a leading label
    // ("**Goal:** …") are dropped, so threads are not all titled "## Task". A label needs a colon, a dash or the end
    // of the line, so "Goal setting for Q4" keeps its words.
    const TITLE_LABEL = /^(?:task|subtask|goal|objective|context|background|instructions?|overview|brief|assignment|request|your (?:task|job|goal))\s*(?::|[-–—]|$)\s*/i;
    function threadTitle(prompt, ident) {
      const clean = s => String(s).replace(/^\s*(?:#{1,6}\s+|>+\s*|[-*+•]\s+|\d+[.)]\s+)/, '')
        .replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
      let t = '';
      for (const raw of String(prompt || '').split(/\r?\n/)) {
        const l = clean(raw).replace(TITLE_LABEL, '').replace(/[.:;,\s]+$/, '');
        if (l && !/^you are\b/i.test(l)) { t = l; break; }
      }
      if (t) return t.length > 48 ? t.slice(0, 47).trimEnd() + '…' : t;
      return ((ident && ident.name) || 'Delegated') + ' task';
    }
    function fileUnderThreads(jobs, ctx) {
      if (typeof deps.childThread !== 'function' || !ctx || !ctx.streamId || ctx.streamId === 'global') return;
      // '<leadRunId>:<this call>:<slot>' — unique per dispatch CALL, so a second dispatch in the same lead run (a retry
      // the timeout row asks for, or two calls in one turn) never lands in the first call's threads
      const call = newId();
      jobs.forEach((job, i) => {
        if (job.error || job.streamId) return;
        try {
          const t = deps.childThread({ parentStreamId: ctx.streamId, agentId: job.agentId, title: threadTitle(job.prompt, job.ident), requestId: (ctx.runId || '') + ':' + call + ':' + i, projectRoot: ctx.projectRoot || '' });
          if (t && t.id) { job.streamId = String(t.id); job.sessionTitle = String(t.title || ''); job.parentStreamId = ctx.streamId; }
        } catch (e) {
          // never silent: the worker still runs (in this conversation), and its row tells the lead why it has no thread
          job.threadNote = 'ran in this conversation: its own thread could not be created (' + String((e && e.message) || e) + ')';
          failNote('dispatch.child-thread', e);
        }
      });
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
        agentId: job.agentId, runId: row.runId || '', prompt: job.prompt, text: userTextOf(row), reason: row.reason || '',
        dispatchDelivery: { state: 'final', text: userTextOf(row), reason: row.reason || 'error', repairRunId: row.repairRunId || '' },
        parentStreamId: job.parentStreamId || undefined   // a fresh child thread the page may not have adopted yet
      };
      try { out = await station.request('station.deliver', args); }
      catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
      if (out && out.ok) row.session = job.sessionTitle || job.streamId;
      else {
        const failure = 'The result targets the "' + (job.sessionTitle || job.streamId)
          + '" session, but the station could not show it there: ' + String((out && out.error) || 'no answer') + '.';
        row.sessionNote = row.sessionNote ? row.sessionNote + ' ' + failure
          : failure + ' The completed run is durable and will be reconciled when that session is opened.';
      }
    }

    async function finalizeWorkerDelivery(runId, row) {
      const envelope = { state: 'final', text: userTextOf(row), reason: row.reason || 'error', repairRunId: row.repairRunId || '' };
      // a refused / never-admitted run filed no execution row: there is nothing to make recoverable
      const recorded = typeof deps.runRecord !== 'function' || !!deps.runRecord(runId);
      if (recorded && typeof deps.finalizeDispatchDelivery === 'function') {
        try { await deps.finalizeDispatchDelivery(runId, envelope); }
        catch (e) { failNote('dispatch.finalize-delivery', e); row.sessionNote = 'The result is available now, but its recovery record could not be saved.'; }
      }
      return envelope;
    }

    // Busy state belongs to the TARGET session, not whichever session the Commander is currently viewing.
    // This is intentionally best-effort: a missing page must never delay or cancel paid worker work.
    function noteSessionActivity(verb, job, runId, delivery) {
      if (!station || !job.streamId) return;
      try {
        const pending = station.request(verb, {
          streamId: job.streamId, sessionTitle: job.sessionTitle || job.session || '',
          agentId: job.agentId, runId: runId || '', parentStreamId: job.parentStreamId || undefined,
          ...(delivery ? { reason: delivery.reason, dispatchDelivery: delivery } : {})
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (_) {}
    }

    const dispatchTool = {
      // The registry timeout is now only a BACKSTOP: it sits a minute above the dispatch's own budget so the
      // in-tool wall clock (which returns partial rows) always fires first. Letting the registry's timeout be the
      // primary mechanism is what threw away every completed worker's result (2026-07-26 audit finding A).
      // + the bounded time workers may spend paused on the Commander's approval (pausableSlice credits it back)
      timeoutMs: dispatchBudgetMs + (hasClock ? APPROVAL_HOLD_MAX_MS : 0) + 60000,
      // CONSENT-GATED (2026-07-14, closes the parked P1): delegation fans out REAL autonomous agent loops that
      // spend budget — if untrusted content in the lead's context (a fetched page, a channel message) injects
      // "dispatch a worker to do X", the human must get a say first. Same semantics as team.summon: the APPROVAL
      // beat in 'ask' mode (a session grant stops per-call fatigue), bypassed by Full Access — so a trusting
      // user keeps the frictionless flow by choosing it. Lead-only conferral + budget caps + the concurrency
      // ceiling + autonomous workers (default-deny) all still stand underneath.
      name: 'team.dispatch', capability: 'orchestrator', scope: 'execute', requiresConsent: true,
      /* INTO THIS CHAT IS NOT A DISPATCH (rc walk 10-14, Haiku 4.5 in ASK): "bring two crew in to help me write a launch post"
         and "add them into this chat" both went to team.dispatch — the lead even said "Bringing COPY and STRATEGY into this
         chat" while dispatching. This is the description the model reads when it picks; it now says where a worker works and
         names the one call that seats crew in this chat (station.control group.add, deferred). Tightened elsewhere to pay
         for it (payload.budget: lead-with-crew tool bytes), nothing dropped. */
      description: 'Delegate subtasks to your specialist crew, each worker in its own thread (never in this chat). Each runs its OWN real agent loop (web, files, memory) and returns its result for you to synthesize. To bring crew INTO this chat to work with the Commander, use station.control group.add instead (tool_search "group add"). Address workers by the agentId listed under YOUR TEAM. background:true starts watchable workers while you keep working. SESSIONS: a worker\'s `session` (the session\'s NAME, as the Commander says it) runs and files that subtask in that session; without it, its work is filed on this conversation\'s card. A name not on this station is REFUSED, not guessed, and that worker does not run. FILES: in a conversation scoped to a trusted project, a worker\'s RELATIVE paths (fs_write, image_generate, voice_generate) land in that project folder, where fs_read finds them by the same path; otherwise each worker saves into its OWN private workspace. After the dispatch you may fs_read EXACTLY the files a worker\'s row lists (artifacts[].abs); never guess another path. That list proves what each worker saved; the Commander sees those files as cards. ORDER: workers run one after another, each handed the earlier ones\' results and files; list a worker that needs another\'s output AFTER it; parallel:true only for independent subtasks. COMMANDS: in ASK mode a delegated worker cannot run shell commands (shell_exec / verify_run are withheld unless that worker has Full Access, WORKBENCH or not); run them here yourself, or have the worker return the exact commands. BUILDER: builder:true lends that worker your station.map/plan/build for this job; builds follow your approval setting.',
      schema: {
        type: 'object', required: ['workers'], properties: {
          workers: {
            type: 'array', items: {
              type: 'object', required: ['agentId', 'prompt'],
              properties: {
                agentId: { type: 'string' }, prompt: { type: 'string' },
                resultSchema: { type: 'object', description: 'Strict JSON result contract: the host validates the final result and allows one bounded repair; invalid output is never accepted as done.' },
                context: { type: 'string', description: 'What YOU already established that this worker needs (file paths, findings, constraints, decisions), placed before the prompt as settled knowledge so it is not re-derived. Do not restate the subtask.' },
                // WHERE the work lands. A session NAME (what the Commander calls it) or its exact id. Omit to run
                // in the current session — see resolveSessions for why an unmatched name never falls back to that.
                session: { type: 'string' },
                // THE LENT BUILDER: this worker gets station.map / plan / build for this job (BUILDER_KIT above)
                builder: { type: 'boolean' }
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
        crewNow = crew;
        // wall-clock time this dispatch's workers spent waiting on the Commander's approval (credited back, bounded)
        let heldTotal = 0;
        const creditHeld = (ms) => { heldTotal = Math.min(APPROVAL_HOLD_MAX_MS, heldTotal + (Number(ms) || 0)); };
        // ...and the time its foreground workers spent held by the run's spend pool (poolHoldClock: not their time)
        const family = poolHoldClock(ctx);
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

        // forward lifecycle/cost from children onto the lead's bus, and their tool steps as crew.tool_step (see makeChildEmit; never tokens)
        const childEmit = makeChildEmit(ctx);

        // validate every target up front: a real, live, OTHER worker (never self, never an unknown agentId).
        const jobs = reqs.map(w => {
          const aid = resolveWorkerId(w && w.agentId, crew, leadId);
          const session = String((w && w.session) || '').trim().slice(0, 80);
          if (!ID_RE.test(aid)) return { agentId: aid, error: 'invalid agentId' };
          if (aid === leadId) return { agentId: aid, error: 'cannot delegate to yourself' };
          if (!crew.has(aid)) return { agentId: aid, error: 'no such live worker — summon them first, or check the agentId against YOUR TEAM.' + crewIdsHint(crew, leadId) };
          const contract = resultSchemaOf(w && w.resultSchema);
          if (!contract.ok) return { agentId: aid, error: 'invalid result contract: ' + contract.error };
          // a lend never widens: a lead whose own run cannot build gets this worker refused, not silently sent toolless
          const builder = !!(w && w.builder === true);
          if (builder && !canLendBuilder(ctx)) return { agentId: aid, error: 'builder:true needs the station builder in YOUR run, and it is not granted here: dispatch this worker without builder, or do the floor change yourself' };
          return { agentId: aid, prompt: String((w && w.prompt) || ''), context: handoffContext(w && w.context), ident: crew.get(aid), session: session, resultSchema: contract.schema, builder };
        });
        markBatchQuality(jobs);
        // WHERE before WHO does the work: an unresolvable session marks its job failed here, so that worker is
        // never started in the wrong place (see resolveSessions). One bridge round-trip for the whole dispatch.
        await resolveSessions(jobs);
        fileUnderThreads(jobs, ctx);
        for (const job of jobs) {
          if (job.streamId && ctx && job.streamId === ctx.streamId) job.error = 'Delegate into a separate working session, not the lead conversation.';
          if (!job.error && job.streamId && typeof deps.sessionContext === 'function') {
            try { job.sessionContext = deps.sessionContext(job.streamId); }
            catch (e) { job.error = 'session context unavailable: ' + e.message; }
          }
        }

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
          const bounded = boundedDomainTask(job.prompt, fileProbeFor(job.agentId, projectOptions(job.sessionContext || ctx).projectRoot));
          // minted up front (not inline in the runOnce call) so the row can carry the SAME id the run was filed
          // under — the page's delivery uses it to append the run to the session and to stay idempotent.
          const workerRunId = o2.runId || newId();
          const finish = async (row, deliver) => {
            row.runId = workerRunId;
            const envelope = await finalizeWorkerDelivery(workerRunId, row);
            // The execution loop ending is not completion: validation and any bounded repair finish first.
            noteSessionActivity('station.dispatch_end', job, workerRunId, envelope);
            if (deliver) {
              if (job.parentStreamId) {
                row.session = job.sessionTitle || job.streamId;
                const copy = Object.assign({}, row);
                if (shownText.has(row)) shownText.set(copy, shownText.get(row));
                const p = deliverToSession(job, copy);
                if (p && typeof p.catch === 'function') p.catch(e => failNote('dispatch.thread-delivery', e));
              } else await deliverToSession(job, row);
            }
            if (job.threadNote) row.sessionNote = job.threadNote;
            return row;
          };
          const allottedWallMs = (typeof o2.wallMs === 'number' && isFinite(o2.wallMs) && o2.wallMs > 0) ? o2.wallMs : 0;
          // A one-host inspection is never a ten-minute autonomous research job. Even if a lead explicitly
          // delegates one (non-interactive callers can still do so), bind all three dimensions: turns, tools,
          // and wall clock. The worker still gets a final synthesis turn after its direct fetch.
          const wallMs = bounded
            ? Math.min(allottedWallMs || bounded.workerMaxMs, bounded.workerMaxMs)
            : allottedWallMs;
          const child = wallMs ? childAbort(parentSignal) : null;
          const ac = child && child.ac;
          let timedOut = false, timer = null, slice = null;
          if (ac) {
            const expire = () => { timedOut = true; abort(ac); };
            // the slice pauses while this worker waits on the Commander (see pausableSlice) — host clock required
            if (hasClock) slice = pausableSlice(wallMs, expire, now, creditHeld);
            else timer = setTimeout(expire, wallMs);
          }
          const timeoutRow = (res) => {
            const partial = res ? (lastAssistant(res.messages) || '') : '';
            const row = {
              agentId: job.agentId, reason: 'timeout',
              result: (partial ? partial + '\n\n' : '')
                + '[STOPPED — this worker used up its ' + Math.round(wallMs / 1000) + 's slice of the dispatch wall clock'
                + (partial ? '; the text above is its PARTIAL work' : ' before returning any text')
                + '. Do not present it as complete: either re-dispatch this subtask alone, or tell the Commander this part is unfinished.]',
              usd: (res && res.usd) || 0,
              taintedBy: taintOfRun(res) || undefined
            };
            // what it DID save before the clock ran out still counts (and still hands on)
            if (res && Array.isArray(res.artifacts) && res.artifacts.length) row.artifacts = res.artifacts.map(a => Object.assign({}, a, { agentId: job.agentId, workspace: job.agentId }));
            // the bracketed note is for the LEAD; the Commander sees the partial work only (the card already says it ran out of time)
            shownText.set(row, partial);
            return row;
          };
          let result;
          const handoff = o2.handoff || null;
          const contractedPrompt = openingMessage(job.prompt, job.context, job.resultSchema, handoff && handoff.text);
          const previousMessages = job.sessionContext && job.sessionContext.messages || [];
          noteSessionActivity('station.dispatch_start', job, workerRunId);
          // its slice and the dispatch's clocks pause while the run's spend pool holds its call (poolHoldClock); a background
          // worker's stall clock does too (o2.stall: its subagent handle), while the call's own clocks never watch it
          const watched = watchedPool(ctx, o2.background === true ? null : family, slice, o2.stall);
          try {
            const conn = connectorOptions(ctx);
            result = await runOnce({
              ...projectOptions(job.sessionContext || ctx), ...conn, ...watched.options,
              // THE HAND-OFF: what the earlier workers read, this one inherits; the files they saved, it may read
              ...(handoff && handoff.taint ? { initialTaint: conn.initialTaint || handoff.taint } : {}),
              ...(handoff && handoff.reads && handoff.reads.length ? { handoffReads: handoff.reads.slice() } : {}),
              key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
              // Class Loadouts S1: the WORKER runs at its OWN class-applied reasoning effort (roster record), not the
              // lead's — a dispatched specialist honors its loadout. Falls back to the lead's effort when unset.
              reasoningEffort: (job.ident && job.ident.reasoningEffort) || reasoningEffort,
              model: wire.model,
              system: workerSystem((job.ident && job.ident.system) || ''),
              messages: previousMessages.concat([{ role: 'user', content: contractedPrompt }]),
              agentId: job.agentId, isTask: true,
              emit: o2.emit || childEmit,      // lifecycle/cost ride the lead/global stream -> the floor lights the worker
              signal: ac ? ac.signal : parentSignal,   // own controller when this worker has a wall clock (see above)
              runId: workerRunId, trigger: 'directive', surface: 'autonomous',
              parentRunId: ctx && ctx.runId, delegatedBy: (ctx && ctx.agentId) || '',
              // SESSION TARGETING: the run host files a run under its streamId (runStore.record + the durable
              // transcript) and scopes its working memory to that stream. Absent -> undefined, byte-identical to
              // the pre-2026-07-30 call. This is the DURABLE half; deliverToSession is the visible one.
              streamId: job.streamId || undefined,
              coordinatedSession: deps.coordinateResults === true,
              dispatchDelivery: { state: 'pending' },
              sessionTitle: job.streamId ? (job.sessionTitle || job.session || '') : undefined,
              sessionPrompt: job.streamId ? job.prompt : undefined,
              // Share the lead's consent broker so a worker's WRITES follow the lead's APPROVAL posture
              // (full-auto bypass, or a prompt forwarded to the watched lead) instead of the headless default-deny.
              // NOT "same access as the orchestrator" — a worker runs surface:'autonomous' (below), and
              // enforceRunAuthority strips WORKSPACE_PROCESS tools on any non-interactive surface *before* consent is
              // ever consulted. So of the WORKBENCH grant a worker receives, shell.exec and verify.run never reach the
              // model at all; only its background-shell and browser-test tools survive. Widening that is a deliberate
              // permissions-surface decision, not something to fix by editing this comment.
              // ...and the worker's slice pauses while one of those prompts waits on the Commander (pausableSlice)
              consent: holdDuringConsent(ctx && ctx.consent, slice),
              // a BACKGROUND worker outlives its lead's turn, so its asks must too (index.js askHuman): they wait on the
              // Commander past the lead's end instead of being denied by it, and still fail closed on the consent timeout
              detachedConsent: o2.background === true,
              extraObjects: kitFor(job.builder),   // + the LENT BUILDER when the lead dispatched it with builder:true
              maxCostUsd: perWorker,           // a runaway worker can't blow the lead's per-run ceiling
              maxIters: bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters,
              maxToolCalls: bounded ? bounded.workerMaxTools : undefined,
              steer: typeof o2.steer === 'function' ? o2.steer : undefined
            });
          } catch (e) {
            if (timedOut) return finish(timeoutRow(null));   // the abort we fired surfaced as a throw — still an honest timeout
            return finish({ agentId: job.agentId, reason: 'error', result: 'worker run failed: ' + ((e && e.message) || e), usd: 0 });
          } finally {
            watched.end();
            if (timer) clearTimeout(timer);
            if (slice) slice.clear();
            if (child) child.detach();
          }
          if (timedOut) return finish(timeoutRow(result));   // keep whatever partial text the aborted run did produce
          if (!result) return finish({ agentId: job.agentId, reason: 'refused', result: 'worker could not start — the station\'s concurrent-agent cap was full at that instant, or a provider sign-in is needed. A parallel dispatch already runs in waves sized to the free capacity and retries a refusal once, so a refusal that survives means the cap is genuinely saturated: raise MAX_CONCURRENT_AGENTS in SETTINGS, or dispatch these workers in a follow-up call.', usd: 0 });
          const firstText = lastAssistant(result.messages) || '(the worker returned no text)';
          const contract = await enforceStructured(job.resultSchema, firstText, async (errors) => {
            const spent = Number(result.usd) || 0;
            const remaining = perWorker > 0 ? Math.max(0, perWorker - spent) : 0;
            if (perWorker > 0 && remaining <= 0) return null;
            const repairRunId = newId();
            const repairPool = watchedPool(ctx, o2.background === true ? null : family, null, o2.stall);
            let repair;
            try {
              repair = await runOnce({
                outputOnly: true,
                ...projectOptions(job.sessionContext || ctx), ...connectorOptions(ctx), ...repairPool.options,
                key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
                reasoningEffort: (job.ident && job.ident.reasoningEffort) || reasoningEffort,
                model: wire.model, system: workerSystem((job.ident && job.ident.system) || ''),
                messages: [{ role: 'user', content: contractedPrompt }, { role: 'assistant', content: firstText },
                  { role: 'user', content: '[STRUCTURED RESULT REPAIR] The prior result failed host validation:\n- ' + errors.slice(0, 20).join('\n- ') + '\nReturn ONLY strict JSON matching: ' + JSON.stringify(job.resultSchema) }],
                agentId: job.agentId, isTask: true, emit: o2.emit || childEmit,
                signal: ac ? ac.signal : parentSignal, runId: repairRunId, trigger: 'directive', surface: 'autonomous',
                parentRunId: ctx && ctx.runId, delegatedBy: (ctx && ctx.agentId) || '', streamId: job.streamId || undefined,
                sessionTitle: job.streamId ? (job.sessionTitle || job.session || '') : undefined,
                dispatchDelivery: { state: 'internal' },
                consent: ctx && ctx.consent, extraObjects: WORKER_KIT,
                maxCostUsd: perWorker > 0 ? remaining : 0,
                maxIters: lowerPositive(4, bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters),
                maxToolCalls: bounded ? bounded.workerMaxTools : undefined,
                steer: typeof o2.steer === 'function' ? o2.steer : undefined
              });
            } finally { repairPool.end(); }
            return repair ? { text: lastAssistant(repair.messages), result: repair, runId: repairRunId } : null;
          });
          const repaired = contract.repairResult || null;
          const totalUsd = (Number(result.usd) || 0) + (Number(repaired && repaired.usd) || 0);
          const artifacts = [].concat(Array.isArray(result.artifacts) ? result.artifacts : [], Array.isArray(repaired && repaired.artifacts) ? repaired.artifacts : []);
          if (job.resultSchema && !contract.ok) return finish({
            agentId: job.agentId, reason: 'invalid-result',
            result: 'Worker output failed its result schema after one bounded repair attempt. No completion was accepted.',
            usd: totalUsd, runId: workerRunId, repairRunId: contract.repairRunId || '', validation: contract.validation,
            artifacts: artifacts.map(a => Object.assign({}, a, { agentId: job.agentId, workspace: job.agentId }))
          });
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
          const rowTaint = taintOfRun(result, repaired);
          if (rowTaint) row.taintedBy = rowTaint;
          if (wire.note) row.note = wire.note;   // honest credential-fallback disclosure (never silent)
          // WORK VISIBILITY (ghost-file fix): what the worker PROVABLY produced (its runOnce artifact ledger),
          // stamped with the OWNING agentId. Files live in the WORKER's private workspace — the lead cannot
          // fs.read them and must reference them as the worker's (they are already shown to the Commander as
          // cards via the forwarded deliverable events). Never invent paths beyond this list.
          if (artifacts.length) {
            row.artifacts = artifacts.map(a => Object.assign({}, a, { agentId: job.agentId, workspace: job.agentId }));
            // the REAL location of each saved file (host-resolved, existing files only), and the lead may now read
            // exactly those — it used to guess "/tmp/<worker>/…" paths and ask the Commander to approve them
            const files = await resolveHandoffFiles(job.agentId, row.artifacts);
            for (const f of files) {
              const a = row.artifacts.find(x => x && x.path === f.path);
              if (a) a.abs = f.abs;
            }
            if (files.length && typeof deps.grantReads === 'function') {
              try { deps.grantReads(files.map(f => f.abs)); } catch (e) { failNote('dispatch.grant-reads', e); }
            }
          }
          return finish(row, true);
        };

        if (args.background) {
          if (!subagents || typeof subagents.start !== 'function') return { content: 'background subagents unavailable (no subagent manager)', summary: 'error' };
          const started = jobs.map(job => {
            if (job.error) return { agentId: job.agentId, reason: 'error', result: job.error };
            // parentRunId: a CANCELLED lead run cancels this worker too (subagents.cancelChildren); a lead that ends
            // normally leaves it running — outliving the call is what background:true is for.
            return subagents.start({ ...projectOptions(job.sessionContext || ctx), leadId, parentRunId: (ctx && ctx.runId) || '', parentStreamId: deps.coordinateResults === true && ctx && ctx.streamId !== 'global' ? ctx.streamId : '', streamId: job.streamId || '', agentId: job.agentId, prompt: job.prompt, context: job.context, runId: newId(), resultSchema: job.resultSchema, builder: job.builder === true, originLimits: originLimitsOf(ctx) }, async (h) => {
              const r = await runWorker(job, { runId: h.runId, signal: h.signal, emit: h.emit, steer: h.steer, background: true, stall: h });
              return { status: r.reason === 'done' ? 'done' : 'error', reason: r.reason, result: r.result, usd: r.usd || 0,
                structuredResult: r.structuredResult, validation: r.validation, repairRunId: r.repairRunId, artifacts: r.artifacts,
                taintedBy: r.taintedBy || '' };
            });
          });
          const startedRows = started.map(startedHandle).concat(overflowRows());
          // revealTools: a crewless lead holds the background controls DEFERRED (index.js ZERO-CREW DIET) — the workers it just
          // started must be one call away from being watched/steered/stopped. A no-op wherever they are already advertised.
          return { content: JSON.stringify(startedRows), summary: 'started ' + started.filter(r => r && r.id).length + ' background worker(s)' + overflowNote,
            control: { revealTools: BACKGROUND_CONTROLS.slice() } };
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
          ? dispatchBudgetMs - (now() - startedAt - heldTotal - family.heldMs())   // waiting on the Commander or the spend pool is not the workers' time
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
          // SEQUENTIAL: each later worker is handed what the earlier ones returned and saved (earlierHandoff)
          const handoff = (!args.parallel && out.length) ? await earlierHandoff(out) : null;
          const done = await Promise.all(waves[w].map(j => runWorker(j, { wallMs: share, handoff })));
          for (const r of done) out.push(r);
        }
        /* ONE RETRY PASS for a refusal. A 'refused' row means the admission gate was full at that instant — a
           sibling wave, another agent's run, or a cron beat holding the last slot. Waves make that rare instead of
           systematic, but a race can still lose one, and a refused worker did NO work and cost NOTHING, so
           retrying it is free. `out` is built in job order, so out[i] pairs with jobs[i] (overflow is appended after). */
        for (let i = 0; i < out.length && i < jobs.length; i++) {
          if (out[i].reason !== 'refused') continue;
          const left = hasClock ? dispatchBudgetMs - (now() - startedAt - heldTotal - family.heldMs()) : Math.floor(dispatchBudgetMs / jobs.length);
          if (left <= 0) break;
          const retryHandoff = (!args.parallel && i > 0) ? await earlierHandoff(out.slice(0, i)) : null;
          const retried = await runWorker(jobs[i], { wallMs: left, handoff: retryHandoff });
          out[i] = (retried.reason === 'refused') ? Object.assign(retried, { retried: true }) : retried;
        }
        out = out.concat(overflowRows());

        const ok = out.filter(r => r.reason === 'done').length;
        const late = out.filter(r => r.reason === 'timeout').length;
        const unrun = out.filter(r => r.reason === 'not-dispatched').length - overflow.length;
        // every worker's row survives the result cap: fair-share its text, spill the whole text per worker
        const fit = await fitAggregate(out, { budget: aggregateBudget(ctx), what: r => 'worker ' + r.agentId + '\'s result', park: workerParker(ctx, 'team.dispatch') });
        return withTaint({
          content: JSON.stringify(fit.rows),
          summary: 'dispatched ' + jobs.length + ' worker(s), ' + ok + ' done'
            + (late ? ', ' + late + ' out of time' : '')
            + (unrun > 0 ? ', ' + unrun + ' never started (wall clock)' : '')
            + overflowNote + fitNote(fit)
        }, taintOfRows(out));
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
      // The run's spend pool can make the clones' calls take turns near the PER RUN cap: that wait does not count, the
      // timeout pauses while any foreground clone's call is held (poolHoldClock, tools/registry.js PAUSABLE DEADLINE).
      timeoutMs: dispatchBudgetMs,
      // CONSENT-GATED like team.dispatch (see its note): spawning clones fans out autonomous budget-spending
      // loops off text in the lead's context — 'ask' mode gets the APPROVAL beat, Full Access bypasses.
      name: 'team.spawn', capability: 'orchestrator', scope: 'execute', requiresConsent: true,
      description: 'Spawn EPHEMERAL sub-agents (clones of yourself) to work subtasks in parallel. Each runs its OWN agent loop on the one subtask you give it, returns its result, then vanishes (it is NOT added to your roster and cannot spawn sub-agents). Use it to decompose a task or fan out parallel work without summoning named crew first. Each task takes a prompt (the focused subtask) and an optional label. background:true spawns watchable workers while you keep working.',
      schema: {
        type: 'object', required: ['tasks'], properties: {
          tasks: {
            type: 'array', items: {
              type: 'object', required: ['prompt'],
              properties: {
                prompt: { type: 'string' }, label: { type: 'string' },
                resultSchema: { type: 'object', description: 'Strict JSON result contract: invalid output gets one bounded repair and is never accepted as done.' },
                context: { type: 'string', description: 'What YOU already established that this clone needs (file paths, findings, constraints, decisions), placed before the prompt as settled knowledge. Do not restate the subtask.' }
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

        // forward lifecycle/cost onto the lead's bus so the floor materializes/pops the Meeseeks live (tool steps only as
        // crew.tool_step — see makeChildEmit); the durable record (via h.emit) keeps the full watch tail for team.subagents.
        const childEmit = makeChildEmit(ctx);
        // this call's timeout pauses while the run's spend pool holds a foreground clone's call (poolHoldClock), and every
        // clone's stall clock (its handle h) stops while its own call is held
        const family = args.background ? null : poolHoldClock(ctx);
        const clonePool = (h) => watchedPool(ctx, family, null, h);

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
            const bounded = boundedDomainTask(prompt, fileProbeFor(ephemeralId, projectOptions(ctx).projectRoot));
            const contractedPrompt = openingMessage(prompt, task.context, task.resultSchema);
            const watched = clonePool(h);
            try {
              result = await runOnce({
              ...projectOptions(ctx), ...connectorOptions(ctx), ...watched.options,
                key, provider, baseUrl, reasoningEffort, model,      // the lead's OWN model - a clone of self
                system: workerSystem(selfSystem),           // the lead's OWN identity plus settled task context
                                                            // composes its own caps for its (narrowed) toolset
                messages: [{ role: 'user', content: contractedPrompt }],
                agentId: ephemeralId, isTask: true,
                emit: (n, p) => { try { h.emit(n, p); } catch (_) {} childEmit(n, p); },   // durable record + lead stream
                signal: h.signal, runId: h.runId,
                parentRunId: ctx && ctx.runId, delegatedBy: (ctx && ctx.agentId) || '',
                trigger: 'directive', surface: 'autonomous',
                consent: ctx && ctx.consent,                // same approval posture as the orchestrator
                detachedConsent: args.background === true,  // a background clone's asks outlive the lead's turn (index.js askHuman)
                extraObjects: WORKER_KIT,                   // WORKBENCH only — NO 'lead' → no orchestrator object →
                                                            // team.spawn never exposed to it → FLAT DEPTH (no re-spawn)
                maxCostUsd: perWorker,                       // a runaway clone can't blow the lead's per-run ceiling
                maxIters: bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters,
                maxToolCalls: bounded ? bounded.workerMaxTools : undefined,
                steer: h.steer
              });
            } catch (e) {
              const stopped = hostStopCode(h.signal);
              const r = stopped ? Object.assign({ label, agentId: ephemeralId, usd: 0 }, hostStopRow(stopped, ''))
                : { label, agentId: ephemeralId, reason: 'error', result: 'subagent run failed: ' + ((e && e.message) || e), usd: 0 };
              settle(r); return { status: 'error', reason: r.reason, result: r.result, usd: 0 };
            } finally { watched.end(); }
            // Stopped by the HOST (its parent run was cancelled, or the liveness check found it hung): say which,
            // with whatever partial text it produced — never a clean-looking 'cancelled'/'done' row.
            const hostStopped = hostStopCode(h.signal);
            if (hostStopped) {
              const r = Object.assign({ label, agentId: ephemeralId, usd: (result && result.usd) || 0 }, hostStopRow(hostStopped, result ? lastAssistant(result.messages) : ''));
              if (taintOfRun(result)) r.taintedBy = taintOfRun(result);
              settle(r); return { status: 'error', reason: r.reason, result: r.result, usd: r.usd, taintedBy: r.taintedBy || '' };
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
              const repairPool = clonePool(h);
              let repair;
              try {
                repair = await runOnce({
                  outputOnly: true,
                  ...projectOptions(ctx), ...connectorOptions(ctx), ...repairPool.options,
                  key, provider, baseUrl, reasoningEffort, model, system: workerSystem(selfSystem),
                  messages: [{ role: 'user', content: contractedPrompt }, { role: 'assistant', content: firstText },
                    { role: 'user', content: '[STRUCTURED RESULT REPAIR] The prior result failed host validation:\n- ' + errors.slice(0, 20).join('\n- ') + '\nReturn ONLY strict JSON matching: ' + JSON.stringify(task.resultSchema) }],
                  agentId: ephemeralId, isTask: true,
                  emit: (n, p) => { try { h.emit(n, p); } catch (_) {} childEmit(n, p); },
                  signal: h.signal, runId: repairRunId, parentRunId: ctx && ctx.runId, delegatedBy: (ctx && ctx.agentId) || '',
                  trigger: 'directive', surface: 'autonomous', consent: ctx && ctx.consent,
                  extraObjects: WORKER_KIT, maxCostUsd: perWorker > 0 ? remaining : 0,
                  maxIters: lowerPositive(4, bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters),
                  maxToolCalls: bounded ? bounded.workerMaxTools : undefined, steer: h.steer
                });
              } finally { repairPool.end(); }
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
            if (taintOfRun(result, repaired)) r.taintedBy = taintOfRun(result, repaired);
            settle(r);
            return { status: r.reason === 'done' ? 'done' : 'error', reason: r.reason, result: r.result, usd: r.usd,
              structuredResult: r.structuredResult, validation: r.validation, repairRunId: r.repairRunId, artifacts: r.artifacts,
              taintedBy: r.taintedBy || '' };
          };
          // a FOREGROUND clone's result already went back to the lead inside its run: only a background one is the overseer's
          // to report on (parentStreamId set), or the Commander would get that result a second time
          const view = subagents.start({ ...projectOptions(ctx), leadId, parentRunId: (ctx && ctx.runId) || '', parentStreamId: args.background && deps.coordinateResults === true && ctx && ctx.streamId !== 'global' ? ctx.streamId : '', agentId: ephemeralId, prompt: prompt, context: task.context, runId: newId(), resultSchema: task.resultSchema, originLimits: originLimitsOf(ctx) }, runner);
          return { label, view, done, started: true };
        };

        const spawned = reqs.map(spawnOne);
        if (args.background) {
          const rows = spawned.map(s => Object.assign({ label: s.label }, startedHandle(s.view))).concat(overflowRows());
          // revealTools: see team.dispatch background — a crewless lead's spawned background workers get their controls
          return { content: JSON.stringify(rows), summary: 'spawned ' + spawned.filter(s => s.started).length + ' subagent(s)' + overflowNote,
            control: { revealTools: BACKGROUND_CONTROLS.slice() } };
        }
        const results = (await Promise.all(spawned.map(s => s.done))).concat(overflowRows());
        const ok = results.filter(r => r.reason === 'done').length;
        const fit = await fitAggregate(results, { budget: aggregateBudget(ctx), what: r => 'subagent ' + (r.label || r.agentId) + '\'s result', park: workerParker(ctx, 'team.spawn') });
        return withTaint({ content: JSON.stringify(fit.rows), summary: 'spawned ' + spawned.filter(s => s.started).length + ' subagent(s), ' + ok + ' done' + overflowNote + fitNote(fit) }, taintOfRows(results));
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
      briefExempt: true,   // hiring is station setup, not the deliverable: never held behind the Task Brief (taskbrief-policy canMutate)
      description: 'Summon a NEW specialist agent onto the crew for the Commander, live, as the Recruitment Bay does. Use it when the specialist you need does not exist yet; one already under YOUR TEAM takes work through team.dispatch. Pick a class with specId (one of: ' + SPEC_IDS + ') or describe a custom one with name + purpose. The station places the new agent\'s workstation with it, so never tell the Commander to go build it a desk. Returns the new agentId: bring it INTO this chat with station.control group.add, or hand it work with team.dispatch. In APPROVAL mode the Commander confirms the summon first.',
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
        // said to the Commander in the second person: the model echoes a result's wording ("The Commander declined …", rc walk 10-14)
        if (!newId) return { content: 'No agent was created: the summon was declined on its card, or the station did not respond. If you mention it, say it to the Commander as "you".', summary: 'declined' };
        // DESK: a summoned specialist needs a workstation to sit and work at, so the station sorts its desk as
        // part of THIS summon. Reported only when the station named a room — never assumed, so the reply can't
        // promise furniture the floor doesn't have (and can't tell the Commander to go build a second one).
        // Worded "workstation is in X", not "placed": the station may have bound a free desk it already had.
        const out = { agentId: newId, name: spec.name || spec.specId };
        if (desk) out.workstation = desk;
        /* NEXT: the two things a new hire is for, by the Commander's words (rc walk 10-14: "bring two crew in to help me write
           a launch post" summoned two, then background-dispatched them — the chat never got them). In this chat with the
           Commander = station.control group.add; a job in its own thread = team.dispatch. */
        out.next = 'to work IN this chat with the Commander: station.control {"action": "group.add", "args": {"agents": [' + JSON.stringify(out.name) + ']}}; a job in its own thread: team.dispatch';
        // revealTools: a crewless lead holds team.dispatch DEFERRED (index.js ZERO-CREW DIET) and every lead holds station.control
        // deferred — the agent it just summoned must be one call away for either, not one search away. A no-op wherever a
        // name is already advertised or not granted (loop.js reveal).
        return { content: JSON.stringify(out), summary: 'summoned ' + newId + (desk ? ' (workstation in ' + desk + ')' : '') + ' — bring it into this chat (station.control group.add) or delegate work to it with team.dispatch',
          control: { revealTools: ['team.dispatch', 'station.control'] } };
      }
    };

    /* VERIFY A DELEGATED RUN (#57). The answer comes from the durable run history the Dossier RECORD reads, never from
       the dispatch's own account of itself. Scoped to THIS lead: the run must have been dispatched by this lead's
       current run, or by an earlier run recorded under this lead's agentId. A dispatch still in flight is recorded
       when its worker ends, so "not found" says that instead of implying the work never happened. */
    function verifyDelegatedRun(runId, leadId, ctx) {
      if (!runRecord) return { content: 'The station\'s run history is not reachable from this run, so run ' + runId + ' cannot be checked here.', summary: 'unavailable' };
      const read = (id) => { try { return runRecord(id) || null; } catch (_) { return null; } };
      const row = read(runId);
      const parentId = row && String(row.parentRunId || '');
      // delegatedBy is stamped on worker rows; rows written before it existed fall back to the parent run's owner.
      const byThisLead = row && row.delegatedBy ? row.delegatedBy === leadId
        : !!parentId && ((ctx && parentId === ctx.runId) || ((read(parentId) || {}).agentId === leadId));
      if (!row || !byThisLead) return {
        content: 'No run ' + runId + ' that you delegated is in this station\'s run history. A worker is recorded when its run ends,'
          + ' so a background worker still running is not here yet (check it with team.subagents by id).',
        summary: 'not found'
      };
      const pick = ['runId', 'agentId', 'delegatedBy', 'parentRunId', 'reason', 'model', 'usd', 'tokens', 'turns', 'toolsOk', 'durationMs', 'startedAt', 'endedAt', 'streamId', 'sessionTitle'];
      const out = { recorded: true };
      for (const k of pick) if (row[k] !== undefined && row[k] !== '') out[k] = row[k];
      if (row.dispatchDelivery) out.dispatchDelivery = { state: row.dispatchDelivery.state, reason: row.dispatchDelivery.reason, repairRunId: row.dispatchDelivery.repairRunId };
      const outcome = row.dispatchDelivery
        ? (row.dispatchDelivery.state === 'final' ? row.dispatchDelivery.reason : 'delivery ' + row.dispatchDelivery.state)
        : (row.reason || 'done');
      return { content: JSON.stringify(out), summary: 'recorded: ' + (row.agentId || 'worker') + ' ' + outcome };
    }

    const subagentsTool = {
      name: 'team.subagents', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'List or inspect your BACKGROUND subagents (team.dispatch with background:true, and team.spawn). Pass id for one worker, or omit id to list recent workers for this lead. Returned records include the current generation, status, event tail, result, steering history, and whether they can be interrupted or resumed. Use the returned id + generation for team.steer. A normal (foreground) team.dispatch is NEVER in this list; to confirm one really ran, pass runId (from its dispatch result) and the station\'s run history answers.',
      schema: { type: 'object', properties: { id: { type: 'string' }, agentId: { type: 'string' }, status: { type: 'string' }, runId: { type: 'string', description: 'A worker runId from a team.dispatch result: look it up in the station\'s durable run history.' } } },
      run: async (args, ctx) => {
        const leadId = (ctx && ctx.agentId) || 'agent';
        if (args && args.runId) return verifyDelegatedRun(String(args.runId), leadId, ctx);
        if (!subagents) return { content: 'background subagents unavailable', summary: 'unavailable' };
        if (args && args.id) {
          const r = subagents.get(String(args.id));
          if (!r || r.leadId !== leadId) return { content: 'No such background subagent for this lead.', summary: 'not found' };
          return withTaint({ content: JSON.stringify(r), summary: r.status }, taintOfRows([r]));
        }
        const rows = subagents.list({ leadId, agentId: args && args.agentId, status: args && args.status });
        // An empty list is NOT evidence that nothing ran: say what this list can and cannot see (#57).
        if (!rows.length) return {
          content: 'No background subagents' + (args && args.agentId ? ' for ' + String(args.agentId) : '') + (args && args.status ? ' with status ' + String(args.status) : '')
            + ' for this lead. This list only tracks BACKGROUND workers (team.dispatch background:true, team.spawn). A normal team.dispatch'
            + ' returns its result directly and never appears here, so an empty list does not mean a dispatch failed. To confirm a dispatched'
            + ' worker really ran, call team.subagents with runId set to the runId from that dispatch result.',
          summary: '0 background subagent(s)'
        };
        const fit = await fitAggregate(rows, { budget: aggregateBudget(ctx), what: r => (r.agentId || 'subagent') + ' (' + (r.id || '') + ')\'s result', park: workerParker(ctx, 'team.subagents') });
        return withTaint({ content: JSON.stringify(fit.rows), summary: rows.length + ' background subagent(s)' + fitNote(fit) }, taintOfRows(rows));
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
        const resumedSession = rec.streamId && typeof deps.sessionContext === 'function' ? deps.sessionContext(rec.streamId) : null;
        const crew = roster() || new Map();
        const ident = crew.get(rec.agentId);
        if (!ident) return { status: 'error', reason: 'error', result: 'worker is no longer in the live roster', usd: 0 };
        const finish = async row => { await finalizeWorkerDelivery(h.runId, row); return row; };
        const wire = workerWire(ident);   // same cross-provider resolution as a fresh dispatch
        let result;
        const bounded = boundedDomainTask(rec.prompt || '', fileProbeFor(rec.agentId, projectOptions(ctx, rec).projectRoot));
        // The durable record carries the lead's handoff `context`, so a resumed worker rebuilds the SAME
        // opening message a fresh dispatch would have — a restart never silently drops the handoff.
        const contractedPrompt = openingMessage(rec.prompt || '', handoffContext(rec.context), rec.resultSchema);
        // its stall clock stops while the run's spend pool holds its call (watchedPool: the liveness sweep covers it too)
        const watched = watchedPool(ctx, null, null, h);
        try {
          result = await runOnce({
            ...projectOptions(ctx, rec), ...resumeConnectorOptions(ctx, rec), ...watched.options,
            key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
            reasoningEffort: (ident && ident.reasoningEffort) || reasoningEffort,   // Class Loadouts S1: worker's own class effort (see runWorker)
            model: wire.model,
            system: workerSystem((ident && ident.system) || ''),
            messages: ((resumedSession && resumedSession.messages) || []).concat([{ role: 'user', content: contractedPrompt }]),
            streamId: rec.streamId || undefined, sessionTitle: resumedSession && resumedSession.title,
            coordinatedSession: !!rec.parentStreamId,
            dispatchDelivery: { state: 'pending' },
            sessionPrompt: rec.streamId ? rec.prompt : undefined,
            agentId: rec.agentId, isTask: true,
            emit: h.emit, signal: h.signal, runId: h.runId,
            parentRunId: ctx && ctx.runId, delegatedBy: (ctx && ctx.agentId) || '',
            trigger: 'directive', surface: 'autonomous',
            consent: ctx && ctx.consent,
            // a resumed worker runs on in the background past the resuming lead's turn (subagents.resume returns at once),
            // so its asks outlive that turn too (index.js askHuman) — the same as a fresh background dispatch
            detachedConsent: true,
            // a worker the lead LENT the builder keeps it on resume, while the resuming lead can still build
            extraObjects: kitFor(rec.builder === true && canLendBuilder(ctx)),
            maxCostUsd: perWorker,
            maxIters: bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters,
            maxToolCalls: bounded ? bounded.workerMaxTools : undefined,
            steer: h.steer
          });
        } catch (e) {
          return finish({ status: 'error', reason: 'error', result: 'worker run failed: ' + ((e && e.message) || e), usd: 0 });
        } finally { watched.end(); }
        if (!result) return finish({ status: 'error', reason: 'refused', result: 'worker could not restart', usd: 0 });
        const firstText = lastAssistant(result.messages) || '(the worker returned no text)';
        const contract = await enforceStructured(rec.resultSchema, firstText, async (errors) => {
          const spent = Number(result.usd) || 0;
          const remaining = perWorker > 0 ? Math.max(0, perWorker - spent) : 0;
          if (perWorker > 0 && remaining <= 0) return null;
          const repairRunId = newId();
          const repairPool = watchedPool(ctx, null, null, h);
          let repair;
          try {
            repair = await runOnce({
              outputOnly: true,
            ...projectOptions(ctx, rec), ...resumeConnectorOptions(ctx, rec), ...repairPool.options,
            key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
            reasoningEffort: (ident && ident.reasoningEffort) || reasoningEffort,
            model: wire.model, system: workerSystem((ident && ident.system) || ''),
            messages: [{ role: 'user', content: contractedPrompt }, { role: 'assistant', content: firstText },
              { role: 'user', content: '[STRUCTURED RESULT REPAIR] The prior result failed host validation:\n- ' + errors.slice(0, 20).join('\n- ') + '\nReturn ONLY strict JSON matching: ' + JSON.stringify(rec.resultSchema) }],
            agentId: rec.agentId, isTask: true, emit: h.emit, signal: h.signal, runId: repairRunId,
            streamId: rec.streamId || undefined, sessionTitle: resumedSession && resumedSession.title,
            dispatchDelivery: { state: 'internal' },
            parentRunId: ctx && ctx.runId, delegatedBy: (ctx && ctx.agentId) || '', trigger: 'directive', surface: 'autonomous',
            consent: ctx && ctx.consent, extraObjects: WORKER_KIT,
            maxCostUsd: perWorker > 0 ? remaining : 0,
            maxIters: lowerPositive(4, bounded ? lowerPositive(workerMaxIters, bounded.workerMaxIters) : workerMaxIters),
            maxToolCalls: bounded ? bounded.workerMaxTools : undefined, steer: h.steer
            });
          } finally { repairPool.end(); }
          return repair ? { text: lastAssistant(repair.messages), result: repair, runId: repairRunId } : null;
        });
        const repaired = contract.repairResult || null;
        const artifacts = [].concat(Array.isArray(result.artifacts) ? result.artifacts : [], Array.isArray(repaired && repaired.artifacts) ? repaired.artifacts : []);
        const invalid = !!(rec.resultSchema && !contract.ok);
        return finish({
          status: invalid ? 'error' : (((repaired || result).reason || 'done') === 'done' ? 'done' : 'error'),
          reason: invalid ? 'invalid-result' : ((repaired || result).reason || 'done'),
          result: invalid ? 'Worker output failed its result schema after one bounded repair attempt. No completion was accepted.' : contract.text,
          structuredResult: rec.resultSchema && contract.ok ? contract.value : null,
          validation: contract.validation, repairRunId: contract.repairRunId || '',
          usd: (Number(result.usd) || 0) + (Number(repaired && repaired.usd) || 0),
          artifacts: artifacts.map(a => Object.assign({}, a, { agentId: rec.agentId, workspace: rec.agentId })),
          taintedBy: taintOfRun(result, repaired)
        });
      };
    }

    const interruptTool = {
      name: 'team.interrupt', capability: 'orchestrator', scope: 'write', requiresConsent: false,
      description: 'Interrupt one of your running background subagents by id. This aborts its run and keeps its event/result record for inspection or resume.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async (args, ctx) => {
        if (!subagents) return { content: 'background subagents unavailable', summary: 'unavailable' };
        const r = subagents.interrupt(String(args.id || ''), (ctx && ctx.agentId) || 'agent');
        return withTaint({ content: JSON.stringify(r), summary: r.ok ? (r.alreadyDone ? 'already done' : 'interrupted') : 'not interrupted' }, taintOfRows([r && r.record]));
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
        // the resumed generation follows THIS run: cancelling it cancels the worker it restarted
        const r = subagents.resume(rec.id, resumeRunnerFor(ctx), { parentRunId: (ctx && ctx.runId) || '' });
        if (!r.ok) {
          const error = new Error(String(r.error || 'background subagent is not resumable'));
          error.precondition = { code: 'subagent_not_resumable', requiredTool: 'team.subagents', requiredState: 'stale_or_interrupted_or_failed' };
          throw error;
        }
        return withTaint({ content: JSON.stringify(r), summary: 'resumed' }, taintOfRows([r && r.record]));
      }
    };

    return {
      dispatchTool, spawnTool, summonTool, subagentsTool, steerTool, interruptTool, resumeTool,
      register(reg) { [dispatchTool, spawnTool, summonTool, subagentsTool, steerTool, interruptTool, resumeTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeOrchestrationTools, fitAggregate };
});
