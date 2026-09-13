---
fingerprint: 6c91f5d9
slug: secondary-console-layouts-lose-provider-text-and
title: Secondary console layouts lose provider text and dropdown affordances at enlarged scale
surface: providers
severity: P2
status: fixed
found: 2026-09-13
lane: agent/interface-finish-0913
fix: 0054a3d7a
origin: owner
report: Owner requested a whole-interface polish audit, 2026-09-12
affected: Source 091d6e7f3; seeded browser UI
family: secondary-console-polish
installer: unverified
recovery: unconfirmed
---

# Secondary console layouts lose provider text and dropdown affordances at enlarged scale

## Symptom

At 1280x720 with 130% interface text, Settings provider descriptions collapse into a zero-width column and the cards become excessively tall. Automation Repeat and Away work agent dropdowns look like text fields because their arrows disappear. Settings helper text and Abilities choice titles use an older, smaller text scale; filtered deliverables offer no direct reset.

## Repro

1. Start the keyless seeded app and open Settings, maximize its docked panel, then choose Appearance > X-LARGE.
2. Open Providers at 1280x720. Compare the provider name, description and action placement.
3. Restore STANDARD and open Automation > New schedule and Away work. Compare dropdown arrows with the time selectors.
4. Open Deliverables and search for a nonexistent item.

## Evidence

Before screenshots: qa/interface-finish-0913/before-providers-130.png, before-ability-router.png, deliverables-empty.png. Live DOM measured the managed provider selection button at clientWidth 0 and scrollWidth 122. Automation Repeat computed background-image was none and padding-right 10px. Anchors: frontend/css/settings.css (`grid-template-columns:minmax(0,1fr) 190px`), frontend/css/menu-glass.css, frontend/css/utility-menus.css, frontend/app/deliverables.js.

## Verdict

Source repaired in 0054a3d7a and verified in the keyless seeded browser. All 18 provider cards fit at 1280x720 with 100%, 130%, and 145% text; wide and compact viewports also fit. Abilities choices now shrink to their pane, catalog cards grow with content, and long section headings wrap without horizontal scrolling. Automation arrows have 28px text clearance. Deliverables clears the combined search/status filters and restores the unfiltered empty state with focus in search. See qa/interface-finish-0913/REPORT.md and its screenshot receipts. Installed desktop and account-backed flows are not verified.

## Regression

Before: at source 091d6e7f3 the managed provider selection measured 0px wide at 130% text, and Repeat had background-image:none. After 0054a3d7a, the provider selection measured 195px with no card overflow, Repeat retained the shared gradient arrow and 28px right padding, and combined Deliverables filters reset through the new button. The GitHub catalog card previously had clientHeight 318px and scrollHeight 379px; it now grows to 489px with equal clientHeight/scrollHeight at 130% text. Browser screenshots and measurement details are in qa/interface-finish-0913/REPORT.md. This is live source verification, not an installer or account-backed regression claim.

## Sibling coverage

{"adapters":[{"target":"OAuth, key, local and managed providers","state":"covered","test":"test/provider-connections-ui.test.js","scenario":"provider status and action contracts","gate":"fast"}],"entrypoints":[{"target":"Settings, Automation, Abilities, Deliverables","state":"blocked","reason":"Browser interaction receipts cover these entry points; no registered cross-console geometry scenario."}],"displays":[{"target":"docked and full-width panels at multiple viewport and text sizes","state":"blocked","reason":"Live screenshot and DOM audit; installed Windows and macOS scaling not exercised."}],"lifecycle":[{"target":"key editor, empty filters, save feedback","state":"blocked","reason":"Disposable live browser verification; account authentication and real provider runs not exercised."}]}
