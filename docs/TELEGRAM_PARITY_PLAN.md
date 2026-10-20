# TELEGRAM PARITY PLAN — getting StarNet to Hermes' 10/10

Written 2026-07-28, after a live diff of `hermes-ref/plugins/platforms/telegram/adapter.py`
(8,776 lines, 49 dedicated test files, 25 `config.extra` options, 19 `TELEGRAM_*` env knobs)
against StarNet's channel stack (`sidecar/channels/*`, ~1,900 lines shared across five
platforms, 6 Telegram test files).

Grounding note: the Hermes side was read selectively — module header, the streaming /
batching / gating / media functions, and the complete Bot-API call surface. The scorecard
below is a **major-feature** diff, not a line-by-line one. Items marked `VERIFY` are ones I
did not prove on either side and must be checked before they are built.

---

## 0. The crux: why we are behind, and the one decision that unblocks everything

This is not a quality gap. It is an **architectural** one, and it was a deliberate choice.

- **Hermes** has a Telegram-*specific* adapter. It is free to use `message_thread_id`,
  `sendMessageDraft`, forum topics, reactions — anything the platform offers.
- **StarNet** has ONE generic adapter (`channels/adapter.js`) driving Telegram, Discord,
  Slack, Matrix and Signal. Telegram supplies only `normalize()` and a length limit. That
  design bought us five platforms for the price of one — and it caps us at the
  *intersection* of what all five can do.

We do **not** fork into a Telegram-specific adapter. StarNet already has the correct seam
and uses it in four places today: **transport-optional capability methods**. `getFile`,
`answerCallback`, `editMessage` and `setCommands` all return `{ok:false, error}` when the
transport lacks them, and the hub falls back (that is exactly what keeps Discord/Slack
working while Telegram gets real buttons).

> **THE PATTERN, and every phase below obeys it:** a new Telegram capability is
> (1) a method on `telegram.transport.js`, (2) a passthrough on `adapter.js` that answers
> `{ok:false,error}` when the transport lacks it, (3) a hub call-site that **probes and
> degrades**. No hub code may assume Telegram. A platform that cannot do the thing must
> lose the polish, never the message.

Corollary law: **the floor is delivery.** Every enhancement here can fail; none of them may
cost the member the reply. That is already how the markdown→HTML fix works (a 400 on the
entity string resends as plain text) and it is the acceptance bar for all of it.

---

## 1. Scorecard — Hermes' 49 Telegram tests mapped onto StarNet

### HAVE (parity today, some of it better)
| Hermes test | StarNet |
|---|---|
| `approval_buttons` | `/approvals` + `channels/prompts.js` — ours is bounded + token-resolved, Hermes' leaks and FIFO-crosses |
| `callback_auth_fail_closed` | fixed here; an unclaimed owner is not a licence |
| `auth_check`, `bot_auth_bypass` | owner trust-on-first-use in `adapter.js` |
| `conflict` | 409 → `.fatal`, with an actionable message |
| `pending_update_probe` | `dropPendingOnConnect` + the deferred "I was offline" notice |
| `init_deadline`, `start_polling_timeout` | `POLL_DEADLINE_MS` (poll timeout + 15s slack) |
| `network`, `network_reconnect` | fixed backoff ladder, no jitter (determinism) |
| `max_doc_bytes` | `MAX_MEDIA_BYTES` 8MB, refused before buffering |
| `caption_merge` | caption becomes the turn text; album merge via `mediaGroupId` |
| `documents` (inbound) | `getFile` → workspace attachment |
| `model_picker` | `/model` |
| `format`, `rich_messages` | **just shipped** — `telegram.format.js` + HTML with a plain-text floor |

### PARTIAL
| Gap | Where we stand |
|---|---|
| `typing_backoff` | we fire `sendChatAction` and stop on a hard error, but there is **no 429 cooldown** per chat |
| `send_path_health` | delivery events + durable outbox exist; no health/degradation signal |
| `rich_newlines`, `send_draft_format` | only the subset our converter proves safe |
| `text_batching` | we **supersede** (abort run #1, restart) where Hermes **batches** into one turn |

### MISSING (verified absent)
Outbound media (`sendPhoto/Document/Video/Voice/Audio/Animation/MediaGroup`) ·
`audio_vs_voice` + `voice_v0_regressions` (no STT on inbound voice) ·
`status_indicator`, `status_update` · `reactions` · `progress_edit_transient`,
`overflow_partial` (no live streaming) · `topic_mode`, `forum_commands`,
`thread_fallback`, `prune_stale_topic_binding` (no `message_thread_id` anywhere) ·
`group_gating`, `mention_boundaries`, `noise_filter` (we answer **every** group message;
no `is_bot` filter) · `channel_posts` · `reply_mode`, `reply_quote` ·
`clarify_buttons` · `webhook_secret` (poll-only) · `error_redaction` ·
`username_chat_id` · `photo_interrupts` · link-preview control · proxy ·
`allowed_users` (we have owner-TOFU + allowed *chats*, not a user list)

---

## 2. The plan

Ordered by **member-visible value ÷ risk**, not by Hermes' file order. Each phase is
independently shippable and independently gated. Nothing here changes the other four
platforms except through the capability-probe seam.

### P0 — DONE (this lane, on trunk)
`0a7e1771` `/approvals` no longer strips the office · `71806559` `/tools` honesty ·
`12922944` markdown→HTML, `/start`, poll-loop wedge. Baseline for everything below.

### P0.5 — DONE (2026-07-29): inbound context — reply quoting + the silent drops
Found on a SECOND pass (§1.5 below), built ahead of P1 because both are "the bot ignored me"
from the member's side and both are small.

- `reply_to_message` is now read (`telegram.js` `replyOf`). The quoted text rides as a fenced,
  attributed preamble above the member's own words (`hub.js` `replyPreamble`, bounded to 500
  chars); the quoted message's MEDIA is ingested with the turn, tagged `fromReply` so every
  note says where the file came from. **The forum trap is handled:** inside a topic Telegram
  sets `reply_to_message` on EVERY message (pointing at the topic-creation message), so that
  case is suppressed or every group turn would carry a phantom quote.
