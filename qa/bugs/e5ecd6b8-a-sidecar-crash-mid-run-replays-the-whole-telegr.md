---
fingerprint: e5ecd6b8
slug: a-sidecar-crash-mid-run-replays-the-whole-telegr
title: A sidecar crash mid-run replays the whole Telegram message as a second identical user turn, so side effects run twice and the reply undercounts them
surface: channels
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: 254ebe0e0
origin: audit
---

# A sidecar crash mid-run replays the whole Telegram message as a second identical user turn, so side effects run twice and the reply undercounts them

## Symptom

The station crashes (or is killed) while a Telegram task is working. When it comes back it quietly runs the same message again from scratch: anything the first attempt already did is done a second time, and the phone gets one ordinary reply that only describes the second attempt. In the live walk an "append one line" task appended TWO lines and the chat was told "Appended one line to audit.log." Nothing on the phone says the station restarted or that the request was re-run.

## Repro

Booted sidecar on :9721 with a mock Telegram Bot API (SKYNET_TELEGRAM_API_BASE) and a scripted mock OpenRouter; owner paired in DM chat 4242; `/approvals off`.
1. Send "append audit line now". The model calls `brief_proceed`, then `fs_append {path:"audit.log", content:"AUDIT-LINE
"}`; its final text turn is held open (the tool has already run).
2. Hard-kill the sidecar while the reply is held; boot it again on the same workspace.
3. On the first poll-up the hub's durable inbox replays message 7046; the scripted model runs the same task again.

## Evidence

- `ws/tg_4242/audit.log` after the reboot: `AUDIT-LINE
AUDIT-LINE
` (11 -> 22 bytes; the second tool receipt reads "Appended to audit.log (+11 bytes, now 22)").
- Phone (mock sendMessage 7047): `Appended one line to audit.log.` — the only message after the restart.
- Canonical transcript `channel_telegram_4242`: the user turn "append audit line now" appears TWICE, the first followed by the interrupted attempt's tool rows. The replayed provider request (captured req-34) carries msg[29] user "append audit line now", the old rows as `[recovered tool result — its originating call is not in this transcript] Appended to audit.log (+11 bytes, now 11)…`, and msg[34] the same user words again — so the model reads it as the Commander asking twice.
- `sidecar/channels/hub.js:1508` `try { await onInbound(it.message, { recovered: true }); }` — the `recovered` intake flag has ZERO consumers (grep), so nothing tells the run or the chat that this is a re-delivery after an interrupted attempt; processInbound appends the user turn again unconditionally (`store.appendTurn(agentId, 'user', turnText …)`).
- Station side is honest: `/api/runs?agent=tg_4242` shows the first run `interrupted`, the replay `done`.
- Regression: `test/channels.inbox-recovery.test.js` (real hub over the real channel store; the "crash" is the first hub closed with its run hanging and a fresh store instance over the same disk). RED before the fix ("the replay does NOT run the interrupted task again from the top — expected 0, got 1", "the audit line is in the file exactly once — expected 1, got 2", "the transcript holds the request once, not twice — expected 1, got 2", "the second go sends the model the request ONCE … expected 1, got 2"), GREEN after (38 assertions).

Not fixed in the lane (a prompt/semantics change, >30 lines): the replay should not append a second copy of the user turn, should carry a host note that an earlier attempt was interrupted after running tools (so completed side effects are not repeated), and the chat should be told the station restarted mid-task.

## Verdict

Fixed: the durable inbox receipt now records how far its run got — `store.markInbox` stamps the run id when it starts and a running count of the tool steps it began (each stamped when `agent.tool_call` is announced, before loop.js dispatches the step; line hops count too). A re-delivered receipt (the poll-up recovery pass, or Telegram handing the same update over again) is settled by that marker, the same split the station's own run recovery makes: no marker -> replayed as before; a run that had begun tool steps -> NOT run again, the chat is told the station restarted mid-task, how many steps had begun and that nothing was re-run, and the next run in that chat gets a one-shot host note (counts only, never the chat text) so a "continue" finishes only what is left; a run that had begun no tool step -> run once more, announced as a second go, with no second legacy user turn, the earlier copy dropped from the replayed history and the canonical directive row reused (`retryUserRunId`). A merged text batch or album marks every receipt it stands for and is reported once. Review follow-up (`254ebe0e0`): `aaa6d7f30` alone read every re-delivered receipt with a marker as a crash, but a receipt also comes back inside the SAME process — the full outbox refused a finished reply and flushOutbox's recovery replays it. That told the chat "StarNet restarted" when nothing had, queued a false interrupted-request host note, and (with a tool step counted) never delivered the finished answer. Each mark now stamps the store's boot id, so only an attempt left by an EARLIER process gets the crash rule (one from this process replays as before), and a finished reply the outbox refused is kept on its receipts and delivered by the replay without running anything, in whichever process it lands. Regression: `test/channels.outbox.test.js` H and H-tool (the chat is sent the answer once, no restart notice, no host note, the step ran once) and G (a merged batch's answer reaches the chat once), plus `test/channels.inbox-recovery.test.js` F–H; RED on `aaa6d7f30` (6 + 8 failures), GREEN after (81 + 51 assertions). Proven through the real hub + store seam only; a live re-walk on a booted sidecar with the mock Telegram was not done in this lane. Fix: `aaa6d7f30` + `254ebe0e0`.

## Family

Closed as a family by the channel-delivery-ledger lane. The receipt and the reply were two records written separately, and every gap between them ran the message again: a crash after the platform took the reply, one EBUSY on the receipt write in a live process, a resend under an update's write freeze. Edits and taps were outside the rule altogether: a second edit of one message was taken for the first, and a choice tap had no receipt. A reply now enters its chat's lane in the same write that takes its receipts away, one attempt rule applies whichever boot left the attempt, an edit's receipt carries its edit date, and a tap has a receipt of its own.

Since review round 1 the marks are write-ahead: a run starts, and a tool step is dispatched, only once its mark is on the disk, so a station dying while its writes fail runs no step twice; and a message that ends with no reply of its own (a follow-up joined to the working run, a command, a stop) is settled where its decision is made, before its acknowledgement, so a crash in that window never acts on it again. A message a platform handed over and does not keep (Discord, Slack, Matrix, Signal) is kept by the adapter through a refused receipt.

The invariants: P1, P4 and P5 of `test/channels.delivery-ledger.property.test.js`, under crashes (inside write-failure spans too) and live write failures, with the accept-then-crash window logged and allowed for exactly that part; `test/channels.ledger-write-failure.test.js` (no tool step twice and no resend in one process; case (f): the station dying while the marks fail); `test/channels.decision-settle.test.js` (a follow-up, a command and a stop are acted on once across a crash in their ack); `test/channels.intake-receipts.test.js` (every acknowledged inbound has a durable receipt, edits and taps included); `test/channels.intake-handover.test.js` (every message a consuming transport handed over is received).
