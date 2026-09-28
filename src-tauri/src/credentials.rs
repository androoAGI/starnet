//! Native credential storage and one-time channel-token migration.
//!
//! The WebView-facing Tauri commands live in `main.rs`; this module owns the OS
//! keychain namespace, provider/channel normalization, secret reads, and the
//! crash-safe migration of legacy plaintext channel tokens.

use std::collections::BTreeMap;
use std::path::Path;

pub(crate) const KEYCHAIN_SERVICE: &str = "ai.skynet.harness";
pub(crate) const KEYCHAIN_ACCOUNT: &str = "openrouter";

/// Stable envelope-encryption key. Never replace an existing malformed/unreadable
/// value: doing so would permanently strand the encrypted connector state.
pub(crate) fn connector_encryption_key() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, "connectors:encryption:v1")
        .map_err(|_| "Connector credential store is unavailable".to_string())?;
    match entry.get_password() {
        Ok(value) => {
            if valid_connector_key(&value) {
                Ok(value)
            } else {
                Err("Connector encryption key is invalid; original key was preserved".into())
            }
        }
        Err(keyring::Error::NoEntry) => {
            // The first eight hex digits of each v4 UUID are 32 unmasked OS-CSPRNG
            // bits. Eight independent UUIDs supply exactly 256 random key bits.
            let value: String = (0..8)
                .map(|_| uuid::Uuid::new_v4().simple().to_string()[..8].to_string())
                .collect();
            entry
                .set_password(&value)
                .map_err(|_| "Connector encryption key could not be saved".to_string())?;
            let saved = entry
                .get_password()
                .map_err(|_| "Connector encryption key could not be verified".to_string())?;
            if saved == value {
                Ok(saved)
            } else {
                Err("Connector encryption key read-back failed".into())
            }
        }
        Err(_) => Err("Connector credential store is locked or unavailable".into()),
    }
}

fn valid_connector_key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
pub(crate) const KEYCHAIN_PROVIDERS: [&str; 13] = [
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "groq",
    "mistral",
    "deepseek",
    "together",
    "fireworks",
    "perplexity",
    "cerebras",
    "custom",
];

// Channel bot tokens live under account "channel:<id>" and inject into the sidecar env.
// (id, env_name) drives spawn injection, the one-time plaintext migration, and the store/has commands.
// EVERY channel credential the sidecar persists lives here: Slack's value is the combined "xoxb-… xapp-…"
// pair (one opaque secret, split by prefix in slack.js), Matrix's is the access token. Signal has NO secret
// (signal-cli endpoint + registered number are non-secret config), so it has no row. The sidecar reads
// these names in index.js CHANNEL_TOKEN_ENV — keep the two tables in step.
pub(crate) const SIDECAR_CHANNEL_TOKEN_ENVS: [(&str, &str); 4] = [
    ("telegram", "SKYNET_TELEGRAM_TOKEN"),
    ("discord", "SKYNET_DISCORD_TOKEN"),
    ("slack", "SKYNET_SLACK_TOKEN"),
    ("matrix", "SKYNET_MATRIX_TOKEN"),
];

pub(crate) const SIDECAR_PROVIDER_KEY_ENVS: [(&str, &str); 12] = [
    ("openai", "SKYNET_OPENAI_API_KEY"),
    ("anthropic", "SKYNET_ANTHROPIC_API_KEY"),
    ("gemini", "SKYNET_GEMINI_API_KEY"),
    ("xai", "SKYNET_XAI_API_KEY"),
    ("groq", "SKYNET_GROQ_API_KEY"),
    ("mistral", "SKYNET_MISTRAL_API_KEY"),
    ("deepseek", "SKYNET_DEEPSEEK_API_KEY"),
    ("together", "SKYNET_TOGETHER_API_KEY"),
    ("fireworks", "SKYNET_FIREWORKS_API_KEY"),
    ("perplexity", "SKYNET_PERPLEXITY_API_KEY"),
    ("cerebras", "SKYNET_CEREBRAS_API_KEY"),
    ("custom", "SKYNET_CUSTOM_OPENAI_KEY"),
];