- Location / venue / contact / poll / dice / story / animated + video stickers no longer fall
  through to `message:null` (`telegram.js` `describeOf`) — they arrive as a descriptor line.
  `describeOf` is an **allowlist of user content**: service messages (joins, leaves, pins,
  title changes) still return `message:null`, or the bot starts narrating group housekeeping.
- The preamble is built from `msg.replyTo` only, never `msg.text`, so command parsing, floor
  routing and task classification still see the raw message.
- Proof: `test/channels.telegram.context.test.js` (57 assertions, in `test/fast.list`), each
  half proven by reverting the fix and watching it go red.

### P1 — DONE (2026-07-29): outbound media
The agent can now send a file back. `telegram.transport.js` grew a dependency-free **multipart encoder**
(the real lift — the transport was JSON-only) plus `sendMedia` (photo/document/video/audio/voice/
animation) and `sendMediaGroup` (2–10 album, `attach://` indirection, first caption only). `adapter.js`
passes both through as transport-optional. `channel.send` gained `files` (workspace paths, max 4);
**known-targets-only is unchanged** — a file may go exactly where words may already go. The jail proof
(`fsJail.resolveInside`) and the mime table live in `index.js`, so `comms.js` stays pure.

**The floor is delivery:** the text is sent FIRST and files are attempted after it. A failed upload
degrades to a line *in the chat* naming the workspace path, and the tool result distinguishes "sent with
2 files" from "sent, and the files did not go". Caption capped at the **media** limit (1024), not 4096.

⚠ **PROVEN LIMITATION — P1 is only reachable from a phone with `/approvals on`.** `channel.send` is
`requiresConsent: true` (it is the exfil surface), and that gate is **unchanged by this work** — `files`
is a new parameter on an existing tool. Run against the real broker:

```
makeConsentBroker({ surface:'autonomous', … })(channel.send call)
  -> { allow:false, reason:'autonomous run cannot self-approve this action — silence is not consent' }
```

A default Telegram chat runs headless with approvals OFF, so an agent there **cannot push a file (or
any `channel.send` message) unprompted**; the member must `/approvals on` first, which gives the chat
an ask channel. This is not a media bug — it is the pre-existing outbound-reach policy, and it applies
to text sends exactly as much as to files.

**The product decision this leaves open:** replying with a file to the chat you are already talking in
is arguably not the exfil case the gate was written for (the target is the person who just messaged
you, and known-targets-only already bounds it). Narrowing consent to "third-party targets only" would
make P1 work on a default chat. That is a security call, deliberately not taken here.

### P2 — DONE (inbound half): voice notes are no longer dead input
A voice note is transcribed through the **same** STT chain `/api/stt` uses (Groq whisper →
OpenAI whisper → the chat-model fallback), extracted into `transcribeAudioBuffer` so there is one engine
chain rather than two that drift. The transcript becomes the turn text, **fenced and labelled as a
transcription** so the agent never quotes a machine's reading of speech as verbatim user text. Only a
real voice note is transcribed (`voice:true` from `normalize`) — a forwarded music file is not. A spoken
directive is re-classified once its words exist, so it still earns the task prompt.

**Outbound TTS voice replies are NOT built, and the reason is technical:** Telegram's `sendVoice` requires
OGG/Opus, and our TTS returns mp3. Sending it as `audio` works and gives a player row, but a real
push-to-play voice bubble needs an opus encode we do not have. Do not "fix" this by calling `sendVoice`
with mp3 — it fails.

### P3 — DONE: group discipline
Three gates in `adapter.js`, each independently disableable, all no-ops for a DM:
`ignoreBots` (default ON — bot-to-bot is an unbounded spend loop with no human in it), `requireMention`
(default ON — an @mention of us, a reply to one of OUR messages, or a bare/self-targeted slash command),
and `allowedUsers` (opt-in; it NARROWS, never widens, and does not bypass the owner gate).
`mentionsOf` reads Telegram's entity offsets as **UTF-16**, which is what they are — a byte-offset read
slices the wrong window the moment an emoji precedes the mention.

With no `botUsername` known the gate deliberately admits everything: we must never silence a room because
we could not prove we were not addressed. The name is read through a **function**, not captured as a
string, because `getMe()` resolves after the adapter is constructed.

### P1 (superseded section — kept for the original reasoning)
Today the agent can receive a file and **cannot send one back**. It generates an image or
writes a report and can only describe it.

