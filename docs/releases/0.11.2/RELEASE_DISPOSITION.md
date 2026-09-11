# 0.11.2 release disposition — September 11

Superseded acceptance decision: [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md) records the owner's clarification that our verified engineering repairs are sufficient without affected-customer retests. Five records close as source-fixed; three uncorrelated investigations remain tracked. The earlier assessment below is retained as history, not the current publication hold.

The owner authorized the final focused release pass and installation of 0.11.2 over their personal StarNet. The ordinary source/installed soak durations remain waived. This does not supply missing customer evidence or waive unresolved P1 reports. The candidate contains all five 0.11.2 version pins, final notes, the release-surface lock, and merge `c9b6a67f8`. The execution receipt records its final immutable identity.

## Customer report decisions

The eight records were reviewed against their reproduction, repair and installed evidence. None has a new affected-customer receipt sufficient to close it. They remain open at P1; no severity was lowered to make the gate pass. They are historical unresolved reports, not eight defects reproduced on this candidate.

| Report | Evidence-based disposition | Remaining release uncertainty |
| --- | --- | --- |
| fd9c4b4d — managed Sonnet 400 | Keep open. Production gateway requests and a separate assistant-prefill repair pass; the positive customer follow-up does not identify a successful affected-model run. | Managed task access: missing failing/recovered request correlation. |
| 72af29f4 — false zero-credit warning | Keep open. Stale-account and balance-observation repairs pass source and packaged-sidecar regressions. | Billing UI accuracy: no same-account balance/banner receipt. |
| eaaa3ec8 — Mac reload/relink | Keep open. Link-race repairs and notarized Intel startup/recovery pass. | Native access on the affected Mac: no Apple Silicon paid-link/keychain reproduction or recovery. |
| 9256a771 — blank viewport after idle | Keep open. Installed bounded idle and injected renderer recovery pass; backdrop performance repairs are included. | The affected GPU/display configuration and renderer failure remain unidentified. |
| acb47320 — unexplained idle usage | Keep open as an investigation. Controlled idle and real task/gateway receipts reconcile. No billing defect is established by the supplied report. | No affected-account run/charge/schedule ledger to explain the reported usage. |
| c2a6c3c8 — missing ONCE routine | Keep open. The installed create/update/restart/due-time path retained one job and completed it once. | Historical disappearance lacks the affected job ID and save/list responses. |
| 432df352 — equipment/Trusted Project | Keep open. Saved-floor grant loss and disclosure were repaired; installed protocol tests and real file tasks pass. | The reported Qwen/Trusted Project/Last run configuration was not reproduced. |
| 2f156837 — Mac catalog boot failure | Keep open separately from relink. Windows loads the exact catalog bytes and boot-guard regressions pass. | The report omits app version, full origin and failed script response; native versus website is unknown. |

GitHub #12 and #13 have source and installed regression proof, separately from customer-account recovery; their public issues remain open. #10 remains a feature disposition. The fresh GitHub read found no new recovery evidence. No customer messages were sent and no issue was closed.

## Security gate

Run `34574117336` flagged `delegatedFullAccess` in historical verification JSON. Its value is Git commit `b4bcdac904f5574ee4541c0cfae5de400592ee69`, verified as an existing repair commit, not an API credential. The correction allowlists only the exact commit/file/rule/line fingerprint. Full-history scan `34575675942` passed afterward. Other findings in the same file remain subject to scanning.

## Publication boundary

Prepare and verify the signed 0.11.2 candidate and personal upgrade now. The aggregate must continue to report NOT READY while the eight P1s are open. A public stable release requires either evidence-backed resolution or an explicit owner decision accepting these documented uncertainties. Do not inherit the separate 0.11.1 aggregate waiver, relabel earlier receipts, or weaken the readiness controller.

The final installer, preservation, signature and gate receipts will be recorded with their exact source and artifact identities in the execution receipt.
