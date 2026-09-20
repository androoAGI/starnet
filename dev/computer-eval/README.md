# Computer-control evaluation

The original `cua-driver.js` here remains a development prototype. It evaluates
Cua Driver through StarNet's MCP client and injected `computer.use` driver seam.
The separate production implementation and its setup are documented in
[Computer Control](../../docs/COMPUTER_CONTROL.md). `production-smoke.js`,
`runtime-smoke.js`, and `app-survival.js` exercise that production implementation.
No shared contract files are modified.

## Reproduce

Tested on Windows with Node 22.23.0 and Cua Driver 0.28.2. Download the
[pinned Windows x64 binary archive](https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/cua-driver-rs-0.28.2-windows-x86_64-binary.zip)
into an ignored scratch directory and check its SHA256 before extracting:

```text
1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba
```

No global installation, PATH change, or autostart registration is required. Keep
the archive's sibling DLLs alongside the executable. The adapter disables upstream
telemetry, strips ambient provider credentials, owns a private named pipe/daemon,
and shuts it down after a probe. It does not attach to a shared CUA daemon.

From this worktree:

```powershell
node --test dev/computer-eval/adapter.test.js
node dev/computer-eval/browser-export.js .qa_tmp/cua-evaluation
node dev/computer-eval/notepad-workflow.js C:/path/to/cua-driver.exe .qa_tmp/cua-evaluation
node dev/computer-eval/live-loop.js C:/path/to/cua-driver.exe <observed-pid> <observed-window-id>
```

The Notepad probe creates its own file, opens it, edits through accessibility,
checks the text, rejects a superseded token, saves through File → Save, verifies
exact disk contents, and closes only its own saved tab. It never kills Notepad:
Windows Notepad can restore unrelated user tabs on launch. Receipts contain no
other tabs or document contents. The browser export uses real headless Chromium
with a local fixture and a private browser profile, not an authenticated service.

`live-loop.js` selects a screenshot using a replay provider but dispatches a real
CUA capture through the real StarNet loop. It checks the screenshot reaches the
model transcript and restricted contexts cannot execute it. It is not a test of
LLM planning, the installed app, or production HTTP registration of CUA.

## Authority and limitations

The trusted development launcher requires `fullPower: true` to start a private
unrestricted CUA runtime. This matches the requested Full Power evaluation; it is
**not** a new renderer-callable authority flag. Production must derive this from
the existing host authority, never agent arguments. Restricted modes need their
own launch policy; they must not inherit an unrestricted daemon.

`makeDriver` supports screenshot, type, key, hotkey, click and double-click for
the experiment. `observe()` and `selectElement(index)` are host-side evaluation
helpers. The production model schema cannot yet express semantic element targets.
The prototype's pixel coordinates are explicitly **window-local**, whereas the
legacy driver uses desktop coordinates. A production replacement must introduce
an explicit target/coordinate-space contract and cannot silently swap these.

The existing tool wrapper prefixes results with `computer.* ok` and formats clicks
as coordinates. Semantic clicks therefore expose `click undefined,undefined` in
these receipts. CUA's structured `effect` is preserved, but production adoption
must update the result grammar so dispatched/unverifiable is never represented as
outcome confirmation. The adapter throws on refusal rather than returning success.

No foreground fallback is automated by these probes. The live native-driver
typing baseline was paused when foreground focus changed; screenshot timings
are available, but there is no complete native-vs-CUA task-success benchmark.
Four passing Notepad trials do not establish arbitrary-app reliability.
