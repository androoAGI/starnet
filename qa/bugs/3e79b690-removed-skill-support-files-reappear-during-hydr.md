---
fingerprint: 3e79b690
slug: removed-skill-support-files-reappear-during-hydr
title: Removed skill support files reappear during hydration
surface: skills
severity: P2
status: fixed
found: 2026-10-27
lane: contribution/skills
fix: 0a86ee8f
origin: customer
report: https://github.com/androoAGI/starnet/issues/145
affected: v0.13.5, Linux browser mode
family: skill-package-removal
installer: unverified
recovery: unconfirmed
---

# Removed skill support files reappear during hydration

## Symptom

`remove_file` updates the stored skill, but leaves the file in the package mirror. The next view hydrates it from disk and delivers it again.

## Repro

1. Create a local skill with two support files, or import a package with a support file.
2. Remove a support file through `skillStore.manage`.
3. Inspect the package directory, view the skill, and reopen the store from its saved log.

## Evidence

`test/skills.package-removal.test.js` fails eight assertions before the fix: removed files remain on disk, return during hydration and after restart, and cannot leave an empty support-file list. After the fix all 24 assertions pass, including append-failure and link-target preservation checks.

## Verdict

The package mirror rebuilds its supported directories from the accepted record. Root-level files remain intact. Source behavior is verified; installer delivery and reporter recovery remain unconfirmed.

## Regression

The registered fast test exercises local and imported skills through the real store and package mirror, replays the durable log, checks that remaining files survive, and removes the last file. A refused append preserves disk contents. Symlink and hardlink targets outside the package remain untouched.

## Sibling coverage

{
  "adapters": [{"target":"local and imported packages","state":"covered","test":"test/skills.package-removal.test.js","scenario":"remove one or the last support file while retaining the skill and root-level files","gate":"fast"}],
  "entrypoints": [{"target":"skillStore.manage remove_file","state":"covered","test":"test/skills.package-removal.test.js","scenario":"accepted removal reconciles the mirror; failed append preserves files","gate":"fast"}],
  "displays": [{"target":"packaged desktop","state":"blocked","reason":"No installer or desktop UI retest was performed; verification uses the real sidecar store and disk mirror."}],
  "lifecycle": [{"target":"hydrate and restart","state":"covered","test":"test/skills.package-removal.test.js","scenario":"deleted files stay absent after view and durable-log replay","gate":"fast"}]
}
