# GATE-03 Consolidated Decision Package

## 1. Control record

- **Experiment:** `AU-UCR-EP-000001`
- **Wave:** `0.3`
- **Artifact ID:** `GATE-03`
- **Status:** `GATE_CLOSED_REVISE_REQUIRED`
- **Status family:** `GATE_CLOSED`
- **Owner:** Coordinator — document preparer only; no governed Coordinator/Architect assignment or release authority is inferred
- **Review basis:** `D-02_INDEPENDENT_DESIGN_ASSURANCE_REPORT.md`
- **Reviewer label:** `D-02 / Agent D`; review completed for design assurance but not formally acknowledged under an effective governed assignment
- **Acceptance receipt:** **NONE**
- **Decision Chair:** **UNASSIGNED / NOT APPROVED**
- **Prepared:** `2026-10-11`
- **Authorization effect:** **NONE**

This package consolidates existing evidence and D-02 findings. It is not acceptance, publication,
QA certification, role assignment, implementation authority, sandbox authority, test authority,
execution release, or permission to merge. **PR merge is BLOCKED.**

## 2. Plain-language executive summary

The Wave 0.3 design documents exist, but all are untracked working-tree files and therefore are not
contained in repository revision `c0579a4e4d272162963de09bdec7494d822c1fe2`. D-02 completed the
authorized design-assurance review and found that A-04, B-03, C-04, and LAB-03 require revision.
It blocked SCRUM03 as a design because its paths and existence claims are stale. D-02 itself is a
completed review report, not formal acknowledgement or acceptance, because no effective governed
Independent Reviewer assignment exists.

The package cannot advance. Required governed roles are unassigned, QA and acceptance receipts are
absent, baseline gates remain failed/blocked, exact publication and commit linkage is absent, and
the current `MANIFEST.sha256` disagrees with all three current PRE_A09 receipt files. No design,
runtime, enforcement control, laboratory, test, or transition is approved. G1 and G2 remain
pending, G3 remains closed, and G4 remains not authorized.

## 3. Repository identity and provenance

- Repository: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Branch independently verified: `cursor/populate-authority-readiness-7886`
- Current revision independently verified:
  `c0579a4e4d272162963de09bdec7494d822c1fe2`
- Git state before creation of this package: A-04, B-03, C-04, D-02, LAB-03, and SCRUM03 were
  individually reported as untracked.
- Provenance rule: these artifacts may be identified by current local byte count and SHA-256, but
  they are **not commit-addressed** and the current revision does not contain them.
- This GATE-03 package is also a new untracked artifact unless and until separately published.
  Its final byte identity must be measured externally after writing; a full-file digest cannot be
  embedded in the same file without changing that digest.

## 4. Artifact inventory

SHA-256 values are over exact current local bytes, independently measured on `2026-10-11`.
“Owner” is an artifact-preparer label only, not a governed appointment.

