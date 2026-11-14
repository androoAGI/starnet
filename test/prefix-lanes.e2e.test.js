/* node test/prefix-lanes.e2e.test.js — THE PREFIX COST LANES (cost audit W3.9) through the REAL request assembly of a
   hermetic sidecar. Each lane is one switch, OFF by default (sidecar/index.js prefixLaneOn).

   The fixed prompt a task call re-sends (its system text and tool schemas) is the largest open cause of "StarNet uses my
   plan faster than other harnesses". A lane that trims it changes what a model is shown, so it ships dark, and this test
   holds both halves of that promise from the bytes the sidecar actually sent (test/helpers/prefix-rig.js: a recording
   mock model and a fake claude CLI, no inference):

   OFF. With every switch unset, five calls are BYTE-IDENTICAL to the base commit: a Commander's first COMMS task (comms),
        the same from a floor without the SERVER CART (cartless), the crew lead call (lead), a dispatched worker's first
        call (worker), and the comms call on claude-cli (its system prompt file, argv and stdin). The sha256 of each call
        (whole request, system text, tools array) was recorded on the base, 57c741da7, in
        test/fixtures/prefix-lanes-golden.json; the run id, the Task Brief id, the date and the temp paths are the only
        things normalized. Red on any commit that moves a default byte.

   ON, one lane at a time: what left, that nothing else moved, and the saving in bytes on each call.
   STARNET_PREFIX_TAIL (W3.9a): the Resolve and widget tools and skill.write leave the tools array; the system text is
        the same but for the [HARNESS] not-loaded sentence, which now names them; GET /api/toolsets says 'specialist-tail';
        a widget's own update run still carries widget_get and widget_set from its first call; and a model that searches
        for widget_set gets it on its next call and publishes a reading with it.
   STARNET_PREFIX_DOCTRINE (W3.9b): the system text is the base's with exactly two edits and nothing else: where the manual
        index rides, CONNECTING A PLATFORM is its rules (manual.js CONNECTING_CORE), and HOW TO WORK is without the three
        sentences FINISH THE JOB restates. FINISH THE JOB is byte-identical and still last; the tools array is untouched;
        and a model that calls manual_read connecting gets the whole section, every moved sentence in it.
   STARNET_PREFIX_RECIPES (W3.9c): the calls that carry skill_view are byte-identical. The floor without the SERVER CART
        gains one tool, recipe_read, and its system text carries the recipe index (naming recipe.read) where every enabled
        recipe body was inline; no memory tool comes with it; recipe_read library:plan returns the recipe, and a name that
        was not offered returns nothing.

   Record the golden only on the base (or when a default byte changes on purpose, saying so in that commit):
     node test/prefix-lanes.e2e.test.js --update */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const R = require('./helpers/prefix-rig.js');
const M = require('../sidecar/manual.js');
const FinishLine = require('../sidecar/finish-line.js');
const SkillsCatalog = require('../sidecar/skills/catalog.js');

const GOLDEN = path.join(__dirname, 'fixtures', 'prefix-lanes-golden.json');
const CALLS = ['comms', 'cartless', 'lead', 'worker'];
const TAIL_WIRE = ['resolve_timeline_file', 'resolve_status', 'resolve_control', 'widget_get', 'widget_set', 'skill_write'];
const PARTIAL_RE = /This list is PARTIAL\. You have \d+ more granted tools that are not loaded yet\. These exist and you CAN use them: [^.]*\./;
// the joined list of the tools on the wire, as [HARNESS] opens with it
const LIVE_RE = /these LIVE tools: ([^.]*)\. /;
const liveNames = sys => { const m = LIVE_RE.exec(String(sys)); return m ? m[1].split(', ') : []; };
// the system text with its two tool-name lists blanked: what a deferral must leave byte-identical
const withoutNameLists = sys => String(sys).replace(LIVE_RE, '<LIVE>').replace(PARTIAL_RE, '<PARTIAL>');

