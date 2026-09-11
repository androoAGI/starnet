'use strict';
/* settings-p1-ui.test.js — source-lock that the P1 settings rows are actually WIRED into the frontend (not
   decorative). Grep-style guards (mirror permissions-ui / autonomy-ui) covering:
     P1-6 per-agent model pin (dossier CONFIG card + App.setAgentModel + pushRoster)
     P1-7 STATION BACKUP export/import (SETTINGS card + real endpoints + browser-slice restore)
     P1-8 notification prefs (per-category toggles + notify() gating at emit time + tagged call sites)
     P1-9 ADVANCED runtime knobs (SETTINGS card + /api/runtime/knobs + env-precedence note)
     P1-10 memory controls (MEMORY tab reflection on/off + cooldown + /api/memory/config)
   The honesty law: each control must reach a real persisted value + a code path — these guards catch a knob that
   silently loses its wiring. */
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const app = (f) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const ui = app('stationui.js'), appjs = app('app.js'), chat = app('chat.js'), auto = app('autonomystore.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ---- P1-6 per-agent model/provider pin ----
ok(/function modelCard\(/.test(ui), 'P1-6: the dossier CONFIG tab renders a per-agent MODEL card');
ok(/id="ag-model-in"/.test(ui) && /id="ag-prov-in"/.test(ui), 'P1-6: the model card has model + provider inputs');
ok(/access\.config\.setModel/.test(ui), 'P1-6: the model card calls config.setModel');
ok(/FOLLOW STATION DEFAULT/.test(ui), 'P1-6: the card offers "follow station default" (clear the pin)');
ok(/function setAgentModelPin\(/.test(appjs), 'P1-6: App implements setAgentModelPin');
ok(/setModel:\s*setAgentModelPin/.test(appjs), 'P1-6: setModel is exposed on the config access surface');
ok(/setAgentModelPin[\s\S]{0,1500}pushRoster\(\)/.test(appjs), 'P1-6: the pin pushes the roster so the sidecar records it');

// ---- P1-7 station backup export/import/reset ----
ok(/STATION BACKUP/.test(ui), 'P1-7: SETTINGS has a STATION BACKUP card');
ok(/function wireBackup\(/.test(ui), 'P1-7: wireBackup is wired');
ok(/\/api\/config\/export/.test(ui), 'P1-7: export hits /api/config/export');
ok(/\/api\/config\/import/.test(ui), 'P1-7: import hits /api/config/import');
ok(/secretsNeeded/.test(ui), 'P1-7: import surfaces re-enter-your-key states from secretsNeeded');
ok(/n\.fields\.join\(', '\)/.test(ui), 'P1-7: import names the exact connector fields that still need re-entry');
ok(/already applied:/.test(ui), 'P1-7: a failed multi-section import reports any sections already applied');
ok(/const freshMsg = document\.querySelector\('#bk-msg'\)/.test(ui), 'P1-7: the import result remains visible after Settings repaints');
ok(/your keys and tokens are never included|secrets excluded/i.test(ui), 'P1-7: the card discloses secrets are excluded');
ok(/AutonomyStore\.exportState/.test(ui) && /AutonomyStore\.importState/.test(ui), 'P1-7: browser-owned autonomy slice round-trips');
ok(/function exportState\(/.test(auto) && /function importState\(/.test(auto), 'P1-7: AutonomyStore exposes export/import');

// Execute the production browser-slice collector: a successful import must restore
// visual preferences as well as theme and sound, including the new sky choices.
const collectStart = ui.indexOf('    const browserSections = () => {');
const collectEnd = ui.indexOf('    if (exportBtn)', collectStart);
ok(collectStart >= 0 && collectEnd > collectStart, 'P1-7: browser export collector is located');
for (const backdrop of ['void', 'galaxy', 'belt', 'moon']) {
  const settings = { theme: 'green', themeHue: 140, themeSat: 85, themeGlow: 75,
    panelBright: 20, roomLighting: 'high', backdrop, textScale: 115, sessionRow: 'inbox',
    flicker: false, crtGlass: 'off', staticLevel: 45, sound: false, keepComputerAwake: false, notifyPrefs: { sound: false } };
  const collect = new Function('store', 'notifyDefaults', 'resolveRoomLighting',
    ui.slice(collectStart, collectEnd) + '\nreturn browserSections;')(
    { settings }, () => ({}), v => v);
  const sections = collect();
  const restored = Object.assign({ backdrop: 'city', textScale: 0, sessionRow: 'compact' }, sections.settings);
  for (const key of ['backdrop', 'textScale', 'sessionRow', 'roomLighting', 'staticLevel', 'theme', 'sound']) {
    ok(restored[key] === settings[key], 'P1-7: backup/import preserves ' + key + ' with ' + backdrop);
  }
  ok(!Object.hasOwn(sections.settings, 'notifyPrefs'), 'P1-7: notification settings retain their separate section');
}

// ---- P1-8 notification preferences ----
ok(/function notifyDefaults\(/.test(ui), 'P1-8: notifyDefaults defines the per-category prefs');
ok(/runComplete[\s\S]{0,80}needsApproval[\s\S]{0,80}cronDigest/.test(ui) || /needsApproval/.test(ui), 'P1-8: the named categories exist');
ok(/id="ntp-runComplete"/.test(ui) && /id="ntp-needsApproval"/.test(ui) && /id="ntp-cronDigest"/.test(ui) && /id="ntp-sound"/.test(ui), 'P1-8: a toggle per category + sound is rendered');
ok(/function wireNotifyPrefs\(/.test(ui), 'P1-8: the toggles are wired to persist');
// GATED AT EMIT TIME (not decorative): notify() consults the pref before pushing/toasting.
ok(/function notify\(text, cls, category(, opts)?\)/.test(ui), 'P1-8: notify() takes a category (EL-11 added the additive opts arg)');
ok(/if \(!pref\.show\) return/.test(ui), 'P1-8: a muted category is DROPPED at the emit point (honored, not decorative)');
ok(/notifyPrefOf\(/.test(ui), 'P1-8: notify() reads the persisted prefs');
// the three key call sites are actually TAGGED with categories
ok(/'needsApproval'\)/.test(chat), 'P1-8: the consent prompt notify is tagged needsApproval');
ok(/'runComplete'\)/.test(chat), 'P1-8: a run-produced-a-deliverable notify is tagged runComplete');
ok(/'cronDigest'\)/.test(appjs), 'P1-8: the while-you-were-away digest is tagged cronDigest');

// ---- P1-9 advanced runtime knobs ----
ok(/Runtime limits\s*<span class="dim">/.test(ui), 'P1-9: SETTINGS has an ADVANCED card');
ok(/function wireAdvanced\(/.test(ui), 'P1-9: wireAdvanced is wired');
ok(/\/api\/runtime\/knobs/.test(ui), 'P1-9: the card reads/writes /api/runtime/knobs');
ok(/environment variable always overrides|env-locked|envLocked/i.test(ui), 'P1-9: precedence (env wins) is disclosed + env-locked fields are shown');
for (const k of ['maxIters', 'maxConcurrentAgents', 'consentTimeoutMs', 'cronTickMs']) ok(new RegExp("key: '" + k + "'").test(ui), 'P1-9: knob offered: ' + k);

// ---- P1-10 memory controls ----
ok(/id="mc-reflect-on"/.test(ui), 'P1-10: MEMORY tab has a reflection on/off toggle');
ok(/id="mc-cooldown"/.test(ui), 'P1-10: MEMORY tab has a reflection cooldown control');
ok(/function loadReflectionConfig\(/.test(ui), 'P1-10: the reflection controls load + wire');
ok(/\/api\/memory\/config/.test(ui), 'P1-10: the controls read/write /api/memory/config');
ok(/mc-scope/.test(ui), 'P1-10: a "what the station may remember" scope note is shown');

console.log('settings-p1-ui.test.js OK —', n, 'assertions');
