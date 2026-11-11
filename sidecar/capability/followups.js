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
   again. Pure: no I/O, no clock. */
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

module.exports = { FAMILIES, ALL_CONTROLS, revealFor, dormantFollowups };
