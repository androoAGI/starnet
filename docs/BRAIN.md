# BRAIN.md — start here

**The 5-minute orientation for any agent session (Claude, Codex, or human) opening this repo.**
Last full reconciliation: **2026-08-03** (grounded against the Phase 0–8 cleanup candidate, not doc claims).

## What this is

**StarNet** — a real, local-first AI-agent harness wrapped in a living pixel-art space
station, shipped as a downloadable desktop app. You create agents, build the station, and
the layout IS the org: rooms = capability scopes, placed props = real tool grants
(**object = capability**), conveyor items = real work. The core product law is **truthful
telemetry**: the UI never asserts anything the harness can't prove.

- Thesis: beginner-friendly and power-user-complete — sandbox freedom, real work, Factorio-style pride loop. User-work quotas are off by default; limits are opt-in — with ONE shipped exception: a $25/day SOFT spend rail on metered runs (one-click RESUME, editable, 0 = off; `sidecar/budgetcaps.js`, DECISIONS 2026-09-17).
- Lineage: UltronOS (banned from Claude API 2026-04-04) → "v7" fake sim → this real harness
  (reuses v7's canvas + U.bus). Rebranded Skynet→StarNet 2026-06-22; internal `skynet.*`
  keys are intentionally kept.
- The repository desktop version is read from the release pins, never copied into this document. **Five
  locations must agree**: `package.json`, the root entries in `package-lock.json`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `skynet-desktop` entry in
  `src-tauri/Cargo.lock`. `release:bump` moves all five together; release preflight and CI must prove
  their agreement before an artifact is named or tagged.

## Customer and owner bug fixes

Check [qa/BUGS.md](../qa/BUGS.md) before fixing a reported bug. Create or update its durable
record using [qa/bugs/README.md](../qa/bugs/README.md): origin, affected build, report,
before/after regression, and sibling **adapters, entry points, displays, lifecycle paths**.
Every relevant sibling needs a registered fast/http scenario or an explicit coverage gap.
Run the affected [customer journeys](../qa/CUSTOMER_JOURNEYS.md) plus the normal change gates.
Keep source-fixed, installer-verified and customer-recovered separate; tag ancestry, a closed
issue or a silent reporter cannot establish recovery. Rebuild the index after updates.
These rules apply to internal agent merges as well as pull requests.

## Architecture in one screen

```
npm start  →  node sidecar/index.js  (ONE process, port 8787)
              ├─ sidecar/loop.js      runAgentLoop() — THE agentic loop (messages array,
              │                       tool accumulation/repair; stateless between runs)
              ├─ sidecar/index.js     composition root (~14.8k lines) — routes + subsystem wiring
              ├─ http-body.js / file-response.js / media-service.js
              │                       bounded request/file/media policy extracted from the root
              ├─ run-execution-state.js / domain-store.js
              │                       explicit per-run bookkeeping + normalized singleton persistence
              ├─ providers/           anthropic, openrouter, openai-compat, codex(OAuth), gemini
              ├─ capability/          station layout → tool allowlist (object=capability)
              ├─ tools/ (14)          web/browser/computer/fs/shell/notebook/recall/skills/…
              ├─ channels/            telegram, discord, SSE hub, keychain-split secrets
              ├─ mcp/                 MCP connector manager + curated catalog + OAuth 2.1
              ├─ cron*.js             schedules → scripts/real runs → bounded outputs/delivery/pipelines
              └─ *-store.js (10+)     atomic fsync-rename persistence per subsystem

frontend/  (no build step; index.html loads ~80 app/*.js modules in order)
              ├─ app/world.js (~5.6k) canvas station renderer — hero agent + crew[] bodies
              ├─ app/app.js           U.bus wiring, roster, run state (frontend OWNS roster)
              ├─ app/chat.js          COMMS window + streaming; recommendPass() = the ONE post-run beat
              ├─ app/recommend.js     THE RECOMMENDATION SPINE — pure one-voice arbiter over every
              │                       proactive channel; drops any offer that can't cite its evidence
              ├─ app/recquality.js    THE QUALITY LOOP (pure) — evidence STRENGTH, belief STALENESS, the
              │  + recqualitystore.js  per-channel outcome EWMA. Strength/quality are bounded WITHIN-tier
              │                       damping (priority order stays the spine's law) and are NEUTRAL when
              │                       state is absent. Weights move only on attributed outcomes: an accepted
              │                       offer stamps the run it spawns (RUN_META.rec) and that run's finish +
              │                       the Commander's 👍/👎 fold back. Floored ≥0.5 — a dud channel gets
              │                       quieter, never silent. A STALE belief may be ASKED about ("still
              │                       true?", same slot + card grammar), never asserted.
              ├─ app/beatcard.js      beat-slot machinery (one visible beat, reserve, FIFO, expiry)
              ├─ app/queryspine.js    keyed GET dedupe, TTL, last-good state, subscriber polling
              └─ app/*                dossier, quests, recruiter, build mode, stores, voice…

shared/    FROZEN contract — events.js (~60 event types) + schema.js validator.
           OWNED files: additive changes only, by request to the owner lane.

src-tauri/ desktop shell (Tauri 2, NSIS/dmg, embedded node; credentials.rs owns keychain and
           legacy secret migration; updater feeds from GitHub Releases: androoAGI/starnet-releases)
```

Most bugs are **seam bugs**: emitter → store → renderer. Trace the full path before editing.

### Task-context elicitation (2026-07-16)

Interactive COMMS and messaging-channel tasks pass through one intent layer in `runOnce`. The model
proceeds immediately when context is sufficient; only a materially outcome-changing, non-discoverable
gap may produce one `TASK_QUESTION` with 2–3 choices (two questions maximum for the whole task, with
the second reserved for a newly exposed blocker). COMMS strips the protocol into a natural one-tap
choice; text channels render numbered choices. The answer resumes the same durable Task Brief, survives
reload/restart, and is injected into delegated workers. Task-local answers never silently become global
dossier beliefs; only an identical decision repeated across two completed briefs appears later as
bounded, explicitly weak relationship evidence. Unattended cron and night-shift runs remain unchanged.

Reliability is host-enforced, not prompt-dependent. An attended Task Brief receives two internal controls:
`brief.ask` validates the decision dimension, material reason, research status, 2–3 distinct choices,
recommended default, second-question blocker, and whole-task two-question ceiling; `brief.proceed` stores a
compact settled objective and unlocks consequential tools. Until proceed succeeds, reads remain available for
research but every write/execute tool is rejected before checkpoint or dispatch. A final ask stops the same tool
batch, so a model cannot ask and mutate behind the question. Explicit cancel/pivot replies are routed separately
instead of being learned as answers, terse channel answers resume by durable brief state, and only `done` briefs
can contribute weak relationship evidence. The text `TASK_QUESTION` marker remains a compatibility/UI transport,
not the authority boundary.

Build-mode gestures and onward routing are locked in [DECISIONS.md](DECISIONS.md), “Build mode / conveyors”: SELECT MOVES, THE HAND, SEND TO and the LOOP-only cycle rule.

## How to work here (non-negotiable)

1. **Read the local operating protocol** (`CLAUDE.md` at the repo root of the internal
   integration environment — untracked, maintainer tooling). You are one of many concurrent
   agents; work in your own worktree, never feature-edit the integration tree. External
   contributors: a normal fork-and-pull-request workflow is all you need (see
   [CONTRIBUTING.md](../CONTRIBUTING.md)).
2. **Invoke the operating-doctrine skills** (local `.claude/skills/`, untracked maintainer
   tooling) — `starnet-task-doctrine` first, always; then the law skill for your area
   (frontend/backend), `starnet-verify` before claiming done, `starnet-merge-ritual` to
   integrate. They encode the locked judgment; they win over anything conflicting in older
   docs.
3. **Gate:** `npm run test:fast` green before merge. The current step lists live in
   `test/fast.list` and `test/http.list`; do not copy changing counts into this orientation.
   Sidecar/route changes also owe the complete `npm run test:http`. Live-app verification via
   `node dev/seed.js --keep` (pre-onboarded workspace, no ceremony) + preview/CDP DOM
   round-trips (canvas screenshots time out — see MISTAKES.md).
4. Read [DECISIONS.md](DECISIONS.md) (locked, don't re-litigate) and
   [MISTAKES.md](MISTAKES.md) (don't repeat) before your first edit.
5. Current work queue: [NEXT.md](NEXT.md).

## Where truth lives (in freshness order)

| Question | Source of truth |
| --- | --- |
| What just happened on trunk | `git log --oneline` + `qa/digests/` merge digests |
| Is trunk green / app healthy | `npm run qa:guardian` · dashboard `qa/STATUS.md` |
| Known/suppressed defects | `qa/KNOWN_ISSUES.md` (fingerprint ledger) |
| Open findings | `node scripts/qa/ledger.mjs --status` |
| Who is working where | `git worktree list` plus the current owner assignments in NEXT.md; a parked tree is not an active claim |
| Current priorities | The current campaign at the top of [NEXT.md](NEXT.md); re-verify old entries against source and customer evidence |
| What the user saw break | `docs/GROUND_UP_AUDIT_2026-07-06.md` + the two UPDATE_*_AUDIT docs |

**Doc-trust rule:** any doc older than ~a day is a hypothesis. This project merges many
lanes per day; grep trunk before acting on any doc claim, including this file's.

## Doc map (what to read, what to ignore)

**Living (keep current, safe to trust after grep-check):**
this file + `DECISIONS.md` / `MISTAKES.md` / `NEXT.md` (plus the untracked local
`CLAUDE.md` / `AGENTS.md` / `.claude/skills/*` maintainer tooling),
`qa/{STATUS,KNOWN_ISSUES,QA_STATION}.md`, `docs/RELEASE_RUNBOOK.md`,
`INSTALL.md`, `PRIVACY.md`, `TERMS.md`, `NOTICE.md`, `loops/*.md` (QA crew directives),
`scripts/VISUAL_AUDITOR.md`, `CODE_MAP.md` (rebuilt 2026-07-06).

**Recent audits still driving work (2026-07-04..06):** `docs/GROUND_UP_AUDIT_2026-07-06.md`,
`docs/UPDATE_PIPELINE_AUDIT_2026-07-06.md`, `docs/UPDATE_STATE_SAFETY_AUDIT_2026-07-06.md`,
`docs/ROADMAP_2026-07-04_BRUTAL.md` (the strategic 7/30/90 plan),
`docs/POLISH_SPRINT_2026-07-06.md` (7 of 8 lanes already merged — see NEXT.md).

**Historical — do NOT plan from these** (they describe finished or superseded work; kept
for archaeology): `docs/archive/SKYNET_BUILD_PLAN.md`, `docs/archive/INCREMENTAL_ROADMAP.md`,
`docs/archive/WIRING_AUDIT.md`, `docs/archive/BUILDER_AND_WORLD_FOUNDATION.md` (architecture
ideas partially adopted; the code is the authority), `docs/STARNET_REF_REPLACEMENT_*` and `docs/STARNET_PHASE*` evidence
templates, `docs/REF_HARNESS_*` parity docs, most `docs/*_PLAN.md` files (nearly every plan
doc marked "SHIPPED/EXECUTED" in its header or superseded by the 2026-07-06 audits), and
everything in `docs/archive/`.

When in doubt: the newer date wins, the audit beats the plan, and trunk beats both.

## Bottlenecks as of 2026-07-06 (historical — current priorities live in docs/NEXT.md)

Since this list was written: releases are public on `androoAGI/starnet-releases` (every cut since v0.10.x),
the release train signs Windows installers and notarizes both macOS builds, and outside users file issues
and PRs on the public repo. Kept for the reasoning, not as current status.

1. **Everything user-facing is bottlenecked on Andrew's ~1 hour of launch chores** — publish
   the releases repo (updater 404s for the public until then), rotate the dev OpenRouter
   key, support email, updater-key offline backup. No code lane can substitute.
2. **Zero outside users** — the 15-min attended playtest (gate 5) and "10 outside installs"
   have been dodged repeatedly; the audit backlog is now lower-value than 5 real user
   sessions.
3. **Unsigned binaries** — SmartScreen/Gatekeeper kill the install funnel; signing identity
   is the single highest-leverage trust purchase (days 8–30 in the roadmap).
4. **18 unmerged `agent/*` branches** — undecided inventory; each is either value to land
   or noise to delete. Triage list in NEXT.md.
5. **Doc sprawl** (~100 md files, most historical) — mitigated by this brain; keep it that
   way by updating NEXT.md instead of writing new plan docs.
