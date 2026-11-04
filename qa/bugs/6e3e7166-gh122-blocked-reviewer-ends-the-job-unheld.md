---
fingerprint: 6e3e7166
slug: gh122-blocked-reviewer-ends-the-job-unheld
title: A reviewer's BLOCKED ends the job with nothing held, and a reply with no verdict buys five paid passes and ships unapproved (GitHub #122)
surface: world
severity: P1
status: fixed
found: 2026-11-04
lane: line-hold-finish-1104
fix: a5a3797a4dbaaea17c1440889dc23e7a0731fe2f
origin: audit
---

# A reviewer's BLOCKED ends the job with nothing held, and a reply with no verdict buys five paid passes and ships unapproved (GitHub #122)

## Symptom

On a work line with a review step (INBOX > drafter > reviewer > LOOP until approved), a reviewer that answered `VERDICT: blocked` stopped the line but not for a person: the job was recorded as a finished `problem` with no saved walk, so there was nothing to approve, send back or stop, and after a station restart it was the same dead record. A reviewer that forgot its VERDICT line was read as `revise`: the work went round the gate for every pass the gate allowed (twelve paid hops on a six-pass gate) and then left on the done lane marked unapproved, to the OUTBOX and through SEND TO. This is GitHub #122, filed here with the line-hold lane that closes it.

## Repro

1. Build INBOX > drafter > reviewer > LOOP (until approved, done lane to the OUTBOX): `geometry` in `test/helpers/line-hold-rig.js`.
2. Send a job whose reviewer answers `no` + `VERDICT: blocked` at pass 0, 1 or 5 (plain, UPPER, markdown, with a trailing line, quoted), settle it the way the hub does, then reload the store and run the boot pass. Before the lane the job is a finished `problem` with no continuation. A runner with no hold port, `makeRig({ hold: false })`, still behaves that way and is the control.
3. Send a job whose reviewer answers `looks fine to me` (no VERDICT line, or a malformed or empty one), at any pass and on any wiring of the gate's escalation lane (unwired, to a dock, to an OUTBOX only, a human OUTBOX beside a downstream dock). The original chain, `test/fixtures/line-hold-5977d433c/chain.js`, buys the passes and delivers.
Regression: `test/line-hold.matrix.test.js` (the BLOCKED forms x passes matrix, the no-verdict family on the real store, held-job-never-spends, no reader counts a held job as delivered), `test/line-hold.policy.test.js` (the whole family in process, and the same battery against the original source, which must stay red), `test/line-hold.persistence.test.js`, `test/line-hold.restart.http.test.js`.

## Evidence

Before the lane (probe run on this tree against the original source and against a runner with no hold port):
`ORIGINAL chain (5977d433c): paid hops=12 hold=null unapproved="the review loop used all 6 passes without VERDICT: approved, so the work went on unapproved" line-output deliveries=1`
`runner of before the lane (no hold port): status=problem outcome=blocked endedAt=set continuation=none after reload+boot`

Same probes on the final source:
`CURRENT chain: paid hops=0 hold=missing_verdict at pass 0 unapproved=null line-output deliveries=0`
`current runner: status=held outcome=blocked endedAt=null continuation=held rev 1 after reload+boot`

The lane, in commits on agent/line-hold-finish-1104: 11a7b414f (a verdict gate holds a reply it cannot read; a spent gate can hold or escalate), e9a5c6cac + 4e86a5dec (the walk parks as a durable hold on its own job, a real restart keeps it), b7f2d3201 + 0137d394d (one resume owner: APPROVE, SEND BACK, STOP, the authority re-checked, WORKFLOWS buttons), a5a3797a4 + 695925d3b (a hold inside a split). Each new test fails on the commit before it (S3: "the job ends problem, finished, with no continuation"; the policy test fails the original source case for case).

Green at a5a3797a4 / 695925d3b, run singly: line-hold.split 119, line-hold.matrix 1807, line-hold.policy 9874, line-hold.resume 79, line-hold.decision 44, line-hold.authority 78, line-hold.persistence 31, line-hold.ui 31, chain 94, chain.join-loop 222, chain.limits 54, chain.multibay 23, chain-audit-1010 174, line-runner 178 assertions. On a real sidecar: line-hold.restart.http 20 (hold, kill, boot, still held, zero provider calls), line-hold.e2e.http 27 (restart, APPROVE delivers once, a duplicate POST buys nothing, DELETE is STOP, SEND BACK twice under one cap, E-STOP refuses the decision), routing.line-jobs.e2e, routing.line-admission.e2e, line-entry.invocation.http 15. The laws test-list-completeness, test-ports-imports.lint, test-ports.lint, lint-determinism, failopen-ratchet, boot-limit, source-text-integrity and payload.budget are green; outcome-family.census has one unlisted line, `sidecar/index.js` cronDegraded.publicationReadOnly (from 5fa8c331e), which is not this lane's. Not run here: the fast and HTTP gates, a browser walk of the WORKFLOWS buttons, a live model.

## Verdict

Fixed in source on agent/line-hold-finish-1104 (a5a3797a4, tests 695925d3b). A verdict-keyed gate holds BLOCKED and a missing, malformed or empty verdict for a person with no further spend, at any pass and whatever its escalation lane reaches. The hold is a version 1 continuation on the same LineJob through the host's verified writer: the job is `held`, not finished, not delivered, and no reader counts it as delivered (hub reply, routine record, trigger, SEND TO, sample, WORKFLOWS, shipments). A restart keeps it; boot never interrupts it. A person's decision (POST /api/line-jobs/<id>/decision, or DELETE on a held job as STOP) is claimed once, the station's authority is re-checked against the job's saved ceilings, and APPROVE carries the saved draft on from the saved cursor once, SEND BACK goes round the gate one pass further with the note, and STOP buys nothing. A hold that cannot be saved exactly ends the old terminal blocked stop with the reason said.
Left, and said: a crash in the middle of a walk is still the interrupted job it was (a per-hop durable intent on the original walk is not part of this lane); SEND TO exactly-once publication after a resumed delivery stays the at-most-once release an ordinary job has; the onSpent gate policy has no control in the UI yet. Origin is classified audit, not customer: if #122 is a customer escape, reclassify and add the escape fields.
Regression tests: `test/line-hold.matrix.test.js`, `test/line-hold.policy.test.js`, `test/line-hold.persistence.test.js`, `test/line-hold.resume.test.js`, `test/line-hold.split.test.js`.
Line-hold family invariant: a held job spends nothing and is never delivered until one decision is claimed; the walk it resumes from the saved cursor buys each stage once.
