'use strict';
/* node test/toolsearch.specialist-tail.test.js — tool_search FINDS A HELD SPECIALIST-TAIL TOOL BY THE WORDS A PERSON USES
   (cost audit W3.9a, STARNET_PREFIX_TAIL; sidecar/tools/builtin/toolsearch.js ANSWERS TO, capability/followups.js TAIL_WORDS).

   With the switch on, the DaVinci Resolve tools, the rail widget tools and skill.write leave the first request. They stay
   granted and named in [HARNESS], and nothing reveals one but a search, so the search has to return it. Measured on the
   real shelf of a COMMS lead with the tail held, it did not: tool_search weighs a name's LEAF, a widget tool says "widget"
   only in its namespace, no Resolve tool says "video" anywhere, and a verb that is another tool's whole name ("create",
   "update", "publish", "edit") clears the relevance floor alone. "create a dashboard widget" returned app.create alone,
   "update my widget" and "edit a video" nothing; 39 of the 90 natural asks below missed their tool.

   The rule: a held tail tool answers to its FAMILY word, the first word of its name (widget, skill, resolve), and to the
   plain words the lane lists for its family (TAIL_WORDS). A search that SAYS one of a held tool's words returns it after
   the scored hits, whatever the floor, the listed tools or the hit cap decided. Nothing is rescored.

     G. OFF IS TODAY'S SEARCH. A golden of the whole answer (the revealed names in rank order, the listed names, a hash
        of the text) for 150 queries over five real shelves, recorded on the base scorer (57c741da7): the catalogue's own
        deferred split as test/toolsearch.phrases-real.test.js builds it, and the projection's shelf for a COMMS lead on
        a fresh floor, the same lead with live follow-ups, a crew lead and a worker. A sixth shelf holds the tail with no
        words handed in (the switch on, before this rule): the rule is the fact's alone, never the pool's. With the
        switch off the projection hands the search no words, on every scenario of the authority census.
     W. THE WORDS. Each family is a tail tool's first name word; each plain word is one lowercase word, and each one is
        needed: a pinned ask misses without it and is answered with it.
     N. ON, 90 NATURAL ASKS. Several phrasings per tail tool, on every shelf that holds it: the tool is among the hits.
        Four asks that say no word of the tool's are pinned as NOT found (LIMITS), so the list of misses is exact.
     U. ON, 92 UNRELATED ASKS (browser, files, shell, station building, apps, routines, connectors, channels, crew,
        media). Each is answered byte for byte as it was before this rule, on every shelf. Against the switch off, on
        the lead's shelves: its first result is the same and it reveals the same tools, plus at most a tail tool whose
        own name or text matched (the off search had it in the tool list). The two exceptions are pinned (LANE_MOVED);
        both are the lane's, there with and without this rule: a shelf six tools larger weighs a word a little differently.
     F. THE FLOOR, THE LISTED TOOLS AND THE CAP never cut a tool the query names; a word must be a whole word (or its
        plural); a tool that is not on this run's shelf is never returned; a malformed fact is ignored.
     H. THE HOST. The projection hands the words only for the tail tools it holds, and runOnce hands tool_search exactly
        that (one line, beside ctx.advertised).

   Re-record the golden only on the base scorer, or when a search result changes on purpose with the switch off for a
   reason outside this rule, and say so in that commit:
     node test/toolsearch.specialist-tail.test.js --update */
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('../sidecar/capability/followups.js');
const C = require('./helpers/authority-census.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
const { makeStationControlTools } = require('../sidecar/tools/builtin/station-control.js');
const { makeStationShowTool } = require('../sidecar/tools/builtin/station-show.js');
const { makeAppTools } = require('../sidecar/tools/builtin/apps.js');
const { makeLoopTools } = require('../sidecar/tools/builtin/loops.js');
const { makeRoutineTools } = require('../sidecar/tools/builtin/routines.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
const { readSidecarIndex } = require('./helpers/source');

const ROOT = path.resolve(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'toolsearch-off-golden.json');
const BASE = '57c741da7';
const TAIL = ['resolve_timeline_file', 'resolve_status', 'resolve_control', 'widget.get', 'widget.set', 'skill.write'];
const RESOLVE = ['resolve_timeline_file', 'resolve_status', 'resolve_control'];
const NONE = { terminal: false, shellBg: false, routines: false, loops: false, tasks: false };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const withFacts = (sc, more) => Object.assign({}, sc, { facts: Object.assign({}, sc.facts, more) });

/* ---------------------------------------------------------------- the asks */
// N. [ask, the tail tool it is for]. The first ten are the asks this rule was written against.
const NATURAL = [
  ['create a dashboard widget', 'widget.set'], ['publish a reading to a dashboard widget', 'widget.set'], ['update my widget', 'widget.set'],
  ['set the dashboard tile value', 'widget.set'], ['read what a widget shows', 'widget.get'], ['is DaVinci Resolve running', 'resolve_status'],
  ['cut the timeline', 'resolve_timeline_file'], ['import a clip into the Resolve timeline', 'resolve_control'], ['save this as a skill', 'skill.write'],
  ['write a new skill', 'skill.write'],
  // widget.set
  ['widget', 'widget.set'], ['widgets', 'widget.set'], ['show a number on the widget rail', 'widget.set'], ['add a widget to the station', 'widget.set'],
  ['make a widget showing app revenue', 'widget.set'], ['publish a widget', 'widget.set'], ['post a metric to the widget rail', 'widget.set'],
  ['refresh the widget value', 'widget.set'], ['create widget', 'widget.set'], ['show subscriber count on a widget', 'widget.set'],
  ['change what the widget displays', 'widget.set'], ['new widget', 'widget.set'], ['how do I make a widget', 'widget.set'],
  ['write a value to a widget', 'widget.set'], ['edit my widget', 'widget.set'], ['update the dashboard tile', 'widget.set'],
  ['update the widget on the rail', 'widget.set'], ['pin a live readout on screen', 'widget.set'], ['widget_set', 'widget.set'],
  // widget.get
  ['get the widget definition', 'widget.get'], ['read a saved widget', 'widget.get'], ['what does my widget say', 'widget.get'],
  ['read the widget refresh instructions', 'widget.get'], ['look up a widget', 'widget.get'], ['check the widget before a scheduled update', 'widget.get'],
  ['inspect a widget', 'widget.get'], ['open the widget settings', 'widget.get'], ['list widgets', 'widget.get'], ['show my widgets', 'widget.get'],
  ['widget_get', 'widget.get'],
  // resolve_status
  ['davinci resolve', 'resolve_status'], ['check resolve status', 'resolve_status'], ['is Resolve open', 'resolve_status'],
  ['which resolve project is open', 'resolve_status'], ['list the timelines in DaVinci Resolve', 'resolve_status'], ['is the video editor installed', 'resolve_status'],
  ['video editor status', 'resolve_status'], ['is my video editor running', 'resolve_status'], ['what timeline is open', 'resolve_status'],
  ['create a DaVinci project', 'resolve_status'], ['resolve_status', 'resolve_status'],
  // resolve_timeline_file
  ['build a video timeline from clips', 'resolve_timeline_file'], ['edit a video', 'resolve_timeline_file'], ['make a rough cut of these clips', 'resolve_timeline_file'],
  ['create an fcpxml timeline', 'resolve_timeline_file'], ['assemble clips into an edit', 'resolve_timeline_file'], ['write a timeline file for DaVinci', 'resolve_timeline_file'],
  ['video editing', 'resolve_timeline_file'], ['create a timeline', 'resolve_timeline_file'], ['edit my video', 'resolve_timeline_file'],
  ['cut a video together', 'resolve_timeline_file'], ['put these clips in order on a timeline', 'resolve_timeline_file'], ['edit footage', 'resolve_timeline_file'],
  ['make a movie from these photos', 'resolve_timeline_file'], ['cut a short film', 'resolve_timeline_file'], ['add music under the video', 'resolve_timeline_file'],
  // resolve_control
  ['render the resolve timeline', 'resolve_control'], ['render a video in DaVinci Resolve', 'resolve_control'], ['launch DaVinci Resolve', 'resolve_control'],
  ['open resolve', 'resolve_control'], ['import media into resolve', 'resolve_control'], ['add a marker to the timeline', 'resolve_control'],
  ['export the video from resolve', 'resolve_control'], ['render the video', 'resolve_control'], ['export my video', 'resolve_control'],
  ['import footage', 'resolve_control'], ['resolve_control', 'resolve_control'],
  // skill.write
  ['save a reusable skill procedure', 'skill.write'], ['create a skill', 'skill.write'], ['update an existing skill', 'skill.write'],
  ['make a new skill', 'skill.write'], ['add a skill', 'skill.write'], ['skills', 'skill.write'], ['save this as a recipe', 'skill.write'],
  ['turn this into a skill', 'skill.write'], ['edit a skill', 'skill.write'], ['write a recipe for later', 'skill.write'],
  ['remember this procedure as a skill', 'skill.write'], ['store these steps as a reusable procedure', 'skill.write'], ['skill_write', 'skill.write']
];
/* LIMITS: asks that say no word of the tool's (no family word, no plain word) and lose to another tool's exact name. Pinned
   as NOT found on the lead's shelf, so a change that starts finding one says so here (move the row up to NATURAL). */
const LIMITS = [
  ['edit decision list', 'resolve_timeline_file', 'the description\'s own phrase; "edit" is fs.edit and "list" is four listed tools'],
  ['start a render', 'resolve_control', '"render" is only in its description, and terminal.start is a whole name'],
  ['put a live number on the dashboard', 'widget.set', 'a dashboard is an app here (app.create); the ask never says widget or tile'],
  ['update the readout', 'widget.set', '"readout" is only in its description, and brief.update / quest.update are whole names']
];
// U. asks for something else. None says a word of the tail's.
const UNRELATED = [
  // browser
  'take a screenshot', 'upload a file', 'read network responses', 'open a new tab', 'go back to the previous page', 'type text into an input field',
  'select an option from a dropdown', 'scroll down the page', 'hover over the menu', 'save the page as pdf', 'switch to another tab', 'close the tab',
  'run javascript on the page', 'read the browser console', 'emulate a mobile device', 'resize the viewport', 'drag and drop', 'accept the dialog',
  'intercept a network request', 'log in to a website', 'inspect an element', 'attach to my chrome', 'reset the browser', 'go forward',
  'test the page in a browser', 'browser',
  // files
  'read a file', 'write a file', 'edit a file', 'search files for a string', 'list the files in a folder', 'append to a file', 'apply a patch',
  // shell and terminal
  'run a shell command', 'run a command in the background', 'kill the background process', 'read the output of the dev server', 'open a terminal',
  'type into the terminal', 'stop the terminal session', 'wait for the background job', 'interrupt the running command', 'resize the terminal',
  // station building
  'station builder', 'build an assembly line', 'add an assembly line', 'test the line', 'change a station setting',
  'station builder - create assembly lines and workflows', 'build an assembly line or workflow on the station', 'make a prop', 'see the station map',
  'start the line', 'turn off the station power', 'station status', 'place a desk in the room', 'show the commander a window',
  // apps, loops, routines, tasks
  'create an app dashboard', 'publish the app', 'schedule the app', 'check the app', 'create a routine that runs every morning', 'manage my routines',
  'pause a routine', 'stop the loop', 'create a loop', 'manage tasks on the board', 'update a task card', 'routine notepad',
  // connectors and channels
  'connect to github', 'list my connectors', 'create a github issue', 'send a message to telegram', 'post in discord', 'send an email', 'list channel targets',
  // crew
  'dispatch a worker', 'steer a teammate', 'interrupt the worker', 'resume the worker', 'spawn a subagent', 'delegate this to the team',
  // media, memory, web
  'generate an image', 'analyze an image', 'generate a voice over', 'search the web', 'fetch a url', 'remember this for later', 'read my notes',
  'play music on spotify', 'recall an earlier conversation', 'ask the commander a question'
];
/* LANE_MOVED: the two answers the switch itself moves for an unrelated ask (there before this rule; identical with and
   without the words). The shelf is six tools larger with the tail on it, so a word is weighed a little differently:
     top:  the same seven tools in another order. resolve_control's text says "create_timeline", so "create" is half as
           rare on the shelf and app.create drops below the builder the ask is for.
     lost: app.read was the last hit above the relevance floor for "read"; it is just under it now. */
const LANE_MOVED = {
  top: { 'station builder - create assembly lines and workflows': { shelves: ['lead', 'crew'], off: 'app.create', on: 'station.plan' } },
  lost: { 'read network responses': { shelves: ['crew'], tools: ['app.read'] } }
};
// each word earns its place: the ask misses its tool without the word and is answered with it (the lead's fresh floor)
const NEEDED = [
  ['widget', 'create a dashboard widget', 'widget.set'], ['skill', 'create a skill', 'skill.write'], ['resolve', 'create a Resolve project', 'resolve_status'],
  ['tile', 'update the dashboard tile', 'widget.set'], ['recipe', 'save this as a recipe', 'skill.write'], ['davinci', 'create a DaVinci project', 'resolve_status'],
  ['video', 'edit a video', 'resolve_timeline_file'], ['footage', 'edit footage', 'resolve_timeline_file'], ['film', 'edit a short film', 'resolve_timeline_file'],
  ['movie', 'make a movie from these photos', 'resolve_timeline_file'], ['timeline', 'create a timeline', 'resolve_timeline_file'],
  ['clip', 'make a rough cut of these clips', 'resolve_timeline_file']
];
// the golden's queries: every ask above, and the edges (no match, a withheld command, a wire name, a name that is listed)
const EDGES = ['zzqqxx', 'run a powershell script', 'station_control', 'tool search', 'resolve the merge conflict', 'set', 'file', 'the status of the line'];
const QUERIES = UNRELATED.concat(NATURAL.slice(0, 50).map(r => r[0]), EDGES);

/* ---------------------------------------------------------------- the shelves */
// the answer as a model reads it: what is revealed (in rank order), what is named as already listed, and the whole text
const read = r => {
  const content = String(r.content);
  const listed = ((content.split('Now available')[0].match(/^· (\S+)/gm)) || []).map(l => l.slice(2));
  return { shown: (r.control && r.control.revealTools) || [], listed, whole: JSON.stringify([r.content, r.summary, r.control || null]) };
};
const says = (ctx, q) => { const map = ctx.answersTo || {}; const said = String(q).toLowerCase().split(/[^a-z0-9]+/); return Object.keys(map).some(n => map[n].some(w => said.indexOf(w) >= 0 || said.indexOf(w + 's') >= 0)); };

// the catalogue's own deferred split over the real descriptions, built as test/toolsearch.phrases-real.test.js builds it
function catalogueShelf() {
  const reg = new Map(), add = t => { if (t && t.name) reg.set(t.name, t); }, into = { register: add };
  makeBrowserTools({ session: {} }).tools.forEach(add);
  makeStationTools({ station: { request: async () => ({ ok: false, error: 'no page' }) }, now: () => 1, planMemo: new Map(),
    lineMenu: () => [{ id: 'revision_loop', roles: ['Writer', 'Reviewer'] }], styleMenu: () => [], roomMenu: () => [], kitMenu: () => [], presetMenu: () => [] }).register(into);
  makeStationControlTools({}).register(into);
  { const s = makeStationShowTool({}); add(s.tool || s); }
  (makeAppTools({ apps: {} }).defs || []).forEach(add);
  makeLoopTools({}).register(into);
  makeRoutineTools({}).register(into);
  const deferred = new Set(), granted = new Set();
  for (const rows of Object.values(CAP_REGISTRY)) for (const g of rows) { granted.add(g.tool); if (g.deferred) deferred.add(g.tool); }
  const pool = [...reg.keys()].filter(n => deferred.has(n)).sort();
  const advertised = ['tool.search'].concat([...reg.keys()].filter(n => granted.has(n) && !deferred.has(n)).sort());
  return { search: makeToolSearchTool({ registry: { get: n => reg.get(n) || null } }).toolSearchTool, ctx: { deferred: pool, advertised }, words: null };
}

/* a run's shelf, from the projection runOnce uses, and the ctx tool_search is handed: capGate's makeCapCtx over the
   projection's `resolved`, then the two lines runOnce adds (ctx.advertised, and ctx.answersTo when words are handed). */
async function runShelf(id, facts) {
  const sc = C.scenarios().find(s => s.id === id);
  const registry = C.catalogRegistry(ROOT);
  let p = null;
  await C.projectMatrix(ROOT, withFacts(sc, facts), { registry, mutate: got => { p = got; return got; } });
  const ctx = makeCapCtx(p.resolved, {});
  ctx.advertised = p.advertised.slice();
  if (p.tailWords) ctx.answersTo = p.tailWords;
  return { search: makeToolSearchTool({ registry }).toolSearchTool, ctx, words: p.tailWords || null, held: (p.specialistTail || []).slice() };
}
const ON = { PREFIX_TAIL: true };
const RUNS = { lead: ['desktop.floor@ask', { followups: NONE }], 'lead.live': ['desktop.floor@ask', {}], crew: ['facts.crew@ask', { followups: NONE }], worker: ['worker@ask', { followups: NONE }] };
const without = (ctx, key) => { const c = Object.assign({}, ctx); delete c[key]; return c; };
const ask = async (shelf, q, ctx) => read(await shelf.search.run({ query: q }, ctx || shelf.ctx));

(async () => {
  const off = { catalogue: catalogueShelf() }, on = {};
  for (const name of Object.keys(RUNS)) {
    off[name] = await runShelf(RUNS[name][0], RUNS[name][1]);
    on[name] = await runShelf(RUNS[name][0], Object.assign({ prefix: ON }, RUNS[name][1]));
  }
  // the tail held, no words handed in: the switch on as the lane built it, before this rule
  const held = Object.assign({}, on.lead, { ctx: without(on.lead.ctx, 'answersTo') });
  const goldenShelves = Object.assign({}, off, { 'lead.held': held });

  /* ---------- G. OFF is today's search ---------- */
  const record = async shelf => {
    const rows = [], whole = [];
    for (const q of QUERIES) { const r = await ask(shelf, q); rows.push(r.shown.join(' ') + ' | ' + r.listed.join(' ') + ' | ' + sha(r.whole).slice(0, 12)); whole.push(r.whole); }
    return { hidden: shelf.ctx.deferred.length, listed: shelf.ctx.advertised.length, sha256: sha(whole.join('\n')), results: rows };
  };
  const now = {};
  for (const name of Object.keys(goldenShelves)) now[name] = await record(goldenShelves[name]);
  if (process.argv.includes('--update')) {
    let golden = {};
    try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); } catch (_) { golden = {}; }
    golden.about = 'tool_search answers with STARNET_PREFIX_TAIL off (test/toolsearch.specialist-tail.test.js): per shelf and per query (in `queries` order), one line: the revealed names in rank order | the names listed as already in the tool list | 12 hex of the sha256 of the whole answer (content, summary, control); sha256 is over every whole answer of the shelf. Recorded on the base scorer; per platform, because some tool descriptions name the host. Re-record (--update) only on the base scorer, or when a result changes on purpose with the switch off, and say so in that commit.';
    golden.queries = QUERIES;
    golden.platforms = golden.platforms || {};
    golden.platforms[process.platform] = { recordedAt: BASE, scorer: sha(fs.readFileSync(path.join(ROOT, 'sidecar', 'tools', 'builtin', 'toolsearch.js'), 'utf8').replace(/\r\n/g, '\n')), shelves: now };
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + '\n', 'utf8');
    console.log('recorded ' + Object.keys(now).length + ' shelves x ' + QUERIES.length + ' queries for ' + process.platform + ' -> ' + GOLDEN);
    return;
  }
  A.ok(QUERIES.length >= 60 && new Set(QUERIES).size === QUERIES.length, 'the golden covers ' + QUERIES.length + ' distinct queries (at least 60)');
  let golden = null;
  try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); } catch (e) { golden = null; }
  A.ok(golden && golden.platforms, 'the golden fixture is there (test/fixtures/toolsearch-off-golden.json)');
  const want = golden && golden.platforms && golden.platforms[process.platform];
  if (!want) {
    console.log('toolsearch.specialist-tail: no golden recorded for ' + process.platform + ' (some tool descriptions name the host); the base comparison is skipped here');
  } else {
    A.eq(golden.queries, QUERIES, 'the golden was recorded for these queries, in this order');
    A.eq(want.recordedAt, BASE, 'the golden was recorded on the base (' + BASE + ')');
    A.eq(Object.keys(want.shelves).sort(), Object.keys(now).sort(), 'the golden holds every shelf');
    for (const name of Object.keys(now)) {
      const w = want.shelves[name] || { results: [] };
      A.eq([now[name].hidden, now[name].listed], [w.hidden, w.listed], 'off ' + name + ': the shelf is the base\'s (' + w.hidden + ' hidden, ' + w.listed + ' listed)');
      let same = 0;
      QUERIES.forEach((q, i) => {
        if (now[name].results[i] === w.results[i]) { same++; return; }
        A.eq(now[name].results[i], w.results[i], 'off ' + name + ' "' + q + '": the answer is the base\'s');
      });
      A.eq(same, QUERIES.length, 'off ' + name + ': all ' + QUERIES.length + ' answers are the base\'s (revealed names in rank order, listed names, text)');
      A.eq(now[name].sha256, w.sha256, 'off ' + name + ': every answer is BYTE-IDENTICAL to the base scorer\'s');
    }
  }
  A.ok(off.lead.held.length === 0 && TAIL.every(n => off.lead.ctx.advertised.indexOf(n) >= 0 && off.lead.ctx.deferred.indexOf(n) < 0), 'off: the tail rides the lead\'s tool list and is not on the shelf');
  A.eq(on.lead.held.slice().sort(), TAIL.slice().sort(), 'on: the lead\'s shelf holds all six');
  A.ok(TAIL.every(n => held.ctx.deferred.indexOf(n) >= 0) && !('answersTo' in held.ctx), 'the sixth golden shelf holds the tail and hands the search no words');
  // with the switch off the search is handed nothing, on every scenario; with it on, words for exactly what is held
  {
    let offRuns = 0, onRuns = 0, heldRuns = 0;
    for (const sc of C.scenarios()) {
      let a = null, b = null;
      await C.projectMatrix(ROOT, sc, { mutate: p => { a = p; return p; } });
      await C.projectMatrix(ROOT, withFacts(sc, { prefix: ON }), { mutate: p => { b = p; return p; } });
      A.ok(a.tailWords === null && !('answersTo' in makeCapCtx(a.resolved, {})), sc.id + ': the switch off hands tool_search no words');
      offRuns++;
      A.eq(b.tailWords ? Object.keys(b.tailWords) : [], b.specialistTail, sc.id + ': the switch on hands words for exactly the tail tools this run holds (' + (b.specialistTail.join(', ') || 'none') + ')');
      if (b.tailWords) { heldRuns++; A.ok(Object.keys(b.tailWords).every(n => (b.resolved.deferred || []).indexOf(n) >= 0), sc.id + ': every tool with words is on the shelf tool_search searches'); }
      else A.ok(b.tailWords === null, sc.id + ': nothing held, no words (null, not an empty map)');
      onRuns++;
    }
    A.ok(offRuns === C.scenarios().length && onRuns === offRuns && heldRuns >= 20, 'checked across the census (' + offRuns + ' scenarios; ' + heldRuns + ' hold tail tools with the switch on)');
  }

  /* ---------- W. the words ---------- */
  {
    const families = Array.from(new Set(TAIL.map(F.familyOf)));
    A.eq(families.slice().sort(), ['resolve', 'skill', 'widget'], 'a tail tool\'s family is the first word of its name');
    A.ok(Object.isFrozen(F.TAIL_WORDS) && Object.keys(F.TAIL_WORDS).every(k => Object.isFrozen(F.TAIL_WORDS[k])), 'the table is frozen');
    A.ok(Object.keys(F.TAIL_WORDS).every(k => families.indexOf(k) >= 0), 'every row of TAIL_WORDS is the family of a tail tool');
    const all = [];
    for (const k of Object.keys(F.TAIL_WORDS)) for (const w of F.TAIL_WORDS[k]) all.push(w);
    A.ok(all.every(w => /^[a-z]{4,}$/.test(w)) && new Set(all).size === all.length && all.every(w => families.indexOf(w) < 0), 'each plain word is one lowercase word, listed once, and not a family word');
    A.eq(F.tailWords(TAIL), { resolve_timeline_file: ['resolve'].concat(F.TAIL_WORDS.resolve), resolve_status: ['resolve'].concat(F.TAIL_WORDS.resolve), resolve_control: ['resolve'].concat(F.TAIL_WORDS.resolve),
      'widget.get': ['widget'].concat(F.TAIL_WORDS.widget), 'widget.set': ['widget'].concat(F.TAIL_WORDS.widget), 'skill.write': ['skill'].concat(F.TAIL_WORDS.skill) }, 'a held tool answers to its family word and its family\'s plain words');
    A.eq(F.tailWords(['widget.set']), { 'widget.set': ['widget'].concat(F.TAIL_WORDS.widget) }, 'words only for what is held');
    for (const none of [[], undefined, null, 'widget.set']) A.eq(F.tailWords(none), null, 'nothing held (' + JSON.stringify(none) + '): null');
    A.eq(F.tailWords(['fs.read', 'browser.tabs']), null, 'a name that is not a tail tool gets no words (the search never forces another tool)');
    A.eq(on.lead.words, F.tailWords(on.lead.held), 'the projection hands the lead exactly those words');
    // each word is needed
    A.eq(NEEDED.map(r => r[0]).sort(), families.concat(all).sort(), 'every family word and every plain word has an ask that needs it');
    for (const [word, q, tool] of NEEDED) {
      const lacking = {};
      for (const n of Object.keys(on.lead.words)) lacking[n] = on.lead.words[n].filter(w => w !== word);
      const a = await ask(on.lead, q, Object.assign({}, on.lead.ctx, { answersTo: lacking })), b = await ask(on.lead, q);
      A.ok(a.shown.indexOf(tool) < 0 && b.shown.indexOf(tool) >= 0, '"' + word + '" is needed: "' + q + '" misses ' + tool + ' without it (' + JSON.stringify(a.shown) + ') and finds it with it (' + JSON.stringify(b.shown) + ')');
    }
  }

  /* ---------- N. ON: natural asks ---------- */
  {
    A.ok(NATURAL.length >= 40 && new Set(NATURAL.map(r => r[0])).size === NATURAL.length, NATURAL.length + ' natural asks (at least 40), each once');
    for (const n of TAIL) A.ok(NATURAL.filter(r => r[1] === n).length >= 5, n + ' has several phrasings (' + NATURAL.filter(r => r[1] === n).length + ')');
    let asked = 0, wordless = 0, before = 0;
    for (const name of Object.keys(on)) {
      const shelf = on[name];
      for (const [q, tool] of NATURAL) {
        if (shelf.ctx.deferred.indexOf(tool) < 0) continue;
        const r = await ask(shelf, q);
        asked++;
        A.ok(r.shown.indexOf(tool) >= 0, 'on ' + name + ': "' + q + '" returns ' + tool + ' (got ' + JSON.stringify(r.shown) + ')');
        if (name === 'lead') {
          if (!says(shelf.ctx, q)) wordless++;
          if ((await ask(held, q)).shown.indexOf(tool) < 0) before++;
        }
      }
    }
    A.ok(asked >= NATURAL.length * 3, 'asked on every shelf that holds the tool (' + asked + ' searches)');
    A.ok(before >= 25, 'on the lead\'s shelf ' + before + ' of the ' + NATURAL.length + ' asks missed their tool before this rule');
    console.log('toolsearch.specialist-tail: ' + NATURAL.length + ' natural asks; on the lead\'s shelf ' + before + ' missed before the rule, ' + wordless + ' say no word of the tool\'s and are found by the score alone');
    for (const [q, tool, why] of LIMITS) {
      const r = await ask(on.lead, q);
      A.ok(!says(on.lead.ctx, q) && r.shown.indexOf(tool) < 0, 'LIMIT "' + q + '" says no word of ' + tool + '\'s and is not answered with it (' + why + '): ' + JSON.stringify(r.shown));
    }
  }

  /* ---------- U. ON: unrelated asks ---------- */
  {
    A.ok(UNRELATED.length >= 40 && new Set(UNRELATED).size === UNRELATED.length, UNRELATED.length + ' unrelated asks (at least 40), each once');
    let identical = 0, sameTop = 0, tailExtra = 0, wasListed = 0;
    for (const name of Object.keys(on)) {
      const shelf = on[name], lane = Object.assign({}, shelf, { ctx: without(shelf.ctx, 'answersTo') });
      for (const q of UNRELATED) {
        A.ok(!says(shelf.ctx, q), '"' + q + '" says no word of the tail\'s');
        const withWords = await ask(shelf, q), asBuilt = await ask(lane, q);
        A.ok(withWords.whole === asBuilt.whole, 'on ' + name + ': "' + q + '" is answered byte for byte as before this rule');
        identical++;
        if (name === 'worker') continue;
        // against the switch off (the lead's shelves)
        const was = await ask(off[name], q);
        const moved = LANE_MOVED.top[q] && LANE_MOVED.top[q].shelves.indexOf(name) >= 0 ? LANE_MOVED.top[q] : null;
        if (moved) A.eq([was.shown[0], withWords.shown[0], withWords.shown.slice().sort()], [moved.off, moved.on, was.shown.slice().sort()], 'on ' + name + ': "' + q + '" is the pinned exception (the lane\'s: the same tools in another order)');
        else { A.eq(withWords.shown[0] || null, was.shown[0] || null, 'on ' + name + ': "' + q + '" has the first result the switch-off search gives'); sameTop++; }
        const extra = withWords.shown.filter(n => was.shown.indexOf(n) < 0), lost = was.shown.filter(n => withWords.shown.indexOf(n) < 0);
        A.ok(extra.every(n => TAIL.indexOf(n) >= 0), 'on ' + name + ': "' + q + '" reveals nothing new but a tail tool (' + (extra.join(', ') || 'none') + ')');
        extra.forEach(n => { tailExtra++; if (was.listed.indexOf(n) >= 0) wasListed++; });
        const gone = LANE_MOVED.lost[q] && LANE_MOVED.lost[q].shelves.indexOf(name) >= 0 ? LANE_MOVED.lost[q].tools : [];
        A.eq(lost, gone, 'on ' + name + ': "' + q + '" reveals every tool the off search revealed' + (gone.length ? ' but the pinned one (the lane\'s)' : ''));
      }
    }
    A.ok(identical === UNRELATED.length * 4 && sameTop === UNRELATED.length * 3 - 2, identical + ' answers identical with and without the words; ' + sameTop + ' first results equal to the switch-off search');
    console.log('toolsearch.specialist-tail: ' + UNRELATED.length + ' unrelated asks x 3 lead shelves: ' + sameTop + ' first results equal to the switch-off search; a tail tool rides along ' + tailExtra + ' times (' + wasListed + ' of them named by the off search as already listed)');
    // a family word used for something else: the Resolve tools answer to "resolve" as they did before this rule
    const a = await ask(on.lead, 'resolve the merge conflict'), b = await ask(held, 'resolve the merge conflict');
    A.ok(a.whole === b.whole && RESOLVE.every(n => a.shown.indexOf(n) >= 0), '"resolve the merge conflict" already returned the Resolve tools (their names hold the word); the rule adds nothing to it');
  }

  /* ---------- F. the floor, the listed tools, the cap ---------- */
  {
    // the real shelf: found by the score, cut by another hit's score, returned by the rule
    for (const [q, tool, by] of [['create a dashboard widget', 'widget.set', 'app.create'], ['publish a reading to a dashboard widget', 'widget.set', 'app.publish']]) {
      const before = await ask(held, q), after = await ask(on.lead, q);
      A.ok(before.shown.indexOf(tool) < 0 && before.shown.indexOf(by) >= 0, 'before: "' + q + '" returned ' + by + ' and cut ' + tool + ' at the relevance floor (' + JSON.stringify(before.shown) + ')');
      A.eq(after.shown.slice(0, before.shown.length), before.shown, 'after: the scored hits keep their order (' + by + ' first)');
      A.eq(after.shown.slice(before.shown.length), ['widget.get', 'widget.set'], 'after: the widget tools follow the scored hits');
      A.eq(after.listed, before.listed, 'after: the listed tools are named as before');
    }
    {
      const before = await ask(held, 'update my widget'), after = await ask(on.lead, 'update my widget');
      A.ok(before.shown.length === 0 && before.listed.indexOf('quest.update') >= 0, 'before: "update my widget" revealed nothing (the listed quest.update and brief.update outscored the widget tools three to one)');
      A.eq([after.shown, after.listed], [['widget.get', 'widget.set'], before.listed], 'after: the widget tools are revealed, and the listed tools are still named');
    }
    // fakes, for the cap and the edges
    const tools = new Map();
    const fake = (name, description) => tools.set(name, { name, description, schema: { type: 'object', properties: {} } });
    for (let i = 1; i <= 9; i++) fake('lab' + i + '.zap', 'Zap sample ' + i + '.');
    fake('widget.set', 'Publish a readout.'); fake('widget.get', 'Read a definition.'); fake('resolve_status', 'Check the editor.'); fake('fs.edit', 'Edit a file.'); fake('quest.update', 'Update a quest.');
    const search = makeToolSearchTool({ registry: { get: n => tools.get(n) || null } }).toolSearchTool;
    const pool = Array.from(tools.keys()).filter(n => n !== 'fs.edit' && n !== 'quest.update' && n !== 'widget.get');
    const words = { 'widget.set': ['widget', 'tile'], 'widget.get': ['widget', 'tile'], resolve_status: ['resolve', 'video'] };
    const run = async (q, ctx) => read(await search.run({ query: q }, Object.assign({ deferred: pool, advertised: ['fs.edit', 'quest.update'] }, ctx)));
    const zaps = (await run('zap', {})).shown;
    A.eq(zaps, [1, 2, 3, 4, 5, 6, 7, 8].map(i => 'lab' + i + '.zap'), 'fixture: nine tools are named "zap" and the hit cap returns eight');
    A.eq((await run('zap widget', { deferred: pool.filter(n => n !== 'lab8.zap' && n !== 'lab9.zap') })).shown, zaps.slice(0, 7).concat(['widget.set']), 'fixture: the widget tool clears the relevance floor (with seven above it, it is the eighth hit)');
    A.eq((await run('zap widget', {})).shown, zaps, 'no words: "zap widget" finds the widget tool and the hit cap cuts it (nine score above it)');
    A.eq((await run('zap widget', { answersTo: words })).shown, zaps.concat(['widget.set']), 'THE CAP: the named tool follows the eight');
    A.eq((await run('edit a video', {})).shown, [], 'no words: "edit a video" reveals nothing (fs.edit is listed)');
    const video = await run('edit a video', { answersTo: words });
    A.eq([video.shown, video.listed], [['resolve_status'], ['fs.edit']], 'THE LISTED TOOLS: the named tool is revealed beside the listed one');
    A.eq((await run('update the tiles', { answersTo: words })).shown, ['widget.set'], 'a plural says the word ("tiles")');
    A.eq((await run('WIDGET', { answersTo: words })).shown, ['widget.set'], 'case does not matter');
    A.eq((await run('widget_set', { answersTo: words })).shown, ['widget.set'], 'the wire name says the family word (and is found once, not twice)');
    A.eq((await run('zap widget video', { answersTo: words })).shown, zaps.concat(['widget.set', 'resolve_status']), 'two families named: both follow, in shelf order');
    for (const q of ['the issue is resolved', 'widgetry', 'videography', 'reptile']) A.eq((await run(q, { answersTo: words })).shown, [], '"' + q + '" says no whole word of a held tool\'s');
    A.ok((await run('widget', { answersTo: words })).shown.indexOf('widget.get') < 0, 'a tool that is not on this run\'s shelf is never returned, whatever the words say');
    A.eq((await run('zap widget', { answersTo: { 'lab9.zap': ['nothing'], 'widget.set': 'widget' } })).shown, zaps, 'a row that is not a list of words is ignored');
    for (const junk of [null, undefined, '', 'widget', 7, [], ['widget']]) A.eq((await run('zap widget', { answersTo: junk })).shown, zaps, 'a malformed fact (' + JSON.stringify(junk) + ') is ignored');
    const empty = await search.run({ query: 'widget' }, { deferred: [], advertised: ['fs.edit'], answersTo: words });
    A.ok(!empty.control, 'an empty shelf reveals nothing');
    const blank = await search.run({ query: '  ' }, { deferred: pool, answersTo: words });
    A.ok(!blank.control && /Provide a `query`/.test(String(blank.content)), 'a blank query is still asked for one');
  }

  /* ---------- H. the host ---------- */
  {
    const index = readSidecarIndex();   // index.js itself: the line that hands tool_search the fact lives there
    A.eq(index.split('capCtx.answersTo').length - 1, 1, 'runOnce sets ctx.answersTo in one place');
    A.ok(/\n  capCtx\.advertised = isTask \? coreNames : \[\];\n(?:  \/\/[^\n]*\n)+  if \(projection\.tailWords\) capCtx\.answersTo = projection\.tailWords;\n/.test(index),
      'runOnce hands tool_search the projection\'s words beside ctx.advertised, and only when there are any');
    const ts = fs.readFileSync(path.join(ROOT, 'sidecar', 'tools', 'builtin', 'toolsearch.js'), 'utf8');
    A.ok(!/process\.env|\bENV\(/.test(ts) && ts.indexOf('STARNET_PREFIX_TAIL') >= 0, 'tool_search reads no environment (the switch reaches it as ctx.answersTo)');
    A.ok(!/resolve_|widget\.|skill\.write/.test(ts.slice(ts.indexOf('ANSWERS TO'), ts.indexOf('function makeToolSearchTool'))), 'the rule names no tool (the words come from the host)');
  }

  A.report('toolsearch.specialist-tail');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
