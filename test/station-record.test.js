/* node test/station-record.test.js — ONE durable lifecycle fact, ONE marker parser, ONE contract with the native door.

   sidecar/station-record.js is the only writer of <WORKSPACES>/.station.json: whether a workspace holds a station, was
   erased or was reset (B3: gh#123, gh#101, gh#65, bug 5451970e). This test drives it through the shared contract fixture
   test/fixtures/station-record-cases.json, which the native door's own test reads too
   (test/native-process-ownership/tests/station_contract.rs proves fresh_start.rs writes exactly the fixture's markers):
   - every lifecycle case: what read() derives and what each predicate answers; that read() writes nothing; what ensure()
     leaves on disk (it only ADDS .station.json: torn bytes are renamed aside, never deleted, and a newer build's record is
     never touched); that a second ensure() writes nothing; and that read() agrees with what ensure() persisted;
   - the one marker parser (every at dialect and shape) and the one Windows case-fold path rule;
   - P1 on a live view: a record never hides hard proof that appears later, and soft evidence never makes a station while a
     usable record decides;
   - the unattended writers' one predicate (station()) and the data-safety one (holdsStationData()), row by row;
   - found(): founding, idempotence, another writer's founding, torn bytes, and a write failure that keeps the record in
     charge and is retried;
   - the JS legacy mirror is field-identical to the native markers, and the reset and recovery builders write valid records
     that the next read accepts as they are;
   - proofBeyondReceipt: what a crash-interrupted activation may set aside is only what the shell's first-run migration
     copied in, byte for byte;
   - the frozen fallback is the rule workspace-lineage used, moved verbatim and declared once;
   - and the Rust half really runs: the contract test reads this fixture and the fast gate requires each test by name. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const SR = require('../sidecar/station-record.js');
const Lineage = require('../sidecar/workspace-lineage.js');
const { sidecarSourceFiles } = require('./helpers/source.js');

const ROOT = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'station-record-cases.json'), 'utf8'));
const NOW = 1793500000000;
const GEN = SR._internals.GENERATION_ID;
const RECORD = 'workspaces/.station.json';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-station-record-'));
let seq = 0;

function realParent(p) { try { return fs.realpathSync.native(p); } catch (_) { return p; } }
function subst(value, vars) {
  if (typeof value === 'string') return Object.keys(vars).reduce((s, k) => s.split(k).join(vars[k]), value);
  if (Array.isArray(value)) return value.map(v => subst(v, vars));
  if (value && typeof value === 'object') { const o = {}; for (const k of Object.keys(value)) o[k] = subst(value[k], vars); return o; }
  return value;
}
function fileBytes(spec, vars) {
  let text;
  if (typeof spec === 'string') text = spec;
  else if (spec.json !== undefined) text = JSON.stringify(subst(spec.json, vars), null, 2);
  else if (spec.native) text = JSON.stringify(subst(Object.assign({}, fixture.nativeMarkers[spec.native], spec.set || {}), vars), null, 2);
  else throw new Error('unknown file spec ' + JSON.stringify(spec));
  if (/\$[A-Z]/.test(text)) throw new Error('an unsubstituted placeholder in ' + text);
  return text;
}
function materialize(parent, files, vars) {
  for (const rel of Object.keys(files)) {
    const file = path.join(parent, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fileBytes(files[rel], vars));
  }
}
// every file under dir: forward-slash relative path -> base64 bytes
function snapshot(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = fs.readFileSync(path.join(d, e.name)).toString('base64');
    }
  })(dir, '');
  return out;
}
function bytesOf(snap, rel) { return snap[rel] === undefined ? undefined : Buffer.from(snap[rel], 'base64').toString('utf8'); }
function freshCase(label) {
  const parent = path.join(scratch, (++seq) + '-' + label);
  const ws = path.join(parent, 'workspaces');
  fs.mkdirSync(ws, { recursive: true });
  return { parent, ws, root: path.join(realParent(parent), 'workspaces') };
}
function deps(ws, extra) {
  let n = 0;
  const notes = [];
  return Object.assign({
    fs, path, platform: process.platform, now: () => NOW, workspaceRoot: ws,
    randomId: () => ('0000000' + (++n).toString(16)).slice(-8),
    failNote: (tag, e) => notes.push({ tag, error: String(e && (e.code || e.message) || e) }),
    notes
  }, extra || {});
}
function at(v) { return v === '$NOW' ? NOW : v; }
function withoutId(record) { const r = JSON.parse(JSON.stringify(record)); delete r.generationId; delete r.since; return r; }

/* ---- the lifecycle names and the carry rule, as the fixture states them ---- */
A.eq(SR.RECORD_FILE, fixture.recordFile, 'the record file');
A.eq(SR.FRESH_MARKER, fixture.freshMarker, 'the legacy marker file');
A.eq(SR.QUARANTINE_DIR, fixture.quarantineDir, 'the one place a set-aside generation is read from');
A.eq(Array.from(SR.LIFECYCLE_FILES), fixture.lifecycleFiles, 'LIFECYCLE_FILES: the files that never travel with station data');
A.eq(Array.from(SR.SEAL), fixture.seal, 'SEAL: what seals a clean generation');
A.eq(Array.from(SR.CARRY_ON_FRESH), fixture.carryOnFresh.files, 'CARRY_ON_FRESH: what START FRESH carries, through both doors');
A.eq(fixture.carryOnFresh.maxBytes, 64 * 1024, 'the carry rule\'s size bound is the native door\'s MAX_CREDITS_LINK_BYTES');
{
  const verdicts = new Set();
  for (const row of fixture.carryOnFresh.rows) {
    A.ok(typeof row.name === 'string' && ['file', 'dir', 'symlink', 'absent'].includes(row.kind) && ['carry', 'none', 'leave-aside'].includes(row.verdict), 'a carry row names its kind and verdict: ' + row.name);
    if (row.kind === 'file') A.ok(typeof row.text === 'string', 'a file row has its bytes: ' + row.name);
    verdicts.add(row.verdict);
  }
  A.eq(Array.from(verdicts).sort(), ['carry', 'leave-aside', 'none'], 'the carry rows cover every verdict');
}

