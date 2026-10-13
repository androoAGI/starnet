# LAB-03 Revised Isolation Specification

## 1. Document control

- Artifact ID: `LAB-03-W04`
- Experiment: `AU-UCR-EP-000001`
- Wave: `0.4`
- Status: `DESIGN_DRAFT_REMEDIATION_NOT_ACCEPTED`
- Preparer label: LAB Agent; this label is not a governed appointment
- Repository: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Branch inspected: `cursor/populate-authority-readiness-7886`
- Exact baseline revision inspected: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Prepared: `2026-10-11`
- Authorization: documentation, read-only investigation, and design only
- Construction status: prohibited and not started
- Test status: `FUTURE / NOT RUN`
- Acceptance receipt: none

This specification revises the Wave 0.3 LAB-03 design in response to D-02 and GATE-03. It does not amend Wave 0.3, establish a governed role, select a platform, construct a sandbox, approve a test, or release execution. The historical D-02 review occurred when the Wave 0.3 files were untracked at revision `c0579a4e4d272162963de09bdec7494d822c1fe2`. The current baseline revision `39bade0506b4d5b12bb979ccf6a51bb11944a9ff` contains all nine Wave 0.3 files. This Wave 0.4 LAB draft remains untracked and is not commit-addressed.

## 2. Binding holds and non-claims

The following remain binding:

1. S0 remains `PUBLISHED_AWAITING_REVIEW`; readiness is blocked, acceptance is false, and S1 is closed.
2. Governed actors remain unassigned in the inspected records. `unassigned_role_only` grants no authority.
3. G1 and G2 remain `PENDING`; G3 remains `CLOSED`, not complete; G4 remains `NOT AUTHORIZED`.
4. `STARNET_UCR_ENABLE` remains OFF and non-authoritative.
5. Baseline failures remain evidence requiring disposition; they are not converted to passes.
6. No construction, account/key/ACL/network/service change, dependency installation, workload, boundary probe, negative test, acceptance test, commit, push, merge, or execution is authorized.
7. Review, acceptance, publication, and execution release remain separate events.
8. Evidence history is append-only. The D-02 and GATE-03 Amendment 1 correction is preserved: PRE_A09 manifest digests identify LF Git-blob content and are not invalid merely because Windows checkout bytes use CRLF. The unstated hash domain, absent `.gitattributes`, and historical commit-identity discrepancy remain risks.

`C:\Users\hakee\Desktop\imhotep_forensic_test` is only an unverified historical path. Its existence, content, provenance, ACLs, isolation, deletion, and prior use are not established. It must never be treated as a sandbox or executed in place. A path listing, hash scan, or absence of matching hashes cannot prove non-interference, because it cannot establish complete object reachability, effective access, open handles, aliases, reparse targets, network effects, credentials, process interactions, or prior writes.

## 3. Evidence provenance register

The following register records this design session's read-only inputs. SHA-256 and byte counts refer to exact Windows working-tree bytes measured at `2026-10-11T22:41:02.3880176Z` by a PowerShell `Get-Item` and `Get-FileHash` collection under the LAB Agent preparer label. These measurements are contextual working-tree evidence, not signatures, independent verification, publication receipts, or proof that untracked files are contained in the baseline revision.

