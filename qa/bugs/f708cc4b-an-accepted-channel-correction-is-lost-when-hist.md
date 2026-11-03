---
fingerprint: f708cc4b
slug: an-accepted-channel-correction-is-lost-when-hist
title: An accepted channel correction is lost when history loading crosses a restart
surface: channels
severity: P1
status: fixed
found: 2026-11-03
lane: turn-identity-1103
fix: 8f6cb7928
origin: audit
---

# An accepted channel correction is lost when history loading crosses a restart

## Symptom

A channel accepts an edit of the latest message, then restarts while loading history. The correction disappears without a run or reply. The in-memory-only edit eligibility seam was exposed by the unlanded C9 awaited history migration; no released-installer occurrence is claimed.

## Repro

1. Replay seed 33 in `test/channels.delivery-ledger.property.test.js` against the exact pre-edit-admission C9 sources saved under `_logs/codex-overnight-1103/turn-identity-c9-edit-admission-control`.
2. The platform acknowledges correction #8 while it is current, before a provider attempt. The process crashes at the same virtual instant while an older task settles.
3. Restart the real channel Store and Hub over the same durable receipt bytes. The fresh route map cannot recognize the accepted correction, and recovery removes its receipt without running it.

## Evidence

`turn-identity-c9-legacy-2134-channels.delivery-ledger.property.log` records the complete 40x40 property result, RED2/19, seed33. `turn-identity-c9-seed33-2139.log/.json` is the observer-only repeat (PID16724, exit1): committed delivery.json contains edit@1761900004 at +4853ms seq50/54 with attempt:null and deferred:false, still present at restart +6933ms seq57, then removed at seq69 without a provider call or reply. `sidecar/channels/routes.js` keeps edit eligibility only in memory, and the old `sidecar/channels/hub.js` gates edits before attempt recovery. The permanent actual-Hub, Store, Telegram-adapter and receipt regression is `test/channels.edit-admission.test.js`. Final C9-EDIT-2200 completed exact saved-source RED20/52 (32 positives, PID58308, exit1) and current GREEN52 (PID11160, exit0); unchanged seed33 then passed all19 assertions (PID71548, exit0). Earlier incomplete teardown and incorrect album-waiter fixture receipts remain preserved separately.

## Verdict

Fixed with receipt-owned accepted/superseded edit admission and strict rollback. Exact old20/52 red, current52 green, unchanged seed33 and full40x40 P1-P7 passed; current52 reran green after preparation repair. Independent review and consumer/law closure green. Combined/browser acceptance separate.
