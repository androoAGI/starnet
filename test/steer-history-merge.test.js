/* node test/steer-history-merge.test.js — a steered reply survives the canonical transcript merge ONCE, with its note.

   A steering note folded mid-run (/steer or a queued pill's SEND NOW) streams into the local reply as a
   '\n[steering] …\n' line; the sidecar's durable transcript stores only the model's own turns. The merge matched
   twins on exact bytes, so the steered local row never found its durable twin and a reload showed the reply TWICE
   (live walk 2026-10-14). Twins now match without the steering lines, and the local row — which still carries the
   note so renderHistory can redraw it as its own dim row — is the one kept. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const merge = new Function(A.fnBody(source, 'function mergeCanonicalHistory(local, turns)') + '; return mergeCanonicalHistory;')();

// single durable turn: one row, steer line kept, durable identity enriched onto it
{
  const out = merge([
    { role: 'user', content: 'run the slow job', sourceRunId: 'r1' },
    { role: 'assistant', content: '\n[steering] use the blue folder\nDone with the blue folder.', sourceRunId: 'r1' }
  ], [
    { role: 'user', content: 'run the slow job', sourceRunId: 'r1', rowId: 'u1' },
    { role: 'assistant', content: 'Done with the blue folder.', sourceRunId: 'r1', rowId: 'a1', ts: 5 }
  ]);
  const replies = out.filter(m => m.role === 'assistant');
  A.eq(replies.length, 1, 'a steered reply and its durable twin merge into ONE row');
  A.ok(/\[steering\] use the blue folder/.test(replies[0].content), 'the merged row keeps the steering note');
  A.eq(replies[0].rowId, 'a1', 'the durable identity enriches the local row');
}

// several durable turns (prose before a tool call, then the final answer): still one row, no re-inserts
{
  const out = merge([
    { role: 'user', content: 'go', sourceRunId: 'r2' },
    { role: 'assistant', content: 'Looking now.\n[steering] skip the tests\nFinished, tests skipped.', sourceRunId: 'r2' }
  ], [
    { role: 'user', content: 'go', sourceRunId: 'r2' },
    { role: 'assistant', content: 'Looking now.', sourceRunId: 'r2' },
    { role: 'assistant', content: 'Finished, tests skipped.', sourceRunId: 'r2' }
  ]);
  const replies = out.filter(m => m.role === 'assistant');
  A.eq(replies.length, 1, 'a steered multi-turn reply stays one row (its durable parts do not re-insert)');
  A.ok(/\[steering\] skip the tests/.test(replies[0].content), 'the aggregate row keeps the steering note');
}

// an unsteered aggregate still defers to the durable turns (unchanged behavior)
{
  const out = merge([
    { role: 'user', content: 'go', sourceRunId: 'r3' },
    { role: 'assistant', content: 'Looking now.Finished.', sourceRunId: 'r3' }
  ], [
    { role: 'user', content: 'go', sourceRunId: 'r3' },
    { role: 'assistant', content: 'Looking now.', sourceRunId: 'r3' },
    { role: 'assistant', content: 'Finished.', sourceRunId: 'r3' }
  ]);
  A.eq(out.filter(m => m.role === 'assistant').map(m => m.content), ['Looking now.', 'Finished.'], 'an unsteered aggregate still yields the durable turns');
}

// THE SAVED MERGE IS THE NEXT LOAD'S INPUT (0.13.5 review): reconcile saves the merged history (App.persist), and the
// steered row it kept now carries the first durable part's rowId. Every later load — the desk's second open, and the
// phone's every thread read (host.js mergeCanonical on that save) — must still find its span, or each durable part is
// inserted again beside it (and the phone's SEND feeds those twins into the model). Run on BOTH copies.
{
  const phone = fs.readFileSync(path.join(__dirname, '../sidecar/remote/host.js'), 'utf8');
  const phoneMerge = new Function(A.fnBody(phone, 'function mergeCanonical(local, turns)') + '; return mergeCanonical;')();
  for (const [who, fn] of [['desk', merge], ['phone', phoneMerge]]) {
    const durable = [
      { role: 'user', content: 'go', sourceRunId: 'r4', rowId: 17 },
      { role: 'assistant', content: 'Looking now.', sourceRunId: 'r4', rowId: 18 },
      { role: 'assistant', content: 'Finished, tests skipped.', sourceRunId: 'r4', rowId: 19 }
    ];
    let saved = [
      { role: 'user', content: 'go', sourceRunId: 'r4' },
      { role: 'assistant', content: 'Looking now.\n[steering] skip the tests\nFinished, tests skipped.', sourceRunId: 'r4' }
    ];
    for (let load = 1; load <= 3; load++) {
      saved = JSON.parse(JSON.stringify(fn(saved, durable)));   // what App.persist writes is what the next load reads
      const replies = saved.filter(m => m.role === 'assistant');
      A.eq(replies.length, 1, who + ' load ' + load + ': a steered multi-part reply stays ONE row: ' + JSON.stringify(replies.map(r => r.content)));
      A.ok(replies[0] && /\[steering\] skip the tests/.test(replies[0].content), who + ' load ' + load + ': the row keeps its steering note');
      A.eq(saved.filter(m => m.role === 'user').length, 1, who + ' load ' + load + ': the user turn stays one row');
    }
    // the single-part shape (the walk's case) is stable across loads too
    let one = [
      { role: 'user', content: 'run the slow job', sourceRunId: 'r5' },
      { role: 'assistant', content: '\n[steering] use the blue folder\nDone.', sourceRunId: 'r5' }
    ];
    const durableOne = [{ role: 'user', content: 'run the slow job', sourceRunId: 'r5', rowId: 1 }, { role: 'assistant', content: 'Done.', sourceRunId: 'r5', rowId: 2 }];
    for (let load = 1; load <= 3; load++) one = JSON.parse(JSON.stringify(fn(one, durableOne)));
    A.eq(one.filter(m => m.role === 'assistant').length, 1, who + ': a steered single-part reply stays one row after three loads');
    // an unsteered durable row that happens to equal two parts joined is still left alone (the rowId rule stands for it)
    const twin = fn([{ role: 'user', content: 'go', sourceRunId: 'r6' }, { role: 'assistant', content: 'A.B.', sourceRunId: 'r6', rowId: 9 }],
      [{ role: 'user', content: 'go', sourceRunId: 'r6' }, { role: 'assistant', content: 'A.', sourceRunId: 'r6', rowId: 7 }, { role: 'assistant', content: 'B.', sourceRunId: 'r6', rowId: 8 }, { role: 'assistant', content: 'A.B.', sourceRunId: 'r6', rowId: 9 }]);
    A.eq(twin.filter(m => m.role === 'assistant').map(m => m.content), ['A.', 'B.', 'A.B.'], who + ': a durable row is never folded into its neighbours');
  }
}

// a multi-line SEND NOW reaches the run as ONE line (sendQueuedNow's wire), so its echo is one steering line here too
{
  const out = merge([
    { role: 'user', content: 'go', sourceRunId: 'r7' },
    { role: 'assistant', content: '\n[steering] use the blue folder and skip the tests\nDone.', sourceRunId: 'r7' }
  ], [{ role: 'user', content: 'go', sourceRunId: 'r7' }, { role: 'assistant', content: 'Done.', sourceRunId: 'r7', rowId: 3 }]);
  A.eq(out.filter(m => m.role === 'assistant').length, 1, 'a collapsed multi-line note twin-matches on the first load');
}

// renderHistory redraws the note as its own steer-echo row, never as agent prose
const rh = A.fnBody(source, 'function renderHistory(onlyTurns)');
A.ok(/\(\?:\^\|\\n\)\\\[steering\\\] \(\[\^\\n\]\*\)\\n\?/.test(rh), 'renderHistory splits steering lines out of the reply');
// …and it is the COMMANDER's row (Andrew 10-26: the note sat under the agent's name, so the agent read as saying it). One
// builder for the live echo and both replay paths: steerRow, a 'user' row labelled MID-RUN, the wire marker stripped.
const sr = A.fnBody(source, 'function steerRow(text, stamp)');
A.ok(sr.length > 40 && sr.length < 800, 'steerRow located');
A.ok(/row\('user', \{ stamp: stamp, brief: 'COMMANDER · MID-RUN' \}\)/.test(sr) && /classList\.add\('steer-echo'\)/.test(sr), 'a steering note is a Commander row labelled MID-RUN');
A.ok(/steerRow\(parts\[pi\], stamp\)/.test(rh) && /steerRow\(m\.content, stamp\)/.test(rh), 'both replay paths draw it with steerRow');
A.ok(/steerRow\(text, true\)/.test(A.fnBody(source, 'function steerNote(text)')), 'and so does the live stream');

/* A NOTE THE RUN READ, SHOWN AFTER A RELOAD (live walk 2026-10-14). A reload cancels the run before its reply is saved, so the
   note's echo existed nowhere: the page asks the station (GET /api/run/steer) and, for a note the run read, files ONE
   station row { sys, steerEcho, content: '[steering] …', sourceRunId } after that run's dialogue (chat.js showSentNowRead).
   That row is the page's own: both merges keep it exactly once across loads, and renderHistory draws it as the same dim
   steer-echo row the live stream drew — never a plain station line, never the agent's prose, never model context (sys). */
{
  const phone = fs.readFileSync(path.join(__dirname, '../sidecar/remote/host.js'), 'utf8');
  const phoneMerge = new Function(A.fnBody(phone, 'function mergeCanonical(local, turns)') + '; return mergeCanonical;')();
  const durable = [
    { role: 'user', content: 'run the slow job', sourceRunId: 'r9', rowId: 1 },
    { role: 'assistant', sys: true, error: true, transcriptPending: true, sourceRunId: 'r9', dispatchState: 'page-closed', content: '■ the run ended when this page closed' }
  ];
  for (const [who, fn] of [['desk', merge], ['phone', phoneMerge]]) {
    let saved = [
      { role: 'user', content: 'run the slow job' },
      { role: 'system', sys: true, steerEcho: true, content: '[steering] use the blue folder', sourceRunId: 'r9', ts: 4 }
    ];
    for (let load = 1; load <= 3; load++) {
      saved = JSON.parse(JSON.stringify(fn(saved, durable)));
      A.eq(saved.filter(m => m.steerEcho).map(m => m.content), ['[steering] use the blue folder'], who + ' load ' + load + ': the read note stays ONE row');
      A.eq(saved.filter(m => m.role === 'user').length, 1, who + ' load ' + load + ': the directive stays one row');
    }
  }
  // LIVE WALK (2026-10-14, this lane): a reload mid-run saves no copy of the run's own directive, so the transcript
  // INSERTS it after the last row it matched — which put the next run's directive between an earlier run and its filed
  // echo ("do the slow job" · "do the slow job again" · [steering] use the blue folder). A run's own station rows stay
  // with that run; a later run's turns go after them. Its own turns still come first.
  for (const [who, fn] of [['desk', merge], ['phone', phoneMerge]]) {
    const saved = [
      { role: 'user', content: 'do the slow job', sourceRunId: 'rA', rowId: 1 },
      { role: 'system', sys: true, steerEcho: true, content: '[steering] use the blue folder', sourceRunId: 'rA', ts: 4 }
    ];
    const turns = [
      { role: 'user', content: 'do the slow job', sourceRunId: 'rA', rowId: 1 },
      { role: 'assistant', content: 'Halfway there.', sourceRunId: 'rA', rowId: 2 },
      { role: 'user', content: 'do the slow job again', sourceRunId: 'rB', rowId: 5 },
      { role: 'assistant', content: 'On it.', sourceRunId: 'rB', rowId: 6 }
    ];
    let out = saved;
    for (let load = 1; load <= 2; load++) {
      out = JSON.parse(JSON.stringify(fn(out, turns)));
      A.eq(out.map(m => m.content), ['do the slow job', 'Halfway there.', '[steering] use the blue folder', 'do the slow job again', 'On it.'],
        who + ' load ' + load + ': the echo stays with its own run, ahead of the next run\'s directive');
    }
    // a station row with no run (and a row of another run) keeps the old placement
    const plain = fn([{ role: 'user', content: 'go', sourceRunId: 'rC', rowId: 1 }, { role: 'system', sys: true, content: '⚒ built while you were away' }],
      [{ role: 'user', content: 'go', sourceRunId: 'rC', rowId: 1 }, { role: 'user', content: 'next', sourceRunId: 'rD', rowId: 2 }]);
    A.eq(plain.map(m => m.content), ['go', 'next', '⚒ built while you were away'], who + ': a station row without a run keeps its old place');
  }
  // the real renderHistory over that row
  const made = [], toolLines = [], sysLines = [];
  const ctx = require('vm').createContext({
    activeWs: { id: 'ws1', history: [] }, renderingHistory: false,
    row: (cls, o) => { const r = { cls, o, d: { cls: [], classList: { add: (...c) => r.d.cls.push(...c) } }, body: {} }; made.push(r); return r; },
    toolLine: (t, e) => toolLines.push(t), sysLine: (t, e) => sysLines.push(t), trimMarkerLine: () => {}, goalStepOf: () => null, goalStepLine: () => {}, addUser: () => {},
    turnFileRefs: () => [], renderProse: (b, t) => { b.text = t; }, replayableDeliverables: () => [], replayDeliverableRow: () => {},
    offerTryAgain: () => {}, offerRetry: () => {}, isBusy: () => false
  });
  require('vm').runInContext(sr + ';\n' + rh + ';\nrenderHistory([{ role: "user", content: "go" }, { role: "system", sys: true, steerEcho: true, content: "[steering] use the blue folder", sourceRunId: "r9", ts: 4 }, { role: "assistant", sys: true, content: "■ a station line" }, { role: "assistant", sys: true, steerEcho: true, content: "[steering] an earlier draft row", sourceRunId: "r8", ts: 5 }, { role: "assistant", content: "Looking.\\n[steering] skip the tests\\nDone.", ts: 6 }]);', ctx);
  const echoRows = made.filter(r => r.d.cls.includes('steer-echo'));
  A.eq(echoRows.map(r => [r.cls, r.body.textContent, r.o.stamp, r.o.brief]), [['user', 'use the blue folder', 4, 'COMMANDER · MID-RUN'], ['user', 'an earlier draft row', 5, 'COMMANDER · MID-RUN'], ['user', 'skip the tests', 6, 'COMMANDER · MID-RUN']],
    'a filed read note (the station-row shape, role system + sys) replays as the Commander\'s MID-RUN row, stamped when it was sent — a row filed in the first draft shape (role assistant) too, and a note saved inside a reply');
  A.eq(made.filter(r => r.cls === 'agent').map(r => r.body.text), ['Looking.', 'Done.'], 'the agent keeps only its own prose around the note');
  // a plain station row replays in the SYSTEM register its live line drew (chat.js sysLine, old-UI review 10-26 #3), not
  // through toolLine as agent prose
  A.eq(sysLines, ['■ a station line'], 'and never as a plain station line (other station rows are unchanged)');
  A.eq(toolLines, [], 'a saved station row is never drawn as an agent tool row');
}

A.report('steer-history-merge.test');
