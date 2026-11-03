---
fingerprint: d2eeeaf7
slug: a-full-access-routine-whose-prompt-says-to-use-c
title: A Full Access routine whose prompt says to use channel.send delivers its words twice: the agent's caption, then the station's own reply
surface: autonomy
severity: P2
status: open
found: 2026-10-18
lane: channel-delivery-ledger
fix:
origin: audit
family: routine authoring
---

# A Full Access routine whose prompt says to use channel.send delivers its words twice: the agent's caption, then the station's own reply

## Symptom

A routine set up by an agent under Full Access to send something to a chat puts its words in that chat twice: once as what the agent itself sent with channel.send, and once more as the routine's own reply, which the station delivers to the same chat. The picture or file arrives once, since 2026-10-18. The words do not.

## Repro

1. Start from an agent with Full Access and a paired Telegram owner chat.
2. In that chat, ask the agent to make a routine that produces a picture or a report and sends it here. Under Full Access the agent writes its own delivery step into the routine's prompt ("send it using channel_send").
3. Press Run Now on the routine.
4. The run calls channel.send with its words and the file, then ends with a reply. The cron delivers that reply to the routine's origin chat.
5. Read the chat: the file is there once, and the words are there twice.

The mechanism is read from the code below, and the picture half of it was seen live on 2026-10-18. The channel-delivery-ledger lane did not run these steps against a live model.

## Evidence

`sidecar/routine-media.js:80` records the live case: "the routine's prompt said "send it using channel_send", the run did that AND wrote an ATTACH line, and the picture arrived twice". That fix made the delivery skip FILES a fire already sent to this chat, per destination: `RoutineMedia.filesAlreadySent(plan.runs, target, chatId)` at `sidecar/routine-delivery.js:208`. Nothing compares the words: `chatBody` is always delivered (`sidecar/routine-delivery.js:172`), because a routine's reply is its result.

`sidecar/tools/builtin/routines.js:288`, routine.create's description, tells the agent results come back to this chat by default, and says nothing about leaving delivery out of the prompt it writes.

Carried over from the memory record `mem:telegram-routine-media-1018`, whose delivery half the channel-delivery-ledger lane closed. This open item is not delivery state, so it is tracked here to survive that record's closing.

It belongs to routine authoring, not to the delivery path: the agent's caption and the run's reply are rarely the same text, so removing repeated words at delivery would be a heuristic on top of a known family. The lane's plan measured 19 bytes of payload budget left in routine.create's description, so a fix there has to pay for its words.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
