---
fingerprint: 9da39e64
slug: one-ask-command-is-approved-twice-the-post-taint
title: One ASK command is approved twice: the post-taint card opens before the Task Brief holds the call
surface: safecell
severity: P1
status: fixed
found: 2026-10-30
lane: authority-census-1030
fix: 81b9bae81
origin: audit
---

# One ASK command is approved twice: the post-taint card opens before the Task Brief holds the call

## Symptom

In ASK mode, with outside content in the run's context (an attachment, a fetched page), the agent asks to run a command. The Commander clicks Approve once on the card. The result says "not run yet — waiting on the task brief". The agent settles its brief, asks for the identical command again, and the Commander has to approve the same command a second time. The first approval did nothing.

## Repro

1. Seed an ASK agent and place a WORKBENCH.
2. Send a COMMS task with a file attached (the run is tainted from its first turn), so a Task Brief is prepared and not yet settled.
3. Have the model call shell_exec first. A post-taint approval card opens. Approve once.
4. The call returns the held stamp (not run yet — waiting on the task brief). The model calls brief_proceed, then makes the identical shell_exec call.
5. A second approval card opens for the same command.
`test/ask-brief-before-approval.e2e.test.js` drives exactly this through the real sidecar with a scripted provider.

## Evidence

Live walk W-A1 (C:/Users/andro/gen-trees/_logs/walk-evidence-0142): W-A1-b2 run dc6b2392-956d-49b3-9d39-bd56e9652c0c, W-A1-b3 8a949c1a-6243-4e52-b80c-746f1d845ceb and W-A1-c e33f7df9-e0e1-4a63-bfe8-59b32846a701 show two approval cards with identical parsed arguments around one held result; W-A1-a and W-A1-b show the same held-first card with changed arguments on the retry. Causal trace: C:/Users/andro/gen-trees/_logs/reliability-coordination-codex-1029/a5-ask-double-approval-trace.json. Cause: in `sidecar/index.js` dispatch the post-taint confirmation (`if (postTaint.needsConfirmation)`) was awaited before `TaskBriefPolicy.canMutate`, and the held return dropped the dispatch-local one-shot. On 748b0462595 `test/ask-brief-before-approval.e2e.test.js` records two shell.exec cards for one executed command.

## Verdict

Fixed in 81b9bae81 (authority-census lane). dispatch now asks the deterministic Task Brief gate (`briefHoldFor`) before it opens a post-taint card. A call the brief will hold is held with no card, and the settled retry asks once. That card approves only that one prepared call: no answer is carried to a later call. The e2e test shows one card, opened after the held call, and the command runs once. The live ASK walkthrough has not been re-run on an installed build.
