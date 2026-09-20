# Computer control implementation proof

Scope: opt-in CUA 0.28.2 backend, Windows x64 installer/repair, Abilities settings,
per-run native sessions, truthful results and existing Full Power authority.
No shared event/schema edits, default driver replacement, microphone change,
global CUA installation, or published installer.

The implementation was isolated onto `agent/cua-production-0919` from integration
`621bbf467`; only this lane's evaluation and implementation commits were copied.
An intermediate integration merge containing another lane's work was deliberately
excluded after integration moved back to its earlier baseline.

## Live proof

- Seeded app from this branch, `http://127.0.0.1:18942`, scratch workspace only.
- Abilities → Computer Control: Off saved and survived restart. Initially CUA
  was unavailable until installation. The real Install button downloaded,
  checksum-verified, extracted and checked the package. CUA then became
  selectable. Selection saved and Check Driver reported executable/version
  evidence. Visible controls had zero native white/grey control-paint matches.
- Actual `/api/run` with a local deterministic provider projected `computer_use`
  and executed ten turns: fresh Notepad fixture, window observation + real image
  delivered to model, background semantic typing, independent accessibility
  readback, File → Save, independent exact disk-byte verification, fixture-tab
  close. Final repetition used the package installed through the UI.
- `type_text` reported `confirmed`; menu/save clicks reported `unverifiable`.
  The wrapper preserved those distinctions. File completion was established by
  disk readback, not inferred from input dispatch.
- Two real private sessions had different session IDs/pipes. Aborting one
  stopped its daemon while the other continued. Completion stopped the second.
- A deliberately expired real session failed without retrying; its actionable
  text diagnostic survived the generic structured error. The next observation
  opened a fresh runtime successfully.
- A newly launched, noninteractive WScript sleep fixture survived CUA cleanup;
  the probe subsequently stopped that exact fixture itself. Driver shutdown
  does not recursively terminate applications launched for the user.
- Real verified install and reinstall passed. No owned CUA daemon/UIA helper
  processes remained after probes. No foreground typing baseline was attempted.

Receipts: `dev/computer-eval/results/production-windows-2026-09-19.json`.
Reproduction: `docs/COMPUTER_CONTROL.md` and `dev/computer-eval/README.md`.

## Regression coverage

19 focused tests cover authority, cancellation during startup, serialized calls,
imagewire, error propagation through the real registry, no automatic mutation
replay, expired session replacement, child environment, host support, durable
setting readback and failed-download/failed-repair preservation. The authenticated
HTTP settings/restart test passes as well.

Sweep fixes included a registry-normalization bug that would have swallowed native
refusals, cleanup that could have killed launched apps, injected runtime clocks,
and a CSS rule overriding the hidden installation button. The first broad HTTP
gate passed 124 steps on the intermediate tree.

## Accepted integration candidate

The lane subsequently synchronized the accepted orchestration, reliability and
Google connector changes by merging, never rebasing. Final source candidate
`d982e9e41` passed the complete fast manifest **839/839**, exit 0
(`.qa_tmp/cua-accepted-final-fast.log`). The same product source passed the
complete HTTP manifest **127/127**, exit 0
(`.qa_tmp/cua-integrated-candidate-http.log`). Later incoming commits through
`d450ce8da` contain documentation/QA receipts only and are preserved.

Earlier accepted checkpoints passed fast 833/833 + HTTP 124/124, then fast
838/838 + HTTP 126/126 before concurrent lanes advanced integration. These are
retained as intermediate evidence, not substituted for the final full gates.

The final product source repeated the native ten-turn edit/save/image workflow
at 2026-09-20T01:50:48Z. Its merged Abilities panel showed selected CUA, successful
driver check, correct custom-install visibility, and 350px width without overflow.
Desktop and website UI mirrors are byte-identical. The test browser and seeded
host were closed after proof.

Intermediate failures were repaired rather than hidden: the full manifest grew
beyond its 15-minute fast watchdog; both full suites now have bounded 20-minute
budgets with outer teardown headroom (also independently accepted by reliability).
Runtime clock injection, source-fingerprint refresh, and explicit cleanup
diagnostics addressed gate failures without loosening assertions. A later canvas
test passed all 408 assertions but failed to remove a Windows log held by Chrome.
The test now requests Browser.close before its existing forced-process fallback;
it passed the focused run, three consecutive repeats, and the complete fast gate.
The original failed log remains `.qa_tmp/cua-integrated-candidate-fast.log`.

No shared schema/event changes or credential migrations were introduced by this
lane. Post-merge gate results will be appended after completion; source acceptance
does not claim a published or rebuilt customer installer.

Before integration the compare-and-merge guard detected another concurrent lane
at `6d44812e0` (REFIT rendering). It was merged into this workspace with no product
conflicts; the shared source fingerprint was regenerated without changing audit
verdicts. Candidate `6961885fd` passed **839/839 fast** and **127/127 HTTP**, both
exit 0 (`.qa_tmp/cua-refit-combined-fast.log` and
`.qa_tmp/cua-refit-combined-http.log`). The later REFIT receipt at `f9da97542`
changes only its own digest and is preserved. These complete results supersede
the earlier candidate counts as the pre-merge acceptance.

This proves the exercised Windows workflows and deterministic-provider plumbing;
it is not a general model benchmark or a claim that every application supports
background input. OS elevation and app accessibility limitations remain real.
