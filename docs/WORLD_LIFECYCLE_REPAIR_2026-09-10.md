# World lifecycle repair — 2026-09-10

Source repair: 35d255dbd. Verified combined candidate: 9c76cba14 (includes shared movement and reliability changes). Integration is queued behind the cleanup lane.

- Retiring or removing plan-derived crew releases its furniture reservation before removing the body. A replacement can use the empty couch.
- Removing a room removes intersecting furniture and its belt tiles in the same undo snapshot. Neighbor furniture and logical agent links remain. Undo restores the exact document; redo and reload retain the deletion.
- Crew consumes permission prompts, matching responses and authoritative snapshots. It stands with an approval tag while pending; work effects are suppressed. Concurrent prompt IDs remain isolated, and terminal/expiry paths release stale waits.

## Verification

The full fast gate passed 761/761 steps; customer journeys passed 34/34. The added lifecycle and approval regressions passed 17 assertions each; the concurrent movement regression passed 15. Frontend and website mirrors are byte-identical. Syntax checks and helper uniqueness passed.

In the seeded browser, nine lifecycle checks passed, including seat reuse, neighboring furniture preservation, exact undo, redo and reload. Twelve routes spanning hero, idle crew and working crew all arrived with zero wall/floor violations. Opaque canvas pixels were sampled and browser diagnostics were empty.

An isolated real sidecar paused an ASK-mode shell run. Its real pending prompt was forwarded to the browser consumer, and the server snapshot confirmed the wait. The browser reported working=false, waitingApproval=true and a standing pose. Approval executed the shell; denial did not. Both terminal outcomes cleared working and waiting state. This is backend-to-browser consumer proof, not an installed-desktop chat journey.

Raw local receipts: .bugloops/world-audit/lifecycle-fast-serial.log, lifecycle-customer-serial.log, lifecycle-final.json, doorways.json, approval-final.json and approval-deny-final.json in the isolated lane.

## Broader checks and limits

The first concurrent fast run failed three timing assertions in unchanged voice tests; the standalone test passed 128/128 and the full serial fast gate subsequently passed. The first concurrent customer run hit WORKSPACE_BUSY during a payment-fixture restart; the full serial customer rerun passed. The initial optional HTTP run stopped at 57/110 with a loops-git sidecar boot timeout; its serial rerun also stopped at 57/110 when loop rejection returned 409 rather than 200. The unchanged loops-git test then passed all 55 assertions in isolation. Full HTTP is not green; this backend/test condition is outside the world repair diff. No tests were skipped or weakened.

Installed desktop rebuild and verification have not been performed. Existing saved layouts with previously orphaned furniture are not migrated by this repair. These checks found no regression in the repaired flows; they do not establish that every product flow is issue-free.