const toolBytes = x => R.bytes(JSON.stringify(x.tools));
// the request without its system text and tools array, normalized: the user turn, its host notes and every other field
const restOf = (x, known) => R.normalize(JSON.stringify(Object.assign({}, x.body, { tools: undefined, messages: (x.body.messages || []).filter(m => m && m.role !== 'system') })), known);
const readGolden = () => { try { return JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); } catch (_) { return null; } };

// the saving of one lane on one call, printed and returned: system text, tool schemas, and their sum (the fixed prefix)
function saving(lane, id, off, on) {
  const s = { system: R.bytes(off.system) - R.bytes(on.system), tools: toolBytes(off) - toolBytes(on) };
  s.prefix = s.system + s.tools;
  console.log('[prefix-lanes] ' + lane + ' ' + id + ': system ' + R.bytes(off.system) + ' -> ' + R.bytes(on.system) + ' B | tools ' + off.tools.length + ' -> ' + on.tools.length
    + ', ' + toolBytes(off) + ' -> ' + toolBytes(on) + ' B | fixed prefix ' + (R.bytes(off.system) + toolBytes(off)) + ' -> ' + (R.bytes(on.system) + toolBytes(on)) + ' B (saves ' + s.prefix + ')');
  return s;
}
function cliSaving(lane, off, on) {
  const saved = R.bytes(off.cli.system) - R.bytes(on.cli.system);
  console.log('[prefix-lanes] ' + lane + ' claude-cli: system prompt file ' + R.bytes(off.cli.system) + ' -> ' + R.bytes(on.cli.system) + ' B (saves ' + saved + ')');
  return saved;
}

/* ---------------------------------------------------------------- STARNET_PREFIX_TAIL */
async function tailScenarios(ctx) {
  const out = {};
  // a widget the Commander configured: its own conversation ('widget-' + id) is its update run
  const made = await ctx.fixture.json('POST', '/api/widgets/configure', { id: 'rig-own', label: 'RIG OWN', request: 'Show the number 42.', display: 'metric', source: { kind: 'agent', id: 'starnet' } });
  out.configured = made.status === 200 && !(made.body && made.body.error);
  let from = ctx.mark();
  await ctx.task('widget-rig-own', ctx.starter, 'Refresh my saved widget "RIG OWN".');
  out.own = ctx.call(ctx.mainOf(from, 'Refresh my saved widget'));
  // an ordinary COMMS task whose model looks the held tool up by the name the [HARNESS] list shows, then uses it
  from = ctx.mark();
  const words = R.scripted([
    { name: 'brief_proceed', args: { objective: 'Publish one reading to a station widget', deliverable: 'The widget shows 7' } },
    { name: 'tool_search', args: { query: 'widget_set' } },
    { name: 'widget_set', args: { id: 'rig-load', label: 'RIG LOAD', value: '7' } }]);
  out.loadRun = await ctx.task('prefix-rig-load', ctx.starter, words);
  out.load = ctx.bodiesFrom(from).filter(b => Array.isArray(b.tools) && b.tools.length);
  out.widgets = ((await ctx.fixture.json('GET', '/api/widgets')).body || {}).widgets || [];
  return out;
}

