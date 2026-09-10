---
fingerprint: a0dffdd7
slug: image-generation-writes-after-run-cancellation
title: Image generation can write an output after run cancellation
surface: providers
severity: P1
status: open
found: 2026-09-10
lane: audit-0112-0910
fix:
origin: audit
---

# Image generation can write an output after run cancellation

## Symptom

Cancelling an in-flight managed image run does not prevent the delayed image tool from saving an output when the provider completes. The run ends cancelled but the file is still created. The image tool cancellation limitation predates 0.11.1; the new managed route exposes it to linked-credit users.

## Repro

Run node scripts/qa/audit-0112/image-cancel.cjs. Hold a local image-provider response until the actual sidecar emits agent.run.start and requests image generation. POST /api/cancel with that run ID, wait for HTTP 200, then release the image response. Observe the cancelled end event and images/credits-proof.png written in the disposable agent workspace.

## Evidence

qa/evidence/0.11.2-audit/audit-image-cancel.json records cancelStatus=200, reason=cancelled and fileAfterCancel=true. sidecar/tools/builtin/image.js:216 does not consume ctx.signal; its network helper creates independent timeout signals at sidecar/tools/builtin/image.js:107. File publication at sidecar/tools/builtin/image.js:281 has no cancellation guard. test/managed-image.e2e.test.js covers refusals/restart but not cancellation.

## Verdict

Open. Propagate the run/tool cancellation signal through inference, download and resize; check before publishing files or deliverables and fence stale results. A provider may already have incurred a charge: retain truthful usage rather than promise refunds or zero cost. Cover abort before call, during synthesis/download, just before publication, timeout and restart. The probe shows a write after acknowledged cancellation, not necessarily after the terminal event.
