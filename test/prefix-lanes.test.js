/* node test/prefix-lanes.test.js — THE PREFIX COST LANES (cost audit W3.9), the pure half. Each lane is behind its own
   switch, read in one place (sidecar/index.js prefixLaneOn), and is OFF by default.

   STARNET_PREFIX_TAIL — the specialist tail (W3.9a, sidecar/capability/followups.js). The DaVinci Resolve tools, the rail
   widget tools and skill.write stay GRANTED, NAMED in the [HARNESS] list and found by tool_search, but leave the wire:
     T1. the table: only the six specialist tools, never a headline capability, a starter or the finder;
     T2. the pure rule: off unless the switch is literally on; a task run with tool search only; widget.get / widget.set
         stay on a widget's own update run; skill.write leaves only while skill.manage is on the wire; a tool already
         held for another reason keeps that reason;
     T3. the WHOLE authority-census matrix (every surface x origin x role x posture): with the switch on, only the tail's
         tools move, and only advertised -> deferred ('specialist-tail'); grants, withheld lists and every other row are
         identical; with it off (and with it on where no deferral can apply) the matrix is exactly the committed one;
         runOnceCore's own projection block (the census cut of index.js) reads the switch and agrees cell for cell;
     T4. tool_search finds every tail tool by its name, by its wire name and by a plain-language ask.

   The switch itself (S): prefixLaneOn is on for 1 / true / yes / on only, and the run and the TOOLSETS preview read the
   same one. The request bytes (OFF identical to the base, the ON saving) are test/prefix-lanes.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const F = require('../sidecar/capability/followups.js');
const C = require('./helpers/authority-census.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { readSidecarIndex } = require('./helpers/source');

const ROOT = path.resolve(__dirname, '..');
const TAIL = ['resolve_timeline_file', 'resolve_status', 'resolve_control', 'widget.get', 'widget.set', 'skill.write'];
// what the registry and its comments lock as never deferred: the finder, the readers the prompt points at, and every
// capability a model may claim it performed (registry.js; harness.integration.test.js; the 2026-07-26 probe)
const HEADLINE = ['tool.search', 'manual.read', 'station.inspect', 'skill.view', 'skill.manage', 'skill.list', 'notebook.write', 'notebook.read',
  'browser.screenshot', 'browser.vision', 'browser.navigate', 'browser.wait', 'browser.need_human', 'connectors.list', 'image_generate', 'image_analyze',
  'voice_generate', 'shell.exec', 'fs.read', 'fs.write', 'web_search', 'web_fetch', 'deliverable_note', 'todo', 'quest.update'];
const withPrefix = (sc, prefix) => Object.assign({}, sc, { facts: Object.assign({}, sc.facts, { prefix }) });
const withFacts = (sc, more) => Object.assign({}, sc, { facts: Object.assign({}, sc.facts, more) });

(async () => {
  /* ---------- S. the switch ---------- */
  const index = readSidecarIndex();
  {
    const m = /\nfunction prefixLaneOn\(suffix\) \{[^\n]*\}\n/.exec(index);
    A.ok(!!m, 'index.js reads the prefix lanes\' switches in one function (prefixLaneOn)');
    const mk = env => new Function('ENV', (m ? m[0] : '') + '\nreturn prefixLaneOn;')(suffix => env[suffix]);
    for (const v of ['1', 'true', 'YES', ' on ']) A.eq(mk({ PREFIX_TAIL: v })('PREFIX_TAIL'), true, 'the switch is on for ' + JSON.stringify(v));
    for (const v of ['0', '', ' ', 'false', 'off', 'no', '2', undefined, null]) A.eq(mk({ PREFIX_TAIL: v })('PREFIX_TAIL'), false, 'the switch is off for ' + JSON.stringify(v));
    A.eq(mk({ PREFIX_TAIL: '1' })('LIVE_NAMES'), false, 'one lane\'s switch never turns another on');
    A.eq(index.split('prefixLaneOn(').length - 1 - 1, index.split(/prefixLaneOn\('[A-Z_]+'\)/).length - 1, 'every use names its lane as a literal (no computed switch)');
    A.ok(!/process\.env\.(STARNET|SKYNET)_(PREFIX_|LIVE_NAMES)/.test(index), 'no prefix lane reads process.env beside ENV()');
    A.eq(index.split("prefixTail: prefixLaneOn('PREFIX_TAIL')").length - 1, 2, 'the run and the TOOLSETS preview hand the projection the same switch');
  }

  /* ---------- T1. the table ---------- */
  A.eq(F.TAIL_TOOLS.slice(), TAIL, 'the specialist tail is the three Resolve tools, the two widget tools and skill.write');
  A.ok(Object.isFrozen(F.SPECIALIST_TAIL) && F.SPECIALIST_TAIL.every(r => Object.isFrozen(r)) && Object.isFrozen(F.TAIL_TOOLS), 'the table is frozen');
  for (const n of HEADLINE) A.ok(F.TAIL_TOOLS.indexOf(n) < 0, n + ' is never in the specialist tail (a headline capability, a reader the prompt names, or the finder)');
  for (const n of F.TAIL_TOOLS) A.ok(F.ALL_CONTROLS.indexOf(n) < 0, n + ' is not also a follow-up control (one hold, one reason)');
  for (const f of F.FAMILIES) A.ok(F.TAIL_TOOLS.indexOf(f.starter) < 0 && F.TAIL_TOOLS.indexOf(f.lister || '') < 0, 'no starter or lister is in the tail (' + f.id + ')');
  A.eq(F.SPECIALIST_TAIL.filter(r => r.keptFor === 'widgetScope').map(r => r.tool), ['widget.get', 'widget.set'], 'the widget tools carry the update-run condition');
  A.eq(F.SPECIALIST_TAIL.filter(r => r.needsOnWire).map(r => [r.tool, r.needsOnWire]), [['skill.write', 'skill.manage']], 'skill.write carries the skill.manage condition');

  /* ---------- T2. the pure rule ---------- */
  {
    const kit = ['tool.search', 'image_generate', 'skill.view', 'skill.manage'].concat(TAIL);
    const base = { on: true, isTask: true, deferralOff: false, granted: kit, wire: kit, widgetScope: '' };
    A.eq(F.specialistTail(base), TAIL, 'on: every granted, advertised tail tool is held, in table order');
    for (const on of [false, undefined, null, 1, '1', 'true']) A.eq(F.specialistTail(Object.assign({}, base, { on })), [], 'on = ' + JSON.stringify(on) + ': nothing is held (only a literal true is on)');
    A.eq(F.specialistTail(Object.assign({}, base, { isTask: false })), [], 'a chat turn (no tools on the wire): nothing to hold');
    A.eq(F.specialistTail(Object.assign({}, base, { deferralOff: true })), [], 'SKYNET_TOOL_SEARCH=0 advertises everything');
    const noSearch = kit.filter(n => n !== 'tool.search');
    A.eq(F.specialistTail(Object.assign({}, base, { granted: noSearch, wire: noSearch })), [], 'tool.search not granted: a held name could never be found again, so none');
    A.eq(F.specialistTail(Object.assign({}, base, { widgetScope: 'w1' })), ['resolve_timeline_file', 'resolve_status', 'resolve_control', 'skill.write'],
      'a widget\'s own update run keeps widget.get and widget.set on the wire');
    const noManage = kit.filter(n => n !== 'skill.manage');
    A.eq(F.specialistTail(Object.assign({}, base, { granted: noManage, wire: noManage })).indexOf('skill.write'), -1, 'skill.manage not granted: skill.write stays (the only way to save a skill)');
    A.eq(F.specialistTail(Object.assign({}, base, { wire: noManage })).indexOf('skill.write'), -1, 'skill.manage off the wire: skill.write stays');
    A.eq(F.specialistTail(Object.assign({}, base, { wire: kit.filter(n => n !== 'resolve_status') })).indexOf('resolve_status'), -1,
      'a tool already off the wire for another reason is not claimed again: it keeps that reason');
    A.eq(F.specialistTail(Object.assign({}, base, { granted: kit.filter(n => n !== 'widget.set') })).indexOf('widget.set'), -1, 'an ungranted tool is never in the list');
    A.eq(F.specialistTail(), [], 'no input: nothing');
    A.eq(F.dormantFollowups({ isTask: true, deferralOff: false, granted: kit, wire: kit, facts: { terminal: false, shellBg: false, routines: false, loops: false, tasks: false } }), [],
      'the follow-up rule never claims a tail tool');
  }

  /* ---------- T3. the whole census matrix ---------- */
  const reg = C.catalogRegistry(ROOT);
  const ON = { PREFIX_TAIL: true };
  let movedRuns = 0, checkedRunOnce = 0, commsLead = null;
  const seenMoved = new Set();
  for (const sc of C.scenarios()) {
    const h = C.hostFacts(sc);
    const base = await C.projectMatrix(ROOT, sc);
    A.eq(C.diffMatrix({ [sc.id]: base }, { [sc.id]: await C.projectMatrix(ROOT, withPrefix(sc, {})) }), [], sc.id + ': the switch off is the matrix');
    const on = await C.projectMatrix(ROOT, withPrefix(sc, ON));
    // the spec, stated independently of the rule
    const searchable = !!sc.origin.o.isTask && !h.deferralOff && base.granted.indexOf('tool.search') >= 0;
    const expected = !searchable ? [] : TAIL.filter(n => base.advertised.indexOf(n) >= 0
      && !(h.widgetScope && /^widget\./.test(n)) && !(n === 'skill.write' && base.advertised.indexOf('skill.manage') < 0));
    const moved = base.advertised.filter(n => on.advertised.indexOf(n) < 0);
    A.eq(moved.slice().sort(), expected.slice().sort(), sc.id + ': exactly the advertised tail tools leave the wire (' + (expected.join(', ') || 'none') + ')');
    A.eq(on.granted, base.granted, sc.id + ': grants are identical (deferral is advertising, never capability)');
    A.eq(on.advertised, base.advertised.filter(n => moved.indexOf(n) < 0), sc.id + ': the wire keeps its order, minus the tail');
    A.eq(on.deferred, base.deferred.concat(expected), sc.id + ': the tail joins the deferred list (named in [HARNESS], searchable), after every other deferral');
    A.eq(on.withheldExplained, base.withheldExplained, sc.id + ': nothing is withheld by the rule');
    A.eq(on.unavailable, base.unavailable, sc.id + ': nothing is called unavailable by the rule (a held tool still works)');
    for (const n of Object.keys(base.rows)) {
      const want = moved.indexOf(n) >= 0 ? Object.assign({}, base.rows[n], { state: 'deferred', reason: 'specialist-tail' }) : base.rows[n];
      A.eq(on.rows[n], want, sc.id + ' ' + n + ': ' + (moved.indexOf(n) >= 0 ? 'deferred as specialist-tail, impact/consent/source unchanged' : 'row unchanged'));
    }
    for (const n of HEADLINE) if (base.rows[n]) A.eq(on.rows[n], base.rows[n], sc.id + ': ' + n + ' never moves');
    if (h.widgetScope && base.granted.indexOf('widget.set') >= 0) {
      A.ok(on.advertised.indexOf('widget.set') >= 0 && on.advertised.indexOf('widget.get') >= 0, sc.id + ': a widget\'s own update run keeps widget.get and widget.set advertised');
    }
    if (moved.length) {
      movedRuns++;
      moved.forEach(n => seenMoved.add(n));
      const cap = await C.runOnceMatrix(ROOT, withPrefix(sc, ON));
      A.eq(cap.failNotes, [], sc.id + ': the runOnce cut ran clean');
      A.eq(C.diffMatrix({ [sc.id]: on }, { [sc.id]: C.cellsFromRunOnce(cap, ROOT) }), [], sc.id + ': runOnceCore (the census cut) projects the same tail');
      checkedRunOnce++;
      // the two holds compose: with no handle and no record anywhere, the follow-ups and the tail are both held, each under its own reason
      const none = { terminal: false, shellBg: false, routines: false, loops: false, tasks: false };
      const both = await C.projectMatrix(ROOT, withFacts(sc, { prefix: ON, followups: none }));
      const onlyFollowups = await C.projectMatrix(ROOT, withFacts(sc, { followups: none }));
      A.eq(both.deferred, onlyFollowups.deferred.concat(expected), sc.id + ': with dormant follow-ups too, the tail is listed after them');
      for (const n of moved) A.eq(both.rows[n].reason, 'specialist-tail', sc.id + ' ' + n + ': keeps its own reason beside the dormant follow-ups');
    }
    if (sc.id === 'desktop.floor@ask') commsLead = { base, on, moved };
  }
  A.ok(movedRuns >= 20, 'the rule applies across the matrix (' + movedRuns + ' task scenarios hold tail tools off the wire)');
  A.eq(checkedRunOnce, movedRuns, 'every scenario that moved was re-checked through the runOnce cut');
  A.eq(Array.from(seenMoved).sort(), TAIL.slice().sort(), 'every tail tool is held somewhere in the matrix');
  A.eq(commsLead && commsLead.moved, ['widget.get', 'widget.set', 'skill.write', 'resolve_timeline_file', 'resolve_status', 'resolve_control'].filter(n => commsLead.base.advertised.indexOf(n) >= 0)
    .sort((a, b) => commsLead.base.advertised.indexOf(a) - commsLead.base.advertised.indexOf(b)), 'the COMMS lead on a placed floor holds all six');
  A.eq(commsLead && commsLead.moved.length, 6, 'all six tail tools were on that lead\'s wire');
  {
    // where no deferral can apply, the switch changes nothing
    for (const id of ['facts.deferral-off@ask', 'desktop.chat@ask']) {
      const sc = C.scenarios().find(s => s.id === id);
      A.eq(C.diffMatrix({ [id]: await C.projectMatrix(ROOT, sc) }, { [id]: await C.projectMatrix(ROOT, withPrefix(sc, ON)) }), [], id + ': no deferral, no tail');
    }
  }

  /* ---------- T4. tool_search finds every tail tool ---------- */
  {
    const search = makeToolSearchTool({ registry: reg }).toolSearchTool;
    const pool = commsLead.on.deferred.slice();
    for (const n of TAIL) {
      const byName = await search.run({ query: n }, { deferred: pool });
      A.ok(byName.control && byName.control.revealTools.indexOf(n) >= 0, 'tool_search "' + n + '" reveals it');
      const wire = n.replace(/\./g, '_');
      const byWire = await search.run({ query: wire }, { deferred: pool });
      A.ok(byWire.control && byWire.control.revealTools.indexOf(n) >= 0, 'tool_search "' + wire + '" (the name the [HARNESS] list shows) reveals it');
    }
    /* Plain asks. The scorer weighs a tool's NAME most, and a widget tool's name says "widget" only in its namespace, so an
       ask that opens with another held tool's own verb ("create a dashboard widget" -> app.create, "publish a reading" ->
       app.publish) lands on that tool. An ask that says what the thing is, or uses the listed name, finds it; the names
       are in the [HARNESS] list for that reason. */
    const asks = [
      ['davinci resolve', 'resolve_status'], ['is DaVinci Resolve running', 'resolve_status'], ['build a video timeline from clips', 'resolve_timeline_file'],
      ['edit a video', 'resolve_timeline_file'], ['render the resolve timeline', 'resolve_control'], ['pin a live readout on the widget rails', 'widget.set'],
      ['make a widget showing app revenue', 'widget.set'], ['widget', 'widget.set'], ['update the widget on the rail', 'widget.set'],
      ['read the current widget definition', 'widget.get'], ['save a reusable skill procedure', 'skill.write'], ['save this as a skill', 'skill.write']];
    for (const [q, n] of asks) {
      const hit = await search.run({ query: q }, { deferred: pool });
      A.ok(hit.control && hit.control.revealTools.indexOf(n) >= 0, 'tool_search "' + q + '" finds ' + n + ' (got ' + JSON.stringify(hit.control && hit.control.revealTools) + ')');
    }
  }

  A.report('prefix-lanes');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
