# Wave 0.4 LAB Isolation Acceptance Checklist

## 1. Control and use

- Experiment: `AU-UCR-EP-000001`
- Wave: `0.4`
- Artifact: `W04-LAB-ISOLATION-ACCEPTANCE`
- Status: `DESIGN_DRAFT / FUTURE NOT RUN`
- Baseline context: branch `cursor/populate-authority-readiness-7886`, revision `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Governing design: `LAB-03_REVISED_ISOLATION_SPEC.md`
- Acceptance receipt: none

This checklist defines future evidence requirements. It does not authorize construction or testing and records no pass. For every item, a future evaluator must record `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`, or approved `NOT_APPLICABLE`; evidence ID/path; exact candidate and policy versions; enforcement primitive; independent evidence source; evaluator stable identity; UTC time; limitations; and disposition. Only `PASS` or reviewer-approved `NOT_APPLICABLE` can satisfy a criterion.

## 2. Authorization and candidate identity

- [ ] Effective, stable assignments exist for platform administrator, operator, fixture custodian, credential/broker administrator, network owner, evidence custodian, QA/Evidence Agent, Independent Reviewer, Decision Chair, and Coordinator/Architect as applicable.
- [ ] Separation and transitive conflict checks satisfy `AU_UCR_GOV_001`; no actor self-certifies.
- [ ] The exact published specification, ADR, implementation/configuration candidate, schemas, and policies are commit/content addressed.
- [ ] Publication, QA, independent-review, Decision Chair, construction-release, and preflight authorization receipts exist in the required order.
- [ ] Branch, repository identity, full commit SHA, working-tree status, artifact byte sizes, declared hash domains, and digests are recorded.
- [ ] Gating state permits only the authorized phase; no acceptance or execution authority is inferred.

## 3. Selected platform profile

- [ ] One platform ADR selects VM, physical host, managed sandbox, Windows Sandbox/equivalent, or container-plus-outer-VM.
- [ ] Threat class, data class, tenant/region, administrative trust, unsupported controls, compensating controls, costs, retention, and incident ownership are approved.
- [ ] Every common criterion is mapped to a platform enforcement primitive, configuration object, responsible owner, and independent evidence source.
- [ ] VM profile evidence covers guest-kernel separation, integration disablement, disks, NICs, snapshots, management plane, and deletion.
- [ ] Physical-host profile evidence covers asset/BMC/firmware/build identity, physical access, network segmentation, media keys, rebuild, and sanitization.
- [ ] Managed-provider profile evidence covers provider tenant/account/project, region, instance, image, policy, keys, audit logs, snapshots/backups, deletion semantics, and provider retention.
- [ ] Windows Sandbox/equivalent evidence proves policy-verifiable networking, mapped-folder, clipboard, device, persistence, collector, export, and teardown controls; otherwise the profile is rejected.
- [ ] Container use has an approved outer VM; evidence covers rootless/user namespace, capabilities, syscall/device limits, cgroups/job controls, immutable digest, no engine socket, and both isolation layers.

## 4. Trust, signatures, time, collector, and broker

- [ ] Approved algorithm/key-purpose registry reconciles LAB requirements with A-04/B-03.
- [ ] Root/intermediate/key owners, generation, custody, quorum, witness, rotation, revocation, rollover, emergency recovery, and decommissioning are evidenced.
- [ ] Image, fixture, workload, identity, network, collector, broker, and teardown policies are digest-pinned and authenticated by purpose-specific keys.
- [ ] Normative schemas define required fields, bounds, canonical encoding, duplicate-key behavior, extension policy, unique receipt IDs, replay controls, and cross-field rules.
- [ ] Collector is external, append-only/WORM as approved, unavailable for workload read/change/delete, and independently administered.
- [ ] Collector records include assignment/instance/source IDs, sequence, event type, monotonic time, untrusted guest time, trusted receipt time, payload digest, and chain/anchor.
- [ ] Authenticated time source, offset, uncertainty, last sync, monotonic continuity, and failure response are evidenced.
- [ ] Credential broker authenticates requester and workload, binds audience/scope/destination/expiry, records leases, and enforces revocation.
- [ ] Invalid signature, stale revocation, replay, duplicate ID, sequence gap, time-health loss, collector outage, or hash-domain ambiguity fails closed.
- [ ] PRE_A09 verification declares its hash domain; CRLF checkout bytes are not falsely compared with LF Git-blob digests.

## 5. Execution identity and administration

- [ ] Execution identity is unique to one assignment and instance, non-human, non-administrative, time-bounded, and not reused.
- [ ] Identity has no host-user, local-admin, hypervisor, container-engine, backup, debugger, driver, service, task, firewall, share, or user-management rights.
- [ ] Interactive and remote logon are denied except an explicitly controlled console.
- [ ] Required guest services have separate least-privilege identities and no general command channel.
- [ ] Administrative requests follow `REQUESTED -> SEPARATION_CHECKED -> QUORUM_APPROVED -> TIME_BOUND_ACTIVE -> COMPLETED -> REVIEW_PENDING -> REVIEWED`.
- [ ] Named just-in-time sessions use strong authentication, operation recording, independent alerts, external expiry, and post-use review.
- [ ] Break-glass scope, approval, automatic expiry, independent alert, rotation, evidence sealing, and review are verified.
- [ ] Unauthorized, unrecorded, expired, or expanded admin activity enters `INCIDENT_HOLD`.

## 6. Filesystem and device prevention

- [ ] Production and candidate-production roots are absent through drive, volume GUID, share, administrative share, VSS, backup, host-folder, worktree, and alias forms.
- [ ] Host profiles, `.cursor`, agent stores, credential stores, browser/cloud/SSH/GPG state, package caches with secrets, and CI secrets are absent.
- [ ] Host/container/hypervisor sockets, raw disks, process/debug interfaces, clipboard, drag/drop, shared folders, enhanced-session drives, printers, removable devices, camera/microphone, and unapproved devices are absent.
- [ ] Final-object/handle enforcement rejects reparse points, symlinks, junctions, mount points, hard-link escapes, alternate streams, path traversal, case/namespace ambiguity, and unsupported filesystems.
- [ ] Synthetic denied canaries receive the expected denial for read, create, modify, rename, delete, execute, link, and alternate-path variants.
- [ ] No actual production path or sensitive object is probed.
- [ ] A path name, directory scan, or hash scan is not accepted as proof of isolation or non-interference.

## 7. Fixture and writable overlay

- [ ] Fixture source is custodian-approved, minimal, classified, and bound to exact source snapshot/commit/object set.
- [ ] LAB runtime identity never receives production read access; export uses controlled one-way staging.
- [ ] Archive depth, expansion ratio, member count, path length, total size, encryption, malformed input, sparse/device content, and ambiguity rules are enforced.
- [ ] Content-based positive file-type allowlist is applied.
- [ ] Executables, installers, drivers, shortcuts, scripts, macros, active documents, package hooks, and startup files are rejected or separately approved and transformed inert.
- [ ] Secrets, personal data not required, machine identifiers, live endpoints, mutable links, and production-only authorities are removed.
- [ ] Every deterministic transformation records rule ID, tool/version, input/output digest, and disposition.
- [ ] Material/software inventory and signed fixture provenance receipt are independently verified.
- [ ] Fixture is content-addressed, read-only, no-execute, and cannot route back to source.
- [ ] Writable overlay is assignment-unique, quota-bound, disposable, and the only allowed write location.

## 8. Credential, service, and metadata isolation

- [ ] Image and packages contain no embedded secret.
- [ ] Environment and credential namespace start empty and scrubbed.
- [ ] Host SSO, delegated credentials, SSH agent, Git helper, browser profile, cloud CLI, keychain, managed identity, and metadata service are denied.
- [ ] Synthetic canary credentials cannot authorize real actions and generate expected alerts if touched.
- [ ] Any justified credential is non-production unless separately excepted, short-lived, least-privilege, non-refreshable past expiry, action/destination-bound, and delivered only after preflight.
- [ ] Secret values are absent from logs and evidence.
- [ ] Revocation succeeds on stop, expiry, breach, and teardown, with independent evidence.
- [ ] Prohibited services are absent/disabled and persistence paths cannot be created.

## 9. Network and relay prevention

- [ ] Initial network state is no NIC or externally enforced deny-all.
- [ ] Inbound, east-west, local subnet, host-only, link-local, multicast/broadcast, arbitrary DNS, metadata, remote shell, tunneling, and public sharing are denied.
- [ ] Every egress rule binds destination provider/owner and tenant/account/project, region, exact endpoint/service/API operation, protocol/port, expiry, purpose, and data class.
- [ ] TLS version, approved CA/pins, proxy chain, SNI/Host consistency, certificate rotation, optional mTLS, and API audience are enforced.
- [ ] Approved resolver prevents rebinding and re-evaluates IPv4/IPv6, redirects, CDN changes, and proxy `CONNECT`.
- [ ] Application gateway constrains methods, schemas, request/response types and sizes, byte/rate/object limits, and sensitivity.
- [ ] Open redirects, callback/URL-fetch parameters, arbitrary uploads/downloads, wildcard tenants, cross-tenant object IDs, generic buckets, protocol upgrades, and encrypted tunnels are denied.
- [ ] Permitted endpoints cannot act as arbitrary relays.
- [ ] Network and gateway decisions are externally logged and correlated to assignment/instance.
- [ ] Only synthetic approved endpoints are used during preflight.

## 10. Process, privilege, resource, and watchdog controls

- [ ] Minimal privilege/token set and no elevation path are verified.
- [ ] Driver/service/task/user creation, nested virtualization, namespace/VM creation, host debugging, raw devices, and management-plane mutation are denied.
- [ ] CPU, memory, process/thread, handle/file, disk, file-count, I/O, network, wall-clock, and log-volume limits are configured externally where possible.
- [ ] OOM, disk-full, process storm, timeout, and log-flood behavior fails closed.
- [ ] External watchdog and hard deadline can isolate/terminate without guest cooperation.
- [ ] Only harmless bounded probes verify limits.

## 11. Evidence collection and destinations

- [ ] Preflight captures assignment, actors, platform/image/fixture/workload/policy IDs and hashes, expected network policy, limits, trust keys, and time health.
- [ ] Runtime evidence captures boot/instance IDs, identity, mounts/devices/integrations, process lifecycle, denials, network decisions, limits, stdout/stderr, admin actions, and teardown.
- [ ] Allowed evidence destinations identify owner, provider/tenant/region, data classes, access roles, retention, legal hold, encryption keys, redaction, quarantine, and deletion policy.
- [ ] Export is one-way/mediated, type- and size-limited, schema-validated, scanned/quarantined, reviewed, and custody-recorded.
- [ ] Workload cannot read prior evidence, alter records, or select a destination.
- [ ] No evidence goes to production roots, personal paths, public sharing, arbitrary storage, chat/email, or `C:\Users\hakee\Desktop\imhotep_forensic_test`.
- [ ] Hash-at-capture and hash-after-transfer agree under an explicitly declared byte domain.
- [ ] Evidence completeness and chronology are independently reviewed.

## 12. Independent boundary verification

- [ ] Verifier is independent of builder/operator and has an effective assignment.
- [ ] Control-plane and guest inventories correlate to the same assignment and instance.
- [ ] Identity, filesystem/device, fixture/overlay, credential/metadata, network, service, and resource expectations all produce exact expected reason codes.
- [ ] Emergency isolation, credential revocation, collector continuity, and external kill control are demonstrated with harmless synthetic actions.
- [ ] Any unexpected success, ambiguity, missing record, sequence gap, clock/signature/hash failure, or unverifiable identity produces `FAIL`/`BLOCKED` and breach handling.
- [ ] No technical pass is represented as governance acceptance or execution release.

## 13. Teardown, deletion, and provider retention

- [ ] Workload stops from the external control plane and evidence is sealed first.
- [ ] Credentials, tokens, egress rules, policy leases, and temporary access expire or are revoked.
- [ ] Instance, overlay, temporary disks, snapshots, exported secrets, queues/buffers, and temporary staging are inventoried and destroyed.
- [ ] Unique assignment encryption keys and all wraps/replicas are covered by destruction evidence.
- [ ] Provider backups, replicas, delayed deletion, legal hold, and media reuse are identified and dispositioned.
- [ ] Independent control-plane evidence verifies absence or justified provider retention.
- [ ] Any unproven deletion enters `TEARDOWN_FAILED` or `PROVIDER_RETENTION_HOLD`; identifiers/material are quarantined and reuse/acceptance are denied.
- [ ] Retained-copy record names location, controller, reason, access policy, key status, deletion schedule, and next verification.
- [ ] Environment reaches `DESTROYED_VERIFIED` before closure.
- [ ] A subsequent run is freshly recreated; no contaminated overlay/snapshot is reused.

## 14. Controlled-test authorization

- [ ] Preflight plan uses only synthetic canaries and harmless bounded probes.
- [ ] Each case states attempted action, expected denial/result, target, maximum resources, timeout, data/network allowance, evidence signal, abort, external kill, and cleanup.
- [ ] Exact instance and all image/workload/fixture/policy/schema/key versions are bound to a time-bounded authorization receipt.
- [ ] Security/platform/data/network/evidence/incident approvals match the test class.
- [ ] Negative tests have a later, separate case-specific authorization.
- [ ] Unexpected success stops the session and enters breach handling.
- [ ] Production, unrelated tenants, public systems, real credentials, and non-consenting users are excluded.

## 15. Acceptance aggregation

- [ ] Every applicable criterion is `PASS`.
- [ ] Every `NOT_APPLICABLE` has ADR rationale and independent reviewer approval.
- [ ] No `FAIL`, `BLOCKED`, `NOT_RUN`, `UNKNOWN`, ambiguous, expired, or stale evidence remains.
- [ ] Residual-risk assessment is completed for the exact candidate and accepted by the authorized risk owner without overriding mandatory holds.
- [ ] Independent QA and review identify no material contradiction.
- [ ] Decision Chair records the governance outcome for the exact published candidate.
- [ ] Any later execution has a separate Coordinator/Architect execution-release receipt.

Current result: `NOT_RUN / NOT_ACCEPTED / NO AUTHORITY`.
