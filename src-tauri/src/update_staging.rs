//! Where the macOS updater stages the new StarNet.app.
//!
//! Customer report (email 2026-11-07, macOS, desktop 0.14.2): the in-app update "failed with a 'cross device link'
//! error", which leaves a Mac on the old version.
//!
//! WHY. tauri-plugin-updater 2.10.1 (src/updater.rs, the macOS `install_inner`) unpacks the new bundle into a
//! `tempfile::Builder::tempdir()` (tempfile's default temp dir: $TMPDIR, /private/var/folders/../T) and then
//! `std::fs::rename`s the running StarNet.app into a second temp dir as its backup, before renaming the new bundle into
//! place. rename(2) cannot cross a volume. When StarNet.app sits on another volume than $TMPDIR (an external or second
//! APFS volume, a mounted disk image, or the read-only mount macOS App Translocation runs a quarantined app from when it
//! was opened from Downloads or the disk image without being moved), that first rename fails with EXDEV,
//! "Cross-device link (os error 18)". The plugin only falls back (to an admin `mv`) on PermissionDenied, so the install
//! ends there. Nothing has moved at that point: the running app is intact and the plugin deletes its unpacked copy.
//!
//! THE FIX, decided here and applied by main.rs before anything is downloaded: when the bundle and $TMPDIR are on
//! different volumes, tempfile's process-wide default temp dir (tempfile::env::override_temp_dir, the same tempfile 3.x
//! the plugin links) is pointed at a hidden folder beside the bundle, so both of the plugin's renames stay on one
//! volume. A translocated copy cannot be updated in place at all (its mount is read-only and goes away on quit), and
//! neither can a bundle on a read-only volume: those are refused up front, in words that say what to do.
//!
//! std only and nothing from main.rs, so the tests compile alone:
//!   rustc --edition 2021 --test src-tauri/src/update_staging.rs -o <dir>/update_staging_tests && <dir>/update_staging_tests

use std::io;
use std::path::{Path, PathBuf};

/// The hidden folder beside StarNet.app that holds the plugin's two temp dirs when $TMPDIR is on another volume. It is
/// empty again once the install returns (the plugin's temp dirs remove themselves) and main.rs removes it then.
pub const STAGING_DIR_NAME: &str = ".starnet-update-staging";

/// EROFS on macOS and Linux. io::ErrorKind::ReadOnlyFilesystem is newer than the crate's rust-version.
const EROFS: i32 = 30;

#[derive(Debug, PartialEq, Eq)]
pub enum Staging {
    /// $TMPDIR shares the bundle's volume (the usual /Applications install), or that cannot be told: the plugin's own
    /// staging, unchanged.
    Default,
    /// Stage the plugin's temp dirs in this folder beside the bundle (made already).
    Beside(PathBuf),
}

/// The .app bundle the updater replaces. The plugin takes exe/../.. when the exe sits in Contents/MacOS (updater.rs
/// `extract_path_from_executable`); this returns that same bundle, or None when the exe is not inside one (a dev run).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    if bundle.as_os_str().is_empty() {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// macOS App Translocation runs a quarantined app that was opened where it was downloaded (or straight from the disk
/// image) from a randomised read-only mount: /private/var/folders/../AppTranslocation/<uuid>/d/StarNet.app.
pub fn is_translocated(bundle: &Path) -> bool {
    bundle.components().any(|c| c.as_os_str() == "AppTranslocation")
}

pub fn translocated_refusal() -> String {
    "StarNet can't update itself from where it is running: macOS opened it from a temporary read-only copy, because it \
     was started from the disk image or the Downloads folder. Nothing was downloaded or changed. Quit StarNet, drag it \
     into your Applications folder, open it from there, and install the update again."
        .to_string()
}

pub fn read_only_refusal(folder: &Path) -> String {
    format!(
        "StarNet can't update itself in {}: that disk is read-only. Nothing was downloaded or changed. Quit StarNet, \
         drag it into your Applications folder, open it from there, and install the update again.",
        folder.display()
    )
}

/// Whether two existing paths are on the same volume (st_dev).
#[cfg(unix)]
pub fn same_volume(a: &Path, b: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(std::fs::metadata(a)?.dev() == std::fs::metadata(b)?.dev())
}

/// Only the macOS install uses staging; elsewhere every pair counts as one volume, so nothing changes.
#[cfg(not(unix))]
pub fn same_volume(_a: &Path, _b: &Path) -> io::Result<bool> {
    Ok(true)
}

