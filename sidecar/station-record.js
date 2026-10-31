/* sidecar/station-record.js — the station lifecycle's one module: whether a workspace holds a station is answered here.

   This first piece is a pure move out of workspace-lineage.js, unchanged: the prior-station evidence rule (the INFRA and
   quest-refresh bookkeeping exclusions, the STATE_EVIDENCE allowlist, meaningfulEntries), the one path rule (sameRoot:
   resolved, case-folded on Windows only) and the two lifecycle names. workspace-lineage.js re-imports them. */
'use strict';

// START FRESH / ERASE marker: the Commander chose a clean generation over prior evidence. Never itself "prior state".
const FRESH_MARKER = '.fresh-start.json';
const QUARANTINE_DIR = 'workspace-quarantine';

// The desktop migration transaction seals even an empty first-run generation with a receipt. The receipt is
// bookkeeping, not user state; any files it actually migrated are scanned independently below.
// E-STOP/scheduler bookkeeping is INFRA, never evidence: the desktop shell fires POST /api/halt on EVERY
// clean quit, which durably writes loops.halt.json + nightshift.state.json (+ cron.halt.json when armed)
// even on a station that was never created — so a fresh install that was merely opened and closed once
// carried "prior station evidence" and stranded on the recovery gate forever (2026-08-25). A file the
// sidecar can write WITHOUT a Commander having created a station must never count as a prior station.
const INFRA = /^(?:\.starnet-workspace-owner\.json|\.schema-version\.json(?:\.bak)?|\.migrated|\.migration-receipt\.json|cron\.lock|proc-ledger\.json|liveprices\.cache\.json|(?:cron\.halt|loops\.halt|nightshift\.state)\.json(?:\.bak)?)$/i;
// Quest-refresh bookkeeping is never evidence either (#123, 2026-10-17): the QUEST REFRESH boot look stamped its
// cadence + a 'skipped' note into _station.questrefresh.json (+ .bak) ~3 s after every boot, station or not, and the
// `_station.*` evidence family below read that as a prior station — open once, close once, Recovery Mode forever.
// Unlike INFRA it belongs to ONE station (a confirmed north star, staged quests), so START FRESH still quarantines it
// with that station rather than leaving it live to steer the next one.
const STATION_BOOKKEEPING = /^_station\.questrefresh\.json(?:\.bak)?$/i;
// Positive evidence only. The former "anything not on the infrastructure denylist" rule made every newly
// introduced cache/receipt a fake prior station. This covers the harness-owned durable authorities without
// treating an arbitrary future `*.cache.json` as proof that a Commander already created a station.
const STATE_EVIDENCE = /^(?:agent\.save\.json(?:\.bak|\.corrupt-\d+)?|agent\.roster\.json(?:\.bak)?|(?:transcript|ledger|runs|growth-ratings|skills|skillprefs|autonomy\.ledger|deliverables\.library)\.jsonl|(?:budget|fallback|station\.widgets|memory\.config|study\.state|projects|personalization|recommendations|task-briefs|threads|execution-settings|terminal-sessions|subagents|routing\.plan|toolsets|usercommands)\.json(?:\.bak)?|(?:skills-allowed|skill-registries|skill-exchange-metrics|permissions\.(?:allow|bypass)|hooks(?:-allowed)?|plugins-allowed|cron\.(?:jobs|armed)|loops|nightshift\.(?:drafts|learn|acts)|nightfocus\.state|scout\.(?:interests|state))\.json(?:\.bak)?|_(?:station|commander)\.[a-z0-9._-]+\.json(?:\.bak)?|[a-z0-9_-]+\.(?:notebook|todo|declined|minted|pending|workshop|deliverables)\.json(?:\.bak)?|.*\.starnet-(?:backup|recovery)\.json)$/i;

function meaningfulEntries(fs, path, root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    return fs.readdirSync(root).filter(name => {
      if (INFRA.test(name) || STATION_BOOKKEEPING.test(name)) return false;
      if (/\.tmp(?:\.|$)/i.test(name)) return false;
      if (name === '.browser-profile') return false;
      return STATE_EVIDENCE.test(name);
    }).slice(0, 40).map(name => ({ name, path: path.join(root, name) }));
  } catch (_) { return []; }
}
function bookkeepingEntries(fs, path, root) {
  try { return fs.readdirSync(root).filter(name => STATION_BOOKKEEPING.test(name)).map(name => ({ name, path: path.join(root, name) })); }
  catch (_) { return []; }
}

// THE ONE PATH RULE for "is this the same root": resolved, and case-folded on Windows only.
function sameRoot(a, b, path, platform) {
  const x = path.resolve(String(a)), y = path.resolve(String(b));
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

module.exports = { FRESH_MARKER, QUARANTINE_DIR, sameRoot, INFRA, STATION_BOOKKEEPING, STATE_EVIDENCE, meaningfulEntries, bookkeepingEntries };
