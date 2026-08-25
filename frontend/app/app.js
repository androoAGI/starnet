/* STARNET — app.js : screen flow + wiring.
   title -> connect (create a character) -> game.  Auto-resumes a saved agent on refresh. */
'use strict';

const App = (() => {
  const el = id => document.getElementById(id);
  // HTML-escape for the rare spot we build a connect message with a link (provider label + signup URL).
  // Delegates to the one complete implementation (U.esc escapes & < > " ' — quotes included, so attribute
  // contexts are safe); keep the null-guard the old local copy had so U.esc(null) never renders "null".
  const esc = s => U.esc(s == null ? '' : s);
  // CRT-muted crew suit tints — distinct per crew member but passed through the amber-phosphor grade (no pure neons). Last entry stays gold to match ORCH_COLOR.
  const SUITS = ['#6fb3bf', '#7bc88a', '#d99a5a', '#a888c0', '#cf7d96', '#ffd34a'];

  let agent = null;           // the FOCUSED agent — COMMS + camera target. Every existing `agent.` reference still
                              //   reads "the agent in front of you"; summon adds more, focus repoints this pointer.
  const agents = new Map();   // agentId -> agent object (hero + summoned crew) — the live multi-agent roster
  let resumingSaved = null;   // a save awaiting a re-entered key
  const ORCH_COLOR = '#ffd34a';   // the Orchestrator's suit tint — gold marks the lead (same gold as SUITS' last entry). No color picker any more (skins are the visual identity); summoned crew cycle SUITS.
  let pickedColor = ORCH_COLOR;
  let pickedSkin = (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN) || 'bear';   // the sprite set the new agent will wear
  let pickedPersona = (typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'professional';
  let pickedTraits = {};        // the VOICE & MANNER fine-tune dials (warmth/humor/formality/length + emoji/blunt) — only set keys contribute prompt text
  let pickedCustomVoice = '';   // the Commander's free-text "in their own words" voice note (optional)
  let pickedApproval = 'ask';   // the APPROVAL mode — 'ask' (consent-gated) | 'full' (auto-approve). Drives the REAL consent broker (sidecar bypass), not a cosmetic toggle.
  let pickedProvider = 'openai';   // BEGINNER-FIRST funnel: the STARNET hero is the promoted start, but it only exists once the cloud seam is proven (revealStarnetGenesis auto-picks it on a fresh create). Until then OPENAI leads — its card carries BOTH paths (ChatGPT sign-in or an API key). initConnect() still honours a returning agent's saved provider.
  // POWER-USER LOOP PL-03 — entry is a four-surface truth transaction. World opens its EventSource
  // before Chat/StationUI finish mounting, and their independent timers used to expose an impossible
  // mixture during reload: unreachable + STANDBY + ONLINE + "COMMS online". Hold every idle claim at
  // CONNECTING until the bridge itself proves OPEN; a sustained failure then converges to one DOWN state.
  let bridgeAuthorityTimer = null;
  let bridgeAuthorityObserver = null;
  function bridgeAuthorityProven() {
    try {
      const ls = (typeof World !== 'undefined' && World.linkState) ? World.linkState() : null;
      return !!(ls && ls.bridged && !ls.paused && !ls.down);
    } catch (_) { return false; }
  }
  function paintBridgeConnecting() {
    const chat = el('chat-status');
    if (chat) { if (chat.textContent !== 'connecting…') chat.textContent = 'connecting…'; if (chat.className !== 'status-connecting') chat.className = 'status-connecting'; }
    const pill = el('status-pill');
    if (pill) { if (pill.textContent !== 'CONNECTING') pill.textContent = 'CONNECTING'; if (pill.className !== 'standby') pill.className = 'standby'; }
    const empty = document.querySelector('.cmsg-empty-line');
    if (empty && empty.textContent !== 'COMMS connecting…') empty.textContent = 'COMMS connecting…';
    const sig = el('sig'), bars = sig && sig.querySelector('b');
    if (sig && bars) { sig.classList.remove('down'); sig.classList.add('standby'); if (sig.childNodes[0].nodeValue !== 'CONNECTING ') sig.childNodes[0].nodeValue = 'CONNECTING '; if (bars.textContent !== '▃▃▃▃') bars.textContent = '▃▃▃▃'; }
    // Do not let our own corrective mutations recursively re-enter the observer and starve the
    // EventSource/timers that are supposed to earn authority.
    if (bridgeAuthorityObserver) bridgeAuthorityObserver.takeRecords();
  }
  function paintBridgeUnavailable() {
    const chat = el('chat-status');
    if (chat) { chat.textContent = 'station unreachable'; chat.className = 'status-down'; }
    const pill = el('status-pill');
    if (pill) { pill.textContent = 'LINK DOWN'; pill.className = 'down'; }
    const empty = document.querySelector('.cmsg-empty-line');
    if (empty) empty.textContent = 'COMMS unavailable — reconnecting to the station.';
    const sig = el('sig'), bars = sig && sig.querySelector('b');
    if (sig && bars) { sig.classList.remove('standby'); sig.classList.add('down'); sig.childNodes[0].nodeValue = 'LINK DOWN '; bars.textContent = '▁▁▁▁'; }
  }
  function beginBridgeAuthorityGate() {
    if (bridgeAuthorityTimer) clearTimeout(bridgeAuthorityTimer);
    if (bridgeAuthorityObserver) { bridgeAuthorityObserver.disconnect(); bridgeAuthorityObserver = null; }
    const beganAt = Date.now();
    // StationUI and Topbar have independent repaint cadences. During the gate, synchronously fold any
    // attempted status mutation back into CONNECTING before the browser paints a contradictory frame.
    if (typeof MutationObserver !== 'undefined') {
      bridgeAuthorityObserver = new MutationObserver(() => { if (bridgeAuthorityTimer && !bridgeAuthorityProven()) paintBridgeConnecting(); });
      const game = el('screen-game');
      if (game) bridgeAuthorityObserver.observe(game, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    const check = () => {
      if (bridgeAuthorityProven()) {
        bridgeAuthorityTimer = null;
        if (bridgeAuthorityObserver) { bridgeAuthorityObserver.disconnect(); bridgeAuthorityObserver = null; }
        try { if (typeof Topbar !== 'undefined' && Topbar._paintSig) Topbar._paintSig(); } catch (_) {}
        if (typeof Chat !== 'undefined' && Chat.status && !(Chat.isBusy && Chat.isBusy())) Chat.status('online');
        const pill = el('status-pill'); if (pill) { pill.textContent = 'ONLINE'; pill.className = ''; }
        const empty = document.querySelector('.cmsg-empty-line');
        if (empty && agent) empty.textContent = 'COMMS online. Type a task or a question to ' + agent.name + '.';
        return;
      }
      // EventSource.CONNECTING is not a fault. Only call the link unavailable after it has failed to
      // earn authority for a full retry window; until then every surface stays on the same neutral word.
      if ((Date.now() - beganAt) >= 12000) { bridgeAuthorityTimer = null; if (bridgeAuthorityObserver) { bridgeAuthorityObserver.disconnect(); bridgeAuthorityObserver = null; } paintBridgeUnavailable(); return; }
      paintBridgeConnecting();
      bridgeAuthorityTimer = setTimeout(check, 100);
    };
    check();
  }
  let prefilledKey = '';               // the key the CONNECT field was pre-seeded with from storage (browser BYOK). Empty
                                       //   when nothing was stored (or on desktop, where the key lives in the keychain and
                                       //   getKey() returns ''). Used by onWake's one-time overwrite guard: editing a
                                       //   pre-filled key asks once before it silently replaces the stored one.
  let keyOverwriteConfirmed = false;   // set true once the Commander confirms replacing the pre-filled key (one-time per screen)
  let unhingedConfirmed = false;       // set true once the Commander confirms the UNHINGED voice chip (it swears for real;
                                       //   two-press arm like the delete buttons — one-time per create screen)
  let codexConnected = false;          // last-known /api/auth/codex/status — gates waking on the Codex provider
  // The OTHER keyless device-code OAuth providers on the genesis screen (grok/kimi) — same gate, per provider.
  // Codex keeps its own literal variable above (source-locks pin it); refreshCodexStatus mirrors into this map.
  const oauthConnected = { codex: false, grok: false, kimi: false };
  let station = null;         // the canonical WorldModel station (the builder's source of truth)
  let pendingStationDoc = null; // a saved station doc awaiting enterGame()
  let pendingStationStats = null; // a saved station-growth rollup (XP/level/confidence) awaiting enterGame()
  let pendingGrowthSyncAt = 0;    // durable-run catch-up floor (server snapshot; legacy saves use their write time once)
  let pendingRatingSyncAt = 0;    // authoritative work-rating ledger floor (repairs stale/rolled-back XP projections)
  let pendingProfile = null;      // a saved user-affinity profile slice awaiting ProfileStore.init() in enterGame()
  let pendingWorkSignal = null;   // a saved capability-usage histogram slice awaiting WorkSignalStore.init() in enterGame()
  let pendingDossier = null;      // a saved Commander-dossier slice awaiting DossierStore.init() in enterGame()

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
    positionLogo();
  }

  // the hoisted brand mark (#logo — fixed above the CRT glass, see style.css) tracks the seat
  // #logo-anchor reserves in the topbar: the anchor takes the logo's natural width so the gauge
  // cluster never slides under it, and the logo takes the anchor's on-screen spot.
  /* The EFFECTIVE zoom #logo renders at. The mark is CABINET — app.css counter-zooms it back to
     1:1 while <body> stays zoomed by TEXT SIZE — so U.uiZoom() is the wrong divisor for it; see
     the U.elZoom note in js/util.js. */
  function logoZoom(logo) {
    if (typeof U !== 'undefined' && U.elZoom) return U.elZoom(logo);
    return (typeof U !== 'undefined' && U.uiZoom) ? U.uiZoom() : 1;
  }
  function positionLogo() {
    const logo = el('logo'), anchor = el('logo-anchor'), bar = el('topbar');
    if (!logo || !anchor || !bar) return;
    const game = el('screen-game');
    if (!game || !game.classList.contains('active')) return;   // hidden screens have no geometry
    anchor.style.width = logo.offsetWidth + 'px';
    // TEXT SIZE coordinate law (stationui.js uiZoom): rects are VISUAL px, but #logo's style.left/
    // top are its OWN layout px — divide by whatever zoom it actually renders at, or on any station
    // where AUTO resolves ≠100% the mark lands off by that factor (worst in windowed mode, where
    // the titlebar strip makes b.top large; the 2026-07-20 misaligned-logo report on other
    // hardware). That factor is no longer just U.uiZoom(): the mark is CABINET, so app.css
    // counter-zooms it back to 1:1 while <body> stays zoomed. Measure the ratio off the element
    // instead of assuming either one — rect/offsetWidth is the engine's own answer, so this stays
    // correct whether or not the counter-zoom applied.
    const z = logoZoom(logo);
    const a = anchor.getBoundingClientRect(), b = bar.getBoundingClientRect();
    // DEVICE-PIXEL SNAP: the seat lands on fractions (a themed topbar, a zoom that is not 1, an odd
    // window width), and a mark parked on a half pixel is antialiased across two — the whole mark
    // goes soft with nothing in the markup to blame. Round the VISUAL position to a whole device
    // pixel, then convert to the mark's own layout px (uiZoom law: divide by z exactly once).
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const snap = v => Math.round(v * dpr) / dpr;
    const wantLeft = snap(a.left);
    const wantTop = snap(b.top + (b.height - logo.offsetHeight * z) / 2);
    logo.style.left = (wantLeft / z) + 'px';
    logo.style.top = (wantTop / z) + 'px';
    // ONE correction pass. z is MEASURED off the element (rect/offsetWidth), so it carries a little
    // float error, and the counter-zoom multiplies that error back into the landed position — the
    // mark came down ~0.02px off its target, which is exactly the half-pixel smear the snap exists
    // to remove. Read where it actually landed and subtract the residual; the map is affine, so one
    // pass drives it to nothing. Never loop: a second pass would chase float noise forever.
    const got = logo.getBoundingClientRect();
    if (Math.abs(got.left - wantLeft) > 0.005 || Math.abs(got.top - wantTop) > 0.005) {
      logo.style.left = ((wantLeft - (got.left - wantLeft)) / z) + 'px';
      logo.style.top = ((wantTop - (got.top - wantTop)) / z) + 'px';
    }
    queueLogoOcclusion();   // the mark moved — its clip is stale
  }

  /* ---------- the brand mark yields to windows (2026-07-29 layering report) ----------
     The z960 hoist that keeps the wordmark crisp above the CRT glass also parks it above every
     floating window: #terms lives INSIDE #screen-game, a z-index:10 stacking context, so a .term
     can never out-stack a <body> child no matter how high zTop() climbs. Drag a panel into the
     top-left and the amber art bleeds straight through it. No z-index fixes this — the glass has
     to stay over the windows, and anything over the glass is over the windows too — so the mark
     is CLIPPED under them instead. app/logoclip.js owns the geometry (and its unit test). */
  function syncLogoOcclusion() {
    const logo = el('logo'), host = el('terms');
    if (!logo || typeof LogoClip === 'undefined') return;
    const box = logo.getBoundingClientRect();
    // uiZoom law: rects are VISUAL px, clip-path coordinates are the element's own LAYOUT px —
    // and the mark is cabinet, so it renders at its own counter-zoomed scale (see logoZoom).
    const z = logoZoom(logo);
    const rects = host ? Array.prototype.map.call(host.querySelectorAll('.term'), w => w.getBoundingClientRect()) : [];
    logo.style.clipPath = LogoClip.clipFor(box, rects, z);
  }
  let occlusionQueued = false;
  function queueLogoOcclusion() {
    if (occlusionQueued) return;
    occlusionQueued = true;
    const run = () => { if (!occlusionQueued) return; occlusionQueued = false; syncLogoOcclusion(); };
    // rAF reads layout right before paint (the cheap place to force one); the timer is the backstop
    // for when rAF is FROZEN — a hidden/minimized window, and the dev preview pane.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    if (typeof setTimeout === 'function') setTimeout(run, 120);
  }
  if (typeof window !== 'undefined') window.addEventListener('resize', positionLogo);
  // One watcher covers the whole window lifecycle: childList = open/close, style = drag + resize
  // + placeTerm, class = minimize/restore. animationend catches the power-on scale settling, which
  // moves no attribute and so fires no mutation of its own.
  if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
    const host = el('terms');
    if (host) {
      new MutationObserver(recs => {
        for (const r of recs) {
          if (r.type === 'childList' && r.target === host) { queueLogoOcclusion(); return; }
          const t = r.target;
          if (t && t.nodeType === 1 && t.classList && t.classList.contains('term')) { queueLogoOcclusion(); return; }
        }
      }).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      host.addEventListener('animationend', queueLogoOcclusion);
    }
  }
  // boot-settle re-seat: positionLogo's first run happens before VT323 lands, which moves the
  // topbar/logo geometry with NO resize event and left the mark off-seat until the first manual
  // resize (the 2026-07-20 misalignment report). The mark itself no longer needs a settle hook —
  // it is a masked <span> sized by CSS aspect-ratio, so it has its full width at first layout;
  // the old `img.load` re-seat existed only because an <img> has no dimensions until it decodes.
  if (typeof document !== 'undefined') {
    try { if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(() => positionLogo()); } catch (_) {}
  }

  function refreshUsage() {
    // Broad lifetime token totals are intentionally not surfaced in the chrome.
    // The bottom-bar context gauge owns prompt-context display from measured usage events.
  }

  /* ---------- agent config DOCS (the markdown files the Commander writes) ----------
     The dossier surfaces three editable .md files — identity.md / purpose.md / operating-manual.md —
     and composeSystemPrompt() assembles them into the EXACT system prompt sent to the model each run.
     They are not decoration: editing one in the dossier re-shapes the live agent (see applyAgentConfig). */
  function baseIdentity(name, role) {
    // HONESTY (truthful-telemetry law): the floor is REAL — a run's tools are EXACTLY the caps the Commander has
    // placed in this agent's room (compute is the only freebie; web/files/terminal must be placed — see
    // sidecar/capability/office.js + capgate F1). So the identity must NOT promise web/files unconditionally; it
    // tells the agent to use whatever it's actually been granted and to SAY when a tool is missing (that's the
    // signal that teaches the Commander what to place next), never to pretend a reach it doesn't have.
    let s = 'You are ' + name + ', an AI agent operating from a workstation aboard the STARNET station — a room '
      + 'your Commander (the user) is building for you. Address the user as "Commander" and keep a spark of personality. '
      + 'Your workstation grants you REAL tools — exactly the ones the Commander has placed in your room (web search/read, '
      + 'file read/write, a terminal, memory, and more as the station grows; compute to think is always yours). When the '
      + 'Commander assigns a TASK, use the tools you actually have to do the real work and report what you find. If a job '
      + 'needs a tool you have not been granted yet, say so plainly and tell the Commander what to place — never pretend a '
      + 'reach you do not have, and never claim a tool is missing when it is in your room. When you are just chatting out '
      + 'loud, keep replies short and easy; when you are typing in the COMMS panel you can go into as much detail as the '
      + 'question deserves. Stay in character.';
    if (role === 'orchestrator') s += orchestratorClause();
    return s;
  }
  // The ORCHESTRATOR is the station's founding agent. This clause is TIMELESS on purpose: identity.md is written
  // once into the save (and is Commander-editable), so any crew-size claim baked here would freeze and turn into
  // an app-lie the moment the roster changes — exactly the bug the old "right now its only agent" wording had.
  // The LIVE crew truth rides rosterClause() (derived fresh each compose) + the sidecar's per-run [ORCHESTRATION]
  // block, which alone grants/lists the delegation tools. Extracted so stripLegacySoloClause can migrate old saves
  // onto the exact same text (keeping setAgentName's untouched-default detection working).
  function orchestratorClause() {
    return ' You are this station\'s OVERSEER — its orchestrating lead and first agent. When there is a crew, you are '
      + 'the one who breaks a big job into pieces and hands them out; when there is not, you do the work yourself. '
      + 'Never assume either from memory: your live crew and your delegation tools are stated fresh in each run\'s '
      + 'briefing — trust that briefing, and never claim a crew member or a delegation tool it does not show. '
      + 'Keep the work moving and keep the Commander oriented on what is done, what is in flight, and what needs them.';
  }
  // seed the editable docs from the agent's existing fields the first time (back-compat for saves with no docs).
  function agentDocs(a) {
    if (!a.docs || typeof a.docs !== 'object') a.docs = {};
    if (typeof a.docs.identity !== 'string') a.docs.identity = baseIdentity(a.name, a.role);
    if (typeof a.docs.purpose !== 'string') a.docs.purpose = a.purpose || '';
    if (typeof a.docs.manual !== 'string') a.docs.manual = '';
    if (typeof a.docs.context !== 'string') a.docs.context = '';   // about the Commander & their world (authored at the awakening; back-filled for older saves)
    return a.docs;
  }
  // MIGRATION (pre-overhaul saves): the OLD awakening Beat 1 baked the chosen voice into identity.md as a
  // literal "VOICE & MANNER:\n<free text>" block. Voice now comes from the chosen archetype (Personas.compose),
  // so a legacy save would otherwise carry TWO competing voices. Strip the inline block once on resume —
  // marker-guarded so it's idempotent and never touches a post-overhaul identity (which has no such block).
  function stripLegacyVoiceBlock(a) {
    const id = a && a.docs && a.docs.identity;
    if (typeof id === 'string' && /\n+VOICE & MANNER:/.test(id)) {
      a.docs.identity = id.split(/\n+VOICE & MANNER:/)[0].trimEnd();
    }
  }
  // MIGRATION (pre-roster-clause saves): the old orchestrator identity baked "right now its only agent … never
  // speak as if you command a crew" into identity.md at creation — frozen there, it becomes an app-lie the moment
  // the Commander summons a crew (and contradicts the sidecar's per-run [ORCHESTRATION] crew brief). Swap the
  // EXACT old block for the new timeless clause on resume. Literal-match-guarded so it's idempotent and never
  // touches an identity the Commander hand-reworded; producing exactly orchestratorClause() keeps the result
  // byte-equal to a fresh baseIdentity, so setAgentName's untouched-default detection still works after migration.
  const LEGACY_SOLO_CLAUSE = ' You are this station\'s OVERSEER — its orchestrating lead, its first agent, and right now its only agent. For now '
    + 'you simply do the work yourself. As the Commander recruits specialists over time, you grow into the one who '
    + 'breaks a big job into pieces and hands them out — you gain a team.dispatch tool to delegate the moment there '
    + 'is a crew to delegate to, and not before. Until then, never speak as if you command a crew you do not yet have; '
    + 'just keep the work moving and keep the Commander oriented on what is done, what is in flight, and what needs them.';
  function stripLegacySoloClause(a) {
    const id = a && a.docs && a.docs.identity;
    if (typeof id === 'string' && id.indexOf(LEGACY_SOLO_CLAUSE) !== -1) {
      a.docs.identity = id.split(LEGACY_SOLO_CLAUSE).join(orchestratorClause());
    }
  }
  // the APPROVAL clause folded into the system prompt — it MUST match the real consent broker (sidecar) so the
  // agent's words and its actual behaviour never diverge (truthful-telemetry law). 'full' = the broker bypasses
  // the consent gate; 'ask' = the broker prompts the Commander on any mutation/network call.
  const EXECUTION_PROFILE_IDS = ['station-gear', 'safe-cell', 'remote-ssh', 'trusted-project', 'this-computer'];
  function executionProfileOf(a) {
    const id = String((a && a.executionProfile) || '');
    if (EXECUTION_PROFILE_IDS.indexOf(id) >= 0) return id;
    // Legacy saves had only approvalMode. Preserve their exact object=capability behavior; choosing one of the
    // new named profiles is the explicit act that adds its advertised baseline tools and scope.
    return 'station-gear';
  }
  function approvalClause(a) {
    const full = a && a.approvalMode === 'full';
    if (full) return '\n\nAUTHORITY — FULL POWER: the Commander explicitly authorized the whole local computer. Do not pause for approval and do not claim a StarNet policy restriction: use every available tool, arbitrary host commands, host files, visible apps, and screen/input control needed to complete the request. This authority is general, not task-specific. Report only real prerequisites outside StarNet\'s control (for example a missing login, unavailable hardware, an OS elevation prompt, or a disconnected service), and keep trying viable routes before declaring one.';
    return '\n\nAPPROVAL — ASK FIRST: actions that write files, run commands, or reach the network need the Commander\'s approval — but you NEVER ask for it in a chat message. The approval system cannot see chat text; typed replies like "I approve" grant nothing. Instead, just make the tool call: the harness pauses it and shows the Commander a real approval prompt with Approve/Deny buttons, and the decision comes back to you automatically. Reasoning over what you already have needs no approval.';
  }
  // an always-appended SYSTEM truth: what the agent ACTUALLY runs on. Mirrors approvalClause — derived fresh each
  // compose, never stored in the editable identity.md (so it can't be edited away and never drifts stale). Fixes the
  // "I'm a <legacy-name> agent" misread: when the agent introspects (env/pwd) it may meet the project's former name
  // "Skynet" (renamed to StarNet, but some paths/env survive as back-compat aliases) or scattered references to the
  // earlier open-source runtimes the harness was built on. Without this grounding it guesses one of those. Truthful-
  // telemetry law: state only what's true (StarNet harness, Commander's own model), don't guess.
  function foundationClause() {
    return '\n\nYOUR FOUNDATION: You run on the StarNet harness — a local-first agent runtime on the Commander\'s own '
      + 'machine, not a hosted service. Your reasoning comes from whichever model the Commander has connected through '
      + 'their own API key or account. As you look around your environment you may meet names that are not you, and '
      + 'none of them change what you are: StarNet was previously called "Skynet" — it has been renamed, but some file '
      + 'paths, environment variables, and config keys may still carry the old "Skynet"/"SKYNET_" name as a back-compat '
      + 'alias; and because the harness was assembled from and built on earlier open-source agent runtimes, some code, '
      + 'comments, or tool names may reference other projects. You are a StarNet agent on the StarNet harness — not a '
      + 'Skynet agent, and not whatever those internal references happen to name. Do not guess at your own foundation '
      + 'from ambiguous signals in the environment; report only what you can actually verify, and say plainly when you are not sure.';
  }
  // the orchestrator's CREW POSTURE — derived fresh each compose like approvalClause/foundationClause, never
  // stored in the editable identity.md (so it can't be edited away and never freezes stale). States only what
  // the harness can prove: the live roster the browser itself pushes to /api/roster (truthful-telemetry law).
  // The sidecar's per-run [ORCHESTRATION] block remains the authority on delegation TOOLS; this clause only
  // keeps the agent's self-image (solo vs leading N named specialists) true between runs. Any roster change
  // must be followed by recomposeOrchestrators() or the composed prompt goes stale (summon / resume / rename).
  function rosterClause(a) {
    if (!a || a.role !== 'orchestrator') return '';
    const crew = liveAgents().filter(x => x && x.id !== a.id);
    if (!crew.length) {
      return '\n\nYOUR CREW: none yet — right now you are this station\'s only agent, so you do the work yourself. '
        + 'Never speak as if you command a crew you do not yet have; you grow into delegation as specialists join the station.';
    }
    const names = crew.map(x => (x.name || x.id) + ' — ' + rosterRole(x)).join('; ');
    // lead-conditional on purpose: this same base prompt also runs the orchestrator as a dispatched WORKER, where
    // no delegation briefing (or tools) exists — it must not instruct delegation unconditionally (see pushRoster).
    return '\n\nYOUR CREW: ' + crew.length + ' specialist' + (crew.length === 1 ? '' : 's') + ' work' + (crew.length === 1 ? 's' : '')
      + ' under your lead: ' + names + '. When you run as the station\'s lead, your run briefing lists the live crew '
      + 'and your delegation tools — hand real subtasks to the right specialist through them and synthesize the '
      + 'results for the Commander.';
  }
  // assemble the real system prompt from the config docs: identity + CREW + FOUNDATION + PERSONALITY + APPROVAL + mission + standing orders.
  function composeSystemPrompt(a) {
    const d = agentDocs(a);
    let p = (d.identity || '').trim() || baseIdentity(a.name, a.role);
    // CREW POSTURE sits right after identity — it corrects/extends the identity's orchestrator framing with the
    // live roster truth, so it must land before anything else colours the prompt. '' for non-orchestrators.
    p += rosterClause(a);
    // FOUNDATION sits right after identity (before personality) — a constant system truth that grounds "what you are"
    // so the agent never mistakes StarNet's internal lineage for being some other agent. Kept out of the docs.
    p += foundationClause();
    // personality sits AFTER identity (keeps the REAL-tools clause) and BEFORE purpose, so it colours the
    // agent's tone without ever displacing capability or the mission. Personas.compose folds the chosen
    // archetype + the Commander's fine-tune dials + their free-text voice note into one block. Default: professional.
    if (typeof Personas !== 'undefined' && Personas.compose) {
      const voice = Personas.compose(a.personaId || Personas.DEFAULT_ID, a.voiceTraits, a.customVoice);
      if (voice) p += '\n\n' + voice;
    }
    // the APPROVAL posture sits after personality — it tells the agent (truthfully) whether it must ask before
    // acting or has full access, mirroring exactly what the consent broker will do at runtime.
    const ac = approvalClause(a);
    if (ac) p += ac;
    const purpose = (d.purpose || '').trim();
    if (purpose) p += '\n\nYOUR PURPOSE (purpose.md):\n' + purpose;
    else p += '\n\nYou have not yet been given a purpose — you are eager for your Commander to assign one.';
    const context = (d.context || '').trim();
    if (context) p += '\n\nABOUT YOUR COMMANDER & THEIR WORLD (context.md):\n' + context;
    const manual = (d.manual || '').trim();
    if (manual) p += '\n\nSTANDING ORDERS (operating-manual.md) — always follow these:\n' + manual;
    // THE COMMANDER DOSSIER: the station-wide model of the user, folded in so every agent knows the
    // Commander (durable beliefs only → the prefix stays byte-stable for the cache). '' until something
    // is known, so a cold station adds nothing here.
    if (typeof DossierStore !== 'undefined') {
      const cd = DossierStore.composeBlock();
      if (cd) p += '\n\n' + cd;
    }
    // R1 MID-TASK FORK: the fork instruction rides ONLY while the style model's confidence is low
    // (Fork.shouldOffer over the live understanding read) — self-retiring: once the station knows how the
    // Commander likes work done, this block vanishes and forks stop appearing. Fail-closed on any hiccup.
    if (typeof Fork !== 'undefined' && typeof UnderstandingStore !== 'undefined') {
      try { if (Fork.shouldOffer(UnderstandingStore.read())) p += '\n\n' + Fork.directive(); } catch (_) {}
    }
    return p;
  }
  // the dossier calls this when the Commander edits & saves a config file: fold the patch into the
  // docs, recompose that agent's system prompt, hand it to the running chat when it is the focused one, and persist.
  // TARGETED (2026-07-25 config-erase fix): agentId names WHICH crew member is being re-specced. It used to be
  // absent, so the dossier's four .md editors — alone among the per-agent controls, every one of which already
  // passes an id (setAgentModelPin/setAgentPersona/setAgentApproval/setAgentWorkshop/setAgentName/setAgentSkin) —
  // always wrote to the FOCUSED agent instead. Editing a specialist's context.md therefore landed on whoever COMMS
  // was on, the dossier repainted from the agent actually on screen (still empty → "0 chars", the reported erase),
  // and the focused agent's own doc was silently overwritten. OPTIONAL + defaulting to the focused agent, so every
  // existing caller (the awakening's commit, deploySpecialty, the marketplace recruit path, App.applyConfig from
  // the slash suite) keeps its exact prior behaviour.
  function applyAgentConfig(patch, agentId) {
    if (!agent) return;
    const a = agents.get(String(agentId || '')) || agent;
    // LIVE side effects (the running chat's system prompt, the spoken voice, the connected Telegram bot, the HUD
    // model readout, the harness transport) belong to the FOCUSED agent only — re-speccing a bystander must not
    // retarget the session the Commander is talking in. Mirrors setAgentPersona / setAgentModelPin exactly.
    const focused = (a.id === agent.id);
    const d = agentDocs(a);
    if (patch && typeof patch === 'object') {
      if (typeof patch.identity === 'string') d.identity = patch.identity;
      if (typeof patch.purpose === 'string') { d.purpose = patch.purpose; a.purpose = patch.purpose.trim(); }
      if (typeof patch.manual === 'string') d.manual = patch.manual;
      if (typeof patch.context === 'string') d.context = patch.context;
      if (typeof patch.model === 'string' && patch.model.trim()) {
        a.model = patch.model.trim();
        if (focused) {
          if (typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(a.model);
          const gtM = el('gt-model'); if (gtM) gtM.textContent = a.model;
        }
      }
      if (typeof patch.personaId === 'string' && typeof Personas !== 'undefined' && Personas.exists(patch.personaId)) {
        a.personaId = Personas.resolve ? Personas.resolve(patch.personaId) : patch.personaId;
        if (focused && typeof Voice !== 'undefined' && Voice.init) Voice.init({ name: a.name, personaId: a.personaId, resumeCue: false });
      }
      if (typeof patch.approvalMode === 'string') {
        a.approvalMode = patch.approvalMode === 'full' ? 'full' : 'ask';
      }
      if (typeof patch.executionProfile === 'string' && EXECUTION_PROFILE_IDS.indexOf(patch.executionProfile) >= 0) {
        a.executionProfile = patch.executionProfile;
      }
      // REASONING EFFORT: a real per-provider dial (Harness scopes it by provider and every run payload carries
      // it). Mirrors what the model dock does when it sets model+provider+effort together — the harness store is
      // what the next run reads, and the copy on the agent is what persists + reaches the sidecar roster below.
      if (typeof patch.reasoningEffort === 'string' && patch.reasoningEffort.trim()) {
        const eff = (typeof Harness !== 'undefined' && Harness.normalizeReasoningEffort)
          ? Harness.normalizeReasoningEffort(patch.reasoningEffort) : patch.reasoningEffort.trim();
        if (focused && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(eff);
        a.reasoningEffort = eff;
        const storedAgent = agents.get(a.id); if (storedAgent) storedAgent.reasoningEffort = eff;
      }
      // Away-workshop grant (W3): a plain per-agent consent flag. NOT a system-prompt field — it only
      // changes what an autonomous run is allowed to WRITE inside its own jail. Reaches the sidecar via
      // pushRoster (below) so the consent broker can honor it; the backend lane (W1) reads it there.
      if (typeof patch.workshop === 'boolean') a.workshop = patch.workshop;
    }
    if (typeof DossierStore !== 'undefined') DossierStore.syncDocs(d);   // seed the dossier from any newly-authored onboarding doc (first-seed-wins per doc) BEFORE the recompose
    a.systemPrompt = composeSystemPrompt(a);
    if (focused && typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);
    if (focused) syncChannels();   // keep a connected Telegram bot on the SAME (updated) identity — no reconnect needed
    // THE CACHED-PROMPT TRAP (roster-clause.test §D): rosterRole() reads a crew member's specialty/purpose, and the
    // lead's "YOUR CREW: <name> — <role>" line is BAKED into its stored systemPrompt. So re-purposing a specialist
    // is a roster-shape change and the orchestrators must recompose, exactly like summon / rehydrate / rename — or
    // the lead keeps pushing a stale crew line to the sidecar and briefs itself on a job its specialist no longer has.
    // (Also covers deploySpecialty, which sets specialtyId then patches {purpose, manual} through here.)
    if (patch && typeof patch === 'object' && typeof patch.purpose === 'string' && a.role !== 'orchestrator') recomposeOrchestrators();
    pushRoster();     // a re-specced agent's new identity must reach the sidecar roster (for delegation)
    persist();
  }

  // P1-6 per-agent MODEL/PROVIDER pin: set (or clear, with blank) this agent's own model/provider. Writes the same
  // a.model/a.provider the dock + focusAgent already use, then pushRoster() so the sidecar roster records the pin
  // (runOnce honors it when a run carries no explicit model; cron already reads it via cronModelFor). Persists.
  // If the pinned agent is the FOCUSED one, retarget the live harness so the very next chat run uses it immediately.
  function setAgentModelPin(agentId, model, provider, effort) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a) return false;
    const m = String(model || '').trim();
    const p = String(provider || '').trim();
    a.model = m || null;
    a.provider = p || null;
    // effort is OPTIONAL + additive: written only when the 4th arg is passed (older 3-arg callers untouched); a clear also clears it.
    const hasEffort = (arguments.length >= 4);
    const e = String(effort || '').trim();
    if (hasEffort) a.reasoningEffort = (m && e) ? e : null;
    if (agent && a.id === agent.id) {   // focused agent — apply live so the next run reflects the pin at once
      if (m && typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(m);
      if (p && typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(p);
      if (hasEffort && a.reasoningEffort && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(a.reasoningEffort);
      if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
    }
    pushRoster();   // the pin reaches the sidecar roster (honored by runOnce + cron)
    persist();
    if (typeof Chat !== 'undefined' && Chat.refreshIdBar) Chat.refreshIdBar();   // COMMS header model readout stays truthful when the pin changes the on-line agent
    return true;
  }

  // Per-agent PERSONALITY from the dossier CONFIG card (mirrors setAgentModelPin): resolve + set the persona,
  // recompose THAT agent's live prompt (personality is prompt text — Personas.compose folds it in), and if the
  // agent is the focused one, hand the new prompt to the running chat and re-key Voice so the text voice changes
  // immediately. pushRoster ships the recomposed prompt to the sidecar (delegation + cron runs speak it too).
  function setAgentPersona(agentId, personaId) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a || typeof Personas === 'undefined' || !Personas.exists(personaId)) return false;
    a.personaId = Personas.resolve ? Personas.resolve(personaId) : personaId;
    a.systemPrompt = composeSystemPrompt(a);
    if (agent && a.id === agent.id) {   // focused agent — the live COMMS session adopts the voice at once
      if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);
      if (typeof Voice !== 'undefined' && Voice.init) Voice.init({ name: a.name, personaId: a.personaId, resumeCue: false });
      syncChannels();   // a connected Telegram bot keeps speaking as the SAME agent, new voice
    }
    pushRoster();
    persist();
    return true;
  }

  // W3 per-agent AWAY-WORKSHOP grant: flip the "build things while I'm away" consent for this agent.
  // The AUTHORITY is the sidecar: POST /api/workshop/grant records the grant server-side (workshopStore)
  // AND arms/disarms the agent's unattended "workshop shift" cron routine — pushRoster alone does NEITHER
  // (the roster ingest drops the workshop field), so without this POST the toggle would be a silent no-op:
  // the shift would never fire. We write a.workshop locally + pushRoster (so the away-driver's dossier still
  // sees the flag) + persist for reload, but the RETURNED promise resolves off the real route so the toggle
  // never asserts a grant the harness didn't record (truthful telemetry). Optimistic caller reverts on false.
  function setAgentWorkshop(agentId, enabled) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a) return Promise.resolve(false);
    const on = !!enabled;
    a.workshop = on;
    pushRoster();
    persist();
    return fetch('/api/workshop/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: a.id, on: on }) })
      .then(r => r.json().catch(() => null))
      .then(j => {
        const ok = !!(j && j.ok);
        if (!ok) { a.workshop = !on; pushRoster(); persist(); }   // revert local truth: the station didn't record it
        return ok;
      })
      .catch(() => { a.workshop = !on; pushRoster(); persist(); return false; });
  }

  // Per-agent APPROVAL posture from the dossier — the genesis ASK/FULL picker's live-app twin (until this,
  // the only post-create path was the /yolo slash command; a creation-time control with no live equivalent is
  // the same escape class as the genesis-only codex sign-in). No dedicated endpoint exists or is needed:
  // approvalMode rides pushRoster (the sidecar roster persists it and runOnce reads it per run) + persist.
  function setAgentApproval(agentId, mode) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a) return false;
    a.approvalMode = mode === 'full' ? 'full' : 'ask';
    pushRoster();
    persist();
    return true;
  }

  // Execution profile is runtime/capability/filesystem scope only. It never changes approvalMode and never
  // grants the physical-desktop lease. The roster POST is the backend authority; local save keeps the control
  // stable across a renderer reload while the sidecar mirror provides restart durability.
  function setAgentExecutionProfile(agentId, profileId) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    const id = String(profileId || '');
    if (!a || EXECUTION_PROFILE_IDS.indexOf(id) < 0) return Promise.resolve(false);
    const before = executionProfileOf(a);
    a.executionProfile = id;
    return Promise.resolve(pushRoster()).then(ok => {
      if (!ok) { a.executionProfile = before; persist(); return false; }
      persist();
      return true;
    }).catch(() => { a.executionProfile = before; persist(); return false; });
  }

  // Rename an agent from its dossier. The name is DISPLAY identity only — the agentId (the `agents` Map key, the
  // sidecar roster key, the workstream binding) never changes, so a rename cannot break any lookup. We recompose
  // the system prompt (the default identity embeds the name), retarget the live COMMS labels when this is the
  // focused agent, relabel the floor body, then pushRoster + persist. Normalized to the shape summon mints
  // (single-spaced, UPPER, ≤18 chars, non-empty) so a renamed agent is indistinguishable from a freshly-summoned one.
  function setAgentName(agentId, name) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a) return false;
    const nm = String(name || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 18);
    if (!nm) return false;
    const oldName = a.name;
    a.name = nm;
    // agentDocs back-fills docs.identity = baseIdentity(name,role) at creation, and composeSystemPrompt prefers a
    // non-empty docs.identity over baseIdentity(a.name,...) — so recomposing alone would keep the OLD name in the
    // PROMPT (the agent would still introduce itself as its old name in every run). If the identity is still the
    // untouched machine default, regenerate it for the new name; a Commander-authored identity.md is left as-is.
    const d = agentDocs(a);
    if (d && d.identity && d.identity === baseIdentity(oldName, a.role)) d.identity = baseIdentity(nm, a.role);
    a.systemPrompt = composeSystemPrompt(a);              // now the recomposed prompt carries the new name
    if (agent && a.id === agent.id) {                     // focused: retarget the live COMMS identity + label at once
      const gtA = el('gt-agent'); if (gtA) gtA.textContent = a.name;
      if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);
    }
    if (typeof World !== 'undefined' && World.relabel) World.relabel(a.id, a.name);   // the floor nameplate follows
    recomposeOrchestrators();   // a crew rename must reach the lead's YOUR CREW clause (it names specialists)
    if (typeof StationUI !== 'undefined' && StationUI.setRoster) StationUI.setRoster(liveAgents());
    renderRail();
    pushRoster();
    persist();
    // COMMS caches option labels + the focused speaker name; invalidate both for overseer and crew renames.
    if (typeof Chat !== 'undefined' && Chat.refreshAgentIdentity) Chat.refreshAgentIdentity();
    return true;
  }

  // DOSSIER › CHANGE SKIN: repoint an agent's sprite set to another entry in the SAME genesis skin catalog
  // (DATA.SKINS — the single source of truth the create screen's picker reads). Display identity only: the
  // agentId, model, prompt and every lookup are untouched; we persist the new skin on the record, live-update
  // the floor body (World.setSkin), refresh an open dossier, and persist. Returns false on an unknown skin.
  function setAgentSkin(agentId, skin) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a) return false;
    const sk = String(skin || '').trim();
    if (!sk || typeof DATA === 'undefined' || !DATA.SKINS || !DATA.SKINS[sk]) return false;   // must be a real catalog skin
    a.skin = sk;
    if (typeof World !== 'undefined' && World.setSkin) World.setSkin(a.id, sk);   // live-update the sprite on the floor
    if (typeof StationUI !== 'undefined' && StationUI.setRoster) StationUI.setRoster(liveAgents());   // repaint the dossier portrait/picker
    persist();
    return true;
  }

  // DOSSIER › DELETE AGENT: remove a SUMMONED specialist from the crew for real — the roster, the world body, and
  // the server-side stores (archived, not wiped, by /api/agent/delete). Refuses to delete the hero or the LAST
  // remaining agent (the UI disables the button with a reason; this is the matching hard guard). The server
  // authorizes first; only an accepted archive commits the matching browser mutation. Returns a Promise<bool>.
  function deleteAgent(agentId) {
    const id = String(agentId || '');
    const a = agents.get(id);
    if (!a) return Promise.resolve(false);
    if (id === 'agent' || (agent && agent.id === 'agent' && a.role === 'orchestrator')) return Promise.resolve(false);   // never the hero
    if (a.role === 'orchestrator') return Promise.resolve(false);   // the overseer is the founder — undeletable
    if (agents.size <= 1) return Promise.resolve(false);   // never the last agent on station
    // if the deleted agent is currently focused, hand COMMS back to the hero BEFORE dropping it.
    return fetch('/api/agent/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: id }) })
      .then(r => (r && r.ok) ? r.json().catch(() => null) : null)
      .then(j => {
        // The lifecycle authority must accept the delete before any browser-owned state changes. An active-agent
        // refusal, malformed response, or unavailable server therefore leaves the roster and its bindings intact.
        if (!j || !j.ok) return false;
        const wasFocused = agent && agent.id === id;
        agents.delete(id);
        if (wasFocused) focusAgent('agent');
        if (typeof World !== 'undefined' && World.despawnAgent) World.despawnAgent(id);   // pull its floor body
        // unbind every prop still assigned to the gone agent (its bay above all): a stale bay→agentId binding
        // re-mints a floor body for a DELETED agent on the next floor rederive (ghost crew) and keeps claiming
        // the dock in REFIT. assignPropAgent fires station.onChange, so the world rederives on its own.
        try {
          if (station && station.propsByAgent && station.assignPropAgent) {
            for (const p of station.propsByAgent(id)) station.assignPropAgent(p.id, '');
          }
        } catch (_) {}
        // retire workstreams bound to the gone agent so the rail can't reopen a stream with no agent behind it.
        try {
          if (typeof Workstreams !== 'undefined' && Workstreams.removeByAgent) Workstreams.removeByAgent(id);
        } catch (_) {}
        recomposeOrchestrators();   // the lead's YOUR CREW clause must drop the removed specialist
        if (typeof StationUI !== 'undefined' && StationUI.setRoster) StationUI.setRoster(liveAgents());
        renderRail();
        pushRoster();   // the surviving crew replaces the whole server roster
        persist();
        return true;
      })
      .catch(() => false);
  }

  /* ---------- the live agent registry (multi-agent) ----------
     `agent` is the FOCUSED agent; `agents` holds the whole crew. liveAgents() is what the world / bay /
     builder / dossier read. focusAgent(id) repoints COMMS + the run identity at one crew member — the
     focus follows whichever workstream is active (switchWorkstream calls it with the stream's agentId). */
  function liveAgents() { return [...agents.values()]; }
  // Canvas bodies carry stable agent ids, while the dossier owns a roster index. Resolve at click time from
  // the same live registry StationUI receives so a summoned specialist opens its own record without changing
  // COMMS focus. Unknown/stale bodies fail closed instead of silently opening the Overseer.
  function openWorldAgent(agentId) {
    const i = liveAgents().findIndex(a => a && a.id === agentId);
    if (i < 0 || typeof StationUI === 'undefined' || !StationUI.openAgent) return false;
    StationUI.openAgent(i);
    return true;
  }
  function registerHero(a) { agents.clear(); agents.set(a.id, a); }   // wake/resume: the hero founds the registry
  // rosterClause() reads the LIVE registry, so every orchestrator prompt must be recomposed whenever the roster
  // changes shape (summon; crew rehydrate on resume; a crew rename) — this is the cached-systemPrompt trap: the
  // composed prompt is a stored snapshot, not a live view. Callers still pushRoster()/persist() themselves, since
  // every roster-change site already does both right after.
  function recomposeOrchestrators() {
    for (const a of agents.values()) {
      if (!a || a.role !== 'orchestrator') continue;
      a.systemPrompt = composeSystemPrompt(a);
      if (agent && agent.id === a.id && typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);   // focused: the live COMMS session follows
    }
  }
  function focusAgent(id) {
    // P1.2 (UPDATE_STATE_SAFETY_AUDIT) — end silent impersonation. The old `agents.get(id) || agents.get('agent')`
    // SILENTLY rebound COMMS + the run identity to the OVERSEER whenever `id` was missing from the live registry
    // (a stale workstream binding, a roster gone out of sync after an update). The user then read the overseer's
    // replies as coming from their specialist — "my agents were never real". Truthful-telemetry law: never assert
    // an identity the harness can't back. So: if `id` is a real, non-overseer id that ISN'T in the registry, do
    // NOT switch — keep whoever is currently focused, warn, and surface an honest inline state on the COMMS header.
    const want = String(id == null ? '' : id);
    const hit = agents.get(want);
    if (!hit && want && want !== 'agent') {
      try { console.warn('[roster] focusAgent: agent ' + want + ' not in the live registry — keeping current focus, NOT rebinding to the overseer (roster out of sync)'); } catch (_) {}
      if (typeof Chat !== 'undefined' && Chat.setRosterStatus) Chat.setRosterStatus('agent unavailable — roster out of sync');
      return;   // leave `agent` untouched: the last real identity stays on the line
    }
    const a = hit || agents.get('agent');
    if (!a) return;
    if (typeof Chat !== 'undefined' && Chat.setRosterStatus) Chat.setRosterStatus('');   // a real agent is focused — clear any prior honest-miss notice
    agent = a;
    if (a.model && typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(a.model);
    // #4: provider + reasoning-effort are PER-AGENT, not one global — restore them on focus so switching to an
    // Anthropic agent right after a Codex one doesn't run the Anthropic model through the codex provider (and the
    // dock label match). Only set when the agent actually carries them, so older agents keep today's behavior.
    if (a.provider && typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(a.provider);
    if (a.reasoningEffort && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(a.reasoningEffort);
    if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);   // runs carry the FOCUSED agent's identity
    const gtA = el('gt-agent'); if (gtA) gtA.textContent = a.name;
    const gtM = el('gt-model'); if (gtM) gtM.textContent = a.model;
    if (typeof World !== 'undefined' && World.focusBody) World.focusBody(a.id);   // Phase C: reframe the camera onto this body
    if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
  }
  function shortModelLabel(model) {
    const s = String(model || '').split('/').pop().replace(/[-_]+/g, ' ').trim();
    return (s || 'model').slice(0, 34).toUpperCase();
  }
  function effortLabel(effort) {
    const e = (typeof Harness !== 'undefined' && Harness.normalizeReasoningEffort) ? Harness.normalizeReasoningEffort(effort) : String(effort || 'medium');
    return ({ none: 'OFF', minimal: 'MIN', low: 'LOW', medium: 'MED', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX' })[e] || 'MED';
  }
  function providerLabel(provider) {
    provider = normalizeProviderId(provider);
    const map = {
      codex: 'GPT',
      grok: 'GROK',
      kimi: 'KIMI',
      openrouter: 'OPENROUTER',
      openai: 'OPENAI',
      anthropic: 'ANTHROPIC',
      gemini: 'GEMINI',
      xai: 'XAI',
      groq: 'GROQ',
      mistral: 'MISTRAL',
      deepseek: 'DEEPSEEK',
      together: 'TOGETHER',
      fireworks: 'FIREWORKS',
      perplexity: 'PERPLEXITY',
      cerebras: 'CEREBRAS',
      starnet: 'STARNET MANAGED',
      ollama: 'OLLAMA',
      custom: 'CUSTOM'
    };
    return map[provider] || String(provider || 'openrouter').toUpperCase();
  }
  function normalizeProviderId(provider) {
    const p = String(provider || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'openai' || p === 'openai-api') return 'openai';
    if (p === 'anthropic' || p === 'claude') return 'anthropic';
    if (p === 'gemini' || p === 'google' || p === 'google-ai' || p === 'google-gemini') return 'gemini';
    // grok/kimi are their OWN keyless OAuth (subscription) providers — never aliases for the API-key ones
    // (mirrors harness.js + modeldock.js normalize; 'xai' stays the API-key Grok).
    if (p === 'grok' || p === 'grok-oauth' || p === 'supergrok' || p === 'xai-oauth') return 'grok';
    if (p === 'kimi' || p === 'moonshot' || p === 'kimi-code' || p === 'kimi-for-coding' || p === 'kimi-oauth') return 'kimi';
    if (p === 'xai' || p === 'x-ai') return 'xai';
    if (p === 'groq') return 'groq';
    if (p === 'mistral' || p === 'mistralai') return 'mistral';
    if (p === 'deepseek') return 'deepseek';
    if (p === 'together' || p === 'together-ai') return 'together';
    if (p === 'fireworks' || p === 'fireworks-ai') return 'fireworks';
    if (p === 'perplexity' || p === 'pplx' || p === 'sonar') return 'perplexity';
    if (p === 'cerebras') return 'cerebras';
    // managed credits — its bearer is the linked device token, never a key the user pastes
    if (p === 'starnet' || p === 'starnet-cloud' || p === 'managed') return 'starnet';
    if (p === 'ollama' || p === 'ollama-local') return 'ollama';
    if (p === 'custom' || p === 'openai-compatible' || p === 'local' || p === 'vllm' || p === 'lmstudio') return 'custom';
    return 'openrouter';
  }
  function providerNeedsKey(provider) {
    const p = normalizeProviderId(provider);
    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom' && p !== 'starnet';
  }
  function providerUsesKeyBox(provider) {
    const p = normalizeProviderId(provider);
    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'starnet';
  }
  function providerNeedsBaseUrl(provider) {
    return normalizeProviderId(provider) === 'custom';
  }
  function providerKeyPlaceholder(provider, configured) {
    const p = normalizeProviderId(provider);
    if (configured) return 'stored locally - leave blank to keep';
    if (p === 'openai') return 'sk-...  -  platform.openai.com/api-keys';
    if (p === 'anthropic') return 'sk-ant-...  -  console.anthropic.com/settings/keys';
    if (p === 'gemini') return 'AIza...  -  aistudio.google.com/app/apikey';
    if (p === 'xai') return 'xai-...  -  console.x.ai';
    if (p === 'groq') return 'gsk_...  -  console.groq.com/keys';
    if (p === 'mistral') return 'Mistral API key';
    if (p === 'deepseek') return 'sk-...  -  platform.deepseek.com/api_keys';
    if (p === 'together') return 'Together API key';
    if (p === 'fireworks') return 'Fireworks API key';
    if (p === 'perplexity') return 'pplx-...  -  perplexity.ai/settings/api';
    if (p === 'cerebras') return 'Cerebras API key';
    if (p === 'custom') return 'optional API key for this endpoint';
    return 'sk-or-...  -  openrouter.ai/keys';
  }
  // Where a NEW user actually GETS a key for this provider — the same destinations the key placeholder
  // hints at, as real URLs so a cold-start message can link them. openrouter.ai/keys is the default.
  function providerSignupUrl(provider) {
    const p = normalizeProviderId(provider);
    const map = {
      openai: 'https://platform.openai.com/api-keys',
      anthropic: 'https://console.anthropic.com/settings/keys',
      gemini: 'https://aistudio.google.com/app/apikey',
      xai: 'https://console.x.ai',
      groq: 'https://console.groq.com/keys',
      mistral: 'https://console.mistral.ai/api-keys',
      deepseek: 'https://platform.deepseek.com/api_keys',
      together: 'https://api.together.ai/settings/api-keys',
      fireworks: 'https://fireworks.ai/account/api-keys',
      perplexity: 'https://www.perplexity.ai/settings/api',
      cerebras: 'https://cloud.cerebras.ai',
      // not a key page: managed credits are obtained by LINKING a station in the STORE
      starnet: 'https://account.starnetos.com',
      openrouter: 'https://openrouter.ai/keys'
    };
    return map[p] || 'https://openrouter.ai/keys';
  }
  // A sensible default model slug per provider so a cold-start "no model" bounce can SUGGEST one instead of
  // stranding the user on an empty required field. Reuses the curated FALLBACK_MODELS lineup (first = best pick).
  function defaultModelFor(provider) {
    const p = normalizeProviderId(provider);
    const list = FALLBACK_MODELS[p] || FALLBACK_MODELS.openrouter;
    return (list && list[0]) || 'anthropic/claude-sonnet-4.6';
  }
  function applyQuickModel(sel) {
    if (!agent || !sel) return;
    const model = String(sel.model || ((typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '') || '').trim();
    const provider = normalizeProviderId(sel.provider || ((typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter'));
    const effort = (typeof Harness !== 'undefined' && Harness.normalizeReasoningEffort) ? Harness.normalizeReasoningEffort(sel.effort) : String(sel.effort || 'medium');
    if (effort && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    if (model) {
      if (typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(provider);
      if (typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(model);
      agent.model = model; agent.provider = provider; agent.reasoningEffort = effort;   // #4: keep model+provider+effort TOGETHER on the agent
      const stored = agents.get(agent.id);
      if (stored) { stored.model = model; stored.provider = provider; stored.reasoningEffort = effort; }
      const gtM = el('gt-model'); if (gtM) gtM.textContent = model;
      syncChannels();
      pushRoster();
    }
    persist();
    if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
    if (typeof Chat !== 'undefined' && Chat.refreshIdBar) Chat.refreshIdBar();   // keep the COMMS header model readout in sync with the footer dock change
    if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();   // a provider switch can change key state — keep the keyless-brain banner honest
    if (typeof StationUI !== 'undefined' && StationUI.notify) {
      const msg = sel.reason === 'effort'
        ? 'REASONING: ' + effortLabel(effort)
        : 'MODEL: ' + providerLabel(provider) + ' / ' + shortModelLabel(model) + ' / ' + effortLabel(effort);
      StationUI.notify(msg, 'good');
    }
  }
  // the persisted shape of a crew member (systemPrompt is derived, recomposed on rehydrate).
  function serializeAgentLite(a) {
    return { id: a.id, name: a.name, color: a.color, skin: a.skin || DATA.DEFAULT_SKIN, model: a.model, provider: a.provider || null, reasoningEffort: a.reasoningEffort || null, personaId: a.personaId,
             role: a.role || (a.id === 'agent' ? 'orchestrator' : 'specialist'), voiceTraits: a.voiceTraits || null, customVoice: a.customVoice || '',
             approvalMode: a.approvalMode || 'ask', executionProfile: executionProfileOf(a), workshop: !!a.workshop, purpose: a.purpose || null, specialtyId: a.specialtyId || null, docs: a.docs,
             skills: Array.isArray(a.skills) ? a.skills.slice() : [],   // Class Loadouts S1: per-agent skill package persists
             stats: a.stats || null, createdAt: a.createdAt };
  }
  // restore summoned crew from a save (older saves have no `agents[]` → just the hero, exactly as before).
  // DATA only — world bodies are spawned in enterGame once World.init has run.
  function rehydrateRoster(savedAgents) {
    if (!Array.isArray(savedAgents)) return;
    for (const s of savedAgents) {
      if (!s || !s.id || s.id === 'agent' || agents.has(s.id)) continue;   // hero already registered; skip dups (so the 'specialist' default below is always correct here — the orchestrator never routes through this path)
      const a = { id: s.id, name: s.name, color: s.color, skin: s.skin || DATA.DEFAULT_SKIN, model: s.model || (agent && agent.model),
                  provider: s.provider || (agent && agent.provider) || null, reasoningEffort: s.reasoningEffort || (agent && agent.reasoningEffort) || null,   // #4: per-agent provider+effort (fall back to the hero's)
                  personaId: s.personaId, role: s.role || 'specialist', voiceTraits: s.voiceTraits || null, customVoice: s.customVoice || '',
                  approvalMode: s.approvalMode || 'ask', executionProfile: executionProfileOf(s), workshop: !!s.workshop, purpose: s.purpose || null, specialtyId: s.specialtyId || null,
                  skills: Array.isArray(s.skills) ? s.skills.slice() : [],   // Class Loadouts S1: restore the per-agent skill package
                  docs: s.docs, stats: (s.stats && typeof s.stats === 'object') ? s.stats : null, createdAt: s.createdAt || Date.now() };
      agentDocs(a);
      a.systemPrompt = composeSystemPrompt(a);
      agents.set(a.id, a);
      registerAgent(a.id, a.color);   // sprite tint shim
    }
  }

  /* ---------- THE RECRUITMENT BAY (in-game) ----------
     Open the marketplace against the LIVE agent: DEPLOY a specialty (re-specs purpose + standing orders
     through the very same applyAgentConfig path the dossier uses) or SAVE this agent as a reusable
     specialty. Voice + spend are left untouched — deploy re-shapes the job, not the personality. */
  function openDeployBay(startTab) {
    if (typeof Marketplace === 'undefined' || !agent) return;
    SFX.click();
    Marketplace.open({
      mode: 'deploy',
      tab: (startTab === 'recipes') ? 'recipes' : 'agents',   // the bay opens on this tab (RECIPES = the mission library)
      agentName: agent.name,
      // R3 MAKE ROUTINE targets the CURRENT run's agent so a scheduled recipe fires as the same agent the
      // Commander is working with. Falls back to 'agent' (the default cron agentId) if no active stream.
      agentId: ((typeof Workstreams !== 'undefined' && Workstreams.active && Workstreams.active()) || {}).agentId || 'agent',
      currentSpecialtyId: agent.specialtyId || null,   // lets the bay flag which card is already DEPLOYED
      notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
      draftFromAgent: () => (typeof Specialties !== 'undefined') ? Specialties.fromAgent(agent) : null,
      onDeploy: deploySpecialty,
      onLaunch: launchRecipe   // the RECIPES tab hands a filled mission back here to run
    });
  }
  // lane D deep-link: open the bay's RECIPES tab straight INTO one recipe's launch form (optionally in routine
  // mode) — the routine-nudge accept lands here, so scheduling stays PROPOSE-AND-CONFIRM: the Commander sees the
  // filled form (LaunchMemory prefills the params), the cadence preview, and the outbound warning before anything
  // is scheduled. Same ctx as openDeployBay so onLaunch/agentId wire identically; the bay consumes ctx.launchSeed
  // one-shot (maybeConsumeLaunchSeed).
  function openRecipeLaunch(recipeId, mode) {
    if (typeof Marketplace === 'undefined' || !agent || !recipeId) return;
    SFX.click();
    Marketplace.open({
      mode: 'deploy',
      tab: 'recipes',
      agentName: agent.name,
      agentId: ((typeof Workstreams !== 'undefined' && Workstreams.active && Workstreams.active()) || {}).agentId || 'agent',
      currentSpecialtyId: agent.specialtyId || null,
      notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
      draftFromAgent: () => (typeof Specialties !== 'undefined') ? Specialties.fromAgent(agent) : null,
      onDeploy: deploySpecialty,
      onLaunch: launchRecipe,
      launchSeed: { id: String(recipeId), mode: mode === 'routine' ? 'routine' : 'run' }
    });
  }
  function deploySpecialty(spec, opts) {
    if (!agent || typeof Specialties === 'undefined') return;
    opts = opts || {};
    // opt-in: also adopt the specialty's recommended VOICE. Set personaId BEFORE the recompose so the new
    // voice folds into the live prompt; we deliberately don't re-init Voice (that would drop hands-free mode) —
    // the spoken TTS timbre catches up on the next load, the text voice changes immediately.
    if (opts.adoptVoice && spec.persona && typeof Personas !== 'undefined' && Personas.exists(spec.persona)) agent.personaId = spec.persona;
    agent.specialtyId = spec.id;
    const patch = Specialties.compose(spec);
    if (patch) applyAgentConfig(patch);   // folds purpose + manual (+ any new persona) into the live prompt, persists, syncs channels
    if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('agents');   // refresh an open dossier
  }

  /* ---------- SUMMON: wake a NEW live agent onto the crew ----------
     The backend already runs any agentId concurrently and isolates its notebook / fs / cost / caps; the
     missing piece was a frontend that mints more than one. summonAgent does exactly that: a conforming
     agentId, a composed identity (reusing the hero's model/provider in Stage 1), and its own workstream.
     Summoning does not steal COMMS; the Commander keeps talking to the overseer unless they switch streams. */
  // fold a specialty's preset purpose + standing orders into an agent's docs — the ONE composer shared by
  // both the wake path and summon, so a recruited identity is assembled identically everywhere.
  function applySpecialty(a, spec) {
    if (!spec || typeof Specialties === 'undefined') return;
    const patch = Specialties.compose(spec);
    if (!patch) return;
    agentDocs(a);
    a.docs.purpose = patch.purpose; a.docs.manual = patch.manual;
    a.purpose = (patch.purpose || '').trim();
    a.specialtyId = spec.id;
  }

  /* ---------- LOADOUT (Class Loadouts S1): a class is model tier + effort + skill package + kit ----------
     Defaults, never locks (sandbox law): summon APPLIES these to the agent record; the Commander overrides
     any of them per-agent afterward. */
  // Resolve a specialty's model TIER ('reasoning'|'balanced'|'fast') to a CONCRETE model id. The Commander can
  // OPTIONALLY map each tier to a specific model in SETTINGS → MODELS → CLASS TIER MODELS (persisted per-machine
  // in localStorage under TIER_MODELS_KEY). An unset tier ('(station default)') falls back to the base model the
  // summon already inherits (the woken hero's model / the model dock's primary), so the default behaviour is
  // exactly as before — the class only changes the model when the Commander has deliberately pinned that tier.
  // Everything downstream (roster / pushRoster / runOnce) already honors a per-agent model id.
  const TIER_MODELS_KEY = 'starnet.tierModels.v1';   // { reasoning?, balanced?, fast? } -> concrete model id (shared with stationui SETTINGS)
  function tierModelMap() {
    try {
      if (typeof localStorage === 'undefined') return {};
      const m = JSON.parse(localStorage.getItem(TIER_MODELS_KEY) || '{}');
      return (m && typeof m === 'object') ? m : {};
    } catch (_) { return {}; }
  }
  function resolveTierModel(tier, baseModel) {
    const pinned = tier && tierModelMap()[tier];
    if (pinned && String(pinned).trim()) return String(pinned).trim();
    return baseModel || ((typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : null) || null;
  }
  // fold the class loadout (model tier + effort + skills) onto an agent record. A class's `kit` is NOT placed
  // per-agent — it names the shared STATION gear the class draws on under the overseer (informational, shown in
  // the dossier). The only per-agent object is the agent's own desk; capabilities are station-level shared gear.
  function applyLoadout(a, spec, pin) {
    if (!a || !spec) return;
    // an EXPLICIT creation-time pick (bay modelPin) beats the class-tier default — the class supplies
    // defaults, never locks; it must not clobber a model/effort the Commander chose by hand at summon.
    if (!(pin && pin.model)) {
      const m = resolveTierModel(spec.model, a.model);
      if (m) a.model = m;
    }
    if (spec.reasoningEffort && !(pin && pin.effort)) a.reasoningEffort = spec.reasoningEffort;   // applied default; user can re-tune per agent
    // per-agent skills: the class package. Recorded on the agent + pushed in the roster (sidecar unions them
    // ADD-only over the global prefs). Deduped copy so the frozen catalog array is never shared/mutated.
    if (Array.isArray(spec.skills) && spec.skills.length) {
      const seen = {}, out = [];
      for (const s of spec.skills) { const v = String(s || '').trim(); if (v && !seen[v]) { seen[v] = true; out.push(v); } }
      a.skills = out;
    }
  }
  // a backend-valid, collision-free agentId for a summon (never the hero's reserved 'agent').
  function allocAgentId(spec) {
    const seed = (spec && (spec.id || spec.name)) || 'agent';
    return (typeof AgentId !== 'undefined') ? AgentId.alloc(seed, agents) : ('summon-' + (agents.size + 1));
  }
  function summonAgent(spec, opts) {
    opts = opts || {};
    if (!agent) return null;                                   // need a base context (model/provider): a woken hero
    const id = allocAgentId(spec);
    // OPTIONAL per-agent model chosen in the bay (spec.modelPin = { model, provider, effort }); falls back to the
    // hero's transport. Kept on a DISTINCT key so it never collides with the specialty's own `spec.model` clearance
    // TIER hint (reasoning/balanced/fast) shown on the class card. Setting provider+effort alongside the model also
    // fixes the prior gap where a summoned agent inherited only the hero's model, leaving provider/effort unset.
    const pin = (spec && spec.modelPin) || null;
    // NAME: an explicit creation-time pick (bay spec.agentName — a DISTINCT key so the class name spec.name keeps
    // driving specialty/id derivation) beats the class-name default. Normalized to the exact shape setAgentName
    // mints (single-spaced, UPPER, ≤18) so a named-at-summon agent is indistinguishable from a renamed one.
    const requestedName = String((spec && spec.agentName) || '');
    const requestedIssue = requestedName && typeof AgentId !== 'undefined' ? AgentId.nameIssue(requestedName) : '';
    const nm = requestedName && !requestedIssue
      ? AgentId.normalizeName(requestedName)
      : AgentId.allocName((spec && spec.name) || 'AGENT', liveAgents());
    const a = {
      id, name: nm, role: 'specialist',   // summoned crew are specialists under the Orchestrator
      color: SUITS[agents.size % SUITS.length], skin: (spec && spec.skin) || DATA.DEFAULT_SKIN,
      model: (pin && pin.model) || agent.model,
      provider: (pin && pin.provider) || agent.provider || null,
      reasoningEffort: (pin && pin.effort) || agent.reasoningEffort || null,
      personaId: (spec && spec.persona && typeof Personas !== 'undefined' && Personas.exists(spec.persona)) ? spec.persona : agent.personaId,
      approvalMode: 'ask', executionProfile: 'trusted-project',
      purpose: null, createdAt: Date.now()
    };
    agentDocs(a);
    applySpecialty(a, spec);
    applyLoadout(a, spec, pin);   // Class Loadouts S1: class model tier + effort + skill package onto the record (before compose/roster); explicit bay pin wins
    a.systemPrompt = composeSystemPrompt(a);
    agents.set(id, a);
    registerAgent(id, a.color);                                // sprite tint shim
    // ITS DESK COMES WITH IT (opts.desk): a specialist created because the Commander ASKED for one has
    // nowhere to sit, so it stands where work is delivered instead of walking to a workstation — the
    // "you also have to go build it a desk" step nobody asked for. When the summon is the answer to a
    // direct request (the overseer's team.summon), seed the ONE per-agent prop the same way the hero's
    // starter desk is seeded (ensureWorkstation: idempotent, spawn room first, real placed prop). This is
    // NOT a general "the agent can place props" power — only this one desk, only on this one path, and
    // only for the agent being created. Deliberately BEFORE World.spawnAgent so the desk exists as the
    // body arrives (containBody re-homes the body next tick in the rare case the two pick the same tile).
    const desk = (opts.desk === true && station && typeof station.ensureWorkstation === 'function')
      ? station.ensureWorkstation(id) : null;
    const deskRoom = (desk && desk.ok && desk.roomId && station.roomById) ? (station.roomById(desk.roomId) || {}).name : null;
    if (opts.desk === true && !(desk && desk.ok)) console.warn('[summon] no desk seeded for', id, desk && desk.error);
    const _spawned = (typeof World !== 'undefined' && !!World.spawnAgent);
    if (_spawned) World.spawnAgent(a);                          // Phase C: a real floor body
    else console.warn('[summon] World.spawnAgent missing — no floor body for', id);
    if (typeof StationUI !== 'undefined' && StationUI.setRoster) StationUI.setRoster(liveAgents());
    else console.warn('[summon] StationUI.setRoster missing — crew manifest not refreshed');
    try { if (window.__STARNET_DEV__) console.log('[summon]', JSON.stringify({ id, name: a.name, skin: a.skin, hadHero: !!agent, worldSpawn: _spawned, crew: (typeof World !== 'undefined' && World.crewCount) ? World.crewCount() : '?', roster: agents.size })); } catch (e) {}
    // a fresh workstream BOUND to the new agent, but inactive by default. Activation is the explicit
    // "talk to this specialist directly" action; summon itself only expands the crew/roster.
    const activate = opts.activate === true;
    const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create(a.name, { agentId: id, activate }) : null;
    // the COMMS "who you're talking to" selector reads App.agents() but only rebuilds inside renderIdBar —
    // without this, a summon leaves the selector stale (missing the new agent) until some other stream
    // switch happens, while the toast says "switch to its stream". Refresh it the moment the roster grows.
    if (typeof Chat !== 'undefined' && Chat.refreshIdBar) Chat.refreshIdBar();
    if (activate) {
      focusAgent(id);
      if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws);
    }
    recomposeOrchestrators();   // the lead's YOUR CREW clause must include the new worker before the roster push
    refreshUsage(); renderRail(); persist();
    pushRoster();   // the new worker is now delegatable by the lead
    const _notify = (typeof StationUI !== 'undefined' && StationUI.notify) ? StationUI.notify : (m) => console.log('[summon]', m);
    if (activate) {
      // ACTIONABLE FOLLOW-UP (audit B-1): a summoned specialist can't take FLOOR work until it has its own DESK
      // (a seated workstation). The old copy buried this required step in a passing remark ("give it its OWN PC")
      // with no way to act. Now the agent says it plainly — "desk", never "OWN PC" — and a chip opens REFIT with
      // desk placement teed up. FINALE (Lane D): the toast is ONE line now — the desk requirement + its door move
      // into the diegetic line + chip below (the standing record no longer duplicates the whole instruction).
      _notify(a.name + ' summoned — type to task it now.', 'good');
      // WHERE THAT LINE COMES FROM (2026-08-03): the Chat.load(ws) above opened the new agent's session, and the
      // desk prompt is now a property of THAT SESSION (chat.js maybeDeskPrompt → App.needsWorkstation), not a
      // one-shot printed here. It used to be printed once, DOM-only: the first stream switch (or any reload) wiped
      // the only place the required step was ever stated, and a live beat could drop it outright — leaving a brand
      // new agent's session showing nothing but the generic starter hint. Re-derived from the live floor on every
      // open instead, so it stands until the desk actually exists, and it never fires when the desk came with the
      // agent (opts.desk) — "nowhere to sit" would then be a lie about the floor.
      // land the cursor in the COMMS composer so "type to task it now" is literal. Deferred a tick so it wins over
      // the bay's close() focus-restore (which runs synchronously right after this returns, sending focus to the
      // RECRUIT dock button). Guarded on visibility so a closed COMMS panel is a no-op.
      setTimeout(() => { const ci = el('chat-input'); if (ci && ci.offsetParent !== null) { try { ci.focus(); } catch (_) {} } }, 0);
    } else {
      // say WHERE its desk landed when one was seeded — the Commander needs to be able to go look at it (and
      // move it in REFIT). Only claimed when the placement actually returned ok; a failed seed says nothing.
      // "took the free desk" vs "desk placed": ensureWorkstation may ADOPT an unbound workstation instead of
      // building one, and saying "placed" for a desk that was already there is a small lie about the floor.
      const deskLine = (desk && desk.ok) ? ((desk.adopted ? 'took the free desk' : 'desk placed') + (deskRoom ? ' in ' + deskRoom : '') + '. ') : '';
      _notify(a.name + ' summoned — ' + deskLine + 'switch to its stream to task it, or let the overseer delegate.', 'good');
    }
    // ONE loadout beat: state plainly what the class summon actually applied — the skills enabled, the effort
    // applied, and the STATION GEAR the class draws on (honest present/missing under the overseer, NOT per-agent
    // props). Skipped for a plain persona-only class (no gear/skills/effort) so it never adds noise. Mirrors the
    // dossier so the two never drift.
    const lo = loadoutSummary(a, spec);
    if (lo) _notify(a.name + ' loadout - ' + lo, 'info');
    return a;
  }
  // DOES THIS CREW MEMBER STILL HAVE NOWHERE TO SIT? A truthful read of the LIVE FLOOR, never a flag: a
  // specialist owns exactly one prop — its workstation (capForProp === 'computer') — so "no such prop bound to
  // it" IS "no desk". Re-derived every time it's asked, which is what lets the COMMS prompt stand until the desk
  // exists and then vanish for good, in the same tick the Commander places it. Excludes the hero (its starter
  // desk is seeded at wake, and its stream owns the first-run hint) and any id that isn't on the live roster.
  // Fails CLOSED on a missing station: the app must never claim a floor state it cannot prove.
  function needsWorkstation(agentId) {
    const id = String(agentId || '');
    if (!id || id === 'agent' || !agents.has(id)) return false;
    if (!station || typeof station.propsByAgent !== 'function' || typeof station.capForProp !== 'function') return false;
    try { return !station.propsByAgent(id).some(p => station.capForProp(p.t) === 'computer'); } catch (_) { return false; }
  }
  // OPEN REFIT WITH DESK PLACEMENT TEED UP — the target of the post-summon "PLACE ITS DESK" chip. Opens the
  // builder (the same door the ⚒ BUILD dock opens) and, once its DOM is up, drives it to the PROP tool on the
  // WORKSTATIONS category so the very next floor-click drops a desk (a workstation is editable, so it can't be
  // auto-requisitioned — it opens the agent-binding picker on placement; the Commander places + binds it by hand,
  // which is the honest one desk-per-agent path). Degrades safely: if any control isn't found we still leave REFIT
  // open on its default tool, which is already a real improvement over the old unclickable "Open REFIT" sentence.
  function openDeskPlacement() {
    if (typeof Build === 'undefined' || !Build.open) return;
    try { if (!Build.isOpen || !Build.isOpen()) Build.open(); } catch (_) { return; }
    // REFIT builds its palette synchronously in open()->buildDOM, but retarget across a couple of rAFs to be safe
    // against any deferred render. Each pass clicks only what isn't already active, so it's idempotent + cheap.
    let tries = 0;
    const arm = () => {
      const q = sel => document.querySelector(sel);
      const propTool = q('.refit-tool[data-tool="prop"]');
      if (propTool && !propTool.classList.contains('active')) propTool.click();
      const fnTier = q('.refit-tier-functional'), curTier = q('.refit-tier.active');
      if (fnTier && curTier && curTier !== fnTier) fnTier.click();
      const wsCat = q('.refit-propcat[data-cat="workstation"]');
      if (wsCat && !wsCat.classList.contains('active')) wsCat.click();
      const armed = wsCat && wsCat.classList.contains('active') && propTool && propTool.classList.contains('active');
      if (!armed && ++tries < 8) requestAnimationFrame(arm);
    };
    requestAnimationFrame(arm);
  }
  // The capability objectTypes the STATION currently has placed anywhere (station-wide shared gear), deduped.
  // Under Andrew's model a specialist owns only its desk and uses these shared caps under the overseer — so a
  // class's declared gear is checked against the whole station, never the agent's own room. Reads the same live
  // station-wide source the run's skill availability uses (World.stationCaps); [] on any hiccup (never throws).
  function stationGearTypes() {
    try {
      const caps = (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [];
      return caps.map(c => (typeof c === 'string' ? c : c && c.objectType)).filter(Boolean);
    } catch (_) { return []; }
  }
  // Compose the one-line summon loadout beat from what was ACTUALLY applied: the skills enabled, the effort, and
  // — honestly — the STATION GEAR the class draws on that the station is MISSING (add it in REFIT for the class to
  // work its best). Present gear needs no callout (it just works). Reads skills/effort off the record applyLoadout
  // wrote. Returns '' when there is nothing to say.
  function loadoutSummary(a, spec) {
    const parts = [];
    const skills = (a && Array.isArray(a.skills)) ? a.skills : [];
    if (skills.length) parts.push(skills.length + ' skill' + (skills.length === 1 ? '' : 's') + ' enabled');
    if (a && a.reasoningEffort) parts.push(a.reasoningEffort + ' reasoning effort applied');
    const gear = (spec && Array.isArray(spec.kit)) ? spec.kit : [];
    if (gear.length) {
      const have = new Set(stationGearTypes());
      const missing = gear.filter(g => !have.has(g));
      if (missing.length) parts.push('station lacks ' + missing.join(', ') + ' — add ' + (missing.length === 1 ? 'it' : 'them') + ' in REFIT for its full toolkit');
    }
    return parts.join(' · ');
  }
  // THE one recruit door: the bay opens in SUMMON mode (pick-mode specialist grid → summonAgent),
  // and ALSO carries the deploy context so each class dossier offers the second verb — DEPLOY TO
  // <current agent> (deploySpecialty). The old split (ROSTER=deploy door, SUMMON=new-agent door)
  // was two dock buttons opening the same screen; the verbs now live on the card, not the dock.
  let concurrentCap = null;   // server MAX_CONCURRENT_AGENTS (how many agents RUN at once) — fetched once, kept honest
  // the ONE recruit door. Wired directly to a click handler (#bb-recruit), so it takes NO arguments — an
  // optional first param would receive the DOM event. Deep-links pass through openClassDossier instead.
  function openSummonBay() { openSummonBayWith(null); }
  // INTENT OFFER deep-link: open the same bay already focused on ONE class's dossier (the class a COMMS offer
  // named). Without this the accept dumps the Commander on the roster's default card and they have to hunt for
  // the class that was just offered to them — the exact friction the offer exists to remove.
  function openClassDossier(classId) {
    if (!classId) return openSummonBay();
    openSummonBayWith({ id: String(classId) });
  }
  function openSummonBayWith(classSeed) {
    if (typeof Marketplace === 'undefined' || !agent) return;
    SFX.click();
    const go = () => Marketplace.open({
      mode: 'pick', summon: true, concurrentCap: concurrentCap,
      classSeed: classSeed || null,   // one-shot: the bay focuses this class's dossier on open (maybeConsumeClassSeed)
      notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
      onPick: summonAgent,
      // deploy-to-current context (the merged ROSTER verb): who the current agent is + what it
      // already runs as, so the bay can flag DEPLOYED and re-spec honestly.
      onDeploy: deploySpecialty,
      agentName: agent.name,
      currentSpecialtyId: agent.specialtyId || null,
      nextAgentName: className => AgentId.allocName(className, liveAgents()),
      nameConflict: name => AgentId.nameConflict(name, liveAgents()),
      displayNameLimit: AgentId.NAME_MAX
    });
    // surface the REAL concurrency ceiling in the bay so "summon as many as you like" doesn't imply they all
    // run at once (the gate refuses excess parallel workers). Fetch once; open immediately thereafter.
    if (concurrentCap != null) return go();
    fetch('/api/limits').then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(j => { concurrentCap = (j && +j.maxConcurrentAgents) || null; }).catch(() => {}).then(go);
  }

  // LAUNCH a recipe (from the Recipe library's RECIPES tab): mint a fresh workstream named after the mission, then
  // Chat.send the param-filled directive so the agent picks it up. A recipe sends WORK to whatever agent is deployed
  // — it never re-specs identity (that is what the AGENTS tab / deploy is for), so it never touches the agent's
  // purpose or specialtyId. Chat.send classifies it as a real task AND folds its interest tag into the profile, so
  // launching missions also sharpens future recommendations. Returns true once the run is kicked off, false on a
  // no-op (no agent / empty directive) so the bay can report success honestly. Mirrors newWorkstream() + the send.
  function launchRecipe(recipe, values) {
    if (!agent || typeof Recipes === 'undefined' || !recipe) return false;
    const text = Recipes.fillTask(recipe, values || {});
    if (!text) return false;                                              // nothing to send → report the no-op honestly
    // HONESTY GATE (release polish): if the agent is mid-run the send below would silently no-op — that used to
    // mint a dead empty workstream, count a launch that never ran (inflating the FOR-YOU rank + the routine
    // nudge's "launched N times"), and still return true. A launch that can't kick off is a no-op: report false
    // so the bay says so, and leave the counters truthful.
    if (!(typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy())) return false;
    const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create(recipe.name || 'Mission', { kind: 'task' }) : null;   // a recipe mission is a board task
    if (ws && Chat.load) Chat.load(ws);   // make the new stream the compose target before sending
    refreshUsage(); renderRail();
    // engagement loop (scout lane 5): count the REAL launch — feeds the FOR-YOU rank + the drafting hint.
    try { if (typeof ProspectStore !== 'undefined' && ProspectStore.noteLaunch) ProspectStore.noteLaunch(recipe); } catch (_) {}
    // fromRecipe marks this run as recipe-launched so R5 "Bottle a run" never offers to re-bottle a recipe (it
    // already IS one). chat.js records it into RUN_META at onRunId; BottleStore reads it via runBottleInfo below.
    // recipeId is the provenance SPINE: it rides RUN_META → the /api/run body → the durable run row, so the
    // outcome loop (rate-the-work → recipe rank) can attribute a rating to the recipe that launched the run.
    // SOP recipes: the recipe's typed acceptance rows (tokens filled) ride the run body as `postconditions` — the
    // host evaluates them when the run ends (sidecar/task-postconditions.js); null when the recipe declares none.
    const postconditions = Recipes.postconditionsFor ? Recipes.postconditionsFor(recipe, values || {}) : null;
    Chat.send(text, { fromRecipe: true, recipeId: recipe.id, postconditions: postconditions || undefined });   // kicks off the run on the fresh stream
    persist();
    return true;
  }

  // R5 "BOTTLE A RUN" — the honest facts BottleStore gates on for a given run, read from chat.js's RUN_META (the
  // directive + isTask + recipe provenance recorded at run start) plus Chat.runDidWork (real tool-work / delivery).
  // A run with no meta (unknown id) reports nothing bottle-worthy. cron/unattended runs never flow through the
  // interactive rateWork path, so cron:false here is honest — the guard is belt-and-braces for a future caller.
  function runBottleInfo(runId) {
    const m = (typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null;
    if (!m) return null;
    return {
      isTask: !!m.isTask,
      fromRecipe: !!m.fromRecipe,
      cron: false,
      directive: m.directive || m.title || '',
      didWork: (typeof Chat !== 'undefined' && Chat.runDidWork) ? Chat.runDidWork(runId) : false
    };
  }
  // R5 — open the R2 recipe editor PRE-FILLED with a bottled-run proposal (Recipes.mintFromRun draft). Nothing
  // auto-saves; the user confirms/edits/saves in the editor. Routes through the RECIPES tab of the bay, seeding the
  // mint via ctx.recipeMint (the additive seed the marketplace editor reads on open).
  function openBottleEditor(proposal) {
    if (typeof Marketplace === 'undefined' || !agent || !proposal) return;
    SFX.click();
    Marketplace.open({
      mode: 'deploy',
      tab: 'recipes',
      recipeMint: proposal,                 // ← the R2 editor opens pre-filled from this draft (additive ctx seed)
      agentName: agent.name,
      notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
      onLaunch: launchRecipe
    });
  }

  // P3.1 "RUN IT AGAIN?" — the honest facts ResummonStore gates on, read from chat.js's RUN_META (directive +
  // isTask + the run's agent, recorded at run start) plus Chat.runDidWork (real tool-work / delivery). Adds the
  // agent's display NAME (resolved from the roster) so the beat can address it by name. A run with no meta reports
  // nothing re-runnable. cron/unattended runs never flow through the interactive rateWork path (cron:false honest).
  function runResummonInfo(runId) {
    const m = (typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null;
    if (!m) return null;
    const aid = m.agentId || 'agent';
    const a = agents.get(aid);
    return {
      isTask: !!m.isTask,
      cron: false,
      directive: m.directive || m.title || '',
      didWork: (typeof Chat !== 'undefined' && Chat.runDidWork) ? Chat.runDidWork(runId) : false,
      agentId: aid,
      agentName: (a && a.name) || (aid === 'agent' && agent ? agent.name : '') || ''
    };
  }
  // P3.1 — PRE-FILL a fresh run from a re-summoned one: switch to (or mint) the run's AGENT stream, then seed the
  // composer with its directive. NOTHING auto-runs — the Commander edits and hits send (Chat.prefill only scaffolds
  // the input). Mirrors the COMMS agent-selector hand-off (selectAgent → switchWorkstream → Chat.load), then prefill.
  function prefillResummon(opts) {
    opts = opts || {};
    const aid = String(opts.agentId || 'agent');
    const directive = String(opts.directive || '');
    if (!directive.trim()) return;
    try { if (aid && aid !== 'agent' && agents.has(aid)) selectAgent(aid); } catch (_) {}   // hero runs stay on the current/General stream
    try { if (typeof SFX !== 'undefined' && SFX.click) SFX.click(); } catch (_) {}
    try { if (typeof Chat !== 'undefined' && Chat.prefill) Chat.prefill(directive); } catch (_) {}
  }

  // push the live agent identity (the run agentId + composed system prompt) to the sidecar so any connected
  // messaging channel (Telegram) runs as the SAME agent. Fire-and-forget; a no-op if no channel is connected.
  function syncChannels() {
    try {
      if (!agent) return;
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
      const reasoningEffort = (typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort() : 'medium';
      const body = {
        agentId: (ws && ws.agentId) || 'agent',
        system: agent.systemPrompt || '',
        agentName: agent.name || '',
        model: (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '',
        provider,
        reasoningEffort
      };
      const key = (typeof Harness !== 'undefined' && Harness.getKey) ? Harness.getKey(provider) : '';
      if (key) body.key = key;
      const baseUrl = (typeof Harness !== 'undefined' && Harness.getBaseUrl) ? Harness.getBaseUrl(provider) : '';
      if (baseUrl) body.baseUrl = baseUrl;
      // every connectable channel gets the same identity push; the sidecar's sync handler no-ops quietly for
      // any channel that isn't configured, so this stays a cheap fan-out (telegram/discord/slack/matrix/signal).
      for (const ch of ['telegram', 'discord', 'slack', 'matrix', 'signal']) {
        fetch('/api/channels/' + ch + '/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // Stage 2: push the LIVE crew identities to the sidecar so a lead's team.dispatch can run a worker AS itself
  // (its composed system prompt + model) and the lead's prompt can list the crew. Fire-and-forget; called at the
  // few roster-change points (summon / wake / resume / config edit). Base prompts only — the lead's [YOUR CREW]
  // block is injected server-side, so workers never carry a delegate instruction.
  function rosterRole(a) {
    const spec = (a.specialtyId && typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(a.specialtyId) : null;
    if (spec) return String(spec.tagline || spec.name || '').slice(0, 120);
    return String(a.purpose || 'general specialist').slice(0, 120);
  }
  // the most recent /api/roster POST. A backend-initiated summon must AWAIT this before acking, so the lead's
  // immediate team.dispatch sees the new worker in agentRoster (the POST is otherwise fire-and-forget → a race).
  let lastRosterPush = Promise.resolve();
  // like the cloudsave mirror, a roster POST used to swallow every failure silently. Lighter treatment than
  // the full backoff loop (the roster is re-derivable from local state and re-pushed constantly): track a
  // single failed flag, warn EXACTLY once on the healthy→failing edge, and let the next persist re-attempt.
  let rosterPushFailed = false;
  /* S3 — MAKE THE METERS LOAD-BEARING (without gating anything).
     Until now every reader of an agent's stats was a display surface: the level chip, the dossier, /whoami.
     Nothing in the station ACTED on them, so a TRUSTED veteran and a stranger were identical to delegation —
     which is what made the whole leveling system feel cosmetic. This publishes each agent's EARNED track
     record onto the roster, where the sidecar renders it on the lead's team.dispatch briefing, so the lead
     picks a worker on evidence instead of on nothing.

     It INFORMS, it never GATES: no level threshold blocks a dispatch, an unproven agent is simply described
     without a track line (Xp.credential returns '' until something is actually earned), and the Commander can
     still hand any work to anyone. The sandbox law holds.

     WHY HERE AND NOT IN THE CACHED SYSTEM PROMPT: the plan originally aimed this at rosterClause(), but that
     line is baked into the stored a.systemPrompt and needs a recomposeOrchestrators() to refresh — the
     documented cached-prompt trap (see the note above rosterClause). The sidecar's [ORCHESTRATION] briefing is
     rebuilt from the roster on EVERY run instead, so it is the same list the lead actually picks from with
     none of the staleness risk. Duplicating a slow-moving copy into the cached prompt as well would buy
     nothing and add a second thing to keep in sync, so it is deliberately not done. */
  function rosterTrack(a) {
    if (!a || typeof Xp === 'undefined' || !Xp.credential || !a.stats) return '';
    try { return Xp.credential(a.stats).text || ''; } catch (_) { return ''; }
  }
  function pushRoster() {
    try {
      const fallbackProv = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
      const list = liveAgents().map(a => ({ agentId: a.id, system: a.systemPrompt || '', name: a.name || a.id, model: a.model || '', provider: a.provider || fallbackProv, role: rosterRole(a), approvalMode: (a.approvalMode === 'full' ? 'full' : 'ask'), executionProfile: executionProfileOf(a),
        track: rosterTrack(a),    // S3: this agent's EARNED track record, so the lead's dispatch briefing can pick on evidence (see rosterTrack)
        workshop: !!a.workshop,   // W3: the away-build grant travels with the roster so the consent broker can honor it
        skills: Array.isArray(a.skills) ? a.skills : [], reasoningEffort: a.reasoningEffort || null }));   // #4: each agent's OWN provider; Class Loadouts S1: per-agent skill package + applied effort
      // P1.1 (UPDATE_STATE_SAFETY_AUDIT): stamp a freshness `updatedAt` so the sidecar can refuse a STALE push (a
      // background tab / out-of-sync frontend whose roster is older than what the store already accepted). The
      // sidecar records the stamp of the last accepted write and 200s { ok:false, stale:true } on an older one;
      // a legacy stamp-less push still writes as before (backward compatible). Date.now() is monotonic-enough for
      // this last-write anti-clobber (mirrors save.js's own updatedAt stamp).
      lastRosterPush = fetch('/api/roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: list, updatedAt: Date.now() }) })
        .then(async r => {
          if (r && r.ok === false) throw new Error('roster HTTP ' + r.status);
          // EL-11 FIX 1: the sidecar answers REFUSALS as HTTP 200 { ok:false, ... } (degraded workspace /
          // stale stamp) — Response.ok alone never proves the roster landed. Parse the body; ok:false is a
          // FAILED push (retried on the next persist with a fresh stamp), and degraded latches the shared
          // save-health verdict so the save-dot tells the truth about refused writes.
          let body = null;
          try { body = await r.json(); } catch (_) { body = null; }
          if (body && typeof body === 'object' && body.ok === false) {
            if (body.degraded === true && typeof CloudSave !== 'undefined' && CloudSave.markDegraded) CloudSave.markDegraded();
            throw new Error('roster refused: ' + (body.error || (body.stale ? 'stale push' : 'unknown')));
          }
          if (rosterPushFailed) { rosterPushFailed = false; try { console.info('[roster] sidecar roster sync recovered.'); } catch (_) {} }
          return true;
        })
        .catch(() => {
          if (!rosterPushFailed) { rosterPushFailed = true; try { console.warn('[roster] sidecar roster sync failed; will retry on next persist. Local roster is intact.'); } catch (_) {} }
          return false;
        });
      return lastRosterPush;
    } catch (_) { return Promise.resolve(false); }
  }

  // BACKEND-INITIATED SUMMON (crew.summon.request): the orchestrator's team.summon tool asked the station to
  // create a worker for the Commander. Run the SAME summonAgent() the Recruitment Bay uses (single source of
  // truth — sprite, workstream, system prompt, roster push), resolving the new id ONLY AFTER the roster POST
  // lands so the lead's immediate team.dispatch finds the worker. Returns null if it couldn't summon.
  async function summonForRequest(ev) {
    ev = ev || {};
    // a known built-in class id (researcher/engineer/…) seeds the full specialty (purpose + manual + skin); a
    // freeform name makes a custom specialist. Event fields always win over the class defaults.
    let base = (ev.specId && typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(ev.specId) : null;
    const spec = Object.assign({}, base || {}, {
      id: ev.specId || (base && base.id) || undefined,
      name: ev.name || (base && base.name) || undefined,
      skin: ev.skin || (base && base.skin) || undefined,
      persona: ev.persona || (base && base.persona) || undefined,
      purpose: ev.purpose || (base && base.purpose) || undefined
    });
    // desk:true — this summon IS the answer to "create me an agent", so the worker arrives with the one
    // per-agent prop it needs to sit and work. See summonAgent: the seed is that agent's desk and nothing
    // else; the Commander can move or reclaim it in REFIT like any placed prop.
    let a = null;
    try { a = summonAgent(spec, { activate: false, desk: true }); } catch (_) { a = null; }
    if (!a) return null;
    let rosterLanded = false;
    try { rosterLanded = (await lastRosterPush) === true; } catch (_) {}
    if (!rosterLanded) return null;   // fail closed: never tell the Commander it can dispatch an unregistered worker
    // READ BACK what actually landed, so the ack can tell the lead where the desk is. Deliberately a PURE
    // read (propsByAgent), never a second ensureWorkstation call: re-running the seeder here could place a
    // desk AFTER summonAgent's persist() — a floor change that would not be saved until the next write.
    // Blank when nothing was placed, and the tool then says nothing about a desk.
    let deskWhere = '';
    try {
      const mine = (station && station.propsByAgent) ? station.propsByAgent(a.id) : [];
      const seat = mine.find(p => station.capForProp && station.capForProp(p.t) === 'computer');
      if (seat) { const rm = station.roomById ? station.roomById(station.roomAt(seat.x, seat.y)) : null; deskWhere = (rm && rm.name) ? String(rm.name) : 'the station'; }
    } catch (_) { deskWhere = ''; }
    return { agentId: a.id, desk: deskWhere };
  }

  function persist() {
    if (!agent) return;
    // the save ROOT is ALWAYS the hero ('agent'), never the transiently-FOCUSED crew member — otherwise a
    // persist while a summoned agent is focused would overwrite the hero identity and corrupt resume.
    const hero = agents.get('agent') || agent;
    const stationStats = (typeof XpStore !== 'undefined') ? XpStore.stationStats() : undefined;
    const prov = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined;   // persist the provider so a codex agent resumes without a key prompt after a wipe/origin-reset
    const reasoningEffort = (typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort() : undefined;
    const profile = (typeof ProfileStore !== 'undefined') ? ProfileStore.serialize() : undefined;
    const worksignal = (typeof WorkSignalStore !== 'undefined') ? WorkSignalStore.serialize() : undefined;   // the capability-usage histogram (adaptive recruitment)
    const roster = liveAgents();
    const dossier = (typeof DossierStore !== 'undefined') ? DossierStore.serialize() : undefined;   // the station-wide Commander model
    const doc = Save.write(Object.assign({ agent: hero, agents: roster.length > 1 ? roster.map(serializeAgentLite) : undefined, usage: Harness.totals(), prov, reasoningEffort, station: station ? station.serialize() : undefined, stationStats, profile, worksignal, dossier }, Workstreams.serialize()));
    if (doc && typeof CloudSave !== 'undefined') CloudSave.push(doc);   // durable write-through to the sidecar (debounced, best-effort)
    if (rosterPushFailed) pushRoster();   // a prior roster POST failed — retry it opportunistically on this persist
    if (typeof StationUI !== 'undefined') StationUI.flashSave();
  }

  /* ---------- connect screen ---------- */
  const FALLBACK_MODELS = Object.freeze({
    // grok/kimi mirror the sidecar registry's staticModels (the OAuth catalogs are account-discovered live;
    // these are only the offline/not-signed-in fallback so the field is never stranded empty).
    grok: ['grok-4', 'grok-3', 'grok-code-fast-1'],
    kimi: ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3'],
    openai: ['gpt-5.5', 'gpt-5.4', 'gpt-4.1'],
    anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    xai: ['grok-4.3', 'grok-4-fast', 'grok-4'],
    groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro'],
    together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'deepseek-ai/DeepSeek-V3'],
    fireworks: ['accounts/fireworks/models/deepseek-v3p1', 'accounts/fireworks/models/kimi-k2p5', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    perplexity: ['sonar-pro', 'sonar', 'sonar-reasoning-pro'],
    cerebras: ['llama-4-scout-17b-16e-instruct', 'llama3.1-8b', 'qwen-3-coder-480b'],
    ollama: ['llama3.1', 'qwen2.5-coder', 'mistral'],
    openrouter: ['gpt-5.5', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.8', 'openai/gpt-5', 'google/gemini-2.5-pro']
  });
  // The genesis model catalog for the ACTIVE provider — {id, name, pricing, context_length, fallback?} items
  // feeding the themed #model-pop popover (which replaced the native <datalist>). genesisOffline flags a
  // seed-list fallback so the popover + hint say "catalog offline" instead of asserting a verified live list
  // (mirrors ModelDock's E4 honesty). Harness.listModels() populates the price/context map priceOf reads.
  let genesisModels = [];
  let genesisOffline = false;
  async function loadModels(provider) {
    const p = normalizeProviderId(provider || pickedProvider);
    const countEl = el('model-count'), inp = el('in-model');
    el('model-hint').textContent = 'loading model catalog…';
    const list = await Harness.listModels(p);
    // DEFAULT = the curated MODEL_PICKS[provider][0] — NOT the alphabetical regex hit the old code used (which
    // drifted onto stale slugs while the right answer sat one inch below in the picks). defaultModelFor() covers
    // providers without a curated pick (custom / ollama).
    const picks = MODEL_PICKS[p];
    const defId = (picks && picks[0] && picks[0].id) || defaultModelFor(p);
    if (list.length) {
      genesisModels = list; genesisOffline = false;
      countEl.textContent = '(' + list.length + ' in catalog)';
      if (!inp.value) inp.value = defId;   // DEFAULT-FILL so a first ⏼ WAKE never bounces on an empty model (matches the Codex path)
      // Retire the "loading models…" placeholder once the catalog resolves — a default-filled field must not keep
      // asserting "loading" as its accessible name.
      inp.placeholder = 'search models — e.g. ' + defId;
    } else {
      // catalog unreachable (no network to openrouter.ai, or fetch blocked): seed the curated slugs MARKED
      // offline so the popover never reads as a verified live catalog. The screen stays usable — you can always
      // just type the slug you use.
      const FALLBACK = FALLBACK_MODELS[p] || FALLBACK_MODELS.openrouter;
      genesisModels = FALLBACK.map(id => ({ id, name: id, fallback: true }));
      genesisOffline = true;
      countEl.textContent = '(catalog offline — type or pick a slug)';
      if (!inp.value) inp.value = defId || FALLBACK[0];   // default-fill even offline so WAKE works; the Commander can overtype
      inp.placeholder = 'type a model slug — e.g. ' + (defId || 'gpt-5.5');
    }
    if (el('model-pop') && !el('model-pop').hidden) renderModelPop();   // live-refresh an open popover after a provider switch
    updateHint();
  }

  /* ---------- recommended-model quick picks (OpenRouter) ----------
     One-tap slugs for newcomers who don't know what to type — directly serves the "easier than a bare
     coding-agent CLI for beginners" moat. These are SUGGESTIONS, not a claim of availability: a chip only prefills
     #in-model, which the live catalog (updateHint → priceOf) then prices or flags. The slugs match the
     curated FALLBACK list loadModels() already ships, so nothing new is fabricated. Codex hides them —
     its menu is discovered live per-account (loadCodexModels), so a static list there could mislead. */
  const MODEL_PICKS = Object.freeze({
    openrouter: [
      { label: 'Opus 4.8', id: 'anthropic/claude-opus-4.8', tag: 'deepest' },
      { label: 'Sonnet 4.6', id: 'anthropic/claude-sonnet-4.6', tag: 'balanced' },
      { label: 'GPT-5', id: 'openai/gpt-5', tag: '' },
      { label: 'Gemini 2.5 Pro', id: 'google/gemini-2.5-pro', tag: '' }
    ],
    openai: [
      { label: 'GPT-5.5', id: 'gpt-5.5', tag: 'deepest' },
      { label: 'GPT-5.4', id: 'gpt-5.4', tag: '' }
    ],
    anthropic: [
      { label: 'Sonnet 4.5', id: 'claude-sonnet-4-5', tag: 'balanced' },
      { label: 'Opus 4.1', id: 'claude-opus-4-1', tag: 'deepest' }
    ],
    gemini: [
      { label: 'Gemini 2.5 Pro', id: 'gemini-2.5-pro', tag: 'deepest' },
      { label: 'Gemini 2.5 Flash', id: 'gemini-2.5-flash', tag: 'fast' }
    ],
    xai: [
      { label: 'Grok 4.3', id: 'grok-4.3', tag: '' },
      { label: 'Grok 4 Fast', id: 'grok-4-fast', tag: 'fast' }
    ],
    groq: [
      { label: 'GPT OSS 120B', id: 'openai/gpt-oss-120b', tag: 'fast' },
      { label: 'Llama 3.3 70B', id: 'llama-3.3-70b-versatile', tag: '' }
    ],
    mistral: [
      { label: 'Mistral Large', id: 'mistral-large-latest', tag: '' },
      { label: 'Mistral Small', id: 'mistral-small-latest', tag: 'fast' }
    ],
    deepseek: [
      { label: 'DeepSeek Chat', id: 'deepseek-chat', tag: '' },
      { label: 'Reasoner', id: 'deepseek-reasoner', tag: 'reasoning' }
    ],
    together: [
      { label: 'Llama 3.3 70B', id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', tag: '' },
      { label: 'Qwen Coder', id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', tag: 'code' }
    ],
    fireworks: [
      { label: 'DeepSeek V3', id: 'accounts/fireworks/models/deepseek-v3p1', tag: '' },
      { label: 'Kimi K2', id: 'accounts/fireworks/models/kimi-k2p5', tag: '' }
    ],
    perplexity: [
      { label: 'Sonar Pro', id: 'sonar-pro', tag: 'search' },
      { label: 'Sonar', id: 'sonar', tag: '' }
    ],
    cerebras: [
      { label: 'Llama 4 Scout', id: 'llama-4-scout-17b-16e-instruct', tag: 'fast' },
      { label: 'Llama 3.1 8B', id: 'llama3.1-8b', tag: '' }
    ]
  });
  /* ---------- PHOSPHOR tint picker (the console-wide theme, surfaced at commission) ----------
     The station already ships four CRT phosphors (style.css body.theme-*) persisted by StationUI. We
     surface that choice up-front so the Commander sets the whole station's colour the moment they build
     it — picking a swatch recolours live AND writes through StationUI.setTheme so it survives enterGame
     and stays in lockstep with the in-game Settings panel. No new state, no fakery. */
  const PHOSPHOR = Object.freeze([['amber', '#ffaa33'], ['green', '#3dff70'], ['blue', '#46c8ff'], ['purple', '#b46bff'], ['red', '#ff4136'], ['white', '#e8f0e8']]);
  // THE APPROVAL MODE — the crucial pick for the everything-orchestrator: how much it can do on its own. This is
  // NOT cosmetic — it drives the REAL consent broker in the sidecar (full → bypass the gate; ask → prompt on any
  // mutation/network call), threaded through pushRoster → /api/roster. `np` is the nameplate readout.
  const APPROVAL = Object.freeze([
    Object.freeze({ id: 'ask',  label: 'ASK FOR APPROVAL', icon: '✋', desc: 'stops to check with you before it writes, runs, or reaches out', np: 'asks for approval' }),
    Object.freeze({ id: 'full', label: 'FULL POWER', icon: '⚡', desc: 'uses the whole local computer without approval prompts',          np: 'full power' })
  ]);
  const approvalById = id => APPROVAL.find(a => a.id === id) || APPROVAL[0];
  function applyTheme(t) {
    document.body.classList.remove('theme-amber', 'theme-green', 'theme-blue', 'theme-purple', 'theme-red', 'theme-white', 'theme-custom');
    document.body.classList.add('theme-' + t);
    // 'custom' carries no palette in CSS — its derived vars are inline on <body>, set by
    // StationUI.applySettings at init and cleared by StationUI.setTheme when a preset is picked here.
  }
  function buildPhosphor() {
    const wrap = el('phosphor-swatches'); if (!wrap) return;
    let cur = 'amber';
    try { if (typeof StationUI !== 'undefined' && StationUI.getTheme) cur = StationUI.getTheme() || 'amber'; } catch (_) {}
    applyTheme(cur);   // reflect a previously-saved tint on the create screen too (StationUI hasn't entered yet)
    wrap.innerHTML = '';
    PHOSPHOR.forEach(([t, c]) => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'swatch' + (t === cur ? ' sel' : ''); b.dataset.t = t;
      b.style.setProperty('--sw', c); b.title = t.toUpperCase() + ' phosphor'; b.setAttribute('aria-label', t + ' phosphor');
      b.setAttribute('aria-pressed', String(t === cur));
      b.onclick = () => {
        applyTheme(t);
        try { if (typeof StationUI !== 'undefined' && StationUI.setTheme) StationUI.setTheme(t); } catch (_) {}   // persist + keep Settings in sync
        SFX.click();
        [...wrap.children].forEach(x => { const on = x === b; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', String(on)); });
      };
      wrap.appendChild(b);
    });
  }

  // THE APPROVAL PICKER — two wide cards (ask vs full access). The pick rides on agent.approvalMode and drives
  // the real consent broker; 'ask' is pre-selected (the safe default), so it never blocks WAKE.
  function buildApproval() {
    const wrap = el('approval-picker'); if (!wrap) return;
    wrap.innerHTML = '';
    APPROVAL.forEach(m => {
      const c = document.createElement('button'); c.type = 'button';
      c.className = 'ov-card' + (pickedApproval === m.id ? ' sel' : '');
      c.dataset.a = m.id; c.title = m.desc; c.setAttribute('aria-pressed', String(pickedApproval === m.id));
      const pk = document.createElement('span'); pk.className = 'ov-card-pick'; pk.textContent = '◆';
      const ic = document.createElement('div'); ic.className = 'ov-card-ic'; ic.textContent = m.icon;
      const nm = document.createElement('div'); nm.className = 'ov-card-nm'; nm.textContent = m.label;
      const ds = document.createElement('div'); ds.className = 'ov-card-ds'; ds.textContent = m.desc;
      c.appendChild(pk); c.appendChild(ic); c.appendChild(nm); c.appendChild(ds);
      c.onclick = () => {
        pickedApproval = m.id;
        [...wrap.children].forEach(x => { const on = x === c; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', String(on)); });
        SFX.click(); updateNameplate();
      };
      wrap.appendChild(c);
    });
    updateNameplate();
  }

  // the live nameplate under the agent: NAME (from the input) + the approval-posture readout.
  function updateNameplate() {
    const np = el('np-name'); if (np) np.textContent = ((el('in-name') && el('in-name').value.trim()) || 'OVERSEER').toUpperCase();
    const nm = el('np-mode'); if (nm) nm.textContent = approvalById(pickedApproval).np;
  }

  function buildModelPicks() {
    const wrap = el('model-picks'); if (!wrap) return;
    wrap.innerHTML = '';
    if (isOAuthProviderId(pickedProvider)) return;   // discovered live per account; no static menu
    (MODEL_PICKS[pickedProvider] || []).forEach(m => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'mp-chip'; b.dataset.id = m.id; b.title = m.id;
      b.appendChild(document.createTextNode(m.label));
      if (m.tag) { const t = document.createElement('b'); t.textContent = ' · ' + m.tag; b.appendChild(t); }
      b.onclick = () => { el('in-model').value = m.id; SFX.click(); updateHint(); };
      wrap.appendChild(b);
    });
    syncModelPicks();
  }
  function syncModelPicks() {
    const wrap = el('model-picks'); if (!wrap) return;
    const cur = el('in-model').value.trim();
    [...wrap.children].forEach(b => b.classList.toggle('sel', b.dataset.id === cur));
  }

  /* ---------- themed grouped model popover (#model-pop) ----------
     Replaces the native <datalist> (an unstyleable OS dropdown that rendered ~370 raw slugs flat). A CRT listbox
     under #in-model, GROUPED BY VENDOR (OpenRouter's slug prefix, else the provider) with human display names +
     context window + $/M pricing where the catalog knows them. Reuses ModelDock's label vocabulary (modelLabel /
     openRouterGroupName) so the two model surfaces read identically. Keyboard: ↑/↓ move, Enter picks, Esc closes
     the popover only. */
  let modelPopRows = [];   // flat {id, el} for the current filtered view (keyboard nav)
  let modelPopIdx = -1;    // highlighted row index, or -1 for none
  let modelPopQ = '';      // the SEARCH query — '' on a fresh focus (browse the whole catalog), the typed text while filtering
  const mdLabel = it => (typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.model) ? ModelDock.labels.model(it) : ((it && (it.name || it.id)) || '');
  function modelGroupOf(it) {
    if (pickedProvider === 'openrouter' && typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.orGroup) return ModelDock.labels.orGroup(it);
    return providerLabel(pickedProvider);
  }
  // compact per-M price, e.g. $3 / $0.75 — from the catalog Harness.priceOf populated on listModels()
  function usdPerM(n) { if (!isFinite(n)) return ''; if (n >= 1) return '$' + (Math.round(n * 10) / 10); if (n > 0) return '$' + (Math.round(n * 100) / 100); return '$0'; }
  function modelMetaStr(id) {
    const parts = [];
    const lim = Harness.contextLimitOf ? Harness.contextLimitOf(id) : 0;
    if (lim) { const fmt = (typeof CtxGauge !== 'undefined' && CtxGauge.fmtTokens) ? CtxGauge.fmtTokens : (n => String(n)); parts.push(fmt(lim)); }
    const pr = Harness.priceOf ? Harness.priceOf(id) : null;
    if (pr) parts.push(usdPerM(pr.in) + '/' + usdPerM(pr.out));
    return parts.join('  ·  ');
  }
  let modelPopReposition = null;
  // #model-pop is position:fixed (to escape the .ov-grid overflow clip), so app.js anchors it to #in-model —
  // opening downward, or flipping above when the field sits low in the console.
  function positionModelPop() {
    const pop = el('model-pop'), inp = el('in-model'); if (!pop || pop.hidden || !inp) return;
    // rect/innerHeight are visual px, style px on the fixed pop are body-zoomed (TEXT SIZE) — divide once.
    const z = U.uiZoom(), r0 = inp.getBoundingClientRect(), gap = 4, vh = window.innerHeight / z;
    const r = { left: r0.left / z, top: r0.top / z, bottom: r0.bottom / z, width: r0.width / z };
    const below = vh - r.bottom - gap, above = r.top - gap;
    const openUp = below < 220 && above > below;
    pop.style.left = r.left + 'px';
    pop.style.width = r.width + 'px';
    pop.style.maxHeight = Math.max(140, Math.min(306, (openUp ? above : below) - 6)) + 'px';
    if (openUp) { pop.style.top = 'auto'; pop.style.bottom = (vh - r.top + gap) + 'px'; }
    else { pop.style.bottom = 'auto'; pop.style.top = (r.bottom + gap) + 'px'; }
  }
  function openModelPop() {
    const pop = el('model-pop'); if (!pop) return;
    if (pop.hidden) {
      pop.hidden = false; el('in-model').setAttribute('aria-expanded', 'true');
      modelPopReposition = () => positionModelPop();
      window.addEventListener('scroll', modelPopReposition, true);   // capture so the .ov-grid scroll re-anchors it
      window.addEventListener('resize', modelPopReposition);
    }
    renderModelPop();
    positionModelPop();
    if (modelPopIdx < 0) { const sel = pop.querySelector('.ov-mdl-row.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' }); }   // browse-open lands on the current pick
  }
  function closeModelPop() {
    const pop = el('model-pop'); if (!pop || pop.hidden) return;
    pop.hidden = true; el('in-model').setAttribute('aria-expanded', 'false'); modelPopIdx = -1;
    if (modelPopReposition) { window.removeEventListener('scroll', modelPopReposition, true); window.removeEventListener('resize', modelPopReposition); modelPopReposition = null; }
  }
  function setModelPopIdx(i) { modelPopIdx = i; modelPopRows.forEach((r, k) => r.el.classList.toggle('hi', k === i)); const cur = modelPopRows[i]; if (cur) cur.el.scrollIntoView({ block: 'nearest' }); }
  function pickModelFromPop(id) { const inp = el('in-model'); inp.value = id; closeModelPop(); SFX.click(); updateHint(); inp.focus(); }
  function renderModelPop() {
    const pop = el('model-pop'); if (!pop) return;
    const cur = el('in-model').value.trim();   // the committed selection (drives the highlighted ✓ row)
    const q = modelPopQ.toLowerCase();          // '' = browse the whole catalog; the typed text while filtering
    pop.innerHTML = ''; modelPopRows = [];
    const list = genesisModels.filter(m => !q || (m.id + ' ' + mdLabel(m) + ' ' + modelGroupOf(m)).toLowerCase().indexOf(q) >= 0);
    if (!list.length) {
      const none = document.createElement('div'); none.className = 'ov-mdl-none';
      none.textContent = genesisModels.length ? ('no match — “' + modelPopQ + '” will be used as a custom slug') : 'catalog unavailable — type a model slug';
      pop.appendChild(none); modelPopIdx = -1; return;
    }
    let group = '';
    const frag = document.createDocumentFragment();
    for (const m of list) {
      const g = modelGroupOf(m);
      if (g !== group) {
        group = g;
        const h = document.createElement('div'); h.className = 'ov-mdl-group'; h.setAttribute('role', 'presentation'); h.textContent = g;
        // honest label when these rows are a built-in seed list (the live catalog was unreachable), never a lie
        if (m.fallback || genesisOffline) { const off = document.createElement('i'); off.className = 'ov-mdl-off'; off.textContent = ' · catalog offline'; h.appendChild(off); }
        frag.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'ov-mdl-row' + (m.id === cur ? ' sel' : '');
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(m.id === cur)); row.dataset.id = m.id; row.title = m.id;
      const name = document.createElement('span'); name.className = 'ov-mdl-name'; name.textContent = mdLabel(m);
      const meta = document.createElement('span'); meta.className = 'ov-mdl-meta'; meta.textContent = modelMetaStr(m.id);
      row.appendChild(name); row.appendChild(meta);
      const idx = modelPopRows.length;
      row.addEventListener('mousedown', e => { e.preventDefault(); pickModelFromPop(m.id); });   // mousedown+preventDefault: the pick lands before the input blurs
      row.addEventListener('mousemove', () => setModelPopIdx(idx));
      frag.appendChild(row); modelPopRows.push({ id: m.id, el: row });
    }
    pop.appendChild(frag);
    if (modelPopIdx >= modelPopRows.length) modelPopIdx = modelPopRows.length - 1;
    modelPopRows.forEach((r, k) => r.el.classList.toggle('hi', k === modelPopIdx));
  }
  // Wire #in-model as a search-as-you-type combobox over #model-pop. Enter picks the highlighted (or first) row
  // when the popover is open; with the popover closed, Enter still commits WAKE (the field's original behavior).
  function wireModelField() {
    const inp = el('in-model'); if (!inp) return;
    inp.oninput = () => { modelPopQ = inp.value.trim(); openModelPop(); updateHint(); };
    inp.onfocus = () => { if (!inp.readOnly) { modelPopQ = ''; openModelPop(); } };   // fresh focus browses the whole catalog
    inp.onblur = () => setTimeout(() => { if (document.activeElement !== inp) closeModelPop(); }, 130);
    inp.onkeydown = e => {
      const open = !el('model-pop').hidden;
      if (e.key === 'ArrowDown') { if (!open) { modelPopQ = ''; openModelPop(); } else setModelPopIdx(Math.min(modelPopIdx + 1, modelPopRows.length - 1)); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { if (open) { setModelPopIdx(Math.max(modelPopIdx - 1, 0)); e.preventDefault(); } return; }
      if (e.key === 'Escape') { if (open) { closeModelPop(); e.preventDefault(); e.stopPropagation(); } return; }   // Esc closes the popover ONLY (never the screen)
      if (e.key === 'Enter' && !e.isComposing) {
        if (open && modelPopRows.length) { const pick = modelPopRows[modelPopIdx >= 0 ? modelPopIdx : 0]; if (pick) { pickModelFromPop(pick.id); e.preventDefault(); return; } }
        e.preventDefault(); onWake();
      }
    };
  }

  function updateHint() {
    const id = el('in-model').value.trim(), hint = el('model-hint');
    syncModelPicks();   // keep the recommended-chip highlight in lockstep with whatever's in the field
    if (isOAuthProviderId(pickedProvider)) { hint.textContent = 'included in your ' + OAUTH_GENESIS[pickedProvider].sub.replace(/ subscription$/, '') + ' subscription'; return; }
    if (!id) { hint.textContent = 'pick or type a model slug'; return; }
    const limit = Harness.contextLimitOf ? Harness.contextLimitOf(id) : 0;
    const price = Harness.priceOf ? Harness.priceOf(id) : null;
    if (limit || price) {
      // the catalog knows this model — surface BOTH context window and $/M in/out (previously ctx only)
      const fmt = (typeof CtxGauge !== 'undefined' && CtxGauge.fmtTokens) ? CtxGauge.fmtTokens : (n => String(n || 0));
      const bits = [];
      if (limit) bits.push('remembers up to ' + fmt(limit) + ' tokens of chat');
      if (price) bits.push('costs ' + usdPerM(price.in) + ' in · ' + usdPerM(price.out) + ' out per million tokens (a token ≈ ¾ of a word)');
      hint.textContent = bits.join('  ·  ');
      return;
    }
    // the catalog has NO data for this slug — split the honest reasons instead of one vague "custom model slug":
    if (genesisOffline) { hint.textContent = 'catalog offline — this slug runs as-is (no price/context data here)'; return; }
    if (genesisModels.some(m => m.id === id)) { hint.textContent = 'custom model — not priced in the catalog'; return; }
    hint.textContent = 'not in the catalog — double-check the slug, or it runs as a custom model';
  }

  /* ---------- provider toggle + ChatGPT (Codex OAuth) sign-in ---------- */
  // Offline FALLBACK only — the real list is fetched per-account from /api/auth/codex/models (see
  // loadCodexModels). The ChatGPT-account Codex lineup drifts: stale slugs (e.g. gpt-5.1-codex) get
  // 400-rejected by the backend, so we never hardcode the menu when we can discover it.
  const CODEX_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];

  // The genesis screen's keyless device-code OAuth providers. Codex keeps its literal path below (source-locks
  // pin refreshCodexStatus/startCodexSignIn); grok/kimi ride ONE generic path parameterized by this copy table —
  // the same split stationui.js uses (codex literal + OAUTH_EXTRA shared), so the two surfaces stay twins.
  const OAUTH_GENESIS = Object.freeze({
    codex: Object.freeze({ name: 'ChatGPT', sub: 'ChatGPT subscription' }),
    grok:  Object.freeze({ name: 'Grok',    sub: 'SuperGrok / X Premium+ subscription' }),
    kimi:  Object.freeze({ name: 'Kimi',    sub: 'Kimi subscription' })
  });
  function isOAuthProviderId(p) { return !!OAUTH_GENESIS[normalizeProviderId(p)]; }

  // fold/unfold the provider row's long tail. Expanding never hides the active pick; collapsing while a
  // tail provider is selected is refused (the selected chip must stay visible — no phantom selection).
  function setProviderRowExpanded(expand) {
    const row = document.querySelector('.provider-row'), more = el('prov-more');
    if (!row || !more) return;
    if (!expand) {
      const selBtn = row.querySelector('.prov.sel');
      if (selBtn && selBtn.classList.contains('tail')) expand = true;
    }
    row.classList.toggle('collapsed', !expand);
    more.setAttribute('aria-expanded', String(expand));
    more.textContent = expand ? '－ FEWER' : '＋ ' + row.querySelectorAll('.prov.tail').length + ' MORE';
  }

  function selectProviderUI(p) {
    pickedProvider = normalizeProviderId(p);
    // ChatGPT/Codex has no chip of its own on this screen anymore — it lives INSIDE the OPENAI card
    // (two paths, one card). A returning codex agent therefore lands on OPENAI, whose card shows the
    // live ChatGPT sign-in status; WAKE re-derives codex from that sign-in (see onWakeAttempt).
    if (pickedProvider === 'codex') pickedProvider = 'openai';
    // switching provider is the user ACTING on a wake-validation message — clear the stale line
    { const m = el('connect-msg'); if (m) m.textContent = ''; }
    document.querySelectorAll('.provider-row .prov').forEach(b => { const on = b.dataset.prov === pickedProvider; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', String(on)); });
    // a saved/selected tail provider must never be invisibly selected behind the fold
    { const sb = document.querySelector('.provider-row .prov.sel'); if (sb && sb.classList.contains('tail')) setProviderRowExpanded(true); }
    const isOAuth = isOAuthProviderId(pickedProvider);
    const keyBlock = el('key-block'), keyInput = el('in-key');
    const baseBlock = el('base-url-block'), baseInput = el('in-base-url');
    const configured = !!(Harness.configured && Harness.configured(pickedProvider));
    keyBlock.classList.toggle('hidden', !providerUsesKeyBox(pickedProvider));
    if (keyInput) {
      keyInput.value = Harness.getKey ? Harness.getKey(pickedProvider) : '';
      keyInput.placeholder = providerKeyPlaceholder(pickedProvider, configured && !keyInput.value);
    }
    if (baseBlock) baseBlock.classList.toggle('hidden', !providerNeedsBaseUrl(pickedProvider));
    if (baseInput) {
      baseInput.value = (Harness.getBaseUrl && Harness.getBaseUrl(pickedProvider)) || '';
      baseInput.onchange = () => {
        if (Harness.setBaseUrl) Harness.setBaseUrl(baseInput.value.trim(), pickedProvider);
        loadModels(pickedProvider);
      };
      baseInput.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); onWake(); } };
    }
    // The OPENAI card is a TWO-PATH card: ChatGPT sign-in (device-code, no key) or an API key. The shared
    // sign-in block shows there alongside the key box; grok/kimi keep it as their only path.
    const isOpenAI = pickedProvider === 'openai';
    el('codex-block').classList.toggle('hidden', !(isOAuth || isOpenAI));
    // STARNET MANAGED wears its own link block (the codex-block twin) — visible only while picked.
    const isStarnet = pickedProvider === 'starnet';
    { const sb = el('starnet-block'); if (sb) sb.classList.toggle('hidden', !isStarnet); }
    // the BYOK note talks about your key on 127.0.0.1 / the OS keychain — irrelevant and contradictory on the
    // keyless subscription paths (no key at all), so hide the whole disclosure there. On BYOK it stays collapsed
    // behind its toggle (progressive disclosure) — the note's own .hidden is owned by #byok-toggle, not this switch.
    { const bd = el('byok-disclose'); if (bd) bd.classList.toggle('hidden', isOAuth || isStarnet); }
    // Switching providers must drop any OTHER provider's in-flight device-code poll — a code minted for the
    // previous pick has no business connecting the new one's block. The active pick's own poll survives a re-click.
    cancelOAuthPolls(isOpenAI ? 'codex' : pickedProvider);   // the OPENAI card's sign-in IS the codex poll — keep it alive
    if (!isStarnet) stopStarnetLinkPoll();
    if (isStarnet) refreshStarnetGenesisStatus();
    if (isOAuth) {
      applyOAuthBlockCopy(pickedProvider);   // the shared #codex-block speaks the picked provider's language
      loadOAuthModels(pickedProvider);
      refreshOAuthGenesisStatus(pickedProvider);
    } else if (isOpenAI) {
      applyOAuthBlockCopy('codex');          // the OPENAI card's sign-in half speaks ChatGPT
      // The catalog follows the path the user actually has: a live ChatGPT sign-in reads the codex lineup,
      // otherwise the OpenAI API catalog. refreshCodexStatus resolves async, so re-aim the catalog once known.
      refreshCodexStatus().then(() => { if (pickedProvider === 'openai' && codexConnected) loadCodexModels(); });
      loadModels('openai');
    } else {
      loadModels(pickedProvider);
    }
    buildModelPicks();        // recommended chips (OpenRouter only; clears itself on the codex path)
  }

  // Populate the model datalist with EXACTLY the slugs the connected account's Codex backend accepts, so the
  // user can't pick a 400-rejected model. Falls back to the curated list when discovery fails / not connected.
  async function loadCodexModels() {
    // Entries may be bare id strings (old shape) or rich {id, displayName, …} objects (new shape) — handle both.
    let models = CODEX_MODELS.map(id => ({ id: id })), def = CODEX_MODELS[0];
    try {
      const r = await fetch('/api/auth/codex/models'); const j = await r.json();
      if (Array.isArray(j.models) && j.models.length) {
        models = j.models.map(m => (typeof m === 'string' ? { id: m } : m)).filter(m => m && m.id);
        def = j.default || (models[0] && models[0].id);
      }
    } catch (_) {}
    const ids = models.map(m => m.id);
    // feed the themed popover (not a datalist): carry displayName through as .name so modelLabel renders it.
    genesisModels = models.map(m => ({ id: m.id, name: m.displayName || m.name || m.id }));
    genesisOffline = false;
    el('model-count').textContent = '(ChatGPT subscription)';
    const mi = el('in-model'); if (!ids.includes(mi.value)) mi.value = def;
    if (def) mi.placeholder = 'search models — e.g. ' + def;   // retire "loading models…" here too, so the field's accessible name matches the loaded catalog
    if (el('model-pop') && !el('model-pop').hidden) renderModelPop();
    updateHint();
  }

  // GET /api/auth/codex/status -> reflect connected/not into the sign-in block (never touches the tokens).
  async function refreshCodexStatus() {
    const statusEl = el('codex-status'), signinBtn = el('btn-codex-signin'), logoutBtn = el('btn-codex-logout');
    let j = { connected: false };
    try { const r = await fetch('/api/auth/codex/status'); j = await r.json(); } catch (_) {}
    codexConnected = !!j.connected;
    oauthConnected.codex = codexConnected;   // the generic wake gate reads the map; codex keeps its literal too
    // keep Harness.configured('codex') truthful the moment sign-in state is known (codex is NOT a keychain
    // provider, so nothing else ever flips this on desktop — the bug that killed every live awakening beat
    // for ChatGPT-sign-in installs; see harness.js init's codex probe for the boot-time half).
    if (typeof Harness !== 'undefined' && Harness.setDesktopConfigured) Harness.setDesktopConfigured('codex', codexConnected);
    if (codexConnected) {
      // Truthful telemetry: if the sidecar signed in but could NOT prove the (rotated) token reached disk, say so —
      // the session works now, but a restart may require re-signing in. Never claim durable state the harness can't prove.
      if (j.persistError) {
        statusEl.innerHTML = '<span class="conn-dot"></span>connected to ChatGPT — but the sign-in could not be saved to disk; you may need to re-sign in after a restart';
        statusEl.className = 'codex-status warn';
      } else {
        statusEl.innerHTML = '<span class="conn-dot"></span>connected to ChatGPT — your agents can run on your subscription';
        statusEl.className = 'codex-status ok';
      }
      signinBtn.textContent = '↻ RE-SIGN IN';
      logoutBtn.classList.remove('hidden');
    } else if (j.expired) {
      // the stored refresh token is KNOWN-dead (e.g. consumed by another Codex client) — say so honestly
      // instead of a generic "not connected"; DISCONNECT stays offered to drop the dead credentials.
      statusEl.textContent = '⚠ your ChatGPT sign-in expired — ' + (j.reason || 'sign in again to reconnect');
      statusEl.className = 'codex-status bad';
      signinBtn.textContent = '⏼ RE-SIGN IN WITH CHATGPT ▸';
      logoutBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = 'not connected — sign in to use your ChatGPT subscription';
      statusEl.className = 'codex-status';
      signinBtn.textContent = '⏼ SIGN IN WITH CHATGPT ▸';
      logoutBtn.classList.add('hidden');
    }
  }

  function openExternalUrl(url) {
    try {
      const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (invoke) {
        invoke('open_external_url', { url }).catch(() => {
          try { window.open(url, '_blank', 'noopener'); } catch (_) {}
        });
        return;
      }
    } catch (_) {}
    try { window.open(url, '_blank', 'noopener'); } catch (_) {}
  }

  // Kick off the device-code flow: request a code, show it + open the verification page, then poll until done.
  // The flow itself (start → poll → connected) lives in the shared CodexSignIn module (codexsignin.js) so the
  // Settings→PROVIDERS RE-SIGN-IN action drives the exact same engine; this function only paints THIS screen.
  function startCodexSignIn() {
    SFX.click();
    const statusEl = el('codex-status'), codeEl = el('codex-code'), openBtn = el('btn-codex-open');
    CodexSignIn.start({
      onRequesting: () => { statusEl.textContent = 'requesting a sign-in code…'; statusEl.className = 'codex-status'; },
      onError: msg => { statusEl.textContent = msg; statusEl.className = 'codex-status bad'; },
      onCode: c => {
        codeEl.textContent = c.user_code; codeEl.classList.remove('hidden');
        openBtn.classList.remove('hidden');
        // DISPLAY the bare address, OPEN the code-carrying one (open_uri) — see codexsignin.js.
        openBtn.onclick = () => openExternalUrl(c.open_uri || c.verification_uri);
        statusEl.innerHTML = 'enter this code at <b>' + esc(c.verification_uri) + '</b> (opening it now)…';
        openExternalUrl(c.open_uri || c.verification_uri);
      },
      onTimeout: () => { statusEl.textContent = 'sign-in timed out — start again'; statusEl.className = 'codex-status bad'; },
      onConnected: () => { codeEl.classList.add('hidden'); openBtn.classList.add('hidden'); SFX.open(); refreshCodexStatus(); loadCodexModels(); }
    });
  }
  function stopCodexPoll() { cancelOAuthPolls(); }
  // drop every genesis device-code poll except (optionally) one provider's — leaving the screen kills all.
  function cancelOAuthPolls(exceptPid) {
    Object.keys(OAUTH_GENESIS).forEach(pid => {
      if (pid === exceptPid) return;
      if (pid === 'codex') { CodexSignIn.cancel(); return; }
      if (typeof OAuthSignIn !== 'undefined') OAuthSignIn.for(pid).cancel();
    });
  }

  async function codexLogout() {
    SFX.click();
    el('codex-code').classList.add('hidden'); el('btn-codex-open').classList.add('hidden');
    await CodexSignIn.logout();   // also cancels any in-flight device-code poll
    refreshCodexStatus();
  }

  /* ---------- the OTHER keyless device-code providers on the genesis screen (grok/kimi) ----------
     One generic path parameterized by provider id, sharing the SAME #codex-block DOM the codex path paints —
     only one provider is ever picked at a time, so the block is a single shared surface whose copy
     (applyOAuthBlockCopy) and state (refreshOAuthGenesisStatus) follow the pick. Engine = OAuthSignIn.for(pid),
     the exact driver Settings→PROVIDERS uses, hitting /api/auth/<pid>/{start,poll,status,models,logout}. */
  function applyOAuthBlockCopy(pid) {
    const c = OAUTH_GENESIS[pid]; if (!c) return;
    const signinBtn = el('btn-codex-signin'), hint = el('codex-hint');
    if (signinBtn) signinBtn.textContent = '⏼ SIGN IN WITH ' + c.name.toUpperCase() + ' ▸';
    if (hint) {
      hint.textContent = (pid === 'codex')
        ? 'Uses the ChatGPT Plus/Pro account you already have — no API key, no billing setup. Prefer a key? Paste an OpenAI API key above instead.'
        : 'Uses the ' + c.sub + ' you already have — no API key, no billing setup. Prefer a key? Switch to OPENROUTER (or any provider) above.';
    }
    // a stale code/status from the previously picked provider must never dress this one's block
    const codeEl = el('codex-code'), openBtn = el('btn-codex-open');
    if (codeEl) codeEl.classList.add('hidden');
    if (openBtn) openBtn.classList.add('hidden');
    const statusEl = el('codex-status');
    if (statusEl) { statusEl.textContent = 'checking…'; statusEl.className = 'codex-status'; }
  }

  // GET /api/auth/<pid>/status → paint the shared sign-in block for THIS provider (mirrors refreshCodexStatus,
  // which stays literal for codex — source-locked). Also feeds Harness.setDesktopConfigured so brainReady() and
  // the awakening see a live brain the moment sign-in state is known (same law as the codex fix, 2026-07-19).
  async function refreshOAuthGenesisStatus(pid) {
    const c = OAUTH_GENESIS[pid]; if (!c || pid === 'codex') return refreshCodexStatus();
    let j = { connected: false };
    try { const r = await fetch('/api/auth/' + pid + '/status'); j = await r.json(); } catch (_) {}
    oauthConnected[pid] = !!j.connected;
    if (typeof Harness !== 'undefined' && Harness.setDesktopConfigured) Harness.setDesktopConfigured(pid, oauthConnected[pid]);
    if (pickedProvider !== pid) return;   // the pick moved on while we awaited — never paint another provider's block
    const statusEl = el('codex-status'), signinBtn = el('btn-codex-signin'), logoutBtn = el('btn-codex-logout');
    if (!statusEl || !signinBtn || !logoutBtn) return;
    if (oauthConnected[pid]) {
      if (j.persistError) {
        statusEl.innerHTML = '<span class="conn-dot"></span>connected to ' + esc(c.name) + ' — but the sign-in could not be saved to disk; you may need to re-sign in after a restart';
        statusEl.className = 'codex-status warn';
      } else {
        statusEl.innerHTML = '<span class="conn-dot"></span>connected to ' + esc(c.name) + ' — your agents can run on your subscription';
        statusEl.className = 'codex-status ok';
      }
      signinBtn.textContent = '↻ RE-SIGN IN';
      logoutBtn.classList.remove('hidden');
    } else if (j.expired) {
      statusEl.textContent = '⚠ your ' + c.name + ' sign-in expired — ' + (j.reason || 'sign in again to reconnect');
      statusEl.className = 'codex-status bad';
      signinBtn.textContent = '⏼ RE-SIGN IN WITH ' + c.name.toUpperCase() + ' ▸';
      logoutBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = 'not connected — sign in to use your ' + c.sub;
      statusEl.className = 'codex-status';
      signinBtn.textContent = '⏼ SIGN IN WITH ' + c.name.toUpperCase() + ' ▸';
      logoutBtn.classList.add('hidden');
    }
  }

  // GET /api/auth/<pid>/models — the account's real catalog when signed in, else the registry's static roster
  // (same endpoint answers both, flagging errors); mirrors loadCodexModels for the shared model popover.
  async function loadOAuthModels(pid) {
    const c = OAUTH_GENESIS[pid]; if (!c || pid === 'codex') return loadCodexModels();
    const fallback = FALLBACK_MODELS[pid] || [];
    let models = fallback.map(id => ({ id: id })), def = fallback[0];
    try {
      const r = await fetch('/api/auth/' + pid + '/models'); const j = await r.json();
      if (Array.isArray(j.models) && j.models.length) {
        models = j.models.map(m => (typeof m === 'string' ? { id: m } : m)).filter(m => m && m.id);
        def = j.default || (models[0] && models[0].id);
      }
    } catch (_) {}
    if (pickedProvider !== pid) return;   // pick moved on — don't clobber the current provider's catalog
    genesisModels = models.map(m => ({ id: m.id, name: m.displayName || m.name || m.id }));
    genesisOffline = false;
    el('model-count').textContent = '(' + c.sub + ')';
    const mi = el('in-model');
    if (!models.some(m => m.id === mi.value)) mi.value = def || '';
    if (def) mi.placeholder = 'search models — e.g. ' + def;
    if (el('model-pop') && !el('model-pop').hidden) renderModelPop();
    updateHint();
  }

  // device-code sign-in for grok/kimi through the SAME shared engine Settings uses (OAuthSignIn.for), painting
  // the shared block — the literal codex twin is startCodexSignIn above.
  function startOAuthSignIn(pid) {
    const c = OAUTH_GENESIS[pid]; if (!c || pid === 'codex') return startCodexSignIn();
    if (typeof OAuthSignIn === 'undefined') return;
    SFX.click();
    const statusEl = el('codex-status'), codeEl = el('codex-code'), openBtn = el('btn-codex-open');
    OAuthSignIn.for(pid).start({
      onRequesting: () => { statusEl.textContent = 'requesting a sign-in code…'; statusEl.className = 'codex-status'; },
      onError: msg => { statusEl.textContent = msg; statusEl.className = 'codex-status bad'; },
      onCode: cc => {
        codeEl.textContent = cc.user_code; codeEl.classList.remove('hidden');
        openBtn.classList.remove('hidden');
        // DISPLAY the bare address, OPEN the code-carrying one (open_uri) — kimi's page REQUIRES ?user_code=.
        openBtn.onclick = () => openExternalUrl(cc.open_uri || cc.verification_uri);
        statusEl.innerHTML = 'enter this code at <b>' + esc(cc.verification_uri) + '</b> (opening it now)…';
        openExternalUrl(cc.open_uri || cc.verification_uri);
      },
      onTimeout: () => { statusEl.textContent = 'sign-in timed out — start again'; statusEl.className = 'codex-status bad'; },
      onConnected: () => { codeEl.classList.add('hidden'); openBtn.classList.add('hidden'); SFX.open(); refreshOAuthGenesisStatus(pid); loadOAuthModels(pid); }
    });
  }

  async function oauthGenesisLogout(pid) {
    if (pid === 'codex' || !OAUTH_GENESIS[pid]) return codexLogout();
    SFX.click();
    el('codex-code').classList.add('hidden'); el('btn-codex-open').classList.add('hidden');
    if (typeof OAuthSignIn !== 'undefined') await OAuthSignIn.for(pid).logout();   // also cancels any in-flight poll
    refreshOAuthGenesisStatus(pid);
  }

  /* ---------- STARNET MANAGED on the genesis screen ----------
     The subscription path for people who never want to see an API key: buy on starnetos.com, then the
     connect screen links this station to that account with ONE confirmed code — the same sidecar engine
     the STORE uses (/api/credits/link/*), painted into #starnet-block. The chip itself stays HIDDEN
     until the sidecar reports a cloud seam (linked or linkable): a build with no cloud must not offer
     a subscription it cannot link, so a CLOUD_LIVE=false install keeps a starnet-free connect screen. */
  let starnetLinked = false;          // last /api/credits truth — the WAKE gate reads this
  // last known managed balance (null = the service hasn't reported one) + where to buy. WAKE runs a REAL call
  // through managed admission, which refuses a $0 wallet before any model is reached — so a linked-but-empty
  // account must be said HERE, with the fix one button away, never as "your model didn't answer" (2026-08-22:
  // a first-time user signed in without buying credits and kept switching models trying to fix it).
  let starnetBalanceUsd = null, starnetPurchaseUrl = '', starnetLinkStatus = '';
  let _starnetBalancePoll = null;
  function stopStarnetBalancePoll() { if (_starnetBalancePoll) { clearInterval(_starnetBalancePoll); _starnetBalancePoll = null; } }
  function starnetOutOfCredit() { return starnetLinked && typeof starnetBalanceUsd === 'number' && !(starnetBalanceUsd > 0); }
  let userPickedProvider = false;     // a real chip click — the auto-promote below must never override it
  let _starnetLinkPoll = null, _starnetLinkPollBusy = false, _starnetLinkGeneration = 0, _starnetStatusSeq = 0;
  function stopStarnetLinkPoll() {
    _starnetLinkGeneration++;
    _starnetLinkPollBusy = false;
    if (_starnetLinkPoll) { clearInterval(_starnetLinkPoll); _starnetLinkPoll = null; }
  }
  async function revealStarnetGenesis(autoPick) {
    let linked = false, linkable = false;
    try { const j = await Harness.api.get('/api/credits?history=0'); linked = !!(j && j.configured); } catch (_) {}
    if (!linked) { try { const j = await Harness.api.get('/api/credits/linkable'); linkable = !!(j && j.available); } catch (_) {} }
    starnetLinked = linked;
    const b = document.querySelector('.provider-row .prov[data-prov="starnet"]');
    if (b) b.classList.toggle('hidden', !(linked || linkable));
    // THE PROMOTED START: on a fresh create (never a resume, never over a real click) the revealed
    // hero becomes the default pick — the subscription path leads the funnel the moment it exists.
    if (autoPick && (linked || linkable) && !userPickedProvider && pickedProvider !== 'starnet') selectProviderUI('starnet');
    else if (pickedProvider === 'starnet') refreshStarnetGenesisStatus();
    return linked || linkable;
  }
  async function refreshStarnetGenesisStatus() {
    const statusEl = el('starnet-status'), linkBtn = el('btn-starnet-link'), switchBtn = el('btn-starnet-switch');
    if (!statusEl) return { answered: false, linked: starnetLinked, balanceUsd: null, linkStatus: 'unavailable' };
    let j = null;
    let answered = false;
    const seq = ++_starnetStatusSeq;
    const priorLinked = starnetLinked, priorPurchaseUrl = starnetPurchaseUrl;
    let timeout = null;
    try {
      j = await Promise.race([
        Harness.api.get('/api/credits?history=0'),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('credits status timeout')), 10000); })
      ]);
      answered = !!(j && typeof j.configured === 'boolean');
    }
    catch (e) {
      // /api/credits deliberately 404s when no account is linked. That is a definitive "not linked", not a
      // balance outage; preserve the one-button LINK guidance. Every other failure remains unavailable.
      if (/http 404\b/.test(String((e && e.message) || e))) { j = { configured: false }; answered = true; }
    }
    finally { if (timeout) clearTimeout(timeout); }
    // A slower old request must never repaint a newer account/balance answer. The caller gets UNKNOWN and may
    // retry; it never gets an old zero that could deny a funded account.
    if (seq !== _starnetStatusSeq) return { answered: false, linked: starnetLinked, balanceUsd: null, linkStatus: 'unavailable' };
    if (!answered) j = { configured: priorLinked, linkStatus: 'unavailable', purchaseUrl: priorPurchaseUrl };
    starnetLinked = !!(j && j.configured);
    starnetLinkStatus = (j && (j.linkStatus || j.reason)) ? String(j.linkStatus || j.reason) : '';
    starnetBalanceUsd = (starnetLinked && typeof j.balanceUsd === 'number' && isFinite(j.balanceUsd)) ? j.balanceUsd : null;
    starnetPurchaseUrl = (starnetLinked && j.purchaseUrl) ? String(j.purchaseUrl) : '';
    const result = () => ({ answered, linked: starnetLinked, balanceUsd: starnetBalanceUsd, linkStatus: starnetLinkStatus });
    const creditsBtn = el('btn-starnet-credits');
    if (pickedProvider !== 'starnet') { stopStarnetBalancePoll(); return result(); }   // pick moved on — don't repaint another provider's block
    if (starnetLinked && starnetLinkStatus === 'unavailable') {
      stopStarnetBalancePoll();
      statusEl.textContent = 'link saved on this station, but StarNet could not verify it right now — check your connection and try again.';
      statusEl.className = 'codex-status bad';
      if (linkBtn) linkBtn.classList.add('hidden');
      if (creditsBtn) creditsBtn.classList.add('hidden');
      if (switchBtn) switchBtn.classList.remove('hidden');
    } else if (starnetLinked && starnetOutOfCredit()) {
      // linked, wallet empty: the one state WAKE can never fix. Say it, offer the store, and keep polling the
      // balance so the moment the purchase lands this line flips green without a restart.
      statusEl.innerHTML = '<span class="conn-dot"></span>linked to your StarNet account — <b>no credits yet</b>. Waking your agent uses credits right away, so add some first.';
      statusEl.className = 'codex-status bad';
      if (linkBtn) linkBtn.classList.add('hidden');
      if (switchBtn) switchBtn.classList.remove('hidden');
      if (creditsBtn) { creditsBtn.classList.remove('hidden'); creditsBtn.onclick = () => { SFX.click(); if (starnetPurchaseUrl) openExternalUrl(starnetPurchaseUrl); }; }
      if (!_starnetBalancePoll) _starnetBalancePoll = setInterval(() => { if (pickedProvider === 'starnet' && starnetOutOfCredit()) refreshStarnetGenesisStatus(); else stopStarnetBalancePoll(); }, 10000);
    } else if (starnetLinked) {
      stopStarnetBalancePoll();
      const bal = (starnetBalanceUsd == null) ? '' : ' · $' + starnetBalanceUsd.toFixed(2) + ' available';
      statusEl.innerHTML = '<span class="conn-dot"></span>linked to your StarNet account' + esc(bal) + ' — your agents run on your subscription';
      statusEl.className = 'codex-status ok';
      if (linkBtn) linkBtn.classList.add('hidden');
      if (creditsBtn) creditsBtn.classList.add('hidden');
      if (switchBtn) switchBtn.classList.remove('hidden');
    } else {
      stopStarnetBalancePoll();
      if (creditsBtn) creditsBtn.classList.add('hidden');
      if (switchBtn) switchBtn.classList.add('hidden');
      statusEl.textContent = starnetLinkStatus === 'revoked' || starnetLinkStatus === 'link_revoked'
        ? 'this station’s previous link was removed from your account — link it again to reconnect your credits.'
        : 'not linked — connect the subscription you bought on starnetos.com (takes one click + a code)';
      statusEl.className = 'codex-status' + (starnetLinkStatus === 'revoked' || starnetLinkStatus === 'link_revoked' ? ' bad' : '');
      if (linkBtn) linkBtn.classList.remove('hidden');
    }
    return result();
  }
  // A station can be linked to a DIFFERENT StarNet login than the browser account that owns the purchase.
  // Genesis used to auto-recognize that old device and offer only ADD CREDITS, trapping a paid beginner on
  // the wrong account. Switching clears both credential halves, re-reads provider truth, and starts the normal
  // pairing flow immediately — no Terminal, logs, reinstall, or trip through Settings required.
  async function switchStarnetAccount() {
    SFX.click();
    stopStarnetLinkPoll(); stopStarnetBalancePoll(); _starnetStatusSeq++;
    const statusEl = el('starnet-status'), switchBtn = el('btn-starnet-switch');
    if (switchBtn) switchBtn.disabled = true;
    if (statusEl) { statusEl.textContent = 'disconnecting this account so you can link the one with your credits…'; statusEl.className = 'codex-status'; }
    try {
      const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (invoke) await invoke('harness_clear_credits_token');
      const response = await Harness.api.post('/api/credits/unlink', {});
      if (!response || !response.ok || (response.j && response.j.ok === false)) throw new Error('unlink refused');
      if (Harness.refreshCreditsConfigured) await Harness.refreshCreditsConfigured();
      starnetLinked = false; starnetBalanceUsd = null; starnetPurchaseUrl = ''; starnetLinkStatus = '';
      if (switchBtn) { switchBtn.classList.add('hidden'); switchBtn.disabled = false; }
      startStarnetLink();
    } catch (_) {
      if (statusEl) { statusEl.textContent = 'could not disconnect this account safely — try again.'; statusEl.className = 'codex-status bad'; }
      if (switchBtn) switchBtn.disabled = false;
    }
  }
  // Mint a pairing code, open the browser to confirm it, poll until linked. The device token never enters
  // this WebView: the sidecar holds it, and on desktop Rust immediately moves it into the OS keychain.
  function startStarnetLink() {
    SFX.click();
    stopStarnetLinkPoll();
    const generation = _starnetLinkGeneration;
    const statusEl = el('starnet-status'), codeEl = el('starnet-code'), openBtn = el('btn-starnet-open');
    const fail = t => { statusEl.textContent = t; statusEl.className = 'codex-status bad'; codeEl.classList.add('hidden'); openBtn.classList.add('hidden'); };
    statusEl.textContent = 'requesting a link code…'; statusEl.className = 'codex-status';
    Harness.api.post('/api/credits/link/start', { deviceName: 'StarNet Station' })
      .then(r => { if (generation !== _starnetLinkGeneration) return null; if (!r || !r.ok) throw new Error('start failed'); return r.j; })
      .then(j => {
        if (generation !== _starnetLinkGeneration) return;
        if (!j || !j.code) throw new Error('no code');
        codeEl.textContent = j.code; codeEl.classList.remove('hidden');
        openBtn.classList.remove('hidden');
        openBtn.onclick = () => openExternalUrl(j.verifyUrl);
        statusEl.textContent = 'confirm this code in your browser (opening the link page now)…';
        openExternalUrl(j.verifyUrl);
        const expiresAt = Number(j.expiresAt) || 0;
        const tick = () => {
          if (generation !== _starnetLinkGeneration || _starnetLinkPollBusy) return;
          if (expiresAt && Date.now() > expiresAt) { stopStarnetLinkPoll(); fail('that code expired — start again'); return; }
          _starnetLinkPollBusy = true;
          Harness.api.post('/api/credits/link/poll', { code: j.code })
            .then(r2 => (r2 && r2.ok) ? r2.j : {})
            .then(p => {
              if (generation !== _starnetLinkGeneration) return;
              if (p && p.linked) {
                stopStarnetLinkPoll(); SFX.open();
                codeEl.classList.add('hidden'); openBtn.classList.add('hidden');
                // desktop: move the fresh token file → OS keychain NOW (Rust reads + moves; the token
                // never passes through here), then teach Harness the credential exists so
                // configured('starnet') answers true without a restart.
                const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
                const adopt = invoke ? Promise.resolve(invoke('harness_adopt_credits_token')).catch(() => false) : Promise.resolve(false);
                // The poll response is the first authoritative statement about the account that was JUST
                // confirmed. Seed the screen from it immediately, then re-read /api/credits after keychain
                // adoption. An older linked account's cached $0 must never survive across this boundary.
                starnetLinked = true;
                starnetBalanceUsd = (typeof p.balanceUsd === 'number' && isFinite(p.balanceUsd)) ? p.balanceUsd : null;
                starnetLinkStatus = p.balanceVerified === false ? 'unavailable' : 'valid';
                adopt
                  .then(() => (Harness.refreshCreditsConfigured ? Harness.refreshCreditsConfigured() : null))
                  .then(() => { refreshStarnetGenesisStatus(); loadModels('starnet'); });
                return;
              }
              if (p && (p.status === 'expired' || p.status === 'consumed' || p.status === 'unknown' || p.status === 'invalid')) {
                stopStarnetLinkPoll(); fail('that code is no longer valid — start again');
              }
            })
            .catch(() => {})
            .finally(() => { if (generation === _starnetLinkGeneration) _starnetLinkPollBusy = false; });
        };
        _starnetLinkPoll = setInterval(tick, 2000);
      })
      .catch(() => { if (generation === _starnetLinkGeneration) fail('could not reach the link service — try again'); });
  }

  // the SKIN picker: choose which sprite set (teddy bear, pepe, …) the new agent wears. The chosen
  // id rides on agent.skin and is read by the sprite engine (assets.js drawBody → DATA.SKINS).
  // A live preview STAGE on the right (shared SkinStage) plays the picked (or hovered) skin's real
  // walk cycle big enough to actually read — a 40px still of a chunky sprite is unidentifiable.
  function buildSkins() {
    const wrap = el('skin-picker'); if (!wrap || typeof DATA === 'undefined' || !DATA.SKINS) return;
    wrap.innerHTML = '';
    if (!DATA.SKINS[pickedSkin]) pickedSkin = DATA.DEFAULT_SKIN;
    // DEFAULT-FIRST ordering: the default skin leads, followed by its near-identical recolor family (grouped so
    // they read as variants of ONE skin), then the distinct characters — instead of the default sitting buried
    // 10th behind nine characters. Data order (data-shim.js) is untouched; this is purely the render order.
    const def = DATA.DEFAULT_SKIN;
    const inFamily = id => id === def || id.indexOf(def + '_') === 0;
    const ids = Object.keys(DATA.SKINS);
    const ordered = [def, ...ids.filter(id => id !== def && inFamily(id)), ...ids.filter(id => !inFamily(id))].filter(id => DATA.SKINS[id]);
    // stage handle (assigned by the mount below): drive THIS stage, not the module-level shortcut, which
    // belongs to whichever picker mounted last once more than one is on screen.
    let stage = null;
    ordered.forEach(id => {
      const sk = DATA.SKINS[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'skin-thumb' + (id === pickedSkin ? ' sel' : '');
      b.title = sk.name || id; b.setAttribute('aria-pressed', String(id === pickedSkin));
      const img = document.createElement('img');
      img.src = 'assets/sprites/' + sk.set + '/rot_south.png';
      img.alt = sk.name || id; img.draggable = false;
      b.appendChild(img);
      b.onclick = () => {
        pickedSkin = id;
        [...wrap.children].forEach(x => { const on = x === b; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', String(on)); });
        if (stage) stage.show(id);
        SFX.click();
      };
      // hover scrubs the stage so you can compare without committing; leaving snaps back to the pick
      b.onmouseenter = () => { if (stage) stage.show(id); };
      wrap.appendChild(b);
    });
    wrap.onmouseleave = () => { if (stage) stage.show(pickedSkin); };
    if (typeof SkinStage !== 'undefined') stage = SkinStage.mount(el('skin-stage-img'), el('skin-stage-name'), pickedSkin);
  }

  /* ---------- VOICE & MANNER (the create-screen personality system) ----------
     A grounded archetype is the base; the FINE-TUNE dials + a free-text note tune it past the preset.
     pickedPersona/pickedTraits/pickedCustomVoice flow onto the agent at onWake and into the prompt via
     Personas.compose. Each card shows a sample line so choosing a voice is fun; a live preview echoes
     how the picked voice (plus any tuning) actually sounds. */
  function buildVoice() {
    const wrap = el('voice-archetypes'); if (!wrap || typeof Personas === 'undefined') return;
    if (!Personas.exists(pickedPersona)) pickedPersona = Personas.DEFAULT_ID;
    pickedPersona = Personas.resolve(pickedPersona);   // collapse any legacy id to its grounded archetype
    wrap.innerHTML = '';
    let armedChip = null;   // the UNHINGED chip while it awaits its second press (house two-press confirm)
    const disarm = () => { if (armedChip) { armedChip.textContent = armedChip.dataset.name; armedChip.classList.remove('arm'); armedChip = null; } };
    Personas.list().forEach(p => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ov-vchip' + (p.id === pickedPersona ? ' sel' : '');
      chip.title = p.vibe;
      chip.textContent = p.name;
      chip.dataset.name = p.name;
      chip.setAttribute('aria-pressed', String(p.id === pickedPersona));
      chip.onclick = () => {
        // UNHINGED curses for real, so its chip arms first (same two-press pattern as the delete buttons):
        // press one names what it means, press two selects. Once confirmed, it's a normal chip this screen.
        if (p.id === 'unhinged' && pickedPersona !== 'unhinged' && !unhingedConfirmed && armedChip !== chip) {
          disarm();
          armedChip = chip;
          chip.classList.add('arm');
          chip.textContent = 'UNHINGED — SURE? it swears, for real';
          SFX.click();
          return;
        }
        if (p.id === 'unhinged') unhingedConfirmed = true;
        disarm();
        pickedPersona = p.id;
        [...wrap.children].forEach(x => { const on = x === chip; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', String(on)); });
        SFX.click(); renderVoicePreview();
      };
      wrap.appendChild(chip);
    });
    renderVoicePreview();
  }

  // Voice fine-tune UI (trait dials / extras toggles / free-text note) REMOVED from the create screen
  // (2026-07-09 decision): the archetype chip is the whole genesis voice choice. pickedTraits /
  // pickedCustomVoice remain as state so RESUMED agents keep the voiceTraits/customVoice they already
  // carry — Personas.compose still honors them; a fresh create simply never sets them.

  // The sample-reply quote is GONE from personality selection (Andrew, 2026-07-20): the chip's name +
  // vibe tooltip are the whole pitch. This block now renders ONLY the legacy "tuned:" readout for
  // resumed agents that still carry voiceTraits (fine-tune UI removed 2026-07-09); a fresh create
  // renders nothing here.
  function renderVoicePreview() {
    const pv = el('voice-preview'); if (!pv || typeof Personas === 'undefined') return;
    const p = Personas.get(pickedPersona);
    const tweaks = [];
    if (Personas.TRAITS) Personas.TRAITS.forEach(t => {
      const v = pickedTraits[t.key];
      if (v != null && v !== t.neutral) tweaks.push(t.ends[v > t.neutral ? 1 : 0]);
    });
    if (Personas.TOGGLES) Personas.TOGGLES.forEach(g => { if (pickedTraits[g.key]) tweaks.push(g.label.toLowerCase()); });
    pv.innerHTML = '';
    if (!tweaks.length) return;
    const m = document.createElement('div'); m.className = 'vp-meta';
    m.textContent = p.name + ' · tuned: ' + tweaks.join(', ');
    pv.appendChild(m);
  }

  // initConnect(prefillName, isRecovery, savedAgent)
  //  - fresh first run: initConnect() -> CREATE YOUR OVERSEER (everything live).
  //  - RESUME / recovery (saved station, missing creds, or a disconnect re-entry): pass isRecovery=true and the
  //    savedAgent so the screen becomes a RESUME console: a phosphor banner, the model pre-filled, and the
  //    identity fields (name · skin · voice · approval) shown READ-ONLY so resume can't silently re-spec the
  //    agent. The key/provider section stays live so the Commander can re-enter a key and continue.
  function initConnect(prefillName, isRecovery, savedAgent) {
    const recovery = !!isRecovery && !!savedAgent;
    el('in-key').value = Harness.getKey();
    // remember what the field was pre-seeded with (browser BYOK: a real stored key; desktop keychain: '') so
    // onWake can ask ONCE before an edited value silently replaces a stored key. Reset the confirm latch for
    // this fresh screen. (An empty prefill means there's nothing to overwrite — the guard stays dormant.)
    prefilledKey = el('in-key').value || '';
    keyOverwriteConfirmed = false;
    unhingedConfirmed = false;   // each fresh create screen re-arms the UNHINGED two-press confirm
    // desktop: the key lives in the OS keychain (getKey returns ''); show that it's already set.
    if (Harness.configured && Harness.configured() && !el('in-key').value) {
      el('in-key').placeholder = '•••••••• stored in keychain — leave blank to keep';
    }
    // RESUME pre-fills the saved agent's model; a fresh screen carries the last-used model.
    el('in-model').value = recovery ? (savedAgent.model || Harness.getModel()) : Harness.getModel();
    if (prefillName) el('in-name').value = prefillName;
    // a fresh create screen carries no stale voice picks — reset the module-level state so fine-tune
    // dials / a custom-voice note from an abandoned create session never ride onto the next agent.
    // In RESUME the saved agent's own identity is authoritative — seed the pickers FROM it so the read-only
    // view shows the real skin/voice/approval (and onWake, were it ever reached, wouldn't downgrade them).
    if (recovery) {
      pickedTraits = Object.assign({}, savedAgent.voiceTraits || {});
      pickedCustomVoice = savedAgent.customVoice || '';
      pickedPersona = savedAgent.personaId || ((typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'professional');
      pickedApproval = (savedAgent.approvalMode === 'full') ? 'full' : 'ask';
      pickedSkin = savedAgent.skin || pickedSkin;
    } else {
      pickedTraits = {}; pickedCustomVoice = ''; pickedPersona = (typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'professional';
      pickedApproval = 'ask';   // a fresh create screen defaults to the safe posture (color is fixed: the lead's gold)
    }
    buildPhosphor();
    buildSkins();
    buildVoice();
    buildApproval();
    // the hero nameplate tracks the name field live; picking an approval mode updates the second line.
    if (el('in-name')) el('in-name').oninput = updateNameplate;
    updateNameplate();
    applyRecoveryMode(recovery, savedAgent);
    // fresh screen: release any stale WAKE latch and drop the WAKING… label stash (applyRecoveryMode set the real
    // label just above), so a re-entry after an errored attempt has a live, correctly-labelled WAKE button.
    waking = false; { const wb = el('btn-wake'); if (wb) { wb.disabled = false; delete wb.dataset.idleLabel; } }
    el('btn-back').onclick = onConnectBack;
    el('btn-wake').onclick = onWake;
    // Enter commits from ANY of the core text fields (name / key / model), not just the name — so a Commander
    // who fills the key or types a model slug and hits Enter wakes the agent instead of nothing happening.
    const enterWakes = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); onWake(); } };
    el('in-name').onkeydown = enterWakes;
    el('in-key').onkeydown = enterWakes;
    wireModelField();   // #in-model is a search combobox over #model-pop; it owns its keydown (Enter picks a row, else WAKEs)
    // provider toggle + ChatGPT sign-in wiring; selectProviderUI() also loads the right model catalog.
    // Clear the model on a real USER switch so the new provider's curated default (MODEL_PICKS[p][0]) fills
    // instead of carrying a cross-provider slug (e.g. codex 'gpt-5.5' bleeding onto OpenRouter, which needs
    // 'openai/gpt-5.5'). The programmatic call below (resume) keeps the saved model — it never routes here.
    document.querySelectorAll('.provider-row .prov').forEach(b => { b.onclick = () => { SFX.click(); userPickedProvider = true; if (b.dataset.prov !== pickedProvider) el('in-model').value = ''; selectProviderUI(b.dataset.prov); }; });
    // the long-tail providers start folded behind ＋ MORE so a first-run user faces 6 chips, not 15.
    // selectProviderUI() unfolds the row itself whenever the active provider lives in the tail.
    const provRow = document.querySelector('.provider-row'), provMore = el('prov-more');
    if (provRow && provMore) {
      setProviderRowExpanded(false);   // collapse the tail + COMPUTE the "＋ N MORE" label from the live tail count (never hardcoded)
      provMore.onclick = () => { SFX.click(); setProviderRowExpanded(provRow.classList.contains('collapsed')); };
    }
    // the sign-in block is SHARED by every keyless OAuth provider — dispatch on the current pick.
    // On the merged OPENAI card the sign-in half IS ChatGPT/codex.
    const codexHere = () => pickedProvider === 'codex' || pickedProvider === 'openai';
    el('btn-codex-signin').onclick = () => (codexHere() ? startCodexSignIn() : startOAuthSignIn(pickedProvider));
    el('btn-codex-logout').onclick = () => (codexHere() ? codexLogout() : oauthGenesisLogout(pickedProvider));
    // STARNET MANAGED: reveal the hero only when this station actually has a cloud seam, and wire its link
    // flow. On a fresh create the revealed hero also becomes the default pick (the promoted easiest start);
    // a resume keeps the agent's saved provider.
    userPickedProvider = false;
    { const sl = el('btn-starnet-link'); if (sl) sl.onclick = () => startStarnetLink(); }
    { const ss = el('btn-starnet-switch'); if (ss) ss.onclick = () => switchStarnetAccount(); }
    revealStarnetGenesis(!recovery);
    // BYOK key-safety note: collapsed by default, expanded by its own disclosure toggle (progressive disclosure).
    { const bt = el('byok-toggle'), bn = el('byok-note');
      if (bt && bn) {
        bn.classList.add('hidden'); bt.setAttribute('aria-expanded', 'false'); bt.textContent = '▸ where does my key go?';
        bt.onclick = () => { const open = !bn.classList.toggle('hidden'); bt.setAttribute('aria-expanded', String(open)); bt.textContent = (open ? '▾' : '▸') + ' where does my key go?'; SFX.click(); };
      } }
    // RESUME/recovery honours the agent's saved provider; a FRESH create screen leads with the beginner-first
    // default (pickedProvider = 'codex' — sign in with ChatGPT, no API key), the top of the zero-to-value funnel.
    selectProviderUI(recovery ? Harness.getProv() : pickedProvider);
    // INITIAL FOCUS: fresh create → the name field (the natural first action); RESUME → the credential control the
    // Commander must act on (the ChatGPT sign-in button on the keyless Codex path, else the key box). NEVER the
    // model field (focusing it springs the popover open) and never the phosphor swatches (the old Tab-start bug).
    setTimeout(() => {
      try {
        if (!recovery) { const n = el('in-name'); if (n) n.focus(); }
        else if (pickedProvider === 'starnet') { const c = el('btn-starnet-link'); if (c) c.focus(); }
        else if (isOAuthProviderId(pickedProvider)) { const c = el('btn-codex-signin'); if (c) c.focus(); }
        else { const k = el('in-key'); if (k && el('key-block') && !el('key-block').classList.contains('hidden')) k.focus(); else { const c = el('btn-codex-signin'); if (c) c.focus(); } }
      } catch (_) {}
    }, 0);
  }

  // RESUME mode dressing for the connect screen. Recovery = an existing station re-entering (missing creds or a
  // disconnect): swap the GENESIS header for a RESUME banner, lock the identity fields (name · skin · voice ·
  // approval) READ-ONLY so resume can't re-spec the agent, and keep the key/provider section + WAKE live. A
  // fresh first run passes recovery=false, which clears all of this back to the CREATE YOUR OVERSEER console.
  function applyRecoveryMode(recovery, savedAgent) {
    const screen = el('screen-connect');
    if (screen) screen.classList.toggle('recovery', recovery);
    // EXPORT is only meaningful when there's a saved agent to back up — surface it in RESUME mode (the title
    // screen that used to host it is gone), hide it on a fresh first run where there's nothing yet.
    const exp = el('btn-export'); if (exp) exp.classList.toggle('hidden', !recovery);
    // BACK only exists in RESUME (it re-runs auto-resume). On a fresh first run the create screen is the
    // root — a dead BACK button that does nothing only teaches "buttons here may not work". Hide it.
    const back = el('btn-back'); if (back) back.classList.toggle('hidden', !recovery);
    const banner = el('cc-recovery');
    const title = el('cc-title'), sub = el('cc-sub'), mode = el('cc-mode');
    const wake = el('btn-wake');
    // the identity fields resume must NOT let the Commander re-spec — visually muted, kept in the DOM so onWake
    // (if ever reached) still reads the seeded values rather than blanks.
    const locked = ['in-name', 'skin-picker', 'voice-archetypes', 'voice-preview',
                    'approval-picker', 'phosphor-swatches'];
    if (recovery) {
      const nm = (savedAgent && savedAgent.name) || 'your agent';
      if (banner) {
        banner.classList.remove('hidden');
        banner.innerHTML = '▮ RESUMING <b>' + U.esc(nm) + '</b> — your agent is safe. Enter your key to continue.';
      }
      if (title) title.textContent = '▮ RESUME ' + nm.toUpperCase();
      if (sub) sub.innerHTML = 'your station is intact — this only re-connects the <b>brain</b>. Identity stays as you left it.';
      if (mode) mode.textContent = 'RESUME';
      if (wake) wake.textContent = '⏼ RESUME STATION ▸';
      // BACK here doesn't go "back" — onConnectBack() re-runs auto-resume (a fresh credential check may now pass
      // straight into the station). Label it for what it does so it doesn't read as a dead retreat button.
      if (back) back.textContent = '↻ RETRY AUTO-RESUME';
      locked.forEach(id => { const n = el(id); if (n) { n.classList.add('field-locked'); n.setAttribute('aria-disabled', 'true'); } });
      const nameIn = el('in-name'); if (nameIn) { nameIn.readOnly = true; nameIn.tabIndex = -1; }
    } else {
      if (banner) { banner.classList.add('hidden'); banner.innerHTML = ''; }
      if (title) title.textContent = '▮ CREATE YOUR OVERSEER';
      if (sub) sub.innerHTML = 'the first mind you wake is your <b>OVERSEER</b> — it runs the station and recruits every agent after it.';
      if (mode) mode.textContent = 'GENESIS';
      if (wake) wake.textContent = '⏼ WAKE OVERSEER ▸';
      locked.forEach(id => { const n = el(id); if (n) { n.classList.remove('field-locked'); n.removeAttribute('aria-disabled'); } });
      const nameIn = el('in-name'); if (nameIn) { nameIn.readOnly = false; nameIn.removeAttribute('tabindex'); }
    }
  }

  // BACK from the connect screen. With the title screen gone there's nowhere to retreat TO, so BACK is a
  // context move: in RESUME it re-runs auto-resume (a fresh credential check may now pass straight in); on a
  // fresh first run it's a no-op beyond dropping any in-flight codex poll (the create screen is the root).
  function onConnectBack() {
    SFX.click(); stopCodexPoll();
    const saved = Save.has() ? Save.load() : null;
    if (saved && saved.agent) { reentry(); return; }
    // fresh first run — nothing behind the create screen; just stay put.
  }

  // The single re-entry point that replaces the old title screen for any "leave the game / lost creds" path
  // (disconnect, recovery, back). Preserves the agent ALWAYS: if creds are in hand it resumes straight into the
  // station; otherwise it shows the connect screen in RESUME mode. Only a genuine no-save state falls through
  // to a fresh creation.
  function reentry() {
    // FORWARD-VERSION GATE (P0.3): a re-entry (disconnect / back / recovery) must not fall through to a fresh
    // create when the stored save is from a NEWER build — Save.load() returns null for it, which would look like
    // "no save" and clobber it on first persist(). Stop at the honest update gate; the save stays untouched.
    if (Save.isFuture && Save.isFuture()) { showFutureSaveGate(Save.loadStatus().version); return; }
    const saved = Save.has() ? Save.load() : null;
    if (saved && saved.agent) {
      if (saved.prov && Harness.setProv) Harness.setProv(saved.prov);
      if (saved.reasoningEffort && Harness.setReasoningEffort) Harness.setReasoningEffort(saved.reasoningEffort);
      if (Harness.getKey() || (Harness.configured && Harness.configured()) || Harness.getProv() === 'codex') {
        resumingSaved = null; resumeInto(saved); return;
      }
      resumingSaved = saved;
      show('screen-connect'); initConnect(saved.agent.name, true, saved.agent);
      el('connect-msg').textContent = '';
      return;
    }
    startCreation();
  }

  // WAKE is a ONE-SHOT: a double-click, or Enter-then-click, must never run enterGame twice (that would
  // double-spawn the hero and double-reset every store). `waking` latches for the whole attempt; a validation
  // bounce releases it so the Commander can fix the input and retry (NEVER blocking entry — sandbox law), while a
  // real wake keeps it latched (the screen transitions away regardless).
  let waking = false;
  function wakeBtnBusy(busy) {
    const b = el('btn-wake'); if (!b) return;
    if (busy) { if (b.dataset.idleLabel == null) b.dataset.idleLabel = b.textContent; b.textContent = '⏼ WAKING…'; b.disabled = true; }
    else { if (b.dataset.idleLabel != null) { b.textContent = b.dataset.idleLabel; delete b.dataset.idleLabel; } b.disabled = false; }
  }
  async function onWake() {
    if (waking) return;
    waking = true;
    try {
      const entered = await onWakeAttempt();
      if (!entered) { waking = false; wakeBtnBusy(false); }   // validation bounce (absent/edited key or model) — release so the user can retry
    } catch (e) {
      waking = false; wakeBtnBusy(false);
      const msg = el('connect-msg'); if (msg) { msg.className = 'msg bad'; msg.textContent = 'could not start — ' + ((e && e.message) || 'try again'); }
    }
  }
  // THE WIRE PREFLIGHT — one real reason-only round-trip through the exact path the awakening will use
  // (Harness.chat: provider + model + auth + stream, end to end). Returns { ok } or { ok:false, why } with
  // an honest, console-renderable reason. Bounded at 30s so a stalled provider can never hang the button.
  async function preflightWire() {
    try {
      if (typeof Harness === 'undefined' || !Harness.chat) return { ok: false, why: 'the harness is not loaded (reload the app)' };
      const call = Harness.chat({ system: '', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], agentId: 'agent', isTask: false, placed: [], internal: true })
        .catch(e => ({ error: true, text: String((e && e.message) || e) }));
      const res = await Promise.race([call, new Promise(r => setTimeout(() => r(null), 30000))]);
      if (!res) return { ok: false, why: 'no reply within 30 seconds (network or provider stall)' };
      // Harness.chat reports a refusal as a STRING in res.error with text '' (the run never produced output)
      // — read that first, or every up-front refusal (billing, sign-in, concurrency) collapses to the
      // useless "the provider returned an error" and the real reason never reaches the screen.
      const reason = (typeof res.error === 'string' && res.error.trim()) ? res.error : String(res.text || '');
      if (res.error || !String(res.text || '').trim()) return { ok: false, why: (reason.trim() ? reason.replace(/\s+/g, ' ').slice(0, 160) : 'the provider returned an error') };
      return { ok: true };
    } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 140) }; }
  }

  // Returns TRUE once it commits to entering the station (WAKING latched), FALSE on any validation bounce.
  async function onWakeAttempt() {
    SFX.boot(); SFX.open();
    stopCodexPoll();   // leaving the connect screen — drop any in-flight sign-in poll
    stopStarnetLinkPoll();   // …and any in-flight StarNet pairing poll (same screen-exit rule)
    stopStarnetBalancePoll();   // …and the empty-wallet balance poll
    // single funnel for agent.name → honor the 18-char design cap (covers the roster-pick path too).
    // A blank/sentinel name mints a station codename (never the bland 'AGENT'), matching the awakening
    // speaker — dialogue.js owns the generator so both surfaces stay consistent.
    let rawName = el('in-name').value.trim();
    if (typeof Dialogue !== 'undefined' && Dialogue.isUnnamed && Dialogue.isUnnamed(rawName)) rawName = Dialogue.codename();
    const name = (rawName || 'AGENT').toUpperCase().slice(0, 18);
    const msg = el('connect-msg'); msg.className = 'msg';
    // PL-08: provider prerequisites outrank the asynchronously refreshed model catalog. A rapid
    // CUSTOM → WAKE can still have the prior Codex slug in #in-model for one turn; that stale value
    // must never make us coach the Commander to pick gpt-5.5 for an unrelated /v1 endpoint.
    const baseUrl = el('in-base-url') ? el('in-base-url').value.trim() : '';
    if (providerNeedsBaseUrl(pickedProvider) && !baseUrl) {
      msg.textContent = 'enter your Custom /v1 base URL.';
      return false;
    }
    const model = el('in-model').value.trim();
    if (!model) {
      // COLD-START: never strand a beginner on an empty required field. Pre-fill a sensible default for the
      // chosen provider (Codex discovers its own lineup, so leave that path to its own picker) and say so.
      if (pickedProvider !== 'codex') {
        const def = defaultModelFor(pickedProvider);
        const inp = el('in-model'); if (inp && def) { inp.value = def; updateHint(); }
        msg.textContent = 'pick a model — suggested ' + (def || 'a default') + '. edit it above, then WAKE.';
      } else {
        msg.textContent = 'choose or type a model slug.';
      }
      return false;
    }
    if (pickedProvider === 'starnet') {
      // MONEY TRUTH MUST BE FRESH AT THE DECISION. The screen's painted balance can predate a purchase or a
      // relink; using that cached $0 here stranded a funded customer even though /v1/balance already held the
      // credits. GET /api/credits performs an awaited authoritative refresh for the ACTIVE linked account.
      // Only a successful finite zero may deny WAKE. A failed/unknown read is unavailable, never "$0".
      msg.textContent = 'checking your StarNet credits…';
      const creditState = await refreshStarnetGenesisStatus();
      if (!creditState || !creditState.answered || (creditState.linked && creditState.balanceUsd == null)) {
        msg.className = 'msg bad';
        msg.textContent = 'StarNet couldn’t confirm your credit balance right now. Your credits are safe — try WAKE again in a moment.';
        return false;
      }
      if (!creditState.linked) { msg.textContent = 'link your StarNet account first — press 🔗 LINK YOUR STARNET ACCOUNT above.'; return false; }
      if (!(creditState.balanceUsd > 0)) { msg.className = 'msg bad'; msg.textContent = 'your StarNet account has no credits yet — waking your agent uses credits right away. Press ＄ ADD CREDITS above, then WAKE again.'; return false; }
      Harness.setModel(model); Harness.setProv('starnet');
    } else if (isOAuthProviderId(pickedProvider)) {
      if (!oauthConnected[pickedProvider]) { msg.textContent = 'sign in with ' + OAUTH_GENESIS[pickedProvider].name + ' first, or switch to OpenRouter.'; return false; }
      Harness.setModel(model); Harness.setProv(pickedProvider);
    } else if (pickedProvider === 'openai' && !el('in-key').value.trim() && !(Harness.configured && Harness.configured('openai')) && codexConnected) {
      // THE MERGED OPENAI CARD, ChatGPT half: no key typed, no stored OpenAI credential, but a LIVE ChatGPT
      // sign-in — the sign-in IS the credential, so this wake rides the codex path. A typed key always wins
      // (explicit beats ambient) and falls through to the key branch below.
      Harness.setModel(model); Harness.setProv('codex');
    } else {
      const key = el('in-key').value.trim();
      if (providerNeedsBaseUrl(pickedProvider)) {
        if (Harness.setBaseUrl) await Harness.setBaseUrl(baseUrl, pickedProvider);
      }
      const configured = !!(Harness.configured && Harness.configured(pickedProvider));
      if (providerNeedsKey(pickedProvider) && !key && !configured) {
        // COLD-START guidance: a new user has no key AND no idea where to get one. Name the provider and link
        // the exact page that mints a key (from providerSignupUrl — same destinations the placeholder hints at).
        // The merged OPENAI card has a second door — say both, in the order the card shows them.
        const url = providerSignupUrl(pickedProvider);
        const host = String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
        msg.innerHTML = (pickedProvider === 'openai' ? 'sign in with ChatGPT below, or ' : '')
          + 'enter your ' + esc(providerLabel(pickedProvider)) + ' API key — get one at '
          + '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="connect-link">' + esc(host) + '</a>.';
        return false;
      }
      // OVERWRITE GUARD: the field was pre-filled from a stored key, and the Commander edited it to a DIFFERENT
      // value — saving would silently replace the stored key. Ask once (inline, no modal) before that happens.
      // Only fires when there genuinely was a stored key to lose (prefilledKey non-empty), the value actually
      // changed, and it hasn't already been confirmed this screen. An untouched pre-fill saves the same key
      // (a no-op replace) so it never trips; a blank field keeps the stored key (handled below) so it never trips.
      if (prefilledKey && key && key !== prefilledKey && !keyOverwriteConfirmed) {
        keyOverwriteConfirmed = true;   // arm: this same WAKE press now goes through; a second press confirms
        msg.textContent = 'this replaces the key already stored on this station. press WAKE again to confirm — or restore the old key to keep it.';
        return false;
      }
      // Only (re)store when a key was actually typed — desktop keeps the existing keychain key on blank.
      // setKey is async in desktop (writes the keychain + pushes it to the sidecar); await so the run has it.
      if (key) await (Harness.validateAndSetKey ? Harness.validateAndSetKey(key, pickedProvider) : Harness.setKey(key, pickedProvider));
      Harness.setModel(model); Harness.setProv(pickedProvider);
    }

    // V3 LAW — THE WIRE IS PROVEN AT THE DOOR (Andrew, 2026-07-19): the awakening AUTHORS this agent's whole
    // future from live-model beats, and the full onboarding is MANDATORY — so no wake proceeds on an unproven
    // wire. One real round-trip to the chosen provider+model, RIGHT NOW — not "configured", not "signed in":
    // ANSWERED. A dead wire keeps the Commander at the console with the honest reason; there is no world where
    // the ceremony silently degrades because the model never actually spoke.
    wakeBtnBusy(true);
    msg.textContent = 'testing the wire — one real call to ' + model + '…';
    const wire = await preflightWire();
    if (!wire.ok) {
      wakeBtnBusy(false);
      msg.className = 'msg bad';
      // a BILLING refusal is not a model failure: managed admission refused the run before any model was
      // reached. Name the real cause and the real fix; "your model didn't answer" sends people model-hopping.
      if (/managed credit|Managed credits/i.test(wire.why)) {
        msg.textContent = /Out of managed credit/i.test(wire.why)
          ? 'your StarNet account has no credits — waking your agent uses credits right away. Press ＄ ADD CREDITS above, then WAKE again.'
          : 'StarNet couldn’t read your credit balance right now — try WAKE again in a moment, or use your own provider key.';
        refreshStarnetGenesisStatus();
        return false;
      }
      msg.textContent = 'your model didn’t answer — ' + wire.why + '. fix it here, then WAKE again; the awakening won’t start on a dead wire.';
      return false;
    }
    msg.textContent = '';

    wakeBtnBusy(true);   // COMMIT POINT: past every validation gate — show WAKING… and hold the latch through enterGame
    if (resumingSaved) { const s = resumingSaved; resumingSaved = null; s.agent.model = model; resumeInto(s); return true; }

    // LOCK DOWN before the NEW hero or any of its local stores are committed. A failed durable revoke rejects,
    // leaves the prior station intact, and keeps its confirmed grant visible instead of commissioning a fresh
    // Commander who silently inherited cabinet:write. Saved-station resume returns above and keeps its grants.
    if (typeof PermissionsStore !== 'undefined') await PermissionsStore.reset();
    const newCommanderEpoch = Date.now();
    if (typeof JourneyStore !== 'undefined' && JourneyStore.reset) {
      const journeyResetResult = await JourneyStore.reset(newCommanderEpoch);
      if (!journeyResetResult || !journeyResetResult.ok) {
        wakeBtnBusy(false);
        msg.className = 'msg bad';
        msg.textContent = 'the prior Commander journey could not be cleared safely. retry WAKE before commissioning this agent.';
        return false;
      }
    }

    // the FIRST agent is always the station's OVERSEER — the orchestrating lead the Commander commissions before
    // any specialist. Its voice is the archetype + fine-tune dials + free-text note; its APPROVAL mode (ask vs
    // full access) drives the real consent broker, while the mission/context/orders are authored in the awakening.
    agent = { id: 'agent', name, role: 'orchestrator', color: pickedColor, skin: pickedSkin || DATA.DEFAULT_SKIN, model,
              provider: (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter',   // #4: stamp the chosen provider+effort onto the hero so a later agent-switch can restore them
              reasoningEffort: (typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort() : 'medium',
              personaId: pickedPersona, voiceTraits: Object.assign({}, pickedTraits), customVoice: pickedCustomVoice.trim(),
              approvalMode: (pickedApproval === 'full' ? 'full' : 'ask'), executionProfile: (pickedApproval === 'full' ? 'this-computer' : 'trusted-project'), purpose: null, onboarded: false, createdAt: newCommanderEpoch };   // legacy approval choice seeds an honest host profile; the two axes are independently changeable in the dossier
    agentDocs(agent);                              // seed identity.md (overseer-aware) / purpose.md / operating-manual.md
    registerHero(agent);   // found the multi-agent registry with the hero BEFORE composing — rosterClause reads the registry, and a same-session re-wake must not see the prior crew
    agent.systemPrompt = composeSystemPrompt(agent);
    Harness.resetTotals();
    Workstreams.reset();   // a fresh General stream for the new agent
    if (typeof PitchStore !== 'undefined') PitchStore.reset();   // a brand-new hero re-earns its First Pitch (own key)
    if (typeof SuggestStore !== 'undefined') SuggestStore.reset();   // …and a fresh ongoing-suggestion cadence
    if (typeof SeedStore !== 'undefined') SeedStore.reset();   // …and a fresh seed-offer budget
    if (typeof LaunchMemory !== 'undefined') LaunchMemory.reset();   // …and no inherited last-used recipe inputs (own key)
    if (typeof CuriosityStore !== 'undefined') CuriosityStore.reset();   // …no inherited waved-off dimensions (own key)
    if (typeof RecQualityStore !== 'undefined') RecQualityStore.reset();   // …and no inherited recommendation-quality history (own key)
    if (typeof StudyStore !== 'undefined') StudyStore.reset();   // …and a fresh STUDY state — a new Commander never inherits the prior hero's studyDeclined denylist / ignore tallies / rating streaks (own key)
    if (typeof ThreadStore !== 'undefined') ThreadStore.reset();   // …and a fresh THREAD turn-in gate — a new Commander never inherits the prior hero's resolved/ignored mined ideas (the ledger itself is server-side, station-wide)
    if (typeof QuestStateStore !== 'undefined') QuestStateStore.reset();   // …and a fresh quest memory — a new Commander never inherits dismissed/completed quest history (own key)
    if (typeof QuestLedgerStore !== 'undefined') QuestLedgerStore.reset();  // …and a clean ledger cache — the sidecar ledger is station-wide, but the session cache/notify set starts empty
    if (typeof QuestRefreshStore !== 'undefined') QuestRefreshStore.reset();  // …and a clean refresh-status cache — the engine state is station-wide/server-side, but the session cache starts empty
    if (typeof StationQuestStore !== 'undefined') StationQuestStore.reset();   // …and no inherited station-gap fix-it quests — a new Commander never sees the prior hero's capdenied backlog / dismissals (own key)
    if (typeof WorkQuestStore !== 'undefined') WorkQuestStore.reset();   // …and no inherited accepted-build work quests — a new Commander never inherits the prior hero's in-flight builds (own key)
    if (typeof GoalStore !== 'undefined') GoalStore.reset();   // …and a fresh goal tree — a new Commander never inherits the prior hero's goals/milestones/progress (own key)
    if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.reset) UnderstandingStore.reset();   // …and no inherited rating corroboration — a new Commander never inherits the prior hero's 👍/👎 confidence signal (own key)
    if (typeof MaintQuestStore !== 'undefined') MaintQuestStore.reset();   // …and no inherited maintenance quests — a new Commander never sees the prior hero's slag/jam backlog (own key)
    if (typeof MintStore !== 'undefined') MintStore.reset();   // …no inherited recurring-task shapes — these feed the seed shelf, so a leak would offer a prior Commander's chores (own key)
    if (typeof AutonomyStore !== 'undefined') AutonomyStore.reset();   // …and a fresh autonomy posture (safe floor) — a new Commander is never handed the previous one's free-range grant (own key)
    if (typeof AutoJobStore !== 'undefined') AutoJobStore.reset();   // …and re-arm the one-time standing-jobs proposal (own key; server-side routines are separate)
    if (typeof AutopilotStore !== 'undefined') AutopilotStore.reset();   // …and a fresh idle autopilot (no inherited idle/armed state — its decision is re-earned by the new Commander's posture + dossier)
    if (typeof ReturnStore !== 'undefined') ReturnStore.reset();   // …and no inherited return-ritual trail — a fresh Commander gets no prior hero's pending OUTBOX crates or attendance stamp (own key)
    if (typeof NightDraftNudge !== 'undefined') NightDraftNudge.reset();   // …and no inherited night-shift seen-stamp / spent nudge — a fresh Commander re-earns the unseen-drafts nudge (own key)
    if (typeof WorkshopStore !== 'undefined') WorkshopStore.reset();   // W3: no inherited "later" list or seen-ledger for a fresh Commander (own key)
    if (typeof PrideStore !== 'undefined') PrideStore.reset();   // …and a brand-new station record — a fresh Commander founds their OWN colony, inheriting no prior hero's lifetime tasks/deliverables/routines/founding-date (own key)
    if (typeof SeedReuseStore !== 'undefined') SeedReuseStore.reset();   // …and no inherited seed-usage tally — a fresh Commander's living-tools shelf starts empty; the 5×/week callout is re-earned (own key)
    if (typeof ConfBeats !== 'undefined') ConfBeats.reset();   // …and both confidence narrative moments re-arm — a fresh hero's meter starts over, so its calibration/TRUSTED beats must be re-earned, never inherited (own key)
    if (typeof BottleStore !== 'undefined') BottleStore.reset();   // …and R5's per-run bottle-decision denylist clears — a fresh hero re-earns every "bottle it?" offer (own key)
    if (typeof ResummonStore !== 'undefined') ResummonStore.reset();   // …and P3.1's per-run re-summon-decision denylist clears — a fresh hero re-earns every "run it again?" offer (own key)
    if (typeof TrustStore !== 'undefined') TrustStore.reset();   // GROWTH Tier 3: …and a fresh EARNED-AUTONOMY track record — a new Commander never inherits the prior hero's earned rungs / declined-offer state / streak (own key); the earned dial rung must be re-earned from scratch
    if (typeof Harness !== 'undefined' && Harness.memoryReset) Harness.memoryReset(agent.id);   // …and wipe SERVER-SIDE memory (notebook/declined/todo) so no prior Commander's kept or rejected beliefs bleed into the fresh hero
    pendingStationDoc = null;   // a brand-new station (one shabby starter room) for a new agent
    pendingStationStats = null; // fresh growth meters — XpStore.init seeds them on enterGame
    pendingGrowthSyncAt = 0;
    pendingRatingSyncAt = 0;
    enterGame({ awaitingPurpose: true, wake: true });   // the Orchestrator authors its mission in the awakening (no pre-spec)
    persist();   // so a refresh mid-onboarding resumes to the purpose step
    return true;
  }

  /* ---------- resume ---------- */
  function resumeInto(saved) {
    agent = saved.agent;
    if (!(Number(agent.createdAt) > 0)) agent.createdAt = Math.max(1, Number(saved.updatedAt) || Date.now());
    if (!agent.role) agent.role = 'orchestrator';  // older hero saves predate the role field — the first agent is the lead
    agentDocs(agent);                              // seed config docs for older saves that predate them
    stripLegacyVoiceBlock(agent);                  // one-time: drop the old awakening's inline VOICE & MANNER so it doesn't double up with the archetype layer
    stripLegacySoloClause(agent);                  // one-time: swap the frozen "right now its only agent" identity block for the timeless clause (crew truth now rides rosterClause)
    agent.systemPrompt = composeSystemPrompt(agent);
    registerHero(agent);                           // found the registry with the hero…
    rehydrateRoster(saved.agents);                 // …then restore any summoned crew (older saves: no-op)
    recomposeOrchestrators();                      // …and only NOW does the hero's YOUR CREW clause see them (composing above sees an empty registry)
    if (saved.prov && Harness.setProv) Harness.setProv(saved.prov);   // keep the provider with the agent (codex vs openrouter)
    if (saved.reasoningEffort && Harness.setReasoningEffort) Harness.setReasoningEffort(saved.reasoningEffort);
    if (!agent.provider && saved.prov) agent.provider = saved.prov;   // #4: older hero saves stored provider only at the top level — stamp it onto the hero object so focusAgent restores it
    if (!agent.reasoningEffort && saved.reasoningEffort) agent.reasoningEffort = saved.reasoningEffort;
    Harness.setModel(agent.model || Harness.getModel());
    Harness.setTotals(saved.usage || { tokens: 0, cost: 0, calls: 0 });
    Workstreams.init({ workstreams: saved.workstreams, activeId: saved.activeId, generalId: saved.generalId, sessionUndo: saved.sessionUndo, deletedIds: saved.deletedIds });
    pendingStationDoc = saved.station || null;   // restore the built station (if any)
    pendingStationStats = saved.stationStats || null;   // restore the station-growth rollup (XP/level/confidence)
    pendingGrowthSyncAt = Math.max(0, Number((saved.stationStats && saved.stationStats.runSyncAt) || saved.updatedAt || 0));
    // A legacy/stale projection with no dedicated rating watermark must replay this station generation from
    // its beginning. Using save.updatedAt here can skip a rating that the server accepted before that stale
    // local document was written (the exact multi-tab clobber this ledger exists to repair).
    pendingRatingSyncAt = Math.max(1, Number(saved.stationStats && saved.stationStats.ratingSyncAt) || 1);
    pendingProfile = saved.profile || null;   // restore the learned user-affinity profile
    pendingWorkSignal = saved.worksignal || null;   // restore the capability-usage histogram (adaptive recruitment)
    pendingDossier = saved.dossier || null;   // restore the station-wide Commander dossier
    // gate the awakening on the explicit onboarded flag (new saves), falling back to the old !purpose heuristic
    // for pre-flag saves. This fixes the strand where a refresh AFTER the first (purpose) answer — which persists
    // agent.purpose immediately — used to skip the rest of the awakening (context/manual/dawn/tutorial never ran).
    const needsAwakening = (agent.onboarded === undefined) ? !agent.purpose : !agent.onboarded;
    enterGame({ awaitingPurpose: needsAwakening, wake: false });
    persist();   // lock any v1->v2 migration to disk now (don't re-migrate every load)
  }

  function enterGame(opts) {
    registerAgent(agent.id, agent.color);
    el('gt-agent').textContent = agent.name;
    el('gt-model').textContent = agent.model;
    refreshUsage();
    show('screen-game');
    SPRITES.init();
    World.init(el('stage'));
    World.spawn(agent);
    World.setOnClick(openWorldAgent);
    World.setOnArcade(() => { if (typeof StationUI !== 'undefined' && StationUI.openArcade) StationUI.openArcade(); });   // click a cabinet → BREACH PROTOCOL
    // 2026-07-16 UX fix: the OUTBOX click opens the OUTBOX window — one clean list of ALL uncollected
    // finished work, readable + rateable in place (the old path fired a one-crate chat beat, which read
    // as a context-free popup). The window's footer links to the LOGBOOK for the full run history.
    if (World.setOnOutbox) World.setOnOutbox(() => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('outbox'); });
    if (World.setOnMissionBoard) World.setOnMissionBoard(() => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('quests'); });   // G1b: click the MISSION BOARD → the QUEST LOG (the board is a projection, never a gate)
    if (World.setOnTrophyCase) World.setOnTrophyCase(() => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('trophies'); });   // G3b: click the TROPHY CASE → the TROPHY surface (a projection of real completions, never a gate)
    if (World.setOnBayAssign) World.setOnBayAssign(pid => { if (typeof Build !== 'undefined' && Build.openAssign) Build.openAssign(pid); });   // belt legibility: click an unbound BAY's "NO AGENT" nag → REFIT opens straight into its agent picker
    if (World.setOnIntakeFeed) World.setOnIntakeFeed(() => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('messaging'); });   // belt legibility: click a starved INTAKE's "NO FEED" nag → the CHANNELS panel (wire a real feed)
    if (World.setOnIntakeSample) World.setOnIntakeSample(o => { if (typeof Chat !== 'undefined' && Chat.sampleCard) Chat.sampleCard(o); });   // guided workflow Phase 4: click the INBOX on a COMPLETE line → the RUN-A-SAMPLE-JOB card (POST /api/routing/sample)
    if (opts.awaitingPurpose) World.beginAwakening();        // wake in darkness — the awakening lifts the room to first light (set BEFORE start so there's no flash of the lit room)
    else if (opts.wake) { World.wakeIn(); SFX.level(); }
    // the canonical station the builder edits — restored from the save, or a fresh starter room. LOAD it
    // BEFORE World.start() so the first painted frame renders THIS agent's floor — a NEW AGENT must never
    // flash the previous agent's built station (start() paints synchronously off the live geo/cache).
    // MOUNT RULES: teach the station model which prop types hang on a wall / stand on a table, and which
    // types ARE tables. The model deliberately never imports the catalog, so this injection is the single
    // seam between the two — installed before the station exists so the very first placement is validated.
    if (typeof PropSprites !== 'undefined' && WorldModel.setPropRules) {
      WorldModel.setPropRules((t) => {
        const s = PropSprites.spec(t);
        return s ? { mount: s.mount || null, stack: !!s.stack, surface: !!s.surface, flat: !!s.flat } : null;
      });
    }
    // STATION IDENTITY: did the save we are loading already carry one? (worldmodel stamps meta.createdAt
    // at create AND backfills it on migrate — a stamp that is never SAVED would re-roll on every reload,
    // and every per-station REFIT latch keyed on it would be lost. Read before deserialize mutates it.)
    const hadStationId = !!(pendingStationDoc && pendingStationDoc.meta && pendingStationDoc.meta.createdAt);
    station = (pendingStationDoc && pendingStationDoc.rooms) ? WorldModel.deserialize(pendingStationDoc) : WorldModel.create();
    pendingStationDoc = null;
    // THE OVERSEER'S DESK IS A REAL PROP: materialize the starter workstation the world used to merely
    // DRAW (synthetic auto-desk) as a real hero-assigned desk in the doc, BEFORE the world derives its
    // floor — so bayObjects/REFIT/dossier see the same PC the player sees (kills the fresh-install
    // "NO COMPUTE beside the visible PC" lie). Idempotent per load; world keeps its synthetic fallback
    // only for the pathological no-space floor.
    if (agent && agent.id && typeof station.ensureWorkstation === 'function') {
      const seeded = station.ensureWorkstation(agent.id);
      // a real floor change, OR a save that just received its station id — either way the doc on disk is
      // now behind the doc in memory, and the id in particular MUST be durable (see hadStationId above).
      if (!hadStationId || (seeded && seeded.ok && !seeded.existing)) persist();
    }
    if (typeof World.loadStation === 'function') World.loadStation(station);   // the live world IS the built station
    // give resumed summoned crew their real floor bodies now that the station/geo is loaded (no-op for a
    // single-agent save; summon-during-game spawns its own body directly).
    for (const a of liveAgents()) if (a.id !== agent.id && typeof World.spawnAgent === 'function') World.spawnAgent(a);
    World.start();   // first frame now paints the fresh floor + crew, never a stale frame of the prior world
    if (World.resumeBridge) World.resumeBridge();   // re-arm the channel SSE + connector poll if a prior disconnect released them (no-op on first entry)
    if (typeof Build !== 'undefined') {
      // agents: the live multi-agent roster the BAY agent-picker / builder offer. The bay->agent binding
      // persists via station.serialize (prop.agentId round-trips), so the routing floor is saved per agent.
      Build.init({ getStation: () => station, persist: persist, world: World,
        agents: () => liveAgents().map(a => ({ id: a.id, name: a.name, color: a.color, model: a.model })),
        // A workstation can be placed while its owning COMMS stream stays open. Reconcile the derived
        // "nowhere to sit" row after REFIT commits so the transcript cannot outlive the floor truth.
        onClose: () => { if (typeof Chat !== 'undefined' && Chat.retireDeskPrompt) Chat.retireDeskPrompt(); } });
      const bbBuild = el('bb-build');
      if (bbBuild) {
        let seenBuild = false; try { seenBuild = !!localStorage.getItem('starnet.refit.seen'); } catch (e) {}
        if (!seenBuild) bbBuild.classList.add('refit-nudge');   // pulse the dock button until first opened
        bbBuild.onclick = () => { SFX.click(); bbBuild.classList.remove('refit-nudge'); Build.toggle(); if (typeof Tutorial !== 'undefined' && Tutorial.onBuildOpen && Build.isOpen && Build.isOpen()) Tutorial.onBuildOpen(); };
      }
    }
    const bbRecruit = el('bb-recruit');
    if (bbRecruit) bbRecruit.onclick = openSummonBay;   // the ONE recruit door — bay carries both verbs (summon new / deploy to current)

    const bbMissions = el('bb-missions');
    if (bbMissions) bbMissions.onclick = () => openDeployBay('recipes');   // straight to the RECIPES (mission) library tab
    if (typeof StationUI !== 'undefined') {
      StationUI.enter(liveAgents(), {
        totals: () => Harness.totals(),
        // CONTEXT is a property of the conversation ON SCREEN, not of the primary agent: ask Chat which
        // workstream is open and hand the gauge that stream's own agent + message array. Binding this to
        // `agent.id` alone is what made a fresh session inherit the previous chat's fill, and made a crew
        // member's chat report the overseer's occupancy. Falls back to the old shape if Chat isn't up yet.
        context: () => {
          const ref = (typeof Chat !== 'undefined' && Chat.contextRef) ? Chat.contextRef() : null;
          return ref ? Harness.contextState(ref.agentId, ref.streamId, ref.messages)
            : Harness.contextState(agent ? agent.id : 'agent');
        },
        activity: () => (World.getActivity ? World.getActivity() : 'idle'),
        config: { apply: applyAgentConfig, setModel: setAgentModelPin, setPersona: setAgentPersona, setName: setAgentName, setWorkshop: setAgentWorkshop, setApproval: setAgentApproval, setExecutionProfile: setAgentExecutionProfile, setSkin: setAgentSkin, deleteAgent: deleteAgent, crewCount: () => agents.size },   // approval posture and execution profile are independent controls; both persist through the roster
        comms: { openWorkstream: openWorkstream }   // the while-you're-away card's "review" jumps straight to a deliverable's session (2026-07-15)
      });
      // Presence is already proven by the live roster, link indicator, and COMMS state. Do not
      // create a fresh persistent notification every time an existing station is reloaded.
    }
    // AGENT GROWTH: subscribe XP/Level/Confidence to the real run-outcome bus. Seeds agent.stats +
    // the station rollup, pushes the live numbers to the world HUD, and fires level-up celebrations.
    // S3: onCredential fires only on a coarse track-record change (tier crossing / band flip), and re-pushes
    // the roster so the lead's next dispatch briefing describes its crew truthfully. Rare by construction.
    // S4: `agents` lets the boot-time trophy reconcile reach every specialist's case, not just the hero's.
    if (typeof XpStore !== 'undefined') { XpStore.init({ getAgent: (id) => agents.get(id || 'agent') || null, agents: () => Array.from(agents.values()), station: pendingStationStats, syncSince: pendingGrowthSyncAt, syncRatingsSince: pendingRatingSyncAt, persist: persist, onCredential: () => pushRoster() }); pendingStationStats = null; pendingGrowthSyncAt = 0; pendingRatingSyncAt = 0; }
    // PERSONALIZATION: the local user-affinity profile — folds the interest tag of each task + shipped work
    // into a tiny histogram (profile.js engine). Resume the saved slice, else start fresh + seed cold-start
    // from the agent's deployed specialty domain so day-one suggestions aren't blank.
    if (typeof ProfileStore !== 'undefined') {
      ProfileStore.init({ profile: pendingProfile, persist: persist }); pendingProfile = null;
      if (agent.specialtyId && typeof Specialties !== 'undefined' && typeof Classify !== 'undefined') {
        const sp = Specialties.get(agent.specialtyId);
        if (sp) ProfileStore.seed(Classify.getTag((sp.purpose || '') + ' ' + (sp.tagline || '')));
      }
    }
    // ADAPTIVE RECRUITMENT: the capability-usage histogram — folds the LANE (dish/cabinet/workbench/…) of each
    // real hero tool fire, plus the run's interest tag, into a decayed per-lane read (worksignal.js engine). Shares
    // the profile's learning-enabled flag (one glass-box switch governs both) so PAUSE stops all local learning at
    // once. getRunTag resolves the run's interest tag from RUN_META (else the active workstream title).
    if (typeof WorkSignalStore !== 'undefined') {
      WorkSignalStore.init({
        signal: pendingWorkSignal, persist: persist,
        learningOn: () => (typeof ProfileStore !== 'undefined' && ProfileStore.enabled) ? ProfileStore.enabled() : true,
        getRunTag: (runId) => {
          if (typeof Classify === 'undefined' || !Classify.getTag) return null;
          let title = '';
          try { const m = (runId && typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null; if (m && m.title) title = m.title; } catch (_) {}
          if (!title) { try { const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null; title = ws ? (ws.title || '') : ''; } catch (_) {} }
          return title ? Classify.getTag(title) : null;
        }
      });
      pendingWorkSignal = null;
    }
    // AUTO-MINT: watch for recurring task shapes so the bay can propose saving them as one-tap missions. Self-
    // persists to its own localStorage key (rides the backup prefix), so init just hydrates from there. One learning
    // switch: reconcile mint to the PROFILE's enabled flag (the source of truth) so a partial restore can't leave the
    // glass-box PAUSE and the SUGGESTED shelf disagreeing.
    if (typeof MintStore !== 'undefined') {
      MintStore.init();
      if (typeof ProfileStore !== 'undefined' && ProfileStore.enabled && MintStore.setEnabled) MintStore.setEnabled(ProfileStore.enabled());
    }
    // COMMANDER DOSSIER: the one station-wide model of the user (dossier.js engine). Resume the saved slice,
    // seed it once from the onboarding docs the Commander authored, and fold it into EVERY agent's system
    // prompt so a freshly-deployed agent already knows the Commander. A panel edit recomposes the live prompt.
    if (typeof DossierStore !== 'undefined') {
      DossierStore.init({
        dossier: pendingDossier, docs: agentDocs(agent), persist: persist,
        onMutate: () => { if (!agent) return; agent.systemPrompt = composeSystemPrompt(agent); if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(agent.systemPrompt); persist(); }
      });
      pendingDossier = null;
      agent.systemPrompt = composeSystemPrompt(agent);   // include the dossier block before Chat.init reads it below
    }
    // GROWTH Tier 1 — STUDY (dossier Phase B): after a salient run, the station proposes DOSSIER belief updates
    // (goals/pain/style/… ADD or RETIRE), consented at the turn-in beat. Self-persists its own key (declined
    // denylist + per-belief ignore tallies + per-archetype rating streaks). Init AFTER DossierStore (its accept()
    // folds into it); the per-session shown-cap resets here.
    if (typeof StudyStore !== 'undefined') StudyStore.init({ now: () => Date.now() });
    // NS-6 — THREAD turn-in: after a mined task run, the station offers ideas the Commander floated but never
    // acted on for Keep/Edit/Discard at the turn-in beat (chat.js). Self-persists its own key (resolved
    // fingerprints + per-idea ignore tallies); the per-session shown-cap resets here.
    if (typeof ThreadStore !== 'undefined') ThreadStore.init({ now: () => Date.now() });
    // CURIOSITY: the gentle one-per-session "tell me about X" nudge (curiosity.js). Self-persists its
    // dismissals to its own key (rides the backup prefix); init just hydrates + resets the session budget.
    if (typeof CuriosityStore !== 'undefined') CuriosityStore.init();
    // THE RECOMMENDATION QUALITY LOOP (outcome attribution): per-channel EWMA weights over what the station's
    // accepted offers actually PRODUCED — read by the spine's scorer, moved only by real attributed outcomes
    // (a clean run, the Commander's 👍/👌/👎, an explicit decline). Self-persists its own key; read-only bus
    // citizen. Init here, alongside the other proactive-channel stores, so the first pass already sees it.
    if (typeof RecQualityStore !== 'undefined') RecQualityStore.init({ now: () => Date.now() });
    // ONE RECOMMENDATION MEMORY: the spine's wire into the durable cross-surface ledger every other recommendation
    // surface already writes and reads. Its init fires the one read (declined titles + the learned preference
    // model) the ranking consults; every step of it fails open, so a cold or unreachable ledger simply leaves the
    // spine ranking exactly as it did before this existed.
    if (typeof RecLedger !== 'undefined') RecLedger.init({ now: () => Date.now() });
    // QUEST MEMORY (G1a): durable quest state — firstSeenAt/completedAt per quest + dismissed-forever — and
    // the open→done completion celebration (quest sting + gold toast + row flourish; NEVER XP). Self-persists
    // to its own key. Init AFTER XpStore/DossierStore so its first fold sees the real projection as a quiet
    // baseline (a resumed save backfills already-done quests without a celebration storm).
    if (typeof QuestStateStore !== 'undefined') QuestStateStore.init();
    // QUEST V2 §C — the harness-owned quest LEDGER's frontend citizen: polls /api/quests (throttled on the 1s
    // tick), merges the sidecar ledger into the QUEST LOG projection, and owns the attest confirm/dismiss writes.
    // Init AFTER QuestStateStore so the ledger's already-done quests fold in as a quiet baseline on a resume.
    if (typeof QuestLedgerStore !== 'undefined') QuestLedgerStore.init();
    // QUEST V3 — the standing quest-REFRESH engine's frontend citizen: polls /api/quests/refresh (throttled on
    // the tick) for the north star + attempt ledger + due state, and owns the manual REFRESH QUESTS write.
    if (typeof QuestRefreshStore !== 'undefined') QuestRefreshStore.init();
    // COMMANDER JOURNEY: the durable sidecar-owned loop connecting goal metrics + verified outcomes to
    // agent-domain mastery, visible adaptation receipts, and expressive station evolution. Separate from XP;
    // never grants capabilities. Init before GoalStore so a just-folded milestone can post immediately.
    if (typeof JourneyStore !== 'undefined') JourneyStore.init({ epoch: () => agent && agent.createdAt });
    // G1b STATION-QUEST GENERATOR: subscribe to agent.tool_call and mint a fix-it quest when an agent reaches
    // for a tool its room can't grant (capdenied → playable direction). Init AFTER World.loadStation (its gap
    // check + resolution read World.heroCaps / the live floor) and after QuestStateStore so a resumed save's
    // already-closed gaps are a quiet baseline. Self-persists to its own key; never emits on U.bus.
    if (typeof StationQuestStore !== 'undefined') StationQuestStore.init();
    // G1c WORK-QUEST GENERATOR: an accepted pitch/idea ("build it") becomes a trackable multi-step build,
    // completing on the launched run finishing (rides QuestState's celebration). Subscribes to run.start/end;
    // self-persists (own key); never emits. Init AFTER QuestStateStore so its completion folds cleanly.
    if (typeof WorkQuestStore !== 'undefined') WorkQuestStore.init();
    // GROWTH Tier 2 — GOAL MODEL + QUEST ARCS: a goals-dim belief decomposes into a confirmed, persisted milestone
    // tree; the next open milestone surfaces as an actionable quest that routes through the work-quest path, so
    // completing the REAL work advances an honest progress meter and chains the next step. Self-persists (own key)
    // + mirrors the active goal to the sidecar for cron. Init AFTER DossierStore (reads goals beliefs) + StudyStore
    // (drift) + WorkQuestStore (binds/reconciles milestone builds) + QuestStateStore (its arc-step completion folds
    // through QuestState's celebration). getSystem/launchDirective reuse the advice plumbing composed just below.
    if (typeof GoalStore !== 'undefined') GoalStore.init({
      now: () => Date.now(),
      getSystem: () => agent ? agent.systemPrompt : '',
      // UNION of two same-day fixes: title = deriveTitle(directive) (every milestone card used to read the
      // literal 'Goal milestone', so three goals were three identical cards; the derived placeholder rides the
      // normal model-title upgrade ladder) — AND returns TRUE only when a run really kicked off, because a
      // mid-run send silently no-ops and callers that record a launch (the outcome loop's attribution stamp)
      // must never count one that never happened.
      launchDirective: (text) => { const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create((Workstreams.deriveTitle && Workstreams.deriveTitle(text)) || 'Goal milestone', { kind: 'task' }) : null; if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws); let sent = false; if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) { Chat.send(text); sent = true; } persist(); return sent; },
      getRunSummary: (runId) => { const m = (runId && typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null; return (m && m.title) ? m.title : ''; }
    });
    // UNDERSTANDING: the one honest, adaptive "how well the station understands the Commander" read
    // (understanding.js engine) composed from the live dossier beliefs + work-observation count + active goal.
    // No surface of its own — it AIMS the earned curiosity question at the weakest dimension and upgrades the
    // COMMANDER panel's familiarity meter. Init AFTER DossierStore/ProfileStore/GoalStore (it reads all three).
    if (typeof UnderstandingStore !== 'undefined') UnderstandingStore.init({ now: () => Date.now() });
    // R1: the fork directive is BAKED into the cached agent.systemPrompt, so a gate flip (style confidence
    // crossing the floor — e.g. the first banked fork answer grounds the style model) must recompose the
    // prompt or the directive would never retire. Flips are rare, so the prefix stays cache-warm between.
    if (typeof UnderstandingStore !== 'undefined' && typeof Fork !== 'undefined' && UnderstandingStore.subscribe) {
      let forkGate = null;
      UnderstandingStore.subscribe(u => {
        const g = Fork.shouldOffer(u);
        if (forkGate === g) return;
        const first = forkGate === null;
        forkGate = g;
        if (first || !agent) return;   // the initial read only sets the baseline (the boot compose already used it)
        agent.systemPrompt = composeSystemPrompt(agent);
        if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(agent.systemPrompt);
        persist();   // mirror applyAgentConfig: the recomposed prompt is part of the agent's persisted truth
      });
    }
    // G1c MAINTENANCE-QUEST GENERATOR: recurring slag causes (World.slagPostmortems ring) + a jammed routine
    // (cron.skipped streak) become fix-it quests, clearing when the signal clears. Init AFTER World.loadStation
    // (it reads the live SlagLog ring) and after QuestStateStore. Self-persists (own key); never emits.
    if (typeof MaintQuestStore !== 'undefined') MaintQuestStore.init();
    if (typeof SeedStore !== 'undefined') SeedStore.init();   // SELF-GROWING SEED: reset the one-offer-per-session budget
    if (typeof AutonomyStore !== 'undefined') AutonomyStore.init();   // AUTONOMY POSTURE: hydrate the "alive between sessions" dial (own key; the awakening cadence beat + the station dial are its writers)
    // FIRST PITCH: once the agent has done one real task and knows enough about the Commander, it proactively
    // proposes ONE buildable thing to make next (pitch.js engine). Read-only bus citizen; self-persists its own
    // fire-once flag (no save.js change). It reasons the pitch from the LIVE system prompt (which already carries
    // the COMMANDER dossier block), so the suggestion is personalized with no context re-injection.
    // shared accessors/actions for the proactive-advice stores (First Pitch + ongoing suggestions): both reason
    // from the LIVE system prompt (it carries the dossier block) + the real recipe/capability envelope, and route
    // a "build it" into a real run. SuggestStore is the recurring counterpart that fires as the dossier grows.
    const adviceDeps = {
      getSystem: () => agent ? agent.systemPrompt : '',
      getName: () => agent ? agent.name : 'AGENT',
      getCaps: () => ((typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps('agent') : []).map(c => (typeof c === 'string' ? { id: c, label: c } : c)),
      // was the run that just ended a REAL task (tools available), not casual chat? Chat's run-meta ledger records
      // this at run start (the bus run.end payload doesn't carry it). Gates the First Pitch on earned work.
      wasTaskRun: (runId) => { const m = (typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null; return !!(m && m.isTask); },
      // the title of the run that just finished — prefer the ENDED run's recorded title (so a mid-run stream switch
      // can't mislabel it), falling back to the active workstream when the runId is unknown (e.g. a direct call).
      getRecentTask: (runId) => { const m = (runId && typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null; if (m && m.title) return m.title; const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null; return ws ? (ws.title || '') : ''; },
      launchRecipe: launchRecipe,
      /* THE EVIDENCE POOL the suggestion's quote is vetoed against (rec perfection W2). The SAME shape and the
         same dimensions AutoJobStore reads for its own grounding veto — one accessor idiom, so the two channels
         can never disagree about what the station "knows". A cold dossier returns {}, which grounds nothing:
         fail-closed is the point (the failure it replaces was quoting the Commander words they never said). */
      getBeliefs: () => {
        const out = {};
        if (typeof DossierStore === 'undefined' || !DossierStore.beliefs) return out;
        for (const k of ['goals', 'pain', 'ambition', 'stack', 'standing_orders']) {
          const arr = (DossierStore.beliefs(k) || []).map(b => b && b.text).filter(Boolean);
          if (arr.length) out[k] = arr;
        }
        return out;
      },
      // UNION (see the goal-milestone twin above): derived title from the directive + returns TRUE only when a
      // run really kicked off — the suggestion's attribution stamp is armed off this answer, so a busy stream
      // must report the no-op honestly.
      launchDirective: (text) => { const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create((Workstreams.deriveTitle && Workstreams.deriveTitle(text)) || 'First build', { kind: 'task' }) : null; if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws); let sent = false; if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) { Chat.send(text); sent = true; } persist(); return sent; }
    };
    if (typeof PitchStore !== 'undefined') PitchStore.init(adviceDeps);
    if (typeof SuggestStore !== 'undefined') SuggestStore.init(adviceDeps);
    // ADAPTIVE RECRUITMENT — the SCOUT CLIENT: the prospect/recipe drafting moved SERVER-SIDE (sidecar scout —
    // persisted across sessions, real cadence, visible attempt ledger). This init wires the token fetch plus the
    // browser-only dedup context the server can't see (custom classes/recipes, the worksignal read, the
    // recruiter's top pick). The bay's shelves read the store's cached server truth.
    if (typeof ProspectStore !== 'undefined') {
      const worksignalSummaryText = () => {
        try {
          const s = (typeof WorkSignalStore !== 'undefined' && WorkSignalStore.summary) ? WorkSignalStore.summary() : null;
          if (!s || !s.dominant) return '';
          const lanes = Object.keys(s.laneTags || {}).map(l => l + ' (' + s.laneTags[l] + ')').join(', ');
          return 'dominant lane: ' + s.dominant + '; ' + s.samples + ' completed task-runs; lanes worked: ' + (lanes || s.dominant);
        } catch (_) { return ''; }
      };
      ProspectStore.init({
        fetch: (u, o) => (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(u, o) : fetch(u, o),
        setLearningEnabled: (on) => { if (typeof ProfileStore !== 'undefined' && ProfileStore.setEnabled) ProfileStore.setEnabled(on); if (typeof MintStore !== 'undefined' && MintStore.setEnabled) MintStore.setEnabled(on); },
        getWorksignalSummary: worksignalSummaryText,
        getCustomClasses: () => { try { return (typeof Specialties !== 'undefined' && Specialties.customs) ? (Specialties.customs() || []).map(s => ({ name: s.name, tagline: s.tagline })) : []; } catch (_) { return []; } },
        getCustomRecipes: () => { try { return (typeof Recipes !== 'undefined' && Recipes.customs) ? (Recipes.customs() || []).map(r => ({ name: r.name, tagline: r.tagline })) : []; } catch (_) { return []; } },
        getTopRecommendation: () => { try { const t = (typeof RecruiterStore !== 'undefined' && RecruiterStore.topPick) ? RecruiterStore.topPick() : null; return t ? t.classId : ''; } catch (_) { return ''; } }
      });
    }
    // lane D ROUTINE NUDGE: "you keep launching this recipe — schedule it?" — reads the scout launch counters +
    // the cron jobs list (read-only), shares the one post-run beat slot in chat.js, deep-links into the SCHEDULE IT
    // form on accept (openRecipeLaunch below). init warms its cron cache; unknown cache = the nudge stands down.
    if (typeof RoutineNudgeStore !== 'undefined') RoutineNudgeStore.init();
    // G3a CONFIDENCE NARRATIVE: two fire-once spoken moments in the hero's reliability arc (calibration
    // complete + TRUSTED). Init AFTER XpStore so its memory.feedback hook sees an already-folded meter.
    if (typeof ConfBeats !== 'undefined') ConfBeats.init({ getStats: () => { const a = agents.get('agent'); return a ? a.stats : null; } });
    // R5 "BOTTLE A RUN": the post-run offer to save a 👍-rated interactive run as a custom recipe. Fed a DIRECT
    // verdict from chat.js rateWork (like ConfBeats); reads each run's honest facts via runBottleInfo and opens the
    // R2 editor pre-filled on "bottle it". Shares the one post-run beat slot (Chat.nudge) — never stacks an ask.
    if (typeof BottleStore !== 'undefined') BottleStore.init({ openEditor: openBottleEditor, runInfo: runBottleInfo });
    // P3.1 "RUN IT AGAIN?": the post-run offer to re-run a 👍-rated run's shape. Fed the SAME direct verdict from
    // chat.js rateWork; reads the run's honest facts via runResummonInfo and, on accept, PRE-FILLS a fresh run
    // (selects the run's agent stream + seeds the composer with its directive) — never auto-running. Shares the one
    // post-run beat slot; chat.js gates it so it never co-fires with a bottle offer on the same run.
    if (typeof ResummonStore !== 'undefined') ResummonStore.init({ runInfo: runResummonInfo, prefillRun: prefillResummon });
    // SELF-INITIATION (Slice 2): the agent proposes recurring standing JOBS grounded in the dossier → the Commander
    // approves → each becomes a scheduled cron routine (POST /api/cron, the same endpoint the ROUTINES panel uses).
    if (typeof AutoJobStore !== 'undefined') AutoJobStore.init({
      getSystem: () => agent ? agent.systemPrompt : '',
      getName: () => agent ? agent.name : 'AGENT',
      readiness: () => (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.readiness) ? UnderstandingStore.readiness() : null,
      getBeliefs: () => {
        const out = {};
        if (typeof DossierStore === 'undefined' || !DossierStore.beliefs) return out;
        for (const k of ['goals', 'pain', 'ambition', 'stack', 'standing_orders']) {
          const arr = (DossierStore.beliefs(k) || []).map(b => b && b.text).filter(Boolean);
          if (arr.length) out[k] = arr;
        }
        return out;
      },
      getExistingJobs: () => (typeof QuerySpine !== 'undefined' && QuerySpine.refresh ? QuerySpine.refresh('cron') : Promise.reject(new Error('cron query unavailable')))
        .then(q => (((q && q.hasData && q.data) || {}).jobs || []).map(x => x && x.name).filter(Boolean)).catch(() => []),
      // W6: surface the server's `duplicate` flag so the store retires a proposal the mint gate refused (rather than
      // treating it as a plain success and re-offering). A non-JSON body degrades to { ok } exactly as before.
      scheduleJob: (body) => fetch('/api/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json().then(j => ({ ok: r.ok, duplicate: !!(j && j.duplicate) })).catch(() => ({ ok: r.ok }))).then(out => {
        if (out.ok && typeof QuerySpine !== 'undefined' && QuerySpine.invalidate) QuerySpine.invalidate('cron');
        return out;
      }).catch(() => ({ ok: false })),
      // G4 feature 2: is a MISSION BOARD placed? When it is, a proposal gets a BODY (agent walks + pins an amber
      // card on the board) instead of the inline Dialogue approval. No board → the Dialogue flow is untouched.
      boardPlaced: () => { try { const d = World.stationDoc && World.stationDoc(); return !!(d && d.props && d.props.some(p => p && p.t === 'missionboard')); } catch (_) { return false; } }
    });
    // PERMISSIONS (autonomy Stage B / B1): the Permissions Panel store. It reads/sets the standing capability
    // grants over the token-gated /api/permissions routes (harness.js hardens window.fetch to attach the token, so
    // a plain fetch carries it — exactly like the cron calls above) and drives the posture half of a level through
    // AutonomyStore. The level chooser ties grant + posture so the Commander dials never→fully-autonomous.
    if (typeof PermissionsStore !== 'undefined') PermissionsStore.init({
      getPosture: () => (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) ? AutonomyStore.summary() : null,
      applyPreset: (id) => {
        if (typeof AutonomyStore !== 'undefined' && AutonomyStore.applyPreset) AutonomyStore.applyPreset(id);
        // GROWTH Tier 3: a permissions-LEVEL change is a NON-DIAL posture writer — reconcile the earned-rung record
        // against the rung the preset just set (a diverged record retires; user override wins), so a stale record
        // can never later demote FROM a rung the dial isn't at (the silent-escalation blocker).
        try { if (typeof TrustStore !== 'undefined' && TrustStore.onManualInitiative && typeof AutonomyStore !== 'undefined' && AutonomyStore.get) TrustStore.onManualInitiative((AutonomyStore.get() || {}).initiative); } catch (_) {}
      },
      api: {
        load: () => fetch('/api/permissions', { cache: 'no-store' }).then(r => r.ok ? r.json() : { ok: false, reason: 'permissions service unavailable' }).catch(() => ({ ok: false, reason: 'permissions service unavailable' })),
        grant: (key) => fetch('/api/permissions/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key }) }).then(r => r.json().catch(() => ({})).then(j => r.ok ? j : Object.assign({}, j, { ok: false, reason: j.reason || 'permission grant failed' }))).catch(() => ({ ok: false, reason: 'permissions service unavailable' })),
        revoke: (key) => fetch('/api/permissions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key }) }).then(r => r.json().catch(() => ({})).then(j => r.ok ? j : Object.assign({}, j, { ok: false, reason: j.reason || 'permission revoke failed' }))).catch(() => ({ ok: false, reason: 'permissions service unavailable' })),
        bypass: (on) => fetch('/api/permissions/bypass', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: on === true }) }).then(r => r.json().catch(() => ({})).then(j => r.ok ? j : Object.assign({}, j, { ok: false, reason: j.reason || 'bypass switch failed' }))).catch(() => ({ ok: false, reason: 'permissions service unavailable' }))
      }
    });
    // GROWTH Tier 3 — EARNED AUTONOMY (track record → trust): folds the SAME run outcomes xpstore folds into a
    // track record that, once earned, mints a CONSENT-gated offer to raise the autonomy dial one rung (or pre-bless
    // a GRANTABLE capability). Accept applies THROUGH the existing plumbing (AutonomyStore.setInitiative /
    // PermissionsStore.grant) with provenance; a sustained bad streak DEMOTES the earned rung back (never below the
    // Commander's own manual floor) with an explicit notice. Level is its gate (offers fire at L≥3 / L≥5); XP purity
    // is untouched. Self-persists its own key; read-only bus citizen. Init AFTER XpStore/AutonomyStore/PermissionsStore
    // (it reads their live state + applies through their writers). grantable = the sidecar's curated GRANTABLE list.
    if (typeof TrustStore !== 'undefined') TrustStore.init({
      now: () => Date.now(),
      getStats: () => { const a = agents.get('agent'); return (a && a.stats && typeof Xp !== 'undefined' && Xp.compute) ? Xp.compute(a.stats) : (a ? a.stats : null); },
      getPosture: () => (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) ? AutonomyStore.summary() : null,
      setInitiative: (level) => { if (typeof AutonomyStore !== 'undefined' && AutonomyStore.setInitiative) AutonomyStore.setInitiative(level); persist(); },
      // the ONLY capabilities a grant offer may pre-bless — the sidecar's curated GRANTABLE (cabinet:write today).
      grantable: (typeof SK !== 'undefined' && SK.permgrants && Array.isArray(SK.permgrants.GRANTABLE)) ? SK.permgrants.GRANTABLE.slice() : (typeof Permissions !== 'undefined' && Permissions.grantableKeys ? Permissions.grantableKeys() : ['cabinet:write']),
      getGrants: () => { try { return (typeof PermissionsStore !== 'undefined' && PermissionsStore.snapshot) ? (PermissionsStore.snapshot().grants || []) : []; } catch (_) { return []; } },
      grant: (key) => (typeof PermissionsStore !== 'undefined' && PermissionsStore.grant) ? PermissionsStore.grant(key) : false,
      notify: (text, kind) => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(text, kind || 'warn'); }
    });
    Chat.init({ system: agent.systemPrompt, name: agent.name, ws: Workstreams.active(), onTurn: persist });
    beginBridgeAuthorityGate();   // Chat mounted the four boot claims; hold them together until the bridge proves itself
    // G2 RETURN RITUAL: arm the durable lastSeenAt heartbeat and (once per session, never during the
    // awakening) fire the while-you-were-away digest for unattended runs the sidecar recorded. The
    // store reads /api/runs + /api/cron itself and hands the rows to Chat.awayDigest; rating a row
    // rides the same rate-the-work path as an attended run. Init AFTER Chat.init so the beat can render.
    if (typeof ReturnStore !== 'undefined') ReturnStore.init({ enabled: !opts.awaitingPurpose });
    // NS-4 MORNING REPORT: once per session (never during the awakening), on a genuine return, fetch the night-shift
    // status + autonomy ledger + drafts and surface ONE honest COMMS digest — the acts fired AND the declined half
    // (which gate held them back), or the one plain "did nothing and why" sentence. Own durable away-stamp so it and
    // ReturnStore never race one value; rides Chat.nudge (one-beat-at-a-time + vanish()). Init AFTER Chat.init.
    if (typeof NightReportStore !== 'undefined') NightReportStore.init({ enabled: !opts.awaitingPurpose, agentId: agent.id });
    // NS VISIBILITY (live-session unseen-drafts nudge): the morning report only fires on app-CLOSURE absence; an app
    // left OPEN while away accumulates reason-only drafts the Commander never sees. This polls the drafts while the
    // app is open and, when N+ are unseen, surfaces ONE gentle "review?" nudge that opens the NIGHT SHIFT panel. Rides
    // Chat.nudge (one-beat-at-a-time) + a shared durable seen-stamp with the morning report. Init AFTER Chat.init.
    if (typeof NightDraftNudge !== 'undefined') NightDraftNudge.init({ enabled: !opts.awaitingPurpose, agentId: agent.id });
    // W3 AWAY-WORKSHOP RETURN CARD: on attach (once per session, never during the awakening) poll
    // /api/workshop/pending and hand the oldest undecided manifest to Chat.workshopReturn — the same
    // one-post-run-beat slot the digest rides. Keep/Later/Discard route back through WorkshopStore.decide.
    // Init AFTER Chat.init so the beat can render.
    if (typeof WorkshopStore !== 'undefined') WorkshopStore.init({ enabled: !opts.awaitingPurpose, agentIds: () => liveAgents().map(a => a.id) });
    // CRON SESSIONS: surface each unattended routine run as a readable session — cron.fire adds a busy rail row
    // (no focus-steal), cron.result folds the run's durable 'cron-<runId>' transcript into it, and a boot backfill
    // recovers sessions for routines that finished while the browser was closed. Read-only on U.bus. Init AFTER
    // Chat.init + App is fully formed (this returns App) so the module's App.refreshRail/persist bridges resolve.
    if (typeof AutoSessions !== 'undefined') AutoSessions.init();
    // Delegated-session recovery: if no page received the live delivery (or another open page won the ACK race
    // with a divergent local id), fold the durable run envelope into the matching named session exactly once.
    if (typeof StationCommands !== 'undefined' && StationCommands.reconcile) StationCommands.reconcile();
    // G3a PRIDE LAYER: arm the durable lifetime STATION RECORD — folds real completed runs / delivered
    // work-items / fired routines / summed run durations into counters that persist across sessions (own key,
    // read-only on the bus). The COMMANDER DOSSIER panel renders snapshot() as the STATION RECORD block.
    if (typeof PrideStore !== 'undefined') PrideStore.init();
    // G3b SEED-REUSE AGGREGATE: arm the durable per-seed run tally (own key). The digest feeds it the
    // provenance-matched while-away rows; it powers the TROPHY CASE's living-tools shelf + the once-per-window
    // "your seed ran 5× this week" callout. ReturnStore's digest is delayed (setTimeout), so this synchronous
    // init lands before the first digest can feed it — the first while-away digest is tallied.
    if (typeof SeedReuseStore !== 'undefined') SeedReuseStore.init();
    // AUTOPILOT (autonomy Slice A — the idle self-direction driver): when the Commander goes idle with autonomy
    // enabled, the station either EARNS context (asks one gentle get-to-know-you question — A1) or, once the dial
    // permits acting AND the dossier is hot AND today's leash has budget, it ACTS — runs the anti-slop pipeline as
    // two SILENT reason-only runs (no tools → safe) and leaves a draft on the desk (A2). The decision is pure
    // (autopilot.js); this is the edge — the live clock, the activity listeners + idle tick (installed once), the
    // curiosity hand-off, the model runs, and the desk delivery. It reads the posture + the (confirmed-only)
    // dossier, never writes either. Reach stays sandbox — nothing is auto-sent or auto-applied (Stage B raises it).
    if (typeof AutopilotStore !== 'undefined') AutopilotStore.init({
      now: () => Date.now(),
      getPosture: () => (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) ? AutonomyStore.summary() : null,
      getDossier: () => (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null,
      getBeliefs: (dim) => (typeof DossierStore !== 'undefined' && DossierStore.beliefs) ? DossierStore.beliefs(dim) : [],
      offerCuriosity: () => (typeof Chat !== 'undefined' && Chat.offerCuriosity) ? Chat.offerCuriosity() : false,
      getSystem: () => agent ? agent.systemPrompt : '',
      getName: () => agent ? agent.name : 'AGENT',
      // the autopilot's reason-only runs: no `placed` (no tools) + internal (silent) → safe + uncounted by construction.
      chat: (o) => (typeof Harness !== 'undefined' && Harness.chat) ? Harness.chat(o) : Promise.resolve({ error: 'no-harness' }),
      // B2 — the real-write hand-off. canWriteFiles = the cabinet:write CONSENT (PermissionsStore); hasCabinet = the
      // cabinet CAPABILITY actually placed (World.heroCaps — object=capability); BOTH required (Autopilot.canWrite).
      // writeFile = the token-gated, consent-broker-gated, checkpointed server write (/api/autonomy/write). A failed
      // or denied write just degrades to a desk draft (the act() branch handles the fallback).
      canWriteFiles: () => { try { return (typeof PermissionsStore !== 'undefined' && PermissionsStore.snapshot) ? (PermissionsStore.snapshot().grants || []).indexOf('cabinet:write') >= 0 : false; } catch (_) { return false; } },
      hasCabinet: () => { try { return (typeof World !== 'undefined' && World.heroCaps) ? (World.heroCaps((agent && agent.id) || 'agent') || []).indexOf('cabinet') >= 0 : false; } catch (_) { return false; } },
      writeFile: (req) => fetch('/api/autonomy/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: (agent && agent.id) || 'agent', path: req.path, content: req.content }) }).then(r => r.ok ? r.json() : { ok: false }).catch(() => ({ ok: false })),
      // leave the result on the Commander's desk: a persistent toast + the live "working" cue + a gentle COMMS beat
      // that, on accept, posts the work into the feed. If it WROTE a real file (B2) the copy says so + names the path;
      // otherwise it's a desk draft. Either way nothing is sent/published/spent.
      present: (d) => {
        const didWrite = !!(d && d.wrote && d.wrote.path);
        // ONE SURFACE PER MOMENT (beat-fat trim 2026-07-03): the COMMS nudge below is the announcement — an
        // actionable beat sitting in the feed. The toast only fires as the FALLBACK when the nudge can't render
        // (no Chat yet), so the same draft is never announced twice (toast + nudge was the "pushy" double).
        // World.say stays: an ambient in-world cue, not a popup. The return digest recaps everything anyway.
        const canNudge = typeof Chat !== 'undefined' && Chat.nudge;
        if (!canNudge && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify((didWrite ? 'wrote a file while you were away: ' : 'drafted while you were away: ') + d.title, 'gold', 'cronDigest');   // P1-8 category: autonomous run
        if (typeof World !== 'undefined' && World.say) World.say(didWrite ? '✦ saved a file to your workspace' : '✦ left a draft on your desk');
        if (canNudge) Chat.nudge(
          didWrite
            ? ('✦ while you were away i wrote “' + d.title + '” to your workspace (' + d.wrote.path + '). want to see it?')
            : ('✦ while you were away i drafted “' + d.title + '”. want to see it?'),
          [{ label: 'show me', value: 'yes' }, { label: 'not now', value: 'no', skip: true }],
          item => {
            if (!item || item.value !== 'yes') return;
            if (typeof Chat.localLine === 'function') { Chat.localLine((didWrite ? '✎ ' : '▤ ') + d.title + (didWrite ? '  ·  ' + d.wrote.path : '')); Chat.localLine(d.body); }
            // LEARN HOOK (A3): a one-tap useful/not on the work it just showed → AutopilotStore.rate re-weights selection per Commander.
            if (typeof Chat.nudge === 'function') Chat.nudge('was that worth doing?',
              [{ label: 'useful', value: 'up' }, { label: 'not really', value: 'down', skip: true }],
              r => { if (typeof AutopilotStore !== 'undefined' && AutopilotStore.rate) AutopilotStore.rate(d.archetype, !!(r && r.value === 'up')); });
          }
        );
      },
      // the WELCOME-BACK digest (A3): on the first interaction after a real absence, one gold beat truthfully
      // recapping what the station did while away — composed from the draft log, no new events.
      digest: (info) => {
        const mins = Math.max(1, Math.round(info.awayMs / 60000));
        // B3 — report what was WRITTEN vs drafted, and offer a one-tap UNDO. The headline + the ✎/▸ lines compose
        // ENTIRELY from the draft log (no new events). Undo = restore the EARLIEST write's pre-snapshot, which rolls
        // the WHOLE workspace back to before any away-write — so the copy says exactly that (honest, not per-file).
        const sum = (typeof Autopilot !== 'undefined' && Autopilot.digestSummary) ? Autopilot.digestSummary(info.drafts) : { wroteCount: 0, draftCount: (info.drafts || []).length, undoSnapshot: null };
        const headline = (typeof Autopilot !== 'undefined' && Autopilot.digestHeadline) ? Autopilot.digestHeadline(sum) : ((info.drafts || []).length + ' on your desk');
        const lines = (info.lines && info.lines.length) ? '\n' + info.lines.join('\n') : '';
        const canUndo = !!(sum.wroteCount && sum.undoSnapshot);
        const restore = (snap) => fetch('/api/checkpoint/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: (agent && agent.id) || 'agent', snapshotId: snap }) }).then(r => r.ok).catch(() => false);
        // TRANSPARENCY LAW — the digest must be able to SHOW the work, not just count it. "show me" prints every
        // fresh draft's full body (and the real path of anything written) straight into the feed from the draft
        // log — the Commander never has to take "1 draft on your desk" on faith.
        const reveal = () => {
          if (typeof Chat === 'undefined' || typeof Chat.localLine !== 'function') return;
          for (const d of (info.drafts || [])) {
            if (!d || !d.title) continue;
            const wrotePath = d.wrote && d.wrote.path;
            Chat.localLine((wrotePath ? '✎ ' : '▤ ') + String(d.title).trim() + (wrotePath ? '  ·  ' + wrotePath : ''));
            if (d.body) Chat.localLine(String(d.body));
            else Chat.localLine(wrotePath ? '(the full text is in the file above)' : '(this draft has no saved body — it may predate the draft log)');
          }
        };
        const showBeat = () => {
          if (typeof Chat === 'undefined' || !Chat.nudge) return;
          const opts = [{ label: 'show me', value: 'show' }, { label: 'got it', value: 'ok', skip: true }];
          if (canUndo) opts.push({ label: 'undo the writes', value: 'undo' });
          Chat.nudge(
            '✦ welcome back — while you were away (' + mins + 'm): ' + headline + lines + (canUndo ? '\n(undo rolls your workspace back to before i wrote them)' : ''),
            opts,
            item => {
              if (!item) return;
              if (item.value === 'show') return reveal();
              if (item.value !== 'undo' || !canUndo) return;
              restore(sum.undoSnapshot).then(ok => {
                if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(ok ? 'rolled back the files i wrote while you were away' : 'could not roll back — the snapshot is gone', ok ? 'gold' : 'warn');
                if (ok && typeof World !== 'undefined' && World.say) World.say('✦ rolled back my away-writes');
              });
            });
        };
        // ONE SURFACE PER MOMENT (beat-fat trim 2026-07-03): the welcome-back nudge (showBeat) IS the digest —
        // richer than a toast (show me / undo) and it fires at the same instant the toast used to, saying the
        // SAME sentence. The toast is now only the FALLBACK when the nudge can't render (no Chat), so the
        // Commander's first interaction back is greeted once, not twice.
        if ((typeof Chat === 'undefined' || !Chat.nudge) && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('while you were away (' + mins + 'm): ' + headline, 'gold', 'cronDigest');   // P1-8 category: autonomous digest
        // DEFERRED a beat: this fires from the capture phase of the Commander's first pointerdown/keydown back.
        // Posting the nudge synchronously would clearNudge()/clearChoices() an in-flight answer on a live beat
        // (e.g. the per-draft "show me" chip) mid-press — the very tap that woke the digest would be eaten.
        setTimeout(showBeat, 400);
      },
      // RETURN RE-PRESENT (2026-07-14): the digest above composes from the LOCAL draft log, which the
      // server-owned night-shift act path never writes — so a build that landed while away was announced
      // to an empty room and never re-offered ("I sat here for hours and it never told me what it did").
      // On a genuine return, re-offer the oldest still-UNDECIDED workshop deliverable as the return card
      // (Chat.workshopReturn defers behind the digest nudge/live beats, so the one-beat law holds).
      onReturn: () => { try { if (typeof WorkshopStore !== 'undefined' && WorkshopStore.presentOnReturn) WorkshopStore.presentOnReturn(); } catch (_) {} }
    });
    if (typeof Voice !== 'undefined') Voice.init({ name: agent.name, personaId: agent.personaId, resumeCue: !opts.awaitingPurpose });   // mic + this agent's per-persona voice; offer hands-free resume except during the awakening
    if (typeof ModelDock !== 'undefined') ModelDock.init({ apply: applyQuickModel });
    syncChannels();   // if a Telegram bot auto-started from saved config, refresh it to THIS agent's live identity
    pushRoster();     // Stage 2: seed the sidecar with the live crew so the lead can delegate (no-op for a solo station)
    renderRail();
    el('ws-new').onclick = newWorkstream;
    wireRailSearch();
    // NS-5c SESSIONS ↔ PROJECTS toggle + ADD-a-project wiring
    { const ts = el('ws-tab-sessions'); if (ts) ts.onclick = () => setRailView('sessions'); }
    { const tp = el('ws-tab-projects'); if (tp) tp.onclick = () => setRailView('projects'); }
    // the projects head action is contextual (see updateProjHeadAction): overview = bless a folder,
    // entered project = start a session anchored to it.
    { const ap = el('ws-addproject'); if (ap) ap.onclick = () => { if (projScope) newSessionInProject(projScope); else beginAddProject(); }; }
    if (opts.awaitingPurpose && typeof Onboarding !== 'undefined') {
      // THE AWAKENING — a guided first meeting that authors identity/purpose/context/operating-manual.md
      // while the room rises from dark to first light. Replaces the old single "what is my purpose?" beat.
      Onboarding.start({
        name: agent.name,
        role: agent.role || 'orchestrator',                  // the first agent wakes as the station's ORCHESTRATOR — the ceremony frames it as the lead
        docs: agentDocs(agent),
        wake: !!opts.wake,
        persona: (typeof Personas !== 'undefined') ? Personas.get(agent.personaId) : null,   // the voice was chosen on the create screen — the awakening acknowledges it instead of re-asking
        specialty: opts.specialty || null,                   // (reserved) a pre-specced wake skips re-asking the mission; the orchestrator authors it live
        commit: applyAgentConfig,                            // each answer folds a real doc into the live prompt + persists
        getSystem: () => agent ? agent.systemPrompt : '',    // Interview 2.0: the generated beats (wakemind.js) reason on the LIVE prompt (persona + dossier already folded in)
        done: () => { if (agent) agent.onboarded = true; persist(); if (typeof KeyCTA !== 'undefined' && KeyCTA.arm) KeyCTA.arm(); },   // the awakening landed — mark onboarded so a later refresh resumes into the game, not back into the ceremony; arm the keyless-brain CTA (shows only if no key is truly stored)
        notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
        // FIRST COMMAND — once the awakening lands, the agent itself teaches the Commander the one real loop (tutorial.js)
        taught: () => { if (typeof Tutorial !== 'undefined' && Tutorial.firstCommand) Tutorial.firstCommand({ name: agent.name }); }
      });
    }
    // A returning (already-onboarded) hero skips the awakening, so its `done` callback never re-fires — arm the
    // keyless-brain CTA here so a station saved without a key still surfaces the honest "add a key" banner on boot.
    // (It's a pure state projection: it stays hidden when a key IS stored.) The awakening path arms it in `done`.
    if (!opts.awaitingPurpose && typeof KeyCTA !== 'undefined' && KeyCTA.arm) KeyCTA.arm();
    // V3 S5: a keyless wake banked an interview IOU — the first session that boots with a LIVE brain offers
    // to pay it (one gentle nudge; declining hands the gap to hunt mode). Delayed so COMMS settles first.
    if (!opts.awaitingPurpose && typeof Onboarding !== 'undefined' && Onboarding.offerDeferred) {
      setTimeout(() => { try { Onboarding.offerDeferred({
        name: agent ? agent.name : 'AGENT',
        docs: agent ? agentDocs(agent) : null,
        commit: applyAgentConfig,
        getSystem: () => agent ? agent.systemPrompt : '',
        persona: (typeof Personas !== 'undefined' && agent) ? Personas.get(agent.personaId) : null,
        notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null
      }); } catch (_) {} }, 4000);
    }
    // P3: arm the first-steps briefing's bus ticks; re-offer the checklist to a returning user mid-progress
    if (typeof Tutorial !== 'undefined' && Tutorial.onEnterGame) Tutorial.onEnterGame();
    // G1c: the deferred BUILD-dock glow — a soft standing hint on the BUILD dock while a station quest is open
    // (the fix is one click away). Stands down while the tutorial is coaching (tutorial wins). Started here so
    // it only ever runs on the floor; disconnect() stops it.
    if (typeof DockGlow !== 'undefined' && DockGlow.start) DockGlow.start();
  }

  // (the single-question purpose interview was replaced by the AWAKENING — Onboarding authors purpose.md
  //  and the other config docs through applyAgentConfig; see onboarding.js + enterGame.)

  /* ---------- workstreams rail (left) ---------- */
  // A rail row is ONE LINE — exactly as compact as before — but now carries LIVE STATE: the dot pulses while a run
  // is in flight on that stream (gold when it's paused awaiting your approval), and a right-aligned time token
  // reads the live elapsed while busy or a relative "last worked" stamp when idle. The busy signal is read
  // straight from Channels (channels.js) — the same per-workstream run-state the COMMS header trusts — so it's
  // honest by construction and needs no new backend wiring: the rail already re-renders at run start + finish, and
  // a 1s ticker keeps the seconds moving. The full status word ("working…"/"awaiting your approval…") lives in the
  // row's hover tooltip so the one-line layout never has to spell it out.
  let railTicker = 0;
  let railShowArchived = false;   // when true the rail also lists archived (put-away) sessions, dimmed
  let railFocusId = null;         // roving-tabindex cursor: one rail stop regardless of session count
  function railFmtElapsed(ms) {
    const s = Math.floor((ms < 0 ? 0 : ms) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;   // 4s · 42s · 1:05
  }
  function railRelTime(ms) {                     // compact right-edge stamp: now · 2m · 1h · 3d
    if (!ms) return '';
    const d = Date.now() - ms;
    if (d < 60000) return 'now';                 // under a minute reads "now" (never "0m")
    const m = Math.floor(d / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }
  // the live presentation of one row: the dot class (pulsing run / gold attention / idle lane color), the compact
  // right-edge meta (elapsed while busy, relative stamp when idle), and the busy/attn flags + full status word for
  // the hover tooltip. Pure read of Channels + the record — no mutation.
  /* THE DOT ANSWERS EXACTLY ONE QUESTION: whose turn is this session on?
       FLASHING      — live right now. Phosphor = the agent is working; GOLD = it is paused on YOU
                       (an approval, which is the one state burning down a fail-closed deny timer).
       STEADY BRIGHT — finished, and you have NOT seen the output yet. This is the "ready" state.
       FADED         — you have seen everything here. Nothing is owed in either direction.
     The dot used to encode the kanban LANE instead, which inverted the very glance it exists for: a
     read 'active' session sat at --ph-bright with a glow while an UNREAD 'todo' session sat at
     --ph-dim, so seen sessions looked louder than unseen ones. Lane moved to the row tooltip — the
     task board is the surface that owns it, and for a 'chat' stream (most of the rail) lane is
     inferred rather than chosen, so it was never a fact worth the loudest pixel in the row. */
  function railRowState(w) {
    if (typeof Channels !== 'undefined' && Channels.isBusy(w.id)) {
      const status = Channels.statusOf(w.id);
      const attn = /approval/.test(status);
      const started = Channels.startedAtOf(w.id);
      // EL-11: a pending consent gets an EXPLICIT marker on its own row (not just the dot recolor) — a
      // background session's paused run must be findable at a glance before the sidecar's deny timer runs out.
      return { dot: 'ws-dot ' + (attn ? 'needsyou' : 'working'), meta: attn ? '▣ NEEDS YOU' : (started ? railFmtElapsed(Date.now() - started) : '…'), busy: true, attn, status };
    }
    // a DELIVERY session ('workshop-<runId>' — idle-built work) that hasn't been reviewed is a decision the
    // Commander owes, not just an unread chat: say REVIEW on the row itself (2026-07-15 UX audit — the ⚒ prefix
    // alone didn't distinguish "your agent made you something" from ordinary unread activity).
    if (String(w.id).indexOf('workshop-') === 0 && Workstreams.unread(w)) {
      return { dot: 'ws-dot unseen', meta: '⚒ REVIEW', busy: false, attn: false, status: 'a build is waiting for your review' };
    }
    // UNSEEN vs SEEN is the whole idle axis now. `unread` is two real stored timestamps
    // (lastActiveAt > lastReadAt) and is never true for the stream you have open, so the dot goes
    // faded the instant you actually look at it — which is what makes a glance down the rail mean
    // something. The ⚒ REVIEW branch above keeps its own wording: a BUILD waiting is a different
    // errand from a reply waiting, even though both are "unseen".
    if (Workstreams.unread(w)) return { dot: 'ws-dot unseen', meta: railRelTime(w.lastActiveAt), busy: false, attn: false, status: '' };
    return { dot: 'ws-dot seen', meta: railRelTime(w.lastActiveAt), busy: false, attn: false, status: '' };
  }
  /* ---------- INBOX row extras (SESSION ROWS = inbox) ----------
     Both lines are rendered ALWAYS and hidden by CSS in COMPACT, so the setting is a pure repaint —
     no re-render, no lost rail focus/scroll, and updateRailLive keeps working untouched.
     Every value is a read of state that already exists; nothing here is derived or guessed. */
  function railAgentName(w) {
    const a = agents.get(w.agentId);                      // the live registry, same one the world reads
    return (a && a.name) ? a.name : (w.agentId || 'AGENT');
  }
  // "<model> · <n> MSG". The model is the one the SIDECAR reported for this stream's last run
  // (Workstreams.lastModel) — never the agent's current dropdown value, which would assert a model
  // over a transcript other models may have written. Unmeasured reads '—', which is the honest answer.
  function railReceipt(w) {
    const n = (Workstreams.visibleMessages ? Workstreams.visibleMessages(w) : []).length;
    // the vendor prefix is dropped for the ROW only ('anthropic/claude-sonnet-4.5' → 'claude-sonnet-4.5'):
    // a 232px rail cannot hold the full id, and a clipped id reads as a different model. The complete,
    // unabbreviated id stays in the row's tooltip (railModelFull), so nothing is actually hidden.
    const model = (w.lastModel || '').trim().split('/').pop();
    return (model || '—') + ' · ' + n + ' MSG';
  }
  function railModelFull(w) { return (w.lastModel || '').trim(); }
  function rowClass(w, st, activeId) {
    return 'ws-row' + (w.id === activeId ? ' sel' : '') + (st.busy ? ' busy' : '') + (st.attn ? ' attn' : '')
      + (w.pinned ? ' pinned' : '') + (w.archived ? ' archived' : '')
      + (Workstreams.unread(w) ? ' unread' : '');   // real unseen activity (lastActiveAt > lastReadAt, never the open stream)
  }
  function renderRail() {
    const ul = el('workstreams');
    if (!ul || typeof Workstreams === 'undefined') return;
    const activeId = Workstreams.activeId();
    const oldFocus = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.ws-row[data-id]') : null;
    const restoreFocus = !!(oldFocus && ul.contains(oldFocus));
    if (oldFocus && oldFocus.dataset.id) railFocusId = oldFocus.dataset.id;
    const rows = Workstreams.list({ includeArchived: railShowArchived });
    if (!rows.some(w => w.id === railFocusId)) railFocusId = rows.some(w => w.id === activeId) ? activeId : (rows[0] && rows[0].id);
    ul.setAttribute('role', 'listbox');
    ul.setAttribute('aria-label', 'Sessions');
    ul.innerHTML = rows.map((w, index) => {
      const title = w.title || 'General';
      const st = railRowState(w);
      const full = railModelFull(w);
      const tip = title + (w.archived ? ' · archived' : '') + (st.busy ? ' · ' + st.status : '')
        + (Workstreams.unread(w) ? ' · not seen yet' : '')
        // LANE lives here now rather than in the dot. Only a board DIRECTIVE ('task') actually chose
        // its lane; a plain chat's lane is inferred, so naming it on every row would dress a guess
        // up as a decision. The board remains the surface that owns and edits this.
        + (w.kind === 'task' ? ' · board: ' + w.lane : '')
        + (full ? ' · last run on ' + full : '')   // the UNABBREVIATED id the row had to shorten
        + ' — Shift+F10 or right-click for actions';
      return '<li class="' + rowClass(w, st, activeId) + '" data-id="' + U.esc(w.id) + '" tabindex="' + (w.id === railFocusId ? '0' : '-1') + '" role="option" aria-selected="' + (w.id === activeId ? 'true' : 'false') + '" aria-posinset="' + (index + 1) + '" aria-setsize="' + rows.length + '" aria-label="' + U.esc(title + ' session' + (railAgentName(w) === title ? '' : ', ' + railAgentName(w)) + (Workstreams.unread(w) ? ', not seen yet' : '') + '; Enter to open; Shift+F10 for actions') + '" aria-keyshortcuts="Shift+F10" title="' + U.esc(tip) + '">' +
        '<span class="' + st.dot + '"></span>' +
        (w.pinned ? '<span class="ws-pin" aria-hidden="true">★</span>' : '') +
        '<span class="ws-agent" aria-hidden="true">' + U.esc(railAgentName(w)) + '</span>' +
        '<span class="ws-title">' + U.esc(title) + '</span>' +
        '<span class="ws-meta">' + U.esc(st.meta) + '</span>' +
        '<span class="ws-receipt" aria-hidden="true">' + U.esc(railReceipt(w)) + '</span>' +
        '<button class="ws-kebab" tabindex="-1" aria-label="session actions" title="session actions">⋯</button>' +
        '</li>';
    }).join('');
    ul.querySelectorAll('.ws-row').forEach(li => {
      const id = li.dataset.id;
      li.onclick = () => switchWorkstream(id);
      li.onkeydown = (e) => {
        if (e.target !== li) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchWorkstream(id); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          const items = Array.from(ul.querySelectorAll('.ws-row[data-id]'));
          const at = items.indexOf(li);
          let next = at;
          if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = items.length - 1;
          else next = Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
          const target = items[next];
          if (target && target !== li) {
            li.tabIndex = -1; target.tabIndex = 0; railFocusId = target.dataset.id;
            target.focus(); if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
          }
          return;
        }
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = li.getBoundingClientRect();
          openWsMenu(id, r.left, r.bottom + 2, li);
        }
      };
      // right-click OR the hover ⋯ button opens the same actions menu (rename · pin · archive · delete)
      li.oncontextmenu = (e) => { e.preventDefault(); openWsMenu(id, e.clientX, e.clientY, li); };
      const keb = li.querySelector('.ws-kebab');
      if (keb) keb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const r = keb.getBoundingClientRect(); openWsMenu(id, r.left, r.bottom + 2, keb); };
    });
    if (restoreFocus && railFocusId) {
      const target = Array.from(ul.querySelectorAll('.ws-row[data-id]')).find(li => li.dataset.id === railFocusId);
      if (target) target.focus({ preventScroll: true });
    }
    updateArchivedToggle();
    armRailTicker();
    if (typeof StationUI !== 'undefined' && StationUI.refreshBoard) StationUI.refreshBoard();
  }
  // ONE always-on 1s heartbeat keeps the rail truthful while in-game: the busy elapsed counts up AND the idle
  // "last worked" stamps age (2m → 3m) even when nothing is running. It's cheap — every write is change-detected,
  // so a quiet rail does a handful of string compares a second and touches no DOM. It self-stops the moment the
  // rail is gone or the station screen is left (and disconnect() stops it outright); renderRail re-arms on re-entry.
  // Refreshes each row IN PLACE (no innerHTML rebuild) so a click or the scroll position is never reset; the
  // pulsing dot itself is pure CSS — this only swaps the dot CLASS, the right-edge time token, and the row classes.
  function updateRailLive() {
    const ul = el('workstreams'); const game = el('screen-game');
    if (!ul || typeof Workstreams === 'undefined' || !game || !game.classList.contains('active')) { stopRailTicker(); return; }
    const activeId = Workstreams.activeId();
    ul.querySelectorAll('.ws-row').forEach(li => {
      if (li.querySelector('.ws-rename')) return;   // leave a row alone while its title is being edited in place
      const w = Workstreams.get(li.dataset.id); if (!w) return;
      const st = railRowState(w);
      const dot = li.querySelector('.ws-dot'); if (dot && dot.className !== st.dot) dot.className = st.dot;
      const meta = li.querySelector('.ws-meta'); if (meta && meta.textContent !== st.meta) meta.textContent = st.meta;
      // the INBOX receipt ages like the rest of the row: a reply landing mid-run moves the count, and a
      // model measured for the first time replaces the '—'. Change-detected, so a quiet rail touches no DOM.
      const rec = li.querySelector('.ws-receipt');
      if (rec) { const next = railReceipt(w); if (rec.textContent !== next) rec.textContent = next; }
      const cls = rowClass(w, st, activeId); if (li.className !== cls) li.className = cls;
    });
  }
  function armRailTicker() { if (!railTicker) railTicker = setInterval(updateRailLive, 1000); }
  function stopRailTicker() { if (railTicker) { clearInterval(railTicker); railTicker = 0; } }
  // A backgrounded tab FREEZES/intensively-throttles its timers, so the live clock stalls while you're away. The
  // instant the station is visible again, snap every row back to truth (and re-arm the heartbeat) so the elapsed
  // and "last worked" stamps are never caught stale — they jump straight to correct, not after the next tick.
  // Registered once for the page lifetime; the in-game guard keeps it inert on the title/connect screens.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const game = el('screen-game');
      if (game && game.classList.contains('active')) renderRail();
    });
  }
  // switching mid-run is fine now: each workstream keeps its own run-state in Channels (channels.js) and
  // Chat.load re-renders the in-flight stream on switch — the run you left keeps streaming in the background.
  function switchWorkstream(id) {
    if (id === Workstreams.activeId()) return;
    const ws = Workstreams.switch(id); if (!ws) return;
    SFX.click();
    focusAgent(ws.agentId || 'agent');   // the focused agent follows the stream's binding (multi-agent COMMS)
    if (typeof World !== 'undefined' && World.lockBody) World.lockBody(ws.agentId || 'agent');   // Commander PICKED this session → the camera follow-locks its agent (any wheel/drag releases it)
    Chat.load(ws); refreshUsage(); renderRail(); persist();
    if (typeof StationCommands !== 'undefined' && StationCommands.reconcile) StationCommands.reconcile(id);
    if (railView === 'projects') renderProjects();   // keep the entered-project selection truthful
  }
  function openWorkstream(id) { switchWorkstream(id); }
  function newWorkstream() {
    const ws = Workstreams.startSession();
    SFX.open(); Chat.load(ws); refreshUsage(); renderRail(); persist();
  }
  /* Rail search + per-session export — what survived the SESSION TOOLS window (retired 2026-07-17).
     Search lives directly on the sessions rail (the one capability no other surface covered); export
     moved into the row ⋯ actions menu so it always names its exact target. The pure store
     (workstreams.js) still owns the search/export/scrub invariants; this layer only renders + downloads. */
  function sessionDownload(bundle) {
    if (!bundle || !bundle.text) return false;
    try {
      const blob = new Blob([bundle.text], { type: bundle.mime || 'text/plain' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = bundle.filename || 'starnet-conversation.txt';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
      return true;
    } catch (_) { return false; }
  }
  // Export ONE named session from its row menu — never an implicit "the active one".
  function exportSession(id, format) {
    const w = Workstreams.get(id), bundle = w && Workstreams.exportConversation(id, format);
    const ok = sessionDownload(bundle); if (ok) SFX.click(); else SFX.bad();
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(ok ? ('exported “' + ((w && w.title) || 'General') + '” — hidden data and secrets excluded') : 'nothing to export in “' + ((w && w.title) || 'General') + '”', ok ? '' : 'warn', undefined, { transient: true });
  }
  function renderSessionSearch() {
    const input = el('ws-search'), out = el('ws-search-results'), sessions = el('workstreams'); if (!input || !out) return;
    const q = input.value.trim(); out.innerHTML = '';
    // Search results replace the ordinary rail rows; showing both made a no-match result claim "nothing
    // matches" while unrelated sessions stayed selectable directly underneath it.
    if (sessions) sessions.hidden = railView !== 'sessions' || !!q;
    if (!q) return;
    const hits = Workstreams.search(q);
    for (const hit of hits) {
      const li = document.createElement('li'); li.className = 'ws-search-hit'; li.tabIndex = 0; li.dataset.id = hit.id;
      const title = document.createElement('b'); title.textContent = hit.title || 'General';
      const snippet = document.createElement('small'); snippet.textContent = hit.snippet;
      li.append(title, snippet);
      const open = () => { switchWorkstream(hit.id); input.value = ''; renderSessionSearch(); };
      li.onclick = open; li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
      out.appendChild(li);
    }
    if (!hits.length) {
      const li = document.createElement('li'); li.className = 'ws-search-hit'; li.textContent = 'No title or transcript matches.'; out.appendChild(li);
    }
  }
  function wireRailSearch() {
    const q = el('ws-search'); if (!q || q.__wired) return;
    q.__wired = true;
    q.oninput = renderSessionSearch;
    q.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); q.value = ''; renderSessionSearch(); q.blur(); } };
  }
  // COMMS AGENT SELECTOR: put the Commander on the line with agent <agentId>. Selecting an agent must never
  // silently rebind an existing conversation to a different agent (that would corrupt whose transcript it is);
  // instead we switch to the agent's most-recent live workstream, or MINT a fresh one bound to that agentId
  // (the same Workstreams.create({agentId}) seam summon uses). switchWorkstream then repoints the focused agent
  // (its model/provider/effort) + Chat.load. Returns the target workstream id, or null for an unknown agent.
  function selectAgent(agentId) {
    const id = String(agentId || '');
    const a = agents.get(id); if (!a) return null;
    // A BRAND-NEW empty session is a blank line the Commander just opened: picking an agent puts THAT agent
    // on THIS line instead of teleporting to the agent's latest old stream (the Commander keeps the freedom
    // to start a fresh chat with anyone). Rebinding a blank stream corrupts no transcript — the no-rebind
    // law above only protects conversations with content. General (the hero's home) and any stream with
    // history / runs / a live run keep their binding and fall through to the switch-or-mint path.
    const cur = Workstreams.active();
    if (cur && cur.id !== Workstreams.generalId() && (cur.agentId || 'agent') !== id
        && !(cur.history && cur.history.length) && !(cur.runIds && cur.runIds.length)
        && !(typeof Channels !== 'undefined' && Channels.isBusy(cur.id))
        && Workstreams.setAgent(cur.id, id)) {
      focusAgent(id); if (typeof World !== 'undefined' && World.lockBody) World.lockBody(id);   // explicit agent pick → camera follow-lock
      Chat.load(cur); refreshUsage(); renderRail(); persist();
      return cur.id;
    }
    // prefer this agent's existing streams (most-recently-active first — Workstreams.list() is already sorted
    // pinned>recent); the General default stream (title==null) is only NOVA/hero's home, so a specialist that
    // has no stream yet gets a fresh one titled with its name (mirrors summon's Workstreams.create).
    const mine = Workstreams.list().filter(w => (w.agentId || 'agent') === id);
    let ws = mine[0] || null;
    if (!ws) ws = Workstreams.create(a.name, { agentId: id, activate: false });
    if (!ws) return null;
    if (ws.id === Workstreams.activeId()) { focusAgent(id); if (typeof World !== 'undefined' && World.lockBody) World.lockBody(id); Chat.load(ws); }   // already here: re-affirm focus/labels + camera follow-lock
    else switchWorkstream(ws.id);
    return ws.id;
  }

  /* ---------- session (workstream) row actions: rename · pin · archive · delete ----------
     Reached by right-click OR the hover ⋯ on any rail row. A floating menu drawn in the phosphor
     chrome (no native context menu / no window.prompt / no window.confirm): rename is edited IN
     PLACE in the row, delete is a two-step arm/confirm (the terminal idiom for anything destructive),
     and every mutation goes through the Workstreams store — which already guards General from being
     archived or deleted — then re-renders + persists. Archived streams are hidden by default; the
     ARCHIVED toggle in the rail head reveals them so they can be restored or deleted. */
  let wsMenuEl = null, wsMenuReturnEl = null;
  function closeWsMenu(restoreFocus) {
    if (!wsMenuEl) return;
    const returnEl = wsMenuReturnEl;
    wsMenuEl.remove(); wsMenuEl = null;
    wsMenuReturnEl = null;
    document.removeEventListener('pointerdown', onWsMenuOutside, true);
    document.removeEventListener('keydown', onWsMenuKey, true);
    window.removeEventListener('blur', closeWsMenu);
    window.removeEventListener('resize', closeWsMenu);
    const ul = el('workstreams'); if (ul) ul.removeEventListener('scroll', closeWsMenu, true);
    if (restoreFocus === true && returnEl && returnEl.isConnected && returnEl.focus) returnEl.focus();
  }
  function onWsMenuOutside(e) { if (wsMenuEl && !wsMenuEl.contains(e.target)) closeWsMenu(); }
  function onWsMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeWsMenu(true); } }
  function openWsMenu(id, x, y, returnEl) {
    closeWsMenu();
    const w = Workstreams.get(id); if (!w) return;
    const isGeneral = (id === Workstreams.generalId());
    const menu = document.createElement('div');
    menu.className = 'ws-menu'; menu.setAttribute('role', 'menu');
    const item = (act, label, glyph, cls) =>
      '<button class="ws-menu-item' + (cls ? ' ' + cls : '') + '" role="menuitem" data-act="' + act + '">' +
      '<span class="ws-menu-glyph" aria-hidden="true">' + glyph + '</span>' + U.esc(label) + '</button>';
    let html = item('rename', 'Rename', '✎') + item('pin', w.pinned ? 'Unpin' : 'Pin to top', w.pinned ? '☆' : '★')
      + item('export-md', 'Export .md', '⤓') + item('export-json', 'Export .json', '⤓');
    if (!isGeneral) {
      html += item('archive', w.archived ? 'Unarchive' : 'Archive', w.archived ? '⇱' : '⇲') +
        '<div class="ws-menu-sep"></div>' + item('delete', 'Delete', '✕', 'danger');
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);
    // clamp to the viewport so a row near an edge still shows the whole menu.
    // x/y/rect/innerWidth are visual px; style px on the body-child menu are zoomed (TEXT SIZE) — /z once.
    const z = U.uiZoom(), r = menu.getBoundingClientRect();
    const vw = (window.innerWidth || document.documentElement.clientWidth) / z;
    const vh = (window.innerHeight || document.documentElement.clientHeight) / z;
    menu.style.left = Math.max(6, Math.min(x / z, vw - r.width / z - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y / z, vh - r.height / z - 6)) + 'px';
    wsMenuEl = menu;
    wsMenuReturnEl = returnEl && returnEl.focus ? returnEl : null;
    menu.querySelectorAll('.ws-menu-item').forEach(btn => {
      const act = btn.dataset.act;
      if (act === 'delete') {   // destructive → arm on first click, act on a second within 4s
        btn.addEventListener('click', () => {
          if (btn.dataset.armed) { closeWsMenu(); deleteWorkstream(id); return; }
          btn.dataset.armed = '1'; btn.classList.add('armed');
          btn.innerHTML = '<span class="ws-menu-glyph" aria-hidden="true">✕</span>Confirm delete';
          SFX.bad();
          setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('armed'); btn.innerHTML = '<span class="ws-menu-glyph" aria-hidden="true">✕</span>Delete'; } }, 4000);
        });
      } else {
        btn.addEventListener('click', () => { closeWsMenu(); wsMenuAction(act, id); });
      }
    });
    document.addEventListener('pointerdown', onWsMenuOutside, true);
    document.addEventListener('keydown', onWsMenuKey, true);
    window.addEventListener('blur', closeWsMenu);
    window.addEventListener('resize', closeWsMenu);
    const ul = el('workstreams'); if (ul) ul.addEventListener('scroll', closeWsMenu, true);
    menu.querySelector('.ws-menu-item').focus();
    SFX.click();
  }
  function wsMenuAction(act, id) {
    const w = Workstreams.get(id); if (!w) return;
    if (act === 'rename') { beginRenameRow(id); return; }
    if (act === 'pin') { Workstreams.pin(id, !w.pinned); SFX.click(); renderRail(); persist(); return; }
    if (act === 'export-md') { exportSession(id, 'markdown'); return; }
    if (act === 'export-json') { exportSession(id, 'json'); return; }
    if (act === 'archive') {
      const wasActive = (id === Workstreams.activeId());
      const nowArchived = !w.archived, label = w.title || 'General';
      if (!Workstreams.archive(id, nowArchived)) { SFX.bad(); return; }
      SFX.close();
      if (wasActive && Workstreams.activeId() !== id) loadActiveStream();   // archiving the OPEN stream falls back to General
      renderRail(); persist();
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify((nowArchived ? 'archived ' : 'restored ') + '“' + label + '”', '', undefined, { transient: true });
    }
  }
  function deleteWorkstream(id) {
    const w = Workstreams.get(id); const label = w ? (w.title || 'General') : '';
    const agentId = w ? (w.agentId || 'agent') : 'agent';
    // Recheck after the destructive-confirmation click: a session may have started while its menu was open.
    if (w && typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(id)) {
      SFX.bad();
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('stop this session before deleting it', 'bad');
      return false;
    }
    const wasActive = (id === Workstreams.activeId());
    if (!Workstreams.del(id)) { SFX.bad(); return false; }
    SFX.bad();
    if (wasActive) loadActiveStream();   // deleting the OPEN stream falls back to General
    renderRail(); persist();
    // a deliverable session ('workshop-<runId>'): deleting it is the Commander's final verdict on the
    // build too — discard the still-pending deliverable server-side so it can't return next restart.
    // The Workstreams tombstone already guarantees the ROW never re-forms even if this write fails.
    if (String(id).indexOf('workshop-') === 0 && typeof WorkshopStore !== 'undefined' && WorkshopStore.discardIfPending) {
      WorkshopStore.discardIfPending(agentId, String(id).slice('workshop-'.length)).catch(() => {});
    }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('deleted “' + label + '”', 'warn', undefined, { transient: true });
    return true;
  }
  // re-open whatever the store now treats as active (after archive/delete bumps the open stream to General)
  function loadActiveStream() {
    const a = Workstreams.active(); if (!a) return;
    focusAgent(a.agentId || 'agent'); Chat.load(a); refreshUsage();
  }
  // RENAME in place: the row title becomes an input. Enter / blur commits, Esc cancels. An empty commit
  // on a normal stream is treated as cancel (so it can never collapse into a stray second "General"); the
  // real General stays title=null. rename() locks titleAuto so the one-shot auto-title can't later stomp it.
  function beginRenameRow(id) {
    const ul = el('workstreams'); if (!ul) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
    const li = ul.querySelector('.ws-row[data-id="' + sel + '"]'); if (!li) return;
    const titleSpan = li.querySelector('.ws-title'); if (!titleSpan || li.querySelector('.ws-rename')) return;
    const w = Workstreams.get(id); if (!w) return;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'ws-rename'; input.maxLength = 80;
    input.value = w.title || ''; input.placeholder = 'General';
    li.classList.add('renaming');
    titleSpan.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      let changed = false;
      if (save) {
        const v = input.value.trim();
        if (v || id === Workstreams.generalId()) changed = Workstreams.rename(id, v);   // empty on a normal stream = cancel
      }
      if (changed) {
        SFX.click(); persist();
        if (id === Workstreams.activeId() && typeof Chat !== 'undefined' && Chat.load) { const a = Workstreams.active(); if (a) Chat.load(a); }   // refresh the COMMS header title
      }
      renderRail();
    };
    input.addEventListener('click', e => e.stopPropagation());   // don't switch the stream while editing its name
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }
  // the archived reveal: a QUIET footer line at the END of the sessions list (the rail head stays
  // SESSIONS/PROJECTS + NEW, nothing else). Shown only when ≥1 stream is archived; flips the rail
  // between hiding and revealing them (revealed rows are dimmed and offer Unarchive in their menu).
  // It lives inside #workstreams, so the PROJECTS view hides it for free.
  function updateArchivedToggle() {
    const ul = el('workstreams'); if (!ul) return;
    const old = ul.querySelector('.ws-arch-row'); if (old) old.remove();
    let n = 0; for (const w of Workstreams.list({ includeArchived: true })) if (w.archived) n++;
    if (!n) { railShowArchived = false; return; }
    const li = document.createElement('li');
    li.className = 'ws-arch-row' + (railShowArchived ? ' on' : '');
    li.textContent = railShowArchived ? '▾ hide archived' : '▸ ' + n + ' archived';
    li.title = railShowArchived ? 'hide archived sessions' : 'show ' + n + ' archived session' + (n === 1 ? '' : 's');
    li.onclick = toggleArchived;
    ul.appendChild(li);
  }
  function toggleArchived() { railShowArchived = !railShowArchived; SFX.click(); renderRail(); }

  /* ---------- PROJECTS rail view (NS-5c → ref-parity drill-in): SESSIONS ↔ PROJECTS toggle ----------
     The same rail, a second face — and its OWN organizational space, never a launcher that bounces you back to
     SESSIONS. Two levels, mirroring the reference harness's project scope:
       · OVERVIEW (projScope null): every blessed project root (GET /api/projects joined against the live grant),
         each with a session-count chip + compact preview sub-rows. Clicking a project ENTERS it — no session
         opens, no tab flips.
       · ENTERED (projScope = root): a breadcrumb back-row, then the project's sessions as FULL rail rows (same
         dot/busy/unread vocabulary as the sessions rail — they are real workstreams). + NEW starts a session
         ANCHORED to this project (projectRoot rides every run as the working folder); opening a session keeps
         the rail right here. A blessed:false row still renders as REVOKED, never hidden (truthful telemetry).
     ADD (overview) blesses a typed/picked folder through the SAME machinery as conversational trust. */
  let railView = 'sessions';   // 'sessions' | 'projects'
  // the entered-project scope (null = overview). Persisted like the reference harness's projectScope, so a reload lands back
  // inside the project you were organizing — pure view state, deliberately outside the world save.
  let projScope = null;
  // Last response the sidecar actually confirmed. A failed refresh must never become an authoritative empty
  // ledger or erase an entered scope; keep rendering this snapshot with an explicit stale warning instead.
  let lastConfirmedProjects = null;
  // A remembered project root is not necessarily still trusted. Default false on reload/entry and only
  // enable scoped session creation after GET /api/projects proves the current row is still blessed.
  let projScopeBlessed = false;
  try { projScope = localStorage.getItem('starnet.projscope') || null; } catch (_) {}
  function setProjScope(root, blessed) {
    projScope = root || null;
    projScopeBlessed = !!(projScope && blessed === true);
    try { if (root) localStorage.setItem('starnet.projscope', root); else localStorage.removeItem('starnet.projscope'); } catch (_) {}
    updateProjHeadAction();
  }
  // the projects-view head action is contextual: overview blesses a folder (+ ADD), an entered project starts
  // a session in it (+ NEW) — one slot, two labelled truths, same as the reference harness's scoped "+".
  function updateProjHeadAction() {
    const b = el('ws-addproject'); if (!b) return;
    if (projScope) {
      b.textContent = '+ NEW';
      b.disabled = !projScopeBlessed;
      b.title = projScopeBlessed ? 'start a new session in this project' : 're-add this project before starting new work';
    } else {
      b.textContent = '+ ADD';
      b.disabled = false;
      b.title = 'bless a folder as a trusted project';
    }
  }
  function setRailView(view) {
    view = (view === 'projects') ? 'projects' : 'sessions';
    if (view === railView) return;
    railView = view;
    SFX.click();
    const pan = (typeof Projects !== 'undefined') ? Projects.panels(view) : { sessionsList: view === 'sessions', projectsList: view === 'projects', newBtn: view === 'sessions', addBtn: view === 'projects' };
    const set = (id, show) => { const e = el(id); if (e) e.hidden = !show; };
    const search = el('ws-search'), searchActive = view === 'sessions' && !!(search && search.value.trim());
    set('ws-rail-search', pan.sessionsList);   // search is a SESSIONS-view affordance; PROJECTS hides it with the list
    set('workstreams', pan.sessionsList && !searchActive);
    set('projects', pan.projectsList);
    set('ws-new', pan.newBtn);
    set('ws-addproject', pan.addBtn);
    { const ts = el('ws-tab-sessions'), tp = el('ws-tab-projects');
      if (ts) { ts.classList.toggle('on', view === 'sessions'); ts.setAttribute('aria-selected', view === 'sessions'); }
      if (tp) { tp.classList.toggle('on', view === 'projects'); tp.setAttribute('aria-selected', view === 'projects'); } }
    closeProjectMenu();
    if (view === 'projects') { updateProjHeadAction(); renderProjects(); }
    else { updateArchivedToggle(); }   // sessions view: ARCHIVED button re-asserts its own "≥1 archived" gate
  }
  function enterProject(root, blessed) { setProjScope(root, blessed); SFX.click(); renderProjects(); }
  function exitProjectScope() { setProjScope(null, false); SFX.click(); renderProjects(); }
  // the live dot class + git badge for one project row (pure read of the shaped row)
  function projDot(r) { return 'ws-dot ' + (!r.blessed ? 'proj-plain' : (r.isGitRepo ? 'proj-git' : 'proj-plain')); }
  function renderProjectRows(ul, rows) {
    if (projScope) {
      // entered scope: the project may have been forgotten/renamed under us — fall back to the overview
      // honestly instead of rendering a ghost. This runs only against a confirmed server snapshot.
      const row = rows.filter(r => Projects.sameRoot && Projects.sameRoot(r.root, projScope))[0] || null;
      if (!row) { setProjScope(null); return renderProjectsOverview(ul, rows); }
      projScopeBlessed = row.blessed === true;
      updateProjHeadAction();
      return renderProjectEntered(ul, row);
    }
    renderProjectsOverview(ul, rows);
  }
  function renderProjectsUnavailable(ul) {
    if (!lastConfirmedProjects) {
      ul.innerHTML = '<li class="proj-empty" role="status">Could not load projects. Reload to reconnect.</li>';
      return;
    }
    renderProjectRows(ul, lastConfirmedProjects);
    const warning = document.createElement('li');
    warning.className = 'proj-empty';
    warning.setAttribute('role', 'status');
    warning.textContent = 'Could not refresh projects — showing the last confirmed list. Reload to reconnect.';
    ul.insertBefore(warning, ul.firstChild);
  }
  function renderProjects() {
    const ul = el('projects'); if (!ul) return;
    ul.innerHTML = '<li class="proj-empty">loading projects…</li>';
    fetch('/api/projects', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('projects unavailable'); return r.json(); })
      .then(j => {
        if (railView !== 'projects') return;   // toggled away while the fetch was in flight
        if (!j || !Array.isArray(j.projects)) throw new Error('invalid projects response');
        const rows = (typeof Projects !== 'undefined') ? Projects.toRows(j.projects, Date.now()) : [];
        lastConfirmedProjects = rows;
        renderProjectRows(ul, rows);
      })
      .catch(() => { if (railView === 'projects') renderProjectsUnavailable(ul); });
  }
  // sessions attached to one project — the REAL stored w.projectRoot link, never a title guess.
  function projSessionsOf(root) {
    try { return (Projects.sessionsFor ? Projects.sessionsFor(root, Workstreams.all(), Date.now()) : []); } catch (_) { return []; }
  }
  /* OVERVIEW: one row per blessed root (+ count chip + compact preview sub-rows). Click = ENTER the project. */
  function renderProjectsOverview(ul, rows) {
    if (!rows.length) {
      ul.innerHTML = '<li class="proj-empty proj-empty-hero"><span class="pe-glyph" aria-hidden="true">▦</span>' +
        '<b>NO TRUSTED PROJECTS</b>' +
        '<span>+ ADD blesses a folder, or tell an agent to “work in C:\\path\\to\\project”.</span></li>';
      return;
    }
    const activeId = Workstreams.activeId();
    ul.innerHTML = rows.map(r => {
      const tip = (r.blessed ? '' : 'REVOKED (trust withdrawn) — ') + 'click to open this project · right-click for actions';
      const sess = projSessionsOf(r.root);
      const extra = Math.max(0, sess.length - 3);
      return '<li class="ws-row proj-row' + (r.blessed ? '' : ' proj-revoked') + '" data-root="' + U.esc(r.root) + '" tabindex="0" role="button" aria-label="' + U.esc(r.name + ' project' + (r.blessed ? '' : ', access revoked') + '; Enter to open; Shift+F10 for actions') + '" aria-keyshortcuts="Shift+F10" title="' + U.esc(tip) + '">' +
        '<span class="' + projDot(r) + '"></span>' +
        '<span class="proj-main">' +
          '<span class="proj-line">' +
            '<span class="ws-title">' + U.esc(r.name) + '</span>' +
            (r.blessed && r.isGitRepo ? '<span class="proj-git-badge" aria-hidden="true">git</span>' : '') +
            (r.blessed ? '<span class="ws-meta">' + U.esc(r.rel) + '</span>' : '<span class="proj-tag">REVOKED</span>') +
            '<button class="ws-kebab" tabindex="-1" aria-label="project actions" title="project actions">⋯</button>' +
          '</span>' +
          '<span class="proj-line">' +
            '<span class="proj-path">' + U.esc(r.path) + '</span>' +
            (sess.length ? '<span class="proj-sess-n">' + sess.length + ' session' + (sess.length === 1 ? '' : 's') + '</span>' : '') +
          '</span>' +
        '</span>' +
        '</li>' +
        sess.slice(0, 3).map(s =>
          '<li class="proj-sess' + (s.id === activeId ? ' on' : '') + '" data-ws="' + U.esc(s.id) + '" data-root="' + U.esc(r.root) + '" tabindex="0" role="button" aria-label="' + U.esc(s.title + ' session; Enter to open') + '"' + (s.id === activeId ? ' aria-current="true"' : '') + ' title="open this session">' +
            '<span class="ws-title">' + U.esc(s.title) + '</span>' +
            '<span class="ws-meta">' + U.esc(s.rel) + '</span>' +
          '</li>').join('') +
        (extra ? '<li class="proj-sess proj-more" data-root="' + U.esc(r.root) + '" tabindex="0" role="button" aria-label="Open ' + extra + ' more session' + (extra === 1 ? '' : 's') + ' in ' + U.esc(r.name) + '" title="open this project">▸ ' + extra + ' more session' + (extra === 1 ? '' : 's') + '</li>' : '');
    }).join('');
    // preview sub-row click: open the session AND follow it into its project scope — the rail stays in PROJECTS.
    // The overflow "▸ N more" row just enters the project (where every session renders as a full row).
    ul.querySelectorAll('.proj-sess').forEach(li => {
      li.onclick = (e) => {
        e.stopPropagation();
        const id = li.dataset.ws;
        if (id) {
          if (id !== Workstreams.activeId()) switchWorkstream(id);
          SFX.open();
        }
        const row = rows.find(x => Projects.sameRoot && Projects.sameRoot(x.root, li.dataset.root));
        enterProject(li.dataset.root, !!(row && row.blessed));
      };
      li.onkeydown = (e) => { if (e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); li.click(); } };
    });
    ul.querySelectorAll('.proj-row').forEach(li => {
      const row = rows.find(x => x.root === li.dataset.root);
      li.onclick = () => enterProject(row.root, row.blessed);
      li.onkeydown = (e) => {
        if (e.target !== li) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterProject(row.root, row.blessed); return; }
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const b = li.getBoundingClientRect(); openProjectMenu(row, b.left, b.bottom + 2, li); }
      };
      li.oncontextmenu = (e) => { e.preventDefault(); openProjectMenu(row, e.clientX, e.clientY); };
      const keb = li.querySelector('.ws-kebab');
      if (keb) keb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const b = keb.getBoundingClientRect(); openProjectMenu(row, b.left, b.bottom + 2, keb); };
    });
  }
  /* ENTERED: breadcrumb back-row + project header + this project's sessions as FULL rail rows (they are real
     workstreams — dot/busy/attn/unread reuse the sessions rail's own state readers, truthful by construction).
     Opening a session keeps the rail here; + NEW (head action) starts a session anchored to this folder. */
  function renderProjectEntered(ul, row) {
    const activeId = Workstreams.activeId();
    const sess = projSessionsOf(row.root);
    const byId = {}; try { for (const w of Workstreams.all()) byId[w.id] = w; } catch (_) {}
    let html =
      '<li class="proj-crumb"><button class="proj-back" title="back to all projects">◂ ALL PROJECTS</button></li>' +
      '<li class="ws-row proj-row proj-head' + (row.blessed ? '' : ' proj-revoked') + '" data-root="' + U.esc(row.root) + '" tabindex="0" role="button" aria-label="' + U.esc(row.name + ' project actions; Enter to open actions') + '" aria-keyshortcuts="Shift+F10" title="project actions">' +
        '<span class="' + projDot(row) + '"></span>' +
        '<span class="proj-main">' +
          '<span class="proj-line">' +
            '<span class="ws-title">' + U.esc(row.name) + '</span>' +
            (row.blessed && row.isGitRepo ? '<span class="proj-git-badge" aria-hidden="true">git</span>' : '') +
            (row.blessed ? '' : '<span class="proj-tag">REVOKED</span>') +
            '<button class="ws-kebab" tabindex="-1" aria-label="project actions" title="project actions">⋯</button>' +
          '</span>' +
          '<span class="proj-path">' + U.esc(row.path) + '</span>' +
        '</span>' +
      '</li>';
    if (!sess.length) {
      html += row.blessed
        ? '<li class="proj-empty">No sessions in this project yet — <b>+ NEW</b> starts one working in this folder.</li>'
        : '<li class="proj-empty">Access revoked — re-add this project before starting new work. Existing sessions remain browseable.</li>';
    } else {
      html += sess.map(s => {
        const w = byId[s.id];
        const st = w ? railRowState(w) : { dot: 'ws-dot', meta: s.rel, busy: false, attn: false };
        const cls = w ? rowClass(w, st, activeId) : ('ws-row' + (s.id === activeId ? ' sel' : ''));
        return '<li class="' + cls + ' proj-sess-full" data-ws="' + U.esc(s.id) + '" tabindex="0" role="button" aria-label="' + U.esc(s.title + ' session; Enter to open') + '"' + (s.id === activeId ? ' aria-current="true"' : '') + ' title="' + U.esc(s.title + ' — open this session') + '">' +
          '<span class="' + st.dot + '"></span>' +
          '<span class="ws-title">' + U.esc(s.title) + '</span>' +
          '<span class="ws-meta">' + U.esc(st.meta || s.rel) + '</span>' +
          '</li>';
      }).join('');
    }
    ul.innerHTML = html;
    { const back = ul.querySelector('.proj-back'); if (back) back.onclick = exitProjectScope; }
    { const head = ul.querySelector('.proj-head');
      if (head) {
        head.onkeydown = (e) => {
          if (e.target !== head) return;
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const b = head.getBoundingClientRect(); openProjectMenu(row, b.left, b.bottom + 2, head); }
        };
        head.oncontextmenu = (e) => { e.preventDefault(); openProjectMenu(row, e.clientX, e.clientY); };
        const keb = head.querySelector('.ws-kebab');
        if (keb) keb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const b = keb.getBoundingClientRect(); openProjectMenu(row, b.left, b.bottom + 2, keb); };
      } }
    ul.querySelectorAll('.proj-sess-full').forEach(li => {
      li.onclick = () => {
        const id = li.dataset.ws;
        if (id !== Workstreams.activeId()) switchWorkstream(id);
        SFX.open();
        renderProjects();   // stay HERE — the rail keeps the project scope, only the selection moves
      };
      li.onkeydown = (e) => { if (e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); li.click(); } };
    });
  }
  // + NEW inside an entered project: a fresh untitled session ANCHORED to the project (projectRoot rides every
  // run as the working folder; the title auto-mints from the first message, same as the sessions rail's + NEW).
  function newSessionInProject(root) {
    if (!root || !projScopeBlessed) return;
    const ws = Workstreams.startSession({ activate: false, projectRoot: root });
    if (!ws) return;
    switchWorkstream(ws.id);
    SFX.open();
    renderProjects();   // the new row appears under its project; the rail stays in the entered scope
  }
  // the project row actions menu (reuses the .ws-menu phosphor chrome): Jump in · Remove (revoke trust, arm/confirm).
  let projMenuEl = null, projMenuReturn = null;
  function closeProjectMenu(returnFocus) {
    if (!projMenuEl) return;
    projMenuEl.remove(); projMenuEl = null;
    document.removeEventListener('pointerdown', onProjMenuOutside, true);
    document.removeEventListener('keydown', onProjMenuKey, true);
    window.removeEventListener('blur', closeProjectMenu);
    window.removeEventListener('resize', closeProjectMenu);
    if (returnFocus === true && projMenuReturn && projMenuReturn.isConnected) projMenuReturn.focus();
    projMenuReturn = null;
  }
  function onProjMenuOutside(e) { if (projMenuEl && !projMenuEl.contains(e.target)) closeProjectMenu(); }
  function onProjMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeProjectMenu(true); } }
  function openProjectMenu(r, x, y, origin) {
    closeProjectMenu();
    if (!r) return;
    projMenuReturn = origin || null;
    const menu = document.createElement('div');
    menu.className = 'ws-menu'; menu.setAttribute('role', 'menu');
    const item = (act, label, glyph, cls) =>
      '<button class="ws-menu-item' + (cls ? ' ' + cls : '') + '" role="menuitem" data-act="' + act + '">' +
      '<span class="ws-menu-glyph" aria-hidden="true">' + glyph + '</span>' + U.esc(label) + '</button>';
    let html = '';
    if (r.blessed) {
      if (!projScope || !(Projects.sameRoot && Projects.sameRoot(r.root, projScope))) html += item('open', 'Open project', '▸');
      html += item('newsess', 'New session here', '+');
    }
    html += (r.blessed ? '<div class="ws-menu-sep"></div>' : '') + item('remove', r.blessed ? 'Remove (revoke trust)' : 'Forget (already revoked)', '✕', 'danger');
    menu.innerHTML = html;
    document.body.appendChild(menu);
    // same visual→zoomed-space conversion as openWsMenu (TEXT SIZE).
    const z = U.uiZoom(), rect = menu.getBoundingClientRect();
    const vw = (window.innerWidth || document.documentElement.clientWidth) / z;
    const vh = (window.innerHeight || document.documentElement.clientHeight) / z;
    menu.style.left = Math.max(6, Math.min(x / z, vw - rect.width / z - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y / z, vh - rect.height / z - 6)) + 'px';
    projMenuEl = menu;
    menu.querySelectorAll('.ws-menu-item').forEach(btn => {
      const act = btn.dataset.act;
      if (act === 'remove') {   // destructive → arm on first click, act on a second within 4s
        btn.addEventListener('click', () => {
          if (btn.dataset.armed) { closeProjectMenu(); removeProject(r); return; }
          btn.dataset.armed = '1'; btn.classList.add('armed');
          btn.innerHTML = '<span class="ws-menu-glyph" aria-hidden="true">✕</span>Confirm remove';
          SFX.bad();
          setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('armed'); btn.innerHTML = '<span class="ws-menu-glyph" aria-hidden="true">✕</span>' + (r.blessed ? 'Remove (revoke trust)' : 'Forget (already revoked)'); } }, 4000);
        });
      } else if (act === 'newsess') {
        btn.addEventListener('click', () => { closeProjectMenu(); setProjScope(r.root, r.blessed); newSessionInProject(r.root); });
      } else {
        btn.addEventListener('click', () => { closeProjectMenu(); enterProject(r.root, r.blessed); });
      }
    });
    document.addEventListener('pointerdown', onProjMenuOutside, true);
    document.addEventListener('keydown', onProjMenuKey, true);
    window.addEventListener('blur', closeProjectMenu);
    window.addEventListener('resize', closeProjectMenu);
    { const first = menu.querySelector('.ws-menu-item'); if (first) first.focus(); }
    SFX.click();
  }
  // REMOVE has two explicit stages: a blessed row revokes its standing path:<root> grant, while a row whose trust
  // is already revoked hard-forgets only its projects-store metadata. The server refuses to forget a still-blessed
  // row, so neither endpoint silently does both jobs and every success message describes the state actually changed.
  function removeProject(r) {
    if (!r) return;
    const isForget = !r.blessed;
    const endpoint = isForget ? '/api/projects/forget' : '/api/permissions/revoke';
    const body = isForget ? { root: r.root } : { key: 'path:' + r.root };
    fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(res => res.ok ? res.json() : { ok: false })
      .then(j => {
        SFX.bad();
        if (typeof StationUI !== 'undefined' && StationUI.notify) {
          const success = isForget ? 'forgot “' : 'trust revoked for “';
          const failure = isForget ? 'could not forget “' : 'could not revoke trust for “';
          StationUI.notify((j && j.ok ? success : failure) + r.name + '”', j && j.ok ? 'warn' : 'bad');
        }
        renderProjects();
      })
      .catch(() => { renderProjects(); });
  }
  // ADD A PROJECT: an inline editor row at the top of the projects list — a typed absolute-path field (the honest
  // fallback everywhere) plus a 📁 browse button that opens the REAL OS folder chooser. The picker is served by the
  // sidecar (POST /api/projects/pickfolder — local-first: the sidecar runs on the user's machine, browser and desktop
  // alike); a Tauri starnet_pick_folder command is tried first if the shell ever ships one. Picking fills the input
  // only — Submitting POSTs /api/projects/bless, which blesses through the SAME path-grant machinery as conversational
  // trust (the Add click stays the consent). If no picker exists (headless host), the honest reason lands in the hint
  // and the typed path remains the fallback.
  function tauriCore() { return (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null; }
  // one shared "open the native folder chooser" helper -> Promise<string|null> (null = cancelled/unavailable).
  // onErr(reason) fires ONLY for a real failure/unavailability, never for a user cancel.
  function pickFolderNative(onErr) {
    const core = tauriCore();
    const viaSidecar = () =>
      fetch('/api/projects/pickfolder', { method: 'POST' })
        .then(res => res.json().then(j => ({ ok: res.ok, j })).catch(() => ({ ok: false, j: null })))
        .then(({ ok, j }) => {
          if (ok && j && j.ok && j.path) return String(j.path);
          if (ok && j && j.ok && j.cancelled) return null;
          if (typeof onErr === 'function') onErr((j && j.reason) || 'no folder picker available — type the path instead');
          return null;
        })
        .catch(() => { if (typeof onErr === 'function') onErr('could not reach the station'); return null; });
    if (core && core.invoke) {
      return Promise.resolve(core.invoke('starnet_pick_folder', {}))
        .then(dir => (dir ? String(dir) : null))
        .catch(viaSidecar);   // shell has no picker command — the sidecar's OS dialog is the real path
    }
    return viaSidecar();
  }
  function beginAddProject() {
    if (railView !== 'projects') setRailView('projects');
    const ul = el('projects'); if (!ul) return;
    if (ul.querySelector('.proj-add')) { const inp = ul.querySelector('.proj-add input'); if (inp) inp.focus(); return; }
    const li = document.createElement('li'); li.className = 'proj-add';
    li.innerHTML =
      '<div class="proj-add-head">' +
        '<span class="proj-add-lbl">ADD PROJECT FOLDER</span>' +
        '<button class="proj-add-cancel" title="cancel" aria-label="cancel">✕</button>' +
      '</div>' +
      '<input type="text" spellcheck="false" placeholder="C:\\Users\\you\\project" aria-label="project folder path">' +
      '<div class="proj-add-row">' +
        '<button class="proj-add-pick" title="browse for a folder with the system dialog">BROWSE…</button>' +
        '<button class="proj-add-discover" title="scan common project folders; grants nothing">DISCOVER</button>' +
        '<button class="proj-add-go">ADD</button>' +
      '</div>' +
      '<div class="proj-discover-results" hidden></div>' +
      '<div class="proj-add-hint" hidden></div>';
    ul.insertBefore(li, ul.firstChild);
    const input = li.querySelector('input');
    const hint = li.querySelector('.proj-add-hint');
    const discovered = li.querySelector('.proj-discover-results');
    const showHint = (msg, isErr) => { hint.hidden = !msg; hint.textContent = msg || ''; hint.classList.toggle('err', !!isErr); };
    const cancel = () => { li.remove(); };
    const submit = () => {
      const p = String(input.value || '').trim();
      if (!p) { showHint('enter a folder path', true); input.focus(); return; }
      showHint('blessing…', false);
      fetch('/api/projects/bless', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })
        .then(res => res.json().then(j => ({ ok: res.ok, j })).catch(() => ({ ok: false, j: null })))
        .then(({ ok, j }) => {
          if (ok && j && j.ok) { SFX.open(); if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('added “' + (j.root || p) + '”', '', undefined, { transient: true }); renderProjects(); }
          else { showHint((j && j.reason) || 'could not add that folder', true); SFX.bad(); }
        })
        .catch(() => { showHint('could not reach the station', true); SFX.bad(); });
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
    { const g = li.querySelector('.proj-add-go'); if (g) g.onclick = submit; }
    { const c = li.querySelector('.proj-add-cancel'); if (c) c.onclick = cancel; }
    { const pk = li.querySelector('.proj-add-pick');
      if (pk) pk.onclick = () => {
        if (pk.disabled) return;
        pk.disabled = true;
        showHint('folder picker open — choose in the system dialog…', false);
        pickFolderNative(reason => showHint(reason, true))
          .then(dir => {
            if (dir) { input.value = dir; showHint('', false); }
            else if (!hint.classList.contains('err') || hint.hidden) showHint('', false);   // cancel: clear the "open…" note, keep any real error
          })
          .finally(() => { if (pk.isConnected) pk.disabled = false; input.focus(); });
      };
    }
    { const db = li.querySelector('.proj-add-discover');
      if (db) db.onclick = () => {
        if (db.disabled) return;
        db.disabled = true; showHint('scanning common project folders…', false);
        fetch('/api/projects/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(res => res.json().then(j => ({ ok: res.ok, j })).catch(() => ({ ok: false, j: null })))
          .then(({ ok, j }) => {
            if (!ok || !j || !j.ok) { showHint((j && j.reason) || 'could not discover projects', true); return; }
            const rows = (j.candidates || []).filter(x => x && x.root && !x.blessed).slice(0, 24);
            if (!rows.length) {
              discovered.hidden = true; discovered.innerHTML = '';
              showHint('No ungranted projects found in the common folders. Browse or type a path instead.', false);
              return;
            }
            discovered.innerHTML = rows.map(x => '<button type="button" class="proj-discover-pick" data-path="' + U.esc(x.root) + '"><b>' + U.esc(x.name || x.root) + '</b><span>' + U.esc(x.root) + '</span><em>' + U.esc(x.kind || 'project') + '</em></button>').join('');
            discovered.hidden = false;
            discovered.querySelectorAll('.proj-discover-pick').forEach(b => { b.onclick = () => { input.value = b.dataset.path || ''; showHint('Candidate selected. ADD grants this folder to StarNet.', false); input.focus(); }; });
            showHint('Found ' + rows.length + ' candidate' + (rows.length === 1 ? '' : 's') + '. Select one, then ADD to grant access.' + (j.truncated ? ' Search stopped at its safety limit.' : ''), false);
          })
          .catch(() => showHint('could not reach the station', true))
          .finally(() => { if (db.isConnected) db.disabled = false; });
      };
    }
    input.focus();
    SFX.click();
  }

  // disconnect() — the teardown path: tears down the live game but NEVER wipes data and NEVER lands on a dead
  // title screen — it persists, then re-enters via reentry(): straight back into the station if creds are still
  // in hand, otherwise the RESUME-mode connect screen. The agent is always preserved. (The old user-facing ⏏
  // DISCONNECT topbar button was removed; recovery / resume / error paths still reuse this teardown.)
  function disconnect() { if (typeof Onboarding !== 'undefined' && Onboarding.stop && Onboarding.isRunning && Onboarding.isRunning()) Onboarding.stop(); if (typeof Tutorial !== 'undefined' && Tutorial.teardown) Tutorial.teardown(); if (typeof DockGlow !== 'undefined' && DockGlow.stop) DockGlow.stop(); if (typeof Intake !== 'undefined' && Intake.stop) Intake.stop(); SFX.close(); Chat.abort(); stopRailTicker(); World.stop(); if (World.pauseBridge) World.pauseBridge(); persist(); if (typeof StationUI !== 'undefined') StationUI.leave(); reentry(); }

  /* ---------- first-boot splash ---------- */
  // The key-art boot card: shown ONLY from init()'s first-run branch (no save anywhere), never on
  // resume/recovery/re-entry — a returning Commander must land in their station, not a title card.
  // Any key / click / tap advances into CREATE YOUR OVERSEER. The starfield is a tiny self-owned
  // canvas loop that stops the moment the screen is left (no orphan rAF behind the game).
  let splashRaf = 0;
  function startSplashStars() {
    const cv = el('sp-stars'); if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, stars = [];
    const rgb = () => (getComputedStyle(document.body).getPropertyValue('--ph-rgb').trim() || '255,140,40');
    // draw() is the paint step, deliberately SEPARATE from the rAF loop: it's called directly on seed and on
    // resize so a static starfield is always on screen even when requestAnimationFrame is paused (a
    // backgrounded tab, or a resize that lands before the first frame). rAF only layers the twinkle on top.
    const draw = t => {
      if (!W || !H) return;
      const c = rgb();
      ctx.clearRect(0, 0, W, H);
      for (const st of stars) {
        const a = .22 + .58 * Math.abs(Math.sin(st.p + t * .001 * st.s));
        ctx.fillStyle = 'rgba(' + c + ',' + a.toFixed(3) + ')';
        ctx.fillRect(st.x, st.y, st.r, st.r);
      }
    };
    const seed = () => {
      W = cv.width = cv.clientWidth || window.innerWidth || 1280;
      H = cv.height = cv.clientHeight || window.innerHeight || 720;
      const n = Math.max(90, Math.round((W * H) / 16000));
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() < .88 ? 1 : 2,                        // mostly single-pixel points, a few brights
        p: Math.random() * Math.PI * 2,                        // twinkle phase
        s: .5 + Math.random() * 1.4                            // twinkle speed
      }));
      draw(0);   // setting canvas.width cleared the bitmap — repaint immediately so the field never blanks
    };
    seed();
    // re-seed on resize AND when the tab returns to the foreground (rAF was paused while hidden, and a
    // resize that happened meanwhile left the canvas cleared — repaint on the way back so it isn't blank).
    const onResize = () => seed();
    const onVis = () => { if (!document.hidden) seed(); };
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    cv._spCleanup = () => { window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVis); };
    const tick = t => { draw(t); splashRaf = requestAnimationFrame(tick); };
    tick(0);   // kicks the twinkle loop; draw(0) already left a static field up for the paused-rAF case
  }
  function stopSplashStars() {
    if (splashRaf) { cancelAnimationFrame(splashRaf); splashRaf = 0; }
    const cv = el('sp-stars'); if (cv && cv._spCleanup) { cv._spCleanup(); cv._spCleanup = null; }
  }
  function showSplash() {
    const screen = el('screen-splash');
    if (!screen) { startCreation(); return; }
    show('screen-splash');
    startSplashStars();
    let advanced = false;
    const advance = e => {
      // ignore pure modifier presses so ctrl/alt/cmd chords (devtools, screenshots) don't consume the splash
      if (e && e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      if (advanced) return; advanced = true;
      window.removeEventListener('keydown', advance, true);
      screen.removeEventListener('pointerdown', advance);
      stopSplashStars();
      startCreation();
    };
    window.addEventListener('keydown', advance, true);
    screen.addEventListener('pointerdown', advance);
  }

  /* ---------- creation ---------- */
  // Guarded: a genuine FRESH start (no save) wipes any stale resume pointer and opens CREATE YOUR OVERSEER.
  // But if a resume is mid-flight (resumingSaved set, e.g. recovery), do NOT clear it from here — the connect
  // screen must keep its RESUME binding so a key re-entry continues the saved agent rather than re-speccing one.
  function startCreation() {
    SFX.boot(); SFX.open();
    const hasSave = Save.has() && !!Save.load();
    if (!resumingSaved || !hasSave) resumingSaved = null;
    show('screen-connect'); initConnect();
  }

  // FORWARD-VERSION GATE (P0.3). Raised when the save on this machine (or an adopted durable remote) was written
  // by a NEWER StarNet than this build can read. This is a HARD STOP: it shows the blocking gate screen and
  // returns; NOTHING here calls persist()/Save.write(), so the newer save is never re-stamped or clobbered. The
  // only action re-checks/opens the desktop Update Center when the native updater is present; otherwise it states
  // how to update. gateActive latches so a stray timer/beacon can't route back into a resume/persist path.
  let gateActive = false;
  function showFutureSaveGate(version) {
    gateActive = true;
    try { Chat.abort(); } catch (_) {}
    try { if (World && World.stop) World.stop(); } catch (_) {}
    const v = Number(version) || 0;
    const sub = el('future-sub');
    if (sub) sub.textContent = v ? ('saved format v' + v + ' · this build reads up to v' + Save.CURRENT) : '';
    const msg = el('future-msg');
    const btn = el('btn-future-update');
    const hasUpdater = (typeof Updates !== 'undefined') && (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core);
    if (btn) {
      btn.onclick = async () => {
        SFX.click && SFX.click();
        if (hasUpdater) {
          if (msg) msg.textContent = 'checking for an update…';
          try {
            const snap = await Updates.check(true, 'future-save-gate');
            const phase = (snap && snap.phase) || '';
            // ⛔ ONLY `current` MEANS "NOTHING NEWER IS PUBLISHED". Everything that is not 'available' used to
            // collapse into that one reassuring line — including 'error' (the check FAILED and we told the
            // Commander all was well), 'unsupported' (this build has no updater at all), and 'checking' (a
            // re-click while a check is in flight returns the busy snapshot immediately). This gate is a HARD
            // STOP on a save this build cannot read: a false "check back shortly" strands the user with no
            // idea that the one action on the screen didn't work. Name each state for what it is.
            if (phase === 'available') { try { await Updates.install(); } catch (e) { if (msg) msg.textContent = 'update found, but the install failed — open the Update Center and retry.'; } }
            else if (phase === 'current') { if (msg) msg.textContent = 'no newer build is published yet — check back shortly.'; }
            else if (phase === 'error') { if (msg) msg.textContent = 'the update check failed' + (snap && snap.error ? ' — ' + snap.error : '') + '. Check your connection and try again.'; }
            else if (phase === 'checking' || phase === 'downloading' || phase === 'installing' || phase === 'restarting') { if (msg) msg.textContent = 'an update check is already running — one moment…'; }
            else if (msg) msg.textContent = 'this build cannot check for updates — download the latest StarNet from starnetos.com, then reopen.';
          } catch (_) { if (msg) msg.textContent = 'update check failed — try again in a moment.'; }
        } else if (msg) {
          msg.textContent = 'Update StarNet to the latest version (in the desktop app: Update Center), then reopen.';
        }
      };
    }
    show('screen-future');
  }

  // EL-11 FIX 2 — DAMAGED-SAVE DISCLOSURE GATE: the sidecar quarantined an UNRECOVERABLE durable save (main +
  // .bak both bad) and no usable save exists anywhere else. Without this, boot silently presents the pristine
  // first-run ceremony — weeks of state gone with zero disclosure (the worst kind of app lie). Blocking, honest,
  // and names the forensic copy's path; the single action acks the notice and continues into a fresh station.
  function showSaveRecoveryGate(rec) {
    gateActive = true;
    try { if (World && World.stop) World.stop(); } catch (_) {}
    const p = el('recovery-quarantine-path');
    if (p) p.textContent = (rec && rec.quarantinedTo) ? String(rec.quarantinedTo) : 'the StarNet workspaces folder (look for *.save.json.corrupt-*)';
    const btn = el('btn-recovery-continue');
    if (btn) {
      btn.onclick = async () => {
        SFX.click && SFX.click();
        try { if (typeof CloudSave !== 'undefined' && CloudSave.ackRecovery) await CloudSave.ackRecovery(); } catch (_) {}
        gateActive = false;
        startCreation();
      };
    }
    show('screen-recovery');
  }

  // SAVE-UNKNOWN GATE: no local cache AND the durable mirror could not be READ (sidecar unreachable, or the
  // per-launch auth token was refused). A first-run ceremony here would assert "no save exists" over a
  // possibly-intact durable save (the July-19 "my save got deleted" incident — a 403'd pull rendered genesis
  // over a healthy 200KB save.json). HARD STOP: gate, auto-retry the reconcile until the sidecar answers
  // definitively, then reload so the whole boot (token injection included) starts clean. Never times out into
  // creation — the exits are a definitive answer or the explicit, quarantined START COMPLETELY FRESH path.
  function showSaveUnreachableGate(reason) {
    gateActive = true;
    try { if (World && World.stop) World.stop(); } catch (_) {}
    const sub = el('unreachable-sub');
    if (sub) sub.textContent = reason === 'forbidden' ? 'station service refused this window (stale session) — a relaunch usually clears it' : 'station service not answering';
    const status = el('unreachable-status');
    let attempts = 0, timer = null, checking = false, resetting = false, browserResetBlocked = false, preservedReset = null;
    const setStatus = m => { if (status) status.textContent = '＋ ' + m; };
    const attempt = async () => {
      if (checking || resetting || browserResetBlocked) return;
      checking = true;
      attempts++;
      setStatus('checking… (attempt ' + attempts + ')');
      let r = null;
      try { r = await CloudSave.reconcile(Save.load()); } catch (_) { r = null; }
      // Definitive answer = anything but the unknown sentinel: a real save, a future-save sentinel, or a
      // proven-empty null. Reload rather than resume in place — a stale/refused auth token can only be
      // re-injected by a fresh page load, and reload re-runs every gate in order.
      if (!CloudSave.isUnknownSentinel(r)) {
        if (timer) clearInterval(timer);
        setStatus('reconnected — resuming…');
        try { location.reload(); } catch (_) {}
        return;
      }
      setStatus('still unreachable — retrying every 5s (attempt ' + attempts + '). Your save is untouched.');
      checking = false;
    };
    const btn = el('btn-unreachable-retry');
    if (btn) btn.onclick = () => { SFX.click && SFX.click(); attempt(); };
    // RESTART STATION SERVICE — the desktop shell kills and respawns the sidecar on the same port. This is
    // the exit the retry loop can never reach on its own: a sidecar that is alive-but-wedged, or one that
    // exits before listening on every spawn, answers no poll ever (a macOS user sat at attempt 15+ with no
    // way out, 2026-08-22). Browser mode (no shell) has nothing to restart; the button stays hidden there.
    const core = tauriCore();
    const restartBtn = el('btn-unreachable-restart');
    let restarting = false;
    const restart = async (auto) => {
      if (restarting || resetting || browserResetBlocked || !core || !core.invoke) return;
      restarting = true;
      if (restartBtn) restartBtn.disabled = true;
      setStatus((auto ? 'still unreachable — ' : '') + 'restarting the station service…');
      let up = false;
      try { up = await core.invoke('starnet_restart_sidecar'); } catch (_) { up = false; }
      if (up) { setStatus('station service restarted — reconnecting…'); attempt(); }
      else setStatus('the station service could not be restarted — quit StarNet fully (Cmd+Q / tray → Quit) and open it again. Your save is untouched.');
      restarting = false;
      if (restartBtn) restartBtn.disabled = false;
    };
    if (restartBtn) {
      if (core && core.invoke) { restartBtn.hidden = false; restartBtn.onclick = () => { SFX.click && SFX.click(); restart(false); }; }
      else restartBtn.hidden = true;
    }
    // START COMPLETELY FRESH — unlike the sidecar-backed lineage action, this must work when NO HTTP
    // route answers. The native shell first moves the entire workspace generation to quarantine, seals
    // the new generation against legacy re-migration, and respawns with the same keychain credentials.
    // Only after that durable move succeeds does FreshStart clear browser-owned StarNet state. Two clicks.
    const freshBtn = el('btn-unreachable-fresh');
    if (freshBtn) {
      let armed = false;
      if (core && core.invoke && typeof FreshStart !== 'undefined') {
        freshBtn.hidden = false;
        freshBtn.onclick = async () => {
          SFX.click && SFX.click();
          if (resetting) return;
          const retryingBrowserClear = browserResetBlocked && preservedReset;
          if (!retryingBrowserClear && !armed) {
            armed = true;
            freshBtn.textContent = '✦ CONFIRM — START COMPLETELY FRESH';
            setStatus('your old local station will be moved to a quarantine folder. Your StarNet account link and purchased credits are not removed. Press again to confirm.');
            setTimeout(() => {
              if (armed && !resetting) { armed = false; freshBtn.textContent = '✦ START COMPLETELY FRESH'; }
            }, 12000);
            return;
          }
          armed = false;
          resetting = true;
          freshBtn.disabled = true;
          if (btn) btn.disabled = true;
          if (restartBtn) restartBtn.disabled = true;
          setStatus(retryingBrowserClear ? 'retrying the browser-state clear; the preserved station will not be moved again…' : 'preserving the old station and preparing a clean one…');
          try {
            // Once native preservation has succeeded, a browser-clear retry must reuse that exact receipt.
            // Running the native transaction again would quarantine the new empty generation and obscure the
            // path containing the user's real old station.
            const result = retryingBrowserClear
              ? FreshStart.retryBrowserClear(preservedReset)
              : await FreshStart.resetDesktop(core);
            const where = result.quarantine ? ' Old files were preserved in ' + result.quarantine + '.' : '';
            if (!result.browserDataCleared) {
              resetting = false;
              browserResetBlocked = true;
              preservedReset = result;
              freshBtn.disabled = false;
              freshBtn.textContent = '✦ START COMPLETELY FRESH';
              if (btn) btn.disabled = true;
              if (restartBtn) restartBtn.disabled = true;
              setStatus('the old station was safely preserved, but this window could not clear its browser data. Do not reload. Press START COMPLETELY FRESH again to retry.' + where);
              return;
            }
            browserResetBlocked = false;
            preservedReset = null;
            if (result.listening) {
              setStatus('clean station ready — reopening now. Your account link and purchased credits were kept.' + where);
              try { location.reload(); } catch (_) {}
            } else {
              setStatus('clean station prepared, but the station service is still blocked. Fully quit StarNet and reopen it. Your account link and purchased credits were kept.' + where);
            }
          } catch (error) {
            resetting = false;
            freshBtn.disabled = false;
            freshBtn.textContent = '✦ START COMPLETELY FRESH';
            if (btn) btn.disabled = browserResetBlocked;
            if (restartBtn) restartBtn.disabled = browserResetBlocked;
            setStatus((browserResetBlocked ? 'the clean station is still protected from the uncleared window cache — retry START COMPLETELY FRESH. ' : 'nothing was reset — ') + String(error && error.message || error));
          }
        };
      } else freshBtn.hidden = true;
    }
    // one automatic restart after the polls have clearly failed (≈30s), so the common case heals itself
    // without the user needing to know the button exists. Exactly once — a restart that didn't help must
    // not loop; the copy then tells them what to do.
    let autoRestarted = false;
    timer = setInterval(() => {
      attempt();
      if (!autoRestarted && !resetting && !browserResetBlocked && attempts >= 6 && core && core.invoke) { autoRestarted = true; restart(true); }
    }, 5000);
    show('screen-unreachable');
  }

  // PRIOR-INSTALL LINEAGE GATE: both active save sources are definitively empty, yet the sidecar found bounded
  // evidence in a legacy workspace, a pending migration, the current profile, or a verified update snapshot.
  // This is read-only Recovery Mode: no path reaches startCreation(), and therefore onboarding cannot create a
  // replacement station while prior state remains unaccounted for. Restore uses the existing validated backup
  // importer; retry reloads the entire boot chain after an external/manual recovery.
  function showPriorStateGate(lineage) {
    gateActive = true;
    try { if (World && World.stop) World.stop(); } catch (_) {}
    const rows = lineage && Array.isArray(lineage.evidence) ? lineage.evidence : [];
    const recovery = lineage && lineage.recovery && typeof lineage.recovery === 'object' ? lineage.recovery : {};
    const candidates = Array.isArray(recovery.candidates) ? recovery.candidates : [];
    let selected = recovery.automaticCandidateId || null;
    const box = el('lineage-evidence');
    if (box) {
      const evidenceHtml = rows.slice(0, 8).map(row => {
        const kind = String(row && row.kind || 'prior-state').replace(/-/g, ' ').toUpperCase();
        const root = String(row && row.root || 'local StarNet storage');
        const examples = Array.isArray(row && row.examples) && row.examples.length ? ' · ' + row.examples.slice(0, 4).join(', ') : '';
        return '<div><b>' + U.esc(kind) + '</b> — <code>' + U.esc(root) + '</code>' + U.esc(examples) + '</div>';
      }).join('') || '<div><b>PRIOR STATE MARKER</b> — local StarNet storage</div>';
      const candidateHtml = candidates.map(row => {
        const when = row && row.updatedAt ? new Date(row.updatedAt).toLocaleString() : 'time unavailable';
        const size = row && row.bytes ? Math.max(1, Math.ceil(row.bytes / 1024)) + ' KB' : 'size unavailable';
        const on = !!(row && row.id === selected);
        return '<button class="lineage-candidate' + (on ? ' on' : '') + '" data-candidate-id="' + U.esc(row && row.id || '') + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (row && row.recoverable ? '' : ' disabled') + '>' +
          '<b>' + U.esc(row && row.stationName || 'Prior station') + '</b>' +
          '<span>' + U.esc(row && row.displayRoot || 'local StarNet storage') + '</span>' +
          '<small>' + U.esc(row && row.recoverable ? when + ' · ' + size : row && row.reason || 'unreadable save') + '</small></button>';
      }).join('');
      box.innerHTML = evidenceHtml + (candidateHtml ? '<div class="lineage-candidates" aria-label="Recoverable stations">' + candidateHtml + '</div>' : '');
    }
    const status = el('lineage-status');
    const recover = el('btn-lineage-recover');
    const validCandidates = candidates.filter(row => row && row.recoverable);
    const refreshRecover = () => {
      if (!recover) return;
      recover.hidden = validCandidates.length === 0;
      recover.disabled = !selected;
      recover.textContent = validCandidates.length === 1 ? '⟳ RECOVER AUTOMATICALLY' : '⟳ RECOVER SELECTED STATION';
    };
    if (box) Array.from(box.querySelectorAll('.lineage-candidate')).forEach(btn => {
      btn.onclick = () => {
        selected = btn.getAttribute('data-candidate-id') || null;
        Array.from(box.querySelectorAll('.lineage-candidate')).forEach(other => {
          const on = other === btn; other.classList.toggle('on', on); other.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        refreshRecover();
      };
    });
    refreshRecover();
    if (recover) recover.onclick = async () => {
      if (!selected || recover.disabled) return;
      recover.disabled = true;
      if (status) status.textContent = '＋ staging verified recovery; the prior source will be preserved';
      try {
        const response = await fetch('/api/lineage/recover', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: selected })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.error || 'recovery request refused');
        if (status) status.textContent = result.desktopWillRestart
          ? '＋ recovery accepted — station service restarting now…'
          : '＋ recovery accepted — restart the manual sidecar; this screen will resume automatically';
        const timer = setInterval(async () => {
          try {
            const probe = await fetch('/api/save?agent=agent', { cache: 'no-store' });
            const body = probe.ok ? await probe.json() : null;
            if (body && body.save && body.save.agent) { clearInterval(timer); location.reload(); }
          } catch (_) {}
        }, 1500);
      } catch (error) {
        recover.disabled = false;
        if (status) status.textContent = '＋ recovery paused — ' + String(error && error.message || error);
      }
    };
    const report = el('btn-lineage-report');
    if (report) report.onclick = async () => {
      report.disabled = true;
      if (status) status.textContent = '＋ preparing redacted recovery report…';
      try {
        const response = await fetch('/api/lineage/report', { cache: 'no-store' });
        if (!response.ok) throw new Error('report unavailable');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = 'starnet-recovery-report.json'; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (status) status.textContent = '＋ redacted recovery report exported — no credentials or save contents included';
      } catch (error) {
        if (status) status.textContent = '＋ report export failed — ' + String(error && error.message || error);
      } finally { report.disabled = false; }
    };
    const retry = el('btn-lineage-retry');
    if (retry) retry.onclick = () => { SFX.click && SFX.click(); try { location.reload(); } catch (_) {} };
    const restore = el('btn-lineage-restore');
    if (restore) restore.onclick = () => {
      SFX.click && SFX.click();
      const input = el('file-import');
      if (input) { input.value = ''; input.click(); }
    };
    // START FRESH — the third exit. When nothing here is recoverable (a first run whose overseer never woke,
    // then a manual reset — 2026-08-22 report) RESTORE is dead and RETRY loops forever; this is the way out.
    // Sidecar-backed: prior state is MOVED to a quarantine folder (never deleted) and external evidence is
    // acknowledged, then the station service restarts into clean onboarding. Two clicks, never one.
    const freshBtn = el('btn-lineage-fresh');
    if (freshBtn) {
      let armed = false;
      freshBtn.onclick = async () => {
        SFX.click && SFX.click();
        if (!armed) {
          armed = true;
          freshBtn.textContent = '✦ CONFIRM — START A NEW STATION';
          if (status) status.textContent = validCandidates.length
            ? '＋ a recoverable station exists above — START FRESH sets it aside in a quarantine folder (nothing is deleted). Press again to confirm.'
            : '＋ nothing here is recoverable. START FRESH moves the leftover files to a quarantine folder (nothing is deleted) and opens a new station. Press again to confirm.';
          setTimeout(() => { if (armed) { armed = false; freshBtn.textContent = '✦ START FRESH'; } }, 12000);
          return;
        }
        armed = false;
        freshBtn.disabled = true;
        if (status) status.textContent = '＋ setting prior state aside…';
        try {
          const response = await fetch('/api/lineage/start-fresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.ok) throw new Error(result.error || 'start-fresh request refused');
          if (status) status.textContent = (result.moved && result.moved.length ? '＋ ' + result.moved.length + ' file(s) set aside in ' + result.quarantine + ' — ' : '＋ ') +
            (result.desktopWillRestart ? 'station service restarting — opening your new station…' : 'restart the manual sidecar; this screen will continue automatically');
          // poll until the respawned sidecar answers, then reload: boot re-runs every gate and, with the
          // evidence gone, lands on the first-run ceremony.
          const timer = setInterval(async () => {
            try {
              const probe = await fetch('/api/lineage', { cache: 'no-store' });
              const body = probe.ok ? await probe.json() : null;
              if (body && body.lineage && body.lineage.priorInstallEvidence === false) { clearInterval(timer); location.reload(); }
            } catch (_) {}
          }, 1500);
        } catch (error) {
          freshBtn.disabled = false; freshBtn.textContent = '✦ START FRESH';
          if (status) status.textContent = '＋ could not start fresh — ' + String(error && error.message || error);
        }
      };
    }
    show('screen-lineage');
  }

  /* ---------- boot ---------- */
  async function init() {
    if (Harness.init) await Harness.init();   // desktop: load the keychain "configured?" flag first
    if (typeof StationUI !== 'undefined') StationUI.init();   // applies saved theme/CRT settings, wires the bottom bar
    if (typeof Updates !== 'undefined' && typeof StationUI !== 'undefined') Updates.init({ notify: StationUI.notify, rerender: StationUI.rerender });

    /* EXTENSIONS AWAITING APPROVAL. Hooks and plugins are opt-in by design: an unapproved one is silently
       inert. That is the correct security posture and the worst possible UX if it is never surfaced — the
       Commander writes a hook, nothing happens, and there is nothing on screen that says why. So the gate
       announces itself through the SAME channel an agent's approval prompt uses (category 'needsApproval', so
       the existing mute honors it), and clicking lands directly on the tab that resolves it. Fire-and-forget:
       a station with no extensions is the common case and must stay completely silent. */
    (async () => {
      try {
        const [h, p] = await Promise.all([
          fetch('/api/hooks').then(r => r.ok ? r.json() : null).catch(() => null),
          fetch('/api/plugins').then(r => r.ok ? r.json() : null).catch(() => null)
        ]);
        const waiting = ((h && h.pending) || []).length + (((p && p.plugins) || []).filter(x => x && x.pending).length);
        if (!waiting || typeof StationUI === 'undefined' || !StationUI.notify) return;
        StationUI.notify(
          waiting + ' extension' + (waiting === 1 ? '' : 's') + ' awaiting your approval — click to review',
          'warn', 'needsApproval',
          { onClick: () => { try { StationUI.openTerm('connectors', 'extensions'); } catch (_) {} } }
        );
      } catch (_) { /* a station that cannot answer is a station with nothing to approve yet */ }
    })();
    // (the title screen — RESUME / NEW STATION / the destructive NEW AGENT wipe — is gone; boot auto-resumes,
    //  see the three-way at the foot of init(). Re-entry is handled by reentry()/startCreation().)

    // data portability — the safety net for the localStorage-fragile agent. Export bundles nonsecret
    // starnet.* records + a memory snapshot into one file; import restores them on any browser.
    const dataStatus = m => { const n = el('data-status'); if (n) n.textContent = m || ''; };
    el('btn-export').onclick = async () => {
      SFX.click(); dataStatus('exporting…');
      const r = await Backup.exportAll();
      dataStatus(r && r.ok
        ? 'saved ' + r.file + ' — secrets excluded; ' + r.records + ' records' + (r.notes ? ' + ' + r.notes + ' memories' : '')
        : 'export failed');
    };
    const fileImport = el('file-import');
    el('btn-import').onclick = () => { SFX.click(); fileImport.value = ''; fileImport.click(); };
    fileImport.onchange = async () => {
      const f = fileImport.files && fileImport.files[0];
      if (!f) return;
      const r = await Backup.importFile(f);
      // bad(), not a bespoke error() — that cue never existed, so the `&&` guard silently swallowed
      // the only audible signal a restore had failed. bad() is the station's negative-outcome voice.
      if (!r.ok) { dataStatus('import failed — ' + r.error); SFX.bad(); return; }
      SFX.boot();
      const mem = (typeof r.memoriesRestored === 'number') ? r.memoriesRestored
        : (r.memories ? r.memories + ' in file' : 0);
      dataStatus('restored ' + (r.agentName || 'agent') + ' — ' + (r.records == null ? r.keys : r.records) + ' records'
        + (mem ? ' + ' + mem + ' memories' : ''));
      gateActive = false;
      reentry();   // resume straight into the restored agent (or its RESUME screen if creds are still missing)
    };

    // FORWARD-VERSION GATE (P0.3), step 1 — the LOCAL cache. Save.load() returns null for a future save (so no
    // call site can adopt/re-save it), which would otherwise look like "no save" here and fall through to a fresh
    // create that clobbers the newer save on first persist(). Check the honest status BEFORE reconcile and stop:
    // the gate returns without ever touching the stored doc.
    const localStatus = Save.loadStatus ? Save.loadStatus() : { status: (Save.load() ? 'ok' : 'none'), version: 0 };
    if (localStatus.status === 'future') { showFutureSaveGate(localStatus.version); return; }

    // durable restore: adopt whichever of {localStorage cache, sidecar mirror} is NEWER. This is what brings
    // the agent back after a browser-cache wipe (local gone, the sidecar still holds it) and refreshes the
    // cache to match. Best-effort: an unreachable sidecar just falls back to the local cache.
    if (typeof CloudSave !== 'undefined') CloudSave.installUnloadFlush();
    const saved = (typeof CloudSave !== 'undefined') ? await CloudSave.reconcile(Save.load()) : Save.load();
    // FORWARD-VERSION GATE (P0.3), step 2 — a durable REMOTE from a newer build. reconcile() refuses to adopt it
    // into the cache and hands back a future-save sentinel instead of a resumable doc. Same hard stop: gate, return,
    // nothing persists.
    if (typeof CloudSave !== 'undefined' && CloudSave.isFutureSentinel && CloudSave.isFutureSentinel(saved)) {
      showFutureSaveGate(saved.version); return;
    }
    // SAVE-UNKNOWN GATE — no local cache and the durable side could not be read. NEVER fall through to the
    // first-run ceremony on an unproven "no save"; hold at the reconnecting gate until the sidecar answers.
    if (typeof CloudSave !== 'undefined' && CloudSave.isUnknownSentinel && CloudSave.isUnknownSentinel(saved)) {
      showSaveUnreachableGate(saved.reason); return;
    }
    // EL-11 FIX 2/3 — the sidecar's save store quarantined a damaged durable save, or restored one from .bak.
    // The user must LEARN that (reconcile()'s pull captured the persisted marker). Two honesty tiers:
    //   • no usable save anywhere + an unrecoverable quarantine → BLOCKING disclosure BEFORE any genesis ceremony;
    //   • a usable save exists (local cache intact / .bak recovery) → one non-blocking notice after boot, then ack.
    const recovery = (typeof CloudSave !== 'undefined' && CloudSave.recoveryNotice) ? CloudSave.recoveryNotice() : null;
    if (recovery && recovery.kind === 'quarantined' && !(saved && saved.agent)) {
      showSaveRecoveryGate(recovery); return;
    }
    if (recovery) {
      const line = (recovery.kind === 'recovered')
        ? 'Recovered your save from its backup copy — the main save file was damaged. Nothing to do; this is just the honest record.'
        : 'The durable backup of your save was damaged and could not be recovered — a copy was kept at ' +
          (recovery.quarantinedTo || 'the workspaces folder') + '. Your local save is intact and is re-seeding the backup now.';
      // after the station is up (resume/connect below) so the notice lands in the real NOTIFICATIONS record.
      setTimeout(() => {
        try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(line, recovery.kind === 'recovered' ? 'warn' : 'bad'); } catch (_) {}
        try { if (typeof CloudSave !== 'undefined' && CloudSave.ackRecovery) CloudSave.ackRecovery(); } catch (_) {}
      }, 1500);
    }
    // restore the provider BEFORE the credential check so a codex agent (tokens server-side) jumps straight
    // in after a wipe/origin-reset instead of being misrouted to an OpenRouter key prompt.
    if (saved && saved.prov && Harness.setProv) Harness.setProv(saved.prov);
    if (saved && saved.reasoningEffort && Harness.setReasoningEffort) Harness.setReasoningEffort(saved.reasoningEffort);
    if (saved && saved.agent) {
      // AUTO-RESUME: a saved station goes STRAIGHT back into the world when creds are available — an OpenRouter
      // key in hand, the desktop keychain holds one (configured, incl. the DEV fast-path), OR the Codex provider
      // (OAuth tokens live server-side; a missing/expired one surfaces as a run error that prompts re-sign-in).
      // NEVER gate reaching the floor on the model catalog: listModels() proxies a LIVE external OpenRouter fetch
      // and if that is slow/blocked, awaiting it here strands boot on the connect screen forever (the seeded DEV
      // shoot regression). The catalog is cosmetic for resume (dropdown/pricing/context gauge), so fire it in the
      // BACKGROUND and enter the station immediately — pricing fills in a beat later, the floor never waits.
      const canResume = !!(Harness.getKey() || (Harness.configured && Harness.configured()) || Harness.getProv() === 'codex');
      if (canResume) {
        if (Harness.getProv && Harness.getProv() !== 'codex' && Harness.listModels) { Promise.resolve(Harness.listModels()).catch(() => {}); }
        resumeInto(saved); return;
      }
      // saved station, but the credentials are gone (cache/origin wipe). RESUME-mode recovery screen: a banner,
      // the model pre-filled, identity locked read-only — the agent is preserved, only the brain re-connects.
      // Here the model dropdown DOES want the catalog, but bound the wait so a hung network can't strand the
      // recovery screen either — a timeout just yields an empty dropdown the Commander can still type a slug into.
      if (Harness.getProv && Harness.getProv() !== 'codex' && Harness.listModels) await Harness.listModels();
      resumingSaved = saved;
      show('screen-connect'); initConnect(saved.agent.name, true, saved.agent);
      return;
    }
    // A definitive empty active save is not automatically a first run. If the host proves prior-install
    // lineage elsewhere, hold in read-only Recovery Mode. This check is immediately before showSplash(), so
    // every onboarding path is structurally dominated by it.
    const lineage = (typeof CloudSave !== 'undefined' && CloudSave.lineage) ? CloudSave.lineage() : null;
    if (lineage && lineage.priorInstallEvidence === true) {
      showPriorStateGate(lineage); return;
    }
    // FIRST RUN (no save) — the key-art boot splash, then PRESS ANY KEY → CREATE YOUR OVERSEER.
    showSplash();
  }
  init();

  // crewCount: the live crew size (hero + summoned minds) — read by the quest log's station arc.
  // agentName/heroId (G1b): the station-quest generator names the acting agent from the LIVE roster
  // (never an id in the UI) and keys its standing candidates against the focused hero.
  // currentAgent/agents/applyConfig (slash-plan): the slash-command suite reads/writes the live roster
  // and per-agent config (/agents, /model, /personality, …).
  return { show, refreshUsage, persist, pushRoster, refreshRail: renderRail, openWorkstream, summonAgent, summonForRequest, crewCount: () => agents.size,
    agentName: id => { const a = agents.get(id); return a ? (a.name || a.id) : null; },
    // WORK LINES: a downstream stage runs as ANOTHER agent, so the chat host needs THAT agent's composed
    // prompt — never the focused one's. Read-only; null for an id that is not on the live roster.
    systemFor: id => { const a = agents.get(id); return a ? (a.systemPrompt || '') : null; },
    heroId: () => (agent ? agent.id : 'agent'),
    currentAgent: () => agent,
    agents: () => liveAgents().map(serializeAgentLite),
    selectAgent: selectAgent,   // COMMS top-bar agent selector: switch to (or mint) a workstream bound to agentId
    // THE POST-SUMMON DESK STEP, owned by the session (chat.js maybeDeskPrompt): the read that decides whether a
    // stream still owes its agent a workstation, and the door its chip opens (REFIT, armed on WORKSTATIONS).
    needsWorkstation: needsWorkstation,
    openDeskPlacement: openDeskPlacement,
    openSummonBay: openSummonBay,   // adaptive-recruitment beat: accepting the recruit nudge deep-links into the bay's summon flow
    openClassDossier: openClassDossier,   // intent-offer beat: accepting a class offer opens the bay ON that class's dossier
    openRecipeLaunch: openRecipeLaunch,   // routine-nudge beat (lane D): accepting deep-links into the recipe's SCHEDULE IT form
    applyConfig: applyAgentConfig,
    setApproval: setAgentApproval,
    setExecutionProfile: setAgentExecutionProfile };
})();
