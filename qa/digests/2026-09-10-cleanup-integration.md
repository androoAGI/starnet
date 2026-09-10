# Cleanup integration — 2026-09-10

Integrated `agent/cleanup-0112-0910` into `feat/harness-backend` by fast-forward from `e80acf63d` to the exact tested commit `695f19232b8d3ab5f36554ca737ff378eb220b27`.

- Full normal `npm run test:fast`: **760/760 GREEN**, exit 0.
- Full normal `npm run test:http`: **110/110 GREEN**, exit 0.
- Includes animation/seating, movement continuity, and Hermes reliability/report-output repairs already on trunk. The backend overlap retains both tool-free output repair and image-cost draining.
- Original nine cleanup findings remain repaired. Integration also replaced host timers with microtasks in the voice retry mock; all 128 assertions remain and production voice code is unchanged.
- Installed dependencies match the committed lockfile. No test steps were removed and no additional timeouts were changed during integration.

The first final HTTP attempt stopped at step 84 when the service-key fixture missed its 9-second readiness deadline under concurrent test load. The unchanged test passed 38/38 assertions in isolation, then the complete unchanged HTTP suite passed after coordinating lower contention. Earlier failed and superseded attempts remain identified in [the hashed verification receipt](../evidence/0.11.2-cleanup/merge-verification.json); they are not counted as green.

The existing dirty integration QA notes were backed up, restored byte-for-byte as a prefix, and followed by the cleanup digest. The unrelated Rooms handoff is unchanged. No foreign working changes were committed.

These are source integration checks. Installed update/relaunch, affected-account recovery, hardware acceptance, existing customer issues and the release soak remain open. No release was published. Prior live evidence and its source limitations remain in `docs/AUDIT_0.11.1_FOR_0.11.2.md`.
