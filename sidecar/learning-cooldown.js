/* sidecar/learning-cooldown.js — ONE cooldown resolver for the four post-run LEARNING passes: reflection, failure
   review, study and thread mining (cost lane W1.4, 2026-11-09).

   WHY. Each pass used to arm its window only when a proposal survived ("a floored or all-dedup run never blocks the
   next one"). A pass that kept nothing (the model's NONE, or every line floored or deduped) therefore fired again on
   the very next run: four quick tool runs paid eight one-shot passes, reflection and study after every run, for
   nothing. That choice is reversed here, on purpose:
     - every ATTEMPT (a model call went out) stamps its pass's window, whatever it kept, and a call that FAILED too (an
       HTTP error, a 429, a usage limit, the timeout): it went out, and a timeout may be billed for its prompt, so a
       route that keeps failing is tried once per window instead of at every run-end;
     - reflection backs off after consecutive replies that kept nothing: its window x1, x4, x10 (the default 3 min
       becomes 3, then 12, then 30 min); a kept proposal resets the streak. The ladder multiplies whatever window is
       configured and has no ceiling of its own (a 60 min window becomes 10 h after three NONE replies);
     - FEEDBACK ALWAYS GETS THROUGH: every like or dislike (a thumbs verdict, the correction after it, KEEP THIS
       STYLE, a workflow's NEEDS CHANGES: the host's one feedback write path, whatever it saves) and an explicit
       preference or correction cue in the Commander's own latest words (CUE) open every learning window of that
       agent, until each pass's next attempt that could have read it AND got an answer: a call that failed never read
       anything, so it uses nothing up and the pass's next attempt still skips its window;
     - failure review also skips its window for a NEW failure class (outcome, stage, code): a different way of
       failing is a different lesson (a W1.4 extension beyond the cues and verdicts). A class stays new until a review
       of it gets an answer.
   A window of 0 (TIME BETWEEN SUGGESTIONS 0) stays 0: the backoff multiplies the configured window, never adds to it.

   ORDER, NOT THE CLOCK. Feedback is a token stamped with an ORDER number. A run's end takes the current order
   (ended): its passes read what had been said by then. An attempt uses a token up only when its run ended at or after
   that token, so a pass that was already running when a verdict landed (or queued behind another pass on a
   subscription route) never spends the verdict: the next run's pass does. A cue in a run whose pass was held back
   (its previous pass still running, or the budget deferred it) keeps its token for that pass's next attempt. The order
   is a counter, never the wall clock: two events in one millisecond, or a clock stepped back, cannot swap places.
   A forget (agent delete, memory reset) takes an order too: an attempt whose run ended before it arms no window and
   folds nothing, so a pass that outlived its agent cannot bring that agent's stamps back.

   SHAPE. Pure: no IO and no clock of its own (`now` is injected; lint-determinism). The host (sidecar/index.js) owns
   the attempt stamps (study's persists in study.state.json) and the live configured windows, and asks this module how
   far reflection is backed off (scale), whether a pass may skip its window this run-end (bypass), and whether an
   attempt that ended should arm anything (noted). The policy state here (NONE streaks, reviewed failure classes,
   feedback tokens, run-end and forget orders) lives in RAM, like the reflection stamp itself: a restart starts it
   over (one extra pass at most, and a feedback token from before the restart is gone with it). */
'use strict';

