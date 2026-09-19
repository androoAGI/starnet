# Overseer home conversation — local verification

Implementation branch: `agent/overseer-home-0919`. Runtime code candidate: `2d9b6b5cd`.

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

Not verified here: real-provider delegation judgment, microphone/audio behavior, cloud execution, or installed-package/release readiness. This is implementation-lane evidence only.
