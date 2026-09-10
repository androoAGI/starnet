/* sidecar/mcp/catalog.js — the CURATED connector catalog: a vetted, categorized list of remote MCP
   servers a Commander can one-click add, layered on the generic connector manager (mcp/manager.js).

   This module is PURE DATA + selectors — no I/O, no Date / Math.random — the honest "what can I plug in"
   list. Adding a connector is a data ROW here, never new code, exactly like dropping a skills/library/*.md
   recipe. Installing an entry only pre-fills the EXISTING `POST /api/connectors` upsert (id / transport /
   url / label / token); the manager then really connects it and reports honest live state (green up /
   amber down / red error). So a catalog row is an OFFER — never a claim that it is connected. Truthful
   telemetry: the catalog never asserts a tool exists; the real tools/list arrives only after the manager
   handshakes the live server.

   authType — drives the UI tier AND which entries are installable TODAY:
     'none'   — no credentials; connects immediately (the zero-setup tier; our live-verified demo path).
     'apikey' — paste a bearer API key / token (works today via the manager's existing `token` field).
     'oauth'  — needs an interactive OAuth sign-in (the generic RFC 9728/8414/7591 + PKCE dynamic-client-
                registration flow in mcp/oauth.js). LIVE: the panel shows a SIGN IN button (gated on
                authType==='oauth'). `installable` stays FALSE for oauth BY DESIGN — an oauth connector is stood
                up by its own start/callback sign-in flow, not a one-click direct upsert, so installConfig()
                returns null for it. A url-less oauth entry (reached via an aggregator) carries `via` — the
                catalog id of the aggregator that reaches it — and the panel renders a live "VIA <name>" jump
                to that card (never a mute dead button).

   transport is always 'http' — the manager's http transport speaks MCP "Streamable HTTP" (POST JSON-RPC,
   response is JSON or an SSE stream). We deliberately seed only Streamable-HTTP `/mcp`-style endpoints and
   NEVER the legacy GET-`/sse` dual-endpoint servers that transport can't drive (listing one would be a lie
   the moment a user clicked it). Remote entries use HTTPS; an explicitly `local` entry may use cleartext
   only on loopback, matching transport.http.js's guard. Remote-first matches CONNECTORS_MCP_PLAN; stdio/npx entries are excluded
   until the child-process jail is a first-class connector transport.

   `official` = a first-party server run by the vendor it integrates (Stripe's own Stripe server), vs a
   community/third-party host. The panel badges it so a Commander can prefer first-party. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).catalog = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the auth tiers stood up by a direct one-click upsert (POST /api/connectors). OAuth is deliberately NOT here —
  // an oauth connector is stood up by its own sign-in flow (oauth/start -> callback), so it is never "installable"
  // and installConfig() returns null for it; the panel drives it via a SIGN IN button instead.
  const INSTALLABLE_AUTH = ['none', 'apikey'];

  // Stable category ORDER for the browse UI (entries within a category sort by name). A category not listed
  // here still renders — it just sorts last, alphabetically — so a new-category row never needs a code edit.
  const CATEGORY_ORDER = [
    'Docs & Knowledge', 'Search & Research', 'Compute & Data', 'Developer Tools',
    'Advanced / Developer', 'Automation', 'Social', 'Productivity', 'Design',
    'Payments & Finance', 'CRM & Sales', 'Marketing'
  ];

  /* staticOauth factory for Google rows — one authorization server (accounts.google.com), so the
     pre-registered client is stored ONCE and every Google product row shares it. Pure data. */
  function GOOGLE_OAUTH(scopes) {
    return {
      authorizationServer: 'https://accounts.google.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email'].concat(scopes),
      // Without these Google issues NO refresh token and the connector dies in ~1h.
      extraAuthParams: { access_type: 'offline', prompt: 'consent select_account' },
      clientSecretRequired: false,
      developerPreview: false,
      setupUrl: 'https://developers.google.com/identity/protocols/oauth2/native-app',
      setupName: 'StarNet publisher setup',
      setupNote: 'StarNet supplies the Google application registration. Users only sign in and approve access.'
    };
  }

  /* The seed. Every endpoint below is a Streamable-HTTP `/mcp`-style URL. The `none` tier is verified to
     connect with no credentials; `apikey` uses the manager's bearer `token` field; `oauth` is listed-but-
     gated until the OAuth flow ships. Grow this list by adding rows — that is the whole extension model. */
  const CATALOG = [
    // ── Docs & Knowledge — zero-setup, no auth ────────────────────────────────────────────────────────
    { id: 'deepwiki', name: 'DeepWiki', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://mcp.deepwiki.com/mcp', official: true, homepage: 'https://deepwiki.com',
      blurb: 'Ask natural-language questions about any public GitHub repository — indexed docs, structure, and code.' },
    { id: 'context7', name: 'Context7', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://mcp.context7.com/mcp', official: true, homepage: 'https://context7.com',
      blurb: 'Pulls up-to-date, version-specific docs and code examples for thousands of libraries and frameworks.' },
    { id: 'huggingface', name: 'Hugging Face', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://hf.co/mcp', official: true, homepage: 'https://huggingface.co',
      blurb: 'Search models, datasets, and Spaces on the Hugging Face Hub, and read model cards.' },
    { id: 'aws-knowledge', name: 'AWS Knowledge', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://knowledge-mcp.global.api.aws', official: true, homepage: 'https://aws.amazon.com',
      blurb: 'Authoritative AWS documentation, API references, and architectural guidance.' },
    { id: 'gitmcp', name: 'GitMCP', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://gitmcp.io/docs', official: false, homepage: 'https://gitmcp.io',
      blurb: 'Turns any GitHub project into a docs assistant the agent can query for accurate, current answers.' },

    // ── Search & Research (Exa is zero-setup; Tavily takes a key) ─────────────────────────────────────
    { id: 'exa', name: 'Exa Search', category: 'Search & Research', authType: 'none', transport: 'http',
      url: 'https://mcp.exa.ai/mcp', official: true, homepage: 'https://exa.ai',
      blurb: 'Neural web search built for AI — higher-signal results and full-page content extraction.' },
    { id: 'tavily', name: 'Tavily', category: 'Search & Research', authType: 'apikey', transport: 'http',
      url: 'https://mcp.tavily.com/mcp', official: true, homepage: 'https://tavily.com',
      blurb: 'AI-native web search + page extraction tuned for agents. Paste your Tavily API key.' },
    { id: 'parallel-search', name: 'Parallel Search', category: 'Search & Research', authType: 'none', transport: 'http',
      url: 'https://search.parallel.ai/mcp', official: true, homepage: 'https://docs.parallel.ai/integrations/mcp/search-mcp',
      aliases: ['parallel', 'parallel web search', 'parallel web fetch'],
      blurb: 'Search and fetch the web through Parallel\'s official MCP server. Anonymous access works without setup at lower rate limits.' },

    // ── Compute & Data — zero-setup ───────────────────────────────────────────────────────────────────
    { id: 'wolfram', name: 'Wolfram', category: 'Compute & Data', authType: 'none', transport: 'http',
      url: 'https://agenttools.wolfram.com/mcp', official: true, homepage: 'https://wolfram.com',
      blurb: 'Wolfram|Alpha computation — math, unit conversions, data, and step-by-step answers.' },

    // ── Automation — one API key, enormous reach ──────────────────────────────────────────────────────
    { id: 'zapier', name: 'Zapier', category: 'Automation', authType: 'apikey', transport: 'http',
      url: 'https://mcp.zapier.com/api/mcp/mcp', official: true, homepage: 'https://zapier.com',
      aliases: ['google', 'google drive', 'gdrive', 'gmail', 'google sheets', 'google calendar', 'gsuite', 'g suite', 'automation'],
      blurb: 'Bridge to 7,000+ apps — including Gmail, Google Calendar, Drive, Sheets, and Slack — through one key.' },
    { id: 'apify', name: 'Apify', category: 'Automation', authType: 'apikey', transport: 'http',
      url: 'https://mcp.apify.com', official: true, homepage: 'https://apify.com',
      blurb: 'Run web-scraping and automation Actors, and pull structured data from the web.' },
    { id: 'composio', name: 'Composio', category: 'Automation', authType: 'apikey', transport: 'http',
      url: 'https://connect.composio.dev/mcp', official: true, homepage: 'https://composio.dev', keyHeader: 'x-consumer-api-key',
      aliases: ['google', 'google drive', 'gdrive', 'gmail', 'outlook', 'microsoft outlook', 'microsoft 365', 'office 365', 'email', 'twitter', 'x', 'slack', 'notion', 'google calendar', 'gsuite', 'g suite'],
      presets: ['Gmail', 'Outlook'],
      blurb: 'One key bridges 500+ apps — including managed Gmail and Outlook email connections, plus X, Slack, Google Drive, Notion, GitHub, and more.' },

    // ── Social — direct first-party surfaces for reading, publishing, and campaign operations ─────────
    { id: 'x-twitter', name: 'X (Twitter)', category: 'Social', authType: 'apikey', transport: 'http',
      url: 'https://api.x.com/mcp', official: true, homepage: 'https://x.com',
      blurb: "X's official server — search and read posts, profiles, and timelines with your X API Bearer token. This read-only token connector does not grant posting (that needs X's write OAuth scope)." },
    { id: 'zernio', name: 'Zernio', category: 'Social', authType: 'oauth', transport: 'http',
      url: 'https://mcp.zernio.com/mcp', official: true, homepage: 'https://zernio.com',
      aliases: ['zernio', 'social media', 'social publishing', 'instagram', 'tiktok', 'linkedin', 'facebook', 'youtube', 'threads', 'reddit', 'pinterest', 'bluesky', 'whatsapp', 'social ads', 'social analytics', 'direct messages'],
      blurb: 'Publish and schedule across 16 social platforms, manage inboxes, ads, automations, and analytics through Zernio. Needs Zernio sign-in (OAuth).' },

    // ── Payments & Finance — one API key ──────────────────────────────────────────────────────────────
    { id: 'stripe', name: 'Stripe', category: 'Payments & Finance', authType: 'apikey', transport: 'http',
      url: 'https://mcp.stripe.com/', official: true, homepage: 'https://stripe.com',
      blurb: 'Query customers, payments, invoices, and subscriptions with a restricted Stripe API key.' },

    // ── CRM & Sales — one API key ─────────────────────────────────────────────────────────────────────
    { id: 'hubspot', name: 'HubSpot', category: 'CRM & Sales', authType: 'apikey', transport: 'http',
      url: 'https://app.hubspot.com/mcp/v1/http', official: true, homepage: 'https://hubspot.com',
      blurb: 'Read and update CRM contacts, companies, deals, and tickets with a private-app token.' },

    // ── OAuth tier — LISTED but not installable until the OAuth slice ships (honest, not a dead click) ──
    /* `via` (url-less oauth entries only): the catalog id of the AGGREGATOR that reaches this platform today.
       The panel renders it as a live "VIA <name>" jump to that card instead of a mute disabled button. */
    /* StarNet implements MCP tools locally over stable Google APIs. The publisher supplies
       an installed-app OAuth registration; customers never configure a Google Cloud project. */
    { id: 'gmail', name: 'Gmail', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me', googleApi: true, official: false, homepage: 'https://mail.google.com',
      aliases: ['google', 'gmail', 'google mail', 'email', 'gsuite', 'g suite', 'google workspace'],
      staticOauth: GOOGLE_OAUTH(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose']),
      blurb: 'Search and read Gmail, create drafts, and send approved drafts. Sign in with Google to connect your account.' },
    { id: 'google-drive', name: 'Google Drive', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://www.googleapis.com/drive/v3', googleApi: true, official: false, homepage: 'https://drive.google.com',
      aliases: ['google', 'google drive', 'gdrive', 'drive', 'gsuite', 'g suite', 'google workspace'],
      staticOauth: GOOGLE_OAUTH(['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file']),
      blurb: 'Search, read, export, and manage Drive files. Sign in with Google to connect your account.' },
    { id: 'google-calendar', name: 'Google Calendar', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://www.googleapis.com/calendar/v3', googleApi: true, official: false, homepage: 'https://calendar.google.com',
      aliases: ['google', 'google calendar', 'gcal', 'calendar', 'gsuite', 'g suite', 'google workspace'],
      staticOauth: GOOGLE_OAUTH(['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy']),
      blurb: 'Read calendars, events, and availability. Sign in with Google to connect your account.' },
    { id: 'google-docs', name: 'Google Docs', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://docs.googleapis.com/v1/documents', googleApi: true, official: false, homepage: 'https://docs.google.com',
      aliases: ['google', 'google docs', 'docs', 'gsuite', 'g suite', 'google workspace'],
      staticOauth: GOOGLE_OAUTH(['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly']),
      blurb: 'Read, create, and edit Google Docs. Sign in with Google to connect your account.' },
    { id: 'google-sheets', name: 'Google Sheets', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://sheets.googleapis.com/v4/spreadsheets', googleApi: true, official: false, homepage: 'https://sheets.google.com',
      aliases: ['google', 'google sheets', 'sheets', 'spreadsheet', 'gsuite', 'g suite', 'google workspace'],
      staticOauth: GOOGLE_OAUTH(['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly']),
      blurb: 'Read, create, and edit Google Sheets. Sign in with Google to connect your account.' },
    { id: 'notion', name: 'Notion', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.notion.com/mcp', official: true, homepage: 'https://notion.so',
      blurb: 'Search, read, and create Notion pages and databases. Needs Notion sign-in (OAuth).' },
    { id: 'linear', name: 'Linear', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.linear.app/mcp', official: true, homepage: 'https://linear.app',
      blurb: 'Create, search, and update Linear issues and projects. Needs Linear sign-in (OAuth).' },
    { id: 'atlassian', name: 'Jira & Confluence', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: '', official: true, homepage: 'https://atlassian.com', via: 'zapier',
      aliases: ['atlassian', 'jira', 'confluence'],
      blurb: 'Atlassian Jira issues and Confluence pages. A newer direct OAuth endpoint is under verification; use the proven Zapier route until StarNet completes an authenticated tool call.' },
    // Registered public device client: GitHub has no dynamic client registration.
    { id: 'github', name: 'GitHub', category: 'Developer Tools', authType: 'oauth', deviceFlow: true, transport: 'http',
      url: 'https://api.githubcopilot.com/mcp', official: true, homepage: 'https://github.com',
      blurb: 'Connect repositories, issues, pull requests, and Actions. Sign in with GitHub using a short code — no API key needed.' },
    { id: 'sentry', name: 'Sentry', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.sentry.dev/mcp', official: true, homepage: 'https://sentry.io',
      blurb: 'Inspect errors, issues, and releases from your Sentry projects. Needs Sentry sign-in (OAuth).' },
    { id: 'supabase', name: 'Supabase', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.supabase.com/mcp', official: true, homepage: 'https://supabase.com',
      blurb: 'Query your Postgres database and manage Supabase projects. Needs Supabase sign-in (OAuth).' },

    // Advanced / Developer — local specialist surfaces. HTTP is allowed only on an explicit loopback host.
    { id: 'unreal-engine', name: 'Unreal Engine', category: 'Advanced / Developer', authType: 'none', transport: 'http',
      url: 'http://127.0.0.1:8000/mcp', official: true, local: true,
      homepage: 'https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor',
      aliases: ['unreal', 'ue', 'ue5', 'game engine', 'unreal editor'],
      blurb: 'Control the open Unreal Editor through Epic\'s experimental local MCP plugin. Enable Unreal MCP and start its loopback server first.' },

    /* ── WAVE 2 (all live-verified 2026-07-06): open docs, bearer-key SaaS, and OAuth+DCR connectors whose
       dynamic registration was confirmed to actually mint a client. Skipped (would lie): figma (advertises DCR
       but 403s it), atlassian (direct authenticated operation not yet proven), plaid (no standard discovery). ── */
    // Docs & Knowledge — zero-setup (connect keyless, tools discovered)
    { id: 'cloudflare-docs', name: 'Cloudflare Docs', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://docs.mcp.cloudflare.com/mcp', official: true, homepage: 'https://developers.cloudflare.com',
      blurb: "Search Cloudflare's product documentation and developer guides." },
    { id: 'microsoft-learn', name: 'Microsoft Learn', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://learn.microsoft.com/api/mcp', official: true, homepage: 'https://learn.microsoft.com',
      blurb: 'Search Microsoft Learn docs for Azure, .NET, Microsoft 365, and more.' },
    // Developer Tools
    { id: 'gitlab', name: 'GitLab', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://gitlab.com/api/v4/mcp', official: true, homepage: 'https://gitlab.com',
      blurb: 'Issues, merge requests, and pipelines across your GitLab projects. Needs GitLab sign-in (OAuth).' },
    { id: 'vercel', name: 'Vercel', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.vercel.com/', official: true, homepage: 'https://vercel.com',
      blurb: 'Manage Vercel projects, deployments, and logs. Needs Vercel sign-in (OAuth).' },
    { id: 'netlify', name: 'Netlify', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://netlify-mcp.netlify.app/mcp', official: true, homepage: 'https://netlify.com',
      blurb: 'Deploy and manage Netlify sites. Needs Netlify sign-in (OAuth).' },
    { id: 'neon', name: 'Neon', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.neon.tech/mcp', official: true, homepage: 'https://neon.tech',
      blurb: 'Query and manage your Neon serverless Postgres. Needs Neon sign-in (OAuth).' },
    { id: 'prisma', name: 'Prisma', category: 'Developer Tools', authType: 'apikey', transport: 'http',
      url: 'https://mcp.prisma.io/mcp', official: true, homepage: 'https://prisma.io',
      blurb: 'Manage Prisma Postgres databases. Paste your Prisma API key.' },
    // Productivity
    { id: 'airtable', name: 'Airtable', category: 'Productivity', authType: 'apikey', transport: 'http',
      url: 'https://mcp.airtable.com/mcp', official: true, homepage: 'https://airtable.com',
      blurb: 'Read and write Airtable bases and records. Paste an Airtable personal access token.' },
    { id: 'asana', name: 'Asana', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.asana.com/mcp', official: true, homepage: 'https://asana.com',
      blurb: 'Create and track Asana tasks and projects. Needs Asana sign-in (OAuth).' },
    { id: 'monday', name: 'monday.com', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.monday.com/mcp', official: true, homepage: 'https://monday.com',
      blurb: 'Create and update monday.com boards and items. Needs monday.com sign-in (OAuth).' },
    // Design
    { id: 'canva', name: 'Canva', category: 'Design', authType: 'oauth', transport: 'http',
      url: 'https://mcp.canva.com/mcp', official: true, homepage: 'https://canva.com',
      blurb: 'Generate and manage Canva designs. Needs Canva sign-in (OAuth).' },
    { id: 'webflow', name: 'Webflow', category: 'Design', authType: 'oauth', transport: 'http',
      url: 'https://mcp.webflow.com/mcp', official: true, homepage: 'https://webflow.com',
      blurb: 'Manage Webflow sites, CMS collections, and content. Needs Webflow sign-in (OAuth).' },
    { id: 'wix', name: 'Wix', category: 'Design', authType: 'oauth', transport: 'http',
      url: 'https://mcp.wix.com/mcp', official: true, homepage: 'https://wix.com',
      blurb: 'Manage Wix sites, stores, and bookings. Needs Wix sign-in (OAuth).' },
    /* higgsfield (added 2026-08-25, user support report): hosted image/video generation MCP.
       OAuth+DCR live-probed 2026-08-25: RFC 7591 registration MINTS a public PKCE client (201)
       against our loopback redirect; PRM at /.well-known/oauth-protected-resource/mcp. Its PRM
       lists a second authorization server (fnf-device-auth.higgsfield.ai, device-code only,
       404s AS-metadata discovery) — discover() correctly uses authorization_servers[0]. */
    { id: 'higgsfield', name: 'Higgsfield', category: 'Design', authType: 'oauth', transport: 'http',
      url: 'https://mcp.higgsfield.ai/mcp', official: true, homepage: 'https://higgsfield.ai',
      aliases: ['higgsfield ai', 'image generation', 'video generation', 'sora', 'veo', 'kling', 'soul'],
      blurb: 'Generate images and video with Higgsfield\'s hosted models (Soul, Veo, Kling, Sora, and more). Needs Higgsfield sign-in (OAuth).' },
    // Payments & Finance
    { id: 'paypal', name: 'PayPal', category: 'Payments & Finance', authType: 'oauth', transport: 'http',
      url: 'https://mcp.paypal.com/mcp', official: true, homepage: 'https://paypal.com',
      blurb: 'Create invoices and query PayPal orders and payments. Needs PayPal sign-in (OAuth).' },
    { id: 'square', name: 'Square', category: 'Payments & Finance', authType: 'oauth', transport: 'http',
      url: 'https://mcp.squareup.com/mcp', official: true, homepage: 'https://squareup.com',
      blurb: 'Payments, catalog, and orders on Square. Needs Square sign-in (OAuth).' },
    // CRM & Sales
    { id: 'intercom', name: 'Intercom', category: 'CRM & Sales', authType: 'apikey', transport: 'http',
      url: 'https://mcp.intercom.com/mcp', official: true, homepage: 'https://intercom.com',
      blurb: 'Search Intercom conversations, contacts, and articles. Paste an Intercom access token.' },

    /* ── WAVE 4 (all live-probed 2026-08-28 with the sidecar's own handshake — initialize → RFC 9728/8414
       discovery → RFC 7591 registration MINTING a real PKCE client against the loopback redirect; the open
       row connected keyless). Re-probed and still absent, with reasons: Figma + Dropbox refuse the client
       mint (403 / registration_not_supported), Slack + Box are live OAuth with NO dynamic registration
       (Google-class — need a pre-registered vendor app + staticOauth in a later slice, same as Microsoft
       365), Atlassian-direct + Heroku serve no discovery metadata, and zoom/salesforce/zendesk/twilio/
       calendly/mailchimp/shopify/trello/perplexity/elevenlabs remain dead or 404. ── */
    // Docs & Knowledge — zero-setup
    { id: 'openai-devdocs', name: 'OpenAI DevDocs', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://developers.openai.com/mcp', official: true, homepage: 'https://developers.openai.com',
      aliases: ['openai', 'openai docs', 'openai api docs', 'gpt docs'],
      blurb: "Search OpenAI's developer documentation — API references, guides, and model docs." },
    // Productivity — OAuth+DCR (mint-proven)
    { id: 'todoist', name: 'Todoist', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://ai.todoist.net/mcp', official: true, homepage: 'https://todoist.com',
      aliases: ['todoist', 'todo', 'task list', 'tasks'],
      blurb: 'Create, search, and complete Todoist tasks and projects. Needs Todoist sign-in (OAuth).' },
    { id: 'clickup', name: 'ClickUp', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.clickup.com/mcp', official: true, homepage: 'https://clickup.com',
      aliases: ['clickup', 'click up', 'tasks', 'project management'],
      blurb: 'Tasks, docs, and spaces in ClickUp. Needs ClickUp sign-in (OAuth).' },
    // Developer Tools — OAuth+DCR (mint-proven)
    { id: 'railway', name: 'Railway', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.railway.com/mcp', official: true, homepage: 'https://railway.com',
      aliases: ['railway', 'deploy', 'hosting'],
      blurb: 'Manage Railway projects, services, and deployments. Needs Railway sign-in (OAuth).' },
    { id: 'grafana', name: 'Grafana', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.grafana.com/mcp', official: true, homepage: 'https://grafana.com',
      aliases: ['grafana', 'dashboards', 'observability', 'metrics'],
      blurb: 'Query dashboards, metrics, and incidents in Grafana Cloud. Needs Grafana sign-in (OAuth).' },
    { id: 'posthog', name: 'PostHog', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.posthog.com/mcp', official: true, homepage: 'https://posthog.com',
      aliases: ['posthog', 'product analytics', 'feature flags', 'analytics'],
      blurb: 'Product analytics, insights, and feature flags from PostHog. Needs PostHog sign-in (OAuth).' },
    { id: 'cloudflare-bindings', name: 'Cloudflare', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://bindings.mcp.cloudflare.com/mcp', official: true, homepage: 'https://cloudflare.com',
      aliases: ['cloudflare', 'workers', 'kv', 'r2', 'd1'],
      blurb: 'Manage Cloudflare Workers, KV, R2, and D1 resources on your account. Needs Cloudflare sign-in (OAuth).' },

    /* ── WAVE 4b (same 2026-08-28 probe run, batch 2 — every row below MINTED a real DCR client against the
       loopback redirect). Probed and absent, with reasons: Chargebee / Front / Render are live OAuth with NO
       dynamic registration (the staticOauth-class backlog alongside Slack/Box/M365); Kagi, Klaviyo, and
       Hunter 401 but serve no protected-resource metadata; CircleCI / LaunchDarkly / Pipedream 404; Auth0,
       DigitalOcean, Fastly, Fly.io, Neo4j, Scaleway, Temporal have no reachable hosted endpoint; Semrush 301s. ── */
    // Productivity
    { id: 'cal-com', name: 'Cal.com', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.cal.com/mcp', official: true, homepage: 'https://cal.com',
      aliases: ['cal', 'cal.com', 'calendar', 'scheduling', 'bookings'],
      blurb: 'Read and manage your Cal.com bookings and schedules. Needs Cal.com sign-in (OAuth).' },
    { id: 'fireflies', name: 'Fireflies', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://api.fireflies.ai/mcp', official: true, homepage: 'https://fireflies.ai',
      aliases: ['fireflies', 'meeting notes', 'transcripts', 'meetings'],
      blurb: 'Search your Fireflies meeting transcripts, summaries, and action items. Needs Fireflies sign-in (OAuth).' },
    // Developer Tools
    { id: 'algolia', name: 'Algolia', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.algolia.com/mcp', official: true, homepage: 'https://algolia.com',
      aliases: ['algolia', 'search index', 'search api'],
      blurb: 'Manage Algolia indices, records, and search configuration. Needs Algolia sign-in (OAuth).' },
    { id: 'buildkite', name: 'Buildkite', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.buildkite.com/mcp', official: true, homepage: 'https://buildkite.com',
      aliases: ['buildkite', 'ci', 'pipelines', 'builds'],
      blurb: 'Inspect Buildkite pipelines, builds, and test results. Needs Buildkite sign-in (OAuth).' },
    { id: 'datadog', name: 'Datadog', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp', official: true, homepage: 'https://datadoghq.com',
      aliases: ['datadog', 'monitoring', 'observability', 'apm', 'logs'],
      blurb: 'Query Datadog monitors, dashboards, logs, and incidents (Datadog Preview endpoint). Needs Datadog sign-in (OAuth).' },
    { id: 'globalping', name: 'Globalping', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.globalping.dev/mcp', official: true, homepage: 'https://globalping.io',
      aliases: ['globalping', 'ping', 'traceroute', 'network test', 'latency'],
      blurb: 'Run ping, traceroute, DNS, and HTTP tests from probes around the world. Needs Globalping sign-in (OAuth).' },
    { id: 'honeybadger', name: 'Honeybadger', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.honeybadger.io/mcp', official: true, homepage: 'https://honeybadger.io',
      aliases: ['honeybadger', 'error tracking', 'uptime', 'exceptions'],
      blurb: 'Inspect Honeybadger errors, uptime checks, and projects. Needs Honeybadger sign-in (OAuth).' },
    { id: 'jam', name: 'Jam', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.jam.dev/mcp', official: true, homepage: 'https://jam.dev',
      aliases: ['jam', 'bug reports', 'screen recording', 'repro'],
      blurb: 'Read Jam bug reports — console logs, network requests, and repro steps. Needs Jam sign-in (OAuth).' },
    { id: 'sanity', name: 'Sanity', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.sanity.io/mcp', official: true, homepage: 'https://sanity.io',
      aliases: ['sanity', 'cms', 'headless cms', 'content'],
      blurb: 'Query and edit content in your Sanity datasets. Needs Sanity sign-in (OAuth).' },
    { id: 'semgrep', name: 'Semgrep', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.semgrep.ai/mcp', official: true, homepage: 'https://semgrep.dev',
      aliases: ['semgrep', 'security scan', 'static analysis', 'sast'],
      blurb: 'Scan code for security issues with Semgrep rules and review findings. Needs Semgrep sign-in (OAuth).' },
    // CRM & Sales
    { id: 'close-crm', name: 'Close', category: 'CRM & Sales', authType: 'oauth', transport: 'http',
      url: 'https://mcp.close.com/mcp', official: true, homepage: 'https://close.com',
      aliases: ['close', 'close crm', 'crm', 'leads', 'sales'],
      blurb: 'Search and update Close CRM leads, contacts, and opportunities. Needs Close sign-in (OAuth).' },
    // Payments & Finance
    { id: 'ramp', name: 'Ramp', category: 'Payments & Finance', authType: 'oauth', transport: 'http',
      url: 'https://mcp.ramp.com/mcp', official: true, homepage: 'https://ramp.com',
      aliases: ['ramp', 'corporate cards', 'expenses', 'spend'],
      blurb: 'Query Ramp transactions, cards, and spend programs. Needs Ramp sign-in (OAuth).' }
  ];

  // ── selectors (pure) ────────────────────────────────────────────────────────────────────────────────

  function isInstallable(entry) { return !!entry && INSTALLABLE_AUTH.indexOf(entry.authType) >= 0; }

  // a defensive clone so callers (and the JSON route) can never mutate the frozen seed.
  function cloneEntry(e) {
    return {
      id: e.id, name: e.name, category: e.category, authType: e.authType, transport: e.transport,
      url: e.url || '', googleApi: !!e.googleApi, deviceFlow: !!e.deviceFlow, official: !!e.official, homepage: e.homepage || '', blurb: e.blurb || '',
      via: e.via || '', keyHeader: e.keyHeader || '', local: !!e.local, installable: isInstallable(e),
      // staticOauth: fixed OAuth endpoints for an AS with no dynamic registration (Google). Deep-cloned.
      staticOauth: e.staticOauth ? {
        authorizationServer: e.staticOauth.authorizationServer,
        authorizationEndpoint: e.staticOauth.authorizationEndpoint,
        tokenEndpoint: e.staticOauth.tokenEndpoint,
        scopes: (e.staticOauth.scopes || []).slice(),
        extraAuthParams: Object.assign({}, e.staticOauth.extraAuthParams || {}),
        clientSecretRequired: !!e.staticOauth.clientSecretRequired,
        developerPreview: !!e.staticOauth.developerPreview,
        setupUrl: e.staticOauth.setupUrl || '', setupName: e.staticOauth.setupName || '',
        setupNote: e.staticOauth.setupNote || ''
      } : null,
      // ALIASES — the names a Commander actually TYPES, which are frequently not the row's name and not in
      // its blurb. "google drive" found nothing while a Google Workspace card sat on screen (2026-07-28);
      // relying on a term happening to appear in marketing copy is not a search. Ride into the card's
      // data-search attribute and into the agent's connect block, so the UI and the agent match the same words.
      aliases: Array.isArray(e.aliases) ? e.aliases.slice() : [],
      presets: Array.isArray(e.presets) ? e.presets.slice() : []
    };
  }

  function list() { return CATALOG.map(cloneEntry); }
  function get(id) { const e = CATALOG.find(c => c.id === String(id)); return e ? cloneEntry(e) : null; }
  function ids() { return CATALOG.map(c => c.id); }

  // stable category order: known categories in CATEGORY_ORDER first, then any extras alphabetically.
  function categories() {
    const seen = [];
    for (const c of CATALOG) if (seen.indexOf(c.category) < 0) seen.push(c.category);
    return seen.slice().sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
  }

  function normUrl(u) { return String(u == null ? '' : u).trim().toLowerCase().replace(/\/+$/, ''); }

  // the browse payload: entries annotated with `installed` from the live connector configs, grouped by category.
  // `installed` accepts an iterable of ids (back-compat) OR of {id,url}. An entry is installed only when a config
  // shares its id AND (the entry has no canonical url, OR a config with that id also matches the entry's url) — so a
  // manually-added connector that merely REUSES a catalog id but points at a foreign URL never flips the vetted
  // vendor card to ADDED (truthful telemetry).
  function browse(installed) {
    const byId = new Map();   // id -> Set<normUrl> of configured urls, or null = "id present, match on id alone"
    const add = (x) => {
      if (x == null) return;
      if (typeof x === 'string') { if (!byId.has(x)) byId.set(x, null); return; }
      const id = x.id; if (!id) return;
      const u = normUrl(x.url);
      if (!byId.has(id)) byId.set(id, u ? new Set([u]) : null);
      else { const cur = byId.get(id); if (cur && u) cur.add(u); }   // a later id-only config leaves it id-only
    };
    if (installed && typeof installed.forEach === 'function') installed.forEach(add);
    const isInstalled = (e) => {
      if (!byId.has(e.id)) return false;
      const urls = byId.get(e.id);
      if (!urls) return true;      // id-only info (back-compat / stdio) — best we can do
      if (!e.url) return true;     // catalog entry has no canonical url to disambiguate
      return urls.has(normUrl(e.url));
    };
    const entries = CATALOG.map(e => { const c = cloneEntry(e); c.installed = isInstalled(c); return c; });
    const order = categories();
    entries.sort((a, b) => (order.indexOf(a.category) - order.indexOf(b.category)) || a.name.localeCompare(b.name));
    const groups = order.map(cat => ({ category: cat, connectors: entries.filter(e => e.category === cat) }));
    return { categories: order, groups: groups, connectors: entries };
  }

  // the fields a catalog install hands to POST /api/connectors (never a token — the user supplies that).
  // Returns null for an entry that isn't installable today (oauth) so a caller can't accidentally push one.
  function installConfig(id) {
    const e = get(id);
    if (!e || !e.installable) return null;
    return { id: e.id, transport: e.transport, url: e.url, label: e.name, keyHeader: e.keyHeader || '', enabled: true };
  }

  return {
    list, get, ids, categories, browse, installConfig, isInstallable,
    INSTALLABLE_AUTH: INSTALLABLE_AUTH.slice(),
    _internals: { CATALOG, CATEGORY_ORDER, cloneEntry }
  };
});
