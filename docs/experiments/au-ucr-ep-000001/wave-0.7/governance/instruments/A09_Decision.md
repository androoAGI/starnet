# Instrument: A09 Decision (Draft)
**Object Kind:** `A09_DECISION`
**Status:** `UNSIGNED_DRAFT`

- **Prerequisites:**
    - Valid `AuthorityAssignment` (Decision Chair)
    - Valid `AssignmentAcknowledgement`
    - Valid `SeparationConflictAssessment`
    - Valid `CandidateQAReceipt`
    - Valid `IndependentReviewReceipt`
    - Valid `FindingsClosureReceipt`
- **Candidate ID/Manifest:** `[REQUIRED]`
- **Decision:** `[REQUIRED: ACCEPTED | REVISE | REJECTED]`
- **Scope/Conditions:** `[REQUIRED]`
- **Signature:** `[REQUIRED]`

**Validation Method:** Cryptographic verification of all prerequisite digests and signatory identity.
**Issuer:** `Decision Chair`
**Signatory:** `[REQUIRED]`
**Effective Date:** `[REQUIRED]`
**Revocation Conditions:** `[REQUIRED]`
