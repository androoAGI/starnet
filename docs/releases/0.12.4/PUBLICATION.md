# StarNet v0.12.4 publication

Published stable/latest on 2026-09-20 at 10:57:08 UTC after the owner's explicit instruction to publish. [Download the release](https://github.com/androoAGI/starnet-releases/releases/tag/v0.12.4).

The immutable tag and binary source are `f00aa04dfceac4e0d1a3a1e95b7b8d24d55456d1`, fast-forward merged into `feat/harness-backend`. Later evidence/documentation commits are not binary source. Earlier audit and native-candidate reports retain their historical scope; their unpublished status does not describe this final release.

## Final gates

- Final-source Guardian cycle `20260920-085035`: all seven gates passed, including 841 fast steps and 129 HTTP checks; beginner journeys passed 6/6. The default trunk-bound readiness receipt returned `ready: true`, no reasons.
- [Release train 35503655947](https://github.com/androoAGI/starnet/actions/runs/35503655947): passed gate, signed Windows build, both Mac builds and notarizations, Intel installed acceptance, assembly and draft staging.
- [Exact draft clean installation 35505964904](https://github.com/androoAGI/starnet/actions/runs/35505964904): passed clean-machine installation and live shell launch. Installer digest matches the published asset.
- [Exact draft lifecycle 35505966180](https://github.com/androoAGI/starnet/actions/runs/35505966180): all three cases passed (idle close, close to tray, updater smoke).
- Live `node scripts/verify-update-host.mjs --expect-version 0.12.4`: passed after publication. Manifest and all three platform assets returned HTTP 200; version, pinned URLs and nonempty signatures passed.
- [Public automatic-update canary 35506471983](https://github.com/androoAGI/starnet/actions/runs/35506471983): passed all ten continuity checks against the exact published installer and final source. The real public v0.12.3 app discovered the update, installed it, restarted automatically, preserved populated state through installation and another restart, passed installed smoke, and reported no further update pending. The companion lifecycle job also passed.
- [Source release mirror 35506666513](https://github.com/androoAGI/starnet/actions/runs/35506666513): passed. The [source release page](https://github.com/androoAGI/starnet/releases/tag/v0.12.4) became public at 11:05:19 UTC; all three human installers match the distribution asset SHA-256 digests and sizes.

## Published asset identity

Nine assets were reviewed before publication, including paired updater signatures and one coherent manifest for Windows x64, Intel Mac and Apple Silicon. The Windows installer is 640,477,760 bytes, SHA-256 `ca0bb0d790c0cef03b4663a38086c136e28c5d58eb57043d4a28097a2dd9adf2`. Manifest SHA-256 is `8d9e464bddd445cb7292d027fd6edbb21f7d1605882a83672c64ab180d5cfd9f`. Full public asset identities and final receipts are retained in `qa/evidence/release-audit-0124-publication/`.

The user's PC was previously upgraded to signed v0.12.4 candidate `f27e70f7`, with a hash-verified local backup. Its application implementation is unchanged in the final release; its installer identity differs. Publication did not interrupt the user's running app or replace that installation again.

## Coverage limits

Real-account authentication, token expiry/re-authentication, billing, selected-Google-file consent/readback and a complete 48-hour installed soak were not performed. Synthetic provider credentials do not establish real-account coverage. The owner explicitly accepted proceeding without a retest on the historically affected Mac; the incident is recorded as accepted residual risk, not verified fixed. Intel Mac installed launch/restart and both architectures' notarization/keychain checks passed, but this is not an exhaustive native UI sweep on both Mac architectures. See [NATIVE_RESULTS.md](NATIVE_RESULTS.md) for detailed scope and earlier retained failures.

The final pre-tag Windows acceptance had one supplementary browser CDP launch timeout on attempt 1; attempt 2 passed against unchanged source and artifacts. The original failed attempt remains retained. No test thresholds were relaxed to obtain publication approval.
