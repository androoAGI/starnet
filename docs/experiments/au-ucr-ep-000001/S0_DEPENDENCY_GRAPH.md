# UCR dependency graph freeze (S0)

This sprint freezes dependency order and execution constraints for UCR-001..UCR-012.

## Frozen order

```mermaid
flowchart TD
  UCR001 --> UCR002
  UCR001 --> UCR003
  UCR001 --> UCR004
  UCR002 --> UCR005
  UCR003 --> UCR005
  UCR004 --> UCR005
  UCR005 --> UCR006
  UCR005 --> UCR007
  UCR005 --> UCR008
  UCR004 --> UCR009
  UCR006 --> UCR009
  UCR007 --> UCR010
  UCR008 --> UCR010
  UCR009 --> UCR010
  UCR010 --> UCR011
  UCR011 --> UCR012
```

## Critical path

- `UCR-001` is the only implementation-critical first move.
- `UCR-002` and `UCR-003` are parallel-safe **only** after explicit UCR-001 acceptance.
- `UCR-004` remains in Security/Governance lane after UCR-001 acceptance.
- Campus/UI runtime-claim surfaces remain blocked from authority assertions until reconciliation controls exist.

## Authority constraints across all dependencies

- No independent University truth store is permitted.
- Existing StarNet authority modules remain source facts:
  - runtime and events
  - capability resolution and consent
  - persistence and lineage
  - workflow routing
  - spend/budget/ledger
