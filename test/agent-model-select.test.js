/* node test/agent-model-select.test.js — source-lock that per-agent MODEL SELECTION + RENAME are actually WIRED
   end to end (mirrors settings-p1-ui / autonomy-ui: these browser-flow modules aren't node-loadable, so we lock
   the wiring invariants against the source). Covers:
     · creation: the recruitment bay offers a model picker and threads it into summon (spec.modelPin)
     · summon: a summoned agent takes the chosen model AND its provider + effort (no more provider drift)
     · dossier: the CONFIG model card is a real picker + persists model/provider/effort; the name is renamable
     · plumbing: ModelDock exposes a pure catalog(); World.relabel follows a rename; the picker script loads */
'use strict';
const A = require('./_assert.js');
const { functionSourceIn } = require('./helpers/source.js');
const fs = require('fs'); const path = require('path');
const app = (f) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const appjs = app('app.js'), ui = app('stationui.js'), mkt = app('marketplace.js'), dock = app('modeldock.js'), world = app('world.js'), chat = app('chat.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const ModelDock = require('../frontend/app/modeldock.js');

// ---- ModelDock: a PURE catalog + helper surface for other pickers (no Harness/DOM side effects) ----
A.ok(/catalog:\s*\(o\)\s*=>\s*computeCatalog/.test(dock), 'ModelDock exposes a pure catalog() accessor');
A.ok(/reconcile:\s*\(\)\s*=>\s*fetchModels\(false\)/.test(dock), 'provider switches can revalidate the saved model against cached live catalogs');
A.ok(/async function computeCatalog\(/.test(dock), 'computeCatalog fans out across providers without touching the dock');
A.ok(/labels:\s*\{/.test(dock) && /efforts:\s*\{/.test(dock), 'ModelDock exposes label + effort helpers for reuse');
A.eq(ModelDock._internals.selectorLabel('anthropic/claude-haiku-4.5', 'medium'),
  'Model selector: claude haiku 4.5, Medium reasoning',
  'the model-chip accessible name includes the selected model and reasoning effort');
A.eq(ModelDock._internals.selectorLabel('', 'none'),
  'Model selector: no model selected, Reasoning off',
  'the model-chip accessible name stays honest when no model is selected');
A.ok(/toggle\.setAttribute\('aria-label',\s*selectorLabel\(current,\s*effort(?:,\s*item)?\)\)/.test(dock),
  'every ModelDock reflect refreshes the toggle accessible name from live model state');

// ---- the shared picker component loads before its consumers ----
A.ok(/app\/modelpicker\.js/.test(html), 'index.html loads the shared ModelPicker');
A.ok(html.indexOf('app/modeldock.js') < html.indexOf('app/modelpicker.js'), 'modelpicker loads AFTER modeldock (its data source)');
A.ok(html.indexOf('app/modelpicker.js') < html.indexOf('app/stationui.js'), 'modelpicker loads BEFORE the dossier that consumes it');

// ---- CREATION: the recruitment bay model picker → summon ----
A.ok(/function summonModelBarHTML\(/.test(mkt), 'the bay renders a SUMMON model bar');
A.ok(/ModelPicker\.shellHTML\(/.test(mkt), 'the bay model bar is built from the shared ModelPicker');
A.ok(/ModelPicker\.populate\(modelWrap/.test(mkt), 'the bay populates the catalog after mount');
A.ok(/modelPin:\s*pickedSummonModel/.test(mkt), 'the picked model is threaded into the onPick payload as modelPin');
// NAME + APPEARANCE + MODEL live in the dossier's CONFIGURE panel (2026-08-15), directly above the SUMMON button
// they feed — they were a collapsible strip on the far side of the window. The model bar is still wired end to end,
// now via summonConfigPanelHTML() off the dossier rather than off the roster.
A.ok(/summonConfigPanelHTML\(s\)/.test(mkt), 'the CONFIGURE panel is rendered into the dossier');
const summonConfigHTML = mkt.match(/function summonConfigPanelHTML\(s\) \{([\s\S]*?)\n  \}/)?.[1] || '';
A.ok(/summonModelBarHTML\(s\)/.test(summonConfigHTML), 'the CONFIGURE panel carries the model bar (still wired into summon)');
// Check the function's wiring, independent of how much appearance/name setup precedes it.
const summonConfigBody = mkt.match(/function wireSummonConfig\(sc\) \{([\s\S]*?)\n  \}/)?.[1] || '';
A.ok(/ModelPicker\.onChange\(modelWrap/.test(summonConfigBody), 'the panel re-binds its model picker on every dossier repaint');
// The name field now sits INSIDE the element renderDossier() replaces, so a keystroke may never repaint the dossier.
A.ok(!/nameIn\.addEventListener\('input',[\s\S]{0,200}renderDossier\(\)/.test(mkt), 'typing a name never re-renders the dossier out from under the focused input');

// ---- SUMMON: the new agent takes the chosen model AND its provider + effort ----
A.ok(/const pin = \(spec && spec\.modelPin\)/.test(appjs), 'summonAgent reads spec.modelPin');
A.ok(/model:\s*\(pin && pin\.model\)\s*\|\|\s*agent\.model/.test(appjs), 'summon uses the picked model, falling back to the hero');
A.ok(/provider:\s*\(pin && pin\.provider\)\s*\|\|\s*agent\.provider/.test(appjs), 'summon sets provider (fixes prior provider drift)');
A.ok(/reasoningEffort:\s*\(pin && pin\.effort\)/.test(appjs), 'summon sets reasoning effort');

// ---- DOSSIER model card: a real picker that persists model/provider/effort ----
A.ok(/function modelCard\(/.test(ui), 'the CONFIG model card still exists');
A.ok(/ModelPicker\.shellHTML\(/.test(ui), 'the model card is built from the shared ModelPicker');
A.ok(/ModelPicker\.populate\(pickWrap/.test(ui), 'the model card preselects + populates the picker from the agent pin');
A.ok(/access\.config\.setModel\(a && a\.id, model, provider, effort\)/.test(ui), 'the card persists model + provider + effort (4-arg setModel)');
A.ok(/id="ag-model-in"/.test(ui) && /id="ag-prov-in"/.test(ui), 'the advanced free-text escape hatch is preserved');

// ---- setAgentModelPin gains an OPTIONAL effort arg (additive, old callers untouched) ----
A.ok(/function setAgentModelPin\(agentId, model, provider, effort\)/.test(appjs), 'setAgentModelPin accepts an optional effort');
A.ok(/arguments\.length >= 4/.test(appjs), 'effort is only written when the 4th arg is passed (back-compatible)');

// ---- DOSSIER rename ----
// data-goconfig now carries the TARGET CARD's id rather than a bare "1" (dossier UX pass 2026-08-07): the same
// attribute drives BRIEF's setup strip, and every one of those rows lands on the card that owns the setting.
// Locked as "the model tag points at the model card", not as a literal — the literal was the weaker claim.
A.ok(/class="tag model" data-goconfig="ag-model-card"/.test(ui), 'the model tag is a one-click shortcut to the CONFIG model card');
A.ok(/id="ag-model-card"/.test(ui), 'the model card carries the id the shortcut targets');
A.ok(/id="ag-rename-btn"/.test(ui) && /id="ag-rename-in"/.test(ui), 'the dossier header has a rename affordance + inline editor');
A.ok(/function wireHead\(/.test(ui) && /wireHead\(body\)/.test(ui), 'wireHead is defined and called for every tab');
A.ok(/access\.config\.setName/.test(ui), 'rename persists through config.setName');

// ---- setAgentName: display-only rename that keeps the prompt + floor honest, then persists ----
A.ok(/function setAgentName\(/.test(appjs), 'App implements setAgentName');
A.ok(/setName:\s*setAgentName/.test(appjs), 'setName is exposed on the config access surface');
A.ok(/function setAgentName[\s\S]{0,600}toUpperCase\(\)\.slice\(0, 18\)/.test(appjs), 'the name is normalized (UPPER, capped 18) like a summoned name');
A.ok(/function setAgentName[\s\S]{0,1200}composeSystemPrompt\(a\)/.test(appjs), 'rename recomposes the system prompt (the default identity embeds the name)');
A.ok(/function setAgentName[\s\S]{0,1800}pushRoster\(\)[\s\S]{0,120}persist\(\)/.test(appjs), 'rename reaches the sidecar roster + persists');

// ---- World.relabel: the floor nameplate follows a rename ----
A.ok(/function relabel\(id, name\)/.test(world), 'World implements relabel');
A.ok(/\brelabel,/.test(world), 'relabel is exported on the World public API');
A.ok(/World\.relabel/.test(appjs), 'setAgentName relabels the floor body');
A.ok(/function setAgentName[\s\S]{0,2600}Chat\.refreshAgentIdentity\(\)/.test(appjs), 'rename invalidates the COMMS identity cache for focused overseer and non-focused crew labels');
A.ok(/function refreshAgentIdentity\(\)[\s\S]{0,500}App\.agentName\(activeWs\.agentId \|\| 'agent'\)[\s\S]{0,220}renderIdBar\(\)/.test(chat), 'COMMS rename refresh re-resolves the focused speaker and rebuilds the live-roster selector without reloading the stream');
A.ok(/refreshAgentIdentity\s*,/.test(chat), 'Chat exposes the narrow rename invalidation hook');

// ---- review fix: rename must re-sync the DEFAULT identity so the PROMPT (not just the label) takes the new name ----
A.ok(/function setAgentName[\s\S]{0,900}baseIdentity\(nm, a\.role\)/.test(appjs), 'rename regenerates the default identity for the new name (prompt is not left saying the old name)');
A.ok(/function setAgentName[\s\S]{0,900}baseIdentity\(oldName, a\.role\)/.test(appjs), 'rename only rewrites the identity when it is still the untouched default (hand-edited identity.md is preserved)');

// ---- review fix: the dossier picker re-fits the effort select on model change + effort is tied to the picked model ----
A.ok(/ModelPicker\.onChange\(pickWrap/.test(ui), 'the dossier wires onChange so the effort select re-fits when the model changes');
A.ok(/pick\.model \? \(pick\.effort/.test(ui), 'effort is only persisted for the PICKED model (never leaks onto a typed advanced model or a cleared pin)');

// ---- COMMS AGENT SELECTOR: the top of the chat window picks which roster agent is on the line ----
// The header markup exists (a native <select> + a truthful model readout), filled from the LIVE roster.
A.ok(/id="comms-agent-select"/.test(html), 'index.html has the COMMS agent selector');
A.ok(/id="comms-agent-model"/.test(html), 'index.html has the COMMS agent model readout');
// chat.js fills the selector + model text from App.agents() (never hardcoded) and reflects the active stream's agent.
A.ok(/function renderIdBar\(/.test(chat), 'chat.js renders the COMMS agent line');
A.ok(/App\.agents\(\)/.test(chat), 'the agent line is populated from the LIVE roster (App.agents), not hardcoded');
A.ok(/activeWs\s*\?\s*\(activeWs\.agentId/.test(chat), 'the selected agent reflects the DISPLAYED workstream\'s agentId');
// Match the function boundary: unrelated comments or new restore paths must not invalidate this wiring check.
const loadBody = chat.match(/function load\(ws\) \{([\s\S]*?)\n  \}/)?.[1] || '';
A.ok(/renderIdBar\(\)/.test(loadBody), 'load() re-renders the agent line so it follows every stream switch');
// a change hands off to App.selectAgent (switch/mint a stream bound to that agent) — never rebinds the current convo.
A.ok(/function wireIdBar\(/.test(chat), 'chat.js wires the selector change once');
A.ok(/App\.selectAgent\(/.test(chat), 'selecting an agent hands off to App.selectAgent');
// App.selectAgent: switch to (or MINT) a workstream BOUND to that agentId — matches the summon binding seam.
A.ok(/function selectAgent\(agentId\)/.test(appjs), 'App implements selectAgent');
A.ok(/selectAgent:\s*selectAgent/.test(appjs), 'selectAgent is exposed on the App public API');
// FRESH-SESSION FREEDOM: a brand-new EMPTY session rebinds in place when an agent is picked (the Commander
// keeps the blank line they just opened); the no-rebind law protects only conversations WITH content, which
// still switch/mint below. These locks read selectAgent's OWN body (sliced to its closing brace), never a char
// window from its declaration: a window broke twice as lines landed at the top of the function (900→2000 /
// 1100→2200, then the COMMS owner arbiter's yieldCommsToPick line pushed both anchors past it).
const selectAgentSrc = functionSourceIn(appjs, 'selectAgent');
A.ok(selectAgentSrc.startsWith('function selectAgent(agentId) {') && selectAgentSrc.endsWith('}')
  && selectAgentSrc.length < 8000 && !/function closeWsMenu\(/.test(selectAgentSrc),
  'the selectAgent slice is that one function, declaration to its own closing brace (no scanner overrun)');
A.ok(/!\(cur\.history\s*&&\s*cur\.history\.length\)[\s\S]{0,220}Workstreams\.setAgent\(cur\.id,\s*id\)/.test(selectAgentSrc), 'selectAgent rebinds a brand-new EMPTY session in place (empty-history guard + setAgent)');
A.ok(/Workstreams\.create\(a\.name,\s*\{\s*agentId:\s*id/.test(selectAgentSrc), 'selectAgent MINTS a stream bound to the agent when it has none (never rebinds a convo with content)');
A.ok(/switchWorkstream\(ws\.id\)/.test(selectAgentSrc), 'selectAgent switches to the agent\'s own workstream when the current one has content');
// the header model readout stays truthful when the model changes via the footer dock or the dossier pin.
A.ok(/refreshIdBar:\s*renderIdBar/.test(chat), 'chat.js exposes refreshIdBar so other surfaces can re-sync the header model');
A.ok(/function applyQuickModel[\s\S]{0,2200}Chat\.refreshIdBar\(\)/.test(appjs), 'the footer dock model change re-syncs the COMMS header readout');
A.ok(/function setAgentModelPin[\s\S]{0,1500}Chat\.refreshIdBar\(\)/.test(appjs), 'the dossier model pin re-syncs the COMMS header readout');

// Execute the actual dossier handlers: a dropdown clear must not fall back to the
// old pin in the collapsed advanced fields (v0.12.4 BYOK delegation escape).
for (const file of ['frontend/app/stationui.js', 'website/app/app/stationui.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf("    const mSave = body.querySelector('#ag-model-save');");
  const end = source.indexOf('    // PERSONALITY chips', start);
  const handlers = source.slice(start, end);
  function dossier() {
    const nodes = {};
    for (const id of ['ag-model-save', 'ag-model-msg', 'ag-model-pick', 'ag-model-in', 'ag-prov-in', 'ag-model-clear']) {
      nodes['#' + id] = { value: '', listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } };
    }
    nodes['#ag-model-in'].value = 'fixture/managed';
    nodes['#ag-prov-in'].value = 'starnet';
    let selection = { model: 'fixture/managed', provider: 'starnet', effort: 'high' }, change;
    const saves = [];
    new Function('body', 'ModelPicker', 'access', 'a', 'sfx', 'rerender', handlers)(
      { querySelector: id => nodes[id] || null },
      { populate: () => Promise.resolve(), read: () => selection, onChange: (_, callback) => { change = callback; } },
      { config: { setModel: (...args) => { saves.push(args); return true; } } },
      { id: 'worker', model: 'fixture/managed', provider: 'starnet' }, () => {}, () => {}
    );
    return { nodes, saves, pick(value) { selection = value; change(value); }, save() { nodes['#ag-model-save'].listeners.click(); } };
  }
  const clear = dossier();
  clear.pick({ model: '', provider: '', effort: '' }); clear.save();
  A.eq(JSON.stringify(clear.saves[0]), JSON.stringify(['worker', '', '', '']), file + ': follow-default SAVE clears the managed model/provider/effort');
  const pin = dossier();
  pin.pick({ model: 'fixture/byok', provider: 'openrouter', effort: 'medium' }); pin.save();
  A.eq(JSON.stringify(pin.saves[0]), JSON.stringify(['worker', 'fixture/byok', 'openrouter', 'medium']), file + ': explicit BYOK pin still saves');
  const advanced = dossier();
  advanced.pick({ model: '', provider: '', effort: '' });
  advanced.nodes['#ag-model-in'].value = 'custom-model'; advanced.nodes['#ag-prov-in'].value = 'custom'; advanced.save();
  A.eq(JSON.stringify(advanced.saves[0]), JSON.stringify(['worker', 'custom-model', 'custom', '']), file + ': deliberately typed advanced model still saves');
  const button = dossier(); button.nodes['#ag-model-clear'].listeners.click();
  A.eq(JSON.stringify(button.saves[0]), JSON.stringify(['worker', '', '', '']), file + ': dedicated clear button clears the same identity');
}
for (const file of ['frontend/app/app.js', 'website/app/app/app.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const restore = source.match(/function rehydrateRoster\(savedAgents\) \{[\s\S]*?\n  \}/)[0];
  const agents = new Map();
  new Function('agents', 'agent', 'DATA', 'executionProfileOf', 'agentDocs', 'composeSystemPrompt', 'registerAgent', restore + '; rehydrateRoster(' + JSON.stringify([
    { id: 'inherited', model: null, provider: null, reasoningEffort: null },
    { id: 'legacy', model: '' },
    { id: 'pinned', model: 'fixture/byok', provider: 'openrouter', reasoningEffort: 'low' }
  ]) + ');')(agents, { model: 'fixture/managed', provider: 'starnet', reasoningEffort: 'high' }, { DEFAULT_SKIN: 'default' }, () => 'local', () => {}, () => '', () => {});
  for (const id of ['inherited', 'legacy']) {
    A.eq(agents.get(id).model, null, file + ': ' + id + ' stays unpinned after reload');
    A.eq(agents.get(id).provider, null, file + ': ' + id + ' does not acquire the managed provider on reload');
    A.eq(agents.get(id).reasoningEffort, null, file + ': ' + id + ' stays free of a pinned effort');
  }
  A.eq(agents.get('pinned').model, 'fixture/byok', file + ': explicit model survives reload');
  A.eq(agents.get('pinned').provider, 'openrouter', file + ': explicit provider survives reload');
  A.eq(agents.get('pinned').reasoningEffort, 'low', file + ': explicit effort survives reload');
}
A.report('agent-model-select.test');
