# Connector / plugin / platform UX — the plan to make StarNet's the easiest in open source

**Status:** plan, nothing built. **Grounded:** every finding below was walked LIVE on a seeded
station (`dev/seed.js`, port 8931, trunk `87b61564`) on 2026-07-28 — not read off docs.
Supersedes nothing; `docs/CONNECTORS_MCP_PLAN.md` is the original bridge design and still holds.

## The one idea

Today StarNet makes the user answer a question they cannot answer: **"which of six mechanisms
does the thing I want use?"** MCP connector, platform API key, messaging channel, AI provider,
hook, plugin — each lives behind a different door, and picking the wrong door is a dead end.

Invert it. **The user names the thing; the station picks the mechanism.** One search box, one
result list, the setup card rendered inline wherever it lives. Mechanism becomes a badge, not a
navigation decision. Then two more rules that no open-source harness does well:

- **A connect must end in PROOF, not a green dot.** A working answer from the thing you just
  connected, in COMMS, on a button.
- **A failure must end in the NEXT ACTION, not an error string.** `fetch failed` is a shrug.

Competitive read (honest): Claude Desktop / Claude Code use a hand-edited JSON config; LibreChat
and Open WebUI use YAML; Goose ships a GUI list. StarNet already beats all of them with a live
GUI catalog carrying real connection status. The differentiator is **search-first + diagnosed
failure + proof of life** — none of them have any of the three.

---

## ROOT CAUSE — why the Google Drive user got gaslit (2026-07-28, live-verified)

A real user could not connect Google Drive and their agent made it worse. The cause is a chain of
four defects, each proven on the running app. **This is the highest-priority section in this
document and it reprioritizes everything below it.**

### R1 — The search box cannot see a single one of the 48 connectable platforms

`stationui.js:1031` filters on a **hardcoded class allowlist**:
`.set-row, label.set-row, .prov-card, .key-row, .set-about, .ms-h, .perk, .sk-card, .mc-hint, .mc-row, .ts-row`

Every catalog entry and every KEYS platform renders as **`.cc-card`** — which is not on that list.
Live, with the CATALOG pane rendered and the string "Google Workspace" visibly on screen:

| typed | rail hits |
|---|---|
| `google` | **none** |
| `gmail` | **none** |
| `google drive` | **none** |
| `drive` | TOOLSETS only — matched *"drive a real browser"* in the WEB toolset description |
| `workspace` | TOOLSETS only — matched *"workspace"* in the FILE CABINET description |

DOM check: `document.querySelectorAll('.cc-card').length === 48`, `card.matches(allowlist) === false`,
`.key-row` count `=== 0` (so the earlier `shopify` hit came from prose in a `.set-about`, not from a
platform row). **The one search box a user would type a platform name into indexes zero platforms.**

### R2 — Google Drive is real, but it is not directly connectable

`google-workspace` is `authType:'oauth'` with `url:''` → `installable:false`, carrying `via:'zapier'`.
Google publishes no public MCP endpoint, so the honest path is: connect **Zapier** (one API key) →
enable Google inside Zapier. The card renders a VIA jump, but that jump drops the user on a different
card with no memory of what they were trying to do and no explanation of the second half.

### R3 — The agent has never heard of the catalog. This is the gaslighting.

`connectorCatalog` is referenced in exactly three places in `sidecar/index.js` — 122 (the require),
7167 and 7288 (HTTP handlers). **It never reaches the system prompt, and there is no agent-callable
tool that can read it** (`sidecar/tools/builtin/` has no connector tool on trunk). Connected service
keys *do* get a `<service_keys>` prompt block (`servicekeys.js:242`), but nothing tells the agent what
*could* be connected or how.

So the agent's entire model of "how does the Commander gain a capability" comes from
`sidecar/manual.js`, whose NAVIGATION section lists COMMS, ROUTINES, TASKS, DOCK/BUILD, REFIT,
Recruitment Bay, and APPROVALS — and **never mentions ABILITIES, CATALOG, KEYS, MCP CONNECTORS,
EXTENSIONS, or CHANNELS.** Its TROUBLESHOOTING section has six entries; none is "how do I connect a
platform." Asked a question it has no grounding for, the model invents a plausible StarNet menu path.

### R4 — And the manual actively teaches the WRONG model for connectors

