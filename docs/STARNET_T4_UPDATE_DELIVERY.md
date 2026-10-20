# StarNet T4 Update Delivery Hardening

T4 answers the beta-critical question left open by T0 through T3:

> Can a user who already has StarNet installed update or reinstall over that install and keep working without losing protected harness state?

For invited beta, manual reinstall over an existing install is acceptable if the state-safety proof is strong. Public signed auto-update delivery is a later public-launch gate.

## Done Condition

T4 is complete only when `.dogfood/t4-update-delivery-latest/t4-update-delivery-status.json` reports `updateDeliveryReady=true`.

That requires:

- The T4 loop spec exists and says manual reinstall/update is the invited-beta target.
- A realistic existing-state fixture is generated with save, notebook, todo, channel, ledger, run, transcript, and update-settings data.
- The current NSIS installer is discoverable and its hash and byte size are recorded.
- A reinstall/update-over-existing-state proof is imported with `schema=starnet.t4-update-delivery-proof.v1`.
- The imported proof references the current installer hash and byte size.
- The imported proof says the existing app launched before the update and the installed app launched after the update.
- The imported proof includes before/after hashes for the protected state buckets and proves they match.
- The rollback path is covered by backup-before-migrate and failure-preserves-original evidence.
- The installed app completes a post-update harness workload before timeout.
- If live proof is explicitly required, the workload includes paid/live model evidence.
- Evidence packs stay redacted and safe to share.

## Loop

Run:

```powershell
npm.cmd run t4:update-delivery:loop
```

The loop records evidence in `.dogfood/t4-update-delivery-<stamp>` and copies the latest run to `.dogfood/t4-update-delivery-latest`.

If the update-over-existing-state proof is missing, the loop must stay blocked. That is the intended behavior; T2 synthetic state safety and T3 installed workload proof are not the same as proving an update over an existing install.

## Importing Update Delivery Proof

After staging existing state, running the current installer over the install, launching StarNet from the installed path, and completing the post-update workload, import a JSON file with this shape:

```json
{
  "schema": "starnet.t4-update-delivery-proof.v1",
  "generatedAt": "2026-06-28T00:00:00.000Z",
  "sourceMachine": {
    "os": "Windows 11 Pro",
    "machineKind": "windows-sandbox"
  },
  "installer": {
    "sha256": "<current installer SHA-256>",
    "bytes": 34826840
  },
  "update": {
    "mode": "manual-nsis-reinstall",
    "previousVersion": "0.1.0",
    "targetVersion": "0.1.0",
    "existingInstallPath": "C:\\Users\\user\\AppData\\Local\\Programs\\StarNet",
    "updatedInstallPath": "C:\\Users\\user\\AppData\\Local\\Programs\\StarNet",
    "launchedBefore": true,
    "launchedAfter": true,
    "exitCode": 0,
    "durationMs": 90000,
    "timeoutMs": 600000
  },
  "state": {
    "protectedBuckets": [
      "save",
      "notebook",
      "todo",
      "channels",
      "ledger",
      "runs",
      "transcript",
      "update-settings"
    ],
    "before": {
      "save": { "sha256": "..." }
    },
    "after": {
      "save": { "sha256": "..." }
    },
    "unchanged": true,
    "backupBeforeMigrate": true,
    "failurePreservesOriginal": true
  },
  "workload": {
    "completed": true,
    "durationMs": 45000,
    "timeoutMs": 600000,
    "runIds": ["run-id"],
    "transcriptIds": ["stream-id"],
    "ledgerRows": [{ "model": "openrouter/model", "spendUsd": 0.01 }],
    "modelNames": ["openrouter/model"],
    "toolCalls": ["fs_write", "notebook_write", "shell_exec"],
    "artifactPaths": ["phase5-ref-workload.md"],
    "liveProvider": true,
    "paidSmoke": { "succeeded": true, "spendUsd": 0.01 }
  },
  "notes": []
}
```

Then run:

```powershell
$env:STARNET_T4_UPDATE_PROOF = "C:\path\to\update-delivery-proof.json"
npm.cmd run t4:update-delivery
```

Malformed imported proof fails red. Missing proof blocks. A dev-server workload does not count.

## Public Launch Deferral

T4 does not require public signed auto-update hosting. That belongs behind T1 public signing and release hosting readiness. For invited beta, the replacement-proof bar is manual reinstall/update plus bulletproof state survival.
