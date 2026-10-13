# Gate P evidence recovery handoff

## Control

- Project: Agent University / StarNet
- Experiment: `AU-UCR-EP-000001`
- Work request: `STAR-WR-0001`
- Gate: Gate P
- Disposition: `BLOCKED_BY_EVIDENCE`
- Authorization: `DEFERRED`
- Reachable repository: `/workspace`
- Reachable commit: `c0579a4e4d272162963de09bdec7494d822c1fe2`
- Reachable branch: `cursor/populate-authority-readiness-7886`
- Primary repository reported by the Principal: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Primary-repository access from the recovery environment: unavailable

This is an additive investigation handoff. It is not a preservation receipt,
acceptance, release, signature, or Gate P decision.

## Executive result

Gate P remains blocked. The reachable repository does not contain the primary
Wave 0.6/Wave 0.7 candidate manifests, the reported aggregate digest method,
the Wave 0.7 verifier and result file, a governing definition of
`FOR-ACT-S0-001`, signed authority, or candidate-specific immutable custody.

The following source-reported claims therefore remain pending:

- 54 Wave 0.6 technical-freeze files
- 19 Wave 0.7 governance files
- 73 unique preservation-candidate files
- aggregate digest
  `3d1942c432722188952b040eba073a76d0bb3358606ed15704ddf86a75a201c4`
- historical 87-versus-90 dossier relationship
- 162 document cases, 576 references, 125 negative cases, and 14 vectors
- `FOR-ACT-S0-001-W04-*` and the composite-record interpretation

## Reproduced results

The independent challenge reproduced these read-only checks:

```text
node scripts/qa/au-ucr-s0-readiness.mjs check
check: PACKAGE_CONSISTENT_S1_CLOSED

cd qa/evidence/au-ucr-ep-000001-s0/star-wr-0001
sha256sum -c MANIFEST.sha256
9/9 entries: OK

npm run validate:raw
FAIL: MODULE_NOT_FOUND test/validate_map.js

node test/checkpoint-default-on.test.js
PASS: 14 assertions

node test/image-task.e2e.test.js
PASS: 69 assertions
```

`PACKAGE_CONSISTENT_S1_CLOSED` proves that the package is consistently blocked;
it is not a readiness approval. A manifest `OK` result proves file integrity,
not that the recorded test outcome passed.

Full `test:fast`, full `test:http`, the production build, and the unavailable
Wave 0.7 verifier were not run.

## Material findings

1. No reachable source identifies the 54-, 19-, 73-, 87-, or 90-member
   populations.
2. The reported root is not the SHA-256 of any reachable Git object under raw,
   Git-framed, CRLF/LF-converted, or trailing-newline variants.
3. No reachable source defines the authoritative aggregate ordering,
   path encoding, normalization, delimiters, framing, or hash domain.
4. `final_technical_results.json` and `verify_wave07_technical.py` are absent
   from the checkout and all reachable refs and history.
5. No reachable source contains `FOR-ACT-S0-001`,
   `FOR-ACT-S0-001-W04-*`, or a protocol authorizing a composite audit record.
6. The only reachable Scrum reconciliation says it is not an authoritative
   tracker update and that no authoritative tracker was found.
7. `EV-STAR-05` remains a historical `FAIL` with disposition
   `REVISE_IMPLEMENTATION`. Focused tests now pass, but no complete superseding
   run or receipt exists.
8. `EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json` cites nonexistent commit
   `2ea38d86a19697b80a827d2dfd83a9219e145532`; the reachable commit is
   `2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d`.
9. Gate P and `FOR-ACT` have no governing definition in reachable records.
10. No named Publication Custodian, signed delegation, authenticated
    acceptance, candidate-specific WORM receipt, retention record, or storage
    access proof was found.
11. The current receipt schema and readiness validator encode the blocked
    state. They would reject genuine assignments or remediated baseline
    receipts until changed through governance.
12. Product-perfect W6/W7 is a separate campaign and must not be conflated with
    the source-reported Wave 0.6/Wave 0.7 preservation package.

## Candidate and technical verdicts

| Question | Verdict |
| --- | --- |
| Exact preservation candidate identified | `NOT_VERIFIED` |
| 73-file union reproduced | `NOT_VERIFIED` |
| Historical digest reproduced | `NOT_REPRODUCIBLE_FROM_REACHABLE_INPUTS` |
| 87-versus-90 crosswalk established | `NOT_VERIFIED` |
| `FOR-ACT-S0-001` authority established | `NOT_VERIFIED` |
| Wave 0.7 verifier executed | `NOT_RUN_UNAVAILABLE` |
| Four reported Wave 0.7 metrics reproduced | `HISTORICAL_ONLY` |
| STAR manifest integrity | `REPRODUCED_9_OF_9` |
| `EV-STAR-05` superseded by a full pass | `NO` |
| Gate P authorization | `NONE` |

## Required local recovery

Recover these original records from the Windows repository without rewriting
them:

1. The complete 54-file Wave 0.6 technical manifest.
2. The complete 19-file Wave 0.7 governance manifest.
3. The combined 73-file manifest with per-file sizes and hashes.
4. The original aggregate-digest specification or verifier.
5. Both historical 87- and 90-member inventories and their digest rules.
6. `final_technical_results.json`.
7. `verify_wave07_technical.py` and all required inputs.
8. Every `FOR-ACT-S0-001-W04-*` record.
9. The authoritative Gate P and `FOR-ACT-S0-001` governing definitions.
10. Signed assignments, acceptance records, custody receipts, WORM controls,
    retention terms, and access-control evidence.

## Decision packet

```text
RECOMMENDATION: REMAIN BLOCKED
AUTHORIZATION: DEFERRED
PRESERVATION EXECUTED: NO
RELEASE EXECUTED: NO
FORMAL ACCEPTANCE: NONE
```

## Rollback and supersession

If a proposed replacement manifest, digest method, interpretation, or result is
invalidated, retain the original record unchanged. Record the old reference,
new reference, reason, responsible authority, UTC timestamp, and rollback path.
Reopen affected Scrum acceptance and gate findings. Do not delete or overwrite
historical evidence.
