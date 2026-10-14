# Gate P Governance Backlog

## Control record

- Experiment: `AU-UCR-EP-000001`
- Backlog: `GP-GOV-BACKLOG`
- Status: `PARKED_PENDING_IN_PRODUCT_AGENTS`
- Gate P: `BLOCKED_BY_EVIDENCE`
- Acceptance: `NONE`
- Created from local HEAD: `bddfafef7f558084a94b76b9cf38d57e924b05db`
- Execution rule: StarNet agents may work these items only after Agents University is integrated into StarNet and can inspect this repository from inside the product. This file does not appoint those agents, accept any item, or approve Gate P.

Completed technical work stays distinct from these items. R1 is locally committed. The R2 manifest proposal is reproducible. The Codex canvas confirmed 54/54 members and aggregate `defad8411df0b6e63b14c71345346976d4ea8c9e2e372d126126b9a0fca7ea8d`. None of that closes a governance item.

## How to read an item

- `PARKED` means the blocker is recorded and intentionally not being forced closed in this session.
- `BLOCKED` means a prerequisite in this backlog must finish first.
- No item is `ACCEPTED`.
- A later agent must attach evidence, an independent review, and an explicit decision before changing either status.

## Active prerequisite

| ID | Title | Status | Owner | Depends on | Evidence needed |
| --- | --- | --- | --- | --- | --- |
| GP-BLK-21 | Integrate Agents University into StarNet so governed work can run inside the product | PARKED | Human Principal to supply the integration source and boundary | None | Versioned integration, separate execution environment, and a record that the in-product agent did not author the R1/R2 changes it later reviews |

All items below stay parked until `GP-BLK-21` is complete.

## Authority and review

| ID | Blocker | Status | Depends on | Remaining evidence |
| --- | --- | --- | --- | --- |
| GP-BLK-01 | Appoint an Independent Reviewer who is not the Human Principal and did not author R1/R2 | PARKED | GP-BLK-21 | Named reviewer, stable non-secret identity, issuer, and conflict disclosure |
| GP-BLK-02 | Authenticate that appointment | PARKED | GP-BLK-01 | Appointment or delegation record, signing-key ID, and authenticated time source |
| GP-BLK-03 | Obtain an exportable review receipt | PARKED | GP-BLK-02 | Receipt binding reviewer identity, packet `bddfafef7…`, candidate `01b5e02a…`, aggregate `defad841…`, outcome, exceptions, timestamp, platform or receipt ID, and a checkable signature |
| GP-BLK-04 | Decide whether unsigned Git commits are acceptable | PARKED | GP-BLK-03 | Both packet and candidate commits currently report no Git signature (`%G? = N`) |
| GP-BLK-11 | Distinguish role labels from authenticated appointments | PARKED | GP-BLK-02 | Separate proof for Decision Chair, Independent Reviewer, and Publication Custodian |

The current Codex canvas is technical verification only. It is not evidence for `GP-BLK-03`.

## Candidate, manifest, and policy

| ID | Blocker | Status | Depends on | Remaining evidence |
| --- | --- | --- | --- | --- |
| GP-BLK-07 | Designate the exact preservation candidate | PARKED | GP-BLK-21 | Explicit decision naming commit `01b5e02a84fe260558c4ae66d03df91bb7f66c20` and tree `dca22c304034f1662db99230a29d3ccc3ca38889`, or a different exact commit |
| GP-BLK-05 | Adopt or reject manifest v1.1.0 | PARKED | GP-BLK-03, GP-BLK-07 | Signed supersession naming v1.0.0 digest `69d71ec5…`, proposed aggregate `defad841…`, actor, time, and rollback path |
| GP-BLK-06 | Adopt or reject the prospective LF checkout policy | PARKED | GP-BLK-05 | Approved `.gitattributes` scope. Technical inspection found 287 LF-only blobs and no simulated content change; that inspection is not approval |
| GP-BLK-16 | Keep the old reported root separate from the reproduced aggregate | PARKED | GP-BLK-05 | The reported root `3d1942c4…` was not reproduced. It must not be replaced by `defad841…` without a signed explanation |

## Gate, audit record, and custody

| ID | Blocker | Status | Depends on | Remaining evidence |
| --- | --- | --- | --- | --- |
| GP-BLK-08 | Adopt an operational Gate P definition | PARKED | GP-BLK-11 | The current Gate P instrument is an unsigned draft. Entry and exit rules need an authenticated decision |
| GP-BLK-09 | Decide what `FOR-ACT-S0-001` authoritatively is | PARKED | GP-BLK-08 | A governing source must say whether it is one record or governed Scrum state. Tracker entries alone are not that decision |
| GP-BLK-10 | Select immutable custody and prove a receipt | PARKED | GP-BLK-05, GP-BLK-07 | Destination, WORM or equivalent lock, retention, access rules, and a receipt covering the exact candidate |
| GP-BLK-17 | Preserve the local-only history before custody | PARKED | GP-BLK-10 | This branch is six commits ahead of its remote and has not been pushed. Custody must cover the exact local commits, not an older remote snapshot |
| GP-BLK-12 | Formally accept the Scrum work | PARKED | GP-BLK-03, GP-BLK-08, GP-BLK-10 | Acceptance needs usable evidence, independent review, an explicit decision, and accepted prerequisites. Technical completion is not acceptance |

## Historical evidence that must stay visible

| ID | Blocker | Status | Depends on | Required handling |
| --- | --- | --- | --- | --- |
| GP-BLK-13 | `EV-STAR-05` remains a historical FAIL | PARKED | GP-BLK-12 | Do not overwrite it. A future `EV-STAR-05-R1` may supersede it only with fresh evidence and a digest link |
| GP-BLK-14 | Earlier in-place provenance edit lacks a supersession record | PARKED | GP-BLK-11 | Commit `c0579a4e…` changed `EV-INF-PRE-A09-LOCAL-BRIDGE-00.json` in place. Add an append-only explanation; do not rewrite that commit |
| GP-BLK-15 | Readiness and schema rules cannot yet record a real adoption | PARKED | GP-BLK-08 | Future schema changes must preserve v1.0.0 and add an explicit supersession chain. They are not authorized now |
| GP-BLK-18 | Correct stale review wording without rewriting history | PARKED | GP-BLK-21 | Addendum 2 still says the generator correction needs committing, but that correction is already in `bddfafef7…`. Fix this with a new record |

## Explicitly out of this governance backlog

These are technical leftovers, not reasons to close Gate P:

- `pathtrust` fails on this machine because the user profile itself is inside a Git tree.
- Three HTTP failures were reproduced on both LF and CRLF checkouts.
- The desktop production build was not run because no Rust toolchain was available.
- The removed `validate:raw` script remains a historical failure in `EV-STAR-05`.

## Next action

1. Keep Gate P blocked.
2. Integrate Agents University into StarNet (`GP-BLK-21`).
3. Give the in-product agents this backlog, the committed review packet, and read-only access to the historical evidence.
4. Let those agents execute the parked items in dependency order.
5. Return only exportable evidence. Do not accept, preserve, push, or release from this backlog alone.

## Rollback

If this backlog misstates an item, keep this file and add a new correction naming the item, the reason, the evidence, and the actor. Do not delete the original backlog or any historical evidence.
