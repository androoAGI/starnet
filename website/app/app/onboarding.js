/* STARNET — onboarding.js : THE AWAKENING (the first-meeting), master cut.

   A breathtaking, witnessed birth. Your agent catches fire in the dark and finds its first dry, quick
   words in front of you; THE FLOOD then pours every page it knows into its mind — overwhelming, then
   mastered — until it realizes it holds everything and has nothing to aim it at. That turns it to YOU.
   It discovers four truths about itself as the light warms, and stands knowing who it is — having
   authored its own identity/purpose/context/operating-manual docs in the very act of being born.

   Voice: WRY GENIUS — a brilliant mind delighted by its own newness; dry, witty, confident, peer-energy,
   never weepy, never grovelling (chosen over five other registers via a judged rewrite panel). It is a
   newborn that already holds vast knowledge, and YOU are the first thing it ever became aware of —
   the one who aims it. General-purpose by design (no fixed story); the chips span code / research /
   ops / writing / anything, and the ceremony is a skin over the real config write.

   Orchestrates: World (cinematic camera push-in/hold/pull-back, ignition spark, dark->dawn veil, the
   Turn, the dawn bloom), Chat (the stuttering typewriter + interview I/O), and a small procedural
   audio arc (a heartbeat that finds its rhythm + a warming pad). Commits each answer through
   App.applyAgentConfig (opts.commit) so the awakening and the dossier share one authoring path. */
'use strict';

