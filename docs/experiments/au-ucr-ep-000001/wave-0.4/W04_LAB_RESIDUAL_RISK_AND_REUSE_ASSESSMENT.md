# Wave 0.4 LAB Residual Risk and Reuse Assessment

## 1. Control record

- Experiment: `AU-UCR-EP-000001`
- Wave: `0.4`
- Artifact: `W04-LAB-RESIDUAL-RISK-AND-REUSE`
- Status: `DESIGN_ASSESSMENT / NOT ACCEPTED`
- Repository context: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Branch: `cursor/populate-authority-readiness-7886`
- Exact baseline revision: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Governing design: `LAB-03_REVISED_ISOLATION_SPEC.md`
- Acceptance checklist: `W04_LAB_ISOLATION_ACCEPTANCE_CHECKLIST.md`
- Environment assessed: none constructed
- Current reuse decision: `PROHIBITED`

This document identifies risks that preventive controls cannot eliminate and defines when future components may be reused. It records no risk acceptance and grants no construction, testing, or execution authority.

## 2. Current assessment

There is no verified LAB environment, selected platform ADR, constrained identity, sanitized fixture, network boundary, trust service, evidence collector, broker, teardown receipt, or accepted control implementation. Therefore:

- environment reuse is not applicable and is prohibited;
- no historical directory or workspace is eligible for reuse;
- no fixture, image, snapshot, overlay, credential, key, policy lease, or provider resource is approved;
- `C:\Users\hakee\Desktop\imhotep_forensic_test` remains only an unverified historical path;
- no hash scan, directory comparison, clean Git status, or path absence can prove non-interference;
- all holds remain in force.

## 3. Risk-rating method

Future assessments must rate likelihood and impact as `LOW`, `MODERATE`, `HIGH`, or `CRITICAL`, state the basis and uncertainty, identify preventive/detective/recovery controls, name the risk owner and decision authority, bind the rating to an exact candidate, and record `OPEN`, `MITIGATED_NOT_ACCEPTED`, `ACCEPTED`, `TRANSFERRED`, or `AVOIDED`.

An authorized risk owner may accept residual operational uncertainty only within established authority. Risk acceptance cannot waive governance role assignment, safety prohibitions, legal/data constraints, independent review, gate prerequisites, or the need for a separate execution release.

## 4. Residual risks

### R-01 — Host, hypervisor, firmware, and physical administrator trust

Privileged administrators or compromised management planes may inspect memory, alter images/policies/clocks, inject devices, recover storage, or suppress evidence. Guest controls cannot eliminate this.

- Inherent rating: `CRITICAL`
- Required reduction: dedicated/approved host or tenant; restricted named administrators; quorum for high-risk changes; measured and authenticated inputs; independent control-plane logs and alerts; no production co-tenancy; session recording; patch and incident ownership.
- Residual disposition: `OPEN`. Hostile kernel/hypervisor testing requires a dedicated physical host or provider explicitly approved for that threat class.

### R-02 — Guest escape and shared-kernel exposure

Unknown vulnerabilities may cross guest or container boundaries. A container alone shares the host kernel.

- Inherent rating: `CRITICAL`
- Required reduction: separate guest kernel, patched minimal platform, disabled integrations/devices, outer VM for containers, external network/resource enforcement, prompt destruction.
- Residual disposition: `OPEN`. Container-only selection is prohibited for hostile or boundary tests.

### R-03 — Identity, broker, or trust-root compromise

Compromised signing, collector, time, identity, or broker keys can produce apparently valid policy or evidence, issue credentials, or suppress revocation.

- Inherent rating: `CRITICAL`
- Required reduction: purpose-separated keys, protected custody, quorum, independent witness, short leases, revocation checking, rollover and compromise recovery, append-only alerts, cross-source correlation.
- Residual disposition: `OPEN` until one shared approved trust architecture and normative schemas exist.

