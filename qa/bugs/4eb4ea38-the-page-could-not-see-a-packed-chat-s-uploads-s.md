---
fingerprint: 4eb4ea38
slug: the-page-could-not-see-a-packed-chat-s-uploads-s
title: The page could not see a packed chat's uploads, so deleting it unopened kept the upload
surface: sessions
severity: P2
status: fixed
found: 2026-11-07
lane: release-0150
fix: b53565c2987ee82a773f3ccac4ceb28a0c38b952
origin: audit
---

# The page could not see a packed chat's uploads, so deleting it unopened kept the upload

## Symptom

A chat from before 0.15 that was deleted from the rail without being opened kept its upload for good, with no count and no log.

## Repro

1. Run `node test/workstreams-packed-uploads.test.js`: a row from before 0.15 names its file only in the packed run's residue, because 0.14 wrote no attachments to the transcript.
2. Seal the row, serialize the save and init from it, as a restart does. The row is not in `w.history` until it is read back.
3. Before the fix, `attachmentRefs` in `frontend/app/workstreams.js` answered `[]` for that session, so the delete posted no file.

## Evidence

- The late review (workflow wf_9a6a76fa-b8e, finding F2) found it. Background hydration narrows it, because an opened or hydrated chat holds its rows.
- `test/workstreams-packed-uploads.test.js` is red without the fix, and passes on b53565c29 with 22 assertions over both shipped trees.

## Verdict

attachmentRefs and attachmentInUse read only w.history. attachmentsOf now reads the residue of a packed run and of a stub as well; the station still proves each path before it removes one.
