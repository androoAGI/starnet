# Reliability hardening — 2026-09-19

Integrated into local trunk at **`760426bc5`**. Private installer source: `a711f6ea2392e82c2c3fbd9147ebb1ffc02e5e4a` (spending repair `410252bbb`). This pass follows the earlier merged audit; it does not certify product perfection or close customer incidents without affected-system evidence.

## Implemented

- Spending authority: unreadable, corrupt, truncated or unsuccessfully persisted history no longer becomes fresh headroom for configured agent/day/global pools. Unknown totals are null, the budget UI says unavailable, and saved limits remain readable/editable. Failed initial reads cannot submit blank limits. Unlimited policy remains opt-in-free.
- Crash accounting: a main metered run writes a dispatch receipt before proceeding. Completed ledger entries receive independent settlement identities, including multiple charges belonging to one parent run. Restart applies known settlements once, before reconciling dispatch markers, independent of directory order. Unsettled interrupted requests remain unknown. Authoritative history is no longer discarded by rolling rotation.
- Ownership uncertainty: only ESRCH proves a process absent. Permission, I/O and unsupported-probe errors preserve ownership. This fixes one takeover path, not the concurrent recovery race below.
- Browser checks: completed/failed CDP requests clear timers, disconnects reject pending work promptly, and uiplay/refit use the shared implementation. Guardian's outer fast deadline now includes cleanup headroom beyond the inner gate.
- Installed regression coverage: the disposable Windows acceptance workflow now runs spending fault/restart cases using the actual installed Node and source-identity-checked sidecar. No hosted-runner guard was bypassed, and the local installed application was not replaced.

- Acceptance evidence: installed Mac upgrade receipts now read the destination version from the installed Info.plist rather than a hard-coded release number. Missing metadata fails receipt creation; executable regressions cover XML/binary plists, multiple versions and missing/empty values.

- Desktop dependency closure: a private Linux build reproduced a development-only Canvas native binding leaking into the installer. Staging now excludes lockfile dev-only packages across fresh and warm outputs, preserving shared runtime and optional dependencies. This addresses the recurring native-package pattern beyond the previous Sharp-only filter.

## Evidence and validation

Evidence directory: [reliability-hardening-0919](../evidence/reliability-hardening-0919/).

Focused unit tests cover read failures, configured scope variations, opt-in behavior, failed writes, strict bounded reads, unknown PID probes, CDP success/error/disconnect/send failure, and budget loading/error/malformed states. Real sidecar tests cover zero paid dispatch on unreadable history, failed append, restart settlement, repeated restart, multiple settlements sharing one parent, directory-order independence and unknown interrupted spend. A separate real-sidecar boot test preserves an existing owner across EACCES/EIO/ENOSYS.

Live seeded browser proof saved a day limit of 2, restarted the sidecar with a deliberately corrupt isolated ledger, and observed unavailable spend with the limit preserved and a truthful save acknowledgement. The test used an owned scratch station, not customer state.

The initial full fast gate passed 833 steps. After the packaging repair, the updated full gate has 834 steps. Final local gates pass: **834 fast steps, 124 HTTP steps, and 139/139 live browser journey assertions**. The packaging change did not change the sidecar/frontend source exercised by HTTP. Receipts and raw-log hashes are in `qa/evidence/reliability-hardening-0919/validation.json`. Private installed acceptance results are recorded below. The initial private build 35476844504 reproduced the Linux packaging failure and was cancelled after preserving that evidence to avoid completing superseded installers. Replacement private installer run: https://github.com/androoAGI/starnet/actions/runs/35477408214 (`publish-test=false`, signed Mac acceptance required). Source-tree tests are not installed-app acceptance.

## Prioritized unresolved work

1. **P1 — concurrent workspace crash recovery (`c24336d5`).** Reproduced two successful owners on the real filesystem with a deterministic read/rename interleaving. A second reclaimer can rename a newly live holder using its stale read. The retained reproducer is `qa/evidence/reliability-hardening-0919/owner-race.cjs`. A safe fix needs an atomic OS ownership primitive or a recoverable election protocol with crash-at-every-step testing; a second read alone remains racy. Do not disable ownership checks or delete live locks.
2. **P1 — affected Mac boot/install recovery.** Source and CI acceptance do not prove recovery on the reported machine. Preserve the existing catalog-boot case and its affected-artifact requirements.
3. **High-impact spending follow-up.** The overnight verification report still requires its actual run/tool/usage ledger. Main-run receipts do not establish crash-complete accounting for every auxiliary/background model call, paid media integration or remote managed-credit settlement. Provider calls already dispatched can also incur charges before local usage arrives; these are soft observed-spend limits, not guaranteed preauthorized billing reservations. Do not infer a refund or customer incident closure from this fix.
4. **Large/history-damaged ledgers.** The bounded reader now reports uncertainty instead of truncating silently. Lifetime checkpoints/streaming aggregation and reconciliation of historical segments already deleted by older versions still require a separate migration. An independent checkpoint is also needed to detect deletion or replacement with an older, syntactically valid ledger; this patch validates available history, not its complete historical lineage. Unknown interrupted charges need provider reconciliation; deleting receipts or resetting totals would manufacture headroom.
5. **Real provider/connector acceptance.** Actual Ollama no-POST/zero-tool cases, Zoho authenticated bootstrap schema, and managed-provider/billing reports retain their existing evidence requirements. Controlled providers prove local behavior, not those customer accounts or models.
6. **Guardian authority.** Unit and live CDP proof do not constitute a complete fresh scheduled Guardian cycle. The latest pre-candidate cycle (23:23Z, trunk 621bbf467) also failed a 9-second sidecar startup check, cross-origin browser navigation, CDP startup on port 9340 and the library-search journey assertion (138/139). These are not all explained by retained timers. Existing visual differences require review; no golden baseline or finding was dismissed to create green status. The Windows Node 24 native HTTP crash remains separate; gates use Node 22.