- `telegram.transport.js`: `sendPhoto/sendDocument/sendVideo/sendAudio/sendVoice/sendMediaGroup`.
  **Real lift:** these need `multipart/form-data`; our transport is JSON-only today. Build one
  small multipart encoder (no new dependency) and unit-test it against a byte fixture.
- `adapter.js`: `sendMedia(chatId, items, opts)` passthrough, `{ok:false}` when unsupported.
- `hub.js`: an outbound attachment path so a run's produced files ride the reply; cap size,
  degrade to "saved to your workspace at `<path>`" when the channel can't carry it.
- Agent-facing: extend `channel.send` to accept attachments — **known-targets-only stays law**
  (`reach-parity` lane); free-form addressing is an exfil path.
- Proof: `channels.telegram.media.test.js` + an e2e that asserts the multipart body.

### P2 — Voice both ways *(highest magic-per-line; we already own both engines)*
Inbound voice is **dead input** today: we save the `.ogg` and tell the model "saved to
`<path>`", which it cannot hear. We already have `/api/stt` (`STT_MODELS`) and TTS.

- Inbound: voice/audio → existing STT → put the **transcript** in the turn text (keep the file
  saved and referenced). Mark it as transcribed so the model never quotes it as verbatim user text.
- Outbound: reply → TTS → `sendVoice`, opt-in per chat (`/voice on|off`), never the default.
- Watch: the `voice-first-word-only` law — a cold-off/backoff must never guillotine work in flight.
- Proof: `channels.telegram.voice.test.js`, incl. an STT failure that still delivers the text reply.

### P3 — Group discipline *(cheap, stops us being noisy and expensive)*
We currently answer **every message in a whitelisted group** and never check `is_bot`.

- `require_mention` (default ON for groups), `mention_patterns`, `observe_unmentioned`
  (store as context, dispatch only when addressed), `allowed_users`, bot-sender filter,
  `guest_mode`.
- This is partly a **spend** fix and partly a security one — put `allowed_users` alongside the
  existing owner gate, not instead of it.
- Proof: `channels.telegram.groups.test.js` — an unmentioned group message must cost zero model calls.

### P4 — Live progress *(most perceived polish; most invasive — do it after P1–P3)*
Hermes edits the message as the model streams (27 `edit_message_text` sites, plus native
`sendMessageDraft`/`sendRichMessageDraft`). This is most of why theirs "feels amazing".

- Placeholder message → throttled `editMessageText` on token deltas → final send.
- Must handle: Telegram edit rate limits, `message is not modified` (a no-op 400), transient
  edit failures (never lose the final), and **overflow continuation** when the stream passes 4096.
- Native drafts (`sendMessageDraft`, Bot API 9.5+) are a **later** optional fast-path — probe and
  degrade to the edit path; do not make it a dependency.
- Proof: `channels.telegram.stream.test.js` — assert the final text is delivered **even when every
  intermediate edit fails**.

### P5 — Threads, forums and reply surface
- Plumb `message_thread_id` end to end: inbound binding, outbound replies, stale-binding prune.
- `topic_mode` / `forum_commands` / `thread_fallback`; `allowed_topics`, `ignored_threads`.
- `reply_quote` / `reply_to_mode`; link-preview control; `channel_post` in `ALLOWED_UPDATES`.
- Reactions as a cheap status ack (`setMessageReaction`) + `status_indicator`.
- Proof: `channels.telegram.topics.test.js` — a forum reply must land in the **originating** topic.

### P6 — Deployment + hardening
- **Webhook mode** + `webhook_secret` (unblocks hosted; we are poll-only). Keep long-poll the default.
- **Error redaction** — we pass raw `e.message` into `console.error`; a fetch error carrying the
  bot-token URL would leak. Hermes redacts explicitly. *Do this one early — it is small and it is a
  secret-leak class.*
- Proxy support, `username → chat_id` resolution, typing 429 cooldown, send-path health.
- **Text batching** to replace supersede-on-rapid-messages (cheaper, loses less).

---

## 3. Where we should NOT copy Hermes

- **Do not fork a Telegram-only adapter.** The capability-probe seam gets us the same result
  and keeps four other platforms alive.
- **Do not adopt their prompt-registry semantics.** Theirs leaks (dicts only emptied on tap) and
  resolves FIFO, so with two live prompts the second tap answers the first. Ours is bounded and
  token-resolved. Keep ours.
- **Native drafts are not a dependency.** They need a very recent Bot API; probe and degrade.
- **Free-form outbound addressing** stays refused whatever Hermes does — known-targets-only.

## 4. Definition of 10/10

1. Every row in §1 is HAVE, or is a documented, deliberate refusal in §3.
2. A Telegram test file per phase, each proven by **reverting the fix and watching it go red**.
3. Every enhancement degrades to a delivered plain-text reply when its API call fails.
4. Discord/Slack/Matrix/Signal behaviour is byte-identical before and after every phase.
5. `npm test` green on trunk after each phase, with its own merge digest in `qa/STATUS.md`.

## 4.5 STATE OF PLAY — 2026-07-29

**DONE:** P0 (approvals/tools/markdown/`/start`/poll-wedge) · P0.5 (reply context, silent drops) ·
P1 (outbound media) · P2 inbound (voice→STT) · P3 (group discipline) · P6-redaction (bot-token leak) ·
plus three of the six second-pass gaps: **group sender attribution**, **fenced-code chunking**, and the
mention/bot gates.

