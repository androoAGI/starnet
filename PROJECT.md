# Remote uplink proposal

Scope: offer a single-app macOS remote viewer and private Linux runtime to upstream while preserving StarNet's local workflow and UI.

- [x] Compare against the official default branch and isolate the proposal from private deployment history.
- [x] Review connection, credential, runtime, UI and packaging boundaries; add maintainer handoff documentation.
- [x] Complete focused regressions, attempt every contribution-gate step and run native build checks; [record remaining baseline failures and release limits](docs/remote/VALIDATION.md).
- [x] Publish [draft PR #21](https://github.com/androoAGI/starnet/pull/21) against the official default branch.

Implementation contracts and extension points are in [the maintainer guide](docs/remote/MAINTAINER_GUIDE.md). Reproduction and manual acceptance are in [testing](docs/remote/TESTING.md). The draft PR is the review record; it is not a release approval.

## PR #21 integration refresh — 2026-09-20

- [ ] Resolve conflicts against current upstream while retaining remote behavior and upstream fixes.
- [ ] Validate remote, integration, native and contribution gates; record concrete limits.
- [ ] Refresh the source manifest and PR validation notes, then push the contribution branch.
