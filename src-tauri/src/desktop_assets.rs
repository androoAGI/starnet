//! Share packaged media with the sidecar without changing the Tauri origin,
//! protocol response handling, HTML transformation, or IPC permissions.
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{App, Assets, Wry};

pub(crate) struct DesktopAssets {
    embedded: Box<dyn Assets<Wry>>,
    media: BTreeSet<String>,
    root: OnceLock<PathBuf>,
}

impl DesktopAssets {
    pub(crate) fn new(embedded: Box<dyn Assets<Wry>>) -> Self {
        Self {
            embedded,
            media: serde_json::from_str(include_str!("../frontend-embed/loose-assets.json"))
                .expect("invalid staged media allowlist"),
            root: OnceLock::new(),
        }
    }

    fn read_media(&self, key: &str) -> Option<Vec<u8>> {
        if !self.media.contains(key) {
            return None;
        }
        read_media(self.root.get()?, key)
    }
}

fn read_media(root: &Path, key: &str) -> Option<Vec<u8>> {
    let relative = key.strip_prefix("/assets/")?;
    // Reject Windows alternate streams, drive/UNC paths and traversal on every OS.
    if relative.is_empty()
        || relative.contains(['\\', ':'])
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let candidate = root.join(relative).canonicalize().ok()?;
    if !candidate.starts_with(root) || !candidate.is_file() {
        return None; // also rejects a symlink/junction escaping the media root
    }
    std::fs::read(candidate).ok()
}

impl Assets<Wry> for DesktopAssets {
    fn setup(&self, app: &App<Wry>) {
        self.embedded.setup(app);
        let media = super::project_root(app.handle())
            .join("frontend")
            .join("assets");
        match media.canonicalize() {
            Ok(root) => {
                let _ = self.root.set(root);
            }
            Err(error) => super::log_startup(
                &super::startup_log_path(app.handle()),
                format!("desktop media unavailable: {}: {error}", media.display()),
            ),
        }
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.embedded
            .get(key)
            .or_else(|| self.read_media(key.as_ref()).map(Cow::Owned))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(
            self.embedded
                .iter()
                .chain(self.media.iter().filter_map(|key| {
                    self.read_media(key)
                        .map(|bytes| (Cow::Borrowed(key.as_str()), Cow::Owned(bytes)))
                })),
        )
    }

    fn csp_hashes(&self, path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestEmbedded;
    impl Assets<Wry> for TestEmbedded {
        fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
            (key.as_ref() == "/index.html").then(|| Cow::Borrowed(b"embedded HTML".as_slice()))
        }
        fn iter(&self) -> Box<AssetsIter<'_>> {
            Box::new(std::iter::empty())
        }
        fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
            Box::new(std::iter::once(CspHash::Script("sha256-test")))
        }
    }

    #[test]
    fn media_reads_are_confined_to_the_resource_directory() {
        let temp = std::env::temp_dir().join(format!("starnet-media-{}", uuid::Uuid::new_v4()));
        let root = temp.join("assets");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/texture.png"), b"texture").unwrap();
        std::fs::write(temp.join("secret"), b"outside").unwrap();
        let root = root.canonicalize().unwrap();
        let assets = DesktopAssets {
            embedded: Box::new(TestEmbedded),
            media: BTreeSet::from(["/assets/nested/texture.png".into()]),
            root: OnceLock::from(root.clone()),
        };
        assert_eq!(
            assets.get(&AssetKey::from("index.html")).unwrap().as_ref(),
            b"embedded HTML"
        );
        assert_eq!(
            assets
                .get(&AssetKey::from("assets/nested/texture.png"))
                .unwrap()
                .as_ref(),
            b"texture"
        );
        std::fs::write(root.join("unlisted.png"), b"not in the build").unwrap();
        assert!(assets.get(&AssetKey::from("assets/unlisted.png")).is_none());
        assert_eq!(
            assets
                .csp_hashes(&AssetKey::from("index.html"))
                .next()
                .unwrap()
                .hash(),
            "sha256-test"
        );
        assert_eq!(
            read_media(&root, "/assets/nested/texture.png"),
            Some(b"texture".to_vec())
        );
        for path in [
            "/assets/../secret",
            "/assets/nested/../../secret",
            "/assets/",
            "/assets/nested",
            "/assets/missing.png",
            "/assets/C:/secret",
            "/assets/nested\\texture.png",
            "/assets/nested/texture.png:stream",
            "/sidecar/index.js",
            "/assets//secret",
        ] {
            assert!(read_media(&root, path).is_none(), "{path}");
        }
        std::fs::remove_dir_all(temp).unwrap();
    }
}
