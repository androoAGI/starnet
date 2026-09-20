# Project workspace verification — 2026-09-19

Source candidate: 4f3f74799fb25e11b99ee43e07ad7996bce030ec. Surface lock: 61cea7ee4.
Owned branch: agent/project-comms-0919.
Preview: http://127.0.0.1:55715/ using dev/seed.js --keep and an isolated local test provider.

## Delivered behavior
- Projects remains a flat list of attached folders. Selecting a project opens its overview and stable existing COMMS workstream.
- Preferred crew comes from existing station agents; preferences do not prohibit using other crew.
- Background crew work appears as expandable activity, without requiring visible child sessions.
- The existing worker manager owns execution, interruption, generation-checked steering and persistence. The existing orchestrator reviews returned work in the original project conversation.
- The normal Sessions and station views remain available. Changing projects or viewing the station does not cancel work.

## Focused verification
- HTTP: stable project identity, separate project activity, existing crew persona, preferred crew in lead context, no extra child sessions, steering included in lead review, restart persistence, revoked access stays revoked, unknown roots rejected.
- UI controller: polling preserves direction drafts, open details and unsaved crew preferences; polling never changes chat focus; late responses cannot reopen the previous project or a closed view; newest activity ordering is stable.
- Existing projects-view: 78 assertions passed.
- Existing orchestration integration test passed.
- Customer journeys: 139/139 assertions passed.

## Live app proof
- Recruited MIRA through the existing recruitment interface, selected her as preferred crew, and saved preferences.
- Opened a project and sent the task through normal COMMS. MIRA appeared in activity and NOVA's review returned to that conversation.
- Sent a direction while work was live: UI reported queued, not applied.
- Stopped a separate activity: UI reported Stop requested, then the durable activity became Stopped.
- Completed-work race correctly rejected a late direction instead of reporting delivery.
- Started Website Refresh work, switched to Launch Notes, and typed an unsent draft. The other worker completed without changing the selected project, its transcript, or the draft. Returning to Website Refresh showed its own result.
- Reloaded/restarted the isolated preview, reopened projects, and observed saved conversations, crew preferences and recorded activity.
- At 1280x720, project panel, activity entries, project list and COMMS all stayed within their horizontal bounds.

## Boundaries
The model responses are deterministic test-provider responses, not evidence of real-model delegation judgment. Voice and packaged installer acceptance were not exercised. This new project extension is an isolated review branch, not a release or deployment.

## Verification chronology
The first complete project HTTP run passed 124/124. The fast run caught a new empty error handler in project-context detection at step 752. It was corrected to distinguish an ordinary unsaved conversation from unavailable coordination state, reporting real failures through the existing fail-open diagnostic helper. The guard then passed all 156 assertions; the focused project HTTP and persistence checks passed, and all 80 remaining fast steps passed. Complete fast and HTTP manifests were restarted on the corrected immutable candidate; final receipts follow below.

The final browser console had no errors. The preview was restarted on the corrected source and Website Refresh reopened with its saved crew preference, activity and conversation. Temporary technical project metadata was removed through the normal revoke/forget controls, leaving two named preview projects.

## Final receipts
- Corrected source: 4f3f74799fb25e11b99ee43e07ad7996bce030ec; audited candidate: 61cea7ee4.
- Full fast manifest: **832/832 steps green**, exit 0. `node scripts/timeout.mjs --label project-fast-verified --timeout=1800000 -- npm run test:fast:raw`; `.project-verified-fast.log`. This is the canonical complete fast manifest with a 30-minute outer deadline; no tests or assertions were skipped.
- HTTP: **all 124 manifest cases passed on the unchanged corrected candidate across a resumed run**. `.project-verified-http.log` passed steps 1–61, then the legacy workshop test hit its unchanged nine-second sidecar-startup confirmation timeout. The same test passed 86 assertions standalone (`.project-workshop-retry.log`). The canonical runner then executed steps 62–124 in manifest order, all **63/63 green**, exit 0 (`.project-verified-http-remainder.log`), including the workshop test again. No timeout or assertion was weakened. This is explicitly not represented as a single uninterrupted HTTP invocation.
- Earlier complete HTTP invocation: 124/124 green before the diagnostic-only error-handler correction (`.project-final-http.log`).
- Customer journeys: **139/139 assertions green**, exit 0 (`.project-journeys.log`).
- Final live preview restarted on the corrected source. Browser console: no errors.

The source worktree was clean after verification. This evidence-only commit adds no product changes. The project extension remains on its isolated branch for owner review; no merge, installer build, push or publication of this extension occurred.
