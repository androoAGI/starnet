# Wave 0.6 Unresolved Evidence Limitations

## Control record

- Experiment: `AU-UCR-EP-000001`
- Prepared: `2026-10-12`
- Status: `LIMITATIONS_EXPLICIT_NO_CLOSURE_INFERRED`
- Acceptance/publication/release effect: none

## Current limitations

### `W06-LIM-01` — Wave 0.4 and Wave 0.5 are mutable

All 20 Wave 0.4 and all 88 Wave 0.5 files are untracked and absent from current `HEAD`. They have
no index mode, blob OID, tree binding, containing commit, remote immutable locator or publication
receipt. Current raw/LF hashes identify observed bytes only.

### `W06-LIM-02` — Wave 0.6 outputs are also not a freeze

The records in this directory are new working-tree documentation. They are not staged, committed,
published, independently reviewed or accepted. Their creation changes future candidate membership,
so all present counts remain observations rather than authorized freeze totals.

The final technical package's `W06_TECHNICAL_FREEZE_MANIFEST.json` is a useful local exact-byte
technical freeze: 54/54 normative entries hash-match. It is still mutable and untracked, has no
Git commit/tree or remote locator, and is not an authorized immutable publication freeze.

### `W06-LIM-03` — Exact historical commit is unsupported

`2ea38d86a19697b80a827d2dfd83a9219e145532` is unresolved and lacks independent immutable proof.
`2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d` is a distinct resolvable object and cannot be used as
a substitute. The deterministic historical execution claim is not reliably bound to its stated
commit.

### `W06-LIM-04` — Current hashing cannot authenticate historical execution

Present receipt bytes, manifest equality and graph structure do not prove that a historical
command ran in `/workspace`, against the claimed revision, by the claimed actor or with the
recorded output. No historical execution was rerun.

### `W06-LIM-05` — PRE_A09 manifest lacks an explicit domain

All nine entries currently match LF/index/`HEAD` content, and none matches raw Windows CRLF bytes.
The manifest itself omits domain, byte counts, repository identity, commit, generation time,
generator, duplicate-path policy, signature and external self-binding. Its technical consistency
does not make it an immutable publication manifest.

### `W06-LIM-06` — Repository line-ending policy is not pinned

No applicable repository `.gitattributes` pins evidence line endings. `core.autocrlf=true` is
machine configuration, not repository policy. Raw checkout identity remains platform-dependent,
and the Wave 0.4 hash-domain policy remains an unadopted draft.

### `W06-LIM-07` — Complete hierarchy is specified but absent

The L0-L6 nested model prevents self-review and incomplete scope in design, but zero hierarchy
levels have been instantiated as immutable objects. There is no L3 reviewed source root, L4
decision package, L5 publication receipt or L6 governance chain.

### `W06-LIM-08` — Historical review does not cover final bytes

F-04 reviewed a pre-correction input set. Later nested-manifest, membership, reconciliation and
metadata corrections are outside that review scope. A future frozen L3 candidate requires new
candidate-bound QA and an effectively assigned independent review.

### `W06-LIM-09` — Validation exists but remains bounded and non-operational

Final permitted local verification passed 15/15 checks. It established:

- 35 schemas meta-valid and 576/576 local references resolved;
- 33 concrete/instantiable schemas and 2 definition-only helpers;
- 162/162 full-document outcomes, including 125/125 negative cases rejected for intended reasons;
- 57/57 subschema pairs, or 114 outcomes;
- 8/8 directly mapped positive vector instances schema-valid; and
- 54/54 technical-freeze entries matching declared raw size and SHA-256.

The earlier limitation that only one family had active full-document coverage is superseded.
Residual limits are different: fixtures, generator and schemas share package authorship; one
installed JSON Schema implementation supplied validation; JSON Schema cannot prove operational
cross-object/state semantics; and no stateful consumer, runtime or operational test was performed.

### `W06-LIM-10` — Vector bytes reproduce, but operational trust remains unproven

The 14-vector bundle reproduced byte-for-byte. The source and regenerated bundle were both
204,024 bytes with SHA-256
`b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`;
8/8 directly mapped positive instances were schema-valid.

Ephemeral ES256/P1363 low-S mechanics passed with an in-memory P-256 key, including genuine
sign/verify, DER-to-P1363 conversion, low-S normalization, unpadded base64url round-trip and
high-S profile rejection. Bounded Node cross-runtime canonicalization also passed.

