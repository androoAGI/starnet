/* node test/provider-aliases-parity.test.js — every provider alias the PAGE knows is one the STATION knows too.

   The page normalises a provider id in four places (harness.js and app.js normalizeProviderId, keycta.js normProv,
   modeldock.js normalizeProvider). The station now REFUSES a provider it does not know (/api/run, the channel connect and
   sync routes, routines, /v1) instead of re-homing it on OpenRouter, so a page alias the registry lacks ('supergrok',
   'kimi-for-coding' — review r5) turned a working selection into a 400. Each table is read from its source (every
   `p === '<alias>'` on a line that returns '<id>'), and every alias must normalise in sidecar/providers/registry.js to the
   SAME id the page maps it to.

   Review r7 (m10): the DESKTOP SHELL has a table too (src-tauri/src/credentials.rs known_provider, behind normalize_provider),
   and it filed every id it did not know under "openrouter": a 'supergrok', 'kimi-for-coding' or 'starnet' key push landed in
   the OpenRouter keychain slot and went out as the OpenRouter key. The Rust table is read from its match arms and must agree
   with the registry both ways and with every page alias; harness_store_provider_key refuses an id it does not know. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const Reg = require('../sidecar/providers/registry.js');

const APP = path.join(__dirname, '..', 'frontend', 'app');
const TABLES = [['harness.js', '  function normalizeProviderId(provider) {'], ['app.js', '  function normalizeProviderId(provider) {'],
  ['keycta.js', '  function normProv(p) {'], ['modeldock.js', '  function normalizeProvider(p) {']];

const { functionSourceIn } = require('./helpers/source.js');
const pageAliases = new Map();
for (const profile of Reg.listProviderProfiles()) for (const alias of [profile.id].concat(profile.aliases || [])) pageAliases.set(alias, profile.id);
for (const [file, head] of TABLES) {
  const src = fs.readFileSync(path.join(APP, file), 'utf8');
  const name = /function (\w+)/.exec(head)[1];
  const fn = functionSourceIn(src, name);
  A.ok(file === 'modeldock.js'
    ? fn.includes('providerRegistry.normalizeProviderId') && src.includes("require('./provider-registry.js') : SK.providers.registry")
    : fn.includes('SK.providers.registry.normalizeProviderId'), file + ': delegates to the shared registry');
  const normalize = file === 'modeldock.js' ? require('../frontend/app/modeldock.js').labels.normProvider
    : new Function('SK', 'return (' + fn + ');')({ providers: { registry: Reg } });
  for (const [alias, id] of pageAliases) A.eq(normalize(alias), id, file + ': ' + alias + ' follows the registry');
  A.eq(normalize('unknown-provider'), '', file + ': unknown provider never becomes OpenRouter');
}
A.eq(fs.readFileSync(path.join(APP, 'provider-registry.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../sidecar/providers/registry.js'), 'utf8'), 'browser registry is an exact generated copy');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
A.ok(html.indexOf('app/provider-registry.js') < html.indexOf('app/harness.js'), 'browser loads the registry before its consumers');

// ---- the desktop shell's table (src-tauri/src/credentials.rs known_provider) ----
const TAURI = path.join(__dirname, '..', 'src-tauri', 'src');
const rs = fs.readFileSync(path.join(TAURI, 'credentials.rs'), 'utf8');
const rsAt = rs.indexOf("pub(crate) fn known_provider(provider: &str) -> Option<&'static str> {");
A.ok(rsAt >= 0, 'credentials.rs declares known_provider (the shell table that can say "not a provider")');
const rsBody = rsAt >= 0 ? rs.slice(rsAt, rs.indexOf('\n}\n', rsAt)) : '';
const rust = new Map();
for (const m of rsBody.split('\n').map(line => /^\s*("[^"]+"(?:\s*\|\s*"[^"]+")*)\s*=>\s*"([^"]+)",\s*$/.exec(line)).filter(Boolean)) {
  for (const alias of m[1].match(/"[^"]+"/g).map(q => q.slice(1, -1))) {
    A.ok(!rust.has(alias), 'credentials.rs: "' + alias + '" is in one arm only');
    rust.set(alias, m[2]);
  }
}
A.ok(/\n\s*_ => return None,\n/.test(rsBody), 'credentials.rs: an id the table does not name is None, never filed under openrouter');
A.ok(rust.size >= 40, 'fixture: the Rust table was read (' + rust.size + ' ids)');
for (const [alias, id] of rust) {
  A.eq(Reg.normalizeProviderId(alias, ''), id, 'credentials.rs: "' + alias + '" normalises in the registry to the shell\'s "' + id + '"');
}
for (const p of Reg.listProviderProfiles()) {
  for (const alias of [p.id].concat(p.aliases || [])) A.eq(rust.get(alias), p.id, 'credentials.rs knows the registry\'s "' + alias + '" as "' + p.id + '"');
}
for (const [alias, id] of pageAliases) A.eq(rust.get(alias), id, 'credentials.rs knows the page\'s "' + alias + '" as "' + id + '"');
// normalize_provider keeps the legacy OpenRouter keychain account for an unknown id (the read paths), through the one table
A.ok(/pub\(crate\) fn normalize_provider\(provider: &str\) -> &'static str \{\s*known_provider\(provider\)\.unwrap_or\("openrouter"\)\s*\}/.test(rs),
  'credentials.rs: normalize_provider is known_provider with the legacy openrouter fallback (one table)');
// the store command refuses an id it does not know instead of writing the OpenRouter slot
const main = fs.readFileSync(path.join(TAURI, 'main.rs'), 'utf8');
const cmdAt = main.indexOf('fn harness_store_provider_key(');
const cmd = cmdAt >= 0 ? main.slice(cmdAt, main.indexOf('\n}\n', cmdAt)) : '';
A.ok(/let provider_id = known_provider\(&provider\)\s*\.ok_or_else\(/.test(cmd) && !/normalize_provider\(/.test(cmd),
  'harness_store_provider_key refuses a provider id it does not know (an error, never the OpenRouter slot)');
A.ok(/provider_id != "starnet"/.test(cmd), "harness_store_provider_key writes no keychain key for starnet (its bearer is the station's device link)");
// review r8: ...and REFUSES a starnet key before anything is pushed — it never lands in the sidecar's runtime key table
{
  const refuse = /\n    if provider_id == "starnet" && matches!\(key_trimmed\.as_deref\(\), Some\(k\) if !k\.is_empty\(\)\) \{\n        return Err\(/.exec(cmd);
  A.ok(!!refuse && refuse.index < cmd.indexOf('push_provider_config('), 'harness_store_provider_key returns an error for a starnet key, before any push_provider_config');
}
const uses = (/\nuse credentials::\{([\s\S]*?)\};/.exec(main) || [])[1] || '';
A.ok(/\bknown_provider\b/.test(uses), 'main.rs imports known_provider from credentials');
A.report('provider-aliases-parity: every provider alias the page and the desktop shell know normalises in the station registry');
