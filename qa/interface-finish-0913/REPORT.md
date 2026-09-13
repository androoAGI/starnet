# StarNet interface finish audit

Audit date: September 12–13, 2026. Baseline: `091d6e7f3`. Implementation: `0054a3d7a` on `agent/interface-finish-0913`. Environment: isolated worktree, keyless `node dev/seed.js --keep`, browser at `127.0.0.1:9237`. Findings below concern the actual seeded UI unless explicitly labelled **code inference**. This is a broad interface audit, not certification of every account, platform, or lifecycle state.

The strongest opportunity is to carry StarNet's existing readable glass-console patterns into secondary forms. Preserve the station artwork, VT323 type, phosphor palette, inset controls, restrained borders, status language, and shared window chrome. The largest defects came from fixed layout dimensions and older text rules, rather than the visual identity itself.

## Prioritized findings and implementation

| Priority | Screen/component | Evidence and consequence | Result |
| --- | --- | --- | --- |
| P1 | Settings → Providers, narrow dock at enlarged text | At 1280×720 / 130%, the managed provider selection measured **0px client width**, with 122px of overflowing content. Names/descriptions collapsed beside the fixed 190px action column. [Before](before-providers-130.png). | **Fixed.** Provider cards respond to their actual container width. Identity, action, and status stack when needed, retaining the established wide arrangement. [After, same scale](after-providers-130.png). |
| P2 | Abilities → Add an ability | Choice headings used the older 13px scale beneath 16px descriptions. A 268px grid minimum forced horizontal scrolling at 130%. [Before](before-ability-router.png). | **Fixed.** 18px shared section headings, flexible minimum columns. Choice grid now measures 250px client/scroll width at 130%. [After](after-abilities-130.png). |
| P2 | Abilities → Discover catalog | Fixed 320px card heights could not contain larger labels, instructions and actions. GitHub measured 318px client height / 379px scroll height at 130%; long section labels also pushed the decorative diamond outside the pane. | **Fixed.** Cards retain a common minimum and grow with content; header and action rows grow; section headings wrap. GitHub now measures 489px client/scroll height, and the pane measures 298px client/scroll width. [Narrow actions](after-catalog-130.png), [wide catalog](after-catalog-1920.png). |
| P2 | Automation → New schedule / Away work | Repeat and away-agent selectors lost their arrows because local background shorthand replaced the shared chevron. Other selects kept arrows but reserved only 10px on the right. | **Fixed.** Background color preserves themed arrows; consistent right clearance protects text. Repeat verified with a long interval label, selected weekdays, and a next-run result. [Docked](after-automation-1280.png), [full-width](after-automation-1024.png). |
| P2 | Settings helpers, subsection navigation; Abilities filters; Automation notes | Secondary controls used 12–13px and dim phosphor where comparable main-screen labels were readable. Abilities choices even inverted the title/body hierarchy. | **Fixed for named roles.** Existing meta/control/section tokens replace the small overrides; instructional text uses the established text color. This is not a blanket recolor of status or disabled controls. |
| P2 | Settings → Spending limits and dense forms | At 145%, the narrow reading pane leaves insufficient room for side-by-side labels and numeric controls. | **Fixed.** Container-based single-column rows and tighter group padding preserve readable inputs. Four budget rows measured equal client/scroll widths (174px). [Focused budget input](after-budget-145.png). |
| P2 | Deliverables → filtered empty state | “Clear the filters” was advice without an immediate action. [Before](deliverables-empty.png). | **Fixed.** CLEAR FILTERS resets query, status, project and kind, cancels pending search debounce, reloads results and focuses search. Combined nonexistent query + failed status was exercised; the UI returned to “NOTHING HERE YET.” [Recovery button](after-deliverables-empty.png). |
| P3 | System dock tooltip | Still advertised restore points/history in System despite those being in each agent's Record tab. | **Fixed.** Tooltip describes current navigation and names the Record destination; verified after reload. |

P1 here is audit impact, while the combined engineering register entry retains P2 because the provider defect depends on a constrained display configuration. Source changes and generated website mirrors are included in the implementation commit. No backend state claims or shared contracts were changed.

## Remaining observed issues

1. **P2 — large-text information density.** At 1280×720 and 145%, the console navigation plus CREW/COMMS leaves a very narrow reading pane. Cards fit now, but require substantial vertical scrolling; COMMS tools wrap to multiple rows and rail search placeholders truncate. At 1024px the existing full-width console breakpoint is paradoxically more comfortable. Consider allowing a deliberate full-width reading mode at intermediate widths, following the existing full-width console treatment. [Large-text context](after-providers-145.png), [comfortable full-width form](after-automation-1024.png). This larger shell decision was left unchanged.
2. **P2 — long task titles are cut mid-word.** A deliberately long task became “Audit crowded task cards with a deliberately long title: compare all secondary p” in the board and session rail. The wrapping card and More menu worked, but the visible title lost its ending. Investigate the title-length contract before changing persistence. Standardize on a concise display title with an accessible full-title disclosure. [Board and menu](task-long-more.png).
3. **P2 — nested reading areas.** Skill instructions introduce a scrollbox inside the already scrolling Abilities pane. At 720–900px height this competes with the panel scroll; expanded advanced forms have similar long journeys. Prefer the existing growing-card pattern for short content and reserve nested scrolling for substantial source/code. [Skill disclosure](skill-instructions.png).
4. **P3 — recruitment no-match context.** Searching for a nonexistent class empties the list while retaining the previous Strategist detail. That retained selection may be intentional, but the empty filter state needs an explicit explanation or a clearer selected-item boundary. Search was exercised; no recruitment was submitted.
5. **P3 — secondary copy and micro-label drift.** The widget library and skill metadata still contain smaller, dim labels than the corrected Settings controls. Treat these as a follow-up consistency pass, preserving a visible difference between supporting text and disabled controls. [Widget library](widget-library.png), [skill metadata](skill-instructions.png). No numerical contrast certification was performed.

