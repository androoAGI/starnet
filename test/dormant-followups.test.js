/* node test/dormant-followups.test.js — DORMANT FOLLOW-UP CONTROLS (cost audit W1.3, sidecar/capability/followups.js).

   A follow-up control (terminal.status/read/write/resize/interrupt/stop, shell.bg.read/write/kill/wait, routine/loop/task
   .manage) has nothing to act on until a terminal, a background process or a record exists. It stays GRANTED, NAMED in the
   [HARNESS] list and found by tool_search, but leaves the wire while the host PROVES nothing of its kind exists; its
   starter's result reveals it. This test holds the rule to:
     A. the table: no starter and no headline tool is ever a dormant control;
     B. the pure rule: certain-only (false = dormant, anything else advertised), task runs with tool search only, a control
        already held for another reason keeps that reason, shell.bg.status stays beside shell.exec;
     C. the WHOLE authority-census matrix (every surface x origin x role x posture): with no handle and no record anywhere,
        only follow-up controls move, and only advertised -> deferred (grants, withheld lists, every other row identical);
        with live handles everywhere, and with the facts unknown, the matrix is exactly the committed one;
     D. runOnceCore's own projection block (the census cut of index.js) hands the fact through and agrees cell for cell;
     E. tool_search finds every dormant control by its name and by a plain-language ask;
     F. the wiring: index.js reads the facts where a deferral can apply, the preview reads the same ones, and every starter
        result names its controls in control.revealTools. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../sidecar/capability/followups.js');
const C = require('./helpers/authority-census.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { readSidecarIndex } = require('./helpers/source');

const ROOT = path.resolve(__dirname, '..');
const NONE = Object.freeze({ terminal: false, shellBg: false, routines: false, loops: false, tasks: false });
const LIVE = Object.freeze({ terminal: true, shellBg: true, routines: true, loops: true, tasks: true });
const STARTERS = ['terminal.start', 'shell.exec', 'routine.create', 'loop.create', 'task.create'];
const withFollowups = (sc, followups) => Object.assign({}, sc, { facts: Object.assign({}, sc.facts, { followups }) });

(async () => {
  /* ---------- A. the table ---------- */
  A.eq(F.ALL_CONTROLS.slice().sort(), ['loop.manage', 'routine.manage', 'shell.bg.kill', 'shell.bg.read', 'shell.bg.status', 'shell.bg.wait', 'shell.bg.write',
    'task.manage', 'terminal.interrupt', 'terminal.read', 'terminal.resize', 'terminal.status', 'terminal.stop', 'terminal.write'],
  'the dormant set is the 13 follow-up controls plus shell.bg.status (which joins only when shell.exec is off the wire)');
  for (const s of STARTERS.concat(['routine.list', 'loop.list', 'task.list', 'tool.search', 'browser.screenshot', 'browser.vision', 'browser.navigate']))
    A.ok(F.ALL_CONTROLS.indexOf(s) < 0, s + ' is never a dormant control (a starter, a lister or a headline capability)');
  A.eq(F.FAMILIES.map(f => f.starter), STARTERS, 'each family names the tool that brings its thing into being');
  A.ok(Object.isFrozen(F.FAMILIES) && F.FAMILIES.every(f => Object.isFrozen(f) && Object.isFrozen(f.controls)), 'the table is frozen');
  A.eq(F.revealFor('shellBg'), ['shell.bg.read', 'shell.bg.write', 'shell.bg.kill', 'shell.bg.wait', 'shell.bg.status'], 'a background start reveals the whole shell.bg family');
  A.eq(F.revealFor('terminal'), ['terminal.status', 'terminal.read', 'terminal.write', 'terminal.resize', 'terminal.interrupt', 'terminal.stop'], 'a terminal start reveals every terminal control');
  A.eq(F.revealFor('nope'), [], 'an unknown family reveals nothing');

  /* ---------- B. the pure rule ---------- */
  {
    const kit = ['tool.search', 'shell.exec', 'shell.bg.status', 'shell.bg.read', 'shell.bg.kill', 'terminal.start', 'terminal.read', 'task.create', 'task.manage', 'routine.manage', 'loop.manage'];
    const base = { isTask: true, deferralOff: false, granted: kit, wire: kit, facts: NONE };
    A.eq(F.dormantFollowups(base), ['terminal.read', 'shell.bg.read', 'shell.bg.kill', 'routine.manage', 'loop.manage', 'task.manage'],
      'no handle and no record: every granted, advertised follow-up control is dormant (FAMILIES order); shell.bg.status stays beside shell.exec');
    A.eq(F.dormantFollowups(Object.assign({}, base, { facts: LIVE })), [], 'live handles and records: nothing is dormant');
    A.eq(F.dormantFollowups(Object.assign({}, base, { facts: undefined })), [], 'facts unknown: nothing is dormant (certain-only)');
    A.eq(F.dormantFollowups(Object.assign({}, base, { facts: { terminal: false, shellBg: 0, routines: null, loops: 'false', tasks: true } })), ['terminal.read'],
      'only a literal false is proof: 0, null, a string or true keep the family advertised');
    A.eq(F.dormantFollowups(Object.assign({}, base, { isTask: false })), [], 'a chat turn (no tools on the wire): nothing to hold');
    A.eq(F.dormantFollowups(Object.assign({}, base, { deferralOff: true })), [], 'SKYNET_TOOL_SEARCH=0 advertises everything');
    const noSearch = kit.filter(n => n !== 'tool.search');
    A.eq(F.dormantFollowups(Object.assign({}, base, { granted: noSearch, wire: noSearch })), [], 'tool.search not granted: a dormant name could never be found again, so none');
    const noExec = kit.filter(n => n !== 'shell.exec');
    A.eq(F.dormantFollowups(Object.assign({}, base, { granted: noExec, wire: noExec })).filter(n => /^shell\.bg\./.test(n)), ['shell.bg.read', 'shell.bg.kill', 'shell.bg.status'],
      'shell.exec off the wire: shell.bg.status joins its family');
    A.eq(F.dormantFollowups(Object.assign({}, base, { wire: kit.filter(n => n !== 'terminal.read') })).indexOf('terminal.read'), -1,
      'a control already off the wire for another reason (e.g. unavailable) is not claimed again: it keeps that reason');
    A.eq(F.dormantFollowups(Object.assign({}, base, { granted: kit.filter(n => n !== 'task.manage') })).indexOf('task.manage'), -1, 'an ungranted control is never in the list');
    A.eq(F.dormantFollowups(), [], 'no input: nothing');
  }

  /* ---------- C + D. the whole census matrix ---------- */
  const reg = C.catalogRegistry(ROOT);
  let movedRuns = 0, checkedRunOnce = 0;
  let commsLead = null;
  for (const sc of C.scenarios()) {
    const h = C.hostFacts(sc);
    const base = await C.projectMatrix(ROOT, sc);
    const live = await C.projectMatrix(ROOT, withFollowups(sc, LIVE));
    A.eq(C.diffMatrix({ [sc.id]: base }, { [sc.id]: live }), [], sc.id + ': live handles and records everywhere move nothing');
    const none = await C.projectMatrix(ROOT, withFollowups(sc, NONE));
    // the spec, stated independently of the rule: on a task run with tool search on, every follow-up control the matrix
    // advertises moves; shell.bg.status only when shell.exec is not advertised
    const searchable = !!sc.origin.o.isTask && !h.deferralOff && base.granted.indexOf('tool.search') >= 0;
    const expected = !searchable ? [] : F.FAMILIES.reduce((out, fam) => out.concat(fam.controls.concat(fam.lister && base.advertised.indexOf(fam.starter) < 0 ? [fam.lister] : [])
      .filter(n => base.advertised.indexOf(n) >= 0)), []);
    const moved = base.advertised.filter(n => none.advertised.indexOf(n) < 0);
    A.eq(moved.slice().sort(), expected.slice().sort(), sc.id + ': exactly the advertised follow-up controls leave the wire (' + (expected.join(', ') || 'none') + ')');
    A.eq(none.granted, base.granted, sc.id + ': grants are identical (deferral is advertising, never capability)');
    A.eq(none.advertised, base.advertised.filter(n => moved.indexOf(n) < 0), sc.id + ': the wire keeps its order, minus the dormant controls');
    A.eq(none.deferred, base.deferred.concat(expected), sc.id + ': the dormant controls join the deferred list (named in [HARNESS], searchable), after every other deferral');
    A.eq(none.withheldExplained, base.withheldExplained, sc.id + ': nothing is withheld by the rule');
    A.eq(none.unavailable, base.unavailable, sc.id + ': nothing is called unavailable by the rule (a dormant tool still works)');
    for (const n of Object.keys(base.rows)) {
      const want = moved.indexOf(n) >= 0 ? Object.assign({}, base.rows[n], { state: 'deferred', reason: 'dormant-followup' }) : base.rows[n];
      A.eq(none.rows[n], want, sc.id + ' ' + n + ': ' + (moved.indexOf(n) >= 0 ? 'deferred as dormant-followup, impact/consent/source unchanged' : 'row unchanged'));
    }
    for (const s of STARTERS) if (base.rows[s]) A.eq(none.rows[s].state, base.rows[s].state, sc.id + ': the starter ' + s + ' never moves');
    if (moved.length) {
      movedRuns++;
      // D. the runOnce cut of index.js reads the same fact and lands on the same cells
      const cap = await C.runOnceMatrix(ROOT, withFollowups(sc, NONE));
      A.eq(cap.failNotes, [], sc.id + ': the runOnce cut ran clean');
      A.eq(C.diffMatrix({ [sc.id]: none }, { [sc.id]: C.cellsFromRunOnce(cap, ROOT) }), [], sc.id + ': runOnceCore (the census cut) projects the same dormant controls');
      checkedRunOnce++;
    }
    if (sc.id === 'desktop.floor@ask') commsLead = { base, none, moved };
  }
  A.ok(movedRuns >= 20, 'the rule applies across the matrix (' + movedRuns + ' task scenarios hold controls off the wire)');
  A.eq(checkedRunOnce, movedRuns, 'every scenario that moved was re-checked through the runOnce cut');
  A.ok(commsLead && commsLead.moved.length === 13, 'the COMMS lead on its starter floor holds all 13 follow-up controls off the wire (' + (commsLead && commsLead.moved.join(', ')) + ')');
  A.ok(commsLead && commsLead.none.advertised.indexOf('shell.bg.status') >= 0 && commsLead.none.advertised.indexOf('shell.exec') >= 0,
    'shell.bg.status stays beside shell.exec (the dev-server verification rule names it)');
  {
    // a deferral that is OFF never sees the facts: SKYNET_TOOL_SEARCH=0 and a chat turn are byte-identical under NONE
    for (const id of ['facts.deferral-off@ask', 'desktop.chat@ask']) {
      const sc = C.scenarios().find(s => s.id === id);
      A.eq(C.diffMatrix({ [id]: await C.projectMatrix(ROOT, sc) }, { [id]: await C.projectMatrix(ROOT, withFollowups(sc, NONE)) }), [], id + ': no deferral, no dormancy');
    }
  }

  /* ---------- E. tool_search finds every dormant control ---------- */
  {
    const search = makeToolSearchTool({ registry: reg }).toolSearchTool;
    const pool = commsLead.none.deferred.slice();
    for (const n of commsLead.moved) {
      const byName = await search.run({ query: n }, { deferred: pool });
      A.ok(byName.control && byName.control.revealTools.indexOf(n) >= 0, 'tool_search "' + n + '" reveals it');
      const wire = n.replace(/\./g, '_');
      const byWire = await search.run({ query: wire }, { deferred: pool });
      A.ok(byWire.control && byWire.control.revealTools.indexOf(n) >= 0, 'tool_search "' + wire + '" (the name the [HARNESS] list shows) reveals it');
    }
    /* Plain asks. Name words weigh most in the scorer, so "stop …" lands on terminal.stop: harmless here, because a dormant
       family means the host PROVED there is nothing of its kind to stop, and the moment one exists (a start, a status or a
       list that shows it, or the next run's start) its controls are on the wire without any search. */
    const asks = [
      ['kill the background process', 'shell.bg.kill'], ['read the full log of a background process', 'shell.bg.read'],
      ['wait for the background process to exit', 'shell.bg.wait'], ['read the terminal session output', 'terminal.read'],
      ['send input to the terminal session', 'terminal.write'], ['pause or delete a routine', 'routine.manage'],
      ['pause a loop', 'loop.manage'], ['move a task card on the board', 'task.manage']];
    for (const [q, n] of asks) {
      const hit = await search.run({ query: q }, { deferred: pool });
      A.ok(hit.control && hit.control.revealTools.indexOf(n) >= 0, 'tool_search "' + q + '" finds ' + n + ' (got ' + JSON.stringify(hit.control && hit.control.revealTools) + ')');
    }
  }

  /* ---------- F. the wiring ---------- */
  {
    const index = readSidecarIndex();
    A.ok(/followups: \(isTask && !deferralOff\) \? followupFactsFor\(agentId\) : undefined/.test(index), 'runOnceCore reads the follow-up facts only where a deferral can apply');
    A.ok(/followups: deferralOff \? undefined : followupFactsFor\(agentId\)/.test(index), 'GET /api/toolsets previews the run from the same facts');
    A.ok(/terminalSessions\.countRunning\(agentId\) > 0/.test(index) && /shellBg\.count\(agentId\) > 0/.test(index), 'live handles: this agent\'s running PTY sessions and background processes');
    A.ok(/\(backend === 'local' \|\| backend === 'docker'\) \? shellBg\.count\(agentId\) > 0 : undefined/.test(index), 'an SSH backend\'s background jobs live on the far machine: unknown, so advertised');
    A.ok(/const canName = wireNames\.indexOf\('deliverable_note'\) >= 0;/.test(index), 'the deliverable clause rides only a call that carries deliverable_note on its wire');
    const src = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    A.ok(/summary: 'bg started ' \+ r\.bgId, control: \{ revealTools: BG_CONTROLS\.slice\(\) \}/.test(src('sidecar/tools/builtin/shell.js')), 'a background shell.exec that started reveals the shell.bg controls');
    A.ok(/control: \{ revealTools: TERMINAL_CONTROLS\.slice\(\) \}/.test(src('sidecar/tools/builtin/terminal.js')), 'terminal.start reveals the terminal controls');
    A.ok((src('sidecar/tools/builtin/routines.js').match(/revealTools: ROUTINE_CONTROLS\.slice\(\)/g) || []).length === 3, 'routine.create (new or existing) and a routine.list that shows one reveal routine.manage');
    A.ok((src('sidecar/tools/builtin/loops.js').match(/revealTools: LOOP_CONTROLS\.slice\(\)/g) || []).length === 2, 'loop.create and a loop.list that shows one reveal loop.manage');
    A.ok((src('sidecar/tools/builtin/station.js').match(/revealTools: TASK_CONTROLS\.slice\(\)/g) || []).length === 2, 'task.create and a task.list that shows a card reveal task.manage');
  }

  A.report('dormant-followups');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
