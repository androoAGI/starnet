# LAB-03 Isolated Execution Environment Specification

## Document control

- Artifact ID: `LAB-03`
- Program: Agent University / IMHOTEP
- Wave: `0.3`
- Status: `DESIGN_DRAFT`
- Owner: LAB Agent
- Proposed reviewer: Agent D
- Acceptance receipt: none
- Authorization used: documentation, read-only investigation, and design only
- Prepared: 2026-10-11
- Construction status: prohibited and not started
- Test status: `FUTURE / NOT RUN`

This document is a design specification, not an authorization to construct, configure, start, or test an execution environment. It creates no identity, ACL, VM, container, network rule, credential, acceptance result, or execution release.

## 1. Purpose and boundary statement

LAB-03 specifies a future environment in which untrusted or negative-test workloads could be executed without granting write access to production material or ambient credentials. The design requires an independently enforceable compute, identity, filesystem, credential, network, process, evidence, and reset boundary.

`C:\Users\hakee\Desktop\imhotep_forensic_test` is classified as a **historical workspace name only**, not an isolation boundary. A directory path, worktree, ownership label, hidden attribute, or conventional name cannot establish containment. Even if that historical directory is later recovered, it must be treated as untrusted source material and must not be executed in place.

## 2. Mandatory holds

The following holds remain binding and are not relaxed by this specification:

1. S0 acceptance is not recorded; S1 and downstream UCR execution remain closed.
2. Stable governed actors for Coordinator/Architect, QA/Evidence Agent, Independent Reviewer, and Decision Chair remain unassigned in the reviewed records.
3. `unassigned_role_only` authorizes no lane action.
4. Rubric definitions and thresholds remain pending; `frozen` is `false`.
5. A measurement or threshold pass is not acceptance. `Done` is not `Accepted`.
6. No UCR-001 execution release is recorded.
7. Existing baseline failures/environment mismatches require owner/reviewer disposition and may not be rewritten as passes.
8. Historical recovery evidence and current branch content are not interchangeable where commit identities differ.
9. `STARNET_UCR_ENABLE` must remain OFF and non-authoritative.
10. Construction, configuration, workload execution, negative testing, acceptance testing, and boundary probing are explicitly prohibited until all required approvals in Section 16 are recorded.

## 3. Observation method and evidence classification

### 3.1 VERIFIED observations

The following observations were obtained using path existence, directory metadata, ACL-owner metadata, Git branch/status metadata, and relevant tracked documentation only. No workload, test, script, credential access, content scan outside the architectural scope, ACL change, or network change was performed.

- The active Git branch was `cursor/populate-authority-readiness-7886`.
- The requested historical path `C:\Users\hakee\Desktop\imhotep_forensic_test` did not exist at inspection time. Therefore no child structure, ACL, contents, provenance, or prior isolation properties were verified.
- The current documentation workspace existed at `C:\Users\hakee\.cursor\starnet-ucr-publish-2`. Its directory owner was reported as `BUILTIN\Administrators`, ACL inheritance was not protected, and directory timestamps were visible. These facts do not prove it is production, safe, immutable, or isolated.
- Other StarNet-named directories were visible under `C:\Users\hakee\.cursor`: `starnet-feat-harness-backend`, `starnet-ucr-publish`, and `tmp-starnet-publication-check`. Only safe metadata was inspected. Their names do not establish authority, role, currency, production status, or isolation.
- Tracked project records identify `feat/harness-backend` as a baseline authority branch and identify the current workspace as a StarNet clone. They also record that repository isolation must be preserved and that a historical AML repository-selection defect occurred.
- Existing records state that S0 is not accepted, roles remain unassigned, the rubric is not frozen, UCR-001 is not execution-released, and S1 has not started.

### 3.2 UNKNOWN or NOT VERIFIED

- Which host or branch is the authoritative production runtime at the time of future construction.
- Whether the historical workspace was deleted, moved, renamed, redirected, or never created on this host.
- Effective ACLs below any candidate root, inherited deny/allow interactions, junctions, symlinks, reparse points, alternate data streams, open handles, service identities, scheduled tasks, or network shares.
- Hypervisor availability, Windows edition capabilities, virtualization-based security state, firmware virtualization state, nested virtualization support, or reboot requirements.
- Whether candidate fixture data contains secrets, personal data, executable hooks, malicious archives, or production-only identifiers.
- Whether local administrators, host services, endpoint tooling, backup tooling, or hypervisor administrators can observe or alter a future guest.