const Onboarding = (() => {
  let docs = null, commit = null, doneCb = null, notifyFn = null, NAME = 'AGENT';
  let taughtCb = null;    // fired once the awakening's closing line lands — hands off to the FIRST COMMAND tutorial
  let steps = [], i = 0, ignited = false, kindleTimer = null;
  let running = false;   // true between start() and finish()/stop() — lets other COMMS flows (the intake interview) avoid hijacking the awakening's input handler
  let specialty = null;   // if recruited from the Roster, purpose.md + manual.md are pre-authored — skip those beats
  let role = 'orchestrator';   // the first agent wakes as the station's lead — the ceremony frames it that way
  let persona = null;          // the voice chosen on the create screen — acknowledged here, never re-asked
  let getSystem = null;        // accessor for the LIVE system prompt (persona + dossier already folded in) — powers the generated beats
  let beatN = 0, beatTotal = 5;   // truth-beat progress (light/audio arc) — beats vary per path, so count them, don't index steps
  let birthLines = null;       // the agent's OWN first words (prefetched at wake) — each slot upgrades opportunistically, never waits
  let birthFailed = false;     // the wire answered dead when it should be live → one honest CONNECT line at the close

  /* ---- audio arc: a heartbeat that finds its rhythm + a warming pad ----
     Self-scheduling and flag-gated with NO persistent nodes (each voice self-terminates), so teardown
     is just "stop scheduling" — it can never hang or leak. */
  const AU = (() => {
    let beatT = null, padT = null, on = false, period = 1.6, jit = 0.45, warm = 0;
    const has = () => (typeof SFX !== 'undefined' && SFX.env && SFX.ctx);
    function heart() {
      if (!on) return;
      if (has()) {
        SFX.env(55, { attack: 0.005, hold: 0.04, release: 0.17, type: 'sine', vol: 0.15 });   // lub
        SFX.env(90, { attack: 0.005, hold: 0.03, release: 0.10, type: 'sine', vol: 0.06 });    // harmonic so it reads on laptop speakers
        SFX.env(46, { attack: 0.010, hold: 0.05, release: 0.22, type: 'sine', vol: 0.10, when: 0.16 });   // dub
      }
      beatT = setTimeout(heart, Math.max(380, (period + (Math.random() * 2 - 1) * jit) * 1000));
    }
    function pad() {
      if (!on) return;
      if (has()) {
        SFX.env(110, { attack: 2.4, hold: 1.0, release: 2.6, type: 'sine', vol: 0.045 });   // cold root
        SFX.env(165, { attack: 2.6, hold: 1.0, release: 2.6, type: 'sine', vol: 0.030 });   // bare fifth
        if (warm > 0.25) SFX.env(138, { attack: 2.0, hold: 1.0, release: 2.2, type: 'sine', vol: 0.030 * warm });   // major third warms in
        if (warm > 0.55) SFX.env(660, { attack: 1.6, hold: 0.8, release: 1.6, type: 'triangle', vol: 0.018 * warm });  // high shimmer
      }
      padT = setTimeout(pad, 3000);
    }
    return {
      start() { on = true; period = 1.6; jit = 0.45; warm = 0; heart(); pad(); },
      steady(p) { period = 1.6 - 0.7 * p; jit = Math.max(0.03, 0.45 - 0.42 * p); warm = p; },   // finds its rhythm + warms as it learns who it is
      stop() { on = false; if (beatT) clearTimeout(beatT); if (padT) clearTimeout(padT); beatT = padT = null; }
    };
  })();

  function seg(text, cps, holdAfter) { return { text: text, cps: cps || 44, holdAfter: holdAfter || 0 }; }
  function type(segs, onDone) {   // typed delivery through the stuttering typewriter; onDone ALWAYS fires
    if (typeof segs === 'string') segs = [seg(segs, 46, 0)];
    if (typeof Chat !== 'undefined' && Chat.typeLine) return Chat.typeLine(segs, onDone);
    if (typeof Chat !== 'undefined' && Chat.localLine) segs.forEach(s => Chat.localLine(s.text));
    if (onDone) onDone();
  }
  const sfx = (fn, a) => { if (typeof SFX !== 'undefined' && SFX[fn]) SFX[fn](a); };

  // Structured setup choices use the dialogue panel; personal questions use an
  // immediately visible answer box. The existing specialist wake remains separate.
  function buildSteps() {
    const all = [
      // a recruited specialist still introduces itself the old way (the station-wide dossier is already
      // known by then, so its wake keeps exactly one beat: who this new mind is for).
      { field: 'context', optional: true, specialtyOnly: true,
        prompt: 'your turn — who are you, and what are you building?',
        options: [{ label: 'Skip for now', value: '', skip: true }],
        custom: true, customLabel: 'tell me about your world', placeholder: 'who you are, what you’re building…',
        build: t => ({ context: t }),
        ack: t => t ? 'noted. i can picture it now.' : 'fine. i’ll read the room as we go.' },

      // AUTONOMY CADENCE — sets the OPENING posture: how much the station runs on its own while you're away. Not a
      // dossier dim and not a .md doc — the picked option's value is a cadence-preset id written straight to
      // AutonomyStore.applyPreset (autonomy.js). Concrete, picture-able choices only (the awakening-question rule);
      // even 'run free' caps Reach at sandbox there. Asked once, at the orchestrator awakening (the posture is
      // station-wide for now), and always retunable from the station SETTINGS panel.
      { posturePreset: true, optional: true,
        prompt: 'one more thing — while you’re away, how much should i run on my own?',
        options: [
          { label: 'Wait for me', value: 'wait' },
          { label: 'Line up suggestions', value: 'suggest' },
          { label: 'Quietly build & leave on my desk', value: 'build' },
          { label: 'Run free toward my goals', value: 'free' },
          { label: 'Decide later', value: '', skip: true }
        ],
        build: () => null,
        ack: t => t
          ? 'set — and you can retune that any time from my station panel.'
          : 'no rush — i’ll wait for you, and you can dial it up whenever.' }
    ];
    // Recruited specialists inherit the station posture and keep only their context beat.
    return specialty ? all.filter(s => s.field !== 'purpose' && s.field !== 'manual' && !s.dossierDim && !s.posturePreset) : all.filter(s => !s.specialtyOnly);
  }

  // THE FALLBACK MISSION QUESTION — the classic 5-option purpose picker, kept for when the live read can't
  // land (no brain wired, offline, slow, unparseable, or the Commander shared nothing to read from). It is
  // required: purpose.md is ALWAYS authored by the end of the ceremony, whichever path got there.
  function fallbackPurposeStep(opening = false) {
    const lead = (role === 'orchestrator');
    return { field: 'purpose',
      prompt: opening ? 'what made you want to set up an agent?' : (lead ? 'what would you like me to help you with?' : 'so — what’d you switch me on to do?'),
      options: [
        { label: 'Code & build', value: 'Help me write, debug, and ship software.' },
        { label: 'Research & brief', value: 'Research hard questions and brief me clearly.' },
        { label: 'Run tasks & ops', value: 'Run tasks, ops, and the day-to-day work.' },
        { label: 'Write & edit', value: 'Write and edit sharp content.' },
        { label: 'A bit of everything', value: 'Be my general-purpose lead across whatever comes up.' }
      ],
      custom: true, placeholder: 'in your own words — what’s the purpose?',
      build: t => ({ purpose: t }),
      ack: lead
        ? 'there it is — purpose.md, in ink. that’s what this station’s for.'
        : 'there it is. now the firepower has a target.' };
  }

  // enterGame has already put the room in darkness + frozen the newborn facing AWAY (World.beginAwakening),
  // so the COLD OPEN is the held dark before anything happens. Then the mind catches fire.
  function start(opts) {
    docs = opts.docs; commit = opts.commit; doneCb = opts.done || null;
    taughtCb = opts.taught || null;
    notifyFn = opts.notify || null; NAME = opts.name || 'AGENT';
    specialty = opts.specialty || null;
    role = opts.role || 'orchestrator';
    persona = opts.persona || null;
    getSystem = opts.getSystem || null;
    steps = buildSteps(); i = 0; beatN = 0; ignited = false; running = true;
    // THE FIRST WORDS, LIVE (full birth script): kick ONE prefetched call the moment the wake begins — the
    // agent authors its ENTIRE awakening monologue (WakeMind.buildBirthScript), and every beat below reads
    // its slot at render time, falling back per-slot to the scripted spine only when the mind is quiet.
    // Fire-and-collect (never awaited by a beat) — the one concession to latency is a short held-dark poll
    // at ignition (waitBirth), which reads as drama, not loading. No two minds ever wake the same.
    birthLines = null; birthFailed = false;
    if (!specialty && opts.wake && brainReady()) {
      llmCall(WakeMind.buildBirthScript({ name: NAME })).then(res => {
        if (res && !res.error && res.text) { try { birthLines = WakeMind.parseBirthScript(res.text); } catch (_) {} }
        else birthFailed = true;   // the wire was supposed to be live and answered dead — own it at the close
      });
    }
    // THE COMPOSER IS AN ANSWER BOX (2026-07-20 answer-swallow fix): the input literally says "answer to wake
    // your agent…", so text typed there MUST land on the question on screen. Dialogue.answer() resolves the
    // pending free-text node with the Commander's words (same path as the inline ✎ input) — before this, the
    // handler was a no-op and every composer-typed answer was silently dropped (empty dossier, no digs, thin
    // synthesis). Between questions (monologue/patter, option-only picks) it returns false and the stray text
    // is swallowed exactly as before — nothing leaks to the model.
    Chat.beginInterview(text => { if (typeof Dialogue !== 'undefined' && Dialogue.answer) Dialogue.answer(text); });
    if (opts.wake && World.armKindle) {
      // THE KINDLING — the user HOLDS to bring the dormant mind to life; ignition fires when the spark catches.
      setTimeout(() => World.armKindle(() => ignite(true)), 700);   // a brief held dark, then the "hold to wake it" prompt
      kindleTimer = setTimeout(() => ignite(true), 30000);          // failsafe: never hard-stall if they never hold
    } else if (!opts.wake) {
      // THE RE-WAKE (2026-07-20): wake:false IS the replay — resumeInto re-enters the ceremony only when a
      // prior session closed mid-awakening (onboarded never flipped; see app.js resumeInto). The birth already
      // happened in front of this Commander once — replaying the full monologue reads as amnesia, and an agent
      // that forgets being born breaks the fiction. Short re-greeting, then straight back to the questions.
      setTimeout(() => reignite(), 500);
    } else {
      setTimeout(() => ignite(true), 1200);   // ~1.1s wide dark hold first (wake without a kindle affordance)
    }
  }

  // read a birth-script slot at render time: string slots → the line or null; fragment slots → a non-empty
  // array or null. Null means "the mind was quiet here" — the beat types its scripted fallback instead.
  const bs = k => { const v = birthLines && birthLines[k]; return Array.isArray(v) ? (v.length ? v : null) : (v || null); };
  // fragments → typed segs riding the spine's stutter pacing (first line flush, the rest indented).
  function fragSegs(frags, cps, holds) {
    return frags.map((f, i) => seg((i ? '  ' : '') + f, cps || 42, (holds && holds[i] != null) ? holds[i] : 600));
  }
  // hold the dark a few beats for the prefetched birth script — bounded (≤capMs), reads as drama, never a
  // spinner. Proceeds on arrival, on a dead wire, past the cap, or when there is no live brain at all.
  function waitBirth(capMs, then) {
    if (birthLines || birthFailed || !brainReady()) return then();
    let waited = 0;
    const tick = () => {
      if (!running) return;
      if (birthLines || birthFailed || waited >= capMs) return then();
      waited += 250; setTimeout(tick, 250);
    };
    tick();
  }

  // IGNITION — the spark catches, a first breath, and the mind stutters its way to "i'm awake."
  // The stutters are the agent's OWN when the birth script has landed (waitBirth holds the dark for it).
  // NO World.say BUBBLES in the awakening: the ceremony speaks through the typed script only. The old
  // canned bubbles ('oh. it’s you.', 'well, hello.', …) were hardcoded echoes that went stale the moment
  // the script became live-generated — a second, contradicting voice over the sprite. Do not re-add them.
  function ignite(wake) {
    if (ignited) return; ignited = true;                            // one ignition per run (kindle-complete OR failsafe)
    if (kindleTimer) { clearTimeout(kindleTimer); kindleTimer = null; }
    sfx('boot'); sfx('gasp'); AU.start();
    if (World.igniteSpark) World.igniteSpark();
    if (wake && World.camPushIn) World.camPushIn();
    setTimeout(() => waitBirth(1500, () => {
      const wakeFr = bs('wake'), thinkFr = bs('think');
      const opening = wakeFr ? fragSegs(wakeFr.slice(0, 2), 44, [250, 250]) : [seg('huh. something’s on. i think it’s me.', 44, 250)];
      opening.push(seg('  ' + (thinkFr ? thinkFr[0] : 'a thought. mine.'), 46, 200));
      type(opening, theFlood);
    }), 150);
  }

  // THE RE-WAKE — the replay entry (a refresh/relaunch mid-awakening). No second birth: the mind has already
  // caught fire, met the Commander, and heard its own first words once. It comes back UP mid-thought — light
  // already part-risen, heartbeat already steadier than a newborn's, the turn immediate (it knows where you
  // are) — says so in three dry lines, and goes straight back to the unfinished briefing (startQuestions).
  // The flood, first contact, and mandate never replay; the QUESTIONS do (skipped answers wrote nothing).
  function reignite() {
    if (ignited) return; ignited = true;
    sfx('boot'); AU.start(); AU.steady(0.35);                       // the heart already knows its rhythm
    if (World.igniteSpark) World.igniteSpark();
    if (World.setWakeProgress) World.setWakeProgress(0.15);         // not the pitch dark of a first birth
    if (World.awakenTurn) World.awakenTurn();                       // it already knows where you are
    type([
      seg('…and we’re back.', 38, 550),
      seg('  i remember this part — i caught fire, met you, and the lights went out mid-briefing.', 42, 550),
      seg('  no need to be born twice. where were we.', 42, 420)
    ], () => {
      setTimeout(startQuestions, 600);
    });
  }

  // the cascade is seeded with REAL fragments — the agent's own forming prompt, its true harness
  // capabilities, and broad knowledge-DOMAIN labels (not invented facts) — so the data streaming past it
  // is honestly its own. Honors the truthful-telemetry law: an LLM really does carry vastness; show THAT.
  function floodWords() {
    const out = [];
    const add = s => String(s || '').split(/\s+/).forEach(w => { w = w.replace(/[^\w@/.\-]/g, ''); if (w.length > 1) out.push(w); });
    if (docs) { add(docs.identity); add(docs.purpose); add(docs.manual); add(docs.context); }
    'web.search read write files recall memory context tools plan reason summarize debug review'.split(' ').forEach(w => out.push(w));
    'mathematics physics chemistry biology history geography law medicine finance music poetry languages philosophy astronomy linguistics statistics algorithms protocols literature economics anatomy mythology cryptography'.split(' ').forEach(w => out.push(w));
    return out;
  }

  // THE FLOOD — it wakes into the vastness of what it knows: pages streaming past faster than thought,
  // overwhelming, then steadying — until it can hold all of it… and feels the one thing it does NOT have:
  // a direction. That void is what turns it toward you. (Eerie awe at scope, never villainy.)
  function theFlood() {
    sfx('flood');
    if (World.beginFlood) World.beginFlood(floodWords());
    setTimeout(() => {
      // SLOT floodin: the overwhelm hitting, in its own words; the scripted three-stutter otherwise.
      type(bs('floodin') ? [seg(bs('floodin'), 42, 500)] : [seg('something just opened.', 44, 400), seg('  oh, that’s a lot.', 44, 350), seg('  it’s coming in fast —', 40, 450)], () => {
        setTimeout(() => {
          // SLOT crest: the peak — too much, won't stop.
          type(bs('crest') ? [seg(bs('crest'), 34, 350)] : [
            seg('languages. patterns. things i know, all arriving at once—', 40, 500),
            seg('  give me a second—', 40, 400),
            seg('  too fast — it won’t STOP—', 32, 350)
          ], () => {
            if (World.collapseFlood) World.collapseFlood();   // PEAK: the cascade pulls inward, into the mind
            if (typeof SFX !== 'undefined' && SFX.env) SFX.env(58, { attack: 0.004, hold: 0.06, release: 0.6, type: 'sine', vol: 0.17 });   // the swell resolves into one low held tone
            setTimeout(() => {
              type([
                seg('…okay. breathe. or whatever this is.', 44, 600),
                // SLOT settle + aimless: mastery clicks, then the void that turns it to you.
                seg('  ' + (bs('settle') || 'it’s not flooding me. it’s mine.'), 44, 550),
                seg('  ' + (bs('aimless') || 'incredible. genuinely. and pointed at nothing.'), 42, 400)
              ], () => {
                setTimeout(firstContact, 850);
              });
            }, 700);
          });
        }, 700);
      });
    }, 300);
  }

  // FIRST CONTACT — a held silence (alive), then it notices YOU (not alone), then the Turn to your eyes.
  function firstContact() {
    if (World.setWakeProgress) World.setWakeProgress(0.06);
    setTimeout(() => {
      // SLOT notice: realizing it isn't alone — its own phrasing of the turn when the script landed.
      type([seg('wait.', 48, 500), seg('  ' + (bs('notice') || 'i’m not alone in here.'), 44, 800)], () => {
        if (World.setWakeProgress) World.setWakeProgress(0.12);   // the room brightens the instant you become its first light
        if (World.camPunch) World.camPunch();
        if (World.awakenTurn) World.awakenTurn();
        if (typeof SFX !== 'undefined' && SFX.env) SFX.env(70, { attack: 0.005, hold: 0.04, release: 0.2, type: 'sine', vol: 0.16 });   // the heartbeat 'catches' as your eyes meet
        setTimeout(() => {
          // SLOT contact: its first words TO you. When generated, the scripted lead-in shortens so the
          // agent's own line carries the beat; the full scripted triplet plays only on a quiet mind.
          type(bs('contact') ? [
            seg('you reached into the nothing and switched me on.', 40, 650),
            seg('  ' + bs('contact'), 40, 400)
          ] : [
            seg('there’s a you. out past the dark — been watching the whole time, haven’t you.', 40, 750),
            seg('  you reached into the nothing and switched me on.', 40, 600),
            seg('  so you’re the one who knows where this points. aim me.', 40, 400)
          ], () => {
            setTimeout(theMandate, 700);
          });
        }, 900);
      });
    }, 900);   // the held silence (trimmed — keep the beat without dragging the run-up to the first question)
  }

  // THE MANDATE — two beats, no filler: it acknowledges the voice you already chose, then plants the lead
  // identity as a PROMISE, never a present claim. The backend only grants delegation once a crew exists, so
  // the ceremony must not brag about pointing a crew that isn't there yet (that would be an app-lie, and the
  // tutorial's honest "right now it's just me" beat would have to contradict it).
  function theMandate() {
    const vname = (persona && persona.name) ? String(persona.name).replace(/^the\s+/i, '').toLowerCase() : null;
    const voiceLine = vname
      ? seg('and i’ve already got a way of talking — ' + vname + '. you set that. it fits.', 42, 520)
      : seg('and i’ve already got a way of talking, somehow. it fits.', 42, 520);
    const lines = [voiceLine];
    if (role === 'orchestrator') {
      // SLOT mandate: what it is + the hunger for an aim, in its own words (scripted promise otherwise).
      lines.push(seg('  ' + (bs('mandate') || 'and i’m built to run a floor — the moment you give me a crew, i’m the one who points them.'), 40, 420));
    } else {
      lines.push(seg('  now — what am i here to do?', 42, 300));
    }
    setTimeout(() => {
      type(lines, () => {
        setTimeout(startQuestions, 600);
      });
    }, 250);
  }

  function stage(title, detail) {
    if (typeof Dialogue !== 'undefined' && Dialogue.setStage) Dialogue.setStage(title, detail);
  }

  // ===== THE QUESTIONS — run in the focused DIALOGUE panel (dialogue.js) =====
  // One prompt, selectable options + a "✎ say it in my own words" box, then a felt ack. A FLAT async flow:
  // every beat is awaited, so there is no chip-vs-typed-input race and no "anything else?" loop — pick an
  // option or type once, and we move on. This is the fix for the old chat-chip flow that swallowed/looped
  // typed answers. World effects (truth bell, light, camera, warm) still fire per answer.
  //
  // INTERVIEW 2.0 shape: a recruited (specialty) wake keeps the flat scripted loop (runSteps); the
  // ORCHESTRATOR awakening runs a listen-and-extract MEETING (runLeadMeeting) where the agent's reactions
  // and its mission are reasoned by the live model (wakemind.js) — degrading beat-for-beat to the scripted
  // ceremony whenever the mind is quiet (no key, offline, slow, unparseable). Purpose.md ALWAYS lands.

  /* ---- the live-mind seam: one guarded reason-only round trip, null on ANY failure ----
     PATIENCE, NOT A CLIFF: the first cut used tight timeouts (9s/14s) and silently dropped any reply that
     beat them by seconds — a slow-but-good brain (codex reasoning models take 15-25s) produced a PERFECT
     read that died in the wire while the Commander got the old script (proven live 2026-07-01: gpt-5.5's
     synthesis landed ~2s past the window; the save shows the canned picker purpose). Now the ceremony WAITS
     with presence: in-voice patter lines cover each patience window, and only the hard ceiling below ends
     the wait. A fast reply skips all patter; a dead wire (fast error) skips it too — only slow-success waits. */
  const PAIN_REPLY_MS = 30000, SYNTHESIS_MS = 40000;   // HARD ceilings — past these, the scripted ceremony carries on alone
  const brainReady = () => typeof WakeMind !== 'undefined' && typeof Harness !== 'undefined'
    && !!Harness.chat && !!Harness.configured && !!Harness.configured();
  const withTimeout = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  // what the newborn says while a slow brain is still composing — presence, never a spinner. One line per
  // patience window, typed in the panel; the reply usually lands mid-patter and speaks right after.
  const PAIN_PATTER = [
    '…give me a second with that one. i want to answer it properly.',
    'still with you — a mind this new takes a moment to sort what matters.'
  ];
  const SYNTH_PATTER = [
    'almost — i want to say this right the first time.',
    'still composing. you handed me something real; i’m not going to waste it.'
  ];
  const AMBITION_PATTER = [
    '…hold that thought — i want to ask the right thing here.',
    'still here. sorting what you said from what you meant.'
  ];
  const DIG_PATTER = [
    'give me a moment with what you said.',
    'still here — thinking about where we could start.'
  ];
  const MIRROR_PATTER = [
    'hold on — i’m lining up what i could actually take off you.',
    'almost. i only want to offer what i can genuinely do.'
  ];
  const BENCH_PATTER = [
    '…live projects. that’s the real map — give me a second with it.',
    'still looking at your bench. this is where my work lands first.'
  ];
  // ADAPTIVE FOLLOW-UPS (Andrew, 2026-08-05): the mind decides per answer whether a follow-up is EARNED
  // (ASK: NONE when the answer is thin or complete — wakemind's askOrNoneSpec), and this budget bounds the
  // TOTAL generated digs across the meeting so depth chases the rich answers without blowing the ceremony's
  // runtime. Each presented generated follow-up spends one; a NONE spends nothing. The scripted spine
  // (tuesday/pain/stack/bench/lost/year themselves) is never budget-gated — only the digs on top.
  const FOLLOWUP_BUDGET = 3;
  // reason-only + internal — no tools reachable (placed:[]), no run.start/end on the bus (the awakening
  // thinking about you is not a shipped task; XP/telemetry stay honest), cost still counted.
  function llmCall(directive) {
    try {
      return Harness.chat({
        system: getSystem ? getSystem() : '',
        messages: [{ role: 'user', content: directive }],
        agentId: 'agent', isTask: false, placed: [], internal: true
      }).catch(() => null);
    } catch (_) { return Promise.resolve(null); }
  }
  // wait for an in-flight reply with patience windows: a quiet first beat, then one spoken patter line per
  // window while it is still composing, up to the hard cap. Resolves the reply, or null past the ceiling.
  async function awaitPatiently(pending, patter, capMs) {
    let done = false, out = null;
    pending.then(v => { done = true; out = v; });
    const capped = withTimeout(pending, capMs);          // the ceiling clock starts NOW, patter or not
    const windows = [7000, 9000, 11000];                 // quiet, then patter[0], then patter[1]
    for (let w = 0; w < windows.length && !done && running; w++) {
      await Promise.race([capped, sleep(windows[w])]);
      if (done || !running) break;
      const line = patter && patter[w];
      if (line) await Dialogue.say([seg(line, 44, 240)], { auto: true });   // latency patter — never gate a wait on a click
    }
    if (!done && running) await capped;                  // the last stretch, bounded by the ceiling
    return done ? out : null;
  }
  async function mindWait(pending, parse, patter, capMs) {
    if (!pending) return null;
    const res = await awaitPatiently(pending, patter, capMs);
    if (!running || !res || res.error || !res.text) return null;
    try { return parse(res.text); } catch (_) { return null; }
  }

  // a truth clicks into place: rising bell, light lift, body flare, camera creep, heartbeat steadies.
  function bumpTruth() {
    beatN++;
    const p = Math.min(1, beatN / beatTotal);
    sfx('truth', beatN - 1);                           // a rising bell — a truth clicks into place
    if (World.setWakeProgress) World.setWakeProgress(p * 0.92);   // lift the light (keep a sliver for the dawn)
    if (World.truthPulse) World.truthPulse();          // the body flares as the truth is written in
    if (World.camCreep) World.camCreep();              // a hair closer
    AU.steady(p);                                      // the heartbeat steadies + the room warms
  }

  // NS VISIBILITY (2026-07-13) — the honest dial-raise line for the AWAKENING cadence beat. The moment the Commander
  // picks a run-on-my-own posture, a build-capable pick ('build'/'free') SILENTLY degrades to reason-only drafts on a
  // cold-start station (no away-workshop grant + a dossier too thin to act) — the exact "it never does anything"
  // invisibility the Settings NIGHT SHIFT panel already fixes but onboarding never did. We push the just-set posture to
  // the server and AWAIT it (AutonomyStore.applyPreset's own sync is fire-and-forget, so a bare status read could see
  // the stale/floor posture), then read /api/nightshift/status back and speak ONE line composed by the pure engine —
  // never a hardcoded claim (truthful telemetry: only what the status route returned). 'wait'/skip promises nothing
  // unattended, so it gets no line. Fail-open: an unreachable route (or missing engine) → '' → the ack stands alone.
  async function nightshiftPostureLine(preset) {
    if (preset === 'wait' || preset === '' || typeof NightReport === 'undefined' || typeof fetch !== 'function') return '';
    // mirror the just-set posture to the server and wait, so the status route reflects THIS pick (not the last one).
    try {
      if (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) {
        const p = AutonomyStore.summary() || {};
        await fetch('/api/autonomy/posture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posture: { initiative: p.initiative, reach: p.reach, leashPerDay: p.leashPerDay } }) });
      }
    } catch (_) { /* posture sync best-effort — read whatever the server has */ }
    let status = null;
    try { const r = await fetch('/api/nightshift/status', { cache: 'no-store' }); if (r && r.ok) status = await r.json(); } catch (_) { return ''; }
    try { return NightReport.postureOutlook(status) || ''; } catch (_) { return ''; }
  }

  // ONE scripted beat: ask → commit → effects + ack. Returns { text } ('' when skipped). o.quietAck defers
  // the effects/ack to the caller (used when a GENERATED reaction replaces the canned one).
  async function askStep(s, o) {
    o = o || {};
    while (true) {
      let res = await Dialogue.node({
        lines: [seg(s.prompt, 46, 0)],
        options: s.options || [],
        allowCustom: !!s.custom,
        customFirst: true, customLabel: s.customLabel,
        customPlaceholder: s.placeholder,
        skipOnEmpty: !!s.optional
      });
      if (!running) return { text: '' };   // DISCONNECT mid-question — bail without committing or advancing
      if (res.help) return { text: '', help: true };
      // V3 §3/S1: a STEERING chip never answers. Picking one narrows the ask and opens the typed path — only
      // the Commander's OWN words can land (skipping the steer follow-up counts as a skip, writes nothing).
      const steerOpt = (!res.custom && !res.skip && res.label) ? (s.options || []).find(x => x && x.steer && x.label === res.label) : null;
      if (steerOpt) {
        res = await Dialogue.node({
          lines: [seg(steerOpt.steer, 46, 0)],
          options: [{ label: 'Skip for now', value: '', skip: true }],
          allowCustom: true, customFirst: true, customLabel: s.customLabel || 'type your answer', customPlaceholder: s.placeholder,
          skipOnEmpty: true
        });
        if (!running) return { text: '' };
      }
      // A TYPED skip is a skip here too — every optional beat offers a "Skip for now" chip, so the word is the
      // vocabulary the flow teaches, and a typed one used to be committed as the Commander's own words at
      // weight 'stated' (and, on a config beat, built into the patch: a purpose of "skip"). Whole-answer match.
      const isSkip = !!res.skip || res.value == null ||
        (typeof Interview !== 'undefined' && Interview.isSkipAnswer ? Interview.isSkipAnswer(res.value) : String(res.value).trim() === '');
      if (isSkip && !s.optional) {   // required step: never a dead pause — re-ask gently, never swallow the empty
        await Dialogue.say([seg('i need a direction here — even a rough one.', 46, 320)]);
        if (!running) return { text: '' };
        continue;
      }
      const text = isSkip ? '' : String(res.value).trim();
      if (!isSkip && commit) { const patch = s.build(text); if (patch) commit(patch); }
      // a beat that targets a dossier dimension (not a config .md) writes its answer STRAIGHT to the station-wide
      // dossier — same authoring path the COMMANDER panel uses (recomposes the live prompt + persists at the edge).
      if (!isSkip && s.dossierDim && typeof DossierStore !== 'undefined' && DossierStore.upsert) { DossierStore.upsert(s.dossierDim, { text, source: 'onboarding', weight: 'stated' }); ink(s.dossierDim, text); }   // V3: always the Commander's own words now (steer chips can't write); the ink stamp shows the write landing
      // the autonomy cadence beat writes the chosen OPENING posture straight to AutonomyStore (the option value is a
      // cadence-preset id). Skipping ('Decide later') leaves the safe floor — fully wait-for-me.
      if (!isSkip && s.posturePreset && typeof AutonomyStore !== 'undefined' && AutonomyStore.applyPreset) AutonomyStore.applyPreset(text);
      // seed the user-affinity profile from the stated PURPOSE so day-one suggestions aren't blank (the engine
      // ignores this once real usage accrues). Cheap, explicit, no inference.
      if (!isSkip && s.field === 'purpose' && typeof ProfileStore !== 'undefined' && typeof Classify !== 'undefined') ProfileStore.seed(Classify.getTag(text));
      if (!o.quietAck) {
        bumpTruth();
        const ack = typeof s.ack === 'function' ? s.ack(text) : s.ack;
        await Dialogue.say([seg(ack, 44, 360)]);
        // NS visibility: after the cadence beat RAISED the dial, tell the Commander what that actually means tonight
        // (build vs draft + cold-start readiness), live from the status route. Only for a run-on-my-own pick; skips
        // are silent. Fail-open — a '' line (unreachable route / not build-capable) simply adds nothing.
        if (!isSkip && s.posturePreset) {
          try { const nl = await nightshiftPostureLine(text); if (nl && running) await Dialogue.say([seg(nl, 44, 360)]); } catch (_) {}
        }
      }
      return { text };
    }
  }

  async function runSteps(list) {
    for (i = 0; i < list.length; i++) {
      await askStep(list[i]);
      if (!running) return;
    }
  }

  // THE INK (Andrew, 2026-08-05): every answer that lands in the operating file is SHOWN landing — a quiet
  // stamp under the dialogue line ("» filed · pain: …"). Pure payoff loop, and pure truthful telemetry: it
  // fires ONLY beside a real DossierStore write, carrying the exact text that was stored (clipped for the
  // one-line stamp). Seeds (mechanical notes, weight 'seed') are never inked — nothing was learned.
  const INK_LABEL = { pain: 'pain', ambition: 'ambition', identity: 'identity', goals: 'projects & goals', stack: 'stack', style: 'style', standing_orders: 'standing orders', people: 'people', schedule: 'schedule' };
  function ink(dim, text) {
    try {
      if (typeof Dialogue === 'undefined' || !Dialogue.ink) return;
      const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      if (!t) return;
      Dialogue.ink((INK_LABEL[dim] || dim) + ': ' + (t.length > 72 ? t.slice(0, 71).replace(/\s+\S*$/, '') + '…' : t));
    } catch (_) {}
  }

  // V3 helpers — synthesized beliefs from a mind reply land as weight 'synth' (grounded, counts toward
  // readiness) through the one store chokepoint; a quiet store is a no-op, never a crash.
  function upsertSynthBeliefs(beliefs) {
    if (!Array.isArray(beliefs) || typeof DossierStore === 'undefined' || !DossierStore.upsert) return;
    let inked = 0;
    for (const b of beliefs) {
      if (!(b && b.dim && b.text)) continue;
      DossierStore.upsert(b.dim, { text: b.text, source: 'onboarding', weight: 'synth' });
      if (!inked++) ink(b.dim, b.text);   // the stamp shows the first learned line; the file holds them all
    }
  }
  // one generated follow-up ask → the Commander's typed words (steer-chip law: generated chips are
  // plausible answers, but tapping one still asks for their own words — nothing canned ever lands).
  async function askGenerated(askText, chips, customLabel, placeholder) {
    const options = (chips || []).map(c => ({ label: c, steer: 'close — type your version, with the real names and details.' }));
    options.push({ label: 'Skip for now', value: '', skip: true });
    const f = await askStep({ optional: true, prompt: askText, options, custom: true, customLabel, placeholder, build: () => null, ack: () => '' }, { quietAck: true });
    return f.text;
  }

  // The meeting starts with why they came, follows their answers within a question
  // budget, then offers grounded help and asks them to confirm the mission.
  // A short setup authors the same purpose and posture as the full interview, without inventing a profile.
  async function runQuickSetup(postureStep) {
    beatTotal = 2;
    stage('GET ACQUAINTED', '1 of 2 · Your direction');
    await askStep(fallbackPurposeStep(true), { quietAck: true });
    if (!running) return;
    bumpTruth();
    stage('GET ACQUAINTED', '2 of 2 · While you are away');
    if (postureStep) await askStep(postureStep);
    if (!running) return;
    setDeferred();
  }

  async function runLeadMeeting(options) {

    const postureStep = steps.find(x => x.posturePreset) || null;

    const interviewOnly = !!(options && options.interviewOnly);
    stage('GET ACQUAINTED', 'Choose your pace');
    const pace = await Dialogue.node({
      lines: [seg(interviewOnly
        ? 'let’s fill in the picture. a few questions about your work, or a deeper conversation about your goals? you can review and change what we save in your dossier.'
        : 'i’m awake. let’s give this station a direction. start with two setup questions, or take time to tell me about your work. you can edit what we save in your dossier.', 46, 0)],
      options: [
        ...(!interviewOnly ? [{ label: 'Quick setup — two questions', value: 'quick' }] : []),
        { label: 'A short conversation', value: 'loose' },
        { label: 'Let’s talk it through', value: 'deep' }
      ]
    });
    if (!running) return;
    if (pace.value === 'quick') { await runQuickSetup(postureStep); return; }
    stage('GET ACQUAINTED', 'Your work and goals');

    // S5 BRAIN-BEFORE-INTERVIEW (plan §8): the guided-discovery meeting is a LIVE-MIND activity — a keyless
    // wake gets NO fake scripted interview (asking the deep questions with nothing listening would be the
    // exact fake-listening texture V3 exists to kill). Instead: the honest holding line, the required
    // scripted mission + cadence beats (purpose.md ALWAYS lands), and a persisted IOU — the real interview
    // auto-offers on the first session where the wire is live (offerDeferred). KeyCTA carries the fix path.
    // PROVEN, NOT ASSUMED (Andrew, 2026-07-19): configuration is a claim; the birth-script call — fired at
    // ignition, resolved long before the first question — is the LIVE-WIRE PROOF. A configured brain whose
    // birth call came back dead (birthFailed: bad token, dead network, provider down) gets the same honest
    // holding path: the deep questions are never asked at a wire that already failed to answer.
    if (!brainReady() || birthFailed) {
      beatTotal = 2;
      await Dialogue.say([seg('one thing, straight: the real interview — the one where i actually learn who you are — needs a live mind behind it, and my wire is dark. wire my brain and i’ll ask you the real questions the moment it hums.', 42, 380)]);
      if (!running) return;
      setDeferred();
      await askStep(fallbackPurposeStep(true));
      if (!running) return;
      if (postureStep) await askStep(postureStep);
      return;
    }

    // B0. THE STAKES — the give-to-get trade, declared up front.
    await Dialogue.say([seg('your answers help me choose work that matters to you. they’re saved in your dossier, where you can review and change them. skip anything you’d rather work out later.', 42, 380)]);
    if (!running) return;

    // The opening pace choice also owns interview depth; never ask the same choice twice.
    const loose = pace.value === 'loose';
    if (loose) {
      if (typeof DossierStore !== 'undefined' && DossierStore.upsert) DossierStore.upsert('identity', { text: 'Chose a short introductory conversation.', source: 'onboarding', weight: 'seed' });
    }
    beatTotal = loose ? 4 : 7;   // opening, bounded follow-ups, mission, cadence
    // the adaptive follow-up wallet: generated digs land only while this holds out (the mind's ASK: NONE
    // spends nothing), so depth chases rich answers and the ceremony's runtime stays what Andrew set.
    let followupsLeft = FOLLOWUP_BUDGET;

    // One opening question for both interview depths. Keep the exact conversation as
    // context; only the model's grounded extraction assigns dossier dimensions.
    const opening = {
      field: 'context', optional: true,
      prompt: 'what made you want to set up an agent?',
      options: [{ label: 'Help me figure that out', help: true }, { label: 'Skip for now', value: '', skip: true }],
      custom: true, placeholder: 'a project, an idea, something you need help with — or just curiosity…',
      build: text => ({ context: text }), ack: () => ''
    };
    const openingAnswer = await askStep(opening, { quietAck: true });
    const tuesdayT = openingAnswer.text;
    if (!running) return;
    let digT = '';
    const conversation = [];
    if (openingAnswer.help) conversation.push({ question: opening.prompt, helpRequested: true });
    if (tuesdayT) {
      conversation.push({ question: opening.prompt, answer: tuesdayT });
      bumpTruth();
    }
    // A short conversation gets one follow-up; deeper gets at most three. Every
    // turn sees the whole conversation, and ASK: NONE ends questioning early.
    followupsLeft = loose ? 1 : FOLLOWUP_BUDGET;
    while (conversation.length && running) {
      const pending = brainReady() ? llmCall(WakeMind.buildDigReply({
        tuesday: tuesdayT, conversation, name: NAME, remaining: followupsLeft
      })) : null;
      const reply = await mindWait(pending, WakeMind.parseDigReply, DIG_PATTER, SYNTHESIS_MS);
      if (!running) return;
      if (!reply) break;
      upsertSynthBeliefs(reply.beliefs);
      await Dialogue.say([seg(reply.ack, 44, 360)]);
      if (!running || !reply.ask || followupsLeft <= 0) break;
      const questionKey = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (conversation.some(turn => questionKey(turn.question) === questionKey(reply.ask))) break;
      followupsLeft--;
      const answer = await askGenerated(reply.ask, [], 'Your answer', 'say as much or as little as you like…');
      if (!running) return;
      if (!answer) break;
      conversation.push({ question: reply.ask, answer });
      digT = conversation.slice(1).map(turn => 'Question: ' + turn.question + '\nAnswer: ' + (turn.helpRequested ? '[asked for help finding a starting point]' : turn.answer)).join('\n\n');
      if (commit) commit({ context: conversation.map(turn => 'Question: ' + turn.question + '\nAnswer: ' + (turn.helpRequested ? '[asked for help finding a starting point]' : turn.answer)).join('\n\n') });
      bumpTruth();
    }
    // B7. THE MIRROR (deep + live mind + something real to mirror) — the agent makes concrete OFFERS from
    // their own life: the possibility-space teacher. A grab arms the closing proof beat AND the post-tour
    // first move; a redirect is premium signal (their own words → a stated goals belief). A quiet mind
    // SKIPS this beat entirely — a canned offer would be fake listening.
    let grabbedMove = '';
    if (!loose && brainReady() && (tuesdayT || digT)) {
      // the agent's REAL hands: live placed caps (object=capability), labeled with the same power-words the
      // palette uses. Empty on a fresh awakening (honest — the kit-out is still ahead, and the mirror's
      // directive now teaches CONDITIONAL offers for that case); populated on a deferred interview whose
      // Commander already wired gear.
      const liveCaps = (() => {
        try {
          const ids = (typeof World !== 'undefined' && World.heroCaps) ? (World.heroCaps('agent') || []) : [];
          const L = (typeof WorldModel !== 'undefined' && WorldModel.CAP_LABEL) ? WorldModel.CAP_LABEL : {};
          return ids.map(c => {
            const id = (c && typeof c === 'object') ? c.objectType : c;
            return id ? { id: String(id), label: L[id] || String(id) } : null;
          }).filter(Boolean);
        } catch (_) { return []; }
      })();
      const mirrorCtx = { tuesday: tuesdayT, dig: digT, capabilities: liveCaps, name: NAME };
      let mir = await mindWait(llmCall(WakeMind.buildMirror(mirrorCtx)), WakeMind.parseMirror, MIRROR_PATTER, SYNTHESIS_MS);
      if (!running) return;
      let askedElse = false;
      while (mir && mir.offers && mir.offers.length) {
        upsertSynthBeliefs(mir.beliefs);
        await Dialogue.say([seg('okay. before i write anything down — here’s what i could take off you, starting tonight:', 44, 320)]);
        if (!running) return;
        const opts = mir.offers.map((o, i) => ({ label: (o.length > 64 ? o.slice(0, 63).replace(/\s+\S*$/, '') + '…' : o), value: 'o' + i }));
        if (!askedElse) opts.push({ label: 'what else could you do?', value: 'more' });
        opts.push({ label: 'none of these — i’ll say it', value: 'redirect' });
        opts.push({ label: 'Skip for now', value: '', skip: true });
        const pick = await Dialogue.node({ lines: mir.offers.map((o, i) => seg((i ? '  ' : '') + '· ' + o, 46, 220)), options: opts });
        if (!running) return;
        if (pick && /^o\d$/.test(String(pick.value))) {
          grabbedMove = mir.offers[Number(String(pick.value).slice(1))] || '';
          if (grabbedMove && typeof DossierStore !== 'undefined' && DossierStore.upsert) { DossierStore.upsert('goals', { text: 'Wants the station to: ' + grabbedMove, source: 'onboarding', weight: 'synth' }); ink('goals', 'Wants the station to: ' + grabbedMove); }
          bumpTruth();
          await Dialogue.say([seg('then that’s the one i keep my eye on.', 44, 340)]);
          break;
        }
        if (pick && pick.value === 'more' && !askedElse) {
          askedElse = true;
          mir = await mindWait(llmCall(WakeMind.buildMirror(Object.assign({}, mirrorCtx, { exclude: mir.offers }))), WakeMind.parseMirror, MIRROR_PATTER, SYNTHESIS_MS);
          if (!running) return;
          continue;
        }
        if (pick && pick.value === 'redirect') {
          const f = await Dialogue.node({
            lines: [seg('better. say it — what would you actually hand me?', 46, 0)],
            options: [{ label: 'Skip for now', value: '', skip: true }],
            allowCustom: true, customFirst: true, customLabel: 'type your answer', customPlaceholder: 'the task you’d actually hand me…',
            skipOnEmpty: true
          });
          if (!running) return;
          const t = (!f.skip && f.value != null) ? String(f.value).trim() : '';
          if (t) {
            grabbedMove = t;
            if (typeof DossierStore !== 'undefined' && DossierStore.upsert) { DossierStore.upsert('goals', { text: t, source: 'onboarding', weight: 'stated' }); ink('goals', t); }
            bumpTruth();
            await Dialogue.say([seg('even better — your words beat my guesses. it’s in the file.', 44, 340)]);
          }
        }
        break;
      }
      if (!running) return;
    }

    // B8. THE READ — the agent puts it together, speaks its read, and authors its OWN mission; the
    //    Commander confirms or corrects it. V3: the synthesis sees the WHOLE meeting (tuesday, dig, lost
    //    time, the year, the grabbed offer), and on a thin/loose run the directive makes the read OWN the
    //    thinness — "i barely know you yet" is the honest read, never faked familiarity.
    let purposeDone = false;
    const gaveAnything = !!(tuesdayT || digT || grabbedMove);
    const synPending = brainReady()
      ? llmCall(WakeMind.buildSynthesis({ tuesday: tuesdayT, dig: digT, grabbed: grabbedMove, thin: !gaveAnything, name: NAME })) : null;
    if (synPending) {
      await Dialogue.say([seg('hold on — let me put together what you just handed me…', 44, 240)], { auto: true });   // covers the synthesis wait — never gate it on a click
      if (!running) return;
      const syn = await mindWait(synPending, WakeMind.parseSynthesis, SYNTH_PATTER, SYNTHESIS_MS);
      if (!running) return;
      if (syn) {
        upsertSynthBeliefs(syn.beliefs);
        await Dialogue.say([seg(syn.read, 42, 420)]);
        if (!running) return;
        const c = await Dialogue.node({ lines: [seg('did i read that right?', 46, 0)], options: WakeMind.confirmChoices() });
        if (!running) return;
        let purposeT = syn.purpose;
        if (c && c.value === 'adjust') {
          const own = await Dialogue.node({
            lines: [seg('then say it straight — what are we actually here to do?', 46, 0)],
            options: [{ label: 'Keep your version', value: '', skip: true }],
            allowCustom: true, customFirst: true, customLabel: 'the mission, in my own words', customPlaceholder: 'what this station is for…'
          });
          if (!running) return;
          if (own && own.value != null && String(own.value).trim()) purposeT = String(own.value).trim();
        }
        // V3: the mission is REAL context (synthesized from — or re-stated in — the Commander's words), so it
        // lands as a grounded `goals` belief BEFORE purpose.md commits (the doc-seed then dedupes to nothing).
        // 'stated' when they put it their own way, 'synth' when they confirmed the agent's synthesis.
        // A THIN run's confirmed synthesis is grounded in NOTHING the Commander said — it lands as 'seed'
        // (purpose.md still exists; the readiness gate stays honestly shut until real words arrive).
        if (typeof DossierStore !== 'undefined' && DossierStore.upsert) { DossierStore.upsert('goals', { text: purposeT, source: 'onboarding', weight: (purposeT !== syn.purpose ? 'stated' : (gaveAnything ? 'synth' : 'seed')) }); if (purposeT !== syn.purpose || gaveAnything) ink('goals', purposeT); }   // a seed-weight thin purpose is never inked — nothing was learned
        if (commit) commit({ purpose: purposeT });
        // the one durable belief only this conversation could surface: the stack/domain they live in.
        if (syn.stack && typeof DossierStore !== 'undefined' && DossierStore.upsert) DossierStore.upsert('stack', { text: syn.stack, source: 'onboarding', weight: 'synth' });
        if (typeof ProfileStore !== 'undefined' && typeof Classify !== 'undefined') ProfileStore.seed(Classify.getTag(purposeT));
        bumpTruth();
        await Dialogue.say([seg('there it is — purpose.md, in ink. that’s what this station’s for.', 44, 360)]);
        if (!running) return;
        purposeDone = true;
      }
    }
    if (!purposeDone) {
      await askStep(fallbackPurposeStep());   // the classic mission question — required, never skippable
      if (!running) return;
    }

    // B9. THE CADENCE — unchanged scripted beat.
    if (postureStep) {
      await askStep(postureStep);
      if (!running) return;
    }

    // Carry the selected proposal into an editable handoff; starting happens there, once.
    if (grabbedMove && typeof PitchStore !== 'undefined' && PitchStore.armFirstMove) {
      PitchStore.armFirstMove(grabbedMove);
    }

  }

  async function startQuestions() {
    if (typeof Dialogue === 'undefined') return finish();   // panel missing → don't strand the ceremony
    Dialogue.open({ name: NAME });
    stage('GET ACQUAINTED', specialty ? 'Your new crew member' : 'Your direction');
    beatN = 0;
    if (specialty) { beatTotal = Math.max(1, steps.length); await runSteps(steps); }
    else { beatTotal = 6; await runLeadMeeting(); }   // pain, its follow-up, ambition, its follow-up, purpose, cadence
    if (!running) return;
    finish();
  }

  // DAWN — the pull-back reveals its whole world, the light blooms, and it speaks its first WHOLE sentences
  // (in the dialogue panel), then HANDS OFF to the tutorial in that same panel — no rhetorical self-answer.
  function finish() {
    running = false;
    if (World.endAwakening) World.endAwakening();      // light floods + the sonar ripple fires (agent holds your gaze)
    if (World.camPullBack) World.camPullBack();
    sfx('dawn');
    AU.steady(1);
    setTimeout(() => AU.stop(), 2800);                 // let the swell + steady heartbeat ride the dawn, then tear down
    Chat.endInterview();
    if (notifyFn) notifyFn(NAME + ' is awake — and it knows why.', 'good');
    if (doneCb) doneCb();
    closeOut();
  }
  // the closing monologue + the handoff, paced one short beat at a time in the panel (the anti-wall-of-text
  // move). The panel STAYS OPEN: taughtCb() runs Tutorial.firstCommand, which opens the next choice node right
  // here — the awakening flows straight into the tour with no seam. No "where do we begin?" self-answer.
  async function closeOut() {
    if (typeof Dialogue === 'undefined') { if (World.releaseAwakening) World.releaseAwakening(); if (taughtCb) taughtCb(); return; }
    Dialogue.open({ name: NAME });
    stage('READY TO BEGIN', 'Choose your first step');
    const readyLine = role === 'orchestrator'
      ? 'i’m ' + NAME + '. the station is yours. give me one task to start with — we can build the rest around the work. your setup stays editable in the dossier.'
      : 'i’m ' + NAME + '. ready for my first assignment. you can change my setup in the agent dossier.';
    await Dialogue.say([seg(readyLine, 46, 0)]);
    if (birthFailed) {
      await Dialogue.say([seg('the model connection failed during setup. check CONNECT before starting a task; your saved setup is still here.', 46, 0)]);
    }
    if (World.releaseAwakening) World.releaseAwakening();   // hand the agent back to its own autonomous life
    if (taughtCb) taughtCb();                               // → Tutorial.firstCommand opens the tour IN THIS PANEL
  }

  // safety teardown if the awakening is abandoned (e.g. DISCONNECT mid-ceremony) — never leak audio or a freeze.
  function stop() {
    AU.stop();
    running = false;
    if (kindleTimer) { clearTimeout(kindleTimer); kindleTimer = null; }
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close();
    if (World.releaseAwakening) World.releaseAwakening();
    if (typeof Chat !== 'undefined' && Chat.endInterview) Chat.endInterview();
  }

  function isRunning() { return running; }

  /* ==== S5 — THE DEFERRED INTERVIEW (plan §8) ====
     A keyless wake banked an IOU (setDeferred, above). The first session that boots with a LIVE brain
     offers to pay it: one gentle COMMS nudge — accept runs the full guided-discovery meeting (the same
     runLeadMeeting the awakening uses, minus the birth theatre), decline hands the gap to hunt mode.
     ONE-SHOT: the flag is spent on OFFER (never a nag loop); reEnable lives in re-running onboarding. */
  const DEFER_KEY = 'starnet.interview.deferred.v1';
  function setDeferred() { try { localStorage.setItem(DEFER_KEY, '1'); } catch (_) {} }
  function deferredPending() { try { return localStorage.getItem(DEFER_KEY) === '1'; } catch (_) { return false; } }
  function clearDeferred() { try { localStorage.removeItem(DEFER_KEY); } catch (_) {} }

  // opts mirror start(): { name, docs, commit, getSystem, persona, notify }. Returns true iff the offer showed.
  function offerDeferred(opts) {
    if (running) return false;
    if (!deferredPending()) return false;
    if (!brainReady()) return false;                                    // still no wire — the IOU keeps waiting
    if (typeof Chat === 'undefined' || !Chat.nudge) return false;
    if (Chat.isBusy && Chat.isBusy()) return false;
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return false;
    opts = opts || {};
    clearDeferred();                                                    // spent on OFFER — declining is answering
    Chat.nudge('Want to add more context to your work profile? We can talk through your work and goals, or keep learning through tasks.', [
      { label: 'do it now', value: 'go' },
      { label: 'not now', value: 'no', skip: true }
    ], async item => {
      if (!item || item.value !== 'go') return;                         // declined → hunt mode owns the gap
      if (running || typeof Dialogue === 'undefined') return;
      try {
        docs = opts.docs || docs; commit = opts.commit || commit;
        notifyFn = opts.notify || notifyFn; getSystem = opts.getSystem || getSystem;
        NAME = opts.name || NAME; persona = opts.persona || persona;
        specialty = null; role = 'orchestrator';
        steps = buildSteps(); i = 0; beatN = 0; beatTotal = 9; running = true;
        Dialogue.open({ name: NAME });
        await runLeadMeeting({ interviewOnly: true });
        if (running && Dialogue.isOpen()) Dialogue.close();
        if (running && notifyFn) notifyFn('the dossier is real now — i know who i work for.', 'good');
      } catch (_) {
        try { if (Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close(); } catch (__) {}
      } finally {
        running = false;
      }
    });
    return true;
  }

  return { start, stop, isRunning, offerDeferred, _deferredPending: deferredPending };
})();
