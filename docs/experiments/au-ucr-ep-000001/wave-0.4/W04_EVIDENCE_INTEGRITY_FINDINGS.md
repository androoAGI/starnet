# Wave 0.4 Evidence Integrity Findings

## 1. Control record

- Experiment: `AU-UCR-EP-000001`
- Wave: `0.4`
- Role: Agent A, evidence-integrity documentation lane
- Inspection date: `2026-10-11`
- Repository: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Branch: `cursor/populate-authority-readiness-7886`
- Inspected `HEAD`: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Authorization used: read-only repository, object, ref, history, and byte inspection plus creation of this documentation
- Runtime controls executed: none
- Dependencies installed: none
- Historical evidence changed: none
- Wave 0.3 files changed: none
- Status: `FINDINGS_RECORDED_NO_ACCEPTANCE_EFFECT`

This report is an append-only Wave 0.4 finding record. It is not an acceptance receipt, QA
certification, governance decision, execution release, publication authorization, merge
authorization, or replacement for any historical receipt.

## 2. Scope and inspected evidence

The inspection covered:

- the nine receipts and `MANIFEST.sha256` under
  `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/`;
- `S0_EVIDENCE_CONVENTIONS.md`, `S0_DEPENDENCY_GRAPH.md`,
  `S0_BASELINE_AND_GATES.md`, `S0_QA_READINESS_GATE.json`, and
  `UCR_001_EVIDENCE_PACKAGE.json`;
- the Wave 0.3 D-02 and GATE-03 manifest-hash amendments and their amended reports;
- Git `HEAD`, index entries, object format, commit objects, refs, reflogs, reachable-object
  inventory, unreachable-object report, and path history;
- applicable attributes and Git line-ending configuration; and
- the receipt dependency graph parsed from the current JSON files.

The historical evidence convention is append-only and states that a new commit invalidates
affected commit-bound receipts until rerun. This inspection therefore distinguishes present-byte
integrity from the validity of a historical execution claim.

## 3. Findings

### F-01 — The current manifest identifies LF Git content, not raw Windows checkout bytes

All nine manifest entries equal the SHA-256 of the corresponding current index and `HEAD` blob
bytes. For every current working-tree file, replacing each `CRLF` pair with one `LF`, and making no
other change, produces those same bytes and SHA-256. Raw Windows hashes differ because this
checkout contains CRLF.

The current manifest is therefore internally consistent in the Git-content/LF domain. A raw
Windows mismatch is not evidence of corruption. The manifest itself does not declare this domain,
so ambiguity remains.

### F-02 — Index and `HEAD` are identical for the inspected evidence set

Each inspected path has the same SHA-1 Git blob object ID in the index and at `HEAD`. Direct
`git cat-file blob` extraction confirms identical byte counts and SHA-256 values. Git reports no
tracked modification in the receipt directory.

### F-03 — Attributes do not pin line-ending behavior

`git check-attr --all` produced no attributes for the receipts or manifest. No root or ancestor
`.gitattributes` applies to these paths; the only tracked `.gitattributes` files found are in other
isolated evidence subdirectories. Repository-local policy therefore does not force a checkout
representation.

System Git configuration reports `core.autocrlf=true`; `core.eol` and `core.safecrlf` are unset.
This explains the clean CRLF checkout and LF blobs, but it is machine configuration rather than a
repository evidence policy.

### F-04 — The current dependency graph is complete and acyclic

Parsing all nine receipt JSON files produced nine nodes and fourteen declared edges. Every target
exists and depth-first color traversal found no cycle. The deterministic-readiness receipt depends
on authority-names and local-bridge; neither depends on deterministic-readiness.

The `c0579a4e4d272162963de09bdec7494d822c1fe2` provenance correction removed later PRE_A09
references from the historical local-bridge receipt and changed its manifest entry from
`8a490c50492e571cb0b331794bed86e6ca06807145d52d5306afcedff9609710` to the restored
original-content digest
`a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d`.
No historical evidence was rewritten during this Wave 0.4 inspection.

### F-05 — Historical scope is bounded and distinguishable

- The local-bridge evidence first appears at
  `e572eb54791abeac07353969e6d3dba65492c42b`; its present LF bytes equal that
  original-content form.
- Authority-names appears at
  `2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d`.
- Deterministic-readiness appears in its child
  `4703c0b216e73398aa2b59a9cc0a01bb60557716`.
- At `4703c0b2...`, the manifest contained the six `EV-STAR` entries, authority-names,
  deterministic-readiness, and the then-expanded local-bridge digest `8a490c...`.
- The deterministic receipt records that its historical `sha256sum -c` output covered eight
  then-listed receipts and did not list the deterministic receipt itself in the observed output.
- Current-byte verification confirms present integrity only; it does not rerun, recreate, or
  certify the historical execution.

### F-06 — Referenced deterministic commit classification: `UNSUPPORTED`

The deterministic-readiness receipt names:

`2ea38d86a19697b80a827d2dfd83a9219e145532`

