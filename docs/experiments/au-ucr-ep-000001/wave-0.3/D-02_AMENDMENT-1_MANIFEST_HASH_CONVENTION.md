# D-02 Amendment 1 — PRE_A09 Manifest Hash Convention

## 1. Control record

- **Amends:** `D-02_INDEPENDENT_DESIGN_ASSURANCE_REPORT.md`
- **Original artifact exact Windows working-tree SHA-256:** `6a1ec6f35f2b66a87da0270a713b23c2e767a8784c7cbdf241ca278905b664d0`
- **Original artifact bytes:** 25,418
- **Scope:** Section 3's PRE_A09 manifest mismatch finding and every downstream statement that relies on that finding
- **Verification date:** `2026-10-11`
- **Verification mode:** read-only byte/provenance inspection; no project tests or scripts were run
- **Verdict on the claimed material blocker:** **CONTRADICTED**
- **Governance effect:** None. This amendment is a provenance correction, not acceptance, certification, publication, execution release, or permission to implement or test.

## 2. Corrected finding

D-02 correctly measured the raw bytes rendered in this Windows checkout, but it treated those checkout-rendered CRLF bytes as the manifest's intended hash domain. That made all three receipts appear mismatched. The repository evidence demonstrates a different convention:

1. the current Git index and `HEAD` blobs use LF line endings;
2. every manifest digest, including all six non-PRE_A09 entries, matches the corresponding index/`HEAD` blob;
3. every Windows working-tree file is a clean CRLF rendering whose digest matches the manifest after replacing CRLF pairs with LF, with no other transformation;
4. Git reports no attributes for these paths, no repository `.gitattributes` exists, and system Git configuration sets `core.autocrlf=true`;
5. Git reports no tracked modification for the receipt directory.

Accordingly, the manifest identifies committed/index content, not the platform-specific raw checkout rendering. The current manifest is not invalid merely because a Windows checkout has CRLF bytes. D-02's requirement to supersede it solely for these three alleged mismatches is withdrawn.

## 3. Exact byte evidence

`LF-normalized` below means replacing each `0d 0a` pair with `0a` only. No lone CR, lone LF, encoding, whitespace, or JSON transformation was applied.

| Receipt | Raw Windows bytes | CRLF / lone LF / lone CR | Raw Windows SHA-256 | LF-normalized bytes and SHA-256 | Index blob SHA-256 | HEAD blob SHA-256 | Manifest SHA-256 | Result |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| `EV-INF-PRE-A09-AUTHORITY-NAMES-00.json` | 6,608 | 160 / 0 / 0 | `aef3c4146bbd978a7c4eb2b5798776351e2728d450dd9556404fd8facaa611ef` | 6,448; `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` | Match to committed/index content |
| `EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json` | 2,900 | 65 / 0 / 0 | `058bcc5cd035c5c1be243e90be0ec59486e9a7029489511ef2367e7cb436a4ba` | 2,835; `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` | Match to committed/index content |
| `EV-INF-PRE-A09-LOCAL-BRIDGE-00.json` | 13,605 | 141 / 0 / 0 | `100c4c174df2cf0fc41f4502410eebd3ca32631e6c7a77a36d422c135ca70f28` | 13,464; `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` | Match to committed/index content |

For each index and `HEAD` blob above, the line-ending counts are 0 CRLF, respectively 160, 65, and 141 lone LF, and 0 lone CR.

The manifest file itself has 821 raw Windows bytes, 9 CRLF pairs, no lone LF or lone CR, and raw SHA-256 `4a67cbe5e960d12a9c15372a7ccdbec0d484dc7a4e58a25d9de8ed9a636fb145`. Its index/`HEAD` form is 812 bytes with 9 lone LF and SHA-256 `f1c14deb36d3a868cb20d877012a6f3262d72eae1cbcaf6952957f2cb88f73bc`.

## 4. Independent convention evidence

The six other manifest entries independently demonstrate the same convention. Each raw Windows checkout hash differs because all line endings are CRLF, while each CRLF-to-LF result exactly equals both the manifest digest and the index/`HEAD` blob digest:

