/* AGENT OS — dossier.js : the PURE Commander Dossier engine — what the STATION knows about its Commander.

   Phase A of the Commander Dossier (docs/COMMANDER_DOSSIER_PLAN.md): one station-wide, dimensioned,
   local-first model of the human, unifying signals that today are thin + scattered. This is the durable
   BELIEF layer — a small set of named dimensions (identity / stack / goals / style / standing_orders / pain / ambition / people / schedule),
   each holding human-readable beliefs with provenance — that compose into every agent's system prompt so
   the whole station knows the Commander. (The live affinity vector in profile.js is the SEPARATE "what
   you work on" signal; this engine never rewrites it — the store reads it for the panel only.)

   PURE + testable, mirroring profile.js / xp.js: a `Dossier` global in the browser, module.exports under
   node. The clock is ALWAYS injected (`now`) — no Date.now / Math.random here — so ids/timestamps are
   deterministic and node tests can fast-forward time. The browser wiring (dossierstore.js) supplies
   Date.now() at the edge. composeBlock() is built ONLY from durable beliefs (never a volatile signal) so
   the cached system-prompt prefix it produces is byte-identical across runs while the dossier is unchanged. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Dossier = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the dimensions the station models — this array's order IS the render + compose order.
  const DIMS = [
    { key: 'identity',        label: 'Identity',        lead: 'Identity' },
    { key: 'stack',           label: 'Stack & tools',   lead: 'Stack & tools' },
    { key: 'goals',           label: 'Aims',            lead: 'Goals' },   // UI label only — QUESTS owns goals-with-plans
    { key: 'style',           label: 'Working style',   lead: 'Working style' },
    { key: 'standing_orders', label: 'Standing orders', lead: 'Standing orders' },
    { key: 'pain',            label: 'Pain points',     lead: 'Pain points (what eats their time / the work they want gone)' },
    { key: 'ambition',        label: 'Ambitions',       lead: 'Ambitions (what they keep meaning to do but never find time for)' },
    // depth pass (2026-07-18): who the work is FOR and WHEN it should land — the two facts agents kept
    // lacking when drafting outreach/deliverables (people) and scheduling routines/night work (schedule).
    { key: 'people',          label: 'People & audience',  lead: 'People & audience (who they work with / build for / report to)' },
    { key: 'schedule',        label: 'Schedule & cadence', lead: 'Schedule & cadence (timezone, work hours, when work should land)' }
  ];
  const DIM_KEYS = DIMS.map(d => d.key);
  // which onboarding doc seeds which dimension (the Commander already authored these at the awakening).
  const DOC_SEEDS = [
    { doc: 'context', dim: 'identity' },         // context.md = about the Commander & their world
    { doc: 'purpose', dim: 'goals' },            // purpose.md = the mission
    { doc: 'manual',  dim: 'standing_orders' }   // operating-manual.md = standing rules
  ];

  const BLOCK_CHARS = 1600;  // default cap on the composed system-prompt block. Sized for all 9 dims at realistic
                             // belief lengths (1200 fit the 7-dim set; people+schedule would have squeezed everyone's
                             // fair share); the sidecar tolerates up to 4096.
  // compose order for the SYSTEM-PROMPT block (distinct from the DIMS panel/render order): highest-signal dims
  // first, so if the cap ever forces a trim the bulky doc-seeded dims yield BEFORE goals/pain/ambition.
  const COMPOSE_ORDER = ['goals', 'pain', 'ambition', 'identity', 'people', 'schedule', 'stack', 'style', 'standing_orders'];
  const TEXT_CHARS = 280;    // a single belief is capped (mirrors the §5.2 memory-record content cap)

  // ONBOARDING V3 (docs/ONBOARDING_V3_PLAN.md §5): every belief carries an evidence WEIGHT — how the station
  // came to hold it. 'stated' = the Commander's own words; 'synth' = model-synthesized FROM their words;
  // 'observed' = learned from real work (study); 'seed' = mechanically copied from a config doc. The readiness
  // gate (understanding.js) counts only non-seed beliefs — a canned/doc-copied line can never convince the
  // station it "knows" its Commander (the blitz-through-onboarding poison this field exists to kill).
  const WEIGHTS = ['stated', 'synth', 'observed', 'seed'];

  function isKey(k) { return DIM_KEYS.indexOf(k) >= 0; }
  function isWeight(w) { return WEIGHTS.indexOf(w) >= 0; }
  // resolve a belief's weight, inferring honestly for legacy records that predate the field: a study-observed
  // belief is 'observed'; anything else was authored by (or with) the Commander — 'stated'.
  function weightOf(b) {
    if (b && isWeight(b.weight)) return b.weight;
    if (b && (b.observedAt || b.source === 'study')) return 'observed';
    return 'stated';
  }
  function clip(s) { s = String(s == null ? '' : s).trim(); return s.length > TEXT_CHARS ? s.slice(0, TEXT_CHARS) : s; }

  function fresh() {
    const dims = {};
    for (const k of DIM_KEYS) dims[k] = [];
    return { v: 1, dims, seededFrom: {}, seedText: {}, updatedAt: 0 };
  }

  // a collision-proof belief id: a monotonic counter over the WHOLE dossier (never reuses a freed slot —
  // mirrors memcore.nextNoteId), so forgetting then adding can never alias a still-referenced id.
  function nextId(dossier) {
    let max = 0;
    for (const k of DIM_KEYS) for (const b of (dossier.dims[k] || [])) {
      const m = /^cd_(\d+)$/.exec(b && b.id); if (m) max = Math.max(max, +m[1]);
    }
    return 'cd_' + (max + 1);
  }

  // add a new belief (no id) or update an existing one (id present) in a dimension. Empty text is a no-op
  // (never store a blank belief). source / sourceRunId carry provenance. Returns the dossier.
  function upsert(dossier, dim, belief, now) {
    if (!dossier || !isKey(dim) || !belief) return dossier;
    const text = clip(belief.text);
    if (!text) return dossier;
    const arr = dossier.dims[dim] || (dossier.dims[dim] = []);
    if (belief.id) {
      const cur = arr.find(b => b.id === belief.id);
      if (cur) {
        cur.text = text; cur.updatedAt = now;
        /* A CALLER MAY RE-STAMP PROVENANCE ON AN EXISTING BELIEF (2026-08-04). Only updatedAt moved before, which
           left a belief the Commander had just CONFIRMED OUT LOUD still recorded as the mechanical seed it started
           as (EVIDENCE_WEIGHT.seed = 0) — so its dimension's confidence never rose, it read stale again three
           weeks later, and the station asked "still true?" about the same belief every three weeks forever. The
           re-stamp is truthful: the Commander really did just state it. Omit source/weight and nothing moves. */
        if (belief.source && typeof belief.source === 'string') cur.source = belief.source;
        if (isWeight(belief.weight)) cur.weight = belief.weight;
        /* …and the EVIDENCE REFERENCE, when the caller explicitly declares one (additive, 2026-08-04; DEFAULTED
           OFF — omit the field and the stored ref is untouched, exactly as before). The re-confirm card needs it:
           it upgrades a station-authored belief to commander/stated, and without a marker saying the Commander
           AFFIRMED the station's wording rather than authored it, every later card renders `you said "…"` about
           words they never spoke. Same shape/normalization as the insert path below. */
        if (belief.evidenceRef && typeof belief.evidenceRef === 'object') {
          cur.evidenceRef = {
            runId: (typeof belief.evidenceRef.runId === 'string') ? belief.evidenceRef.runId : null,
            kind: (typeof belief.evidenceRef.kind === 'string') ? belief.evidenceRef.kind.slice(0, 40) : ''
          };
        }
        dossier.updatedAt = now; return dossier;
      }
    }
    arr.push({
      id: nextId(dossier), text,
      source: (belief.source && typeof belief.source === 'string') ? belief.source : 'commander',
      // evidence weight (V3): caller-declared; an invalid/missing weight infers via weightOf (legacy-honest).
      weight: isWeight(belief.weight) ? belief.weight : weightOf(belief),
      sourceRunId: (typeof belief.sourceRunId === 'string') ? belief.sourceRunId : null,
      evidence: (typeof belief.evidence === 'string') ? clip(belief.evidence) : '',
      evidenceRef: (belief.evidenceRef && typeof belief.evidenceRef === 'object') ? {
        runId: (typeof belief.evidenceRef.runId === 'string') ? belief.evidenceRef.runId : null,
        kind: (typeof belief.evidenceRef.kind === 'string') ? belief.evidenceRef.kind.slice(0, 40) : ''
      } : null,
      // Phase B (study): when the STATION observed a belief from real work (not the Commander authoring it), stamp
      // WHEN — the COMMANDER panel renders a study-sourced belief with an "observed" tag + this timestamp. Only a
      // finite number is kept (never a guessed 0), so a Commander-authored belief carries none.
      observedAt: (Number.isFinite(belief.observedAt) && belief.observedAt > 0) ? belief.observedAt : null,
      createdAt: now, updatedAt: now, pinned: false
    });
    dossier.updatedAt = now;
    return dossier;
  }

  // remove the FIRST belief matching id from a dimension (first-match-only, like memcore.applyForget).
  function forget(dossier, dim, id, now) {
    if (!dossier || !isKey(dim)) return dossier;
    const arr = dossier.dims[dim]; if (!arr) return dossier;
    const i = arr.findIndex(b => b.id === id);
    if (i >= 0) { arr.splice(i, 1); dossier.updatedAt = now; }
    return dossier;
  }

  function setPinned(dossier, dim, id, pinned, now) {
    if (!dossier || !isKey(dim)) return dossier;
    const arr = dossier.dims[dim]; if (!arr) return dossier;
    const b = arr.find(x => x.id === id);
    if (b) { b.pinned = !!pinned; dossier.updatedAt = now; }
    return dossier;
  }

  // deterministic read order: pinned first, then oldest-first (createdAt, then id) — so the order, and thus
  // the composed prompt block, is byte-stable regardless of when individual beliefs were edited.
  function beliefs(dossier, dim) {
    const arr = (dossier && dossier.dims[dim]) ? dossier.dims[dim].slice() : [];
    arr.sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((a.createdAt || 0) - (b.createdAt || 0)) || String(a.id).localeCompare(String(b.id)));
    return arr;
  }

  // seed dimensions from the onboarding docs the Commander already authored — ONCE PER DOC (tracked in
  // seededFrom). First-seed-wins, so a doc that is empty at first init seeds later when the awakening fills
  // it, a forgotten seed never reappears on reload, and re-entering the game never duplicates a belief.
  // the belief a doc seeded, still exactly as seeded: mechanical provenance, and its text equal to what was copied
  // (a legacy dossier with no record of the copied text: the seed nobody has touched since — updatedAt === createdAt)
  function untouchedSeed(dossier, dim, seededText) {
    const seeds = (dossier.dims[dim] || []).filter(b => b && b.source === 'onboarding' && b.weight === 'seed');
    if (typeof seededText === 'string') return seeds.find(b => b.text === seededText) || null;
    const pristine = seeds.filter(b => (b.updatedAt || 0) === (b.createdAt || 0));
    return pristine.length === 1 ? pristine[0] : null;
  }
  function seedFromDocs(dossier, docs, now, opts) {
    if (!dossier) return dossier;
    docs = docs || {};
    opts = opts || {};
    if (!dossier.seededFrom || typeof dossier.seededFrom !== 'object') dossier.seededFrom = {};
    if (!dossier.seedText || typeof dossier.seedText !== 'object') dossier.seedText = {};
    for (const s of DOC_SEEDS) {
      const text = String(docs[s.doc] == null ? '' : docs[s.doc]).trim();
      if (dossier.seededFrom[s.doc]) {
        /* A DOC EDIT REACHES ITS SEED (memory-truth lane, 2026-10-11). The seed used to be copied ONCE: edit
           operating-manual.md later and every prompt carried BOTH "STANDING ORDERS: <new manual>" and the dossier's
           "Standing orders: <old manual>" forever — an old instruction recalled beside the new one. Now, when the
           CANONICAL docs (the Overseer's — opts.resync) change, the seed belief follows them IF it is still the
           untouched copy. A belief the Commander edited, re-confirmed or forgot is theirs and is never touched; an
           EMPTY doc is never treated as a deletion (unloaded and cleared look the same here). */
        if (!opts.resync || !text) continue;
        const clipped = clip(text);
        const was = typeof dossier.seedText[s.doc] === 'string' ? dossier.seedText[s.doc] : undefined;
        if (was === clipped) continue;
        const seed = untouchedSeed(dossier, s.dim, was);
        if (seed && seed.text !== clipped) upsert(dossier, s.dim, { id: seed.id, text: clipped }, now);
        if (seed || was !== undefined) dossier.seedText[s.doc] = clipped;
        continue;
      }
      if (!text) continue;
      // V3 dedupe guard: when the interview already wrote this exact text as a real belief (e.g. the synthesized
      // purpose lands in `goals` as 'synth' BEFORE purpose.md commits), the mechanical seed would be a duplicate
      // line in the composed prompt — mark the doc seeded and add nothing. Weight 'seed' otherwise: a doc-copied
      // belief informs the prompt but never counts toward readiness (the fallback purpose picker's canned line
      // must not open the recommendation gate).
      const clipped = clip(text);
      const dup = (dossier.dims[s.dim] || []).some(b => b && b.text === clipped);
      if (!dup) upsert(dossier, s.dim, { text, source: 'onboarding', weight: 'seed' }, now);
      dossier.seededFrom[s.doc] = true;
      dossier.seedText[s.doc] = clipped;   // what was copied — the resync above compares against it
    }
    return dossier;
  }

  // the compact COMMANDER block folded into every agent's system prompt. DURABLE BELIEFS ONLY (no volatile
  // affinity signal) so it is byte-identical for identical state — the cached prefix stays warm. Returns ''
  // when nothing is known (a cold station adds nothing to the prompt). Empty dimensions are omitted, never
  // guessed. Capped at maxChars (whole-word backoff so the cap never splits a word mid-token).
  function composeBlock(dossier, opts) {
    opts = opts || {};
    const cap = Number.isFinite(opts.maxChars) ? opts.maxChars : BLOCK_CHARS;
    // known dims in compose-PRIORITY order (pitch-critical first) so a trim never silently loses the keystone dims.
    const known = COMPOSE_ORDER.map(k => DIMS.find(d => d.key === k)).filter(d => d && beliefs(dossier, d.key).length);
    if (!known.length) return '';
    const head = 'WHAT YOU KNOW ABOUT YOUR COMMANDER (the station has learned this — honor it; if anything here is wrong, the Commander will correct it):';
    const lineOf = d => '- ' + d.lead + ': ' + beliefs(dossier, d.key).map(b => b.text).join('; ');
    let body = head + '\n' + known.map(lineOf).join('\n');
    if (body.length <= cap) return body;   // fast path: everything fits (the common case)
    // OVER BUDGET: give every KNOWN dim a fair share so a bulky doc-seeded dim can't crowd out a later one. (A single
    // tail-cut used to drop pain+ambition — the two dims the whole arc exists to use — entirely + silently.) Each dim
    // keeps its lead + as many beliefs as its share allows; so every known dim stays represented in the prompt.
    const share = Math.max(0, Math.floor((cap - head.length - known.length) / known.length));
    body = head + '\n' + known.map(d => {
      const ln = lineOf(d);
      return ln.length > share ? ln.slice(0, Math.max(0, share - 1)).replace(/\s+\S*$/, '') + '…' : ln;
    }).join('\n');
    // last-resort hard guarantee for a pathologically small cap (e.g. a test cap below the header length).
    if (body.length > cap) body = body.slice(0, Math.max(0, cap - 1)).replace(/\s+\S*$/, '') + '…';
    return body;
  }

  // the panel read: per-dimension counts, which dimensions are known vs still blank, and an HONEST
  // familiarity meter = the fraction of dimensions with at least one belief (the legible, recommended
  // math). `observed` (optional, the affinity summary from profile.js) is passed straight through for the
  // panel; it deliberately does NOT affect familiarity (that meter is about the dossier, not work-mix).
  function summary(dossier, opts) {
    opts = opts || {};
    const counts = {}, known = [], blank = [];
    let total = 0;
    for (const d of DIMS) {
      const n = (dossier && Array.isArray(dossier.dims[d.key])) ? dossier.dims[d.key].length : 0;
      counts[d.key] = n; total += n;
      (n > 0 ? known : blank).push(d.key);
    }
    return {
      counts, known, blank, total,
      familiarity: DIMS.length ? known.length / DIMS.length : 0,
      observed: opts.observed || null
    };
  }

  // defensively rebuild a valid dossier from a (possibly malformed / old) persisted blob. Re-ids any belief
  // with a missing / malformed / duplicate id so nextId() stays collision-proof.
  function hydrate(raw) {
    const d = fresh();
    if (!raw || typeof raw !== 'object') return d;
    if (raw.seededFrom && typeof raw.seededFrom === 'object') {
      for (const s of DOC_SEEDS) if (raw.seededFrom[s.doc]) d.seededFrom[s.doc] = true;
    }
    // what each doc seed copied (memory-truth): lets a later doc edit update an untouched seed (seedFromDocs)
    if (raw.seedText && typeof raw.seedText === 'object') {
      for (const s of DOC_SEEDS) if (typeof raw.seedText[s.doc] === 'string') d.seedText[s.doc] = clip(raw.seedText[s.doc]);
    }
    if (Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0) d.updatedAt = raw.updatedAt;
    if (raw.dims && typeof raw.dims === 'object') {
      for (const k of DIM_KEYS) {
        const arr = raw.dims[k]; if (!Array.isArray(arr)) continue;
        for (const b of arr) {
          if (!b || typeof b.text !== 'string') continue;
          const text = clip(b.text); if (!text) continue;
          d.dims[k].push({
            id: (typeof b.id === 'string') ? b.id : null,
            text,
            source: (typeof b.source === 'string') ? b.source : 'commander',
            weight: weightOf(b),   // V3: preserved when valid; legacy records infer honestly (never 'seed' by guess)
            sourceRunId: (typeof b.sourceRunId === 'string') ? b.sourceRunId : null,
            evidence: (typeof b.evidence === 'string') ? clip(b.evidence) : '',
            evidenceRef: (b.evidenceRef && typeof b.evidenceRef === 'object') ? {
              runId: (typeof b.evidenceRef.runId === 'string') ? b.evidenceRef.runId : null,
              kind: (typeof b.evidenceRef.kind === 'string') ? b.evidenceRef.kind.slice(0, 40) : ''
            } : null,
            observedAt: (Number.isFinite(b.observedAt) && b.observedAt > 0) ? b.observedAt : null,   // Phase B study provenance (preserved across reload)
            createdAt: Number.isFinite(b.createdAt) ? b.createdAt : 0,
            updatedAt: Number.isFinite(b.updatedAt) ? b.updatedAt : 0,
            pinned: !!b.pinned
          });
        }
      }
    }
    const seen = {};
    for (const k of DIM_KEYS) for (const b of d.dims[k]) {
      if (!b.id || seen[b.id] || !/^cd_\d+$/.test(b.id)) b.id = nextId(d);
      seen[b.id] = true;
    }
    return d;
  }

  return { fresh, hydrate, upsert, forget, setPinned, beliefs, seedFromDocs, composeBlock, summary, weightOf, DIMS, DIM_KEYS, WEIGHTS, BLOCK_CHARS, TEXT_CHARS };
});
