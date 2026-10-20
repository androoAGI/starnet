# StarNet T3 Release Smoke

T3 answers the beta-critical question that T0 and T2 do not answer by themselves:

> Can the current packaged StarNet build, after installation, run a useful harness workload from the installed app path?

T0 proves install and first launch. T2 proves state survives migration/reinstall scenarios. T3 ties those proofs to an installed-workload proof so StarNet does not overclaim readiness from dev-repo smoke alone.

## Done Condition

T3 is complete only when `.dogfood/t3-release-smoke-latest/t3-release-smoke-status.json` reports `releaseSmokeReady=true`.

That requires:

- The current NSIS installer exists and its hash is recorded.
- T0 clean-machine proof is green for the current installer.
- T2 state-safety proof is green.
- A real installed-app workload proof is imported with `schema=starnet.t3-installed-workload-proof.v1`.
- The imported proof references the current installer hash and byte size.
- The proof declares an installed app source, not a dev-server source.
- The installed app reached a usable harness state.
- The workload completed before its timeout and produced run, transcript, ledger, model, tool-call, and artifact evidence.
- If a live provider key is present, the proof must include paid/live model evidence.
- Evidence packs must remain redacted and safe to share.

## Loop

Run:

```powershell
npm.cmd run t3:release-smoke:loop
```

The loop records evidence in `.dogfood/t3-release-smoke-<stamp>` and copies the latest run to `.dogfood/t3-release-smoke-latest`.

If the installed workload proof is missing, the loop must stay blocked. That is the intended behavior; a dev-repo P5 workload is not the same as an installed-app release smoke.

## Importing Installed Workload Proof

After running the current installed app and completing the deterministic release-smoke workload, create a JSON file with this shape and import it:

```json
{
  "schema": "starnet.t3-installed-workload-proof.v1",
  "generatedAt": "2026-06-28T00:00:00.000Z",
  "sourceMachine": {
    "os": "Windows 11 Pro",
    "machineKind": "windows-sandbox"
  },
  "installer": {
    "sha256": "<current installer SHA-256>",
    "bytes": 34826840
  },
  "installedApp": {
    "source": "nsis-installed",
    "launched": true,
    "usableHarness": true,
    "observedWindowTitle": "StarNet"
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
$env:STARNET_T3_WORKLOAD_EVIDENCE = "C:\path\to\installed-workload-proof.json"
npm.cmd run t3:release-smoke
```

Malformed imported proof fails red. Missing proof blocks. A dev-server proof does not count.
