# StarNet Privacy

_Last reviewed: 2026-07-25, against the shipping code._

StarNet is a **local-first desktop app**. It runs a small server (the "sidecar") on your own
machine (`localhost`) and does the agent work there. Out of the box there is **no StarNet
account and nothing of yours on a StarNet server** — the app talks only to the providers you
choose, with your own keys. There is exactly one opt-in exception: if you choose to buy
**StarNet Credits**, that creates an account on our billing service. It is described in full
under *StarNet Credits* below, and nothing in this document changes for you unless you buy
them. This document is written in plain English and is grounded in an audit of the actual
code — not aspirations.

Support questions: androo.agi@gmail.com.

## The short version

- **The app does not track you.** There is no telemetry, no analytics, no crash reporting, or ad
  SDK. We verified this by searching the whole codebase for the
  usual suspects (Sentry, PostHog, Mixpanel, Segment, Google Analytics, Amplitude, Datadog):
  none are present. The desktop app does make the automatic update-manifest request described
  below; that request carries no user data or app identifier. This stays true whether or not you
  buy credits — buying credits adds a billing account, not tracking.
- **Your data stays on your machine**, under your OS user's app-data directory —
  Windows: `%APPDATA%\ai.skynet.harness\workspaces\`; macOS:
  `~/Library/Application Support/ai.skynet.harness/workspaces/`; Linux:
  `~/.local/share/ai.skynet.harness/workspaces/`. (The developer-mode sidecar uses
  `%LOCALAPPDATA%\StarNet\` on Windows.) The `ai.skynet.harness` folder name is an intentional
  back-compatibility alias kept from before the app was renamed to StarNet on 2026-06-22 — it
  holds your StarNet data.
- The app talks to the network for the configured or requested work described below, plus the
  desktop app's automatic update-manifest check. These are the only outbound cases.

## What leaves your machine — and only these

StarNet makes outbound network requests in exactly these situations. Nothing else.

### 1. Your chosen AI model provider (using your key)

When an agent runs, StarNet calls the model provider **you** configured, authenticated with
**your** API key (or your ChatGPT sign-in). Your prompts, conversation, and any content the
agent works with are sent to that provider so it can generate a response — the same as any app
that uses that provider. StarNet is a pass-through here; it does not sit in the middle.

Depending on what you set up, that provider is one of:

- OpenRouter (`openrouter.ai`)
- OpenAI (`api.openai.com`)
- Anthropic (`api.anthropic.com`)
- Google Gemini (`generativelanguage.googleapis.com`)
- ChatGPT via sign-in (`chatgpt.com` / `auth.openai.com`)
- or another OpenAI-compatible provider you point it at (xAI, Groq, Mistral, DeepSeek,
  Together, Fireworks, Perplexity, Cerebras).

**Your key, your data, your account.** StarNet never sees a StarNet-owned copy — the key is
yours and the request goes straight to the provider you picked.

### 2. Chat channels — only if you connect them

If you connect a chat channel, StarNet talks to that platform to send and receive messages on the
channel you set up, authenticated with the token (or endpoint) **you** provide. Nothing is
contacted unless you connect it:

- **Discord / Telegram** — StarNet calls that platform's API (`discord.com`, `api.telegram.org`)
  with your bot token.
- **Slack** — StarNet calls the Slack API (`slack.com`) with your bot token.
- **Matrix** — StarNet talks to **the homeserver you point it at** — whatever URL you configure,
  whether `matrix.org` or a server you run yourself — using your access token. StarNet does not
  pick a server; you do.
- **Signal** — StarNet talks to **the signal-cli REST endpoint you run** (the URL you configure for
  your own signal-cli bridge), using the account you registered there.

If you never connect a channel, StarNet never contacts any of these services.

### 3. Spotify — only if you enable it

If you enable the Spotify integration and authorize it, StarNet calls the Spotify API
(`api.spotify.com`, `accounts.spotify.com`) to read what's playing and control playback, using
the token you granted. If you don't enable Spotify, no Spotify requests are made.

### 4. Web search / web fetch — only when an agent uses that tool

If an agent uses its web tools, StarNet fetches results through independent, keyless services
— web search via Mojeek (`mojeek.com`, with DuckDuckGo as a fallback) and page reading via
Jina Reader (`r.jina.ai`) — or, if you have an OpenRouter key, OpenRouter's web plugin. If the
Jina reader is unavailable or rate-limits, the page is fetched **directly from its own host**
as a fallback, so the site you asked to read may see the request come from your machine. Only
your search query or the URL you asked to read is sent, and only when an agent actually runs a
web search or fetch. (The fetch tool also refuses to reach private/internal network addresses,
as an anti-abuse guard.)

### 5. Voice / text-to-speech — only if voices are on

Agent voices are synthesized through your model provider (OpenRouter) by default. If you
configure an **ElevenLabs** voice with your own ElevenLabs key, the line to be spoken is sent
to `api.elevenlabs.io` instead. No voices, no TTS requests.

### 6. A version check for updates (no personal data)

Automatic update checks are on by default. On first run and at the configured interval, the
desktop app fetches a single public manifest file from GitHub Releases:

```
https://github.com/androoAGI/starnet-releases/releases/latest/download/latest.json
```

This is a plain `GET` for a static file. **No user data, no identifier, and no telemetry are
sent** — it's the same request your browser would make to view that file. Each update's
integrity is cryptographically verified against a key baked into the app before anything is
installed. You can stop automatic checks by turning off **AUTO-CHECK FOR UPDATES** in
**SYSTEM > SETTINGS > UPDATES**; the Update Center still lets you check manually.

## What StarNet stores on your machine (and how)

Everything below lives under your per-user app-data directory (see the paths in "The short
version" above for Windows/macOS/Linux). It never leaves your machine except as described
above. Where this document says "OS keychain," that means Windows Credential Manager, the
macOS Keychain, or the Linux Secret Service (e.g. GNOME Keyring), depending on your platform —
always under the service name `ai.skynet.harness`.

| What | Where | How it's stored |
| --- | --- | --- |
| Conversation transcripts | `transcript.jsonl` | **Plaintext** JSON on disk |
| Run history + cost ledger | `runs.jsonl`, `ledger.jsonl` | **Plaintext** JSON on disk |
| Agent memory / beliefs / to-dos | `<agent>.notebook.json`, `<agent>.todo.json`, dossier/goals | **Plaintext** JSON on disk |
| Voice cache (spoken-line audio) | `voice-cache/` | **Plaintext** audio files on disk |
| Discord / Telegram bot tokens | OS keychain (desktop) | **OS keychain** (Windows Credential Manager); plaintext fallback in bare/dev mode — see below |
| Your model-provider API keys | OS keychain (desktop) | **OS keychain** (Windows Credential Manager); loaded into app memory at launch, never written to disk by the app |
| Spotify OAuth token | `.secrets/spotify.json` | **Plaintext** JSON on disk |
| ChatGPT / Codex sign-in token | `codex/tokens.json` | **Plaintext** JSON on disk |
| Grok sign-in token | `grok/tokens.json` | **Plaintext** JSON on disk |
| Kimi sign-in token | `kimi/tokens.json` | **Plaintext** JSON on disk |
| Google and other connector credentials, account identity and configuration | `connectors/state.json` and its recovery copy | **AES-256-GCM encrypted on desktop**, with an encryption key in the OS keychain; bare sidecar development without a supplied key remains plaintext |
| Channel message history (Discord/Telegram chats the bot saw) | `channels/*.history.json` | **Plaintext** JSON on disk |
| Agent memory ledgers (accepted/declined memory proposals, dossiers, goals) | per-agent `*.json` | **Plaintext** JSON on disk |
| Station state (widgets, sub-agents, routing, quests, XP) | various `*.json` | **Plaintext** JSON on disk |
| Settings, roster, permissions, cron | various `*.json` | **Plaintext** JSON on disk |

### Secrets: keychain vs. plaintext — the honest picture

On the **desktop build**, your provider API keys and your Discord/Telegram bot tokens are held
in the **OS keychain** (Windows Credential Manager, under service `ai.skynet.harness`), not in
a plaintext file. When you upgrade from an older build, any bot token found in the old
plaintext `channels/secrets.json` is migrated into the keychain and stripped from that file.

Connector credentials use a separate encryption key under the same keychain service,
account `connectors:encryption:v1`. Desktop startup encrypts and verifies both active
and recovery copies before removing legacy connector credential files. If the keychain
is locked or the original key is missing, StarNet preserves the encrypted files and
reports that saved connections are unavailable; it does not replace them with empty data.
Copies of those files alone cannot unlock connections on another OS account or computer.
Protect and retain your OS credential store when restoring backups. This protects
connector credentials, not the conversations, memories or exported files that may contain
Google content; their storage is listed separately above. Google Workspace public
activation remains deferred pending the remaining verification and data-handling work.

If you instead run the bare sidecar directly (developer mode / `node sidecar/index.js` /
tests), the OS keychain isn't reachable, so those bot tokens **fall back to a plaintext file**
(`channels/secrets.json`). This is called out plainly in the code rather than hidden.

These integration secrets are **plaintext even on desktop** today: the **Spotify** OAuth token
(`.secrets/spotify.json`) and the **ChatGPT/Codex**, **Grok**, and **Kimi** sign-in tokens
(`codex/tokens.json`, `grok/tokens.json`, and `kimi/tokens.json`). If that matters to you, keep
those integrations off. (Transcripts are run through a redaction step at write-time to avoid
capturing secret-shaped tokens in your chat history, but the transcript file itself is plaintext.)

Because this data sits in plaintext files under your user profile, anyone with access to your
Windows user account can read it. Protect your machine account accordingly.

## What we do NOT do

- We do **not** run analytics or telemetry of any kind.
- We do **not** collect crash reports.
- We do **not** require a StarNet account. Unless you buy credits, no account exists, and no
  StarNet backend holds anything of yours.
- We do **not** sell, share, or transmit your conversations, keys, or files to anyone —
  the only outbound traffic is the specific, purpose-built requests listed above.
- We do **not** store your prompts or your agents' replies on our servers, even on the credits
  path — see below.

## StarNet Credits — only if you buy them

Credits are optional and off by default. If you never buy them, skip this section: nothing in
it applies to you, and the app behaves exactly as described above.

If you do buy credits, you create an account on StarNet's billing service, and these things
become true:

- **What we hold.** Your email address, your credit balance and the ledger of grants and
  charges behind it, an identifier for each station you link, and the customer/subscription
  identifiers our payment processor gives us. That's the list.
- **Card details never reach us.** Checkout runs on **Stripe**, in your browser. StarNet never
  sees, receives, or stores a card number — the app has no payment form at all.
- **How you sign in.** By emailed one-time link. There is no StarNet password to steal.
- **Model runs go through our gateway.** This is the part worth being blunt about: on the
  credits path your prompts and your agents' replies are relayed through StarNet's servers to
  the model provider, because that is the only way we can pay for the call on your behalf. We
  relay them; we do **not** store their contents, and we do **not** train on them. What we
  keep is the metering — model name, token counts, cost, timestamp — which is what your balance
  is computed from. **If you use your own key instead, none of this traffic touches us at all.**
- **Deleting it.** Email androo.agi@gmail.com and we'll delete the account and its data. We
  keep the minimum transaction records that tax and payment rules require us to keep.

## Deleting your data

Your data is just files. To wipe it, uninstall StarNet and delete the `ai.skynet.harness`
app-data folder for your OS — Windows: `%APPDATA%\ai.skynet.harness\`
(`C:\Users\<you>\AppData\Roaming\ai.skynet.harness\`); macOS:
`~/Library/Application Support/ai.skynet.harness/`; Linux: `~/.local/share/ai.skynet.harness/`.
If you ever ran the developer-mode sidecar on Windows, also delete `%LOCALAPPDATA%\StarNet\`.
Provider API keys and channel tokens held in the OS keychain can be removed there too (search
your credential manager / keychain for `ai.skynet.harness`).

## Changes

If this changes, we'll update this document. Questions: androo.agi@gmail.com.
