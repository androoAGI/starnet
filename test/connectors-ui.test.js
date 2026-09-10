/* node test/connectors-ui.test.js — the generic MCP connector MANAGER UI (P0-1).
   Two layers:
   1) MANAGER behaviour — the new per-connector `headers` + `timeoutMs` config threads all the way
      to makeTransport / makeClient, is carried forward when omitted, and is redacted in the summary
      (header VALUES are never echoed). The pre-existing http/stdio/token behaviour is unchanged.
   2) SOURCE GUARD over the frontend CONNECTORS panel — the panel must surface a GENERIC manager
      (transport toggle, stdio fields, headers, timeout, edit, reload), and the Spotify card must
      stay intact. Mirrors the provider-connections-ui source-guard style. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const A = require('./_assert.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');

// ---- a fake transport/client that records exactly what the manager handed it ----
function fakeStack(tools) {
  const seen = { transport: null };
  const makeTransport = (opts) => { seen.transport = opts; return { send() {}, onMessage() {}, close() {} }; };
  const makeClient = ({ transport, timeoutMs }) => {
    seen.clientTimeout = timeoutMs;
    return {
      initialize: () => Promise.resolve({}),
      listTools: () => Promise.resolve(tools || []),
      callTool: () => Promise.resolve({ content: [] }),
      close() {}
    };
  };
  return { seen, makeTransport, makeClient };
}

(async () => {
  // ---------- 1. MANAGER: headers + timeout threading ----------
  {
    const { seen, makeTransport, makeClient } = fakeStack([{ name: 'do_thing' }]);
    const m = makeConnectorManager({ makeTransport, makeClient, makeToolDef: () => ({ name: 'x' }), timeoutMs: 30000 });
    const r = await m.configure('gh', { transport: 'http', url: 'https://mcp.example/x', token: 'sk-secret',
      headers: { 'X-Api-Version': '2024', 'X-Auth-Token': 'zzz' }, timeoutMs: 5000 });
    A.eq(r.ok, true, 'http connector with headers+timeout connects');
    A.eq(seen.transport.headers, { 'X-Api-Version': '2024', 'X-Auth-Token': 'zzz' }, 'custom headers reach the transport verbatim');
    A.eq(seen.transport.timeoutMs, 5000, 'per-connector timeout reaches the transport');
    A.eq(seen.clientTimeout, 5000, 'per-connector timeout reaches the client too');

    const s = m.status('gh');
    A.eq(s.hasToken, true, 'summary reports a token is set');
    A.eq(s.hasHeaders, true, 'summary reports headers are set');
    A.eq(s.timeoutMs, 5000, 'summary carries the effective timeout');
    A.eq(s.headers['X-Auth-Token'], '<redacted>', 'secret-looking header value is redacted');
    A.eq(s.headers['X-Api-Version'], '<set>', 'non-secret header value is masked to <set>, never echoed');
    A.ok(JSON.stringify(s).indexOf('zzz') === -1, 'header VALUE never leaves the summary');
    A.ok(JSON.stringify(s).indexOf('sk-secret') === -1, 'token VALUE never leaves the summary');
  }

  // headers + timeout are carried forward when a later configure() omits them
  {
    const { seen, makeTransport, makeClient } = fakeStack([]);
    const m = makeConnectorManager({ makeTransport, makeClient, makeToolDef: () => ({}), timeoutMs: 30000 });
    await m.configure('gh', { transport: 'http', url: 'https://mcp.example/x', headers: { 'X-Keep': 'v' }, timeoutMs: 7000 });
    await m.configure('gh', { transport: 'http', url: 'https://mcp.example/x', enabled: true }); // no headers/timeout in this call
    A.eq(seen.transport.headers, { 'X-Keep': 'v' }, 'omitted headers are carried forward, not wiped');
    A.eq(seen.transport.timeoutMs, 7000, 'omitted timeout is carried forward, not reset to default');
  }

  // default timeout when never set = the manager global; a stdio connector never exposes http headers
  {
    const { seen, makeTransport, makeClient } = fakeStack([]);
    const m = makeConnectorManager({ makeTransport, makeClient, makeToolDef: () => ({}), timeoutMs: 30000 });
    await m.configure('local', { transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'x' } });
    A.eq(seen.transport.timeoutMs, 30000, 'no per-connector timeout falls back to the manager default');
    const s = m.status('local');
    A.eq(s.transport, 'stdio', 'stdio connector reports its transport');
    A.ok(!('headers' in s), 'stdio summary carries no http headers field');
    A.eq(s.hasEnv, true, 'stdio summary reports env is set');
    A.ok(JSON.stringify(s).indexOf('"x"') === -1, 'stdio secret env value never leaves the summary');
    A.eq(s.timeoutMs, 30000, 'stdio summary carries the effective timeout');
  }

  // a bad headers shape is rejected (throws), not silently coerced
  {
    const { makeTransport, makeClient } = fakeStack([]);
    const m = makeConnectorManager({ makeTransport, makeClient, makeToolDef: () => ({}) });
    let threw = false;
    try { await m.configure('bad', { transport: 'http', url: 'https://x/y', headers: ['not', 'an', 'object'] }); }
    catch (e) { threw = true; }
    A.ok(threw, 'array headers are rejected');
  }

  // durable missing-field requirements are a runtime gate even if a caller or hand-edited file sets enabled=true.
  {
    const { seen, makeTransport, makeClient } = fakeStack([]);
    const m = makeConnectorManager({ makeTransport, makeClient, makeToolDef: () => ({}) });
    const r = await m.configure('incomplete', { transport: 'stdio', command: 'node', enabled: true,
      missingFields: ['args:0', 'env:ACCESS'] });
    A.eq(r.ok, false, 'an enabled incomplete connector is refused by the runtime');
    A.ok(/args:0/.test(r.error) && /env:ACCESS/.test(r.error), 'runtime refusal names the durable missing fields');
    A.eq(seen.transport, null, 'runtime does not create a transport for incomplete configuration');
    A.eq(m.status('incomplete').missingFields, ['args:0', 'env:ACCESS'], 'safe status exposes only the missing field names');
  }

  // oauth connectors pass a tokenProvider() (not a frozen token) so EVERY (re)connect/Reload fetches a FRESH bearer
  // — the fix for the token dying ~1h into a session. The resolved token never leaks into the summary.
  {
    const { seen, makeTransport, makeClient } = fakeStack([]);
    let calls = 0;
    const m = makeConnectorManager({ makeTransport, makeClient, makeToolDef: () => ({}), timeoutMs: 30000 });
    await m.configure('oa', { transport: 'http', url: 'https://mcp.example/x', token: '', tokenProvider: async () => { calls++; return 'fresh-' + calls; } });
    A.eq(seen.transport.token, 'fresh-1', 'tokenProvider result is the bearer handed to the transport on connect');
    const s = m.status('oa');
    A.eq(s.hasToken, true, 'summary reports hasToken for a tokenProvider connector');
    A.eq(s.oauth, true, 'summary flags oauth (tokenProvider) connectors so the panel can render them distinctly');
    A.ok(JSON.stringify(s).indexOf('fresh-1') === -1, 'the resolved oauth token never leaves the summary');
    await m.refresh('oa');
    A.eq(seen.transport.token, 'fresh-2', 'Reload/refresh re-invokes the tokenProvider (fresh bearer, not a frozen stale one)');
    await m.configure('oa', { transport: 'http', url: 'https://mcp.example/x', token: 'manual', tokenProvider: null, enabled: false });
    A.eq(m.status('oa').oauth, false, 'an explicit null tokenProvider switches the runtime out of OAuth mode');
    A.eq(m.status('oa').hasToken, true, 'the replacement manual token remains configured after leaving OAuth mode');
  }

  // ---------- 2. SOURCE GUARD: the frontend panel ----------
  const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'connectors.js'), 'utf8');   // CONNECTORS window extracted from stationui.js (BUILDERS split)
  A.ok(/cached:\s*\['var\(--gold\)', '◐ idle · starts on use'\]/.test(station),
    'cached stdio schemas render as idle/starts-on-use, never falsely connected or disabled');
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'app.css'), 'utf8');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');

  // the panel is still reachable + Spotify (the pre-existing card) is untouched
  A.ok(/data-term="connectors"/.test(idx), 'CONNECTORS panel entry still exists');
  A.ok(/function buildConnectors/.test(station), 'buildConnectors panel builder present');
  A.ok(/setupSpotify\(body\)/.test(station), 'Spotify card is still wired (not regressed)');
  A.ok(/id="sp-connect"/.test(station), 'Spotify connect control preserved');

  // transport choice: HTTP plus local stdio bound to a real per-agent Safe Cell.
  A.ok(/id="mc-transport"/.test(station) && /data-tp="stdio"/.test(station) && /data-tp="http"/.test(station), 'transport toggle (http/stdio) present');
  A.ok(/id="mc-command"/.test(station) && /id="mc-args"/.test(station), 'stdio command and exact-argv inputs are present');
  A.ok(/id="mc-cwd"/.test(station) && /id="mc-env"/.test(station), 'stdio container cwd and explicit env inputs are present');
  A.ok(/id="mc-agent"/.test(station) && /\/api\/execution-profiles/.test(station), 'stdio must bind to a live Safe Cell agent');
  A.ok(/tp === 'stdio' && stdioAgents\.length === 0/.test(station), 'ADD is disabled when no isolated agent is available');
  A.ok(/payload\.agentId = agentId/.test(station) && /payload\.command = command/.test(station), 'stdio owner and command reach the connector API');
  // the web build ships the same panel — a fix that lands in only one copy is a fix half the users never get
  const webStation = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'app', 'windows', 'connectors.js'), 'utf8');
  A.ok(/id="mc-command"/.test(webStation) && /id="mc-agent"/.test(webStation), 'web build carries the same isolated stdio form');
  A.ok(/function readJSON/.test(webStation) && /offline: true/.test(webStation) && /offline: false/.test(webStation),
    'web build carries the same read-honesty fix — a one-copy fix is one half the users never get');
  A.ok(/id="mc-headers"/.test(station), 'http custom-headers input present');
  A.ok(/id="mc-timeout"/.test(station), 'per-connector timeout input present');

  /* ⛔ AN ERRORED READ IS NOT "YOU HAVE NONE", AND A REFUSAL IS NOT "OFFLINE" (fix 1d0c7557).
     `(await fetch(u)).json()` RESOLVES on 4xx/5xx — the error body parses fine, `j.groups` comes back
     undefined, and the KEYS tab printed "No keyed platform connectors" at a Commander who has plenty.
     A non-JSON error body threw instead, and the catch said "sidecar offline — start it" about a station
     that had just answered. Both readings send someone to fix the wrong thing. These pin the three-way
     discrimination, because the defect is invisible in a screenshot: an empty list looks like a fact. */
  A.ok(/function readJSON/.test(station), 'reads go through readJSON, not a bare (await fetch()).json()');
  A.ok(/if \(!r\.ok\) return/.test(station), 'a 4xx/5xx is detected instead of being parsed as data');
  A.ok(/offline: true/.test(station) && /offline: false/.test(station),
    'readJSON separates "never reached the station" from "the station refused" — a two-state boolean cannot');
  A.ok(/res\.offline/.test(station), 'the failure line keys off res.offline, so only a real outage says start-it');
  A.ok(/it is running, so this is not a start-it problem/.test(station),
    'an errored-but-reachable station says so in words, instead of blaming the station being down');
  A.ok(/couldn\\?['’]t read this from the station/.test(station),
    'a failed read is reported as a FAILED READ, never rendered as a confirmed-empty list');
  A.ok(/HTTP ' \+ res\.status|HTTP ' \+ r\.status/.test(station), 'the status code reaches the user, so the cause is diagnosable');

  // add + edit + reload + status
  A.ok(/id="mc-add"/.test(station), 'ADD/SAVE button present');
  A.ok(/function startEdit/.test(station) && /data-act="edit"/.test(station), 'per-row EDIT wired');
  A.ok(/data-act="reload"/.test(station), 'per-row RELOAD wired');
  A.ok(/\/api\/connectors\/refresh/.test(station), 'RELOAD hits the refresh endpoint');
  A.ok(/function badge/.test(station) && /connected/.test(station) && /error/.test(station), 'status badge (green/amber/red) present');
  A.ok(/mc-tools/.test(station), 'discovered-tools preview present');
  A.ok(/async function removeConnector\([\s\S]{0,500}if \(!r\.ok\)/.test(station),
    'connector delete checks HTTP success before claiming removal');
  A.ok(/function wireRemoveButtons\(\)/.test(station) && /ArmConfirm\.wire\(btn/.test(station) &&
    /armedLabel:\s*'SURE\? REMOVE CONNECTOR'/.test(station) && /btn\.dataset\.wired === '1'/.test(station),
    'connector removal requires the shared two-step armed confirmation');
  A.ok(/postJSON\('\/api\/connectors', \{ id, transport: c\.transport, enabled: cb\.checked \}\)[\s\S]{0,250}if \(!r\.ok\)/.test(station),
    'connector enable toggles reject and visibly revert a refused HTTP write');

  // beginner-first: inline help under fields + a discoverable send shape (transport is passed)
  A.ok(/class="mc-hint"/.test(station), 'one-line inline help under fields present');
  A.ok(/data-tp="oauth"/.test(station) && /ADD & SIGN IN/.test(station), 'custom MCP form exposes an OAuth sign-in mode');
  A.ok(/transport:\s*httpMode \? 'http' : 'stdio'/.test(station) && /payload\.oauth = tp === 'oauth'/.test(station),
    'OAuth is persisted as HTTP transport plus an explicit auth marker');
  A.ok(/ccSignIn\(id, msgEl, label \|\| id\)/.test(station), 'saving a custom OAuth connector immediately starts browser sign-in');
  A.ok(/c\.state === 'error' && \(!c\.oauth \|\| c\.oauthAuthorized\)/.test(station),
    'the expected unsigned 401 cannot end polling before OAuth callback, but a post-grant error remains visible');
  A.ok(/OAuth authorized/.test(station) && /OAuth sign-in needed/.test(station),
    'OAuth rows never mislabel a token-provider function as a saved grant');
  A.ok(/parseKV/.test(station), 'key:value parser for headers/env present');

  // never round-trip a secret back into the form on edit
  A.ok(/never round-trip the token/.test(station), 'edit leaves the token blank to keep the saved one');

  // styling hooks exist so the new controls actually render on-theme
  A.ok(/\.mc-seg-btn/.test(css) && /\.mc-hint/.test(css) && /\.mc-tag/.test(css), 'connector form styles present');

  // ---------- 3. CONNECTOR CATALOG tab (one-click browse-and-add) ----------
  // the tab exists and is fed by the catalog route
  A.ok(/id:\s*'catalog'/.test(station) && /label:\s*'CATALOG'/.test(station), 'CATALOG tab registered on the connectors console');
  A.ok(/id="cc-list"/.test(station), 'catalog list container present');
  A.ok(/\/api\/connectors\/catalog/.test(station), 'catalog pane fetches GET /api/connectors/catalog');
  A.ok(/function ccCard/.test(station) && /function ccGroupHTML/.test(station), 'catalog card + category-group renderers present');
  // honest auth tiers: no-setup adds, apikey reveals a key field, oauth is listed-but-gated (never a dead click)
  A.ok(/data-cc-act="add"/.test(station), 'no-setup connectors get an ADD action');
  A.ok(/data-cc-act="key"/.test(station) && /data-cc-key=/.test(station), 'apikey connectors reveal an inline key field');
  A.ok(/data-cc-act="signin"/.test(station) && /function ccSignIn/.test(station), 'oauth connectors get a live SIGN IN button + handler');
  A.ok(/action = e\.url/.test(station), 'an oauth entry with no endpoint is NOT shown as sign-in-able (no dead button — truthful telemetry)');
  A.ok(!/data-cc-act="oclient"|data-cc-oclientid|data-cc-oclientsecret/.test(station), 'customers never see Google developer credential fields');
  A.ok(/signInAvailable/.test(station) && /GOOGLE SIGN-IN UNAVAILABLE/.test(station), 'unconfigured builds show a truthful operator-owned availability state');
  A.ok(!/\/api\/connectors\/oauth\/client/.test(station), 'customer UI never saves an OAuth application registration');
  // url-less oauth entries with an aggregator route get a LIVE "VIA <name>" jump, never a mute disabled button
  A.ok(/data-cc-act="via"/.test(station) && /data-via=/.test(station), 'url-less oauth entries with `via` get a live VIA jump button');
  A.ok(/scrollIntoView/.test(station) && /cc-jump/.test(station), 'the VIA jump scrolls to + flashes the aggregator card');
  A.ok(/\/api\/connectors\/oauth\/start/.test(station), 'sign-in kicks off the real OAuth flow (oauth/start)');
  // the popup itself lives in the shared openSignIn helper, which stayed in stationui.js core (settings re-sign-in shares it)
  const stationCore = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  A.ok(/openSignIn\(/.test(station) && /window\.open\(/.test(stationCore), 'sign-in opens the provider consent in a popup (via the shared openSignIn helper)');
  A.ok(/ccPending/.test(station), 'sign-in has a per-connector in-flight guard (no duplicate popups / concurrent pollers)');
  A.ok(/e\.authType === 'oauth'/.test(station), 'the UI gates on the authType tier from the catalog');
  const sidecar = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/resolveConnectorOauthTarget\([^\n]+connectorCatalog, connectorConfigs\)/.test(sidecar),
    'OAuth start resolves both catalog and durably saved custom connector ids');
  A.ok(/connectorOauthPublicUrl[\s\S]{0,500}assertResolvedSafe/.test(sidecar) && /fetchImpl: connectorOauthFetch/.test(sidecar)
      && /if \(target\.custom\) await connectorOauthPublicUrl\(disc\.authorizationEndpoint\)/.test(sidecar),
    'custom OAuth discovery/token legs use the public-host DNS guard');
  A.ok(/oauthAuthorized/.test(sidecar), 'connector status distinguishes a configured OAuth row from a stored grant');
  // installing reuses the SAME upsert (no parallel install path) and never fabricates the endpoint
  A.ok(/function ccInstall/.test(station) && /postJSON\('\/api\/connectors'/.test(station), 'install posts through the existing /api/connectors upsert');
  A.ok(/ccCache\.find\(/.test(station), 'install reads the authoritative url/name from the catalog, never a re-typed value');
  A.ok(/transport:\s*'http',\s*url:\s*e\.url/.test(station), 'install pre-fills the catalog entry url');
  A.ok(/if \(token\) payload\.token = token/.test(station), 'an API key is sent only when the user provided one');
  A.ok(/const keyDelivery = e\.keyHeader/.test(station) && /esc\(e\.keyHeader\)/.test(station),
    'custom-header API keys describe their real wire header instead of falsely claiming Bearer auth');
  A.ok(/Authorization: Bearer &hellip;/.test(station), 'ordinary token connectors retain the Bearer-auth explanation');
  A.ok(/Array\.isArray\(e\.presets\)/.test(station) && /PRESETS ·/.test(station),
    'a catalog entry can expose named presets without multiplying duplicate cards');
  A.ok(/Array\.isArray\(e\.presets\)/.test(webStation) && /PRESETS ·/.test(webStation),
    'web build carries the same preset rendering');
  // truthful telemetry: ADDED state comes from the backend `installed` flag, and live state is re-read after add
  const renderCatalog = require('node:vm').runInNewContext('(' + station.slice(station.indexOf('function ccCard('), station.indexOf('    function ccGroupHTML')) + ')', {
    CC_CHIP: { none: ['', 'no setup', 'green'] }, esc: x => String(x == null ? '' : x), ccSeal: () => '', location: { port: '8787' }
  });
  const savedCard = renderCatalog({ id: 'fixture', name: 'Fixture', installed: true, blurb: 'test' }, 0);
  A.ok(savedCard.includes('data-cc-act="manage"') && !savedCard.includes('disabled'), 'saved service has an actionable management button');
  A.ok(savedCard.includes('Setup saved.') && !savedCard.includes('✓ connected'), 'saved configuration does not assert live connectivity');
  const newCard = renderCatalog({ id: 'fixture', name: 'Fixture', installed: false, blurb: 'test' }, 0);
  A.ok(newCard.includes('data-cc-act="add"') && !newCard.includes('MANAGE SERVICE'), 'new service still offers its actual setup action');
  const popularGroups = vm.runInNewContext('(' + A.fnBody(station, 'function ccPopularGroups(') + ')');
  const inputGroups = [{ category: 'Productivity', connectors: [
    { id: 'gmail', url: 'google', releaseDeferred: true },
    { id: 'notion', url: 'notion' }, { id: 'custom', url: 'custom' },
    { id: 'asana', url: 'asana', signInAvailable: false }
  ] }, { category: 'Developer Tools', connectors: [{ id: 'github', url: 'github' }] }];
  const ordered = popularGroups(inputGroups);
  A.eq(ordered[0].category, 'Popular', 'popular services precede categories');
  A.eq(ordered[0].connectors.map(e => e.id).join(','), 'notion,github', 'popular picks exclude unavailable services');
  A.eq(ordered.flatMap(g => g.connectors).length, 5, 'moving popular cards neither duplicates nor drops services');
  A.eq(inputGroups[0].connectors.length, 4, 'popular grouping preserves source groups');
  A.eq(popularGroups([{ category: 'Other', connectors: [{ id: 'custom' }] }])[0].category, 'Other', 'no empty popular heading');
  const keyCard = renderCatalog({ id: 'key', name: 'Key service', authType: 'apikey', homepage: 'https://example.com', blurb: 'test' });
  A.ok(keyCard.includes('SET UP API KEY') && keyCard.includes('Paste it below, then choose CONNECT'), 'key setup states the next action before submission');
  A.ok(/state === 'up'/.test(station), 'the connect result badge reflects the real manager state, not an assumption');
  // on-theme styling for the new cards
  A.ok(/\.cc-card/.test(css) && /\.cc-grid/.test(css) && /\.cc-chip/.test(css), 'catalog card styles present');

  /* ---------- 4. THE CONSOLE SEARCH MUST INDEX THE PLATFORMS (regression, 2026-07-28) ----------
     A user could not connect Google Drive: typing "google" / "gmail" / "google drive" into the ABILITIES
     search box returned ZERO hits while a Google Workspace card was rendered on screen. Cause: doFilter's
     row selector is a hardcoded class allowlist and `.cc-card` — the class every catalog AND every KEYS
     platform card uses (48 of them) — was not on it. A search box directly above a catalog that indexes
     none of the catalog is the single worst discoverability bug the connector surface can have. */
  const searchSel = (stationCore.match(/const rows = pane\.querySelectorAll\(([^)]*)\)/) || [])[1] || '';
  A.ok(/\.cc-card/.test(searchSel), 'console search indexes .cc-card (catalog + KEYS platform cards)');
  // aliases: the words a Commander TYPES are often in neither the name nor the blurb ("gdrive", "g suite").
  // The matcher must read the off-screen data-search attribute, and the card must emit it.
  A.ok(/dataset\.search/.test(stationCore), 'console search also matches the off-screen data-search aliases');
  A.ok(/data-search="/.test(station), 'catalog cards emit data-search from their aliases');
  A.ok(/e\.aliases/.test(station) && /Object\.assign\(\{\}, p,/.test(station),
    'the unified CATALOG search carries aliases from both connector and platform rows');

  /* ---------- 5. SEARCH + FILTER ACCESSIBILITY ----------
     A zero-hit global search used to hide every pane and clear every tab's selected state, leaving a
     silent blank console. Filter selection was color-only, and dynamic form feedback was not announced. */
  A.ok(/mkEl\('div', 'con-search-empty'\)/.test(stationCore) && /setAttribute\('role', 'status'\)/.test(stationCore),
    'console search owns a polite status surface for zero results');
  A.ok(/setSearchContext\(matches\[0\] \|\| activeId\)/.test(stationCore),
    'zero-hit search retains the real selected section instead of clearing the tablist selection');
  A.ok(/searchLabel:\s*'Search abilities'/.test(station) && /searchEmptyText:\s*'No abilities match/.test(station),
    'ABILITIES names its global search accurately and explains a zero-hit result');
  A.ok(/data-cc-filter="all" aria-pressed="true"/.test(station) &&
    /setAttribute\('aria-pressed', active \? 'true' : 'false'\)/.test(station),
    'catalog setup filters expose the same selected state to assistive technology that the active class paints');
  for (const id of ['sp-msg', 'mc-msg', 'cc-msg', 'ky-msg', 'ext-msg']) {
    A.ok(new RegExp('id="' + id + '"[^>]*role="status"[^>]*aria-live="polite"').test(station),
      id + ' announces validation and connection feedback');
  }
  A.ok(/\.con-search-empty\s*\{/.test(css), 'zero-result search feedback has station-native styling');
  A.ok(/\(c\.hasToken \|\| c\.hasHeaders\) && !c\.oauth/.test(station),
    'KEYS recognizes catalog connectors authenticated through a protected custom header');
  A.ok(/c\.hasHeaders && !c\.hasToken \? 'header saved' : 'token saved'/.test(station),
    'KEYS labels custom-header credentials truthfully instead of calling every credential a token');
  A.ok(/k\.unattendedSupported !== false/.test(station) && /k\.enabled && unattendedSupported \? '' : ' disabled'/.test(station),
    'KEYS disables the unattended control for watched-only integrations');
  A.ok(/p\.unattendedSupported === false \? 'manual' : 'apikey'/.test(station),
    'watched-only platform rows are explicitly manual setup, not automatic sign-in or API-key automation');
  A.ok(/Harness\.api\.get\('\/api\/servicekeys\/catalog'\)/.test(station) && /platformApi:\s*true/.test(station),
    'CATALOG consumes the keyed-platform directory while keeping those rows explicitly distinct from MCP connectors');
  A.ok(/data-cc-act="platform"/.test(station) && /function ccPrefillPlatform/.test(station),
    'platform catalog cards route to the existing KEYS setup form instead of calling the MCP installer');
  A.ok(/catalogId:\s*'platform:' \+ p\.id/.test(station) && /const cardId = e\.catalogId \|\| e\.id/.test(station),
    'platform cards are identity-namespaced so GitHub/Notion/Stripe cannot collide with same-id MCP cards');
  A.ok(!/id="ky-catalog"/.test(station) && /CONNECTED API KEYS/.test(station),
    'KEYS shows connected credentials and no longer hides the curated platform catalog inside its add form');
  const routeSource = /const ROUTES = (\[[\s\S]*?\n\s*\]);/.exec(station);
  const routes = routeSource ? vm.runInNewContext(routeSource[1]) : [];
  const podRoute = routes.find(r => /print.on.demand|\bPOD\b/i.test(r.title + ' ' + r.blurb));
  A.ok(podRoute && podRoute.to === 'catalog',
    'the ABILITIES front door routes POD discovery through CATALOG before the KEYS setup path');
  A.eq(routes.filter(r => r.to === 'catalog').length, 1,
    'service and platform discovery share one catalog route');
  A.ok(/to: 'catalog', title: 'Connect a service you use'/.test(station) && /entry\.platformApi \? 'keys' : 'mcp'/.test(station),
    'one service front door preserves the correct platform-key and connector management paths');

  const availabilitySource = A.fnBody(station, 'function tsAvailability(');
  const availability = vm.runInNewContext('(' + availabilitySource + ')');
  A.eq(availability({available:true, enabled:false, switchEffective:false}), 'AVAILABLE', 'Full Access overrides a saved disabled switch');
  A.eq(availability({available:true, enabled:true, placed:false, profileGranted:true, switchEffective:true}), 'AVAILABLE', 'execution profile grants do not require a prop');
  A.eq(availability({available:false, enabled:false, placed:false, switchEffective:true}), 'DISABLED', 'effective disabled switch takes priority over missing equipment');
  A.eq(availability({available:false, enabled:true, placed:false, profileGranted:false, switchEffective:true}), 'NEEDS PROP', 'ASK mode without any grant identifies missing equipment');
  A.eq(availability({available:false, enabled:true, placed:true, switchEffective:false}), 'UNAVAILABLE', 'missing host grant never implies availability');

  // Production row rendering: the glance must preserve status and recovery actions while technical
  // detail stays available behind one disclosure. Escaping still applies inside the folded content.
  const renderService = vm.runInNewContext('(' + A.fnBody(station, 'function row(') + ')', {
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    badge: s => ['var(--ph)', s]
  });
  const deferredRow = renderService({id:'google-sheets',label:'Google Sheets',releaseDeferred:true,credentialSaved:true,oauth:true,url:'https://example.test',detail:'Shared release explanation'},0);
  const glance = deferredRow.replace(/<details[\s\S]*?<\/details>/g, '');
  A.ok(glance.includes('Google Sheets') && glance.includes('deferred') && glance.includes('Saved connection retained.'), 'deferred glance preserves service, availability and retained setup');
  A.ok(!glance.includes('https://') && !glance.includes('Account identity') && !glance.includes('Shared release explanation'), 'technical caveats and repeated release prose do not compete in the glance');
  A.ok(/<details class="mc-inspect">/.test(deferredRow) && !/<details[^>]*\bopen\b/.test(deferredRow), 'connection details start folded');
  A.ok(!/data-act="(?:reload|edit|resign)"/.test(deferredRow) && /data-act="remove"/.test(deferredRow), 'deferred service keeps removal without offering unavailable connection actions');
  const rejectedRow = renderService({id:'expired',oauth:true,oauthAuthorized:true,authRequired:true,enabled:true,state:'error',url:'https://example.test',detail:'Rejected <grant>'},0);
  A.ok(rejectedRow.includes('Sign in below') && rejectedRow.includes('data-act="resign"'), 'rejected OAuth grant has a visible recovery instruction and sign-in action');
  A.ok(rejectedRow.includes('Error &amp; connection details') && rejectedRow.includes('Rejected &lt;grant>'), 'complete error stays inspectable and escaped');
  A.ok(!rejectedRow.includes('· OAuth authorized'), 'stored rejected OAuth grant does not claim authorization');
  const toolsRow = renderService({id:'docs',state:'up',enabled:true,tools:['read_docs','search_docs'],toolCount:2,url:'https://example.test'},0);
  A.ok(toolsRow.includes('2 tools') && /<details[\s\S]*read_docs[\s\S]*search_docs[\s\S]*<\/details>/.test(toolsRow), 'tools remain fully inspectable without an always-expanded tool wall');
  A.ok(/\.mc-row\s*\{[^}]*flex-direction:\s*column/.test(css), 'shared record cards stack instead of inheriting the legacy horizontal header');
  A.report('connectors-ui');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
