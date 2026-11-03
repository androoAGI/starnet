---
fingerprint: 562c293e
slug: voice-init
title: Voice.init (agent focus / persona change / dossier apply) calls reflectToggle without clearing fbNotified, permanently wiping the pinned degrade tooltip while t
surface: voice
severity: P1
status: fixed
found: 2026-07-28
lane: sweep/voice
fix: 50a8b07b
---

# Voice.init (agent focus / persona change / dossier apply) calls reflectToggle without clearing fbNotified, permanently wiping the pinned degrade tooltip while t

## Symptom

Voice is failing and the speaker toggle honestly reads '🔇 real voice offline — voice provider out of credits · reply shown as text'. The user switches agents, edits a persona, or applies a dossier change. The tooltip silently reverts to 'agent voice: ON — click to mute' and stays there for the rest of the outage, while every reply continues to be silent. The app now asserts the voice is on and gives the user no way to find out why the station stopped talking — exactly the 2026-07-07 escape the fbMsg machinery was built to prevent (the code comment at :117 names it).

## Repro

rig: /api/tts always fails with 'openrouter 402 — insufficient credits; edge: edge timeout'. Voice.speak() → tooltip = '🔇 real voice offline — voice provider out of credits · reply shown as text'. Call Voice.init({name:'Tester', personaId:'professional'}) as app.js does → tooltip = 'agent voice: ON — click to mute'. Two further failed replies → tooltip still 'agent voice: ON — click to mute'.

## Evidence

`frontend/app/voice.js:1117`

**Mechanism (read from the code):** The degrade reason is pinned by writing directly to the element: `if (toggleBtn) toggleBtn.title = fbMsg;` (line 154). reflectToggle overwrites that same property unconditionally: `toggleBtn.title = speakReplies ? 'agent voice: ON — click to mute' : …` (line 1117). Every path that CLEARS the reason first calls clearNeuralCold() (toggleSpeakReplies:1151, setSpeakReplies:1159) so it stays consistent — but `init()` calls reflectToggle() at line 1189 without touching fbNotified/fbMsg. app.js calls Voice.init on agent focus (app.js:2873), on persona change (app.js:412) and on dossier apply (app.js:340). Because noteFallback early-returns on `if (fbNotified === cls …) return;` (line 147), the reason is never re-pinned for the remainder of that outage class. The state that says 'already told them' outlives the message that told them.

**Existing test coverage:** test/voice.button.test.js:184-192 asserts the tooltip IS pinned on a degrade, but the test never calls Voice.init a second time, so the wipe is outside its reach.

**Adversarial verdict (survived refutation):** Confirmed end to end. The reason is pinned by a direct property write at voice.js:154 (`if (toggleBtn) toggleBtn.title = fbMsg;`), and reflectToggle:1117 overwrites that same property unconditionally (`toggleBtn.title = speakReplies ? 'agent voice: ON — click to mute' : …`). init() calls reflectToggle() at 1189 and touches neither fbNotified nor fbMsg — it calls stopSpeaking() (1176), clears forcedSpeak (1177) and resets prewarmedFor (1206), but never clearNeuralCold(), which is the ONLY function besides noteNeuralOk:159 that resets fbNotified (161). Contrast the paths that DO clear the reason: toggleSpeakReplies:1151 and setSpeakReplies:1159 both call clearNeuralCold() before reflectToggle(), so they stay consistent — init is the outlier. noteFallback:147 then early-returns on `if (fbNotified === cls || …) return;`, so the same outage class never re-pins for the rest of the outage, and prewarmVoice:211 is also skipped while the cold-off holds. The three app.js call sites are real: app.js:340 (dossier apply), :412 (persona change), :2873 (agent focus) all call Voice.init with a fresh name/personaId. voice.button.test.js:184-192 asserts the pin but never calls Voice.init a second time, so the wipe is outside its reach. Raising to P1: the speaker tooltip is the ONLY sanctioned channel for voice-outage telemetry (voice.js:135-140 forbids #chat-status per Andrew 2026-07-13), so wiping it permanently reproduces the exact 2026-07-07 escape the fbMsg machinery was built for — the station goes silent asserting 'agent voice: ON' with no way for the user to find out why.

_Found by the `sweep/voice` lane, 2026-07-28. Finder confidence: high. Severity claimed P2, after refutation P1._

## Verdict

Confirmed as found. 50a8b07b fixed it inside reflectToggle, which covers every redraw rather than init alone: while the speaker is on, a pinned degrade reason outranks the plain on/off copy. `test/voice.button.test.js` pins that Voice.init keeps the reason and that a deliberate toggle still clears it.

The family was the speaker's many paths, each running its own subset of what a change needs: clear the cold-off and the degrade reason, silence speech, put the speech note away, warm the stock lines and redraw the key. Six writers saved or flipped the speaker, and init redrew it without clearing. The voice-reply-handles-and-speaker-lease lane closes the family. setSpeaker is now the speaker's one transition, and every writer goes through it: the key, /voice, hands-free, Local Live, every session teardown and Voice.init. Every change runs one fixed effect list in one order, so no path can skip a step another path takes. A transition that leaves the speaker as it was, like Voice.init over a speaker the Commander turned on, keeps a pinned reason.

The class invariant is `test/voice-speaker.property.test.js` (I2). It drives seeded sequences of every speaker writer, Voice.init and a reload included, and checks after every step that the saved setting is the Commander's last explicit choice, that a muted speaker shows no speech note and no ON tooltip, and that `frontend/app/voice-state.js` is the key's only writer. On the lane's base the saved-setting and one-writer laws broke in every sequence; the muted-speaker law already held there. The on side, a pinned reason surviving a redraw, rests on reflectToggle's guard and stays pinned by `test/voice.button.test.js`.
