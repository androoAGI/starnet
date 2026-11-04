---
fingerprint: d4b3a5af
slug: history-cache-accepts-an-explicitly-refused-proo
title: History cache accepts an explicitly refused proof
surface: sessions
severity: P2
status: fixed
found: 2026-11-03
lane: agent/line-intake-next-1103
fix: c22cfbf7e
origin: audit
family: truthful-ack-client
installer: unverified
recovery: unconfirmed
---

# History cache accepts an explicitly refused proof

## Symptom

A conversation can remove its cached rows even though the station's JSON body explicitly refuses the cache proof. The durable transcript is not erased by this page operation, but the page can present the removal as confirmed.

## Repro

1. Run the actual desktop reconciliation function against the real in-memory transcript owner in `test/turn-retract.cache.test.js`, retaining two identified local rows and an unrelated foreign row.
2. Answer its cache-retraction request with HTTP200 and `{ok:false, streamId:'s', retracted:[1,2]}`. The explicit refusal must prevent any cache mutation even if the other fields look valid.
3. The original code checks HTTP success only and removes the two local rows. The repaired code uses the production Harness.api response reader and refuses the body, preserving the exact cache and failed-read state.
4. Keep HTTP503 refusal, successful removal, foreign-row preservation, delayed superseded load and unknown durable identity controls unchanged.

## Evidence

- Fixed source `frontend/app/chat.js`: both cache proof and undo mutations now use `Harness.api.post`. Tests load that production client through `test/helpers/harness-api.js`; no duplicate client implementation.
- Exact old Chat source from5efa3b864, SHA256 `8492147936dbd261ffdc6c9fdf2b2e3af97ddab7d17a89a26baf37cbad1ba4b0`, preserved in `_logs/codex-overnight-1103/ack-chat-json-pre-client.js.txt` outside the tree.
- Original control `ack-chat-json-old-2231.log`: completed3/27red with24positive assertions, actual exit1. The three failures are refusal acceptance, cache deletion and successful-read classification.
- Current `ack-chat-json-current-2231.log`: all9files passed, actual wrapper session35511 exit0: cache27, undo review27, merge68, COMMS38, threadUX24subtests, redaction110, fetch ratchet128, mirror8 and actual retractHTTP55.
- Initial merged acknowledgement closing queue completed18/19green; its only failure was the raw-fetch ratchet,3assertions, retained in `ack-root-closing-2226.log`. Both new JSON callers were migrated; the chat baseline decreased to27 and backup's obsolete raw-fetch row was removed. No baseline increase.

## Verdict

Fixed in source. Exact original/current controls prove explicit refused JSON cannot authorize cache removal; successful and delayed-ownership paths still pass. Actual app/browser and installed verification remain separate, and no whole candidate readiness is claimed.
