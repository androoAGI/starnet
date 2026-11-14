/* sidecar/capability/followups.js — DORMANT FOLLOW-UP CONTROLS (cost audit lane W1.3, 2026-11-08).

   A follow-up control steers something that has to exist first: a terminal session, a background process, a routine,
   a loop, a task-board card. Until it exists the control has nothing to act on, yet its schema rode every task request:
   13 schemas, about 7.3 KB of the ~95 KB fixed prefix of a fresh COMMS task call. Such a control stays GRANTED,
   dispatchable, NAMED in the [HARNESS] list of granted tools that are not loaded yet, and found by tool_search, but it
   leaves the wire until the thing it controls exists:
     - within a run, its starter's result reveals it (control.revealTools: terminal.start, a background shell.exec,
       routine/loop/task create; a list that shows a live handle or record reveals its controls too), and
     - at run start, the host has PROVEN that a live handle or a record exists (facts.followups, collected by the caller).
   A reveal appends to the tools array, and on an Anthropic route that rewrites the cached prefix once, so a family comes
   back only when a handle or record really exists, never speculatively.

   CERTAIN-ONLY, like unavailableTools: a family is dormant only on a proven negative (`false`). A fact the caller did not
   collect (undefined: the authority-census matrix, an SSH backend whose background jobs live on the far machine, an
   unreadable save) keeps the family on the wire. Never a headline capability: every starter stays advertised, and
   shell.bg.status stays beside shell.exec (the dev-server verification rule names it); it joins its family only when
   shell.exec itself is off the wire. Applies only to a task run with tool search on, where a deferred name can be found
   again. Pure: no I/O, no clock.

   The SPECIALIST TAIL at the end of this file (cost audit W3.9a) is held the same way, behind a switch that is off by
   default. */
'use strict';

/* id = the key of facts.followups. starter = the tool that brings the thing into being (its result reveals the
   controls). lister = a control that also lists what exists: it stays beside its starter on the wire. */
const FAMILIES = Object.freeze([
  Object.freeze({ id: 'terminal', starter: 'terminal.start',
    controls: Object.freeze(['terminal.status', 'terminal.read', 'terminal.write', 'terminal.resize', 'terminal.interrupt', 'terminal.stop']) }),
  Object.freeze({ id: 'shellBg', starter: 'shell.exec', lister: 'shell.bg.status',
    controls: Object.freeze(['shell.bg.read', 'shell.bg.write', 'shell.bg.kill', 'shell.bg.wait']) }),
  Object.freeze({ id: 'routines', starter: 'routine.create', controls: Object.freeze(['routine.manage']) }),
  Object.freeze({ id: 'loops', starter: 'loop.create', controls: Object.freeze(['loop.manage']) }),
  Object.freeze({ id: 'tasks', starter: 'task.create', controls: Object.freeze(['task.manage']) })
]);

// every control a family holds, its lister included: what the starter's result reveals (loop.js appends only names this
// run holds deferred, so a reveal of an advertised or ungranted name is a no-op)
function revealFor(id) {
  const fam = FAMILIES.find(f => f.id === id);
  return fam ? fam.controls.concat(fam.lister ? [fam.lister] : []) : [];
}

/* dormantFollowups — the follow-up controls this run holds off the wire, in FAMILIES order.
   isTask: a task run (tools on the wire). deferralOff: SKYNET_TOOL_SEARCH=0. granted: this run's GRANTED names.
   wire: the names that would otherwise be advertised (granted, minus every other deferral). facts: { terminal, shellBg,
   routines, loops, tasks } — true = a live handle or record exists, false = the host proved none, anything else unknown. */
function dormantFollowups({ isTask, deferralOff, granted, wire, facts } = {}) {
  const held = new Set(Array.isArray(granted) ? granted : []);
  if (!isTask || deferralOff || !held.has('tool.search')) return [];
  const known = (facts && typeof facts === 'object') ? facts : {};
  const onWire = new Set(Array.isArray(wire) ? wire : []);
  const out = [];
  for (const fam of FAMILIES) {
    if (known[fam.id] !== false) continue;
    const names = fam.lister && !onWire.has(fam.starter) ? fam.controls.concat([fam.lister]) : fam.controls;
    for (const name of names) if (held.has(name) && onWire.has(name) && out.indexOf(name) < 0) out.push(name);
  }
  return out;
}

// every name this file can hold off the wire (the census invariant: nothing else may move)
const ALL_CONTROLS = Object.freeze(FAMILIES.reduce((all, f) => all.concat(f.controls, f.lister ? [f.lister] : []), []));

