---
fingerprint: 31db37b0
slug: every-install-update-attempt-writes-another-full
title: Every INSTALL UPDATE attempt writes another full-station backup to update-snapshots and nothing ever prunes them
surface: release
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/release
fix: 0d456f194
origin: audit
---

# Every INSTALL UPDATE attempt writes another full-station backup to update-snapshots and nothing ever prunes them

## Symptom

Each INSTALL UPDATE click freezes the station and writes a complete station backup (`pre-<version>-<id>.starnet-backup.json`, chmod read-only) into the `update-snapshots` folder next to the workspaces. A failed install (signature refused, download dropped) cancels the freeze but keeps the backup, and a retry writes another one. Nothing anywhere prunes the folder, so every update and every retry adds a full copy of the station forever. This machine has already run its disk to zero once (2026-10-07).

## Repro

1. Boot the sidecar on a populated workspace.
2. `POST /api/update/prepare {targetVersion:'0.13.6', browserStore:{...}}` then `POST /api/update/cancel` (what the Update Center does when the native install fails), five times.
3. List `<parent of workspaces>/update-snapshots`.

## Evidence

`sidecar/update-preparation.js:88` writes `path.join(path.dirname(workspaceRoot), 'update-snapshots')` plus a `pre-...starnet-backup.json` on every prepare; a repo-wide grep for `update-snapshots` finds only that writer, the lineage reader (`sidecar/workspace-lineage.js:83`), erase-all and recovery listing, and no retention.

Live (lane scratch `release/interrupt/result.json`, HEAD sidecar on port 9791): workspace 89,708 bytes; after 5 prepare/cancel cycles `update-snapshots` held 5 backups totalling 468,294 bytes (plus 5 receipts), each about 1.04x the workspace, files mode `-r--r--r--`. The fail-closed behaviour itself is correct: a mutation during the freeze returns HTTP 423 `UPDATE_MUTATIONS_FROZEN`, cancel unfreezes, and a hard kill while frozen or mid-prepare relaunches unfrozen with writes accepted and no partial files.

_Found by the `sweep/release` lane, 2026-10-20._

## Verdict

Fixed in `0d456f194` (2026-10-23; an ancestor of trunk, first released in v0.14.0). After a verified prepare and once at boot, `update-snapshots` keeps only the three newest pre-update bundles with their receipts (`sidecar/update-preparation.js` pruneSnapshots, KEEP_SNAPSHOTS = 3): the bundle a prepare just verified, or the live receipt's, is never removed; read-only files are made writable first; only `pre-*.starnet-backup.json` and its `.receipt.json` are ever touched; a file that cannot be removed is reported (failNote `update.snapshots.prune`) and never fails the update. Regression: test/update-snapshot-prune.test.js (passes on this tree) and test/update-preparation.http.test.js. Reconciled 2026-10-27 (reliability wave 1, quick win 37).
