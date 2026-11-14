/* sidecar/finish-line.js — immutable task-completion doctrine.

   Agent identity/purpose/manual are Commander-editable and may be old on autonomous surfaces. The host's
   execution contract cannot live only there. runOnce appends this compact block at the final prompt seam for
   every real task, after the editable identity and against the live tool grant. It grants no authority; it tells
   the model how relentlessly to use the authority it already has, and where it must stop honestly. */
'use strict';

const MARKER = '## FINISH THE JOB';

function block(opts) {
  opts = opts || {};
  const tools = new Set((Array.isArray(opts.tools) ? opts.tools : []).map(x => String(x || '').replace(/_/g, '.')));
  const lines = [
    MARKER,
    'Keep working until the requested result is actually complete and verified. The deliverable is the real result backed by tool output, not a plan, a promise, a workaround for the Commander to assemble, or a description of what you would do.',
    'Use tools whenever they materially improve correctness or completeness. If a tool returns empty, partial, stale, or failed output, inspect the exact failure and try a different query, arguments, strategy, or tool before giving up. Never repeat an identical failing call blindly.'
  ];
  if (tools.has('tool.search')) {
    lines.push('Before claiming a capability is missing, use tool.search to discover deferred tools and alternate routes that the live station has granted. A tool not shown in the first row may still be available through search.');
  }
  if (tools.has('browser.login')) {
    lines.push('When a website genuinely requires authentication and the Commander is watching, use browser.login: it opens the station\'s visible, dedicated Chrome window for the Commander to sign in themselves, then returns you to the authenticated headless session. Do not replace that first-class path with command-line or remote-debugging setup instructions.');
  }
  lines.push(
    'Act on the obvious safe interpretation instead of asking how to begin. Ask the Commander only for irreducible human input or a decision that cannot be retrieved and would materially change the action; credentials, MFA, and explicit consent stay with them.',
    'Exhaust safe, authorized, in-scope alternatives before reporting a blocker. Never bypass consent, widen scope, expose secrets, or control the Commander\'s personal browser/profile without the specific authority the harness provides.',
    'Before finishing, verify that every requested requirement is satisfied and report only what real execution proved. If the real path remains blocked after alternatives are exhausted, state the exact blocker and what you tried. Never fabricate output or success.'
  );
  return lines.join('\n');
}

/* opts.restated (cost audit W3.9b, STARNET_PREFIX_DOCTRINE): the caller left out of its own text the sentences this
   block says again (rides: the one test of whether it may). The block must then close the prompt, so a base that
   already quotes the heading (a persona, a recipe) no longer stops the append. Absent or false: as before. */
function append(system, opts) {
  const base = String(system || '');
  opts = opts || {};
  if (!rides(opts) || (base.indexOf(MARKER) >= 0 && opts.restated !== true)) return base;
  const doctrine = block(opts);
  return base + (base.trim() ? '\n\n' : '') + doctrine;
}

// whether this block closes a run's prompt at all: a real task that is not internal self-talk. The same test append
// applies, for a caller that drops a sentence only because the block restates it.
function rides(opts) {
  return !!(opts && opts.isTask && !opts.internal);
}

/* THE SENTENCES THE BLOCK RESTATES. [HARNESS] HOW TO WORK (index.js taskDoctrineNote) opens with three sentences this
   block says again, last and in more words: what the deliverable is, keep acting until done or honestly blocked, and
   never repeat a failing call. Each entry is the HOW TO WORK sentence and the lines of this block that carry it; a
   run that rides this block may leave those sentences out of HOW TO WORK (never out of here: the last position is
   deliberate). test/prefix-lanes.test.js holds every entry to both texts. */
const RESTATED = Object.freeze([
  Object.freeze({ howToWork: 'the deliverable is a real outcome proven by real tool output — never a description, a plan, or a promise of future action. ',
    here: Object.freeze(['The deliverable is the real result backed by tool output, not a plan, a promise, a workaround for the Commander to assemble, or a description of what you would do.']) }),
  Object.freeze({ howToWork: 'Act with tools NOW and keep going until the task is done or genuinely blocked; if blocked, say so honestly and try a different path — NEVER invent output you did not produce. ',
    here: Object.freeze(['Keep working until the requested result is actually complete and verified.', 'Use tools whenever they materially improve correctness or completeness.',
      'Exhaust safe, authorized, in-scope alternatives before reporting a blocker.',
      'If the real path remains blocked after alternatives are exhausted, state the exact blocker and what you tried. Never fabricate output or success.']) }),
  Object.freeze({ howToWork: 'A tool error is information: read it and change strategy — never repeat the identical failing call. ',
    here: Object.freeze(['If a tool returns empty, partial, stale, or failed output, inspect the exact failure and try a different query, arguments, strategy, or tool before giving up. Never repeat an identical failing call blindly.']) })
]);

module.exports = { MARKER, block, append, rides, RESTATED };
