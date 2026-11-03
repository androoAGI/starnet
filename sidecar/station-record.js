/* sidecar/station-record.js — THE STATION LIFECYCLE RECORD. Whether a workspace holds a station, was erased or was reset
   is ONE durable fact, <WORKSPACES>/.station.json, and this module is the only writer of it.

   WHY (B3 lifecycle: gh#123, gh#101, gh#65, bug 5451970e). "Is there a station here" was answered five ways that
   disagreed: workspace-lineage's STATE_EVIDENCE file-name allowlist (the onboarding gate, one rung per incident),
   hasStationState (the same regex, read by the quest refresh), two more parsers of .fresh-start.json (workspace-recovery,
   savestore) and the CLI's save/roster probe. Any background file that matched the regex trapped a fresh install in
   Recovery Mode, a torn marker refused every first save, and whether an ERASE kept its authority depended on which reader
   looked and which door had written the marker. This module holds the record, the ONE marker parser and the frozen
   fallback rule, and every reader asks it: the onboarding gate (workspace-lineage), automatic recovery
   (workspace-recovery), the save store's reset seed rule, the terminal (bin/starnet.js), every unattended writer (the
   night shift, discovery and the quest refresh stand down while !station(); test/stationless-boot-census.http.test.js
   is their completeness ratchet), the roster's one write path (held in RAM while !station(), so nothing but a founding ever
   writes hard proof) and update preparation (no recovery point only while !holdsStationData()).
   test/station-record-readers.test.js keeps it that way: no other file may name the lifecycle files, the fallback, or
   probe a save or roster file for existence.

   THE RECORD (schema 'starnet.station', version 1)
     root               canonical WORKSPACES: realpath(parent) + basename. A record that names another root was copied.
     state              'none' | 'active' | 'erased'
     generationId       'g-<base36 ms>-<8 hex>' while active, else null
     since, by          when the state began, and the writer that set it (BY)
     reset              null | { kind: 'start-fresh'|'erase', at: ms, source: 'record'|'marker', unreadable?: true }
                        THE SEED-REFUSAL FACT: a browser copy of a station founded before reset.at never re-seeds a
                        missing save file.
     eraseAuthority,    THE AUTO-IMPORT FACTS, kept apart from reset so an explicit recovery can clear the reset time
     acknowledgedRoots  without weakening auto-import blocking.
     setAside, previous best-effort lineage: where the last generation was set aside, and its generationId.
     derivedFrom        (derived records) the bounded evidence names the derive saw.

   P1 — THE RECORD ONLY ADDS EVIDENCE. A root holds a station iff the record says active, OR hard proof is on disk (any
   agent.save.json, .bak or .corrupt-N, or agent.roster.json(.bak), valid or not), OR there is no usable record and the
   frozen fallback finds evidence. The record decides only SOFT evidence (scheduler and preference bookkeeping, exactly the
   gh#123 family), so a stale none/erased record (an older build onboarded under it, a hand restore that missed the
   dotfile, a failed founding write) can never hide a real station. Every predicate here applies P1.

   API (every function takes an injected { fs, path, now, platform, randomId?, failNote?, workspaceRoot }):
     read(deps)          never writes. Parses the record; when it is absent, torn, unreadable or from a newer build, derives
                         one in memory from today's evidence. Applies the reconcile rules (below) in memory.
     ensure(deps)        the OWNER's boot write (after recovery and the owner claim): read(), then persist. It derives on the
                         first boot of this build, promotes, re-derives after an older build's reset, re-mints a copied
                         record and renames torn bytes aside to .station.json.corrupt-<n>. A newer-version record is read-
                         only: nothing writes, renames or deletes it.
     view.found({by})    marks the generation active and mints its generationId (the first accepted save; the CLI
                         bootstrap). Idempotent.
     view predicates     station() (P1), holdsHardProof() (P1's floor alone), holdsStationData() (station() or any fallback
                         evidence: for data-safety writers), blocksAutoImport(root) / autoImportBlock(root), resetAt() (null
                         or ms), acknowledges(root); evidenceNames() is what a reader shows as the station's files.
     freshRecord / recoveryRecord / mirrorMarker / writeRecord / writeMirror — the reset and recovery writers' builders.
     freshFacts(deps)    what a START FRESH request pins and its apply compares (workspace-recovery.js applyFreshRequest).
     proofBeyondReceipt(deps, dir)  the save and roster files in a generation that no first-run migration put there.
     carryInto(deps, from, stage)  THE CARRY RULE: what rides into START FRESH's clean generation, the same through both doors.

   RECONCILE (read() and ensure(), in this order)
     1. COPIED: the record names another root (the shell's first-run migration copies a legacy root's dotfiles) — re-mint
        the generationId (by 'copied', previous = the copied id), keeping the state and the auto-import facts.
     2. AN OLDER BUILD RESET THIS WORKSPACE: a legacy marker newer than reset.at, or any marker under a record with no reset —
        re-derive from that marker, never weakening eraseAuthority or the acknowledged list.
     3. HARD PROOF under a non-active record — promote it to active (by 'promoted'), keeping the reset and auto-import facts.

   WRITE FAILURES NEVER FAIL A BOOT OR AN ACCEPTED SAVE: ensure() and found() keep the in-memory record in charge, call
   failNote('station.record.write'), expose writeError on the view, and retry at the next boot or accepted save.

   THE NATIVE DOOR, BRIDGED. The desktop shell's START FRESH and ERASE (src-tauri/src/fresh_start.rs) write no record, only
   their .fresh-start.json marker. derive() reads it with the one parser, and for a marker whose quarantine field names a
   set-aside generation INSIDE <parent>/workspace-quarantine it carries that generation's eraseAuthority, acknowledged roots
   and generationId (as previous) from its record, or from its own marker when it has none. If that folder is gone the
   marker alone decides, as before. So a reset never weakens a prior one, through either door.
   test/fixtures/station-record-cases.json pins the markers both doors write, every derive verdict, SEAL and
   CARRY_ON_FRESH; test/station-record.test.js and test/native-process-ownership/tests/station_contract.rs both read it.

   Pure: fs, path, now, randomId and platform are injected (lint-determinism); every write goes through durable-write.js. */
