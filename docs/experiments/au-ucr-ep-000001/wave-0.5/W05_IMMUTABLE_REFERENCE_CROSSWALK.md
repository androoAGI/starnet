# Wave 0.5 Immutable Reference Crosswalk

## 1. Control record

- **Task:** Wave 2 reconciliation for `FOR-ACT-S0-001-W05-PROVENANCE`
- **Experiment:** `AU-UCR-EP-000001`
- **Repository:** `https://github.com/mrrobot787/starnet.git`
- **Local repository:** `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- **Branch context:** `cursor/populate-authority-readiness-7886`
- **Inspected baseline:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Object format:** `sha1`
- **Prepared:** 2026-10-12
- **Status:** `CROSSWALK_COMPLETE_IDENTITIES_UNPUBLISHED`
- **Publication claim:** none
- **Acceptance effect:** none

This reconciliation inspected the Wave 0.5 schema, fixture, vector, shared-contract/interface and
authority outputs. It did not edit either prior provenance artifact, historical evidence, or any
inspected source. It created only this crosswalk.

## 2. Historical inspected scope and snapshot identity

The Wave 2 inspection scope at that time contained 33 working-tree artifacts in four families:

| Family | Members | Included artifacts |
| --- | ---: | --- |
| Schema and fixtures | 24 | `schemas/README.md`; 8 `*.schema.json`; 14 positive/negative fixtures; `schemas/fixtures/manifest.json` |
| Vectors | 4 | vector JSON bundle, derivation report, generator, reproducer |
| Shared contract | 2 | shared trust/state contract and interface matrix |
| Authority | 3 | authorization input, authority closure package, G3/G4 receipt requirements |

All 33 in that historical scope were untracked and absent from baseline `HEAD`; consequently none
had an index binding,
Git blob/path binding, containing tree, candidate commit, remotely published revision, or
publication receipt.

For reconciliation only, each family was inventoried using sorted repository-relative UTF-8 paths.
For every member the inventory line is:

`path<TAB>raw_byte_count<TAB>raw_sha256<TAB>lf_byte_count<TAB>lf_sha256<LF>`

`lf_sha256` uses `crlf-to-lf-sha256-v1`: replace only every `0d 0a` pair with `0a`. SHA-256 of
the concatenated inventory lines produced:

| Family | Members | Inspection-only inventory SHA-256 |
| --- | ---: | --- |
| Schema and fixtures | 24 | `2dbb34d3b02e94d9df27de3d955eb5bb42d3b43044c73149716d59e3fb7c1d20` |
| Vectors | 4 | `fd3970175cc91b481d0b226c7040ac2e2e6faba725bc496ad3e646fe28a89503` |
| Shared contract | 2 | `a0893e0a542c139a98a5c2ac21d0bd47a7e1383f5ecde15d33bf5befe105db5f` |
| Authority | 3 | `56930e7a19bb6f666d8a1bbb24796496a45271cd5e81a8a2d469c8bf7f39e9be` |

These are historical inspection-snapshot observations, not governed manifests, current family
counts, Git identities, signatures, publication identities, or acceptance evidence. A changed
member, membership set, ordering rule, path, byte count, or byte domain produces a different
family inventory. Later correction work expanded those families; the values above MUST NOT be
used as normative current membership or freeze expectations.

## 3. Family identity crosswalk

### 3.1 Required identity layers

Every family must be bound across these non-substitutable layers:

1. **Raw identity:** exact binary working-tree bytes, byte count, SHA-256, line-ending counts,
   capture platform/time and worktree status.
2. **LF identity:** exact `crlf-to-lf-sha256-v1` byte count and SHA-256; no other normalization.
3. **Schema identity:** exact schema `$id`/version plus canonical schema bytes and digest; every
   external `$ref` resolved by immutable digest, not only a relative path.
4. **Vector identity:** vector bundle ID/version, canonical bundle bytes/digest, generator and
   reproducer identities, source schema/contract digests, expected result and verification class.
5. **Git-object identity:** repository object format, mode, full blob OID and blob SHA-256 for
   every path; full tree and commit OIDs for the exact set.
6. **Published-revision identity:** canonical repository ID, publication service/namespace,
   candidate-content commit/tree, manifest commit or external envelope, manifest SHA-256,
   immutable locator, publisher identity/signature and remote verification.
7. **Acceptance binding:** authorized receipt binding all applicable layers and prerequisite
   receipts for one exact candidate.

### 3.2 Family requirements and current result

| Family | Raw/LF requirement | Schema identity requirement | Vector identity requirement | Git/published-revision requirement | Acceptance binding | Current result |
| --- | --- | --- | --- | --- | --- | --- |
| Schema and fixtures | Each of 24 paths must carry raw and LF byte counts/digests; a manifest must bind exact membership and paths | Bind all 8 schema `$id` values to canonical schema bytes; bind every relative `$ref`; bind each of 14 fixtures to the exact schema digest and expected result; bind fixture manifest bytes | Bind validator implementation/version, validation profile and result receipt; where canonicalization/framing is claimed, bind applicable vectors | Bind 24 path/blob pairs, schema-bundle tree, full commit, repository and published manifest | Acceptance must name schema bundle digest, fixture manifest digest, validation receipt, exact Git objects and published revision | `OBSERVED_ONLY`; no validator execution, Git binding, publication or adoption |
| Vectors | Bind raw/LF identities of all 4 paths; vector JSON is already LF-only at 29,306 bytes and SHA-256 `b074af8678ffdfad3ce688f8fe89d1469eb87d128e071e78311b1c752b0855a1` | Bind the exact event/attestation schemas and shared definitions used to interpret every payload and reason | Bind bundle ID `urn:au-ucr:gpep:vectors:1.0`, 8-vector membership, generator/reproducer bytes, expected preimages/digests, execution receipt and independent reproduction | Bind all 4 blobs, tree/commit, repository, manifest and immutable publication locator | Acceptance must distinguish derived same-agent agreement from independent conformance and bind approved schema/domain/algorithm registries | `DERIVED_NOT_INDEPENDENTLY_VERIFIED`; unpublished and unaccepted |
| Shared contract | Bind exact raw/LF bytes for both documents and their ordered two-file family set | Bind adopted interface/object schemas and immutable algorithm, key-purpose, dependency, state and reason-code registry schemas | Bind conformance vectors for framing, states, precedence, revocation, receipt chains and every adopted interface profile | Bind both blobs, containing tree/commit, repository and publication manifest | Adoption/acceptance receipt must bind both documents together, reconciled schema/vector digests and adoption authority | `SPECIFIED_DESIGN_PROPOSAL`; not adopted, demonstrated or published |
| Authority | Bind exact raw/LF bytes for all 3 records; blank fields remain blank and cannot be inferred | Bind assignment, acknowledgement, decision, closure, acceptance and release receipt schemas by digest | Bind signature, replay, lifecycle ordering, separation and negative authorization vectors where adopted | Bind all 3 blobs, tree/commit, repository and publication manifest; later completed receipts require their own immutable identities | Acceptance requires effective assignments, QA, independent review, closure and Decision Chair receipt for the exact published candidate; G4 remains separate | `GAPS_OPEN`; no effective assignment, acceptance or release |

## 4. Schema and fixture reconciliation

Eight schema documents use JSON Schema draft 2020-12 and versioned `$id` URNs. Fourteen fixtures
are listed by relative path in `schemas/fixtures/manifest.json`. The manifest declares expected
`VALID`/`INVALID` results, but no schema validator was authorized or run.

The schema family contains useful content-level digest fields, but those fields do not establish
the schemas' own immutable identities:

- `common.schema.json` defines SHA-256 and SHA-1 lexical forms and a `digestRef`.
- `digestRef` carries URI, algorithm, digest and one of four proposed hash domains.
- several records carry candidate, policy, registry, evidence or receipt digest values.
- `authorization-a09-decision` and `evidence-acceptance-receipt` carry a 40-hex
  `candidate_commit`.

Those payload fields are future data contracts. They do not digest-pin the eight schema files,
the fixture files, their family manifest, or the current candidate.

## 5. Vector reconciliation

The vector family contains eight vectors and records exact framed inputs and expected SHA-256
values. The derivation report states:

- vector JSON: 29,306 LF bytes;
- bundle SHA-256:
  `b074af8678ffdfad3ce688f8fe89d1469eb87d128e071e78311b1c752b0855a1`;
- genesis hash:
  `f2b8d64cc6e3f50a8af46f37ff35d9843708649ff37bfbd4f00354086f18ddf9`;
- successor hash:
  `985f9c99648478643c886f5d42fe11f2fa0b43a666e528f9de0f8430be02ff2d`;
- single-record attestation-input hash:
  `6e5c1474a899f1986e42aa58522b398e9bd7e955bf8e5102bdf893275238f180`;
- chain attestation-input hash:
  `cb29e2ea4c7624e57714a24f069d60af7eae972b9510b615e0a83989023c0685`.

The generator and reproducer were authored and run by the same lane. Their agreement is derived
consistency, not independent conformance. No ES256 signature values exist, no general RFC 8785
implementation was verified, and no schema validator established that vector payloads conform to
the current schema family.

## 6. Cross-family discrepancies

The following require explicit reconciliation rather than nearest-name inference:

- Vector schema IDs `urn:au-ucr:gpep:event:1.0` and
  `urn:au-ucr:runtime:attestation:1.0` do not identify the current JSON Schema `$id` values
  `urn:au-ucr:wave-0.5:schema:audit-ledger-record:1.0.0` and
  `urn:au-ucr:wave-0.5:schema:attestation-evidence:1.0.0`.
- Vector canonicalization is named `RFC8785-JCS`; schemas use `RFC8785-JCS-UTF8`; the shared
  contract proposes `CANON-JCS-RFC8785-v1`. No adopted registry maps these identifiers.
- Vector negative reasons include `E_HASH_MISMATCH`, `E_DOMAIN_MISMATCH`,
  `E_FRAMING_AMBIGUOUS`, `E_TRUNCATED_INPUT`, `E_VERSION_UNSUPPORTED` and `E_KEY_PURPOSE`.
  The schema enum instead includes generic values such as `E_INTEGRITY`, `E_CANONICAL`,
  `E_VERSION` and `E_POLICY`; the proposed contract registry includes `E_KEY_PURPOSE` but does
  not adopt all vector spellings.
- `AU-RUNTIME-ATTEST-v1` remains provisional. The schema signature object does not bind a
  framing/domain identifier, while the vector bundle assumes a specific framed input.
- The shared contract's proposed registry IDs and profiles have no adopted schema/digest mapping.

No schema ID, reason code, canonicalization name, domain, nearby object or semantically similar
field may be silently substituted for another.

## 7. Open issue register

There are **24 open reconciliation issues**: 7 missing digest/binding issues, 5 ambiguous identity
domain issues, 4 mutable-reference issues, 4 cross-family verification issues and 4
authority-blocked action issues.

### 7.1 Missing digest or binding fields — 7

1. `W05-XW-D01` — No governed 33-member or per-family manifest records every path, raw/LF byte
   count and digest.
2. `W05-XW-D02` — Schema `$id` values are not bound to canonical schema bytes, Git blobs or a
   published revision.
3. `W05-XW-D03` — Relative schema `$ref` targets carry no target digest, object ID or immutable
   publication locator.
4. `W05-XW-D04` — Fixture manifest entries omit schema digest, fixture digest, byte domain,
   validator identity and result-receipt digest.
5. `W05-XW-D05` — Vector bundle does not bind generator, reproducer, schema bundle, contract,
   registry or independent-verification digests.
6. `W05-XW-D06` — Shared contract and interface matrix do not bind their own bytes, each other, or
   adopted registry/schema/vector digests.
7. `W05-XW-D07` — Authority outputs contain intentional blanks and no exact candidate manifest,
   publication receipt, actor assignment, signature or acceptance/release digest chain.

### 7.2 Ambiguous identity domains — 5

1. `W05-XW-A01` — `checkout_bytes` omits byte count, capture platform, line-ending inventory and
   an explicit no-transformation statement.
2. `W05-XW-A02` — `git_blob_lf` conflates Git blob identity with LF normalization; a Git blob is
   exact object bytes and is not inherently an LF-normalized working tree.
3. `W05-XW-A03` — Many scalar `*_digest` fields specify only a 64-hex value, without algorithm,
   byte domain, canonicalization, URI/path, byte count or object binding.
4. `W05-XW-A04` — Canonicalization identifiers differ across schema, vector and contract families
   without an adopted equivalence mapping.
5. `W05-XW-A05` — `candidate_commit` constrains a SHA-1-shaped value but omits object format,
   repository identity, object-type check, root tree and path/blob bindings.

### 7.3 Mutable references — 4

1. `W05-XW-M01` — All 33 inspected artifacts are untracked mutable files outside `HEAD`.
2. `W05-XW-M02` — Relative schema and fixture paths can resolve to changed bytes without their
   textual reference changing.
3. `W05-XW-M03` — Versioned/provisional URNs and registry names are semantic labels, not immutable
   publication locators or content identities.
4. `W05-XW-M04` — Branch names, local paths, filenames and source-trace strings are
   discoverability metadata and can move or change.

### 7.4 Cross-family and verification gaps — 4

1. `W05-XW-X01` — Vector schema identifiers do not map to the current JSON Schema `$id` values.
2. `W05-XW-X02` — Vector, schema and proposed contract reason-code vocabularies are inconsistent
   and not adopted.
3. `W05-XW-X03` — Attestation domain/framing and canonicalization profiles are provisional or
   differently named across families.
4. `W05-XW-X04` — Schema validation, general JCS conformance, ES256 generation/verification and
   independent vector reproduction remain absent.

### 7.5 Actions blocked by authority — 4

1. `W05-XW-B01` — Staging, blob/index creation and candidate/manifest commits are blocked because
   commit authority was not granted.
2. `W05-XW-B02` — Push, remote object publication, immutable locator creation and publication
   receipt issuance are blocked because push/publication authority was not granted.
3. `W05-XW-B03` — Schema/contract adoption, signing and exact-candidate acceptance are blocked
   because effective adoption, publisher and Decision Chair authorities are absent.
4. `W05-XW-B04` — Validator/conformance claims, independent review and G4 release remain blocked
   by missing validation authorization, effective assignments and prerequisite receipts.

## 8. Published-revision and acceptance binding

An immutable Wave 0.5 reference must use either a two-commit model or an external immutable
envelope:

1. a candidate-content commit binds the exact 33 path/blob identities;
2. a manifest commit or external envelope binds that candidate commit/tree, every member, all
   family identities and the final manifest digest without a self-reference cycle;
3. an authorized push makes those exact objects remotely reachable;
4. a signed publication receipt binds canonical repository identity, publication namespace,
   object format, candidate commit/tree, manifest identity, immutable locator and remote
   verification; and
5. later QA, independent review, findings/dependency closure and Decision Chair receipts all bind
   the same published candidate.

The acceptance receipt must bind at least:

- canonical repository identity, not only local path or branch;
- exact candidate-content commit and root tree;
- exact manifest commit/envelope and canonical manifest SHA-256;
- all 33 paths and blob OIDs through the manifest;
- raw/LF identities and declared equality/difference from each blob;
- all 8 schema IDs plus canonical schema digests and immutable `$ref` closure;
- fixture manifest, all 14 fixture digests, validator identity and validation receipt;
- vector bundle ID/digest, all 8 vector IDs, generator/reproducer identities and independent
  verification result;
- shared contract/interface digests and adopted registry/profile mappings;
- authority assignment, acknowledgement, separation, QA, review and closure receipt digests;
- exact decision scope, conditions, residual risks, effective interval and revocation behavior;
  and
- authorized signer identity, key purpose, signature and verification evidence.

Changing any accepted byte, schema, fixture, vector, contract, authority record, path, membership,
Git object or registry mapping requires a new candidate, publication receipt, review chain and
acceptance decision. Publication does not itself constitute acceptance, and acceptance does not
constitute G4 execution release.

## 9. Historical commit-reference preservation

No inspected Wave 0.5 schema, vector, shared-contract or authority output contains or resolves the
historical deterministic-readiness reference. The exact historical value remains:

`2ea38d86a19697b80a827d2dfd83a9219e145532`

Its classification remains **`UNSUPPORTED`**. The distinct local commit
`2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d` was not substituted, and no same-prefix, adjacent,
semantic or inferred replacement was used. **No historical commit substitution occurred.**

## 10. Reproducible read-only checks

Run from repository root in PowerShell:

```powershell
git rev-parse HEAD
git rev-parse --show-object-format
git status --porcelain=v1 -uall
git ls-tree -r --name-only HEAD -- docs/experiments/au-ucr-ep-000001/wave-0.5
git ls-files --others --exclude-standard docs/experiments/au-ucr-ep-000001/wave-0.5
```

```powershell
@'
import hashlib, json, pathlib
root = pathlib.Path("docs/experiments/au-ucr-ep-000001/wave-0.5")
groups = {
  "schema": [root/"schemas/README.md",
             *sorted((root/"schemas").glob("*.schema.json")),
             *sorted((root/"schemas/fixtures").glob("*.json"))],
  "vector": sorted((root/"vectors").glob("*")),
  "contract": [root/"W05_SHARED_TRUST_AND_STATE_CONTRACT.md",
               root/"W05_INTERFACE_MATRIX.md"],
  "authority": [root/"W05_AUTHORIZATION_INPUT_RECORD.md",
                root/"W05_AUTHORITY_CLOSURE_PACKAGE.md",
                root/"W05_G3_G4_RECEIPT_REQUIREMENTS.md"],
}
for name, paths in groups.items():
    lines = []
    for path in sorted(paths, key=lambda p: p.relative_to(root).as_posix().encode()):
        raw = path.read_bytes()
        lf = raw.replace(b"\r\n", b"\n")
        rel = path.relative_to(root).as_posix()
        lines.append(f"{rel}\t{len(raw)}\t{hashlib.sha256(raw).hexdigest()}"
                     f"\t{len(lf)}\t{hashlib.sha256(lf).hexdigest()}\n")
        if path.suffix == ".json":
            json.loads(raw)
    inventory = "".join(lines).encode()
    print(name, len(paths), hashlib.sha256(inventory).hexdigest())
