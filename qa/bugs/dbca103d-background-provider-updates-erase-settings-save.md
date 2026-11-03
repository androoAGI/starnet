---
fingerprint: dbca103d
slug: background-provider-updates-erase-settings-save
title: Background provider updates erase settings save receipts
surface: providers
severity: P2
status: fixed
found: 2026-11-03
lane: spend-governor-1103
fix: 67d74dffe
origin: audit
---

# Background provider updates erase settings save receipts

## Symptom

An asynchronous provider status update can erase the confirmation or error from a runtime-limit save, or replace fields while the user edits them. Effective-limit labels and values also ran together in a narrow settings pane.

## Repro

Open APP & BACKUP in a seeded real station, hold the actual Claude account-list response, save a runtime limit, then release that response. scheduleSettingsRepaint previously rebuilt the entire settings console, detaching wireAdvanced's live form and message. The external spend-s5-preview.mjs fixture holds only the synthetic station's browser response and makes no generation calls.

## Evidence

gen-trees/_logs/codex-overnight-1103/spend-s5-refresh-old2.log is the deterministic original failure: the provider refresh removes the saved form/receipt. spend-s5-refresh-current.log passes that same real-app check plus actual HTTP500 disk refusal, unchanged disk/live limit, confirmed readback on reopen, two actual payer groups and zero model calls. Screenshot/DOM/API evidence is in spend-s5-refresh-current/. Six affected files pass in spend-ui-followups-02.log, including test/provider-connections-ui.test.js, test/settings-p1-ui.test.js, test/settings-save-failure.test.js and test/effective-limits.test.js. Earlier fixture errors and stale source expectations remain in the numbered logs; no product failure is attributed to those.

## Verdict

Source-fixed in 67d74dffe. Background status refresh rebuilds only the existing provider pane and rewires its controls, preserving other live pane controllers and receipts. The provider pane still refreshes while hidden. Deliberate settings actions retain their existing full rebuild. Scoped layout rules separate effective labels, values and pending restart values; actual screenshot and geometry checks pass. This is isolated real browser/host evidence, not installed-build or live-provider acceptance. Combined gates remain pending.
