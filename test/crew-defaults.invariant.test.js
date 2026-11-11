'use strict';
/* node test/crew-defaults.invariant.test.js — LEANER CREW DEFAULTS (cost lanes W3.3 + W3.4, approved by Andrew 2026-11-08).

   ONE switch, STARNET_CREW_DEFAULTS, ships off. With it on ('lean'):
     W3.3 EFFORT. A crew run (a worker team.dispatch hands a task, a clone team.spawn starts, a line stage) whose effort is its
       class's applied default above medium runs at medium; the run after a failed verify (a review gate's revise verdict, a
       structured result that failed host validation) steps up one rung; a pinned high stays high, an unmarked effort is a pin, a
       class effort at or below medium is kept; claude-cli main runs still carry no --effort (W3.8 not chosen), so a claude-cli crew
       run sends none and its record says why ('unsent'). Every crew run's record says the effort it ran on (reasoningEffort) and
       why (effortRule).
     W3.4 MODEL. A summon of a balanced class preselects the base model's family mid-tier model and a fast class its small one,
       from the provider's own catalog, on the existing summon card (the model picker's inherit option and helper line).
   With it off: every request and record exactly as before (no effortRule, every crew request at its asked effort).

   Parts: A the pure module, and the station's read of the switch (index.js crewDefaultsMode over the real ENV(), compiled out
   of the source and run on fake environments); B one reader of the switch: production code names it once, as
   ENV('CREW_DEFAULTS') in the sidecar (its one env reader), the module never reads the environment, and every sidecar use
   asks crewDefaultsMode; C the page's summon path (app.js resolveTierModel / applyLoadout / effortSourceOf and the marketplace
   card's words, compiled out of the real files); D the real sidecar (SidecarFixture) with a fake OpenRouter endpoint that logs
   the reasoning effort every request carries, on and off: a class-marked crew lead the Commander talks to dispatches four
   workers and spawns a clone, the Overseer (a pin, as the page always marks it) spawns one, a drafter -> reviewer line is
   sent back once, and three class-high agents each crewing a bay of their own line run a routine: a TERMINAL one (runsLine
   false) pressed with Run Now, another fired by the clock, and one that runs its line (runsLine true); and E a fake Claude Code
   CLI. No network, no real CLI, no model spend.

   RED on agent/cost-stack 9896a5c44 (the base): the module does not exist, nothing reads the switch, a balanced summon keeps the
   copied model, and a class-high worker, clone and line stage all run at high with no effortRule on their records. RED on the
   lane's first review head (e6199f70c) too: its module read process.env itself, so a blank STARNET_ value fell through to
   SKYNET_=lean where ENV() keeps the blank, and no sidecar call read the switch through ENV(). RED on its second review head
   (afd220d69): a terminal routine, whose crate LINE WATCH stamps with its bay's line, ran as a line stage at medium with an
   effortRule saying 'line', though a terminal routine is not line work (Andrew's 08-07 ruling, the rule the line's budget cap
   reads: index.js capLine).

   CREW_DEFAULTS_DUMP=<file> writes the off arm's normalized crew request bodies (the base-vs-lane byte-identity evidence). */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