## Patterns to make standard

**Code-only follow-up, not an observed defect:** catalog blurbs still deliberately clamp to four lines until details are opened (`frontend/css/menu-glass.css`). A separate content audit should confirm that every service's essential setup caveat is also present in the expanded details. This pass did not compare every service's preview against its complete description.

- **Typography:** shared `--sn-type-*` roles in `readability.css`; readable instructional text, stronger section titles, restrained metadata. Do not introduce another isolated font scale.
- **Layout:** size against the available pane; use `minmax(0,1fr)` or a bounded minimum and content-driven height. The existing Settings/Automation full-width layout is the reference for focused reading.
- **Forms:** shared dark inputs, phosphor chevrons, matching padding and visible keyboard focus. Keep disabled actions visibly disabled with the reason nearby, as in cleanup preview and browser-only desktop settings.
- **Feedback:** distinguish no data from no matches; provide an action that resolves the current condition. Use the existing inline validation, next-run preview, notification cards and save toast rather than adding a new alert style.
- **Truth:** preserve “not linked,” “no key,” “offline,” scheduler-off explanations, and browser-unavailable messages. A saved setup must not imply a proven connection.

## Coverage and receipts

“Inspected” means opened and read in the running app. Some tab coverage is DOM inspection plus captured screenshots, rather than every control receiving a separate visual review. Only the specific findings and repairs above are asserted as visually verified.

| Surface | Inspected states/workflows | Limits |
| --- | --- | --- |
| Main station, CREW, COMMS, rails | Idle/empty station; long saved title; dock dropdowns; Add agents modal with unavailable additions; Projects empty; model picker and offline catalog labels; resized panels/windows | No real streamed run, attachments, crowded many-agent station or voice session |
| Settings — all 10 sections | Providers, Autonomy, Night shift, Permissions, Spending limits, Model defaults, Live voice, Appearance, Alerts, App & Backup; blank inline key editor; disabled desktop controls; text presets; test notification | No credentials, billing, OAuth, actual backup/restore, installer update or microphone/speaker test |
| Tasks and Deliverables | Empty board/library; long task creation and More actions; search/status no matches; loading after reset; cleanup preview with disabled zero-record action | No populated file preview, cleanup deletion or task execution |
| Automation — all 5 sections | Scheduled jobs off/empty; new schedule, alternate timing controls and inline required-fields error; goal loops empty; new-goal choices; away work off/empty | No scheduled execution, completed/failed loop, permission grant or account delivery |
| Abilities | Installed built-ins; keys empty; services empty; custom connection form; Add an ability; discovery catalog; 74-skill library and instruction disclosure; advanced creation choices; plugin editor opened/cancelled; extensions empty | No installation, real auth, plugin execution or every service setup detail |
| Channels | Overview plus Telegram, Discord, Slack, Matrix and Signal setup tabs; setup copy/controls | No pairing, external message, connected service or actual network failure |
| Agent dossier | Brief, Growth, Record, Memory, Config; empty runs/issues/insights/restore points; expanded window | Not every deep configuration editor or run detail |
| Commander | About you, Goals, Preferences, Agent briefing, Sources, Station record; wrapping seeded text and empty records | No external document import or live progression |
| Recruitment / Recipes | Class/appearance catalog, empty class search, crowded recipe categories and Plan Trip form | No hire or recipe launch |
| Quests | Quests, Goals, Progress, Completed including three completed entries | No new goal execution |
| System | Field manual first mission/navigation; browser Updates unavailable; notifications empty, populated test event, mark-all-read and badge removal | Remaining manual chapters and installed updater not exercised |
| Refit | Quick-guide modal, prop categories/details, toolbar at two sizes, DONE success toast after unchanged layout | Other editing modes, placement failures and every prop not exercised |
| Widgets | Your widgets empty, Connected apps, available StarNet entry | No widget generation or connected third-party data |

Window checks: 800×600, 1024×768, 1280×720, 1440×900, 1920×1080. Text presets: STANDARD 100%, X-LARGE 130%, HUGE 145%. Provider checks covered all 18 cards via live geometry, with representative visual screenshots. Abilities/catalog repairs were rechecked at 1280×720 / 130% and 1920×1080 / 100%. Automation was checked at 1280×720 and 1024×768 / 100%. [Green-theme Autonomy](after-autonomy-green.png) was visually checked at 1280×720; the original amber theme and AUTO text preference were restored afterward. This is a targeted matrix, not every screen at every combination. Temporary viewport overrides were reset after verification.

## Verification status

- `node --check frontend/app/deliverables.js` and `frontend/app/glossary.js`: passed.
- `git diff --check`: passed before the implementation commit.
- `npm run sync:website`: synchronized the generated website assets.
- Full `npm run test:fast`: final run pending at report creation; see the final gate receipt below when available.
- Earlier gate attempts caught: worktree dependency detection when using only NODE_PATH (resolved with a local node_modules junction); stale generated website mirror (regenerated); stale QA index after filling the bug record (regenerated). These are recorded rather than represented as passing runs.

No installed Windows/macOS executable, actual OS display scaling/mixed-DPI move, native select popup rendering, browser zoom, authenticated service flow, real provider run, or exhaustive forced network-error/loading matrix was verified. The browser-only desktop messages were observed, not treated as desktop defects. A slash-command menu probe was inconclusive while the model picker was active and is not claimed as covered. Code inspection identified the fixed layout constraints; the repair claims rely on the browser observations, not only on CSS inspection or tests.
