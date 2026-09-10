# Platform connection tutorial — 2026-09-10

Lane: agent/onboarding-refresh-0910. Source: 59a5b1e22. Mechanical source lock: 529fdb1ef.
Owner asked for tutorial guidance on where and how to connect platforms, while preserving
all deeper interview questions. No onboarding/interview source was changed in this pass.

## Behavior

- CONNECT MY PLATFORMS is a visible choice in the first-task/tutorial entry.
- The recommended first-task form has the same shortcut and preserves unsent material.
- SYSTEM > FIELD MANUAL > CONNECT PLATFORMS is a replayable chapter with two paths:
  work apps (BUILD > ABILITIES > CATALOG), and messaging (BUILD > CHANNELS).
- Both paths open the real setup pane with inline, collapsible instructions. They explain
  the next control, account/key or pairing flow, actual connection status, and a first
  small verification action. Existing authorization and platform setup handlers remain in charge.
- The late connector offer now includes the guide and uses concrete navigation language.
- First-steps connection rows are actionable. The work-app step uses a new platform key:
  legacy portal-placement progress stays stored but cannot count as an account connection.
  Only a host-listed connector with state up completes that step; placing a portal does not.
- Website frontend mirror is synchronized.

## Live proof

Real frontend and sidecar from this isolated worktree, using dev/onboard-mock.js --keep,
port 19374 and a seeded NOVA station. The local model fixture was not needed for account setup.

1. SYSTEM > FIELD MANUAL > REPLAY QUICK TOUR showed NOVA and CONNECT MY PLATFORMS.
   Choosing it closed the conversation and selected CONNECT PLATFORMS in the manual.
2. Work-app guidance opened ABILITIES with CATALOG selected and the inline steps expanded.
   Search abilities for Notion exposed the real Notion card and SIGN IN action.
3. Back to connection guide returned to the correct chapter. Messaging guidance opened
   CHANNELS > OVERVIEW with its steps expanded. TELEGRAM opened the existing BotFather,
   token, CONNECT and pairing instructions. Its actual status remained not connected.
4. Recommended first-task path: entered `Tutorial draft preservation check — keep this unsent.`,
   opened Connect my platforms, skipped setup, and observed the exact draft still present.
5. At 1024x600, manual article clientWidth/scrollWidth both 840; inline work-app guide both
   748. No horizontal overflow in either. Visible native-control paint scan returned [].
6. Reloaded the final source. The new Connect a work app checklist button opened CATALOG,
   with the final Search abilities instructions visible. The checklist was hidden during help.
7. Browser warning/error logs returned []. Test tab and owned server were closed afterward.

No external accounts were authorized, no messages were sent to other people, and no private
account data was used. Real OAuth completion, installed desktop behavior and a real connected
service operation were not verified. This is a tutorial/navigation proof, not a release-readiness claim.

## Gates

Syntax checks, focused tutorial routing/truth regressions, first-task draft lifecycle,
manual accessibility, dialogue and onboarding-legibility checks passed.
First full gate stopped at voice.button.test.js: a fixed 70ms observation ran before both asynchronous playback retries cleaned up. Isolated rerun passed 128 assertions. Commit 35f12cc35 uses the existing bounded outcome wait for that check and the previously flaky ordered-retry tail check; all assertions and voice runtime behavior are unchanged.
Full fast gate on 35f12cc35: `run-fast-tests: OK — 754 step(s) green` (exit 0).
Customer journeys: `run-test-list: OK — 34 step(s) green` (exit 0).

Not merged or released. Integration merges are being serialized by the cleanup lane;
this task remains isolated and does not touch the integration tree.
