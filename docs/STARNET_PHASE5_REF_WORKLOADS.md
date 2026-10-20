# StarNet Phase 5 the reference harness Replacement Workloads

Phase 5 moves StarNet from P4 `limited-pilot` to a replacement decision that can honestly retire the reference harness as the main harness.

The core rule is simple: contract-green is not ref-proven. P5 evidence must say which surface was proven through a live StarNet workload, which surface is only contract-green, and which gap is accepted or blocked.

## Completion Contract

P5 can only be called `ready-to-replace` when all of these are true:

- P4 remains green from the current integration tree.
- A live model completes a real StarNet UI workload with file, memory, shell or verify, web reach, transcript, ledger, artifact, screenshot, model, and spend evidence.
- Browser automation is proven by live workload evidence or explicitly remains below replacement-ready.
- Desktop computer-use is proven by live attended driver evidence or explicitly remains below replacement-ready.
- Soak evidence includes a restart/resume pass with transcript, ledger, artifact, memory, and station state preserved.
- Recovery remains green for cancel, budget, denied consent, tool error, and checkpoint/restore.
- Clean-machine desktop readiness is either green or explicitly kept out of the replacement decision.
- The final decision file says `ready-to-replace` only if no accepted replacement gaps remain.

## Canonical Workload Pack

The P5 live workload should exercise these ref-style behaviors through the gamified StarNet UI:

| Workload | Required Evidence |
|---|---|
| Live model run | run id, transcript id, model name, positive reconciled spend |
| File deliverable | artifact path plus transcript/tool-call proof |
| Memory write | notebook write event or durable memory record |
| Shell or verify | `shell_exec` or `verify_run` tool call with a successful result |
| Web reach | `web_search`, `web_fetch`, or browser tool call from a placed DISH |
| Restart soak | same run/transcript/artifact/ledger/memory still visible after sidecar restart |
| Browser surface | `ref-proven`, `contract-green`, `accepted-deferral`, or `blocked` |
| Computer-use surface | `ref-proven`, `contract-green`, `accepted-deferral`, or `blocked` |
| Desktop readiness | `green`, `toolchain-blocked`, `accepted-deferral`, or `blocked` |

## Loop Commands

```powershell
npm.cmd run phase5
npm.cmd run phase5:loop
npm.cmd run phase5:live
npm.cmd run phase5:ready
npm.cmd run phase5:evidence:check
```

`phase5:live` is the main evidence loop. `phase5:ready` is the replacement gate; it exits non-zero unless the decision is actually `ready-to-replace`.

