---
fingerprint: 812c3bfb
slug: chat-replies-cut-off-without-confirmed-completio
title: Chat replies cut off without confirmed completion
surface: channels
severity: P1
status: open
found: 2026-09-19
lane: agent/chat-cutoff-0919
fix:
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
4. Inspect `.dogfood/chat-cutoff/live.json`: EOF returns no error and no end reason; COMMS renders `RUN COMPLETE`, saves the partial text and emits `workitem.delivered`.
5. Controls: a normal end is complete; `finishReason:length` shows `CUT SHORT` and emits no delivery. A complete final JSON end record without a trailing newline is ignored, reproducing the false completion too.

## Evidence

Source anchors: `frontend/app/harness.js:769` breaks on reader EOF, does not flush the final buffered record and returns success without requiring a matching run-end. `frontend/app/chat.js:8568` takes the non-error completion branch; `frontend/app/chat.js:8689` accepts a null end reason for delivery. The normal sidecar writer at `sidecar/index.js:14782` does append newlines; the no-newline fixture is defensive coverage, not evidence the host normally omits delimiters.

Sanitized live receipt: `qa/evidence/chat-cutoff-0919/investigation.json`. All four cases used the real browser Harness and COMMS in a seeded station. The missing-end case preserved `The answer stops in the middle of`, returned `endReason:null`, rendered `RUN COMPLETE`, and emitted one delivery. The output-limit control rendered `CUT SHORT` with zero deliveries.

Related policy: `sidecar/index.js:17251` disables semantic continuation for non-task, non-internal calls across providers. Ollama's defaults in `sidecar/providers/registry.js:513` are 4096 task tokens and 512 casual-chat tokens. General substantive prompts default to tasks; this is not a blanket 512-token cap on all chat or hosted providers. Starting a new session does not alter these per-response policies.

Focused checks passed: chat-prompt-diet HTTP (29 assertions), output-continuation (43), loop provider recovery (60), provider timeouts (53), OpenRouter adapter (89), and casual-response-safety HTTP (lead/worker, hosted/local, context, task promotion, restart). These existing checks pass despite the reproduced browser EOF defect.

## Verdict

OPEN. Investigation only; no production fix, merge or release. Confirmed browser completion-integrity defect; original customer cause remains uncorrelated. Provider-to-sidecar recovery already retries a missing completion marker, but that does not protect the separate sidecar-to-browser stream. A connection reset that makes `reader.read()` throw follows a different existing error path; this reproduction specifically covers clean EOF.

Recommended repair: require a matching lead completion receipt; parse the final buffered JSON record; retain partial text as interrupted and reconcile with the durable run journal before offering continuation. Never automatically replay possibly executed tools merely because the response connection ended.

## Sibling coverage

{"adapters":[{"target":"provider-to-sidecar transport","state":"covered","test":"test/loop.provider-recovery.test.js","scenario":"missing provider completion marker retries once and persistent truncation becomes error","gate":"fast"},{"target":"customer provider and model","state":"blocked","reason":"Provider/model and actual failing output were not supplied."}],"entrypoints":[{"target":"COMMS lead and delegated/internal streams","state":"blocked","reason":"Lead COMMS failure reproduced by investigation script; a registered before/after regression including worker end-event isolation and internal calls is still required."}],"displays":[{"target":"COMMS completion, partial transcript and delivered event","state":"blocked","reason":"Before-fix live proof recorded; repaired UI and installed desktop acceptance are not available."}],"lifecycle":[{"target":"reconnect, restart, session switch and journal reconciliation","state":"blocked","reason":"Needs repair-specific regression coverage, including safe handling of an already-executed tool."}]}
