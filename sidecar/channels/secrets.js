/* sidecar/channels/secrets.js — the secret-vs-config split for channel secrets (T1.4 + P1 key hygiene).

   Channel configs (Telegram/Discord) live at WORKSPACES/channels/secrets.json. Historically the whole record —
   INCLUDING the bot token AND the resolved provider API `key` — was persisted plaintext there. On the desktop
   build BOTH secrets belong in the OS keychain (keyring service "ai.skynet.harness"): the bot token under account
   "channel:<id>", the BYOK provider key under the provider's own account — both injected into the sidecar env at
   spawn (SKYNET_<ID>_TOKEN / SKYNET_<PROVIDER>_API_KEY) and live-pushed via token-gated endpoints. The sidecar
   resolves the provider key at connect/run time from that runtime layer (providerRuntimeKey -> runtimeKeys/env),
   so it NEVER needs the plaintext `key` on desktop. The bare sidecar (npm start / tests) can't reach the keychain,
   so it HONESTLY keeps the plaintext bot token as its only fallback — that token path is unchanged.

   Two secret classes, stripped together but handled differently:
     • token  — a keychain-IMPORT candidate: the sidecar reports a plaintext bot token so the shell can adopt it
                 into the keychain (the sidecar can't write keyring itself). Reported in `imports`.
     • key    — STRIP-ONLY: the provider key already lives in the shell's keychain / env (it is pushed to the
                 sidecar via /api/key, never authored here), so a plaintext copy is pure leak. Removed from the
                 persisted config, NEVER re-imported (there is nothing for the sidecar to hand back).

   A RECORD HOLDS A REFERENCE, NEVER A PROVIDER CREDENTIAL (credential-store lane, step S8). A record used to keep its bot's
   provider `key` and endpoint (`baseUrl`, `base_url`; an older one `keyPool` too), so a rotated key stayed in secrets.json and
   its .bak and the bot went on using it. It now keeps credential: { ref, bind }:
     ref 'station'   the bot follows the station's credential for its provider, live
     ref 'channel'   the bot has an entry of its own in .secrets/channel-credentials.json, bound to this record by `bind`
   The entry, the conversions and the boot reconciliation are sidecar/credential-store.js's (its header's CHANNELS); this
   module is the record side of that: which records there are, what one carries, and the clone that gives it a reference.
     credentialRows(secrets)            -> [{ id, provider, credential, key, baseUrl, carries }]   one row per record, as the
                                           store's reconcileChannels reads them (a bot's id is 'telegramBots:<botId>')
     recordAt(secrets, id)              -> that record, or null
     withCredentials(secrets, byId)     -> clone: each named record gets that credential (null: none) and loses what it carries
     withCarried(secrets, carried, normalize)  -> clone for the disk: a record whose move failed keeps its credential there
     withoutProviderCredentials(secrets) -> clone: no record carries a provider credential (the .bak sweep)

   This module is the pure, deterministic, injectable core so the migration + fallback logic is unit-testable
   without Tauri. It knows nothing about fs, keyring, or env — the host injects those decisions:

     TOKEN_FIELDS                      -> secret keys that are keychain-IMPORT candidates (just `token`)
     STRIP_FIELDS                      -> every secret key removed from plaintext in keychain mode (`token` + `key`)
     RECORD_CREDENTIAL_FIELDS          -> the fields a record held a provider credential in, before S8
     splitSecret(record)               -> { config, token }   // config = non-secret remainder (both secrets out);
                                                               // token = the extracted bot token (import candidate)
     splitKeyOnly(record)              -> config              // config MINUS strip-only secrets (key) but KEEPING token
     stripTokens(secrets, isDurable)   -> secrets with the provider key removed everywhere, and the bot token removed
                                          ONLY for channels where isDurable(id) is true (default: all durable = legacy
                                          behaviour). A NON-durable channel keeps its plaintext token — that plaintext
                                          copy is the honest last-known-good fallback, exactly like the bare sidecar.
     migratePlaintext(secrets, { keychainMode, hasChannelToken }) ->
         { config, imports, changed }  // config to persist; imports=[{id,token}] to hand the keychain; changed=did we strip anything

   `keychainMode` = "is this the desktop shell?" (host passes STARNET_DESKTOP_SHELL === '1'). When false the record
   is returned untouched (browser/dev keeps its plaintext secrets). When true, any plaintext bot token is reported
   as an `import` — but it is ONLY removed from the persisted config when hasChannelToken(id) proves the keychain
   already holds it. When the keychain does NOT (yet) hold it, the token is reported as an import AND kept in the
   persisted config: a plaintext token on disk is strictly better than a lost token (the invariant: never remove the
   last copy of a secret without proof another durable home holds it). A provider key is the store's to move, before this
   runs (reconcileChannels), so this touches tokens only. `changed` is true if a token was removed, so a legacy file still
   triggers the scrub-rewrite. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.secrets = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the channels whose records carry secrets; other top-level keys (notifyAutonomous) are never secret.
  // slack's `token` is the combined "xoxb-… xapp-…" pair (one opaque secret); matrix's is the access token;
  // signal has no token (endpoint+account are non-secret config) but keeps a row so a provider `key` is stripped.
  const CHANNEL_IDS = ['telegram', 'discord', 'slack', 'matrix', 'signal'];
  // keychain-IMPORT candidates: a plaintext value here is reported so the shell can adopt it into the keychain.
  const TOKEN_FIELDS = ['token'];
  // EVERY secret field removed from a channel record under keychain mode. `key` is strip-only (the provider API
  // key already lives in the shell keychain / env and is pushed via /api/key — a plaintext copy is pure leak).
  const STRIP_FIELDS = ['token', 'key'];
  // the fields a record held its bot's provider credential in, before S8: only an older build writes them now
  const RECORD_CREDENTIAL_FIELDS = ['key', 'keyPool', 'baseUrl', 'base_url'];

  function isChannelRecord(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function telegramBotSecretId(botId) {
    const id = String(botId || '');
    return /^\d+$/.test(id) && id.length <= 20 ? 'telegram:' + id : '';
  }

  // pull the secret fields out of ONE channel record. Returns { config, token } where config is a shallow clone
  // MINUS every secret field (token AND key) and token is the extracted bot token (import candidate; '' when absent).
  function splitSecret(record) {
    const config = {};
    let token = '';
    if (isChannelRecord(record)) {
      for (const k of Object.keys(record)) {
        if (TOKEN_FIELDS.indexOf(k) >= 0) { if (record[k]) token = String(record[k]); continue; }   // extract + drop the import candidate
        if (STRIP_FIELDS.indexOf(k) >= 0) continue;                                                    // drop the strip-only secrets (key)
        config[k] = record[k];
      }
    }
    return { config, token };
  }

  // clone ONE channel record MINUS the strip-only secrets (key) but KEEPING the bot token. Used for a NON-durable
  // channel: the provider key still lives in the shell keychain (safe to drop), but the bot token has no proven
  // durable home, so its plaintext copy on disk is the honest last-known-good fallback and must survive.
  function splitKeyOnly(record) {
    const config = {};
    if (isChannelRecord(record)) {
      for (const k of Object.keys(record)) {
        if (TOKEN_FIELDS.indexOf(k) >= 0) { config[k] = record[k]; continue; }   // KEEP the token (not durable elsewhere)
        if (STRIP_FIELDS.indexOf(k) >= 0) continue;                               // drop the strip-only secrets (key)
        config[k] = record[k];
      }
    }
    return config;
  }

  // return a deep-ish clone of `secrets` for the desktop persist path. The provider `key` is ALWAYS stripped (it
  // lives in the shell keychain / env). The bot `token` is stripped ONLY for channels whose token is DURABLE
  // elsewhere (isDurable(id) true — in the keychain or spawn-env). A non-durable channel KEEPS its plaintext token:
  // that plaintext copy is the only surviving home, and losing it is the exact bug this guard closes. `isDurable`
  // defaults to always-true so a caller that omits it gets the legacy "strip every token" behaviour.
  function stripTokens(secrets, isDurable) {
    const out = {};
    const src = (secrets && typeof secrets === 'object') ? secrets : {};
    const durable = (typeof isDurable === 'function') ? isDurable : function () { return true; };
    for (const k of Object.keys(src)) {
      if (CHANNEL_IDS.indexOf(k) >= 0 && isChannelRecord(src[k])) {
        const split = splitSecret(src[k]);
        out[k] = split.token && durable(k, split.token) ? split.config : splitKeyOnly(src[k]);
      } else if (k === 'telegramBots' && isChannelRecord(src[k])) {
        const bots = {};
        for (const botId of Object.keys(src[k])) {
          const record = src[k][botId];
          const secretId = telegramBotSecretId(botId);
          if (isChannelRecord(record)) {
            const split = splitSecret(record);
            bots[botId] = secretId && split.token && durable(secretId, split.token) ? split.config : splitKeyOnly(record);
          }
          else bots[botId] = record;
        }
        out[k] = bots;
      } else out[k] = src[k];
    }
    return out;
  }

  // boot migration: given the loaded plaintext secrets, decide what to persist and what to import to the keychain.
  //   opts.keychainMode  = desktop shell? (only then do we import + strip)
  //   opts.hasChannelToken(id) -> bool  = does the keychain ALREADY hold this channel's token? (skip re-import)
  // Returns { config, imports:[{id,token}], changed }. In non-keychain mode config === secrets and imports === [].
  function migratePlaintext(secrets, opts) {
    const o = opts || {};
    const src = (secrets && typeof secrets === 'object') ? secrets : {};
    if (!o.keychainMode) return { config: src, imports: [], changed: false };
    const has = (typeof o.hasChannelToken === 'function') ? o.hasChannelToken : function () { return false; };
    const imports = [];
    let changed = false;
    const config = {};
    function migrateRecord(id, record) {
      const s = splitSecret(record);
      if (!s.token) return record;
      if (id) imports.push({ id: id, token: s.token });
      if (!id || !has(id, s.token)) return record;   // no proven home: the plaintext copy stays
      changed = true;
      const next = Object.assign({}, record);
      for (const f of TOKEN_FIELDS) delete next[f];
      return next;
    }
    for (const k of Object.keys(src)) {
      if (CHANNEL_IDS.indexOf(k) >= 0 && isChannelRecord(src[k])) {
        config[k] = migrateRecord(k, src[k]);
      } else if (k === 'telegramBots' && isChannelRecord(src[k])) {
        const bots = {};
        for (const botId of Object.keys(src[k])) {
          const record = src[k][botId];
          bots[botId] = isChannelRecord(record) ? migrateRecord(telegramBotSecretId(botId), record) : record;
        }
        config[k] = bots;
      } else {
        config[k] = src[k];
      }
    }
    return { config, imports, changed };
  }

  /* ---- the record side of a channel's credential (S8; the header) ---- */
  // a clone with fn(id, record) applied to every channel record; everything else (notifyAutonomous) as it is
  function mapRecords(secrets, fn) {
    const src = (secrets && typeof secrets === 'object') ? secrets : {};
    const out = {};
    for (const k of Object.keys(src)) {
      if (CHANNEL_IDS.indexOf(k) >= 0 && isChannelRecord(src[k])) out[k] = fn(k, src[k]);
      else if (k === 'telegramBots' && isChannelRecord(src[k])) {
        const bots = {};
        for (const botId of Object.keys(src[k])) bots[botId] = isChannelRecord(src[k][botId]) ? fn('telegramBots:' + botId, src[k][botId]) : src[k][botId];
        out[k] = bots;
      } else out[k] = src[k];
    }
    return out;
  }
  function recordAt(secrets, id) {
    const src = (secrets && typeof secrets === 'object') ? secrets : {};
    const bot = /^telegramBots:(.+)$/.exec(String(id || ''));
    const bots = isChannelRecord(src.telegramBots) ? src.telegramBots : {};
    const record = bot ? (Object.prototype.hasOwnProperty.call(bots, bot[1]) ? bots[bot[1]] : null) : (CHANNEL_IDS.indexOf(id) >= 0 ? src[id] : null);
    return isChannelRecord(record) ? record : null;
  }
  const text = v => (typeof v === 'string' ? v.trim() : '');
  // The record's public identity only, never a credential envelope or its arbitrary extra fields.
  // Bind equality is byte-exact in credential-store.js; do not trim or invent a new bind grammar here.
  function credentialReference(value) {
    if (!isChannelRecord(value)) return null;
    if (value.ref === 'station') return { ref: 'station' };
    return value.ref === 'channel' && typeof value.bind === 'string' && value.bind
      ? { ref: 'channel', bind: value.bind } : null;
  }
  // one row per record: its credential field and the provider credential it still carries, if an older build wrote one
  function credentialRows(secrets) {
    const rows = [];
    mapRecords(secrets, (id, record) => {
      rows.push({ id, provider: record.provider, credential: isChannelRecord(record.credential) ? record.credential : null,
        key: text(record.key), baseUrl: text(record.baseUrl) || text(record.base_url),
        carries: RECORD_CREDENTIAL_FIELDS.some(f => Object.prototype.hasOwnProperty.call(record, f)) });
      return record;
    });
    return rows;
  }
  function withoutCredential(record) {
    const next = Object.assign({}, record);
    for (const f of RECORD_CREDENTIAL_FIELDS) delete next[f];
    return next;
  }
  // byId[id]: the credential that record now holds (null: none). A record left out is left as it is.
  function withCredentials(secrets, byId) {
    return mapRecords(secrets, (id, record) => {
      if (!byId || byId[id] === undefined) return record;
      const next = withoutCredential(record);
      delete next.credential;
      if (byId[id]) next.credential = byId[id];
      return next;
    });
  }
  /* A move that failed (the channel file could not be written, or read) leaves the bot running on what its record carried, held
     in memory by the store, and that key's only durable copy is still this file: every save puts it back on the record until a
     later boot moves it. A record that has since gone to another provider takes nothing. */
  function withCarried(secrets, carried, normalize) {
    if (!carried || !Object.keys(carried).length) return secrets;
    return mapRecords(secrets, (id, record) => {
      const c = carried[id];
      if (!c || normalize(record.provider) !== c.provider) return record;
      const next = Object.assign({}, record);
      if (c.key) next.key = c.key;
      if (c.baseUrl) next.baseUrl = c.baseUrl;
      return next;
    });
  }
  function withoutProviderCredentials(secrets) { return mapRecords(secrets, (id, record) => withoutCredential(record)); }

  /* Verified channel-secrets persist (the saveJsonVerified law applied to THIS store). Channel bot tokens were the
     one credential class still persisted fire-and-forget: a swallowed write error loses what is by construction the
     token's LAST surviving copy (see the fallback comment in index.js channelToken) while every route keeps saying
     ok:true — the exact EL-5 Telegram-token regression. This factory is pure/injected so the failure scenario is
     unit-testable without fs: the host supplies the durable writer, the resilient loader, and the desktop
     strip policy; the proof predicate demands the read-back byte-equal the intended persisted value.

       makeVerifiedPersist({ saveJsonVerified, save(toPersist), load()->raw, mkdir?(), strip?(obj)->toPersist })
         -> persist(obj) -> { ok, attempts, error }

     ok is true ONLY when the read-back proves the write reached disk; on ok:false the caller keeps the value in
     memory but MUST surface the failure (never a false "saved"). */
  function makeVerifiedPersist(deps) {
    deps = deps || {};
    const sjv = deps.saveJsonVerified;
    if (typeof sjv !== 'function' || typeof deps.save !== 'function' || typeof deps.load !== 'function') {
      throw new Error('makeVerifiedPersist requires saveJsonVerified + save + load');
    }
    return function persist(obj) {
      const toPersist = (typeof deps.strip === 'function') ? deps.strip(obj) : obj;
      let intended = '';
      try { intended = JSON.stringify(toPersist); } catch (e) { return { ok: false, attempts: 0, error: 'unserializable secrets object: ' + ((e && e.message) || e) }; }
      return sjv({
        mkdir: deps.mkdir,
        save: () => deps.save(toPersist),
        load: deps.load,
        proof: (raw) => { try { return JSON.stringify(raw) === intended; } catch (_) { return false; } }
      });
    };
  }

  return { CHANNEL_IDS, TOKEN_FIELDS, STRIP_FIELDS, RECORD_CREDENTIAL_FIELDS, telegramBotSecretId, splitSecret, splitKeyOnly, stripTokens, migratePlaintext, recordAt, credentialReference, credentialRows, withCredentials, withCarried, withoutProviderCredentials, makeVerifiedPersist };
});
