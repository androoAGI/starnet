# 0.11.2 focused closeout — September 11

Candidate `69baf91a5b2c22230f87e614da6a72882278bc6c` remains unchanged. The two crowded-floor awareness findings are dismissed with live evidence. Eight historical customer P1 reports remain open; the readiness controller still reports NOT READY for that category alone. Public distribution is still v0.11.1. No release tag or public updater feed was changed.

## Crowded-floor findings resolved

Findings `0b802140-1789136215296` and `4692c89f-1789136215296` asserted that gaze caused chasing because a moving character's next waypoint occupied another character's tile. The original detector is `scripts/audit.mjs:208`. That snapshot does not establish the cause of movement. `frontend/app/world.js` deliberately handles transient occupied waypoints using path-planning blockers, soft separation and a bounded jam-release mechanism.

An isolated seeded sidecar and isolated browser profile recruited 19 specialists through the real RECRUIT interface, producing a 20-body live floor. Browser-only instrumentation preserved the original `glanceAt` implementation and arguments, recording every body's position, target, path, path index, goal and movement state immediately before and after each call. No production source or personal station was modified.

- Initial run: 180 snapshots, 64 occupied-waypoint snapshots, 32 natural gaze calls plus 380 direct gaze calls, zero movement mutations and zero containment violations.
- Repeat with a negative control: 180 snapshots, 77 occupied-waypoint snapshots, 26 natural gaze calls plus 380 direct gaze calls, zero movement mutations and zero containment violations.
- The negative control deliberately introduced a one-pixel movement inside the instrumented gaze call. The diagnostic detected it, then restored the original function and position.

This supports dismissing the two claimed gaze-caused movement regressions. It does not claim that every possible crowded-floor movement issue is absent. The existing audit's occupancy heuristic remains unsuitable as a causal gaze assertion; its code was not weakened to obtain a green candidate run. The original findings, their explicit dismissals, both complete compressed traces, screenshot and byte hashes are retained in [the evidence directory](../../../qa/evidence/0.11.2-closeout-0911/manifest.json).

The diagnostic is retained at `scripts/verify/release-0112-crowded.mjs`. Run from the owned repository with `node scripts/verify/release-0112-crowded.mjs`; it owns ports 18984/19384, an isolated seed and browser profile, and tears down its own processes. It uses no live provider and spends no customer funds. This is a focused behavior check, not an extended-soak claim.

## Customer records and publication boundary

The fresh support search and GitHub issue read added no new affected-customer recovery evidence. GitHub #12 and #13 remain publicly open despite their separately documented source and installed fixes; #10 is a feature request. No customer messages were sent or issues closed.

The eight case-by-case decisions and precisely missing evidence remain in [RELEASE_DISPOSITION.md](RELEASE_DISPOSITION.md). Some have related proven repairs; others still have uncorrelated symptoms or missing device/account details. They are not eight defects reproduced on this candidate, and passing unrelated checks cannot prove the original causes were fixed. The stale Sonnet symptom paragraph now distinguishes the original September 5 HTTP 400 from the newer model/credential selection diagnostics and positive September 10 reply.

The owner's instruction to finish and release establishes the intended outcome. The earlier waiver explicitly covers soak durations. It does not establish that these eight reports recovered. The existing publication boundary requires either evidence-backed resolution or an explicit decision to publish with these documented uncertainties. Do not silently convert a request to finish repairs into eight fabricated closures or a green readiness result.

## Installer and personal station

The exact candidate has complete Guardian, CI, signed build, hosted clean-install/upgrade/lifecycle and personal preservation receipts in [POINTER_CUT.md](POINTER_CUT.md). The signed Windows installer hash remains `8b39dab2818acac23097056c8796d1f48668b9a711f09c134f7d56b51e58f416`.

A fresh read of the normally running personal installation again returned version 0.11.2, source `69baf91a5b2c22230f87e614da6a72882278bc6c`, 26 crew, 141 props, 73 conversations, zero active runs and one paused routine. The native StarNet window was responding. No reinstall was needed for this evidence-only closeout.