**STILL OPEN, in the order I would take them:**
1. **P4 — live progress streaming.** The single biggest reason Hermes "feels" better. Placeholder message
   → throttled `editMessageText` on token deltas → final send, with overflow continuation past 4096. Most
   invasive; do it on its own.
2. **`my_chat_member` is still invisible.** `ALLOWED_UPDATES` is `['message','callback_query']`, so being
   blocked or kicked cannot be detected and the notifier keeps sending into a dead chat. **Deliberately not
   half-built:** detecting it without a consumer that marks the chat unreachable would be a stamped field
   with no reader, which is one of this project's named bug classes. Build the detection and the store
   update together or not at all.
3. **P5 — threads/forums.** `message_thread_id` end to end, `reply_quote`, reactions, `channel_post`.
   `replyOf` already suppresses the forum-topic-root trap, so the parse side is half-ready.
4. **Per-user / per-thread sessions.** `agentIdFor(chatId)` keys on chatId alone; Hermes has
   `group_sessions_per_user` / `thread_sessions_per_user`. Now that groups are mention-gated this matters
   less for spend and more for context bleed between people.
5. **Rest of P6:** webhook mode + secret, typing 429 cooldown, `username → chat_id`, text batching to
   replace supersede-on-rapid-messages, proxy.
6. **`disable_notification`.** Small, but it needs a product decision (quiet hours? per-chat toggle?
   autonomous pings only?) rather than a default someone has to discover.

## 4.6 THIRD SWEEP — the COMPLETE gap inventory (2026-07-29)

§1's scorecard was an admitted major-feature diff. This sweep is mechanical and exhaustive on the
axes that can be enumerated: every one of Hermes' **236 `def`s**, its **28 `config.extra` keys**, its
**39 `TELEGRAM_*` env knobs** and its **49 test files**, each grepped against trunk. Everything below
was proven by reading our code, not by trusting §1 or §4.5.

**§4.5 CORRECTION — one row there is stale.** "typing 429 cooldown" is **NOT missing**: `hub.js`
`startTyping` already waits out `retryAfter` (capped 30s) and stops the loop entirely on a
non-retryable error. What we lack is only Hermes' *persistent per-chat* cooldown
(`_record_typing_cooldown` / `_typing_in_cooldown`), which survives across runs; ours resets each run.
That is a nuance, not a gap.

### NEW — found by this sweep, absent from every earlier list

| # | Gap | Why it bites | Size |
|---|---|---|---|
| N1 | **Outbound never carries `message_thread_id`.** `normalize` reads it only to suppress the forum-root reply trap; it is on no inbound event and no send. | In a **forum supergroup our answer lands in General, not the topic the member asked in**. Not polish — a wrong-destination bug. | S–M |
| N2 | **Outbound never carries `reply_to_message_id`.** Hermes has `reply_to_mode` + `_should_thread_reply`. | In a busy group our reply floats detached from the question. | S |
| N3 | **The P3 gates are unreachable.** `requireMention` / `ignoreBots` / `allowedUsers` are read in `adapter.js` but **`index.js` passes none of them** — they are hardcoded defaults with no command, no route and no UI. | P3 shipped a behaviour change (groups now answer only when addressed) with **no escape hatch**: a member who wants free response in their group cannot get it. | S |
| N4 | ~~**No `mention_patterns`**~~ **DONE** — see below. | "StarNet, summarise that" does not wake the bot — the most natural way to address it by name. | S |
| N5 | ~~**No `observe_unmentioned`**~~ **DONE** — see below. | When finally mentioned the agent has **no idea what the room was discussing** — the mention gate bought spend safety and paid in amnesia. | M |
| N6 | ~~**`edited_message` never arrives**~~ **DONE** — see below. | Fixing a typo in your question does nothing; the bot answers the typo. | S |
| N7 | ~~**`channel_post` never arrives**~~ **DONE** — see below. | The bot is **completely deaf** when added to a broadcast channel. | S |
| N8 | ~~**No reactions**~~ **DONE** — see below. | The cheapest possible "I heard you" — one API call, no message, no chunking. | S |
| N9 | ~~**No status indicator**~~ **DONE** — `setShortDescription` on the transport + adapter, written on connect/disconnect. Opt-in via `TELEGRAM_STATUS_INDICATOR` (with `TELEGRAM_STATUS_ONLINE` / `_OFFLINE`), **off by default exactly as in Hermes**, because it overwrites a public profile field the member may have written themselves. Capped at Telegram's 120 chars. | The bot's profile card never says whether the station is up. | S |
| N10 | **No link-preview control** (`disable_link_previews` / `_link_preview_kwargs`). | Any URL in a reply drags a full unfurl card. | XS |
| N11 | **No `deleteMessage`.** Hermes deletes its own transient progress/status messages. | Prerequisite for P4 streaming cleanup. | XS |
| N12 | **No `getChat` / `username → chat_id`.** | A member can only be reached by numeric id. | S |
| N13 | **No proxy and no DNS fallback.** `telegram_network.py` is a whole module: DoH discovery, `fallback_ips`, IP-rewritten requests, connect/pool-timeout classification and drain. | Ours is bare `fetch`. On a network that blocks `api.telegram.org` by DNS we simply never connect. | M |
| N14 | **Per-photo / per-text batching.** We debounce only a true `media_group_id` album; Hermes also batches loose rapid photos (`_photo_batch_key`) and text (`_text_batch_key`). | Three photos pasted one-by-one = three supersedes. | M |
| N15 | **No `send_path_health`.** Delivery events + durable outbox exist; nothing summarises "this chat's send path is degraded". | | M |
| N16 | **No `clarify_buttons` / `slash_confirm`.** We have consent + model-picker keyboards; the agent cannot ask a bounded multiple-choice question. | | M |
| N17 | **`TELEGRAM_API_BASE` is half a local-Bot-API-server story.** `apiBase` reaches both the method URL and `getFile`, so a local server would work — but it is env-only, undocumented, and there is no `base_file_url` / `local_mode` split, so the 2GB local-mode upload ceiling is unreachable (we still refuse at 50MB). | | S |

