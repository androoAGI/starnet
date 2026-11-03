/* sidecar/auxgovernor.js — the PURE AUX-SPEND GOVERNOR for the post-run seam (aux-budget lane).

   THE PROBLEM THIS CLOSES: after ONE hot task run, up to SIX independent aux model passes can fire
   (sidecar/index.js run-end: reflection · study · thread-mine · scout-cycle · skill-review · skill-curator).
   Each has its OWN salience gate + cooldown + cost cap — good in isolation — but there was NO JOINT ceiling:
   a single substantive run could touch off five or six billable model calls back-to-back, and no test bounded
   the aggregate. This module is the one JOINT decision: given the passes whose OWN gates already cleared THIS
   run-end (the candidates), a priority order, and a budget, it decides which passes may SPEND and which are
   DEFERRED. It NEVER fires anything and holds NO state — the ambient half (reading the gates, firing the
   granted passes, logging the deferrals) lives in sidecar/index.js.

   PRIORITY is LOCKED to the product's beat order (highest first):
     reflection > failure-review > study > threadmine > scout > skill-review > skill-curator
   so when the budget is scarce the station keeps the turn-in beat + belief updates the Commander actually sees,
   and yields the quieter background passes to the NEXT qualifying run. (failure-review fires only on FAILED
   run-ends, where reflection never qualifies — the two are mutually exclusive per run, never rivals.)

   DEFERRED ≠ SUPPRESSED: a deferred pass simply is not fired this run-end; the caller arms NO cooldown for it,
   so its own gate re-qualifies and it retries on the next run. Truthful telemetry: the caller records the
   deferral (which passes yielded) so a reader can see the ceiling bit, not just its effect.

   DETERMINISM SPLIT (mirrors nightshift.js / nightfocus.js / cron-store.js): every function here is a pure
   transform over its inputs — NO Date.now / new Date() / Math.random / performance.now / fs — so it passes
   test/lint-determinism.js and is headless-testable. There is no `now` parameter because the decision has no
   time dependence: the caller has ALREADY resolved each pass's own time-based gate before handing us the
   candidate list. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).auxgovernor = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The LOCKED beat-order priority: earlier index = higher priority = wins a scarce budget slot.
  // 'failure-review' sits directly after 'reflection': a failed run's lesson is the most valuable thing that
  // run can produce. The two never actually compete — reflection gates on reason 'done' and failure-review on
  // a failure reason, so per run-end at most ONE of them is a candidate (asserted in test/failreview.test.js).
  const PRIORITY = ['reflection', 'failure-review', 'study', 'threadmine', 'scout', 'skill-review', 'skill-curator'];
  // Default JOINT ceiling: at most this many aux passes may SPEND per run-end, a pass the caller marks `reserved` included (it
  // takes its slot first: decide below). 0 means "no ceiling" (governor OFF / unlimited) — an explicit opt-out only; 0 is NEVER
  // the default (see parseBudget).
  const DEFAULT_BUDGET = 2;

  /* THE TOKEN CEILING (issue #105). On an unmetered route (a subscription sign-in books $0 per call) no dollar guard can bind, so
     background aux work gets a rolling token ceiling instead, per route: tokens over 24 hours, cache re-reads at 1/10. A guard on
     passes only: the caller checks it before firing them and never on a user's run. It is SOFT: a pass's tokens count only once
     it has finished and booked its row. aux-admission.js serializes automatic passes per capped route and rechecks after each
     settlement, so concurrent run-ends cannot all spend the same headroom. One admitted pass can finish above the ceiling;
     it is never cut mid-response. A pass cut off before its usage line can still leave the figure incomplete.
     What it skips is not queued: a run's reflection, study and thread mining are gone, a failure review for good. A due skill
     review keeps its nudge count and fires on a later run.
     200k is a starting figure, not a measurement of any plan: reporter's 4-message test ran about 10 aux passes. 0 = off. */
  const DEFAULT_TOKEN_CEILING = 200000;
  const MAX_TOKEN_CEILING = 100000000;
  const TOKEN_WINDOW_MS = 24 * 60 * 60 * 1000;
  // The automatic background passes the ceiling counts. Left out, by being absent: a recall embedding (part of the user's run) and
  // the station one-shots (one thing the Commander pressed). A verdict review and a manual quest refresh are Commander-triggered:
  // they share these kinds, so they run past the ceiling and still count.
  const CEILING_KINDS = Object.freeze(['reflection', 'failure-review', 'study', 'threadmine', 'scout', 'quest-refresh', 'skill-review', 'skill-curator']);
  // parseTokenCeiling(value) -> integer in 0..MAX, or null for anything else: a bad value never reads as "off". Only a number or
  // a string of digits: Number() reads '   ', '\n0', '0x0', [] and [0] as 0, and '1e3' as 1000.
  function parseTokenCeiling(value) {
    let n = null;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && /^\d+$/.test(value)) n = Number(value);
    return (Number.isInteger(n) && n >= 0 && n <= MAX_TOKEN_CEILING) ? n : null;
  }
  // tokenGate({ unmetered, ceiling, used }) -> { applies, blocked, ceiling, used }. `unmetered`: this route draws on an allowance no
  // dollar guard can see. A metered route keeps its dollar guards; a local model draws on nothing. `used` is THIS route's figure.
  function tokenGate(o) {
    o = o || {};
    const parsed = parseTokenCeiling(o.ceiling);
    const ceiling = parsed == null ? DEFAULT_TOKEN_CEILING : parsed;
    const used = (Number.isFinite(o.used) && o.used > 0) ? o.used : 0;
    const applies = o.unmetered === true && ceiling > 0;
    return { applies, blocked: applies && used >= ceiling, ceiling, used };
  }

  // parseBudget(raw, dflt) -> integer >= 0. `raw` is the env string (SKYNET_AUX_BUDGET); `dflt` overrides the
  // module default. A missing / blank / non-integer / negative value falls back to the default — we never
  // silently drop to "unlimited" on garbage input. A literal, well-formed "0" IS honored (unlimited/off) —
  // but only when the operator wrote it, never as the fallback.
  function parseBudget(raw, dflt) {
    const d = (Number.isInteger(dflt) && dflt >= 0) ? dflt : DEFAULT_BUDGET;
    if (raw == null) return d;
    const s = String(raw).trim();
    if (s === '' || !/^\d+$/.test(s)) return d;   // reject '', negatives, floats, junk -> default (fail-safe, not unlimited)
    const n = parseInt(s, 10);
    return (Number.isInteger(n) && n >= 0) ? n : d;
  }

  // rank(name, priority) -> its index in the priority list, or Infinity for an unknown pass (sorts last but is
  // still eligible — the governor never silently drops a pass it doesn't recognize; it just deprioritizes it).
  function rank(name, priority) {
    const p = Array.isArray(priority) ? priority : PRIORITY;
    const i = p.indexOf(name);
    return i < 0 ? Infinity : i;
  }

  // decide({ candidates, budget, priority, reserved }) -> { spend:[names], deferred:[names], reserved:[names], budget, unlimited }
  //   candidates : pass-names whose OWN gates ALREADY cleared this run-end (input order irrelevant — we re-sort).
  //   budget     : integer (typically from parseBudget); 0 = unlimited (every candidate spends, nothing deferred).
  //   priority   : optional override of PRIORITY (tests); defaults to the locked order.
  //   reserved   : candidates that take their budget slots FIRST, so they count against the ceiling and cannot lose to a
  //                higher beat; the rest share what is left in priority order. For a pass that carries its own due-counter
  //                (the skill nudge: skillreview.nudgeAfterRun): by rank alone it would lose every run-end, because the
  //                scout is a candidate on every finished task. The beat it displaces gets its next chance on the next run.
  //                It used to spend on top of the budget (issue #105). A reserved name that is not a candidate spends nothing.
  // Pure: same inputs -> same output, always. Dups are collapsed; unknown names sort last but stay eligible.
  function decide(o) {
    o = o || {};
    const priority = Array.isArray(o.priority) ? o.priority : PRIORITY;
    const budget = (Number.isInteger(o.budget) && o.budget >= 0) ? o.budget : DEFAULT_BUDGET;
    const src = Array.isArray(o.candidates) ? o.candidates : [];
    const reservedSet = new Set((Array.isArray(o.reserved) ? o.reserved : []).map(String));
    const seen = new Set();
    const list = [];
    for (let i = 0; i < src.length; i++) {
      const name = String(src[i]);
      if (seen.has(name)) continue;   // collapse duplicates (a pass named twice still spends at most once)
      seen.add(name);
      list.push({ name, i });
    }
    // sort by priority; stable tiebreak on first-seen index so the output is fully deterministic across engines.
    list.sort((a, b) => (rank(a.name, priority) - rank(b.name, priority)) || (a.i - b.i));
    const ordered = list.map(x => x.name);
    const reserved = ordered.filter(n => reservedSet.has(n));
    const governed = ordered.filter(n => !reservedSet.has(n));
    if (budget === 0) return { spend: ordered.slice(), deferred: [], reserved, budget: 0, unlimited: true };
    const first = reserved.slice(0, budget);
    const spent = first.concat(governed.slice(0, budget - first.length));
    return { spend: ordered.filter(n => spent.indexOf(n) >= 0), deferred: ordered.filter(n => spent.indexOf(n) < 0), reserved: first, budget: budget, unlimited: false };
  }

  // pickAuxEffort(allowed) -> 'none' | 'minimal' | 'low' | null. The reasoning effort for REASON-ONLY aux work (the
  // post-run passes and internal self-talk runs) when the operator configured no aux tier: the LOWEST effort the
  // provider verifiably offers for that model. Aux work is a strict-format extraction (a title, a PREFERENCE line, a
  // JSON plan); thinking is billed as output and the Commander never sees it — measured live on haiku-4.5, a title
  // spent 483 reasoning tokens at the chat's 'medium' and 0 at 'none' for the same title. `allowed` is the provider's
  // own reasoningEfforts(model) list; no list, or no low tier on it, -> null = no override (the provider default).
  const AUX_EFFORT_LADDER = ['none', 'minimal', 'low'];
  function pickAuxEffort(allowed) {
    if (!Array.isArray(allowed)) return null;
    for (let i = 0; i < AUX_EFFORT_LADDER.length; i++) if (allowed.indexOf(AUX_EFFORT_LADDER[i]) >= 0) return AUX_EFFORT_LADDER[i];
    return null;
  }

  // effortAsRan(want, allowed) -> the rung a run that asked for `want` actually ran on, read from the model's list AFTER
  // the run. A self-talk pick the endpoint refused mid-run was resent at the nearest rung it keeps — down first, then up,
  // the OpenRouter adapter's clamp — and the list now says so (test/openrouter-effort-heal.test.js). `want` itself when
  // it is still on the list, or when there is no list to read.
  const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  function effortAsRan(want, allowed) {
    if (!want) return null;
    if (!Array.isArray(allowed) || !allowed.length || allowed.indexOf(want) >= 0) return want;
    const at = EFFORT_ORDER.indexOf(want);
    if (at < 0) return want;
    for (let i = at; i >= 0; i--) if (allowed.indexOf(EFFORT_ORDER[i]) >= 0) return EFFORT_ORDER[i];
    for (let i = at + 1; i < EFFORT_ORDER.length; i++) if (allowed.indexOf(EFFORT_ORDER[i]) >= 0) return EFFORT_ORDER[i];
    return want;
  }

  return { PRIORITY: PRIORITY.slice(), DEFAULT_BUDGET, DEFAULT_TOKEN_CEILING, MAX_TOKEN_CEILING, TOKEN_WINDOW_MS, CEILING_KINDS: CEILING_KINDS.slice(), parseTokenCeiling, tokenGate, parseBudget, rank, decide, pickAuxEffort, effortAsRan, AUX_EFFORT_LADDER: AUX_EFFORT_LADDER.slice() };
});
