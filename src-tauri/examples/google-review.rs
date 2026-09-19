//! Developer-only Google verification preview. Never part of the installed app.
//! cargo run --example google-review -- <installed-client.json> [port]
#[allow(dead_code)]
#[path = "../src/credentials.rs"]
mod credentials;

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let client_file = args
        .next()
        .ok_or("Supply Google's installed Desktop client JSON path")?;
    let port: u16 = args
        .next()
        .unwrap_or_else(|| "9498".into())
        .parse()
        .map_err(|_| "Invalid preview port")?;
    if port < 1024 {
        return Err("Use an unprivileged preview port".into());
    }
    let client =
        std::fs::read_to_string(client_file).map_err(|_| "Cannot read Desktop registration")?;
    let parsed: serde_json::Value =
        serde_json::from_str(&client).map_err(|_| "Invalid Desktop registration JSON")?;
    if !parsed["installed"].is_object() || !parsed["web"].is_null() {
        return Err(
            "Use an installed Desktop registration, never a confidential Web client".into(),
        );
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Missing repository root")?;
    let key = credentials::connector_encryption_key()?;
    let node = std::env::var_os("STARNET_REVIEW_NODE").unwrap_or_else(|| "node".into());
    eprintln!("Google review preview: http://127.0.0.1:{port}");
    eprintln!("UNVERIFIED developer preview: real Google endpoints; isolated dev/.scratch-workspace; no public activation.");
    eprintln!("Google-derived content outside connector credentials is not encrypted by this candidate. Use dedicated test data.");
    let status = std::process::Command::new(node)
        .current_dir(root)
        // The existing test-only deferral injection changes this process only.
        // Unlike google-signin-preload.cjs, it does NOT replace Google requests.
        .arg("--require")
        .arg(root.join("test/fixtures/google-future-release.cjs"))
        .arg(root.join("dev/seed.js"))
        .arg("--keep")
        .env_remove("NODE_OPTIONS")
        .env("STARNET_CONNECTOR_ENCRYPTION_KEY", key)
        .env("STARNET_DESKTOP_SHELL", "1")
        .env("STARNET_GOOGLE_DESKTOP_CLIENT_JSON", client)
        .env("SKYNET_WORKSPACES", root.join("dev/.scratch-workspace"))
        .env("STARNET_WORKSPACES", root.join("dev/.scratch-workspace"))
        .env("SKYNET_OPENROUTER_KEY", "")
        .env("STARNET_OPENROUTER_KEY", "")
        .env("SKYNET_PORT", port.to_string())
        .env("STARNET_PORT", port.to_string())
        .env("SKYNET_DEFAULT_MODEL", "replay")
        .env("STARNET_DEFAULT_MODEL", "replay")
        // dev/seed spawns index.js; inherit ONLY the explicit deferral preload.
        .env(
            "NODE_OPTIONS",
            format!(
                "--require=\"{}\"",
                root.join("test/fixtures/google-future-release.cjs")
                    .display()
            ),
        )
        .status()
        .map_err(|_| "Unable to launch review sidecar")?;
    if status.success() {
        Ok(())
    } else {
        Err("Review sidecar stopped with an error; inspect its log".into())
    }
}
