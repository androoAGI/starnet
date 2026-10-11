# B-03 Executable Enforcement Specification

## Document control

- Artifact ID: `B-03`
- Status: `DESIGN_DRAFT`
- Program: Agent University / IMHOTEP Wave 0.3
- Owner: Agent B
- Proposed reviewer: Agent D
- Repository branch inspected: `cursor/populate-authority-readiness-7886`
- Repository commit inspected: `c0579a4e4d272162963de09bdec7494d822c1fe2`
- Acceptance receipt: **NONE**
- Acceptance state: **NOT ACCEPTED / NOT AUTHORIZED FOR IMPLEMENTATION**
- Scope: documentation, read-only investigation, and control design only

> **No-implementation statement:** This artifact does not implement, enable, test, deploy, or authorize any control. No runtime/source/configuration, ACL, account, network, VM, commit, or remote state was changed. Every acceptance test below is `FUTURE/NOT RUN`. Prompt, persona, policy prose, branch naming, and pre-commit hooks are not treated as enforcement.

## 1. Executive distinction

### VERIFIED EXISTING

The inspected tree contains partial, application-level enforcement mechanisms:

- `sidecar/permissions.js` has a deterministic consent broker with hardline denial, fail-closed autonomous mutation behavior, injected grants, and explicit bypass/full-power paths.
- `sidecar/capability/capGate.js` checks resolved tool capabilities and attenuates delegated capability sets by intersection.
- `shared/schema.js` performs a limited JSON-schema-like validation subset for tool arguments and event payloads.
- `sidecar/skills/gate.js` withholds blocked or unapproved skill content and rechecks changed content at delivery.
- `scripts/qa/au-ucr-s0-readiness.mjs` checks selected repository invariants and keeps the S1 transition closed when acceptance is absent.
- Governance documents separate publication, governance decision, and execution-release states, require role separation, and prescribe append-only receipts and rollback.

These controls do **not** constitute the executable Agent University enforcement system specified here. In particular, no verified OS ACL boundary, A01-A12 runtime transition manager, cryptographically signed A09 receipt verifier, canonical hash-chained audit ledger, or mandatory runtime validation of the governance receipt schema was found.

### PROPOSED

This specification proposes an OS boundary plus a single mandatory Policy Enforcement Point (PEP) that validates version-pinned schemas, evaluates A-code prerequisites, verifies A09 authority receipts, atomically commits transitions and append-only audit records, fails closed, and supports suspension/rollback. The design is intentionally independent of prompt/persona compliance and cannot be satisfied by a pre-commit hook alone.

## 2. Evidence and confidence

Git blob hashes below are SHA-1 object identifiers returned by `git hash-object`; repository commit identity is the 40-hex commit above. They identify inspected bytes but are not acceptance receipts.

- `docs/experiments/au-ucr-ep-000001/AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md` — blob `0615ce69cb41c6affeda8fa919a513007fa6a5d9`: role separation, distinct state machines, receipt requirements, blocking and rollback.
- `docs/experiments/au-ucr-ep-000001/S0_RECEIPT_SCHEMA.json` — blob `d407708b6141925b28c4b37377f682d410e670cf`: JSON Schema draft 2020-12 declaration, but permissive `additionalProperties: true`, S0-specific constants, and no verified runtime enforcement.
- `docs/experiments/au-ucr-ep-000001/S0_DEPENDENCY_GRAPH.md` — blob `0d07262fcc82fd720e611ab6c23aba125e399ea0`: frozen UCR-001..UCR-012 work-item dependencies; this is not an A01-A12 stage graph.
- `docs/experiments/au-ucr-ep-000001/S0_FEATURE_FLAG_CONTRACT.md` — blob `aea9396aa5a4fa1d246cb9c2978d5ae6d409a2fe`: proposed/default-OFF overlay and A09 rollback law; the readiness record says there were no runtime flag hits.
- `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-AUTHORITY-NAMES-00.json` — blob `1646f08d23c4d66f3882f0c34cea0ef2349da6fc`: directly records missing named assignments, absent Decision Chair receipt, and absent execution release.
- `shared/schema.js` — blob `0763408d34fcdc47bb34b7f158af57e099367066`: limited validator; no `$schema`, `$id`, `const`, pattern, format, numeric/string bounds, conditionals, references, or unevaluated-property support.
- `sidecar/permissions.js` — blob `18fc8341f0c8c8fa68a6ba71564b30b43d5d2e7c`: consent enforcement with documented bypasses and fail-closed branches.
- `sidecar/capability/capGate.js` — blob `ce3b495d904e4fcfd9b9b5195a48d15477a16cd6`: capability checks and monotonic attenuation.
- `sidecar/skills/gate.js` — blob `ee041de1f31db56d3a38d36f144c594287254867`: content gate; its FNV-1a digest is explicitly a change detector, not a cryptographic signature.
- Safe local IMHOTEP reference: `C:\Users\hakee\.cursor\skills\imhotep\SKILL.md` defines A01 Discover, A02 Define, A06 Evaluate, A07 Risk, A08 Options, A09 Decision Gate, and A12 Review. It does not supply authoritative definitions for A03-A05 or A10-A11 and is not runtime enforcement.
- Persona inspection: `frontend/app/personas.js` explicitly states personality never changes authority or grants permission. It is prompt composition, not an authorization schema or enforcement point.

