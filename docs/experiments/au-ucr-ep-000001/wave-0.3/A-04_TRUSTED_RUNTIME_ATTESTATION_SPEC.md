# A-04 Trusted Runtime Attestation Specification

## 1. Control record

- **Artifact ID:** `A-04`
- **Title:** Trusted Runtime Attestation Specification
- **Experiment:** `AU-UCR-EP-000001`
- **Wave:** `0.3`
- **Transaction ID:** `AU-UCR-EP-000001-W0.3-A04`
- **Work request ID:** `AU-UCR-W03-A04`
- **Audit ID:** `AU-UCR-AUD-W03-A04-001`
- **Status:** `DESIGN_DRAFT`
- **Owner:** `Agent A`
- **Proposed independent reviewer:** `Agent D`
- **Repository branch inspected:** `cursor/populate-authority-readiness-7886`
- **Repository HEAD inspected:** `c0579a4e4d272162963de09bdec7494d822c1fe2`
- **Prepared:** `2026-10-11`
- **Acceptance receipt:** **None.** This artifact is not accepted, approved, certified, or an execution release.
- **Authorization boundary:** Documentation, read-only investigation, and design only. No runtime, test, account, key, ACL, network, VM, commit, or publication action was performed.

## 2. Purpose and decision rule

This specification defines how a verifier can determine that a particular live runtime session is using an authorized harness, process, model, persona, overlay, and configuration, rather than merely possessing a file whose hash matches a persona record.

The control is conservative:

> A persona hash proves only the bytes measured at a stated location and time. It does not prove which process loaded those bytes, which model received them, which configuration overrode them, whether a fallback occurred, or whether the runtime remained bound after launch.

An attestation verdict is `TRUSTED` only when all required launch and continuous evidence validates against an approved trust root and remains fresh. Missing, stale, revoked, ambiguous, unsigned, or conflicting evidence produces `UNTRUSTED` or `SUSPENDED`, never an inferred pass.

## 3. Epistemic separation

### 3.1 Verified existing controls and observations

The following were verified by direct read-only inspection or byte hashing. “Verified” here means observed in the cited artifact; it does not elevate the observation to runtime attestation.

1. `IMHOTEP_IDENTITY_VERIFICATION.md` records an E2-inspected persona hash and overlay hash, identifies `#DSRV_Kernel` as persona authority, and states RBAC paths. Its own SHA-256 is listed in section 16.
2. The readable external persona and overlay bytes at the AML repository paths hash to the same values recorded by the identity-verification document:
   - persona: `83129a97dfe3cde5c0bef7119804e282403644c0b78f5432b05636653d7d0b65`
   - overlay: `6461f1f774bb1eb02ec5aa02fd138999bb23138ab71a0ee423b282de99b5779a`
3. The persona identifies its owner as `#DSRV_Kernel`, defines A-code governance behavior, and declares read/write path intent. The overlay defines defaults and task-state rules.
4. AU-UCR evidence conventions require append-only history, explicit unknown/blocked/not-run values, commit-bound receipts, and independent review metadata.
5. AU-UCR governance separates publication, governance decision, and execution release; prohibits self-certification; and requires named, effective role assignments.
6. Current AU-UCR records remain unaccepted and blocked. The inspected authority evidence reports missing named assignments and no Decision Chair or execution-release receipt.
7. Historical PRE_A09 evidence observed a StarNet/Ollama session and a `llama3.1:8b` model digest, but explicitly records no A09 transition, no capability certification, and zero ingested AU artifacts.
8. `sidecar/runtimeinfo.js` constructs a prompt-visible runtime block containing app/harness labels, provider, requested model, agent ID, run ID, surface, and trigger.
9. Inspected runtime source selects model/provider from explicit run options, roster identity, or defaults; it marks a missing-roster fallback but allows the run to continue. These are useful transparency controls, not cryptographic attestation and not failure-closed identity enforcement.

### 3.2 Proposed controls

Everything in sections 4 through 15 is a proposed design unless explicitly repeated from section 3.1. No signing key, trust anchor, TPM-bound runtime key, approved attestation manifest, verifier service, continuous attestation supervisor, fail-closed admission gate, or attestation evidence store was verified as existing.