'use strict';
const { createHash } = require('node:crypto');
const { writeFileDurable } = require('./durable-write.js');
const persist = require('./persist/index.js');
const { note: failopenNote } = require('./failopen.js');

const SCHEMA = 'starnet.station';
const VERSION = 1;
const RECORD_FILE = '.station.json';
// START FRESH / ERASE marker: the Commander chose a clean generation over prior evidence. Written by the native door
// (fresh_start.rs) and, as a legacy mirror for downgrades, by every JS reset writer. Never itself "prior state".
const FRESH_MARKER = '.fresh-start.json';
const MIGRATION_RECEIPT = '.migration-receipt.json';   // the shell's first-run migration lists what it copied, with hashes
const QUARANTINE_DIR = 'workspace-quarantine';
const STATES = Object.freeze(['none', 'active', 'erased']);
const BY = Object.freeze(['derived', 'promoted', 'copied', 'save', 'cli-bootstrap', 'recovery', 'start-fresh']);
const RESET_KINDS = Object.freeze(['start-fresh', 'erase']);
const RESET_SOURCES = Object.freeze(['record', 'marker']);
// The lifecycle files never travel with station data (recovery copies, bundles, update snapshots): one record per workspace.
const LIFECYCLE_FILES = Object.freeze([RECORD_FILE, FRESH_MARKER]);
// What seals a clean generation (fresh_start.rs MIGRATION_MARKER), and what START FRESH carries into it through both doors
// (fresh_start.rs CREDITS_LINK: the account link, so purchased credits survive the reset).
const SEAL = Object.freeze(['.migrated']);
const CARRY_ON_FRESH = Object.freeze(['.secrets/credits.json']);
const MAX_CARRY_BYTES = 64 * 1024;   // fresh_start.rs MAX_CREDITS_LINK_BYTES
const GENERATION_ID = /^g-[0-9a-z]{1,12}-[0-9a-f]{8}$/;
// HARD PROOF (P1): a save or roster file under any of its names, readable or not. The record can never talk a reader out of it.
const HARD_PROOF = new RegExp(String.raw`^(?:agent\.save\.json(?:\.bak|${persist.names.QUARANTINE_N_SOURCE})?|agent\.roster\.json(?:\.bak)?)$`, 'i');
const MAX_ROOTS = 256;
const MAX_DERIVED_FROM = 8;

/* ---- THE FROZEN FALLBACK: today's evidence rule, moved here verbatim from workspace-lineage.js. It is read only by derive,
   by P1's no-usable-record branch and by holdsStationData. No rung is ever added again: the record decides soft evidence. */

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
const STATE_EVIDENCE = new RegExp(String.raw`^(?:agent\.save\.json(?:\.bak|${persist.names.QUARANTINE_N_SOURCE})?|agent\.roster\.json(?:\.bak)?|(?:transcript|ledger|runs|growth-ratings|skills|skillprefs|autonomy\.ledger|deliverables\.library)\.jsonl|(?:budget|fallback|station\.widgets|memory\.config|study\.state|projects|personalization|recommendations|task-briefs|threads|execution-settings|terminal-sessions|subagents|routing\.plan|toolsets|usercommands)\.json(?:\.bak)?|(?:skills-allowed|skill-registries|skill-exchange-metrics|permissions\.(?:allow|bypass)|hooks(?:-allowed)?|plugins-allowed|cron\.(?:jobs|armed)|loops|nightshift\.(?:drafts|learn|acts)|nightfocus\.state|scout\.(?:interests|state))\.json(?:\.bak)?|_(?:station|commander)\.[a-z0-9._-]+\.json(?:\.bak)?|[a-z0-9_-]+\.(?:notebook|todo|declined|minted|pending|workshop|deliverables)\.json(?:\.bak)?|.*\.starnet-(?:backup|recovery)\.json)$`, 'i');

function meaningfulEntries(fs, path, root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    return fs.readdirSync(root).filter(name => {
      if (INFRA.test(name) || STATION_BOOKKEEPING.test(name)) return false;
      if (persist.names.isTemp(name)) return false;
      if (name === '.browser-profile') return false;
      return STATE_EVIDENCE.test(name);
    }).slice(0, 40).map(name => ({ name, path: path.join(root, name) }));
  } catch (_) { return []; }
}

// THE ONE PATH RULE for "is this the same root": resolved, and case-folded on Windows only.
function sameRoot(a, b, path, platform) {
  const x = path.resolve(String(a)), y = path.resolve(String(b));
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/* ---- small helpers ---- */
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return typeof v === 'string' && v.trim().length > 0; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function errText(e) { return String((e && (e.code || e.message)) || e); }
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function nowMs(ctx) { const t = Number(ctx.now()); return Number.isFinite(t) ? Math.floor(t) : 0; }
function uniq(names) { return names.filter((n, i) => names.indexOf(n) === i); }

// Resolved, de-duplicated (one path rule), bounded: the acknowledged-roots list every record carries.
function rootsOf(path, platform, list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!text(raw)) continue;
    const root = path.resolve(raw);
    if (!out.some(r => sameRoot(r, root, path, platform))) out.push(root);
    if (out.length >= MAX_ROOTS) break;
  }
  return out;
}

