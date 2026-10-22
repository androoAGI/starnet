/* AGENT OS — recruiter.js : the PURE adaptive-recruitment matcher (the "which teammate to recruit NEXT" brain).

   Given what the Commander ACTUALLY does (the worksignal capability histogram), what they're interested in (the
   profile affinity vector), what they've told the station (the dossier goals/pain/ambition beliefs), and who's
   already on the crew (the roster), rank the catalog classes NOT yet rostered and return the single best NEW hire
   with an HONEST, counter-derived reason.

   TRUTHFUL TELEMETRY LAW (non-negotiable): every `why` string is derived from a REAL persisted counter — the
   dominant capability lane the Commander's work leaned on, or the matched goal/pain text. Confidence reflects
   evidence VOLUME; below the warm threshold (the shared CALIBRATING_N sample floor) recommend() returns an EMPTY
   list so the UI falls back to the honest cold-start lineup. Never fabricate a reason, never pad the list.

   PURE + deterministic: no Date.now / Math.random (the clock is injected as `now`); given the same inputs it
   returns the same ranked list in the same order. A `Recruiter` global in the browser, module.exports under node.
   It leans on the pure WorkSignal engine (LANES + laneWeight + laneTag) to read the histogram — the ONE source of
   the capability vocabulary, so the matcher can never drift from what the store records. */
