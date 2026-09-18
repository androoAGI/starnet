---
fingerprint: 9f67d884
slug: conversation-crowded-on-short-laptop-windows
title: Conversation crowded on short laptop windows
surface: sessions
severity: P2
status: fixed
found: 2026-09-18
lane: small-screen-0917
fix: edb33201d
origin: customer
report: Screenshot shared by owner on 2026-09-17
affected: Desktop build and display scaling unknown
family: responsive-comms
installer: unverified
recovery: unconfirmed
---

# Conversation crowded on short laptop windows

## Symptom

A customer screenshot shows the question form occupying most of COMMS, with large nested choice cards and limited room to read or respond. The screenshot alone does not establish the original viewport or display scaling.

## Repro

Run the seeded app at 1280x720 and render a conversation-mode Task Brief with two starting points. At baseline the 360px conversation panel wraps the choices heavily and spends horizontal space on two padded card frames. See `frontend/css/app.css:1202` and the layout regression driver `scripts/check-small-screen.mjs`.

## Evidence

Owner-provided screenshot, 2026-09-17. Local baseline and after screenshots plus geometry are recorded in `.dogfood/small-screen/` by `scripts/check-small-screen.mjs`. The driver uses the live seeded application and a representative question rendered through the production TaskConversation component; it does not represent a real model reply.

## Verdict

Source layout improved and verified in the isolated seeded app. Original customer configuration and installer recovery remain unverified; this closes the reproduced layout issue only.

## Regression

The same production question component at 1280x720 and STANDARD measured 535px tall inside a 360px COMMS panel before this stylesheet, versus 353px inside 486px afterward. All twenty window-size/text-size/expanded-state combinations passed actual geometry checks. Expand/Restore preserved 420px COMMS, 250px crew, crew visibility and an unsent draft. The sample starting point submitted and became a receipt. See `scripts/check-small-screen.mjs`, `.dogfood/small-screen/results.json` and `docs/SMALL_SCREEN_PREVIEW.md`.

## Sibling coverage

{"adapters":[{"target":"Browser and packaged WebView","state":"blocked","reason":"Owned headless Chromium live layout passed; the actual packaged Windows and macOS WebViews are not installer-verified in this lane."}],"entrypoints":[{"target":"Conversation question and COMMS expand control","state":"blocked","reason":"Live production-component submission and Expand/Restore passed in scripts/check-small-screen.mjs; this visual driver is not registered in the fast/http manifests, so automated gate coverage remains a gap."}],"displays":[{"target":"Small and short windows with enlarged text","state":"blocked","reason":"Twenty live viewport combinations passed at 100% and 145% text, but original customer resolution/OS scaling are unknown and the viewport driver is not a fast/http gate."}],"lifecycle":[{"target":"Expand/Restore and window resizing","state":"blocked","reason":"Live retained-width, crew visibility, draft and geometry checks passed; installed restart and cross-monitor display-scaling transitions remain unverified."}]}
