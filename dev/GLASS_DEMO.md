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

## COMMS simplification - 2026-09-09

Owner feedback: the 26px name overshot and the overall COMMS treatment still did not fit. Reworked the panel hierarchy instead of only changing type. The identity is now a compact integrated row with a 20px name, 34 x 44 portrait, and one lower hairline. Message speaker names are 15px. Prose rows have quiet edge accents and use the same glass hover/focus gradient as CREW; persistent full message boxes are removed. The composer has one outer glass edge, a borderless writing area, a compact arrow send control with its existing accessible name, and a quieter tool row. Reduced extra borders in the reasoning controls, empty-state suggestions, and secondary diagnostic actions.

Live proof on the final local demo: 20px header and 15px speaker names; one composer frame, no inner field border, no header card frame. Message focus resolved to the exact CREW hover gradient. Error left edge stayed rgb(255,92,77), matching the real --bad token, while focused. Model popup and composer had no horizontal overflow. At 145% text size, the header, composer, tool row and empty starter cards fit without horizontal overflow; restored STANDARD. Agent picker Escape returned focus and hid its menu. Restored Glass UI exploration with an empty draft and the original 354px COMMS width. Browser warning/error log was empty.

Checks: comms-responsive-text (5), control-floor (121), website-app-sync (8), existing glass-comms behavior regression, and final diff whitespace check passed. Website mirror synchronized. No JavaScript or backend state logic changed. Full suite was not repeated for this CSS refinement; its previously recorded release-manifest failure remains unresolved. Active voice, real model runs, and multi-agent group conversations were not live-tested in this pass.

## COMMS copy and Add Agents controls - 2026-09-09

Reproduced the Add Agents overlap live: the generic .bb hover rule drew literal opening/closing brackets at 4px offsets over the button's 6px text padding. The demo now suppresses those pseudo-elements and renders a separate angular plus icon with a compact uppercase ADD AGENTS label, 28px control height, and a thin glass edge. Enhancement preserves the existing button/click handler and also handles GroupChat attaching that button after the demo script loads.

Message and fenced-code copy controls use a theme-coloured vector mask instead of the old font glyph. The existing copied/copy-failed classes select the check and failure icons; the original clipboard result logic and accessible labels remain authoritative. Copy controls are 26 x 24px with reserved header spacing for names and timestamps.

Live proof: hovering Add Agents now reports before:none and after:none; its label and plus icon render without horizontal overflow. The button opened the real ADD AGENTS sheet, then Cancel closed it without membership changes. Copying the existing Commander message placed exactly that message on the clipboard, produced the Copied label and check icon, and reset to Copy message with the copy icon. Restored the prior empty clipboard afterward. Both existing message copy controls had zero intersection with their speaker names and timestamps. Copy focus was visible with opacity 1 and the themed vector mask. Failure feedback styling and fenced-code appearance were not live-exercised in this keyless conversation.

Syntax and whitespace checks passed. group-chat-picker, chat-code-copy (20), comms-responsive-text (5), control-floor (121), website-app-sync (8), and the existing glass-comms behavior regression passed. Website mirror synchronized. Full suite was not rerun for these local control refinements; its existing release-manifest failure remains documented above.

## Shared STANDARD readability - 2026-09-09

Owner report 96921b22: ordinary text at STANDARD is too small, but magnifying everything overshoots. Added frontend/css/readability.css to the normal frontend entry point, including the generated website mirror. It runs both with and without the glass demo.

The scale uses 14px metadata, 15px compact Build controls, 16px controls/help, 18px conversation prose and 20px COMMS agent identity. Sessions are 17px; their tabs and filters are 16px. Scoped legacy inline captions below 14px receive a reading floor. Ordinary inactive navigation, dossier summaries and search placeholders use lighter theme-derived text. Semantic state colors are retained. STANDARD still means 100%; AUTO, saved enlargement preferences, CRT effects and frame sizing code are unchanged. New text surfaces should use the shared role tokens instead of adding 8-12px captions. Icon-only controls retain their own dimensions and font suppression.

