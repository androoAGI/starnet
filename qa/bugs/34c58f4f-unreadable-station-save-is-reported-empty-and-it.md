---
fingerprint: 34c58f4f
slug: unreadable-station-save-is-reported-empty-and-it
title: Unreadable station save is reported empty and its sole backup can be eclipsed
surface: onboarding
severity: P1
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: d9b6fba04
origin: audit
family: save-lifecycle
---

# Unreadable station save is reported empty and its sole backup can be eclipsed

## Symptom

A temporary file read failure makes an existing station appear empty. If only its backup remains, a new save can eclipse that backup and remain authoritative after restart.

## Repro

Run `node dev/reliability-save-proof.mjs` on the pre-fix source: the test-only host injects EACCES on one exact save path, retaining real file bytes. First deny primary reads and reconcile without a local cache; then move a separate save to its backup, deny backup reads, submit a replacement, unlock and restart. `test/save-unreadable.http.test.js` asserts the corrected HTTP contract. `test/save.test.js` covers missing and corrupt main files with a locked backup.

## Evidence

`qa/evidence/reliability-audit-0919/save-live-before.log`: primary GET 200/save:null, browser empty:true, backup replacement ok:true, restart name EMPTY REPLACEMENT. The final live receipt requires GET 503, SAVE-READ recovery screen after cache removal/reload, Retry restoring the station, denied replacement, and RETAIN ME after restart with a recovered notice.

## Verdict

Source repair preserves unreadable primary/backup authority, refuses replacement, exposes an explicit error and discloses missing-main backup recovery. Installer acceptance remains unverified.

The family is closed for every store (lane persist-module, 2026-11-03). The same hazard, a file that could not be read
treated as empty or as corrupt and then replaced, lived in the stores beside the station save. sidecar/persist owns the
read and the replace now: its tagged read (`sidecar/persist/read.js`) answers unreadable for any errno but ENOENT and
ENOTDIR, never empty and never corrupt, and its replace (`sidecar/persist/replace.js`) refuses with ESTORE_UNREADABLE
when the main, or a missing or bad main's `.bak`, cannot be read.

- Read side: the channel stores throw a typed ESTORE_UNREADABLE with the errno as its cause, instead of the raw errno
  (b1b0be499); the deliverables library refuses and caches nothing (record 06a5fb9e, d05241c24); a locked run journal
  is neither repaired nor moved aside (record c836f3f7, d05241c24).
- Write side: a torn main is kept as `.corrupt-<n>` before any replace, or the write is refused (record d50f704b:
  9d4f5ff13, b1b0be499, cb6ff28fa); a store whose boot read was locked keeps the bytes it never read as `.unseen-<n>`
  before its next blind save (record ca42c717: 9d4f5ff13).

Proof: `test/persist.conformance.test.js` (INV-4 and INV-5 for every store, each again with hard links failing six
ways) and `test/persist-seam.http.test.js` S3 (_commander.dossier.json locked at boot, through index.js), RED at
0b8441064 and GREEN at the lane tip. Installer acceptance remains unverified for these stores too.