## 4. Identity model

Three identities are mandatory and must not be conflated.

### 4.1 Exact-byte identity

Exact-byte identity is `SHA-256` over the file bytes as read, with no newline, encoding, whitespace, path, or key-order normalization. It answers: “Are these bytes identical?”

Required exact-byte digests:

- persona file;
- overlay file;
- each effective configuration input;
- harness executable and all executable modules in the approved measurement set;
- launcher/supervisor;
- model artifact or provider-issued immutable model digest;
- policy and attestation-manifest bytes.

A path, filename, model tag, Git branch, or semantic version is metadata, not exact-byte identity.

### 4.2 Canonical identity

Canonical identity answers: “Are these inputs semantically the same under one approved normalization rule?”

For JSON, the loader must reject duplicate keys, invalid Unicode, non-finite numbers, and schema violations, then serialize using RFC 8785 JSON Canonicalization Scheme (JCS). The canonical digest is `SHA-256(JCS(parsed_value))`. YAML or environment input must first be converted by a versioned, deterministic schema mapping into the same canonical JSON domain; unsupported or ambiguous values fail.

The canonical configuration identity is the digest of a versioned manifest containing ordered component IDs, exact-byte digests, canonical digests, schema versions, override precedence, allowed values, and an explicit deny-list of ambient inputs. Canonical identity never replaces exact-byte evidence; both are retained.

### 4.3 Active-runtime binding

Active-runtime binding answers: “Did this session actually load and continue to use the approved identities?”

It binds:

`device + boot + launcher + harness process + executable modules + effective config + persona + overlay + model + provider endpoint + session + request`

The binding requires a non-exportable runtime key, launch measurements, process identity, loaded-config evidence from the same loader that supplies the runtime, model-resolution evidence from the inference adapter, verifier challenge freshness, and continuing signed heartbeats. Disk hashes or self-reported prompt text alone cannot satisfy this layer.

## 5. Trusted configuration source and authority

### 5.1 Proposed authoritative source

The sole runtime authority is an immutable, content-addressed **Approved Runtime Manifest** (`ARM`). A local directory, Desktop copy, environment variable, branch name, current working tree, or model alias is not authoritative.

The ARM must contain:

- manifest ID, schema version, issue/expiry times, and superseded manifest ID;
- experiment, wave, transaction, work request, and audit IDs;
- approved exact and canonical digests for persona, overlay, schemas, policy, harness, launcher, modules, and model;
- allowed provider and endpoint identities;
- deterministic configuration precedence and allowed overrides;
- minimum attestation protocol and verifier versions;
- key IDs, certificate policy OIDs, and revocation endpoints or signed offline revocation set;
- heartbeat interval, maximum evidence age, retention class, and rollback target;
- governance decision receipt, independent-review receipt, and execution-release receipt references.

### 5.2 Authority chain

The ARM becomes usable only after:

1. a named configuration owner prepares it;
2. an independently assigned reviewer validates its contents and conflicts;
3. the Decision Chair issues a commit- and digest-specific `ACCEPTED` receipt;
4. the Coordinator/Architect issues a separate execution-release receipt; and
5. a release-signing authority signs the exact ARM bytes.

The runtime must pin the approved ARM digest. A newer file at the same path does not supersede it automatically. Authority follows signed content and receipts, not location.

## 6. Runtime and session identity

Each launch receives:

- `runtime_instance_id`: UUIDv7 generated by the attestation supervisor;
- `session_id`: UUIDv7 generated after launch admission;
- `boot_id`: platform boot identifier plus TPM quote context;
- `process_id` and OS process creation time;
- `runtime_key_id`: thumbprint of the non-exportable session/runtime attestation public key;
- `arm_digest`;
- `harness_measurement_digest`;
- `effective_config_digest`;
- persona and overlay exact/canonical digests;
- immutable model digest and provider/endpoint identity;
- monotonically increasing `evidence_sequence`;
- `audience` identifying the intended verifier.

