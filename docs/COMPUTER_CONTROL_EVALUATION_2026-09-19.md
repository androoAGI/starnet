# Computer control: CUA evaluation, 2026-09-19

**Recommendation: continue with an opt-in CUA native-app backend; do not replace
StarNet's default driver yet.** The live Windows evaluation demonstrates useful
background editing, semantic targeting, explicit stale-reference rejection, and
compatibility with StarNet's screenshot-to-model pipeline. It is not a complete
Hermes-vs-StarNet task-success benchmark.

## What was evaluated

- StarNet source: `621bbf467`, isolated branch `agent/cua-evaluation-0919`.
- Windows, Node 22.23.0, pinned Cua Driver 0.28.2 binary (archive SHA256 in the
  [reproduction instructions](../dev/computer-eval/README.md)).
- Hermes's architectural reference: its current public CUA integration. The
  locally installed Hermes checkout is `c9de69c6d`, dated 2026-07-30; it was not
  updated or presented as a test of current Hermes.
- Only development files were added. No production backend selection, public
  tool schema, shared event/schema contract, or Full Power policy was changed.
- CUA ran with a private, explicitly unrestricted evaluation runtime, matching
  this Full Power experiment. No PATH/autostart registration or global driver
  installation. Upstream telemetry disabled; no provider credentials inherited.

## Observed results

| Scenario | Result | Evidence |
| --- | --- | --- |
| Native Notepad edit and save via CUA injected into `computer.use` | 4/4 fresh scripted trials passed | Exact resulting file contents checked; final trial also explicitly verified owned-tab closure |
| User coexistence during those edits | Cursor and foreground unchanged in all 4 sampled before/after checks | These observations do not prove there was no transient focus change between samples |
| Superseded element reference | Rejected in all 4 trials | Driver returned `stale_element_token`; no fallback click |
| Closed-menu Ctrl+S in modern Notepad | Failed in exploratory test | Driver could not find an exposed UIA accelerator; disk unchanged |
| Recovery through File → Save | Passed | Semantic menu actions followed by actual disk read-back |
| Browser report export | Passed using StarNet's existing headless browser driver | Local export fixture; real Chromium download, exact 49-byte CSV checked |
| Browser → native app handoff | Passed | CUA opened the exported CSV in Notepad; StarNet adapter appended a review row and saved it; disk checked |
| Live StarNet agent loop | Passed with deterministic replay planning and real CUA capture | One tool result and one real image turn reached the model transcript; `agent.run.end` emitted |
| Restricted context | Rejected before native dispatch | Existing `computer.use` authority check preserved |
| Seeded StarNet app smoke | Passed | Live UI exposed NOVA/COMMS; local fixture-provider HTTP run returned `agent.run.end` with reason `done` |
| Legacy physical-input task baseline | Incomplete | Foreground changed during setup; typing was withheld instead of risking a different window |

The browser fixture is not an authenticated SaaS app. Notepad is a real native
application, but these are small, deterministic workflows. No model-planning
success rate, comparative token bill, or arbitrary-app reliability is established.
The seeded app smoke does not register CUA in the production HTTP path; that
remains future integration work.

## Measurements

The four scripted CUA background edits took **17, 20, 22 and 65 ms** at the action
call, excluding discovery, snapshots, model latency and startup. Semantic menu
opening took 14–19 ms; Save invocation took 9–16 ms. Outcomes were verified
separately; the Save invocation itself correctly remained `unverifiable`.

Three repeat window captures with CUA took **737, 741 and 761 ms**, with roughly
42 KB of image data plus an accessibility tree. Three legacy virtual-desktop
captures took **496, 527 and 669 ms**, with roughly 596 KB of image data for a
3840×1080 desktop. These are different workloads and capture areas. CUA was not
faster at capture in this sample; its benefit was targeted context and semantic
control. No overall speedup is claimed.

The exploratory legacy click took 592 ms. Comparing it directly with a CUA UIA
invocation would conflate different operations and excludes the unresolved focus
issue. A complete native task baseline needs a quiet foreground testing window.

Sanitized machine receipts: [Windows results](../dev/computer-eval/results/windows-2026-09-19.json).

## Integration gaps found

1. **Result semantics:** the production wrapper prefixes action results with
   `computer.* ok`. CUA's `unverifiable` verdict is retained in the payload, but
   the prefix is ambiguous. Semantic clicks also produce the old coordinate
   summary `click undefined,undefined`. Introduce explicit delivered/confirmed/
   unverified/refused results and semantic target summaries before adoption.
2. **Target and coordinate contract:** legacy coordinates are desktop-global;
   this experiment's CUA pixel path is window-local. The public tool needs exact
   app/window identity and snapshot-bound elements. Never silently swap meanings.
3. **Session lifetime:** the exploratory long-lived CUA session expired while
   idle. A read was explicitly rejected; `start_session` revived it and fresh
   observation succeeded. Production must handle lifetime, cancellation and
   reconnect without blindly repeating possibly completed mutations.
4. **Fallback behavior:** modern Notepad's closed-menu shortcut failed even
   though its semantic Save worked. Reobserve and verify before deciding on a
   pixel or foreground fallback; bound recovery attempts.
5. **Compatibility:** this prototype covers only the actions exercised here.
   Broader Windows apps, scrolling/dragging, DPI/monitor transformations, modal
   dialogs, elevation, Mac/Linux, long sessions and interruption remain unproven.
6. **Packaging and authority:** pin and verify the driver; detect prerequisites;
   tie private runtime mode to existing host-minted authority. Full Power must
   retain its current meaning. Do not copy Hermes's independent shortcut/text
   denylists into StarNet or add a second permission ceremony.
7. **Concurrent use:** exact window/session ownership and task cancellation need
   tests across multiple StarNet agents; native foreground input still needs
   serialized ownership when an application requires it.

## Suggested next implementation slice

Add an opt-in backend setting with a startup diagnostic, exact window/element
targets, truthful structured results, and a cancellable private runtime. Preserve
the existing browser/connector routing. Prove the same workflows through the
served app and model-visible schema, then extend to one Chromium/Electron app and
one Office app before proposing a default switch. Voice already exists in
StarNet; evaluate spoken steering and stop behavior after this control layer is
stable.

## Validation status

Eight adapter regression tests passed. The real Notepad probes, native image
loop and seeded app smoke passed as described above. `npm run test:fast` timed
out at its 900,000 ms limit after 743/829 steps, last completed
`test/station-recovery.test.js`. No assertion failure was reported in that
prefix. This is **not a green full gate**. The remaining 86 steps were resumed
separately, starting with `test/station-recovery-cli.test.js`, and passed:
`cua-eval-fast-remainder: OK — 86 step(s) green`. All 829 steps completed across
the split runs, but the standard single-run gate still timed out. The branch
has not been merged. No production sidecar/route files changed, so
the additional HTTP gate was not required for this development-only evaluation.

An initial fast-gate attempt stopped at step 88 because this new worktree lacked
`ogg-opus-decoder`. `npm ci --ignore-scripts` installed the locked dependencies
and the full gate was restarted. No dependency manifest changed.

The owned seed-browser teardown reported a timeout once; a process inventory
afterward showed no Chrome process with its unique evaluation profile remaining.
All private evaluation CUA processes and the owned seeded sidecar were stopped.

## References

- [Hermes computer-use architecture](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use/)
- [Hermes private daemon implementation](https://github.com/NousResearch/hermes-agent/blob/main/tools/computer_use/cua_backend_daemon.py)
- [Cua Driver 0.28.2 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2)
