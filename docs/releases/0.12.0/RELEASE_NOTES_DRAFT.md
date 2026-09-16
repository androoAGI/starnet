# StarNet 0.12.0 — draft release notes

**Editorial draft; not published or installer-verified.** Finalize after the overhaul merges and combined acceptance. Keep root `RELEASE_NOTES.md` describing the current public release until the release cut.

## A new station

StarNet 0.12.0 reworks the station's visual identity and the way you move from an idea to useful work. Industrial materials, a redesigned command bridge and new floor and shell choices give the world a different character. Your agents' work remains connected to real tools, results and recorded progress.

## From an idea to a result

- Onboarding follows what you want to do, with an agent arrival sequence and a first-task handoff.
- Personal journeys connect ambitions, plans, next actions and outcome reviews.
- Goal drafts and choices are retained more reliably through refreshes and planning.
- The station tour can be replayed without repeating task setup.

## Everyday improvements

- More compact speech bubbles and fewer redundant delivery acknowledgments.
- Conversation refresh preserves local transcript order.
- Better layouts for secondary panels, provider text and controls at enlarged UI scale.
- Earned XP refreshes in open views, and skipped rating credit can be recovered.
- Station hover and click targets account for CRT curvature.

## Reliability work

- Browser discovery recognizes more JavaScript-driven cards, ARIA targets and open-shadow controls.
- Account unlink and status-read failures remain visible, with a recovery path instead of silently hiding linking controls.
- Small-talk turns omit task-only prompt material; Ollama has a configurable output limit.
- Repairs to task cancellation, review retries, routine/session binding and recovery controls.

## Editorial holds before publication

Pending integration of preparation repairs, add these verified source behaviors after combined acceptance: Telegram owner tasks receive the crew briefing matching their granted tools; new interactive replies in scheduled conversations can be rated independently. Older replies without saved origin receive a specific eligibility explanation. Source receipts: [FOLLOWTHROUGH.md](FOLLOWTHROUGH.md).

The copy above describes code in baseline `90d6f0111`, not completed release acceptance. Do not promise measured local-model speedups, recovery on every customer machine, data-preservation guarantees or a fully repaired Telegram report without the corresponding evidence.

Add final owner-selected furnished stations, Build library, remastered prop catalog, complete skin/motion work and final onboarding changes only after their actual combined inclusion and live verification. Retake screenshots from that build. Do not promise a community gallery or AI station builder based on the existence of furnished presets.

Before copying this draft into the public release body, replace this editorial section with the actual upgrade instructions and any unresolved limitations from the final disposition. Mention only migrations and retained settings that the 0.11.2 upgrade test proves. Keep historical artwork already shipped in 0.11.2 out of the new-change list.

## Internal claim trace (remove from public copy)

| Copy | Source anchors |
| --- | --- |
| Industrial default, bridge, shell/floor choices | `312b7b5d6`, `ae32f360f`, `a2764b708` |
| Onboarding/arrival/first task | `36ab97298`, `53b62ff84`, `9568243c4` |
| Journeys/plans/reviews | `172acd77e`, `e1696ce99`, `e529f9dc4`, `f49596784` |
| Compact bubbles/acknowledgments | `05155ab01`, `ac370cefb` |
| Transcript order, panels, XP, pointers | `003ac403e`, `0054a3d7a`, `05a399cf0`, `f8b60bef0` |
| Browser, unlink, prompt changes | `dcbc2b941`, `02332ee85`, `5acf4640f` |
| Lifecycle/retry/session repairs | `b54b44574`, `c3d4f4f8e`, `b5c5cba75` |

Complete mechanical inventory: [scope.json](scope.json). Product commits can include art, tests or partial work; each public bullet still needs review against the final behavior.
