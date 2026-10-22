---
name: Meme Generation
slug: meme-generation
description: Turn a topic into an actual meme image — pick a template, write tight captions, render the picture.
category: Creative
requires: [studio]
license: MIT
default: false
---

Make a real meme image from a topic: identify the core dynamic, pick a matching template, write captions that land, and generate the picture with `image_generate`.

Use when the Commander says "make a meme", "meme this", or wants a meme about a topic or frustration.

## Step 1 — find the dynamic
Read the topic and name what it really is: chaos/denial, an impossible dilemma, a preference, escalating irony, a plan backfiring, shutting down a bad idea. The dynamic picks the template.

## Step 2 — pick the template format
Match the dynamic to a classic layout and its text slots:
- **This Is Fine** (top/bottom) — chaos, denial.
- **Drake** (reject / approve) — rejecting one thing, preferring another.
- **Distracted Boyfriend** (distraction / current / person) — temptation, shifting priorities.
- **Two Buttons** (left / right / person) — an impossible choice.
- **Expanding Brain** (4 escalating levels) — escalating irony.
- **Change My Mind** (one statement) — a hot take.
- **One Does Not Simply** (top/bottom) — a deceptively hard thing.
- **Gru's Plan** (steps + realization) — a plan that backfires.

## Step 3 — write the captions
Short, punchy, specific to the topic. Meme text is compressed — cut every non-essential word. The joke is in the tension between the slots, not in explaining it.

## Step 4 — render
Call `image_generate` with a prompt that describes the chosen template composition AND places your exact caption text in each slot (e.g. "'This Is Fine' meme format, cartoon dog at a table in a burning room, top caption 'shipping on friday', bottom caption 'this is fine'"). Request a clean, legible, bold caption font. Save the .png to the workspace and show it to the Commander; offer one alternate caption if the first is soft.

*Uses Agent OS's `image_generate` — needs the STUDIO object.*