Live proof on the seeded local app:
- At STANDARD, crew state/levels and model metadata computed 14px, session tabs/filters 16px, session titles 17px, message text/input 18px and the COMMS agent name 20px.
- Original viewport 1049 x 912 retained the 270px crew rail, 426px COMMS rail and 44px bottom bar. Main rails, COMMS identity/composer and bottom navigation had no horizontal overflow.
- At 900 x 700 STANDARD, the session toolbar wrapped NEW onto its second row, preserving the readable tabs; search, filters, COMMS composer, Add Agents and bottom navigation fit. Settings sheet and its body had no horizontal overflow.
- At 900 x 700 HUGE (145%), inspected main panel containers, composer and Settings body/size controls had no internal horizontal overflow. Restored STANDARD. This is not a claim that all installed OS/DPI combinations were exercised.
- At 1440 x 900 STANDARD, the Build inventory, tool buttons and purpose tabs had no horizontal overflow; labels were readable and purpose names wrapped. Browsed props without placing or removing anything. Restored the actual browser viewport afterward.
- Opened Settings, Dossier CONFIG and Task Board. Settings navigation/backdrop captions computed 16px; dossier state 14px, headings 18px and prompt/help text 16px; Task Board buttons and explanatory note 16px. Window containers fit without horizontal scrolling.
- ADD AGENTS opened and Cancel closed without changes. Model picker labels/search computed 16px and fit their popup; Escape closed it. Final browser warning/error log was empty.
- Loaded the normal app without ?glass=1: shared stylesheet present, body zoom 1, crew metadata 14px, session tabs/filters 16px, messages/input 18px, main rails had no horizontal overflow. Returned to the glass demo with Glass UI exploration, empty draft, original rail widths, red theme and STANDARD.

Verification:
- readability (21), comms-responsive-text (5), control-floor-theming (125), textsize-screen-space (95), website-app-sync (8) passed on the final stylesheet. Customer journeys passed all 32 suites.
- Full fast gate stopped at step 286/734 with the existing 10 qa-product-perfect-claims release-manifest failures, also present before this pass. The complete fast gate is not green; no integration merge or release was performed.
- Installed desktop artifacts, customer DPI/hardware and owner acceptance remain unverified. Populated multi-agent, active voice and real provider execution were not live-tested in this typography pass. Source guards are registered; manual browser geometry is documented here rather than represented as an automated gate.

## Compact model selector - 2026-09-09

Owner feedback: the model selector stretches too wide along the composer footer. The glass selector now uses its content width with a 220px maximum instead of growing into all available space. The audio controls remain aligned to the right. The readable 16px model name, real model/effort state and existing narrow-container behavior are preserved.

Live proof at the owner's current 484px COMMS rail: selector width fell from 330px to 152px, while the model name remained 16px. Composer toolbar client/scroll width both 464px; selector client/scroll width both 150px. The model menu opened normally (348px client/scroll width), and Escape closed it. Empty draft, active model and rail width were preserved.

readability (21), comms-responsive-text (5), control-floor-theming (125) and website-app-sync (8) passed. Website mirror synchronized. Full fast was not repeated for this CSS adjustment; its previously recorded release-manifest failure remains unresolved. No merge or release.

## Borderless model control and cleaner picker - 2026-09-09

Removed the model toggle's resting, hover, open and missing-key border treatments. It now has a small stateful chevron and a soft glass hover; keyboard focus retains its accessible outline. The real missing-key condition still colors the model name amber and keeps its Settings action inside the menu.

The popup has a stacked provider/model heading, a recessed search underline, a labeled REASONING row, brighter model names, crew-style row hover/selection, a quiet left-accent credential notice, and compact footer actions. A stronger glass backing and blur separate the menu from the transcript. No selection, provider, credential, effort or execution logic changed.

Live proof: toggle computed border-width 0px both closed and open, with a compact 166px width at the original 484px rail. Search for haiku filtered the real catalog; Escape closed the menu and returned focus, and Enter reopened it with search focused. At a 302px rail, toolbar client/scroll width both 282px and toggle client/scroll both 131px. Popup client/scroll width both 348px; all seven reasoning controls fit their labels. Restored the exact 484px rail, original model/MED effort and empty draft. Browser warnings/errors were empty; left the model popup open for review.

readability (21), comms-responsive-text (5), control-floor-theming (125), website-app-sync (8) and diff whitespace checks passed. Website mirror synchronized. Full fast was not repeated for this CSS refinement; its previously recorded release-manifest failures remain unresolved. Real model execution and installed builds were not verified; no merge or release.

## CREW glass material and StarNet subscription door - 2026-09-09

Owner correction: the model popup still looked flat and the OpenRouter-key warning was obsolete. The popup now uses exactly CREW's --gd-face, --gd-edge and --gd-shadow; its heading matches the rail's illuminated strip. Search, model rows, reasoning controls and footer actions carry the same glass face and inset light. Selected/hovered model rows use CREW's --gd-hover gradient. The compact bottom toggle stays borderless.

Removed the shared picker-only missing-key notice, amber chip treatment and their unused credential helpers. Replaced its footer Settings action with STARNET SUBSCRIPTION, pointing to the public https://www.starnetos.com/pricing page verified during this pass. This is a navigation action, not a claimed account status or a provider switch. Existing provider/model selection, credential checks in the harness, catalog reconciliation and runtime errors remain authoritative. Browser activation preserves the native secure new-tab link; desktop activation uses the existing open_external_url bridge and reports launch failures with the public URL.

