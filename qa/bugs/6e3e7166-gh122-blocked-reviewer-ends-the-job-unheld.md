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
origin: customer
report: https://github.com/androoAGI/starnet/issues/122
affected: v0.14.x installed builds (the reporter's exact build is not recorded in this register; the issue was open against v0.14.2 at the 2026-11-01 triage)
family: line-review-gate
installer: unverified
recovery: unconfirmed
---

# A reviewer's BLOCKED ends the job with nothing held, and a reply with no verdict buys five paid passes and ships unapproved (GitHub #122)

CUSTOMER ESCAPE: the reporter is afowler103, an external customer, and the issue is still open on GitHub (nothing has been posted or changed there). The record is origin: customer, so the register counts it in the user-report census until a release carries the fix and the reporter's build is seen to hold it.

## Symptom

On a work line with a review step (INBOX > drafter > reviewer > LOOP until approved), a reviewer that answered `VERDICT: blocked` stopped the line but not for a person: the job was recorded as a finished `problem` with no saved walk, so there was nothing to approve, send back or stop, and after a station restart it was the same dead record. A reviewer that forgot its VERDICT line was read as `revise`: the work went round the gate for every pass the gate allowed (twelve paid hops on a six-pass gate) and then left on the done lane marked unapproved, to the OUTBOX and through SEND TO. This is GitHub #122, a customer report (reporter afowler103, still open on GitHub), filed here with the line-hold lane that closes it. The report also asks that a review that runs out of passes still saying revise end at a person instead of leaving on DONE marked unapproved; see Verdict for what that is today.

## Repro

1. Build INBOX > drafter > reviewer > LOOP (until approved, done lane to the OUTBOX): `geometry` in `test/helpers/line-hold-rig.js`.
2. Send a job whose reviewer answers `no` + `VERDICT: blocked` at pass 0, 1 or 5 (plain, UPPER, markdown, with a trailing line, quoted), settle it the way the hub does, then reload the store and run the boot pass. Before the lane the job is a finished `problem` with no continuation. A runner with no hold port, `makeRig({ hold: false })`, still behaves that way and is the control.
3. Send a job whose reviewer answers `looks fine to me` (no VERDICT line, or a malformed or empty one), at any pass and on any wiring of the gate's escalation lane (unwired, to a dock, to an OUTBOX only, a human OUTBOX beside a downstream dock). The original chain, `test/fixtures/line-hold-5977d433c/chain.js`, buys the passes and delivers.

## Evidence

Before the lane (probe run on this tree against the original source and against a runner with no hold port):
`ORIGINAL chain (5977d433c): paid hops=12 hold=null unapproved="the review loop used all 6 passes without VERDICT: approved, so the work went on unapproved" line-output deliveries=1`
`runner of before the lane (no hold port): status=problem outcome=blocked endedAt=set continuation=none after reload+boot`

Same probes on the final source:
`CURRENT chain: paid hops=0 hold=missing_verdict at pass 0 unapproved=null line-output deliveries=0`
`current runner: status=held outcome=blocked endedAt=null continuation=held rev 1 after reload+boot`

The lane, in commits on agent/line-hold-finish-1104: 11a7b414f (a verdict gate holds a reply it cannot read; a spent gate can hold or escalate), e9a5c6cac + 4e86a5dec (the walk parks as a durable hold on its own job, a real restart keeps it), b7f2d3201 + 0137d394d (one resume owner: APPROVE, SEND BACK, STOP, the authority re-checked, WORKFLOWS buttons), a5a3797a4 + 695925d3b (a hold inside a split). Each new test fails on the commit before it (S3: "the job ends problem, finished, with no continuation"; the policy test fails the original source case for case).

Green at a5a3797a4 / 695925d3b, run singly: line-hold.split 119, line-hold.matrix 1807, line-hold.policy 9874, line-hold.resume 79, line-hold.decision 44, line-hold.authority 78, line-hold.persistence 31, line-hold.ui 31, chain 94, chain.join-loop 222, chain.limits 54, chain.multibay 23, chain-audit-1010 174, line-runner 178 assertions. On a real sidecar: line-hold.restart.http 20 (hold, kill, boot, still held, zero provider calls), line-hold.e2e.http 27 (restart, APPROVE delivers once, a duplicate POST buys nothing, DELETE is STOP, SEND BACK twice under one cap, E-STOP refuses the decision), routing.line-jobs.e2e, routing.line-admission.e2e, line-entry.invocation.http 15. The laws test-list-completeness, test-ports-imports.lint, test-ports.lint, lint-determinism, failopen-ratchet, boot-limit, source-text-integrity and payload.budget are green; outcome-family.census has one unlisted line, `sidecar/index.js` cronDegraded.publicationReadOnly (from 5fa8c331e), which is not this lane's. Not run here: the fast and HTTP gates, a browser walk of the WORKFLOWS buttons, a live model.

The repair round after review (also on agent/line-hold-finish-1104) found and closed what the first green runs did not see, each with a test that fails on the tip before it: a hold older than 100 later jobs fell out of the list WORKFLOWS reads, so nobody could decide it (`test/line-jobs.held-visible.test.js`, section 6 of `test/line-hold.ui.test.js`); the saved floor could not carry a gate's `onSpent` policy, so hold-on-exhaustion could not be switched on by any floor a person could save (`test/floor.onspent.seam.test.js`); the job box showed the request the reviewer was handed instead of the work APPROVE carries on for a self-loop gate and for a gate after a joiner (`test/line-hold.approve-shown.test.js`); a routine's job resumed with its tool families, folder and skills dropped (`test/line-hold.routine-policy.test.js`); and a walk the station died in could not be stopped or trimmed (`test/line-hold.stuck.test.js`).

Evidence run at cd4664025, singly: `routing.line-jobs.e2e` and `routing.line-admission.e2e` (the two adoption02 HTTP singles) green, `line-hold.wiring.http` green.

## Verdict

Fixed in source on agent/line-hold-finish-1104 (a5a3797a4, tests 695925d3b, repairs above). A verdict-keyed gate holds BLOCKED and a missing, malformed or empty verdict for a person with no further spend, at any pass and whatever its escalation lane reaches. The hold is a version 1 continuation on the same LineJob through the host's verified writer: the job is `held`, not finished, not delivered, and no reader counts it as delivered (hub reply, routine record, trigger, SEND TO, sample, WORKFLOWS, shipments). A restart keeps it; boot never interrupts it. A person's decision (POST /api/line-jobs/<id>/decision, or DELETE on a held job as STOP) is claimed once, the station's authority is re-checked against the job's saved ceilings, and APPROVE carries the saved draft on from the saved cursor once, SEND BACK goes round the gate one pass further with the note, and STOP buys nothing. A hold that cannot be saved exactly ends the old terminal blocked stop with the reason said.

Left, and said. An empty reviewer reply is a failed stage (`stage_empty`, the job ends `problem`, nothing is shipped), not a hold; `test/line-hold.wiring.http.test.js` pins that. `outcome-family.census` has one unlisted line, and it is trunk's (`cronDegraded`, `sidecar/index.js:17302`), not this lane's. The reporter's second request is only partly met: a review that runs out of passes still saying revise goes on marked unapproved by default (Andrew's ruling, 2026-11-04, C2 of the line-hold decisions); a gate can be set to hold it for a person or to escalate it, and the saved floor now carries that setting (`onSpent`, `test/floor.onspent.seam.test.js`), but no control in the app sets it yet. A walk the station died in is closed by STOP, never carried on from where it was. SEND TO exactly-once publication after a resumed delivery stays the at-most-once release an ordinary job has. The origin is customer, so the installed build is unverified and recovery unconfirmed: nothing has been posted on the issue, and a reply or close waits for Andrew's go and a release that holds the fix.

