/* STARNET — windows/connectors.js : the TOOLSETS & CONNECTORS window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface
   (esc/sfx/notify/fmtRel, mountConsole, and openSignIn for catalog OAuth flows). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const esc = H.esc, sfx = H.sfx, notify = H.notify, fmtRel = H.fmtRel;
  const mountConsole = H.mountConsole, openSignIn = H.openSignIn;

  // CATALOG DEEP-LINK (tutorial lane 2, 2026-08-22): StationUI.connectorJump(id) opens ABILITIES on the CATALOG
  // rail and scrolls/flashes that connector's card (the same cc-jump flash the ▸ VIA action uses) — the
  // Commander still presses the card's OWN ▸ SIGN IN, so the existing OAuth path stays the only door. The id
  // parks here until ccRefresh has rendered the cards (the window builds async).
  let ccJumpPending = null;
  function ccFlash(target) {
    for (let p = target.parentElement; p; p = p.parentElement) { if (p.tagName === 'DETAILS') p.open = true; }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('cc-jump'); void target.offsetWidth;
    target.classList.add('cc-jump');
    setTimeout(() => target.classList.remove('cc-jump'), 2500);
  }
  StationUI.connectorJump = function (id) {
    ccJumpPending = String(id || '') || null;
    if (typeof StationUI.openTerm === 'function') StationUI.openTerm('connectors', 'catalog');
  };

  /* ============== CONNECTORS — attach MCP servers so agents gain external tools ==============
     A connector is a remote MCP (Model Context Protocol) server. Once added + connected, its tools
     become real agent tools, gated by the same consent prompt as everything else. The server URL +
     optional bearer token are stored by the sidecar (never displayed) via /api/connectors. */
  function buildConnectors(body) {
    // CONSOLE MODE: TOOLSETS & CONNECTORS. TOOLSETS (first) is the standard organized surface — one CRT
    // pill-switch row per capId FAMILY (web, files, workbench, delegation, studio, memory, jukebox), each a
    // kill-switch layered on object=capability (available = object placed AND toolset enabled). The JUKEBOX row
    // is where Spotify now lives (the connect flow is hosted inline, all sp-* ids intact). MCP CONNECTORS (second)
    // is the pre-existing generic manager, unchanged except each row gains a per-connector ENABLE pill.
    // mountConsole appends its host to `body`, so the existing body.querySelector wiring (setupSpotify, the MCP
    // form/list handlers) resolves against the mounted panes with no rewrite.
    // ---- TOOLSETS pane: rendered async from GET /api/toolsets; the Spotify flow markup is embedded in-line so
    //      the JUKEBOX row can host it (kept verbatim from the old SPOTIFY section, ids unchanged). ----
    const spotifyInline =
      '<div class="ts-spotify" id="ts-spotify">' +
        '<p class="set-about">One-time setup: make a free app at <span class="dim">developer.spotify.com/dashboard</span>, add the redirect URI below to it, paste the Client ID, then connect. ' +
          '<span class="dim">(OAuth PKCE — no client secret is ever stored.)</span></p>' +
        '<div id="sp-status" class="mc-url dim">checking…</div>' +
        '<div class="mc-form">' +
          '<input id="sp-client" class="key-input" placeholder="Spotify Client ID" autocomplete="off" spellcheck="false" maxlength="64">' +
          '<div class="mc-url dim">Redirect URI to whitelist: <code id="sp-redir">…</code></div>' +
          '<div class="mc-acts">' +
            '<button class="bb sm" id="sp-connect">▶ CONNECT SPOTIFY</button>' +
            '<button class="bb xs danger" id="sp-disconnect" style="display:none">✕ DISCONNECT</button>' +
          '</div>' +
        '</div>' +
        '<div id="sp-msg" class="msg" role="status" aria-live="polite"></div>' +
      '</div>';
    // NO LEAD PARAGRAPH HERE. mountConsole already prints this section's `desc` as `.con-sec-desc`
    // directly above, and this pane used to follow it with a second sentence saying the same thing in
    // different words ("Every capability your agents can use, grouped and switchable…" then "Every
    // capability your agents can use, grouped into toolsets…"). Every pane in this console had the same
    // stutter. The `desc` is the one that stays — it is also what the search box matches on.
    const secToolsets =
      '<label class="mc-hint" for="ts-agent">Capabilities for agent</label><select id="ts-agent" class="key-input" aria-label="Capabilities for agent"></select>' +
      '<button class="bb xs" id="ts-refresh" type="button">REFRESH AUTHORITY</button>' +
      '<div id="ts-authority" class="set-about" role="status"></div>' +
      '<div class="ts-core set-row"><span class="ts-glyph" aria-hidden="true">◉</span>' +
        '<span class="ts-main"><span class="ts-name">COMPUTE <span class="ts-core-tag">CORE</span></span>' +
        '<span class="ts-desc dim">The compute gate — an agent can always think. Always on.</span></span></div>' +
      '<div id="ts-list"><span class="loading pulse">loading toolsets…</span></div>';
    // ---- CONNECTORS pane markup (unchanged generic MCP manager) ----
    // The lead sentence that used to open this pane restated the section `desc` verbatim; only the two
    // asides were load-bearing, so only they remain. The CHANNELS pointer earns its place because
    // "connect Slack" is genuinely ambiguous — tools-INTO-the-agent lives here, chat-FROM-Slack does not.
    const secMcp =
      // No ✉ in the prose: a symbol glyph falls back to a non-VT323 face, and mid-sentence it took its
      // own line break with it ("That’s ✉ / CHANNELS."). Glyphs stay in glyph SLOTS (the front-door
      // column, the rail), never inside a running sentence.
      // ⛔ "Remote http(s) MCP servers." is a SURFACE LOCATOR for the `manual-mcp-connect` claim in
      // qa/product-perfect/claims.json — the ledger anchors that advertised claim to this exact sentence.
      // A first pass at this paragraph reworded it and turned the claims audit BLOCKED. The claim is
      // still true and still stated, so the honest repair is to keep the canonical phrase here rather
      // than re-point the audit needle at whatever the copy happens to say now.
      '<div id="mc-overview" class="mc-overview" role="status"></div>' +
      '<div id="mc-notices"></div>' +
      '<div id="mc-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      '<details class="mc-adv"><summary>About connected services</summary>' +
        '<p class="set-about">Remote http(s) MCP servers. Secrets are stored locally by the sidecar and never displayed. ' +
        'Looking to chat with your agent <i>from</i> Slack or Telegram instead? That’s the <b>CHANNELS</b> window.</p></details>' +
      '<div class="sec"><span class="sec-l" id="mc-form-h">ADD A CONNECTOR</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<div class="mc-form" id="mc-form">' +
        '<input id="mc-id" class="key-input" placeholder="id — e.g. github (a-z 0-9 _ -)" autocomplete="off" spellcheck="false" maxlength="40">' +
        '<div class="mc-hint">A short handle for this server. Its tools appear to agents as <code>mcp__&lt;id&gt;__&lt;tool&gt;</code>.</div>' +
        '<input id="mc-label" class="key-input" placeholder="label (optional) — e.g. GitHub" autocomplete="off" spellcheck="false">' +
        '<div class="mc-seg" id="mc-transport" role="tablist">' +
          '<button type="button" class="mc-seg-btn active" data-tp="http" role="tab" aria-selected="true">HTTP</button>' +
          '<button type="button" class="mc-seg-btn" data-tp="oauth" role="tab" aria-selected="false">OAUTH</button>' +
          '<button type="button" class="mc-seg-btn" data-tp="stdio" role="tab" aria-selected="false">STDIO (Safe Cell)</button>' +
        '</div>' +
        // ---- HTTP fields ----
        '<div class="mc-tp-fields" data-tp="http oauth">' +
          '<input id="mc-url" class="key-input" placeholder="https://server.example/mcp" autocomplete="off" spellcheck="false">' +
          '<div class="mc-hint">The server’s Streamable-HTTP endpoint. <code>http://</code> is allowed only for localhost.</div>' +
          '<div id="mc-token-fields">' +
            '<input id="mc-token" type="password" class="key-input" placeholder="bearer token (optional)" autocomplete="off" spellcheck="false">' +
            '<div class="mc-hint">Sent as <code>Authorization: Bearer …</code>. Leave blank when editing to keep the saved token.</div>' +
          '</div>' +
          '<div id="mc-oauth-note" class="mc-hint" style="display:none">A secure browser window will open for sign-in. The OAuth grant is stored locally and refreshed automatically.</div>' +
        '</div>' +
        // ---- STDIO fields ----
        // Arbitrary stdio server code is bound to one named agent's persistent Docker Safe Cell.
        '<div class="mc-tp-fields" data-tp="stdio" style="display:none">' +
          '<select id="mc-agent" class="key-input" aria-label="Safe Cell owner"><option value="">loading Safe Cell agents…</option></select>' +
          '<div class="mc-hint" id="mc-agent-hint">The server runs inside this agent’s persistent Safe Cell, never as an interactive host child.</div>' +
          '<input id="mc-command" class="key-input" placeholder="command — e.g. npx" autocomplete="off" spellcheck="false">' +
          '<textarea id="mc-args" class="key-input mc-kv" placeholder="arguments, one per line:&#10;-y&#10;@modelcontextprotocol/server-filesystem&#10;/workspace" spellcheck="false" rows="3"></textarea>' +
          '<input id="mc-cwd" class="key-input" placeholder="container cwd (optional; default /workspace)" autocomplete="off" spellcheck="false">' +
          '<textarea id="mc-env" class="key-input mc-kv" placeholder="environment (optional), one per line:&#10;SERVICE_TOKEN=value" spellcheck="false" rows="2"></textarea>' +
          '<div class="mc-hint">Command and arguments use exact argv with no shell. Secrets stay out of process listings; blank env while editing keeps the saved values.</div>' +
        '</div>' +
        // FOLDED, NOT REMOVED. Adding a server needs an id and a URL; custom headers and a hand-set
        // timeout are power-user fields, and stacked open they made the common path look like a
        // six-field form. Both keep their ids, so edit-prefill and the add handler are unchanged.
        // (Deliberately NOT `open` by default — unlike the CHANNELS setup guide, which is instructions
        // needed at exactly the moment it was folded away, these are settings almost nobody sets.)
        '<details class="mc-adv"><summary>advanced — custom headers, timeout</summary>' +
          '<textarea id="mc-headers" class="key-input mc-kv" placeholder="extra headers (optional), one per line:&#10;X-Api-Version: 2024-01" spellcheck="false" rows="2"></textarea>' +
          '<div class="mc-hint">Custom request headers as <code>Name: value</code>, one per line.</div>' +
          '<input id="mc-timeout" class="key-input" type="number" min="1000" max="600000" placeholder="timeout ms (optional, default 30000)" autocomplete="off">' +
          '<div class="mc-hint">How long to wait for the handshake / a tool call before giving up. Default 30s.</div>' +
        '</details>' +
        '<div class="mc-acts">' +
          '<button class="bb sm" id="mc-add">+ ADD &amp; CONNECT</button>' +
          '<button class="bb xs" id="mc-cancel" style="display:none">CANCEL EDIT</button>' +
        '</div>' +
      '</div>' +
      '<div id="mc-msg" class="msg" role="status" aria-live="polite"></div>';
    // ---- CATALOG pane markup: one-click, vetted MCP servers and platform APIs. Cards render async from
    //      both catalog endpoints and route through the existing connector/key setup flows. ----
    // The pane copy is JUST the setup-type legend now — the "browse vetted MCP servers and add them" sentence lived
    // here AND verbatim in the section desc below (mountConsole), so it read twice. CRT glyphs, not emoji.
    // The legend doubles as the FILTER: it already taught the three setup tiers, so making those same
    // words the control costs no new vocabulary. "What can I add without any setup right now?" is the
    // first question a newcomer has and 39 cards in one scroll could not answer it; "which of these am
    // I already on?" was equally unanswerable without reading every card.
    const secCatalog =
      '<div class="cc-filters" id="cc-filters" role="group" aria-label="Filter connectors by setup type">' +
        '<button type="button" class="cc-filter active" data-cc-filter="all" aria-pressed="true">ALL</button>' +
        '<button type="button" class="cc-filter cc-lg-none" data-cc-filter="none" aria-pressed="false">▸ no setup</button>' +
        '<button type="button" class="cc-filter cc-lg-key" data-cc-filter="apikey" aria-pressed="false">API key</button>' +
        '<button type="button" class="cc-filter cc-lg-oauth" data-cc-filter="oauth" aria-pressed="false">SIGN IN</button>' +
        '<button type="button" class="cc-filter" data-cc-filter="manual" aria-pressed="false">MANUAL SETUP</button>' +
        '<button type="button" class="cc-filter cc-f-on" data-cc-filter="installed" aria-pressed="false">YOUR SERVICES</button>' +
      '</div>' +
      '<p class="set-about"><span class="cc-legend"><b class="cc-lg-none">▸ no setup</b> no credentials needed · ' +
        '<b class="cc-lg-key">API key</b> you paste a key · <b class="cc-lg-oauth">SIGN IN</b> connect through your browser. Some services require one-time app setup first.</span></p>' +
      '<div id="cc-list" class="cc-list"><span class="loading pulse">loading catalog…</span></div>' +
      '<div id="cc-msg" class="msg" role="status" aria-live="polite"></div>' +
      '<p class="set-about dim">Need something not listed? Add any remote MCP server by URL in <b>MCP CONNECTORS</b>, or paste a custom platform key in <b>KEYS</b>.</p>';
    // ---- KEYS pane markup: every platform key the agents hold, in one place. Top = keyed catalog/MCP platforms
    //      currently connected (truth from /api/connectors — managed on their own tab, read-only here). Bottom =
    //      encrypted API credentials (POST /api/servicekeys): the sidecar exposes each as an env var in
    //      the agents' shell, so an agent can call ANY service's API with it. Values render masked, never whole. ----
    /* SHAPE (2026-08-13, Andrew's call): "keys should just be the list of keys available and connected,
       and underneath should allow users to add custom keys." The pane was FIVE stacked top-level sections
       — two lists, then a whole platform DIRECTORY, then the form — measured at 1560px of scroll in a
       599px pane, so the add form (the pane's only verb) sat a full screen below the fold with a catalog
       wedged between it and the list it belongs to.
       Now: ONE list block, then the form. The two lists stay SEPARATE rows inside that block because they
       are not the same thing — a keyed CATALOG/MCP platform is read-only here and managed where it was
       added, a custom key is editable and deletable — but they are demoted from full section rules to the
       shared `.set-sub` label, which is what they always were: two groups of one list. Their counts stay
       SPLIT for the same reason the code already refuses to fake one: if the /api/connectors read fails
       we say so rather than assert a zero, and a single summed total could not stay honest through that.
       The curated platform directory now lives in CATALOG, where discovery belongs. Its cards route here
       and prefill this form; KEYS stays the inventory/setup surface for credentials the Commander actually
       holds, plus the escape hatch for a custom platform the catalog does not list. */
    const secKeys =
      '<div class="sec"><span class="sec-l">YOUR KEYS</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<div class="set-sub"><span class="set-sub-k">CONNECTED PLATFORMS</span><span class="set-sub-d" id="ky-plat-n">0</span></div>' +
      '<div id="ky-platforms" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      '<div class="set-sub"><span class="set-sub-k">CONNECTED API KEYS</span><span class="set-sub-d" id="ky-mine-n">0</span></div>' +
      '<div id="ky-list" class="mc-list"></div>' +
      '<div class="sec"><span class="sec-l">ADD A KEY</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<div class="mc-form">' +
        '<input id="ky-name" class="key-input" placeholder="platform name — e.g. Resend" autocomplete="off" spellcheck="false" maxlength="64">' +
        '<input id="ky-key" type="password" class="key-input" placeholder="API key" autocomplete="off" spellcheck="false">' +
        '<input id="ky-docs" class="key-input" placeholder="API docs URL (optional — helps agents use the service)" autocomplete="off" spellcheck="false">' +
        '<div class="mc-hint">Stored locally by the sidecar and shown as ····last4 only. Agents get it as an environment variable ' +
          '(e.g. <code>RESEND_API_KEY</code>) in their shell, so they can call the platform’s API directly.</div>' +
        // TRUTHFUL TELEMETRY: the key alone is not enough. The shell it is handed to only exists when a WORKBENCH
        // prop is placed (capability/office.js grants it nowhere by default), and workspace-process tools are not
        // projected onto unattended surfaces at all (inputpolicy.js), so a saved key is inert until both hold.
        '<div class="mc-hint">These API keys are used through the terminal. Check the selected agent in TOOLSETS: access may come from a workbench, an execution profile or Full Access. ' +
          'Scheduled work also follows its saved unattended access settings. Saving a key does not verify that the service accepts it.</div>' +
        '<div class="mc-acts"><button class="bb sm" id="ky-add">+ SAVE KEY</button></div>' +
      '</div>' +
      '<div id="ky-msg" class="msg" role="status" aria-live="polite"></div>';
    /* ---- EXTENSIONS: the Commander's OWN code, running inside the station ----
       Sits in this console and not in SETTINGS because "MCP server", "hook" and "plugin" are one user intent —
       things I plug into my station — and splitting them by which subsystem implements them is how a settings
       screen becomes a junk drawer. The two lists stay SEPARATE inside the tab because they are not the same
       promise: a hook is a script the station shells out to, a plugin is code loaded into the station itself.

       The PENDING rows are the reason this panel exists at all. Both gates are opt-in by design, so an
       unapproved extension is silently inert — and an extension you wrote that never ran, with nothing on
       screen saying why, is the worst failure this design can produce. */
    const secExt = `
      <div class="ext-workspace">
        <div class="ext-choices" aria-label="Add an extension">
          <button class="ext-choice" data-ext-editor="hook" aria-controls="hk-form" aria-expanded="false">
            <span class="ext-choice-icon" aria-hidden="true">⌁</span>
            <span><b>Run a command automatically</b><small>Choose when StarNet runs your script.</small></span><span aria-hidden="true">＋</span>
          </button>
          <button class="ext-choice" data-ext-editor="plugin" aria-controls="pl-form" aria-expanded="false">
            <span class="ext-choice-icon" aria-hidden="true">⌘</span>
            <span><b>Create a plugin</b><small>Start with working code you can customize.</small></span><span aria-hidden="true">＋</span>
          </button>
        </div>
        <div id="ext-msg" class="msg" role="status" aria-live="polite"></div>
        <section class="ext-editor mc-form" id="hk-form" aria-label="Run a command automatically" hidden>
          <div class="ext-editor-head"><b>Run a command automatically</b><button class="bb xs" data-ext-editor="">CANCEL</button></div>
          <label for="hk-event">When to run</label>
          <select id="hk-event" class="key-input fbc-sel"></select>
          <label for="hk-cmd">Command</label>
          <input id="hk-cmd" class="key-input" placeholder="e.g. node scripts/run-summary.js" autocomplete="off" spellcheck="false">
          <details class="ext-details"><summary>Name &amp; technical details</summary>
            <label for="hk-name">Name <span class="dim">(optional)</span></label>
            <input id="hk-name" class="key-input" placeholder="e.g. Run summary" autocomplete="off" maxlength="60">
            <p class="mc-hint">This is a hook. The event arrives as JSON on stdin. Commands run without a shell; put pipes and redirects in a script. Before-tool hooks can block a tool by printing <code>{"decision":"block","reason":"why"}</code>.</p>
          </details>
          <p class="mc-hint">Runs with your computer’s permissions. Enable only commands you trust.</p>
          <div class="mc-acts"><button class="bb sm" id="hk-add">+ ADD &amp; ENABLE</button></div>
        </section>
        <section class="ext-editor mc-form" id="pl-form" aria-label="Create a plugin" hidden>
          <div class="ext-editor-head"><b>Create a plugin</b><button class="bb xs" data-ext-editor="">CANCEL</button></div>
          <p class="mc-hint">Your starter counts tool calls and logs a total after each run. Edit its code to make it do more.</p>
          <label for="pl-name">Plugin name</label>
          <input id="pl-name" class="key-input" placeholder="e.g. Run counter" autocomplete="off" maxlength="60">
          <details class="ext-details" id="pl-options"><summary>Optional settings</summary>
            <label for="pl-desc">Description</label>
            <input id="pl-desc" class="key-input" placeholder="A short note about this plugin" autocomplete="off" maxlength="140">
            <label for="pl-id">Folder ID <span class="dim">(filled from the name)</span></label>
            <input id="pl-id" class="key-input" autocomplete="off" spellcheck="false" maxlength="64" aria-describedby="pl-id-hint">
            <p id="pl-id-hint" class="mc-hint">Letters, numbers, dots, dashes or underscores. Use a different ID if this name is already taken.</p>
          </details>
          <p class="mc-hint">Runs with your computer’s permissions. Creating it enables the starter code.</p>
          <div class="mc-acts"><button class="bb sm" id="pl-add">+ CREATE &amp; ENABLE</button></div>
        </section>
        <div class="sec"><span class="sec-l">YOUR EXTENSIONS</span><span class="sec-r"></span><span class="sec-nd"></span></div>
        <div class="ext-list-heading">AUTOMATIC COMMANDS <span class="dim">/ hooks</span></div>
        <div id="hk-list" class="mc-list"><span class="loading pulse">Loading commands…</span></div>
        <div class="ext-list-heading">PLUGINS</div>
        <div id="pl-list" class="mc-list"><span class="loading pulse">Loading plugins…</span></div>
        <button class="bb xs" id="pl-where">COPY PLUGINS FOLDER PATH</button>
      </div>`;

    const frag = h => (el => { el.innerHTML = h; });
    // NAV CONDENSE 2 (2026-08-04): the standalone SKILLS window merged in here — one window owns
    // the whole "what agents can do" axis. stationui.js pushes its skill-library/agent-skills lane
    // onto window.AbilityLanes ((body)=>({sections,wire}), the windows/automation.js shape); the
    // lanes' sections mount in THIS console and their wire() runs after ours, against the same body.
    const lanes = (window.AbilityLanes || []).map(fn => { try { return fn(body); } catch (_) { return null; } }).filter(l => l && Array.isArray(l.sections));
    // TOOLSETS first (audit finding 5): the dock button says TOOLSETS, so the panel must open on the tab it's
    // named for — a first click used to land on the CATALOG storefront, which read as "TOOLSETS = connectors".
    /* ---- THE FRONT DOOR ----
       This console's five tabs are five MECHANISMS (curated MCP server · platform API key · MCP server by
       URL · hook/plugin · built-in toolset), and picking the right one is a question a newcomer cannot
       answer — they know the NAME of the thing they want, not which of six subsystems implements it.
       Landing on TOOLSETS and reading a rail of jargon is where that user stops.

       So the console opens with the question they CAN answer ("what are you trying to connect?") and each
       answer is a real jump to the tab that handles it. Two of the answers leave this window entirely —
       chat-FROM-Slack is CHANNELS and model providers are SETTINGS — because the honest answer to "how do
       I connect Telegram" is a different window, and silence there is exactly what sends people hunting.
       Nothing here gates anything: every tab remains one click away in the rail. */
    const ROUTES = [
      { glyph: '⊞', to: 'catalog', title: 'Connect a service you use',
        blurb: 'Find services and platform APIs, including print-on-demand. See what they can do and follow their setup steps. <b>Start here.</b>' },
      { glyph: '⧉', to: 'mcp', title: 'Advanced: add a custom connection',
        blurb: 'You already have an MCP endpoint and want to point the station at it.' },
      { glyph: '▤', to: 'toolsets', title: 'Switch a built-in on or off',
        blurb: 'Web, files, terminal, memory — inspect the selected agent’s tools and where its access comes from.' },
      // cross-window, and deliberately so: naming the wrong window is worse than naming none.
      { glyph: '✉', term: 'messaging', title: 'Message your agent from Telegram or Slack',
        blurb: 'Connect a chat account so you can give your agent work from there. Opens CHANNELS.' },
      { glyph: '◈', term: 'settings', section: 'providers', title: 'Add an AI model provider',
        blurb: 'Anthropic, OpenAI, OpenRouter keys and sign-ins live in SETTINGS › PROVIDERS.' }
    ];
    const secRouter =
      '<details class="ab-router" id="ab-router">' +
        '<summary class="ab-router-q"><span>＋ ADD AN ABILITY</span><small>Choose a service, server, channel or model provider</small></summary>' +
        '<div class="ab-router-grid">' +
          ROUTES.map((r, i) =>
            '<button type="button" class="ab-route" style="--ci:' + i + '"' +
              (r.to ? ' data-ab-to="' + esc(r.to) + '"' : '') +
              (r.term ? ' data-ab-term="' + esc(r.term) + '"' : '') +
              (r.section ? ' data-ab-section="' + esc(r.section) + '"' : '') + '>' +
              '<span class="ab-route-glyph" aria-hidden="true">' + esc(r.glyph) + '</span>' +
              '<span class="ab-route-main"><span class="ab-route-title">' + esc(r.title) + '</span>' +
                '<span class="ab-route-blurb dim">' + r.blurb + '</span></span>' +
              '<span class="ab-route-go" aria-hidden="true">' + (r.term ? '↗' : '›') + '</span>' +
            '</button>').join('') +
        '</div>' +
      '</details>';

    const host = mountConsole(body, 'connectors', [
      { id: 'toolsets', label: 'BUILT-IN ABILITIES', glyph: '▤', desc: 'Inspect an agent’s capability grants. Switches apply in ASK mode; Full Access overrides them. Connected services still need working credentials.', build: frag(secToolsets) },
      { id: 'catalog', label: 'CATALOG', glyph: '⊞', desc: 'Find a service by name or what you want to do. Choose it to see the setup required; YOUR SERVICES shows saved setups, not a live connection guarantee.', build: frag(secCatalog) },
      { id: 'keys', label: 'SAVED API CONNECTIONS', glyph: '⊟', desc: 'The platform credentials your agents actually hold, plus a safe drop for a custom API the catalog does not list.', build: frag(secKeys) },
      { id: 'mcp', label: 'CONNECTED SERVICES', glyph: '⧉', desc: 'Manage service access, check connection status, and reconnect when needed.', build: frag(secMcp) },
      { id: 'custom', label: 'CREATE / ADVANCED', glyph: '＋', desc: 'Configure a custom server, API, skill package, hook or plugin.', build: frag('<div class="ab-router-grid"><button class="ab-route" data-ab-to="mcp">Add a custom MCP server</button><button class="ab-route" data-ab-to="keys">Add a custom API key</button><button class="ab-route" data-ab-to="exchange">Import a skill package</button><button class="ab-route" data-ab-to="extensions">Create hooks and plugins</button></div>') },
      { id: 'extensions', label: 'EXTENSIONS', glyph: '⌥', desc: 'Automate a step or extend StarNet with your own code.', build: frag(secExt) }
    ].concat(lanes.reduce((acc, l) => acc.concat(l.sections), [])), {
      search: true,
      groups: [
        { id: 'installed', label: 'INSTALLED', sections: ['toolsets', 'mcp', 'keys', 'agent'] },
        { id: 'discover', label: 'DISCOVER', sections: ['catalog', 'library'] },
        { id: 'advanced', label: 'CREATE / ADVANCED', sections: ['custom', 'extensions', 'exchange'] }
      ],
      searchLabel: 'Search abilities',
      searchPlaceholder: 'search a platform, tool or skill — try “notion”…',
      searchEmptyText: 'No abilities match that search. Try another platform, tool, or skill.'
    });
    lanes.forEach(l => { try { if (typeof l.wire === 'function') l.wire(); } catch (_) {} });

    /* Mount the front door ABOVE the panes, inside the scrolling content column: it is the first thing
       read on every tab, and it scrolls away once you are working — permanent chrome for a question you
       only ask once would be worse than no answer. It hides itself while the search box is active
       (`.con-searching`), because then the Commander has already named the thing and the results ARE the
       answer. */
    const routerEl = document.createElement('div');
    routerEl.innerHTML = secRouter;
    const routerNode = routerEl.firstChild;
    if (host && routerNode) host.insertBefore(routerNode, host.firstChild);
    const handoffEl = document.createElement('div');
    handoffEl.className = 'mc-hint'; handoffEl.setAttribute('aria-live', 'polite');
    if (host) host.insertBefore(handoffEl, host.firstChild);
    function renderHandoffs(connectors) {
      handoffEl.replaceChildren();
      if (typeof Workstreams === 'undefined' || !Workstreams.connectorHandoff) return;
      for (const ws of Workstreams.list()) {
        const h = Workstreams.connectorHandoff(ws.id); if (!h) continue;
        const c = connectors.find(x => x.id === h.connectorId);
        const ready = c && c.enabled && c.state === 'up' && !c.authRequired;
        const dormant = c && c.enabled && c.state === 'cached' && !c.authRequired;
        const supported = dormant || (ready && (!h.toolName || (c.tools || []).includes(h.toolName)));
        const line = document.createElement('div');
        const caption = document.createElement('span');
        caption.textContent = (ws.title || 'Task') + ' · ' + h.connectorId + ' — '
          + (dormant ? 'saved connection will be checked. ' : supported ? 'connection ready. ' : ready ? 'requested operation is unavailable. ' : 'waiting for connection. ');
        line.appendChild(caption);
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'bb xs';
        btn.textContent = dormant ? 'CHECK & CONTINUE TASK' : supported ? 'CONTINUE TASK' : 'RETURN TO TASK';
        btn.onclick = async () => {
          if (!supported) { App.openWorkstream(ws.id); return; }
          btn.disabled = true;
          await Chat.continueConnectorTask(ws.id);
          if (btn.isConnected) btn.disabled = false;
          refresh();
        };
        line.appendChild(btn); handoffEl.appendChild(line);
      }
    }
    // Delegated on the whole console body, not just the strip: `data-ab-to` is the jump CONTRACT for this
    // window, and the empty states reuse it (KEYS' "no keyed platform yet" offers OPEN CATALOG). Binding
    // to the strip alone would have left those buttons inert — a new dead end shipped beside a cured one.
    body.addEventListener('click', ev => {
      const btn = ev.target.closest('.ab-route, [data-ab-to], [data-ab-term]'); if (!btn) return;
      sfx('click');
      // in-console jump: click the REAL rail button so the console's own selection + persistence run.
      const to = btn.dataset.abTo;
      if (to) {
        const tab = body.querySelector('#con-tab-connectors-' + to);
        if (tab) { tab.click(); routerNode.open = false; host.scrollTop = 0; }
        return;
      }
      // cross-window jump: openTerm is idempotent (restores a minimized window rather than duplicating).
      const term = btn.dataset.abTerm;
      if (term && typeof H.openTerm === 'function') H.openTerm(term, btn.dataset.abSection || undefined);
    });

    /* ===== EXTENSIONS: hooks + plugins, straight off /api/hooks and /api/plugins =====
       TRUTHFUL TELEMETRY, strictly: every badge here reads a state the sidecar can prove. "active" means the
       hook spine actually registered it this boot — not that it appears in a config file. That distinction is
       the entire value of the panel, because a configured-but-unapproved extension looks identical to a
       working one from the outside. */
    /* The picker says WHEN in plain language. "post_tool_call" is the wire name and it is meaningless to
       anyone who has not read the source; the value stays the wire name, only the label is human. */
    const EVENT_LABEL = {
      pre_tool_call: 'before the agent uses a tool  (can block it)',
      post_tool_call: 'after the agent uses a tool',
      pre_llm_call: 'before every model call  (can add a note, or block)',
      post_llm_call: 'after every model call',
      on_session_start: 'when a run starts',
      on_session_end: 'when a run finishes',
      subagent_stop: 'when a delegated worker finishes',
      on_pre_compress: 'just before history is compacted',
      on_memory_write: 'when something is written to memory'
    };
    let extPluginDir = '';
    const extMsg = body.querySelector('#ext-msg');
    function extSay(text, bad) {
      if (!extMsg) return;
      extMsg.textContent = text || '';
      extMsg.style.color = bad ? 'var(--bad)' : 'var(--ok)';
    }
    // Actions carry their own busy state: a double-click on APPROVE must not fire two re-installs.
    async function extPost(url, payload, btn) {
      if (btn) { btn.disabled = true; btn.classList.add('busy'); }
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { extSay((j && j.error) || ('request failed (' + r.status + ')'), true); return false; }
        return true;
      } catch (e) { extSay('could not reach the station: ' + ((e && e.message) || e), true); return false; }
      finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); } }
    }

    function extBadge(state) {
      return ({
        active: ['var(--ok)', '● On'],
        pending: ['var(--gold)', '○ Off · needs approval'],
        error: ['var(--bad)', '✕ error']
      })[state] || ['var(--ph-dim)', '○ Off'];
    }
    // A findings block is DISCLOSURE at the approval moment — the guard is not a boundary, so the Commander
    // has to be able to see what they are about to say yes to.
    function extFindings(f) {
      if (!f || !f.level) return '';
      const hits = Array.isArray(f.hits) && f.hits.length ? ' — ' + f.hits.map(h => esc(String(h))).join(', ') : '';
      return '<div class="mc-hint">scanner: <b>' + esc(String(f.level)) + '</b>' + hits + '</div>';
    }

    // Keep drafts in the DOM while changing editors; never ask for two setups at once.
    function extEditor(kind, focus = true) {
      body.querySelector('#hk-form').hidden = kind !== 'hook';
      body.querySelector('#pl-form').hidden = kind !== 'plugin';
      body.querySelectorAll('.ext-choice').forEach(btn => {
        btn.setAttribute('aria-expanded', String(btn.dataset.extEditor === kind));
      });
      if (focus && kind) body.querySelector(kind === 'hook' ? '#hk-event' : '#pl-name').focus();
    }
    body.querySelectorAll('[data-ext-editor]').forEach(btn => btn.addEventListener('click', () => {
      const kind = btn.dataset.extEditor;
      const prior = body.querySelector('#hk-form').hidden ? 'plugin' : 'hook';
      extEditor(kind);
      extSay('');
      if (!kind) body.querySelector('[data-ext-editor="' + prior + '"]').focus();
    }));
    const pluginName = body.querySelector('#pl-name'), pluginId = body.querySelector('#pl-id');
    let pluginIdEdited = false;
    function suggestedPluginId(name) {
      return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'my-plugin';
    }
    pluginName.addEventListener('input', () => {
      if (!pluginIdEdited) pluginId.value = suggestedPluginId(pluginName.value);
    });
    pluginId.addEventListener('input', () => { pluginIdEdited = !!pluginId.value.trim(); });

    async function renderExtensions() {
      const hkEl = body.querySelector('#hk-list'), plEl = body.querySelector('#pl-list');
      if (!hkEl || !plEl) return false;
      // A failed read is unavailable state, never an empty list. Keep the other list usable.
      const read = async (url, key) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        if (!Array.isArray(data[key])) throw new Error('Invalid extension response');
        return data;
      };
      const results = await Promise.allSettled([read('/api/hooks', 'hooks'), read('/api/plugins', 'plugins')]);
      const hooks = results[0].status === 'fulfilled' ? results[0].value : null;
      const plugins = results[1].status === 'fulfilled' ? results[1].value : null;
      extPluginDir = plugins ? plugins.dir || '' : '';
      body.querySelector('#pl-where').hidden = !extPluginDir || !plugins.plugins.length;
      const unavailable = label => '<div class="mc-hint">Could not load ' + label + '. <button class="bb xs" data-ext="retry">TRY AGAIN</button></div>';
      const evSel = body.querySelector('#hk-event');
      if (hooks && evSel && !evSel.options.length && Array.isArray(hooks.events)) {
        evSel.innerHTML = hooks.events.map(e => '<option value="' + esc(e) + '">' + esc(EVENT_LABEL[e] || e) + '</option>').join('');
        if (hooks.events.includes('on_session_end')) evSel.value = 'on_session_end';
      }
      body.querySelector('#hk-add').disabled = !hooks || !evSel.options.length;
      hkEl.innerHTML = !hooks ? unavailable('commands') : hooks.hooks.map(h => {
        const badge = extBadge(h.active ? 'active' : 'pending');
        const dat = ' data-event="' + esc(h.event) + '" data-command="' + esc(h.command) + '"';
        return '<div class="mc-row ext-row"><div class="mc-top"><b>' + esc(h.name || h.command) + '</b>' +
          '<span class="mc-state" style="color:' + badge[0] + '">' + badge[1] + '</span></div>' +
          '<div class="mc-hint">' + esc(EVENT_LABEL[h.event] || h.event) + '</div>' +
          '<div class="mc-acts"><button class="bb xs" data-ext="hook-' + (h.active ? 'revoke' : 'allow') + '"' + dat + '>' +
          (h.active ? 'TURN OFF' : 'APPROVE &amp; ENABLE') + '</button></div>' +
          '<details class="ext-details"><summary>Details</summary><code class="ext-command">' + esc(h.command) + '</code>' +
          (!h.active ? '<p class="mc-hint">Runs with your computer’s permissions when enabled.</p>' : '') +
          '<button class="bb xs danger" data-ext="hook-delete"' + dat + '>REMOVE COMMAND</button></details></div>';
      }).join('') || '<div class="ext-empty">No automatic commands yet.</div>';
      plEl.innerHTML = !plugins ? unavailable('plugins') : plugins.plugins.map(p => {
        const badge = extBadge(p.active ? 'active' : (p.pending ? 'pending' : 'inert'));
        return '<div class="mc-row ext-row"><div class="mc-top"><b>' + esc(p.name || p.id) + '</b>' +
          '<span class="mc-state" style="color:' + badge[0] + '">' + badge[1] + '</span></div>' +
          (p.description ? '<div class="mc-hint">' + esc(p.description) + '</div>' : '') +
          (!p.active ? extFindings(p.findings) : '') +
          '<div class="mc-acts"><button class="bb xs" data-ext="plugin-' + (p.active ? 'revoke' : 'allow') + '" data-id="' + esc(p.id) + '" data-digest="' + esc(p.digest || '') + '">' +
          (p.active ? 'TURN OFF' : 'APPROVE &amp; ENABLE') + '</button></div>' +
          '<details class="ext-details"><summary>Details &amp; code</summary>' +
          '<p class="mc-hint">Folder: <code>' + esc(p.id) + '</code> · Version ' + esc(p.version || '0') +
          '<br>Open its folder to edit the code. Starters use <code>index.js</code>.</p>' +
          (p.active ? extFindings(p.findings) : '<p class="mc-hint">Enabling loads this code with your computer’s permissions.</p>') +
          '<div class="mc-acts"><button class="bb xs" data-ext="plugin-where" data-id="' + esc(p.id) + '">COPY FOLDER PATH</button>' +
          '<button class="bb xs danger" data-ext-remove="' + esc(p.id) + '">DELETE PLUGIN</button></div>' +
          '<p class="mc-hint">Deleting also removes its code from disk.</p></details></div>';
      }).join('') || '<div class="ext-empty">No plugins yet.</div>';
      plEl.querySelectorAll('[data-ext-remove]').forEach(btn => {
        ArmConfirm.wire(btn, {
          armedLabel: 'SURE? DELETE CODE', restLabel: 'DELETE PLUGIN', timeoutMs: 4000,
          onArm: () => sfx('bad'),
          onConfirm: async () => {
            if (await extPost('/api/plugins/delete', { id: btn.dataset.extRemove }, btn)) {
              const refreshed = await renderExtensions();
              if (refreshed) extSay('Plugin deleted.');
            }
          }
        });
      });
      const errors = (hooks ? hooks.errors || [] : ['Could not load commands. Try again.'])
        .concat(plugins ? plugins.errors || [] : ['Could not load plugins. Try again.']);
      extSay(errors[0] || '', !!errors.length);
      return !errors.length;
    }

    // The three form buttons carry no data-ext of their own (they live in the markup, not in a rendered row),
    // so they are mapped to actions here rather than duplicating the handler.
    const EXT_FORM_BTNS = { 'hk-add': 'hook-add', 'pl-add': 'plugin-add', 'pl-where': 'plugin-where' };
    body.addEventListener('click', async (ev) => {
      const formBtn = ev.target.closest('#hk-add, #pl-add, #pl-where');
      const btn = formBtn || ev.target.closest('[data-ext]');
      if (!btn || !body.contains(btn) || btn.disabled) return;
      const kind = formBtn ? EXT_FORM_BTNS[formBtn.id] : btn.getAttribute('data-ext');
      let ok = false;
      // Set AFTER the re-render, never before: renderExtensions() clears the message line to drop stale
      // errors, so a success set inline is wiped the instant it is written (caught live).
      let done = '';
      if (kind === 'retry') { await renderExtensions(); return; }
      if (kind === 'hook-allow') ok = await extPost('/api/hooks/allow', { event: btn.dataset.event, command: btn.dataset.command }, btn);
      else if (kind === 'hook-revoke') ok = await extPost('/api/hooks/revoke', { event: btn.dataset.event, command: btn.dataset.command }, btn);
      else if (kind === 'hook-delete') ok = await extPost('/api/hooks/delete', { event: btn.dataset.event, command: btn.dataset.command }, btn);
      else if (kind === 'plugin-allow') ok = await extPost('/api/plugins/allow', { id: btn.dataset.id, digest: btn.dataset.digest }, btn);
      else if (kind === 'plugin-revoke') ok = await extPost('/api/plugins/revoke', { id: btn.dataset.id }, btn);
      else if (kind === 'hook-add') {
        const ev = body.querySelector('#hk-event'), cmd = body.querySelector('#hk-cmd'), nm = body.querySelector('#hk-name');
        if (!cmd.value.trim()) { extSay('Enter the command you want to run.', true); cmd.focus(); return; }
        ok = await extPost('/api/hooks/create', { event: ev.value, command: cmd.value.trim(), name: nm.value.trim() }, btn);
        if (ok) { cmd.value = ''; nm.value = ''; done = 'Command added.'; extEditor('', false); }
      }
      else if (kind === 'plugin-add') {
        const id = body.querySelector('#pl-id'), nm = body.querySelector('#pl-name'), ds = body.querySelector('#pl-desc');
        if (!nm.value.trim()) { extSay('Give your plugin a name.', true); nm.focus(); return; }
        if (!pluginIdEdited) id.value = suggestedPluginId(nm.value);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id.value.trim())) {
          body.querySelector('#pl-options').open = true;
          extSay('Use letters or numbers at the start of the folder ID, then letters, numbers, dots, dashes or underscores.', true);
          id.focus(); return;
        }
        ok = await extPost('/api/plugins/create', { id: id.value.trim(), name: nm.value.trim(), description: ds.value.trim() }, btn);
        if (!ok) body.querySelector('#pl-options').open = true;
        if (ok) { done = 'Plugin created. Find its code under Details & code.'; id.value = ''; nm.value = ''; ds.value = ''; pluginIdEdited = false; extEditor('', false); }
      }
      else if (kind === 'plugin-where') {
        if (!extPluginDir) { extSay('the station has not reported a plugins folder yet', true); return; }
        const path = extPluginDir + (btn.dataset.id ? '/' + btn.dataset.id : '');
        try { await navigator.clipboard.writeText(path); extSay('Path copied to your clipboard.'); }
        catch (_) { extSay(path); }   // no clipboard permission — show it rather than fail silently
        return;
      }
      else return;
      if (ok) { try { sfx('ok'); } catch (_) {} const refreshed = await renderExtensions(); if (done && refreshed) extSay(done); }
    });
    renderExtensions();

    // ===== TOOLSETS: render pill-switch rows from GET /api/toolsets, honestly reflecting placement + consent =====
    const tsListEl = body.querySelector('#ts-list');
    // Refresh the selected agent's workspace projection alongside its host authority.
    let placedTypes = [];
    // How many tool chips a row shows before folding the rest behind a count. WEB & BROWSER grants 36:
    // unfolded they ran seven lines deep and pushed every other toolset below the fold, so the pane's
    // first screen was a wall of `browser.*` instead of the seven families it exists to present. The
    // full list is still one click away — this hides nothing, it just stops one row eating the pane.
    const TS_TOOLS_SHOWN = 8;
    function tsAvailability(t) {
      if (t.available) return 'AVAILABLE';
      if (t.switchEffective && !t.enabled) return 'DISABLED';
      if (t.switchEffective && !t.placed && !t.profileGranted) return 'NEEDS PROP';
      return 'UNAVAILABLE';
    }
    function tsRowHTML(t, ri) {
      const off = !t.available;
      const availability = tsAvailability(t);
      const inert = availability === 'NEEDS PROP';
      // A DIAGNOSIS WITHOUT A CURE. This span named the exact missing prop and offered nothing to click,
      // so the one row that knows what is wrong was the one row you could not act on. The button hands
      // off to the same REFIT deep-link the SKILLS library's PLACE uses (arms the palette on the prop),
      // which is the honest path: the prop still lands where the Commander puts it.
      const hint = inert
        ? '<span class="ts-inert">no ' + esc(t.object || 'prop') + ' in this agent’s workspace — choose one matching prop for this ability' +
            (t.object ? '<button class="bb xs ts-place" type="button" data-ts-place="' + esc(t.object) + '">⚒ PLACE ONE</button>' : '') +
          '</span>'
        : '';
      const consent = '<span class="ts-tag">' + (t.available ? esc(t.grantSource || 'granted') : 'not granted') + '</span>' + (t.consentGated ? '<span class="ts-tag">risky actions may ask</span>' : '');
      const status = '<span class="ts-availability' + (t.available ? ' available' : '') + '">' + availability + '</span>';
      const isJuke = t.id === 'jukebox';
      const all = (t.tools && t.tools.length) ? t.tools : [];
      const rest = all.length - TS_TOOLS_SHOWN;
      const tools = all.length
        ? '<details><summary>Inspect tools</summary><div class="ts-tools">' + all.map((n, i) =>
            '<code' + (i >= TS_TOOLS_SHOWN ? ' class="ts-tool-more" hidden' : '') + '>' + esc(n) + '</code>').join('') +
            (rest > 0 ? '<button class="ts-more" type="button" data-ts-more="' + esc(t.id) + '">+' + rest + ' more</button>' : '') +
          '</div></details>'
        : '';
      return '<div class="set-row ts-row' + (off ? ' ts-off' : '') + (inert ? ' ts-inert-row' : '') + '" data-id="' + esc(t.id) + '" style="--ci:' + (ri || 0) + '">' +
          '<input type="checkbox" data-ts-toggle="' + esc(t.id) + '"' + (t.enabled ? ' checked' : '') + ' aria-label="Enable ' + esc(t.label) + '"' + (t.switchEffective ? '' : ' disabled data-tip="Full Access overrides this saved switch. Change authority first."') + '>' +
          '<span class="ts-glyph" aria-hidden="true">' + esc(t.glyph || '▪') + '</span>' +
          '<span class="ts-main">' +
            '<span class="ts-name">' + esc(t.label) + ' ' + status + consent +
              '<span class="ts-count dim">' + t.toolCount + ' tool' + (t.toolCount === 1 ? '' : 's') + '</span></span>' +
            '<span class="ts-desc dim">' + esc(t.desc) + '</span>' + hint + tools +
            (isJuke ? spotifyInline : '') +
          '</span>' +
        '</div>';
    }
    const tsAgentEl = body.querySelector('#ts-agent');
    const tsAuthorityEl = body.querySelector('#ts-authority');
    const agents = H.present || [];
    tsAgentEl.innerHTML = agents.map(a => '<option value="' + esc(a.id) + '">' + esc(a.name || a.id) + '</option>').join('') || '<option value="">Station defaults</option>';
    if (agents[H.sel]) tsAgentEl.value = agents[H.sel].id;
    let tsRequest = 0;
    tsAgentEl.addEventListener('change', tsRefresh);
    body.querySelector('#ts-refresh').addEventListener('click', tsRefresh);
    async function tsRefresh() {
      const request = ++tsRequest;
      try {
        placedTypes = (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(tsAgentEl.value).map(c => c.objectType) : [];
        const j = await Harness.api.get('/api/toolsets?agent=' + encodeURIComponent(tsAgentEl.value) + '&placed=' + encodeURIComponent(placedTypes.join(',')));
        if (request !== tsRequest || !body.isConnected) return;
        if (!j || j.error || !j.authority) throw new Error((j && j.error) || 'authority unavailable');
        const a = j.authority;
        tsAuthorityEl.textContent = a.name + ' · ' + a.approvalLabel + ' · ' + a.filesystemLabel + '. ' + a.revoke + ' Capability grants shown here; the current task, service connection and operating system can still limit execution.';
        const list = (j && j.toolsets) || [];
        tsListEl.innerHTML = '<div class="ability-readout" aria-label="Selected agent toolset availability">' +
          '<div><b>' + list.filter(t => t.available).length + '</b><span>AVAILABLE</span></div>' +
          '<div><b>' + list.filter(t => tsAvailability(t) === 'NEEDS PROP').length + '</b><span>NEED A PROP</span></div>' +
          '<div><b>' + list.filter(t => !t.available && tsAvailability(t) !== 'NEEDS PROP').length + '</b><span>UNAVAILABLE</span></div></div>' +
          '<p class="ability-legend">AVAILABLE means this agent has the capability through equipment or access settings. Service connections and task permissions still apply.</p>' +
          list.map(tsRowHTML).join('');
        if (body.querySelector('#sp-connect')) setupSpotify(body);   // wire Spotify now the sp-* markup is in the JUKEBOX row
      } catch (_) { if (request !== tsRequest) return; tsAuthorityEl.textContent = 'Effective authority unavailable.'; tsListEl.innerHTML = '<div class="mc-detail">Cannot read current capabilities. Reopen ABILITIES after reconnecting.</div>'; }
    }
    tsListEl.addEventListener('change', async ev => {
      const cb = ev.target.closest('input[data-ts-toggle]'); if (!cb) return;
      const id = cb.dataset.tsToggle; const enabled = cb.checked;
      cb.disabled = true;
      try {
        const r = await Harness.api.post('/api/toolsets/' + encodeURIComponent(id), { enabled });
        const j = r.j || {};
        if (!r.ok || j.error) { cb.checked = !enabled; sfx('bad'); notify('✕ ' + (j.error || 'toggle failed')); }
        else { sfx('tick'); notify((enabled ? 'Enabled ' : 'Disabled ') + id, enabled ? 'good' : undefined); }
      } catch (e) { cb.checked = !enabled; sfx('bad'); notify('✕ ' + ((e && e.message) || 'request failed')); }
      cb.disabled = false;
      tsRefresh();
    });
    // The two non-toggle controls on a toolset row: unfold the rest of the tool chips, and cure an
    // inert row by deep-linking its missing prop into REFIT.
    tsListEl.addEventListener('click', ev => {
      const more = ev.target.closest('button[data-ts-more]');
      if (more) {
        const wrap = more.parentElement;
        if (wrap) wrap.querySelectorAll('.ts-tool-more').forEach(c => { c.hidden = false; });
        more.remove(); sfx('tick'); return;
      }
      const place = ev.target.closest('button[data-ts-place]');
      if (place) {
        sfx('click');
        // H.placeGearForSkill minimizes this console, opens REFIT and arms the palette on the prop.
        // No mapping for this objectType still opens REFIT + names the gear in a toast, which is the
        // floor of acceptable — never a silent no-op.
        if (typeof H.placeGearForSkill === 'function') H.placeGearForSkill(place.dataset.tsPlace);
        else notify('Open ⚒ BUILD and place a ' + place.dataset.tsPlace + ' to grant these tools', 'warn');
      }
    });
    tsRefresh();

    const listEl = body.querySelector('#mc-list');
    const msgEl = body.querySelector('#mc-msg');
    const formH = body.querySelector('#mc-form-h');
    const addBtn = body.querySelector('#mc-add');
    const cancelBtn = body.querySelector('#mc-cancel');
    const idInput = body.querySelector('#mc-id');
    let editing = null;   // id being edited (null = adding a new connector)
    let stdioAgents = [];

    // ----- transport segmented toggle -----
    function transport() { const on = body.querySelector('.mc-seg-btn.active'); return (on && on.dataset.tp) || 'http'; }
    function setTransport(tp) {
      body.querySelectorAll('.mc-seg-btn').forEach(b => { const a = b.dataset.tp === tp; b.classList.toggle('active', a); b.setAttribute('aria-selected', a ? 'true' : 'false'); });
      body.querySelectorAll('.mc-tp-fields').forEach(f => { f.style.display = String(f.dataset.tp || '').split(/\s+/).indexOf(tp) >= 0 ? '' : 'none'; });
      const tokenFields = body.querySelector('#mc-token-fields'); if (tokenFields) tokenFields.style.display = tp === 'http' ? '' : 'none';
      const oauthNote = body.querySelector('#mc-oauth-note'); if (oauthNote) oauthNote.style.display = tp === 'oauth' ? '' : 'none';
      const dead = tp === 'stdio' && stdioAgents.length === 0;
      addBtn.disabled = dead;
      addBtn.title = dead ? 'set an agent’s execution profile to SAFE CELL first' : '';
      addBtn.textContent = tp === 'oauth' ? (editing ? '✓ SAVE & SIGN IN' : '+ ADD & SIGN IN') : (editing ? '✓ SAVE & RECONNECT' : '+ ADD & CONNECT');
    }
    body.querySelector('#mc-transport').addEventListener('click', ev => {
      const b = ev.target.closest('.mc-seg-btn'); if (!b) return; setTransport(b.dataset.tp); sfx('tick');
    });

    async function loadStdioAgents(selected) {
      const sel = body.querySelector('#mc-agent'); if (!sel) return;
      try {
        const j = await Harness.api.get('/api/execution-profiles');
        stdioAgents = ((j && j.agents) || []).filter(x => x && x.agentId && x.profile && x.profile.id === 'safe-cell' && x.environment && x.environment.effectiveBackend === 'docker' && x.environment.safeCell && x.environment.safeCell.hostileCodeSandbox === true);
      } catch (_) { stdioAgents = []; }
      sel.innerHTML = stdioAgents.length
        ? '<option value="">choose a Safe Cell agent…</option>' + stdioAgents.map(x => '<option value="' + esc(x.agentId) + '">' + esc(x.agentId) + ' — SAFE CELL</option>').join('')
        : '<option value="">no Safe Cell agents available</option>';
      if (selected && stdioAgents.some(x => x.agentId === selected)) sel.value = selected;
      const hint = body.querySelector('#mc-agent-hint');
      if (hint) hint.textContent = stdioAgents.length
        ? 'The server runs inside this agent’s persistent Safe Cell, never as an interactive host child.'
        : 'Set an agent’s execution profile to SAFE CELL first, then return here. Docker must also be available on this machine.';
      if (transport() === 'stdio') setTransport('stdio');
    }

    // ----- key:value textarea parsers (headers use ':' , env uses '=') -----
    function parseKV(text, sep) {
      const out = {}; let bad = null;
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim(); if (!line) continue;
        const i = line.indexOf(sep); if (i < 1) { bad = line; break; }
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return { out, bad };
    }

    function resetForm() {
      editing = null;
      formH.textContent = 'ADD A CONNECTOR';
      addBtn.textContent = '+ ADD & CONNECT';
      cancelBtn.style.display = 'none';
      idInput.disabled = false;
      ['#mc-id', '#mc-label', '#mc-url', '#mc-token', '#mc-headers', '#mc-timeout', '#mc-command', '#mc-args', '#mc-cwd', '#mc-env']
        .forEach(s => { const el = body.querySelector(s); if (el) el.value = ''; });
      const adv = body.querySelector('#mc-form .mc-adv'); if (adv) adv.open = false;   // a cleared form is the simple form again
      setTransport('http');
    }
    cancelBtn.addEventListener('click', () => { resetForm(); msgEl.textContent = ''; sfx('click'); });

    // populate the form from an existing connector for EDIT (secrets stay blank = keep-saved).
    function startEdit(c) {
      editing = c.id;
      formH.textContent = 'EDIT CONNECTOR — ' + (c.label || c.id);
      addBtn.textContent = '✓ SAVE & RECONNECT';
      cancelBtn.style.display = '';
      idInput.disabled = true;
      idInput.value = c.id;
      body.querySelector('#mc-label').value = c.label && c.label !== c.id ? c.label : '';
      body.querySelector('#mc-timeout').value = (c.timeoutMs && c.timeoutMs !== 30000) ? c.timeoutMs : '';
      setTransport(c.transport === 'stdio' ? 'stdio' : (c.oauth ? 'oauth' : 'http'));
      if (c.transport === 'stdio') {
        body.querySelector('#mc-command').value = c.command || '';
        body.querySelector('#mc-args').value = (c.args || []).some(x => x === '<redacted>') ? '' : (c.args || []).join('\n');
        body.querySelector('#mc-cwd').value = '';
        body.querySelector('#mc-env').value = '';
        loadStdioAgents(c.agentId || '');
        msgEl.classList.remove('ok');
        msgEl.textContent = c.hasEnv ? 'Saved environment values are hidden; leave env blank to keep them.' : '';
      } else {
        body.querySelector('#mc-url').value = c.url || '';
        body.querySelector('#mc-token').value = '';   // never round-trip the token
        const hKeys = Object.keys(c.headers || {});
        body.querySelector('#mc-headers').value = hKeys.map(k => k + ': ' + (c.headers[k] === '<redacted>' ? '' : c.headers[k])).join('\n');
        // Unfold the advanced block when this connector actually HAS advanced settings — otherwise an
        // edit would silently hide the headers/timeout it is about to re-save, which reads as data loss.
        const adv = body.querySelector('#mc-form .mc-adv');
        if (adv) adv.open = hKeys.length > 0 || !!(c.timeoutMs && c.timeoutMs !== 30000);
      }
      formH.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      idInput.focus();
      sfx('click');
    }

    function badge(state) {
      return ({ up: ['var(--ok)', '● connected'], connecting: ['var(--gold)', '◌ connecting…'],
                cached: ['var(--gold)', '◐ idle · starts on use'],
                down: ['var(--ph-dim)', '○ disabled'], error: ['var(--bad)', '✕ error'] })[state] || ['var(--ph-dim)', '○ ' + esc(state || 'unknown')];
    }
    function row(c, ri) {
      const b = c.releaseDeferred ? ['var(--gold)', '○ deferred'] : badge(c.state);
      const tools = (c.tools && c.tools.length) ? '<div class="mc-tools">' + c.tools.map(t => '<code>' + esc(t) + '</code>').join('') + '</div>' : '';
      const detail = (c.state === 'error' && c.detail) ? '<div class="mc-detail">' + esc(c.detail) + '</div>' : '';
      const next = c.releaseDeferred ? (c.credentialSaved ? 'Saved connection retained.' : 'Unavailable in this release.') : !c.enabled ? 'Turn on the switch above to let agents use this service.'
        : c.oauth && (c.authRequired || !c.oauthAuthorized) ? 'Sign in below to restore access to this account.'
        : c.state === 'error' ? 'Open the error details below, then reload to retry.'
        : '';
      const where = c.transport === 'stdio'
        ? ('<span class="mc-tag">stdio</span> <code>' + esc([c.command].concat(c.args || []).join(' ')) + '</code>' + (c.hasEnv ? ' · env set' : '') +
           '<div class="mc-hint">isolated owner: ' + esc(c.agentId || 'unbound') + ' · persistent Safe Cell</div>')
        : ('<span class="mc-tag">' + (c.oauth ? 'oauth' : 'http') + '</span> ' + esc(c.url)
          // COPY TRUTH: a row must never read "OAuth authorized" AND "reauthentication required" at once — a
          // rejected grant (authRequired) outranks token presence (oauthAuthorized derives from a stored token).
          + (c.releaseDeferred ? (c.credentialSaved ? ' · saved connection retained' : '') : c.oauth ? (c.authRequired ? ' · OAuth grant rejected — sign in again' : (c.oauthAuthorized ? ' · OAuth authorized' : ' · OAuth sign-in needed')) : (c.hasToken ? ' · token saved' : ''))
          + (c.hasHeaders ? ' · headers set' : ''));
      const timeout = (c.timeoutMs && c.timeoutMs !== 30000) ? '<span class="dim"> · ' + Math.round(c.timeoutMs / 1000) + 's</span>' : '';
      return '<div class="mc-row" data-service data-id="' + esc(c.id) + '" data-enabled="' + (c.enabled ? '1' : '0') + '" style="--ci:' + (ri || 0) + '">' +
        '<div class="mc-top">' +
          '<span class="set-row mc-enable"><input type="checkbox" data-act="toggle"' + (c.enabled ? ' checked' : '') + (c.releaseDeferred ? ' disabled' : '') + ' aria-label="Enable connector ' + esc(c.id) + '"></span>' +
          '<b>' + esc(c.label || c.id) + '</b>' +
          '<span class="mc-state" style="color:' + b[0] + '">' + b[1] + (c.toolCount ? ' · ' + c.toolCount + ' tool' + (c.toolCount === 1 ? '' : 's') : '') + '</span></div>' +
        (c.account && c.account.email ? '<div class="mc-summary">Account at last sign-in: ' + esc(c.account.email) + '</div>' : '') +
        (next ? '<div class="mc-summary">' + esc(next) + '</div>' : '') +
        '<details class="mc-inspect"><summary>' + (detail ? 'Error &amp; connection details' : 'Connection details') + (c.tools && c.tools.length ? ' · ' + c.tools.length + ' tools' : '') + '</summary>' +
          '<div class="mc-hint">Service ID: <code>' + esc(c.id) + '</code></div>' +
          '<div class="mc-url dim">' + where + timeout + '</div>' +
          '<div class="mc-hint">' + (c.account && c.account.email ? '' : 'Account identity: not verified by StarNet. ') + 'Browser logins are separate from this connection.</div>' +
          detail + tools +
        '</details>' +
        '<div class="mc-acts">' +
          // an OAuth connector's stored grant can die provider-side (token revoked, DCR client deleted) — a state
          // RELOAD can't cure (it reconnects with the same dead grant) and EDIT can't reach (its form is the
          // http-bearer/stdio editor; there is no bearer to paste). A fresh browser consent is the only cure, so
          // the row always carries it — same engine as the catalog card's ▸ SIGN IN (ccSignIn), which is otherwise
          // unreachable here: the catalog card renders a disabled ✓ ADDED for every installed connector.
          (c.oauth && !c.releaseDeferred ? '<button class="bb xs" data-act="resign" title="' + (c.oauthAuthorized
            ? 're-run the browser OAuth sign-in — the fix for a revoked or expired grant">⏼ RE-SIGN-IN'
            : 'open the browser OAuth sign-in">⏼ SIGN IN') + '</button>' : '') +
          (c.releaseDeferred ? '' :
          '<button class="bb xs" data-act="reload">↻ RELOAD</button>' +
          '<button class="bb xs" data-act="edit">✎ EDIT</button>') +
          '<button class="bb xs danger" data-act="remove">✕ REMOVE</button>' +
        '</div></div>';
    }
    let lastList = [];
    async function refresh() {
      try {
        const j = await Harness.api.get('/api/connectors');
        const list = (j && j.connectors) || []; lastList = list;
        renderHandoffs(list);
        const overview = body.querySelector('#mc-overview');
        const notices = body.querySelector('#mc-notices');
        const connected = list.filter(c => !c.releaseDeferred && c.state === 'up').length;
        const deferred = list.filter(c => c.releaseDeferred);
        const attention = list.filter(c => !c.releaseDeferred && (c.state === 'error' || c.authRequired)).length;
        overview.textContent = list.length + ' service' + (list.length === 1 ? '' : 's') + ' · ' + connected + ' connected' + (deferred.length ? ' · ' + deferred.length + ' deferred' : '') + (attention ? ' · ' + attention + ' need attention' : '');
        // A release-wide explanation belongs once above the list, not in every saved service.
        notices.innerHTML = Array.from(new Set(deferred.map(c => c.detail).filter(Boolean))).map(note =>
          '<div class="mc-notice"><b>Service availability</b>' + esc(note) + '</div>').join('');
        if (list.length) {
          const expanded = new Set(Array.from(listEl.querySelectorAll('.mc-inspect[open]')).map(el => el.closest('.mc-row').dataset.id));
          listEl.innerHTML = list.map(row).join('');
          listEl.querySelectorAll('.mc-inspect').forEach(el => { el.open = expanded.has(el.closest('.mc-row').dataset.id); });
        }
        else {
          listEl.innerHTML = '<div class="empty-state"><span class="es-glyph">⧉</span>' +
            '<b>NO CONNECTORS YET</b><span>Attach an MCP server to give your agents external tools — GitHub, Slack, a database.</span>' +
            '<button class="es-cta" id="mc-empty-cta" type="button">+ ADD A CONNECTOR</button></div>';
          const cta = listEl.querySelector('#mc-empty-cta');
          if (cta) cta.addEventListener('click', () => { sfx('click'); const idf = body.querySelector('#mc-id'); if (idf) idf.focus(); });
        }
        wireRemoveButtons();
      } catch (_) {
        body.querySelector('#mc-overview').textContent = 'Service status unavailable';
        body.querySelector('#mc-notices').textContent = '';
        listEl.innerHTML = '<div class="mc-detail">Could not read connections. Retry when the station is available.</div>';
      }
    }
    const postJSON = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    /* ⛔ AN ERRORED ENDPOINT IS NOT AN EMPTY ONE, AND A REFUSAL IS NOT AN OFFLINE STATION.
       `(await fetch(u)).json()` resolves on 4xx/5xx: a JSON error body parses fine, `j.groups` comes back
       undefined, and the panel prints "no platform directory available" / "No keyed platform connected yet" —
       a CONFIRMED EMPTY over a read that never succeeded. A non-JSON error (the plain-text `forbidden token`
       a 403 returns) throws instead, and the catch printed "sidecar offline — start it", which is the opposite
       of true: the station answered, it just refused. Both readings send a Commander to fix the wrong thing —
       or to re-add a key they already have.

       Returns {ok, json, status, offline} so a caller can say which of the three actually happened. */
    async function readJSON(path) {
      let r;
      try { r = await fetch(path, { cache: 'no-store' }); }
      catch (_) { return { ok: false, offline: true, status: 0, json: null }; }
      if (!r.ok) return { ok: false, offline: false, status: r.status, json: null };
      try { return { ok: true, offline: false, status: r.status, json: await r.json() }; }
      catch (_) { return { ok: false, offline: false, status: r.status, json: null }; }
    }
    // the one honest sentence for a failed read: offline vs the station refusing/erroring.
    const readFailLine = (res, offlineMsg) => res.offline
      ? '<div class="mc-detail">' + esc(offlineMsg) + '</div>'
      : '<div class="mc-detail">couldn\'t read this from the station' + (res.status ? ' (HTTP ' + res.status + ')' : '') + ' — it is running, so this is not a start-it problem. Retry, and check the station log if it persists.</div>';
    async function removeConnector(id, btn) {
      if (btn) btn.disabled = true;
      try {
        const r = await postJSON('/api/connectors/remove', { id });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          notify('Connector "' + id + '" was NOT removed', 'warn');
          msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((j && j.error) || ('HTTP ' + r.status)); sfx('bad');
        } else {
          notify('Connector "' + id + '" removed'); sfx('click'); if (editing === id) resetForm(); ccRefresh();
        }
      } catch (e) { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((e && e.message) || 'request failed'); sfx('bad'); }
      if (btn && btn.isConnected) btn.disabled = false;
      refresh();
    }
    function wireRemoveButtons() {
      if (typeof ArmConfirm === 'undefined' || !ArmConfirm.wire) return;
      listEl.querySelectorAll('button[data-act="remove"]').forEach(btn => {
        const rowEl = btn.closest('.mc-row'); const id = rowEl && rowEl.dataset.id;
        if (!id) return;
        btn.dataset.wired = '1';
        ArmConfirm.wire(btn, {
          armedLabel: 'SURE? REMOVE CONNECTOR',
          restLabel: '✕ REMOVE',
          timeoutMs: 4000,
          onArm: () => sfx('bad'),
          onConfirm: () => removeConnector(id, btn)
        });
      });
    }
    listEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-act]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      const act = btn.dataset.act;
      if (act === 'edit') { const c = lastList.find(x => x.id === id); if (c) startEdit(c); return; }
      // ⏼ RE-SIGN-IN: a fresh OAuth consent for an installed connector — the callback upserts new tokens and
      // reconnects, so this works for revoked/expired grants where RELOAD just re-errors. ccSignIn owns the
      // pending/poll state; its progress lands in THIS pane's message line (msgEl), not the catalog's.
      if (act === 'resign') { sfx('click'); ccSignIn(id, msgEl); return; }
      if (act === 'remove' && btn.dataset.wired === '1') return; // ArmConfirm owns both clicks.
      if (act === 'remove') { await removeConnector(id, btn); return; } // defensive fallback for stripped builds.
      btn.disabled = true;
      try {
        if (act === 'reload') {
          msgEl.classList.remove('ok'); msgEl.textContent = 'reloading ' + id + '…';
          const j = await (await postJSON('/api/connectors/refresh', { id })).json().catch(() => ({}));
          if (j.status && j.status.state === 'up') { msgEl.classList.add('ok'); msgEl.textContent = '✓ ' + id + ' — ' + (j.status.toolCount || 0) + ' tool(s)'; }
          else { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + id + ' — ' + ((j.status && j.status.detail) || j.error || 'not connected'); }
          sfx('click');
        }
      } catch (e) { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((e && e.message) || 'request failed'); sfx('bad'); }
      refresh();
    });
    // per-connector ENABLE pill switch (upgraded presentation of the old DISABLE/ENABLE button; same server flag).
    listEl.addEventListener('change', async ev => {
      const cb = ev.target.closest('input[data-act="toggle"]'); if (!cb) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      const c = lastList.find(x => x.id === id) || {};
      cb.disabled = true;
      try {
        const r = await postJSON('/api/connectors', { id, transport: c.transport, enabled: cb.checked });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          cb.checked = !cb.checked; msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((j && j.error) || ('HTTP ' + r.status)); sfx('bad');
        } else sfx('tick');
      }
      catch (e) { cb.checked = !cb.checked; msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((e && e.message) || 'request failed'); sfx('bad'); }
      cb.disabled = false;
      refresh();
    });
    addBtn.addEventListener('click', async () => {
      const id = (idInput.value || '').trim();
      const label = (body.querySelector('#mc-label').value || '').trim();
      const tp = transport();
      if (!id) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'an id is required'; return; }
      const httpMode = tp !== 'stdio';
      const payload = { id, label, transport: httpMode ? 'http' : 'stdio', enabled: true };
      if (httpMode) {
        const url = (body.querySelector('#mc-url').value || '').trim();
        if (!url) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'a server URL is required'; return; }
        payload.url = url;
        payload.oauth = tp === 'oauth';
        const token = body.querySelector('#mc-token').value || '';
        if (tp === 'http' && token) payload.token = token;   // blank keeps the saved one (on edit)
        const h = parseKV(body.querySelector('#mc-headers').value, ':');
        if (h.bad) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'header needs "Name: value" — check: ' + h.bad; return; }
        payload.headers = h.out;
      } else {
        const agentId = (body.querySelector('#mc-agent').value || '').trim();
        const command = (body.querySelector('#mc-command').value || '').trim();
        if (!agentId) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'choose a Safe Cell agent'; return; }
        if (!command) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'a stdio command is required'; return; }
        payload.agentId = agentId;
        payload.command = command;
        const argText = body.querySelector('#mc-args').value || '';
        if (argText.trim() || !editing) payload.args = argText.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const cwd = (body.querySelector('#mc-cwd').value || '').trim();
        if (cwd) payload.cwd = cwd;
        const envText = body.querySelector('#mc-env').value || '';
        if (envText.trim()) {
          const e = parseKV(envText, '=');
          if (e.bad) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'environment needs "NAME=value" — check: ' + e.bad; return; }
          payload.env = e.out;
        }
      }
      const to = (body.querySelector('#mc-timeout').value || '').trim();
      if (to) payload.timeout = Number(to);
      msgEl.classList.remove('ok'); msgEl.textContent = (editing ? 'saving ' : 'connecting ') + id + '…';
      try {
        const j = await (await postJSON('/api/connectors', payload)).json().catch(() => ({}));
        if (tp === 'oauth' && j.saved) {
          // The unsigned 401 is expected between the durable config save and the callback. Start the same proven
          // browser flow as catalog connectors; the poll waits for oauthAuthorized before treating that 401 as final.
          await ccSignIn(id, msgEl, label || id);
          if (ccPending.has(id)) resetForm();
        } else if (j.error) { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + j.error; sfx('bad'); }
        else if (j.status && j.status.state === 'up') {
          msgEl.classList.add('ok'); msgEl.textContent = '✓ connected — ' + (j.status.toolCount || 0) + ' tool(s) available'; sfx('click');
          notify('Connector "' + id + '" ' + (editing ? 'saved' : 'connected'), 'good');
          resetForm();
        } else { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((j.status && j.status.detail) || ('state: ' + (j.state || 'error'))); sfx('bad'); }
      } catch (e) { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((e && e.message) || 'failed to reach the sidecar'); sfx('bad'); }
      refresh();
    });
    refresh();
    loadStdioAgents('');
    // NB: setupSpotify(body) is invoked from tsRefresh() above, once the JUKEBOX toolset row has mounted the sp-* markup.

    // ===== CATALOG: unified discovery over connector and platform API catalogs =====
    // Each card installs by pre-filling the SAME POST /api/connectors upsert the manual form uses; the manager
    // then really connects and reports honest live state, so a card never claims more than the backend proves.
    const ccListEl = body.querySelector('#cc-list');
    const ccMsgEl = body.querySelector('#cc-msg');
    let ccCache = [];   // flat catalog entries, so a click reads the authoritative id/url/name (never re-typed)
    let ccAlternatives = new Map();
    const ccEntry = id => ccCache.find(x => (x.catalogId || x.id) === id);
    const ccPending = new Set();   // connector ids with an in-flight OAuth sign-in (guards duplicate popups/pollers)
    const ccTimers = new Map();    // id -> live poll interval, so a CANCEL / panel-close can clear it (EL-11 #13)
    const ccPendingWin = new Map();// id -> popup window handle (browser) so a CANCEL can close a still-open consent tab
    const ccAttempts = new Map();  // id -> { attemptId, controller }; CANCEL reaches backend discovery too
    // Stop and forget the poll for a connector — used by success/error/cap paths, the CANCEL affordance, and the
    // panel-leaves-DOM self-terminate guard. Idempotent (a missing id is a no-op).
    function stopCcPoll(id) { const t = ccTimers.get(id); if (t) { clearInterval(t); ccTimers.delete(id); } }
    // Restore a signing-in card's action button back to its idle SIGN IN state so a re-click starts fresh.
    function ccResetSignBtn(id) {
      const btn = ccListEl && ccListEl.querySelector('.cc-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] button[data-cc-act]');
      if (btn && (btn.dataset.ccAct === 'signin' || btn.dataset.ccAct === 'signin-cancel')) {
        btn.dataset.ccAct = 'signin'; btn.textContent = '▸ SIGN IN'; btn.disabled = false;
        btn.title = 'opens a secure browser sign-in (OAuth)';
      }
    }
    // auth tier chip: glyph, label, colour. Drives the honest "what will adding this cost me" cue.
    // CRT glyphs, not emoji (⚡🔑🔒 punched holes in the phosphor look). ▸ = no setup; API key + OAUTH ride as plain
    // colour-coded text chips (gold / dim) — VT323 has no key/lock glyph that renders (⚿ came out as tofu), and the
    // task says plain text chips are fine. The render below omits the leading glyph when it's empty.
    const CC_CHIP = { none: ['▸', 'no setup', 'var(--ok)'], apikey: ['', 'API key', 'var(--gold)'], oauth: ['', 'sign in', 'var(--ph-dim)'] };
    /* The catalog seal (2026-08-14). ClassIcons.platformIcon resolves an entry's BESPOKE mark, else the
       seal for its CATEGORY, else null — and null renders NOTHING rather than a placeholder, so a catalog
       entry added tomorrow in a group with no art degrades to today's text-only card instead of wearing a
       mark that misdescribes it. Reuses the bay's .mkt-coin/.mkt-coin-ico pair so these ride the same
       frameless, one-phosphor treatment; a second socket idiom here would be a second thing to keep in
       sync. Guarded on ClassIcons being loaded, exactly like the marketplace's own coinInner. */
    // Simple Icons 16.12.0 (CC0); Printify: printify.com/pfh/assets/logo-small.svg. Local assets; no third-party requests at runtime.
    const CC_LOGOS = {"airtable": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z\"/></svg>", "algolia": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 0C5.445 0 .103 5.285.01 11.817c-.097 6.634 5.285 12.131 11.92 12.17a11.91 11.91 0 0 0 5.775-1.443.281.281 0 0 0 .052-.457l-1.122-.994a.79.79 0 0 0-.833-.14 9.693 9.693 0 0 1-3.923.77c-5.36-.067-9.692-4.527-9.607-9.888.084-5.293 4.417-9.573 9.73-9.573h9.73v17.296l-5.522-4.907a.407.407 0 0 0-.596.063 4.52 4.52 0 0 1-3.934 1.793 4.538 4.538 0 0 1-4.192-4.168 4.53 4.53 0 0 1 4.512-4.872 4.532 4.532 0 0 1 4.509 4.126c.018.205.11.397.265.533l1.438 1.275a.28.28 0 0 0 .462-.158 6.82 6.82 0 0 0 .099-1.725c-.232-3.376-2.966-6.092-6.345-6.3-3.873-.24-7.11 2.79-7.214 6.588-.1 3.7 2.933 6.892 6.634 6.974a6.75 6.75 0 0 0 4.136-1.294l7.212 6.394a.48.48 0 0 0 .797-.36V.456A.456.456 0 0 0 23.54 0Z\"/></svg>", "asana": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18.78 12.653c-2.882 0-5.22 2.336-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.34 5.22-5.22-2.336-5.22-5.22-5.22zm-13.56 0c-2.88 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.338 5.22-5.22-2.336-5.22-5.22-5.22zm12-6.525c0 2.883-2.337 5.22-5.22 5.22-2.882 0-5.22-2.337-5.22-5.22 0-2.88 2.338-5.22 5.22-5.22 2.883 0 5.22 2.34 5.22 5.22z\"/></svg>", "atlassian": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z\"/></svg>", "brave-search": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M15.68 0l2.096 2.38s1.84-.512 2.709.358c.868.87 1.584 1.638 1.584 1.638l-.562 1.381.715 2.047s-2.104 7.98-2.35 8.955c-.486 1.919-.818 2.66-2.198 3.633-1.38.972-3.884 2.66-4.293 2.916-.409.256-.92.692-1.38.692-.46 0-.97-.436-1.38-.692a185.796 185.796 0 01-4.293-2.916c-1.38-.973-1.712-1.714-2.197-3.633-.247-.975-2.351-8.955-2.351-8.955l.715-2.047-.562-1.381s.716-.768 1.585-1.638c.868-.87 2.708-.358 2.708-.358L8.321 0h7.36zm-3.679 14.936c-.14 0-1.038.317-1.758.69-.72.373-1.242.637-1.409.742-.167.104-.065.301.087.409.152.107 2.194 1.69 2.393 1.866.198.175.489.464.687.464.198 0 .49-.29.688-.464.198-.175 2.24-1.759 2.392-1.866.152-.108.254-.305.087-.41-.167-.104-.689-.368-1.41-.741-.72-.373-1.617-.69-1.757-.69zm0-11.278s-.409.001-1.022.206-1.278.46-1.584.46c-.307 0-2.581-.434-2.581-.434S4.119 7.152 4.119 7.849c0 .697.339.881.68 1.243l2.02 2.149c.192.203.59.511.356 1.066-.235.555-.58 1.26-.196 1.977.384.716 1.042 1.194 1.464 1.115.421-.08 1.412-.598 1.776-.834.364-.237 1.518-1.19 1.518-1.554 0-.365-1.193-1.02-1.413-1.168-.22-.15-1.226-.725-1.247-.95-.02-.227-.012-.293.284-.851.297-.559.831-1.304.742-1.8-.089-.495-.95-.753-1.565-.986-.615-.232-1.799-.671-1.947-.74-.148-.068-.11-.133.339-.175.448-.043 1.719-.212 2.292-.052.573.16 1.552.403 1.632.532.079.13.149.134.067.579-.081.445-.5 2.581-.541 2.96-.04.38-.12.63.288.724.409.094 1.097.256 1.333.256s.924-.162 1.333-.256c.408-.093.329-.344.288-.723-.04-.38-.46-2.516-.541-2.961-.082-.445-.012-.45.067-.579.08-.129 1.059-.372 1.632-.532.573-.16 1.845.009 2.292.052.449.042.487.107.339.175-.148.069-1.332.508-1.947.74-.615.233-1.476.49-1.565.986-.09.496.445 1.241.742 1.8.297.558.304.624.284.85-.02.226-1.026.802-1.247.95-.22.15-1.413.804-1.413 1.169 0 .364 1.154 1.317 1.518 1.554.364.236 1.355.755 1.776.834.422.079 1.08-.4 1.464-1.115.384-.716.039-1.422-.195-1.977-.235-.555.163-.863.355-1.066l2.02-2.149c.341-.362.68-.546.68-1.243 0-.697-2.695-3.96-2.695-3.96s-2.274.436-2.58.436c-.307 0-.972-.256-1.585-.461-.613-.205-1.022-.206-1.022-.206z\"/></svg>", "buildkite": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M23.613 8.143l-7.668-3.856v7.712l7.668-3.855zM8.166 15.857V8.143L.387 4.287V12l7.78 3.857zM.183 3.958a.382.382 0 01.377-.017l7.606 3.771 7.607-3.771a.386.386 0 01.346 0l7.668 3.857a.386.386 0 01.213.345v7.71a.388.388 0 01-.213.346l-7.668 3.86a.389.389 0 01-.562-.345v-7.09l-7.219 3.58a.392.392 0 01-.344 0L.215 12.346A.387.387 0 010 12V4.287a.385.385 0 01.183-.329z\"/></svg>", "clickup": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z\"/></svg>", "datadog": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749\"/></svg>", "deepl": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M20.907 4.93953 12.68543.18573a1.3577 1.3577 0 0 0-1.3709 0L3.09298 4.9565a1.3766 1.3766 0 0 0-.68639 1.18233v9.52646a1.3766 1.3766 0 0 0 .68639 1.19363l8.22157 4.75946.06223.03583 4.04856 2.3458-.01131-2.06106.0075-1.1446.0038.01885v-.38467c0-.23006.1188-.43371.29605-.56005l.264-.15086.12633-.06977h-.0075l4.80283-2.7795a1.3803 1.3803 0 0 0 .68639-1.19551V6.13505a1.3803 1.3803 0 0 0-.68642-1.19552m-9.85269 9.68863a1.4275 1.4275 0 0 1-.39976 1.3841 1.4086 1.4086 0 0 1-1.97054 0 1.4199 1.4199 0 0 1 0-2.06294 1.4086 1.4086 0 0 1 2.0422.07543l3.32822-1.91585.6864.38656zm5.77019-2.41367a1.4086 1.4086 0 0 1-1.97054 0 1.4256 1.4256 0 0 1-.3696-1.47837l-.0132.0075-3.7525-2.1723-.05657.05656a1.4086 1.4086 0 0 1-1.97053 0 1.4199 1.4199 0 0 1 0-2.06293 1.4086 1.4086 0 0 1 1.97242 0c.3941.37713.52422.91832.39033 1.40672l3.7808 2.20059.01886-.01886a1.4086 1.4086 0 0 1 1.97242 0 1.42746 1.42746 0 0 1 0 2.06105z\"/></svg>", "discogs": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M1.7422 11.982c0-5.6682 4.61-10.2782 10.2758-10.2782 1.8238 0 3.5372.48 5.0251 1.3175l.8135-1.4879C16.1768.588 14.2474.036 12.1908.0024h-.1944C5.4091.0144.072 5.3107 0 11.886v.1152c.0072 3.4389 1.4567 6.5345 3.7748 8.7207l1.1855-1.2814c-1.9798-1.8743-3.218-4.526-3.218-7.4585zM20.362 3.4053l-1.1543 1.2406c1.903 1.867 3.0885 4.4636 3.0885 7.3361 0 5.6658-4.61 10.2758-10.2758 10.2758-1.783 0-3.4605-.456-4.922-1.2575l-.8542 1.5214c1.7086.9384 3.6692 1.4735 5.7546 1.4759C18.6245 23.9976 24 18.6246 24 11.9988c-.0048-3.3717-1.399-6.4146-3.638-8.5935zM1.963 11.982c0 2.8701 1.2119 5.4619 3.146 7.2953l1.1808-1.2767c-1.591-1.5166-2.587-3.6524-2.587-6.0186 0-4.586 3.7293-8.3152 8.3152-8.3152 1.483 0 2.875.3912 4.082 1.0751l.8351-1.5262C15.481 2.395 13.8034 1.927 12.018 1.927 6.4746 1.9246 1.963 6.4362 1.963 11.982zm18.3702 0c0 4.586-3.7293 8.3152-8.3152 8.3152-1.4327 0-2.7837-.3648-3.962-1.0055l-.852 1.5166c1.4303.7823 3.0718 1.2287 4.814 1.2287 5.5434 0 10.055-4.5116 10.055-10.055 0-2.8077-1.1567-5.3467-3.0165-7.1729l-1.183 1.2743c1.519 1.507 2.4597 3.5924 2.4597 5.8986zm-1.9486 0c0 3.5109-2.8558 6.3642-6.3642 6.3642a6.3286 6.3286 0 01-3.0069-.756l-.8471 1.507c1.147.624 2.4597.9768 3.854.9768 4.4636 0 8.0944-3.6308 8.0944-8.0944 0-2.239-.9143-4.2692-2.3902-5.7378l-1.1783 1.267c1.1351 1.152 1.8383 2.731 1.8383 4.4732zm-14.4586 0c0 2.3014.9671 4.382 2.515 5.8578l1.1734-1.2695c-1.207-1.159-1.9606-2.786-1.9606-4.5883 0-3.5108 2.8557-6.3642 6.3642-6.3642 1.1423 0 2.215.3048 3.1437.8352l.8303-1.5167c-1.1759-.6647-2.5317-1.0487-3.974-1.0487-4.4612 0-8.092 3.6308-8.092 8.0944zm12.5292 0c0 2.4502-1.987 4.4372-4.4372 4.4372a4.4192 4.4192 0 01-2.0614-.5088l-.8351 1.4879a6.1135 6.1135 0 002.8965.727c3.3885 0 6.1434-2.7548 6.1434-6.1433 0-1.6774-.6767-3.1989-1.7686-4.3076l-1.1615 1.2503c.7559.7967 1.2239 1.8718 1.2239 3.0573zm-10.5806 0c0 1.7374.7247 3.3069 1.8886 4.4252L8.92 15.1569l.0144.0144c-.8351-.8063-1.3559-1.9366-1.3559-3.1869 0-2.4502 1.9846-4.4372 4.4372-4.4372.8087 0 1.5646.2184 2.2174.5976l.8207-1.4975a6.097 6.097 0 00-3.0381-.8063c-3.3837-.0048-6.141 2.7525-6.141 6.141zm6.681 0c0 .2952-.2424.5351-.5376.5351-.2952 0-.5375-.24-.5375-.5351 0-.2976.24-.5375.5375-.5375.2952 0 .5375.24.5375.5375zm-3.9405 0c0-1.879 1.5239-3.4029 3.4005-3.4029 1.879 0 3.4005 1.5215 3.4005 3.4029 0 1.879-1.5239 3.4005-3.4005 3.4005S8.6151 13.861 8.6151 11.982zm.1488 0c.0048 1.7974 1.4567 3.2493 3.2517 3.2517 1.795 0 3.254-1.4567 3.254-3.2517-.0023-1.7974-1.4566-3.2517-3.254-3.254-1.795 0-3.2517 1.4566-3.2517 3.254Z\"/></svg>", "elevenlabs": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M4.6035 0v24h4.9317V0zm9.8613 0v24h4.9317V0z\"/></svg>", "etsy": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M8.559 2.445c0-.325.033-.52.59-.52h7.465c1.3 0 2.02 1.11 2.54 3.193l.42 1.666h1.27c.23-4.728.43-6.784.43-6.784s-3.196.36-5.09.36H6.635L1.521.196v1.37l1.725.326c1.21.24 1.5.496 1.6 1.606 0 0 .11 3.27.11 8.64 0 5.385-.09 8.61-.09 8.61 0 .973-.39 1.333-1.59 1.573l-1.722.33V24l5.13-.165h8.55c1.935 0 6.39.165 6.39.165.105-1.17.75-6.48.855-7.064h-1.2l-1.284 2.91c-1.005 2.28-2.476 2.445-4.11 2.445h-4.906c-1.63 0-2.415-.64-2.415-2.05V12.8s3.62 0 4.79.096c.912.064 1.463.325 1.76 1.598l.39 1.695h1.41l-.09-4.278.192-4.305h-1.391l-.45 1.89c-.283 1.244-.48 1.47-1.754 1.6-1.666.17-4.815.14-4.815.14V2.45h-.05z\"/></svg>", "github": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12\"/></svg>", "gitlab": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z\"/></svg>", "gmail": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z\"/></svg>", "google-calendar": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z\"/></svg>", "google-docs": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.727 6.727H14V0H4.91c-.905 0-1.637.732-1.637 1.636v20.728c0 .904.732 1.636 1.636 1.636h14.182c.904 0 1.636-.732 1.636-1.636V6.727h-6zm-.545 10.455H7.09v-1.364h7.09v1.364zm2.727-3.273H7.091v-1.364h9.818v1.364zm0-3.273H7.091V9.273h9.818v1.363zM14.727 6h6l-6-6v6z\"/></svg>", "google-drive": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z\"/></svg>", "google-sheets": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M11.318 12.545H7.91v-1.909h3.41v1.91zM14.728 0v6h6l-6-6zm1.363 10.636h-3.41v1.91h3.41v-1.91zm0 3.273h-3.41v1.91h3.41v-1.91zM20.727 6.5v15.864c0 .904-.732 1.636-1.636 1.636H4.909a1.636 1.636 0 0 1-1.636-1.636V1.636C3.273.732 4.005 0 4.909 0h9.318v6.5h6.5zm-3.273 2.773H6.545v7.909h10.91v-7.91zm-6.136 4.636H7.91v1.91h3.41v-1.91z\"/></svg>", "grafana": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M23.02 10.59a8.578 8.578 0 0 0-.862-3.034 8.911 8.911 0 0 0-1.789-2.445c.337-1.342-.413-2.505-.413-2.505-1.292-.08-2.113.4-2.416.62-.052-.02-.102-.044-.154-.064-.22-.089-.446-.172-.677-.247-.231-.073-.47-.14-.711-.197a9.867 9.867 0 0 0-.875-.161C14.557.753 12.94 0 12.94 0c-1.804 1.145-2.147 2.744-2.147 2.744l-.018.093c-.098.029-.2.057-.298.088-.138.042-.275.094-.413.143-.138.055-.275.107-.41.166a8.869 8.869 0 0 0-1.557.87l-.063-.029c-2.497-.955-4.716.195-4.716.195-.203 2.658.996 4.33 1.235 4.636a11.608 11.608 0 0 0-.607 2.635C1.636 12.677.953 15.014.953 15.014c1.926 2.214 4.171 2.351 4.171 2.351.003-.002.006-.002.006-.005.285.509.615.994.986 1.446.156.19.32.371.488.548-.704 2.009.099 3.68.099 3.68 2.144.08 3.553-.937 3.849-1.173a9.784 9.784 0 0 0 3.164.501h.08l.055-.003.107-.002.103-.005.003.002c1.01 1.44 2.788 1.646 2.788 1.646 1.264-1.332 1.337-2.653 1.337-2.94v-.058c0-.02-.003-.039-.003-.06.265-.187.52-.387.758-.6a7.875 7.875 0 0 0 1.415-1.7c1.43.083 2.437-.885 2.437-.885-.236-1.49-1.085-2.216-1.264-2.354l-.018-.013-.016-.013a.217.217 0 0 1-.031-.02c.008-.092.016-.18.02-.27.011-.162.016-.323.016-.48v-.253l-.005-.098-.008-.135a1.891 1.891 0 0 0-.01-.13c-.003-.042-.008-.083-.013-.125l-.016-.124-.018-.122a6.215 6.215 0 0 0-2.032-3.73 6.015 6.015 0 0 0-3.222-1.46 6.292 6.292 0 0 0-.85-.048l-.107.002h-.063l-.044.003-.104.008a4.777 4.777 0 0 0-3.335 1.695c-.332.4-.592.84-.768 1.297a4.594 4.594 0 0 0-.312 1.817l.003.091c.005.055.007.11.013.164a3.615 3.615 0 0 0 .698 1.82 3.53 3.53 0 0 0 1.827 1.282c.33.098.66.14.971.137.039 0 .078 0 .114-.002l.063-.003c.02 0 .041-.003.062-.003.034-.002.065-.007.099-.01.007 0 .018-.003.028-.003l.031-.005.06-.008a1.18 1.18 0 0 0 .112-.02c.036-.008.072-.013.109-.024a2.634 2.634 0 0 0 .914-.415c.028-.02.056-.041.085-.065a.248.248 0 0 0 .039-.35.244.244 0 0 0-.309-.06l-.078.042c-.09.044-.184.083-.283.116a2.476 2.476 0 0 1-.475.096c-.028.003-.054.006-.083.006l-.083.002c-.026 0-.054 0-.08-.002l-.102-.006h-.012l-.024.006c-.016-.003-.031-.003-.044-.006-.031-.002-.06-.007-.091-.01a2.59 2.59 0 0 1-.724-.213 2.557 2.557 0 0 1-.667-.438 2.52 2.52 0 0 1-.805-1.475 2.306 2.306 0 0 1-.029-.444l.006-.122v-.023l.002-.031c.003-.021.003-.04.005-.06a3.163 3.163 0 0 1 1.352-2.29 3.12 3.12 0 0 1 .937-.43 2.946 2.946 0 0 1 .776-.101h.06l.07.002.045.003h.026l.07.005a4.041 4.041 0 0 1 1.635.49 3.94 3.94 0 0 1 1.602 1.662 3.77 3.77 0 0 1 .397 1.414l.005.076.003.075c.002.026.002.05.002.075 0 .024.003.052 0 .07v.065l-.002.073-.008.174a6.195 6.195 0 0 1-.08.639 5.1 5.1 0 0 1-.267.927 5.31 5.31 0 0 1-.624 1.13 5.052 5.052 0 0 1-3.237 2.014 4.82 4.82 0 0 1-.649.066l-.039.003h-.287a6.607 6.607 0 0 1-1.716-.265 6.776 6.776 0 0 1-3.4-2.274 6.75 6.75 0 0 1-.746-1.15 6.616 6.616 0 0 1-.714-2.596l-.005-.083-.002-.02v-.056l-.003-.073v-.096l-.003-.104v-.07l.003-.163c.008-.22.026-.45.054-.678a8.707 8.707 0 0 1 .28-1.355c.128-.444.286-.872.473-1.277a7.04 7.04 0 0 1 1.456-2.1 5.925 5.925 0 0 1 .953-.763c.169-.111.343-.213.524-.306.089-.05.182-.091.273-.135.047-.02.093-.042.138-.062a7.177 7.177 0 0 1 .714-.267l.145-.045c.049-.015.098-.026.148-.041.098-.029.197-.052.296-.076.049-.013.1-.02.15-.033l.15-.032.151-.028.076-.013.075-.01.153-.024c.057-.01.114-.013.171-.023l.169-.021c.036-.003.073-.008.106-.01l.073-.008.036-.003.042-.002c.057-.003.114-.008.171-.01l.086-.006h.023l.037-.003.145-.007a7.999 7.999 0 0 1 1.708.125 7.917 7.917 0 0 1 2.048.68 8.253 8.253 0 0 1 1.672 1.09l.09.077.089.078c.06.052.114.107.171.159.057.052.112.106.166.16.052.055.107.107.159.164a8.671 8.671 0 0 1 1.41 1.978c.012.026.028.052.04.078l.04.078.075.156c.023.051.05.1.07.153l.065.15a8.848 8.848 0 0 1 .45 1.34.19.19 0 0 0 .201.142.186.186 0 0 0 .172-.184c.01-.246.002-.532-.024-.856z\"/></svg>", "gumroad": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0Zm-.007 5.12c4.48 0 5.995 3.025 6.064 4.744h-3.239c-.069-.962-.897-2.406-2.896-2.406-2.136 0-3.514 1.857-3.514 4.126 0 2.27 1.378 4.125 3.514 4.125 1.93 0 2.758-1.512 3.103-3.025h-3.103v-1.238h6.509v6.327h-2.855v-3.989c-.207 1.444-1.102 4.264-4.617 4.264-3.516 0-5.584-2.82-5.584-6.326 0-3.645 2.276-6.602 6.618-6.602z\"/></svg>", "honeybadger": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M11.999 0c-.346 0-.691.131-.955.395L.394 11.045a1.35 1.35 0 0 0 0 1.91l6.243 6.24.915-1.95L2.306 12l9.693-9.693 1.158 1.157 1.432-1.432L12.954.395A1.346 1.346 0 0 0 11.999 0Zm5.54 1.106a.331.331 0 0 0-.218.102l-1.777 1.778-1.432 1.432-8.393 8.392h4.726l-3.76 9.26c-.139.34.29.626.55.366l1.321-1.32v-.001l1.432-1.432h.001l8.56-8.561h-4.727l2.083-4.91v.001l.854-2.012 1.112-2.623c.108-.256-.108-.485-.333-.472Zm.25 4.125-.853 2.012 4.756 4.756L12 21.693l-1.056-1.055-1.432 1.432 1.533 1.534a1.35 1.35 0 0 0 1.91 0l10.65-10.65a1.35 1.35 0 0 0 0-1.91z\"/></svg>", "hubspot": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z\"/></svg>", "huggingface": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624\"/></svg>", "intercom": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z\"/></svg>", "lemon-squeezy": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m7.4916 10.835 2.3748-6.5114a3.1497 3.1497 0 0 0-.065-2.3418C9.0315.183 6.9427-.398 5.2928.265 3.643.929 2.71 2.4348 3.512 4.3046l2.8197 6.5615c.219.509.97.489 1.16-.03m1.6798 1.0969 6.5334-2.7758c2.1699-.9219 2.7218-3.6907 1.022-5.2905l-.068-.063c-1.6669-1.5469-4.4217-1.002-5.3706 1.0359L8.3566 11.135c-.234.503.295 1.0199.8159.7979m.373.87 6.6454-2.5119c2.2078-.8349 4.6206.745 4.5886 3.0398l-.002.09c-.048 2.2358-2.3938 3.7376-4.5536 2.9467l-6.6724-2.4418a.595.595 0 0 1-.006-1.1229m-.386 1.9269 6.4375 2.9767a3.2997 3.2997 0 0 1 1.6658 1.6989c.769 1.7998-.283 3.6396-1.9328 4.3016-1.6499.662-3.4097.235-4.2097-1.6359l-2.8027-6.5694c-.217-.509.328-1.009.8419-.772\"/></svg>", "linear": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z\"/></svg>", "netlify": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M6.49 19.04h-.23L5.13 17.9v-.23l1.73-1.71h1.2l.15.15v1.2L6.5 19.04ZM5.13 6.31V6.1l1.13-1.13h.23L8.2 6.68v1.2l-.15.15h-1.2L5.13 6.31Zm9.96 9.09h-1.65l-.14-.13v-3.83c0-.68-.27-1.2-1.1-1.23-.42 0-.9 0-1.43.02l-.07.08v4.96l-.14.14H8.9l-.13-.14V8.73l.13-.14h3.7a2.6 2.6 0 0 1 2.61 2.6v4.08l-.13.14Zm-8.37-2.44H.14L0 12.82v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14Zm17.14 0h-6.58l-.14-.14v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14ZM11.05 6.55V1.64l.14-.14h1.65l.14.14v4.9l-.14.14h-1.65l-.14-.13Zm0 15.81v-4.9l.14-.14h1.65l.14.13v4.91l-.14.14h-1.65l-.14-.14Z\"/></svg>", "notion": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z\"/></svg>", "paypal": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z\"/></svg>", "porkbun": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 0C5.3708 0 .0176 5.3532.0176 11.9824.0176 18.6117 5.3708 24 12 24s11.9824-5.3532 11.9824-11.9824C23.9824 5.3883 18.6292 0 12 0ZM5.832 5.8848c1.0635.2481 2.092.6384 3.0137 1.1347-1.099.5318-1.9866 1.3824-2.6602 2.375-.4254-.5672-.6738-1.2767-.6738-2.0566 0-.5318.1076-.9923.3203-1.4531zm12.336 0c.2127.4254.3203.9213.3203 1.453 0 .78-.2484 1.4895-.6738 2.0567-.6736-.9926-1.5967-1.8432-2.6602-2.375a9.9821 9.9821 0 0 1 3.0137-1.1347zm-6.0723.8105c3.5286.0471 6.3547 2.9198 6.3203 6.457v3.8282c0 .638-.5318 1.1699-1.17 1.1699-.638 0-1.1698-.5318-1.1698-1.17v-.957H7.8516v.957c0 .6382-.5319 1.17-1.17 1.17-.638 0-1.1699-.5318-1.1699-1.17v-3.6503c0-3.5096 2.7307-6.489 6.2403-6.6309.1152-.0044.2299-.0054.3437-.0039zm1.5 3.7988c-.4963 0-.9219.4256-.9219.922 0 .248.0711.4242.213.6015.1417.2127.3536.3546.5663.461-.1418.0708-.3188.1425-.496.1425-.2128 0-.3907.176-.3907.3887s.178.3906.3906.3906h.1778c.6026 0 1.1346-.3553 1.3828-.8516.39-.1418.7092-.3896.9219-.7441.0709-.1064.0337-.2484-.0372-.2129-.1063-.0355-.2123-.034-.2832.0723-.1063.1418-.2485.2826-.4257.3535v-.1426c0-.39-.1409-.7086-.3536-.9922-.1772-.2481-.425-.3887-.7441-.3887zm0 .5313c.2127 0 .3532.1408.3887.3535v.1777c0 .1773-.0346.3543-.1055.4961-.2481-.0709-.4617-.213-.6035-.4257-.0355-.071-.0703-.14-.0703-.211 0-.2392.2063-.3906.3906-.3906z\"/></svg>", "posthog": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z\"/></svg>", "prisma": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M21.8068 18.2848L13.5528.7565c-.207-.4382-.639-.7273-1.1286-.7541-.5023-.0293-.9523.213-1.2062.6253L2.266 15.1271c-.2773.4518-.2718 1.0091.0158 1.4555l4.3759 6.7786c.2608.4046.7127.6388 1.1823.6388.1332 0 .267-.0188.3987-.0577l12.7019-3.7568c.3891-.1151.7072-.3904.8737-.7553s.1633-.7828-.0075-1.1454zm-1.8481.7519L9.1814 22.2242c-.3292.0975-.6448-.1873-.5756-.5194l3.8501-18.4386c.072-.3448.5486-.3996.699-.0803l7.1288 15.138c.1344.2856-.019.6224-.325.7128z\"/></svg>", "railway": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M.113 10.27A13.026 13.026 0 000 11.48h18.23c-.064-.125-.15-.237-.235-.347-3.117-4.027-4.793-3.677-7.19-3.78-.8-.034-1.34-.048-4.524-.048-1.704 0-3.555.005-5.358.01-.234.63-.459 1.24-.567 1.737h9.342v1.216H.113v.002zm18.26 2.426H.009c.02.326.05.645.094.961h16.955c.754 0 1.179-.429 1.315-.96zm-17.318 4.28s2.81 6.902 10.93 7.024c4.855 0 9.027-2.883 10.92-7.024H1.056zM11.988 0C7.5 0 3.593 2.466 1.531 6.108l4.75-.005v-.002c3.71 0 3.849.016 4.573.047l.448.016c1.563.052 3.485.22 4.996 1.364.82.621 2.007 1.99 2.712 2.965.654.902.842 1.94.396 2.934-.408.914-1.289 1.458-2.353 1.458H.391s.099.42.249.886h22.748A12.026 12.026 0 0024 12.005C24 5.377 18.621 0 11.988 0z\"/></svg>", "resend": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.679 0c4.648 0 7.413 2.765 7.413 6.434s-2.765 6.434-7.413 6.434H12.33L24 24h-8.245l-8.88-8.44c-.636-.588-.93-1.273-.93-1.86 0-.831.587-1.565 1.713-1.883l4.574-1.224c1.737-.465 2.936-1.81 2.936-3.572 0-2.153-1.761-3.4-3.939-3.4H0V0z\"/></svg>", "sanity": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m23.327 15.205-.893-1.555-4.321 2.632 4.799-6.11.726-.426-.179-.27.33-.421-1.515-1.261-.693.883-13.992 8.186 5.173-6.221 9.636-5.282-.915-1.769-5.248 2.876 2.584-3.106-1.481-1.305-5.816 6.994-5.777 3.168 4.423-5.847 2.771-1.442-.88-1.789-8.075 4.203L6.186 4.43 4.648 3.198 0 9.349l.072.058.868 1.768 5.153-2.683-4.696 6.207.77.617.458.885 5.425-2.974-5.974 7.185 1.481 1.304.297-.358 14.411-8.459-4.785 6.094.078.065-.007.005.992 1.726 6.364-3.877-2.451 3.954 1.642 1.077L24 15.648z\"/></svg>", "sentry": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z\"/></svg>", "shopify": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z\"/></svg>", "square": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M4.01 0A4.01 4.01 0 000 4.01v15.98c0 2.21 1.8 4 4.01 4.01h15.98C22.2 24 24 22.2 24 19.99V4A4.01 4.01 0 0019.99 0H4zm1.62 4.36h12.74c.7 0 1.26.57 1.26 1.27v12.74c0 .7-.56 1.27-1.26 1.27H5.63c-.7 0-1.26-.57-1.26-1.27V5.63a1.27 1.27 0 011.26-1.27zm3.83 4.35a.73.73 0 00-.73.73v5.09c0 .4.32.72.72.72h5.1a.73.73 0 00.73-.72V9.44a.73.73 0 00-.73-.73h-5.1Z\"/></svg>", "stripe": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z\"/></svg>", "supabase": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z\"/></svg>", "todoist": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z\"/></svg>", "unreal-engine": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 0a12 12 0 1012 12A12 12 0 0012 0zm0 23.52A11.52 11.52 0 1123.52 12 11.52 11.52 0 0112 23.52zm7.13-9.791c-.206.997-1.126 3.557-4.06 4.942l-1.179-1.325-1.988 2a7.338 7.338 0 01-5.804-2.978 2.859 2.859 0 00.65.123c.326.006.678-.114.678-.66v-5.394a.89.89 0 00-1.116-.89c-.92.212-1.656 2.509-1.656 2.509a7.304 7.304 0 012.528-5.597 7.408 7.408 0 013.73-1.721c-1.006.573-1.57 1.507-1.57 2.29 0 1.262.76 1.109.984.923v7.28a1.157 1.157 0 00.148.256 1.075 1.075 0 00.88.445c.76 0 1.747-.868 1.747-.868V9.172c0-.6-.452-1.324-.905-1.572 0 0 .838-.149 1.484.346a5.537 5.537 0 01.387-.425c1.508-1.48 2.929-1.902 4.112-2.112 0 0-2.151 1.69-2.151 3.96 0 1.687.043 5.801.043 5.801.799.771 1.986-.342 3.059-1.441Z\"/></svg>", "vercel": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m12 1.608 12 20.784H0Z\"/></svg>", "webflow": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m24 4.515-7.658 14.97H9.149l3.205-6.204h-.144C9.566 16.713 5.621 18.973 0 19.485v-6.118s3.596-.213 5.71-2.435H0V4.515h6.417v5.278l.144-.001 2.622-5.277h4.854v5.244h.144l2.72-5.244H24Z\"/></svg>", "wix": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m0 7.354 2.113 9.292h.801a1.54 1.54 0 0 0 1.506-1.218l1.351-6.34a.171.171 0 0 1 .167-.137c.08 0 .15.058.167.137l1.352 6.34a1.54 1.54 0 0 0 1.506 1.218h.805l2.113-9.292h-.565c-.62 0-1.159.43-1.296 1.035l-1.26 5.545-1.106-5.176a1.76 1.76 0 0 0-2.19-1.324c-.639.176-1.113.716-1.251 1.365l-1.094 5.127-1.26-5.537A1.33 1.33 0 0 0 .563 7.354H0zm13.992 0a.951.951 0 0 0-.951.95v8.342h.635a.952.952 0 0 0 .951-.95V7.353h-.635zm1.778 0 3.158 4.66-3.14 4.632h1.325c.368 0 .712-.181.918-.486l1.756-2.59a.12.12 0 0 1 .197 0l1.754 2.59c.206.305.55.486.918.486h1.326l-3.14-4.632L24 7.354h-1.326c-.368 0-.712.181-.918.486l-1.772 2.617a.12.12 0 0 1-.197 0L18.014 7.84a1.108 1.108 0 0 0-.918-.486H15.77z\"/></svg>", "wolfram": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M20.105 12.001l3.307-3.708-4.854-1.059.495-4.944-4.55 1.996L12 0 9.495 4.287 4.947 2.291l.494 4.944L.587 8.289l3.305 3.707-3.305 3.713 4.854 1.053-.5 4.945 4.553-1.994L12 24l2.504-4.287 4.55 1.994-.495-4.938 4.854-1.06-3.308-3.708zm1.605 2.792l-2.861-.982-1.899-2.471 2.526.942 2.234 2.511zm.459-6.096l-2.602 2.918-3.066-1.141 1.844-2.612 3.824.835zm-4.288-1.324l-1.533 2.179.088-3.162 1.788-2.415-.343 3.398zm-3.304-2.399l3.091-1.354L15.9 5.998l-2.943 1.049 1.62-2.073zm1.187 1.772l-.096 3.652-3.341 1.12V7.969l3.437-1.223zM12 1.308l1.969 3.371L12 7.199l-1.971-2.521L12 1.308zM9.423 4.974l1.619 2.072-2.948-1.048L6.332 3.62l3.091 1.354zm2.245 2.995v3.549l-3.335-1.12-.102-3.652 3.437 1.223zM7.564 6.39l.086 3.162-1.532-2.179-.341-3.397L7.564 6.39zM1.83 8.692l3.824-.83 1.839 2.612-3.065 1.136L1.83 8.692zm2.694 3.585l2.526-.937-1.9 2.471-2.861.977 2.235-2.511zm-2.093 3.159l2.929-1 3.045.896-2.622.837-3.352-.733zm3.28 5.212l.392-3.896 3.111-.982.082 3.31-3.585 1.568zm3.691-5.708l-3.498-1.03 2.226-2.892 3.335 1.126-2.063 2.796zm2.266 7.191l-1.711-2.934-.066-2.771 1.777 2.597v3.108zm-1.73-6.8L12 12.532l2.063 2.799L12 18.336l-2.062-3.005zm4.104 3.866l-1.715 2.934v-3.107l1.782-2.597-.067 2.77zm-1.514-7.052l3.341-1.126 2.221 2.892-3.499 1.03-2.063-2.796zm2.175 6.935l.077-3.31 3.116.982.386 3.901-3.579-1.573zm3.514-2.912l-2.625-.837 3.049-.896 2.928 1.003-3.352.73z\"/></svg>", "x-twitter": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z\"/></svg>", "zapier": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M4.157 0A4.151 4.151 0 0 0 0 4.161v15.678A4.151 4.151 0 0 0 4.157 24h15.682A4.152 4.152 0 0 0 24 19.839V4.161A4.152 4.152 0 0 0 19.839 0H4.157Zm10.61 8.761h.03a.577.577 0 0 1 .23.038.585.585 0 0 1 .201.124.63.63 0 0 1 .162.431.612.612 0 0 1-.162.435.58.58 0 0 1-.201.128.58.58 0 0 1-.23.042.529.529 0 0 1-.235-.042.585.585 0 0 1-.332-.328.559.559 0 0 1-.038-.235.613.613 0 0 1 .17-.431.59.59 0 0 1 .405-.162Zm2.853 1.572c.03.004.061.004.095.004.325-.011.646.064.937.219.238.144.431.355.552.609.128.279.189.582.185.888v.193a2 2 0 0 1 0 .219h-2.498c.003.227.075.45.204.642a.78.78 0 0 0 .646.265.714.714 0 0 0 .484-.136.642.642 0 0 0 .23-.318l.915.257a1.398 1.398 0 0 1-.28.537c-.14.159-.321.284-.521.355a2.234 2.234 0 0 1-.836.136 1.923 1.923 0 0 1-1.001-.245 1.618 1.618 0 0 1-.665-.703 2.221 2.221 0 0 1-.227-1.036 1.95 1.95 0 0 1 .48-1.398 1.9 1.9 0 0 1 1.3-.488Zm-9.607.023c.162.004.325.026.48.079.207.065.4.174.563.314.26.302.393.692.366 1.088v2.276H8.53l-.109-.711h-.065c-.064.163-.155.31-.272.439a1.122 1.122 0 0 1-.374.264 1.023 1.023 0 0 1-.453.083 1.334 1.334 0 0 1-.866-.264.965.965 0 0 1-.329-.801.993.993 0 0 1 .076-.431 1.02 1.02 0 0 1 .242-.363 1.478 1.478 0 0 1 1.043-.303h.952v-.181a.696.696 0 0 0-.136-.454.553.553 0 0 0-.438-.154.695.695 0 0 0-.378.086.48.48 0 0 0-.193.254l-.99-.144a1.26 1.26 0 0 1 .257-.563c.14-.174.321-.302.533-.378.261-.091.54-.136.82-.129.053-.003.106-.007.163-.007Zm4.384.007c.174 0 .347.038.506.114.182.083.34.211.458.374.257.423.377.911.351 1.406a2.53 2.53 0 0 1-.355 1.448 1.148 1.148 0 0 1-1.009.517c-.204 0-.401-.045-.582-.136a1.052 1.052 0 0 1-.48-.457 1.298 1.298 0 0 1-.114-.234h-.045l.004 1.784h-1.059v-4.713h.904l.117.805h.057c.068-.208.177-.401.328-.56a1.129 1.129 0 0 1 .843-.344h.076v-.004Zm7.559.084h.903l.113.805h.053a1.37 1.37 0 0 1 .235-.484.813.813 0 0 1 .313-.242.82.82 0 0 1 .39-.076h.234v1.051h-.401a.662.662 0 0 0-.313.008.623.623 0 0 0-.272.155.663.663 0 0 0-.174.26.683.683 0 0 0-.027.314v1.875h-1.054v-3.666Zm-17.515.003h3.262v.896L3.73 13.104l.034.113h1.973l.042.9H2.4v-.9l1.931-1.754-.045-.117H2.441v-.896Zm11.815 0h1.055v3.659h-1.055V10.45Zm3.443.684.019.016a.69.69 0 0 0-.351.045.756.756 0 0 0-.287.204c-.11.155-.174.336-.189.522h1.545c-.034-.526-.257-.787-.74-.787h.003Zm-5.718.163c-.026 0-.057 0-.083.004a.78.78 0 0 0-.31.053.746.746 0 0 0-.257.189 1.016 1.016 0 0 0-.204.695v.064c-.015.257.057.507.204.711a.634.634 0 0 0 .253.196.638.638 0 0 0 .314.061.644.644 0 0 0 .578-.265c.14-.223.204-.48.189-.74a1.216 1.216 0 0 0-.181-.711.677.677 0 0 0-.503-.257Zm-4.509 1.266a.464.464 0 0 0-.268.102.373.373 0 0 0-.114.276c0 .053.008.106.027.155a.375.375 0 0 0 .087.132.576.576 0 0 0 .397.11v.004a.863.863 0 0 0 .563-.182.573.573 0 0 0 .211-.457v-.14h-.903Z\"/></svg>", "zazzle": "<svg aria-hidden=\"true\" fill=\"currentColor\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 12C0 5.382 5.382 0 12 0s12 5.382 12 12-5.382 12-12 12S0 18.618 0 12zm5.936 6.179c.134.177.422.155.665-.045.532-.42 1.042-.753 2.016-.753 1.839 0 3.301 1.152 5.495 1.152 1.684.021 2.747-.62 3.346-1.485.465-.664.686-1.573.686-2.282 0-.997-.576-1.662-1.573-1.662-.953 0-1.373.487-1.419 1.196-.021.288-.021.843-.199 1.108-.177.288-.51.377-.908.377-1.042 0-2.283-.841-3.655-.841h-.2l8.928-7.223c.155-.112.222-.377.045-.51l-1.374-1.618c-.244-.222-.421-.199-.665 0-.466.377-.908.754-1.861.754-1.552 0-3.213-.975-5.383-.975-1.55 0-2.416.576-3.014 1.197-.576.62-.974 1.617-.974 2.57 0 .975.576 1.595 1.529 1.595.864 0 1.374-.487 1.374-1.174 0-.398.021-.753.199-1.018.155-.266.554-.51 1.108-.51.864 0 2.503.597 3.523.597h.066l-9.04 7.179c-.177.133-.177.442-.066.597Z\"/></svg>", "printify": "<svg aria-hidden=\"true\" fill=\"none\" height=\"28\" viewBox=\"0 0 25 28\" width=\"25\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m15.4984.0712891h-15.4984v7.6527509h14.351c.6618 0 1.2412.49379 1.3021 1.15749.0309.32669-.0619.63554-.24.88055-.1565.21498-.3796.38112-.6449.46372l-14.7682 4.6581v13.0431h9.62453v-8.2751c1.76987-.5586 3.54247-1.1106 5.30487-1.6935 2.1711-.7182 4.4528-1.3115 6.2732-2.7731 1.8899-1.5189 2.9004-4.0536 2.9004-6.45867 0-4.78109-3.8518-8.6553409-8.6046-8.6553409z\" fill=\"currentColor\"/></svg>"};
    function ccSeal(e) {
      return '<span class="cc-brand" aria-hidden="true">' + (CC_LOGOS[e.id] || esc(e.name.slice(0, 2).toUpperCase())) + '</span>';
    }
    function ccCard(e, ci) {
      const cardId = e.catalogId || e.id;
      const chip = e.platformApi && e.unattendedSupported === false
        ? ['', 'manual setup', 'var(--gold)']
        : (e.signInAvailable === false ? ['', e.releaseDeferred ? 'deferred' : 'sign-in unavailable', 'var(--gold)'] : (CC_CHIP[e.authType] || CC_CHIP.none));
      const origin = e.googleApi ? '<span class="cc-badge cc-official" title="StarNet connector using Google’s APIs">STARNET · GOOGLE API</span>' : e.platformApi
        ? '<span class="cc-badge cc-official" title="first-party REST API documented by the vendor">✓ official API</span>'
        : (e.official ? '<span class="cc-badge cc-official" title="first-party server, run by the vendor">✓ official</span>'
                      : '<span class="cc-badge cc-community" title="community-run server">community</span>');
      let action;
      if (e.installed) action = '<button class="bb xs" data-cc-act="manage" data-id="' + esc(cardId) + '">MANAGE SERVICE</button>';
      else if (e.platformApi) action = '<button class="bb xs" data-cc-act="platform" data-id="' + esc(cardId) + '">+ ADD KEY</button>';
      else if (e.googleApi && e.signInAvailable === false) action =
        '<button class="bb xs" disabled>' + (e.releaseDeferred ? 'DEFERRED' : 'GOOGLE SIGN-IN UNAVAILABLE') + '</button>';
      else if (e.authType === 'oauth') action = e.url
        ? '<button class="bb xs" data-cc-act="signin" data-id="' + esc(cardId) + '" title="opens a secure browser sign-in (OAuth)">' + (e.googleApi ? 'SIGN IN WITH GOOGLE' : '▸ SIGN IN') + '</button>'
        : (e.via
          // url-less oauth entry reachable through an aggregator: a LIVE jump to that card, never a mute dead button.
          ? '<button class="bb xs" data-cc-act="via" data-id="' + esc(cardId) + '" data-via="' + esc(e.via) + '" title="no direct endpoint — jump to the connector that reaches it">▸ VIA ' + esc(e.via.toUpperCase()) + '</button>'
          : '<button class="bb xs" data-cc-act="soon" disabled title="not directly wired yet — see the note">SOON</button>');   // an oauth entry with no endpoint and no aggregator is honestly not sign-in-able
      else if (e.authType === 'apikey') action = '<button class="bb xs" data-cc-act="key" data-id="' + esc(cardId) + '">+ ADD</button>';
      else action = '<button class="bb sm" data-cc-act="add" data-id="' + esc(cardId) + '">+ ADD</button>';
      const keyDelivery = e.keyHeader
        ? '<code>' + esc(e.keyHeader) + ': &hellip;</code>'
        : '<code>Authorization: Bearer &hellip;</code>';
      const keyField = e.authType === 'apikey' && !e.platformApi
        ? '<div class="cc-key" style="display:none"><input type="password" class="key-input" data-cc-key="' + esc(cardId) + '" placeholder="' + esc(e.name) + ' API key / token" autocomplete="off" spellcheck="false">' +
            '<div class="mc-hint">Stored locally by the sidecar, sent as ' + keyDelivery + ', never displayed again.</div></div>'
        : '';
      const clientField = e.googleApi && e.signInAvailable === false
        ? '<div class="mc-hint">' + esc(e.signInMessage || 'Google sign-in is not available in this build. StarNet needs to finish enabling it. No account setup is required from you.') + '</div>' : '';
      const home = e.homepage ? ' <a class="cc-home dim" href="' + esc(e.homepage) + '" target="_blank" rel="noopener">site ↗</a>' : '';
      // data-search: the console search box (stationui.js doFilter) matches textContent + this attribute, so a
      // Commander typing "google drive" reaches the Google Workspace card even though those words are only in
      // its blurb by luck. Off-screen matching text only — never rendered.
      const alias = (Array.isArray(e.aliases) && e.aliases.length) ? ' data-search="' + esc(e.aliases.join(' ')) + '"' : '';
      const presets = (Array.isArray(e.presets) && e.presets.length)
        ? '<div class="mc-hint">PRESETS · ' + e.presets.map(esc).join(' · ') + '</div>'
        : '';
      const platformMeta = e.platformApi
        ? (e.note ? '<div class="mc-hint">' + esc(e.note) + '</div>' : '') +
          '<div class="mc-url dim"><code>' + esc(e.envVar) + '</code>' +
            (e.docsUrl ? ' · <a class="dim" href="' + esc(e.docsUrl) + '" target="_blank" rel="noopener">docs ↗</a>' : '') + '</div>'
        : '';
      // data-auth / data-installed drive the tier filter above. They mirror the chip the card already
      // shows, so the filter can never disagree with what is printed on the card.
      return '<div class="cc-card' + (e.installed ? ' cc-on' : '') + '" data-id="' + esc(cardId) + '"' + alias +
          ' data-auth="' + esc(e.authType || 'none') + '" data-installed="' + (e.installed ? '1' : '0') + '"' +
          ' style="--ci:' + (ci || 0) + '">' +
          '<div class="cc-head">' + ccSeal(e) + '<div class="cc-identity"><b>' + esc(e.name) + '</b>' +
            '<span class="cc-chip" style="color:' + chip[2] + '" title="' + esc(chip[1]) + '">' + (chip[0] ? chip[0] + ' ' : '') + esc(chip[1]) + '</span></div></div>' +
          '<div class="cc-blurb dim">' + esc(e.blurb) + '</div>' + clientField + '<details class="cc-details"><summary>Connection details</summary><div class="cc-details-body">' + origin + presets + platformMeta + '</div></details>' + keyField +
          (e.installed ? '<div class="mc-hint">' + (e.releaseDeferred ? 'Saved connection retained. Open Manage Service to view or remove it.' : 'Setup saved. Open Manage Service to check access or reconnect.') + '</div>' : '') +
          '<div class="cc-acts">' + action + home + '</div>' +
        '</div>';
    }
    function ccGroupHTML(g) {
      if (!g.connectors || !g.connectors.length) return '';
      return '<div class="cc-group"><div class="sec"><span class="sec-l">' + esc(g.category) + '</span>' +
          '<span class="sec-tag">' + g.connectors.length + '</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
        '<div class="cc-grid">' + g.connectors.map((e, i) => {
          const alternate = ccAlternatives.get(e.catalogId || e.id);
          return alternate ? '<div class="cc-service">' + ccCard(e, i) + '<details class="cc-alternatives"><summary>Advanced: ' + esc(e.name) + ' API connection</summary>' + ccCard(alternate, i) + '</details></div>' : ccCard(e, i);
        }).join('') + '</div></div>';
    }
    async function ccRefresh() {
      try {
        const pair = await Promise.all([
          Harness.api.get('/api/connectors/catalog'),
          Harness.api.get('/api/servicekeys/catalog')
        ]);
        const j = pair[0] || {}, keyed = pair[1] || {};
        // A platform API is catalog-worthy but it is NOT an MCP connector. Normalize only the card grammar;
        // `platformApi` keeps its action on the KEYS/servicekeys path and prevents ccInstall from ever seeing it.
        const platformGroups = ((keyed && keyed.groups) || []).map(g => ({
          category: g.category,
          connectors: (g.platforms || []).map(p => Object.assign({}, p, {
            authType: p.unattendedSupported === false ? 'manual' : 'apikey',
            official: true,
            platformApi: true,
            catalogId: 'platform:' + p.id
          }))
        }));
        // Platform categories lead: a Commander asking for Printify should not have to scroll past the entire
        // MCP directory. Exact-name categories merge so Developer Tools does not render twice.
        const groups = [];
        ccAlternatives = new Map();
        const connections = ((j && j.groups) || []).flatMap(g => g.connectors || []);
        const serviceName = value => String(value || '').trim().toLowerCase();
        for (const group of platformGroups) {
          group.connectors = group.connectors.filter(platform => {
            const primary = connections.find(c => serviceName(c.name) === serviceName(platform.name));
            if (!primary) return true;
            ccAlternatives.set(primary.catalogId || primary.id, platform);
            return false;
          });
        }
        for (const g of platformGroups.concat((j && j.groups) || [])) {
          let out = groups.find(x => x.category === g.category);
          if (!out) { out = { category: g.category, connectors: [] }; groups.push(out); }
          out.connectors.push.apply(out.connectors, g.connectors || []);
        }
        ccCache = groups.flatMap(g => g.connectors).concat([...ccAlternatives.values()]);
        ccListEl.innerHTML = groups.map(ccGroupHTML).join('') || '<div class="mc-detail">catalog is empty.</div>';
        ccApplyFilter();   // a refresh re-renders every card, so re-assert the active tier filter
        const search = body.querySelector('.con-search-in');
        if (search && search.value.trim()) search.dispatchEvent(new Event('input', { bubbles: true }));
        if (ccJumpPending) {
          const jid = ccJumpPending; ccJumpPending = null;
          const card = ccListEl.querySelector('.cc-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(jid) : jid) + '"]');
          if (card) { if (card.hidden) ccSetFilter('all'); ccFlash(card); }
          else { ccMsgEl.classList.remove('ok'); ccMsgEl.textContent = '✕ "' + jid + '" is not in the catalog'; }
        }
      } catch (_) { ccListEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to browse the catalog.</div>'; }
    }
    /* Tier filter. Hides cards, then hides any category group left with nothing visible — a category
       heading over an empty grid reads as a broken render. The per-group count re-states what is SHOWN
       rather than the authored total, because a header claiming "7" above three cards is exactly the kind
       of small lie this project treats as a bug. */
    let ccFilter = 'all';
    const ccFiltersEl = body.querySelector('#cc-filters');
    function ccApplyFilter() {
      if (!ccListEl) return;
      let shown = 0;
      ccListEl.querySelectorAll('.cc-group').forEach(g => {
        let vis = 0;
        g.querySelectorAll('.cc-card').forEach(c => {
          const hit = ccFilter === 'all' ? true
            : ccFilter === 'installed' ? c.dataset.installed === '1'
            : c.dataset.auth === ccFilter;
          c.hidden = !hit;
        });
        // Count services, including one whose saved setup uses the alternate API path.
        for (const service of g.querySelector('.cc-grid').children) {
          if (service.matches('.cc-card') ? !service.hidden : service.querySelector('.cc-card:not([hidden])')) vis++;
        }
        g.hidden = vis === 0;
        const tag = g.querySelector('.sec-tag');
        if (tag) tag.textContent = String(vis);
        shown += vis;
      });
      // An empty result is a real answer and must say which filter produced it — never a blank pane.
      let none = ccListEl.querySelector('.cc-nores');
      if (!shown && ccFilter !== 'all') {
        if (!none) {
          none = document.createElement('div');
          none.className = 'mc-detail cc-nores';
          ccListEl.appendChild(none);
        }
        none.hidden = false;
        none.textContent = ccFilter === 'installed'
          ? 'No saved services from the catalog yet — pick ALL to connect one.'
          : 'No catalog entry uses that setup type.';
      } else if (none) none.hidden = true;
    }
    function ccSetFilter(f) {
      ccFilter = f;
      if (ccFiltersEl) ccFiltersEl.querySelectorAll('.cc-filter').forEach(x => {
        const active = x.dataset.ccFilter === f;
        x.classList.toggle('active', active);
        x.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      ccApplyFilter();
    }
    if (ccFiltersEl) ccFiltersEl.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-cc-filter]'); if (!b) return;
      ccSetFilter(b.dataset.ccFilter); sfx('tick');
    });
    // SEARCH BEATS THE TIER FILTER. The console search (stationui doFilter) marks a matching card
    // `.con-hit`, but a card this filter set `hidden` stays display:none — so searching "stripe" with
    // "▸ no setup" active lit the CATALOG rail and showed NOTHING (probed live: hit:true, painted:false).
    // The Commander who types a name has stated a stronger intent than a chip they clicked earlier, so
    // entering search resets the filter to ALL rather than leaving two filters silently ANDed.
    const ccSearchIn = body.querySelector('.con-search-in');
    if (ccSearchIn) ccSearchIn.addEventListener('input', () => {
      if ((ccSearchIn.value || '').trim() && ccFilter !== 'all') ccSetFilter('all');
    });
    async function ccInstall(id, token) {
      const e = ccEntry(id);
      if (!e || !e.url) { sfx('bad'); return; }
      ccMsgEl.classList.remove('ok'); ccMsgEl.textContent = 'connecting ' + e.name + '…';
      const payload = { id: e.id, label: e.name, transport: 'http', url: e.url, enabled: true };
      if (token) payload.token = token;
      try {
        const j = await (await postJSON('/api/connectors', payload)).json().catch(() => ({}));
        if (j.error) { ccMsgEl.textContent = '✕ ' + j.error; sfx('bad'); }
        else if (j.status && j.status.state === 'up') {
          ccMsgEl.classList.add('ok'); ccMsgEl.textContent = '✓ ' + e.name + ' connected — ' + (j.status.toolCount || 0) + ' tool(s) available'; sfx('click');
          notify('Connector "' + e.name + '" connected', 'good');
        } else { ccMsgEl.textContent = '✕ ' + ((j.status && j.status.detail) || ('could not connect (' + (j.state || 'error') + ')')); sfx('bad'); }
      } catch (err) { ccMsgEl.textContent = '✕ ' + ((err && err.message) || 'failed to reach the sidecar'); sfx('bad'); }
      ccRefresh();   // reflect the new installed state on the cards
      refresh();     // and repaint the MCP CONNECTORS list (same underlying connector set)
    }
    // OAuth sign-in: start the flow, open the provider's consent (browser tab on desktop, popup in a browser),
    // then poll until the connector connects — but only if the consent window actually opened.
    async function ccSignIn(id, msgOut, labelOverride, googleDisclosed = false) {
      // progress lands in the caller's message line: the catalog's by default, the MCP CONNECTORS pane's when the
      // ⏼ RE-SIGN-IN row action drives this (the user is looking at that tab — the catalog line is off-screen).
      const out = msgOut || ccMsgEl;
      if (ccPending.has(id)) { sfx('bad'); out.classList.remove('ok'); out.textContent = 'a sign-in is already in progress for this connector…'; return; }
      const e = ccEntry(id); const label = labelOverride || (e && e.name) || id;
      if (e && e.releaseDeferred) { out.classList.remove('ok'); out.textContent = e.signInMessage; return; }
      // Disclose the actual model/data path in the app immediately before Google consent.
      // No OAuth attempt exists until the explicit Continue action; dismissing this panel is not consent.
      if (!googleDisclosed && ((e && e.googleApi) || /^(gmail|google-(drive|calendar|docs|sheets))$/.test(id))) {
        body.querySelectorAll('.google-disclosure').forEach(node => node.remove());
        const notice = document.createElement('section');
        notice.className = 'ext-editor mc-form google-disclosure';
        notice.setAttribute('role', 'group');
        notice.setAttribute('aria-label', 'Google connection and data use');
        notice.innerHTML = '<strong>CONNECT ' + esc(label.toUpperCase()) + '</strong>' +
          '<p>' + esc((e && e.blurb) || 'Connect the selected Google service using the permissions you approve in Google.') + '</p>' +
          '<p>When an agent uses this connection, content from the Google service can be sent to your selected AI model provider. With StarNet Credits, those requests also pass through the StarNet credits gateway.</p>' +
          '<p>Sign-in credentials are saved on this device. Conversations, files and memories may retain content from your requests. Removing the connection clears its saved credentials; it does not erase previous work or revoke access in your Google account.</p>' +
          '<p><a class="bb sm" href="https://starnetos.com/legal/privacy#google-workspace" target="_blank" rel="noopener">Google data use and removal details ↗</a></p>' +
          '<div class="mc-acts"><button class="bb sm" data-google-continue>CONTINUE TO GOOGLE</button><button class="bb sm" data-google-cancel>CANCEL</button></div>';
        out.classList.remove('ok'); out.textContent = '';
        out.before(notice);
        const proceed = notice.querySelector('[data-google-continue]');
        proceed.addEventListener('click', () => {
          if (!body.isConnected || !notice.isConnected) return;
          proceed.disabled = true; notice.remove();
          ccSignIn(id, msgOut, labelOverride, true);
        });
        notice.querySelector('[data-google-cancel]').addEventListener('click', () => {
          notice.remove(); out.textContent = 'Google sign-in cancelled — no connection was started.';
        });
        notice.scrollIntoView({ block: 'center' }); proceed.focus({ preventScroll: true });
        return;
      }
      ccPending.add(id);   // one in-flight sign-in per connector — no duplicate popups / concurrent pollers
      out.classList.remove('ok'); out.textContent = 'starting sign-in for ' + label + '…';
      const attemptId = 'cc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      const controller = new AbortController();
      ccAttempts.set(id, { attemptId, controller });
      const earlyCancel = ccListEl.querySelector('.cc-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] button[data-cc-act]');
      if (earlyCancel) { earlyCancel.dataset.ccAct = 'signin-cancel'; earlyCancel.textContent = 'CANCEL'; earlyCancel.disabled = false; }
      let url;
      try {
        const startRes = await fetch('/api/connectors/oauth/start', { method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, attemptId: attemptId }) });
        const j = await startRes.json().catch(() => ({}));
        if (j.error || !j.url) { out.textContent = '✕ ' + (j.error || 'could not start sign-in'); sfx('bad'); ccPending.delete(id); ccAttempts.delete(id); ccResetSignBtn(id); return; }
        url = j.url;
      } catch (err) {
        ccPending.delete(id); ccAttempts.delete(id); ccResetSignBtn(id);
        if (controller.signal.aborted) { out.textContent = 'sign-in for ' + label + ' cancelled — press SIGN IN to try again.'; return; }
        out.textContent = '✕ ' + ((err && err.message) || 'request failed'); sfx('bad'); return;
      }
      const opened = await openSignIn(url);
      if (!opened.opened) {
        // The consent window never opened (popup-blocked in a browser, or the OS-browser hand-off failed on
        // desktop). Do NOT start the poll — a "waiting for sign-in" claim against a window that doesn't exist
        // is the exact lie this fix removes. Tell the truth and stop.
        out.textContent = '✕ couldn’t open the sign-in page for ' + label + (opened.where === 'popup' ? ' — allow pop-ups for this site, then try again.' : ' — try again.'); sfx('bad'); ccPending.delete(id); ccAttempts.delete(id); ccResetSignBtn(id); return;
      }
      const win = opened.win;   // popup handle when in a browser; null on desktop (opened in the real browser)
      ccPendingWin.set(id, win || null);   // remembered so a CANCEL can close a still-open popup
      out.textContent = 'complete the sign-in for ' + label + (opened.where === 'browser' ? ' in your browser…' : ' in the popup window…');
      // Turn the card's SIGN IN button into a visible CANCEL affordance for the duration of the poll — before this
      // the only way out of a stalled/abandoned sign-in was to wait out the 5-minute cap (EL-11 #13).
      const signBtn = ccListEl.querySelector('.cc-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] button[data-cc-act]');
      if (signBtn) { signBtn.dataset.ccAct = 'signin-cancel'; signBtn.textContent = '✕ CANCEL'; signBtn.disabled = false; signBtn.title = 'stop waiting for this sign-in'; }
      let tries = 0;
      const timer = setInterval(async () => {
        // Self-terminate the moment the panel body leaves the DOM (window closed / rerendered) — the same guard
        // buildMessaging._poll uses. Without it an abandoned sign-in kept hitting /api/connectors for ~5 min.
        if (!document.body.contains(body)) { stopCcPoll(id); ccPending.delete(id); ccPendingWin.delete(id); ccAttempts.delete(id); return; }
        tries++;
        try {
          const j = await Harness.api.get('/api/connectors');
          const c = (j.connectors || []).find(x => x.id === id);
          if (c && c.state === 'up') { stopCcPoll(id); ccPending.delete(id); ccPendingWin.delete(id); ccAttempts.delete(id); sfx('click'); notify('Connector "' + label + '" connected', 'good'); out.classList.add('ok'); out.textContent = '✓ ' + label + ' signed in — ' + (c.toolCount || 0) + ' tool(s)'; ccRefresh(); refresh(); try { if (win && !win.closed) win.close(); } catch (_) {} return; }
          if (c && c.state === 'error' && (!c.oauth || c.oauthAuthorized)) { stopCcPoll(id); ccPending.delete(id); ccPendingWin.delete(id); ccAttempts.delete(id); sfx('bad'); out.textContent = '✕ ' + label + ' — ' + (c.detail || 'connection failed'); ccRefresh(); refresh(); return; }
        } catch (_) {}
        if (tries > 150) { stopCcPoll(id); ccPending.delete(id); ccPendingWin.delete(id); ccAttempts.delete(id); ccResetSignBtn(id); out.classList.remove('ok'); out.textContent = 'Sign-in timed out. Sign in again, then return to your task.'; }   // ~5-minute cap
      }, 2000);
      ccTimers.set(id, timer);
    }
    // CANCEL a still-polling sign-in: clear the timer, drop the in-flight guard, close any popup we opened, and reset
    // the card so a re-click can start over. Honest neutral message — we are NOT claiming a failure, the user opted out.
    function ccCancelSignIn(id) {
      stopCcPoll(id);
      ccPending.delete(id);
      const attempt = ccAttempts.get(id); ccAttempts.delete(id);
      if (attempt) {
        try { attempt.controller.abort(); } catch (_) {}
        postJSON('/api/connectors/oauth/cancel', { id: id, attemptId: attempt.attemptId }).catch(() => {});
      } else postJSON('/api/connectors/oauth/cancel', { id: id }).catch(() => {});
      const w = ccPendingWin.get(id); ccPendingWin.delete(id);
      try { if (w && !w.closed) w.close(); } catch (_) {}
      ccResetSignBtn(id);
      const e = ccEntry(id); const label = (e && e.name) || id;
      ccMsgEl.classList.remove('ok'); ccMsgEl.textContent = 'sign-in for ' + label + ' cancelled — press SIGN IN to try again.'; sfx('tick');
    }
    ccListEl.addEventListener('click', async ev => {
      const copyBtn = ev.target.closest('button[data-cc-copy]');
      if (copyBtn) {
        try { await navigator.clipboard.writeText(copyBtn.dataset.ccCopy); copyBtn.textContent = 'COPIED'; sfx('tick'); }
        catch (_) { copyBtn.textContent = 'SELECT'; const code = copyBtn.previousElementSibling; try { getSelection().selectAllChildren(code); } catch (__) {} }
        setTimeout(() => { copyBtn.textContent = 'COPY'; }, 1500);
        return;
      }
      const btn = ev.target.closest('button[data-cc-act]'); if (!btn) return;
      const act = btn.dataset.ccAct, id = btn.dataset.id;
      if (act === 'manage') {
        const entry = ccEntry(id);
        if (!entry) return;
        const tab = body.querySelector('#con-tab-connectors-' + (entry.platformApi ? 'keys' : 'mcp'));
        if (tab) tab.click();
        if (entry.platformApi) { await kyRefresh(); await kyPlatformsRefresh(); }
        else {
          await refresh();
          const target = Array.from(listEl.querySelectorAll('.mc-row')).find(r => r.dataset.id === entry.id);
          if (target) ccFlash(target);
          else { msgEl.classList.remove('ok'); msgEl.textContent = 'This saved connection is no longer listed. Return to CATALOG and refresh to check its setup.'; }
        }
      }
      else if (act === 'add') { btn.disabled = true; await ccInstall(id); }
      else if (act === 'platform') {
        const entry = ccEntry(id);
        if (entry) ccPrefillPlatform(entry);
      }
      else if (act === 'key') {
        // first tap reveals the inline key field; the second (now ▶ CONNECT) submits it — no modal.
        const card = ev.target.closest('.cc-card');
        const wrap = card && card.querySelector('.cc-key');
        const input = wrap && wrap.querySelector('input[data-cc-key]');
        if (wrap && wrap.style.display === 'none') { wrap.style.display = ''; btn.textContent = '▶ CONNECT'; if (input) input.focus(); sfx('tick'); return; }
        const token = ((input && input.value) || '').trim();
        if (!token) { sfx('bad'); ccMsgEl.classList.remove('ok'); ccMsgEl.textContent = 'paste the API key first'; return; }
        btn.disabled = true; await ccInstall(id, token);
      }
      else if (act === 'signin') { btn.disabled = true; await ccSignIn(id); btn.disabled = false; }
      else if (act === 'signin-cancel') { ccCancelSignIn(id); }
      else if (act === 'via') {
        // Jump to the aggregator card that actually reaches this platform (e.g. Atlassian -> Zapier).
        const viaId = btn.dataset.via;
        const target = ccListEl.querySelector('.cc-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(viaId) : viaId) + '"]');
        const e = ccEntry(id), v = ccEntry(viaId);
        ccMsgEl.classList.remove('ok');
        if (!target || !v) { ccMsgEl.textContent = '✕ the "' + viaId + '" connector is not in the catalog'; sfx('bad'); return; }
        ccMsgEl.textContent = ((e && e.name) || id) + ' connects through ' + v.name + ' — add ' + v.name + ' with one API key.';
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('cc-jump'); void target.offsetWidth;   // restart the flash on a re-click
        target.classList.add('cc-jump');
        setTimeout(() => target.classList.remove('cc-jump'), 2500);
        sfx('tick');
      }
    });
    ccRefresh();

    // ===== KEYS: connected keyed platforms (truth from /api/connectors + catalog) + custom /api/servicekeys =====
    const kyPlatEl = body.querySelector('#ky-platforms');
    const kyListEl = body.querySelector('#ky-list');
    const kyMsgEl = body.querySelector('#ky-msg');
    const kyNameEl = body.querySelector('#ky-name');
    const kyKeyEl = body.querySelector('#ky-key');
    const kyDocsEl = body.querySelector('#ky-docs');
    // CATALOG owns discovery; KEYS owns the credential. A platform card lands on the real add form and
    // carries only public setup metadata from /api/servicekeys/catalog — never a secret or invented state.
    function ccPrefillPlatform(p) {
      const tab = body.querySelector('#con-tab-connectors-keys');
      if (tab) tab.click();
      kyNameEl.value = p.name;
      kyDocsEl.value = p.docsUrl || '';
      kyMsgEl.classList.remove('ok');
      kyMsgEl.textContent = p.unattendedSupported === false
        ? p.name + ' is watched/manual only — ' + (p.unattendedReason || 'unattended use is unsupported')
        : (p.authHint
          ? 'paste your ' + p.name + ' key — the agent will send it as  ' + p.authHint
          : 'paste your ' + p.name + ' key — the agent reads ' + (p.docsUrl || 'the docs') + ' for the right header');
      if (host) host.scrollTop = host.scrollHeight;
      kyKeyEl.focus();
      sfx('click');
    }
    // TOP: platforms whose credential is a saved key/token on a live connector config. Read-only here — each is
    // managed where it was added (its CATALOG card / MCP CONNECTORS row). hasToken/hasHeaders are the backend's honest flags;
    // we never see (or show) the value. OAuth connectors are keyless by design and stay off this list.
    async function kyPlatformsRefresh() {
      try {
        const [cRes, gRes] = await Promise.all([readJSON('/api/connectors'), readJSON('/api/connectors/catalog')]);
        // The CONNECTORS read is what decides "you have none" — if it failed, say so instead of asserting zero.
        // The catalog is only display sugar (names); a failed catalog degrades labels, never the count.
        if (!cRes.ok) { kyPlatEl.innerHTML = readFailLine(cRes, 'sidecar offline — start it to see connected platforms.'); return; }
        const cj = cRes.json, gj = gRes.json;
        const byId = {};
        for (const e of ((gj && gj.connectors) || [])) byId[e.id] = e;
        const keyed = ((cj && cj.connectors) || []).filter(c => (c.hasToken || c.hasHeaders) && !c.oauth);
        const n = body.querySelector('#ky-plat-n'); if (n) n.textContent = String(keyed.length);
        if (!keyed.length) {
          // The sentence named a destination and gave nothing to click — the same dead-end shape as the
          // inert toolset row. `data-ab-to` is the front door's own jump contract, handled by the router.
          kyPlatEl.innerHTML = '<div class="mc-detail">No keyed platform connected yet — add one from the CATALOG (the entries marked <b style="color:var(--gold)">API key</b>). ' +
            '<button type="button" class="bb xs" data-ab-to="catalog">⊞ OPEN CATALOG</button></div>';
          return;
        }
        kyPlatEl.innerHTML = keyed.map((c, i) => {
          const cat = byId[c.id];
          const b = c.state === 'up' ? ['var(--ok)', '● connected'] : (c.state === 'cached' ? ['var(--gold)', '◐ idle · starts on use'] : (c.state === 'error' ? ['var(--bad)', '✕ error'] : ['var(--ph-dim)', '○ ' + esc(c.state || 'off')]));
          return '<div class="mc-row" style="--ci:' + i + '">' +
            '<div class="mc-top"><b>' + esc((cat && cat.name) || c.label || c.id) + '</b> <span class="dim">' + esc(c.id) + '</span>' +
              '<span class="mc-state" style="color:' + b[0] + '">' + b[1] + (c.toolCount ? ' · ' + c.toolCount + ' tool' + (c.toolCount === 1 ? '' : 's') : '') + '</span></div>' +
            '<div class="mc-url dim"><span class="mc-tag">' + (c.hasHeaders && !c.hasToken ? 'header saved' : 'token saved') + '</span> managed in ' + (cat ? 'CATALOG' : 'MCP CONNECTORS') + '</div>' +
          '</div>';
        }).join('');
      } catch (_) { kyPlatEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to see connected platforms.</div>'; }
    }
    // BOTTOM: the custom store. Checkbox = kill-switch (key stays saved, agents stop seeing it); ✕ deletes.
    function kyRow(k, i) {
      const unattendedSupported = k.unattendedSupported !== false;
      const docs = k.docsUrl ? ' <a class="dim" href="' + esc(k.docsUrl) + '" target="_blank" rel="noopener">docs ↗</a>' : '';
      return '<div class="mc-row" data-id="' + esc(k.id) + '" style="--ci:' + (i || 0) + '">' +
        '<div class="mc-top">' +
          '<span class="set-row mc-enable"><input type="checkbox" data-ky-act="toggle"' + (k.enabled ? ' checked' : '') + ' aria-label="Enable key ' + esc(k.name) + '"></span>' +
          '<b>' + esc(k.name) + '</b> <span class="dim">' + esc(k.last4) + '</span>' +
          '<span class="mc-state" style="color:' + (k.enabled ? 'var(--ok)' : 'var(--ph-dim)') + '">' + (k.enabled ? '● live for agents' : '○ off') + '</span></div>' +
        '<div class="mc-url dim">env var <code>' + esc(k.envVar) + '</code>' + docs + '</div>' +
        // THE UNATTENDED GRANT, stated plainly. `enabled` = an agent may spend this while you watch;
        // this second switch = ...and while you don't (cron, Night Shift, a Telegram message). Default OFF
        // and never inferred, so pasting a key can't silently change what happens overnight.
        '<div class="set-row ky-auto"><input type="checkbox" data-ky-act="autonomy"' + (k.autonomous ? ' checked' : '') +
          (k.enabled && unattendedSupported ? '' : ' disabled') + ' aria-label="Allow unattended use of ' + esc(k.name) + '">' +
          '<span class="dim">' + (!unattendedSupported
            ? 'watched sessions only — ' + esc(k.unattendedReason || 'unattended use is unsupported')
            : (k.autonomous
              ? 'usable in scheduled &amp; messaged runs'
              : 'watched sessions only — tick to allow scheduled &amp; messaged runs')) + '</span></div>' +
        '<div class="mc-acts"><button class="bb xs danger" data-ky-act="remove">✕ REMOVE</button></div>' +
      '</div>';
    }
    async function kyRefresh() {
      // same law as readJSON's banner above: an errored read must never render as a CONFIRMED
      // empty key list, and a refusal (403 plain-text) is not an offline station.
      const res = await readJSON('/api/servicekeys');
      if (!res.ok) { kyListEl.innerHTML = readFailLine(res, 'sidecar offline — start it to manage keys.'); return; }
      const list = (res.json && res.json.keys) || [];
      const n = body.querySelector('#ky-mine-n'); if (n) n.textContent = String(list.length);
      kyListEl.innerHTML = list.length ? list.map(kyRow).join('')
        : '<div class="mc-detail">No API keys connected yet — choose a platform in CATALOG, or add a custom key below.</div>';
    }
    body.querySelector('#ky-add').addEventListener('click', async () => {
      const name = (kyNameEl.value || '').trim(), key = (kyKeyEl.value || '').trim(), docsUrl = (kyDocsEl.value || '').trim();
      kyMsgEl.classList.remove('ok');
      if (!name) { kyMsgEl.textContent = 'give the platform a name first'; sfx('bad'); kyNameEl.focus(); return; }
      if (!key) { kyMsgEl.textContent = 'paste the API key'; sfx('bad'); kyKeyEl.focus(); return; }
      try {
        // a non-JSON refusal parses to {} — without the r.ok check that {} reads as "saved".
        // A body that carries `key` is a structured verdict (saved:false = live-this-session,
        // handled below) even on a 500, so only a key-less answer is a refusal.
        const r = await postJSON('/api/servicekeys', { name, key, docsUrl });
        const j = await r.json().catch(() => ({}));
        if (!j.key && (!r.ok || j.error)) { kyMsgEl.textContent = '✕ ' + (j.error || ('the station refused (HTTP ' + r.status + ') — the key was NOT saved')); sfx('bad'); return; }
        // saved:false still means LIVE this session — surface the persistence truth instead of a flat "saved".
        kyMsgEl.classList.toggle('ok', j.saved !== false);
        kyMsgEl.textContent = j.saved === false
          ? '⚠ ' + name + ' is active for this session, but saving to disk failed — it may not survive a restart'
          : '✓ ' + name + ' saved — agents can use ' + ((j.key && j.key.envVar) || 'it') + ' in their shell';
        sfx(j.saved === false ? 'bad' : 'click');
        if (j.saved !== false) notify('Key "' + name + '" saved', 'good');
        kyNameEl.value = ''; kyKeyEl.value = ''; kyDocsEl.value = '';
      } catch (e) { kyMsgEl.textContent = '✕ ' + ((e && e.message) || 'failed to reach the sidecar'); sfx('bad'); }
      ccRefresh(); kyRefresh();
    });
    kyListEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-ky-act]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      if (btn.dataset.kyAct === 'remove') {
        try {
          const r = await postJSON('/api/servicekeys/remove', { id });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || (j.error && !j.ok)) { kyMsgEl.classList.remove('ok'); kyMsgEl.textContent = '✕ ' + (j.error || ('the station refused (HTTP ' + r.status + ') — the key was NOT removed')); sfx('bad'); }
          else { sfx('tick'); notify('Key removed'); }
        } catch (_) { kyMsgEl.classList.remove('ok'); kyMsgEl.textContent = '✕ could not reach the sidecar — the key was NOT removed'; sfx('bad'); }
        ccRefresh(); kyRefresh();
      }
    });
    kyListEl.addEventListener('change', async ev => {
      const cb = ev.target.closest('input[data-ky-act="toggle"], input[data-ky-act="autonomy"]'); if (!cb) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      const isAutonomy = cb.dataset.kyAct === 'autonomy';
      cb.disabled = true;
      try {
        // the unattended-grant switch: a ticked box the station never recorded is a false grant
        // readout, so any non-ok answer reverts the checkbox to the state the harness can prove.
        const r = isAutonomy
          ? await postJSON('/api/servicekeys/autonomy', { id, autonomous: cb.checked })
          : await postJSON('/api/servicekeys/toggle', { id, enabled: cb.checked });
        const j = await r.json().catch(() => ({}));
        if (j.key && j.saved === false) {
          // structured 500: the switch IS live this session (list + env already updated) — keep the
          // box truthful to the live state and surface the persistence gap instead of reverting.
          sfx('bad'); notify('⚠ the switch is live for this session, but saving to disk failed — it may not survive a restart', 'warn');
        }
        else if (!r.ok || (j.error && !j.ok)) { cb.checked = !cb.checked; sfx('bad'); notify('✕ ' + (j.error || ('the station refused (HTTP ' + r.status + ') — nothing changed'))); }
        else sfx('tick');
      } catch (_) { cb.checked = !cb.checked; sfx('bad'); }
      cb.disabled = false;
      ccRefresh(); kyRefresh();
    });
    kyPlatformsRefresh();
    kyRefresh();
    // panes mount once and tab clicks only toggle visibility — re-poll both lists when the Commander
    // lands on KEYS, so a connector keyed on the CATALOG tab moments ago shows up without a window reopen.
    const kyTab = body.querySelector('#con-tab-connectors-keys');
    if (kyTab) kyTab.addEventListener('click', () => { kyPlatformsRefresh(); kyRefresh(); });
    const ccTab = body.querySelector('#con-tab-connectors-catalog');
    if (ccTab) ccTab.addEventListener('click', ccRefresh);
  }

  /* ---- SPOTIFY connect (OAuth PKCE): open the consent window, then poll /api/spotify/status until the
     callback lands. The Client ID + tokens live in the sidecar; the browser only triggers the flow. ---- */
  function setupSpotify(body) {
    const statusEl = body.querySelector('#sp-status');
    const msgEl = body.querySelector('#sp-msg');
    const redirEl = body.querySelector('#sp-redir');
    const connectBtn = body.querySelector('#sp-connect');
    const disconnectBtn = body.querySelector('#sp-disconnect');
    const clientInput = body.querySelector('#sp-client');
    let pollTimer = null;
    async function refreshStatus() {
      try {
        const j = await Harness.api.get('/api/spotify/status');
        if (redirEl && j.redirectUri) redirEl.textContent = j.redirectUri;
        if (j.connected) {
          statusEl.innerHTML = '<span style="color:var(--ok)">● connected</span>' + (j.scope ? ' <span class="dim">· ' + esc(j.scope) + '</span>' : '');
          connectBtn.textContent = '↻ RECONNECT';
          disconnectBtn.style.display = '';
        } else {
          statusEl.innerHTML = j.hasClientId ? '<span class="dim">○ not connected (Client ID saved)</span>' : '<span class="dim">○ not connected</span>';
          disconnectBtn.style.display = 'none';
          connectBtn.textContent = '▶ CONNECT SPOTIFY';
        }
        return j;
      } catch (_) { statusEl.textContent = 'sidecar offline — start the full app to connect Spotify.'; return null; }
    }
    connectBtn.addEventListener('click', async () => {
      const clientId = (clientInput.value || '').trim();
      msgEl.textContent = 'opening Spotify…';
      try {
        const j = (await Harness.api.post('/api/spotify/auth/start', clientId ? { clientId } : {})).j;
        if (j.error) { msgEl.textContent = '✕ ' + j.error; sfx('bad'); return; }
        const opened = await openSignIn(j.url);
        if (!opened.opened) {
          // No consent window opened → don't poll and don't claim one is waiting (truthful-telemetry law).
          msgEl.textContent = '✕ couldn’t open the Spotify sign-in page' + (opened.where === 'popup' ? ' — allow pop-ups for this site, then try again.' : ' — try again.'); sfx('bad'); return;
        }
        msgEl.textContent = 'Approve access in ' + (opened.where === 'browser' ? 'your browser' : 'the window that opened') + ', then return here — this updates automatically.';
        sfx('click');
        let n = 0, fails = 0; clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
          // Panel closed -> stop. Without this the poll outlived the window for its full ~120s
          // (writing status into a detached tree, notifying from a dead panel), and a re-opened
          // panel's fresh CONNECT couldn't clear it (new closure, new pollTimer) — two live polls.
          // Same law as the connector-card poll above (stopCcPoll on !contains(body)).
          if (!document.body.contains(body)) { clearInterval(pollTimer); return; }
          // E6d: guard the poll body so a throw can't leak an unhandled rejection AND never stops the timer.
          // Count consecutive failures toward an EARLY bail so a persistently-broken poll gives up instead of
          // spinning the full ~120s window; a success resets the streak.
          n++;
          let s = null;
          try { s = await refreshStatus(); fails = 0; }
          catch (_) { fails++; }
          if ((s && s.connected) || n > 60 || fails >= 5) {
            clearInterval(pollTimer);
            if (s && s.connected) { msgEl.textContent = '✓ Spotify connected'; notify('Spotify connected', 'good'); sfx('click'); }
          }
        }, 2000);
      } catch (e) { msgEl.textContent = '✕ ' + ((e && e.message) || 'failed to reach the sidecar'); sfx('bad'); }
    });
    disconnectBtn.addEventListener('click', async () => {
      disconnectBtn.disabled = true;
      try {
        const out = await Harness.api.post('/api/spotify/disconnect');
        if (!out.ok || !out.j || out.j.ok === false) {
          const why = (out.j && out.j.error) || 'the station did not confirm the change';
          msgEl.textContent = '✕ ' + why;
          notify('Spotify was NOT disconnected', 'warn'); sfx('bad');
          return;
        }
        clearInterval(pollTimer); msgEl.textContent = 'disconnected'; notify('Spotify disconnected'); sfx('click');
      } catch (_) {
        msgEl.textContent = '✕ could not reach the station — Spotify was not disconnected';
        notify('Spotify was NOT disconnected', 'warn'); sfx('bad');
      } finally {
        disconnectBtn.disabled = false;
        refreshStatus();
      }
    });
    refreshStatus();
  }

  // The title must match the dock button that opens it — a window whose chrome disagrees with the button you
  // pressed reads as the wrong window, and this console now covers more than toolsets and connectors.
  StationUI.registerWindow('connectors', 'ABILITIES', buildConnectors, { console: true });
})();
