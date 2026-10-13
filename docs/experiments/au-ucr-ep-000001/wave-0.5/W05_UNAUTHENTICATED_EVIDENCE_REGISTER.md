# Wave 0.5 Unauthenticated Evidence Register

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-PROVENANCE`
- **Experiment:** `AU-UCR-EP-000001`
- **Inspected baseline:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Prepared:** 2026-10-12
- **Status:** `UNAUTHENTICATED_EVIDENCE_REGISTERED`
- **Publication claim:** none
- **Acceptance effect:** none

“Unauthenticated” means that present bytes can be observed and hashed but are not bound to a
resolvable candidate Git commit, immutable publication receipt and authorized publisher. It does
not mean the files are corrupt. This register is append-only documentation and does not modify,
adopt, accept or publish any listed artifact.

## 2. Repository and worktree observation

The inspected repository is `https://github.com/mrrobot787/starnet.git`, local branch
`cursor/populate-authority-readiness-7886`, object format `sha1`. Baseline `HEAD` is exactly
`39bade0506b4d5b12bb979ccf6a51bb11944a9ff`.

Exactly 20 Wave 0.4 Markdown artifacts were historically observed as present and untracked. No
Wave 0.4 path existed in the
baseline tree. Before this provenance task wrote its two authorized documents, `git status
--porcelain=v1 -uall` reported 23 untracked files: 20 Wave 0.4 plus three existing Wave 0.5
documents, with no tracked modifications. The two files produced by this task necessarily add two
new untracked Wave 0.5 paths; they do not alter the 20-item Wave 0.4 count or authenticate it.
Post-write verification observed concurrent Wave 0.5 lanes increase the worktree first to 40 and
then to 44 untracked files; the latter snapshot contained the same 20 Wave 0.4 artifacts and 24
Wave 0.5 paths. `HEAD` remained unchanged and there were still no tracked modifications. This
changing count is concurrent uncommitted work, not publication. This task created only its two
directed files. All counts in this paragraph are historical observations, not normative candidate
membership.

## 3. Exact observed candidate bytes

`Raw SHA-256` is over exact current Windows working-tree bytes. `LF SHA-256` uses
`crlf-to-lf-sha256-v1`: replace only every CRLF pair with LF. Every row has authentication status
`NO_GIT_OR_PUBLICATION_BINDING`.

