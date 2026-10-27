---
fingerprint: 29c1cf0c
slug: imported-skill-support-files-are-delivered-and-p
title: Imported skill support files are delivered and persisted as base64 text
surface: skills
severity: P1
status: fixed
found: 2026-10-27
lane: contribution/skills
fix: eac484af
origin: customer
report: https://github.com/androoAGI/starnet/issues/145
affected: v0.13.5, Linux browser mode
family: skill-package-encoding
installer: unverified
recovery: unconfirmed
---

# Imported skill support files are delivered and persisted as base64 text

## Symptom

Imported support text is shown as base64 in skill.view. Editing the installed skill writes that base64 representation into its support files, including binary assets.

## Repro

1. Import a package with SKILL.md, references/notes.md containing UTF-8 text, and assets/sample.bin containing non-UTF-8 bytes.
2. Load it through skill.view and inspect the reference text.
3. Patch its body, then compare both support files on disk with their original bytes and load the skill again.

## Evidence

`node test/skills.package-hardening.test.js` fails five assertions before the fix: decoded delivery, binary labeling, both disk byte comparisons, and delivery after hydration. The same suite passes all 31 assertions with the fix. Existing guard tests still withhold a package whose support file requires approval.

## Verdict

The tool now decodes valid UTF-8 after approval checks, and the mirror writes bytes according to each file's encoding. The regression passes at the sidecar boundary; installer delivery and the reporter's recovery are not confirmed.

## Regression

The imported-support-files scenario in `test/skills.package-hardening.test.js` uses the real exchange, store, package mirror, gate and skill.view tool. It covers UTF-8 and binary content before and after editing. Decoding happens after gate verification; stored approval inputs are unchanged.

## Sibling coverage

{
  "adapters": [{"target":"skill package exchange","state":"covered","test":"test/skills.package-hardening.test.js","scenario":"imported text and binary support files survive a body edit","gate":"fast"}],
  "entrypoints": [{"target":"skill.view","state":"covered","test":"test/skills.package-hardening.test.js","scenario":"UTF-8 delivery and labeled binary content before and after hydration","gate":"fast"}],
  "displays": [{"target":"packaged desktop","state":"blocked","reason":"No installer or desktop UI retest was performed; the repair is verified at the sidecar tool boundary."}],
  "lifecycle": [{"target":"persist and hydrate","state":"covered","test":"test/skills.package-hardening.test.js","scenario":"support bytes remain unchanged after editing the installed body","gate":"fast"}]
}
