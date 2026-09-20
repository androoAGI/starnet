# Reliability audit integration — 2026-09-19

Integrated `agent/reliability-audit-0919` into `feat/harness-backend` at `d1a6046bef6009b2cc2f9fb7f8534b2b06369c3d`, from trunk snapshot `5bb28bb833469b5b9e7a7dd7cf8573b098a90a50`. The merge tree is exactly the accepted candidate tree (`5262a71073e07ffaa24e82320d4ac439e84b175c`; tree `778eefa3a22a3ff8a0de29cbeecb45f32b917c70`). One automated-fixture isolation defect was reproduced and fixed during integration; production application code required no additional change.

The merge combines the audit's persistence, request-lifecycle, permissions, acknowledgement, catalog-retry and connector-readiness fixes with trunk's session-restoration repairs. See the [systemic analysis](2026-09-19-systemic-bug-analysis.md) and [original audit](2026-09-19-reliability-audit.md) for reproduced defects and regression matrices.

## Consistency review

- Application changes were disjoint. Overlap was confined to the generated bug index, release-source verification metadata and the test manifest. Regenerated the index and source identity and preserved the union of test entries.
- Validated 194 bug records. Shared events/schema and package contracts were unchanged. Changed scripts passed syntax checks; corresponding frontend/website assets match.
- Examined the interaction between CloudSave persistence/unknown-state guards and asynchronous session history restoration. Controlled browser proof covers delayed history before model dispatch, draft/focus protection, history failure/retry, failed save, loss of browser cache, and process restart.
- Repeated browser fault proof on the integrated commit for stale permission reads, ambiguous acknowledgements, refused routine proposals, Recipe Bay retry, execution-policy refusal, unreadable saves, bounded save responses, and durable restart. No uncaught exceptions in the fault proofs.
- Preserved pre-existing uncommitted `docs/NEXT.md` and `qa/STATUS.md` notes. Guardian independently updated its status timestamp during the campaign; that update was preserved too. Only this lane's coordination/digest notes were appended; other lanes' operational edits were not committed.

## Verification

| Gate | Accepted candidate | Integrated commit |
| --- | --- | --- |
| Full fast gate, Node 22.23.0 | 829/829 pass | 829/829 pass |
| Full HTTP gate, Node 22.23.0 | 122/122 pass | 122/122 pass |
| Customer journey gate | 38 steps pass | Covered by exact candidate-tree identity; no separate full rerun |
| Live UI journeys | 139/139 assertions pass | Covered by exact candidate-tree identity; focused live checks rerun |
| Systemic browser fault checks | Pass | Pass |
| Save recovery and restart proof | Pass | Pass |
| Session restoration and restart proof | Pass | Pass |

Receipts and hashes are in [validation.json](../evidence/reliability-merge-0919/validation.json). The first pre-merge fast attempt failed because an exact private backup of existing operational notes contained a key-shaped string inside the evidence scan. Moved that backup outside the worktree, retained the failure log, and reran the entire gate without application edits or scanner exceptions. Historical audit raw-log line endings remain unchanged so their recorded hashes remain valid; source/test/new-receipt whitespace checks pass.

The first integration (`95983cdb6`) was rejected when the post-merge fast gate failed at step 776/829: the seeded session campaign reused `dev/.scratch-workspace`, and its retained owner PID 39976 now belonged to npm's fast-test process. Rolled trunk back to `5bb28bb83` using `reset --merge`, preserving dirty operational notes. That attempt's HTTP gate passed 121/121. Bug `46f9dad7`, fixed in `b123e3ea3`, adds explicit seed-workspace selection requiring `--keep`, a unique workspace per session campaign, and fixture-owned workspace selection for seeded memory campaigns. Regression coverage verifies invalid arguments, concurrent launches, independent durable saves and restart retention. Session and memory campaigns also passed concurrently. The production ownership guard was not bypassed or weakened. The final complete gates were rerun before and after the second integration.

## Remaining work and limits

No new application regression was reproduced by the merge campaign; the automated-fixture defect above was corrected. This is bounded evidence, not a guarantee that all defects are absent. The [prioritized unresolved register](2026-09-19-systemic-bug-analysis.md#prioritized-unresolved-work) remains authoritative: affected Mac boot/install recovery, overnight spend correlation, actual Ollama behavior, Zoho schema bootstrap, provider/billing incidents and the Node 24 native test crash remain open. The earlier intermittent paid-link restart ownership refusal remains documented; the merge HTTP runs did not reproduce it. The shared-seed PID mismatch is additional evidence to examine during ownership-refusal investigations, not proof of the paid-link cause or authorization to steal a lease.

P2 validation infrastructure: Guardian's independent 20:00Z and 21:00Z campaigns were red both before and during this integration, with sidecar boot/readiness timeouts and CDP connection failures on ports 9340/9341. Its latest cycle names the first, subsequently rejected merge. [Guardian context](../evidence/reliability-merge-0919/guardian-context.json) preserves both cycles' failure tails. Investigate the scheduled runner's runtime/session, launch latency, browser lifecycle and resource contention, then rerun that runner against final trunk. The owned-workspace gates passing does not establish that Guardian recovered. Its status was not relabeled green.

No installer was built or published, and no remote push or customer-recovery claim was made. The final receipt commit changes only this digest and merge evidence. The owned workspace retains local ignored runtime/proof data and is not force-reaped.
