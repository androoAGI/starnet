---
fingerprint: 4dee26ba
slug: internal-title-and-goal-self-talk-is-stored-as-c
title: Internal title and goal self-talk is stored as Commander dialogue in the global transcript and recalled as such
surface: sessions
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/sessions
fix: 284b20ed0
origin: audit
---

# Internal title and goal self-talk is stored as Commander dialogue in the global transcript and recalled as such

## Symptom

The station's own reason-only calls are sent with `internal: true` and no stream: the session-title summary
(`chat.js` maybeRetitle) and `INTERNAL — GOAL DECOMPOSITION`. Each is written to the durable transcript as a
`user` turn plus an `assistant` turn under the shared `global` stream. `recall_conversation` then returns those
rows to the agent as the Commander's dialogue, for example `[global · user] echo session uniqueword quokka Assistant reply (context only): …`.
The rows also keep a deleted session's opening line alive outside that session's stream (see 3e926b6a).

## Repro

1. Seeded sidecar with a mock provider. Send a few ordinary messages in new sessions so each one gets an auto-title call.
2. `GET /api/transcript?agent=agent&stream=global&limit=50`.
3. Have the agent call `recall_conversation {"query":"<a word from one of those messages>","scope":"all"}`.

## Evidence

Live on 2026-10-20, `GET /api/transcript?stream=global` → 16 turns, starting:

```
"user: bravo session about yaks\n\nAssistant reply (context only): Mock Title","assistant: Mock Title",
"user: charlie session about xylophones\n\nAssistant reply (context only): Mock Title","assistant: Mock Title", …
"user: INTERNAL — GOAL DECOMPOSITION. Do not run any tools. Reason only, then reply in the exact ", …
```

The `recall_conversation` result the provider received listed
`1. [global · user · t=1792475986998] [id=tx-21] echo session uniqueword quokka Assistant reply (context only): Reply to: …`
as a user turn.

Sources: `sidecar/index.js:20096` (`const internal = !!o.internal || !!o.outputOnly; // … no memory/transcript injection`)
gates only the reads. The writes go through `makeRunTranscript` (`sidecar/index.js:21841`) and the run-end append
with no `internal` check. `nightshiftContextPack` already treats internal run titles as exclusion markers, but the
recall tool reads the rows directly.

## Verdict

Fixed in `284b20ed0`, with review follow-ups `5a7ac3900` and `d76f3ca0c` (2026-10-23; all ancestors of trunk, first released in v0.14.0). A streamless internal run's rows are stamped dispatchState 'internal' on both transcript writers; search, scroll and the browse preview skip them, and also the shapes a 0.13.5 station already filed in global (title and goal-judge prompts and their replies, learned by run id). Nothing is deleted. recall_conversation no longer quotes the station's self-talk as the Commander's words. Regression: test/transcript-selftalk.test.js and test/selftalk-transcript.http.test.js (both pass on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).

## Notes

Not fixed in the lane. Skipping transcript writes for internal runs touches the run journal's `transcriptAck`
retirement path in the `index.js` hotfile and needs an http-level regression test. The fix is to keep `internal`
self-talk with no stream out of the transcript, or to filter it in `recall_conversation`.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._
