/* node test/managed-model-93.test.js — GitHub #93: a LINKED StarNet Managed station read "GPT-5.5 — Not Available",
   "no model selected", STARNET MANAGED greyed in the per-agent picker, and CHOOSE MODEL flashed shut. Three chained
   bugs, each locked here by executing the REAL frontend code:
     1. a bare 'gpt-5.5' (the default a managed setup saved, borrowed from the openrouter list) is mapped to the ONE
        catalog row '<vendor>/gpt-5.5' and the reconcile PERSISTS the replacement — never cleared, never guessed when
        two vendors serve the same tail; STARNET has its own catalog-shaped default.
     2. the dock's outside-click closer ignores the click that finishes the very press which opened it (the COMMS
        chip opens on pointerdown and removes its own row, so that click lands detached or on whatever is underneath).
     3. a desktop boot rebuilding the configured map from the keychain keeps the sidecar's starnet answer.
   Plus: the per-agent catalog fans out to 'starnet' when linked, and drops it when not. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dockPath = path.join(root, 'frontend', 'app', 'modeldock.js');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeEl(id) {
  const listeners = {};
  const self = {
    id, hidden: true, textContent: '', innerHTML: '', title: '', value: '', style: {}, dataset: {}, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    appendChild() {}, querySelector: () => null, querySelectorAll: () => [], focus() {},
    contains: t => t === self, _listeners: listeners
  };
  return self;
}

// Load modeldock.js against a stub document whose listeners are captured, so the real handlers can be driven.
function loadDock(opts) {
  opts = opts || {};
  let provider = opts.provider || 'starnet', model = opts.model || '', revision = 0;
  const applied = [];
  const docListeners = [];
  const els = { 'model-dock': fakeEl('model-dock'), 'model-dock-toggle': fakeEl('model-dock-toggle') };
  const old = { SK: global.SK, document: global.document, localStorage: global.localStorage, Harness: global.Harness, U: global.U };
  global.SK = { providers: { registry: require('../sidecar/providers/registry.js') } };
  global.document = {
    getElementById: id => els[id] || null,
    querySelector: () => null,
    addEventListener(type, fn, capture) { docListeners.push({ type, fn, capture: !!capture }); },
    createElement: () => fakeEl(''),
    createDocumentFragment: () => ({ appendChild() {} })
  };
  global.localStorage = { getItem: () => '1', setItem() {} };
  global.U = { esc: s => String(s) };
  global.Harness = {
    getSelectionRevision: () => revision,
    getProv: () => provider, setProv: v => { revision++; provider = v; },
    getModel: () => model, setModel: v => { revision++; model = v; },
    getReasoningEffort: () => 'medium', setReasoningEffort() {}, normalizeReasoningEffort: v => String(v || 'medium'),
    configured: p => (opts.linked !== false && p === 'starnet') || (p === 'claude-cli' && !!opts.claudeCatalog),
    getKey: () => '', getBaseUrl: () => '', listModels: async () => [],
    apiFetch: async url => {
      if (url === '/api/models/starnet') return new Response(JSON.stringify({ provider: 'starnet', models: opts.catalog || [] }), { status: 200 });
      if (url === '/api/models/claude-cli' && opts.claudeCatalog) return new Response(JSON.stringify({ provider: 'claude-cli', models: opts.claudeCatalog }), { status: 200 });
      if (url === '/api/credits?history=0') return opts.credits ? new Response(JSON.stringify(opts.credits), { status: 200 }) : new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ models: [], error: 'not configured', connected: false }), { status: 200 });
    }
  };
  delete require.cache[require.resolve(dockPath)];
  let dock;
  if (process.env.MODELDOCK_CACHE_CONTROL) {
    const Module = require('module'), mod = new Module(dockPath, module);
    mod.filename = dockPath; mod.paths = module.paths;
    const source = fs.readFileSync(dockPath, 'utf8');
    const a = source.indexOf('  async function fetchProviderModels('), b = source.indexOf('  async function fetchModels(', a);
    mod._compile(source.slice(0, a) + fs.readFileSync(process.env.MODELDOCK_CACHE_CONTROL, 'utf8') + source.slice(b), dockPath);
    dock = mod.exports;
  } else dock = require(dockPath);
  const restore = () => {
    delete require.cache[require.resolve(dockPath)];
    Object.assign(global, old);
  };
  const fire = (type, ev) => docListeners.filter(l => l.type === type).forEach(l => l.fn(ev));
  return { dock, els, fire, applied, restore, state: () => ({ provider, model }) };
}

module.exports = (async () => {
  /* ---------- 1. bare id → the one routed row ---------- */
  {
    const t = loadDock();
    try {
      const eqv = t.dock._internals.catalogEquivalent;
      A.eq(eqv('gpt-5.5', 'starnet', [{ id: 'openai/gpt-5.5' }]), 'openai/gpt-5.5', 'bare gpt-5.5 maps to the single managed row openai/gpt-5.5');
      A.eq(eqv('gpt-5.5', 'openrouter', [{ id: 'openai/gpt-5.5' }, { id: 'openai/gpt-5.5-mini' }]), 'openai/gpt-5.5', 'openrouter maps the same way; a longer tail is not a match');
      A.eq(eqv('gpt-5.5', 'starnet', [{ id: 'openai/gpt-5.5' }, { id: 'azure/gpt-5.5' }]), '', 'two vendors serving the same tail is ambiguous: no remap');
      A.eq(eqv('gpt-5.5', 'starnet', [{ id: 'openai/gpt-5.5:free' }, { id: 'x/y/gpt-5.5' }]), '', 'a variant suffix or a nested path is never a match');
      A.eq(eqv('claude-sonnet-5', 'starnet', [{ id: 'anthropic/claude-sonnet-5' }, { id: 'other/claude-sonnet-5' }]), 'anthropic/claude-sonnet-5', 'the anthropic/ equivalent still wins first');
      A.eq(eqv('gpt-5.5', 'openai', [{ id: 'openai/gpt-5.5' }]), '', 'a direct provider never gains a routed prefix');
      A.eq(eqv('gpt-5.5', 'starnet', [{ id: 'openai/gpt-5.4' }]), '', 'never invents a slug the catalog lacks');
    } finally { t.restore(); }
  }
  {
    // the reconcile REPLACES the stored bare id and persists it through the app callback (no "MODEL UNAVAILABLE")
    const t = loadDock({ model: 'gpt-5.5', catalog: [{ id: 'openai/gpt-5.5', name: 'OpenAI: GPT-5.5', supported_parameters: ['tools'] }, { id: 'anthropic/claude-sonnet-4.6', supported_parameters: ['tools'] }] });
    try {
      t.dock.init({ apply: c => t.applied.push(c), identity: () => 'agent' });
      for (let i = 0; i < 100 && !t.applied.length; i++) await sleep(5);
      A.eq(t.state().model, 'openai/gpt-5.5', 'the stored bare gpt-5.5 is replaced by the catalog id');
      A.eq(t.applied.length, 1, 'the replacement is persisted exactly once');
      A.eq(t.applied[0] && t.applied[0].reason, 'catalog_reconcile', 'it is a reconcile, never catalog_unavailable');
      A.eq(t.applied[0] && t.applied[0].model, 'openai/gpt-5.5', 'the persisted model is the prefixed id');
    } finally { t.restore(); }
  }
  {
    // STARNET's own default is catalog-shaped (no more borrowing openrouter's bare 'gpt-5.5')
    const app = read('frontend', 'app', 'app.js');
    const fallback = (app.match(/const FALLBACK_MODELS = Object\.freeze\(\{[\s\S]*?\n  \}\);/) || [''])[0];
    const picks = (app.match(/const MODEL_PICKS = Object\.freeze\(\{[\s\S]*?\n  \}\);/) || [''])[0];
    const sf = (fallback.match(/\n    starnet: \[([^\]]*)\]/) || [, ''])[1];
    const sp = (picks.match(/\n    starnet: \[[\s\S]*?\n    \],/) || [''])[0];
    const fIds = (sf.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
    const pIds = (sp.match(/id: '([^']+)'/g) || []).map(s => s.slice(5, -1));
    A.ok(fIds.length > 0 && pIds.length > 0, 'STARNET has its own FALLBACK_MODELS + MODEL_PICKS entries');
    A.ok(fIds.concat(pIds).every(id => /^[a-z0-9-]+\/[^/]+$/.test(id)), 'every STARNET default is a vendor/model id: ' + fIds.concat(pIds).join(', '));
    A.eq(pIds[0], fIds[0], 'the first pick (the genesis default) matches defaultModelFor(starnet)');
  }

  /* ---------- 2. the opening press's click does not close the dock ---------- */
  {
    const t = loadDock({ catalog: [{ id: 'openai/gpt-5.5' }] });
    try {
      t.dock.init({ apply() {}, identity: () => 'agent' });
      const dockEl = t.els['model-dock'];
      t.fire('pointerdown', { button: 0 });            // the chip press begins …
      t.dock.open();                                    // … and its pointerdown handler opens the dock
      A.eq(dockEl.hidden, false, 'the programmatic open shows the dock');
      t.fire('click', { target: Object.assign(fakeEl('chip'), { isConnected: false }) });
      A.eq(dockEl.hidden, false, 'the click on the detached chip (Chromium) does not close the dock it just opened');
      t.fire('click', { target: fakeEl('log') });
      A.eq(dockEl.hidden, false, 'nor does that press\'s click landing on whatever now sits under the pointer (WebKit)');
      await sleep(5);
      t.fire('pointerdown', { button: 0 });             // a NEW press outside
      t.fire('click', { target: fakeEl('elsewhere') });
      A.eq(dockEl.hidden, true, 'a real later click outside still closes the dock');
      t.dock.open();
      t.fire('click', { target: Object.assign(fakeEl('gone'), { isConnected: false }) });
      A.eq(dockEl.hidden, false, 'a click on a node no longer in the document is never an outside click');
    } finally { t.restore(); }
  }

  /* ---------- 4. the per-agent catalog includes starnet when linked, drops it when not ---------- */
  for (const linked of [true, false]) {
    const t = loadDock({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', linked, catalog: [{ id: 'openai/gpt-5.5', supported_parameters: ['tools'] }] });
    try {
      const rows = await t.dock.catalog({ force: true });
      const managed = rows.filter(m => m.provider === 'starnet');
      if (linked) A.ok(managed.some(m => m.id === 'openai/gpt-5.5'), 'a linked station offers STARNET MANAGED rows in the per-agent picker even when the focused agent runs elsewhere');
      else A.eq(managed.length, 0, 'an unlinked station shows no STARNET MANAGED rows (providerEnabled gates it)');
    } finally { t.restore(); }
  }

  /* ---------- 5. an empty wallet sinks STARNET below the user's own sign-ins (2026-10-21 user reports) ---------- */
  {
    const options = { linked: true, catalog: [{ id: 'openai/gpt-5.5' }] };
    const t = loadDock(options);
    try {
      A.ok((await t.dock.catalog({ force: true })).some(m => m.provider === 'starnet'), 'fixture warms an eligible provider catalog');
      options.linked = false;   // the common readiness row changed; no model/selection revision changed
      A.ok(!(await t.dock.catalog()).some(m => m.provider === 'starnet'), 'normal reopen drops an ineligible provider even with a warm catalog');
    } finally { t.restore(); }
  }
  /* ---------- 5. an empty wallet sinks STARNET below the user's own sign-ins (2026-10-21 user reports) ---------- */
  // A linked $0 station listed managed "Claude Opus" right above CLAUDE CODE's, so a mis-pick ran on managed credit.
  for (const [credits, dry, label] of [
    [{ configured: true, balanceUsd: -0.14 }, true, 'a negative balance'],
    [{ configured: true, balanceUsd: 0 }, true, 'a $0 balance'],
    [{ configured: true, balanceUsd: 12.5 }, false, 'a funded balance'],
    [{ configured: true, balanceUsd: null }, false, 'an unreported balance'],
    [null, false, 'a failed balance check']
  ]) {
    const t = loadDock({
      provider: 'claude-cli', model: 'claude-opus-5-5', credits,
      catalog: [{ id: 'anthropic/claude-opus-5', supported_parameters: ['tools'] }],
      claudeCatalog: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }]
    });
    try {
      const rows = await t.dock.catalog({ force: true });
      const order = rows.map(m => m.provider).filter((p, i, a) => a.indexOf(p) === i);
      A.ok(order.includes('starnet') && order.includes('claude-cli'), label + ': both catalogs are listed');
      A.eq(t.dock.starnetDry(), dry, label + ': starnetDry reads the reported balance only');
      if (dry) A.eq(order[order.length - 1], 'starnet', label + ': STARNET sinks below every other provider');
      else A.eq(order[0], 'starnet', label + ': STARNET keeps its place (an unknown balance never buries a funded account)');
    } finally { t.restore(); }
  }
  {
    const dock = read('frontend', 'app', 'modeldock.js');
    A.ok(/starnetDry\(\)\) \{\s*\n\s*const dry = document\.createElement\('i'\);[\s\S]{0,120}' · NO CREDITS'/.test(dock), 'the dock labels a dry STARNET group NO CREDITS');
    A.ok(/p === 'starnet' && M\.starnetDry && M\.starnetDry\(\)\) return M\.labels\.provider\(p\) \+ ' · NO CREDITS'/.test(read('frontend', 'app', 'modelpicker.js')), 'the per-agent picker labels it the same way');
  }

  /* Desktop keychain callbacks cannot erase the sidecar's managed readiness row. */
  {
    const harness = read('frontend', 'app', 'harness.js');
    const { functionSourceIn } = require('./helpers/source.js');
    const cache = require('../frontend/app/provider-readiness.js').makeCache();
    const funcs = ['init', 'normalizeProviderId', 'readiness', 'configured'].map(n => functionSourceIn(harness, n)).join('\n');
    for (const keychain of [true, false]) {
      let refreshed = 0;
      const ctx = { SK: { providers: { registry: require('../sidecar/providers/registry.js') } },
        readinessCache: cache, DESKTOP: true, _alternateCountByProvider: {}, bootNotices() {}, ensureApiToken: async () => 't',
        pushDesktopEndpoints: async () => [], getProv: () => 'starnet',
        refreshProviderReadiness: async () => { refreshed++; cache.accept([{ id: 'starnet', unattendedReady: true, configured: true,
          credential: { present: true, status: 'unverified' }, endpoint: { configured: true }, lastVerified: null }], cache.ticket()); },
        invoke: async () => { if (!keychain) throw new Error('keychain unavailable'); return [{ provider: 'starnet', configured: false, alternateCount: 0 }]; } };
      const H = vm.runInNewContext(funcs + '\n({init, configured})', ctx);
      await H.init();
      A.ok(refreshed > 0 && H.configured('starnet'), 'sidecar managed readiness survives keychain false/unavailable');
    }
  }

  A.report('managed-model-93.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
