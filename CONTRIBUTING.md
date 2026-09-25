# Contributing to StarNet

Thanks for helping improve StarNet. Bug fixes, tests, documentation, accessibility work, and
carefully scoped features are welcome.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- For a substantial feature or architecture change, open an issue first so the scope and safety
  model can be agreed before implementation.
- Report security vulnerabilities privately using [SECURITY.md](SECURITY.md), never in a public
  issue.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Node.js 22 is recommended because it matches CI and the release train.

```bash
git clone https://github.com/androoAGI/starnet.git
cd starnet
npm ci
npm run test:fast
```

After installing dependencies, start the Node sidecar with `node sidecar/index.js`.
For a dedicated Linux service account, see [Private Linux server](docs/LINUX_SERVER.md).
Desktop development additionally requires Rust and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Pull-request workflow

1. Fork the repository and create a focused branch from the current default branch.
2. Keep the change narrow; do not mix unrelated formatting or generated artifacts into it.
3. Add or update tests for behavior changes.
4. Run `npm run test:fast`. Run `npm run test:http` when changing routes, streaming, persistence,
   providers, tools, schedules, channels, or other sidecar integration paths.
5. Use a clear Conventional Commit-style title such as `fix(sidecar): reject stale consent`.
6. Explain what changed, why it is safe, and how you verified it in the pull request.

Do not commit credentials, local workspaces, QA captures, installers, or generated release
artifacts. Run `npm run security:secrets` before submitting if you have Gitleaks installed.

## Project laws

- Only claim behavior that was verified in the live app.
- The interface must never assert state the harness cannot prove.
- Permission escalation defaults to deny and destructive actions require explicit consent.
- `shared/events.js` and `shared/schema.js` are additive contracts: do not rename or remove existing
  events or fields without an approved migration.
- Keep secrets in the sidecar or native credential store; never send them to the renderer or logs.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `frontend/` | Station UI and renderer. |
| `sidecar/` | Agent runtime and local authority. |
| `shared/` | Cross-boundary schemas and events. |
| `src-tauri/` | Desktop shell. |
| `test/` | Test gates. |
| `qa/` | Live verification and release receipts. |

Maintainers and automated coding agents working in the shared local integration environment
follow an internal worktree protocol (local tooling, not part of this repository); external
contributors can use a normal fork-and-pull-request workflow.
