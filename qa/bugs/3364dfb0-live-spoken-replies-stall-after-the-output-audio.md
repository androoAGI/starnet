---
fingerprint: 3364dfb0
slug: live-spoken-replies-stall-after-the-output-audio
title: Live spoken replies stall after the output audio context closes
surface: voice
severity: P1
status: fixed
found: 2026-09-10
lane: agent/live-speech-0910
fix: f129e19e3
origin: customer
report: Customer report relayed by owner on 2026-09-10: chimes restored but agent live speech keeps failing
affected: New update; exact customer build and platform unknown
family: speech-device-recovery
installer: unverified
recovery: unconfirmed
---

# Live spoken replies stall after the output audio context closes

## Symptom

Customer reports that chimes were restored but live agent speech keeps failing. The exact customer failure is not yet correlated. A related speech-device lifecycle defect is independently reproduced below.

## Repro

1. Launch a disposable station with `node dev/seed.js --keep` and enable spoken replies.
2. Speak a sentence using real `/api/tts` audio and wait for playback completion.
3. Close the speech AudioContext to model a lost output graph, then speak another sentence.
4. Before repair, the second media element stays at currentTime 0 with no ended/error event. The effects graph still reports closed.

## Evidence

Seeded browser at port 9297 on baseline 4db93cb7d: initial audio ended at 2.832 seconds with context running. After closure, context remained closed, second audio stayed at time 0, and speech diagnostics were empty. After repair the contexts were closed/running and the second audio ended at 3.696 seconds. Real Edge synthesis returned 13,968 bytes; local Kokoro returned a 216,044-byte WAV after its initial model load. Browser playback was measured in headless Chromium, not heard on physical speakers. Regression anchor: test/voice.button.test.js.

## Verdict

Source repair replaces closed transmission/shell graphs and leaves audio on native playback while an effects context cannot resume. Repeated gestures retry suspended/interrupted contexts. Installer and customer recovery remain unverified; this mechanism must not be represented as a confirmed diagnosis of the reporter's machine.

## Regression

Before: the real browser stalled at time 0 after closing the speech graph. After: the same reproduction completed the second reply. test/voice.button.test.js exercises both shell and transmission replacement and rejected resume for suspended/interrupted devices without capturing native output. Focused suite 140 assertions, customer journeys 34/34, and full fast gate 762/762 passed on 0a250ae40. Receipt: qa/live-speech-device-0910.md.

## Sibling coverage

{
  "adapters": [{"target":"Transmission and machine-shell Web Audio","state":"covered","test":"test/voice.button.test.js","scenario":"closed graph replacement and suspended/interrupted resume rejection with native playback","gate":"fast"},{"target":"Provider-native realtime voice","state":"blocked","reason":"Separate realtime playback path; no customer mode, provider account or exact failing artifact supplied."}],
  "entrypoints": [{"target":"Shared spoken reply queue used by COMMS and Local Live","state":"covered","test":"test/voice.button.test.js","scenario":"real Voice.speak entrypoint completes before and after device graph closure","gate":"fast"}],
  "displays": [{"target":"Seeded Chromium","state":"blocked","reason":"Live CDP reproduction passed, but this browser/device test is not registered in the fast/http manifests."},{"target":"Installed Windows and macOS hardware","state":"blocked","reason":"Customer build/platform is unknown; no installer or physical speaker acceptance performed."}],
  "lifecycle": [{"target":"Output context closure, suspension and interruption","state":"covered","test":"test/voice.button.test.js","scenario":"both effects chains replace closed graphs and preserve native output on rejected resume","gate":"fast"}]
}
