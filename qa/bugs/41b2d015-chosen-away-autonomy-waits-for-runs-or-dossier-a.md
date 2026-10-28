---
fingerprint: 41b2d015
slug: chosen-away-autonomy-waits-for-runs-or-dossier-a
title: Chosen away autonomy waits for runs or dossier areas before acting (usage unlock on the onboarding path)
surface: autonomy
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: 2a2596397
origin: audit
---

# Chosen away autonomy waits for runs or dossier areas before acting (usage unlock on the onboarding path)

## Symptom

At the awakening's "while you're away, how much should i run on my own?" a new Commander picks "Quietly do small jobs" (or "Run free"). The station answers: "While you're away I'll do up to 3 small jobs a day… I'll start once I've seen a few of your runs or learned a little more about you." The setting they chose stays off until the station has 4 recent runs or 4 known dossier areas. There is no setting that lifts the hold. The onboarding lane brief (state 5) says any grind, unlock or usage requirement found on this path is filed as P1 even when it looks deliberate.

## Repro

1. Fresh station, WAKE, deep or short conversation; answer briefly.
2. At "while you're away…" pick "Quietly do small jobs — each one a new session".
3. Read the next line, then `GET /api/nightshift/status` (readiness tier cold).

## Evidence

Live (station ORBIT, 2026-10-20): `While you’re away I’ll do up to 3 small jobs a day; each arrives as a new session in your rail. I’ll start once I’ve seen a few of your runs or learned a little more about you.`

Source: `frontend/app/nightreport.js:286` readinessPlain; the bar is `frontend/app/autopilot.js:44` `const HOT_MIN = 4` and `frontend/app/autopilot.js:71` `const ACTIVITY_HOT_MIN = 4`, surfaced by `sidecar/index.js:8297`.

This is a deliberate design: `docs/AUTONOMY_DRIVER_PLAN.md` §2 "Earn context, then act" (locked with Andrew). `docs/DECISIONS.md` also locks "full power from minute one, and no grind/unlock/usage walls". The two locked decisions conflict here, so this needs the owner's ruling (keep the hold as a safety floor with an override, or `wontfix`). The copy is truthful; the question is only whether the hold is allowed.

## Verdict

Fixed on agent/p1-41b2d015 (a5152c59e, 9f9ade258, a559b3bd6, 2a2596397), not merged and not walked live. Owner ruling (0.14 ship calls, 2026-10-22): "Fix all six before release" for the open P1s, this one included.

The chain: a5152c59e moved the act floor from "goals + 4 dossier areas, or 4 recent runs" to one fresh grounded aim or one recent user run (`frontend/app/autopilot.js` `HOT_MIN` / `ACTIVITY_HOT_MIN` = 1). On review, that commit also let one `seed` goals belief make the station hot: the canned "Code & build" chip (`onboarding.js:120`) or a thin run's synthesis, while the same snapshot's shared V3 verdict said `no-direction`. The follow-up 9f9ade258 restores the trust line (AUTONOMY_DRIVER_PLAN §2 "only confirmed beliefs cross the acting line"; `dossier.js` WEIGHTS). `Autopilot.readiness` now counts the goals keystone only from its non-seed beliefs, and freshness comes from their own stamps. A seed-only goals area is warm, so the idle EARN branch still fires there.

A second review found the awakening itself still labelled every mind-reply BELIEF line `synth`: a thin run's read (`thin:true`, nothing typed) and the dig reply after "Help me figure that out" could write a model-invented goals line as grounded, and that one line made the station hot. a559b3bd6 labels each write by what the Commander gave (`onboarding.js` `upsertSynthBeliefs`): the read's lines are `synth` only when they gave anything, a dig's only once a turn holds a typed answer, and the mirror (which only runs on their words) stays `synth`. Ungrounded lines land as `seed` and are never inked; the thin read's STACK line follows the same rule.

A third review found the fallback mission question still lost typed words: quick setup, the keyless wake and a talk whose synthesis timed out or could not be parsed all ask `fallbackPurposeStep`, and a typed answer there only committed purpose.md (a `seed`), so the posture held right after the Commander typed what they want. It also found the hold copy had become false ("I’ll start once I know what you want help with" after they said it; "the station has nothing of yours" beside "the aims it has for you are too old to act on"). 2a2596397 lands a typed purpose (`askStep`: typed, or not one of the chip values) as a `stated` goals belief before purpose.md commits, so the doc seed dedupes; a tapped chip stays a seed. The readiness binding phrase is now one sentence true in every hold (nothing known, seed-only aim, stale aims, other areas only): "the station has no current aim or recent run to ground a job on — tell it in your own words what you want help with now, or run one task". `readinessText` says "it has no aim it can act on yet" (or that the aims are too old), and the plain hold names the requirement.

What a new Commander sees now: anything they type at the awakening (an answer, a correction of the synthesis, or the mission question on any path, quick setup included), or a synthesis of their words they confirm, makes the chosen "Quietly do small jobs" / "Run free" posture act with zero runs. One recent run does the same. Only when they give no words of their own (a tapped chip, a thin run, help with nothing typed) does the hold stay, as the trust line (AUTONOMY_DRIVER_PLAN §2: only confirmed beliefs cross the acting line), and it says exactly what lifts it: "I’ll start once you tell me in your own words what you want help with, or I’ve seen one of your runs." No count, no grind: one sentence or one task.

`test/nightshift-chosen-autonomy.test.js` drives the real DossierStore snapshot, the real `commanderPosture` / `nightshiftPrecheck` / `nightshiftReadinessView` from `sidecar/index.js`, and the real driver. Chip and doc seeds stand down pre-spend; synth and stated aims fire. Before 9f9ade258 there were 11 failures (the chip fired); after, it is OK. `test/autopilot.test.js` pins the seed rule: 4 failures before, OK after. Its section 6 runs the real `onboarding.js` short conversation against a stubbed brain into the real DossierStore and gates that snapshot: a thin run and a help-only run hold (warm, no beat, no leash spent); help-then-words and own words act. Before a559b3bd6 there were 9 failures (the thin and help-only runs fired); after, it is OK. 2a2596397 adds the real quick setup (typed purpose acts; the "Code & build" chip holds), a short talk with an unparseable synthesis (the typed fallback mission acts), and the stale panel (the why line beside `readinessText`): 12 failures before, OK after. `test/nightreport.test.js` pins the readiness phrase in all four non-hot states (10 failures before, OK after), and `test/onboarding-refresh.test.js` pins that quick setup files only the typed mission, as `stated`.

Reconciled 2026-10-27 (reliability wave 1, quick win 37): all four commits (`a5152c59e`, `9f9ade258`, `a559b3bd6`, `2a2596397`) are ancestors of trunk and first released in v0.14.0; "not merged" no longer holds. No live walk is recorded here.
