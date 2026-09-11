# 0.11.2 public release execution

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

The owner-directed release exception applies to this documented acceptance boundary. Signing, actual installer integrity, draft acceptance and public feed verification remain required. The tag was pushed through the official release train; publication is pending successful signed artifacts and final staged-installer checks.

Release train: https://github.com/androoAGI/starnet/actions/runs/34639855021

See POINTER_CUT.md for the preceding exact-candidate Guardian, private signed build, hosted installer acceptance, 534 personal preservation checks and native pointer verification. The final tagged installer is verified separately below when available.
