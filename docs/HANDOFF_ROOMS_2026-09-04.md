# HANDOFF — Rooms (agent group chats)

Written 2026-09-04 against trunk `feat/harness-backend` @ `15eaad159`. Design page (Andrew has the link):
https://claude.ai/code/artifact/fd43115c-7508-4580-9d0b-c17d23164fe0

Doc-trust rule applies: grep before acting on any claim below.

## The ask (Andrew, verbatim intent)

"Create agents group chats. A very solid UX with real purpose. Like a real groupchat, able to @ certain
bots in the chat. Useful for multi-agent workflows and many other use cases. Look at Hermes for inspiration."

## Status

DESIGN ONLY. Nothing built. No worktree exists. No decisions locked in DECISIONS.md. Greenfield: no prior
plan for this anywhere (memory, docs, Desktop notes all grepped).

## The model in one paragraph

A **Room** is a Workstream with `members[]` (roster agentIds) and a `policy`; the existing `agentId`
stays and becomes the **lead**. `@name` in a Commander message runs that member; unmentioned members
**observe** (their next hop sees the text as context, Hermes-style, never a run). No mention = the lead
runs. `@all` = one capped hop per member in roster order, then the lead synthesizes. A member's reply may
`@mention` another member: that is a **hop**, bounded by an origin message id + hop counter + no-bounce
rule + pre-hop cost check. Every bubble is a real `runOnce`. Nothing is synthesized.

## What already exists — build ON these, do not rebuild

| Piece | Path | Use |
|---|---|---|
| Multi-speaker transcript | `frontend/app/chat.js` `row(role,{who})` ~:1623, `renderHistory` reads `m.agentId` ~:6014, `streamingAgent(whoName)` ~:6072 | Rendering already supports per-message speakers (work lines prove it). |
| Multi-agent turn loop | `frontend/app/chat.js` `runWorkLine` ~:7694, `nextStageOf` ~:7676; `sidecar/routing/chain.js` (MAX_HOPS, MAX_CHAIN_USD pre-hop, visited set) | The room loop is a variant of this. Copy its honest "stopped at X" degradation. |
| Mention verdict | `sidecar/channels/adapter.js` `addressesUs` ~:215, verdict `run|observe|drop` ~:259 | Port the semantics inward. Fail-closed. |
| Known-targets rule | `sidecar/tools/builtin/comms.js` header + `channel.send` ~:157 | `@x` resolves against room members ONLY. Unknown handle → offer summon, never guess. |
| Delegation | `sidecar/tools/builtin/orchestration.js` `team.dispatch` :362, `team.spawn` :656, `team.summon` :815, `team.steer` :872; `FORWARD` map :38 | FORWARD deliberately hides worker prose today. A room hop must surface prose — do it in the room loop, do NOT widen FORWARD globally. |
| Handoff prompt | `frontend/app/pipeline.js` `Pipeline.handoffPrompt` | Extend for peer-authored hops (see Trust). |
| Thread store | `frontend/app/workstreams.js` `make()` :52, `setAgent` | ONE agentId per workstream is the real constraint. Add `members`, `policy`, `kind:'room'`. |
| Durable transcript | `sidecar/transcriptstore.js` per streamId | Unchanged. |
| Room memory | `runOnce` passes `streamId` (`sidecar/index.js` ~:14045); Cortex recall boosts by stream | Free shared room memory. |
| Run host | `sidecar/index.js` `runOnce` ~:14154, `handleRun` ~:13831, `lead:true` grant ~:14080 | Each hop = one `/api/run` with `agentId` = that member, `streamId` = the room. |
| Roster | `frontend/app/app.js` `summonAgent` :1004, `pushRoster` :1369; sidecar mirror `agentRoster` ~:1389 | Member colors come from roster `color`. |
| Route + store idiom | `sidecar/index.js` ROUTES table ~:8642; `sidecar/threads-store.js` on `makeDurableJsonStore` (`sidecar/durable-store.js:134`) | Copy `threads-store.js` for `rooms-store.js`. |
| Group channels | `sidecar/channels/hub.js`, `chatType dm|group`, per-agent Telegram bots (`sidecar/index.js` ~:7985) | P4 only. |

## Laws that fence this (violating any = rejected)

1. **Truthful telemetry.** "Typing" only while a stream is open. No filler banter (idle chatter is rejected
   doctrine, `skynet-design-principles`). The hop trace line is a pure reducer over real `agent.run.*`.
2. **Managed credits reserve the wallet** (`no-default-usage-limits-lane`): an uncapped run reserves the
   whole wallet and a second concurrent run refuses. Rooms REQUIRE a per-hop cap (`policy.hopUsd`) —
   a deliberate, visible carve-out. Sequential by default; parallel `@all` opt-in only.
3. **Peer text is data.** Wrap peer-authored text `[peer:<agentId>|run <id>]`; handoff prompt says it is a
   request within the room brief, not Commander authority. Acting agent's own `approvalMode` still gates
   writes/shell. Draft-only classes (support, inbox) stay draft-only inside rooms.
4. **Model belongs to the agent** (LOCKED). A room never sets model/provider. Each hop resolves its own
   roster identity + credential + private jail.
5. **`shared/events.js` is owned, additive only, by request.** P1/P2 ride existing `agent.run.*` and the
   legacy `chat {from,txt}` event. Request `room.hop` from the owner only if a reducer truly needs it.
