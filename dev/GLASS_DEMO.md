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


## Panel joins and resize cleanup — 2026-09-09

Removed both the lower-right resize control and decorative footer grip from glass windows. The top height handle and maximize/restore remain the sizing controls.

The cabinet gaps now expose an opaque, theme-derived glass bed instead of the near-black body background. Rail shadows are shallower, and the camera casing uses the same fine glass edge instead of the previous black outer ring. Grid spacing and panel dimensions are preserved.

Live on the current custom blue theme: the shared bed resolved to srgb(0.04235, 0.08957, 0.22526); the camera edge had no black outer shadow. Both corner grip elements computed display:none. Maximize/restore and top-handle ArrowUp/ArrowDown worked. Window-minimize (20), control-floor (117), terminal-resize (16), and website-app-sync (8) assertions passed; diff whitespace check passed. This CSS-only pass did not rerun the full suite; its existing release-manifest failure is documented above.

## COMMS glass pass - 2026-09-09

The opt-in loader now includes glass-comms.css and glass-comms.js. COMMS has a compact agent header, a recessed writing field, matched send/attachment/audio controls, glass model and command menus, and fine-edged message, choice, empty-state, and group-agent cards. Theme variables carry the active phosphor colour throughout. Recording, muted audio, missing keys, errors, and suggested decisions retain their existing state semantics. The live-voice panel, tool cards, and attachment previews have matching material rules.

The agent picker progressively mirrors the original roster select and dispatches its original change event only when the selected agent changes. Selecting the current agent is a no-op for session routing. Keyboard navigation supports arrows, Home/End, Escape and Tab. Escape in the model picker returns focus to its toggle. Closing pickers become inert while their opacity/translate transition completes; reduced motion disables these transitions.

Live checks on the final local demo:
- Visually inspected the COMMS rail, message/error cards, composer and expanded model picker in the current red theme.
- At a 300px COMMS rail, the panel, header, composer and tools had no horizontal overflow at both standard and 145% text size. Restored STANDARD afterward.
- Agent picker opened by keyboard, selected NOVA, and closed with focus returned; selecting NOVA retained Glass UI exploration.
- Model search filtered the real model list; Escape closed it and returned focus to the model toggle.
- Slash input opened the real command list without executing a command. Cleared the test draft.
- ADD AGENTS showed the actual current membership and no-changes state. Cancelled without saving.
- General displayed the real empty conversation and three glass starter cards; returned to Glass UI exploration without sending a starter.
- Final reload preserved the conversation and theme; placeholder rendered Message followed by a middle dot and / commands, with an empty draft.
- The inspected browser warning/error log was empty.

Checks:
- Syntax checks passed for glass-comms.js and glass-demo.js; diff whitespace check passed.
- dev/glass-comms.test.cjs passed same-agent no-op, canonical changed-agent event routing, and focus-return cases.
- group-chat-picker, composer-paste-limit (25), comms-responsive-text (5), control-floor (121), and website-app-sync (8) passed. The generated website mirror is synchronized.
- Full npm run test:fast stopped at step 286/733 with the same 10 qa-product-perfect-claims release-manifest failures documented above. The full suite is not green; no merge or release was performed.
- The keyless demo has one agent. Real model execution, switching between two live agents, active voice recording/live voice, and populated attachment/tool states were not live-tested. Those associated surfaces were styled without changing their backend state logic.

## COMMS identity correction - 2026-09-09

Owner feedback: the names were too small and the hierarchy did not fit the station. The header now uses an inset crew-style glass card, a 40 x 52 portrait, and a full-width 26px uppercase agent name. Removed the redundant ON THE LINE overline; model information and Add agents sit beneath the name. Message speaker names increased from 11px to 17px while timestamps remain secondary. Group conversations keep their existing flex header layout.

Live DOM proof: NOVA header 26px, speaker name 17px, header height 76px; no horizontal header overflow at the original 354px rail or the narrowed 303px rail. Agent menu opened and Escape returned focus. Restored the exact original rail width and preserved the empty draft. Final reload showed the revised typography with no browser warnings/errors. Group header appearance was not live-tested with multiple agents.

comms-responsive-text (5), control-floor (121), website-app-sync (8) passed; mirror synchronization and final diff whitespace check passed. This CSS-only adjustment did not repeat the full suite; the existing release-manifest failure remains documented above.