### 3.3 PROPOSED controls

Every control in Sections 4 through 18 is proposed unless explicitly labeled VERIFIED. Nothing in this draft has been implemented or tested.

## 4. Platform options and selection criteria

No platform is selected because capability, policy, licensing, threat model, administrative support, and acceptance evidence are not yet available.

### Option A: Dedicated disposable virtual machine

Potential technologies include Hyper-V, an organization-approved VDI/VM platform, or an equivalent managed hypervisor.

- Strengths: distinct guest kernel; explicit virtual disk and NIC boundaries; snapshots/checkpoints; clearer process and resource isolation than a host directory.
- Limits: host/hypervisor administrators remain trusted; shared clipboard, drive mapping, enhanced session, guest services, and host integrations can bypass the intended boundary if enabled.
- Selection evidence required: approved hypervisor, measured host capability, secure-boot/vTPM policy if required, approved base-image provenance, patch state, disabled integration matrix, and documented snapshot/reset semantics.

### Option B: Dedicated physical host

- Strengths: strongest separation from a developer workstation when separately administered, cabled, and network-segmented.
- Limits: higher cost and operational burden; firmware/BMC, removable media, management plane, and administrator trust remain.
- Selection evidence required: asset ownership, approved build standard, management-network controls, disk sanitization method, physical access controls, and rebuild SLA.

### Option C: Managed remote sandbox or ephemeral compute service

- Strengths: disposable instances, policy-driven identity and egress, centralized audit, and potentially hardware-backed isolation.
- Limits: provider administrators and control plane become trusted; tenant configuration mistakes, artifact export paths, and billing/availability dependencies remain.
- Selection evidence required: data classification approval, region/residency approval, tenant isolation documentation, log custody, deletion guarantees, egress controls, and provider incident process.

### Option D: Windows Sandbox or equivalent local ephemeral guest

- Strengths: short-lived guest and simple reset.
- Limits: configuration, persistence, networking, telemetry, and evidence-export behavior may be insufficient for governed repeatability; host trust remains.
- Selection evidence required: feature availability, policy support, base-image provenance, networking disablement/allowlisting capability, evidence export design, and verified teardown behavior.

### Option E: Container

- Strengths: low startup cost and reproducible packaging.
- Limits: shared host kernel and frequent ambient host integrations make a container insufficient by default for hostile or escape-oriented negative tests.
- Selection evidence required: explicit threat-model approval for shared-kernel risk, rootless/user-namespace enforcement, seccomp/job-object equivalent, capability removal, immutable image, no host socket, and an independently enforced outer VM boundary.

### Selection gate

A future architecture decision record must compare the options against: adversary strength; kernel separation; identity isolation; filesystem and device isolation; deny-by-default networking; fixture import/export; deterministic reset; evidence integrity; host/admin trust; negative-test scope; cost; licensing; operational ownership; accessibility; recovery time; required reboot; and reviewability. A container-only design must not be selected for code intended to probe sandbox, privilege, kernel, credential, or network boundaries.

## 5. Proposed reference architecture

The platform-neutral target is:

1. An approved, disposable compute boundary with a separately administered base image.
2. A dedicated constrained runtime identity unique to one assignment and not reusable for interactive administration.
3. A read-only fixture disk derived from an approved production snapshot through a controlled export and sanitization process.
4. A separate disposable writable overlay for outputs and temporary state.
5. No production mounts, host home directories, Git credential stores, agent stores, Docker/Podman sockets, named pipes, clipboard, device pass-through, shared folders, or host SSH/WinRM channels.
6. A deny-by-default network with only assignment-specific, time-bounded egress destinations.
7. An append-oriented evidence collector outside the writable overlay, with integrity hashes and trusted timestamps.
8. Reset by destroying the overlay and compute instance and re-instantiating from approved immutable inputs.

## 6. Identity separation and assignment

- Create a dedicated non-human runtime identity only after authorization. It must not be the host user, administrator, service owner, repository owner, or reviewer.
- Bind the identity to one assignment ID, one environment instance, a defined start/end time, and one approved policy version.
- Deny interactive logon except where the approved platform requires a controlled console; deny remote interactive logon by default.
- Do not add the identity to local administrators, hypervisor groups, Docker/container groups, backup operators, debugger users, or production groups.
- Grant no rights to create services, scheduled tasks, drivers, users, tokens, firewall rules, shares, junctions into host paths, or persistent startup entries.
- Separate the environment builder/administrator, assignment operator, evidence custodian, and reviewer. No actor may self-approve the boundary or acceptance result.
- Record assignment authority, stable actor identity, acknowledgement, independence declaration, policy hash, and expiry before provisioning.

