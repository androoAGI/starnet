# Wave 0.4 Controls Objection Resolution Matrix

## 1. Control and interpretation

- **Scope:** D-02 objections to A-04 and B-03, as amended by `D-02_AMENDMENT-1_MANIFEST_HASH_CONVENTION.md`
- **Design baseline:** branch `cursor/populate-authority-readiness-7886`, HEAD `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Status:** `READY FOR ACCEPTANCE REVIEW`
- **Acceptance / execution authority:** none / none

Status meanings:

- `RESOLVED_IN_DESIGN`: Wave 0.4 contains specific normative design addressing the objection; no implementation or effectiveness claim follows.
- `CORRECTED_BY_AMENDMENT`: Amendment 1 contradicted the premise; remaining risks are tracked separately.
- `OPEN`: the objection requires an artifact or authority outside the four-file Wave 0.4 authorization.

## 2. A-04 objections

### A04-O01 — External observations not commit-bound or authoritative

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** A-04 Sections 2 and 4 classify external files, prompt-visible metadata, paths, and producer statements as contextual/non-authoritative. Sections 3 and 14 require ARM, containing-commit, publication, review, acceptance, and execution-release provenance and fail closed when provenance is ambiguous.
- **No claim:** No external persona/overlay is declared canonical or actively loaded.

### A04-O02 — Example envelope is not a complete machine-valid schema

- **Status:** `OPEN`
- **Resolution supplied:** A-04 Sections 5 and 12 define the minimum normative ARM/evidence schema contract: required classes of fields, bounds, duplicate-key and Unicode behavior, nullability, extension rules, conditionals, canonicalization, framing, and schema separation.
- **Why open:** The authorized deliverables exclude standalone JSON Schema files, so machine-valid schemas have not been published or independently validated.
- **Closure evidence:** Digest-pinned schema artifacts plus conformance and independent-review receipts.

### A04-O03 — Producer, verifier, and session states conflated

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** A-04 Section 11 defines separate producer-evidence, verifier-verdict, and runtime-admission state machines, legal transitions, terminal states, trigger precedence, restart behavior, and no same-session recovery.

### A04-O04 — Endpoint/remote-provider identity imprecise

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** A-04 Section 8 defines a versioned tenant/account, service, region, protocol, DNS, TLS policy/pin, proxy chain, model authority/digest, and audience tuple plus request-scoped provider evidence. Tenant, proxy, region, model, and certificate-policy changes force a new session.

### A04-O05 — TPM bootstrapping and lifecycle incomplete

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** A-04 Section 7 specifies EK/AK proofing, enrollment, PCR ownership, event-log replay, firmware/boot policy changes, TPM clear/replacement, vTPM anti-cloning requirements, revocation, and decommissioning.

### A04-O06 — Root/admin controls and compromise recovery incomplete

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** A-04 Section 13 defines role classes, quorum, independent witness, split control, ceremonies, signed monotonic trust-store distribution, rollover, emergency revocation, recovery root use, and compromise backdating.

### A04-O07 — Heartbeats lack independent liveness challenges

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** A-04 Section 10 requires unpredictable verifier challenges, channel binding, verifier receipt-time freshness, bounded response time, sequence/counter checks, and suspension on delayed, missing, buffered, forked, or channel-changed evidence.

### A04-O08 — PRE_A09 manifest reliance invalid

- **Status:** `CORRECTED_BY_AMENDMENT`
- **Resolution:** D-02 Amendment 1 establishes that manifest hashes identify Git/index LF bytes and withdraws the claimed three-file mismatch. A-04 Sections 4 and 14 preserve the remaining hash-domain documentation risk and historical commit discrepancy and prohibit PRE_A09 evidence from acting as current attestation.

## 3. B-03 objections

### B03-O01 — State transition relation incomplete

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** B-03 Section 5 defines legal status transitions, guards, invariants, predecessor terminal rules, re-entry, supersession, object versions, idempotency, competing-request behavior, and recovery through new versions.

### B03-O02 — Undefined A-code nodes appear executable

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** B-03 Section 4 enumerates A01-A12, marks A03-A05/A10-A11 `UNDEFINED_BLOCKED`, marks the others `DEFINED_DISABLED`, and declares the current executable topology to be the empty graph with no outgoing edges.

### B03-O03 — Cross-store atomicity unspecified

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** B-03 Section 8 uses one serializable transaction for state, event, nonce/counter, and outbox; explicitly excludes the WORM destination from the atomic claim; and defines delivery, replay, orphan handling, bidirectional reconciliation, suspension bounds, and checkpoint behavior.

### B03-O04 — Receipt schemas and hash framing ambiguous

- **Status:** `OPEN`
- **Resolution supplied:** B-03 Section 6 defines schema families, strict parse rules, JCS, identifier and timestamp representation, genesis, omitted/null treatment, and digest pinning. D-03 finding `D03-NMF-01` corrected the ledger preimage to `len32(domain) || domain`, fixes `domain` to the 16 ASCII bytes `AU-GPEP-EVENT-v1`, defines raw predecessor-hash handling, and requires deterministic canonical genesis and immediate-successor vectors with independently reproduced preimages and hashes.
- **Why open:** Standalone machine-valid schemas are outside the four-file authorization and have not been published or validated.
- **Closure evidence:** Published schema bundle, the required canonical genesis/non-genesis vector bundle, and independent conformance receipt.

### B03-O05 — A-04/B-03 cryptographic profiles conflict

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** A-04 Section 12 and B-03 Sections 6-7 use the same provisional purpose-separated ES256/SHA-256 registry and framing. Enterprise cryptographic approval remains an acceptance prerequisite, not a design contradiction.

### B03-O06 — Suspension/rollback authorities vague

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** B-03 Section 11 defines automatic and manual suspension authority, duration, extension threshold, rollback quorum and separation, reinstatement evidence/signers, and two-person time-bound break-glass controls.

### B03-O07 — No authoritative entry-point inventory or bypass prevention

- **Status:** `RESOLVED_IN_DESIGN`
- **Resolution:** B-03 Section 10 defines the signed Authoritative Mediation Inventory, ownership and independent checks, deployment admission, continuous discovery, database credential restriction, drift/canary checks, restore quarantine, deployment separation, and administrator compensating controls.

### B03-O08 — PRE_A09 package integrity reliance invalid

- **Status:** `CORRECTED_BY_AMENDMENT`
- **Resolution:** D-02 Amendment 1 withdraws the raw-CRLF mismatch premise. B-03 does not rely on PRE_A09 as current acceptance or enforcement evidence. Remaining hash-domain and historical commit risks are carried in the residual-risk register.

## 4. Cross-cutting required actions still open

These are acceptance prerequisites, not undisclosed implementation claims:

1. Publish the machine-valid ARM, attestation, transition, role, A09, event, recovery, and anchor schemas.
2. Bind the Wave 0.4 artifacts to a containing commit and publication receipt.
3. Resolve the historical deterministic-readiness commit-identifier discrepancy.
4. Obtain named, stable, effective, acknowledged, conflict-checked role assignments.
5. Obtain independent QA and a digest-specific independent review of the published candidate.
6. Obtain a Decision Chair outcome; `READY FOR ACCEPTANCE REVIEW` is not that outcome.
7. If accepted, obtain a later separate Coordinator/Architect execution-release receipt before implementation, testing, or operation.

## 5. Status counts

- **Total D-02 A-04/B-03 objections:** 16
- **`RESOLVED_IN_DESIGN`:** 12
- **`CORRECTED_BY_AMENDMENT`:** 2
- **`OPEN`:** 2
- **Unaddressed or silently deferred:** 0

For closure accounting, 14 objections have a resolved/corrected disposition and 2 remain explicitly open because the authorized deliverable set excludes the required machine-valid schema artifacts.

## 6. Hold statement

G1 remains `PENDING`, G2 remains `PENDING`, G3 remains `CLOSED`, G4 remains `NOT AUTHORIZED`, feature/treatment paths remain OFF, baseline StarNet remains authoritative, and PR merge remains blocked. No status in this matrix grants acceptance, implementation, testing, construction, execution, or merge authority.
