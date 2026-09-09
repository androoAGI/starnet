# Voice continuity execution receipt

Plan: docs/VOICE_CONTINUITY_PLAN_2026-09-09.md. Customer bug: e1051446. Source repairs: 7e83246fa and 767bf9252; final candidate/source fingerprint receipt: 671d9471f.

Seeded sidecar launched with node dev/seed.js --keep on :19299, accessed through an isolated local fault-injection proxy on :19298. The proxy injects test controls without changing served production source files. Native browser Audio decodes test WAVs; model/TTS failures are controlled injections, not a paid provider or acoustic quality proof.

Final browser pass on 2026-09-09:
- Stream 'Hello, ' then the remainder: zero opening-fragment TTS requests; one request 'Hello, this is a complete sentence that should stay together.'; queue drained.
- One transient 503: two identical sentence requests; queue drained.
- Persistent 503: three attempts, queue stopped, visible 'Speech interrupted — voice synthesis failed. Full reply remains in chat.'
- Invalid WAV: two media attempts, error code 4, visible playback-specific interruption.
- Notice was within the viewport (336 px wide in a 360 px COMMS row). Browser error log empty.

Focused production-module coverage: voice.button, voice-flow, voice-live-ui, source claims authority; customer journeys 33/33 passed. Final candidate 671d9471f: npm run test:fast 734/734, exit 0. Merged ab1cd74be from snapshot ed768880a; post-merge npm run test:fast 734/734, exit 0. Voice-button regression count: 128 assertions.

Physical echo/noise recordings, natural prosody listening, native realtime provider audio, affected installer and reporter recovery were not verified. Local Live diagnostic thresholds are observations of audio energy, never claims that a human spoke. Existing echoCancellation/noiseSuppression requests are retained; actual track settings are recorded when available.

Real backend follow-up: local-kokoro returned HTTP 200 audio/wav, 475244 bytes, for one complete sentence. Native browser playback transitioned speaking → ready and drained the queue. Initial test-proxy origin mismatch correctly returned 403; after correcting only the temporary proxy routing, real synthesis succeeded. The proxy, browser tab and seeded process were stopped; temporary controls were removed.

All three merged voice sources were SHA-256-identical to the live-tested lane. No shared contract, provider route, credential, installer, remote branch or release was changed. Existing integration QA-status edits and Rooms handoff bytes were preserved.
