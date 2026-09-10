# Glass interface integration audit — 2026-09-09

The complete glass interface is the default presentation, including COMMS, model/reasoning selection, session signals, dock menus, widget pickers and docked windows. The approved world upgrade is incorporated. Merged into `feat/harness-backend` as `c275727ea2344bd208d16313f3280edce68da0a7`. No push, installer, deployment or release was performed.

## Candidate

Branch `agent/glass-demo-0909`; runtime integration `bd390967817b0fbc98e3add6604351910912b172`; final regression candidate `26d483abc341d5ef2ee7db3dcee18e3c4102a77e`; pre-merge trunk snapshot `209ce13579ba919329d96886ed1c0b2e9997ecfe` is an ancestor. The merge rehearsal is clean. Backend, package manifest and shared contracts have no branch changes against that trunk.

Glass styles load before first paint and the body starts with the glass material. BootGuard remains the first script, followed by legacy migration and glass selection. `?glass=0` is an explicit diagnostic fallback; `?glass=1` remains compatible. Internal demo filenames are retained, but the visible demo badge is gone. Frontend and website mirror are synchronized.

## Repairs found during the audit

- Escape from a terminal text field previously blurred to BODY, leaving the next Escape unable to close the dialog. It now returns focus to the dialog while preserving field content and the existing unsaved-draft close guard. Bug `8b2ef7e7`, source `e6ecdd986`.
- Cold Appearance thumbnail generation blocked the UI thread for 1439–1559 ms; sampled GPU readbacks accounted for 1231 ms. Scratch canvases now use CPU readback storage, and the same real sky/terrain sample functions render in a worker. Late responses cannot paint closed windows, bitmaps are disposed, and unsupported/failed workers retain the renderer fallback. Bug `63f08158`, source `db3ae6bb4`.
- The full fast gate caught two integration issues: an initial glass boot placement violated BootGuard ordering (repaired before sign-off), and OAuth parity expected a removed frontend key-warning helper. The latter now executes the actual selection handler for every registry OAuth provider and proves provider identity, persistence and selection without a browser-held key. Authentication remains owned by Harness and the sidecar.

## Live verification

- Five repeated open/close/reopen and minimize/restore cycles; maximize/restore, keyboard resizing, first/second Escape, stale callback cancellation, no orphan dock chips or inert restored dialog.
- Settings, Deliverables and Abilities; both widget pickers and their searches/tabs; model search, empty results and focus restoration; slash dismissal without sending a message.
- 1280, 899, 640 and 390 px widths, plus 145% text, with sheets and close controls inside the viewport. Reduced motion produces no sheet animation. Explicit legacy fallback opens successfully.
- Eight of eight real Appearance previews rendered in the worker. The combined world/glass sweep recorded zero uncaught errors, a 16.6 ms p95 frame interval across 2533 samples and a longest main-thread task of 144 ms. These are measurements on this local headless Chrome run, not a universal hardware guarantee. The pre-world worker run's maximum was 87 ms.
- Separate real-sidecar journeys cover task lifecycle, stop, panel close, reload during work, rapid sends/toggles, deliverable opening and slash dispatch: 139/139 assertions, no soft failures.
- Behavioral audit: 47/47 assertions, including a real paused permission request, the session lamp's `Approval needed` state, approval click and run resumption. The local controlled provider is deterministic; no paid model request was made.
- Fresh-user UI flow: 6/6 steps passed in 122395 ms. It reaches the first-command model boundary; it does not claim an authenticated first deliverable.
- The user's open seeded preview at `http://127.0.0.1:9199/` still renders, with no inspected browser warnings/errors. Existing theme, draft and station data are preserved.

## Gates

- Full fast: 752/752 steps PASS.
- HTTP: 108/108 steps PASS.
- Customer journeys: 34/34 steps PASS.
- Release-source planning authority: PASS, 37 claims and 239 locked surface files. Existing claim verdicts and live-proof flags are preserved; only the mechanical source receipt and the actual consent-code locator were reconciled.
- Website mirror, bug-register validation, whitespace check and evidence-secret scan: PASS.

The final trunk follow-up changes only the default shell material for newly created starter rooms. Full fast (752/752) and fresh startup (6/6) were rerun afterward. HTTP and customer-journey receipts remain from `028b0d321`; their backend and corresponding UI flow code is unchanged. The earlier combined interaction/performance capture retains its original source SHA.

## Post-merge verification

The source merge tree `22ade9089bf1f45f9de306a8b517f28d505b7984` exactly matches integrated candidate `0e8c0ad8d`. The full post-merge fast gate passed 752/752 on trunk. The retained preview advanced to the merge SHA and its repeated interaction sweep passed with zero uncaught errors, eight worker previews, 16.6ms p95 frames and an 89ms maximum main-thread task. Proof: `qa/evidence/glass-postmerge-interactions-0909.json`.

Integration had unrelated changes in QA STATUS and an untracked Rooms handoff. Git autostash preserved the QA edits; byte/hash checks confirmed the handoff was untouched and the final QA content was exactly our owned prefix plus the original working file. Foreign changes remain unstaged. The preview worktree is retained because its local server is in use.

## Release limits

`qa:ready` remains NOT READY. There are seven existing open P1 customer reports, no Guardian cycle receipt in this worktree, and no installed-app smoke receipt. The passing branch journeys and Beginner Run cannot satisfy the tool's exact-trunk requirement before merging. The product-perfect terminal audit also retains its broader pending proof obligations. No existing customer bug or terminal claim was marked green from these UI tests.

The post-merge check in the integration checkout remains NOT READY with six reasons: four existing Guardian findings (1 P0 detector timeout and 3 P1 findings), seven customer P1 reports, a prior RED Guardian cycle, older journey and Beginner Run source stamps, and an installed binary from an older revision. These existing records were not silently closed from adjacent source tests.

The installed Windows/macOS builds, customer-specific GPU/DPI cases and authenticated provider flows remain outside this browser/source receipt. In particular, the prior customer report of a blank viewport after prolonged use stays open; a successful local spot check does not establish its cause or recovery.

## Evidence

Tracked gate counts, log hashes and release limits: `qa/evidence/glass-merge-checks-0909.json`. Tracked interaction details: `qa/evidence/glass-interactions-0909.json`. Repro runner: `scripts/qa/glass-interactions-live.cjs`. Local full reports: `.uijourneys/journeys-report.json`, `.uiaudit/audit-report.json`, `.bugloops/beginner-2026-09-09T23-01-33/timings.json`. Final gate logs use `%TEMP%/starnet-glass-final-*.log`.
