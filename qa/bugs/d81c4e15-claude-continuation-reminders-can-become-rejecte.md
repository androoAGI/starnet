---
fingerprint: d81c4e15
slug: claude-continuation-reminders-can-become-rejecte
title: Claude continuation reminders can become rejected assistant prefill
surface: providers
severity: P1
status: open
found: 2026-09-10
lane: agent/release-0112-audit-0910
fix:
origin: audit
---

# Claude continuation reminders can become rejected assistant prefill

## Symptom

An installed Sonnet 4.6 task writes and reads its file, then ends with a generic HTTP 400 while trying to continue verification. COMMS correctly marks the run failed, although the file exists.

## Repro

On installed canary source `bed625bdd`, use OpenRouter / `anthropic/claude-sonnet-4.6` to write and read back a small HTML page without executing it. Approve the file and deliverable operations. The verify-on-stop host reminder follows the assistant's answer. A minimal real upstream request with roles `system,user,assistant,system` reproduces the 400; changing only the final role to `user` returns 200.

## Evidence

Installed run `7b92366d-05cb-4128-a203-9383699b8b88` has three successful tools, `failureStage: provider_stream`, `failureCode: format_error`, and $0.20579385 recorded spend. `.dogfood/release-0112-closeout/installed-tool-run-record.json` preserves its receipt. The requested project root had not been granted by the probe, so the app correctly used the agent workspace; this is a probe setup limit, not evidence of project data loss.

`.dogfood/release-0112-closeout/prefill-probe.log` preserves real upstream Sonnet 4.6 error metadata: "This model does not support assistant message prefill. The conversation must end with a user message." The user-tail control returned 200. Sonnet 5 returned 200 for both shapes on this probe, so no identical current Sonnet 5 failure is claimed. [Anthropic documents the prefill restriction](https://platform.claude.com/docs/en/api/errors).

`test/provider.openrouter.test.js` adds seven assertions at the actual outgoing request seam. Two fail before the repair; all 71 adapter assertions pass afterward. `sidecar/providers/openrouter.js` now preserves mid-conversation host notes as user turns for Claude, matching the existing native Anthropic adapter. Leading system policy, note bytes, other models, and durable loop history are preserved.

## Verdict

Source repair is covered; rebuilt installed reproduction remains pending. This independently reproduced defect does not close the historical managed-Sonnet customer report without its affected-run evidence.
