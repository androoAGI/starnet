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
  const old = { document: global.document, localStorage: global.localStorage, Harness: global.Harness, U: global.U };
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
    configured: p => (opts.linked !== false && p === 'starnet'),
    getKey: () => '', getBaseUrl: () => '', listModels: async () => [],
    apiFetch: async url => {
      if (url === '/api/models/starnet') return new Response(JSON.stringify({ provider: 'starnet', models: opts.catalog || [] }), { status: 200 });
      return new Response(JSON.stringify({ models: [], error: 'not configured', connected: false }), { status: 200 });
    }
  };
  delete require.cache[require.resolve(dockPath)];
  const dock = require(dockPath);
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

  /* ---------- 3. desktop boot keeps the sidecar's starnet answer ---------- */
  {
    const harness = read('frontend', 'app', 'harness.js');
    const slice = (from, to) => { const a = harness.indexOf(from), b = harness.indexOf(to, a + 1); A.ok(a >= 0 && b > a, 'harness.js still has ' + from.trim().slice(0, 40)); return harness.slice(a, b); };
    const src = [
      'let _configured = false, _configuredByProvider = Object.create(null), _alternateCountByProvider = Object.create(null), selectionRevision = 0;',
      slice('  async function init() {', '  /* whether a key is set'),
      slice('  function normalizeProviderId(provider) {', '  function providerSlot('),
      slice('  function configured(provider) {', '  // Truthful-telemetry getter'),
      '({ init, configured, map: () => _configuredByProvider });'
    ].join('\n');
    for (const [label, keychain] of [['keychain status sweep', true], ['legacy has_key fallback', false]]) {
      const fetched = [];
      const ctx = {
        DESKTOP: true, DEVMODE: false, Object, Array, Number, String, Promise, JSON,
        ensureApiToken: async () => 't', syncEngineKeysOnBoot() {}, getProv: () => 'starnet', getBaseUrl: () => '', getKey: () => '',
        providerNeedsKey: () => true,
        invoke: async cmd => {
          if (cmd === 'harness_provider_key_status') { if (!keychain) throw new Error('old build'); return [{ provider: 'openrouter', configured: false }, { provider: 'anthropic', configured: true }]; }
          if (cmd === 'harness_has_key') return false;
          throw new Error('unexpected ' + cmd);
        },
        fetch: async url => {
          fetched.push(url);
          if (String(url).indexOf('/api/credits') === 0) return { ok: true, json: async () => ({ configured: true, balance: 14.96 }) };
          return { ok: true, json: async () => ({ connected: false }) };
        }
      };
      const H = vm.runInNewContext(src, ctx);
      await H.init();
      A.ok(fetched.some(u => String(u).indexOf('/api/credits') === 0), label + ': boot probes /api/credits');
      A.eq(H.configured('starnet'), true, label + ': a linked station stays configured for STARNET after a desktop boot');
      A.eq(H.configured('anthropic'), keychain, label + ': the keychain answer still lands for key providers');
    }
  }

  A.report('managed-model-93.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
