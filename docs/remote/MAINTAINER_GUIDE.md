# Remote uplink proposal: maintainer and agent guide

## Intent

Let the existing StarNet desktop app act as a viewer for a private, continuously running Linux station. A user chooses **This Computer** or **Remote Uplink** in the same app. Closing the viewer, sleeping the Mac, or losing SSH must not terminate accepted server work. Provider quota and catalog failures must not prevent opening an existing station or repairing its settings.

This is a draft implementation for review, not a request to adopt a specific authentication provider or release schedule. The current macOS client and Linux/systemd installer form one working vertical slice. The transport, sign-in and installer can be replaced independently while preserving the contracts below. Local Windows/Linux desktop paths are retained; remote desktop setup and native execution checks on those platforms are not covered by this macOS proposal.

## Architecture and review map

| Layer | Files | Responsibility |
| --- | --- | --- |
| Native shell | `src-tauri/src/remote_desktop.rs`, `main.rs` | Select local/setup/remote; supervise helper lifetime; isolate native authority; flush before exit; retire startup placeholder |
| Setup | `remote/setup.js`, `connection.js`, `config.js`, `desktop.js` | GitHub device sign-in, strict SSH, connection probe, private atomic configuration, separate origin per station |
| Transport | `remote/gateway.js`, `cli.js` | Loopback listeners, owner sessions, streaming proxy, bounded reconnect, viewer disconnect/reconnect |
| Runtime | `sidecar/remote-runtime.js`, `remote-goals.js`, `index.js` | Runs outlive their transport; durable request claims; headless session commands; explicit goal ownership |
| Provider storage | `sidecar/remote-provider-store.js`, provider routes, `frontend/app/harness.js` | Server-owned keys/endpoints/pools, insert-only migration, no secret readback |
| Viewer reconciliation | `remote-channels.js`, `remote-status.js`, `chat.js`, `cloudsave.js` | SSE/snapshot reconciliation, no duplicate token delivery, drafts and revision conflicts |
| Existing UI integration | `stationui.js`, `onboarding.js`, `dialogue.js`, settings CSS | Stable settings refresh, resumable interview, upstream typography/components/wordmark |
| Optional model adapter | `sidecar/providers/responses-gateway.js`, registry/factory | Responses-compatible model gateway using the existing Codex stream decoder |
| Packaging | `remote/package.mjs`, installers, `scripts/prepare-remote-desktop.mjs`, macOS Tauri config | Checksum-verified helper runtimes, tracked-source server archive, dedicated Linux service |

`website/app/` mirrors `frontend/` through the existing sync script. Change the source and synchronize it; do not design a separate remote UI. Setup imports the actual StarNet styles, font and wordmark through an explicit asset allowlist. The interview panel uses upstream Dialogue markup. Native remote rendering avoids WebKit's canvas readback warp; the remote CRT flicker default is off with the existing Appearance control available.

## Contracts to preserve when changing the implementation

1. **The server owns work.** Remote response closure detaches a viewer. Only explicit cancellation, halt or server shutdown stops work. Local response cancellation keeps its prior semantics. Never replay a run POST automatically after an uncertain network result.
2. **Admission is durable.** Run and goal request IDs are claimed with exclusive creation and fsync before execution. Duplicate IDs return 409. This prevents duplicate admission, not exactly-once external effects. After a process restart, unfinished goals pause for inspection instead of silently replaying tools.
3. **Authority remains separate.** Remote HTML never receives the local desktop's keychain/tool IPC. Only the bundled `main` origin may invoke native commands. The setup page has its own origin and CSRF token. A remote page can request that setup be opened, but cannot execute its SSH/admin actions.
4. **Network services stay private.** Gateway/runtime/client listeners bind to loopback. SSH verifies the server host key and supplies encryption. GitHub `/user` authenticates the configured numeric owner, not a mutable login name. The server sees the GitHub credential transiently and must be trusted with it; the gateway does not store it.
5. **Credentials survive independently of validity.** Opening a station reads saved configuration, not provider health. Keys are never returned to the viewer. File storage is private, atomic and durable, but is not an encrypted keychain. Migrations cannot overwrite newer records or removed-key tombstones. Failed writes cannot claim success or delete the last browser copy.
6. **Reconnect preserves user intent.** Restore live activity from SSE and snapshots. Retain unsent drafts, in-progress settings editors, focus, scroll and save revisions. Refreshing a view must not start queued work or an autonomous goal. Each server/account/SSH-port/gateway-port identity receives a distinct saved browser origin.
7. **Installation is explicit.** Connection probing performs no inference. New-server installation runs visibly in Terminal, including host-key verification and sudo. An active service is never overwritten by the installer. Code releases and station data stay in separate directories.
8. **Bound resource use.** Session limits, timeouts, response limits, viewer backpressure and reconnect backoff are deliberate. The first-byte provider watchdog is distinct from the longer idle timeout after streaming begins. The Linux unit's limits are deployment defaults, not capacity guarantees.

## Adapting this proposal with your own agent

Start from the PR branch and read this guide, `SETUP.md`, `OPERATIONS.md`, the test manifests and the existing `CONTRIBUTING.md`. Keep changes focused on one boundary at a time. The code is organized so a maintainer can adopt the complete implementation or retain its runtime/transport contracts with a different UX.

- **Different sign-in:** replace `githubIdentity` and the desktop credential acquisition/device flow together. Keep immutable owner identity, session expiry, no credential logging, and strict SSH. Do not turn a login handle into authorization.
- **Different transport:** keep the streaming behavior and runtime token boundary. If adding public HTTPS or multi-user tenancy, design authorization, cookie/CSRF policy, TLS and per-user storage separately. The loopback owner-only gateway is not a public multi-tenant service.
- **Different installer:** replace packaging/systemd without coupling data to the application directory. Preserve idle upgrade, backup, rollback and ownership checks. Supply explicit dependencies for browser/PTY/voice tools rather than promising them from the minimal headless package.
- **Different desktop flow:** reuse StarNet's actual components and local window factory. Keep setup, local and remote origins distinct, including per-station storage. Exercise both local-to-remote and remote-to-local transitions and the startup-window retirement.
- **Different model gateway:** the optional `gateway` profile is separate from the SSH station gateway. It consumes an authenticated `/models` catalog and `/responses`, reusing the established decoder. It assumes tool-capable Responses models unless a catalog row explicitly opts out. Unknown pricing is not free usage. The experimental `levserver` provider ID/environment names remain compatibility aliases; canonical gateway records, including removed keys, win over legacy data. Remove this profile independently if custom model gateway support is out of scope.

For each change, run the affected remote tests and retained upstream regressions first, then the contribution gates. Preserve existing tests unless a contract intentionally changes, and explain that change in the PR. Do not weaken origin, permission, cancellation, admission or persistence checks to make a test pass. Use temporary workspaces and mocked providers; never load production credentials or create paid tasks as test fixtures.

## Validation and release boundaries

See `TESTING.md` for reproducible commands and attended acceptance. The [validation record](VALIDATION.md) and draft PR description record the actual results for this proposal revision. A local build is not public distribution approval. Developer ID signing, notarization, both Linux architecture installation checks, resource sizing, and maintainer release policy remain release decisions. No assertion of production certification or complete cross-platform coverage is implied.
