# Latest native acceptance

Final publication status and source-bound evidence: [PUBLICATION.md](PUBLICATION.md). The earlier reports below are historical.

The later signed candidate passes the candidate-bound READY gate. See [NATIVE_RESULTS.md](NATIVE_RESULTS.md) for exact source, signed installation/upgrade evidence, owner-accepted Mac risk, and remaining real-account/automatic-update limits. The earlier audit below is retained with its original source scope.

---

# StarNet 0.12.4 release-readiness audit

Status: **BLOCKED — not approved for release**. No tag, push, release, publication, updater pointer change, or installed-app replacement was performed by this audit.

Baseline: `v0.12.3`. Integrated input: `d5045ac93`, including the project COMMS merge that arrived during this audit. Combined candidate source: `0c5f0d54a73122105ace05f9ca4627b5a94bb774`, on isolated branch `agent/release-audit-0124-0920`. Earlier complete validation at `f4021a682` predates that merge and is retained as historical evidence, not proof of the combined candidate. Changes remain reviewable in the audit branch. Existing integration-tree work was preserved. Version pins were advanced locally to 0.12.4 with the repository's no-tag release preparation command.

## Scope and evidence rules

The accompanying change inventory records all 399 changed paths from v0.12.3 through the combined candidate. It includes file hashes, categories, and the fast, HTTP, and customer-journey manifests. Inventory completeness does not mean independent live proof for each path.

Review traced the changed production flows into existing storage, identity, permissions, budgets, scheduling, tool dispatch, event streaming, frontend state, and desktop packaging. Existing evidence was treated as historical, not relabeled as proof of this combined candidate. Controlled upstream providers exercise production adapters and local sidecars; they do not establish real-account OAuth, billing, or third-party availability.

## Verified issues fixed during this audit

1. **Encrypted connector backup destruction.** A current store containing JSON `null` was treated as absent; startup then sealed empty state over both current and last-good encrypted backup. The real-sidecar baseline reproduction showed one saved connector becoming zero and the backup changing. The vault now rejects non-object JSON and stays locked without writing. New HTTP regression covers two boots, visible locked state, byte preservation, explicit backup restoration, and successful recovery. Fix `42ad5937f`; durable regression `test/connector-vault-invalid.http.test.js`. Related bug `0428b50d`.
2. **Concurrent stale workspace takeover.** The original real-filesystem reproducer allowed both reclaimers to report ownership. Immutable generation tickets now elect one writer before primary-lock mutation. A complete ticket and primary claim are atomically published by hard link; release markers never recycle generations. Tests kill actual child processes at five publication boundaries and race eight real processes. The real-sidecar second-writer/restart test also passes. Fix `d9f9b71f0`; related bug `c24336d5`.
3. **Recovery activation before the ordinary owner guard.** Whole-workspace recovery now holds a separate immutable election outside the directory it can replace. Nested recovery cannot enter its mutation section concurrently. Unknown cron PID-probe errors now fail closed; only ESRCH proves a process absent. Fix `a238fae14`.
4. **Vulnerable transitive dependencies.** Updated Sharp 0.35.3 to 0.35.4 and adm-zip 0.6.0 to 0.6.1, including lockfile and exact bundle expectations. npm audit changed from five advisories (four high, one moderate) to zero. Fix `1b9795445`. Advisory references: GHSA-rgj7-g3m4-5g8c, GHSA-7q85-xj36-vmfc, GHSA-vwc7-r8mq-g2x9.
5. **False fresh-user campaign failure.** Beginner's workspace lived directly beneath the shared temporary directory, allowing other tests' sibling update snapshots to trigger lineage recovery. The entire parent/profile is now isolated. Original failure and diagnostic remain preserved; the repeated live UI campaign passed all six steps. This is test isolation, not a claim that actual customer lineage recovery was broken. Fix `2595e5a66`.
6. **Project reopening and failed-open identity.** The late project COMMS merge cleared the crew DOM without clearing its render signature. A real browser and sidecar showed crew control counts `[1,0,0]` when switching between projects; the fix gives `[1,1,1]`. Failed or revoked-project opens now preserve the actual conversation title and identity; choosing another session cancels an outstanding open instead of allowing it to steal focus. Controlled network failures and a real revoked folder were exercised in the running app, with zero browser exceptions. Fixes `dc1257f03` and `4c09cec32`; bug `629c9bd7`; regression `test/project-home-ui.test.js`.
7. **Screenshot readiness.** The golden runner froze an early OFFLINE canvas before SSE recovery finished, while the DOM later showed ONLINE. It now requires a live bridge and two paints before freezing, failing loudly on timeout. All 15 flagged frames were inspected; the responsive COMMS width accounts for the intended structural change. Reviewed captured signatures were adopted without widening the 1.5 threshold or suppressing findings. A separate fresh capture passed. Fix `7d97b2349`; per-frame hashes and review rationale are retained in `visual-review.json`.

