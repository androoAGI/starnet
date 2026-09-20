#[allow(dead_code)]
#[path = "../../../src-tauri/src/credentials.rs"]
mod credentials;

#[cfg(target_os = "macos")]
#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
}

fn main() -> Result<(), String> {
    // This harness may mutate only a disposable GitHub-hosted acceptance keychain.
    if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || std::env::var("RUNNER_OS").as_deref() != Ok("macOS")
        || std::env::var("STARNET_DISPOSABLE_KEYCHAIN").as_deref() != Ok("1")
    {
        return Err("Requires the disposable macOS CI keychain".into());
    }
    #[cfg(target_os = "macos")]
    unsafe {
        if SecKeychainSetUserInteractionAllowed(0) != 0 {
            return Err("Could not disable interactive keychain prompts".into());
        }
    }
    let phase = std::env::args().nth(1).ok_or("Missing acceptance phase")?;
    let entry = keyring::Entry::new(credentials::KEYCHAIN_SERVICE, "connectors:encryption:v1")
        .map_err(|_| "Cannot open test entry")?;
    if phase == "unavailable" {
        if credentials::connector_encryption_key().is_ok() {
            return Err("Locked keychain unexpectedly returned a key".into());
        }
        println!("PASS locked keychain fails closed");
        return Ok(());
    }
    if phase == "migrate" && !matches!(entry.get_password(), Err(keyring::Error::NoEntry)) {
        return Err("Acceptance keychain is not empty; refusing to modify it".into());
    }
    let key = credentials::connector_encryption_key()?;
    if phase == "malformed" {
        entry.set_password("INVALID_ACCEPTANCE_KEY").map_err(|_| "Cannot seed invalid key")?;
        let rejected = credentials::connector_encryption_key().is_err();
        let preserved = entry.get_password().map(|v| v == "INVALID_ACCEPTANCE_KEY").unwrap_or(false);
        entry.set_password(&key).map_err(|_| "Cannot restore acceptance key")?;
        if !rejected || !preserved || credentials::connector_encryption_key()? != key {
            return Err("Malformed key was not preserved and recoverable".into());
        }
        println!("PASS malformed key preserved; original key restored");
        return Ok(());
    }
    if phase != "migrate" && phase != "recover" {
        return Err("Unknown acceptance phase".into());
    }
    let status = std::process::Command::new("node")
        .arg("test/native-connector-keychain/vault-check.cjs")
        .arg(&phase)
        .env("STARNET_CONNECTOR_ENCRYPTION_KEY", key)
        .status().map_err(|_| "Cannot run vault acceptance")?;
    if !status.success() { return Err("Vault acceptance failed".into()); }
    Ok(())
}