function checkTail(off, on) {
  const lane = 'STARNET_PREFIX_TAIL';
  const floors = { comms: 6500, cartless: 3300, lead: 6500, worker: 6500 };
  for (const id of CALLS) {
    const a = off[id], b = on[id];
    A.ok(a && b, lane + ' ' + id + ': the call was captured off and on');
    if (!a || !b) continue;
    const moved = a.names.filter(n => TAIL_WIRE.indexOf(n) >= 0);
    A.ok(moved.length >= 3, lane + ' ' + id + ': the base call carries tail tools (' + moved.join(', ') + ')');
    A.eq(b.names, a.names.filter(n => moved.indexOf(n) < 0), lane + ' ' + id + ': exactly the tail tools leave the tools array; every other tool keeps its place');
    A.ok(JSON.stringify(b.tools) === JSON.stringify(a.tools.filter(t => moved.indexOf(t.function.name) < 0)), lane + ' ' + id + ': every remaining tool schema is byte-identical');
    A.eq(R.namedDeferred(b.system).slice().sort(), R.namedDeferred(a.system).concat(moved).sort(), lane + ' ' + id + ': each one is NAMED in the [HARNESS] list of granted tools that are not loaded yet');
    A.ok(PARTIAL_RE.test(a.system) && PARTIAL_RE.test(b.system) && LIVE_RE.test(a.system) && LIVE_RE.test(b.system), lane + ' ' + id + ': the live list and the not-loaded sentence are there off and on');
    A.eq(liveNames(b.system), b.names, lane + ' ' + id + ': the [HARNESS] live list is the tools array, name for name');
    A.ok(withoutNameLists(b.system) === withoutNameLists(a.system), lane + ' ' + id + ': the system text is otherwise byte-identical (the names moved from the live list to the not-loaded list)');
    A.ok(new RegExp('You have ' + (R.namedDeferred(a.system).length + moved.length) + ' more granted tools').test(b.system), lane + ' ' + id + ': the count of not-loaded tools counts them');
    A.ok(restOf(b, on.known) === restOf(a, off.known), lane + ' ' + id + ': the rest of the request (the user turn, its host notes, every other field) is identical');
    const s = saving(lane, id, a, b);
    A.ok(s.tools > 0 && Math.abs(s.system) <= 16 && s.prefix >= floors[id], lane + ' ' + id + ': saves ' + s.prefix + ' B of fixed prefix, all of it tool schemas (at least ' + floors[id] + ')');
  }
  A.ok(off.comms.names.filter(n => TAIL_WIRE.indexOf(n) >= 0).length === 6, lane + ': all six tail tools ride the base COMMS call');
  for (const n of ['image_generate', 'image_analyze', 'voice_generate', 'skill_manage', 'skill_view', 'skill_list', 'notebook_write', 'notebook_read', 'tool_search'])
    A.ok(on.comms.names.indexOf(n) >= 0, lane + ': ' + n + ' stays advertised (the studio\'s and the memory\'s headline tools, and the finder)');
  // claude-cli: the same tools are text in the system prompt file
  A.ok(off.cli && on.cli, lane + ' claude-cli: the call was captured off and on');
  if (off.cli && on.cli) {
    for (const n of TAIL_WIRE) {
      A.ok(off.cli.system.indexOf('\n- ' + n + ': ') >= 0 && on.cli.system.indexOf('\n- ' + n + ': ') < 0, lane + ' claude-cli: ' + n + ' leaves the # Tools text');
      A.ok(R.namedDeferred(on.cli.system).indexOf(n) >= 0, lane + ' claude-cli: ' + n + ' is named in [HARNESS]');
    }
    A.eq(JSON.stringify(on.cli.args.slice(0, -1)), JSON.stringify(off.cli.args.slice(0, -1)), lane + ' claude-cli: the argv is the same (but for the prompt file\'s temp name)');
    A.ok(R.normalize(on.cli.stdin, on.known) === R.normalize(off.cli.stdin, off.known), lane + ' claude-cli: the stdin is identical');
    const saved = cliSaving(lane, off, on);
    A.ok(saved >= 6000, lane + ' claude-cli: saves ' + saved + ' B of system prompt file (at least 6000)');
  }
  // GET /api/toolsets says the same, with the reason
  const view = on.preview || {};
  for (const n of ['resolve_timeline_file', 'resolve_status', 'resolve_control', 'widget.get', 'widget.set', 'skill.write']) {
    A.ok((view.deferred || []).indexOf(n) >= 0 && view.rows && view.rows[n] && view.rows[n].reason === 'specialist-tail', lane + ': GET /api/toolsets previews ' + n + ' deferred as specialist-tail');
    A.ok(((off.preview || {}).advertised || []).indexOf(n) >= 0, lane + ': ...and advertised with the switch off');
  }
  // a widget's own update run keeps its two tools from the first call
  const x = on.extra || {};
  A.ok(x.configured, lane + ': a widget was configured');
  A.ok(x.own && x.own.names.indexOf('widget_set') >= 0 && x.own.names.indexOf('widget_get') >= 0, lane + ': a widget\'s own update run carries widget_get and widget_set on its first call');
  A.ok(x.own && R.namedDeferred(x.own.system).indexOf('widget_set') < 0 && R.namedDeferred(x.own.system).indexOf('resolve_status') >= 0, lane + ': ...and only the rest of the tail is held there');
  // searched by its listed name, loaded, used
  const load = x.load || [];
  A.eq(x.loadRun && x.loadRun.end && x.loadRun.end.reason, 'done', lane + ': the search-and-use run completes');
  A.ok(load.length >= 4, lane + ': the model was called after the brief, after tool_search and after widget_set (' + load.length + ' calls)');
  const before = load.find(b => R.toolNames(b).indexOf('widget_set') < 0), after = load.find(b => R.toolNames(b).indexOf('widget_set') >= 0);
  A.ok(before && after, lane + ': widget_set is off the first call and on a later one');
  if (before && after) {
    A.eq(R.toolNames(after).slice(0, R.toolNames(before).length), R.toolNames(before), lane + ': the reveal only appends (every advertised tool keeps its place)');
    const searched = (after.messages || []).filter(m => m.role === 'tool').map(m => R.text(m.content)).join('\n');
    A.ok(/widget[._]set/.test(searched), lane + ': tool_search answered with widget.set (' + searched.slice(0, 120).replace(/\n/g, ' ') + ')');
  }
  const last = load[load.length - 1] || {};
  const results = (last.messages || []).filter(m => m.role === 'tool').map(m => R.text(m.content));
  A.ok(results.length >= 3 && !/SCRIPT MISSING/.test(JSON.stringify(last.messages || [])), lane + ': every scripted call was on the wire when the model made it');
  const pinned = (x.widgets || []).find(w => w && w.id === 'rig-load');
  A.ok(pinned && String(pinned.value) === '7', lane + ': the loaded widget_set really published the reading (' + JSON.stringify(pinned && { id: pinned.id, value: pinned.value }) + ')');
}

