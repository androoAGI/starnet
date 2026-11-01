---
fingerprint: 3b958e41
slug: routine-add-typed-on-telegram-creates-a-station
title: /routine add typed on Telegram creates a station-only routine: its results never come back to the chat that created it
surface: channels
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: 61aadf2ab
origin: audit
---

# /routine add typed on Telegram creates a station-only routine: its results never come back to the chat that created it

## Symptom

On Telegram the Commander types "/routine add every day at 9am | long routine report" and is told "Routine created: … first fire Tue, Oct 20, 9:00 AM EDT." The routine runs, but its result only lands on the station: nothing is ever sent back to the chat that created it (unless the optional "notify on autonomous runs" ping is on, which sends a fixed one-liner, not the result). The reply does not say where results will go. The same request phrased as a message ("make me a daily routine") makes the agent call routine.create, which defaults to delivering back to the chat — two doors, two different routines.

## Repro

Booted sidecar :9721, mock Telegram + scripted mock OpenRouter, owner DM 4242.
1. Send "/routine add every day at 9am | long routine report".
2. GET /api/cron -> the new job.
3. POST /api/cron/run {id} and watch the mock Bot API.

## Evidence

- GET /api/cron: `a354b169-… long routine report deliver=local origin=null`, while the agent-tool routine from the same chat is `c19cb049-… Daily long digest deliver=origin origin={"channel":"telegram","chatId":"4242",…}`.
- Run Now of the /routine add job: run `done`, zero sendMessage calls to chat 4242.
- Mechanism: the hub calls `runSlashFn('/' + cmd + …, { agentId: boundId, ownerTrusted })` (sidecar/channels/hub.js) with no delivery origin; `runSlashForChannel` (sidecar/index.js) forwards only `{ agentId, placed }`; `sidecar/slash-actions.js` routineAction creates `cron.create({ name, prompt, schedule, agentId: me })` — deliver defaults to local. The agent tool (`sidecar/tools/builtin/routines.js`) uses `ctx.deliveryOrigin ? 'origin' : 'local'`.
- Fix sketch (4 seams, not done in the lane): pass the chat's delivery origin from the hub through runSlashForChannel's ctx into routineAction, create with deliver:'origin' when present, and say in the reply where results will be delivered.

## Verdict

Fixed in `61aadf2ab` (2026-10-23; an ancestor of trunk, first released in v0.14.0). The hub hands the chat's delivery origin to the slash registry, runSlashForChannel forwards it, and routineAction creates the routine with deliver:'origin' and says in its reply where results will go (`sidecar/channels/hub.js`, `sidecar/slash-actions.js`). Regression: test/channels.routine-add-origin.test.js (passes on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