### Deliberate non-goals (do not build)

- **DM topics / home channel** (`_create_dm_topic`, `ensure_dm_topic`, `rename_dm_topic`, `_setup_dm_topics`,
  `create_handoff_thread`, `TELEGRAM_HOME_CHANNEL`) — Hermes mirrors every DM into a topic of one operator
  supergroup. That is a *fleet-operator* shape; StarNet's member owns their own station. Refuse on product
  grounds, not capability.
- **`sendRichMessage` / `sendRichMessageDraft`** — §3 already says probe-and-degrade, never a dependency.
- **Free-form outbound addressing** — known-targets-only stays law whatever Hermes does.
- **HTTP pool/closewait tuning** (`TELEGRAM_HTTP_*`, `test_telegram_closewait_limits`) — an httpx/PTB
  artefact; `fetch` + one long-poll has no pool to exhaust.
- **`_handle_gmail_triage_callback`** — an app feature of theirs, not a Telegram capability.

### The ranked queue after this sweep

**N1+N2 (thread + reply plumbing) → N3 (make the P3 gates reachable) → N6+N7 (the deaf update kinds)
→ N8 (reaction ack) → P4 streaming → N5 (observe-unmentioned) → N4 → the rest.**
N1 leads because it is the only remaining item that sends a message to the **wrong place**; everything
else above is a missing capability, not a wrong one.

**N1–N8, `my_chat_member` and P4 are all done** (below). What is left is breadth, not depth: **N14**
loose-photo/text batching, and **N9, N11–N13, N15–N17**. N10 (link previews) is worth stating precisely: the
transport already passes `link_preview_options` straight through from send opts, so the capability is
*reachable* today; what is missing is a product decision about the default, which is why no knob was added.
N11 (`deleteMessage`) shipped as part of P4.

### P4 — LIVE STREAMING (done, 2026-07-29)

The reply is written in front of you: the first sentences go out as a real message, and each throttle window
edits that same message with everything produced so far. The token deltas were already being accumulated in
one place (`state.buf += p.delta`), so that is where the stream is fed.

**The invariant, and the plan's own acceptance bar: exactly one complete reply, whatever fails.** Streaming is
an optimisation on top of `deliver()`, never a replacement, and every failure mode converges on the same place:

| Failure | What the member gets |
|---|---|
| Cannot seed (send failed, channel cannot edit) | `deliver()` sends normally; nothing was left behind |
| An intermediate edit 429s or blips | Skipped; the next window retries; the final edit carries everything |
| **The final edit fails** | The stranded partial is **deleted**, then the reply is sent whole — never half an answer sitting above the real one |
| The reply outgrows 4096 | Streaming stops at the limit; `deliver()` chunks as always, chunk 0 replacing the streamed message in place |
| The run is superseded / E-STOPped | The partial is deleted — it answers a question that was withdrawn |
| `message is not modified` | Treated as success: it means we streamed the exact final text |

Two design rules worth keeping:

- **`editMessage` and `deleteMessage` must BOTH be wired or streaming does not arm.** Arming the grow without
  the clean-up is precisely how a failed edit becomes a duplicate reply. That pairing is also what keeps this
  Telegram-only — no other transport supplies either, so the other four are byte-identical.
- **Never stream a protocol marker.** The reply the member reads is not always the raw buffer: a
  `TASK_QUESTION: …` answer is parsed, stripped and re-rendered as a numbered list with a keyboard. Streaming
  the buffer put the internal marker on screen for several seconds first. An opening ALL-CAPS token followed by
  a colon is a marker, not prose, so that run does not stream. **Found by the real-sidecar buttons e2e, not by
  a unit test** — the raw marker showed up on the wire.

`test/channels.telegram.stream.test.js`, 34 assertions, in `fast.list`, written as failure modes first.

### DONE from this sweep (2026-07-29, same lane)

- **N1 + N2 — thread and reply routing.** `normalize` reads `message_thread_id` (only for
  `is_topic_message`; a plain supergroup sets it on a reply chain too, and echoing that back aims at a
  topic the chat does not have). The hub keeps the route **ambient per chat** — bounded at 500 — rather
  than threading it through ~40 `deliver()` call-sites, so a command reply, a consent card and the run's
  answer all land in the same topic. The thread rides **every** chunk; the quote rides the first chunk
  and is then **consumed**, so a routine firing hours later still lands in the right topic without
  replying to a stale message. The typing bubble and outbound media follow the same route; the outbox
  redelivers into the thread but never re-quotes.
  Two floor-is-delivery guards: `allow_sending_without_reply` rides every quote (a deleted target is
  otherwise a 400 and the reply is LOST), and a closed/deleted topic gets exactly one retry to the chat
  root — rebuilt from the payload that actually failed, so a message that already fell back to plain text
  does not get its markdown syntax back on the way to General.
  `test/channels.telegram.threads.test.js`, 47 assertions, in `fast.list`.
