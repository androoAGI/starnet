# Proposed Preservation Controls Document
**Experiment:** `AU-UCR-EP-000001`
**Wave:** `0.7`
**Status:** `PROPOSED_PENDING_DECISION`

## 1. Immutable Storage Destination
The selection of a concrete immutable storage destination (e.g., specific cloud provider WORM bucket, blockchain-anchored repository, or air-gapped archival system) **requires a human decision**. No destination is assumed. 

Current state: `DESTINATION_SELECTION_PENDING_HUMAN_AUTHORITY`

## 2. Preservation Mechanism
Once a destination is selected, the following controls shall be applied:

- **Preservation Mechanism:** Write-Once-Read-Many (WORM) storage with object locking enabled.
- **Retention Policy:** Permanent retention for the duration of the experiment's legal and technical lifecycle; no automated deletion permitted.
- **Access Controls:** 
    - `READ`: Public or authorized auditors (as defined by the Decision Chair).
    - `WRITE`: Restricted to the authorized Publication Custodian during the freeze window.
    - `DELETE/MODIFY`: Prohibited by storage-level immutability policy.
- **Integrity Verification:**
    - Every leaf object must be verified against `raw-working-tree-sha256-v1` and `git-blob-oid-v1`.
    - Root manifests (L3-L5) must be signed and cross-referenced in a non-circular hierarchy.
    - Periodic automated integrity audits comparing remote bytes against the authorized L5 receipt.
- **Custody Responsibilities:**
    - **Publication Custodian:** Responsible for the atomic transfer of the frozen candidate to the destination.
    - **Decision Chair:** Responsible for verifying the L5 publication receipt against the L4 decision package.

## 3. Signing Authority & Authentication
The preservation act (The "Freeze and Publish" event) requires:

- **Signing Authority:** The designated Publication Custodian, acting under the mandate of the Human Authority (`Hakeem Moore`).
- **Authentication Prerequisites:**
    - Validated `Identity and Mandate` record for the Custodian.
    - Multi-factor authentication (MFA) tied to the stable identity identifier.
    - Cryptographic signature of the L5 publication envelope using a hardware-backed key.
