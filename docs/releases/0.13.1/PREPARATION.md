# v0.13.1 — release preparation record

Tag `v0.13.1` = `e0a36dcd3` (release commit `749324e01`, notes `a5f29a5d8`, claims re-lock `e0a36dcd3`). Cut
2026-10-04 on the owner's go: "waive the soak, cut it and publish it".

## Scope

The owner named the scope: group chat repair, the web_request / web_fetch "fetch failed" fix, COMMS readability, the
schedule and recipe feedback (RUN AS, EDIT / DELETE in the header, same-name guard, honest unattended-send warning),
crew stuck in the halls (follow-ring fix and a 12-second stall watchdog), and the per-line floor OUTBOX filed in
DELIVERABLES. The spending-cap, provider key-check and #57 delegation fixes landed on trunk during preparation and ship
too, by owner decision. Live steer / agent interruption (`agent/live-steer-composer`) is deliberately NOT included.

## Soak

- **48-hour installed soak: WAIVED by the owner** (2026-10-04), as for 0.12.4, 0.12.5 and 0.13.0.

## Evidence on `e0a36dcd3`

| Proof | Result |
| --- | --- |
| `npm run test:fast` | 1053 of 1053 green |
| `npm run test:http` | 185 of 185 green |
| Guardian cycle 20261004-104823 (pinned to the lane) | GREEN |
| Beginner Run | PASS, 6 of 6 steps |
| Journeys | 139 of 139 assertions |
| Local installer (clean `npm ci`, no linked node_modules) | 457,493,917 bytes, sha256 `09c0bfee9d7cf363…`, minisign OK |
| Installed smoke (that installer, installed over 0.13.0) | GREEN, app 0.13.1, build `e0a36dcd3` |
| `qa:ready` | READY |
| Release preflight (post-bump) | PASS 13, FAIL 0 |
| Push audit (82 commits) | single human author, 0 co-author trailers, 0 `claude/` subjects, no secret pattern in 3,525 added lines |
| Release train 37225126827 | GREEN first attempt: gate, 3 signed builds, both Macs notarized, Intel acceptance, assemble, stage-draft (9 assets) |
| Trunk CI on `e0a36dcd3` | fast-gate, eval-gates, secret-history green |
| T0 clean install on the draft (37228700196) | GREEN |
| G1 packaged lifecycle on the draft (37228704705) | GREEN (idle-close, close-to-tray, updater-smoke) |

## Release notes

`RELEASE_NOTES.md` was drafted from the merged commits. Three independent fact-checks against the code at the candidate
found about 20 overstatements, all corrected before the claims re-lock.

## Publish

- Published 2026-10-04 19:37:30Z as Latest on androoAGI/starnet-releases (owner's go).
- `release:verify-host --expect-version 0.13.1`: ALL CHECKS PASSED (windows-x86_64, darwin-aarch64, darwin-x86_64).
- Source mirror sync (37229023095) green.
- Website restamped (`FALLBACK_VERSION` 0.13.1) and deployed to starnetos.com from `website-deploy`; live site serves
  v0.13.1, Skill Market catalog still 200.
- Public updater canary (G1 public_canary=true, baseline v0.13.0): first run 37229000890 FAILED "Save drain not
  confirmed" after a correct update (0.13.0 → 0.13.1, automatic restart healthy, build e0a36dcd3). The automatic-restart
  window saved revision 6 to the sidecar at 19:44:39Z and was closed; the inspection relaunch's WebView2 local copy
  still held revision 5, so its next save was correctly refused as a conflict (recovery file kept, nothing lost). No
  save-path code changed since v0.13.0. Re-run 37229609433 GREEN (lifecycle + public-updater-canary). The close-timing
  race is pre-existing and filed as a follow-up; a user who hits it sees the "Another window saved newer station
  changes" notice with download / reload keys.
