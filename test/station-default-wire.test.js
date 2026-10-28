/* node test/station-default-wire.test.js — issue #24: "Follow station default" must follow the STATION, not the
   last pinned agent that was focused. focusAgent writes the focused agent's wire into the one global Harness wire
   every COMMS run reads; an unpinned agent used to keep whatever pin was there, so a specialist summoned on StarNet
   credits and later un-pinned kept sending runs as `starnet` — refused at 0s with "Out of managed credit" on a funded
   OpenRouter station. app.js is not node-loadable, so the wire helpers are lifted from source and run against a fake
   roster, and the call sites that must use them are locked against the source. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');

function lift(name) {
  const start = appjs.indexOf('  function ' + name + '(');
  A.ok(start >= 0, name + ' exists in app.js');
  const end = appjs.indexOf('\n  }\n', start);
  return appjs.slice(start, end + 4);
}
const src = ['stationDefaultWire', 'savedStationProv', 'focusWire', 'applyWire'].map(lift).join('\n');
// the wire-pin tracker is two module lines (a `let` + a one-line helper), lifted verbatim
const pinDecl = (appjs.match(/\n  let wirePinOwner = '';\n  function noteWirePin\(a\) \{[^\n]*\}\n/) || [''])[0];
A.ok(pinDecl.length > 0, 'the wire-pin tracker exists in app.js');
function world(agentsList) {
  const agents = new Map(agentsList.map(a => [a.id, a]));
  const state = { prov: '', model: '', effort: '' };
  const Harness = {
    setProv: p => { state.prov = p; }, setModel: m => { state.model = m; }, setReasoningEffort: e => { state.effort = e; }
  };
  const fns = new Function('agents', 'Harness', pinDecl + src + '\nreturn { stationDefaultWire, savedStationProv, focusWire, applyWire, noteWirePin };')(agents, Harness);
  return Object.assign(fns, { agents, state });
}

const hero = { id: 'agent', model: 'openai/gpt-6-astra-pro', provider: 'openrouter', reasoningEffort: 'medium' };
const pinned = { id: 'chief', model: 'anthropic/claude-sonnet-5', provider: 'starnet', reasoningEffort: 'high' };
const unpinned = { id: 'researcher', model: null, provider: null, reasoningEffort: null };
const w = world([hero, pinned, unpinned]);

// the reporter's sequence: focus a starnet-pinned specialist, then an unpinned one
w.applyWire(w.focusWire(pinned));
A.eq(w.state.prov, 'starnet', 'a pinned agent still runs on its own pin');
A.eq(w.state.model, 'anthropic/claude-sonnet-5', 'a pinned agent still runs on its own model');
w.applyWire(w.focusWire(unpinned));
A.eq(w.state.prov, 'openrouter', 'an unpinned agent follows the station provider, not the last pin focused (#24)');
A.eq(w.state.model, 'openai/gpt-6-astra-pro', 'an unpinned agent follows the station model, not the last pin focused');
A.eq(w.state.effort, 'medium', 'an unpinned agent follows the station reasoning effort');

// clearing the focused agent's pin re-applies the station default at once
w.applyWire(w.focusWire(pinned));
pinned.model = null; pinned.provider = null; pinned.reasoningEffort = null;
w.applyWire(w.focusWire(pinned));
A.eq(w.state.prov, 'openrouter', 'FOLLOW STATION DEFAULT on the focused agent drops its starnet pin immediately');

// a pinned model with no provider takes the station provider, never a stale global
const legacy = { id: 'old', model: 'openai/gpt-4o-mini', provider: null };
A.eq(w.focusWire(legacy).provider, 'openrouter', 'a legacy pin without a provider rides the station provider');

// saves written while a pinned agent was focused carried its provider as the top-level `prov`
A.eq(w.savedStationProv({ prov: 'starnet', agent: { provider: 'openrouter' } }), 'openrouter', 'a poisoned save resumes on the hero\'s provider');
A.eq(w.savedStationProv({ prov: 'codex', agent: {} }), 'codex', 'an older save without a hero provider still resumes on its top-level prov');
A.eq(w.savedStationProv(null), '', 'no save → no provider');

// the call sites that must route through the station default
const focusBody = appjs.slice(appjs.indexOf('  function focusAgent('), appjs.indexOf('\n  }\n', appjs.indexOf('  function focusAgent(')));
A.ok(/applyWire\(wire\)/.test(focusBody) && /const wire = focusWire\(a\)/.test(focusBody), 'focusAgent applies focusWire (station default for unpinned agents)');
A.ok(!/if \(a\.provider && typeof Harness/.test(focusBody), 'focusAgent no longer writes only the fields an agent happens to carry');
A.ok(/applyWire\(focusWire\(a\)\);\s+\/\/ a CLEARED pin/.test(appjs), 'clearing the focused agent\'s pin re-applies the station default');
A.ok(/const fallbackProv = stationDefaultWire\(\)\.provider \|\|/.test(appjs), 'pushRoster pairs a pinned row\'s bare model with the station provider, not the focused pin');
// run-wire-resolver lane: an UNPINNED crew row carries no provider (it follows the station default on every surface); the
// Overseer's row keeps its provider (the station's provider choice)
A.ok(/provider: \(a\.model \|\| a\.id === 'agent'\) \? \(a\.provider \|\| fallbackProv\) : ''/.test(appjs), 'pushRoster stops stamping a provider onto unpinned crew rows');
A.ok(/const prov = \(hero && hero\.provider\) \|\|/.test(appjs), 'persist saves the station provider, not the focused agent\'s pin');
A.eq((appjs.match(/Harness\.setProv\(saved\.prov\)/g) || []).length, 0, 'no resume path restores the raw top-level saved.prov');
A.eq((appjs.match(/Harness\.setProv\(savedStationProv\(saved\)\)/g) || []).length, 3, 'all three resume paths restore the station provider');

// SETTINGS -> PROVIDERS moves the station default (the Overseer's pin), so unpinned agents follow the switch instead
// of the provider the station just left (a StarNet-credits station switched to a BYOK key kept sending `starnet`).
{
  const calls = [];
  const src2 = ['stationDefaultWire', 'focusWire', 'setStationProvider'].map(lift).join('\n');
  const roster = new Map([
    ['agent', { id: 'agent', model: 'anthropic/claude-sonnet-5', provider: 'starnet', reasoningEffort: 'medium' }],
    ['scout', { id: 'scout', model: null, provider: null, reasoningEffort: null }]
  ]);
  const f = new Function('agents', 'normalizeProviderId', 'pushRoster', 'persist', src2 + '\nreturn { focusWire, setStationProvider };')(
    roster, p => String(p).trim().toLowerCase(), () => calls.push('roster'), () => calls.push('persist'));
  A.eq(f.focusWire(roster.get('scout')).provider, 'starnet', 'before the switch an unpinned agent follows the Overseer');
  A.eq(f.setStationProvider('openrouter'), true, 'the Settings pick moves the station default');
  A.eq(f.focusWire(roster.get('scout')).provider, 'openrouter', 'an unpinned agent follows the Settings switch, not the provider the station left');
  A.eq(f.focusWire(roster.get('scout')).model, 'anthropic/claude-sonnet-5', 'the station model is kept (the dock reconciles an invalid one)');
  A.eq(calls, ['roster', 'persist'], 'unpinned roster rows and the save are rewritten');
  A.eq(f.setStationProvider('openrouter'), false, 'a repeat pick is a no-op');
}
// 2026-10-21 user report: an Overseer with NO model let an unpinned agent keep the last crew pin in the wire (a StarNet
// slug), so runs went to managed credits or the dock cleared it to "no model selected for CLAUDE CODE".
{
  const bare = { id: 'agent', model: '', provider: 'claude-cli', reasoningEffort: '' };
  const starPin = { id: 'custom1', model: 'openai/gpt-6-luna', provider: 'starnet', reasoningEffort: 'high' };
  const free = { id: 'scout', model: null, provider: null, reasoningEffort: null };
  const v = world([bare, starPin, free]);
  v.applyWire(v.focusWire(starPin));
  A.eq(v.state.model, 'openai/gpt-6-luna', 'a crew pin still drives the wire while that agent is focused');
  v.applyWire(v.focusWire(free));
  A.eq(v.state.model, '', 'an unpinned agent never inherits the last crew pin when the Overseer has no model');
  A.eq(v.state.prov, 'claude-cli', 'it takes the station provider');
  v.applyWire(v.focusWire(bare));
  A.eq(v.state.model, '', 'the model-less Overseer does not resurrect the crew pin either');

  // an older station keeps its model only in the wire (hero saved with no model): focusing must NOT wipe it
  const L = world([{ id: 'agent', model: '', provider: 'codex' }, { id: 'r', model: null, provider: null }]);
  L.state.model = 'gpt-6-luna';
  L.applyWire(L.focusWire(L.agents.get('agent')));
  L.applyWire(L.focusWire(L.agents.get('r')));
  A.eq(L.state.model, 'gpt-6-luna', 'a station model that lives only in the wire survives focus changes');

  // a pin written straight to the wire (dock pick / pin editor, not applyWire) is tracked too
  const D = world([{ id: 'agent', model: '', provider: 'codex' }, { id: 'x', model: 'm-x', provider: 'starnet' }, { id: 'y', model: null }]);
  D.state.model = 'm-x'; D.noteWirePin(D.agents.get('x'));
  D.applyWire(D.focusWire(D.agents.get('y')));
  A.eq(D.state.model, '', 'a crew pin set by the dock is cleared when an unpinned agent takes focus');
  D.state.model = 'm-hero'; D.noteWirePin(D.agents.get('agent'));
  D.applyWire(D.focusWire(D.agents.get('y')));
  A.eq(D.state.model, 'm-hero', 'the Overseer is never a crew pin owner');
}
A.eq((appjs.match(/noteWirePin\((a|agent)\);/g) || []).length, 2, 'both direct pin writers (pin editor + dock) note the wire owner');

const stationui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
A.ok(/h\.setProv\(p\);\s*\n\s*\/\/[^\n]*\n\s*if \(typeof App !== 'undefined' && App\.setStationProvider\) App\.setStationProvider\(p\);/.test(stationui),
  'the Settings provider card moves the station default too');

A.report('station-default-wire.test');
