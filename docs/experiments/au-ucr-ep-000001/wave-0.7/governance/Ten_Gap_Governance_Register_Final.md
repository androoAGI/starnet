# Ten-Gap Governance Register (W07 - Final Review)
**Experiment:** `AU-UCR-EP-000001`
**Wave:** `0.7`
**Human Authority:** `Hakeem Moore`
**Status:** `GAPS_VERIFIED_OPEN`

| Gap ID | Required Evidence | Current State | Precise Closure Condition | Finding |
| :--- | :--- | :--- | :--- | :--- |
| `W05-AUTH-GAP-01` | Named Decision Chair | `OPEN` | Valid `AuthorityAssignment` record naming a Decision Chair, signed by Grantor. | No signed appointment record exists. |
| `W05-AUTH-GAP-02` | Stable Identity | `OPEN` | Stable identity identifier bound to `Hakeem Moore` via approved issuer/verification. | Governed name recorded; no machine-verifiable identity binding. |
| `W05-AUTH-GAP-03` | Delegating Authority | `OPEN` | Root mandate record and signed delegation chain established for the role. | Root mandate is currently a draft; no delegation chain. |
| `W05-AUTH-GAP-04` | Scope | `OPEN` | Exact experiment, repository, and candidate manifest binding in the assignment record. | Scope defined in drafts, but not bound in an effective record. |
| `W05-AUTH-GAP-05` | Duties & Boundaries | `OPEN` | Explicit duties, prohibited actions, and role separation constraints documented in assignment. | Duties listed in draft acknowledgement; no effective appointment. |
| `W05-AUTH-GAP-06` | Effective Time | `OPEN` | Non-backdated UTC effective-from and effective-through values in assignment. | Date fields are `[REQUIRED]` placeholders in drafts. |
| `W05-AUTH-GAP-07` | Conflicts & Separation | `OPEN` | Signed `SeparationConflictAssessment` by an independent checker. | No signed assessment exists. |
| `W05-AUTH-GAP-08` | Explicit Acknowledgement | `OPEN` | Signed `AssignmentAcknowledgement` by the appointee of the duties and scope. | Acknowledgement is currently an unsigned draft. |
| `W05-AUTH-GAP-09` | Revocation & Lifecycle | `OPEN` | Signed revocation triggers and lifecycle event receipt forms. | Revocation conditions are `[REQUIRED]` placeholders. |
| `W05-AUTH-GAP-10` | Run Authorization | `OPEN` | `G4ExactRunRelease` receipt issued only after G3 acceptance. | Blocked by all previous gaps and missing G3 acceptance. |

**Conclusion:** All ten gaps are confirmed `OPEN`. Technical progress is decoupled from governance authority.
