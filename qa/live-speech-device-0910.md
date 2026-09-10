# Live speech output recovery — 2026-09-10

Source commit: `f129e19e3`, based on `4db93cb7d`. Customer record: `3364dfb0`.

The reported symptom is live speech failing after chimes were restored. The reporter's
mode, platform, exact build and error are unknown. The following defect is reproduced,
not inferred to be the confirmed cause on their machine.

The speech transmission and machine-shell effects graphs cached their ready state after
their AudioContext closed. Subsequent media elements were connected to that dead graph,
which took away native output and stalled playback at time zero without an ended/error
event. Chime recovery does not affect these separate graphs.

Both graphs now rebuild after closure. Suspended/interrupted contexts attempt resume;
until running, the new element keeps native playback instead of being captured into a
silent graph. Resume promise rejection is handled. Capture-phase gestures remain active
to retry recovery after the initial audio unlock.

## Live evidence

Disposable station launched with `node dev/seed.js --keep`, port 9297, isolated workspace.
Real Edge and local Kokoro `/api/tts` requests returned MP3 and WAV audio respectively.
No provider credentials or production station settings were changed.

CDP instrumented the real browser AudioContext constructors and media-element ended
events; it did not substitute synthesized audio. Baseline shell playback ended at
2.832 seconds. After closing the graph, the next element remained at time 0, with the
only context closed and no speech diagnostic. With the repair, the second element ended
at 3.696 seconds and a new running context replaced the closed graph.

The transmission sibling was exercised by making the optional shell constructor fail.
Its replacement also ended at 3.696 seconds. Suspending the replacement and rejecting
resume left that context suspended while native playback completed at 2.832 seconds;
`Voice.isReplyPending()` returned false. These are browser engine/output proofs in
headless Chromium, not an acoustic or installed-WebView claim.

## Validation

- `test/voice.button.test.js`: 140 assertions passed, including both graph replacements
  and rejected resume for suspended/interrupted devices.
- JavaScript syntax and `git diff --check`: passed.
- Customer journeys: 34/34 passed.
- Bug register validation: passed.
- Full fast gate: pending.

No installer was built or published. Customer recovery and hardware acceptance remain
unverified. Already-playing audio interrupted mid-sentence and provider-native realtime
audio are outside this new regression's measured scope.
