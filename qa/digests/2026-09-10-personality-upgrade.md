# Personality upgrade — verification record

Worktree: `agent/personality-upgrade-0910`, synchronized with trunk `e80acf63d`.

## Implemented

- Six choices: Composed, Warm, Blunt, Dry, Unhinged, Upbeat. Existing Professional,
  Friendly, Direct, Witty, Calm and Hype IDs resolve to the approved replacements;
  all earlier legacy aliases remain supported. Calm resolves to Composed.
- Each profile specifies conversation, disagreement, uncertainty, failure, success
  and frustration behavior while preserving universal accuracy and task rigor.
- One deterministic composer resolves preset defaults and saved tuning. The dossier
  offers warmth, humor, formality, length, energy, profanity, emoji, bluntness and a
  custom style note. Changing presets retains explicit tuning; reset restores defaults.
- Spoken chat and real-time voice no longer reapply untuned preset text. The live
  voice context refreshes when the same agent's prompt or tuning changes. Fixed
  ambient quips respect humor suppression and do not override custom style notes.
- `scripts/personality-eval.mjs` prepares or captures seven ten-turn evaluation
  trials (six presets plus tuned Dry), with separate blinded response files and
  an answer key. Capture is explicitly not a quality verdict.

## Live seeded app evidence

Observed through the actual browser UI on the isolated `dev/seed.js --keep` app,
port 8967, with its own `dev/.scratch-workspace`:

1. Dossier → CONFIG → PERSONALITY rendered exactly the six approved labels.
2. Selecting Dry changed its pressed state. Saving humor None, energy High,
   language No profanity and custom text `Use short sentences.` persisted those
   exact values into `agent.save.json`; the roster's system prompt contained all
   four effective instructions and the Dry profile.
3. Stopping the verified worktree sidecar, relaunching with `--keep`, and reloading
   the browser retained Dry and all four settings in the actual controls.
4. Switching to Unhinged retained the no-profanity override and applied immediately
   without claiming the tuned profile would swear. Reset cleared the overrides and
   restored the preset language instruction in the saved backend roster.
5. `/personality calm` rendered `Personality set to Composed.`; `/personality dry`
   rendered `Personality set to Dry.`
6. New selects had `appearance: none` and transparent backgrounds, with no native
   white control paint. Browser error log inspection returned an empty array.
7. After synchronization and another sidecar restart, the served personas.js bytes
   matched the worktree source and the saved roster contained the complete current
   composer output. Profile source SHA-256:
   `9b8fd447596e95ee0d9b1e4370dad7d46e46a778e5db473efc4665e3450a5c17`.

8. Saving a humor override displayed `FINE-TUNE PERSONALITY · CUSTOMIZED`; the
   panel distinguished instant preset changes from tuning that requires SAVE.
9. Selecting Unhinged on the final code saved the roster language instruction
   `Occasional natural, uncensored profanity is allowed`; frequent profanity is opt-in.

## Automated evidence

Initial full fast gate: 753 steps green. Focused executable regressions cover
legacy migration, invalid IDs, tuning precedence, agent-target isolation, voice
fallback behavior, same-agent live-context timer refresh and ambient suppression.
The evaluation runner prepared 7 × 10 trials without a model call and refused
`--live` with exit 2 when no isolated key was supplied, without creating output.

The synchronized gate exposed a voice-button test timing race: fixed 40/70 ms
samples could run before playback completion or cleanup callbacks. Its existing
bounded outcome helper now waits for the tested completion state; all ordering,
retry, state-clearance and URL-release assertions remain intact. An independent
creation task also reported intermittent failures in unchanged voice-button code.
The voice suite passed three consecutive 128-assertion runs after those wait changes.
Pre-cleanup full gate: **759 steps green**. Focused final customization regressions
also passed. Final synchronization and integration gate: pending cleanup merge.

## Limits

No real-model response-distinctness verdict: this isolated environment had no
provider evaluation credentials. No live microphone/audio quality or installed
Tauri build verification was performed. This record proves the source behavior,
UI changes and persistence listed above; it is not release-readiness certification.
