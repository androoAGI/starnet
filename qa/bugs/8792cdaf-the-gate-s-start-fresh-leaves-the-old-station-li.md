---
fingerprint: 8792cdaf
slug: the-gate-s-start-fresh-leaves-the-old-station-li
title: The gate's START FRESH leaves the old station live
surface: onboarding
severity: P1
status: fixed
found: 2026-11-02
lane: agent/station-lifecycle-record-1031
fix: 65944dc92
origin: audit
---

# The gate's START FRESH leaves the old station live

## Symptom

START FRESH on PRIOR STATION DATA FOUND says the old station was set aside and opens a new one. But the new station still holds most of the old one: the old agent folders, past chats, channel bot configs, checkpoints, line jobs and spend, the voice cache and the station browser's profile. The "fresh" station starts on top of them. The marker it writes also drops an earlier ERASE EVERYTHING's authority, so whether an erase survives a later START FRESH depends on which door ran.

## Repro

1. Start from a copy of a real 0.14.x workspace layout in a sandboxed profile, on trunk b14923ca2, with its save removed so the gate fires.
2. Boot the sidecar and `POST /api/lineage/start-fresh`. It answers 202 and exits 75.
3. Boot again and list the workspace: `agent/`, `channels/`, `.checkpoints/`, `transcript-history-v2/`, `.run-journal/`, `.spend-pending/`, `voice-cache/`, `.browser-profile/`, `line-spend.json` and `_away.briefing.json` are all still live.

`node test/start-fresh-generation.http.test.js` reproduces it against b14923ca2, in its WHOLE row.

## Evidence

- At b14923ca2, `startFresh` in sidecar/workspace-lineage.js moved only what `meaningfulEntries` matched, a file-name regex, one file at a time, inside the running sidecar. The native door in src-tauri/src/fresh_start.rs has always renamed the whole generation.
- Planner probe probe-sidecar-startfresh.cjs on a scratch copy of a real 0.14.x layout: 22 files moved and the gate opened, with the directories above and `line-jobs.json`, `verdict.packets.json`, `skill-evaluations.json`, `discovery.state.json` and `group-sessions.json` still live. The source sample was not touched.
- `test/start-fresh-generation.http.test.js` against b14923ca2 gives 47 problems. For example: "WHOLE: the live generation no longer holds transcript-history-v2/old-chat.jsonl — expected false, got true", the same for `channels/telegram.json` and `.browser-profile/Default/Cookies`, and "WHOLE: the mirror has the native marker's keys, in its order — expected [version, erased, at, ...], got [version, at, ...]".
- The same test at the tip: 80 assertions pass.

## Verdict

Fixed by 65944dc92 (lane station-lifecycle-record, step 4). START FRESH now means the whole generation, from either door.

- `POST /api/lineage/start-fresh` only takes a request, pinning the generation, the save and roster hashes, the marker's at and the build version. The sidecar exits 75 through the graceful path.
- The next boot sets the generation aside in `applyFreshRequest` (sidecar/workspace-recovery.js), in the locked pre-claim phase, with the activation explicit recovery uses: one rename into workspace-quarantine/station-<stamp>, in place of a stage holding SEAL, the station record, the legacy mirror and the carry rule's files.
- A request the workspace moved on from is refused, kept as `.failed-<stamp>`, and reported in `lineage.lastFresh`. A failed rename changes nothing, and the gate's button re-arms.

`test/start-fresh-generation.test.js` pins the exact live listing, the rollback, every stale-request guard and every carry row.

Workspace-held sign-ins, channel bots and connectors now leave with the station (Andrew decision 4), and the gate's confirm line says so. They stay restorable by hand from the quarantine folder, and OS-keychain credentials are untouched.

The native door's refusal over an unreadable account link is aligned in 90d7a17af, its own commit so it can be dropped.

Not verified on an installed build: the proof is the real sidecar on Windows here and Linux in CI, not a packaged desktop app.
