---
fingerprint: c5dc6017
slug: a-crash-between-start-fresh-s-two-renames-brings
title: A crash between START FRESH's two renames brings an erased station back
surface: onboarding
severity: P2
status: fixed
found: 2026-11-03
lane: agent/station-lifecycle-record-1031
fix: d7bdf9eaa
origin: audit
---

# A crash between START FRESH's two renames brings an erased station back

## Symptom

A process killed at the wrong moment of START FRESH (a power cut, a hard kill, a crash) brings back the station the Commander erased or set aside. The next start says "this workspace was reset again after START FRESH was requested. Nothing was moved", although everything was moved. The start after that imports the erased station from the old install folder. An explicit recovery killed the same way comes back without its erase authority, and leaves its stage behind.

## Repro

1. On 206ecd44a, take an ERASE generation whose marker acknowledges a legacy root holding an old station, and take a START FRESH request (`requestFresh`).
2. Run `applyPendingRecovery` in a child process whose fs ends the process at the rename of the stage onto the workspace, after the live generation has gone to the shelf.
3. Boot as index.js does, twice, with automatic recovery on.

`node test/activation-crash-window.test.js` reproduces it at 206ecd44a for every step of both activations. Its explicit-recovery rows reproduce it at trunk b14923ca2 too.

## Evidence

- At 206ecd44a, `activateGeneration` (sidecar/workspace-recovery.js) renamed the live generation to the shelf, then the stage into place. Nothing durable said an activation was under way. The next boot's `applyFreshRequest` compared the request's pins against a workspace that no longer existed and refused it with FRESH_REQUEST_MARKER_CHANGED. It orphaned the stage, and the boot created an empty workspace with no seal, no record and no marker.
- The erase authority survived only in the set-aside generation, which derive reads only through a marker's quarantine field, and none existed.
- On a power loss the desktop shell's first-run migration (main.rs `migrate_workspace_data`) runs before any sidecar, into the unsealed root, and imports the legacy station itself.
- Correctness reviewer's probes against 206ecd44a: probe-crash-window.cjs gives "boot1 apply: ok:false, FRESH_REQUEST_MARKER_CHANGED, 'Nothing was moved'", "boot1 record: state none, eraseAuthority false, ack 0", "boot1 seal present? false | stage left: 1" and "boot2 auto recovery: applied:true, stationName ERASED-OLD-STATION". probe-crash-recovery.cjs gives "record after the redo: state active, eraseAuthority false" and "stage left: 1".
- A crash after the second rename, before the request was removed, had the same false "Nothing was moved" refusal. So did a request file that could not be removed. When both renames failed (stranded), the stage was deleted with the facts in it.

## Verdict

Fixed by d7bdf9eaa. The request file carries an activation journal, in two atomic steps. The first names the stage and where the live generation goes, before the stage exists. The second adds `ready`, the stage record's hash and the result to report, before the first rename.

Every boot settles a journaled activation first, before any stale check (`resumeActivation`). A stage that never got past its first rename is dropped and the request runs as usual. A stage that took its place is finished. A missing workspace gets the stage. A workspace that appeared after the first rename is set aside too: the shell's import, or an empty sealed folder. A station that no migration receipt accounts for stays, and the request ends there with an honest message.

When neither generation will take the name, the stage's files are written in place, so a stuck rename can never leave an unsealed workspace or a request nothing can get past. Explicit recovery shares all of it.

`test/activation-crash-window.test.js` kills a real child process at every step of both activations, and again with the shell's migration running first. In every case the next boot lands the generation that was asked for, sealed, with its erase authority and acknowledged roots kept. The old generation is byte-identical on the shelf, no stage is left, nothing reports a failure, and automatic recovery stays blocked.

The native door (src-tauri/src/fresh_start.rs) has the same two-rename window. It has no durable request to finish from, and this lane leaves it as it was.

Not verified on an installed build: the proof is real files and a real killed process on Windows.
