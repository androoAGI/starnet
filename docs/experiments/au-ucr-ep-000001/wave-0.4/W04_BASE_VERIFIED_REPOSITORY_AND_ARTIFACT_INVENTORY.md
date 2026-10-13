# W04-BASE — Verified Repository and Artifact Inventory

## Control record

- **Task:** `FOR-ACT-S0-001-W04-BASE`
- **Project:** Agent University / StarNet
- **Work request:** `STAR-WR-0001`
- **Evidence package:** `AU-UCR-EP-000001-S0`
- **Prepared:** 2026-10-11
- **Status:** `BASELINE_VERIFIED_NOT_ACCEPTED`
- **Authority effect:** None. This record does not accept an artifact, open a gate, authorize
  implementation, permit laboratory construction, or release execution.

## Repository baseline

- Repository root: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Remote: `https://github.com/mrrobot787/starnet.git`
- Active branch: `cursor/populate-authority-readiness-7886`
- Active revision: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Active revision parent: `c0579a4e4d272162963de09bdec7494d822c1fe2`
- Active revision subject: `Add Agent University Wave 0.3 design package`
- Evidence-remediation revision: `c0579a4e4d272162963de09bdec7494d822c1fe2`
- Recovery reference:
  `refs/backup/pre-split-20261011-181324` ->
  `44b5804fa2feba28cb8654287e827029790cc33c`
- Ancestor check: `c0579a4e4` is an ancestor of `39bade050` (`git merge-base --is-ancestor`
  exit 0).
- Working tree before Wave 0.4 additions: clean.
- Tracking state before Wave 0.4 additions: local branch was one commit ahead of
  `origin/cursor/populate-authority-readiness-7886`.
- Reported base branch discrepancy: local `feat/harness-backend` was
  `dd462513c4c05eb09b976e899a61c4fe456afe15` and four commits behind
  `origin/feat/harness-backend` at `95ed933f7698715768e51c7f4c79d33343bf973f`.
  Remote base is the relevant review baseline; the stale local ref must not be treated as current.

## Wave 0.3 artifact inventory

All hashes below are SHA-256 over the exact Windows working-tree bytes at
`39bade0506b4d5b12bb979ccf6a51bb11944a9ff`. Each artifact's latest containing revision is
`39bade0506b4d5b12bb979ccf6a51bb11944a9ff`.

| Artifact | Repository path | Bytes | Exact working-tree SHA-256 |
| --- | --- | ---: | --- |
| A-04 | `docs/experiments/au-ucr-ep-000001/wave-0.3/A-04_TRUSTED_RUNTIME_ATTESTATION_SPEC.md` | 30,976 | `3bdb80b055f672141101dd4417aa75df349e4a8b25c3f19051a77a98613cc5ed` |
| B-03 | `docs/experiments/au-ucr-ep-000001/wave-0.3/B-03_EXECUTABLE_ENFORCEMENT_SPEC.md` | 32,599 | `f6cad82b5bb9049a8a5bebc4bbfd4d8be09af3b927aaa9b301fb287b09c6582a` |
| C-04 | `docs/experiments/au-ucr-ep-000001/wave-0.3/C-04_AUTHORITY_PACKAGE_DRAFT.md` | 11,385 | `f78fa119d767285efb984b3246842081ac0be4a7513eadbd70566bae64377999` |
| D-02 amendment | `docs/experiments/au-ucr-ep-000001/wave-0.3/D-02_AMENDMENT-1_MANIFEST_HASH_CONVENTION.md` | 8,822 | `f86a8d02591a18f0081d6d1d096c58160b6ba73ef64717af7f62fbd8f154c0bb` |
| D-02 | `docs/experiments/au-ucr-ep-000001/wave-0.3/D-02_INDEPENDENT_DESIGN_ASSURANCE_REPORT.md` | 25,418 | `6a1ec6f35f2b66a87da0270a713b23c2e767a8784c7cbdf241ca278905b664d0` |
| GATE-03 amendment | `docs/experiments/au-ucr-ep-000001/wave-0.3/GATE-03_AMENDMENT-1_MANIFEST_HASH_CONVENTION.md` | 6,797 | `8549a89cf9c05be7cefd8ca8edaf9fc784cafa5648510586919a61b9dee134ea` |
| GATE-03 | `docs/experiments/au-ucr-ep-000001/wave-0.3/GATE-03_CONSOLIDATED_DECISION_PACKAGE.md` | 21,828 | `b7767c81e3093c7d031e432533805f415f8082d01c3970e8f91e66367ce2b31b` |
| LAB-03 | `docs/experiments/au-ucr-ep-000001/wave-0.3/LAB-03_ISOLATED_EXECUTION_ENVIRONMENT_SPEC.md` | 32,071 | `b9ba2f40db06921fc01368b00a838d59f5ab0d72f9867c0a39d2277c9f4c2361` |
| SCRUM03 | `docs/experiments/au-ucr-ep-000001/wave-0.3/SCRUM03_RECONCILIATION.md` | 13,706 | `b3b3349454e76a6705674e5c65d21e3aee3ff4519941586313bca727bef7abd3` |

