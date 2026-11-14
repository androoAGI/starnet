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
     T4. tool_search finds every tail tool by its name, by its wire name and by a plain-language ask, searching as a run
         does (the listed tools beside the shelf, and the words the held tail answers to; the full tables are
         test/toolsearch.specialist-tail.test.js).

   STARNET_PREFIX_DOCTRINE — two doctrine blocks said once (W3.9b, sidecar/manual.js and sidecar/finish-line.js):
     D1. CONNECTING A PLATFORM on demand: the lean index is the index with that one section replaced by its rules
         (CONNECTING_CORE); the honesty core is inline (connectors.list with the goal before answering or declining, never
         assert catalog membership, never invent a menu path, the API KEYS + web_request fallback, "not connected YET");
         EVERY sentence of the section, moved or kept, is served verbatim by manual.read ("connecting" and "all"); the
         lean form exists only for the index (never where manual.read is off the wire); and manual.read lists the section
         as readable, not as already in the prompt, on a run that carries the lean index;
     D2. HOW TO WORK said once: each of the three sentences the switch drops is restated by FINISH THE JOB (the lines
         named in FinishLine.RESTATED are in the block with no tool at all), FINISH itself is untouched, and the append
         cannot be skipped once the sentences are gone.

   STARNET_PREFIX_RECIPES — recipes read without the SERVER CART (W3.9c, sidecar/tools/builtin/recipe-read.js):
     R1. recipe.read serves exactly the recipes a run was offered, each as the text skill.view serves and the inline block
         carried, and nothing else: not a recipe that is disabled or whose gear is not placed, not a saved skill;
         the index names the reader the run has (recipe.read), and without one it is the text it always was;
     R2. the WHOLE authority-census matrix: with the switch on, a task run whose wire has no skill.view gains recipe.read
         (advertised, impact none, no consent, source 'recipe-reader') and NOTHING else: no SERVER CART tool is granted
         that the room did not grant, every other row is identical; a run that has skill.view, and a chat turn, are the
         matrix as committed; runOnceCore's own projection block agrees cell for cell;
     R3. the reader is a station self-knowledge read (never deferred, never a toggleable family, no CAP_REGISTRY row).

   STARNET_LIVE_NAMES — the joined live tool-name list (W2.5, sidecar/index.js toolNote):
     L.  one gate swaps the list for a pointer to it, only where the request carries the tools; the sentences that lean
         on the list (never claim a listed tool is unavailable; This list is PARTIAL and the names of the tools that are
         not loaded yet) are untouched; and claude-cli names every advertised tool in the # Tools text of the same
         system prompt, so the list is a repeat there too.

   The switch itself (S): prefixLaneOn is on for 1 / true / yes / on only, and the run and the TOOLSETS preview read the
   same one. The request bytes (OFF identical to the base, the ON saving) are test/prefix-lanes.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const SkillsCatalog = require('../sidecar/skills/catalog.js');
