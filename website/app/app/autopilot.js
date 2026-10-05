/* STARNET — autopilot.js : the PURE engine for the IDLE SELF-DIRECTION DRIVER (autonomy layer, Slice A).

   This is the missing CONSUMER of the autonomy posture. Slices 1–2 shipped the dial (autonomy.js) and cron
   self-initiation (autojobs.js), but nothing read the posture to actually drive idle behaviour — so the dial had
   no effect on the floor. This engine closes that: when the Commander goes idle, it decides what the station
   should do on its own, GATED by the dial AND by how well it actually knows the Commander.

   THE DECISION (pure + deterministic; the live clock, the dossier reads, and the curiosity hand-off live in the
   thin store, autopilotstore.js):

     idle + posture →  EARN  (learn one thing — ask a gentle get-to-know-you question)
                  or   ACT   (do a small reason/draft job toward their goals)      ← Slice A2
                  or   none

   THE CONFIDENCE FLOOR (the anti-slop heart): an idle agent that confidently does the WRONG work is worse than
   one that does nothing — the first autonomous deliverable sets trust forever. So ACTING is EARNED, not just
   permitted. readiness() reads the (confirmed-only, never-inferred) dossier — breadth, the required dim, and
   recency — into a tier; decide() acts only when the dial permits AND the tier is hot; otherwise it EARNS more
   context first (the flywheel: when it doesn't know enough to act, it acts to know more).

   THE GOVERNING RULE — ceiling vs earned: the dial is the ceiling the Commander PERMITS; the tier is the level the
   station has EARNED; it operates at the LOWER of the two and names which is BINDING (legibility — "you set me
   free, but i'm still learning you, so here's a question instead of a guess"). WAIT means nothing, ever.

   PURE + node-testable, mirroring autonomy.js / autojobs.js / pitch.js: an `Autopilot` global in the browser,
   module.exports under node. NO Date.now / Math.random — a decision is a deterministic function of (posture,
   idleness, dossier-readiness). The store injects the clock. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Autopilot = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // edge defaults (consumed by the store's clock/timer wiring — just numbers, so they live with the engine).
  const DEFAULT_IDLE_MS = 120000;   // "stepped away" = no interaction for 2 minutes
  const DEFAULT_TICK_MS = 20000;    // how often the store re-checks idleness

  // the readiness floor constants. goals is the keystone dim (you can't usefully act without knowing what they
  // want); the breadth bars mirror the existing self-initiation gate (goals + ≥2 known = the propose floor).
  const REQUIRE_DIM = 'goals';
  const WARM_MIN = 2;               // goals usable + this many usable dims → warm (may propose / earn)
  const HOT_MIN = 4;                // goals usable + this many usable dims → hot  (has EARNED the right to act)
  const STALE_MS = 1000 * 60 * 60 * 24 * 45;   // a belief older than ~45 days is stale: still known, but too old to ground ACTING on

  // is the clock idle? (now - lastActivity ≥ the idle span). A bad/unknown clock is never idle (fail safe).
  function idleFor(now, lastActivity, idleMs) {
    if (!Number.isFinite(now) || !Number.isFinite(lastActivity)) return false;
    const span = Number.isFinite(idleMs) ? idleMs : DEFAULT_IDLE_MS;
    return (now - lastActivity) >= span;
  }

  // newest timestamp across a dimension's beliefs (updatedAt, falling back to createdAt). 0 = undated.
  function newestStamp(beliefs) {
    let mx = 0;
    for (const b of (Array.isArray(beliefs) ? beliefs : [])) {
      const t = Number(b && b.updatedAt) || Number(b && b.createdAt) || 0;
      if (t > mx) mx = t;
    }
    return mx;
  }

  // ACTIVITY-AS-GROUNDING (NS-2): with the context pack, a "cold dossier" no longer means the station can do
  // nothing. If the Commander has been visibly working — enough recent USER-INITIATED runs (real evidence of what
  // he's doing) — the station has honest grounding to act on that work even before the six dossier dims are filled.
  // These bars are deliberately CONSERVATIVE (activity must be substantial, not a single stray run) and the grant is
  // capped at HOT so heavy activity can license real acting, exactly as a full dossier does. It is a SEPARATE path,
  // never a discount on the dossier bars — a thin-activity night still falls back to the dossier tier.
  const ACTIVITY_WARM_MIN = 2;      // ≥ this many recent user runs → the station has enough to usefully PROPOSE
  const ACTIVITY_HOT_MIN = 4;       // ≥ this many recent user runs → the station has EARNED the right to ACT on it

  // READINESS — derive the confidence tier, purely. TWO grounding paths, take the HIGHER:
  //   (a) DOSSIER — a dim is USABLE iff known AND its freshest belief is not stale (recency gates acting). An undated
  //       belief (legacy/seeded) counts as fresh — never punish an old save. goals is the keystone; breadth sets warm/hot.
  //   (b) ACTIVITY (NS-2) — substantial recent user-run activity is its own grounding: it directly evidences the work
  //       the Commander is doing, so a brand-new-dossier user who is heavily active gets useful beats, not endless
  //       get-to-know-you stand-downs. Conservative bars; capped at HOT. opts.activityCount (a count the caller derives
  //       from the context pack's user-run evidence) drives it; 0/absent → this path contributes nothing (pure dossier).
  //   dossierSummary — DossierStore.summary() shape: { known:[dim], familiarity:0..1, ... }
  //   beliefsByDim   — fn(dim)->[belief] OR a { dim:[belief] } map (each belief carries updatedAt/createdAt)
  //   opts.activityCount — count of recent user-initiated runs (grounding evidence); default 0
  function readiness(dossierSummary, beliefsByDim, now, opts) {
    opts = opts || {};
    const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : STALE_MS;
    const sum = dossierSummary || {};
    const known = Array.isArray(sum.known) ? sum.known : [];
    const get = (dim) => {
      if (typeof beliefsByDim === 'function') { try { return beliefsByDim(dim) || []; } catch (_) { return []; } }
      if (beliefsByDim && typeof beliefsByDim === 'object') return beliefsByDim[dim] || [];
      return [];
    };
    const usableDims = [], staleDims = [];
    for (const dim of known) {
      const newest = newestStamp(get(dim));
      const fresh = !newest || !Number.isFinite(now) || (now - newest) <= staleMs;
      (fresh ? usableDims : staleDims).push(dim);
    }
    const goalsUsable = usableDims.indexOf(REQUIRE_DIM) >= 0;
    let dossierTier = 'cold';
    if (goalsUsable && usableDims.length >= HOT_MIN) dossierTier = 'hot';
    else if (goalsUsable && usableDims.length >= WARM_MIN) dossierTier = 'warm';

    // the ACTIVITY path (NS-2): a conservative tier derived purely from recent user-run count.
    const activityCount = Math.max(0, Math.floor(Number(opts.activityCount) || 0));
    let activityTier = 'cold';
    if (activityCount >= ACTIVITY_HOT_MIN) activityTier = 'hot';
    else if (activityCount >= ACTIVITY_WARM_MIN) activityTier = 'warm';

    // take the HIGHER of the two (either grounding suffices); name which one licensed acting, for honest telemetry.
    const rank = { cold: 0, warm: 1, hot: 2 };
    const tier = rank[activityTier] > rank[dossierTier] ? activityTier : dossierTier;
    const groundedBy = tier === 'cold' ? null : (rank[activityTier] > rank[dossierTier] ? 'activity' : 'dossier');
    return {
      tier, dossierTier, activityTier, groundedBy, activityCount, goalsUsable, usableDims, staleDims,
      familiarity: Number.isFinite(sum.familiarity) ? sum.familiarity : 0
    };
  }

  // THE DECISION. Returns { go, mode:'act'|'earn'|'none', reason, binding } — binding names what holds ACT back
  // (for the honest "still learning you" line), or null when nothing does. Order: WAIT short-circuits to nothing;
  // an active (non-idle) station does nothing; otherwise it ACTS only when the dial permits acting AND the tier is
  // hot AND there's daily budget — else it EARNS context, naming the limiting axis.
  //   enabled        — posture initiative ≥ propose (AutonomyStore.summary().enabled)
  //   actsUnattended — posture initiative ≥ leash    (AutonomyStore.summary().actsUnattended) → the dial permits acting
  //   idle           — Autopilot.idleFor(...)
  //   tier           — readiness().tier
  //   budgetLeft     — remaining leash actions today (omit/Infinity in Slice A1 — the earn branch isn't budgeted)
  function decide(state) {
    state = state || {};
    if (!state.enabled) return { go: false, mode: 'none', reason: 'disabled', binding: null };
    if (!state.idle) return { go: false, mode: 'none', reason: 'active', binding: null };
    const canActDial = !!state.actsUnattended;
    const canActConfidence = state.tier === 'hot';
    const hasBudget = !Number.isFinite(state.budgetLeft) || state.budgetLeft > 0;
    if (canActDial && canActConfidence && hasBudget) return { go: true, mode: 'act', reason: 'ready', binding: null };
    // not act-ready → earn one piece of context, and name what's keeping it from acting (legibility / the flywheel).
    let binding = null;
    if (!canActDial) binding = 'dial';                 // the Commander hasn't dialled it up to acting yet
    else if (!canActConfidence) binding = 'confidence'; // it's allowed to act, but doesn't know them well enough
    else if (!hasBudget) binding = 'budget';            // allowed + confident, but today's leash is spent
    return { go: true, mode: 'earn', reason: 'earn', binding: binding };
  }

  /* ============================ THE ACT BRANCH — anti-slop selection pipeline (Slice A2) ============================
     When decide() returns 'act', the store runs this pure pipeline (the model fills two narrow slots — propose
     candidates, then do the chosen one; everything structural is here): eligibility → a candidate directive →
     a strict parse with the GROUNDING VETO → deterministic score-and-pick-best with a CONFIDENCE GATE → a do
     directive → a tolerant deliverable parse. Anti-slop is the whole game: a candidate that doesn't cite something
     the station actually knows never exists, and if nothing clears the confidence bar the station does NOTHING
     (idle-doing-nothing beats shipping slop). Only score-based selection lets a future LEARN loop re-weight per
     user — the uncopyable moat — so selection is a score, with a FIXED tie-break for predictability. */

  // the five task archetypes (LOCKED). Each is grounded in ONE dossier dimension — no usable belief in that dim,
  // no candidate of that kind. ARRAY ORDER is the tie-break precedence (advance › kill-pain › prep › maintain ›
  // scout) used when scores are close.
  const ARCHETYPES = [
    // NOTE (2026-08-15): the BLURBS teach the shift what shape of work to propose, and two of them used to say
    // "draft" — so "draft a tool for it" / "research / draft / stage" invited a document about the job instead of
    // the job. The ids are LEARN-STORE KEYS and persisted per Commander; never rename them, only the prose.
    { id: 'advance-goal',    dim: 'goals', blurb: 'take the next concrete step toward a goal' },
    { id: 'kill-pain',       dim: 'pain',  blurb: 'chip away at a pain point — build the thing that removes it' },
    { id: 'prep-next',       dim: 'goals', blurb: 'research or stage something they will need soon' },
    { id: 'maintain-extend', dim: 'goals', blurb: 'improve or extend a prior piece of work' },
    { id: 'scout',           dim: 'stack', blurb: 'watch / scout something in their stack' }
  ];
  const CANDIDATE_MAX = 4;          // ask for a few typed candidates, then pick the best — never act on the first idea
  const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
  const MIN_ACT_SCORE = 2;          // the confidence gate: nothing scoring below this acts (low-confidence → stay silent)
  const STOPWORDS = { about: 1, there: 1, their: 1, would: 1, could: 1, should: 1, which: 1, where: 1, while: 1, these: 1, those: 1, after: 1, before: 1, every: 1, other: 1, thing: 1, things: 1, stuff: 1, really: 1, around: 1 };

  // which archetypes can even be proposed, given which dims are USABLE grounding (from readiness().usableDims). When
  // the grounding is ACTIVITY rather than the dossier (NS-2: opts.activityGrounded), the per-dim gate does not apply
  // — the candidate grounds on a real recent run/chat line, not a dossier dim, and the grounding VETO (over the
  // activity evidence pool) still enforces honesty. So an activity-grounded station may propose ANY archetype; the
  // veto, not the dim map, is what keeps it honest. Default (no flag) is unchanged: dossier-dim eligibility.
  function eligibleArchetypes(usableDims, opts) {
    opts = opts || {};
    if (opts.activityGrounded) return ARCHETYPES.slice();
    const u = Array.isArray(usableDims) ? usableDims : [];
    return ARCHETYPES.filter(a => u.indexOf(a.dim) >= 0);
  }

  // significant tokens of a string (lowercased words ≥5 chars, minus a few stopwords) — the basis of the grounding
  // check. Deterministic and dependency-free; a structural floor, NOT a semantic judge.
  function sigTokens(s) {
    const out = {};
    for (const w of String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (w.length >= 5 && !STOPWORDS[w]) out[w] = 1;
    }
    return out;
  }
  // is `grounds` actually anchored in something the station knows? True iff it substring-matches a belief (either
  // direction, normalized) OR shares ≥1 significant token with one. Catches invented grounding (zero overlap) while
  // tolerating paraphrase. beliefTexts = a flat array of belief strings.
  function grounded(grounds, beliefTexts) {
    const g = String(grounds == null ? '' : grounds).toLowerCase().trim();
    if (!g) return false;
    const texts = Array.isArray(beliefTexts) ? beliefTexts : [];
    const gTok = sigTokens(g);
    for (const raw of texts) {
      const b = String(raw == null ? '' : raw).toLowerCase().trim();
      if (!b) continue;
      if (b.indexOf(g) >= 0 || g.indexOf(b) >= 0) return true;
      const bTok = sigTokens(b);
      for (const w in gTok) if (bTok[w]) return true;
    }
    return false;
  }

  // flatten a { dim:[texts] } beliefs map (or pass an array through) to a single belief-text array.
  function flattenBeliefs(beliefs) {
    if (Array.isArray(beliefs)) return beliefs.filter(Boolean);
    const out = [];
    if (beliefs && typeof beliefs === 'object') for (const k in beliefs) for (const t of (beliefs[k] || [])) if (t) out.push(t);
    return out;
  }

  // the RECENT-ACTIVITY block (NS-2) — dated lines of what the Commander ACTUALLY did lately (from the context
  // pack: recent runs, chats, the goal arc, kept/discarded work). Pushed into the directive so proposals aim at
  // REAL current work, not a static personality sketch. Returns whether any activity was rendered (so the directive
  // can add the "aim at their recent work" rule only when there IS recent work — never inviting fabrication). Pure.
  function pushActivityBlock(lines, activity) {
    const act = Array.isArray(activity) ? activity.filter(Boolean).map(String) : [];
    if (!act.length) return false;
    lines.push('What they worked on recently (aim your ideas at THIS — continue, unblock, or extend it):');
    for (const l of act) lines.push('- ' + l);
    return true;
  }

  // the OPEN-THREADS block (NS-6) — durable ideas the Commander raised before but never acted on (from the thread
  // ledger, injected via the context pack). Each gets a citable tag [tN] so a candidate can name EXACTLY which
  // thread it advances (the preferred grounding — beats a fresh improv idea, and lets the beat verdict write the
  // thread's state back to picked/delivered/declined). Returns whether any thread was rendered (so the directive
  // only adds the "prefer a thread" rule when there ARE threads — never inviting a fabricated citation). Pure.
  //   threads: [{ id, title, spec }]  (already recency-ranked + capped by the caller)
  function threadRef(i) { return 't' + (i + 1); }
  function pushThreadsBlock(lines, threads) {
    const list = Array.isArray(threads) ? threads.filter(Boolean) : [];
    if (!list.length) return false;
    lines.push('OPEN THREADS — ideas the Commander raised before but never acted on. PREFER these: if one fits, propose it and cite its tag (e.g. [t1]) in GROUNDS:');
    list.forEach((t, i) => {
      const title = String((t && t.title) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const spec = String((t && t.spec) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (title) lines.push('- [' + threadRef(i) + '] ' + title + (spec ? ' — "' + spec + '"' : ''));
    });
    return true;
  }
  // resolve a GROUNDS string to a cited thread id (for the picked/delivered writeback): an explicit [tN] tag wins;
  // else a thread whose TITLE appears (either direction, normalized) in the grounds. null when nothing is cited.
  function citedThreadId(grounds, threads) {
    const list = Array.isArray(threads) ? threads.filter(Boolean) : [];
    if (!list.length) return null;
    const g = String(grounds == null ? '' : grounds);
    const tag = /\[\s*t(\d+)\s*\]/i.exec(g);
    if (tag) { const idx = parseInt(tag[1], 10) - 1; if (idx >= 0 && idx < list.length && list[idx] && list[idx].id) return String(list[idx].id); }
    const gl = g.toLowerCase();
    for (const t of list) { const title = String((t && t.title) || '').toLowerCase().trim(); if (title && (gl.indexOf(title) >= 0 || title.indexOf(gl) >= 0) && t.id) return String(t.id); }
    return null;
  }

  // NS-5b: the FOCUS block — a single-priority night leads with ONE declared focus (nightfocus.js) + its cited
  // evidence, and every candidate must ADVANCE it (the compounding shape, not three unrelated drafts). focusHeader
  // is the already-composed "TONIGHT'S FOCUS: <label> — because <evidence>" line (server passes nightfocus.focusLine).
  // Returns whether a focus was rendered (so the Hard-rules add the "stay on focus" clause only when there IS one).
  function pushFocusBlock(lines, focusHeader) {
    const h = String(focusHeader == null ? '' : focusHeader).trim();
    if (!h) return false;
    lines.push(h);
    lines.push('This is the ONE thing to move tonight. Everything you propose must ADVANCE this focus — extend, unblock, or refine it — never start something unrelated. If truly nothing here can advance it, say so and propose the closest grounded step.');
    return true;
  }
  // NS-5b: the PROJECT SNAPSHOT block — a bounded, harness-read view of the focused project (git status/log/diff +
  // TODO/FIXME), so the beat proposes against the REAL current state of the repo, not a guess. snapshot is the
  // already-bounded text from projectscan.js (the server reads the blessed root; the model never improvises the read).
  function pushSnapshotBlock(lines, snapshot) {
    const s = String(snapshot == null ? '' : snapshot).trim();
    if (!s) return false;
    lines.push(s);
    return true;
  }
  // NS-5b: same-night COMPOUNDING — the titles/summaries earlier beats produced THIS night, so beat 2+ EXTENDS the
  // same work instead of restarting. priorTonight is a small array of one-line summaries (server: tonight's drafts).
  function pushPriorTonight(lines, prior) {
    const list = Array.isArray(prior) ? prior.filter(Boolean) : [];
    if (!list.length) return false;
    lines.push('WHAT YOU ALREADY PRODUCED TONIGHT ON THIS FOCUS (build ON these — extend/deepen, do NOT repeat):');
    for (const p of list.slice(0, 6)) lines.push('- ' + String(p).replace(/\s+/g, ' ').trim().slice(0, 160));
    return true;
  }
  // PRIOR BUILDS (2026-10-05 audit item 1): what earlier NIGHTS already built/drafted for this focus (last ~14 days,
  // each with its status + where its files live — server: priorwork.promptLines). Without it the same prototype was
  // rebuilt night after night. The host ALSO vetoes near-duplicates (priorwork.veto); this block is the courtesy that
  // lets the model propose the continuation itself. Returns whether anything was rendered.
  function pushPriorBuilds(lines, prior) {
    const list = Array.isArray(prior) ? prior.filter(Boolean) : [];
    if (!list.length) return false;
    lines.push('ALREADY BUILT ON EARLIER NIGHTS (last 14 days) — continue or improve these, do NOT rebuild them:');
    for (const p of list.slice(0, 12)) lines.push('- ' + String(p).replace(/\s+/g, ' ').trim().slice(0, 220));
    return true;
  }
  // the CONTINUE block for a do directive: the selected job iterates on an earlier build instead of starting over.
  //   cont: { title, where, files:[path], summary, seeded }  (seeded = the host already copied its files into dir)
  function pushContinueBlock(lines, cont, dir) {
    if (!cont || !String(cont.title || '').trim()) return false;
    const files = (Array.isArray(cont.files) ? cont.files : []).filter(Boolean).slice(0, 20);
    // seeded: name only the NEW dir (one unambiguous place to work); otherwise point at where the old files live.
    lines.push('CONTINUE, DO NOT RESTART: this job builds on your earlier build "' + String(cont.title).trim().slice(0, 120) + '"'
      + (!(cont.seeded && dir) && cont.where ? ' (' + String(cont.where).trim() + ')' : '') + '.'
      + (cont.seeded && dir ? ' Its files are ALREADY COPIED into "' + dir + '/" — open them, keep what works, and improve them in place.'
        : (cont.where && cont.where !== 'desk draft' ? ' Read its files there first, then write the improved, complete version.' : ' Extend and improve that earlier draft rather than starting a new one.')));
    if (files.length) lines.push('- its files: ' + files.join(', '));
    if (String(cont.summary || '').trim()) lines.push('- what it was: ' + String(cont.summary).replace(/\s+/g, ' ').trim().slice(0, 240));
    return true;
  }

  // THE CANDIDATE DIRECTIVE — the reason-only task that asks the model for a few grounded, achievable-now job ideas
  // (it carries the dossier in its live system prompt; this hands the beliefs + the recent activity + the eligible
  // archetypes explicitly so a weak model can't miss them, and hard-constrains output to the reason/draft envelope
  // + a strict tagged format).
  //   ctx: { beliefs:{dim:[texts]}, activity:[line], eligible:[archetype], max }
  function buildCandidateDirective(ctx) {
    ctx = ctx || {};
    const beliefs = (ctx.beliefs && typeof ctx.beliefs === 'object') ? ctx.beliefs : {};
    const eligible = (Array.isArray(ctx.eligible) && ctx.eligible.length) ? ctx.eligible : ARCHETYPES;
    const max = Number.isFinite(ctx.max) ? ctx.max : CANDIDATE_MAX;
    const lines = [];
    lines.push('INTERNAL — SELF-DIRECTED WORK. The Commander is away. Do not run any tools. Reason only, then reply in the exact format below.');
    const hasFocus = pushFocusBlock(lines, ctx.focusHeader);
    lines.push('Propose up to ' + max + ' small jobs you could do RIGHT NOW, unattended, to help them — then you will be asked to do the single best one and leave a draft on their desk.');
    const hasThreads = pushThreadsBlock(lines, ctx.threads);
    const hasActivity = pushActivityBlock(lines, ctx.activity);
    pushSnapshotBlock(lines, ctx.projectSnapshot);
    pushPriorTonight(lines, ctx.priorTonight);
    const hasPrior = pushPriorBuilds(lines, ctx.priorBuilds);
    const dimLine = (key, label) => { const arr = Array.isArray(beliefs[key]) ? beliefs[key].filter(Boolean) : []; if (arr.length) lines.push('- ' + label + ': ' + arr.join(' | ')); };
    lines.push('What you know about them:');
    dimLine('goals', 'Goals'); dimLine('pain', 'Pain points'); dimLine('ambition', 'Ambitions'); dimLine('stack', 'Stack & tools'); dimLine('standing_orders', 'Standing orders'); dimLine('style', 'Working style'); dimLine('people', 'People & audience (who the work is for)'); dimLine('schedule', 'Schedule & cadence (when work should land)');
    lines.push('Each job must be ONE of these kinds: ' + eligible.map(a => a.id + ' (' + a.blurb + ')').join(', ') + '.');
    lines.push('Hard rules:');
    if (hasFocus) lines.push('- STAY ON FOCUS: the single best job MUST advance TONIGHT\'S FOCUS above. A job that wanders off it is worse than a smaller job that moves it.');
    if (hasPrior) lines.push('- NO REBUILDS: never propose a job that re-makes one of the ALREADY BUILT items above. To work on one, title the job "Continue: <its title>" and say in SPEC what you will improve. Prefer continuing the newest UNDECIDED build over starting something new.');
    if (hasThreads) lines.push('- PREFER AN OPEN THREAD: if any thread above fits, propose it and cite its tag in GROUNDS (e.g. GROUNDS: [t1] ...). A grounded open thread beats a fresh idea. If none fit, improvise a grounded idea as below.');
    if (hasActivity) lines.push('- CONTINUE THEIR WORK: prefer a job that directly advances, unblocks, or extends something in "What they worked on recently" above — that beats a generic idea. But stay HONEST: only cite work that is actually listed; never invent activity.');
    lines.push('- GROUNDED: every job must aim at a SPECIFIC thing above (an open thread / a real recent job / goal / pain / etc). Quote the exact thing in GROUNDS. If you cannot ground it in something you actually know or they actually did, do not propose it.');
    lines.push('- ACHIEVABLE NOW, UNATTENDED: NO tools, NO web, NO file writes, NO sending. It must be REASONING / DRAFTING / PLANNING you can finish from what you know and leave as a draft. Never propose searching, fetching, posting, or messaging.');
    lines.push('- HONEST CONFIDENCE: rate how sure you are it is genuinely useful AND that you can do it well now (high/medium/low). Low is fine — it is better to admit it than to pad.');
    lines.push('Reply with one block PER job, EXACTLY this format, nothing else:');
    lines.push('JOB: <short title, a few words>');
    lines.push('KIND: <one id from the list>');
    lines.push('GROUNDS: <the exact goal/pain/etc this serves — quote what you know>');
    lines.push('CONFIDENCE: <high | medium | low>');
    lines.push('SPEC: <one line — exactly what the finished draft will contain (your own done-check)>');
    return lines.join('\n');
  }

  /* ---- THE FOCUS-ADVANCEMENT VETO (2026-10-05 audit item 3) ----
     A declared night focus used to be PROMPT-ONLY: the directive said "everything must advance TONIGHT'S FOCUS", but
     nothing checked, so a candidate about something else entirely was selected and built under the focus banner.
     When a focus is declared, a candidate now survives only if its text (title + grounds + spec) shares at least one
     significant token with the focus's own evidence — its label, its ref's name, its cited why-lines, plus any extra
     evidence the host hands in (the harness-read project snapshot for a project focus). Deliberately LENIENT: one
     shared word is enough, and a candidate citing the focus thread's own id always passes. The words the resolver's
     why-line TEMPLATES are made of ("you worked in … last touched today", "an open thread you raised …") are not
     evidence and are excluded, otherwise every candidate mentioning "repo" or "today" would pass for free. */
  const FOCUS_STOP = {};
  ('the and for with that this from into onto your you yours are was were has have had not can will just than then '
    + 'them they their there what when where which while who how why its our out over also only very more most '
    + 'worked work working last touched today yesterday ago git repo read patch recent run runs point points open thread '
    + 'threads raised never acted quest quests beat advance slate active goal arc done next step confirmed north star '
    + 'asked ask focus outranks picked pick tonight night times time separate day days workflow keep keeps seen '
    + 'commander because would could should about every other thing things stuff really around').split(/\s+/).forEach(w => { if (w) FOCUS_STOP[w] = 1; });
  function focusStem(w) { return (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) ? w.slice(0, -1) : w; }
  function focusTokens(s) {
    const out = {};
    for (const w of String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (w.length < 3 || FOCUS_STOP[w] || STOPWORDS[w] || /^\d+$/.test(w)) continue;
      out[focusStem(w)] = 1;
    }
    return out;
  }
  function focusRefName(focus) {
    const ref = String((focus && focus.ref) || '');
    if (!focus || focus.kind !== 'project') return '';
    const t = ref.replace(/[\\/]+$/, '');
    const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
    return i >= 0 ? t.slice(i + 1) : t;
  }
  // the focus's evidence texts (label, ref name, why lines) + host extras. Pure.
  function focusEvidenceTexts(focus, extra) {
    const out = [];
    if (focus && typeof focus === 'object') {
      if (focus.label) out.push(String(focus.label));
      const rn = focusRefName(focus); if (rn) out.push(rn);
      for (const w of (Array.isArray(focus.why) ? focus.why : [])) if (w) out.push(String(w));
    }
    for (const e of (Array.isArray(extra) ? extra : [])) if (e) out.push(String(e));
    return out;
  }
  // does candidate `cand` advance `focus`? true when no focus is declared (nothing to check against).
  function advancesFocus(cand, focus, extraEvidence) {
    if (!focus || typeof focus !== 'object' || !(focus.label || focus.ref)) return true;
    const c = cand || {};
    if (focus.kind === 'thread' && c.threadId && String(c.threadId) === String(focus.ref || focus.threadId || '')) return true;
    const text = [c.title, c.grounds, c.spec].filter(Boolean).join(' ');
    const lower = text.toLowerCase();
    const label = String(focus.label || '').toLowerCase().trim();
    if (label.length >= 3 && lower.indexOf(label) >= 0) return true;
    const cTok = focusTokens(text);
    const fTok = focusTokens(focusEvidenceTexts(focus, extraEvidence).join(' . '));
    for (const w in cTok) if (fTok[w]) return true;
    return false;
  }

  // parse the candidate reply, tolerantly + with the GROUNDING VETO. Keeps a candidate only with a title, an
  // eligible KIND, a non-empty SPEC, and GROUNDS that is actually anchored in the provided EVIDENCE (structure
  // overrules the model). NS-2 widens the evidence pool: a candidate's GROUNDS may cite a static dossier BELIEF OR a
  // recent-ACTIVITY line (a real run/chat/goal/landed-work line from the context pack) — the token-overlap mechanics
  // are unchanged, so invented grounding (zero overlap with EITHER pool) still dies. opts: { eligible:[archetype],
  // beliefs (map|array), activity:[line], requireGrounding:true, focus?:{kind,ref,label,why}, focusEvidence?:[line],
  // onDrop?:(cand, reason) }. With `focus`, the FOCUS veto (advancesFocus) also applies.
  function parseCandidates(text, opts) {
    opts = opts || {};
    const eligibleIds = {};
    for (const a of (Array.isArray(opts.eligible) && opts.eligible.length ? opts.eligible : ARCHETYPES)) eligibleIds[a.id] = 1;
    const activityTexts = Array.isArray(opts.activity) ? opts.activity.filter(Boolean).map(String) : [];
    // NS-6: open threads are veto evidence too — a candidate may ground itself in a thread's title/spec (or its
    // [tN] tag). Adding the thread texts to the pool means a thread-cited candidate passes the token-overlap veto,
    // and citedThreadId() below resolves WHICH thread (for the picked/delivered writeback). Invented grounding
    // (zero overlap with beliefs, activity, OR threads, and no valid tag) still dies.
    const threads = Array.isArray(opts.threads) ? opts.threads.filter(Boolean) : [];
    const threadTexts = [];
    for (const t of threads) { if (t && t.title) threadTexts.push(String(t.title)); if (t && t.spec) threadTexts.push(String(t.spec)); }
    const beliefTexts = flattenBeliefs(opts.beliefs).concat(activityTexts).concat(threadTexts);   // the veto evidence pool
    const requireGrounding = opts.requireGrounding !== false;
    const raw = String(text == null ? '' : text);
    const grab = (block, label) => { const m = new RegExp('^\\s*' + label + '\\s*:\\s*(.+?)\\s*$', 'im').exec(block); return m ? m[1].trim() : ''; };
    const parts = raw.split(/(?=^\s*JOB\s*:)/im).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const block of parts) {
      const title = grab(block, 'JOB');
      const kind = grab(block, 'KIND').toLowerCase();
      const grounds = grab(block, 'GROUNDS');
      const spec = grab(block, 'SPEC');
      if (!title || !grounds || !spec) continue;                 // structure: all three are mandatory
      if (!eligibleIds[kind]) continue;                          // an ineligible / hallucinated kind is dropped
      // NS-6: an explicit [tN] tag that resolves to a real open thread is grounding on its own (the preferred
      // grounding); otherwise the token-overlap veto (now including thread texts) decides.
      const threadId = citedThreadId(grounds, threads);
      if (requireGrounding && !threadId && !grounded(grounds, beliefTexts)) continue;   // the grounding veto: invented grounding never survives
      let conf = grab(block, 'CONFIDENCE').toLowerCase();
      if (conf !== 'high' && conf !== 'medium' && conf !== 'low') conf = 'medium';
      const cand = { title: title.slice(0, 80), archetype: kind, grounds, confidence: conf, spec };
      if (threadId) cand.threadId = threadId;
      // the FOCUS veto (host-enforced, not prompt-only): with a declared focus, an off-focus candidate never survives.
      if (opts.focus && !advancesFocus(cand, opts.focus, opts.focusEvidence)) {
        if (typeof opts.onDrop === 'function') { try { opts.onDrop(cand, 'off-focus'); } catch (_) {} }
        continue;
      }
      out.push(cand);
    }
    return out;
  }

  // SCORE-AND-PICK-BEST + the CONFIDENCE GATE. Score is dominated by confidence (the slot a future LEARN loop
  // re-weights); ties break by the fixed ARCHETYPES order. If the best clears MIN_ACT_SCORE it is selected; else
  // nothing acts (downgrade to silence — the anti-slop refusal). Returns { selected, score, reason, dropped }.
  function scoreAndSelect(candidates, opts) {
    opts = opts || {};
    const minScore = Number.isFinite(opts.minScore) ? opts.minScore : MIN_ACT_SCORE;
    const weights = (opts.weights && typeof opts.weights === 'object') ? opts.weights : {};   // per-user LEARN bias (A3)
    const list = Array.isArray(candidates) ? candidates.slice() : [];
    if (!list.length) return { selected: null, score: 0, reason: 'no-candidates', dropped: 0 };
    const order = {}; ARCHETYPES.forEach((a, i) => { order[a.id] = i; });
    const rawConf = (c) => CONFIDENCE_RANK[c.confidence] || 1;
    // SELECTION score = confidence + a small per-user LEARN bias (re-weighting over time is the uncopyable moat).
    // The bias is capped BELOW a confidence step, so learning sways ties / near-ties but never promotes a
    // low-confidence idea — the confidence GATE below always reads RAW confidence, so learning can't let slop through.
    const selScore = (c) => rawConf(c) + (Number(weights[c.archetype]) || 0);
    let best = list[0];
    for (const c of list) {
      const s = selScore(c), bs = selScore(best);
      if (s > bs) best = c;
      else if (s === bs && (order[c.archetype] != null ? order[c.archetype] : 99) < (order[best.archetype] != null ? order[best.archetype] : 99)) best = c;
    }
    if (rawConf(best) < minScore) return { selected: null, score: rawConf(best), reason: 'low-confidence', dropped: list.length };
    return { selected: best, score: selScore(best), reason: 'selected', dropped: list.length - 1 };
  }

  // THE DO DIRECTIVE — the reason-only task that actually does the selected job and ends with a titled draft.
  //   selected: a candidate { title, archetype, grounds, spec }; ctx: { name }
  function buildDoDirective(selected, ctx) {
    selected = selected || {}; ctx = ctx || {};
    const lines = [];
    lines.push('INTERNAL — SELF-DIRECTED WORK. The Commander is away. Do not run any tools. Reason only, then reply in the exact format below.');
    pushFocusBlock(lines, ctx.focusHeader);
    pushContinueBlock(lines, ctx.continueFrom, '');
    lines.push('Do this ONE job now and leave a finished draft on their desk:');
    lines.push('- JOB: ' + String(selected.title || '').trim());
    if (selected.grounds) lines.push('- WHY IT MATTERS TO THEM: ' + String(selected.grounds).trim());
    if (selected.spec) lines.push('- DONE WHEN: ' + String(selected.spec).trim());
    lines.push('Rules: REASONING / DRAFTING only — no tools, no web, no file writes, no sending. Finish it completely from what you know; if a piece genuinely needs info you do not have, draft around it and flag the gap rather than guessing.');
    lines.push('Reply EXACTLY:');
    lines.push('TITLE: <a short title for the draft>');
    lines.push('<the finished draft itself, ready for them to read>');
    return lines.join('\n');
  }

  // parse the do-run output into a deliverable, tolerantly. Pulls a leading TITLE: line; the rest is the draft body.
  // Falls back to the selected job's title. Returns { title, body } or null if there's no usable body.
  function parseDeliverable(text, opts) {
    opts = opts || {};
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    let title = '', body = raw;
    const m = /^\s*TITLE\s*:\s*(.+?)\s*(?:\n|$)/i.exec(raw);
    if (m) { title = m[1].trim(); body = raw.slice(m.index + m[0].length).trim(); }
    if (!title) title = String(opts.fallbackTitle || 'Draft').trim().slice(0, 80);
    if (!body) return null;
    return { title: title.slice(0, 80), body };
  }

  /* ============================ NS-3: the TOOL-CAPABLE ACT variant (reach ≥ sandbox) ============================
     The Slice-A directives above hard-forbid tools ("NO tools, NO web, NO file writes") — correct for the
     reason-only DRAFT path (reach 'observe'). When the Commander raises Reach to 'sandbox', an unattended beat may
     do REAL work in the agent's jailed sandbox: research with read-only tools, then BUILD a reviewable artifact
     (a file / a small tool / a research brief) under workshop/<runId>/, exactly like an away-workshop shift. These
     V2 variants ask for that instead — same grounding veto (parseCandidates is reused unchanged), same confidence
     gate (scoreAndSelect unchanged), same self-critique step after. They are ADDITIVE: the V1 exports and their
     tests are untouched; the server picks V2 only on the reach-gated path. The one hard rule these keep, matching
     the consent floor the sidecar enforces, is that NOTHING may send/publish/spend — the artifact is LOCAL. */

  // the tool-capable CANDIDATE directive. Same tagged output contract as buildCandidateDirective (so parseCandidates
  // + the grounding veto work verbatim), but the achievability rule is inverted: the job must produce a REAL
  // artifact the agent can build UNATTENDED in its sandbox — a file, a small runnable tool, a researched brief.
  function buildCandidateDirectiveV2(ctx) {
    ctx = ctx || {};
    const beliefs = (ctx.beliefs && typeof ctx.beliefs === 'object') ? ctx.beliefs : {};
    const eligible = (Array.isArray(ctx.eligible) && ctx.eligible.length) ? ctx.eligible : ARCHETYPES;
    const max = Number.isFinite(ctx.max) ? ctx.max : CANDIDATE_MAX;
    const lines = [];
    lines.push('INTERNAL — SELF-DIRECTED WORK. The Commander is away and has cleared you to BUILD in your private sandbox. Reason first, then reply in the exact format below.');
    const hasFocus = pushFocusBlock(lines, ctx.focusHeader);
    lines.push('Propose up to ' + max + ' small jobs you could do RIGHT NOW, unattended, that each end in a REAL, reviewable artifact left in your workshop — then you will be asked to build the single best one.');
    const hasThreads = pushThreadsBlock(lines, ctx.threads);
    const hasActivity = pushActivityBlock(lines, ctx.activity);
    const hasSnapshot = pushSnapshotBlock(lines, ctx.projectSnapshot);
    pushPriorTonight(lines, ctx.priorTonight);
    const hasPrior = pushPriorBuilds(lines, ctx.priorBuilds);
    const dimLine = (key, label) => { const arr = Array.isArray(beliefs[key]) ? beliefs[key].filter(Boolean) : []; if (arr.length) lines.push('- ' + label + ': ' + arr.join(' | ')); };
    lines.push('What you know about them:');
    dimLine('goals', 'Goals'); dimLine('pain', 'Pain points'); dimLine('ambition', 'Ambitions'); dimLine('stack', 'Stack & tools'); dimLine('standing_orders', 'Standing orders'); dimLine('style', 'Working style'); dimLine('people', 'People & audience (who the work is for)'); dimLine('schedule', 'Schedule & cadence (when work should land)');
    lines.push('Each job must be ONE of these kinds: ' + eligible.map(a => a.id + ' (' + a.blurb + ')').join(', ') + '.');
    lines.push('Hard rules:');
    if (hasFocus) lines.push('- STAY ON FOCUS: the single best job MUST advance TONIGHT\'S FOCUS above.');
    if (hasPrior) lines.push('- NO REBUILDS: never propose a job that re-makes one of the ALREADY BUILT items above. To work on one, title the job "Continue: <its title>" and say in SPEC what you will improve. Prefer continuing the newest UNDECIDED build over starting something new.');
    if (hasSnapshot) lines.push('- PATCH THE REAL PROJECT: base your change on the PROJECT SNAPSHOT above. Your artifact for a code change is a UNIFIED-DIFF .patch file (git-apply-able from the repo root) plus a one-line "howToUse" — the Commander applies it to a new branch on Keep. Set the manifest "kind":"patch" and include "targetRoot":"<the project root path shown in the snapshot header>".');
    if (hasThreads) lines.push('- PREFER AN OPEN THREAD: if any thread above fits, build it and cite its tag in GROUNDS (e.g. GROUNDS: [t1] ...). A grounded open thread beats a fresh idea. If none fit, improvise a grounded idea as below.');
    if (hasActivity) lines.push('- CONTINUE THEIR WORK: prefer a job that directly advances, unblocks, or extends something in "What they worked on recently" above — that beats a generic idea. But stay HONEST: only cite work that is actually listed; never invent activity.');
    lines.push('- GROUNDED: every job must aim at a SPECIFIC thing above (an open thread / a real recent job / goal / pain / etc). Quote the exact thing in GROUNDS. If you cannot ground it in something you actually know or they actually did, do not propose it.');
    lines.push('- BUILDABLE NOW, UNATTENDED, LOCAL: it must finish as a FILE or small self-contained tool you write into your workshop folder. You MAY read/research with your tools first. You may NOT send, publish, spend, message, or touch anything outside your sandbox — the artifact stays local for the Commander to review.');
    lines.push(finishRuleFor(ctx.initiative));
    lines.push('- HONEST CONFIDENCE: rate how sure you are it is genuinely useful AND that you can build it well now (high/medium/low). Low is fine — better than padding.');
    lines.push('Reply with one block PER job, EXACTLY this format, nothing else:');
    lines.push('JOB: <short title, a few words>');
    lines.push('KIND: <one id from the list>');
    lines.push('GROUNDS: <the exact goal/pain/etc this serves — quote what you know>');
    lines.push('CONFIDENCE: <high | medium | low>');
    lines.push('SPEC: <one line — exactly what the finished artifact will be, as a THING that works (your own done-check)>');
    return lines.join('\n');
  }

  // the tool-capable DO directive. Unlike buildDoDirective (which asks for a titled text draft in the reply), this
  // instructs the agent to BUILD the artifact with its real tools under a given run directory and write a workshop
  // manifest — the SAME deliverable.json contract the away-workshop validates, so the return card + ship gate are
  // reused verbatim. The runId/dir come from the caller (ctx.runId, ctx.dir); the sidecar re-jails every path.
  /* THE AUTONOMY RUNG DECIDES WHETHER A PLAN IS A DELIVERABLE (2026-08-15).
     The Commander's dial reads WAIT / SUGGEST / BUILD (DRAFTS) / FREE (FULLY AUTONOMOUS) and maps to
     initiative wait|propose|leash|free. Until now NONE of that reached the build directive: FREE and
     BUILD (DRAFTS) sent byte-identical prompts, so the top rung differed only in CADENCE (a beat every
     ~45 min vs all night) and could still hand back a backlog describing work instead of the work. That
     makes the headline promise — "while you were away, it BUILT this" — false at the rung that promises
     it hardest.
       leash (BUILD DRAFTS) → a plan is a legitimate deliverable; that rung literally says drafts.
       free  (FULLY AUTONOMOUS) → a plan is a FAILED shift. Build the thing, or the smallest complete
             working piece of it. Enforced server-side too (a planOnly manifest is refused, never
             delivered) — prose alone is not a guarantee.
     A research/findings answer is NOT a plan: it IS the deliverable, and stays allowed at every rung. */
  /* THE SELECTOR IS WHERE THE VISION LEAKS (2026-08-15). "While you were away" exists to GET THINGS DONE toward
     the Commander's goals — but a goal, quest, or thread is often PHRASED as a draft ("Draft Automation Backlog"
     was a real quest that produced a real backlog-instead-of-a-tool). The shift obeyed the wording, so the
     plan-shaped deliverable was chosen at CANDIDATE time, long before any card rendered it. Fixing the card was
     treating the symptom. This rule aims the proposal at finishable work, and re-reads a draft-phrased ask as an
     instruction to build the thing it describes. */
  function finishRuleFor(initiative) {
    const common = '- PREFER WHAT YOU CAN FINISH: a smaller job you can COMPLETE tonight beats a bigger one you could only describe. If an ask is phrased as "draft/plan/spec/outline X", the job is to BUILD X — the wording describes the goal, not the artifact.';
    return String(initiative || '') === 'free'
      ? common + ' At this autonomy level NEVER propose writing a plan, backlog, roadmap, or "next steps" document as the job itself — those are refused. Propose the smallest COMPLETE working thing that moves it.'
      : common;
  }

  function planRuleFor(initiative) {
    return String(initiative || '') === 'free'
      ? '- FINISH IT, DO NOT PLAN IT. The Commander is at FREE (fully autonomous) — they want the WORKING THING, not a document about it. NEVER deliver a backlog, roadmap, spec, plan, proposal, checklist, or "next steps" write-up as the artifact. If the job is too big for one shift, build the SMALLEST COMPLETE WORKING PIECE of it and say in the summary what it covers and what is left. At this level a plan is not a deliverable — it is a failed shift, and it will be refused. (Answering a question with a findings doc is NOT a plan; that is still fine.)'
      : '- If the job is genuinely too big to finish now, a short plan the Commander can act on IS an acceptable deliverable — set "planOnly": true so they are offered a one-click build of it. Prefer finishing something small over describing something large.';
  }
  function planOnlyFieldFor(initiative) {
    return String(initiative || '') === 'free'
      ? '    "planOnly": false,   <-- MUST be false at this autonomy level; a plan-shaped deliverable is refused (see the rule above),'
      : '    "planOnly": <true ONLY if this deliverable DESCRIBES work to be done (a plan, backlog, spec, proposal) rather than BEING the finished thing; false for anything the Commander can open and use as-is, including a research answer>,';
  }

  function buildDoDirectiveV2(selected, ctx) {
    selected = selected || {}; ctx = ctx || {};
    const dir = String(ctx.dir || ('workshop/' + (ctx.runId || 'run')));
    const backlogId = String(ctx.backlogId || '');
    const lines = [];
    lines.push('INTERNAL — SELF-DIRECTED WORK. The Commander is away and cleared you to build in your private sandbox. Build this ONE job now and leave a real, reviewable artifact.');
    pushFocusBlock(lines, ctx.focusHeader);
    lines.push('- JOB: ' + String(selected.title || '').trim());
    if (selected.grounds) lines.push('- WHY IT MATTERS TO THEM: ' + String(selected.grounds).trim());
    if (selected.spec) lines.push('- DONE WHEN: ' + String(selected.spec).trim());
    pushContinueBlock(lines, ctx.continueFrom, dir);
    const hasSnap = pushSnapshotBlock(lines, ctx.projectSnapshot);
    lines.push('RULES:');
    if (hasSnap && String(ctx.targetRoot || '').trim()) {
      lines.push('- THIS IS A PROJECT PATCH: write a UNIFIED-DIFF file (e.g. "' + dir + '/change.patch") that applies cleanly with `git apply` from the repo root ' + String(ctx.targetRoot).trim() + '. Base every hunk on the PROJECT SNAPSHOT above; do not invent files or lines that aren\'t there. In the manifest set "kind":"patch" and "targetRoot":"' + String(ctx.targetRoot).trim() + '", and list the .patch file in "files". The Commander applies it to a NEW branch on Keep — you never touch their repo yourself.');
    }
    lines.push(planRuleFor(ctx.initiative));
    lines.push('- MATCH THE FORMAT TO THE ASK — build the SIMPLEST thing that fully serves it, never the most impressive: a question/research ask -> a short findings doc (answer first, sources after); a draft ask -> the draft file itself; a comparison/decision -> a short ranked write-up, recommendation on top. ONLY build an interactive SINGLE-FILE HTML tool (all CSS/JS inline, no build step, named index.html) when the ask genuinely needs interaction the Commander will use repeatedly — NEVER default to a dashboard unless the ask is literally to watch several changing numbers in one place.');
    lines.push('- Whatever the format: ZERO SETUP on their end — self-contained, one-click openable, no external files or build step; a script ships with its single run note in "howToUse".');
    lines.push('- Do the real work with your tools (web read/search, files). Ground factual claims in what the tools return. Write every file for this deliverable UNDER "' + dir + '/" (use paths like "' + dir + '/<file>").');
    lines.push('- LOCAL ONLY: never send, publish, spend, or message. You cannot run commands or tests, so do not claim anything was tested — list what a human still needs to verify.');
    lines.push('- When finished, write a manifest to "' + dir + '/deliverable.json" with EXACTLY this shape:');
    lines.push('  { "v": 1, "runId": "' + String(ctx.runId || '') + '", "agentId": "<your id>", "backlogId": "' + backlogId + '",');
    // 'patch' MUST be listed here: the PROJECT PATCH rule above tells the agent to set it, and the apply path
    // (nightpatch.patchTargetFrom) fires ONLY on kind === 'patch'. It was missing from this enum from 2026-07-07
    // until 2026-08-14 — the rule said "patch", the shape said otherwise, so a patch build came back as a plain
    // file copy AND skipped the savedOnly honesty line (which is keyed on the same kind). Never drop it again.
    lines.push('    "title": "<short name>", "kind": "tool|fix|draft|doc|patch|other",');
    lines.push(planOnlyFieldFor(ctx.initiative));
    lines.push('    "summary": "<2-3 SHORT plain sentences a busy person absorbs in ten seconds: what it IS and what it does for them. NEVER an inventory — no inline lists of categories, failure modes, or counts, and no sentence over ~25 words; the deliverable itself holds the detail>",');
    lines.push('    "files": [{ "path": "<relative to ' + dir + '>", "bytes": <number> }],');
    lines.push('    "howToUse": "<ONE short sentence — at most the single run command. The station gives the Commander an Open link and a one-click Implement action (a patch is applied for them), so NEVER write multi-step setup or git instructions here>",');
    lines.push('    "notVerified": ["<up to 5 items, each ONE short check written FOR the Commander — a concrete thing THEY can do in a minute. NEVER your run diagnostics: no tool budgets, byte counts, or what this shift could not execute — turn every limitation into the check it implies>"] }');
    lines.push('- The manifest MUST list the real files you wrote (paths relative to "' + dir + '/"). A shift with no manifest is discarded.');
    return lines.join('\n');
  }

  /* the shared LEARN transform (A3 parity, server + frontend). The frontend AutopilotStore keeps a per-archetype
     { up, down } tally the Commander's verdicts feed; learnWeightsFrom() turns it into the small, capped selection
     bias scoreAndSelect consumes. NS-1 ran server-side with EMPTY weights; NS-3 needs the server to learn from
     approve/deny too, so the pure math lives HERE (one definition, both sides) instead of being re-derived. Pure:
     no clock/rng. learnFold() applies one verdict; learnWeightsFrom() derives the weights. */
  function learnFold(learn, archetype, useful) {
    const L = (learn && typeof learn === 'object') ? learn : {};
    const key = String(archetype || '').trim();
    if (!key) return L;
    const e = L[key] = L[key] || { up: 0, down: 0 };
    if (useful) e.up = (Number(e.up) || 0) + 1; else e.down = (Number(e.down) || 0) + 1;
    return L;
  }
  function learnWeightsFrom(learn) {
    const w = {}; const L = (learn && typeof learn === 'object') ? learn : {};
    for (const k in L) { const e = L[k] || {}; const net = (Number(e.up) || 0) - (Number(e.down) || 0); w[k] = Math.max(-0.5, Math.min(0.5, net * 0.25)); }
    return w;
  }

  /* ---- Slice A3: self-critique before delivery, + the "while you were away" digest ---- */

  // THE CRITIQUE DIRECTIVE — the reason-only self-review run: the agent adversarially checks its OWN draft against
  // the spec + the Commander's style/standing-orders before it hits the desk ("verify before done", turned inward).
  // The honest outcomes: ship (good), revise (then give the corrected draft), drop (not worth their time).
  function buildCritiqueDirective(deliverable, selected, ctx) {
    deliverable = deliverable || {}; selected = selected || {}; ctx = ctx || {};
    const lines = [];
    lines.push('INTERNAL — SELF-REVIEW. Before this draft reaches the Commander, review it adversarially and honestly.');
    lines.push('The job: ' + String(selected.title || '').trim() + (selected.spec ? ' — done when: ' + String(selected.spec).trim() : ''));
    if (ctx.style) lines.push('Their working style: ' + ctx.style);
    if (ctx.standingOrders) lines.push('Their standing orders (must respect): ' + ctx.standingOrders);
    lines.push('The draft:');
    lines.push('TITLE: ' + String(deliverable.title || '').trim());
    lines.push(String(deliverable.body || '').trim());
    lines.push('Does it satisfy the job, respect their style/orders, and avoid padding or guessing? Be strict — a draft that wastes their time is worse than no draft at all.');
    lines.push('Reply EXACTLY:');
    lines.push('VERDICT: <ship | revise | drop>');
    lines.push('NOTE: <one line — why, or what you changed>');
    lines.push('If (and only if) revise, then give the corrected draft below, as:');
    lines.push('TITLE: <title>');
    lines.push('<the corrected draft>');
    return lines.join('\n');
  }

  // parse the self-review. Fails OPEN to 'ship' on a format miss (never lose good work over a parse), and on
  // 'revise' pulls the corrected draft (the TITLE: block) back through parseDeliverable.
  function parseCritique(text, opts) {
    opts = opts || {};
    const raw = String(text == null ? '' : text);
    const vm = /^\s*VERDICT\s*:\s*(ship|revise|drop)\b/im.exec(raw);
    const verdict = vm ? vm[1].toLowerCase() : 'ship';
    const nm = /^\s*NOTE\s*:\s*(.+?)\s*$/im.exec(raw);
    const note = nm ? nm[1].trim() : '';
    let revised = null;
    if (verdict === 'revise') {
      const ti = raw.search(/^\s*TITLE\s*:/im);
      if (ti >= 0) revised = parseDeliverable(raw.slice(ti), { fallbackTitle: opts.fallbackTitle });
    }
    return { verdict, note, revised };
  }

  // the "while you were away" digest body — one line per draft. The digest composes ENTIRELY from the draft log
  // (no new events), upholding the legibility law: you always see, truthfully, what ran while you were gone.
  function digestLines(drafts) {
    const out = [];
    for (const d of (Array.isArray(drafts) ? drafts : [])) if (d && d.title) out.push((d && d.wrote ? '✎ ' : '▸ ') + String(d.title).trim());
    return out;
  }

  // ── B2: the act path WRITES a real local file (under the cabinet:write grant) ────────────────────────────────
  // turn a deliverable TITLE into a safe, deterministic workspace path under drafts/. Pure: a slug of the title
  // (lowercased, non-alnum → '-', clamped), so the same deliverable maps to the same file. The server STILL
  // re-jails it (resolveInside) and the hardline floor blocks .env/.git — this just keeps the path tidy + legible.
  function writePath(title) {
    const slug = String(title == null ? '' : title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return 'drafts/' + (slug || 'draft') + '.md';
  }
  // the write GATE: the autopilot may write a real file ONLY with BOTH the cabinet:write CONSENT (granted) AND the
  // cabinet CAPABILITY (a Filing Cabinet placed) — object=capability. Either missing → draft-only (Stage A). This
  // is the policy that keeps B1's "needs a Filing Cabinet placed to take effect" promise honest for the auto flow.
  function canWrite(opts) { opts = opts || {}; return !!opts.granted && !!opts.cabinetPlaced; }
  // compose the file BODY from the finished deliverable: the title as an H1 + the body. Pure (no clock/rng).
  function fileBody(deliverable) {
    const d = deliverable || {};
    const title = (String(d.title == null ? '' : d.title).trim()) || 'Draft';
    const body = String(d.body == null ? '' : d.body).trim();
    return '# ' + title + '\n\n' + body + '\n';
  }

  // ── B3: the "while you were away" digest — report what was WRITTEN + a one-tap undo target ───────────────────
  // split a batch of away-deliverables into the files it actually WROTE vs the desk DRAFTS, and compute the single
  // honest rollback target: the snapshot taken BEFORE the FIRST write. Restoring it reverts EVERY away-write (each
  // write snapshots the pre-write state, so the earliest one is the floor). Pure (no clock/rng) — composed entirely
  // from the draft log, no new events (legibility law). Drafts are chronological (pushed in order), so the first
  // entry carrying a `wrote` is the earliest write.
  function digestSummary(drafts) {
    const list = (Array.isArray(drafts) ? drafts : []).filter(d => d && d.title);
    const wrote = list.filter(d => d.wrote && d.wrote.path);
    const drafted = list.filter(d => !(d.wrote && d.wrote.path));
    let undoSnapshot = null;
    for (const d of wrote) { if (d.wrote.snapshot) { undoSnapshot = d.wrote.snapshot; break; } }   // earliest write's pre-snapshot
    return {
      wrote: wrote.map(d => ({ title: String(d.title).trim(), path: d.wrote.path, snapshot: d.wrote.snapshot || null, at: d.at })),
      drafted: drafted.map(d => ({ title: String(d.title).trim(), at: d.at })),
      wroteCount: wrote.length, draftCount: drafted.length, undoSnapshot: undoSnapshot
    };
  }
  // one honest headline line for the welcome-back beat (files written + drafts left). Pure.
  function digestHeadline(summary) {
    const s = summary || {}; const parts = [];
    if (s.wroteCount) parts.push(s.wroteCount + (s.wroteCount === 1 ? ' file written' : ' files written'));
    if (s.draftCount) parts.push(s.draftCount + (s.draftCount === 1 ? ' draft' : ' drafts') + ' on your desk');
    return parts.length ? parts.join(' + ') : 'nothing to report';
  }

  return {
    idleFor, readiness, decide, newestStamp,
    eligibleArchetypes, grounded, sigTokens, flattenBeliefs, pushActivityBlock,
    pushThreadsBlock, citedThreadId, threadRef, pushFocusBlock, pushSnapshotBlock, pushPriorTonight, pushPriorBuilds, pushContinueBlock,
    buildCandidateDirective, parseCandidates, scoreAndSelect, advancesFocus, focusTokens, focusEvidenceTexts, buildDoDirective, parseDeliverable,
    buildCandidateDirectiveV2, buildDoDirectiveV2, planRuleFor, planOnlyFieldFor, finishRuleFor, learnFold, learnWeightsFrom,
    buildCritiqueDirective, parseCritique, digestLines, digestSummary, digestHeadline,
    writePath, canWrite, fileBody,
    DEFAULT_IDLE_MS, DEFAULT_TICK_MS, REQUIRE_DIM, WARM_MIN, HOT_MIN, STALE_MS,
    ARCHETYPES, CANDIDATE_MAX, MIN_ACT_SCORE, CONFIDENCE_RANK,
    ACTIVITY_WARM_MIN, ACTIVITY_HOT_MIN
  };
});
