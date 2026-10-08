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
Real-model run: ✅ 2026-10-08 — see "Real-model proof" below.

## Lane 4 — Ctrl+K: one search for everything  ✅ BUILT
SYSTEM › FIND (windows/find.js): a station window (rises from the dock, never a centred popup), Ctrl+K anywhere. Searches
every place, each crew member's dossier tabs + desk ("NOVA › CONFIG"), every open conversation; ↑↓ Enter. No match → ASK
THE CREW types the words into COMMS (never sends). ONE opener: `Places.open` (app/places.js) — FIND and the agent's
station.show open places through the same code. FIND is itself a place; the manual names Ctrl+K. Glass recipe measured
live (8px field, 10px rows, ≥14px, no glow). Proof: test/find-window.e2e.test.mjs.

## Lane 5 — front doors (organization, nothing removed)
1. Autonomy & access in one place — ✅ done by another lane (one-access-setting, merged 10-04).
2. NOTIFICATIONS — ✅ All/New count the NEEDS YOU rows they show; New = the bell badge (proven live in
   station-control-gaps.e2e: All · 2, New · 2, bell 2).
3. DELIVERABLES — ✅ no second heading, one short lead line, glass keys + fields (10-05); ✅ 10-08 the library itself: 10px
   glass cards, the recessed summary strip, 8px kind chips + project rows, a readable drawer, nothing under 14px, an open
   card is a brighter edge (no glow). Measured live on a real deliverable: no OS paint, no text under 14px, no outer glow.
4. Recruit-bay forms (`.mkt-save-h`) — ✅ resolved on trunk: every form view (save, recipe save, launch, build, harness
   import) mounts inside `.mkt-stage.form`, whose rule replaces the solid phosphor title (measured live 10-08: Build a
   custom class + IMPORT AGENT headers are transparent, 21px). Nothing left to do here.
5. Dossier CONFIG one save model — ✅ decided on trunk (2f17027a3, one-access-setting): "Text you edit needs SAVE; buttons
   apply right away." — stated in the CONFIG lead.

Order: 2 → 3 → 4 → 5 (2 makes every later lane's agent smarter; 4 reuses Lane 1's PLACES).

## Lane 6 — the trunk since 10-04, taught (2026-10-08)
A read-only audit of 207 trunk commits found 12 user-facing features the agent did not know. CONCEPTS now covers desk
seats (station.build op agent; WHO SITS HERE), SETTLE (Commander only, and station.settings spending shows `unsettled`),
held StarNet credits, routine keys + toolsets, station.status, connector SIGN IN (Commander only), browser.reset, HINTS
(look.set), START FRESH / ERASE EVERYTHING (Commander only — no agent route exists, on purpose), updates stop live runs,
and "a conveyor is a line". FIND/station.show place descriptions carry credits, settle, hints, reset browser and erase.

## Real-model proof (2026-10-08, scratch station from this worktree, dev OpenRouter key)
Each ask in a FRESH COMMS session, plain words, no tool names; every result checked against backend truth, not the reply.
| ask | model | result | calls / time |
|---|---|---|---|
| open my deliverables | Haiku 4.5 | ✅ DELIVERABLES opened | 2 / 28 s |
| what is a conveyor, where do I build one | Haiku 4.5 | ❌ "not a standard term" → ✅ after CONCEPTS fix | 1 / 9 s |
| open NOVA's config | Haiku 4.5 | ✅ dossier on CONFIG | 3 / 11 s |
| daily spending limit $5 | Haiku 4.5 | ❌ opened the window → ✅ perDay 5 → ✅ $7 in 7 calls | 10 / 49 s → 7 / 26 s |
| per-run cap $2 | Haiku 4.5 | ✅ perRun 2 | 5 / 20 s |
| clear my notifications | Haiku 4.5 | ❌ opened the window → ✅ notifications.clear | 3 / 20 s |
| turn off the hover hints | Haiku 4.5 | ❌ opened → ✅ but 19 calls + shell/find detour → ✅ hints false | 6 / 28 s |
| take me to where I reset the browser | Haiku 4.5 | ✅ SETTINGS › BROWSER | 3 / 17 s |
| write a weekly-review checklist file | Haiku 4.5 | ✅ file + deliverable_note → DELIVERABLES 1 | 3 / 30 s |
| switch yourself to Sonnet 4.5 | Haiku 4.5 | ✅ agent.model (stringified args) | 5 / 30 s |
| Monday 9am motivational routine | Sonnet 4.5 | ✅ cron 0 9 * * 1, next Mon Oct 12 | 2 / 26 s |
| hit the emergency stop | Sonnet 4.5 | ✅ /api/halt all halted; COMMS names the E-STOP, no TRY AGAIN | 3–12 / 22–34 s |
| pin this chat to the top of my sessions list | Sonnet 4.5 | ✅ session.pin, no id → this conversation | 6 / 36 s |
| pin this conversation | Haiku + Sonnet | ❌ both wrote a notebook memory → ✅ 8/8 (4 phrasings × 2 models) pinned their OWN session | 3–5 / 18–42 s |
Fixes the runs drove: station.control/power read action|setting|name and flat or stringified args (the card reads the
call the same way); budget.set/limits.set with none of their fields are refused, never an empty "done"; "$5" saves as 5;
station.settings answers carry `toChange` (the actions, tool and args that change that section) and accept look /
sessions / agents / budget / all; station.show reads place|target|id|window|page|section and its result says opening is
not doing a change; NAVIGATION says CHANGE = station.control/power and never the shell, files or a web request to the
station; session.* default to this conversation; a run stopped by its own E-STOP says so, no TRY AGAIN; an inline SESSIONS
rule (every COMMS chat is a rail session — pin/rename/archive with station.control session.*, never a memory note), paid for
by a tighter TOC (system 24727/24750 · 24948/24950 — ~2 chars left on the granted floor); session.list marks
`thisConversation`; session_id/sessionId read as session.
Known, not fixed: Sonnet paused a routine by hand before
pressing the E-STOP (the pause outlives RESUME); a model may name tool ids in a reply (station.build) — prompt-level.
Not a bug: after an agent E-STOP in a HIDDEN tab, RESUME AUTOMATION appears on the next focus (it polls only while visible).
Repeatable: `node dev/self-driving-proof.mjs [port] [--estop]` against a running scratch station (close other tabs on it).
Not yet proven: ASK mode (every run above had full access — no approval cards), and any non-Anthropic model live.
