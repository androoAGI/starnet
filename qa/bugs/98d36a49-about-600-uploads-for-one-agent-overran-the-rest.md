---
fingerprint: 98d36a49
slug: about-600-uploads-for-one-agent-overran-the-rest
title: About 600 uploads for one agent overran the restore-point search and the forget ledger never settled
surface: sessions
severity: P2
status: fixed
found: 2026-11-07
lane: release-0150
fix: b53565c2987ee82a773f3ccac4ceb28a0c38b952
origin: audit
---

# About 600 uploads for one agent overran the restore-point search and the forget ledger never settled

## Symptom

Deleting chats that named about 600 or more uploads for one agent on Windows removed the files but left the delete unfinished: the forget ledger never settled, the failure repeated at every retry, and a restore point that still held an upload was not replaced.

## Repro

1. Run `node test/checkpoint-attachments.test.js`: call `forgetAttachments` with 1000 upload paths on a real shadow repo.
2. Before the fix, every path went on one `git log` command line in `sidecar/checkpoint-store.js`. Windows refuses it near 32 KB, so the search failed and the store threw "could not be searched".

## Evidence

- Final review, real store with real git: 580 paths pass, 620 throw `spawn ENAMETOOLONG`. That probe used a test-style runner; the store throws on any non-zero result from the runner.
- `test/checkpoint-attachments.test.js` is red without the fix, and passes on b53565c29 with 39 assertions, including a held path in the last batch.

## Verdict

forgetAttachments now searches in batches under 6000 characters each, the way exactEntries does. Unchanged and recorded for later: a corrupt shadow repo still fails the entry at every retry. The other entries run and the uploads have gone by then; only the ledger stays open.
