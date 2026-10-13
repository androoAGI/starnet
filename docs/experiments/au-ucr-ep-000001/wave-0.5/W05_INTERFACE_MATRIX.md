# Wave 0.5 Interface Matrix

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-CONTRACT`
- **Experiment:** `AU-UCR-EP-000001`
- **Artifact:** `W05_INTERFACE_MATRIX`
- **Repository baseline inspected:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Companion contract:** `W05_SHARED_TRUST_AND_STATE_CONTRACT.md`
- **Artifact status:** `SPECIFIED_DESIGN_PROPOSAL_F04_RECONCILED`
- **Adoption status:** `NOT_ADOPTED`
- **Demonstrated enforcement:** `NONE`
- **Authorization effect:** `NONE`

This matrix specifies future interfaces against which A-04/B-03 schemas and vectors may later be
reconciled. It does not create an API, schema, implementation, test, operational endpoint, role
assignment, or authority. All interface behavior below is **SPECIFIED**, not demonstrated.

`W05_VERSIONED_REGISTRY.md`, registry
`urn:au-ucr:registry:wave-0.5-contract:1.3.0`, is authoritative within this proposed design for
all schema/profile IDs, interface IDs, decisions, audit projection, algorithms, key purposes,
canonical/framing profiles, hash domains, ordered reasons, aliases, detector interfaces,
precedence, and safe states. Existing schema/vector literals are not conformant merely because
the registry supplies a migration disposition.

## 2. Common envelope and result contract

### 2.1 Common signed envelope

Every signed cross-boundary object SHALL expose or bind these fields:

- `schema_id`, `schema_version`, `object_type`, `object_id`, and `event_id`;
- `interface_id`;
- `producer_id`, `producer_role`, `producer_assignment_ref`, and `key_id`;
- `algorithm_id`, `key_purpose_id`, `canonicalization_id`, and `framing_id`;
- `issued_at`, `not_before`, `expires_at`, `authority_counter`, and `previous_event_digest`;
- `audience`, `environment`, `repository_id`, `candidate_commit`, and
  `publication_manifest_digest`;
- `run_id`, `session_id`, `object_id`/`object_version`, where applicable;
- `policy_digest`, `schema_bundle_digest`, `algorithm_registry_digest`,
  `dependency_registry_digest`, `reason_registry_digest`, and `revocation_epoch`;
- `nonce` or `challenge_ref`, `payload_digest`, `extensions`, and `signature`.

Applicability SHALL be explicit in the eventual schema. Omission and permitted `null` are not
equivalent. Unknown critical extensions, fields outside the extension policy, unsupported
versions, or missing conditionally required fields fail closed.

### 2.2 Common verification result

Every consumer decision SHALL record:

- `interface_id`, `result_id`, `correlation_id`, and consumer stable identity;
- exact input object IDs and digests;
- verification time from the trusted consumer clock;
- `decision`: `ALLOW`, `DENY`, `SUSPEND`, `REVOKE`, `BLOCK`, or `NO_MUTATION`;
- resulting shared state and prior state, if any;
- ordered `reason_codes` from the pinned reason-code registry;
- `retryable` and required recovery authority;
- policy/schema/registry/revocation snapshots used; and
- audit event or intake-ledger reference.

Producer-supplied success, verdict, reason, timestamp, or digest is input only. The consumer
creates the authoritative verification result for its boundary.

The decision enum above is a consumer-boundary vocabulary. Governance outcomes remain
`ACCEPTED | REVISE | REJECTED`; technical vector expectations are `ALLOW | REJECT`; transaction
outcomes remain separate. `ACCEPT` is deprecated and never implies governance acceptance.

## 3. Producer/consumer/trust-boundary matrix

| ID | Producer | Consumer | Trust boundary | Required input | Required output | Failure behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `IF-01` | Assignment authority | Role/receipt verifier and G-PEP | Human governance mandate to machine-verifiable identity | Root mandate/delegation chain, subject identity, role/scope, effective interval, conflict/separation evidence, acknowledgement requirements | Signed assignment lifecycle receipt and verification result | Missing mandate, self/reciprocal appointment, identity ambiguity, scope/depth failure, conflict, expiry, suspension, or revocation: `E_AUTHORITY_ABSENT`/`E_SEPARATION`; no effective role |
| `IF-02` | Publication Custodian, QA, Independent Reviewer | Decision Chair verifier | Mutable preparation space to immutable candidate review | Candidate commit/tree/artifact digests, publication manifest, schema/policy/registry snapshot, QA receipt, independent-review acknowledgement, findings/dependency status | Candidate-bound review package with immutable references | Mutable/unpublished candidate, role overlap, incomplete findings, digest mismatch, or stale receipt: deny with `E_DEPENDENCY` or `E_SCOPE` |
| `IF-03` | Decision Chair | G-PEP and execution-release verifier | Governance judgment to A09 and later G3 state | For A09: `IF-01` role evidence, `IF-02` package, prior governance state/event, nonce/counter/revocation; for G3: a distinct still-valid `ACCEPTED` A09 plus candidate-identical prerequisites | First an `A09_DECISION` signed only with `KP-A09-DECISION-v1`; separately and later, when eligible, `G3_ACCEPTANCE` signed only with `KP-G3-ACCEPTANCE-v1` | Wrong signer/purpose/kind/outcome/candidate/state/audience, replay, expiry, or revocation: deny; A09 and G3 states remain independently unchanged |
| `IF-04` | Coordinator/Architect | ARM publisher, verifier, and G-PEP | G3-accepted design to exact-run execution eligibility | Valid candidate-identical `G3_ACCEPTANCE` and its accepted A09 prerequisite, exact implementation/candidate, dependency snapshot, environment, bounded actions/window, feature state, rollback target, abort conditions | `G4_EXACT_RUN_RELEASE` signed only with `KP-G4-EXACT-RUN-RELEASE-v1` | G3/A09 absent or invalid, wrong release purpose/issuer, dependency gap, no rollback target, or scope mismatch: `NOT_RELEASED`, `E_KEY_PURPOSE`/`E_AUTHORITY_ABSENT`/`E_DEPENDENCY` |
| `IF-05` | ARM/release publisher | TMC and verifier | Governance/release plane to runtime configuration plane | Valid publication, accepted A09, G3 acceptance, G4 exact-run release, policy/schema/topology/registry digests, component identities/hash domains, endpoint/model profile | Signed immutable digest-addressed ARM | Any absent, mutable, ambiguous, wrong-purpose, wrong-domain, expired, revoked, or conflicting dependency: ARM `PUBLISHED_INELIGIBLE`; no launch |
| `IF-06` | Effective `VERIFIER_OPERATOR` | Enrolled platform-bound TMC at IF-08/12 | Independent verifier to measured workload supervisor | 256-bit single-use nonce, audience, policy digest, channel binding, issue/expiry | `VERIFIER_CHALLENGE` signed only with `KP-VERIFIER-CHALLENGE-v1`; TMC may reserve the nonce once after all checks pass | Verdict purpose reuse, other purpose mismatch, replay, weak/malformed nonce, wrong audience/channel/policy, expiry over 120 seconds, or staleness: `E_KEY_PURPOSE`/`E_REPLAY`/`E_SCOPE`/`E_EXPIRED`; no nonce use or measurement |
| `IF-07` | Approved loader | TMC | Parser/loader execution to independent measurement supervisor | Exact ARM-addressed opened handles and declared precedence rules | Parsed-byte digest set, ordered effective-configuration representation/digest, loader identity, load result | Undeclared input, ambiguous precedence, bytes/handle mismatch, parse or digest failure: `E_SCHEMA`/`E_ATTESTATION`; abort launch |
| `IF-08` | TMC | Verifier | Potentially compromised host/runtime to independent trust decision | Valid `IF-06` challenge; eligible ARM; exact launcher/modules/config; platform quote; process/session/key; model/endpoint evidence | `urn:au-ucr:schema:runtime-attestation-evidence:1.0.0` kind `LAUNCH`, signed with `KP-TMC-RUNTIME-v1` under `DOMAIN-TMC-RUNTIME-v1` | Incomplete provenance, race, quote/policy mismatch, unknown module, ambient input, signing misuse, or exact bytes indeterminate: producer `FAILED`; verifier blocks with ordered registered reasons |
| `IF-09` | Platform enrollment/trust service | Verifier | Hardware/platform trust domain to verifier policy | Device inventory, EK/AK chain, templates, PCR/event policy, lifecycle and revocation evidence | Platform enrollment and quote-verification result | Unknown provenance, event-log/PCR mismatch, TPM clear/replacement gap, vTPM clone/migration ambiguity: `E_ATTESTATION`; `UNTRUSTED` |
| `IF-10` | Effective `LOCAL_MEASURED_MODEL_ADAPTER` or `MODEL_PROVIDER_IDENTITY_AUTHORITY` | TMC evidence assembly; verifier at IF-11; audit binder at IF-13 | External inference provider/model plane to governed runtime | Request ID, tenant/account, service/region, endpoint tuple, immutable model digest, nonce, input/output commitments, issue/expiry/audience | `MODEL_ENDPOINT_STATEMENT` signed only with `KP-MODEL-ENDPOINT-STATEMENT-v1` | Wrong signer/purpose, alias/tag/TLS alone, wrong tenant/region/proxy, no immutable model proof, expiry, or commitment mismatch: primary `E_KEY_PURPOSE` when applicable plus `E_MODEL_BINDING`; deny `TRUSTED_ACTIVE` and governed output use |
| `IF-11` | Verifier | G-PEP runtime-admission function | Evidence evaluation to enforcement decision | `IF-05` ARM, `IF-08` evidence, `IF-09` platform result, `IF-10` model evidence, trust/revocation/time and assignment state | Signed verdict receipt: `TRUSTED_ACTIVE`, `UNTRUSTED`, `SUSPENDED`, `REVOKED`, or `ENDED` | Missing/stale/conflicting evidence or verifier uncertainty: non-trusted verdict; G-PEP keeps or moves admission to `BLOCKED` |
| `IF-12` | TMC | Verifier | Active runtime to independent continuous-integrity monitor | Fresh unpredictable challenge, prior accepted evidence digest, current process/session/module/config/model/endpoint state | Signed liveness response with channel, strict sequence, monotonic counter, security flags | Late/missed, buffered, out-of-order, forked, changed, restarted, disconnected, debugger/injection, or counter rollback: `E_LIVENESS`; session `SUSPENDED` |
| `IF-13` | Runtime/provider adapter and TMC | Verifier and audit binder | Governed inference execution to evidence/audit plane | Admitted session, request ID, nearest launch/liveness evidence, endpoint/model identity, input/output commitments | Inference receipt bound to session and evidence | No current `TRUSTED_ACTIVE`, commitment mismatch, stale liveness, or wrong model/endpoint: block result from governed use and emit reason |
| `IF-14` | UI/API/CLI/queue/scheduler or other AMI-listed caller | G-PEP ingress | Untrusted or semi-trusted caller to authoritative mediation boundary | Authenticated principal, AMI interface ID, request bytes, requested transition, expected version, idempotency key, evidence refs, correlation ID | Acceptance result and normalized candidate request, or intake denial record | Malformed/oversized/unknown schema, unauthenticated caller, absent AMI ID, undeclared field, bad reference: `NO_MUTATION`; intake-ledger denial |
| `IF-15` | G-PEP ingress | G-PEP transactional evaluator/state store | Prevalidated request to sole authoritative write boundary | `IF-14` request, current object lock/version/state, topology/policy/schema, role/receipt/revocation/replay state, verifier verdict | Atomic state row + Registry Section 6 `governed-audit-event` `record_without_hash` + nonce/counter consumption + outbox row, or denial | Any changed dependency, conflict, illegal transition, timeout, constraint, event or outbox failure: transaction rollback; `NO_MUTATION`; no state row/event/outbox tuple survives |
| `IF-16` | G-PEP transaction | Outbox relay | Authoritative transactional domain to external immutable audit domain | Committed outbox bytes formed from the Registry Section 6 JSON projection and external `domain`, `ledger_id`, `sequence`, raw `prev_hash`, derived `record_hash`, plus delivery deadline | Idempotent WORM append and immutable delivery acknowledgement | Framing/domain/truncation/hash failures use the exact registered reason detected at IF-16; never synthesize/import state; retry exact committed bytes; suspend promotion |
| `IF-17` | WORM ledger | Independent anchor service and chain verifier | Audit administration to independently administered checkpoint domain | Ledger ID, ordered records/head hash, policy digest, prior checkpoint | `urn:au-ucr:schema:ledger-head-attestation:1.0.0` signed under `PROFILE-LEDGER-HEAD-SIGNING-v1` with `KP-LEDGER-HEAD-ATTEST-v1`, `DOMAIN-LEDGER-HEAD-ATTEST-v1`, and `SIGENC-ES256-P1363-LOW-S-B64URL-v1`, plus anchor checkpoint | Projection/framing/schema/version/domain/purpose/digest/signature/authority/revocation/freshness/chain/anchor failures route in Registry Section 7.1 order; no trusted attestation; suspend promotion where chain/head trust is uncertain |
| `IF-18` | Reconciler | G-PEP control plane, Security/Governance, audit operations | Read-only cross-domain comparison to suspension authority | State versions, events, outbox, WORM records, delivery acknowledgements, checkpoints | Difference report, signed suspension request/automatic-policy trigger, replay instruction limited to committed outbox bytes | Orphan external record: `ORPHAN_REJECTED`; missing external record: replay committed bytes only; unexplained difference: suspend, never auto-import |
| `IF-19` | Trust-Store Publisher / Revocation Officer | Verifier, TMC, G-PEP, registry consumers | Independent trust governance to every verification boundary | Authorized quorum, monotonic prior version, key/authority status changes, compromise effective ordering | Signed trust-store/revocation snapshot with epoch and distribution evidence | Fork, rollback, stale/unavailable status, wrong quorum, or ambiguous effective time: `E_REVOCATION_UNAVAILABLE`/`E_ORDERING_AMBIGUOUS`; suspend/block |
| `IF-20` | Signed automatic policy or Coordinator/Architect plus independent Security/Governance approver | G-PEP recovery controller, runtime admission, audit | Incident/suspension authority to recovery mutation boundary | Trigger evidence, affected scope, known-good target, compatibility evidence, side-effect inventory, authorizations | Quiesce decision and rollback plan/receipt proposal | Missing quorum, affected-role conflict, no accepted target, incompatible state, or uncertain integrity: `E_ROLLBACK_AUTHORITY`; remain suspended |
| `IF-21` | G-PEP recovery controller | State store, outbox/WORM/anchor, verifier | Authorized recovery to new authoritative state/session | Valid `IF-20`, source snapshot, exact target, compensation results, rotated credentials, invalidated receipts/nonces | New object version/event/outbox/rollback receipt; new-session requirement; anchored audit | Never overwrite failed state; any atomic/reconciliation/anchor failure rolls back or remains suspended |
| `IF-22` | QA + Independent Reviewer + Coordinator/Architect; Decision Chair when A09/G3 was invalidated | G-PEP and verifier | Corrective evidence to reinstatement boundary | Corrected immutable evidence, purpose-valid QA and review receipts, new G4 release version, and new A09/G3 where required | Reinstatement authorization signed only with `KP-REINSTATEMENT-AUTHORIZATION-v1`, permitting a new challenge/session | Missing correction, quorum, purpose, separation, release, or required A09/G3: no reinstatement; old session/release remains terminal |

## 4. Interface ownership and write authority

| Data/control plane | Authoritative writer | Read/verify consumers | Explicit non-writers |
| --- | --- | --- | --- |
| Assignment lifecycle | Valid assignment authority through signed events | Receipt verifiers, G-PEP, auditors | Assignee, repository author, agent, OS administrator |
| Governance outcome | Decision Chair | G-PEP, release verifier, auditors | QA, reviewer, publisher, Coordinator/Architect |
| Execution release | Coordinator/Architect | ARM publisher, verifier, G-PEP | Decision Chair, implementer, runtime |
| ARM/configuration approval | Purpose-authorized ARM publisher constrained by acceptance/release | TMC, verifier, loader | Runtime, agent, environment, CLI |
| Effective configuration measurement | Loader emits observation; TMC signs measured evidence | Verifier | Agent/model/harness verdict logic |
| Runtime trust verdict | Verifier | G-PEP, auditor | TMC, runtime, provider |
| Admission and governed object state | G-PEP | Callers, verifier, reconciler, auditor | Direct DB users, admin, migration, backup, UI/API caller |
| External immutable audit | WORM/anchor services for their own records | Reconciler, independent auditor | WORM/anchor cannot mutate governed state |
| Rollback authorization | Automatic adopted policy, or Coordinator/Architect plus independent Security/Governance approver | G-PEP recovery controller, auditor | Operator request alone, affected implementer/evidence producer |

## 5. State handoff matrix

| Source state/event | Receiving interface | Required receiving state/action | Forbidden shortcut |
| --- | --- | --- | --- |
| Assignment `EFFECTIVE` | `IF-03`, `IF-04`, `IF-11`, `IF-15` | Reverify exact scope, interval, separation, counter, and revocation at use time | Cache role eligibility beyond freshness or infer it from key possession |
| A09 governance `ACCEPTED` | `IF-03` | Permit separate G3 acceptance evaluation only | Directly create `G3_ACCEPTED`, `RELEASED`, ARM `ELIGIBLE`, runtime `ADMITTED`, or object `PASSED` |
| Gate `G3_ACCEPTED` | `IF-04` | Permit exact-run G4 release evaluation only | Reuse A09/G3 signature or directly create `RELEASED` |
| Run `RELEASED` | `IF-05` | Permit ARM eligibility evaluation only | Use release for another candidate, environment, run, or time window |
| ARM `ELIGIBLE` | `IF-06` through `IF-11` | Permit challenge and attestation evaluation | Treat signed manifest as proof of active loaded state |
| Producer `EVIDENCE_ISSUED` | `IF-11` | Independently evaluate to a verifier verdict | Map `MEASURED` directly to `TRUSTED_ACTIVE` |
| Verdict `TRUSTED_ACTIVE` | `IF-11`/`IF-15` | `BLOCKED -> ADMITTED` only while fresh and all mutation guards pass | Treat admission as authority to mutate or as A09 acceptance |
| Verdict non-trusted/stale | `IF-11`/`IF-12` | Immediate `ADMITTED -> BLOCKED`; preserve evidence | Grace period, cached allow, or same-session recovery |
| Object `READY` | `IF-15` | Permit stage evaluator evaluation | Treat as governance acceptance |
| Object `PASSED` | `IF-15` | Satisfy only explicit enabled successor/join guards | Skip undefined/disabled A01-A12 nodes or imply execution release |
| Event transaction committed | `IF-16` | Deliver exact outbox bytes | Synthesize event from state or import external orphan |
| WORM `DELIVERED` | `IF-17` | Include in next checkpoint within adopted bound | Treat delivery as anchored before checkpoint |
| Revocation/suspension | `IF-19` to all | Apply highest-precedence blocking state | “Newest allow wins,” local override, or evidence deletion |
| Rollback authorized | `IF-21` | New version/event and new runtime session | Destructive overwrite or reactivation of old session |

## 6. Input/output object profiles

These profiles identify minimum schema families for later reconciliation. Names are stable design
labels, not published schema IDs.

| Profile | Produced at | Minimum payload beyond common envelope | Consumed at |
| --- | --- | --- | --- |
| `AssignmentReceipt` | `IF-01` | Grantor/grantee identity, mandate chain, delegation depth, role/scope, effective interval, lifecycle state, conflicts, acknowledgement | `IF-03`, `IF-04`, `IF-11`, `IF-15`, `IF-19` |
| `CandidateReviewPackage` | `IF-02` | Commit/tree/artifact digests, manifest, QA/review receipts, findings/dependencies, policy/schema/registry snapshot | `IF-03` |
| `A09Decision` | `IF-03` | Prior/next governance state, `ACCEPTED`/`REVISE`/`REJECTED`, rationale, typed prerequisites, nonce/counter/revocation epoch, `KP-A09-DECISION-v1` | `IF-03` G3 evaluation, audit |
| `G3Acceptance` | `IF-03` | Exact accepted A09, candidate-identical typed prerequisites, `CLOSED -> G3_ACCEPTED`, `KP-G3-ACCEPTANCE-v1` | `IF-04`, `IF-05`, audit |
| `G4ExactRunRelease` | `IF-04` | Exact G3 and A09 refs, run/environment/window, actions/effects, feature state, abort conditions, rollback target, `KP-G4-EXACT-RUN-RELEASE-v1` | `IF-05`, `IF-11`, `IF-15`, `IF-20` |
| `ApprovedRuntimeManifest` | `IF-05` | Components, hash domains/raw/canonical digests, precedence, ambient denylist, endpoint/model and measurement profiles, receipt refs | `IF-07`, `IF-08`, `IF-11` |
| `VerifierChallenge` | `IF-06` | `VERIFIER_OPERATOR`, `KP-VERIFIER-CHALLENGE-v1`, random nonce, channel binding, policy digest, expiry <=120 seconds, single use | enrolled TMC at `IF-08`/`IF-12` |
| `LoaderObservation` | `IF-07` | Opened-handle/component mapping, parsed bytes, ordered resolution trace, effective-config digest | `IF-08`, `IF-11` |
| `LaunchEvidence` | `IF-08` | Canonical runtime-attestation schema ID; challenge, platform quote, boot/TMC/launcher/process/session/runtime key, module/config/model/endpoint digests; TMC runtime domain/purpose | `IF-11` |
| `ModelEndpointStatement` | `IF-10` | exact allowed signer role, `KP-MODEL-ENDPOINT-STATEMENT-v1`, provider/tenant/service/region/proxy/TLS policy, immutable model, request and commitments, nonce/audience/expiry | TMC assembly, `IF-11`, `IF-13` |
| `VerifierVerdictReceipt` | `IF-11` | Verdict state, complete input digest set, receipt time/freshness, reason codes | `IF-12`, `IF-13`, `IF-15` |
| `LivenessEvidence` | `IF-12` | Challenge/channel, prior evidence digest, sequence/counter, process/boot/session and security state | `IF-11`, `IF-13` |
| `MutationRequest` | `IF-14` | Principal/interface ID, object/expected version, requested edge, idempotency key, evidence refs | `IF-15` |
| `GovernedEvent` | `IF-15` | Exact Registry Section 6 `record_without_hash`; ledger domain/ID/sequence/raw predecessor/derived hash remain outside JSON | `IF-16`, `IF-18`, `IF-21` |
| `IntakeDenial` | `IF-14` | Raw-input commitment, caller/interface/correlation, decision/reason, trusted receipt time | Intake audit and `IF-18` |
| `DeliveryAcknowledgement` | `IF-16` | Event/outbox identity, exact byte/hash confirmation, WORM sequence and receipt time | `IF-17`, `IF-18` |
| `LedgerHeadAttestation` / `AnchorCheckpoint` | `IF-17` | Registry `PROFILE-LEDGER-HEAD-SIGNING-v1`; exact non-self-referential projection, RFC 8785 bytes, 24-byte domain, length frame, ledger ID/sequence/head hash/policy/prior checkpoint, low-S P1363 ES256 encoding | `IF-18` |
| `RevocationSnapshot` | `IF-19` | Monotonic epoch, affected IDs/purposes/scopes, effective ordering, incident/adjudication refs | Every verification boundary |
| `RollbackReceipt` | `IF-20`/`IF-21` | Trigger, initiator/approvers, source/target, affected scope, compensation/irreversible effects, invalidations, resulting versions | `IF-18`, `IF-22` |
| `ReinstatementAuthorization` | `IF-22` | Cause resolution, corrected evidence, purpose-valid QA/review/new G4 release/A09/G3 refs as applicable, exact quorum, new validity/state/run/session, `KP-REINSTATEMENT-AUTHORIZATION-v1` | G-PEP and verifier |

## 7. Failure and reason-code routing

| Failure class | Detecting interfaces | Primary proposed code | Required system response |
| --- | --- | --- | --- |
| Identity/assignment/role conflict | `IF-01`-`IF-05`, `IF-11`, `IF-15`, `IF-20`, `IF-22` | `E_AUTHORITY_ABSENT`, `E_SEPARATION` | Deny action; retain prior state |
| Schema/canonicalization/unsupported version | All object ingress interfaces | `E_SCHEMA`, `E_UNKNOWN_REGISTRY` | Deny before trusted interpretation |
| Signature/key-purpose/trust-chain | Signed-object consumers | `E_SIGNATURE`, `E_KEY_PURPOSE` | Deny; suspend scope if previously active trust is implicated |
| Expiry/revocation/status unavailable | `IF-03`-`IF-05`, `IF-08`-`IF-12`, `IF-15`, `IF-19` | `E_EXPIRED`, `E_REVOKED`, `E_REVOCATION_UNAVAILABLE` | Block or revoke according to precedence |
| Replay/order ambiguity | `IF-03`, `IF-04`, `IF-06`, `IF-11`, `IF-12`, `IF-15`, `IF-19` | `E_REPLAY`, `E_ORDERING_AMBIGUOUS` | Deny; alert; suspend if active scope cannot be trusted |
| Candidate/run/session/object scope mismatch | `IF-03`-`IF-15` | `E_SCOPE` | Deny; no substitution or nearest-match behavior |
| Dependency unavailable/unverified | All consumers of registry-pinned dependencies | `E_DEPENDENCY` | Remain blocked; availability never overrides integrity |
| Runtime/config/platform trust failure | `IF-07`-`IF-12` | `E_ATTESTATION`, `E_LIVENESS` | `UNTRUSTED` or `SUSPENDED`; admission `BLOCKED` |
| Model/endpoint proof failure | `IF-10`, `IF-11`, `IF-13` | `E_MODEL_BINDING` | Deny governed use of result |
| Mutation concurrency/idempotency/topology | `IF-14`, `IF-15` | `E_CONFLICT`, `E_IDEMPOTENCY_CONFLICT`, `E_TRANSITION` | No mutation; caller rereads where safe |
| Audit delivery/checkpoint mismatch | `IF-16`-`IF-18` | `E_AUDIT_DELIVERY`, `E_ANCHOR` | Suspend promotion; replay committed bytes only |
| Rollback/recovery invalid | `IF-20`-`IF-22` | `E_ROLLBACK_AUTHORITY` | Remain suspended; preserve failed state |
| Irreversible side effect | `IF-20`, `IF-21` | `E_IRREVERSIBLE_EFFECT` | Record, compensate where possible, escalate |
| Unclassified error | Any | `E_INTERNAL` | Fail closed, safe diagnostics, alert |

## 8. Boundary-specific audit requirements

Every boundary SHALL emit an audit record for allow and deny outcomes. At minimum:

- `IF-01`-`IF-05`: actor identities, assignments, exact candidate/run, prior/next authority state,
  counters, revocation epoch, receipt IDs/digests, and separation result.
- `IF-06`-`IF-13`: challenge/session/channel, platform/TMC/process/config/model/endpoint identities,
  sequences/counters, verifier receipt time, verdict, and nearest liveness/inference binding.
- `IF-14`-`IF-15`: caller, AMI interface ID, object/version, requested edge, expected version,
  idempotency key, transaction outcome, prior/current event hash, and no-mutation reason.
- `IF-16`-`IF-18`: outbox/event bytes and hashes, delivery attempts/acknowledgements, WORM
  sequence, checkpoint identity, reconciliation direction, and orphan/missing classification.
- `IF-19`-`IF-22`: revocation/incident ordering, affected scope, initiator/approvers, source/target,
  irreversible effects, new versions, invalidated receipts/nonces, and reinstatement prerequisites.

Audit bodies SHALL exclude secrets and unnecessary sensitive payloads. Commitments, access
controls, encryption, retention, legal hold, and linked non-destructive redaction SHALL be fixed
by an adopted data-classification profile.

## 9. Reconciliation constraints for later A/B work

Future schema/vector authors can use the following exact constraints without editing this matrix:

1. **A-04 ownership:** loader resolves; TMC measures and signs producer evidence; verifier decides
   trust; G-PEP enforces admission. No schema may merge those authorities.
2. **B-03 ownership:** G-PEP alone writes governed state. Intake, WORM, anchor, and reconciler
   cannot write authoritative object state.
3. **Double validation:** `IF-14` acceptance validation and `IF-15` persistence validation are
   separate results. Only `IF-15` can commit.
4. **Exact bindings:** all applicable objects pin candidate, release, ARM, challenge, session,
   object/version, policy/schema/registry/revocation snapshots, and predecessor/event identity.
5. **State separation:** assignment, governance, run, ARM, producer, verifier, admission,
   governed-object, and audit-delivery states remain separate fields and state machines.
6. **Terminal semantics:** expired/revoked/superseded assignments and releases, non-trusted ended
   sessions, and rolled-back/superseded objects cannot be reactivated. Recovery creates new
   versions or sessions.
7. **Precedence:** revocation and suspension override positive states; conflict/uncertainty blocks.
8. **Framing and projection:** general signed objects use `FRAME-LEN-DOMAIN-v1`; B-03 ledger
   records use `FRAME-GPEP-EVENT-v1` and the exact Registry Section 6 projection. Ledger framing
   fields are outside JSON; no JSON record hashes itself.
9. **Registries:** schemas, algorithms, key purposes, canonical/framing profiles, hash domains,
   decisions, dependencies, states, and ordered reason codes use
   `W05_VERSIONED_REGISTRY.md`. Unknown/unmapped values fail closed.
10. **Rollback:** `IF-20` authorizes and plans; `IF-21` records recovery as a new version/event;
    `IF-22` governs reinstatement and a new runtime session.

### 9.1 Current schema/vector reconciliation

The current package contains 35 schema files and one canonical fourteen-scenario vector family
(2 positive, 12 negative) in six files. Current literals use the registered interface IDs, event projection,
`ALLOW|REJECT`, ledger-head IF-17 schema/domain/purpose, and ordered detector reasons.
Registry Section 7.1 now authoritatively adopts the vector family’s non-self-referential
ledger-head projection and adds the exact design signature encoding and verification order.

This replaces the old pending Agent A/B consumption status. It does not assert validator
execution, cryptographic verification, implementation, adoption, or publication.

## 10. Design alignment after F-04 correction

Applied together, this matrix, the shared contract, and the versioned registry classify:

- `ALIGNED`: **22**
- `PARTIAL`: **0**
- `CONFLICT`: **0**
- `BLOCKED_BY_ADOPTION`: **0** as a primary design-consistency classification

Operational overlay:

- adopted interfaces: **0**
- demonstrated interfaces: **0**
- interfaces blocked from operation by adoption/implementation: **22**

## 11. Non-demonstration and adoption gaps

No interface in this matrix was executed, probed, validated, or tested. Current schemas,
fixtures, and canonical design vectors are present, but no validator/consumer/cryptographic
execution established conformance. No service, datastore, trust root, effective key, assignment,
immutable candidate, publication receipt, QA receipt, formal independent-review receipt,
Decision Chair receipt, adoption receipt, or execution release was demonstrated.

Adoption remains dependent on:

- effective adoption authority and exact-candidate signed adoption receipt;
- immutable publication of this matrix, its companion contract, and reconciled A/B schemas;
- approved identities, assignments, separations, algorithms/key purposes, dependencies, reason
  codes, state vocabulary, cryptographic framing, and trust/revocation/time profiles;
- machine-valid schemas and canonical vectors for every interface object;
- selected and independently reviewed platform, provider, G-PEP, WORM, anchor, and reconciliation
  implementations;
- separately authorized conformance, negative, replay, failure, recovery, and bypass testing;
- exact-candidate QA and effective independent review;
- Decision Chair acceptance; and
- a later, separate Coordinator/Architect exact-run execution release.

Current disposition:

`35 SCHEMAS + 1 VECTOR FAMILY / 14 SCENARIOS (2 POSITIVE, 12 NEGATIVE) / 6 FILES PRESENT -> 22 INTERFACES INTERNALLY DESIGN-ALIGNED -> VALIDATION/CRYPTO/ENFORCEMENT NOT DEMONSTRATED -> ADOPTION AUTHORITY ABSENT -> UNPUBLISHED -> NOT ADOPTED`

