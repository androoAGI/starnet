# Overseer home conversation — local verification

Implementation branch: `agent/overseer-home-0919`. Live UI candidate: `2d9b6b5cd`; final backend candidate: `b8d3d0274` (queue cleanup and E-STOP write-failure handling).

Live app: `node dev/overseer-preview.cjs`, which launches the real seeded sidecar/UI with a deterministic local provider and an isolated profile. The browser was operated through its visible controls; model responses are scripted fixtures.

Observed:

1. Sending a delegation request from General created **Research proof** and returned a reviewed result to General without selecting the child.
2. A follow-up reused Research proof and appended its second answer. Opening that session showed both worker answers. **Talk to overseer** returned to General.
3. An unsent draft survived worker completion, automatic review, and the deliberate child/home navigation.
4. On the final build, the overview displayed one **Reviewed · Research proof** row across repeated attempts. General remained selected.
5. The final review persisted after a page reload and did not add a synthetic Commander message. Two old synthetic messages from an earlier development build remained unchanged; the final run added none. The isolated HTTP test independently asserts exactly one genuine user turn after its first automatic review.

Final-build DOM receipt before reload:

```json
{
  "draft": "FINAL DRAFT — keep this unsent.",
  "overview": "Reviewed · Research proof",
  "reviewCount": 3,
  "selectedSession": "General session, NOVA, read; Enter to open; Shift+F10 for actions",
  "syntheticUserCount": 2
}
```

Focused tests pass for durable identities, parent project inheritance, title changes, deletion tombstones, same-session serialization, independent-session progress, failed-turn recovery, automatic review, follow-up history, restart without duplicate review, uncertain review interruption, and E-STOP persistence across restart. Existing orchestration and subagent suites pass (262 and 45 assertions respectively).

The final backend additionally proves that a failed disk write still pauses review admission in memory, that a failed resume leaves it paused, and that the real halt route reports `overseerHaltPersisted: true` only after successful storage. The queue's turn error propagates to its caller while its release signal remains infallible; the fail-open ratchet passes without a new exception.

Full HTTP gate: `npm run test:http` exited 0 with `run-test-list: OK — 120 step(s) green`. The release-source audit also passes its 64 assertions after refreshing only the changed source identities and adding overseer coverage; no claim verdict or release-readiness status was promoted.

Full fast gate: `npm run test:fast` exited 0 with `run-fast-tests: OK — 823 step(s) green`. Earlier attempts exposed an outdated source audit and unnecessary silent catches; both were corrected before this successful complete run. The full checkout was restored after disk space became available.

Not verified here: real-provider delegation judgment, microphone/audio behavior, cloud execution, or installed-package/release readiness. This is implementation-lane evidence only.
