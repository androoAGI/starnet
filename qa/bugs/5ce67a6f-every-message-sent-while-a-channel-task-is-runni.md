---
fingerprint: 5ce67a6f
slug: every-message-sent-while-a-channel-task-is-runni
title: Every message sent while a channel task is running is processed twice: inbox recovery replays a follow-up that already finished while it waited
surface: channels
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: 2899b4102
origin: audit
---

# Every message sent while a channel task is running is processed twice: inbox recovery replays a follow-up that already finished while it waited

## Symptom

While a Telegram task is running, the Commander types a follow-up ("also add a limerick"). The chat says "↪ Added to the task that is already running — it picks this up at its next step, no restart." and the running task does fold it in — and then, the moment that task finishes, the same follow-up runs AGAIN as its own separate task with its own reply. The same happens to anything typed during a run: "/routine add …" answered "Routine created" and then, after the run, "A routine named … already exists — not creating a second one."; "/away build …" answered "Queued…" and then "Could not queue that: that is already on the build list." Double model spend, double side effects for any follow-up that a store does not deduplicate, and contradictory replies.

## Repro

Booted sidecar :9721, mock Telegram + scripted mock OpenRouter, owner paired in DM 4242.
1. Send "slow task four" — the scripted reply is held open so the run stays in flight.
2. 3 s later send "also add a limerick" (steered; the ack is delivered).
3. Release the held reply.
4. Observe a second run start ~0.5 s after the first ends whose last user message is "also add a limerick".
Same with step 2 = "/routine add every day at 9am | check the morning news" or "/away build a tiny landing page for my bakery".

## Evidence

- The mock Bot API delivered each update exactly once (instrumented: `DELIVER update_id 5001`, `DELIVER update_id 5002`), yet the provider received "also add a limerick" as a fresh run after the steered run ended; the chat got "answer to slow task four\n[steering] also add a limerick…" and then "ACK[also add a limerick]".
- A temporary stack trace in processInbound showed the second call came from `recoverInbox (sidecar/channels/hub.js:1508)` via textInbound.
- Mechanism: `flushOutbox`'s finally calls `recoverInbox()` whenever the outbox drains ("Capacity is back…"), which happens on the steer ack's own delivery. recoverInbox snapshots the inbox ([running task, follow-up]), `await onInbound(task)` gets the task's LIVE promise and parks for the whole run, then replays the follow-up from the stale list although it had already finished and left the inbox.
- Regression: `test/channels.outbox.test.js` case I ("a STALE recovery snapshot never replays a message that completed while recovery waited") — RED before the fix ("the steered follow-up never starts a run of its own — expected 0, got 1"), GREEN after.

## Verdict

Fixed: recoverInbox re-checks that an item is still durably pending immediately before replaying it, so a message that finished on its own path while recovery waited is skipped. Live re-check on the fixed sidecar: steered "also add a sonnet" + "/away build a recipe card generator" during a held run -> one ack each, no second run, no duplicate /away reply. Fix: `2899b4102`.

## Family

Closed as a family by the channel-delivery-ledger lane. The stale snapshot was one symptom of recovery firing on a drain: recoverInbox ran from the outbox flush's finally, so it fired mid-session on ordinary deliveries, and work a full outbox held replayed only when the whole channel's outbox emptied, so one failing chat parked every other chat's. Recovery now runs on 'up' and on a 30 s timer, never on a delivery, and every inbound ends in exactly one terminal transition: its answer's write or a settle.

The invariant: P5 of `test/channels.delivery-ledger.property.test.js` and its soak `test/channels.delivery-ledger.soak.test.js`: every inbound the adapter acknowledged gets exactly one terminal outcome, follow-ups steered into a live run included (joined or run, never both), a slash command at most once, on hubs lifted from the production calls. `test/channels.decision-settle.test.js` holds the follow-up, the command and the stop to it across a crash in their ack, and `test/channels.intake-backpressure.test.js` keeps a stop and a follow-up from ever being held back behind a chat's owed replies. Case I of `test/channels.outbox.test.js` locks recovery's clock.
