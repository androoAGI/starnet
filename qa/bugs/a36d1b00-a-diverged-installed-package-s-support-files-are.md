---
fingerprint: a36d1b00
slug: a-diverged-installed-package-s-support-files-are
title: A diverged installed package's support files are mirrored to disk and shown to the model as base64 text
surface: skills
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/skills
fix: 0661095d8
origin: audit
---

# A diverged installed package's support files are mirrored to disk and shown to the model as base64 text

## Symptom

After an installed package diverges (the Commander edits it), its support files are written back to disk and shown to the model as base64 text instead of their real content: `references/setup.md` on disk becomes a line of base64.

## Repro

1. Install a package with a text support file `references/setup.md`.
2. Patch the SKILL.md body as the Commander (the package diverges).
3. Read `references/setup.md` from the skill's on-disk package and preload the skill against a capturing mock provider.

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b) (same before and after bd449b81b):
- `[S1.diverge.disk] QmVmb3JlIGFueXRoaW5nIGVsc2UsIHBhc3RlIHRoaXMgY29tbWFuZCBpbnRv` (the file's text, base64-encoded, written as the file content)

Anchor: `sidecar/skills/package.js:261` maps envelope files to `{ content: f.content, encoding: 'base64' }` and the write side writes `f.content` verbatim (`writeText(path.join(dir, f.path), f.content)`).

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

## Verdict

Fixed by the skills-canonical-bytes lane (2026-10-28; the fixing commit is the `fix:` field above). What was true:
`writePackage`'s diverged path wrote each support file's stored TEXT (`writeText(..., f.content)`), and every file of
an installed package is stored base64, so the mirror held a line of base64; `readSupportFiles` then read that text
back as the file and the model was shown base64. The same bug hit an authored skill's binary `write_file`, the export
of a diverged package, and the evaluation runner.

Closed as a family through one canonical-bytes boundary (`sidecar/skills/file-bytes.js`): the mirror writes
`FileBytes.bytesOf(f)`, the disk is read once into the one stored form, an untouched mirror delivers the record's own
entries (a mirror the pre-fix code wrote, holding the record's own base64 text, reads as the bytes it encodes and is
re-written as real bytes on the next write), and digests hash bytes rather than their stored string (existing
approvals are re-stamped at boot, nothing removed). With the store keeping exact bytes, a skill's text is scrubbed
where it leaves for a model or the station (every such seam passes prompt-scrub `scrubStored`).

Regression: `test/skills.roundtrip.property.test.js` — the repro as filed (section "a36d1b00": install a text
reference, patch the body as the Commander, read `references/setup.md` off disk and the preloaded block), a v0.14 save
with a base64-text mirror, and the byte round trip on every write and read path. It fails on the lane's base trunk
commit, including `a36d1b00: references/setup.md on disk ... got "QmVmb3JlIGFueXRoaW5nIGV..."`, and passes on the fix.
