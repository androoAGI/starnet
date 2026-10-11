# D-02 Independent Design Assurance Report

## 1. Control record

- **Artifact ID:** `D-02`
- **Experiment:** `AU-UCR-EP-000001`
- **Wave:** `0.3`
- **Reviewer:** `Agent D`
- **Status:** `REVIEW_COMPLETE_NOT_ACCEPTED`
- **Acceptance receipt:** **None**
- **Review date:** `2026-10-11`
- **Review authority used:** user-authorized, read-only design assurance plus this one new report
- **Formal governance effect:** **None.** This report is not governance acceptance, QA certification, publication, execution release, or permission to implement, construct, test, or operate.

The five supplied artifact digests matched the exact local bytes, so identity verification did not trigger `REVIEW_BLOCKED`. However, the governing assignment evidence still records no named, effective Independent Reviewer assignment. Agent D's review is complete for this requested assurance task, but it is not the formally effective Independent Reviewer acknowledgement required by `AU-UCR-GOV-001`. Review completion and formal acceptance remain separate.

No tests or project scripts were run. No design, existing evidence, host, network, account, key, ACL, runtime, commit, or remote state was modified. Only this report was created.

## 2. Repository and artifact inventory

- Repository: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Branch: `cursor/populate-authority-readiness-7886`
- Current revision during review: `c0579a4e4d272162963de09bdec7494d822c1fe2`
- Initial Git status: `## cursor/populate-authority-readiness-7886...origin/cursor/populate-authority-readiness-7886` and untracked `docs/experiments/au-ucr-ep-000001/wave-0.3/`
- Provenance consequence: all five reviewed designs were present only in the untracked Wave 0.3 directory. Their byte digests are reviewable, but none is contained in the stated current repository revision. References in the designs to the inspected HEAD identify a baseline, not a commit that contains the designs.

| Artifact | Exact path | Bytes | SHA-256 | Identity |
| --- | --- | ---: | --- | --- |
| A-04 | `C:\Users\hakee\.cursor\starnet-ucr-publish-2\docs\experiments\au-ucr-ep-000001\wave-0.3\A-04_TRUSTED_RUNTIME_ATTESTATION_SPEC.md` | 30,976 | `3bdb80b055f672141101dd4417aa75df349e4a8b25c3f19051a77a98613cc5ed` | MATCH |
| B-03 | `C:\Users\hakee\.cursor\starnet-ucr-publish-2\docs\experiments\au-ucr-ep-000001\wave-0.3\B-03_EXECUTABLE_ENFORCEMENT_SPEC.md` | 32,599 | `f6cad82b5bb9049a8a5bebc4bbfd4d8be09af3b927aaa9b301fb287b09c6582a` | MATCH |
| C-04 | `C:\Users\hakee\.cursor\starnet-ucr-publish-2\docs\experiments\au-ucr-ep-000001\wave-0.3\C-04_AUTHORITY_PACKAGE_DRAFT.md` | 11,385 | `f78fa119d767285efb984b3246842081ac0be4a7513eadbd70566bae64377999` | MATCH |
| SCRUM03 | `C:\Users\hakee\.cursor\starnet-ucr-publish-2\docs\experiments\au-ucr-ep-000001\wave-0.3\SCRUM03_RECONCILIATION.md` | 13,706 | `b3b3349454e76a6705674e5c65d21e3aee3ff4519941586313bca727bef7abd3` | MATCH |
| LAB-03 | `C:\Users\hakee\.cursor\starnet-ucr-publish-2\docs\experiments\au-ucr-ep-000001\wave-0.3\LAB-03_ISOLATED_EXECUTION_ENVIRONMENT_SPEC.md` | 32,071 | `b9ba2f40db06921fc01368b00a838d59f5ab0d72f9867c0a39d2277c9f4c2361` | MATCH |

## 3. Governing evidence inspected

The review used the following local governing records and current relevant receipts:

