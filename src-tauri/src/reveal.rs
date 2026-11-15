//! Windows Explorer navigation. The caller MUST first use resolve_artifact_path's path jail.
//! No command-line parsing, file associations, or executable-file opening on this path.
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
    fn CoUninitialize();
    fn CoTaskMemFree(memory: *mut c_void);
}
#[link(name = "shell32")]
extern "system" {
    fn SHParseDisplayName(
        name: *const u16,
        bind: *mut c_void,
        item: *mut *mut c_void,
        attributes: u32,
        out_attributes: *mut u32,
    ) -> i32;
    fn SHOpenFolderAndSelectItems(
        folder: *const c_void,
        count: u32,
        children: *const *const c_void,
        flags: u32,
    ) -> i32;
    fn ShellExecuteW(
        window: *mut c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> isize;
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: created only after a successful initialization on this same thread.
        unsafe { CoUninitialize() };
    }
}
struct Item(*mut c_void);
impl Drop for Item {
    fn drop(&mut self) {
        // SAFETY: SHParseDisplayName allocates this PIDL with the COM task allocator.
        unsafe { CoTaskMemFree(self.0) };
    }
}
fn checked(hr: i32, operation: &str) -> Result<(), String> {
    if hr < 0 {
        Err(format!(
            "Could not {operation} (Windows error 0x{:08X})",
            hr as u32
        ))
    } else {
        Ok(())
    }
}
fn wide(path: &Path) -> Result<Vec<u16>, String> {
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.is_empty() || value.contains(&0) || !path.is_absolute() {
        return Err("The deliverable has no valid absolute saved path.".to_string());
    }
    value.push(0);
    Ok(value)
}

/// Navigate only to an existing, already-authorized filesystem item. A dedicated thread
/// owns its STA for the whole operation; async runtime workers may already be MTA.
pub fn show_in_explorer(path: &Path) -> Result<(), String> {
    let path = path.to_path_buf();
    std::thread::spawn(move || show(&path))
        .join()
        .map_err(|_| "Windows folder navigation failed.".to_string())?
}
fn show(path: &Path) -> Result<(), String> {
    let name = wide(path)?;
    let metadata = std::fs::metadata(path)
        .map_err(|_| "The saved deliverable no longer exists or cannot be accessed.".to_string())?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("The saved deliverable is not a file or folder.".to_string());
    }
    // SAFETY: a fresh thread, null reserved pointer, COINIT_APARTMENTTHREADED.
    checked(
        unsafe { CoInitializeEx(null_mut(), 2) },
        "initialize Explorer navigation",
    )?;
    let _apartment = Apartment;
    if metadata.is_dir() {
        // Fixed directory-only verb, never a default FILE association or a shell command.
        // SAFETY: all string buffers are nul-terminated and alive through the call;
        // optional arguments are null. SW_SHOWNORMAL = 1.
        let verb: Vec<u16> = "explore".encode_utf16().chain(Some(0)).collect();
        let result =
            unsafe { ShellExecuteW(null_mut(), verb.as_ptr(), name.as_ptr(), null(), null(), 1) };
        if result <= 32 {
            return Err(format!(
                "Could not open this folder in Explorer (Windows error {result})."
            ));
        }
    } else {
        let mut pidl = null_mut();
        // SAFETY: name is a live nul-terminated absolute filesystem path, pidl is an out pointer.
        checked(
            unsafe { SHParseDisplayName(name.as_ptr(), null_mut(), &mut pidl, 0, null_mut()) },
            "locate this deliverable in Explorer",
        )?;
        if pidl.is_null() {
            return Err("Windows could not locate this deliverable.".to_string());
        }
        let item = Item(pidl);
        // cidl=0: the absolute PIDL names the single file; Windows opens its parent and selects it.
        // SAFETY: the live PIDL was allocated by SHParseDisplayName, with no child array or flags.
        checked(
            unsafe { SHOpenFolderAndSelectItems(item.0, 0, null(), 0) },
            "show this deliverable in Explorer",
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_invalid_paths_without_navigating() {
        for value in ["", "report.md", "E:relative.md", "E:\\bad\0name.md"] {
            assert!(show_in_explorer(Path::new(value)).is_err(), "{value:?}");
        }
        assert!(show_in_explorer(Path::new("E:\\starnet-missing-4bade61a\\report.md")).is_err());
    }
    #[test]
    fn preserves_spaces_unicode_and_punctuation_as_path_data() {
        let p = Path::new("E:\\Example Workspace\\nested, space & café\\report.py");
        let encoded = wide(p).unwrap();
        assert_eq!(encoded.last(), Some(&0));
        assert_eq!(
            String::from_utf16(&encoded[..encoded.len() - 1]).unwrap(),
            p.to_str().unwrap()
        );
    }
}