/* ---- THE ONE MARKER PARSER ---- */
for (const row of fixture.markerDialects) {
  const got = SR.markerAt(row.at);
  A.eq(Number.isFinite(got) ? got : null, row.ms, 'markerAt reads ' + row.dialect);
  const parsed = SR.parseMarker(JSON.stringify({ version: 1, at: row.at, acknowledgedRoots: [] }));
  A.eq(parsed.status, row.ms === null ? 'torn' : 'ok', 'a marker whose at is ' + row.dialect + ' is ' + (row.ms === null ? 'torn' : 'valid'));
  if (row.ms !== null) A.eq(parsed.marker.at, row.ms, 'and its reset time is ' + row.ms);
}
for (const row of fixture.markerShapes) {
  const raw = row.raw !== undefined ? row.raw : JSON.stringify(row.native ? subst(fixture.nativeMarkers[row.native], { $QUARANTINE: '/q/station-1' }) : row.marker);
  A.eq(SR.parseMarker(raw).status, row.status, 'the one parser: ' + row.name);
}
A.eq(SR.parseMarker('{torn').salvage, { erased: false, acknowledgedRoots: [] }, 'torn bytes salvage nothing');

/* ---- THE ONE PATH RULE (workspace-lineage's sameRoot, now the module's): resolved, case-folded on Windows only ---- */
for (const row of fixture.acknowledgesRule) {
  const p = row.platform === 'win32' ? path.win32 : path.posix;
  A.eq(SR.sameRoot(row.acknowledged, row.root, p, row.platform), row.same, 'sameRoot on ' + row.platform + ': ' + row.acknowledged + ' vs ' + row.root);
}

