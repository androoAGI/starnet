# Remote uplink proposal

Scope: offer a single-app macOS remote viewer and private Linux runtime to upstream while preserving StarNet's local workflow and UI.

- [x] Compare against the official default branch and isolate the proposal from private deployment history.
- [x] Review connection, credential, runtime, UI and packaging boundaries; add maintainer handoff documentation.
- [x] Complete focused regressions, attempt every contribution-gate step and run native build checks; [record remaining baseline failures and release limits](docs/remote/VALIDATION.md).
- [x] Publish [PR #21](https://github.com/androoAGI/starnet/pull/21) against the official default branch.

Implementation contracts and extension points are in [the maintainer guide](docs/remote/MAINTAINER_GUIDE.md). Reproduction and manual acceptance are in [testing](docs/remote/TESTING.md). The PR is the review record; it is not a release approval.

## PR #21 integration refresh — 2026-09-20

- [x] Resolve all conflicts against upstream `f00aa04df`, retaining both branches' behavior and test entries.
- [x] Validate focused remote/regression suites, native tests, macOS packaging, all contribution-gate entries and a clean Linux x86_64 installation with restart persistence.
- [x] Refresh the source manifest and prepare the updated contribution branch and PR validation notes.

851/852 fast entries and 131/132 HTTP entries exited successfully. The canvas comparison and five shell assertions reproduce on unchanged upstream; the full gates remain non-green. The previous CRT/browser failures pass on this candidate. See [current validation](docs/remote/VALIDATION.md) for exact results.

Remaining maintainer/release work: disposition of the two upstream gate failures, attended macOS acceptance, Linux arm64 and Windows-native acceptance, resource sizing and public distribution. These are outside the conflict-resolution refresh. The existing station and installed app were not replaced; the disposable Linux test environment was removed.
