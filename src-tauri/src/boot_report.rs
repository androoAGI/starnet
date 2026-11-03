//! The page's own boot verdict reaches startup.log.
//!
//! frontend/app/bootguard.js (the page's first script) accounts for every station script of the page: it RAN, FAILED
//! TO LOAD, or THREW WHILE LOADING (gh#136: a SyntaxError dropped app/workflowline.js, the boot check said "passed",
//! and nothing outside the page knew). Once per page load it sends `starnet_boot_report` the counts, the station paths
//! that did not run, their error type names and lines, the critical modules missing and whether the engine is below
//! the floor. This module sanitizes that and formats ONE line for startup.log, which support and the installed
//! acceptance read:
//!
//!   page-boot: passed · 270 of 270 station scripts ran · 0 not run
//!   page-boot: DEGRADED · 269 of 270 station scripts ran · 1 not run: app/workflowline.js (SyntaxError at line 797)
//!   page-boot: FAILED · 269 of 270 station scripts ran · 1 not run: app/recipes.js (failed to load) · missing: World
//!
//! The verdict is decided here from the counts, never taken from the page: FAILED when a critical module is missing or
//! a station script failed to load (bootguard's fatal rule), DEGRADED when any station script did not run or nothing
//! was counted, passed otherwise. Only counts, station paths (app/, js/, shared/), error type names and line numbers
//! pass; a report with anything else in those fields is dropped, and the line says so without repeating it. Unknown
//! fields are ignored, never logged. At most MAX_LINES lines per process (a page that reloads in a loop cannot fill the
//! log). Diagnostic only: nothing waits on it and nothing is refused because of it.
//!
//! serde_json + std only, and nothing from main.rs.

use serde_json::Value;
use std::sync::atomic::{AtomicU32, Ordering};

/// startup.log lines this module writes per process, malformed-report lines included.
pub const MAX_LINES: u32 = 32;
/// The most station scripts a page may count (the station page loads about 270).
pub const MAX_SCRIPTS: u64 = 4096;
/// The most not-run scripts a report may name (bootguard names at most 40; the counts carry the rest).
pub const MAX_NAMED: usize = 64;
/// The most missing critical modules a report may name (bootguard probes 13).
pub const MAX_MISSING: usize = 32;
/// How many not-run scripts the line names before "+N more".
const NAMED_IN_LINE: usize = 12;
const MAX_PATH: usize = 160;
const MAX_LINE_NUMBER: u64 = 10_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Why {
    /// an error event at the <script> element: a 404, a block, a quarantined file
    Load,
    /// an error reported while it was being evaluated: the error's type name and line (0 = unknown)
    Threw { kind: String, line: u32 },
    /// no load or error event observed (including an unavailable load listener)
    Never,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotRun {
    pub file: String,
    pub why: Why,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootReport {
    pub total: u32,
    pub ran: u32,
    pub not_run: Vec<NotRun>,
    pub missing: Vec<String>,
    pub below_floor: bool,
}

/// `app/workflowline.js`, `js/util.js`, `shared/specialties.js`: a station script path and nothing else.
fn station_path(s: &str) -> bool {
    let Some((root, rest)) = s.split_once('/') else {
        return false;
    };
    s.len() <= MAX_PATH
        && matches!(root, "app" | "js" | "shared")
        && rest.ends_with(".js")
        && rest.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        })
}

/// `SyntaxError`, `TypeError`, `Error`: an error type name (the shape bootguard's errorKind keeps), never a message.
fn error_kind(s: &str) -> bool {
    let b = s.as_bytes();
    (2..=48).contains(&b.len())
        && b[0].is_ascii_uppercase()
        && b.iter().all(|c| c.is_ascii_alphabetic())
        && s.ends_with("Error")
}

/// A critical module's global (`World`, `CloudSave`): an identifier.
fn identifier(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=40).contains(&b.len())
        && (b[0].is_ascii_alphabetic() || b[0] == b'_' || b[0] == b'$')
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$')
}

