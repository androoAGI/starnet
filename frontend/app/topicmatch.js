/* AGENT OS — topicmatch.js : the ONE pure matcher between a LEARNED INTEREST TOPIC and a candidate's text.

   WHY THIS EXISTS — the station learns what the Commander actually keeps working on in sidecar/interests.js: a
   decayed histogram of SPECIFIC topics ("gpu price tracking", "songwriting"), each carrying the verbatim evidence
   quote that earned it. Until now that signal only reached the LLM drafting paths (the scout's directives, the
   quest refresh) and the archetype matcher. Every DETERMINISTIC recommendation surface — the FOR YOU recipe row,
   the class shelves, the night shift's focus resolver — still ranked on the 3-bucket code/research/general profile
   and capability lanes, which cannot tell "stock research" from "song lyrics". This module is the shared bridge:
   one matcher, one set of thresholds, so a topic means the SAME thing on every surface it now feeds.

   IT IS DELIBERATELY THE SAME ALGORITHM the archetype matcher already ships (scout.js matchArchetype): ≥4-char
   tokens, a crude stem, a stopword list that drops words which would match everything, and COVERAGE scoring — a
   topic only counts when the candidate's corpus matches a MAJORITY of its tokens, and it scores weight×coverage.
   Copied here rather than imported (the mint-ledger/scout precedent: pure modules stay standalone), so behaviour
   is identical and neither copy can drift silently — test/topicmatch.test.js pins the shared thresholds.

   THE ANCHOR RULE (the safety property this whole lane rests on): match() returns null unless at least one hit is
   a WARM habit (decayed weight ≥ WARM_WEIGHT, the same floor interests.warm() uses). Below that the contribution
   is EXACTLY ZERO — so every consumer's ranking is byte-identical to what it produced before this module existed
   until the station has genuinely learned something, and a thin/cold histogram can never move a recommendation.

   TRUTHFUL TELEMETRY: reason() renders the WHY from the topic's OWN persisted counters (its label + observation
   count) — never a synthesized pitch. A consumer may only cite a topic this module actually matched.

   PURE: no Date.now / Math.random / fs / network — decay is applied by the caller (interests.summary already
   hands out live decayed weights). A `TopicMatch` global in the browser, module.exports under node. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TopicMatch = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WARM_WEIGHT = 0.8;     // mirrors interests.WARM_WEIGHT / scout.ARCH_MIN_TOPIC_WEIGHT — a real habit, not a one-off
  const MIN_COVERAGE = 0.5;    // the corpus must match a MAJORITY of a topic's tokens (a single graze is not a match)
  const MIN_TOKEN = 4;         // shorter words carry no topic signal

  // generic words that would match every candidate (or nothing about the JOB) — never count as a topic hit.
  // VERBATIM from scout.js ARCH_STOP: the two lists must stay identical or the archetype shelf and the ranked
  // shelves would disagree about what a topic even is.
  const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'their', 'about', 'into',
    'over', 'what', 'when', 'work', 'working', 'works', 'task', 'tasks', 'project', 'projects', 'daily', 'weekly',
    'general', 'station', 'commander', 'agent', 'agents', 'using', 'help', 'helping', 'stuff', 'things', 'keep',
    'keeps', 'other', 'some', 'more', 'most', 'like', 'time', 'times', 'every', 'each', 'never', 'always']);

  const str = (v) => (v == null ? '' : String(v));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // crude stem so "translation" hits "translates", "pricing" hits "prices" (substring match on the corpus).
  function stem(tok) { return str(tok).replace(/(ings?|ions?|ed|es|s)$/, ''); }

  // the significant, stemmed tokens of a topic label. Empty => that topic can never match anything (by design).
  function tokens(text) {
    return str(text).toLowerCase().split(/[^a-z0-9]+/)
      .filter(t => t.length >= MIN_TOKEN && !STOP.has(t))
      .map(stem)
      .filter(t => t.length >= MIN_TOKEN);
  }

  // 0..1 — the share of a topic's tokens the corpus contains. A topic with no significant tokens scores 0.
  function coverage(topicLabel, corpus) {
    const toks = tokens(topicLabel);
    if (!toks.length) return 0;
    const hay = str(corpus).toLowerCase();
    if (!hay) return 0;
    let hit = 0;
    for (const t of toks) if (hay.indexOf(t) !== -1) hit++;
    return hit / toks.length;
  }

  // does this candidate corpus COVER the topic (a majority of its tokens)? The roster-coverage test reads this.
  function coversTopic(topic, corpus, opts) {
    const min = Number.isFinite(opts && opts.minCoverage) ? opts.minCoverage : MIN_COVERAGE;
    return coverage(topic && topic.label, corpus) > min;
  }

  // the WARM topics of a summary (interests.summary rows), strongest first. The one place the warm floor is read.
  function warmTopics(topics, minWeight) {
    const floor = Number.isFinite(minWeight) ? minWeight : WARM_WEIGHT;
    return (Array.isArray(topics) ? topics : [])
      .filter(t => t && str(t.label) && num(t.weight) >= floor)
      .slice()
      .sort((a, b) => (num(b.weight) - num(a.weight)) || (num(b.count) - num(a.count)));
  }

  /* match — score a candidate corpus against the learned topics.
       topics: interests.summary() rows [{ label, weight, count, evidence[] }] (weights already decayed to now)
       corpus: the candidate's searchable text (name + tagline + blurb + tags…)
     Returns null when nothing WARM matched (the anchor rule — a zero contribution, byte-identical to before),
     else { score, hits:[{label,weight,count,coverage,evidence}], top } where score = Σ weight×coverage and `top`
     is the strongest hit (the one a WHY may cite). */
  function match(topics, corpus, opts) {
    opts = opts || {};
    const minCoverage = Number.isFinite(opts.minCoverage) ? opts.minCoverage : MIN_COVERAGE;
    const minWeight = Number.isFinite(opts.minWeight) ? opts.minWeight : WARM_WEIGHT;
    const hay = str(corpus).toLowerCase();
    if (!hay) return null;
    let score = 0; const hits = [];
    for (const t of (Array.isArray(topics) ? topics : [])) {
      if (!t || !str(t.label)) continue;
      const w = num(t.weight);
      if (w <= 0) continue;
      const cov = coverage(t.label, hay);
      if (cov <= minCoverage) continue;
      score += w * cov;
      hits.push({ label: str(t.label), weight: w, count: Math.max(0, Math.floor(num(t.count))), coverage: cov, evidence: Array.isArray(t.evidence) ? t.evidence.slice(0, 1) : [] });
    }
    // THE ANCHOR RULE: one stray brush against a barely-observed topic is not a signal. Without a warm hit the
    // whole match is discarded, so a cold/calibrating histogram contributes exactly nothing anywhere.
    if (!hits.length || !hits.some(h => h.weight >= minWeight)) return null;
    const top = hits.slice().sort((a, b) => (b.weight - a.weight) || (b.coverage - a.coverage))[0];
    return { score: score, hits: hits, top: top };
  }

  /* term — the BOUNDED ranking contribution of a match, for a surface whose other terms have a known scale.
     Deliberately capped: a topic is strong evidence, but a long-lived histogram grows weights without bound
     (interests.fold does w = decayed + 1 per observation), so an uncapped term would eventually swamp every
     other signal and freeze the shelf on one subject. cap/scale are the caller's (it knows its own scale). */
  function term(m, scale, cap) {
    if (!m || !(num(m.score) > 0)) return 0;
    const s = Number.isFinite(scale) ? scale : 1;
    const c = Number.isFinite(cap) ? cap : Infinity;
    return Math.min(c, num(m.score) * s);
  }

  /* THE RECEIPT (2026-08-05) — show the quote, not just the count.

     Every topic in the histogram carries the VERBATIM fragment that earned it (sidecar/interests.js keeps up to
     EVIDENCE_CAP per topic, each one grounded against the real activity line it was quoted from, and its header
     states the law: a recommendation downstream may cite THIS evidence and nothing else). match() has been
     carrying that quote through on every hit — and every surface threw it away, rendering "you keep working on
     gpu price tracking (seen 4×)". The Commander was asked to take the count on faith when the station was
     holding the receipt the whole time.

     ⛔ THE FRAME CLAIMS NO SPEAKER, AND THAT IS DELIBERATE. It would be easy to write `because you said "…"`, and
     wrong: interests quotes an ACTIVITY LINE, and contextpack's activity pool is runs + completed-task briefs +
     chat openings + the goal + landed deliverable titles. A run title is very often machine-composed (a recipe
     launch, a scheduled brief) and a landed title is the STATION's own words. So the quote is real evidence with
     unknown authorship — exactly the case chat.js's recCite already answers with a neutral citation rather than
     putting words in the Commander's mouth. "e.g." is also the phrasing sidecar/interests.topicsBlock already
     uses for this same data, so the station cites its own histogram one way everywhere.

     Visibly truncated when clipped (the repo's citation law: a cut quote must LOOK cut, so it can never read as
     a sentence the Commander never finished). */
  const QUOTE_MAX = 72;
  function evidenceLine(quote, max) {
    const q = str(quote).replace(/\s+/g, ' ').replace(/^["“”']+|["“”']+$/g, '').trim();
    if (!q) return '';
    const cap = Number.isFinite(max) ? max : QUOTE_MAX;
    const cut = q.length > cap ? (q.slice(0, Math.max(1, cap - 1)) + '…') : q;
    return 'e.g. “' + cut + '”';
  }

  // the honest WHY for a matched topic — derived ONLY from its real persisted counters, plus the verbatim
  // receipt behind them when the topic carries one. Never a synthesized pitch.
  function reason(topOrMatch, opts) {
    opts = opts || {};
    const top = (topOrMatch && topOrMatch.top) ? topOrMatch.top : topOrMatch;
    if (!top || !str(top.label)) return '';
    const n = Math.max(0, Math.floor(num(top.count)));
    const lead = str(opts.lead) || 'you keep working on';
    const base = lead + ' ' + str(top.label) + (n > 0 ? ' (seen ' + n + '×)' : '');
    if (opts.quote === false) return base;
    const ev = evidenceLine(Array.isArray(top.evidence) ? top.evidence[0] : '', opts.quoteMax);
    return ev ? (base + ' — ' + ev) : base;
  }

  return {
    match, term, reason, evidenceLine, coverage, coversTopic, warmTopics, tokens, stem,
    WARM_WEIGHT, MIN_COVERAGE, MIN_TOKEN, STOP, QUOTE_MAX
  };
});
