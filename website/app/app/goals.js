/* STARNET — goals.js : the PURE GOAL-TREE engine (GROWTH Tier 2: understanding → direction).

   Today a Commander "goal" is a flat dossier belief string ("shipping a local-first agent harness"); a quest is
   an isolated one-off; a completed quest fires SFX+toast and feeds back NOTHING. This engine upgrades a goal
   into a STRUCTURED, PERSISTED TREE — one goal decomposed into 3-5 ordered MILESTONES, the next OPEN milestone
   surfacing as an actionable quest, real chaining as milestones complete, an HONEST progress meter (done/total,
   nothing synthetic), and completion EVIDENCE written back into the node. The agent decomposes; the Commander
   confirms; only real completed work advances the bar.

   The tree shape:
     goal = { id, text, sourceBeliefId, status:'active'|'done'|'retired',
              milestones:[{ id, text, status:'open'|'done', questRef, evidence, doneAt, journeySyncedAt }],
              createdAt, updatedAt }
   - sourceBeliefId binds the goal to the dossier goals-dim belief it decomposed (dossier.js cd_N ids), so if the
     Study Engine RETIRES that belief (dossier.forget → drift), the goal tree goes status:'retired' (kept for
     history, hidden from the active quest log). retireBySource() carries that propagation.
   - progress(goal) = milestones done / total — the ONLY progress there is (a milestone is done only when its
     REAL work quest completed; foldMilestoneDone writes the evidence + advances the bar; nothing is synthetic).

   PURE + node-testable (a `Goals` global in the browser, module.exports under node), mirroring dossier.js /
   quests.js: NO Date.now / Math.random — the clock is ALWAYS injected (ids/timestamps deterministic + replay-
   safe). parseDecomposition() reads the agent's tagged reply into 3-5 milestone lines with the SAME value floor +
   cap + redaction discipline study.js applies to its belief lines. The browser wiring (goalstore.js) supplies
   Date.now() at the edge, the model call, the dossier reads, and persistence; this file owns only the deterministic
   fold + the quest projection.

   Fail-open by construction: an absent goal, an empty decomposition, a malformed reply — all yield an inert tree
   and never throw. A station with no goals.js loaded is byte-identical to before (additive-only). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Goals = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_MILESTONES = 3;      // a goal worth decomposing has a real path, not one step
  const MAX_MILESTONES = 5;      // and never a wall — 3-5 keeps the arc readable (mission floor + cap)
  const TEXT_CHARS = 140;        // a milestone is a short, actionable line (well under the belief cap)
  const MIN_CONTENT = 6;         // below this it isn't a real step — a value floor against trivia
  const MIN_TOKENS = 2;          // a milestone needs at least this many significant words
  const EVIDENCE_CHARS = 160;    // the run-summary line folded onto a completed milestone

  // a milestone line the agent proposes: "1. <text>" | "- <text>" | "• <text>" | "<text>" (a leading ordinal /
  // bullet is stripped). Deliberately permissive on the marker, strict on "there must be real text after it".
  const LINE = /^\s*(?:\d{1,2}[.)\]:-]?\s+|[-*•]\s+)?(.+?)\s*$/;
  // run-narration openers dropped by the floor — a milestone is a durable step, never "in this run we…".
  const TRANSIENT = /^(the user (said|asked|wanted)|we (discussed|talked|covered)|in this (run|task|session)|this (run|task|session)|today (i|we))\b/i;
  // lines the model sometimes emits as framing, not steps — dropped (a header is not a milestone).
  const FRAMING = /^(here('| i)s|the (path|plan|breakdown|milestones?|steps?)( i see)?|milestones?|steps?|plan)\s*[:\-—]?\s*$/i;

  // a self-contained secret scrubber (the default redact) — the decomposition model text is authored client-side
  // (unlike study proposals, which the sidecar redacts before they reach the browser), so a milestone line must be
  // scrubbed HERE before it can be stored. Covers the common key shapes the app already guards against elsewhere
  // (OpenRouter/OpenAI sk- keys, bearer tokens, long hex/base64 secrets). The host may inject a stronger redact;
  // this is the always-on floor so redaction can never be skipped. Conservative: only obvious secret shapes go.
  const SECRET_RES = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,                 // sk- / sk-or-v1- style API keys
    /\b(?:xox[baprs]-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{10,}\b/g,   // slack / github tokens
    /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,         // bearer tokens
    /\b[A-Fa-f0-9]{32,}\b/g                       // long hex secrets (≥32) — API secrets / hashes
  ];
  function scrubSecrets(s) {
    let out = String(s == null ? '' : s);
    for (const re of SECRET_RES) out = out.replace(re, '[redacted]');
    return out;
  }

  const STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that with as at by from your you i we they').split(/\s+/));
  function floorTokens(s) {
    const set = new Set();
    for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 2 && !STOP.has(t)) set.add(t);
    return set.size;
  }
  function lowValue(text) {
    const c = String(text == null ? '' : text).trim();
    if (c.length < MIN_CONTENT) return true;
    if (floorTokens(c) < MIN_TOKENS) return true;
    if (TRANSIENT.test(c)) return true;
    if (FRAMING.test(c)) return true;
    return false;
  }
  const clip = (s, n) => { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) : s; };

  /* THE DECOMPOSITION DIRECTIVE — the self-assigned task the agent runs to break a goal into a path. The agent
     already carries the COMMANDER dossier block in its system prompt, so this tells it to USE what it knows, not
     re-state it. It hard-constrains the reply to 3-5 concrete, ordered milestones so parseDecomposition() reads it.
     Deterministic: same goalText → byte-identical directive (mirrors pitch.buildDirective). */
  function buildDirective(goalText) {
    const g = clip(goalText, 280);
    const lines = [];
    lines.push('INTERNAL — GOAL DECOMPOSITION. Do not run any tools. Reason only, then reply in the exact format below.');
    lines.push('Your Commander has this goal: "' + g + '".');
    lines.push('Break it into a clear PATH — the ordered milestones that get them there. Hard rules:');
    lines.push('- Between ' + MIN_MILESTONES + ' and ' + MAX_MILESTONES + ' milestones. Ordered: earliest first, each a real step toward the goal.');
    lines.push('- Each milestone is ONE concrete, achievable outcome — something you could actually help build or do, not a vague theme.');
    lines.push('- Ground them in what you know about this Commander (their stack, pain, world). No generic filler.');
    lines.push('- One per line, numbered. Nothing else — no preamble, no closing note.');
    lines.push('Reply in EXACTLY this format:');
    lines.push('1. <first milestone>');
    lines.push('2. <second milestone>');
    lines.push('3. <third milestone>');
    return lines.join('\n');
  }

  /* parseDecomposition(modelText, opts) → [ text, … ] (3-5 clean milestone strings) or [] when the reply is
     unusable. Applies the value floor, the redaction (opts.redact — secrets scrubbed before a step is stored),
     the per-line cap, and near-exact dedup (a model that repeats a step doesn't double it). Returns AT MOST
     MAX_MILESTONES; returns [] (never a partial tree) when fewer than MIN_MILESTONES survive — an under-
     decomposed goal is not worth a confirm beat, so the caller re-offers only when the belief changes. */
  function parseDecomposition(modelText, opts) {
    opts = opts || {};
    // a host-injected redact runs FIRST (a stronger scrub if available), then the always-on secret floor — so a
    // milestone line is never stored with an obvious key shape even when no redact is injected.
    const inject = typeof opts.redact === 'function' ? opts.redact : (x => x);
    const redact = s => scrubSecrets(inject(s));
    const out = [];
    const seen = new Set();
    for (const ln of String(modelText == null ? '' : modelText).split('\n')) {
      const m = LINE.exec(ln);
      if (!m) continue;
      let text = redact(String(m[1])).trim();
      if (!text) continue;
      if (lowValue(text)) continue;
      text = clip(text, TEXT_CHARS);
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= MAX_MILESTONES) break;
    }
    return out.length >= MIN_MILESTONES ? out : [];
  }

  /* mint a goal tree from a confirmed decomposition. texts = the (edited/confirmed) milestone strings; sourceBeliefId
     binds it to the dossier belief; now = injected clock. Returns the goal node (or null on a too-short path — the
     3-milestone floor is enforced here too, so a hand-edited list can't create a degenerate one-step goal). Ids are
     deterministic: goal id from the injected clock, milestone ids goalId + ':m' + index. */
  function makeGoal(goalText, texts, sourceBeliefId, now, opts) {
    // scrub every milestone text (an edited path from the confirm panel bypasses parseDecomposition, so redact here
    // too) — the always-on secret floor, then cap + value-floor. Redaction can never be skipped on a stored step.
    const clean = (Array.isArray(texts) ? texts : []).map(t => clip(scrubSecrets(t), TEXT_CHARS)).filter(t => t && !lowValue(t)).slice(0, MAX_MILESTONES);
    if (clean.length < (opts && opts.userAuthored ? 1 : MIN_MILESTONES)) return null;
    const id = 'goal_' + now;
    const milestones = clean.map((t, i) => ({ id: id + ':m' + (i + 1), text: t, status: 'open', questRef: null, evidence: '', doneAt: null, journeySyncedAt: null }));
    return { id, text: clip(goalText, 280), sourceBeliefId: sourceBeliefId == null ? null : String(sourceBeliefId), status: 'active', milestones, createdAt: now, updatedAt: now };
  }

  // progress = milestones DONE / TOTAL. Honest: a milestone is done only when its real work quest completed. Returns
  // { done, total, pct } (pct 0..100, integer). An empty/absent goal reads 0/0/0 (never a divide-by-zero).
  function progress(goal) {
    const ms = (goal && Array.isArray(goal.milestones)) ? goal.milestones : [];
    const total = ms.length;
    let done = 0;
    for (const m of ms) if (m && m.status === 'done') done++;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  // the NEXT open milestone (in order) — the one that surfaces as the actionable quest. null when the goal is
  // complete / has none. Only ever returns an OPEN milestone of an ACTIVE goal (a retired/done goal surfaces none).
  function nextMilestone(goal) {
    if (!goal || goal.status !== 'active' || !Array.isArray(goal.milestones)) return null;
    const chosen = goal.milestones.find(m => m && m.id === goal.nextMilestoneId && m.status === 'open');
    if (chosen) return chosen;
    for (const m of goal.milestones) if (m && m.status === 'open') return m;
    return null;
  }

  // Change direction without rewriting the original plan or its completed history.
  // An accepted build must finish or stall before changing the selected next step.
  function chooseNext(goal, milestoneId, now, questLive) {
    if (!goal || goal.status !== 'active' || !Array.isArray(goal.milestones)) return false;
    const next = goal.milestones.find(m => m && m.id === milestoneId && m.status === 'open');
    if (!next || goal.milestones.some(m => m && m.status === 'open' && m.questRef && typeof questLive === 'function' && questLive(m.questRef))) return false;
    goal.nextMilestoneId = next.id;
    goal.updatedAt = now;
    return true;
  }

  // A return briefing is a read of existing records, never a new progress ledger.
  function briefing(goals, questLive) {
    const list = Array.isArray(goals) ? goals : [];
    const goal = activeGoal(list);
    const completedGoal = list.filter(g => g && g.status === 'done').slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
    if (!goal) return { goal: null, completedGoal };
    const next = nextMilestone(goal);
    const latest = goal.milestones.filter(m => m && m.status === 'done').slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0] || null;
    return { goal, next, latest, completedGoal, progress: progress(goal),
      inFlight: !!(next && next.questRef && questLive && questLive(next.questRef)) };
  }

  // is every milestone done? (a goal completes when its whole path is done — foldGoalDone stamps status:'done').
  function allDone(goal) {
    const ms = (goal && Array.isArray(goal.milestones)) ? goal.milestones : [];
    if (!ms.length) return false;
    return ms.every(m => m && m.status === 'done');
  }

  /* bind a real WORK quest to a milestone (in place): the Commander accepted the milestone quest, it routed
     through the work-quest path, and THAT quest's id is recorded here so completing the real work can find and
     complete this milestone. Idempotent; only ever binds an OPEN milestone of an ACTIVE goal. Returns true iff bound. */
  function bindMilestoneQuest(goal, milestoneId, questRef) {
    if (!goal || goal.status !== 'active' || !Array.isArray(goal.milestones)) return false;
    const m = goal.milestones.find(x => x && x.id === milestoneId);
    if (!m || m.status !== 'open') return false;
    m.questRef = questRef == null ? null : String(questRef);
    return true;
  }

  /* FOLD MILESTONE DONE (the honesty core): the milestone's REAL work quest completed. Mark it done, stamp doneAt,
     and WRITE the evidence (a run-summary line — provenance of what actually shipped) onto the node. Idempotent
     (re-folding a done milestone is a no-op). Only advances an OPEN milestone of an ACTIVE goal — a retired goal's
     milestones never move (drift is final). Returns { changed, goalDone } — goalDone true when THIS fold completed
     the last open milestone (the caller then celebrates the whole goal). */
  function foldMilestoneDone(goal, milestoneId, evidence, now) {
    const res = { changed: false, goalDone: false };
    if (!goal || goal.status !== 'active' || !Array.isArray(goal.milestones)) return res;
    const m = goal.milestones.find(x => x && x.id === milestoneId);
    if (!m || m.status !== 'open') return res;
    m.status = 'done';
    m.doneAt = now;
    m.evidence = clip(evidence, EVIDENCE_CHARS);
    goal.updatedAt = now;
    res.changed = true;
    // A completed plan is evidence of actions, not proof that the life outcome happened.
    // The goal remains active until the Commander reports its stored success condition met.
    res.planDone = allDone(goal);
    return res;
  }

  // find the ACTIVE goal whose milestone is bound to a given work-quest id (the store's hook when a work quest
  // completes). Returns { goal, milestone } or null. Only matches OPEN milestones (a done one is already folded).
  function milestoneForQuest(goals, questRef) {
    if (questRef == null) return null;
    const rid = String(questRef);
    for (const g of (Array.isArray(goals) ? goals : [])) {
      if (!g || g.status !== 'active' || !Array.isArray(g.milestones)) continue;
      for (const m of g.milestones) if (m && m.status === 'open' && m.questRef === rid) return { goal: g, milestone: m };
    }
    return null;
  }

  /* RETIRE by source belief (drift propagation): the Study Engine retired the dossier goals-dim belief this tree
     decomposed — the goal itself drifted. Set status:'retired' (kept for history, hidden from the active quest
     log; its milestones never move again). Idempotent; only an ACTIVE goal retires (a done goal stays done — a
     shipped goal isn't "drift"). Returns true iff it flipped an active goal. */
  function retireBySource(goal, sourceBeliefId, now) {
    if (!goal || goal.status !== 'active') return false;
    if (goal.sourceBeliefId == null || String(goal.sourceBeliefId) !== String(sourceBeliefId)) return false;
    goal.status = 'retired';
    goal.updatedAt = now;
    return true;
  }

  /* resolve the confirm-panel choice (the Dialogue node result) into ONE decision — the tested home for the
     Confirm / ✎-Edit / Not-now routing so chat.js stays thin glue. Rules:
       • an explicit Confirm keeps the proposed path as-is.
       • a CUSTOM (edited) reply re-parses the typed text (steps split on ';' or newline, ordinals stripped);
         a valid edit (≥ MIN_MILESTONES steps) confirms the EDITED path (capped at MAX).
       • an edit that parses UNDER the floor is a REJECTION of the model's tree — decline (treat as not-now),
         NEVER silently persist the unedited model path the Commander just tried to replace.
       • anything else (not-now / skip / no choice) declines.
     Returns { action:'confirm'|'decline', path } — path is only meaningful on 'confirm'. */
  function resolveConfirmChoice(choice, path) {
    const orig = Array.isArray(path) ? path.slice() : [];
    if (!choice) return { action: 'decline', path: orig };
    if (choice.custom && typeof choice.value === 'string') {
      const revised = String(choice.value).split(/[;\n]+/).map(l => l.replace(/^\s*\d{1,2}[.)\]:-]?\s+/, '').trim()).filter(Boolean);
      if (revised.length >= MIN_MILESTONES) return { action: 'confirm', path: revised.slice(0, MAX_MILESTONES) };
      return { action: 'decline', path: orig };   // a too-short edit = the Commander rejected the tree — never persist it
    }
    if (choice.value === 'confirm') return { action: 'confirm', path: orig };
    return { action: 'decline', path: orig };
  }

  // the single ACTIVE goal (the quest log surfaces one arc at a time — the most recent active goal). null when
  // none is active. Deterministic: the last active goal by createdAt (a fresh decomposition supersedes an older arc).
  function activeGoal(goals) {
    let best = null;
    for (const g of (Array.isArray(goals) ? goals : [])) {
      if (!g || g.status !== 'active') continue;
      if (!best || (g.focusedAt || g.createdAt || 0) >= (best.focusedAt || best.createdAt || 0)) best = g;
    }
    return best;
  }

  /* PROJECT the active goal into the shared Quests shape (kind 'arc'). Emits a GOAL HEADER (progress meter) plus
     ONE actionable quest for the next OPEN milestone — real chaining: as each milestone folds done, the NEXT open
     one surfaces. Done milestones render as done rows (the trophy shelf of the arc); a fully-done/retired goal
     surfaces nothing here (a completed arc lives in the trophy case, a retired one is history). Deterministic +
     absent-input safe: no active goal → []. The header id 'arc:goal:<id>' and step ids 'arc:step:<mId>' are
     stable so QuestState's open→done fold + dismiss never confuse them. */
  //   opts.questLive(questRef) -> bool (optional): is the milestone's bound work quest still IN FLIGHT (open, not
  //   stalled, not dismissed)? A live-bound front milestone renders IN PROGRESS (no Accept — re-clicking would mint
  //   a duplicate build + a duplicate paid run); a dead/stalled/absent binding re-offers Accept (the recovery path).
  function project(goals, opts) {
    opts = opts || {};
    const questLive = typeof opts.questLive === 'function' ? opts.questLive : (() => false);
    const goal = activeGoal(goals);
    if (!goal) return [];
    const pr = progress(goal);
    const out = [];
    // the GOAL HEADER — a done "quest" only in the sense that it carries the meter; it is never actionable and
    // never dismissible (the arc header isn't a to-do, it's the frame). status mirrors the goal so the panel can
    // group its steps under it. reward names the real outcome (the goal itself).
    out.push({
      id: 'arc:goal:' + goal.id, kind: 'arc-goal', title: '◇ ' + clip(goal.text, 120),
      desc: pr.total ? (pr.done + ' of ' + pr.total + ' planned steps completed') : 'no planned steps',
      reward: 'the goal, reached', status: 'open', arcGoalId: goal.id, pct: pr.pct, done: pr.done, total: pr.total
    });
    const next = nextMilestone(goal);
    for (const m of goal.milestones) {
      if (!m) continue;
      const isDone = m.status === 'done';
      const isNext = next && m.id === next.id;
      // an ACCEPTED front milestone whose bound work quest is still in flight is IN PROGRESS — visible, honest,
      // but NOT re-acceptable (a second Accept would double-mint the build and double-spend a paid run).
      const inFlight = !isDone && isNext && !!m.questRef && !!questLive(m.questRef);
      // One selected next step is offered for execution; the Commander can select a different
      // open step without changing the original plan order or its completed history.
      const status = isDone ? 'done' : (isNext ? 'open' : 'open');
      out.push({
        id: 'arc:step:' + m.id, kind: 'arc-step', title: (isDone ? 'done — ' : (isNext ? '▸ ' : '· ')) + clip(m.text, 120),
        desc: isDone ? ('done.' + (m.evidence ? ' ' + m.evidence : ''))
          : inFlight ? 'in progress — the build is running; finishing it completes this step.'
          : (isNext ? 'the next step — do it yourself or ask StarNet for help.' : 'another planned step — you can choose it next in Goals.'),
        reward: 'progress on “' + clip(goal.text, 60) + '”', status,
        arcGoalId: goal.id, milestoneId: m.id, isNext: !!isNext, inFlight: inFlight
      });
    }
    return out;
  }

  return {
    buildDirective, parseDecomposition, makeGoal, progress, nextMilestone, chooseNext, briefing, allDone,
    bindMilestoneQuest, foldMilestoneDone, milestoneForQuest, retireBySource, activeGoal, project, lowValue, scrubSecrets, resolveConfirmChoice,
    MIN_MILESTONES, MAX_MILESTONES, TEXT_CHARS
  };
});
