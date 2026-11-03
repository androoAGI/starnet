---
fingerprint: 59cafc37
slug: shared-channel-stream-readers-open-the-wrong-wor
title: Shared channel stream readers open the wrong workflow job
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: line-intake-next-1103
fix: 6c125cf2c290ee7e4478908cf5bd1344a4fc875d
origin: audit
---

# Shared channel stream readers open the wrong workflow job

## Symptom

An older delivered job from a channel chat can open the newest job on that chat instead. Channel jobs also lack the workflow action in TO REVIEW because it only recognizes sample and handoff stream names.

## Repro

Bind a dev channel chat through its ordinary /talk command to a crewed line. Deliver two tasks on that chat. Read the older run through /api/line-jobs with its stream and runId, then open its workflow. test/line-job-reader-identity.http.test.js performs both actual deliveries, repeats the reads after restart and executes the actual Workflows reader. test/line-job-reader-identity.test.js proves membership filtering precedes the result limit.

## Evidence

gen-trees/_logs/codex-overnight-1103/line-intake-s4-exact-reader-old-02.log records5/9 failures against the unchanged owner; corrected owner passes9 and later invalid-scope controls pass11. line-intake-s4-reader-http-old-03.log records12/25 failures with the original owner loaded in the actual host; line-intake-s4-reader-http-current-02.log passes25, including exact answers after restart, absent identity refusal and legacy sample navigation. line-intake-s4-readers-root.log passes11/12 affected files; the one inherited pre-LineJob wording assertion was reanchored, and line-intake-s4-workflows-reanchored.log passes133. Initial fixture/control errors are retained and explained in line-intake-handoff.md.

## Verdict

Source-fixed in6c125cf2c. The durable owner filters exact run membership before limiting and keeps the supplied stream/line scope. The OUTBOX uses one proved job for its provenance and workflow action; Workflows opens that exact ID and refuses absent records. Website mirrors are synchronized. Actual browser proof passes in line-intake-s4-preview-02.log: both real OUTBOX actions display their exact job and answer, and the oldest still does after restart. Screenshots job-1.png and old-job-after-restart.png were visually checked. That run made two synthetic provider calls and no read/navigation/restart call, with zero uncaught errors. The first attempt stopped before reader assertions because setup made three calls; its original evidence remains, the extra setup call is unattributed, and no production repair is claimed for the later two-call run. Final independent source review found no additional major in this S4 scope; the later affected37-file run retains the reader proof. No installed-app or whole-lane completion claim.
