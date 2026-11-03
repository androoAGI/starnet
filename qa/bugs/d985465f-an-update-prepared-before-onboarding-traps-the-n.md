---
fingerprint: d985465f
slug: an-update-prepared-before-onboarding-traps-the-n
title: An update prepared before onboarding traps the next boot in Recovery Mode
surface: onboarding
severity: P2
status: fixed
found: 2026-10-31
lane: agent/station-lifecycle-record-1031
fix: cb8d67536
origin: audit
---

# An update prepared before onboarding traps the next boot in Recovery Mode

## Symptom

If an in-app update is prepared on a workspace that has no station yet, the next launch opens on PRIOR STATION DATA FOUND (Recovery Mode) with nothing to recover. The recovery point made for the update is itself the only "prior station" there is. This is latent today: the Update Center lives on the station floor, so a person cannot reach it before onboarding, but `POST /api/update/prepare` accepts the request.

## Repro

1. Start from an empty workspace in a sandboxed profile, on trunk b14923ca2.
2. Boot the sidecar and `POST /api/update/prepare` with `{"targetVersion":"9.9.9"}` and no station-save journal in `browserStore`.
3. It answers 200 ok, and `update-snapshots` now holds `pre-9.9.9-<id>.starnet-backup.json` and its `.receipt.json`.
4. `POST /api/update/cancel`, stop the sidecar, boot it again and `GET /api/lineage`: onboardingAllowed is false, with evidence kind `update-snapshot`.

`node test/stationless-boot-census.http.test.js` reproduces it against b14923ca2, in its UPDATE ROW.

## Evidence

- At b14923ca2, `prepare()` in sidecar/update-preparation.js (line 132) always ran `recovery.capture` (line 163) and wrote the bundle, whatever the workspace held.
- inspectWorkspaceLineage counts any `*.starnet-backup.json` in `update-snapshots` as prior-station evidence, so the bundle gates the next boot. Every build reads it this way, older ones included.
- Planner probe probe-stationless-update.cjs: prepare returns 200 ok, and after the restart onboardingAllowed is false with evidence update-snapshot:1.
- `test/stationless-boot-census.http.test.js` against b14923ca2 gives 18 problems. For this bug: "nothing was written to update-snapshots: no recovery bundle, no receipt file — expected [], got [pre-9.9.9-<id>.starnet-backup.json, pre-9.9.9-<id>.starnet-backup.json.receipt.json]".
- The bundle alone is enough. With only the `holdsStationData` wiring removed from sidecar/index.js at 4d91b4af8, so that every other fix stays in place, the restart row fails with the single evidence row `update-snapshot`.

## Verdict

Fixed by cb8d67536 (lane station-lifecycle-record, step 3). A prepare skips its bundle only when there is nothing to protect, which takes both of these:
- the host's holdsStationData() is false: no founded station, no save or roster, and nothing the frozen fallback calls station state;
- the page's browser store holds no station-save journal (a `starnet.save` or `starnet.save.<...>` key with a value, or the pre-rename `skynet.` spelling).

It then writes no bundle and no receipt file, and answers with an in-memory receipt `{ station:'none', snapshot:null }` under the same barrier. frontend/app/updates.js needs only a truthy receipt, and nothing reads a snapshot from it.

A journal, station data, a host that injects no check, or a check that cannot answer always captures. `test/update-preparation.http.test.js` proves that a station-less page journal and station-less data on disk each still get a real bundle, and `test/update-preparation.test.js` proves each reason to capture.

Not covered: files outside the frozen fallback on a station-less workspace do not count as data to protect, such as what an older sidecar START FRESH left live (agent/, transcript-history-v2/). The planned whole-generation START FRESH (step 4) sets those aside.
