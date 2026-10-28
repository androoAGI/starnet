/* node test/agent-threads-rail.test.js — PER-AGENT THREADS: a CREW row narrows the SESSIONS rail to that agent.

   Andrew, 2026-10-01: clicking an agent shows all of that agent's sessions; clicking SESSIONS goes back to
   the full list. A group chat belongs to every member, so it lists under each of them — but the session
   record stores only the lead, so membership comes from the backend (GroupChat.membersOf).

   1. GENUINE: Workstreams.hasAgent — the one rule for "is this session one of X's?".
   2. SOURCE-LOCKED wiring (the rail and roster need a live layout to drive): the crew row filters, a
      one-agent station keeps crew-click = dossier, the dossier stays one step away (key + right-click),
      the SESSIONS tab clears the filter, + NEW binds to the narrowed agent, search stays inside it.

   OUT OF HEADLESS SCOPE: the on-screen result (chip, the single lit row, empty state) was proven live on a
   3-agent + 1-group station and a 1-agent station (lane notes: agent-threads-lane-1001). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const W = require('../frontend/app/workstreams.js');

/* ---- 1. GENUINE: hasAgent ---- */
const groups = { g1: ['echo', 'finn'] };
const membersOf = id => groups[id] || null;
const direct = { id: 's1', agentId: 'finn', conversationMode: 'direct' };
const hero = { id: 's2', conversationMode: 'direct' };            // no agentId = the hero ('agent')
const group = { id: 'g1', agentId: 'echo', conversationMode: 'group' };
const unknownGroup = { id: 'g2', agentId: 'echo', conversationMode: 'group' };

A.ok(W.hasAgent(direct, 'finn', membersOf), "a direct session is its bound agent's");
A.ok(!W.hasAgent(direct, 'echo', membersOf), "a direct session is no one else's");
A.ok(W.hasAgent(hero, 'agent', membersOf), "an unbound session is the hero's");
A.ok(W.hasAgent(group, 'echo', membersOf), "a group is its lead's");
A.ok(W.hasAgent(group, 'finn', membersOf), 'a group lists under a non-lead member too');
A.ok(!W.hasAgent(group, 'agent', membersOf), 'a group never lists under a non-member');
A.ok(W.hasAgent(unknownGroup, 'echo', membersOf) && !W.hasAgent(unknownGroup, 'finn', membersOf),
  'before membership is known a group lists under its lead only (never guesses members)');
A.ok(!W.hasAgent({ id: 's3', agentId: 'finn', conversationMode: 'direct' }, 'echo', () => ['echo']),
  'membership is read for GROUP sessions only — a direct session cannot be widened by it');
A.ok(W.hasAgent(group, 'echo', null) && !W.hasAgent(group, 'finn', null), 'no membership source = lead only');
// Andrew 10-01: "if finn and nova are in a chat, if i click nova, it should show that session" — the overseer
// (id 'agent') is a member like any other, even when another agent leads the group.
const novaFinn = { id: 'g3', agentId: 'finn', conversationMode: 'group' };
const withNova = id => (id === 'g3' ? ['agent', 'finn'] : null);
A.ok(W.hasAgent(novaFinn, 'agent', withNova) && W.hasAgent(novaFinn, 'finn', withNova),
  'a NOVA + FINN group led by FINN lists under NOVA (the overseer) and under FINN');
A.ok(!W.hasAgent(null, 'finn', membersOf) && !W.hasAgent(direct, '', membersOf), 'empty input is no match');

/* ---- 2. SOURCE-LOCKED wiring ---- */
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('frontend/app/app.js'), ui = read('frontend/app/stationui.js'), gc = read('frontend/app/group-chat.js');

A.ok(/next = g\.members\.slice\(\);\s*membersById\.set\(g\.id, next\);/.test(gc) && /membersOf: id => membersById\.get\(id\) \|\| null/.test(gc),
  'GroupChat records each group\'s members from the backend and exposes membersOf');
A.ok(/before && before\.join\('\\n'\) !== next\.join\('\\n'\) && typeof App !== 'undefined' && App\.refreshRail\) queueMicrotask\(\(\) => App\.refreshRail\(\)\)/.test(gc),
  'a member joining or leaving repaints the rail, so the group appears under them without a reload');
A.ok(/group = result; adopt\(result\); paint\(\);/.test(gc), 'an @mention invite records the new member at once');
A.ok(/Workstreams\.hasAgent\(w, id, typeof GroupChat !== 'undefined' \? GroupChat\.membersOf : null\)/.test(app),
  'the rail filter reads the shared hasAgent rule with the backend membership');
