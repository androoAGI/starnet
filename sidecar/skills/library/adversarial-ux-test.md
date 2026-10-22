---
name: Adversarial UX Test
slug: adversarial-ux-test
description: Roleplay the hardest, most tech-resistant user, browse the app as them to find friction, then filter for real problems.
category: Engineering
requires: [dish]
license: MIT
default: false
---

Roleplay the worst-case user of a product — the person who hates technology and will find every reason to quit — then filter their complaints through a pragmatism layer so you keep the real UX problems and drop the "I hate computers" noise. An automated "mom test", but angry.

Use when the Commander says "run an adversarial UX test on [URL]", "be a grumpy user and test my app", or wants to find friction real humans hit.

## Why it works
Ordinary QA finds bugs; this finds **friction** — confusing terminology, too many steps, missing onboarding, empty-state dead ends, unreadable text, signup walls that kill conversion. A technically correct app can still be unusable.

## Step 1 — define the persona
If none is given, invent a specific one: who is the HARDEST user (age, non-technical role, does it "the old way"), their tech comfort (the lower the better), the ONE thing they need to do, what makes them give up, and how they talk when frustrated. It must be specific enough to hold character for the whole run. ("Big Mick, 58, uses WhatsApp and a paper notebook, needs to log results for 25 players, hates small text and passwords.")

## Step 2 — browse as them (browser tools)
Fully inhabit the persona and attempt their ACTUAL task, not a feature tour. Use `browser.navigate` / `browser.snapshot` / `browser.get_text` to move through the app and `browser.console` to catch JS errors on each page. Track: first impression (would they bother past the landing page?), the core workflow (how many clicks to the one thing?), error recovery, readability, speed vs. their old method, jargon, and whether they ever get lost.

## Step 3 — the rant (in character)
Write the feedback AS the persona — their voice, their frustration. Not a bug report; a real human venting at each pain point, with where it happened.

## Step 4 — the pragmatism filter (the point)
Now step out of character and triage each complaint: **real problem** (a genuine person would hit this) vs. **noise** ("I just hate computers"). Keep only the real ones. For each, write an actionable ticket: the friction, where, who it blocks, and a concrete fix. Don't add a "print this page" button just because the persona fears PDFs.

*Uses Agent OS's browser tools — needs the DISH object.*
