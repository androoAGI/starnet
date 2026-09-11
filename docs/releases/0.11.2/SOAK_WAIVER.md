# 0.11.2 owner soak waiver and update standing

On September 11, 2026 UTC, Andrew explicitly directed: “we are once again going to waive our typical soak routine” and prioritized fixing update defects and ensuring a smooth update experience.

**Decision: the 12-hour source and 48-hour installed/attended soak duration requirements are WAIVED for 0.11.2.** No elapsed-time wait is required for this release. This is a new, release-specific owner decision, not an inherited 0.11.1 exception. It does not change the default procedure for future releases.

The replacement source soak was stopped by this lane after verifying its PID, command and creation time. Its child processes were stopped with it. Partial logs and the owner-cancellation record are retained; neither interrupted run is a completed PASS. Prior handoff statements requiring completion or predicting a finish time are superseded by this decision.

## Focused update verification

Installed candidate **7f6c7b005120381539ad9c4b4601cb42b6b9b27d** remains unchanged.

- Ten update-specific suites passed **239 assertions** covering update planning, installation guards, save parity, preparation/cancellation, continuity, workspace migration, installer selection, host verification and update delivery.
- The real installed canary reported the unavailable localhost update feed as an error. Its Update Center renderer included the manual-recovery control. A retry against a local HTTP 204 endpoint recovered to **current**, clearing the error. This is native check/retry proof, not published-feed delivery.
- The installed pre-install drain confirmed save and roster durability. Preparation produced a 658,787-byte recovery snapshot containing 31 browser keys; its file SHA-256 and durable receipt were verified locally. No snapshot contents or credentials are included in portable evidence.
- The snapshot recorded zero live runs and zero active mutations. Writes were blocked while prepared, saved state remained readable and unchanged, and cancellation restored writes with a successful drain.
- An initial probe called the Update Center renderer without its required element. That driver failure is retained; the corrected probe supplied an element and completed. No product repair is inferred from that probe error.

This adds to the previously verified signed local canary update, installation/relaunch persistence, fresh onboarding, backdrop recovery, four platform builds and full Guardian. No new product defect was reproduced in this focused pass, so no runtime code was changed.

## Remaining release work

The waiver removes duration-based soak requirements. It does not close the seven customer reports, invent affected-account/hardware recovery, or waive concrete installer/update checks. Use [CUSTOMER_RETESTS.md](CUSTOMER_RETESTS.md) for those reports. Historical public-client update continuity and the staged-artifact clean-install/lifecycle checks still need their actual artifacts; the canary update remains bounded mechanism proof.

Canonical readiness currently reports seven open customer P1s. No statuses were downgraded to change that verdict. Official pins remain 0.11.1; version bump, final notes, post-bump gates, staged release checks and publication have not been performed.

[Focused evidence](../../../qa/evidence/0.11.2-update-standing-0911/manifest.json). Earlier receipts retain their original hashes and candidate identities. Carry this owner waiver into the final release notes when cutting 0.11.2.
