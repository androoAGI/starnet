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

## Lane 2 — the agent knows everything  ✅ BUILT (on demand, inline prompt got SHORTER)
`manual.read` section **concepts** (~8K, reference only): every StarNet thing — what it is, its place id, the tool or
station.control action that does it, the trap — grounded line by line in the code. NAVIGATION's **EVERY PLACE** list is
generated from PLACES. A Telegram owner DM gets a ~480-char pointer to manual.read (never the 6K index, never nothing).
Stale text fixed: the dossier SKILLS tab. Drift test `test/manual-concepts.test.js`: every [place], tool, action and
MENU › TAB path the manual names is real. Payload 24650/24700 · 24871/24900 · tool bytes 65276/65300.

## Lane 3 — 100% freedom  ✅ BUILT (20 more actions: 47 → 67)
station.control: away.queue|remove, deliverables.cleanup|restore (records only), quest.dismiss|later, project.forget,
channel.disconnect (Discord forget refused — its route ignores it), browser.mode, group.configure (by id or title, at the
current revision), notifications.read|clear (page; a NEEDS YOU entry is never touched), **estop.engage** (fires just
after its result, reported as "engaging"; only the Commander resumes). station.power: plugin/hook revoke+delete (one may be
a veto guard), limits.set (0 = UNLIMITED). New read sections: away, library, quests, groups, channels, limits.
Left out on purpose: away-work shift/implement (streaming routes that spend — the agent can do the work itself), update
prepare (aborts every run), prop scale/delete (canvas would show stale art until reload), recipe launch (refuses while any
COMMS run is busy — routine.create/team.dispatch cover it), quest confirm/report (an agent never approves its own claim),
cron degraded-clear (accepts data loss — the Commander's call), credentials, consent answers, lifting an E-STOP.
Still open: a REAL-model run on a seeded station (every lane so far is mock-proven).

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