- `docs/experiments/au-ucr-ep-000001/AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md`, SHA-256 `afc9d17f9cf6b93727b33c297cbde0999e5c2d35348a5d9ed723570bd393b6ac`
- `docs/experiments/au-ucr-ep-000001/S0_EVIDENCE_CONVENTIONS.md`, SHA-256 `e3364a149bb8137771959321ebbd68dacaeb579652283b81fd43c4f447d8627e`
- `docs/experiments/au-ucr-ep-000001/S0_QA_READINESS_GATE.json`, SHA-256 `c90125d89d05c74b3a3a9fc93d585fcc32ef1b3a287d316e2536cb5cb0abadba`
- `docs/experiments/au-ucr-ep-000001/S0_WORKTREE_LANE_REGISTER.yaml`, SHA-256 `eaf4604648539caa981bb1e627459420dd912c68c3171edddb1ebc7e4d38b985`
- `qa/evidence/au-ucr-ep-000001-s0/receipts/readiness-check.json`, SHA-256 `f7b581ed44b2e6de7f8175aece5dadea7570229115ebf9860ad833c3b0384964`
- `qa/evidence/au-ucr-ep-000001-s0/receipts/test-fast.json`
- `qa/evidence/au-ucr-ep-000001-s0/receipts/test-http.json`
- `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-AUTHORITY-NAMES-00.json`, SHA-256 `aef3c4146bbd978a7c4eb2b5798776351e2728d450dd9556404fd8facaa611ef`
- `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json`, SHA-256 `058bcc5cd035c5c1be243e90be0ec59486e9a7029489511ef2367e7cb436a4ba`
- `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-LOCAL-BRIDGE-00.json`, SHA-256 `100c4c174df2cf0fc41f4502410eebd3ca32631e6c7a77a36d422c135ca70f28`
- `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/MANIFEST.sha256`, SHA-256 `4a67cbe5e960d12a9c15372a7ccdbec0d484dc7a4e58a25d9de8ed9a636fb145`

### Material evidence-provenance objection

The current `MANIFEST.sha256` does not match the current bytes of all three PRE_A09 receipts it lists:

| Receipt | Manifest digest | Current digest | Result |
| --- | --- | --- | --- |
| `EV-INF-PRE-A09-AUTHORITY-NAMES-00.json` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | `aef3c4146bbd978a7c4eb2b5798776351e2728d450dd9556404fd8facaa611ef` | MISMATCH |
| `EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | `058bcc5cd035c5c1be243e90be0ec59486e9a7029489511ef2367e7cb436a4ba` | MISMATCH |
| `EV-INF-PRE-A09-LOCAL-BRIDGE-00.json` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | `100c4c174df2cf0fc41f4502410eebd3ca32631e6c7a77a36d422c135ca70f28` | MISMATCH |

Therefore, the manifest's earlier deterministic-verification claim cannot be used as current integrity evidence. Preserve both generations; do not overwrite history. Create a new append-only manifest/receipt that identifies the exact current commit or explicit working-tree state, sizes, hashes, producer, and reason for supersession, then independently verify it. Until then, dependencies that rely on this manifest remain unresolved.

## 4. Design verdicts

### A-04 — `REVISE AS DESIGN`

**Strengths and evidence:** Sections 2-3 correctly limit file hashes and historical runtime observations; sections 4-8 separate exact bytes, canonical identity, and live binding; sections 10-15 cover key custody, replay, fail-closed behavior, and major bypasses; sections 17-21 preserve blocked status and distinguish review, acceptance, and execution release. Existing controls and proposals are explicitly separated.

**Objections and unsupported claims:**

1. Section 3.1 describes direct inspection of external persona/overlay files and runtime source. Those observations are not commit-bound to this repository, and the external AML copies are expressly non-authoritative. They may remain contextual observations only.
2. The proposed envelope in section 9 is an example, not a complete machine-valid schema. Required/optional fields, field lengths, nullability, extension handling, numeric ranges, evidence-type-specific constraints, and cross-field rules are undefined.
3. The runtime state machine is incomplete. `ATTESTED_ACTIVE`, `SUSPENDED`, `TRUSTED`, `UNTRUSTED`, and historical signature validity mix producer, verifier, and session states without a normative transition table, terminal-state rules, or concurrency/restart precedence.
4. `endpoint_identity_sha256` and remote provider identity are not defined precisely enough to resist DNS, certificate rotation, proxy termination, tenant mix-up, or provider account/region substitution.
5. TPM trust bootstrapping is incomplete: endorsement/attestation-key enrollment, EK/AK certificate validation, PCR selection and policy ownership, event-log replay, firmware/boot updates, TPM clear/replacement, and virtual TPM cloning are not normatively specified.
6. Root and administrator controls are incomplete. Dual control is stated, but root/intermediate compromise recovery, key-generation evidence, quorum identities, ceremony approval authority, emergency rollover, trust-store update authorization, and split knowledge are not defined.
7. Heartbeats are chained but do not receive independent per-heartbeat challenges. A captured signer/session or buffered chain can create delayed evidence unless verifier receipt-time, channel binding, and liveness challenge rules are normative.
8. The claimed current PRE_A09 evidence dependency is affected by the manifest mismatch in section 3 of this report.

**Exact required revisions:**

- Publish normative ARM and evidence JSON Schemas with required fields, bounds, duplicate-key behavior, extension policy, and evidence-type conditionals.
- Add separate normative producer-evidence, verifier-verdict, and session-state machines with all states, legal transitions, trigger precedence, restart behavior, and terminal conditions.
- Define endpoint identity as a versioned tuple covering provider tenant/account, model digest authority, region, protocol, TLS identity/pins or approved CA policy, proxy chain, and request-scoped provider signature.
- Add a TPM enrollment and lifecycle profile covering EK/AK proofing, PCR/event-log policy, updates, TPM clear/replacement, vTPM cloning, and decommissioning.
- Add trust-root governance and compromise-recovery procedures with named role classes, quorum, independent witness, trust-store distribution, rollover, and emergency revocation.
- Require verifier-driven liveness challenges or equivalently justified channel-bound freshness for continuous evidence.
- Replace current-manifest reliance with a newly verified append-only provenance record, and bind the revised A-04 itself to a containing commit/publication receipt.

### B-03 — `REVISE AS DESIGN`

**Strengths and evidence:** Sections 1-2 and 12 cleanly distinguish partial existing application controls from proposed enforcement. Sections 3-5 recognize OS/admin bypasses and require mandatory PEP mediation. Sections 6-11 cover missing A-code definitions, signature/replay checks, audit, denial behavior, rollback, and bypass analysis. Tests remain explicitly `FUTURE/NOT RUN`.

**Objections and gaps:**

1. The state model lists statuses but does not define a complete transition relation, stage/status invariants, terminal predecessor states, re-entry, supersession, competing requests, or object version semantics. `READY`, `PASSED`, `HOLD`, `SUSPENDED`, and `ROLLED_BACK` are ambiguous.
2. A03-A05 and A10-A11 are absent. The displayed arrow chain can be misread as an approved topology even though those definitions and joins are blocked.
3. “Atomically append audit event and update state” is not implementable as stated when the state database, append-only/WORM ledger, and off-host anchor are separate failure domains. No outbox/commit protocol, recovery invariant, or orphan reconciliation is defined.
4. The receipt/schema proposal lacks exact schemas and a canonical byte-level definition for `ledger_id`, `prev_hash`, omitted/null values, Unicode, timestamp precision, identifier encoding, and hash concatenation length framing.
5. The A09 design proposes Ed25519 while A-04 proposes ES256, but no shared cryptographic profile or rationale defines where each is allowed. Key enrollment, assignment-signing authority, trust-store administration, key recovery, and compromise backdating are incomplete.
6. Suspension authority is vague: “any authorized security responder” and “signed suspension policy” do not identify the assigning authority, threshold, scope, expiry, appeal, or reinstatement signer. Rollback's emergency approver is likewise undefined.
7. Entry-point coverage is asserted as mandatory but no authoritative inventory ownership or mechanism prevents a new interface, migration, direct database credential, backup restore, service-control action, or deployment tool from bypassing the PEP.
8. Current baseline failures are correctly reported, but the stale PRE_A09 manifest prevents treating those grouped STAR-WR receipts as a current integrity-verified package.

**Exact required revisions:**

- Replace the status list with a complete versioned state-transition table, guards, invariants, idempotency behavior, concurrent-request rules, and recovery semantics.
- Represent undefined A-code nodes as disabled registry entries, not an apparent executable chain; require signed authoritative definitions before any edge can be enabled.
- Specify an atomicity design such as a single transactional ledger/state store or transactional outbox with exact crash invariants, replay, orphan detection, reconciliation, and external-anchor behavior.
- Publish normative schemas and unambiguous framed hash/signature inputs.
- Reconcile A-04/B-03 cryptographic profiles in one approved algorithm/key-purpose registry and define enrollment, custody, trust-store administration, revocation, and compromise recovery.
- Define suspension, rollback, reinstatement, and break-glass authorities, separation rules, scope, expiry, quorum, and receipts.
- Add a controlled entry-point inventory with deployment-time and continuous bypass detection, including backup/restore and administrative paths.
- Bind the revised B-03 and its evidence package to a containing commit and corrected append-only manifest.

### C-04 — `REVISE AS DESIGN`

**Strengths and evidence:** The package accurately remains unsigned, unexecuted, and non-authoritative. It requires stable identities, effective times, duties, conflicts, acknowledgement, separation checks, candidate/evidence linkage, suspension, and a separate decision receipt. It does not invent a Decision Chair.

**Objections and authority gaps:**

1. The template records an “assignment authority” but does not define who may hold that authority, how that authority is established, or prohibit self-appointment, reciprocal appointment, or appointment by an incompatible implementation/evidence actor.
2. Separation checks cover the Decision Chair and reviewer but do not expressly compare the assignment authority and checker against the assignee, evidence preparers, implementers, publication custodian, or other assignment authorities.
3. Assignment lifecycle states are implicit. There is no normative state machine for `DRAFT`, `ACKNOWLEDGED`, `EFFECTIVE`, `SUSPENDED`, `EXPIRED`, `REVOKED`, and `SUPERSEDED`, including race handling for decisions issued near suspension/expiry.
4. Signature verification is an unfilled free-text field. Required algorithm profile, key purpose, issuer/trust root, identity proofing, nonce/counter, canonical encoding, revocation evidence, and verification result are absent.
5. Decision receipts require exact commit and content digest but not digest algorithm, repository identity, tree versus artifact scope, policy version, receipt schema version, or replay-resistant unique identifier.
6. The package relies on PRE_A09 historical inputs whose current manifest is inconsistent. They cannot satisfy integrity linkage until a new append-only manifest is verified.

**Exact required revisions:**

- Add an assignment-authority policy and evidence field set that proves the authority's own effective mandate and bars self/reciprocal/incompatible appointment.
- Extend separation checks to assignment authority, checker, and any delegator, using stable identities and transitive conflict checks.
- Add a normative assignment lifecycle and rules for decision validity across suspension, expiry, revocation, reinstatement, and supersession.
- Replace free-text signature fields with a versioned receipt schema and approved identity/key verification profile.
- Fully qualify candidate and receipt bindings with repository, object type, algorithm, schema/policy version, unique receipt ID, and replay controls.
- Reference only a corrected, independently verified append-only evidence manifest and bind the revised C-04 to a containing commit.

### SCRUM03 — `BLOCK AS DESIGN`

**Reason for block:** The artifact's own reconciliation facts are materially stale against the artifacts reviewed at the same supplied revision context. It states that A-04, B-03, and LAB-03 files were not found and points to nonexistent `*_DESIGN_DRAFT.md` pending targets. The actual files exist under the exact names in section 2 of this report. It also leaves D-02 pointed to `D-02_DESIGN_DRAFT.md`, which is not the authorized report path. These errors make the proposed tracker view unreliable even though its digest matched the supplied digest.

**Preserved correct controls:** It has no `DONE` or accepted task state, does not invent a Decision Chair, distinguishes work/review/acceptance/dependency axes, and preserves `G1 PENDING`, `G2 PENDING`, `G3 CLOSED`, and `G4 NOT AUTHORIZED`. It correctly says `G3 CLOSED` is not completion or acceptance.

**Exact required revisions:**

- Reconcile A-04, B-03, C-04, LAB-03, SCRUM03, and D-02 against their actual exact paths and byte digests; remove all false “file not found” and `PENDING_TARGET` statements.
- Record A-04, B-03, C-04, and LAB-03 as draft produced, design-review completed with the verdicts in this report, and not accepted. Do not convert review completion into acceptance or dependency eligibility.
- Record D-02 at `docs/experiments/au-ucr-ep-000001/wave-0.3/D-02_INDEPENDENT_DESIGN_ASSURANCE_REPORT.md`, status `REVIEW_COMPLETE_NOT_ACCEPTED`, while noting the lack of an effective reviewer assignment prevents formal governance acknowledgement.
- Normalize owner/reviewer fields to distinguish artifact preparer labels from governed assignments; all governed assignments remain unverified.
- Add exact dependency IDs, artifact digests, receipt paths, and current provenance status. Mark the PRE_A09 manifest mismatch as unresolved.
- Keep `G1 PENDING`, `G2 PENDING`, `G3 CLOSED`, and `G4 NOT AUTHORIZED`; retain all mandatory holds and no acceptance receipt.
- Bind the replacement reconciliation to a containing commit and new review cycle.

### LAB-03 — `REVISE AS DESIGN`

**Strengths and evidence:** The specification correctly treats `C:\Users\hakee\Desktop\imhotep_forensic_test` only as a historical workspace name, never as containment. Mandatory holds are explicit. Verified observations, unknowns, and proposals are separated. The design covers platform choices, identity, filesystem, fixtures, credentials, network, privilege, evidence, reset, breach handling, and bounded negative tests.

**Objections and gaps:**

1. Unlike A-04/B-03/C-04/SCRUM03, the control record does not state the exact inspected repository revision. The design is untracked, so its evidence basis is not commit-bound.
2. Verified host/workspace observations lack per-observation evidence paths, collector identity, UTC time, command/method, exact outputs or digests, and handling provenance. They are unsupported as repeatable evidence in this draft.
3. The platform-neutral design postpones platform selection appropriately, but the acceptance criteria are presented as if one set can cover all options. VM, physical host, managed sandbox, Windows Sandbox, and container-plus-VM require different enforceable controls and evidence.
4. The append-oriented collector, signed preflight receipt, trusted time, image signature, policy signature, and credential broker have no trust-root, key-custody, administrator, schema, or revocation design.
5. Management-plane and administrator risks are acknowledged but lack a normative admin action state machine, quorum, emergency access, session recording, expiry, post-use review, and independent alert path.
6. Network controls cover many bypasses but do not define application-layer egress content controls, destination ownership/tenant binding, certificate/client-auth policy, or how permitted endpoints are prevented from becoming arbitrary relays.
7. Fixture sanitization lacks a normative archive recursion/decompression policy, file-type allowlist, script/macro handling, software bill/provenance record, and deterministic transformation receipt.
8. Reset criteria do not define verification for provider-retained snapshots/backups, failed teardown, key-destruction evidence, or quarantine retention when deletion cannot be proven.

**Exact required revisions:**

- Add exact repository revision and a per-observation evidence register with source path, method, actor, UTC, size/digest, limitations, and commit applicability.
- After the ADR, create platform-specific control/evidence profiles and map every acceptance criterion to the selected enforcement primitive and responsible independent evidence source.
- Define the trust architecture and schemas for image/policy signatures, preflight receipts, collector records, time health, credential broker, revocation, and key custody; reconcile these with A-04/B-03.
- Add privileged administration and break-glass lifecycle controls with separation, quorum, recording, alerting, expiry, and independent review.
- Add destination tenant identity and application-layer egress controls, including relay/upload abuse and certificate policy.
- Define deterministic fixture transformation and archive/file-type safety rules with a signed provenance chain.
- Specify teardown failure/quarantine states, retained-provider-copy treatment, crypto-erasure proof, and resumption rules.
- Bind the revised LAB-03 to a containing commit and corrected evidence provenance.

## 5. Cross-artifact reconciliation

### Consistent and preserved

- No artifact is `DONE`, formally accepted, or execution-authorized.
- No valid Decision Chair is invented; C-04 and SCRUM03 explicitly keep the role unassigned.
- Publication, review, governance acceptance, and execution release are treated as different events.
- Governing evidence remains: S0 `PUBLISHED_AWAITING_REVIEW`; lane owners `unassigned_role_only`; readiness `blocked`; acceptance `false`; S1 closed pending explicit acceptance.
- G1 is `PENDING`; G2 is `PENDING`; G3 is `CLOSED`; G4 is `NOT AUTHORIZED`.
- The historical forensic directory is treated only as a historical workspace, not a sandbox or authority source.
- Mandatory holds remain in force, including feature/treatment OFF, no construction/testing, no inferred pass from missing evidence, and no execution without separate receipts.

### Inconsistent or unresolved

1. **Paths/statuses:** SCRUM03's A-04, B-03, LAB-03, and D-02 paths/status observations are wrong or obsolete.
2. **Commit provenance:** all reviewed Wave 0.3 artifacts are untracked and therefore not actually contained in revision `c0579a4e...`.
3. **Owners/reviewers:** `Agent A`, `Agent B`, `Agent C`, `LAB Agent`, and `Agent D` are preparer/reviewer labels, not effective governed assignments. SCRUM03 role placeholders must not imply appointments.
4. **Evidence integrity:** current PRE_A09 receipt bytes do not match their current manifest entries.
5. **Dependencies:** A-04, B-03, and LAB-03 independently propose trust roots, signing, identity, evidence stores, trusted time, revocation, administrator controls, and rollback without one shared authoritative architecture or dependency registry.
6. **Cryptographic profiles:** A-04 proposes ES256 for runtime evidence; B-03 proposes Ed25519 for A09. This may be valid by key purpose but is not reconciled in a shared approved profile.
7. **State machines:** runtime attestation, A-code enforcement, role assignment, lab lifecycle, suspension, rollback, and gate reconciliation use related terms without a shared vocabulary, precedence rules, or cross-system transition contract.
8. **Acceptance criteria:** criteria are generally testable in intent but lack exact release candidate IDs, normative schemas/policies, evidence producers, expected reason codes, and pass/fail aggregation rules. All remain future/not run.

## 6. Critical blockers and disposition

The following block formal acceptance and any execution or construction:

1. No effective named assignments for Independent Reviewer, Decision Chair, Coordinator/Architect, QA/Evidence Agent, Publication Custodian, or implementation/security roles.
2. No Decision Chair governance receipt, formal Independent Reviewer acknowledgement, QA certification, publication receipt for these untracked designs, or execution-release receipt.
3. The Wave 0.3 designs are not contained in the stated repository revision.
4. The current STAR-WR-0001 manifest fails to identify the current bytes of three PRE_A09 receipts.
5. SCRUM03 materially misstates the existence and paths of reviewed artifacts.
6. No verified trust root, key custody, revocation service, runtime attestation, mandatory PEP, protected state/audit boundary, isolated lab, or shared authoritative schema/state-machine set exists.
7. Existing `test:fast` and `test:http` receipts remain failures at canonical S0 commit `cdc793ba738c688ef2493fcd196043bfb3fddd77`; no rerun was authorized or performed.
8. G1/G2 remain pending, G3 remains closed, G4 remains not authorized, and all mandatory holds remain active.

Required disposition:

`REVIEW COMPLETE FOR DESIGN ASSURANCE -> NOT FORMALLY ACKNOWLEDGED -> NOT ACCEPTED -> NO EXECUTION`

Any revised artifact changes its digest and requires a new independent design review. This report records objections and required revisions only; it grants no formal acceptance.
