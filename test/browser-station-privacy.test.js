/* node test/browser-station-privacy.test.js — ONLY the Commander at COMMS may drive the shared station browser.
   Release review 2026-09-30: the station browser carries the Commander's sign-ins and open tabs, and 'interactive' is
   also the surface of Telegram/Discord chats with approvals on (including allowed group chats), STARNET REMOTE phone
   runs and group sessions. Those must browse in a private browser. Pins the composition-root wiring (an injected-deps
   unit test cannot see it): the station view is granted only on surface 'interactive' AND stationBrowser:true, and only
   the COMMS /api/run call passes stationBrowser. Plus the view itself: a non-interactive request gets no station view. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeBrowserViews } = require('../sidecar/browser-view.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const index = readSidecarSource();

// the grant
const grant = index.match(/runStationBrowser = await browserViews\.sessionForRun\(\{[^}]*\}\)/);
A.ok(!!grant, 'runOnce asks browser-view for the station browser');
A.ok(grant && /interactive:\s*surface === 'interactive' && o\.stationBrowser === true/.test(grant[0]),
  'the station browser is granted only to an interactive run that is ALSO marked as started from COMMS');

// who marks a run as COMMS
const marks = index.match(/stationBrowser:\s*true/g) || [];
A.eq(marks.length, 1, 'exactly one runOnce call in index.js claims the station browser');
const at = index.indexOf('stationBrowser: true');
const around = index.slice(Math.max(0, at - 2500), at);
A.ok(/loginPrompt:\s*askHuman/.test(around) && /surface:\s*'interactive', prompt: promptConsent/.test(around),
  '…and it is the COMMS directive run (the one with the live consent and sign-in prompts)');

// the unattended / remote callers never claim it
for (const rel of ['sidecar/channels/hub.js', 'sidecar/remote/host.js']) {
  A.ok(!/stationBrowser/.test(read(rel)), rel + ' never claims the station browser');
}
// the group-session runOnce (surface 'interactive', lead only for the group's lead) must not either
const group = index.indexOf("surface: 'interactive', lead: t.agentId === g.leadId, groupTools: tools");
A.ok(group > 0, 'the group-session run is still where this test expects it');
const groupCall = index.slice(group - 1500, group + 1500);
A.ok(!/stationBrowser/.test(groupCall), 'group sessions never claim the station browser');

// the view: no station view unless interactive
{
  const views = makeBrowserViews({ now: () => 0, makeStationSession: () => ({}) });
  A.eq(views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: false }), null, 'a run that is not granted gets no station view (a private browser)');
  A.eq(views.sessionForRun({ agentId: 'nova', runId: 'r2' }), null, '…including one that says nothing');
}
A.report('browser-station-privacy.test');