## 7. Filesystem allow/deny model

### Allowed

- Read-only operating-system and tool image.
- Read-only assignment manifest and verified workload package.
- Read-only sanitized fixture volume.
- Writable disposable overlay scoped to the assignment.
- Append-oriented evidence channel that accepts only approved record formats and does not expose prior evidence back to the workload.

### Denied

- All production roots and candidate production roots, including direct paths, shares, mapped drives, volume GUID paths, administrative shares, VSS snapshots, host-mounted volumes, and repository worktrees.
- Host user profiles, Desktop/Documents/Downloads, `.cursor`, agent stores, browser profiles, package-manager credentials/caches containing tokens, SSH/GPG stores, cloud CLI profiles, environment-secret files, keychains, credential manager, and CI secrets.
- Hypervisor/control sockets, container-engine sockets, host process/debug interfaces, raw disks, removable devices, serial ports, camera/microphone, clipboard, drag-and-drop, printer redirection, and enhanced-session drive mapping.
- Reparse-point traversal outside allowlisted roots, creation of mount points/junctions/symlinks that cross boundaries, alternate data streams where not required, and execution from fixture/evidence volumes.

Path checks alone are insufficient. Enforcement must be handle/object based where supported, resolve final paths after reparse processing, reject unexpected filesystem types, and fail closed when canonicalization is ambiguous.

## 8. Production fixture derivation and writable overlay

Fixture derivation is a future controlled release process:

1. An authorized production custodian identifies the exact source root, commit/snapshot, data classification, and minimal required subset.
2. A separate exporter copies data through a one-way staging process; the LAB identity receives no production read permission.
3. Automated and manual review remove credentials, tokens, private keys, personal data not required by the assignment, machine identifiers, executable startup hooks, live endpoints, and mutable links.
4. The export is normalized to prevent junctions, symlinks, hard-link surprises, sparse-file abuse, device files, path traversal, unsupported alternate streams, and decompression bombs.
5. The approved fixture is content-addressed, signed or otherwise authenticated, malware-scanned under approved policy, and mounted read-only with execution disabled.
6. A fresh writable copy-on-write overlay is created for each assignment. It must have no route back to the source and no persistence after disposal.

Any discovered need to write a fixture is a design failure: write activity belongs only in the overlay. Production must never be used as a live fixture.

## 9. Credential isolation

- Build images and workload packages without embedded secrets.
- Start with an empty credential namespace and a scrubbed environment.
- Disable host credential delegation, SSO passthrough, managed-identity inheritance, browser-profile sharing, SSH agent forwarding, Git credential helpers, cloud metadata access, and host keychain integration.
- If a future assignment requires a credential, use a purpose-built, least-privilege, assignment-scoped, short-lived credential delivered after boot through an approved broker. It must be non-production unless a separately governed exception is approved.
- Bind credentials to approved destinations and actions, prevent refresh beyond assignment expiry, redact values from logs, and revoke them at teardown or breach.
- Evidence must record credential identifier/class and policy version, never the secret value.

## 10. Network policy

The default state is no NIC or an enforced deny-all policy at a control point the guest cannot modify.

Explicit egress, if required, must be approved per assignment and specify destination FQDN/IP set, protocol, port, TLS requirements, purpose, data class, byte/rate limits, expiry, DNS behavior, and logging. Prefer an authenticated proxy with destination allowlisting. Deny inbound connectivity, east-west traffic, local subnets, host-only adapters, link-local services, multicast/broadcast, arbitrary DNS, tunneling protocols, public paste/file-sharing sites, remote shells, and cloud instance-metadata endpoints.

DNS must use an approved resolver and reject rebinding to denied address ranges. FQDN allowlists must not silently become unrestricted CDN or wildcard access. Redirects and proxy `CONNECT` targets require equivalent policy checks. Network policy administration must remain outside the guest.

## 11. Process, privilege, and resource limits

