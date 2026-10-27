//! Is the process that holds a PID today the one that stamped a workspace-owner claim? The native twin of
//! sidecar/process-identity.js (judgeReuse) and of the boot rule in sidecar/workspace-owner.js (predatesBoot), so the
//! desktop shell judges a claim by the sidecar's own rules. One reading differs: a process this user cannot open is
//! read from the kernel's process list, whose creation time is EXACT, where the sidecar's Win32_Process fallback is
//! approximate (CIM_TOLERANCE_MS). Near the edges of the tolerance the two can then disagree — in both directions, and
//! both safely: a 'reused' from an exact time is proof, and an unproven reuse stays held.
//!
//! A PID alone proves nothing: Windows recycles PIDs within one boot, and a claim left behind by a hard kill can name
//! a PID that now belongs to an unrelated program (the 2026-10-15 soak: hard-killed node 43136 stamped its claim at
//! 08:30:50Z, cmd.exe got PID 43136 at 09:01:52Z). A shell that read that PID as "alive" refused START FRESH and ERASE
//! for good — the escape hatch for a wedged station was itself wedged. So a live PID is probed for the OS's record of
//! when its CURRENT process was created and which image it runs, and judged against the claim's stamp:
//!   - Linux: the claimant stamps its exact /proc start ticks; different ticks = a different process.
//!   - otherwise a process created more than REUSE_SLACK_MS after the stamp cannot be the claimant (a holder always
//!     exists before it writes its claim); between REUSE_EXE_SLACK_MS and that slack it counts only when the image
//!     differs too. An approximate reading (the sidecar's Win32_Process fallback) carries a tolerance that widens both.
//!   - anything unreadable is UNKNOWN, which every caller treats as a live owner: uncertainty is a safe "busy", never a
//!     second writer on one station.
//! The rule and its parsers are tested against the SAME cases as the JS rule (test/fixtures/process-identity-cases.json,
//! read by both test suites), so the two cannot drift apart silently.

pub const REUSE_SLACK_MS: u64 = 60_000;
pub const REUSE_EXE_SLACK_MS: u64 = 2_000;

/// What a claimant wrote about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stamp {
    /// epoch ms when the claim was written (0 = not stamped)
    pub started_at: u64,
    pub executable: String,
    /// Linux /proc start ticks ('' = not stamped)
    pub start_ticks: String,
}

/// What a probe of a live PID's current process found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    /// the identity could not be read (access denied, tool missing, unparseable): treat as the claimant
    Unknown(String),
    Read {
        /// epoch ms the process was created (0 = not read)
        started_at: u64,
        executable: String,
        start_ticks: String,
        /// how far off `started_at` may be (0 = exact)
        tolerance_ms: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// proof that the PID's current process cannot have written the stamp
    Reused,
    SameProcess,
    Unknown,
}

impl Verdict {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Reused => "reused",
            Verdict::SameProcess => "same-process",
            Verdict::Unknown => "unknown",
        }
    }
}

/// A file's base name without directory, case or a trailing ".exe": `C:\x\NODE.EXE`, `node.exe` and `/usr/bin/node` are
/// all `node` (sidecar/process-identity.js imageName).
pub fn image_name(file: &str) -> String {
    let s = file.trim().replace('\\', "/");
    let base = s.rsplit('/').next().unwrap_or("").to_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

/// judgeReuse, verbatim: 'reused' only on proof.
pub fn judge_reuse(stamp: &Stamp, seen: &Seen) -> Verdict {
    let Seen::Read { started_at, executable, start_ticks, tolerance_ms } = seen else {
        return Verdict::Unknown;
    };
    if !stamp.start_ticks.is_empty() && !start_ticks.is_empty() {
        return if stamp.start_ticks != *start_ticks { Verdict::Reused } else { Verdict::SameProcess };
    }
    let born = *started_at as i128;
    let stamped = stamp.started_at as i128;
    if born <= 0 || stamped <= 0 {
        return Verdict::Unknown;
    }
    let tolerance = *tolerance_ms as i128;
    let (a, b) = (image_name(&stamp.executable), image_name(executable));
    let other_image = !a.is_empty() && !b.is_empty() && a != b;
    let slack = REUSE_SLACK_MS as i128;
    let exe_slack = REUSE_EXE_SLACK_MS as i128;
    let reused = if tolerance == 0 {
        born > stamped + slack || (other_image && born > stamped + exe_slack)
    } else {
        born - tolerance > stamped + slack || (other_image && born + tolerance > stamped + exe_slack)
    };
    if reused {
        Verdict::Reused
    } else {
        Verdict::SameProcess
    }
}

/// A workspace-owner claim (`.starnet-workspace-owner.json`, version 1) — the PID and what its claimant stamped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerClaim {
    pub pid: u32,
    pub stamp: Stamp,
}

