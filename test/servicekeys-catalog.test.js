/* node test/servicekeys-catalog.test.js — the KEYS platform directory (sidecar/servicekeys-catalog.js).

   This directory exists because most platforms ship NO remote MCP server (probed 2026-07-24: printify,
   printful, etsy, woocommerce, shopify all 404 or do not resolve), so the generic KEYS + web_request path
   is their route and the picker is how a user finds it. A row here is a PROMISE that picking it works —
   so the invariants below are the honesty gate:

     • picking a row must PREFILL a name whose derived env var is exactly the one advertised, or the
       agent's ${PLACEHOLDER} would name a variable that does not exist
     • every row must survive a REAL upsert, so no row can be a dead click (a model-provider name would be
       refused as reserved — that trap shipped in a draft of this file and is locked out here)
     • every row must carry a docs URL: it rides into the system prompt and is what lets the agent find the
       right endpoint instead of guessing */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/servicekeys-catalog.js');
const K = require('../sidecar/servicekeys.js');

// stand-in for the host's real reserved set (every model-provider keyEnv + its scoped forms)
const RESERVED = new Set(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'STARNET_OPENROUTER_API_KEY', 'SKYNET_OPENROUTER_API_KEY']);

A.ok(C.PLATFORMS.length >= 15, 'the directory is seeded (' + C.PLATFORMS.length + ' platforms)');

