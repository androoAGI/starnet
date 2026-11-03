---
fingerprint: c96c4d41
slug: a-meeseeks-helper-sprite-whose-terminal-task-eve
title: A Meeseeks helper sprite whose terminal `task` event is lost stays asserted LIVE forever — the ledger has no TTL, no snapshot reconcile, and no reset on NEW AGE
surface: world
severity: P1
status: fixed
found: 2026-07-28
lane: sweep/world
fix: meeseeks layer removed 2026-07-30 (agent/meeseeks-visual)
family: run-lifecycle
---

# A Meeseeks helper sprite whose terminal `task` event is lost stays asserted LIVE forever — the ledger has no TTL, no snapshot reconcile, and no reset on NEW AGE

## Symptom

A small spectral helper sprite keeps flickering next to the desk (and `World.dbg().helpers` keeps counting it) long after the background sub-agent finished or the sidecar restarted. After NEW AGENT, the previous Commander's helpers haunt the newborn's "fresh" station.

## Repro

1. Start a background sub-agent (any `team.dispatch`/subagent path) so a `task {kind:'subagent', status:'running'}` reaches the browser and a helper materializes. 2. Kill/restart the sidecar (or drop the SSE) while it is still running, so the terminal `task` frame is never delivered. 3. Reconnect — `fetchSnapshot()` clears the run clock and the work pose, but the helper sprite keeps drawing at full alpha and `World.dbg().helpers` still reports 1. 4. Second half: with a helper live, do NEW AGENT — `World.spawn()` wipes crew/economy/queues but the helper re-renders beside the newborn hero.

## Evidence

`frontend/app/world.js:5987`

**Mechanism (read from the code):** `subLedger` is the ONLY source of helper sprites (world.js:144, `SubagentSprites.makeLedger({cap:5})`) and its only writer is the `task` handler: `if (subLedger && t.kind === 'subagent') subLedger.fold(t, performance.now(), ...)` (world.js:5987). subagentsprites.js `prune(now)` only drops rows already in state `'dying'` (`if (r.state === 'dying' && now - r.diedAt >= DISSOLVE_MS)`), and `list()` renders any `'live'` row at `alpha = Math.min(1, (now - r.bornAt)/MATERIALIZE_MS)` = 1 forever. Every other paired state in this file got a lost-event net in the E2 pass — `sweepStaleStates` degrades `runStartByAgent`/`glyphByAgent`/`serverLit` after `RUN_TTL_MS` (world.js:4820-4856) and `reconcileFromSnapshot` authoritatively rebuilds runs, `inflightTools` and `serverLitAgents` (world.js:4880-4921) — but NEITHER touches `subLedger`, and `/api/state/snapshot` carries no sub-agent list (`{ ts, runs, prompts, summons, queues }`). The SSE stream emits no `id:` lines (`res.write('retry: 3000\n\n')`, sidecar/index.js:6602), so there is no Last-Event-ID replay — any `task` done/failed frame emitted while the socket is down is gone permanently. Finally `spawn()` — the block that exists precisely so "nothing from the previous agent haunts the newborn" — clears crew, occupiedSeats, floor, slaglog, convey, `chanQueues.clear(); serverLit.clear();` (world.js:760) and xp, but never calls `subLedger.clear()`; `drawMeeseeks` then falls back to `bodyForAgent(s.leadId) || agent` (world.js:4356), i.e. the NEW hero. The module's own header states the law it breaks: "a helper sprite exists IFF a real sub-agent is live".

**Existing test coverage:** test/subagentsprites.test.js — exercises the pure fold (materialize → dissolve → prune, cap/+N, revive-on-re-running, non-subagent events ignored). It passes vacuously here because every case hands the ledger its terminal event; there is no TTL/reconcile/reset concept in the ledger or the test. No test in test/ references `subLedger`, `drawMeeseeks`, or a lost subagent terminal event.

