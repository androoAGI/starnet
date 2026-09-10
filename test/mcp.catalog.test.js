/* node test/mcp.catalog.test.js — the CURATED connector catalog (sidecar/mcp/catalog.js).
   Locks the shape + selectors AND the honesty invariants the catalog must never regress:
   every seeded endpoint is a Streamable-HTTP url the manager's http transport can actually drive
   (https or explicit loopback, no legacy `/sse`), ids are upsert-safe, `installable` tracks the auth tier, and installConfig
   never leaks a token. Pure + deterministic — two reads deep-equal. */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/mcp/catalog.js');
const ClassIcons = require('../frontend/app/classicons.js');

const AUTH = { none: 1, apikey: 1, oauth: 1 };
// the exact id shape POST /api/connectors accepts (index.js handleConnectorUpsert) — a catalog id that
// fails this could never be installed, so the catalog would be lying about it.
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// ---- A. list(): entries exist, carry the full shape, and are CLONED (no mutating the seed) ----
{
  const all = C.list();
  A.ok(Array.isArray(all) && all.length >= 10, 'catalog lists a real seed (>=10 connectors)');
  for (const e of all) {
    A.ok(ID_RE.test(e.id), 'id "' + e.id + '" is upsert-safe');
    A.ok(!!e.name, e.id + ' has a name');
    A.ok(!!e.category, e.id + ' has a category');
    A.ok(AUTH[e.authType] === 1, e.id + ' authType is none|apikey|oauth (got ' + e.authType + ')');
    A.eq(e.transport, 'http', e.id + ' transport is http (Streamable HTTP)');
    A.eq(typeof e.installable, 'boolean', e.id + ' exposes an installable flag');
    A.ok(!!e.blurb, e.id + ' has a human blurb');
  }
  // ids are unique (a dupe would collide on install / in the manager's config list).
  const ids = all.map(e => e.id);
  A.eq(new Set(ids).size, ids.length, 'connector ids are unique');
  const names = all.map(e => e.name.toLowerCase());
  A.eq(new Set(names).size, names.length, 'connector names are unique');
  const urls = all.map(e => String(e.url || '').replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  A.eq(new Set(urls).size, urls.length, 'canonical connector URLs are unique');
  // clone guarantee: mutating a returned entry must not leak into the next read.
  all[0].name = 'MUTATED';
  A.ok(C.list()[0].name !== 'MUTATED', 'list() returns defensive clones (seed is immutable)');
  const composio = all.find(e => e.id === 'composio');
  composio.presets[0] = 'MUTATED';
  A.eq(C.get('composio').presets[0], 'Gmail', 'nested presets are defensively cloned');
}

// ---- B. installable tracks the auth tier exactly (none|apikey today; oauth is listed-but-gated) ----
{
  for (const e of C.list()) {
    const expect = (e.authType === 'none' || e.authType === 'apikey');
    A.eq(e.installable, expect, e.id + ' installable === (auth is none|apikey)');
    A.eq(C.isInstallable(e), expect, e.id + ' isInstallable() agrees');
  }
  A.ok(C.INSTALLABLE_AUTH.indexOf('oauth') < 0, 'oauth is not a direct-install tier — it is stood up by its own sign-in flow');
  A.ok(C.INSTALLABLE_AUTH.indexOf('none') >= 0 && C.INSTALLABLE_AUTH.indexOf('apikey') >= 0, 'none+apikey are installable');
}

// ---- C. HONESTY invariants: only endpoints the http transport can drive; cleartext is loopback-only ----
{
  for (const e of C.list()) {
    // never seed a legacy GET-/sse dual-endpoint server — transport.http.js only speaks Streamable HTTP.
    A.ok(String(e.url).indexOf('/sse') < 0, e.id + ' url is not a legacy /sse endpoint');
    if (e.url) {
      const u = new URL(e.url);
      const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1');
      A.ok(u.protocol === 'https:' || (e.local && loopback), e.id + ' url is https or explicitly local loopback');
      if (e.local) A.ok(loopback, e.id + ' local flag never excuses a non-loopback cleartext URL');
    }
    // an installable connector MUST have a concrete transport-safe endpoint — otherwise "Add" would fail.
    if (e.installable) A.ok(/^https?:\/\/\S+/.test(e.url), e.id + ' installable ⇒ has a concrete http(s) url');
  }
}

// ---- D. categories(): stable known-first order, no dupes, covers every entry's category ----
{
  const cats = C.categories();
  A.eq(new Set(cats).size, cats.length, 'categories() has no duplicates');
  const seedCats = new Set(C.list().map(e => e.category));
  for (const c of seedCats) A.ok(cats.indexOf(c) >= 0, 'category "' + c + '" appears in categories()');
  A.eq(cats.length, seedCats.size, 'categories() lists exactly the categories in use');
  // known-first: 'Docs & Knowledge' (first in CATEGORY_ORDER) precedes any ad-hoc category.
  A.eq(cats[0], 'Docs & Knowledge', 'the ordered head is the first known category');
}

// ---- E. browse(installedIds): marks installed, groups cover all connectors in category order ----
{
  const b = C.browse(['deepwiki', 'not-a-real-id']);
  A.ok(Array.isArray(b.groups) && b.groups.length === b.categories.length, 'a group per category');
  const flat = b.groups.reduce((n, g) => n + g.connectors.length, 0);
  A.eq(flat, b.connectors.length, 'groups partition every connector exactly once');
  A.eq(b.connectors.length, C.list().length, 'browse covers the whole catalog');
  const dw = b.connectors.find(e => e.id === 'deepwiki');
  A.eq(dw.installed, true, 'a configured id is marked installed');
  A.eq(b.connectors.find(e => e.id === 'context7').installed, false, 'an unconfigured id is not installed');
  // group order follows categories() order.
  A.eq(b.groups.map(g => g.category).join('|'), b.categories.join('|'), 'group order == category order');
  // empty/absent input ⇒ nothing installed (never throws).
  A.ok(C.browse().connectors.every(e => e.installed === false), 'no input ⇒ nothing marked installed');
  // TRUTHFUL TELEMETRY: with {id,url}, a config that reuses a catalog id but points at a FOREIGN url is NOT installed;
  // the entry's real url IS. (Guards against a manual connector named 'stripe' flipping the vetted vendor card.)
  A.eq(C.browse([{ id: 'stripe', url: 'https://evil.example/mcp' }]).connectors.find(e => e.id === 'stripe').installed, false, 'foreign-url id collision is not installed');
  A.eq(C.browse([{ id: 'stripe', url: C.get('stripe').url }]).connectors.find(e => e.id === 'stripe').installed, true, 'the real catalog url marks it installed');
  A.eq(C.browse([{ id: 'stripe', url: C.get('stripe').url + '/' }]).connectors.find(e => e.id === 'stripe').installed, true, 'url match is trailing-slash tolerant');
}

// ---- F. installConfig(): upsert-shaped for installable entries, null for oauth, NEVER a token ----
{
  const cfg = C.installConfig('deepwiki');
  A.ok(cfg && cfg.id === 'deepwiki', 'installConfig returns a config for an installable entry');
  A.eq(cfg.transport, 'http', 'config carries transport');
  A.ok(/^https:\/\//.test(cfg.url), 'config carries the https url');
  A.eq(cfg.label, 'DeepWiki', 'config carries a friendly label');
  A.eq(cfg.enabled, true, 'config enables the connector');
  A.ok(!('token' in cfg), 'installConfig NEVER embeds a token (the user supplies it)');
  const composio = C.installConfig('composio');
  A.eq(composio.keyHeader, 'x-consumer-api-key', 'Composio declares its official non-Bearer key header');
  A.ok(!('token' in composio), 'custom-header install config still never embeds the user secret');
  A.eq(C.installConfig('notion'), null, 'installConfig is null for an oauth (not-installable) entry');
  A.eq(C.installConfig('nope'), null, 'installConfig is null for an unknown id');
}

// ---- G. determinism: repeated reads are byte-identical (pure, no ambient time/rng) ----
{
  A.eq(JSON.stringify(C.browse(['stripe'])), JSON.stringify(C.browse(['stripe'])), 'browse is deterministic');
  A.eq(JSON.stringify(C.list()), JSON.stringify(C.list()), 'list is deterministic');
}

// ---- H. the named common paste-a-key connectors (X, aggregator, search) are present + installable ----
{
  for (const id of ['x-twitter', 'composio', 'tavily']) {
    const e = C.get(id);
    A.ok(e, id + ' is in the catalog');
    A.eq(e.authType, 'apikey', id + ' is a paste-a-key (apikey) connector');
    A.eq(e.installable, true, id + ' is installable today');
    A.ok(/^https:\/\/\S+/.test(e.url), id + ' has a concrete https endpoint (verified reachable)');
    const cfg = C.installConfig(id);
    A.ok(cfg && !('token' in cfg), id + ' installConfig carries no token (the user pastes the key)');
  }
  A.eq(C.get('composio').keyHeader, 'x-consumer-api-key', 'Composio public metadata carries the required header name, never its value');
  A.ok(C.categories().indexOf('Social') >= 0, 'Social category is present (home for X)');
  A.eq(C.get('x-twitter').category, 'Social', 'X is filed under Social');
}

// ---- H2. Zernio: one direct first-party OAuth card for the multi-network social surface ----
{
  const zernio = C.get('zernio');
  A.ok(zernio, 'Zernio is in the catalog');
  A.eq(zernio.category, 'Social', 'Zernio is filed under Social');
  A.eq(zernio.authType, 'oauth', 'Zernio uses its recommended browser OAuth flow');
  A.eq(zernio.url, 'https://mcp.zernio.com/mcp', 'Zernio uses its official hosted Streamable-HTTP endpoint');
  A.eq(zernio.official, true, 'Zernio is marked first-party');
  A.eq(zernio.installable, false, 'Zernio is stood up by OAuth rather than direct token upsert');
  A.eq(C.installConfig('zernio'), null, 'the OAuth start/callback flow owns Zernio setup');
  A.ok(zernio.aliases.indexOf('instagram') >= 0 && zernio.aliases.indexOf('tiktok') >= 0 && zernio.aliases.indexOf('linkedin') >= 0,
    'common downstream social-network searches find the single Zernio card');
  A.ok(!!ClassIcons.platformIcon(zernio), 'Zernio inherits the established Social category seal');
  A.eq(C.list().filter(e => e.id === 'zernio' || /^zernio$/i.test(e.name)).length, 1, 'Zernio appears exactly once');
}

// ---- I. wave-2 additions: present, correctly tiered, and the Design category exists ----
{
  A.ok(C.categories().indexOf('Design') >= 0, 'Design category present (Canva/Webflow/Wix)');
  for (const id of ['gitlab', 'vercel', 'asana', 'canva', 'paypal', 'square', 'neon', 'netlify', 'monday', 'webflow', 'wix']) A.eq((C.get(id) || {}).authType, 'oauth', id + ' is an oauth connector');
  for (const id of ['airtable', 'prisma', 'intercom']) A.eq((C.get(id) || {}).authType, 'apikey', id + ' is a paste-a-key connector');
  for (const id of ['cloudflare-docs', 'microsoft-learn']) { const e = C.get(id); A.eq(e.authType, 'none', id + ' is zero-setup'); A.eq(e.installable, true, id + ' installs with no key'); }
  A.ok(C.list().length >= 30, 'catalog now carries a substantial verified set (30+)');
}

// ---- J. Registered GitHub device sign-in; url-less oauth entries carry `via` ----
{
  // GitHub has no dynamic registration; StarNet now supplies its own public device client.
  const gh = C.get('github');
  A.eq(gh.authType, 'oauth', 'github uses registered device sign-in');
  A.eq(gh.deviceFlow, true, 'github bypasses dynamic registration with its device client');
  A.eq(gh.installable, false, 'github is installed by sign-in rather than unauthenticated direct install');
  A.ok(!('token' in (C.installConfig('github') || {})), 'github installConfig carries no token');
  // `via` honesty: only url-less oauth entries carry it, and it must point at a REAL installable catalog
  // entry — otherwise the "VIA <name>" jump would land nowhere (a dead click with extra steps).
  for (const e of C.list()) {
    if (e.via) {
      A.eq(e.authType, 'oauth', e.id + ' via is only for oauth entries');
      A.eq(e.url, '', e.id + ' via is only for url-less entries (a direct endpoint signs in directly)');
      const target = C.get(e.via);
      A.ok(target && target.installable, e.id + ' via targets a real, installable catalog entry (' + e.via + ')');
    }
  }
  A.ok(!!(C.get('atlassian') || {}).via, 'atlassian points at its aggregator route (via)');
}

// ---- K. Google Workspace (2026-08-14): DIRECT official endpoints with staticOauth, no via-Zapier detour ----
{
  A.eq(C.get('google-workspace'), null, 'the stale via-zapier google-workspace umbrella row is gone');
  const GOOGLE = ['gmail', 'google-drive', 'google-calendar', 'google-docs', 'google-sheets'];
  for (const id of GOOGLE) {
    const e = C.get(id);
    A.ok(e, id + ' is in the catalog');
    A.eq(e.authType, 'oauth', id + ' is an oauth connector');
    A.eq(require('../sidecar/mcp/transport.google.js').ENDPOINTS[id], e.url, id + ' uses the stable Google API adapter');
    A.ok(!e.via, id + ' needs no aggregator detour');
    A.ok(e.staticOauth, id + ' carries staticOauth (Google has no dynamic client registration)');
    A.eq(e.staticOauth.authorizationServer, 'https://accounts.google.com', id + ' shares the ONE Google authorization server (client pasted once)');
    A.ok(/^https:\/\/accounts\.google\.com\//.test(e.staticOauth.authorizationEndpoint), id + ' authorize endpoint is Google\'s');
    A.eq(e.staticOauth.tokenEndpoint, 'https://oauth2.googleapis.com/token', id + ' token endpoint is Google\'s');
    A.ok(Array.isArray(e.staticOauth.scopes) && e.staticOauth.scopes.length >= 2, id + ' declares real scopes');
    A.ok(e.staticOauth.scopes.every(s => s === 'openid' || /^https:\/\/www\.googleapis\.com\/auth\//.test(s)), id + ' scopes are Google API and identity scopes');
    // Google never issues a refresh token without these — a connector that dies in an hour is a lie.
    A.eq(e.staticOauth.extraAuthParams.access_type, 'offline', id + ' requests offline access (refresh token)');
    A.eq(e.staticOauth.extraAuthParams.prompt, 'consent select_account', id + ' asks which account and requests consent');
    A.eq(e.staticOauth.clientSecretRequired, false, id + ' does not require a customer client secret');
    A.eq(e.staticOauth.developerPreview, false, id + ' does not depend on Developer Preview');
    A.ok(/^https:\/\/developers\.google\.com\/identity\//.test(e.staticOauth.setupUrl), id + ' links the official complete setup guide');
    A.ok(/StarNet supplies the Google application registration/i.test(e.staticOauth.setupNote), id + ' states the required Google Cloud enablement step');
    A.eq(C.installConfig(id), null, id + ' is not one-click-upsert installable (sign-in flow owns it)');
    A.ok(e.aliases.indexOf('google') >= 0 && e.aliases.indexOf('google workspace') >= 0, id + ' is findable by the google names');
  }
  // deep-clone guarantee for the new nested field: mutating a returned staticOauth must not leak into the seed.
  const g1 = C.get('gmail'); g1.staticOauth.scopes.push('MUTATED'); g1.staticOauth.extraAuthParams.prompt = 'MUTATED';
  const g2 = C.get('gmail');
  A.ok(g2.staticOauth.scopes.indexOf('MUTATED') < 0, 'staticOauth.scopes is defensively cloned');
  A.eq(g2.staticOauth.extraAuthParams.prompt, 'consent select_account', 'staticOauth.extraAuthParams is defensively cloned');
  // entries WITHOUT staticOauth carry an explicit null (a stable shape the UI can branch on).
  A.eq(C.get('notion').staticOauth, null, 'a DCR oauth entry has staticOauth: null');
}

// ---- K. requested parity additions are present once, and pre-existing routes stay singular ----
{
  const parallel = C.get('parallel-search');
  A.eq(parallel.url, 'https://search.parallel.ai/mcp', 'Parallel uses its verified anonymous Streamable-HTTP endpoint');
  A.eq(parallel.authType, 'none', 'Parallel anonymous tier is zero-setup');

  const unreal = C.get('unreal-engine');
  A.eq(unreal.category, 'Advanced / Developer', 'Unreal Engine is filed under Advanced / Developer');
  A.eq(unreal.url, 'http://127.0.0.1:8000/mcp', 'Unreal uses Epic\'s documented local editor endpoint');
  A.eq(unreal.local, true, 'Unreal is explicitly marked local');

  const composio = C.get('composio');
  A.eq(composio.presets, ['Gmail', 'Outlook'], 'one existing connector exposes the Gmail + Outlook presets');
  A.ok(composio.aliases.indexOf('email') >= 0 && composio.aliases.indexOf('microsoft outlook') >= 0, 'email searches resolve to the preset-bearing connector');
  A.eq(C.list().filter(e => /^gmail$/i.test(e.name)).length, 1, 'Gmail has exactly one direct connector card');
  A.eq(C.list().filter(e => /^(outlook|email)$/i.test(e.name)).length, 0, 'Composio presets do not create duplicate Outlook/Email connector cards');

  A.eq(C.list().filter(e => /duckduckgo/i.test(e.id + ' ' + e.name)).length, 0, 'DuckDuckGo is not duplicated as a connector (it is built into web_search)');
  A.eq(C.get('atlassian').via, 'zapier', 'Atlassian stays on the proven route until an authenticated direct tool call exists');
}

// ---- L. wave-4 additions (2026-08-28): mint-proven OAuth+DCR rows + one zero-setup docs row ----
{
  for (const id of ['todoist', 'clickup', 'railway', 'grafana', 'posthog', 'cloudflare-bindings',
    'cal-com', 'fireflies', 'algolia', 'buildkite', 'datadog', 'globalping', 'honeybadger',
    'jam', 'sanity', 'semgrep', 'close-crm', 'ramp']) {
    const e = C.get(id);
    A.ok(e, id + ' is in the catalog');
    A.eq(e.authType, 'oauth', id + ' is an oauth connector (DCR mint live-proven 2026-08-28)');
    A.ok(/^https:\/\/\S+/.test(e.url), id + ' has a concrete https endpoint');
    A.ok(!e.via, id + ' signs in directly — no aggregator detour');
    A.eq(e.staticOauth, null, id + ' rides dynamic registration, not a pre-registered client');
    A.eq(C.installConfig(id), null, id + ' is stood up by the sign-in flow, not one-click upsert');
    A.ok(e.aliases.length >= 2, id + ' carries the names a Commander actually types');
  }
  const oai = C.get('openai-devdocs');
  A.eq(oai.authType, 'none', 'OpenAI DevDocs is zero-setup');
  A.eq(oai.installable, true, 'OpenAI DevDocs installs with no key');
  A.eq(oai.category, 'Docs & Knowledge', 'OpenAI DevDocs files under Docs & Knowledge');
  // the two Cloudflare surfaces stay DISTINCT cards: keyless docs search vs account-scoped OAuth management.
  A.ok(C.get('cloudflare-docs') && C.get('cloudflare-bindings'), 'Cloudflare docs and account cards coexist');
  A.ok(C.get('cloudflare-docs').name !== C.get('cloudflare-bindings').name, 'the two Cloudflare cards have distinct names');
}

// report() LAST — it is what calls process.exit(fail?1:0). This file used to end in a bare
// console.log, so every assertion failure printed FAIL and STILL exited 0: the fast gate scored
// it green no matter what broke. Never end an _assert.js test any other way.
A.report('mcp.catalog.test');
