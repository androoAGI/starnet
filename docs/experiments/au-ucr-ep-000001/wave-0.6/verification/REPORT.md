# Wave 0.6 Agent B — Wave 0.5 Verification Report

## Scope and classification

This report records independent execution by the Wave 0.6 Agent B activity against the local
Wave 0.5 schema, fixture, registry/contract, vector, manifest, hash, and script artifacts.

- Repository baseline observed: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Branch observed: `cursor/populate-authority-readiness-7886`
- Python: `3.13.7`
- Preinstalled validator: `jsonschema 4.26.0`
- Dependencies installed: none
- Source artifacts modified: none by this activity
- Output boundary: `wave-0.6/verification/` only
- Operational, runtime, lab, sandbox, browser, and network tests: not run
- Commit, push, publication, merge, approval, or adoption action: none

The executed checks below are local, non-operational validation and reproducibility evidence.
They do not establish governance adoption, operational enforcement, authority, provenance, or
cryptographic trust.

## Overall result

`PASS — 17/17 local non-operational checks passed; 0 executed check failures`

The machine-readable source of truth is `results.json`. The full 88-file Wave 0.5 byte inventory
is `wave05_inventory.json`.

## Executed PASS results

### JSON, schemas, and references

- Strict duplicate-key-aware JSON parsing: **51/51 PASS**
  - 35 schema documents
  - 16 fixture JSON documents
- Unique schema IDs: **35/35 PASS**
- Canonical schema ID/draft checks: **35/35 PASS**
  - each ID starts with `urn:au-ucr:schema:`
  - each ID ends with `:1.0.0`
  - each declares JSON Schema draft 2020-12
- Draft 2020-12 meta-schema checks using `Draft202012Validator.check_schema`: **35/35 PASS**
- Local `$ref` and JSON Pointer resolution: **576/576 PASS**
- Unresolved references: **0**
- Duplicate schema IDs: **0**

These are actual parser, meta-schema, and local-reference results. They do not prove semantic
constraints that JSON Schema cannot express.

### Fixtures and manifest

- Fixture manifest internal count/file consistency: **PASS**
- Active full-document outcomes: **2/2 PASS**
  - positive governed-audit-event fixture accepted
  - single-defect negative governed-audit-event fixture rejected
- Subschema unit outcomes: **114/114 PASS**
  - 57 positive values accepted by their target subschemas
  - 57 negative values rejected by their target subschemas
- Fixture JSON Pointers resolved: **57/57 PASS**
- Retired pre-correction full-document fixture membership: **12/12 files present**

The 12 retired fixtures were intentionally not counted as current expected outcomes, matching the
manifest. Subschema unit success is not complete-object validation.

### Canonical vectors, scripts, and hashes

- Bundle scenarios/counts: **PASS**
  - 14 unique scenarios
  - 2 positive
  - 12 negative
- Bundle size: **204,024 bytes**
- Bundle SHA-256:  
  `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`
- Registry-reported bundle digest match: **PASS**
- Python syntax/compilation checks: **4/4 vector scripts PASS**
- Existing read-only reproducer: **PASS**
  - direct schema-instance design mappings: 8
  - semantic byte checks: 15
  - digest checks: 22
  - signature-profile shape checks: 5
  - oracle checks: 14
  - result: `ALL_REGISTRY_1_3_DERIVED_BYTES_REPRODUCED`
- Isolated generator reproduction: **PASS**
  - generator scripts were copied into a temporary directory under `wave-0.6/verification/`
  - generated bundle was byte-for-byte identical to the Wave 0.5 bundle
  - regenerated SHA-256 matched the digest above
- Positive vector direct-instance schema validation: **8/8 PASS**
  - 3 governed-event payload occurrences
  - 3 external ledger-envelope occurrences
  - 2 ledger-head attestation occurrences

The generator was not executed in Wave 0.5, because it writes its bundle beside itself. Isolated
copy execution preserved prior-wave artifacts.

### Registry and contract design review

- Required contract files present: **PASS**
- Registry/bundle literal alignment for framing/signing profile, signature encoding, ledger
  domain, attestation domain, registry ID, and registry version: **PASS**