- **N3 — the P3 gates are reachable.** `/mention on|off` (the `/approvals` shape exactly), persisted on
  the chat record, read by the adapter **per message** so a flip lands on the next one. `requireMention`
  now takes a string **or a function**, the same late-binding treatment `botUsername` needed; a throwing
  lookup keeps the gate ON, and a plain boolean still behaves identically. A DM says the setting is
  group-only instead of storing a value that can never apply. 16 new assertions in
  `channels.telegram.groups`.
- **N6 + N7 + `my_chat_member` — the deaf update kinds.** `ALLOWED_UPDATES` is a **subscription, not a filter**:
  a kind not named there is never delivered at all. It now names `edited_message`, `channel_post`,
  `edited_channel_post` and `my_chat_member` alongside `message` and `callback_query`.
  - **Edits** are flagged, not auto-run. An edit counts only when it edits the **last message we saw in that
    chat** — anything older is somebody tidying history, and a fresh boot with no record declines too. When it
    is accepted the turn carries a one-line correction label, because the original is already in history and two
    near-identical turns read to the model as the member saying two different things. The existing supersede
    rule then does the rest: correcting a question mid-run aborts the stale run and re-answers.
  - **Channel posts** carry no `from` at all, so `is_bot` cannot tell the bot's own post from an admin's.
    Unguarded that is not a cosmetic bug, it is an **unbounded loop** — every reply becomes a new question. The
    guard is an `adapter.js` set of the message ids **we** created (bounded, FIFO, keyed chat+id, platform-
    agnostic so any future echoing transport is covered). `author_signature` becomes the speaker name.
  - **`my_chat_member`** ships **with its consumer**, as §4.5 demanded: the chat is marked `unreachable`, which
    stops `deliver()` queueing for it and drops its existing backlog — each dropped item reported on the
    **existing** `channel.delivery` `redelivery-gave-up` event rather than inventing a name in the owned
    `shared/events.js`. The flag is lifted by the chat **speaking again** (proof), not by a `left` we might
    never be sent.
- **N8 — reaction ack.** 👀 on the question while the run thinks, cleared when the answer lands, on the same
  lifecycle as the typing bubble. Unlike the bubble it survives the member closing the app. Transport-optional
  and entirely cosmetic; the emoji is a **constant** because bots may only use Telegram's fixed reaction set.
  The clear **waits for its own set** — a clear that overtakes it leaves a 👀 stuck on an answered question,
  which is the app asserting state the harness can't prove.
  `test/channels.telegram.updates.test.js`, 59 assertions, in `fast.list`.
- **N4 — wake words.** Being called by NAME is being addressed. The bot's own display name (from `getMe`) and,
  for an agent-bound bot, the agent's name, both read lazily. **Literal strings, not the reference harness's
  regexes**: a regex from a config field is a ReDoS surface pointed at the poll loop and a footgun for anyone
  who mistypes one. Word-boundary, case-insensitive, minimum three characters (a two-letter agent name would
  trigger on half the room). It only ever WIDENS addressing, so a bad pattern costs an extra run, never silence.
- **N5 — observe-unmentioned.** `admission()` now returns three verdicts, not two: `drop`, `run`, and
  **`observe`** — heard and filed in the transcript, never dispatched. The hub's observe branch sits **above**
  command parsing (an unmentioned `/deploy@someotherbot` must not be executed by us), above the belt crate,
  above typing, above the reaction: zero model calls by construction, not by a check further down. Attributed
  ("Ana: …") because knowing who said what is the entire value, and bounded for free by `appendTurn`'s trim.
  **Default OFF**, as in Hermes — storing every message a room sends is the member's decision, and observing
  can never bypass admission (echo, bot-sender and allowlist are all refused before anything is stored).
  `/mention` is now three-state — `on` / `observe` / `off` — and writes both fields together, so a chat can
  never end up answering everything *and* filing it twice. 28 new assertions in `channels.telegram.groups` (89).

  Still open under N3: `ignoreBots` and `allowedUsers` remain construction-time only. `ignoreBots` is
  arguably correct as a constant (bot-to-bot is an unbounded spend loop, not a preference); `allowedUsers`
  wants a real UI, not a chat command, because it is a security control.

## 4.7 LIVE VERIFICATION — 2026-07-29, against api.telegram.org

Everything above was proven with fakes. This section records what has now been run against a **real bot**
(`@bottest173bot`), driving the **real `telegram.transport.js`** rather than curl, and — just as important —
what is still unproven and why.

### Proven live