| Stable ID | Exact path | Bytes | SHA-256 | Author/preparer role | Artifact status | D-02 verdict | Acceptance receipt |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| A-04 | `docs/experiments/au-ucr-ep-000001/wave-0.3/A-04_TRUSTED_RUNTIME_ATTESTATION_SPEC.md` | 30,976 | `3bdb80b055f672141101dd4417aa75df349e4a8b25c3f19051a77a98613cc5ed` | Agent A | `DESIGN_DRAFT`; untracked | `REVISE AS DESIGN` | None |
| B-03 | `docs/experiments/au-ucr-ep-000001/wave-0.3/B-03_EXECUTABLE_ENFORCEMENT_SPEC.md` | 32,599 | `f6cad82b5bb9049a8a5bebc4bbfd4d8be09af3b927aaa9b301fb287b09c6582a` | Agent B | `DESIGN_DRAFT`; untracked | `REVISE AS DESIGN` | None |
| C-04 | `docs/experiments/au-ucr-ep-000001/wave-0.3/C-04_AUTHORITY_PACKAGE_DRAFT.md` | 11,385 | `f78fa119d767285efb984b3246842081ac0be4a7513eadbd70566bae64377999` | Agent C documentation/design lane | `DESIGN_DRAFT`; untracked | `REVISE AS DESIGN` | None |
| LAB-03 | `docs/experiments/au-ucr-ep-000001/wave-0.3/LAB-03_ISOLATED_EXECUTION_ENVIRONMENT_SPEC.md` | 32,071 | `b9ba2f40db06921fc01368b00a838d59f5ab0d72f9867c0a39d2277c9f4c2361` | LAB Agent | `DESIGN_DRAFT`; untracked | `REVISE AS DESIGN` | None |
| D-02 | `docs/experiments/au-ucr-ep-000001/wave-0.3/D-02_INDEPENDENT_DESIGN_ASSURANCE_REPORT.md` | 25,418 | `6a1ec6f35f2b66a87da0270a713b23c2e767a8784c7cbdf241ca278905b664d0` | Agent D, assurance reviewer label | `REVIEW_COMPLETE_NOT_ACCEPTED`; untracked | Review report; no acceptance effect | None |
| SCRUM03 | `docs/experiments/au-ucr-ep-000001/wave-0.3/SCRUM03_RECONCILIATION.md` | 13,706 | `b3b3349454e76a6705674e5c65d21e3aee3ff4519941586313bca727bef7abd3` | Reconciliation preparer | `BLOCKED_AS_DESIGN`; untracked | `BLOCK AS DESIGN` | None |
| GATE-03 | `docs/experiments/au-ucr-ep-000001/wave-0.3/GATE-03_CONSOLIDATED_DECISION_PACKAGE.md` | Measured after write | Reported after write | Coordinator, document preparer only | `GATE_CLOSED_REVISE_REQUIRED`; untracked | Consolidates D-02; not a new review | None |

## 5. Corrected task status

| Task | Work completion | Review completion | Formal acceptance | Dependency eligibility | Corrected status |
| --- | --- | --- | --- | --- | --- |
| A-04 | Draft produced; revisions required | D-02 design assurance complete; not formal governed acknowledgement | None / not accepted | Ineligible | `DESIGN_DRAFT` |
| B-03 | Draft produced; revisions required | D-02 design assurance complete; not formal governed acknowledgement | None / not accepted | Ineligible | `DESIGN_DRAFT` |
| C-04 | Draft template produced; revisions required; appointment not executed | D-02 design assurance complete; not formal governed acknowledgement | None / not accepted | Ineligible | `DESIGN_DRAFT` |
| LAB-03 | Draft produced; construction and tests not started | D-02 design assurance complete; not formal governed acknowledgement | None / not accepted | Ineligible | `DESIGN_DRAFT` |
| D-02 | Authorized assurance report produced | `REVIEW_COMPLETE_NOT_ACCEPTED`; no effective reviewer assignment | None / not accepted | Cannot satisfy formal-review dependency | `REVIEW_COMPLETE_NOT_ACCEPTED` |
| SCRUM03 | Draft produced but materially stale and unreliable | D-02 review complete with block | None / not accepted | Ineligible | `BLOCKED_AS_DESIGN` |
| GATE-03 | Consolidation produced; gate criteria unmet | Relies on D-02; independent review/QA of corrected package absent | None / not accepted | Closed | `GATE_CLOSED_REVISE_REQUIRED` (`GATE_CLOSED`) |

Work production is not review completion. Review completion is not formal acknowledgement.
Formal acknowledgement is not acceptance. Acceptance is not execution release. No task is
dependency-eligible.

## 6. Independent review findings and required revisions

### A-04 — REVISE AS DESIGN

Objections: external observations are not commit-bound or authoritative; the example envelope is
not a complete schema; producer, verifier, and session states are conflated; endpoint identity and
TPM bootstrapping are incomplete; root compromise recovery is undefined; heartbeat freshness lacks
normative verifier liveness; and current PRE_A09 manifest reliance is invalid.

Required revisions:

1. Publish normative ARM and evidence JSON Schemas with fields, bounds, duplicate-key behavior,
   extension policy, and evidence-type conditionals.
2. Define separate producer-evidence, verifier-verdict, and session-state machines, including legal
   transitions, precedence, restart behavior, and terminal conditions.
3. Define endpoint identity as a versioned provider tenant/account, model authority, region,
   protocol, TLS/proxy, and request-signature tuple.
4. Add a TPM profile for EK/AK proofing, PCR/event logs, updates, clear/replacement, vTPM cloning,
   and decommissioning.
5. Add trust-root governance and compromise recovery with role classes, quorum, witness,
   distribution, rollover, and emergency revocation.
