---
fingerprint: 600f4982
slug: e-stop-silences-the-channel-reply-path-via-the-s
title: E-STOP silences the channel reply path via the supersede flag, so a deliberately stopped run is indistinguishable from a crashed bot on the phone
surface: channels
severity: P2
status: fixed
found: 2026-07-28
lane: sweep/channels
fix: 96fe108d
---

# E-STOP silences the channel reply path via the supersede flag, so a deliberately stopped run is indistinguishable from a crashed bot on the phone

## Symptom

Someone starts a long task from Telegram. The Commander hits E-STOP in the station. The typing bubble expires and the chat receives absolutely nothing — no reply, no partial, no "stopped". On the one surface with no floor, no browser and no other signal, a deliberate stop is byte-identical to a crashed bot. /stop typed from the phone, by contrast, answers "Stopped the run in progress."

## Repro

scratchpad/probe-estop.js — a hub whose runOnce parks mid-run, then `killAll(null, hub._internals.inflight)` (exactly what handleHalt does at index.js:12162), then release. Output: `E-STOP aborted 1 channel run(s)` / `messages the phone received after E-STOP: []` / `inflight map size after: 0`. Live equivalent: DM the bot a long task, click E-STOP in MISSION CONTROL, watch the chat.

## Evidence

`sidecar/channels/hub.js:942`

**Mechanism (read from the code):** E-STOP reuses the supersede flag, which already means something else. halt.js:25 does `rec.superseded = true; if (rec.abort ...) rec.abort.abort();` and hub.js:942 (and again at 1007) does `if (myRec.superseded) return;` — an unconditional silent return before any deliver(). That return is correct for the meaning the flag was built for (a NEWER message owns the conversation and is about to answer, so the stale partial must not ship), and wrong for E-STOP, where nothing else is coming. One flag, two orthogonal meanings, read by two unrelated producers — the same shape as finding 2. Nothing else covers the gap: handleHalt (index.js:12149-12191) posts no channel notice, and the run's own reply path is what just returned.

**Existing test coverage:** test/channels.hub.test.js:157-158 covers the supersede-by-newer-message case and asserts the silence is CORRECT there ('only the latest message is answered (first run superseded, no partial sent)'), which is why the E-STOP case inherits it. test/halt.test.js asserts only killAll's counts and that hub runs are marked superseded before aborting; it never looks at what the chat receives. None found for the E-STOP-to-chat path.

**Adversarial verdict (survived refutation):** Confirmed by reading and by probe. halt.js:25 sets `rec.superseded = true` then aborts; hub.js:942 and hub.js:1007 are unconditional `if (myRec.superseded) return;` ahead of every deliver(), and handleHalt (index.js:12149-12190) posts no channel notice — it only counts and stands down cron/night-shift/loops. I drove the real hub with the real killAll (scratchpad probe): `E-STOP aborted 1 channel run(s)` / `messages the phone received after E-STOP: []`. The contrast is real: /stop answers from the command handler itself (hub.js:513-520 'Stopped the run in progress.'), which is why it is not affected. The silence is half-deliberate — hub.js:940-941 names E-STOP at that return — but the justification written there ('the newer message owns the conversation now and is running its own replacement') is false for E-STOP, where nothing else is coming, so this is a gap rather than a stated design. Existing tests cannot catch it: test/channels.hub.test.js:158 asserts the silence is CORRECT for the supersede-by-newer-message case, and test/halt.test.js only checks killAll's counts and superseded-before-abort. One detail in the claim is wrong and harmless: the typing bubble is stopped properly (the `return` unwinds through the finally at hub.js:1072), it does not linger to expiry. P2 is right — the chat is told nothing, but nothing false is asserted.

_Found by the `sweep/channels` lane, 2026-07-28. Finder confidence: high. Severity claimed P2, after refutation P2._

## Verdict

Confirmed and fixed in `96fe108d`. Channel runs now distinguish E-STOP from ordinary supersession: both abandon stale partial output, but E-STOP delivers one explicit stopped notice while a newer-message supersede remains silent. The real hub/kill path is locked by `channels.hub.test.js` (124 assertions).

## Family

Closed as a family by the channel-delivery-ledger lane. No user-visible defect remained here, but the mechanism had grown: a run's ending was four flags with three writers, where one flag carrying two meanings had been the bug. A withdrawn run now carries one endReason ('superseded', 'stopped', 'halted' or 'faulted'), and the first one written stands. hub.js and routing/steptest.js read only that.

The invariant: the ending half of `test/reply-assembler.census.test.js` (no run-end flag is read or written in hub.js, steptest.js or halt.js, and nine ways a run is withdrawn, each with its endReason and exactly what the chat is told), with `test/halt.test.js`.