PID, UUID, user name, hostname, and model tag are correlators only. They become trusted only inside valid signed evidence.

## 7. Launch-time binding protocol

1. **Challenge:** The verifier issues a 256-bit cryptographically random nonce, audience, policy ID, and expiry not more than 120 seconds in the future.
2. **Manifest validation:** The supervisor verifies ARM signature, governance references, time validity, algorithm policy, and revocation state.
3. **Pre-launch measurement:** The supervisor opens components with no-follow semantics, validates file identity/ownership and approved roots, hashes the exact opened bytes, canonicalizes structured inputs, and denies unlisted ambient configuration.
4. **Key establishment:** A TPM-backed, non-exportable runtime key is created or unsealed only when approved platform measurements and supervisor policy hold. Software-only keys cannot produce `TRUSTED` for production.
5. **Process launch:** The supervisor launches the measured harness through inherited handles or an equivalent race-resistant mechanism, records process creation identity, and denies debugger/injection conditions outside policy.
6. **Loader proof:** The instrumented loader returns digests of the exact bytes it parsed and the fully resolved effective configuration. The supervisor compares these to pre-launch measurements and the ARM.
7. **Model binding:** The inference adapter resolves the model tag to an immutable content digest. For a local model, it measures the loaded artifact and process association. For a remote model, it requires provider-signed model identity evidence scoped to the request; absent such evidence, model binding is `UNVERIFIABLE`.
8. **Launch evidence:** The runtime signs the complete launch payload including challenge, all measurements, process/session identity, and verifier audience.
9. **Admission:** The verifier independently validates section 12. Only then may the session enter `ATTESTED_ACTIVE`.

Any failure terminates or quarantines the candidate before governed work is accepted.

## 8. Continuous binding

- The runtime emits a signed heartbeat at least every 60 seconds; verifier freshness is at most 120 seconds.
- Every heartbeat includes prior-evidence digest, sequence, session/process identity, current ARM and effective-config digests, loaded-module set digest, resolved model digest, policy state, and health flags.
- The supervisor watches process exit/restart, executable or configuration replacement, loaded-module changes, debugger/injection state, model/provider fallback, endpoint change, key state, clock anomaly, and revocation updates.
- Each inference receipt binds request ID, input digest or privacy-preserving commitment, output digest, model digest, effective persona/config digest, launch-evidence digest, nearest heartbeat digest, and sequence.
- A model, provider, persona, overlay, module, endpoint, or effective-config change requires a new session and launch attestation. It cannot be absorbed by a heartbeat.
- Missing two heartbeat deadlines, loss of supervisor contact, sequence discontinuity, or an unverifiable model response immediately changes the state to `SUSPENDED`.

## 9. Cryptographic evidence format

### 9.1 Envelope

Evidence is UTF-8 JSON with duplicate keys forbidden. The `payload` is canonicalized with RFC 8785 JCS and signed over:

`"AU-UCR-ATTEST-V1" || 0x00 || SHA-256(JCS(payload))`

Proposed envelope:

```json
{
  "schema": "au-ucr-attestation-envelope/v1",
  "payload": {
    "evidence_id": "EV-ATT-...",
    "evidence_type": "launch|heartbeat|inference|suspension|revocation",
    "experiment_id": "AU-UCR-EP-000001",
    "artifact_id": "A-04",
    "transaction_id": "AU-UCR-EP-000001-W0.3-A04",
    "work_request_id": "AU-UCR-W03-A04",
    "audit_id": "AU-UCR-AUD-W03-A04-001",
    "runtime_instance_id": "...",
    "session_id": "...",
    "boot_id": "...",
    "process": {"pid": 0, "created_at_utc": "...", "image_sha256": "..."},
    "identity": {
      "arm_sha256": "...",
      "harness_sha256": "...",
      "effective_config_sha256": "...",
      "persona_raw_sha256": "...",
      "persona_canonical_sha256": "...",
      "overlay_raw_sha256": "...",
      "overlay_canonical_sha256": "...",
      "model_content_sha256": "...",
      "provider_id": "...",
      "endpoint_identity_sha256": "..."
    },
    "freshness": {
      "nonce_b64u": "...",
      "audience": "...",
      "issued_at_utc": "...",
      "expires_at_utc": "...",
      "sequence": 1,
      "previous_evidence_sha256": null
    },
    "platform_quote": {"format": "TPM2_quote", "quote_b64u": "...", "event_log_sha256": "..."},
    "verdict_claimed": "MEASURED"
  },
  "signature": {
    "alg": "ES256",
    "kid": "...",
    "cert_chain_b64": ["..."],
    "value_b64u": "..."
  }
}
```

