# ONBOARDING V3 — The Interview That Earns the Magic

**Status: RED-PEN DRAFT — every question's wording below is for Andrew's approval before code.**
Date: 2026-07-19. Author lane: `claude/onboarding-questions-update-7e28b3`.
Supersedes the interview beats of Interview 2.0 / Awakening 2.0 (`f9a061d`, `c575044d`). The birth
monologue (WakeMind.buildBirthScript) is NOT touched by this plan — it stays as shipped.

---

## 0. The diagnosis this plan answers

Andrew blitz-tested onboarding (clicked random preset chips) and got random, awful task
recommendations immediately after. Two distinct failures, both verified in code:

1. **Chip clicks write canned beliefs.** `onboarding.js:103-106` — clicking "Copy-pasting between
   apps" upserts the literal string *"Loses time copy-pasting data between apps that refuse to talk
   to each other"* into the dossier as a real belief. Generic, specific to nobody.
2. **The gates count beliefs, not knowledge.** `Pitch.shouldPitch` requires `MIN_KNOWN=2` dims and
   `goals` known (`pitch.js:52-62`); two blitzed chips satisfy it. Scout's cold-start lane buys a
   recipe off any "non-empty dossier" (`scout.js:144-147`). The harness acted confidently on
   context it did not have.

**The law this plan installs (Andrew, 2026-07-18):** the harness must model what it knows about
the Commander, KNOW when that isn't enough, refuse to recommend until it is, and actively close
the gap. Onboarding is the first and densest context-pursuit episode; the pursuit never stops.

## 1. The five locked pillars

1. **Extraction-first question craft (PLAIN-QUESTION LAW, Andrew 2026-07-20 — supersedes the old
   "scene register").** Every question is an extraction instrument: design it BACKWARDS from the
   dossier field it fills — target data → what a great answer looks like → wording that makes that
   answer the natural response on a single read. Literal words only: zero metaphors, zero poetic
   phrasing, zero decode-work. A misunderstood question produces a sideways answer that gets SAVED
   as grounded context and corrupts every downstream surface (synthesis, mirror, pitch, gate).
   Personality lives in ACK/reaction lines, NEVER in questions. Every question still passes the old
   hard rule: answerable concretely in one sentence without the user thinking hard. Regression-locked
   by test/onboarding.test.js (banned-shapes scan + PLAIN WORDS clause in every wakemind ASK spec).
2. **Chips steer, never answer.** Every chip is either live-model-generated from prior answers or a
   shape-example; clicking one NEVER writes a belief — it triggers a specifics-forcing follow-up.
   The dossier only ever receives beliefs synthesized from the user's actual words.
3. **Brain before interview.** The deep interview is a live-model activity, full stop. The create
   console already places THE BRAIN as the only required step, last, beside WAKE
   (`index.html:136`). If wake happens with no working brain (keyless degrade), the fake scripted
   interview is DELETED — replaced by a short honest holding beat + KeyCTA; the real interview
   fires on the first session after the brain comes alive.
4. **The gate.** Every proactive recommendation surface checks station readiness first. Below
   threshold: structurally OFF, not toned down. Above it: every pitch must be traceable to the
   specific beliefs that justify it. The magic moment is protected, never counterfeited.
5. **Hunt mode.** Below readiness, the agent's standing job is closing the gap: scene-based probes
   riding natural moments (session open, post-run, curiosity drip) — persistent, never repeated
   after rejection, always in the engaging register. Plus silent harvest from real work
   (worksignal, interests, study).

## 2. What already exists (grounded — build on, don't duplicate)

| Substrate | Where | Reuse |
|---|---|---|
| Dossier: 9 dims, belief records, provenance, compose block | `dossier.js` / `dossierstore.js` | unchanged shape; add belief **weight** (§5) |
| Per-dim confidence + VOI + probeTarget | `understanding.js` / `understandingstore.js` | becomes the gate's substrate |
| Interview beat loop, patience windows, tagged-line parse | `onboarding.js` (`askStep`, `mindWait`, `grab`) | the V3 flow reuses all of it |
| Live builders (pain/ambition/synthesis) | `wakemind.js` | replaced by the V3 builder set (§4) |
| Curiosity drip: CAP=1/session, ASK_LIMIT=2, MIN_WORK=3, persisted asked/dismissed | `curiosity.js` / `curiositystore.js` | hunt mode = a hungrier pre-readiness profile of this engine (§7) |
| Pitch/suggest/starter + familiarity cadence | `pitch.js` / `pitchstore.js` / `suggeststore.js` | re-gated on readiness (§6) |
| Work signals: lane EWMA + profile EWMA + interests | `worksignal.js`, `profile.js`, `sidecar/interests.js` | feed readiness corroboration |
| Declined-everything index | `sidecar/declinedindex.js` | hunt mode respects it |

