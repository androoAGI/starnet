---
fingerprint: 5d8c7060
slug: a-torn-start-fresh-marker-refuses-every-save-of
title: A torn START FRESH marker refuses every save of a station founded after it
surface: sessions
severity: P1
status: fixed
found: 2026-10-31
lane: agent/station-lifecycle-record-1031
fix: 7c30dd9e3
origin: audit
---

# A torn START FRESH marker refuses every save of a station founded after it

## Symptom

When a workspace's .fresh-start.json is torn (a power loss or an antivirus truncation mid-write), the gate lets a new Commander onboard. Every save of the station they found is then refused as a pre-reset copy (reset:true): the station file is never written, the save light says the station was reset, and nothing in the app clears it.

## Repro

1. Start from a workspace whose `.fresh-start.json` is `{"version":1,"acknow`, on trunk b14923ca2.
2. Boot the sidecar. `GET /api/lineage` says onboardingAllowed true.
3. `POST /api/save` a station founded now (_saveRevision 0): `{ok:false, reset:true, recovery:'agent.save-conflict-<window>.json'}`.
4. Save again: refused the same way. No agent.save.json is ever written.

`node test/station-marker-matrix.http.test.js` reproduces it against b14923ca2: "torn marker: a station founded after the reset saves ({"ok":false,"stale":true,"conflict":true,"revision":0,...,"reset":true})".

## Evidence

- At b14923ca2, sidecar/savestore.js kept its own parser of the marker (resetReceiptAt, about line 265), which returned NaN for a receipt it could not parse.
- The seed rule then refused whenever that time was not finite: `function predatesReceipt(founded, at) { return at !== null && !(Number.isFinite(at) && Number.isFinite(founded) && founded > at); }`.
- The gate's own parser (readFreshMarker in sidecar/workspace-lineage.js) read the same torn marker as no marker, so the gate opened onto a station that could never save.
- Critic probe critique-risk/probe-torn-marker-seed.cjs: both saves were refused with reset:true, and no station file was written.
- `test/station-marker-matrix.http.test.js` against b14923ca2 gives 32 problems. In the torn row the first save, the next save and the save after a restart are all refused.

## Verdict

Fixed by 7c30dd9e3 (lane station-lifecycle-record, step 2).
- savestore.js no longer parses the marker. index.js injects the live station record's resetAt, and a store built without one asks `sidecar/station-record.js` read().
- The module's one parser reads a torn marker as reset {unreadable:true, at: <the time the record was derived>}. The boot that derived it bounds the reset, so a station founded after that boot saves, while a browser copy from before it is still refused.
- Automatic recovery stays blocked over the unreadable reset.

`test/station-marker-matrix.http.test.js` passes at 717919a82 (54 assertions). The torn row founds the record, saves twice, restarts and saves again, and still refuses the pre-boot copy.