/* ---- EVERY LIFECYCLE CASE ---- */
A.ok(fixture.cases.length >= 20, 'the fixture carries the lifecycle cases (' + fixture.cases.length + ')');
for (const c of fixture.cases) {
  const name = c.name;
  const k = freshCase('case');
  const vars = { $PARENT: k.parent, $ROOT: k.root };
  materialize(k.parent, c.files, vars);
  const caseIds = JSON.stringify(c.files).match(/g-[0-9a-z]+-[0-9a-f]{8}/g) || [];
  const own = c.files[RECORD];
  const keptId = own && own.json ? own.json.generationId : null;
  const d = deps(k.ws);
  const e = c.read;

  const before = snapshot(k.parent);
  const view = SR.read(d);
  A.eq(snapshot(k.parent), before, name + ': read() writes nothing');
  const r = view.record;
  A.eq(SR._internals.invalidRecord(r), null, name + ': read() yields a valid record');
  A.eq(r.generationId !== null, r.state === 'active', name + ': a generationId exists exactly while the station is active');
  A.eq(r.root, e.root !== undefined ? subst(e.root, vars) : k.root, name + ': the record names this workspace\'s canonical root');
  if ('state' in e) A.eq(r.state, e.state, name + ': state');
  if ('by' in e) A.eq(r.by, e.by, name + ': by');
  if ('generationId' in e) {
    if (e.generationId === null) A.eq(r.generationId, null, name + ': no generationId');
    else if (e.generationId === 'minted') A.ok(GEN.test(String(r.generationId)) && !caseIds.includes(r.generationId), name + ': a freshly minted generationId (' + r.generationId + ')');
    else if (e.generationId === 'kept') A.eq(r.generationId, keptId, name + ': the record keeps its generationId');
  }
  if ('reset' in e) A.eq(r.reset, e.reset === null ? null : Object.assign({}, e.reset, { at: at(e.reset.at) }), name + ': reset');
  if ('eraseAuthority' in e) A.eq(r.eraseAuthority, e.eraseAuthority, name + ': eraseAuthority');
  if ('acknowledgedRoots' in e) A.eq(r.acknowledgedRoots.map(x => path.resolve(x)), e.acknowledgedRoots.map(x => path.resolve(subst(x, vars))), name + ': acknowledgedRoots');
  if ('setAside' in e) A.eq(r.setAside === null ? null : path.resolve(r.setAside), e.setAside === null ? null : path.resolve(subst(e.setAside, vars)), name + ': setAside');
  if ('previous' in e) A.eq(r.previous ? r.previous.generationId : null, e.previous, name + ': previous');
  if ('derivedFrom' in e) A.eq(r.derivedFrom, e.derivedFrom, name + ': derivedFrom');
  if ('station' in e) A.eq(view.station(), e.station, name + ': station()');
  if ('holdsStationData' in e) A.eq(view.holdsStationData(), e.holdsStationData, name + ': holdsStationData()');
  if ('resetAt' in e) A.eq(view.resetAt(), at(e.resetAt), name + ': resetAt()');
  if (r.state === 'active') A.eq(view.station(), true, name + ': P1 — an active record is a station');
  A.eq(view.recordProblem, e.recordProblem === undefined ? null : e.recordProblem, name + ': recordProblem');
  for (const root of Object.keys(e.autoImport || {})) {
    const want = e.autoImport[root];
    A.eq(view.autoImportBlock(root || undefined), want, name + ': autoImportBlock(' + (root || 'no root') + ')');
    A.eq(view.blocksAutoImport(root || undefined), want !== null, name + ': blocksAutoImport(' + (root || 'no root') + ')');
  }

  // ensure(): only ever ADDS the record (and sets torn bytes aside); never moves or deletes anything else
  const ev = SR.ensure(d);
  const after = snapshot(k.parent);
  for (const rel of Object.keys(before)) {
    if (rel !== RECORD) A.eq(after[rel], before[rel], name + ': ensure() leaves ' + rel + ' byte-identical');
  }
  const allowed = [RECORD].concat((c.ensure.corrupt || []).map(n => 'workspaces/' + n));
  const added = Object.keys(after).filter(rel => !(rel in before));
  A.ok(added.every(rel => allowed.includes(rel)), name + ': ensure() adds nothing but the record: ' + added.join(', '));
  if (c.ensure.disk === 'written') {
    A.ok(RECORD in after, name + ': ensure() wrote the record');
    A.eq(JSON.parse(bytesOf(after, RECORD) || 'null'), ev.record, name + ': the record on disk is the view\'s record');
    A.eq([ev.persisted, ev.writeError, ev.usable], [true, null, true], name + ': persisted, no write error, in charge');
  } else {
    A.eq(after[RECORD], before[RECORD], name + ': ensure() leaves the record byte-identical');
  }
  for (const n of c.ensure.corrupt || []) A.eq(after['workspaces/' + n], before[RECORD], name + ': the torn bytes live on as ' + n);
  A.eq(withoutId(ev.record), withoutId(r), name + ': ensure() decides what read() decided');
  for (const root of Object.keys(c.ensure.autoImport || {})) A.eq(ev.autoImportBlock(root || undefined), c.ensure.autoImport[root], name + ': after ensure(), autoImportBlock(' + (root || 'no root') + ')');
  SR.ensure(d);
  A.eq(snapshot(k.parent), after, name + ': a second ensure() writes nothing');
  const again = SR.read(d);
  if (ev.persisted) A.eq(again.record, ev.record, name + ': read() returns what ensure() persisted');
  else A.eq(withoutId(again.record), withoutId(ev.record), name + ': read() derives what ensure() derived');
  if (c.ensure.found === 'memory') {
    ev.found({ by: 'save' });
    A.eq([ev.state, ev.persisted, ev.readOnly], ['active', false, true], name + ': found() lives in memory');
    A.eq(snapshot(k.parent)[RECORD], before[RECORD], name + ': found() never writes over a newer build\'s record');
  }
  A.eq(d.notes, [], name + ': no write failed');
}

