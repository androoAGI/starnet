'use strict';

// The Skills backend can be completely healthy while a missing frontend lane dependency makes
// ABILITIES silently omit SKILL LIBRARY, AGENT SKILLS, and SKILL EXCHANGE. connectors.js deliberately
// catches lane-builder errors so one optional lane cannot break the whole console; this test therefore
// executes the production lane builder and requires every shipped Skills section to survive that seam.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');
const readSourceText = require('./_source-text.js');

const source = readSourceText(path.join(__dirname, '../frontend/app/stationui.js'));
const laneMatch = source.match(/function abilitySkillsLane\(body\) \{[\s\S]*?\n  \}\n  window\.AbilityLanes/);
A.ok(laneMatch, 'the ABILITIES Skills lane is present');

const laneSource = laneMatch[0].replace(/\n  window\.AbilityLanes[\s\S]*$/, '');
const context = {
  present: [{ id: 'agent', name: 'Agent' }],
  sel: 0,
  esc: value => String(value),
  result: null
};
vm.runInNewContext(laneSource + '\nresult = abilitySkillsLane({});', context);

A.eq(context.result.sections.map(section => section.id), ['library', 'agent', 'exchange'],
  'the live lane builds all three Skills sections without throwing');
A.eq(context.result.sections.map(section => section.label), ['SKILL LIBRARY', 'AGENT SKILLS', 'SKILL EXCHANGE'],
  'the live lane exposes the three promised labels');
A.ok(/function\s+scanFindingText\s*\(/.test(source), 'Skill Exchange scan findings renderer is defined');
A.ok(/function\s+renderSkillExchangePreview\s*\(/.test(source), 'Skill Exchange preview renderer is defined');
A.ok(/function\s+wireSkillExchange\s*\(/.test(source), 'Skill Exchange controls are wired');
A.ok(/window\.AbilityLanes\.push\(abilitySkillsLane\)/.test(source), 'the Skills lane registers with ABILITIES');
A.ok(source.includes("skills.length + ' skill'"), 'the library count calls these procedures skills, not launchable recipes');
A.ok(/id="sk-exchange-preview"[^>]*role="status"[^>]*aria-live="polite"/.test(source),
  'Skill Exchange inspection and validation feedback is announced');
A.ok(source.includes('PACKAGE SHA-256') && source.includes('sk-package-file'), 'review exposes the complete package manifest and exact digest');
A.ok(source.includes('IMPORT EXPORTED PACKAGE') && source.includes('data-ag-act="export"'), 'lossless import and export controls are present');
A.ok(source.includes('data-ag-act="generations"') && source.includes('data-rollback='), 'offline generation rollback is exposed');
A.ok(source.includes('DISCOVER SITE') && source.includes('SAVE TAP'), 'registry discovery and user-managed taps are exposed');
A.ok(!source.includes('referenced package files remain at the source'), 'the obsolete single-document limitation is gone');

// A Full Access user must not be sent to place a cabinet just to load FILES instructions.
// Exercise the actual UI loader with the real authority projection, not a second grant calculation.
async function checkAvailability() {
  const { effectiveToolsets } = require('../sidecar/capability/effective-toolsets.js');
  const loader = source.match(/function loadSkillLibrary\(agentId\) \{[\s\S]*?\n  \}/)[0];
  async function run(view, shared = []) {
    let requested = '', rendered = null;
    const host = { innerHTML:'', closest:() => null };
    vm.runInNewContext(loader + '\nloadSkillLibrary("agent");', {
      $: () => host, Harness:{api:{get:async () => view}},
      World:{heroCaps:() => [],stationCaps:() => shared.map(objectType => ({objectType}))},
      fetch:async url => { requested = url; return {ok:true,json:async () => ({skills:[]})}; },
      renderSkillLibrary:(_host,_skills,_id,placed) => { rendered = Array.from(placed); },
      requestAnimationFrame:() => {}, encodeURIComponent
    });
    await new Promise(resolve => setImmediate(resolve));
    return {requested,rendered,host};
  }
  const full = await run(effectiveToolsets({fullAccess:true}));
  A.ok(full.rendered.includes('cabinet') && full.requested.includes('cabinet'), 'Full Access projects FILES into skill availability without a placed cabinet');
  const profile = await run(effectiveToolsets({agent:{executionProfile:'safe-cell',approvalMode:'ask'}}), ['dish']);
  A.ok(profile.rendered.includes('cabinet') && profile.rendered.includes('dish'), 'profile objects and shared station gear follow the runtime skill context');
  const restricted = await run(effectiveToolsets({agent:{executionProfile:'station-gear',approvalMode:'ask'}}));
  A.ok(!restricted.rendered.includes('cabinet'), 'restricted station without FILES does not invent that ability');
  const unavailable = await run(null);
  A.eq(unavailable.requested, '', 'unavailable authority never produces a guessed skill query');
  A.ok(unavailable.host.innerHTML.includes('Could not load'), 'unavailable authority renders recovery instead of missing-prop advice');
  A.report('abilities.skills-lane.test');
}
checkAvailability().catch(error => { console.error(error); process.exitCode = 1; });
