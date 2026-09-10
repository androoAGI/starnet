---
fingerprint: 408a0794
slug: group-conversion-loses-attachments
title: Adding a participant to a direct conversation discards its existing attachments
surface: sessions
severity: P1
status: fixed
found: 2026-09-10
lane: agent/adversarial-audit-0910
fix: 64ed8711b
origin: audit
---
# Adding a participant to a direct conversation discards its existing attachments

## Symptom

P1: Add agents converts a direct conversation to a group but silently removes every existing message attachment from the conversation. The file links disappear, the group's shared-file inventory is empty, and the saved direct history is overwritten without the attachment references. The original bytes remain in the lead's workspace, but the product no longer exposes them through that conversation.

## Repro

1. Recruit a second participant in a disposable seeded station.
2. In a direct NOVA conversation attach conversion-proof.txt and send 'Keep this document available for everyone who joins this conversation.'
3. Verify COMMS displays the file link. Wait for the run to finish.
4. Click Add agents, add QA TESTER, and choose START GROUP CHAT.
5. The conversation now has two participants and its text, but no file link or shared artifact. GET /api/groups?id=<same-stream-id> reports artifacts:[]; GET /api/save shows zero attachment references in that workstream.
6. Reload and restart the sidecar with --keep: the attachment remains absent from the conversation.

A reproducible HTTP equivalent is dev/audit-conversion.cjs, which uploads real bytes then submits the same history shape as the picker.

## Evidence

Audited source: 2aa8305c0. qa/evidence/adversarial-0910/restart-receipt.json records one beforeAttachments entry, afterHistoryAttachmentCount:0, afterGroupArtifactCount:0, and originalFileStillOnDisk:true. The live picker says everyone sees the conversation and its shared files. The direct link was observed before conversion; the group rendering showed only two text messages afterward.

Root cause: frontend/app/group-chat.js:405 sends origin.history but does not migrate its attachments. sidecar/group-sessions.js:76 initializes artifacts:[] and sidecar/group-sessions.js:78 imports only author/text with imported:true, dropping m.attachments. frontend/app/group-chat.js:32 then replaces ws.history from that reduced group transcript, discarding the original references in the durable save. Related fixed record de0bb232 covers files sent within an existing group, not direct-to-group conversion.

## Regression

Existing test/group-sessions.test.js and test/group-sessions.edge.test.js both pass. Neither establishes preservation of an attachment-bearing direct history through conversion. No repair applied.

## Fix direction

Migrate attachment bytes and message associations transactionally before committing conversion, preserving author, timestamp and original history until read-back succeeds. Refuse with a recoverable explanation if any source file is unavailable. Cover images, documents, mixed authors, large histories, interrupted conversion and repeated conversion requests.

## Repair verification — 2026-09-10

Source fix: 64ed8711b. Conversion reads and snapshots every referenced file before atomically creating the group, preserving message-file associations, timestamps and the entire historical transcript. Missing/unreadable files refuse conversion without creating a partial group. The UI passes a conversion retry key and preserves artifact associations in its saved projection. test/group-message-attachments.test.js covers 125-message conversion, repeated references, exact bytes, missing-file rollback, idempotent retry and restart alongside existing upload/send/fork isolation cases. Live Add agents > QA TESTER > START GROUP CHAT retained the original attachment button; opening it displayed LIVE_CONVERSION_FILE_BYTES, also served unchanged after a sidecar restart.

Sanitized post-restart receipt: qa/evidence/adversarial-0910/fixed-restart-receipt.json. Full integration gates are recorded in the follow-up report; installed desktop execution is not verified by this seeded-browser proof.