/* ---- P1 ON A LIVE VIEW: the owner's view re-reads hard proof; soft evidence never makes a station under a usable record ---- */
{
  const k = freshCase('p1');
  const d = deps(k.ws);
  const live = SR.ensure(d);
  A.eq([live.state, live.persisted, live.station()], ['none', true, false], 'a fresh workspace records none');
  fs.writeFileSync(path.join(k.ws, 'autonomy.ledger.jsonl'), '{"source":"nightshift","kind":"decline"}\n');
  fs.writeFileSync(path.join(k.ws, 'scout.state.json'), '{}');
  A.eq(live.station(), false, 'soft evidence written after the record never makes a station (the gh#123 family)');
  A.eq(SR.read(d).station(), false, 'and a reader agrees');
  A.eq(live.holdsStationData(), true, 'but data-safety writers still see data worth protecting');
  for (const proof of ['agent.save.json', 'agent.save.json.bak', 'agent.save.json.corrupt-3', 'agent.roster.json', 'agent.roster.json.bak']) {
    fs.writeFileSync(path.join(k.ws, proof), 'not json');
    A.eq(live.station(), true, 'P1: ' + proof + ' (readable or not) is a station, whatever the record says');
    A.eq(SR.read(d).record.state, 'active', 'and a reader promotes the record in memory for ' + proof);
    fs.unlinkSync(path.join(k.ws, proof));
  }
  const bare = freshCase('p1-no-record');
  fs.writeFileSync(path.join(bare.ws, 'autonomy.ledger.jsonl'), '{}\n');
  const noRecord = SR.read(deps(bare.ws));
  fs.unlinkSync(path.join(bare.ws, 'autonomy.ledger.jsonl'));
  fs.writeFileSync(path.join(bare.ws, 'loops.json'), '{}');
  A.eq([noRecord.usable, noRecord.station()], [false, true], 'with no usable record the frozen fallback stays live');
  A.eq(live.acknowledges(path.join(k.parent, 'legacy')), false, 'a record acknowledges only its own roots');
  // what a reader shows and the CLI's first refusal: the fallback's listing (else the record itself), and P1's floor alone
  A.eq([live.holdsHardProof(), live.evidenceNames().sort()], [false, ['autonomy.ledger.jsonl', 'scout.state.json']], 'the names a reader shows are the fallback listing, even under a none record');
  fs.writeFileSync(path.join(k.ws, 'agent.roster.json.bak'), 'not json');
  A.eq([live.holdsHardProof(), live.station()], [true, true], 'holdsHardProof() is P1\'s floor: any save or roster name, readable or not');
  fs.unlinkSync(path.join(k.ws, 'agent.roster.json.bak'));
  const founded = freshCase('p1-record-only');
  const only = SR.ensure(deps(founded.ws));
  only.found({ by: 'save' });
  A.eq([only.station(), only.holdsHardProof(), only.evidenceNames()], [true, false, ['.station.json']], 'a station the record alone proves (its files gone) names the record');
}

