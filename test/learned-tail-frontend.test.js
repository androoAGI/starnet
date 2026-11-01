/* node test/learned-tail-frontend.test.js — issue #105, the app half, by BEHAVIOUR. app.js is a browser-flow module (not node-loadable), so
   the real source of composeSystemPrompt, recomposeAllPrompts, the boot's closing sequence and the fork-gate subscriber are cut out
   and EXECUTED over stubs, with the real Dossier and Fork engines. A regex over the source let "recompose only the focused agent" and
   `if (false)` survive; running the code does not.

   The relaunch bug this holds: crew rehydrate before the dossier and the understanding read exist. If the boot does not recompose the
   whole crew afterwards, a worker's pushed prompt has no dossier and carries a fork block its confidence never earned. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const Dossier = require('../frontend/app/dossier.js');
const Fork = require('../frontend/app/fork.js');
const { split } = require('../sidecar/learned-tail.js');

const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
function fnSource(name) {
  const at = app.indexOf('function ' + name + '(');
  A.ok(at >= 0, name + ' found');
  const nl = app.indexOf('\n  }\n', at);   // these are two-space-indented functions of the app closure
  return app.slice(at, nl + 4);
}
function between(a, b) {
  const s = app.indexOf(a), e = app.indexOf(b, s);
  A.ok(s >= 0 && e > s, 'found the block from: ' + a);
  return app.slice(s, e);
}

function station() {
  const calls = [];
  let dossierReady = false;
  const dossier = Dossier.fresh();
  Dossier.upsert(dossier, 'style', { text: 'prefers terse replies' }, 1000);
  let conf = 0.2;
  const deps = {
    agents: new Map(), calls,
    agentDocs: a => a.docs,
    baseIdentity: n => 'You are ' + n + '.',
    rosterClause: () => '', foundationClause: () => '', approvalClause: () => '',
    Personas: { DEFAULT_ID: 'x', compose: () => '' },
    DossierStore: { composeBlock: () => (dossierReady ? Dossier.composeBlock(dossier, {}) : '') },
    Fork: { shouldOffer: Fork.shouldOffer, directive: Fork.directive },
    // before its init the read has nothing behind it, which reads as low confidence: the fork block's false positive
    UnderstandingStore: { read: () => ({ dims: { style: { conf: dossierReady ? conf : 0 } } }) },
    Chat: { setSystem: s => calls.push(['setSystem', s]) },
    pushRoster: () => calls.push(['pushRoster', snapshot()]),
    syncChannels: () => calls.push(['syncChannels', snapshot()]),
    persist: () => calls.push(['persist'])
  };
  const snapshot = () => Array.from(deps.agents.values()).map(a => [a.id, a.systemPrompt]);
  const body = fnSource('composeSystemPrompt') + '\n' + fnSource('recomposeAllPrompts') + '\nlet agent = null;\nreturn { composeSystemPrompt, recomposeAllPrompts, setAgent(a) { agent = a; }, getAgent() { return agent; },'
    + ' boot() {' + between('// ONE BOOT COMPOSE (issue #105)', 'renderRail();') + '} };';
  const keys = Object.keys(deps);
  const X = new Function(...keys, body)(...keys.map(k => deps[k]));
  const add = (id, name) => { const a = { id, name, docs: { identity: 'You are ' + name + '.' } }; a.systemPrompt = X.composeSystemPrompt(a); deps.agents.set(id, a); return a; };
  return { X, deps, calls, add, dossierUp() { dossierReady = true; }, setConf(c) { conf = c; }, a: id => deps.agents.get(id) };
}

// ---- the learned blocks close the persona, so the sidecar can cut them off ----
{
  const s = station();
  s.dossierUp();
  const a = s.add('agent', 'Ada');
  const parts = split(a.systemPrompt);
  A.eq(parts.stable, 'You are Ada.\n\nYou have not yet been given a purpose — you are eager for your Commander to assign one.', 'the stable half holds no learned state');
  A.ok(parts.learned.includes('prefers terse replies') && parts.learned.includes('MID-TASK PREFERENCE FORK'), 'the dossier and the fork block are both in the learned half');
  s.setConf(0.9);
  A.eq(split(s.X.composeSystemPrompt(a)).stable, parts.stable, 'a fork flip does not move the stable half');
  A.ok(!s.X.composeSystemPrompt(a).includes('MID-TASK PREFERENCE FORK'), 'and the block retires');
}

// ---- FE1, FE2: the relaunch. Workers composed early are corrected by the boot, and the roster and channels get the corrected prompts ----
{
  const s = station();
  const lead = s.add('agent', 'Ada'), worker = s.add('w1', 'Bea');
  A.ok(!worker.systemPrompt.includes('prefers terse replies'), 'fixture: a worker composed at rehydrate has no dossier');
  A.ok(worker.systemPrompt.includes('MID-TASK PREFERENCE FORK'), 'fixture: and an unearned fork block');
  s.dossierUp();
  s.setConf(0.9);
  s.X.setAgent(lead);
  lead.systemPrompt = s.X.composeSystemPrompt(lead);   // the old boot stopped here: only the focused agent
  s.X.boot();
  A.ok(worker.systemPrompt.includes('prefers terse replies'), 'FE1: the boot recomposes the worker too: the dossier is back');
  A.ok(!worker.systemPrompt.includes('MID-TASK PREFERENCE FORK'), 'FE1: and the unearned fork block is gone');
  const names = s.calls.map(c => c[0]);
  const channels = s.calls.find(c => c[0] === 'syncChannels'), roster = s.calls.find(c => c[0] === 'pushRoster');
  A.ok(channels && roster, 'FE2: the boot pushes the channels and the roster');
  A.ok(channels[1].every(([, p]) => p.includes('prefers terse replies')), 'item 9: Telegram gets the recomposed prompt');
  A.ok(roster[1].every(([, p]) => p.includes('prefers terse replies') && !p.includes('MID-TASK PREFERENCE FORK')), 'FE2: the sidecar roster gets the recomposed prompts');
  A.ok(names.includes('setSystem'), 'the focused live session follows');
  const once = worker.systemPrompt;
  s.X.boot();
  A.eq(worker.systemPrompt, once, 'same inputs, same prompt: a second boot changes no byte');
}

// ---- FE4, FE5: a fork-gate flip reaches the whole crew and the sidecar, and the first read is only a baseline ----
{
  const s = station();
  s.dossierUp();
  const lead = s.add('agent', 'Ada'), worker = s.add('w1', 'Bea');
  A.ok(worker.systemPrompt.includes('MID-TASK PREFERENCE FORK'), 'fixture: low confidence, the block is on');
  let listener = null;
  const block = between("if (typeof UnderstandingStore !== 'undefined' && typeof Fork !== 'undefined' && UnderstandingStore.subscribe) {", '// G1c MAINTENANCE-QUEST GENERATOR');
  const understanding = { subscribe(fn) { listener = fn; } };
  const body = fnSource('composeSystemPrompt') + '\n' + fnSource('recomposeAllPrompts') + '\nlet agent = focused;\n' + block;
  const deps = Object.assign({}, s.deps, { UnderstandingStore: Object.assign({}, s.deps.UnderstandingStore, understanding), focused: lead });
  const keys = Object.keys(deps);
  new Function(...keys, body)(...keys.map(k => deps[k]));
  A.eq(typeof listener, 'function', 'the block subscribed');
  const read = c => ({ dims: { style: { conf: c } } });
  listener(read(0.2));
  A.eq(s.calls.filter(c => c[0] === 'pushRoster').length, 0, 'FE5: the first read is a baseline: it recomposes and pushes nothing');
  s.setConf(0.2);
  listener(read(0.2));
  A.eq(s.calls.filter(c => c[0] === 'pushRoster').length, 0, 'FE5: no flip, no push');
  s.setConf(0.9);
  listener(read(0.9));
  A.ok(!worker.systemPrompt.includes('MID-TASK PREFERENCE FORK'), 'FE4: a flip reaches the worker');
  A.ok(!lead.systemPrompt.includes('MID-TASK PREFERENCE FORK'), 'FE4: and the focused agent');
  const pushed = s.calls.find(c => c[0] === 'pushRoster');
  A.ok(pushed && pushed[1].every(([, p]) => !p.includes('MID-TASK PREFERENCE FORK')), 'FE4: and the sidecar roster, with the new prompts');
  A.ok(s.calls.some(c => c[0] === 'persist'), 'and it is persisted');
}

A.report('learned-tail-frontend.test');
