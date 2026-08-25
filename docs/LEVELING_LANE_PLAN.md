# LEVELING / XP LANE — plan

**Date:** 2026-07-29 · **Branch:** `claude/starnet-improvement-ideas-feef01` · **Status:** ALL FIVE SLICES BUILT.

| Slice | Commit | What shipped |
| --- | --- | --- |
| S1 | `9df2aec1` | the specialist rate-starve fix — a summoned agent can earn at all |
| S2 | `f016f09c` | RELIABILITY, the harness's own read, as dossier B2 |
| S3 | `b103854f` + `62e97d1c` | the track record reaches the lead's dispatch briefing |
| S4 | `f85e6e10` | five mid-game milestones + the boot-time trophy reconcile |
| S5 | `d902ab61` | PRACTICE — what the agent taught itself, as dossier B3 |

Each slice carries its own claims re-lock. Two slices landed somewhere other than where this plan aimed
them; both deviations are recorded under their slice below.

Grounded against trunk by reading the code, not the docs. Current gate for this subsystem is green:
`test/xp.test.js` 268 assertions · `test/xpstore.test.js` 43 · `test/xp-crewsplit.test.js` 19 ·
`test/roster-track.e2e.test.js` 25 (the counts at audit time were 146 / 29 / 19 / none).

---

## The finding (as audited, BEFORE the work — each item now carries the slice that closed it)

The engine is not the problem. `frontend/app/xp.js` is a careful, honest model: XP mints **only** on explicit
positive user approval, confidence reports `known:false` until `MIN_SAMPLES` (3) real samples exist, and
`crewSplit` refuses to split credit across workers whose contribution the harness cannot prove. That is the
product's truthful-telemetry law correctly applied to a growth meter.

The problem is everything around it.

