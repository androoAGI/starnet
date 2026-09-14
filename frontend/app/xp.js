/* STARNET — xp.js : the AGENT-GROWTH model — XP, Level, and a Confidence (reliability) gauge.
   Pure + testable (UMD: an `Xp` global in the browser, module.exports under node).

   Four HONEST meters — never fabricated, mirroring ctxgauge.js. The first two read off explicit user
   satisfaction; the third reads off what the harness itself observed; the fourth off what the agent has
   actually learned and put to work. They are never averaged into one score: two meters that can disagree is
   the truthful shape.
     • XP / LEVEL  — cumulative, MONOTONIC user trust. You never lose a level.
                     Curve: cumulative XP to REACH level n = LEVEL_K * n * (n-1)
                     (L2=50, L3=150, L5=500, L10=2250, L28=18900).
     • CONFIDENCE  — a recency-weighted (EWMA) satisfaction %, moves BOTH ways. Reports
                     known:false ("calibrating") until MIN_SAMPLES user feedback samples exist, so a
                     fresh agent never shows a made-up number.
     • RELIABILITY — (S2) completed ÷ attributable runs, off the frozen agent.run.end terminal reasons.
                     What the HARNESS observed, not what the Commander said, so it can honestly disagree
                     with CONFIDENCE. Mints NO XP; provider faults and Commander cancellations are excluded
                     from the ratio, never charged to the agent. Same calibration honesty (MIN_RUNS).
     • PRACTICE     — (S5) distilled procedures the agent wrote from real work AND has actually used since.
                     Descriptive capability, not currency: authoring earns nothing, so it cannot be farmed.

   The design rule: these DESCRIBE the agent's user-approved growth/reliability — they never GATE it. No
   capability is ever locked behind a level. The station-wide rollup uses the SAME engine fed
   the same events, so "STATION Lv 28" is just the colony's cumulative, user-approved track record. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Xp = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- tunables (one place to retune the whole feel) ----
  const LEVEL_K = 25;       // cumulative XP to REACH level n = LEVEL_K * n * (n-1)
  const ALPHA = 0.25;       // EWMA weight — how fast satisfaction tracks recent feedback
  const SEED_CONF = 50;     // neutral starting confidence (held, not shown, until calibrated)
  const MIN_SAMPLES = 3;    // user feedback samples needed before confidence is "known"
  const FEEDBACK_XP_PER_DELTA = 10; // explicit positive user turn-in feedback is the only XP mint
  const FEEDBACK_XP_CAP = 50;       // cap one feedback event so one huge delta cannot jump many levels
  const MIN_RUNS = 3;               // attributable runs needed before RELIABILITY is "known" (cf. MIN_SAMPLES)
  const MAX_WHOLE = Number.MAX_SAFE_INTEGER;
  const RECEIPT_CAP = 10000;        // exact replay horizon; compacted after each durable-history checkpoint

  /* S2 — RELIABILITY: the SECOND axis, and deliberately NOT a second XP faucet.
     CONFIDENCE answers "what did the Commander SAY about this agent"; RELIABILITY answers "what did the
     HARNESS OBSERVE" — the one thing the meters never used to read, even though every fact was already on the
     bus. It mints no XP and never touches the level ladder (scoreEvent is untouched): XP stays user-approval-only.

     THE HONESTY LINE is WHICH TERMINAL REASON THE AGENT IS ACCOUNTABLE FOR. A run is only attributable when the
     agent's own conduct decided the outcome:
       • ATTRIBUTED — 'done' (completed) · 'max_iters' / 'budget' / 'refusal' (it engaged and fell short)
       • EXCLUDED   — 'error' + 'empty' (the PROVIDER failed: a 404, a dead model id, an out-of-credit key, a
                      degraded stream — charging that to the agent would be a lie, and it is the single most
                      common terminal on a misconfigured station) · 'cancelled' (the COMMANDER stopped it) ·
                      'clarifying' (a neutral Task Brief question — the frozen contract says every success-keyed
                      consumer must treat it exactly like 'cancelled').
     Excluded runs are still COUNTED, separately, so the dossier can say how many were set aside instead of
     silently shrinking the denominator. Reasons are the frozen shared/events.js enum; an unknown future value
     falls through to neither bucket (counted only in `runs`), which is the safe, non-lying default. */
  const RELIABILITY_ATTRIBUTED = { done: 'done', max_iters: 'short', budget: 'short', refusal: 'short' };
  const RELIABILITY_EXCLUDED = { error: 'faulted', empty: 'faulted', cancelled: 'neutral', clarifying: 'neutral' };
  // LEGACY SIZE TELEMETRY: workSize still classifies real run cost/tool facts for receipts and old saves, but it
  // NEVER changes XP. Spend and tool count measure execution shape, not value to the Commander's life goal; using
  // them as a multiplier rewarded expensive/thrashy work. Meaningful complexity now lives in the separate verified
  // journey/mastery ledger. Equal explicit verdicts earn equal XP.

  // derive the honest size hint from a run's REAL work: successful tool calls + reconciled spend.
  // Pure + shared so the rate-the-work caller (chat.js) and tests agree on one derivation.
  function workSize(w) {
    const tools = Math.max(0, (w && w.tools) | 0);
    const usd = Math.max(0, (w && typeof w.usd === 'number' && isFinite(w.usd)) ? w.usd : 0);
    if (tools >= 6 || usd >= 0.5) return 'large';
    if (tools >= 3 || usd >= 0.08) return 'medium';
    return 'small';
  }

  // P3.2 CREW-RUN ATTRIBUTION — one explicit verdict has one value. A named worker run-end is proof of
  // participation; tools/spend never scale its credit. The sidecar independently reconstructs this from durable
  // parent/child run records, so this browser projection is only a request hint.
  // Returns { lead: { delta, size }, workers: [{ agentId, delta, size }] } — deltas feed the SAME memory.feedback
  // mint path (xp.js scoreEvent), so a worker's share rides the identical, node-tested XP curve. Pure + exported.
  //   args: { leadDelta (the whole-run size delta 1..10), leadCost (usd), workers: [{ agentId, usd }] }
  function crewSplit(args) {
    args = args || {};
    const leadDelta = Math.max(1, Math.min(10, Math.round(num(args.leadDelta, 1)) || 1));
    const raw = Array.isArray(args.workers) ? args.workers : [];
    // Ephemeral spawn clones are filtered by the caller/server; duplicate named contributors collapse here.
    const proven = [];
    const seen = new Set();
    for (const w of raw) {
      const aid = w && typeof w.agentId === 'string' ? w.agentId.trim() : '';
      if (aid && !seen.has(aid)) { seen.add(aid); proven.push({ agentId: aid, usd: Math.max(0, num(w && w.usd, 0)) }); }
    }
    const out = { lead: { delta: leadDelta, size: null }, workers: [] };
    for (const w of proven) {
      out.workers.push({ agentId: w.agentId, delta: leadDelta, size: workSize({ usd: w.usd }) });
    }
    return out;
  }

  function feedbackReason(p) {
    return String((p && p.reason) || '').trim().toLowerCase();
  }
  function turnInFeedbackQuality(reason) {
    if (reason === 'kept' || reason === 'edited') return 1;
    if (reason === 'discarded') return 0;
    // The post-run "rate the work" beat (chat.js) rides this SAME mint path with a synthetic id, called
    // directly into XpStore (never the bus / never the sidecar memory store — so memory trust is untouched).
    if (reason === 'work_great') return 1;     // 👍 nailed it — full positive: mints size-weighted XP + confidence up
    if (reason === 'work_ok') return 0.5;      // 👌 close — a neutral satisfaction sample only: never mints XP
    if (reason === 'work_miss') return 0;      // 👎 missed — confidence down, no XP, and NO penalty
    return null;
  }

  // ---- XP + satisfaction per event ----
  // XP comes ONLY from explicit positive user feedback — a turn-in Keep/Edit OR a 👍 "rate the work" verdict
  // (both ride memory.feedback). Operational events still feed counters but never level an agent on their own.
  // returns { xp, quality } : xp is positive-only (failures/negative feedback never subtract);
  // quality in [0,1] feeds satisfaction confidence, or null when the event carries no user judgment.
  function scoreEvent(name, p) {
    p = p || {};
    switch (name) {
      case 'agent.run.end': {
        switch (p.reason) {
          case 'done':      return { xp: 0, quality: null };
          case 'max_iters': return { xp: 0, quality: null };
          case 'budget':    return { xp: 0, quality: null };
          case 'refusal':   return { xp: 0, quality: null };
          case 'error':     return { xp: 0, quality: null };
          case 'cancelled': return { xp: 0, quality: null };
          default:          return { xp: 0, quality: null };
        }
      }
      case 'agent.tool_result':  return { xp: 0, quality: null };
      case 'memory.write':       return { xp: 0, quality: null };
      case 'memory.used':        return { xp: 0, quality: null };
      case 'memory.feedback': {
        const quality = turnInFeedbackQuality(feedbackReason(p));
        if (quality === null) return { xp: 0, quality: null };
        const d = (typeof p.delta === 'number' && Number.isFinite(p.delta)) ? p.delta : 0;
        const eff = Math.min(Math.max(d, 0), 10);
        // ONLY a full positive (quality 1 = kept/edited/work_great) mints; a 👌 work_ok (0.5) is a satisfaction
        // sample with no XP. Gate on >=1 so the neutral middle rung never levels an agent.
        return { xp: quality >= 1 && d > 0 ? Math.min(FEEDBACK_XP_CAP, Math.round(eff * FEEDBACK_XP_PER_DELTA)) : 0, quality };
      }
      case 'workitem.delivered': return { xp: 0, quality: null };
      case 'channel.delivery':   return { xp: 0, quality: null };
      default:                   return { xp: 0, quality: null };
    }
  }

  // ---- the curve ----
  function xpForLevel(level) { level = Math.max(1, Math.floor(level || 1)); return LEVEL_K * level * (level - 1); }
  function levelForXp(xp) {
    if (!Number.isFinite(xp)) return 1;   // defensive: a corrupted save must never yield Infinity/NaN levels
    xp = Math.max(0, Math.floor(xp));
    // largest n with LEVEL_K*n*(n-1) <= xp  ->  n = floor((1 + sqrt(1 + 4*xp/LEVEL_K)) / 2)
    return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / LEVEL_K)) / 2));
  }

  // agents with established positive user feedback grow FASTER: a trust multiplier on earned XP, but ONLY
  // once calibrated, and NEVER a penalty (sub-45% confidence just earns base). Tiers align with the bands in compute().
  function trustMult(s) {
    if ((s.samples || 0) < MIN_SAMPLES) return 1;
    const c = s.confidence || 0;
    return c >= 85 ? 1.5 : c >= 65 ? 1.3 : c >= 45 ? 1.15 : 1;
  }

  // ---- the stats shape (used for BOTH a single agent and the station rollup) ----
  function fresh() { return { xp: 0, level: 1, lifetimeXp: 0, confidence: SEED_CONF, samples: 0, counters: {}, milestones: [], receipts: { runs: [], feedback: [] } }; }
  function clone(s) { return s ? JSON.parse(JSON.stringify(s)) : fresh(); }
  // defensive: a corrupted / hand-edited save must never let a non-finite value (NaN/Infinity) poison the
  // meters. The schema validator blocks these at the bus; this is belt-and-suspenders on the persisted state.
  function num(v, d) { return Number.isFinite(v) ? v : d; }
  function whole(v, d) { return Math.max(0, Math.min(MAX_WHOLE, Math.floor(num(v, d)))); }
  function receiptList(v) {
    if (!Array.isArray(v)) return [];
    const seen = new Set(), out = [];
    for (let i = Math.max(0, v.length - RECEIPT_CAP); i < v.length; i++) {
      const id = String(v[i] == null ? '' : v[i]);
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  }
  function sanitize(s) {
    s.confidence = Math.max(0, Math.min(100, num(s.confidence, SEED_CONF)));
    s.xp = whole(s.xp, 0);
    s.samples = whole(s.samples, 0);
    const maxLevel = levelForXp(MAX_WHOLE);
    s.level = Math.max(1, Math.min(maxLevel, whole(s.level, 1)));
    s.level = Math.max(s.level, levelForXp(s.xp));
    s.xp = Math.max(s.xp, xpForLevel(s.level));
    s.lifetimeXp = Math.max(whole(s.lifetimeXp, 0), s.xp);
    if (!s.counters || typeof s.counters !== 'object' || Array.isArray(s.counters)) s.counters = {};
    for (const k of Object.keys(s.counters)) s.counters[k] = whole(s.counters[k], 0);
    s.milestones = Array.isArray(s.milestones) ? Array.from(new Set(s.milestones.map(String))) : [];
    if (!s.receipts || typeof s.receipts !== 'object' || Array.isArray(s.receipts)) s.receipts = {};
    s.receipts = { runs: receiptList(s.receipts.runs), feedback: receiptList(s.receipts.feedback) };
    return s;
  }

  /* ---- milestones — declarative; each fires ONCE when its predicate first holds ----
     each carries a display label + the unlock HINT shown on its locked badge (drives the trophy case).

     S4 — THE MID-GAME. The original nine had four badges that all fire in session one and then a cliff to
     25 tasks / Lv 10, so the entire middle of an agent's life lit nothing. The five added here sit in that
     gap, and every one of them is predicated on a counter the HARNESS PROVES — no participation badges,
     nothing minted by opening a panel:
       • the shipped-task ladder is now 1 → 5 → 25 → 100, the SAME rungs credential() publishes as tiers, so
         a trophy lighting and the agent's dispatch briefing gaining a line are one event, not two systems.
       • HANDS ON is the first badge in the whole catalogue to read `toolsOk` — real successful tool calls,
         the most-proven counter the station keeps, and previously worth no recognition at all.
       • DEPENDABLE is the harness-observed twin of TRUSTED (what the Commander SAID vs what the station SAW).
         It asks reliability() for the band rather than re-deriving the 85% threshold, so the badge can never
         drift from the dossier's B2 gauge, and it adds a VOLUME floor on top: the band alone goes DEPENDABLE
         at MIN_RUNS (3), which would have made this a sixth session-one badge — the exact cliff S4 exists to
         fix. Ten owned runs is a real body of work, and the hint says so rather than implying the gauge lies.
     Earning any of them still unlocks NOTHING (the sandbox law) — a trophy is recognition, never a key. */
  const MILESTONES = [
    { id: 'first_light', label: 'FIRST LIGHT', hint: 'ship 1 task',       when: (c) => (c.tasksDone || 0) >= 1 },     // first task shipped
    { id: 'still_here',  label: 'STILL HERE',  hint: '5 tasks',           when: (c) => (c.tasksDone || 0) >= 5 },     // S4: the first real rung — and the tier credential() first publishes
    { id: 'approved',    label: 'APPROVED',    hint: 'earn positive feedback', when: (c) => (c.positiveFeedback || 0) >= 1 }, // first user approval
    { id: 'pack_rat',    label: 'PACK RAT',    hint: 'reuse a memory',    when: (c) => (c.memReused || 0) >= 1 },     // first memory reused
    { id: 'long_memory', label: 'LONG MEMORY', hint: 'reuse 10 memories', when: (c) => (c.memReused || 0) >= 10 },    // S4: memory reuse became a habit (one credit per run, never per chunk)
    { id: 'archivist',   label: 'ARCHIVIST',   hint: '10 memories saved', when: (c) => (c.memWrites || 0) >= 10 },    // built a real memory bank
    { id: 'hands_on',    label: 'HANDS ON',    hint: '25 tool calls',     when: (c) => (c.toolsOk || 0) >= 25 },      // S4: 25 tools that really ran and really succeeded
    { id: 'workhorse',   label: 'WORKHORSE',   hint: '25 tasks',          when: (c) => (c.tasksDone || 0) >= 25 },    // 25 tasks shipped
    { id: 'centurion',   label: 'CENTURION',   hint: '100 tasks',         when: (c) => (c.tasksDone || 0) >= 100 },   // 100 tasks shipped
    { id: 'night_shift', label: 'NIGHT SHIFT', hint: '1 delivery',        when: (c) => (c.delivered || 0) >= 1 },     // delivered work via an external channel
    { id: 'trusted',     label: 'TRUSTED',     hint: 'satisfaction 85%',  when: (c, s) => s.samples >= MIN_SAMPLES && s.confidence >= 85 },   // satisfaction -> TRUSTED
    { id: 'dependable',  label: 'DEPENDABLE',  hint: '85% of 10+ runs',   when: (c, s) => (c.runsOwned || 0) >= 10 && reliability(s).band === 'dependable' },   // S4: the harness's own read, SUSTAINED
    { id: 'seasoned',    label: 'SEASONED',    hint: 'reach Lv 5',        when: (c, s) => s.level >= 5 },             // S4: the one rung on an otherwise empty Lv1 -> Lv10 ladder
    { id: 'veteran',     label: 'VETERAN',     hint: 'reach Lv 10',       when: (c, s) => s.level >= 10 },            // reached level 10
  ];
  // the ONE milestone loop — shared by applyEvent (fire on a real event) and reconcile (light what is already
  // true). Mutates s.milestones, appends the newly-earned ids to `into`, and returns it.
  function fireMilestones(s, into) {
    for (const m of MILESTONES) {
      if (s.milestones.indexOf(m.id) === -1 && m.when(s.counters, s)) { s.milestones.push(m.id); into.push(m.id); }
    }
    return into;
  }
  function bump(c, k, by) { c[k] = whole((c[k] || 0) + (by == null ? 1 : by), 0); }
  function receiptFor(name, p) {
    if (name === 'agent.run.end' && p.runId != null) return { bucket: 'runs', id: String(p.runId) };
    if (name === 'memory.feedback' && turnInFeedbackQuality(feedbackReason(p)) !== null &&
        (p.receiptId != null || String(p.id || '').indexOf('work:') === 0)) {
      return { bucket: 'feedback', id: String(p.receiptId == null ? p.id : p.receiptId) };
    }
    return null;
  }
  function hasReceipt(s, receipt) { return receipt && s.receipts[receipt.bucket].indexOf(receipt.id) !== -1; }
  function addReceipt(s, receipt) {
    if (!receipt || hasReceipt(s, receipt)) return;
    const list = s.receipts[receipt.bucket];
    list.push(receipt.id);
    if (list.length > RECEIPT_CAP) list.splice(0, list.length - RECEIPT_CAP);
  }

  // ---- the one transform: fold a real event into a stats object (pure: returns a NEW object) ----
  // ev = { name, payload }.  returns { stats, awards } where
  //   awards = { xp, levelFrom, levelTo, levelUp, milestones[] }
  // a fresh per-run buffer for credit that must wait for the run's outcome (see applyEvent COUNTERS). Keyed by
  // runId so a new run starts a clean tally even if a prior run's end was never seen. usedMemory is a FLAG (one
  // reuse EVENT per run — never one per recalled chunk), matching the "reuse a memory" trophy copy.
  function freshRun(id) { return { id: id == null ? null : id, usedMemory: false, toolsOk: 0 }; }
  // Did the run produce anything? 'error' (the model call failed / 404) and 'empty' (a degraded provider streamed a
  // zero-tool, zero-text turn) both mean "no work happened", so buffered credit is DISCARDED. Every other terminal
  // reason (done, and the ceiling/abort reasons max_iters/budget/cancelled/refusal, where the model DID engage) keeps
  // its earned credit — withholding it from genuine partial work would be its own dishonesty.
  function runDidWork(reason) { return reason !== 'error' && reason !== 'empty'; }

  function applyEvent(stats, ev) {
    const s = sanitize(clone(stats));
    if (!s.counters) s.counters = {};
    if (!s.milestones) s.milestones = [];
    if (!s.run || typeof s.run !== 'object') s.run = freshRun(null);
    const name = (ev && ev.name) || '', p = (ev && ev.payload) || {};
    const sc = scoreEvent(name, p);
    const awards = { xp: 0, levelFrom: s.level, levelTo: s.level, levelUp: false, milestones: [], duplicate: false };
    const receipt = receiptFor(name, p);
    if (hasReceipt(s, receipt)) { awards.duplicate = true; return { stats: s, awards }; }

    // base XP: explicit positive user feedback only. Operational events can still update counters below,
    // but they cannot mint XP or move the level ladder by themselves.
    let base = sc.xp;

    // XP — monotonic, scaled by the agent's ESTABLISHED satisfaction (trust bonus uses pre-update confidence)
    if (base > 0) {
      // The event cap is final, not merely a pre-trust base cap: established trust may improve a normal
      // award, but a single verdict must never jump past the documented +50 ceiling.
      const gained = Math.min(FEEDBACK_XP_CAP, Math.round(base * trustMult(s)));
      s.xp += gained; s.lifetimeXp += gained; awards.xp = gained;
      const lvl = Math.max(s.level, levelForXp(s.xp));
      if (lvl > s.level) { awards.levelUp = true; awards.levelTo = lvl; }
      s.level = lvl;
    }

    // CONFIDENCE — bidirectional EWMA; only explicit user feedback moves it
    if (sc.quality !== null && sc.quality !== undefined) {
      s.samples += 1;
      s.confidence = Math.max(0, Math.min(100, s.confidence + ALPHA * (sc.quality * 100 - s.confidence)));
    }

    // COUNTERS — drive milestones + the dossier.
    //
    // THE HONESTY LINE for operational counters is WHICH EVENT PROVES WHICH FACT:
    //   • agent.tool_result{ok} → toolsOk, memory.write → memWrites, workitem.delivered → delivered
    //     each fires ONLY when that action REALLY happened (a tool truly ran, a note was truly written, a work-item
    //     truly reached the outbox). The event IS the proof, so they commit IMMEDIATELY. A run that errors AFTER
    //     making real tool calls must not un-count them — discarding provably-completed work would be its own lie
    //     (under-claiming the dossier), and a run that dies BEFORE acting never emits these anyway.
    //   • memory.feedback → positiveFeedback / negativeFeedback are EXPLICIT user verdicts, not run outcomes —
    //     immediate, unchanged.
    //   • runs counts attempts (an errored run IS a run) — immediate.
    //   • memReused is the exception: it is fed by memory.used, which the sidecar emits at CONTEXT-ASSEMBLY — before
    //     the model is even called. A 404'd run recalls memory, then dies having produced nothing, yet would still
    //     mint memory-reuse credit AND the permanent PACK RAT trophy. Recall is NOT proof of work. So we BUFFER the
    //     reuse in s.run and only credit it at run.end, and only when the run produced something (runDidWork). It is
    //     also credited at most ONCE per run (a flag, not a per-chunk tally), matching the "reuse a memory" copy —
    //     memory.used fires once PER recalled chunk (7× for a 7-record recall), which would otherwise over-count.
    if (name === 'agent.run.end') {
      const sameRun = s.run && s.run.id === p.runId;
      bump(s.counters, 'runs');
      if (p.reason === 'done') bump(s.counters, 'tasksDone');
      if (p._historyToolsOk) bump(s.counters, 'toolsOk', Math.max(0, p._historyToolsOk - (sameRun ? (s.run.toolsOk || 0) : 0)));
      /* S2 RELIABILITY buckets — provable outcome facts, no XP consequence.
         `runsOwned` is bumped for EVERY attributable run (including the completions), even though
         `tasksDone` already counts the done ones. That duplication is deliberate and load-bearing: these
         counters must be written ONLY by S2, so that their ABSENCE unambiguously means "this save predates
         reliability" rather than "this agent never fell short". Deriving the denominator from the older
         `runs`/`tasksDone` pair instead made every legacy save render a fabricated 100% — caught by
         test/xp.test.js's pre-S2 save case, which is why that test exists. */
      if (RELIABILITY_ATTRIBUTED[p.reason]) {
        bump(s.counters, 'runsOwned');
        if (RELIABILITY_ATTRIBUTED[p.reason] === 'done') bump(s.counters, 'runsWon');
      }
      else if (RELIABILITY_EXCLUDED[p.reason] === 'faulted') bump(s.counters, 'runsFaulted');
      else if (RELIABILITY_EXCLUDED[p.reason] === 'neutral') bump(s.counters, 'runsNeutral');
      // COMMIT-OR-DISCARD this run's buffered memory reuse, then reset for the next run. A run that produced nothing
      // (error/empty) forfeits it — no PACK RAT for a recall that never fed a real turn.
      if (sameRun && s.run.usedMemory && runDidWork(p.reason)) bump(s.counters, 'memReused');
      s.run = freshRun(null);   // whatever the outcome, the tally is spent — the next run starts clean
    }
    else if (name === 'memory.used') {
      // stamp the buffer to THIS run (a new runId starts a clean tally, so a dropped prior run.end can't leak
      // credit forward) and record that memory surfaced. Credit is deferred to run.end.
      if (s.run.id !== p.runId) s.run = freshRun(p.runId);
      s.run.usedMemory = true;
    }
    else if (name === 'agent.tool_result' && p.ok && !p.isError) {
      if (s.run.id !== p.runId) s.run = freshRun(p.runId);
      // DEDUPE BY callId: the hero page re-emits the harness's authoritative tool_result with the resolved
      // tool NAME attached (chat.js onToolResult — the frozen shape carries no name), so an interactive run
      // delivers each result TWICE on the bus. Both copies share the callId; count each real call once.
      const cid = p.callId ? String(p.callId) : '';
      const dup = !!(cid && s.run.seenCalls && s.run.seenCalls[cid]);
      if (!dup) {
        if (cid) { if (!s.run.seenCalls) s.run.seenCalls = {}; s.run.seenCalls[cid] = 1; }
        bump(s.run, 'toolsOk');
        bump(s.counters, 'toolsOk');
      }
    }
    else if (name === 'memory.write') bump(s.counters, 'memWrites');
    else if (name === 'workitem.delivered') { if (!p.sample) bump(s.counters, 'delivered'); }   // a routing-sample PROOF dispatch marks itself sample:true — never durable dossier credit
    else if (name === 'memory.feedback') {
      const quality = turnInFeedbackQuality(feedbackReason(p));
      if (quality === 1) bump(s.counters, 'positiveFeedback');
      else if (quality === 0) bump(s.counters, 'negativeFeedback');
    }

    // MILESTONES — fire once
    fireMilestones(s, awards.milestones);
    addReceipt(s, receipt);
    return { stats: s, awards };
  }

  /* S4 — RECONCILE: light every badge this save has ALREADY earned, without an event.
     Milestones only ever fired inside applyEvent, so a save written before a badge EXISTED carries the record
     that satisfies it and none of the credit: the trophy case would show `STILL HERE ▸ 5 tasks` LOCKED while
     the dossier two sections above read "8 tasks shipped" — the app contradicting its own state, which is the
     one thing this product must never do. The alternative (wait for the next event) is worse: the whole
     backlog then detonates as a burst of gold TROPHY EARNED broadcasts for work done weeks ago.
     So the caller reconciles at boot and does NOT announce: these are historical facts being recognized, not
     moments happening now. Pure, idempotent (a second call earns nothing), and it can only ADD — it never
     revokes a badge whose predicate has since stopped holding, because a trophy records that you REACHED it.
     Returns { stats, earned } so a caller that DOES want to say something knows exactly what changed. */
  function reconcile(stats) {
    const s = sanitize(clone(stats));
    if (!s.counters) s.counters = {};
    if (!s.milestones) s.milestones = [];
    return { stats: s, earned: fireMilestones(s, []) };
  }

  // ---- render-state for the gauges (pure transform → render-agnostic, mirrors CtxGauge.compute) ----
  function compute(stats) {
    const s = stats || fresh();
    const level = Math.max(1, Math.floor(num(s.level, 1)));
    const base = xpForLevel(level), next = xpForLevel(level + 1), span = Math.max(1, next - base);
    const xp = Math.max(0, Math.floor(num(s.xp, 0)));
    const inLevel = Math.max(0, xp - base);
    const frac = Math.max(0, Math.min(1, inLevel / span));
    const known = Math.max(0, Math.floor(num(s.samples, 0))) >= MIN_SAMPLES;   // honesty: no fabricated % before calibration
    const conf = Math.round(Math.max(0, Math.min(100, num(s.confidence, 0))));
    const bonus = Math.round((trustMult(s) - 1) * 100);     // current feedback XP bonus as a percent (0 / 15 / 30 / 50)
    return {
      level, xp, lifetimeXp: Math.max(0, s.lifetimeXp || 0),
      inLevel, span, toNext: Math.max(0, next - xp),
      frac, pct: Math.round(frac * 100),
      known, confidence: known ? conf : null, confLabel: known ? (conf + '%') : '—', bonus,
      band: !known ? 'calibrating' : conf >= 85 ? 'trusted' : conf >= 65 ? 'reliable' : conf >= 45 ? 'steady' : 'building',
      tasksDone: Math.max(0, Math.floor(num(s.counters && s.counters.tasksDone, 0))),   // shipped-task count for the dossier
      positiveFeedback: Math.max(0, Math.floor(num(s.counters && s.counters.positiveFeedback, 0))),
      negativeFeedback: Math.max(0, Math.floor(num(s.counters && s.counters.negativeFeedback, 0))),
      samples: Math.max(0, Math.floor(num(s.samples, 0))),                              // feedback samples behind the confidence %
      milestones: (s.milestones || []).slice(),
    };
  }

  /* S2 — RELIABILITY as render-state (pure, mirrors compute()). The SECOND honest meter: what the harness
     OBSERVED, versus compute()'s confidence which is what the Commander SAID. Never averaged into one score —
     two meters that can disagree is the truthful shape (a well-liked agent that keeps hitting its iteration
     ceiling should read exactly that way).

     Calibration honesty matches confidence: under MIN_RUNS ATTRIBUTABLE runs it reports known:false and a '—'
     label rather than a number derived from one or two samples.

     LEGACY SAVES: every counter read here is written ONLY by S2, so all four are absent on a save written
     before this shipped and an old agent reads 0/0 → calibrating until it runs again. That is deliberate, and
     it is why the denominator is `runsOwned` rather than the older `runs`/`tasksDone` pair: those predate S2,
     so dividing them would have rendered a confident, WRONG number for every existing agent (and `runs`
     counts provider errors and cancellations besides). We do not ship a number we cannot stand behind — the
     meter starts calibrating instead. */
  function reliability(stats) {
    const s = stats || fresh();
    const c = (s && s.counters) || {};
    const attributed = Math.max(0, Math.floor(num(c.runsOwned, 0)));
    const completed = Math.min(attributed, Math.max(0, Math.floor(num(c.runsWon, 0))));
    const short = attributed - completed;
    const faulted = Math.max(0, Math.floor(num(c.runsFaulted, 0)));   // provider's fault — excluded from the ratio
    const neutral = Math.max(0, Math.floor(num(c.runsNeutral, 0)));   // Commander-cancelled / a clarifying question
    const attempted = attributed;
    const known = attempted >= MIN_RUNS;
    const pct = attempted > 0 ? Math.round((completed / attempted) * 100) : 0;
    return {
      known, completed, short, attempted, excluded: faulted + neutral, faulted, neutral,
      pct: known ? pct : null,
      label: known ? (pct + '%') : '—',
      band: !known ? 'calibrating' : pct >= 85 ? 'dependable' : pct >= 65 ? 'consistent' : pct >= 45 ? 'uneven' : 'faltering',
      toKnown: Math.max(0, MIN_RUNS - attempted),   // attributable runs still needed before a % is honest
    };
  }

  /* S3 — CREDENTIAL: the agent's track record reduced to COARSE, SLOW-MOVING facts, so it can be safely put
     somewhere a fast-changing number must never go (a delegation briefing the lead reads to pick a worker).

     Everything here is quantized on purpose. XP ticks on every approval and `tasksDone` on every run, so
     publishing either raw would rewrite the briefing constantly; the tiers and bands below change a handful of
     times in an agent's whole life, which is what makes `key` usable as a "has anything actually changed?"
     trigger instead of re-pushing on every event.

     EARNED-ONLY: each part is null until the agent has proved it. A brand-new specialist yields
     `{ key: '', text: '' }` — the consumer then says NOTHING about it, rather than publishing "Lv 1 · unproven",
     which would read as a ranking and quietly discourage delegating to a new agent. Silence is the honest
     default; the sandbox law means an unproven agent must never be disadvantaged by the meter. */
  const TIERS = [{ at: 100, label: '100+ tasks shipped' }, { at: 25, label: '25+ tasks shipped' }, { at: 5, label: '5+ tasks shipped' }];
  function credential(stats) {
    const s = stats || fresh();
    const c = (s && s.counters) || {};
    const doneCount = Math.max(0, Math.floor(num(c.tasksDone, 0)));
    const tier = (TIERS.find(t => doneCount >= t.at) || null);
    const m = compute(s);
    const r = reliability(s);
    const confBand = m.known ? m.band : null;         // what the COMMANDER said (needs MIN_SAMPLES ratings)
    const relBand = r.known ? r.band : null;          // what the HARNESS saw (needs MIN_RUNS attributable runs)
    const parts = [];
    if (tier) parts.push(tier.label);
    if (confBand) parts.push('Commander rating: ' + confBand.toUpperCase());
    if (relBand) parts.push('finish rate: ' + relBand.toUpperCase());
    return {
      tier: tier ? tier.at : null, confBand, relBand,
      // the change-detection handle: identical key => nothing worth republishing has moved. Empty (not '||')
      // when nothing is earned, so "has a credential at all" is a plain truthiness check for every consumer.
      key: parts.length ? [tier ? tier.at : '', confBand || '', relBand || ''].join('|') : '',
      text: parts.join(' · '),
    };
  }

  /* S5 — PRACTICE: what this agent has actually LEARNED, as opposed to what it has been paid in.
     The lane's original S5 sketch was to redefine LEVEL as a readout of accumulated capability. That is the
     right IDEA and the wrong PLACE: level is a monotonic, user-approval-only ladder that every existing save
     has already climbed under that rule, so redefining it would silently rewrite records the Commander earned,
     and it renders synchronously in the world/topbar where this data (an async per-agent skill list) cannot go.
     So it lands the way RELIABILITY did — a FOURTH separately-labelled meter, never averaged into the others.

     A procedure counts as LEARNED only when all four hold, and each exclusion is a lie we refuse to tell:
       • the AGENT wrote it (createdBy agent/reflection/background-review/curator). A skill the Commander
         authored is GIVEN, not learned — counted separately, never folded in.
       • it is not ARCHIVED — a retired procedure is not carried knowledge.
       • the guard is not WITHHOLDING it. A withheld skill was never handed to the model, so claiming the agent
         "knows" it would assert something the harness can prove false.
       • it has been USED at least once (useCount >= 1). THIS is the anti-farm line and the whole point: an
         agent can author skills all day, and authoring moves nothing. The count only advances when a distilled
         procedure was actually loaded into real work — a fact the store writes, not the model.
     `known` splits "we could not read the skillbase" (null in → known:false, label '—') from the honest,
     precise answer zero ([] in → known:true, count 0). A count of nothing is evidence; a count we never
     fetched is not. Nothing here gates anything — it describes, exactly like every other meter in this file. */
  const PRACTICE_AUTHORED = { agent: 1, reflection: 1, 'background-review': 1, 'agent-created': 1, curator: 1 };
  function practice(skills) {
    const known = Array.isArray(skills);
    const list = known ? skills : [];
    let learned = 0, idle = 0, withheld = 0, given = 0, retired = 0;
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      if (String(s.state || 'active').toLowerCase() === 'archived') { retired++; continue; }
      if (!PRACTICE_AUTHORED[String(s.createdBy || 'agent').toLowerCase()]) { given++; continue; }
      if (s.withheld) { withheld++; continue; }
      if (Math.max(0, Math.floor(num(s.useCount, 0))) >= 1) learned++; else idle++;
    }
    return {
      known, count: learned, idle, withheld, given, retired,
      authored: learned + idle + withheld,          // everything the agent distilled and still holds
      label: known ? String(learned) : '—',
      band: !known ? 'unknown' : learned >= 7 ? 'fluent' : learned >= 3 ? 'practised' : learned >= 1 ? 'forming' : 'none',
    };
  }

  // the FULL milestone catalogue as render-state: every badge with its label, unlock hint, and earned flag —
  // earned ones lit, locked ones shown with what unlocks them. Pure → drives the trophy case in the dossier.
  function milestones(stats) {
    const earned = (stats && Array.isArray(stats.milestones)) ? stats.milestones : [];
    return MILESTONES.map(m => ({ id: m.id, label: m.label, hint: m.hint, earned: earned.indexOf(m.id) !== -1 }));
  }

  return { fresh, clone, applyEvent, reconcile, compute, reliability, credential, practice, scoreEvent, levelForXp, xpForLevel, milestones, MILESTONES, LEVEL_K, MIN_SAMPLES, MIN_RUNS, RECEIPT_CAP, workSize, crewSplit };
});