pub(crate) fn normalize_provider(provider: &str) -> &'static str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" | "openai-codex" => "codex",
        "openai" | "openai-api" => "openai",
        "anthropic" | "claude" => "anthropic",
        "gemini" | "google" | "google-ai" | "google-gemini" => "gemini",
        "grok" | "grok-oauth" | "xai-oauth" => "grok",
        "kimi" | "moonshot" | "kimi-code" | "kimi-oauth" => "kimi",
        "xai" | "x-ai" => "xai",
        "groq" => "groq",
        "mistral" | "mistralai" => "mistral",
        "deepseek" => "deepseek",
        "together" | "together-ai" => "together",
        "fireworks" | "fireworks-ai" => "fireworks",
        "perplexity" | "pplx" | "sonar" => "perplexity",
        "cerebras" => "cerebras",
        "ollama" | "ollama-local" => "ollama",
        "claude-cli" | "claude-code" | "claude-code-cli" => "claude-cli",
        "custom" | "openai-compatible" | "local" | "vllm" | "lmstudio" => "custom",
        _ => "openrouter",
    }
}

pub(crate) fn keychain_account_for(provider: &str) -> String {
    match normalize_provider(provider) {
        // Preserve the original account name so existing OpenRouter keys keep working.
        "openrouter" => KEYCHAIN_ACCOUNT.to_string(),
        id => format!("provider:{id}"),
    }
}

pub(crate) fn keychain_entry() -> keyring::Result<keyring::Entry> {
    keychain_entry_for("openrouter")
}

pub(crate) fn keychain_entry_for(provider: &str) -> keyring::Result<keyring::Entry> {
    let account = keychain_account_for(provider);
    keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
}

pub(crate) fn keychain_pool_entry_for(provider: &str) -> keyring::Result<keyring::Entry> {
    let account = format!("{}:pool", keychain_account_for(provider));
    keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
}

/// The stored OpenRouter BYOK key, or `None` if unset/empty.
pub(crate) fn read_key() -> Option<String> {
    read_key_for("openrouter")
}

pub(crate) fn read_key_for(provider: &str) -> Option<String> {
    keychain_entry_for(provider)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|key| !key.trim().is_empty())
}

pub(crate) fn read_key_pool_for(provider: &str) -> Vec<String> {
    keychain_pool_entry_for(provider)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .take(8)
        .collect()
}

/// Only channels the native shell injects may occupy the `channel:<id>` namespace.
pub(crate) fn is_known_channel(channel: &str) -> bool {
    SIDECAR_CHANNEL_TOKEN_ENVS
        .iter()
        .any(|(id, _)| *id == channel)
        || channel.strip_prefix("telegram:").is_some_and(|id| {
            !id.is_empty() && id.len() <= 20 && id.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn channel_keychain_account(channel: &str) -> String {
    format!("channel:{channel}")
}

pub(crate) fn channel_keychain_entry(channel: &str) -> keyring::Result<keyring::Entry> {
    let account = channel_keychain_account(channel);
    keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
}

/// Delete a keychain credential, treating "nothing stored" as success. A real deletion
/// failure surfaces so callers cannot claim a credential was purged while it still exists.
pub(crate) fn delete_credential_honest(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn restore_credential(
    entry: &keyring::Entry,
    previous: Option<&str>,
) -> Result<(), String> {
    match previous {
        Some(value) => entry.set_password(value).map_err(|error| error.to_string()),
        None => delete_credential_honest(entry),
    }
}

pub(crate) fn rollback_error(primary: String, failures: Vec<String>) -> String {
    if failures.is_empty() {
        primary
    } else {
        format!("{primary}; rollback incomplete: {}", failures.join("; "))
    }
}

/// The stored bot token for a channel, or `None` if unset/empty.
pub(crate) fn read_channel_token(channel: &str) -> Option<String> {
    channel_keychain_entry(channel)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|token| !token.trim().is_empty())
}

/// Keychain-backed tokens for saved agent-bound Telegram bots, keyed by their stable numeric Bot API id.
/// The returned map is injected as one JSON environment value when the sidecar starts.
pub(crate) fn read_telegram_bot_tokens(workspaces: &Path) -> BTreeMap<String, String> {
    let file = workspaces.join("channels").join("secrets.json");
    let json: serde_json::Value = match std::fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
    {
        Some(json) => json,
        None => return BTreeMap::new(),
    };
    json.get("telegramBots")
        .and_then(|value| value.as_object())
        .into_iter()
        .flat_map(|bots| bots.keys())
        .filter(|bot_id| is_known_channel(&format!("telegram:{bot_id}")))
        .take(200)
        .filter_map(|bot_id| {
            read_channel_token(&format!("telegram:{bot_id}"))
                .map(|token| (bot_id.to_string(), token))
        })
        .collect()
}

// ---- StarNet Cloud device token (keychain account "credits:device") ----
//
// The device token is a BEARER CREDENTIAL THAT SPENDS MONEY: anyone holding it can bill the
// linked account until the balance runs out. It is minted by the sidecar (which polls the cloud),
// so unlike a BYOK key it never passes through the UI — and it must not stay in plaintext either.
//
// Same posture as channel bot tokens: keychain -> env -> sidecar runtime layer. The sidecar writes
// the link record to `.secrets/credits.json`; we adopt the secret half into the keychain and strip
// it from the file, leaving the non-secret fields (url, accountId, linkedAt) exactly where they were.

pub(crate) fn credits_keychain_entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, "credits:device")
}

/// The stored StarNet Cloud device token, or `None` if unset/empty.
pub(crate) fn read_credits_token() -> Option<String> {
    credits_keychain_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|token| !token.trim().is_empty())
}

