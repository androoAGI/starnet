'use strict';
// Execute the real resume function with rendering stubbed. Saves and rating HTTP are real in the caller.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');
module.exports = function resumeRatingFixture(saved) {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
  const body = A.fnBody(source, 'function resumeInto(');
  const agents = new Map();
  const noop = () => {};
  const context = {
    saved: JSON.parse(JSON.stringify(saved)), agent: null,
    agentDocs: noop, stripLegacyVoiceBlock: noop, stripLegacySoloClause: noop,
    composeSystemPrompt: () => 'fixture', registerHero: a => agents.set('agent', a),
    rehydrateRoster: rows => { for (const a of rows || []) if (a.id !== 'agent') agents.set(a.id, a); },
    recomposeOrchestrators: noop, Harness: {setProv:noop,setReasoningEffort:noop,setModel:noop,getModel:()=> 'test/model',setTotals:noop},
    Workstreams: {init:noop}, enterGame:noop,persist:noop,
    pendingStationDoc:null,pendingStationStats:null,pendingGrowthSyncAt:0,pendingRatingSyncAt:0,
    pendingProfile:null,pendingWorkSignal:null,pendingDossier:null
  };
  vm.runInNewContext(body + '; resumeInto(saved);', context);
  return { hero: context.agent, agents };
};
