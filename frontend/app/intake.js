/* AGENT OS — intake.js : THE INTAKE INTERVIEW flow (Commander Dossier, Phase B slice 1).

   The COMMS half of the active "get to know the Commander" move — a thin controller that mirrors
   onboarding.js's answer loop, but lighter and mid-game: it runs the questions interview.js planned, in
   the agent's own COMMS voice, and folds each answer into the station-wide dossier (DossierStore.upsert)
   through the same Keep/forget glass box the panel uses. Optional + skippable: every question can be
   skipped, partial completion still banks what was answered, and it never calls the model (Chat interview
   mode intercepts input). ALL decision logic lives in the pure interview.js; this is just the COMMS glue. */
'use strict';
const Intake = (() => {
  let questions = [], idx = 0, accepting = false, running = false;
  let onCommit = null, onDone = null, onLeave = null;
  let escHandler = null;   // document-level Esc-to-leave, live only while the interview is running

  const sfx = n => { try { if (typeof SFX === 'object' && SFX[n]) SFX[n](); } catch (_) {} };
  function type(segs, cb) {
    if (typeof Chat !== 'undefined' && Chat.typeLine) return Chat.typeLine(segs, cb);
    if (cb) cb();
    return () => {};
  }

  // start an interview over the dimensions in opts.skip-complement. Returns true if it began, false on a
  // no-op (already running, no Chat, or nothing left to ask). opts: { skip:[knownDims], onCommit(belief),
  // onDone(), onEmpty() }.
  function start(opts) {
    opts = opts || {};
    if (running) return false;
    if (typeof Chat === 'undefined' || !Chat.beginInterview) return false;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return false;   // never hijack the awakening's COMMS input handler (defense-in-depth; the panel guards too)
    questions = (typeof Interview !== 'undefined') ? Interview.plan({ skip: opts.skip || [] }) : [];
    if (!questions.length) { if (opts.onEmpty) { try { opts.onEmpty(); } catch (_) {} } return false; }
    onCommit = opts.onCommit || null;
    onDone = opts.onDone || null;
    onLeave = opts.onLeave || null;
    idx = 0; accepting = false; running = true;
    Chat.beginInterview(text => answer(text, text, false), { placeholder: 'tell the station about yourself… (or “skip”)', status: 'getting to know you…' });
    // ESCAPE HATCH (Andrew ask): the interview hijacks COMMS, so the Commander must be able to walk away from the
    // WHOLE thing — not just skip one question at a time. Esc leaves; a "✕ leave interview" chip sits on every
    // question (see ask()). Capture-phase so it wins over any other Esc listener while the interview owns the moment.
    escHandler = e => { if (e.key === 'Escape' && running) { e.preventDefault(); e.stopPropagation(); leave(); } };
    document.addEventListener('keydown', escHandler, true);
    type([{ text: 'one second, Commander — let me actually get to know you. this shapes how every agent here works for you. answer or tap, “skip” anything — or press Esc to leave the interview.', cps: 48, holdAfter: 250 }], () => setTimeout(ask, 450));
    return true;
  }

  function ask() {
    if (!running) return;
    const q = questions[idx];
    if (!q) return finish();
    const myIdx = idx;   // bind this question's index so a stale chip row (left over when the user TYPED a
    const segs = [];     //   prior answer instead of tapping) can never answer a LATER question
    // PROGRESS (truthful): the whole queue is planned up front (Interview.plan), so the count is knowable —
    // show "question N of M" so the Commander knows the interview is finite and how far in they are. A fast
    // lead segment (high cps → types near-instantly) so it reads as a quiet HUD marker before the real ask.
    // (typeLine styles the whole line uniformly, so this is a plain inline prefix, not a styled sub-span.)
    if (questions.length > 1) segs.push({ text: '[' + (idx + 1) + '/' + questions.length + '] ', cps: 120, holdAfter: 0 });
    if (q.pre) segs.push({ text: q.pre, cps: 47, holdAfter: 300 });
    segs.push({ text: q.ask, cps: 47 });
    type(segs, () => {
      if (!running) return;
      accepting = true;
      if (Chat.choices) {
        // every question carries a quiet "✕ leave interview" chip alongside its own chips, so the Commander can
        // exit the WHOLE flow at any point without answering (partial answers already banked). `leave:true` is the
        // marker answer() reads to tear the interview down instead of advancing.
        const chips = (q.chips ? q.chips.slice() : []).concat([{ label: '✕ leave interview', value: '', leave: true, quiet: true }]);
        Chat.choices(chips, item => {
          if (!accepting || idx !== myIdx) return;   // ignore a tap meant for a question we've already moved past
          if (item && item.leave) { leave(); return; }
          answer(item.value != null ? item.value : item.label, item.label, !!item.skip);
        });
      }
    });
  }

  // commit = what gets written; display = the echoed Commander line; explicitSkip from a skip chip.
  function answer(commit, display, explicitSkip) {
    if (!accepting || !running) return;
    const q = questions[idx]; if (!q) return;
    const text = (commit == null ? '' : String(commit)).trim();
    // A TYPED skip counts too — the opening line invites exactly that ("answer or tap, 'skip' anything"), and the
    // word is the chip's own label. Whole-answer match only (Interview.isSkipAnswer), so a real answer that
    // merely CONTAINS one of those words still lands. Falls back to the old rule if the engine isn't loaded.
    const isSkip = explicitSkip || (typeof Interview !== 'undefined' && Interview.isSkipAnswer ? Interview.isSkipAnswer(text) : text === '');
    accepting = false;
    if (Chat.echoUser) Chat.echoUser(isSkip ? '(skip)' : (display != null ? String(display) : text));
    if (!isSkip && onCommit && typeof Interview !== 'undefined') {
      const belief = Interview.beliefFromAnswer(q, text);
      if (belief) { try { onCommit(belief); } catch (_) {} sfx('truth'); }   // a soft bell as the station learns one thing about you
    }
    idx++;
    setTimeout(ask, 520);
  }

  function detachEsc() { if (escHandler) { document.removeEventListener('keydown', escHandler, true); escHandler = null; } }

  // LEAVE THE WHOLE INTERVIEW (Esc or the leave chip): the Commander walks away without finishing. Whatever was
  // already answered stays banked (each answer committed as it was given); the rest is simply not asked. Dismissal
  // is recorded through the caller's EXISTING waved-off store via onLeave (the curiosity path marks the dimension
  // dismissed so it isn't re-asked this session) — this module invents no persistence of its own.
  function leave() {
    if (!running) return;
    running = false; accepting = false;
    detachEsc();
    if (Chat.endInterview) Chat.endInterview();
    sfx('close');
    type([{ text: 'no problem — we’ll leave it there. i kept whatever you did tell me; refine any of it in the COMMANDER dossier whenever.', cps: 48 }], () => {});
    if (onLeave) { try { onLeave(); } catch (_) {} }
  }

  function finish() {
    if (!running) return;
    running = false; accepting = false;
    detachEsc();
    if (Chat.endInterview) Chat.endInterview();
    // CLOSING SIGNAL: name the end explicitly and hand the COMMS input back — the interview hijacked it, so
    // "talk to me normally now" tells the Commander the field is theirs again (the exit signal the audit flagged).
    type([{ text: 'that’s everything — talk to me normally now. i know you a little better, and so does every agent on the station. refine any of it in the COMMANDER dossier whenever.', cps: 48 }], () => {});
    if (onDone) { try { onDone(); } catch (_) {} }
  }

  // teardown if the interview is abandoned (e.g. DISCONNECT mid-interview) — never leave COMMS stuck in
  // interview mode.
  function stop() {
    if (!running) return;
    running = false; accepting = false;
    detachEsc();
    if (typeof Chat !== 'undefined' && Chat.endInterview) Chat.endInterview();
  }
  function isRunning() { return running; }

  return { start, stop, isRunning };
})();
