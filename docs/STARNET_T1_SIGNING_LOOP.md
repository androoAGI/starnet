# StarNet T1 Signing Lead-Time Loop

T1 is the signing lead-time lane for beta distribution. It does not decide whether the
harness can replace the reference harness; P5 already does that. T1 decides whether the current desktop
build can be trusted as an installer/update artifact for the intended audience.

## Goal

Keep signing procurement moving without blocking an invited beta on work that only becomes
mandatory for a public release.

## Loop

Run:

```powershell
npm.cmd run t1:signing
```

Use this for the invited beta lane. It records artifact hashes, Authenticode state, Tauri
updater signature state, and certificate procurement status. Unsigned artifacts are an
accepted deferral only for invited beta.

Run:

```powershell
npm.cmd run t1:signing:public
```

Use this for the public release lane. It exits non-zero until Windows app and installer
Authenticode signatures are valid and updater signature artifacts exist.

## Required States

| Audience | Authenticode | Updater .sig | Procurement |
|---|---|---|---|
| Invited beta | May be unsigned with explicit accepted deferral | May be absent with explicit accepted deferral | May be not-started, but the next action is recorded |
| Public release | Must be valid | Must exist | Must be started or already evidenced by valid signatures |

## Certificate Track

Choose OV or EV Authenticode based on launch model:

- OV is suitable for controlled beta and normal product distribution, but SmartScreen
  reputation may need to build over time.
- EV is more expensive and operationally heavier, but is the faster path when a public
  download must avoid a cold SmartScreen trust wall.

Set this environment variable as the procurement lane advances:

```powershell
$env:STARNET_AUTHENTICODE_CERT_STATUS = "started"
```

Allowed values are `started`, `ordered`, `validation`, `issued`, and `available`.

## Tauri Updater Signing

The updater public key is embedded in `src-tauri/tauri.conf.json`. Public update delivery
requires a generated installer `.sig` artifact for the current installer build, produced by
building with:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\starnet-updater.key"
npm.cmd run desktop:build
```

If the installer is rebuilt, the `.sig` must be regenerated too. The signing gate treats a
signature older than its installer as stale and blocks public release.

Do not commit the private key. Keep it in a password manager or release vault.

## Done Conditions

T1 is done for invited beta when `t1:signing` exits 0 and the summary says
`invitedBetaReady=true`. That does not mean public signing work is finished; check
`leadTimeStarted` and `nextAction` in the status file. If `leadTimeStarted=false`, the
next T1 action is to start OV/EV Authenticode procurement.

T1 is done for public release only when `t1:signing:public` exits 0 and the summary says
`publicReleaseReady=true`.