function defaultRandomId() {
  try { return require('node:crypto').randomBytes(4).toString('hex'); }
  catch (e) { return '00000000'; }   // never reached on node; the id is lineage, not a secret
}
function mintGenerationId(ctx) {
  const hex = (String(ctx.randomId() || '').toLowerCase().replace(/[^0-9a-f]/g, '') + '00000000').slice(0, 8);
  return 'g-' + Math.max(0, nowMs(ctx)).toString(36) + '-' + hex;
}

// canonical WORKSPACES: realpath(parent) + basename, so a junction/8.3/case spelling of the same parent is one root.
function canonicalRoot(fs, path, workspaceRoot) {
  const abs = path.resolve(String(workspaceRoot || ''));
  const parent = path.dirname(abs);
  let real = parent;
  try {
    const rp = fs && typeof fs.realpathSync === 'function' ? (fs.realpathSync.native || fs.realpathSync) : null;
    if (rp) real = rp(parent);
  } catch (e) { real = parent; }   // a parent that does not exist yet: its resolved spelling
  return path.join(real, path.basename(abs));
}

/* ---- THE ONE MARKER PARSER ----------------------------------------------------------------------------------------
   A valid .fresh-start.json is: version 1; acknowledgedRoots of non-empty strings; erased a boolean if present; and at as
   a number, digit text (the native door: epoch ms as text) or ISO text (the old sidecar door). Every real writer has
   always written all of those. Anything else is TORN: its reset time is unknown, so derive bounds it by the derive time
   (a station founded after that may save; a browser copy from before it is still refused) and auto import stays blocked.
   A torn marker's auto-import facts are SALVAGED only where they strengthen nothing wrongly: erased:true from any parseable
   object (an erase is never weakened), and the non-empty string roots of a version-1 array (what lineage acknowledged). */
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function markerAt(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : NaN;
  if (typeof v !== 'string') return NaN;
  if (/^\d{1,16}$/.test(v)) { const n = Number(v); return Number.isSafeInteger(n) ? n : NaN; }
  if (!ISO_AT.test(v)) return NaN;
  const t = Date.parse(v);
  return Number.isFinite(t) && t >= 0 ? t : NaN;
}
function salvageOf(v) {
  return {
    erased: isObj(v) && v.erased === true,
    acknowledgedRoots: isObj(v) && v.version === 1 && Array.isArray(v.acknowledgedRoots) ? v.acknowledgedRoots.filter(text).slice(0, MAX_ROOTS) : []
  };
}
function parseMarker(raw) {
  let v;
  try { v = JSON.parse(String(raw)); }
  catch (e) { return { status: 'torn', why: 'not JSON', salvage: salvageOf(null) }; }
  const torn = why => ({ status: 'torn', why, salvage: salvageOf(v) });
  if (!isObj(v) || v.version !== 1) return torn('version');
  if (!Array.isArray(v.acknowledgedRoots) || v.acknowledgedRoots.length > MAX_ROOTS || !v.acknowledgedRoots.every(text)) return torn('acknowledgedRoots');
  if (v.erased !== undefined && typeof v.erased !== 'boolean') return torn('erased');
  const at = markerAt(v.at);
  if (!Number.isFinite(at)) return torn('at');
  return { status: 'ok', marker: { erased: v.erased === true, at, acknowledgedRoots: v.acknowledgedRoots.slice(), quarantine: text(v.quarantine) ? v.quarantine : null } };
}
function readMarker(fs, path, dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, FRESH_MARKER), 'utf8'); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { status: 'absent' };
    return { status: 'torn', why: 'unreadable (' + errText(e) + ')', salvage: salvageOf(null) };
  }
  return parseMarker(raw);
}

/* ---- THE RECORD: strict parse. A future version is READ-ONLY (never written, renamed or deleted here); bytes that do not
   parse, or a v1 record that fails validation, are torn (ensure() alone renames them aside); an I/O error is unreadable
   (read-only: the bytes may be fine). Unknown extra fields of a valid v1 record are tolerated and not carried. */
