---
fingerprint: 3ad3e2b8
slug: comms-report-lists-lose-plus-and-tab-separated-m
title: COMMS report lists lose plus and tab-separated markers
surface: channels
severity: P2
status: fixed
found: 2026-09-10
lane: agent/release-0112-audit-0910
fix: cb6c30b4d
origin: audit
---

# COMMS report lists lose plus and tab-separated markers

## Symptom

COMMS displays plus-prefixed bullets and tab-separated bullet/number markers as plain text. The same report using hyphens and spaces becomes a semantic list.

## Repro

1. Start an isolated app with `node dev/seed.js --keep` and enter COMMS.
2. Render an assistant report containing `+ First` and `+ Second`, each on its own line, through `Chat.renderProse`.
3. Repeat with a tab after a hyphen or a numbered marker.
4. Inspect the visible message body: the affected inputs produce zero list items; `- First` with a space produces two.

## Evidence

On integration source `00de68e0f`, the real seeded browser returned list-item counts 0, 0, 0, 2 for plus, hyphen-tab, number-tab and hyphen-space inputs. After the repair it returned 2, 2, 2, 2. Raw DOM outcomes are recorded in `qa/evidence/0.11.2-merge-audit/report-lists.json`.

`test/chat-code-copy.test.js` now exercises `renderProse`, including its shortcut, across five markers and two spacing variants. Before the repair six assertions failed; after it all 54 passed. The test remains in the normal fast manifest.

## Verdict

Source and seeded-browser repair verified; final gate and fix commit are recorded during audit finalization. No installed/customer recovery claim.

## Regression

The public renderer shortcut omitted plus markers, while the new report block parser required a literal space. The repaired gate accepts plus, and the parser accepts horizontal whitespace. Copy retains the exact original report bytes. Live and restored assistant messages share this renderer; group messages call the same public method. Text without list markers still uses the existing plain-text path. Installed desktop verification remains outstanding.
