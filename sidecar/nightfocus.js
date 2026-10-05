/* sidecar/nightfocus.js — the PURE FOCUS RESOLVER for single-priority nights (autonomy layer, NS-5b).

   THE PROBLEM THIS CLOSES: NS-0..NS-6 made the night shift reliable, safe, and grounded — but every beat
   regenerated its own idea, so a night could scatter across every blessed root / open thread / goal. Andrew's
   direction (2026-07-08): "hone in on moving the needle." A shift should pick ONE priority and let every beat that
   night COMPOUND on it (later beats extend the same work), not produce three unrelated drafts.

   This module is the PRIORITY-RESOLUTION step: at shift start (the first beat of an away episode / a new day) it
   ranks the real evidence — blessed project roots (recency of last touch), open threads (recency), the active goal
   arc — and declares ONE focus for the night: { kind, ref, label, why:[cited evidence], source }. A durable user
   STEER ("focus on Y") outranks all derived evidence until it is cleared or goes stale (~7d), so a wrong guess is
   correctable. TRUTHFUL-TELEMETRY LAW: a declared focus ALWAYS carries the non-empty evidence lines that produced
   it — never an unexplained vibe. If there is nothing to cite, resolveFocus returns null (the beat falls to improv,
   which the caller ledgers as such).

   DETERMINISM SPLIT (mirrors nightshift.js / contextpack.js): every function is a transform over (inputs, now) with
   `now` INJECTED — NO Date.now / new Date() / Math.random / fs — so it passes lint-determinism.js and is headless-
   testable with a fake clock. The ambient half (fetching the projects/threads/goal, load/persist of the state file)
   lives ONLY in sidecar/index.js.

   THE PERSISTED STATE (a small sibling JSON, so a restart resumes the SAME night's focus, not a re-scatter):
     { v, day, focus:{kind,ref,label,why,source,threadId?,resolvedAt}|null, steer:{ref,kind,setAt}|null,
       avoid:[{ref,kind,label,setAt}] }
   day = the LOCAL calendar day the focus belongs to (localday.js — the SAME key the leash rolls on, so "tonight"
   means one thing everywhere); a new day re-resolves.

   AVOID (autonomy-tuning, 2026-07-17): the EXCLUSION directive — "never pick X as the night's focus on your own."
   Unlike a steer it does NOT go stale (an off-limits stays until the user removes it): a steer is a nudge, an avoid
   is a boundary. Conflicts resolve by RECENCY OF DIRECTIVE (the user's latest word wins): steering to X removes X
   from the avoid list; avoiding X clears a steer at X. The resolver itself still honors avoid over a matching steer
   (defense in depth — a conflicting persisted pair fails toward NOT acting). An avoid grants nothing and blocks no
   access the user initiates — it only stops the resolver from DECLARING that target as the autonomous priority. */
