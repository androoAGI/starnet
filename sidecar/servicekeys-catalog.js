/* sidecar/servicekeys-catalog.js — the PLATFORM directory behind the KEYS tab.

   WHY THIS EXISTS, and why it is NOT more MCP catalog rows: most platforms people want to connect ship no
   remote MCP server at all. Probed 2026-07-24 — printify, printful, etsy, woocommerce, shopify(catalog/dev)
   all 404 or do not resolve, and the only Printify MCP that exists is a LOCAL `npx` server StarNet
   deliberately refuses to spawn. Seeding them as connectors would be a lie the moment a user clicked.

   What DOES work for every one of them is the generic path: paste the platform's API key in KEYS, place a
   dish, and the agent calls the REST API with web_request. This directory just makes that path findable —
   it turns "paste a key for… something?" into "pick your platform". Each row is pure data:

     id       — stable slug
     name     — what the Commander picks; servicekeys.deriveEnvVar(name) MUST equal envVar (locked by test)
     envVar   — the name the agent references as ${ENVVAR} in a header
     docsUrl  — the API reference. This rides into the system prompt, so the agent can look up endpoints
                itself instead of guessing — the single highest-value field here.
     apiBase  — the documented base URL, shown so a Commander can sanity-check what the agent will call
     authHint — the header shape, ONLY where verified. Omitted rather than guessed: a wrong hint would send
                every agent down a broken path, which is worse than no hint (the agent reads docsUrl).
     note     — anything that would otherwise surprise the user (e.g. OAuth, per-store hosts)

   Adding a platform is a DATA ROW here, never new code — same extension model as mcp/catalog.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.servicekeysCatalog = api); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORY_ORDER = ['Commerce & Print-on-Demand', 'Physical World', 'Payments', 'Email & Messaging', 'Search & Research', 'Data & Content', 'Developer Tools', 'AI & Media'];

  const PLATFORMS = [
    // ── Commerce & Print-on-Demand — the gap that started this: no MCP server exists for ANY of these ──
    { id: 'printify', name: 'Printify', category: 'Commerce & Print-on-Demand', envVar: 'PRINTIFY_API_KEY',
      docsUrl: 'https://developers.printify.com/', apiBase: 'https://api.printify.com/v1',
      authHint: 'Authorization: Bearer ${PRINTIFY_API_KEY}',
      aliases: ['pod', 'print on demand', 'merch', 'marketplace products'],
      blurb: 'Print-on-demand: shops, blueprints, products, orders, publishing.',
      note: 'Create a personal access token under Printify → Settings → API.' },

    { id: 'printful', name: 'Printful', category: 'Commerce & Print-on-Demand', envVar: 'PRINTFUL_API_KEY',
      docsUrl: 'https://developers.printful.com/', apiBase: 'https://api.printful.com',
      authHint: 'Authorization: Bearer ${PRINTFUL_API_KEY}',
      aliases: ['pod', 'print on demand', 'merch', 'marketplace products'],
      blurb: 'Print-on-demand fulfilment: catalog, orders, mockups, shipping rates.' },

    { id: 'gelato', name: 'Gelato', category: 'Commerce & Print-on-Demand', envVar: 'GELATO_API_KEY',
      docsUrl: 'https://dashboard.gelato.com/docs/', apiBase: 'https://order.gelatoapis.com',
      authHint: 'X-API-KEY: ${GELATO_API_KEY}',
      aliases: ['pod', 'print on demand', 'merch', 'marketplace products'],
      blurb: 'Print-on-demand products and fulfilment: templates, store publishing, quotes, orders.',
      note: 'Create an API key in Gelato’s API Portal. Product publishing starts from a Gelato template and connected store.' },

    { id: 'prodigi', name: 'Prodigi', category: 'Commerce & Print-on-Demand', envVar: 'PRODIGI_API_KEY',
      docsUrl: 'https://www.prodigi.com/print-api/docs/reference/', apiBase: 'https://api.prodigi.com/v4.0',
      authHint: 'X-API-Key: ${PRODIGI_API_KEY}',
      aliases: ['pod', 'print on demand', 'merch', 'marketplace products'],
      blurb: 'Print-on-demand fulfilment: product details, quotes, orders, shipping and status.',
      note: 'Use Prodigi’s sandbox API and sandbox key while testing; live API orders can enter fulfilment.' },

    { id: 'shopify', name: 'Shopify', category: 'Commerce & Print-on-Demand', envVar: 'SHOPIFY_API_KEY',
      docsUrl: 'https://shopify.dev/docs/api/admin-rest', apiBase: 'https://{your-store}.myshopify.com/admin/api',
      authHint: 'X-Shopify-Access-Token: ${SHOPIFY_API_KEY}',
      blurb: 'Storefront admin: products, orders, customers, inventory.',
      note: 'The host is YOUR store (your-store.myshopify.com), so tell the agent which store it is working on.' },

    { id: 'etsy', name: 'Etsy', category: 'Commerce & Print-on-Demand', envVar: 'ETSY_API_KEY',
      docsUrl: 'https://developers.etsy.com/documentation/', apiBase: 'https://openapi.etsy.com/v3',
      blurb: 'Public/manual API work only — persistent shop automation is not connected.',
      unattendedSupported: false,
      unattendedReason: 'StarNet does not yet manage Etsy OAuth consent or refresh its one-hour access tokens.',
      note: 'MANUAL OAUTH ONLY: Etsy private/write endpoints need OAuth 2.0; access tokens expire after one hour. StarNet does not refresh them yet, so this key cannot be enabled for scheduled, messaged, or Night Shift runs.' },

    /* ── WAVE 2 (2026-08-30): the "whole business on one key" directory. Every apiBase below answered a
       live probe with an auth-shaped error (or a real response) on 2026-08-30 — the row is a live API,
       not a guess. authHint appears ONLY where the header shape is documented/verified; rows with quirky
       auth (query-param, JSON-body, Basic, token exchange) carry the shape in `note` instead. ── */

    // Commerce & POD — the unique verticals: supplements, creator merch, jewelry, sustainable apparel.
    { id: 'supliful', name: 'Supliful', category: 'Commerce & Print-on-Demand', envVar: 'SUPLIFUL_API_KEY',
      docsUrl: 'https://docs.supliful.com/', apiBase: 'https://app.supliful.com/api/v1',
      aliases: ['pod', 'supplements', 'vitamins', 'skincare', 'coffee', 'private label'],
      blurb: 'Supplement, coffee, and skincare print-on-demand: white-label products, orders, fulfilment.',
      note: 'Create an API key in the Supliful app. An agent can design labels, create products, and route orders.' },
    { id: 'fourthwall', name: 'Fourthwall', category: 'Commerce & Print-on-Demand', envVar: 'FOURTHWALL_API_KEY',
      docsUrl: 'https://docs.fourthwall.com/', apiBase: 'https://api.fourthwall.com/open-api/v1.0',
      aliases: ['pod', 'creator merch', 'merch storefront', 'fan shop'],
      blurb: 'Creator merch storefronts: products, offers, orders, memberships.',
      note: 'Generate an API token in Fourthwall → Settings → For developers.' },
    { id: 'shineon', name: 'ShineOn', category: 'Commerce & Print-on-Demand', envVar: 'SHINEON_API_KEY',
      docsUrl: 'https://api.shineon.com/docs', apiBase: 'https://api.shineon.com/v1',
      aliases: ['pod', 'jewelry', 'necklace', 'pendant', 'message card'],
      blurb: 'Jewelry print-on-demand: pendants and message-card products, orders, fulfilment.' },
    { id: 'spod', name: 'SPOD', category: 'Commerce & Print-on-Demand', envVar: 'SPOD_API_KEY',
      docsUrl: 'https://rest.spod.com/docs', apiBase: 'https://rest.spod.com',
      aliases: ['pod', 'print on demand', 'spreadshirt', 'apparel'],
      blurb: 'Spreadshirt\'s print-on-demand engine: articles, orders, shipping, stock.' },
    { id: 'teemill', name: 'Teemill', category: 'Commerce & Print-on-Demand', envVar: 'TEEMILL_API_KEY',
      docsUrl: 'https://teemill.com/api-info/', apiBase: 'https://api.teemill.com',
      authHint: 'Authorization: Bearer ${TEEMILL_API_KEY}',
      aliases: ['pod', 'sustainable', 'organic apparel', 'circular fashion'],
      blurb: 'Sustainable organic-cotton print-on-demand: create products from an image URL in one call.' },
    { id: 'zazzle', name: 'Zazzle', category: 'Commerce & Print-on-Demand', envVar: 'ZAZZLE_API_KEY',
      docsUrl: 'https://www.zazzle.com/sell/developers/createaproduct', apiBase: 'https://www.zazzle.com/api/create',
      aliases: ['pod', 'print on demand', 'mugs', 'cards', 'gifts'],
      blurb: 'Create-a-Product across ~1,300 Zazzle product types (mugs, cards, wrapping paper, skateboards…).',
      note: 'Zazzle uses your associate/member ID in Create-a-Product URLs, not a secret header — save your associate ID as the key.' },
    { id: 'gumroad', name: 'Gumroad', category: 'Commerce & Print-on-Demand', envVar: 'GUMROAD_API_KEY',
      docsUrl: 'https://gumroad.com/api', apiBase: 'https://api.gumroad.com/v2',
      aliases: ['digital products', 'downloads', 'creator sales'],
      blurb: 'Sell digital products: create/list products, licenses, sales.',
      note: 'Create an application access token in Gumroad → Settings → Advanced. The token rides the access_token parameter.' },
    { id: 'lemon-squeezy', name: 'Lemon Squeezy', category: 'Commerce & Print-on-Demand', envVar: 'LEMON_SQUEEZY_API_KEY',
      docsUrl: 'https://docs.lemonsqueezy.com/api', apiBase: 'https://api.lemonsqueezy.com/v1',
      authHint: 'Authorization: Bearer ${LEMON_SQUEEZY_API_KEY}',
      aliases: ['digital products', 'saas billing', 'licenses'],
      blurb: 'Digital products, subscriptions, and license keys.' },
    { id: 'cj-dropshipping', name: 'CJ Dropshipping', category: 'Commerce & Print-on-Demand', envVar: 'CJ_DROPSHIPPING_API_KEY',
      docsUrl: 'https://developers.cjdropshipping.com/', apiBase: 'https://developers.cjdropshipping.com/api2.0/v1',
      aliases: ['dropshipping', 'sourcing', 'fulfilment'],
      blurb: 'Dropshipping end to end: product sourcing, listings, orders, logistics.',
      note: 'CJ exchanges your API key for a short-lived access token via getAccessToken — the docs show the flow; the agent can do the exchange itself.' },
    { id: 'keepa', name: 'Keepa', category: 'Commerce & Print-on-Demand', envVar: 'KEEPA_API_KEY',
      docsUrl: 'https://keepa.com/#!discuss/t/rest-api/110', apiBase: 'https://api.keepa.com',
      aliases: ['amazon', 'price tracking', 'arbitrage', 'product research'],
      blurb: 'Amazon product and price-history intel for research and arbitrage.',
      note: 'The key rides the ?key= query parameter, not a header.' },
    { id: 'discogs', name: 'Discogs', category: 'Commerce & Print-on-Demand', envVar: 'DISCOGS_API_KEY',
      docsUrl: 'https://www.discogs.com/developers', apiBase: 'https://api.discogs.com',
      authHint: 'Authorization: Discogs token=${DISCOGS_API_KEY}',
      aliases: ['vinyl', 'records', 'collectibles', 'marketplace'],
      blurb: 'The vinyl/record marketplace: search, pricing, collection, and listings.' },

    // ── Physical World — the agent touches paper, books, and planes ──
    { id: 'lob', name: 'Lob', category: 'Physical World', envVar: 'LOB_API_KEY',
      docsUrl: 'https://docs.lob.com/', apiBase: 'https://api.lob.com/v1',
      aliases: ['direct mail', 'postcards', 'letters', 'print and mail'],
      blurb: 'Send real postcards, letters, and checks by API — direct-mail campaigns from an agent.',
      note: 'Lob uses HTTP Basic auth with the key as the username (empty password). Test keys print nothing.' },
    { id: 'lulu', name: 'Lulu', category: 'Physical World', envVar: 'LULU_API_KEY',
      docsUrl: 'https://developers.lulu.com/', apiBase: 'https://api.lulu.com',
      aliases: ['book publishing', 'print books', 'self publishing'],
      blurb: 'Print and drop-ship real books: cost calculations, print jobs, tracking.',
      note: 'Lulu issues a client key + secret exchanged for a bearer token (client-credentials) — the docs show the flow; use the sandbox (api.sandbox.lulu.com) while testing.' },
    { id: 'duffel', name: 'Duffel', category: 'Physical World', envVar: 'DUFFEL_API_KEY',
      docsUrl: 'https://duffel.com/docs/api', apiBase: 'https://api.duffel.com',
      authHint: 'Authorization: Bearer ${DUFFEL_API_KEY}',
      aliases: ['flights', 'travel', 'booking', 'airlines'],
      blurb: 'Flight search, offers, and booking — a travel-agent workflow by API.',
      note: 'Every request also needs a Duffel-Version header (see docs). Test mode books nothing real.' },

    // ── Payments ──
    { id: 'stripe', name: 'Stripe', category: 'Payments', envVar: 'STRIPE_API_KEY',
      docsUrl: 'https://docs.stripe.com/api', apiBase: 'https://api.stripe.com/v1',
      authHint: 'Authorization: Bearer ${STRIPE_API_KEY}',
      blurb: 'Payments, customers, invoices, subscriptions.',
      note: 'Prefer a restricted key. Stripe also has a one-click MCP connector in CATALOG — use that if you want tools instead of raw REST.' },

    // ── Email & Messaging ──
    { id: 'resend', name: 'Resend', category: 'Email & Messaging', envVar: 'RESEND_API_KEY',
      docsUrl: 'https://resend.com/docs/api-reference/introduction', apiBase: 'https://api.resend.com',
      authHint: 'Authorization: Bearer ${RESEND_API_KEY}',
      blurb: 'Transactional email sending, domains, audiences.' },

    { id: 'sendgrid', name: 'SendGrid', category: 'Email & Messaging', envVar: 'SENDGRID_API_KEY',
      docsUrl: 'https://www.twilio.com/docs/sendgrid/api-reference', apiBase: 'https://api.sendgrid.com/v3',
      authHint: 'Authorization: Bearer ${SENDGRID_API_KEY}',
      blurb: 'Email delivery, templates, and stats.' },

    // ── Search & Research — raw REST APIs; DuckDuckGo is already built into web_search ──
    { id: 'brave-search', name: 'Brave Search', category: 'Search & Research', envVar: 'BRAVE_SEARCH_API_KEY',
      docsUrl: 'https://api-dashboard.search.brave.com/api-reference/web/search/get', apiBase: 'https://api.search.brave.com/res/v1',
      authHint: 'X-Subscription-Token: ${BRAVE_SEARCH_API_KEY}',
      aliases: ['brave', 'brave web search'],
      blurb: 'Independent web and news search through Brave\'s REST API.' },

    { id: 'firecrawl', name: 'Firecrawl', category: 'Search & Research', envVar: 'FIRECRAWL_API_KEY',
      docsUrl: 'https://docs.firecrawl.dev/api-reference/introduction', apiBase: 'https://api.firecrawl.dev/v2',
      authHint: 'Authorization: Bearer ${FIRECRAWL_API_KEY}',
      aliases: ['firecrawl search', 'web scrape', 'web crawl', 'web extraction'],
      blurb: 'Search, scrape, crawl, map, and extract structured content from websites.' },

    // ── Data & Content ──
    { id: 'airtable', name: 'Airtable', category: 'Data & Content', envVar: 'AIRTABLE_API_KEY',
      docsUrl: 'https://airtable.com/developers/web/api/introduction', apiBase: 'https://api.airtable.com/v0',
      authHint: 'Authorization: Bearer ${AIRTABLE_API_KEY}',
      blurb: 'Bases, tables, and records as a lightweight database.' },

    { id: 'notion', name: 'Notion', category: 'Data & Content', envVar: 'NOTION_API_KEY',
      docsUrl: 'https://developers.notion.com/reference/intro', apiBase: 'https://api.notion.com/v1',
      authHint: 'Authorization: Bearer ${NOTION_API_KEY}',
      blurb: 'Pages, databases, and blocks.',
      note: 'Notion also has a one-click OAuth connector in CATALOG — that is usually the easier route.' },

    // ── Developer Tools ──
    { id: 'jina', name: 'Jina', category: 'Developer Tools', envVar: 'JINA_API_KEY',
      docsUrl: 'https://jina.ai/reader/', apiBase: 'https://r.jina.ai',
      blurb: 'Cleaner page-text extraction for web_fetch — pages come back as readable text instead of raw HTML.',
      note: 'Optional. StarNet uses this automatically for web_fetch when connected; without it pages still load, just with cruder text extraction. Jina\'s keyless tier no longer works.' },

    { id: 'github', name: 'GitHub', category: 'Developer Tools', envVar: 'GITHUB_API_KEY',
      docsUrl: 'https://docs.github.com/rest', apiBase: 'https://api.github.com',
      authHint: 'Authorization: Bearer ${GITHUB_API_KEY}',
      blurb: 'Repos, issues, pull requests, actions.',
      note: 'GitHub also has a one-click MCP connector in CATALOG.' },

    { id: 'porkbun', name: 'Porkbun', category: 'Developer Tools', envVar: 'PORKBUN_API_KEY',
      docsUrl: 'https://porkbun.com/api/json/v3/documentation', apiBase: 'https://api.porkbun.com/api/json/v3',
      aliases: ['domains', 'dns', 'domain registration'],
      blurb: 'Domain search, registration, DNS, and portfolio management.',
      note: 'Porkbun wants BOTH an apikey and secretapikey in the JSON request body — save the secret as a second KEYS entry named "Porkbun Secret" and enable API access per-domain in the Porkbun dashboard.' },

    // ── AI & Media — the content-factory tier: voice, avatar video, auto-design, phone agents ──
    { id: 'elevenlabs', name: 'ElevenLabs', category: 'AI & Media', envVar: 'ELEVENLABS_API_KEY',
      docsUrl: 'https://elevenlabs.io/docs/api-reference/introduction', apiBase: 'https://api.elevenlabs.io/v1',
      authHint: 'xi-api-key: ${ELEVENLABS_API_KEY}',
      aliases: ['voice', 'tts', 'voiceover', 'audiobook', 'narration'],
      blurb: 'Voice generation: narration, voiceovers, audiobooks, dubbing.' },
    { id: 'heygen', name: 'HeyGen', category: 'AI & Media', envVar: 'HEYGEN_API_KEY',
      docsUrl: 'https://docs.heygen.com/', apiBase: 'https://api.heygen.com',
      authHint: 'X-Api-Key: ${HEYGEN_API_KEY}',
      aliases: ['avatar video', 'spokesperson', 'talking head', 'video generation'],
      blurb: 'Avatar spokesperson videos: generate presenter videos from a script.' },
    { id: 'simli', name: 'Simli', category: 'AI & Media', envVar: 'SIMLI_API_KEY',
      docsUrl: 'https://docs.simli.com/', apiBase: 'https://api.simli.ai',
      authHint: 'x-simli-api-key: ${SIMLI_API_KEY}',
      aliases: ['video call', 'avatar', 'talking head', 'lip sync', 'face'],
      blurb: 'Real-time talking face. Enables the VIDEO CALL button: a live call with your lead agent.',
      note: 'Create an API key at app.simli.com. The face is chosen in the call panel (any Simli face ID).' },
    { id: 'bannerbear', name: 'Bannerbear', category: 'AI & Media', envVar: 'BANNERBEAR_API_KEY',
      docsUrl: 'https://developers.bannerbear.com/', apiBase: 'https://api.bannerbear.com/v2',
      authHint: 'Authorization: Bearer ${BANNERBEAR_API_KEY}',
      aliases: ['auto design', 'image generation', 'templates', 'social graphics'],
      blurb: 'Templated image/design rendering at scale — product mockups, social graphics, thumbnails.' },
    { id: 'shotstack', name: 'Shotstack', category: 'AI & Media', envVar: 'SHOTSTACK_API_KEY',
      docsUrl: 'https://shotstack.io/docs/api/', apiBase: 'https://api.shotstack.io/edit/v1',
      authHint: 'x-api-key: ${SHOTSTACK_API_KEY}',
      aliases: ['video editing', 'video render', 'shorts', 'video automation'],
      blurb: 'Programmatic video editing: assemble and render videos from JSON timelines.',
      note: 'Use the stage environment (api.shotstack.io/edit/stage) while testing — stage renders are free with a watermark.' },
    { id: 'bland', name: 'Bland', category: 'AI & Media', envVar: 'BLAND_API_KEY',
      docsUrl: 'https://docs.bland.ai/', apiBase: 'https://api.bland.ai/v1',
      aliases: ['ai phone', 'phone calls', 'voice agent', 'call automation'],
      blurb: 'AI phone calls: place and manage automated voice calls — a phone-answering service by API.',
      note: 'The raw key rides the authorization header with no Bearer prefix (see docs). Calls dial real phones — test on your own number first.' },
    { id: 'vapi', name: 'Vapi', category: 'AI & Media', envVar: 'VAPI_API_KEY',
      docsUrl: 'https://docs.vapi.ai/', apiBase: 'https://api.vapi.ai',
      authHint: 'Authorization: Bearer ${VAPI_API_KEY}',
      aliases: ['ai phone', 'voice assistant', 'call automation'],
      blurb: 'Voice-AI assistants and phone calls: build and run phone agents.',
      note: 'Calls dial real phones — test on your own number first.' },
    { id: 'deepl', name: 'DeepL', category: 'AI & Media', envVar: 'DEEPL_API_KEY',
      docsUrl: 'https://developers.deepl.com/docs', apiBase: 'https://api-free.deepl.com/v2',
      authHint: 'Authorization: DeepL-Auth-Key ${DEEPL_API_KEY}',
      aliases: ['translation', 'translate', 'localization'],
      blurb: 'High-quality machine translation — a translation-agency workflow.',
      note: 'Free-tier keys use api-free.deepl.com; paid keys use api.deepl.com.' },
    { id: 'transistor', name: 'Transistor', category: 'AI & Media', envVar: 'TRANSISTOR_API_KEY',
      docsUrl: 'https://developers.transistor.fm/', apiBase: 'https://api.transistor.fm/v1',
      authHint: 'x-api-key: ${TRANSISTOR_API_KEY}',
      aliases: ['podcast', 'podcast hosting', 'episodes'],
      blurb: 'Podcast hosting: shows, episodes, analytics — publish a podcast feed by API.' }

    // NOTE — model providers (OpenRouter, Anthropic, OpenAI…) are deliberately ABSENT. Their env names are
    // reserved: servicekeys.upsert refuses them so a pasted key can never silently become billing
    // credentials. Listing one here would put a row in the picker that always fails on save.
  ];

  function categories() {
    const seen = [];
    for (const p of PLATFORMS) if (seen.indexOf(p.category) < 0) seen.push(p.category);
    return seen.slice().sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      if (ia < 0 && ib < 0) return a.localeCompare(b);
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
  }

  // grouped view for the picker; `installed` marks platforms the Commander already has a key for.
  function grouped(existingEnvVars) {
    const have = new Set(Array.isArray(existingEnvVars) ? existingEnvVars : []);
    return categories().map(c => ({
      category: c,
      platforms: PLATFORMS.filter(p => p.category === c)
        .slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(p => Object.assign({}, p, { installed: have.has(p.envVar) }))
    }));
  }

  function byId(id) { return PLATFORMS.find(p => p.id === String(id || '')) || null; }

  return { PLATFORMS, CATEGORY_ORDER, categories, grouped, byId };
});