/* ---- THE UNATTENDED WRITERS' ONE PREDICATE: the night shift, discovery and the quest refresh stand down while the owner's
   live view says !station(); update preparation keeps a recovery point while holdsStationData(). (These rows were
   workspace-lineage's hasStationState, the quest refresh's old gate, which read the same regex as the onboarding gate.) ---- */
{
  const k = freshCase('unattended');
  for (const f of ['_station.questrefresh.json', '_station.questrefresh.json.bak']) fs.writeFileSync(path.join(k.ws, f), '{"v":1,"state":{"lastCycleAt":1}}');
  const bare = SR.read(deps(k.ws));
  A.eq([bare.station(), bare.holdsStationData()], [false, false], 'quest-refresh bookkeeping alone is no station for background writers, and nothing to protect');
  const live = SR.ensure(deps(k.ws));
  A.eq([live.state, live.station()], ['none', false], 'the owner\'s live view of a bookkeeping-only workspace: none, so no unattended writer runs');
  for (const f of ['_station.quests.json', '_station.journey.json', '_commander.dossier.json', '_commander.goals.json', '_commander.autonomy.json']) {
    fs.writeFileSync(path.join(k.ws, f), '{}');
    // written under the live none record (WAKE's pre-save lock-downs, a scout push, cut short before the first save)
    A.eq(live.station(), false, f + ' written before any station is founded starts no unattended writer');
    A.eq(live.holdsStationData(), true, f + ' is still data a pre-update recovery point protects');
    // on disk before this build recorded anything (an older build's station): the first boot derives it active, the
    // never-orphan rule, so every background writer keeps running for it
    const older = freshCase('unattended-older');
    fs.writeFileSync(path.join(older.ws, f), '{}');
    A.eq([SR.read(deps(older.ws)).station(), SR.ensure(deps(older.ws)).station()], [true, true], f + ' from before the record is a station for background writers');
    fs.unlinkSync(path.join(k.ws, f));
  }
  live.found({ by: 'save' });
  A.eq([live.station(), live.holdsStationData()], [true, true], 'once the first accepted save founds the generation, every background writer runs');
}

/* ---- found() ---- */
{
  const k = freshCase('found');
  materialize(k.parent, { 'workspaces/.fresh-start.json': { native: 'erase' } }, {});
  const d = deps(k.ws);
  const live = SR.ensure(d);
  A.eq(live.state, 'erased', 'an erased generation');
  fs.writeFileSync(path.join(k.ws, 'agent.save.json'), '{}');
  live.found({ by: 'save' });
  const disk = JSON.parse(fs.readFileSync(path.join(k.ws, '.station.json'), 'utf8'));
  A.eq([live.state, live.record.by, live.persisted], ['active', 'save', true], 'the first accepted save founds the generation');
  A.ok(GEN.test(live.generationId), 'with a minted generationId');
  A.eq(disk, live.record, 'durably');
  A.eq([disk.reset && disk.reset.kind, disk.eraseAuthority, disk.acknowledgedRoots.length], ['erase', true, 2], 'founding keeps the reset and the auto-import facts');
  A.eq(live.publicView(), { state: 'active', generationId: live.generationId }, 'the additive API field');
  const snap = snapshot(k.parent);
  live.found({ by: 'save' });
  A.eq(snapshot(k.parent), snap, 'found() is idempotent: a founded, persisted generation writes nothing');
  A.throws(() => live.found({ by: 'whoever' }), 'found() refuses an unknown writer');
}
{
  const k = freshCase('found-race');
  let ownerWrites = 0;
  const counting = Object.create(fs);
  counting.renameSync = function (from, to) { if (/\.station\.json$/.test(String(to))) ownerWrites++; return fs.renameSync(from, to); };
  const owner = SR.ensure(deps(k.ws, { fs: counting }));
  A.eq(ownerWrites, 1, 'the owner recorded the fresh workspace');
  const cli = SR.read(deps(k.ws, { randomId: () => 'c0ffee00' }));
  cli.found({ by: 'cli-bootstrap' });
  A.eq([cli.state, cli.record.by, cli.persisted], ['active', 'cli-bootstrap', true], 'a read() view founds too (the CLI bootstrap)');
  owner.found({ by: 'save' });
  A.eq([owner.generationId, owner.record.by, owner.persisted], [cli.generationId, 'cli-bootstrap', true], 'a later found() adopts the generation another writer founded instead of minting another');
  A.eq(ownerWrites, 1, 'and writes nothing over it');
}
{
  const k = freshCase('found-torn');
  fs.writeFileSync(path.join(k.ws, 'agent.save.json'), '{}');
  fs.writeFileSync(path.join(k.ws, '.station.json'), '{"schema":"starnet.st');
  const v = SR.read(deps(k.ws));
  v.found({ by: 'cli-bootstrap' });
  A.eq([v.state, v.persisted], ['active', false], 'found() over torn bytes stays in memory');
  A.ok(/unreadable/.test(String(v.writeError)), 'and says why: ' + v.writeError);
  A.eq(fs.readFileSync(path.join(k.ws, '.station.json'), 'utf8'), '{"schema":"starnet.st', 'only the owner\'s ensure() sets torn bytes aside');
  const boot = SR.ensure(deps(k.ws));
  A.eq([boot.state, boot.persisted], ['active', true], 'the next boot sets them aside and records the station (P1: its save)');
  A.ok(fs.existsSync(path.join(k.ws, '.station.json.corrupt-1')), 'the torn bytes are kept as .station.json.corrupt-1');
}

