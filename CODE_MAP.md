# CODE_MAP — what lives where (rebuilt 2026-07-06)

Real structure of the StarNet harness, grounded against trunk. Numbers are approximate and
drift — trust `wc -l` over this file. Start at [docs/BRAIN.md](docs/BRAIN.md) if you're new.

> The previous CODE_MAP.md was a June-era single-agent→multi-agent refactor plan for
> world.js; that refactor shipped. This file replaced it.

## Process model

ONE Node process: `npm start` → `node sidecar/index.js` → HTTP + SSE on **:8787**
(`PORT`/`SKYNET_PORT` override). It serves `frontend/` statically, runs the agent loop
in-process, and streams frozen `U.bus` events to the browser as ndjson/SSE. The desktop
app (Tauri) embeds Node + this same sidecar and compiles `frontend/` into the exe.

Dev entry: `node dev/seed.js --keep` — materializes a pre-onboarded scratch workspace from
`dev/fixtures/seed-workspace/`, boots with `SKYNET_DEV=1`; key/model in `dev/.env.dev`.

## sidecar/ (~23k lines, ~82 files) — the harness

| Area | Files | Role |
| --- | --- | --- |
| Agent loop | `loop.js` (~460) | `runAgentLoop()` — messages-array while-loop; tool-call accumulation + arg repair; stateless between runs |
| Server | `index.js` (~6.5k) | HTTP+SSE, `/api/run` and every other route, static frontend, event emission. THE hotfile — most merges conflict here |
| Providers | `providers/` | `factory.js` + anthropic, openrouter, openai-compatible, gemini, codex (ChatGPT OAuth + token store) |
| Capability | `capability/` | station layout → tool allowlist: `resolve.js`, `capGate.js`, `registry.js` (CAP_REGISTRY), `toolsets.js`, `office.js` |
| Tools | `tools/` (14) | registry + web/browser/computer/desktop/fs/notebook/recall/skills/image/spotify/shell… Tool surface must never exceed wired reality |
| Channels | `channels/` (8) | telegram transport+adapter, discord gateway+wire, SSE hub, `secrets.js` (keychain split), store, registry |
| MCP | `mcp/` (5) | manager, http/stdio transports, OAuth 2.1 generic client, curated one-click catalog |
| Cron | `cron*.js` (5) | pure schedule math, lock, store, driver, channel auto-notify |
| Cost/spend | `cost.js`, `spend.js`, `credits.js`, `ledger.js`, `mint-ledger.js` | real USD reconciliation, budgets, mint dedup |
| Persistence | `*-store.js` (10+) | atomic fsync-before-rename stores: checkpoint, save, run, transcript, skill, workshop… |
| Memory | `context.js`, `memcore.js` | cortex recall/redaction, context compaction |
| Safety | `permissions.js`, `permgrants.js`, `apiauth.js`, `halt.js` | consent broker, grants, local API auth, E-STOP |

## frontend/ (~50k lines in app/, ~133 files) — the station

No build step: `index.html` loads ~80 `app/*.js` modules in dependency order, then `app.js`
wires them to U.bus. All static assets MUST live under `frontend/` (packaged app 404s
anything else).

| Area | Files | Role |
| --- | --- | --- |
| World render | `app/world.js` (~5.6k) | canvas station: tiles, pathing, props, conveyors, CRT warp. Hero `agent` + `crew[]` bodies at Bay props (crew are real separate runs, but only the hero walks/explores) |
| Model/bake | `app/worldmodel.js`, `app/stationbake.js` | geometry, prop defs, bake cache |
| State spine | `app/app.js` | roster (frontend OWNS the roster; sidecar mirrors via `/api/roster`), run state, U.bus listeners |
| COMMS | `app/chat.js`, `app/voice.js`, `app/voice-state.js` | streaming chat window, beats, STT/TTS; spoken-reply handles and typed cancels |
| Growth | `app/dossier.js`, `app/understanding.js`, `app/study.js`, `app/autonomy.js`, `app/trust.js` | commander dossier, beliefs, earned autonomy |
| Work | `app/quests.js`, `app/goals.js`, `app/recipes.js`, `app/workstreams.js`, `app/channels.js` | quests, goal arcs, recipes, per-workstream run state |
| Recruit | `app/recruiter.js`, `app/prospect.js`, `app/worksignal.js` | EWMA work-signal → adaptive prospects |
| Build | `app/build.js`, `app/refit.js` | station editor |
| Chrome | `app/topbar.js`, `app/modeldock.js`, `app/navdock.js`, `app/widgets.js`, `app/stationui.js` | instruments, docks, windows |
| Persistence | `app/save.js`, `app/cloudsave.js`, + ~20 `*store.js` | versioned localStorage save (v5) + durable sidecar mirror |
| Legacy v7 | `js/util.js`, `js/arcade.js`, `js/audio.js`, `js/assets.js` | ported utilities, SFX director (music deleted by design), sprite data |

## shared/ — the FROZEN contract (owned; additive-only by request)

`events.js` (~60 event types, schema-validated both directions), `schema.js` (zero-dep
validator), `emitter.js`, `clock-rng.js` (deterministic tests), `specialties.js` (class
catalog). Never rename/remove an event or field.

## src-tauri/ — desktop shell

Tauri 2; version in `tauri.conf.json` + `Cargo.toml` (0.2.2). NSIS + dmg; embedded node
binary; platform keyring; updater → GitHub Releases `androoAGI/starnet-releases`
`latest.json`. Workspace data root: `%APPDATA%\Roaming\ai.skynet.harness\workspaces`.

## test/ (~409 files) + gates

- `npm run test:fast` — THE merge gate: ~364 steps from `test/fast.list` via
  `scripts/run-fast-tests.mjs`.
- `npm run test:http` — HTTP/e2e. `npm test` = test:fast + test:http.
  (The old `validate` / `test:world` steps were retired 2026-07-24: both were Phase-0.0 wrappers
  around the v7 engine files `frontend/js/map.js` + `frontend/js/data.js`, which no longer exist —
  so `npm test` had been failing at step 1. The current engine is covered by `worldmodel.test.js`,
  `crew-containment.test.js` and `station-authority.test.js` in the fast gate.)
- `npm run sync:website` — regenerate the starnetos.com demo embed (`website/app`) from `frontend/`;
  gated by `test/website-app-sync.test.js`, so never hand-edit `website/app`.
- QA station: `npm run qa:guardian` (pinned-worktree trunk gate: test:fast→shoot→golden→audit),
  `qa:beginner`, `qa:janitor`, ledger at `scripts/qa/ledger.mjs`; dashboards in `qa/`.
- Release: `scripts/release-bump.mjs`, `release-assemble-manifest.mjs`,
  `verify-update-host.mjs`, `t0`–`t5` tiers; CI in `.github/workflows/release-train.yml`;
  procedures in `docs/RELEASE_RUNBOOK.md`.

## Everything else

- `dev/` — seed launcher + fixtures + `.env.dev` (gitignored).
- `loops/` — long-form directives for the autonomous QA crew (guardian, janitor, truth
  auditor, beginner run, overseer, adversarial reviewer…).
- `qa/` — STATUS dashboard, KNOWN_ISSUES fingerprint baseline, digests, findings ledger.
- `scripts/` — gates, golden screenshots (`shoot.mjs`, `golden.mjs`, `audit.mjs`), release
  tooling, QA crew runners.
- `design/mockups/` — throwaway HTML mockups (not product code).
- `docs/` — see the doc map in [docs/BRAIN.md](docs/BRAIN.md); most plan docs are historical.