This proves the tested primitive/encoding and bounded canonicalization mechanics, not package key
authority or operational trust. The vector bundle's `r=1,s=1` values remain synthetic sentinels
and were not verified as genuine signatures. A complete third-party RFC 8785 conformance suite,
operational trust/authority/revocation, stateful consumer behavior, adoption, immutable publication
and candidate-bound governance review remain NOT_RUN or absent.

### `W06-LIM-11` — Authority chain is incomplete

Effective stable identities, mandate/delegation chain, assignments, acknowledgements,
separation/conflict receipts, Publication Custodian, QA, Independent Reviewer and Decision Chair
evidence remain absent or insufficient. Human-readable names, agent labels, OS identity,
repository access and authorship do not create authority.

### `W06-LIM-12` — No acceptance or execution release exists

A09 remains unresolved; G3 remains closed and blocked by dependency; G4 remains not authorized.
No publication, QA, findings-closure, Decision Chair acceptance or exact-run release receipt
exists for the current package.

### `W06-LIM-13` — Baseline and operational evidence remain outside this task

Historical baseline failures/blocked readiness were not dispositioned. No implementation,
laboratory construction, runtime control, negative test, operational test or rollback test was
authorized or run.

### `W06-LIM-14` — Duplicate representations require normalization

The filesystem has 117 unique Wave 0.3-0.5 files and no normalized duplicate or case collision.
However, tooling and status snapshots may display the same Windows path once with `/` and once
with `\`. Consumers must canonicalize repository-relative paths to UTF-8 forward-slash form before
duplicate checks and must not count display variants as separate evidence.

### `W06-LIM-15` — No authenticated Bugbot receipt was found

No inspected prior-wave file contains a literal Bugbot attribution or immutable Bugbot review
receipt. Historical-count, circular-dependency and self-review concerns are addressed as technical
findings only. No reviewer identity, independence, authority or acceptance is inferred.

## Residual dependencies

1. Explicit freeze/commit and push/publication/signing authority.
2. Effective publisher, QA, reviewer, closure and Decision Chair assignments.
3. Adopted manifest schema, canonicalization, path and hash-domain policies.
4. Authorized dynamic freeze with concurrent-write exclusion.
5. Complete L0-L5 Git/publication identities and independent remote remeasurement.
6. Independent/candidate-bound assurance, complete third-party RFC 8785 conformance, operational
   key/trust/authority/revocation verification and stateful consumer enforcement beyond the
   completed local checks.
7. Candidate-bound QA and independent review with findings/dependency closure.
8. Append-only disposition or independent immutable proof for the unsupported commit.
9. Exact-candidate G3 decision and, only if accepted, a separate G4 release.

## Check summary

- Current evidence files inventoried: 127.
- Current Wave 0.3-0.5 files: 117.
- QA receipt/manifest files: 10.
- Tracked/current-`HEAD`: 19.
- Untracked prior-wave files: 108.
- Normalized duplicate paths: 0.
- Manifest entries/matches/mismatches: 9 / 9 / 0.
- Receipt graph nodes/edges/missing/cycles: 9 / 14 / 0 / 0.
- Wave 0.5 JSON parse results: 52 passed / 0 failed.
- Final technical verification checks: 15 passed / 0 failed.
- Technical-freeze manifest entries/hash matches: 54 / 54.
- Schema meta-validation and local references: 35/35 and 576/576 passed.
- Schema classification: 33 concrete / 2 helpers.
- Full-document outcomes: 162/162, including 125/125 intended negative reasons.
- Subschema pairs/outcomes: 57/57 and 114/114 passed.
- Directly mapped positive vector instances: 8/8 schema-valid.
- Vector bundle reproduction: 14/14 scenarios, byte-for-byte match.
- Ephemeral ES256/P1363 low-S mechanics: passed.
- Bounded Node cross-runtime canonicalization: passed.
- Complete third-party RFC 8785 suite and synthetic sentinel verification: NOT_RUN.
- Operational trust/authority/revocation, stateful consumer and operational tests: NOT_RUN.
- Publications, commits, pushes, merges and acceptances performed: 0.

Final disposition:

`BYTES VERIFIED READ-ONLY -> LINEAGE RECONCILED -> LIMITATIONS EXPLICIT -> IMMUTABLE CANDIDATE ABSENT -> G3 CLOSED -> G4 NOT AUTHORIZED`