/* ---- WRITE FAILURES NEVER FAIL A BOOT OR AN ACCEPTED SAVE ---- */
{
  const k = freshCase('write-fail');
  let deny = true;
  const failing = Object.create(fs);
  failing.renameSync = function (from, to) {
    if (deny && /\.station\.json$/.test(String(to))) { const e = new Error('fixture: denied'); e.code = 'EPERM'; throw e; }
    return fs.renameSync(from, to);
  };
  const d = deps(k.ws, { fs: failing });
  const live = SR.ensure(d);
  A.eq([live.state, live.persisted, live.usable], ['none', false, true], 'a failed boot write keeps the in-memory record in charge');
  A.ok(/could not write the station record: EPERM/.test(String(live.writeError)), 'and exposes the error: ' + live.writeError);
  A.eq(d.notes.map(n => n.tag), ['station.record.write'], 'through failNote');
  A.eq(fs.existsSync(path.join(k.ws, '.station.json')), false, 'nothing half-written');
  fs.writeFileSync(path.join(k.ws, 'agent.save.json'), '{}');
  live.found({ by: 'save' });
  A.eq([live.state, live.persisted], ['active', false], 'an accepted save still founds the station in memory');
  const id = live.generationId;
  deny = false;
  live.found({ by: 'save' });
  A.eq([live.persisted, live.writeError, live.generationId], [true, null, id], 'the next accepted save retries and persists the same generation');
  A.eq(live.publicView(), { state: 'active', generationId: id }, 'and the write error clears');
}
{
  const k = freshCase('torn-aside-fail');
  fs.writeFileSync(path.join(k.ws, '.station.json'), 'torn');
  const failing = Object.create(fs);
  // The shared quarantine now preserves exclusively, then unlinks the original only after the copy is durable.
  failing.unlinkSync = function (file) {
    if (String(file) === path.join(k.ws, '.station.json')) { const e = new Error('fixture: busy'); e.code = 'EBUSY'; throw e; }
    return fs.unlinkSync(file);
  };
  const d = deps(k.ws, { fs: failing });
  const v = SR.ensure(d);
  A.eq([v.persisted, v.recordProblem, v.autoImportBlock()], [false, 'torn', 'record-unreadable'], 'torn bytes that cannot be set aside are never written over');
  A.eq(fs.readFileSync(path.join(k.ws, '.station.json'), 'utf8'), 'torn', 'they stay byte-identical for the next boot');
  A.eq(d.notes.map(n => n.tag), ['station.record.write'], 'and the failure is noted');
}
A.throws(() => SR.read({ fs, path, workspaceRoot: scratch }), 'the clock is injected, never ambient');
A.throws(() => SR.read({ fs, path, now: () => NOW }), 'a reader names its workspace');

