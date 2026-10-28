/* node test/crew-diet.test.js — ZERO-CREW DIET predicate (sidecar/crew-diet.js): which lead defers which part of the
   crew kit. Review 2026-10-12: only what needs a crew or a running background worker is deferred (team.spawn and the
   lead's own Dossier tools stay advertised), and never where tool.search is not granted (a deferred name nothing can
   reveal is a hidden tool). Wiring is pinned against index.js and the reveal producers. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { CREW_KIT_DEFERRED, isCrewlessLead } = require('../sidecar/crew-diet.js');

A.eq(CREW_KIT_DEFERRED.slice().sort().join(','), ['team.dispatch', 'team.interrupt', 'team.resume', 'team.steer', 'team.subagents'].join(','),
  'deferred = team.dispatch + the background-worker controls, nothing else');
for (const kept of ['team.summon', 'team.spawn', 'team.config', 'team.configure', 'tool.search'])
  A.ok(CREW_KIT_DEFERRED.indexOf(kept) < 0, kept + ' is never deferred by the diet (needs no crew)');
A.ok(Object.isFrozen(CREW_KIT_DEFERRED), 'the deferred list is frozen');

const LEAD = ['team.dispatch', 'team.summon', 'team.spawn', 'tool.search', 'fs.read'];
const base = { isTask: true, deferralOff: false, leanCrew: undefined, tools: LEAD, crewCount: 0 };
A.eq(isCrewlessLead(base), true, 'a task lead with no crew, team.dispatch and tool.search granted: crewless');
A.eq(isCrewlessLead(Object.assign({}, base, { tools: LEAD.filter(n => n !== 'tool.search') })), false,
  'tool.search NOT granted: no diet (nothing could reveal the deferred kit)');
A.eq(isCrewlessLead(Object.assign({}, base, { tools: LEAD.filter(n => n !== 'team.dispatch') })), false, 'no team.dispatch (a worker): no diet');
A.eq(isCrewlessLead(Object.assign({}, base, { crewCount: 1 })), false, 'any crew: no diet (byte-identical to before)');
A.eq(isCrewlessLead(Object.assign({}, base, { isTask: false })), false, 'a chat turn (no tools on the wire): no diet');
A.eq(isCrewlessLead(Object.assign({}, base, { deferralOff: true })), false, 'SKYNET_TOOL_SEARCH=0: no diet');
A.eq(isCrewlessLead(Object.assign({}, base, { leanCrew: '0' })), false, 'STARNET_LEAN_CREW=0: no diet');
A.eq(isCrewlessLead(Object.assign({}, base, { leanCrew: ' 0 ' })), false, 'STARNET_LEAN_CREW=" 0 ": no diet (trimmed)');
A.eq(isCrewlessLead(Object.assign({}, base, { leanCrew: '1' })), true, 'STARNET_LEAN_CREW=1: diet on');
A.eq(isCrewlessLead(Object.assign({}, base, { tools: null })), false, 'no tool list: no diet');
A.eq(isCrewlessLead(), false, 'no input: no diet');

// wiring: index.js decides `crewless` through this predicate and defers exactly this list
const index = readSidecarSource();
A.ok(/const crewless = CrewDiet\.isCrewlessLead\(\{[^}]*tools: resolved\.tools[^}]*crewCount: crewCountFor\(agentId\)/.test(index),
  'index.js: `crewless` is the crew-diet predicate over the run\'s granted tools and live crew count');
A.ok(index.indexOf('crewless ? CrewDiet.CREW_KIT_DEFERRED : []') >= 0, 'index.js: a crewless lead defers exactly CREW_KIT_DEFERRED');
// every deferred name has a reveal producer, so none needs a search after the action that makes it useful
const orch = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'orchestration.js'), 'utf8');
A.ok(/control: \{ revealTools: \['team\.dispatch', 'station\.control'\] \}/.test(orch), 'team.summon\'s result reveals team.dispatch (and station.control, which seats the new hire in this chat)');
A.eq((orch.match(/control: \{ revealTools: BACKGROUND_CONTROLS\.slice\(\) \}/g) || []).length, 2, 'background team.dispatch and team.spawn results reveal the controls');
const bg = (orch.match(/BACKGROUND_CONTROLS = Object\.freeze\(\[([^\]]*)\]\)/) || [])[1] || '';
A.eq(bg.replace(/['\s]/g, '').split(',').sort().join(','), CREW_KIT_DEFERRED.filter(n => n !== 'team.dispatch').slice().sort().join(','),
  'the background controls a spawn reveals are exactly the deferred controls');
const station = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'station.js'), 'utf8');
A.ok(/name: 'team\.config'[\s\S]{0,900}control: \{ revealTools: \['team\.configure'\] \}/.test(station), 'team.config\'s result reveals team.configure');

A.report('crew-diet');
