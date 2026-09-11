# 0.11.2 last call — September 11, 2026

Historical source-preparation receipt. The subsequent signed 0.11.2 cut, additional paused-routine repair, personal installation and final readiness verdict are recorded in [EXECUTION.md](EXECUTION.md).

Merge `c9b6a67f84d6f3a37e83d6043189000c75271843` is included in the candidate and the release notes. It adds persistent CRT static strength without changing the existing 100% appearance. The candidate also contains the provider-fallback, delegated-MCP and queued-save restart repairs from the preceding closeout.

No new application defect was reproduced in this pass. The release remains **NOT READY**; eight earlier customer P1 reports remain unresolved, and the final release freeze still needs its canonical installed-artifact acceptance. The ordinary soak-duration waiver remains in force.

## Verified on the frozen candidate

| Check | Result |
| --- | --- |
| Full Guardian | Seven gates GREEN, none skipped: 771 fast steps, 113 HTTP steps, 515 adversarial attacks over 234 API routes, screenshot sweep, 16 golden frames, 47 behavior assertions and 139 journey assertions. |
| Fresh onboarding | Six UI steps PASS on the exact candidate, through the documented UI-only model boundary. |
| CRT settings in the running app | 0%, 45%, 100% and 200% apply/save; 45% survives reload. The grain preset remains 0.26; the multiplier alone changes. Slider geometry stays within its row. No browser exceptions. |
| Brief rendering sample | Across 120 frames at each of 0%, 100% and 200%, median frame interval was approximately 33.3 ms at every level. This was a headless source check under concurrent QA load, not a performance guarantee for every GPU. |
| Native builds | Windows, Linux, Apple Silicon and Intel Mac PASS; both Mac notarizations and Intel installed acceptance PASS. |
| Windows installation and upgrade | Clean install/first launch, idle-close, close-to-tray, published 0.11.1 to candidate installation, populated-station preservation and normal restart PASS. |
| Compiled desktop CRT control | Historical profile opens at 100%; 0%, 200% and 45% apply/save; 45% survives normal desktop restart. |
| Exact installed WebView | Nine smoke checks PASS with matching candidate commit/tree and executable bytes. |
| Installed customer regressions | Provider fallback and delegated MCP suites PASS using the installed Node/sidecar bundle and controlled upstream services. |

Build: [34571871677](https://github.com/androoAGI/starnet/actions/runs/34571871677). Installed proof: [34573167978](https://github.com/androoAGI/starnet/actions/runs/34573167978), controlled by `01200c9a1`. The new controller retains candidate Git history for exact source-tree verification and adds the installed static-setting and WebView checks; it does not alter application runtime behavior.

The Windows installer has a valid Andrew Sims signature. Installer SHA-256: `78c0a42bc4f902fdd9a8ad79bedabc50b451016f76099d680479bc7742c55a2f`. Installed executable SHA-256: `86e3d108ea95843bdcb72750dc24ab7b44228f3d18a9a06dad58db75dcfd5b94`.

Original identities, hashes and portable receipts: [last-call evidence](../../../qa/evidence/0.11.2-lastcall-0911/manifest.json). The installed smoke receipt retains its hosted-runner paths; it was not relabeled as a local canary test. Earlier failed upgrade attempts and their repair remain in the preceding closeout evidence.

## Remaining release work

The latest support-mail and GitHub review added no recovery confirmation for the eight earlier reports. [CUSTOMER_RETESTS.md](CUSTOMER_RETESTS.md) lists the precise evidence still needed for idle usage, missing ONCE jobs, Mac relink, false zero-credit warnings, managed Sonnet errors, blank viewports, equipment projection and Mac catalog boot failures. Installed tests against controlled endpoints do not establish the reporters' account/device recovery.

The frozen-candidate readiness receipt has two failing categories: the eight open P1 records and the machine-local installed stamp still naming the older canary. The new hosted installed proof is separately GREEN; it is not substituted for that older local receipt. Guardian, journeys and Beginner receipts were refreshed to `c9b6a67f8` with their original identities. Subsequent QA/documentation commits must not be represented as the tested executable.

Official version pins remain 0.11.1. This private candidate proves a manual same-version NSIS upgrade from the real public 0.11.1 build; it does not prove a published automatic 0.11.2 feed. Once the remaining reports receive evidence-backed dispositions, use a clean release checkout, update all five version pins, run the post-bump gates and staged-artifact checks, then make the publication decision. The integration tree's pre-existing operational edits were preserved. No public tag or release was created.
