---
fingerprint: 661cbfea
slug: starnet-boots-the-station-erase-everything-set-a
title: starnet boots the station ERASE EVERYTHING set aside in the install folder
surface: onboarding
severity: P1
status: fixed
found: 2026-10-31
lane: agent/station-lifecycle-record-1031
fix: 7c30dd9e3
origin: audit
---

# starnet boots the station ERASE EVERYTHING set aside in the install folder

## Symptom

After ERASE EVERYTHING on a default Windows install, the app says the computer is clean, but `starnet -p` and `starnet init` pick %LOCALAPPDATA%\StarNet\workspaces. That folder is inside the NSIS install folder, which the erase never deletes, so the terminal boots the old station the Commander erased (gh#101's resurrection, through the terminal instead of automatic recovery).

## Repro

1. In a sandboxed profile, make the desktop workspace a native ERASE generation: `.migrated` plus `.fresh-start.json` `{version:1, erased:true, at:"<epoch ms>", acknowledgedRoots:[<LOCALAPPDATA>/StarNet/workspaces, ...]}`.
2. Put a valid save and roster in <LOCALAPPDATA>/StarNet/workspaces.
3. At trunk b14923ca2, `require('bin/starnet.js').defaultWorkspace({})` returns the install-folder root.

`node test/station-marker-matrix.test.js` reproduces it against b14923ca2: "native ERASE plus the install-folder legacy station (gh#101): `starnet` boots the desktop workspace — expected desktop, got legacy".

## Evidence

- At b14923ca2 the terminal's whole station rule was a file probe, bin/starnet.js:69: `function hasStation(ws) { return exists(path.join(ws, 'agent.save.json')) || exists(path.join(ws, 'agent.roster.json')); }`. It never read the erase marker, so defaultWorkspace took the bare root whenever the desktop held no save.
- For the same shape, the sidecar's gate says onboardingAllowed true and automatic recovery says AUTO_RECOVERY_ERASED (planner probe probe-erase-readers.cjs). The readers disagreed.
- `test/station-marker-matrix.test.js` against b14923ca2 gives 32 problems. The terminal also picks the install-folder station:
  - over a START FRESH marker in each at dialect;
  - after ERASE then START FRESH through either door;
  - over a torn marker, a torn record or a newer build's record.
  The same run shows the terminal and the gate disagreeing on whether a workspace holds a station (bookkeeping only; a save and roster gone with the rest of the station kept).

## Verdict

Fixed by 7c30dd9e3 (lane station-lifecycle-record, step 2). bin/starnet.js now asks `sidecar/station-record.js`, loaded on first use so `starnet --version` still reads only bin/.
- defaultWorkspace never picks a bare root that the desktop's record acknowledges, or that its erase authority or an unreadable reset or record blocks. That is the same predicate automatic recovery uses, so the gate, automatic recovery and the terminal give one answer.
- bootstrapWorkspace refuses on a save or roster under any of its names first (P1), then on a founded station whose save is gone. It writes with 'wx' and then founds the record.

`test/station-marker-matrix.test.js` passes at 717919a82 (251 assertions over 23 shapes).

The install-folder root itself still survives ERASE (Andrew decision 3, unchanged). No reader uses it automatically any more, and explicit recovery can still restore it.