- Wave 0.3 LAB-03: `docs/experiments/au-ucr-ep-000001/wave-0.3/LAB-03_ISOLATED_EXECUTION_ENVIRONMENT_SPEC.md`; 32,071 bytes; SHA-256 `b9ba2f40db06921fc01368b00a838d59f5ab0d72f9867c0a39d2277c9f4c2361`; read as the superseded design basis.
- D-02: `docs/experiments/au-ucr-ep-000001/wave-0.3/D-02_INDEPENDENT_DESIGN_ASSURANCE_REPORT.md`; 25,418 bytes; SHA-256 `6a1ec6f35f2b66a87da0270a713b23c2e767a8784c7cbdf241ca278905b664d0`; read for objections, subject to Amendment 1.
- GATE-03: `docs/experiments/au-ucr-ep-000001/wave-0.3/GATE-03_CONSOLIDATED_DECISION_PACKAGE.md`; 21,828 bytes; SHA-256 `b7767c81e3093c7d031e432533805f415f8082d01c3970e8f91e66367ce2b31b`; read for holds and required revisions, subject to Amendment 1.
- Governance addendum: `docs/experiments/au-ucr-ep-000001/AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md`; 9,470 bytes; SHA-256 `afc9d17f9cf6b93727b33c297cbde0999e5c2d35348a5d9ed723570bd393b6ac`; commit applicability is governed by its own canonical S0 reference.
- Evidence conventions: `docs/experiments/au-ucr-ep-000001/S0_EVIDENCE_CONVENTIONS.md`; 1,330 bytes; SHA-256 `e3364a149bb8137771959321ebbd68dacaeb579652283b81fd43c4f447d8627e`.
- Readiness gate: `docs/experiments/au-ucr-ep-000001/S0_QA_READINESS_GATE.json`; 2,031 bytes; SHA-256 `c90125d89d05c74b3a3a287d316e2536cb5cb0abadba`; records `blocked`, `acceptance: false`.
- Lane register: `docs/experiments/au-ucr-ep-000001/S0_WORKTREE_LANE_REGISTER.yaml`; 1,447 bytes; SHA-256 `eaf4604648539caa981bb1e627459420dd912c68c3171edddb1ebc7e4d38b985`; records `proposed_not_accepted` and `unassigned_role_only`.
- D-02 and GATE-03 Amendment 1 were read from their exact Wave 0.3 paths. They correct only the CRLF/LF manifest objection and retain all other holds and objections.

Future observations used for acceptance must have a unique evidence ID, exact source object or path, collection method and tool version, stable collector identity, UTC and monotonic times, raw byte count, declared hash domain, digest algorithm and value, repository/commit applicability, handling history, redactions, limitations, and independent verifier disposition. Unknown or unavailable values must be explicit; they may not be inferred.

## 4. Threat model and security objective

The future lab must contain an assignment-scoped workload that may be buggy, malicious, escape-seeking, secret-seeking, resource-exhausting, or designed to exploit filesystem, process, credential, service, or network boundaries.

Protected assets include production and developer repositories; host and management planes; user profiles; credentials and signing keys; cloud metadata; other tenants; internal networks; evidence stores; fixture sources; baseline StarNet authority; and the integrity and chronology of receipts.

Adversary capabilities include arbitrary workload code, archive/path tricks, symlinks and reparse points, alternate path syntax, process spawning, resource exhaustion, DNS rebinding, redirect and proxy abuse, permitted-endpoint relay abuse, log flooding, clock manipulation, and attempts to retain persistence. Host, hypervisor, cloud, backup, EDR, firmware, and privileged administrators remain trusted dependencies and residual risks; their compromise is not solved by guest controls.

The security objective is preventive non-reachability: production assets and ambient authority must be absent or denied by controls outside workload control. Detection, path naming, post-run hashes, and cleanup are supplementary and cannot replace prevention.

Out of scope until separately approved are kernel or hypervisor exploitation, malware detonation, destructive storage, denial-of-service stress, credential dumping, public scanning, and tests against production, unrelated tenants, or real credentials.

## 5. Required reference architecture

The future environment must comprise:

1. An approved disposable compute boundary instantiated from a versioned, authenticated, immutable base.
2. One dedicated non-human execution identity per assignment and instance.
3. A normalized, content-addressed, read-only, no-execute fixture.
4. A separate disposable writable overlay with fixed resource quotas.
5. No production mount, host profile, credential store, agent store, host socket, raw disk, clipboard, shared folder, enhanced-session drive, device pass-through, or management channel exposed to the workload.
6. Network deny-all enforced outside the guest, with only explicitly authorized mediated destinations.
7. An external evidence collector whose prior records cannot be read, changed, or deleted by the workload.
8. An external watchdog, emergency isolation control, credential revoker, and teardown controller.
9. Re-creation from authenticated inputs after every run; contaminated writable state is never reused.

