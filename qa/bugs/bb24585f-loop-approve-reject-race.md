---
fingerprint: bb24585f
slug: loop-approve-reject-race
title: Concurrent loop approval can retain an approved verdict after rejection reverts the files
surface: autonomy
severity: P1
status: fixed
found: 2026-09-10
lane: agent/adversarial-audit-0910
fix: 64ed8711b
origin: audit
---
# Concurrent loop approval can retain an approved verdict after rejection reverts the files

## Symptom

P1: a review decision can delete work the station says was approved. Reject and Approve from two clients, or overlapping requests from one review panel, both succeed. The files are reverted but the authoritative iteration remains approved. Further review is refused because the iteration already has a verdict.

## Repro

1. Boot an isolated seeded sidecar with the local mock in dev/audit-mock.cjs.
2. Run node dev/audit-loop-verdict.cjs. It creates a disposable Git project, grants only that project, starts one real loop iteration, provides a known file change while the mock run is held, and lets StarNet harvest a real candidate commit.
3. POST /api/loops/verdict with rejected; 25 ms later POST approved for the same loop and iteration.
4. Both responses are HTTP 200 and ok:true. The rejection reports undone:[1]; the final record reports approvedCount:1, rejectedCount:0, verdict:approved. candidate.txt no longer exists.
5. Open WORK > AUTOMATION > Goal loops. The live UI says 'pass 1/1 · 1 approved · 0 rejected'. Restart with --keep: the contradiction remains.

## Evidence

Audited source: 2aa8305c0, 2026-09-10. Sanitized receipt: qa/evidence/adversarial-0910/restart-receipt.json.
Actual candidate commit 01135d4 was followed by undo commit 0c652cd. The file existed before the competing requests and was absent afterward and after a real sidecar restart.

Root cause: sidecar/index.js:7415 checks target.verdict only before the asynchronous undo at sidecar/index.js:7431. There is no per-loop review lock covering validation, Git mutation and persistence. The concurrent approval records its result during the await. sidecar/loopjob-store.js:545 then returns the already-decided loop unchanged, so rejection still responds success after changing Git while retaining the approval. This is separate from fixed bug 24b375c9, which fences late iteration settlement and driver leases.

## Regression

Existing test/loopjob.test.js (193 assertions) and test/loopjob-driver.test.js (175 assertions) passed on the audited source. The new live probe demonstrates a missing route-level transaction test. No repair applied.

## Fix direction

Serialize verdicts and their Git effects per loop; revalidate the current pending iteration inside the lock. Coordinate review with active harvest/control operations. A losing request must return a conflict before changing files. Also cover overlapping rejections and ancestor/descendant reviews.

## Repair verification — 2026-09-10

Source fix: 64ed8711b. The shared per-loop guard covers HTTP and model verdicts, scheduler admission, and conflicting update/control/removal actions. A running pass or another review returns a conflict before Git effects. test/loops-git.e2e.test.js passed 56 assertions, including ancestor rejection versus descendant approval, cascading undo, dirty-file refusal and keeping approved files. The live original race now returns approval 409 / rejection 200, with 0 approved / 1 rejected and the file absent, including after restart.

Sanitized post-restart receipt: qa/evidence/adversarial-0910/fixed-restart-receipt.json. Full integration gates are recorded in the follow-up report; installed desktop execution is not verified by this seeded-browser proof.
