# Supersession and Rollback Procedure
**Experiment:** `AU-UCR-EP-000001`
**Status:** `NORMATIVE_PROCEDURE`

## 1. Core Principle: Immutability
Once a record is preserved in the immutable storage destination, it **must remain retained**. Deletion, modification, or "rolling back" by erasing data is strictly prohibited.

## 2. The Supersession Model
Any change to a previously preserved record, including corrections of errors or updates to findings, must be handled via a **Supersession Record**.

### 2.1 Mechanics of Supersession
A supersession event consists of:
1. **Preservation of Original:** The original record (vN) remains in the immutable store.
2. **Creation of Superseding Record:** A new record (vN+1) is created containing the corrected data.
3. **Binding Linkage:** The vN+1 record must contain an explicit, immutable reference to the vN record it supersedes.
4. **Invalidation Marker:** An invalidation record is issued, referencing both vN and vN+1, and signed by the appropriate authority, marking vN as "Superseded" for all future interpretations.

### 2.2 Rollback as Supersession
A "rollback" to a previous state is not a deletion of the current state. It is the creation of a new record that restores the previous values, while explicitly superseding the intervening records.

## 3. Lineage Integrity
The chain of supersession must be append-only and non-circular. Any attempt to modify the lineage ledger itself must follow this same supersession procedure.

## 4. Verification
Integrity audits must verify that:
- No preserved object has been deleted.
- Every "Superseded" marker is bound to a valid, signed supersession record.
- The current controlling interpretation is derivable by traversing the supersession chain from the most recent record backwards.