pub fn parse_owner_claim(bytes: &[u8]) -> Option<OwnerClaim> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if value.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let pid = value.get("pid").and_then(|v| v.as_u64())?;
    let pid = u32::try_from(pid).ok().filter(|pid| *pid > 0)?;
    let started_at = value
        .get("startedAt")
        .and_then(|v| v.as_f64())
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map(|ms| ms as u64)
        .unwrap_or(0);
    let executable = value.get("executable").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let start_ticks = value
        .get("startTicks")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or("")
        .to_string();
    Some(OwnerClaim { pid, stamp: Stamp { started_at, executable, start_ticks } })
}

/// `ps -o lstart= -o comm=` under TZ=UTC / LC_ALL=C → (epoch ms, image). sidecar/process-identity.js parseLstart.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub fn parse_lstart(out: &str) -> Option<(u64, String)> {
    let line = out.lines().find(|l| !l.trim().is_empty())?.trim();
    let mut it = line.split_whitespace();
    let _weekday = it.next().filter(|w| w.len() == 3 && w.chars().all(|c| c.is_ascii_alphabetic()))?;
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let month = it.next().map(|m| m.to_lowercase())?;
    let month = MONTHS.iter().position(|m| *m == month)? as u32 + 1;
    let day: u32 = it.next()?.parse().ok().filter(|d| (1..=31).contains(d))?;
    let mut hms = it.next()?.split(':');
    let hour: u32 = hms.next()?.parse().ok().filter(|h| *h < 24)?;
    let minute: u32 = hms.next()?.parse().ok().filter(|m| *m < 60)?;
    let second: u32 = hms.next()?.parse().ok().filter(|s| *s < 61)?;
    if hms.next().is_some() {
        return None;
    }
    let year: i64 = it.next()?.parse().ok().filter(|y: &i64| (1970..=9999).contains(y))?;
    let rest: Vec<&str> = it.collect();
    let days = days_from_civil(year, month, day);
    let ms = ((days * 86_400) + (hour as i64 * 3600) + (minute as i64 * 60) + second as i64) * 1000;
    if ms <= 0 {
        return None;
    }
    Some((ms as u64, rest.join(" ")))
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's days_from_civil).
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// /proc/<pid>/stat → field 22 (start time, clock ticks since boot), counted from the LAST ')' because comm may itself
/// hold spaces and parentheses. sidecar/process-identity.js parseProcStat.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
pub fn parse_proc_stat(text: &str) -> String {
    let Some(close) = text.rfind(')') else {
        return String::new();
    };
    let ticks = text[close + 1..].split_whitespace().nth(19).unwrap_or("");
    if !ticks.is_empty() && ticks.bytes().all(|b| b.is_ascii_digit()) {
        ticks.to_string()
    } else {
        String::new()
    }
}

/// What the OS says about one PID right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// provably no such process (or it has exited)
    Gone,
    Live(Seen),
}

