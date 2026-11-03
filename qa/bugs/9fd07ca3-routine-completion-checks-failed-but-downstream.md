---
fingerprint: 9fd07ca3
slug: routine-completion-checks-failed-but-downstream
title: Routine completion checks failed but downstream work and delivery continued
surface: autonomy
severity: P1
status: fixed
found: 2026-11-03
lane: line-postconditions-1103
fix: 59822864db36448d3338834d728714b73b155ff4
origin: audit
---

# Routine completion checks failed but downstream work and delivery continued

## Symptom

A scheduled or manually fired routine with an unmet caller-authored completion contract still paid for the next line stage and SEND TO, delivered its LineJob and reported a successful routine. The entry provider had finished, but the host's separate completion verdict said incomplete or verification_required. The pipeline treated those distinct facts as one success decision.

## Repro

1. Save a line with an entry agent, downstream stage and OUTBOX SEND TO target. Create a routine on that line with meta.postconditions requiring an artifact the entry does not write; repeat with an invalid contract.
2. Fire on schedule or through Run Now. The synthetic adapter completes its reply normally, and the real host assesses the explicit contract.
3. Read the entry run, LineJob, routine record and cron.result, and count downstream generation requests and workitem deliveries.

Regression: test/line-postconditions.e2e.test.js uses the actual sidecar, adapter, contract assessment and durable stores with isolated synthetic transport. Both entry points cover unmet, invalid, verified and no-contract cases. test/line-job-cron-durability.test.js drives the actual driver, production host settlement and job book across failed persistence, retry, foreign-worker terminal evidence and late owned STOP/fault.

## Evidence

Before-fix exact base 5acb0819a: the expanded actual-host control failed 40 of 84 assertions. All four unmet/invalid cases bought one downstream hop and one SEND TO target, created a receiving job, emitted five deliveries and reported routine ok / LineJob delivered. The entry execution stayed succeeded while completion was incomplete or verification_required. The four verified/no-contract positives passed.

Fixed actual-host test: all 84 assertions passed. Every unmet/invalid case bought zero hops, zero receiving jobs, zero SEND TO targets and zero deliveries. The durable job is blocked; the routine's status/reason/outcome, lastLine stop facts, error words and cron.result agree on the verification hold. The execution row remains succeeded, with no invented provider failure. All verified/no-contract positives retain their downstream behavior.

The exact original durability control failed 17 of 121 assertions. A separate pre-cleanup control exposed four stale verification sentences after late STOP/fault; the final durability test passes all 121, including first-store refusal/retry, second-store accepted-result retry, no duplicate execution/publication and released ownership. Only this private hold's superseded blocked sentence is removed; unrelated reviewer, partial and unapproved facts remain.

Owner receipts are preserved under gen-trees/_logs/codex-overnight-1103: line-postconditions-http-old-eight.log, line-postconditions-http-fixed-eight.log, line-postconditions-durability-old-complete.log, line-postconditions-stop-cleanup-old.log and line-postconditions-close-line-job-cron-durability.test.js.log. Saved original bytes and the child-inherited control loader are retained there. Earlier fixture dereference and initial stale-fact red receipts remain; neither is hidden by later greens.

Affected checks passed: outcome-family census 607, cross-surface roundtrip 598, run-outcome 114, cron.chain 88, cron.run-now 28, real cron.run-now HTTP 41 and task-postconditions 25. Payload, source integrity, list registration, ports, boot floor, determinism, fail-open ratchet and website mirrors passed. Root and takeover_map independently reviewed the shared helper and durable STOP/fault precedence without another blocker.

## Verdict

Source-fixed in 59822864db36448d3338834d728714b73b155ff4. The shared holdForCompletion helper in sidecar/cron-driver.js gates both routine doors using the caller contract and trusted own terminal evidence through RunOutcome. Strict job settlement owns the acceptance decision. The generic held phrase now says the work was not accepted, while details retain the exact reviewer or verification reason.

The new real-host regression is registered in test/http.list; durability remains in test/fast.list. This is the Batch 3 completion-authority follow-up to LineJob S3 entry/settlement and S4 publication. It does not change direct COMMS behavior, completion policy, or provider execution classification. Installer, live paid provider and combined candidate gate verification remain separate; this record claims isolated host and focused regression proof only.