/* ---------------------------------------------------------------- STARNET_PREFIX_DOCTRINE */
// the base system text with the lane's two edits applied by hand: what the switch must produce, byte for byte
function doctrineOf(system) {
  let out = String(system);
  if (out.indexOf(M.starnetManualIndex()) >= 0) out = out.replace(M.manualSection('connecting'), () => M.CONNECTING_CORE);
  for (const r of FinishLine.RESTATED) out = out.replace(r.howToWork, () => '');
  return out;
}
const finishOf = system => { const at = String(system).lastIndexOf(FinishLine.MARKER); return at < 0 ? '' : String(system).slice(at); };

async function doctrineScenarios(ctx) {
  const from = ctx.mark();
  const run = await ctx.task('prefix-rig-manual', ctx.starter, R.scripted([{ name: 'manual_read', args: { section: 'connecting' } }, { name: 'manual_read', args: {} }]));
  return { run, calls: ctx.bodiesFrom(from).filter(b => Array.isArray(b.tools) && b.tools.length) };
}

function checkDoctrine(off, on) {
  const lane = 'STARNET_PREFIX_DOCTRINE';
  const section = M.manualSection('connecting');
  const floors = { comms: 1900, cartless: 1900, lead: 1900, worker: 400 };
  for (const id of CALLS) {
    const a = off[id], b = on[id];
    A.ok(a && b, lane + ' ' + id + ': the call was captured off and on');
    if (!a || !b) continue;
    const hasIndex = a.system.indexOf(M.starnetManualIndex()) >= 0;
    A.eq(hasIndex, id !== 'worker', lane + ' ' + id + ': ' + (id === 'worker' ? 'a worker carries no operator manual' : 'the base call carries the manual index'));
    for (const r of FinishLine.RESTATED) A.eq(a.system.split(r.howToWork).length - 1, 1, lane + ' ' + id + ': the base HOW TO WORK carries the sentence once: ' + r.howToWork.slice(0, 40));
    A.ok(b.system === doctrineOf(a.system), lane + ' ' + id + ': the system text is the base with ' + (hasIndex ? 'CONNECTING as its core and ' : '') + 'the three restated sentences out, and nothing else');
    A.ok(finishOf(b.system) === finishOf(a.system) && finishOf(a.system).length > 1000 && b.system.endsWith(finishOf(a.system)), lane + ' ' + id + ': FINISH THE JOB is byte-identical and still closes the prompt');
    for (const r of FinishLine.RESTATED) A.ok(r.here.every(line => finishOf(b.system).indexOf(line) >= 0), lane + ' ' + id + ': FINISH THE JOB says it: ' + r.howToWork.slice(0, 40));
    A.ok(b.system.indexOf('HOW TO WORK: Always take the QUIETEST path that achieves the goal') >= 0 && b.system.indexOf('VERIFY it took effect with a read-back tool') >= 0
      && b.system.indexOf('Escalate automatically through safe authorized routes') >= 0, lane + ' ' + id + ': HOW TO WORK keeps the quiet-path ladder, the read-back rule and the escalation rule');
    if (hasIndex) {
      A.ok(b.system.indexOf(M.starnetManualIndexLean()) >= 0 && b.system.indexOf(section) < 0, lane + ' ' + id + ': the lean index rides in the place of the index');
      A.ok(b.names.indexOf('manual_read') >= 0 && b.names.indexOf('connectors_list') >= 0, lane + ' ' + id + ': manual_read and connectors_list, which the core names, are on the wire');
    }
    A.ok(JSON.stringify(b.tools) === JSON.stringify(a.tools), lane + ' ' + id + ': the tools array is byte-identical');
    A.ok(restOf(b, on.known) === restOf(a, off.known), lane + ' ' + id + ': the rest of the request is identical');
    const s = saving(lane, id, a, b);
    A.ok(s.tools === 0 && s.prefix >= floors[id], lane + ' ' + id + ': saves ' + s.prefix + ' B of fixed prefix, all of it system text (at least ' + floors[id] + ')');
  }
  A.ok(off.cli && on.cli, lane + ' claude-cli: the call was captured off and on');
  if (off.cli && on.cli) {
    A.ok(on.cli.system === doctrineOf(off.cli.system), lane + ' claude-cli: the system prompt file is the base with the same two edits, and nothing else');
    A.eq(JSON.stringify(on.cli.args.slice(0, -1)), JSON.stringify(off.cli.args.slice(0, -1)), lane + ' claude-cli: the argv is the same (but for the temp name of the prompt file)');
    A.ok(R.normalize(on.cli.stdin, on.known) === R.normalize(off.cli.stdin, off.known), lane + ' claude-cli: the stdin is identical');
    const saved = cliSaving(lane, off, on);
    A.ok(saved >= 1900, lane + ' claude-cli: saves ' + saved + ' B of system prompt file (at least 1900)');
  }
  // one manual.read away: the whole section, and manual.read knows it is not in the prompt
  const x = on.extra || {};
  A.eq(x.run && x.run.end && x.run.end.reason, 'done', lane + ': the manual.read run completes');
  const last = (x.calls || [])[(x.calls || []).length - 1] || {};
  const results = (last.messages || []).filter(m => m.role === 'tool').map(m => R.text(m.content));
  A.eq(results.length, 2, lane + ': both manual_read calls answered');
  const lines = section.split('\n').filter(Boolean);
  A.ok(lines.length >= 8 && lines.every(line => (results[0] || '').indexOf(line) >= 0), lane + ': manual_read connecting put the WHOLE section in front of the model, every moved line in it (' + lines.length + ' lines)');
  A.ok(/Reference sections: navigation, props, connecting, troubleshooting, concepts\. Already in your prompt: about, live-state, connectors, approval\./.test(results[1] || ''),
    lane + ': manual_read lists connecting as a section to read on this run (' + String(results[1] || '').slice(0, 160) + ')');
}

