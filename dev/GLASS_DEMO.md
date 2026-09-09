# Glass UI local demo

Open http://127.0.0.1:9199/?glass=1 in a browser. Without `?glass=1`, the normal presentation is used.

This isolated branch is a design demo of the real StarNet frontend and sidecar, not an installed release. Its save lives in `dev/.scratch-workspace`. No production station data or provider keys were copied.

## Try it

- Hover CREW and SESSIONS rows: both use the same glass gradient, edge and highlight.
- Bottom SYSTEM > SETTINGS opens a sheet above the existing dock.
- Drag the small top handle vertically, or focus it and use Up/Down. Home makes it compact; End expands it.
- EXPAND / RESTORE switches between a compact sheet and the available height.
- Drag the title to move the window freely; DOCK returns it to the bottom.
- MINIMIZE puts it in the existing minimized-window strip; select the strip button to restore it.
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

`frontend/app/glass-demo.js` is opt-in, with `frontend/css/glass-demo.css` loaded only for the demo URL. Two small window-manager hooks reuse minimize and allow a docked sheet to own its geometry without saved floating-window dimensions fighting it. The generated website mirror is synchronized.

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