## 6. Platform decision and acceptance profiles

A platform ADR must select exactly one profile before construction. The ADR must identify the threat class, owners, administrative trust, enforcement primitives, unsupported controls, compensating controls, evidence sources, retention model, and residual-risk acceptance. Common criteria do not substitute for profile-specific evidence.

### 6.1 Dedicated virtual machine profile

Required controls are a distinct guest kernel, immutable base disk, disposable overlay, externally controlled virtual NIC, disabled clipboard/drive mapping/enhanced session/guest file services, no host sockets, virtual-device allowlist, and management-plane separation. Independent evidence must come from the hypervisor/control plane plus an inside-guest inventory correlated by instance ID. Snapshot trees, integration settings, virtual disks, NIC policy, and deletion/key-destruction records are mandatory evidence.

### 6.2 Dedicated physical host profile

Required controls are a separately administered asset, approved firmware/build baseline, segmented data and management networks, restricted physical and BMC access, removable-media denial, dedicated storage keys, and rebuild/sanitization procedures. Independent evidence must come from asset management, network enforcement, firmware/build attestation where approved, and media-sanitization custody. Reuse is prohibited until rebuild and sanitization are independently accepted.

### 6.3 Managed remote sandbox profile

Required controls are an approved tenant/account and region, assignment-scoped project, provider identity binding, deny-all VPC/service policy, no inherited managed identity, customer-controlled or approved disposable keys, provider audit logs, deletion semantics, backup/snapshot inventory, and incident/export controls. Evidence must bind provider, tenant/account, subscription/project, region, instance, policy, image, and key identifiers. Provider retention and administrator access are explicit residual risks.

### 6.4 Windows Sandbox or equivalent local ephemeral guest profile

Required controls are policy-verifiable disablement of networking unless specifically mediated, mapped folders, clipboard, printer/device redirection, protected-client integrations, and persistence. The host must be dedicated or approved for the threat class. If the platform cannot independently evidence configuration, export, collector separation, and teardown, this profile is ineligible.

### 6.5 Container-plus-outer-VM profile

A container alone is ineligible for hostile, escape, privilege, kernel, credential, or boundary tests. An approved outer VM is mandatory. Inside it, require rootless execution where supported, user namespaces, no-new-privileges, dropped capabilities, syscall and device restrictions, read-only image, no engine socket, bounded cgroups/job objects, and immutable image digest. Evidence must cover both outer VM and container layers; failure of either fails acceptance.

## 7. Identity, service, credential, and privilege isolation

- The execution identity is unique to assignment ID and instance ID, non-interactive by default, time-bounded, non-administrative, and never reused.
- It receives no local administrator, hypervisor, container-engine, backup, debugger, service-control, driver, scheduled-task, user-management, firewall, share, or repository-owner rights.
- Builder/platform administrator, operator, credential broker administrator, evidence custodian, fixture custodian, QA/Evidence Agent, Independent Reviewer, and authorization roles must be stably assigned and separated under `AU-UCR-GOV-001`.
- Unneeded services are absent or disabled. Required guest agents run under separate least-privilege service identities, expose no general command channel, and authenticate the control plane mutually.
- The environment starts with an empty credential namespace and scrubbed environment. Host SSO, SSH agents, Git helpers, browser profiles, cloud CLI state, keychains, managed identity inheritance, and metadata endpoints are denied.
- Any justified credential must be synthetic or non-production, assignment-scoped, action- and destination-bound, short-lived, non-refreshable past expiry, delivered only after preflight by an approved broker, and revoked on stop, breach, or teardown.
- Evidence records credential class, issuer, policy and lease IDs, issue/expiry/revocation times, and destination binding, never secret values.

## 8. Preventive filesystem and fixture controls

