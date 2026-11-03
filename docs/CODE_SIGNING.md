# Code signing — Windows (Azure Trusted Signing) + macOS (Apple notarization)

Why this exists: unsigned installers hit the Windows SmartScreen "unrecognized app /
potential virus" wall and the macOS Gatekeeper block. Signing + notarization is what
turns "sketchy download" into "opens cleanly". Both CI workflows (desktop-build.yml,
release-train.yml) are wired. Manual `desktop-build` runs sign when credentials are
available and may degrade to unsigned internal-test artifacts. The tagged public
`release-train` fails closed if either platform's production credentials or trust proof
is missing.

## Windows — Azure Trusted Signing ("Artifact Signing")

### What already exists (created 2026-07-21 via az CLI)

| Thing | Value |
| --- | --- |
| Azure subscription | `Azure subscription 1` (`685b8c19-f09a-4264-ba08-a8127cd31e4d`), upgraded from free tier to pay-as-you-go (Artifact Signing refuses free/trial subs) |
| Tenant | `bb673ff6-ccab-4628-9b90-c8a874c20d65` (androosbotoutlook.onmicrosoft.com) |
| Resource group | `starnet-signing-rg` (eastus) |
| Signing account | `starnet-signing`, SKU Basic ($9.99/mo, 5k signatures/mo), endpoint `https://eus.codesigning.azure.net/` |
| Role granted | `Artifact Signing Identity Verifier` → Andrew's user (needed to run identity validation) |
| Identity validation | **Individual / Public**, "Andrew Sims" — COMPLETED 2026-07-21, id `b19a2faa-4463-4564-8de0-344ecbe00ebe`. (First attempt failed: submitted as *Organization* — no registered business to verify. Individual resubmit passed same day. An inert failed Organization row remains; safe to delete.) |
| Certificate profile | `starnet-public` (PublicTrust) — provisioned Succeeded 2026-07-21. Name is load-bearing: CI's signCommand references it. |
| Service principal | `starnet-ci-signer` (appId `2a51e476-1196-49e4-8ee9-8f31a57045f2`) with role `Artifact Signing Certificate Profile Signer` scoped to the account. Credentials at `%USERPROFILE%\.starnet-signing\azure-ci-signer.json` (delete after first signed build verifies). |

### Live status (verified 2026-07-31)

- The three `AZURE_*` Actions secrets are installed in `androoAGI/starnet`.
- Non-publishing `desktop-build` run `30606849654` authenticated as the signing service
  principal and used account `starnet-signing`, public-trust profile `starnet-public`.
- Azure successfully signed `skynet-desktop.exe`, the NSIS components, and
  `StarNet_0.7.0_x64-setup.exe` with zero signing errors.
- The downloaded CI installer passed the native Windows check:
  `Get-AuthenticodeSignature` returned `Valid` / `Signature verified`, publisher
  `Andrew Sims`, a Microsoft verified code-signing issuer, and a Microsoft timestamp.
- The checksum-verified Node runtime that is bundled by `externalBin` independently
  returns `Valid`, publisher `OpenJS Foundation`, with a DigiCert timestamp. Preserve
  that upstream signature rather than replacing it.

### How CI signs (already wired — no action)

With the AZURE_* secrets present, the Windows leg installs `trusted-signing-cli` and
injects `bundle.windows.signCommand` via `--config`. Tauri signs the app executable,
NSIS components, and final installer. The bundled Node sidecar keeps its upstream
OpenJS signature. `tauri.conf.json` stays untouched so local builds never reach for
Azure.

The tagged public train requires all three Azure credentials before compiling, then
uses `Get-AuthenticodeSignature` to require a valid timestamped signature on the app,
installer, and bundled Node runtime. Any missing credential, wrong publisher, unsigned
file, invalid chain, or missing timestamp stops the release before staging.

### Reputation reality check

Signing removes the unknown-publisher condition and reduces malware heuristics, but
SmartScreen reputation still accrues over real downloads. Azure's short-lived
certificates rotate automatically; reputation follows the verified publisher identity.
Early releases can still receive a reputation warning even when the signature is fully
valid, so record clean-machine results rather than promising instant SmartScreen silence.

## macOS — Apple Developer ID + notarization

The paid Apple Developer Program is active. StarNet is distributed directly as a DMG,
not through the Mac App Store, so the required identity is **Developer ID Application**
(not Apple Distribution, Mac App Distribution, or Developer ID Installer).

### One-time operator setup

Do this on a Mac. The private key created with the certificate signing request must stay
with the certificate when it is exported.

1. In **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority**, create a CSR and select **Saved to disk**.
2. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list),
   add a certificate, choose **Developer ID Application**, upload the CSR, and download
   the resulting `.cer`.
3. Open the `.cer` so it joins its private key in the login keychain. Under **My
   Certificates**, expand the new `Developer ID Application: …` row and confirm a private
   key appears beneath it. If there is no private key, do not continue—the `.p12` would be
   unusable.
4. Export that certificate **and its private key** as a `.p12`. Give the export a strong,
   unique password; this becomes `APPLE_CERTIFICATE_PASSWORD`.
