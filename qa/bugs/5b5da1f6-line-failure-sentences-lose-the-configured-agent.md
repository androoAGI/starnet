---
fingerprint: 5b5da1f6
slug: line-failure-sentences-lose-the-configured-agent
title: Line failure sentences lose the configured agent name
surface: autonomy
severity: P2
status: fixed
found: 2026-11-03
lane: agent/batch3-runtime-fixtures-1103
fix: fb33da958e1b8998a661e793d8a5f0a0aa44129a
origin: audit
---

# Line failure sentences lose the configured agent name

## Symptom

After shared LineRunner integration, a failed trigger stage is described by its internal agent ID even when the station knows its display name.

## Repro

Run test/trigger-sweep.test.js: the actual trigger runner settles a failed agent-a stage with the configured display name NOVA. The error sentence must name NOVA while the recorded agent identity remains agent-a.

## Evidence

The saved original LineRunner and trigger/handoff constructors fail 1 of 48 assertions against the updated canonical-sentence fixture; current source passes all 48. The separate OUTBOX fixture now supplies the actual required walk receipt. Other focused checks pass: loop-unapproved 56, line-runner 178, line-jobs invariant 122, publication 29, handoff 114 and census 10. Saved originals and loader: batch3-line-label-original.json and batch3-line-label-control.cjs; receipts batch3-root-focused-02.log. Independent review confirmed that only synthesized display sentences use names; canonical IDs, explicit stop authority, outcomes and persistence order stay intact.

## Verdict

Source-fixed in fb33da958e1b8998a661e793d8a5f0a0aa44129a. The shared job book accepts the existing label resolver, with host and standalone trigger/handoff wiring. Combined candidate gates and installed verification remain separate. The focused law queue initially invoked a nonexistent test filename; the corrected payload.budget test passed 25 and boot-limit passed 293, recorded in batch3-root-laws.log.