6. Require verifier-driven liveness challenges or justified channel-bound equivalent freshness.
7. Replace manifest reliance with corrected append-only provenance and bind revised A-04 to a
   containing commit and publication receipt.

### B-03 — REVISE AS DESIGN

Objections: the state transition relation is incomplete; undefined A-code nodes look executable;
cross-store atomicity is unspecified; schemas and hash framing are ambiguous; A-04/B-03 algorithms
are unreconciled; suspension and rollback authorities are vague; PEP entry-point coverage has no
authoritative inventory; and the stale PRE_A09 manifest prevents package integrity reliance.

Required revisions:

1. Replace the status list with a versioned transition table, guards, invariants, idempotency,
   concurrency, object-version, and recovery rules.
2. Represent undefined A03-A05 and A10-A11 nodes as disabled registry entries until signed
   authoritative definitions enable them.
3. Specify a single transactional store or transactional-outbox design with crash invariants,
   replay, orphan detection, reconciliation, and anchor behavior.
4. Publish normative schemas and unambiguous framed hash/signature inputs.
5. Reconcile A-04/B-03 algorithms in an approved algorithm/key-purpose registry, including
   enrollment, custody, trust-store administration, revocation, and compromise recovery.
6. Define suspension, rollback, reinstatement, and break-glass authority, separation, scope,
   expiry, quorum, and receipts.
7. Add controlled entry-point inventory and continuous bypass detection, including administrative
   and backup/restore paths.
8. Bind revised B-03 and its evidence to a containing commit and corrected append-only manifest.

### C-04 — REVISE AS DESIGN

Objections: assignment authority is not grounded; conflict checks omit assignment authorities,
checkers, and delegators; assignment lifecycle is implicit; signatures are free text; candidate
bindings omit repository/object/algorithm/schema/replay details; and PRE_A09 integrity linkage is
invalid.

Required revisions:

1. Add assignment-authority policy and evidence proving the authority's mandate while prohibiting
   self-, reciprocal-, or incompatible appointment.
2. Extend stable-identity and transitive conflict checks to assignment authority, checker, and
   every delegator.
3. Define the assignment lifecycle and decision validity across suspension, expiry, revocation,
   reinstatement, and supersession.
4. Replace free-text signature fields with a versioned receipt schema and approved identity/key
   verification profile.
5. Fully qualify repository, object type, digest algorithm, schema/policy version, unique receipt
   ID, and replay controls.
6. Use only a corrected independently verified append-only manifest and bind revised C-04 to a
   containing commit.

### SCRUM03 — BLOCK AS DESIGN

Objection: it falsely says current A-04, B-03, and LAB-03 files were not found, points to nonexistent
`*_DESIGN_DRAFT.md` files, and gives D-02 the wrong target path. Its tracker view is materially stale.

Required revisions:

1. Reconcile all six actual paths and byte digests and remove false missing-file/PENDING_TARGET claims.
2. Record A-04, B-03, C-04, and LAB-03 as drafts produced, design assurance reviewed with D-02
   verdicts, and not accepted.
3. Record D-02 at its actual report path as `REVIEW_COMPLETE_NOT_ACCEPTED`, including the absent
   effective reviewer assignment.
4. Separate preparer labels from governed assignments.
5. Add exact dependency IDs, digests, receipt paths, provenance status, and unresolved PRE_A09
   manifest mismatches.
6. Preserve G1 `PENDING`, G2 `PENDING`, G3 `CLOSED`, G4 `NOT AUTHORIZED`, mandatory holds, and no
   acceptance receipt.
7. Bind replacement reconciliation to a containing commit and a new review cycle.

### LAB-03 — REVISE AS DESIGN

Objections: no exact revision appears in its control record; host observations lack evidence
provenance; one acceptance set cannot cover all platform options; collector/signing/time/broker
trust design is absent; admin lifecycle is undefined; egress relay risks are incomplete; fixture
sanitization is non-normative; and teardown failure/provider retention states are undefined.

Required revisions:

1. Add repository revision and a per-observation register with path, method, actor, UTC, size/hash,
   limitations, and commit applicability.
2. After an ADR, create platform-specific control/evidence profiles and map each criterion to its
   enforcement primitive and independent evidence source.
