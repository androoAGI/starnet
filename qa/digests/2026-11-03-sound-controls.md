# Separate hum and heartbeat controls

Owner request, 2026-11-03: keep useful clicks and completion chimes while independently disabling the hum and heartbeat. This is a sound-preference feature request; no speaker defect or customer recovery is asserted.

Integrated at `1c2cc3af80c4ab7fd9a2767fe250867fd5db4972` from candidate `f644205b1b9a3bb50065e37c24f90be57f690bb6`. The merge tree exactly equals the tested candidate (`793a719300001fc0eb6761c158d1bd7d44f7f592`). Existing dirty coordination files and the unrelated untracked directory were preserved. The pre-existing `qa/STATUS.md` edits remain untouched; this separate digest holds the lane receipt.

- SETTINGS â†’ LOOK & SOUND adds BACKGROUND HUM and HEARTBEAT switches. TERMINAL AUDIO remains the existing master mute.
- Separate gain buses fade out already-playing awakening pads/pulses. New notes respect each choice; UI and completion cues keep their existing routing.
- Existing defaults and master-mute preferences are preserved. Saved settings, station backup collection and chat look controls include both choices.
- The generated website app mirror includes the same controls. Nothing was deployed.
- Release copy: [next update sound controls](../../docs/releases/next/SOUND_CONTROLS.md).

## Verification

- Complete fast gate: **1566/1566 PASS** on `f644205b1`, across all three supported 522-step shards. Every shard exited 0; no exclusions. [Candidate-bound integration receipt](../evidence/sound-controls-1103/integration.json).
- Customer journeys: **38/38 PASS** on the initial implemented source. Later changes were settings key order/line endings, generated mirrors and manifest metadata; no backend changes.
- Registered `test/sound-controls.test.js`: separate buses, active-tail mute, independent repeated scheduling, master mute, useful clicks/completion/attention cues and backup collection.
- Final dev-seeded live app: actual Settings controls drive real Web Audio; muted ambience measured zero while the completion chime remained measurable. Reload and sidecar restart preserve the switches. New controls use theme colours. [Live receipt](../evidence/sound-controls-1103/live.json).
- Focused post-merge sound, COMMS sound, settings, hints, lighting and website-mirror checks passed in the owned worktree at the merge commit. Post-merge claims planning also passed (37 claims, 385 locked surface files).
- Reproduce the browser check using `node dev/sound-controls-proof.mjs` against the isolated seeded app on port 9327; after restarting that same workspace with `--keep`, add `--restart` to require the prior preferences before modifying them.

Earlier failures remain recorded: first attempt cancelled after stale-source manifest assertions; the subsequent complete run passed 1560 and failed six (an untouched voice fixture, mirror guards, exact settings-source anchors and mixed line endings). The integration issues were corrected; voice passed independently without a source change. The final complete three-shard run passed every check. Earlier attempts are not represented as green receipts.

The completion probe sends a synthetic done-task event through the real audio Director; it does not claim a provider run. Browser audio was measured through Web Audio, not heard through physical speakers. Packaged installer and customer retest remain unverified. No push, tag or publication.
