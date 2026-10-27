//! Is the process that holds a PID today the one that stamped a workspace-owner claim? The native twin of
//! sidecar/process-identity.js (judgeReuse), so the desktop shell decides exactly as the sidecar does.
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
#[cfg(windows)]
pub fn probe(pid: u32) -> Probe {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    if pid == 0 {
        return Probe::Live(Seen::Unknown("pid 0".to_string()));
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        // Windows documents INVALID_PARAMETER for a PID that does not exist; access denied is a live, unreadable one
        return if error == ERROR_INVALID_PARAMETER {
            Probe::Gone
        } else {
            Probe::Live(Seen::Unknown(format!("cannot open the process (error {error})")))
        };
    }
    // an exited process whose handle someone still holds answers OpenProcess: only a signalled handle proves it gone
    let exited = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
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

/// Does `claim` still name a live process that may be its claimant? false only on proof: the PID is gone, or its
/// current process is provably a different one (reused). Unknown identity = held. `why` says what decided it.
pub fn claim_is_held(claim: &OwnerClaim) -> (bool, String) {
    claim_is_held_with(claim, &probe)
}

pub fn claim_is_held_with(claim: &OwnerClaim, probe: &dyn Fn(u32) -> Probe) -> (bool, String) {
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
        let gone = claim_is_held_with(&claim, &|_| Probe::Gone);
        assert!(!gone.0 && gone.1.contains("gone"), "{gone:?}");
        let reused = claim_is_held_with(&claim, &|_| {
            Probe::Live(Seen::Read {
                started_at: 1_792_054_912_000,
                executable: "cmd.exe".into(),
                start_ticks: String::new(),
                tolerance_ms: 0,
            })
        });
        assert!(!reused.0 && reused.1.contains("recycled"), "{reused:?}");
        let same = claim_is_held_with(&claim, &|_| {
            Probe::Live(Seen::Read {
                started_at: 1_792_053_049_000,
                executable: "node.exe".into(),
                start_ticks: String::new(),
                tolerance_ms: 0,
            })
        });
        assert!(same.0, "{same:?}");
        let unknown = claim_is_held_with(&claim, &|_| Probe::Live(Seen::Unknown("access denied".into())));
        assert!(unknown.0 && unknown.1.contains("access denied"), "{unknown:?}");
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