`verdict_claimed` is not a verifier verdict. The producer may claim only what it measured.

### 9.2 Algorithms and certificate profile

- Hash: SHA-256 minimum; algorithm agility is controlled by ARM policy.
- Signature: TPM-backed ECDSA P-256/SHA-256 (`ES256`) initially.
- Encoding: base64url without padding.
- Certificates must carry runtime-attestation purpose, device identity, issuer, validity, and revocation references.
- Unknown algorithms, critical fields, schema versions, or certificate policies fail closed.

## 10. Key custody and trust root

Proposed trust hierarchy:

1. **Offline AU-UCR Root CA:** held under dual control; signs only intermediates and revocation material.
2. **Release-signing intermediate:** signs approved ARM artifacts after governance and execution-release checks.
3. **Device-attestation intermediate:** enrolls TPM endorsement/attestation identities under documented proofing.
4. **Runtime attestation key:** generated and retained non-exportably in TPM/CNG, scoped to attestation use, device, policy, and approved measured state.

Private keys must never appear in source, environment variables, evidence, logs, or model context. Root operations require two authorized custodians, offline ceremony records, and an independent witness. Runtime key export, signature oracle access by the model, or use outside the supervisor is prohibited.

No existing key custody, CA, certificate policy, TPM enrollment, or trust root was verified.

## 11. Nonce, freshness, and replay controls

- Verifier nonces are 256 random bits, single-use, audience-bound, and expire within 120 seconds.
- The verifier stores `(kid, nonce, audience)` through expiry plus the maximum accepted clock-skew window.
- Launch evidence must arrive before challenge expiry and include the exact nonce.
- Sequences increase strictly within `(runtime_instance_id, session_id, kid)`.
- Evidence chains include the SHA-256 of the prior accepted envelope.
- Duplicate evidence IDs, nonces, sequence numbers, or conflicting payloads are rejected and logged as security events.
- UTC is used for audit display; freshness relies additionally on verifier receipt time and a TPM monotonic counter or equivalent rollback-resistant counter.
- Clock rollback, counter rollback, boot change, session reuse, or chain fork suspends the session.
- Offline verification may validate signatures and historical ordering but cannot assert current freshness or revocation state; its verdict must be `HISTORICALLY_VALID_SIGNATURE`, not `TRUSTED_ACTIVE`.

## 12. Verifier workflow

The verifier must:

1. parse with duplicate-key rejection and enforce the exact schema;
2. canonicalize the payload and verify domain-separated signature bytes;
3. build the certificate chain to the pinned AU-UCR root and check purpose, validity, policy, and revocation;
4. verify nonce, audience, expiry, sequence, previous digest, boot/session continuity, and replay-store uniqueness;
5. verify TPM quote, approved PCR policy, event-log consistency, and runtime-key binding;
6. fetch the ARM by digest, verify its release signature, and confirm its governance, independent-review, and execution-release references;
7. compare every harness/process/model/persona/overlay/config digest to ARM allow-lists;
8. require both exact-byte and canonical identities and reject unlisted overrides;
9. verify process creation and loader/model binding evidence;
10. check heartbeat age and all security flags;
11. correlate inference evidence to the accepted launch and heartbeat chain;
12. emit its own append-only verdict receipt: `TRUSTED`, `UNTRUSTED`, `SUSPENDED`, or `HISTORICALLY_VALID_SIGNATURE`, with reason codes and evidence digests.

The verifier must not trust producer-supplied verdict text, local paths, model tags, branch names, self-reported prompts, or successful inference output.

## 13. Failure-closed behavior

