'use strict';
const { readSidecarSource } = require('./helpers/source');

/* releases#10 — BUILT-IN ABILITIES: the agent picker above the switches read "Abilities of <agent>" and the legend
   right above the rows spoke only of "this agent", so a switch looked per-agent. It is not: the picker only chooses
   whose AVAILABILITY the list shows (GET /api/toolsets?agent=…), while every switch POSTs a bare { enabled } that the
   sidecar writes into the ONE station-wide toolsetDisabled map, and the run path applies that map to every agent.
   This pins the truth the copy now states, so a later per-agent switch must update both together. */

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CONN = read('frontend/app/windows/connectors.js');
const SC = readSidecarSource();

// the copy beside the switches
A.ok(CONN.includes('<label class="mc-hint" for="ts-agent">Show abilities of</label>'), 'the picker caption says it SHOWS an agent’s abilities');
A.ok(!CONN.includes('>Abilities of</label>'), 'the old caption that read as ownership is gone');
const legend = (CONN.match(/<p class="ability-legend">([^<]+)<\/p>/) || [])[1] || '';
A.ok(/Each switch below applies to every agent\.$/.test(legend), 'the legend directly above the rows says each switch applies to every agent');
A.ok(/^AVAILABLE means this agent has the capability/.test(legend), 'and still explains AVAILABLE for the agent shown');

// the truth behind the copy: the picker feeds only the read; the switch carries no agent
A.ok(/Harness\.api\.get\('\/api\/toolsets\?agent=' \+ encodeURIComponent\(tsAgentEl\.value\)/.test(CONN), 'the picker selects whose availability GET /api/toolsets reads');
const post = (CONN.match(/Harness\.api\.post\('\/api\/toolsets\/'[^;]+;/) || [''])[0];
A.ok(post && !/agent/i.test(post), 'the switch POST carries no agent');
const toggle = SC.slice(SC.indexOf('async function handleToolsetToggle'), SC.indexOf('/* ---- /api/connectors'));
A.ok(toggle.length > 0 && !/agent/i.test(toggle), 'the toggle handler never reads an agent');
A.ok(/if \(body\.enabled\) delete toolsetDisabled\[id\]; else toolsetDisabled\[id\] = false;/.test(toggle), 'it writes the one station-wide toolsetDisabled map, keyed by ability only');
A.ok(/resolveTools\(agentId, station, undefined, \{ disabledCaps: unrestrictedHostNow\(\) \? new Set\(\) : disabledCapsSet\(\) \}\)/.test(SC), 'and the run path applies that same map to whichever agent runs');

A.report('abilities-switch-scope.test');
