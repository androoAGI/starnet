# GATE-03 Amendment 1 — PRE_A09 Manifest Hash Convention

## 1. Control record

- **Amends:** `GATE-03_CONSOLIDATED_DECISION_PACKAGE.md`
- **Original artifact exact Windows working-tree SHA-256:** `b7767c81e3093c7d031e432533805f415f8082d01c3970e8f91e66367ce2b31b`
- **Original artifact bytes:** 21,828
- **Related correction:** `D-02_AMENDMENT-1_MANIFEST_HASH_CONVENTION.md`
- **Scope:** GATE-03 statements that classify the three PRE_A09 manifest entries as integrity mismatches
- **Verification date:** `2026-10-11`
- **Verification mode:** read-only byte/provenance inspection; no project tests or scripts were run
- **Verdict on the inherited material blocker:** **CONTRADICTED**
- **Governance effect:** None. This correction does not open a gate, accept an artifact, certify evidence, authorize execution, or permit merge.

## 2. Gate correction

GATE-03 inherited D-02's comparison of manifest digests with raw CRLF bytes rendered by this Windows checkout. That comparison is accurate only for platform-rendered checkout bytes and does not establish corruption or a stale manifest.

The manifest digests exactly match all three current Git index and `HEAD` blobs. Replacing CRLF pairs with LF in the working-tree files, without any other transformation, produces those same digests. The same result holds for every one of the six non-PRE_A09 manifest entries. Git has no applicable attributes or repository `.gitattributes`, system configuration sets `core.autocrlf=true`, and the receipt directory is clean according to Git.

Therefore:

- remove the PRE_A09 three-file mismatch from GATE-03's blockers;
- do not require a superseding manifest solely to resolve these checkout-rendering differences;
- retain the manifest-domain documentation risk described below;
- do not change gate state on this correction alone.

## 3. Exact corrected table

Line-ending counts are shown as `CRLF / lone LF / lone CR`. LF normalization replaced CRLF pairs only.

| Receipt | Raw Windows bytes and line endings | Raw Windows SHA-256 | LF-normalized SHA-256 | Index SHA-256 | HEAD SHA-256 | Manifest SHA-256 | Correct result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `EV-INF-PRE-A09-AUTHORITY-NAMES-00.json` | 6,608; 160 / 0 / 0 | `aef3c4146bbd978a7c4eb2b5798776351e2728d450dd9556404fd8facaa611ef` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | Match to committed/index content |
| `EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json` | 2,900; 65 / 0 / 0 | `058bcc5cd035c5c1be243e90be0ec59486e9a7029489511ef2367e7cb436a4ba` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | Match to committed/index content |
| `EV-INF-PRE-A09-LOCAL-BRIDGE-00.json` | 13,605; 141 / 0 / 0 | `100c4c174df2cf0fc41f4502410eebd3ca32631e6c7a77a36d422c135ca70f28` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | Match to committed/index content |

The normalized byte counts are respectively 6,448, 2,835, and 13,464. The index and `HEAD` blobs contain respectively 160, 65, and 141 lone LF, with zero CRLF and zero lone CR.

The exact raw Windows manifest remains 821 bytes and SHA-256 `4a67cbe5e960d12a9c15372a7ccdbec0d484dc7a4e58a25d9de8ed9a636fb145`; its 812-byte LF index/`HEAD` form has SHA-256 `f1c14deb36d3a868cb20d877012a6f3262d72eae1cbcaf6952957f2cb88f73bc`.

## 4. Historical and dependency confirmation

The deterministic-readiness receipt records execution under repository path `/workspace` using:

`cd qa/evidence/au-ucr-ep-000001-s0/star-wr-0001 && sha256sum -c MANIFEST.sha256`

The local-bridge receipt's current normalized/index/`HEAD` content is 13,464 bytes with 141 LF and SHA-256 `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d`. It exactly matches its original introduction content at `e572eb54791abeac07353969e6d3dba65492c42b` and the identical content at `b51d69855ad34ca69cc082078a8e842692040d63`.

Commit `c0579a4e4d272162963de09bdec7494d822c1fe2` removed the later circular PRE_A09 additions from the local-bridge receipt and changed its manifest entry from the then-current `8a490c50492e571cb0b331794bed86e6ca06807145d52d5306afcedff9609710` back to the original-content digest above. The current nine-receipt graph has 14 dependency edges and no cycles.

## 5. Correction scope, gate effect, and remaining blockers

This amendment corrects:

- the executive-summary statement that `MANIFEST.sha256` disagrees with all three receipts;
- A-04, B-03, C-04, SCRUM03, and LAB-03 revision language whose only basis is that alleged mismatch;
- GATE-03 Section 7's “Verified PRE_A09 manifest mismatches” table and supersession demand;
- G1/G2 prerequisites for a corrected manifest to the extent they are based solely on that false mismatch;
- rollback/suspension language only insofar as it treats this CRLF/LF rendering difference as a provenance failure.

Remaining provenance risks:

- the manifest does not explicitly declare Git-blob/LF content as its hash domain;
- no `.gitattributes` fixes the normalization policy across environments;
- the deterministic-readiness receipt names unavailable commit `2ea38d86a19697b80a827d2dfd83a9219e145532`, while local history contains `2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d`;
- this investigation did not rerun the historical command and does not convert technical integrity into QA certification or governance acceptance.

Remaining gate blockers include the absent governed role assignments and acknowledgements; absent QA, Decision Chair, acceptance, publication, and execution-release receipts; untracked Wave 0.3 artifacts without containing-commit/publication linkage; baseline failed/blocked readiness evidence; stale SCRUM03 claims; absent accepted shared trust and enforcement architecture; and absent corrected designs, independent QA, re-review, and finding closure.

G1 remains `PENDING`, G2 remains `PENDING`, G3 remains `CLOSED`, G4 remains `NOT AUTHORIZED`, and PR merge remains blocked. All other D-02 and GATE-03 findings, objections, required revisions, statuses, mandatory holds, and lack of acceptance or execution authority remain unchanged.
