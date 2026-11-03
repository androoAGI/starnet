/* node test/credential-store.spawn-adoption.test.js — the desktop shell's spawn keys become the credential store's keychain
   layer and leave the environment; nothing else does (credential-store lane, step S2; family B1, credential sources).

   THE BUG (doneMeans 1). The desktop shell hands the sidecar the OS keychain's provider keys and key pools as environment
   variables at spawn (src-tauri main.rs sidecar_command), and they stayed there. A removal in Settings deleted the keychain
   entry and pushed an empty key (POST /api/key), which emptied the store's keychain layer, but the environment copy went on
   serving the removed key: /api/providers said configured, and routines sent it upstream (probe-remove-desktop). A key
   rotation left the old key in the environment too, and a bare OS export of the same provider (ANTHROPIC_API_KEY set for
   another tool) outranked the Settings key because the env layer reads the bare name first (probe R5).

   THE RULE. Under the shell's marker (STARNET_DESKTOP_SHELL=1, which every spawn sets) index.js's first statements after
   the connector key hand process.env to credential-store.js adoptSpawnCredentials, which takes each pair the shell could
   have written — both spellings, one value: set_sidecar_branded_env — into the keychain layer and deletes both spellings.
   One spelling, two values and a bare name are the user's own exports and stay. Without the marker nothing moves.

   WHAT IS LOCKED
   1. The shell's side, read from its source as text (like provider-aliases-parity): the marker it sets, that it writes
      every value in both spellings, and the names it writes (credentials.rs SIDECAR_PROVIDER_KEY_ENVS, OpenRouter's key,
      a KEY_POOL_<ID> per KEYCHAIN_PROVIDERS entry). Each is a name this store reads for that provider.
   2. index.js adopts at its top, before any other module loads, with process.env itself and the shell's exact marker.
   3. No sidecar module reads a provider key's env variable except through the store, so deleting the shell's copy
      strands no reader.
   4. Every name the shell writes is adopted and deleted under the marker; none without it; never one spelling, two
      values, a blank pair or a bare name; a later name of the same provider leaves env only with the adopted value.
   5. Through index.js's own wiring (the adoption statement and the store construction, lifted): the station resolves the
      adopted key from the keychain layer and its env no longer holds it; a REMOVE leaves no key, or the user's own export,
      and the readout (credentialSource, envName) says which; a headless station is untouched.
   Rows 1-3 read source text and run first; the store is loaded after them, so a tree without it (trunk) reports what it
   lacks instead of stopping at the require. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const Reg = require('../sidecar/providers/registry.js');
const { readSidecarIndex, sidecarSourceFiles } = require('./helpers/source.js');

const PROFILES = Reg.listProviderProfiles({ includeInactive: true, public: false });
const keyEnvOf = id => (Reg.getProviderProfile(id) || {}).keyEnv || [];

/* ---- 1. the shell's side ---- */
const TAURI = path.join(__dirname, '..', 'src-tauri', 'src');
const rs = fs.readFileSync(path.join(TAURI, 'credentials.rs'), 'utf8');
const main = fs.readFileSync(path.join(TAURI, 'main.rs'), 'utf8');
// a Rust table (up to its '];') or function (up to its closing brace at column 0), from its head
const block = (text, head, label) => {
  const at = text.indexOf(head);
  A.ok(at >= 0, 'fixture: ' + label + ' is still declared');
  const end = at < 0 ? -1 : text.indexOf(head.startsWith('fn ') ? '\n}\n' : '];', at);
  return at >= 0 && end > at ? text.slice(at, end) : '';
};
const envTable = block(rs, 'pub(crate) const SIDECAR_PROVIDER_KEY_ENVS: [(&str, &str); ', 'credentials.rs SIDECAR_PROVIDER_KEY_ENVS');
const SHELL_KEYS = Array.from(envTable.matchAll(/\("([a-z-]+)",\s*"(SKYNET_[A-Z0-9_]+)"\)/g)).map(m => ({ provider: m[1], name: m[2] }));
A.eq(SHELL_KEYS.length, Number((/; (\d+)\] = \[/.exec(envTable) || [])[1]), 'fixture: every row of SIDECAR_PROVIDER_KEY_ENVS was read (' + SHELL_KEYS.length + ')');
const poolTable = block(rs, 'pub(crate) const KEYCHAIN_PROVIDERS: [&str; ', 'credentials.rs KEYCHAIN_PROVIDERS');
const POOL_PROVIDERS = Array.from(poolTable.matchAll(/"([a-z-]+)"/g)).map(m => m[1]);
A.eq(POOL_PROVIDERS.length, Number((/; (\d+)\] = \[/.exec(poolTable) || [])[1]), 'fixture: every KEYCHAIN_PROVIDERS entry was read (' + POOL_PROVIDERS.length + ')');
A.ok(SHELL_KEYS.length >= 12 && POOL_PROVIDERS.includes('openrouter') && POOL_PROVIDERS.includes('custom'), 'fixture: the tables are the ones the shell spawns with');

