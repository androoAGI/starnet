# Wave 0.4 Controls Residual Risk Register

## 1. Control record

- **Scope:** residual and open risks for revised A-04 and B-03
- **Design baseline:** branch `cursor/populate-authority-readiness-7886`, HEAD `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Status:** `READY FOR ACCEPTANCE REVIEW`
- **Acceptance / execution authority:** none / none

Risk owners below are required role classes, not current appointments. Current governance evidence does not establish named effective assignees. Therefore every risk remains governance-open even where the design proposes treatment.

Ratings are qualitative design estimates, not measured operational results.

## 2. Risks

### W04-R01 — Machine-valid schemas absent

- **Rating:** likelihood high; impact high
- **Status:** `OPEN_BLOCKING_ACCEPTANCE`
- **Owner class:** Coordinator/Architect with independent QA
- **Exposure:** Prose may be interpreted inconsistently; malformed or ambiguous objects cannot be deterministically rejected.
- **Treatment:** Publish and digest-pin the schema families required by A-04 Sections 5/12 and B-03 Section 6, with validator conformance evidence. For the B-03 ledger, publish the required canonical genesis and immediate-successor vectors using the corrected fixed 16-byte `AU-GPEP-EVENT-v1` domain and `len32(domain) || domain` framing, with complete preimages and independently reproduced hashes.
- **Trigger:** Any implementation or acceptance request without the schemas.
- **Acceptance condition:** Independent conformance receipt for the exact published bundle.

### W04-R02 — A01-A12 authoritative topology incomplete

- **Rating:** likelihood certain; impact critical
- **Status:** `OPEN_BLOCKING_ACCEPTANCE_AND_EXECUTION`
- **Owner class:** Decision/governance architecture authority
- **Exposure:** A03-A05 and A10-A11 lack authoritative definitions; enabling an inferred chain could skip governance.
- **Treatment:** Keep all registry edges disabled. Publish signed definitions, evidence contracts, joins, failure rules, and rollback semantics for every node.
- **Trigger:** Any non-empty executable topology before authoritative registry approval.
- **Acceptance condition:** Signed complete registry and independent topology review.

### W04-R03 — No established trust root or key custody

- **Rating:** likelihood certain; impact critical
- **Status:** `OPEN_BLOCKING_ACCEPTANCE`
- **Owner class:** Root Custodian and Security/Governance
- **Exposure:** ARM, runtime, authority, revocation, and audit signatures have no verified trust basis.
- **Treatment:** Establish purpose-separated keys, ceremonies, quorum, witness, non-exportability, trust-store distribution, rollover, recovery, and revocation.
- **Trigger:** Signature validation against an ad hoc or self-generated key.
- **Acceptance condition:** Approved cryptographic profile and independently witnessed trust ceremony.

### W04-R04 — Named governed assignments absent

- **Rating:** likelihood certain; impact critical
- **Status:** `OPEN_BLOCKING_ALL_GOVERNED_TRANSITIONS`
- **Owner class:** Valid assignment authority
- **Exposure:** Agent/preparer labels could be mistaken for Decision Chair, reviewer, QA, coordinator, verifier, or key-custody authority.
- **Treatment:** Apply AU-UCR-GOV-001 identity, scope, effective interval, acknowledgement, and separation requirements; prohibit self/reciprocal appointment.
- **Trigger:** A receipt signed only under a role label or repository/OS identity.
- **Acceptance condition:** Independently conflict-checked assignment receipts.

### W04-R05 — Artifact publication and containing-commit linkage absent

- **Rating:** likelihood certain; impact high
- **Status:** `OPEN_BLOCKING_ACCEPTANCE`
- **Owner class:** Publication Custodian
- **Exposure:** Review could address bytes different from the candidate later presented for acceptance.
- **Treatment:** Publish immutable commit-addressed artifacts and manifest, then review exact digests.
- **Trigger:** Revision after review or receipt lacking repository/commit/object digest.
- **Acceptance condition:** Publication receipt plus digest-specific QA and review.

### W04-R06 — Manifest hash domain not self-describing

- **Rating:** likelihood medium; impact medium
- **Status:** `OPEN_PROVENANCE`
- **Owner class:** QA/Evidence Agent
- **Exposure:** Git-blob LF hashes may be compared to platform-rendered CRLF checkout bytes, producing false integrity findings.
- **Treatment:** Declare hash domain per entry and pin normalization policy (for example with reviewed `.gitattributes`) without rewriting prior evidence.
- **Trigger:** Verification result that omits byte domain.
- **Acceptance condition:** New append-only domain declaration or manifest convention receipt.

### W04-R07 — Historical commit identifier discrepancy

- **Rating:** likelihood certain; impact medium
- **Status:** `OPEN_PROVENANCE`
- **Owner class:** QA/Evidence Agent
- **Exposure:** The deterministic-readiness receipt names unavailable `2ea38d86a196...`, while nearby local history contains `2ea38d86acaf...`.
- **Treatment:** Preserve the receipt, investigate provenance under separate authorization, and issue an append-only correction if evidence supports one.
- **Trigger:** Reliance on that receipt as current commit-bound evidence.
- **Acceptance condition:** Independent provenance disposition; no silent typo correction.

### W04-R08 — Privileged host or control-plane compromise

- **Rating:** likelihood low-to-medium; impact critical
- **Status:** `RESIDUAL_AFTER_DESIGN`
- **Owner class:** Platform Security
- **Exposure:** Administrator, SYSTEM, kernel, hypervisor, backup, or deployment authority can exceed ordinary ACL assumptions.
- **Treatment:** Hardware attestation, least privilege, two-person break-glass, independent alerts, WORM anchors, workload identity, restore quarantine, and reconciliation.
- **Trigger:** Unexpected privileged action, measurement change, or attestation loss.
- **Response:** Suspend; revoke; reconcile from off-host evidence; re-enroll/re-attest.
- **Acceptance authority:** Decision Chair must explicitly accept bounded residual risk.

### W04-R09 — Root/signing service compromise

- **Rating:** likelihood low; impact catastrophic
- **Status:** `RESIDUAL_AFTER_DESIGN`
- **Owner class:** Root Custodian and incident authority
- **Exposure:** A compromised root or authority service can mint apparently valid evidence.
- **Treatment:** Offline root, split control, purpose separation, transparency, emergency recovery root, monotonic trust stores, compromise backdating, and re-adjudication.
- **Trigger:** Unauthorized ceremony, key-use anomaly, export suspicion, or trust-store fork.
- **Response:** Global suspension and emergency revocation; prior evidence remains immutable but may be marked affected.

### W04-R10 — Remote provider cannot prove model identity

- **Rating:** likelihood medium-to-high; impact high
- **Status:** `OPEN_PROVIDER_DEPENDENCY`
- **Owner class:** Runtime/Provider Integration
- **Exposure:** A tag or TLS session cannot prove which immutable model handled a request.
- **Treatment:** Require request-scoped provider-signed tenant/region/model evidence. Otherwise classify binding `UNVERIFIABLE`.
- **Trigger:** Missing or invalid provider statement, proxy/tenant/region change, or model alias only.
- **Response:** Deny `TRUSTED_ACTIVE`; use an approved locally measured model or remain blocked.

### W04-R11 — Compromised runtime/TMC after launch

- **Rating:** likelihood low-to-medium; impact critical
- **Status:** `RESIDUAL_AFTER_DESIGN`
- **Owner class:** Runtime Security
- **Exposure:** A privileged exploit may falsify or subvert measurements after initial quote.
- **Treatment:** Hardware-bound TMC, challenge liveness, loaded-module/injection monitoring, short freshness, process restart invalidation, hardened build, and independent verification.
- **Trigger:** measurement drift, sequence anomaly, challenge failure, debugger/injection signal, or security incident.
- **Response:** Immediate suspension and new-session-only recovery.

### W04-R12 — Valid but malicious/coerced authority

- **Rating:** likelihood low; impact critical
- **Status:** `RESIDUAL_AFTER_DESIGN`
- **Owner class:** Governance leadership
- **Exposure:** A properly assigned signer may authorize harmful action that satisfies syntactic policy.
- **Treatment:** Separation, independent QA/review, evidence-bound receipts, rationale, short validity, quorum for emergency actions, and post-decision audit.
- **Trigger:** conflict disclosure, anomalous decisions, coercion report, or material contradiction.
- **Response:** Suspend affected transitions and initiate governance re-adjudication.

### W04-R13 — Policy/schema is wrong but consistently enforced

- **Rating:** likelihood medium; impact high
- **Status:** `RESIDUAL_AFTER_DESIGN`
- **Owner class:** Coordinator/Architect and Independent Reviewer
- **Exposure:** Deterministic enforcement can reliably apply an incorrect topology, guard, or identity rule.
- **Treatment:** Versioning, test vectors, independent review, shadow evaluation, limited pilot, monitoring, and rollback.
- **Trigger:** contradiction between intended governance and enforced result.
- **Response:** Block execution, move governance to revision, and publish a new candidate.

### W04-R14 — Audit outbox or anchor lag

- **Rating:** likelihood medium; impact high
- **Status:** `RESIDUAL_AFTER_DESIGN`
- **Owner class:** Audit Operations
- **Exposure:** Authoritative state may commit before external WORM delivery/anchor, creating a bounded detection gap.
- **Treatment:** Durable in-transaction outbox, short delivery bound, promotion suspension on stale delivery, idempotent replay, independent checkpoint chain, and reconciliation.
- **Trigger:** missed delivery bound, sequence gap, hash mismatch, stale or conflicting anchor.
- **Response:** Suspend promotion; replay only committed outbox bytes; retain orphans as rejected evidence.

### W04-R15 — New or hidden bypass path

- **Rating:** likelihood medium; impact critical
- **Status:** `RESIDUAL_AFTER_DESIGN`
- **Owner class:** Coordinator/Architect with Security/Governance
- **Exposure:** A new interface, credential, migration, restore, service-control, full-power, or deployment path may bypass G-PEP.
- **Treatment:** Signed AMI, deployment admission, sole database workload identity, continuous inventory, effective-access checks, canary writes, restore quarantine, and drift alerts.
- **Trigger:** Discovered state-changing component absent from AMI or direct-write attempt.
- **Response:** Disable path, suspend affected objects, reconcile history, and require inventory review.

### W04-R16 — Failure-closed availability loss

- **Rating:** likelihood medium; impact high
- **Status:** `RESIDUAL_ACCEPTANCE_DECISION`
- **Owner class:** Coordinator/Architect and Operations
- **Exposure:** Trust, revocation, verifier, database, WORM, anchor, or time outage blocks work and may pressure unsafe break-glass use.
- **Treatment:** Redundant read-only verification, bounded recovery, practiced restore, narrow two-person break-glass, and explicit no-fail-open rule.
- **Trigger:** Dependency outage or stale trust state.
- **Response:** Remain blocked; availability never overrides integrity.

### W04-R17 — Replay, clock rollback, or buffered liveness evidence

- **Rating:** likelihood medium; impact high
- **Status:** `RESIDUAL_AFTER_DESIGN`
- **Owner class:** Verifier Operations
- **Exposure:** Captured valid evidence could be reused or delayed.
- **Treatment:** Single-use nonce, audience/channel binding, verifier receipt time, challenge cadence, monotonic counter, strict sequence, prior hash, authority counter, and atomic consumption.
- **Trigger:** duplicate nonce/event, stale challenge, counter rollback, chain fork, or wrong audience.
- **Response:** Deny, log security event, and suspend candidate session/authority.

### W04-R18 — Irreversible external side effects

- **Rating:** likelihood medium; impact high
- **Status:** `RESIDUAL_ACCEPTANCE_DECISION`
- **Owner class:** Operations and business owner
- **Exposure:** State rollback may not reverse messages, external writes, payments, disclosures, or provider actions.
- **Treatment:** Predeclared compensation, idempotency, side-effect inventory, reconciliation, and explicit irreversible-effect status.
- **Trigger:** Partial completion or rollback after an external effect.
- **Response:** Compensate where possible; preserve and escalate non-reversible consequences.

### W04-R19 — Evidence privacy or secret leakage

- **Rating:** likelihood medium; impact high
- **Status:** `OPEN_CONTROL_DETAIL`
- **Owner class:** Privacy/Security
- **Exposure:** Rich runtime and governance evidence may expose prompts, identities, endpoint details, or secrets.
- **Treatment:** Commitments instead of plaintext, field-level classification, access control, encryption, tokenized identifiers, retention limits, and linked non-destructive redaction.
- **Trigger:** Schema includes unnecessary sensitive content or logs contain secrets.
- **Acceptance condition:** Approved data classification and retention/redaction profile.

### W04-R20 — Implementation and tests do not exist

- **Rating:** likelihood certain; impact critical
- **Status:** `OPEN_BY_AUTHORIZATION`
- **Owner class:** Future assigned implementation and QA roles
- **Exposure:** Design completeness cannot establish control effectiveness.
- **Treatment:** None under this authorization. Future implementation and testing require separate approval after design acceptance.
- **Trigger:** Any statement that this Wave 0.4 package proves an operating control.
- **Acceptance condition:** Not closable by design review; requires separately authorized implementation, negative testing, recovery exercises, QA, and release evidence.

## 3. Summary counts

- **Registered risks:** 20
- **Open/blocking or open dependency/control risks:** 10 (`R01`-`R07`, `R10`, `R19`, `R20`)
- **Residual after proposed design or requiring explicit risk acceptance:** 10 (`R08`, `R09`, `R11`-`R18`)
- **Closed operational risks:** 0

The counts do not imply quantified assurance. No risk is operationally closed because no implementation or test was authorized.

## 4. Mandatory hold and escalation rule

Any material contradiction, role conflict, provenance ambiguity, trust failure, stale/absent receipt, unexplained state/audit difference, safety regression, or uncertainty preserves or restores the blocked state. Evidence and failures remain append-only.

G1 remains `PENDING`, G2 remains `PENDING`, G3 remains `CLOSED`, G4 remains `NOT AUTHORIZED`, feature/treatment paths remain OFF, baseline StarNet remains authoritative, and PR merge remains blocked.

Disposition:

`READY FOR ACCEPTANCE REVIEW -> NOT ACCEPTED -> NO IMPLEMENTATION -> NO TEST -> NO EXECUTION`
