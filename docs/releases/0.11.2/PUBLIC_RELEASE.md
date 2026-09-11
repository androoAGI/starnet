# 0.11.2 public release execution

**COMPLETE — published September 11, 2026 at 20:16:08 UTC.** [Download 0.11.2](https://github.com/androoAGI/starnet-releases/releases/tag/v0.11.2). The [source release mirror](https://github.com/androoAGI/starnet/releases/tag/v0.11.2) is also public. This is the final disposition; earlier pending/held notes below or in preceding handoffs are historical.

## Owner decision and engineering closure

On September 11 the owner directed finishing and publishing the update, then clarified: "as long as we proved it and dealt with it were good to go" and that affected users are not available as a required test pool. Engineering reproduction, repair and verification are the acceptance standard. Customer recovery remains a separate, truthful field. This supersedes the earlier customer-confirmation hold in RELEASE_DISPOSITION and CLOSEOUT; the separate extended-soak waiver also remains in force.

Five records now close as source-fixed based on concrete engineering proof already present, without claiming an affected-customer retest:

| Record | Verified repair | Source commit |
| --- | --- | --- |
| 72af29f4 — false zero-credit warning | Stale-account replies and retired warnings lose authority; local holds preserve service-observed balance. | c364e991d |
| eaaa3ec8 — reload/relink recovery | Delayed pairing and keychain replies cannot undo unlink; state survives restart. | c364e991d |
| 9256a771 — blank viewport | A reproduced dead visible-stage canvas is rebuilt; installed fault recovery and bounded idle pass. | 57112a690 |
| c2a6c3c8 — missing ONCE routine | Creation confirms the saved job and retains drafts on ambiguity; installed create/update/restart/fire-once path passes. | 2b976f5f3 |
| 432df352 — saved equipment/tool disclosure | Saved floor equipment reaches interactive tool projection; tool diagnostics and Last run/restart correlation pass. | 3c95b184f |

The exact historical account/device/configuration correlations remain unconfirmed. That does not erase the independently proven source repairs. Their records retain all prior evidence and explicitly distinguish engineering closure from installer-specific and customer outcomes.

Three investigations remain open rather than receiving invented fix commits: the historical uncorrelated managed Sonnet 400 (fd9c4b4d), unexplained account usage without the account ledger (acb47320), and Mac catalog loading without the affected origin/build (2f156837). Current managed requests, controlled idle/charge reconciliation, and catalog/installed boot checks pass; no specific current defect was established for those reports. Under the owner's clarified release direction these remain tracked follow-ups, not a requirement to obtain customer testers before this release. No severity was lowered and no customer recovery was fabricated.

## Frozen cut and preflight

Tag `v0.11.2` points to `69baf91a5b2c22230f87e614da6a72882278bc6c`, the already verified signed candidate. Both requested merges, c9b6a67f8 and 33c925797, are included. Documentation, disposition and evidence changes are retained separately so the application source does not move during release.

The production ritual accepted the original exact-candidate fast 771/771 and HTTP 113/113 logs, and verified version pins, release notes, release-surface lock, website mirror, signing-key presence, tag availability and remote source identity. It stopped on the uncommitted operational NEXT notes and aggregate readiness. Those operational edits were preserved; the tag names the committed tree explicitly. No application source dirt was present.

The aggregate remains a truthful raw result, not an invented READY: the frozen source register predates the five engineering closures, and a newer hourly Guardian run repeated the already disproved occupied-waypoint/gaze heuristic. That 19:00 run passed fast, HTTP, adversarial, visual and journey gates; its only hard audit failure was `floor/awareness-gaze-only` with 24 bodies. The independent 20-body causal proof and negative control are retained in CLOSEOUT. Neither its raw red stamp nor the original report was overwritten to create a green result.

The owner-directed release exception applies to this documented acceptance boundary. Signing, actual installer integrity, draft acceptance and public feed verification remained required and all passed before/after publication as detailed below. The immutable tag was pushed through the official release train and its verified draft was published.

Release train: https://github.com/androoAGI/starnet/actions/runs/34639855021

See POINTER_CUT.md for the preceding exact-candidate Guardian, private signed build, hosted installer acceptance, 534 personal preservation checks and native pointer verification. The final tagged installer is verified separately below.

## Final public artifact and update proof

Original receipts and their SHA-256 manifest are retained in `qa/evidence/0.11.2-public-release-0911/`. All 27 copied receipts retain their original bytes; private personal save snapshots and credential contents are excluded.

| Check | Result and receipt |
| --- | --- |
| Signed release train | [34639855021](https://github.com/androoAGI/starnet/actions/runs/34639855021) passed: fast 771, customer journeys, signed Windows and both notarized Mac builds, installed Intel launch and legacy station recovery, draft assembly. |
| Exact draft clean install | [34642893710](https://github.com/androoAGI/starnet/actions/runs/34642893710) passed on the final Windows installer. |
| Exact draft lifecycle | [34642921798](https://github.com/androoAGI/starnet/actions/runs/34642921798) passed idle-close, close-to-tray and updater-smoke. |
| Previous public installer upgrades | Original train receipt passes 0.11.0 and 0.11.1 manual installer upgrades, populated state preservation, missing-old-uninstaller recovery and future uninstall behavior. |
| Actual public Update Center | [34643340260](https://github.com/androoAGI/starnet/actions/runs/34643340260) passed all 10 automatic 0.11.1 → 0.11.2 checks, including install, automatic healthy restart, exact source/executable identity, saved state and credentials across update/restart, no pending update, installed smoke. Its separate post-publication lifecycle job also passed all three cases. |
| Source mirror | [34643342855](https://github.com/androoAGI/starnet/actions/runs/34643342855) passed; all three mirrored human installers have identical sizes and digests to distribution. |
| Public feed | Version and all three platform URLs verified; every URL returned HTTP 200. All nine distribution asset digests matched staged local artifacts before publication. |
| Personal installation | Public installer exit 0; closed-state backup verified 39 workspace records; 534 preservation checks passed after install and again after restart. Installed smoke passed 9/9. Update Center reports current 0.11.2, no pending update. Final normal launch responds with the exact source, zero active runs, one paused routine and lifecycle disarmed. |

The public Windows installer is `StarNet_0.11.2_x64-setup.exe`, 129,757,152 bytes, SHA-256 `d3ecca65a517d0270ee9e20bd085cee56b02e3f15fe6470cf98c221ae1684f16`, valid Andrew Sims Authenticode and verified updater signature. The installed executable is 17,882,376 bytes, SHA-256 `d6d2152f35d19e4aa8f4ef0a63d78a7b9fbd8c5106b2402a500ed700dff4bd6c`. Hosted automatic upgrade and personal installation report that same executable, clean source `69baf91a5`, tree `930d6dc2c4f556f9f22ded59f0f9cbfcc72d3fe5`, describe `v0.11.2`. These public signatures/build identities supersede the earlier private candidate artifact identities without moving the source tag.

The automatic canary first proves the installer's own visible restart and healthy sidecar. Because NSIS drops diagnostic browser flags on restart, it then closes and reopens that verified new installation with CDP solely for state inspection; the receipt records the distinction. The user's personal app was finally restarted normally without diagnostic flags. Its 26 crew, 141 props, 73 conversations, settings, paused routine and credential availability were preserved.

Two receipt interpretation limits remain explicit: draft-mode clean-install provenance fields are null and correlate by exact installer hash; the Intel legacy-recovery receipt contains historical layout labels rather than the candidate's semantic version. Actual candidate identity comes from the tagged train and artifact digests. No customer retest, extended soak, or global aggregate READY is claimed. GitHub issues #12 and #13 are closed completed; the three uncorrelated investigations above remain tracked follow-ups.