fn count(v: &Value, key: &str, max: u64) -> Result<u32, &'static str> {
    match v.get(key).and_then(Value::as_u64) {
        Some(n) if n <= max => Ok(n as u32),
        Some(_) => Err("a count is out of range"),
        None => Err("a count is missing or not a whole number"),
    }
}

/// The report as bootguard sends it, or why it was refused (a fixed phrase: nothing of the page's is repeated).
pub fn sanitize(v: &Value) -> Result<BootReport, &'static str> {
    if !v.is_object() {
        return Err("the report is not an object");
    }
    let total = count(v, "total", MAX_SCRIPTS)?;
    let ran = count(v, "ran", MAX_SCRIPTS)?;
    if ran > total {
        return Err("more scripts ran than were counted");
    }
    let Some(list) = v.get("notRun").and_then(Value::as_array) else {
        return Err("notRun is missing or not a list");
    };
    if list.len() > MAX_NAMED {
        return Err("notRun names too many scripts");
    }
    let mut not_run = Vec::with_capacity(list.len());
    for item in list {
        let file = item.get("file").and_then(Value::as_str).unwrap_or("");
        if !station_path(file) {
            return Err("a script that did not run is not a station path");
        }
        let why = match item.get("why").and_then(Value::as_str) {
            Some("load") => Why::Load,
            Some("never") => Why::Never,
            Some("threw") => {
                let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
                if !error_kind(kind) {
                    return Err("an error kind is not an error type name");
                }
                let line = match item.get("line") {
                    None | Some(Value::Null) => 0,
                    Some(n) => match n.as_u64() {
                        Some(n) if n <= MAX_LINE_NUMBER => n as u32,
                        _ => return Err("a line number is out of range"),
                    },
                };
                Why::Threw {
                    kind: kind.to_string(),
                    line,
                }
            }
            _ => return Err("a script's reason is not load, threw or never"),
        };
        not_run.push(NotRun {
            file: file.to_string(),
            why,
        });
    }
    let Some(missing_list) = v.get("missing").and_then(Value::as_array) else {
        return Err("missing is not a list");
    };
    if missing_list.len() > MAX_MISSING {
        return Err("missing names too many modules");
    }
    let mut missing = Vec::with_capacity(missing_list.len());
    for m in missing_list {
        match m.as_str() {
            Some(name) if identifier(name) => missing.push(name.to_string()),
            _ => return Err("a missing module is not an identifier"),
        }
    }
    let Some(below_floor) = v.get("belowFloor").and_then(Value::as_bool) else {
        return Err("belowFloor is missing or not true/false");
    };
    Ok(BootReport {
        total,
        ran,
        not_run,
        missing,
        below_floor,
    })
}

/// FAILED / DEGRADED / passed, decided here from the counts (see the module comment).
pub fn verdict(r: &BootReport) -> &'static str {
    if !r.missing.is_empty() || r.not_run.iter().any(|n| n.why == Why::Load) {
        "FAILED"
    } else if !r.not_run.is_empty() || r.ran < r.total || r.total == 0 {
        "DEGRADED"
    } else {
        "passed"
    }
}

fn why_text(n: &NotRun) -> String {
    match &n.why {
        Why::Load => format!("{} (failed to load)", n.file),
        Why::Never => format!("{} (no load event)", n.file),
        Why::Threw { kind, line: 0 } => format!("{} ({kind})", n.file),
        Why::Threw { kind, line } => format!("{} ({kind} at line {line})", n.file),
    }
}

/// The one startup.log line for a sanitized report.
pub fn format_line(r: &BootReport) -> String {
    let mut line = format!("page-boot: {}", verdict(r));
    if r.total == 0 {
        line.push_str(" · no station script was counted");
    } else {
        line.push_str(&format!(" · {} of {} station scripts ran", r.ran, r.total));
    }
    let not_run = (r.total - r.ran).max(r.not_run.len() as u32);
    line.push_str(&format!(" · {not_run} not run"));
    if !r.not_run.is_empty() {
        let named: Vec<String> = r.not_run.iter().take(NAMED_IN_LINE).map(why_text).collect();
        line.push_str(": ");
        line.push_str(&named.join(", "));
        let more = not_run as usize - named.len().min(not_run as usize);
        if more > 0 {
            line.push_str(&format!(" +{more} more"));
        }
    }
    if !r.missing.is_empty() {
        line.push_str(" · missing: ");
        line.push_str(&r.missing.join(", "));
    }
    if r.below_floor {
        line.push_str(" · the web engine is below the floor");
    }
    line
}