| Wave 0.4 artifact | Raw bytes | Raw SHA-256 | LF bytes | LF SHA-256 |
| --- | ---: | --- | ---: | --- |
| `A-04_REVISED_RUNTIME_ATTESTATION_SPEC.md` | 18,640 | `3c3bc08ff3b18490dcf279790ff841b7a2cc22baa06b0800d339a7da791f0560` | 18,386 | `de33618489037cf8874843e192f7381801a84c2c93508ddd697568183d48b053` |
| `B-03_REVISED_EXECUTABLE_ENFORCEMENT_SPEC.md` | 21,495 | `bc6cd09ddccdf084537d9f76140e22c3880f3c8f7873b816e8b427381e706659` | 21,229 | `74acbb2027b86658bd20a570d5463224da4327653f68a920cad2ab682b653aa1` |
| `C-04_REVISED_AUTHORITY_PACKAGE_DRAFT.md` | 10,835 | `1c6821ac4262c7ff97f974f52fd18a7d300aec9a4e2f929a598be8bc6d84b551` | 10,605 | `9197aa2e3c4aad3fee192f7066352ddf967c1ce21fde24970f92914e415fd865` |
| `D-03_AMENDMENT-1_POST_CORRECTION_REVIEW.md` | 14,271 | `8a0b3c953683fdaaea691569faddd1827fdb87d38c7902689881a342dbdae803` | 14,018 | `cb7a33ee17d752d932b557c3e4348a817d22524631ee4c7d44bde5ec51a71952` |
| `D-03_INDEPENDENT_WAVE_0.4_ASSURANCE_REPORT.md` | 26,674 | `4ac662b1baaa764e41984269af3a251c94ba025b2734a4030d76f95003758134` | 26,296 | `b2ca983eb25e9fd8ddb4f4e01a6abb89fa8fe5e3995c4802c76355383d5e7fb5` |
| `GATE-04_PROPOSED_DECISION_PACKAGE.md` | 12,604 | `fa8c82bc3dff5a53ad446bb0e509466eb9c8cdeb7156f44511daaf4bea25367b` | 12,319 | `b51e312ff0f3ebda8fe61618bb534dce8172c17dc06ec4cec5afcfe00a2e5736` |
| `LAB-03_REVISED_ISOLATION_SPEC.md` | 26,492 | `1beac099d6c59699635a4f934a629712fcfe159763c7db82d78d004ce9a3d9bc` | 26,249 | `39f0bc3bf52708405c3af9ef23a98f8586f6d21ca0ff5f0345a68cdaaacff039` |
| `SCRUM04_RECONCILIATION.md` | 12,999 | `a50dddf3028c053f743519348909b627f998d2b0cd5d1409a6c8b1bc38c9f971` | 12,732 | `4fe2b8cc9e0fec2872d354fabc110486185c199548a58e9d197ec5325cc079b6` |
| `W04_BASE_VERIFIED_REPOSITORY_AND_ARTIFACT_INVENTORY.md` | 7,238 | `138fee96b2513736c7baaf84bfc835aee251eb6469dd18a0103ad06250a62512` | 7,123 | `2c027ad717acfbdfeeb8678456e94451049bebc4f744e432330202869f1122b5` |
| `W04_CONTROLS_OBJECTION_RESOLUTION_MATRIX.md` | 9,059 | `f54154d72e279789502d47bbafc17eda13532f49868aeff57cb6a03f60463e01` | 8,930 | `6479d9b6c82615431db9b7d7bf5a45ecb0ae20bf3db8af70197c4d0152d3f80a` |
| `W04_CONTROLS_RESIDUAL_RISK_REGISTER.md` | 15,162 | `7152e68f1777406b24c03ea115bed81b3507b3aa571409c147774874ddadeee2` | 14,928 | `fc8c68275735b0b2cc1e6f5e26b9b538c32806e0aa5232e5362c1a11514ad3be` |
| `W04_D03_REVIEW_PREPARATION.md` | 31,270 | `9d7e6879f37df299e1084589c4296104034d8e4aee94825d78e4dac51918526c` | 30,983 | `7936cd7ed4bbda66f03efa861008357ee0f7186c1f283447934e4f050a26eebd` |
| `W04_EVIDENCE_INTEGRITY_FINDINGS.md` | 14,503 | `6d9341d429c684cf8e37de7aa215416bda884e5a7137b05ea4eae73d20e46e93` | 14,256 | `13b6c0eb9e8e53b4432b4401d09e29b65005b9ae1969945e29a2e7ddcbcb8580` |
| `W04_GOVERNANCE_DEPENDENCY_MAP.md` | 7,617 | `05c05cbafb33a033bdbdbab5a3e77004756c9241f0dd8bfbb95bc9e09751b5b4` | 7,462 | `b0cc4be29423cdf6138964a3536a72bbd5383b1349e48dc00851e882a15b58a5` |
| `W04_HASH_DOMAIN_POLICY.md` | 13,366 | `f02a762b9553a729052fa135c78788ba2d5072573a0d582742903266afa399b2` | 13,033 | `8d1479529eb3e67553a02fa2c19dae7a13984fc16d159cd7c7526f351b06d96c` |
| `W04_LAB_ISOLATION_ACCEPTANCE_CHECKLIST.md` | 15,509 | `6ddba05d88056e802b5f10371b88b57e4357f219aa9a87aa74733991e5ba42f2` | 15,341 | `1b0870c96c372d29408615de131112fdba83acfcad335d9ac020863f09a1aeaa` |
| `W04_LAB_RESIDUAL_RISK_AND_REUSE_ASSESSMENT.md` | 17,029 | `9526946801f8c1e0d86536874da104eab8d35454f54a917b8c72fe219a98c20e` | 16,785 | `a3f71bcd00855115be26add74abdbc3f3ee7c97c3e44043c3f19d80a9bcd9fdf` |
| `W04_MISSING_AUTHORIZATION_REGISTER.md` | 6,865 | `d88198e380c1cc51dc7a6113f8bd581e687fb880b37044130a32b6890665ef14` | 6,666 | `456f2585b0146f0f16637c47c69717f233f3deef5b4960ff248843ee7cc09b4b` |
| `W04_SCRUM_AUTHORITATIVE_TRACKER.md` | 7,769 | `15ca1353d195351d246637c2011938ffb27957da9487f89c8059afc6d92ad7ee` | 7,646 | `9ba4c63a2ccd042d99049326cf9165680bed56b9f76120b222456edc2ac82262` |
| `W04_VERIFICATION_REPORT.md` | 5,856 | `3dc16c9d7db1ceab579729f50b4bc28810296f6f7cb78fcf8b5dd095f0d85357` | 5,737 | `a9c0bd10c49677e71d2daeb1dcce02501e029ef790b1db0fcf280b598115aba0` |

