# Native computer control

In the Windows desktop app, open **Abilities → Computer Control**. Install CUA,
then select **CUA · Accessibility**. Installation alone does not enable it. The
selection persists across restarts and applies to new runs. Changing it closes
active CUA sessions. **Windows · Classic** keeps the existing desktop driver;
**Off** removes native control from subsequent tool projections.

CUA currently supports Windows x64 in StarNet. Browser and connector tools remain
the preferred paths for websites and service APIs. Existing voice tasks use the
same native tool when their agent has Full Power. This change does not introduce
an always-listening microphone or change voice permissions.

## What is different

CUA exposes app/window discovery, window screenshots with accessibility elements,
semantic and pixel input, menus, window geometry, clipboard actions, and bounded
state verification through `computer.use`. A model can request `describe` for an
operation's exact schema. Schemas come from the pinned CUA 0.28.2 release; the
adjacent `CUA-LICENSE.txt` includes its MIT notice.

An observation provides opaque element tokens. Later observations invalidate
older tokens; stale actions return a tool error. Window pixels and desktop pixels
are distinct coordinate spaces. Background input is preferred; foreground input
remains explicitly available when background input refuses or produces a verified
no-op. Full Power retains whole-computer authority, including intentional control
of StarNet itself. Restricted runs cannot launch the native driver.

Results retain CUA's effect, route, refusal and verification evidence. `confirmed`
means the driver's particular check succeeded. `unverifiable` and `dispatched`
require another observation or independent readback before claiming the task
was accomplished. A successful tool call is not itself proof that a file saved.

## Installation and lifecycle

StarNet downloads the official Windows x64 0.28.2 archive and checks SHA-256
`1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba` before
extracting it. A staging directory becomes the installed version directory only
after the executable's version and UIA helper are verified. No global PATH,
autostart, standalone daemon, or global CUA configuration is changed. Telemetry
is disabled in the child environment, and provider credentials are not inherited.
**Reinstall CUA** downloads and verifies the replacement before closing sessions
and swapping directories. A failed download leaves the previous driver intact.
If Windows prevents old-file cleanup, the `previous-*` folder can remain beside
the active version; it is never selected as the active driver.

Files live in `<WORKSPACES>/native-computer/0.28.2`; selection lives in the
protected sibling `computer-control.json`. **Check Driver** proves the executable
responds with the expected version, not that every app supports background input.
Windows security controls, elevation, and application accessibility limitations
can still prevent an operation.

Each authorized run lazily owns a separate daemon, named pipe, MCP client, and
session. Tool calls within a run are serialized. Completion, abort, tool transport
failure, and backend changes close its private driver and proxy. Applications
opened for the user are not terminated when a run finishes. Other runs' sessions
are not stopped. An expired session is discarded; the next call can establish a
new session. Mutations are never automatically replayed after ambiguous failure.
Observe again before deciding to retry. A force-killed host cannot promise orderly
cleanup; graceful shutdown and run cancellation are the supported cleanup paths.

Advanced direct-sidecar launch settings (the desktop host marker is still required):

- `STARNET_COMPUTER_DRIVER=cua` pins CUA; `off` pins disabled.
- Existing `1`/`win32` selection remains the default until changed in Abilities.
- `STARNET_CUA_BINARY` selects an explicit installation with its sibling UIA helper.
  StarNet verifies its version; installation is then managed by the operator.

The CUA runtime's unrestricted flag is private implementation of the authority
StarNet already granted. It is not exposed as a model argument or a new permission
switch. This runtime is not registered as an isolated third-party MCP connector.

## Reproducible verification

Run `node --test test/cua-computer.test.js test/computer-control.test.js` and
`node test/computer-control.http.test.js` for authority, effect reporting,
serialization, failed installation, settings persistence and HTTP authentication.

For native proof, launch a seeded Windows desktop-marked sidecar with a scratch
workspace and CUA binary configured, then run
`node dev/computer-eval/production-smoke.js http://127.0.0.1:<port>`.
It uses a local deterministic provider and a newly created Notepad file/tab to
exercise the actual HTTP → run → registry → driver → model-image path, verifies
the saved bytes independently, and closes only that fixture tab. It does not
benchmark a general-purpose language model's planning ability.

`node dev/computer-eval/runtime-smoke.js <binary>` checks two real independent
sessions, cancellation, continued operation of the other session, and cleanup.
`node dev/computer-eval/app-survival.js <binary>` verifies that a newly launched
noninteractive fixture app survives driver cleanup, then stops that fixture itself.
The earlier Hermes comparison and measurements are in
[the evaluation report](COMPUTER_CONTROL_EVALUATION_2026-09-19.md).
