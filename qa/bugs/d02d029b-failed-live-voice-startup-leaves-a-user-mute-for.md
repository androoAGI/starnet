---
fingerprint: d02d029b
slug: failed-live-voice-startup-leaves-a-user-mute-for
title: Failed Live Voice startup leaves a user mute force-enabled
surface: voice
severity: P2
status: fixed
found: 2026-07-31
lane: agent/voice-release-sweep
fix: 8bc9ff9a
---

# Failed Live Voice startup leaves a user mute force-enabled

## Symptom

Starting Local Live force-enables speech so a hands-free session cannot open silently. If microphone
startup then fails, the session closes but the speaker remains enabled even when the user had muted it
before starting.

## Repro

1. Mute the speaker.
2. Start Local Live and deny microphone permission (or make microphone startup throw).
3. Before the fix, `start()` called `Voice.forceSpeakOn()` and its catch block detached the coordinator
   but never called `Voice.restoreSpeak()`.

## Evidence

The failure path in `frontend/app/voice-live.js` had no preference restoration while the normal
`finish()` path did. `test/voice-live-ui.test.js` now pins `Voice.restoreSpeak()` inside the startup
failure teardown, in addition to the existing normal-finish assertion.

## Verdict

Fixed by restoring the speaker preference in the startup catch path. `restoreSpeak()` only reverses
the automatic force-on state, so a speaker choice changed manually during startup remains respected.

## Regression

The voice-reply-handles-and-speaker-lease lane closes the family this was one member of: a voice
session wrote the speaker's one saved value, so its force could outlive it. A page that died mid-call
reloaded speaking because the forced '1' was saved, and a legacy hands-free loop's restore muted a
Local Live call opened over it. restoreSpeak is gone. A Local Live call now borrows the speaker with a
lease that lives in memory and is never saved, and every way a call ends, a refused start included,
gives the lease back through Voice.endSession.

`test/voice-speaker.property.test.js` (I2) runs refused starts among seeded sequences of every speaker
writer, reloads included. After every step it checks that the saved setting is the Commander's last
explicit choice, and that the speaker is on only for that choice or for a session still holding it. On
the lane's base the saved-setting law broke in 42 of 42 sequences and the on/off law in 26.
`test/voice-live-ui.test.js` now pins `Voice.endSession('live_start_failed', { lease: 'live', scope: 'audible' })`
in the refused start, where it used to pin `Voice.restoreSpeak()`.