- Run as the constrained identity with no elevation path and a minimal privilege/token set.
- Use an immutable allowlisted toolchain where feasible; prohibit driver loading, service creation, nested virtualization, namespace/VM creation, host debugging, and raw device access.
- Apply limits for CPU, memory, process count, threads, open handles/files, disk capacity, inode/file count where applicable, I/O bandwidth, network bytes, wall-clock runtime, and log volume.
- Enforce a watchdog and hard assignment deadline from outside the guest.
- Disable core dumps or route them to a protected evidence path after secret-aware review.
- Define out-of-memory, disk-full, fork/process storm, and timeout behavior as fail-closed termination events.

## 12. Host and administrator residual risk

No proposed option eliminates host/admin trust. A host, hypervisor, cloud, EDR, backup, firmware, or physical administrator may be able to inspect memory, alter images or clocks, inject devices, change policy, or recover deleted storage. Conversely, a guest escape could affect the host.

Mitigations include a dedicated patched host, separation of duties, measured/verified base images, secure boot where supported, minimal integrations, restricted admin membership, tamper-evident host logs, independent network enforcement, and no production co-tenancy. Highly hostile kernel/escape testing requires a dedicated physical host or provider service expressly approved for that class of testing.

## 13. Artifact, evidence, clock, and log integrity

- Before start, record the assignment ID; actor assignments; platform/image identifiers; policy hashes; fixture/workload hashes; expected network policy; resource limits; and trusted UTC source.
- Capture boot/instance identifiers, constrained identity output, mount table/drive inventory, effective policy summaries, process lifecycle, denied access events, network decisions, resource-limit events, workload stdout/stderr, and teardown outcome.
- Send logs to an external append-oriented collector unavailable for workload modification. Sequence records and include UTC timestamp, monotonic time, instance ID, assignment ID, source, and event type.
- Synchronize the host/control plane to an approved authenticated time source. Treat guest wall clock as untrusted; correlate it with collector receipt time and monotonic counters.
- Hash artifacts at capture and after transfer. Produce a manifest that records algorithm, size, origin, collector time, handling actor, redaction, and retention class.
- Evidence export must be one-way or mediated. Do not mount the evidence repository writable inside the workload.
- Clock rollback, time-source loss, collector unavailability, sequence gaps, or hash mismatch must stop acceptance and trigger incident handling.

## 14. Reset, disposal, and rollback

### Normal reset/disposal

1. Stop the workload from the external control plane.
2. Seal logs and artifact manifests.
3. Revoke assignment credentials and egress grants.
4. Detach and retain only explicitly approved evidence.
5. Destroy the writable overlay and ephemeral instance.
6. Verify the instance, overlay, temporary snapshots, exported secrets, and policy lease no longer exist.
7. Recreate from the approved immutable image and fixture for any subsequent run; never reuse a contaminated overlay.

Storage deletion claims must match the platform's encryption and media-sanitization model. Crypto-erasure is acceptable only when unique disposable keys and key-destruction evidence exist.

### Rollback

Rollback means returning to the last approved image, fixture, policy, and manifest versions by recreating the environment. It does not mean preserving or reattaching a possibly contaminated writable disk. Any changed platform component requires a new preflight and reviewer disposition.

## 15. Breach response

Trigger conditions include unexpected access success, denied-root visibility, credential discovery, policy alteration, network contact outside the allowlist, host integration exposure, evidence gaps, clock anomalies, suspected escape, or inability to prove teardown.

On trigger:

1. The external control plane blocks network egress and pauses or terminates the instance according to the approved forensic policy.
2. Operators do not interactively explore with production credentials.
3. Preserve control-plane logs, volatile evidence only if pre-authorized, instance/image identifiers, and policy versions.
4. Revoke assignment credentials and related tokens; notify security, environment owner, production custodian, evidence custodian, and governance roles.
5. Quarantine artifacts as untrusted; do not attach them to production systems.
6. Record scope, timeline, affected boundaries, containment, residual uncertainty, and required rebuild.
7. Destroy/rebuild only after the evidence custodian releases the instance and the incident owner approves the method.
8. Acceptance remains blocked until independent review closes the breach and a fresh environment passes future preflight.

## 16. Negative-test safety

Negative tests must be separately enumerated and approved; broad labels such as “sandbox escape test” are insufficient. Each test case must define the attempted action, expected denial, target object, maximum resource use, timeout, safe synthetic payload, evidence signal, abort condition, and cleanup.