- Governed requests are admitted only in `ATTESTED_ACTIVE`.
- Unknown or missing evidence, trust roots, assignments, signatures, model digests, platform quotes, or review/release receipts block admission.
- Persona/config mismatch, fallback, override, process replacement, revocation, stale heartbeat, chain fork, or verifier outage suspends the session and stops new governed requests.
- In-flight output after suspension is marked `UNATTESTED` and cannot become evidence or drive a governance transition.
- Recovery requires a fresh challenge, new session, complete launch attestation, and explicit verifier acceptance.
- A transparency flag such as `identityFallback=true` is not sufficient. The observed current behavior that continues on fallback must be changed before acceptance of this design.

## 14. Evidence retention, rotation, revocation, and privacy

### 14.1 Retention

- ARM, governance/review/release receipts, launch evidence, verifier verdicts, revocations, suspension records, and evidence manifests: retain for the experiment lifetime plus seven years, or longer if policy requires.
- Heartbeats: retain complete records for one year, then cryptographically committed daily summaries through the primary retention period.
- Inference receipts: retain per data classification and experiment policy; store input/output digests or approved commitments rather than sensitive plaintext where possible.
- Evidence is append-only, content-addressed, access-logged, encrypted at rest, backed up, and periodically integrity-checked. Redaction creates a new linked record; it never overwrites historical evidence.

### 14.2 Rotation and revocation

- Release intermediates rotate at least annually; runtime keys rotate at each launch or at most every 24 hours.
- Rotation is overlap-safe: old and new public keys are simultaneously published for a bounded period, but each evidence item has one `kid`.
- Device compromise, key export suspicion, unauthorized signature, manifest error, role revocation, or platform-integrity failure triggers immediate signed revocation.
- Verifiers consume online revocation status when available and a signed, maximum-age-bounded offline revocation set otherwise. Stale revocation state fails closed for current trust.
- Revocation never deletes prior evidence; it records effective time and reason and can invalidate trust from an explicitly adjudicated earlier time.

## 15. Threat and bypass analysis

- **Copy approved persona onto an unapproved runtime:** defeated by process, harness, config, model, session, and TPM binding.
- **Hash a file but load different bytes (TOCTOU):** mitigated by handle-based launch/loading and loader proof; unresolved platform races fail admission.
- **Use semantically altered JSON with a convenient raw hash reference:** both raw and JCS canonical digests are required; duplicate keys are rejected.
- **Override persona/config through environment, CLI, registry, or roster:** only ARM-listed inputs and precedence are allowed; ambient or unlisted inputs block.
- **Model tag drift or provider fallback:** immutable model digest and endpoint identity are mandatory; fallback creates a new session or blocks.
- **Replay old valid evidence:** verifier nonce, audience, expiry, sequence, chain digest, boot ID, monotonic counter, and replay ledger are checked.
- **Forge evidence with a copied software key:** production trust requires a non-exportable TPM key and quote bound to measured state.
- **Compromised harness signs false measurements:** platform measurement reduces but does not eliminate this risk; independent builds, reproducible artifacts, code review, and hardened supervisor are dependencies.
- **Compromised verifier or root:** dual control, offline root, separation of duties, transparency log, and cross-review reduce impact; compromise remains catastrophic.
- **Remote provider misreports model:** without provider-signed immutable model evidence, end-to-end model identity remains unverifiable and the session cannot receive full `TRUSTED`.
- **Prompt injection alters self-report:** producer statements and model output are never trust inputs.
- **Stolen valid session after launch:** short freshness windows, channel binding, process checks, sequence enforcement, and immediate suspension limit but do not eliminate abuse.
- **OS/kernel or privileged attacker tampers after quote:** continuous monitoring cannot fully defeat a compromised kernel; confidential-computing/remote-attestation support may be required for higher assurance.

### Residual risks and limitations

This design cannot prove model semantics, absence of hidden provider changes, safety, correctness, or capability certification. Hashes identify artifacts, not behavior. TPM evidence attests measured platform state, not the absence of all runtime exploitation. Remote inference can be strongly bound only if the provider supplies independently verifiable request-scoped identity evidence. Privacy-preserving input/output commitments may prove integrity without proving content quality. Availability is intentionally sacrificed when evidence is incomplete.