/// Probe a PID's current process: gone, or alive with whatever identity could be read.
///
/// The handle asks for PROCESS_QUERY_LIMITED_INFORMATION alone (no SYNCHRONIZE: more processes grant the narrower
/// right). A process this user cannot open at all (a service, another user's or an elevated one) is still read: the
/// kernel's own process list (`system_processes`) carries its exact creation time and image name with no handle —
/// the native counterpart of the sidecar's Win32_Process fallback, and exact where that one is approximate.
#[cfg(windows)]
pub fn probe(pid: u32) -> Probe {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return Probe::Live(Seen::Unknown("pid 0".to_string()));
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        // Windows documents INVALID_PARAMETER for a PID that does not exist; access denied is a live, unreadable one
        if error == ERROR_INVALID_PARAMETER {
            return Probe::Gone;
        }
        let opened = format!("cannot open the process (error {error})");
        return match system_processes().and_then(|all| all.into_iter().find(|p| p.pid == pid)) {
            Some(row) => match filetime_to_epoch_ms(row.created) {
                Some(started_at) => Probe::Live(Seen::Read {
                    started_at,
                    executable: row.image,
                    start_ticks: String::new(),
                    tolerance_ms: 0,
                }),
                None => Probe::Live(Seen::Unknown(format!("{opened}; the process list gives no creation time"))),
            },
            // not listed (it may have just exited): unproven either way, so it stays a live owner
            None => Probe::Live(Seen::Unknown(opened)),
        };
    }
    // an exited process whose handle someone still holds answers OpenProcess: only an exit code proves it gone
    // (STILL_ACTIVE, 259, is what a running process reports — a process that EXITED with 259 reads as live: safe)
    let mut code = 0u32;
    let exited = unsafe { GetExitCodeProcess(handle, &mut code) } != 0 && code != STILL_ACTIVE;
    let created = windows_created_ms(handle);
    let image = windows_image(handle);
    unsafe { CloseHandle(handle) };
    if exited {
        return Probe::Gone;
    }
    match created {
        Some(started_at) => Probe::Live(Seen::Read {
            started_at,
            executable: image.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
            start_ticks: String::new(),
            tolerance_ms: 0,
        }),
        None => Probe::Live(Seen::Unknown("no creation time".to_string())),
    }
}

#[cfg(target_os = "linux")]
pub fn probe(pid: u32) -> Probe {
    if !unix_pid_exists(pid) {
        return Probe::Gone;
    }
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(text) => {
            let ticks = parse_proc_stat(&text);
            if ticks.is_empty() {
                Probe::Live(Seen::Unknown("unparseable /proc stat".to_string()))
            } else {
                let executable = std::fs::read_link(format!("/proc/{pid}/exe"))
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                Probe::Live(Seen::Read { started_at: 0, executable, start_ticks: ticks, tolerance_ms: 0 })
            }
        }
        Err(error) => Probe::Live(Seen::Unknown(format!("/proc unreadable: {error}"))),
    }
}

#[cfg(target_os = "macos")]
pub fn probe(pid: u32) -> Probe {
    if !unix_pid_exists(pid) {
        return Probe::Gone;
    }
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "lstart=", "-o", "comm=", "-p", &pid.to_string()])
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .output();
    match out {
        Ok(out) if out.status.success() => match parse_lstart(&String::from_utf8_lossy(&out.stdout)) {
            Some((started_at, executable)) => {
                Probe::Live(Seen::Read { started_at, executable, start_ticks: String::new(), tolerance_ms: 0 })
            }
            None => Probe::Live(Seen::Unknown("unparseable start time".to_string())),
        },
        Ok(out) => Probe::Live(Seen::Unknown(format!("ps exited {:?}", out.status.code()))),
        Err(error) => Probe::Live(Seen::Unknown(format!("ps failed: {error}"))),
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn probe(pid: u32) -> Probe {
    if !unix_pid_exists(pid) {
        return Probe::Gone;
    }
    Probe::Live(Seen::Unknown("unsupported platform".to_string()))
}

#[cfg(not(any(unix, windows)))]
pub fn probe(_pid: u32) -> Probe {
    Probe::Live(Seen::Unknown("unsupported platform".to_string()))
}

/// kill(pid, 0): only ESRCH proves absence (EPERM is a live process this user cannot signal).
#[cfg(unix)]
fn unix_pid_exists(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let Ok(pid) = i32::try_from(pid) else {
        return true;
    };
    if pid <= 0 {
        return true;
    }
    if unsafe { kill(pid, 0) } == 0 {
        return true;
    }
    // ESRCH is 3 on the Unix platforms StarNet ships (macOS and Linux)
    std::io::Error::last_os_error().raw_os_error() != Some(3)
}

/// A process's full executable image path (the handle needs PROCESS_QUERY_LIMITED_INFORMATION).
#[cfg(windows)]
pub fn windows_image(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<std::path::PathBuf> {
    use windows_sys::Win32::Foundation::MAX_PATH;
    use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;
    let mut buf = vec![0u16; 32 * MAX_PATH as usize];
    let mut size = buf.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) } == 0 {
        return None;
    }
    Some(std::path::PathBuf::from(String::from_utf16_lossy(&buf[..size as usize])))
}