**1. Nothing consumes the numbers.** *(closed by S3 — the sidecar's per-run `[ORCHESTRATION]` briefing now
carries each specialist's earned credential.)* Every reader of `a.stats` is a *display* surface:

| Consumer | What it does with it |
| --- | --- |
| `world.js:146`, `world.js:6185` | hero name-tag "Lv N" + level-up pulse |
| `topbar.js:28` | station XP sliver |
| `stationui.js:1090/1212/1246/1310` | crew chip, dossier gauge, trophy case |
| `chat.js:4899` | `/whoami` line |
| `queststore.js:15` | quest copy |
| `confbeats.js:66` | one-time narration beat |

Grepping `sidecar/subagents.js`, `sidecar/nightshift.js`, `sidecar/runroute.js`, and `sidecar/scout.js` for
`confidence` or `level` returns **zero hits**. A Lv 20 / TRUSTED 92% agent and a Lv 1 stranger are treated
identically by delegation, night shift, and every ranked shelf. A trust number nothing acts on is decoration.

**2. XP has exactly one mint source.** *(closed by S2 + S5 — as two new axes, not a looser faucet; XP is
still user-approval-only, exactly as the standing law below demands.)* In `scoreEvent`, `agent.run.end` has six outcome branches
(`done`/`max_iters`/`budget`/`refusal`/`error`/`cancelled`) and **all six return `{ xp: 0 }`**; so do
`agent.tool_result`, `memory.write`, `memory.used`, `workitem.delivered`, and `channel.delivery`. Only
`memory.feedback` with quality 1 mints. Progression therefore tracks *how often somebody taps ▲*, not work
done — while the harness sits on provable facts (successful tool calls, deliverables, reconciled spend,
terminal reason) that never move any meter.

**3. Specialists are structurally starved.** *(closed by S1.)* `maybeStandaloneRate` ([chat.js:2060](../frontend/app/chat.js))
returns `'never'` when `agentId !== 'agent'`. The rate control renders from five sites — the standalone beat
(hero-only), the away-digest/OUTBOX rows (any agent), and the turn-in memory batch card (any agent) — so a
workstream bound to a specialist earns the **primary leveling beat only if that run happened to produce a
memory proposal**. Interactive specialist work is otherwise unrateable, and non-hero agents sit at Lv 1
indefinitely while the hero collects everything.

**4. The mid-game is empty.** *(closed by S4 — 14 badges now, five of them mid-curve.)* `MILESTONES` has 9 entries, four of which fire in session one (`first_light`,
`approved`, `pack_rat`, `night_shift`), then a cliff to `archivist` (10 memories), `workhorse` (25 tasks),
`veteran` (Lv 10), `centurion` (100 tasks).

**5. It is frontend-only.** *(STILL OPEN — the only finding this lane did not close.)* Stats live in the save envelope and are folded in the browser. A Telegram-only
Commander never levels anything until they open the desktop app (the return ritual back-fills, which is the
right design — but the dependency is real).

---

## Standing laws for this lane (do not violate)

- **Never gate.** No capability is locked behind a level; the sandbox law wins. Everything here *informs*, it
  never *unlocks*. (`xp.js` header states this; keep it true.)
- **XP stays user-approval-only.** Do not mint XP from operational events. The fix for #2 is a *second,
  separately-labelled* axis, not a looser XP faucet. Blurring them re-creates the "levels from chatter"
  problem the current design deliberately solved.
- **Never fabricate a number.** New meters honour the same calibration honesty: no readout before there is
  evidence for it.
- `shared/events.js` / `shared/schema.js` are owned — **additive only, by request**. Everything below is
  designed to need no bus change: `XpStore` already never emits.

---

## Slices

Ordered so each one is independently mergeable and independently verifiable.

### S1 — Fix the specialist rate-starve (bug, cheapest, ship first)

The hero gate in `maybeStandaloneRate` predates multi-agent workstreams. The beat renders into the *active
COMMS log*, so the correct predicate is not "is this the hero" but "is this run's agent the one the displayed
workstream is bound to" (`ws.agentId`, cf. `chat.js:5768`).

- Change the gate at `chat.js:2060` from hero-only to displayed-workstream-match; keep every other
  `'blocked'` condition untouched (one ask at a time, never mid-run, never behind a focused panel).
- `armRateFallback` already retries per run — no new plumbing.

**Done means:** in a seeded app, open a workstream bound to a specialist, run a task that makes ≥1 successful
tool call, observe the `▲ nailed it / ◆ close / ▼ missed` beat in that workstream, tap ▲, and see that
specialist's Lv chip in the crew manifest increment — with the hero's level unchanged. `test:fast` green.

### S2 — A second, provable axis (fixes #2 without touching the XP law)

Add a **RELIABILITY** track fed by events the harness already proves, kept strictly separate from XP/Level:

- New counters in `applyEvent` from `agent.run.end` terminal reasons (`done` vs `error`/`empty` vs the
  ceiling reasons `max_iters`/`budget`/`cancelled`/`refusal`), alongside the existing `toolsOk` / `delivered`.
- A pure `reliability(stats)` in `xp.js` returning `{ known, pct, band, completed, attempted }`, honouring the
  same "no number before evidence" rule as confidence (`known:false` under a minimum sample count).
- Render it in the dossier next to CONFIDENCE, labelled as what it is: *what the harness observed*, versus
  CONFIDENCE which is *what the Commander said*. Two honest meters, never averaged into one score.

Counter additions are additive to the persisted stats shape; `sanitize()` already defends non-finite values,
and `fresh()`/`clone()` need the new keys defaulted for old saves.

**Done means:** a run that ends `error` visibly moves the reliability readout while XP and Level do not move
at all; a `done` run moves both reliability and (after a ▲) XP. `test:fast` green.

### S3 — Make the numbers load-bearing, without gating

> **SHIPPED ELSEWHERE.** This slice was scoped at `rosterClause()`, whose output is baked into the cached
> `a.systemPrompt` — hence the recompose trap below. It landed instead on the sidecar's `[ORCHESTRATION]`
> briefing, which is rebuilt from the roster on EVERY run: same list the lead picks from, so the staleness
> risk was removed rather than mitigated. `Xp.credential()` quantizes the record precisely so the roster is
> re-pushed only on a tier crossing or band flip.

The delegation pick is made by the *model*, from the roster string. `rosterClause()`
([app.js:250](../frontend/app/app.js)) already composes `name — role` per specialist and rides into the lead's
system prompt and the pushed roster (`orchestration.js` `roster()` → `Map(agentId → {system, name, model})`).
Appending each specialist's **provable track record** there makes the lead's choice informed and truthful, with
no new transport.

- Extend the roster line with a compact, earned-only fact (e.g. `— 12 tasks shipped · TRUSTED`), omitted
  entirely for an agent with no evidence (never "Lv 1 · unproven", which reads as a rank).
- **The trap:** the composed system prompt is cached and the repo already has a documented
  cached-prompt hazard (`app.js:364`, roster-clause.test §D) — any roster change must be followed by
  `recomposeOrchestrators()`. Stats tick constantly, so recomposing on every XP change would thrash the cache.
  **Recompose only when the displayed band or level changes**, not per XP delta.
- Second consumer, same principle: the dossier/delegation surface states "has done this N times" from real
  counters instead of a bare level.

**Done means:** with two specialists on the roster where one has a real track record, the composed prompt
contains that specialist's earned fact and not a fabricated one for the other; a level-up triggers exactly one
recompose while ordinary XP ticks trigger none. `test:fast` green.

### S4 — Fill the mid-game

Extend `MILESTONES` with provable mid-game entries between "first session" and "25 tasks" — each declarative,
one-fire, and predicated only on counters the harness proves. Keep the existing shape so the trophy case,
`hint` copy, and quest rollup need no changes.

**Done means:** a seeded save mid-way through the curve lights at least one previously-unreachable badge, and
the trophy case shows its unlock hint while locked. `test:fast` green.

### S5 — Levels that actually level (own lane, after S1–S4)

> **SHIPPED, BUT NOT AS A REDEFINITION OF LEVEL.** Redefining the ladder would silently rewrite records the
> Commander already earned under the user-approval-only rule, and level renders synchronously in the world
> name tags and topbar where an async per-agent skill list cannot go. The idea ships intact as PRACTICE, a
> fourth separately-labelled meter (`Xp.practice`), exactly as S2 did for RELIABILITY. A procedure counts only
> when the AGENT wrote it, it is not archived, the guard is not withholding it, and it has actually been USED —
> that last clause is the anti-farm line: authoring moves the number by nothing. The remaining fork (whether a
> LEVEL should ever be recomputed from capability) stays open and unbuilt.

The payoff, and the reason this subsystem is worth touching at all: make a level a **readout of accumulated
capability** rather than a currency. `sidecar/skillcurator.js` / `skillreview.js` already distil procedure;
tying the band to how many distilled, user-approved procedures an agent actually carries would make
"Lv 7" mean *this agent has learned 7 things about how you work* — descriptive, provable, and impossible to
farm. Scope this properly once S1–S3 have landed; it is a design lane, not a fix.

---

## Verification plan

Per `starnet-verify`: `node dev/seed.js --keep`, DOM round-trips for each "done means" above (canvas
screenshots time out — assert on DOM/state, not pixels), and `npm run test:fast` green before any merge.
New pure logic goes in `test/xp.test.js`; wiring goes in `test/xpstore.test.js`. For S1, prove it the honest
way: revert the gate change and watch the new regression go red.

## Risks

- **S3 prompt churn** is the one real engineering risk — see the recompose rule above.
- **S2 save-shape drift**: old saves must hydrate with the new counters absent; cover it in `save.js` migration
  the way `stats` itself is already seeded (`save.js:29`).
- **Scope creep into gating.** Every slice above is descriptive by construction. If a change starts to read as
  "unlock", it is out of scope for this lane.

## Open for Andrew

1. ~~S5 is a design fork (level-as-capability-readout vs level-as-track-record).~~ **Decided in the build:**
   level was left alone and the capability readout shipped beside it as PRACTICE. Rewriting the ladder would
   have changed levels the Commander already earned. The fork's other half — should a LEVEL ever be recomputed
   from capability — is deliberately still unbuilt, and still Andrew's call.
2. ~~Whether RELIABILITY (S2) belongs on the always-visible surfaces or only in the dossier.~~ **Decided:**
   dossier-only. It is a number that can look bad, and the always-visible chrome is not where an honest bad
   number belongs. PRACTICE (S5) sits in the same place for the same reason.
3. **Still open:** finding 5 — stats are folded in the browser, so a Telegram-only Commander levels nothing
   until they open the app. The return ritual back-fills, which is the right design; the dependency is real.