'@ | python -
```

```powershell
$bad  = '2ea38d86a19697b80a827d2dfd83a9219e145532'
$near = '2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d'
git cat-file -t $bad
git cat-file -t $near
git rev-list --all --objects | Select-String '2ea38d86a'
git reflog show --all --format='%H %gD %gs' | Select-String '2ea38d86a'
```

These checks inspect present bytes and Git metadata. They do not validate the schemas, prove
vector independence, adopt contracts, establish authority, publish a revision, or accept a
candidate.

## 11. Final disposition

- Historical families inspected by this Wave 2 crosswalk: **4**
- Historical artifacts inspected by this Wave 2 crosswalk: **33**
- Open reconciliation issues: **24**
  - missing digest/binding fields: **7**
  - ambiguous identity domains: **5**
  - mutable references: **4**
  - cross-family/verification gaps: **4**
  - authority-blocked actions: **4**
- Historical commit substitutions: **0**
- Published revisions: **0**
- Acceptance receipts: **0**

`EXACT PRESENT BYTES OBSERVED -> IMMUTABLE CROSSWALK SPECIFIED -> COMMIT/PUSH BLOCKED -> NO PUBLICATION -> NO ACCEPTANCE`

## 12. A1-NMF-01 membership-status amendment

The 33-member scope, 24-file schema family, 4-file vector family, 2-file contract family and
3-file authority family above are historical Wave 2 inspection boundaries only. They do not
describe current or final package membership. Later correction and assurance work added schemas,
fixtures, vector programs, registries, authority requirements, review amendments and other
outputs.

Normative candidate membership, counts and digests MUST be generated only at an authorized freeze
under `W05_NESTED_CANDIDATE_MANIFEST_SPEC.md`. The freeze MUST recursively enumerate every
in-scope Wave 0.4 and Wave 0.5 path at the declared cutoff, including all subsequent:

- schema, fixture, vector and verification outputs;
- contract, registry, authority and provenance outputs;
- reconciliation and integration reports;
- review and assurance amendments;
- trackers and Scrum/status records;
- gate/decision packages; and
- findings/dependency-closure, publication, amendment and revocation outputs.

The freeze generates exact leaf/family/wave/root counts and digests. It must not consume any
historical count in this document. A later file addition or byte change invalidates the affected
generated identities and requires a new sequence or review overlay.

No new inventory or reconciliation report is created here; current reconciliation remains Agent
C's ownership. No manifest, Git object, commit, push, publication or acceptance was instantiated.
All current artifacts remain untracked.

The exact historical reference
`2ea38d86a19697b80a827d2dfd83a9219e145532` remains `UNSUPPORTED`; the distinct local object
remains non-substitutable.
