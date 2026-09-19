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

## Polish pass — September 19

Product source: `ba862429a`; candidate/source lock: `2511b394b`. This lane merged the then-current reliability candidate `95983cdb6` through `e5fb9777a`. The reliability lane subsequently rolled trunk back to `5bb28bb83` after its post-merge test hit a shared scratch-workspace collision. This branch has not been integrated; it must be synchronized with the reliability lane's accepted replacement before inclusion in an update. Do not use this branch to bypass that lane's held integration reservation.

Changes: always-visible home button outside the collapsible work list; active/attention counts; chronological selection of the latest attempt with running attempts retained; unresolved issues first; visible recovery explanations; direct navigation to the originating review; a reviewed failed worker says `Issue reported`; polling omits worker results, context, artifacts and event histories. Both shipped frontend copies match.

Live verification used the real seeded app and local deterministic provider at `127.0.0.1:49284`. Sending another follow-up reused Research proof. During background execution the DOM reported:

```json
{
  "overview": "Delegated work · 1 active / Starting · Research proof",
  "draft": "POLISH DRAFT — keep this unsent.",
  "selected": "General session, NOVA, read; Enter to open; Shift+F10 for actions"
}
```

Completion produced one `Reviewed · Research proof` row and `Open review`. Opening the child, then Open review, returned to General and restored the unsent draft. Collapsing Delegated work left Talk to overseer visible; the DOM receipt had `collapsed: true`, `homeVisible: true`, the unchanged draft, and `reviewCount: 4`.

Stopping the preview process cleared the stale rows and active count, showing `Work status unavailable — reconnecting.` Restarting the sidecar and reloading restored the same single Reviewed row and exactly four review deliveries; no review was duplicated. Browser error logs after reload were empty. New controls had transparent backgrounds and station-theme borders (`rgb(255, 170, 51)`), with no native white/grey button paint. The preview processes and temporary browser tab were closed after proof.

Focused regressions passed: chronological deduplication, confirmed-start labeling, attention ordering, reviewed-failure labeling, originating-review routing, pause/credential recovery copy, durable queue tests, and the complete HTTP delegation/review/restart/halt journey. Error-state copy was regression-tested; no real-provider failure or microphone test was performed. Draft retention is proven across in-page delegation/navigation, not page reload.

Final full gates on frozen candidate `2511b394b` both exited 0:

```text
run-fast-tests: OK — 831 step(s) green
run-test-list: OK — 122 step(s) green
```

Logs retained in this worktree: `.overseer-polish-fast.log` and `.overseer-polish-http.log`. The fast gate includes the source-bound claims audit (64 assertions), frontend/website synchronization, and session lifecycle campaign. Source files remained unchanged during these runs; only this verification digest was updated. The integration reservation is still held by the reliability lane. No trunk merge, push, installer build or publication was performed for this polish pass.
