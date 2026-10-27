'use strict';
const { readSidecarSource } = require('./helpers/source');
// provider-connections-ui.test.js - source guard for additive provider credentials in Settings.
// ChatGPT/Codex OAuth and OpenRouter BYOK must coexist: signing into Codex must not erase,
// hide, or leak the OpenRouter key path.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const tauri = ['main.rs', 'credentials.rs']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', file), 'utf8'))
  .join('\n');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const hostedProviders = ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras'];

ok(!/Harness\.setKey\(\s*['"]{2}\s*\)/.test(app), 'Codex wake does not clear the OpenRouter BYOK slot');
ok(/provider\s*!==\s*'codex'[\s\S]{0,80}reqBody\.key\s*=\s*key/.test(harness), 'browser BYOK key is sent only for key-backed provider runs');

ok(/fetch\('\/api\/auth\/codex\/status'/.test(station), 'Settings checks real Codex OAuth status');
ok(/let\s+codexStatusKnown\s*=\s*null/.test(station), 'Codex OAuth status is independent from active provider selection');
ok(/if\s*\(active\s*!==\s*'openrouter'\)\s*addProvider\('openrouter'\)/.test(station), 'Settings can list OpenRouter independently from the active provider');
ok(/const\s+addProvider\s*=\s*active\s*===\s*'codex'\s*\?\s*'openrouter'\s*:\s*active/.test(station), 'Codex-active add-key row targets OpenRouter');
ok(/id="key-in-new"/.test(station) && /data-act="add"/.test(station) && /data-provider=/.test(station), 'add-key controls carry their target provider');
ok(/const\s+provider\s*=\s*b\.dataset\.provider\s*\|\|\s*activeProv\(\)/.test(station), 'add-key save writes to the row provider, not necessarily the active provider');

for (const id of hostedProviders) {
  ok(index.includes('data-prov="' + id + '"'), id + ' appears in the connect provider picker');
  ok(station.includes("id: '" + id + "'"), id + ' appears in Settings provider cards');
  ok(tauri.includes('"' + id + '"'), id + ' appears in desktop keychain provider status');
}
ok(/PROVIDERS\.forEach\(p\s*=>\s*addProvider\(p\.id\)\)/.test(station), 'Settings lists any configured provider, not only the active provider');

// Provider cards contain their own ADD KEY / SIGN IN / SAVE controls. The selectable card surface must therefore
// be a separate native button, not a role=button ancestor that creates nested interactive controls in the a11y tree.
ok(!/class="prov-card[^\n]+role="button"/.test(station), 'provider card container is not an interactive ancestor');
ok(/role="group" aria-label="[^\n]+ provider"/.test(station), 'provider card is exposed as a named group');
ok(/<button class="prov-select" data-act="prov-select" aria-label="Select /.test(station), 'provider selection has a dedicated native button');
ok(/providerSelect\.addEventListener\('click', activate\)/.test(station), 'dedicated provider button owns activation');

// settings-truth: the credential list must reflect ACTUALLY-stored keys, never DEVMODE-fabricated ones.
// The honest getter (hasStoredCredential) is exported and used by the Settings list; configured() (which
// reports true in DEVMODE for auto-resume) must NOT be the credential-list gate.
ok(/function\s+hasStoredCredential\s*\(/.test(harness), 'harness exposes an honest hasStoredCredential getter');
ok(/return\s*\{[\s\S]*hasStoredCredential[\s\S]*\}/.test(harness), 'hasStoredCredential is on the harness public API');
ok(/DEVMODE\s*&&\s*DEV\s*&&\s*DEV\.hasKey\s*===\s*true\s*&&\s*normalizeProviderId\(DEV\.prov\)\s*===\s*p/.test(harness), 'DEV seed only backs the seeded provider (DEV.prov), not all providers');
// …and only when the host SAYS it holds one. A seeded station with no key still boots in DEV mode, and
// assuming the key existed rendered "● KEY SAVED" over nothing — the badge an agent reads as proof it can run.
ok(/hasKey:\s*!!runtimeKey/.test(readSidecarSource()),
  'the DEV boot payload carries the honest hasKey (no secret, just the boolean)');
ok(/const\s+set\s*=\s*h\.hasStoredCredential\s*\?\s*h\.hasStoredCredential\(provider\)/.test(station), 'Settings credential list gates rows on hasStoredCredential, not the DEVMODE-fabricated configured()');
ok(/stored:\s*!!set/.test(station), 'credential rows preserve the stored-key fact when desktop keychain values are intentionally unreadable');
ok(/k\.baseUrl\s*\|\|\s*\(k\.stored\s*\?\s*'stored securely'\s*:\s*'keyless endpoint'\)/.test(station),
  'a stored desktop credential is labeled stored securely, never as a keyless endpoint');
// armed REMOVE must be unmistakable: filled --bad button + row hairline + inline confirm hint.
ok(/b\.classList\.add\('armed'\)/.test(station) && /rowEl\.classList\.add\('rm-armed'\)/.test(station), 'REMOVE arm marks both the button and its row');
ok(/click again to confirm removal/.test(station), 'armed REMOVE shows an inline confirm hint');

// PU-07: keyless endpoints are configuration, not credentials, and ACTIVE requires a live catalog probe.
ok(/if\s*\(p\s*===\s*'ollama'\)\s*return\s*false/.test(harness), 'Ollama never manufactures a stored credential');
ok(/async\s+function\s+probeProvider\s*\(/.test(harness), 'Harness exposes a live provider endpoint probe');
ok(/credentialSaved[\s\S]*endpointConfigured[\s\S]*reachable[\s\S]*catalogAvailable[\s\S]*selected/.test(harness), 'provider probe separates credential, endpoint, reachability, catalog, and selection facts');
ok(/h\.probeProvider\(provider\)/.test(station), 'Settings provider cards refresh from the live Harness probe');
ok(/LOCAL ENDPOINT CONFIGURED/.test(station) && /OFFLINE/.test(station), 'keyless provider copy distinguishes configured endpoints from offline endpoints');
ok(/const\s+runnable\s*=\s*!!\(health\s*&&\s*health\.reachable/.test(station), 'ACTIVE is gated on proven endpoint reachability');
ok(/const\s+health\s*=\s*providerHealth\[k\.provider\]/.test(station) &&
   !/const\s+runnable\s*=\s*k\.provider\s*===\s*active\s*&&\s*!!k\.model/.test(station),
  'the API-key rows also reserve ACTIVE for probe-proven runnability instead of selection alone');
ok(!/connected\s*\?\s*connLabel[\s\S]{0,160}p\.id\s*===\s*'ollama'\s*\?\s*'[^']*LOCAL'/.test(station), 'Ollama does not fall through the generic credential status copy');

// GitHub #113 (confirmed live 2026-10-13): a CUSTOM endpoint is added with its URL, the key is optional, and the add copy no
// longer claims a ChatGPT sign-in on stations that have none. org P04: ONE key box per provider — the CUSTOM card's ＋ ADD KEY
// is the only CUSTOM add form (the API KEYS twin is gone), and the list-side add row only renders for a provider whose card
// offers no ＋ ADD KEY / ⏼ SIGN IN of its own.
ok(/customEndpointInputHtml\('prov-base-in-custom'\)/.test(station) && !/customEndpointInputHtml\('base-in-new'\)/.test(station), 'the CUSTOM card is the one CUSTOM add form, and it takes the endpoint URL');
ok(/if \(provider === 'custom'\) return saveCustomEndpoint\(/.test(station), 'the CUSTOM save stores the endpoint before any key');
ok(/if \(provider === 'custom'\) return '<div class="key-empty"><p>' \+ ADD_ON_CARD/.test(station), 'API KEYS never renders a second CUSTOM add form');
ok(/!hasAddProvider && !cardOffersAdd\(addProvider\)\) rows\.push\(addKeyHtml/.test(station), 'the API KEYS add row is dropped when the provider card offers ＋ ADD KEY / ⏼ SIGN IN');
ok(/const ADD_ON_CARD = 'Add a key on a provider card above\.'/.test(station) && /if \(!keys\.length\) return \(cardOffersAdd\(addProvider\)/.test(station), 'the empty API KEYS state is one line pointing at the cards');
ok(/>✎ ENDPOINT URL<\/button>/.test(station) && !/✎ STATION LINK/.test(station), 'the saved CUSTOM row edits its address under ✎ ENDPOINT URL');
ok(/↻ SPARE KEYS/.test(station) && !/↻ BACKUPS/.test(station), 'the key pool reads ↻ SPARE KEYS, not BACKUPS (STATION BACKUP is a different thing)');
ok(/retry ✎ ENDPOINT URL before running/.test(harness), 'the desktop endpoint error names the ✎ ENDPOINT URL key');
ok(/data-act="baseurl-edit" data-i="' \+ i \+ '" data-tip="[^"]+">✎ ENDPOINT URL</.test(station), 'the ✎ ENDPOINT URL key carries a station data-tip, never a native title= bubble');
ok(/a spare key was rejected/.test(harness) && /your previous spare keys are unchanged/.test(harness) && !/backup key|backup pool is/.test(harness), 'a rejected ↻ SPARE KEYS save names spare keys, never a backup pool');
ok(/set your fallback models to/.test(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'station-control.js'), 'utf8')), 'the fallback.set approval card names FALLBACK MODELS, the heading AI & MODELS shows');
ok(!/while keeping your ChatGPT sign-in connected/.test(station), 'the add-key copy never claims a ChatGPT sign-in');
// org P04 (g4 final round): "Add it on its card above" pointed at whatever card sat above it — the no-key line is a real door
// that lands ON the selected provider's card (focusProvider: the error doors' scroll + mark), in reading-size words
ok(/else if \(addProvider === active && \(providerAcceptsKey\(addProvider\) \|\| addProvider === 'starnet'\) && !hasAddProvider\) rows\.push\(selectedSetupLineHtml\(addProvider, provName\(addProvider\), creditsProv\.state\)\);/.test(station)
  && !/Add it on its card above/.test(station), 'the selected provider\'s no-key line names its card as a door, never "its card above"');
// (wiring) the line names what THAT card is missing: STARNET MANAGED takes no key (its card offers ↗ LINK STATION), CUSTOM's
// key is optional and its card reads ○ NO ENDPOINT — "has no key yet" + "ADD IT" sent both to a card with no such field
ok(/return !isOAuthProvider\(provider\) && provider !== 'ollama' && provider !== 'claude-cli' && provider !== 'starnet';/.test(station), 'STARNET MANAGED never counts as a key provider (agrees with harness providerNeedsKey)');
{
  const at = station.indexOf('  function selectedSetupLineHtml(');
  const src = station.slice(at, station.indexOf('\n  }\n', at) + 4);
  const line = new Function('esc', src + '\nreturn selectedSetupLineHtml;')(s => String(s));
  const sn = line('starnet', 'STARNET MANAGED', 'linkable');
  ok(/The selected provider, STARNET MANAGED, isn’t linked yet\./.test(sn) && /▸ LINK IT ON THE STARNET MANAGED CARD/.test(sn) && !/no key|ADD IT/.test(sn), 'unlinked STARNET MANAGED: "isn’t linked yet" + LINK IT, never a key');
  ok(line('starnet', 'STARNET MANAGED', 'linked') === '' && line('starnet', 'STARNET MANAGED', 'saved') === '', 'a linked or saved StarNet link owes no line');
  const cu = line('custom', 'CUSTOM', 'absent');
  ok(/The selected provider, CUSTOM, has no endpoint yet\./.test(cu) && /▸ SET IT ON THE CUSTOM CARD/.test(cu) && !/no key/.test(cu), 'CUSTOM without an endpoint: "has no endpoint yet"');
  const or = line('openrouter', 'OPENROUTER', 'absent');
  ok(/The selected provider, OPENROUTER, has no key yet\./.test(or) && /data-act="to-prov-card" data-provider="openrouter">▸ ADD IT ON THE OPENROUTER CARD</.test(or), 'a key provider keeps "has no key yet" + ADD IT, landing on its card');
}
ok(/body\.querySelectorAll\('\[data-act="to-prov-card"\]\[data-provider\]'\)\.forEach\(b => b\.addEventListener\('click', \(\) => \{ sfx\('click'\); focusProvider\(b\.dataset\.provider\); \}\)\);/.test(station), 'that door lands on the provider\'s card through focusProvider');
// (org P03 wiring) a BACKGROUND repaint (a probe / status check landing) keeps the reader's place: the console rebuild made a
// fresh .con-pane at scrollTop 0, throwing a Commander — or an error door's landed card — back to the top of AI & MODELS
{
  const at = station.indexOf('  function scheduleSettingsRepaint() {');
  const src = station.slice(at, station.indexOf('\n  }\n', at) + 4);
  const mk = top => ({ scrollTop: top });
  let pane = mk(640), section = 'providers';
  const open = {}, consoleSection = { settings: 'providers' };
  const win = { querySelector: sel => sel === '.con-pane' ? pane : null };
  open.settings = win;
  const rerender = () => { pane = mk(0); consoleSection.settings = section; };   // the rebuild: a fresh pane at the top
  const run = new Function('open', 'consoleSection', 'rerender', 'setTimeout', 'SETTINGS_REPAINT_COALESCE_MS',
    'let settingsRepaintQueued = false;\n' + src + '\nreturn scheduleSettingsRepaint;')(open, consoleSection, rerender, fn => fn(), 120);
  run();
  ok(pane.scrollTop === 640, 'a background repaint restores the pane scroll (got ' + pane.scrollTop + ')');
  pane = mk(300); section = 'autonomy'; run();
  ok(pane.scrollTop === 0, 'a repaint that changed the section never carries the old scroll across');
}
ok(/const until = Date\.now\(\) \+ 20000;/.test(station) && !/const until = Date\.now\(\) \+ 4000;/.test(station), 'the landing outlasts a first-open probe (15s credential check), not 4s');
ok(/const TAKE_OVER = \['pointerdown', 'wheel', 'keydown'\];/.test(station) && /if \(touched\) return;/.test(station), 'the landing stops re-landing the moment the Commander takes over the window');
// (wiring) one key box per provider card: the STARNET credits notice sends "your own key" to the cards (add, then select),
// never to API KEYS, which has no add box for another provider and no switch
ok(!/switch to your own key under API KEYS above/.test(station) && (station.match(/You can always switch to your own key: add it on a provider card above, then select that card\./g) || []).length === 2, 'both credits notices point your own key at a provider card');
ok(/\.settings-console \.key-empty\.key-goto p \{ font-size: 16px;[^}]*opacity: 1; \}/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'settings.css'), 'utf8')), 'the no-key line reads at the paragraphs\' size, not the dim 12px empty-state voice');
{
  const src = station.slice(station.indexOf('  function normEndpoint(raw) {'), station.indexOf('  function addKeyHtml('));
  const norm = new Function(src.slice(0, src.indexOf('\n  }\n') + 4) + '\nreturn normEndpoint;')();
  ok(norm('localhost:1234/v1') === 'http://localhost:1234/v1', 'a bare local host gets http:// (LM Studio)');
  ok(norm('192.168.1.20:8000/v1') === 'http://192.168.1.20:8000/v1', 'a bare LAN host gets http://');
  ok(norm('api.freellmapi.com/v1') === 'https://api.freellmapi.com/v1', 'a bare public host gets https://');
  ok(norm('https://x.example/v1') === 'https://x.example/v1' && norm('') === '' && norm('http://') === null, 'a full URL is kept, empty is empty, junk is refused');
}

// LOOKING IS NOT SWITCHING (live walkthrough 2026-10-13): one click on the unconfigured CUSTOM card made it the station's
// brain and every later run failed. A card says whether it is set up; a click on one that is not opens its setup instead.
ok(/data-configured="' \+ \(configured \? '1' : '0'\) \+ '"/.test(station), 'each provider card says whether it is set up');
ok(/if \(card\.dataset\.configured === '0' && p !== activeProv\(\)\) \{[\s\S]{0,400}return;\s*\}\s*h\.setProv\(p\);/.test(station), 'a click on a provider that is not set up never switches the brain to it');

// ONE LIVE LANDING (org P03 review): focusProvider sliced out of the shipped file and run over a fake Settings window and a
// fake clock. A newer door ends the older landing (whose stay() loop used to re-land the pane on ITS card after the newer
// door's repaint), and a click / wheel / key in Settings ends a landing, even one whose card has not painted yet.
{
  const vm = require('vm');
  const iFp = station.indexOf('  let provLanding = null;'), jFp = station.indexOf('  // Following work should uncover the destination');
  ok(iFp > 0 && jFp > iFp && jFp - iFp < 8000, 'sliced focusProvider with its one-landing slot (' + (jFp - iFp) + ' chars)');
  const mkWorld = () => {
    let clock = 1000, timers = [];
    const listeners = {};
    const pane = { scrollTop: 0, offsetTop: 0, clientHeight: 400 };
    const ORDER = { openrouter: 300, codex: 900, anthropic: 1500 };
    let cards = {}, painted = true;
    const mkCard = pid => {
      const cls = new Set();
      return { pid, isConnected: true, offsetTop: ORDER[pid], closest: () => pane, querySelector: () => null,
        classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) } };
    };
    const settings = {
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
      querySelector: sel => { const m = /data-provider="([^"]+)"/.exec(sel); return painted && m ? cards[m[1]] || null : null; }
    };
    // a repaint replaces every card (the old nodes disconnect), exactly what openTerm('settings', section) does on an open window
    const repaint = () => { Object.values(cards).forEach(c => { c.isConnected = false; }); cards = {}; Object.keys(ORDER).forEach(p => { cards[p] = mkCard(p); }); };
    repaint();
    const ctx = vm.createContext({
      open: { settings }, Math, String,
      Date: { now: () => clock },
      setTimeout: (fn, ms) => { timers.push({ at: clock + ms, fn }); return timers.length; },
      openTerm: () => repaint(),
      isOAuthProvider: () => false, startCardSignin: () => {}
    });
    vm.runInContext(station.slice(iFp, jFp) + '\nthis.focusProvider = focusProvider;', ctx);
    const advance = ms => {
      const end = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift(); clock = t.at; t.fn();
      }
      clock = end;
    };
    const fire = t => (listeners[t] || []).slice().forEach(fn => fn({ type: t }));
    const markedNow = () => Object.keys(cards).filter(p => cards[p].classList.contains('prov-landed'));
    return { ctx, pane, advance, fire, repaint, markedNow, setPainted: v => { painted = v; }, landedOn: pid => pane.scrollTop === Math.max(0, ORDER[pid] - 100) };
  };

  // the review's repro: door A, then door B within 20s, nothing touched in Settings
  {
    const W = mkWorld();
    W.ctx.focusProvider('openrouter');
    ok(W.landedOn('openrouter') && W.markedNow().join() === 'openrouter', 'door A lands on card A');
    W.advance(1000);
    W.ctx.focusProvider('codex');
    ok(W.landedOn('codex'), 'door B lands on card B');
    W.advance(3000);
    ok(W.landedOn('codex'), 'the older landing never pulls the pane back to card A after door B repainted Settings: scrollTop ' + W.pane.scrollTop);
    ok(W.markedNow().join() === 'codex', 'one marked card, the newest door\'s: ' + JSON.stringify(W.markedNow()));
    // B is the live landing: a background repaint still re-lands on B, never on A
    W.pane.scrollTop = 0; W.repaint(); W.advance(400);
    ok(W.landedOn('codex') && W.markedNow().join() === 'codex', 'a background repaint re-lands on the live (newest) landing only');
  }
  // the Commander takes over: a wheel / click / key in Settings ends the landing, so a later repaint does not yank the pane
  ['wheel', 'pointerdown', 'keydown'].forEach(kind => {
    const W = mkWorld();
    W.ctx.focusProvider('anthropic');
    ok(W.landedOn('anthropic'), kind + ': the door lands on the card');
    W.fire(kind); W.pane.scrollTop = 42;
    W.repaint(); W.advance(2000);
    ok(W.pane.scrollTop === 42, kind + ' in Settings ends the landing: a later repaint leaves the Commander\'s scroll alone (scrollTop ' + W.pane.scrollTop + ')');
  });
  // ...even before the card has painted (a first open whose section paints a beat late)
  {
    const W = mkWorld();
    W.setPainted(false);
    W.ctx.focusProvider('codex');
    W.fire('wheel'); W.pane.scrollTop = 7;
    W.setPainted(true); W.advance(3000);
    ok(W.pane.scrollTop === 7 && W.markedNow().length === 0, 'a scroll before the card paints ends the landing: its pending retry never lands');
  }
}

console.log('provider-connections-ui.test.js OK -', n, 'assertions');