/// Adopt the device token out of `.secrets/credits.json` into the OS keychain, then rewrite the
/// file without it. Returns whether a token now lives in the keychain (adopted just now or already
/// there), so callers report the truth rather than assume success.
///
/// Runs at every launch (migrating already-linked stations) AND on demand right after a link, so a
/// freshly minted token spends seconds on disk instead of until the next restart. Idempotent.
pub(crate) fn migrate_credits_token_from_plaintext(workspaces: &Path) -> bool {
    let file = workspaces.join(".secrets").join("credits.json");
    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(_) => return read_credits_token().is_some(), // no file -> keychain may still hold it
    };
    let mut json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(json) => json,
        Err(_) => return read_credits_token().is_some(), // corrupt -> leave it for the sidecar's loader
    };
    let token = json
        .get("deviceToken")
        .and_then(|token| token.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);

    let Some(token) = token else {
        return read_credits_token().is_some(); // already stripped on a previous run
    };

    if read_credits_token().as_deref() != Some(token.as_str()) {
        if let Ok(entry) = credits_keychain_entry() {
            let _ = entry.set_password(&token);
        }
    }

    // INVARIANT (Andrew): never remove the last copy of a secret without PROOF a durable home holds
    // it. Strip the plaintext token only once a READ-BACK confirms the keychain really has this
    // exact value. If the store failed (locked keychain, no backend, permissions), leave the token
    // on disk — a token in a file beats a token nobody has. The next launch retries (self-healing).
    let keychain_has_it = read_credits_token()
        .map(|held| held == token)
        .unwrap_or(false);
    if keychain_has_it {
        if let Some(object) = json.as_object_mut() {
            object.remove("deviceToken");
        }
        if let Ok(serialized) = serde_json::to_string(&json) {
            let _ = atomic_write(&file, serialized.as_bytes());
        }
    }
    keychain_has_it
}

/// The credential-store seam the channel-token migration writes through. Production uses the OS
/// keychain (`KeyringChannelStore`); tests inject a store whose writes fail or read back wrong, which
/// is the only way to prove the "never destroy the last copy" path without touching a real keychain.
pub(crate) trait ChannelSecretStore {
    /// The stored token for a channel id (`telegram`, `slack`, `telegram:<bot id>`, …), `None` if unset/empty.
    fn read(&self, channel: &str) -> Option<String>;
    /// Write a token. A failure is reported, never assumed away.
    fn write(&self, channel: &str, token: &str) -> Result<(), String>;
}

/// The OS keychain (`ai.skynet.harness` / `channel:<id>`).
pub(crate) struct KeyringChannelStore;

impl ChannelSecretStore for KeyringChannelStore {
    fn read(&self, channel: &str) -> Option<String> {
        read_channel_token(channel)
    }
    fn write(&self, channel: &str, token: &str) -> Result<(), String> {
        channel_keychain_entry(channel)
            .map_err(|error| error.to_string())?
            .set_password(token)
            .map_err(|error| error.to_string())
    }
}

/// Import plaintext channel bot tokens from legacy `secrets.json` into the OS keychain.
/// A plaintext token is removed only after read-back proves the exact value arrived.
pub(crate) fn migrate_channel_tokens_from_plaintext(workspaces: &Path) {
    migrate_channel_tokens_with(&KeyringChannelStore, workspaces);
}