Workspace-election limitations: local filesystems must support hard links; unsupported storage fails closed. Generation records intentionally accumulate rather than risking unsafe reuse. This protocol cannot coordinate with concurrently running older binaries that do not implement it. Normal desktop single-instance enforcement and closing the prior app remain required during upgrades.

## Interaction review and journey coverage

| Area | Interactions inspected and exercised | Remaining boundary |
| --- | --- | --- |
| Onboarding | Boot catalog staging, older-WebKit syntax fallback, contrast, clean profiles, create-overseer ceremony, first directive | Beginner fixture does not prove real sign-in; affected Mac boot recovery remains open |
| Authentication | Launch token and Origin checks; provider pairing, expiration and recovery; saved-provider selection; connector OAuth refresh/removal races | Current real-account provider and billing acceptance not established |
| Overseer and agents | Existing roster identity, named working sessions, automatic result review, queued user history, synthetic-message exclusion, halt/resume, lightweight polling | Controlled provider; no claim of arbitrary model task quality |
| Conversations | Restore-before-send, drafts/focus, partial streams, explicit run-end authority, interrupted tool history, durable transcript/restart | Native WebView acceptance required in addition to Chrome |
| Conveyors and station | Delivery exactly once, filters/mergers, approvals, autosave and refit projection, movement/right-of-way | Native small-screen/DPI and Mac visual acceptance outstanding |
| Integrations | Selected-file Google scope boundary, deferred broad Workspace services, connector secret migration/readback, keychain failure, MCP session recovery | Publisher registration, real consent/picker, locked native keychain on exact installers outstanding |
| Local storage | Malformed/unreadable main and backups, write failure, acknowledgment timeout, permission ordering, exclusive workspace mutation, explicit recovery | Native filesystem/keychain acceptance on macOS outstanding |
| Updates | Snapshot/recovery exclusions, runtime dependencies, bundled catalog, five version pins, candidate provenance and signing contracts | Signed updater path, install/upgrade/relaunch/rollback of exact candidate outstanding |
| Error recovery | Process death, malformed payloads, permissions, budget accounting unavailable, network interruption, E-STOP, stalled acknowledgments | No extrapolation from injected faults to every OS failure |

## Validation

Final combined-source results at `0c5f0d54a`: Guardian GREEN, all seven gates executed with none skipped. Fast 841/841 steps; HTTP 129/129 steps; adversarial sweep 523 attacks across 238 literal routes; screenshot sweep and all 16 golden frames pass without suppression; behavioral audit 49/49 assertions; interactive journeys 139/139 assertions. Separately, customer journeys 38/38 and beginner UI-only 6/6 pass. Rust default tests: 54 passed, two ignored; the isolated native process-reaping test then passed separately, and the persistent Windows keychain roundtrip subsequently passed in two independent processes. All 56 Rust tests have therefore passed across separate invocations; see [BLOCKER_FOLLOWUP.md](BLOCKER_FOLLOWUP.md). Final Windows build, evidence lint, 183 changed-JavaScript syntax checks, Rust formatting, and claims planning pass; npm audit reports zero advisories. The native adapter's 8/8 result is retained from the earlier source; its implementation did not change in the late project merge.

Final candidate-bound readiness: **NOT READY**, two reasons: open Mac P1 and no installed-executable smoke. The earlier `f4021a682` Guardian cycle passed six gates and failed only the 15 visual changes awaiting review. Those original failures remain recorded. After visual review, the corrected capture/baseline passed a fresh immutable combined-source cycle with zero flags and zero excused frames; the 15 earlier operational findings were closed against that evidence. The audit branch is not merged into integration; integration-bound readiness also rejects receipts for a different source commit.

Final command results and exact scopes are recorded in the adjacent validation receipt. Local raw logs and browser artifacts remain in the owned worktree under `.qa_tmp/release-0124`, `.uiaudit`, `.uijourneys`, `.bugloops`, and `.dogfood`.

Earlier-source supplemental live checks retained with their original provenance: 521 adversarial attacks across 237 routes; panel sweep without uncaught exceptions; 20 viewport/zoom/focus combinations; populated refit placement; file drag/paste/picker, delayed upload, session re-entry and oversize rejection. On the final combined source, native CUA was rerun successfully: isolated install/checksum, independent private runtime cancellation, and a ten-stage real Notepad workflow with screenshot transport and disk verification. Individual click receipts remain truthfully marked unverifiable where appropriate; the file outcome was independently read from disk. These Windows checks do not certify macOS.