These values identify observed content domains only. They are not a signed manifest, a Git
candidate, a publication receipt or an acceptance receipt.

## 4. Unauthenticated-evidence findings

### `W05-UE-01` — Wave 0.4 package has no Git candidate identity

- **Affected evidence:** all 20 rows above.
- **Observed:** paths are untracked and absent from `HEAD`.
- **Cannot authenticate:** index modes/OIDs, blob OIDs, tree binding, candidate commit or remote
  object reachability.
- **Required closure:** an authorized freeze, commit and independently verified manifest/receipt.
- **Status:** `BLOCKED_MISSING_COMMIT_AND_PUSH_AUTHORITY`.

### `W05-UE-02` — No immutable candidate manifest

- **Observed:** byte inventories exist, but no canonical 20-entry manifest is bound to a Git object
  or signed immutable envelope.
- **Cannot authenticate:** exact candidate set, canonical serialization, manifest final bytes,
  generator, generation time or supersession.
- **Required closure:** the design in `W05_PUBLICATION_AND_PROVENANCE_SPEC.md`, independently
  reproduced and authorized.
- **Status:** `OPEN`.

### `W05-UE-03` — No publication receipt

- **Observed:** no immutable remote locator, remote object verification, publisher identity,
  signature, timestamp/transparency record or revocation evidence exists.
- **Cannot authenticate:** that any exact candidate was published by an authorized actor.
- **Required closure:** authorized push/publication followed by an independently verified receipt.
- **Status:** `BLOCKED_MISSING_PUSH_PUBLICATION_AUTHORITY`.

### `W05-UE-04` — No exact-candidate acceptance

- **Observed:** Decision Chair is unassigned and no acceptance receipt exists.
- **Cannot authenticate:** acceptance of exact bytes, objects, revision, repository, manifest or
  publication receipt.
- **Required closure:** effective role assignment plus a separate digest/object-specific decision.
- **Status:** `BLOCKED_BY_GOVERNANCE`.

### `W05-UE-05` — Hash-domain policy is not adopted

- **Observed:** `W04_HASH_DOMAIN_POLICY.md` proposes distinct raw, LF, Git and manifest domains.
- **Cannot authenticate:** governed adoption or mandatory enforcement of that convention.
- **Required closure:** authorized adoption and version/digest binding without retroactive
  redefinition.
- **Status:** `OPEN`.

### `W05-UE-06` — Exact deterministic commit reference is unsupported

- **Original referenced value:** `2ea38d86a19697b80a827d2dfd83a9219e145532`.
- **Classification:** `UNSUPPORTED`.
- **Observed:** exact object absent from objects, refs, object traversal, reflogs and no-reflog
  unreachable-object inspection; no independent immutable support supplies its tree, parents,
  signature or locator.
- **Distinct comparison object:** `2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d`.
- **Substitution rule:** prohibited; the comparison object is not the referenced object.
- **Cannot authenticate:** the deterministic execution claim as commit-bound to the exact original
  reference.
- **Required closure:** append-only correction or independent immutable proof under authority.
- **Status:** `UNSUPPORTED_REFERENCE_PRESERVED`.

### `W05-UE-07` — Historical execution cannot be recreated by hashing