## 3. Trust boundaries and principals

### VERIFIED EXISTING boundary observations

- The current evidence names local OS and repository principals but explicitly refuses to infer governance authority from them.
- Lane owners remain `unassigned_role_only`; that value authorizes no action.
- Existing consent/capability checks execute within the application process and depend on host-injected state.
- Full-power/full-access and administrator-equivalent paths remain deliberate bypass surfaces.

### PROPOSED trust model

1. **Untrusted request zone:** agents, prompts, personas, UI, API clients, repository content, receipt submitters, and imported evidence.
2. **PEP service zone:** a dedicated non-interactive service identity runs the transition API, schema validator, A09 verifier, and audit writer. No agent identity may run this process or hold its private credentials.
3. **Authority zone:** an identity provider and signing service bind a named human to an effective role assignment and protected signing key.
4. **State zone:** the transition database permits writes only through the PEP identity; readers receive read-only credentials.
5. **Audit zone:** the audit writer may append but cannot update/delete; a separate anchor publisher emits periodic externally verifiable roots.
6. **Administration zone:** administrators can recover infrastructure but cannot silently create a valid A09 transition; privileged actions must be dual-controlled and produce out-of-band audit evidence.

## 4. OS-level write restriction design

### PROPOSED identities

- `AU_PEP_SVC`: logon-as-service only; execute PEP binaries, read pinned policy/schema bundle, update transition state, append audit.
- `AU_AUDIT_SVC`: append audit and publish anchors; cannot mutate transition state.
- `AU_DEPLOY_SVC`: deployment-only; may replace signed binaries/policies during an approved maintenance window; cannot issue governance decisions.
- `AU_BREAKGLASS`: disabled by default, individually assigned, MFA-protected, time-bound, dual-approved, fully recorded.
- `AU_READERS`: read state and verified audit projections only.
- Human/agent interactive identities receive no write access to protected runtime, policy, schema, state, key, or audit locations.

### PROPOSED ACL boundary

- Protected roots: executable/runtime root, policy/schema root, transition-state root, authority-key/trust root, audit root, and backup/anchor configuration.
- Disable inheritance at every protected root after copying only reviewed parent ACEs. Child objects inherit solely from that protected root.
- Use explicit allowlists; no write/modify/delete/delete-child/change-permissions/take-ownership for interactive users, generic Users, agents, or build identities.
- Audit root: `AU_AUDIT_SVC` gets create/append only; PEP gets append through a narrow broker; neither gets delete or rewrite. Readers get read.
- State root: only `AU_PEP_SVC` gets data mutation. Deployment identity cannot mutate state.
- Policy/schema and executable roots: runtime services get read/execute only; only `AU_DEPLOY_SVC` gets maintenance-window replace.
- Explicit deny is reserved for broad interactive/agent groups where inherited or newly granted parent permissions could otherwise reopen writes. Deny ACE ordering and effective-access checks must be verified because deny entries can also block recovery identities.
- Network shares, alternate data streams, junctions/reparse points, hard links, backup/restore privilege, service-control rights, scheduled tasks, debugger rights, and DLL/module search paths are inside the boundary assessment.

### Denial and administrator residual risk

ACL denial is mandatory but not absolute against local administrators, SYSTEM, kernel compromise, offline disk access, ownership takeover, backup/restore privileges, or a compromised deployment pipeline. Therefore:

- transitions require valid signed authority material even if files are writable;
- audit anchors leave the host;
- service keys are non-exportable where supported;
- privileged changes require two-person operation and generate independent alerts;
- host compromise suspends promotion until re-attestation and ledger reconciliation.

## 5. Runtime schema validation

### VERIFIED EXISTING

The exact existing receipt schema is `docs/experiments/au-ucr-ep-000001/S0_RECEIPT_SCHEMA.json`, `$schema` draft 2020-12, `$id` `au-ucr-ep-000001-s0-receipt`. It is S0-specific, allows extra properties, fixes `owner_lane` to `unassigned_role_only`, and has no signature, nonce, expiry, revocation, chain, or transition fields. No mandatory runtime call site validating governance transitions against it was verified. `shared/schema.js` is not a complete draft-2020-12 implementation.

### PROPOSED exact schema source/version

- Canonical future source: `schemas/agent-university/enforcement/1.0.0/transition-receipt.schema.json`
- Canonical schema identifier: `urn:agent-university:enforcement:transition-receipt:1.0.0`
- Dialect: JSON Schema 2020-12.
- Deployment pin: SHA-256 of the schema bundle stored in signed PEP release metadata. Runtime must reject unknown schema IDs or hash mismatch; network schema retrieval is forbidden.
- Validator: a standards-conformant implementation pinned by package name, exact version, lockfile digest, and conformance evidence before deployment. Selection is an implementation prerequisite, not decided by this draft.

### PROPOSED enforcement point and bypass resistance

Every state-changing interface—UI, API, CLI, queue consumer, recovery tool, migration, and administrative path—must call one PEP transaction endpoint. The datastore rejects direct client writes. The PEP sequence is:

1. authenticate principal and bind request to a stable identity;
2. parse with duplicate-key rejection, bounded depth/size, and UTF-8 validity;
3. validate request and referenced receipts against pinned schemas;
4. load current state, prerequisite closure, role assignments, revocations, and nonce status under one serializable transaction;
5. authorize the transition;
6. verify A09 signature when required;
7. atomically append audit event and update state, or update neither;
8. return a receipt containing committed sequence and event hash.

Schema or policy loading failure, unknown version, stale cache, storage ambiguity, audit failure, or transaction conflict denies the transition. A pre-commit hook and client-side validation may improve feedback but are advisory and insufficient.

## 6. A01-A12 transition manager

### Definition constraint

Only A01, A02, A06, A07, A08, A09, and A12 semantics were found in the safe local IMHOTEP reference. The repository mentions A01-A12 mapping but does not provide a complete authoritative A01-A12 registry. Consequently, the PEP must not invent A03-A05 or A10-A11 semantics. Their definitions, owners, prerequisites, evidence contracts, and transition outcomes are a blocking prerequisite.

### PROPOSED state model

- Each governed object stores `current_stage`, `stage_status`, `version`, `predecessor_event_hash`, and immutable references to evidence.
- Status values: `NOT_STARTED`, `IN_PROGRESS`, `READY`, `PASSED`, `FAILED`, `HOLD`, `SUSPENDED`, `ROLLED_BACK`, `SUPERSEDED`.
- No caller sets stage directly. It submits a requested transition and evidence references.
- Forward movement requires all graph predecessors in an allowed terminal state, complete evidence, effective role assignment, separation-of-duty checks, and stage-specific policy success.
- Unknown, missing, contradictory, expired, or unverifiable prerequisites are denial, never pass.
- Backward movement is represented by append-only `SUSPEND`, `REMEDIATE`, or `ROLLBACK` events; history is never rewritten.

### PROPOSED prerequisite graph

Pending authoritative definitions, the only enabled edges are those grounded in the IMHOTEP reference:

`A01 Discover -> A02 Define -> [A03-A05 BLOCKED: definitions absent] -> A06 Evaluate -> A07 Risk -> A08 Options -> A09 Decision Gate -> [A10-A11 BLOCKED: definitions absent] -> A12 Review`

The registry must enumerate all twelve nodes and explicit edges in a signed, versioned policy bundle. Any omitted node, ambiguous edge, cycle, or policy-version mismatch returns `E_STAGE_REGISTRY_INVALID`. Parallel branches require an explicit join policy; implicit skipping is prohibited.

The UCR-001..UCR-012 graph in `S0_DEPENDENCY_GRAPH.md` is a separate work-item graph. The manager must evaluate both graphs without conflating UCR item numbers with A-code stages.