`manual.js:49` lists `CONNECTOR PORTAL → an MCP server's live tools` **under** the heading
*"OBJECT = CAPABILITY — a prop placed in an agent's BAY room grants it a REAL power. No prop placed
means no power (the floor never lies)."*

That is false for connectors. `sidecar/capability/office.js:38` rides **every configured connector
portal onto the office unconditionally** — the comment says it outright: *"account-level (not a placed
floor prop), so it rides on both surfaces."* So the agent confidently sends the Commander into REFIT
to place a connector portal, which is (a) unnecessary and (b) a dead end, because a portal needs a
`connectorId` binding that only exists **after** the connector was already added in ABILITIES.

The user follows instructions that sound authoritative, nothing works, and the agent — grounded in a
manual that says this is how it works — insists. That is the gaslighting, and it is a StarNet bug,
not a model failure.

### The fix, in the order that buys the most

1. **Add `.cc-card` to the allowlist at `stationui.js:1031`.** One line. Makes all 48 platforms
   findable by name today. Verify by typing `google` and landing on the Google Workspace card.
2. **Correct `manual.js`** — add ABILITIES › CATALOG / KEYS / MCP CONNECTORS / EXTENSIONS and the
   CHANNELS window to NAVIGATION; add a "how do I connect <platform>" troubleshooting entry; and
   **delete the false claim that a connector needs a placed portal.**
3. **Give the agent the catalog** — a `connect.search` tool (and/or a compact prompt block) over the
   unified index from S1, so "how do I connect Google Drive" is answered from real rows. It must be
   able to return the honest negatives: *not directly — via Zapier*, and *no MCP server exists for
   this; paste a key in KEYS and I'll call the REST API*. Pair it with an explicit instruction:
   **never invent a StarNet menu path; if it is not in the catalog block, say so.**
4. **`aliases[]` on catalog rows.** Even with `.cc-card` indexed, `gmail` only matches because a blurb
   happens to say "Gmail"; `gdrive`, `google docs`, `g suite` match nothing. Alias the obvious names.
5. **Make the `via` hop a guided flow**, not a jump — "CONNECT VIA ZAPIER" that carries the original
   intent through and states the second step (enable Google inside Zapier) instead of abandoning the
   user on the Zapier card.

---

## What is actually there today (live-verified)

The connect surfaces, all real:

| Surface | Where | What it connects |
|---|---|---|
| CATALOG | ABILITIES › CATALOG | 37 curated MCP servers (9 no-setup · 11 apikey · 17 oauth) |
| KEYS | ABILITIES › KEYS | 11 platform API keys (Printify, Shopify, Stripe, Notion…) |
| MCP CONNECTORS | ABILITIES › MCP CONNECTORS | any MCP server by URL (HTTP or stdio) |
| EXTENSIONS | ABILITIES › EXTENSIONS | hooks + plugins |
| TOOLSETS | ABILITIES › TOOLSETS | built-in tool families + (oddly) the Spotify connect flow |
| CHANNELS | CHANNELS window | Telegram · Discord · Slack · Matrix · Signal |
| PROVIDERS | SETTINGS › PROVIDERS | 17 AI providers (keys + 3 OAuth sign-ins) |

**What is genuinely good and must not be broken:** the zero-setup tier really is one click —
clicking `+ ADD` on DeepWiki produced `✓ DeepWiki connected — 3 tool(s) available` and a live
`● connected · 3 tools` row with the real `tools/list` result, in under a second. The catalog
being pure data (`sidecar/mcp/catalog.js`) so a new connector is a ROW, not code, is the right
extension model and should be extended, not replaced. Cross-tab search inside ABILITIES already
works (typing `shopify` jumped the rail to KEYS and dimmed the non-matching tabs). EXTENSIONS'
plain-language event picker ("before the agent uses a tool (can block it)") is the best copy in
the whole product.

---

## The findings (each one proven live)

### F1 — Six doors, no front door
Searching `telegram` in the ABILITIES search box lights up TOOLSETS and MCP CONNECTORS and
**never mentions the CHANNELS window**, which is the only place Telegram can actually be
connected. The search is scoped per-window, so the most common intent in the product lands on a
dead end. Same for `anthropic` (lives in SETTINGS › PROVIDERS), `spotify` (lives inside
TOOLSETS, not CATALOG).

