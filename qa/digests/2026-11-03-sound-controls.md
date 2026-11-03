# Separate hum and heartbeat controls

Owner request, 2026-11-03: keep useful clicks and completion chimes while independently disabling the hum and heartbeat. This is a sound-preference feature request; no speaker defect or customer recovery is asserted.

Candidate: `agent/sound-controls-1103`, implementation `24222f1ba`, based on `e1925caed`.

- SETTINGS â†’ LOOK & SOUND adds BACKGROUND HUM and HEARTBEAT switches. TERMINAL AUDIO remains the existing master mute.
- Separate gain buses fade out already-playing awakening pads/pulses. New notes respect each choice; UI and completion cues keep their existing routing.
- Existing defaults and master-mute preferences are preserved. Saved settings, station backup collection and chat look controls include both choices.
- Release copy: [next update sound controls](../../docs/releases/next/SOUND_CONTROLS.md).

## Verification

- Syntax checks passed for all changed application JS and the new regression.
- Focused tests passed: sound-controls, comms-press-sound (30 assertions), settings-p1-ui (75 assertions), settings-save-failure.
- Registered `test/sound-controls.test.js` in `test/fast.list`: separate buses, active-tail mute, independent repeat scheduling, master mute, useful clicks/completion/attention cues and backup collection.
- Dev-seeded running app on isolated port 9327: actual Settings controls drive Web Audio, muted ambience approaches zero while the completion chime remains measurable. Reload and sidecar restart preserve the selected switches. New controls use theme colours. [Measured live receipt](../evidence/sound-controls-1103/live.json).
- Reproducible browser proof: `node dev/sound-controls-proof.mjs`; after restarting the same seeded app with `--keep`, add `--restart` to require prior preferences before modifying them.
- Customer journeys passed all 38 steps. The first full fast attempt passed 467 steps, then failed the stale candidate-source lock at qa-product-perfect-claims; cancelled after the recorded assertions. Refreshing the mechanical source manifest and rerunning the complete gate.

The completion probe sends a synthetic done-task event through the real audio Director; it does not claim a provider run. Browser audio was measured through Web Audio, not heard through physical speakers. Packaged installer, customer retest, integration and publication remain unverified.
