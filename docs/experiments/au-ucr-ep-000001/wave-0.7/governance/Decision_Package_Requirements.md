# A09/G3/G4 Decision Package (W07)
**Experiment:** `AU-UCR-EP-000001`
**Wave:** `0.7`

## Instrument Prerequisites & Validation

### 1. A09 Decision
- **Prerequisites:** 
  - Signed `Identity_and_Mandate.md`
  - Signed `Authority_Acknowledgement.md`
  - Signed `SeparationConflictAssessment` (Missing)
  - Valid `CandidateQAReceipt`, `IndependentReviewReceipt`, `FindingsClosureReceipt`
- **Validation:** Signatory identity check $\cap$ Prerequisite digest verification.
- **Instrument:** `docs/experiments/au-ucr-ep-000001/wave-0.7/governance/instruments/A09_Decision.md`

### 2. G3 Acceptance
- **Prerequisites:** 
  - Valid `A09_Decision` (Outcome: `ACCEPTED`)
- **Validation:** Prerequisite digest chain verification.
- **Instrument:** `docs/experiments/au-ucr-ep-000001/wave-0.7/governance/instruments/G3_Acceptance.md`

### 3. G4 Exact-Run Release
- **Prerequisites:** 
  - Valid `G3_Acceptance`
  - Valid `A09_Decision`
  - Signed `Coordinator/Architect` assignment & acknowledgement.
- **Validation:** Prerequisite verification $\cap$ Run-binding integrity check.
- **Instrument:** `docs/experiments/au-ucr-ep-000001/wave-0.7/governance/instruments/G4_Release.md`
