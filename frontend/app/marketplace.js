/* STARNET — marketplace.js : THE RECRUITMENT BAY — a premium "personnel registry" of agent classes.

   Renders the Specialties catalog (built-ins + the Commander's saved customs) as a roster of engraved
   class SEALS (a challenge-coin per class, drawn by classicons.js — NEVER a character skin; the skin is
   the Commander's own choice at summon). A two-pane character-select layout: the roster grid on the left,
   a live CLASS DOSSIER on the right that re-themes to whichever class is in focus. Self-contained overlay
   (scrim + console), owns its DOM + events, themes purely off the shared CRT vars (marketplace.css).

   Two modes, both opened by the app:
     • 'deploy'  (in-game)  — DEPLOY a specialty onto the CURRENT agent (re-specs purpose + standing orders
                              via the app's real applyAgentConfig path; optionally adopts its voice), SAVE
                              the current agent as a reusable custom specialty, browse + launch RECIPES.
     • 'pick'    (at wake / summon) — choose a specialist to wake a NEW agent as; hands the chosen spec back.

   Accessibility: a real modal dialog (role=dialog, aria-modal), moves focus in, TRAPS Tab, restores focus on
   close. Cards are buttons. Destructive deletes use the app's arm/confirm idiom, never window.confirm.
   UMD-light: a `Marketplace` global. */
