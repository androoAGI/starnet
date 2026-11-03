---
fingerprint: cad78f6a
slug: strict-channel-history-read-blocks-an-active-run
title: Strict channel history read blocks an active run's plain STOP
surface: channels
severity: P1
status: fixed
found: 2026-11-03
lane: turn-identity-1103
fix: 8f6cb7928
origin: audit
---

# Strict channel history read blocks an active run's plain STOP

## Symptom

A channel owner typing plain `stop` during an active run can receive a history-unavailable response while the existing run keeps working. This was found in the unlanded C9 consumer migration, not reported from a released installer.

## Repro

1. Run `test/channels.history-ownership.test.js` with `CHANNEL_HISTORY_REVIEW_HUB_SOURCE` naming the exact source04 hub control.
2. The actual hub begins a run and retains its abort owner. Refuse only the new strict chat-record read while ordinary cached metadata remains available.
3. Send the owner's ordinary direct-chat `stop`. The control attempts strict history context acquisition before reaching its existing cancellation branch.

## Evidence

Root independent source review identified `sidecar/channels/hub.js` acquiring `chatContext(chatId)` before the `STOP_WORDS_RE` branch. Exact vulnerable source is preserved in `_logs/codex-overnight-1103/turn-identity-c9-consumer-review-control-source04/hub.js` with SHA256 in its manifest. The permanent actual-hub regression is `test/channels.history-ownership.test.js`. Lease C9-OWNERSHIP-2122 completed the combined review control RED11/17 (PID16524, exit1) and current GREEN17 (PID62480, exit0). The STOP control did not abort the live run and showed a history hold; current cancels without acquiring strict history. No browser or installer claim.

## Verdict

Fixed in the canonical consumer checkpoint. Exact saved-source control RED11/17 and current17 prove plain owner STOP cancels without strict history access; independent source review closed. Hub189 and affected consumer/law closure are green. Combined/browser acceptance remains separate.
