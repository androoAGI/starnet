/* sidecar/stop-reason.js — one plain-English sentence for every way a run can END without a clean delivery.

   The run-end reasons (shared/events.js agent.run.end `reason`) are machine words: 'empty', 'max_iters', 'refusal'…
   Surfaces used to print them raw — Telegram "(stopped: empty)", a routine "run ended without completion: empty" —
   which a user reads as "it stopped for no reason" (2026-10-11 report: "they start a task and then stop repeatedly
   with no explanation as to why"). Every server-side surface that reports a stop asks here, so the same stop reads the
   same way on Telegram, Discord, routines and loops. COMMS keeps its own copy in frontend/app/friendlyerror.js
   (stopLine) because the browser never loads sidecar modules — keep the two in step.

   stopSentence(reason, extra) -> string | ''
     reason: agent.run.end reason. extra (optional): { finishReason, budgetScope, unpricedModel, unpricedCapTokens,
     subscriptionModel, subscriptionCapTokens, toolsRan (agent.tool_call count this run — 'empty' after tools is not
     "nothing was done"), unattended (a routine/loop: no conversation to say "continue" to, so the advice is to run it
     again — never RUN NOW by name, since loops have RESUME) }.
     '' for a clean end ('done' with no cut, 'clarifying') — nothing to explain. Never throws. */
'use strict';

function stopSentence(reason, extra) {
  const x = extra || {};
  const r = String(reason == null ? '' : reason);
  if (r === 'done' || r === 'clarifying') {
    if (x.finishReason === 'length') return x.unattended ? 'the reply was cut short by the model\'s output limit' : 'the reply was cut short by the model\'s output limit — say "continue" for the rest';
    if (x.finishReason === 'content_filter') return 'the model\'s output was filtered, so this reply is incomplete';
    return '';
  }
  if (r === 'empty') {
    // tools already ran (a file may be written): "nothing was done" would be false, and a blind retry could redo the work
    const ran = Math.floor(Number(x.toolsRan) || 0);
    if (ran > 0) return 'the model went silent after ' + ran + ' tool step' + (ran === 1 ? '' : 's') + ' and never gave a final answer — those steps may already have made changes; '
      + (x.unattended ? 'check them before you run it again, or switch model if it keeps happening' : 'say "continue" to have it finish, or switch model if it keeps happening');
    return x.unattended
      ? 'the model sent back an empty reply, so nothing was done — run it again, or switch model if it keeps happening'
      : 'the model sent back an empty reply, so nothing was done — say "continue" to try again, or switch model if it keeps happening';
  }
  if (r === 'max_iters') return x.unattended
    ? 'it reached the step limit before finishing — run it again, or split the task into smaller steps'
    : 'it reached the step limit before finishing — say "continue" to keep going';
  if (r === 'budget') {
    if (x.unpricedModel) {
      const cap = Number(x.unpricedCapTokens) > 0 ? Number(x.unpricedCapTokens).toLocaleString('en-US') + '-token' : 'token';
      // NOT the $ cap: a model with no known price is bounded in TOKENS (loop.js maxUnpricedTokens), and the $ setting
      // never reads it — so "raise your spend cap" was a door onto a room without the lever. Name the real knobs.
      return 'it reached the ' + cap + ' safety ceiling Agent OS puts on ' + x.unpricedModel + ', a model it has no price for — raising the $ spending limit does not change this. Switch to a priced model, or raise the ceiling with the STARNET_MAX_UNPRICED_TOKENS environment variable, or give the model a price with SKYNET_MODEL_PRICES';
    }
    if (x.subscriptionModel) {
      const cap = Number(x.subscriptionCapTokens) > 0 ? Number(x.subscriptionCapTokens).toLocaleString('en-US') + '-token' : 'token';
      // a Claude Code sign-in books $0 per turn: its run is bounded in TOKENS (loop.js maxSubscriptionTokens), not by the $ limits
      return 'it used the ' + cap + ' per-run ceiling Agent OS puts on your Claude subscription (' + x.subscriptionModel + ') — ' + (x.unattended ? 'run it again' : 'say "continue" to keep going') + ', or change the ceiling in SETTINGS › APP & BACKUP › Runtime limits, or with STARNET_MAX_SUBSCRIPTION_TOKENS';
    }
    return 'it hit a spending limit (SETTINGS › SPENDING LIMITS)';
  }
  if (r === 'cancelled') return 'it was cancelled before it finished';
  if (r === 'refusal') return 'the model declined the request';
  if (r === 'error') return 'it stopped on an error before it finished';
  if (!r) return 'it ended without reporting how it finished';
  return 'it stopped before finishing (' + r + ')';
}

