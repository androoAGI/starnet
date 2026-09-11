# 0.11.2 pointer repair candidate — September 11, 2026

Requested merge `33c925797e1a63e943272c05486902d366623aac` is included in the signed 0.11.2 candidate and the owner's personal installation. Trunk is frozen at `69baf91a5b2c22230f87e614da6a72882278bc6c`, source tree `930d6dc2c4f556f9f22ded59f0f9cbfcc72d3fe5`. Release notes include the repair. No public release, tag or updater-feed change was made.

## Included repair and verification

PowerShell resolved the native driver's `Move` helper to its filesystem `Move-Item` alias. The repair renames the helper and every pointer call site; application behavior outside that Windows driver is unchanged from the previous candidate. The exact merge's pointer, computer and desktop regressions pass 103 assertions. The existing source proof records the real in-app click failing before the repair and opening BUILD afterward.

| Check | Result |
| --- | --- |
| Complete Guardian | GREEN on the frozen candidate, all seven gates, none skipped: 771 fast steps, 113 HTTP steps, 515 adversarial attacks across 234 routes, screenshot sweep, 16 golden frames, 47 behavior assertions and 139 journey assertions. |
| Beginner | Six UI steps PASS in 100.252 seconds, through the documented UI-only model boundary. |
| Post-merge CI | [Fast 34630805616](https://github.com/androoAGI/starnet/actions/runs/34630805616), [security 34630805587](https://github.com/androoAGI/starnet/actions/runs/34630805587) and [evaluations 34630805588](https://github.com/androoAGI/starnet/actions/runs/34630805588) PASS on the same commit. |
| Signed build | [34629097326](https://github.com/androoAGI/starnet/actions/runs/34629097326) PASS: Windows, Linux, both Mac architectures, both Mac notarizations, Intel installed launch/recovery. |
| Hosted installer acceptance | [34631356870](https://github.com/androoAGI/starnet/actions/runs/34631356870) PASS: clean install, first launch, idle close, tray/reopen, public 0.11.1 populated-station upgrade/restart, static-setting persistence, installed smoke and bundled provider-fallback/delegated-connector regressions. |
| Updater preparation | Production manifest assembler verified Windows x64 and both Mac updater signatures against the baked public key; hosted feed/version smoke passed. Candidate feed remains unpublished. |
| Personal upgrade | Same-version replacement of earlier bb9 0.11.2 PASS; new executable bytes match hosted acceptance. Installed WebView smoke 9/9 GREEN. All 534 preservation checks pass after install and normal restart. |
| Actual installed pointer actions | The exact bundled Windows driver moved, clicked, double-clicked and dragged inside an owned native test window. Ten checks PASS, including target process ownership, cursor position, down/up counts, double-click event and drag endpoints. Input was refused until the target window was proven. This is installed-driver proof, not affected-customer recovery. |

## Artifact and personal data

- Windows installer: `StarNet_0.11.2_x64-setup.exe`, 130,093,488 bytes; SHA-256 `8b39dab2818acac23097056c8796d1f48668b9a711f09c134f7d56b51e58f416`. Authenticode Valid, Andrew Sims.
- Installed executable: SHA-256 `b34852944e6853b2439eca5bde47b90669a1b786c71e48e6d5dece4f69baf4fc`, 17,882,376 bytes.
- Exact installed driver: SHA-256 `49ad8fbf992eec072dd3078c577ae1792cca8bf0783b1d542e0d4a8f3e5daea0`; source comparison allows only checkout line-ending differences.
- Fresh backup: `C:\Users\andro\AppData\Local\StarNet-release-backups\0.11.2-pointer-20260911-141109`. Contains the prior installation, closed roaming data and local WebView profile. All 39 root workspace JSON/JSONL records hash-match the closed original. Earlier backups remain intact.
- Preserved: 26 crew, 141 props and **73 conversations**, including the two conversations created since the earlier update, plus settings and provider credential availability.
- App left running normally at `C:\Users\andro\AppData\Local\StarNet\skynet-desktop.exe`, without the temporary debugging flag. Final native/API identity is 69baf91a5 / app 0.11.2, idle with its paused routine retained.

The first comparator used an early pre-upgrade UI observation. Before the installer ran, the old app's final drain reconciled one conversation's canonical timestamps/row identifiers and compacted eight checkpointed XP receipt IDs (`chat.js` reconciliation and `xpstore.js` watermark compaction). Conversation text and other crew statistics/configuration did not change. The final comparator uses the actual closed, hash-verified backup as the save boundary; both post-install and post-restart saved state match it. The initial failing comparison and private snapshots remain in ignored local evidence. No product change or blanket field exclusion was used to obtain the pass.

The native test harness initially could not launch its helper under the child PowerShell execution policy, then exposed missing assembly references, a hidden target window and mismatched test-process DPI contexts. Those harness issues were corrected locally; target ownership checks were retained and no application code changed. The final fixture uses the same coordinate context as the installed driver and observes actual native events. Its window closed afterward and the cursor was restored.

## Final readiness and remaining findings

`qa:ready` remains **NOT READY**. The exact current Guardian, journeys, Beginner and installed smoke checks all pass. Two categories remain blocking:

1. Eight unresolved customer P1 reports, as documented in [RELEASE_DISPOSITION.md](RELEASE_DISPOSITION.md).
2. Two shared-ledger P1 findings, `0b802140` and `4692c89f`, from the earlier 14:00 UTC Guardian run on bb9. The crowded 20/21-body fixture flagged `floor/awareness-gaze-only` and `summon/awareness-gaze-only`. The final fresh candidate audit used a smaller 1/2-body fixture, so its green result does not resolve the crowded-floor findings.

Initial triage: the audit classifies any moving body whose next target tile is occupied as awareness chasing. The stored floor snapshot shows a summoned STRATEGIST walking toward the tile occupied by another STRATEGIST; all bodies remain inside their permitted room. This snapshot does not establish movement causality or distinguish an ordinary path waypoint from awareness-induced movement. Neither finding was dismissed, downgraded or marked fixed. Follow-up must reproduce the crowded fixture and inspect movement intent/path state before deciding product defect versus audit false positive.

The ordinary source/installed soak-duration waiver remains in force. The prior recommendation about eight customer reports alone must not be treated as acceptance of these two additional unresolved findings. Public publication remains held; the requested pointer rebuild and personal replacement are complete.

Portable receipts and hashes: `qa/evidence/0.11.2-pointer-cut-0911/manifest.json`. Raw logs, prepared signed artifacts, private backup/comparison inputs and native test helpers are in the owned worktree's ignored `.dogfood/release-0112-pointer/` directory. Evidence-only commits remain separate from frozen integration head 69baf91a5.
