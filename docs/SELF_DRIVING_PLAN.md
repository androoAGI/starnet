# SELF-DRIVING STARNET — the polish build plan (2026-10-04)

Andrew 10-04: *"focused on polishing everything within starnet as a whole … WAAY easier to use and navigate … the agents
[should] understand EVERYTHING about starnet and how it works so it can basically use itself instead of the user having to
navigate and do everything … 100% full freedom with the harness."*

Grounded on trunk `707dcaf5e` by three read-only audits (agent self-knowledge, agent control coverage, UI navigation).
Laws that bound this plan: simplify = organization, never removal ([interview-depth-is-sacred]); ABILITIES 8→3 was
rejected once — never merge its tabs into one grid; every UI claim must be provable (truthful telemetry); escalations stay
in `station.power`; credentials, consent answers and E-STOP *resume* stay human-only.

## Lane 1 — the agent drives the UI  ✅ BUILT (`agent/self-driving`)
`station.show {place, agent?}` opens any of 50 places (frontend/app/places.js) on the Commander's screen, raised, on the
right tab — only from the run they are watching. Manual NAVIGATION tells agents to open instead of describe. Fixed the
manual's stale "APPROVALS hotspot / Alt+A" (approvals live in COMMS). Unit 273 + e2e ALL PASS.

## Lane 2 — the agent knows everything (on demand, 0 prompt bytes)
Gaps found: outbox, group chat, trophies, notifications, E-STOP, spending screen, checkpoints/rewind, apps, floors/lines
are unexplained or one-word; Telegram/plain-chat turns get NO manual TOC; the agent manual and the Field Manual are two
hand-kept texts that drift.
1. `manual.read` section **places** — generated from PLACES (every place's words + about), so it can never drift.
2. `manual.read` section **concepts** — a glossary of every StarNet noun (crew/classes, props=capability, floors & lines,
   outbox vs deliverables, recipes, schedules vs goal loops vs away work, group chat, quests/progress/trophies,
   notifications/NEEDS YOU, spending caps, checkpoints/RECORD, memory/learning, approvals/Full Power, E-STOP, apps,
   abilities/connectors/skills/channels) — each with "how the agent does it for you" (the tool) and "where it lives" (place id).
3. Every surface gets the TOC line (Telegram/owner DM/plain chat), within the payload budget (24653/24700 now).
4. Drift test: every CAPS UI name the manual uses must exist in PLACES words or a known control list.

## Lane 3 — 100% freedom (the station-control catalog gaps)
Easy (a route exists — add a catalog entry, same `callOwnRoute` path): away-work queue/shift/remove/implement/undo
(`/api/workshop/*`), deliverables cleanup + undo, quests confirm/dismiss/disposition, `projects/forget`, plugin/hook
revoke+delete, channel disconnect, `cron/degraded/clear`, `runtime/knobs`, `browser/settings`, `config/export`,
`update/prepare|cancel`, group-chat membership (`/api/groups` configure), user-prop scale/delete, **E-STOP engage**
(`POST /api/halt` — the safe direction; resume stays human). Power tier: computer-control, skill-exchange install,
execution policy, remote enable, config import/reset (typed confirm).
Page bridge (new `station.control` page actions): launch a recipe, set the station default model
(`App.setStationProvider`), notifications mark-read/clear, author a custom class, per-agent toolsets.
Then a REAL-model run on a seeded station (the 10-02 lane is mock-proven only).

## Lane 4 — Ctrl+K: one search for every place, agent and action
A palette over PLACES (same list the agent uses) + the crew + common verbs; Enter opens through `StationUI.showTerm`.
No match → "ask the crew" types it into COMMS. One list = the palette, the agent and the manual can never disagree.

## Lane 5 — front doors (organization, nothing removed)
1. Autonomy & access: SETTINGS › PERMISSIONS is the one place it is SET; SETTINGS › AUTONOMY dials, dossier ACCESS and the
   AUTOMATE initiative line become read-outs with a jump (station.show-style) to it. Every control kept.
2. NOTIFICATIONS: All/New counts include NEEDS YOU rows (badge and count disagree today — truthfulness bug).
3. DELIVERABLES: drop the duplicate heading + intro paragraph; old keys → glass keys.
4. Recruit-bay forms: the 6 `.mkt-save-h` headers → the glass sheet header.
5. Dossier CONFIG: one save model.

Order: 2 → 3 → 4 → 5 (2 makes every later lane's agent smarter; 4 reuses Lane 1's PLACES).
