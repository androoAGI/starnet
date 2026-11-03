---
fingerprint: 2f7b280c
slug: muting-the-speaker-mid-reply-in-hands-free-nulls
title: Muting the speaker mid-reply in hands-free nulls the only surviving rearm heartbeat — the mic never re-opens while the mode button still reads 'hands-free ON'
surface: voice
severity: P2
status: fixed
found: 2026-07-28
lane: sweep/voice
fix: 50a8b07b
---

# Muting the speaker mid-reply in hands-free nulls the only surviving rearm heartbeat — the mic never re-opens while the mode button still reads 'hands-free ON'

## Symptom

In hands-free voice mode, the user mutes the speaker (🔊) while the agent is still speaking. Audio stops as intended — and the mic never re-opens again. The station sits at status 'online' with the mode button still reading 'voice mode: ON (hands-free) — click for push-to-talk'. The conversation is dead until the user notices and clicks the mic. The UI asserts a live hands-free loop the runtime no longer has.

## Repro

rig with the recorder STT path: Voice.toggleVoiceMode() → transcript sends → speakChunk x2 → endReply() + onTurnEnd() (chat.js's real order) → while audio is playing, click the real speaker button (nodes['voice-toggle'].onclick()). After 600ms: convoMode=true, listening=false, modeBtn.title='voice mode: ON (hands-free)', status='online' — the mic never re-opens. Control: the identical mute BETWEEN turns leaves listening=true. Baseline: without the mute, listening=true after the reply drains.

## Evidence

`frontend/app/voice.js:648`

**Mechanism (read from the code):** The rearm heartbeat has exactly two triggers: chat.js:6151 `Voice.onTurnEnd()` at run teardown, and the queue's own `onReplyDone` callback fired from finishReply (voice.js:582). onTurnEnd normally lands FIRST, while audio is still draining, and maybeRearm bails at voice.js:700 (`if (busyNow() || listening || talking()) return;`) — by design, so the mic can't open into the agent's own voice. That leaves `onReplyDone` as the only remaining trigger. `toggleSpeakReplies()` (voice.js:1152) calls `stopSpeaking()`, which does `onReplyDone = null;` (line 648) and then `resetQueue()`. The one surviving heartbeat is discarded while convoMode is still true, so nothing ever calls maybeRearm again. Note stopSpeaking's other callers all cover themselves — onMicClick re-arms after 150ms (line 1085), stopConvo/init exit the mode — so the mute path is the one leak.

**Existing test coverage:** none found — no test in test/ drives convoMode at all (grep for toggleVoiceMode/inVoiceMode/convoMode over test/*.js returns only a comment in voice.draftguard.test.js:6). voice.button.test.js covers mic-button wedges in push-to-talk only.

**Adversarial verdict (survived refutation):** Confirmed by grepping every maybeRearm producer in frontend/app/voice.js — there are exactly two: onReplyEnded (683, reached only via the onReplyDone heartbeat at 582/635) and onTurnEnd (685), plus handleEmptyListen:749 which needs an active listen. chat.js:6143-6151 calls Voice.endReply() and Voice.onTurnEnd() back-to-back in the SAME synchronous block, so onTurnEnd lands while audio is still draining and maybeRearm bails at voice.js:700 (`if (busyNow() || listening || talking()) return;`; talking() at 697 includes `draining`). That leaves onReplyDone as the sole surviving trigger, and voice.js:648 inside stopSpeaking() sets `onReplyDone = null` before resetQueue() (649). toggleSpeakReplies (1148-1156) calls stopSpeaking() at 1152 when muting and never touches convoMode, never calls reflectMode, never schedules a rearm — unlike onMicClick:1085 (150ms re-arm) and stopConvo:729-743 / init:1174 (which exit the mode). So convoMode stays true, listening stays false, rearmTimer is null, and nothing can call maybeRearm again. reflectMode:1125-1127 therefore keeps painting 'voice mode: ON (hands-free) — click for push-to-talk', and setSpeaking(false) at 1111 writes 'online'. Test claim verified: grep for toggleVoiceMode/inVoiceMode/convoMode across test/ returns zero driving tests. Recoverable by a mic click (onMicClick:1086), which is why P2 is the right rank, not higher.

_Found by the `sweep/voice` lane, 2026-07-28. Finder confidence: high. Severity claimed P2, after refutation P2._

## Verdict

Confirmed as found. 50a8b07b fixed the mute path with a special case: muting called muteStopSpeaking, which re-armed the loop by hand, and `test/voice.button.test.js` pins that the mic re-opens after a mute mid-reply.

The family stayed open: a cancel still threw the reply's end heartbeat away, and only the paths that re-armed by hand recovered. On the lane's base, a playing reply cut by the mic button, by a plain stopSpeaking() or by setSpeakReplies(false) never fired its endReply callback. The voice-reply-handles-and-speaker-lease lane closes the family. A spoken reply is now a handle from send to its last sentence (`frontend/app/voice-state.js`). Every reply ends in exactly one terminal state, done or cancelled with a typed cause, and fires its heartbeat exactly once on every path. The heartbeat fires after the queue is torn down, so the re-arm never sees the reply that just ended. A mute is one more cancel (speaker_off), and muteStopSpeaking is gone.

The class invariant is `test/voice-reply-lifecycle.invariant.test.js` (I3). In hands-free it runs every way a reply ends on its own: a natural end, a skipped sentence, the cooldown, a playback error, a refused autoplay and a stalled clip. It also runs six cancels across both scopes, the mute included, each on a reply still thinking and on one speaking, before and after endReply. Every run must fire the heartbeat exactly once, re-open the mic exactly once (never, once hands-free is off) and account for every chunk, and every cause in CANCEL_CAUSES ends a reply exactly once. On the lane's base the cancel rows fail: the heartbeat never fired, no cancel was typed and the cancelled chunks vanished.
