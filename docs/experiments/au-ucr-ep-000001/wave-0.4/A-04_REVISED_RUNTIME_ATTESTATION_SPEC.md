# A-04 Revised Runtime Attestation Specification

## 1. Control record

- **Artifact:** `A-04`
- **Experiment / wave:** `AU-UCR-EP-000001 / 0.4`
- **Status:** `READY FOR ACCEPTANCE REVIEW`
- **Preparer:** Agent B, documentation/design role only
- **Design baseline inspected:** branch `cursor/populate-authority-readiness-7886`, HEAD `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Supersedes for review:** Wave 0.3 A-04 design; it does not overwrite prior history
- **Acceptance receipt:** none
- **Execution release:** none
- **Authorization:** design/documentation only

`READY FOR ACCEPTANCE REVIEW` means the design objections have a proposed normative disposition. It is not publication, formal reviewer acknowledgement, QA certification, governance acceptance, implementation authority, test authority, or execution release. All GATE-03 holds remain.

Normative terms `MUST`, `MUST NOT`, `SHALL`, and `SHALL NOT` describe a future control. No statement in this document claims that the control exists or has been tested.

## 2. Trust claim and prohibited inference

The verifier may issue `TRUSTED_ACTIVE` only for one identified runtime session and only while all required evidence is valid, fresh, authoritative, and bound to that session.

A file digest proves only the measured bytes in the declared hash domain. An agent-, harness-, model-, or session-generated digest is a producer claim and **MUST NOT** be treated as independent attestation. Prompt text, model output, runtime labels, branch names, paths, tags, successful inference, and producer-supplied verdicts are non-authoritative.

The current `sidecar/runtimeinfo.js` block is prompt-visible self-reporting. It is useful operator context but cannot satisfy this specification. Existing persona/overlay observations are contextual and non-authoritative unless a future publication receipt binds them to a containing commit and approved manifest.

## 3. Authorities and precedence

### 3.1 Trusted configuration source

The sole configuration authority SHALL be an immutable, content-addressed **Approved Runtime Manifest** (`ARM`) retrieved by digest from an approved registry. A directory, working tree, environment variable, registry key, command line, roster, model alias, or agent memory is not authoritative.

An ARM is eligible only when its exact bytes:

1. identify repository, commit, artifact set, schema and policy versions;
2. reference an effective role-assignment chain;
3. reference a publication receipt and independent-review acknowledgement;
4. reference a Decision Chair `ACCEPTED` receipt;
5. reference a later, separate Coordinator/Architect execution-release receipt; and
6. carry a valid release-authority signature under the approved key-purpose registry.

Absent any item, ARM status is `INELIGIBLE` and admission fails closed.

### 3.2 Verifier authority

Only a verifier operating under an effective, signed verifier-service assignment and pinned verifier policy may issue a runtime verdict. The evidence producer may claim `MEASURED` but never `TRUSTED`.

Verifier trust inputs are, in descending precedence:

1. emergency revocation or suspension signed by its authorized quorum;
2. current signed trust-store and revocation state;
3. separate execution-release receipt;
4. Decision Chair acceptance receipt;
5. independent review and QA receipts;
6. signed ARM and pinned policy/schema bundle;
7. verifier challenge and verifier receipt time;
8. platform quote and trusted measurement component evidence;
9. loader, model-adapter, and runtime evidence;
10. informational metadata.

Higher-precedence denial, revocation, expiry, conflict, or uncertainty overrides every lower-precedence allow. Evidence at equal precedence that conflicts yields `UNTRUSTED`, never “newest wins.” Local configuration cannot override the ARM.

## 4. File identity versus runtime identity

The verifier SHALL keep these identities distinct:

- **Raw file identity:** SHA-256 of exact bytes in an explicitly declared domain (`git_blob_lf`, `checkout_bytes`, or other versioned domain). No implicit newline or encoding normalization is permitted.
- **Canonical structured identity:** SHA-256 of RFC 8785 JCS after strict duplicate-key, Unicode, number, and schema validation.
- **Effective configuration identity:** digest of the fully resolved ordered configuration after applying the ARM precedence rules.
- **Runtime identity:** binding of device, boot, trusted measurement component, launcher, process creation, loaded executable/module set, effective configuration, persona, overlay, model, endpoint, session, and request.

Raw and canonical identities are complementary. Neither establishes active use. Runtime identity is valid only through independently verified measurement and live session binding.

The ARM SHALL declare the hash domain of every component. The Wave 0.3 manifest amendment establishes that PRE_A09 manifest values match Git/index LF content, not raw Windows CRLF checkout bytes. Its domain remains insufficiently self-describing and the historical commit identifier discrepancy remains open; neither issue is silently converted into attestation.

## 5. Normative ARM contract

The future schema `urn:au-ucr:runtime:arm:1.0` SHALL:

- use UTF-8 JSON, reject BOM, duplicate keys, invalid Unicode, non-finite numbers, unknown critical extensions, and undeclared properties;
- require `schema`, `manifest_id`, `repository_id`, `commit_sha`, `issued_at`, `expires_at`, `supersedes`, `components`, `config_precedence`, `ambient_input_denylist`, `endpoint_policy`, `measurement_policy`, `attestation_policy`, `receipt_refs`, and `signatures`;
- bound strings to 1–512 Unicode scalar values, identifiers to approved URI/UUID formats, arrays to explicit maxima, and timestamps to UTC RFC 3339 with whole microseconds or less;
- require 64 lowercase hexadecimal characters for SHA-256 and 40 lowercase hexadecimal characters for Git SHA-1 only where legacy Git identity is explicitly allowed;
- require each component to declare purpose, source URI, hash algorithm, hash domain, raw digest, canonical digest when applicable, loader identity, and whether it is executable;
- prohibit `null` unless a field explicitly permits it; omission and null are never equivalent;
- permit extensions only beneath `extensions`, with reverse-DNS names and a `critical` flag; unknown critical extensions fail closed;
- define conditional requirements for local and remote models and for hardware and virtual platforms.

The published schema, not this prose, SHALL be machine-valid and digest-pinned before acceptance. This document defines its minimum contract; schema publication remains an acceptance prerequisite.

## 6. Trusted measurement component

The **Trusted Measurement Component** (`TMC`) SHALL be a separately measured supervisor outside the agent/model process. It SHALL:

1. run under a dedicated non-interactive identity;
2. possess the sole runtime-attestation signing interface;
3. obtain a verifier challenge before measurement;
4. open components with race-resistant/no-follow semantics and measure the exact handles later used to launch or load;
5. enforce ARM ownership, location, signature, and digest rules;
6. deny undeclared ambient inputs and observe the same loader output supplied to the runtime;
7. bind measurements to process creation identity and a non-exportable runtime key;
8. receive model-resolution evidence from the inference adapter;
9. maintain the evidence sequence and challenge channel; and
10. be unable to issue governance acceptance or execution release.

The runtime and agent cannot ask the TMC to sign arbitrary bytes. Its signing API SHALL accept only schema-valid evidence assembled from TMC-observed state. A TMC self-measurement alone is insufficient; verifier policy SHALL validate platform-rooted measurement and the approved TMC digest.

## 7. TPM and platform lifecycle profile

Production `TRUSTED_ACTIVE` requires a hardware-rooted profile approved for the selected platform:

- EK certificate chain validation to an approved manufacturer or enterprise endorsement root;
- AK creation under a non-exportable restricted signing template and proof of possession;
- enrollment binding device inventory, EK, AK, owner, platform class, firmware, and enrollment receipt;
- policy-owned PCR selection and expected-value sets, with event-log replay to the quote;
- approved firmware/boot update procedure that creates a new measurement-policy version;
- TPM clear/replacement workflow that revokes prior AK/runtime keys and requires fresh enrollment;
- vTPM use only where hypervisor identity, tenant, anti-cloning controls, and migration policy are independently attested;
- decommissioning with key destruction, revocation, inventory closure, and retained evidence.

Unknown EK provenance, unverifiable event log, unexpected PCR, stale policy, cloned vTPM suspicion, or lifecycle discontinuity denies admission. Software-only keys may produce diagnostic evidence but never `TRUSTED_ACTIVE`.

## 8. Endpoint and model identity

Endpoint identity SHALL be the versioned tuple:

`provider legal ID + tenant/account ID + service ID + region + protocol/version + DNS name + TLS certificate/SPKI or approved CA policy + approved proxy identities/order + model-identity authority + immutable model digest + request audience`

For each inference, the provider or a locally measured adapter SHALL sign a request-scoped statement containing request ID, tenant, region, immutable model digest, endpoint tuple digest, input commitment, response commitment, nonce, issue/expiry time, and audience.

DNS resolution, a valid public certificate, a model tag, or a provider response alone is insufficient. Certificate rotation is allowed only under a pre-authorized pin set or CA policy version in the ARM. Proxy, tenant, account, region, model, or authority change requires a new session. If a remote provider cannot supply request-scoped immutable model evidence, the model binding is `UNVERIFIABLE` and full trust is denied.

## 9. Active session binding protocol

1. The verifier issues a 256-bit random single-use nonce, audience, policy digest, channel-binding value, and expiry no more than 120 seconds ahead.
2. The TMC validates authority, ARM, trust store, revocation, platform policy, and time health.
3. The TMC measures the opened launcher, harness, modules, persona, overlay, schemas, policies, model artifact where local, and every configuration input.
4. The approved loader emits the exact parsed-byte digests and effective configuration digest from the values supplied to the runtime.
5. The TMC creates/unseals a non-exportable per-session key bound to approved platform measurements.
6. The TMC launches and binds process ID plus creation time, boot ID, runtime instance ID, session ID, ARM digest, loaded-module set, endpoint tuple, and immutable model digest.
7. The TMC signs producer launch evidence over the verifier nonce and channel binding.
8. The verifier independently validates all evidence and records a verdict receipt.
9. Governed work begins only after verdict `TRUSTED_ACTIVE`.

Any process restart creates a new runtime instance, key, challenge, session, and verdict. Session IDs and nonces cannot be reused.

## 10. Continuous integrity and liveness

The verifier SHALL issue an unpredictable liveness challenge at least every 60 seconds. The TMC response SHALL arrive within 30 seconds and include the challenge, channel binding, prior accepted evidence digest, strictly increasing sequence, monotonic counter, current process and boot identity, ARM/effective-config/module/model/endpoint digests, and security flags.

Verifier receipt time, not producer time, controls freshness. Two missed challenges, a channel change, buffered/out-of-order response, sequence fork, counter rollback, process restart, measurement change, fallback, debugger/injection condition, revocation, or verifier disconnect moves the session to `SUSPENDED`.

Every governed inference receipt SHALL bind request and output commitments to the accepted launch evidence and nearest accepted liveness response. Agent-generated hashes may be stored as untrusted supplementary claims but never replace TMC evidence or verifier receipt.

## 11. Separated state machines

### 11.1 Producer evidence state

| State | Legal next state | Trigger |
| --- | --- | --- |
| `UNINITIALIZED` | `MEASURING`, `FAILED` | valid challenge or local failure |
| `MEASURING` | `EVIDENCE_ISSUED`, `FAILED` | complete signed evidence or any failure |
| `EVIDENCE_ISSUED` | `RESPONDING`, `ENDED` | verifier challenge or process end |
| `RESPONDING` | `EVIDENCE_ISSUED`, `FAILED`, `ENDED` | response accepted locally, failure, or end |
| `FAILED` | `ENDED` | evidence preserved; no recovery in same session |
| `ENDED` | none | terminal |

### 11.2 Verifier verdict state

| State | Legal next state | Trigger |
| --- | --- | --- |
| `NOT_EVALUATED` | `TRUSTED_ACTIVE`, `UNTRUSTED` | complete evaluation |
| `TRUSTED_ACTIVE` | `SUSPENDED`, `REVOKED`, `ENDED` | liveness/integrity failure, revocation, or clean end |
| `UNTRUSTED` | none | terminal for candidate session |
| `SUSPENDED` | `REVOKED`, `ENDED` | adjudication or termination; no same-session reactivation |
| `REVOKED` | none | terminal |
| `ENDED` | none | terminal |

### 11.3 Runtime admission state

`BLOCKED -> ADMITTED` only on a current `TRUSTED_ACTIVE` verifier receipt. `ADMITTED -> BLOCKED` occurs immediately on any other verdict or stale evidence. No direct recovery edge exists; recovery creates a new session.

Precedence for simultaneous triggers is `REVOKED > SUSPENDED/UNTRUSTED > ENDED > TRUSTED_ACTIVE`. A restart always terminates the old session before evaluation of a new one.

## 12. Evidence framing and integrity

All signed objects SHALL use a registry-approved algorithm and key purpose. Initial proposed profile:

- ARM/release and A09 authority receipts: `ES256`, purpose-specific keys;
- runtime/TMC evidence: TPM-backed `ES256`;
- hash: SHA-256;
- canonical payload: RFC 8785 JCS.

This reconciles Wave 0.3's conflicting ES256/Ed25519 proposals by selecting one provisional suite; enterprise cryptography approval remains open.

Signature input is:

`len32(domain) || domain || len64(payload_bytes) || payload_bytes`

where integers are unsigned big-endian, domain is an ASCII registry value, and payload bytes are JCS UTF-8. Hash-chain inputs use the same length framing. Omitted values do not serialize; permitted null values serialize as JSON `null`. Timestamps use UTC `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`.

Normative schemas SHALL separately define ARM, producer launch, liveness, inference, suspension/revocation, and verifier verdict receipts. Unknown schema versions, algorithms, key purposes, fields outside the extension policy, or framing ambiguity fail closed.

## 13. Trust-root governance and recovery

Trust roles SHALL be distinct: Root Custodian, Release/Receipt CA Operator, Device Enrollment Officer, Trust-Store Publisher, Revocation Officer, Independent Witness, and Verifier Operator. Effective assignments and conflict checks are mandatory.

- Root key generation and use require a documented offline ceremony, at least two of three custodians, and an independent witness.
- Private root material uses split control; no one actor can reconstruct or use it.
- Intermediate issuance, rollover, trust-store publication, and emergency revocation require two authorized approvers from different role classes.
- Trust-store updates are signed, versioned, monotonic, rollback-protected, distributed through two authenticated channels, and activated only after independent digest comparison.
- Suspected root compromise immediately suspends all affected trust, publishes emergency revocation through pre-established channels, rolls to a pre-authorized recovery root if valid, inventories affected evidence, and requires governance re-adjudication.
- Compromise backdating is explicit in a signed incident determination; prior evidence is preserved and marked, not deleted.

No such trust infrastructure was verified as existing.

## 14. Fail-closed provenance and recovery

Admission SHALL fail or an active session SHALL suspend on missing/ambiguous provenance, absent containing commit/publication receipt, hash-domain ambiguity affecting candidate identity, untrusted external source, stale or conflicting receipt, signature/revocation outage, unknown authority, or inability to determine the exact loaded bytes.

PRE_A09 evidence is historical context only. Amendment 1 withdraws the raw-CRLF mismatch blocker but does not make PRE_A09 evidence current, accepted, or runtime-attesting.

Recovery requires:

1. preserve evidence append-only;
2. revoke or suspend affected keys/manifests;
3. select a separately accepted rollback ARM;
4. create a new challenge, process, runtime key, and session;
5. obtain a new verifier verdict; and
6. retain governed work as blocked if no trusted rollback target exists.

## 15. Acceptance prerequisites and open items

Before acceptance, the exact candidate must have:

- published machine-valid schemas satisfying Sections 5 and 12;
- approved algorithm/key-purpose registry;
- selected platform profile and PCR/event-log policy;
- approved endpoint/provider evidence contract;
- named effective roles, trust ceremonies, revocation and recovery procedures;
- commit-addressed publication, independent QA, and digest-specific independent review;
- future negative and recovery tests (not authorized or run here);
- Decision Chair acceptance receipt; and
- only afterward, a separate execution-release receipt before implementation or operation.

Open items are: schema artifacts not yet published; cryptographic profile not enterprise-approved; platform/provider choices unset; trust infrastructure absent; containing-commit/publication linkage absent; formal assignments and receipts absent; historical commit discrepancy unresolved; and all implementation/testing evidence absent.

## 16. Disposition

The revised design disposition is:

`READY FOR ACCEPTANCE REVIEW -> NOT ACCEPTED -> NO IMPLEMENTATION -> NO TEST -> NO EXECUTION`

G1 remains `PENDING`, G2 remains `PENDING`, G3 remains `CLOSED`, G4 remains `NOT AUTHORIZED`, feature/treatment paths remain OFF, baseline StarNet remains authoritative, and PR merge remains blocked.
