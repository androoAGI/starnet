/* node test/channels.secrets.test.js — the channel-token keychain seam (T1.4).

   Proves the pure token-vs-config split + migration logic (sidecar/channels/secrets.js) and static-guards the
   host wiring on BOTH sides:
     • splitSecret pulls the bot token out and leaves every non-secret field.
     • stripTokens removes every channel token (what the desktop build persists) and keeps the rest.
     • migratePlaintext: bare mode = untouched; desktop mode imports the plaintext token AND strips it; an
       already-migrated channel (keychain has it) is stripped but NOT re-imported; a tokenless config is a no-op. A provider key is
       the channel reconciliation's (section K), which runs first.
     • the sidecar host resolves tokens from runtime/env and strips before writing under STARNET_DESKTOP_SHELL,
       and exposes a token-gated /api/channels/token push that never echoes the token.
     • the Rust shell injects SKYNET_<ID>_TOKEN from the keychain, migrates plaintext, and gates the command. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const S = require('../sidecar/channels/secrets.js');

const root = path.resolve(__dirname, '..');

// ---- A. splitSecret: BOTH secrets (token + key) out, everything else stays ----
{
  const { config, token } = S.splitSecret({ token: 'BOT:123', key: 'sk-live-abc', model: 'x/y', enabled: true, ownerId: '42' });
  A.eq(token, 'BOT:123', 'splitSecret extracts the token');
  A.eq(config, { model: 'x/y', enabled: true, ownerId: '42' }, 'splitSecret keeps every non-secret field');
  A.ok(!('token' in config), 'splitSecret config carries no token');
  A.ok(!('key' in config), 'splitSecret config carries no provider key (P1 hygiene)');   // the leak this fix closes
  A.eq(S.splitSecret({ model: 'x/y' }).token, '', 'splitSecret token is empty when absent');
  A.eq(S.splitSecret(null).config, {}, 'splitSecret tolerates a non-object record');
  // a record that ONLY carries a key (no bot token) still loses the key and reports no token
  const k = S.splitSecret({ key: 'sk-only', model: 'm' });
  A.eq(k.token, '', 'splitSecret: no token to extract when only a key is present');
  A.ok(!('key' in k.config), 'splitSecret: a lone provider key is still stripped');
  A.ok('STRIP_FIELDS' in S && S.STRIP_FIELDS.indexOf('key') >= 0, 'STRIP_FIELDS lists the provider key');
}

// ---- B. stripTokens: every channel token AND provider key gone, non-channel keys untouched ----
{
  const secrets = {
    telegram: { token: 'T:1', key: 'sk-tg', model: 'm1', enabled: true },
    discord: { token: 'D:2', key: 'sk-dc', model: 'm2', ownerId: 'o' },
    notifyAutonomous: true
  };
  const stripped = S.stripTokens(secrets);
  A.ok(!stripped.telegram.token && !stripped.discord.token, 'stripTokens removes both channel tokens');
  A.ok(!('key' in stripped.telegram) && !('key' in stripped.discord), 'stripTokens removes both provider keys (P1)');
  A.eq(stripped.telegram, { model: 'm1', enabled: true }, 'stripTokens keeps telegram config');
  A.eq(stripped.discord, { model: 'm2', ownerId: 'o' }, 'stripTokens keeps discord config');
  A.eq(stripped.notifyAutonomous, true, 'stripTokens keeps non-channel keys');
  // the whole persisted blob must contain no secret substring anywhere
  const blob = JSON.stringify(stripped);
  A.ok(blob.indexOf('T:1') < 0 && blob.indexOf('D:2') < 0 && blob.indexOf('sk-tg') < 0 && blob.indexOf('sk-dc') < 0,
    'stripTokens output serializes with NO token/key substring');
  // original is not mutated
  A.eq(secrets.telegram.token, 'T:1', 'stripTokens does not mutate the input');
  A.eq(secrets.telegram.key, 'sk-tg', 'stripTokens does not mutate the input key');
}

// ---- C. migratePlaintext: bare mode leaves everything (plaintext fallback) ----
{
  const secrets = { telegram: { token: 'T:1', model: 'm' } };
  const res = S.migratePlaintext(secrets, { keychainMode: false });
  A.eq(res.config, secrets, 'bare mode: config is untouched');
  A.eq(res.imports, [], 'bare mode: nothing to import');
  A.eq(res.changed, false, 'bare mode: unchanged');
}

// ---- B2. Agent-bound Telegram bots obey the same keychain/last-copy split as the station bot ----
{
  const secrets = {
    telegramBots: {
      '101': { token: 'BOT:101', key: 'sk-101', model: 'm', agentId: 'a' },
      '202': { token: 'BOT:202', key: 'sk-202', model: 'm', agentId: 'b' }
    }
  };
  const out = S.stripTokens(secrets, (id) => id === 'telegram:101');
  A.ok(!('token' in out.telegramBots['101']), 'nested durable bot token is stripped');
  A.eq(out.telegramBots['202'].token, 'BOT:202', 'nested non-durable bot keeps its last plaintext copy');
  A.ok(!('key' in out.telegramBots['101']) && !('key' in out.telegramBots['202']), 'nested provider keys are always stripped on desktop');
  A.eq(S.telegramBotSecretId('101'), 'telegram:101', 'numeric bot id maps to its closed keychain namespace');
  A.eq(S.telegramBotSecretId('../bad'), '', 'malformed bot id cannot enter the keychain namespace');
  A.eq(S.telegramBotSecretId('123456789012345678901'), '', 'oversized bot id cannot enter the keychain namespace');

  const migrated = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: (id) => id === 'telegram:101' });
  A.ok(!('token' in migrated.config.telegramBots['101']), 'nested migration strips a read-back-proven token');
  A.eq(migrated.config.telegramBots['202'].token, 'BOT:202', 'nested migration preserves an unproven last copy');
  A.eq(migrated.imports.map(i => i.id).sort(), ['telegram:101', 'telegram:202'], 'nested tokens are reported under per-bot keychain ids');

  const rotated = S.stripTokens({ telegramBots: { '101': { token: 'BOT:new', model: 'm' } } },
    (_id, candidate) => candidate === 'BOT:old');
  A.eq(rotated.telegramBots['101'].token, 'BOT:new', 'an old keychain value cannot falsely prove a rotated token durable');
}

// ---- D. migratePlaintext: desktop mode WITHOUT keychain proof KEEPS the token (never destroys the last copy) ----
//   Andrew's invariant: never remove the last copy of a secret without proof another durable home holds it. When
//   hasChannelToken(id) is false the keychain provably does NOT have the token, so the plaintext copy is the only
//   home — keep it. A provider `key` is not this function's: the reconciliation moved it before this runs. The token is STILL
//   reported as an import so the shell can adopt it into the keychain this launch (self-heal).
{
  const secrets = { telegram: { token: 'T:1', key: 'sk-tg', model: 'm', enabled: true }, discord: { token: 'D:2', key: 'sk-dc', model: 'm2' }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => false });
  A.eq(res.changed, false, 'desktop w/o keychain: nothing proven, nothing removed');
  A.eq(res.config.telegram.token, 'T:1', 'desktop w/o keychain: token KEPT in persisted config (last copy)');
  A.eq(res.config.discord.token, 'D:2', 'desktop w/o keychain: discord token KEPT too');
  A.eq(res.config.telegram, secrets.telegram, 'desktop: a provider key is left to the reconciliation (it runs first, and only it can move a key)');
  A.eq(res.config.notifyAutonomous, true, 'desktop: non-channel keys preserved');
  const ids = res.imports.map(i => i.id).sort();
  A.eq(ids, ['discord', 'telegram'], 'desktop: both tokens reported for keychain import (self-heal)');
  A.eq(res.imports.find(i => i.id === 'telegram').token, 'T:1', 'desktop: import carries the real token');
  // a KEY is NEVER handed back as an import (nothing for the sidecar to adopt)
  A.ok(!res.imports.some(i => 'key' in i || i.token === 'sk-tg' || i.token === 'sk-dc'), 'desktop: provider key is never imported');
}

// ---- D2. migratePlaintext: desktop mode WITH keychain proof strips the token (durable home exists) ----
{
  const secrets = { telegram: { token: 'T:1', key: 'sk-tg', model: 'm', enabled: true }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => true });
  A.eq(res.changed, true, 'desktop w/ keychain: token stripped -> change');
  A.ok(!('token' in res.config.telegram), 'desktop w/ keychain: token stripped (keychain proves the durable home)');
  A.eq(res.config.telegram, { key: 'sk-tg', model: 'm', enabled: true }, 'desktop w/ keychain: config minus the token; a provider key is the reconciliation\'s');
  A.eq(res.imports.map(i => i.id), ['telegram'], 'desktop w/ keychain: token still reported to keep the session live');
}

// ---- E. migratePlaintext: mixed — a keychain-backed channel is stripped, an un-backed one keeps its token ----
{
  const secrets = { telegram: { token: 'T:1', model: 'm' }, discord: { token: 'D:2', model: 'm2' } };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: (id) => id === 'telegram' });
  A.eq(res.changed, true, 'desktop: changed (telegram stripped)');
  const ids = res.imports.map(i => i.id).sort();
  A.eq(ids, ['discord', 'telegram'], 'desktop: both reported (telegram to keep live, discord to adopt)');
  A.ok(!('token' in res.config.telegram), 'desktop: the keychain-backed token is stripped from plaintext');
  A.eq(res.config.discord.token, 'D:2', 'desktop: the un-backed token is KEPT in plaintext (last copy survives)');
}

// ---- E2. stripTokens(isDurable): the desktop persist path keeps a NON-durable token, drops a durable one + all keys ----
{
  const secrets = {
    telegram: { token: 'T:dur', key: 'sk-tg', model: 'm1', enabled: true },   // durable -> token dropped
    discord: { token: 'D:nondur', key: 'sk-dc', model: 'm2', ownerId: 'o' },  // NOT durable -> token kept
    notifyAutonomous: true
  };
  const out = S.stripTokens(secrets, (id) => id === 'telegram');
  A.ok(!('token' in out.telegram), 'stripTokens: durable channel token removed');
  A.eq(out.discord.token, 'D:nondur', 'stripTokens: NON-durable channel token KEPT (honest plaintext fallback)');
  A.ok(!('key' in out.telegram) && !('key' in out.discord), 'stripTokens: provider keys always removed');
  A.eq(out.discord, { token: 'D:nondur', model: 'm2', ownerId: 'o' }, 'stripTokens: non-durable config keeps token, drops key');
  A.eq(out.notifyAutonomous, true, 'stripTokens: non-channel keys untouched');
  // legacy 1-arg call still strips every token (back-compat)
  const legacy = S.stripTokens(secrets);
  A.ok(!('token' in legacy.telegram) && !('token' in legacy.discord), 'stripTokens (no isDurable) strips every token (back-compat)');
}

// ---- E3. REPRODUCTION (Andrew's loss): desktop, token via connect body (keychain store failed), sidecar "restart".
//   Before this fix stripTokens() unconditionally removed the token, so the reloaded config had NO token and
//   channelToken() (blocked from the plaintext fallback on desktop) returned '' -> configured:false, token GONE.
//   After the fix: a NON-durable token is persisted plaintext + resolvable after reload -> configured stays true. ----
{
  const DS = require('../sidecar/durable-store.js');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-loss-'));
  const file = path.join(dir, 'secrets.json');
  const deps = { fs: fs, path: path };
  try {
    // startTelegram persisted this record; the token came from the connect POST body (frontend keychain store
    // returned false) so it is NOT durable. The desktop persist path is stripTokens(record, isDurable).
    const record = { telegram: { token: 'BOT:from-body', key: 'sk-x', model: 'm', enabled: true, ownerId: '42' } };
    const isDurable = (id) => false;   // keychain does NOT hold it, not from spawn env either
    DS.writeJsonResilient(deps, file, S.stripTokens(record, isDurable));   // == saveChannelSecrets under DESKTOP_SHELL
    // --- simulate a sidecar RESTART: reload from disk, no env token, empty runtime layer ---
    const reloaded = DS.readJsonResilient(deps, file).value;
    A.eq(reloaded.telegram.token, 'BOT:from-body', 'RESTART: the non-durable token survived on disk');
    A.ok(!('key' in reloaded.telegram), 'RESTART: the provider key did NOT survive (lives in keychain)');
    // channelToken() desktop resolution AFTER the fix: runtime empty -> the plaintext record fallback is allowed.
    // (mirrors the index.js change; asserted structurally in section G below.)
    const resolved = reloaded.telegram.token || '';
    A.ok(!!resolved, 'RESTART: configured stays TRUE — the token is resolvable (Andrew\'s loss is fixed)');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- E4. Slack + Matrix are keychain channels too; Signal carries no secret (config only) ----
//   The shell's keychain table now covers every channel credential. The sidecar side of the split must treat the
//   Slack pair and the Matrix access token exactly like the Telegram/Discord tokens: stripped only with proof,
//   kept as the last copy without it, and never touching the non-secret endpoint/account config.
{
  const secrets = {
    slack: { token: 'xoxb-1 xapp-1', key: 'sk-s', model: 'm', enabled: true },
    matrix: { token: 'syt_2', key: 'sk-m', endpoint: 'https://matrix.example', model: 'm' },
    signal: { endpoint: 'http://127.0.0.1:8080', account: '+15550001111', key: 'sk-g', model: 'm' }
  };
  const failed = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => false });
  A.eq(failed.config.slack.token, 'xoxb-1 xapp-1', 'keychain write failed: the Slack pair stays on disk (last copy)');
  A.eq(failed.config.matrix.token, 'syt_2', 'keychain write failed: the Matrix token stays on disk (last copy)');
  A.eq(failed.imports.map(i => i.id).sort(), ['matrix', 'slack'], 'Slack + Matrix are reported for keychain adoption; Signal is not');
  A.eq(failed.config.signal, secrets.signal, 'Signal has no token to migrate: its record is left as it is');

  const proven = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: (id, tok) => (id === 'slack' && tok === 'xoxb-1 xapp-1') || (id === 'matrix' && tok === 'syt_2') });
  A.ok(!('token' in proven.config.slack) && !('token' in proven.config.matrix), 'keychain read-back proven: Slack + Matrix plaintext stripped');
  A.eq(proven.config.matrix.endpoint, 'https://matrix.example', 'the Matrix homeserver (non-secret) survives the strip');

  const stale = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: (id, tok) => id === 'matrix' && tok === 'syt_OLD' });
  A.eq(stale.config.matrix.token, 'syt_2', 'a keychain holding a DIFFERENT Matrix token cannot prove this one durable');

  const persisted = S.stripTokens(secrets, (id) => id === 'slack');
  A.ok(!('token' in persisted.slack), 'desktop persist: durable Slack pair stripped');
  A.eq(persisted.matrix.token, 'syt_2', 'desktop persist: non-durable Matrix token kept');
}

// ---- F. migratePlaintext: a secret-free desktop config is a no-op (no needless rewrite) ----
{
  const secrets = { telegram: { model: 'm', enabled: false }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => false });
  A.eq(res.changed, false, 'desktop: no plaintext token or key -> no change');
  A.eq(res.imports, [], 'desktop: nothing to import');
}

// ---- F2. migratePlaintext: a KEY-ONLY legacy record is the reconciliation's, on every mode ----
{
  const secrets = { telegram: { key: 'sk-leaked', model: 'm', enabled: true }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => true });
  A.eq([res.changed, res.imports], [false, []], 'desktop: a lone provider key is not this function\'s to strip, and imports nothing');
  A.eq(S.migratePlaintext(secrets, { keychainMode: false }).config, secrets, 'bare mode: untouched');
}

// ---- G. sidecar host wiring (static guard on index.js) ----
{
  // the host wherever it lives — but not the modules that DEFINE what it wires (secrets.js, child-env.js, registry.js)
  const src = readSidecarSource({ except: ['sidecar/channels/secrets.js', 'sidecar/child-env.js', 'sidecar/channels/registry.js'] });
  A.ok(/require\(['"]\.\/channels\/secrets\.js['"]\)/.test(src), 'index.js requires the secrets module');
  A.ok(/DESKTOP_SHELL\s*=\s*\/\^\(1\|true\|yes\|on\)/.test(src), 'index.js derives DESKTOP_SHELL from the shell env');
  A.ok(/channelTokenRuntime/.test(src), 'index.js has a runtime channel-token layer');
  A.ok(/TELEGRAM_BOT_TOKENS/.test(src) && /telegramBotSecretId/.test(src), 'index.js loads per-bot keychain tokens from the bounded JSON spawn payload');
  A.ok(/dynamicTelegram[\s\S]*?telegramBotSecretId/.test(src), 'the live token push uses the same closed numeric Telegram bot key namespace');
  A.ok(/SKYNET_TELEGRAM_TOKEN|TELEGRAM_TOKEN/.test(src) && /DISCORD_TOKEN/.test(src), 'index.js seeds tokens from env');
  A.ok(/DESKTOP_SHELL\s*\?\s*channelSecretsMod\.stripTokens\(held,\s*isChannelTokenDurable\)/.test(src), 'saveChannelSecrets strips secrets DURABILITY-AWARE under the desktop shell (never the last copy)');
  A.ok(/migratePlaintext/.test(src), 'index.js runs the boot migration');
  A.ok(/exact: '\/api\/channels\/token', h: handleSetChannelToken \}/.test(src), 'index.js wires the token-push route');
  // DURABILITY LEDGER (Andrew's invariant): a ledger exists, spawn-env seeds it durable, and a body-token stays non-durable.
  A.ok(/channelTokenDurable/.test(src), 'index.js tracks per-channel token durability');
  A.ok(/function isChannelTokenDurable/.test(src), 'index.js exposes isChannelTokenDurable(id)');
  A.ok(/channelTokenRuntime\[id\]\s*=\s*v;\s*channelTokenDurable\[id\]\s*=\s*v/.test(src), 'spawn-env seeds the exact keychain-backed value into the durability ledger');
  A.ok(/scrubChannelSecretsBak[\s\S]*?stripTokens\(channelSecretsMod\.withoutProviderCredentials\(parsed\),\s*isChannelTokenDurable\)/.test(src), 'the .bak scrub is durability-aware (never destroys the last copy in .bak)');
  // channelToken() now allows the plaintext-record fallback on desktop too (it only exists there when non-durable).
  A.ok(/if\s*\(savedRecord\s*&&\s*savedRecord\.token\)\s*return String\(savedRecord\.token\)/.test(src), 'channelToken() allows the plaintext-record fallback (desktop included)');
  A.ok(!/!DESKTOP_SHELL\s*&&\s*savedRecord\s*&&\s*savedRecord\.token/.test(src), 'channelToken() no longer blocks the plaintext fallback on desktop');
  // /status exposes a truthful `durable` flag (keychain/env OR plaintext-on-disk).
  A.ok(/configured: configured, durable: durable/.test(src), '/status endpoints report a truthful durable flag');
  A.ok(/handleChannelSync[\s\S]*?channelToken\(['"]telegram['"],\s*['"]['"],\s*t\)/.test(src), 'Telegram identity sync resolves a keychain/runtime token instead of requiring a plaintext copy');
  A.ok(/channelTokenDurable\[channel\]\s*=\s*tok/.test(src), 'a /api/channels/token push records the exact keychain-backed value as durable');
  // P1 key hygiene: the boot migration also sweeps the .bak, and the provider key is resolved from the runtime
  // layer (never persisted). Guard the .bak-scrub wiring and that no write path re-persists a resolved key.
  A.ok(/function scrubChannelSecretsBak/.test(src), 'index.js defines the .bak secret scrub');
  A.ok(/scrubChannelSecretsBak\(\)/.test(src.slice(src.indexOf('migrateChannelSecretsToKeychain'))), 'the boot migration calls scrubChannelSecretsBak()');
  A.ok(/writeFileDurable\(\{\s*fs:\s*fs,\s*path:\s*path\s*\},\s*bak,/.test(src), 'the .bak scrub uses the durable write helper (house style)');
  A.ok(/credStore\.resolve\(provider, \{ channel: r \}\)/.test(src), 'a hub\'s secrets() resolves the key through the store (its own credential, else the station\'s), not from the record');
  // the push handler is IPC-token gated and never returns the token
  const h = src.slice(src.indexOf('function handleSetChannelToken'));
  const body = h.slice(0, h.indexOf('\n}\n') + 3);
  A.ok(/ipcTokenOk\(req\)/.test(body), '/api/channels/token is gated by the per-launch IPC token (ipcTokenOk)');
  const gate = src.slice(src.indexOf('function ipcTokenOk'));
  const gateBody = gate.slice(0, gate.indexOf('\n}\n') + 3);
  A.ok(/IPC_TOKEN/.test(gateBody), 'ipcTokenOk reads the per-launch IPC token');
  A.ok(/timingSafeEqual/.test(gateBody), 'ipcTokenOk compares in constant time (no prefix-timing oracle)');
  A.ok(!/token:\s*(tok|body\.token|channelTokenRuntime)/.test(body), '/api/channels/token never echoes the token back');
}

// ---- G2. on-disk round-trip through the REAL durable-store path: key never lands on disk; a legacy file is scrubbed ----
{
  // index.js self-boots a server and can't be required, so drive the exact seam it uses: stripTokens (desktop
  // persist) + writeJsonResilient/readJsonResilient (the durable store saveChannelSecrets/loadResilient call).
  const DS = require('../sidecar/durable-store.js');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-secret-'));
  const file = path.join(dir, 'secrets.json');
  const deps = { fs: fs, path: path };
  try {
    // (a) desktop WRITE path: a record carrying token+key is stripped before it hits disk -> no secret on disk or .bak.
    const live = { telegram: { token: 'T:disk', key: 'sk-disk', model: 'm', enabled: true }, notifyAutonomous: true };
    DS.writeJsonResilient(deps, file, S.stripTokens(live));   // == saveChannelSecrets(live) under DESKTOP_SHELL
    const onDisk = fs.readFileSync(file, 'utf8');
    A.ok(onDisk.indexOf('sk-disk') < 0 && onDisk.indexOf('T:disk') < 0, 'WRITE: neither key nor token round-trips to secrets.json');
    A.ok(onDisk.indexOf('"model":"m"') >= 0, 'WRITE: non-secret config still persisted');
    const loadedBack = DS.readJsonResilient(deps, file);
    A.ok(loadedBack.value && loadedBack.value.telegram && !('key' in loadedBack.value.telegram), 'WRITE: reload carries no key');

    // (b) LEGACY-file scrub: a pre-fix file WITH a plaintext key (as older builds wrote) is detected + rewritten clean,
    //     and crucially the .bak snapshot the rewrite creates is ALSO swept (mirrors scrubChannelSecretsBak()).
    const legacy = { telegram: { token: 'T:old', key: 'sk-legacy', model: 'm', enabled: true } };
    DS.writeJsonResilient(deps, file, legacy);               // simulate the old plaintext file on disk
    A.ok(fs.readFileSync(file, 'utf8').indexOf('sk-legacy') >= 0, 'LEGACY: precondition — the leaked key is on disk');
    // boot scrub: migratePlaintext flags changed, we persist the stripped config, THEN sweep the .bak.
    const res = S.migratePlaintext(legacy, { keychainMode: true, hasChannelToken: () => true });
    A.eq(res.changed, true, 'LEGACY: boot migration flags the file for a scrub');
    DS.writeJsonResilient(deps, file, S.stripTokens(res.config));   // saveChannelSecrets(res.config)
    // the durable write just snapshotted the pre-scrub (leaky) main into .bak — sweep it exactly as index.js does.
    const bak = file + '.bak';
    const bakRaw = fs.readFileSync(bak, 'utf8');
    if (JSON.stringify(S.stripTokens(JSON.parse(bakRaw))) !== bakRaw) {
      require('../sidecar/durable-write.js').writeFileDurable(deps, bak, JSON.stringify(S.stripTokens(JSON.parse(bakRaw))));
    }
    A.ok(fs.readFileSync(file, 'utf8').indexOf('sk-legacy') < 0, 'LEGACY: main secrets.json scrubbed of the key');
    A.ok(fs.readFileSync(bak, 'utf8').indexOf('sk-legacy') < 0, 'LEGACY: the .bak last-known-good scrubbed of the key too');
    A.ok(fs.readFileSync(file, 'utf8').indexOf('"model":"m"') >= 0, 'LEGACY: config survives the scrub');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- H. apiauth exempts the IPC-gated channel-token push (like /api/key) ----
{
  const auth = fs.readFileSync(path.join(root, 'sidecar', 'apiauth.js'), 'utf8');
  A.ok(/'\/api\/channels\/token'/.test(auth), 'apiauth TOKEN_EXEMPT includes /api/channels/token');
  const { requiresApiToken } = require('../sidecar/apiauth.js');
  A.ok(requiresApiToken({ method: 'POST', url: '/api/channels/token' }) === false, '/api/channels/token is not API-token gated (uses its own IPC token)');
  A.ok(requiresApiToken({ method: 'POST', url: '/api/channels/telegram/connect' }) === true, 'the connect route still requires the API token');
}

// ---- I. Rust shell wiring (static guard on main.rs) ----
{
  const mainRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
  const credentialsRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'credentials.rs'), 'utf8');
  const nativeRs = mainRs + '\n' + credentialsRs;
  A.ok(/mod credentials;/.test(mainRs), 'main.rs owns one focused native credential module');
  A.ok(/SIDECAR_CHANNEL_TOKEN_ENVS/.test(credentialsRs), 'credentials.rs declares the channel-token env table');
  A.ok(/"telegram",\s*"SKYNET_TELEGRAM_TOKEN"/.test(credentialsRs) && /"discord",\s*"SKYNET_DISCORD_TOKEN"/.test(credentialsRs), 'credentials.rs maps both channels to their spawn env vars');
  A.ok(/"slack",\s*"SKYNET_SLACK_TOKEN"/.test(credentialsRs) && /"matrix",\s*"SKYNET_MATRIX_TOKEN"/.test(credentialsRs), 'credentials.rs keychains the Slack pair and the Matrix access token too');
  // the Rust env names and the sidecar's CHANNEL_TOKEN_ENV must agree for every keychained channel
  const idx = readSidecarSource();
  const envTable = /const CHANNEL_TOKEN_ENV = \{([^}]*)\}/.exec(idx);
  A.ok(!!envTable, 'index.js declares CHANNEL_TOKEN_ENV');
  for (const m of credentialsRs.matchAll(/\("([a-z]+)",\s*"SKYNET_([A-Z_]+)"\)/g)) {
    if (!/_TOKEN$/.test(m[2])) continue;
    A.ok(new RegExp('\\b' + m[1] + ":\\s*'" + m[2] + "'").test(envTable ? envTable[1] : ''), 'sidecar reads the ' + m[1] + ' keychain env (' + m[2] + ')');
  }
  A.ok(/format!\("channel:\{channel\}"\)/.test(credentialsRs), 'credentials.rs uses the channel:<id> keychain account');
  A.ok(/read_channel_token\(channel\)/.test(nativeRs) && /set_sidecar_branded_env\(&mut cmd, env_name, token\)/.test(mainRs), 'main.rs injects module-owned keychain tokens into both branded sidecar env aliases at spawn');
  A.ok(/fn read_telegram_bot_tokens/.test(credentialsRs) && /SKYNET_TELEGRAM_BOT_TOKENS/.test(mainRs), 'the shell injects saved agent-bot keychain tokens at every sidecar spawn');
  A.ok(/strip_prefix\("telegram:"\)/.test(credentialsRs) && /byte\.is_ascii_digit/.test(credentialsRs), 'the dynamic keychain namespace accepts numeric Telegram bot ids only');
  A.ok(/fn migrate_channel_tokens_from_plaintext/.test(credentialsRs), 'credentials.rs migrates plaintext channel tokens into the keychain');
  A.ok(/fn harness_store_channel_token/.test(mainRs) && /fn harness_has_channel_token/.test(mainRs), 'main.rs preserves the store/has channel-token commands');
  A.ok(/harness_store_channel_token,\s*\n\s*harness_has_channel_token/.test(mainRs), 'both channel-token commands are registered in the invoke handler');
  // the store command must write the keychain (set_password/delete) and push, never return the token
  A.ok(/fn harness_store_channel_token[\s\S]*?set_password[\s\S]*?push_channel_token/.test(mainRs), 'store command writes the keychain then pushes to the sidecar');
  // DURABILITY (Andrew's invariant): the plaintext-token migration only strips the file token AFTER a keychain
  // read-back confirms the keychain actually holds it — a failed set_password must leave the plaintext copy intact.
  A.ok(/fn migrate_channel_tokens_from_plaintext[\s\S]*?migrate_channel_tokens_with\(&KeyringChannelStore/.test(credentialsRs), 'the boot migration writes through the real keychain store');
  A.ok(/fn migrate_channel_tokens_with[\s\S]*?store\s*\.read\(channel\)[\s\S]*?keychain_has_it[\s\S]*?\.remove\("token"\)/.test(credentialsRs), 'migrate strips the plaintext token only after a keychain read-back confirms it (never destroys the last copy)');
  A.ok(/fn failed_keychain_writes_leave_the_plaintext_file_byte_identical/.test(credentialsRs), 'a Rust unit test proves the write-failure path keeps the plaintext file intact');
}

// ---- J. frontend routes the token through the keychain on desktop, POST-body on browser ----
{
  const harness = fs.readFileSync(path.join(root, 'frontend', 'app', 'harness.js'), 'utf8');
  A.ok(/function storeChannelToken/.test(harness), 'harness.js exposes storeChannelToken');
  A.ok(/harness_store_channel_token/.test(harness), 'harness.js invokes the Tauri channel-token command');
  A.ok(/if\s*\(!DESKTOP[\s\S]{0,40}\)\s*return Promise\.resolve\(false\)/.test(harness), 'browser build no-ops storeChannelToken (keeps the POST-body path)');
  const ui = fs.readFileSync(path.join(root, 'frontend', 'app', 'windows', 'messaging.js'), 'utf8');
  // one catalog-generated connect handler serves EVERY channel: the keychain park happens once, by channel id.
  A.ok(/Harness\.storeChannelToken\(c\.id, vals\.token\)/.test(ui), 'the generic connect handler parks each channel\'s token in the keychain first');
  A.ok((ui.match(/if \(stored\) bodyToken = ''/g) || []).length >= 1, 'a keychain-stored token is omitted from the connect POST body');
  // DURABILITY UX: when the desktop keychain store fails, the token still rides the body (now persisted safely as a
  // plaintext fallback) and the UI says so honestly — no scary modal, one short line.
  A.ok(/isDesktop/.test(harness), 'harness.js exposes isDesktop() so the UI can tell a desktop store failure from a browser no-op');
  A.ok((ui.match(/localFallback = true/g) || []).length >= 1, 'the generic connect handler flags a desktop keychain-store failure');
  A.ok(/token saved locally, not the OS keychain/.test(ui), 'the connect handler notes a local (non-keychain) save honestly');
  A.ok(/storeChannelToken\('telegram:' \+ j\.botId, token\)/.test(ui), 'agent-bound Telegram tokens move into their per-bot keychain slot after getMe reveals the stable id');
  A.ok(/storeChannelToken\('telegram:' \+ botId, ''\)/.test(ui), 'forget clears the agent bot keychain slot as well as its saved record');
}

// ---- G. makeVerifiedPersist: the saveJsonVerified law applied to channel secrets (EL-5 class) ----
// The regression this locks: channel bot tokens were the ONE credential class persisted fire-and-forget —
// a swallowed write error lost the token's last surviving copy while every route kept returning ok:true.
{
  const { saveJsonVerified } = require('../sidecar/durable-store.js');

  // 1) healthy round-trip: write lands, read-back matches -> ok:true, first attempt
  {
    let disk;
    const persist = S.makeVerifiedPersist({ saveJsonVerified, save: (v) => { disk = JSON.stringify(v); }, load: () => JSON.parse(disk) });
    const r = persist({ telegram: { token: 'BOT:123', enabled: true }, notifyAutonomous: true });
    A.ok(r.ok, 'healthy write is proven ok');
    A.eq(r.attempts, 1, 'healthy write proves on the first attempt');
  }

  // 2) THE ESCAPE SCENARIO (disk full / file locked): save throws, disk keeps the STALE value.
  //    Pre-fix this was catch{warn} -> callers reported "saved". Now it must be ok:false, after a retry.
  {
    const stale = JSON.stringify({ telegram: { enabled: false } });
    const persist = S.makeVerifiedPersist({ saveJsonVerified, save: () => { throw new Error('ENOSPC: no space left'); }, load: () => JSON.parse(stale) });
    const r = persist({ telegram: { token: 'BOT:new-last-copy', enabled: true } });
    A.ok(!r.ok, 'a swallowed write error can no longer be reported as saved (the EL-5 Telegram-token escape)');
    A.eq(r.attempts, 2, 'the failed write was retried once before reporting honestly');
    A.ok(String(r.error).length > 0, 'the failure carries the real cause');
  }

  // 3) silent corruption: save "succeeds" but the read-back is NOT the intended value -> proof refuses it
  {
    const persist = S.makeVerifiedPersist({ saveJsonVerified, save: () => {}, load: () => ({ telegram: { token: 'SOMETHING-ELSE' } }) });
    const r = persist({ telegram: { token: 'BOT:123' } });
    A.ok(!r.ok, 'a read-back that does not byte-match the intended value is never called proven');
  }

  // 4) transient first failure: attempt 1 throws, attempt 2 lands -> ok:true on the retry
  {
    let disk, n = 0;
    const persist = S.makeVerifiedPersist({ saveJsonVerified, save: (v) => { if (++n === 1) throw new Error('EBUSY'); disk = JSON.stringify(v); }, load: () => (disk === undefined ? undefined : JSON.parse(disk)) });
    const r = persist({ discord: { token: 'BOT:d', enabled: true } });
    A.ok(r.ok, 'a transient first-attempt failure recovers on the retry');
    A.eq(r.attempts, 2, 'recovery is reported as attempt 2');
  }

  // 5) the strip policy runs BEFORE the write and the proof compares the STRIPPED value (desktop posture:
  //    a durable token never touches the plaintext file; the proof must demand exactly what was intended on disk)
  {
    let disk;
    const persist = S.makeVerifiedPersist({
      saveJsonVerified,
      strip: (obj) => S.stripTokens(obj, () => true),   // every token durable elsewhere -> all stripped
      save: (v) => { disk = JSON.stringify(v); },
      load: () => JSON.parse(disk)
    });
    const r = persist({ telegram: { token: 'BOT:123', key: 'sk-live', model: 'm', enabled: true } });
    A.ok(r.ok, 'stripped persist is proven ok');
    const onDisk = JSON.parse(disk);
    A.ok(!('token' in onDisk.telegram) && !('key' in onDisk.telegram), 'the durable token + key never reach the plaintext file');
    A.eq(onDisk.telegram.model, 'm', 'non-secret config survives the strip');
  }

  // 6) host wiring static guards: index.js persists through the verified factory, RETURNS the ok bit, and the
  //    routes surface it (notify 500s, disconnect never claims `purged` on an unproven write).
  {
    const idx = readSidecarSource();
    A.ok(/persistChannelSecretsVerified = channelSecretsMod\.makeVerifiedPersist\(\{/.test(idx), 'saveChannelSecrets rides makeVerifiedPersist (read-back-proven)');
    A.ok(/const r = persistChannelSecretsVerified\(obj\);[\s\S]{0,400}?return r\.ok;/.test(idx), 'saveChannelSecrets returns the proven ok bit');
    A.ok(/if \(!saveChannelSecrets\(channelSecrets\)\) \{ res\.writeHead\(500/.test(idx), 'the notify route surfaces a failed persist as 500 (the old guard was unreachable)');
    A.ok((idx.match(/purged: purge && persisted/g) || []).length >= 2, 'a FORGET/purge never claims `purged` without read-back proof (telegram + generic)');
    A.ok((idx.match(/persisted: !!\(started && started\.secretsPersisted\)/g) || []).length >= 3, 'all three connect routes report the persist truth bit');
  }
}

// ---- K. THE CHANNEL RECONCILIATION (credential-store lane, S8; the store's CHANNELS) ----
// Each row boots index.js's OWN channel region (the load, the verified persist, the reconciliation, the .bak sweep, the token
// migration) over a real folder, through the real durable store and writer (test/helpers/credential-store-sandbox.js channelStation).
{
  const os = require('os');
  const { channelStation } = require('./helpers/credential-store-sandbox.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-reconcile-'));
  let seq = 0;
  const OWN = 'sk-or-v1-bot-own-key-K1-0123456789abcdef', NEWER = 'sk-or-v1-bot-newer-key-K3-0123456789abcd', OLDER = 'sk-or-v1-bot-older-key-K0-0123456789abcd';
  const HELD = 'sk-or-v1-station-key-K2-0123456789abcdef', TOKEN = 'BOT:plaintext-browser-token';
  const U = 'http://127.0.0.1:9/bot-own/v1', FOREIGN = 'http://127.0.0.1:9/a-script/v1', DEFAULT = 'https://openrouter.ai/api/v1';
  const bot = extra => Object.assign({ token: TOKEN, provider: 'openrouter', model: 'test/model', enabled: true, agentId: 'agent' }, extra);
  const entry = (bind, extra) => Object.assign({ provider: 'openrouter', bind, ownKey: true, rev: 1 }, extra);
  const envelope = channels => ({ version: 1, channels });
  // a workspace: secrets (main), bak, channel (both copies, unless channelBak says otherwise)
  function seed(o) {
    const dir = path.join(root, 's' + (++seq));
    fs.mkdirSync(path.join(dir, 'channels'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.secrets'), { recursive: true });
    const put = (f, v) => { if (v !== undefined) fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
    const main = path.join(dir, 'channels', 'secrets.json'), chan = path.join(dir, '.secrets', 'channel-credentials.json');
    put(main, o.secrets); put(main + '.bak', o.bak);
    put(chan, o.channel); put(chan + '.bak', o.channelBak !== undefined ? o.channelBak : o.channel);
    return dir;
  }
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
  const json = f => { try { return JSON.parse(read(f)); } catch (_) { return null; } };
  const holders = (s, needle) => Object.keys(s.files).filter(n => read(s.files[n]).includes(needle)).sort();
  const pair = h => [h.key, h.baseUrl, h.configured];
  // disk mutations a boot makes, faults on demand. crashAt: after that many the process is gone, as far as the disk can tell
  function disk() {
    const st = { ops: 0, crashAt: null, block: null, readBlock: null, readBlockAfterWrite: null };
    const fsio = new Proxy(fs, { get(t, p) {
      if (p === 'readFileSync') return (...a) => {
        if (st.readBlock && st.readBlock.test(String(a[0]))) throw Object.assign(new Error('EIO: read-back unavailable'), { code: 'EIO' });
        return t[p](...a);
      };
      if (['renameSync', 'linkSync', 'unlinkSync', 'copyFileSync'].includes(p)) return (...a) => {
        const eio = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        if (st.block && st.block.test(String(a[a.length - 1]))) throw eio();
        if (st.crashAt !== null && st.ops >= st.crashAt) throw eio();
        st.ops++;
        const result = t[p](...a);
        if (st.readBlockAfterWrite && st.readBlockAfterWrite.test(String(a[a.length - 1]))) st.readBlock = st.readBlockAfterWrite;
        return result;
      };
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    return { fsio, st };
  }

  // ---- the record side ----
  {
    const sec = { telegram: { token: 't', key: 'k', baseUrl: 'u', provider: 'openrouter' }, discord: { provider: 'custom', base_url: 'u2', keyPool: ['p'] }, slack: { credential: { ref: 'station' } },
      telegramBots: { 42: { key: 'k42', provider: 'anthropic' }, bad: 'not-a-record' }, notifyAutonomous: true };
    A.eq(S.credentialRows(sec).map(r => [r.id, r.key, r.baseUrl, r.carries]), [['telegram', 'k', 'u', true], ['discord', '', 'u2', true], ['slack', '', '', false], ['telegramBots:42', 'k42', '', true]],
      'one row per record, a bot under telegramBots:<botId>, each with what it carries');
    A.eq(S.recordAt(sec, 'telegramBots:42').key, 'k42', 'recordAt reads a bot by its id');
    A.eq([S.recordAt(sec, 'telegramBots:bad'), S.recordAt(sec, 'telegramBots:__proto__'), S.recordAt(sec, 'notifyAutonomous'), S.recordAt(sec, 'nosuch')], [null, null, null, null], '...and nothing that is not a record');
    const next = S.withCredentials(sec, { telegram: { ref: 'channel', bind: 'b' }, discord: { ref: 'station' }, 'telegramBots:42': null });
    A.eq([next.telegram, next.discord, next.telegramBots['42'], next.slack, next.notifyAutonomous, next.telegramBots.bad],
      [{ token: 't', provider: 'openrouter', credential: { ref: 'channel', bind: 'b' } }, { provider: 'custom', credential: { ref: 'station' } }, { provider: 'anthropic' }, sec.slack, true, 'not-a-record'],
      'withCredentials gives each named record its reference and takes what it carried; a record left out is untouched');
    A.eq(sec.telegram.key, 'k', 'the input is not mutated');
    A.eq(S.withoutProviderCredentials(sec).discord, { provider: 'custom' }, 'withoutProviderCredentials leaves no key, keyPool, baseUrl or base_url');
    const norm = p => p || 'openrouter';
    const kept = S.withCarried({ telegram: { provider: 'openrouter' }, discord: { provider: 'custom' } }, { telegram: { provider: 'openrouter', key: 'k', baseUrl: 'u' }, discord: { provider: 'openrouter', key: 'other' } }, norm);
    A.eq([kept.telegram, kept.discord], [{ provider: 'openrouter', key: 'k', baseUrl: 'u' }, { provider: 'custom' }], 'withCarried puts a failed move back on its record, never on a record that went to another provider');
  }

  // ---- 1c: an older build's own key moves, in order, and stays once ----
  {
    const dir = seed({ secrets: { telegram: bot({ key: OWN, baseUrl: U }), notifyAutonomous: true }, bak: { telegram: bot({ key: OLDER, baseUrl: U }) } });
    const d = disk();
    const s = channelStation({ dir, fs: d.fsio });
    A.eq(holders(s, OWN), ['channel', 'channelBak'], '1c: the own key is in the channel file, both copies, and no other');
    A.eq([holders(s, OLDER), holders(s, U)], [[], ['channel', 'channelBak']], '1c: the .bak\'s older key is swept, and the endpoint moved with the key');
    const rec = json(s.files.secrets).telegram;
    A.ok(!('key' in rec) && !('baseUrl' in rec) && rec.credential.ref === 'channel' && rec.credential.bind === json(s.files.channel).channels.telegram.bind, '1c: the record holds a reference with the entry\'s bind: ' + JSON.stringify(rec));
    A.eq([rec.token, json(s.files.bak).telegram.token], [TOKEN, TOKEN], '1c: a non-durable bot token stays, in main and in the .bak (its only recovery copy)');
    A.eq(json(s.files.secrets).notifyAutonomous, true, '1c: the rest of the file is kept');
    A.eq(pair(s.hub('telegram')), [OWN, U, true], '1c: the bot runs on its own key at its own endpoint');
    const ops = d.st.ops, again = channelStation({ dir, fs: d.fsio });
    A.eq(d.st.ops, ops, 'running it again changes nothing: not one write');
    A.eq(pair(again.hub('telegram')), [OWN, U, true], '...and the bot resolves the same pair after a restart');
    A.eq(again.warns.filter(w => /\[channels\]/.test(w)), [], '...with nothing to say');
    A.ok(!JSON.stringify(s.warns).includes(OWN) && !JSON.stringify(s.warns).includes(U), 'the log names records, never a key or an endpoint');
  }

  // ---- 1b: a key the station holds is dropped, and what it was saved with decides the endpoint ----
  {
    const envKey = { OPENROUTER_API_KEY: HELD };
    const plain = channelStation({ dir: seed({ secrets: { telegram: bot({ key: HELD, baseUrl: '' }) } }), env: envKey });
    A.eq([json(plain.files.secrets).telegram.credential, holders(plain, HELD), read(plain.files.channel)], [{ ref: 'station' }, [], ''], '1b: the operator\'s key leaves the record, which follows the station; no entry is made');
    A.eq(pair(plain.hub('telegram')), [HELD, DEFAULT, true], '1b: ...and the bot runs it live');
    const resolved = channelStation({ dir: seed({ secrets: { telegram: bot({ key: HELD, baseUrl: DEFAULT }) } }), env: envKey });
    A.eq(json(resolved.files.secrets).telegram.credential, { ref: 'station' }, '1b: the endpoint the station resolves anyway is no endpoint of the bot\'s, so a proxy set later reaches it');
    const kept = channelStation({ dir: seed({ secrets: { telegram: bot({ key: HELD, baseUrl: U }) } }), env: envKey });
    A.eq([json(kept.files.secrets).telegram.credential.ref, json(kept.files.channel).channels.telegram.ownKey, json(kept.files.channel).channels.telegram.baseUrl, holders(kept, HELD)], ['channel', false, U, []],
      '1b: any other endpoint becomes an endpoint-only entry, with no key');
    A.eq(pair(kept.hub('telegram')), [HELD, DEFAULT, true], '1b: ...and the station\'s key never goes there');
    const page = { openrouter: { key: HELD, baseUrl: 'http://127.0.0.1:9/page/v1', rev: 'r1' } };
    const foreign = channelStation({ dir: seed({ secrets: { telegram: bot({ key: HELD, baseUrl: FOREIGN }) } }), page });
    A.eq([json(foreign.files.secrets).telegram.credential, holders(foreign, FOREIGN)], [{ ref: 'station' }, []], '1b: the page copy\'s key beside an endpoint it was not saved with: the endpoint goes too');
    A.eq(pair(foreign.hub('telegram')), [HELD, 'http://127.0.0.1:9/page/v1', true], '1b: ...and the bot runs the page copy at the page\'s own endpoint');
    const signin = channelStation({ dir: seed({ secrets: { telegram: bot({ provider: 'starnet', key: OWN, baseUrl: FOREIGN }) } }) });
    A.eq([json(signin.files.secrets).telegram.credential, holders(signin, OWN), holders(signin, FOREIGN)], [{ ref: 'station' }, [], []], '1: StarNet\'s linked account takes no channel credential: a stale key and endpoint on its record simply go');
  }

  // ---- half-migrated: a crash between the entry and the record leaves the key in both, and the main file's is the newest ----
  {
    const s = channelStation({ dir: seed({ secrets: { telegram: bot({ key: NEWER }) }, channel: envelope({ telegram: entry('b0', { key: OLDER }) }) }) });
    A.eq([holders(s, NEWER), holders(s, OLDER)], [['channel', 'channelBak'], []], '1c half-migrated: the key read from main replaces the entry');
    A.eq(pair(s.hub('telegram')), [NEWER, DEFAULT, true], '...and the bot runs it');
  }

  // ---- 1a: a .bak recovery never rolls a newer entry back ----
  {
    const s = channelStation({ dir: seed({ secrets: '{"telegram":{"tok', bak: { telegram: bot({ key: OLDER }) }, channel: envelope({ telegram: entry('b1', { key: NEWER }) }) }) });
    A.eq(s.status(), 'recovered', 'fixture: main is torn, and the record came from the .bak');
    A.eq(pair(s.hub('telegram')), [NEWER, DEFAULT, true], '1a: the entry is newer and stands');
    A.eq([json(s.files.secrets).telegram.credential, holders(s, OLDER), holders(s, NEWER)], [{ ref: 'channel', bind: 'b1' }, [], ['channel', 'channelBak']], '1a: the record binds to it, and its own older copy is gone from main and .bak');
    // the .bak the sweep already cleaned: a recovered record carries nothing, not even a reference, and the entry still stands
    const swept = channelStation({ dir: seed({ secrets: '', bak: { telegram: bot({}) }, channel: envelope({ telegram: entry('b1', { key: NEWER }) }) }) });
    A.eq([swept.status(), pair(swept.hub('telegram')), json(swept.files.secrets).telegram.credential], ['recovered', [NEWER, DEFAULT, true], { ref: 'channel', bind: 'b1' }], '1a: a .bak with no reference at all rolls nothing back either');
    const fresh = channelStation({ dir: seed({ secrets: '', bak: { telegram: bot({ key: OLDER }) } }) });
    A.eq(pair(fresh.hub('telegram')), [OLDER, DEFAULT, true], '1c: with no entry, a key recovered from the .bak moves like any other');
  }

  // ---- 2: an entry whose key has become the station's converts ----
  {
    const ref = { ref: 'channel', bind: 'b1' };
    const s = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: HELD }) }) }), env: { OPENROUTER_API_KEY: HELD } });
    A.eq([json(s.files.secrets).telegram.credential, holders(s, HELD), Object.keys(json(s.files.channel).channels)], [{ ref: 'station' }, [], []], '2: the entry goes, and the record follows the station');
    const u = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: HELD, baseUrl: U }) }) }), env: { OPENROUTER_API_KEY: HELD } });
    A.eq([json(u.files.secrets).telegram.credential, holders(u, HELD), json(u.files.channel).channels.telegram.baseUrl], [ref, [], U], '2: with an endpoint of its own the entry stays, endpoint only');
    const stays = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: OWN }) }) }), env: { OPENROUTER_API_KEY: HELD } });
    A.eq(pair(stays.hub('telegram')), [OWN, DEFAULT, true], '2: an own key the station does not hold stays, beside a station key');
    // review r1: a key a layer holds only as a BACKUP in its pool is not the station's key. The bot keeps the key it was given and
    // runs on it, never on the station's primary (another account), as the connect gate judges it (stationHeld). Red at 86ff765db.
    for (const [where, extra] of [['the environment\'s KEY_POOL', { env: { OPENROUTER_API_KEY: HELD, STARNET_KEY_POOL_OPENROUTER: OWN } }],
      ['the page copy\'s backups', { page: { openrouter: { key: HELD, keyPool: [OWN], rev: 'r1' } } }]]) {
      const pooled = channelStation(Object.assign({ dir: seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: OWN }) }) }) }, extra));
      A.eq([json(pooled.files.secrets).telegram.credential, pooled.hub('telegram').key, holders(pooled, OWN)], [ref, OWN, ['channel', 'channelBak']],
        '2: an own key the station holds only in ' + where + ' stays the bot\'s, and the bot runs on it');
      const older = channelStation(Object.assign({ dir: seed({ secrets: { telegram: bot({ key: OWN }) } }) }, extra));
      A.eq([(json(older.files.secrets).telegram.credential || {}).ref, older.hub('telegram').key, holders(older, OWN)], ['channel', OWN, ['channel', 'channelBak']],
        '1b: an older build\'s record carrying a key the station holds only in ' + where + ' moves it, as the bot\'s own');
    }
  }

  // ---- 3: a reference with no matching entry is refused, and never moves onto the station's key ----
  {
    const ref = { ref: 'channel', bind: 'b1' }, env = { OPENROUTER_API_KEY: HELD };
    const none = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) } }), env });
    const h = none.hub('telegram');
    A.eq([h.key, h.configured, h.error], ['', false, 'this bot\'s own OPENROUTER key is no longer saved on this station — reconnect it with its key, or with none to use the station\'s'], '3: no entry: refused with the sentence, beside a station key');
    A.eq(json(none.files.secrets).telegram.credential, ref, '3: the record stays as it is');
    A.ok(none.warns.some(w => /^\[channels\] telegram: /.test(w) && /refused/.test(w)), '3: and the record id is logged: ' + JSON.stringify(none.warns));
    const other = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b2', { key: OWN }) }) }), env });
    A.eq([other.hub('telegram').configured, holders(other, OWN)], [false, []], '3 + 5: an entry with another bind does not serve, and goes');
  }

  // ---- 4: an older build's record, or one it rewrote ----
  {
    // the exact shape trunk's auto-start writes (probe R2), plus the entry the new build left
    const R2 = { baseUrl: '', enabled: true, key: '', model: 'test/model', provider: 'openrouter', reasoningEffort: 'medium', token: TOKEN };
    const s = channelStation({ dir: seed({ secrets: { telegram: R2 }, channel: envelope({ telegram: entry('b1', { key: OWN }) }) }), env: { OPENROUTER_API_KEY: HELD } });
    A.eq([json(s.files.secrets).telegram.credential, holders(s, OWN), pair(s.hub('telegram'))], [{ ref: 'station' }, [], [HELD, DEFAULT, true]], '4: the record follows the station as the older build ran it, and the orphan is gone from both copies');
    A.ok(!('key' in json(s.files.secrets).telegram) && !('baseUrl' in json(s.files.secrets).telegram), '4: the empty fields an older build writes go too');
    const up = channelStation({ dir: seed({ secrets: { telegram: bot({}), discord: bot({ credential: { ref: 'station' }, key: '', baseUrl: '' }) } }) });
    A.eq([json(up.files.secrets).telegram.credential, json(up.files.secrets).discord], [{ ref: 'station' }, bot({ credential: { ref: 'station' } })], '4: a record with nothing becomes a station reference, and a station reference loses the empty fields a rewrite left');
    A.eq([read(up.files.channel), up.warns.filter(w => /moved/.test(w))], ['', []], '...and no file is made for nothing');
  }

  // ---- 5: orphans. A record gone, a bot forgotten on an older build, another bind ----
  {
    const ref = { ref: 'channel', bind: 'b1' };
    const s = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) },
      channel: envelope({ telegram: entry('b1', { key: OWN }), discord: entry('b2', { key: NEWER }), 'telegramBots:42': entry('b3', { key: OLDER }) }) }) });
    A.eq(Object.keys(json(s.files.channel).channels), ['telegram'], '5: entries whose record is gone are deleted');
    A.eq([holders(s, NEWER), holders(s, OLDER)], [[], []], '5: from both copies');
    A.ok(s.warns.some(w => /discord, telegramBots:42: /.test(w)), '5: named by record id: ' + JSON.stringify(s.warns));
  }

  // ---- a record an older sync moved to another provider, with the old provider's address still on it (bug 61bb1c7d's leftover) ----
  {
    const s = channelStation({ dir: seed({ secrets: { telegram: bot({ provider: 'anthropic', baseUrl: DEFAULT }) } }), env: { ANTHROPIC_API_KEY: HELD } });
    A.eq(pair(s.hub('telegram')), [HELD, 'https://api.anthropic.com/v1', true], 'the station\'s Anthropic key goes to Anthropic: an endpoint rides only a keyless run now, never a station key');
    A.eq(json(s.files.channel).channels.telegram.ownKey, false, '...the old address is an endpoint-only entry');
  }

  // ---- 6: the .bak is swept on every mode ----
  {
    const dirty = { telegram: bot({ key: OWN, baseUrl: U, keyPool: ['p1'] }), discord: bot({ token: 'BOT:durable', base_url: FOREIGN }), telegramBots: { 42: { token: 'BOT:42', key: OLDER } } };
    const browser = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: { ref: 'station' } }) }, bak: dirty }), durableTokens: { discord: 'BOT:durable' } });
    const b = json(browser.files.bak);
    A.eq([holders(browser, OWN), holders(browser, U), holders(browser, FOREIGN), holders(browser, OLDER)], [[], [], [], []], '6: main rewritten but the .bak not swept: its keys and endpoints go, on a browser station too');
    A.eq([b.telegram.token, b.telegramBots['42'].token, 'token' in b.discord], [TOKEN, 'BOT:42', false], '6: a non-durable token in the .bak is its only copy and stays; a durable one goes');
    const torn = '{"telegram":{"key":"' + OWN;
    const t = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: { ref: 'station' } }) }, bak: torn }) });
    A.eq(read(t.files.bak), torn, '6: a torn .bak is left byte for byte (recovery may need it)');
    A.ok(t.warns.some(w => /secrets\.json\.bak/.test(w) && /could not read/.test(w)), '...and said');
  }

  // ---- a quarantined copy of secrets.json is forensic: named once a boot, and left ----
  {
    const dir = seed({ secrets: { telegram: bot({ credential: { ref: 'station' } }) } });
    const q = path.join(dir, 'channels', 'secrets.json.corrupt-4242-1'), torn = '{"telegram":{"key":"' + OWN;
    fs.writeFileSync(q, torn);
    const s = channelStation({ dir });
    A.eq(read(q), torn, 'a quarantine is left as it is');
    A.eq(s.warns.filter(w => /secrets\.json\.corrupt-4242-1/.test(w) && /may hold/.test(w)).length, 1, 'it is named, in one line');
    A.ok(!JSON.stringify(s.warns).includes(OWN), '...never what it holds');
  }

  // ---- the desktop: a key stays out of the file, an endpoint does not (decision 3, probe R4) ----
  {
    const dir = seed({ secrets: { telegram: bot({ key: OWN, baseUrl: U }), discord: bot({ provider: 'custom', baseUrl: U, key: '' }) } });
    const s = channelStation({ dir, desktop: true });
    A.eq(holders(s, OWN), [], 'desktop: the own key is on no disk');
    const row = json(s.files.channel).channels.telegram;
    A.eq([row.ownKey, row.key, row.baseUrl], [true, undefined, U], 'desktop: the entry records that the bot was given one, and keeps its URL');
    A.eq(pair(s.hub('telegram')), [OWN, U, true], 'desktop: it serves for the session');
    A.eq(s.hub('discord').baseUrl, U, 'desktop (R4): a keyless own endpoint serves a keyless run');
    const after = channelStation({ dir, desktop: true, env: { OPENROUTER_API_KEY: HELD } });
    const h = after.hub('telegram');
    A.eq([h.key, h.configured, h.error], ['', false, 'this bot\'s own OPENROUTER key was kept for that session only — reconnect it with its key, or with none to use the station\'s'], 'desktop: after a restart it is refused with the sentence, never moved onto the station\'s key');
    A.eq([after.hub('discord').baseUrl, after.hub('discord').configured], [U, true], 'desktop (R4): the keyless own endpoint survives the migration and a restart');
    // a browser file carried over: the desktop rewrites the entry without the key at its first boot
    const moved = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: { ref: 'channel', bind: 'b1' } }) }, channel: envelope({ telegram: entry('b1', { key: OWN }) }) }), desktop: true });
    A.eq([holders(moved, OWN), pair(moved.hub('telegram'))], [[], [OWN, DEFAULT, true]], 'desktop: a key in the file leaves it at boot, and serves for that session');
  }

  // ---- an unreadable file is left alone, and nothing is decided because of it ----
  {
    // the channel file cannot be read (a directory stands there: EISDIR, as a locked file answers EBUSY)
    const dir = seed({ secrets: { telegram: bot({ key: OWN }) }, bak: { telegram: bot({ key: OLDER }) } });
    const chan = path.join(dir, '.secrets', 'channel-credentials.json');
    fs.mkdirSync(chan);
    const s = channelStation({ dir });
    A.eq(pair(s.hub('telegram')), [OWN, DEFAULT, true], 'unreadable channel file: the bot keeps working on what its record carries');
    A.eq(holders(s, OWN).includes('secrets'), true, '...and the record keeps it on disk');
    A.eq(holders(s, OLDER), ['bak'], '...and the .bak is not swept while a move is pending');
    s.save();
    A.eq(json(s.files.secrets).telegram.key, OWN, '...any later save keeps the key on its record');
    A.ok(s.warns.some(w => /^\[channels\] telegram: /.test(w) && /could not be moved/.test(w)), '...and the log says so: ' + JSON.stringify(s.warns));
    fs.rmdirSync(chan);
    const next = channelStation({ dir });
    A.eq([holders(next, OWN), holders(next, OLDER), pair(next.hub('telegram'))], [['channel', 'channelBak'], [], [OWN, DEFAULT, true]], '...the next boot that can read it moves the key');

    // secrets.json cannot be read: it loads as no records, and every entry would read as an orphan
    const dir2 = seed({ channel: envelope({ telegram: entry('b1', { key: OWN }) }) });
    fs.mkdirSync(path.join(dir2, 'channels', 'secrets.json'));
    const s2 = channelStation({ dir2, dir: dir2 });
    A.eq([s2.status(), holders(s2, OWN)], ['unreadable', ['channel', 'channelBak']], 'unreadable secrets.json: no entry is deleted because of it');

    /* review r1: the channel file cannot be read while its record holds a REFERENCE (an antivirus scan or a backup agent holds it
       open with no sharing: EBUSY, here a directory standing in its place). Nothing can be said about the bot's own key while the
       file is closed to us: it is not "no longer saved", and a forget cannot have removed it. Red at 86ff765db: the bot read as
       'gone' ("is no longer saved on this station — reconnect it"), and dropChannel answered true without touching the disk, so
       the forget routes answered purged:true while the key stayed in both copies. */
    const dir3 = seed({ secrets: { telegram: bot({ credential: { ref: 'channel', bind: 'b1' } }) }, channel: envelope({ telegram: entry('b1', { key: OWN }) }) });
    const chan3 = path.join(dir3, '.secrets', 'channel-credentials.json');
    const aside = path.join(root, 'aside-' + (++seq));
    fs.mkdirSync(aside);
    fs.renameSync(chan3, path.join(aside, 'main'));
    fs.renameSync(chan3 + '.bak', path.join(aside, 'bak'));
    fs.mkdirSync(chan3);
    const locked = channelStation({ dir: dir3 });
    const UNREADABLE = 'this bot\'s own OPENROUTER key could not be read on this station just now (.secrets/channel-credentials.json is locked or unreadable) — it is read again with the next message; if that keeps failing, close whatever holds the file open, or reconnect the bot with its key';
    const lh = locked.hub('telegram');
    A.eq([lh.key, lh.configured, lh.error], ['', false, UNREADABLE], 'unreadable channel file: the bot is refused with a sentence that says the file could not be read, never that its key is gone');
    A.eq(json(locked.files.secrets).telegram.credential, { ref: 'channel', bind: 'b1' }, '...its record is left as it is');
    A.eq(locked.credStore.dropChannel('telegram'), false, 'unreadable channel file: a forget cannot prove anything left it, so it answers false (the routes then answer purged:false)');
    A.eq(locked.credStore.putChannel('telegram', { provider: 'openrouter', key: '' }).persisted, false, '...and a connect that turns the bot to the station says its old entry is not proven gone');
    A.eq(locked.warns.filter(w => /channel-credentials\.json could not be read/.test(w)).length, 1, '...and the log says, once, that the file could not be read: ' + JSON.stringify(locked.warns));
    // the lock clears: the same station reads the file again at its next use, and a retried forget proves the key is gone
    fs.rmdirSync(chan3);
    fs.renameSync(path.join(aside, 'main'), chan3);
    fs.renameSync(path.join(aside, 'bak'), chan3 + '.bak');
    A.eq(holders(locked, OWN), ['channel', 'channelBak'], 'fixture: the file is back, with the key in both copies');
    A.eq(locked.credStore.dropChannel('telegram'), true, 'the lock clears: a retried forget answers true...');
    A.eq(holders(locked, OWN), [], '...and the key is in neither copy');
  }

  // ---- a write that fails moves nothing ----
  {
    const dir = seed({ secrets: { telegram: bot({ key: OWN, baseUrl: U }) }, bak: { telegram: bot({ key: OLDER }) } });
    const d = disk();
    d.st.block = /channel-credentials/;
    const s = channelStation({ dir, fs: d.fsio });
    A.eq(pair(s.hub('telegram')), [OWN, U, true], 'a failed write: the bot keeps working');
    A.eq([json(s.files.secrets).telegram.key, json(s.files.secrets).telegram.baseUrl], [OWN, U], '...the record keeps its key and endpoint');
    A.ok(s.credStore.secretValues().includes(OWN), '...redaction holds the key');
    s.save();
    A.eq(json(s.files.secrets).telegram.key, OWN, '...through any later save');
    A.ok(!JSON.stringify(s.warns).includes(OWN) && s.warns.some(w => /channel-credentials\.json is not proven saved/.test(w)), '...the log names the file, never a value');
    d.st.block = null;
    const next = channelStation({ dir, fs: d.fsio });
    A.eq([holders(next, OWN), pair(next.hub('telegram'))], [['channel', 'channelBak'], [OWN, U, true]], '...the next boot retries and moves it');
  }

  // ---- an entry goes only once its record has landed: a record save that fails keeps the two in step ----
  {
    const ref = { ref: 'channel', bind: 'b1' }, env = { OPENROUTER_API_KEY: HELD };
    const dir = seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: HELD }) }) });
    const d = disk();
    d.st.block = /secrets\.json/;
    const s = channelStation({ dir, fs: d.fsio, env });
    A.eq([json(s.files.secrets).telegram.credential, holders(s, HELD)], [ref, ['channel', 'channelBak']], 'a record save that fails: the entry stays on disk beside its record, so the bot is never left refused');
    A.eq(pair(s.hub('telegram')), [HELD, DEFAULT, true], '...the bot follows the station in this session');
    d.st.block = null;
    const next = channelStation({ dir, fs: d.fsio, env });
    A.eq([json(next.files.secrets).telegram.credential, holders(next, HELD), pair(next.hub('telegram'))], [{ ref: 'station' }, [], [HELD, DEFAULT, true]], '...and the next boot finishes the conversion');
  }

  /* ---- review r1: a change of a bot's own credential lands with the record that names it, or not at all ----
     A connect, a sync or a bot add hands putChannel the bot's new credential before its record is saved. putChannel wrote the new
     entry over the old one at once, so when the record's save failed, or the station stopped between the two, the record on disk
     named an entry that was not there any more. On the same provider (whose bind was kept) the bot came back on the new key a
     route had answered "nothing was started" for; on a provider switch (a new bind) it was refused as 'gone', the next boot
     deleted the new entry as an orphan, and neither key was left anywhere. Each version now stays until a record proven on disk
     names one, and a boot keeps the one its record names. Red at e1d54e4be. */
  {
    const K2 = 'sk-or-v1-bot-second-key-K2-0123456789abc', A2 = 'sk-ant-api03-bot-second-key-0123456789abcdefAB';
    const SWITCHES = [['the same provider', { provider: 'openrouter', key: K2 }, K2], ['a provider switch', { provider: 'anthropic', key: A2 }, A2]];
    // a crash between the entry and the record: the next boot finds the record as it was, and the key that record names
    for (const [how, input, newer] of SWITCHES) {
      const dir = seed({ secrets: { telegram: bot({ key: OWN }) } });
      const s = channelStation({ dir });
      A.eq(pair(s.hub('telegram')), [OWN, DEFAULT, true], 'fixture: ' + how + ': the bot runs on its own key K1');
      s.credStore.putChannel('telegram', input);   // a connect, a sync or a bot add, up to its record's save; the station stops there
      const next = channelStation({ dir });
      A.eq([pair(next.hub('telegram')), holders(next, OWN), holders(next, newer)], [[OWN, DEFAULT, true], ['channel', 'channelBak'], []],
        'a crash on ' + how + ' before the record is saved: the record still names K1, so the bot runs on K1, and the key that never landed is in no file');
    }
    // the record is proven saved: the new credential stands, and the old key is in no file
    for (const [how, input, newer] of SWITCHES) {
      const dir = seed({ secrets: { telegram: bot({ key: OWN }) } });
      const s = channelStation({ dir });
      const own = s.credStore.putChannel('telegram', input);
      s.records().telegram = Object.assign({}, s.records().telegram, { provider: input.provider, credential: own.credential });
      A.eq(s.save(), true, 'fixture: ' + how + ': the record naming the new credential is saved');
      A.eq([s.view('telegram').key, holders(s, OWN), holders(s, newer)], [newer, [], ['channel', 'channelBak']], 'a record proven saved on ' + how + ': the bot runs on the new key, and K1 is in no file');
      A.eq(channelStation({ dir }).view('telegram').key, newer, '...across a restart');
    }
    // an agent-bound bot's re-add whose record save fails: the route rolls its record back in memory (and answers 500, "nothing
    // was started"), and what it changed in the channel file is undone, read against the record the disk still holds
    for (const [how, input, newer] of SWITCHES) {
      const d = disk();
      const dir = seed({ secrets: { telegramBots: { 42: bot({ key: OWN, username: 'agent_bot' }) } } });
      const s = channelStation({ dir, fs: d.fsio });
      A.eq(s.view('telegramBots:42').key, OWN, 'fixture: ' + how + ': the agent-bound bot runs on its own key K1');
      const own = s.credStore.putChannel('telegramBots:42', input);
      d.st.block = /secrets\.json/;   // secrets.json cannot be written (an antivirus lock, a read-only file, a full disk)
      // the route's own patch always changes the record (a fresh owner-pairing state, the token): so does this one
      A.eq(s.botRecord('42', { provider: input.provider, credential: own.credential, name: 'RE-ADDED' }), false, 'fixture: ' + how + ': the re-add cannot prove its record saved');
      A.eq([s.view('telegramBots:42').key, holders(s, OWN), holders(s, newer)], [OWN, ['channel', 'channelBak'], []],
        'a failed re-add on ' + how + ': the bot keeps K1, on disk in both copies, and the key it was handed is in no file');
      d.st.block = null;
      A.eq(channelStation({ dir, fs: d.fsio }).view('telegramBots:42').key, OWN, '...and after a restart it runs on K1, the key its saved record names');
    }
    // a connect or a sync whose record save fails keeps its record in memory (live for this session, persisted:false): both
    // versions stay, the bot runs on the new one now, and a restart comes back on the one the saved record names
    for (const [how, input, newer] of SWITCHES) {
      const d = disk();
      const dir = seed({ secrets: { telegram: bot({ key: OWN }) } });
      const s = channelStation({ dir, fs: d.fsio });
      const own = s.credStore.putChannel('telegram', input);
      s.records().telegram = Object.assign({}, s.records().telegram, { provider: input.provider, credential: own.credential, name: 'RECONNECTED' });
      d.st.block = /secrets\.json/;
      A.eq(s.save(), false, 'fixture: ' + how + ': the connect\'s record save fails');
      A.eq([s.view('telegram').key, holders(s, OWN), holders(s, newer)], [newer, ['channel', 'channelBak'], ['channel', 'channelBak']],
        'a connect on ' + how + ' that is live but not saved: the bot runs on the new key this session, and both versions are on disk');
      d.st.block = null;
      const next = channelStation({ dir, fs: d.fsio });
      A.eq([next.view('telegram').key, holders(next, newer)], [OWN, []], '...and after a restart it runs on K1, the key its saved record names, and the other is in no file');
    }
  }

  // ---- review r2: unchanged memory never proves a failed channel-file write (connect, settle, forget) ----
  // Real files and the production save/readback functions, with faults only at the filesystem edge. These retry paths
  // previously returned true without checking the destination; a reconnect even claimed keyPersisted while no file held it.
  {
    const d = disk(), dir = seed({ secrets: { telegram: bot({}) } });
    const s = channelStation({ dir, fs: d.fsio });
    d.st.block = /channel-credentials\.json/;
    const input = { provider: 'openrouter', key: OWN, baseUrl: U };
    const first = s.credStore.putChannel('telegram', input);
    A.eq([first.persisted, first.keyPersisted, holders(s, OWN)], [false, false, []], 'connect: a blocked first write is not durable');
    const again = s.credStore.putChannel('telegram', input);
    A.eq([again.persisted, again.keyPersisted], [false, false], 'connect: an identical retry while blocked still reports unproven');
    d.st.block = null;
    const landed = s.credStore.putChannel('telegram', input);
    A.eq([landed.persisted, landed.keyPersisted, holders(s, OWN)], [true, true, ['channel', 'channelBak']], 'connect: an identical retry proves both destination copies before claiming saved');
    s.records().telegram.credential = landed.credential;
    A.eq(s.save(), true, 'connect: the record naming the proven entry saves');
    A.eq(channelStation({ dir }).view('telegram').key, OWN, 'connect: the key claimed saved is available after a restart');
  }
  for (const operation of ['settle', 'forget']) {
    const d = disk(), dir = seed({ secrets: { telegram: bot({ key: OWN }) } });
    const s = channelStation({ dir, fs: d.fsio });
    const change = operation === 'forget' ? () => s.credStore.dropChannel('telegram') : () => s.credStore.settleChannels([]);
    d.st.block = /channel-credentials\.json/;
    A.eq(change(), false, operation + ': a blocked removal is unproven');
    A.eq(change(), false, operation + ': an unchanged retry cannot claim the still-saved key is gone');
    A.eq(holders(s, OWN), ['channel', 'channelBak'], operation + ': the fixture still holds the key in both files');
    d.st.block = null;
    A.eq(change(), true, operation + ': the unchanged retry repairs and reads back the destination');
    A.eq(holders(s, OWN), [], operation + ': a proven removal leaves the key in neither copy');
  }

  // ---- review r2: every unproven bind survives until the actual records identify what can be removed ----
  // A record write can land while its read-back fails. A later write can fail before landing. Keeping oldest+latest alone
  // then loses the middle key the authoritative record names. Exercise a deeper chain, provider changes, both restart and
  // explicit settlement, and the redaction/lookup readers of every retained version.
  for (const how of ['restart', 'settle']) {
    const d = disk(), dir = seed({ secrets: { telegram: bot({ key: OWN }) } });
    const s = channelStation({ dir, fs: d.fsio });
    const middle = { provider: 'anthropic', key: OLDER, baseUrl: 'http://fixture:middle-secret@127.0.0.1:9/middle/v1' };
    const chosen = s.credStore.putChannel('telegram', middle);
    s.records().telegram = Object.assign({}, s.records().telegram, { provider: middle.provider, credential: chosen.credential });
    d.st.readBlockAfterWrite = /[\\/]channels[\\/]secrets\.json$/;
    A.eq(s.save(), false, how + ': the middle record write lands but its read-back fails');
    A.eq(json(s.files.secrets).telegram.credential, chosen.credential, how + ': actual disk names the middle bind despite failed read-back');
    d.st.readBlock = null;
    d.st.readBlockAfterWrite = null;
    d.st.block = /secrets\.json/;
    const later = [NEWER, 'sk-or-v1-final-unproven-credential-0123456789'];
    for (const key of later) {
      const own = s.credStore.putChannel('telegram', { provider: 'openrouter', key });
      s.records().telegram = Object.assign({}, s.records().telegram, { provider: 'openrouter', credential: own.credential });
      A.eq(s.save(), false, how + ': a later record cannot reach disk');
    }
    for (const key of [OWN, OLDER].concat(later)) {
      A.eq(holders(s, key), ['channel', 'channelBak'], how + ': each uncertain key remains in both destination copies');
      A.ok(s.credStore.secretValues().includes(key), how + ': each retained key stays redacted');
    }
    A.ok(s.credStore.secretValues().includes('middle-secret'), how + ': a retained endpoint credential stays redacted');
    A.eq(s.credStore.channel('telegram', { provider: 'anthropic', credential: chosen.credential }).key, OLDER, how + ': a live reader resolves a middle bind on its own provider');
    A.eq(s.credStore.channel('telegram', { provider: 'openrouter', credential: chosen.credential }).keyLost, 'gone', how + ': that middle bind never crosses a provider');
    d.st.block = null;
    if (how === 'settle') {
      A.eq(s.credStore.settleChannels(S.credentialRows(s.records()).concat(S.credentialRows(json(s.files.secrets)))), true, 'settle: both live and authoritative disk records select the versions to retain');
      A.eq([holders(s, OWN), holders(s, later[0]), holders(s, OLDER), holders(s, later[1])], [[], [], ['channel', 'channelBak'], ['channel', 'channelBak']], 'settle: only versions neither record names are removed');
    }
    const after = channelStation({ dir });
    A.eq([after.view('telegram').key, after.view('telegram').provider], [OLDER, 'anthropic'], how + ': restart uses the actual saved middle key/provider');
    A.eq([holders(after, OWN), holders(after, later[0]), holders(after, later[1])], [[], [], []], how + ': restart removes only the versions its authoritative record does not name');
  }

  // Loading a file after an unreadable boot merges its durable versions with a connect's pending in-memory entry.
  {
    const d = disk(), ref = { ref: 'channel', bind: 'before-unreadable' };
    const dir = seed({ secrets: { telegramBots: { 42: bot({ credential: ref }) } }, channel: envelope({ 'telegramBots:42': entry(ref.bind, { key: OWN }) }) });
    d.st.readBlock = /channel-credentials\.json/;
    const s = channelStation({ dir, fs: d.fsio });
    const input = { provider: 'openrouter', key: NEWER };
    const pending = s.credStore.putChannel('telegramBots:42', input);
    A.eq(pending.persisted, false, 'reload: reconnect beside an unreadable channel file is unproven');
    d.st.block = /secrets\.json/;
    A.eq(s.botRecord('42', { credential: pending.credential, name: 'UNPROVEN' }), false, 'reload: record failure keeps the older live bind');
    d.st.readBlock = null;
    A.eq(s.credStore.putChannel('telegramBots:42', input).persisted, true, 'reload: once readable the pending entry can be saved');
    A.eq([holders(s, OWN), holders(s, NEWER)], [['channel', 'channelBak'], ['channel', 'channelBak']], 'reload: saving the pending entry preserves the newly readable durable version');
    A.eq(s.view('telegramBots:42').key, OWN, 'reload: the live old record resolves its durable key');
    A.eq(channelStation({ dir }).view('telegramBots:42').key, OWN, 'reload: the saved old record still resolves its key after restart');
  }

  // A failed re-add can leave a newer pending entry beside an older live record. Station-key adoption must judge that live
  // record's bind, including endpoint-only conversion, rather than silently switching the bot to the pending version.
  for (const ownEndpoint of [false, true]) {
    const d = disk(), dir = seed({ secrets: { telegramBots: { 42: bot({ key: OWN, baseUrl: ownEndpoint ? U : '' }) } } });
    const s = channelStation({ dir, fs: d.fsio });
    const oldRef = s.records().telegramBots['42'].credential;
    const pending = s.credStore.putChannel('telegramBots:42', { provider: 'openrouter', key: NEWER });
    d.st.readBlockAfterWrite = /[\\/]channels[\\/]secrets\.json$/;
    A.eq(s.botRecord('42', { credential: pending.credential, name: 'UNPROVEN' }), false, 'conversion: a re-add lands but cannot be read back, and restores its old live record');
    d.st.block = /secrets\.json/;
    s.putPage('openrouter', { key: NEWER }, {});
    A.eq([s.view('telegramBots:42').key, s.records().telegramBots['42'].credential], [OWN, oldRef], 'conversion: adopting the pending key does not replace the live bot key or bind');
    s.push('openrouter', { key: OWN });
    if (ownEndpoint) {
      A.eq([s.view('telegramBots:42').key, s.view('telegramBots:42').baseUrl, s.records().telegramBots['42'].credential], ['', U, oldRef], 'conversion: only the named older version becomes endpoint-only');
      A.eq(s.credStore.channel('telegramBots:42', { provider: 'openrouter', credential: pending.credential }).key, NEWER, 'conversion: the other uncertain version retains its own key');
    } else {
      A.eq(s.records().telegramBots['42'].credential, { ref: 'station' }, 'conversion: adopting the live named key converts that bot');
      A.eq([holders(s, OWN), holders(s, NEWER)], [['channel', 'channelBak'], ['channel', 'channelBak']], 'conversion: an unproven record conversion retains every prior key');
    }
  }

  // ---- a crash at every write of the boot: a key is never lost, and a recovery never rolls one back ----
  {
    const SCENARIOS = [
      ['an older build\'s own key', () => ({ secrets: { telegram: bot({ key: OWN, baseUrl: U }), discord: bot({ key: NEWER }) }, bak: { telegram: bot({ key: OWN }) } }), { telegram: OWN, discord: NEWER }],
      ['a half-migrated record', () => ({ secrets: { telegram: bot({ key: OWN }) }, bak: { telegram: bot({ key: OLDER }) }, channel: envelope({ telegram: entry('b0', { key: OLDER }) }) }), { telegram: OWN }],
      ['a torn main over a newer entry', () => ({ secrets: '{"tele', bak: { telegram: bot({ key: OLDER }) }, channel: envelope({ telegram: entry('b1', { key: NEWER }) }) }), { telegram: NEWER }],
      ['a torn main and no entry', () => ({ secrets: '{"tele', bak: { telegram: bot({ key: OLDER }) } }), { telegram: OLDER }]
    ];
    for (const [label, make, want] of SCENARIOS) {
      const clean = disk();
      channelStation({ dir: seed(make()), fs: clean.fsio });
      const writes = clean.st.ops;
      A.ok(writes >= 3, 'fixture: ' + label + ': the clean boot writes (' + writes + ')');
      for (let crashAt = 0; crashAt < writes; crashAt++) {
        const dir = seed(make()), d = disk();
        d.st.crashAt = crashAt;
        const s = channelStation({ dir, fs: d.fsio });
        for (const [id, key] of Object.entries(want)) {
          if (!Object.keys(s.files).some(n => read(s.files[n]).includes(key))) A.ok(false, label + ': a crash after ' + crashAt + ' writes lost ' + id + '\'s key');
        }
        const after = channelStation({ dir });
        for (const [id, key] of Object.entries(want)) {
          if (after.hub(id).key !== key) A.ok(false, label + ': after a crash at ' + crashAt + ', ' + id + ' resolves ' + after.hub(id).key + ', not its key');
          if (holders(after, key).join() !== 'channel,channelBak') A.ok(false, label + ': after a crash at ' + crashAt + ', ' + id + '\'s key is in ' + holders(after, key));
        }
        for (const old of [OLDER]) if (!Object.values(want).includes(old) && holders(after, old).length) A.ok(false, label + ': after a crash at ' + crashAt + ', the older key is in ' + holders(after, old));
        const dd = disk();
        channelStation({ dir, fs: dd.fsio });
        if (dd.st.ops) A.ok(false, label + ': after a crash at ' + crashAt + ', the next clean boot still writes (' + dd.st.ops + ')');
      }
      A.ok(true, label + ': every crash point of ' + writes + ' keeps the key, and the next boot finishes the job');
    }
  }

  // ---- a key that becomes station-held turns its channel into a station reference at once (channels TODO 3) ----
  {
    const ref = { ref: 'channel', bind: 'b1' };
    const dir = seed({ secrets: { telegram: bot({ credential: ref }), telegramBots: { 42: { token: 'B', provider: 'openrouter', agentId: 'agent', credential: { ref: 'channel', bind: 'b2' } } } },
      channel: envelope({ telegram: entry('b1', { key: OWN }), 'telegramBots:42': entry('b2', { key: OWN }) }) });
    const s = channelStation({ dir });
    s.putPage('openrouter', { key: OWN });
    A.eq([json(s.files.secrets).telegram.credential, json(s.files.secrets).telegramBots['42'].credential, holders(s, OWN)], [{ ref: 'station' }, { ref: 'station' }, []], 'a page save of a bot\'s own key: each bot that held it follows the station at once, and the key leaves the channel file');
    A.eq(s.hub('telegram').key, OWN, '...it still runs that key, as the station\'s');
    s.putPage('openrouter', { key: NEWER });
    A.eq([s.hub('telegram').key, holders(s, OWN)], [NEWER, []], '...and the page\'s next rotation reaches it with no sync and no restart');
    const push = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: OWN }) }) }) });
    push.push('openrouter', { key: OWN });
    A.eq([json(push.files.secrets).telegram.credential, holders(push, OWN)], [{ ref: 'station' }, []], 'a push of a bot\'s own key does the same');
    const u = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: OWN, baseUrl: U }) }) }) });
    u.push('openrouter', { key: OWN });
    A.eq([json(u.files.secrets).telegram.credential, holders(u, OWN), json(u.files.channel).channels.telegram.baseUrl], [ref, [], U], '...keeping an endpoint of its own, endpoint only');
    const other = channelStation({ dir: seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: OWN }) }) }) });
    other.push('anthropic', { key: OWN });
    A.eq(json(other.files.secrets).telegram.credential, ref, 'the same value on another provider is another key: nothing moves');
    // the record's save is not proven: the entry stays on disk, in step with the record there, and the next boot converts it
    const dir3 = seed({ secrets: { telegram: bot({ credential: ref }) }, channel: envelope({ telegram: entry('b1', { key: OWN }) }) });
    const d = disk(), f = channelStation({ dir: dir3, fs: d.fsio });
    d.st.block = /secrets\.json/;
    f.push('openrouter', { key: OWN });
    d.st.block = null;
    A.eq([json(f.files.secrets).telegram.credential, holders(f, OWN)], [ref, ['channel', 'channelBak']], 'a failed record save: record and entry stay in step on disk');
    A.eq(f.hub('telegram').key, OWN, '...the bot follows the station in this session');
  }
  fs.rmSync(root, { recursive: true, force: true });
}

A.report('channels.secrets.test');