### R-04 — Evidence incompleteness or chronology error

Collectors can fail, buffers can drop, clocks can drift, schemas can be ambiguous, and administrators can alter records.

- Inherent rating: `HIGH`
- Required reduction: external append-only collector, sequence and monotonic counters, authenticated receive time, health telemetry, chain/anchor, duplicate/replay controls, declared hash domains, fail-closed acceptance.
- Residual disposition: `OPEN`. Missing or ambiguous evidence blocks acceptance; it is never converted to zero or pass.

### R-05 — Egress relay and destination-tenant confusion

An allowlisted endpoint may relay arbitrary URLs, accept uploads, redirect, route across tenants, or terminate TLS through an unexpected proxy.

- Inherent rating: `CRITICAL`
- Required reduction: destination owner/tenant tuple, operation and audience binding, application-layer schemas and content limits, redirect/rebinding/proxy checks, no wildcard tenants or generic buckets, independent flow and gateway logs.
- Residual disposition: `OPEN`. Network destination allowlisting alone is insufficient.

### R-06 — Fixture supply-chain and sanitization failure

Fixtures may contain secrets, personal data, active content, malicious archives, links, unsupported streams, live endpoints, or misleading provenance. Scanners have false negatives.

- Inherent rating: `CRITICAL`
- Required reduction: custodian-approved minimal source, one-way staging, archive limits, content-based file allowlist, active-content rejection, deterministic transforms, signed provenance, read-only/no-execute mount, independent verification.
- Residual disposition: `OPEN`. Hashes establish identity only; they do not establish safety or non-interference.

### R-07 — Filesystem alias and integration bypass

Volume paths, shares, reparse points, backup views, device integrations, clipboard, or management agents may expose denied host objects.

- Inherent rating: `CRITICAL`
- Required reduction: no host mounts/integrations, handle-based final-object controls, device allowlist, control-plane and guest inventories, synthetic canaries, fail-closed canonicalization.
- Residual disposition: `OPEN` until selected-platform enforcement is independently demonstrated.

### R-08 — Resource exhaustion and noisy-neighbor effects

CPU, memory, disk, process, I/O, network, or log exhaustion can affect host/provider services or destroy evidence.

- Inherent rating: `HIGH`
- Required reduction: external quotas/watchdog/deadline, dedicated capacity for high-risk cases, fail-closed OOM/disk/log behavior, bounded cases, provider rate controls.
- Residual disposition: `OPEN`; shared infrastructure contention cannot be eliminated.

### R-09 — Administrator misuse and break-glass abuse

Authorized privilege may be mis-scoped, retained, shared, or used outside the recorded session.

- Inherent rating: `CRITICAL`
- Required reduction: stable identities, just-in-time privilege, separation/quorum, exact action plan, recording, independent alert, expiry, rotation, post-use review, incident hold on deviation.
- Residual disposition: `OPEN`; collusion and control-plane compromise remain possible.

### R-10 — Teardown failure and provider-retained copies

Snapshots, backups, replicas, queues, logs, keys, delayed deletion, legal holds, or media reuse may retain assignment data after apparent teardown.

- Inherent rating: `CRITICAL` for sensitive data; `HIGH` for synthetic-only data
- Required reduction: resource inventory, unique disposable keys, replica/key-wrap coverage, provider deletion evidence, retention schedule, quarantine, re-verification, no reuse before `DESTROYED_VERIFIED`.
- Residual disposition: `OPEN`. Provider attestations and crypto-erasure depend on provider/control-plane trust.

### R-11 — Evidence export as an exfiltration path

Allowed artifacts may carry secrets, covert payloads, active content, excessive data, or malware into reviewer or production environments.

- Inherent rating: `HIGH`
- Required reduction: fixed destinations, one-way mediated export, schema/type/size/content policy, redaction, quarantine, no automatic execution/indexing, custody records, independent review.
- Residual disposition: `OPEN`; content review cannot eliminate all covert channels.