## 7. A09 authorization verification

### VERIFIED EXISTING

Governance prose assigns the Decision Chair the governance outcome and the Coordinator/Architect the separate execution release. Existing evidence records no named assignments, no Decision Chair receipt, no execution-release receipt, and `NO_DECISION_NO_TRANSITION`.

### PROPOSED mandatory A09 receipt

An A09 transition requires a signed receipt with:

- artifact/experiment/object IDs, requested transition, prior state/event hash, exact candidate content SHA-256, policy/schema bundle SHA-256, prerequisite receipt hashes, decision and rationale;
- authority `subject_id`, legal/display name, named role `Decision Chair`, role-assignment receipt hash, issuer, organization, and separation-of-duty attestations;
- signature algorithm and key ID; issued-at, not-before, expires-at; unique 256-bit nonce; monotonically increasing authority counter; revocation epoch; intended audience and environment;
- independent reviewer and QA receipt hashes when policy requires them;
- explicit `ACCEPTED`, `REVISE`, or `REJECTED`; no null/default acceptance.

Canonicalize the unsigned payload using RFC 8785 JSON Canonicalization Scheme and sign its SHA-256 digest with an approved asymmetric algorithm (proposed Ed25519, subject to enterprise cryptography approval). The PEP verifies certificate/key trust, key usage, identity-to-role binding, assignment effective interval, signature, candidate binding, audience, and every prerequisite hash.

Freshness default is proposed as 15 minutes from `issued_at`, with maximum clock skew 60 seconds. A consumed nonce is atomically recorded with the transition and may never be reused. The authority counter must exceed the last accepted counter for that authority and scope. Revocation lists/epochs must be available and current; unavailable revocation state fails closed. Revoking a role, assignment, or key immediately prevents new use and triggers review/suspension of affected unconsumed or active authorizations. An `ACCEPTED` governance receipt does not itself issue execution release.

## 8. Tamper-evident append-only audit

### VERIFIED EXISTING

Documents require append-only receipts and preservation of failures. Existing evidence uses SHA-256 manifests in places. No mandatory runtime cryptographic chain, external anchor, or storage-enforced append-only ledger for A-code transitions was verified.

### PROPOSED record format and chain

Every attempted transition, including denial and internal failure, creates an audit record with:

- `ledger_id`, strictly increasing `sequence`, UTC timestamp plus monotonic time, event ID, correlation/trace ID;
- actor, authenticated principal, effective roles, source interface, target object/version;
- requested transition, decision, error code, policy/schema hashes, receipt/evidence hashes, redacted reason;
- `prev_hash`, `record_hash`, PEP build identity, host/workload identity, and transaction outcome.

Canonical bytes are RFC 8785 JCS over the record excluding `record_hash`. Compute:

`record_hash = SHA-256("AU-AUDIT-v1" || ledger_id || uint64be(sequence) || prev_hash || canonical_record_bytes)`

The genesis record references a published zero hash and ledger-creation authorization. Sequences are gap-detected. Forks, duplicate sequences, hash mismatch, or missing anchors trigger suspension.

The primary store must enforce append-only semantics; retention-lock/WORM storage or an equivalent separately administered ledger is required. At least every 5 minutes or 1,000 records, publish a signed checkpoint containing ledger ID, sequence, head hash, and Merkle root to an independently administered anchor destination. Anchors must be cross-checked by a read-only verifier. Sensitive values are never logged; stable tokenized identifiers permit correlation.

## 9. Failure-closed behavior and error taxonomy

No state change occurs unless authorization, schema, prerequisites, audit append, and state commit succeed atomically. Timeouts are denial. Retries require the same idempotency key and return the prior outcome; they cannot create a second transition.