3. Define trust architecture and schemas for image/policy signatures, preflight receipts,
   collector records, time health, credential broker, revocation, and custody, reconciled with
   A-04/B-03.
4. Add privileged administration and break-glass lifecycle, separation, quorum, recording,
   alerting, expiry, and independent review.
5. Add destination-tenant identity and application-layer egress controls, including relay/upload
   abuse and certificate policy.
6. Define deterministic fixture transformation, archive recursion/decompression limits, file-type
   and script/macro rules, and signed provenance.
7. Define teardown-failure/quarantine states, retained provider copies, crypto-erasure evidence,
   and resumption rules.
8. Bind revised LAB-03 to a containing commit and corrected provenance.

## 7. Evidence references and unresolved blockers

Governing references include:

- `AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md` — SHA-256
  `afc9d17f9cf6b93727b33c297cbde0999e5c2d35348a5d9ed723570bd393b6ac`
- `S0_EVIDENCE_CONVENTIONS.md` — SHA-256
  `e3364a149bb8137771959321ebbd68dacaeb579652283b81fd43c4f447d8627e`
- `S0_QA_READINESS_GATE.json` — SHA-256
  `c90125d89d05c74b3a3a9fc93d585fcc32ef1b3a287d316e2536cb5cb0abadba`
- `S0_WORKTREE_LANE_REGISTER.yaml` — SHA-256
  `eaf4604648539caa981bb1e627459420dd912c68c3171edddb1ebc7e4d38b985`
- `qa/evidence/au-ucr-ep-000001-s0/receipts/readiness-check.json` — SHA-256
  `f7b581ed44b2e6de7f8175aece5dadea7570229115ebf9860ad833c3b0384964`
- D-02 at the exact path and identity in Section 4.

Open blockers:

1. No named, stable, effective assignments or acknowledgements for Coordinator/Architect,
   QA/Evidence Agent, Independent Reviewer, Decision Chair, Publication Custodian, implementation,
   or Security/Governance roles. `unassigned_role_only` grants no authority.
2. No formal QA certification, Independent Reviewer acknowledgement, publication receipt,
   Decision Chair receipt, acceptance receipt, or execution-release receipt exists for Wave 0.3.
3. Exact evidence linkage is absent: the Wave 0.3 artifacts are untracked, not contained in the
   current revision, and not bound to publication receipts.
4. Baseline gates remain failed: `test:fast` failed at step `73/953` and `test:http` failed at step
   `38/156` at canonical S0 commit `cdc793ba738c688ef2493fcd196043bfb3fddd77`.
   Readiness remains `blocked`, acceptance `false`, and S1 closed.
5. SCRUM03 contains stale/nonexistent paths and false missing-file claims.
6. No verified shared trust root, key custody, revocation, trusted time, schema registry, state
   machines, runtime attestation, mandatory PEP, protected state/audit boundary, or isolated lab
   exists.
7. No corrected designs, independent QA, new independent re-review, finding closure, or
   dependency-closure record exists.
8. `STARNET_UCR_ENABLE` remains OFF/non-authoritative; construction, implementation, testing,
   execution, promotion, and merge remain held.

### Verified PRE_A09 manifest mismatches

The current manifest is 821 bytes, SHA-256
`4a67cbe5e960d12a9c15372a7ccdbec0d484dc7a4e58a25d9de8ed9a636fb145`.
Its listed digests do not match current receipt bytes:

| Receipt | Manifest SHA-256 | Current bytes | Current SHA-256 | Result |
| --- | --- | ---: | --- | --- |
| `EV-INF-PRE-A09-AUTHORITY-NAMES-00.json` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | 6,608 | `aef3c4146bbd978a7c4eb2b5798776351e2728d450dd9556404fd8facaa611ef` | `MISMATCH` |
| `EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | 2,900 | `058bcc5cd035c5c1be243e90be0ec59486e9a7029489511ef2367e7cb436a4ba` | `MISMATCH` |
| `EV-INF-PRE-A09-LOCAL-BRIDGE-00.json` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | 13,605 | `100c4c174df2cf0fc41f4502410eebd3ca32631e6c7a77a36d422c135ca70f28` | `MISMATCH` |

Do not overwrite either generation. The historical deterministic-verification claim is not current
integrity evidence. A new append-only manifest must identify the exact current commit or explicit
working-tree state, sizes, hashes, producer, supersession reason, and independent verification.

## 8. A09 and gate status

### A09 authority

The Decision Chair is **UNASSIGNED / NOT APPROVED**. No appointment, acknowledgement, effective
assignment, decision, signature, or A09 transition is fabricated or inferred. PRE_A09 runtime
success and `PASS_WITH_A09_TRANSITION_CLOSED` do not certify capability, accept governance, or
authorize transition.

### Gate states and exact prerequisites

- **G1 — PENDING.** Requires corrected A-04, B-03, C-04, LAB-03, and SCRUM03 artifacts addressing
  every D-02 revision; exact stable paths; containing commits; publication receipts; corrected
  append-only provenance; and complete governed role assignments.
- **G2 — PENDING.** Requires independent QA of exact corrected commits and evidence, disposition of
  baseline `test:fast` and `test:http` failures, verified manifests and dependency links, assigned
  independent actors, and a new digest-specific independent review with all material findings
  resolved or explicitly carried.
- **G3 — CLOSED, not complete.** It requires corrected designs, QA, independent re-review, a valid
  Decision Chair governance/acceptance receipt for the exact published candidate, and dependency
  closure. None exists. G3 must not be described as completed, passed, or accepted.
- **G4 — NOT AUTHORIZED.** It requires accepted governance plus a later, separate
  Coordinator/Architect execution-release receipt tied to exact implementation and governance
  commits, all prerequisite receipts, dependency/feature-flag state, and rollback target. No G4
  work or execution may begin.

## 9. Separate future authorization requests

Only the following request may be considered now:

1. **Design-revision work only:** authorize edits to A-04, B-03, C-04, LAB-03, and SCRUM03 that
   address every D-02 revision, plus corrected append-only provenance preparation. This request
   would not authorize implementation, construction, testing, acceptance, execution, or merge.

The following requests remain separate and blocked:

2. **Later enforcement implementation:** blocked pending accepted revised governance/designs,
   assigned roles, implementation plan, QA plan, and a separate execution-release authorization.
3. **Later sandbox construction:** blocked pending accepted LAB-03 revision, platform ADR, owner
   and security approvals, assigned roles, and a separate construction authorization.
4. **Later testing:** blocked pending accepted test plans, constructed/approved controls or lab as
   applicable, bounded scope, QA independence, safety approvals, and a separate test authorization.

Requests 2-4 must not be bundled with or inferred from request 1.

## 10. Rollback, suspension, and mandatory holds

- Default state is blocked. Keep feature/treatment paths OFF and baseline StarNet authoritative.
- Any material contradiction, evidence mismatch, role conflict, stale/absent receipt, provenance
  failure, safety regression, revocation, or uncertainty immediately preserves or restores the
  closed/blocked state.
- Stop new governed work, suspend affected transitions/sessions, preserve all evidence and prior
  receipts append-only, and record escalation without rewriting history.
- Rollback may target only a separately verified prior accepted revision. If no accepted,
  attested rollback target exists, remain blocked.
- Resume only after corrected publication, assigned independent QA/review, finding closure,
  Decision Chair acceptance, dependency closure, and—only for execution—a separate
  Coordinator/Architect execution-release receipt.
- No implementation, control enablement, account/key/ACL/network/VM change, laboratory
  construction, test, script, commit, push, merge, acceptance, or execution is authorized.
- PR merge remains **BLOCKED**.

## 11. Required next decisions and stop statement

Required decisions:

1. Decide whether to authorize **design-revision work only**.
2. Name and evidence governed role assignments through a valid assignment authority; do not infer
   appointments from agent labels, repository access, OS identity, or authorship.
3. Decide the authority and procedure for a new append-only PRE_A09 provenance record while
   preserving mismatched historical records.
4. After revisions, separately authorize publication, independent QA, and independent re-review.
5. Only after those steps, obtain a Decision Chair outcome for the exact candidate. If accepted,
   assess dependency eligibility. Do not infer execution release.

**STOP:** GATE-03 is closed with revision required. No acceptance or execution authority is granted.
Do not mark G3 complete. Do not release G4. Do not merge the PR. Await explicit authorization for
design-revision work only; enforcement implementation, sandbox construction, and testing remain
blocked under separate future requests.
