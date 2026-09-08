/* sidecar/tools/builtin/deliverable.js — the agent NAMES its own finished work.

   A run's artifacts ledger already proves WHAT files were written (sidecar/artifacts.js, folded from real tool
   results). What it cannot know is what the work was FOR: "output.md" is a true name and a useless one. This tool
   lets the agent supply the missing prose — a plain-English title, a one-line description, and which file is the
   point — so the Deliverables library can show a person what they got instead of a basename.

   THE LINE THIS TOOL EXISTS TO HOLD: the agent may NAME and DESCRIBE its work. It may never ASSERT that the work
   is complete, correct, verified, or that anyone else helped. Status, crew, byte counts and timings are harness
   truth, derived elsewhere (runstore + deliverable-provenance) and rendered as pills the prose cannot contradict.
   So the accepted keys are an allowlist of four, and everything else a model sends is dropped in silence rather
   than honored. A model that passes status:'kept' or verified:true must have those keys VANISH — if they could
   ride through, this tool would become the app's most convincing lie surface, because the deliverables card is
   the surface a user trusts most.

   The description below is deliberately worded to ask for a DESCRIPTION, never a VERDICT. "Say what it is" gets a
   noun phrase; "summarize what you completed" gets a claim, and the card would carry a sentence the harness
   cannot back.

   makeDeliverableTool({ notes }) -> { deliverableTool, register(reg) }
     notes : { set(runId, note), get(runId) }  — a bounded per-run bag the host drains at run end. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).deliverable = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A Set, not an object literal: this is tested against a MODEL-SUPPLIED string, and `({doc:1})['constructor']`
  // is truthy — the same prototype-key trap deliverable-store.js and todo.js each document.
  const KINDS = new Set(['doc', 'data', 'page', 'patch', 'image', 'files']);
  const TITLE_MAX = 80, SUMMARY_MAX = 240, PATH_MAX = 260;

  function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

  /* The allowlist. Four keys in, four keys out — anything else the model sent is not copied. This is written as an
     explicit construction rather than a delete-list precisely so a future key cannot arrive by accident. */
  function noteOf(args) {
    args = (args && typeof args === 'object') ? args : {};
    const title = text(args.title, TITLE_MAX);
    if (!title) return null;                      // an untitled note is not worth recording
    const kind = String(args.kind || '').trim().toLowerCase();
    return {
      title: title,
      summary: text(args.summary, SUMMARY_MAX),
      kind: KINDS.has(kind) ? kind : 'files',
      main: text(args.main, PATH_MAX)             // a CLAIM about which file matters; the host proves it against
                                                  // the artifacts ledger and drops it when it names nothing real
    };
  }

  function makeDeliverableTool(deps) {
    deps = deps || {};
    const notes = deps.notes;
    if (!notes) throw new Error('deliverable.js requires { notes }');

    const deliverableTool = {
      // NO consent gate and NO capability requirement: this writes no file, reaches no network, and has no outward
      // effect — it labels work the run already did. Gating it would mean the runs most in need of a readable name
      // (a plain chat run with no cabinet) are exactly the ones that could never supply one.
      name: 'deliverable_note', capability: 'deliverable', scope: 'write', requiresConsent: false, timeoutMs: 5000,
      description: 'Name the work you produced in this task, so the Commander can find it later in DELIVERABLES. '
        + 'Optional: call this ONCE, at the end, only when you actually created or changed files. Skip it when the user limits actions, says no further actions, or asks you to stop after the requested change. '
        + 'title: a short plain-English name for the thing you made (not a filename). '
        + 'summary: one sentence saying what it is, in the same plain language. '
        + 'kind: doc | data | page | patch | image | files. '
        + 'main: the path of the one file that IS the deliverable, if one of them is. '
        + 'Describe the work — do not judge it. Whether the run succeeded, what it cost, who worked on it and '
        + 'which files exist are recorded by the station from the run itself; anything you say about those is ignored.',
      schema: { type: 'object', required: ['title'], properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        kind: { type: 'string', enum: ['doc', 'data', 'page', 'patch', 'image', 'files'] },
        main: { type: 'string' }
      } },
      run: async (args, ctx) => {
        const runId = String((ctx && ctx.runId) || '');
        const note = noteOf(args);
        if (!note) return { content: 'Nothing recorded: a deliverable needs a title.', summary: 'no title' };
        if (!runId) return { content: 'Nothing recorded: this run has no id to file the work under.', summary: 'no run' };
        notes.set(runId, note);
        // Tell the agent exactly what was kept, so it neither re-calls the tool nor believes it recorded more
        // than it did. Truthful telemetry applies to what we say to the MODEL too, not just to the screen.
        return {
          content: 'Recorded for the Deliverables library: "' + note.title + '" (' + note.kind + ').'
            + (note.summary ? ' Description: ' + note.summary : ' No description given.')
            + ' The station will attach the real file list, status, cost and crew from this run.',
          summary: note.title
        };
      }
    };

    return { deliverableTool, register(reg) { reg.register(deliverableTool); return reg; } };
  }

  return { makeDeliverableTool, KINDS, _internals: { noteOf, text } };
});