## Review and gate baseline

- D-02 status: `REVIEW_COMPLETE_NOT_ACCEPTED`.
- D-02 design findings:
  - A-04: `REVISE AS DESIGN`.
  - B-03: `REVISE AS DESIGN`.
  - C-04: `REVISE AS DESIGN`.
  - SCRUM03: `BLOCK AS DESIGN`.
  - LAB-03: `REVISE AS DESIGN`.
- GATE-03 status: `GATE_CLOSED_REVISE_REQUIRED`.
- D-02 Amendment 1 contradicts only the alleged three-file PRE_A09 manifest mismatch. It does
  not withdraw unrelated design objections or open any gate.

## Pull-request state

State was queried from GitHub on 2026-10-11. No merge or acceptance is inferred from branch
existence.

| PR | Scope | State | Base | Head |
| --- | --- | --- | --- | --- |
| [#10](https://github.com/mrrobot787/starnet/pull/10) | PRE_A09 receipt provenance | `MERGED` | `feat/harness-backend` | `fix/pre-a09-receipt-provenance` |
| [#11](https://github.com/mrrobot787/starnet/pull/11) | Wave 0.3 technical designs | `OPEN`, draft | `feat/harness-backend` | `docs/w03-technical-control-designs` |
| [#12](https://github.com/mrrobot787/starnet/pull/12) | Readiness gate tests | `OPEN` | `feat/harness-backend` | `test/readiness-gate-stabilization` |
| [#13](https://github.com/mrrobot787/starnet/pull/13) | Authority reconciliation | `OPEN`, draft | `docs/w03-technical-control-designs` | `docs/w03-authority-reconciliation` |
| [#14](https://github.com/mrrobot787/starnet/pull/14) | Assurance and GATE-03 | `OPEN`, draft | `docs/w03-authority-reconciliation` | `docs/w03-assurance-gate` |

The two manifest-hash amendments are present in PR #14. PR #14 contains revision
`f4faaf41fd039f2ba81c7cb287087a1a115478ea`.

## Historical receipt preservation

`EV-INF-PRE-A09-LOCAL-BRIDGE-00.json` at `HEAD` has Git blob
`bd41fd484abec3657e004b7ee9dd006e83463bb2`. The file at its historical introduction revision
`e572eb547` has the same blob ID. `git diff --exit-code e572eb547:<path> HEAD:<path>` returned
exit 0. The historical observation content is therefore preserved exactly in Git's committed
content domain.

The current local-bridge receipt does not depend on deterministic readiness. The later
deterministic-readiness receipt depends on the local-bridge and authority-name receipts. The
former circular edge was removed by `c0579a4e4`.

## Discrepancies from the prior worknote and package prose

1. The prior worknote listed PR #10 without recording that it is now merged. GitHub reports it
   `MERGED`; this does not constitute governance acceptance.
2. GATE-03 and D-02 describe the Wave 0.3 files as untracked. That statement was true when those
   reports were authored, but is stale at the current local revision: all nine files are tracked
   in local commit `39bade050`.
3. Local commit `39bade050` has not been pushed on the starting branch. The split PR branches
   contain review slices, not the local consolidation commit.
4. The local `feat/harness-backend` ref is stale. Review comparisons must use
   `origin/feat/harness-backend` unless the local ref is deliberately updated.
5. The deterministic-readiness receipt names
   `2ea38d86a19697b80a827d2dfd83a9219e145532`, while local history contains nearby
   `2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d`. The named object was not assumed equivalent and
   remains subject to Wave 0.4 evidence disposition.

## Holds

`S1 CLOSED`; `G1 PENDING`; `G2 PENDING`; `G3 CLOSED — REVISE REQUIRED`;
`G4 NOT AUTHORIZED`; `A09 UNRESOLVED`; implementation prohibited; laboratory construction
prohibited; negative testing blocked; production release `NO-GO`; PR merge blocked.