function invalidReset(r) {
  if (!isObj(r)) return 'reset';
  if (RESET_KINDS.indexOf(r.kind) < 0) return 'reset.kind';
  if (!finite(r.at)) return 'reset.at';
  if (RESET_SOURCES.indexOf(r.source) < 0) return 'reset.source';
  if (r.unreadable !== undefined && r.unreadable !== true) return 'reset.unreadable';
  return null;
}
function invalidRecord(v) {
  if (!isObj(v) || v.schema !== SCHEMA) return 'schema';
  if (v.version !== VERSION) return 'version';
  if (!text(v.root)) return 'root';
  if (STATES.indexOf(v.state) < 0) return 'state';
  if (v.state === 'active' ? !(typeof v.generationId === 'string' && GENERATION_ID.test(v.generationId)) : v.generationId !== null) return 'generationId';
  if (!finite(v.since)) return 'since';
  if (BY.indexOf(v.by) < 0) return 'by';
  if (v.reset !== null) { const why = invalidReset(v.reset); if (why) return why; }
  if (typeof v.eraseAuthority !== 'boolean') return 'eraseAuthority';
  if (!Array.isArray(v.acknowledgedRoots) || v.acknowledgedRoots.length > MAX_ROOTS || !v.acknowledgedRoots.every(text)) return 'acknowledgedRoots';
  if (!(v.setAside === null || text(v.setAside))) return 'setAside';
  if (!(v.previous === null || (isObj(v.previous) && typeof v.previous.generationId === 'string' && GENERATION_ID.test(v.previous.generationId)))) return 'previous';
  if (v.derivedFrom !== undefined && !(Array.isArray(v.derivedFrom) && v.derivedFrom.length <= MAX_DERIVED_FROM && v.derivedFrom.every(text))) return 'derivedFrom';
  return null;
}
function normalizeRecord(v) {
  const out = {
    schema: SCHEMA, version: VERSION, root: v.root, state: v.state, generationId: v.state === 'active' ? v.generationId : null,
    since: v.since, by: v.by,
    reset: v.reset ? Object.assign({ kind: v.reset.kind, at: v.reset.at, source: v.reset.source }, v.reset.unreadable === true ? { unreadable: true } : {}) : null,
    eraseAuthority: v.eraseAuthority, acknowledgedRoots: v.acknowledgedRoots.slice(), setAside: v.setAside,
    previous: v.previous ? { generationId: v.previous.generationId } : null
  };
  if (Array.isArray(v.derivedFrom)) out.derivedFrom = v.derivedFrom.slice();
  return out;
}
function parseRecord(raw) {
  let v;
  try { v = JSON.parse(String(raw)); }
  catch (e) { return { status: 'torn', why: 'not JSON' }; }
  if (!isObj(v) || v.schema !== SCHEMA) return { status: 'torn', why: 'schema' };
  if (Number.isInteger(v.version) && v.version > VERSION) return { status: 'future', version: v.version };
  const why = invalidRecord(v);
  return why ? { status: 'torn', why } : { status: 'ok', record: normalizeRecord(v) };
}
function readRecordFile(fs, path, dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, RECORD_FILE), 'utf8'); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { status: 'absent' };
    return { status: 'unreadable', why: errText(e) };
  }
  return parseRecord(raw);
}

/* ---- DERIVE: the record today's evidence implies (the first boot of this build, and any read without a usable record).
   (a) the legacy marker through the one parser, plus the native door's carry from the generation it set aside;
   (b) state = active iff hard proof or any file today's STATE_EVIDENCE matches — exactly the workspaces today's gate
       protects, so the migration never releases a station (the never-orphan rule) — else erased for an erase, else none;
   (c) a generationId for active, by 'derived', with the bounded evidence names. derive never moves or deletes anything. */
function listing(fs, dir) {
  try { return { names: fs.readdirSync(dir), error: null }; }
  catch (e) { return { names: [], error: e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? null : errText(e) }; }
}
function hardProofNames(fs, dir) { return listing(fs, dir).names.filter(name => HARD_PROOF.test(name)); }

// the set-aside generation a marker names — accepted only as a direct child of <parent>/workspace-quarantine
function setAsideOf(ctx, quarantine) {
  if (!text(quarantine)) return null;
  const p = ctx.path, dir = p.resolve(quarantine), home = p.dirname(dir);
  const homes = [p.join(p.dirname(ctx.current), QUARANTINE_DIR), p.join(p.dirname(ctx.root), QUARANTINE_DIR)];
  return homes.some(h => sameRoot(home, h, p, ctx.platform)) ? dir : null;
}
// what a set-aside generation knew: its record, else its own marker; null when the folder is gone or holds neither
function priorGeneration(ctx, dir) {
  const rec = readRecordFile(ctx.fs, ctx.path, dir);
  if (rec.status === 'ok') return { eraseAuthority: rec.record.eraseAuthority, acknowledgedRoots: rec.record.acknowledgedRoots, generationId: rec.record.generationId };
  const m = readMarker(ctx.fs, ctx.path, dir);
  if (m.status === 'ok') return { eraseAuthority: m.marker.erased, acknowledgedRoots: m.marker.acknowledgedRoots, generationId: null };
  if (m.status === 'torn') return { eraseAuthority: m.salvage.erased, acknowledgedRoots: m.salvage.acknowledgedRoots, generationId: null };
  return null;
}
function markerFacts(ctx, read, since) {
  const p = ctx.path;
  if (read.status === 'absent') return { reset: null, eraseAuthority: false, acknowledgedRoots: [], setAside: null, previous: null };
  if (read.status === 'torn') {
    return {
      reset: { kind: read.salvage.erased ? 'erase' : 'start-fresh', at: since, source: 'marker', unreadable: true },
      eraseAuthority: read.salvage.erased, acknowledgedRoots: rootsOf(p, ctx.platform, read.salvage.acknowledgedRoots), setAside: null, previous: null
    };
  }
  const m = read.marker;
  const facts = {
    reset: { kind: m.erased ? 'erase' : 'start-fresh', at: m.at, source: 'marker' },
    eraseAuthority: m.erased, acknowledgedRoots: rootsOf(p, ctx.platform, m.acknowledgedRoots), setAside: setAsideOf(ctx, m.quarantine), previous: null
  };
  const prior = facts.setAside ? priorGeneration(ctx, facts.setAside) : null;
  if (prior) {
    facts.eraseAuthority = facts.eraseAuthority || prior.eraseAuthority === true;
    facts.acknowledgedRoots = rootsOf(p, ctx.platform, facts.acknowledgedRoots.concat(prior.acknowledgedRoots));
    if (prior.generationId) facts.previous = { generationId: prior.generationId };
  }
  return facts;
}
function deriveRecord(ctx) {
  const since = nowMs(ctx);
  const list = listing(ctx.fs, ctx.current);
  const facts = markerFacts(ctx, readMarker(ctx.fs, ctx.path, ctx.current), since);
  const evidence = uniq(list.names.filter(name => HARD_PROOF.test(name)).sort()
    .concat(meaningfulEntries(ctx.fs, ctx.path, ctx.current).map(e => e.name).sort()));
  const state = evidence.length ? 'active' : (facts.reset && facts.reset.kind === 'erase' ? 'erased' : 'none');
  const record = {
    schema: SCHEMA, version: VERSION, root: ctx.root, state,
    generationId: state === 'active' ? mintGenerationId(ctx) : null,
    since, by: 'derived', reset: facts.reset,
    eraseAuthority: facts.eraseAuthority, acknowledgedRoots: facts.acknowledgedRoots,
    setAside: facts.setAside, previous: facts.previous
  };
  if (evidence.length) record.derivedFrom = evidence.slice(0, MAX_DERIVED_FROM);
  return { record, inconclusive: list.error };
}