5. Record the exact identity:

   ```sh
   security find-identity -v -p codesigning
   ```

   Copy the full `Developer ID Application: Name (TEAMID)` string as
   `APPLE_SIGNING_IDENTITY`.
6. Find the 10-character Team ID on the Apple Developer membership page. This becomes
   `APPLE_TEAM_ID`.
7. At [account.apple.com](https://account.apple.com/), create an app-specific password
   dedicated to `StarNet notarization`. This—not the normal Apple Account password—is
   `APPLE_PASSWORD`. The Apple Account email is `APPLE_ID`.
8. Convert the `.p12` to one unwrapped base64 line:

   ```sh
   openssl base64 -A -in StarNet-Developer-ID.p12 -out StarNet-Developer-ID.base64.txt
   ```

   The contents of that text file become `APPLE_CERTIFICATE`.

### GitHub Actions secrets

In `androoAGI/starnet` go to **Settings → Secrets and variables → Actions** and create
all six repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Entire one-line base64 `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | Exact `Developer ID Application: Name (TEAMID)` identity |
| `APPLE_ID` | Apple Account email |
| `APPLE_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

Never commit the CSR private key, `.p12`, base64 export, passwords, or GitHub secret
values. Keep an encrypted backup of the `.p12` and its password outside the repository;
losing them prevents signing the next release with the same identity.

### First proof

1. Run the manual `desktop-build` workflow with `publish-test=false`. Both Mac legs
   should sign locally, upload a `notarization-input-*` artifact, and then enter the
   independent `notarize-macos` finalization jobs.
2. On the first tagged release train, the Mac legs must show all of these:
   `Authority=Developer ID Application`, hardened runtime, Node `allow-jit`,
   `DMG notarized + stapled`, `DMG notarized proof passed`, and
   `source=Notarized Developer ID`. The Intel installed acceptance must also show a
   `page-boot: passed` line for each Finder launch, `installed app: verified N files`, and
   `a copy of the app with an empty sidecar/tools/builtin/shell.js: its headless verify exits 3 naming it`
   (`scripts/verify-macos-installed-integrity.sh`); the Windows published-upgrade proof shows the
   same verify and zeroed module for each upgraded install.
3. Download each staged DMG on a clean Intel and Apple Silicon Mac. Drag StarNet to
   Applications and launch it normally while online, then repeat offline. There must be
   no “damaged,” unidentified developer, or Open Anyway path.
4. Only after that live proof, remove the temporary unsigned-build instructions from
   README.md, DOWNLOAD_PAGE.md, INSTALL.md/release notes, and launch checklists.

The tagged public release train now fails closed if any Apple secret is absent or if
Gatekeeper does not return the notarized Developer ID verdict. Manual test builds can
still be unsigned so contributor CI remains usable.

### Long Apple queues and safe retries

Do not put Apple account credentials in Tauri's build step. Tauri then invokes
`notarytool --wait` inside the build, and an unusually long Apple queue can consume
GitHub's six-hour job limit before the signed DMG is uploaded anywhere.

Both release workflows instead use a resumable sequence:

1. Tauri builds and Developer-ID-signs the DMG without receiving `APPLE_ID`,
   `APPLE_PASSWORD`, or `APPLE_TEAM_ID`.
2. `scripts/notarize-macos-submit.sh` submits that exact DMG without `--wait` and saves
   Apple's submission ID beside it.
3. Actions uploads the DMG plus ID as `notarization-input-<arch>` before polling.
4. A separate `notarize-macos` job resumes the saved ID, tolerates transient network
   failures, staples the accepted ticket, validates it, and requires Gatekeeper to report
   `source=Notarized Developer ID` for the DMG itself and for the app inside it.

The DMG's own signature is proven twice by `scripts/verify-macos-dmg.sh`: in the build
job before submission (`signed`: strict `codesign --verify`, Developer ID authority from
the app's team) and in the finalizer after stapling (`notarized`: the same, plus
`xcrun stapler validate` and `spctl -a -t open --context context:primary-signature`).
Checking only the app missed a v0.13.5 aarch64 DMG that a user's Mac reported as
"invalid signature (code or signature have been modified)". Any failure stops the train
before a draft is staged.
5. Only that finalized job publishes the `starnet-<arch>` artifact consumed downstream.

If Apple is still processing after 330 minutes, the finalizer exits retryably before
GitHub cancels it. Re-run that failed finalization job; do not rebuild or resubmit. This
also keeps one slow architecture from destroying the other architecture's signed bytes.

The first live proof run, `30606849654`, established that the certificate imports and
Developer ID signing succeeds on both architectures. Its notarization attempts remained
in Apple's queue for hours: three runners later lost their network route while polling,
and one reached GitHub's six-hour limit. None contained an Apple rejection. That run is
diagnostic evidence for the resumable workflow, not a completed notarization proof.

## Per-release hygiene (until reputation is established)

- Upload the setup exe to VirusTotal before publishing; note which engines flag it.
- Submit each release to Microsoft's false-positive portal
  (https://www.microsoft.com/en-us/wdsi/filesubmission, "software developer" path) —
  typically cleared in 1–3 days and feeds Defender globally.
- Keep filenames, publisher name, and download host stable across releases.
