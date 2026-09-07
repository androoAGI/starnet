# Installed Windows emergency recovery acceptance

`emergency-native-proof.mjs` runs ONLY on a disposable GitHub-hosted Windows VM.
It refuses a local workstation or self-hosted runner before opening any files for writing.
It does not install, publish, reset a station, or edit runtime source. Node 22+ is required;
the CDP helper uses Node's built-in WebSocket and fetch, with no extra dependencies.

Install the exact candidate through the existing T0 workflow first. Close that installed
app before this helper starts. Pass the installed executable path, not the installer path.
The native shell, installed sidecar and frontend resources must all come from the same
candidate. Checkout this helper and `scripts/lib/cdp.mjs` in the tooling workspace.

```powershell
$candidateExe = Join-Path $installDir 'StarNet.exe' # use the actual filename installed by T0
$candidateExeHash = (Get-FileHash -LiteralPath $candidateExe -Algorithm SHA256).Hash.ToLowerInvariant()
node scripts/qa/emergency-native-proof.mjs `
  --exe $candidateExe `
  --install-dir $installDir `
  --out (Join-Path $env:RUNNER_TEMP 'emergency-native-proof') `
  --expected-exe-sha256 $candidateExeHash `
  --expected-build-sha $candidateSourceSha
```

Inputs:

- `--exe`: installed native application executable; must be inside `--install-dir`.
- `--install-dir`: defaults to the executable's directory; must contain the candidate's
  `frontend/app/emergency-control.js` and the normal installed runtime resources.
- `--out`: a NEW output directory under `RUNNER_TEMP`; existing output is refused.
- `--expected-exe-sha256`: full 64-character SHA-256 from the independently selected installer output.
- `--expected-build-sha`: full 40-character candidate SOURCE SHA (e.g. the frozen build ref),
  checked against `starnet_build_info.sha` in the actual running native app.
- Optional `--workspace`: must equal the shell's normal `%APPDATA%/ai.skynet.harness/workspaces`
  on this disposable runner. It cannot redirect inspection to some other convenient workspace.
- Optional `--seed-workspace`: defaults to the checked-in `dev/fixtures/seed-workspace`.
  Only `agent.save.json` and `agent.roster.json` are copied, and only into an empty station.
  An existing nonempty station with no save is refused; use the normal T0 onboarding first.
- Environment guards: `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, Windows,
  valid `RUNNER_TEMP` and `APPDATA`. Never set these on an owner's machine to bypass the guard.

The helper uses a separate retained WebView2 cache directory under `--out` through all three
launches. It injects a nonfunctional placeholder OpenRouter key into the child process only,
so a seeded station can enter without a real provider credential. It neither verifies nor
claims model execution. Existing channel/provider credentials must not be provisioned in
this disposable test profile. If the native connect gate still requires onboarding, the
helper fails with that explicit timeout; it does not hide the gate or mutate the UI to pass.

It first prepares one disabled routine and one individually paused loop behind an E-STOP,
then arms scheduler intent and clears setup halts. The measured cycle clicks the real System
Stop control via CDP mouse events, verifies all three live AND persisted flags, kills only
the process tree it launched, restarts the same installed exe, clicks the real Resume Automation
control, and restarts again to prove recovery persists. Forced process restarts deliberately
avoid the app's explicit Quit action, which itself requests a new emergency stop.

The before/after comparisons include autonomy posture, permission allow/bypass records,
workshop records, scheduler arm intent, and routine/loop settings. No test job is enabled
for execution. This is lifecycle/control acceptance, not a provider, real-workload, or
customer-recovery proof. Separate HTTP tests cover each partial persistence failure.

Once preflight accepts the disposable host and output path, launch/test outputs are retained
on success AND failure. Argument, host, path and fixture preflight refusals print an error and
exit 1; they cannot produce a PASS receipt or run the app.

- `receipt.json`: PASS/FAIL, exact native source/executable identity, executed-script hash,
  per-phase API and disk halt flags, protected-state hashes, and any error.
- `network.jsonl`: the actual button requests, HTTP status and JSON response bodies for
  `/api/halt` and `/api/halt/resume`. Auth headers and API tokens are never recorded.
- `startup-*.log`, `process.log`: native workspace provenance and process diagnostics.
- `webview-profile/`: retained test-only cache for failure investigation; don't publish it
  as a public release asset. Upload receipts/logs through the existing private T0 workflow.

The executed recovery script must hash-identically to the candidate's installed resource;
an HTTP-served patch or stale embedded/cache script cannot satisfy this test. Process cleanup
targets only the spawned PID and descendants; no process-name-wide stop or data deletion occurs.
Exit 0 means the complete measured cycle passed. Missing CDP, wrong artifact, stale script,
missing startup provenance, changed permissions, or mismatched persisted flags yield exit 1.
