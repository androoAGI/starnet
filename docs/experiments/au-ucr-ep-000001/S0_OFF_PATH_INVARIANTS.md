# `STARNET_UCR_ENABLE` OFF-path invariants

Flag name: `STARNET_UCR_ENABLE`. Default: unset or `0`, both meaning OFF. Sprint 0 specifies the contract. It does not wire the flag into the runtime.

## OFF invariants

1. Execution truth stays in the StarNet authority modules listed in `qa/evidence/au-ucr-ep-000001-s0/baseline/authority-module-inventory.json`.
2. University state, when later displayed, stays non-authoritative until an explicit A09 Promote.
3. No independent University truth store is created.
4. `shared/` changes stay additive. `test/events-contract.test.js` rejects a removed event, a removed property, and a newly required field. A new optional property is reported as additive and still requires an explicit snapshot update.
5. UI projections (`sidecar/tools/builtin/station.js`, `frontend/app/workflowpanel.js`, `frontend/app/linewatch.js`, `frontend/app/deliverables.js`) gain no University authority path in this sprint.
6. Baseline commands remain `npm run test:fast` and, for sidecar route changes, `npm run test:http`.

## ON behavior and rollback

ON (`STARNET_UCR_ENABLE=1`) is a non-authoritative display overlay. It does not grant University state the ability to change capability resolution, consent, routing, persistence, lineage, or ledger decisions.

Rollback sets the flag OFF, keeps the failure evidence, and returns execution to baseline StarNet behavior. If the overlay produces a false runtime claim, an additive-contract break, a competing authority path, or a reconciliation failure, A09 is recorded as `Revise` or `Reject`.

A code search of `sidecar/`, `shared/`, `frontend/`, `scripts/`, and `test/` is stored in `qa/evidence/au-ucr-ep-000001-s0/baseline/flag-code-search.json`. A hit count of zero means the running tree has no flag branch, so the OFF path is the whole current runtime.
