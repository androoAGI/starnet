'use strict';
/* node test/selectable-windows-87.test.js — #87 stays fixed: what a station window SAYS can be selected and copied, and
   DELIVERABLES' OPEN THE FULL CONVERSATION really opens the run's conversation (fixed in bba85b23a, no lock until now).

   1. frontend/css/app.css: `.term-body` selects as text (it inherited the game chrome's `user-select: none`, so a
      workflow's result, a deliverable's WHAT CAME BACK and a dossier could not be copied), while its controls —
      buttons, summaries, labels, selects, role=button rows, draggable cards, .bb keys — stay unselectable so a
      drag-select copies prose, not captions. Rules are parsed (comments stripped), not grepped.
   2. frontend/app/deliverables.js: the OPEN THE FULL CONVERSATION branch is RUN against fakes. It must go through
      ReturnStore.openWork (adopt the stream + fold its durable transcript), never a bare App.openWorkstream, which
      silently no-ops on a stream the COMMS rail never adopted (a workflow step's, a routine's) — the #87 dead button. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', 'frontend', rel), 'utf8');

/* ---- 1. the CSS split: the words select, the controls never do ---- */
{
  const css = read('css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) rules.push({ sel: m[1].trim().replace(/\s+/g, ' '), decl: m[2], at: m.index });
  const userSelect = d => { const m = /(?:^|;)\s*user-select\s*:\s*([a-z-]+)/.exec(d); return m ? m[1] : null; };
  const own = rules.filter(r => r.sel.split(',').map(s => s.trim()).includes('.term-body') && userSelect(r.decl));
  A.ok(own.length >= 1, 'a .term-body rule sets user-select');
  const last = own[own.length - 1];
  A.eq(last && userSelect(last.decl), 'text', 'the LAST .term-body user-select rule is text (window prose can be selected and copied)');
  const controls = rules.filter(r => /^\.term-body :is\(/.test(r.sel) && userSelect(r.decl) === 'none');
  A.ok(controls.length === 1, 'one .term-body controls rule keeps them unselectable: ' + controls.map(r => r.sel).join(' | '));
  const list = controls[0] ? controls[0].sel : '';
  for (const s of ['button', 'summary', 'label', 'select', '[role="button"]', '[draggable="true"]', '.bb'])
    A.ok(list.includes(s), 'controls stay unselectable inside a window: ' + s);
  A.ok(controls[0] && last && controls[0].at > last.at, 'the controls rule follows the text rule, so it wins for the controls');
  // nothing later turns a window body back off as a whole
  A.ok(!rules.some(r => r.at > (last ? last.at : -1) && /(^|,\s*)(\.term|\.term-body)(\s*,|$)/.test(r.sel) && userSelect(r.decl) === 'none'),
    'no later rule switches a whole window body back to user-select: none');
}

/* ---- 2. OPEN THE FULL CONVERSATION opens it through the OUTBOX's open seam ---- */
{
  const src = read('app/deliverables.js');
  const block = A.fnBody(src, "if (b.dataset.act === 'session') {");
  A.ok(block.length > 200 && block.length < 3000, 'the OPEN THE FULL CONVERSATION branch is located (length guard)');
  const branch = new Function('b', 'r', 'say', 'ReturnStore', 'App', 'Workstreams', 'StationUI',
    'return (async () => { ' + block + '\n return "fell-through"; })();');
  const fakes = (over) => {
    const log = { said: [], opened: [], bare: [], conv: [] };
    const b = { dataset: { act: 'session' }, disabled: false };
    const App = { openWorkstream: sid => log.bare.push(sid) };
    const StationUI = { h: { workConversation: from => log.conv.push(from) } };
    const say = (t, bad) => { log.said.push({ t, bad: !!bad, disabledWhileSaying: b.disabled }); };
    return Object.assign({ log, b, App, StationUI, say, Workstreams: { get: () => null } }, over || {});
  };
  const row = { runId: 'run-wf-1', agentId: 'researcher', title: 'Morning brief', run: { streamId: 'ws-wf-1' } };
  (async () => {
    // a workflow step's stream (never adopted by the COMMS rail): ReturnStore adopts + opens it
    {
      const f = fakes();
      const RS = { openWork: async (w) => { f.log.opened.push(w); return true; } };
      await branch(f.b, row, f.say, RS, f.App, f.Workstreams, f.StationUI);
      A.eq(f.log.opened, [{ runId: 'run-wf-1', streamId: 'ws-wf-1', agentId: 'researcher', title: 'Morning brief' }], 'the run\'s stream goes through ReturnStore.openWork with its run, agent and title');
      A.eq(f.log.bare, [], 'never a bare App.openWorkstream (it no-ops on an unadopted stream)');
      A.eq(f.log.conv, ['deliverables'], 'the conversation opens, remembering it came from DELIVERABLES');
      A.ok(f.b.disabled === false && f.log.said.length === 0, 'no error line, and the button is live again');
    }
    // the transcript is gone: say so, never pretend it opened
    {
      const f = fakes();
      await branch(f.b, row, f.say, { openWork: async () => false }, f.App, f.Workstreams, f.StationUI);
      A.ok(f.log.said.length === 1 && f.log.said[0].bad && /Could not read that conversation/.test(f.log.said[0].t), 'a transcript that is gone says so: ' + JSON.stringify(f.log.said));
      A.eq(f.log.conv, [], 'and nothing claims to have opened it');
      A.ok(f.b.disabled === false, 'the button is re-enabled after a miss');
    }
    // openWork throwing is a miss, not an uncaught page error
    {
      const f = fakes();
      await branch(f.b, row, f.say, { openWork: async () => { throw new Error('boom'); } }, f.App, f.Workstreams, f.StationUI);
      A.ok(f.log.said.length === 1 && /Could not read that conversation/.test(f.log.said[0].t) && f.log.conv.length === 0, 'a failed open says it could not read the conversation');
    }
    // a run that never recorded a stream says that
    {
      const f = fakes();
      await branch(f.b, { runId: 'r', run: {} }, f.say, { openWork: async () => { throw new Error('must not be called'); } }, f.App, f.Workstreams, f.StationUI);
      A.ok(f.log.said.length === 1 && /did not record a session/.test(f.log.said[0].t), 'no recorded session is named as such');
    }
    // the bare fallback (no ReturnStore on this page) only opens a stream the rail actually has
    {
      const f = fakes();
      await branch(f.b, row, f.say, undefined, f.App, { get: () => null }, f.StationUI);
      A.ok(f.log.bare.length === 0 && /Could not read that conversation/.test((f.log.said[0] || {}).t || ''), 'without ReturnStore an unknown stream is never "opened" by a no-op');
      const g = fakes();
      await branch(g.b, row, g.say, undefined, g.App, { get: sid => (sid === 'ws-wf-1' ? { id: sid } : null) }, g.StationUI);
      A.ok(g.log.bare.length === 1 && g.log.conv.length === 1, 'without ReturnStore a stream the rail has opens directly');
    }
    A.report('selectable-windows-87.test');
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