| Path | Evidence |
|---|---|
| `getMe` | Real id / username / display name through our own transport. |
| **Privacy mode** | `can_read_all_group_messages: false`. See below — this found a real bug. |
| `setCommands` | Published the hub's real 13-command table; `getMyCommands` read it back **in the same order, `/mention` included**. A true round-trip. |
| **Multipart encoder** | `sendPhoto`, `sendDocument` (filename containing a quote *and* a newline) and a 2-item `sendMediaGroup` all reach **`chat not found`** — i.e. Telegram *parsed* our hand-rolled body and got to chat validation. A framing bug answers differently. |
| Error normalisation | `send`, `editMessage`, `deleteMessage`, `setReaction`, `sendChatAction`, `getFile` all return the normalized shape carrying Telegram's real description. |
| **Token redaction** | No answer from any path contains the token. |
| **409 conflict** | Two concurrent pollers on one token: both got the real `Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`, and our transport reported `fatal:true`, `code:409` and the rewritten actionable message. That sentence is now a **live-captured fixture** in `channels.telegram.test` — an invented string can only prove the code matches itself. |
| `deleteWebhook`, `getWebhookInfo` | Clean; the webhook slot is empty and `allowed_updates` reflects our new six-kind subscription. |

### ⚠ THE BUG LIVE TESTING FOUND — privacy mode

`getMe` reports `can_read_all_group_messages: false` by default. With privacy mode ON a group delivers a bot
**only** slash commands, `@username` mentions, and replies to its own messages. So:

- **N5 observe-unmentioned receives nothing.** Ordinary chatter never arrives.
- **N4 wake words cannot fire at all.** A bot's *name* is not an `@mention`.

`/mention observe` would have confirmed "I read the rest of the room" — the app asserting state the harness
cannot deliver. Fixed: the flag now travels with the identity from `getMe`, and `/mention` names both the
limitation and the fix (@BotFather → `/setprivacy` → Disable). A second, subtler bug in that fix was caught by
an existing deep-equal on `getMe`'s shape: a **missing** field was being coerced to `false`, claiming a
limitation we had not been told about. Absent now means unknown, and unknown says nothing.

### Proven live in a REAL chat (a DM, after the first inbound message)

Every one of these was driven through `telegram.transport.js` against a real chat, not a fake:

| Path | Result |
|---|---|
| `setReaction` 👀 on the member's own message, then cleared (N8) | `ok` / `ok` |
| `sendChatAction` | `ok` |
| **Reply-quote + markdown→HTML** (N2) | `ok`, quoting their message |
| **Streaming (P4)**: seed → 3 in-place edits | all `ok`; the message visibly grew |
| **`message is not modified`** on an identical re-edit | Telegram's real sentence — matched by our `notModified()` and treated as success, exactly as designed |
| **Multipart photo** (P1) | `ok` once given a *valid* PNG — see below |
| **Multipart document** | `ok` |
| **`sendMediaGroup`**, 3 photos via `attach://` | `ok`, `count: 3` |
| `deleteMessage` (N11) | `ok` |
| **Thread fallback fired for real** | a `threadId` that cannot exist in a DM → first attempt refused, resent to the chat root, and the result carried **`ok:true, threadGone:true`** — the N1 fallback *and* the stale-binding prune, both live |

**One false alarm worth recording:** the first photo attempt returned `IMAGE_PROCESS_FAILED`. That was a
corrupt hand-written PNG fixture in the *probe*, not a transport bug — the document upload through the same
encoder succeeded in the same run, and a properly built PNG then went through cleanly. The encoder is fine;
the lesson is that a hand-rolled binary fixture is worth generating rather than typing.

### THE INBOUND HALF — PROVEN LIVE (2026-07-30)

Closed with a **real sidecar polling real `api.telegram.org`**, booted from env onto an isolated workspace with
a local zero-cost model, so it touched neither the station's config nor a paid provider. A real message
("what can u do") sent from a phone produced, in order:

- `telegram auto-started from env` → `telegram channel connecting…` — the poll loop, with the new six-kind
  `ALLOWED_UPDATES`, against the real API;
- `telegram owner claimed (userId …) — other DMs are now refused` — a **real** update parsed by `normalize`
  and admitted, with trust-on-first-use firing;
- a run recorded in `runs.jsonl` as `reason: done, turns: 1, usd: 0`;
- the assistant turn persisted in `channels/tg_<id>.history.json`;
- **no outbox file created at all** — the hub queues every failed delivery there, so its absence is the proof
  the reply actually reached Telegram.

That closes the last gap in this plan: **both halves of the channel are now verified against the real
platform**, not only against fakes.

### Historical — what this section said while it was still open

The outbound half is now done. What remains is the inbound half, and it is blocked on something simpler than
it looks: **nothing in StarNet is polling this token.** The bot has never been added to a station (no
`telegram.token` in any channel-secrets file), so a message to it reaches no hub and gets no reply. Open until
it is connected in the app's Messaging tab: inbound admission end to end, a real run and its reaction ack,
streaming on real model output, voice-note STT, album batching, `edited_message`, `channel_post` + the echo
guard, `my_chat_member` on a real block, and thread routing inside a real forum topic. That last one also
needs a forum supergroup; the group features additionally need privacy mode disabled (§4.7).

## 4.8 N14 TEXT BATCHING — BUILT, THEN REVERTED ON PURPOSE

Their `text_batching` is not "merge chatty messages": Telegram clients **split a long paste into several
messages**, and our one-run-per-conversation rule then makes each part abort the previous part's run. A
three-part paste is two wasted runs the member paid for. Real, and worth fixing.

