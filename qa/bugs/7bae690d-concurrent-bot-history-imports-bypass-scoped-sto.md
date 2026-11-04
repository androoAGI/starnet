---
fingerprint: 7bae690d
slug: concurrent-bot-history-imports-bypass-scoped-sto
title: Concurrent bot history imports bypass scoped-store serialization
surface: channels
severity: P1
status: fixed
found: 2026-11-03
lane: turn-identity-1103
fix: 8f6cb7928
origin: audit
---

# Concurrent bot history imports bypass scoped-store serialization

## Symptom

Two simultaneous requests for a disconnected bot conversation can leave duplicate imported history and an unavailable history count. Found in the unlanded C9 consumer migration; no released customer occurrence is claimed.

## Repro

1. Run `test/channels.history-ownership.test.js` with `CHANNEL_HISTORY_REVIEW_HOST_SOURCE` naming the exact source04 host control.
2. Use a real saved bot record with an empty shared legacy chat file and a nonempty isolated hop history named by its stored `hopKeys`.
3. Begin one actual handoff/count and hold its first canonical append acknowledgement. Start a second request for the same bot/chat before releasing the first append.
4. The old host creates separate scoped-store objects, bypassing the port's per-store/chat import queue.

## Evidence

Root independent review identified `sidecar/index.js` constructing a fresh `makeBotScopedStore` for each disconnected context while `sidecar/channels/history-port.js` queues by actual store identity. Exact source04 host bytes are preserved in `_logs/codex-overnight-1103/turn-identity-c9-consumer-review-control-source04/index.js`, with a hash manifest. The permanent test exercises the real host handler, scoped wrapper, port and transcript Store with a deferred append. Lease C9-OWNERSHIP-2122 completed the combined review control RED11/17 (PID16524, exit1) and current GREEN17 (PID62480, exit0): the control appended the source row twice and left one count unavailable; current appends once and both counts complete.

## Verdict

Fixed in the canonical consumer checkpoint. Exact saved-source control RED11/17 and current17 prove one serialized bot import and current saved context; independent source review closed. No credential or record cache was introduced. Affected consumer/law closure green; combined acceptance separate.