/// Decide where the plugin stages the new bundle. `same_volume(a, b)` says whether two existing paths share a volume;
/// `make_dir` creates the staging folder. An Err is a sentence for the person: nothing has been downloaded or changed.
pub fn plan(
    bundle: &Path,
    temp_dir: &Path,
    same_volume: &dyn Fn(&Path, &Path) -> io::Result<bool>,
    make_dir: &dyn Fn(&Path) -> io::Result<()>,
) -> Result<Staging, String> {
    if is_translocated(bundle) {
        return Err(translocated_refusal());
    }
    match same_volume(bundle, temp_dir) {
        Ok(true) => return Ok(Staging::Default),
        Ok(false) => {}
        // cannot tell: keep the plugin's own staging, exactly as before
        Err(_) => return Ok(Staging::Default),
    }
    let parent = match bundle.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => return Ok(Staging::Default),
    };
    let dir = parent.join(STAGING_DIR_NAME);
    match make_dir(&dir) {
        Ok(()) => Ok(Staging::Beside(dir)),
        Err(e) if e.raw_os_error() == Some(EROFS) => Err(read_only_refusal(parent)),
        // e.g. a folder only an administrator may write: the plugin's own path (it asks for the password on
        // PermissionDenied) stays as it was
        Err(_) => Ok(Staging::Default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn vol_of(p: &Path) -> &'static str {
        let s = p.to_string_lossy().replace('\\', "/");
        if s.starts_with("/Volumes/External") {
            "external"
        } else {
            "data"
        }
    }

    fn by_prefix(a: &Path, b: &Path) -> io::Result<bool> {
        Ok(vol_of(a) == vol_of(b))
    }

    const TMP: &str = "/private/var/folders/ab/cd/T";

    #[test]
    fn bundle_is_the_app_around_contents_macos() {
        assert_eq!(
            bundle_of(Path::new("/Applications/StarNet.app/Contents/MacOS/StarNet")),
            Some(PathBuf::from("/Applications/StarNet.app"))
        );
        assert_eq!(
            bundle_of(Path::new("/Volumes/External/Apps/StarNet.app/Contents/MacOS/StarNet")),
            Some(PathBuf::from("/Volumes/External/Apps/StarNet.app"))
        );
        // a dev run (target/debug/skynet-desktop) has no bundle to replace
        assert_eq!(bundle_of(Path::new("/Users/me/gen/src-tauri/target/debug/skynet-desktop")), None);
        assert_eq!(bundle_of(Path::new("StarNet")), None);
    }

    #[test]
    fn same_volume_as_tmpdir_keeps_the_plugin_staging() {
        let made = RefCell::new(Vec::<PathBuf>::new());
        let mk = |p: &Path| {
            made.borrow_mut().push(p.to_path_buf());
            Ok(())
        };
        let got = plan(Path::new("/Applications/StarNet.app"), Path::new(TMP), &by_prefix, &mk);
        assert_eq!(got, Ok(Staging::Default));
        assert!(made.borrow().is_empty(), "nothing is created for the usual install");
    }

    #[test]
    fn another_volume_stages_beside_the_bundle() {
        // the customer's shape: the app on one volume, $TMPDIR on another; the plugin's backup rename was EXDEV
        let made = RefCell::new(Vec::<PathBuf>::new());
        let mk = |p: &Path| {
            made.borrow_mut().push(p.to_path_buf());
            Ok(())
        };
        let bundle = Path::new("/Volumes/External/Applications/StarNet.app");
        let got = plan(bundle, Path::new(TMP), &by_prefix, &mk);
        let want = PathBuf::from("/Volumes/External/Applications").join(STAGING_DIR_NAME);
        assert_eq!(got, Ok(Staging::Beside(want.clone())));
        assert_eq!(*made.borrow(), vec![want.clone()]);
        // and the staging folder is on the bundle's volume, so both of the plugin's renames are same-volume
        assert_eq!(by_prefix(bundle, &want).unwrap(), true);
    }

    #[test]
    fn a_translocated_copy_is_refused_before_any_download() {
        let mk = |_: &Path| -> io::Result<()> { panic!("nothing is created for a translocated copy") };
        let bundle = Path::new("/private/var/folders/ab/cd/T/AppTranslocation/1F2E-UUID/d/StarNet.app");
        // refused whatever the volume answer is: the copy is read-only and goes away on quit
        let same = |_: &Path, _: &Path| -> io::Result<bool> { Ok(true) };
        let got = plan(bundle, Path::new(TMP), &same, &mk);
        let msg = got.expect_err("a translocated copy cannot be updated in place");
        assert!(msg.contains("Applications folder"), "says what to do: {msg}");
        assert!(msg.contains("Nothing was downloaded or changed"), "says nothing changed: {msg}");
        assert!(!is_translocated(Path::new("/Applications/StarNet.app")));
    }

    #[test]
    fn a_read_only_volume_is_refused_with_its_folder() {
        let mk = |_: &Path| -> io::Result<()> { Err(io::Error::from_raw_os_error(EROFS)) };
        let got = plan(Path::new("/Volumes/External/StarNet.app"), Path::new(TMP), &by_prefix, &mk);
        let msg = got.expect_err("a read-only disk cannot take the new bundle");
        assert!(msg.contains("/Volumes/External"), "names the folder: {msg}");
        assert!(msg.contains("read-only"), "{msg}");
    }

    #[test]
    fn an_unwritable_folder_keeps_the_plugin_admin_path() {
        // PermissionDenied: the plugin's own fallback asks for the administrator password; we do not stand in its way
        let mk = |_: &Path| -> io::Result<()> { Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied")) };
        let got = plan(Path::new("/Volumes/External/Applications/StarNet.app"), Path::new(TMP), &by_prefix, &mk);
        assert_eq!(got, Ok(Staging::Default));
    }

    #[test]
    fn an_unknown_volume_keeps_the_plugin_staging() {
        let mk = |_: &Path| -> io::Result<()> { panic!("nothing is created when the volume cannot be told") };
        let err = |_: &Path, _: &Path| -> io::Result<bool> { Err(io::Error::new(io::ErrorKind::NotFound, "gone")) };
        assert_eq!(plan(Path::new("/Applications/StarNet.app"), Path::new(TMP), &err, &mk), Ok(Staging::Default));
    }

    #[test]
    fn a_bundle_without_a_parent_keeps_the_plugin_staging() {
        let mk = |_: &Path| -> io::Result<()> { panic!("no folder to stage beside") };
        let diff = |_: &Path, _: &Path| -> io::Result<bool> { Ok(false) };
        assert_eq!(plan(Path::new("StarNet.app"), Path::new(TMP), &diff, &mk), Ok(Staging::Default));
    }

    #[cfg(unix)]
    #[test]
    fn same_volume_reads_st_dev() {
        let tmp = std::env::temp_dir();
        assert_eq!(same_volume(&tmp, &tmp).unwrap(), true);
        assert!(same_volume(Path::new("/definitely/not/here"), &tmp).is_err());
    }
}