- `E_AUTHN_REQUIRED`: no authenticated stable principal.
- `E_AUTHZ_DENIED`: principal lacks effective authority.
- `E_ROLE_ASSIGNMENT_INVALID`: missing, inactive, conflicting, or unsigned assignment.
- `E_SEPARATION_DUTY`: incompatible roles or self-certification.
- `E_SCHEMA_UNKNOWN`, `E_SCHEMA_HASH_MISMATCH`, `E_SCHEMA_INVALID`: schema or payload failure.
- `E_STAGE_REGISTRY_INVALID`, `E_TRANSITION_ILLEGAL`, `E_PREREQUISITE_MISSING`: graph/state failure.
- `E_EVIDENCE_UNKNOWN`, `E_EVIDENCE_HASH_MISMATCH`, `E_EVIDENCE_STALE`: evidence failure.
- `E_A09_RECEIPT_REQUIRED`, `E_SIGNATURE_INVALID`, `E_RECEIPT_EXPIRED`, `E_RECEIPT_REVOKED`, `E_REPLAY_DETECTED`: A09 failure.
- `E_POLICY_UNAVAILABLE`, `E_REVOCATION_UNAVAILABLE`, `E_CLOCK_UNTRUSTED`: trusted dependency unavailable.
- `E_AUDIT_UNAVAILABLE`, `E_AUDIT_CHAIN_BROKEN`, `E_ANCHOR_STALE`: audit integrity failure.
- `E_CONFLICT`: optimistic/serializable transaction conflict; caller must reread state.
- `E_SUSPENDED`: global, object, stage, or authority suspension active.
- `E_INTERNAL`: unclassified internal failure; deny and alert without exposing secrets.

Externally returned messages include code, correlation ID, and safe remediation only. Detailed diagnostics remain access-controlled.

## 10. Rollback and suspension

### PROPOSED suspension

Any authorized security responder may request suspension, but the PEP applies only a signed suspension policy or automatic trigger. Triggers include compromised authority/key, broken audit chain, stale anchor, invalid policy/schema digest, revocation unavailability, host attestation failure, material contradiction, or safety regression.

Suspension immediately denies promotion/execution transitions, preserves read access and evidence collection, marks affected objects `SUSPENDED`, snapshots verified state, revokes outstanding nonces/receipts, and emits/anchors a suspension event. It does not delete history.

### PROPOSED rollback

1. Identify last verified state and content-addressed rollback target.
2. Verify target signature, hash, schema/policy compatibility, and restoration prerequisites.
3. Obtain separate rollback authorization under the defined emergency policy; the original implementer cannot self-authorize.
4. Quiesce new transitions and drain or reject in-flight work.
5. restore by creating a new version pointing to the prior known-good content; never overwrite the failed version.
6. Reconcile state, audit head, external side effects, and outstanding credentials.
7. Emit rollback receipt and anchor; keep feature/treatment path disabled.
8. Resume only after independent verification and a new authorized transition.

For the current UCR design, rollback keeps `STARNET_UCR_ENABLE` OFF and baseline StarNet authoritative. Because runtime flag wiring was not verified, this is currently a documented target, not an executable control.

## 11. Threat and bypass analysis

- **Prompt/persona claims authority:** denied because authority derives only from authenticated identity, effective signed assignment, and policy; persona text is untrusted data.
- **Direct database/file edit:** OS ACL and datastore credentials deny ordinary identities; cryptographic chain and off-host anchors detect privileged tampering.
- **Pre-commit hook bypass (`--no-verify`, alternate client, API write):** hook is advisory; server/PEP and datastore enforcement remain mandatory.
- **Replay of valid A09 receipt:** nonce, authority counter, candidate/state hash binding, expiry, audience, and atomic consume prevent reuse.
- **Stolen or revoked signing key:** non-exportable key, MFA ceremony, revocation epoch, short freshness, and suspension constrain use; compromise before detection remains residual risk.
- **Role self-assignment or self-certification:** signed assignment authority, incompatible-role rules, and evidence-producer identity comparison deny.
- **Schema downgrade/substitution:** schema ID/hash pinned in signed release and receipt; unknown/different bundle denied.
- **TOCTOU between validation and commit:** serializable transaction locks current state, prerequisites, revocation, nonce, audit sequence, and update.
- **Audit truncation/fork:** sequence/hash verification and independent anchors detect; service suspends on inconsistency.
- **Clock rollback:** trusted time health plus monotonic counters; untrusted clock denies freshness-sensitive transitions.
- **Service/admin compromise:** least privilege, separate services, dual control, non-exportable keys, host attestation, and off-host anchoring reduce but do not eliminate risk.
- **Alternate executable/recovery path:** deployment inventory and mandatory PEP mediation; recovery produces the same authorization/audit obligations.
- **Denial of service:** failure closed protects integrity but harms availability; redundant PEP/read-only verification and practiced recovery are required.

## 12. Control matrix

