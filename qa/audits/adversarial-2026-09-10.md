# StarNet adversarial audit — 2026-09-10

Three new P1 failures reproduced against source 2aa8305c0 in an isolated seeded station. All three persisted across a real sidecar restart. No product fix, trunk edit, merge, production-station mutation, or paid model call was performed.

| Priority | Finding | Observed consequence | Record |
| --- | --- | --- | --- |
| P1 | Conflicting loop review decisions | File reverted while API and UI say approved; both requests return success | [bb24585f](../bugs/bb24585f-loop-approve-reject-race.md) |
| P1 | Stale client save overwrite | A later interaction in an older client erases another client's saved conversation | [7546cccd](../bugs/7546cccd-stale-client-save-overwrite.md) |
| P1 | Direct-to-group conversion loses files | Existing message attachments disappear and their saved references are discarded | [408a0794](../bugs/408a0794-group-conversion-loses-attachments.md) |

The Git race reproduced twice in separate disposable repositories; the [second receipt](../evidence/adversarial-0910/loop-race-repeat.json) has a different candidate and undo commit.

The loop race deserves the first repair: it violates the review decision at the actual Git boundary. Save conflict protection is next because it replaces the full station snapshot. Attachment migration should be transactional before conversion is acknowledged.

## Evidence and reproduction

[Restart receipt](../evidence/adversarial-0910/restart-receipt.json) contains the concrete before/after fields, original file reference, candidate and undo commits, and persisted verdict. [Boundary probe receipt](../evidence/adversarial-0910/boundary-probes.json) records concurrent routine creation and malformed-input results.

The live browser used http://127.0.0.1:9236; a deterministic local model at :9237 supported successful runs, held streams and cancellation. The loop fixture placed a known file during the held run, following the existing loops-git.e2e fixture technique; StarNet itself performed the real Git harvest and undo. This proves the review transaction failure, not real-model coding quality.

The API reproducers are under dev/: audit-stale-save.cjs, audit-conversion.cjs, audit-loop-verdict.cjs, with audit-api.cjs and audit-mock.cjs. Use only a disposable seeded station. The mock and API helper default to ports 9237/9236. Launch the mock with node dev/audit-mock.cjs; launch node dev/seed.js --keep with SKYNET_PORT=9236, SKYNET_DEFAULT_MODEL=anthropic/claude-haiku-4.5, SKYNET_OPENROUTER_BASE=http://127.0.0.1:9237/api/v1, and SKYNET_OPENROUTER_KEY=audit-local-mock. Worktree dependency resolution used NODE_PATH pointing to the integration checkout's installed node_modules. The loop reproducer creates and grants its own disposable repository; it never operates on the integration checkout's Git history.

## Scope and negative controls

Exercised live: direct chat success and provider failure; two-client stale writes; session creation/switch/reload; recruitment and direct-to-group conversion; file upload and persistence; group stop/retry; scheduling creation concurrency; real loop candidate harvest and conflicting reviews; sidecar interruption/restart. Inspected the emitting/store/rendering paths for each finding.

Cross-surface invalid-input probes covered schedules/timezones, empty routine tasks, missing loop folders/check roots, widgets, unknown group participants/files, stale group revisions, stale journey generations, malformed backup envelopes, runtime limits and project removal. Fourteen of fifteen returned a refusal. Creating a routine for a nonexistent agent returned success; this alone is not counted as a new major bug because execution validation and historical missing-agent behavior require separate assessment. Eight concurrent identical routine creates correctly produced one job and seven duplicate acknowledgements.

Additional leads, not counted as confirmed major findings: an old stopped group turn accepts another retry after its prior retry completed (API demonstrated; no duplicate external side effect established); group portability and model access to binary attachments need a separate end-to-end migration/vision pass. No backup-portability claim is made from source inspection alone.

Known-issue comparison covered qa/BUGS.md, qa/KNOWN_ISSUES.md, the live finding ledger, current NEXT entries and historical audits. The related roster, rating-watermark, group-message-attachment and late-loop-settlement fixes do not cover these reproduced root causes. 'New' means no matching finding was located in those records; it cannot rule out an unrecorded discovery in another active session.

## Validation and limits

Existing regression suites passed: save.test.js (70 assertions), group-sessions.test.js, group-sessions.edge.test.js, loopjob.test.js (193 assertions), loopjob-driver.test.js (175 assertions). They remain green despite these live failures. The audit adds reproductions and records, not a source repair.

The full fast/HTTP suites were not run, and no release-readiness claim is made. Installed Windows/macOS builds, real paid-provider behavior, production OAuth accounts, actual microphones/audio, native input isolation, updater/signing, remote SSH/Docker and long-duration exhaustion were not verified. This is an adversarial audit of representative cross-feature and failure paths, not proof that every product behavior was exhausted.
