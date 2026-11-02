---
fingerprint: 1ac8819d
slug: a-process-a-shell-command-detaches-start-process
title: A process a shell command detaches (Start-Process) survives E-STOP and sidecar exit and nothing reports it
surface: safecell
severity: P2
status: open
found: 2026-10-20
lane: sweep/safecell
fix:
origin: audit
---

# A process a shell command detaches (Start-Process) survives E-STOP and sidecar exit and nothing reports it

## Symptom

An approved `shell.exec` whose command launches its own detached child (PowerShell `Start-Process`, or any launcher that does not keep the child in its handle tree) returns `exit 0` in about a second. The child keeps running. `POST /api/halt` (E-STOP) reports `halted: 0` and leaves it running; stopping the sidecar leaves it running. No surface lists it — it is not a `shell.bg` process, not in the procledger, and the foreground call's own tree-kill only runs on timeout/abort of a call that has already finished. Ordinary foreground children and `background:true` processes ARE reaped (verified below), so the gap is specifically the self-detached grandchild.

## Repro

1. Boot a sidecar with Full Access OFF; place the workbench.
2. Watched run: `shell.exec { cmd: "powershell -NoProfile -Command \"Start-Process -WindowStyle Hidden ping -ArgumentList '-n','219','127.0.0.1'\"" }`; approve once.
3. `POST /api/halt`. Wait 4 s. List `PING.EXE` processes (`Get-CimInstance Win32_Process`).
4. Stop the sidecar. List again.

## Evidence

Live against our own sidecar (probe `walk8.js`, sweep scratchpad), process table read from `Win32_Process`:

```
c_results      [{"tool":"shell_exec","ok":true,"summary":"exit 0 (1092ms)"}]
c_beforeHalt   [{"pid":44596,"ppid":6276,"cmd":"\"C:\\Windows\\system32\\PING.EXE\" -n 219 127.0.0.1 "}]
c_halt         {"halted":0, … "terminalStops":0 …}
c_after        [{"pid":44596,"ppid":6276, …}]          (4 s after E-STOP)
survivorsAfterSidecarExit  [{"pid":44596, …}]          (killed by the probe afterwards)
```

Controls in the same walk: a foreground `ping -n 217` mid-call was gone after E-STOP (`a_after: []`, result `cancelled`); a `background:true` `ping -n 218` was gone after E-STOP (`b_after: []`).

Anchor: `sidecar/tools/builtin/shell.js` `killTree` (taskkill `/T` walks live parents only, and runs only on a call's timeout/abort) — and `sidecar/proctree.js` already has the owned-descendant walk (`ownedTree`, creation-time window) that could name such a child, but foreground calls do not record their root in the ledger once they finish. Not a small fix (needs a per-call owned-tree sweep or a Job Object); filed open. Related doctrine: docs/MISTAKES.md "Same-session arbitrary code defeats denylist guarantees … Job Objects help with process lifetime".

_Found by the `sweep/safecell` lane (safecell surface), 2026-10-20._

Still open. Reconciled 2026-11-02 (the v0.14.2 merge-back, cut record item 9.3b): `f9860dcac` (first released in v0.14.2) is a partial fix. On Windows every sidecar attempt now runs in a kill-on-close Job Object, and every stop of the station ends what it left behind, including a self-detached `Start-Process` child. The release's kill-relaunch case passed on Windows and macOS (run 41179376463). The E-STOP half stays open: nothing in that commit makes E-STOP end or report such a child.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