/// Store-injected core of the migration. For every keychained channel (Telegram, Discord, Slack,
/// Matrix, plus agent-bound Telegram bots): write the plaintext token into the store when the store
/// holds nothing, READ IT BACK, and strip the plaintext copy only on an exact match. A failed write, a
/// locked store, or a mismatched read-back leaves the file untouched and the channel working from its
/// plaintext copy; the next launch retries. Never destroys the last copy of a secret.
pub(crate) fn migrate_channel_tokens_with(store: &dyn ChannelSecretStore, workspaces: &Path) {
    let file = workspaces.join("channels").join("secrets.json");
    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(_) => return,
    };
    let mut json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(json) => json,
        Err(_) => return,
    };

    let mut changed = false;
    for (channel, _) in SIDECAR_CHANNEL_TOKEN_ENVS {
        let token = json
            .get(channel)
            .and_then(|record| record.get("token"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        if let Some(token) = token {
            if store.read(channel).is_none() {
                let _ = store.write(channel, &token); // outcome is judged by the read-back below
            }

            // Never destroy the last copy: verify the exact destination value first.
            let keychain_has_it = store
                .read(channel)
                .map(|stored| stored == token)
                .unwrap_or(false);
            if keychain_has_it {
                if let Some(record) = json
                    .get_mut(channel)
                    .and_then(|value| value.as_object_mut())
                {
                    record.remove("token");
                    changed = true;
                }
            }
        }
    }

    // Agent-bound Telegram bots use dynamic channel ids (`telegram:<numeric bot id>`). Import each nested token
    // independently and remove it only after exact keychain read-back, preserving the same last-copy invariant.
    let nested_tokens: Vec<(String, String)> = json
        .get("telegramBots")
        .and_then(|value| value.as_object())
        .into_iter()
        .flat_map(|bots| bots.iter())
        .filter_map(|(bot_id, record)| {
            let channel = format!("telegram:{bot_id}");
            if !is_known_channel(&channel) {
                return None;
            }
            record
                .get("token")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|token| (bot_id.clone(), token.to_string()))
        })
        .take(200)
        .collect();
    for (bot_id, token) in nested_tokens {
        let channel = format!("telegram:{bot_id}");
        if store.read(&channel).is_none() {
            let _ = store.write(&channel, &token); // outcome is judged by the read-back below
        }
        let keychain_has_it = store
            .read(&channel)
            .map(|stored| stored == token)
            .unwrap_or(false);
        if keychain_has_it {
            if let Some(record) = json
                .get_mut("telegramBots")
                .and_then(|value| value.get_mut(&bot_id))
                .and_then(|value| value.as_object_mut())
            {
                record.remove("token");
                changed = true;
            }
        }
    }

    if changed {
        if let Ok(serialized) = serde_json::to_string(&json) {
            let _ = atomic_write(&file, serialized.as_bytes());
        }
    }
}

