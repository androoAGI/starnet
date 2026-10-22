/* AGENT OS — goalloop.js : the PURE GOAL-LOOP state machine (Agent OS's "Ralph loop").

   The autonomous engine behind /goal: the Commander sets a standing goal on a workstream; after each turn
   lands, an auxiliary JUDGE model is asked "is this goal satisfied by the agent's last response?" and returns
   a one-line JSON verdict {done, reason}. If not done, a CONTINUATION prompt (goal + subgoals + judge reason)
   is auto-queued as the next turn. The loop ends when the judge says done, the continuation budget is spent,
   a real user message preempts it, or the Commander pauses/clears it. Mirrors the reference CLI's goal loop, minus
   the wait-barrier (Agent OS's /goal has no async-process registry to park on).

   PURE + node-testable (a `GoalLoop` global in the browser, module.exports under node), mirroring goals.js /
   dossier.js: NO Date.now / Math.random — the clock is ALWAYS injected. This file owns ONLY the deterministic
   verdict-parse + the continuation/preemption/budget state machine over a plain serializable state object; the
   browser wiring (chat.js) supplies the clock, the aux model call, and persistence (the state rides on the
   workstream record so it survives a reload exactly like the thread history).

   The state object (serializable; lives at ws.goalLoop):
     { goal, status, turnsUsed, maxTurns, subgoals:[…], lastVerdict, lastReason,
       pausedReason, parseFails, createdAt, lastTurnAt }
   status: 'active' | 'paused' | 'done' | 'cleared'

   Fail-open by construction: an unparseable judge reply → CONTINUE (a broken judge must never wedge progress;
   the turn budget + the consecutive-parse-failure auto-pause are the backstops). A station with no goalloop.js
   loaded is byte-identical to before (additive-only). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.GoalLoop = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_TURNS = 20;                 // the continuation budget: a hard backstop against a runaway loop
  const MAX_PARSE_FAILS = 3;                     // N consecutive unparseable judge replies → auto-pause (weak judge model)
  const GOAL_CHARS = 2000, SUB_CHARS = 400, REASON_CHARS = 300;   // caps on stored/echoed strings (bound the prompt)
  const RESP_SNIPPET = 4000;                     // how much of the last reply we hand the judge

  const clamp = (s, n) => { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) : s; };

  /* ============================ VERDICT PARSE (pure, fail-open) ============================
     Read the judge's reply into { verdict:'done'|'continue', reason, parseFailed }. parseFailed is true ONLY
     when the call returned a body we could not interpret as the JSON contract (empty / prose / malformed) — the
     caller counts those toward the auto-pause. Accepts the {done:<bool>} shape AND a {verdict:'done'|'continue'}
     shape, tolerates a ```json fence and prose around the object, and always fails open to CONTINUE. */
  const JSON_OBJ = /\{[\s\S]*?\}/;
  function parseVerdict(raw) {
    if (raw == null || !String(raw).trim()) return { verdict: 'continue', reason: 'judge returned empty response', parseFailed: true };
    let text = String(raw).trim();
    if (text.indexOf('```') === 0) {                       // strip a leading markdown code fence + its lang tag
      text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    }
    let data = null;
    try { data = JSON.parse(text); } catch (_) {
      const m = JSON_OBJ.exec(text);                        // pull the first {…} object out of surrounding prose
      if (m) { try { data = JSON.parse(m[0]); } catch (_2) { data = null; } }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { verdict: 'continue', reason: 'judge reply was not JSON', parseFailed: true };
    }
    const reason = clamp(data.reason, REASON_CHARS) || 'no reason given';
    let verdict;
    if (typeof data.verdict === 'string') {
      verdict = data.verdict.trim().toLowerCase();
    } else {
      const dv = data.done;
      const done = (typeof dv === 'string') ? (['true', 'yes', '1', 'done'].indexOf(dv.trim().toLowerCase()) >= 0) : !!dv;
      verdict = done ? 'done' : 'continue';
    }
    if (verdict !== 'done' && verdict !== 'continue') verdict = 'continue';   // any unknown verdict → keep going
    return { verdict: verdict, reason: reason, parseFailed: false };
  }

  /* ============================ STATE FACTORY + NORMALIZE ============================ */

  function create(goal, opts) {
    opts = opts || {};
    const g = clamp(goal, GOAL_CHARS);
    if (!g) return null;                                   // an empty goal is not a loop
    const t = +opts.now || 0;
    let mt = parseInt(opts.maxTurns, 10);
    if (!(mt > 0)) mt = DEFAULT_MAX_TURNS;
    return {
      goal: g, status: 'active', turnsUsed: 0, maxTurns: mt,
      subgoals: [], lastVerdict: null, lastReason: null, pausedReason: null,
      parseFails: 0, createdAt: t, lastTurnAt: 0
    };
  }

  // re-normalize a persisted/foreign state object into a safe shape (fail-open on a corrupt row); null if unusable.
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const g = clamp(raw.goal, GOAL_CHARS);
    if (!g) return null;
    const st = ['active', 'paused', 'done', 'cleared'].indexOf(raw.status) >= 0 ? raw.status : 'active';
    let mt = parseInt(raw.maxTurns, 10); if (!(mt > 0)) mt = DEFAULT_MAX_TURNS;
    const subs = Array.isArray(raw.subgoals) ? raw.subgoals.map(s => clamp(s, SUB_CHARS)).filter(Boolean).slice(0, 20) : [];
    return {
      goal: g, status: st, turnsUsed: Math.max(0, parseInt(raw.turnsUsed, 10) || 0), maxTurns: mt,
      subgoals: subs, lastVerdict: raw.lastVerdict || null, lastReason: raw.lastReason || null,
      pausedReason: raw.pausedReason || null, parseFails: Math.max(0, parseInt(raw.parseFails, 10) || 0),
      createdAt: +raw.createdAt || 0, lastTurnAt: +raw.lastTurnAt || 0
    };
  }

  const isActive = s => !!(s && s.status === 'active');
  const hasGoal = s => !!(s && (s.status === 'active' || s.status === 'paused'));

  /* ============================ MUTATIONS (all return the state for chaining) ============================ */

  function addSubgoal(s, text) {
    if (!hasGoal(s)) return null;
    const t = clamp(text, SUB_CHARS);
    if (!t) return null;
    if (s.subgoals.length >= 20) return null;              // a sane ceiling on criteria
    s.subgoals.push(t);
    return t;
  }
  function pause(s, reason) {
    if (!s || s.status === 'cleared' || s.status === 'done') return s;
    s.status = 'paused'; s.pausedReason = clamp(reason, REASON_CHARS) || 'paused';
    return s;
  }
  function resume(s, opts) {
    opts = opts || {};
    if (!s || (s.status !== 'paused')) return s;
    s.status = 'active'; s.pausedReason = null;
    if (opts.resetBudget !== false) { s.turnsUsed = 0; s.parseFails = 0; }   // a fresh window on resume (reference-harness parity)
    return s;
  }
  function clear(s) { if (s) { s.status = 'cleared'; } return s; }

  /* ============================ CONTINUATION PROMPT ============================
     The next-turn message fed back to the agent — a plain user-role directive, NO system-prompt mutation and NO
     toolset swap (prompt caching + the moat's real-prop reach stay intact). Carries the goal, any subgoals, and
     the judge's reason so the agent knows why it's still going. */
  const CONT_HEAD = '[Continuing toward your session goal]\nGoal: ';
  // the head every goal step stored BEFORE the org pass carries (0.13.2 / 0.13.3 / the 0.13.5 candidate wrote "standing goal"):
  // a saved session replays those steps too, so the READER accepts both heads; only CONT_HEAD is ever written
  const CONT_HEAD_RE = /^\[Continuing toward your (?:session|standing) goal\]\nGoal: /;
  const CONT_SUBS = '\n\nAdditional criteria the Commander added:\n';
  const CONT_TAIL = '\n\nContinue working toward this goal. ';
  function continuationPrompt(s) {
    if (!isActive(s)) return null;
    let p = CONT_HEAD + s.goal + '\n\n';
    if (s.subgoals.length) {
      p += 'Additional criteria the Commander added:\n'
        + s.subgoals.map((t, i) => '- ' + (i + 1) + '. ' + t).join('\n') + '\n\n'
        + 'Continue working toward the goal AND every criterion. Take the next concrete step. '
        + 'If the goal and all criteria are complete, say so explicitly and stop. '
        + 'If you are blocked and need input, say so clearly and stop.';
    } else {
      p += 'Continue working toward this goal. Take the next concrete step. '
        + 'If you believe the goal is complete, state so explicitly and stop. '
        + 'If you are blocked and need input from the user, say so clearly and stop.';
    }
    return p;
  }
  /* WHICH GOAL a continuation turn works toward — or null when `text` is not one (org P29-sys, 2026-10-14). The prompt
     above rides the wire as a user-role turn, but the Commander never typed it: COMMS shows a goal step as ONE station line
     naming the goal, live and when the history is replayed, so it reads the stored turn's own text (no flag on the turn,
     nothing new on the wire). */
  function continuationGoal(text) {
    const t = String(text == null ? '' : text);
    const head = CONT_HEAD_RE.exec(t);
    if (!head) return null;
    const rest = t.slice(head[0].length);
    const cuts = [rest.indexOf(CONT_SUBS), rest.indexOf(CONT_TAIL)].filter(i => i >= 0);
    if (!cuts.length) return null;
    const goal = rest.slice(0, Math.min.apply(null, cuts)).trim();
    return goal || null;
  }
  /* THE ONE TURN-LEVEL PREDICATE every history reader shares (org P29-sys wiring, 2026-10-14): the goal a stored history
     turn works toward when it is a goal step, else null. Only a user-role turn the Commander's own page sent can be one —
     a delegated brief (m.from) keeps its own speaker. COMMS, the rail excerpt, export, the HUD + desk screen task and
     station.read_session (the page's handler AND the overseer's, sidecar/overseer.js readSessionTurns, which the interactive
     lead's session.peek reaches) all ask THIS, so a goal step never reads as the Commander's words on any surface. */
  function stepOfTurn(m) {
    if (!m || m.role !== 'user' || m.from || typeof m.content !== 'string') return null;
    return continuationGoal(m.content);
  }

  /* ============================ THE JUDGE PROMPT ============================
     A reason-only aux call (chat.js runs it through the same internal:true Harness.chat path pitchstore/goalstore
     use). System + user text are pure functions of the state + the last reply so they're deterministic + testable. */
  const JUDGE_SYSTEM =
    'You are a strict judge deciding whether an autonomous agent has achieved a user\'s stated goal. '
    + 'You receive the goal text and the agent\'s most recent response. Decide one verdict.\n\n'
    + 'DONE — the goal is fully satisfied: the response confirms completion, shows the final deliverable was '
    + 'produced, OR explains the goal is unachievable / blocked / needs user input (treat a genuine block as DONE '
    + 'with a reason describing it).\n'
    + 'CONTINUE — not done, and there is a concrete next step the agent can take right now. This is the default '
    + 'when in doubt.\n\n'
    + 'Reply ONLY with a single JSON object on one line, no prose, no code fence:\n'
    + '{"verdict": "done", "reason": "<one sentence>"}  or  {"verdict": "continue", "reason": "<one sentence>"}';

  function judgeUser(s, lastResponse, opts) {
    opts = opts || {};
    const resp = clamp(lastResponse, RESP_SNIPPET);
    let u = 'Goal:\n' + s.goal + '\n\n';
    if (s.subgoals.length) {
      u += 'Additional criteria the user added (ALL must also be satisfied for DONE):\n'
        + s.subgoals.map((t, i) => '- ' + (i + 1) + '. ' + t).join('\n') + '\n\n';
    }
    u += 'Agent\'s most recent response:\n' + resp + '\n\n';
    if (opts.now) u += 'Current time: ' + opts.now + '\n\n';
    if (s.subgoals.length) {
      u += 'For EACH criterion, require concrete evidence in the response — do not accept generic phrases like '
        + '"all requirements met". If ANY criterion lacks specific evidence, the goal is NOT done → continue.\n\n';
    }
    u += 'Is the goal satisfied — done or continue?';
    return u;
  }

  /* ============================ THE STATE MACHINE: evaluate after a turn ============================
     Called once per completed turn with the judge's parsed verdict (or a preempt flag). Mutates the state and
     returns a decision the caller drives the next turn from. NO model call here — chat.js does the judge round-
     trip and hands us the parsed { verdict, reason, parseFailed }; keeping the model out makes this fully pure.

     `preempt: true` means a REAL user message just took this turn (not a continuation we queued) — their message
     wins, so we PAUSE the loop for that turn and fire no continuation. We do NOT judge on a preempt (the user is
     steering now; the next continuation-driven turn re-judges normally after they hand back control).

     Decision keys:
       shouldContinue   — the caller should queue continuationPrompt as the next turn
       continuation     — that prompt (or null)
       verdict          — 'done' | 'continue' | 'paused' | 'inactive' | 'preempted'
       reason           — one-liner
       message          — a user-visible localLine (turn N/M + verdict), or '' when silent */
  function evaluate(s, judged, opts) {
    opts = opts || {};
    if (!isActive(s)) {
      return { shouldContinue: false, continuation: null, verdict: 'inactive', reason: 'no active goal', message: '' };
    }
    // a real user message preempts: pause for this turn, judge nothing, queue nothing. (They took the wheel.)
    if (opts.preempt) {
      pause(s, 'you took over — /goal resume to continue');
      return { shouldContinue: false, continuation: null, verdict: 'preempted', reason: 'user message preempted the loop',
        message: '⏸ session goal paused — you took over. /goal resume to continue.' };
    }
    const j = judged || { verdict: 'continue', reason: 'no verdict', parseFailed: true };
    s.turnsUsed += 1;
    s.lastTurnAt = +opts.now || s.lastTurnAt;
    s.lastVerdict = j.verdict;
    s.lastReason = j.reason;
    if (j.parseFailed) s.parseFails += 1; else s.parseFails = 0;   // any usable reply resets the streak

    if (j.verdict === 'done') {
      s.status = 'done';
      return { shouldContinue: false, continuation: null, verdict: 'done', reason: j.reason,
        message: '✓ session goal: judge says done — ' + j.reason };
    }
    // weak-judge guard: N unparseable replies in a row → auto-pause (don't burn the budget on garbage).
    if (s.parseFails >= MAX_PARSE_FAILS) {
      s.status = 'paused';
      s.pausedReason = 'the judge model returned unparseable output ' + s.parseFails + ' turns in a row';
      return { shouldContinue: false, continuation: null, verdict: 'paused', reason: s.pausedReason,
        message: '⏸ session goal paused — the judge isn\'t returning a JSON verdict (' + s.parseFails + ' turns). Try a stronger model, then /goal resume.' };
    }
    // budget backstop: spent the continuation budget → auto-pause (resumable).
    if (s.turnsUsed >= s.maxTurns) {
      s.status = 'paused';
      s.pausedReason = 'turn budget exhausted (' + s.turnsUsed + '/' + s.maxTurns + ')';
      return { shouldContinue: false, continuation: null, verdict: 'paused', reason: s.pausedReason,
        message: '⏸ session goal paused — ' + s.turnsUsed + '/' + s.maxTurns + ' turns used. /goal resume to keep going, /goal clear to stop.' };
    }
    // not done, budget + judge healthy → fire the next continuation.
    return { shouldContinue: true, continuation: continuationPrompt(s), verdict: 'continue', reason: j.reason,
      message: 'session goal: turn ' + s.turnsUsed + '/' + s.maxTurns + ' — judge: not yet, ' + j.reason };
  }

  /* ============================ STATUS LINE ============================ */
  function statusLine(s) {
    if (!s || s.status === 'cleared') return 'No session goal is set. Set one with /goal <text>.';
    const turns = s.turnsUsed + '/' + s.maxTurns + ' turns';
    const sub = s.subgoals.length ? (', ' + s.subgoals.length + ' subgoal' + (s.subgoals.length === 1 ? '' : 's')) : '';
    if (s.status === 'active') return '⊙ session goal (active, ' + turns + sub + '): ' + s.goal;
    if (s.status === 'paused') return '⏸ session goal (paused' + (s.pausedReason ? ' — ' + s.pausedReason : '') + ', ' + turns + sub + '): ' + s.goal;
    if (s.status === 'done') return '✓ session goal done (' + turns + sub + '): ' + s.goal;
    return 'session goal (' + s.status + ', ' + turns + sub + '): ' + s.goal;
  }

  return {
    DEFAULT_MAX_TURNS, MAX_PARSE_FAILS,
    parseVerdict, create, normalize, isActive, hasGoal,
    addSubgoal, pause, resume, clear,
    continuationPrompt, continuationGoal, stepOfTurn, judgeSystem: () => JUDGE_SYSTEM, judgeUser, evaluate, statusLine
  };
});