It was built (batch only while a run is already in flight, so an idle chat keeps answering instantly) and
**reverted**, because it breaks an invariant `sidecar/index.js` states in a comment right where it matters:

> "The hook fires in onInbound's first synchronous slice (before any await, so before the run starts) … If the
> hub ever moves resolution behind an await, tgResolved stays null here and we honestly place NO crate."

Batching puts exactly such an `await` in front of `processInbound`, so a batched message silently loses its
**belt crate** and the prior crate never gets its `workitem.superseded`. `atlas-events.emit.e2e` caught it.
Losing floor telemetry for every rapid message is a worse bug than the one batching fixes.

**The fix this needs, when it is taken as its own lane:** move the crate placement in `index.js` out of the
post-`onInbound` synchronous read and into the `onResolved` **callback** — where the agent id is genuinely
known, whenever that happens. That is belt-telemetry surgery with its own e2e, not a tail-end change to a
Telegram lane. Until then N14 stays open, and the cost is bounded: a split paste burns one extra aborted run
per part, and no content is lost (each part is already persisted as its own user turn, and consecutive user
turns are merged by the provider adapter).

## 4.9 FINAL SCORECARD — all 49 of their Telegram tests, mapped (2026-07-29)

§1's scorecard is now historical. This is the answer to "are we as good as Hermes as a Telegram adapter",
row by row against their **49 test files**, judged on behaviour rather than on whether we copied their design.

### HAVE — 38 of 49

`approval_buttons` (ours is bounded + token-resolved; theirs leaks and FIFO-crosses) · `auth_check` ·
`bot_auth_bypass` · `callback_auth_fail_closed` · `caption_merge` · **`conflict` (live-verified)** ·
`documents` · `error_redaction` · `format` · `init_deadline` · `max_doc_bytes` · `model_picker` · `network` ·
`network_reconnect` · `pending_update_probe` · `start_polling_timeout` · `typing_backoff` ·
`audio_vs_voice` · `voice_v0_regressions` · `group_gating` · `mention_boundaries` · `noise_filter` ·
`channel_posts` · `reactions` · `reply_mode` · `reply_quote` · `topic_mode` · `thread_fallback` ·
`prune_stale_topic_binding` · `progress_edit_transient` · `overflow_partial` · `clarify_buttons`
(our TASK_QUESTION keyboards) · `status_indicator` · `status_update` · `username_chat_id` (we never coerce a
chat id to a number, so an `@name` passes straight through) · `managed_bot` (multi-bot) ·
`rich_messages` / `rich_newlines` (the subset our converter can prove safe, with a plain-text floor).

### DELIBERATE DIFFERENCES — 6, all documented above

- `send_draft_format`, and the rich-draft half of `rich_messages` — §3: probe-and-degrade, never a dependency.
- `webhook_secret` — StarNet is local-first; long-poll is the correct transport, not a limitation.
- `closewait_limits` — an httpx/PTB pool artefact. `fetch` + one long-poll has no pool to exhaust.
- `slash_confirm` — a formatting regression guard for a Hermes-specific feature, not a capability.
- `photo_interrupts` — they QUEUE a photo that lands mid-run; we SUPERSEDE. Ours is the documented
  one-run-per-conversation rule, and no content is lost (the earlier turn is already in history). The
  pathological case they were guarding, a multi-part photo drop, is handled by our album debounce.
- `relay_roundtrip_telegram` — their gateway's own plumbing.

### GENUINELY OPEN — 5, and none of them is a correctness bug

| | Why it is still open |
|---|---|
| `text_batching`, `text_batch_perf` | Built and reverted — §4.8. Blocked on belt-telemetry surgery, not on Telegram. |
| `send_path_health` | Partly covered now (`unreachable` chats, the durable outbox, `channel.delivery`). Their specific case is a wedged httpx pool; we have no evidence of the `fetch` equivalent, so building a detector for it would be guessing. |
| `forum_commands` | We publish one global command menu, which works inside topics; they re-register lazily per forum. |
| proxy | Environment-specific; nothing in the product needs it yet. |
| N12 `getChat` | The Bot API cannot resolve an arbitrary **user** @username to a chat id at all — only public chats. Half of this is a platform limit, not a gap. |

### The verdict

**On capability, yes** — every row that a member could feel is HAVE, including the three that mattered most
and were missing a day ago: the reply lands in the topic it was asked in, it is written live in front of you,
and the bot is no longer deaf to edits, channel posts or being blocked. What is left is breadth with a
documented reason.

**On proof, done.** Everything is gated (`test:fast` 436 steps, `test:http`, 8 Telegram suites, every fix
revert-proven) and the transport half is now verified against the real Bot API (§4.7). The inbound half —
thread routing into a real topic, streaming edits on a real run, voice STT, the channel-post echo guard,
`my_chat_member` — is **still fake-proven only**, because a bot cannot start a conversation and no one has
messaged the test bot yet. That gap is honest and it is the last one.

## 5. Honest sizing

P1–P3 are the ones a member would notice tomorrow, and they are mostly wiring over engines we
already own. P4 is the one that changes how the product *feels* and is where the real
engineering risk sits (rate limits, partial state, overflow). P5–P6 are breadth.

This is a multi-lane program, not a single sitting. Recommended order:
**P6-redaction → P1 → P2 → P3 → P4 → P5 → rest of P6.**