Production and candidate-production roots must not be attached through drive letters, volume GUIDs, shares, administrative shares, VSS snapshots, host folders, repository worktrees, backup views, or aliases. Final-object resolution must reject reparse, symlink, junction, mount-point, hard-link, alternate-stream, case-folding, namespace, and unsupported-filesystem ambiguity. Enforcement must be object/handle based where available and fail closed.

Fixture release is a one-way custodian process:

1. Record source custodian, exact source snapshot/commit/object set, classification, legal/retention constraints, and minimization rationale.
2. Export through staging inaccessible to the LAB identity.
3. Recursively inspect archives to an approved maximum depth, expanded-byte ratio, member count, path length, and total size; encrypted, malformed, nested beyond limit, device-like, sparse, or ambiguous archives are rejected.
4. Apply a positive file-type allowlist based on content detection, not extension alone. Executables, installers, drivers, shortcuts, scripts, macros, active documents, package hooks, startup files, and unsupported formats are rejected unless separately justified and transformed inert.
5. Remove credentials, tokens, keys, personal data not required, machine identifiers, live endpoints, mutable links, and production-only authorities.
6. Normalize paths, metadata, ownership, timestamps where policy requires, line endings only under a declared rule, and archive ordering deterministically. Every transformation has a rule ID, tool/version, input digest, output digest, and disposition.
7. Produce a software/material inventory and signed fixture provenance receipt identifying source, transformations, exceptions, scan policy/results, reviewer, declared hash domain, final digest, and no-execute/read-only mount requirements.
8. Independently verify the released bytes and mount controls. Writes occur only in the disposable overlay.

Malware scans and hashes are limited evidence: they do not prove safety, completeness, provenance, isolation, or non-interference.

## 9. Network and egress mediation

Initial state is no NIC or externally enforced deny-all. Inbound, east-west, local subnet, host-only, link-local, multicast/broadcast, arbitrary DNS, metadata, remote-shell, tunneling, and public paste/file-sharing access are denied.

Every egress grant must bind destination owner and tenant/account, exact service and API operation, FQDN and resolved address policy, protocol/port, TLS version and approved CA or pin policy, SNI/Host consistency, optional mTLS client identity, DNS resolver, redirects, proxy `CONNECT`, byte/rate/object limits, request and response content types, expiry, and business purpose.

An application-layer gateway outside workload control must prevent an allowed endpoint from becoming an arbitrary relay. It must reject open redirects, user-selected callback URLs, arbitrary URL fetch parameters, unapproved upload/download destinations, wildcard tenant routing, cross-tenant object IDs, generic storage buckets, encrypted tunnels, protocol upgrades, and content outside the allowlist. Request bodies and responses are constrained by schema, type, size, sensitivity, and operation. Secrets and fixture content are denied from egress unless a specific data-release authorization names the fields and destination.

Destination identity is a versioned tuple containing provider, service, tenant/account/project, region, endpoint, TLS/proxy chain policy, and API audience. DNS rebinding, IPv4/IPv6 variance, CDN expansion, certificate rotation, proxy termination, and redirects must re-evaluate the same policy. Network and gateway decision logs go to the external collector.

## 10. Trust architecture

No trust service is accepted merely by naming it. Before construction, one approved trust architecture must reconcile LAB evidence with A-04/B-03 algorithm and key-purpose governance.

- Root and intermediate trust keys have defined owners, generation evidence, approved algorithms, purpose separation, protected custody, quorum, rotation, revocation, compromise recovery, and independent witness.
- Base images, fixtures, workload packages, identity policy, network policy, collector configuration, broker policy, and teardown policy are digest-pinned and authenticated under purpose-specific keys.
- Preflight and teardown receipts use a versioned schema, canonical encoding, unique receipt ID, assignment/instance IDs, repository and object identity, declared hash domain, policy versions, previous state, outcome/reason codes, collector receipt time, nonce/counter, signer identity/key ID, revocation evidence, and signature.
- Collector records use versioned schemas, sequence numbers, source and instance identities, monotonic time, guest-reported time marked untrusted, authenticated collector receive time, event type, payload digest, and chain/anchor references.
- Time health binds control-plane time to an approved authenticated source and records source identity, offset, uncertainty, last synchronization, monotonic continuity, and failure state. Guest wall time alone is never authoritative.
- Credential-broker trust covers requester and workload attestation, audience, lease ID, scope, expiry, revocation status, issuance policy, and audit linkage.
- Unknown key status, stale revocation data, collector gaps, time-health failure, invalid signature, duplicate receipt ID, replay, or digest/hash-domain ambiguity is fail-closed.

