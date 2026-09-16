'use strict';
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
const hostedProviders = ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'qwencloud'];

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
ok(/hasKey:\s*!!runtimeKey/.test(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8')),
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

ok(/function defaultModelFor\(provider\)[\s\S]*if \(p === 'custom'\) return ''/.test(app), 'custom defaultModelFor does not fall back to OpenRouter slugs');
ok(/custom:\s*\[\]/.test(app), 'custom FALLBACK_MODELS stays empty so offline UX does not inject OpenRouter ids');

console.log('provider-connections-ui.test.js OK -', n, 'assertions');