Live proof:
- Popup and CREW background values matched exactly, including the 165-degree gradient and theme-colored translucent base. Selected model and selected CREW row both resolved to the same 120-degree highlight.
- No model-dock-keywarn element or obsolete key notice in the glass or normal app. Final footer href was the verified public subscription page; model toggle border width was 0px.
- At a 302px COMMS rail, toolbar client/scroll width both 282px. Popup client/scroll width both 348px; subscription action client/scroll width both 255px. Restored the 484px rail and empty draft.
- Haiku search filtered the real catalog; Escape closed it. Final model/effort remained claude haiku latest / MIN as observed during this pass. No model or effort selections were made by these checks.
- Final browser warning/error log was empty. Left the glass picker open for review. Payment, account sign-in and an installed desktop browser launch were not exercised.

Checks: JS syntax; dev/model-subscription.test.cjs browser-default, simulated desktop-bridge success and failure feedback; model-provider-reconcile (9), agent-model-select (65), readability (21), comms-responsive-text (5), control-floor-theming (125), website-app-sync (8), all passed. Final destination/handler refinement was rechecked with these focused gates. Full fast stopped at step 286/734 with the same 10 qa-product-perfect-claims release-manifest failures already documented; it is not green. Website mirror synchronized. No merge or release.

## Unified reasoning track - 2026-09-09

Replaced the seven individually framed reasoning buttons with one inset glass track. Unselected options are borderless, evenly sized labels; the selected option alone has the glass fill and a short illuminated lower edge. REASONING stays above the track, and keyboard focus remains visible inside it. Existing options, model-specific availability and selection handlers are unchanged.

Live proof: track client/scroll width both 326px; all seven options client/scroll width both 44px, computed border width 0px. MIN remained selected. Tab from model search focused OFF with a solid focus outline without changing MIN; Escape closed and Enter reopened the model picker. Empty draft preserved, browser warning/error log empty, menu left open for review.

readability (21), control-floor-theming (125), website-app-sync (8) and diff whitespace checks passed. Website mirror synchronized. Full fast was not rerun for this CSS-only refinement; its existing release-manifest failure remains documented above. No merge or release.

## Model menu hierarchy polish - 2026-09-09

Reduced the model header to one row: current model first in station-style uppercase, provider metadata aligned right. Removed the redundant rule above the model list. Per-model reasoning tags now appear on selection, hover or keyboard focus, with their space reserved to prevent label movement. Footer actions size to their contents. Glass surfaces, reasoning track, readable type sizes and the StarNet subscription action are preserved.

Live proof: header height reduced from 64.4px to 42.5px, client/scroll width both 348px. Subscription action client/scroll width both 162px (previously 255px). Model popup client/scroll width both 348px. Hovering the Sonnet row revealed its MIN tag at opacity .8 while the actual selected reasoning remained MIN. Final model claude haiku latest, 484px rail, empty draft and subscription destination preserved. Browser warning/error log empty; final menu open for review.

readability (21), comms-responsive-text (5), control-floor-theming (125), website-app-sync (8) and diff whitespace checks passed. Website mirror synchronized. Full fast was not rerun for this CSS-only refinement; the prior release-manifest failure remains unresolved. No merge or release.


## Four reasoning presets with exact control preserved - 2026-09-09

Owner feedback: simplify the choices without losing higher reasoning levels. COMMS now shows QUICK, BALANCED, DEEP and MAX in the existing glass track. For the full effort range these target low/medium/high/max; for the Codex fallback they target low/medium/high/xhigh. Explicit model metadata takes precedence. Models with fewer non-Off levels show only distinct supported choices, and Max always reaches the highest level in that available range. A model with no adjustable reasoning shows a neutral explanation instead of fake presets.

Advanced holds the unchanged exact effort choices, including Off where available. Supported saved MIN/XHIGH/Off values are not rewritten on rendering or when reselecting their highlighted range. The Advanced summary and bottom model chip continue to show the real exact value. Transport, per-agent pickers and capability clamping are unchanged. The main and exact controls use labeled button groups with aria-pressed, and focus survives rendering. Fixed an existing dismissal bug: the document outside-click handler now checks the original event path, so rebuilding a clicked reasoning button does not close the menu.

Live proof on the real seeded server at :9199:
- Initial claude haiku latest / MIN survived reload and a Quick re-selection. Max changed the chip to Maximum reasoning and persisted through reload. Deep applied High; selecting exact XHIGH and then Deep preserved XHIGH. Off in Advanced selected no primary preset.
- Reasoning selections kept the menu open and retained keyboard focus. Advanced stayed expanded through exact selection. Escape closed the menu and returned focus to its toggle; Enter reopened with search focused.
- Selecting the real catalog's Amazon Nova Micro entry showed no presets, no Advanced control, and the no-adjustable-reasoning explanation. Restored claude haiku latest / MIN afterward.
- At 302px COMMS width, popup client/scroll width both 348px and all four label client/scroll widths 79px. The seven exact controls fit at 44px each in glass. In the normal app, the expanded menu fit at client/scroll 318px and height/scroll-height 410px; exact controls fit at 38px each, primary controls 71px each. No native white controls found in the open standard picker.
- Final glass popup open with Advanced collapsed, claude haiku latest / MIN, 484px COMMS rail, empty draft and original red theme. Browser warning/error log empty.

