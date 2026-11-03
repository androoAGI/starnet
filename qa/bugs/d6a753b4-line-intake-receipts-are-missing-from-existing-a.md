---
fingerprint: d6a753b4
slug: line-intake-receipts-are-missing-from-existing-a
title: Line intake receipts are missing from existing admission owners
surface: sessions
severity: P2
status: fixed
found: 2026-11-03
lane: line-intake-next-1103
fix: 11e714352
origin: audit
---

# Line intake receipts are missing from existing admission owners

## Symptom

Existing channel bindings, schedule records, webhook records and their admitted jobs do not retain which INBOX the existing routing decision selected. Readers cannot distinguish an observed direct binding from a line intake, and SEND TO jobs omit the selected target INBOX.

## Repro

Run test/line-intake-bindings.test.js and test/line-intake-bindings.http.test.js. The HTTP proof starts the actual fixture host with a synthetic provider, creates an armed line and bound channel, saves direct and line schedules, fires a webhook, runs sample/SEND TO, and reloads the durable records after restart. Compare exact job metadata through GET /api/line-jobs/:id; list summaries intentionally omit intake metadata. Unit cases also cover unarmed or changed floors, failed writes, preserved hard locks and exactly one picker decision per message.

## Evidence

gen-trees/_logs/codex-overnight-1103/line-intake-s2-original-expanded.log records 19 failed assertions out of 35 against the ten original modules captured from a9fe648b3; line-intake-s2-unit-expanded.log passes all 35. line-intake-s2-http-original.log records 12 failures out of 23 through the actual original host; line-intake-s2-http-expanded-final.log passes 23 with four expected synthetic generations. The first expanded SEND TO fixture mistakenly read a summary endpoint; its failure is preserved, the test was corrected to read exact job metadata, and no product fix is claimed for that fixture change. line-intake-s2-merged-affected.log passes all 33 affected files after merging ae7429714 at 089cde60f, including channel, triggers, job identity, workflow and source-integrity checks.

## Verdict

Source-fixed in 11e714352. Receipts are read-only observations in existing durable owners, derived after the existing routing choice; they neither route future work nor grant authority. Unknown or unarmed floors do not invent direct intent, script schedules remain unbound, explicit bot bindings remain hard locks, and SEND TO retains its actual selected intake. Final independent source review found no additional major in this S2 scope. The separate S3 withdrawal finding is fixed by ebded1422 and recorded as e5a46952; affected37-file proof remains green. This record does not claim combined integration, installed-app or live-account completion.