### F2 — A connected connector is invisible where the product claims completeness
TOOLSETS says *"Every capability your agents can use, grouped into toolsets."* After connecting
DeepWiki, TOOLSETS does not contain the string "DeepWiki". `sidecar/capability/toolsets.js`
skips the `connector` capId by design ("freebie / dynamic"). Two parallel worlds; the one that
claims to be the complete list isn't.

### F3 — The prop rule is inverted, and the diagnosis is a dead end
On the interactive (browser) surface `composeOffice` gives an agent **compute only** plus
whatever props are placed (`sidecar/capability/office.js:35`) — but **every configured connector
portal rides on unconditionally** (`office.js:38`, "account-level, not a placed floor prop").
On the seeded station (one `desk` prop, verified in `starnet.save`) that means:

> NOVA can query a third-party MCP server on the public internet, but cannot run `web_search`.

And TOOLSETS diagnoses it without treating it: every row renders
`<span class="ts-inert">no dish on station — place one to grant these tools</span>`
(`frontend/app/windows/connectors.js:374`) — an inert span with **no button**. The panel tells
you exactly what is wrong and gives you nothing to click.

### F4 — OAuth SIGN IN can hang forever (17 of 37 catalog rows)
`POST /api/connectors/oauth/start` (`sidecar/index.js:7285`) makes three sequential raw
`globalThis.fetch` calls — the `initialize` probe, `mcpOauth.discover`, `registerClient` — and
`sidecar/mcp/oauth.js` contains **zero** `AbortSignal` or timeout (the HTTP transport has a 30s
one; this path bypasses the transport). Live: `POST /api/connectors/oauth/start {id:'sentry'}`
had not resolved after >60s. Meanwhile the UI sits on `starting sign-in for Sentry…` with the
button `disabled` (`windows/connectors.js:760`); the CANCEL affordance is only installed at line
718, i.e. **after** the hung call returns. Nearly half the catalog's only setup path can wedge
with no message and no way out.

### F5 — Failure copy is a raw Node error
Adding `https://example.invalid/mcp` yields exactly `connector request failed: fetch failed`
(`sidecar/mcp/transport.http.js:103`). It does not distinguish DNS failure, refused connection,
401-needs-auth, an HTML page that isn't an MCP endpoint, or a legacy `/sse` server StarNet
deliberately cannot drive — which are the five things that actually go wrong.

### F6 — No payoff after a successful connect
`✓ DeepWiki connected — 3 tool(s) available` and then nothing. No example prompt, no test call,
no proof the thing works. The user is left to guess what `ask_question` wants.

### F7 — Setup instructions are hidden by default
The Telegram card renders `SETUP GUIDE` as a collapsed `<details>`; a first-time user sees only
`BOT TOKEN — FROM @BOTFATHER` and an input. The instructions exist and are good — they're just
folded away at exactly the moment they're needed.

### F8 — Reach is a hardcoded 48 rows
37 MCP catalog + 11 KEYS platforms. Anything else means knowing an MCP endpoint URL by heart.
There is no live search of the public MCP registry.

### F9 — (known, still open) connector consent blast radius
`'full'` on a connector consent card writes `'*'`, so one click on a Shopify card also blesses
`fs.write` and `shell.exec` for the session. Documented in
`memory/connector-approval-repeat-fix.md` as the recommended follow-up; connector cards are the
highest-frequency card an MCP agent raises, so this is the most-trafficked doorway to `'*'`.

---

## The plan, in slice order (impact per unit of work)

### S0 — Truth fixes (small, independent, unblock everything else)

1. **Bound the OAuth start.** `AbortSignal.timeout()` on each leg in `sidecar/mcp/oauth.js` +
   `index.js:7285` (8s probe / 8s discover / 10s DCR, ~25s total budget), and install the CANCEL
   affordance BEFORE the await in `ccSignIn`, not after. Done means: point a catalog oauth entry
   at a black-hole host and watch a named error land inside 30s with a live CANCEL throughout.
