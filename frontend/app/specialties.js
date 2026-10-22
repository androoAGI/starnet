/* AGENT OS — specialties.js : preset SPECIALTY types for agents — the "what it's FOR" axis.

   Parallel to personas.js (the "how it TALKS" axis). The two compose: a "Witty Researcher"
   is a Researcher specialty wearing the witty persona. A specialty bundles a ready-made
   purpose.md + a tuned operating-manual.md + a recommended persona + a model-tier hint + a few
   starter tasks + an accent suit — so the Commander can stand up a focused specialist in one tap
   instead of authoring the whole dossier by hand.

   Built-ins are FROZEN (the curated catalog). The Commander can also SAVE their current agent as a
   CUSTOM specialty — persisted in localStorage — and re-deploy it later: that is the "marketplace."

   compose(idOrSpec) returns exactly the { purpose, manual } patch that App.applyAgentConfig already
   takes, so DEPLOYING a specialty rides the SAME authoring path as a hand-edited dossier file — no
   second code path, no drift. UMD: a `Specialties` global in the browser, module.exports under node
   (so the registry + custom round-trip are unit-testable without a DOM). */
'use strict';
(function (root, factory) {
  // the SHARED catalog data (loadout fields + the frozen built-ins) — required under node, a global in the
  // browser (loaded by index.html BEFORE this file). This module wraps it (freeze/tags/custom store/compose).
  const shared = (typeof module !== 'undefined' && module.exports)
    ? require('../../shared/specialties.js')
    : (root.SharedSpecialties || {});
  const api = factory(shared);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Specialties = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  'use strict';

  const STORE_KEY = 'starnet.specialties.v1';   // localStorage home for custom (save-your-own) specialties
  const DEFAULT_ID = shared.DEFAULT_ID || 'chief';

  // model-tier hints are ADVISORY only (the real model list is the live OpenRouter catalog) — a chip
  // that nudges the Commander toward the right spend, never a hard requirement. Sourced from the shared
  // catalog so backend + frontend never drift on the tier vocabulary.
  const TIERS = Object.freeze(Object.assign({
    reasoning: 'deep reasoning — give it a top-tier model',
    balanced: 'a solid mid-tier model is plenty',
    fast: 'cheap & fast works fine'
  }, shared.TIERS || {}));

  // the interest vocabulary the personalization recommender ranks against (mirrors classify.js getTag).
  // Each spec carries a `tags` weight map over these lanes; the user-affinity engine scores a spec by how
  // well its tags match what the Commander actually works on.
  const TAGS = shared.TAGS || ['code', 'research', 'general'];

  // normalize a loadout list of string ids (kit objectTypes / skill slugs) — deduped, trimmed, frozen.
  function normList(a) {
    const out = [], seen = {};
    for (const v of (Array.isArray(a) ? a : [])) {
      const s = String(v || '').trim();
      if (s && !seen[s]) { seen[s] = true; out.push(s); }
    }
    return Object.freeze(out);
  }
  const EFFORTS = { high: 1, medium: 1, low: 1 };
  function normEffort(e) { return EFFORTS[String(e || '')] ? String(e) : null; }

  // keep only the known lanes with a positive weight; an empty/garbage map falls back to the general lane
  // (the catch-all) so every spec is always rankable and never silently scores zero across the board.
  function normTags(t) {
    const out = {}; let sum = 0;
    if (t && typeof t === 'object') for (const k of TAGS) {
      const v = Number(t[k]);
      if (Number.isFinite(v) && v > 0) { out[k] = v; sum += v; }
    }
    return sum > 0 ? out : { general: 1 };
  }
  // derive a tag map for a CUSTOM spec from its own text, using the same classifier the rest of the app uses
  // (Classify is a browser global; under node — where customs aren't authored — it falls back to general).
  function deriveTags(text) {
    if (typeof Classify !== 'undefined' && Classify.getTag) { const tag = Classify.getTag(text); return { [tag]: 1 }; }
    return { general: 1 };
  }

  // normalize + freeze one spec so no caller can mutate the catalog.
  function freezeSpec(s) {
    return Object.freeze({
      id: s.id,
      name: s.name,                                   // role label shown on the card (the agent keeps its own name)
      emoji: s.emoji || '◆',
      tagline: s.tagline || '',
      blurb: s.blurb || '',
      purpose: s.purpose || '',                       // -> purpose.md
      manual: s.manual || '',                         // -> operating-manual.md (standing orders)
      persona: s.persona || 'friendly',              // recommended personaId (the Commander can override)
      model: TIERS[s.model] ? s.model : 'balanced',   // tier KEY (see TIERS); advisory
      accent: s.accent || '#ffaa33',                  // suggested avatar suit
      tags: Object.freeze(normTags(s.tags)),          // interest-lane weights the recommender ranks by
      starters: Object.freeze((s.starters || []).slice()),
      // ---- LOADOUT (Class Loadouts S1): applied at summon; the user can override everything after ----
      kit: normList(s.kit),                           // CAP_REGISTRY objectTypes auto-requisitioned at the workstation
      skills: normList(s.skills),                     // bundled skill-library slugs enabled for THIS agent (ADD-only)
      reasoningEffort: normEffort(s.reasoningEffort), // applied default effort (roster record); pips stay advisory
      custom: false
    });
  }

  /* ---------- the curated catalog ---------- *
     Each purpose folds into the prompt under "YOUR PURPOSE", each manual under "STANDING ORDERS …
     always follow these"; both are written in the harness voice (real tools, the Commander, do the
     work). Several tie into the station's real subsystems (messaging+cron, Cortex memory, PixelLab). */
  const BUILTINS = Object.freeze((shared.BUILTINS || []).map(freezeSpec));
  // the ARCHETYPE pool (deep cuts): full specs held OFF the default roster. Never gated — get() resolves
  // them (so an old save / a scout draft / a summon by id keeps working), the bay lists them only in the
  // SPECIALIST ARCHIVE, and the scout stages one as a prospect when the learned interests point at it.
  const ARCHETYPES = Object.freeze((shared.ARCHETYPES || []).map(freezeSpec));

  /* ---------- custom (save-your-own) specialties ---------- */
  let customs = [];   // plain (mutable) records with custom:true
  function readStore() {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function writeStore() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(customs)); } catch (_) {}
  }
  function normCustom(s) {
    const purpose = s.purpose || '', manual = s.manual || '', tagline = s.tagline || '';
    return {
      id: s.id, name: String(s.name || 'My Specialist'),
      emoji: s.emoji || '✦', tagline, blurb: s.blurb || '',
      purpose, manual,
      persona: s.persona || 'friendly', model: TIERS[s.model] ? s.model : 'balanced',
      accent: s.accent || '#ffaa33',
      // a saved custom carries its own ranking tags; pre-tags customs (or older saves) get them classified
      // from their own text — so the Commander's own specialists rank in the feed just like the built-ins.
      tags: normTags(s.tags && Object.keys(s.tags).length ? s.tags : deriveTags(purpose + ' ' + manual + ' ' + tagline)),
      starters: (s.starters || []).slice(),
      // LOADOUT (Class Loadouts S1): customs carry a loadout too so a saved class is a full loadout. S3 adds
      // the kit/skill pickers to the custom builder; until then these default empty (a plain persona-only class).
      kit: normList(s.kit).slice(), skills: normList(s.skills).slice(), reasoningEffort: normEffort(s.reasoningEffort),
      custom: true
    };
  }
  customs = readStore().map(normCustom).filter(s => s.id);   // hydrate on load (drops any malformed record with no id)

  function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function uniqueId(base) {
    let id = base || 'custom-specialty', n = 2;
    while (exists(id)) { id = (base || 'custom-specialty') + '-' + n++; }
    return id;
  }

  /* ---------- public API ---------- */
  function builtins() { return BUILTINS.slice(); }
  function archetypes() { return ARCHETYPES.slice(); }
  function customList() { return customs.map(c => Object.assign({}, c)); }   // copies — callers never hold a live ref
  // list() stays builtins+customs (the default roster surface); archive classes are asked for explicitly.
  function list() { return BUILTINS.concat(customList()); }
  function get(id) { return BUILTINS.find(b => b.id === id) || ARCHETYPES.find(a => a.id === id) || customs.find(c => c.id === id) || null; }
  function exists(id) { return !!get(id); }

  // the EXACT patch App.applyAgentConfig consumes — the single deploy path (dossier edits use the same).
  function compose(idOrSpec) {
    const s = typeof idOrSpec === 'string' ? get(idOrSpec) : idOrSpec;
    if (!s) return null;
    return { purpose: s.purpose || '', manual: s.manual || '' };
  }

  // build a draft custom spec from a LIVE agent's docs — the "save current agent as a specialty" capture.
  function fromAgent(agent, meta) {
    meta = meta || {};
    const d = (agent && agent.docs) || {};
    const baseName = (agent && agent.name) ? (agent.name.charAt(0) + agent.name.slice(1).toLowerCase()) : 'My Specialist';
    return {
      name: meta.name || baseName,
      emoji: meta.emoji || '✦',
      tagline: meta.tagline || ('Saved from ' + ((agent && agent.name) || 'an agent')),
      blurb: meta.blurb || '',
      purpose: (typeof d.purpose === 'string' && d.purpose) || (agent && agent.purpose) || '',
      manual: (typeof d.manual === 'string' && d.manual) || '',
      persona: (agent && agent.personaId) || 'friendly',
      accent: (agent && agent.color) || '#ffaa33',
      model: 'balanced',
      starters: []
    };
  }

  // upsert a custom specialty (assigns a unique custom-<slug> id on first save). Returns the saved record.
  function saveCustom(spec) {
    if (!spec || !String(spec.name || '').trim()) throw new Error('a specialty needs a name');
    const isExistingCustom = spec.id && customs.some(c => c.id === spec.id);
    const rec = normCustom(spec);
    rec.id = isExistingCustom ? spec.id : uniqueId('custom-' + (slugify(spec.name) || 'specialty'));
    const idx = customs.findIndex(c => c.id === rec.id);
    if (idx >= 0) customs[idx] = rec; else customs.push(rec);
    writeStore();
    return Object.assign({}, rec);
  }

  function removeCustom(id) {
    const before = customs.length;
    customs = customs.filter(c => c.id !== id);
    const removed = customs.length !== before;
    if (removed) writeStore();
    return removed;
  }

  function tierNote(idOrSpec) {
    const s = typeof idOrSpec === 'string' ? get(idOrSpec) : idOrSpec;
    return (s && TIERS[s.model]) || TIERS.balanced;
  }

  return {
    TIERS, DEFAULT_ID,
    list, builtins, archetypes, customs: customList, get, exists,
    compose, fromAgent, saveCustom, removeCustom, tierNote
  };
});