## 16. Evidence references measured during design

All hashes below are SHA-256 over exact local file bytes measured on `2026-10-11`. A hash establishes byte identity only; it does not establish source authority or active use.

- `C:\Users\hakee\StarNet\docs\gates\IMHOTEP_IDENTITY_VERIFICATION.md`  
  `21d086c04391880efe1c88153a1ad728066b97bd036c004c91ef1f1a4ed367c9`
- `C:\Users\hakee\Desktop\AML-labeler-fix\ops\personas\imhotep\imhotep.persona.json`  
  `83129a97dfe3cde5c0bef7119804e282403644c0b78f5432b05636653d7d0b65`
- `C:\Users\hakee\Desktop\AML-labeler-fix\ops\personas\imhotep\overlay.json`  
  `6461f1f774bb1eb02ec5aa02fd138999bb23138ab71a0ee423b282de99b5779a`
- `C:\Users\hakee\Desktop\AML-labeler-fix\ops\personas\imhotep\task-object.schema.json`  
  `7c076b1c4b195d9c2c72754968cdd5142ec160cbea0ef547fb1882ff3f2c78e6`
- `C:\Users\hakee\.cursor\starnet-ucr-publish-2\docs\experiments\au-ucr-ep-000001\S0_EVIDENCE_CONVENTIONS.md`  
  `e3364a149bb8137771959321ebbd68dacaeb579652283b81fd43c4f447d8627e`
- `C:\Users\hakee\.cursor\starnet-ucr-publish-2\docs\experiments\au-ucr-ep-000001\S0_RECEIPT_SCHEMA.json`  
  `8086d483a3956709af27cbc6a73a9f078c4ce9f457df2890e3d6015a9dc80cc3`
- `C:\Users\hakee\.cursor\starnet-ucr-publish-2\docs\experiments\au-ucr-ep-000001\AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md`  
  `afc9d17f9cf6b93727b33c297cbde0999e5c2d35348a5d9ed723570bd393b6ac`
- `C:\Users\hakee\.cursor\starnet-ucr-publish-2\qa\evidence\au-ucr-ep-000001-s0\star-wr-0001\EV-INF-PRE-A09-AUTHORITY-NAMES-00.json`  
  `aef3c4146bbd978a7c4eb2b5798776351e2728d450dd9556404fd8facaa611ef`
- `C:\Users\hakee\.cursor\starnet-ucr-publish-2\qa\evidence\au-ucr-ep-000001-s0\star-wr-0001\EV-INF-PRE-A09-LOCAL-BRIDGE-00.json`  
  `100c4c174df2cf0fc41f4502410eebd3ca32631e6c7a77a36d422c135ca70f28`
- `C:\Users\hakee\.cursor\starnet-ucr-publish-2\sidecar\runtimeinfo.js`  
  `91879f56ba98df89326b82f00d8656a799c69cecbceef32ecd1af9478257889d`

The historical identity-verification record uses a redacted private source path. The matching AML persona/overlay hashes support byte equivalence, but neither that local path nor the E2 record proves that the AML copy is the current canonical source or that any runtime loaded it.

## 17. Acceptance criteria

A-04 may advance from `DESIGN_DRAFT` only when all criteria below have evidence:

