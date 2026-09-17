# StarNet v0.12.2

This update remasters the station itself: industrial materials, a redesigned command bridge, a furnished default station with every essential ability already installed, a browsable Build library, remastered agent skins with grounded walk cycles, and an onboarding that goes from what you want to do straight to a first useful task. It includes fixes and hardening for customer-reported update, boot, rating, delegation and conversation-history problems reported since 0.11.2.

These notes cover the changes shipped since **0.11.2**. The 0.12.0 and 0.12.1 candidates were held before publication; this corrected build includes the complete overhaul.

- **Close-to-tray:** finishing startup or reloading the document no longer reopens a window you closed to the tray. Initial display waits for the completed document; explicit tray Open and a second launch still reveal the app.

- **Saved model choices:** a temporary catalog error or offline fallback list no longer clears your selected model, including during startup and refresh.

## A remastered station

- **Industrial station materials:** walls, floors, ceiling coping, corridor doorways and shells are rebuilt in a darker industrial style with orbital shells, clean station floors and consistent structural frames. Wall heights, doorway reveals and corner joins are aligned across every room shape.
- **Redesigned command bridge and props:** the workstation, tactical table, capability equipment (terminal, files cabinet, comms dish, memory core, media studio), lounge furniture, storage, lab and workshop machinery are re-authored at station scale with readable forms, fitted screen effects and truthful activity (screens, mechanisms and indicators follow real harness state).
- **Pre-equipped default station:** a new station starts as one furnished room with a workstation, all five essential ability props and plants, so a fresh Commander can hand over a first task without placing equipment. Seven station presets (DEFAULT, QUIET RETREAT, COZY WORKSHOP with a connected conveyor line, CREATIVE STUDIO with a prepared draft-and-review line, RESEARCH, ENGINEERING and OPERATIONS stations) can be applied from Build and the previous station restored.
- **Build library:** Build Mode is a spacious, searchable prop library sectioned into FURNITURE, EQUIPMENT and ABILITIES with category menus, previews, clear placement/cancellation feedback, inline move cancellation and keyboard Escape. Build selections now match the visible artwork.
- **Remastered agent skins:** 37 finalized skins with grounded strides, corrected cardinal facings, natural turns, talking and sitting motion, workstation seating with proper foot occlusion, and layered couch seating. Legacy skin selections keep working.
- **Movement and lighting:** agents route clear of raised doorway walls, keep a natural travel pace, reconcile their walk after collisions and plant correctly when stopped. Station lighting pools, fixture illumination, back-wall light and exterior navigation lights are rebalanced; the shipped CRT look is preserved.
- **Renderer recovery and performance:** silently lost station canvases are recovered and remaster materials restored before a re-bake; the canvas watchdog no longer performs synchronous readbacks; lighting caches are reused. On the 96-prop stress layout the integration measurements recorded frame intervals of 8 to 15 ms at p95 with zero render faults.

## From an idea to a result

- **Goal-first onboarding:** setup follows what you want to do, with a cinematic agent arrival and a first-task handoff. The optional quick tour explains the equipment already in the station and never asks you to place props; a typed first task survives the tour and returns as an editable draft.
- **Personal journeys:** WORK → QUESTS connects ambitions, plans, next actions and outcome reviews (Now / Goals / Progress / History). Planning suggestions can be reviewed, adopted, edited and undone; drafts survive refreshes and delayed saves; finished steps link to the exact run output.
- **Creative Studio guidance:** a guided setup and verified sample workflow for the Studio, with a prepared draft and review conveyor in the furnished preset.

## Everyday improvements

- **Compact speech bubbles** and fewer redundant delivery acknowledgments.
- **Conversation history stays in order:** refreshing or retrying a conversation no longer reorders or rewrites the local transcript (the "my turns vanish / an old message moved to the front" report).
- **Composing stays in your chosen session:** background workshop events and delayed connector checks respect the focused composer, unsent drafts and attachments. Explicit session navigation continues to work.
- **Corrections replace old memories:** explicit memory corrections preserve an audit history while keeping one current belief in recall. Approved requirements can stay pinned within their project or conversation, and stale reviews cannot overwrite newer edits.
- **Incomplete work is explained:** repeated promises without tool actions end with an explicit incomplete-work error. Unsupported claims that a preference was saved are checked against actual notebook-write receipts.
- **Saved files stay clickable:** the "▤ saved <file>" and media rows an agent produced are replayed when a conversation is reopened, switched to, reloaded or retried, instead of surviving only in the model's prose.
- **XP and ratings:** earned XP refreshes in open views, skipped rating credit can be recovered, and interactive replies in a conversation that also contains scheduled routine activity can be rated on their own run record. Ineligible replies now say exactly why.
- **Secondary panels** render correctly at enlarged UI scale and narrow widths; provider text and dropdown affordances are readable; CRT curvature is accounted for in hover and click targets.
- **Static CRT settings** (0–200%) persist across reload independently of theme and glass.

## Reliability and support repairs

- **Boot guard self-heals a slow engine:** if the desktop window loads before the station engine answers, the shared catalog is retried with backoff and the page reloads once on success instead of painting "STATION FAILED TO BOOT" (the shared/specialties.js reports on Mac and Windows). A genuinely broken file still shows the banner, now with the retry ledger for support.
- **Account unlink recovery:** unlink and status-read failures stay visible with a retry and a working LINK STATION path instead of silently hiding the controls.
- **ChatGPT sign-in at setup:** a live ChatGPT sign-in takes precedence over an old saved OpenAI API key when the key field is blank. A key you explicitly type still selects the API route, and connection errors identify the route used.
- **Browser element discovery:** the internal browser now finds JavaScript-driven cards, ARIA targets and open-shadow controls (the campaign-listing report).
- **Telegram and channel leads** receive the crew briefing matching the delegation tools they were actually granted; workers cannot delegate recursively.
- **Local models:** small-talk turns omit task-only prompt material and per-run ids ride last in the prompt so caches survive; Ollama output has a configurable ceiling and capped casual replies stop without automatic continuation.
- **Response safety:** auxiliary budgets and responsive fallback cancellation are preserved; durable unload saves are recognized when their acknowledgement was lost; the tutorial activity guard stays scoped to orientation.
- **Delegated specialists** keep access to connected MCP tools; cross-provider fallback keeps the selected route; task cancellation, review retries and routine/session binding repairs from the 0.11.2 follow-through are included.

## Upgrade notes

- Existing stations keep their layout, props, crew, conversations, routines, goals and settings. The furnished presets never replace a saved station; they are applied only from Build and can be restored.
- Update from SYSTEM → SETTINGS → UPDATE CENTER, or download the installer for Windows or macOS from the release page. The desktop shell clears the stale WebView cache automatically on a version change.
- The installer is substantially larger than 0.11.2 because it includes the new station and character artwork. Review-only art is excluded; the textures needed to enable the remaster are included.
- The customary 48-hour attended soak was waived for this release. Candidate-specific installed smoke, scripted reliability and responsiveness receipts are recorded with the release preparation evidence.
