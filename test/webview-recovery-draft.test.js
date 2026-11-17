#!/usr/bin/env node
'use strict';
/* #181 (Mac, 0.15.0): Claude sign-in -> WAKE -> "testing the wire..." -> back to PRESS ANY KEY, with nothing in startup.log.
   macOS stopped the page's web content process and Tauri's default reloaded the page silently; a first run has no save,
   so every setup choice was gone. This runs the SHIPPED page helpers (both trees) in a vm against a fake DOM and storage,
   and holds the host and the page to one recovery mark:
     - the choices are kept only for the length of a wire test, never a key, never FULL approval, and read once;
     - a stale (15 min+), future-dated or malformed draft is ignored;
     - a restore puts the connect screen back on the brain step with the choices, and says what happened;
     - the host's macOS handler logs the stop, spends the WebView2 budget, and marks its reload #webview-recovered. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sliceHelpers(src) {
  const start = src.indexOf('  const WAKE_DRAFT_KEY = ');
  const end = src.indexOf('\n  // Returns TRUE once it commits to entering the station', start);
  A.ok(start > 0 && end > start && end - start < 12000, 'the #181 helpers are one bounded block before onWakeAttempt');
  return src.slice(start, end);
}

function rig(src) {
  const store = new Map();
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, value: '', textContent: '', className: '', events: [],
        dispatchEvent(ev) { this.events.push(ev.type); } });
    }
    return nodes.get(id);
  };
  const calls = [];
  const chips = ['openai', 'claude-cli', 'starnet', 'openrouter'].map(p => ({ dataset: { prov: p } }));
  const ctx = {
    Date, JSON, Number, Object, Array, String, Event: class { constructor(type) { this.type = type; } },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
    },
    location: { hash: '', pathname: '/index.html', search: '' },
    history: { replaceState: (_s, _t, url) => { calls.push(['replaceState', url]); ctx.location.hash = ''; } },
    document: { querySelectorAll: sel => (sel === '.provider-row .prov' ? chips : []), getElementById: node },
    el: node,
    // app.js state the helpers read and write
    pickedProvider: 'openai', pickedSkin: 'bear', pickedPersona: 'professional', pickedTraits: {}, pickedCustomVoice: '',
    pickedApproval: 'ask', userPickedProvider: false,
    buildSkins: () => calls.push(['buildSkins']), buildVoice: () => calls.push(['buildVoice']),
    buildApproval: () => calls.push(['buildApproval']), updateNameplate: () => calls.push(['updateNameplate']),
    updateHint: () => calls.push(['updateHint']),
    selectProviderUI: p => { calls.push(['selectProviderUI', p]); ctx.pickedProvider = p; },
    OverseerSetup: { showStep: (s, f) => calls.push(['showStep', s, f]), beginConnection: () => calls.push(['beginConnection']) },
  };
  vm.createContext(ctx);
  vm.runInContext(sliceHelpers(src) + `
    this.api = { takeRecoveryMarker, saveWakeDraft, clearWakeDraft, takeWakeDraft, restoreWakeDraft, wakeDraftTraits,
      KEY: WAKE_DRAFT_KEY, MS: WAKE_DRAFT_MS, FRAGMENT: WEBVIEW_RECOVERED_FRAGMENT,
      get picked() { return { pickedProvider, pickedSkin, pickedPersona, pickedTraits, pickedCustomVoice, pickedApproval, userPickedProvider }; },
      set picked(v) { ({ pickedProvider, pickedSkin, pickedPersona, pickedTraits, pickedCustomVoice, pickedApproval } = Object.assign(this.picked, v)); } };`, ctx);
  return { ctx, api: ctx.api, store, node, calls };
}

for (const tree of ['frontend/app', 'website/app/app']) {
  const src = read(tree + '/app.js');
  const t = tree + ': ';

  // 1. the host's mark is read once and stripped from the address
  {
    const { ctx, api, calls } = rig(src);
    A.eq(api.takeRecoveryMarker(), false, t + 'no mark, no recovery');
    ctx.location.hash = '#webview-recovered';
    A.eq(api.takeRecoveryMarker(), true, t + 'the host mark reads as a recovery');
    A.eq(calls.find(c => c[0] === 'replaceState'), ['replaceState', '/index.html'], t + 'and is stripped from the address');
    A.eq(api.takeRecoveryMarker(), false, t + 'once only');
    ctx.location.hash = '#something-else';
    A.eq(api.takeRecoveryMarker(), false, t + 'another fragment is not a recovery');
  }

  // 2. what is kept: the choices, never a key, never FULL approval
  {
    const { api, store, node } = rig(src);
    node('in-name').value = 'Nova the very long name indeed';
    node('in-key').value = 'sk-SECRET-KEY-NEVER-STORED';
    api.picked = { pickedProvider: 'claude-cli', pickedSkin: 'fox', pickedPersona: 'warm', pickedTraits: { warmth: 2, emoji: true },
      pickedCustomVoice: 'calm', pickedApproval: 'full' };
    api.saveWakeDraft('claude-sonnet-5-5', '');
    const raw = store.get(api.KEY);
    A.ok(typeof raw === 'string', t + 'a wire test keeps the setup');
    A.ok(!raw.includes('SECRET') && !/"key"|apiKey/i.test(raw), t + 'no key is ever kept');
    A.ok(!/approval/i.test(raw), t + 'approval is not kept');
    const d = JSON.parse(raw);
    A.eq([d.name, d.provider, d.model, d.skin, d.persona, d.customVoice], ['Nova the very long', 'claude-cli', 'claude-sonnet-5-5', 'fox', 'warm', 'calm'],
      t + 'name (18 max), provider, model, character and voice are kept');
    api.clearWakeDraft();
    A.ok(!store.has(api.KEY), t + 'a finished test clears it');
  }

  // 3. read once; stale, future-dated and malformed drafts are ignored (and removed)
  {
    const { api, store } = rig(src);
    const now = Date.now();
    store.set(api.KEY, JSON.stringify({ at: now - 60000, name: 'A' }));
    A.eq(api.takeWakeDraft(now).name, 'A', t + 'a fresh draft is returned');
    A.eq(api.takeWakeDraft(now), null, t + 'once only');
    for (const [label, value] of [['stale', JSON.stringify({ at: now - api.MS - 1, name: 'B' })],
      ['future', JSON.stringify({ at: now + 3600000, name: 'C' })], ['no time', JSON.stringify({ name: 'D' })],
      ['array', '[1,2]'], ['not json', '{oops'], ['null', 'null']]) {
      store.set(api.KEY, value);
      A.eq(api.takeWakeDraft(now), null, t + label + ' draft is ignored');
      A.ok(!store.has(api.KEY), t + label + ' draft is removed');
    }
  }

  // 4. a restore: brain step, the provider only when its chip exists, approval back to ask, traits sanitised, the reason said
  {
    const { api, node, calls } = rig(src);
    api.picked = { pickedApproval: 'full' };
    api.restoreWakeDraft({ name: 'NOVA', provider: 'claude-cli', model: 'claude-sonnet-5-5', skin: 'fox', persona: 'warm',
      traits: { warmth: 2, emoji: true, 'bad key': 1, html: '<img src=x onerror=alert(1)>', nested: { a: 1 } }, customVoice: 'calm' }, true);
    const p = api.picked;
    A.eq(node('in-name').value, 'NOVA', t + 'the name is back');
    A.ok(node('in-name').events.includes('input'), t + 'and the nameplate and counter follow it');
    A.eq([p.pickedProvider, p.userPickedProvider, node('in-model').value], ['claude-cli', true, 'claude-sonnet-5-5'],
      t + 'the provider (as a user pick, so no auto-promote replaces it) and the model are back');
    A.eq(p.pickedApproval, 'ask', t + 'FULL approval is never restored: it asks again at the safe default');
    A.eq(p.pickedTraits, { warmth: 2, emoji: true }, t + 'only plain trait values survive');
    A.eq([p.pickedSkin, p.pickedPersona, p.pickedCustomVoice], ['fox', 'warm', 'calm'], t + 'character and voice are back');
    A.ok(calls.some(c => c[0] === 'showStep' && c[1] === 'brain') && calls.some(c => c[0] === 'beginConnection'),
      t + 'the connect screen opens on the brain step with the connection open');
    const order = calls.map(c => c[0]);
    A.ok(order.indexOf('selectProviderUI') < order.lastIndexOf('updateHint'), t + 'the model is set after the provider (whose switch resets it)');
    A.ok(/macOS stopped StarNet’s display/.test(node('connect-msg').textContent) && /press WAKE to try again/.test(node('connect-msg').textContent),
      t + 'a host recovery says macOS stopped the display, and what to do');
  }
  {
    const { api, node, calls } = rig(src);
    api.restoreWakeDraft({ provider: 'not-a-provider', model: 'm' }, false);
    A.ok(!calls.some(c => c[0] === 'selectProviderUI'), t + 'an unknown provider is not selected');
    A.ok(!calls.some(c => c[0] === 'beginConnection'), t + 'and the connection panel stays on the provider list');
    A.ok(/^StarNet stopped before the wire test finished\./.test(node('connect-msg').textContent), t + 'without the host mark it does not blame macOS');
  }

  // 5. the wiring in the shipped page
  const wake = A.fnBody(src, 'async function onWakeAttempt(');
  A.ok(wake.length > 2000 && wake.length < src.length / 2, t + 'onWakeAttempt sliced');
  const save = wake.indexOf('saveWakeDraft(model, baseUrl)'), test = wake.indexOf('await preflightWire()'), clear = wake.indexOf('clearWakeDraft()');
  A.ok(save > 0 && save < test && test < clear, t + 'the setup is kept just before the wire test and cleared as soon as it returns');
  A.ok(/if \(!resumingSaved\) saveWakeDraft/.test(wake), t + 'a saved station resuming keeps nothing (its save is the record)');
  const init = A.fnBody(src, 'async function init()');
  A.ok(init.length > 2000 && init.length < src.length / 2, t + 'init sliced');
  A.ok(/^\{\s*pageRecoveredByHost = takeRecoveryMarker\(\);/.test(init.slice(init.indexOf('{'))), t + 'init reads the host mark before anything else');
  const take = init.indexOf('const draft = takeWakeDraft()'), splash = init.lastIndexOf('showSplash()'), lineage = init.indexOf('priorInstallEvidence === true');
  A.ok(lineage > 0 && lineage < take && take < splash, t + 'a draft is honoured only on a first run, after the prior-install gate, before the title');
  A.ok(/showStep: select/.test(read(tree + '/overseer-setup.js')), t + 'OverseerSetup exposes the step a restore opens');
}

// 6. one mark, host and page
const recovery = read('src-tauri/src/webview_recovery.rs'), main = read('src-tauri/src/main.rs');
const hostMark = /pub\(crate\) const RECOVERED_FRAGMENT: &str = "([^"]+)";/.exec(recovery);
const pageMark = /WEBVIEW_RECOVERED_FRAGMENT = '([^']+)'/.exec(read('frontend/app/app.js'));
A.ok(hostMark && pageMark && hostMark[1] === pageMark[1], 'the host marks its reload with the word the page reads');
const handler = A.fnBody(main, 'fn on_web_content_terminated(webview: &tauri::Webview)');
A.ok(handler.length > 500 && handler.length < 8000, 'the macOS handler sliced');
A.ok(/webview_recovery\.try_spend\(Instant::now\(\)\)/.test(handler) && /recovery budget spent/.test(handler), 'it spends the same budget as WebView2 and says when it is spent');
A.ok(/log_startup\(/.test(handler) && /macOS stopped the web content process/.test(handler), 'it says the stop in startup.log');
A.ok(/set_fragment\(Some\(webview_recovery::RECOVERED_FRAGMENT\)\)/.test(handler) && /webview\.reload\(\)/.test(handler), 'it marks the reload, and falls back to a plain reload');
A.ok(/std::thread::spawn/.test(handler) && /run_on_main_thread/.test(handler), 'the reload leaves the WebKit callback before it touches the webview');
A.ok(/shutting_down\.load/.test(handler), 'a stop during shutdown is ignored');
A.ok(/\.on_web_content_process_terminate\(on_web_content_terminated\)/.test(main) && /\n\s+\.with_web_content_recovery\(\)\n/.test(main),
  'the builder installs it in place of Tauri\'s silent reload');

A.report('webview-recovery-draft (#181: a setup survives a stopped page, both trees)');