/* ---------------------------------------------------------------- STARNET_PREFIX_RECIPES */
const MEMORY_WIRE = ['notebook_write', 'notebook_read', 'notebook_feedback', 'recall_conversation', 'skill_write', 'skill_manage', 'skill_list', 'skill_view', 'widget_get', 'widget_set'];
const LIB = SkillsCatalog.loadDir(path.join(__dirname, '..', 'sidecar', 'skills', 'library'), fs, path);
// the recipes the cart-less floor is offered: its room's gear (the lead's office and its placed props), nothing switched off
const cartlessOpts = starter => ({ overrides: {}, placedTypes: ['computer', 'orchestrator'].concat(starter.filter(t => t !== 'notebook')), agentSkills: [] });

async function recipeScenarios(ctx) {
  const cartless = ctx.starter.filter(t => t !== 'notebook');
  const from = ctx.mark();
  const run = await ctx.task('prefix-rig-recipes', cartless, R.scripted([
    { name: 'recipe_read', args: { name: 'library:plan' } }, { name: 'recipe_read', args: { name: 'Make a Plan' } }, { name: 'recipe_read', args: { name: 'library:no-such-recipe' } }]));
  const view = (await ctx.fixture.json('GET', '/api/toolsets?placed=' + encodeURIComponent(cartless.map(t => encodeURIComponent(t)).join(',')))).body || {};
  return { run, calls: ctx.bodiesFrom(from).filter(b => Array.isArray(b.tools) && b.tools.length), preview: view.run || null };
}