Combined-source supplemental proof: visible project-rail entry, repeated crew switching, failed requests, revoked folders without conversations, and delayed-open focus cancellation pass in the real browser/sidecar. The backend project journey passes stable conversation identity, preferred crew, project isolation, steering, automatic result return, restart, and trust revocation. A matching Playwright WebKit engine (26.5) on Windows reached all 16 panel states with no page exceptions; its final frame was visually inspected. This is Windows WebKit coverage, not macOS acceptance. An earlier attempt using a mismatched installed browser stalled and was terminated; it is retained as an unsuccessful environment attempt.

Exploratory successes are retained separately and are not substituted for final gates. There is no standalone TypeScript configuration or npm typecheck/general ESLint command; Rust compilation supplies native type checking, and repository-specific lint assertions belong to the fast gate.

Failed attempts remain evidence: an initial fast run encountered the audit's then-unfinished bug record; an initial HTTP run timed out starting the workshop fixture under concurrent compilation; the initial desktop build produced a 0.12.3 exploratory installer but exited at missing updater private-key signing; a Rust test attempt overlapped frontend restaging and failed to read removed/replaced assets. A first native ad-hoc wrapper used a Windows path instead of a file URL for ESM import; it was corrected. Drag/drop initially lacked Playwright and passed after selecting the bundled runtime. The final beginner invocation initially selected an out-of-lane port and was refused before boot; it was rerun on allowed ports. These failed attempts do not count as candidate passes. Final validation must run without source edits or overlapping frontend staging.

The final combined-source Windows NSIS build passed with a local configuration override disabling updater-artifact signing only. Product/file version is 0.12.4; bundled Node is 22.23.2. Installer: 640,515,736 bytes; SHA-256 `0c755a955f309243eedc279e5bfc33e9860196c1b9eb9c6ea5c9adba0b01b568`. Executable: 274,099,712 bytes; SHA-256 `ebf07778b59a8beb415bce57203e647ff171251240d3a8e1ee68dd9a263fe392`. Authenticode: NotSigned. It has not been installed or distributed. Earlier artifact hashes in retained logs refer to earlier builds and are superseded by `artifacts-final-combined.json`.

## Large-station performance observation

The configured 3,000-conversation budget audit initially failed startup (5,802.96 ms vs 2,500 ms) and recovery-list median (162.59 ms vs 150 ms), while storage correctness and all other budgets passed. A paired code comparison using identical synthetic data and current dependencies measured candidate startup at 882.20/851.33 ms and baseline v0.12.3 at 4,801.98/919.23 ms; candidate recovery medians were 135.62/111.07 ms versus baseline 143.34/116.84 ms. This does not demonstrate a candidate regression, but it also does not certify cold installed startup. The complete budget audit then passed with unchanged thresholds. Both attempts and the comparison are retained; fresh installed cold-start acceptance remains owed.

## Release blockers and acceptance still owed

- Fresh exact-candidate signed Windows install/upgrade/relaunch and updater acceptance, including Credential Manager migration and restart. The local unsigned package is only a build check. Signing credentials are absent locally; the follow-up confirmed signing secret names are configured in GitHub, but the candidate is not uploaded.
- Native Intel and Apple Silicon macOS build, trust/notarization, installed boot, WebKit UI, Keychain lock/unlock/migration, upgrade and recovery. This host is Windows. Older CI receipts do not certify the combined candidate.
- The tracked bug register still contains 11 open items (one P1, ten P2); uncorrelated customer credit, provider, Zoho, local-model, unsupported-Mac and Node-24 reports were not marked fixed without a reproduction.
- Customer Mac boot failure `2f156837` remains P1/open. Source hardening is included, but affected-machine recovery is not proven.
- Real-account authentication and selected-Google-file acceptance on the exact installed artifacts; broad Google Workspace activation remains intentionally deferred.
- Fresh candidate-bound Guardian, beginner, journeys, installed-smoke and readiness receipts after final integration. Do not copy old receipts or change open verdicts to force readiness.

No release approval is requested while these remain unverified. Continue in the same isolated branch, build the exact approved candidate through non-publishing CI or disposable platform hosts, preserve artifact hashes, complete the missing acceptance, then rerun `npm run qa:ready`. Only a genuine READY receipt can support the requested final approval.

The remaining native checks and isolation requirements are detailed in [NATIVE_ACCEPTANCE.md](NATIVE_ACCEPTANCE.md).
