/* sidecar/learning-cooldown.js — ONE cooldown resolver for the four post-run LEARNING passes: reflection, failure
   review, study and thread mining (cost lane W1.4, 2026-11-09).

   WHY. Each pass used to arm its window only when a proposal survived ("a floored or all-dedup run never blocks the
   next one"). A pass that kept nothing (the model's NONE, or every line floored or deduped) therefore fired again on
   the very next run: four quick tool runs paid eight one-shot passes, reflection and study after every run, for
   nothing. That choice is reversed here, on purpose:
     - every ATTEMPT (a model call went out) stamps its pass's window, whatever it kept;
     - reflection backs off after consecutive replies that kept nothing: its window x1, x4, x10 (the default 3 min
       becomes 3, then 12, then 30 min); a kept proposal resets the streak;
     - feedback always gets through: an explicit preference or correction cue in the Commander's own latest words
       (CUE: remember, always, never, from now on, going forward, prefer, don't / do not) skips every window, and so
       does a thumbs verdict on a run (or the correction that follows it), once per pass;
     - failure review also skips its window for a NEW failure class (outcome, stage, code): a different way of
       failing is a different lesson.
   A window of 0 (TIME BETWEEN SUGGESTIONS 0) stays 0: the backoff multiplies the configured window, never adds to it.

   SHAPE. Pure: no IO and no clock of its own (`now` is injected; lint-determinism). The host (sidecar/index.js) owns
   the attempt stamps (study's persists in study.state.json) and the live configured windows, and asks this module two
   things: how far reflection is backed off (scale) and whether a pass may skip its window this run-end (bypass). The
   per-agent policy state here (NONE streaks, reviewed failure classes, verdict-opened passes) lives in RAM, like the
   reflection stamp itself: a restart starts it over (one extra pass at most). */
'use strict';

const KINDS = Object.freeze(['reflection', 'failure-review', 'study', 'threadmine']);
// reflection's window multiplier by consecutive replies that kept nothing (index = the streak, capped at the last)
const NONE_BACKOFF = Object.freeze([1, 1, 4, 10]);
// an explicit preference or correction in the Commander's own words. Broad on purpose: a false hit costs one extra
// pass, a miss loses feedback the next run should have learned from.
const CUE = /\b(?:remember|always|never|from now on|going forward|prefer(?:s|red|ence|ences)?|don'?t|do not)\b/i;
const CLASS_PART_CHARS = 80;   // per part of a failure class (stage / code are enumerated; this only bounds a stray one)
const CLASSES_PER_AGENT = 16;  // reviewed failure classes kept per agent (oldest first out)

const isKind = kind => KINDS.indexOf(kind) >= 0;

// does the Commander's latest turn carry an explicit preference or correction cue?
function cueIn(text) {
  const t = String(text == null ? '' : text).replace(/[‘’ʼ]/g, "'");
  return !!t.trim() && CUE.test(t);
}

// a failed run's class: what kind of failure it was, never which run (stage and code are enumerated by loop.js)
function failureClass(o) {
  const part = v => String(v == null ? '' : v).trim().slice(0, CLASS_PART_CHARS);
  const f = o || {};
  return [part(f.outcome), part(f.failureStage), part(f.failureCode)].join('|');
}

function make(opts) {
  const now = (opts && typeof opts.now === 'function') ? opts.now : (() => 0);
  const streaks = new Map();   // agentId -> consecutive reflection replies that kept nothing
  const classes = new Map();   // agentId -> Map(failure class -> when it was last reviewed)
  const opened = new Map();    // agentId -> Set of passes a thumbs verdict opened (each closes on its next attempt)

  // reflection's window multiplier for this agent; 1 for every other pass (their windows are flat)
  function scale(kind, agentId) {
    if (kind !== 'reflection') return 1;
    const n = streaks.get(String(agentId)) || 0;
    return NONE_BACKOFF[Math.min(n, NONE_BACKOFF.length - 1)];
  }

  /* why this pass may skip its window at this run-end ('' = it may not; the window decides).
     ctx: { cue: the latest turn carries a cue, failureClass: the failed run's class, windowMs: failure review's window } */
  function bypass(kind, agentId, ctx) {
    if (!isKind(kind)) return '';
    const id = String(agentId), c = ctx || {};
    if (c.cue === true) return 'cue';
    const o = opened.get(id);
    if (o && o.has(kind)) return 'verdict';
    if (kind === 'failure-review' && c.failureClass) {
      const seen = classes.get(id);
      const at = seen ? seen.get(String(c.failureClass)) : undefined;
      const windowMs = Math.max(0, Number(c.windowMs) || 0);
      if (at === undefined || now() - at >= windowMs) return 'new-failure-class';
    }
    return '';
  }

  /* one ATTEMPT of a pass has ended (the host stamps the window). r: { replied: the model answered, produced: a
     proposal survived, failureClass: the class a failure review read }. A call that failed (no reply) leaves the
     NONE streak as it is. */
  function noted(kind, agentId, r) {
    if (!isKind(kind)) return;
    const id = String(agentId), o = r || {};
    const open = opened.get(id);
    if (open) { open.delete(kind); if (!open.size) opened.delete(id); }
    if (kind === 'reflection') {
      if (o.produced === true) streaks.delete(id);
      else if (o.replied === true) streaks.set(id, (streaks.get(id) || 0) + 1);
    }
    if (kind === 'failure-review' && o.failureClass) {
      const seen = classes.get(id) || new Map();
      seen.delete(String(o.failureClass));
      seen.set(String(o.failureClass), now());
      while (seen.size > CLASSES_PER_AGENT) seen.delete(seen.keys().next().value);
      classes.set(id, seen);
    }
  }

  // a thumbs verdict (or the correction after it) on this agent's run: every pass skips its window once
  function open(agentId) { opened.set(String(agentId), new Set(KINDS)); }

  // the agent was deleted or its memory reset: its policy state goes with the stamps
  function forget(agentId) {
    const id = String(agentId);
    streaks.delete(id); classes.delete(id); opened.delete(id);
  }

  return { scale, bypass, noted, open, forget, streak: agentId => streaks.get(String(agentId)) || 0 };
}

module.exports = { KINDS, NONE_BACKOFF, CUE, cueIn, failureClass, make };