// RECONCILE rule 2's trigger: a marker this record has not seen. A stale mirror (older than the record's own reset) is not
// a newer reset; a torn marker under a reset that was already unreadable is the same marker.
function markerIsNewer(record, marker) {
  if (marker.status === 'absent') return false;
  const reset = record.reset;
  if (marker.status === 'torn') return !(reset && reset.unreadable === true);
  if (!reset || reset.unreadable === true) return true;
  return marker.marker.at > reset.at;
}
function reconcile(ctx, stored) {
  let r = clone(stored);
  const steps = [];
  let inconclusive = null;
  if (!sameRoot(r.root, ctx.root, ctx.path, ctx.platform)) {                         // 1. copied
    if (r.generationId) { r.previous = { generationId: r.generationId }; r.generationId = mintGenerationId(ctx); }
    r.root = ctx.root; r.by = 'copied'; r.since = nowMs(ctx);
    steps.push('copied');
  }
  if (markerIsNewer(r, readMarker(ctx.fs, ctx.path, ctx.current))) {                // 2. an older build's reset
    const d = deriveRecord(ctx);
    if (d.inconclusive) inconclusive = d.inconclusive;
    else {
      const next = d.record;
      next.eraseAuthority = r.eraseAuthority || next.eraseAuthority;
      next.acknowledgedRoots = rootsOf(ctx.path, ctx.platform, r.acknowledgedRoots.concat(next.acknowledgedRoots));
      if (!next.previous) next.previous = r.generationId ? { generationId: r.generationId } : r.previous;
      r = next;
      steps.push('reset');
    }
  }
  if (r.state !== 'active' && hardProofNames(ctx.fs, ctx.current).length) {           // 3. hard proof
    r.state = 'active'; r.generationId = mintGenerationId(ctx); r.by = 'promoted'; r.since = nowMs(ctx);
    delete r.derivedFrom;
    steps.push('promoted');
  }
  return { record: r, steps, inconclusive };
}

// the founding transition: active from now, a fresh generationId (a copied record's id becomes previous)
function activate(ctx, base, by) {
  const r = clone(base);
  const copied = !sameRoot(r.root, ctx.root, ctx.path, ctx.platform);
  if (r.state === 'active' && !copied) return r;
  if (r.generationId) r.previous = { generationId: r.generationId };
  r.root = ctx.root; r.state = 'active'; r.generationId = mintGenerationId(ctx); r.since = nowMs(ctx); r.by = by;
  delete r.derivedFrom;
  return r;
}

function context(deps) {
  const d = deps || {};
  if (!d.fs || typeof d.fs.readFileSync !== 'function' || typeof d.fs.readdirSync !== 'function') throw new TypeError('station-record: an injected fs is required');
  if (!d.path || typeof d.path.resolve !== 'function') throw new TypeError('station-record: an injected path is required');
  if (typeof d.now !== 'function') throw new TypeError('station-record: an injected now() is required');
  if (!text(d.workspaceRoot)) throw new TypeError('station-record: a workspaceRoot is required');
  const current = d.path.resolve(d.workspaceRoot);
  return {
    fs: d.fs, path: d.path, platform: String(d.platform || process.platform), now: d.now,
    randomId: typeof d.randomId === 'function' ? d.randomId : defaultRandomId,
    randomTmpId: typeof d.randomTmpId === 'function' ? d.randomTmpId : undefined,
    failNote: typeof d.failNote === 'function' ? d.failNote : failopenNote,
    current, root: canonicalRoot(d.fs, d.path, current)
  };
}

/* ---- WRITES: all through durable-write.js (temp + fsync + rename + dir fsync). */
function writeRecord(deps, dir, record) {
  const why = invalidRecord(record);
  if (why) throw new Error('station-record: refusing to write an invalid record (' + why + ')');
  writeFileDurable({ fs: deps.fs, path: deps.path, randomTmpId: deps.randomTmpId }, deps.path.join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + '\n');
}
// the legacy marker, in the native door's exact shape (fresh_start.rs FreshMarker), for a build that predates the record
function mirrorMarker(record, opts) {
  const o = opts || {};
  if (!isObj(record) || !isObj(record.reset)) throw new Error('station-record: the legacy mirror needs a record with a reset');
  return {
    version: 1,
    erased: record.eraseAuthority === true,
    at: String(Math.floor(record.reset.at)),
    acknowledgedRoots: (record.acknowledgedRoots || []).slice(),
    quarantine: text(o.quarantine) ? o.quarantine : null,
    moved: Array.isArray(o.moved) ? o.moved.map(String) : []
  };
}
function writeMirror(deps, dir, record, opts) {
  writeFileDurable({ fs: deps.fs, path: deps.path, randomTmpId: deps.randomTmpId }, deps.path.join(dir, FRESH_MARKER), JSON.stringify(mirrorMarker(record, opts), null, 2));
}
// ensure() alone preserves torn bytes under the first exclusive forensic name before replacing the record.
function setTornAside(ctx) {
  const file = ctx.path.join(ctx.current, RECORD_FILE);
  const moved = persist.moveAside({ fs: ctx.fs, path: ctx.path }, file, persist.names.LABELS.CORRUPT);
  if (moved.ok) return { ok: true, name: ctx.path.basename(moved.to) };
  const cause = moved.error || new Error('station-record: torn bytes could not be preserved');
  return { ok: false, error: errText(cause), cause };
}