No release was published. Source integration and its required gates are complete; this is not a READY or PRODUCT PERFECT verdict.

## Combined integration

The preceding lane released its reservation at trunk `713951f89`. Merged it into this isolated branch at `2c8804eb0`, preserved incoming orchestration authority checks, and locked the combined source at `c71da2625`. Test lists contain 836 fast / 125 HTTP suites with no duplicate entries; shared event/schema contracts were unchanged. Mac receipt repair is `2098a36f9`.

Combined HTTP passed **125/125**, and live journeys passed **139/139**. The first combined fast run hit its unchanged 20-minute limit without an assertion failure; its log is retained. Retained dependency-staging output was moved out of the evidence scan directory into `C:/Users/andro/AppData/Local/Temp/starnet-reliability-0919-staging`, preserving the build output and all receipts. The complete fast rerun passed **836/836** within the unchanged time limit. Trunk briefly advanced to `a8a41c990` with Google credential integration, then its lane rolled back to `713951f89`. This lane integrated only after verifying that restored base. No Google lane code was discarded or modified by this task.

## Installed acceptance results

Windows run [35479606762](https://github.com/androoAGI/starnet/actions/runs/35479606762) passed clean first launch, shell close/reopen, v0.11.1 upgrade continuity and all four installed-customer regression suites, including the hard-crash spending replay test. These used the installed Node and identity-checked sidecar with isolated stations and controlled upstreams. Receipts are in `installed-windows/`.

Intel Mac acceptance retry [105995029124](https://github.com/androoAGI/starnet/actions/runs/35477408214/job/105995029124) passed on the same artifact: SHA-256 `97668c40c4305167f384f3013fa44b3ff9f13c5f35c3557238a1d3bea173d03c`. Gatekeeper, Finder launch, sidecar boot, v0.9.0 station recovery/source preservation and restart all passed. Preserve attempt 1's Gatekeeper rejection as an intermittent trust-path finding; a retry pass does not explain its cause. Apple Silicon build/notarization passed but installed acceptance was not run there.

The original Intel receipt falsely says upgrade destination 0.10.0 because the verifier hard-coded that field. The original evidence is preserved unchanged. Fix `2098a36f9` reads the actual installed Info.plist and rejects missing version metadata; executable regression covers XML, binary, multiple versions and absent/empty values. It does not retroactively change the CI receipt or claim the corrected writer ran on that Mac.

The tested private installers use source `a711f6ea2`, before the orchestration merge and receipt-writer fix. Their receipts prove those exact artifacts, not an installer rebuilt from the eventual combined trunk. Windows installer SHA-256 is `ff98fc80c455ace232b8a57ebc67800b19599696ff8dd886cc6d3b5585d7297e` (640,556,504 bytes, valid Authenticode, publisher Andrew Sims). No local user installation was replaced.

## Final integration result

**Merged at `760426bc5`; full post-merge fast 836/836 and HTTP 125/125 passed on Node 22.23.0.** The integration and verification worktrees had identical tree `54d2ab62c69e3a6d686be77c15869d4983b5ee1f`. Combined live browser journeys passed 139/139 before integration. `combined-validation.json` preserves successful pre/post receipts plus the first timed-out fast attempt; `combined-journeys-report.json` contains the actual combined UI assertions. Only evidence/report files change in the final receipt commit. Existing dirty operational notes were preserved.

The register validates: 201 reports, 12 open, including the two P1 cases listed above. Five reproduced defects were repaired in this pass (spend authority, uncertain PID takeover, retained CDP timers, dev-only desktop dependencies, and the installed-version receipt); budget UI and Guardian deadline safeguards accompany them. Complete auxiliary-call accounting, atomic crash ownership, historical spend lineage, affected-customer acceptance, intermittent Mac trust lookup and a fresh complete Guardian cycle remain explicit follow-up work.