/* The loop's own STOP messages (agent.run.error) are written for triage — "loop guard: fs_read failed 3 times with
   identical arguments — stopping a stuck loop". A person reads that as a crash. explainStop(message) -> { kind, text }
   | null turns each harness-authored stop into what happened + what to do. Provider/API failures are NOT here (their
   classifier is providers/errorClass.js). MIRRORED in frontend/app/friendlyerror.js (STOP_EXPLAINERS) because the
   browser never loads sidecar modules; test/stop-reason.test.js locks the two copies to the same words. */
const STOP_EXPLAINERS = [
  { kind: 'loop_stuck', re: /loop guard: (.+?) failed (\d+) times with identical arguments/i,
    text: m => 'The agent got stuck repeating one step: ' + m[1] + ' failed ' + m[2] + ' times in a row with the same input, so Agent OS stopped the run. Say what to try differently, or fix what that step needs, then ask again.' },
  { kind: 'unknown_tools', re: /loop breaker: the model called tools that do not exist \(([^)]*)\)/i,
    text: m => 'The model kept calling tools that don’t exist (' + m[1] + '), so Agent OS stopped the run. Try again, or switch to a stronger model.' },
  { kind: 'tool_keeps_failing', re: /loop breaker: (.+?) failed (\d+) times in a row/i,
    text: m => m[1] + ' kept failing (' + m[2] + ' times in a row, with different inputs), so Agent OS stopped this unattended run. Check its error, fix the cause, then run it again.' },
  { kind: 'no_progress', re: /loop breaker: (.+?) returned the identical result (\d+) turns in a row/i,
    text: m => m[1] + ' kept returning the same result (' + m[2] + ' turns in a row), so Agent OS stopped this unattended run as stuck. Check what it was waiting for, then run it again.' },
  { kind: 'incomplete_work', re: /Work is incomplete: the model kept announcing/i,
    text: () => 'The agent stopped before finishing: it kept saying what it would do next without actually doing it. Say "continue" to push it on, or switch to a stronger model.' },
  { kind: 'memory_unverified', re: /memory update is unverified|promise to remember above is unverified/i,
    text: () => 'The agent said it saved (or would remember) something, but nothing was written to memory — it will not remember this next time. Ask it again to save it.' },
  { kind: 'output_limit', re: /hit the model's output limit while writing a large (\S+) call/i,
    text: m => 'The reply hit the model’s output limit while writing a large ' + m[1] + ' call, so it never ran and nothing from it was saved. Ask for it in smaller parts (for example "write it section by section"), or switch to a model with a larger output limit.' },
  { kind: 'checkpoint_failed', re: /run checkpoint failed/i,
    text: () => 'Agent OS couldn’t save this run’s progress to disk, so it stopped rather than risk losing work. Check free disk space, then try again.' },
  { kind: 'hook_blocked', re: /blocked by your hook(?: `([^`]*)`)?: ?(.*)$/i,
    text: m => 'Your hook' + (m[1] ? ' `' + m[1] + '`' : '') + ' blocked this run' + (m[2] ? ': ' + m[2].replace(/\.\s*$/, '') : '') + '. Change or turn off that hook to let it run.' },
  { kind: 'context_overflow', re: /context still too large after compacting/i,
    text: () => 'This conversation got too long for the model, even after Agent OS compacted it. Start a fresh conversation, or switch to a model with a larger context window.' }
];
function explainStop(message) {
  const s = String(message == null ? '' : message);
  if (!s) return null;
  for (const e of STOP_EXPLAINERS) {
    const m = s.match(e.re);
    if (m) return { kind: e.kind, text: e.text(m) };
  }
  return null;
}

// The routine/loop settlement line: the plain sentence first, the machine reason kept in brackets for triage. Every
// caller is an unattended run (routine fire, Run Now, loop step), so the advice never says "continue" to a missing chat.
function incompleteRunMessage(reason, extra) {
  const r = String(reason == null ? '' : reason).trim();
  const plain = stopSentence(r || '', Object.assign({}, extra, { unattended: true })) || 'it ended without a clean finish';
  return 'run ended without completion — ' + plain + ' [' + (r || 'missing terminal outcome') + ']';
}

module.exports = { stopSentence, incompleteRunMessage, explainStop, STOP_EXPLAINERS };