- **Observed:** current receipt bytes and dependency graph can be inspected.
- **Cannot authenticate:** that historical commands ran in the claimed environment, by the claimed
  producer, against the claimed revision, or produced the recorded output.
- **Required closure:** valid historical provenance or a newly authorized execution with a new
  receipt; never rewrite the historical receipt.
- **Status:** `OPEN`.

### `W05-UE-08` — Repository naming is not immutable repository identity

- **Observed:** local path and GitHub remote URI are known.
- **Cannot authenticate:** stable repository namespace ownership and publication authority from
  those strings alone.
- **Required closure:** an approved stable repository identifier in the manifest and receipt,
  bound to the publication service/namespace.
- **Status:** `OPEN`.

## 5. Explicit authority blocker

The Wave 0.5 authorization input permits documentation preparation but does not authorize commit,
push, publication, signing, PR merge or acceptance. Consequently this task cannot convert the
observed 20 files into immutable evidence. Specifically blocked actions are:

- staging and committing the candidate or manifest;
- pushing Git objects or refs;
- creating or updating a publication PR as a substitute for push authority;
- signing or publishing a manifest/receipt;
- claiming remote reachability;
- accepting the candidate; and
- substituting any nearby commit for an unavailable exact reference.

No silent commit substitution occurred.

## 6. Reproducible read-only checks