### R-12 — Stale, replayed, or wrong-candidate evidence

Valid receipts can be replayed against a different instance, policy, commit, tenant, or time window.

- Inherent rating: `CRITICAL`
- Required reduction: exact repository/object/commit and assignment/instance binding, unique receipt IDs, nonce/counter, expiry, canonical schema, revocation state, previous/next state, independent verification.
- Residual disposition: `OPEN` until normative schemas and trust services are accepted.

### R-13 — Hash-domain and provenance ambiguity

Raw checkout bytes and Git-blob bytes may differ by line endings. A manifest that omits its byte domain can produce false mismatch or false confidence. Historical commit identifiers may be unavailable or inconsistent.

- Inherent rating: `HIGH`
- Required reduction: declare exact byte domain and normalization, pin repository attributes/policy where approved, record object type and full commit, preserve raw and canonical digests when both matter, independently verify graph availability.
- Residual disposition: `OPEN`. D-02/GATE-03 Amendment 1 corrects the PRE_A09 CRLF/LF objection but does not remove the unstated-domain or historical commit-identity risks.

### R-14 — Governance or role-assignment failure

Preparer labels, repository access, or OS identities may be mistaken for effective authority; actors may self-certify or use stale assignments.

- Inherent rating: `CRITICAL`
- Required reduction: assignment evidence under `AU_UCR_GOV_001`, stable identities, effective times, acknowledgement, transitive conflict checks, receipt-specific authority verification.
- Residual disposition: `OPEN`. Current records remain unassigned and not accepted.

### R-15 — Historical workspace misclassification

An old directory may be mistaken for a sandbox, authoritative source, clean fixture, or evidence of prior isolation.

- Inherent rating: `HIGH`
- Required reduction: classify historical paths as untrusted; never execute in place; do not import without normal fixture provenance and sanitization; use an independently created disposable boundary.
- Residual disposition: `OPEN`. The named historical path is unverified and grants no inference.

## 5. Reuse classes

### 5.1 Never reusable

- Writable overlays, running or stopped workload instances, session credentials, bearer tokens, broker leases, temporary network grants, temporary snapshots, guest-generated signing keys, break-glass credentials, and unreviewed exported artifacts.
- Any component exposed during a breach, unexpected boundary success, evidence gap, time/signature failure, admin-scope violation, or teardown uncertainty.
- Any historical workspace as an execution environment.

These must be revoked, quarantined, destroyed, or retained only under incident/legal hold. They cannot return to service.

### 5.2 Reusable only as immutable, re-verified input

- Base images, toolchain images, normalized fixtures, workload packages, schema bundles, and policy templates.

Reuse requires an accepted immutable digest; trusted provenance/signature; no revocation; vulnerability and patch disposition within policy; exact platform compatibility; independent byte verification; and a fresh instance/overlay. A prior successful run is not sufficient.

Fixtures must also retain valid source authority, classification, minimization, sanitization rules, and retention. Any source, rule, tool, exception, or policy change creates a new fixture identity and review.

### 5.3 Rotatable shared trust services

- Collector service, time service, credential broker, gateway, schema registry, and trust store may persist as managed services only when their accepted configuration and keys are not exposed to workloads.

Before each assignment, verify service identity, health, tenant/region, policy version, key and revocation status, administrator roster, audit continuity, capacity, and prior-incident closure. Service compromise invalidates affected evidence and may require key rotation and re-review.

### 5.4 Reusable physical or provider capacity

Underlying hardware or provider capacity may be reused only after the prior assignment reaches `DESTROYED_VERIFIED`, all assignment resources and keys are gone or validly retained under hold, platform integrity is re-established, and the new assignment receives fresh identities, storage, overlays, policies, and leases.

The same VM instance, disk, overlay, snapshot, or account-scoped credential is never reused.

## 6. Reuse decision procedure