- **C-01 OS write boundary — PROPOSED:** owner Platform Security; evidence effective-access export, inheritance report, service identity inventory; blocks runtime/policy/state/audit mutation by agents.
- **C-02 Runtime schema gate — PROPOSED:** owner Runtime; evidence pinned bundle/hash, validator conformance, entry-point coverage; blocks malformed or downgraded requests.
- **C-03 Capability/consent gates — VERIFIED EXISTING, partial:** owner StarNet Runtime; evidence inspected modules; applies to current tool dispatch, not A-code transitions.
- **C-04 A01-A12 manager — PROPOSED:** owner Governance Runtime; evidence signed complete stage registry and transition tests; currently blocked by missing definitions.
- **C-05 A09 authority verifier — PROPOSED:** owner Governance/Security; evidence named assignments, signing trust, revocation and replay tests; currently blocked by absent authorities.
- **C-06 Atomic state/audit commit — PROPOSED:** owner Runtime/Data; evidence transaction and fault-injection results.
- **C-07 Hash-chained append-only audit — PROPOSED:** owner Audit; evidence chain verification, WORM configuration, external anchors.
- **C-08 Suspension/rollback — PROPOSED:** owner Operations plus independent approver; evidence drills and reconciliation receipts.
- **C-09 Readiness script — VERIFIED EXISTING, advisory/partial:** owner S0 package; checks selected repository invariants but is not the runtime PEP.
- **C-10 Pre-commit/client validation — ADVISORY ONLY:** never accepted as a security boundary.

## 13. Observability

PROPOSED metrics and alerts:

- allowed/denied transitions by stage, reason, principal, policy version, and interface;
- schema failures, illegal edges, missing prerequisites, separation-of-duty denials;
- A09 signature failures, expired/revoked receipts, replay attempts, nonce/counter conflicts;
- audit append latency/failure, sequence gaps, hash mismatch, fork detection, anchor age/failure;
- ACL drift, protected-root ownership/permission change, service identity use outside expected host/process;
- policy/schema/build digest drift, clock health, revocation age, suspension state, rollback duration;
- data-minimized traces correlating request, decision, state transaction, audit sequence, and anchor.

Alerts for signature/replay, ACL drift, chain break, stale anchor, policy mismatch, or break-glass use are high severity and page independent responders. Metrics must not contain receipt bodies, secrets, private keys, or unredacted evidence.

## 14. Dependencies and implementation prerequisites

1. Authoritative, reviewed definitions for all A01-A12 stages, especially A03-A05 and A10-A11.
2. Named human assignments with stable identities, assignment authority, effective intervals, acknowledgements, conflict declarations, and separation-of-duty mapping.
3. Approved receipt, role-assignment, revocation, stage-registry, audit-record, suspension, and rollback schemas.
4. Approved cryptographic profile, key lifecycle, trust anchors, signing ceremony, and revocation service.
5. Selected conformant JSON Schema 2020-12 validator and canonicalization implementation with exact versions.
6. PEP architecture, complete entry-point inventory, datastore mediation, serializable transaction design, and migration/recovery controls.
7. Windows ACL/service-account design reviewed against deployment topology, including administrator and backup privileges.
8. Append-only/WORM audit platform and independently administered anchor destination.
9. Trusted time, workload identity/attestation, secret management, monitoring, alerting, backups, and disaster recovery.
10. Data classification, retention, privacy/redaction, and incident-response approvals.

## 15. Acceptance criteria and FUTURE/NOT RUN tests

All tests are design targets only.