## 3. The interview — beat-by-beat script (RED-PEN ZONE)

Voice: station voice — lowercase, eerie-not-cute, hungry to understand, never corporate.
Timing: deep path ≈ 6–8 min, 9–12 exchanges. Every generated beat degrades per the failure
doctrine in §8 (honest, never fake). All questions below are the EXACT proposed wording.

### B0 — STAKES (scripted, rewritten)
> "before anything else — a warning, or a promise. what you tell me in the next few minutes
> becomes my permanent operating file. i will act on it every day from here. vague in, vague out.
> give me the real thing and i will feel like i've known you for years."

*Writes nothing. Sets the give-to-get frame.*

### B1 — THE FORK (scripted chips, steering-only)
> "i can do this two ways. we go deep now — ten minutes, and i come out the other side knowing
> what to build for you. or we keep it loose and i figure you out as we go. your call."

- chips: `go deep — i'll give you the real answers` / `keep it loose — learn me as we go`
- **loose path** → jumps to B5 → B6 → B10 (three beats), writes belief
  `identity: "Chose to be figured out through the work, not an interview."` (source `onboarding`),
  readiness stays honestly LOW → gate stays shut → hunt mode carries the load. This is a
  first-class choice, not a skip.

### B2 — THE TUESDAY (identity/work · scripted question, shape-example chips)
> "paint me your tuesday. not the calendar version — the real one. where do the hours actually go?"

- shape chips (steering-only): `i run something` / `i work for someone` / `i make things on the
  side` / `i'm studying` — a click does NOT advance; it narrows the follow-up: e.g. `i run
  something` → "then paint me the shop's tuesday — what do YOU end up doing with your own hands?"
- free text is the primary path; placeholder: `the honest version…`
- **writes:** nothing yet — raw answer feeds B3.

### B3 — THE DIG (generated, 1–2 exchanges)
The model reads the tuesday answer and asks the single next-most-revealing question about it —
grounded in their actual words, with 3 generated chips that are *plausible specific answers for
this person* (still steering: picking one gets one confirm/expand micro-follow-up, never a raw
write). Builder: `buildDigReply` — returns `ACK / ASK / CHIPS / BELIEF*`. The BELIEF lines are
the model's synthesis of what it just learned (dims: `identity`, `stack`, `schedule`, `people`)
and upsert with source `onboarding` only when grounded in user words (§5 weight rules).
A second dig fires only if the coverage map says identity is still thin AND total elapsed < 4 min.

### B4 — THE COMPLAINT (pain · scripted question, generated chips)
> "now the part i exist for. what did you catch yourself complaining about this week — not the big
> stuff, the dumb recurring thing? the chore where YOU were the robot."

- chips: **generated from B2/B3** (`buildPainChips` inside the B3 call — 3 chores this specific
  person plausibly has). Fallback chips if the mind is quiet: the current three (copy-pasting /
  same email / hunting files) — but as steering only: a click asks "which apps? paint me the last
  time it happened." Nothing lands until they name the real one.
- **writes:** `pain` belief synthesized from their words by `buildPainReply` v3 (ACK + one
  grounded dig into the project BEHIND the chore → second belief to `identity` or `goals`).

### B5 — LOST TIME (desires/hobbies → goals/style)
> "different question. when you lose track of time — actually lose it, look up and it's dark out —
> what are you doing?"

- no chips except `skip`. This one works because it's effortless and it mines what the user
  LOVES, which is where long-term direction hides and where "what agents could do for me"
  recommendations get their warmth.
- **writes:** synthesized belief to `goals` (the pull) and/or `style`.

### B6 — THE YEAR (ambition/vision · the signature question)
> "last big one. say i work for you for a year. free. tireless. i don't sleep and i don't quit.
> what exists at the end of that year that doesn't exist right now?"