Normative schemas and an algorithm/key-purpose registry are prerequisites, not supplied by this design.

## 11. Privileged administration lifecycle

Administrative actions use this lifecycle:

`REQUESTED -> SEPARATION_CHECKED -> QUORUM_APPROVED -> TIME_BOUND_ACTIVE -> COMPLETED -> REVIEW_PENDING -> REVIEWED`

Any state may move to `DENIED`, `EXPIRED`, `REVOKED`, or `INCIDENT_HOLD`; terminal states cannot be silently reopened.

Each request identifies exact action, target, reason, risk, commands/API operations, expected change, rollback, window, requester, operators, approvers, and evidence plan. The requester/operator cannot be the sole approver or reviewer. High-risk actions require an independent second approver. Sessions use named identities, phishing-resistant authentication where available, just-in-time privilege, command/API recording, immutable control-plane logs, and expiry enforced outside the session.

Break-glass requires a declared emergency class, narrowly scoped temporary privilege, two-person approval when technically possible, immediate alert to an independent channel, automatic expiry, credential rotation, evidence sealing, and mandatory post-use review. If dual approval is impossible during a life/safety emergency, the exception and reason are recorded and acceptance remains blocked pending independent disposition.

Unauthorized action, recording loss, scope expansion, expired privilege, or review rejection moves the environment to `INCIDENT_HOLD`.

## 12. Independent boundary verification

Verification is future work and may begin only under Section 15 authorization. It must be performed against synthetic canaries and approved harmless probes, never actual production paths or credentials.

Independent evidence must establish:

- exact instance, image, fixture, workload, identity, policy, collector, broker, gateway, and key versions;
- constrained `whoami`/token/groups and absence of host or elevated identity;
- expected mount/device/integration inventory from both control plane and guest;
- denied read/write/create/rename/delete/execute/link/alternate-path operations against synthetic denied canaries;
- read-only/no-execute fixture and quota-bound overlay;
- absence of ambient credentials, delegated identity, metadata access, management sockets, and prohibited services;
- network deny-all before allowlisting and exact application-layer behavior after an approved grant;
- external log ordering, trusted receive time, sequence completeness, signatures, and artifact hashes;
- resource controls, watchdog, emergency isolation, revocation, teardown, and clean recreation.

The builder/operator may supply evidence but cannot independently verify it. Any unexpected success, missing signal, ambiguous result, collector/time/signature failure, or mismatch is a stop and breach condition. No hash scan may be used as proof of non-interference.

## 13. Allowed evidence destinations and export

Evidence may go only to destinations named in the future authorization:

1. an approved external append-only/WORM collector for structured control and security events;
2. an approved quarantine store for untrusted artifacts, with no production mount and no automatic execution/indexing;
3. an approved in-repository evidence index containing only reviewed summaries, manifests, and receipts; and
4. an approved large-log store referenced by immutable identifier where repository limits require it.

Each destination must specify owner, tenant/account/region, data classes, write/read/delete roles, retention, legal hold, encryption keys, malware/content handling, redaction, and deletion policy. Export is one-way or mediated, type- and size-limited, schema-validated, scanned/quarantined, content-reviewed, and recorded in a custody manifest. The workload cannot browse prior evidence or choose destinations. Production repositories, personal directories, public sharing sites, arbitrary object stores, chat, email, and the historical forensic path are prohibited destinations.