A.ok(/\(!railAgentFilter \|\| railHasAgent\(w, railAgentFilter\)\)/.test(app), 'renderRail narrows its rows to the chosen agent');
A.ok(/if \(id && id === railAgentFilter\) id = null;/.test(app), 'the same crew row again returns to every session');
A.ok(/railAgentFilter && !\(opts && opts\.keepAgentFilter\)/.test(app), 'the SESSIONS tab (setRailView) clears the filter');
A.ok(/chip\.onclick = \(\) => \{ SFX\.click\(\); setRailAgentFilter\(null\); \}/.test(app), 'the chip returns to every session');
A.ok(/ws\.id === Workstreams\.generalId\(\) \|\| !Workstreams\.setAgent\(ws\.id, f\)\)\) \{\s*ws = Workstreams\.create\(null, \{ agentId: f \}\);/.test(app),
  '+ NEW while narrowed binds the new session to that agent, never rebinding General');
A.ok(/Workstreams\.search\(q\)\.filter\(hit => \{ if \(!railAgentFilter\) return true;/.test(app), 'search stays inside the narrowed agent');
A.ok(/filterRailByAgent: setRailAgentFilter/.test(app), 'App exposes the filter to the roster');
A.ok(/if \(w\.archived && \(!railAgentFilter \|\| railHasAgent\(w, railAgentFilter\)\)\) n\+\+;/.test(app),
  'narrowed, the "N archived" row counts only that agent\'s archived sessions (it never promises rows it won\'t show)');
A.ok(/const ws = Workstreams\.switch\(id\); if \(!ws\) return;\s*\/\/[^\n]*\n[^\n]*\n\s*if \(railAgentFilter && !railHasAgent\(ws, railAgentFilter\)\) \{ railAgentFilter = null;/.test(app),
  'opening a session from elsewhere that the narrowed rail does not list returns to every session');
A.ok(/if \(railAgentFilter && railAgentFilter !== id\) \{ railAgentFilter = null;/.test(app),
  'the COMMS picker rebinding the open blank line to another agent keeps that line on the rail');
A.ok(!/localStorage\.setItem\([^)]*railAgentFilter/.test(app), 'the narrowed view is view state only — never persisted');

A.ok(/if \(present\.length > 1 && typeof App !== 'undefined' && App\.filterRailByAgent\) App\.filterRailByAgent\(li\.dataset\.agentId\);\s*else openAgent\(\+li\.dataset\.i\);/.test(ui),
  'a crew row narrows the rail; a one-agent station keeps crew-click = dossier');
A.ok(/li\.addEventListener\('contextmenu', ev => \{ ev\.preventDefault\(\); sfx\('click'\); openAgent\(\+li\.dataset\.i\); \}\);/.test(ui),
  'right-click (and Shift+F10) on a crew row opens the dossier');
A.ok(!/class="crew-dossier"/.test(ui), 'no DOSSIER key on a crew card (Andrew 10-26: "unaligned, looks terrible") — right-click / Shift+F10 open the dossier');
A.ok(/row\.classList\.toggle\('filtering', !!railFilter && a\.id === railFilter\)/.test(ui), 'the narrowed agent\'s row is marked');

// sweep 2026-10-01
A.ok(/ev\.key === 'ContextMenu' \|\| \(ev\.shiftKey && ev\.key === 'F10'\)\) \{ ev\.preventDefault\(\); sfx\('click'\); openAgent\(\+li\.dataset\.i\); \}/.test(ui),
  'Shift+F10 / the menu key open the dossier from the keydown too (WKWebView fires no contextmenu for it)');
// the "Waiting for you" filter became NEEDS YOU (2026-10-11): a station-wide list that never narrows the rail at all
A.ok(!/railAttentionOnly/.test(app) && /NeedsYou\.render\(\)/.test(app),
  'what waits on you is a station-wide list (NEEDS YOU) — it never narrows the rail, so it can never open a blank one');
const desk = read('frontend/app/deskscreen.js');
A.ok(/deskAgentId = String\(agentId\);/.test(ui) && !/function openDesk\(agentId\) \{[^}]*\bsel = i;/.test(ui) && /get deskAgentId\(\) \{ return deskAgentId; \}/.test(ui),
  'opening a desk sets the desk\'s own target, never the dossier\'s selection');
A.ok(/H\.deskAgentId && H\.present\.find\(x => x && x\.id === H\.deskAgentId\)/.test(desk), 'the desk window builds from its own target');

A.report('agent-threads-rail.test');