/* THE SPECIALIST TAIL (cost audit W3.9a, 2026-11-14; behind STARNET_PREFIX_TAIL, off by default). The same hold for the
   tools of a specialist job no ordinary task starts with: the DaVinci Resolve edit bay (resolve_timeline_file,
   resolve_status, resolve_control), the rail widgets (widget.get, widget.set) and skill.write. Six schemas, 6,721 B on
   every call of a fresh COMMS task, of a crew lead and of a worker (5,932 B without skill.write); none of the first
   five was called in 657 recorded tool runs. Each stays GRANTED, dispatchable, NAMED in the [HARNESS] list of granted
   tools that are not loaded yet, and found by tool_search, exactly like a dormant follow-up control; what differs is why
   it is held: no fact, only the switch. Nothing reveals one but a search (it has no starter).
   Two rows carry a condition, so the hold never takes the wire's only way to do something:
     - widget.get / widget.set stay advertised on a widget's own update run (widgetScope): that run exists to call them.
     - skill.write leaves only while skill.manage is on the wire: skill.manage creates and edits a saved skill too
       (tools/builtin/skills.js), and the saved-skill prompt lines name skill.manage whenever it is granted.
   Not a headline capability: image, voice and vision stay beside the STUDIO, and memory keeps notebook.*, skill.view,
   skill.list and skill.manage. Deferral is model-dependent (the 2026-07-26 probe: two weak models skipped or faked a
   deferred tool), which is why this ships off until an A/B on real models. */
const SPECIALIST_TAIL = Object.freeze([
  Object.freeze({ tool: 'resolve_timeline_file' }),
  Object.freeze({ tool: 'resolve_status' }),
  Object.freeze({ tool: 'resolve_control' }),
  Object.freeze({ tool: 'widget.get', keptFor: 'widgetScope' }),
  Object.freeze({ tool: 'widget.set', keptFor: 'widgetScope' }),
  Object.freeze({ tool: 'skill.write', needsOnWire: 'skill.manage' })
]);
const TAIL_TOOLS = Object.freeze(SPECIALIST_TAIL.map(r => r.tool));

/* specialistTail — the specialist tools this run holds off the wire, in SPECIALIST_TAIL order. `on` is the switch (true
   only); isTask, deferralOff, granted and wire are dormantFollowups' own; widgetScope is the widget this run updates
   ('' on every other run). The same guard as the follow-ups: a task run with tool search on and granted, where a held
   name can be found again. */
function specialistTail({ on, isTask, deferralOff, granted, wire, widgetScope } = {}) {
  const held = new Set(Array.isArray(granted) ? granted : []);
  if (on !== true || !isTask || deferralOff || !held.has('tool.search')) return [];
  const onWire = new Set(Array.isArray(wire) ? wire : []);
  const out = [];
  for (const row of SPECIALIST_TAIL) {
    if (!held.has(row.tool) || !onWire.has(row.tool)) continue;
    if (row.keptFor === 'widgetScope' && String(widgetScope || '')) continue;
    if (row.needsOnWire && !onWire.has(row.needsOnWire)) continue;
    out.push(row.tool);
  }
  return out;
}

/* THE WORDS A HELD TAIL TOOL ANSWERS TO (tool.search, behind the same switch). Nothing reveals a tail tool but a search,
   so a search that asks for one in a person's words has to return it, and the score alone does not: tool.search weighs a
   name's LEAF, a widget tool says "widget" only in its namespace, no Resolve tool says "video" in its name or its
   description, and a verb that is another tool's whole name ("create", "update", "publish", "edit") clears the relevance
   floor by itself. Measured on a COMMS lead's real shelf with the tail held: "create a dashboard widget" returned
   app.create alone, "update my widget" and "edit a video" nothing (test/toolsearch.specialist-tail.test.js).
   So a held tail tool answers to its FAMILY word, the first word of its name (widget, skill, resolve), and to the plain
   words below: what a person calls the thing its family works on, where a name does not say it. tool.search returns a
   held tool whose word the query says, after its scored hits (toolsearch.js ANSWERS TO); it rescores nothing.
   By family, not by tool: the three Resolve tools are one edit bay, and each description sends the model to another.
   Kept short on purpose: any search that says a word here brings its family (three schemas for Resolve), so a word
   with another common meaning stays out ("dashboard" is an app here, "render" is what a page does). Each word has an
   ask in that test that misses without it. */
const TAIL_WORDS = Object.freeze({
  resolve: Object.freeze(['davinci', 'video', 'footage', 'film', 'movie', 'timeline', 'clip']),
  widget: Object.freeze(['tile']),
  skill: Object.freeze(['recipe'])
});
// 'widget.set' -> 'widget', 'resolve_status' -> 'resolve': the first word of a name, dotted or flat
function familyOf(name) { return String(name == null ? '' : name).toLowerCase().split(/[._]/)[0]; }

/* tailWords — what runOnce hands tool.search (ctx.answersTo): for each tail tool this run HOLDS, the words it answers to.
   `held` is specialistTail()'s own list, so with the switch off, or where no tail tool is held, this is null and the
   search is the one it was. A name outside the table gets nothing: the search never forces another tool. */
function tailWords(held) {
  const out = {};
  let any = false;
  for (const name of (Array.isArray(held) ? held : [])) {
    if (TAIL_TOOLS.indexOf(name) < 0) continue;
    const family = familyOf(name);
    out[name] = [family].concat(TAIL_WORDS[family] || []);
    any = true;
  }
  return any ? out : null;
}

module.exports = { FAMILIES, ALL_CONTROLS, revealFor, dormantFollowups, SPECIALIST_TAIL, TAIL_TOOLS, specialistTail, TAIL_WORDS, familyOf, tailWords };
