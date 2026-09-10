/* STARNET — recipes.js : THE RECIPE / MISSION LIBRARY — ready-made, parameterized job templates.

   The sibling of specialties.js. A SPECIALTY answers "who should my agent BE" (its purpose + standing
   orders); a RECIPE answers "what should my agent DO right now" — a one-tap mission like "morning research
   brief on {topic}" or "review {target} for bugs". Each recipe carries a tiny param form + a directive
   TEMPLATE; filling the params and launching it opens a fresh workstream and sends the agent that directive.

   Built-ins are a FROZEN curated catalog. The Commander can also save their own (persisted in localStorage,
   the same marketplace pattern as custom specialties) — the substrate the Phase-3 "auto-mint a recipe from
   what you keep asking for" moat move writes into.

   fillTask(idOrRecipe, values) -> the directive string the agent receives (params substituted). It is THE
   single launch primitive — pure + deterministic + node-testable, the recipe analogue of Specialties.compose.
   The app's launchRecipe() takes that string, mints a workstream, and Chat.send()s it (which classifies it as
   a real task directive, so the agent walks to the workstation and works — and the send folds the recipe's
   interest tag into the personalization profile, so launching recipes sharpens future recommendations).

   Recipes carry `tags` (interest-lane weights over the SAME {code|research|general} vocabulary as specialties)
   so the personalization recommender ranks them in the bay's "RECOMMENDED FOR YOU" shelf with no engine change.

   UMD-light: a `Recipes` global in the browser, module.exports under node (so the registry + the launch
   primitives are unit-testable without a DOM). It leans on the pure TopicMatch engine (the SAME matcher the
   archetype shelf uses) so the FOR YOU row can rank on the station's LEARNED TOPICS, not just the 3-bucket
   profile — resolved with the recruiter.js conditional-require pattern so a missing module simply means the
   topic term is 0 (the ranking then behaves exactly as it did before topics existed). */
