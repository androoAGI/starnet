---
fingerprint: b6f04205
slug: repeated-promises-without-tool-actions-can-end-w
title: Repeated promises without tool actions can end with done and no blocker explanation
surface: autonomy
severity: P1
status: open
found: 2026-09-16
lane: agent/recall-report-0916
fix:
origin: customer
report: Anonymized customer complaint relayed by owner in local task on 2026-09-16
affected: Customer version model and platform unknown; investigated source 87e10e1fe on Windows
family: premature-stops
installer: unverified
recovery: unconfirmed
---

# Repeated promises without tool actions can end with done and no blocker explanation

## Symptom

A customer reports agents starting tasks and repeatedly stopping without explanation, requiring further prompting. The investigation reproduced a provider repeatedly promising action while the host closes the run without any tool action or blocker explanation. The customer's particular transcript/model/build remains unknown.

## Repro

1. Boot the seeded app with `node dev/seed.js --keep` in an isolated worktree and use a local OpenAI-compatible provider advertising tool support.
2. Have the provider return `I'll work on that.` with finish reason `stop` for every model call, without tool calls.
3. POST authenticated `/api/run` with `isTask:true`, a fresh stream, and `Please inspect the station and report what you find.`
4. Observe the continuation nudge, repeated promise, zero tool actions, and final `agent.run.end` with `reason:done` and no blocker explanation.

## Evidence

Source `87e10e1fe`, Windows, 2026-09-16. Local reproducer and receipts: `.dogfood/recall-report/{probe.cjs,result.json,boot.log}` in `agent/recall-report-0916`.

Live run `b5ff8efa-470a-4f18-b592-f55afba7f7d6`: two provider calls, each offered 88 tools, both emitted `I'll work on that.`. The second provider request contained one `<continuation>` nudge. The event stream emitted `iteration.refunded {reason:duplicate,refundsUsed:1}` and ended with `{reason:done,turns:1,completionVerdict:not_assessed,effectVerdict:no_observed_effects}`. It emitted no tool calls or run error.

The duplicate-response path affects this exact fixture. A separate existing baseline test already establishes the varied-announcement path: `test/continuation-guard.test.js:77` expects a narrate-forever run to terminate `done` after the two-nudge budget. Relevant production anchors: `sidecar/loop.js:587` defines the budget; line 1351 guards announcement retries; line 1453 returns done for remaining nonempty output.

The backend DOES retain `no_observed_effects` and `not_assessed`; this finding does not claim those fields assert successful completion or that the UI showed a success badge. It concerns the run ending without carrying out the requested work or explaining why. No commercial model quality or installed UI was tested.

## Verdict

Open. Preserve bounded retries, but handle repeated/exhausted announcements as incomplete work with an explicit reason. Verify duplicate/grace behavior as well as ordinary nudge exhaustion. A model stop alone cannot establish task fulfillment.

## Regression

Baseline `test/continuation-guard.test.js` passes (28 assertions) and explicitly accepts the varied-announcement behavior. No source fix, full gate, installer proof, or customer recovery is claimed.


## Sibling coverage

Follow-up coverage needed: all provider finish-reason adapters; duplicate replies and varied repeated announcements; continuation/grace exhaustion; task-brief lifecycle; error/cancel/output-limit endings; COMMS, Telegram/Discord and durable run history; restart/recovery. Only seeded HTTP and the unchanged standalone continuation suite were exercised. No UI behavior was verified.