/// A process's creation time as Windows FILETIME ticks (100 ns since 1601), when Windows says it.
#[cfg(windows)]
pub fn windows_created(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return None;
    }
    Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

/// GetExitCodeProcess's "still running" code.
#[cfg(windows)]
const STILL_ACTIVE: u32 = 259;

/// One row of the kernel's process list (NtQuerySystemInformation, SystemProcessInformation): every process, read with
/// NO handle, so the ones this user may not open (services, other users', elevated) are there too.
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemProcess {
    pub pid: u32,
    /// the PID of the process that created it (it may have exited since, and its PID been reused: check `created`)
    pub parent: u32,
    /// creation time, FILETIME ticks (100 ns since 1601) — exactly what GetProcessTimes reports
    pub created: u64,
    /// the image's file name (no directory); '' for the idle process
    pub image: String,
}

/// The whole process list right now, or None when the kernel would not give it (or on a 32-bit build, whose row layout
/// this reader does not decode).
#[cfg(windows)]
pub fn system_processes() -> Option<Vec<SystemProcess>> {
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQuerySystemInformation(class: u32, info: *mut core::ffi::c_void, length: u32, returned: *mut u32) -> i32;
    }
    const SYSTEM_PROCESS_INFORMATION: u32 = 5;
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
    if !cfg!(target_pointer_width = "64") {
        return None;
    }
    let mut size = 1usize << 20;
    for _ in 0..6 {
        // u64 cells: the rows hold 8-byte fields and pointers, so the buffer must be 8-aligned
        let mut buf = vec![0u64; size / 8];
        let mut returned = 0u32;
        let status = unsafe {
            NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, &mut returned)
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            size = (returned as usize).max(size) * 2;
            continue;
        }
        if status < 0 {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), buf.len() * 8) };
        return parse_system_processes(bytes, buf.as_ptr() as usize);
    }
    None
}

/// The SYSTEM_PROCESS_INFORMATION rows of a 64-bit process list buffer that starts at address `base` (each row's image
/// name points INTO the buffer; a pointer outside it is never followed). None on any malformed row.
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
pub fn parse_system_processes(bytes: &[u8], base: usize) -> Option<Vec<SystemProcess>> {
    // x64 offsets: NextEntryOffset 0x00, CreateTime 0x20, ImageName {Length 0x38, Buffer 0x40}, UniqueProcessId 0x50,
    // InheritedFromUniqueProcessId 0x58
    const ROW: usize = 0x60;
    let mut out = Vec::new();
    let mut at = 0usize;
    loop {
        let row = bytes.get(at..at.checked_add(ROW)?)?;
        let u32_at = |o: usize| u32::from_le_bytes(row[o..o + 4].try_into().unwrap());
        let u64_at = |o: usize| u64::from_le_bytes(row[o..o + 8].try_into().unwrap());
        let next = u32_at(0x00) as usize;
        let name_len = u16::from_le_bytes(row[0x38..0x3A].try_into().unwrap()) as usize;
        let name_ptr = u64_at(0x40) as usize;
        let image = if name_len > 0 && name_len % 2 == 0 && name_ptr >= base {
            let off = name_ptr - base;
            match bytes.get(off..off.checked_add(name_len)?) {
                Some(raw) => String::from_utf16_lossy(&raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()),
                None => return None,
            }
        } else {
            String::new()
        };
        out.push(SystemProcess {
            pid: u32::try_from(u64_at(0x50)).ok()?,
            parent: u32::try_from(u64_at(0x58)).ok()?,
            created: u64_at(0x20),
            image,
        });
        if next == 0 {
            return Some(out);
        }
        if next < ROW {
            return None;
        }
        at = at.checked_add(next)?;
    }
}

