# Glass UI local demo

Open http://127.0.0.1:9199/?glass=1 in a browser. Without `?glass=1`, the normal presentation is used.

This isolated branch is a design demo of the real StarNet frontend and sidecar, not an installed release. Its save lives in `dev/.scratch-workspace`. No production station data or provider keys were copied.

## Try it

- Hover CREW and SESSIONS rows: both use the same glass gradient, edge and highlight.
- Bottom SYSTEM > SETTINGS opens a sheet above the existing dock.
- Drag the small top handle vertically, or focus it and use Up/Down. Home makes it compact; End expands it.
- The square maximize / restore icon switches between a compact sheet and the available height.
- Drag the title to move the window freely; DOCK returns it to the bottom.
- The minimize line icon puts it in the existing minimized-window strip; select the strip button to restore it.
- Open an agent dossier to try the same shell with another real panel.
- Settings > Appearance still controls the phosphor theme, CRT and text size.
- CREW / WORK / BUILD / SYSTEM remain in their existing bottom position.

At desktop widths the sheet fits between CREW and COMMS. When the center becomes too narrow, it uses the available viewport width while keeping clear of the top and bottom bars.

## Relaunch

From this worktree in PowerShell:

```powershell
$env:SKYNET_PORT = '9199'
$env:SKYNET_DEFAULT_MODEL = 'anthropic/claude-haiku-4.5'
node dev/seed.js --keep
```

The current demo is keyless: browsing and UI controls work; real model runs need a connected provider. Empty example sessions were created through the real UI. Sheet heights/expanded state are session-local for this prototype.

## Implementation

`frontend/app/glass-demo.js` is opt-in, with `frontend/css/glass-demo.css` loaded only for the demo URL. Window-manager hooks reuse minimize, let the docked sheet own its geometry, and route close/minimize/restore through its interruptible motion controller. The generated website mirror is synchronized.

## Live verification

- Matching CREW/SESSIONS hover: identical computed gradient, border and inset shadow.
- Settings and agent dossier open as sheets.
- Expand/restore; keyboard height adjustment; title drag and redock.
- Minimize to the existing strip and restore with docking preserved.
- 1280 x 800: panel left 253, right 899, bottom 735; CREW right 243, COMMS left 909, dock top 745.
- 800 x 700: panel left 12, right 788, bottom 637.98; dock top 648; close control visible.
- 145% text size: panel and close control remain inside the top/bottom band.
- Purple appearance and the three empty sessions survive reload.
- No browser warnings/errors in the inspected demo log.
- Installed desktop and authenticated provider runs were not tested.

## Test receipt

Both touched JavaScript files pass node --check. Window-minimize passed 20 assertions; control-floor theming passed 117. The canonical npm run test:fast exceeded its 900000 ms wrapper limit after test/g3btrophy.test.js (manifest line 561), with no assertion failure reported before termination. The full gate is INCOMPLETE; no merge or release was performed.


## Motion refinement — 2026-09-09

Close, minimize, and restore now share one interruptible glass-sheet animation. The old CRT squash/brightness animation is disabled for this opt-in shell. Completion removes/hides the window before releasing its final transparent frame; replacing an animation cancels its stale completion. Closing/minimizing windows are inert, and exiting sheets ignore layout observers. New sheets dock before the first paint. Rail resize events are batched once per frame and share one band measurement.

Dock menus fade and move 8px in both directions. Closing menus become inert immediately; keyboard navigation reenables the destination before focusing it. Window buttons and section controls share the existing short motion tokens. Rapid restore/minimize replaces a departing disabled dock chip, so its old removal callback cannot strand the window without a restore button.

Live checks on the final local demo:
- Settings close sampled from opacity 1 / translate 0 to opacity 0.000115 / translate 63.993px, then removed. Transform and filter stayed none throughout: no vertical squash or brightness flash.
- Settings minimize/restore returned a visible, non-inert sheet, with no legacy restore animation.
- Maximize/restore controls remained reachable; close returned focus to SYSTEM.
- Agent dossier opened with the same shell; Escape removed it. Switching to Settings left one correct window and an active scrim.
- Keyboard SYSTEM → BUILD menu navigation focused the correct first destination; menus settled closed with display:none and inert.
- Settings and dossier controls had zero matches for the native white/grey paint signatures.

Checks:
- Syntax checks passed for glass-demo.js, stationui.js, and navdock.js.
- dev/glass-motion.test.cjs passed interrupted entrance/exit, stale callback suppression, completion ordering, reduced-motion, exit-layout, and rapid dock-chip replacement cases.
- window-minimize 20, terminal-resize 16, terminal-position 43, control-floor 117, and website-app-sync 8 assertions passed; approval indicator regression also passed.
- The resize source guard now checks operation order rather than a 500-character limit that the earlier docking hook exceeded.
- Full npm run test:fast stopped at step 286/733: qa-product-perfect-claims.test.js (10 failures). A read against the pre-change committed baseline 2036bce8dfb64b8de03622a167d31dff9f22c198 confirmed its release manifest already rejects the demo's app.js, stationui.js, index.html and added paths. That release audit was not rewritten for a local design prototype. The full suite is not green.
- Reduced-motion behavior was exercised in the deterministic controller test; the OS preference was not changed. No installed-app or release verification/merge.
