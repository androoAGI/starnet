# UCR-001 acceptance checklist (execution-ready package)

`UCR-001` is the first implementation-critical work item and blocks all downstream work.

## Required contract scope

The canonical runtime state contract must cover:

- Mission
- Experiment
- Run
- Agent
- Workspace
- Stage (A01-A12 mapping)
- Capability Grant
- Permission
- Evidence
- Decision
- Deliverable
- Cost
- Status

## Required implementation constraints

- Shared contract edits are additive-only in `shared/events.js`.
- No existing shared event names or fields are renamed/removed.
- Existing runtime authority is preserved.

## Required tests

- Serialization/deserialization tests for the canonical state contract.
- Stage mapping tests (A01-A12 mapping fidelity).
- Event contract gate (`test/events-contract.test.js`) remains green after snapshot update.
- Negative test proving non-additive mutations are rejected.

## Required evidence

- Contract diff receipt against baseline.
- Updated event contract snapshot receipt.
- Negative-test receipt showing rejection behavior.
- Commit-specific gate receipts tied to tested commit.

## Gate requirement before UCR-002/UCR-003 start

- UCR-001 reviewer acceptance is explicit and recorded.
- Dependency integrity is signed by coordinator.
- QA/Evidence lane validation is independent and complete.