/// When this computer last started, epoch ms (0 = unknown) — the same clock reading as the sidecar's
/// `Date.now() - os.uptime() * 1000` (workspace-owner.js makeBootedAt): Windows GetTickCount64, Linux /proc/uptime,
/// macOS kern.boottime.
pub fn booted_at_ms() -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    booted_at_from(now)
}

#[cfg(windows)]
fn booted_at_from(now: u64) -> u64 {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetTickCount64() -> u64;
    }
    let up = unsafe { GetTickCount64() };
    if now > up && up > 0 {
        now - up
    } else {
        0
    }
}

#[cfg(target_os = "linux")]
fn booted_at_from(now: u64) -> u64 {
    let up = std::fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()))
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| (v * 1000.0) as u64)
        .unwrap_or(0);
    if now > up && up > 0 {
        now - up
    } else {
        0
    }
}

#[cfg(target_os = "macos")]
fn booted_at_from(_now: u64) -> u64 {
    #[repr(C)]
    struct TimeVal {
        sec: i64,
        usec: i32,
    }
    unsafe extern "C" {
        fn sysctlbyname(
            name: *const std::ffi::c_char,
            oldp: *mut std::ffi::c_void,
            oldlenp: *mut usize,
            newp: *mut std::ffi::c_void,
            newlen: usize,
        ) -> i32;
    }
    let mut tv = TimeVal { sec: 0, usec: 0 };
    let mut len = std::mem::size_of::<TimeVal>();
    let ok = unsafe {
        sysctlbyname(
            b"kern.boottime\0".as_ptr().cast(),
            (&mut tv as *mut TimeVal).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    if ok && tv.sec > 0 {
        tv.sec as u64 * 1000 + (tv.usec.max(0) as u64) / 1000
    } else {
        0
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn booted_at_from(_now: u64) -> u64 {
    0
}

/// The slack between the boot clock and a claim's stamp (workspace-owner.js BOOT_SLACK_MS): a station that stamped its
/// claim seconds after boot is never misread as pre-boot.
pub const BOOT_SLACK_MS: u64 = 60_000;

/// A claim stamped before this computer last started cannot belong to a running process (workspace-owner.js
/// predatesBoot; sidecar/process-identity.js predatesBoot holds the same rule, and the shared fixtures pin both).
pub fn predates_boot(stamped_ms: u64, booted_at_ms: u64) -> bool {
    booted_at_ms > 0 && stamped_ms > 0 && stamped_ms < booted_at_ms.saturating_sub(BOOT_SLACK_MS)
}

/// FILETIME ticks → epoch ms (None before 1970).
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
pub fn filetime_to_epoch_ms(ticks: u64) -> Option<u64> {
    const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;
    ticks.checked_sub(FILETIME_UNIX_EPOCH).map(|t| t / 10_000).filter(|ms| *ms > 0)
}

#[cfg(windows)]
fn windows_created_ms(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<u64> {
    windows_created(handle).and_then(filetime_to_epoch_ms)
}

/// Does `claim` still name a live process that may be its claimant? false only on proof: it was stamped before this
/// computer last started, the PID is gone, or its current process is provably a different one (reused) — the order
/// the sidecar's own boot judges a claim in (workspace-owner.js holderDead). Unknown identity = held. `why` says what
/// decided it.
pub fn claim_is_held(claim: &OwnerClaim) -> (bool, String) {
    claim_is_held_with(claim, &probe, booted_at_ms())
}

pub fn claim_is_held_with(claim: &OwnerClaim, probe: &dyn Fn(u32) -> Probe, booted_at: u64) -> (bool, String) {
    if predates_boot(claim.stamp.started_at, booted_at) {
        return (
            false,
            format!("PID {}'s claim was stamped before this computer last started — no process holds it now", claim.pid),
        );
    }
    match probe(claim.pid) {
        Probe::Gone => (false, format!("PID {} is gone", claim.pid)),
        Probe::Live(seen) => match judge_reuse(&claim.stamp, &seen) {
            Verdict::Reused => (
                false,
                format!("PID {} now belongs to a process started after the claim — a recycled PID", claim.pid),
            ),
            Verdict::SameProcess => (true, format!("PID {} is the process that stamped the claim", claim.pid)),
            Verdict::Unknown => (
                true,
                format!(
                    "PID {} is running but its identity could not be read ({}) — treated as the owner",
                    claim.pid,
                    match &seen {
                        Seen::Unknown(reason) => reason.as_str(),
                        Seen::Read { .. } => "no comparable start time",
                    }
                ),
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = include_str!("../../test/fixtures/process-identity-cases.json");

    fn stamp_of(v: &serde_json::Value) -> Stamp {
        Stamp {
            started_at: v.get("startedAt").and_then(|x| x.as_u64()).unwrap_or(0),
            executable: v.get("executable").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            start_ticks: v.get("startTicks").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        }
    }

    fn seen_of(v: &serde_json::Value) -> Seen {
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            return Seen::Unknown(v.get("reason").and_then(|x| x.as_str()).unwrap_or("").to_string());
        }
        Seen::Read {
            started_at: v.get("startedAt").and_then(|x| x.as_u64()).unwrap_or(0),
            executable: v.get("executable").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            start_ticks: v.get("startTicks").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            tolerance_ms: v.get("toleranceMs").and_then(|x| x.as_u64()).unwrap_or(0),
        }
    }

    #[test]
    fn shared_fixtures_match_the_js_rule() {
        let fixtures: serde_json::Value = serde_json::from_str(FIXTURES).expect("fixture JSON");
        let cases = fixtures["judge"].as_array().expect("judge cases");
        assert!(cases.len() >= 15, "the shared fixture file carries the judge cases");
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let got = judge_reuse(&stamp_of(&c["stamp"]), &seen_of(&c["seen"]));
            assert_eq!(got.as_str(), c["verdict"].as_str().unwrap(), "Rust judge_reuse: {name}");
        }
        for pair in fixtures["imageName"].as_array().unwrap() {
            let (raw, want) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
            assert_eq!(image_name(raw), want, "Rust image_name({raw:?})");
        }
        for pair in fixtures["lstart"].as_array().unwrap() {
            let raw = pair[0].as_str().unwrap();
            let want = (!pair[1].is_null()).then(|| {
                (pair[1]["startedAt"].as_u64().unwrap(), pair[1]["executable"].as_str().unwrap().to_string())
            });
            assert_eq!(parse_lstart(raw), want, "Rust parse_lstart({raw:?})");
        }
        for pair in fixtures["procStat"].as_array().unwrap() {
            let (raw, want) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
            assert_eq!(parse_proc_stat(raw), want, "Rust parse_proc_stat({raw:?})");
        }
    }

    #[test]
    fn owner_claims_are_read_like_the_sidecar_writes_them() {
        let claim = parse_owner_claim(
            br#"{"version":1,"pid":43136,"nonce":"n","startedAt":1792053050000,"executable":"C:\\x\\node.exe"}"#,
        )
        .expect("claim");
        assert_eq!(claim.pid, 43136);
        assert_eq!(claim.stamp.started_at, 1792053050000);
        assert_eq!(claim.stamp.executable, "C:\\x\\node.exe");
        let linux = parse_owner_claim(br#"{"version":1,"pid":7,"startedAt":5,"startTicks":"987654"}"#).unwrap();
        assert_eq!(linux.stamp.start_ticks, "987654");
        assert!(parse_owner_claim(br#"{"version":2,"pid":7}"#).is_none(), "another version is not ours to judge");
        assert!(parse_owner_claim(br#"{"version":1,"pid":0}"#).is_none());
        assert!(parse_owner_claim(b"{torn").is_none());
        let bad_ticks = parse_owner_claim(br#"{"version":1,"pid":7,"startTicks":"12x"}"#).unwrap();
        assert_eq!(bad_ticks.stamp.start_ticks, "", "non-numeric ticks are not a stamp");
    }

    #[test]
    fn a_claim_is_held_unless_proven_otherwise() {
        let claim = OwnerClaim {
            pid: 43136,
            stamp: Stamp { started_at: 1_792_053_050_000, executable: "node.exe".into(), start_ticks: String::new() },
        };
        // booted an hour before the stamp: the boot rule never decides these
        let boot = 1_792_053_050_000 - 3_600_000;
        let gone = claim_is_held_with(&claim, &|_| Probe::Gone, boot);
        assert!(!gone.0 && gone.1.contains("gone"), "{gone:?}");
        let reused = claim_is_held_with(
            &claim,
            &|_| {
                Probe::Live(Seen::Read {
                    started_at: 1_792_054_912_000,
                    executable: "cmd.exe".into(),
                    start_ticks: String::new(),
                    tolerance_ms: 0,
                })
            },
            boot,
        );
        assert!(!reused.0 && reused.1.contains("recycled"), "{reused:?}");
        let same_seen = Probe::Live(Seen::Read {
            started_at: 1_792_053_049_000,
            executable: "node.exe".into(),
            start_ticks: String::new(),
            tolerance_ms: 0,
        });
        let same = claim_is_held_with(&claim, &|_| same_seen.clone(), boot);
        assert!(same.0, "{same:?}");
        let unknown = claim_is_held_with(&claim, &|_| Probe::Live(Seen::Unknown("access denied".into())), boot);
        assert!(unknown.0 && unknown.1.contains("access denied"), "{unknown:?}");
        // a reboot since the stamp releases the claim before any probe — even one that cannot read the PID's process
        let rebooted = claim_is_held_with(&claim, &|_| Probe::Live(Seen::Unknown("access denied".into())), 1_792_053_050_000 + 600_000);
        assert!(!rebooted.0 && rebooted.1.contains("before this computer last started"), "{rebooted:?}");
        // an unknown boot time decides nothing
        let no_boot = claim_is_held_with(&claim, &|_| Probe::Live(Seen::Unknown("access denied".into())), 0);
        assert!(no_boot.0, "{no_boot:?}");
    }

    #[test]
    fn the_shared_boot_rule_matches_the_js_rule() {
        let fixtures: serde_json::Value = serde_json::from_str(FIXTURES).expect("fixture JSON");
        let cases = fixtures["predatesBoot"].as_array().expect("predatesBoot cases");
        assert!(cases.len() >= 5);
        for c in cases {
            let (booted, stamped, want) = (c[0].as_u64().unwrap(), c[1].as_u64().unwrap(), c[2].as_bool().unwrap());
            assert_eq!(predates_boot(stamped, booted), want, "Rust predates_boot(stamp {stamped}, boot {booted})");
        }
        assert_eq!(BOOT_SLACK_MS, 60_000);
        // the real boot clock: some time in the past, after 2020
        let booted = booted_at_ms();
        if cfg!(any(windows, target_os = "linux", target_os = "macos")) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
            assert!(booted > 1_577_836_800_000 && booted < now, "boot time {booted} vs now {now}");
        }
    }

    /// A synthetic two-row 64-bit process list: the reader takes each row's PID, parent, creation time and the image
    /// name its pointer names inside the buffer, and refuses a pointer outside it.
    #[test]
    fn the_kernel_process_list_rows_are_read() {
        let mut buf = vec![0u8; 0x200];
        let base = 0x10_0000usize;
        let row = |buf: &mut Vec<u8>, at: usize, next: u32, pid: u64, parent: u64, created: u64, name_at: usize, name: &str| {
            buf[at..at + 4].copy_from_slice(&next.to_le_bytes());
            buf[at + 0x20..at + 0x28].copy_from_slice(&created.to_le_bytes());
            let units: Vec<u8> = name.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
            buf[at + 0x38..at + 0x3A].copy_from_slice(&(units.len() as u16).to_le_bytes());
            buf[at + 0x40..at + 0x48].copy_from_slice(&((base + name_at) as u64).to_le_bytes());
            buf[at + 0x50..at + 0x58].copy_from_slice(&pid.to_le_bytes());
            buf[at + 0x58..at + 0x60].copy_from_slice(&parent.to_le_bytes());
            buf[name_at..name_at + units.len()].copy_from_slice(&units);
        };
        row(&mut buf, 0, 0x80, 4, 0, 1111, 0x180, "System");
        row(&mut buf, 0x80, 0, 4242, 4, 2222, 0x1A0, "node.exe");
        let rows = parse_system_processes(&buf, base).expect("rows");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1], SystemProcess { pid: 4242, parent: 4, created: 2222, image: "node.exe".into() });
        assert_eq!(rows[0].image, "System");
        // a name pointer outside the buffer is never followed
        buf[0x80 + 0x40..0x80 + 0x48].copy_from_slice(&((base + 0x10_000) as u64).to_le_bytes());
        assert_eq!(parse_system_processes(&buf, base), None);
        // a row that runs past the end is malformed
        assert_eq!(parse_system_processes(&buf[..0x70], base), None);
    }

    /// The real kernel list: this process is in it with the same creation time GetProcessTimes reports and this test
    /// binary's file name; a process this user cannot open is still probed to a real identity through it.
    #[cfg(windows)]
    #[test]
    fn the_real_process_list_and_an_unopenable_process() {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let all = system_processes().expect("the kernel process list");
        let me = std::process::id();
        let row = all.iter().find(|p| p.pid == me).expect("this process is listed");
        assert_eq!(Some(row.created), windows_created(unsafe { GetCurrentProcess() }), "the same creation time GetProcessTimes reports");
        let exe = std::env::current_exe().unwrap();
        assert_eq!(row.image.to_lowercase(), exe.file_name().unwrap().to_string_lossy().to_lowercase());
        let unopenable = all.iter().find(|p| {
            if p.pid == 0 || p.image.is_empty() || filetime_to_epoch_ms(p.created).is_none() {
                return false;
            }
            let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, p.pid) };
            if h.is_null() {
                return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
            }
            unsafe { CloseHandle(h) };
            false
        });
        let Some(target) = unopenable else {
            eprintln!("every listed process opens for this user (an elevated run) — the fallback is not reached here");
            return;
        };
        match probe(target.pid) {
            Probe::Live(Seen::Read { started_at, executable, tolerance_ms, .. }) => {
                assert_eq!(Some(started_at), filetime_to_epoch_ms(target.created), "{target:?}");
                assert_eq!(executable, target.image);
                assert_eq!(tolerance_ms, 0, "the kernel's creation time is exact");
            }
            other => panic!("an unopenable live process ({target:?}) must still be read: {other:?}"),
        }
    }

    #[test]
    fn filetime_converts_to_epoch_ms() {
        assert_eq!(filetime_to_epoch_ms(116_444_736_000_000_000), None, "the epoch itself is not a creation time");
        assert_eq!(filetime_to_epoch_ms(116_444_736_000_000_000 + 10_000), Some(1));
        assert_eq!(filetime_to_epoch_ms(5), None);
    }

    /// The real probe on this very process: alive, with a creation time at or before now and (Windows/macOS) this
    /// test binary's image; a stamp written now is the same process, one written an hour before it was born is not.
    #[test]
    fn the_real_probe_reads_this_process() {
        let me = std::process::id();
        let Probe::Live(seen) = probe(me) else { panic!("this process is alive") };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        if let Seen::Read { started_at, executable, start_ticks, .. } = &seen {
            if cfg!(windows) || cfg!(target_os = "macos") {
                assert!(*started_at > 0 && *started_at <= now_ms + 1000, "creation time {started_at} vs now {now_ms}");
                assert!(!executable.is_empty());
            }
            let stamp_now = Stamp { started_at: now_ms, executable: executable.clone(), start_ticks: start_ticks.clone() };
            assert_eq!(judge_reuse(&stamp_now, &seen), Verdict::SameProcess);
            if start_ticks.is_empty() {
                let stamp_before = Stamp { started_at: started_at.saturating_sub(3_600_000), ..stamp_now };
                assert_eq!(judge_reuse(&stamp_before, &seen), Verdict::Reused, "born an hour after the stamp");
            }
        } else if cfg!(any(windows, target_os = "linux", target_os = "macos")) {
            panic!("the probe could not read this process: {seen:?}");
        }
        // a PID far beyond any live one (Windows ignores a PID's low two bits, so keep it a multiple of 4; unix: past pid_max)
        let impossible = if cfg!(windows) { 4_294_967_292 } else { 2_147_483_000 };
        assert_eq!(probe(impossible), Probe::Gone);
    }
}
