/* node test/routine-spend-pause-words.test.js — B1's carry-overs: the HUD toast and the NEEDS YOU door say what is true.

   Stabilization plan C0-5, B1. A fire StarNet's spend check paused or refused (failureCode spend_history_unavailable: spend
   history incomplete, an open spend item) no longer counts toward the auto-pause, so the routine stays on its schedule and
   every fire ends the same way until the item is settled with COUNT AS. Two surfaces still said otherwise:
     1. the HUD toast (frontend/app/world.js, the cron.result listener, sliced whole and run) said "✕ routine failed — error":
        it now names the spend-check pause, COUNT AS and SETTINGS › SPENDING LIMITS; every other failure reads as before;
     2. the NEEDS YOU routine row's door read "in ROUTINES", a place that is no door any more and not where the row goes: the row
        opens the fire's own session (NeedsYou open -> App.openWorkstream), so it names that session as the SESSIONS rail does,
        as every other session row does, and never "ROUTINES". The window that re-enables a routine is AUTOMATE › SCHEDULES, the
        label sidecar/cron-store.js's auto-pause note uses, which the AUTOMATE strip shows. Both trees. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
require('./helpers/frontend-esc.js').installEsc();
global.RunOutcome = require('../frontend/app/runoutcome.js');

const sliceListener = (src, head) => {
  const at = src.indexOf(head);
  return at < 0 ? '' : src.slice(at, src.indexOf('\n    });', at) + '\n    });'.length);
};
const SPEND = 'spend_history_unavailable';

for (const tree of ['frontend/app', 'website/app/app']) {
  const t = tree + ': ';
  // ---- 1. the HUD toast ----
  {
    const src = sliceListener(read(tree + '/world.js'), "U.bus.on('cron.result', p => {");
    let on = null; const said = [];
    if (src) new Function('U', 'hudNote', 'RunOutcome', src)({ bus: { on: (n, fn) => { if (n === 'cron.result') on = fn; } } }, (txt, cls, opts) => said.push({ txt, cls, go: opts && opts.go }), RunOutcome);
    const toast = p => { said.length = 0; if (on) on(p); return said[0] || { txt: '(none)' }; };
    A.ok(!!on, t + 'fixture: the cron.result listener is sliced and runs');
    const paused = toast({ jobId: 'j', runId: 'r1', outcome: 'failed', runOutcome: 'failed', failureCode: SPEND, reason: 'error' });
    A.ok(/spend check/.test(paused.txt) && /spend history is incomplete/.test(paused.txt), t + 'a spend-check fire names the pause and why: ' + paused.txt);
    A.ok(/COUNT AS/.test(paused.txt) && /SETTINGS › SPENDING LIMITS/.test(paused.txt), t + 'and its way out, COUNT AS, and where it is');
    A.ok(/stays on its schedule/.test(paused.txt) && !/— error\b/.test(paused.txt), t + 'it says the routine stays on, never the bare "— error"');
    A.eq([paused.cls, paused.go && paused.go.ws], ['warn', 'cron-r1'], t + 'a warning, and it opens that fire\'s session (which ends on the same way out)');
    const plain = toast({ jobId: 'j', runId: 'r2', outcome: 'failed', runOutcome: 'failed', failureCode: 'run_failure', reason: 'error' });
    A.eq(plain.txt, '✕ routine failed — error', t + 'every other failure reads as before');
    const asked = toast({ jobId: 'j', runId: 'r3', outcome: 'failed', runOutcome: 'asked', reason: 'clarifying' });
    A.ok(/^▲ routine asked a question/.test(asked.txt), t + 'and a question is still a question');
  }

  // ---- 2. the NEEDS YOU routine row's door ----
  {
    delete require.cache[require.resolve(path.join(ROOT, tree, 'needsyou.js'))];
    const sessions = new Map([['cron-f1', { id: 'cron-f1', title: 'Nightly report', agentId: 'agent', lastRunOk: false, lastActiveAt: 5000,
      automation: { kind: 'routine', id: 'nightly', name: 'Nightly report' }, history: [] }]]);
    const opened = [];
    global.Workstreams = { get: id => sessions.get(id) || null, list: () => [...sessions.values()], unread: () => true, generalId: () => 'home' };
    global.App = { agentName: () => 'NOVA', openWorkstream: id => opened.push(id) };
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = undefined;
    const NY = require(path.join(ROOT, tree, 'needsyou.js'));
    const row = NY.items(10000).find(i => i.kind === 'routine');
    A.ok(row && row.where !== 'ROUTINES', t + 'the routine row never names ROUTINES, which is no door (got ' + (row && row.where) + ')');
    A.eq(row && row.where, 'Nightly report', t + 'it names the fire\'s session, as the SESSIONS rail titles it');
    NY.openKey(row.key);
    A.eq(opened, ['cron-f1'], t + 'and that session is where its door goes');
    const html = NY._internals.html([row], 10000);
    A.ok(/ny-place-said/.test(html) && /aria-label="[^"]*— in Nightly report"/.test(html), t + 'its line already names it, so the place is said once on sight and kept for the keyboard');
    A.ok(!/in ROUTINES/.test(html), t + 'the rendered row never says "in ROUTINES"');
  }
}

// ---- the window a routine is re-enabled in is AUTOMATE › SCHEDULES, the words the auto-pause note uses ----
A.ok(/re-enable it from AUTOMATE › SCHEDULES/.test(read('sidecar/cron-store.js')), 'cron-store\'s auto-pause note names AUTOMATE › SCHEDULES');
A.ok(/label: 'SCHEDULES'/.test(read('frontend/app/stationui.js')), 'and the AUTOMATE strip labels that window SCHEDULES');

A.report('routine-spend-pause-words.test (B1 carry-overs)');
