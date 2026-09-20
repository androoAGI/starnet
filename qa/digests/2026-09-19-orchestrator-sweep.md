# Orchestrator COMMS sweep and merge assessment

Owner requested an inconsistency sweep before evaluating integration. This is a source-lane assessment, not a release-readiness or exhaustive product-perfection claim.

## Candidate and integration

- Owned workspace: `agent/overseer-home-0919`.
- Synchronized current trunk `621bbf467` through merge `a93cc1672`.
- Final product source: `418cfd42a`; source-lock receipt: `34d835c98`.
- The sole synchronization conflict was the source-lock metadata in `qa/product-perfect/claims.json`. Both frontend changes were retained and the combined lock regenerated with the repository utility. No verdicts were promoted.
- Shared events/schema, dependency manifests and credential stores were not changed by this lane. Frontend and website copies remain paired. The rejected sidebar/panel remains absent.

## Findings repaired

1. Failed E-STOP persistence could leave review cancellations only partly applied, allowing storage recovery to revive old work. Cancellation now takes effect in RAM before persistence, including the stopped worker generation; a successful later resume persists those cancellations.
2. An invalid optional coordination store could throw during application boot. Coordination now remains paused and refuses data operations while preserving the damaged file; ordinary chat still starts and reaches its provider. This does not claim the damaged file has been repaired.
3. The new server session adapter was supplied to unrelated lead runs. It is now selected only for eligible COMMS orchestrator runs and their admitted reviews. Existing specialist/scheduled/channel adapters remain in place.
4. The review timer and store writer did not participate fully in the pre-update freeze. Admission checks now honor the freeze, and durable writes use the existing protected writer. An HTTP regression proves review state stays byte-identical across a polling interval behind a verified update snapshot.
5. A user turn queued behind a review could retain history captured before the review finished. Ordinary queued chat refreshes from the durable transcript at admission while retaining the incoming message, including attachments. Recovery checkpoints and group message assembly keep their existing contracts. The real-provider-boundary fixture asserts the newly finished review is present in the queued user request.
6. The existing stop/resume status omitted coordination. The existing status includes it, and explicit resume lifts its pause without reviving cancelled reviews. No control was added.
7. Scoped server-owned session context/refresh to coordinated workers. Retained the existing renderer-bridge fallback before a page's first durable session save. The full HTTP campaign reproduced a targeted-delivery regression at this boundary; the corrected existing `e2e.dispatch-session.test.js` passed all 31 assertions. Ordinary specialist dispatch does not opt into server-owned coordination metadata.

## Evidence

The focused real-sidecar campaign passed on the final source (`.overseer-accepted-focused.log`). It covers custom crew identity, a parent distinct from General, reused worker history, automatic result delivery, queued user history, direct-specialist isolation, replay/restart, uncertain completion, stop/resume, corruption preservation and pre-update freeze. Orchestration unit suite passed 263 assertions.

Unit regression additionally simulates a full disk during stop and resume, restores writes, and verifies cancellation after another restart. Existing UI synchronization regression checks no added UI/focus changes, retry after offline recovery and request timeout.

Final-source seeded browser proof used the existing preview at `http://127.0.0.1:60319/`, isolated under `.dogfood/overseer/workspace`, with a deterministic local provider:

- Existing Crew coordination transcript restored after sidecar restart without duplicate results.
- Selected NOVA in existing COMMS; follow-up reused the existing MIRA research session.
- Switched to MIRA direct chat while the worker was running. On completion it remained selected and contained no `Reviewed findings` delivery.
- Returned to Crew coordination: fourth review present, `Final sweep draft.` preserved. No additional orchestrator button or panel.
- Browser error log empty. Test draft cleared through normal keyboard input. Preview remains available for owner review.

After the first-save compatibility correction, restarted source `418cfd42a` again and repeated the existing-session follow-up. DOM receipt: `reviews: 5`, `draft: "Compatibility draft."`, `focus: "chat-input"`, `extraUI: 0`, `technicalLabels: false`. Browser errors remained empty. Cleared that test draft afterward. Final customer journeys exited zero with 139/139 assertions (`.overseer-accepted-journeys.log`).

Full gate results are recorded below when complete. Earlier `.overseer-sweep-fast.log` / `http.log` runs were deliberately interrupted when the concurrency/control fixes changed the candidate; they are not accepted full gates. The subsequent `.overseer-sweep-final-http.log` failed at the first-save compatibility boundary described above; its companion fast run was stopped for the fix. An intermediate focused test selected the newly added coordinator probe instead of the specialist probe; its selector was narrowed. Another intermediate test used the wrong halt-status URL; it was corrected to the existing `GET /api/halt`. Source-wiring tests now inspect the actual registration section instead of a fixed 3,000-character cutoff that omitted the injected clock. Final focused campaigns exited zero.

The next full fast campaign (`.overseer-accepted-fast.log`) stopped at step 293: the claims authority referenced the stable assertion text `automatic review never impersonates a Commander message`, which the queued-message test had renamed. Test-only commit `ad34b66a4` restored that label while retaining the expected count of two actual user turns. Product source and the assertion behavior were unchanged. A new complete fast campaign runs in `.overseer-verified-fast.log`; the HTTP campaign remains valid for the identical product source and test behavior.

The HTTP campaign then stopped at step 110 because the existing emergency-recovery contract asserted exactly three subsystem statuses. Test-only `193934ed8` expanded it to explicitly cover all four, including coordinator state after stop/restart/resume and a failed coordinator persistence write. The strengthened real-HTTP test passed (`.overseer-emergency-recovery.log`). Full HTTP was restarted into `.overseer-verified-http.log`. The isolated remaining HTTP slice was also run to inspect the previously unreached scenarios promptly; it is supplementary, not a substitute for the full gate.

## Limits

The scripted provider proves harness behavior, not real-model delegation judgment, provider-specific voice/audio or packaged-desktop behavior. Existing station-wide QA findings are not closed by this lane. No trunk integration, push, installer build or publication was performed. User requested merge evaluation; integration remains a subsequent action against a freshly checked trunk and serialized merge window.

## Completed gates

- Full fast: exit 0, `run-fast-tests: OK — 831 step(s) green`, `.overseer-verified-fast.log`. Product source `418cfd42a`; test locator repair `ad34b66a4`. HTTP-only test update `193934ed8` was committed during this run; no product source or fast-list test changed.
- Full HTTP: exit 0, `run-test-list: OK — 123 step(s) green`, `.overseer-verified-http.log`, candidate `193934ed8`. Includes the strengthened emergency recovery contract and complete orchestrator/restart/freeze/corruption campaign.
- Customer journeys: exit 0, 139/139 assertions, `.overseer-accepted-journeys.log` on the same product source.
- Supplemental HTTP tail: exit 0, 13/13 steps, `.overseer-http-tail.log`.
- Source-claims planning validation: exit 0, 37 claim families / 328 locked files, `.overseer-claims-planning.log`. This is not terminal product-perfect authority.
- Syntax checks for changed JavaScript and `git diff --check`: pass.

## Merge evaluation

Recommend source integration of this branch: no remaining merge blocker was found in the reviewed scope. Current trunk remains `621bbf467`; the combined candidate contains its onboarding fix. The complete fast/HTTP gates, customer journeys and live candidate proof passed. Preserve the existing COMMS-only design. Use the normal serialized merge ritual and post-integration verification when integration is requested. Real-model delegation judgment and installed-package acceptance remain release follow-ups, not claims established by this source sweep.
