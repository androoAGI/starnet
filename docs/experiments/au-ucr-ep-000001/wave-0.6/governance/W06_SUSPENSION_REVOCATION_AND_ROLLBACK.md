# Wave 0.6 Suspension, Revocation, and Rollback

## Control principles

1. Lifecycle events are append-only, purpose-specific records.
2. Suspension, revocation, supersession, expiry, and rollback do not erase prior evidence.
3. Unknown ordering, identity, scope, status, or signature fails closed.
4. A final governance decision is separate from an operational release.
5. Rollback is never general implementation authority; it is limited to a named source state,
   target, environment, action set, and validity window.
6. No lifecycle action is authorized by this prepared specification.

## Mandatory suspension triggers

Suspend affected authority, acceptance, or activity when any of these is discovered:

- identity, mandate, assignment, acknowledgement, or signature cannot be verified;
- role conflict or prohibited role combination;
- scope, candidate, repository, path, branch, environment, or time mismatch;
- expired, replayed, revoked, superseded, or out-of-order prerequisite;
- evidence, dependency, trust, provenance, or independent-review regression;
- material contradiction or safety/security finding;
- missing rollback target where a release requires one.

Containment is fail-closed: stop at the authorized boundary, keep inactive paths off, preserve
evidence, quarantine affected identities, append the finding, and request a new governed record.

## Suspension/revocation receipt template

- Object kind: `AUTHORITY_LIFECYCLE_EVENT`
- Event ID: ``
- Outcome: `SUSPENDED | REVOKED | SUPERSEDED`
- Issuer governed name: ``
- Issuer stable identity: ``
- Issuer role and effective appointment ID/digest: ``
- Key purpose: `AUTHORITY_LIFECYCLE`
- Affected appointment/decision/acceptance/release IDs and digests: ``
- Exact affected candidate/run/environment scope: ``
- Trigger and evidence IDs/digests: ``
- Reason and governing policy clause: ``
- Effective at UTC: ``
- Event counter/previous-event digest/nonce: ``
- Required containment actions: ``
- In-flight work disposition: ``
- Re-review and replacement requirements: ``
- Issuer signature/receipt: ``
- Independent verification result: `NOT_PERFORMED`

Hakeem Moore may suspend or revoke any delegated Wave 0.6 role within his root authority. A
delegated revocation authority may act only if an effective appointment expressly grants that
power. No delegated actor may revoke or supersede Hakeem Moore's root final-decision authority.

## Rollback authorization receipt template

- Object kind: `ROLLBACK_AUTHORIZATION`
- Rollback ID: ``
- Outcome: `ROLLBACK_AUTHORIZED | ROLLBACK_DENIED`
- Exact affected release/run ID and digest: ``
- Exact source candidate/state/environment IDs and digests: ``
- Exact rollback target ID/digest: ``
- Evidence that target was separately accepted and remains compatible: ``
- Authorized actions in order: ``
- Prohibited actions: ``
- Maximum effects and data boundaries: ``
- Compensating actions: ``
- Abort/stop conditions: ``
- Irreversible effects disclosed: ``
- Effective from/through UTC: ``
- Coordinator/Architect name, stable identity, appointment ID/digest: ``
- Security/Governance name, stable identity, appointment ID/digest: ``
- Both acceptance/separation receipt IDs/digests: ``
- Event counter/previous-event digest/nonce/replay result: ``
- Coordinator/Architect signature/receipt: ``
- Security/Governance signature/receipt: ``
- Independent verification result: `NOT_PERFORMED`

If either required issuer, signature, effective appointment, target acceptance, or compatibility
record is missing, rollback is `NOT AUTHORIZED`; containment remains permitted only to the extent
already authorized by the affected release.

## Reinstatement receipt template

- Object kind: `REINSTATEMENT_AUTHORIZATION`
- Reinstatement ID: ``
- Outcome: `REINSTATED_NEW_VERSION | REINSTATEMENT_DENIED`
- Suspension/revocation event IDs/digests: ``
- Cause-resolution evidence IDs/digests: ``
- Corrected candidate/version ID and digest: ``
- New QA and independent-review receipt IDs/digests: ``
- New final-decision receipt ID/digest, when decision validity was affected: ``
- New operational-release ID/digest, when a run is requested: ``
- New validity interval and event ordering: ``
- Required appointed issuers and signatures: ``
- Independent verification result: `NOT_PERFORMED`

Reinstatement never reactivates an old terminal receipt, session, or run and never validates
intervening actions retroactively.

## Current lifecycle status

- Effective delegated appointments: `NONE`
- Effective operational release: `NONE`
- Active run: `NONE`
- Suspension event required now: `NO ACTIVE AUTHORITY OR RUN TO SUSPEND`
- Revocation event required now: `NO ACTIVE DELEGATION TO REVOKE`
- Rollback required now: `NO OPERATIONAL STATE CREATED BY THIS PACKAGE`
- Prepared lifecycle controls: `COMPLETE`