const KINDS = Object.freeze(['reflection', 'failure-review', 'study', 'threadmine']);
// reflection's window multiplier by consecutive replies that kept nothing (index = the streak, capped at the last)
const NONE_BACKOFF = Object.freeze([1, 1, 4, 10]);
// an explicit preference or correction in the Commander's own words. Broad on purpose: a false hit costs one extra
// attempt per pass, a miss loses feedback the next run should have learned from.
const CUE = /\b(?:remember|always|never|from now on|from here on|going forward|next time|in (?:the )?future|prefer(?:s|red|ence|ences)?|don'?t|do not|stop \w+ing|instead of)\b/i;
// phrases that carry a cue word but give no instruction ("never mind", "I don't know why ...")
const NOT_CUE = /\b(?:never ?mind|don'?t know|do not know)\b/gi;
const CLASS_PART_CHARS = 80;   // per part of a failure class (stage / code are enumerated; this only bounds a stray one)
const CLASSES_PER_AGENT = 16;  // reviewed failure classes kept per agent (oldest first out)
const RUNS_KEPT = 256;         // run-end orders kept: a pass notes its attempt within seconds of its run's end
const FORGETS_KEPT = 256;      // forget orders kept (agents deleted or reset)

const isKind = kind => KINDS.indexOf(kind) >= 0;

// does the Commander's latest turn carry an explicit preference or correction cue?
function cueIn(text) {
  const t = String(text == null ? '' : text).replace(/[‘’ʼ]/g, "'").replace(NOT_CUE, ' ');
  return !!t.trim() && CUE.test(t);
}

// a failed run's class: what kind of failure it was, never which run (stage and code are enumerated by loop.js)
function failureClass(o) {
  const part = v => String(v == null ? '' : v).trim().slice(0, CLASS_PART_CHARS);
  const f = o || {};
  return [part(f.outcome), part(f.failureStage), part(f.failureCode)].join('|');
}

// insert or refresh a bounded insertion-ordered map entry (oldest first out)
function keep(map, key, value, cap) {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value);
}

function make(opts) {
  const now = (opts && typeof opts.now === 'function') ? opts.now : (() => 0);
  let order = 0;                // feedback order: a counter, never the clock
  const streaks = new Map();    // agentId -> consecutive reflection replies that kept nothing
  const classes = new Map();    // agentId -> Map(failure class -> when it was last reviewed)
  const tokens = new Map();     // agentId -> Map(pass -> { order, why }): feedback that pass has not had the chance to read
  const runs = new Map();       // runId -> the order when that run ended (what its passes could read)
  const forgotten = new Map();  // agentId -> the order of its last forget (agent delete / memory reset)

  // reflection's window multiplier for this agent; 1 for every other pass (their windows are flat)
  function scale(kind, agentId) {
    if (kind !== 'reflection') return 1;
    const n = streaks.get(String(agentId)) || 0;
    return NONE_BACKOFF[Math.min(n, NONE_BACKOFF.length - 1)];
  }

  // feedback reached this agent (why: 'feedback' = a like or dislike was stored, 'cue' = the Commander's own words):
  // every learning pass may skip its window until its next attempt from a run that ended after this
  function open(agentId, why) {
    const at = ++order, w = String(why || 'feedback');
    tokens.set(String(agentId), new Map(KINDS.map(k => [k, { order: at, why: w }])));
  }

  // a run ended: its learning passes read what had been said up to now
  function ended(runId) {
    if (runId == null || runId === '') return;
    keep(runs, String(runId), order, RUNS_KEPT);
  }

  /* why this pass may skip its window at this run-end ('' = it may not; the window decides).
     ctx: { failureClass: the failed run's class, windowMs: failure review's window } */
  function bypass(kind, agentId, ctx) {
    if (!isKind(kind)) return '';
    const id = String(agentId), c = ctx || {};
    const t = tokens.get(id), tok = t && t.get(kind);
    if (tok) return tok.why;
    if (kind === 'failure-review' && c.failureClass) {
      const seen = classes.get(id);
      const at = seen ? seen.get(String(c.failureClass)) : undefined;
      const windowMs = Math.max(0, Number(c.windowMs) || 0);
      if (at === undefined || now() - at >= windowMs) return 'new-failure-class';
    }
    return '';
  }

  /* one ATTEMPT of a pass has ended. r: { runId: the run it learned from, replied: the model answered, produced: a
     proposal survived, failureClass: the class a failure review read }. Returns whether the host arms the pass's
     window: true for every attempt, a failed call included; false when the attempt's run ended before its agent was
     forgotten (deleted or reset), or for a pass outside the family. Only an ANSWERED attempt learned anything, so only
     an answer uses up a feedback token, counts toward the NONE streak and marks a failure class reviewed: a call that
     failed (an HTTP error, a 429, a usage limit, the timeout) keeps the token for the pass's next attempt and leaves
     the class new. */
  function noted(kind, agentId, r) {
    if (!isKind(kind)) return false;
    const id = String(agentId), o = r || {};
    const key = String(o.runId == null ? '' : o.runId);
    const at = runs.has(key) ? runs.get(key) : -1;   // -1: a run this policy never saw end reads nothing new
    if (forgotten.has(id) && at < forgotten.get(id)) return false;
    if (o.replied !== true && o.produced !== true) return true;   // no answer: nothing was read, so nothing is used up
    const t = tokens.get(id), tok = t && t.get(kind);
    if (tok && at >= tok.order) { t.delete(kind); if (!t.size) tokens.delete(id); }
    if (kind === 'reflection') {
      if (o.produced === true) streaks.delete(id);
      else streaks.set(id, (streaks.get(id) || 0) + 1);
    }
    if (kind === 'failure-review' && o.failureClass) {
      const seen = classes.get(id) || new Map();
      keep(seen, String(o.failureClass), now(), CLASSES_PER_AGENT);
      classes.set(id, seen);
    }
    return true;
  }

  // the agent was deleted or its memory reset: its policy state goes with the stamps, and an attempt from a run that
  // ended before this point arms nothing when it finishes
  function forget(agentId) {
    const id = String(agentId);
    streaks.delete(id); classes.delete(id); tokens.delete(id);
    keep(forgotten, id, ++order, FORGETS_KEPT);
  }

  return {
    scale, bypass, noted, open, ended, forget,
    streak: agentId => streaks.get(String(agentId)) || 0,
    // the passes still holding a feedback token for this agent (diagnostics and tests)
    pending: agentId => { const t = tokens.get(String(agentId)); return t ? KINDS.filter(k => t.has(k)) : []; }
  };
}

module.exports = { KINDS, NONE_BACKOFF, CUE, cueIn, failureClass, make };
