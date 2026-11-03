---
fingerprint: d2a917eb
slug: an-armed-night-shift-traps-a-fresh-install-in-re
title: An armed night shift traps a fresh install in Recovery Mode after one station-less session
surface: onboarding
severity: P1
status: fixed
found: 2026-10-31
lane: agent/station-lifecycle-record-1031
fix: 7c30dd9e3
origin: audit
---

# An armed night shift traps a fresh install in Recovery Mode after one station-less session

## Symptom

With the night shift armed, a fresh install that is opened and closed once, before anyone onboards, opens on PRIOR STATION DATA FOUND (Recovery Mode) at the next launch with nothing to recover. START FRESH holds only until the next session writes the same file again. The same trap follows a WAKE cut short between its lock-down routes and its first save, and any other station-scoped file a station-less writer leaves behind.

## Repro

1. Start from an empty workspace in a sandboxed profile, on trunk b14923ca2.
2. Boot the sidecar with `SKYNET_NIGHTSHIFT_ENABLED=1`, `SKYNET_NIGHTSHIFT_TICK_MS=1000` and `SKYNET_NIGHTSHIFT_AWAY_MS=1`, with the quest refresh on (its default).
3. Wait about 9 s, send the quit-path `POST /api/halt`, and stop the sidecar.
4. Boot it again and `GET /api/lineage`: onboardingAllowed is false, and the evidence is current-workspace [autonomy.ledger.jsonl].

`node test/stationless-boot-census.http.test.js` reproduces it against b14923ca2.

## Evidence

- The night shift's first tick writes a decline row (`{source:'nightshift',kind:'decline',binding:'posture'}`) to autonomy.ledger.jsonl on a station-less workspace, with both the fast and the default away threshold (planner probe probe-which-scheduler.cjs).
- At b14923ca2 the gate's evidence allowlist (STATE_EVIDENCE, sidecar/workspace-lineage.js:22 before the move) lists autonomy.ledger in its .jsonl family, so that one row gates onboarding.
- The #123 gate on the quest refresh read the same regex (`if (!hasStationState({ fs, path, workspaceRoot: WORKSPACES })) return;`, sidecar/index.js:10933). The ledger row turned it back on, and _station.questrefresh.json was written by cascade.
- `test/stationless-boot-census.http.test.js` against b14923ca2 gives 7 problems:
  - "the quest-refresh boot look writes nothing on a station-less workspace" (it wrote one);
  - the restart after the armed session is gated on autonomy.ledger.jsonl;
  - the restart after WAKE's pre-save routes is gated on 13 files. `POST /api/memory/reset` alone wrote agent.declined/minted/notebook/pending/todo, and the scout, dossier, goals and posture routes wrote the rest;
  - the restart with scout.state.json, _commander.autonomy.json, cron.jobs.json, loops.json, nightfocus.state.json, personalization.json and autonomy.ledger.jsonl planted is gated;
  - the record field is missing on each restart.

## Verdict

Fixed by 7c30dd9e3 (lane station-lifecycle-record, step 2). The gate now counts the current workspace by its station record, through `sidecar/station-record.js` read():
- a save or roster file is always a station (P1);
- the record decides soft bookkeeping, whoever writes it;
- ensure() records a station-less workspace as none at its first boot, and only the station file's first accepted save founds it.

The quest refresh asks the same live record. `test/stationless-boot-census.http.test.js` passes at 717919a82 (34 assertions, 28 s).

The night-shift tick's own decline row is gone too, as of cb8d67536 (step 3): the tick stands down until a station is founded, so a downgrade to 0.14.x after a no-client session is no longer trapped either. `test/stationless-boot-census.http.test.js` proves it with its completeness census.

The client routes WAKE calls before its first save still write by design (Andrew decision 1). The soft files they leave no longer trap this build, because the record decides those. The one hard-proof write among them did trap it: WAKE's crew push wrote a roster file before the first save landed. ff173210e holds that crew until a station is founded (qa/bugs/a1dfe9c3-a-crew-pushed-before-the-first-save-traps-the-ne.md). What remains is downgrade-only: if WAKE dies before its first save and the Commander then goes back to 0.14.x, that build reads the soft files as a station, as it always did.