```powershell
git rev-parse HEAD
git branch --show-current
git remote get-url origin
git rev-parse --show-object-format
git status --porcelain=v1 -uall
git ls-tree -r --name-only HEAD -- docs/experiments/au-ucr-ep-000001/wave-0.4
(git ls-files --others --exclude-standard `
  docs/experiments/au-ucr-ep-000001/wave-0.4/*.md).Count
```

```powershell
@'
import hashlib, pathlib
root = pathlib.Path("docs/experiments/au-ucr-ep-000001/wave-0.4")
paths = sorted(root.glob("*.md"), key=lambda p: p.as_posix().encode("utf-8"))
assert len(paths) == 20
for p in paths:
    raw = p.read_bytes()
    lf = raw.replace(b"\r\n", b"\n")
    print(p.name, len(raw), hashlib.sha256(raw).hexdigest(),
          len(lf), hashlib.sha256(lf).hexdigest())
'@ | python -
```

```powershell
$bad  = '2ea38d86a19697b80a827d2dfd83a9219e145532'
$near = '2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d'
git cat-file -t $bad
git cat-file -t $near
git rev-list --all --objects | Select-String '2ea38d86a'
git reflog show --all --format='%H %gD %gs' | Select-String '2ea38d86a'
git show-ref
git fsck --full --no-reflogs --unreachable --no-progress
```

These checks are non-destructive. A failed `git cat-file -t $bad` is the expected unsupported
result, not permission to infer or substitute `$near`.

## 7. Final disposition

Current-byte observations are reproducible, but immutable provenance and publication are absent.
`W05-OBJ-03`, `W05-OBJ-04`, `W05-OBJ-05` and the publication portion of `W05-OBJ-09` remain
`BLOCKED BY DEPENDENCY`. No publication, acceptance, execution, merge or release claim is made.

## 8. F04-NMF-05 scope and hierarchy addendum

### `W05-UE-09` — Complete nested candidate hierarchy is specified but not instantiated

- **Finding source:** `F04-NMF-05`.
- **Observed correction:** `W05_NESTED_CANDIDATE_MANIFEST_SPEC.md` defines seven levels:
  `L0` artifact records, `L1` family manifests, `L2` wave manifests, `L3` reviewed source root,
  `L4` decision-package root, `L5` publication receipt and `L6` governance receipt chain.
- **Required scope:** every Wave 0.4 and Wave 0.5 artifact dynamically enumerated at the authorized
  cutoff, including every control, schema, fixture, vector, contract, authority, provenance,
  reconciliation, review, amendment, tracker and gate output.
- **Cannot authenticate:** any actual child manifest, wave root, reviewed source root, decision
  package, Git binding, publication envelope or governance receipt.
- **Status:** `DESIGN_SPECIFIED_NOT_INSTANTIATED`.

At the pre-addendum snapshot, Wave 0.5 contained 44 untracked files. Concurrent authority and
contract lanes then added `W05_AUTHORITY_SCHEMA_REQUIREMENTS.md` and
`W05_VERSIONED_REGISTRY.md`; adding the nested specification produced a 47-file historical
observation. F-04 Amendment 1 later recorded 77 files before its creation and identified itself as
the 78th. None of 44, 47, 77 or 78 is normative current membership. The final count and digest are
unknown until authorized freeze enumeration. All observed files remained outside baseline
`HEAD`.

### `W05-UE-10` — Current F-04 review does not bind the corrected candidate

- **Observed:** F-04 measured and reviewed 43 pre-F-04 Wave 0.5 inputs.
- **Changed provenance scope:** this addendum revises two provenance artifacts and adds the nested
  manifest specification.
- **Cannot authenticate:** that F-04 reviewed these corrected bytes or the final complete set.
- **Required closure:** freeze an L3 reviewed source root, publish it under authority, obtain
  candidate-bound QA and effective independent re-review, then bind those outputs at L4.
- **Status:** `RE_REVIEW_REQUIRED_AFTER_FREEZE`.

### Nested unauthenticated identities

Until an authorized publisher completes the hierarchy:

- L0 raw/LF observations have no index/blob/tree/commit binding;
- L1 family membership remains mutable;
- L2 wave roots do not exist;
- L3 has no immutable reviewed candidate;
- L4 has no complete decision package;
- L5 has no remote locator, publisher signature or publication receipt; and
- L6 has no valid QA, review, closure or Decision Chair acceptance chain.

One transferred object or child family would not authenticate its parent. A partial transfer MUST
be recorded as `PUBLICATION_FAILED_QUARANTINED`, must not issue a success receipt, and must not
displace any prior published candidate. Amendment and revocation require new append-only,
externally bound receipts and MUST NOT rewrite prior bytes.

### Updated authority blocker

No actual freeze, stage, commit, push, signature, locator, publication receipt, amendment receipt,
revocation receipt or acceptance may be created under the current authority. Documentation design
does not grant commit/push/publication authority. The current files remain untracked.

The exact historical deterministic reference
`2ea38d86a19697b80a827d2dfd83a9219e145532` remains `UNSUPPORTED`. The distinct local
`2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d` was not substituted.

### Updated register counts

- unauthenticated-evidence findings: **10**
- normative hierarchy levels: **7**
- instantiated hierarchy levels: **0**
- open nested-manifest blockers: **10**
- historical commit substitutions: **0**
- publication/acceptance claims: **0**

## 9. A1-NMF-01 dynamic-membership finding

### `W05-UE-11` — Embedded counts are historical, not manifest cardinality

- **Finding source:** `A1-NMF-01`.
- **Observed:** successive mutable snapshots reported different package and family counts as
  additional schemas, vectors, registries, amendments and assurance outputs arrived.
- **Correction:** `W05_NESTED_CANDIDATE_MANIFEST_SPEC.md` now makes authorized dynamic enumeration
  the sole source of candidate membership, count and digest.
- **Required freeze coverage:** every in-scope file at cutoff, including all subsequent reviews,
  assurance amendments, reconciliation/integration outputs, trackers, gate/decision packages,
  publication records and closure outputs.
- **Cannot authenticate:** a current count, family count, family digest or candidate root before
  that freeze.
- **Status:** `MEMBERSHIP_UNDETERMINED_FREEZE_UNAUTHORIZED`.

The freeze must generate each family count/digest and L0-L4 total/root count/digest from sorted
enumerated paths. It must not read an expected count from this register or another narrative.
Any post-cutoff mutation creates a new candidate sequence or review overlay.

No freeze, manifest, commit or publication was performed. Agent C owns current reconciliation;
this register does not create a competing current reconciliation report.

The exact historical reference
`2ea38d86a19697b80a827d2dfd83a9219e145532` remains `UNSUPPORTED`; no substitution occurred.

Updated status:

- unauthenticated-evidence findings: **11**
- normative current membership count/digest: **UNDETERMINED UNTIL AUTHORIZED FREEZE**
- instantiated hierarchy levels: **0**
- publication/acceptance claims: **0**
