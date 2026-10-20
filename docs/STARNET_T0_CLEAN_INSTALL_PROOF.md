# StarNet T0 Clean-Machine Install Proof

T0 exists to answer one beta-critical question before T2 release smoke: can a fresh user install and launch the current StarNet build without anything from the developer machine?

## Done Condition

T0 is complete only when `.dogfood/t0-clean-install-latest/t0-clean-install-status.json` reports `cleanInstallProofReady=true`.

That requires:

- The current NSIS installer exists and its installer hash is recorded.
- A real clean-machine run supplies evidence with `schema=starnet.clean-install-proof.v1`.
- The evidence declares `cleanMachine=true`; this must be Windows Sandbox, a clean VM, or a physical clean Windows install.
- The evidence installer hash matches the current NSIS installer hash.
- The evidence records install success.
- The evidence records first launch success.
- The evidence records the install location, launched executable, and sidecar workspace root.
- The sidecar workspace root must live under Windows AppData, never under the installation directory.
- The install/executable/workspace paths must not point at a StarNet T3/T4 smoke-test install.

A not a dev-box run does not count. A reinstall on the development checkout, a second local Windows user, or a cleared AppData profile can be useful smoke, but it is not T0 proof.

## Loop

Run:

```powershell
npm.cmd run t0:clean-install:loop
```

The loop records evidence in `.dogfood/t0-clean-install-<stamp>` and copies the latest run to `.dogfood/t0-clean-install-latest`.

If no clean Windows surface is available locally, the loop must stay blocked. That is the intended behavior; it protects T2 from being built on fake certainty.

## Importing Proof

After running the current installer on a clean machine, create a JSON file with this shape and import it:

```json
{
  "schema": "starnet.clean-install-proof.v1",
  "generatedAt": "2026-06-27T00:00:00.000Z",
  "sourceMachine": {
    "os": "Windows 11 Pro",
    "build": "26200"
  },
  "machineKind": "windows-sandbox",
  "cleanMachine": true,
  "installer": {
    "sha256": "<current installer SHA-256>",
    "bytes": 34826840
  },
  "install": {
    "succeeded": true,
    "method": "manual",
    "installLocation": "C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\Programs\\StarNet"
  },
  "launch": {
    "succeeded": true,
    "observedWindowTitle": "StarNet",
    "exePath": "C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\Programs\\StarNet\\skynet-desktop.exe",
    "startupRoot": "C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\Programs\\StarNet",
    "workspaceRoot": "C:\\Users\\WDAGUtilityAccount\\AppData\\Roaming\\ai.skynet.harness\\workspaces"
  },
  "notes": []
}
```

Then run:

```powershell
$env:STARNET_T0_CLEAN_EVIDENCE = "C:\path\to\clean-install-proof.json"
npm.cmd run t0:clean-install
```

The gate will fail, not block, if the imported proof is malformed or points at a different installer hash.