/* ---- THE VIEW: one record and its predicates. index.js holds the owner's live view (ensure); readers take read() views. */
function makeView(ctx, init) {
  const s = Object.assign({ record: null, usable: false, readOnly: false, problem: null, persisted: false, writeError: null, source: 'derived' }, init);
  const fs = ctx.fs, p = ctx.path;
  const view = {
    get root() { return ctx.root; },
    get workspaceRoot() { return ctx.current; },
    get record() { return clone(s.record); },
    get state() { return s.record.state; },
    get generationId() { return s.record.generationId; },
    get usable() { return s.usable; },             // the record decides soft evidence (else the frozen fallback does)
    get readOnly() { return s.readOnly; },         // a newer build's record, or one that could not be read
    get recordProblem() { return s.problem; },     // null | 'torn' | 'future' | 'unreadable'
    get persisted() { return s.persisted; },
    get writeError() { return s.writeError; },
    get source() { return s.source; },
    // P1: active, or hard proof on disk, or (no usable record and) fallback evidence
    station() {
      if (s.record.state === 'active') return true;
      if (hardProofNames(fs, ctx.current).length) return true;
      return !s.usable && meaningfulEntries(fs, p, ctx.current).length > 0;
    },
    // P1's floor alone: a save or roster file under any of its names is on disk, readable or not (the CLI's first refusal)
    holdsHardProof() { return hardProofNames(fs, ctx.current).length > 0; },
    // for data-safety writers: a station, or anything today's rule calls station state
    holdsStationData() { return view.station() || meaningfulEntries(fs, p, ctx.current).length > 0; },
    // the bounded names a reader shows for this workspace's station state: the frozen fallback's listing (hard proof
    // included), else the record itself when it alone says a station was founded here
    evidenceNames() {
      const names = meaningfulEntries(fs, p, ctx.current).map(e => e.name);
      return names.length || s.record.state !== 'active' ? names : [RECORD_FILE];
    },
    acknowledges(root) { return text(root) && s.record.acknowledgedRoots.some(r => sameRoot(r, root, p, ctx.platform)); },
    // why automatic recovery must not import into this workspace (from `root`, when given): null when it may
    autoImportBlock(root) {
      if (s.problem) return 'record-unreadable';
      if (s.record.eraseAuthority) return 'erase-authority';
      if (s.record.reset && s.record.reset.unreadable === true) return 'reset-unreadable';
      if (text(root) && view.acknowledges(root)) return 'acknowledged';
      return null;
    },
    blocksAutoImport(root) { return view.autoImportBlock(root) !== null; },
    resetAt() { return s.record.reset ? s.record.reset.at : null; },
    /* FOUNDING. The first accepted save (savestore's onFounded) and the CLI bootstrap call this; it is idempotent. A newer
       build's record stays untouched (the founding lives in memory), torn bytes are left for the owner's ensure(), and a
       write failure keeps the in-memory record in charge and is retried at the next call or boot. */
    found(opts) {
      const by = opts && opts.by !== undefined ? opts.by : 'save';
      if (BY.indexOf(by) < 0) throw new TypeError('station-record: found() needs a known writer, got ' + JSON.stringify(by));
      if (s.record.state === 'active' && s.persisted) return view;
      if (s.readOnly) { s.record = activate(ctx, s.record, by); return view; }
      const disk = readRecordFile(fs, p, ctx.current);
      if (disk.status === 'future' || disk.status === 'unreadable') {
        s.readOnly = true; s.usable = false; s.problem = disk.status;
        s.record = activate(ctx, s.record, by);
        return view;
      }
      if (disk.status === 'torn') {
        s.problem = 'torn';
        s.record = activate(ctx, s.record, by);
        s.writeError = 'the station record on disk is unreadable; the next StarNet boot sets it aside and records this station';
        return view;
      }
      if (disk.status === 'ok' && disk.record.state === 'active' && sameRoot(disk.record.root, ctx.root, p, ctx.platform)) {
        s.record = disk.record; s.usable = true; s.persisted = true; s.writeError = null;   // another writer founded it
        return view;
      }
      const mine = s.record.state === 'active' && sameRoot(s.record.root, ctx.root, p, ctx.platform);
      const next = mine ? s.record : activate(ctx, disk.status === 'ok' ? disk.record : s.record, by);
      s.record = next; s.usable = true; s.problem = null;
      try { writeRecord(ctx, ctx.current, next); s.persisted = true; s.writeError = null; }
      catch (e) { s.persisted = false; s.writeError = 'could not write the station record: ' + errText(e); ctx.failNote('station.record.write', e); }
      return view;
    },
    // the additive /api/lineage + /api/save field
    publicView() {
      const out = { state: s.record.state, generationId: s.record.generationId };
      if (s.writeError) out.writeError = s.writeError;
      if (s.readOnly) out.readOnly = true;
      return out;
    }
  };
  return view;
}

