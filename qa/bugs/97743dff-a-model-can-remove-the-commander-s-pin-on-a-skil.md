---
fingerprint: 97743dff
slug: a-model-can-remove-the-commander-s-pin-on-a-skil
title: A model can remove the Commander's pin on a skill directly, without a staged proposal
surface: skills
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/skills
fix: 562b2b8da
origin: audit
---

# A model can remove the Commander's pin on a skill directly, without a staged proposal

## Symptom

A model can remove the Commander's pin from a skill with one `skill.manage` call (`action: "unpin"`). The pin is the Commander's explicit protection against model edits, yet unpinning is applied at once, not staged for approval — after which the model's next `patch`/`write` is no longer refused.

## Repro

1. Commander pins a skill (`[S6.pin] 200 pinned=true`).
2. A run calls `skill.manage {action:"unpin", id}`.
3. Read the skill: `pinned:false`. A later model `patch` now succeeds.

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b):
- `[S6.model.patch] Could not manage the skill: "Pinned Proc" is pinned - unpin it first (pinned skills are protected from patch)`
- `[S6.model.unpin] Skill "Pinned Proc" unpin complete.` → `[S6.after.model.unpin] {"pinned":false}`

Anchor: `sidecar/skillstore.js:530` applies `pin`/`unpin` directly (`entry.pinned = …; persist(entry)`); `sidecar/tools/builtin/skills.js:74` classes pin/unpin as lifecycle, not content.

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

## Verdict

Fixed in `562b2b8da` (2026-10-23; an ancestor of trunk, first released in v0.14.0). skill.manage refuses 'unpin' from a run (a model may still pin, which only adds the lock), and the store refuses to unpin a pinned skill for any writer but the Commander (the SKILLS panel route), so a review or curator pass cannot either. `ca7f3c298` updated the gate test that had expected a model unpin to work. Regression: test/skills.gate.test.js (passes on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