'use strict';
(function (root, factory) {
  const TM = (typeof module !== 'undefined' && module.exports)
    ? (() => { try { return require('./topicmatch.js'); } catch (_) { return null; } })()
    : (root.TopicMatch || null);
  const api = factory(TM);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Recipes = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TopicMatch) {
  'use strict';

  const STORE_KEY = 'starnet.recipes.v2';        // localStorage home for custom (save-your-own) recipes (schema v2)
  const STORE_KEY_V1 = 'starnet.recipes.v1';     // legacy v1 home — read once + migrated forward, then left in place

  // the interest vocabulary the personalization recommender ranks against (mirrors classify.js getTag and
  // specialties.js) — a recipe's `tags` map weights these lanes so it ranks honestly in the same feed.
  const TAGS = ['code', 'research', 'general'];

  // ---- schema v2 vocabularies (all ADVISORY — a recipe NEVER gates execution) ----
  // GEAR = the capability objectTypes a use case draws on, same vocabulary as the skills catalog `requires`
  // (dish=web, cabinet=files, notebook=memory, workbench=terminal, studio=images, computer, connector). A recipe
  // renders a WANT badge for gear the station lacks; it never blocks the launch (sandbox/no-gating law).
  const GEAR_TYPES = ['dish', 'cabinet', 'notebook', 'workbench', 'studio', 'computer', 'connector'];
  // the SUGGESTED-cadence ids a recipe may carry (mirrors autojobs.js CADENCES). null = one-shot by nature.
  const CADENCES = ['morning', 'weekly', 'sixhourly', 'hourly'];
  // browse buckets for the marketplace category rail (the R6 discovery front). A persona catalog module authors
  // one of these — it MUST be a known bucket or normCategory collapses it to 'general' and the rail can't group
  // it. 'code' and 'planning' stay valid legacy aliases (older customs) that the rail folds into developer/ops.
  // 'general' is the catch-all fallback. Additive only — no bucket is ever renamed or removed.
  //
  // STANDING-AUTOMATION BUCKETS (2026-08-04): the catalog is a use-case dictionary for someone who cannot yet
  // name their own use case, so the buckets are the areas a StarNet user actually works in. A bucket only
  // exists if a real shelf of recipes stands behind it — an empty or one-item bucket reads as broken next to
  // a full one, so a bucket is added WITH its module and removed when its module goes.
  const CATEGORIES = ['developer', 'research', 'creator', 'writing', 'ops', 'business', 'money',
    'data', 'general', 'code', 'planning'];
  /* THE VISIBLE buckets, in rail order, and the fold from a raw category onto one. Two categories can be
     DIFFERENT values and the same bucket ('code' and 'developer' both render under DEVELOPER), so anything
     reasoning about what the Commander actually SEES must fold first — the marketplace rail delegates here
     rather than keeping its own copy, so the rail and the recommender can never disagree about what "one
     per category" means. Legacy aliases fold; an unknown value falls back to 'general'. */
  const RAIL_BUCKETS = ['general', 'research', 'creator', 'ops', 'business', 'money', 'data', 'developer'];
  // 'writing' stays a valid stored category (core's draft-reply / tighten-writing carry it) but folds into
  // CREATOR on the rail: a two-item chip beside a thirteen-item one reads as broken, and both recipes are
  // squarely content work. Same treatment as 'code' -> developer and 'planning' -> ops.
  const CAT_TO_RAIL = { developer: 'developer', code: 'developer', research: 'research', writing: 'creator',
    creator: 'creator', ops: 'ops', planning: 'ops', business: 'business', money: 'money',
    data: 'data', general: 'general' };
  function railBucket(r) {
    const c = (r && typeof r === 'object') ? r.category : r;
    return CAT_TO_RAIL[String(c == null ? '' : c)] || 'general';
  }
  // provenance: where a recipe came from. 'builtin' = curated; 'custom' = hand-authored; 'fork' = tweaked from another.
  const SOURCES = ['builtin', 'custom', 'fork'];

  // keep only the known gear objectTypes, de-duped, order preserved. Garbage → []. Advisory list, never a gate.
  function normGear(arr) {
    const seen = {}, out = [];
    (Array.isArray(arr) ? arr : []).forEach(g => {
      const t = String(g == null ? '' : g).trim();
      if (t && GEAR_TYPES.indexOf(t) >= 0 && !seen[t]) { seen[t] = true; out.push(t); }
    });
    return out;
  }
  // keep only non-empty string skill slugs, de-duped, order preserved.
  function normSkills(arr) {
    const seen = {}, out = [];
    (Array.isArray(arr) ? arr : []).forEach(s => {
      const t = String(s == null ? '' : s).trim();
      if (t && !seen[t]) { seen[t] = true; out.push(t); }
    });
    return out;
  }
  // a valid suggested cadence id, else null (null = one-shot; never a bogus id the routine picker can't resolve).
  function normCadence(c) { const t = String(c == null ? '' : c).trim(); return CADENCES.indexOf(t) >= 0 ? t : null; }
  // a known category, else 'general' (every recipe is always browsable under some bucket).
  function normCategory(c) { const t = String(c == null ? '' : c).trim(); return CATEGORIES.indexOf(t) >= 0 ? t : 'general'; }
  // a known source, else the supplied fallback ('builtin' for the catalog, 'custom' for a save-your-own).
  function normSource(s, fallback) { const t = String(s == null ? '' : s).trim(); return SOURCES.indexOf(t) >= 0 ? t : fallback; }

  // keep only the known lanes with a positive weight; an empty/garbage map falls back to the general lane
  // (the catch-all) so every recipe is always rankable and never silently scores zero across the board.
  function normTags(t) {
    const out = {}; let sum = 0;
    if (t && typeof t === 'object') for (const k of TAGS) {
      const v = Number(t[k]);
      if (Number.isFinite(v) && v > 0) { out[k] = v; sum += v; }
    }
    return sum > 0 ? out : { general: 1 };
  }
  // derive a tag map for a CUSTOM recipe from its own text, using the same classifier the rest of the app uses
  // (Classify is a browser global; under node — where customs aren't authored — it falls back to general).
  function deriveTags(text) {
    if (typeof Classify !== 'undefined' && Classify.getTag) { const tag = Classify.getTag(text); return { [tag]: 1 }; }
    return { general: 1 };
  }

  /* ---- TYPED FILL-INS (launch-form input kinds) ----
     A param declares WHAT KIND of value it wants, so the launch form can hand the Commander the right control
     instead of one undifferentiated textarea for everything ("point me at a file" used to mean "type a path
     from memory"). Every type still resolves to a plain STRING substituted into the directive by fillTask —
     the launch primitive is unchanged, so a typed recipe and an untyped one compose identically.
       text      — free text (the default; a multi-line textarea)
       choice    — one of `options` (chips); needs >= 2 options or it degrades to text (never an empty picker)
       file      — an absolute file path + a native BROWSE button (the OS file chooser)
       folder    — an absolute folder path + the same chooser in directory mode
       connector — one of the station's LIVE connected services (the form fills the list from /api/connectors)
     Unknown/garbage type -> 'text'. Everything here is presentation: a type NEVER gates a launch, and a
     recipe authored before types existed reads as all-text, exactly as it rendered before. */
  const PARAM_TYPES = ['text', 'choice', 'file', 'folder', 'connector'];
  const PARAM_OPTIONS_MAX = 6;      // a chip row the eye can scan; more than this wants free text
  const PARAM_OPTION_MAX_LEN = 48;
  // keep only non-empty option labels, trimmed + clipped, de-duped case-insensitively, order preserved.
  function normParamOptions(arr) {
    const seen = {}, out = [];
    (Array.isArray(arr) ? arr : []).forEach(o => {
      const t = String(o == null ? '' : o).replace(/\s+/g, ' ').trim().slice(0, PARAM_OPTION_MAX_LEN);
      const k = t.toLowerCase();
      if (t && !seen[k] && out.length < PARAM_OPTIONS_MAX) { seen[k] = true; out.push(t); }
    });
    return out;
  }
  // normalize + freeze one param descriptor ({ key, label, placeholder, required, default, type, options }). A
  // param with no key is dropped by the caller (filter on key). default is the value substituted when an optional
  // field is left blank; required params have no default (the UI blocks launch until they're filled).
  function freezeParam(p) {
    const options = normParamOptions(p.options);
    let type = PARAM_TYPES.indexOf(String(p.type == null ? '' : p.type).trim()) >= 0 ? String(p.type).trim() : 'text';
    if (type === 'choice' && options.length < 2) type = 'text';   // a picker with nothing to pick IS a text box
    let dflt = typeof p.default === 'string' ? p.default : '';
    // a choice's default must be one of its own options — otherwise the form would preselect a chip that isn't
    // there and fillTask would substitute a value the Commander was never shown.
    if (type === 'choice' && dflt && !options.some(o => o.toLowerCase() === dflt.toLowerCase())) dflt = '';
    return Object.freeze({
      key: String(p.key),
      label: p.label || p.key,
      placeholder: p.placeholder || '',
      required: p.required !== false,                 // params are required by default; opt out with required:false
      default: dflt,
      type: type,
      options: Object.freeze(type === 'choice' ? options : [])
    });
  }
  function normParams(arr) {
    return (Array.isArray(arr) ? arr : [])
      .filter(p => p && p.key != null && String(p.key).length)
      .map(freezeParam);
  }

  // TASK BRIEF v2 — a recipe's declared MATERIAL decisions, settled by one tap at launch (or aimed at mid-run).
  // dimension must be one of the taskbrief-policy decision dimensions — mirrored here because this browser module
  // never requires sidecar code; the taskintent test pins the two lists together. Malformed entries drop silently
  // (author error is never a crash); a recipe without valid intake simply has none and launches exactly as before.
  const INTAKE_DIMENSIONS = { objective: 1, audience: 1, deliverable: 1, scope: 1, constraints: 1, sources: 1, acceptance: 1, safety: 1 };
  function normIntake(arr) {
    return Object.freeze((Array.isArray(arr) ? arr : []).map(e => {
      if (!e || typeof e !== 'object') return null;
      const dimension = String(e.dimension || '').toLowerCase();
      const question = String(e.question || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const options = (Array.isArray(e.options) ? e.options : []).map(x => String(x == null ? '' : x).trim().slice(0, 72)).filter(Boolean).slice(0, 3);
      const recommended = String(e.recommended || '').trim().slice(0, 72);
      const reason = String(e.reason || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!INTAKE_DIMENSIONS[dimension] || !question || options.length < 2) return null;
      if (!recommended || !options.some(o => o.toLowerCase() === recommended.toLowerCase())) return null;
      return Object.freeze({ dimension, question, options: Object.freeze(options), recommended, reason });
    }).filter(Boolean).slice(0, 3));
  }

  /* SOP RECIPES (2026-08-21) — a recipe can carry a PROCEDURE and an ACCEPTANCE CONTRACT so the same business
     workflow comes out the same way on run 50 as on run 1.
       steps[]      — ordered plain-text procedure lines. They ride the directive verbatim (fillTask appends them),
                      so the agent is told the order; they are advisory prose, never host-checked.
       acceptance[] — typed, HOST-CHECKED predicates. Each row mirrors ONE sidecar task-postconditions type
                      (sidecar/task-postconditions.js — the single acceptance authority; this module never grows
                      a second predicate engine):
                        artifact_exists      { path }            the run produced that workspace file
                        artifact_contains    { path, text }      ...and it contains the text
                        artifact_sha256      { path, sha256 }    ...and its digest matches exactly
                        verification_passed  { command }         that exact check command ran green in the run
                        connector_readback   { connector, tool, args?, contains|regex }
                                                                 the HOST re-reads the connector itself (a read tool only)
                                                                 after the run acted on it, and the text must match
                      path/text/command/args/contains may carry {param} tokens; postconditionsFor() fills them at launch and the
                      contract rides the run body as `postconditions` — the host evaluates it when the run ends and
                      the loop gets ONE bounded turn to repair a failing check (acceptance-on-stop). Malformed rows
                      drop silently (author error is never a crash); a recipe with none launches exactly as before.
     Bounds mirror the sidecar's (20 requirements, 260-char path, 500-char text, 1000-char command). */
  const STEPS_MAX = 12, STEP_MAX_LEN = 240;
  const ACCEPTANCE_MAX = 20, ACC_PATH_MAX = 260, ACC_TEXT_MAX = 500, ACC_CMD_MAX = 1000;
  const ACCEPTANCE_TYPES = Object.freeze(['artifact_exists', 'artifact_contains', 'artifact_sha256', 'verification_passed', 'connector_readback']);
  const ACC_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;   // connector ids + tool names (mirrors the sidecar)
  const ACC_ARGS_MAX = 2000;
  function normSteps(arr) {
    return Object.freeze((Array.isArray(arr) ? arr : [])
      .map(s => String(s == null ? '' : (typeof s === 'object' ? (s.text || '') : s)).replace(/\s+/g, ' ').trim().slice(0, STEP_MAX_LEN))
      .filter(Boolean)
      .slice(0, STEPS_MAX));
  }
  // a relative workspace path — no absolute roots, no `..` hops, no NUL. Same rule as the sidecar normalizer, so a
  // row that survives here survives there (a {token} may still make it absolute at launch; the host rejects that).
  function saneAccPath(p) {
    const path = String(p == null ? '' : p).trim().slice(0, ACC_PATH_MAX);
    if (!path || path.indexOf('\0') >= 0) return '';
    if (path.replace(/\\/g, '/').split('/').indexOf('..') >= 0) return '';
    if (/^(?:[a-z]:[\\/]|[\\/])/i.test(path)) return '';
    return path;
  }
  function normAcceptance(arr) {
    const out = [];
    (Array.isArray(arr) ? arr : []).forEach(e => {
      if (!e || typeof e !== 'object' || out.length >= ACCEPTANCE_MAX) return;
      const type = String(e.type || '').trim();
      if (ACCEPTANCE_TYPES.indexOf(type) < 0) return;
      const label = String(e.label || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (type === 'verification_passed') {
        const command = String(e.command || '').trim().slice(0, ACC_CMD_MAX);
        if (!command) return;
        out.push(Object.freeze({ type, command, label }));
        return;
      }
      if (type === 'connector_readback') {
        const connector = String(e.connector || '').trim(), tool = String(e.tool || '').trim();
        if (!ACC_SLUG_RE.test(connector) || !ACC_SLUG_RE.test(tool)) return;
        const contains = String(e.contains == null ? '' : e.contains).trim().slice(0, ACC_TEXT_MAX);
        const regex = String(e.regex == null ? '' : e.regex).trim().slice(0, ACC_TEXT_MAX);
        if (!contains && !regex) return;
        if (regex) { try { new RegExp(regex); } catch (_) { return; } }
        // args: a plain object (authored as JSON text in the editor), bounded; a {token} may live in any string value.
        let args = null;
        if (e.args != null) {
          let obj = e.args;
          if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (_) { return; } }
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
          let json = ''; try { json = JSON.stringify(obj); } catch (_) { return; }
          if (json.length > ACC_ARGS_MAX) return;
          args = JSON.parse(json);
        }
        const row = { type, connector, tool, label };
        if (args) row.args = Object.freeze(args);
        if (contains) row.contains = contains;
        if (regex) row.regex = regex;
        out.push(Object.freeze(row));
        return;
      }
      const path = saneAccPath(e.path);
      if (!path) return;
      const row = { type, path, label };
      if (type === 'artifact_contains') {
        const text = String(e.text == null ? '' : e.text).trim().slice(0, ACC_TEXT_MAX);
        if (!text) return;
        row.text = text;
      } else if (type === 'artifact_sha256') {
        const sha256 = String(e.sha256 || '').trim().toLowerCase();
        // a {token} is allowed (filled at launch); otherwise it must already be a 64-hex digest.
        if (!/^[a-f0-9]{64}$/.test(sha256) && !/\{\w+\}/.test(sha256)) return;
        row.sha256 = sha256;
      }
      out.push(Object.freeze(row));
    });
    return Object.freeze(out);
  }
  // one-line human reading of an acceptance row (dossier / editor / the directive's ACCEPTANCE block).
  function acceptanceLabel(a) {
    if (!a) return '';
    if (a.label) return a.label;
    if (a.type === 'artifact_exists') return 'file exists: ' + a.path;
    if (a.type === 'artifact_contains') return a.path + ' contains "' + a.text + '"';
    if (a.type === 'artifact_sha256') return a.path + ' sha256 = ' + a.sha256;
    if (a.type === 'verification_passed') return 'check passes: ' + a.command;
    if (a.type === 'connector_readback') {
      // the editor's live preview hands args as the raw JSON text the author is typing — show it as JSON, not as a quoted string
      let args = a.args; if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { /* keep the text */ } }
      return a.connector + ' › ' + a.tool + (args ? ' ' + (typeof args === 'string' ? args : JSON.stringify(args)) : '') + (a.contains ? ' shows "' + a.contains + '"' : ' matches /' + a.regex + '/');
    }
    return a.type;
  }

  // humanize a param key into a form label: snake_case / camelCase -> Title-cased words ('look_back' -> 'Look Back').
  // (Tokens are \w+ — see the fillTask/paramsFromTemplate regex — so hyphens never reach here.)
  function humanize(key) {
    return String(key || '')
      .replace(/_+/g, ' ')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // acronym boundary: 'HTTPStatus' -> 'HTTP Status'
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')       // camelCase boundary: 'lookBack' -> 'look Back'
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase());       // Title-Case each word ('look_back' -> 'Look Back')
  }
  // derive the param form from a task TEMPLATE: each DISTINCT {token} becomes a required text input (humanized
  // label). This is how an AUTHORED custom recipe gets its inputs — the template IS the spec, so the Commander
  // only writes the directive and the blanks fall out of it. A template with no tokens yields a one-tap mission.
  function paramsFromTemplate(task) {
    const seen = {}, out = [];
    const re = /\{(\w+)\}/g; let m;
    while ((m = re.exec(String(task || ''))) !== null) {
      const key = m[1];
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ key: key, label: humanize(key) || key, placeholder: '', required: true });   // never a blank label
    }
    // keep every launch-form field identifiable: if two distinct tokens humanize to the SAME label
    // ({look_back} vs {lookBack}, {topic} vs {Topic}), append the raw key so they can be told apart.
    const counts = {};
    out.forEach(p => { counts[p.label] = (counts[p.label] || 0) + 1; });
    out.forEach(p => { if (counts[p.label] > 1) p.label = p.label + ' (' + p.key + ')'; });
    return out;
  }

  // normalize + freeze one recipe so no caller can mutate the catalog (deep: outer + tags + params).
  function freezeRecipe(r) {
    return Object.freeze({
      id: r.id,
      archived: r.archived === true,
      name: r.name,
      emoji: r.emoji || '▸',
      tagline: r.tagline || '',
      blurb: r.blurb || '',
      accent: r.accent || '#7bc88a',
      tags: Object.freeze(normTags(r.tags)),          // interest-lane weights the recommender ranks by
      params: Object.freeze(normParams(r.params)),    // the param form: [{ key, label, placeholder, required, default }]
      task: r.task || '',                             // the directive TEMPLATE; {key} tokens get param values
      // ---- schema v2 (all ADVISORY; never gate execution) ----
      intake: normIntake(r.intake),                   // TASK BRIEF v2: material decisions offered as one-tap chips at launch
      steps: normSteps(r.steps),                      // SOP: ordered procedure lines (prose, rides the directive)
      acceptance: normAcceptance(r.acceptance),       // SOP: typed host-checked postconditions (see normAcceptance)
      gear: Object.freeze(normGear(r.gear)),          // capability objectTypes this use case draws on (WANT badge)
      skills: Object.freeze(normSkills(r.skills)),    // bundled-skill references (pairs-with hints)
      cadence: normCadence(r.cadence),                // suggested cadence id, or null (one-shot by nature)
      category: normCategory(r.category),             // browse bucket
      source: normSource(r.source, 'builtin'),        // provenance
      forkedFrom: r.forkedFrom != null ? String(r.forkedFrom) : null,
      sourceRunId: r.sourceRunId != null ? String(r.sourceRunId) : null,   // R5: the interactive run this was bottled from (null for the catalog)
      custom: false
    });
  }

  /* ---------- the curated catalog ---------- *
     The built-in records are DATA now, authored in recipe-catalog/ (core.js today; persona files under R4). We
     read the aggregate (recipe-catalog/index.js) and freeze each here — the same freeze pass every built-in went
     through when they lived inline, so nothing downstream can tell the difference. Under node the module requires
     the catalog; in the browser it's the `RecipeCatalog` global set by recipe-catalog/index.js (loaded first).
     Fallback [] keeps recipes.js from throwing if the catalog is somehow unavailable (empty library, never a crash). */
  function loadCatalog() {
    if (typeof require === 'function' && typeof module !== 'undefined') {
      try { const c = require('./recipe-catalog/index.js'); return Array.isArray(c) ? c : []; } catch (_) { return []; }
    }
    const g = (typeof RecipeCatalog !== 'undefined') ? RecipeCatalog : null;
    return Array.isArray(g) ? g : [];
  }
  const BUILTINS = Object.freeze(loadCatalog().map(freezeRecipe));

  /* ---------- custom (save-your-own) recipes ---------- */
  let customs = [];   // plain (mutable) records with custom:true
  // read one localStorage key as an array (tolerant: missing/garbage -> []).
  function readKey(key) {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(key);
      if (raw == null) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  // migrate the v1 custom store forward to v2 ONCE. The record shape is a strict superset (v2 only ADDS
  // gear/skills/cadence/category/source/forkedFrom), so migration is: read v1 rows, hand them to normCustom
  // (which fills v2 defaults — normSource(...,'custom') stamps provenance, category derives from tags), and
  // persist under the v2 key. NEVER loses a user recipe: we only migrate if v2 is absent AND v1 has rows, and
  // we leave the v1 key untouched (a belt-and-braces fallback if a downgrade ever re-reads it).
  function readStore() {
    const v2 = readKey(STORE_KEY);
    if (v2 != null) return v2;                       // v2 already exists (even if empty) — authoritative
    const v1 = readKey(STORE_KEY_V1);
    if (v1 && v1.length) {                           // first run since the v2 upgrade with real v1 recipes
      try {
        const migrated = v1.map(normCustom).filter(r => r.id);
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
      } catch (_) {}
      return v1;                                     // hydrate from v1 this run; the write above persists v2
    }
    return [];
  }
  function writeStore() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(customs)); } catch (_) {}
  }
  function normCustom(r) {
    const name = String(r.name || 'My Recipe');
    const tagline = r.tagline || '', task = r.task || '';
    return {
      id: r.id, name,
      emoji: r.emoji || '▸', tagline, blurb: r.blurb || '',
      accent: r.accent || '#7bc88a',
      // a saved custom carries its own ranking tags; pre-tags customs (or older saves) get them classified
      // from their own text — so the Commander's own recipes rank in the feed just like the built-ins.
      tags: normTags(r.tags && Object.keys(r.tags).length ? r.tags : deriveTags(name + ' ' + tagline + ' ' + task)),
      // an authored custom supplies only the task TEMPLATE — derive its inputs from the {tokens} when no usable
      // params given. Check the NORMALIZED result (not the raw length) so a keyless/garbage params array from a
      // hand-edited or corrupted import still falls through to template derivation instead of shipping ungated.
      params: (function () { const np = normParams(r.params); return np.length ? np : normParams(paramsFromTemplate(task)); })(),
      task,
      // ---- schema v2 (all ADVISORY; never gate execution) ----
      steps: normSteps(r.steps),                      // SOP procedure (prose)
      acceptance: normAcceptance(r.acceptance),       // SOP typed acceptance (host-checked at run end)
      gear: normGear(r.gear),                         // capability objectTypes this custom draws on
      skills: normSkills(r.skills),                   // bundled-skill references
      cadence: normCadence(r.cadence),                // suggested cadence id (for MAKE ROUTINE), or null
      // a v1 record (or a hand-authored save) carries no category → derive one from its dominant ranking lane, so
      // it still lands in a browse bucket. code→code, research→research, general→general (the catch-all).
      category: normCategory(r.category || dominantCategory(r.tags && Object.keys(r.tags).length ? r.tags : deriveTags(name + ' ' + tagline + ' ' + task))),
      // provenance: a TWEAK mints source:'fork' + forkedFrom; a hand-authored save is 'custom'. A v1 record has
      // neither field → normSource falls back to 'custom'. forkedFrom is only meaningful on a fork.
      source: normSource(r.source, 'custom'),
      forkedFrom: r.forkedFrom != null ? String(r.forkedFrom) : null,
      // R5 "Bottle a run": a custom minted from a completed interactive run carries that run's id (the agent-skill
      // sourceRunId pattern) — honest provenance for a bottled recipe. A hand-authored / forked save leaves it null.
      sourceRunId: r.sourceRunId != null ? String(r.sourceRunId) : null,
      custom: true,
      // G3a seed callouts: a recipe the AGENT authored from an observed pattern (seedstore.save) carries this
      // durable flag, so a later pitch/suggestion/digest that reuses it can CREDIT the Commander's saved seed.
      // A hand-authored save-your-own recipe leaves it false — only agent-minted seeds get the callout.
      seedborn: !!r.seedborn
    };
  }
  // the browse category implied by a tag map: the highest-weighted known lane, or 'general'. code/research map
  // 1:1 to their category bucket; anything else falls to general (writing/planning are author-set, not derived).
  function dominantCategory(tags) {
    if (!tags || typeof tags !== 'object') return 'general';
    let best = null, bestW = 0;
    for (const k of TAGS) { const w = Number(tags[k]) || 0; if (w > bestW) { bestW = w; best = k; } }
    return best === 'code' ? 'code' : best === 'research' ? 'research' : 'general';
  }
  customs = readStore().map(normCustom).filter(r => r.id);   // hydrate on load (drops any malformed record with no id)

  function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function uniqueId(base) {
    let id = base || 'custom-recipe', n = 2;
    while (exists(id)) { id = (base || 'custom-recipe') + '-' + n++; }
    return id;
  }

  /* ---------- public API ---------- */
  function builtins() { return BUILTINS.filter(r => !r.archived); }
  function customList() { return customs.map(c => Object.assign({}, c)); }   // copies — callers never hold a live ref
  function list() { return builtins().concat(customList()); }
  function get(id) { return BUILTINS.find(b => b.id === id) || customs.find(c => c.id === id) || null; }
  function exists(id) { return !!get(id); }

  // the param keys a recipe still needs before it can launch (required + still blank). The launch UI blocks
  // on a non-empty result; node-testable so the gate can't silently drift from the template.
  function requiredMissing(idOrRecipe, values) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r || !r.params) return [];
    const v = values || {};
    return r.params
      .filter(p => p.required && !(typeof v[p.key] === 'string' && v[p.key].trim()))
      .map(p => p.key);
  }

  // THE launch primitive: substitute the param values into the recipe's directive template and return the
  // string the agent receives. Returns null for an unknown id/recipe. The recipe analogue of Specialties.compose
  // — the single, no-drift launch path. A FILLED value is inserted VERBATIM, so pasted code / logs / indentation
  // / aligned tables survive untouched (the agent must run exactly what the Commander supplied). A blank optional
  // falls back to its param default; only when a token resolves to nothing do we drop the seam whitespace it
  // would otherwise leave behind — and that trim only ever touches the LITERAL template segment, never user text.
  // Tokens that aren't params of this recipe are left as-is (author error, never a crash).
  function fillTask(idOrRecipe, values) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r) return null;
    const v = values || {};
    const byKey = {};
    (r.params || []).forEach(p => { byKey[p.key] = p; });
    const tmpl = String(r.task || '');
    const re = /\{(\w+)\}/g;
    let out = '', cursor = 0, m;
    while ((m = re.exec(tmpl)) !== null) {
      let literal = tmpl.slice(cursor, m.index);
      const key = m[1];
      cursor = m.index + m[0].length;
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) { out += literal + m[0]; continue; }   // foreign token → leave as-is
      const val = (typeof v[key] === 'string' && v[key].trim()) ? v[key] : (byKey[key].default || '');
      if (!val) literal = literal.replace(/[ \t]+$/, '');   // gone token → close the gap (literal segment only)
      out += literal + val;
    }
    out += tmpl.slice(cursor);
    out = out.trim();
    // TASK BRIEF v2: launch-time intake decisions ride the directive ITSELF — never a new run-body field
    // (handleRun whitelists body fields). values.__intake maps dimension -> the tapped answer; a skipped
    // decision says nothing (the agent resolves or asks per the task-context doctrine).
    const intake = v.__intake && typeof v.__intake === 'object' ? v.__intake : null;
    if (out && intake && r.intake && r.intake.length) {
      const lines = r.intake
        .filter(e => typeof intake[e.dimension] === 'string' && intake[e.dimension].trim())
        .map(e => '- ' + e.dimension + ': ' + intake[e.dimension].trim().slice(0, 72));
      if (lines.length) out += '\n\nDecisions (chosen at launch — treat these as answered; do not re-ask them):\n' + lines.join('\n');
    }
    // SOP: the procedure rides the directive so the agent follows the Commander's order, and the acceptance
    // contract is STATED so the agent knows exactly what the host will check (the host checks it regardless).
    if (out && r.steps && r.steps.length) {
      out += '\n\nProcedure (follow in this order; do not skip or reorder steps):\n'
        + r.steps.map((s, i) => (i + 1) + '. ' + fillTokens(s, r, v)).join('\n');
    }
    if (out && r.acceptance && r.acceptance.length) {
      out += '\n\nAcceptance (the host checks these when you finish — the task is not done until every one holds):\n'
        + r.acceptance.map(a => '- ' + acceptanceLabel(fillAcceptance(a, r, v))).join('\n');
    }
    return out;
  }
  // {token} substitution for a short SOP field: same param semantics as the template (filled value verbatim, blank
  // optional -> default, foreign token left as-is). No seam-whitespace trimming — these are single fields.
  function fillTokens(str, r, v) {
    const byKey = {};
    (r.params || []).forEach(p => { byKey[p.key] = p; });
    return String(str == null ? '' : str).replace(/\{(\w+)\}/g, (m, key) => {
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) return m;
      return (typeof v[key] === 'string' && v[key].trim()) ? v[key] : (byKey[key].default || '');
    });
  }
  function fillAcceptance(a, r, v) {
    const out = { type: a.type, label: a.label ? fillTokens(a.label, r, v) : '' };
    if (a.path != null) out.path = fillTokens(a.path, r, v);
    if (a.text != null) out.text = fillTokens(a.text, r, v);
    if (a.sha256 != null) out.sha256 = fillTokens(a.sha256, r, v).toLowerCase();
    if (a.command != null) out.command = fillTokens(a.command, r, v);
    if (a.connector != null) out.connector = a.connector;
    if (a.tool != null) out.tool = a.tool;
    if (a.contains != null) out.contains = fillTokens(a.contains, r, v);
    if (a.regex != null) out.regex = a.regex;
    if (a.args != null) {
      // tokens fill inside STRING values only; shape and non-string values are carried verbatim.
      const fillDeep = x => (typeof x === 'string') ? fillTokens(x, r, v) : (Array.isArray(x) ? x.map(fillDeep) : (x && typeof x === 'object') ? Object.keys(x).reduce((o, k) => { o[k] = fillDeep(x[k]); return o; }, {}) : x);
      out.args = fillDeep(a.args);
    }
    return out;
  }
  /* the run-body `postconditions` contract for a launch: the recipe's acceptance rows with their tokens filled,
     in the exact shape sidecar/task-postconditions.js normalizeContract() accepts. Returns null when the recipe
     has no acceptance (the run body then carries no contract and the host reports `not_assessed`, as today).
     Row ids are stable (`sop-<n>`) so a dossier / COMMS line can name which check failed. */
  function postconditionsFor(idOrRecipe, values) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r || !r.acceptance || !r.acceptance.length) return null;
    const v = values || {};
    const requirements = r.acceptance.map((a, i) => {
      const f = fillAcceptance(a, r, v);
      const row = { id: 'sop-' + (i + 1), type: f.type };
      if (f.type === 'verification_passed') row.command = f.command;
      else if (f.type === 'connector_readback') {
        row.connector = f.connector; row.tool = f.tool;
        if (f.args) row.args = f.args;
        if (f.contains) row.contains = f.contains;
        if (f.regex) row.regex = f.regex;
      } else {
        row.path = f.path;
        if (f.type === 'artifact_contains') row.text = f.text;
        if (f.type === 'artifact_sha256') row.sha256 = f.sha256;
      }
      return row;
    });
    return { schemaVersion: 'starnet.task-postconditions.v1', authority: 'commander', requirements };
  }

  // build a DRAFT custom recipe from a launched one (P3 "save what you keep asking for" seam). Returns a plain
  // draft (no id, custom not set) for saveCustom — mirrors Specialties.fromAgent. Carries the v2 authoring fields
  // through so a caller (e.g. the TWEAK editor) can prefill every picker.
  function draft(over) {
    over = over || {};
    return {
      name: over.name || 'My Recipe',
      emoji: over.emoji || '▸',
      tagline: over.tagline || '',
      blurb: over.blurb || '',
      accent: over.accent || '#7bc88a',
      tags: over.tags || null,
      params: over.params || [],
      task: over.task || '',
      steps: Array.isArray(over.steps) ? over.steps.slice() : [],
      acceptance: Array.isArray(over.acceptance) ? over.acceptance.map(a => Object.assign({}, a)) : [],
      gear: Array.isArray(over.gear) ? over.gear.slice() : [],
      skills: Array.isArray(over.skills) ? over.skills.slice() : [],
      cadence: over.cadence != null ? over.cadence : null,
      category: over.category || null,
      source: over.source || null,
      forkedFrom: over.forkedFrom != null ? over.forkedFrom : null,
      sourceRunId: over.sourceRunId != null ? over.sourceRunId : null,   // R5: carried through so a bottled run keeps its provenance on save
      seedborn: !!over.seedborn   // carried through so an agent-authored seed keeps its provenance on save
    };
  }

  // FORK a recipe (R2 TWEAK): produce a DRAFT prefilled from an existing recipe's authoring surface, stamped
  // source:'fork' + forkedFrom:<id>. The draft has NO id (saveCustom mints a fresh custom-recipe-<slug>), so the
  // original — builtin OR custom — is never touched. Every editable field (name/emoji/params/task/gear/cadence/
  // category) is copied so the editor opens fully populated; the caller adjusts and saves a new custom recipe.
  // Returns null for an unknown id. The name gets a distinguishing suffix so the fork doesn't look like a dupe.
  function forkFrom(idOrRecipe) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r) return null;
    return draft({
      name: (r.name || 'Recipe') + ' (my version)',
      emoji: r.emoji, tagline: r.tagline, blurb: r.blurb, accent: r.accent,
      // copy params as plain objects (the source's are frozen); the editor mutates these freely.
      params: (r.params || []).map(p => ({ key: p.key, label: p.label, placeholder: p.placeholder, required: p.required, default: p.default, type: p.type, options: (p.options || []).slice() })),
      task: r.task,
      steps: (r.steps || []).slice(),
      acceptance: (r.acceptance || []).map(a => Object.assign({}, a)),
      gear: (r.gear || []).slice(), skills: (r.skills || []).slice(),
      cadence: r.cadence || null, category: r.category || null,
      source: 'fork', forkedFrom: r.id
    });
  }

  /* R5 "Bottle a run" — mint a DRAFT custom recipe from a completed interactive run's DIRECTIVE. Pure +
     deterministic + node-testable (the beat's decide-half lives in bottlestore.js; this is its templating half).
     Agent-side templating is out of scope, so we derive everything with honest heuristics:
       • NAME   — the first few meaningful words of the directive, Title-Cased (stopwords trimmed off the front).
       • TASK   — the directive VERBATIM, except obvious parameter candidates are wrapped in {tokens} so the R2
                  editor's paramsFromTemplate() surfaces them as fill-ins. Zero candidates is fine — a one-tap recipe.
       • PARAMS — derived from those {tokens} (so the editor opens with the fill-in grid pre-populated).
     Parameter candidates (kept SIMPLE + honest): "double-quoted"/'single-quoted' strings and http(s) URLs. Each
     distinct candidate becomes one param, keyed topic/topic2/… (quotes) or url/url2/… (links). We NEVER invent a
     value the user didn't type; a directive with none yields a faithful one-tap recipe. The draft is unsaved
     (no id, custom not set) and stamped source:'custom' + sourceRunId — the caller opens the R2 editor on it and
     the user confirms/edits/saves. Returns null for an empty/whitespace directive (nothing real to bottle). */
  const NAME_STOP = { the: 1, a: 1, an: 1, please: 1, kindly: 1, could: 1, can: 1, you: 1, i: 1, we: 1, let: 1, lets: 1, "let's": 1, my: 1, our: 1, this: 1, that: 1, go: 1, now: 1 };
  function deriveName(directive) {
    // first line only (a multi-line directive names off its headline), words → drop leading stopwords → take up to 5.
    const firstLine = String(directive || '').split(/\r?\n/)[0] || '';
    const words = firstLine.replace(/[`"'*_>#]/g, ' ').split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && NAME_STOP[words[i].toLowerCase().replace(/[^a-z']/g, '')]) i++;
    const picked = words.slice(i, i + 5).map(w => w.replace(/[^\w'-]+$/, ''));   // trim trailing punctuation
    const name = picked.join(' ').trim();
    if (!name) return 'My Recipe';
    return name.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 48);
  }
  function mintFromRun(directive, opts) {
    const text = String(directive == null ? '' : directive);
    if (!text.trim()) return null;                    // no real directive → nothing honest to bottle
    opts = opts || {};
    // find parameter candidates in ORDER of appearance, de-duped by their literal value. Quoted strings first
    // (topic-shaped), then bare URLs (url-shaped). We wrap each in a {token} in the task template.
    const params = [];                                // { key, raw, label }
    const seen = {};
    let quoteN = 0, urlN = 0;
    // quoted strings: "…" or '…' (non-empty, no embedded newline). The captured inner value is the substitution.
    const QUOTE_RE = /"([^"\n]+)"|'([^'\n]+)'/g;
    // bare URLs not already inside quotes (those are handled above; a quoted URL becomes a topic param, fine).
    const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/g;
    let out = text, m;
    // pass 1 — quotes. Rebuild the string so replacements don't shift subsequent match indices.
    let rebuilt = '', cursor = 0;
    while ((m = QUOTE_RE.exec(text)) !== null) {
      const inner = (m[1] != null ? m[1] : m[2]);
      rebuilt += text.slice(cursor, m.index);
      cursor = m.index + m[0].length;
      if (Object.prototype.hasOwnProperty.call(seen, inner)) { rebuilt += '{' + seen[inner] + '}'; continue; }
      const key = quoteN === 0 ? 'topic' : 'topic' + (quoteN + 1); quoteN++;
      seen[inner] = key;
      params.push({ key: key, raw: inner, label: humanize(key) });
      rebuilt += '{' + key + '}';
    }
    rebuilt += text.slice(cursor);
    out = rebuilt;
    // pass 2 — URLs, over the quote-substituted string (so a quoted URL isn't double-wrapped).
    rebuilt = ''; cursor = 0;
    while ((m = URL_RE.exec(out)) !== null) {
      const raw = m[0];
      rebuilt += out.slice(cursor, m.index);
      cursor = m.index + m[0].length;
      if (Object.prototype.hasOwnProperty.call(seen, raw)) { rebuilt += '{' + seen[raw] + '}'; continue; }
      const key = urlN === 0 ? 'url' : 'url' + (urlN + 1); urlN++;
      seen[raw] = key;
      params.push({ key: key, raw: raw, label: humanize(key) });
      rebuilt += '{' + key + '}';
    }
    rebuilt += out.slice(cursor);
    const task = rebuilt.trim();
    return draft({
      name: deriveName(text),
      emoji: '✦',
      task: task,
      // fill-in grid pre-populated from the detected candidates (placeholder = the value the user actually typed,
      // so the editor shows a concrete example). Empty → a one-tap recipe (paramsFromTemplate finds no tokens).
      params: params.map(p => ({ key: p.key, label: p.label, placeholder: p.raw, required: true })),
      source: 'custom',
      sourceRunId: opts.runId != null ? String(opts.runId) : null
    });
  }

  // upsert a custom recipe (assigns a unique custom-recipe-<slug> id on first save). Returns the saved record.
  function saveCustom(recipe) {
    if (!recipe || !String(recipe.name || '').trim()) throw new Error('a recipe needs a name');
    const isExistingCustom = recipe.id && customs.some(c => c.id === recipe.id);
    const rec = normCustom(recipe);
    // mint under a custom-recipe- prefix so a mission id can never collide with a custom SPECIALTY (custom-<slug>),
    // which share the bay's preview-state map; specialties mint custom-<slug>, missions custom-recipe-<slug>.
    rec.id = isExistingCustom ? recipe.id : uniqueId('custom-recipe-' + (slugify(recipe.name) || 'mission'));
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

  // R3 soft-warning heuristic: does this recipe's directive template imply an OUTBOUND action (a send / post /
  // message / publish / file write / commit)? Scheduling such a recipe as an UNATTENDED routine deserves a warn
  // line (never a block — law 1). Pure string scan over the task template; a false positive just shows a warning.
  const OUTBOUND_RE = /\b(send|reply|post|publish|message|email|e-mail|dm|tweet|commit|push|deploy|write\s+(?:to\s+)?(?:the\s+)?(?:file|disk)|save\s+(?:to\s+)?(?:the\s+)?(?:file|disk)|delete|remove)\b/i;
  function impliesOutbound(idOrRecipe) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r) return false;
    return OUTBOUND_RE.test(String(r.task || ''));
  }

  /* ================= R6: marketplace surface (export / import / ranking) =================
     Pure, node-testable helpers appended near the public API. They do NOT touch the launch primitives above —
     export/import move a recipe as a portable JSON unit; rankRecipes powers the "FOR YOU" row deterministically. */

  // the on-disk format marker. Bump only on a breaking format change; importers accept any value they understand.
  const EXPORT_FORMAT = 1;
  // the fields an exported recipe carries — the v2 authoring surface, nothing runtime/derived. `custom`,
  // `seedborn`, timestamps and any live-routine state are deliberately NOT exported (they're local provenance).
  const EXPORT_FIELDS = ['id', 'name', 'emoji', 'tagline', 'blurb', 'accent', 'tags', 'params', 'task', 'steps', 'acceptance', 'gear', 'skills', 'cadence', 'category', 'source', 'forkedFrom'];

  // EXPORT: a plain, JSON-serializable object for ONE recipe (built-in or custom), stamped with a format marker.
  // Returns null for an unknown id. The result is a deep copy (never a live/frozen ref) so a caller can pretty-print
  // and hand it to a file download. It is the seed of the open-core marketplace unit — a clean portable format,
  // no network. The original recipe's `id` is kept as provenance; importRecipe re-homes it into forkedFrom.
  function exportRecipe(idOrRecipe) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r) return null;
    const out = { starnetRecipe: EXPORT_FORMAT };
    for (const k of EXPORT_FIELDS) {
      const v = r[k];
      if (v == null) { out[k] = (k === 'cadence' || k === 'forkedFrom') ? null : v; continue; }
      if (k === 'tags') out.tags = Object.assign({}, v);
      else if (k === 'params') out.params = (Array.isArray(v) ? v : []).map(p => ({ key: p.key, label: p.label, placeholder: p.placeholder, required: p.required, default: p.default, type: p.type || 'text', options: (Array.isArray(p.options) ? p.options : []).slice() }));
      else if (k === 'gear' || k === 'skills' || k === 'steps') out[k] = (Array.isArray(v) ? v : []).slice();
      else if (k === 'acceptance') out.acceptance = (Array.isArray(v) ? v : []).map(a => Object.assign({}, a));
      else out[k] = v;
    }
    return out;
  }

  // validate the SHAPE of a parsed import object (never executes anything from it). Returns { ok:true, recipe } with
  // a sanitized DRAFT (unknown fields stripped, arrays coerced) or { ok:false, error } with an honest reason. This is
  // the trust boundary: an imported file is data, so we only ever read strings/arrays out of it and re-run them
  // through the same normalizers a hand-authored save uses — a malformed file can NEVER produce an ungated or
  // ambiguous recipe, and there is no code path from the file into the agent's directive beyond the task TEMPLATE.
  function validateImport(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'not a recipe file (expected a JSON object)' };
    // required: a name and a task template. `id` is used only for provenance (forkedFrom), never to overwrite.
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const task = typeof obj.task === 'string' ? obj.task.trim() : '';
    if (!name) return { ok: false, error: 'the file has no recipe name' };
    if (!task) return { ok: false, error: 'the file has no directive (task) template' };
    // params: an array of sane {key,...} descriptors. A non-array (or garbage) is dropped → normCustom re-derives
    // from the template tokens, so the recipe is never left with a literal {token} it can't fill.
    const rawParams = Array.isArray(obj.params) ? obj.params : [];
    const params = rawParams
      .filter(p => p && typeof p === 'object' && !Array.isArray(p) && typeof p.key === 'string' && p.key.trim())
      .map(p => ({
        key: String(p.key).trim(),
        label: typeof p.label === 'string' ? p.label : '',
        placeholder: typeof p.placeholder === 'string' ? p.placeholder : '',
        required: p.required !== false,
        default: typeof p.default === 'string' ? p.default : '',
        // typed fill-ins ride the portable format too; freezeParam re-validates (unknown type -> text, a choice
        // with < 2 options -> text), so a hand-edited file can never produce a picker with nothing to pick.
        type: typeof p.type === 'string' ? p.type : 'text',
        options: Array.isArray(p.options) ? p.options : []
      }));
    // a sanitized DRAFT (plain strings/arrays only) — saveCustom/normCustom apply the real freezing + defaults.
    // provenance: if the file carried an id, keep it as forkedFrom (source:'fork') so the import reads as "from
    // <original>"; else it's a plain 'custom'. A file that already declared forkedFrom keeps that lineage.
    const originId = (obj.id != null && String(obj.id).trim()) ? String(obj.id).trim() : null;
    const carriedFork = (obj.forkedFrom != null && String(obj.forkedFrom).trim()) ? String(obj.forkedFrom).trim() : null;
    const forkedFrom = carriedFork || originId;
    const recipe = draft({
      name, task,
      emoji: typeof obj.emoji === 'string' ? obj.emoji : '',
      tagline: typeof obj.tagline === 'string' ? obj.tagline : '',
      blurb: typeof obj.blurb === 'string' ? obj.blurb : '',
      accent: typeof obj.accent === 'string' ? obj.accent : '',
      tags: (obj.tags && typeof obj.tags === 'object' && !Array.isArray(obj.tags)) ? obj.tags : null,
      params,
      // SOP fields ride the portable format; normSteps/normAcceptance re-validate on save (a hand-edited file can
      // never smuggle an unknown predicate type or an absolute/`..` path past the sidecar's own rules).
      steps: Array.isArray(obj.steps) ? obj.steps.filter(x => typeof x === 'string') : [],
      acceptance: Array.isArray(obj.acceptance) ? obj.acceptance.filter(a => a && typeof a === 'object' && !Array.isArray(a)) : [],
      gear: Array.isArray(obj.gear) ? obj.gear : [],
      skills: Array.isArray(obj.skills) ? obj.skills : [],
      cadence: obj.cadence != null ? obj.cadence : null,
      category: typeof obj.category === 'string' ? obj.category : null,
      // an imported recipe is never a builtin — it's always yours. If it named a parent, mark it a fork of that.
      source: forkedFrom ? 'fork' : 'custom',
      forkedFrom
    });
    return { ok: true, recipe };
  }

  // IMPORT: validate a parsed object, then SAVE it as a fresh custom (mints a new custom-recipe-<slug> id so it can
  // never collide with — or overwrite — an existing recipe). Returns { ok:true, recipe:<saved> } or { ok:false,
  // error }. Nothing from the file is executed; only the recipe's own launch (later, by the user) ever runs its task.
  function importRecipe(obj) {
    const v = validateImport(obj);
    if (!v.ok) return v;
    // strip any id from the draft so saveCustom always mints a fresh one (the file's id lives on in forkedFrom).
    const clean = Object.assign({}, v.recipe); delete clean.id;
    try {
      const saved = saveCustom(clean);
      return { ok: true, recipe: saved };
    } catch (e) { return { ok: false, error: (e && e.message) || 'could not save the imported recipe' }; }
  }

  /* does a recipe's browsable text match a free-text goal string? A deterministic keyword overlap over the goal's
     words against the recipe's name+tagline+tags — returns a small count used as a ranking nudge (never the sole
     signal). Pure + case-insensitive; punctuation is split on. No fuzzy matching (honest).

     MATCHING IS WORD-WISE, NOT SUBSTRING. The first cut used `hay.indexOf(word)`, which made "for" match
     per·FOR·mance and "the" match o·THE·r — on a cold station (no profile affinity, no launches) this term is the
     ONLY live signal, so stopword collisions alone decided the whole FOR YOU row: a real goals belief scored 42 of
     50 recipes above zero and surfaced four unrelated cards. Two rules fix it and keep the result explainable:
       • common words carry no topic signal and are skipped outright (the same GOAL_STOP discipline the
         specialist shelf already applies);
       • a hit means the recipe's text contains that WORD — exact, or the word plus one ordinary English suffix
         ("test" matches "testing", "brief" matches "briefs") — never a fragment buried inside a longer word. */
  const GOAL_STOP = new Set(['the', 'and', 'for', 'you', 'your', 'with', 'that', 'this', 'from', 'are', 'was', 'has',
    'have', 'will', 'can', 'all', 'any', 'out', 'get', 'got', 'its', 'our', 'but', 'who', 'how', 'why', 'what',
    'when', 'into', 'over', 'more', 'most', 'some', 'than', 'then', 'them', 'they', 'use', 'using', 'need', 'want',
    'like', 'just', 'also', 'one', 'two', 'per', 'via', 'not', 'new', 'own', 'make', 'made', 'work', 'working',
    // filler that survived the first pass: function words a goal sentence carries but no recipe is ABOUT.
    'always', 'ready', 'fully', 'really', 'very', 'much', 'many', 'every', 'each', 'other', 'same', 'thing',
    'things', 'stuff', 'something', 'anything', 'someone', 'anyone', 'around', 'about', 'because', 'been', 'help',
    'being', 'doing', 'does', 'did', 'able', 'good', 'well', 'back', 'keep', 'give', 'take', 'know', 'let']);
  const GOAL_SUFFIX = new Set(['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'ly']);
  // split any text into its lowercase word tokens (>= 3 chars — shorter words are noise at this scale).
  function goalWords(text) {
    return String(text == null ? '' : text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  }
  // the goal keywords this recipe actually matched, in goal order, de-duped. Exported shape for the caller that
  // wants to NAME the reason ("matches your goal: X") rather than assert an unexplained number.
  function goalKeywordHits(recipe, goalText) {
    if (!recipe || !goalText) return [];
    // the haystack is the recipe's READABLE text (name + tagline + blurb) — deliberately NOT its tag keys. The
    // lanes are internal vocabulary ('code'/'research'/'general'), so a goal that merely contains the word
    // "general" used to score a point against every general-lane recipe in the catalog: twenty identical false
    // hits and no way for the Commander to see why. Every hit is now a word they can find on the card itself.
    const hay = new Set(goalWords((recipe.name || '') + ' ' + (recipe.tagline || '') + ' ' + (recipe.blurb || '')));
    if (!hay.size) return [];
    const seen = {}, hits = [];
    for (const w of goalWords(goalText)) {
      if (seen[w] || GOAL_STOP.has(w)) continue;
      seen[w] = true;
      let hit = false;
      for (const h of hay) { if (h.length >= w.length && h.indexOf(w) === 0 && GOAL_SUFFIX.has(h.slice(w.length))) { hit = true; break; } }
      if (hit) hits.push(w);
    }
    return hits;
  }
  function goalKeywordScore(recipe, goalText) { return goalKeywordHits(recipe, goalText).length; }

  /* MERGE NOTE (2026-07-28): the learned-topic lane landed its own stoplist here, deliberately scoped to filter
     only which hit a REASON may NAME — never the score — because re-ranking every Commander's row was outside
     that lane's mandate, and it flagged "the underlying rank noise is real and worth its own decision". This
     branch IS that decision: the stoplist now lives INSIDE goalKeywordHits (above) and applies to the rank too,
     so hits and score can never disagree. Its `namableGoalHits` filter is therefore already satisfied by every
     hit list this module produces, and folding the two stoplists into one is what keeps them from drifting. */
  const namableGoalHits = (hits) => (Array.isArray(hits) ? hits : []).filter(w => !GOAL_STOP.has(String(w)));

  /* ---- the LEARNED-TOPIC term (2026-07-28) ----
     The station's interest histogram (sidecar/interests.js, served to the browser via GET /api/scout and cached
     in ProspectStore.interests()) knows WHAT the Commander keeps working on — "gpu price tracking", not just
     "research". Until now the FOR YOU row could not read it. This folds it in as ONE MORE POSITIVE TERM.

     STRICTLY ADDITIVE, and that is the safety property: TopicMatch.match returns null unless a WARM topic
     (weight ≥ 0.8) covers a majority of the recipe's tokens, so on a cold/calibrating station the term is
     exactly 0 and every ranking is byte-identical to before. Because it can only ever RAISE a score, it can
     never shrink the survivor set the way the negative outcome term could (the 2026-07-26 blank-shelf trap) —
     it can only promote a recipe the Commander's real, evidenced work points at.

     CAPPED on purpose: interests.fold grows a topic's weight by ~1 per observation with no ceiling, so an
     uncapped term would eventually swamp affinity, goals and outcomes alike and freeze the row on one subject. */
  const TOPIC_SCALE = 1.5;   // one warm topic fully covered (weight 1.0) ≈ a two-keyword goal match
  const TOPIC_CAP = 3;       // …and no amount of accumulated weight may exceed a strong goal match
  function topicMatch(recipe, topics) {
    if (!TopicMatch || !TopicMatch.match || !recipe) return null;
    const corpus = (recipe.name || '') + ' ' + (recipe.tagline || '') + ' ' + (recipe.blurb || '') + ' ' +
      Object.keys(recipe.tags || {}).join(' ') + ' ' + (recipe.category || '');
    try { return TopicMatch.match(topics, corpus); } catch (_) { return null; }
  }
  function topicScore(recipe, topics) {
    const m = topicMatch(recipe, topics);
    return m ? TopicMatch.term(m, TOPIC_SCALE, TOPIC_CAP) : 0;
  }

  /* forYouReason — the honest WHY for one FOR YOU card, recomputed from the SAME inputs that ranked it (pure,
     no state). Precedence is most-specific-evidence first: a learned topic names the actual subject and its
     observation count; a goal match names the matched word; then the Commander's own verdicts, then launches.
     Returns '' when no term the caller can honestly phrase fired — the caller then falls back to its profile-
     affinity copy, or shows no reason at all. Truthful-telemetry law: every string here traces to a real
     persisted counter, so a card can never claim a reason the backend cannot prove. */
  function forYouReason(recipe, opts) {
    opts = opts || {};
    if (!recipe) return '';
    const m = topicMatch(recipe, opts.topics);
    if (m && TopicMatch && TopicMatch.reason) { const r = TopicMatch.reason(m); if (r) return r; }
    const gh = namableGoalHits(goalKeywordHits(recipe, opts.goalText || ''));
    if (gh.length) return 'it matches your goal: “' + gh[0] + '”';
    // the PAIN/AMBITION term (momentum loop, 2026-08-21): the same word-wise matcher over what the Commander said
    // eats their time / what they keep meaning to do — the two highest-signal "automate this for me" dossier dims.
    const ph = namableGoalHits(goalKeywordHits(recipe, opts.painText || ''));
    if (ph.length) return 'it matches something you want off your plate: “' + ph[0] + '”';
    const u = (opts.launches && typeof opts.launches === 'object') ? opts.launches[recipe.id] : null;
    const rated = (u && typeof u === 'object' && u.rated && typeof u.rated === 'object') ? u.rated : null;
    const great = rated && Number.isFinite(rated.great) && rated.great > 0 ? Math.floor(rated.great) : 0;
    if (great > 0) return 'you rated this work great ' + great + '×';
    const n = (u && typeof u === 'object') ? u.n : u;
    if (Number.isFinite(n) && n > 0) return 'you have launched this ' + Math.floor(n) + '×';
    return '';
  }

  // RANK the "FOR YOU" row deterministically. `opts`:
  //   score(itemTags) -> number  — the profile affinity scorer (ProfileStore.score), or null when learning is off/thin.
  //   goalText        -> string  — the user's goals belief text (keyword-matched into the ranking as a small nudge).
  //   painText        -> string  — the user's PAIN + AMBITION belief text (dossier dims `pain`, `ambition`: what eats
  //                      their time / what they never find time for). Same word-wise matcher and weight as goals —
  //                      these are the dims that literally name the work the Commander wants taken off their
  //                      shoulders, and the shelf used to ignore them entirely (momentum loop, 2026-08-21).
  //   launches        -> {id: {n, rated?}} or {id: n} — REAL per-recipe launch counts (the scout usage read), each
  //                      optionally carrying rate-the-work outcome counters {great, ok, miss}. Launching ranks a
  //                      recipe up (capped nudge); the Commander's own verdicts rank what actually HELPED.
  //   topics          -> [row]   — the station's LEARNED interest topics (interests.summary rows, as served by
  //                      GET /api/scout and cached in ProspectStore.interests()). A warm topic that covers the
  //                      recipe adds a capped POSITIVE term — never subtracts, so it cannot empty the row.
  //   exclude         -> id      — a recipe to omit (e.g. the one already in the dossier).
  //   limit           -> N       — how many to return (default 4).
  // Signal blend: (profile affinity × 4) + (goal-keyword hits × 2) + min(launches, 5) + OUTCOME + TOPIC, where OUTCOME =
  // min(great, 3) − 2·min(miss, 3) — asymmetric on purpose: a recipe the Commander keeps rating 👎 sinks fast and
  // can drop out of the row entirely (score ≤ 0 is filtered — the honest sink), while 👍 lifts it gently. Ratings
  // never count as a signal on their own (a rating implies a launch, which already signals). Tie-broken by original
  // catalog order so the result is STABLE for a fixed input (test-friendly). If EVERY signal is silent (no profile
  // + no goal match + never launched), we fall back to an HONEST category spread — one recipe per distinct category
  // in catalog order — so a cold-start user still sees a varied, non-arbitrary row (never a fake "popular"
  // ordering; truthful-telemetry law — the launch counts are the user's OWN real launches, never anyone else's).
  /* rankRecipesExplained — the ranker, plus the ONE fact its caller cannot otherwise recover: did any real signal
     produce this row, or is it the cold-start category spread? (2026-08-05)

     The bay printed its personalized "◈ FOR YOU" header off `UnderstandingStore.readiness()` alone. Readiness
     says the station has learned enough to be ASKED; it does not say this particular row used any of it. A
     Commander with a filled dossier but no profile signal, no goal keyword that hits any of ~100 recipe names,
     no launches and no warm topic gets `anySignal === false` and a category spread drawn in catalog order — and
     a header claiming those three cards are FOR THEM. That is the product's core law broken by a string.

     rankRecipes keeps its exact old signature and return value (an array) so every existing caller and test is
     byte-unaffected; this is the same function with the fact attached. `personalized` is true only when a real
     term fired AND survived the sink — a row that is entirely spread reports false, and the top-up case (≥1 real
     card, the rest spread) reports true, because at least one card genuinely is for them.

     ⛔ AND `personalized` ALONE STILL OVERCLAIMS ON THE TOP-UP PATH (2026-08-05). "at least one card is for them"
     is not "this row was picked from your real work", and the header was reading the boolean as if it were. A
     one-hit row tops up from the SAME catalog spread the cold start uses, and those filler cards carry no why at
     all — so a plural, whole-row claim sat over two cards the station had never seen the Commander touch. So the
     count rides out too: `scored` is how many cards a real term actually produced, `items.length` how many are
     shown. Equal → the whole row is earned. Fewer → the caller owes MIXED phrasing, not the full claim. */
  function rankRecipes(items, opts) { return rankRecipesExplained(items, opts).items; }
  function rankRecipesExplained(items, opts) {
    opts = opts || {};
    const list0 = Array.isArray(items) ? items : builtins();
    const exclude = opts.exclude || null;
    const limit = opts.limit != null ? opts.limit : 4;
    const scoreFn = typeof opts.score === 'function' ? opts.score : null;
    const goalText = opts.goalText || '';
    const painText = opts.painText || '';
    const launches = (opts.launches && typeof opts.launches === 'object') ? opts.launches : null;
    const launchCount = (id) => {
      if (!launches || !id) return 0;
      const u = launches[id];
      const n = (u && typeof u === 'object') ? u.n : u;
      return (Number.isFinite(n) && n > 0) ? Math.min(5, Math.floor(n)) : 0;
    };
    // the outcome term (lane B): the Commander's OWN rate-the-work verdicts on this recipe's runs. Capped both
    // ways and miss-heavy on purpose (a 👎 is rarer and better-informed than a 👍); bad counters read as zeros.
    const outcomeScore = (id) => {
      if (!launches || !id) return 0;
      const u = launches[id];
      const r = (u && typeof u === 'object') ? u.rated : null;
      if (!r || typeof r !== 'object') return 0;
      const g = (Number.isFinite(r.great) && r.great > 0) ? Math.min(3, Math.floor(r.great)) : 0;
      const m = (Number.isFinite(r.miss) && r.miss > 0) ? Math.min(3, Math.floor(r.miss)) : 0;
      return g - 2 * m;
    };
    const topics = Array.isArray(opts.topics) ? opts.topics : null;
    const preferenceModel = opts.preferenceModel && typeof opts.preferenceModel === 'object' ? opts.preferenceModel : null;
    const preferenceScore = (recipe) => {
      if (!preferenceModel) return 0;
      const rows = [];
      const kind = preferenceModel.kinds && preferenceModel.kinds.recipe;
      if (kind && Number.isFinite(kind.weight)) rows.push(kind.weight);
      const traits = preferenceModel.traits || {};
      const keys = [recipe.category, recipe.id].concat(Object.keys(recipe.tags || {}).filter(k => Number(recipe.tags[k]) > 0));
      for (const key of keys) { const row = traits[String(key || '').toLowerCase()]; if (row && Number.isFinite(row.weight)) rows.push(row.weight); }
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0;
    };
    const pool = list0.filter(r => r && r.id !== exclude);
    let anySignal = false;
    const scored = pool.map((r, idx) => {
      const aff = scoreFn ? (Number(scoreFn(r.tags || {})) || 0) : 0;
      const goal = goalKeywordScore(r, goalText) + goalKeywordScore(r, painText);   // goals + pain/ambition, same weight
      const use = launchCount(r.id);
      // a WARM learned topic is real evidence in its own right (it is only ever folded from observed activity),
      // so it counts as signal — a station that has learned a habit but launched nothing is NOT cold-start.
      const topic = topics ? topicScore(r, topics) : 0;
      const preference = preferenceScore(r);
      if (aff > 0 || goal > 0 || use > 0 || topic > 0 || preference !== 0) anySignal = true;   // ratings never signal alone: a rating implies a launch
      return { r, idx, s: aff * 4 + goal * 2 + use + outcomeScore(r.id) + topic + preference * 3 };
    });
    if (anySignal) {
      let top = scored
        .filter(x => x.s > 0)
        .sort((a, b) => (b.s - a.s) || (a.idx - b.idx))
        .slice(0, limit)
        .map(x => x.r);
      // TOP UP a thin row. Now that goal matching is word-wise (not substring), a real goals belief legitimately
      // scores only a handful of recipes — which used to render a lonely one- or two-card shelf. Fill the rest
      // from the SAME honest category spread the cold start uses, drawing only on recipes that scored EXACTLY
      // zero: a recipe the Commander rated 👎 carries a negative score and must stay sunk, never quietly readmitted.
      const earned = top.length;   // how many cards a real term actually produced, BEFORE any filler
      if (top.length && top.length < limit) {
        const inRow = {}; top.forEach(r => { inRow[r.id] = true; });
        const spare = scored.filter(x => x.s === 0 && !inRow[x.r.id]).map(x => x.r);
        top = top.concat(categorySpread(spare, limit - top.length, opts.spreadOffset));
      }
      // …unless the SINK TOOK EVERYTHING. The outcome term is negative-heavy on purpose, so a station whose only
      // engagement on record is a 👎 (launched one recipe, rated it miss — the exact first-session shape: no
      // profile affinity, no goal text) scores every candidate <= 0 and this filter returns NOTHING. The caller
      // renders no row at all, so honest feedback would DELETE the FOR YOU shelf. Fall through to the cold-start
      // spread instead: "nothing has earned the row yet" is the same honest state as never having launched one.
      if (top.length) return { items: top, personalized: true, scored: earned };
    }
    // honest cold-start fallback: a bucket spread (first recipe of each distinct browse bucket), topped up with
    // the next recipes in order if there aren't enough distinct buckets to fill the row. NOTHING here is about
    // this Commander — which is exactly what `personalized: false` tells the caller to say out loud.
    return { items: categorySpread(pool, limit, opts.spreadOffset), personalized: false, scored: 0 };
  }
  /* One recipe per distinct BROWSE BUCKET, then the remainder, clipped to n. Shared by the cold-start row and
     the thin-signal top-up so "varied" means the same thing in both places.

     ⛔ SPREAD BY BUCKET, NOT BY RAW CATEGORY. This walked `r.category` and it quietly broke as the catalog
     grew: core.js owns four legacy categories (research/code/writing/planning) and sits FIRST in the aggregate,
     so a 4-card cold-start row was filled entirely from core.js before any persona module was reached — the
     other hundred-odd recipes could never appear on a cold station no matter how many were added. It was not
     even varied in the way the Commander sees it, since code+developer and writing+planning+ops each render
     under ONE rail chip. Folding to the bucket first fixes both: the row spans what the rail actually shows.

     `offset` rotates WHICH bucket the row starts from. Selection stays pure and deterministic — the same
     offset always yields the same row, so tests and the all-sunk fallback are unaffected — but a caller that
     passes a real, changing counter (the marketplace passes how many times this Commander has opened the
     recipes tab) shows a different corner of the library on each visit instead of the same four cards forever.
     This claims nothing: the row is labelled as a varied lineup, never as popular or recommended, so rotating
     it stays inside the truthful-telemetry law — there is no assertion here that could become false. */
  function categorySpread(pool, n, offset) {
    const list = pool || [];
    const firstOf = [], seen = {}, rest = [];
    for (const r of list) {
      const b = railBucket(r);
      if (!seen[b]) { seen[b] = true; firstOf.push({ b, r }); } else rest.push(r);
    }
    // rotate the one-per-bucket head so a repeat visitor starts on a different bucket; the remainder keeps
    // catalog order so the tail is still stable and the whole result is a pure function of (pool, n, offset).
    const k = firstOf.length;
    const off = (Number.isFinite(offset) && k > 0) ? (((Math.floor(offset) % k) + k) % k) : 0;
    const head = off ? firstOf.slice(off).concat(firstOf.slice(0, off)) : firstOf;
    return head.map(x => x.r).concat(rest).slice(0, Math.max(0, n));
  }

  return {
    TAGS, GEAR_TYPES, CADENCES, CATEGORIES, SOURCES, PARAM_TYPES, RAIL_BUCKETS, railBucket,
    list, builtins, customs: customList, get, exists,
    fillTask, requiredMissing, paramsFromTemplate, draft, forkFrom, mintFromRun, saveCustom, removeCustom, impliesOutbound,
    // SOP recipes: typed acceptance -> run-body postconditions contract; prose helpers for the dossier/editor
    ACCEPTANCE_TYPES, STEPS_MAX, ACCEPTANCE_MAX, postconditionsFor, acceptanceLabel,
    // R6 marketplace surface
    EXPORT_FORMAT, exportRecipe, validateImport, importRecipe, rankRecipes, rankRecipesExplained, goalKeywordScore,
    goalKeywordHits, forYouReason, topicScore, TOPIC_SCALE, TOPIC_CAP
  };
});