- `IF-01` through `IF-22` presence in both registry and interface matrix: **22/22 PASS**

This is literal and structural design alignment, not proof that an implementation enforces any
interface.

### Artifact inventory

- Wave 0.5 files inventoried: **88**
- Per-file SHA-256 and byte length recorded: **88/88**
- Deterministic inventory aggregate SHA-256:  
  `daf4d914df7cc10207cf0d4d58545f48815e789c2aaeb4819543ec1ca2a6c4de`
- Aggregate construction:  
  `SHA256(path_utf8 || NUL || decimal_size || NUL || file_sha256_ascii || LF)` in sorted path order

This aggregate identifies the inspected mutable local snapshot. It is not a publication,
commit-tree, signature, or immutable provenance receipt.

## Executed FAIL results

None. All 17 checks represented in `results.json` passed.

This does not convert unavailable, prohibited, or design-only checks into passes.

## Design review observations

1. Only one schema family has current active full-document positive/negative fixtures:
   `governed-audit-event`. The remaining current fixture coverage is subschema-unit coverage.
2. The positive vectors are accepted by the three directly mapped schema families, but their
   signature value is the documented synthetic `r=1, s=1` shape and is not a valid ES256
   signature over the payload.
3. The 12 negative vector expected outcomes are internally reproduced as declared oracles. No
   consumer implementation executed those rejection paths.
4. JSON Schema cannot establish sequence arithmetic, predecessor linkage, legal state
   transitions, replay consumption, timestamp ordering, identity equality/separation, hash
   recomputation, signer authority, revocation state, or trust-chain validity.
5. The registry, schemas, fixtures, vectors, and inventory remain local proposed-design
   artifacts. Their internal consistency does not establish adoption or immutable publication.

## Unavailable or prohibited checks

The following were not executed and are not classified as passing:

- generalized RFC 8785 conformance beyond the documented fixture subset;
- ES256 signing or verification;
- malformed-signature, wrong-key, high-S, DER, or trust-root cryptographic execution;
- authority assignment, acknowledgement, separation, identity, key status, or revocation
  verification;
- stateful consumer behavior for replay, transition, sequence, fork, rollback, or negative
  oracle enforcement;
- runtime, operational, lab, sandbox, browser, or network tests;
- authorized candidate freeze, publication, independent retrieval, or remeasurement;
- formal QA, independent governed review, G3 acceptance, or G4 exact-run release;
- dependency installation;
- commit, push, merge, publication, approval, or adoption.

## Commands executed

From repository root:

```text
python --version
python -c "import jsonschema; print('jsonschema=' + jsonschema.__version__)"
git rev-parse HEAD
git branch --show-current
python docs/experiments/au-ucr-ep-000001/wave-0.6/verification/verify_wave05.py
git status --short -- docs/experiments/au-ucr-ep-000001/wave-0.6/verification docs/experiments/au-ucr-ep-000001/wave-0.5
```

Final verification output:

```text
checks=17/17
failed=0
schemas=35
json_documents=51
schema_references=576
active_fixture_cases=2
subschema_case_outcomes=114
vectors=14
direct_vector_schema_instances=8
```

The suite also executed the following read-only or isolated subprocesses:

```text
python docs/experiments/au-ucr-ep-000001/wave-0.5/vectors/reproduce_vectors.py
python <temporary-verification-directory>/derive_vectors.py
```

## Produced files

- `verify_wave05.py` — executable verification suite
- `results.json` — machine-readable executed outcomes and detailed messages
- `wave05_inventory.json` — 88-file byte/hash inventory
- `REPORT.md` — this report

Disposition:

`WAVE 0.5 LOCAL NON-OPERATIONAL CHECKS 17/17 PASS -> 35 SCHEMAS META-VALID -> 576/576 REFERENCES RESOLVED -> 116/116 ACTIVE FIXTURE OUTCOMES PASS -> 14-VECTOR BUNDLE BYTE-REPRODUCED -> 8/8 POSITIVE DIRECT INSTANCES VALID -> NO OPERATIONAL OR CRYPTOGRAPHIC CLAIM -> NOT ADOPTED`