2. **Diagnose connector failure.** Replace the `fetch failed` passthrough with a probe ladder,
   each rung ending in an action:
   - `ENOTFOUND` → "that host doesn't exist — check the URL for a typo"
   - `ECONNREFUSED` / `ETIMEDOUT` → "nothing answered at that address"
   - `401`/`403` with `WWW-Authenticate` → "this server needs a sign-in — add it from CATALOG instead" (+ jump)
   - `content-type: text/html` → "that's a web page, not an MCP endpoint — the URL usually ends in `/mcp`"
   - `/mcp` 404 but the `/sse` sibling answers → "that's a legacy SSE server; StarNet can't drive those yet"
   - abort → "no answer in 30s — the server may be down"
3. **Kill the `ts-inert` dead end.** `windows/connectors.js:374` becomes a real
   `+ PLACE A DISH` button that places the prop (or opens BUILD focused on it) and re-renders the
   row live. This is the single highest ratio of user-unblocked to lines-changed in the document.

### S1 — ONE DOOR (the headline)

4. **`sidecar/connect/index.js` — a pure JOIN, no new data to author.** Merge the four existing
   pure-data sources (`mcp/catalog.js` 37 · `servicekeys-catalog.js` 11 · `channels/registry.js`
   5 descriptors · the providers catalog 17) into one row shape:
   `{ id, name, kind: 'mcp'|'key'|'channel'|'provider'|'extension', authType, category, blurb, aliases[], status }`
   served at `GET /api/connect/search?q=`. The only new field worth authoring is `aliases` —
   `gmail`/`google drive`/`x`/`twitter` → Composio, `chatgpt` → the Codex provider, `wordpress` →
   an unlisted key. Adding a row stays a data edit, per the existing extension model.
5. **Make the ABILITIES search box the front door.** It searches the union and renders the
   matching setup card **inline** — the Telegram card appears in ABILITIES rather than telling
   you to go to another window. The existing per-surface panes stay for power users.
6. **`/connect <thing>` in COMMS** hitting the same index, so the front door also exists where
   the user is already typing.

### S2 — Fix the inversion

7. **Auto-place on first connect.** When a CATALOG/KEYS connect implies a prop the station
   doesn't have (a KEYS platform is useless without `web_request`, i.e. a dish), place it and say
   so in a visible beat: *"placed a dish on your station so NOVA can reach Printify."* Keeps the
   moat (placing-grants-reach stays true and visible) while removing the invisible second step.
8. **Give connectors a TOOLSETS row.** One `CONNECTORS` family listing each connected server with
   its live tools and its own kill-switch, so "every capability your agents can use" is true.

### S3 — Payoff and proof

9. **A `▶ TEST` button per connector** that calls the cheapest read-only tool and shows the real
   result inline. Truthful telemetry applied to the connect flow itself: a green dot is a claim,
   a returned answer is proof.
10. **One example prompt per catalog row** (a data field), surfaced after a successful connect as
    a button that drops it into COMMS — "Ask DeepWiki what facebook/react's reconciler does."
11. **Unfold the setup guides.** `<details open>` on an unconfigured channel card; collapse it
    only once that platform is connected.

### S4 — Reach

12. **Live MCP registry search** behind "Need something not listed?" — query the public registry,
    badge results `UNVETTED`, and **filter to Streamable-HTTP endpoints only** so StarNet never
    lists something it cannot drive (the same law that keeps legacy `/sse` servers out of the
    curated catalog).
13. **Grow `aliases` and the KEYS directory** — the KEYS directory is the honest answer for every
    platform with no MCP server, and 11 rows is thin.

### S5 — Safety

14. **Scope connector `'full'`.** A `full` grant on a connector consent card writes a
    connectors-scoped token, not `'*'` (F9). Narrow with `isConnectorTool(tool)` (capability
    `mcp:<id>`), the same way the unattended lane already does.

---

## Definition of done (observable, per the task doctrine)

- A first-time user who wants Notion types `notion` into one box and reaches a working setup card
  without knowing the word "MCP", without opening a second window, and without reading docs.
- Every failure path names a cause and offers an action; no raw Node error reaches a user.
- Every successful connect ends with a real result from the thing connected.
- `npm run test:fast` and `npm run test:http` green; the connector e2e
  (`test/e2e.mcp-connector.test.js`) extended to cover the diagnosed-failure ladder.
- Frontend edits under `frontend/app/` require a claims re-lock, COMMITTED before the gate.