## 14. Teardown, rollback, retention, and failure states

Lifecycle states are:

`PLANNED -> PREFLIGHT_PENDING -> PREFLIGHT_VERIFIED -> AUTHORIZED_READY -> RUNNING -> STOPPING -> EVIDENCE_SEALED -> TEARDOWN_PENDING -> TEARDOWN_VERIFYING -> DESTROYED_VERIFIED`

Exceptional states are `PREFLIGHT_FAILED`, `BREACH_HOLD`, `TEARDOWN_FAILED`, `PROVIDER_RETENTION_HOLD`, and `INCIDENT_HOLD`. Only `DESTROYED_VERIFIED` permits a new assignment, and only through fresh re-creation.

Normal teardown stops externally, seals evidence, revokes credentials and egress leases, detaches approved evidence, destroys instance/overlay/temporary snapshots, destroys unique disposable encryption keys, inventories provider backups/replicas, verifies resource absence, and independently reviews the teardown receipt.

If any resource, snapshot, backup, key, token, policy lease, route, log buffer, or copy cannot be proven destroyed:

- enter `TEARDOWN_FAILED` or `PROVIDER_RETENTION_HOLD`;
- quarantine identifiers and remaining material;
- deny reuse, new workload, and acceptance;
- preserve provider/control-plane evidence and open an incident/risk disposition;
- record retention location, controller, reason, access policy, encryption/key status, provider deletion schedule, and next verification time;
- resume only after independently verified deletion/crypto-erasure or explicit authorized residual-risk acceptance for non-sensitive synthetic material.

Provider deletion assertions are insufficient without the selected profile's proof. Crypto-erasure requires a unique assignment key, proof of key isolation, destruction receipt, replica/key-wrap coverage, and no surviving plaintext copy. Provider-mandated backup retention remains a residual risk until expiry and verification.

Rollback means destroy and recreate from the last separately accepted image, fixture, workload, and policies. It never means reattaching a contaminated overlay or snapshot.

## 15. Later controlled-test authorization

No verification or test may run until all of the following exist for the exact candidate:

1. effective governed role assignments and conflict checks;
2. accepted revised LAB design and selected platform ADR;
3. publication, independent QA, independent review, and Decision Chair receipts;
4. separate Coordinator/Architect construction release, followed by independently accepted construction/preflight evidence;
5. a test plan enumerating each synthetic case, expected result/reason code, target, maximum resources, duration, network/data allowance, evidence signal, abort condition, kill method, and cleanup;
6. security, platform, fixture/data, network, evidence, and incident-owner approvals appropriate to test class;
7. a distinct, time-bounded controlled-test authorization receipt identifying exact instance and all image/workload/fixture/policy/schema/key versions; and
8. an observer and external kill control.

The first authorization permits only harmless preflight against synthetic canaries. Negative tests require a later case-specific authorization. An unexpected success is a breach, not permission to continue. Acceptance of a technical test does not itself release UCR execution.

## 16. Acceptance rule

The companion `W04_LAB_ISOLATION_ACCEPTANCE_CHECKLIST.md` is normative for future evaluation. Every applicable item must be evidenced by the selected platform's enforcement primitive and an independent source. `PASS` requires complete evidence; `NOT_APPLICABLE` requires ADR rationale and reviewer approval; `UNKNOWN`, `NOT_RUN`, ambiguity, or missing evidence blocks acceptance.

The companion `W04_LAB_RESIDUAL_RISK_AND_REUSE_ASSESSMENT.md` must be completed for the exact candidate. No environment may be reused unless it reaches `DESTROYED_VERIFIED` and the next run is a fresh instantiation from accepted immutable inputs.

## 17. Current disposition

`DESIGN REMEDIATION PRODUCED -> NOT INDEPENDENTLY REVIEWED -> NOT ACCEPTED -> NO CONSTRUCTION -> NO TEST -> NO EXECUTION`

All controls remain proposed. Holds remain in force.
