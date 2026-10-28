---
fingerprint: e903a199
slug: a-steered-telegram-reply-arrives-with-the-raw-st
title: A steered Telegram reply arrives with the raw '[steering] <note>' echo and both the pre- and post-steer answers glued into one message
surface: channels
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: faccfbbdd
origin: audit
---

# A steered Telegram reply arrives with the raw '[steering] <note>' echo and both the pre- and post-steer answers glued into one message

## Symptom

A follow-up typed into a running Telegram task is folded in (good), but the final message the phone receives is the raw token stream: the first answer, an internal "[steering] also add a sonnet" echo line, blank lines, and then the second answer — e.g. "answer to slow task eight\n[steering] also add a sonnet\n\n\nACK[slow task eight]". COMMS renders the same "[steering] …" line as its own steer-echo row; the phone shows the marker as prose and two answers glued together.

## Repro

Booted sidecar :9721, mock Telegram + scripted mock OpenRouter, owner DM 4242.
1. Send "slow task eight" (scripted reply held).
2. Send "also add a sonnet" (steered: "↪ Added to the task…").
3. Release the reply.

## Evidence

- Mock capture: `sendMessage "answer to slow task eight\n[steering] also add a sonnet\n\n\nACK[slow task eight]"`.
- `sidecar/loop.js:1036` emits the fold as a token: `emit('agent.token', { agentId, runId, delta: '\n[steering] ' + t + '\n' })`; the hub buffers every agent.token into the reply (`state.buf += (p.delta || '')`, reset only on agent.tool_call) and has no counterpart to frontend/app/chat.js's steer-echo split (chat.js:8213-8218, 8363-8370).
- Cosmetic/legibility only: nothing is lost or invented. Not fixed in the lane (a reply-shaping decision: drop the marker, or send the pre-steer answer as its own message).

## Verdict

Fixed in `faccfbbdd` with its follow-up `f6f1287c9` (2026-10-23; both ancestors of trunk, first released in v0.14.0). The hub splits a steered reply the way COMMS does: the chat gets both answers with the steering note on its own line, never the raw `[steering]` marker, and a note sent as two quick bubbles or on two lines reaches the chat as one note line (`sidecar/channels/hub.js`). Regression: test/channels.steer-reply.test.js (passes on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
