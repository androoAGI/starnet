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
      '<p class="set-about dim">Remote http(s) MCP servers. Secrets are stored locally by the sidecar and never displayed. ' +
        'Looking to chat with your agent <i>from</i> Slack or Telegram instead? That’s the <b>CHANNELS</b> window.</p>' +
      '<div id="mc-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
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
      { id: 'mcp', label: 'CONNECTED SERVICES', glyph: '⧉', desc: 'External tool servers your agents can call — GitHub, Slack, a database. Inspect connection status, reconnect, or edit advanced settings. Tool access follows the agent’s effective permissions.', build: frag(secMcp) },
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
      const adv = body.querySelector('.mc-adv'); if (adv) adv.open = false;   // a cleared form is the simple form again
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
        const adv = body.querySelector('.mc-adv');
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
      const b = badge(c.state);
      const tools = (c.tools && c.tools.length) ? '<div class="mc-tools">' + c.tools.map(t => '<code>' + esc(t) + '</code>').join('') + '</div>' : '';
      const detail = (c.state === 'error' && c.detail) ? '<div class="mc-detail">' + esc(c.detail) + '</div>' : '';
      const next = !c.enabled ? 'Turn on the switch above to let agents use this service.'
        : c.oauth && (c.authRequired || !c.oauthAuthorized) ? 'Sign in below to restore access to this account.'
        : c.state === 'error' ? 'Check the error below, then reload to retry. Use Edit if the connection details changed.'
        : c.state === 'up' ? 'Connected. Tell your agent what you want to do with this service.' : '';
      const where = c.transport === 'stdio'
        ? ('<span class="mc-tag">stdio</span> <code>' + esc([c.command].concat(c.args || []).join(' ')) + '</code>' + (c.hasEnv ? ' · env set' : '') +
           '<div class="mc-hint">isolated owner: ' + esc(c.agentId || 'unbound') + ' · persistent Safe Cell</div>')
        : ('<span class="mc-tag">' + (c.oauth ? 'oauth' : 'http') + '</span> ' + esc(c.url)
          // COPY TRUTH: a row must never read "OAuth authorized" AND "reauthentication required" at once — a
          // rejected grant (authRequired) outranks token presence (oauthAuthorized derives from a stored token).
          + (c.oauth ? (c.authRequired ? ' · OAuth grant rejected — sign in again' : (c.oauthAuthorized ? ' · OAuth authorized' : ' · OAuth sign-in needed')) : (c.hasToken ? ' · token saved' : ''))
          + (c.hasHeaders ? ' · headers set' : ''));
      const timeout = (c.timeoutMs && c.timeoutMs !== 30000) ? '<span class="dim"> · ' + Math.round(c.timeoutMs / 1000) + 's</span>' : '';
      return '<div class="mc-row" data-id="' + esc(c.id) + '" data-enabled="' + (c.enabled ? '1' : '0') + '" style="--ci:' + (ri || 0) + '">' +
        '<div class="mc-top">' +
          '<span class="set-row mc-enable"><input type="checkbox" data-act="toggle"' + (c.enabled ? ' checked' : '') + ' aria-label="Enable connector ' + esc(c.id) + '"></span>' +
          '<b>' + esc(c.label || c.id) + '</b> <span class="dim">' + esc(c.id) + '</span>' +
          '<span class="mc-state" style="color:' + b[0] + '">' + b[1] + (c.toolCount ? ' · ' + c.toolCount + ' tool' + (c.toolCount === 1 ? '' : 's') : '') + '</span></div>' +
        '<div class="mc-url dim">' + where + timeout + '</div>' +
        '<div class="mc-hint">' + (c.account && c.account.email ? 'Account at last sign-in: ' + esc(c.account.email) : 'Account identity: not verified by StarNet.') + ' Browser logins are separate from this connection.</div>' +
        (next ? '<div class="mc-hint">' + esc(next) + '</div>' : '') + detail + tools +
        '<div class="mc-acts">' +
          // an OAuth connector's stored grant can die provider-side (token revoked, DCR client deleted) — a state
          // RELOAD can't cure (it reconnects with the same dead grant) and EDIT can't reach (its form is the
          // http-bearer/stdio editor; there is no bearer to paste). A fresh browser consent is the only cure, so
          // the row always carries it — same engine as the catalog card's ▸ SIGN IN (ccSignIn), which is otherwise
          // unreachable here: the catalog card renders a disabled ✓ ADDED for every installed connector.
          (c.oauth ? '<button class="bb xs" data-act="resign" title="' + (c.oauthAuthorized
            ? 're-run the browser OAuth sign-in — the fix for a revoked or expired grant">⏼ RE-SIGN-IN'
            : 'open the browser OAuth sign-in">⏼ SIGN IN') + '</button>' : '') +
          '<button class="bb xs" data-act="reload">↻ RELOAD</button>' +
          '<button class="bb xs" data-act="edit">✎ EDIT</button>' +
          '<button class="bb xs danger" data-act="remove">✕ REMOVE</button>' +
        '</div></div>';
    }
    let lastList = [];
    async function refresh() {
      try {
        const j = await Harness.api.get('/api/connectors');
        const list = (j && j.connectors) || []; lastList = list;
        renderHandoffs(list);
        if (list.length) { listEl.innerHTML = list.map(row).join(''); }
        else {
          listEl.innerHTML = '<div class="empty-state"><span class="es-glyph">⧉</span>' +
            '<b>NO CONNECTORS YET</b><span>Attach an MCP server to give your agents external tools — GitHub, Slack, a database.</span>' +
            '<button class="es-cta" id="mc-empty-cta" type="button">+ ADD A CONNECTOR</button></div>';
          const cta = listEl.querySelector('#mc-empty-cta');
          if (cta) cta.addEventListener('click', () => { sfx('click'); const idf = body.querySelector('#mc-id'); if (idf) idf.focus(); });
        }
        wireRemoveButtons();
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage connectors.</div>'; }
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
    function ccSeal(e) {
      const svg = (typeof ClassIcons !== 'undefined' && ClassIcons.platformIcon) ? ClassIcons.platformIcon(e) : null;
      return svg ? '<span class="mkt-coin cc-seal"><span class="mkt-coin-ico">' + svg + '</span></span>' : '';
    }
    function ccCard(e, ci) {
      const cardId = e.catalogId || e.id;
      const chip = e.platformApi && e.unattendedSupported === false
        ? ['', 'manual setup', 'var(--gold)']
        : (e.signInAvailable === false ? ['', 'sign-in unavailable', 'var(--gold)'] : (CC_CHIP[e.authType] || CC_CHIP.none));
      const origin = e.googleApi ? '<span class="cc-badge cc-official" title="StarNet connector using Google’s APIs">STARNET · GOOGLE API</span>' : e.platformApi
        ? '<span class="cc-badge cc-official" title="first-party REST API documented by the vendor">✓ official API</span>'
        : (e.official ? '<span class="cc-badge cc-official" title="first-party server, run by the vendor">✓ official</span>'
                      : '<span class="cc-badge cc-community" title="community-run server">community</span>');
      let action;
      if (e.installed) action = '<button class="bb xs" data-cc-act="manage" data-id="' + esc(cardId) + '">MANAGE SERVICE</button>';
      else if (e.platformApi) action = '<button class="bb xs" data-cc-act="platform" data-id="' + esc(cardId) + '">+ ADD KEY</button>';
      else if (e.googleApi && e.signInAvailable === false) action =
        '<button class="bb xs" disabled>GOOGLE SIGN-IN UNAVAILABLE</button>';
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
          '<div class="cc-head">' + ccSeal(e) + '<b>' + esc(e.name) + '</b> ' + origin +
            '<span class="cc-chip" style="color:' + chip[2] + '" title="' + esc(chip[1]) + '">' + (chip[0] ? chip[0] + ' ' : '') + esc(chip[1]) + '</span></div>' +
          '<div class="cc-blurb dim">' + esc(e.blurb) + '</div>' + presets + (platformMeta ? '<details><summary>Setup details</summary>' + platformMeta + '</details>' : '') + keyField + clientField +
          (e.installed ? '<div class="mc-hint">Setup saved. Open Manage Service to check access or reconnect.</div>' : '') +
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