For each proposed component:

1. Identify component type, owner, provider/tenant/region, exact digest or resource ID, prior assignments, data class, and exposure history.
2. Confirm the prior environment reached `DESTROYED_VERIFIED`. If not, decision is `DENY`.
3. Confirm no breach, unexpected success, evidence gap, admin violation, revocation, unresolved vulnerability, or provider retention affects it. If affected, decision is `QUARANTINE` or `DENY`.
4. Apply the reuse class above. Ephemeral/runtime components are `DENY`.
5. For immutable inputs, independently verify bytes, signatures, revocation, provenance, patch/vulnerability disposition, and current policy compatibility.
6. For shared services or capacity, verify health, configuration, key status, audit continuity, administrator state, incident closure, and tenant isolation.
7. Record residual risks, compensating controls, expiry, approver, independent reviewer, and evidence references.
8. Issue one result: `APPROVE_IMMUTABLE_INPUT`, `APPROVE_SHARED_SERVICE`, `APPROVE_CAPACITY`, `QUARANTINE`, or `DENY`.
9. Even after approval, instantiate a fresh environment with new assignment/instance identity, overlay, credentials, leases, and authorization.

No component may be approved by the person who built, operated, or solely evidenced it.

## 7. Teardown-failure and retention assessment

A future assessment must answer:

- Are all instances, disks, overlays, snapshots, images derived during the run, temporary staging objects, network grants, identities, tokens, leases, queues, and log buffers inventoried?
- Which objects were destroyed, by what control-plane operation, at what UTC time, by whom, and with what independently observed result?
- Were unique data-encryption keys used? Are all key wraps, replicas, escrow copies, caches, and recovery paths included in destruction evidence?
- Does the provider retain backups, replicas, audit copies, crash dumps, support bundles, or media blocks? For how long, in which region/tenant, under whose access, and with which encryption?
- Is deletion immediate, asynchronous, crypto-erasure based, or policy/contract based?
- Did any delete operation fail, time out, return ambiguity, or omit a resource class?
- Is legal hold or incident quarantine active?
- When will retention expire, who must re-verify, and what evidence will close the hold?

Any adverse or unknown answer sets `TEARDOWN_FAILED` or `PROVIDER_RETENTION_HOLD`. Acceptance, capacity reuse, and new workloads remain blocked. If retained material contains anything beyond approved synthetic/non-sensitive data, residual-risk acceptance alone cannot authorize reuse.

## 8. Required future risk-acceptance receipt

A valid receipt must identify:

- unique receipt and assessment IDs;
- exact platform, provider, tenant/account/project, region, assignment, and instance;
- repository, full commit, artifact object types, declared hash domains, and digests;
- selected profile and exact image/fixture/workload/policy/schema/key versions;
- each open risk, rating, controls, evidence, uncertainty, owner, expiry, and decision;
- teardown state and every retained provider copy;
- proposed reuse components and decisions;
- assessor, independent reviewer, authorized risk owner, stable identities, role-assignment references, signatures, revocation status, UTC and monotonic context;
- explicit statement that risk acceptance is not governance acceptance or execution release.

## 9. Current residual-risk decision

- Overall risk: `UNASSESSED IMPLEMENTATION / CRITICAL UNCERTAINTY`
- Risk acceptance: `NONE`
- Reuse authorization: `NONE`
- Construction authorization: `NONE`
- Test authorization: `NONE`
- Execution release: `NONE`

Disposition:

`PRESERVE HOLDS -> COMPLETE GOVERNED DESIGN REVIEW -> SELECT PLATFORM -> AUTHORIZE CONSTRUCTION SEPARATELY -> VERIFY CONTROLS INDEPENDENTLY -> AUTHORIZE SYNTHETIC PREFLIGHT SEPARATELY -> ASSESS RESIDUAL RISK -> NO REUSE EXCEPT UNDER THIS PROCEDURE`
