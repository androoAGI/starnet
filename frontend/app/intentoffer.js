/* AGENT OS — intentoffer.js : the INTENT OFFER matcher.

   The Recruitment Bay and the recipe library hold 38 preconfigured classes and 50 ready-made jobs, and
   both live two clicks deep inside a bottom-bar popover. A Commander who never opens those doors never
   learns they exist. This module closes that gap from the other side: when what they just TYPED is
   plainly the job of a class or a recipe, the station says so, once, in COMMS — where they already are.

   The whole design problem is PRECISION. A discovery card that fires on a vague match is noise, and
   noise in the COMMS beat slot is worse than the undiscovered feature. So the match must be earned:

     • DISTINCTIVE TERMS ONLY. Every candidate's text is scored with inverse document frequency across
       the live catalog, so a word that appears in one class ("lease", "refund", "overnight", "resume")
       carries weight and a word that appears in thirty ("write", "help", "find") carries almost none.
       This self-maintains: adding a class that also says "contract" automatically de-weights the term
       for everyone, instead of drifting away from a hand-written keyword list.
     • A CLEAR WINNER. The top candidate must beat the runner-up by a real margin. Two plausible matches
       means the station does not actually know, and it stays silent rather than guessing.
     • A REAL SIGNAL. At least one matched term must clear the distinctiveness floor on its own — a pile
       of weak overlaps never adds up to an offer.

   Silence is the default and the honest answer. Everything here is pure (no DOM, no clock, no storage)
   so the thresholds are pinned by test/intent-offer.test.js against real phrasings.
   UMD-light: an `IntentOffer` global in the browser, module.exports under node. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.IntentOffer = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // words that carry no intent. Deliberately generous: a stop word costs nothing (idf would near-zero it
  // anyway), while a missed one can only ever add noise to the score.
  const STOP = new Set(('a about all also am an and any are as at back be been being but by can cant could did do does '
    + 'doing done dont down each even every for from get gets getting give go going good got had has have having he her '
    + 'here hers him his how i if in into is it its ive just keep let like ll make many may me might mine more most much '
    + 'my need needs new no nor not now of off on once one only or other our out over own please put re really right '
    + 'said same say see should show so some something still such sure take tell than that the their them then there '
    + 'these they thing things this those through to too try up us use using very want wants was way we well were what '
    + 'when where which while who why will with would you your yours '
    // POSITIONAL TIME WORDS carry no topic. Left in, "prep me for an interview next week" scored a recipe on
    // "next"+"week" hard enough to tie the job hunter out of its own match — calendar adverbials must not vote.
    // Deliberately NOT stopped: week, month, day, night, morning — those ARE topical for some classes
    // (a week of meals, the night shift).
    + 'next last today tomorrow yesterday soon later ago again already yet').split(' '));

  // a crude, deterministic stem — enough to join plural/gerund forms without a stemmer's false merges.
  function stem(w) {
    w = String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (w.length > 4) {
      if (/ies$/.test(w)) w = w.slice(0, -3) + 'y';
      else if (/(sses|shes|ches|xes)$/.test(w)) w = w.slice(0, -2);
      else if (/[^s]s$/.test(w)) w = w.slice(0, -1);
    }
    if (w.length > 6 && /ing$/.test(w)) w = w.slice(0, -3);
    else if (w.length > 5 && /ed$/.test(w)) w = w.slice(0, -2);
    return w;
  }

  // the distinct content terms in a string (order-free; a term counted once however often it repeats —
  // repetition is emphasis, not evidence).
  function terms(s) {
    const out = new Set();
    for (const raw of String(s || '').toLowerCase().split(/[^a-z0-9']+/)) {
      if (!raw) continue;
      const w = stem(raw);
      if (w.length < 3) continue;          // "up", "it", ids — never diagnostic
      if (STOP.has(w) || STOP.has(raw)) continue;
      out.add(w);
    }
    return out;
  }

  /* ---------- tuning ----------
     Pinned by test/intent-offer.test.js against real phrasings (both the asks that MUST match and the
     chatter that must NOT). Raise MIN_SCORE / MARGIN to make the station quieter; never lower them to
     make a demo fire. */
  // NOTE this counts RAW words, not content terms. Counting content terms looked equivalent and was not:
  // "rewrite this so it sounds like me" carries exactly two content terms and is obviously an intent, while
  // "what do you think" carries four raw words and zero content terms. Raw length only has to prove the
  // Commander typed a sentence rather than an acknowledgement; the score gates below do the real work.
  const MIN_QUERY_WORDS = 3;   // "hi" / "thanks!" / "ok cool" can never carry an intent
  const MIN_SCORE = 3.2;       // total idf weight the winner must carry
  const MIN_TOP_IDF = 1.9;     // at least ONE genuinely distinctive term (~<15% of the catalog uses it)
  const MARGIN = 1.45;         // the winner must beat the runner-up by this factor — else we don't know
  // CORROBORATION. A single rare word is not an intent: "explain what you just did" hits the tutor's blurb on
  // "explain" and nothing else, and one high-idf term alone clears MIN_SCORE on its own. So an offer needs two
  // matched terms — UNLESS the lone term landed in the candidate's own NAME or TAGLINE and is very distinctive
  // ("I need a paralegal"), which is the Commander naming the thing outright.
  const MIN_HITS = 2;
  const SOLO_HEADLINE_IDF = MIN_TOP_IDF * 2;

  // candidates: [{ kind:'class'|'recipe', id, name, label, text }]. `text` is the matchable surface
  // (name + tagline + blurb + starters / task) — never the purpose/manual, whose shared vocabulary
  // ("the Commander", "output:", "notebook.write") would blur every class into every other.
  function index(candidates) {
    const list = [];
    const df = Object.create(null);
    for (const c of (candidates || [])) {
      if (!c || !c.id) continue;
      const t = terms(c.text);
      if (!t.size) continue;
      list.push({ c, t });
      for (const w of t) df[w] = (df[w] || 0) + 1;
    }
    return { list, df, n: list.length };
  }

  // idf over the LIVE catalog: a term in one candidate scores high, a term in most scores ~0.
  function idf(df, n, w) {
    const d = df[w] || 0;
    if (!d) return 0;
    return Math.log(n / d);
  }

  /* the match, or null. Returns { kind, id, name, label, score, runnerUp, terms } — `terms` being the
     distinctive words that actually earned it, so the caller can show an honest reason and a test can
     assert WHY something matched, not just that it did. */
  function matchPool(q, candidates) {
    const idx = index(candidates);
    if (idx.n < 2) return null;                       // idf is meaningless without a corpus to compare against

    const scored = [];
    for (const row of idx.list) {
      let score = 0, best = 0, bestHeadline = false, hits = [];
      const head = row.c.headline ? terms(row.c.headline) : null;
      for (const w of q) {
        if (!row.t.has(w)) continue;
        let weight = idf(idx.df, idx.n, w);
        if (weight <= 0) continue;
        // a hit in the NAME or TAGLINE is the most diagnostic place a term can land ("paralegal",
        // "ghostwriter", "nightwatch") — worth more than the same word buried in a blurb.
        const inHead = !!(head && head.has(w));
        if (inHead) weight *= 1.6;
        score += weight;
        if (weight > best) { best = weight; bestHeadline = inHead; }
        hits.push({ w, weight, headline: inHead });
      }
      if (score > 0) scored.push({ row, score, best, bestHeadline, hits });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);

    const top = scored[0], second = scored[1];
    if (top.score < MIN_SCORE) return null;                                  // too thin to speak
    if (top.best < MIN_TOP_IDF) return null;                                 // no genuinely distinctive term
    // Corroboration: one rare word alone is not an intent unless the Commander named the WHOLE class/recipe.
    // Merely sharing one word with a multi-word headline is not naming it: “explain what you just did” must not
    // count as an explicit request for “Explain This Data”. Single-word names (Ghostwriter, Zebrafish) still work.
    const fullyNamed = ['name', 'label'].some(key => {
      const named = terms(top.row.c[key]);
      return named.size > 0 && Array.from(named).every(w => q.has(w));
    });
    if (top.hits.length < MIN_HITS && !(fullyNamed && top.bestHeadline && top.best >= SOLO_HEADLINE_IDF)) return null;
    if (second && top.score < second.score * MARGIN) return null;            // two plausible answers = we don't know

    return {
      kind: top.row.c.kind, id: top.row.c.id, name: top.row.c.name, label: top.row.c.label || '',
      score: Math.round(top.score * 100) / 100,
      runnerUp: second ? top.row.c.id !== second.row.c.id ? second.row.c.id : null : null,
      terms: top.hits.sort((a, b) => b.weight - a.weight).slice(0, 3).map(h => h.w)
    };
  }

  function match(text, candidates) {
    const words = String(text || '').trim().split(/\s+/).filter(w => w.replace(/[^a-z0-9']/gi, '').length >= 2);
    if (words.length < MIN_QUERY_WORDS) return null;
    const q = terms(text);
    if (!q.size) return null;
    const rows = Array.isArray(candidates) ? candidates : [];

    /* Classes and ready-made recipes deliberately overlap: a Legal Assistant owns contract review while the
       library also has a Contract Review job. Scoring them as one flat corpus makes those two truthful doors
       cancel each other at the ambiguity margin as the library grows. The class is the broader, durable hire and
       therefore gets first refusal; recipes remain discoverable whenever no class clears every precision gate. */
    const classMatch = matchPool(q, rows.filter(c => c && c.kind === 'class'));
    if (classMatch) return classMatch;
    return matchPool(q, rows.filter(c => !c || c.kind !== 'class'));
  }

  return { match, terms, stem, index, MIN_SCORE, MIN_TOP_IDF, MARGIN, MIN_QUERY_WORDS };
});