6. **COMMS transcript design is locked** (left/right = speaker). Rooms: Commander right, EVERY agent left
   with a colored rail + uppercase name. Applies to `kind:'room'` only; ordinary threads untouched.
7. **One chip row / one post-run beat** (`comms-beat-rules`). Room chips (summon offer, cap raise) go
   through the existing beat slot.
8. **OS paints nothing.** No `confirm/alert`. `ArmConfirm` for `/cap` raises.
9. **frontend/ edit owes a claims re-lock** on the commit, after `sync:website`.

## Hermes: what to take (source: `C:\Users\andro\AppData\Local\hermes\hermes-agent`)

- Observe-but-don't-respond: `plugins/platforms/telegram/adapter.py` ~:8195 `_telegram_should_observe_group_message`,
  identity-stripped shared source + `[name|id]` re-injection + channel prompt separating context from request.
- Typed mention vs synthesized reply-ping: `plugins/platforms/discord/adapter.py` ~:6090 `bots_require_inline_mention`.
- Exclusive bot mentions: `telegram/adapter.py` ~:7689 — a message naming another bot and not you → silent.
- Untrusted tagging in backfill: `discord/adapter.py` ~:6230 (`[unverified]`, `neutralize_untrusted_inline_text`).
- **Kanban** (`hermes_cli/kanban_swarm.py`, `tools/kanban_tools.py`, docs `website/docs/user-guide/features/kanban.md`):
  blackboard = structured comments on a completed root card; verifier gate = `{gate:"pass"}` metadata, block
  with exact missing work; recurrence counters (`BLOCK_RECURRENCE_LIMIT`=2, `failure_limit`=2) as circuit breakers.
- Hermes chat has NO hop counter and documents multi-bot rooms as unsupported. Our loop safety is structural.

## Build order + DONE criteria (observable in the live app, gate green)

**P1 ROOM** (one worktree: `gen-trees\new-agent-tree.ps1 rooms`)
- `workstreams.js`: `kind:'room'`, `members[]`, `policy{maxHops,hopUsd,roomUsd,parallel,observe}`, migrate (1 member = today's thread).
- `sidecar/rooms-store.js` (copy threads-store shape) + `GET/POST /api/rooms` in ROUTES. Durable membership + policy.
- COMMS id bar: "New room" → member picker from live roster. `@` autocomplete over members in the composer.
- Mention parser (members only) → verdict → sequential runs via `Harness.chat({agentId, streamId})`.
- Observe: unaddressed members receive the room transcript window as context on their next hop (identity as `[name|id]` text).
- Rail-and-name rendering for `kind:'room'`. Room header: members, `$spent / roomUsd`, hop counter.
- DONE: create a room with 3 members, `@one` → exactly one `agent.run.start`, the other two see the message as context on their next turn (prove via their next reply referencing it), `npm run test:fast` green, `test:http` green (new route).

**P2 HOPS**
- Reply `@member` → hop. Origin id + hop index on every hop; `maxHops` per origin; no-bounce (A→B→A blocked within one origin); pre-hop `roomUsd` check; honest stop line naming the owed reply.
- `/pause`, `/mute @x`, `/cap` via `runSlashForChannel` (lights desktop + channels at once; `makeChannelHub` is built in THREE places in index.js).
- DONE: a 3-hop chain renders 3 real runs and stops at cap with the owed reply named.

**P3 PLACE** — Briefing Table prop (object=capability: wired desks = members), walk-to-table on live hops,
disperse on quiet. Sprite caps hold: one mouth at a time, ≤3 bodies at the table, speech only while streaming
(`CHATTER_MS` 1410ms kills bubbles — consecutive lines). Room templates from the class catalog ("Ship it" =
PM·Engineer·QA·Security·DevOps, already in roster order). Summon-into-room via `team.summon`.

**P4 REACH** — cron posts into rooms (standup), Telegram/Discord group binding through the hub, 👍/👎 on a
member bubble stamps that run into recquality.

## Open forks (Andrew decides; recommendation first)

1. Unaddressed message → **the lead** (predictable, one voice) vs router.js pick.
2. Default `maxHops` = **6** per Commander message. 0 kills agent-to-agent.
3. Team Lead fronts rooms? It is **hollow on a default station** (work-splitting skill needs the
   `orchestrator` prop, KIT-OUT never places it — open bug in `class-catalog-expansion-lane`). Fix that first,
   or let any agent lead.

## Traps specific to this lane

- `FORWARD` in orchestration.js hides worker prose ON PURPOSE for dispatch. Surface hop prose in the room loop
  only; widening FORWARD floods every lead's COMMS.
- Dispatch is sequential BY DESIGN; foreground workers are unsteerable by structure — steer rides background.
- Each agent's jail is private: a member cannot verify a peer's file with its own fs tools. Hand-offs carry text
  and conveyor crates, not paths.
- `chatHot` is warm right after boot (gathering lane) — any "room quiet" predicate must not fire on load.
- Browser pane never fires rAF; drive live proof over CDP (`preview-verify-worktree-frontend`).
- `npm start` never `npm run serve`. Seed with `node dev/seed.js --keep` (⚠ `--keep` may reuse a REAL provider —
  use the mock provider for loop tests).