/* read(deps): never writes. */
function read(deps) {
  const ctx = context(deps);
  const disk = readRecordFile(ctx.fs, ctx.path, ctx.current);
  if (disk.status === 'ok') {
    const rec = reconcile(ctx, disk.record);
    return makeView(ctx, { record: rec.record, usable: !rec.inconclusive, persisted: !rec.steps.length, source: rec.steps.length ? rec.steps.join('+') : 'record' });
  }
  const derived = deriveRecord(ctx);
  return makeView(ctx, {
    record: derived.record, usable: false, persisted: false,
    readOnly: disk.status === 'future' || disk.status === 'unreadable',
    problem: disk.status === 'absent' ? null : disk.status,
    source: disk.status === 'absent' ? 'derived' : disk.status
  });
}

/* ensure(deps): the owner's best-effort boot write. Never throws for a write; never fails the boot. */
function ensure(deps) {
  const ctx = context(deps);
  const disk = readRecordFile(ctx.fs, ctx.path, ctx.current);
  if (disk.status === 'future' || disk.status === 'unreadable') {
    return makeView(ctx, { record: deriveRecord(ctx).record, usable: false, readOnly: true, problem: disk.status, source: disk.status });
  }
  let record, source, problem = null, writeError = null, mayWrite = true, usable = true;
  if (disk.status === 'ok') {
    const rec = reconcile(ctx, disk.record);
    if (rec.inconclusive) {
      return makeView(ctx, { record: rec.record, usable: false, persisted: false, source: 'record',
        writeError: 'the workspace could not be listed (' + rec.inconclusive + '); the station record was left as it was' });
    }
    if (!rec.steps.length) return makeView(ctx, { record: rec.record, usable: true, persisted: true, source: 'record' });
    record = rec.record; source = rec.steps.join('+');
  } else {
    if (disk.status === 'torn') {
      const aside = setTornAside(ctx);
      if (!aside.ok) {
        mayWrite = false; problem = 'torn';
        writeError = 'could not set the unreadable station record aside: ' + aside.error;
        ctx.failNote('station.record.write', aside.cause);
      }
    }
    const d = deriveRecord(ctx);
    record = d.record; source = 'derived';
    if (d.inconclusive) {
      mayWrite = false; usable = false;
      writeError = writeError || ('the workspace could not be listed (' + d.inconclusive + '); the station record was not written');
    }
  }
  let persisted = false;
  if (mayWrite) {
    try { writeRecord(ctx, ctx.current, record); persisted = true; }
    catch (e) { writeError = 'could not write the station record: ' + errText(e); ctx.failNote('station.record.write', e); }
  }
  return makeView(ctx, { record, usable, persisted, problem, writeError, source });
}

function found(deps, opts) { return read(deps).found(opts); }

/* ---- the reset and recovery writers' builders (the record each writes into its stage). ---- */
function builderRoot(deps, opts) {
  if (text(opts.root)) return opts.root;
  if (!text(deps.workspaceRoot)) throw new TypeError('station-record: a record builder needs the canonical root or the workspaceRoot');
  return canonicalRoot(deps.fs, deps.path, deps.workspaceRoot);
}
function previousOf(prior) {
  if (!isObj(prior)) return null;
  if (typeof prior.generationId === 'string' && GENERATION_ID.test(prior.generationId)) return { generationId: prior.generationId };
  return isObj(prior.previous) && typeof prior.previous.generationId === 'string' && GENERATION_ID.test(prior.previous.generationId)
    ? { generationId: prior.previous.generationId } : null;
}
// START FRESH's clean generation: none, a reset from now, the erase authority carried and the acknowledged roots unioned
function freshRecord(deps, prior, opts) {
  const o = opts || {}, p = deps.path, platform = String(deps.platform || process.platform);
  const at = Math.floor(Number(o.at !== undefined ? o.at : deps.now()));
  const base = isObj(prior) ? prior : {};
  return {
    schema: SCHEMA, version: VERSION, root: builderRoot(deps, o), state: 'none', generationId: null, since: at, by: 'start-fresh',
    reset: { kind: 'start-fresh', at, source: 'record' },
    eraseAuthority: base.eraseAuthority === true,
    acknowledgedRoots: rootsOf(p, platform, (Array.isArray(base.acknowledgedRoots) ? base.acknowledgedRoots : []).concat(o.acknowledgedRoots || [])),
    setAside: text(o.setAside) ? p.resolve(o.setAside) : null,
    previous: previousOf(base)
  };
}
// an explicit recovery's generation: the recovered station is active and predates any reset here, so the reset is cleared;
// the erase authority stays and the source root is acknowledged — with every other root the recovery chose among
// (opts.acknowledgedRoots), so a root the Commander did not pick never becomes the one automatic candidate later
function recoveryRecord(deps, prior, opts) {
  const o = opts || {}, p = deps.path, platform = String(deps.platform || process.platform);
  const at = Math.floor(Number(o.at !== undefined ? o.at : deps.now()));
  const mint = { now: () => at, randomId: typeof deps.randomId === 'function' ? deps.randomId : defaultRandomId };
  const base = isObj(prior) ? prior : {};
  return {
    schema: SCHEMA, version: VERSION, root: builderRoot(deps, o), state: 'active', generationId: mintGenerationId(mint), since: at, by: 'recovery',
    reset: null,
    eraseAuthority: base.eraseAuthority === true,
    acknowledgedRoots: rootsOf(p, platform, (Array.isArray(base.acknowledgedRoots) ? base.acknowledgedRoots : [])
      .concat(text(o.sourceRoot) ? [o.sourceRoot] : []).concat(Array.isArray(o.acknowledgedRoots) ? o.acknowledgedRoots : [])),
    setAside: text(o.setAside) ? p.resolve(o.setAside) : null,
    previous: previousOf(base)
  };
}

