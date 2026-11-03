# Feature-flag contract (`STARNET_UCR_ENABLE`)

## Flag intent

- Flag name: `STARNET_UCR_ENABLE`
- Default: `0` / unset (OFF)
- Scope in Sprint 0: contract and behavior definition only

## OFF behavior (authoritative baseline path)

When OFF:

- StarNet runtime behavior remains baseline-authoritative.
- No University-origin claim may alter execution authority.
- No University-only derived state may be presented as runtime truth.

## ON behavior (still non-authoritative in Sprint 0)

When ON:

- University views are additive overlays only.
- Runtime authority remains in existing StarNet modules:
  - capability resolution
  - permission/consent
  - routing/run execution
  - persistence/ledger/workspace lineage
- University state cannot promote itself into execution decisions.

## A09 rollback law binding

If any of the following occurs:

- false runtime claim
- additive compatibility break in shared contract
- competing authority path
- reconciliation failure with StarNet source truth

Then:

- record A09 outcome as `Revise` or `Reject`
- disable `STARNET_UCR_ENABLE`
- preserve failure evidence
- return to baseline StarNet behavior