Verification: new registered model-reasoning-presets regression passed 3245 assertions, covering all 127 nonempty capability combinations, highest-level reachability, saved exact-value preservation and real outside-click wiring with detached targets. JS syntax, agent-model-select (65), model-provider-reconcile (9), readability (21), comms-responsive-text (5), control-floor-theming (125), website-app-sync (8), and subscription navigation tests passed. Website mirror synchronized; diff whitespace clean. Full fast stopped at step 286/735 in qa-product-perfect-claims with the same 10 existing release-manifest failures. The gate is not green. No real provider inference or installed-desktop execution was tested; no merge or release.


## Plain reasoning labels - 2026-09-09

Owner refinement: renamed the primary presets to LOW, MEDIUM, HIGH and MAX. Available-level mapping, exact saved values, Advanced and highest-level reachability are unchanged. Live glass menu confirmed all four labels fit at 79px client/scroll widths, with claude haiku latest / MIN preserved, Advanced collapsed and COMMS at 484px. Registered reasoning regression (3245) and website mirror (8) checks passed; JS syntax and diff whitespace passed. Full fast was not repeated for this label change; its existing 10 release-manifest failures above remain unresolved.


## Session signal family - 2026-09-09

Replaced the flat 6px session lamps with fixed 12px glass bezels. Read uses an empty outline; unread has a steady illuminated core; confirmed work scans inside the frame; approval shows a red exclamation with a slow 1.6s light pulse; an agent question uses two message strokes; failed runs show a steady cross; connecting has a dotted frame and center point. Only confirmed work and pending approvals animate. Shapes remain distinct without color or motion. Reduced-motion CSS disables the scan/pulse and keeps the working stroke visible. Project folder lamps retain their existing small squares; sessions inside Projects share the new signal treatment.

Truth and interaction fixes:
- Channels.runIdOf must confirm a run before the working state is shown. Connecting gets its own signal and label rather than a false work timer.
- The working timer uses Channels.elapsedOf, excluding accumulated approval pauses.
- Pending questions, approvals and recorded failures have separate classes. Real pending prompts remain visible even before a run-start event and take priority over working/unread.
- Read/unread still come from the original Workstreams timestamps and open-session rules. No counters, activity, runs or read receipts are invented.
- Row accessible names and hover tips now explain every state. The existing one-second ticker updates adopted tooltip text in place, including a visible tooltip, and updates project-scoped session rows too. The glyph is decorative to screen readers because the row names the state.

A separate labeled sample preview is served at /dev/session-indicators.html. It uses the actual shared styles for all seven states without manufacturing jobs or approval prompts in the station. The preview's sample labels are not live telemetry.

Live verification:
- Real app: all three current sessions honestly showed read; each lamp measured 12px, no animation. Row height stayed 34.39px and client/scroll widths both 231px on the final inspected rail. Arrow navigation focused General and showed its current read tooltip; Enter opened it. Returned to Glass UI exploration, claude haiku latest / MIN and empty draft. Browser warning/error log empty.
- Sample preview: all seven frames measured 12px. Only working's inner stroke had gd-session-scan; only approval's outer frame had gd-approval-pulse. Unread/read/reply/failure/connecting had no animation. Screenshot inspection confirmed distinct filled, hollow, scan, exclamation, message and cross silhouettes with the red glass theme. The preview clearly identifies all rows as samples.
- Real provider execution, live consent prompts, a populated project session list and the OS reduced-motion setting were not exercised. Their transition logic is covered by the real channel/session reducer tests; reduced-motion rules are source-checked. No fake live state was injected into the owner's station.

Checks: JS syntax for app.js and changed tests; registered session-indicators (32 assertions), consent-visibility (24), channels (53), workstreams (193), projects-view (69), session-power-tools (130), session-creation (19), readability (21), comms-responsive-text (5), station-tooltip (427), control-floor-theming (125), website-app-sync (8) and the standalone approval regression all passed. The transition test uses the real Channels and Workstreams modules with a controlled clock, including working/unread/read, save hydration, same-agent session isolation, approval priority, pause exclusion and failure recovery. Website mirror synchronized. Full fast stopped at step 286/736 with the same 10 existing qa-product-perfect-claims release-manifest failures. Gate remains red; no merge or release.