/* ---- START FRESH: what a request pins, and what rides into the clean generation. ---- */

// the names a request always pins, there or not: a save that APPEARS after the request is the stale case that matters most
const PINNED_FILES = Object.freeze(['agent.save.json', 'agent.save.json.bak', 'agent.roster.json', 'agent.roster.json.bak']);
function pinOf(fs, file) {
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'absent' : 'unreadable'; }
  return createHash('sha256').update(bytes).digest('hex');
}
/* freshFacts(deps): the workspace as a START FRESH request saw it, and as its apply must find it. A workspace that moved
   under a request is never set aside: another build onboarded here, a save came back, or another reset ran. An older build
   ignores a pending request, so these facts are what the next new-build boot compares. Only a persisted generationId can
   pin: read() mints a derived record's id anew on every call. A save or roster file that cannot be read pins as 'unreadable':
   START FRESH is the exit from a workspace in that state, so it never refuses over one. */
function freshFacts(deps) {
  const ctx = context(deps);
  const view = read(deps);
  const marker = readMarker(ctx.fs, ctx.path, ctx.current);
  const pinned = {};
  for (const name of uniq(PINNED_FILES.concat(hardProofNames(ctx.fs, ctx.current))).sort()) pinned[name] = pinOf(ctx.fs, ctx.path.join(ctx.current, name));
  return {
    expectedState: view.state, expectedGenerationId: view.persisted ? view.generationId : null, pinned,
    markerAt: marker.status === 'absent' ? null : (marker.status === 'ok' ? marker.marker.at : 'torn')
  };
}

/* proofBeyondReceipt: the save and roster files in a generation that are not, byte for byte, what the shell's first-run
   migration copied in (main.rs migrate_workspace_data, which runs before any sidecar and into any workspace with no seal).
   Empty means nobody has founded anything here. */
function proofBeyondReceipt(deps, dir) {
  const fs = deps.fs, p = deps.path;
  let files = [];
  try {
    const receipt = JSON.parse(fs.readFileSync(p.join(dir, MIGRATION_RECEIPT), 'utf8'));
    if (isObj(receipt) && Array.isArray(receipt.files)) files = receipt.files;
  } catch (e) { files = []; }
  return hardProofNames(fs, dir).filter(name => {
    const row = files.find(f => isObj(f) && f.path === name);
    return !row || row.sha256 !== pinOf(fs, p.join(dir, name));
  });
}

/* THE CARRY RULE, one rule through both doors (test/fixtures/station-record-cases.json; fresh_start.rs preserve_credits_link
   is the native half). A file in CARRY_ON_FRESH rides into the clean generation when it is a regular file of at most
   MAX_CARRY_BYTES holding a JSON object. Anything else stays in the set-aside generation, which keeps its bytes either way:
   the clean generation starts unlinked and the caller says so. An unreadable money record never blocks the reset. */
function carryVerdict(fs, file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? { verdict: 'none' } : { verdict: 'leave-aside', why: errText(e) }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { verdict: 'leave-aside', why: 'not a regular file' };
  if (stat.size > MAX_CARRY_BYTES) return { verdict: 'leave-aside', why: 'larger than ' + MAX_CARRY_BYTES + ' bytes' };
  let bytes, value;
  // strict UTF-8 with the BOM kept, so a byte sequence serde_json refuses on the native door is refused here too
  try { bytes = fs.readFileSync(file); value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch (e) { return { verdict: 'leave-aside', why: 'not readable JSON' }; }
  return isObj(value) ? { verdict: 'carry', bytes } : { verdict: 'leave-aside', why: 'not a JSON object' };
}
function carryInto(deps, from, stage) {
  const p = deps.path, leftAside = [], carried = [];
  for (const rel of CARRY_ON_FRESH) {
    const parts = rel.split('/');
    const verdict = carryVerdict(deps.fs, p.join(from, ...parts));
    if (verdict.verdict === 'leave-aside') leftAside.push({ file: rel, why: verdict.why });
    if (verdict.verdict !== 'carry') continue;
    const target = p.join(stage, ...parts);
    deps.fs.mkdirSync(p.dirname(target), { recursive: true });
    writeFileDurable({ fs: deps.fs, path: p, randomTmpId: deps.randomTmpId }, target, verdict.bytes);
    carried.push(rel);
  }
  return { carried, leftAside };
}

module.exports = {
  SCHEMA, VERSION, RECORD_FILE, FRESH_MARKER, QUARANTINE_DIR, LIFECYCLE_FILES, SEAL, CARRY_ON_FRESH, BY,
  read, ensure, found,
  freshRecord, recoveryRecord, mirrorMarker, writeRecord, writeMirror, freshFacts, proofBeyondReceipt, carryInto,
  parseMarker, parseRecord, markerAt, sameRoot, canonicalRoot,
  INFRA, STATION_BOOKKEEPING, STATE_EVIDENCE, meaningfulEntries,
  _internals: { deriveRecord, reconcile, invalidRecord, mintGenerationId, hardProofNames, setAsideOf, context, HARD_PROOF, GENERATION_ID }
};