- chips: `honestly — no idea yet. let's find out` (→ writes
  `ambition: "Direction open — wants the station to help discover what to build."`, readiness for
  `ambition` marked LOW-BY-CHOICE, hunt mode inherits) / 2 generated chips from B2–B5 (*this
  user's* plausible year-outcomes, steering-only).
- **writes:** `ambition` beliefs via `buildYearReply` (ACK + one dig into the concrete shape:
  "what's the first thing a stranger would see of it?").
- This question does triple duty: extracts the long-term vision, TEACHES what the product is,
  and makes the user feel the magic mid-interview.

### B7 — THE MIRROR (generated · the possibility-space teacher)
The agent reflects back who it now thinks the user is — then makes 3–4 OFFERS: concrete,
grabbable things it could actually do, each traceable to a belief it just formed.
> "okay. here's what i think i'm looking at. [READ]. and here's what i could take off you,
> starting tonight: [OFFERS]"

- offers are chips: grab (`that one. yes.`) / more (`what else?` — one regeneration) / redirect
  (`none of these — here's what i actually want…` free text, which is itself premium signal).
- **This is where users who don't know what AI can do, find out** — by being tempted with their
  own life. Reactions write: grabbed → `goals` belief + a **delegation-candidate note** (feeds
  First Pitch/starter so the first real recommendation is one they already wanted); rejected →
  recorded, never re-pitched (declinedindex).
- Builder: `buildMirror` — `READ / OFFER×4 / BELIEF*`. Every OFFER line must cite the belief ids
  it grew from (§6 traceability); unparseable/ungrounded offers are dropped, never shown.

### B8 — THE READ (kept from Interview 2.0, now richer)
Synthesized purpose + confirm/adjust (`that's me` / `let me put it my way`) → `purpose.md`
(→ `goals` seed), exactly the current `commit({purpose})` path. The read now draws on B2–B7.

### B9 — CADENCE (unchanged)
The current autonomy-posture question stays verbatim (`onboarding.js:137-149`) — it's a setting,
not context, and its chips are honest presets.

### B10 — THE PROOF (closing beat, replaces "i'm yours to point")
If a delegation candidate was grabbed in B7: the agent ends by SHOWING it listened —
> "then here's my first move: [the grabbed offer, sharpened into one honestly-doable starter].
> say the word and i start."
This rides the existing `offerStarter`/`starterChoices` machinery, now fed by the interview
instead of a cold dossier. Rich interview → magic on minute nine. Loose path → the honest close:
> "then i watch, i learn, i ask. give me a week of real work and i'll know you better than a
> form ever could."

## 4. Engine work (wakemind v3)

New builders in `wakemind.js`, same directive/tagged-line/`grab` pattern, same char caps
discipline, all reason-only `internal:true` via the existing `llmCall`:

- `buildDigReply {tuesday,name}` → `ACK / ASK / CHIPS(3) / BELIEF*`
- `buildPainReply` v3 `{pain,tuesday,digs,name}` → `ACK / ASK / BELIEF*` (+ `buildPainChips` folded into the B3 response as `PAINCHIP×3`)
- `buildYearReply {year,everything,name}` → `ACK / ASK / BELIEF*`
- `buildMirror {allAnswers,capabilities,name}` → `READ / OFFER×4(with belief-id citations) / BELIEF*`
- `buildSynthesis` v3 — extended context, same `READ/PURPOSE/STACK` contract
- `BELIEF` line format: `BELIEF <dim>: <text>` — parser validates dim against `Dossier.DIMS`,
  clamps to 280, drops anything not traceable to a user answer in the transcript it was given.

Interview state machine stays in `onboarding.js` (`runLeadMeeting` v3): same patience windows +
patter, same ceilings (30s/40s), one added global budget — soft cap ~8 min, after which the
flow skips optional digs and goes to B7.

## 5. The knowledge model — beliefs with weight

Additive change to `dossier.js` (belief record gains optional fields; no renames):

- `weight: 'stated' | 'synth' | 'observed' | 'seed'` — stated = user's own words; synth =
  model-synthesized from user words (all V3 interview writes); observed = study/worksignal;
  seed = doc-seeded. **Canned strings can no longer exist** — the chip-value write path is
  deleted outright.
- `Understanding` (already per-dim conf) treats weight as evidence quality; blitzing now yields
  an empty map because nothing writes without real words.

## 6. THE GATE — readiness, enforced structurally

**One shared predicate**, frontend `understanding.js` (new pure fn) + mirrored server-side via
the existing `/api/autonomy/posture` beliefs snapshot:

```
ready = knows(goals|ambition) AND knows(pain OR identity) AND familiarity ≥ 0.33
knows(dim) = ≥1 belief with weight stated|synth|observed  (seeds don't count)
```

(Defaults — observable and tunable, see §9. `familiarity` = existing `Dossier.summary()`.)

| Surface | Today's gate | V3 gate |
|---|---|---|
| First Pitch / offerAtHandoff (`pitch.js:52`) | MIN_KNOWN=2 + goals known | `ready` + directive must cite belief ids; parse drops uncited pitches |
| offerStarter (`pitchstore.js:164`) | fires on cold dossier | allowed BELOW ready only when fed by a grabbed B7 offer; otherwise quest-pointer |
| Ongoing suggestions (`pitch.js:76`) | familiarity delta + cooldowns | AND `ready` |
| Scout cold-start (`scout.js:144`) | dossier non-empty | dossier `ready` (server-side mirror) |
| Quest refresh (`questrefresh.js:108`) | daily cadence | AND `ready`; below it, emits at most a context-quest ("tell me your tuesday") |
| Night-shift proposals (`nightshift.js:96`) | posture/leash/readiness | readiness gate now uses the shared predicate |
| Session-opener PITCH chip (`starters.js:39`) | dossier-grounded | AND `ready`; below it the slot becomes a hunt probe (§7) |

**Traceability law:** any surface that generates a recommendation passes the belief snapshot in
its directive and must get back citations; a pitch that can't say why it fits THIS user does not
fire. (Extends the existing `probe` mechanic in `pitch.js:113`.)

## 7. HUNT MODE — below the gate, the agent closes the gap

A pre-readiness profile of the existing curiosity engine (no new engine):

- While `!ready`: `MIN_WORK` floor waived (it may ask from session one — the interview may have
  been loose/blitzed), session cap 2 (not 1), and the ask surfaces widen: curiosity drip +
  session-opener slot + one post-run beat.
- Questions come from a rewritten bank: `interview.js` `QUESTIONS` are ALL re-authored in the
  scene register of §3 (current ones are form-questions in a costume — e.g. `stack` becomes
  *"what's open on your screen right now? that's the honest answer."*; `people` becomes *"who's
  waiting on something from you this week?"*). When the brain is live, probes are generated off
  `Understanding.probeTarget()` (highest-VOI thin dim) instead of the static bank.
- Discipline that keeps "almost forcing" from becoming lying-to-make-it-stop: persisted
  asked/dismissed state is honored exactly as today (`curiositystore`), a rejected question is
  never re-asked (reEnable stays the manual escape hatch), and every probe rides a natural
  moment — no cold pop-ups.
- Silent harvest continues regardless: worksignal lanes, profile EWMA, interests, study — all
  already corroborate `understanding` confidence. Real work raises readiness without a single
  question; the gate opens the moment the station honestly knows enough, whichever road got it
  there.

## 8. Failure doctrine (stranded-user law applied)

- **No brain at wake:** no fake interview. Holding beat: *"i can't do this part with a dead
  wire. wire my mind and i'll ask you the real questions."* + KeyCTA armed. Interview auto-offers
  on the first brainReady session (one-shot, declinable → hunt mode).
- **Call fails mid-interview (key present):** patience windows as today; on hard failure the
  agent owns it in-voice, banks everything already learned, falls to the next SCRIPTED beat
  (B4→B5→B6 spine works scripted; digs/mirror are the live-only parts), and hunt mode inherits
  the unfilled dims. purpose.md ALWAYS lands (fallbackPurposeStep survives as the last resort).
- **User walks away mid-interview:** answers land as they're given (per-beat upserts, already
  true); no all-or-nothing.

## 9. Tuning knobs — set principled, keep observable

`ready` thresholds, hunt session cap, mirror offer count, interview soft budget: all constants
in one place (`understanding.js` / `curiosity.js` headers), each surfaced in the existing
understanding/dossier panel readout so live onboarding tests can see WHY the gate is open/shut
(truthful telemetry applies to the gate itself). Expect tuning after real onboardings — nobody
can reason their way to 0.33.

## 10. Slices (each independently verifiable live)

1. **S1 — kill the poison:** chip-value writes deleted; chips become steering (follow-up
   required); belief `weight` added; blitz test = dossier ends EMPTY. *(small, ships alone)*
2. **S2 — the gate:** shared `ready` predicate + all seven surfaces re-gated + traceability in
   pitch directives. Blitz test = zero recommendations anywhere, honest panel readout.
3. **S3 — interview v3:** B0–B10 + wakemind v3 builders + tests (wakemind.test / onboarding.test
   extended; every question wording source-locked).
4. **S4 — hunt mode:** curiosity pre-readiness profile + interview.js bank rewrite + probe
   generation off probeTarget.
5. **S5 — brain-gating + proof beat:** keyless holding path, first-brainReady offer, B10 starter
   wiring.

Done, per slice = observable behavior in the live app (onboard-fresh launcher, port 8812, real
provider key) + `npm run test:fast` green. Final acceptance = Andrew's two walkthroughs: a rich
interview that ends in a starter he'd actually run, and a blitz run that ends with a quiet,
curious agent and an empty-but-honest dossier — and NOT ONE recommendation until it's earned.

## 11. Open questions for Andrew (red-pen along with the wording)

1. B1 fork copy — comfortable offering the "loose" path this prominently, or should deep be the
   default with loose as the quiet second chip?
2. B7 mirror — offer count (3 vs 4) and whether "what else?" regeneration is once or twice.
3. Hunt persistence — session cap 2 below readiness: push harder (3?) or is 2 right?
4. `ready` recipe in §6 — sign off the shape (thresholds stay tunable).
