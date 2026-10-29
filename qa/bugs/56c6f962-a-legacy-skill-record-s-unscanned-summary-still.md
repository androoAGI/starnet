---
fingerprint: 56c6f962
slug: a-legacy-skill-record-s-unscanned-summary-still
title: A legacy skill record's unscanned summary still rides the prompt index
surface: skills
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/skills
fix: 161e234f0
origin: audit
---

# A legacy skill record's unscanned summary still rides the prompt index

## Symptom

A legacy skill record saved before the guard existed has its BODY withheld, but its unscanned summary is still written into the skill index of every run, so text that never passed the scanner reaches the model on each turn.

## Repro

1. Write a skill record into the store without any guard verdict (the pre-guard legacy shape) whose summary carries a marker string.
2. Start a run and capture the composed system prompt at a mock provider.
3. The body is withheld (`withheldNotice:true`, body marker absent) but the summary marker is in the index.

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b) (same before and after bd449b81b):
- `[S1.legacy.preload] {"withheldNotice":true,"bodyNeedle":false,"indexSummaryNeedle":true}`

Anchor: the index builder in `sidecar/skills/runtime.js` (around line 145) prints a summary for rows not marked held; a legacy record is withheld at preload but not marked held in the index.

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

## Verdict

Fixed by the skills-canonical-bytes lane (2026-10-28; the fixing commit is the `fix:` field above). What was true: a
record saved before the guard existed carries no verdict and no stamp; `skills/gate.js verify()` scans it at delivery
(so the body was withheld), but the prompt index decides from metadata (`decide()`), saw no verdict, and printed the
summary no scan had covered.

The store now judges such a record at load, in RAM only (`skillstore.js settleLoaded`, nothing written; `markUsed`
still persists it on first use), so the index names and withholds it exactly as the delivery seam does, and a clean
legacy record keeps its (now scanned) summary. A scan that fails is no verdict: a record the scanner cannot judge
(it throws) asks, in RAM, and `verify()` asks for its body too, where it used to return the metadata decision
(allow); an approval of exactly those bytes still releases them. The same census found two more unscanned
prompt-bound fields (a skill's platforms, a support file's path) and an ungated prompt surface (the background review
and curator prompts listed every summary); all are fixed in the same commit.

Regression: `test/skills.scan-census.test.js` — section B (a legacy record with a flagged body, one with a flagged
summary, one clean; nothing written at load; and with a scanner that throws, the record asks, its summary is
withheld from the index and its body asks at delivery) and section A (the field census). It fails on the lane's base trunk
commit, including the three 56c6f962 assertions, and passes on the fix.