That exact object is absent from the inspected object database. It is absent from all local and
remote-tracking refs, `git rev-list --all --objects`, and all reflogs. Full no-reflog `git fsck`
reported other unreachable objects but not this commit. No inspected artifact supplies a tree ID,
parent set, signature, or external immutable locator that independently establishes the exact
commit as historically valid.

The repository does contain the distinct commit:

`2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d`

It is the parent of `4703c0b2...`, has subject `Add pre-A09 authority evidence gate`, and shares
only the prefix `2ea38d86a` with the receipt value. It is not silently substituted. Under the
required classification choices, the receipt's exact referenced commit is **unsupported**, not
resolvable and not established as historically valid but unavailable.

This identity defect limits commit-bound provenance for the deterministic execution claim. It does
not change the direct present-byte and graph observations above.

## 4. Exact hash-domain inventory

`Raw` means exact bytes in this Windows working tree. `LF` means only `0d 0a -> 0a`.
`Index/HEAD OID` is the repository's SHA-1 Git blob identity, not a SHA-256 content digest.
All index and `HEAD` OIDs are equal for each row.

| File | Raw bytes; CRLF/LF/CR | Raw SHA-256 | LF/blob bytes; SHA-256 | Index/HEAD Git blob SHA-1 | Manifest SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `EV-STAR-00.json` | 1,576; 46/0/0 | `44bd0d9eb880e1795eae478c273377eb7564ca1ba8d8e8a5fc4d65903bcfc17f` | 1,530; `dd0b05fdc0d7bad3b336549087de4c9ef454b81548dae895559ac047528d5e63` | `34e49fab2e8ebc084bbb28f868c2066e2a5d2449` | `dd0b05fdc0d7bad3b336549087de4c9ef454b81548dae895559ac047528d5e63` |
| `EV-STAR-01.json` | 2,055; 51/0/0 | `6d19f1d719f0ac6fbecaf016458848d9e6ec23c89f0bcab430996159bd5555ac` | 2,004; `28b71a0871cb1b23bda605224ddbd400ec2c6a7bf8524541d3481ec4875d339e` | `3bad01ee150897eedfeaeb19846f4d69c226d33d` | `28b71a0871cb1b23bda605224ddbd400ec2c6a7bf8524541d3481ec4875d339e` |
| `EV-STAR-02.json` | 1,233; 31/0/0 | `ac7f6070445a906e4ed0e03eadcbd59f64bd8322226b3c034284d1670166bd6d` | 1,202; `49bfffae51172785032c69666b79a915a079d7be9d59d1bc18d8efa963f9f3d7` | `2fa944d3b04dfaa788e33b065c97abac4c8e7bc7` | `49bfffae51172785032c69666b79a915a079d7be9d59d1bc18d8efa963f9f3d7` |
| `EV-STAR-03.json` | 4,652; 124/0/0 | `6a16f48ccf075213c1847ac04697948a0fc20652a123492530fac8baa77f7256` | 4,528; `22cc9c94cd74d604a7f2f73675bfd443f217d7cb192a7a195251a24f199f0eb9` | `695d022f50c4f04575e33b1874c6ca417359bcc9` | `22cc9c94cd74d604a7f2f73675bfd443f217d7cb192a7a195251a24f199f0eb9` |
| `EV-STAR-04.json` | 2,707; 60/0/0 | `d155d5e5a79c1b098c45017836b18373d627171fead68142c52a2a7ba20f44b5` | 2,647; `57e4f37f6e9ac34302372481ddc6dded02f8f7347157ccc6c45c7070bdf62c17` | `c86bbbd4d2622741a261dd0aa76f0f96a19d09f7` | `57e4f37f6e9ac34302372481ddc6dded02f8f7347157ccc6c45c7070bdf62c17` |
| `EV-STAR-05.json` | 2,917; 80/0/0 | `a3d75b73e18a1b30ad5c457a45cd9f529602082f0bd3596dd5c4f33aad9e3e39` | 2,837; `bdd048415aa65aef59af315a57ed8b12fc861fbbe530ca4cffd57289f821316d` | `f2e2245508bc065aa6890c2a4a13e59ce4d29e92` | `bdd048415aa65aef59af315a57ed8b12fc861fbbe530ca4cffd57289f821316d` |
| `EV-INF-PRE-A09-AUTHORITY-NAMES-00.json` | 6,608; 160/0/0 | `aef3c4146bbd978a7c4eb2b5798776351e2728d450dd9556404fd8facaa611ef` | 6,448; `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | `1646f08d23c4d66f3882f0c34cea0ef2349da6fc` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` |
| `EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json` | 2,900; 65/0/0 | `058bcc5cd035c5c1be243e90be0ec59486e9a7029489511ef2367e7cb436a4ba` | 2,835; `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | `0a774863edf8e35c976a8d2eac5a8d5ddd3f5a6b` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` |
| `EV-INF-PRE-A09-LOCAL-BRIDGE-00.json` | 13,605; 141/0/0 | `100c4c174df2cf0fc41f4502410eebd3ca32631e6c7a77a36d422c135ca70f28` | 13,464; `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | `bd41fd484abec3657e004b7ee9dd006e83463bb2` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` |
| `MANIFEST.sha256` | 821; 9/0/0 | `4a67cbe5e960d12a9c15372a7ccdbec0d484dc7a4e58a25d9de8ed9a636fb145` | 812; `f1c14deb36d3a868cb20d877012a6f3262d72eae1cbcaf6952957f2cb88f73bc` | `313f88b143c55c411a7e8cdfba10260e94aa854a` | not self-listed |