const { makeRecipeReadTool, NAME: RECIPE_READER } = require('../sidecar/tools/builtin/recipe-read.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { impactOfTool, enforceEnabledToolsets, IMPACTS } = require('../sidecar/inputpolicy.js');
const M = require('../sidecar/manual.js');
const FinishLine = require('../sidecar/finish-line.js');
const { makeManualReadTool } = require('../sidecar/tools/builtin/manual-read.js');
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
    // as a run searches: the tools on its wire are ranked beside the shelf (ctx.advertised), and each held tail tool
    // answers to its words (ctx.answersTo = the projection's tailWords)
    const asRun = { deferred: pool, advertised: commsLead.on.advertised.slice(), answersTo: F.tailWords(commsLead.moved) };
    A.eq(Object.keys(asRun.answersTo || {}).sort(), TAIL.slice().sort(), 'the lead\'s search is handed words for all six');
    for (const n of TAIL) {
      const byName = await search.run({ query: n }, asRun);
      A.ok(byName.control && byName.control.revealTools.indexOf(n) >= 0, 'tool_search "' + n + '" reveals it');
      const wire = n.replace(/\./g, '_');
      const byWire = await search.run({ query: wire }, asRun);
      A.ok(byWire.control && byWire.control.revealTools.indexOf(n) >= 0, 'tool_search "' + wire + '" (the name the [HARNESS] list shows) reveals it');
    }
    /* Plain asks. The scorer weighs a tool's NAME most, and a widget tool's name says "widget" only in its namespace, so an
       ask that opens with another tool's own verb ("create a dashboard widget" -> app.create, "publish a reading to a
       dashboard widget" -> app.publish) landed on that tool alone; and "edit a video" passed here only while this block
       left the listed tools out (fs.edit is one, and no Resolve tool says "video"). A held tail tool now answers to its
       family word and its plain words, whatever else scored. */
    const asks = [
      ['davinci resolve', 'resolve_status'], ['is DaVinci Resolve running', 'resolve_status'], ['build a video timeline from clips', 'resolve_timeline_file'],
      ['edit a video', 'resolve_timeline_file'], ['render the resolve timeline', 'resolve_control'], ['pin a live readout on the widget rails', 'widget.set'],
      ['make a widget showing app revenue', 'widget.set'], ['widget', 'widget.set'], ['update the widget on the rail', 'widget.set'],
      ['read the current widget definition', 'widget.get'], ['save a reusable skill procedure', 'skill.write'], ['save this as a skill', 'skill.write'],
      ['create a dashboard widget', 'widget.set'], ['publish a reading to a dashboard widget', 'widget.set']];
    for (const [q, n] of asks) {
      const hit = await search.run({ query: q }, asRun);
      A.ok(hit.control && hit.control.revealTools.indexOf(n) >= 0, 'tool_search "' + q + '" finds ' + n + ' (got ' + JSON.stringify(hit.control && hit.control.revealTools) + ')');
    }
  }

  /* ---------- D1. CONNECTING A PLATFORM on demand ---------- */
  {
    const B = s => Buffer.byteLength(String(s));
    const full = M.starnetManual(), idx = M.starnetManualIndex(), lean = M.starnetManualIndexLean();
    const section = M.manualSection('connecting'), core = M.CONNECTING_CORE;
    A.ok(idx.split(section).length === 2, 'the index carries CONNECTING A PLATFORM once, whole');
    A.ok(lean === idx.replace(section, () => core), 'the lean index is the index with that one section replaced by its core, and nothing else');
    A.ok(lean.indexOf('\n<starnet_operator_manual>\n') === 0 && lean.endsWith('</starnet_operator_manual>'), 'the lean index keeps the manual fence');
    for (const s of M.MANUAL_SECTIONS.filter(x => x.kind !== 'reference' && x.id !== 'connecting'))
      A.ok(lean.indexOf(M.manualSection(s.id)) >= 0, s.id + ' (' + s.kind + ') still rides inline VERBATIM');
    for (const r of M.INLINE_RULE_EXCERPTS) A.ok(lean.indexOf(r) >= 0, 'a rule that lives inside a reference section still rides inline');
    A.ok(M.starnetManualIndexLean() === lean && !/undefined|null|\[object/.test(core), 'deterministic (it rides the cached prefix), no junk');
    A.eq(M.ON_DEMAND_RULE_SECTIONS.slice(), ['connecting'], 'one rule section is on demand under the switch');
    // the honesty core, inline
    A.ok(/CONNECTING A PLATFORM — the single most common request, and the one you must not improvise\./.test(core), 'core: never improvise it');
    A.ok(/LOOK IT UP BEFORE YOU ANSWER\. If you have the connectors\.list tool, CALL IT before you say whether a platform can be reached; never answer that question from memory while the tool is available to you\./.test(core),
      'core: look it up with connectors.list before saying whether a service can be reached (asked only of a run that has the tool)');
    A.ok(/BEFORE DECLINING a task for lack of email, website, calendar, docs or any service access, call connectors\.list with `goal` set to the Commander's task in their words\. Decline only after that call comes back with nothing\./.test(core),
      'core: connectors.list with the goal before declining, and decline only after it');
    for (const head of ['CONNECTING A PLATFORM — ', 'LOOK IT UP BEFORE YOU ANSWER. ', 'BEFORE DECLINING ', 'HONESTY RULE — this is the rule that matters most here: '])
      A.ok(core.indexOf(head) >= 0 && section.indexOf(head) >= 0, 'core: keeps the section\'s own heading "' + head.trim() + '"');
    A.ok(/NEVER assert that a specific platform is or is not there/.test(core), 'core: never assert catalog membership');
    A.ok(/NEVER invent a StarNet menu path, settings screen, or button name/.test(core), 'core: never invent a menu path');
    A.ok(/open CONNECT › ABILITIES and type the platform name into its search box/.test(core), 'core: the one place to send them');
    A.ok(/guaranteed fallback, which works for ANY platform, listed or not: they paste its API key in CONNECTED › API KEYS and you call its REST API yourself with web_request \(or curl in your shell\), referencing the key by its environment-variable NAME/.test(core),
      'core: the API KEYS + web_request fallback');
    A.ok(/never say StarNet “cannot” reach a service when what you mean is that it is not connected YET/.test(core), 'core: not connected YET is never "cannot"');
    A.ok(/call manual\.read section connecting/.test(core) && /Before you walk the Commander through connecting/.test(core) && /whenever a route you suggested did not work/.test(core),
      'core: read the section before walking anyone through it, and when a route failed');
    A.ok(/NEVER send the Commander to BUILD MODE to connect a platform/.test(lean), 'the CONNECTORS rule (never BUILD MODE for a connector) is untouched');
    // every sentence of the section is reachable through manual.read, verbatim
    const { tool } = makeManualReadTool();
    const served = tool.run({ section: 'connecting' }).content, servedAll = tool.run({ section: 'all' }).content;
    A.ok(served === section, 'manual.read connecting serves the whole section verbatim');
    A.ok(servedAll === full && full.indexOf(section) >= 0, 'manual.read all serves the whole manual, the section in it');
    A.ok(tool.schema.properties.section.enum.indexOf('connecting') >= 0, 'the schema lists connecting as a section the model can ask for');
    const sentences = section.split('\n').filter(Boolean).reduce((out, line) => out.concat(line.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [line]), []).map(x => x.trim()).filter(Boolean);
    A.ok(sentences.length >= 20, 'the section was split into its sentences (' + sentences.length + ')');
    let moved = 0;
    for (const sentence of sentences) {
      const kept = lean.indexOf(sentence) >= 0;
      if (!kept) moved++;
      A.ok(served.indexOf(sentence) >= 0 && servedAll.indexOf(sentence) >= 0, (kept ? 'kept' : 'MOVED') + ' sentence is served by manual.read: ' + sentence.slice(0, 60));
    }
    A.ok(moved >= 8, 'sentences really moved behind manual.read (' + moved + ' of ' + sentences.length + ')');
    for (const must of ['1. APPS — the platform has a vetted one-click connector.', '3. CONNECTED, by address', 'Jira/Confluence remains on its verified Zapier route',
      'never tell them to create a Cloud project or paste client credentials', 'believe them and switch routes; do not repeat it or imply they did it wrong'])
      A.ok(lean.indexOf(must) < 0 && served.indexOf(must) >= 0, 'moved, and one manual.read away: ' + must);
    // the lean form exists for the index alone
    A.ok(M.leanManualBlock(idx) === lean, 'the index becomes its lean form');
    for (const [name, block] of [['the whole manual (a run without manual.read)', full], ['the phone pointer', M.starnetManualPointer()], ['the terminal pointer', M.starnetManualTerminal()], ['no manual', '']])
      A.ok(M.leanManualBlock(block) === block, name + ' has no lean form: returned as it came');
    A.ok(full.indexOf(section) >= 0 && idx.indexOf(section) >= 0, 'the whole manual and the switch-off index still carry the section whole');
    // manual.read never calls a section "already in your prompt" on a run that carries only its core
    const plain = tool.run({ section: 'nope' }).content, onDemand = tool.run({ section: 'nope' }, { manualOnDemand: M.ON_DEMAND_RULE_SECTIONS.slice() }).content;
    A.ok(/Reference sections: navigation, props, troubleshooting, concepts\. Already in your prompt: about, live-state, connectors, approval, connecting\./.test(plain), 'manual.read without the fact answers as before');
    A.ok(/Reference sections: navigation, props, connecting, troubleshooting, concepts\. Already in your prompt: about, live-state, connectors, approval\./.test(onDemand),
      'manual.read on a lean-index run lists connecting as a section to read');
    A.ok(tool.run({ section: 'connecting' }, { manualOnDemand: ['connecting'] }).content === section, '...and serves it the same');
    console.log('[prefix-lanes] CONNECTING: section ' + B(section) + ' B -> core ' + B(core) + ' B; index ' + B(idx) + ' -> ' + B(lean) + ' B (saves ' + (B(idx) - B(lean)) + ')');
    A.ok(B(idx) - B(lean) >= 1400, 'the lean index is at least 1,400 B smaller (' + (B(idx) - B(lean)) + ')');
    // the wiring
    A.ok(/const operatorManual = prefixLaneOn\('PREFIX_DOCTRINE'\) \? leanManualBlock\(operatorManualWhole\) : operatorManualWhole;/.test(index), 'index.js swaps the manual block only under the switch');
    A.ok(/if \(operatorManual !== operatorManualWhole\) capCtx\.manualOnDemand = ON_DEMAND_RULE_SECTIONS\.slice\(\);/.test(index), '...and tells manual.read only when the lean index really rides');
  }

  /* ---------- D2. HOW TO WORK said once ---------- */
  {
    const bare = FinishLine.block({ tools: [] });   // the block with no tool-specific line at all
    A.eq(FinishLine.RESTATED.length, 3, 'three HOW TO WORK sentences are restated by FINISH THE JOB');
    let bytes = 0;
    for (const r of FinishLine.RESTATED) {
      bytes += Buffer.byteLength(r.howToWork);
      A.eq(index.split(r.howToWork.trim()).length - 1, 1, 'index.js carries the sentence once: ' + r.howToWork.slice(0, 50));
      A.ok(r.here.length >= 1 && r.here.every(line => bare.indexOf(line) >= 0), 'FINISH THE JOB restates it, on every task run: ' + r.howToWork.slice(0, 50));
    }
    A.ok(bytes >= 400, 'the three sentences are ' + bytes + ' B');
    // each is dropped only by the switch, and only on a run FINISH closes
    A.ok(/const howToWorkLean = stablePrefix && FinishLine\.rides\(\{ isTask, internal \}\) && prefixLaneOn\('PREFIX_DOCTRINE'\);/.test(index),
      'the sentences leave only on a cache-stable run FINISH THE JOB closes, under the switch');
    A.ok(index.indexOf('const stablePrefix = ') > 0 && index.indexOf('const stablePrefix = ') < index.indexOf('const howToWorkLean = ') && index.split('const stablePrefix = ').length === 2,
      'stablePrefix is declared once, before HOW TO WORK asks it');
    const gate = "(howToWorkLean ? '' : '";
    A.ok(index.indexOf("'HOW TO WORK: ' + " + gate + FinishLine.RESTATED[0].howToWork + "'\n    + '" + FinishLine.RESTATED[1].howToWork + "')") >= 0, 'the first two sentences sit behind the one gate, after the HOW TO WORK heading');
    A.ok(index.indexOf('+ ' + gate + FinishLine.RESTATED[2].howToWork + "')") >= 0, 'the third sits behind the same gate');
    A.ok(/\? FinishLine\.append\(cacheSystemPrefix \+ serviceKeysBlock \+ taskDoctrine \+ journeyBlock \+ deliverableNote, \{ isTask, internal, tools: resolved\.tools, restated: howToWorkLean \}\)/.test(index),
      'the cache-stable final seam tells the append the sentences are gone');
    A.eq(index.split('restated: howToWorkLean').length - 1, 1, 'the STARNET_STABLE_PREFIX=0 seam is as it was (its prompt keeps HOW TO WORK whole)');
    A.eq(index.split('howToWorkLean').length - 1, 4, 'howToWorkLean is declared once and used three times (two gates, one append)');
    // FINISH itself: riding, forcing, never trimmed
    A.eq([FinishLine.rides({ isTask: true, internal: false }), FinishLine.rides({ isTask: false }), FinishLine.rides({ isTask: true, internal: true }), FinishLine.rides()], [true, false, false, false], 'FINISH rides a real task only');
    const quoted = 'PERSONA that quotes ## FINISH THE JOB in passing';
    const opts = { isTask: true, internal: false, tools: ['tool.search'] };
    A.eq(FinishLine.append(quoted, opts), quoted, 'as before: a base that already holds the heading is left alone');
    const forced = FinishLine.append(quoted, Object.assign({ restated: true }, opts));
    A.ok(forced.indexOf(quoted) === 0 && forced.endsWith(FinishLine.block(opts)), 'restated: the block closes the prompt even there (the sentences it restates are gone)');
    A.eq(FinishLine.append('IDENTITY', Object.assign({ restated: true }, opts)), FinishLine.append('IDENTITY', opts), 'restated changes nothing where the block rides anyway');
    A.eq(FinishLine.append('X', { isTask: false, restated: true }), 'X', 'restated never adds the block to a chat turn');
    A.eq(FinishLine.append('X', { isTask: true, internal: true, restated: true }), 'X', '...or to internal self-talk');
  }

  /* ---------- R1. recipe.read: the offered recipes, and nothing else ---------- */
  const MEMORY_TOOLS = CAP_REGISTRY.notebook.map(g => g.tool);   // what the SERVER CART grants
  {
    const lib = SkillsCatalog.loadDir(path.join(ROOT, 'sidecar', 'skills', 'library'), fs, path);
    const opts = { overrides: {}, placedTypes: ['computer'], agentSkills: [] };
    const offered = SkillsCatalog.live(lib, opts);
    A.ok(offered.length >= 3 && offered.length < lib.length, 'a bare desk is offered the recipes that need no gear (' + offered.length + ' of ' + lib.length + ')');
    const { tool } = makeRecipeReadTool({ find: name => SkillsCatalog.find(offered, name), view: SkillsCatalog.viewText });
    A.eq([tool.name, tool.capability, tool.impact, tool.scope, tool.requiresConsent], ['recipe.read', 'stationinfo', 'none', 'read', false], 'a read-only, consent-free station self-knowledge tool');
    A.eq(RECIPE_READER, 'recipe.read', 'one name, exported');
    const inline = SkillsCatalog.compose(lib, opts);
    for (const r of offered) {
      const byName = tool.run({ name: SkillsCatalog.viewName(r) });
      A.ok(byName.content === SkillsCatalog.viewText(r), 'recipe.read ' + SkillsCatalog.viewName(r) + ' serves what skill.view serves');
      A.ok(byName.content.indexOf(r.body) >= 0 && inline.indexOf(r.body) >= 0, '...the exact body the inline block carried');
      A.ok(tool.run({ name: r.slug }).content === byName.content && tool.run({ name: r.name.toUpperCase() }).content === byName.content, '...by slug or display name too');
    }
    const notOffered = lib.find(r => offered.indexOf(r) < 0);
    A.ok(/^No installed recipe named /.test(tool.run({ name: SkillsCatalog.viewName(notOffered) }).content), 'a recipe this run was not offered (' + notOffered.slug + ') is not served');
    const off = SkillsCatalog.live(lib, { overrides: { [offered[0].slug]: false }, placedTypes: ['computer'], agentSkills: [] });
    const gated = makeRecipeReadTool({ find: name => SkillsCatalog.find(off, name), view: SkillsCatalog.viewText }).tool;
    A.ok(/^No installed recipe named /.test(gated.run({ name: SkillsCatalog.viewName(offered[0]) }).content), 'a recipe the Commander switched off is not served');
    for (const name of ['Deploy the site', 'deploy-the-site', 'notebook:agent', '../library/plan/SKILL.md', 'library:', '   '])
      A.ok(/^(No installed recipe named |Name a recipe\. )/.test(tool.run({ name }).content), 'nothing but an offered recipe is readable: ' + JSON.stringify(name));
    A.ok(/^Name a recipe\. /.test(tool.run({}).content) && /^Name a recipe\. /.test(tool.run().content), 'no name: says how to name one');
    A.ok(/No installed recipe named/.test(makeRecipeReadTool().tool.run({ name: 'library:plan' }).content), 'with no resolver wired it serves nothing');
    // the index names the reader the run has
    const recipeIndex = SkillsCatalog.composeIndex(lib, opts), indexReader = SkillsCatalog.composeIndex(lib, Object.assign({ reader: RECIPE_READER }, opts));
    A.ok(recipeIndex.split('skill.view').length === 3 && recipeIndex.indexOf('recipe.read') < 0, 'the index names skill.view (twice) when no reader is named: the text it always was');
    A.ok(indexReader === recipeIndex.split('skill.view').join('recipe.read'), 'with the reader named, the index differs only in the tool it names');
    for (const r of offered) A.ok(indexReader.indexOf('[' + SkillsCatalog.viewName(r) + ']') >= 0 && indexReader.indexOf(r.body) < 0, 'the index lists ' + r.slug + ' by the name recipe.read takes, without its body');
    console.log('[prefix-lanes] RECIPES: inline ' + Buffer.byteLength(inline) + ' B -> index ' + Buffer.byteLength(indexReader) + ' B');
    A.ok(Buffer.byteLength(inline) - Buffer.byteLength(indexReader) >= 10000, 'the index is at least 10,000 B smaller than the bodies');
    // the wiring
    A.ok(/makeRecipeReadTool\(\{ find: name => skillsCatalog\.find\(runRecipes, name\), view: skillsCatalog\.viewText \}\)\.register\(registry\);/.test(index), 'the run registers recipe.read over the recipes its prompt offered');
    A.ok(/if \(isTask && coreNames\.indexOf\(RECIPE_READER\) >= 0\) skillBlock = skillsCatalog\.composeIndex\(skillLibrary\(\), Object\.assign\(\{ reader: RECIPE_READER \}, recipeOpts\)\);/.test(index),
      'the prompt carries the index naming recipe.read exactly when recipe.read is on this run\'s wire');
    A.eq(index.split("recipeReader: prefixLaneOn('PREFIX_RECIPES')").length - 1, 2, 'the run and the TOOLSETS preview hand the projection the same switch');
  }

  /* ---------- R2. the whole census matrix ---------- */
  {
    const ON_R = { PREFIX_RECIPES: true };
    let readerRuns = 0, viewRuns = 0, checked = 0;
    for (const sc of C.scenarios()) {
      const base = await C.projectMatrix(ROOT, sc);
      const on = await C.projectMatrix(ROOT, withPrefix(sc, ON_R));
      const wants = !!sc.origin.o.isTask && base.advertised.indexOf('skill.view') < 0;
      A.eq(on.advertised.indexOf(RECIPE_READER) >= 0, wants, sc.id + ': recipe.read is offered ' + (wants ? 'because' : 'only where') + ' the wire has no skill.view');
      A.eq(on.granted, base.granted.concat(wants ? [RECIPE_READER] : []), sc.id + ': ' + (wants ? 'the reader is the ONLY grant added' : 'grants are identical'));
      A.eq(on.advertised, base.advertised.concat(wants ? [RECIPE_READER] : []), sc.id + ': the wire is the same' + (wants ? ', plus the reader' : ''));
      A.eq(on.deferred, base.deferred, sc.id + ': nothing is deferred by the switch');
      A.eq(on.withheldExplained, base.withheldExplained, sc.id + ': nothing is withheld by the switch');
      A.eq(on.unavailable, base.unavailable, sc.id + ': nothing is called unavailable by the switch');
      for (const n of Object.keys(base.rows)) A.eq(on.rows[n], base.rows[n], sc.id + ' ' + n + ': row unchanged');
      A.eq(Object.keys(on.rows).filter(n => !base.rows[n]), wants ? [RECIPE_READER] : [], sc.id + ': no other row appears');
      for (const n of MEMORY_TOOLS) A.eq(on.granted.indexOf(n) >= 0, base.granted.indexOf(n) >= 0, sc.id + ': the SERVER CART\'s ' + n + ' is granted exactly as the room grants it');
      if (wants) {
        readerRuns++;
        A.eq(on.rows[RECIPE_READER], { state: 'advertised', impact: 'none', consent: 'none', source: 'recipe-reader' }, sc.id + ': advertised, no impact, no consent, offered by the host (not a prop)');
        A.ok(base.granted.indexOf('skill.view') < 0 || base.deferred.indexOf('skill.view') >= 0, sc.id + ': this run cannot call skill.view on its first request');
        const cap = await C.runOnceMatrix(ROOT, withPrefix(sc, ON_R));
        A.eq(cap.failNotes, [], sc.id + ': the runOnce cut ran clean');
        A.eq(C.diffMatrix({ [sc.id]: on }, { [sc.id]: C.cellsFromRunOnce(cap, ROOT) }), [], sc.id + ': runOnceCore (the census cut) offers the same reader');
        checked++;
      } else if (sc.origin.o.isTask) viewRuns++;
    }
    A.ok(readerRuns >= 5 && viewRuns >= 10, 'the matrix holds both kinds of task run (' + readerRuns + ' without skill.view, ' + viewRuns + ' with it)');
    A.eq(checked, readerRuns, 'every reader run was re-checked through the runOnce cut');
    const chat = C.scenarios().find(s => s.id === 'desktop.chat@ask');
    A.eq(C.diffMatrix({ x: await C.projectMatrix(ROOT, chat) }, { x: await C.projectMatrix(ROOT, withPrefix(chat, ON_R)) }), [], 'a chat turn (no tools on the wire) is offered nothing');
    const bare = C.scenarios().find(s => s.id === 'desktop.bare@ask');
    A.ok((await C.projectMatrix(ROOT, withPrefix(bare, ON_R))).advertised.indexOf(RECIPE_READER) >= 0, 'the desk with no SERVER CART placed is offered the reader');
    A.ok((await C.projectMatrix(ROOT, bare)).granted.indexOf(RECIPE_READER) < 0 && (await C.projectMatrix(ROOT, withPrefix(bare, { PREFIX_TAIL: true }))).granted.indexOf(RECIPE_READER) < 0,
      'with the switch off, and under another lane\'s switch, no run holds it');
  }

  /* ---------- R3. a station self-knowledge read ---------- */
  {
    A.ok(Object.keys(CAP_REGISTRY).every(k => CAP_REGISTRY[k].every(g => g.tool !== RECIPE_READER)), 'recipe.read is no prop\'s grant (no CAP_REGISTRY row): only the host offers it');
    A.ok(F.TAIL_TOOLS.indexOf(RECIPE_READER) < 0 && F.ALL_CONTROLS.indexOf(RECIPE_READER) < 0, 'it is never held off the wire (the index must point at an advertised tool)');
    const reg2 = makeRegistry();
    makeRecipeReadTool({}).register(reg2);
    A.eq(impactOfTool(reg2.get(RECIPE_READER)), IMPACTS.NONE, 'declared impact none');
    const kept = enforceEnabledToolsets({ tools: [RECIPE_READER], deferred: [], grants: [], approvalRules: {}, networkCaps: {} }, reg2, ['web']);
    A.eq(kept.tools, [RECIPE_READER], 'a routine restricted to other toolsets keeps it, like manual.read (a freebie, never a toggleable family)');
    A.ok(reg.get(RECIPE_READER) && reg.get(RECIPE_READER).impact === 'none', 'the declared catalogue holds it');
  }

  /* ---------- L. the live name list ---------- */
  {
    A.ok(/const liveNamesLean = prefixLaneOn\('LIVE_NAMES'\) && toolDefs\.length > 0 && !o\.outputOnly;/.test(index), 'the list is dropped only under the switch, and only where the request carries tools');
    A.ok(index.indexOf("+ (liveNamesLean ? 'the LIVE tools in your tool list. ' : 'these LIVE tools: ' + wireNames.join(', ') + '. ')\n      + 'Actually use the listed tools when relevant; never claim a listed tool is unavailable. '") >= 0,
      'one gate swaps the joined list for a pointer to it; the sentence after it is untouched');
    A.eq(index.split('liveNamesLean').length - 1, 2, 'liveNamesLean is declared once and used once');
    // the sentences that lean on the list are the ones the base shipped
    for (const piece of ["? 'This list is PARTIAL. You have ' + listedDeferred.length + ' more granted tools that are not loaded yet. '", "+ 'These exist and you CAN use them: ' + listedDeferred.join(', ') + '. '",
      "+ 'To use one, call tool_search with the capability you want (\"take a screenshot\", \"read network responses\") '", "+ 'never report an action as done when you had no tool to perform it. '"])
      A.eq(index.split(piece).length - 1, 1, 'the not-loaded sentence is untouched: ' + piece.slice(0, 50));
    A.ok(/const wireNames = toolDefs\.map\(d => d\.function\.name\);/.test(index), 'the list was the tools array\'s own names');
    // the tools ride the same request wherever [HARNESS] does: the one request handed no tools is internal, and its system is verbatim
    A.ok(/messages: msgs, provider, emit: loopEmit, cost, tools: o\.outputOnly \? \[\] : toolDefs, dispatch, capCtx,/.test(index), 'the loop is handed the advertised tools on every run but an outputOnly one');
    A.ok(/const internal = !!o\.internal \|\| !!o\.outputOnly;/.test(index) && /const sys = internal\s*\? \(String\(system \|\| ''\) \+ evidenceBlock \+ delegatedBlock\)/.test(index), '...and an outputOnly run is internal: its system is the caller\'s own, with no [HARNESS] note');
    // claude-cli: the same tools are text in the same system prompt, each by its name
    const CLI = require('../sidecar/providers/claude-cli.js');
    const defs = reg.wireFormat(reg.list(new Set(commsLead.base.advertised)));
    for (const d of defs) d.function.name = d.function.name.replace(/\./g, '_');
    const toolsText = CLI._internals.toolsPrompt(defs);
    A.ok(defs.length >= 60 && /^# Tools\n/.test(toolsText) && toolsText.indexOf('\nAvailable tools:\n') > 0, 'claude-cli renders the advertised tools as the # Tools text of its system prompt (' + defs.length + ' tools)');
    for (const d of defs) A.ok(toolsText.indexOf('\n- ' + d.function.name + ': ') >= 0, 'claude-cli names ' + d.function.name + ' in that text (the [HARNESS] list repeats it)');
  }

  A.report('prefix-lanes');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
