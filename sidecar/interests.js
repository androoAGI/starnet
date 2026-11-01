/* sidecar/interests.js — the PURE topic-interest engine (Scout lane 1): what does the Commander keep
   asking about?

   WHY THIS EXISTS — the recruitment bay's adaptive shelves (recruiter/prospect) key off CAPABILITY lanes
   (which tools fired) and the recipe shelf keys off a 3-bucket code/research/general profile. Neither knows
   a TOPIC: "asks about stocks a lot", "keeps drafting song lyrics". That missing signal is why the bay
   never drafts the stock-research recipe or the songwriter specialist the Commander's actual work is begging
   for. This module owns the topic signal: a small reason-only extraction pass reads the recent REAL activity
   (the same contextpack "WORKED RECENTLY / ASKED RECENTLY" lines the night shift grounds in) and emits topic
   candidates WITH verbatim evidence; fold() decays + accumulates them into a persisted histogram.

   TRUTHFUL TELEMETRY: every topic carries the evidence quotes that earned it (capped, newest-first) — a
   recommendation downstream may only ever cite THIS evidence, never a synthesized "users like you". A topic
   with no real activity behind it cannot enter the histogram, and an idle station decays back toward empty.

   DETERMINISM SPLIT (mirrors nightshift.js / contextpack.js): every function is a transform over
   (state, args) with `now` INJECTED — no Date.now / Math.random / fs / network — so it passes
   lint-determinism.js and is headless-testable. The ambient half (the aux-model call, the durable file,
   the post-run trigger) lives ONLY in sidecar/index.js.

   THE STATE (one small workspaces JSON, persisted by the host):
     { v, topics: { slug: { label, w, n, lastAt, ev: [{ q, at }] } }, lastPassAt, runsSincePass }
   w = EWMA-style decayed weight (half-life DECAY_HALF_LIFE_MS, applied lazily at fold/read time);
   n = lifetime observation count; ev = the evidence quotes (EVIDENCE_CAP, newest first).
   Optional trustedTopics is an independent histogram minted only by the host after extraction from
   proven clean activity. Old topics remain inspectable; their counts and evidence never become trusted
   merely because a matching topic is observed again. Each histogram has its own eviction budget.

   UMD: (root.SK).interests in a browser-ish global, module.exports under node. */
