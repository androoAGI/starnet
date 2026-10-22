/* AGENT OS — mint.js : THE AUTO-MINT engine — notice the jobs you keep asking for, and offer to save them.

   The moat move (personalization P3 slice 2). As the Commander assigns tasks, this watches for a RECURRING
   SHAPE of request — "brief me on X", "fix the bug in Y", "summarize Z" — and, once a shape repeats enough,
   proposes turning it into a one-tap MISSION (a custom recipe) they own. It is the magic that fills the owned,
   exportable library: behaviour observed → a reusable asset the user keeps. PROPOSE-AND-CONFIRM only — mint.js
   never saves anything; it surfaces candidates, the Commander reviews/edits/saves (or dismisses) each one.

   Deliberately CONSERVATIVE (single-user local data is sparse — the design panel's skeptic flagged this): it
   groups by a function-word SKELETON (keeps the verb + structural words, collapses the variable content), only
   fires at a recurrence THRESHOLD, and induceTemplate() backs off to the raw text rather than emit an over-grouped
   junk template. Better to miss a pattern than to confidently propose a wrong one.

   Pure + clock-injected (no Date.now / Math.random) so it is deterministic + node-testable, exactly like
   profile.js. UMD: a `Mint` global in the browser, module.exports under node. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Mint = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const THRESHOLD = 3;        // a shape must recur this many times before it's proposed AS A SEED
  const RECUR_MIN = 2;        // a shape seen this many times is "recurring" — the salience signal for the memory beat
  const MAX_EXAMPLES = 6;     // distinct example directives kept per shape (for template induction)
  const MAX_CANDIDATES = 3;   // never surface more than this many proposals at once (anti-spam)
  const MIN_WORDS = 2;        // ignore trivially short directives ("go", "hi") — no shape worth learning
  const MAX_SHAPES = 200;     // cap the tracked shapes so a long session can't grow state unbounded

  // structural words kept in the skeleton; everything else (the specifics) collapses to a single ∎ slot. The
  // VERB (first non-structural word) is always kept too, so "summarize the report" and "delete the report" never
  // group together. Grouping only needs to be CONSISTENT — the real template is induced from the raw examples.
  const FUNCTION_WORDS = new Set([
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their', 'its', 'his', 'her',
    'me', 'you', 'us', 'them', 'it', 'i', 'we', 'they',
    'on', 'in', 'of', 'for', 'to', 'with', 'into', 'from', 'at', 'by', 'as', 'about', 'over', 'up', 'out', 'off',
    'and', 'or', 'but', 'then', 'now', 'so', 'vs', 'versus',
    'please', 'can', 'could', 'would', 'will', 'should', 'is', 'are', 'was', 'were', 'be', 'do', 'does',
    'all', 'each', 'every', 'any', 'some', 'more', 'most'
  ]);

  // the group key: lowercase, drop punctuation, keep function words + the first content word (verb), collapse
  // every other maximal run of content words into one ∎. Returns '' for a too-short / empty directive.
  function normalizeShape(text) {
    const words = String(text == null ? '' : text).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length < MIN_WORDS) return '';
    const out = []; let verbKept = false;
    for (const w of words) {
      if (FUNCTION_WORDS.has(w)) { out.push(w); continue; }
      if (!verbKept) { out.push(w); verbKept = true; continue; }   // keep the first content word (the verb)
      if (out[out.length - 1] !== '∎') out.push('∎');               // collapse subsequent content into one slot
    }
    // a shape with no variable slot at all (e.g. "summarize this") is still mintable as a FIXED mission, so keep it;
    // but a shape that is ALL function words / no verb carries no signal — drop it.
    return verbKept ? out.join(' ') : '';
  }

  function fresh() { return { v: 1, shapes: {}, enabled: true }; }

  // fold one task directive into the recurrence map. No-op when paused or when the text carries no learnable shape.
  function observe(state, text, now) {
    if (!state || !state.enabled) return state;
    const key = normalizeShape(text);
    if (!key) return state;
    if (!state.shapes) state.shapes = {};
    let s = state.shapes[key];
    if (!s) {
      // at the cap, EVICT the weakest tracked shape (lowest count, then oldest) to make room — so learning never
      // permanently freezes at MAX_SHAPES, it just forgets the least-seen patterns first.
      if (Object.keys(state.shapes).length >= MAX_SHAPES) {
        let wk = null, wc = Infinity, wt = Infinity;
        for (const k in state.shapes) { const c = state.shapes[k]; if (c.count < wc || (c.count === wc && (c.lastAt || 0) < wt)) { wk = k; wc = c.count; wt = c.lastAt || 0; } }
        if (wk) delete state.shapes[wk];
      }
      s = state.shapes[key] = { count: 0, examples: [], minted: false, dismissed: false, lastAt: 0, proposed: 0 };
    }
    const raw = String(text == null ? '' : text).trim();
    s.count += 1;
    s.lastAt = typeof now === 'number' ? now : 0;
    // keep distinct examples, most-recent-last, capped — these drive template induction
    const i = s.examples.indexOf(raw);
    if (i >= 0) s.examples.splice(i, 1);
    s.examples.push(raw);
    if (s.examples.length > MAX_EXAMPLES) s.examples.shift();
    return state;
  }

  // longest common token-prefix / token-suffix over the distinct examples → a {input} template, or the raw text
  // when the examples are too heterogeneous to share real structure (conservative: never emit junk).
  function induceTemplate(examples) {
    const ex = [];
    for (const e of (examples || [])) { const t = String(e == null ? '' : e).trim(); if (t && ex.indexOf(t) < 0) ex.push(t); }
    if (!ex.length) return { template: '', hasToken: false };
    if (ex.length === 1) return { template: ex[0], hasToken: false };   // always the same fill → a FIXED mission

    const arrs = ex.map(s => s.split(/(\s+)/));   // keep whitespace tokens so the rejoin is exact
    const minLen = Math.min.apply(null, arrs.map(a => a.length));
    const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
    let p = 0; while (p < minLen && arrs.every(a => eq(a[p], arrs[0][p]))) p++;
    let suf = 0; while (suf < minLen - p && arrs.every(a => eq(a[a.length - 1 - suf], arrs[0][arrs[0].length - 1 - suf]))) suf++;

    let prefix = arrs[0].slice(0, p).join('');
    let suffix = suf ? arrs[0].slice(arrs[0].length - suf).join('') : '';
    const fixedLen = (prefix + suffix).replace(/\s/g, '').length;
    const avgLen = ex.reduce((a, b) => a + b.replace(/\s/g, '').length, 0) / ex.length;
    // the shared structure must be substantial — otherwise the bucket mixed genuinely different requests and the
    // honest move is to propose the most-recent raw directive (the Commander can add their own {braces}).
    if (fixedLen < 6 || fixedLen / avgLen < 0.35) return { template: ex[ex.length - 1], hasToken: false };

    // keep {input} from fusing onto an adjacent CONTENT token when the divergence is a pure append/prepend
    // ("summarize the report" vs "summarize the report notes" → "summarize the report {input}", never "...report{input}").
    if (prefix && !/\s$/.test(prefix)) prefix += ' ';
    if (suffix && !/^\s/.test(suffix)) suffix = ' ' + suffix;
    const template = (prefix + '{input}' + suffix).replace(/[ \t]{2,}/g, ' ').trim();
    return { template, hasToken: true };
  }

  // the proposals worth surfacing: shapes at/over THRESHOLD, not already minted or dismissed, newest first, capped.
  // opts.maxProposed (default ∞): the GENTLE seed nudge passes a small ceiling so a shape it has already offered-
  // and-been-ignored that many times stops surfacing AS A NUDGE — the manual RECIPES tab calls candidates() with
  // no ceiling, so those shapes still show there (the user can always go find them; we just stop interrupting).
  function candidates(state, opts) {
    opts = opts || {};
    if (!state || !state.enabled || !state.shapes) return [];
    const threshold = typeof opts.threshold === 'number' ? opts.threshold : THRESHOLD;
    const maxProposed = typeof opts.maxProposed === 'number' ? opts.maxProposed : Infinity;
    const out = [];
    for (const key in state.shapes) {
      const s = state.shapes[key];
      if (!s || s.minted || s.dismissed || s.count < threshold) continue;
      if ((s.proposed || 0) >= maxProposed) continue;   // offered-and-ignored enough — stop nudging this shape
      const ind = induceTemplate(s.examples);
      if (!ind.template) continue;
      out.push({ key, count: s.count, lastAt: s.lastAt || 0, template: ind.template, hasToken: ind.hasToken, lastText: s.examples[s.examples.length - 1] || '' });
    }
    out.sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt));   // most-repeated first, then most-recent
    return out.slice(0, MAX_CANDIDATES);
  }

  // how many times this directive's SHAPE has been seen (0 if shapeless/unknown). Drives the "recurring" salience
  // signal for the memory beat — a lower bar (RECUR_MIN) than the seed THRESHOLD, since "seen before" ≠ "mint a recipe".
  function seenCount(state, text) {
    if (!state || !state.shapes) return 0;
    const key = normalizeShape(text);
    if (!key) return 0;
    const s = state.shapes[key];
    return s ? (s.count || 0) : 0;
  }

  function markMinted(state, key) { if (state && state.shapes && state.shapes[key]) state.shapes[key].minted = true; return state; }
  function markDismissed(state, key) { if (state && state.shapes && state.shapes[key]) state.shapes[key].dismissed = true; return state; }
  // tally that a shape was OFFERED as a seed nudge (whether or not the user acted). candidates(opts.maxProposed)
  // uses this to stop re-offering an ignored shape — the durable counterpart to the in-memory per-session cap.
  function markProposed(state, key) { if (state && state.shapes && state.shapes[key]) state.shapes[key].proposed = (state.shapes[key].proposed || 0) + 1; return state; }

  function setEnabled(state, on) { if (state) state.enabled = !!on; return state; }
  function forget(state) { const keep = state && typeof state.enabled === 'boolean' ? state.enabled : true; return { v: 1, shapes: {}, enabled: keep }; }

  // defensive load of a (possibly malformed / old) persisted blob → always a valid state.
  function hydrate(blob) {
    const s = fresh();
    if (!blob || typeof blob !== 'object') return s;
    s.enabled = typeof blob.enabled === 'boolean' ? blob.enabled : true;
    if (blob.shapes && typeof blob.shapes === 'object') {
      for (const key in blob.shapes) {
        const r = blob.shapes[key];
        if (!r || typeof r !== 'object') continue;
        const count = Number(r.count);
        if (!Number.isFinite(count) || count <= 0) continue;
        const examples = Array.isArray(r.examples) ? r.examples.filter(e => typeof e === 'string').slice(-MAX_EXAMPLES) : [];
        s.shapes[key] = {
          count: Math.floor(count),
          examples,
          minted: !!r.minted,
          dismissed: !!r.dismissed,
          lastAt: Number.isFinite(Number(r.lastAt)) ? Number(r.lastAt) : 0,
          proposed: Number.isFinite(Number(r.proposed)) && Number(r.proposed) > 0 ? Math.floor(Number(r.proposed)) : 0
        };
      }
    }
    // enforce the same bound observe() does, so a large / hand-edited / future-cap blob can't bypass it across
    // reloads — keep the strongest shapes (highest count, then most-recent), drop the rest.
    const keys = Object.keys(s.shapes);
    if (keys.length > MAX_SHAPES) {
      keys.sort((a, b) => (s.shapes[b].count - s.shapes[a].count) || ((s.shapes[b].lastAt || 0) - (s.shapes[a].lastAt || 0)));
      const trimmed = {};
      keys.slice(0, MAX_SHAPES).forEach(k => { trimmed[k] = s.shapes[k]; });
      s.shapes = trimmed;
    }
    return s;
  }

  return {
    THRESHOLD, RECUR_MIN, MAX_CANDIDATES, MAX_SHAPES,
    normalizeShape, fresh, observe, induceTemplate, candidates, seenCount,
    markMinted, markDismissed, markProposed, setEnabled, forget, hydrate
  };
});