/* ---- THE WRITERS' BUILDERS AND THE LEGACY MIRROR ---- */
{
  const native = fixture.nativeMarkers;
  const k = freshCase('mirror');
  const q = path.join(k.parent, 'workspace-quarantine', 'station-1793400000000');
  const d = deps(k.ws);
  const resolved = native.acknowledgedRoots.map(r => path.resolve(r));
  // a START FRESH with no erase authority mirrors exactly the native START FRESH marker
  const fresh = SR.freshRecord(d, null, { at: native.nowMs, acknowledgedRoots: native.acknowledgedRoots, setAside: q });
  A.eq(SR._internals.invalidRecord(fresh), null, 'freshRecord builds a valid record');
  A.eq([fresh.state, fresh.generationId, fresh.by, fresh.reset, fresh.root], ['none', null, 'start-fresh', { kind: 'start-fresh', at: native.nowMs, source: 'record' }, k.root], 'START FRESH: none, a reset from now, this root');
  const mirror = SR.mirrorMarker(fresh, { quarantine: q, moved: [] });
  A.eq(Object.keys(mirror), native.keys, 'the JS mirror has the native marker\'s keys, in its order');
  A.eq(mirror, Object.assign(subst(native.startFresh, { $QUARANTINE: q }), { acknowledgedRoots: resolved }), 'and is field-identical to the native START FRESH marker');
  // an erase authority rides in the mirror as erased:true, the shape of the native ERASE marker
  const erased = SR.freshRecord(d, { eraseAuthority: true, acknowledgedRoots: [] }, { at: native.nowMs, acknowledgedRoots: native.acknowledgedRoots });
  A.eq(SR.mirrorMarker(erased), Object.assign({}, native.erase, { acknowledgedRoots: resolved }), 'a mirror keeps the erase authority for an older build, in the native ERASE marker\'s shape');
  // written: the one parser reads it back, its keys sit in order, and the next read accepts the pair as it is
  SR.writeRecord(d, k.ws, fresh);
  SR.writeMirror(d, k.ws, fresh, { quarantine: q, moved: [] });
  const text = fs.readFileSync(path.join(k.ws, '.fresh-start.json'), 'utf8');
  const positions = native.keys.map(key => text.indexOf('"' + key + '":'));
  A.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), 'the written mirror keeps the key order');
  const back = SR.parseMarker(text);
  A.eq([back.status, back.marker && back.marker.at, back.marker && back.marker.erased], ['ok', native.nowMs, false], 'the one parser reads the mirror back');
  const v = SR.read(d);
  A.eq([v.source, v.persisted, v.record], ['record', true, fresh], 'a record with its own mirror is not mistaken for an older build\'s reset');
  // explicit recovery: active, the reset cleared, the erase authority kept, the source root acknowledged
  const prior = Object.assign({}, fresh, { eraseAuthority: true });
  const source = path.join(k.parent, 'legacy', 'workspaces');
  const rec = SR.recoveryRecord(d, prior, { at: NOW, sourceRoot: source });
  A.eq(SR._internals.invalidRecord(rec), null, 'recoveryRecord builds a valid record');
  A.eq([rec.state, rec.by, rec.reset, rec.eraseAuthority], ['active', 'recovery', null, true], 'recovery: active, the reset cleared, the erase authority kept');
  A.ok(GEN.test(rec.generationId), 'with a generationId of its own');
  A.ok(rec.acknowledgedRoots.some(x => SR.sameRoot(x, source, path, process.platform)), 'the recovered source root is acknowledged');
  const k2 = freshCase('recovered');
  fs.writeFileSync(path.join(k2.ws, 'agent.save.json'), '{}');
  SR.writeRecord(deps(k2.ws), k2.ws, Object.assign({}, rec, { root: k2.root }));
  const rv = SR.read(deps(k2.ws));
  A.eq([rv.persisted, rv.resetAt(), rv.autoImportBlock(), rv.station()], [true, null, 'erase-authority', true], 'a recovered generation saves freely and still blocks auto import');
  A.throws(() => SR.writeRecord(d, k.ws, Object.assign({}, fresh, { state: 'active' })), 'writeRecord refuses an invalid record (active with no generationId)');
  A.eq(SR.read(d).record, fresh, 'and wrote nothing');
}

