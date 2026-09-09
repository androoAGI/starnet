/* STARNET — windows/messaging.js : the CHANNELS (messaging platforms) window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface
   (sfx/notify/openTerm/mountConsole and the live present view). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const sfx = H.sfx, notify = H.notify, openTerm = H.openTerm;
  const mountConsole = H.mountConsole;

  /* ============== MESSAGING — every messaging platform the agent can be reached on ==============
     One catalog drives the whole CHANNELS panel: each entry supplies the platform copy (setup guide, field
     markup, messages) and the panel generates the card, status painting, and connect/disconnect wiring from
     it — adding a platform is a catalog row, mirroring the sidecar's channel registry. Status truth comes
     from ONE bulk poll (GET /api/channels/status) + live channel.connect bus refreshes. Only platforms the
     LOCAL-FIRST sidecar can honestly drive are listed (webhook-only surfaces like WhatsApp stay out). */
  function buildMessaging(body) {
    // ---- the channel catalog (copy + fields per platform; ids are literal so source-guards can pin them) ----
    // `accent` gives each card its per-platform accent strip + coin (marketplace card grammar); `steps` render as
    // an <ol> inside the setup <details>; `note` is the trailing dim caveat. Secret-input id + type order is
    // load-bearing (the wire source-guard pins e.g. id="sl-bot-token" type="password") — never reorder those.
    const CHANNEL_CATALOG = [
      { id: 'telegram', title: 'TELEGRAM', pre: 'tg', accent: '#37aee2',
        tagline: 'DM your agent from Telegram.',
        verb: 'polling',
        steps: [
          '<b>Create your bot in Telegram.</b><br>Search for <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>, open the chat, and send <code>/newbot</code>. Follow its replies to choose a name and an available username ending in <code>bot</code>.',
          '<b>Connect it to StarNet.</b><br>BotFather sends you a bot token (a long code). Copy it into <b>Bot token</b> below, then click <b>CONNECT</b>.',
          '<b>Pair and start chatting.</b><br>StarNet shows a <code>/pair</code> message with a code. Copy the whole message and send it to <b>your new bot</b> in Telegram. Once pairing is confirmed, you can chat with your agent.'
        ],
        note: 'Your token is saved on this machine and never displayed.',
        fieldsHtml: '<label class="ch-lbl" for="tg-token">BOT TOKEN <span class="dim">— from @BotFather</span></label>' +
          '<input id="tg-token" type="password" class="key-input" placeholder="123456789:ABCdef..." autocomplete="off" spellcheck="false">',
        read: (b) => ({ token: (b.querySelector('#tg-token').value || '').trim() }),
        clear: (b) => { b.querySelector('#tg-token').value = ''; },
        emptyMsg: 'paste your @BotFather token first',
        okMsg: '✓ connected — Telegram is accepting owner DMs',
        // multi-bot: each additional bot is a SEPARATE Telegram contact hard-bound to one agent. The list paints
        // exclusively from the status payload's bots[] (truthful per-instance transport state); the add flow is
        // token + agent — the sidecar validates the token with getMe before anything persists.
        extraHtml:
          '<div class="ch-bots" id="tg-owner">' +
            '<div class="ch-bots-head">Pair your Telegram account <span class="dim" id="tg-owner-state">not paired</span></div>' +
            '<p class="ch-note">Pairing tells your bot which Telegram account is yours. Send the /pair message to your new bot, not to BotFather. The pairing code expires after 10 minutes.</p>' +
            '<div class="set-save"><button class="bb xs" id="tg-owner-pair">PAIR OWNER</button> <button class="bb xs danger" id="tg-owner-revoke" style="display:none">REVOKE OWNER</button></div>' +
          '</div>' +
          '<div class="ch-bots" id="tg-bots">' +
            '<div class="ch-bots-head">Agent bots <span class="dim">A separate Telegram contact per agent</span></div>' +
            '<div id="tg-bots-list"></div>' +
            '<details class="ch-setup" id="tg-bot-addbox"><summary>ADD A BOT</summary>' +
              '<ol class="ch-steps">' +
                '<li><b>Create another bot.</b><br>In Telegram, message <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> with <code>/newbot</code>. Choose a name and an available username ending in <code>bot</code>, then copy the token it sends back.</li>' +
                '<li><b>Choose its agent.</b><br>Paste the token below, choose which agent should reply, and click <b>ADD AGENT BOT</b>.</li>' +
                '<li><b>Pair and chat.</b><br>Send the full <code>/pair</code> message StarNet shows you to that new bot in Telegram. Once pairing is confirmed, message it whenever you want to talk to that agent.</li>' +
              '</ol>' +
              '<label class="ch-lbl" for="tg-bot-token">BOT TOKEN <span class="dim">— from @BotFather</span></label>' +
              '<input id="tg-bot-token" type="password" class="key-input" placeholder="123456789:ABCdef..." autocomplete="off" spellcheck="false">' +
              '<label class="ch-lbl" for="tg-bot-agent">Agent that replies</label>' +
              '<select id="tg-bot-agent" class="key-input"></select>' +
              '<div class="set-save"><button class="bb sm" id="tg-bot-add">+ ADD AGENT BOT</button></div>' +
              '<div id="tg-bots-msg" class="msg"></div>' +
            '</details>' +
          '</div>' },

      { id: 'discord', title: 'DISCORD', pre: 'dc', accent: '#7c83f5',
        // HONESTY: server/channel messages need a chat allowlist no production path supplies yet — DMs only today.
        tagline: 'DM your Discord bot to talk to your agent. Server channels are not supported yet.',
        verb: 'receiving',
        steps: [
          'Open the <b>Discord Developer Portal</b> → <b>New Application</b> → <b>Bot</b> → <b>Reset Token</b> → copy the token.',
          'Enable <b>MESSAGE CONTENT INTENT</b> on the Bot page (required to read your messages), then invite the bot to a server (OAuth2 → URL Generator → <code>bot</code> scope).',
          'Paste the token below and connect.'
        ],
        note: 'Your token is saved on this machine and never displayed.',
        fieldsHtml: '<label class="ch-lbl" for="dc-token">BOT TOKEN <span class="dim">— from the Discord Developer Portal</span></label>' +
          '<input id="dc-token" type="password" class="key-input" placeholder="MTE...Bot token" autocomplete="off" spellcheck="false">',
        read: (b) => ({ token: (b.querySelector('#dc-token').value || '').trim() }),
        clear: (b) => { b.querySelector('#dc-token').value = ''; },
        emptyMsg: 'paste your Discord bot token first',
        okMsg: '✓ connected — DM your bot on Discord',
        errHint: ' — check the bot token / MESSAGE CONTENT intent' },

      { id: 'slack', title: 'SLACK', pre: 'sl', accent: '#b98ec8',
        // HONESTY: channel messages need a chat allowlist no production path supplies yet — DMs only today.
        // audit finding 5: Slack appears in BOTH panels — say which direction THIS one is.
        tagline: 'DM your Slack app to talk to your agent. Channel conversations are not supported yet. To let your agent use Slack as a tool, open ABILITIES.',
        verb: 'receiving',
        steps: [
          'Open <b>api.slack.com/apps</b> → <b>Create New App</b> → From scratch.',
          'Enable <b>Socket Mode</b> (Settings → Socket Mode) and create an <b>app-level token</b> with <code>connections:write</code> (starts <code>xapp-</code>).',
          'Under <b>OAuth &amp; Permissions</b> add bot scopes <code>chat:write</code>, <code>im:history</code>, <code>channels:history</code> → <b>Install to Workspace</b> → copy the <b>bot token</b> (starts <code>xoxb-</code>).',
          'Under <b>Event Subscriptions</b> subscribe the bot to <code>message.im</code>.'
        ],
        note: 'Both tokens are saved on this machine and never displayed.',
        fieldsHtml: '<label class="ch-lbl" for="sl-bot-token">BOT TOKEN <span class="dim">— xoxb-…, from OAuth &amp; Permissions</span></label>' +
          '<input id="sl-bot-token" type="password" class="key-input" placeholder="xoxb-..." autocomplete="off" spellcheck="false">' +
          '<label class="ch-lbl" for="sl-app-token">APP-LEVEL TOKEN <span class="dim">— xapp-…, from Socket Mode</span></label>' +
          '<input id="sl-app-token" type="password" class="key-input" placeholder="xapp-..." autocomplete="off" spellcheck="false">',
        read: (b) => {
          const bot = (b.querySelector('#sl-bot-token').value || '').trim();
          const app = (b.querySelector('#sl-app-token').value || '').trim();
          return { token: (bot && app) ? (bot + ' ' + app) : (bot || app) };   // combined secret; sidecar splits by prefix
        },
        clear: (b) => { b.querySelector('#sl-bot-token').value = ''; b.querySelector('#sl-app-token').value = ''; },
        emptyMsg: 'paste BOTH Slack tokens first (xoxb-… and xapp-…)',
        okMsg: '✓ connected — DM your Slack app' },

      { id: 'matrix', title: 'MATRIX', pre: 'mx', accent: '#5bd18d',
        tagline: 'Reach your agent from any Matrix client (Element, …) on any homeserver.',
        verb: 'syncing',
        steps: [
          'Create a Matrix account for the agent (e.g. on <b>matrix.org</b> or your homeserver).',
          'Get an <b>access token</b> for that account (Element: Settings → Help &amp; About → Advanced → Access Token).',
          'Enter the homeserver URL + token below and connect, then invite the agent\'s account to a room from YOUR account and accept the invite once from any client.'
        ],
        note: 'Every room is owner-locked: the first person to message the agent claims it.',
        fieldsHtml: '<label class="ch-lbl" for="mx-endpoint">HOMESERVER URL <span class="dim">— e.g. https://matrix.org</span></label>' +
          '<input id="mx-endpoint" type="text" class="key-input" placeholder="https://matrix.org" autocomplete="off" spellcheck="false">' +
          '<label class="ch-lbl" for="mx-token">ACCESS TOKEN <span class="dim">— for the agent\'s Matrix account</span></label>' +
          '<input id="mx-token" type="password" class="key-input" placeholder="syt_..." autocomplete="off" spellcheck="false">',
        read: (b) => ({ token: (b.querySelector('#mx-token').value || '').trim(), endpoint: (b.querySelector('#mx-endpoint').value || '').trim() }),
        clear: (b) => { b.querySelector('#mx-token').value = ''; },
        prefill: (b, st) => { const e = b.querySelector('#mx-endpoint'); if (e && !e.value && st && st.endpoint) e.value = st.endpoint; },
        urlField: 'mx-endpoint', urlScheme: 'https',
        emptyMsg: 'enter the homeserver URL and paste an access token first',
        okMsg: '✓ connected — message the agent\'s Matrix account' },

      { id: 'signal', title: 'SIGNAL', pre: 'sg', accent: '#6aa0ff', advanced: true,
        tagline: 'Message your agent on Signal through a self-hosted signal-cli bridge.',
        verb: 'receiving',
        steps: [
          'Run the <b>signal-cli REST API</b> next to StarNet (docker: <code>bbernhard/signal-cli-rest-api</code>).',
          'Register or link a number for the agent (the bridge\'s <code>/v1/register</code> or QR link flow).',
          'Enter the bridge URL + that number below and connect, then message it from your own Signal.'
        ],
        note: 'No token needed — the bridge runs on your machine; keep it bound to localhost.',
        fieldsHtml: '<label class="ch-lbl" for="sg-endpoint">SIGNAL-CLI REST URL <span class="dim">— e.g. http://127.0.0.1:8080</span></label>' +
          '<input id="sg-endpoint" type="text" class="key-input" placeholder="http://127.0.0.1:8080" autocomplete="off" spellcheck="false">' +
          '<label class="ch-lbl" for="sg-account">REGISTERED NUMBER <span class="dim">— the agent\'s Signal number</span></label>' +
          '<input id="sg-account" type="text" class="key-input" placeholder="+15551234567" autocomplete="off" spellcheck="false">',
        read: (b) => ({ endpoint: (b.querySelector('#sg-endpoint').value || '').trim(), account: (b.querySelector('#sg-account').value || '').trim() }),
        clear: () => {},
        prefill: (b, st) => {
          const e = b.querySelector('#sg-endpoint'); if (e && !e.value && st && st.endpoint) e.value = st.endpoint;
          const a = b.querySelector('#sg-account'); if (a && !a.value && st && st.account) a.value = st.account;
        },
        urlField: 'sg-endpoint', urlScheme: 'http',
        emptyMsg: 'enter the signal-cli REST URL and the registered number first',
        okMsg: '✓ connected — message the agent on Signal' }
    ];

    // ---- console shell (the SETTINGS layout): left platform rail, one pane per platform ----
    // OVERVIEW carries the intro copy, the ONE shared autonomous-ping opt-in, and a live per-platform summary
    // (click a row → jump to that platform's pane). Each platform pane hosts the SAME catalog-generated card as
    // the old single-scroll panel — every control id (tg-token, sl-bot-token, …) is unchanged, and mountConsole
    // mounts ALL panes into `body` up-front, so the body.querySelector wiring + wire source-guards are untouched.
    // The "keeps working headless" promise is FULL-CONTRAST (a real capability, not fine print), lifted out of the
    // opacity-.55 intro. The opt-in label reads as a plain sentence with its description on its own line.
    function channelLogo(id) {
      const mark = typeof ClassIcons !== 'undefined' ? ClassIcons.brandIcon(id) : '';
      return mark ? '<span class="ch-logo" aria-hidden="true">' + mark + '</span>' : '';
    }
    const platformHints = {
      telegram: 'Private messages · optional bot per agent',
      discord: 'Private messages · requires a Discord bot',
      slack: 'Private messages · requires a Slack app',
      matrix: 'Room conversations · requires a bot account',
      signal: 'Private messages · self-hosted bridge'
    };
    const overviewHtml =
      '<div class="ch-intro"><h3>Chat with your agents anywhere</h3>' +
        '<p>Connect a messaging app to the same agents, memory, tools, and workspace you use here.</p></div>' +
      '<div class="ch-sum"><div class="ch-bots-head">Choose an app <span class="dim">Setup instructions included</span></div>' +
        CHANNEL_CATALOG.map(c =>
          '<button type="button" class="ch-sum-row" data-ch="' + c.id + '">' +
            channelLogo(c.id) + '<span class="ch-sum-copy"><span class="ch-sum-t">' + c.title + '</span>' +
              '<span class="ch-sum-help">' + platformHints[c.id] + '</span></span>' +
            '<span class="ch-state st-off" id="' + c.pre + '-sum">checking…</span><span class="ch-sum-arrow" aria-hidden="true">›</span>' +
          '</button>').join('') +
      '</div>' +
      '<div class="ch-preferences"><label class="set-row ch-optin"><span class="ch-optin-copy">' +
        '<span class="ch-optin-t">Send completed-work updates</span>' +
        '<span class="ch-optin-d dim">When autonomous work produces a result, notify me on every connected channel.</span></span>' +
        '<input type="checkbox" id="ch-notify"></label><div id="ch-notify-msg" class="msg"></div></div>' +
      '<p class="ch-headless"><b>Keep StarNet running.</b> You can close this window. Messages sent while the station app is fully off are not processed; you receive an "I was offline" note instead.</p>';
    function cardHtml(c) {
      return '<div class="ch-card" id="ch-card-' + c.id + '" style="--accent:' + c.accent + '">' +
          '<div class="ch-head">' +
            '<div class="ch-id">' +
              (c.advanced ? '<span class="ch-adv">SELF-HOSTED BRIDGE</span>' : '') +
              '<span class="ch-answers" id="' + c.pre + '-answers"></span>' +
            '</div>' +
            '<span class="ch-state" id="' + c.pre + '-status">checking…</span>' +
          '</div>' +
          '<p class="set-about ch-tagline">' + c.tagline + '</p>' +
          // OPEN by default: the steps are the whole point of a card nobody has set up yet, and a folded
          // <details> hides them at exactly the moment they are needed. paintCard folds it once this
          // platform is actually configured (and never again after the Commander toggles it by hand).
          '<details class="ch-setup" open data-autofold="1"><summary>SETUP GUIDE</summary>' +
            '<ol class="ch-steps"><li>' + c.steps.join('</li><li>') + '</li></ol>' +
            (c.note ? '<p class="ch-note">' + c.note + '</p>' : '') +
          '</details>' +
          '<section class="ch-connection"><h3 class="ch-section-title">Connection details</h3>' + c.fieldsHtml +
          '<div class="set-save">' +
            '<button class="bb sm" id="' + c.pre + '-connect">⏼ CONNECT</button> ' +
            '<button class="bb sm danger" id="' + c.pre + '-disconnect" style="display:none">⏏ DISCONNECT</button> ' +
            '<button class="bb xs danger" id="' + c.pre + '-forget" style="display:none" title="' + (c.id === 'signal' ? 'removes the saved bridge URL and registered number from this machine' : 'permanently deletes the saved token from this machine (record + OS keychain) — you’d have to set it up again') + '">' + (c.id === 'signal' ? '✕ REMOVE CONFIGURATION' : '⌫ FORGET') + '</button>' +
          '</div>' +
          '<div id="' + c.pre + '-msg" class="msg"></div>' +
          '</section>' + (c.extraHtml || '') +
        '</div>';
    }
    // Real platform marks share the station theme and stay decorative beside the text labels.
    mountConsole(body, 'messaging', [
      { id: 'overview', label: 'OVERVIEW', build: (pane) => { pane.innerHTML = overviewHtml; } }
    ].concat(CHANNEL_CATALOG.map(c => ({
      id: c.id, label: c.title, glyph: channelLogo(c.id),
      build: (pane) => { pane.innerHTML = cardHtml(c); }
    }))));
    // rail truth dots: one per platform tab, painted from the same proven status as its card (paintCard).
    for (const c of CHANNEL_CATALOG) {
      const heading = body.querySelector('.con-sec[data-section="' + c.id + '"] .sec-l');
      if (heading) heading.insertAdjacentHTML('afterbegin', channelLogo(c.id));
      const tab = body.querySelector('#con-tab-messaging-' + c.id);
      if (tab) {
        const d = document.createElement('span');
        d.className = 'ch-rail-dot st-off'; d.id = c.pre + '-dot'; d.textContent = '●';
        tab.appendChild(d);
      }
    }
    // overview rows jump to the platform pane by driving the REAL rail tab (active state/aria stay correct).
    body.querySelectorAll('.ch-sum-row').forEach(row => row.addEventListener('click', () => {
      const t = body.querySelector('#con-tab-messaging-' + row.dataset.ch);
      if (t) { t.click(); sfx('click'); }
    }));

    // per-card mutable UI state kept out of the DOM: are we mid-connect (finalize the msg from the PROVEN status,
    // not the POST), and the saved placeholders (restored when a card goes back to un-configured).
    const configuredById = {};
    const pendingConnect = {};
    // A pairing code is returned exactly once. Keep its instruction outside the repainting DOM so a later
    // channel.connect event cannot replace it with a generic success line (the live-reported lost-code bug).
    const pairingInstruction = {};
    const savedPlaceholder = {};

    // status-line colour by state as a CLASS (never inline el.style.color — truthful-telemetry palette lives in css).
    function stateClass(conn, inFlight, state, configured) {
      if (conn) return 'st-up';
      if (state === 'error') return 'st-err';
      if (inFlight) return 'st-wait';
      return configured ? 'st-wait' : 'st-off';
    }
    function setMsg(el, text, kind) {   // kind: 'ok' (success/gold) | 'info' (neutral) | '' (error/red default)
      if (!el) return;
      el.className = 'msg' + (kind === 'ok' ? ' ok' : kind === 'info' ? ' info' : '');
      el.textContent = text || '';
    }

    // ---- multi-bot telegram: paint the AGENT BOTS list from status.bots (per-instance transport truth) ----
    function paintTelegramBots(bots) {
      const list = body.querySelector('#tg-bots-list');
      if (!list) return;
      list.textContent = '';
      for (const bItem of (Array.isArray(bots) ? bots : [])) {
        const acceptingDms = bItem.acceptingDms === true;
        const pairingBlocked = !!bItem.connected && !acceptingDms;
        const row = document.createElement('div');
        row.className = 'tg-bot-row' + (acceptingDms ? ' on' : '');
        row.dataset.bot = String(bItem.botId || '');
        const name = document.createElement('span');
        name.className = 'tg-bot-name';
        name.textContent = (bItem.username ? '@' + bItem.username : 'bot ' + bItem.botId) + ' → ' + (bItem.agentName || bItem.agentId || '?');
        const state = document.createElement('span');
        const inFlight = !bItem.connected && (bItem.state === 'connecting' || bItem.state === 'reconnecting');
        const deliveryDown = !!(bItem.delivery && bItem.delivery.state === 'down');
        const runBlocked = bItem.runReady === false;
        state.className = 'ch-state ' + ((deliveryDown || runBlocked) ? 'st-err' : pairingBlocked ? 'st-wait' : stateClass(bItem.connected, inFlight, bItem.state, bItem.configured));
        state.textContent = runBlocked ? ('✕ replies blocked · ' + (bItem.runDetail || 'agent model unavailable')) : deliveryDown ? '✕ replies blocked · polling' : pairingBlocked ? '◐ polling · pair owner' : acceptingDms ? '● connected' : inFlight ? '◐ connecting…'
          : bItem.state === 'error' ? ('✕ ' + (bItem.detail || 'error')) : (bItem.enabled === false ? '○ off' : '○ offline');
        if (bItem.ownerLocked) state.title = 'owner-locked';
        if (runBlocked) state.title = 'Telegram transport may be polling, but this agent cannot run: ' + (bItem.runDetail || 'provider/model unavailable');
        if (bItem.delivery && bItem.delivery.state === 'down') state.title = 'outbound delivery degraded' + (bItem.delivery.detail ? ': ' + bItem.delivery.detail : '');
        if (bItem.warning) state.textContent += ' ⚠ ' + bItem.warning;
        row.appendChild(name); row.appendChild(state);
        const btn = (label, act, danger) => {
          const b = document.createElement('button');
          b.className = 'bb xs' + (danger ? ' danger' : ''); b.textContent = label; b.dataset.act = act; b.dataset.bot = String(bItem.botId || '');
          row.appendChild(b); return b;
        };
        if (!bItem.ownerLocked) btn('PAIR', 'pair', false).title = 'issue a local owner pairing code for this bot';
        else btn('UNPAIR', 'revokeOwner', true).title = 'revoke this bot owner locally';
        if (!bItem.connected && bItem.configured) btn('⏵', 'resume', false).title = 'reconnect this bot';
        if (bItem.connected || bItem.enabled !== false) btn('⏏', 'off', false).title = 'disconnect (token kept)';
        btn('⌫', 'forget', true).title = 'forget this bot — removes its saved token';
        list.appendChild(row);
      }
      const wrap = body.querySelector('#tg-bots');
      if (wrap) wrap.classList.toggle('empty', !(Array.isArray(bots) && bots.length));
    }

    function paintCard(c, st) {
      const el = body.querySelector('#' + c.pre + '-status');
      if (!el) return;
      const conn = !!(st && st.connected);
      const state = st && st.state;
      const inFlight = !conn && (state === 'connecting' || state === 'reconnecting');
      const configured = !!(st && st.configured);
      // Telegram has two separate truths: Bot API polling and admitted owner DMs. Polling without a paired owner
      // is real transport health, but it is not an operational channel; ordinary messages are refused by design.
      const pairingBlocked = c.id === 'telegram' && conn && !(st && st.acceptingDms === true);
      configuredById[c.id] = configured;
      el.className = 'ch-state ' + (pairingBlocked ? 'st-wait' : stateClass(conn, inFlight, state, configured));
      el.textContent = pairingBlocked ? '◐ POLLING — DMs BLOCKED: PAIR OWNER'
        : conn ? ('● CONNECTED — ' + c.verb + (state && state !== 'up' ? ' (' + state + ')' : ''))
        : inFlight ? ('◐ ' + (state === 'reconnecting' ? 'reconnecting' : 'connecting') + '…' + (st.detail ? ' — ' + st.detail : ''))
        : state === 'error' ? ('✕ error' + (st.detail ? ' — ' + st.detail : '') + (c.errHint || ''))
        : configured ? ('○ saved but offline — RESUME to reconnect' + (st.detail ? ' — ' + st.detail : ''))
        : '○ not connected';
      // a standing backend warning (e.g. the owner binding failed to persist) rides EVERY state — real risk
      // the Commander must see, straight from channelStatusPayload (self-heals server-side once the disk agrees).
      if (st && st.warning) el.textContent += ' ⚠ ' + st.warning;
      // rail dot + overview summary row ride the SAME proven status (one truth, three projections)
      const dot = body.querySelector('#' + c.pre + '-dot');
      if (dot) dot.className = 'ch-rail-dot ' + (pairingBlocked ? 'st-wait' : stateClass(conn, inFlight, state, configured));
      const sum = body.querySelector('#' + c.pre + '-sum');
      if (sum) {
        sum.className = 'ch-state ' + (pairingBlocked ? 'st-wait' : stateClass(conn, inFlight, state, configured));
        sum.textContent = pairingBlocked ? '◐ polling — pair owner' : conn ? '● connected' : inFlight ? '◐ connecting…'
          : state === 'error' ? '✕ error' : configured ? '○ saved — offline' : '○ not connected';
      }
      // SETUP GUIDE auto-fold — keyed off `configured` (a real saved config), never off `conn`: a platform
      // that is saved-but-offline is set up, while a cold card still needs its steps in front of the user.
      // One-shot: activating the SUMMARY clears the flag, after which we never move it again. Do not listen
      // for `toggle` here: assigning guide.open below emits that event too, so the old listener mistook our
      // automatic fold for a hand toggle and left a later cold/unconfigured card collapsed.
      const guide = body.querySelector('#ch-card-' + c.id + ' .ch-setup');
      if (guide && !guide.dataset.foldWired) {
        guide.dataset.foldWired = '1';
        const summary = guide.querySelector('summary');
        if (summary) summary.addEventListener('click', () => { delete guide.dataset.autofold; });
      }
      if (guide && guide.dataset.autofold === '1') guide.open = !configured;
      if (c.prefill) { try { c.prefill(body, st); } catch (_) {} }
      const card = body.querySelector('#ch-card-' + c.id);
      if (card) card.classList.toggle('on', conn && !pairingBlocked);

      // ANSWERS AS / owner-locked truth line (only once a config exists — never claim an identity for a cold card).
      const ans = body.querySelector('#' + c.pre + '-answers');
      if (ans) {
        const nm = (st && st.agentName || '').trim();
        const bits = [];
        if ((conn || configured) && nm) bits.push((pairingBlocked ? 'WILL ANSWER AS: ' : 'ANSWERS AS: ') + nm);
        if (st && st.ownerLocked) bits.push('owner-locked ✓');
        if (c.id === 'telegram' && st && st.delivery && st.delivery.state === 'down') bits.push('OUTBOUND DEGRADED: ' + (st.delivery.detail || 'send failed'));
        ans.textContent = bits.join('  ·  ');
        ans.style.display = bits.length ? '' : 'none';
      }

      // buttons follow state: DISCONNECT/FORGET only when there is something to act on; CONNECT relabels to RESUME
      // when saved-but-offline, and disables to a neutral "connecting…" while a round-trip is in flight.
      const cBtn = body.querySelector('#' + c.pre + '-connect');
      const dBtn = body.querySelector('#' + c.pre + '-disconnect');
      const fBtn = body.querySelector('#' + c.pre + '-forget');
      if (cBtn) {
        cBtn.disabled = inFlight;
        cBtn.textContent = inFlight ? '◐ CONNECTING…' : (configured && !conn ? '⏵ RESUME' : '⏼ CONNECT');
      }
      if (dBtn) { dBtn.style.display = (conn || configured) ? '' : 'none'; if (!(conn || configured)) disarm(c.pre + '-disconnect', dBtn, '⏏ DISCONNECT'); }
      if (fBtn) { fBtn.style.display = configured ? '' : 'none'; if (!configured) disarm(c.pre + '-forget', fBtn, c.id === 'signal' ? '✕ REMOVE CONFIGURATION' : '⌫ FORGET'); }

      // saved-but-offline: swap the password placeholder to a non-echoing hint (never render the secret).
      body.querySelectorAll('#ch-card-' + c.id + ' input[type=password]').forEach(inp => {
        if (savedPlaceholder[inp.id] == null) savedPlaceholder[inp.id] = inp.getAttribute('placeholder') || '';
        inp.placeholder = (configured && !inp.value) ? '•••• saved — paste to replace' : savedPlaceholder[inp.id];
      });

      if (c.id === 'telegram') {
        try { paintTelegramBots(st && st.bots); } catch (_) {}
        const ownerState = body.querySelector('#tg-owner-state');
        const pairBtn = body.querySelector('#tg-owner-pair');
        const revokeBtn = body.querySelector('#tg-owner-revoke');
        const ownerLocked = !!(st && st.ownerLocked);
        const pairingActive = !!(st && st.ownerPairingActive);
        if (ownerState) ownerState.textContent = ownerLocked ? 'owner paired'
          : pairingActive ? 'pairing code active - awaiting /pair' : 'not paired';
        if (pairBtn) { pairBtn.style.display = configured && !ownerLocked ? '' : 'none'; pairBtn.disabled = !configured; }
        if (revokeBtn) { revokeBtn.style.display = ownerLocked ? '' : 'none'; if (!ownerLocked) disarm('tg-owner-revoke', revokeBtn, 'REVOKE OWNER'); }
        const msgEl = body.querySelector('#tg-msg');
        if (ownerLocked && pairingInstruction.telegram) {
          delete pairingInstruction.telegram;
          setMsg(msgEl, '✓ owner paired — Telegram is connected and accepting DMs', 'ok');
        } else if (!ownerLocked && !pairingActive && pairingInstruction.telegram) {
          delete pairingInstruction.telegram;
          setMsg(msgEl, 'pairing code expired — click PAIR OWNER for a fresh one', 'info');
        }
      }

      // finalize a pending connect's MESSAGE from the proven status (not the optimistic POST body).
      if (pendingConnect[c.id]) {
        const msgEl = body.querySelector('#' + c.pre + '-msg');
        if (conn) {
          if (c.id === 'telegram' && !(st && st.acceptingDms === true)) {
            setMsg(msgEl, pairingInstruction.telegram || 'Telegram is polling, but DMs stay blocked until you click PAIR OWNER and send the /pair command.', 'info');
          } else setMsg(msgEl, c.okMsg, 'ok');
          delete pendingConnect[c.id];
          // first-steps: only ticked on the PROVEN round-trip (this branch), never on the optimistic POST.
          try { if (typeof Tutorial !== 'undefined' && Tutorial.tickBrief) Tutorial.tickBrief('channel'); } catch (_) {}
        }
        else if (state === 'error') { setMsg(msgEl, '✕ ' + ((st && st.detail) || 'connection failed') + (c.errHint || ''), ''); delete pendingConnect[c.id]; }
        // else still 'connecting' — leave the neutral connecting… line until the transport proves one way or the other.
      }
    }

    // ---- armed-confirm helper: a danger action needs a second click within 2s (no accidental token loss) ----
    const armTimers = {};
    function disarm(id, btn, label) { if (armTimers[id]) { clearTimeout(armTimers[id]); delete armTimers[id]; } if (btn) { btn.classList.remove('armed'); btn.textContent = label; } }
    function armed(id, btn, label, confirmLabel, run) {
      if (btn.dataset.armed === '1') { disarm(id, btn, label); btn.dataset.armed = ''; run(); return; }
      btn.dataset.armed = '1'; btn.classList.add('armed'); btn.textContent = confirmLabel;
      armTimers[id] = setTimeout(() => { btn.dataset.armed = ''; disarm(id, btn, label); }, 2000);
    }

    let zeroChannelHintShown = false;
    async function refreshAll() {
      try {
        const r = await fetch('/api/channels/status');
        const all = await r.json();
        let notifyOn = false, anyConnected = false;
        for (const c of CHANNEL_CATALOG) { const st = all[c.id]; if (st) { paintCard(c, st); notifyOn = notifyOn || !!st.notifyAutonomous; anyConnected = anyConnected || !!st.connected; } }
        const nb = body.querySelector('#ch-notify'); if (nb) nb.checked = notifyOn;
        // notify is on but nothing is connected → it can never fire; say so honestly (don't imply pings will arrive).
        const nMsg = body.querySelector('#ch-notify-msg');
        if (notifyOn && !anyConnected) { setMsg(nMsg, 'no channel connected yet — connect one below so these pings have somewhere to go', 'info'); zeroChannelHintShown = true; }
        else if (zeroChannelHintShown) { setMsg(nMsg, '', 'info'); zeroChannelHintShown = false; }
      } catch (_) {
        for (const c of CHANNEL_CATALOG) {
          const el = body.querySelector('#' + c.pre + '-status');
          if (el) { el.className = 'ch-state st-off'; el.textContent = '○ sidecar offline'; }
          const dot = body.querySelector('#' + c.pre + '-dot');
          if (dot) dot.className = 'ch-rail-dot st-off';
          const sum = body.querySelector('#' + c.pre + '-sum');
          if (sum) { sum.className = 'ch-state st-off'; sum.textContent = '○ sidecar offline'; }
          configuredById[c.id] = false;
        }
      }
    }
    buildMessaging._refresh = refreshAll;
    // live transport health: channel.connect (up/down/error) is emitted + SSE-broadcast by every hub — one
    // subscription refreshes whichever card it names, the moment health changes (not only on panel reopen).
    if (!buildMessaging._wired && typeof U !== 'undefined' && U.bus) {
      buildMessaging._wired = true;
      U.bus.on('channel.connect', p => {
        if (p && p.channel && buildMessaging._refresh && document.querySelector('.ch-card')) buildMessaging._refresh();
      });
    }
    // 30s heartbeat re-poll while the panel is open — a background reconnect/drop repaints without a manual reopen.
    // Self-terminating: the moment this panel's body leaves the DOM (window closed / rerendered) the timer clears.
    if (buildMessaging._poll) { clearInterval(buildMessaging._poll); }
    buildMessaging._poll = setInterval(() => {
      if (!document.body.contains(body)) { clearInterval(buildMessaging._poll); buildMessaging._poll = null; return; }
      refreshAll();
    }, 30000);

    // ---- connect / disconnect / forget wiring, generated per card from the catalog ----
    // the SAME selected agent supplies the id, prompt AND name (previously the id came from the active workstream
    // but the prompt/name came from present[0] — a mismatch whenever the active stream wasn't the first agent).
    function agentIdentity() {
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
      const wsAgentId = ws && ws.agentId;
      let ag = null;
      if (wsAgentId) ag = H.present.find(a => a && a.id === wsAgentId) || null;
      if (!ag) ag = H.present[0] || null;
      return { agentId: (ag && ag.id) || wsAgentId || 'agent', system: (ag && ag.systemPrompt) || '', agentName: (ag && ag.name) || '' };
    }
    // normalize a URL-shape config field client-side: prepend the scheme when the user typed a bare host, and write
    // the normalized value back so what they see is what we send. Returns '' when there's nothing usable.
    function normalizeUrl(raw, scheme) {
      let v = String(raw || '').trim();
      if (!v) return '';
      if (!/^https?:\/\//i.test(v)) v = scheme + '://' + v.replace(/^\/+/, '');
      try { const u = new URL(v); if (!u.hostname) return ''; return u.origin + (u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : ''); }
      catch (_) { return ''; }
    }
    for (const c of CHANNEL_CATALOG) {
      const msgEl = body.querySelector('#' + c.pre + '-msg');
      body.querySelector('#' + c.pre + '-connect').addEventListener('click', async () => {
        // URL-shape validation + auto-scheme for the endpoint channels, written back into the field before we read.
        if (c.urlField) {
          const inp = body.querySelector('#' + c.urlField);
          if (inp && inp.value.trim()) {
            const norm = normalizeUrl(inp.value, c.urlScheme);
            if (!norm) { sfx('bad'); setMsg(msgEl, '✕ that doesn\'t look like a URL — e.g. ' + inp.getAttribute('placeholder'), ''); return; }
            inp.value = norm;
          }
        }
        const vals = c.read(body);
        const hasFreshAuth = !!(vals.token || vals.endpoint || vals.account);
        // a saved config can be reused (one-click reconnect) — fresh credentials only required on first setup.
        if (!hasFreshAuth && !configuredById[c.id]) { sfx('bad'); setMsg(msgEl, c.emptyMsg, ''); return; }
        if (c.id === 'slack' && vals.token && !(/xoxb-/.test(vals.token) && /xapp-/.test(vals.token))) { sfx('bad'); setMsg(msgEl, c.emptyMsg, ''); return; }
        const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
        const usingCodex = provider === 'codex' || provider === 'openai-codex';
        const key = (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey(provider) || '') : '';
        const baseUrl = (typeof Harness !== 'undefined' && Harness.getBaseUrl) ? (Harness.getBaseUrl(provider) || '') : '';
        const hasStoredKey = !!(typeof Harness !== 'undefined' && Harness.configured && Harness.configured(provider));
        const model = (typeof Harness !== 'undefined' && Harness.getModel()) || '';
        if (!model || (!usingCodex && !key && !hasStoredKey)) {
          sfx('bad'); setMsg(msgEl, '✕ connect your agent\'s provider + model in SETTINGS first', '');
          // deep-link door: land Settings on PROVIDERS so a beginner can fix it in one hop (pattern: openTerm section).
          const link = document.createElement('button'); link.className = 'ch-door'; link.textContent = 'open SETTINGS → PROVIDERS';
          link.addEventListener('click', () => { try { openTerm('settings', 'providers'); } catch (_) {} });
          msgEl.appendChild(document.createTextNode(' ')); msgEl.appendChild(link);
          return;
        }
        const ident = agentIdentity();
        pendingConnect[c.id] = true;
        setMsg(msgEl, 'connecting… — watch the status above for the verified result', 'info');
        try {
          // Desktop: park the secret in the OS keychain (via Tauri), then connect WITHOUT sending it over HTTP —
          // the sidecar reads it from the keychain-injected runtime layer. Browser: storeChannelToken is a no-op
          // and the token rides the POST body. Non-secret config (endpoint/account) always rides the body.
          let bodyToken = vals.token || '';
          let localFallback = false;
          if (typeof Harness !== 'undefined' && Harness.storeChannelToken && vals.token) {
            const stored = await Harness.storeChannelToken(c.id, vals.token);
            if (stored) bodyToken = '';
            else if (Harness.isDesktop && Harness.isDesktop()) localFallback = true;
          }
          const payload = { token: bodyToken, key, model, provider, baseUrl, agentId: ident.agentId, system: ident.system, agentName: ident.agentName };
          if (vals.endpoint != null) payload.endpoint = vals.endpoint;
          if (vals.account != null) payload.account = vals.account;
          const r = await Harness.api.post('/api/channels/' + c.id + '/connect', payload);
          const j = r.j || {};
          if (!r.ok || j.error) { delete pendingConnect[c.id]; setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); sfx('bad'); }
          else {
            // DERIVE the outcome line from the status refresh (paintCard finalizes pendingConnect), NOT from this
            // POST — the sidecar only reports 'connecting' until the transport actually proves the round-trip.
            if (c.id === 'telegram' && j.pairingCode) {
              pairingInstruction.telegram = 'Telegram poller starting. To activate DMs, send this exact message to your bot: /pair ' + j.pairingCode + ' (expires in 10 minutes).';
              setMsg(msgEl, pairingInstruction.telegram, 'info');
            } else if (c.id === 'telegram' && j.pairingRequired) {
              setMsg(msgEl, 'Telegram poller starting, but DMs are blocked: ' + (j.pairingError || 'click PAIR OWNER to issue a pairing command.'), 'info');
            } else if (localFallback) setMsg(msgEl, 'connecting… (token saved locally, not the OS keychain)', 'info');
            sfx('click');
            try { c.clear(body); } catch (_) {}
          }
        } catch (e) { delete pendingConnect[c.id]; setMsg(msgEl, '✕ ' + ((e && e.message) || 'failed to reach the sidecar'), ''); sfx('bad'); }
        refreshAll();
      });
      // DISCONNECT — armed (2s) so a stray click can't drop a live channel; never fires on a never-connected card
      // (the button is hidden then anyway). Marks the config disabled server-side but KEEPS the saved token so
      // RESUME is one click; use FORGET to actually purge the secret.
      const dBtn = body.querySelector('#' + c.pre + '-disconnect');
      dBtn.addEventListener('click', () => {
        if (!(configuredById[c.id])) { return; }   // nothing to disconnect — no lie, no request
        armed(c.pre + '-disconnect', dBtn, '⏏ DISCONNECT', '⏏ CONFIRM DISCONNECT', async () => {
          try { await Harness.api.post('/api/channels/' + c.id + '/disconnect', {}); setMsg(msgEl, 'disconnected — token kept; RESUME to reconnect', 'info'); sfx('click'); }
          catch (_) { setMsg(msgEl, '✕ could not reach the sidecar', ''); }
          refreshAll();
        });
      });
      // FORGET — armed purge of the stored secret (record + OS keychain). Explicit user destruction, so exempt from
      // the never-remove-a-secret-silently law; the record/runtime token is cleared server-side (purge:true) and the
      // desktop keychain entry is overwritten empty.
      const fBtn = body.querySelector('#' + c.pre + '-forget');
      fBtn.addEventListener('click', () => {
        if (!(configuredById[c.id])) { return; }
        const removeLabel = c.id === 'signal' ? '✕ REMOVE CONFIGURATION' : '⌫ FORGET';
        const confirmRemoveLabel = c.id === 'signal' ? '✕ CONFIRM REMOVE' : '⌫ CONFIRM FORGET';
        armed(c.pre + '-forget', fBtn, removeLabel, confirmRemoveLabel, async () => {
          try {
            // Signal has no token. Its destructive action removes the actual durable configuration — endpoint,
            // registered account and adapter ownership — and claims success only from the backend read-back bit.
            if (c.id === 'signal') {
              const r = await Harness.api.post('/api/channels/signal/disconnect', { purge: true });
              const j = r.j || {};
              if (j.removedConfiguration) {
                setMsg(msgEl, 'configuration removed — Signal is no longer configured on this machine', 'info');
                const endpoint = body.querySelector('#sg-endpoint'); if (endpoint) endpoint.value = '';
                const account = body.querySelector('#sg-account'); if (account) account.value = '';
                sfx('click');
              } else if (!r.ok || j.error) { setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); sfx('bad'); }
              else { setMsg(msgEl, '⚠ removal incomplete — could not prove the Signal configuration left disk; try again', ''); sfx('bad'); }
              refreshAll();
              return;
            }
            // Desktop: clear the OS-keychain copy and KEEP the result — a swallowed failure here used to let
            // the "purged" line lie while the token lived on in the keychain. Browser builds have no keychain
            // copy (storeChannelToken is a no-op false there), so only desktop counts it.
            let kcCleared = true;
            if (typeof Harness !== 'undefined' && Harness.storeChannelToken && Harness.isDesktop && Harness.isDesktop()) {
              kcCleared = await Promise.resolve(Harness.storeChannelToken(c.id, '')).then(ok => ok !== false).catch(() => false);
            }
            const r = await Harness.api.post('/api/channels/' + c.id + '/disconnect', { purge: true });
            const j = r.j || {};
            // truthful telemetry: "purged" is a DESTRUCTION claim — assert it only from the backend's
            // read-back-proven bit (j.purged) plus the keychain result, never from the click itself.
            if (j.purged && kcCleared) { setMsg(msgEl, 'forgotten — the stored token was purged', 'info'); sfx('click'); try { c.clear(body); } catch (_) {} }
            else if (!r.ok || j.error) { setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); sfx('bad'); }
            else {
              const where = [];
              if (!j.purged) where.push('the saved record');
              if (!kcCleared) where.push('the OS keychain');
              setMsg(msgEl, '⚠ forget incomplete — could not prove the token left ' + where.join(' or ') + '; try again', ''); sfx('bad');
            }
          } catch (_) { setMsg(msgEl, '✕ could not reach the sidecar', ''); }
          refreshAll();
        });
      });
      // Enter in any of the card's inputs = CONNECT
      body.querySelectorAll('#ch-card-' + c.id + ' input.key-input').forEach(inp => {
        inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); body.querySelector('#' + c.pre + '-connect').click(); } });
      });
    }

    // ---- Telegram owner enrollment: code comes from the local authenticated sidecar and is never polled back. ----
    (function wireTelegramOwner() {
      const msgEl = body.querySelector('#tg-msg');
      const pairBtn = body.querySelector('#tg-owner-pair');
      const revokeBtn = body.querySelector('#tg-owner-revoke');
      if (!pairBtn || !revokeBtn) return;
      pairBtn.addEventListener('click', async () => {
        try {
          const r = await Harness.api.post('/api/channels/telegram/owner/pair', {});
          const j = r.j || {};
          if (!r.ok || j.error || !j.code) { setMsg(msgEl, 'could not issue a pairing code: ' + (j.error || ('HTTP ' + r.status)), ''); sfx('bad'); return; }
          pairingInstruction.telegram = 'In Telegram, DM this bot: /pair ' + j.code + ' (code expires in 10 minutes).';
          setMsg(msgEl, pairingInstruction.telegram, 'info');
          sfx('click'); refreshAll();
        } catch (_) { setMsg(msgEl, 'could not reach the sidecar', ''); sfx('bad'); }
      });
      revokeBtn.addEventListener('click', () => armed('tg-owner-revoke', revokeBtn, 'REVOKE OWNER', 'CONFIRM REVOKE', async () => {
        try {
          const r = await Harness.api.post('/api/channels/telegram/owner/revoke', {});
          const j = r.j || {};
          if (!r.ok || j.error) { setMsg(msgEl, 'could not revoke owner: ' + (j.error || ('HTTP ' + r.status)), ''); sfx('bad'); }
          else { setMsg(msgEl, 'owner revoked locally - issue a new pairing code before Telegram can run the agent again', 'info'); sfx('click'); }
        } catch (_) { setMsg(msgEl, 'could not reach the sidecar', ''); sfx('bad'); }
        refreshAll();
      }));
    })();

    // ---- multi-bot telegram wiring: add / resume / disconnect / forget --------------------------------------
    (function wireTelegramBots() {
      const msgEl = body.querySelector('#tg-bots-msg');
      const sel = body.querySelector('#tg-bot-agent');
      if (!sel) return;
      function fillAgents() {
        const cur = sel.value;
        sel.textContent = '';
        for (const a of (H.present || [])) {
          if (!a || !a.id) continue;
          const o = document.createElement('option');
          o.value = a.id; o.textContent = a.name || a.id;
          sel.appendChild(o);
        }
        if (cur) sel.value = cur;
      }
      fillAgents();
      const addBox = body.querySelector('#tg-bot-addbox');
      if (addBox) addBox.addEventListener('toggle', fillAgents);   // roster may have changed since build
      body.querySelector('#tg-bot-add').addEventListener('click', async () => {
        const tokInp = body.querySelector('#tg-bot-token');
        const token = (tokInp.value || '').trim();
        const agentId = sel.value;
        if (!token) { sfx('bad'); setMsg(msgEl, 'paste a @BotFather token for the new bot first', ''); return; }
        if (!agentId) { sfx('bad'); setMsg(msgEl, 'pick which agent this bot should be', ''); return; }
        const ag = (H.present || []).find(a => a && a.id === agentId) || null;
        // An agent bot runs as the SELECTED roster agent, not whichever agent/provider is currently focused in
        // COMMS. Keep provider+model+credential together here; the backend independently resolves the same roster
        // tuple and refuses any mismatch before it saves the Telegram token.
        const provider = (ag && ag.provider) || ((typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter');
        const usingCodex = provider === 'codex' || provider === 'openai-codex';
        const usingOAuth = usingCodex || provider === 'grok' || provider === 'kimi';
        const key = (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey(provider) || '') : '';
        const baseUrl = (typeof Harness !== 'undefined' && Harness.getBaseUrl) ? (Harness.getBaseUrl(provider) || '') : '';
        const hasStoredKey = !!(typeof Harness !== 'undefined' && Harness.configured && Harness.configured(provider));
        const model = (ag && ag.model) || '';
        const reasoningEffort = (ag && ag.reasoningEffort) || ((typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort(provider) : 'medium');
        if (!model || (!usingOAuth && !key && !hasStoredKey)) { sfx('bad'); setMsg(msgEl, '✕ connect this agent\'s provider + model in SETTINGS first', ''); return; }
        setMsg(msgEl, 'checking Telegram and proving this agent\'s model sign-in…', 'info');
        try {
          const r = await Harness.api.post('/api/channels/telegram/bots/connect', {
            token, agentId, key, model, provider, baseUrl, reasoningEffort,
            system: (ag && ag.systemPrompt) || '', agentName: (ag && ag.name) || ''
          });
          const j = r.j || {};
          if (!r.ok || j.error) { sfx('bad'); setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); }
          else {
            let localFallback = false;
            if (j.botId && typeof Harness !== 'undefined' && Harness.storeChannelToken) {
              const stored = await Harness.storeChannelToken('telegram:' + j.botId, token);
              localFallback = !stored && !!(Harness.isDesktop && Harness.isDesktop());
            }
            sfx('click'); tokInp.value = '';
            // A new agent bot is deliberately deaf until its Telegram owner proves possession with /pair.
            // Surface that command NOW, in the same response that proved the token, instead of telling the user
            // to wait for a green row that cannot become green before pairing.
            if (j.pairingCode) {
              setMsg(msgEl, '✓ @' + (j.username || 'bot') + (j.rebound ? ' re-bound' : ' added') + ' — ' + (j.providerVerified ? 'agent model verified; ' : '') + 'finish setup now: DM that bot /pair ' + j.pairingCode + ' (expires in 10 minutes).' + (localFallback ? ' Token saved locally, not the OS keychain.' : ''), 'info');
            } else if (j.pairingRequired) {
              setMsg(msgEl, '◐ @' + (j.username || 'bot') + ' is polling, but DMs are blocked: ' + (j.pairingError || 'click its PAIR button to issue the owner command.') + (localFallback ? ' Token saved locally, not the OS keychain.' : ''), 'info');
            } else {
              setMsg(msgEl, '✓ @' + (j.username || 'bot') + (j.rebound ? ' re-bound' : ' added') + ' — connecting as the paired owner' + (localFallback ? ' (token saved locally, not the OS keychain)' : ''), 'ok');
            }
          }
        } catch (e) { sfx('bad'); setMsg(msgEl, '✕ ' + ((e && e.message) || 'failed to reach the sidecar'), ''); }
        refreshAll();
      });
      // row actions by delegation (rows re-render on every status paint)
      body.querySelector('#tg-bots-list').addEventListener('click', (ev) => {
        const b = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
        if (!b) return;
        const botId = b.dataset.bot, act = b.dataset.act;
        if (!botId) return;
        const doPost = async (path, payload, okText) => {
          try { const r = await Harness.api.post(path, payload || {}); const j = r.j || {};
            if (!r.ok || j.error) { sfx('bad'); setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); }
            else { sfx('click'); if (okText) setMsg(msgEl, okText, 'info'); } }
          catch (_) { sfx('bad'); setMsg(msgEl, '✕ could not reach the sidecar', ''); }
          refreshAll();
        };
        if (act === 'resume') doPost('/api/channels/telegram/bots/' + botId + '/connect', {}, null);
        else if (act === 'pair') (async () => {
          try {
            const r = await Harness.api.post('/api/channels/telegram/bots/' + botId + '/owner/pair', {});
            const j = r.j || {};
            if (!r.ok || j.error || !j.code) { sfx('bad'); setMsg(msgEl, 'could not issue pairing code: ' + (j.error || ('HTTP ' + r.status)), ''); }
            else { sfx('click'); setMsg(msgEl, 'DM that bot: /pair ' + j.code + ' (expires in 10 minutes).', 'info'); }
          } catch (_) { sfx('bad'); setMsg(msgEl, 'could not reach the sidecar', ''); }
          refreshAll();
        })();
        else if (act === 'revokeOwner') armed('tg-bot-owner-' + botId, b, 'UNPAIR', 'CONFIRM UNPAIR', () =>
          doPost('/api/channels/telegram/bots/' + botId + '/owner/revoke', {}, 'bot owner revoked locally'));
        else if (act === 'off') doPost('/api/channels/telegram/bots/' + botId + '/disconnect', {}, 'bot disconnected — token kept; ⏵ to reconnect');
        else if (act === 'forget') armed('tg-bot-forget-' + botId, b, '⌫', '⌫ SURE?', async () => {
          try {
            const r = await Harness.api.post('/api/channels/telegram/bots/' + botId + '/disconnect', { purge: true });
            const j = r.j || {};
            if (!r.ok || j.error || !j.purged) { sfx('bad'); setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); }
            else {
              let kcCleared = true;
              if (Harness.storeChannelToken && Harness.isDesktop && Harness.isDesktop()) {
                kcCleared = await Harness.storeChannelToken('telegram:' + botId, '');
              }
              if (kcCleared) { sfx('click'); setMsg(msgEl, 'bot forgotten — its stored token was purged', 'info'); }
              else { sfx('bad'); setMsg(msgEl, '⚠ bot record removed, but the OS keychain token could not be deleted; try FORGET again after re-adding it', ''); }
            }
          } catch (_) { sfx('bad'); setMsg(msgEl, '✕ could not reach the sidecar', ''); }
          refreshAll();
        });
      });
    })();

    // ---- the ONE global "ping me when I work on my own" opt-in (persisted server-side; cron reads it) ----
    const notifyBox = body.querySelector('#ch-notify');
    const notifyMsg = body.querySelector('#ch-notify-msg');
    if (notifyBox) notifyBox.addEventListener('change', async () => {
      try {
        const r = await Harness.api.post('/api/channels/notify', { on: notifyBox.checked });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        sfx('click'); refreshAll();   // refresh so the zero-channel hint appears/clears from PROVEN status
      } catch (_) { notifyBox.checked = !notifyBox.checked; setMsg(notifyMsg, '✕ couldn\'t save that — the sidecar didn\'t answer', ''); }
    });

    refreshAll();
  }

  StationUI.registerWindow('messaging', 'CHANNELS', buildMessaging, { console: true, className: 'channels-console' });   // console mode = the wide SETTINGS-style two-pane window; the className scopes the no-glyph rail; dock label = window title (it's Telegram/external channels, not COMMS)
})();
