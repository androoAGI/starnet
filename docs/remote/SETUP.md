# Connect a remote StarNet station

StarNet is one desktop app. **This Computer** uses the original local runtime, onboarding and keychain. **Remote Uplink** connects another computer or a private gateway. In remote mode, that computer owns your agent, provider keys, files and running work; closing the Mac app leaves the server running. The connection chooser currently ships on macOS; other desktop platforms retain their original local behavior.

## Desktop setup

Open **Station → Connection Setup…** (Command-K). A fresh installation opens this screen automatically. An unavailable saved connection returns to it after a bounded startup attempt instead of waiting forever.

1. Choose **This Computer** to open the original local station, or **Remote Uplink** for another computer. Remote setup defaults to **New Server** on a fresh installation; a saved connection selects **Already Installed** and retains its address.
2. Sign in with GitHub. Complete the device-code flow in your browser. The gateway accepts only its configured GitHub owner; the app does not ask you to find a numeric account ID.
3. Enter an SSH alias or `user@hostname`. Existing SSH configuration and keys work. Connection options allow an SSH port override and an existing gateway's port.
4. Use **Set up SSH access in Terminal** if this is your first connection. Verify the fingerprint against your server provider/administrator. Add your public key to the server or unlock it in your SSH agent as needed. Automatic connections use key authentication and strict host-key checking; a changed fingerprint is never silently accepted.
5. Choose **Test & save connection**. The first successful setup opens the station automatically; for an existing connection, use **Open your station**. The test checks SSH, GitHub ownership, runtime health, the state snapshot and the live event stream. It does not run an agent or spend model credits.

Failed and cancelled checks leave the saved connection unchanged. Settings persist outside the application bundle, so rebuilding does not reset them. Each server/account combination receives a separate browser origin; returning to a previous connection reuses its origin. Existing installations retain port 8790. Local station storage is kept separate. New origins start at port 30000. The setup helper uses loopback port 18790 on a separate origin with strict Host/Origin and CSRF checks.

GitHub CLI handles sign-in storage on the Mac. The token is sent through authenticated SSH to verify ownership, then discarded by the gateway. Provider credentials stay in the server's private provider store. Do not paste provider tokens into the SSH form.

## A new server

Use a Linux x86_64 or arm64 machine with systemd, SSH, a working network connection and root/sudo access. The package bundles Node and the locked runtime dependencies; Node/npm installation on the server is not required. Normal work needs no display or GPU. See [operations](OPERATIONS.md) for limits and optional tool dependencies.

Choose **Open server installer in Terminal**. The viewer transfers its bundled, reviewed server archive over SSH, extracts it in a private temporary directory and invokes the installer with your signed-in GitHub owner ID. Terminal shows progress and asks for sudo when necessary. Closing the setup screen does not cancel a Terminal installer already launched.

The installer creates a `starnet` service account, immutable releases under `/opt/starnet`, private data under `/var/lib/starnet`, and `starnet-remote.service`. Gateway port 18791 and runtime port 18792 bind only to server loopback. Do not expose either through a public firewall. The installer refuses to replace a running service. Existing-station upgrades use the explicit idle/backup procedure in [operations](OPERATIONS.md).

When Terminal reports success, return to the viewer and test the connection. Configure model providers inside the station. An empty machine gets normal StarNet character onboarding; an existing station resumes its stored character and progress.

## Build and distribute a candidate

From a reviewed checkout on the target Mac architecture:

```sh
bash remote/install-mac.sh
```

The build includes pinned Node and GitHub CLI binaries verified against their official release checksums, their license notices, and a server archive containing only Git-tracked runtime sources plus locked dependencies. It includes both supported Linux architectures. Build tools (Node/npm, Rust, Xcode command-line tools, tar and unzip) are needed only on the packaging Mac. Fresh users do not need Homebrew, Node or GitHub CLI installed separately.

`Contents/Resources/REMOTE-BUILD.json` records the runtime versions, architecture and server archive checksum. `SOURCE_REVISION` records the reviewed source revision. `remote/package.mjs` stages reproducible inputs under `work/remote-package/`; it refuses bundled workspace state. Stage new source files before a candidate build; release builds should use a clean committed checkout.

The current script makes an ad-hoc signed developer candidate. Public distribution still requires the maintainer's Developer ID signing/notarization and release upload. No public download is claimed to exist before that release is published. Setup uses the station’s actual component styles, local VT323 font and ASCII wordmark. These assets are copied byte-for-byte from `frontend/`; `setup.css` only arranges the connection fields. The original Tauri shell hosts separate local, setup and remote windows. Only its bundled local window can call native commands; remote HTML has no local keychain or tool authority. No second desktop app is installed. The installer preserves previous app bundles under `work/mac-build/replaced-apps/`.

## Design reference

[Hermes Desktop's official guide](https://hermes-agent.nousresearch.com/docs/user-guide/desktop) distinguishes local setup from an existing remote backend, preserves existing configuration and validates remote connectivity. StarNet follows those interaction principles with its own GitHub-owner authentication, pinned SSH transport and SSE runtime. It does not import Hermes code or add a cloud-account dependency.