const { geometry } = require('./helpers/line-hold-rig.js');
const { decomment } = require('./helpers/decomment.js');
// the sidecar's own files as text through the source helper (the one reader of sidecar/ as text; never require index.js)
const { sidecarSourceFiles, readSidecarSource, sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source.js');

for (const k of Object.keys(process.env)) if (/^(STARNET|SKYNET)_CREW_DEFAULTS$/.test(k)) delete process.env[k];
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const one = list => Array.from(new Set(list));

/* ---- A. THE MODULE ------------------------------------------------------------------------------------------------------ */
let CD = null;
try { CD = require('../frontend/app/crewdefaults.js'); } catch (e) { A.ok(false, 'A: the crew defaults module exists (frontend/app/crewdefaults.js): ' + e.message); }
if (CD) {
  // the switch's VALUE, as the sidecar's ENV('CREW_DEFAULTS') read it, is handed to mode(): only the word "lean" turns it on
  A.eq([undefined, '', '  ', 'lean', ' LEAN ', 'on', 'off', 'leaner', null, 1, { STARNET_CREW_DEFAULTS: 'lean' }].map(v => CD.mode(v)),
    ['off', 'off', 'off', 'lean', 'lean', 'off', 'off', 'off', 'off', 'off', 'off'],
    'A: the switch: only "lean" turns it on; unset, blank, an unknown word, or anything that is not a value (an env object too: the module reads no environment) is off');
  // ...and the station reads that value through its one env reader: index.js crewDefaultsMode over the real ENV(), compiled out
  // of the source and run on fake environments. ENV()'s membership rule: a STARNET_ value that is set wins even when blank, else
  // the legacy SKYNET_ spelling (a blank STARNET_ with SKYNET_=lean is OFF, the case the first review caught)
  const ENVsrc = sidecarFunctionSource('ENV'), readSrc = sidecarFunctionSource('crewDefaultsMode');
  const stationMode = env => new Function('process', 'CrewDefaults', ENVsrc + '\n' + readSrc + '\nreturn crewDefaultsMode();')({ env }, CD);   // eslint-disable-line no-new-func
  let read = null;
  try { read = (readSrc && ENVsrc) ? [{}, { STARNET_CREW_DEFAULTS: 'lean' }, { SKYNET_CREW_DEFAULTS: 'lean' }, { STARNET_CREW_DEFAULTS: '', SKYNET_CREW_DEFAULTS: 'lean' },
    { STARNET_CREW_DEFAULTS: '  ', SKYNET_CREW_DEFAULTS: 'lean' }, { STARNET_CREW_DEFAULTS: 'off', SKYNET_CREW_DEFAULTS: 'lean' }, { STARNET_CREW_DEFAULTS: ' Lean ', SKYNET_CREW_DEFAULTS: 'off' }].map(stationMode) : null; }
  catch (e) { read = 'threw: ' + e.message; }
  A.eq(read, ['off', 'lean', 'lean', 'off', 'off', 'off', 'lean'],
    'A: the station reads the switch through ENV() (index.js crewDefaultsMode): unset is off, STARNET_ wins, SKYNET_ is the fallback, and a blank STARNET_ value wins over SKYNET_=lean');
  const rule = (o) => CD.effortRule(Object.assign({ mode: 'lean', surface: 'worker' }, o));
  A.eq(rule({ asked: 'high', source: 'class' }), { why: 'lean', want: 'medium' }, 'A: a class-applied high asks for medium');
  A.eq(rule({ asked: 'xhigh', source: 'class' }), { why: 'lean', want: 'medium' }, 'A: a class-applied xhigh asks for medium');
  A.eq(rule({ asked: 'high', source: 'class', retry: true }), { why: 'retry', want: 'high' }, 'A: after a failed verify, one rung up');
  A.eq(rule({ asked: 'max', source: 'class', retry: true }), { why: 'retry', want: 'high' }, 'A: one rung up from medium, not back to the class effort');
  A.eq(rule({ asked: 'high', source: 'pin' }), { why: 'pinned' }, 'A: a pinned high stays');
  A.eq(rule({ asked: 'high', source: '' }), { why: 'unmarked' }, 'A: an effort with no marker is a pin');
  A.eq([rule({ asked: 'medium', source: 'class' }), rule({ asked: 'low', source: 'class', retry: true })], [{ why: 'kept' }, { why: 'kept' }], 'A: a class effort at or below medium is kept, retry or not');
  A.eq([rule({ asked: 'high', source: 'class', mode: 'off' }), rule({ asked: 'high', source: 'class', surface: '' })], [null, null], 'A: off, or not a crew run: no rule');
  // the one clamp (AuxGovernor.clampEffort) moves an unlisted want UP; on a list without the asked rung that can pass it, and the
  // rule only ever lowers: such a rung is never sent (index.js crewEffort sends nothing and records 'unsent')
  A.eq(typeof CD.sendable === 'function' ? [CD.sendable('medium', 'high'), CD.sendable('high', 'high'), CD.sendable('low', 'medium'), CD.sendable('xhigh', 'high'),
    CD.sendable('max', 'xhigh'), CD.sendable(null, 'high'), CD.sendable('medium', '')] : null,
  ['medium', 'high', 'low', null, null, null, null], 'A: a clamped rung above the effort the run asked for is never sent');
  A.eq([CD.surfaceOf({ delegatedBy: 'agent', inRoster: true }), CD.surfaceOf({ delegatedBy: 'agent', inRoster: false }), CD.surfaceOf({ lineId: 'l1' }), CD.surfaceOf({})],
    ['worker', 'clone', 'line', ''], 'A: a delegated rostered agent is a worker, a delegated ephemeral one a clone, a run on a line a line stage');
  const CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5[1m]', 'opus', 'sonnet', 'haiku'];
  const pick = (tier, base, catalog) => CD.tierPick({ mode: 'lean', tier, base, catalog });
  A.eq([pick('balanced', 'claude-opus-5-5', CLAUDE), pick('fast', 'claude-opus-5-5', CLAUDE), pick('reasoning', 'claude-opus-5-5', CLAUDE)],
    ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', null], 'A: Claude: balanced -> the same version\'s Sonnet, fast -> the newest Haiku listed, reasoning -> no pick');
  A.eq([pick('balanced', 'claude-opus-5-5[1m]', CLAUDE), pick('fast', 'claude-opus-5-5[1m]', CLAUDE), pick('balanced', 'opus', CLAUDE)],
    ['claude-sonnet-5-5[1m]', null, 'sonnet'], 'A: a variant only picks the same variant, an alias only an alias');
  A.eq([pick('balanced', 'claude-sonnet-5-5', CLAUDE), pick('balanced', 'claude-haiku-4-5-20251001', CLAUDE)], [null, null], 'A: never the same tier again, never above the base');
  A.eq([pick('balanced', 'anthropic/claude-opus-4.8', ['anthropic/claude-opus-4.8', 'anthropic/claude-sonnet-4.6', 'claude-sonnet-5-5', 'anthropic/claude-haiku-4.5']),
    pick('fast', 'anthropic/claude-opus-4.8', ['anthropic/claude-opus-4.8', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5'])],
  ['anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5'], 'A: a router\'s vendor prefix is kept (never an id from another route)');
  A.eq([pick('balanced', 'gpt-5.5', ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']), pick('fast', 'gpt-5.5', ['gpt-5.5', 'gpt-5.4-mini'])],
    ['gpt-5.4-mini', null], 'A: GPT: balanced -> the newest -mini listed; no -nano listed -> no pick');
  A.eq([pick('balanced', 'openai/gpt-5.6-sol', ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna']), pick('fast', 'openai/gpt-5.6-sol', ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna'])],
    ['openai/gpt-5.6-terra', 'openai/gpt-5.6-luna'], 'A: GPT-5.6: sol -> terra (balanced), luna (fast)');
  A.eq([pick('balanced', 'gemini-2.5-pro', ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']), pick('fast', 'gemini-2.5-pro', ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'])],
    ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], 'A: Gemini: pro -> flash (balanced), flash-lite (fast)');
  A.eq([pick('balanced', 'gpt-6-astra', ['gpt-6-astra', 'gpt-5.4-mini']), pick('balanced', 'meta-llama/llama-3.3-70b-instruct', ['meta-llama/llama-3.1-8b-instruct']), pick('balanced', 'claude-opus-5-5', null)],
    [null, null, null], 'A: a family with no known tier, or no catalog, keeps today\'s choice');
  A.eq(CD.tierPick({ mode: 'off', tier: 'balanced', base: 'claude-opus-5-5', catalog: CLAUDE }), null, 'A: off: no pick');
}

/* ---- B. ONE READER OF THE SWITCH: the sidecar's ENV() (its one env reader, GitHub #105; the pattern of ENV('LEAN_CREW')) ---- */
{
  // every mention of the switch in production code, comments aside: each sidecar file through the source helper, the page's
  // and the shared contract's by walking them. The one allowed: ENV('CREW_DEFAULTS') in the sidecar.
  const mentions = [];
  const scan = (rel, text) => {
    const code = decomment(text);
    for (let at = code.indexOf('CREW_DEFAULTS'); at >= 0; at = code.indexOf('CREW_DEFAULTS', at + 1)) {
      const viaEnv = code.slice(at - 5, at) === "ENV('" && code.slice(at + 13, at + 15) === "')";
      mentions.push(rel + ': ' + (viaEnv ? "ENV('CREW_DEFAULTS')" : JSON.stringify(code.slice(Math.max(0, at - 24), at + 24))));
    }
  };
  for (const f of sidecarSourceFiles()) scan(f.rel, f.text);
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(rel); continue; }
      if (/\.(js|mjs|cjs)$/.test(e.name)) scan(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    }
  };
  for (const d of ['frontend/app', 'shared']) walk(d);
  A.eq(mentions, ["sidecar/index.js: ENV('CREW_DEFAULTS')"], 'B: production code names the switch once, as the sidecar\'s ENV(\'CREW_DEFAULTS\') (' + JSON.stringify(mentions) + ')');
  // the module is handed the value: it never reads the environment itself
  const mod = (() => { try { return decomment(fs.readFileSync(path.join(ROOT, 'frontend/app/crewdefaults.js'), 'utf8')); } catch (_) { return null; } })();
  A.ok(mod != null && !/\bprocess\b/.test(mod), 'B: frontend/app/crewdefaults.js never touches process (no env read of its own)');
  // the sidecar parses it in one place, crewDefaultsMode, and every use asks that reader
  const all = decomment(readSidecarSource());
  A.eq((all.match(/CrewDefaults\.mode\(/g) || []).length, 1, 'B: the sidecar calls CrewDefaults.mode once');
  A.ok(/CrewDefaults\.mode\(ENV\('CREW_DEFAULTS'\)\)/.test(sidecarFunctionSource('crewDefaultsMode')), 'B: …in crewDefaultsMode, on the value ENV(\'CREW_DEFAULTS\') read');
  for (const fn of ['crewEffort', 'handleAgentModel', 'handleProviders']) {
    A.ok(decomment(sidecarTopLevelFunction(fn)).indexOf('crewDefaultsMode()') >= 0, 'B: ' + fn + ' asks crewDefaultsMode() for the switch');
  }
  // the crew rule's line is the run's line WORK: runOnceCore's capLine, the one rule its line budget cap and its stage team read. A
  // terminal routine (runsLine false) is not line work though LINE WATCH stamps its crate with the bay's line (o.lineId), so crewEffort
  // is handed capLine and never reads o.lineId itself (the second review, 2026-11-09). D proves it on the wire.
  const core = decomment(sidecarTopLevelFunction('runOnceCore')), ce = decomment(sidecarTopLevelFunction('crewEffort'));
  A.ok(/\bcrewEffort\([^;]*,\s*capLine\)/.test(core), 'B: runOnceCore hands crewEffort capLine, the line-work rule its line budget cap reads');
  A.ok(/surfaceOf\(\{[^}]*\blineId\b/.test(ce) && !/\.lineId\b/.test(ce), 'B: crewEffort takes the line it is handed and never reads o.lineId (LINE WATCH\'s stamp)');
  A.ok(/require\('\.\.\/frontend\/app\/crewdefaults\.js'\)/.test(readSidecarSource()), 'B: the sidecar asks the one module');
  A.ok(/<script src="app\/crewdefaults\.js"><\/script>/.test(fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8')), 'B: the page loads the same module');
}

/* ---- C. THE PAGE'S SUMMON PATH (compiled out of app.js and marketplace.js) ------------------------------------------------ */
function appSection(o) {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/app/app.js'), 'utf8');
  const a = src.indexOf("  const TIER_MODELS_KEY = 'starnet.tierModels.v1';"), b = src.indexOf('  // a backend-valid, collision-free agentId for a summon', a);
  if (a < 0 || b <= a) throw new Error('C: the tier/loadout section moved in app.js');
  const tiers = new Map([['starnet.tierModels.v1', JSON.stringify(o.tierPins || {})]]);
  const scope = {
    localStorage: { getItem: k => tiers.get(k) || null, setItem: (k, v) => tiers.set(k, v) },
    Harness: { crewDefaults: () => o.mode, getModel: () => o.dockModel || '', getProv: () => o.dockProv || '' },
    ModelDock: { catalogIds: p => (o.catalogs && Object.prototype.hasOwnProperty.call(o.catalogs, p)) ? o.catalogs[p] : null },
    CrewDefaults: CD || undefined,
    Specialties: { get: id => (o.classes || {})[id] || null },
    stationDefaultWire: () => ({ model: '', provider: o.stationProv || '', effort: '' }),
    agent: o.agent || null
  };
  const names = ['resolveTierModel', 'applyLoadout', 'leanTierModelFor', 'effortSourceOf', 'noteEffortSource'];
  const body = src.slice(a, b) + '\nreturn {' + names.map(n => n + ': typeof ' + n + " === 'function' ? " + n + ' : null').join(', ') + '};';
  return vm.compileFunction(body, Object.keys(scope))(...Object.values(scope));
}
{
  const CATALOG = { anthropic: ['claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-sonnet-5-5'], openrouter: ['openai/gpt-6-astra'] };
  const hero = { id: 'agent', model: 'claude-opus-5-5', provider: 'anthropic', reasoningEffort: 'high' };
  const summon = (o, spec, pin) => {
    const S = appSection(Object.assign({ catalogs: CATALOG, agent: hero }, o));
    const a = { id: 'w1', model: (pin && pin.model) || (o.base || hero).model, provider: (pin && pin.provider) || (o.base || hero).provider,
      reasoningEffort: (pin && pin.effort) || hero.reasoningEffort };
    S.applyLoadout(a, spec, pin || null);
    return a;
  };
  const balanced = { id: 'writer', model: 'balanced', reasoningEffort: 'medium' }, fast = { id: 'scout', model: 'fast', reasoningEffort: 'low' };
  const deep = { id: 'engineer', model: 'reasoning', reasoningEffort: 'high' }, deepBalanced = { id: 'analyst', model: 'balanced', reasoningEffort: 'high' };
  A.eq([summon({ mode: 'lean' }, balanced).model, summon({ mode: 'lean' }, fast).model, summon({ mode: 'lean' }, deep).model],
    ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5'], 'C: on: a balanced summon preselects the family mid-tier, a fast one the small model, a reasoning one keeps the copy');
  A.eq([summon({ mode: 'off' }, balanced).model, summon({ mode: 'off' }, fast).model], ['claude-opus-5-5', 'claude-opus-5-5'], 'C: off: the copy, exactly as before');
  A.eq(summon({ mode: 'lean', tierPins: { balanced: 'my-own-model' } }, balanced).model, 'my-own-model', 'C: a SETTINGS tier pin still wins');
  A.eq(summon({ mode: 'lean' }, balanced, { model: 'claude-opus-5-5', provider: 'anthropic', effort: '' }).model, 'claude-opus-5-5', 'C: a model picked on the card wins');
  A.eq(summon({ mode: 'lean', base: { model: 'openai/gpt-6-astra', provider: 'openrouter' } }, balanced).model, 'openai/gpt-6-astra', 'C: an unknown family keeps today\'s choice');
  A.eq(summon({ mode: 'lean', catalogs: {} }, balanced).model, 'claude-opus-5-5', 'C: no catalog from the provider (never this page\'s offline seed): today\'s choice');
  const S = appSection({ mode: 'lean', catalogs: CATALOG, agent: hero });
  A.eq(S.leanTierModelFor ? [S.leanTierModelFor('balanced'), S.leanTierModelFor('fast'), S.leanTierModelFor('reasoning')] : null,
    ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', null], 'C: the card reads the same pick for the agent on the line');
  // W3.3 provenance: what the loadout wrote is the class's; a card pick is a pin; off writes no marker
  A.eq([summon({ mode: 'lean' }, deepBalanced).effortSource, summon({ mode: 'lean' }, deepBalanced, { model: '', provider: '', effort: 'high' }).effortSource, 'effortSource' in summon({ mode: 'off' }, deepBalanced)],
    ['class', 'pin', false], 'C: the class loadout marks its effort class, a card effort pick pin, and off writes no marker');
  const classes = { analyst: { id: 'analyst', reasoningEffort: 'high' } };
  const D = appSection({ mode: 'lean', catalogs: CATALOG, agent: hero, classes });
  const Doff = appSection({ mode: 'off', catalogs: CATALOG, agent: hero, classes });
  A.eq(D.effortSourceOf ? [D.effortSourceOf({ id: 'w2', specialtyId: 'analyst', reasoningEffort: 'high' }), D.effortSourceOf({ id: 'w3', specialtyId: 'analyst', reasoningEffort: 'xhigh' }),
    D.effortSourceOf({ id: 'agent', specialtyId: 'analyst', reasoningEffort: 'high' }), D.effortSourceOf({ id: 'w4', specialtyId: 'analyst', reasoningEffort: 'high', effortSource: 'pin' }),
    Doff.effortSourceOf({ id: 'w2', specialtyId: 'analyst', reasoningEffort: 'high', effortSource: 'class' })] : null,
  [{ effortSource: 'class' }, { effortSource: 'pin' }, { effortSource: 'pin' }, { effortSource: 'pin' }, {}],
  'C: existing crew: an effort equal to the class default is the class\'s, anything else a pin, the Overseer\'s is its own, a marker wins, off sends none');
  // the summon card names the pick on the picker's inherit option and the helper line (marketplace.js, compiled)
  const msrc = fs.readFileSync(path.join(ROOT, 'frontend/app/marketplace.js'), 'utf8');
  const ma = msrc.indexOf('  function modelHelpHTML(s) {'), mb = msrc.indexOf('  // ONE section-header component', ma);
  if (ma < 0 || mb <= ma) A.ok(false, 'C: the summon card helpers moved in marketplace.js');
  else {
    const card = (lean, tierPin) => vm.compileFunction(msrc.slice(ma, mb) + "\nreturn { help: modelHelpHTML, label: typeof inheritLabelOf === 'function' ? inheritLabelOf : null };",
      ['App', 'pickedSummonModel', 'esc', 'clearanceLabel'])({ tierModelFor: () => tierPin || null, leanTierModelFor: () => lean }, null, s => String(s), m => String(m).toUpperCase());
    const on = card('claude-sonnet-5-5', null), off = card(null, null);
    A.eq(on.label ? [on.label(balanced), off.label(balanced)] : null, ['Use the balanced tier model (claude sonnet 5 5)', 'Copy the model of the agent on the line'],
      'C: the card\'s model picker says what an untouched pick gives the recruit');
    A.ok(/uses <b>claude sonnet 5 5<\/b>, the <b>balanced<\/b> tier model in the family of the agent on the line\./.test(on.help(balanced)), 'C: and its helper line names the tier model: ' + on.help(balanced));
    A.ok(/Copies the model of the agent on the line now/.test(off.help(balanced)), 'C: off: the helper line is the one from before');
  }
}

/* ---- D. THE STATION, ON AND OFF (fake OpenRouter: every request's reasoning effort is on the wire) --------------------------- */
const MODEL = 'run/model';
const REVISE = 'not yet\nVERDICT: revise', APPROVED = 'Reads right now.\nVERDICT: approved';
const SCHEMA = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
function startWire() {
  const calls = [];
  let reviews = 0, drafts = 0;
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'] }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) {}
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const sys = JSON.stringify((msgs.find(m => m && m.role === 'system') || {}).content || '');
        const users = msgs.filter(m => m && m.role === 'user');
        const firstUser = JSON.stringify(users.length ? users[0].content : ''), lastUser = JSON.stringify(users.length ? users[users.length - 1].content : '');
        let probe = (sys.match(/CREW_PROBE:([a-z0-9-]+)/) || [])[1] || '';
        // a clone runs on its lead's own identity: the crew lead's clone, or the Overseer's
        if ((probe === 'lead' || probe === 'agent') && firstUser.indexOf('CLONE_TASK') >= 0) probe = probe === 'lead' ? 'clone' : 'agent-clone';
        if (probe && lastUser.indexOf('[STRUCTURED RESULT REPAIR]') >= 0) probe += '-repair';
        const main = raw.indexOf('[RUNTIME]') >= 0 || /-repair$/.test(probe);
        const effort = body.reasoning ? (body.reasoning.effort || null) : null;
        const results = msgs.filter(m => m && m.role === 'tool');
        const offered = JSON.stringify(body.tools || []);
        calls.push({ probe: main ? probe : '', effort, body: main && probe ? raw : '', tools: (body.tools || []).map(t => (t && t.function && t.function.name) || '').filter(Boolean) });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
        const say = text => { send({ choices: [{ delta: { content: text } }] }); send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 } }); };
        if (main && probe === 'lead' && !results.length && offered.indexOf('team_dispatch') >= 0 && offered.indexOf('team_spawn') >= 0) {
          send({ choices: [{ delta: { tool_calls: [
            { index: 0, id: 'call_dispatch', type: 'function', function: { name: 'team_dispatch', arguments: JSON.stringify({ workers: [
              { agentId: 'w-class', prompt: 'Write up the staging rollback in one JSON summary.', resultSchema: SCHEMA },
              { agentId: 'w-pin', prompt: 'Write up the staging rollback.' }, { agentId: 'w-old', prompt: 'Write up the staging rollback.' },
              { agentId: 'w-low', prompt: 'Write up the staging rollback.' }] }) } },
            { index: 1, id: 'call_spawn', type: 'function', function: { name: 'team_spawn', arguments: JSON.stringify({ tasks: [{ prompt: 'CLONE_TASK: list the rollback steps.', label: 'steps' }] }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 } });
        } else if (main && probe === 'agent' && !results.length && offered.indexOf('team_spawn') >= 0) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_spawn_overseer', type: 'function', function: { name: 'team_spawn',
            arguments: JSON.stringify({ tasks: [{ prompt: 'CLONE_TASK: check the rollback steps.', label: 'check' }] }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 } });
        } else if (main && (probe === 'lead' || probe === 'agent')) say('Handed off.');
        else if (main && probe === 'w-class') say('Here is the summary in prose, not JSON.');
        else if (main && probe === 'w-class-repair') say(JSON.stringify({ summary: 'The staging rollback path was rebuilt.' }));
        else if (main && probe === 'reviewer') say(reviews++ === 0 ? REVISE : APPROVED);
        else if (main && probe === 'drafter') say('Draft ' + (++drafts) + ' of the rollback note.');
        else say(main ? 'Done: the rollback is written up.' : 'nothing durable.');
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}
const QUIET = { STARNET_LIVE_PRICES: '0', STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0',
  STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '',
  SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0' };
const row = (agentId, effort, source) => Object.assign({ agentId, name: agentId.toUpperCase().replace(/-/g, ' '), system: 'CREW_PROBE:' + agentId + ': you are ' + agentId + '.',
  provider: 'openrouter', model: MODEL, reasoningEffort: effort, role: agentId === 'agent' ? '' : 'specialist' }, source ? { effortSource: source } : {});
// the Overseer is marked as the page always marks it (a pin: its effort is the Commander's own dial, app.js effortSourceOf);
// 'lead' is a class-marked crew member the Commander talks to directly, so it leads: it dispatches the workers and spawns a clone
const CREW = [row('agent', 'high', 'pin'), row('lead', 'high', 'class'), row('w-class', 'high', 'class'), row('w-pin', 'high', 'pin'), row('w-old', 'high'),
  row('w-low', 'low', 'class'), row('drafter', 'high', 'class'), row('reviewer', 'high', 'class')];
// ROUTINES (the second review, 2026-11-09): three class-high agents, each crewing the one bay of a line of its own (INBOX > bay > OUTBOX), so
// LINE WATCH stamps each routine's crate with that line. Only a routine that RUNS its line (runsLine) is line work (Andrew's 08-07 ruling)
const ROUTINES = [
  { agentId: 'r-now', dockId: 'bN', runsLine: false, via: 'press', name: 'Morning report', prompt: 'Write the morning report.' },
  { agentId: 'r-tick', dockId: 'bT', runsLine: false, via: 'clock', name: 'Evening digest', prompt: 'Write the evening digest.' },
  { agentId: 'r-line', dockId: 'bL', runsLine: true, via: 'press', name: 'Intake note', prompt: 'Write the intake note.' }];
const ROUTINE_CREW = ROUTINES.map(r => row(r.agentId, 'high', 'class'));
const ROUTINE_FLOOR = {
  props: [].concat(...ROUTINES.map((r, i) => [{ id: 'i' + r.dockId.slice(1), t: 'intake', x: 0, y: 3 * i, w: 1, h: 1 },
    { id: r.dockId, t: 'bay', x: 3, y: 3 * i, w: 1, h: 1, agentId: r.agentId }, { id: 'o' + r.dockId.slice(1), t: 'outbox', x: 6, y: 3 * i, w: 1, h: 1 }])),
  belts: [].concat(...ROUTINES.map((r, i) => [1, 2, 4, 5].map(x => ({ x, y: 3 * i, dir: 'E' }))))
};
// the volatile bytes of a request body (ids, clocks, paths, ports), so the off arm's bodies compare across two trees
function normalized(raw, f) {
  let s = String(raw || '');
  for (const p of [f.workspace, f.workspace.replace(/\\/g, '\\\\'), f.workspace.replace(/\\/g, '/')]) if (p) s = s.split(p).join('<WS>');
  return s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?\b/g, '<TS>').replace(/\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?\b/gi, '<CLOCK>')
    .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? [A-Z][a-z]+ \d{1,2},? \d{4}\b/g, '<DATE>').replace(/\b\d{10,}\b/g, '<N>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>').replace(/\b(job|run|smp|sub|wi|sess|stream)[-_][A-Za-z0-9_-]{6,}/g, '$1-<ID>').replace(/\b[0-9a-f]{12,}\b/g, '<HEX>');
}

async function stationArm(mode) {
  const wire = await startWire();
  // the routine tick at 100ms, so a routine due in a second fires on the clock inside the arm (the scheduler stays off until armed below)
  const env = Object.assign({}, QUIET, { SKYNET_OPENROUTER_BASE: wire.base, STARNET_OPENROUTER_KEY: 'sk-or-v1-crewdefaults-fixture',
    STARNET_CRON_TICK_MS: '100', SKYNET_CRON_TICK_MS: '100' }, mode ? { STARNET_CREW_DEFAULTS: mode } : {});
  const f = SidecarFixture.create({ prefix: 'sk-crewdefaults-' + (mode || 'off') + '-', timeoutMs: 90000, env });
  const tag = (mode || 'off') + ': ';
  const settle = async () => {
    let last = -1, since = Date.now();
    for (const until = Date.now() + 20000; Date.now() < until;) {
      const n = wire.calls.length;
      if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= 1500) return;
      await sleep(150);
    }
  };
  try {
    seedActiveStation(f.workspace);
    await f.start();
    await f.json('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    const providers = await f.json('GET', '/api/providers');
    A.eq(providers.body && providers.body.crewDefaults, mode === 'lean' ? 'lean' : undefined, tag + 'GET /api/providers names the switch only while it is on');
    const pushed = await f.json('POST', '/api/roster', { agents: CREW, updatedAt: Date.now() });
    A.eq(pushed.status, 200, tag + 'fixture: the crew is on the roster (the page sends the markers while the switch is on; this arm sends them either way)');
    await sleep(500);   // the catalog warms: run/model takes a reasoning field (OpenRouter's ladder, none..max)

    // DISPATCH + SPAWN: the crew lead (class high) hands four workers a task and starts one clone; then the Overseer (a pin)
    // starts one clone of its own
    const lead = async (agentId, text) => {
      const r = await f.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, provider: 'openrouter', model: MODEL,
        reasoningEffort: 'high', isTask: true, system: CREW.find(c => c.agentId === agentId).system, placed: [], messages: [{ role: 'user', content: text }] }) });
      const raw = await r.text();
      A.eq(r.status, 200, tag + 'fixture: ' + agentId + '\'s run opened' + (r.status === 200 ? '' : ': ' + raw.slice(0, 200)));
      await settle();
    };
    await lead('lead', 'Have the crew write up the staging rollback path.');
    await lead('agent', 'Have a helper check the rollback steps.');
    // LINE: drafter -> reviewer -> a review gate that sends the first draft back once
    const published = await publishFloor({ json: (m, u, b) => f.json(m, u, b) }, floorOf(geometry({ maxIter: 4 }, 'esc unwired')), { label: tag + 'the review line' });
    const line = published.plan.lineOfProp.p1;
    const sample = await f.json('POST', '/api/routing/sample', { line, text: 'Write the rollback note.', name: 'Rollback note' });
    A.eq([sample.status, sample.body && sample.body.delivered && sample.body.delivered.agentId], [200, 'reviewer'], tag + 'fixture: the line delivered after one revise (' + JSON.stringify(sample.body && sample.body.stop) + ')');
    await settle();
    // ROUTINES: the routine agents join the crew, each on the bay of a line of its own; two routines are pressed (Run Now), one fires on the clock
    A.eq((await f.json('POST', '/api/roster', { agents: CREW.concat(ROUTINE_CREW), updatedAt: Date.now() })).status, 200, tag + 'fixture: the routine agents join the crew');
    const bays = await publishFloor({ json: (m, u, b) => f.json(m, u, b) }, floorOf(ROUTINE_FLOOR), { label: tag + 'the routine bays' });
    const lineOfBay = Object.fromEntries(ROUTINES.map(r => [r.agentId, (bays.plan.lineOfProp || {})[r.dockId] || null]));
    const saveRoutine = async (r, schedule) => {
      const c = await f.json('POST', '/api/cron', { name: r.name, prompt: r.prompt, schedule, agentId: r.agentId, dockId: r.dockId, model: MODEL, provider: 'openrouter', runsLine: r.runsLine });
      A.ok(c.status === 200 && !!(c.body && c.body.job && c.body.job.id) && !c.body.duplicate, tag + 'fixture: ' + r.agentId + '\'s routine is saved (' + c.status + ' ' + String(c.text || '').slice(0, 160) + ')');
      return (c.body && c.body.job) || {};
    };
    for (const r of ROUTINES.filter(x => x.via === 'press')) {
      const job = await saveRoutine(r, 'every 1h');
      const ran = await f.json('POST', '/api/cron/run', { id: job.id });
      A.eq(ran.status, 200, tag + 'fixture: ' + r.agentId + '\'s routine ran on Run Now' + (ran.status === 200 ? '' : ': ' + String(ran.text || '').slice(0, 200)));
      await settle();
    }
    for (const r of ROUTINES.filter(x => x.via === 'clock')) {
      const job = await saveRoutine(r, 'in 1s');
      let fired = null;
      await f.json('POST', '/api/cron/arm', { enabled: true });
      try {
        for (const until = Date.now() + 30000; !fired && Date.now() < until;) {
          fired = ((((await f.json('GET', '/api/cron')).body) || {}).jobs || []).find(j => j && j.id === job.id && j.lastStatus) || null;
          if (!fired) await sleep(150);
        }
      } finally { await f.json('POST', '/api/cron/arm', { enabled: false }); }
      A.ok(!!fired, tag + 'fixture: ' + r.agentId + '\'s routine fired on the clock (' + JSON.stringify(fired && fired.lastStatus) + ')');
      await settle();
    }

    const runs = ((await f.json('GET', '/api/runs?agent=*&limit=200')).body || {}).runs || [];
    const efforts = p => wire.calls.filter(c => c.probe === p).map(c => c.effort);
    const recs = id => runs.filter(x => x.agentId === id).sort((a, b) => (a.startedAt || a.ts || 0) - (b.startedAt || b.ts || 0));
    // a clone (team.spawn's ephemeral 'sub-' agent) is never on the roster; it runs delegated by the lead that started it
    const clonesOf = id => runs.filter(x => x.delegatedBy === id && !CREW.some(c => c.agentId === x.agentId)).sort((a, b) => (a.startedAt || a.ts || 0) - (b.startedAt || b.ts || 0));
    if (process.env.CREW_DEFAULTS_DEBUG) console.error(JSON.stringify({ mode, leadTools: (wire.calls.find(c => c.probe === 'lead') || {}).tools, calls: wire.calls.map(c => [c.probe, c.effort]), runs: runs.map(x => [x.agentId, x.reasoningEffort, x.effortRule, x.lineId || '', x.delegatedBy || '']) }));
    A.ok(efforts('lead').length >= 2 && efforts('w-class').length && efforts('w-class-repair').length && efforts('w-pin').length && efforts('w-old').length && efforts('w-low').length && efforts('clone').length
      && efforts('agent').length >= 2 && efforts('agent-clone').length,
      tag + 'fixture: the crew lead delegated, every worker and both clones ran, and the class worker\'s prose answer was sent for repair (' + JSON.stringify(one(wire.calls.map(c => c.probe))) + ')');
    A.eq([clonesOf('lead').length, clonesOf('agent').length], [1, 1], tag + 'fixture: one clone of each lead on the records');
    A.eq([efforts('drafter').length, efforts('reviewer').length], [2, 2], tag + 'fixture: the line ran the draft and the review twice (one revise)');
    A.eq([one(efforts('lead')), one(efforts('agent'))], [['high'], ['high']], tag + 'a lead\'s own run is not crew: the crew lead and the Overseer keep their high');
    // each routine reached the wire once and left one record naming its routine and, LINE WATCH, its own bay's line (the case under test)
    A.eq(ROUTINES.map(r => efforts(r.agentId).length), [1, 1, 1], tag + 'fixture: each routine ran once (' + JSON.stringify(ROUTINES.map(r => efforts(r.agentId))) + ')');
    A.eq(ROUTINES.map(r => { const x = recs(r.agentId)[0] || {}; return [recs(r.agentId).length, !!x.cronJobId, !!lineOfBay[r.agentId] && x.lineId === lineOfBay[r.agentId]]; }),
      ROUTINES.map(() => [1, true, true]), tag + 'fixture: each routine\'s record names its routine and its bay\'s line (' + JSON.stringify(ROUTINES.map(r => [lineOfBay[r.agentId], (recs(r.agentId)[0] || {}).lineId])) + ')');

    if (mode === 'lean') {
      A.eq(efforts('w-class'), ['medium'], 'lean: a class-high WORKER runs at medium');
      A.eq(efforts('w-class-repair'), ['high'], 'lean: its repair after the failed host check steps up one rung (high)');
      A.eq([one(efforts('w-pin')), one(efforts('w-old')), one(efforts('w-low'))], [['high'], ['high'], ['low']], 'lean: a pinned high stays high, an unmarked high is a pin, a class low is kept');
      A.eq(one(efforts('clone')), ['medium'], 'lean: a CLONE of a class-high crew lead runs at medium');
      A.eq(one(efforts('agent-clone')), ['high'], 'lean: a clone of the Overseer keeps its high (the Overseer\'s effort is a pin)');
      A.eq(efforts('drafter'), ['medium', 'high'], 'lean: a class-high LINE STAGE runs at medium, and its pass after the review sent it back at high');
      A.eq(efforts('reviewer'), ['medium', 'high'], 'lean: the review in that failed pass runs at high too');
      const rec = id => recs(id)[0] || {};
      const rule = x => x && x.effortRule;
      A.eq([rec('w-class').reasoningEffort, rule(rec('w-class'))], ['medium', { surface: 'worker', source: 'class', asked: 'high', why: 'lean', sent: 'medium' }], 'lean: the worker\'s record says medium, and why');
      const repairRec = recs('w-class')[1] || {};
      A.eq([repairRec.reasoningEffort, rule(repairRec)], ['high', { surface: 'worker', source: 'class', asked: 'high', why: 'retry', sent: 'high' }], 'lean: the repair\'s record says high, a retry');
      A.eq([rule(rec('w-pin')), rule(rec('w-old')), rule(rec('w-low'))], [{ surface: 'worker', source: 'pin', asked: 'high', why: 'pinned' }, { surface: 'worker', source: 'unmarked', asked: 'high', why: 'unmarked' },
        { surface: 'worker', source: 'class', asked: 'low', why: 'kept' }], 'lean: a pin, an unmarked row and a kept class effort each say why nothing changed');
      A.eq([rec('w-pin').reasoningEffort, rec('w-old').reasoningEffort], ['high', 'high'], 'lean: and ran on high');
      A.eq(clonesOf('lead').map(x => [x.reasoningEffort, rule(x)]), [['medium', { surface: 'clone', source: 'class', asked: 'high', why: 'lean', sent: 'medium' }]], 'lean: the crew lead\'s clone\'s record');
      A.eq(clonesOf('agent').map(x => [x.reasoningEffort, rule(x)]), [['high', { surface: 'clone', source: 'pin', asked: 'high', why: 'pinned' }]], 'lean: the Overseer\'s clone\'s record');
      A.eq(recs('drafter').map(x => [x.reasoningEffort, rule(x) && rule(x).surface, rule(x) && rule(x).why]), [['medium', 'line', 'lean'], ['high', 'line', 'retry']], 'lean: the drafter\'s records');
      A.eq(recs('reviewer').map(x => [x.reasoningEffort, rule(x) && rule(x).why]), [['medium', 'lean'], ['high', 'retry']], 'lean: the reviewer\'s records');
      A.ok(recs('lead').length && recs('agent').length && !rule(rec('lead')) && !rule(rec('agent')), 'lean: a lead\'s own record carries no crew rule');
      // ROUTINES: a TERMINAL routine (runsLine false) is not line work, though LINE WATCH names its bay's line (Andrew's 08-07 ruling, the
      // rule the line's budget cap reads): pressed or fired by the clock, it is no crew run, keeps its high, and its record carries no rule
      A.eq([efforts('r-now'), efforts('r-tick')], [['high'], ['high']], 'lean: a TERMINAL routine on a class-high bay agent keeps its high, on Run Now and on the clock');
      A.eq(['r-now', 'r-tick'].map(id => [rec(id).reasoningEffort, rule(rec(id)) || null]), [['high', null], ['high', null]], 'lean: …and its record says high, with no crew rule');
      A.eq([efforts('r-line'), rec('r-line').reasoningEffort, rule(rec('r-line'))], [['medium'], 'medium', { surface: 'line', source: 'class', asked: 'high', why: 'lean', sent: 'medium' }],
        'lean: a routine that RUNS its line (runsLine) is a line stage: its entry run asks for medium, and its record says why');
      const saved = JSON.parse(fs.readFileSync(path.join(f.workspace, 'agent.roster.json'), 'utf8'));
      const savedRow = id => ((saved && saved.agents) || []).find(x => x.agentId === id) || {};
      A.eq([savedRow('w-class').effortSource, savedRow('w-pin').effortSource, 'effortSource' in savedRow('w-old')], ['class', 'pin', false], 'lean: the roster keeps each row\'s marker where its settings live');
    } else {
      for (const p of ['w-class', 'w-class-repair', 'w-pin', 'w-old', 'clone', 'agent-clone', 'drafter', 'reviewer', 'r-now', 'r-tick', 'r-line']) A.eq(one(efforts(p)), ['high'], 'off: ' + p + ' asks for its high, exactly as before');
      A.eq(one(efforts('w-low')), ['low'], 'off: w-low asks for its low');
      A.eq(runs.filter(x => 'effortRule' in x).length, 0, 'off: no record carries an effortRule');
      if (process.env.CREW_DEFAULTS_DUMP) {
        const order = ['lead', 'w-class', 'w-class-repair', 'w-pin', 'w-old', 'w-low', 'clone', 'agent', 'agent-clone', 'drafter', 'reviewer', 'r-now', 'r-tick', 'r-line'];
        const bodies = order.map(p => ({ probe: p, bodies: wire.calls.filter(c => c.probe === p && c.body).map(c => normalized(c.body, f)).sort() }));
        fs.writeFileSync(process.env.CREW_DEFAULTS_DUMP, JSON.stringify(bodies, null, 1));
      }
    }
  } finally { await f.dispose(); await new Promise(r => wire.server.close(r)); }
}

/* ---- E. CLAUDE CODE: a class-high line stage on claude-cli. The CLI takes an effort only per request (--effort) and a main run
   there sends none (W3.8 not chosen): the rule sends nothing, the stage runs on the CLI's own default, and its record says so. -- */
const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
let system = '';
try { const p = val('--system-prompt-file'); system = p ? fs.readFileSync(p, 'utf8') : ''; } catch (_) {}
const probe = (system.match(/CREW_PROBE:([a-z0-9-]+)/) || [])[1] || '';
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ probe, effort: val('--effort'), hasEffortFlag: args.indexOf('--effort') >= 0 }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  const text = probe ? 'The rollback note, written.' : 'nothing durable.';
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } });
});
`;
async function cliArm() {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-crewdefaults-cli-'));
  const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
  const shim = path.join(fakeRoot, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
  const logFile = path.join(fakeRoot, 'calls.log');
  fs.writeFileSync(logFile, '');
  const home = path.join(fakeRoot, 'home');
  fs.mkdirSync(home);
  const f = SidecarFixture.create({ prefix: 'sk-crewdefaults-cli-', timeoutMs: 90000, env: Object.assign({}, QUIET, {
    HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: logFile, STARNET_CLAUDE_CLI_PERSIST: '0', STARNET_CREW_DEFAULTS: 'lean' }) });
  try {
    seedActiveStation(f.workspace);
    await f.start();
    await f.json('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    const st = await f.json('GET', '/api/auth/claude-cli/status');
    A.eq([st.status, st.body && st.body.installed, st.body && st.body.loggedIn], [200, true, true], 'cli: fixture: the fake CLI is installed and signed in');
    A.eq((await f.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'ADA', provider: 'claude-cli', model: 'haiku', reasoningEffort: null },
      { agentId: 'cli-stage', name: 'WRITER', system: 'CREW_PROBE:cli-stage: you write things up.', provider: 'claude-cli', model: 'claude-opus-5-5', reasoningEffort: 'high', effortSource: 'class', role: 'specialist' }] })).status,
    200, 'cli: fixture: a class-high stage on the Claude sign-in');
    const published = await publishFloor({ json: (m, u, b) => f.json(m, u, b) }, floorOf({ props: [{ id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'p2', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'cli-stage' }, { id: 'p3', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) }), { label: 'cli: the one-stage line' });
    const sample = await f.json('POST', '/api/routing/sample', { line: published.plan.lineOfProp.p1, text: 'Write the rollback note.', name: 'Rollback note' });
    A.eq(sample.status, 200, 'cli: fixture: the line ran (' + JSON.stringify(sample.body && sample.body.stop) + ')');
    const spawns = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => c.probe === 'cli-stage');
    const rec = ((((await f.json('GET', '/api/runs?agent=cli-stage&limit=20')).body || {}).runs) || [])[0] || {};
    A.ok(spawns.length >= 1, 'cli: fixture: the stage spawned the CLI');
    A.eq(one(spawns.map(c => c.hasEffortFlag)), [false], 'cli: a claude-cli crew run still carries no --effort (W3.8 not chosen)');
    A.eq([rec.reasoningEffort, rec.effortRule], ['cli-default', { surface: 'line', source: 'class', asked: 'high', why: 'unsent' }], 'cli: its record says it ran on the CLI default, and that the rule sent nothing');
  } finally { await f.dispose(); try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {} }
}

(async () => {
  const only = String(process.env.CREW_DEFAULTS_ARMS || '').split(',').filter(Boolean);   // (debugging: run some arms)
  for (const arm of [['off', () => stationArm('')], ['lean', () => stationArm('lean')], ['cli', cliArm]]) {
    if (only.length && only.indexOf(arm[0]) < 0) continue;
    try { await arm[1](); } catch (e) { A.ok(false, arm[0] + ' arm threw: ' + ((e && e.stack) || e)); }
  }
  A.report('crew-defaults.invariant.test');
})().catch(e => { console.log('FAIL: crew-defaults.invariant.test threw - ' + ((e && e.stack) || e)); process.exit(1); });
