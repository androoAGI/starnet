/* node test/channels.secrets.test.js — the channel-token keychain seam (T1.4).

   Proves the pure token-vs-config split + migration logic (sidecar/channels/secrets.js) and static-guards the
   host wiring on BOTH sides:
     • splitSecret pulls the bot token out and leaves every non-secret field.
     • stripTokens removes every channel token (what the desktop build persists) and keeps the rest.
     • migratePlaintext: bare mode = untouched; desktop mode imports the plaintext token AND strips it; an
       already-migrated channel (keychain has it) is stripped but NOT re-imported; a tokenless config is a no-op.
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
//   home — keep it. The provider `key` is still dropped (it lives in the shell keychain). The token is STILL reported
//   as an import so the shell can adopt it into the keychain this launch (self-heal).
{
  const secrets = { telegram: { token: 'T:1', key: 'sk-tg', model: 'm', enabled: true }, discord: { token: 'D:2', key: 'sk-dc', model: 'm2' }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => false });
  A.eq(res.changed, true, 'desktop: dropping the plaintext key forces a change');
  A.eq(res.config.telegram.token, 'T:1', 'desktop w/o keychain: token KEPT in persisted config (last copy)');
  A.eq(res.config.discord.token, 'D:2', 'desktop w/o keychain: discord token KEPT too');
  A.ok(!('key' in res.config.telegram) && !('key' in res.config.discord), 'desktop: provider keys stripped from persisted config (P1)');
  A.eq(res.config.telegram, { token: 'T:1', model: 'm', enabled: true }, 'desktop: telegram config preserved minus key');
  A.eq(res.config.notifyAutonomous, true, 'desktop: non-channel keys preserved');
  const ids = res.imports.map(i => i.id).sort();
  A.eq(ids, ['discord', 'telegram'], 'desktop: both tokens reported for keychain import (self-heal)');
  A.eq(res.imports.find(i => i.id === 'telegram').token, 'T:1', 'desktop: import carries the real token');
  // the KEY is stripped but NEVER handed back as an import (nothing for the sidecar to adopt — it lives in the shell)
  A.ok(!res.imports.some(i => 'key' in i || i.token === 'sk-tg' || i.token === 'sk-dc'), 'desktop: provider key is strip-only, never imported');
}

// ---- D2. migratePlaintext: desktop mode WITH keychain proof strips the token (durable home exists) ----
{
  const secrets = { telegram: { token: 'T:1', key: 'sk-tg', model: 'm', enabled: true }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => true });
  A.eq(res.changed, true, 'desktop w/ keychain: token+key stripped -> change');
  A.ok(!('token' in res.config.telegram), 'desktop w/ keychain: token stripped (keychain proves the durable home)');
  A.ok(!('key' in res.config.telegram), 'desktop w/ keychain: key stripped');
  A.eq(res.config.telegram, { model: 'm', enabled: true }, 'desktop w/ keychain: config minus both secrets');
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
  A.eq(failed.config.signal, { endpoint: 'http://127.0.0.1:8080', account: '+15550001111', model: 'm' }, 'Signal keeps its endpoint/account config, loses only the provider key');

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

// ---- F2. migratePlaintext: a KEY-ONLY legacy record (token already migrated) still forces the scrub ----
{
  // the exact P1 regression case: an already-token-migrated channel whose plaintext `key` was still being written.
  const secrets = { telegram: { key: 'sk-leaked', model: 'm', enabled: true }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => true });
  A.eq(res.changed, true, 'desktop: a lone plaintext key forces a rewrite (scrub)');
  A.eq(res.imports, [], 'desktop: a lone key imports nothing (strip-only)');
  A.ok(!('key' in res.config.telegram), 'desktop: the lone key is stripped from persisted config');
  A.eq(res.config.telegram, { model: 'm', enabled: true }, 'desktop: config minus the key is preserved');
  A.ok(JSON.stringify(res.config).indexOf('sk-leaked') < 0, 'desktop: no key substring survives migration');
  // bare mode leaves the key alone (honest plaintext fallback; there is no keychain to be more secure than a file)
  const bare = S.migratePlaintext(secrets, { keychainMode: false });
  A.eq(bare.config, secrets, 'bare mode: key-carrying config is untouched (honest fallback)');
  A.eq(bare.changed, false, 'bare mode: nothing stripped');
  // hasStrippableSecret is the exported predicate the boot .bak-scrub relies on
  A.ok(S.hasStrippableSecret({ key: 'x', model: 'm' }) === true, 'hasStrippableSecret true for a plaintext key');
  A.ok(S.hasStrippableSecret({ token: 't', model: 'm' }) === false, 'hasStrippableSecret false for a token-only record (token counted separately)');
  A.ok(S.hasStrippableSecret({ model: 'm' }) === false, 'hasStrippableSecret false for a secret-free record');
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
  A.ok(/DESKTOP_SHELL\s*\?\s*channelSecretsMod\.stripTokens\(obj,\s*isChannelTokenDurable\)/.test(src), 'saveChannelSecrets strips secrets DURABILITY-AWARE under the desktop shell (never the last copy)');
  A.ok(/migratePlaintext/.test(src), 'index.js runs the boot migration');
  A.ok(/'\/api\/channels\/token'/.test(src) && /handleSetChannelToken/.test(src), 'index.js wires the token-push route');
  // DURABILITY LEDGER (Andrew's invariant): a ledger exists, spawn-env seeds it durable, and a body-token stays non-durable.
  A.ok(/channelTokenDurable/.test(src), 'index.js tracks per-channel token durability');
  A.ok(/function isChannelTokenDurable/.test(src), 'index.js exposes isChannelTokenDurable(id)');
  A.ok(/channelTokenRuntime\[id\]\s*=\s*v;\s*channelTokenDurable\[id\]\s*=\s*v/.test(src), 'spawn-env seeds the exact keychain-backed value into the durability ledger');
  A.ok(/scrubChannelSecretsBak[\s\S]*?stripTokens\(parsed,\s*isChannelTokenDurable\)/.test(src), 'the .bak scrub is durability-aware (never destroys the last copy in .bak)');
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
  A.ok(/providerRuntimeKey\(provider,\s*t\.key\s*\|\|\s*''\)/.test(src), 'telegram secrets() resolves the key via providerRuntimeKey (runtime/env fallback, not the persisted plaintext)');
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

A.report('channels.secrets.test');