/// The per-process line budget.
pub struct Budget(AtomicU32);

impl Budget {
    pub const fn new() -> Self {
        Budget(AtomicU32::new(0))
    }
    /// true while this process may still write a line (at most MAX_LINES)
    pub fn take(&self) -> bool {
        self.0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_LINES).then_some(n + 1)
            })
            .is_ok()
    }
}

pub static BUDGET: Budget = Budget::new();

/// The line to write for one report, or None once the budget is spent.
pub fn accept(report: &Value, budget: &Budget) -> Option<String> {
    if !budget.take() {
        return None;
    }
    Some(match sanitize(report) {
        Ok(r) => format_line(&r),
        Err(why) => format!("page-boot: the page sent a boot report that was dropped ({why})"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn healthy() -> Value {
        json!({ "total": 270, "ran": 270, "notRun": [], "missing": [], "belowFloor": false })
    }

    #[test]
    fn a_healthy_page_reads_passed_with_none_not_run() {
        assert_eq!(
            accept(&healthy(), &Budget::new()).unwrap(),
            "page-boot: passed · 270 of 270 station scripts ran · 0 not run"
        );
    }

    #[test]
    fn a_script_that_threw_while_loading_reads_degraded_and_is_named() {
        let r = json!({ "total": 270, "ran": 269, "missing": [], "belowFloor": false,
            "notRun": [{ "file": "app/workflowline.js", "why": "threw", "kind": "SyntaxError", "line": 797 }] });
        assert_eq!(
            accept(&r, &Budget::new()).unwrap(),
            "page-boot: DEGRADED · 269 of 270 station scripts ran · 1 not run: app/workflowline.js (SyntaxError at line 797)"
        );
    }

    #[test]
    fn a_load_failure_or_a_missing_module_reads_failed() {
        let r = json!({ "total": 270, "ran": 268, "missing": ["World"], "belowFloor": true, "notRun": [
            { "file": "app/recipes.js", "why": "load" },
            { "file": "app/world.js", "why": "threw", "kind": "TypeError", "line": 0 }] });
        assert_eq!(
            accept(&r, &Budget::new()).unwrap(),
            "page-boot: FAILED · 268 of 270 station scripts ran · 2 not run: app/recipes.js (failed to load), app/world.js (TypeError) · missing: World · the web engine is below the floor"
        );
        let never = json!({ "total": 3, "ran": 2, "missing": [], "belowFloor": false,
            "notRun": [{ "file": "shared/specialties.js", "why": "never" }] });
        assert!(accept(&never, &Budget::new()).unwrap().starts_with("page-boot: DEGRADED · 2 of 3 station scripts ran · 1 not run: shared/specialties.js (no load event)"));
    }

    #[test]
    fn the_verdict_is_the_shells_own_never_the_pages() {
        // the counts say something did not run although no script is named: not passed
        let r = json!({ "total": 270, "ran": 200, "notRun": [], "missing": [], "belowFloor": false, "verdict": "passed" });
        assert_eq!(
            accept(&r, &Budget::new()).unwrap(),
            "page-boot: DEGRADED · 200 of 270 station scripts ran · 70 not run"
        );
        let none =
            json!({ "total": 0, "ran": 0, "notRun": [], "missing": [], "belowFloor": false });
        assert_eq!(
            accept(&none, &Budget::new()).unwrap(),
            "page-boot: DEGRADED · no station script was counted · 0 not run"
        );
    }

    #[test]
    fn named_scripts_are_bounded_in_the_line() {
        let list: Vec<Value> = (0..40)
            .map(|i| json!({ "file": format!("app/m{i}.js"), "why": "threw", "kind": "SyntaxError", "line": 1 }))
            .collect();
        let r =
            json!({ "total": 270, "ran": 210, "notRun": list, "missing": [], "belowFloor": false });
        let line = accept(&r, &Budget::new()).unwrap();
        assert!(
            line.contains("· 60 not run: app/m0.js (SyntaxError at line 1)"),
            "{line}"
        );
        assert!(
            line.contains("app/m11.js (SyntaxError at line 1) +48 more"),
            "{line}"
        );
        assert!(!line.contains("app/m12.js"), "{line}");
    }

    #[test]
    fn only_counts_paths_kinds_and_lines_pass() {
        let budget = Budget::new();
        let dropped = |v: Value| {
            let line = accept(&v, &budget).unwrap();
            assert!(
                line.starts_with("page-boot: the page sent a boot report that was dropped ("),
                "{line}"
            );
            assert!(!line.contains("SECRET") && !line.contains("sk-"), "{line}");
            line
        };
        let bad_files = [
            "app/chat.js?ticket=SECRET",
            "../etc/passwd.js",
            "app/../../SECRET.js",
            "C:\\Users\\SECRET\\x.js",
            "/app/x.js",
            "app/x.js\nSECRET",
            "assets/sk-SECRET.js",
            "app/SECRET token.js",
            "app/x.css",
        ];
        for file in bad_files {
            dropped(
                json!({ "total": 2, "ran": 1, "missing": [], "belowFloor": false,
                "notRun": [{ "file": file, "why": "load" }] }),
            );
        }
        for kind in [
            "TypeError: sk-SECRET",
            "x\nSyntaxError",
            "syntaxError",
            "Error SECRET",
            "SECRETS",
        ] {
            dropped(
                json!({ "total": 2, "ran": 1, "missing": [], "belowFloor": false,
                "notRun": [{ "file": "app/x.js", "why": "threw", "kind": kind, "line": 1 }] }),
            );
        }
        dropped(
            json!({ "total": 2, "ran": 1, "missing": [], "belowFloor": false,
            "notRun": [{ "file": "app/x.js", "why": "threw", "kind": "TypeError", "line": "SECRET" }] }),
        );
        dropped(
            json!({ "total": 2, "ran": 1, "missing": [], "belowFloor": false,
            "notRun": [{ "file": "app/x.js", "why": "sk-SECRET" }] }),
        );
        dropped(
            json!({ "total": 2, "ran": 2, "missing": ["World; SECRET"], "belowFloor": false, "notRun": [] }),
        );
        dropped(json!({ "total": 2, "ran": 3, "missing": [], "belowFloor": false, "notRun": [] }));
        dropped(
            json!({ "total": 5000, "ran": 1, "missing": [], "belowFloor": false, "notRun": [] }),
        );
        dropped(
            json!({ "total": 2.5, "ran": 1, "missing": [], "belowFloor": false, "notRun": [] }),
        );
        dropped(json!({ "total": 2, "ran": 1, "missing": [], "notRun": [] }));
        dropped(json!("SECRET"));
        let many: Vec<Value> = (0..65)
            .map(|i| json!({ "file": format!("app/m{i}.js"), "why": "load" }))
            .collect();
        dropped(
            json!({ "total": 100, "ran": 35, "missing": [], "belowFloor": false, "notRun": many }),
        );
        // unknown fields never reach the log
        let r = json!({ "total": 1, "ran": 1, "notRun": [], "missing": [], "belowFloor": false,
            "message": "sk-SECRET", "page": "/?ticket=SECRET" });
        let line = accept(&r, &budget).unwrap();
        assert_eq!(
            line,
            "page-boot: passed · 1 of 1 station scripts ran · 0 not run"
        );
    }

    #[test]
    fn at_most_max_lines_per_process() {
        let budget = Budget::new();
        for _ in 0..MAX_LINES {
            assert!(accept(&healthy(), &budget).is_some());
        }
        assert_eq!(accept(&healthy(), &budget), None);
        assert_eq!(
            accept(&json!("malformed"), &budget),
            None,
            "a malformed report past the budget writes nothing either"
        );
    }
}