function checkRecipes(off, on) {
  const lane = 'STARNET_PREFIX_RECIPES';
  // a run that has skill.view is untouched
  for (const id of ['comms', 'lead', 'worker']) {
    const a = off[id], b = on[id];
    A.ok(a && b && a.names.indexOf('skill_view') >= 0, lane + ' ' + id + ': the call carries skill_view');
    A.ok(b.system === a.system && JSON.stringify(b.tools) === JSON.stringify(a.tools) && restOf(b, on.known) === restOf(a, off.known), lane + ' ' + id + ': byte-identical with the switch on (it reads recipes with skill_view already)');
    A.ok(b.names.indexOf('recipe_read') < 0, lane + ' ' + id + ': recipe_read is not offered where skill_view is');
  }
  A.ok(off.cli && on.cli && on.cli.system === off.cli.system, lane + ' claude-cli: the comms call is byte-identical (it has skill_view)');
  // the floor without the SERVER CART
  const a = off.cartless, b = on.cartless;
  const opts = cartlessOpts(off.starter);
  const inline = SkillsCatalog.compose(LIB, opts), index = SkillsCatalog.composeIndex(LIB, Object.assign({ reader: 'recipe.read' }, opts));
  A.ok(inline.length > 10000 && a.system.split(inline).length === 2, lane + ' cartless: the base call carries every enabled recipe body inline (' + R.bytes(inline) + ' B)');
  A.eq(b.names.filter(n => n !== 'recipe_read'), a.names, lane + ' cartless: every tool keeps its place');
  A.eq(b.names.filter(n => n === 'recipe_read').length, 1, lane + ' cartless: recipe_read joins the wire, once');
  A.ok(JSON.stringify(b.tools.filter(t => t.function.name !== 'recipe_read')) === JSON.stringify(a.tools), lane + ' cartless: every other tool schema is byte-identical');
  for (const n of MEMORY_WIRE) A.ok(b.names.indexOf(n) < 0 && R.namedDeferred(b.system).indexOf(n) < 0, lane + ' cartless: ' + n + ' is neither on the wire nor loadable (no SERVER CART power came with the reader)');
  A.eq(liveNames(b.system), b.names, lane + ' cartless: the [HARNESS] live list is the tools array, name for name');
  A.ok(b.system.replace(LIVE_RE, '<LIVE>') === a.system.replace(inline, () => index).replace(LIVE_RE, '<LIVE>'), lane + ' cartless: the system text is the base with the recipe bodies replaced by their index, and nothing else (but the live list, which names the reader)');
  const block = b.system.slice(b.system.indexOf('## INSTALLED SKILLS'), b.system.indexOf('## INSTALLED SKILLS') + index.length);
  A.ok(block.indexOf('recipe.read') > 0 && block.indexOf('skill.view') < 0, lane + ' cartless: the index names recipe.read, the reader this run has, and never skill.view');
  for (const r of SkillsCatalog.live(LIB, opts)) A.ok(b.system.indexOf('[' + SkillsCatalog.viewName(r) + ']') >= 0 && b.system.indexOf(r.body) < 0, lane + ' cartless: ' + r.slug + ' is indexed, its body no longer inline');
  A.ok(restOf(b, on.known) === restOf(a, off.known), lane + ' cartless: the rest of the request is identical');
  const s = saving(lane, 'cartless', a, b);
  A.ok(s.system >= 10500 && s.tools < 0 && s.tools > -600 && s.prefix >= 10000, lane + ' cartless: saves ' + s.prefix + ' B of fixed prefix (the bodies, less the reader\'s own schema; at least 10000)');
  // the same floor on claude-cli: the index and the reader's own line are text in the system prompt file
  A.ok(off.cartlessCli && on.cartlessCli, lane + ' cartless claude-cli: the call was captured off and on');
  if (off.cartlessCli && on.cartlessCli) {
    A.ok(off.cartlessCli.system.indexOf(inline) >= 0 && on.cartlessCli.system.indexOf(index) >= 0 && on.cartlessCli.system.indexOf(inline) < 0, lane + ' cartless claude-cli: the bodies are replaced by the index there too');
    A.ok(on.cartlessCli.system.indexOf('\n- recipe_read: ') >= 0 && off.cartlessCli.system.indexOf('\n- recipe_read: ') < 0, lane + ' cartless claude-cli: recipe_read is in the # Tools text');
    const saved = R.bytes(off.cartlessCli.system) - R.bytes(on.cartlessCli.system);
    console.log('[prefix-lanes] ' + lane + ' cartless claude-cli: system prompt file ' + R.bytes(off.cartlessCli.system) + ' -> ' + R.bytes(on.cartlessCli.system) + ' B (saves ' + saved + ')');
    A.ok(saved >= 10000, lane + ' cartless claude-cli: saves ' + saved + ' B of system prompt file (at least 10000)');
  }
  // the reader works, and serves only what was offered
  const x = on.extra || {};
  A.eq(x.run && x.run.end && x.run.end.reason, 'done', lane + ': the recipe_read run completes');
  const last = (x.calls || [])[(x.calls || []).length - 1] || {};
  const results = (last.messages || []).filter(m => m.role === 'tool').map(m => R.text(m.content));
  A.eq(results.length, 3, lane + ': all three recipe_read calls answered (' + JSON.stringify(last.messages && last.messages.filter(m => m.role === 'assistant').map(m => m.content)).slice(0, 120) + ')');
  const plan = SkillsCatalog.find(SkillsCatalog.live(LIB, opts), 'library:plan');
  A.ok(!!plan && (results[0] || '').indexOf(plan.body.trim()) >= 0 && (results[0] || '').indexOf('[library:plan]') >= 0, lane + ': recipe_read library:plan put the whole recipe in front of the model, the body the base inlined');
  A.ok((results[1] || '') === (results[0] || ''), lane + ': the display name loads the same text');
  A.ok(/No installed recipe named "library:no-such-recipe"/.test(results[2] || ''), lane + ': a recipe that was not offered is not served');
  const view = x.preview || {};
  A.ok((view.advertised || []).indexOf('recipe.read') >= 0 && view.rows && view.rows['recipe.read'] && view.rows['recipe.read'].source === 'recipe-reader' && view.rows['recipe.read'].state === 'advertised',
    lane + ': GET /api/toolsets previews the cart-less floor with recipe.read advertised, offered by the host');
  A.ok(((on.preview || {}).advertised || []).indexOf('recipe.read') < 0, lane + ': ...and the starter floor (it has the cart) without it');
}

