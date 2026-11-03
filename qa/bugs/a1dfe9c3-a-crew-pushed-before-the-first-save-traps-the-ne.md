---
fingerprint: a1dfe9c3
slug: a-crew-pushed-before-the-first-save-traps-the-ne
title: A crew pushed before the first save traps the next boot in Recovery Mode
surface: onboarding
severity: P2
status: fixed
found: 2026-11-03
lane: agent/station-lifecycle-record-1031
fix: ff173210e
origin: audit
---

# A crew pushed before the first save traps the next boot in Recovery Mode

## Symptom

A WAKE cut short in its first second or so (the app killed, a crash, a power cut), or a browser window that still holds a station from before ERASE EVERYTHING or START FRESH, leaves a roster file behind with no station. The next start shows PRIOR STATION DATA FOUND with nothing to recover. After an ERASE, the station record also flips from erased to active.

## Repro

1. On 206ecd44a (or trunk b14923ca2), boot a sidecar on an empty workspace. Send WAKE's lock-downs, then `POST /api/roster` exactly as the page's `pushRoster` sends it, then kill the sidecar before any save lands. Boot again: `GET /api/lineage` says onboardingAllowed false, with current-workspace evidence `agent.roster.json`.
2. Or boot a native ERASE generation (`.migrated` plus the erase marker). `POST /api/save` with a copy founded before the erase, which is refused with reset:true, then `POST /api/roster` from the same window, which answers 200 ok. Restart: onboardingAllowed false, and the record says active.

`node test/stationless-boot-census.http.test.js` (its client-route row), `node test/erase-then-restart.http.test.js` (the window from before the erase) and `node test/station-marker-matrix.http.test.js` (WAKE's order, in every reset dialect) each reproduce it at 206ecd44a.

## Evidence

- frontend/app/app.js enterGame calls `pushRoster()` (4083), which POSTs at once. The first save goes through CloudSave, which debounces it by 1200 ms (frontend/app/cloudsave.js 21 and 521). A page closed cleanly still sends that save by beacon, so this takes a crash or a kill.
- At 206ecd44a, sidecar/index.js handleRoster wrote `agent.roster.json` through `saveAgentRoster` with no station check, and the reset seed rule that refuses `/api/save` does not apply to it. `saveAgentRoster` is the file's one write path. Eight other callers reach it too: the permission card's Full Access answer, the no-page `/model`, `/yolo` and `/personality` controls, agent delete, config import and reset, and a channel's `/model`.
- A roster file is hard proof of a station (sidecar/station-record.js HARD_PROOF, P1), so the record cannot discount it, and ensure() promotes the workspace to active. An older build's gate reads it as a station too.
- Spec reviewer's probes (review-r1-spec/probes/probe-wake-roster.cjs and probe-stale-roster.cjs) against the real sidecar at 206ecd44a: "after the crash {allowed:false, prior:true, evidence: current-workspace [... agent.roster.json ...], station: active}", and "next boot {allowed:false, evidence: [current-workspace:agent.roster.json], station: active}".
- `test/stationless-boot-census.http.test.js` at 206ecd44a: "WAKE's crew push is taken and held, not written" fails, "no roster file: before a founding nothing writes hard proof, whichever route asked" fails, and the restart after the routes fails "the workspace still onboards".

## Verdict

Fixed by ff173210e. Before a station is founded the crew is held, not written. `saveAgentRoster` asks the live station record first. While there is no station, the roster goes to the live roster only, which is what runs and delegation read, and the anti-clobber stamp moves as usual. The founding save (savestore's onFounded) then writes it, and a write that fails stays held for the next save. `POST /api/roster` answers `held: true` while the crew is held. Every writer goes through that one path, so the gate covers them all. `test/station-record-readers.test.js` pins the one write path and its order.

`test/stationless-boot-census.http.test.js` sends every roster writer before a founding and finds no roster file, and the restart onboards. Its founding row shows the founding save writing the held crew with its stamp. `test/erase-then-restart.http.test.js` keeps a window from before the erase open across the restart, and the erase holds. `test/station-marker-matrix.http.test.js` runs WAKE's order in every reset dialect.

Consequence: on a workspace no station was ever founded on, a crew pushed through the API alone no longer survives a restart (the page and the terminal both found a station first). Tests that modelled that seed a founded station now (test/helpers/station.js).

Not verified on an installed build: the proof is the real sidecar on Windows.