## Regression

Before the fix, on the original chain source and on a runner with no hold port: a `VERDICT: blocked` reply finished the job as a `problem` with no continuation (nothing to approve, send back or stop, the same dead record after a restart), and a reply with no VERDICT line bought twelve paid hops on a six-pass gate and delivered unapproved. After: the same probes hold with zero further spend and the held job survives a reload and the boot pass (`CURRENT chain: paid hops=0 hold=missing_verdict`, `current runner: status=held ... continuation=held rev 1 after reload+boot`), a person's decision is claimed once and carried on from the saved cursor, and the repair round's tests (listed in Evidence) fail on the tip before each repair and pass after it.
Regression tests: `test/line-hold.matrix.test.js`, `test/line-hold.policy.test.js`, `test/line-hold.persistence.test.js`, `test/line-hold.resume.test.js`, `test/line-hold.split.test.js`, `test/line-hold.restart.http.test.js`, `test/line-hold.wiring.http.test.js`.
Line-hold family invariant: a held job spends nothing and is never delivered until one decision is claimed; the walk it resumes from the saved cursor buys each stage once; and nothing a person is shown, offered or can reach about a held job is cut, guessed or stranded.

## Sibling coverage

{
  "adapters": [
    {"target":"entry doors: chat, scheduled fire, Run Now, webhook, folder, SEND TO, sample","state":"covered","test":"test/line-hold.matrix.test.js","scenario":"a BLOCKED reply parks as a held job at every entry door, each named through the station's own origin mapping","gate":"fast"},
    {"target":"the real sidecar over HTTP","state":"covered","test":"test/line-hold.restart.http.test.js","scenario":"hold, kill, boot: still held, zero provider calls","gate":"http"},
    {"target":"every escalation wiring and reply form on the real sidecar","state":"covered","test":"test/line-hold.wiring.http.test.js","scenario":"BLOCKED in five forms and a missing verdict hold after drafter then reviewer on all four wirings, survive a restart with the provider-call count flat, APPROVE on a human OUTBOX delivers once, an empty reply is a failed stage","gate":"http"},
    {"target":"a routine's job resumed under the routine's limits","state":"covered","test":"test/line-hold.routine-policy.test.js","scenario":"the resumed stage's tool families, folder and skills are inside the original stages' for every door","gate":"fast"}
  ],
  "entrypoints": [
    {"target":"decision route and the STOP route","state":"covered","test":"test/line-hold.e2e.http.test.js","scenario":"APPROVE delivers once, a duplicate POST buys nothing, DELETE is STOP, SEND BACK twice under one cap, E-STOP refuses the decision","gate":"http"},
    {"target":"the resume owner","state":"covered","test":"test/line-hold.resume.test.js","scenario":"APPROVE from the saved cursor, SEND BACK, STOP, a stage whose intent cannot be saved is never bought","gate":"fast"},
    {"target":"exhausted revise (a gate's passes run out)","state":"blocked","reason":"By default it still goes on marked unapproved (Andrew's ruling C2, 2026-11-04); hold and escalate are per gate in the saved floor (carried by test/floor.onspent.seam.test.js on the posted-plan path, and by test/routing.saved-onspent.test.js on the path that ships: a saved world document through makeSavedFloorProjection to the saved router's loopGateAfter) and no control in the app sets them yet."}
  ],
  "displays": [
    {"target":"WORKFLOWS job box and list","state":"covered","test":"test/line-hold.ui.test.js","scenario":"waiting-for-you chip, why, the keys, a hold older than the newest page, a hold whose workflow is gone, the stuck-walk STOP","gate":"fast"},
    {"target":"the work the card shows against what APPROVE carries on","state":"covered","test":"test/line-hold.approve-shown.test.js","scenario":"plain, self-loop, after a joiner, in a branch with a parked sibling, empty draft, files","gate":"fast"},
    {"target":"chat reply, routine record, trigger, SEND TO and shipments","state":"covered","test":"test/line-hold.matrix.test.js","scenario":"no reader counts a held job as delivered","gate":"fast"},
    {"target":"the job list the window reads","state":"covered","test":"test/line-jobs.held-visible.test.js","scenario":"a hold stays on the first page, its line's page and a page of one, after 0 to 250 later jobs","gate":"fast"}
  ],
  "lifecycle": [
    {"target":"restart","state":"covered","test":"test/line-hold.persistence.test.js","scenario":"the saved hold survives a reload and the boot pass","gate":"fast"},
    {"target":"restart on the real sidecar","state":"covered","test":"test/line-hold.wiring.http.test.js","scenario":"every held job in the matrix survives one real kill and boot, boot makes no provider call","gate":"http"},
    {"target":"one decision wins, once","state":"covered","test":"test/line-hold.decision.test.js","scenario":"token and revision make a decision exactly-once, a rival decision is refused","gate":"fast"},
    {"target":"authority at resume","state":"covered","test":"test/line-hold.authority.test.js","scenario":"a changed floor, E-STOP, a deleted agent, spent limits and altered files refuse the decision and leave the job held","gate":"fast"},
    {"target":"a crash in the middle of a resumed walk","state":"covered","test":"test/line-hold.stuck.test.js","scenario":"the owner is killed between each pair of verified writes, the station restarts, STOP reaches a finished record that retention can drop","gate":"fast"},
    {"target":"a hold inside a split","state":"covered","test":"test/line-hold.split.test.js","scenario":"the barrier is saved with the hold and joins once after a restart","gate":"fast"}
  ]
}
