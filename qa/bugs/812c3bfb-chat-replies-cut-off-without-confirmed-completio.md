---
fingerprint: 812c3bfb
slug: chat-replies-cut-off-without-confirmed-completio
title: Chat replies cut off without confirmed completion
surface: channels
severity: P1
status: fixed
found: 2026-09-19
lane: agent/chat-cutoff-0919
fix: 93a4ee64c
origin: customer
report: Owner-relayed customer chat report on 2026-09-19; frequent cut-off replies even in new sessions
affected: Customer build, platform and provider unknown; browser defect reproduced on source acbf3c225 (package 0.12.3)
family: chat-response-completion
installer: unverified
recovery: unconfirmed
---

# Chat replies cut off without confirmed completion

## Symptom

A customer reports frequent cut-off agent replies despite starting new sessions. No example reply, model/provider, build, platform or diagnostic bundle was supplied. Investigation independently reproduced a COMMS failure mode with the same visible symptom; correlation to this customer's incidents remains unproved.

## Repro

1. In an isolated worktree with dependencies installed, run `node scripts/qa/chat-cutoff-investigate.mjs` (Node 22+, local Chromium, free ports 19419/19420).
2. The script boots `node dev/seed.js --keep`, opens the real station in headless Chromium and starts fresh task sessions through `Chat.send`.
3. At the browser fetch boundary only, inject `agent.run.start`, a mid-sentence `agent.token`, then clean EOF without `agent.run.end`. This is a controlled transport fixture, not an observed customer/network failure or real inference.
4. Before repair: EOF returns no error and no end reason; COMMS renders `RUN COMPLETE`, saves the partial text and emits `workitem.delivered`. After repair: EOF throws a transport interruption, COMMS preserves partial text plus a durable error, and emits no delivery.
5. Controls: a normal end is complete; `finishReason:length` shows `CUT SHORT` and emits no delivery. A complete final JSON end record without a trailing newline now retains the output-limit status too.

## Evidence

Source anchors: `frontend/app/harness.js:769` breaks on reader EOF, does not flush the final buffered record and returns success without requiring a matching run-end. `frontend/app/chat.js:8568` takes the non-error completion branch; `frontend/app/chat.js:8689` accepts a null end reason for delivery. The normal sidecar writer at `sidecar/index.js:14782` does append newlines; the no-newline fixture is defensive coverage, not evidence the host normally omits delimiters.

Sanitized live receipt: `qa/evidence/chat-cutoff-0919/investigation.json`. All four cases used the real browser Harness and COMMS in a seeded station. The missing-end case preserved `The answer stops in the middle of`, returned `endReason:null`, rendered `RUN COMPLETE`, and emitted one delivery. The output-limit control rendered `CUT SHORT` with zero deliveries.

Related policy: `sidecar/index.js:17251` disables semantic continuation for non-task, non-internal calls across providers. Ollama's defaults in `sidecar/providers/registry.js:513` are 4096 task tokens and 512 casual-chat tokens. General substantive prompts default to tasks; this is not a blanket 512-token cap on all chat or hosted providers. Starting a new session does not alter these per-response policies.

Focused checks passed: chat-prompt-diet HTTP (29 assertions), output-continuation (43), loop provider recovery (60), provider timeouts (53), OpenRouter adapter (89), and casual-response-safety HTTP (lead/worker, hosted/local, context, task promotion, restart). These existing checks pass despite the reproduced browser EOF defect.

## Verdict

Source-fixed in `93a4ee64c`. The browser requires a matching lead completion receipt, flushes the final buffered record, and cleans up its reader and lead metadata on interruption. A transport error after confirmed completion cannot undo that completion. COMMS retains partial output and the error, records an unsuccessful run, and arms the existing durable-journal recovery path on thrown transport failures as well as in-band failures. The transport reader never repeats inference or tools. Website mirrors are identical.

Original customer cause remains uncorrelated: no affected model, diagnostic bundle or example was supplied. This closes the reproduced source defect, not a claim of customer recovery or an installed release. Existing local-chat limits remain intentional and unchanged.

## Regression

The new `test/harness-stream-completion.test.js` executes the production browser functions in both desktop and website mirrors. It fails against the original harness (78 failed assertions in the initial 158-assertion comparison) and passes 188 assertions after the sweep: missing, malformed, foreign and internal completion; bytewise UTF-8; no final newline; explicit stop reasons; reader failure; post-completion connection loss; tool boundary; retained output; foreground/background failure and journal-recovery wiring.

`qa/evidence/chat-cutoff-0919/verification.json` records nine real Chromium COMMS scenarios after repair. Missing completion, worker-only completion and reader error retain partial text with no delivery; the error survives session switching and browser reload. Normal completion and trailing connection loss after a confirmed end deliver once. Length/filter/cancel remain non-deliveries. The existing real-host recovery API regression passes 37 assertions including crash/restart after a mutation, review-required refusal and no replay of that mutation. Customer journeys pass 36/36. Full merge-gate receipts are recorded in the lane digest.

## Sibling coverage

{"adapters":[{"target":"provider-to-sidecar transport","state":"covered","test":"test/loop.provider-recovery.test.js","scenario":"missing provider completion marker retries once and persistent truncation becomes error","gate":"fast"},{"target":"customer provider and model","state":"blocked","reason":"Provider/model and actual failing output were not supplied."}],"entrypoints":[{"target":"COMMS lead, delegated-worker and internal streams","state":"covered","test":"test/harness-stream-completion.test.js","scenario":"matching lead end, worker-only end, internal suppression and interruption","gate":"fast"}],"displays":[{"target":"desktop and website partial transcript and failure state","state":"covered","test":"test/harness-stream-completion.test.js","scenario":"production COMMS branch persists partial before error, marks unsuccessful and respects background focus","gate":"fast"},{"target":"installed desktop customer acceptance","state":"blocked","reason":"No installer rebuild or customer retest is part of this source merge."}],"lifecycle":[{"target":"interrupted browser recovery and byte-stream teardown","state":"covered","test":"test/harness-stream-completion.test.js","scenario":"EOF, malformed tail, reader error, cancellation, post-end drop and journal watch","gate":"fast"},{"target":"restart and safe continuation after an executed mutation","state":"covered","test":"test/run-recovery.api.test.js","scenario":"crash after mutation, needs-review refusal, operator review, replay blocked and consumed continuation refused","gate":"http"}]}
