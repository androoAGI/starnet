<!-- DRAFT release notes for the first official version. Consumed at release time:
     after `npm run release:bump 1.0.0` scaffolds RELEASE_NOTES.md, paste this body over
     the scaffold, amend + re-tag per docs/RELEASE_RUNBOOK.md §1.2, then DELETE this file.
     Written 2026-07-09 (launch-polish session) against trunk 47fbc90a — re-verify claims
     against trunk at cut time; add anything the UI-finale sprint ships when it merges. -->
# StarNet v1.0.0 — the first official release

StarNet is a local-first AI-agent harness wrapped in a living pixel-art space
station. You create agents, build the station, and the layout IS the org:
rooms are capability scopes, placed objects are real tool grants, conveyor
items are real work. The core law is **truthful telemetry** — the station
never shows you a state the harness can't prove.

This is the first public build. Everything below ships working, verified
against the live app.

## The station
- **First-boot ceremony**: STARNET splash → CREATE YOUR OVERSEER (one full-screen
  console: name, brain, appearance, voice) → a live awakening with CRT speech
  bubbles → Interview 2.0 → your station.
- **Object = capability**: place a prop, grant a power; remove it, revoke it.
  Undo/redo re-grants for real. The world renders only proven state.
- A living crew: agents walk to their desks because they are actually using a
  tool, sleep when idle, and speak in CRT nameplate bubbles.

## Real work
- **COMMS**: streaming chat with slash commands, photo/file attachments (jailed
  upload, models really read them), selectable transcripts, input history,
  per-agent voices (neural TTS with honest fallback), and a beat system that
  asks for exactly one decision at a time.
- **Task board & workshop**: real deliverables built in a jailed workshop —
  the payoff action is OPEN (run the artifact), not "view source".
- **Quests** with completion contracts — a quest can only exist if the harness
  can mechanically prove it done.
- **Recipes, skills, routines**: what to build, how to build it, when to run it.
  Skills gate on placed gear; routines fire real scheduled runs with visible
  history.

## Autonomy you can trust
- **Night shift**: leave the station and it works — server-owned beats, real
  jailed tool runs, an enforced leash, and a morning report of everything it
  did, built, and declined (with reasons). Every decision is ledgered.
- **Project lens**: tell an agent a path in chat and it can work there after
  ONE consent; night shift may only revisit roots you blessed — deliverables
  arrive as patches applied to a fresh `ns/` branch, never main, never pushed.
- **E-STOP**: a visible red control in the top bar (or Alt+H) kills every live
  run everywhere — including cron, channels, and a wedged night-shift beat —
  and reports the honest count.
- Consent prompts from background sessions surface as clickable notifications;
  an unseen prompt fails closed (deny), never open.

## Providers & channels
- **BYOK, free forever**: OpenRouter, Anthropic, OpenAI-compatible, Gemini,
  local/Ollama — or sign in with ChatGPT (no key). Keys live in the OS
  keychain; honest expired-auth states with re-sign-in doors.
- **Channels**: Telegram, Discord, Slack, Matrix, Signal — message your agents
  from your phone; connection state is transport-proven, never optimistic.
  (Slack/Matrix/Signal are new this release — marked experimental until the
  first real-token pass.)
- **Connectors**: a curated one-click MCP catalog with OAuth 2.1, paste-a-key
  tier, and honest per-connector state.

## Trust & recovery
- Crash-safe persistence with atomic writes, quarantine + disclosure on
  corrupt saves (never a silent reset), verified-write law on every credential.
- A hung provider stream can no longer masquerade as a completed run; stalls
  time out honestly and E-STOP always reaches them.
- Updates change code, never state; the updater feeds from signed releases.

---
Windows installer (NSIS, unsigned). SmartScreen will ask for
**More info → Run anyway** on first launch until code-signing is in place.
macOS and Linux builds are staged from the same pipeline; Gatekeeper shows the
equivalent unsigned-app warning on macOS.
