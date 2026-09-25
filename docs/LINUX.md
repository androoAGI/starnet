# Linux desktop builds

StarNet can be built natively for Linux **x86_64** and **ARM64** (including DGX Spark).
The Linux configuration produces `.deb` and AppImage packages with a bundled Node runtime;
users of a packaged build do not need Node or Rust installed. Other architectures and musl
distributions such as Alpine are not covered.

Linux packages are source/CI builds. The tagged public release train still ships Windows and
macOS only; do not expect Linux downloads on its releases page or automatic Linux updates.
The `linux-desktop` workflow builds and exercises both architectures on pull requests and can
be run manually. Its package artifacts are uploaded only after the smoke checks pass.

## Build on Ubuntu

Use Node.js 22, Rust stable (installed with [rustup](https://rustup.rs)), and a native machine
matching the desired package architecture. On Ubuntu 22.04/24.04:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev patchelf
npm ci
npm run desktop:dev
# Or build installers, using the committed Rust dependency lockfile:
npm run desktop:build -- -- --locked
```

The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) describe dependencies for
other distributions. Build on the oldest distribution you intend to support: packages built
on Ubuntu 24.04 can require newer glibc/system libraries than Ubuntu 22.04 provides.
The CI baseline is Ubuntu 22.04 for x86_64 and Ubuntu 24.04 for ARM64.

The build selects the host architecture automatically. `desktop:prepare` downloads and
checksum-verifies the matching Node runtime. Merely passing another target to `prepare-node`
does **not** cross-compile the Rust shell or install matching native npm dependencies.

Linux desktop preparation uses `patchelf` to give the two bundled ONNX runtimes distinct
library names, preventing ASR and TTS from loading each other's incompatible ABI. Staging
changes only the copied dependencies; `desktop:dev` prepares the local `node_modules` copy.
If running the sidecar directly with offline voice, first run `node scripts/prepare-linux-native.mjs`
after `npm ci`. Reinstalling dependencies restores their original upstream bytes.

## Install and launch

Packages are written under `src-tauri/target/release/bundle/`:

| CPU | Debian package | AppImage |
| --- | --- | --- |
| x86_64 | `StarNet_<version>_amd64.deb` | `StarNet_<version>_amd64.AppImage` |
| ARM64 | `StarNet_<version>_arm64.deb` | `StarNet_<version>_aarch64.AppImage` |

For Debian/Ubuntu, install the matching package with `sudo apt install ./StarNet_<version>_<arch>.deb`.
When testing a rebuilt package with the same version, add `--reinstall` so APT replaces the installed bytes.
Launch **StarNet** from your application menu or run `skynet-desktop` as your normal user.
The bundled runtime is `/usr/bin/starnet-node`; it does not replace `/usr/bin/node`.
Remove the package with `sudo apt remove star-net`.

For AppImage, run `chmod +x StarNet_<version>_<arch>.AppImage`, then execute that file.
If FUSE is unavailable, extract with `./StarNet_<version>_<arch>.AppImage --appimage-extract`
and run `./squashfs-root/AppRun`. Keep the entire extracted directory together.
AppImage users need `xdg-utils` for external links and `zenity` for the folder picker.

Use a graphical desktop session with an unlocked Secret Service keyring (for example GNOME
Keyring or a compatible KDE service) for persistent credentials. A locked keyring can prompt
for unlock; headless sessions must supply their own Secret Service session. Do not run the
app with `sudo`. A desktop supporting AppIndicator provides the tray menu; on GNOME this may
require the AppIndicator extension. Leave close-to-tray/start-minimized off if no tray is visible.

Station data lives in `$XDG_DATA_HOME/ai.skynet.harness` (normally
`~/.local/share/ai.skynet.harness`), outside the package. Install a newer `.deb` or replace the
AppImage to update; preserve this data directory. `startup.log` there records startup failures.

## Features and limits

Agent chat, tools, browser automation, and local model endpoints use the shared sidecar.
Native Windows computer control and Windows system speech are not Linux features. Offline
voice uses the packaged CPU runtime; a DGX Spark GPU does not automatically accelerate it.
An independently configured Ollama or OpenAI-compatible local server can use the GPU and
be connected through StarNet's provider settings.

X11 packaged startup and lifecycle are covered by the automated smoke. Wayland, microphone
capture, tray integration across desktop environments, and full offline voice inference need
separate interactive verification; a passing package build does not prove them.

## Reproduce packaged checks

Install the `.deb` first, then install the smoke dependencies:

```bash
sudo apt-get install -y dbus-x11 xvfb openbox xdotool wmctrl gnome-keyring
xvfb-run -a -s '-screen 0 1440x1000x24' dbus-run-session -- sh -c '
  openbox >/tmp/starnet-openbox.log 2>&1 &
  node scripts/verify-linux-desktop.mjs /usr/bin/skynet-desktop
'
```

For an extracted AppImage, pass the absolute path to `squashfs-root/AppRun` instead.
The script uses a disposable XDG profile and keyring, checks WebKit document load, a visible
window, sidecar health, the bundled Node/native dependency closure, shell timeouts, graceful close, shell-crash
cleanup, and relaunch with preserved data. It deliberately skips legacy station migration.
It uses a tiny ONNX test graph; no model downloads or provider credentials are required. Run `npm run test:fast`,
`npm run test:http`, and `cargo test --manifest-path src-tauri/Cargo.toml --locked` for regressions.