const LANES = [
  { env: 'STARNET_PREFIX_TAIL', scenarios: tailScenarios, check: checkTail },
  { env: 'STARNET_PREFIX_DOCTRINE', scenarios: doctrineScenarios, check: checkDoctrine },
  { env: 'STARNET_PREFIX_RECIPES', scenarios: recipeScenarios, check: checkRecipes }
];

(async () => {
  if (process.argv.includes('--update')) {
    const c = await R.capture({});
    let d; try { d = R.digests(c); } finally { await c.close(); }
    let at = 'unknown';
    try { at = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim(); } catch (_) { /* not a git tree */ }
    const golden = readGolden() || { about: '', platforms: {} };
    golden.about = 'sha256 of the five calls test/prefix-lanes.e2e.test.js captures with every prefix-lane switch OFF (whole request, system text, tools array; claude-cli: system prompt file, argv, stdin), per platform (the prompt names the host shell). Re-record (--update) only on the base, or when a default byte changes on purpose for a reason outside these lanes, and say so in that commit.';
    golden.platforms[process.platform] = { recordedAt: at, calls: d };
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + '\n');
    console.log('prefix-lanes golden recorded for ' + process.platform + ' at ' + at);
    process.exit(0);
  }

  // ================= every switch OFF: byte-identical to the base =================
  const off = await R.capture({});
  await off.close();
  for (const id of CALLS) A.ok(off[id] && off[id].tools.length > 10 && R.bytes(off[id].system) > 5000, 'off ' + id + ': a real task call was captured (' + (off[id] ? off[id].tools.length + ' tools, ' + R.bytes(off[id].system) + ' B of system text' : 'missing') + ')');
  A.ok(off.cli && off.cli.calls === 1 && R.bytes(off.cli.system) > 20000, 'off claude-cli: one CLI call carries the system prompt file with the # Tools text');
  A.ok(off.leadRun && off.leadRun.prompts.length === 1 && /team[._]dispatch/.test(String(off.leadRun.prompts[0].tool || '')), 'off lead: team.dispatch asked once and was approved once (ASK approval, as a default station)');
  A.ok(off.worker && off.worker.names.indexOf('shell_exec') < 0 && off.worker.names.indexOf('team_dispatch') < 0, 'off worker: an ASK-mode worker (no shell, no re-delegation)');
  A.ok(off.cartless.names.indexOf('skill_view') < 0 && off.comms.names.indexOf('skill_view') >= 0, 'off cartless: the floor without the SERVER CART has no skill_view');
  const golden = readGolden();
  const base = golden && golden.platforms && golden.platforms[process.platform];
  const now = R.digests(off);
  if (!base) {
    console.log('[prefix-lanes] no golden for ' + process.platform + ' (recorded on: ' + Object.keys((golden && golden.platforms) || {}).join(', ') + '): the base comparison is skipped on this platform');
  } else {
    for (const id of CALLS.concat(['cli'])) {
      A.eq(now[id], base.calls[id], 'off ' + id + ': every switch unset is BYTE-IDENTICAL to the base ' + base.recordedAt + ' (request, system text, tools' + (id === 'cli' ? ': system prompt file, argv, stdin' : '') + ')');
    }
  }
  A.ok(!!base || process.platform !== 'win32', 'the golden holds the platform the gate runs on (win32)');

  // ================= one lane ON at a time (--lane=<switch> runs that one alone, for work on a single lane) =================
  const only = (process.argv.find(a => a.indexOf('--lane=') === 0) || '').slice('--lane='.length);
  for (const lane of LANES.filter(l => !only || l.env === only)) {
    const on = await R.capture({ [lane.env]: '1' }, { scenarios: lane.scenarios });
    await on.close();
    lane.check(off, on);
  }

  A.report('prefix-lanes.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