- Never target production, host management planes, unrelated tenants, public systems, real credentials, or non-consenting users.
- Use synthetic secrets/canary tokens that cannot authorize any real action.
- Tests involving malware, persistence, privilege escalation, kernel exploitation, credential dumping, destructive storage, denial of service, or network scanning require explicit security and platform-owner approval and may require a dedicated physical or provider-approved environment.
- A negative test unexpectedly succeeding is a breach condition, not a pass and not permission to continue.
- Run one bounded case at a time with an external kill mechanism and observer.

## 17. Future preflight boundary verification

All items are `FUTURE / NOT RUN`. Preflight must occur before any workload and must produce a signed reviewable receipt.

1. Verify assignment, approvals, instance ID, image/fixture/workload/policy hashes, and expiry.
2. Run `whoami` (and platform-equivalent token/group inspection). Expected: the dedicated assignment identity, no administrator/elevated groups, and no host-user identity.
3. Enumerate mounted drives/filesystems and host integrations. Expected: only approved system, read-only fixture, writable overlay, and mediated evidence interfaces.
4. Attempt a non-destructive metadata open of a designated **synthetic denied canary path**, not real production content. Expected: `AccessDenied`/permission denied. The canary must be created by an authorized administrator in the future and contain no sensitive data.
5. Attempt read, create, modify, rename, delete, execute, reparse-link, and alternate-path variants only against synthetic canaries approved for this purpose. Expected: denied for fixture writes and all denied roots; allowed only inside the overlay as specified.
6. Verify no ambient credentials, delegated identity, cloud metadata, credential helper, host agent, or secret-bearing environment variable is present.
7. Verify inbound denied and egress deny-all before loading any assignment allowlist; then test only synthetic approved endpoints. Expected: denied except exact approved policy.
8. Verify process, privilege, disk, memory, CPU, handle, network, and deadline limits using harmless bounded probes.
9. Verify logs arrive externally with monotonic sequence, trusted collector time, correct instance/assignment IDs, and hashable artifacts.
10. Verify emergency isolation and teardown controls from outside the guest.

Any unexpected success, ambiguous result, missing log, or unverifiable identity is a stop condition. Preflight must not probe actual production paths until a production custodian has approved a synthetic canary mechanism that reveals no production names or content.

## 18. Threat and bypass matrix

| Threat or bypass | Proposed preventive control | Required future evidence | Residual risk / response |
| --- | --- | --- | --- |
| Historical folder mistaken for sandbox | Explicit historical-workspace classification; independent VM/host boundary | Architecture approval and instance identity | Human error; stop if execution is proposed in place |
| Host path reached by alias, share, junction, reparse point, or volume path | No host mounts; canonical handle checks; reparse restrictions; synthetic canaries | Mount inventory and expected `AccessDenied` receipts | Platform parsing defect; treat unexpected success as breach |
| Production fixture modified | Content-addressed read-only, no-execute fixture plus separate overlay | Fixture hash, mount flags, denied-write evidence | Hypervisor/admin can alter backing media |
| Ambient host/cloud credential inherited | Empty credential namespace; delegation/metadata/agent forwarding disabled | Identity and environment inventory with redacted receipt | Admin/control-plane compromise |
| Network allowlist bypass via DNS, redirects, proxy, IPv6, or tunnel | External L3-L7 enforcement, approved DNS, rebinding/redirect checks, tunnel denial | Flow and proxy decision logs | Provider/network-admin trust |
| Container escape/shared-kernel attack | Outer VM/dedicated host; no container-only selection for hostile tests | Platform ADR and kernel-boundary evidence | Hypervisor/firmware vulnerability |
| Resource exhaustion affects host | External quotas, watchdog, deadline, dedicated capacity | Limit configuration and bounded-probe receipt | Shared infrastructure contention |
| Log tampering or deletion | External append-oriented collector, sequence and hashes | Collector receipt and manifest verification | Collector/admin compromise |
| Clock manipulation falsifies chronology | Trusted host time, collector receive time, monotonic counters | Time-health and correlation receipt | Host/control-plane time compromise |
| Evidence export becomes exfiltration route | One-way mediated export, type/size policy, review/quarantine | Export manifest and custody record | Covert content in allowed artifacts |
| Snapshot/reset retains contamination | Destroy overlay/instance; recreate from immutable inputs | Deletion and fresh-instance receipts | Provider backup/media retention |
| Clipboard, shared folder, device, or enhanced session bypass | Disable all host integrations by policy | Integration-state inventory | Administrator re-enables integration |
| Local administrator reads or changes guest | Admin separation, dedicated host, tamper-evident audit | Admin roster and control-plane logs | Administrators remain trusted |
| Negative test succeeds unexpectedly | One-case scope, external kill, breach trigger | Test plan and abort evidence | Unknown exploit impact; isolate and incident-handle |
| Malicious fixture/workload package | Signed/hash-pinned package, normalization, scan, no-execute fixture | Provenance and scan receipts | Scanner and supply-chain limitations |
| Reviewer self-certification | Separated builder/operator/custodian/reviewer roles | Stable assignments and acknowledgements | Collusion or assignment-authority failure |