## 5. Reproducible non-destructive checks

Run from repository root in PowerShell. These commands read files and Git metadata only.

```powershell
git rev-parse HEAD
git branch --show-current
git rev-parse --show-object-format
git status --short -- qa/evidence/au-ucr-ep-000001-s0/star-wr-0001
git ls-files -s -- qa/evidence/au-ucr-ep-000001-s0/star-wr-0001
```

Observed: the expected `HEAD` and branch above; object format `sha1`; no receipt-directory status
output; ten index entries with the blob OIDs reported in Section 4.

```powershell
$p = 'qa/evidence/au-ucr-ep-000001-s0/star-wr-0001'
git check-attr --all -- "$p/EV-INF-PRE-A09-AUTHORITY-NAMES-00.json" `
  "$p/EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json" `
  "$p/EV-INF-PRE-A09-LOCAL-BRIDGE-00.json" "$p/MANIFEST.sha256"
git config --show-origin --get core.autocrlf
git config --show-origin --get core.eol
git config --show-origin --get core.safecrlf
```

Observed: no attribute output; `core.autocrlf=true` from
`C:/Program Files/Git/etc/gitconfig`; no value for `core.eol` or `core.safecrlf`.

```powershell
@'
import hashlib, pathlib, subprocess
base = pathlib.Path("qa/evidence/au-ucr-ep-000001-s0/star-wr-0001")
for path in sorted(base.iterdir()):
    if not path.is_file(): continue
    raw = path.read_bytes()
    lf = raw.replace(b"\r\n", b"\n")
    rel = path.as_posix()
    idx = subprocess.check_output(["git","rev-parse",":"+rel], text=True).strip()
    head = subprocess.check_output(["git","rev-parse","HEAD:"+rel], text=True).strip()
    ib = subprocess.check_output(["git","cat-file","blob",idx])
    hb = subprocess.check_output(["git","cat-file","blob",head])
    print(path.name, len(raw), hashlib.sha256(raw).hexdigest(),
          len(lf), hashlib.sha256(lf).hexdigest(),
          idx, hashlib.sha256(ib).hexdigest(),
          head, hashlib.sha256(hb).hexdigest(), ib == hb)
'@ | python -
```

Observed: the byte counts, hashes, and equal index/`HEAD` result in Section 4.

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

Observed: `$bad` is not a valid local object; `$near` is a commit; object/reflog search returns
only `$near`; no ref names `$bad`; `fsck` does not report `$bad`.

```powershell
git log --all --follow --format='%H %aI %s' -- `
  qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json
git show 4703c0b216e73398aa2b59a9cc0a01bb60557716:`
qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/MANIFEST.sha256
git show --no-ext-diff c0579a4e4d272162963de09bdec7494d822c1fe2 -- `
  qa/evidence/au-ucr-ep-000001-s0/star-wr-0001
```

Observed: deterministic-readiness was introduced at `4703c0b2...`; the historical manifest and
the later append-only provenance correction have the scope described in F-05.

For graph verification, parse each `*.json`, map `evidence_id` to `dependencies`, require every
target to exist, and use white/gray/black depth-first traversal. Observed result:
`nodes=9 edges=14 cycle=False missing_targets=0`.

## 6. Outstanding risks

1. The manifest format does not identify algorithm, byte domain, normalization operation,
   repository, path root, object format, commit, index state, or generation time.
2. No applicable `.gitattributes` makes working-tree representation deterministic across machines.
3. The deterministic receipt's exact `commit_tested` is unsupported; its historical execution
   claim is not reliably commit-bound.
4. Present integrity cannot establish that the historical command ran in the stated `/workspace`
   environment or produced the recorded output.
5. The manifest is mutable and unsigned and does not bind itself or a containing tree/commit.
6. Baseline gate failures, absent governed assignments, absent independent QA/Decision Chair
   receipts, and absent execution release remain outside byte-integrity correction.
7. Other Wave 0.4 artifacts are untracked and concurrently present; this report does not inventory,
   review, accept, or alter them.

## 7. Mandatory holds preserved

- S1 transition remains `closed_pending_explicit_acceptance`.
- G1 remains `PENDING`.
- G2 remains `PENDING`.
- G3 remains `CLOSED`.
- G4 remains `NOT AUTHORIZED`.
- A09 remains `NO_DECISION_NO_TRANSITION`; eligibility is not established.
- No acceptance, certification, publication, execution, merge, or promotion claim is made.