1. Agent D has a valid named Independent Reviewer assignment and records a digest-specific review with no unresolved material contradiction.
2. All required AU-UCR role assignments are named, acknowledged, effective, independent, and conflict-checked.
3. A versioned ARM schema, attestation-envelope schema, verifier policy, and reason-code registry are approved.
4. Persona, overlay, schemas, harness, launcher, modules, effective configuration, and model are represented by exact and canonical identities as applicable.
5. A release-signing authority and independently governed trust root exist with documented custody, dual control, rotation, recovery, and revocation ceremonies.
6. Runtime keys are demonstrated non-exportable and TPM-bound; software-key evidence cannot receive production trust.
7. Launch protocol binds verifier nonce, device/boot, process, harness, loaded modules, effective config, persona, overlay, immutable model, endpoint, and session.
8. Continuous heartbeats, sequence/chain validation, inference correlation, fallback detection, and revocation checking operate within specified freshness bounds.
9. Negative tests demonstrate rejection of altered bytes, canonical mismatch, duplicate JSON keys, stale/replayed nonce, wrong audience, sequence fork, expired/revoked key, changed model/endpoint, roster fallback, config override, process replacement, and missing heartbeat.
10. Verifier and runtime fail closed during evidence-store, revocation, trust-root, supervisor, and provider-identity outages.
11. Evidence retention, append-only integrity, privacy classification, backup, and restoration are independently verified.
12. Rollback to the prior approved manifest and suspension of active sessions are demonstrated without loss or overwrite of evidence.
13. Threat-model findings are resolved or explicitly accepted by the authorized Decision Chair.
14. A separate digest-specific governance `ACCEPTED` receipt and subsequent execution-release receipt exist.

No criterion is satisfied by this design document alone.

## 18. Rollback and suspension

The default state is `BLOCKED`. The last accepted ARM, if one exists, is the rollback target.

On mismatch, revocation, key compromise, material contradiction, stale evidence, unexpected fallback, or verifier uncertainty:

1. stop admitting governed requests;
2. mark all affected sessions `SUSPENDED`;
3. emit signed suspension and escalation evidence where signing remains trustworthy;
4. preserve in-flight and prior evidence without alteration;
5. revoke affected keys/manifests when warranted;
6. direct traffic only to a separately attested prior ARM, never by silently changing the current session;
7. require a new publication, independent review, governance decision, execution release, challenge, and launch attestation before resumption.

If safe rollback cannot be attested, remain blocked. Suspension is not deletion, acceptance, or evidence of compromise by itself.

## 19. Dependencies

- named AU-UCR authority and reviewer assignments under `AU-UCR-GOV-001`;
- approved canonical source registry and ARM governance workflow;
- deterministic persona/overlay/config schemas and JCS implementation;
- reproducible harness and model artifact measurement;
- race-resistant launcher and instrumented loader/inference adapter;
- TPM 2.0/CNG enrollment and platform quote verification;
- offline root, intermediates, certificate policy, transparency, and revocation services;
- nonce/replay ledger and append-only evidence store;
- trusted time and rollback-resistant counter;
- provider support for immutable, request-scoped model identity, or a local measured model path;
- independent security review, negative test plan, rollback exercise, and retention/privacy approval.

## 20. Blockers

1. No acceptance receipt, independent-review receipt, or execution-release receipt exists for A-04.
2. Existing AU-UCR evidence reports required roles as unnamed/unassigned; proposed reviewer Agent D is not a verified effective assignment.
3. No trusted configuration registry or signed ARM exists.
4. No signing keys, CA hierarchy, TPM enrollment, key-custody procedure, revocation service, or trust root was verified.
5. No cryptographic launch or continuous runtime attestation control was verified.
6. No evidence binds the readable IMHOTEP persona/overlay bytes to the current harness process, model, or session.
7. The repository does not contain the inspected IMHOTEP persona/overlay records; the readable copies are external local artifacts whose authority and active use are unproven.
8. Prompt-visible runtime metadata is unsigned and self-reported to the model; it is not verifier evidence.
9. Inspected runtime logic permits explicit model/provider selection and continued execution on a marked roster fallback, which is incompatible with this specification's fail-closed rule.
10. Historical local-bridge evidence is PRE_A09, tied to another historical commit/session, records zero AU artifact ingestion, and explicitly does not certify capability or authorize transition.
11. Remote-provider immutable model identity and request-scoped provider attestation are not established.
12. No scripts or tests were executed under this work authorization; all implementation and acceptance criteria remain untested.

## 21. Required next governance action

Keep status `DESIGN_DRAFT` and execution `BLOCKED`. Obtain valid named assignments, then have Agent D independently review this exact artifact digest. Any revision changes the digest and requires a new review. Review does not itself constitute acceptance or execution release.
