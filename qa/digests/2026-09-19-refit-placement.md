# REFIT placement latency

Source fix: `0afbde0cf`; synchronized website copy: `b512f7bdb`; final verified candidate: `6aa268980`. Isolated branch `agent/refit-smooth-0919`, based on `713951f89`.

The owner's placement-lag report reproduced in the real seeded app: an ordinary prop edit repainted the unchanged static environment. Five model placements took 397–473 ms through two animation frames; each bake alone consumed 294–342 ms. With the fix, the identical benchmark took 74–88 ms and performed no placement bakes. This comparison used software-rendered Chromium on this host, not the installed WebView.

The model now marks ordinary prop add/move/rotate/mirror/remove notifications as leaving static pixels unchanged. REFIT still updates geometry, collision, mounting and routing. It retains existing environment pixels until an edit actually affects them. Airlocks and unknown edits remain conservative, as do undo/redo. A queued global/floor edit cannot be suppressed by a subsequent prop edit, and an edit clears the pan-only bake flag.

Live proof command: `node scripts/qa/refit-placement.mjs http://127.0.0.1:8896 .refit-proof/live`. Add `--populated` for the 100-prop end-state campaign. Both campaigns passed pointer-preview/click agreement, exactly-one placement, functional equipment, move/rotate/mirror, collision, serialization, undo/redo, same-frame floor plus prop changes, airlock invalidation, painted pixels and reopening. Neither reported degraded render layers. Actual pointer clicks through two frames were 109–238 ms on the small station and 186–360 ms on the populated station while other gates ran; these include UI feedback and are separate from the controlled model-placement comparison.

Regression: `test/refit-bake-reuse.test.js` executes production notification/rebake code and actual model mutations, including both mixed-edit orders and entry/cold-cache fallback. It is registered in the existing fast gate.

Final full `npm run test:fast`: **831/831 PASS**, exit 0, on unchanged candidate `6aa268980`. `npm run qa:customer-journeys`: **38/38 PASS** on retry. Syntax, diff whitespace and bug-register validation passed. Source claims lock refreshed mechanically for the changed frontend bytes, preserving all audit verdicts. The website's identical frontend copy is synchronized and its rendering-parity check passed (85 assertions).

Earlier verification attempts are retained honestly: the first journey attempt hit a refused randomly allocated Windows port; an early gate found the stale source lock and a moving HEAD while proof work was committed; a subsequent audit process exited without an assertion and then passed independently (64 assertions); the continuation found the omitted website copy, which was synchronized before the final complete green gate. Raw logs remain under `.refit-proof/`. No failures were reported by the final 831-step run.

No trunk merge, rebuilt installer, publication or customer-recovery claim. Browser profiles and raw timings remain in the owned `.refit-proof/` directory.