// ---- A. per-row invariants ----
const ids = new Set();
for (const p of C.PLATFORMS) {
  const at = ' [' + p.id + ']';
  A.ok(/^[a-z0-9-]+$/.test(p.id), 'id is a slug' + at);
  A.ok(!ids.has(p.id), 'id is unique' + at); ids.add(p.id);
  A.ok(!!p.name && !!p.category && !!p.blurb, 'name/category/blurb present' + at);

  // THE LOAD-BEARING ONE: the picker prefills `name`, and servicekeys derives the env var from it.
  A.eq(K.deriveEnvVar(p.name), p.envVar, 'deriveEnvVar(name) === advertised envVar' + at);

  // docsUrl rides into the prompt — an agent with no docs link guesses endpoints.
  A.ok(/^https:\/\//.test(p.docsUrl || ''), 'has an https docs URL' + at);
  A.ok(/^https:\/\//.test(p.apiBase || '') || /\{/.test(p.apiBase || ''), 'apiBase is https or an explicit template' + at);

  // an authHint must actually reference THIS row's key, or it teaches the wrong placeholder
  if (p.authHint) A.ok(p.authHint.indexOf('${' + p.envVar + '}') >= 0, 'authHint uses this row\'s placeholder' + at);

  // NO DEAD CLICKS: the row must survive the real upsert path, reserved-name guard included.
  const r = K.upsert([], { name: p.name, key: 'probe-key', docsUrl: p.docsUrl }, 1, { reservedEnv: RESERVED });
  A.ok(!r.error, 'a real upsert accepts this row' + at + (r.error ? ' — ' + r.error : ''));
  if (!r.error) A.eq(r.record.envVar, p.envVar, 'the saved record carries the advertised envVar' + at);
}

// ---- B. no model providers (their env names are reserved; the row would always fail on save) ----
for (const p of C.PLATFORMS) {
  A.ok(!RESERVED.has(p.envVar), 'no reserved provider env var in the directory [' + p.id + ']');
  A.ok(!/^(openrouter|anthropic|openai)$/i.test(p.id), 'no model-provider row [' + p.id + ']');
}

// ---- C. the commerce gap this whole lane came from is actually covered ----
{
  const byId = id => C.PLATFORMS.find(p => p.id === id);
  for (const id of ['printify', 'printful', 'gelato', 'prodigi', 'shopify', 'etsy']) {
    A.ok(!!byId(id), 'the directory covers ' + id + ' — the case with no MCP server anywhere');
  }
  A.eq(byId('printify').envVar, 'PRINTIFY_API_KEY', 'Printify resolves to the env var the docs promise');
  A.ok(/Bearer/.test(byId('printify').authHint || ''), 'Printify carries its verified bearer hint');
  A.eq(byId('printful').envVar, 'PRINTFUL_API_KEY', 'Printful resolves to the env var the docs promise');
  A.ok(/Bearer/.test(byId('printful').authHint || ''), 'Printful carries its verified bearer hint');
  A.eq(byId('gelato').apiBase, 'https://order.gelatoapis.com', 'Gelato points at its current order API host');
  A.ok(/^X-API-KEY:/.test(byId('gelato').authHint || ''), 'Gelato carries its verified API-key header');
  A.eq(byId('prodigi').apiBase, 'https://api.prodigi.com/v4.0', 'Prodigi points at its current live v4 API');
  A.ok(/^X-API-Key:/.test(byId('prodigi').authHint || ''), 'Prodigi carries its verified API-key header');
  A.ok(/sandbox/i.test(byId('prodigi').note || ''), 'Prodigi points users to the non-fulfilling sandbox for tests');
  for (const id of ['printify', 'printful', 'gelato', 'prodigi']) {
    A.ok((byId(id).aliases || []).includes('pod'), id + ' is discoverable by the POD acronym');
  }
  // Etsy needs OAuth for most endpoints — it must SAY so rather than imply a key is enough
  A.ok(/OAuth/i.test(byId('etsy').note || ''), 'Etsy warns that a keystring alone is not enough');
  A.eq(byId('etsy').unattendedSupported, false, 'Etsy explicitly disables unattended mode until OAuth refresh is managed');
  A.ok(/one[- ]hour/i.test(byId('etsy').note || ''), 'Etsy warning explains the one-hour access-token lifetime');
  A.ok(/does not.*refresh/i.test(byId('etsy').unattendedReason || ''), 'Etsy policy explains the missing refresh lifecycle');
  // Shopify is per-store, so a fixed apiBase would be a lie
  A.ok(/\{/.test(byId('shopify').apiBase || ''), 'Shopify apiBase is templated on the store host');
}

// ---- D. grouping / selectors ----
{
  const groups = C.grouped(['PRINTIFY_API_KEY']);
  A.ok(groups.length >= 3, 'grouped() returns categories');
  const flat = groups.flatMap(g => g.platforms);
  A.eq(flat.length, C.PLATFORMS.length, 'grouping loses no platform');
  A.eq(flat.find(p => p.id === 'printify').installed, true, 'an existing key marks its platform installed');
  A.eq(flat.find(p => p.id === 'printful').installed, false, 'others are not marked installed');
  A.eq(flat.find(p => p.id === 'gelato').installed, false, 'new POD rows participate in installed-state grouping');
  A.ok(groups[0].category === C.CATEGORY_ORDER[0], 'declared category order leads');
  // no secret-bearing FIELD may ride the payload (the word "key" legitimately appears in blurbs/notes,
  // so assert on property names, not on the serialized text).
  const secretish = flat.filter(p => ['key', 'token', 'secret', 'apiKey'].some(f => Object.prototype.hasOwnProperty.call(p, f)));
  A.eq(secretish.length, 0, 'no platform row carries a key/token/secret field');
  A.eq(C.grouped([]).flatMap(g => g.platforms).every(p => p.installed === false), true, 'nothing installed on an empty store');
  A.eq(C.byId('printify').id, 'printify', 'byId resolves');
  A.eq(C.byId('nope'), null, 'byId is null for an unknown id');
}

// ---- E. search/API additions: exact auth shape, no duplicate built-in DuckDuckGo row ----
{
  const brave = C.byId('brave-search');
  A.eq(brave.envVar, 'BRAVE_SEARCH_API_KEY', 'Brave Search advertises its saved environment variable');
  A.ok(/^X-Subscription-Token:/.test(brave.authHint || ''), 'Brave carries its verified subscription-token header');

  const firecrawl = C.byId('firecrawl');
  A.eq(firecrawl.apiBase, 'https://api.firecrawl.dev/v2', 'Firecrawl points at the current v2 REST base');
  A.ok(/Bearer/.test(firecrawl.authHint || ''), 'Firecrawl carries its verified bearer header');

  A.eq(C.PLATFORMS.filter(p => /duckduckgo/i.test(p.id + ' ' + p.name)).length, 0,
    'DuckDuckGo is not duplicated in KEYS because web_search already owns it');
}

// ---- F. wave-2 (2026-08-30): the unique-business directory — every apiBase live-probed that day ----
{
  const WAVE2 = ['supliful', 'fourthwall', 'shineon', 'spod', 'teemill', 'zazzle', 'gumroad',
    'lemon-squeezy', 'cj-dropshipping', 'keepa', 'discogs', 'lob', 'lulu', 'duffel', 'porkbun',
    'elevenlabs', 'heygen', 'bannerbear', 'shotstack', 'bland', 'vapi', 'deepl', 'transistor'];
  for (const id of WAVE2) A.ok(!!C.byId(id), 'wave-2 row present [' + id + ']');
  // quirky-auth rows must explain the shape in `note` INSTEAD of carrying a header hint they can't honor
  for (const id of ['keepa', 'porkbun', 'lob', 'lulu', 'zazzle', 'gumroad', 'cj-dropshipping', 'bland']) {
    const p = C.byId(id);
    A.ok(!p.authHint, id + ' has no header hint (its auth is not a simple header)');
    A.ok(!!p.note, id + ' explains its auth shape in note');
  }
  // DeepL's header shape came verbatim from the API's own 403 error — lock it
  A.ok(/^Authorization: DeepL-Auth-Key /.test(C.byId('deepl').authHint || ''), 'DeepL carries its API-verified auth header');
  // real-world-consequence rows must warn (mail prints, phones dial, flights book)
  for (const id of ['lob', 'duffel', 'bland', 'vapi']) {
    A.ok(/test|sandbox|own number/i.test(C.byId(id).note || ''), id + ' warns about real-world side effects / points at test mode');
  }
  A.ok(C.CATEGORY_ORDER.indexOf('Physical World') >= 0, 'Physical World category is declared in the order');
}

// ---- G. retired docs links heal; a vendor with no API of its own says so (2026-10-07 live audit) ----
{
  // a saved key stores its docsUrl and the prompt reads THAT copy — a moved vendor page must heal on load
  for (const id of ['supliful', 'teemill', 'zazzle']) A.ok((C.byId(id).retiredDocsUrls || []).length > 0, id + ' lists the docs link it retired');
  for (const p of C.PLATFORMS.filter(row => row.retiredDocsUrls)) {
    const at = ' [' + p.id + ']';
    A.ok(Array.isArray(p.retiredDocsUrls) && p.retiredDocsUrls.every(u => /^https:\/\//.test(u)), 'retired links are https strings' + at);
    A.ok(p.retiredDocsUrls.indexOf(p.docsUrl) < 0, 'the current docs link is never listed as retired' + at);
    for (const u of p.retiredDocsUrls) {
      A.eq(C.healDocsUrl({ id: p.id, envVar: p.envVar, docsUrl: u }).docsUrl, p.docsUrl, 'a key saved with ' + u + ' heals' + at);
      A.eq(C.healDocsUrl({ id: 'renamed-' + p.id, envVar: p.envVar, docsUrl: u + ' ' }).docsUrl, p.docsUrl, 'a key saved under another name heals by its env var' + at);
    }
  }
  const typed = { id: 'supliful', envVar: 'SUPLIFUL_API_KEY', docsUrl: 'https://example.com/my-own-notes' };
  A.eq(C.healDocsUrl(typed), typed, 'a docs link the Commander typed is never rewritten');
  A.eq(C.healDocsUrl({ id: 'custom', envVar: 'CUSTOM_API_KEY', docsUrl: 'https://docs.supliful.com/' }).docsUrl, 'https://docs.supliful.com/', 'only the matching platform heals its own retired link');
  A.eq(C.healDocsUrl(null), null, 'a missing record passes through');
  // no public API of its own → the card must not claim one; the note says what the row really uses
  A.eq(C.byId('supliful').apiVia, 'Shopify Admin API', 'Supliful names the API it actually uses');
  for (const p of C.PLATFORMS.filter(row => row.apiVia)) {
    A.ok(/no public API/i.test(p.note || '') && /\{your-store\}|https:\/\//.test(p.apiBase || ''), p.id + ' explains why it routes through ' + p.apiVia);
  }
}

A.report('servicekeys-catalog.test.js');
