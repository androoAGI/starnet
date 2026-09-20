---
fingerprint: 629c9bd7
slug: project-reopening-loses-crew-controls-and-can-mi
title: Project reopening loses crew controls and can mislabel or steal conversation focus
surface: sessions
severity: P1
status: fixed
found: 2026-09-20
lane: release-audit-0124-0920
fix: 4c09cec32d2000892c56d4388dc6374beb04baf1
origin: audit
---

# Project reopening loses crew controls and can mislabel or steal conversation focus

## Symptom

Reopening projects with identical crew preferences empties the crew chooser. Failed project opening can relabel the previous conversation, and a delayed open can steal focus after the user chooses another session.

## Repro

Create a specialist and two trusted projects with the same preferences. Open each project and inspect Crew, then reopen the first. Inject failure for the workspace request while a different project conversation is active. Finally delay the workspace response, select an ordinary conversation, and let the response finish. Also try opening a revoked project which has never had a conversation.

## Evidence

The real browser/sidecar probe in .qa_tmp/release-0124/project-live.mjs observed crew input counts [1,0,0] on the pre-fix controller. The repaired controller gives [1,1,1], preserves the title and active session during injected failure, and retains the explicitly selected session after a delayed response, with zero browser exceptions. test/project-home-ui.test.js first failed on each relevant pre-fix invariant. Source anchor: frontend/app/project-home.js open(), render(), and onSession(). The real browser also verified that a revoked project with no conversation leaves the prior title and active session intact and reports the missing conversation.

## Verdict

Live browser and real sidecar verified repeated opens, failed requests, revoked folders without conversations, and explicit session selection during delayed opens; zero browser exceptions.
