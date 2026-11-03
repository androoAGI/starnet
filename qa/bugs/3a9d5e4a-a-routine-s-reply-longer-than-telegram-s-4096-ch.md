---
fingerprint: 3a9d5e4a
slug: a-routine-s-reply-longer-than-telegram-s-4096-ch
title: A routine's reply longer than Telegram's 4096 characters is sent as one message, refused 'message is too long' on every retry, and never reaches the chat
surface: channels
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: 9af08a5a0
origin: audit
---

# A routine's reply longer than Telegram's 4096 characters is sent as one message, refused 'message is too long' on every retry, and never reaches the chat

## Symptom

A routine that reports to a Telegram chat ("research overnight and tell me") produces a normal-length digest — anything past ~4096 characters — and the chat receives nothing. Not a truncated message, not a part: nothing, on the fire and on every retry. The station's routine row says lastStatus "ok"; only lastDeliveryOk:false / "Bad Request: message is too long" in the job record shows why.

## Repro

Booted sidecar :9721 with a mock Bot API that enforces Telegram's 4096-character sendMessage ceiling (after entity parsing), scripted mock OpenRouter, owner paired in DM 4242.
1. From the chat, have the agent call `routine_create {name:"Daily long digest", prompt:"long routine report for the digest", schedule:"every day at 10am"}` (deliver defaults to 'origin' = this chat).
2. Script the routine's model reply as ~13,000 rendered characters.
3. POST /api/cron/run {id}.

## Evidence

- Mock capture before the fix: ONE `sendMessage` of 16,722 wire characters -> `400 Bad Request: message is too long`; nothing else reached chat 4242. Job record: `"lastStatus":"ok", "lastDeliveryOk":false, "lastDeliveryError":"Bad Request: message is too long", "finalization":{"state":"pending",…}` — the retry resends the same over-long message.
- Mechanism: `deliverCronResult` (sidecar/index.js) called `live.adapter.send(chatId, redact(chatText), route)` with the whole reply; `adapter.send` sends ONE message by contract ("the hub chunks long replies to MAX_MESSAGE_LENGTH before calling this", sidecar/channels/adapter.js). Chat replies go through the hub's chunker; routine delivery did not.
- Regression: `test/cron.channel-media.e2e.test.js` case 5 (the fake Bot API now refuses >4096) — RED before ("no part of the digest was refused as too long (1 refused)", "lastDeliveryOk … expected true, got false"), GREEN after.

## Verdict

Fixed: the routine reply is split with the hub's chunker at the channel registry's maxMessageLength and sent in order; a mid-way failure names how many parts landed. Live re-check: the same routine delivered in 4 messages, none refused, `lastDeliveryOk true`, finalization `delivered`. Fix: `9af08a5a0`.

## Family

Closed as a family by the channel-delivery-ledger lane. The chunking fix reached one of five send paths. Routine delivery kept its own 429 retry, its own in-memory order and no progress per part, so a retry after a refused part resent the parts before it, and a crash after the last part resent them all. channel.send had another chunker, and the notifier, the nudge and the loop notice had none. Every send outside a hub's reply now goes through one contract (`sidecar/channels/outbound.js`) and one chunker (`sidecar/channels/chunk.js`), and a routine's parts are ledger records with sent marks.

The invariants: `test/channels.outbound.contract.test.js` (a source census, then each path's behaviour), `test/routine-delivery.lifecycle.test.js` and `test/routine-delivery.parts.e2e.test.js` (the real cron driver: parts are never resent, across a crash too), and P7 of `test/channels.delivery-ledger.property.test.js`.