/* ---- proofBeyondReceipt: the save and roster files a first-run migration did not put there, byte for byte. A crash between an
   activation's two renames lets the desktop shell's migration run into the missing workspace first; what it imported may be
   set aside with the rest (workspace-recovery.js resumeActivation), a station anyone founded there never. ---- */
{
  const crypto = require('node:crypto');
  const dir = path.join(scratch, 'receipt-' + (++seq), 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  const d = { fs, path };
  const put = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  const receipt = files => put('.migration-receipt.json', JSON.stringify({ version: 1, validated: true, sourceRoots: ['x'], files }));
  const row = name => { const bytes = fs.readFileSync(path.join(dir, name)); return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; };
  A.eq(SR.proofBeyondReceipt(d, path.join(scratch, 'no-such-folder')), [], 'no folder: nothing founded');
  put('ledger.jsonl', 'soft\n');
  A.eq(SR.proofBeyondReceipt(d, dir), [], 'soft evidence is never a founding');
  put('agent.save.json', '{"doc":1}');
  put('agent.roster.json', '{"agents":[]}');
  A.eq(SR.proofBeyondReceipt(d, dir), ['agent.roster.json', 'agent.save.json'], 'with no receipt every save and roster file is unaccounted for');
  receipt([row('agent.save.json'), row('agent.roster.json')]);
  A.eq(SR.proofBeyondReceipt(d, dir), [], 'a receipt that lists them byte for byte accounts for them');
  put('agent.save.json', '{"doc":2}');
  A.eq(SR.proofBeyondReceipt(d, dir), ['agent.save.json'], 'a file changed since the copy is not the copy');
  put('agent.save.json.bak', '{"doc":1}');
  A.eq(SR.proofBeyondReceipt(d, dir), ['agent.save.json', 'agent.save.json.bak'], 'nor is one the receipt never listed');
  put('.migration-receipt.json', '{"files":');
  A.eq(SR.proofBeyondReceipt(d, dir).length, 3, 'a receipt that cannot be read accounts for nothing');
}

/* ---- THE FROZEN FALLBACK: today's rule, moved verbatim, declared once — and no longer re-exported by a reader ---- */
A.eq([Lineage._internals, Lineage.FRESH_MARKER], [undefined, undefined], 'workspace-lineage re-exports neither the fallback nor the marker name: it asks the record (test/station-record-readers.test.js)');
{
  const files = sidecarSourceFiles();
  const declaring = re => files.filter(f => re.test(f.text)).map(f => f.rel);
  for (const [what, re] of [
    ['STATE_EVIDENCE', /\bconst\s+STATE_EVIDENCE\s*=/], ['INFRA', /\bconst\s+INFRA\s*=/], ['STATION_BOOKKEEPING', /\bconst\s+STATION_BOOKKEEPING\s*=/],
    ['meaningfulEntries', /\bfunction\s+meaningfulEntries\s*\(/],
    ['sameRoot', /\bfunction\s+sameRoot\s*\(/]
  ]) A.eq(declaring(re), ['sidecar/station-record.js'], what + ' is declared once, in the record module');
  const src = files.find(f => f.rel === 'sidecar/station-record.js').text;
  A.ok(/require\('\.\/durable-write\.js'\)/.test(src) && !/\bwriteFileSync\s*\(/.test(src), 'every record write goes through durable-write.js');
  A.eq(/\b(?:unlinkSync|rmSync|rmdirSync)\s*\(/.test(src), false, 'the record module never deletes anything');
}

/* ---- THE RUST HALF RUNS: the native contract test reads this fixture, and the fast gate requires it by name ---- */
{
  const contract = fs.readFileSync(path.join(ROOT, 'test', 'native-process-ownership', 'tests', 'station_contract.rs'), 'utf8');
  A.ok(contract.includes('include_str!("../../fixtures/station-record-cases.json")'), 'the native contract test reads this same fixture');
  A.ok(contract.includes('use starnet_process_ownership_rules::fresh_start::{quarantine_and_prepare, set_aside_for_erase};'), 'and drives fresh_start.rs through its public API');
  const crate = fs.readFileSync(path.join(ROOT, 'test', 'native-process-ownership', 'src', 'lib.rs'), 'utf8');
  A.ok(/#\[path = "\.\.\/\.\.\/\.\.\/src-tauri\/src\/fresh_start\.rs"\]\s*pub mod fresh_start;/.test(crate), 'the rules crate compiles the shell\'s own fresh_start.rs');
  const gate = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'fast-gate.yml'), 'utf8');
  const lines = gate.slice(gate.indexOf('  rust-policy:')).split(/\r?\n/);
  const at = lines.findIndex(l => /^\s*for t in .*\bnative_erase_marker_matches_the_fixture\b/.test(l));
  A.ok(at > 0, 'the fast gate loops over the station contract tests');
  const required = at > 0 ? lines[at].trim().replace(/^for t in /, '').replace(/; do$/, '').split(/\s+/) : [];
  A.ok(at > 0 && lines[at + 1].includes('grep -Eq "^test $t \\.\\.\\. ok"'), 'and fails unless each one passed');
  const declared = (contract.match(/#\[test\]\s*fn\s+[a-z0-9_]+\s*\(/g) || []).map(m => /fn\s+([a-z0-9_]+)/.exec(m)[1]);
  A.ok(declared.length >= 4, 'the contract test has its tests (' + declared.length + ')');
  A.eq(required.slice().sort(), declared.slice().sort(), 'the gate requires every contract test by name');
}

fs.rmSync(scratch, { recursive: true, force: true });
A.report('station-record.test');