const branded = block(main, 'fn set_sidecar_branded_env<V: AsRef<OsStr>>(cmd: &mut Command, legacy_name: &str, value: V) {', 'main.rs set_sidecar_branded_env');
A.ok(/\n    cmd\.env\(legacy_name, value\);\n    if let Some\(suffix\) = legacy_name\.strip_prefix\("SKYNET_"\) \{\n        cmd\.env\(format!\("STARNET_\{suffix\}"\), value\);/.test(branded),
  'set_sidecar_branded_env writes the SKYNET_ name and its STARNET_ spelling with the SAME value (what adoption looks for)');
const spawnCmd = block(main, 'fn sidecar_command(state: &AppState, entry: &Path, node: &Path) -> Command {', 'main.rs sidecar_command');
A.ok(/\.env\("STARNET_DESKTOP_SHELL", "1"\)/.test(spawnCmd), 'every shell spawn sets STARNET_DESKTOP_SHELL=1 (the marker adoption keys on)');
A.ok(/if let Some\(key\) = read_key\(\) \{\n        set_sidecar_branded_env\(&mut cmd, "SKYNET_OPENROUTER_KEY", key\);/.test(spawnCmd), 'the shell writes the OpenRouter keychain key as SKYNET_OPENROUTER_KEY, in both spellings');
A.ok(/for \(provider, env_name\) in SIDECAR_PROVIDER_KEY_ENVS \{\n        if let Some\(key\) = read_key_for\(provider\) \{\n            set_sidecar_branded_env\(&mut cmd, env_name, key\);/.test(spawnCmd), '...each SIDECAR_PROVIDER_KEY_ENVS key, in both spellings');
A.ok(/for provider in KEYCHAIN_PROVIDERS \{[\s\S]*?"SKYNET_KEY_POOL_\{\}",\s*provider\.to_ascii_uppercase\(\)\.replace\('-', "_"\)[\s\S]*?set_sidecar_branded_env\(&mut cmd, &env_name, pool\.join\(","\)\);/.test(spawnCmd),
  '...and each KEYCHAIN_PROVIDERS pool as SKYNET_KEY_POOL_<ID>, comma-joined, in both spellings');
A.ok(!/env_remove\("(?:SKYNET|STARNET)_[A-Z_]*(?:API_KEY|OPENROUTER_KEY|KEY_POOL)/.test(spawnCmd), 'fixture: the shell never removes an inherited branded key name (a user\'s single-spelling export reaches the sidecar)');
// each name the shell writes is one this store reads for that provider
for (const { provider, name } of SHELL_KEYS.concat([{ provider: 'openrouter', name: 'SKYNET_OPENROUTER_KEY' }])) {
  A.ok(keyEnvOf(provider).includes(name.replace(/^SKYNET_/, '')), 'the shell\'s ' + name + ' is a ' + provider + ' keyEnv name in the registry');
}

/* ---- 2. index.js adopts at its top ---- */
{
  // the one place this test reads index.js as it stands: where the adoption sits is index.js's own structure
  const idx = readSidecarIndex();
  const consumed = idx.indexOf('delete process.env.STARNET_CONNECTOR_KEY_ERROR;\n');
  const stmt = "const SPAWN_CREDENTIALS = credentialStore.adoptSpawnCredentials(process.env, {\n  desktopShell: process.env.STARNET_DESKTOP_SHELL === '1',\n  profiles: require('./providers/registry.js').listProviderProfiles({ includeInactive: true, public: false })\n});\n";
  const at = idx.indexOf(stmt);
  A.ok(consumed > 0 && at > consumed, 'index.js adopts the shell\'s keys right after it consumes the connector key, with process.env itself and the shell\'s exact marker');
  const between = idx.slice(consumed, at + stmt.length);
  A.eq((between.match(/require\(\s*'[^']+'\s*\)/g) || []), ["require('./credential-store.js')", "require('./providers/registry.js')"], '...before any other module loads (nothing can copy process.env first)');
  A.eq((idx.match(/require\('\.\/credential-store\.js'\)/g) || []).length, 1, 'index.js loads the store once, there');
  const make = idx.slice(idx.indexOf('const credStore = credentialStore.makeCredentialStore({'), idx.indexOf('\ncredStore.loadKeptEndpoints();'));
  A.ok(/\n  spawn: SPAWN_CREDENTIALS,\n/.test(make) && /\n  envName: envFirstName,\n/.test(make), 'the store is seeded with what was adopted, and reads the env layer\'s variable names');
  A.ok(!/\n  alias:/.test(make), 'index.js hands the store no alias value of its own: the store reads it after the adoption');
}

/* ---- 3. no sidecar module reads a provider key's env variable except through the store ---- */
{
  const names = new Set();
  for (const p of PROFILES) for (const n of p.keyEnv || []) names.add(n);
  const BLOCK = /\/\*[\s\S]*?\*\//g, LINE = /(^|[^:'"`\\])\/\/[^\n]*/g;
  const code = text => text.replace(BLOCK, m => m.replace(/[^\n]/g, ' ')).replace(LINE, '$1');
  const nameRe = new RegExp('(?:^|[^A-Z0-9_])(?:(?:STARNET|SKYNET)_)?(?:' + Array.from(names).join('|') + ')(?![A-Z0-9_])|KEY_POOL');
  const hits = [];
  for (const f of sidecarSourceFiles()) {
    if (f.rel === 'sidecar/credential-store.js' || f.rel === 'sidecar/providers/registry.js') continue;   // the store; the names' table
    code(f.text).split('\n').forEach((line, i) => { if (nameRe.test(line)) hits.push({ file: f.rel, line: i + 1, text: line.trim() }); });
  }
  // the two lines that name one and read no station credential, each pinned to exactly what it is
  const channelMeta = hits.filter(h => h.file === 'sidecar/channels/registry.js');
  const childRead = hits.filter(h => h.file === 'sidecar/providers/claude-cli.js');
  A.ok(channelMeta.length > 0 && channelMeta.every(h => /keyVar: 'SKYNET_OPENROUTER_KEY'/.test(h.text)), 'channels/registry.js names it only as descriptor metadata (keyVar)');
  const allCode = sidecarSourceFiles().map(f => code(f.text)).join('\n');
  A.ok(!/\.keyVar\b|\[\s*['"]keyVar['"]\s*\]|\{[^}]*\bkeyVar\b[^}]*\}\s*=/.test(allCode), '...which no sidecar code reads');
  A.ok(childRead.length === 1 && /childEnv\(\)\.ANTHROPIC_API_KEY/.test(childRead[0].text), 'claude-cli.js reads ANTHROPIC_API_KEY only from the environment its child gets (child-env.js), never the station\'s: ' + JSON.stringify(childRead));
  const others = hits.filter(h => h.file !== 'sidecar/channels/registry.js' && h.file !== 'sidecar/providers/claude-cli.js');
  A.eq(others.map(h => h.file + ':' + h.line + ' ' + h.text.slice(0, 120)), [], 'no other sidecar code names a provider key\'s env variable or a key pool: it asks the store');
  // and a name built from the registry: only the store reads env by it; index.js uses the names for words, never a read
  const keyEnvReads = [];
  for (const f of sidecarSourceFiles()) {
    if (f.rel === 'sidecar/credential-store.js' || f.rel === 'sidecar/providers/registry.js') continue;
    code(f.text).split('\n').forEach((line, i) => { if (/\.keyEnv\b/.test(line)) keyEnvReads.push(f.rel + ':' + line.trim()); });
  }
  A.eq(keyEnvReads.length, 2, 'outside the store, two lines read a profile\'s keyEnv names: ' + JSON.stringify(keyEnvReads));
  A.ok(keyEnvReads.some(l => /envOf\(profile && profile\.keyEnv\)/.test(l)), '...the refusal sentence names the variable to set (engineCredentialError)');
  A.ok(keyEnvReads.some(l => /for \(const n of \(p\.keyEnv \|\| \[\]\)\) \{ names\.add\(n\);/.test(l)), '...and the KEYS tab refuses to export one (SERVICEKEYS_RESERVED_ENV)');
  // the env layer's readers: index.js declares them and hands them to the store; nothing else calls them
  const callers = {};
  for (const f of sidecarSourceFiles()) {
    if (f.rel === 'sidecar/credential-store.js') continue;
    const calls = (code(f.text).match(/.*\benvFirst(?:Name)?\(.*/g) || []).map(l => l.trim());
    if (calls.length) callers[f.rel] = calls;
  }
  A.eq(callers, { 'sidecar/index.js': ['function envFirstName(names) {', 'function envFirst(names) {', 'const name = envFirstName(names);'] },
    'envFirst and envFirstName are called by nobody but each other and the store (index.js hands them over)');
}

/* ---- the store, loaded after the source rows ---- */
let CS = null, G = null;
try { CS = require('../sidecar/credential-store.js'); G = require('./helpers/credential-store-sandbox.js'); }
catch (e) { A.ok(false, 'sidecar/credential-store.js loads (the store and its adoption): ' + ((e && e.message) || e).split('\n')[0]); }
const adopt = (env, desktopShell) => CS.adoptSpawnCredentials(env, { desktopShell, profiles: PROFILES });
if (CS) {
  /* ---- 4. adoption itself ---- */
  // the spawn environment the shell builds, from its own tables: every value in both spellings
  const KEY = p => 'shell-key-for-' + p + '-0123456789';
  const POOL = p => ['pool-a-' + p, 'pool-b-' + p];
  function shellEnv() {
    const env = { STARNET_DESKTOP_SHELL: '1', PATH: '/usr/bin' };
    const put = (name, value) => { env[name] = value; env['STARNET_' + name.replace(/^SKYNET_/, '')] = value; };
    put('SKYNET_OPENROUTER_KEY', KEY('openrouter'));
    for (const { provider, name } of SHELL_KEYS) put(name, KEY(provider));
    for (const p of POOL_PROVIDERS) put('SKYNET_KEY_POOL_' + p.toUpperCase().replace(/-/g, '_'), POOL(p).join(','));
    return env;
  }
  {
    const env = shellEnv();
    const injected = Object.keys(env).filter(n => /^(?:STARNET|SKYNET)_/.test(n) && n !== 'STARNET_DESKTOP_SHELL').sort();
    const got = adopt(env, true);
    A.eq(Object.keys(got.keys).sort(), Array.from(new Set(['openrouter'].concat(SHELL_KEYS.map(k => k.provider)))).sort(), 'under the marker every provider the shell injects a key for is adopted');
    for (const p of Object.keys(got.keys)) if (got.keys[p] !== KEY(p)) A.ok(false, p + ' is adopted with its own key, never another provider\'s: ' + got.keys[p]);
    A.eq(Object.keys(got.pools).sort(), POOL_PROVIDERS.slice().sort(), '...and every provider it injects a pool for');
    for (const p of POOL_PROVIDERS) A.eq(got.pools[p], POOL(p), p + '\'s pool is split as the shell joined it');
    A.eq(got.names.slice().sort(), injected, 'adoption deletes exactly the names the shell injected, both spellings');
    A.eq(Object.keys(env).sort(), ['PATH', 'STARNET_DESKTOP_SHELL'], 'the environment holds none of them afterwards');
  }
  {
    const env = shellEnv();
    delete env.STARNET_DESKTOP_SHELL;
    const before = JSON.stringify(env);
    const got = adopt(env, false);
    A.eq([Object.keys(got.keys).length, Object.keys(got.pools).length, got.names.length, JSON.stringify(env) === before], [0, 0, 0, true],
      'without the marker (bin/starnet.js, servers, CI) nothing is adopted and nothing is deleted');
  }
  {
    // a user's own exports are never adopted: one spelling, two values, a blank pair, padding that differs, a bare name
    const env = {
      STARNET_ANTHROPIC_API_KEY: 'only-one-spelling-key-0123',
      STARNET_MISTRAL_API_KEY: 'starnet-value-0123456789', SKYNET_MISTRAL_API_KEY: 'skynet-value-0123456789',
      STARNET_GROQ_API_KEY: '', SKYNET_GROQ_API_KEY: '',
      STARNET_OPENAI_API_KEY: ' padded-key-0123456789', SKYNET_OPENAI_API_KEY: 'padded-key-0123456789',
      DEEPSEEK_API_KEY: 'bare-export-0123456789', OPENROUTER_API_KEY: 'bare-openrouter-0123456789',
      STARNET_KEY_POOL_ANTHROPIC: 'p1,p2'
    };
    const before = JSON.stringify(env);
    const got = adopt(env, true);
    A.eq([Object.keys(got.keys), Object.keys(got.pools), JSON.stringify(env) === before], [[], [], true],
      'one spelling, two values, a blank pair, a padded twin, bare names and a one-spelling pool all stay in the env layer');
  }
  {
    // a later keyEnv name of the same provider: the same value leaves with the adopted pair, another value stays
    const same = { STARNET_GEMINI_API_KEY: 'gk-0123456789', SKYNET_GEMINI_API_KEY: 'gk-0123456789', STARNET_GOOGLE_API_KEY: 'gk-0123456789', SKYNET_GOOGLE_API_KEY: 'gk-0123456789' };
    A.eq([adopt(same, true).keys.gemini, Object.keys(same)], ['gk-0123456789', []], 'a second name holding the adopted value leaves env too (no copy of the key lingers)');
    const other = { STARNET_GEMINI_API_KEY: 'gk-0123456789', SKYNET_GEMINI_API_KEY: 'gk-0123456789', STARNET_GOOGLE_API_KEY: 'other-9876543210', SKYNET_GOOGLE_API_KEY: 'other-9876543210' };
    A.eq([adopt(other, true).keys.gemini, Object.keys(other).sort()], ['gk-0123456789', ['SKYNET_GOOGLE_API_KEY', 'STARNET_GOOGLE_API_KEY']], '...one holding another value stays (a user\'s export, read below the keychain key)');
    const later = { STARNET_GOOGLE_AI_API_KEY: 'gai-0123456789', SKYNET_GOOGLE_AI_API_KEY: 'gai-0123456789' };
    A.eq(adopt(later, true).keys.gemini, 'gai-0123456789', 'a pair under any of the provider\'s names is the keychain key when it is the only one');
  }

  /* ---- 5. through index.js's own wiring ---- */
  const wired = G.wiredImpl();
  const station = (env, extra) => wired(Object.assign({ env, kept: { on: true }, pushes: [] }, extra || {}));
  const src = (api, id) => { const p = api.presence(id); return p.credentialSource + (p.envName ? ':' + p.envName : ''); };
  {
    const api = station(shellEnv());
    for (const p of ['anthropic', 'openrouter', 'custom', 'mistral']) A.eq(src(api, p), 'keychain', p + ': the shell\'s key is the keychain layer\'s');
    A.eq(api.key('anthropic', ''), KEY('anthropic'), 'a station run goes out on it');
    A.eq(Object.keys(api.host.env).filter(n => /API_KEY|OPENROUTER_KEY|CUSTOM_OPENAI_KEY|KEY_POOL/.test(n)), [], 'and the station\'s environment holds no provider key or pool');
    A.eq(api.keychainValues().keys.includes(KEY('anthropic')), true, 'the adopted key is a held value from boot (redaction and the child-env value rule see it)');
    api.push('anthropic', { key: '' });
    A.eq([api.key('anthropic', ''), src(api, 'anthropic'), api.presence('anthropic').unattendedReady], ['', 'none', false], 'the shell\'s REMOVE leaves no key anywhere, and presence says so');
    api.push('openrouter', { key: 'rotated-openrouter-key-0123' });
    A.eq([api.key('openrouter', ''), api.alias(), api.stationHeld('openrouter', KEY('openrouter'))], ['rotated-openrouter-key-0123', 'rotated-openrouter-key-0123', false], 'a rotation: the new key everywhere, the old one held nowhere');
    api.push('custom', { keyPool: [] });
    A.eq(api.keyPool('custom'), [], 'a pool the shell cleared stays cleared (no spawn copy comes back)');
  }
  {
    // D1: the shell's key beside a bare OS export of the same provider (probe R5), and a single-spelling export
    const api = station({ STARNET_DESKTOP_SHELL: '1', STARNET_ANTHROPIC_API_KEY: 'kc-0123456789', SKYNET_ANTHROPIC_API_KEY: 'kc-0123456789', ANTHROPIC_API_KEY: 'os-0123456789',
      STARNET_MISTRAL_API_KEY: 'mine-0123456789' });
    A.eq([api.key('anthropic', ''), src(api, 'anthropic')], ['kc-0123456789', 'keychain'], 'D1: the keychain key outranks the bare OS export');
    A.eq(src(api, 'mistral'), 'environment:STARNET_MISTRAL_API_KEY', 'a single-spelling export is the env layer\'s, and the readout names it');
    api.push('anthropic', { key: '' });
    api.push('mistral', { key: '' });
    A.eq([api.key('anthropic', ''), src(api, 'anthropic')], ['os-0123456789', 'environment:ANTHROPIC_API_KEY'], 'after the REMOVE the user\'s own export serves, and the readout names it');
    A.eq([api.key('mistral', ''), src(api, 'mistral')], ['mine-0123456789', 'environment:STARNET_MISTRAL_API_KEY'], '...and a single-spelling export survives a REMOVE');
    const lines = api.host.warns.filter(w => /^\[credentials\]/.test(w));
    A.ok(lines.length === 2 && /ANTHROPIC_API_KEY still holds one/.test(lines[0]) && /STARNET_MISTRAL_API_KEY still holds one/.test(lines[1]), 'each REMOVE that leaves an env key serving says so in one line naming the variable: ' + JSON.stringify(lines));
    A.ok(!lines.join('\n').includes('0123456789'), '...and never a key');
  }
  {
    // headless: the same branded pair without the marker is an operator's export, untouched
    const env = { STARNET_ANTHROPIC_API_KEY: 'hk-0123456789', SKYNET_ANTHROPIC_API_KEY: 'hk-0123456789', SKYNET_OPENROUTER_KEY: 'hor-0123456789' };
    const api = station(Object.assign({}, env));
    A.eq(Object.keys(api.host.env).filter(n => n !== 'STARNET_IPC_TOKEN').sort(), Object.keys(env).sort(), 'headless: nothing is adopted or deleted');
    A.eq([api.key('anthropic', ''), src(api, 'anthropic')], ['hk-0123456789', 'environment:STARNET_ANTHROPIC_API_KEY'], '...the env key serves, and the readout names its variable');
    A.eq([api.key('openrouter', ''), src(api, 'openrouter')], ['hor-0123456789', 'environment:SKYNET_OPENROUTER_KEY'], '...the legacy OpenRouter alias is an environment variable, named, not a keychain');
    A.eq(api.presence('anthropic').keySource, 'environment', '...and the page still reads keySource environment');
    api.push('openrouter', { key: 'pushed-0123456789' });
    A.eq(src(api, 'openrouter'), 'keychain', 'a push replaces the alias with a keychain key');
  }
  {
    // every other source the readout names
    const page = station({}, { page: { mistral: { key: 'page-0123456789', rev: 'r1' } } });
    A.eq(src(page, 'mistral'), 'page', 'a browser page copy reads page');
    A.eq([src(station({}, { linked: { url: 'http://li.test', apiKey: 'li' } }), 'starnet'), src(station({}), 'starnet')], ['linked', 'none'], 'StarNet reads linked, or none unlinked');
    A.eq(['codex', 'grok', 'kimi'].map(p => src(station({}), p)), ['sign-in', 'sign-in', 'sign-in'], 'the sign-ins read sign-in (their bearer is not a key this store holds)');
    A.eq(src(station({}), 'anthropic'), 'none', 'nothing anywhere reads none');
  }

}

A.report('credential-store.spawn-adoption');