'use strict';
const Marketplace = (() => {
  let root = null, ctx = null, view = 'grid';   // 'grid' | 'save' | 'recipesave' | 'launch'
  let opener = null;
  let firstValueForm = null;
  let editingId = null, editingRecipeId = null, launchId = null;
  // context-derived launch values from the READY shelf, keyed by recipe id (see readyShelfHTML/launchFormHTML)
  let readySeeds = {};
  let pendingMintKey = null, pendingMintTemplate = null;
  // SCOUT handoff: the station-drafted recipe being reviewed in the editor. pendingScoutRecipeId is consumed on a
  // successful save (accept — retires the staged draft server-side, never denylists); scoutSeedDraft prefills the
  // whole form (name/emoji/tagline/task — richer than a mint's bare template). Reset wherever the mint keys reset.
  let pendingScoutRecipeId = null, scoutSeedDraft = null;
  // R2 editor working state (the unified fork/create form): the picked gear set, cadence id, category, and the
  // fork provenance carried from a TWEAK. Reset on every open of the editor.
  let editGear = [], editCadence = null, editCategory = 'general', editForkedFrom = null, editParams = [];
  // R5 handoff: the run this editor session is bottling (a mintFromRun proposal's sourceRunId), preserved through
  // save so a bottled recipe keeps honest provenance. null for every other entry point (create / tweak / edit / import).
  let editSourceRunId = null;
  // SOP recipes: the PROCEDURE (one step per line) + the typed ACCEPTANCE rows the editor is working on.
  let editSteps = [], editAcceptance = [];
  // R3 launch/routine state: the live cron jobs (fetched once when the recipes dossier renders) so a recipe can
  // show a "● live — every morning" indicator, and whether the launch pane is in RUN-NOW or MAKE-ROUTINE mode.
  let cronJobs = null, cronArmed = false, launchMode = 'run', launchCadence = null;
  let launchPreviewOpen = false;                  // "WHAT GETS SENT" — open by default: seeing the real directive before you commit IS the point
  let tab = 'agents';                            // 'agents' | 'recipes'
  let glassOpen = false;
  let scoutLogOpen = false;                       // the collapsible SCOUT LOG (attempt ledger) — collapsed by default
  let pendingCardAnim = false;                   // play the staggered card-entrance ONCE per open/tab-switch, not on every filter/search rebuild
  let pickedSummonSkin = null;
  let pickedSummonModel = null;   // SUMMON-only per-agent model choice: { model, provider, effort } or null = inherit the orchestrator's
  let pickedSummonName = '';      // SUMMON-only agent NAME typed in the config strip ('' = default to the class name)
  let modelSettingsOpen = false;
  let focusAgent = null, focusRecipe = null;     // the spec/recipe id shown in the dossier (per tab)
  let laneFilter = 'all';                        // 'all' | 'code' | 'research' | 'general'  (AGENTS tab)
  let archiveOpen = false;                       // SPECIALIST ARCHIVE (deep-cut archetypes) — collapsed by default
  let catFilter = 'all';                         // 'all' | 'mine' | <rail bucket>          (RECIPES tab, R6)
  let query = '';
  let buildAccent = '#ffaa33', buildModel = 'balanced';   // the custom-class builder's picked accent + tier
  let buildKit = [], buildSkills = [], buildEffort = null;   // the custom-class builder's picked loadout (Class Loadouts S3)
  let buildDraft = null;            // Slice 4: a station-drafted prospect pre-filling the builder (name/tagline/purpose/manual/emoji)
  let acceptingProspectId = null;   // Slice 4: the prospect id being reviewed → removed from staging on a successful CREATE
  // ---- IMPORT AGENT (Hermes / OpenClaw migration) — the view='harnessImport' flow's working state ----
  // importStep: 'detect' (list found installs / PICK FOLDER) → 'preview' (the dossier-style scan card).
  // importFound = the /api/harness/detect list (null until the detect call lands, [] = nothing found).
  // importScan = the /api/harness/scan result being previewed; importOrigin = { harness, root } that produced it.
  // All strings shown come straight from the scan (truthful telemetry) — no invented placeholders.
  let importStep = 'detect', importFound = null, importDetecting = false, importScanning = false;
  let importScan = null, importOrigin = null, importName = '', importErr = '';

  const hasRecipes = () => typeof Recipes !== 'undefined';
  const hasIcons = () => typeof ClassIcons !== 'undefined';
  const mintApi = () => (typeof MintStore !== 'undefined' && MintStore.candidates) ? MintStore : null;

  /* ---------- recipe R2/R3 vocabularies ----------
     CADENCE_OPTS mirrors autojobs.js CADENCES (the proven 4-option menu) — each id maps to a schedule STRING the
     sidecar's cron.parseSchedule accepts (interval or a 5-field cron). Kept here so MAKE ROUTINE can convert a
     recipe's suggested cadence id into a real schedule without a round-trip. 'none' = one-shot (RUN NOW only). */
  const CADENCE_OPTS = [
    { id: 'morning',   label: 'every morning',        schedule: '0 9 * * *' },
    { id: 'weekly',    label: 'every Monday morning', schedule: '0 9 * * 1' },
    { id: 'sixhourly', label: 'every 6 hours',        schedule: 'every 6h' },
    { id: 'hourly',    label: 'every hour',           schedule: 'every 1h' }
  ];
  function cadenceOpt(id) { return CADENCE_OPTS.filter(c => c.id === id)[0] || null; }
  function cadenceLabel(id) { const c = cadenceOpt(id); return c ? c.label : 'one-shot'; }
  // the gear objectTypes a recipe editor offers (same pickable set as the class builder — dish/cabinet/notebook/
  // workbench/studio; computer/connector are per-agent binds, not advisory recipe gear). Labels from the live source.
  const RECIPE_GEAR_PICK = ['dish', 'cabinet', 'notebook', 'workbench', 'studio'];
  // the category buckets the EDITOR offers as authorable browse buckets (the discovery-rail personas).
  const RECIPE_CATEGORIES = ['developer', 'research', 'creator', 'ops', 'business', 'money', 'data', 'general'];
  const CAT_LABEL = { developer: 'CODING', research: 'LEARNING & RESEARCH', writing: 'WRITING & CONTENT', creator: 'WRITING & CONTENT',
    ops: 'WORK & PLANNING', business: 'BUSINESS', money: 'MONEY', data: 'DATA', general: 'EVERYDAY LIFE',
    // legacy aliases older customs may still carry — labeled so a dossier chip never shows a raw slug.
    code: 'DEVELOPER', planning: 'WORK' };
  /* Discovery-rail buckets (in rail order) + the fold from a raw category onto one — BOTH owned by recipes.js
     and delegated to here. They used to be a second copy living in this file, which is a standing invitation
     for the rail and the recommender to disagree about what "one per category" means (they did: the FOR-YOU
     spread walked raw categories while the rail folded them). ORDER IS THE SCAN ORDER: the rail is how a
     Commander who cannot yet name their use case finds one, so it runs work-shaped buckets first, then the
     life domains. `.mkt-lanes` wraps (flex-wrap), so a rail this long lays out as two tidy rows.

     Read LAZILY, never at module scope: this file is written to survive `Recipes` being absent entirely
     (see hasRecipes()), and a top-level `Recipes.RAIL_BUCKETS` would throw on load and take the whole bay
     down instead of just the recipes tab. Fall back to the bare bucket when it is not there. */
  const RAIL_BUCKETS_FALLBACK = ['developer', 'research', 'creator', 'ops', 'business', 'money', 'data', 'general'];
  const railBuckets = () => (hasRecipes() && Recipes.RAIL_BUCKETS) || RAIL_BUCKETS_FALLBACK;
  const railBucket = (r) => (hasRecipes() && Recipes.railBucket) ? Recipes.railBucket(r) : 'general';

  /* ---------- personalization (the recommender's read surface) ---------- */
  const FAM_TAGS = ['code', 'research', 'general'];
  const TAG_LABEL = { code: 'CODE', research: 'RESEARCH', general: 'GENERAL OPS' };
  // EVERY reason string must read as natural English after the shared “because …” framing (Recommend.whyLine).
  // “because matches your focus on code” was not a sentence — the leading “it” is what makes it one.
  const BECAUSE = { code: 'it matches your focus on code', research: 'it matches your focus on research', general: 'it fits your day-to-day ops' };
  const ACK_KEY = 'starnet.profile.ack.v1';
  /* The cold-start row's rotation seed: a REAL count of how many times this Commander has opened the recipes
     tab, persisted so it survives a reload. With 12 browse buckets and a 3-card shelf, a fixed spread would
     show the same three corners of the library forever and the other nine would only ever be found by
     browsing. This ONLY selects which bucket the varied lineup starts from — it is not a ranking signal, it
     asserts nothing about the recipes it picks, and the shelf is labelled as a varied lineup rather than as
     popular or recommended, so rotating it stays inside the truthful-telemetry law. */
  const VISITS_KEY = 'starnet.recipes.visits.v1';
  function recipeVisits() { try { return parseInt(localStorage.getItem(VISITS_KEY), 10) || 0; } catch (_) { return 0; } }
  function bumpRecipeVisits() {
    try { const n = recipeVisits() + 1; localStorage.setItem(VISITS_KEY, String(n)); return n; } catch (_) { return 0; }
  }
  const profileApi = () => (typeof ProfileStore !== 'undefined' && ProfileStore.summary) ? ProfileStore : null;
  function acked() { try { return typeof localStorage !== 'undefined' && !!localStorage.getItem(ACK_KEY); } catch (_) { return true; } }
  function setAcked() { try { if (typeof localStorage !== 'undefined') localStorage.setItem(ACK_KEY, '1'); } catch (_) {} }

  const has = () => typeof Specialties !== 'undefined';
  const sfx = n => { try { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); } catch (_) {} };
  const note = (m, k) => { try { if (ctx && ctx.notify) ctx.notify(m, k); } catch (_) {} };
  const esc = s => U.esc(s == null ? '' : s);   // delegate to the one complete impl (escapes & < > " ')
  function summonCandidateName(s) {
    const typed = (typeof AgentId !== 'undefined' && AgentId.normalizeName) ? AgentId.normalizeName(pickedSummonName) : String(pickedSummonName || '').trim().toUpperCase();
    if (typed) return typed;
    if (ctx && typeof ctx.nextAgentName === 'function') return ctx.nextAgentName((s && s.name) || 'AGENT');
    return (typeof AgentId !== 'undefined' && AgentId.normalizeName) ? AgentId.normalizeName((s && s.name) || 'AGENT') : String((s && s.name) || 'AGENT').toUpperCase();
  }
  function summonNameIssue() {
    if (!String(pickedSummonName || '').trim()) return '';
    return (typeof AgentId !== 'undefined' && AgentId.nameIssue) ? AgentId.nameIssue(pickedSummonName) : (String(pickedSummonName).length > 18 ? 'too-long' : '');
  }
  function summonNameConflict() {
    return !!(String(pickedSummonName || '').trim() && ctx && typeof ctx.nameConflict === 'function' && ctx.nameConflict(pickedSummonName));
  }
  function mkEl(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function voiceName(personaId) { return (typeof Personas !== 'undefined' && Personas.get(personaId) && Personas.get(personaId).name) || personaId; }

  /* ---------- the class seal — the engraved SVG coin (the typed-ASCII layer was removed 2026-07-16;
     the vector seal is the one emblem system, with the class emoji as the custom-class fallback) ---------- */
  function coinInner(item) {
    const svg = hasIcons() ? ClassIcons.svg(item) : null;
    return svg ? '<span class="mkt-coin-ico">' + svg + '</span>' : '<span class="mkt-coin-emoji">' + esc(item.emoji || '◆') + '</span>';
  }
  function codeOf(item) { return hasIcons() ? ClassIcons.code(item) : ''; }
  function laneOf(item) { return hasIcons() ? ClassIcons.lane(item) : 'general'; }
  function laneLabelOf(item) { return hasIcons() ? ClassIcons.laneLabel(item) : 'OPS'; }
  function pipsOf(model) { return hasIcons() ? ClassIcons.pipsHTML(model) : ''; }
  function clearanceLabel(model) { return hasIcons() ? ClassIcons.clearance(model).label : String(model || '').toUpperCase(); }
  function sealHTML(item, withCode) {
    return '<div class="mkt-seal"><div class="mkt-coin">' + coinInner(item) + '</div>' +
      (withCode ? '<span class="mkt-seal-code">' + esc(codeOf(item)) + '</span>' : '') + '</div>';
  }

  /* ---------- LOADOUT resolvers (Class Loadouts S3) — labels/grants from LIVE sources, never hardcoded ----------
     Prop labels + plain-English grants for a kit objectType come from WorldModel's OWNED source of truth
     (CAP_LABEL: the power word every UI already shows; CAP_PROP_MAP: the canonical prop) and the live PropSprites
     catalog (the prop's display label). Skill names/descriptions come from the /api/skills catalog the SKILLS
     window already reads. This keeps the dossier honest — it says exactly what the summon will grant. */
  const WM = () => (typeof WorldModel !== 'undefined') ? WorldModel : null;
  // one plain sentence describing what an objectType grants (the CAP_LABEL power word, humanized).
  const CAP_GRANTS = {
    dish: 'the WEB — live search & fetch', cabinet: 'FILES — read, write & search the workspace',
    notebook: 'MEMORY — a durable notebook it can save to & recall', workbench: 'a TERMINAL — run & test real code (approval-gated)',
    studio: 'IMAGES — generate & analyse visuals', computer: 'COMPUTE — its own workstation', connector: 'LIVE TOOLS — a bound MCP server'
  };
  function capGrant(objType) {
    const t = String(objType || '').trim();
    return CAP_GRANTS[t] || (WM() && WM().CAP_LABEL && WM().CAP_LABEL[t] ? String(WM().CAP_LABEL[t]).toLowerCase() : t);
  }
  // the display label for the prop a kit objectType requisitions (from the live PropSprites catalog via the
  // canonical prop for the cap) — never a hardcoded prop name (onboarding-tour law: resolve from the live catalog).
  function kitPropLabel(objType) {
    const t = String(objType || '').trim();
    const wm = WM(), map = (wm && wm.CAP_PROP_MAP) || {};
    // pick the first prop id that maps to this cap, then look up its catalog label.
    let propId = null;
    for (const pid of Object.keys(map)) { if (map[pid] === t) { propId = pid; break; } }
    if (!propId && map[t]) propId = t;   // workbench/studio map 1:1
    if (propId && typeof PropSprites !== 'undefined' && Array.isArray(PropSprites.CATALOG)) {
      const spec = PropSprites.CATALOG.find(c => c && c.id === propId);
      if (spec && spec.label) return spec.label;
    }
    // last resort: the power word (still a live source, never a made-up prop name)
    return (wm && wm.CAP_LABEL && wm.CAP_LABEL[t]) || t.toUpperCase();
  }

  // skill catalog cache: { slug -> { name, description } } from /api/skills. Fetched once, then dossiers hydrate
  // async (the section renders a placeholder, then fills in). Best-effort — a missing catalog degrades to the slug.
  let skillCatalog = null, skillCatalogPending = null;
  function loadSkillCatalog() {
    if (skillCatalog) return Promise.resolve(skillCatalog);
    if (skillCatalogPending) return skillCatalogPending;
    skillCatalogPending = fetch('/api/skills').then(r => r.ok ? r.json() : { skills: [] })
      .then(d => {
        const map = {};
        for (const s of ((d && d.skills) || [])) if (s && s.slug) map[s.slug] = { name: s.name || s.slug, description: s.description || '' };
        skillCatalog = map; skillCatalogPending = null; return map;
      })
      // FAILURE MUST STAY RETRYABLE: a transient sidecar hiccup used to cache `skillCatalog = {}`, and the
      // `if (skillCatalog)` guard above then short-circuited every later open — recipes showed raw slugs for
      // the rest of the session even after the sidecar recovered. Leave skillCatalog null and clear the
      // in-flight marker so the NEXT natural open re-fetches (same retry shape as cronPending below). Return
      // an empty map so THIS call's hydrateSkillRows degrades to slug placeholders instead of throwing.
      .catch(() => { skillCatalogPending = null; return {}; });
    return skillCatalogPending;
  }

  /* ---------- open / close ---------- */
  function open(context) {
    if (!has()) return;
    const trigger = (typeof document !== 'undefined' && document.activeElement) || null;
    close();
    opener = trigger;
    ctx = context || {};
    view = ctx.firstValue ? 'firstvalue' : 'grid'; editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null;
    editForkedFrom = null; editSourceRunId = null;
    importStep = 'detect'; importFound = null; importDetecting = false; importScanning = false;
    importScan = null; importOrigin = null; importName = ''; importErr = '';
    laneFilter = 'all'; catFilter = 'all'; query = '';
    lastDecodedHero = null;   // a fresh bay open replays the hero decode beat once
    recipeRuns = null; recipeDrift = null;   // re-read the run log (+ drift) on every open: work done since the last visit shows up
    invalidateFit();          // …and so does a folder granted or a channel connected in another panel since
    // SCOUT: re-read server truth on open (fresh drafts/interests land) and push the browser-only dedup context.
    try { if (typeof ProspectStore !== 'undefined' && ProspectStore.refresh) { ProspectStore.pushContext(); ProspectStore.refresh(); } } catch (_) {}
    // DISCOVERY: same discipline (consistency sweep, 2026-08-30) — the store's only other refreshes were init
    // and decide, so findings the sidecar staged AFTER page load never reached the shelf until a reload. The
    // read is coalesced (REFRESH_MIN_MS) and fail-open like its sibling above.
    try { if (typeof DiscoveryStore !== 'undefined' && DiscoveryStore.refresh) DiscoveryStore.refresh(); } catch (_) {}
    tab = (ctx.mode !== 'pick' && ctx.tab === 'recipes' && hasRecipes()) ? 'recipes' : 'agents';
    // count the VISIT, not the render — forYouShelfHTML re-runs on every filter and search keystroke, and
    // seeding the rotation from that would reshuffle the shelf under the Commander's cursor as they type.
    if (tab === 'recipes') bumpRecipeVisits();
    glassOpen = !acked();
    scoutLogOpen = false;
    pickedSummonSkin = null;
    pickedSummonModel = null;
    pickedSummonName = '';
    modelSettingsOpen = false;
    const builtins = Specialties.builtins();
    focusAgent = (ctx.currentSpecialtyId && Specialties.get(ctx.currentSpecialtyId)) ? ctx.currentSpecialtyId : (builtins[0] && builtins[0].id) || null;
    focusRecipe = hasRecipes() ? ((Recipes.builtins()[0] && Recipes.builtins()[0].id) || null) : null;

    root = mkEl('div', 'mkt-host');
    root.innerHTML =
      '<div class="mkt" tabindex="-1">' +
        '<div class="mkt-head">' +
          '<div class="mkt-nameplate"><span class="mkt-sub" id="mkt-sub">' + esc(subtitle()) + '</span></div>' +
          '<div class="mkt-search">⌕ <input id="mkt-q" type="text" autocomplete="off" spellcheck="false" placeholder="Find a class…" aria-label="Search classes"></div>' +
        '</div>' +
        '<div class="mkt-bar" id="mkt-bar"></div>' +
        '<div class="mkt-stage" id="mkt-stage"></div>' +
      '</div>';
    // The normal window manager owns the frame, focus, drag, resize, minimize and saved geometry.
    // Keep this mounted host intact when it is minimized so recipe/summon drafts survive restore.
    const mounted = root;
    StationUI.toggleTerm('marketplace', plainTitle(), body => {
      body.classList.add('mkt-window-body');
      if (!body.contains(mounted)) body.appendChild(mounted);
    }, { wide: true, console: true, className: 'mkt-window', onClose: () => release(mounted) });
    const q = root.querySelector('#mkt-q');
    if (q) q.addEventListener('input', () => { query = (q.value || '').toLowerCase().trim(); renderStage(); restoreSearchFocus(); });
    root.addEventListener('keydown', onKey);
    sfx('open');
    pendingCardAnim = true;   // the first paint gets the staggered card entrance
    renderBar();
    renderStage();
    const panel = root.querySelector('.mkt'); if (panel) panel.focus();
    maybeConsumeRecipeMint();   // R5: if opened to bottle a run, drop straight into the editor pre-filled from it
    maybeConsumeLaunchSeed();   // lane D: if opened by the routine nudge, drop straight into the launch/SCHEDULE IT form
    maybeConsumeClassSeed();    // intent offer: if opened from a COMMS offer, focus THAT class's dossier
  }
  /* INTENT-OFFER class seed (the launchSeed pattern, AGENTS tab): app.js seeds ctx.classSeed = { id } before
     opening the bay, so accepting a COMMS offer lands on the dossier of the class that was offered rather than
     on the roster's default card — otherwise the Commander has to go find it again, which is the friction the
     offer exists to remove. An ARCHETYPE is not on the default roster, so its card only renders once the
     SPECIALIST ARCHIVE is expanded: seeding one opens the archive too, or the dossier would name a class with
     no visible card. One-shot (cleared before any render) and a graceful no-op on an unknown id. */
  function maybeConsumeClassSeed() {
    const seed = ctx && ctx.classSeed;
    if (!seed || typeof seed !== 'object') return;
    if (ctx) ctx.classSeed = null;   // one-shot: consume before anything that could re-render
    if (tab !== 'agents' || typeof Specialties === 'undefined') return;
    const id = String(seed.id || '');
    const spec = id && Specialties.get ? Specialties.get(id) : null;
    if (!spec) return;                                            // unknown class → leave the bay exactly as it opened
    focusAgent = spec.id;
    // a deep cut lives in the collapsed archive — open it so the focused class actually has a card on screen.
    try {
      const archs = (Specialties.archetypes && Specialties.archetypes()) || [];
      if (archs.some(a => a && a.id === spec.id)) archiveOpen = true;
    } catch (_) {}
    renderBar(); renderStage();
  }
  // R5 "BOTTLE A RUN" consume: app.js seeds ctx.recipeMint (a Recipes.mintFromRun proposal — a DRAFT custom recipe
  // pre-filled from a 👍-rated run's directive, carrying sourceRunId) before opening the bay on the RECIPES tab.
  // Open the R2 editor on it (same entry as TWEAK, but source:'custom' + sourceRunId preserved), then CLEAR the seed
  // so it's one-shot (a re-render / tab-switch never re-triggers it). Graceful no-op if absent or malformed.
  function maybeConsumeRecipeMint() {
    const seed = ctx && ctx.recipeMint;
    if (!seed || typeof seed !== 'object') return;
    if (ctx) ctx.recipeMint = null;   // one-shot: consume before doing anything that could re-render
    if (!hasRecipes() || tab !== 'recipes') return;
    // a bottled proposal must at least carry a task template to be editable; anything less is a malformed seed.
    if (!seed.task || !String(seed.task).trim()) return;
    pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null;
    // 'create' entry (a brand-new custom, not a fork of an existing recipe) — the proposal is the pre-fill.
    // enterRecipeEditor lifts seed.sourceRunId into editSourceRunId so it survives save.
    enterRecipeEditor(seed, 'create');
  }
  // lane D launch-seed consume (the recipeMint pattern): app.js seeds ctx.launchSeed = { id, mode:'run'|'routine' }
  // before opening the bay on the RECIPES tab (App.openRecipeLaunch — the routine-nudge accept). Drop straight into
  // that recipe's launch form, in routine mode when asked (cadence preset to the recipe's suggestion, cron armed-state
  // warmed) — the same PROPOSE-AND-CONFIRM form every manual schedule goes through. One-shot: the seed is cleared
  // before any render so a tab-switch / re-render never re-triggers it. Graceful no-op on an unknown recipe.
  function maybeConsumeLaunchSeed() {
    const seed = ctx && ctx.launchSeed;
    if (!seed || typeof seed !== 'object') return;
    if (ctx) ctx.launchSeed = null;   // one-shot: consume before doing anything that could re-render
    if (!hasRecipes() || tab !== 'recipes') return;
    const r = Recipes.get(String(seed.id || '')); if (!r) return;
    focusRecipe = r.id;
    launchId = r.id;
    launchMode = (seed.mode === 'routine') ? 'routine' : 'run';
    if (launchMode === 'routine') {
      launchCadence = (r.cadence && cadenceOpt(r.cadence)) ? r.cadence : 'morning';
      loadCronJobs().then(() => { if (view === 'launch') renderStage(); });   // refresh the armed-state note
    }
    view = 'launch';
    renderBar(); renderStage();
  }
  function close() {
    if (root) StationUI.closeTerm('marketplace');
  }
  function release(mounted) {
    if (root !== mounted) return;
    if (firstValueForm) { firstValueForm.destroy(); firstValueForm = null; }
    if (!root) return;
    root.remove(); root = null; ctx = null; view = 'grid';
    editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null;
    const o = opener; opener = null;
    try { if (o && o.focus) o.focus(); } catch (_) {}
  }
  // a stage re-render (from typing in search) rebuilds the input; re-focus it and keep the caret at the end.
  function restoreSearchFocus() {
    const q = root && root.querySelector('#mkt-q');
    if (q) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (_) {} }
  }
  function focusables() {
    if (!root) return [];
    return Array.from(root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(e => e.offsetWidth > 0 || e.offsetHeight > 0 || e === document.activeElement);
  }
  // narrow bay = the responsive breakpoint where the dossier becomes a full-width sheet OVER the roster.
  function isNarrowBay() {
    try {
      const panel = root && root.querySelector('.mkt');
      return (panel && panel.clientWidth <= 660) ||
        (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches);
    } catch (_) { return false; }
  }
  function isTypingTarget(t) { return !!(t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
  // dismiss the narrow dossier SHEET back to the roster (the stranded-state fix) and restore focus to the card
  // that opened it, so a keyboard user isn't dropped at the top of the list.
  function closeDossierSheet() {
    const mkt = root && root.querySelector('.mkt'); if (!mkt) return;
    mkt.classList.remove('show-dossier'); sfx('click');
    const fid = tab === 'recipes' ? focusRecipe : focusAgent;
    const card = fid && root.querySelector('.mkt-card[data-id="' + fid + '"]');
    if (card && card.focus) { try { card.focus(); } catch (_) {} }
  }
  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') {
      if (isTypingTarget(e.target)) return; // the shared window first leaves a text field
      // Esc is a STEP-BACK, not an instant bay-close, whenever there's somewhere to step back to (stranded-user
      // law): (1) a full-width form view routes through its own BACK (which resets the right editor state, never
      // discards silently mid-bay); (2) the narrow dossier-only sheet returns to the roster. Only at the top-level
      // grid does Esc close the whole bay.
      if (view !== 'grid') { const back = root.querySelector('.mkt-cancel'); if (back) { e.preventDefault(); e.stopPropagation(); back.click(); return; } }
      const mkt = root.querySelector('.mkt');
      if (mkt && mkt.classList.contains('show-dossier') && isNarrowBay()) { e.preventDefault(); e.stopPropagation(); closeDossierSheet(); return; }
      return; // top-level Escape uses the shared close/draft guard
    }
    // "/" jumps to the search box from anywhere in the bay (unless already typing) — the discovery shortcut.
    if (e.key === '/' && !isTypingTarget(e.target)) {
      const q = root.querySelector('#mkt-q');
      if (q) { e.preventDefault(); q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (_) {} }
    }
  }
  /* The bay hosts TWO dock doors: CREW ▸ RECRUIT (agents) and WORK ▸ RECIPES. The nameplate used to be
     hardcoded to RECRUITMENT BAY, so launching a recipe opened a window titled with a CREW concept — the
     subtitle and search placeholder already tracked the tab, the title never did (UI audit 2026-08-03).
     LABEL LAW (index.html): the title must match or be prefixed by the dock button that opened it, so the
     recipes tab reads RECIPES — exactly the ❒ RECIPES label. plainTitle() feeds the close button's
     aria-label; title() adds the ▮ nameplate glyph. */
  function plainTitle() {
    return (!(ctx && ctx.mode === 'pick') && tab === 'recipes' && hasRecipes()) ? 'RECIPES' : 'RECRUITMENT BAY';
  }
  function title() { return '▮ ' + plainTitle(); }

  function subtitle() {
    if (ctx && ctx.mode === 'pick') return ctx.summon
      ? ('summon a new agent onto your crew — it gets its own chat thread'
         + (ctx.concurrentCap > 0 ? ' · up to ' + ctx.concurrentCap + ' run at once' : ''))
      : 'choose a specialist to wake your agent as';
    const who = (ctx && ctx.agentName) || 'your agent';
    return tab === 'recipes'
      ? 'launch a ready-made recipe — ' + who + ' picks it up in a new task conversation'
      : 'deploy a specialty onto ' + who + ' — or save this one as a template';
  }

  /* ---------- the bar: tabs + lane filter ---------- */
  function renderBar() {
    const bar = root && root.querySelector('#mkt-bar'); if (!bar) return;
    let html = '';
    if (!(ctx && ctx.mode === 'pick') && hasRecipes()) {
      const t = (id, label) => '<button class="mkt-tab' + (tab === id ? ' on' : '') + '" role="tab" aria-selected="' +
        (tab === id ? 'true' : 'false') + '" data-tab="' + id + '">' + label + '</button>';
      // NAV CONDENSE (2026-08-04): the tab is labelled CLASSES, not AGENTS — 'AGENTS' already names the
      // CREW dossier of the crew you HAVE; this tab is the catalog of classes you can summon. The tab id
      // ('agents') is untouched: deep-links (openSummonBay/openDeployBay) and the persisted tab bind to it.
      html += '<div class="mkt-tabs" role="tablist">' + t('agents', '☰ CLASSES') + t('recipes', '❒ RECIPES') + '</div>';
    }
    if (tab === 'recipes' && hasRecipes()) {
      // R6 CATEGORY RAIL — persona buckets (developer/research/creator/ops/general) + ALL + MINE, each with a
      // live count. MINE holds the Commander's own customs (saved / forked / imported). An IMPORT button sits at
      // the end of the rail (file → validate → save as custom); EXPORT lives per-recipe in the dossier.
      const builtins = Recipes.builtins(), customs = Recipes.customs();
      const all = builtins.concat(customs);
      const counts = { all: all.length, mine: customs.length };
      railBuckets().forEach(b => counts[b] = 0);
      all.forEach(r => { const rb = railBucket(r); counts[rb] = (counts[rb] || 0) + 1; });
      const cat = (id, label) => '<button class="mkt-lane' + (catFilter === id ? ' on' : '') + '" aria-pressed="' + (catFilter === id) + '" data-cat="' + id + '">' +
        label + '<span class="ct">' + (counts[id] || 0) + '</span></button>';
      let rail = cat('all', 'ALL');
      railBuckets().forEach(b => { if (counts[b] > 0 || b === 'general') rail += cat(b, CAT_LABEL[b] || b); });
      rail += cat('mine', 'MINE');
      html += '<span class="mkt-lanes-lbl">BROWSE</span><div class="mkt-lanes">' + rail + '</div>' +
        '<button class="mkt-from-notes bb sm" title="turn notes or a sample into a useful draft">DRAFT FROM YOUR NOTES</button>' +
        '<button class="mkt-import bb sm" title="import a recipe from a JSON file">⇪ IMPORT</button>' +
        '<input type="file" id="mkt-import-file" accept="application/json,.json" hidden>';
    } else {
      // FILTER counts span the WHOLE roster — built-ins AND the Commander's customs (audit item 8) — so a lane
      // count never undercounts a class the Commander authored. MINE = the customs scope chip (mirrors RECIPES).
      const customs = has() ? Specialties.customs() : [];
      const pool = Specialties.builtins().concat(customs);
      const counts = { all: pool.length, code: 0, research: 0, general: 0, mine: customs.length };
      pool.forEach(it => { counts[laneOf(it)] = (counts[laneOf(it)] || 0) + 1; });
      const lane = (id, label) => '<button class="mkt-lane' + (laneFilter === id ? ' on' : '') + '" data-lane="' + id + '">' +
        label + '<span class="ct">' + (counts[id] || 0) + '</span></button>';
      let rail = lane('all', 'ALL') + lane('code', 'CODE') + lane('research', 'RESEARCH') + lane('general', 'OPS');
      if (customs.length) rail += lane('mine', 'MINE');
      html += '<span class="mkt-lanes-lbl">FILTER</span><div class="mkt-lanes">' + rail + '</div>';
      // IMPORT AGENT: the one-click migration door from OpenClaw / Hermes. Only meaningful when the bay can MINT a
      // new agent (summon/pick mode carries ctx.onPick) — a deploy-only bay has no agent to create. Mirrors the
      // recipes-tab ⇪ IMPORT control's look (mkt-import pushes it to the right; bb sm is the shared button chrome).
      if (ctx && ctx.onPick) {
        html += '<button class="mkt-import mkt-import-agent bb sm" title="bring an agent over from OpenClaw or Hermes">⇪ IMPORT AGENT</button>';
      }
    }
    bar.innerHTML = html;
    // per-tab search placeholder (audit item 8): name what "search" actually spans on this tab.
    const q = root && root.querySelector('#mkt-q');
    if (q) { const ph = (tab === 'recipes') ? 'search recipes…' : 'Find a class…';
      q.placeholder = ph; q.setAttribute('aria-label', tab === 'recipes' ? 'Search recipes' : 'Search classes'); }
    bar.querySelectorAll('.mkt-tab').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.tab; if (!next || next === tab) return;
      tab = next; view = 'grid'; laneFilter = 'all'; catFilter = 'all'; sfx('click');
      if (next === 'recipes') bumpRecipeVisits();   // arriving via the tab IS a visit (open() only sees ctx.tab)
      pendingCardAnim = true;   // a tab switch is a fresh context — animate; a filter/search rebuild is not
      renderBar(); renderStage(); syncTitle(); syncSub(); syncFoot();
    }));
    bar.querySelectorAll('.mkt-lane[data-lane]').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.lane; if (next === laneFilter) return;
      laneFilter = next; sfx('click'); renderBar(); renderStage();
      // renderBar rebuilt the chips — return focus to the one just clicked (audit item 8), not to the modal shell.
      const again = root.querySelector('.mkt-lane[data-lane="' + next + '"]'); if (again) again.focus();
    }));
    bar.querySelectorAll('.mkt-lane[data-cat]').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.cat; if (next === catFilter) return;
      catFilter = next; sfx('click'); renderBar(); renderStage();
      const again = root.querySelector('.mkt-lane[data-cat="' + next + '"]'); if (again) again.focus();
    }));
    const impAgent = bar.querySelector('.mkt-import-agent');
    if (impAgent) impAgent.addEventListener('click', () => { sfx('click'); enterHarnessImport(); });
    const fromNotes = bar.querySelector('.mkt-from-notes');
    if (fromNotes) fromNotes.addEventListener('click', () => { if (view === 'firstvalue') view = 'grid'; else { ctx.firstValue = {}; view = 'firstvalue'; } renderStage(); });
    wireImport(bar);
  }
  // the nameplate + the close button's aria-label follow the tab, exactly like syncSub does for the subtitle.
  function syncTitle() {
    const win = root && root.closest('.term'); if (!win) return;
    win.querySelector('.term-title').textContent = plainTitle();
    win.querySelector('.term-x').setAttribute('aria-label', 'Close ' + plainTitle());
    win.querySelector('.term-foot-k').textContent = plainTitle();
  }
  function syncSub() { const s = root && root.querySelector('#mkt-sub'); if (s) s.textContent = subtitle(); }
  // the footer legend explains the CARD glyphs of the CURRENT tab — clearance pips on AGENTS, setup marks on
  // RECIPES (the pips legend was plain wrong on the recipes grid). Swapped on every tab change (audit item 8).
  function footLegendHTML() {
    return (tab === 'recipes' && hasRecipes())
      ? 'SETUP&nbsp;&nbsp;<b>▤</b> needs inputs&nbsp;·&nbsp;<b>◷</b> no setup'
      : 'CLEARANCE&nbsp;&nbsp;<b>◆◆◆</b> DEEP&nbsp;·&nbsp;<b>◆◆</b> BALANCED&nbsp;·&nbsp;<b>◆</b> FAST';
  }
  function syncFoot() { const f = root && root.querySelector('#mkt-foot-legend'); if (f) f.innerHTML = footLegendHTML(); }

  /* ---------- stage: two-pane (roster + dossier) OR a full-width form ---------- */
  function renderStage() {
    const stage = root && root.querySelector('#mkt-stage'); if (!stage) return;
    root.classList.toggle('mkt-firstvalue', view === 'firstvalue');
    const draftButton = root.querySelector('.mkt-from-notes');
    if (draftButton) draftButton.textContent = view === 'firstvalue' ? '← ALL RECIPES' : 'DRAFT FROM YOUR NOTES';
    if (firstValueForm) { firstValueForm.destroy(); firstValueForm = null; }
    if (view === 'firstvalue') {
      stage.className = 'mkt-stage form';
      const options = ctx.firstValue || {};
      firstValueForm = FirstValue.mount(stage, Object.assign({}, options, {
        onLaunch: async (recipe, values, source) => {
          if (options.findingId) {
            const r = await Harness.api.post('/api/discovery/decide', {id:options.findingId,decision:'validate'});
            if (!r.ok || r.j?.ok === false) throw Error(r.j?.error || 'This suggestion is no longer available. Review your source.');
          }
          const launched = App.launchRecipe(recipe, values, source);
          if (launched && options.findingId) {
            Harness.api.post('/api/discovery/decide', {id:options.findingId,decision:'accept'}).then(r => {
              if (!r.ok || r.j?.ok === false) throw Error('Suggestion history was not updated.');
            }).catch(() => { if (typeof StationUI !== 'undefined') StationUI.notify('Task launched. Suggestion history could not be updated.', 'warn'); });
          }
          return launched;
        },
        onClear: () => { delete options.findingId; },
        onProjects: () => { close(); document.getElementById('ws-tab-projects')?.click(); },
        onModelSetup: () => { close(); StationUI.openTerm('settings','providers'); },
        onOpenWork: () => close()
      }));
      return;
    }
    if (view === 'save' || view === 'recipesave' || view === 'launch' || view === 'build' || view === 'harnessImport') {
      stage.className = 'mkt-stage form';
      stage.innerHTML = view === 'save' ? saveFormHTML() : view === 'recipesave' ? recipeSaveFormHTML()
        : view === 'build' ? buildFormHTML() : view === 'harnessImport' ? harnessImportHTML() : launchFormHTML();
      if (view === 'save') wireSaveForm(stage);
      else if (view === 'recipesave') wireRecipeSaveForm(stage);
      else if (view === 'build') wireBuildForm(stage);
      else if (view === 'harnessImport') wireHarnessImport(stage);
      else wireLaunchForm(stage);
      return;
    }
    if (tab === 'recipes' && hasRecipes()) syncRecipeFocus();
    stage.className = 'mkt-stage mkt-recruit' + (tab === 'recipes' ? ' mkt-recipes' : ' mkt-agents');
    // a fresh grid render (open / tab / filter / search) always returns to the ROSTER view on a narrow bay — the
    // dossier SHEET is only entered by an explicit card click, never left stuck over a rebuilt roster.
    const mkt0 = root.querySelector('.mkt'); if (mkt0) mkt0.classList.remove('show-dossier');
    const animCls = pendingCardAnim ? ' mkt-anim' : ''; pendingCardAnim = false;   // entrance stagger only on open/tab-switch
    stage.innerHTML = '<div class="mkt-roster' + animCls + '" id="mkt-roster">' + rosterHTML() + '</div>' +
                      '<div class="mkt-dossier" id="mkt-dossier">' + dossierHTML() + '</div>';
    wireRoster(stage);
    wireDossier(stage);
    paintDossierAccent();
    decodeHero();
    hydrateSkillRows();                          // fill real skill names once the catalog loads (agent + recipe dossiers)
    if (tab === 'recipes') { hydrateLiveRoutines(); hydrateRecipeRuns(); hydrateReadyShelf(); }   // "● live as a routine" + the last-run line, once their reads land
    if (!root.contains(document.activeElement)) { const p = root.querySelector('.mkt'); if (p) p.focus(); }
  }
  function renderDossier() {
    const d = root && root.querySelector('#mkt-dossier'); if (!d) return;
    d.innerHTML = dossierHTML();
    wireDossier(root);
    paintDossierAccent();
    decodeHero();
    hydrateSkillRows();                          // fill real skill names once the catalog loads (agent + recipe dossiers)
    if (tab === 'recipes') { hydrateLiveRoutines(); hydrateRecipeRuns(); hydrateReadyShelf(); }   // refresh the live-routine + last-run lines for the focused recipe
    const fid = tab === 'recipes' ? focusRecipe : focusAgent;
    root.querySelectorAll('.mkt-card').forEach(c => {
      c.classList.toggle('sel', c.dataset.id === fid);
      if (tab === 'agents') {
        c.setAttribute('aria-pressed', String(c.dataset.id === fid));
        c.tabIndex = c.dataset.id === fid ? 0 : -1;
      }
    });
  }

  /* ---------- filtering ---------- */
  function matchq(it) {
    if (!query) return true;
    // search spans name + tagline + blurb AND the class CODE (e.g. "ENG") + purpose text (audit item 8), so a
    // Commander can find a class by its stamp or by what it actually does, not just its name.
    const hay = (it.name || '') + ' ' + (it.tagline || '') + ' ' + (it.blurb || '') + ' ' +
      (it.purpose || '') + ' ' + codeOf(it);
    return hay.toLowerCase().includes(query);
  }
  // MINE is a scope filter (customs only), handled by the roster; it must PASS-THROUGH here so filt() doesn't
  // strip every card (no card's lane is literally "mine").
  function passLane(it) { return laneFilter === 'all' || laneFilter === 'mine' || laneOf(it) === laneFilter; }
  function filt(list) { return list.filter(it => passLane(it) && matchq(it)); }
  // RECIPES tab filtering (R6): category rail + free-text search. 'all' passes everything, 'mine' passes customs,
  // any other value is a rail bucket. Search (matchq) also spans the blurb — the plan's name/tagline/blurb search.
  function passCat(r) {
    if (catFilter === 'all') return true;
    if (catFilter === 'mine') return !!r.custom;
    return railBucket(r) === catFilter;
  }
  function filtRecipes(list) { return list.filter(r => passCat(r) && matchq(r)); }
  function syncRecipeFocus() {
    const visible = filtRecipes(Recipes.list());
    const current = focusRecipe && Recipes.get(focusRecipe);
    // Explicit legacy deep links remain usable in the unfiltered library.
    if (current && ((!query && catFilter === 'all') || visible.some(r => r.id === current.id))) return;
    focusRecipe = visible.length ? visible[0].id : null;
  }

  /* ---------- roster (left pane) ---------- */
  function rosterHTML() {
    return (tab === 'recipes' && hasRecipes()) ? recipesRosterHTML() : agentsRosterHTML();
  }
  function agentsRosterHTML() {
    const deploy = !ctx || ctx.mode !== 'pick';
    // search OR a lane filter collapses the top shelves so the results grid owns the pane — the same
    // discipline the RECIPES tab uses (audit item 7). MINE is a lane filter value, so it collapses too.
    const filtering = !!query || laneFilter !== 'all';
    // deploy mode keeps the SAVE-THIS-AGENT toolbar; summon drops the stale "pre-fills the wake screen" hint —
    // the subtitle already states the summon promise, and the dossier's CONFIGURE panel + shelves carry the rest.
    const toolbar = deploy
      ? '<div class="mkt-toolbar"><button class="bb sm mkt-saveas">＋ SAVE THIS AGENT AS A SPECIALTY</button></div>'
      : '';
    let html = toolbar;

    // TOP OF THE PANE: this pane answers ONE question — WHICH CLASS — so it holds only the shelves and the roster.
    // NAME / APPEARANCE / MODEL used to live here as a collapsible SUMMON CONFIG strip, which split the summon
    // decision across both panes (2026-08-15): pick on the left, read on the right, then scroll BACK left to
    // configure. They now live in the dossier's CONFIGURE panel, directly above the button they feed.
    const buildTile = '<button class="mkt-build" type="button" aria-label="build a custom class">' +
      '<span class="mkt-build-plus" aria-hidden="true">＋</span><span class="mkt-build-lbl">BUILD A CUSTOM CLASS</span></button>';
    const allBuiltins = Specialties.builtins();
    const builtins = filt(allBuiltins);
    const customs = filt(Specialties.customs());
    const hasAnyCustoms = Specialties.customs().length > 0;

    // MINE view: the Commander's own specialists only (matches the RECIPES-tab MINE chip).
    if (laneFilter === 'mine') {
      html += sectH('▮ YOUR SPECIALISTS');
      html += customs.length
        ? '<div class="mkt-grid mkt-rows">' + customs.map(cardHTML).join('') + buildTile + '</div>'
        : '<p class="mkt-hint mkt-yours-hint">' + (query ? 'none of your specialists match your search — '
            : 'none yet — ') + 'build one from scratch below.</p><div class="mkt-grid mkt-rows">' + buildTile + '</div>';
      return html;
    }

    // customs pinned ABOVE the built-in catalog when the Commander has some AND isn't searching (their own classes
    // are the more relevant pick); otherwise CLASS ROSTER leads (beginners keep it above the fold) and YOUR
    // SPECIALISTS + the build tile sit at the bottom. (audit item 7 reconciled with item 3)
    const pinCustoms = hasAnyCustoms && !query;
    if (pinCustoms) {
      html += sectH('▮ YOUR SPECIALISTS');
      html += '<div class="mkt-grid mkt-rows">' + customs.map(cardHTML).join('') + buildTile + '</div>';
    }

    html += sectH('▮ CLASS ROSTER');
    // truthful telemetry: an EMPTY catalog means the shared catalog script failed to load (a wiring
    // fault), not "no matches" — say so loudly instead of rendering a quietly blank roster.
    if (!allBuiltins.length) html += '<div class="mkt-empty">⚠ the class catalog failed to load (shared/specialties.js unreachable) — the built-in roster is unavailable. Restart the app; if it persists, this build is mis-wired.</div>';
    else html += builtins.length ? '<div class="mkt-grid mkt-rows">' + builtins.map(cardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no classes match your ' + (query ? 'search' : 'filter') + '.</div>';

    html += archiveSectionHTML(filtering);

    if (!pinCustoms) {
      html += sectH('▮ YOUR SPECIALISTS');
      if (!customs.length) html += '<p class="mkt-hint mkt-yours-hint">' +
        (query ? 'none of your specialists match your search — ' : 'none yet — ') +
        'build one from scratch below' + (deploy && !query ? ', or save the live agent as a specialty above' : '') + '.</p>';
      html += '<div class="mkt-grid mkt-rows">' + customs.map(cardHTML).join('') + buildTile + '</div>';
    }
    if (!filtering) html += '<details class="mkt-library-more"><summary>Suggestions for your station</summary>' +
      glassHTML() + recShelfHTML() + interestGapShelfHTML() + prospectShelfHTML() + scoutLogHTML() + '</details>';
    return html;
  }
  /* ---------- SPECIALIST ARCHIVE: the deep-cut archetype pool (never gated, never in the way) ----------
     The default roster is the curated 12; the demoted deep cuts stay one click away here — full specs,
     summonable as-is. Collapsed by default in the clean view; a search or lane filter that matches an
     archetype auto-expands it (search must FIND a class, never hide it — the no-gating law). These same
     archetypes are what the scout drafts onto the DRAFTED-FOR-YOU shelf when the learned interests point
     at one, so this section is the manual door to the pool the station recommends from. */
  function archiveSectionHTML(filtering) {
    const all = (Specialties.archetypes ? Specialties.archetypes() : []);
    if (!all.length) return '';
    const archs = filt(all);
    if (filtering) {
      // searching / lane-filtering: archetypes participate like any class — matches render expanded, no toggle.
      if (!archs.length) return '';
      return sectH('▮ SPECIALIST ARCHIVE — deep cuts') + '<div class="mkt-grid mkt-rows">' + archs.map(cardHTML).join('') + '</div>';
    }
    const head = '<button type="button" class="mkt-sect-h mkt-archive-head" aria-expanded="' + (archiveOpen ? 'true' : 'false') + '">' +
      '<span aria-hidden="true">' + (archiveOpen ? '▾' : '▸') + '</span> SPECIALIST ARCHIVE (' + all.length + ')</button>';
    if (!archiveOpen) return head;
    return head +
      '<p class="mkt-hint">niche classes held off the main roster — fully specified, summon any time. When your real work points at one, the station drafts it onto the shelf above for you.</p>' +
      '<div class="mkt-grid mkt-rows">' + archs.map(cardHTML).join('') + '</div>';
  }
  /* Name and the live character preview lead. Skin choices stay visible; model controls expand
     in place. Choices and model drawer state survive class changes within this session. */
  function agentReferenceHTML(s) {
    return '<div class="mkt-agent-reference">' +
      (s.purpose ? '<p class="mkt-agent-purpose">' + esc(s.purpose) + '</p>' : '') +
      (s.starters && s.starters.length ? '<div class="bh">EXAMPLE REQUESTS</div><ul class="mkt-agent-examples">' +
        s.starters.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      (s.manual ? '<details class="mkt-recipe-instructions"><summary>Standing instructions</summary><pre>' + esc(s.manual) + '</pre></details>' : '') + '</div>';
  }
  function summonConfigPanelHTML(s) {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon)) return '';
    const panels = [
      '<section class="mkt-appearance" aria-label="Choose a skin"><div class="mkt-appearance-heading">APPEARANCE <span class="mkt-appearance-choice">' +
        esc((typeof DATA !== 'undefined' && DATA.SKINS && DATA.SKINS[pickedSummonSkin || DATA.DEFAULT_SKIN] || {}).name || 'Choose a character') +
        '</span></div>' + summonSkinBarHTML() + '</section>',
      '<p class="mkt-detail-note">Use the station default, or choose a model for this agent.</p>' + summonModelBarHTML(s),
      agentReferenceHTML(s)
    ];
    return '<section class="mkt-config" aria-label="configure this agent">' +
      '<div class="mkt-recruit-identity">' + summonSkinStageHTML() + '<div class="mkt-recruit-fields">' + summonNameBarHTML() + '</div></div>' +
      '<div class="mkt-recipe-detail-tabs" role="tablist" aria-label="Recruit settings">' +
      ['Appearance', 'Model', 'Role'].map((label, i) => '<button type="button" role="tab" id="recruit-tab-' + i +
        '" aria-controls="recruit-panel-' + i + '" aria-selected="' + (i === 0) + '" tabindex="' + (i ? '-1' : '0') +
        '" data-recipe-panel="' + i + '">' + label + '</button>').join('') + '</div>' +
      panels.map((html, i) => '<div class="mkt-recipe-detail-panel" role="tabpanel" id="recruit-panel-' + i +
        '" aria-labelledby="recruit-tab-' + i + '"' + (i ? ' hidden' : '') + '>' + html + '</div>').join('') + '</section>';
  }
  /* The MODEL field's helper line is where CLEARANCE and EFFORT became honest. They used to be two rows of a spec
     grid at the top of the dossier that read "model: station default / class default — applied at summon" — true,
     but stated where nothing could be done about it, which is exactly what made them read as filler. The same
     facts belong on the control that resolves them: what this class is TUNED for, and what your pick OVERRIDES. */
  function modelHelpHTML(s) {
    const pin = pickedSummonModel;
    if (pin && pin.model) return 'pinned to <b>' + esc(shortModel(pin.model)) + '</b>' +
      (pin.effort ? ' at <b>' + esc(String(pin.effort).toUpperCase()) + '</b> effort' : '') + ' — overrides the class default.';
    if (pin && pin.effort) return 'the same brain as your orchestrator, at <b>' + esc(String(pin.effort).toUpperCase()) + '</b> effort.';
    return 'Inherits your orchestrator’s model; tuned for <b>' + esc(clearanceLabel(s && s.model).toLowerCase()) + '</b>' +
      (s && s.reasoningEffort ? ' · ' + esc(String(s.reasoningEffort).toLowerCase()) + ' effort' : '') + '.';
  }

  function summonModelSummary() {
    const pin = pickedSummonModel;
    return (pin && pin.model ? shortModel(pin.model) : 'Station default') +
      (pin && pin.effort ? ' · ' + pin.effort : '');
  }
  function shortModel(m) { return String(m || '').split('/').pop().replace(/[-_]+/g, ' ').trim() || String(m || ''); }
  // ONE section-header component (audit item 8): amber struck-metal plate for roster ranks. Shelves add their own
  // gold/phosphor modifier class on top of .mkt-sect-h; the config strip uses its own plain .mkt-cfg-ttl label.
  function sectH(label, extra) { return '<div class="mkt-sect-h' + (extra ? ' ' + extra : '') + '">' + label + '</div>'; }
  // Recipes lead; personalization and library management remain available under Library options.
  function recipesRosterHTML() {
    if (!hasRecipes()) return '<div class="mkt-empty">the recipe library isn’t available.</div>';
    const filtering = !!query || catFilter !== 'all';   // searching/filtering: the results own the pane (agents-tab discipline)
    const consentFirst = !acked();
    const suggestedHasCards = !filtering && (suggestedMissions().length > 0 || scoutRecipeDrafts().length > 0);
    let html = '';
    const builtins = filtRecipes(Recipes.builtins());
    const customs = filtRecipes(Recipes.customs());
    const yours = (label, empty) => '<div class="mkt-sect-h">▮ YOUR RECIPES</div>' +
      (customs.length ? '<div class="mkt-grid mkt-rows">' + customs.map(recipeCardHTML).join('') + '</div>'
        : '<div class="mkt-empty">' + empty + '</div>');
    // MINE view: a single "YOUR RECIPES" section (the builtins are all filtered out anyway).
    if (catFilter === 'mine') {
      return html + '<button class="bb sm mkt-recipe-saveas">＋ SAVE A RECIPE</button>' + yours('mine', query ? 'none of your recipes match your search.'
        : 'no saved recipes yet — hit “＋ save a recipe” above, TWEAK any recipe into your own, or ⇪ IMPORT one from a file.');
    }
    // YOUR RECIPES leads the library whenever you HAVE any — the Commander's own work is not an appendix to a
    // 50-card catalog. With none saved, the invitation stays below the library where it reads as a next step.
    if (customs.length) html += yours('top', '');
    const libLabel = catFilter === 'all' ? '▮ RECIPE LIBRARY' : ('▮ ' + (CAT_LABEL[catFilter] || catFilter) + ' RECIPES');
    html += '<div class="mkt-sect-h">' + libLabel + '</div>';
    html += builtins.length ? '<div class="mkt-grid mkt-rows">' + builtins.map(recipeCardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no recipes match your ' + (query ? 'search' : 'filter') + '.</div>';


    html += '<details class="mkt-library-more"><summary>Library options</summary>' +
      '<button class="bb sm mkt-recipe-saveas">＋ SAVE A RECIPE</button>' +
      ((!filtering && consentFirst) ? consentStripHTML() : '') +
      (!filtering ? (readyShelfHTML() || forYouShelfHTML()) + discoveryShelfHTML() + suggestedShelfHTML() + glassHTML() + scoutLogHTML() : '') + '</details>';
    return html;
  }
  // the one-line learning disclosure that rides ABOVE the personalized shelf until it's acknowledged. Same words
  // and the same GOT IT action as the full panel's consent block (which stays below) — this is the notice, not a
  // second copy of the console. Hidden the moment it's acked; the panel below remains the place to pause or wipe.
  function consentStripHTML() {
    const ps = profileApi(); if (!ps || !ps.summary || !ps.summary()) return '';
    return '<div class="mkt-consent-strip">◉ STARNET keeps a local preference profile. When Scout drafts a new option, a bounded summary is sent only to your configured model. ' +
      'Pause or wipe it anytime in STATION FAMILIARITY below. <button class="bb sm mkt-fam-ack">GOT IT</button></div>';
  }

  // Keep the raw value visible so a 19-character paste can be explained, never silently clipped.
  function summonNameBarHTML() {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon)) return '';
    const used = ((typeof AgentId !== 'undefined' && AgentId.normalizeName) ? AgentId.normalizeName(pickedSummonName) : String(pickedSummonName || '')).length;
    const max = (ctx && ctx.displayNameLimit) || (typeof AgentId !== 'undefined' && AgentId.NAME_MAX) || 18;
    const issue = summonNameIssue(), dup = summonNameConflict();
    const helper = issue === 'too-long' ? 'too long — shorten this name before summoning'
      : dup ? 'duplicate name — summon requires a second confirmation; the agent id will remain unique'
      : 'blank uses the proposed default: ' + summonCandidateName((focusAgent && Specialties.get(focusAgent)) || null);
    return '<div class="mkt-skinbar mkt-namebar"><label class="mkt-skinlabel" for="mkt-summon-name">NAME</label>' +
      '<input class="mkt-in" id="mkt-summon-name" type="text" autocomplete="off" spellcheck="false" aria-invalid="' + (issue ? 'true' : 'false') + '" placeholder="' + esc(summonCandidateName((focusAgent && Specialties.get(focusAgent)) || null)) + '" value="' + esc(pickedSummonName) + '">' +
      '<div class="mkt-name-meta"><span class="mkt-name-help' + (issue || dup ? ' warn' : '') + '">' + esc(helper) + '</span><span class="mkt-name-count' + (used > max ? ' over' : '') + '">' + used + ' / ' + max + '</span></div></div>';
  }

  // SUMMON-only: pick the new agent's APPEARANCE (its own choice — independent of class). A LIVE preview
  // STAGE (shared SkinStage) plays the picked/hovered skin's real walk cycle big enough to actually read —
  // a 40px still of a chunky sprite is unidentifiable. The picker wells are large + smooth-downscaled so the
  // Commander can judge a skin at a glance; the selected well carries the bracket-ring active treatment.
  function summonSkinBarHTML() {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon) || typeof DATA === 'undefined' || !DATA.SKINS) return '';
    if (!pickedSummonSkin || !DATA.SKINS[pickedSummonSkin]) pickedSummonSkin = DATA.DEFAULT_SKIN;
    const thumbs = Object.keys(DATA.SKINS).map(id => {
      const sk = DATA.SKINS[id];
      return '<button type="button" class="skin-thumb' + (id === pickedSummonSkin ? ' sel' : '') +
        '" data-skin="' + esc(id) + '" aria-pressed="' + (id === pickedSummonSkin) + '" title="' + esc(sk.name || id) + '">' +
        '<img src="assets/sprites/' + esc(sk.set) + '/rot_south.png" alt="' + esc(sk.name || id) + '" draggable="false"></button>';
    }).join('');
    return '<div class="mkt-skinbar"><div class="mkt-skinlabel">Choose any character for this class</div>' +
      '<div class="mkt-skin-section">' +
        '<div class="skin-picker" id="mkt-skin-picker">' + thumbs + '</div>' +
      '</div></div>';
  }

  // Keep the chosen character visible next to the name while browsing the skin grid below.
  function summonSkinStageHTML() {
    return '<figure class="mkt-skin-stage">' +
      '<div class="mkt-skin-stage-frame"><img id="mkt-skin-stage-img" alt="Recruit appearance preview" draggable="false"></div>' +
      '<figcaption class="mkt-skin-stage-name"><span id="mkt-skin-stage-name"></span></figcaption>' +
    '</figure>';
  }

  // SUMMON-only: choose the new agent's MODEL (optional — blank inherits the orchestrator's). Reuses the shared
  // ModelPicker so the catalog, grouping and effort options match the COMMS dock and the dossier. The <select>
  // is populated asynchronously after mount (wireSummonConfig), then read at SUMMON time into spec.modelPin.
  // The helper line under it carries the class's clearance/effort tuning — see modelHelpHTML.
  function summonModelBarHTML(s) {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon) || typeof ModelPicker === 'undefined') return '';
    return '<div class="mkt-skinbar mkt-modelbar"><div class="mkt-skinlabel">MODEL &amp; EFFORT</div>' +
      '<div class="mkt-modelpick" id="mkt-model-pick">' +
        ModelPicker.shellHTML({ id: 'mkt-model', inheritLabel: 'Same as the orchestrator', ariaLabel: 'New agent model', effort: true }) +
      '</div>' +
      '<div class="mkt-field-help" id="mkt-model-help">' + modelHelpHTML(s) + '</div></div>';
  }

  /* ---------- the class card (coin seal in the roster) ---------- */
  function cardHTML(s, i) {
    // DEPLOYED flag is mode-independent: the merged recruit door passes currentSpecialtyId in
    // pick mode too, so the card the current agent already runs as stays honestly marked.
    const here = !!(ctx && ctx.currentSpecialtyId && ctx.currentSpecialtyId === s.id);
    const sel = (focusAgent === s.id);
    // settings-console row shape: [typed mark socket] [name + tagline] ……… [lane · pips · tier / code]
    // — the right cluster is its own column so it right-aligns like the provider rows' status column.
    /* NO `--accent` (2026-08-13). Every row used to inject its spec's raw accent hex here, so the class
       roster rendered its seals in cold blue / steel / green / pink INSIDE an amber phosphor tube —
       thirty-five rows, no two the same, and none of them the station's colour. A CRT emits ONE
       phosphor: the SEAL is engraved station hardware seen through that tube, so it rides `--ph` and
       recolours with the theme. The accent is not lost and not decoration — it is the SUIT the summoned
       agent wears on the floor, which is a painted object and may be any colour. Dropping the inline
       var is the whole fix: every rule in marketplace.css already reads `var(--accent, var(--ph))`.
       Class identity is carried where classicons.js always intended it — the emblem SHAPE and the
       3-letter code stamp, never the colour. */
    return '<button class="mkt-card' + (sel ? ' sel' : '') + '" type="button" aria-pressed="' + sel + '" data-id="' + esc(s.id) + '" style="--ci:' + (i || 0) + '">' +
      sealHTML(s, false) +
      '<div class="mkt-card-id">' +
        '<div class="mkt-name">' + esc(s.name) +
          (here ? ' <span class="mkt-badge mkt-here">DEPLOYED</span>' : '') +
          (s.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
        '<div class="mkt-tag">' + esc(s.tagline) + '</div>' +
      '</div>' +
      '<div class="mkt-card-side">' +
        '<div class="mkt-meta"><span class="mkt-chip lane">' + esc(laneLabelOf(s)) + '</span>' +
          pipsOf(s.model) + ' <span class="mkt-tier">' + esc(clearanceLabel(s.model)) + '</span></div>' +
        '<span class="mkt-card-code">' + esc(codeOf(s)) + '</span>' +
      '</div>' +
    '</button>';
  }
  // lane F: the honest-life chip — the Commander's OWN launch count for this recipe (never anyone else's, never
  // a fake "popular"), plus a rated arrow once their own verdicts point somewhere (great>miss ▲ / miss>great ▽).
  // Every number derives from the scout usage read (ProspectStore.launches — real persisted telemetry).
  function recipeLifeChip(r) {
    try {
      if (typeof ProspectStore === 'undefined' || !ProspectStore.launches) return '';
      const u = (ProspectStore.launches() || {})[r.id];
      const n = (u && typeof u === 'object') ? u.n : u;
      if (!Number.isFinite(n) || n <= 0) return '';
      const rated = (u && typeof u === 'object' && u.rated && typeof u.rated === 'object') ? u.rated : null;
      const g = rated ? (Number(rated.great) || 0) : 0, m = rated ? (Number(rated.miss) || 0) : 0;
      const arrow = (g > m && g > 0) ? ' · rated ▲' : (m > g && m > 0) ? ' · rated ▽' : '';
      return '<span class="mkt-chip mkt-life" title="your own launches' + (arrow ? ' + your ratings' : '') + '">↻ ran ' + Math.floor(n) + '×' + esc(arrow) + '</span>';
    } catch (_) { return ''; }
  }
  function recipeCardHTML(r, i) {
    // the SAME settings-console row shape as the class list (the two tabs share one UI language):
    // [seal socket] [name + tagline] ……… [lane · setup / code stamp]
    const sel = (focusRecipe === r.id);
    const n = (r.params || []).length;
    const missing = Recipes.requiredMissing(r, recipeDefaults(r)).length;
    const setup = missing ? ('▤ ' + missing + ' detail' + (missing === 1 ? '' : 's') + ' needed') : (r.intake || []).length ? '▤ choose options' : '▸ ready to start';
    // SOP: a recipe with host-checked acceptance says so on the card — the one glance that separates "a prompt"
    // from "a procedure the station holds itself to".
    const na = (r.acceptance || []).length;
    const sop = na ? '<span class="mkt-chip" title="host-checked acceptance">◇ ' + na + ' check' + (na === 1 ? '' : 's') + '</span>' : '';
    const dr = recipeDrift && recipeDrift[r.id];
    const drift = (dr && dr.status === 'drift') ? '<span class="mkt-chip bad" title="the latest run differs from its good history">⚠ DRIFT</span>' : '';
    // no `--accent` — same one-phosphor rule as the class rows above (see the note on mkt-card there).
    // The recipe library was the worse offender: not ONE of its seals was the station's colour.
    return '<button class="mkt-card' + (sel ? ' sel' : '') + '" type="button" data-id="' + esc(r.id) + '" style="--ci:' + (i || 0) + '">' +
      sealHTML(r, false) +
      '<div class="mkt-card-id">' +
        '<div class="mkt-name">' + esc(r.name) + (r.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
        '<div class="mkt-tag">' + esc(r.tagline) + '</div>' +
      '</div>' +
      '<div class="mkt-card-side">' +
        '<div class="mkt-meta"><span class="mkt-chip lane">' + esc(CAT_LABEL[railBucket(r)] || 'GENERAL') + '</span>' +
          '<span class="mkt-chip">' + setup + '</span>' + sop + drift + recipeLifeChip(r) + '</div>' +
        '<span class="mkt-card-code">' + setup + '</span>' +
      '</div>' +
    '</button>';
  }

  /* ---------- the dossier (right pane: focused class detail + the action) ---------- */
  function focusedItem() {
    if (tab === 'recipes' && hasRecipes()) return (focusRecipe && Recipes.get(focusRecipe)) || Recipes.builtins()[0];
    return (focusAgent && Specialties.get(focusAgent)) || Specialties.builtins()[0];
  }
  /* The dossier used to re-theme to the focused class's raw accent, so clicking down the roster
     strobed the whole right-hand panel — coin, focus bars, and the SUMMON call-to-action — through
     blue / green / pink. One phosphor (see the note on mkt-card): the dossier stays the station's
     colour and the class is named by its emblem, code stamp, and lane chip. Kept as a no-op rather
     than deleted so the render path's call site, and the reason, stay visible. */
  function paintDossierAccent() {
    const d = root && root.querySelector('#mkt-dossier');
    if (d) d.style.removeProperty('--accent');
  }
  // the DECODE beat: focusing a NEW class resolves its hero (emblem + name) out of glyph static — the
  // station's own AsciiFX register (eerie signal-lock, never confetti). Once per focused id, instant
  // under reduced-motion (the kit handles it), and null-safe when the kit isn't loaded.
  let lastDecodedHero = null;
  function decodeHero() {
    if (typeof AsciiFX === 'undefined' || !AsciiFX.scramble) return;
    const hero = root && root.querySelector('.mkt-dos-hero'); if (!hero) return;
    const it = focusedItem(); const id = (it && it.id) || null;
    if (!id || id === lastDecodedHero) return;
    lastDecodedHero = id;
    try { AsciiFX.scramble(hero, { duration: 460 }); } catch (_) {}
  }
  // narrow-viewport escape hatch: at <=820px the dossier is a full-width sheet OVER the roster, so it needs a
  // visible way back (the stranded-state fix). Hidden at wide widths by CSS (both panes show side by side).
  function dossierBackHTML() {
    return '<button type="button" class="mkt-dos-back" aria-label="back to the library">‹ LIBRARY</button>';
  }
  function dossierHTML() {
    return dossierBackHTML() + ((tab === 'recipes' && hasRecipes()) ? recipeDossierHTML() : agentDossierHTML());
  }
  // the capability objectTypes the STATION currently has placed anywhere (station-wide shared gear). Under the
  // shared-gear model a specialist owns only its desk and draws on these caps UNDER THE OVERSEER — so a class's
  // gear is checked against the whole station, never a per-agent room. Reads World.stationCaps (the same live
  // source the run's skill availability uses); [] on any hiccup (renders every row as "not on station", honest).
  function stationGearSet() {
    try {
      const caps = (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [];
      return new Set(caps.map(c => (typeof c === 'string' ? c : c && c.objectType)).filter(Boolean));
    } catch (_) { return new Set(); }
  }
  /* The class dossier's DRAWS ON STATION GEAR + SKILL PACKAGE inventories were removed 2026-08-15 (Andrew).
     Nothing about the LOADOUT changed — `s.kit` and `s.skills` still ride applyLoadout at summon exactly as
     before; the bay simply stopped printing the manifest. The live-source resolvers those blocks introduced are
     still in use and still owned here: kitPropLabel/capGrant/stationGearSet by the RECIPE dossier's gear block
     (recipeGearHTML), and loadSkillCatalog/hydrateSkillRows by its skills chips. */
  // async: fill real skill names/descriptions into a rendered dossier once the catalog loads. Re-queries the DOM
  // after the await so a dossier swapped mid-fetch is a safe no-op.
  function hydrateSkillRows() {
    loadSkillCatalog().then(map => {
      const d = root && root.querySelector('#mkt-dossier'); if (!d) return;
      d.querySelectorAll('.mkt-skill-row[data-slug]').forEach(row => {
        const meta = map[row.dataset.slug]; if (!meta) return;
        const n = row.querySelector('.mkt-skill-name'); if (n) n.textContent = meta.name;
        const de = row.querySelector('.mkt-skill-desc'); if (de) de.textContent = meta.description;
      });
    });
  }

  /* ---------- R3: live cron routines (the "● live as a routine" provenance) ---------- */
  // cron-job cache: fetched from /api/cron once per open of the recipes tab, then reused. Best-effort — a missing
  // sidecar just means no live-routine badges (the recipe still launches). The window.fetch shim attaches the token.
  let cronPending = null;
  function loadCronJobs(force) {
    if (cronJobs && !force) return Promise.resolve(cronJobs);
    if (cronPending) return cronPending;
    cronPending = fetch('/api/cron').then(r => r.ok ? r.json() : { jobs: [], enabled: false })
      .then(d => { cronJobs = Array.isArray(d && d.jobs) ? d.jobs : []; cronArmed = !!(d && d.enabled); cronPending = null; return cronJobs; })
      .catch(() => { cronJobs = cronJobs || []; cronPending = null; return cronJobs; });
    return cronPending;
  }
  // async: fetch cron jobs, then repaint the focused recipe's dossier so its live-routine badge appears. Re-queries
  // the DOM after the await (a dossier swapped mid-fetch is a safe no-op). Only repaints if the badge would change.
  function hydrateLiveRoutines() {
    const had = cronJobs != null;
    loadCronJobs().then(() => {
      if (!root || tab !== 'recipes') return;
      const d = root.querySelector('#mkt-dossier'); if (!d) return;
      // if this is the first load (badge wasn't rendered), or the badge state differs from what's shown, repaint.
      if (!had) renderDossier();
    });
  }

  /* ---------- WHAT THIS RECIPE ACTUALLY DID (the dossier's history line) ----------
     "↻ ran 3×" is a counter; it never says whether any of those runs produced anything. The durable run log does:
     every recipe launch stamps meta.recipeId down the provenance spine into the run row, and that row carries the
     run's end reason and its ARTIFACT ledger (what the run actually wrote). Reading it back turns the dossier from
     a menu entry into somewhere you return to — "last run 2h ago · done · produced brief.md".
     Read-only, best-effort, and strictly what the log says: no run rows = no line at all (never an invented one).
     agent=* because a recipe may have been launched by any crew member, or fired unattended as a routine. */
  let recipeRuns = null, recipeRunsPending = null;
  // GOLDEN-RUN DRIFT: recipeId -> the sidecar's drift verdict for its latest run (read with the run log; null = not read)
  let recipeDrift = null;
  function loadRecipeRuns(force) {
    if (recipeRuns && !force) return Promise.resolve(recipeRuns);
    if (recipeRunsPending) return recipeRunsPending;
    // the drift read rides alongside (advisory; a failed read asserts nothing)
    fetch('/api/recipes/drift', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d => { recipeDrift = (d && d.drift) || {}; }).catch(() => { recipeDrift = recipeDrift || {}; });
    recipeRunsPending = fetch('/api/runs?agent=*&limit=200', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { runs: [] })
      .then(d => {
        const map = {};
        // rows come newest-first; keep the FIRST row seen per recipe (its most recent run).
        (Array.isArray(d && d.runs) ? d.runs : []).forEach(row => {
          const id = row && row.recipeId;
          if (!id || map[id]) return;
          map[id] = { ts: Number(row.ts) || 0, reason: String(row.reason || ''), artifacts: Array.isArray(row.artifacts) ? row.artifacts : [] };
        });
        recipeRuns = map; recipeRunsPending = null; return recipeRuns;
      })
      .catch(() => { recipeRuns = recipeRuns || {}; recipeRunsPending = null; return recipeRuns; });
    return recipeRunsPending;
  }
  function hydrateRecipeRuns() {
    const had = recipeRuns != null;
    loadRecipeRuns().then(() => {
      if (!root || tab !== 'recipes') return;
      if (!root.querySelector('#mkt-dossier')) return;
      if (!had) renderDossier();
    });
  }
  // the file/target name of the first artifact a run recorded — a display label, never a link we can't honor.
  function artifactLabel(list) {
    for (const a of (list || [])) {
      const s = String((a && (a.path || a.target)) || '').trim();
      if (s) return s.split(/[\\/]/).pop() || s;
    }
    return '';
  }
  const RUN_REASON_WORD = { done: 'done', max_iters: 'hit its turn limit', budget: 'hit its budget', cancelled: 'cancelled', error: 'errored', refusal: 'refused' };
  // GOLDEN-RUN DRIFT line: the last 5 outcomes as marks, and the named signal when the latest run drifted from the
  // recipe's own good history. Says 'insufficient' nothing — a recipe with no baseline shows only its streak.
  function driftHTML(r) {
    const d = recipeDrift && recipeDrift[r.id]; if (!d || !d.streak || !d.streak.length) return '';
    const marks = d.streak.map(m => '<span class="mkt-drift-mark' + (m === 'pass' ? ' ok' : ' bad') + '" aria-label="' + m + '">' + (m === 'pass' ? '✓' : '✗') + '</span>').join('');
    let line = '<div class="mkt-r-drift' + (d.status === 'drift' ? ' bad' : '') + '"><span class="mkt-r-lastrun-k" aria-hidden="true">◫</span> last ' + d.streak.length + ' run' + (d.streak.length === 1 ? '' : 's') + ' ' + marks;
    if (d.status === 'drift') line += ' · <b>DRIFT</b> — ' + d.signals.slice(0, 2).map(s => esc(s.detail)).join('; ') + (d.signals.length > 2 ? ' <span class="dim">+' + (d.signals.length - 2) + '</span>' : '');
    else if (d.status === 'steady') line += ' · steady vs ' + d.baselineRuns + ' prior';
    return line + '</div>';
  }
  function lastRunHTML(r) {
    if (!recipeRuns) return '';                       // no read yet — assert nothing
    const row = recipeRuns[r.id]; if (!row) return '';
    const when = scoutRelTime(row.ts);
    const why = RUN_REASON_WORD[row.reason] || row.reason || '';
    const art = artifactLabel(row.artifacts);
    const cls = (row.reason === 'error' || row.reason === 'refusal') ? ' bad' : '';
    return '<div class="mkt-r-lastrun' + cls + '"><span class="mkt-r-lastrun-k" aria-hidden="true">◱</span> last run' +
      (when ? ' ' + esc(when) : '') + (why ? ' · ' + esc(why) : '') +
      (art ? ' · produced <b>' + esc(art) + '</b>' + (row.artifacts.length > 1 ? ' <span class="dim">+' + (row.artifacts.length - 1) + '</span>' : '')
           : ' <span class="dim">· no files recorded</span>') + '</div>';
  }

  /* ---------- the class dossier (right pane) ----------
     Reads top-to-bottom as one decision: WHO IT IS → WHAT IT DOES FOR YOU → WHAT IT USES → WHAT YOU SET → GO.
     Rewritten 2026-08-15 (Andrew: "should be a simple description of the purpose of the agent, and the user should
     configure the agent on the right side entirely"). What was cut and why:
       • FOCUS LANES — three percentage bars off s.tags. The tags are a RECOMMENDER weighting, not a capability
         budget: an agent at "70% research / 30% ops" is not throttled to those ratios by anything, so the bars
         implied a mechanic the harness cannot back. The lane the class actually leads with is one chip.
       • the CLEARANCE / EFFORT / VOICE / FOCUS spec grid — four rows of label-value whose values were mostly
         "station default", stated where nothing could act on them. Clearance + effort moved onto the MODEL
         control's helper (modelHelpHTML); lane + voice are chips under the hero.
       • the commit summary — it restated NAME / SKIN / MODEL / CLASS because the controls were a pane away.
         With CONFIGURE sitting directly above the button, it was echoing the three fields you just filled in.
     What was ADDED: the description. s.blurb — a written-for-humans paragraph that already shipped on every
     class — was being used only for SEARCH, never displayed here, so the dossier's whole account of a class was
     a 4-word tagline plus a system prompt that opened "You are the station's…". */
  function agentDossierHTML() {
    const s = (focusAgent && Specialties.get(focusAgent)) || Specialties.builtins()[0];
    if (!s) return '<div class="mkt-dos-empty">no class selected.</div>';
    const deploy = !ctx || ctx.mode !== 'pick';
    const here = !!(ctx && ctx.currentSpecialtyId && ctx.currentSpecialtyId === s.id);
    const badges = (here ? ' <span class="mkt-badge mkt-here">DEPLOYED</span>' : '') + (s.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '');
    const ctaLabel = deploy ? ('⏼ DEPLOY TO ' + esc(((ctx && ctx.agentName) || 'AGENT')).toUpperCase())
      : ('⏼ SUMMON <span class="mkt-candidate-name">' + esc(summonCandidateName(s)) + '</span>');
    const ctaSub = deploy
      ? 're-specs ' + esc((ctx && ctx.agentName) || 'your agent') + '’s purpose &amp; standing orders'
      : 'joins your crew with its own <span data-hint="workstream">chat thread</span>, pre-filled from this class';
    const custActs = s.custom
      ? '<div class="mkt-cta-row"><button class="bb sm mkt-edit" data-id="' + esc(s.id) + '">✎ EDIT</button>' +
        '<button class="bb sm danger mkt-del" data-id="' + esc(s.id) + '">⌫ DELETE</button></div>' : '';
    // the description: the human blurb leads (what it does FOR you), the purpose follows (how it works, the brief
    // it actually carries into every thread). A custom class may have no blurb — then the purpose leads alone.
    const lead = String(s.blurb || '').trim();
    const brief = String(s.purpose || '').trim();
    const aboutBlock = (lead || brief)
      ? '<div class="mkt-block mkt-about"><div class="bh">WHAT IT DOES</div>' +
          (lead ? '<p class="bp lead">' + esc(lead) + '</p>' : '') +
          (!lead && brief ? '<p class="bp lead">' + esc(brief) + '</p>' : '') +
        '</div>'
      : '';
    return '<div class="mkt-dos-scroll mkt-agent-simple">' +
      '<div class="mkt-dos-hero"><div class="mkt-dos-hi"><div class="mkt-dos-name">' + esc(s.name) + badges + '</div></div></div>' +
      aboutBlock + summonConfigPanelHTML(s) +
      (!(ctx && ctx.mode === 'pick' && ctx.summon) ? agentReferenceHTML(s) : '') +
      // the merged recruit door's SECOND verb: in summon mode, a deploy context (onDeploy + agentName) also offers
      // re-speccing the CURRENT agent as this class — the old ROSTER door's action, now living on the card instead
      // of a separate dock button. It rides in NORMAL FLOW, outside the sticky block: pinning it too made the
      // permanent footer four elements tall (~190px of a ~660px pane), which is what pushed CONFIGURE off screen.
      (!deploy && ctx && ctx.onDeploy && ctx.agentName && !here
        ? '<div class="mkt-cta-second"><button class="mkt-cta-alt mkt-deploy-cur" data-id="' + esc(s.id) + '">⏼ DEPLOY TO ' + esc(ctx.agentName).toUpperCase() + ' ▸</button>' +
          '<div class="mkt-cta-sub">re-specs ' + esc(ctx.agentName) + ' instead — no new crew member</div></div>'
        : '') +
      '</div><div class="mkt-dos-cta">' + custActs +
        // adopt-voice sits BESIDE the DEPLOY CTA it modifies (audit item 8), not orphaned up in the toolbar.
        (deploy ? '<label class="mkt-adopt mkt-adopt-cta"><input type="checkbox" class="mkt-adopt-cb"> adopt its voice too</label>' : '') +
        '<button class="mkt-cta-main mkt-deploy" data-id="' + esc(s.id) + '">' + ctaLabel + ' ▸</button>' +
        '<div class="mkt-cta-sub">' + ctaSub + '</div>' +
      '</div>';
  }
  // GEAR the recipe draws on — one advisory row per objectType: prop label + what it grants + a present/WANT
  // check against the live station gear (skills-panel WANT pattern). Missing gear is a WANT badge, NEVER a lock.
  function recipeGearHTML(r) {
    const gear = (r && Array.isArray(r.gear)) ? r.gear : [];
    if (!gear.length) return '';
    const have = stationGearSet();
    const rows = gear.map(t => {
      const present = have.has(t);
      return '<div class="mkt-kit-row' + (present ? '' : ' mkt-kit-missing') + '">' +
        '<span class="mkt-kit-dot" aria-hidden="true">' + (present ? '●' : '○') + '</span>' +
        '<span class="mkt-kit-obj">' + esc(kitPropLabel(t)) + '</span>' +
        '<span class="mkt-kit-grant">' + esc(capGrant(t)) + '</span></div>';
    }).join('');
    return '<div class="mkt-block"><div class="bh">ABILITIES THIS TASK MAY USE</div><div class="mkt-kit">' + rows + '</div>' +
      '<div class="mkt-kit-note">Needed only when the task uses these abilities. Your current access may already provide them; matching props are alternatives.</div></div>';
  }
  // SKILLS PAIRING (R6) — the bundled-skill references this use case pairs with, as chips. Renders slug-only
  // immediately (works offline), then hydrateSkillRows fills real names once the /api/skills catalog resolves.
  // Empty skills => the block is omitted. Advisory only — a recipe never enables a skill on its own.
  function recipeSkillsHTML(r) {
    const skills = (r && Array.isArray(r.skills)) ? r.skills : [];
    if (!skills.length) return '';
    const cached = skillCatalog || {};
    const chips = skills.map(slug => {
      const meta = cached[slug];
      return '<span class="mkt-skill-row" data-slug="' + esc(slug) + '"><span class="mkt-skill-name">' +
        esc(meta ? meta.name : slug) + '</span></span>';
    }).join('');
    return '<div class="mkt-block"><div class="bh">PAIRS WITH SKILLS</div><div class="mkt-skills mkt-pair">' + chips + '</div>' +
      '<div class="mkt-kit-note">skills that fit this use case — enable them in SKILLS to sharpen the run.</div></div>';
  }
  // R3 live-routine lookup: the ENABLED cron jobs whose meta.recipeId matches this recipe (from the last
  // /api/cron fetch). Returns { count, cadence } so the dossier can show "● live — every morning" (or "×N").
  function liveRoutinesFor(recipeId) {
    if (!Array.isArray(cronJobs) || !recipeId) return null;
    const mine = cronJobs.filter(j => j && j.enabled && j.meta && j.meta.recipeId === recipeId);
    if (!mine.length) return null;
    return { count: mine.length, display: mine[0].scheduleDisplay || '' };
  }
  function liveRoutineBadgeHTML(r) {
    const live = liveRoutinesFor(r.id);
    if (!live) return '';
    const sched = live.display ? esc(live.display) : 'on a schedule';
    const extra = live.count > 1 ? ' <span class="dim">×' + live.count + '</span>' : '';
    return '<div class="mkt-r-live"><span class="mkt-r-live-dot" aria-hidden="true">●</span> live as a routine — ' + sched + extra + '</div>';
  }
  function recipeDossierHTML() {
    const r = focusRecipe && Recipes.get(focusRecipe);
    if (!r) return '<div class="mkt-dos-empty">No matching recipe. Try another category or search.</div>';
    const who = (ctx && ctx.agentName) || 'your agent';
    const steps = (r.steps && r.steps.length) ? '<div class="mkt-block"><div class="bh">HOW IT WORKS</div><ol class="mkt-starters mkt-sop-steps">' +
      r.steps.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol></div>' : '';
    const accept = (r.acceptance && r.acceptance.length) ? '<div class="mkt-block"><div class="bh">RESULT CHECKS</div><ul class="mkt-starters mkt-sop-accept">' +
      r.acceptance.map(a => '<li>◇ ' + esc(Recipes.acceptanceLabel(a)) + '</li>').join('') + '</ul></div>' : '';
    // fork provenance: a forked custom names its parent (a live jump would be nice but the parent may be gone).
    const parent = (r.source === 'fork' && r.forkedFrom) ? Recipes.get(r.forkedFrom) : null;
    const forkLine = (r.source === 'fork')
      ? '<div class="mkt-r-fork">⑃ tweaked from <b>' + esc(parent ? parent.name : r.forkedFrom) + '</b></div>' : '';
    const cadHint = r.cadence
      ? '<div class="mkt-r-cadhint">◷ naturally recurring — suggests <b>' + esc(cadenceLabel(r.cadence)) + '</b></div>' : '';
    // TWEAK + EXPORT are on EVERY dossier (fork/export any recipe); EDIT/DELETE only on your own customs.
    const tweakBtn = '<button class="bb sm mkt-recipe-tweak" data-id="' + esc(r.id) + '">CUSTOMIZE A COPY</button>';
    const exportBtn = '<button class="bb sm mkt-recipe-export" data-id="' + esc(r.id) + '" title="download this recipe as a portable JSON file">DOWNLOAD RECIPE</button>';
    const custActs = r.custom
      ? '<div class="mkt-cta-row">' + tweakBtn +
        '<button class="bb sm mkt-recipe-edit" data-id="' + esc(r.id) + '">✐ EDIT</button>' + exportBtn +
        '<button class="bb sm danger mkt-recipe-del" data-id="' + esc(r.id) + '">⌫ DELETE</button></div>'
      : '<div class="mkt-cta-row">' + tweakBtn + exportBtn + '</div>';
    const intakeRows = (r.intake || []).map(e =>
      '<div class="mkt-intake" data-dim="' + esc(e.dimension) + '"><div class="mkt-lbl">' + esc(e.question) +
        (e.reason ? ' <span class="mkt-lbl-hint">— ' + esc(e.reason) + '</span>' : '') + '</div>' +
        '<div class="mkt-intake-opts">' +
          e.options.map(o => '<button type="button" class="mkt-intake-opt' + (o === e.recommended ? ' sel rec' : '') + '" data-val="' + esc(o) + '">' + (o === e.recommended ? '★ ' : '') + esc(o) + '</button>').join('') +
          '<button type="button" class="mkt-intake-opt mkt-intake-skip" data-val="">agent decides</button>' +
        '</div></div>'
    ).join('');
    const field = p => '<label class="mkt-lbl mkt-p-lbl"><span class="mkt-p-lbl-t">' + esc(p.label) +
      (p.required ? '' : ' <span class="mkt-opt">(optional)</span>') + '</span>' + paramControlHTML(p, p.default || '') + '</label>';
    const requiredFields = (r.params || []).filter(p => p.required).map(field).join('');
    const optionalFields = (r.params || []).filter(p => !p.required).map(field).join('');
    const tabs = ['Options', 'Workflow', 'Reuse'].map((label, i) =>
      '<button type="button" role="tab" id="recipe-detail-tab-' + i + '" aria-controls="recipe-detail-panel-' + i +
      '" aria-selected="' + (i === 0) + '" tabindex="' + (i === 0 ? '0' : '-1') + '" data-recipe-panel="' + i + '">' + label + '</button>').join('');
    const panel = (i, html) => '<div class="mkt-recipe-detail-panel" role="tabpanel" id="recipe-detail-panel-' + i +
      '" aria-labelledby="recipe-detail-tab-' + i + '"' + (i ? ' hidden' : '') + '>' + html + '</div>';
    const options = optionalFields || intakeRows
      ? '<p class="mkt-detail-note">Adjust what matters. You can leave the rest as it is.</p>' + optionalFields + intakeRows
      : '<p class="mkt-detail-note">No extra options for this recipe. It is ready with the details above.</p>';
    const workflow = steps + accept +
      '<details class="mkt-recipe-instructions"><summary>View full instructions</summary><pre id="mkt-l-preview"></pre></details>';
    const reuse = '<p class="mkt-detail-note">Make a version of your own, or run this recipe on a schedule.</p>' +
      '<div class="mkt-reuse-actions">' + custActs +
      '<button class="bb sm mkt-launch-options" data-id="' + esc(r.id) + '">SET UP A SCHEDULE</button></div>' +
      liveRoutineBadgeHTML(r) + forkLine;
    return '<div class="mkt-dos-scroll mkt-recipe-simple"><div class="mkt-dos-hero">' +
      '<div class="mkt-dos-hi"><div class="mkt-dos-name">' + esc(r.name) + '</div>' +
      '<div class="mkt-dos-tag">' + esc(r.tagline) + '</div></div></div>' +
      '<div class="mkt-inline-launch">' + requiredFields +
      '<details class="mkt-brief mkt-recipe-details"><summary>Options &amp; recipe details</summary>' +
      '<div class="mkt-recipe-detail-tabs" role="tablist" aria-label="Recipe details">' + tabs + '</div>' +
      panel(0, options) + panel(1, workflow) + panel(2, reuse) + '</details>' +
      '<button class="mkt-cta-main mkt-do-launch">▸ START SESSION</button>' +
      '<div class="mkt-cta-sub">Opens a new session with ' + esc(who) + '.</div></div></div>';

  }

  /* ---------- glass box: "STATION FAMILIARITY" ---------- */
  function glassHTML() {
    if (ctx && ctx.mode === 'pick') return '';
    const ps = profileApi(); if (!ps) return '';
    const summ = ps.summary(); if (!summ) return '';
    const on = ps.enabled ? ps.enabled() : true;
    const pct = Math.round((summ.familiarity || 0) * 100);
    const meter = !on ? 'PAUSED' : (summ.calibrating ? 'CALIBRATING' : pct + '%');
    const dom = summ.dominant ? (TAG_LABEL[summ.dominant] || summ.dominant) : '—';
    const noteTxt = !on ? 'learning paused — nothing new is being folded in'
      : summ.dominant ? ('leaning ' + dom.toLowerCase() + ' · ' + summ.samples + ' signal' + (summ.samples === 1 ? '' : 's') + ' so far')
      : 'still getting to know you — set an agent to work and I’ll learn what you focus on';
    const head =
      '<button class="mkt-fam-head" aria-expanded="' + (glassOpen ? 'true' : 'false') + '">' +
        '<span class="mkt-fam-ico" aria-hidden="true">◉</span>' +
        '<span class="mkt-fam-ttl">STATION FAMILIARITY</span>' +
        '<span class="mkt-fam-meter ' + (on && !summ.calibrating ? 'known' : 'cal') + '">' + meter + '</span>' +
        '<span class="mkt-fam-note">' + esc(noteTxt) + '</span>' +
        '<span class="mkt-fam-caret" aria-hidden="true">' + (glassOpen ? '▾' : '▸') + '</span>' +
      '</button>';
    if (!glassOpen) return '<div class="mkt-fam' + (on ? '' : ' paused') + '">' + head + '</div>';
    const bars = FAM_TAGS.map(k => {
      const v = Math.round((summ.affinity[k] || 0) * 100);
      return '<div class="mkt-fam-bar"><span class="mkt-fam-k">' + TAG_LABEL[k] + '</span>' +
        '<span class="mkt-fam-trk"><span class="mkt-fam-fill" style="width:' + v + '%;"></span></span>' +
        '<span class="mkt-fam-v">' + v + '%</span></div>';
    }).join('');
    const consent = !acked()
      ? '<div class="mkt-fam-consent">STARNET learns what you work on to tailor these picks. The profile is stored locally; bounded summaries are sent to your configured model only when it drafts a recommendation. ' +
        'Pause or wipe it anytime, right here. <button class="bb sm mkt-fam-ack">GOT IT</button></div>' : '';
    const acts = '<div class="mkt-fam-acts">' +
        '<span class="mkt-fam-priv">◇ local-first · pause stops browser and sidecar personalization</span>' +
        '<button class="bb sm mkt-fam-pause">' + (on ? '❚❚ PAUSE LEARNING' : '▸ RESUME LEARNING') + '</button>' +
        '<button class="bb sm danger mkt-fam-forget">⌫ FORGET</button></div>';
    return '<div class="mkt-fam open' + (on ? '' : ' paused') + '">' + head +
      '<div class="mkt-fam-body">' + consent + '<div class="mkt-fam-bars">' + bars + '</div>' + acts + '</div></div>';
  }

  /* ---------- recommender shelves ---------- */
  /* ONE grammar for every recommendation the station makes — the shelves speak the exact line the COMMS offer
     cards do (recommend.js whyLine). Fail-open: the raw reason if the pure spine isn't loaded. */
  function whyGrammar(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) return '';
    return (typeof Recommend !== 'undefined' && Recommend.whyLine) ? (Recommend.whyLine({ why: t }) || t) : t;
  }
  /* ONE HEADER GRAMMAR TOO (2026-08-05). The bay's five recommender shelves had grown five headers under FOUR
     different glyphs — ★ RECOMMENDED, ◆ CURATED, ◆ UNCOVERED, ✦ DRAFTED, ◈ FOR YOU — and not one of them named
     the agent doing the noticing, while the COMMS offer card next door leads with '◈ <NAME> NOTICED'. Same
     station, same act of noticing, five costumes. These are the SAME family now: one glyph, and the noticer is
     named wherever the shelf genuinely noticed something.

     ⛔ THE NOTICER CLAIM IS NOT DECORATION. A cold-start shelf noticed NOTHING — it is a lineup drawn in catalog
     order — so it keeps the glyph and does NOT get the eyebrow. Stamping "NOTICED" on a spread would be the
     header telling the same lie item 6 fixes one function below. `noticedHead` is for earned rows only. */
  /* ⛔ THE NAME IS USER TEXT, AND THIS RETURN VALUE GOES STRAIGHT INTO innerHTML (2026-08-05). `ctx.agentName`
     is whatever the Commander typed when they named the agent (app.js does not HTML-escape it on the way in),
     and `.toUpperCase()` neuters nothing — `<img onerror=…>` uppercases to a tag that still parses. Five shelf
     headers in this file compose through here; every sibling render around them already escapes. So does this
     one now. The tails are literals today, but they ride esc() too so a future caller cannot re-open the hole. */
  function noticedHead(tail) {
    const n = String((ctx && ctx.agentName) || '').trim();
    // mirrors chat.js recCard: the name when the station has one, a bare NOTICED when it does not.
    return '◈ ' + (n ? esc(n.toUpperCase()) + ' NOTICED' : 'NOTICED') + (tail ? ' — ' + esc(tail) : '');
  }
  const coldHead = (tail) => '◈ ' + esc(tail);   // same glyph, no noticer claim
  function becauseText(s) {
    const ps = profileApi(); if (!ps || !ps.explain) return '';
    const t = ps.explain(s.tags || {});
    return t ? (BECAUSE[t] || '') : '';
  }
  function recommendationsReady() {
    try {
      const r = (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.readiness) ? UnderstandingStore.readiness() : null;
      return !!(r && r.ready);
    } catch (_) { return false; }
  }
  /* ---------- specialist recommendations (deploy AND summon/pick) ----------
     Mirrors Recipes.rankRecipes: (profile affinity × 4) + (goal-keyword hits × 2), catalog-order tie-break.
     When BOTH signals are silent (cold start) we fall back to an HONEST lane spread — the first class of each
     distinct interest lane in catalog order — under a header that says so (never a fake "recommended"). This
     shelf now renders in the summon/pick flow too: recruiting a NEW agent is exactly when guidance matters. */
  /* ONE GOAL MATCHER FOR THE WHOLE STATION (2026-08-05). This file used to carry its own: a plain substring
     scan over a haystack that INCLUDED `Object.keys(s.tags)`. Two artifacts followed, and both were visible on
     the card. (a) the tag lanes are internal vocabulary — 'code'/'research'/'general' — so a goal containing the
     word "general" scored a point against every general-lane class in the catalog and the WHY chip then quoted
     it back as «it matches your goal: “general”». (b) a bare `indexOf` matched a FRAGMENT buried inside a longer
     word ("for" inside "performance"). recipes.js:goalKeywordHits already fixed exactly this — word-wise tokens,
     a stoplist, an explicit suffix set, and a READABLE-TEXT haystack (name + tagline + blurb, never tag keys) —
     and its merge note recorded the unification as intended. So this delegates rather than duplicating: the bay
     and the FOR YOU row can never again disagree about what "matches your goal" means.
     Resolved LAZILY (never captured at load): recipes.js loads AFTER marketplace.js's dependencies are wired. */
  function goalMatcher() {
    return (typeof Recipes !== 'undefined' && Recipes && Recipes.goalKeywordHits) ? Recipes.goalKeywordHits : null;
  }
  // the ACTUAL goal keywords a class matched (the persisted GOALS belief text ∩ the class's READABLE text). The
  // WHY chip names hits[0] so it says WHY truthfully ("matches your goal: X") instead of ×3 boilerplate.
  function specGoalHits(s, gt) {
    if (!s || !gt) return [];
    const hits = goalMatcher();
    // no matcher loaded → NO goal term at all. Never a local fallback: a second matcher is how the two surfaces
    // drifted in the first place, and a silent term is honest where a divergent one is not.
    if (!hits) return [];
    return hits({ name: s.name || '', tagline: s.tagline || '', blurb: s.blurb || '' }, gt);
  }
  function specGoalScore(s, gt) { return specGoalHits(s, gt).length; }
  function dominantLane(s) {
    let best = 'general', bv = -Infinity; const t = s.tags || {};
    for (const k in t) { const v = Number(t[k]); if (isFinite(v) && v > bv) { bv = v; best = k; } }
    return best;
  }
  // the searchable corpus of a class, for the learned-topic match (same shape the archetype matcher reads).
  function specCorpus(s) {
    return ((s && s.name) || '') + ' ' + ((s && s.tagline) || '') + ' ' + ((s && s.blurb) || '') + ' ' +
      ((s && s.purpose) || '') + ' ' + Object.keys((s && s.tags) || {}).join(' ');
  }
  // the class's LEARNED-TOPIC match, or null. Same engine, thresholds and cap as the FOR YOU row (TopicMatch),
  // so "the station knows you keep doing X" means one identical thing across every shelf in the bay.
  const SPEC_TOPIC_SCALE = 1.5, SPEC_TOPIC_CAP = 3;
  function specTopicMatch(s, topics) {
    if (typeof TopicMatch === 'undefined' || !TopicMatch || !TopicMatch.match || !s) return null;
    try { return TopicMatch.match(topics, specCorpus(s)); } catch (_) { return null; }
  }
  function rankSpecs(items, excludeId) {
    const ps = profileApi();
    const ready = recommendationsReady();
    const learningOn = ready && !!(ps && (!ps.enabled || ps.enabled()));
    const scoreFn = (learningOn && ps && ps.score) ? (t => ps.score(t)) : null;
    const gt = ready ? goalText() : '';
    const topics = learningOn ? learnedTopics() : [];   // same glass-box gate as the affinity scorer (see forYouShelfHTML)
    // the shared declined read gates the INPUT here too — a declined class never enters the rank, and both the
    // personalized top-3 and the cold-start lane spread fill from the classes that remain.
    const pool = (items || []).filter(s => s && s.id !== excludeId && !shelfDeclined(s.name));
    let anySignal = false;
    const scored = pool.map((s, idx) => {
      const aff = scoreFn ? (Number(scoreFn(s.tags || {})) || 0) : 0;
      const goalHits = specGoalHits(s, gt);
      const goal = goalHits.length;
      // the LEARNED-TOPIC term: strictly additive and capped, and exactly 0 until a WARM topic covers the class —
      // so a cold station ranks byte-identically to before, and this can only ever PROMOTE a class the Commander's
      // real observed work points at. It can never shrink the shelf.
      const tm = specTopicMatch(s, topics);
      const topic = tm ? TopicMatch.term(tm, SPEC_TOPIC_SCALE, SPEC_TOPIC_CAP) : 0;
      if (aff > 0 || goal > 0 || topic > 0) anySignal = true;
      // the honest per-pick WHY, most-specific evidence first: a learned topic NAMES the actual subject and its
      // observation count, so it outranks both priors; then profile affinity (the stronger of the two remaining);
      // then a goal match, which NAMES the matched keyword rather than ×3 boilerplate.
      const why = whyGrammar((topic > 0 ? TopicMatch.reason(tm) : '') ||
        (aff > 0 ? becauseText(s) : '') || (goal > 0 ? ('it matches your goal: “' + goalHits[0] + '”') : ''));
      return { s, idx, v: aff * 4 + goal * 2 + topic, why };
    });
    if (anySignal) {
      return { personalized: true, items: scored.filter(x => x.v > 0).sort((a, b) => (b.v - a.v) || (a.idx - b.idx)).slice(0, 3) };
    }
    // honest cold-start fallback: one class per distinct interest lane (dominant tag), catalog order.
    const byLane = [], used = {}, rest = [];
    pool.forEach(s => { const l = dominantLane(s); if (!used[l]) { used[l] = true; byLane.push(s); } else rest.push(s); });
    return { personalized: false, items: byLane.concat(rest).slice(0, 3).map(s => {
      const lbl = TAG_LABEL[dominantLane(s)] || 'GENERAL OPS';
      return { s, why: whyGrammar('it covers the ' + lbl.toLowerCase() + ' lane') };
    }) };
  }
  /* ── THE SHARED DECLINED MEMORY, ON THE SHELVES (one-memory lane, 2026-08-05) ──────────────────────────
     Every personalized shelf here consults the ONE cross-surface declined read (RecLedger — the browser wire
     into sidecar/recommendation-ledger.js) before it ranks: a class or recipe the Commander explicitly waved
     off — here, at a COMMS card, anywhere — is not shown to them as a recommendation again. Exact normalized
     name match only, the declinedindex.js bar; fail-open, so an unreachable ledger suppresses nothing.
     LIBRARY vs SHELF, stated: the declined read gates only the RECOMMENDATION rows. The class stays in the
     catalog and the recipe stays in the library — "stop recommending this" is not "hide this from me". */
  let shelfDeclinedNow = null;   // names declined THIS session — covers the gap until the ledger read returns
  let shelfShownClassIds = null; // classIds the recruit shelves above have already shown THIS paint (dedup)
  function shelfNameKey(name) {
    try { if (typeof RecLedger !== 'undefined' && RecLedger.normKey) return RecLedger.normKey(name); } catch (_) {}
    return String(name == null ? '' : name).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function shelfDeclined(name) {
    const k = shelfNameKey(name);
    if (!k) return false;
    if (shelfDeclinedNow && shelfDeclinedNow.has(k)) return true;
    try { return !!(typeof RecLedger !== 'undefined' && RecLedger.isDeclined && RecLedger.isDeclined(name)); } catch (_) {}
    return false;
  }
  /* the ✕ on a shelf card. A verdict, not a deletion: it lands on the ledger row this card's impression minted
     (ProspectStore.recommendationVerdict finds it by surface+target), teaches the preference model, joins the
     cross-surface declined index the propose-time filters and the spine consult — and repaints, so the card is
     gone the moment it was declined. When personalization is paused no row exists and nothing is recorded
     durably; the session-set still hides the card, which is UX, not learning. */
  function declineShelfItem(surface, id, name) {
    try { if (typeof ProspectStore !== 'undefined' && ProspectStore.recommendationVerdict) ProspectStore.recommendationVerdict(surface, id, 'declined', 'not_relevant'); } catch (_) {}
    if (!shelfDeclinedNow) shelfDeclinedNow = new Set();
    const k = shelfNameKey(name);
    if (k) shelfDeclinedNow.add(k);
    try { if (typeof RecLedger !== 'undefined' && RecLedger.refresh) RecLedger.refresh(true); } catch (_) {}
  }
  // the glyph itself — a span, because these cards are <button>s and a button may not nest one. Same ✕ the
  // prospect/scout dismissals already use; matte, phosphor-dim until hover (never a white control).
  function declineGlyphHTML(surface, id, name) {
    return '<span class="mkt-rec-decline" role="button" tabindex="0" data-decline-surface="' + esc(surface) + '"' +
      ' data-decline-id="' + esc(id) + '" data-decline-name="' + esc(name) + '"' +
      ' aria-label="not interested — stop recommending this" title="not interested — stop recommending this">✕</span>';
  }
  function trackRecommendation(surface, item, why, rank) {
    try {
      if (typeof ProspectStore === 'undefined' || !ProspectStore.noteRecommendation || !item) return;
      const traits = [item.id, item.category].concat(item.kit || [], Object.keys(item.tags || {}).filter(k => Number(item.tags[k]) > 0)).filter(Boolean);
      ProspectStore.noteRecommendation(surface, item, { kind: surface, traits, why: why || '', rank, readiness: { ready: recommendationsReady(), reasons: recommendationsReady() ? ['grounded_profile'] : ['cold_start'] } });
    } catch (_) {}
  }
  function recShelfHTML() {
    if (typeof Specialties === 'undefined' || !Specialties.builtins().length) return '';
    // ADAPTIVE RECRUITMENT: when the station has a WARM read of the Commander's real workflow (the capability
    // histogram past its floor), the shelf becomes a CURATED next-hire pick — the class whose kit covers the work
    // the Commander actually does, with a why derived from a real persisted counter. The curated list already
    // excludes rostered classes and only surfaces classes the work TOUCHES, so it never fabricates a pick. When the
    // signal is cold/thin (or learning is off), fall through to today's honest rankSpecs shelf UNCHANGED.
    shelfShownClassIds = new Set();   // fresh per paint — the gap shelf below dedups against what THIS render shows
    const curated = recruiterShelf();
    if (curated) return curated;
    const res = rankSpecs(Specialties.builtins(), ctx && ctx.currentSpecialtyId);
    if (!res.items.length) return '';
    res.items.forEach(x => shelfShownClassIds.add(x.s.id));
    res.items.forEach((x, i) => trackRecommendation('recruit', x.s, x.why, i + 1));
    const head = res.personalized
      ? noticedHead('based on your recent runs')
      : coldHead('STARTING LINEUP');
    return '<div class="mkt-sect-h mkt-rec-sect">' + head + '</div><div class="mkt-rec-rail' + (res.personalized ? '' : ' mkt-lineup') + '">' +
      res.items.map(x => recCardHTML(x.s, x.why, !res.personalized)).join('') + '</div>';
  }
  // the CURATED-FOR-YOUR-WORKFLOW shelf: returns the shelf HTML when Recruiter has a warm read, else '' (so the
  // caller falls back to the honest lineup). Excludes the currently-focused class (deploy re-spec) like rankSpecs.
  function recruiterShelf() {
    if (typeof RecruiterStore === 'undefined' || !RecruiterStore.recommend) return '';
    let res; try { res = RecruiterStore.recommend(); } catch (_) { return ''; }
    if (!res || !res.warm || !res.items || !res.items.length) return '';
    const excludeId = ctx && ctx.currentSpecialtyId;
    // …through the SAME grammar every other shelf and every COMMS offer card speaks. These two recruiter shelves
    // rendered `it.why` raw, so the one place the bay names a REAL counter ("your recent work leaned on the web")
    // was also the one place it forgot the "because" — two shelves side by side in different voices.
    const cards = res.items
      .map(it => ({ s: Specialties.get(it.classId), why: whyGrammar(it.why) }))
      .filter(x => x.s && x.s.id !== excludeId && !shelfDeclined(x.s.name));   // the shared declined read
    if (!cards.length) return '';
    cards.forEach(x => { if (shelfShownClassIds) shelfShownClassIds.add(x.s.id); });
    cards.forEach((x, i) => trackRecommendation('recruit', x.s, x.why, i + 1));
    return '<div class="mkt-sect-h mkt-rec-sect mkt-curated-sect">' +
      noticedHead('the next hire your real work points to') + '</div>' +
      '<div class="mkt-rec-rail">' + cards.map(x => recCardHTML(x.s, x.why)).join('') + '</div>';
  }
  /* ---------- UNCOVERED: a warm learned topic NOBODY on the crew handles (2026-07-28) ----------
     The curated shelf above can only ever rank classes whose kit the Commander's work ALREADY touches, so it can
     never surface the recommendation that actually grows the station: "you keep asking about X and no one here
     can do it." This shelf answers that from two real persisted counters — the topic's own observation count and
     the crew's actual coverage — and renders ONLY when both say so. Empty (cold topics, or a crew that already
     covers everything warm) → '' , so nothing that renders today can be displaced by it. */
  function interestGapShelfHTML() {
    if (typeof RecruiterStore === 'undefined' || !RecruiterStore.interestGaps) return '';
    let res; try { res = RecruiterStore.interestGaps(); } catch (_) { return ''; }
    if (!res || !res.items || !res.items.length) return '';
    const excludeId = ctx && ctx.currentSpecialtyId;
    const cards = res.items
      .map(it => ({ s: Specialties.get(it.classId), why: whyGrammar(it.why) }))
      /* the shared declined read, PLUS the cross-shelf dedup (one-memory lane): the curated/lineup shelf just
         above can rank the same class this shelf's gap points to, and two adjacent shelves recommending the same
         hire back-to-back reads as the bay repeating itself. The shelf ABOVE keeps the card (its evidence names
         the Commander's own work, the stronger claim); this one shows its next-best uncovered topic instead. */
      .filter(x => x.s && x.s.id !== excludeId && !shelfDeclined(x.s.name)
        && !(shelfShownClassIds && shelfShownClassIds.has(x.s.id)));
    if (!cards.length) return '';
    cards.forEach((x, i) => trackRecommendation('recruit', x.s, x.why, i + 1));
    return '<div class="mkt-sect-h mkt-rec-sect mkt-gap-sect">' +
      noticedHead('work you keep doing that nobody on the crew handles') + '</div>' +
      '<div class="mkt-rec-rail">' + cards.map(x => recCardHTML(x.s, x.why)).join('') + '</div>';
  }
  /* ---------- PROSPECTS: bespoke DRAFTS the station authored from the Commander's real work (Slice 4) ----------
     Distinct from the curated shelf (which ranks EXISTING classes): a prospect is a brand-new spec the catalog
     doesn't contain, DRAFTED by the station and awaiting the Commander's confirm (never auto-saved/summoned).
     Honest labelling: "DRAFTED FOR YOU" + a provenance note. Clicking opens the EXISTING custom-class builder
     pre-filled with the draft (mirrors the R5 recipeMint seed path); dismiss denylists it. */
  function prospectShelfHTML() {
    if (typeof ProspectStore === 'undefined' || !ProspectStore.list) return '';
    let items = []; try { items = ProspectStore.list() || []; } catch (_) { return ''; }
    if (!items.length) return '';
    // one glyph with the rest of the family; the VERB stays "drafted" because that is what actually happened —
    // these are specs the station wrote, not catalog classes it ranked.
    return '<div class="mkt-sect-h mkt-rec-sect mkt-prospect-sect">' +
      noticedHead('new roles the station drafted from your work') + '</div>' +
      '<div class="mkt-rec-rail">' + items.map(prospectCardHTML).join('') + '</div>';
  }
  function prospectCardHTML(p) {
    const d = (p && p.draft) || {};
    const emoji = d.emoji || '✦';
    return '<div class="mkt-rec mkt-prospect" data-prospect="' + esc(p.id) + '">' +
      '<div class="mkt-rec-top"><span class="mkt-prospect-glyph" aria-hidden="true">' + esc(emoji) + '</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(d.name || 'New specialist') + '</div>' +
          '<div class="mkt-rec-tag">' + esc(d.tagline || '') + '</div></div></div>' +
      (p.why ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(p.why) + '</div>' : '') +
      '<div class="mkt-prospect-prov">◇ drafted by the station from your work — review &amp; save to add it</div>' +
      '<div class="mkt-prospect-acts"><button class="bb sm mkt-prospect-open" data-prospect="' + esc(p.id) + '">▸ REVIEW &amp; SAVE</button>' +
        '<button class="bb sm mkt-prospect-dismiss" data-prospect="' + esc(p.id) + '" aria-label="dismiss this drafted role forever" title="dismiss forever — the station won\'t draft this role again">✕</button></div>' +
    '</div>';
  }
  /* ---------- R6: the "FOR YOU" row (ranked by dossier interest lanes + goal-text keyword match) ----------
     The plan's discovery-front recommender. Distinct from the profile-affinity "RECOMMENDED FOR YOU" shelf above:
     FOR YOU blends the SAME profile affinity with the Commander's GOALS belief text (keyword-matched into the rank),
     and ALWAYS renders (with an honest category-spread fallback when the profile is thin AND no goals are set) — so
     even a cold-start user gets a varied, non-arbitrary starting row. Never a fake "popular" ordering. Shown only in
     the un-filtered top-level view (no active category/search) so it doesn't fight the filtered grid below. */
  function goalText() {
    try {
      if (typeof DossierStore === 'undefined' || !DossierStore.beliefs) return '';
      return (DossierStore.beliefs('goals') || []).map(b => b && b.text).filter(Boolean).join(' ');
    } catch (_) { return ''; }
  }
  // the PAIN + AMBITION dims — what eats the Commander's time and what they never get to. Read exactly like
  // goals; the ranker gives them the same weight and names them honestly in the card's why (momentum loop).
  function painText() {
    try {
      if (typeof DossierStore === 'undefined' || !DossierStore.beliefs) return '';
      return ['pain', 'ambition'].map(d => (DossierStore.beliefs(d) || []).map(b => b && b.text).filter(Boolean).join(' ')).filter(Boolean).join(' ');
    } catch (_) { return ''; }
  }
  function forYouShelfHTML() {
    if (!hasRecipes()) return '';
    if (catFilter !== 'all' || query) return '';   // only in the clean top-level view
    const ps = profileApi();
    const ready = recommendationsReady();
    const learningOff = !ready || !!(ps && ps.enabled && !ps.enabled());
    // the affinity scorer only feeds the rank when learning is ON and the profile has signal; else rankRecipes
    // leans on goal text, then the honest category-spread fallback.
    const scoreFn = (ps && ps.score && !learningOff) ? (tags => ps.score(tags)) : null;
    // launches = the Commander's OWN real per-recipe launch counts (scout usage read) — engagement feeds the rank.
    let launches = null; if (!learningOff) { try { launches = (typeof ProspectStore !== 'undefined' && ProspectStore.launches) ? ProspectStore.launches() : null; } catch (_) {} }
    // topics ride the SAME glass-box switch as the affinity scorer: the learned histogram IS a model of the
    // Commander, so learning OFF means it may not rank anything (consent), and — because a positive term flips
    // `anySignal` — it also guarantees the row can never shrink: whenever topics are live the profile is live
    // too, so the positive filter was already engaged and an additive term can only ever ADD survivors.
    const topics = learningOff ? [] : learnedTopics();
    const gt = ready ? goalText() : '';
    const pt = ready ? painText() : '';
    // THREE, not four: the rail wraps to a second row at four cards on a standard bay, and a shelf that spends
    // two rows above the library is the thing that pushed the catalog off screen. Three also matches the
    // specialists shelf next door, so both tabs speak the same visual language.
    const preferenceModel = (typeof ProspectStore !== 'undefined' && ProspectStore.preferenceModel) ? ProspectStore.preferenceModel() : null;
    // Stride by the ROW SIZE, not by 1: a stride of 1 slides the window one bucket per visit, so consecutive
    // visits repeat two of three cards and it takes twelve visits to see the whole library. Striding by 3
    // makes each visit a disjoint set and surfaces all twelve buckets in four. This shelf exists for someone
    // who cannot yet name a use case, so three NEW domains beats one new and two they already skipped.
    const rankOpts = { score: scoreFn, goalText: gt, painText: pt, launches: launches, topics: topics, preferenceModel: preferenceModel, limit: 3, spreadOffset: recipeVisits() * 3 };
    // ASK THE RANKER WHAT IT ACTUALLY DID. `ready` only says the station has learned enough to be asked; it does
    // NOT say this row used any of it. A ready Commander whose profile, goals, launches and topics all come up
    // silent gets a catalog-order category spread — and used to get "◈ FOR YOU" printed over it.
    // the shared declined read gates the INPUT (see readyShelfHTML): a declined recipe never enters the rank,
    // and the ranker's own spread/top-up keeps the row at three from the recipes that remain — the FOR YOU
    // shelf-sink law (a negative term must never EMPTY the shelf) holds because this excludes, never down-ranks.
    const pool = Recipes.list().filter(r => !shelfDeclined(r && r.name));
    const ranked = Recipes.rankRecipesExplained
      ? Recipes.rankRecipesExplained(pool, rankOpts)
      : { items: Recipes.rankRecipes(pool, rankOpts), personalized: false };
    const items = ranked.items;
    if (!items || !items.length) return '';
    // the honest per-card WHY, recomputed from the SAME inputs that ranked the row (Recipes.forYouReason). This
    // shelf blends four real signals and used to explain NONE of them — every other shelf in the bay names its
    // reason, and truthful telemetry means the flagship row should too.
    const reasonFor = (r) => {
      let why = '';
      try { why = Recipes.forYouReason ? (Recipes.forYouReason(r, { topics: topics, goalText: gt, painText: pt, launches: launches }) || '') : ''; } catch (_) { why = ''; }
      const raw = why || (scoreFn ? becauseText(r) : '');   // affinity copy lives in ONE place (BECAUSE) — fall back to it
      // ONE grammar for every recommendation the station makes: the shelf speaks the same "because …" line
      // the COMMS offer cards do (recommend.js whyLine). Fail-open — the raw reason if the spine isn't loaded.
      return whyGrammar(raw);
    };
    /* the header may claim this row is FOR THEM only when a real term produced it (and readiness still gates the
       whole personalized read, so both must hold).

       ⛔ AND THE CLAIM IS SIZED TO THE ROW, NOT TO THE BOOLEAN (2026-08-05). `personalized` goes true on ONE real
       hit, and rankRecipesExplained then TOPS THE ROW UP from the same cold-start category spread — filler cards
       that carry no why at all, because nothing about them is about this Commander. The plural whole-row claim
       "picked from your real work" therefore sat over two catalog cards the station had never seen touched: the
       honest-header fix, still overclaiming one path down. Three states, one per thing that actually happened. */
    const scored = Number.isFinite(ranked.scored) ? ranked.scored : (ranked.personalized ? items.length : 0);
    const head = !(ready && ranked.personalized)
      ? coldHead('STARTING POINTS — a varied lineup while the station gets to know you')
      : (scored >= items.length)
        ? noticedHead('picked from your real work')
        : noticedHead(scored === 1
          ? 'one pick from your real work, plus starting points'
          : scored + ' picks from your real work, plus starting points');
    items.forEach((r, i) => trackRecommendation('recipe', r, reasonFor(r), i + 1));
    return '<div class="mkt-sect-h mkt-foryou-sect">' + head + '</div><div class="mkt-rec-rail">' +
      items.map(r => forYouCardHTML(r, reasonFor(r))).join('') + '</div>';
  }

  /* ---------- READY ON THIS STATION — the context-bound shelf ----------
     The library below is the same 98 cards for everybody. THIS shelf is not: it binds catalog recipes to
     what this station actually has — granted project roots, connected channels, learned topics, and what
     is already running as a routine — and states the evidence on every card. RecipeFit does the deciding
     (pure, node-tested); everything here is gathering and painting.

     ⛔ IT RENDERS NOTHING WHEN THERE IS NO CONTEXT. A station with no project granted and no channel
     connected knows nothing about its Commander, and a "ready for you" shelf on top of that is theatre.
     RecipeFit.offers returns [] and the Commander sees the honest library instead.

     ⛔ AND IT NEVER BLOCKS THE PAINT. Every input is read from an already-cached best-effort fetch; a
     sidecar that is down means a smaller shelf or none, never a stalled tab. */
  /* ⛔ AND A FAILURE MUST STAY RETRYABLE (2026-08-05). Both caches used to `.catch(() => { fitX = fitX || []; })`,
     and `[]` is TRUTHY — so the `if (fitX) return` guard above short-circuited every later call. ONE transient
     /api/projects hiccup (a sidecar restart, a slow first paint) therefore killed the READY shelf for the rest of
     the session: RecipeFit was handed zero projects forever, decided the station knows nothing about its
     Commander, and correctly rendered nothing. The shelf did not look broken — it looked EMPTY, which is its own
     honest state, so the bug is invisible. This file already documents the exact fix twenty lines into the module
     (loadSkillCatalog: leave the cache null, clear the in-flight marker, return an empty value for THIS call so
     the current paint degrades instead of throwing); these two are now the same shape.

     Invalidation is the other half: a Commander who grants a folder or connects a channel does it in ANOTHER
     panel and comes BACK to the bay, so re-opening the bay drops both caches (invalidateFit, called from open()).
     A stale-forever "ready" shelf is the same lie as an empty one.

     ⛔ AND INVALIDATION MUST DROP THE IN-FLIGHT FETCH TOO (2026-08-05). It nulled the two CACHES and left the
     two PENDING markers standing, which is only half a drop and produced the same stale shelf by a longer route:
     grant a folder while a /api/projects fetch from the previous open is still in the air → invalidateFit()
     clears the cache → the OLD promise resolves and writes its pre-grant rows straight back in → the READY shelf
     is authoritatively stale, and stays that way until a THIRD open. Worse, a caller that arrived between the
     invalidate and the resolve was handed the retained promise and got the pre-grant answer with no fetch of its
     own. So invalidation clears the markers AND bumps a generation token: a resolve from a superseded generation
     may answer ITS OWN caller (that request really did happen) but may not write through to the cache or touch
     the markers a newer fetch now owns. */
  let fitProjects = null, fitProjectsPending = null, fitChannels = null, fitChannelsPending = null;
  let fitGen = 0;   // bumped on every invalidation; a resolve carrying an older token cannot write through
  function invalidateFit() { fitProjects = null; fitChannels = null; fitProjectsPending = null; fitChannelsPending = null; fitGen++; }
  function loadFitProjects() {
    if (fitProjects) return Promise.resolve(fitProjects);
    if (fitProjectsPending) return fitProjectsPending;
    const gen = fitGen;
    const p = fetch('/api/projects', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(d => {
        const rows = (Array.isArray(d && d.projects) ? d.projects : []).map(p2 => ({
          root: String((p2 && (p2.root || p2.path)) || ''),
          name: String((p2 && (p2.name || p2.label)) || '') || basenameOf(String((p2 && (p2.root || p2.path)) || '')),
          // REAL evidence about what KIND of folder this is — the projects API already computes it. Without it
          // the shelf cannot tell a code repo from a folder of invoices and offers 'PR Sweep' against either.
          git: !!(p2 && p2.isGitRepo)
        })).filter(p2 => p2.root);
        if (gen !== fitGen) return rows;                 // superseded: answer this caller, write through NOTHING
        fitProjects = rows; fitProjectsPending = null; return fitProjects;
      })
      // retryable: leave fitProjects NULL (an empty array would be truthy and cache the failure forever).
      .catch(() => { if (gen === fitGen) fitProjectsPending = null; return fitProjects || []; });
    fitProjectsPending = p;
    return p;
  }
  function loadFitChannels() {
    if (fitChannels) return Promise.resolve(fitChannels);
    if (fitChannelsPending) return fitChannelsPending;
    const gen = fitGen;
    const p = fetch('/api/connectors', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { connectors: [] })
      .then(d => {
        const raw = Array.isArray(d && d.connectors) ? d.connectors : (Array.isArray(d && d.items) ? d.items : []);
        // CONNECTED only — a configured-but-broken connector cannot be cited as a reason the station is ready.
        const rows = raw.filter(c => c && c.connected !== false && c.status !== 'error')
          .map(c => ({ id: String((c && c.id) || ''), label: String((c && (c.label || c.name || c.kind || c.id)) || '') }))
          .filter(c => c.label);
        if (gen !== fitGen) return rows;                 // superseded: answer this caller, write through NOTHING
        fitChannels = rows; fitChannelsPending = null; return fitChannels;
      })
      // retryable: leave fitChannels NULL — same reason (see the note above the cache declarations).
      .catch(() => { if (gen === fitGen) fitChannelsPending = null; return fitChannels || []; });
    fitChannelsPending = p;
    return p;
  }
  function basenameOf(p) { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }

  // the context RecipeFit reasons over — every field is real, already-fetched station truth or [].
  function fitContext() {
    let launches = null;
    try { launches = (typeof ProspectStore !== 'undefined' && ProspectStore.launches) ? ProspectStore.launches() : null; } catch (_) {}
    // a live cron job carries its recipe provenance in meta.recipeId (the R3 spine) — that is how we know
    // a recipe is ALREADY running and must not be offered again.
    const scheduled = (cronJobs || []).map(j => ({
      recipeId: String((j && j.meta && j.meta.recipeId) || (j && j.recipeId) || '')
    })).filter(j => j.recipeId);
    return {
      projects: fitProjects || [],
      channels: fitChannels || [],
      topics: learnedTopics(),
      scheduled: scheduled,
      launches: launches
    };
  }

  function readyShelfHTML() {
    if (!hasRecipes() || typeof RecipeFit === 'undefined') return '';
    if (catFilter !== 'all' || query) return '';        // only in the clean top-level view
    const ctx = fitContext();
    let offers = [];
    // SIX, not three: READY now replaces the cold-start row rather than stacking above it, so it can spend the
    // two rows that row was using. Kept to a multiple of the 3-column rail so the grid never leaves an orphan.
    // the shared declined read gates the INPUT, so the fit engine ranks over the eligible pool and the shelf
    // stays as full as the context allows (a post-rank filter would shrink it below its limit instead).
    try { offers = RecipeFit.offers(Recipes.list().filter(r => !shelfDeclined(r && r.name)), ctx, { limit: 6 }) || []; } catch (_) { offers = []; }
    if (!offers.length) return '';
    // stash the context-derived values by id so the launch form can prefill from them (see launchFormHTML).
    // Rebuilt from scratch on every shelf render, so a stale binding can never outlive the context that made it.
    readySeeds = {}; offers.forEach(o => { if (o.values && Object.keys(o.values).length) readySeeds[o.recipe.id] = o.values; });
    const basis = RecipeFit.basis(ctx);
    offers.forEach((o, i) => trackRecommendation('recipe', o.recipe, o.why, i + 1));
    // the basis strip is the audit trail: it names exactly what was looked at to produce the cards below it.
    const head = '<div class="mkt-sect-h mkt-ready-sect">▲ READY ON THIS STATION' +
      (basis ? '<span class="mkt-ready-basis">read: ' + esc(basis) + '</span>' : '') + '</div>';
    const deep = offers.length > 3 ? ' mkt-rail-deep' : '';
    return head + '<div class="mkt-rec-rail' + deep + '">' + offers.map(readyCardHTML).join('') + '</div>';
  }

  /* One context-bound card. Deliberately the SAME `.mkt-rec[data-id]` markup the other shelves use, so it
     inherits their styling, focus behaviour and the one click handler at the bottom of renderStage —
     a bespoke card here would need its own binding and would drift from the rest of the bay's look.
     What it adds: the evidence line, the cadence chip, and — when the station pre-filled something — the
     line saying what it filled. A form that silently arrives filled is one that gets launched unread. */
  function readyCardHTML(o) {
    const r = o.recipe;
    const cad = r.cadence ? ' <span class="mkt-badge mkt-ready-cad">↻ ' + esc(cadenceLabelOf(r.cadence)) + '</span>' : '';
    const fill = (o.bound || []).length
      ? '<div class="mkt-ready-fill">↳ fills in ' + esc((o.bound || []).map(b => b.key + ': ' + b.label).join(' · ')) + '</div>' : '';
    return '<button class="mkt-rec mkt-foryou mkt-ready-card" type="button" data-id="' + esc(r.id) + '">' +
      declineGlyphHTML('recipe', r.id, r.name) +
      '<div class="mkt-rec-top">' + sealHTML(r, false) +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(r.name) + '</div><div class="mkt-rec-tag">' + esc(r.tagline) + '</div></div></div>' +
      '<div class="mkt-rec-why"><span class="mkt-rec-why-k">' + esc(CAT_LABEL[railBucket(r)] || 'GENERAL') + '</span>' + cad +
        ' <span class="mkt-foryou-why mkt-ready-why">' + esc(o.why) + '</span></div>' + fill + '</button>';
  }
  function cadenceLabelOf(c) {
    const m = { morning: 'every morning', weekly: 'weekly', sixhourly: 'every 6h', hourly: 'hourly' };
    return m[String(c || '')] || String(c || '');
  }

  /* Re-derive the shelf when the context it is built from actually lands. The fetches are best-effort and
     resolve after the first paint, so without this the shelf would be permanently empty on a cold open and
     only appear on the SECOND visit — which reads as broken. Repaints once, only if something changed. */
  function hydrateReadyShelf() {
    if (!hasRecipes() || typeof RecipeFit === 'undefined') return;
    const before = JSON.stringify(fitContext());
    Promise.all([loadFitProjects(), loadFitChannels(), loadCronJobs()]).then(() => {
      if (!root || tab !== 'recipes') return;
      if (JSON.stringify(fitContext()) === before) return;   // nothing new landed — no repaint
      renderStage();
    }).catch(() => {});
  }
  // the station's LEARNED interest topics (server truth: GET /api/scout, cached in ProspectStore). Empty until a
  // read lands or the histogram warms — and an empty list makes every topic term exactly 0, so the shelves rank
  // precisely as they did before topics existed. The frontend never asserts topic state it hasn't been served.
  function learnedTopics() {
    try { return (typeof ProspectStore !== 'undefined' && ProspectStore.interests) ? (ProspectStore.interests() || []) : []; }
    catch (_) { return []; }
  }
  // MERGE NOTE: this branch grew its own forYouWhy (goal keyword → affinity → launches). Recipes.forYouReason —
  // which reasonFor above calls — is the same idea with the learned-topic term in front of it, so the local copy
  // is dropped rather than kept as a second, quietly-diverging explanation of the same row.
  function forYouCardHTML(r, why) {
    const cat = CAT_LABEL[railBucket(r)] || 'GENERAL';
    return '<button class="mkt-rec mkt-foryou" type="button" data-id="' + esc(r.id) + '">' +
      declineGlyphHTML('recipe', r.id, r.name) +
      '<div class="mkt-rec-top">' + sealHTML(r, false) +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(r.name) + '</div><div class="mkt-rec-tag">' + esc(r.tagline) + '</div></div></div>' +
      '<div class="mkt-rec-why"><span class="mkt-rec-why-k">' + esc(cat) + '</span>' + (r.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') +
        (why ? ' <span class="mkt-foryou-why">' + esc(why) + '</span>' : '') + '</div></button>';
  }
  function recCardHTML(s, why, compact) {
    // `why` comes from rankSpecs: the profile-affinity reason, a goal-match note, or the cold-start lane label
    // no `--accent` — the shelf cards ride the station phosphor like every other seal in the bay
    // (see the note on mkt-card). STARTING LINEUP sat three different colours side by side.
    return '<button class="mkt-rec" type="button" data-id="' + esc(s.id) + '"' + (compact && why ? ' title="' + esc(why) + '"' : '') + '>' +
      declineGlyphHTML('recruit', s.id, s.name) +
      '<div class="mkt-rec-top">' + sealHTML(s, false) +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(s.name) + '</div><div class="mkt-rec-tag">' + esc(s.tagline) + '</div></div></div>' +
      (why && !compact ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(why) + '</div>' : '') + '</button>';
  }

  /* ---------- auto-mint: "SUGGESTED" ---------- */
  function suggestedMissions() {
    const mp = mintApi(); if (!mp) return [];
    const ps = profileApi();
    if (ps && ps.enabled && !ps.enabled()) return [];
    if (mp.enabled && !mp.enabled()) return [];
    return mp.candidates() || [];
  }
  function suggestedShelfHTML() {
    // two honest sources share this shelf: auto-mint candidates (exact task shapes the Commander keeps typing)
    // and SCOUT recipe drafts (server-authored from the learned interests, each carrying its evidence-grounded WHY).
    const cands = suggestedMissions();
    const drafts = scoutRecipeDrafts();
    if (!cands.length && !drafts.length) return scoutColdStateHTML();
    // a rail deeper than one row SCROLLS sideways instead of wrapping — see the .mkt-rail-deep note in the CSS.
    const deep = (cands.length + drafts.length) > 3 ? ' mkt-rail-deep' : '';
    return '<div class="mkt-sect-h mkt-suggest-sect">✨ SUGGESTED — from what you keep asking</div><div class="mkt-rec-rail' + deep + '">' +
      cands.map(suggestCardHTML).join('') + drafts.map(scoutRecipeCardHTML).join('') + '</div>';
  }
  /* ---------- the SUGGESTED shelf's honest COLD STATE ----------
     An empty shelf used to render as NOTHING — indistinguishable from a broken scout. Truthful telemetry:
     when the server truth (GET /api/scout, cached in ProspectStore) is in hand, say WHERE the scout actually
     is. Every figure below comes from that payload (gate/warm/interests) — nothing invented. When the cache
     has never loaded (no server read yet) we still render '' — the frontend may not assert scout state it
     can't prove. Shown only in the clean top-level view (same discipline as the FOR-YOU shelf). */
  function scoutColdStateHTML() {
    if (catFilter !== 'all' || query) return '';
    if (typeof ProspectStore === 'undefined' || !ProspectStore.gate) return '';
    let gate = null, warm = false, nInterests = 0;
    try {
      gate = ProspectStore.gate();
      warm = !!(ProspectStore.warm && ProspectStore.warm());
      nInterests = (ProspectStore.interests && ProspectStore.interests() || []).length;
    } catch (_) { return ''; }
    if (!gate) return '';   // no /api/scout read yet — assert nothing rather than guess
    let line = '';
    if (gate.fire) {
      line = 'signal locked — the station attempts a new draft after your next run.';
    } else if (gate.binding === 'cold') {
      line = !warm && nInterests > 0
        ? 'CALIBRATING — ' + nInterests + ' early signal' + (nInterests === 1 ? '' : 's') + ' held, none strong enough to draft from yet. Keep working; the station is watching what you work on.'
        : 'CALIBRATING — watching what you work on. Run real tasks and the station learns what to suggest.';
    } else if (gate.binding === 'cooldown') {
      const n = Number(gate.runsSinceMint), N = Number(gate.mintEveryRuns);
      line = 'no draft staged yet — the next attempt earns itself with more runs' +
        (Number.isFinite(n) && Number.isFinite(N) && N > 0 ? ' (' + Math.min(n, N) + '/' + N + ')' : '') + '.';
    } else if (gate.binding === 'gap') {
      line = 'the station attempted a draft recently — cooling down before the next try.';
    } else {
      return '';   // 'full' (or an unknown binding) can't co-occur with an empty shelf — stay silent, stay honest
    }
    return '<div class="mkt-sect-h mkt-suggest-sect">✨ SUGGESTED — from what you keep asking</div>' +
      '<div class="mkt-empty mkt-scout-cold">' + esc(line) + '</div>';
  }
  function scoutRecipeDrafts() {
    try { return (typeof ProspectStore !== 'undefined' && ProspectStore.recipeDrafts) ? (ProspectStore.recipeDrafts() || []) : []; } catch (_) { return []; }
  }

  /* ---------- SCOUT LOG: the attempt ledger (truthful telemetry) ----------
     Every scout mint attempt writes ONE outcome to a server-side ledger (sidecar/scout.js note()) — staged
     (a draft landed), rejected, none (the model judged the library already covers it), expired (a stale draft
     aged out), accepted/dismissed (your own verdict), or error. GET /api/scout returns the tail; the bay reads
     it via ProspectStore.ledger(). Rendering it here makes the engine VISIBLE: a dismissed draft is no longer
     the whole story — the Commander can see what the station tried and the honest reason each time. Collapsed by
     default; EVERY line comes straight from the payload — nothing invented (no fabricated "trying…" filler). */
  const SCOUT_OUT = {
    staged:    { label: 'MINTED',    cls: 'ok' },
    accepted:  { label: 'SAVED',     cls: 'ok' },
    rejected:  { label: 'REJECTED',  cls: 'no' },
    dismissed: { label: 'DISMISSED', cls: 'no' },
    none:      { label: 'NONE',      cls: 'mut' },
    expired:   { label: 'EXPIRED',   cls: 'mut' },
    error:     { label: 'ERROR',     cls: 'err' }
  };
  // relative "Nx ago" for a past epoch-ms stamp (local, tiny — mirrors projects.js relTime). '' when absent.
  function scoutRelTime(ms) {
    const t = Number(ms) || 0; if (!t) return '';
    const d = Date.now() - t; if (d < 60000) return 'now';
    const m = Math.floor(d / 60000); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function scoutLogHTML() {
    if (typeof ProspectStore === 'undefined' || !ProspectStore.ledger) return '';
    let entries = [];
    try { entries = ProspectStore.ledger() || []; } catch (_) { return ''; }
    if (!entries.length) return '';   // no attempts recorded yet — assert nothing (never a fake/empty log)
    const rows = entries.slice().reverse();   // ledger is appended oldest→newest; show newest first
    const n = rows.length;
    const head =
      '<button type="button" class="mkt-scoutlog-head" aria-expanded="' + (scoutLogOpen ? 'true' : 'false') + '">' +
        '<span class="mkt-scoutlog-caret" aria-hidden="true">' + (scoutLogOpen ? '▾' : '▸') + '</span>' +
        '<span class="mkt-scoutlog-ttl">SCOUT LOG</span>' +
        '<span class="mkt-scoutlog-sum">' + n + ' attempt' + (n === 1 ? '' : 's') + ' the station recorded</span>' +
      '</button>';
    if (!scoutLogOpen) return '<div class="mkt-scoutlog">' + head + '</div>';
    return '<div class="mkt-scoutlog open">' + head +
      '<div class="mkt-scoutlog-body">' + rows.map(scoutLogRowHTML).join('') + '</div></div>';
  }
  function scoutLogRowHTML(e) {
    e = e || {};
    const meta = SCOUT_OUT[e.outcome] || { label: String(e.outcome || '·').toUpperCase().slice(0, 12), cls: 'mut' };
    const kind = String(e.kind || '');
    const kindLbl = kind === 'prospect' ? 'class' : kind === 'recipe' ? 'recipe' : kind;   // honest kind, never invented
    const when = scoutRelTime(e.at);
    const title = String(e.title || '');
    const reason = String(e.reason || '');
    return '<div class="mkt-slog-row">' +
      '<span class="mkt-slog-out ' + meta.cls + '">' + esc(meta.label) + '</span>' +
      '<div class="mkt-slog-main">' +
        '<div class="mkt-slog-line">' +
          (kindLbl ? '<span class="mkt-slog-kind">' + esc(kindLbl) + '</span>' : '') +
          (title ? '<span class="mkt-slog-ttl">' + esc(title) + '</span>' : '') +
          (when ? '<span class="mkt-slog-time">' + esc(when) + '</span>' : '') +
        '</div>' +
        (reason ? '<div class="mkt-slog-reason">' + esc(reason) + '</div>' : '') +
      '</div></div>';
  }
  /* ---------- FOUND ON YOUR PROJECTS: the environment-discovery shelf ----------
     The first surface where the station proposes work the Commander never typed. Every card's FOUND line is the
     repo's own text (a TODO marker, the porcelain status), read from a BLESSED root by the sidecar's bounded
     scan — nothing is model-authored, so nothing can be invented. Renders '' until a real server read lands
     (the scoutColdState law: the frontend may not assert discovery state it can't prove) and '' when the shelf
     is empty — discovery earns its section with real cards, it never sits as furniture. */
  function discoveryFindings() {
    try { return (typeof DiscoveryStore !== 'undefined' && DiscoveryStore.findings) ? (DiscoveryStore.findings() || []) : []; } catch (_) { return []; }
  }
  function discoveryShelfHTML() {
    if (catFilter !== 'all' || query) return '';
    const rows = discoveryFindings();
    if (!rows.length) return '';
    const deep = rows.length > 3 ? ' mkt-rail-deep' : '';
    return '<div class="mkt-sect-h mkt-suggest-sect">🔭 FOUND ON YOUR PROJECTS — in the code’s own words</div><div class="mkt-rec-rail' + deep + '">' +
      rows.map(discoveryCardHTML).join('') + '</div>';
  }
  function discoveryCardHTML(f) {
    const base = (String(f.displayPath || f.root || '').split(/[\\/]+/).filter(Boolean).pop()) || '';
    return '<div class="mkt-rec mkt-prospect mkt-disc" data-disc="' + esc(f.id) + '">' +
      '<div class="mkt-rec-top"><span class="mkt-prospect-glyph" aria-hidden="true">' + (f.kind === 'wip' ? '🔧' : '🔭') + '</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(f.title) + '</div>' +
          '<div class="mkt-rec-tag">' + esc(base) + '</div></div></div>' +
      '<div class="mkt-rec-why"><span class="mkt-rec-why-k">FOUND</span> ' + esc(f.quote) + '</div>' +
      '<div class="mkt-prospect-prov">◇ read from your blessed project — nothing runs without your word</div>' +
      '<div class="mkt-prospect-acts"><button class="bb sm mkt-disc-take" data-disc="' + esc(f.id) + '">▸ HAND IT TO THE CREW</button>' +
        '<button class="bb sm mkt-disc-dismiss" data-disc="' + esc(f.id) + '" aria-label="dismiss this finding forever" title="dismiss forever — this exact finding won’t come back">✕</button></div>' +
    '</div>';
  }

  // a station-drafted recipe card — same card family as the prospect shelf (glyph + WHY + provenance + arm-confirmed
  // dismiss), because it makes the same promise: drafted from YOUR observed work, never saved without your review.
  function scoutRecipeCardHTML(p) {
    const d = (p && p.draft) || {};
    return '<div class="mkt-rec mkt-prospect mkt-scout-recipe" data-scout="' + esc(p.id) + '">' +
      '<div class="mkt-rec-top"><span class="mkt-prospect-glyph" aria-hidden="true">' + esc(d.emoji || '✦') + '</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(d.name || 'New recipe') + '</div>' +
          '<div class="mkt-rec-tag">' + esc(d.tagline || '') + '</div></div></div>' +
      (p.why ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(p.why) + '</div>' : '') +
      '<div class="mkt-prospect-prov">◇ drafted by the station from your work — review &amp; save to add it</div>' +
      '<div class="mkt-prospect-acts"><button class="bb sm mkt-scout-recipe-open" data-scout="' + esc(p.id) + '">▸ REVIEW &amp; SAVE</button>' +
        '<button class="bb sm mkt-scout-recipe-dismiss" data-scout="' + esc(p.id) + '" aria-label="dismiss this drafted recipe forever" title="dismiss forever — the station won\'t draft this recipe again">✕</button></div>' +
    '</div>';
  }
  function suggestCardHTML(c) {
    return '<div class="mkt-rec mkt-suggest" data-key="' + esc(c.key) + '">' +
      '<div class="mkt-rec-top"><span class="mkt-suggest-spark" aria-hidden="true">✨</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(c.template) + '</div>' +
          '<div class="mkt-rec-tag">you’ve asked this ' + c.count + ' times</div></div></div>' +
      '<div class="mkt-suggest-acts"><button class="bb sm mkt-suggest-review" data-key="' + esc(c.key) + '">▸ REVIEW &amp; SAVE</button>' +
        '<button class="bb sm mkt-suggest-dismiss" data-key="' + esc(c.key) + '" aria-label="dismiss this suggestion" title="not a recipe">✕</button></div>' +
    '</div>';
  }

  /* ---------- wiring: roster ---------- */
  function focusFromCard(id) {
    if (!id) return;
    try { if (typeof ProspectStore !== 'undefined' && ProspectStore.recommendationVerdict) ProspectStore.recommendationVerdict(tab === 'recipes' ? 'recipe' : 'recruit', id, 'opened', 'accepted'); } catch (_) {}
    if (tab === 'recipes') focusRecipe = id; else focusAgent = id;
    sfx('click'); renderDossier();
    const dos = root.querySelector('#mkt-dossier'); if (dos) dos.scrollTop = 0;
    const mkt = root.querySelector('.mkt'); if (mkt) mkt.classList.add('show-dossier');
  }
  function wireRoster(stage) {
    stage.querySelectorAll('.mkt-card').forEach(b => b.addEventListener('click', () => focusFromCard(b.dataset.id)));
    stage.querySelectorAll('.mkt-rec[data-id]').forEach(b => b.addEventListener('click', () => focusFromCard(b.dataset.id)));
    /* the shelf-card ✕ (one-memory lane): a span inside the card <button>, so its click must stop before the
       card's own open handler above sees it. Keyboard parity because role="button" promises it. The repaint is
       immediate — the declined card vanishes and the shelf refills from what remains. */
    stage.querySelectorAll('.mkt-rec-decline').forEach(x => {
      const fire = (ev) => {
        ev.stopPropagation(); ev.preventDefault();
        declineShelfItem(x.dataset.declineSurface, x.dataset.declineId, x.dataset.declineName);
        sfx('click'); renderStage();
      };
      x.addEventListener('click', fire);
      x.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') fire(ev); });
    });

    const saveas = stage.querySelector('.mkt-saveas');
    if (saveas) saveas.addEventListener('click', () => { sfx('click'); view = 'save'; editingId = null; renderStage(); });
    const build = stage.querySelector('.mkt-build');
    // editingId cleared: ＋ is always a FRESH class, never a stale upsert (the edit view can be abandoned by closing the window)
    if (build) build.addEventListener('click', () => { sfx('click'); editingId = null; buildDraft = null; acceptingProspectId = null; buildAccent = '#ffaa33'; buildModel = 'balanced'; buildKit = []; buildSkills = []; buildEffort = null; view = 'build'; renderStage(); });
    const recipeSaveas = stage.querySelector('.mkt-recipe-saveas');
    if (recipeSaveas) recipeSaveas.addEventListener('click', () => { sfx('click'); pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; enterRecipeEditor(null, 'create'); });

    // SPECIALIST ARCHIVE: the deep-cut pool expands/collapses (state survives re-renders within one open bay).
    const archHead = stage.querySelector('.mkt-archive-head');
    if (archHead) archHead.addEventListener('click', () => { archiveOpen = !archiveOpen; sfx('click'); renderStage(); });

    wireGridNav(stage);
    wireGlass(stage);
    wireSuggest(stage);
    wireProspect(stage);
  }
  // roving tabindex + arrow-key nav across the class/recipe grid (audit item 8): exactly one card is Tab-reachable
  // (the selected one, else the first); Left/Right walk in DOM order, Up/Down jump a row (columns derived live from
  // the auto-fill layout). Keeps the grid one Tab-stop instead of dozens, and makes it keyboard-drivable.
  function wireGridNav(scope) {
    // Filters reuse the stage node. Replace its handler so each arrow advances once,
    // even after several searches or lane changes.
    if (scope._mktGridNav) scope.removeEventListener('keydown', scope._mktGridNav);
    const cards0 = Array.from(scope.querySelectorAll('.mkt-card'));
    if (!cards0.length) return;
    const fid = tab === 'recipes' ? focusRecipe : focusAgent;
    let activeIdx = cards0.findIndex(c => c.dataset.id === fid); if (activeIdx < 0) activeIdx = 0;
    cards0.forEach((c, i) => { c.tabIndex = (i === activeIdx ? 0 : -1); });
    scope._mktGridNav = e => {
      const cur = document.activeElement;
      if (!cur || !cur.classList || !cur.classList.contains('mkt-card') || !scope.contains(cur)) return;
      if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      const list = Array.from(scope.querySelectorAll('.mkt-card'));
      const i = list.indexOf(cur); if (i < 0) return;
      // columns = how many cards share the first row's top offset (auto-fill layout, read live)
      let cols = 0; const top0 = list[0].offsetTop;
      for (const c of list) { if (c.offsetTop === top0) cols++; else break; }
      cols = Math.max(1, cols);
      let next = i;
      if (e.key === 'ArrowRight') next = i + 1;
      else if (e.key === 'ArrowLeft') next = i - 1;
      else if (e.key === 'ArrowDown') next = i + cols;
      else if (e.key === 'ArrowUp') next = i - cols;
      if (next < 0 || next >= list.length || next === i) { e.preventDefault(); return; }
      e.preventDefault();
      list.forEach(c => { c.tabIndex = -1; });
      list[next].tabIndex = 0; list[next].focus();
    };
    scope.addEventListener('keydown', scope._mktGridNav);
  }

  /* ---------- wiring: prospects (station-drafted new classes) ----------
     REVIEW & SAVE seeds the EXISTING custom-class builder with the draft (kit/skills/text pre-filled) — the
     Commander reviews, edits, and confirms → a normal custom specialty is saved (summon path unchanged). Accepting
     removes the prospect from staging (accept, not denylist). Dismiss denylists the fingerprint + re-renders. */
  function wireProspect(scope) {
    const sc = scope || root;
    if (typeof ProspectStore === 'undefined') return;
    sc.querySelectorAll('.mkt-prospect-open').forEach(b => b.addEventListener('click', () => {
      const p = ProspectStore.get ? ProspectStore.get(b.dataset.prospect) : null;
      if (!p || !p.draft) { renderStage(); return; }
      sfx('click');
      prefillBuilderFromProspect(p);
    }));
    // dismiss permanently denylists the fingerprint (the station won't re-draft this role), so it takes a
    // two-step arm/confirm — the armed label admits the permanence. Reuse the shared ArmConfirm helper (the ONE
    // tested arm/confirm primitive, index.html loads it before this) rather than a fourth hand-rolled copy;
    // fall back to the bay's local armDelete only if ArmConfirm isn't loaded in this build, so it never regresses.
    sc.querySelectorAll('.mkt-prospect-dismiss').forEach(b => {
      const confirmDismiss = () => {
        sfx('close');
        if (ProspectStore.dismiss) ProspectStore.dismiss(b.dataset.prospect);
        renderStage();
      };
      if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
        ArmConfirm.wire(b, { armedLabel: 'DISMISS FOREVER?', restLabel: '✕', timeoutMs: 4000, onConfirm: confirmDismiss });
      } else {
        b.addEventListener('click', () => armDelete(b, '✕', confirmDismiss, 'DISMISS FOREVER?'));
      }
    });
  }
  // seed the custom-class builder state from a prospect draft, then open it (mirrors the R5 recipeMint pre-fill).
  // acceptingProspectId is held so a successful CREATE removes the prospect from staging (accept, not dismiss).
  function prefillBuilderFromProspect(p) {
    const d = p.draft || {};
    editingId = null;                                  // a brand-new custom, not an upsert of an existing class
    buildAccent = d.accent || '#ffaa33';
    buildModel = (d.model && ['reasoning', 'balanced', 'fast'].indexOf(d.model) >= 0) ? d.model : 'balanced';
    buildKit = Array.isArray(d.kit) ? d.kit.slice() : [];
    buildSkills = Array.isArray(d.skills) ? d.skills.slice() : [];
    buildEffort = d.reasoningEffort || null;
    buildDraft = { emoji: d.emoji || '✦', name: d.name || '', tagline: d.tagline || '', purpose: d.purpose || '', manual: d.manual || '' };
    acceptingProspectId = p.id;                        // consumed on a successful save
    view = 'build'; renderStage();
  }

  /* ---------- wiring: dossier (the action button + custom edit/delete) ---------- */
  /* CONFIGURE panel wiring. It lives in the dossier now, which changes ONE rule that used to be free: the name
     field is INSIDE the element renderDossier() replaces, so a keystroke may never trigger a dossier repaint —
     that would tear the focused input out from under the Commander mid-word. Every name-driven surface is
     therefore patched in place (counter, helper, aria-invalid, and every .mkt-candidate-name echo including the
     CTA's). Called from wireDossier so it re-binds on both a full stage render and a dossier-only repaint. */
  function wireSummonConfig(sc) {
    const modelSettings = sc.querySelector('.mkt-model-settings');
    if (modelSettings) modelSettings.addEventListener('toggle', () => { if (modelSettings.isConnected) modelSettingsOpen = modelSettings.open; });
    const nameIn = sc.querySelector('#mkt-summon-name');
    if (nameIn) nameIn.addEventListener('input', () => {
      pickedSummonName = nameIn.value;
      const s = (focusAgent && Specialties.get(focusAgent)) || null;
      root.querySelectorAll('.mkt-candidate-name').forEach(e => { e.textContent = summonCandidateName(s); });
      const used = ((typeof AgentId !== 'undefined' && AgentId.normalizeName) ? AgentId.normalizeName(pickedSummonName) : String(pickedSummonName || '')).length;
      const max = (ctx && ctx.displayNameLimit) || (typeof AgentId !== 'undefined' && AgentId.NAME_MAX) || 18;
      const count = root.querySelector('.mkt-name-count'); if (count) { count.textContent = used + ' / ' + max; count.classList.toggle('over', used > max); }
      const issue = summonNameIssue(), dup = summonNameConflict();
      const help = root.querySelector('.mkt-name-help');
      if (help) {
        help.textContent = issue === 'too-long' ? 'too long — shorten this name before summoning'
          : dup ? 'duplicate name — summon requires a second confirmation; the agent id will remain unique'
          : 'blank uses the proposed default: ' + summonCandidateName(s);
        help.classList.toggle('warn', !!(issue || dup));
      }
      nameIn.setAttribute('aria-invalid', issue ? 'true' : 'false');
    });

    const skinWrap = sc.querySelector('#mkt-skin-picker');
    if (skinWrap) {
      // stage handle (assigned by the mount below): drive THIS stage, not the module-level shortcut — the
      // agent dossier's CONFIG › SKIN stage can be open behind this modal and whichever mounted last owns it.
      let skinStage = null;
      skinWrap.querySelectorAll('.skin-thumb').forEach(b => {
        b.addEventListener('click', () => {
          pickedSummonSkin = b.dataset.skin;
          skinWrap.querySelectorAll('.skin-thumb').forEach(x => { x.classList.remove('sel'); x.setAttribute('aria-pressed', 'false'); });
          b.classList.add('sel'); sfx('click');
          b.setAttribute('aria-pressed', 'true');
          const choice = sc.querySelector('.mkt-appearance-choice');
          if (choice) choice.textContent = DATA.SKINS[pickedSummonSkin].name || pickedSummonSkin;
          if (skinStage) skinStage.show(pickedSummonSkin);
        });
        // hover scrubs the live stage so you can compare without committing; leaving snaps back to the pick
        b.addEventListener('mouseenter', () => { if (skinStage) skinStage.show(b.dataset.skin); });
      });
      skinWrap.addEventListener('mouseleave', () => { if (skinStage) skinStage.show(pickedSummonSkin); });
      // bind the live preview stage to the picked skin
      const stageImg = sc.querySelector('#mkt-skin-stage-img');
      const stageName = sc.querySelector('#mkt-skin-stage-name');
      if (stageImg && typeof SkinStage !== 'undefined') skinStage = SkinStage.mount(stageImg, stageName, pickedSummonSkin);
    }

    // SUMMON model picker: fill the catalog async, then track the choice ('' model → inherit the orchestrator's).
    const modelWrap = sc.querySelector('#mkt-model-pick');
    if (modelWrap && typeof ModelPicker !== 'undefined') {
      ModelPicker.populate(modelWrap, { current: pickedSummonModel || {} }).catch(() => {});
      ModelPicker.onChange(modelWrap, (sel) => {
        // EFFORT is an independent axis (audit item 5): a chosen effort must survive even when the MODEL is left
        // to inherit the orchestrator's. summonAgent/applyLoadout honor pin.effort independently of pin.model, so
        // carry { model:'', effort } rather than dropping the whole pin the moment model is blank.
        if (sel && sel.model) pickedSummonModel = { model: sel.model, provider: sel.provider, effort: sel.effort || '' };
        else if (sel && sel.effort) pickedSummonModel = { model: '', provider: '', effort: sel.effort };
        else pickedSummonModel = null;
        sfx('click');
        // patch the helper only — a renderDossier here would rebuild the <select> and re-run its async populate,
        // flashing the choice the Commander just made back to blank until the catalog resolves again.
        const help = sc.querySelector('#mkt-model-help');
        if (help) help.innerHTML = modelHelpHTML((focusAgent && Specialties.get(focusAgent)) || null);
        const choice = sc.querySelector('.mkt-model-choice');
        if (choice) choice.textContent = summonModelSummary();
      });
    }
  }

  function wireDossier(scope) {
    const sc = scope || root; if (!sc) return;
    wireSummonConfig(sc);
    const detailTabs = Array.from(sc.querySelectorAll('[data-recipe-panel]'));
    const selectDetailTab = btn => {
      detailTabs.forEach(t => { const active = t === btn; t.setAttribute('aria-selected', String(active)); t.tabIndex = active ? 0 : -1; });
      sc.querySelectorAll('.mkt-recipe-detail-panel').forEach(p => { p.hidden = p.id !== btn.getAttribute('aria-controls'); });
    };
    detailTabs.forEach((btn, i) => {
      btn.addEventListener('click', () => selectDetailTab(btn));
      btn.addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? detailTabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + detailTabs.length) % detailTabs.length;
        selectDetailTab(detailTabs[next]); detailTabs[next].focus();
      });
    });
    const inlineLaunch = sc.querySelector('.mkt-inline-launch');
    if (inlineLaunch && focusRecipe) wireLaunchForm(inlineLaunch, Recipes.get(focusRecipe));
    const dosBack = sc.querySelector('.mkt-dos-back');
    if (dosBack) dosBack.addEventListener('click', () => closeDossierSheet());
    const deployBtn = sc.querySelector('.mkt-deploy');
    if (deployBtn) {
      if (ctx && ctx.mode === 'pick') {
        // SUMMON (pick mode) — additive, never destructive, so it fires on the first click (no arm). The P0 fix
        // (audit #6): hand back { activate:true } so summonAgent LANDS the Commander in the new agent's chat
        // thread (focus + Chat.load) instead of quietly toasting from behind the still-open bay. The desk-placement
        // chip lives in summonAgent's activate branch, so routing through it delivers that guidance too. Non-summon
        // pick (the wake screen) has no live agent to activate — it just hands the chosen spec back.
        deployBtn.addEventListener('click', () => {
          const s = Specialties.get(deployBtn.dataset.id); if (!s) return;
          const commit = () => {
            sfx('click');
            if (ctx.onPick) {
              if (ctx.summon) ctx.onPick(Object.assign({}, s, { skin: pickedSummonSkin || (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN), modelPin: pickedSummonModel || null, agentName: summonCandidateName(s) }), { activate: true });
              else ctx.onPick(s);
            }
            try {
              if (typeof ProspectStore !== 'undefined' && ProspectStore.recommendationVerdict) {
                ProspectStore.recommendationVerdict('recruit', s.id, 'completed', 'completed');
                ProspectStore.recommendationOutcome('recruit', s.id, { adopted: true, quality: 1, completedAt: Date.now() });
              }
            } catch (_) {}
            close();
          };
          if (ctx.summon && summonNameIssue()) {
            // no re-render: the field is always on screen now, so send the Commander straight to it.
            sfx('bad'); note('name is too long — use 18 characters or fewer', 'bad');
            const input = root.querySelector('#mkt-summon-name');
            if (input) { try { input.scrollIntoView({ block: 'center' }); } catch (_) {} input.focus(); }
            return;
          }
          if (ctx.summon && summonNameConflict()) return armDelete(deployBtn, deployBtn.textContent, commit, 'SUMMON DUPLICATE NAME?');
          commit();
        });
      } else {
        // DEPLOY TO <current> (deploy mode) — a RE-SPEC that rewrites the live agent's purpose + standing orders.
        // That's consequential, so it arms/confirms ("RE-SPEC <NAME>?") like every other irreversible bay action.
        armCta(deployBtn, 'RE-SPEC ' + String((ctx && ctx.agentName) || 'AGENT').toUpperCase() + '?', () => {
          const s = Specialties.get(deployBtn.dataset.id); if (!s) return;
          const cb = root && root.querySelector('.mkt-adopt-cb');
          const adoptVoice = !!(cb && cb.checked);
          sfx('close');
          if (ctx && ctx.onDeploy) ctx.onDeploy(s, { adoptVoice });
          try { if (typeof ProspectStore !== 'undefined' && ProspectStore.recommendationVerdict) { ProspectStore.recommendationVerdict('recruit', s.id, 'completed', 'completed'); ProspectStore.recommendationOutcome('recruit', s.id, { adopted: true, quality: 1, completedAt: Date.now() }); } } catch (_) {}
          note(s.name + ' deployed to ' + ((ctx && ctx.agentName) || 'your agent') + (adoptVoice ? ' (+ voice)' : ''), 'good');
          close();
        });
      }
    }
    // second verb on the merged recruit door: DEPLOY TO <current> from summon mode (no voice adoption checkbox in
    // this pane — deploy keeps the agent's voice; the dossier can retune it). Same re-spec, same arm/confirm.
    const deployCurBtn = sc.querySelector('.mkt-deploy-cur');
    if (deployCurBtn) armCta(deployCurBtn, 'RE-SPEC ' + String((ctx && ctx.agentName) || 'AGENT').toUpperCase() + '?', () => {
      const s = Specialties.get(deployCurBtn.dataset.id); if (!s) return;
      sfx('close');
      if (ctx && ctx.onDeploy) ctx.onDeploy(s, { adoptVoice: false });
      note(s.name + ' deployed to ' + ((ctx && ctx.agentName) || 'your agent'), 'good');
      close();
    });
    const launchBtn = sc.querySelector('.mkt-launch');
    if (launchBtn) launchBtn.addEventListener('click', () => {
      if (!hasRecipes()) return;
      const r = Recipes.get(launchBtn.dataset.id); if (!r) return;
      sfx('click');
      const defaults = recipeDefaults(r);
      if (!Recipes.requiredMissing(r, defaults).length && !(r.intake || []).length) {
        launchRecipeNow(r, defaults); return;
      }
      launchId = r.id; launchMode = 'run'; launchCadence = null; view = 'launch';
      loadCronJobs();   // warm the armed-state note for the MAKE ROUTINE panel
      renderStage();
    });
    const optionsBtn = sc.querySelector('.mkt-launch-options');
    if (optionsBtn) optionsBtn.addEventListener('click', () => {
      launchId = optionsBtn.dataset.id; launchMode = 'routine';
      const r = Recipes.get(launchId);
      launchCadence = r && r.cadence && cadenceOpt(r.cadence) ? r.cadence : 'morning'; view = 'launch';
      loadCronJobs(); renderStage();
    });
    const edit = sc.querySelector('.mkt-edit');
    if (edit) edit.addEventListener('click', () => {
      editingId = edit.dataset.id; sfx('click');
      // A custom class is a full loadout — edit it in the same builder form (so kit/skills/effort are editable),
      // prefilling every picker from the saved spec. (Only customs carry an EDIT button; built-ins stay frozen.)
      const s = Specialties.get(editingId);
      buildAccent = (s && s.accent) || '#ffaa33';
      buildModel = (s && s.model) || 'balanced';
      buildKit = (s && Array.isArray(s.kit)) ? s.kit.slice() : [];
      buildSkills = (s && Array.isArray(s.skills)) ? s.skills.slice() : [];
      buildEffort = (s && s.reasoningEffort) || null;
      view = 'build'; renderStage();
    });
    const rEdit = sc.querySelector('.mkt-recipe-edit');
    if (rEdit) rEdit.addEventListener('click', () => {
      pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; sfx('click');
      // EDIT an existing custom in place — seed the editor from the saved record so every picker prefills.
      const r = hasRecipes() ? Recipes.get(rEdit.dataset.id) : null;
      enterRecipeEditor(r || {}, 'edit', rEdit.dataset.id);
    });
    // TWEAK — on EVERY recipe dossier (builtin or custom): fork it into a new editable custom, prefilled.
    const rTweak = sc.querySelector('.mkt-recipe-tweak');
    if (rTweak) rTweak.addEventListener('click', () => {
      if (!hasRecipes()) return;
      pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; sfx('click');
      const forkDraft = Recipes.forkFrom(rTweak.dataset.id);
      if (!forkDraft) { note('could not tweak that recipe', 'bad'); return; }
      enterRecipeEditor(forkDraft, 'fork');
    });
    // EXPORT — download the focused recipe as a portable JSON file (R6). On EVERY dossier (builtins are seeds too).
    const rExport = sc.querySelector('.mkt-recipe-export');
    if (rExport) rExport.addEventListener('click', () => {
      if (!hasRecipes()) return;
      const obj = Recipes.exportRecipe(rExport.dataset.id);
      if (!obj) { sfx('bad'); note('could not export that recipe', 'bad'); return; }
      sfx('click'); downloadRecipeFile(obj);
    });
    const del = sc.querySelector('.mkt-del');
    if (del) del.addEventListener('click', () => armDelete(del, '⌫ DELETE', () => {
      const s = Specialties.get(del.dataset.id);
      Specialties.removeCustom(del.dataset.id);
      if (focusAgent === del.dataset.id) focusAgent = (Specialties.builtins()[0] || {}).id || null;
      note('removed specialty: ' + ((s && s.name) || del.dataset.id), 'good'); renderStage();
    }));
    const rDel = sc.querySelector('.mkt-recipe-del');
    if (rDel) rDel.addEventListener('click', () => armDelete(rDel, '⌫ DELETE', () => {
      const r = hasRecipes() ? Recipes.get(rDel.dataset.id) : null;
      if (hasRecipes()) Recipes.removeCustom(rDel.dataset.id);
      if (focusRecipe === rDel.dataset.id) focusRecipe = ((hasRecipes() && Recipes.builtins()[0]) || {}).id || null;
      note('removed recipe: ' + ((r && r.name) || rDel.dataset.id), 'good'); renderStage();
    }));
  }
  // arm/confirm a CTA (re-spec) in place: prefer the ONE shared ArmConfirm primitive (label swap + .armed +
  // auto-disarm), fall back to the bay's local armDelete only where ArmConfirm isn't loaded. Distinct from
  // armDelete in that the resting label is whatever the button already shows (a full CTA caption), not a fixed one.
  function armCta(btn, armedLabel, onConfirm) {
    if (!btn) return;
    if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
      ArmConfirm.wire(btn, { armedLabel: armedLabel, timeoutMs: 4000, onConfirm: onConfirm });
    } else {
      const rest = btn.textContent;
      btn.addEventListener('click', () => armDelete(btn, rest, onConfirm, armedLabel));
    }
  }
  // two-step arm/confirm on a destructive button (the bay's idiom — never a native confirm)
  // armLabel is the text shown once armed (defaults to 'SURE?'); lets a destructive action admit permanence.
  function armDelete(b, label, run, armLabel) {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1'; b.classList.add('armed'); b.textContent = armLabel || 'SURE?'; sfx('bad');
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = '0'; b.classList.remove('armed'); b.textContent = label; } }, 4000);
      return;
    }
    sfx('close'); run();
  }

  /* ---------- wiring: glass box ---------- */
  function wireGlass(scope) {
    const sc = scope || root;
    const famHead = sc.querySelector('.mkt-fam-head');
    if (famHead) famHead.addEventListener('click', () => { glassOpen = !glassOpen; sfx('click'); renderStage(); });
    // BOTH consent surfaces carry this button — the slim strip above the shelf and the full panel's block below.
    // querySelectorAll, not querySelector: wiring only the first would leave one of the two GOT ITs inert.
    sc.querySelectorAll('.mkt-fam-ack').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); setAcked(); sfx('click'); renderStage(); }));
    const famPause = sc.querySelector('.mkt-fam-pause');
    if (famPause) famPause.addEventListener('click', async () => {
      const ps = profileApi(); if (!ps || !ps.setEnabled) return;
      const on = ps.enabled ? ps.enabled() : true;
      famPause.disabled = true;
      try {
        const f = (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch : fetch;
        const response = await f('/api/personalization', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !on }) });
        if (!response.ok) throw new Error('http ' + response.status);
        const verified = await response.json();
        if (!verified || !!verified.enabled !== !on) throw new Error('state mismatch');
        ps.setEnabled(!on);
        if (mintApi() && MintStore.setEnabled) MintStore.setEnabled(!on);
        sfx(on ? 'bad' : 'click');
        note(on ? 'learning paused — browser and sidecar confirmed' : 'learning resumed — browser and sidecar confirmed', on ? '' : 'good');
        renderStage();
      } catch (_) {
        famPause.disabled = false;
        note('could not verify the sidecar setting; personalization was not changed', 'bad');
      }
    });
    const famForget = sc.querySelector('.mkt-fam-forget');
    if (famForget) famForget.addEventListener('click', () => armDelete(famForget, '⌫ FORGET', () => {
      const ps = profileApi(); if (ps && ps.forget) ps.forget();
      if (typeof WorkSignalStore !== 'undefined' && WorkSignalStore.forget) WorkSignalStore.forget();
      if (mintApi() && MintStore.forget) MintStore.forget();
      if (typeof ProspectStore !== 'undefined' && ProspectStore.reset) ProspectStore.reset();
      try { const f = (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch : fetch; f('/api/personalization', { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(() => { if (typeof ProspectStore !== 'undefined' && ProspectStore.refresh) ProspectStore.refresh(); note('derived preference profile wiped; your explicit dossier, goals, projects, and threads were preserved', 'good'); }).catch(() => note('local profile wiped; server-side erase could not be verified', 'bad')); } catch (_) {}
      sfx('close'); renderStage();
    }, 'SURE? WIPE'));
  }

  /* ---------- wiring: suggested (mint) ---------- */
  function wireSuggest(scope) {
    const sc = scope || root;
    // SCOUT LOG collapsible: toggle expands/collapses the attempt ledger (re-render, like the SUMMON CONFIG strip).
    const slogHead = sc.querySelector('.mkt-scoutlog-head');
    if (slogHead) slogHead.addEventListener('click', () => { scoutLogOpen = !scoutLogOpen; sfx('click'); renderStage(); });
    sc.querySelectorAll('.mkt-suggest-review').forEach(b => b.addEventListener('click', () => {
      const c = suggestedMissions().find(x => x.key === b.dataset.key);
      if (!c) { renderStage(); return; }
      pendingMintKey = c.key; pendingMintTemplate = c.template;
      sfx('click');
      // a mint review seeds the editor with the observed template (params derive from its {tokens} on save).
      enterRecipeEditor({ task: c.template }, 'create');
    }));
    sc.querySelectorAll('.mkt-suggest-dismiss').forEach(b => b.addEventListener('click', () => {
      if (mintApi()) MintStore.markDismissed(b.dataset.key);
      sfx('close'); renderStage();
    }));
    // SCOUT recipe drafts: REVIEW & SAVE opens the R2 editor fully pre-filled from the draft; the save is the
    // accept (consumed in wireRecipeSaveForm). Dismiss denylists server-side (never re-drafted) → arm/confirm.
    sc.querySelectorAll('.mkt-scout-recipe-open').forEach(b => b.addEventListener('click', () => {
      const p = (typeof ProspectStore !== 'undefined' && ProspectStore.get) ? ProspectStore.get(b.dataset.scout) : null;
      if (!p || !p.draft) { renderStage(); return; }
      sfx('click');
      pendingMintKey = null; pendingMintTemplate = null;
      pendingScoutRecipeId = p.id;
      scoutSeedDraft = p.draft;
      enterRecipeEditor({ task: p.draft.task, gear: p.draft.gear, category: p.draft.category, params: p.draft.params }, 'create');
    }));
    sc.querySelectorAll('.mkt-scout-recipe-dismiss').forEach(b => {
      const confirmDismiss = () => {
        sfx('close');
        if (typeof ProspectStore !== 'undefined' && ProspectStore.dismiss) ProspectStore.dismiss(b.dataset.scout);
        renderStage();
      };
      if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
        ArmConfirm.wire(b, { armedLabel: 'DISMISS FOREVER?', restLabel: '✕', timeoutMs: 4000, onConfirm: confirmDismiss });
      } else {
        b.addEventListener('click', () => armDelete(b, '✕', confirmDismiss, 'DISMISS FOREVER?'));
      }
    });
    /* DISCOVERY findings: HAND IT posts the accepted verdict and PREFILLS the COMMS composer with a directive
       that carries the finding's own citation — NOTHING auto-runs, the Commander edits and hits send
       (Chat.prefill only scaffolds; the resummon law verbatim). Dismiss denylists the fingerprint server-side
       forever → arm/confirm, same weight as the scout's. */
    sc.querySelectorAll('.mkt-disc-take').forEach(b => b.addEventListener('click', () => {
      const f = (typeof DiscoveryStore !== 'undefined' && DiscoveryStore.get) ? DiscoveryStore.get(b.dataset.disc) : null;
      if (!f) { renderStage(); return; }
      sfx('click');
      try { if (DiscoveryStore.decide) DiscoveryStore.decide(f.id, 'accept'); } catch (_) {}
      const dir = 'In my project ' + String(f.displayPath || f.root) + ' — ' + String(f.title) +
        ' (the scan found: "' + String(f.quote) + '"). Take care of it.';
      try { if (typeof Chat !== 'undefined' && Chat.prefill) Chat.prefill(dir); } catch (_) {}
      renderStage();
    }));
    sc.querySelectorAll('.mkt-disc-dismiss').forEach(b => {
      const confirmDiscDismiss = () => {
        sfx('close');
        try { if (typeof DiscoveryStore !== 'undefined' && DiscoveryStore.decide) DiscoveryStore.decide(b.dataset.disc, 'dismiss'); } catch (_) {}
        renderStage();
      };
      if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
        ArmConfirm.wire(b, { armedLabel: 'DISMISS FOREVER?', restLabel: '✕', timeoutMs: 4000, onConfirm: confirmDiscDismiss });
      } else {
        b.addEventListener('click', () => armDelete(b, '✕', confirmDiscDismiss, 'DISMISS FOREVER?'));
      }
    });
  }

  /* ---------- R6: export / import a recipe as a portable JSON file ----------
     EXPORT downloads the v2 recipe object (pretty-printed, format-marked) as a single file. IMPORT reads a picked
     file, JSON-parses it, and hands it to Recipes.importRecipe which validates the shape, strips unknown fields,
     and saves it as a fresh custom (never executes anything from the file). A malformed file → an honest inline
     note, no crash. This is the seed of the open-core marketplace unit — a clean portable format, no network. */
  function safeFilename(name) {
    const base = String(name || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return (base || 'recipe') + '.starnet-recipe.json';
  }
  function downloadRecipeFile(obj) {
    try {
      const json = JSON.stringify(obj, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = safeFilename(obj && obj.name); a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (_) {} }, 0);
      note('exported recipe: ' + ((obj && obj.name) || 'recipe') + ' — saved to your downloads', 'good');
    } catch (_) { sfx('bad'); note('could not export the recipe file', 'bad'); }
  }
  // IMPORT: the file-picker button (in the bar) fires a hidden <input type=file>; this reads + parses + imports it.
  function wireImport(scope) {
    const sc = scope || root; if (!sc) return;
    const btn = sc.querySelector('.mkt-import'), file = sc.querySelector('#mkt-import-file');
    if (!btn || !file) return;
    btn.addEventListener('click', () => { sfx('click'); file.value = ''; file.click(); });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        let parsed = null;
        try { parsed = JSON.parse(String(reader.result || '')); }
        catch (_) { sfx('bad'); note('that file isn’t valid JSON — nothing imported', 'bad'); return; }
        if (!hasRecipes()) return;
        const res = Recipes.importRecipe(parsed);
        if (!res.ok) { sfx('bad'); note('could not import: ' + (res.error || 'malformed recipe file'), 'bad'); return; }
        // land the Commander on their freshly imported recipe (MINE view, dossier focused on it).
        focusRecipe = res.recipe.id; catFilter = 'mine'; view = 'grid';
        sfx('click'); note('imported recipe: ' + res.recipe.name + ' — it’s in YOUR RECIPES', 'good');
        renderBar(); renderStage();
      };
      reader.onerror = () => { sfx('bad'); note('could not read that file', 'bad'); };
      reader.readAsText(f);
    });
  }

  /* ---------- IMPORT AGENT — the Hermes / OpenClaw migration flow ----------
     A one-click path for a Commander arriving from OpenClaw or hermes-agent: detect installs (or pick a folder),
     preview exactly what the scan found, then RECRUIT mints a StarNet agent with the persona/orders/memory
     pre-filled. Every field shown comes straight from /api/harness/scan — nothing is invented (truthful telemetry).
     Keys are NEVER read or transferred; the preview says so and the KEYS tab is where the Commander re-enters them.
     Backend routes (built in parallel this session): POST /api/harness/detect, POST /api/harness/scan. The folder
     fallback reuses the existing POST /api/projects/pickfolder. If a route is missing the flow degrades to an honest
     empty/error state — it never fakes a detection or a scan. */
  const up = s => String(s == null ? '' : s).toUpperCase();
  // Is this scan's provider a StarNet provider id we can actually pin to? ModelDock.labels.normProvider maps every
  // known alias to its canonical id and buckets anything unknown into 'openrouter' — so 'openrouter' only counts
  // when the raw string literally names it, otherwise an unknown provider would be silently mis-pinned. Returns the
  // canonical id or null (→ no pin; the station's default model runs instead). No ModelDock → null (honest: can't verify).
  function recognizeProvider(raw) {
    const r = String(raw || '').trim().toLowerCase();
    const norm0 = (typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.normProvider) ? ModelDock.labels.normProvider : null;
    if (!r || !norm0) return null;
    const norm = norm0(r);
    if (norm === 'openrouter' && !/^open[\s_-]?router$/.test(r)) return null;
    return norm;
  }
  // the ONE pin resolver — shared by the preview and RECRUIT so the card can never claim a pin confirmImport
  // won't set. A pin exists only when the provider is recognized AND a concrete model id exists. Direct providers
  // take a BARE model id (anthropic.js passes req.model straight to the API) — only openrouter keeps the
  // 'vendor/model' slug shape, so a prefix that just restates the pinned provider is stripped.
  function importModelPin(s) {
    const m = (s && s.model) || {};
    const rec = recognizeProvider(m.provider);
    let modelId = String(m.model || m.raw || '').trim();
    if (rec && rec !== 'openrouter' && modelId.toLowerCase().indexOf(rec + '/') === 0) modelId = modelId.slice(rec.length + 1);
    return { pin: (rec && modelId) ? { model: modelId, provider: rec, effort: '' } : null, rec: rec, raw: String(m.raw || ''), provider: String(m.provider || '') };
  }
  // enter the flow: reset to the detect step and kick the machine scan.
  function enterHarnessImport() {
    view = 'harnessImport'; importStep = 'detect';
    importFound = null; importScan = null; importOrigin = null; importErr = ''; importScanning = false; importName = '';
    renderStage();
    runDetect();
  }
  function runDetect() {
    importDetecting = true;
    fetch('/api/harness/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.ok ? r.json() : { ok: false, found: [] })
      .then(d => { importDetecting = false; importFound = (d && d.ok && Array.isArray(d.found)) ? d.found : []; if (view === 'harnessImport' && importStep === 'detect') renderStage(); })
      .catch(() => { importDetecting = false; importFound = []; if (view === 'harnessImport' && importStep === 'detect') renderStage(); });
  }
  // scan a folder as each harness in `harnesses` (in order), stopping at the first ok:true. A detected row passes a
  // single known harness; PICK FOLDER passes ['openclaw','hermes'] (try both). On ok:true → preview step; on total
  // miss → the last honest reason inline.
  function scanHarness(rootPath, harnesses) {
    importScanning = true; importErr = ''; renderStage();
    let lastReason = '';
    const tryOne = i => {
      if (i >= harnesses.length) {
        importScanning = false;
        importErr = lastReason || 'no OpenClaw or Hermes agent found in that folder';
        if (view === 'harnessImport') renderStage();
        return;
      }
      fetch('/api/harness/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harness: harnesses[i], root: rootPath }) })
        .then(r => r.ok ? r.json() : { ok: false, reason: 'scan failed (http ' + r.status + ')' })
        .then(res => {
          if (res && res.ok) {
            importScanning = false; importScan = res;
            importOrigin = { harness: res.harness || harnesses[i], root: rootPath };
            importName = String(res.name || '').trim();
            importStep = 'preview';
            if (view === 'harnessImport') renderStage();
          } else { lastReason = (res && res.reason) || 'no agent found'; tryOne(i + 1); }
        })
        .catch(() => { lastReason = 'scan request failed'; tryOne(i + 1); });
    };
    tryOne(0);
  }
  // the first non-heading, non-rule line of the persona, clamped — the honest one-line "what it's for". Neutral
  // default when the persona is empty/all-headings so the agent still lands with a real (if generic) purpose.
  function derivePurpose(persona, harnessLabel) {
    const lines = String(persona || '').split(/\r?\n/);
    for (const raw of lines) {
      const t = raw.trim();
      // skip blanks, EVERY heading line (a title like "# Vex — soul" is a name, not a purpose), and rules.
      if (!t || t.charAt(0) === '#' || /^[-*=_]{2,}$/.test(t)) continue;
      let p = t.replace(/^[-*]\s+/, '').trim();
      if (!p) continue;
      if (p.length > 140) p = p.slice(0, 139).replace(/\s+\S*$/, '') + '…';
      return p;
    }
    return 'Imported from ' + up(harnessLabel) + ' — tell it what you need.';
  }
  // context.md body: the harness USER.md + the curated memory, each under a labeled header so the agent knows the
  // provenance. Only present sources are included (truthful telemetry). Scan pre-clamps every string server-side;
  // a defensive overall cap keeps a pathological payload from bloating the composed prompt.
  function buildContextDoc(s, harnessLabel) {
    const H = up(harnessLabel);
    const parts = [];
    const uc = String((s && s.userContext) || '').trim();
    const mem = String((s && s.memory && s.memory.curated) || '').trim();
    if (uc) parts.push('## From ' + H + ' USER.md\n' + uc);
    if (mem) parts.push('## Curated memory — from ' + H + '\n' + mem);
    let doc = parts.join('\n\n');
    if (doc.length > 8000) doc = doc.slice(0, 8000);
    return doc;
  }
  function harnessImportHTML() {
    return importStep === 'preview' ? harnessPreviewHTML() : harnessDetectHTML();
  }
  function harnessDetectHTML() {
    let rows;
    if (importDetecting || importFound == null) {
      rows = '<p class="mkt-hint">◌ scanning this machine for OpenClaw / Hermes installs…</p>';
    } else if ((importFound || []).length) {
      rows = importFound.map((f, i) => {
        // the backend label already reads "OpenClaw — main" / "Hermes — profile X"; fall back to the bare harness id.
        const label = up(f.label || f.harness);
        return '<button type="button" class="mkt-imp-row" data-idx="' + i + '">' +
          '<span class="mkt-imp-row-h">' + esc(label) + '</span>' +
          '<span class="mkt-imp-row-path">' + esc(f.root || '') + '</span></button>';
      }).join('');
    } else {
      rows = '<div class="mkt-empty">no Hermes or OpenClaw install detected on this machine — pick a folder to import from instead.</div>';
    }
    const pick = '<button type="button" class="mkt-imp-row mkt-imp-pick">' +
      '<span class="mkt-imp-row-h">▸ PICK FOLDER…</span>' +
      '<span class="mkt-imp-row-path">choose an OpenClaw / Hermes agent folder</span></button>';
    const scanning = importScanning ? '<p class="mkt-hint">◌ reading the agent…</p>' : '';
    const err = importErr ? '<div class="mkt-r-warn">⚠ ' + esc(importErr) + '</div>' : '';
    return '<div class="mkt-save mkt-imp">' +
      '<div class="mkt-save-h">⇪ IMPORT AGENT</div>' +
      '<p class="mkt-hint">bring an agent over from OpenClaw or Hermes — its persona, standing orders and curated memory come with it. keys never transfer.</p>' +
      '<div class="mkt-imp-rows">' + rows + pick + '</div>' +
      scanning + err +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button></div>' +
    '</div>';
  }
  function harnessPreviewHTML() {
    const s = importScan || {};
    const H = up(s.harness || (importOrigin && importOrigin.harness) || 'harness');
    const rootPath = (importOrigin && importOrigin.root) || '';
    const persona = String(s.persona || '').trim();
    const excerpt = persona
      ? esc(persona.slice(0, 400)) + (persona.length > 400 ? '…' : '')
      : '<span class="mkt-imp-dim">no persona text found</span>';
    const mem = s.memory || {};
    const memChars = String(mem.curated || '').length;
    const dailyCount = +mem.dailyCount || 0;
    const dash = '<span class="mkt-imp-dim">—</span>';
    const t = (k, v) => '<div class="mkt-imp-t"><span class="mkt-imp-t-k">' + k + '</span><span class="mkt-imp-t-v">' + v + '</span></div>';
    // MEMORY claims ONLY what actually transfers: the curated chars. Daily notes are counted, never read —
    // their bodies stay behind, so they must not sit inside a "WHAT TRANSFERS" claim (truthful telemetry);
    // they get their own explicitly-dim non-transfer note below the table instead.
    let transfers =
      t('INSTRUCTIONS', String(s.instructions || '').trim() ? 'present' : dash) +
      t('USER CONTEXT', String(s.userContext || '').trim() ? 'present' : dash) +
      t('MEMORY', memChars ? (memChars + ' chars curated') : '<span class="mkt-imp-dim">none</span>');
    // MODEL: the pin branch renders ONLY when confirmImport will actually set a pin (same importModelPin
    // resolver) — a recognized provider with no model id gets the honest no-pin line, never a dangling
    // "PROVIDER · " that implies a pin. No pin → say what we do know (raw id or provider name), dim.
    const mp = importModelPin(s);
    if (mp.pin) {
      const lbl = (typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.provider) ? ModelDock.labels.provider(mp.rec) : up(mp.rec);
      transfers += t('MODEL', esc(lbl) + ' · ' + esc(mp.pin.model));
    } else {
      const known = String(mp.raw || mp.provider || '').trim();
      transfers += t('MODEL', (known ? esc(known) + ' ' : '') + '<span class="mkt-imp-dim">— ' + (known ? 'not pinnable here' : 'none found') + '; station default model will be used</span>');
    }
    const dailyNote = dailyCount
      ? '<div class="mkt-imp-dim">' + dailyCount + ' daily note' + (dailyCount === 1 ? ' stays' : 's stay') + ' behind — not imported</div>'
      : '';
    // warnings: render every entry the scan returned verbatim, and ALWAYS state the keys-never-transfer truth
    // (added only if the scan didn't already say it).
    const warns = Array.isArray(s.warnings) ? s.warnings.slice() : [];
    if (!warns.some(w => /key/i.test(w) && /transfer/i.test(w))) warns.push('keys never transfer — re-enter them in the KEYS tab');
    const warnHTML = warns.map(w => '<div class="mkt-r-warn dim">⚠ ' + esc(w) + '</div>').join('');
    return '<div class="mkt-save mkt-imp mkt-imp-preview">' +
      '<div class="mkt-save-h">⇪ IMPORT — ' + esc(s.name || H) + '</div>' +
      '<label class="mkt-lbl">NAME<input class="mkt-in" id="mkt-imp-name" type="text" autocomplete="off" spellcheck="false" value="' + esc(importName || s.name || '') + '"></label>' +
      '<div class="mkt-imp-origin">' + esc(H) + ' · <span class="mkt-imp-row-path">' + esc(rootPath) + '</span></div>' +
      '<div class="mkt-imp-sect">PERSONA</div><div class="mkt-imp-persona">' + excerpt + '</div>' +
      '<div class="mkt-imp-sect">WHAT TRANSFERS</div><div class="mkt-imp-transfers">' + transfers + '</div>' +
      dailyNote +
      warnHTML +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-imp-recruit">▸ RECRUIT</button></div>' +
    '</div>';
  }
  function wireHarnessImport(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => {
      sfx('click');
      // preview BACK steps to detect (never discards the whole flow); detect BACK returns to the roster.
      if (importStep === 'preview') { importStep = 'detect'; importScan = null; importOrigin = null; importErr = ''; renderStage(); }
      else { view = 'grid'; renderStage(); }
    });
    stage.querySelectorAll('.mkt-imp-row[data-idx]').forEach(b => b.addEventListener('click', () => {
      const f = (importFound || [])[+b.dataset.idx]; if (!f) return;
      sfx('click'); scanHarness(f.root, [f.harness]);
    }));
    const pick = stage.querySelector('.mkt-imp-pick');
    if (pick) pick.addEventListener('click', () => {
      sfx('click'); importErr = ''; importScanning = true; renderStage();
      fetch('/api/projects/pickfolder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(r => r.ok ? r.json() : { ok: false })
        .then(d => {
          if (d && d.ok && d.path) scanHarness(d.path, ['openclaw', 'hermes']);
          else { importScanning = false; if (view === 'harnessImport') renderStage(); }   // cancelled → quietly stay on detect
        })
        .catch(() => { importScanning = false; importErr = 'could not open the folder picker'; if (view === 'harnessImport') renderStage(); });
    });
    // NAME is stateful (importName is the single source of truth): the bay's search box + FILTER chips stay live
    // during this view and each rebuilds the stage — without this write-back a rebuild would revert the field to
    // the stale value and RECRUIT would mint under the wrong name.
    const nameIn = stage.querySelector('#mkt-imp-name');
    if (nameIn) nameIn.addEventListener('input', () => { importName = nameIn.value; });
    const recruit = stage.querySelector('.mkt-imp-recruit');
    if (recruit) recruit.addEventListener('click', confirmImport);
  }
  // RECRUIT: mint the agent through the real summon seam (ctx.onPick === App.summonAgent), then write its docs
  // through the canonical dossier editor seam (App.applyConfig, exactly what the CONFIG card's Save uses —
  // recompose + persist + pushRoster). Construction-time fields (name/skin/model pin) ride the summon spec because
  // summonAgent bakes them in at creation; the markdown docs go through applyConfig on the freshly-focused new
  // agent (summon with activate:true focuses it), so we reuse the one docs write-path instead of inventing another.
  // The persona is APPENDED under a labeled header beneath the station's own baseIdentity — replacing identity
  // wholesale would strip the locked real-tools/honesty grounding, so we preserve it and add the imported voice.
  function confirmImport() {
    if (!importScan || !(ctx && ctx.onPick)) { close(); return; }
    const s = importScan;
    const harnessLabel = s.harness || (importOrigin && importOrigin.harness) || 'harness';
    // NAME comes from state, never the DOM: importName is the single source of truth (the input's 'input'
    // listener writes it back), so a stage rebuild between typing and RECRUIT can't revert the mint name.
    const editedName = String(importName || s.name || '').trim();
    const spec = {
      name: s.name || harnessLabel,
      agentName: editedName,
      skin: (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN) || undefined,
      modelPin: importModelPin(s).pin   // the SAME resolver the preview rendered — the card and the mint can't drift
    };
    sfx('click');
    const created = ctx.onPick(spec, { activate: true });
    try {
      const cur = (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null;
      if (created && cur && cur.id === created.id && typeof App !== 'undefined' && App.applyConfig) {
        const baseId = (created.docs && created.docs.identity) || '';
        const persona = String(s.persona || '').trim();
        const identity = persona ? (baseId + '\n\n## IMPORTED PERSONA — from ' + up(harnessLabel) + '\n' + persona) : baseId;
        App.applyConfig({
          identity: identity,
          manual: String(s.instructions || '').trim(),
          context: buildContextDoc(s, harnessLabel),
          purpose: derivePurpose(s.persona, harnessLabel)
        });
      }
    } catch (_) {}
    close();
  }

  /* ---------- launch a recipe ---------- */
  function recipeDefaults(r) {
    const values = {};
    (r.params || []).forEach(p => { values[p.key] = p.default || ''; });
    return values;
  }
  function launchRecipeNow(r, values) {
    const ok = !!(ctx && typeof ctx.onLaunch === 'function' && ctx.onLaunch(r, values) !== false);
    if (ok) { note('session opened: ' + r.name, 'good'); close(); }
    else { sfx('bad'); note('could not launch ' + r.name + ' — the agent is mid-run (or there was nothing to send). try again when it settles.', 'bad'); }
  }
  // the schedule string a launchCadence id maps to, plus a 'custom' free-text entry the user types (every Nh or
  // a 5-field cron). The sidecar re-validates via cron.parseSchedule, so a bad custom string is caught server-side.
  function scheduleForLaunchCadence(customStr) {
    if (launchCadence === 'custom') return String(customStr || '').trim();
    const c = cadenceOpt(launchCadence); return c ? c.schedule : '';
  }
  function launchCadenceOptionsHTML() {
    let html = CADENCE_OPTS.map(c => '<option value="' + esc(c.id) + '"' + (launchCadence === c.id ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('');
    html += '<option value="custom"' + (launchCadence === 'custom' ? ' selected' : '') + '>custom…</option>';
    return html;
  }
  /* ---------- TYPED FILL-IN CONTROLS (the launch form's inputs) ----------
     One textarea for every kind of value made the form lie about what it wanted: "point me at a file" meant
     "type an absolute path from memory", and a recipe with two sensible options gave no hint that there were
     only two. Each param now renders the control its declared type deserves. Every control still carries the
     SAME contract the collector reads — class `mkt-p-in`, a `data-key`, and a `.value` — so collectLaunchValues,
     requiredMissing and fillTask are untouched and a typed recipe launches exactly like an untyped one.
       text      textarea (unchanged)
       choice    chip row (single-select) writing through a hidden input
       file      path input + ⌸ BROWSE (native OS file chooser via POST /api/pickpath)
       folder    path input + ⌸ BROWSE (the same chooser, directory mode)
       connector one <select>, filled from the live /api/connectors list after mount (honest empty state when none) */
  const PARAM_KIND_LABEL = { choice: 'pick one', file: 'a file', folder: 'a folder', connector: 'a connected service' };
  function paramKindHTML(p) {
    const lbl = PARAM_KIND_LABEL[p && p.type];
    return lbl ? ' <span class="mkt-p-kind">' + esc(lbl) + '</span>' : '';
  }
  function paramControlHTML(p, val) {
    const key = esc(p.key), ph = esc(p.placeholder || '');
    if (p.type === 'choice' && (p.options || []).length >= 2) {
      const chips = p.options.map(o =>
        '<button type="button" class="mkt-p-chip' + (o === val ? ' sel' : '') + '" data-key="' + key + '" data-val="' + esc(o) + '">' + esc(o) + '</button>'
      ).join('');
      return '<span class="mkt-p-chips" data-key="' + key + '">' + chips + '</span>' +
        '<input type="hidden" class="mkt-p-in" data-key="' + key + '" value="' + esc(val) + '">';
    }
    if (p.type === 'file' || p.type === 'folder') {
      const what = p.type === 'file' ? 'file' : 'folder';
      return '<span class="mkt-p-path">' +
        '<input type="text" class="mkt-in mkt-p-in" data-key="' + key + '" spellcheck="false" placeholder="' + (ph || esc('the ' + what + ' path')) + '" value="' + esc(val) + '">' +
        '<button type="button" class="bb sm mkt-p-browse" data-key="' + key + '" data-mode="' + esc(p.type) + '" title="choose a ' + what + ' on this machine">⌸ BROWSE</button>' +
        '</span><span class="mkt-p-note" data-note="' + key + '">picking a ' + what + ' fills the box — nothing is read until you launch</span>';
    }
    if (p.type === 'connector') {
      return '<select class="mkt-in mkt-p-in mkt-p-conn" data-key="' + key + '" data-want="' + esc(val) + '">' +
        '<option value="">… loading your connected services</option></select>';
    }
    return '<textarea class="mkt-in mkt-p-in" data-key="' + key + '" rows="2" placeholder="' + ph + '">' + esc(val) + '</textarea>';
  }
  // fill every connector <select> from the LIVE list. Honest states: no sidecar / no connectors say so instead of
  // rendering an empty dropdown, and the field stays typable-free (a blank value just leaves the token unfilled).
  function hydrateConnectorSelects(stage, onDone) {
    const sels = stage.querySelectorAll('.mkt-p-conn'); if (!sels.length) return;
    const done = () => { if (typeof onDone === 'function') onDone(); };
    const paint = (opts, note) => {
      sels.forEach(sel => {
        const want = sel.dataset.want || '';
        sel.innerHTML = (note ? '<option value="">' + esc(note) + '</option>' : '<option value="">— pick a service —</option>') +
          opts.map(c => '<option value="' + esc(c.id) + '"' + (c.id === want ? ' selected' : '') + '>' + esc(c.label || c.id) + '</option>').join('');
      });
      done();
    };
    if (typeof fetch === 'undefined') return paint([], 'no station — type the service name in the directive instead');
    fetch('/api/connectors', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => {
      const list = (j && j.connectors) || [];
      if (!list.length) return paint([], 'no connected services yet — add one in ⇄ ABILITIES');
      paint(list.map(c => ({ id: c.id, label: c.label || c.id })), '');
    }).catch(() => paint([], 'could not reach the station'));
  }
  // the native chooser behind ⌸ BROWSE. Cancel is silent; a real failure explains itself and leaves the typed
  // path alone (the honest fallback everywhere in this app is "type it yourself").
  function browseForPath(mode, onPicked) {
    if (typeof fetch === 'undefined') { note('no station — type the path instead', 'bad'); return; }
    fetch('/api/pickpath', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: mode }) })
      .then(res => res.json().then(j => ({ ok: res.ok, j })).catch(() => ({ ok: false, j: null })))
      .then(({ ok, j }) => {
        if (ok && j && j.ok && j.path) { onPicked(String(j.path)); sfx('click'); return; }
        if (ok && j && j.ok && j.cancelled) return;                       // a cancel is not an error
        note((j && j.reason) || 'no picker available — type the path instead', 'bad');
      })
      .catch(() => note('could not reach the station', 'bad'));
  }

  function launchFormHTML() {
    const r = launchId && hasRecipes() ? Recipes.get(launchId) : null;
    if (!r) { view = 'grid'; return '<div class="mkt-roster">' + rosterHTML() + '</div>'; }
    const who = (ctx && ctx.agentName) || 'your agent';
    // lane C: prefill each field with the value this recipe launched with LAST time (LaunchMemory, own local key).
    // Confirm-by-sight safety: the values sit visibly in the form and nothing runs until the button — plus the
    // hint below names the mechanism. esc() covers the content (U.esc escapes & < > " ', so </textarea> can't break out).
    // CONTEXT BEATS MEMORY: a value the station just derived from a granted project root is fresher and more
    // specific than whatever this recipe was launched with last time, so the READY shelf's binding wins. Both
    // are visible in the form and nothing runs until the button — the confirm-by-sight safety is unchanged.
    const seedVals = (readySeeds && readySeeds[r.id]) ? readySeeds[r.id] : {};
    const lastVals = Object.assign({}, (typeof LaunchMemory !== 'undefined' && LaunchMemory.get) ? (LaunchMemory.get(r.id) || {}) : {}, seedVals);
    let prefilled = false;
    const fields = (r.params || []).map(p => {
      const val = (typeof lastVals[p.key] === 'string' && lastVals[p.key].trim()) ? lastVals[p.key] : (p.default || '');
      if (val && lastVals[p.key]) prefilled = true;
      // label text and its required/optional marker share ONE row: .mkt-lbl is a flex column, so an unwrapped
      // marker becomes its own orphan line under the label ("Topic" / "*" stacked).
      return '<label class="mkt-lbl mkt-p-lbl" data-type="' + esc(p.type || 'text') + '">' +
        '<span class="mkt-p-lbl-t">' + esc(p.label) +
          (p.required ? ' <span class="mkt-req" title="required">*</span>' : ' <span class="mkt-opt">(optional)</span>') +
        '</span>' + paramControlHTML(p, val) + '</label>';
    }).join('');
    const prefillHint = prefilled ? '<p class="mkt-hint mkt-prefill-hint">↺ using your last inputs — edit anything before you run</p>' : '';
    // TASK BRIEF v2 intake: the recipe's declared material decisions as one-tap chip rows. The recommended
    // option starts selected (★, gold); "agent decides" opts out — the run then resolves or asks per the
    // task-context doctrine. Answers ride the composed directive (Recipes.fillTask values.__intake).
    const intakeRows = (r.intake || []).map(e =>
      '<div class="mkt-intake" data-dim="' + esc(e.dimension) + '"><div class="mkt-lbl">' + esc(e.question) +
        (e.reason ? ' <span class="mkt-lbl-hint">— ' + esc(e.reason) + '</span>' : '') + '</div>' +
        '<div class="mkt-intake-opts">' +
          e.options.map(o => '<button type="button" class="mkt-intake-opt' + (o === e.recommended ? ' sel rec' : '') + '" data-val="' + esc(o) + '">' + (o === e.recommended ? '★ ' : '') + esc(o) + '</button>').join('') +
          '<button type="button" class="mkt-intake-opt mkt-intake-skip" data-val="">agent decides</button>' +
        '</div></div>'
    ).join('');
    // MAKE ROUTINE panel — revealed when launchMode==='routine'. Cadence defaults to the recipe's suggested one.
    const outbound = hasRecipes() && Recipes.impliesOutbound(r);
    const warnLine = outbound
      ? '<div class="mkt-r-warn">⚠ this routine runs UNATTENDED. its directive looks like it may SEND or WRITE something — while you’re away it can only reason &amp; draft, so it will leave the result on the desk, not actually send. (a heads-up, not a block.)</div>'
      : '';
    const armNote = (cronJobs != null && !cronArmed)
      ? '<div class="mkt-r-warn dim">◷ scheduling is currently OFF — your routine is saved but dormant until you enable the scheduler in ROUTINES.</div>' : '';
    const routinePanel = (launchMode === 'routine')
      ? '<div class="mkt-r-routine">' +
          '<label class="mkt-lbl">CADENCE<select class="mkt-in" id="mkt-l-cad">' + launchCadenceOptionsHTML() + '</select></label>' +
          '<label class="mkt-lbl mkt-l-custom" id="mkt-l-custom-wrap"' + (launchCadence === 'custom' ? '' : ' hidden') + '>CUSTOM SCHEDULE ' +
            '<span class="mkt-lbl-hint">— “every 6h”, “in 2h”, or a 5-field cron “0 9 * * 1”</span>' +
            '<input class="mkt-in" id="mkt-l-custom" placeholder="every 6h"></label>' +
          '<div class="mkt-r-pv" id="mkt-l-pv"></div>' +
          warnLine + armNote +
        '</div>' : '';
    // the action row switches on the mode: RUN NOW + MAKE ROUTINE side by side; in routine mode a CONFIRM button.
    const acts = (launchMode === 'routine')
      ? '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
          '<button class="bb sm mkt-launch-run-alt">▸ RUN NOW INSTEAD</button>' +
          '<button class="bb sm mkt-do-routine">◷ SCHEDULE IT</button></div>'
      : '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
          '<button class="bb sm mkt-do-launch">▸ START SESSION</button>' +
          '<button class="bb sm mkt-do-makeroutine" title="puts this recipe on a schedule — it becomes a ROUTINE you can manage in ⏱ ROUTINES">◷ MAKE ROUTINE</button></div>';
    const modeNote = (launchMode === 'routine')
      ? '◷ fills the blanks ONCE, then runs the same directive on your chosen cadence as <b>' + esc(who) + '</b> — it becomes a ROUTINE (manage or stop it any time in ⏱ ROUTINES).'
      : '▸ opens a new session and starts this workflow with <b>' + esc(who) + '</b>.';
    /* WHAT GETS SENT — the filled directive, live. The dossier shows the raw template with its {tokens}; the last
       thing the Commander saw before committing used to be a form full of blanks, so the actual instruction the
       agent receives was never visible anywhere. This renders the REAL output of Recipes.fillTask against the
       values in the form right now (including the intake decisions appended at the bottom), refreshed on every
       keystroke and chip tap — the same primitive the launch itself calls, so it cannot drift from what runs. */
    const preview = '<div class="mkt-r-pv-wrap' + (launchPreviewOpen ? ' open' : '') + '">' +
      '<button type="button" class="mkt-r-pv-head" aria-expanded="' + (launchPreviewOpen ? 'true' : 'false') + '">' +
        '<span class="mkt-r-pv-caret" aria-hidden="true">' + (launchPreviewOpen ? '▾' : '▸') + '</span>' +
        '<span class="mkt-r-pv-ttl">WHAT GETS SENT</span>' +
        '<span class="mkt-r-pv-sub">the exact directive ' + esc(who) + ' receives</span>' +
      '</button>' +
      (launchPreviewOpen ? '<pre class="mkt-r-pv-body" id="mkt-l-preview"></pre>' : '') +
    '</div>';
    return '<div class="mkt-save mkt-launch-form">' +
      '<div class="mkt-save-h">' + esc((launchMode === 'routine' ? '◷ MAKE ROUTINE — ' : '▸ LAUNCH — ') + r.name) + '</div>' +
      '<p class="mkt-hint">' + esc(r.blurb || r.tagline) + '</p>' +
      (fields || '<p class="mkt-hint">this recipe needs no setup — just launch it.</p>') +
      intakeRows +
      prefillHint +
      preview +
      routinePanel +
      '<p class="mkt-launch-note">' + modeNote + '</p>' +
      acts + '</div>';
  }
  // gather + validate the param values from the launch form; returns { values } or null (with UI feedback) if a
  // required field is blank. Shared by RUN NOW and MAKE ROUTINE (both fill the same params, once).
  function collectLaunchValues(stage, r) {
    const values = {};
    stage.querySelectorAll('.mkt-p-in').forEach(inp => { values[inp.dataset.key] = inp.value; });
    // TASK BRIEF v2: fold the tapped intake decisions in (dimension -> answer). "agent decides" contributes
    // nothing — an unanswered material decision is the run's to resolve, never a fabricated choice.
    const intake = {};
    stage.querySelectorAll('.mkt-intake').forEach(rowEl => {
      const sel = rowEl.querySelector('.mkt-intake-opt.sel');
      const val = sel ? String(sel.dataset.val || '').trim() : '';
      if (val && rowEl.dataset.dim) intake[rowEl.dataset.dim] = val;
    });
    if (Object.keys(intake).length) values.__intake = intake;
    const missing = Recipes.requiredMissing(r, values);
    if (missing.length) {
      sfx('bad');
      // mark what the Commander can SEE: a choice row's carrier input is hidden, so redden its chip row instead
      // (a red outline on a display:none input is an invisible error, and focusing it does nothing at all).
      missing.forEach(k => {
        const f = stage.querySelector('.mkt-p-in[data-key="' + k + '"]');
        const chips = stage.querySelector('.mkt-p-chips[data-key="' + k + '"]');
        if (chips) chips.classList.add('mkt-bad'); else if (f) f.classList.add('mkt-bad');
      });
      const focusable = stage.querySelector('textarea.mkt-p-in[data-key="' + missing[0] + '"], input[type="text"].mkt-p-in[data-key="' + missing[0] + '"], select.mkt-p-in[data-key="' + missing[0] + '"]') ||
        stage.querySelector('.mkt-p-chips[data-key="' + missing[0] + '"] .mkt-p-chip');
      if (focusable) focusable.focus();
      note('fill in: ' + missing.join(', '), 'bad'); return null;
    }
    return values;
  }
  function wireLaunchForm(stage, inlineRecipe) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; launchId = null; launchMode = 'run'; renderStage(); });

    /* the live "WHAT GETS SENT" preview: recompose through the REAL launch primitive on every edit. Values are
       read exactly the way collectLaunchValues reads them (minus its blank-field gate), so what is shown here is
       literally what RUN NOW would send — an empty required field just leaves its {token} visible. */
    const previewEl = () => stage.querySelector('#mkt-l-preview');
    const paintPreview = () => {
      const el = previewEl(); if (!el) return;
      const r = inlineRecipe || (launchId && hasRecipes() ? Recipes.get(launchId) : null); if (!r) return;
      const values = {};
      stage.querySelectorAll('.mkt-p-in').forEach(inp => { values[inp.dataset.key] = inp.value; });
      const intake = {};
      stage.querySelectorAll('.mkt-intake').forEach(rowEl => {
        const sel = rowEl.querySelector('.mkt-intake-opt.sel');
        const val = sel ? String(sel.dataset.val || '').trim() : '';
        if (val && rowEl.dataset.dim) intake[rowEl.dataset.dim] = val;
      });
      if (Object.keys(intake).length) values.__intake = intake;
      // an unfilled required blank shows as [Its Label], never as a closed-up sentence. fillTask deliberately
      // swallows a gone token and tidies the gap — right for a launch, wrong for a preview, where it would read
      // as a complete instruction that silently lost its subject ("Review adversarially — …" with no target).
      // Same [Label] convention the recipe EDITOR's preview uses, so both previews speak one language.
      const missing = Recipes.requiredMissing(r, values);
      const shown = Object.assign({}, values);
      (r.params || []).forEach(p => { if (missing.indexOf(p.key) >= 0) shown[p.key] = '[' + (p.label || p.key) + ']'; });
      el.textContent = Recipes.fillTask(r, shown) || '';
      el.classList.toggle('has-blanks', missing.length > 0);
    };
    const pvHead = stage.querySelector('.mkt-r-pv-head');
    if (pvHead) pvHead.addEventListener('click', () => { launchPreviewOpen = !launchPreviewOpen; sfx('click'); renderStage(); });

    stage.querySelectorAll('.mkt-p-in').forEach(inp => inp.addEventListener('input', () => { inp.classList.remove('mkt-bad'); paintPreview(); }));
    stage.querySelectorAll('select.mkt-p-in').forEach(sel => sel.addEventListener('change', paintPreview));
    // CHOICE chips: single-select per row, writing through the hidden input the collector reads.
    stage.querySelectorAll('.mkt-p-chips').forEach(rowEl => {
      rowEl.querySelectorAll('.mkt-p-chip').forEach(btn => btn.addEventListener('click', () => {
        const hidden = stage.querySelector('input.mkt-p-in[data-key="' + btn.dataset.key + '"]');
        const already = btn.classList.contains('sel');
        rowEl.querySelectorAll('.mkt-p-chip').forEach(b => b.classList.remove('sel'));
        if (!already) { btn.classList.add('sel'); if (hidden) hidden.value = btn.dataset.val || ''; }
        else if (hidden) hidden.value = '';                   // tapping the selected chip clears it
        rowEl.classList.remove('mkt-bad');
        sfx('click'); paintPreview();
      }));
    });
    // ⌸ BROWSE: the native OS chooser fills the path box (and nothing else happens until launch).
    stage.querySelectorAll('.mkt-p-browse').forEach(btn => btn.addEventListener('click', () => {
      const field = stage.querySelector('input.mkt-p-in[data-key="' + btn.dataset.key + '"]');
      btn.disabled = true;
      const done = () => { btn.disabled = false; };
      browseForPath(btn.dataset.mode === 'file' ? 'file' : 'folder', (picked) => {
        if (field) { field.value = picked; field.classList.remove('mkt-bad'); }
        paintPreview();
      });
      // the dialog resolves on the user's clock; re-enable on the next tick either way (single-flight is server-side).
      setTimeout(done, 400);
    }));
    hydrateConnectorSelects(stage, paintPreview);

    // TASK BRIEF v2 intake chips: single-select per decision row (tap toggles which chip holds .sel).
    stage.querySelectorAll('.mkt-intake').forEach(rowEl => {
      rowEl.querySelectorAll('.mkt-intake-opt').forEach(btn => btn.addEventListener('click', () => {
        rowEl.querySelectorAll('.mkt-intake-opt').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel'); sfx('click'); paintPreview();
      }));
    });
    paintPreview();

    // RUN NOW (from run mode) — the existing path, unchanged.
    const go = stage.querySelector('.mkt-do-launch');
    if (go) go.addEventListener('click', () => {
      const r = inlineRecipe || (launchId && hasRecipes() ? Recipes.get(launchId) : null);
      if (!r) { view = 'grid'; launchId = null; renderStage(); return; }
      const values = collectLaunchValues(stage, r); if (!values) return;
      try { if (typeof LaunchMemory !== 'undefined' && LaunchMemory.save) LaunchMemory.save(r.id, values); } catch (_) {}   // lane C: remember what launched
      launchId = null; launchMode = 'run'; launchRecipeNow(r, values);
    });
    // MAKE ROUTINE — reveal the cadence panel (default to the recipe's suggested cadence, else morning).
    const mkRoutine = stage.querySelector('.mkt-do-makeroutine');
    if (mkRoutine) mkRoutine.addEventListener('click', () => {
      const r = inlineRecipe || (launchId && hasRecipes() ? Recipes.get(launchId) : null); if (!r) return;
      // validate the params up front so scheduling can't proceed with a blank required fill-in.
      if (!collectLaunchValues(stage, r)) return;
      launchMode = 'routine';
      launchCadence = (r.cadence && cadenceOpt(r.cadence)) ? r.cadence : 'morning';
      loadCronJobs().then(() => { if (view === 'launch') renderStage(); });   // refresh armed-state note
      sfx('click'); renderStage();
    });
    // RUN NOW INSTEAD (from routine mode) — flip back and run.
    const runAlt = stage.querySelector('.mkt-launch-run-alt');
    if (runAlt) runAlt.addEventListener('click', () => {
      const r = inlineRecipe || (launchId && hasRecipes() ? Recipes.get(launchId) : null); if (!r) return;
      const values = collectLaunchValues(stage, r); if (!values) return;
      try { if (typeof LaunchMemory !== 'undefined' && LaunchMemory.save) LaunchMemory.save(r.id, values); } catch (_) {}   // lane C: remember what launched
      launchId = null; launchMode = 'run'; launchRecipeNow(r, values);
    });

    // cadence picker + custom-schedule reveal + a live preview of the next fires (via /api/cron/preview).
    const cadSel = stage.querySelector('#mkt-l-cad');
    const customWrap = stage.querySelector('#mkt-l-custom-wrap'), customIn = stage.querySelector('#mkt-l-custom'), pv = stage.querySelector('#mkt-l-pv');
    let pvTimer = null;
    const paintSchedPreview = () => {
      if (!pv) return;
      const sched = scheduleForLaunchCadence(customIn && customIn.value);
      if (!sched) { pv.textContent = ''; return; }
      clearTimeout(pvTimer);
      pvTimer = setTimeout(() => {
        fetch('/api/cron/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: sched }) })
          .then(r => r.ok ? r.json() : null).then(d => {
            if (!pv) return;
            if (d && d.ok) pv.textContent = '✓ ' + (d.display || sched);
            else pv.innerHTML = '<span class="mkt-r-warn-inline">' + esc((d && d.error) || 'unrecognized schedule') + '</span>';
          }).catch(() => {});
      }, 250);
    };
    if (cadSel) cadSel.addEventListener('change', () => {
      launchCadence = cadSel.value || 'morning';
      if (customWrap) customWrap.hidden = (launchCadence !== 'custom');
      sfx('click'); paintSchedPreview();
    });
    if (customIn) customIn.addEventListener('input', paintSchedPreview);
    if (launchMode === 'routine') paintSchedPreview();

    // SCHEDULE IT — fill the params ONCE, convert cadence → schedule, POST /api/cron with meta.recipeId.
    const doRoutine = stage.querySelector('.mkt-do-routine');
    if (doRoutine) doRoutine.addEventListener('click', () => {
      const r = inlineRecipe || (launchId && hasRecipes() ? Recipes.get(launchId) : null); if (!r) return;
      const values = collectLaunchValues(stage, r); if (!values) return;
      try { if (typeof LaunchMemory !== 'undefined' && LaunchMemory.save) LaunchMemory.save(r.id, values); } catch (_) {}   // lane C: remember what scheduled
      const schedule = scheduleForLaunchCadence(customIn && customIn.value);
      if (!schedule) { sfx('bad'); note('pick a cadence (or type a custom schedule)', 'bad'); if (customIn) customIn.focus(); return; }
      makeRoutine(r, values, schedule);
    });

    // focus the first control the Commander can actually type in — a choice row's carrier input is hidden, so
    // reaching for `.mkt-p-in` blindly would focus nothing and leave the form feeling dead on open.
    const first = stage.querySelector('textarea.mkt-p-in, input[type="text"].mkt-p-in, select.mkt-p-in') ||
      stage.querySelector('.mkt-p-chip');
    if (first) first.focus();
  }
  // POST /api/cron for MAKE ROUTINE. The filled directive is the routine's prompt (params filled ONCE, now); the
  // meta.recipeId stamps provenance so the ROUTINES console + the recipe dossier can both show the link. The agentId
  // targets the current run's agent (ctx.agentId) if the host handed one, else the default 'agent'.
  function makeRoutine(r, values, schedule) {
    const prompt = Recipes.fillTask(r, values);
    if (!prompt) { sfx('bad'); note('nothing to schedule — the directive is empty', 'bad'); return; }
    const agentId = (ctx && ctx.agentId) || 'agent';
    const body = {
      name: r.name, prompt, schedule, agentId,
      enabled: true, deliver: 'local', repeat: { times: null },
      meta: { recipeId: r.id }
    };
    // SOP recipes: the acceptance contract rides the routine's meta bag (additive provenance) so every scheduled
    // tick is held to the same host-checked postconditions as an interactive launch (cron-driver passes it through).
    const pcs = Recipes.postconditionsFor ? Recipes.postconditionsFor(r, values) : null;
    if (pcs) body.meta.postconditions = pcs;
    const btn = root && root.querySelector('.mkt-do-routine'); if (btn) { btn.disabled = true; btn.textContent = '… scheduling'; }
    fetch('/api/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(res => res.json().catch(() => ({})).then(d => ({ ok: res.ok, d })))
      .then(({ ok, d }) => {
        if (!ok || (d && d.error)) { sfx('bad'); note((d && d.error) || 'could not schedule the routine', 'bad'); if (btn) { btn.disabled = false; btn.textContent = '◷ SCHEDULE IT'; } return; }
        // the mint gate's refusals are 200s with NO error key — treating them as success said "scheduled"
        // about a routine the server refused to create (declined name) or silently swapped for an old one
        // (near-duplicate). Same fix as the AUTOMATION window.
        if (d && d.declined) { sfx('bad'); note(d.message || 'this routine name was deleted before — pick a different name', 'bad'); if (btn) { btn.disabled = false; btn.textContent = '◷ SCHEDULE IT'; } return; }
        if (d && d.duplicate) { sfx('bad'); note('a similar routine already exists' + (d.job && d.job.name ? (': "' + d.job.name + '"') : '') + ' — nothing new was created', 'warn'); if (btn) { btn.disabled = false; btn.textContent = '◷ SCHEDULE IT'; } return; }
        cronJobs = null;   // invalidate the cache so the dossier's live-routine badge refreshes
        sfx('click');
        note('routine scheduled: ' + r.name + ' — ' + cadenceLabel(launchCadence === 'custom' ? null : launchCadence).replace('one-shot', 'on your schedule') + '. find it in ROUTINES.', 'good');
        launchId = null; launchMode = 'run'; close();
      })
      .catch(() => { sfx('bad'); note('could not reach the scheduler', 'bad'); if (btn) { btn.disabled = false; btn.textContent = '◷ SCHEDULE IT'; } });
  }

  /* ---------- the unified recipe editor (R2) ----------
     ONE editor component, three entry points: a blank CREATE (＋ SAVE A RECIPE), a mint REVIEW (from a SUGGESTED
     card), and a TWEAK/fork or EDIT (from a dossier). Every path seeds the shared editor state via enterRecipeEditor
     so the form opens fully populated — name/emoji/params/task/gear/cadence/category. Save mints a custom recipe;
     a fork carries source:'fork' + forkedFrom. Builtins are never mutated (a TWEAK forks; only a custom EDITs in place). */

  // seed the editor's working state from a recipe (or a plain draft), then switch to the editor view. `mode`:
  //   'create' — blank/new custom;  'edit' — upsert an existing custom (editingRecipeId set);
  //   'fork'   — a NEW custom pre-filled from `seed` (a Recipes.forkFrom draft; editingRecipeId stays null).
  // `seed` is the recipe/draft to prefill from (null for a truly blank create).
  function enterRecipeEditor(seed, mode, editId) {
    seed = seed || {};
    editingRecipeId = (mode === 'edit') ? (editId || null) : null;
    editForkedFrom = (mode === 'fork') ? (seed.forkedFrom || null) : (seed.forkedFrom || null);
    editGear = Array.isArray(seed.gear) ? seed.gear.slice() : [];
    editCadence = seed.cadence || null;
    // map any legacy/raw category onto a rail bucket so the CATEGORY <select> (developer/research/creator/ops/
    // general) always has a matching option selected; unknown → general.
    // FIX (2026-08-22): `CAT_TO_RAIL` moved into recipes.js on 2026-08-04 (971d475e8) and this one reference was
    // left behind — every EDIT / TWEAK / bottle of a categorized recipe threw a ReferenceError and the editor never
    // opened. Fold through the same delegate the rail uses.
    editCategory = (seed.category && railBucket(seed)) || 'general';
    // R5 bottled-run provenance: a mintFromRun proposal carries sourceRunId; carry it through save. Every other
    // entry (blank create / tweak / import) has none → null. An EDIT preserves whatever the saved record had.
    editSourceRunId = (seed.sourceRunId != null) ? String(seed.sourceRunId) : null;
    // params: plain, editable copies ({key,label,placeholder,required}). A blank create starts with none — the
    // author writes {tokens} and the param rows are derived on save (paramsFromTemplate) if they leave them empty.
    editParams = (Array.isArray(seed.params) ? seed.params : []).map(p => ({
      key: p.key || '', label: p.label || '', placeholder: p.placeholder || '', required: p.required !== false,
      // typed fill-ins carry through every editor entry (create / tweak / edit / bottle / scout draft). `options`
      // lives as the raw comma line the author types; normParamOptions splits + cleans it on save.
      type: p.type || 'text', options: (Array.isArray(p.options) ? p.options : []).join(', ')
    }));
    // SOP fields: plain editable copies (a blank create starts with none).
    editSteps = (Array.isArray(seed.steps) ? seed.steps : []).map(x => String(x || ''));
    editAcceptance = (Array.isArray(seed.acceptance) ? seed.acceptance : []).map(a => ({
      type: (a && a.type) || 'artifact_exists', path: (a && a.path) || '', text: (a && a.text) || '', sha256: (a && a.sha256) || '', command: (a && a.command) || '',
      // connector read-back fields; args live as the raw JSON text the author types (normAcceptance parses on save)
      connector: (a && a.connector) || '', tool: (a && a.tool) || '', args: (a && a.args) ? (typeof a.args === 'string' ? a.args : JSON.stringify(a.args)) : '', contains: (a && a.contains) || ''
    }));
    view = 'recipesave'; renderStage();
  }

  function recipeTokenHint(task) {
    if (!hasRecipes()) return '';
    const ps = Recipes.paramsFromTemplate(task);
    if (!ps.length) return '<span class="mkt-r-tok-none">◷ one-tap recipe — no fill-ins</span>';
    return '<span class="mkt-r-tok-lbl">asks for</span> ' + ps.map(p => '<span class="mkt-r-tok">' + esc(p.label) + '</span>').join(' ');
  }
  function gearPickHTML() {
    return RECIPE_GEAR_PICK.map(t => {
      const on = editGear.indexOf(t) >= 0;
      return '<button type="button" class="mkt-chip pick' + (on ? ' sel' : '') + '" data-gear="' + esc(t) + '" ' +
        'title="' + esc(capGrant(t)) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(kitPropLabel(t)) + '</button>';
    }).join('');
  }
  function catSelectHTML() {
    return RECIPE_CATEGORIES.map(c => '<option value="' + esc(c) + '"' + (editCategory === c ? ' selected' : '') + '>' + esc(CAT_LABEL[c] || c) + '</option>').join('');
  }
  function cadSelectHTML() {
    let html = '<option value=""' + (!editCadence ? ' selected' : '') + '>one-shot — no suggested cadence</option>';
    html += CADENCE_OPTS.map(c => '<option value="' + esc(c.id) + '"' + (editCadence === c.id ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('');
    return html;
  }
  // the KIND of control a fill-in gets at launch (recipes.js PARAM_TYPES). Authoring it here is what lets a
  // recipe ask for a file with a real chooser instead of hoping the Commander types a path correctly.
  const PARAM_TYPE_OPTS = [
    { id: 'text', label: 'text' },
    { id: 'choice', label: 'pick one' },
    { id: 'file', label: 'a file' },
    { id: 'folder', label: 'a folder' },
    { id: 'connector', label: 'a service' }
  ];
  // one editable param row: key + label + hint/options + type + required toggle + remove. Keys are the {tokens}
  // in the directive; the live preview keys off them. An empty grid means "derive from the template on save".
  // A 'choice' row swaps its hint box for the OPTIONS line (comma-separated) — the two never both apply.
  function paramRowHTML(p, i) {
    const type = p.type || 'text';
    const isChoice = type === 'choice';
    return '<div class="mkt-r-prow" data-i="' + i + '" data-type="' + esc(type) + '">' +
      '<input class="mkt-in mkt-r-pkey" data-i="' + i + '" maxlength="24" value="' + esc(p.key || '') + '" placeholder="key (e.g. topic)" aria-label="param key">' +
      '<input class="mkt-in mkt-r-plabel" data-i="' + i + '" maxlength="32" value="' + esc(p.label || '') + '" placeholder="label (optional)" aria-label="param label">' +
      (isChoice
        ? '<input class="mkt-in mkt-r-popts" data-i="' + i + '" maxlength="180" value="' + esc(p.options || '') + '" placeholder="options, comma separated" aria-label="choice options">'
        : '<input class="mkt-in mkt-r-pph" data-i="' + i + '" maxlength="48" value="' + esc(p.placeholder || '') + '" placeholder="hint (optional)" aria-label="param placeholder">') +
      '<select class="mkt-in mkt-r-ptype" data-i="' + i + '" aria-label="what kind of value">' +
        PARAM_TYPE_OPTS.map(t => '<option value="' + esc(t.id) + '"' + (type === t.id ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('') +
      '</select>' +
      '<label class="mkt-r-preq" title="required at launch"><input type="checkbox" class="mkt-r-preq-cb" data-i="' + i + '"' + (p.required ? ' checked' : '') + '> req</label>' +
      '<button type="button" class="bb xs danger mkt-r-prm" data-i="' + i + '" aria-label="remove param">✕</button>' +
      '</div>';
  }
  function paramsGridHTML() {
    const rows = editParams.map(paramRowHTML).join('');
    return '<div class="mkt-r-params" id="mkt-r-params">' + rows + '</div>' +
      '<button type="button" class="bb xs mkt-r-padd">＋ ADD FILL-IN</button>' +
      '<span class="mkt-hint mkt-r-phint"> — or leave empty and STARNET derives them from the {tokens} in your directive.</span>';
  }
  // SOP acceptance rows: one typed check per row. The TYPE picks which second box applies (path / command) and
  // whether a third (text / sha256) exists — the same swap-a-box discipline the fill-in grid uses for 'pick one'.
  const ACC_TYPE_OPTS = [
    { id: 'artifact_exists', label: 'file exists' },
    { id: 'artifact_contains', label: 'file contains text' },
    { id: 'artifact_sha256', label: 'file sha256 =' },
    { id: 'verification_passed', label: 'check command passes' },
    { id: 'connector_readback', label: 'connector shows (host re-reads)' }
  ];
  function acceptRowHTML(a, i) {
    const type = a.type || 'artifact_exists';
    const isCmd = type === 'verification_passed';
    const isRb = type === 'connector_readback';
    if (isRb) {
      // connector read-back: connector id + READ tool + optional args JSON + the text the read must show. The
      // host refuses a non-read tool at run end, so the hint says READ up front.
      return '<div class="mkt-r-prow mkt-r-arow" data-i="' + i + '" data-type="' + esc(type) + '">' +
        '<select class="mkt-in mkt-r-atype" data-i="' + i + '" aria-label="check type">' +
          ACC_TYPE_OPTS.map(t => '<option value="' + esc(t.id) + '"' + (type === t.id ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('') +
        '</select>' +
        '<input class="mkt-in mkt-r-aconn" data-i="' + i + '" maxlength="80" value="' + esc(a.connector || '') + '" placeholder="connector id, e.g. gmail" aria-label="connector id">' +
        '<input class="mkt-in mkt-r-atool" data-i="' + i + '" maxlength="80" value="' + esc(a.tool || '') + '" placeholder="READ tool, e.g. search_messages" aria-label="read tool">' +
        '<input class="mkt-in mkt-r-aargs mkt-grow" data-i="' + i + '" maxlength="2000" value="' + esc(a.args || '') + '" placeholder="args JSON, e.g. {&quot;q&quot;:&quot;{client} invoice&quot;}" aria-label="read args">' +
        '<input class="mkt-in mkt-r-atext mkt-grow" data-i="' + i + '" maxlength="500" value="' + esc(a.contains || '') + '" placeholder="the read must show this text" aria-label="expected text">' +
        '<button type="button" class="bb xs danger mkt-r-arm" data-i="' + i + '" aria-label="remove check">✕</button>' +
        '</div>';
    }
    return '<div class="mkt-r-prow mkt-r-arow" data-i="' + i + '" data-type="' + esc(type) + '">' +
      '<select class="mkt-in mkt-r-atype" data-i="' + i + '" aria-label="check type">' +
        ACC_TYPE_OPTS.map(t => '<option value="' + esc(t.id) + '"' + (type === t.id ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('') +
      '</select>' +
      (isCmd
        ? '<input class="mkt-in mkt-r-acmd mkt-grow" data-i="' + i + '" maxlength="1000" value="' + esc(a.command || '') + '" placeholder="exact command, e.g. npm test" aria-label="check command">'
        : '<input class="mkt-in mkt-r-apath mkt-grow" data-i="' + i + '" maxlength="260" value="' + esc(a.path || '') + '" placeholder="workspace path, e.g. out/{client}-invoice.md" aria-label="artifact path">') +
      (type === 'artifact_contains'
        ? '<input class="mkt-in mkt-r-atext mkt-grow" data-i="' + i + '" maxlength="500" value="' + esc(a.text || '') + '" placeholder="must contain this text" aria-label="required text">' : '') +
      (type === 'artifact_sha256'
        ? '<input class="mkt-in mkt-r-asha mkt-grow" data-i="' + i + '" maxlength="64" value="' + esc(a.sha256 || '') + '" placeholder="64-hex digest (or a {token})" aria-label="sha256">' : '') +
      '<button type="button" class="bb xs danger mkt-r-arm" data-i="' + i + '" aria-label="remove check">✕</button>' +
      '</div>';
  }
  function acceptGridHTML() {
    return '<div class="mkt-r-params" id="mkt-r-accept">' + editAcceptance.map(acceptRowHTML).join('') + '</div>' +
      '<button type="button" class="bb xs mkt-r-aadd">＋ ADD CHECK</button>' +
      '<span class="mkt-hint mkt-r-phint"> — mechanical, host-checked at run end; paths are relative to the workspace and may use {tokens}.</span>';
  }
  function recipeSaveFormHTML() {
    const editing = editingRecipeId && hasRecipes() ? Recipes.get(editingRecipeId) : null;
    const minting = !editing && !!pendingMintTemplate;
    const scouting = !editing && !minting && !!scoutSeedDraft;   // a SCOUT draft: the whole form pre-fills from it
    const forking = !editing && !!editForkedFrom;
    const parent = forking && hasRecipes() ? Recipes.get(editForkedFrom) : null;
    const d = editing || (scouting ? scoutSeedDraft : null) || { emoji: '✦', name: '', tagline: '', task: '' };
    const title = editing ? 'EDIT RECIPE' : forking ? 'TWEAK RECIPE' : minting ? 'SAVE THIS AS A RECIPE' : scouting ? 'REVIEW THE STATION’S DRAFT' : 'SAVE A RECIPE';
    const intro = forking
      ? 'a copy of <b>' + esc((parent && parent.name) || 'the recipe') + '</b> — yours to change. adjust the wording, the fill-ins, the gear or cadence, then save it as your own. the original stays put.'
      : minting
      ? 'you’ve done this a few times — saving it makes it a one-tap recipe you own. Tweak the wording, wrap any blanks in <b>{braces}</b>, then save.'
      : scouting
      ? 'the station drafted this from your observed work — review it, change anything, and save to make it yours. Nothing is added without this save.'
      : 'write the directive your agent should run. Wrap each blank in <b>{braces}</b> — “Brief me on <b>{topic}</b>” — and it becomes a fill-in at launch.';
    // when the form is (re)rendered we read the CURRENT working state (editGear/editCadence/... survive across
    // re-renders); name/emoji/tagline/task come from the DOM on save, but seed from `d` here on first paint.
    // For a fork/mint the seed came through enterRecipeEditor; for edit, from `d`. We keep the name/task in the
    // inputs (not editParams) — editParams is only the fill-in grid.
    const seedName = forking && parent ? ((parent.name || 'Recipe') + ' (my version)') : (d.name || '');
    const seedEmoji = (forking && parent ? parent.emoji : d.emoji) || '✦';
    const seedTag = forking && parent ? (parent.tagline || '') : (d.tagline || '');
    const seedTask = editing ? (d.task || '')
      : forking && parent ? (parent.task || '')
      : minting ? pendingMintTemplate : (d.task || '');
    return '<div class="mkt-save mkt-recipe-form">' +
      '<div class="mkt-save-h">' + esc(title) + '</div>' +
      '<p class="mkt-hint">' + intro + '</p>' +
      '<div class="mkt-save-row"><label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-r-emoji" maxlength="2" value="' + esc(seedEmoji) + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-r-name" maxlength="40" value="' + esc(seedName) + '" placeholder="e.g. Morning Standup"></label></div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-r-tag" maxlength="48" value="' + esc(seedTag) + '" placeholder="one line — what it’s for"></label>' +
      '<label class="mkt-lbl">DIRECTIVE TEMPLATE<textarea class="mkt-in mkt-r-task" id="mkt-r-task" rows="4" placeholder="e.g. Summarize {project} progress since {since} and flag blockers.">' + esc(seedTask || '') + '</textarea></label>' +
      '<div class="mkt-r-tokens" id="mkt-r-tokens"></div>' +
      '<label class="mkt-lbl">FILL-INS <span class="mkt-lbl-hint">— the blanks filled at launch</span></label>' +
      paramsGridHTML() +
      '<label class="mkt-lbl">PROCEDURE <span class="mkt-lbl-hint">— optional; one step per line, followed in order</span>' +
        '<textarea class="mkt-in mkt-r-steps" id="mkt-r-steps" rows="3" placeholder="e.g.\nPull this week\'s orders from {source}\nDraft the summary\nSave it to out/{client}-weekly.md">' + esc(editSteps.join('\n')) + '</textarea></label>' +
      '<label class="mkt-lbl">ACCEPTANCE CHECKS <span class="mkt-lbl-hint">— optional; the run is not done until every one holds</span></label>' +
      acceptGridHTML() +
      '<label class="mkt-lbl">LIVE PREVIEW <span class="mkt-lbl-hint">— what your agent receives</span></label>' +
      '<pre class="mkt-r-preview" id="mkt-r-preview"></pre>' +
      '<label class="mkt-lbl">GEAR IT DRAWS ON <span class="mkt-lbl-hint">— advisory; a WANT badge if the station lacks it, never a lock</span></label>' +
      '<div class="mkt-chips" id="mkt-r-gear">' + gearPickHTML() + '</div>' +
      '<div class="mkt-save-row">' +
        '<label class="mkt-lbl mkt-grow">CATEGORY<select class="mkt-in" id="mkt-r-cat">' + catSelectHTML() + '</select></label>' +
        '<label class="mkt-lbl mkt-grow">SUGGESTED CADENCE<select class="mkt-in" id="mkt-r-cad">' + cadSelectHTML() + '</select></label>' +
      '</div>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-recipe-save">' + (editing ? '✓ SAVE CHANGES' : forking ? '✓ SAVE MY VERSION' : '✓ SAVE RECIPE') + '</button></div></div>';
  }
  function wireRecipeSaveForm(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; editingRecipeId = null; editForkedFrom = null; editSourceRunId = null; pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; renderStage(); });
    const taskIn = stage.querySelector('#mkt-r-task'), tokens = stage.querySelector('#mkt-r-tokens'), preview = stage.querySelector('#mkt-r-preview');
    // read the fill-in grid back into editParams (keys/labels/placeholder/required) from the live inputs.
    const syncParamsFromDOM = () => {
      stage.querySelectorAll('.mkt-r-prow').forEach(row => {
        const i = +row.dataset.i; if (!editParams[i]) return;
        const k = row.querySelector('.mkt-r-pkey'), l = row.querySelector('.mkt-r-plabel'), ph = row.querySelector('.mkt-r-pph'), rq = row.querySelector('.mkt-r-preq-cb');
        const ty = row.querySelector('.mkt-r-ptype'), op = row.querySelector('.mkt-r-popts');
        if (k) editParams[i].key = (k.value || '').trim();
        if (l) editParams[i].label = (l.value || '').trim();
        if (ph) editParams[i].placeholder = (ph.value || '').trim();
        if (op) editParams[i].options = (op.value || '').trim();     // the raw comma line; split on save
        if (ty) editParams[i].type = ty.value || 'text';
        if (rq) editParams[i].required = !!rq.checked;
      });
    };
    // one authored row -> the param descriptor shape recipes.js normalizes (options split from the comma line).
    const paramOut = (p) => ({
      key: p.key, label: p.label || p.key, placeholder: p.placeholder, required: p.required,
      type: p.type || 'text', options: String(p.options || '').split(',').map(s => s.trim()).filter(Boolean)
    });
    // build the effective recipe for previewing: explicit fill-in rows if any have a key, else derive from tokens.
    const effectiveParams = (task) => {
      const explicit = editParams.filter(p => p.key);
      if (explicit.length) return explicit.map(paramOut);
      return Recipes.paramsFromTemplate(task);
    };
    // SOP: read the procedure textarea + acceptance rows back into editor state (the preview + save read these).
    const stepsIn = stage.querySelector('#mkt-r-steps');
    const syncStepsFromDOM = () => { if (stepsIn) editSteps = String(stepsIn.value || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean); };
    const syncAcceptFromDOM = () => {
      stage.querySelectorAll('.mkt-r-arow').forEach(row => {
        const i = +row.dataset.i; if (!editAcceptance[i]) return;
        const ty = row.querySelector('.mkt-r-atype'), pa = row.querySelector('.mkt-r-apath'), tx = row.querySelector('.mkt-r-atext'), sh = row.querySelector('.mkt-r-asha'), cm = row.querySelector('.mkt-r-acmd');
        const cn = row.querySelector('.mkt-r-aconn'), tl = row.querySelector('.mkt-r-atool'), ag = row.querySelector('.mkt-r-aargs');
        if (ty) editAcceptance[i].type = ty.value || 'artifact_exists';
        if (cn) editAcceptance[i].connector = (cn.value || '').trim();
        if (tl) editAcceptance[i].tool = (tl.value || '').trim();
        if (ag) editAcceptance[i].args = (ag.value || '').trim();
        if (tx && cn) { editAcceptance[i].contains = (tx.value || '').trim(); }
        if (pa) editAcceptance[i].path = (pa.value || '').trim();
        if (tx) editAcceptance[i].text = (tx.value || '').trim();
        if (sh) editAcceptance[i].sha256 = (sh.value || '').trim();
        if (cm) editAcceptance[i].command = (cm.value || '').trim();
      });
    };
    const paintPreview = () => {
      if (!preview || !taskIn) return;
      const task = taskIn.value || '';
      // preview through the REAL fillTask primitive against a throwaway recipe shape (never persisted).
      syncAcceptFromDOM(); syncStepsFromDOM();
      const draft = Recipes.draft({ task: task, params: effectiveParams(task), steps: editSteps, acceptance: editAcceptance });
      const vals = {};
      (draft.params || []).forEach(p => { if (p.required) vals[p.key] = '[' + (p.label || p.key) + ']'; });
      const filled = Recipes.fillTask(draft, vals);
      preview.textContent = filled || '(write a directive above)';
    };
    const paintTokens = () => { if (tokens && taskIn) tokens.innerHTML = recipeTokenHint(taskIn.value); };
    const repaint = () => { paintTokens(); paintPreview(); };
    if (taskIn) taskIn.addEventListener('input', repaint);

    // param grid: add / remove rows, and re-read on any edit so the preview tracks.
    const grid = stage.querySelector('#mkt-r-params');
    const rerenderGrid = () => {
      if (!grid) return;
      grid.innerHTML = editParams.map(paramRowHTML).join('');
      wireGridRows();
      repaint();
    };
    const wireGridRows = () => {
      if (!grid) return;
      grid.querySelectorAll('.mkt-r-prm').forEach(b => b.addEventListener('click', () => {
        syncParamsFromDOM(); editParams.splice(+b.dataset.i, 1); sfx('click'); rerenderGrid();
      }));
      grid.querySelectorAll('.mkt-r-pkey, .mkt-r-plabel, .mkt-r-pph, .mkt-r-popts').forEach(inp => inp.addEventListener('input', () => { syncParamsFromDOM(); paintPreview(); }));
      grid.querySelectorAll('.mkt-r-preq-cb').forEach(cb => cb.addEventListener('change', () => { syncParamsFromDOM(); paintPreview(); }));
      // switching a row to/from 'pick one' swaps its third box (hint <-> options), so the grid re-renders.
      grid.querySelectorAll('.mkt-r-ptype').forEach(sel => sel.addEventListener('change', () => { syncParamsFromDOM(); sfx('click'); rerenderGrid(); }));
    };
    wireGridRows();
    const padd = stage.querySelector('.mkt-r-padd');
    if (padd) padd.addEventListener('click', () => { syncParamsFromDOM(); editParams.push({ key: '', label: '', placeholder: '', required: true, type: 'text', options: '' }); sfx('click'); rerenderGrid(); });

    // SOP: procedure textarea tracks the preview; acceptance grid adds/removes rows and re-renders on a type swap.
    if (stepsIn) stepsIn.addEventListener('input', paintPreview);
    const agrid = stage.querySelector('#mkt-r-accept');
    const rerenderAccept = () => {
      if (!agrid) return;
      agrid.innerHTML = editAcceptance.map(acceptRowHTML).join('');
      wireAcceptRows();
      paintPreview();
    };
    const wireAcceptRows = () => {
      if (!agrid) return;
      agrid.querySelectorAll('.mkt-r-arm').forEach(b => b.addEventListener('click', () => { syncAcceptFromDOM(); editAcceptance.splice(+b.dataset.i, 1); sfx('click'); rerenderAccept(); }));
      agrid.querySelectorAll('.mkt-r-apath, .mkt-r-atext, .mkt-r-asha, .mkt-r-acmd, .mkt-r-aconn, .mkt-r-atool, .mkt-r-aargs').forEach(inp => inp.addEventListener('input', paintPreview));
      agrid.querySelectorAll('.mkt-r-atype').forEach(sel => sel.addEventListener('change', () => { syncAcceptFromDOM(); sfx('click'); rerenderAccept(); }));
    };
    wireAcceptRows();
    const aadd = stage.querySelector('.mkt-r-aadd');
    if (aadd) aadd.addEventListener('click', () => { syncAcceptFromDOM(); editAcceptance.push({ type: 'artifact_exists', path: '', text: '', sha256: '', command: '', connector: '', tool: '', args: '', contains: '' }); sfx('click'); rerenderAccept(); });

    // gear chips (toggle in/out of editGear).
    stage.querySelectorAll('#mkt-r-gear .mkt-chip.pick').forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.gear, i = editGear.indexOf(t);
      if (i >= 0) editGear.splice(i, 1); else editGear.push(t);
      const on = editGear.indexOf(t) >= 0;
      b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); sfx('click');
    }));
    const catSel = stage.querySelector('#mkt-r-cat');
    if (catSel) catSel.addEventListener('change', () => { editCategory = catSel.value || 'general'; });
    const cadSel = stage.querySelector('#mkt-r-cad');
    if (cadSel) cadSel.addEventListener('change', () => { editCadence = cadSel.value || null; });

    repaint();

    const save = stage.querySelector('.mkt-do-recipe-save');
    if (save) save.addEventListener('click', () => {
      const editing = editingRecipeId && hasRecipes() ? Recipes.get(editingRecipeId) : null;
      const name = (stage.querySelector('#mkt-r-name').value || '').trim();
      const task = (stage.querySelector('#mkt-r-task').value || '').trim();
      if (!name) { sfx('bad'); note('give your recipe a name', 'bad'); stage.querySelector('#mkt-r-name').focus(); return; }
      if (!task) { sfx('bad'); note('write the directive your agent should run', 'bad'); stage.querySelector('#mkt-r-task').focus(); return; }
      syncParamsFromDOM(); syncStepsFromDOM(); syncAcceptFromDOM();
      const explicit = editParams.filter(p => p.key).map(paramOut);
      // an acceptance row that is still blank (no path / no command) is not a check — drop it rather than save a
      // row recipes.js would discard anyway, so the author never sees a phantom "◇ 1 check".
      const accepts = editAcceptance.filter(a => a.type === 'verification_passed' ? a.command : a.type === 'connector_readback' ? (a.connector && a.tool && a.contains) : a.path)
        .map(a => a.type === 'connector_readback' ? { type: a.type, connector: a.connector, tool: a.tool, args: a.args || null, contains: a.contains } : a);
      const rec = {
        name, emoji: (stage.querySelector('#mkt-r-emoji').value || '✦').trim() || '✦',
        tagline: (stage.querySelector('#mkt-r-tag').value || '').trim(), task,
        gear: editGear.slice(), cadence: editCadence, category: editCategory,
        params: explicit,   // empty → normCustom derives from the template tokens
        steps: editSteps.slice(), acceptance: accepts
      };
      // provenance: an EDIT keeps its id (and its existing source); a FORK stamps source:'fork' + forkedFrom.
      if (editing) rec.id = editing.id;
      else if (editForkedFrom) { rec.source = 'fork'; rec.forkedFrom = editForkedFrom; }
      // R5: a bottled-run mint carries sourceRunId through save (honest provenance). Prefer the live editor state;
      // on an EDIT of an already-bottled custom, fall back to the saved record's value so it isn't dropped.
      const srid = editSourceRunId != null ? editSourceRunId : (editing && editing.sourceRunId != null ? editing.sourceRunId : null);
      if (srid != null) rec.sourceRunId = srid;
      try {
        const saved = Recipes.saveCustom(rec);
        if (pendingMintKey && mintApi()) MintStore.markMinted(pendingMintKey);
        // a SCOUT draft: the save IS the accept — retire the staged draft server-side (never a denylist).
        if (pendingScoutRecipeId && typeof ProspectStore !== 'undefined' && ProspectStore.accept) ProspectStore.accept(pendingScoutRecipeId);
        pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; editForkedFrom = null; editSourceRunId = null;
        focusRecipe = saved.id;
        sfx('click'); note((editing ? 'updated' : 'saved') + ' recipe: ' + saved.name, 'good');
        editingRecipeId = null; view = 'grid'; renderStage();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = stage.querySelector('#mkt-r-name');
    if (nameIn) { nameIn.focus(); nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length); }
  }

  /* ---------- save / edit a specialty ---------- */
  function saveFormHTML() {
    const editing = editingId ? Specialties.get(editingId) : null;
    const d = editing || (ctx && ctx.draftFromAgent && ctx.draftFromAgent()) || { name: 'My Specialist', emoji: '✦', tagline: '', purpose: '', manual: '' };
    const hasMission = (d.purpose && d.purpose.trim()) || (d.manual && d.manual.trim());
    const title = editing ? 'EDIT SPECIALTY' : ('SAVE ' + (((ctx && ctx.agentName) || 'THIS AGENT')).toUpperCase() + ' AS A SPECIALTY');
    const intro = editing
      ? 'rename or re-icon this saved specialty — its purpose &amp; standing orders are kept as they are.'
      : 'captures this agent’s current purpose + standing orders as a reusable template you can deploy later.' +
        (hasMission ? '' : ' <b>heads up:</b> this agent has no purpose / standing-orders set yet, so the template would be near-empty.');
    const ctaCls = (editing || hasMission) ? '' : ' caution';
    const ctaText = editing ? '✓ SAVE CHANGES' : (hasMission ? '✓ SAVE SPECIALTY' : '✓ SAVE ANYWAY');
    return '<div class="mkt-save">' +
      '<div class="mkt-save-h">' + esc(title) + '</div>' +
      '<p class="mkt-hint">' + intro + '</p>' +
      '<div class="mkt-save-row"><label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-f-emoji" maxlength="2" value="' + esc(d.emoji || '✦') + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-f-name" maxlength="28" value="' + esc(d.name || '') + '" placeholder="e.g. Night-Shift Researcher"></label></div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-f-tag" maxlength="48" value="' + esc(d.tagline || '') + '" placeholder="one line — what it’s for"></label>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-save' + ctaCls + '">' + ctaText + '</button></div></div>';
  }
  function wireSaveForm(stage) {
    stage.querySelector('.mkt-cancel').addEventListener('click', () => { sfx('click'); view = 'grid'; editingId = null; renderStage(); });
    stage.querySelector('.mkt-do-save').addEventListener('click', () => {
      const editing = editingId ? Specialties.get(editingId) : null;
      const base = editing || (ctx && ctx.draftFromAgent && ctx.draftFromAgent()) || {};
      const name = (stage.querySelector('#mkt-f-name').value || '').trim();
      if (!name) { sfx('bad'); note('give your specialty a name', 'bad'); return; }
      const spec = Object.assign({}, base, {
        name, emoji: (stage.querySelector('#mkt-f-emoji').value || '✦').trim() || '✦',
        tagline: (stage.querySelector('#mkt-f-tag').value || '').trim()
      });
      if (editing) spec.id = editing.id;
      try {
        const saved = Specialties.saveCustom(spec);
        focusAgent = saved.id;
        sfx('click'); note((editing ? 'updated' : 'saved') + ' specialty: ' + saved.name, 'good');
        editingId = null; view = 'grid'; renderStage();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = stage.querySelector('#mkt-f-name');
    if (nameIn) { nameIn.focus(); nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length); }
  }

  /* ---------- build a custom class from scratch (the ＋ tile) ----------
     A full authoring form: icon, name, accent (the seal colour), tagline, clearance tier, purpose +
     standing orders — saved straight to YOUR SPECIALISTS via Specialties.saveCustom (tags auto-derive
     from the text, so the new class ranks in the feed and deploys/recruits like any built-in). */
  const BUILD_ACCENTS = ['#ffaa33', '#7bc88a', '#6fa8bf', '#b790c0', '#cf8a7d', '#88b6c4', '#ffd34a', '#6fbcc0', '#9fc0c4'];
  function buildFormHTML() {
    // Custom classes are edited in THIS builder (via editingId) so their loadout pickers are reachable; a fresh
    // ＋ build has no editingId. Every field prefills from the spec being edited. (Built-ins are frozen — no edit.)
    const editing = editingId ? Specialties.get(editingId) : null;
    // a station-drafted prospect (buildDraft) pre-fills the NEW-class form when not editing an existing custom.
    const d = editing || buildDraft || { emoji: '✦', name: '', tagline: '', purpose: '', manual: '' };
    const sw = BUILD_ACCENTS.map(c => '<button type="button" class="mkt-sw' + (c === buildAccent ? ' sel' : '') +
      '" data-acc="' + c + '" style="background:' + c + '" aria-label="accent ' + c + '"></button>').join('');
    const seg = (m, l) => '<button type="button" class="mkt-seg' + (buildModel === m ? ' sel' : '') + '" data-model="' + m + '">' + l + '</button>';
    const previewEmoji = (d.emoji || '✦').trim() || '✦';
    return '<div class="mkt-save mkt-build-form">' +
      '<div class="mkt-save-h">' + (editing ? 'EDIT CUSTOM CLASS' : 'BUILD A CUSTOM CLASS') + '</div>' +
      '<p class="mkt-hint">' + (editing
        ? 'retune this class — its job, standing orders, look, and loadout. changes apply to agents <b>summoned from here on</b>; already-summoned agents keep the loadout they were given.'
        : 'define your own class — its job, its standing orders, its look. it joins <b>YOUR SPECIALISTS</b>, ready to deploy or summon.') + '</p>' +
      /* The preview coin no longer takes the picked accent. It is a PREVIEW, so it must show what the
         roster will actually show — and every seal in the bay is engraved in the station's one phosphor
         (see the note on mkt-card). Painting this one coin blue while its row renders amber is the
         precise kind of claim the app is not allowed to make. The accent is still picked and still
         saved: it is the SUIT the agent wears on the floor, which the swatches themselves preview. */
      '<div class="mkt-build-preview"><div class="mkt-coin" id="mkt-build-coin">' +
        '<span class="mkt-coin-emoji" id="mkt-build-emoji">' + esc(previewEmoji) + '</span></div><span class="mkt-hint">live preview — your class seal</span></div>' +
      '<div class="mkt-save-row"><label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-b-emoji" maxlength="2" value="' + esc(previewEmoji) + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-b-name" maxlength="28" value="' + esc(d.name || '') + '" placeholder="e.g. Growth Hacker"></label></div>' +
      // relabelled from the bare "ACCENT": now that the seal is always station phosphor, this swatch's
      // one real job is the agent's SUIT on the floor — say so rather than leave it pointing at nothing.
      '<label class="mkt-lbl">SUIT COLOUR <span class="mkt-lbl-hint">— what your agent wears on the floor</span></label><div class="mkt-swatches" id="mkt-b-acc">' + sw + '</div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-b-tag" maxlength="48" value="' + esc(d.tagline || '') + '" placeholder="one line — what it’s for"></label>' +
      '<label class="mkt-lbl">CLEARANCE</label><div class="mkt-segs" id="mkt-b-model">' +
        seg('reasoning', '◆◆◆ DEEP') + seg('balanced', '◆◆ BALANCED') + seg('fast', '◆ FAST') + '</div>' +
      // EFFORT — the reasoning effort applied at summon (independent of the clearance tier/model).
      '<label class="mkt-lbl">REASONING EFFORT <span class="mkt-lbl-hint">— applied at summon</span></label><div class="mkt-segs" id="mkt-b-effort">' +
        effSeg(null, 'DEFAULT') + effSeg('high', 'HIGH') + effSeg('medium', 'MEDIUM') + effSeg('low', 'LOW') + '</div>' +
      // STATION GEAR — capability objectTypes this class draws on under the overseer (informational; labels from
      // the LIVE catalog). Not per-agent props — shared station gear; the picks round-trip into the saved spec.
      '<label class="mkt-lbl">STATION GEAR IT DRAWS ON <span class="mkt-lbl-hint">— shared gear it uses under the overseer</span></label>' +
      '<div class="mkt-kitpicks" id="mkt-b-kit">' + buildKitChipsHTML() + '</div>' +
      // SKILL PACKAGE — bundled recipes enabled for this class (from the live /api/skills catalog, filled async).
      '<label class="mkt-lbl">SKILL PACKAGE <span class="mkt-lbl-hint">— recipes it follows when a task matches</span></label>' +
      '<div class="mkt-chips" id="mkt-b-skills"><span class="mkt-hint mkt-chips-loading">loading the skill library…</span></div>' +
      '<label class="mkt-lbl">PURPOSE<textarea class="mkt-in mkt-b-area" id="mkt-b-purpose" rows="3" placeholder="what this class is FOR — its job, in its own words.">' + esc(d.purpose || '') + '</textarea></label>' +
      '<label class="mkt-lbl">STANDING ORDERS<textarea class="mkt-in mkt-b-area" id="mkt-b-manual" rows="4" placeholder="- the rules it always follows\n- one per line">' + esc(d.manual || '') + '</textarea></label>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button><button class="bb sm mkt-do-build">' + (editing ? '✓ SAVE CHANGES' : '✓ CREATE CLASS') + '</button></div></div>';
  }
  // the pickable kit objectTypes — the auto-requisitionable capabilities (computer/connector are per-agent
  // manual-bind, per-agent bound props, never shared station gear a class draws on). Labels from the live source.
  const KIT_PICKABLE = ['dish', 'cabinet', 'notebook', 'workbench', 'studio'];
  // each kit pick shows its capability blurb (from capGrant) next to the toggle, so a beginner sees what the
  // gear actually grants ("the WEB — live search & fetch") instead of a bare prop label with a hidden title.
  function buildKitChipsHTML() {
    return KIT_PICKABLE.map(t => {
      const on = buildKit.indexOf(t) >= 0;
      return '<div class="mkt-kitpick">' +
        '<button type="button" class="mkt-chip pick' + (on ? ' sel' : '') + '" data-kit="' + esc(t) + '" ' +
          'title="' + esc(capGrant(t)) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(kitPropLabel(t)) + '</button>' +
        '<span class="mkt-kitpick-grant">' + esc(capGrant(t)) + '</span></div>';
    }).join('');
  }
  const effSeg = (e, l) => '<button type="button" class="mkt-seg' + ((buildEffort === e || (e === null && !buildEffort)) ? ' sel' : '') + '" data-effort="' + (e == null ? '' : e) + '">' + l + '</button>';
  function wireBuildForm(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); editingId = null; buildDraft = null; acceptingProspectId = null; view = 'grid'; renderStage(); });
    // live seal preview: the ICON only. The suit swatch no longer repaints the coin — the seal is
    // station phosphor in the roster, so previewing it in the picked colour would preview a lie.
    const emojiIn = stage.querySelector('#mkt-b-emoji'), coinEmoji = stage.querySelector('#mkt-build-emoji');
    if (emojiIn) emojiIn.addEventListener('input', () => { if (coinEmoji) coinEmoji.textContent = (emojiIn.value || '✦').trim() || '✦'; });
    stage.querySelectorAll('#mkt-b-acc .mkt-sw').forEach(b => b.addEventListener('click', () => {
      buildAccent = b.dataset.acc;
      stage.querySelectorAll('#mkt-b-acc .mkt-sw').forEach(x => x.classList.remove('sel')); b.classList.add('sel');
      sfx('click');
    }));
    stage.querySelectorAll('#mkt-b-model .mkt-seg').forEach(b => b.addEventListener('click', () => {
      buildModel = b.dataset.model;
      stage.querySelectorAll('#mkt-b-model .mkt-seg').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); sfx('click');
    }));
    // EFFORT selector — '' data-effort => default (null).
    stage.querySelectorAll('#mkt-b-effort .mkt-seg').forEach(b => b.addEventListener('click', () => {
      buildEffort = b.dataset.effort || null;
      stage.querySelectorAll('#mkt-b-effort .mkt-seg').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); sfx('click');
    }));
    // KIT chips — toggle a capability objectType in/out of the picked kit.
    const wireKitChips = () => stage.querySelectorAll('#mkt-b-kit .mkt-chip.pick').forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.kit, i = buildKit.indexOf(t);
      if (i >= 0) buildKit.splice(i, 1); else buildKit.push(t);
      const on = buildKit.indexOf(t) >= 0;
      b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); sfx('click');
    }));
    wireKitChips();
    // SKILL chips — fetched from the live catalog, then toggle a slug in/out of the package. Best-effort: an
    // unreachable catalog leaves a hint (the class still saves with whatever kit/effort was picked).
    const skHost = stage.querySelector('#mkt-b-skills');
    if (skHost) loadSkillCatalog().then(map => {
      const slugs = Object.keys(map).sort((a, b) => map[a].name.localeCompare(map[b].name));
      if (!slugs.length) { skHost.innerHTML = '<span class="mkt-hint">no skill library found (is the sidecar running?)</span>'; return; }
      skHost.innerHTML = slugs.map(slug => {
        const on = buildSkills.indexOf(slug) >= 0;
        return '<button type="button" class="mkt-chip pick' + (on ? ' sel' : '') + '" data-skill="' + esc(slug) + '" ' +
          'title="' + esc(map[slug].description) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(map[slug].name) + '</button>';
      }).join('');
      skHost.querySelectorAll('.mkt-chip.pick').forEach(b => b.addEventListener('click', () => {
        const slug = b.dataset.skill, i = buildSkills.indexOf(slug);
        if (i >= 0) buildSkills.splice(i, 1); else buildSkills.push(slug);
        const on = buildSkills.indexOf(slug) >= 0;
        b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); sfx('click');
      }));
    });
    const create = stage.querySelector('.mkt-do-build');
    if (create) create.addEventListener('click', () => {
      // editingId set => upserting an existing custom class through the SAME store path (saveCustom keeps the id).
      const editing = editingId ? Specialties.get(editingId) : null;
      const name = (stage.querySelector('#mkt-b-name').value || '').trim();
      if (!name) { sfx('bad'); note('give your class a name', 'bad'); stage.querySelector('#mkt-b-name').focus(); return; }
      // mirror the prospect drafter's constraint (prospect.js:112): a specialist with no gear is not a real role.
      // an empty kit used to save silently; make it explain itself and point back at the gear picker.
      if (!buildKit.length) {
        sfx('bad'); note('a specialist with no gear is not a real role — pick at least one kit item', 'bad');
        const kitHost = stage.querySelector('#mkt-b-kit'); if (kitHost && kitHost.scrollIntoView) kitHost.scrollIntoView({ block: 'center' });
        return;
      }
      // when editing, start from the saved record so non-authored carried fields (persona, tags, starters, blurb)
      // survive the round-trip; the form fields below overwrite what the builder exposes.
      const spec = Object.assign({}, editing || {}, {
        name,
        emoji: (stage.querySelector('#mkt-b-emoji').value || '✦').trim() || '✦',
        accent: buildAccent, model: buildModel,
        tagline: (stage.querySelector('#mkt-b-tag').value || '').trim(),
        purpose: (stage.querySelector('#mkt-b-purpose').value || '').trim(),
        manual: (stage.querySelector('#mkt-b-manual').value || '').trim(),
        // LOADOUT (Class Loadouts S3): the picked kit/skills/effort round-trip into the saved custom spec
        // (Specialties.normCustom normalizes + freezes them) so a user class is a full loadout, applied at summon.
        kit: buildKit.slice(), skills: buildSkills.slice(), reasoningEffort: buildEffort
      });
      // keep the id (and any non-editable carried fields, e.g. persona/tags/starters) when editing, so the edit
      // is an upsert of the SAME record rather than a new class. Editing does not touch already-summoned agents —
      // they own their loadout on their roster record (applyLoadout snapshots it at summon).
      if (editing) spec.id = editing.id;
      try {
        const saved = Specialties.saveCustom(spec);
        // Slice 4: a saved prospect graduates to a real custom class — remove it from staging (accept, not deny).
        if (acceptingProspectId && typeof ProspectStore !== 'undefined' && ProspectStore.accept) { try { ProspectStore.accept(acceptingProspectId); } catch (_) {} }
        acceptingProspectId = null; buildDraft = null;
        focusAgent = saved.id; editingId = null; view = 'grid';
        sfx('click'); note((editing ? 'updated class: ' : 'created class: ') + saved.name, 'good');
        renderStage();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = stage.querySelector('#mkt-b-name'); if (nameIn) nameIn.focus();
  }

  // Slice 4: let ProspectStore refresh the open bay when a fresh prospect mints (no-op when the bay is closed or
  // not on the grid view — never yanks the user out of the editor).
  function refreshIfOpen() { if (root && view === 'grid') { try { renderStage(); } catch (_) {} } }
  return { open, close, refreshIfOpen };
})();
