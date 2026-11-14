'use strict';
/* sidecar/batch-hint.js — THE BATCHING SENTENCE (cost audit W2.3, 2026-11-14).

   THE COST. Every wire takes several tool calls in one reply, and the loop runs all of a reply's calls before it asks the
   model again, so each call a model sends alone re-sends the whole prompt once more. No line in the task prompt said so.
   On the station the audit measured, codex runs averaged 1.14 to 1.18 calls per reply and todo rode alone in 519 of 531
   calls; runs of single read calls that could have shared a reply came to about 5.6% of all raw tokens (upper bound).

   THE SENTENCE. One line at the end of the task doctrine (index.js taskDoctrineNote, the HOW TO WORK block every task run
   with tools carries, on every wire). It asks for INDEPENDENT calls together and names what must wait: a call whose
   ARGUMENTS depend on a result the model has not seen. The wording is chosen against the rest of the prompt:
     - brief_proceed rides in the same response as the first write (W1.2, taskbrief-tools.js): a write's arguments do not
       depend on the settle's result, so this line never tells the model to split them;
     - "inspect before editing" (the work-discipline note) still holds: an edit's arguments depend on the read;
     - how a batch RUNS is unchanged and unsaid: a batch of parallel-safe reads runs together, any other batch runs in the
       order listed with the brief calls first (index.js parallelSafe / PARALLEL_UNSAFE_FAMILY, loop.js executeCalls).
   The todo clause rides only when the run has the todo tool on its wire: the prompt never names a tool a run lacks. No
   per-run value is in it, so it sits in the cached prefix like the doctrine around it.

   THE SWITCH. STARNET_BATCH_HINT, read in one place (index.js batchHintOn, through ENV()). '1' is on. Unset, blank, '0'
   and every other value are off, and off adds nothing: line() returns '' and the prompt is byte-identical to before. Off
   by default until an A/B on real models shows they do not start batching calls that depend on each other.
   Pure: no environment, no clock. */

// the switch's VALUE as ENV('BATCH_HINT') read it: only '1' turns the sentence on
function on(value) {
  return typeof value === 'string' && value.trim() === '1';
}

const TODO_CLAUSE = ', a todo update alongside the next real call';
function sentence(has) {
  return 'When you need several independent things (file reads, searches, listings' + (has && has.todo ? TODO_CLAUSE : '')
    + '), request them together in one reply rather than one per reply; a call whose arguments depend on a result you have not seen yet waits for the next reply. ';
}

// What the task doctrine appends. enabled: batchHintOn(); has.todo: the todo tool is on this run's wire.
function line(enabled, has) {
  return enabled === true ? sentence(has) : '';
}

module.exports = { on, line, sentence };
