# Installing StarNet (Desktop)

StarNet's public release train supports **Windows and macOS**:

| Platform | Download this asset |
| --- | --- |
| **Windows** (10/11, 64-bit) | `StarNet_<version>_x64-setup.exe` |
| **macOS — Apple Silicon** (M1/M2/M3/M4) | `StarNet_<version>_aarch64.dmg` |
| **macOS — Intel** | `StarNet_<version>_x64.dmg` |

Linux is not yet a supported public release target. Linux x86_64 and ARM64 packages can be
built from source or obtained as CI artifacts; see [Linux installation and testing](docs/LINUX.md).
The public releases page does not currently contain Linux installers or Linux automatic updates.

Download from the [StarNet releases page](https://github.com/androoAGI/starnet-releases/releases/latest).
Use only an asset attached to the release you intend to install.

## What the public release train guarantees

The tagged public workflow is configured to fail closed unless all of these checks pass:

- The Windows app and installer have valid Authenticode signatures, the expected publisher,
  and a trusted timestamp.
- Both macOS architectures have Developer ID signatures. Their bundled native dependencies
  are signed and timestamped, and the DMGs are accepted and stapled by Apple notarization.
- Every platform updater artifact has a valid updater signature and is included in the one
  Windows/macOS update manifest.

These are **release-pipeline requirements**, not installed proof for a particular download.
This repository does not contain evidence that the asset you downloaded was installed and
launched on your exact OS. If your OS reports an unknown publisher, a missing Developer ID,
or a notarization failure, stop and report the release and asset name rather than bypassing the
warning.

Manual/local and shareable test builds are a different tier. They can be intentionally unsigned
when signing credentials are unavailable and are for internal testing only. Do not infer public
release trust from a successful local build.

## Windows

1. Run `StarNet_<version>_x64-setup.exe`.
2. Confirm Windows identifies the publisher expected by the release notes before approving the
   installer.
3. Complete the installer, then launch StarNet from the Start menu.

An Authenticode signature does not guarantee that SmartScreen is silent. A new certificate can
still have limited reputation. If SmartScreen shows **Windows protected your PC**, inspect the
publisher under **More info** before choosing **Run anyway**. Do not proceed when the publisher is
unknown or different from the release notes.

Windows 11 Smart App Control can apply additional policy even to signed software. Its verdict is
machine policy, not proof that an installation was exercised by this repository's test suite.

To uninstall, use **Settings → Apps → Installed apps**.

## macOS

1. Choose `aarch64.dmg` for Apple Silicon or `x64.dmg` for an Intel Mac. Check **Apple menu →
   About This Mac** if you are unsure.
2. Open the DMG and drag **StarNet** into **Applications**.
3. Launch StarNet from Applications.

The public release train requires a Developer ID signature and a stapled Apple notarization
ticket. A public DMG should therefore pass Gatekeeper normally. Do **not** clear quarantine with
`xattr` or use an unsigned-app override for a purported public release. If macOS says the app is
damaged, from an unidentified developer, or cannot be checked for malicious software, stop and
report the release tag, asset name, Mac architecture, and macOS version.

To uninstall, quit StarNet and drag it from **Applications** to the Trash.

## Run free with a local model

StarNet does not require an API key or a StarNet account. Install [Ollama](https://ollama.com),
pull a model (`ollama pull llama3.1`), and choose **OLLAMA** as the provider — on the first-run
brain screen, or later under **SETTINGS → PROVIDERS**. StarNet reaches Ollama at `127.0.0.1:11434`
and shows it as ready only after it has listed your local models. Local models are smaller than
cloud models: expect slower, rougher results on long tasks.

## Updates

The public release train produces signed updater artifacts for Windows and both Mac
architectures. StarNet's Update Center checks the public manifest and verifies a downloaded
update against the updater public key embedded in the app before installation. Updater signing
is separate from Authenticode, Developer ID signing, and Apple notarization; the public train
requires all applicable layers.

On Windows, current manual installers detect an older StarNet installation and use the same
in-place update mode as Update Center. They do not depend on the older installation's
`uninstall.exe`, and the user's station data remains outside the application directory. If an
older installer still shows an **Already Installed** page, quit StarNet from its tray icon,
choose **Do not uninstall**, and continue. Do not delete `%APPDATA%\ai.skynet.harness` as an
update workaround.

This describes the supported update path. It does not claim that an update was exercised on an
installed copy from this candidate. If the Update Center cannot complete an update, download the
matching current installer/DMG from the releases page and report the failure before relying on
automatic update behavior.

## Support

Report installer, Gatekeeper, SmartScreen, or updater problems to **androo.agi@gmail.com**. Include
the release tag, exact asset name, OS version, CPU architecture, and the complete warning text.