'use strict';
(function (root, factory) {
  // under node, summary() scrubs each evidence quote through prompt-scrub (see summary)
  const node = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const api = factory(node ? require('./prompt-scrub.js').scrubStored : null);
  if (node) module.exports = api;
  else { (root.SK = root.SK || {}).interests = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scrubStored) {
  'use strict';
  const scrub = typeof scrubStored === 'function' ? scrubStored : (s => s);

  const STATE_VERSION = 1;
  const DECAY_HALF_LIFE_MS = 14 * 86400000;  // 14-day half-life — same horizon as the profile engine
  const MAX_TOPICS = 24;                     // histogram ceiling; the weakest decayed topic is evicted first
  const EVIDENCE_CAP = 3;                    // quotes kept per topic (newest first) — the "why" a card may cite
  const EVIDENCE_MAX = 140;                  // per-quote length cap (a quote is a receipt, not a transcript)
  const LABEL_MAX = 48;
  const PASS_EVERY_RUNS = 5;                 // a pass earns itself: every ~5 qualifying task runs…
  const PASS_MIN_GAP_MS = 30 * 60 * 1000;    // …but never two passes within half an hour
  const PASS_STALE_MS = 6 * 60 * 60 * 1000;  // …and a single run after 6h quiet also qualifies (catch-up)
  const MIN_ACTIVITY_LINES = 2;              // don't burn a model call on an empty activity window
  const MAX_CANDIDATES = 5;                  // per pass — a pass proposes a few strong topics, not a dump
  const WARM_WEIGHT = 0.8;                   // a topic at/above this decayed weight counts as a REAL interest

  // the tagged reply line: TOPIC: <label> | EVIDENCE: <quote>. Anything untagged is ignored (conservative).
  const LINE = /^\s*[-*•]?\s*TOPIC\s*[:\-—]\s*([^|]+?)\s*\|\s*EVIDENCE\s*[:\-—]\s*(.+?)\s*$/i;
  // labels too generic to be an interest — they'd match everyone and recommend nothing specific.
  const GENERIC = new Set(['work', 'tasks', 'projects', 'research', 'coding', 'code', 'writing', 'general',
    'productivity', 'ai', 'help', 'questions', 'chat', 'misc', 'various', 'stuff']);

  const str = (v) => (v == null ? '' : String(v));

  // a stable topic slug: lowercase alphanumeric tokens joined by '-' ("Stock research " -> 'stock-research').
  function slugOf(label) {
    return str(label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).join('-');
  }

  function fresh(now) { return { v: STATE_VERSION, topics: {}, lastPassAt: 0, runsSincePass: 0 }; }

  // tolerant hydrate: clamp every field; a corrupt/partial save degrades per-field to the floor, never throws.
  function normalize(raw, now) {
    const s = fresh(now);
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(raw.lastPassAt) && raw.lastPassAt >= 0) s.lastPassAt = Math.floor(raw.lastPassAt);
      if (Number.isFinite(raw.runsSincePass) && raw.runsSincePass >= 0) s.runsSincePass = Math.floor(raw.runsSincePass);
      if (raw.topics && typeof raw.topics === 'object') {
        for (const k of Object.keys(raw.topics)) {
          const t = raw.topics[k];
          if (!t || typeof t !== 'object') continue;
          const slug = slugOf(k);
          if (!slug) continue;
          s.topics[slug] = {
            label: str(t.label || k).slice(0, LABEL_MAX),
            w: (Number.isFinite(t.w) && t.w >= 0) ? t.w : 0,
            n: (Number.isFinite(t.n) && t.n >= 0) ? Math.floor(t.n) : 0,
            lastAt: (Number.isFinite(t.lastAt) && t.lastAt >= 0) ? Math.floor(t.lastAt) : 0,
            ev: Array.isArray(t.ev)
              ? t.ev.filter(e => e && typeof e === 'object' && str(e.q))
                  .slice(0, EVIDENCE_CAP)
                  .map(e => ({ q: str(e.q).slice(0, EVIDENCE_MAX), at: Number.isFinite(e.at) ? Math.floor(e.at) : 0 }))
              : []
          };
        }
      }
    }
    if (raw && raw.trustedTopics && typeof raw.trustedTopics === 'object' && !Array.isArray(raw.trustedTopics)) {
      // Reuse the same bounded field hydration without promoting the legacy histogram. The recursive
      // input contains only topics, so it cannot recurse through arbitrary persisted trusted fields.
      s.trustedTopics = normalize({ topics: raw.trustedTopics }, now).topics;
    }
    return s;
  }

  // lazy decay: the weight a topic holds NOW, given when it was last touched. Never mutates.
  function decayedWeight(topic, now) {
    if (!topic || !Number.isFinite(topic.w)) return 0;
    const dt = Math.max(0, (Number(now) || 0) - (topic.lastAt || 0));
    return topic.w * Math.pow(0.5, dt / DECAY_HALF_LIFE_MS);
  }

  // observe one qualifying task run (the host calls this post-run; the counter is what earns a pass).
  function noteRun(state, now) {
    const s = normalize(state, now);
    return Object.assign({}, s, { runsSincePass: s.runsSincePass + 1 });
  }

  /* shouldExtract — should an extraction pass fire on THIS post-run tick? Named binding for truthful
     telemetry (the scout ledger records WHY a pass didn't fire). activityCount = how many real activity
     lines the context pack currently holds (no activity → nothing to read → no spend). */
  function shouldExtract(state, inp) {
    const s = normalize(state, inp && inp.now);
    const now = Number(inp && inp.now) || 0;
    const activityCount = Number(inp && inp.activityCount) || 0;
    if (activityCount < MIN_ACTIVITY_LINES) return { fire: false, binding: 'no-activity' };
    if (now - s.lastPassAt < PASS_MIN_GAP_MS) return { fire: false, binding: 'gap' };
    const earned = s.runsSincePass >= PASS_EVERY_RUNS;
    const catchUp = s.runsSincePass >= 1 && (now - s.lastPassAt) >= PASS_STALE_MS;
    if (!earned && !catchUp) return { fire: false, binding: 'cadence' };
    return { fire: true, binding: null };
  }

  // the constrained reason-only extraction directive. ctx = { activityLines: [..], knownTopics: [label..] }.
  function buildDirective(ctx) {
    ctx = ctx || {};
    const lines = [];
    lines.push('You are the station\'s intake analyst. From the Commander\'s REAL recent activity below, extract the');
    lines.push('SPECIFIC recurring topics or domains they are working in — the kind of interest a tailored recipe or a');
    lines.push('specialist crew member could serve (e.g. "stock research", "songwriting", "kubernetes ops").');
    lines.push('');
    lines.push('RECENT ACTIVITY (each line is a real run title or chat opening):');
    for (const a of (ctx.activityLines || []).slice(0, 24)) lines.push('• ' + str(a).slice(0, 160));
    const known = (ctx.knownTopics || []).map(str).filter(Boolean);
    if (known.length) {
      lines.push('');
      lines.push('ALREADY TRACKED (re-list one of these ONLY if the activity above shows it again): ' + known.join(', '));
    }
    lines.push('');
    lines.push('RULES:');
    lines.push('- At most ' + MAX_CANDIDATES + ' topics, each 2-4 words, SPECIFIC (never "coding", "research", "work").');
    lines.push('- EVIDENCE must be a short verbatim fragment quoted from ONE activity line above — never invented.');
    lines.push('- Only topics the activity genuinely shows. If nothing specific recurs, reply exactly: NONE');
    lines.push('');
    lines.push('REPLY, one per line, in exactly this format:');
    lines.push('TOPIC: <2-4 word topic> | EVIDENCE: <short quote from an activity line>');
    return lines.join('\n');
  }

  /* parse — the model's tagged reply -> validated candidates [{ label, slug, evidence }].
     GUARDS: generic labels dropped, over-long labels clipped, evidence must be non-empty AND actually
     overlap the provided activity (a token from the quote must appear in some activity line) so an
     invented quote dies here — the histogram only ever holds evidence that traces to real activity. */
  function parse(text, opts) {
    opts = opts || {};
    const raw = str(text);
    if (/^\s*NONE\s*$/im.test(raw) && !LINE.test(raw)) return [];
    const activityBlob = (opts.activityLines || []).map(a => str(a).toLowerCase()).join('\n');
    const exactEvidence = opts.requireExactEvidence === true;
    const quoteKey = value => str(value).replace(/\s+/g, ' ').trim().toLowerCase();
    const activityLines = exactEvidence ? (opts.activityLines || []).map(quoteKey).filter(Boolean) : [];
    const out = [];
    const seen = new Set();
    for (const ln of raw.split('\n')) {
      const m = LINE.exec(ln);
      if (!m) continue;
      const label = m[1].trim().slice(0, LABEL_MAX);
      const fullEvidence = m[2].trim();
      const evidence = fullEvidence.slice(0, EVIDENCE_MAX);
      const slug = slugOf(label);
      if (!slug || slug.length < 3) continue;
      if (GENERIC.has(slug) || GENERIC.has(label.toLowerCase())) continue;
      if (!evidence) continue;
      if (exactEvidence) {
        // Match the WHOLE quote in one clean source line before clipping for storage. A matching
        // prefix, one shared token, or a splice across two lines cannot authenticate invented text.
        const quote = quoteKey(fullEvidence);
        if (!quote || !activityLines.some(line => line.includes(quote))) continue;
      } else if (activityBlob) {
        // legacy grounding check: at least one significant evidence token must appear in the real activity.
        const toks = evidence.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4);
        if (toks.length && !toks.some(t => activityBlob.indexOf(t) !== -1)) continue;
      }
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ label: label, slug: slug, evidence: evidence });
      if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
  }

  /* fold — apply one pass's candidates to the state: decay every touched topic to `now`, +1 the observed
     ones, keep evidence newest-first, evict the weakest when over MAX_TOPICS, stamp the pass + reset the
     run counter. Pure: returns a NEW state. Folding an EMPTY candidate list still stamps the pass (the
     spend happened; the cadence must not immediately re-fire). */
  function fold(state, candidates, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state, now);
    const topics = {};
    for (const k of Object.keys(s.topics)) topics[k] = Object.assign({}, s.topics[k], { ev: s.topics[k].ev.slice() });
    for (const c of (Array.isArray(candidates) ? candidates : [])) {
      if (!c || !c.slug) continue;
      const slug = slugOf(c.slug);
      if (!slug) continue;
      const cur = topics[slug];
      const decayed = cur ? decayedWeight(cur, now) : 0;
      const ev = cur ? cur.ev.slice() : [];
      if (c.evidence) ev.unshift({ q: str(c.evidence).slice(0, EVIDENCE_MAX), at: now });
      topics[slug] = {
        label: str(c.label || (cur && cur.label) || slug).slice(0, LABEL_MAX),
        w: decayed + 1,
        n: (cur ? cur.n : 0) + 1,
        lastAt: now,
        ev: ev.slice(0, EVIDENCE_CAP)
      };
    }
    // evict beyond the ceiling: weakest decayed weight goes first (ties: oldest lastAt).
    const keys = Object.keys(topics);
    if (keys.length > MAX_TOPICS) {
      keys.sort((a, b) => (decayedWeight(topics[b], now) - decayedWeight(topics[a], now)) || ((topics[b].lastAt || 0) - (topics[a].lastAt || 0)));
      for (const k of keys.slice(MAX_TOPICS)) delete topics[k];
    }
    const out = { v: STATE_VERSION, topics: topics, lastPassAt: now, runsSincePass: 0 };
    if (s.trustedTopics) out.trustedTopics = s.trustedTopics;
    if (opts && opts.trustedActivity === true) {
      // This option is host-only, never read from candidate/model fields. The host calls it only after
      // exact-evidence parsing against proven clean activity. The isolated fold starts from ONLY
      // prior trusted observations: legacy labels, weights, counts and evidence cannot leak across,
      // and a saturated old histogram cannot evict a fresh trusted observation.
      out.trustedTopics = fold({ topics: s.trustedTopics || {} }, candidates, { now: now }).topics;
    }
    return out;
  }

  // summary — the read every consumer uses: topics ranked by live decayed weight, evidence included.
  // SECRETS (context-key-redact, 2026-10-28): a stored quote is the model's verbatim fragment of an activity line, so it
  // can hold a key — typed before the station held it, or cut mid-key. Every read projects it through scrubStored
  // against the LIVE held list (the stored q itself is unchanged), so a value saved later is gone from every prompt too.
  function summary(state, opts) {
    const now = Number(opts && opts.now) || 0;
    const limit = Number(opts && opts.limit) || 8;
    const s = normalize(state, now);
    const topics = opts && opts.trustedOnly === true ? (s.trustedTopics || {}) : s.topics;
    const rows = Object.keys(topics).map(slug => {
      const t = topics[slug];
      return { topic: slug, label: t.label, weight: Math.round(decayedWeight(t, now) * 100) / 100, count: t.n, lastAt: t.lastAt, evidence: t.ev.map(e => scrub(e.q)) };
    }).filter(r => r.weight > 0.05);
    rows.sort((a, b) => (b.weight - a.weight) || (b.lastAt - a.lastAt));
    return rows.slice(0, Math.max(1, limit));
  }

  // warm — does the station KNOW at least one real interest yet? (the scout's warm floor reads this).
  function warm(state, now, opts) {
    const s = normalize(state, now);
    const topics = opts && opts.trustedOnly === true ? (s.trustedTopics || {}) : s.topics;
    for (const slug of Object.keys(topics)) if (decayedWeight(topics[slug], now) >= WARM_WEIGHT) return true;
    return false;
  }

  // topicsBlock — the bounded prompt block a generation directive embeds ("what the Commander cares about").
  function topicsBlock(state, opts) {
    const rows = summary(state, opts);
    if (!rows.length) return '';
    return rows.map(r => '• ' + r.label + ' (seen ' + r.count + '×)' + (r.evidence[0] ? ' — e.g. "' + r.evidence[0] + '"' : '')).join('\n');
  }

  return {
    fresh, normalize, noteRun, shouldExtract, buildDirective, parse, fold, summary, warm, topicsBlock,
    slugOf, decayedWeight,
    PASS_EVERY_RUNS, PASS_MIN_GAP_MS, PASS_STALE_MS, MAX_TOPICS, EVIDENCE_CAP, WARM_WEIGHT, DECAY_HALF_LIFE_MS
  };
});