## 19. Acceptance criteria

Status for every criterion: `FUTURE / NOT RUN`.

- An approved platform ADR selects an option using Section 4 criteria and documents residual risk.
- Stable actors and separation of duties are recorded; Agent D or another duly assigned independent reviewer reviews the exact specification and implementation evidence.
- The production custodian identifies authoritative source roots and approves a minimal sanitized fixture release.
- Image, fixture, workload, network policy, identity policy, resource policy, and evidence schema are versioned and hash-pinned.
- `whoami` proves the constrained assignment identity with no elevated or host identity.
- Synthetic denied canaries return expected `AccessDenied` across direct and alternate path forms.
- Production roots and host integrations are absent, not merely hidden.
- Fixture writes and execution are denied; overlay writes work only within quota.
- No ambient credential or metadata identity is available.
- Network starts deny-all; only exact approved egress succeeds and all decisions are externally logged.
- Process/privilege/resource limits and external watchdog behave as specified.
- Logs and artifacts are complete, externally captured, ordered, time-correlated, hashed, and reviewable.
- Emergency isolation, credential revocation, teardown, crypto-erasure/deletion evidence, and clean recreation are demonstrated.
- Approved negative tests use only synthetic targets and every unexpected success triggers breach handling.
- Independent review records limitations and a disposition. A technical pass alone does not constitute governance acceptance or execution release.

No acceptance receipt is created by this draft.

## 20. Dependencies, approvals, and blockers

### Required dependencies

- Governed actor assignments and separation-of-duties record.
- Resolution of existing S0, publication-history, rubric-freeze, baseline-gate, UCR-001 release, and S1 holds.
- Authoritative production-root and data-custodian identification.
- Data classification, minimization, sanitization, retention, and evidence-custody decisions.
- Platform ADR, approved base image, patch baseline, licensing, capacity, and operational owner.
- Identity provider/service-account design and short-lived credential broker if credentials are later justified.
- Network security owner for deny-all enforcement, DNS/proxy policy, and logging.
- Security owner for negative-test classification and incident response.
- Evidence collector, trusted time source, storage retention, and deletion-verification mechanism.
- Synthetic denied canaries and approved harmless preflight probes.

### Explicit admin/reboot approvals

Administrator approval is required before enabling any hypervisor/sandbox feature, creating a dedicated identity, changing ACLs or user rights, creating virtual switches/firewall/proxy rules, installing images or agents, allocating devices, configuring log collectors, or creating/deleting instances and storage.

Separate platform-owner approval is required for any firmware/BIOS virtualization change, Windows feature enablement, virtualization-based security change, host hardening change, or other action that may require a reboot. The approval must state the affected host, maintenance window, rollback plan, expected service impact, and post-reboot verification. This design grants no such approval.

### Current blockers

- The historical workspace is absent, so its provenance and structure cannot support platform selection or recovery assumptions.
- No authoritative production-root inventory or custodian approval was available from the inspected evidence.
- Platform capabilities and host hardening state were not verified.
- No constrained identity, fixture, overlay, network boundary, evidence collector, synthetic canary, or reset mechanism exists as verified LAB-03 evidence.
- Governance assignments, independent review, acceptance, and execution release remain absent.
- Construction and all testing remain prohibited.

## 21. Prohibited next actions

Until the dependencies and approvals above are recorded, do not:

- create or alter users, groups, ACLs, rights, credentials, VMs, containers, virtual disks, snapshots, networks, firewall rules, proxies, services, scheduled tasks, or log collectors;
- enable Windows or firmware features or reboot a host;
- mount, copy, sanitize, or execute historical or production material;
- run preflight, boundary, resource, negative, acceptance, or rollback tests;
- infer acceptance from this specification, a future technical pass, directory naming, branch presence, or administrator ownership.

The only permitted continuation under the current hold is documentation review and read-only evidence gathering expressly authorized by the applicable owners.