| Entry | CRLF count | Raw Windows SHA-256 | Manifest = LF-normalized = index = HEAD SHA-256 |
| --- | ---: | --- | --- |
| `EV-STAR-00.json` | 46 | `44bd0d9eb880e1795eae478c273377eb7564ca1ba8d8e8a5fc4d65903bcfc17f` | `dd0b05fdc0d7bad3b336549087de4c9ef454b81548dae895559ac047528d5e63` |
| `EV-STAR-01.json` | 51 | `6d19f1d719f0ac6fbecaf016458848d9e6ec23c89f0bcab430996159bd5555ac` | `28b71a0871cb1b23bda605224ddbd400ec2c6a7bf8524541d3481ec4875d339e` |
| `EV-STAR-02.json` | 31 | `ac7f6070445a906e4ed0e03eadcbd59f64bd8322226b3c034284d1670166bd6d` | `49bfffae51172785032c69666b79a915a079d7be9d59d1bc18d8efa963f9f3d7` |
| `EV-STAR-03.json` | 124 | `6a16f48ccf075213c1847ac04697948a0fc20652a123492530fac8baa77f7256` | `22cc9c94cd74d604a7f2f73675bfd443f217d7cb192a7a195251a24f199f0eb9` |
| `EV-STAR-04.json` | 60 | `d155d5e5a79c1b098c45017836b18373d627171fead68142c52a2a7ba20f44b5` | `57e4f37f6e9ac34302372481ddc6dded02f8f7347157ccc6c45c7070bdf62c17` |
| `EV-STAR-05.json` | 80 | `a3d75b73e18a1b30ad5c457a45cd9f529602082f0bd3596dd5c4f33aad9e3e39` | `bdd048415aa65aef59af315a57ed8b12fc861fbbe530ca4cffd57289f821316d` |

`git check-attr -a` returned no attributes for the three receipts or manifest. Git configuration resolves `core.autocrlf=true` from `C:/Program Files/Git/etc/gitconfig`; `core.eol` and `core.safecrlf` are unset. This configuration explains the clean CRLF checkout rendering and LF Git blobs.

## 5. Historical provenance and graph verification

The deterministic-readiness receipt records a `/workspace` repository environment and the command:

`cd qa/evidence/au-ucr-ep-000001-s0/star-wr-0001 && sha256sum -c MANIFEST.sha256`

Its observed output reported the then-listed receipts as `OK`. Commit `4703c0b216e73398aa2b59a9cc0a01bb60557716` contains that receipt and a manifest whose local-bridge digest was then `8a490c50492e571cb0b331794bed86e6ca06807145d52d5306afcedff9609710`. Commit `c0579a4e4d272162963de09bdec7494d822c1fe2` explicitly restored the local-bridge receipt to its original provenance content and updated the manifest entry to `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d`.

The current local-bridge LF/index/`HEAD` digest exactly matches its original introduction content at commit `e572eb54791abeac07353969e6d3dba65492c42b` and the same content at `b51d69855ad34ca69cc082078a8e842692040d63`: 13,464 bytes, 141 LF, SHA-256 `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d`.

The current nine-receipt graph has 14 declared dependency edges and no cycle. In particular, deterministic readiness depends on authority names and local bridge; neither points back to deterministic readiness. The circular dependencies removed by `c0579a4e...` remain absent.

## 6. Correction scope and remaining risks

Corrected or withdrawn:

- D-02 Section 3's assertion that the manifest fails to identify all three current PRE_A09 receipts;
- blocker 4 in D-02 Section 6;
- all A-04, B-03, C-04, SCRUM03, LAB-03, and cross-artifact revision language whose only basis is this alleged three-file manifest mismatch;
- the demand for a superseding manifest made solely because raw Windows checkout hashes differ.

Remaining risks:

- `MANIFEST.sha256` does not state its hash domain explicitly. Future verification procedures should say whether hashes cover Git blob/LF content or exact platform checkout bytes.
- No `.gitattributes` pins the intended normalization policy, so portability currently depends on Git's text detection and configuration.
- The deterministic-readiness receipt names commit `2ea38d86a19697b80a827d2dfd83a9219e145532`, which is not present locally; the nearby historical commit is `2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d`. This commit-identity discrepancy requires separate provenance treatment.
- The historical deterministic command/output establishes its historical execution claim, but this amendment did not rerun it and does not elevate that receipt into QA certification, governance acceptance, capability certification, or transition authority.
- Raw checkout-byte verification remains platform-dependent unless an explicit checkout-byte manifest is separately produced.

All other D-02 findings, objections, required revisions, statuses, holds, and lack of acceptance or execution authority remain unchanged.
