/* node test/journey-wiring.test.js — end-to-end source seams for the six-part leveling foundation. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const index = read('frontend/index.html'), app = read('frontend/app/app.js'), goals = read('frontend/app/goalstore.js');
const ui = read('frontend/app/stationui.js'), world = read('frontend/app/world.js'), props = read('frontend/app/propsprites.js');
const host = readSidecarSource(), xp = read('frontend/app/xp.js'), ratings = read('sidecar/growthratings.js');
const journeyStore = read('frontend/app/journeystore.js'), spine = read('frontend/app/queryspine.js');

A.ok(index.indexOf('app/journey.js') < index.indexOf('app/journeystore.js'), 'pure journey helper loads before its state citizen');
A.ok(app.indexOf('JourneyStore.init') >= 0 && app.indexOf('JourneyStore.reset') >= 0, 'journey lifecycle initializes and clears for a new Commander');
A.ok(goals.indexOf('JourneyStore.noteMilestone') >= 0, 'verified goal milestones fold into durable journey evidence');
A.ok(host.indexOf("exact: '/api/journey'") >= 0 && /journeyStore\.adaptationBlock\(agentId[,)]/.test(host), 'HTTP proof and per-agent adaptation are wired into the real host');
// the cache-stable system prompt carries the tier-only block; the STARNET_STABLE_PREFIX=0 kill switch keeps the counted one
A.ok(host.indexOf('journeyStore.adaptationBlock(agentId, { counts: !stablePrefix })') >= 0, 'the stable system prompt gets the count-free adaptation block');
A.ok(ui.indexOf('STATION XP') >= 0 && ui.indexOf('COMMANDER JOURNEY') >= 0 && ui.indexOf('STATION EVOLUTION') >= 0, 'the UI keeps all three progression tracks distinct');
// org pass 10-14 (P28): one number, one name — the station-XP meter mislabelled AGENT GROWTH is gone, approvals read as thumbs-up
A.ok(!/gx-title">AGENT GROWTH</.test(ui) && !/data-open-growth/.test(ui), 'QUESTS › Progress no longer repeats STATION XP as a second AGENT GROWTH meter');
A.ok(/<span class="ttl">STATION XP<\/span>/.test(ui) && /' THUMBS-UP &middot;/.test(ui) && !/' APPROVALS &middot;/.test(ui), 'STATION XP counts thumbs-up by that name');
A.ok(/<summary><span>Station milestones<\/span><span class="q-section-count">[\s\S]{0,120}data-open-trophies>OPEN THE TROPHY CASE<\/button><\/summary>/.test(ui), 'the TROPHY CASE door sits on the folded Station milestones summary row (one arrow: the fold chevron)');
A.ok(/if \(b\.closest\('summary'\)\) ev\.preventDefault\(\);/.test(ui), 'clicking that door does not also fold the milestones');
// org pass 10-14 (P29): the QUESTS tab strip reads in caps like every family strip
A.ok(/\['available', 'NOW', /.test(ui) && /\['goals', 'GOALS', /.test(ui) && /\['progress', 'PROGRESS', /.test(ui) && /\['completed', 'HISTORY', /.test(ui), 'QUESTS tabs read NOW · GOALS · PROGRESS · HISTORY');
A.ok(ui.indexOf('STOP USING THIS') >= 0 && ui.indexOf('RESUME ADAPTATION') >= 0, 'adaptation receipts have Commander correction controls');
A.ok(world.indexOf('PropSprites.setJourneyStage') >= 0 && props.indexOf('journeyStage') >= 0, 'distinct reached goals physically transform the trophy case crown');
A.ok(xp.indexOf('SIZE_MULT') < 0 && ratings.indexOf('const verdictDelta = 3') >= 0, 'tool/spend size can no longer weight new XP verdicts upstream or downstream');
A.ok(!/capabilit(?:y|ies).*evolution/i.test(read('sidecar/journey-store.js')), 'journey storage does not advertise capability gates');
A.ok(host.indexOf('station generation changed; reload before updating journey') >= 0 && host.indexOf('journeyStore.currentEpoch') >= 0,
  'stale tabs cannot write journey progress into a different Commander generation');
A.ok(/define\('journey',[\s\S]*path:\s*'\/api\/journey'/.test(spine), 'QuerySpine owns the canonical Journey GET resource');
A.ok(/QuerySpine/.test(journeyStore) && !/fetch\(\s*'\/api\/journey'\s*,\s*\{\s*cache:\s*'no-store'/.test(journeyStore),
  'JourneyStore owns no private GET cache or poller outside QuerySpine');
A.ok(/journey snapshot is unconfirmed/i.test(ui), 'cached journey proof is visibly labeled unconfirmed after a read failure');
// org pass 10-14 (P19): automation doors land in the right AUTOMATE tab
{
  const tut = read('frontend/app/tutorial.js');
  A.ok(/fmAction\('workflows', 'OPEN WORKFLOWS'\)/.test(tut) && !/'OPEN AUTOMATION'/.test(tut), 'FIELD MANUAL › LINES ends on OPEN WORKFLOWS (the window that runs lines), not SCHEDULES');
  A.ok(/<b>Routines = WHEN\.<\/b>/.test(tut), '…and keeps Routines = WHEN (DECISIONS.md, Andrew’s call #4)');
  A.ok(/type <code>\/away<\/code> in COMMS/.test(ui) && /<b>Build while away<\/b>/.test(ui) && !/<code>\/build-away<\/code>/.test(ui), 'the AWAY WORK queue names /away (canonical) beside the quest’s Build while away');
  A.ok(/<small>workflows, schedules, loops &amp; away&nbsp;work<\/small>/.test(index), 'the AUTOMATE dock subtitle names all four tabs on one line (away&nbsp;work never strands "work")');
}
A.report('journey-wiring.test');