**Adversarial verdict (survived refutation):** Every leg checks out. frontend/app/world.js:5987 is the ONLY writer (`if (subLedger && t.kind === 'subagent') subLedger.fold(...)`); grep for `subLedger` returns only :144 (construction), :4340-4342 (drawMeeseeks prune/list), :5987 and :6204 (dbg). frontend/app/subagentsprites.js prune() drops only `r.state === 'dying'` rows and list() gives a 'live' row alpha `Math.min(1,(now-bornAt)/MATERIALIZE_MS)` = 1 forever — `clear()` exists and has zero callers. sweepStaleStates (world.js:4824-4856) and reconcileFromSnapshot (world.js:4880-4934) both touch runStartByAgent/liveRunsByAgent/glyphByAgent/serverLit/awaitPrompt/delegateLead and never the ledger. sidecar/index.js:7615 handleStateSnapshot emits exactly `{ts,runs,prompts,summons,queues}` — no subagent list, so normalizeSnapshot has nothing to reconcile against. spawn() (world.js:742-751) clears crew, occupiedSeats, floor, slaglog, convey, `chanQueues.clear(); serverLit.clear();`, xp and the one-shot beats — no subLedger.clear(), and enterGame calls World.spawn on every re-entry (app.js:2417). drawMeeseeks then does `bodyForAgent(s.leadId) || agent` (world.js:4345) and bodyForAgent (world.js:5356-5360) returns null for the dead lead id, so the orphan renders beside the NEW hero. Test surface: grep of test/ for subLedger/drawMeeseeks/SubagentSprites returns nothing; test/subagentsprites.test.js requires the module directly and every case hands the ledger its terminal event (`L.fold(ev('a','done'), 1000)`), so it cannot fail on a lost terminal. Server truth does exist at GET /api/subagents (stationui.js:4703 repaints LIVE HELPERS from it), but the world layer never consumes it — that mitigates severity, it does not refute the sprite leak. Not deliberate: the module header states the law this breaks ("a helper sprite exists IFF a real sub-agent is live").

_Found by the `sweep/world` lane, 2026-07-28. Finder confidence: high. Severity claimed P1, after refutation P1._

## Verdict

The finding was true (a trunk pass later added `subLedger.clear()` on spawn + a `/api/subagents` reconcile in
fetchSnapshot, closing the lost-event legs). Moot as of 2026-07-30: Andrew ordered the helper-sprite layer
removed outright — the flickering cyan follower read as floating garbage on his own station, and he flagged it
twice. world.js no longer constructs the ledger or draws any floating sub-agent marker; subagentsprites.js and
its test are deleted. Sub-agent observability lives solely in the LIVE HELPERS panel (server-truth
`/api/subagents`). Do not rebuild a follower sprite for this.

Family run-lifecycle (run-table lane S2, 2026-11-03): the family is "a lost terminal event leaves a view asserting LIVE". It is now closed at the source for every run the station drives. Each admitted run ends exactly once, on its own sink and on the station floor, including a run whose host threw (runOnce's belt) and a run stopped while queued. Class invariant: test/run-lifecycle.invariants.http.test.js (RED at 0b8441064: a thrown /v1 or Run Now run started on the floor and never ended). The reconnect snapshot reading the one run table follows in the lane's S3. No sprite is rebuilt. Status unchanged.

Registry coverage (run-table lane S3, 2026-11-03): the family's other half is a view that cannot see a live run, so its reconcile clears it while it works. The reconnect snapshot, the phone's status and its stop, STOP and steer by id, E-STOP, the process-fault quiesce and the update drain now read one run table, where every run the station drives sits from its admission until it ends. Class invariant: test/run-registry-coverage.http.test.js. It was RED at 0b8441064: a /v1 chat, a /v1/runs run and a dev-hub run held at the provider were in no snapshot source, and the phone's status missed them and a background worker. E-STOP ending /v1 was green at the base and is now locked there behaviourally. The matrix in test/run-lifecycle.invariants.http.test.js gains stop by id, E-STOP and a process fault per surface: each still ends exactly once, and the faulted chat is told it was the station's fault. Status unchanged.

Registry retirement (run-table S5, 2026-11-03): the host's old abort/metadata maps, host-live map and core counter are removed. Admission-owned callbacks preserve phone, review, group and manual-beat stops; loop admissions release after the physical context/model/check/snapshot tail, including thrown and no-launch paths. The unchanged physical-work registry matrix remains green (229 assertions after deleting obsolete legacy-superset diagnostics checks), as does the real lifecycle matrix (562). Held foreground-worker coverage was added before retirement. The table supplies snapshots, stop/steer, group eligibility and update-drain membership; per-chat ownership and subagent controllers remain with their owners. Central diagnostics now report the live count only. Final reader checks and census passed; full combined gates and installed/browser acceptance remain required. Historical fixed status is unchanged.

Final independent review found an inherited workshop setup escape: focus persistence could throw after admission but before the cleanup block. Setup now runs inside the existing failed-shift/claim-cleanup boundary. The actual workshop, focus, and resilient-store functions with real RunTable reproduced RED36/94 against the saved old function and GREEN94 after repair, including actual filesystem read/write faults, generic prompt/scan rejection contracts, and a held scan stopped with local or supplied signals. Ordinary project-scan errors are already caught by their production helper; its injected rejection is a cleanup contract, not a newly observed production trigger. Existing workshop HTTP92 and implement HTTP67, then the registry229 and lifecycle562 matrices and seven laws passed after this repair. Both required bounded source reviews are closed. Final claims lock and combined/installed acceptance remain owed.
