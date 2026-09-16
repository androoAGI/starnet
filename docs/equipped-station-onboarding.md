# Pre-equipped station onboarding — 2026-09-15

## Behavior

The optional quick tour has two lessons: equipment already in the agent's area, then COMMS and basic building. It never enters the legacy prop-placement loop. All five essential abilities get a short purpose; room-scoped inventory determines which descriptions appear. Edited stations and unavailable inventory have separate messages. Equipment presence does not assert service connection or runtime access.

Next and Finish remain visible in a short COMMS panel; only lesson text scrolls. The tour does not set activity to WORKING or IDLE. Completion returns to COMMS or explicitly selected first-task recipes without starting a placement checklist or connector pitch. Reload no longer resurfaces the old checklist for returning users. Earned progress remains stored.

The file example is optional, preflighted, and asks to preserve an existing `starnet-welcome.txt`. Approval wording reflects access settings. Narration only begins after an explicitly launched example receives a matching agent start, and completion follows the captured run ID. Denial is correlated by prompt ID. Timeout and failure text make no unsupported claims about file contents or the cause of a connection failure.

## Verified

- Live preview at `http://127.0.0.1:18845/`, SYSTEM → FIELD MANUAL → REPLAY QUICK TOUR: all five labels appeared on the existing furnished station; no builder opened and station remained ONLINE / IDLE.
- At approximately 830 × 912, all five labels and Next / Finish were visible. The shortened second lesson and all three actions fit in COMMS.
- Finish returned to COMMS with no follow-up overlays. Reload did not restore the old placement checklist.
- Choose my first task opened the existing draft-from-notes Recipes surface. No provider run was submitted in the live preview.
- `tutorial-equipped-station.test.js` drives the actual module: full, partial, empty and unavailable inventories; skip, replay, useful-task handoff, unavailable model, demo event ownership, denial and timeout. It is registered in `test/fast.list`.
- Focused checks passed: onboarding, onboarding-refresh, onboarding-legibility, tutorial-platform-guide, tutorial-connect-beat, kitout, refit-flow-polish; syntax checks and `git diff --check` passed.

## Merge status

Not merged. The full `npm run test:fast` attempt reproduced three existing failures in `qa-product-perfect-claims.test.js`: planning authority expected true, planning status expected PASS but received BLOCKED, and missing open grep-verdict explanation. After recording these failures, the owned long-running claims-test process was stopped; the runner exited 1. Full-suite completion is not claimed.

Log: `.dogfood/build-interactions/equipped-tutorial-test-fast.log`. This branch also needs synchronization with current trunk before integration. The green-before-merge gate remains required. A fresh end-to-end awakening and real provider-backed file example have not been verified in this pass; live evidence covers replay and the first-task handoff.
