# Wave 0.6 Evidence Lineage and Correction Ledger

## Control record

- Experiment: `AU-UCR-EP-000001`
- Prepared: `2026-10-12`
- Status: `LINEAGE_RECONCILED_LIMITATIONS_CARRIED`
- Historical files amended: none
- Acceptance, publication and authorization effect: none

This ledger records the controlling interpretation of historical observations without replacing
or rewriting any prior report, amendment, manifest or QA receipt.

## Lineage ledger

| Sequence | Historical record or event | Preserved observation | Current controlling interpretation |
| ---: | --- | --- | --- |
| 1 | PRE_A09 local bridge introduced at `e572eb54791abeac07353969e6d3dba65492c42b` | Local runtime observations were recorded before later PRE_A09 receipts existed. | Present local-bridge Git content matches its introduction content in the LF/blob domain. The runtime claim remains historical and is not rerun or recertified. |
| 2 | Authority-names lineage at local commit `2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d` | Named-role gaps and lack of assignment authority were recorded. | The distinct commit is resolvable, but it must not replace the different commit value embedded in deterministic readiness. |
| 3 | Deterministic-readiness receipt introduced at `4703c0b216e73398aa2b59a9cc0a01bb60557716` | The receipt records a historical `/workspace` `sha256sum -c` execution and depends on authority names and local bridge. | Current bytes and graph can be verified. Historical execution, environment and actor cannot be recreated by present hashing. |
| 4 | Later local-bridge expansion created circular PRE_A09 dependencies | Historical intermediate bytes and manifest digest `8a490c...` existed. | Commit `c0579a4e4d272162963de09bdec7494d822c1fe2` removed the later circular additions and restored original local-bridge content. No prior receipt was edited during this Wave 0.6 task. |
| 5 | D-02 and GATE-03 originally classified three PRE_A09 raw Windows hashes as manifest mismatches | Raw CRLF checkout hashes differ from the two-column manifest values. | D-02 Amendment 1 and GATE-03 Amendment 1 correctly establish that all nine entries match LF/index/`HEAD` bytes. The original mismatch prose remains historical and is superseded only on that narrow point. |
| 6 | D-02/GATE-03 described Wave 0.3 files as untracked at `c0579a4e...` | They were untracked at report authoring time. | Current `HEAD` `39bade0506b4d5b12bb979ccf6a51bb11944a9ff` contains all nine Wave 0.3 files. The old statement is historical, not current state. |
| 7 | Wave 0.4 created 20 revised design/review records | Exact working-tree bytes and hashes were recorded; D-03 corrections reduced the objection count to 32 addressed, 9 remaining, 4 amendment-corrected. | All 20 remain untracked and absent from `HEAD`. Their review results are design evidence, not immutable publication or acceptance. |
| 8 | Wave 0.4 hash-domain policy separated raw, LF, Git and manifest identities | The policy resolves conceptual ambiguity prospectively. | `W04_HASH_DOMAIN_POLICY.md` remains a draft, untracked and not adopted. It cannot retroactively redefine historical evidence. |
| 9 | Early Wave 0.5 records embedded snapshot counts such as 20, 33, 44, 47, 77 and 78 | Each count accurately described a particular mutable inspection scope. | A1-NMF-01 correction controls: none is current manifest cardinality. Present inspection finds 88 Wave 0.5 files; that is still only a mutable observation, not a freeze count. |
| 10 | F-04 reviewed a pre-correction 43-input Wave 0.5 set | The report is valid historical technical review evidence for that measured set. | It cannot review its own bytes, later amendments or final corrected candidate. Candidate-bound QA and independent re-review remain required after freeze/publication. |
| 11 | F04-NMF-05 identified incomplete/circular manifest scope | A flat package could omit later review outputs or imply a report reviewed itself. | `W05_NESTED_CANDIDATE_MANIFEST_SPEC.md` defines L3 reviewed source separately from L4 review/decision evidence, preventing self-review. The seven-level hierarchy is specified but not instantiated. |
| 12 | Vector metadata evolved from 8 scenarios to 14 | Older reports truthfully record the prior 8-scenario snapshot. | `W05_POST_CORRECTION_RECONCILIATION_AMENDMENT_1.md`, Registry 1.3.0 and the final bundle control current metadata: 1 family, 14 scenarios, 2 positive, 12 negative, 6 files, bundle SHA-256 `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`. |
| 13 | F-04 Amendment 4 classified the metadata supersession chain as non-circular | It confirms the narrow current tuple while preserving old counts as historical. | Its conclusion remains design-addressed/verification-pending because all relevant files are untracked, mutable and unpublished. |
| 14 | Wave 0.6 final technical package created a 54-entry normative technical-freeze manifest | All 54 declared raw byte counts and SHA-256 values match; the package contains 35 schemas (33 concrete, 2 helpers), 162 full-document cases, 57 subschema pairs and 14 vectors. | This is a local mutable exact-byte technical freeze, not an authorized immutable freeze, Git candidate, publication or adoption. |
| 15 | Final independent local non-operational technical verification | 15/15 checks passed, including intended-reason negatives, ephemeral ES256/P1363 low-S mechanics and bounded Node cross-runtime canonicalization. | Complete third-party RFC 8785, synthetic sentinel signature verification, operational trust/authority/revocation, stateful consumers and publication remain NOT_RUN. |
| 16 | Earlier Wave 0.6 principal spelling was corrected | Final technical manifest, README, completion report and verification agree on `Hakeem Moore`. | **Hakeem Moore** is the controlling spelling. Consistent text does not itself prove identity, mandate or decision authority. |

## Unsupported historical reference

The deterministic-readiness receipt contains:

`2ea38d86a19697b80a827d2dfd83a9219e145532`

Read-only Git inspection still cannot resolve this exact object. The repository contains the
distinct commit:

`2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d`

Classification remains `UNSUPPORTED`. Similar prefix, subject, parent/child placement and semantic
fit are insufficient to substitute one full object ID for another. Historical substitutions: 0.

## Historical and circular-receipt concern disposition

No file in the inspected Wave 0.3-0.5 roots contains a literal `Bugbot` attribution, report ID or
authenticated Bugbot receipt. Therefore no Bugbot identity or review authority is fabricated.
The concerns described as Bugbot historical/circular-receipt concerns are reconciled on their
technical substance:

1. historical counts are snapshot observations, never freeze expectations;
2. current receipts do not contain the removed circular PRE_A09 edge;
3. current QA graph is 9 nodes, 14 edges, 0 missing targets and 0 cycles;
4. review outputs cannot review themselves or later corrections;
5. amendment/revocation receipts require an external immutable binding and cannot live only
   inside the object they amend;
6. metadata supersession is explicit and append-only; and
7. none of those design corrections establishes immutable publication or formal review authority.

## Correction rules carried into Wave 0.6

- Preserve every historical artifact and receipt unchanged.
- Add corrections as later records with exact scope.
- Never treat a superseding interpretation as deletion of the prior observation.
- Never silently substitute commit IDs, paths, schema IDs, aliases, counts or digest domains.
- Keep publication, QA, independent review, acceptance and G4 release separate.
- Unknown or unavailable evidence remains unknown or unavailable; it is not a pass.

## Current holds

- A09: unresolved.
- G3: closed, blocked by dependency.
- G4: not authorized.
- Candidate freeze: not authorized and not performed.
- Publication/acceptance: none.
- Operational testing: not performed.