/// Write bytes through a sibling temp file, flush, then rename over the target.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("secrets.json"),
        std::process::id()
    ));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        let _ = file.sync_all();
    }

    #[cfg(windows)]
    {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_key_requires_exact_256_bit_encoding() {
        assert!(valid_connector_key(&"a1".repeat(32)));
        assert!(!valid_connector_key(&"a1".repeat(31)));
        assert!(!valid_connector_key(&"a1".repeat(33)));
        assert!(!valid_connector_key(&"zz".repeat(32)));
        assert!(!valid_connector_key(&format!("{}\n", "a1".repeat(32))));
    }

    #[test]
    #[ignore = "Requires an unlocked native OS credential store; creates the persistent StarNet connector key if absent"]
    fn connector_keychain_roundtrip() {
        let first = connector_encryption_key().expect("native connector key available");
        let second = connector_encryption_key().expect("native connector key readable again");
        assert!(valid_connector_key(&first));
        assert!(first == second, "native key must persist unchanged");
    }

    #[test]
    fn provider_aliases_normalize_to_runtime_ids() {
        let cases = [
            (" OpenAI-API ", "openai"),
            ("claude", "anthropic"),
            ("google-gemini", "gemini"),
            ("grok-oauth", "grok"),
            ("x-ai", "xai"),
            ("moonshot", "kimi"),
            ("pplx", "perplexity"),
            ("ollama-local", "ollama"),
            ("claude-code", "claude-cli"),
            ("lmstudio", "custom"),
            ("unknown-provider", "openrouter"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_provider(input), expected, "alias {input}");
        }
    }

    #[test]
    fn keychain_accounts_preserve_legacy_openrouter_slot() {
        assert_eq!(keychain_account_for("openrouter"), "openrouter");
        assert_eq!(keychain_account_for("unknown"), "openrouter");
        assert_eq!(keychain_account_for("openai-api"), "provider:openai");
        assert_eq!(keychain_account_for("claude"), "provider:anthropic");
    }

    #[test]
    fn channel_namespace_is_closed_and_env_mapping_is_stable() {
        assert!(is_known_channel("telegram"));
        assert!(is_known_channel("discord"));
        assert!(is_known_channel("slack"));
        assert!(is_known_channel("matrix"));
        assert!(is_known_channel("telegram:123456789"));
        assert!(!is_known_channel("Telegram"));
        assert!(!is_known_channel("signal")); // signal has no secret to keychain
        assert!(!is_known_channel("slack:1"));
        assert!(!is_known_channel("telegram:"));
        assert!(!is_known_channel("telegram:12/34"));
        assert!(!is_known_channel("telegram:123456789012345678901"));
        assert_eq!(channel_keychain_account("telegram"), "channel:telegram");
        assert_eq!(
            channel_keychain_account("telegram:123"),
            "channel:telegram:123"
        );
        assert_eq!(
            SIDECAR_CHANNEL_TOKEN_ENVS,
            [
                ("telegram", "SKYNET_TELEGRAM_TOKEN"),
                ("discord", "SKYNET_DISCORD_TOKEN"),
                ("slack", "SKYNET_SLACK_TOKEN"),
                ("matrix", "SKYNET_MATRIX_TOKEN"),
            ]
        );
    }

    // ---- plaintext -> keychain migration, driven through an injected store (never the real keychain) ----

    use std::cell::RefCell;
    use std::collections::BTreeSet;

    /// In-memory store. `fail` channels reject every write; `garble` channels accept the write but
    /// read back a different value (a store that lies about what it holds).
    #[derive(Default)]
    struct FakeStore {
        held: RefCell<BTreeMap<String, String>>,
        fail: BTreeSet<String>,
        garble: BTreeSet<String>,
        writes: RefCell<Vec<String>>,
    }

    impl FakeStore {
        fn failing(channels: &[&str]) -> Self {
            FakeStore {
                fail: channels.iter().map(|c| c.to_string()).collect(),
                ..Default::default()
            }
        }
    }

    impl ChannelSecretStore for FakeStore {
        fn read(&self, channel: &str) -> Option<String> {
            self.held.borrow().get(channel).cloned()
        }
        fn write(&self, channel: &str, token: &str) -> Result<(), String> {
            self.writes.borrow_mut().push(channel.to_string());
            if self.fail.contains(channel) {
                return Err("keychain locked".into());
            }
            let value = if self.garble.contains(channel) {
                format!("{token}-truncated")
            } else {
                token.to_string()
            };
            self.held.borrow_mut().insert(channel.to_string(), value);
            Ok(())
        }
    }

    struct TempWorkspace(std::path::PathBuf);
    impl TempWorkspace {
        fn new(name: &str, secrets: &serde_json::Value) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "starnet-channel-migrate-{}-{name}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("channels")).unwrap();
            std::fs::write(
                dir.join("channels").join("secrets.json"),
                serde_json::to_string(secrets).unwrap(),
            )
            .unwrap();
            TempWorkspace(dir)
        }
        fn raw(&self) -> String {
            std::fs::read_to_string(self.0.join("channels").join("secrets.json")).unwrap()
        }
        fn json(&self) -> serde_json::Value {
            serde_json::from_str(&self.raw()).unwrap()
        }
    }
    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn every_channel_secrets() -> serde_json::Value {
        serde_json::json!({
            "telegram": { "token": "TG:1", "model": "m", "ownerId": "7" },
            "discord": { "token": "DC.2", "model": "m" },
            "slack": { "token": "xoxb-3 xapp-3", "model": "m", "enabled": true },
            "matrix": { "token": "syt_4", "endpoint": "https://matrix.example", "model": "m" },
            "signal": { "endpoint": "http://127.0.0.1:8080", "account": "+15550001111", "model": "m" },
            "telegramBots": { "555": { "token": "BOT:5", "username": "NovaBot" } },
            "notifyAutonomous": true
        })
    }

    #[test]
    fn migration_moves_every_channel_credential_after_exact_read_back() {
        let ws = TempWorkspace::new("all-ok", &every_channel_secrets());
        let store = FakeStore::default();
        migrate_channel_tokens_with(&store, &ws.0);

        for (channel, token) in [
            ("telegram", "TG:1"),
            ("discord", "DC.2"),
            ("slack", "xoxb-3 xapp-3"),
            ("matrix", "syt_4"),
            ("telegram:555", "BOT:5"),
        ] {
            assert_eq!(
                store.read(channel).as_deref(),
                Some(token),
                "{channel} adopted"
            );
        }
        assert!(
            store.read("signal").is_none(),
            "signal has no secret to adopt"
        );

        let after = ws.json();
        for channel in ["telegram", "discord", "slack", "matrix"] {
            assert!(
                after[channel].get("token").is_none(),
                "{channel} plaintext stripped"
            );
        }
        assert!(after["telegramBots"]["555"].get("token").is_none());
        // non-secret config survives exactly
        assert_eq!(after["matrix"]["endpoint"], "https://matrix.example");
        assert_eq!(after["slack"]["enabled"], true);
        assert_eq!(after["telegram"]["ownerId"], "7");
        assert_eq!(after["signal"], every_channel_secrets()["signal"]);
        assert_eq!(after["notifyAutonomous"], true);
    }

    #[test]
    fn failed_keychain_writes_leave_the_plaintext_file_byte_identical() {
        let ws = TempWorkspace::new("all-fail", &every_channel_secrets());
        let before = ws.raw();
        let store = FakeStore::failing(&["telegram", "discord", "slack", "matrix", "telegram:555"]);
        migrate_channel_tokens_with(&store, &ws.0);
        assert_eq!(
            store.writes.borrow().len(),
            5,
            "every channel was attempted"
        );
        assert_eq!(
            ws.raw(),
            before,
            "no write proved -> the file is never rewritten"
        );
    }

    #[test]
    fn one_failed_write_keeps_only_that_channels_plaintext_copy() {
        let ws = TempWorkspace::new("slack-fail", &every_channel_secrets());
        let store = FakeStore::failing(&["slack"]);
        migrate_channel_tokens_with(&store, &ws.0);
        let after = ws.json();
        assert_eq!(
            after["slack"]["token"], "xoxb-3 xapp-3",
            "the last copy of the Slack pair survives"
        );
        assert!(store.read("slack").is_none());
        assert!(
            after["matrix"].get("token").is_none(),
            "matrix still migrates"
        );
        assert_eq!(store.read("matrix").as_deref(), Some("syt_4"));
    }

    #[test]
    fn a_store_that_reads_back_a_different_value_never_earns_the_strip() {
        let ws = TempWorkspace::new("garble", &every_channel_secrets());
        let mut store = FakeStore::default();
        store.garble.insert("matrix".into());
        migrate_channel_tokens_with(&store, &ws.0);
        let after = ws.json();
        assert_eq!(
            after["matrix"]["token"], "syt_4",
            "mismatched read-back keeps the plaintext"
        );
        assert!(after["slack"].get("token").is_none());
    }

    #[test]
    fn an_existing_keychain_value_is_never_overwritten_by_the_file() {
        let ws = TempWorkspace::new("held", &every_channel_secrets());
        let store = FakeStore::default();
        store
            .held
            .borrow_mut()
            .insert("slack".into(), "xoxb-3 xapp-3".into());
        store
            .held
            .borrow_mut()
            .insert("matrix".into(), "syt_OTHER".into());
        migrate_channel_tokens_with(&store, &ws.0);
        assert!(
            !store
                .writes
                .borrow()
                .iter()
                .any(|c| c == "slack" || c == "matrix"),
            "a held value is never rewritten"
        );
        let after = ws.json();
        assert!(
            after["slack"].get("token").is_none(),
            "same value already held -> strip"
        );
        assert_eq!(
            after["matrix"]["token"], "syt_4",
            "different value held -> plaintext kept"
        );
        assert_eq!(store.read("matrix").as_deref(), Some("syt_OTHER"));
    }

    #[test]
    fn unreadable_secrets_file_is_left_alone() {
        let ws = TempWorkspace::new("corrupt", &serde_json::json!({}));
        let file = ws.0.join("channels").join("secrets.json");
        std::fs::write(&file, b"{\"slack\":{\"token\":\"xoxb").unwrap();
        let store = FakeStore::default();
        migrate_channel_tokens_with(&store, &ws.0);
        assert!(store.writes.borrow().is_empty());
        assert_eq!(ws.raw(), "{\"slack\":{\"token\":\"xoxb");
    }

    #[test]
    fn rollback_errors_never_hide_incomplete_restoration() {
        assert_eq!(
            rollback_error("push failed".to_string(), Vec::new()),
            "push failed"
        );
        assert_eq!(
            rollback_error(
                "push failed".to_string(),
                vec!["keychain restore failed".to_string()],
            ),
            "push failed; rollback incomplete: keychain restore failed"
        );
    }
}