- `AT-01 FUTURE/NOT RUN`: interactive user and agent identities cannot create, modify, replace, delete, relink, take ownership of, or change ACLs on protected roots.
- `AT-02 FUTURE/NOT RUN`: inherited parent permission changes do not reopen protected-root writes; effective-access evidence confirms explicit boundary.
- `AT-03 FUTURE/NOT RUN`: administrator/break-glass exercise generates dual approval, suspension, and off-host alert/anchor.
- `AT-04 FUTURE/NOT RUN`: every state-changing interface reaches the PEP; direct datastore and recovery-path writes fail.
- `AT-05 FUTURE/NOT RUN`: official JSON Schema 2020-12 conformance subset passes; unknown ID, wrong hash, extra properties, duplicate keys, oversized/deep payloads fail closed.
- `AT-06 FUTURE/NOT RUN`: every legal A01-A12 edge succeeds only with complete predecessors; skips, cycles, undefined stages, stale evidence, and UCR/A-code conflation fail.
- `AT-07 FUTURE/NOT RUN`: A09 accepts only a currently assigned named Decision Chair with valid signature and complete prerequisite receipts.
- `AT-08 FUTURE/NOT RUN`: expired, future-dated, revoked, wrong-audience, wrong-candidate, wrong-state, reused nonce, and non-increasing counter receipts fail.
- `AT-09 FUTURE/NOT RUN`: governance `ACCEPTED` without separate Coordinator execution release cannot execute.
- `AT-10 FUTURE/NOT RUN`: crash/fault at every transaction boundary produces both state+audit commit or neither.
- `AT-11 FUTURE/NOT RUN`: record mutation, deletion, insertion, truncation, reorder, duplicate sequence, and fork are detected; stale/missing anchor suspends promotion.
- `AT-12 FUTURE/NOT RUN`: policy, schema, revocation, audit, clock, or identity dependency outage denies transitions with the specified error.
- `AT-13 FUTURE/NOT RUN`: prompt/persona injection, alternate client, `--no-verify`, direct API, and privileged file-edit attempts cannot create an accepted transition.
- `AT-14 FUTURE/NOT RUN`: rollback restores a verified known-good version, preserves failed evidence/history, reconciles side effects, and requires independent resumption authorization.
- `AT-15 FUTURE/NOT RUN`: monitoring correlates each attempt through decision, state, ledger sequence, and anchor without exposing secrets.

Acceptance requires all mandatory tests passing on the exact release candidate, independent Agent D review, security review, named-authority receipts, and a separate acceptance receipt. This draft contains no such receipt.

## 16. Deployment stages

1. **D0 Design closure:** resolve blockers; approve schemas, full A-code registry, threat model, identities, and cryptographic profile.
2. **D1 Offline verifier:** validate fixtures and historical records without authorizing writes.
3. **D2 Shadow PEP:** evaluate production-like requests and compare decisions, but cannot mutate state.
4. **D3 Enforced non-A09 pilot:** OS boundary, schema gate, audit chain, and low-risk transitions in an isolated environment.
5. **D4 A09 closed pilot:** named authorities and signatures active; execution remains disabled while replay/revocation/failure tests run.
6. **D5 Limited execution:** explicit allowlisted objects, dual observation, immediate suspension capability, frequent anchoring.
7. **D6 General enforcement:** only after independent acceptance, rollback drill, and operational readiness.

Each stage has a signed promotion receipt and immutable rollback target. Failure returns to the prior stage; stage promotion is never inferred from deployment completion.

## 17. Blockers and residual risks

### Blocking

- Complete authoritative A01-A12 definitions and graph are absent; A03-A05 and A10-A11 cannot be safely inferred.
- No named effective Decision Chair, Coordinator/Architect, Independent Reviewer, QA/Evidence Agent, or other mandatory role assignment was verified.
- No A09 decision receipt, execution-release receipt, or acceptance receipt exists.
- Existing receipt schema is not suitable for runtime A09 enforcement and no mandatory runtime validation point was verified.
- No verified OS ACL/service-identity boundary, signing PKI, revocation service, WORM audit ledger, external anchor, or atomic transition datastore exists for this design.
- Baseline readiness records report failed `test:fast` and `test:http` gates and keep S1 closed.
- `STARNET_UCR_ENABLE` is documented but was reported as having zero runtime hits; rollback-by-flag is not yet executable.

### Residual after proposed controls

- Local/domain administrators, SYSTEM, kernel or hypervisor compromise, signing-service compromise, and supply-chain compromise can exceed ordinary ACL assumptions.
- A valid but malicious or coerced named authority can approve harmful action that satisfies syntactic policy.
- Revocation and trusted-time delay create bounded exposure before detection.
- Off-host anchors detect tampering but do not prevent initial malicious commits.
- Failure-closed design can cause availability loss and operational pressure to misuse break-glass.
- Incorrect authoritative stage definitions or policy rules can enforce the wrong process consistently.
- External side effects may not be fully reversible; rollback must use compensation and reconciliation where restoration is impossible.

## 18. Disposition

`B-03` is a `DESIGN_DRAFT` owned by Agent B and proposed for Agent D review. It distinguishes observed partial controls from unimplemented controls and explicitly grants no authority to proceed. Until blockers are resolved and a separate acceptance receipt is issued, the required disposition is:

`NO ACCEPTANCE -> NO A09 PROMOTION -> NO EXECUTION`