'use strict';
(function (root, factory) {
  const WS = (typeof module !== 'undefined' && module.exports) ? require('./worksignal.js') : root.WorkSignal;
  const TM = (typeof module !== 'undefined' && module.exports)
    ? (() => { try { return require('./topicmatch.js'); } catch (_) { return null; } })()
    : (root.TopicMatch || null);
  const api = factory(WS, TM);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Recruiter = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (WorkSignal, TopicMatch) {
  'use strict';

  // scoring weights (one place to retune the blend). kit-affinity is the CORE new signal; coverage-gap is the
  // "you do this work and nobody covers it" boost; dossier + profile are supporting priors.
  const W_KIT = 4;        // overlap of the class kit with the capability histogram (dominant term)
  const W_GAP = 3;        // the class covers a high-volume lane whose dominant tag no rostered class shares
  const W_DOSSIER = 2;    // keyword match of blurb/tags against goals+pain+ambition belief texts
  const W_PROFILE = 1;    // profile interest affinity — a mild prior

  // the shared warm sample floor — READ from WorkSignal.CALIBRATING_N (the single source of truth, currently 3),
  // never a duplicated literal that can drift stale. The `: 0` arm is inert: it's only reached when WorkSignal is
  // absent, in which case recommend()'s `!WorkSignal` guard short-circuits to the cold-start lineup before CAL_N
  // is ever compared, so no magic number is duplicated here.
  const CAL_N = (WorkSignal && Number.isFinite(WorkSignal.CALIBRATING_N)) ? WorkSignal.CALIBRATING_N : 0;
  const LANES = (WorkSignal && WorkSignal.LANES) || [];

  // the plain-English power word for a capability lane — for the honest "your work used the WEB" reason. Mirrors
  // worldmodel's CAP_LABEL (kept here so the pure matcher has no DOM/worldmodel dependency); a lane with no power
  // word falls back to its own name.
  const LANE_WORD = {
    dish: 'web research', cabinet: 'the files', notebook: 'memory', workbench: 'the terminal',
    studio: 'image work', connector: 'live tools', computer: 'compute', orchestrator: 'delegation', jukebox: 'music control'
  };
  function laneWord(lane) { return LANE_WORD[lane] || String(lane || '').toLowerCase(); }

  /* THE ONE GOAL MATCHER (2026-08-05) — Recipes.goalKeywordHits, the same function the FOR YOU row and the bay's
     specialist shelf now call. This file used to carry its own tokenizer with NO stoplist and a bare `indexOf`,
     so a dossier sentence scored the W_DOSSIER term on function words ("you", "with", "want") and on fragments
     buried inside longer words. The shared matcher is word-wise, stoplisted, suffix-aware, and reads only the
     class's READABLE text (name + tagline + blurb) — never its tag keys, which are internal lane vocabulary.
     Resolved LAZILY, never captured at load: index.html loads recruiter.js BEFORE recipes.js, so a load-time
     binding would be null forever in the browser. No matcher available → NO dossier term (0), never a second
     local matcher — a divergent fallback is exactly the drift this unification exists to end. */
  const RECIPES_NODE = (typeof module !== 'undefined' && module.exports)
    ? (() => { try { return require('./recipes.js'); } catch (_) { return null; } })()
    : null;
  function goalMatcher() {
    const R = RECIPES_NODE || ((typeof globalThis !== 'undefined' && globalThis.Recipes) || null);
    return (R && R.goalKeywordHits) ? R.goalKeywordHits : null;
  }
  function keywordHits(cls, text) {
    if (!cls || !text) return 0;
    const hits = goalMatcher();
    if (!hits) return 0;
    return hits({ name: cls.name || '', tagline: cls.tagline || '', blurb: cls.blurb || '' }, text).length;
  }

  // the dominant interest tag of a class (its heaviest kit-agnostic tag weight) — for the coverage-gap test.
  function classDominantTag(cls) {
    let best = null, bv = 0; const t = (cls && cls.tags) || {};
    for (const k in t) { const v = Number(t[k]); if (isFinite(v) && v > bv) { bv = v; best = k; } }
    return best;
  }

  // recommend(): the whole matcher. Returns { warm:boolean, items:[{ classId, why, confidence, evidence }] }.
  // opts = { worksignal (raw histogram model), profile ({score,explain} or null), dossier ({goals,pain,ambition}
  //          belief-text arrays), roster (occupied specialtyIds []), catalog (Specialties.builtins() []), now }.
  function recommend(opts) {
    opts = opts || {};
    const now = Number.isFinite(opts.now) ? opts.now : 0;
    const sig = opts.worksignal || null;
    const catalog = Array.isArray(opts.catalog) ? opts.catalog : [];
    const rostered = new Set((opts.roster || []).filter(Boolean));
    const preferenceModel = opts.preferenceModel && typeof opts.preferenceModel === 'object' ? opts.preferenceModel : null;
    const preferenceFor = (cls) => {
      if (!preferenceModel) return 0;
      const rows = [];
      const kind = preferenceModel.kinds && (preferenceModel.kinds.recruit || preferenceModel.kinds.prospect);
      if (kind && Number.isFinite(kind.weight)) rows.push(kind.weight);
      const traits = preferenceModel.traits || {};
      const keys = [cls.id].concat(cls.kit || [], Object.keys(cls.tags || {}).filter(k => Number(cls.tags[k]) > 0));
      for (const key of keys) { const row = traits[String(key || '').toLowerCase()]; if (row && Number.isFinite(row.weight)) rows.push(row.weight); }
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0;
    };

    // WARM GATE: below the shared sample floor the histogram hasn't earned a read — return empty so the bay falls
    // back to the honest cold-start lineup (never a fabricated "curated" pick).
    const samples = (sig && Number.isFinite(sig.total)) ? sig.total : 0;
    if (!WorkSignal || samples < CAL_N) return { warm: false, items: [] };

    // the capability vector + the dominant lane of the Commander's real work.
    const summ = WorkSignal.summary(sig, now);
    const dominantLane = summ.dominant;

    // which interest tags are ALREADY covered by a rostered class (for the coverage-gap boost).
    const coveredTags = new Set();
    for (const cls of catalog) { if (rostered.has(cls.id)) { const t = classDominantTag(cls); if (t) coveredTags.add(t); } }

    // dossier belief text (goals + pain + ambition) — the Commander's stated direction.
    const dossierText = [].concat(opts.dossier && opts.dossier.goals || [], opts.dossier && opts.dossier.pain || [], opts.dossier && opts.dossier.ambition || []).filter(Boolean).join(' ');

    const scored = [];
    catalog.forEach((cls, idx) => {
      if (!cls || rostered.has(cls.id)) return;   // never recommend a class already on the roster
      const kit = Array.isArray(cls.kit) ? cls.kit : [];

      // (a) KIT-AFFINITY — how much of the Commander's real work lands in the lanes this class's kit covers. The
      // heaviest single kit lane is the honest "reason" anchor.
      let kitAff = 0, bestLane = null, bestLaneW = 0;
      for (const lane of kit) {
        const w = WorkSignal.laneWeight(sig, lane, now);
        kitAff += w;
        if (w > bestLaneW) { bestLaneW = w; bestLane = lane; }
      }

      // (b) COVERAGE GAP — this class's dominant tag matches the tag of high-volume work AND no rostered class
      // already covers that tag. Uses the lane the Commander works in most and the tag they do there.
      const cTag = classDominantTag(cls);
      const domLaneTag = dominantLane ? WorkSignal.laneTag(sig, dominantLane, now) : null;
      const coversGap = !!(cTag && kitAff > 0 && !coveredTags.has(cTag) &&
        (cTag === domLaneTag || (dominantLane && kit.indexOf(dominantLane) >= 0)));
      const gap = coversGap ? 1 : 0;

      // (c) DOSSIER match — keyword overlap of blurb/tags with goals+pain+ambition text.
      const dossierHits = keywordHits(cls, dossierText);

      // (d) PROFILE affinity — a mild interest prior (0..1), only when a profile scorer is supplied.
      const profAff = (opts.profile && typeof opts.profile.score === 'function') ? (Number(opts.profile.score(cls.tags || {})) || 0) : 0;
      const outcomePreference = preferenceFor(cls);

      const v = kitAff * W_KIT + gap * W_GAP + Math.min(dossierHits, 3) * W_DOSSIER + profAff * W_PROFILE + outcomePreference * 3;
      // (only classes the Commander's work actually TOUCHES are eligible — a zero-kit-affinity class has no honest
      // workflow reason to be "curated", so it never surfaces even if the dossier keyword-matches.)
      if (kitAff <= 0) return;

      // the honest WHY — anchored on the heaviest lane this class's kit covers (a real persisted counter), plus the
      // coverage-gap phrasing when it applies. Never fabricated.
      let why;
      const word = laneWord(bestLane);
      if (coversGap && domLaneTag) {
        why = 'most of your recent work used ' + word + ' and no one on the crew covers ' + tagWord(cTag);
      } else {
        why = 'your recent work leaned on ' + word + ' — ' + (cls.tagline || cls.name).toLowerCase();
      }

      // confidence reflects EVIDENCE VOLUME: the share of the Commander's work this class's kit captures, lifted
      // toward 1 as the sample count clears the floor. Honest 0..1 — never a fabricated high number on thin data.
      const share = clamp01(kitAff);                                    // 0..1 (the vector is normalized)
      const volume = clamp01(samples / (CAL_N * 4));                    // ramps to 1 at ~4x the floor
      // 0.35 is an arbitrary FLOOR, chosen so a warm-but-thin read still reports something rather than ~0; the
      // band it produces is 0.35..0.85, entirely below 1. recommend.js maps strength onto a [0.5..1] multiplier,
      // so this number can only ever DISCOUNT the recruit candidate — it can never inflate one. That asymmetry
      // is the honest reading and the reason the exact floor does not need defending.
      const confidence = clamp01(0.35 + 0.5 * share * (0.5 + 0.5 * volume));

      scored.push({ classId: cls.id, why, confidence,
        evidence: { kitAffinity: round(kitAff), dominantLane, bestLane, coversGap, dossierHits, profileAffinity: round(profAff), outcomePreference: round(outcomePreference), samples },
        _v: v, _idx: idx });
    });

    scored.sort((a, b) => (b._v - a._v) || (a._idx - b._idx));   // deterministic: score desc, catalog order tie-break
    const items = scored.slice(0, 3).map(x => ({ classId: x.classId, why: x.why, confidence: round(x.confidence), evidence: x.evidence }));
    return { warm: true, items };
  }

  /* ============================ THE INTEREST GAP — the one recommendation recommend() structurally cannot make
     ============================================================================================================
     recommend() above is deliberately walled: a class with `kitAff <= 0` returns early, so a class is only ever
     eligible if the Commander's work ALREADY touched the lanes its kit covers. That wall is load-bearing — it is
     what stops the curated shelf inventing a workflow reason — but it also means the bay can only ever recommend
     MORE OF WHAT YOU ALREADY DO. It can never say the most valuable thing a recruiter can say: "you keep asking
     about X and nobody here can do it." An echo chamber cannot grow the station.

     So this is a SEPARATE path, not a loosening of that gate. recommend() is untouched, byte-for-byte. This one
     reads the LEARNED TOPIC histogram (sidecar/interests.js — folded only from real observed activity, each topic
     carrying its evidence quote) and asks a different question: is there a WARM topic that NO ONE ON THE CREW
     covers? If so, name the catalog class that does. The claim is honest because both halves are real persisted
     counters — the topic's own observation count, and the crew's actual coverage — and the surface says exactly
     what it checked. When nothing is warm, or the crew already covers everything warm, it returns NOTHING (the
     bay then renders what it renders today: this can only ever ADD a shelf where there was none).

       opts = { topics (interests.summary rows), roster ([specialtyId]), rosterSpecs ([{name,tagline,blurb,tags}] —
                the crew's REAL specs, including custom classes the catalog doesn't contain), catalog, limit }
     Returns { items: [{ classId, why, topic:{label,count,weight}, coverage, evidence }] }. */
  const GAP_LIMIT = 2;            // at most two uncovered topics surfaced at once — a shelf, not a backlog
  const GAP_MAX_TOPICS = 4;       // only the strongest warm topics are worth a hire recommendation
  function interestGaps(opts) {
    opts = opts || {};
    if (!TopicMatch || !TopicMatch.warmTopics) return { items: [] };
    const warm = TopicMatch.warmTopics(opts.topics).slice(0, GAP_MAX_TOPICS);
    if (!warm.length) return { items: [] };
    const catalog = Array.isArray(opts.catalog) ? opts.catalog : [];
    const rostered = new Set((opts.roster || []).filter(Boolean));
    // the crew's real corpora: every rostered catalog class PLUS any explicitly-passed specs (custom classes the
    // catalog never held). A topic one of these covers is NOT a gap, whatever the catalog could also serve.
    const crew = [];
    for (const cls of catalog) if (rostered.has(cls && cls.id)) crew.push(corpusOf(cls));
    for (const s of (Array.isArray(opts.rosterSpecs) ? opts.rosterSpecs : [])) if (s) crew.push(corpusOf(s));
    const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : GAP_LIMIT;
    const items = []; const taken = new Set();
    for (const topic of warm) {
      if (items.length >= limit) break;
      if (crew.some(c => TopicMatch.coversTopic(topic, c))) continue;         // somebody on the crew already does this
      // the catalog class that covers it best; catalog order breaks ties (deterministic, mirrors recommend()).
      let best = null;
      catalog.forEach((cls, idx) => {
        if (!cls || rostered.has(cls.id) || taken.has(cls.id)) return;
        const cov = TopicMatch.coverage(topic.label, corpusOf(cls));
        if (cov <= TopicMatch.MIN_COVERAGE) return;
        if (!best || cov > best.cov) best = { cls, cov, idx };
      });
      if (!best) continue;                                                    // nothing in the catalog covers it either
      taken.add(best.cls.id);
      items.push({
        classId: best.cls.id,
        // the same receipt the other topic-backed shelves now show, composed by the ONE helper that owns the
        // clip and the speaker-neutral frame (TopicMatch.evidenceLine). The gap clause keeps the last word —
        // it is the point of this shelf — so the quote sits behind the count it corroborates.
        why: 'you keep working on ' + String(topic.label) + (topic.count > 0 ? ' (seen ' + Math.floor(topic.count) + '×)' : '') +
             ((TopicMatch && TopicMatch.evidenceLine && Array.isArray(topic.evidence) && topic.evidence[0])
               ? (' — ' + TopicMatch.evidenceLine(topic.evidence[0])) : '') +
             ' — nobody on the crew covers it',
        topic: { label: String(topic.label), count: Math.floor(Number(topic.count) || 0), weight: round(topic.weight) },
        coverage: round(best.cov),
        evidence: (Array.isArray(topic.evidence) ? topic.evidence.slice(0, 1) : [])
      });
    }
    return { items: items };
  }
  // the searchable text of a class — the SAME corpus shape the archetype matcher reads, so "covers this topic"
  // means one identical thing wherever it is asked.
  function corpusOf(cls) {
    return ((cls && cls.name) || '') + ' ' + ((cls && cls.tagline) || '') + ' ' + ((cls && cls.blurb) || '') + ' ' +
      ((cls && cls.purpose) || '') + ' ' + Object.keys((cls && cls.tags) || {}).join(' ');
  }

  function tagWord(tag) { return tag === 'code' ? 'that engineering work' : tag === 'research' ? 'that research work' : 'that work'; }
  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
  function round(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

  return { recommend, interestGaps, _keywordHits: keywordHits, _classDominantTag: classDominantTag, _corpusOf: corpusOf,
    CAL_N, W_KIT, W_GAP, W_DOSSIER, W_PROFILE, GAP_LIMIT, GAP_MAX_TOPICS };
});
