# Voice continuity execution receipt

Plan: docs/VOICE_CONTINUITY_PLAN_2026-09-09.md. Customer bug: e1051446. Source: 7e83246fa; source fingerprint: e426c3cf4.

Seeded sidecar launched with node dev/seed.js --keep on :19299, accessed through an isolated local fault-injection proxy on :19298. The proxy injects test controls without changing served production source files. Native browser Audio decodes test WAVs; model/TTS failures are controlled injections, not a paid provider or acoustic quality proof.

Final browser pass on 2026-09-09:
- Stream 'Hello, ' then the remainder: zero opening-fragment TTS requests; one request 'Hello, this is a complete sentence that should stay together.'; queue drained.
- One transient 503: two identical sentence requests; queue drained.
- Persistent 503: three attempts, queue stopped, visible 'Speech interrupted — voice synthesis failed. Full reply remains in chat.'
- Invalid WAV: two media attempts, error code 4, visible playback-specific interruption.
- Notice was within the viewport (336 px wide in a 360 px COMMS row). Browser error log empty.

Focused production-module coverage: voice.button, voice-flow, voice-live-ui, source claims authority; customer journeys 33/33 passed. Full final-candidate and post-merge gate receipts pending below.

Physical echo/noise recordings, natural prosody listening, native realtime provider audio, affected installer and reporter recovery were not verified. Local Live diagnostic thresholds are observations of audio energy, never claims that a human spoke. Existing echoCancellation/noiseSuppression requests are retained; actual track settings are recorded when available.
