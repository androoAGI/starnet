# W07 A09/G3/G4 Decision Templates

## Control Record
- **Status:** `DRAFT_UNAUTHORIZED`
- **Pre-requisite:** These templates require a valid, acknowledged Decision Chair and Coordinator/Architect appointment before use.

## Template 1: A09 Governance Decision
**Purpose:** Final decision on the integrated dossier.

- **Dossier Manifest Digest:** `[REQUIRED]`
- **Decision:** `[APPROVE | REVISE | REJECT]`
- **Scope/Conditions:** `[REQUIRED]`
- **Decision Chair Signature:** `[REQUIRED]`
- **Timestamp:** `[UTC]`

---

## Template 2: G3 Gate Acceptance
**Purpose:** Formal acceptance of G3 closure based on A09 `APPROVE` outcome.

- **A09 Decision ID:** `[REQUIRED]`
- **Candidate Identity:** `[REQUIRED]`
- **QA/Review/Closure Receipts:** `[REQUIRED]`
- **Outcome:** `G3_ACCEPTED`
- **Signature:** `[REQUIRED]`

---

## Template 3: G4 Exact-Run Release
**Purpose:** Authorization of a specific non-production implementation run.

- **G3 Acceptance ID:** `[REQUIRED]`
- **Run ID / Environment:** `[REQUIRED]`
- **Implementation Scope:** `[REQUIRED]`
- **Rollback Target:** `[REQUIRED]`
- **Coordinator Signature:** `[REQUIRED]`
- **Timestamp:** `[UTC]`