'use strict';
(function (root, factory) {
  // the pure learned-topic matcher (frontend/app/topicmatch.js — the SAME engine the bay's shelves use, reused
  // server-side exactly as autopilot.js / prospect.js already are). Absent module → null → every topic boost is
  // 0 and the resolver ranks precisely as it did before topics existed. It is pure (no clock/rng), so it does
  // not disturb this file's determinism split.
  const TM = (typeof module !== 'undefined' && module.exports)
    ? (() => { try { return require('../frontend/app/topicmatch.js'); } catch (_) { return null; } })()
    : ((root.SK && root.SK.topicmatch) || root.TopicMatch || null);
  const LD = (typeof module !== 'undefined' && module.exports) ? require('./localday.js') : (root.SK && root.SK.localday);
  const api = factory(TM, LD);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).nightfocus = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TopicMatch, LocalDay) {
  'use strict';

  const STATE_VERSION = 1;
  const DAY_MS = 86400000;
  const STEER_STALE_MS = 7 * DAY_MS;          // a durable steer outranks evidence for ~7 days, then goes stale
  const AVOID_MAX = 12;                       // off-limits list ceiling (oldest entry evicted first)
  const PROJECT_WINDOW_DAYS = 30;             // a project touched longer ago than this can't be the focus on its own
  const RECENCY_DECAY_DAYS = 30;              // linear recency decay horizon (today = 1.0, 30d ago → 0)

  const num = (v) => ((typeof v === 'number' && isFinite(v)) ? v : 0);
  const str = (v) => (v == null ? '' : String(v));
  // the LOCAL calendar day (shared with nightshift.js's leash key). Falls back to the UTC bucket only if the
  // localday module is somehow absent (a browser bundle that didn't load it).
  const dayOf = (t, tz) => (LocalDay ? LocalDay.dayOf(num(t), tz) : Math.floor(num(t) / DAY_MS));

  // a compact relative-day tag for a timestamp, given `now`. Pure arithmetic (no Date). '' when undated.
  function dayTag(ts, now) {
    const t = num(ts), n = num(now);
    if (!t || !n || n < t) return '';
    const days = Math.floor((n - t) / DAY_MS);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + 'd ago';
  }

  // the focus KINDS this resolver may declare. project/thread/goal are the NS-5b originals; 'quest' (an open
  // ledger quest) and 'northstar' (the confirmed inferred long-term direction) are the flagship cross-wire (a
  // night beat can actually ADVANCE a work quest / serve the star). Steering is still project/thread/goal only.
  // 'workflow' (2026-10-05 audit item 2): work the Commander asked for on ≥3 separate days that no routine covers yet
  // (workflow-takeover.js's evidence) — repeated work is the clearest signal of what they want done.
  const FOCUS_KINDS = ['project', 'thread', 'goal', 'quest', 'northstar', 'workflow'];
  const WORKFLOW_MIN_COUNT = 3;               // the same bar workflow-takeover.js offers a routine at

  /* ---- the LEARNED-TOPIC TIE-BREAK (2026-07-28) ----
     Until now this resolver ranked purely on RECENCY: the most recently touched project won the night, whatever
     the Commander actually keeps working ON. The station already learns that (interests.js — an evidence-backed
     topic histogram), and a focus that matches a warm topic is measurably more likely to be the thing worth
     moving. So a matched candidate gets a SMALL boost and cites the topic in its `why`.

     DELIBERATELY A TIE-BREAK, NOT A RE-RANKER. The cap is 0.2 against a recency term that spans a full 1.0, so
     it can only reorder candidates already within ~6 days of each other — a genuinely stale project can never
     be dragged over fresh work by a topic match. And TopicMatch's anchor rule means the boost is exactly 0
     until a topic is WARM, so a cold station resolves the identical focus it resolved before this existed.

     Applied ONLY to the three evidence-derived kinds with real subject text (project / thread / quest). The goal
     arc and the north star are the Commander's EXPLICIT direction with flat scores — boosting those by an
     inferred topic would double-count the same signal and let an inference outrank a stated intent. */
  const TOPIC_BOOST_MAX = 0.2;
  function topicBoost(topics, corpus) {
    if (!TopicMatch || !TopicMatch.match || !str(corpus)) return null;
    let m = null;
    try { m = TopicMatch.match(topics, corpus); } catch (_) { return null; }
    if (!m) return null;
    const boost = TopicMatch.term(m, TOPIC_BOOST_MAX, TOPIC_BOOST_MAX);
    if (!(boost > 0)) return null;
    return { boost: boost, why: TopicMatch.reason(m) };
  }

  // linear recency score in [0,1]: today = 1, decaying to 0 at RECENCY_DECAY_DAYS. Unknown/future ts → 0.
  function recency(ts, now) {
    const t = num(ts), n = num(now);
    if (!t || !n || n < t) return 0;
    const days = (n - t) / DAY_MS;
    return Math.max(0, 1 - days / RECENCY_DECAY_DAYS);
  }

  // the trailing path/segment of a root, for a legible label ("C:/repo/alpha" → "alpha"). Never throws.
  function baseName(p) {
    const s = str(p).replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // ---- AVOID ----
  // ref equality for directive targets. Project refs are filesystem paths the host has already canonicalized, but a
  // pure compare still folds case + slash direction so a win32 round-trip can't split one root into two identities.
  function sameRef(kind, a, b) {
    const x = str(a), y = str(b);
    if (!x || !y) return false;
    if (kind === 'project') return x.toLowerCase().replace(/\\/g, '/') === y.toLowerCase().replace(/\\/g, '/');
    return x === y;
  }
  function normAvoid(list) {
    const out = [];
    for (const e of (Array.isArray(list) ? list : [])) {
      if (!e || typeof e !== 'object' || !str(e.ref)) continue;
      const kind = (e.kind === 'thread' || e.kind === 'goal') ? e.kind : 'project';
      if (out.some(o => o.kind === kind && sameRef(kind, o.ref, e.ref))) continue;   // dedupe, first (oldest) wins
      out.push({ ref: str(e.ref), kind, label: str(e.label || '').slice(0, 120) || (kind === 'project' ? baseName(e.ref) : str(e.ref)), setAt: num(e.setAt) });
    }
    return out.slice(-AVOID_MAX);   // over-cap: evict the OLDEST entries (list order is insertion order)
  }
  // is this (kind, ref) target off-limits? `avoid` is the normalized list.
  function isAvoided(avoid, kind, ref) {
    return (Array.isArray(avoid) ? avoid : []).some(e => e && e.kind === kind && sameRef(kind, e.ref, ref));
  }
  // add an off-limits entry (stamps setAt from the injected `now`). The user's LATEST word wins: a steer at the same
  // target is cleared, and a current focus at the same target is dropped so the next ensureFocus re-resolves. Pure.
  function applyAvoid(state, entry, now) {
    const s = normalize(state, now);
    const kind = (entry && (entry.kind === 'thread' || entry.kind === 'goal')) ? entry.kind : 'project';
    const ref = str(entry && entry.ref);
    if (!ref) return s;
    const next = normAvoid(s.avoid.filter(e => !(e.kind === kind && sameRef(kind, e.ref, ref)))
      .concat([{ ref, kind, label: str(entry.label || ''), setAt: num(now) }]));
    const steer = (s.steer && s.steer.kind === kind && sameRef(kind, s.steer.ref, ref)) ? null : s.steer;
    const focus = (s.focus && s.focus.kind === kind && sameRef(kind, s.focus.ref, ref)) ? null : s.focus;
    return { v: STATE_VERSION, day: s.day, focus, steer, avoid: next };
  }
  // remove an off-limits entry by ref (any kind). Pure; unknown ref is a harmless no-op.
  function removeAvoid(state, ref) {
    const s = normalize(state, 0);
    return { v: STATE_VERSION, day: s.day, focus: s.focus, steer: s.steer, avoid: s.avoid.filter(e => !sameRef(e.kind, e.ref, ref)) };
  }

  // ---- STEER ----
  // is a durable steer still authoritative? true iff it exists, has a ref, and is younger than STEER_STALE_MS.
  function steerActive(steer, now) {
    if (!steer || typeof steer !== 'object' || !str(steer.ref)) return false;
    const set = num(steer.setAt);
    if (!set) return true;                    // an un-stamped steer is treated as fresh (fail toward honoring the user)
    return (num(now) - set) < STEER_STALE_MS;
  }

  /* northStarEvidence — the PURE gate deciding whether the quest engine's north star may steer the night, applying
     the consent + no-double-count rules so the ambient half never has to. `star` is the ADOPTED-slot north star
     ({ text, groundedIn, source, status }) — pass the adopted star, NOT effectiveNorthStar (which surfaces an
     UNCONFIRMED proposal). `goal` is the active commander goal arc (or null). Returns the evidence { text,
     groundedIn } the resolver may rank, or null when the star must NOT steer:
       · an UNCONFIRMED proposal (status !== 'adopted') — consent law: a guess never drives autonomous work;
       · a GOAL-sourced star (source === 'goal') — that IS the commander goal, already the `goal` input (no double count);
       · an inferred star whose text equals the active goal — the same direction, already ranked as `goal`. */
  function northStarEvidence(star, goal) {
    if (!star || typeof star !== 'object') return null;
    const text = str(star.text).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (str(star.status) && str(star.status) !== 'adopted') return null;   // unconfirmed proposal — never steers
    if (star.source === 'goal') return null;                               // the commander goal — the `goal` input covers it
    const gtext = (goal && goal.text) ? str(goal.text).replace(/\s+/g, ' ').trim().toLowerCase() : '';
    if (gtext && gtext === text.toLowerCase()) return null;                // same direction as the goal — no double count
    return { text: text.slice(0, 140), groundedIn: str(star.groundedIn) };
  }

  /* resolveFocus — THE pure ranker. Given already-fetched evidence + `now`, returns ONE focus or null.
       inputs: {
         projects:  [{ root, displayPath, lastTouchedAt, isGitRepo, mentionCount? }],  // blessed roots + light meta
         threads:   [{ id, title, spec, updatedAt }],                                  // open threads (recency-ranked)
         goal:      { text, done, total, next } | null,                                // the active goal arc
         quests:    [{ id, title, contractType, createdAt }],                          // OPEN ledger quests (flagship cross-wire)
         northStar: { text, groundedIn } | null,                                       // CONFIRMED inferred star (via northStarEvidence)
         topics:    [{ label, weight, count, evidence }],                              // learned interests (interests.summary) — a capped TIE-BREAK only
         workflows: [{ id, name, count, lastAt, quotes:[their words] }],               // repeated asks no routine covers (workflow-takeover)
         steer:     { ref, kind, setAt } | null                                        // a durable user directive
       }
     A fresh steer short-circuits to itself (source:'steer'). Otherwise every candidate is scored by recency and the
     best wins (ties break project > quest/thread > goal > northstar). A returned focus ALWAYS has a non-empty `why`. */
  function resolveFocus(inputs, opts) {
    inputs = inputs || {}; opts = opts || {};
    const now = num(opts.now);

    const avoid = normAvoid(inputs.avoid);

    // 1) a fresh STEER outranks all derived evidence and cites the user's directive — unless the same target is
    //    ALSO on the avoid list (a conflicting persisted pair fails toward NOT acting; applySteer/applyAvoid keep
    //    that pair from forming, so this is defense in depth, not a UI state).
    if (steerActive(inputs.steer, now) && !isAvoided(avoid, (inputs.steer.kind === 'thread' || inputs.steer.kind === 'goal') ? inputs.steer.kind : 'project', inputs.steer.ref)) {
      const s = inputs.steer;
      const kind = (s.kind === 'thread' || s.kind === 'goal') ? s.kind : 'project';
      const label = kind === 'project' ? baseName(s.ref) : str(s.ref);
      const tag = dayTag(s.setAt, now);
      return {
        kind, ref: str(s.ref), label,
        why: ['you asked me to focus on ' + label + (tag ? ' (' + tag + ')' : '') + ' — that outranks what I\'d have picked'],
        source: 'steer',
        threadId: kind === 'thread' ? str(s.ref) : undefined,
        resolvedAt: now
      };
    }

    // 2) rank the derived candidates.
    const cands = [];

    for (const p of (Array.isArray(inputs.projects) ? inputs.projects : [])) {
      if (!p || !str(p.root)) continue;
      if (isAvoided(avoid, 'project', p.root)) continue;   // off-limits by user directive
      const r = recency(p.lastTouchedAt, now);
      const days = (num(now) - num(p.lastTouchedAt)) / DAY_MS;
      if (num(p.lastTouchedAt) && days > PROJECT_WINDOW_DAYS) continue;   // too stale to lead on its own
      const label = baseName(p.displayPath || p.root);
      const tag = dayTag(p.lastTouchedAt, now);
      const mentions = Math.max(0, Math.floor(num(p.mentionCount)));
      const why = ['you worked in ' + label + (tag ? ' — last touched ' + tag : '') + (p.isGitRepo ? ' (a git repo I can read + patch)' : '')];
      if (mentions > 0) why.push(mentions + ' recent run' + (mentions === 1 ? '' : 's') + ' point at it');
      /* ENVIRONMENT DISCOVERY citations (2026-08-28): what the repo's own bounded scan found — an uncommitted
         working tree, a TODO the code itself carries. Each line arrives WITH its verbatim quote (discovery.js
         findingsForRoot caps them at 2, and normFocus's 6-line cap still binds). Deliberately EVIDENCE ONLY:
         the score is untouched, the same law the topic boost holds — citations may explain a choice the
         recency ranking already made, never re-rank it. */
      for (const f of (Array.isArray(p.findings) ? p.findings : []).slice(0, 2)) {
        const q = f && str(f.quote).replace(/\s+/g, ' ').trim();
        if (q) why.push(q.slice(0, 160));
      }
      const tb = topicBoost(inputs.topics, label + ' ' + str(p.displayPath || p.root));
      if (tb && tb.why) why.push(tb.why);   // the boost is only ever taken WITH its cited evidence
      // a project with NO touch metadata still scores a small floor (it IS blessed = the user chose it) so it can
      // lead when there is nothing fresher; a recently-touched root dominates via the recency term.
      const score = 1.0 * r + 0.15 * Math.min(mentions, 4) + (num(p.lastTouchedAt) ? 0 : 0.1) + (tb ? tb.boost : 0);
      cands.push({ order: 0, score, focus: { kind: 'project', ref: str(p.root), label, why, source: 'evidence', resolvedAt: now } });
    }

    for (const t of (Array.isArray(inputs.threads) ? inputs.threads : [])) {
      if (!t || !str(t.id) || !str(t.title)) continue;
      if (isAvoided(avoid, 'thread', t.id)) continue;   // off-limits by user directive
      const r = recency(t.updatedAt, now);
      const tag = dayTag(t.updatedAt, now);
      const title = str(t.title).replace(/\s+/g, ' ').trim().slice(0, 120);
      const why = ['an open thread you raised but never acted on: "' + title + '"' + (tag ? ' (' + tag + ')' : '')];
      const tb = topicBoost(inputs.topics, title + ' ' + str(t.spec));
      if (tb && tb.why) why.push(tb.why);
      const score = 0.85 * r + 0.2 + (tb ? tb.boost : 0);   // a live thread is worth chasing even when a touch is a few days old
      cands.push({ order: 1, score, focus: { kind: 'thread', ref: str(t.id), label: title, why, source: 'evidence', threadId: str(t.id), resolvedAt: now } });
    }

    // open ledger QUESTS — the Commander's committed next steps (flagship cross-wire). A WORK quest (run/artifact
    // contract) is the strongest kind here: a night beat can actually ADVANCE it (do the run / build the artifact).
    // A prop/fact/attest quest is weaker evidence — its completion needs a capability/fact/Commander-verdict a beat
    // can't force. Scored in the THREAD neighbourhood (comparable evidence) so a fresh explicit quest beats a stale
    // project but a work quest can be chased over a bare thread.
    for (const q of (Array.isArray(inputs.quests) ? inputs.quests : [])) {
      if (!q || !str(q.title)) continue;
      const r = recency(q.createdAt, now);
      const tag = dayTag(q.createdAt, now);
      const title = str(q.title).replace(/\s+/g, ' ').trim().slice(0, 120);
      const ctype = str(q.contractType).toLowerCase();
      const isWork = (ctype === 'run' || ctype === 'artifact');
      const why = [(isWork ? 'an open work quest a beat can advance: "' : 'an open quest on your slate: "') + title + '"'
        + (ctype ? ' [' + ctype + ']' : '') + (tag ? ' (' + tag + ')' : '')];
      const tb = topicBoost(inputs.topics, title);
      if (tb && tb.why) why.push(tb.why);
      const score = (isWork ? (0.85 * r + 0.28) : (0.7 * r + 0.15)) + (tb ? tb.boost : 0);
      cands.push({ order: 1, score, focus: { kind: 'quest', ref: str(q.id) || ('quest:' + title), label: title, why, source: 'evidence', resolvedAt: now } });
    }

    // REPEATED WORK — a request the Commander made on ≥3 separate days (workflow-takeover.js clustering; the host
    // passes only ones no cron job covers yet). Scored by FREQUENCY × RECENCY: three asks this week sit beside a
    // project touched today; five or six outrank it. Evidence-or-null: no count ≥3 or no quote of their own words →
    // not a candidate (a focus must cite what produced it).
    for (const w of (Array.isArray(inputs.workflows) ? inputs.workflows : [])) {
      if (!w || !str(w.id) || !str(w.name)) continue;
      const count = Math.max(0, Math.floor(num(w.count)));
      if (count < WORKFLOW_MIN_COUNT) continue;
      const quotes = (Array.isArray(w.quotes) ? w.quotes : []).map(q => str(q).replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (!quotes.length) continue;
      const r = recency(w.lastAt, now);
      if (!(r > 0)) continue;
      const tag = dayTag(w.lastAt, now);
      const label = str(w.name).replace(/\s+/g, ' ').trim().slice(0, 120);
      const why = ['you asked for this ' + count + ' times on separate days' + (tag ? ' (last ' + tag + ')' : '') + ' and no routine does it yet',
        'in your words: "' + quotes[quotes.length - 1].slice(0, 160) + '"'];
      if (quotes.length > 1 && quotes[0] !== quotes[quotes.length - 1]) why.push('earlier: "' + quotes[0].slice(0, 120) + '"');
      const score = r * (0.6 + 0.1 * Math.min(count, 6));
      cands.push({ order: 1, score, focus: { kind: 'workflow', ref: str(w.id), label, why, source: 'evidence', resolvedAt: now } });
    }

    const g = (inputs.goal && !isAvoided(avoid, 'goal', 'goal')) ? inputs.goal : null;
    if (g && str(g.text)) {
      const text = str(g.text).replace(/\s+/g, ' ').trim().slice(0, 140);
      const why = ['your active goal arc: "' + text + '"' + (num(g.total) > 0 ? ' (' + num(g.done) + '/' + num(g.total) + ' done)' : '')];
      if (str(g.next)) why.push('next step: ' + str(g.next).replace(/\s+/g, ' ').trim().slice(0, 100));
      const score = 0.55 + (str(g.next) ? 0.1 : 0);
      cands.push({ order: 2, score, focus: { kind: 'goal', ref: 'goal', label: text, why, source: 'evidence', resolvedAt: now } });
    }

    // the CONFIRMED inferred NORTH STAR — the station's long-term direction, evidence-cited. Only a confirmed
    // (adopted, model-sourced, not-already-the-goal) star reaches here: the ambient half runs northStarEvidence()
    // first, so an unconfirmed proposal (consent law) or a goal-sourced star (no double count) is already null.
    const ns = inputs.northStar;
    if (ns && str(ns.text)) {
      const text = str(ns.text).replace(/\s+/g, ' ').trim().slice(0, 140);
      const gi = str(ns.groundedIn).replace(/\s+/g, ' ').trim().slice(0, 100);
      const why = ['your confirmed north star: "' + text + '"' + (gi ? ' — ' + gi : '')];
      const score = 0.55;
      cands.push({ order: 3, score, focus: { kind: 'northstar', ref: 'northstar', label: text, why, source: 'evidence', resolvedAt: now } });
    }

    if (!cands.length) return null;
    cands.sort((a, b) => (b.score - a.score) || (a.order - b.order));
    return cands[0].focus;
  }

  // render the focus as a directive header the propose/do prompts LEAD with (truthful-telemetry: cites the WHY).
  function focusLine(focus) {
    if (!focus || !str(focus.label)) return '';
    const why = (Array.isArray(focus.why) ? focus.why.filter(Boolean) : []).join('; ');
    return "TONIGHT'S FOCUS: " + str(focus.label) + (why ? ' — because ' + why : '');
  }

  // ---- STATE ----
  function fresh(now) { return { v: STATE_VERSION, day: dayOf(now || 0), focus: null, steer: null, avoid: [] }; }

  function normFocus(f) {
    if (!f || typeof f !== 'object' || !str(f.ref)) return null;
    const kind = FOCUS_KINDS.indexOf(f.kind) >= 0 ? f.kind : 'project';
    return {
      kind, ref: str(f.ref), label: str(f.label || f.ref),
      why: Array.isArray(f.why) ? f.why.map(str).filter(Boolean).slice(0, 6) : [],
      source: f.source === 'steer' ? 'steer' : 'evidence',
      threadId: str(f.threadId) || undefined,
      resolvedAt: num(f.resolvedAt)
    };
  }
  function normSteer(s) {
    if (!s || typeof s !== 'object' || !str(s.ref)) return null;
    const kind = (s.kind === 'thread' || s.kind === 'goal') ? s.kind : 'project';
    return { ref: str(s.ref), kind, setAt: num(s.setAt) };
  }
  function normalize(raw, now) {
    const s = fresh(now);
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(raw.day)) s.day = Math.floor(raw.day);
      s.focus = normFocus(raw.focus);
      s.steer = normSteer(raw.steer);
      s.avoid = normAvoid(raw.avoid);
    }
    return s;
  }

  // apply / clear a durable steer (stamps setAt from the injected `now`). Pure; input not mutated.
  function applySteer(state, steer, now) {
    const s = normalize(state, now);
    const ns = normSteer(Object.assign({}, steer, { setAt: num(now) }));
    // the user's LATEST word wins: steering to a target lifts a standing off-limits at that same target.
    const avoid = ns ? s.avoid.filter(e => !(e.kind === ns.kind && sameRef(ns.kind, e.ref, ns.ref))) : s.avoid;
    return { v: STATE_VERSION, day: s.day, focus: s.focus, steer: ns, avoid };
  }
  function clearSteer(state) {
    const s = normalize(state, 0);
    // A steer-derived focus is only a cache of that directive. Keeping it after CLEAR makes the route claim the
    // deleted directive is still tonight's priority until a day roll. Evidence-derived focus is independent and
    // may remain stable; a steer-derived one must be discarded so ensureFocus resolves fresh evidence (or null).
    const focus = (s.focus && s.focus.source === 'steer') ? null : s.focus;
    return { v: STATE_VERSION, day: s.day, focus, steer: null, avoid: s.avoid };
  }

  /* ensureFocus — the DAY-KEYED, steer-aware resolver the host calls at the start of every beat. Keeps the SAME
     focus for the whole night (single-priority) and re-resolves ONLY when:
       · a new LOCAL day has begun (day-roll), OR
       · a durable steer was set/changed AFTER the current focus was resolved (a fresh user directive), OR
       · there is no focus yet.
     Returns { state, focus, resolved } — `resolved:true` iff this call recomputed the focus (the beat should ledger
     the fresh declaration). A null result (nothing to cite) leaves focus null → the caller runs improv. */
  function ensureFocus(state, inputs, opts) {
    opts = opts || {};
    const now = num(opts.now);
    const s = normalize(state, now);
    const curDay = dayOf(now);
    const steerFresh = !!(s.steer && s.focus && num(s.steer.setAt) > num(s.focus.resolvedAt) && steerActive(s.steer, now));
    // an off-limits added after the focus was declared (or a stale persisted pair) must dethrone it — defense in
    // depth alongside applyAvoid's own focus drop.
    const focusAvoided = !!(s.focus && isAvoided(s.avoid, s.focus.kind, s.focus.ref));
    const needsResolve = !s.focus || s.day !== curDay || steerFresh || focusAvoided;
    if (!needsResolve) return { state: s, focus: s.focus, resolved: false };
    const focus = resolveFocus(Object.assign({}, inputs, { steer: s.steer, avoid: s.avoid }), { now });
    const next = { v: STATE_VERSION, day: curDay, focus: focus || null, steer: s.steer, avoid: s.avoid };
    return { state: next, focus: focus || null, resolved: true };
  }

  function loadEnvelope(raw, now) {
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
    if (!obj || typeof obj !== 'object') return normalize(null, now);
    return normalize(obj, now);
  }
  function toEnvelope(state, now) {
    const s = normalize(state, now);
    return { v: STATE_VERSION, day: s.day, focus: s.focus, steer: s.steer, avoid: s.avoid };
  }

  return {
    resolveFocus, focusLine, ensureFocus, steerActive, applySteer, clearSteer, northStarEvidence,
    applyAvoid, removeAvoid, isAvoided, normAvoid, sameRef,
    fresh, normalize, loadEnvelope, toEnvelope, dayOf, recency, dayTag, baseName, topicBoost,
    STATE_VERSION, STEER_STALE_MS, DAY_MS, PROJECT_WINDOW_DAYS, FOCUS_KINDS, AVOID_MAX, TOPIC_BOOST_MAX, WORKFLOW_MIN_COUNT
  };
});
