---
fingerprint: 4214684b
slug: splitter-not-fixed-1010-barrier-lost-on-restart
title: A job held or restarted inside a split loses its sibling branches' work: the join barrier lives in memory and the line will not resume
surface: world
severity: P1
status: fixed
found: 2026-11-04
lane: line-hold-finish-1104
fix: a5a3797a4dbaaea17c1440889dc23e7a0731fe2f
origin: audit
---

# A job held or restarted inside a split loses its sibling branches' work: the join barrier lives in memory and the line will not resume

## Symptom

A line that fans out into branches and meets a JOINER (COPY TO EACH, SPLIT THE JOB, PARALLEL CREW, the 10-10 splitter lane) parks each finished branch's work in a barrier that exists only in the chain's memory. When a reviewer's gate inside one branch, or right after the join, stopped the job for a person, the siblings' work could not wait with it: the job ended the old terminal blocked stop, and any station restart dropped the barrier with a console line, "join barrier lost on restart ... the line will not resume". So a person could never approve the branch and have the join complete: the finished siblings were paid for and gone. The 10-10 audit of the splitter lane left that restart caveat open ("RESTART IS FAIL-LOUD, NOT DURABLE" in `sidecar/routing/chain.js`).

## Repro

1. Build INBOX > SPLIT > (A | B) > JOINER > D > OUTBOX with a LOOP gate inside B's lane: `F2` in `test/line-hold.split.test.js`. A is the entry dock, B its sibling.
2. Send a job: A parks its work at the joiner, B runs and answers with no usable VERDICT line, and the gate holds the job.
3. Before a5a3797a4 the job ends the old way. A walk that parks a part at the barrier and a station that restarts report: "[chain] join barrier lost on restart: 9,4|run5 (2/3 branches had delivered) — the line will not resume".
4. The same for a gate that holds the ENTRY branch while its sibling has not started (`F1`), a gate right after the join (`F3`), and a divided job whose queued branches each carry their own part.
Regression: `test/line-hold.split.test.js` (every section red on 0554f37c6), `test/chain.join-loop.test.js` (the S5 block: red against the original chain source, which has no part meta, no view and no restore).

## Evidence

Before: `test/line-hold.split.test.js` as first written, run against 0554f37c6 (the tip before this change): 19 problems, 7 ok, every split section failing with "FAIL: the job is parked as a hold: it could not be saved as a hold (the gate sits inside a split that is still running, and a hold inside a split is not saved yet), so the job ends here", "FAIL: a gate after the join is saved: it could not be saved as a hold (the held work is the crate a joiner merged, and a hold after a join is not saved yet), so the job ends here" and "FAIL: nothing joined, nothing delivered, and the sibling's part does not sit in memory for a join that cannot come — expected [0,0,0,0], got [0,0,0,1]" (the parked part leaked in memory).
Before, the restart: a barrier parked mid-walk (2 of 3 delivered) and a station restart print "[chain] join barrier lost on restart: 9,4|run5 (2/3 branches had delivered) — the line will not resume" (run on this tree; pinned by the RESTART block of `test/chain.join-loop.test.js`, which stays true for a crash mid-walk).
Before, the barrier module: `LINE_HOLD_CONTROL=original node test/chain.join-loop.test.js` fails the S5 block: "FAIL: S5 a part parked at the barrier carries its branch and run ..." then "TypeError: one.c._barrier.view is not a function".

After, at a5a3797a4 / 695925d3b, run singly: line-hold.split 119 assertions, chain.join-loop 222, line-hold.matrix 1807 (its two fallback cases for a split and a join now assert the hold is saved), chain 94, chain.limits 54, chain.multibay 23, chain-audit-1010 174, line-hold.resume 79, line-hold.decision 44, line-hold.authority 78, line-hold.persistence 31, line-runner 178. The restart in `test/line-hold.split.test.js` is a new chain and a new runner over the saved file: after it the job record, revision, barrier and draft are byte for byte as saved, nothing is in memory and no provider is called. APPROVE then buys only the stage past the joiner (calls `["D"]`), joins once and delivers once; SEND BACK brings the barrier back with A's part exactly once (same part id) and a second hold is saved; STOP buys, joins and delivers nothing. A parallel join (two single-step branches run at once) and two reviewers in series are saved and decided the same way. On a real sidecar the straight-line hold survives a restart (line-hold.restart.http 20, line-hold.e2e.http 27 assertions); there is no real-sidecar run of a split floor. The laws (list-completeness, ports lints, determinism, fail-open ratchet, boot-limit, source-text-integrity, payload budget) are green; outcome-family.census has the one unlisted `sidecar/index.js` line that is not this lane's. Not run here: the fast and HTTP gates, a browser, a live model.

## Verdict

Fixed in source on agent/line-hold-finish-1104 (a5a3797a4, tests 695925d3b) for the case the lane owns: a job HELD at a reviewer's gate. The hold carries the split: the branch that stopped, the branches not started (each with the part of the job it was handed and the run its work comes from), the fan-out's record (its branches, the ones that failed, the joiner it meets) and the barrier with every part parked, each tied to its branch and the run that made it, with the joiner's count and timeout. The barrier leaves memory and the barrier file with the hold, so a restart reports nothing lost. The walk a decision resumes puts the barrier back once (a barrier already open is never opened twice and no part is delivered twice), delivers and releases nothing by itself, arms the joiner's timer only when a walk waits there, runs only the unfinished branches, and leaves nothing parked if it is stopped before the join. A crate a joiner merged is saved as the merge of its runs. Two defects of the resume itself surfaced here and are fixed with it: APPROVE overwrote the approved reply with the draft under review when the gate handed on to a joiner, and APPROVE of a gate right after a join shipped the plan the branches were handed instead of the merged crate.
Left, and said: a crash in the middle of a walk, before any hold, still loses the barrier and still says so; a branch that ends at an OUTBOX of its own, a split inside a split, a part with no recorded run, a batch still out and a split wider than the validator's 512-part bound are refused in words and the job ends the old terminal blocked stop; the WORKFLOWS job box lists the sibling parts waiting at the join (04075f2b0, `test/line-hold.approve-shown.test.js`, case "in a branch with a parked sibling"), so the one caveat that remains for the barrier is that a crash in the middle of a walk, before any hold, still loses it.
Regression tests: `test/line-hold.split.test.js`, `test/chain.join-loop.test.js`, `test/line-hold.matrix.test.js`.
Line-hold family invariant: what a hold saves of a split is exactly what its resume puts back; a part is parked once and joined once.
