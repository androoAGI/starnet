/* node test/transcript-row-identity.test.js — a transcript rowId names ONE row, on every boot path (turn-identity commit 1).

   Every copy of a turn is going to be matched by (streamId, rowId), so the durable io must never mint an id it cannot
   prove unused. Trunk could reissue one three ways: the degraded init (`manifest = freshManifest()`: rowId 1, appended
   into closed segment-000001), a healthy boot whose active segment could not be read (its max taken as 0), and an
   acknowledged row damaged or cut away on disk (the parse max fell below it). This file drives the REAL segmented io
   and the REAL store on temp dirs, through injected fs faults, and checks: the proven floor and its lease (§2.1 items
   1-4), unsafe mode and its 30 s re-probe, the boot collision audit (item 5), the additive row fields (buildEntry),
   the in-memory io, findTurn's four rungs, the vouched history read and TurnKinds' pure helpers.

   Every leg runs on its own (a leg that throws fails by name, the others still run), so on a tree without this commit
   each leg fails at its own assertion. Controls (pass on trunk too): 2f, 2k (b), the buildEntry byte-identity checks
   and the vouch-less history reference. Every test here is a ratchet (commit 1 closes nothing). */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require('./_assert.js');
const History = require('../sidecar/transcript-history.js');
const StoreModule = require('../sidecar/transcriptstore.js');
const { makeSegmentedTranscriptIo } = History;
const { makeTranscriptStore } = StoreModule;
let TurnKinds = null;
try { TurnKinds = require('../frontend/app/turnkinds.js'); } catch (e) { A.ok(false, 'frontend/app/turnkinds.js loads: ' + (e && e.message)); }

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-row-identity-'));
let dirs = 0;
const freshRoot = () => path.join(BASE, 'h' + (++dirs));
const SEG = n => 'segment-' + String(n).padStart(6, '0') + '.jsonl';
const IDX = n => 'segment-' + String(n).padStart(6, '0') + '.index.json';
const MINUTE = 60 * 1000;
const T = 'tTURNabcdef0123456789xyz';   // a desk-shaped turnId

function leg(name, fn) {
  try { fn(); } catch (e) { A.ok(false, name + ': the leg threw ' + ((e && e.stack) || e)); }
}
function open(root, extra) { return makeSegmentedTranscriptIo(Object.assign({ fs, path, root }, extra || {})); }
function segNumbers(root) {
  return fs.readdirSync(root).map(n => /^segment-(\d{6})\.jsonl$/.exec(n)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
}
function parseLine(line) {
  if (!line.trim()) return null;
  try { const r = JSON.parse(line); return r && r.rowId > 0 ? r : null; } catch (_) { return null; /* a damaged line is not a row */ }
}
function rowsOn(root) {
  const out = [];
  for (const n of segNumbers(root)) for (const line of fs.readFileSync(path.join(root, SEG(n)), 'utf8').split('\n')) {
    const r = parseLine(line);
    if (r) out.push(Object.assign({ seg: n }, r));
  }
  return out;
}
const idsOn = root => rowsOn(root).map(r => r.rowId);
const maxOf = list => list.reduce((m, v) => Math.max(m, v), 0);
function snapshot(root) {
  const out = {};
  for (const name of fs.readdirSync(root).sort()) {
    const p = path.join(root, name);
    if (fs.statSync(p).isFile()) out[name] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}
function codeOf(fn) {
  try { fn(); return 'no throw'; } catch (e) { return (e && e.code) || ('threw: ' + ((e && e.message) || e)); }
}
function tryAppend(io, entry) { try { return io.appendDurable(entry); } catch (e) { return null; } }
function lineFor(id, sid, content, ts) { return JSON.stringify({ streamId: sid, agentId: 'a', role: 'user', content, ts, rowId: id }) + '\n'; }
// an fs whose ensureRoot (mkdirSync) fails ONCE: init() throws, every segment file stays readable
function initFails() {
  let first = true;
  const f = Object.create(fs);
  f.mkdirSync = (...a) => { if (first) { first = false; const e = new Error('EPERM: simulated init failure'); e.code = 'EPERM'; throw e; } return fs.mkdirSync(...a); };
  return f;
}
// overwrite whole lines in place with same-length garbage, keeping each newline
function garble(file, lineIndexes) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const i of lineIndexes) lines[i] = '#'.repeat(Buffer.byteLength(lines[i]));
  fs.writeFileSync(file, lines.join('\n'));
  A.eq(fs.statSync(file).size, Buffer.byteLength(text), 'fixture: the garbled file keeps its size');
}
function fillSegments(io, root, count, sid, bodyLen) {
  let i = 0;
  while (segNumbers(root).length < count) io.appendDurable({ streamId: sid || 's', role: 'user', content: 'row ' + (i++) + ' ' + 'x'.repeat(bodyLen || 80), ts: 1000 + i });
  return i;
}
function removeLease(root) { fs.rmSync(path.join(root, 'rowid-lease.json'), { force: true }); }
const unproven = (warnings, n) => warnings.some(w => w.indexOf(SEG(n)) >= 0 && /unproven/.test(w));

try {
  // ---- 1. degraded init over existing closed segments ------------------------------------------------------------
  leg('1', () => {
    const root = freshRoot();
    const io = open(root, { segmentBytes: 700 });
    fillSegments(io, root, 3);
    io.close();
    const oldIds = idsOn(root), oldSegs = segNumbers(root), before = snapshot(root);
    const dio = open(root, { fs: initFails(), segmentBytes: 700, onWarning: () => {} });
    A.eq(dio.status().degraded, true, '1: the injected init failure degrades the boot');
    const added = [];
    for (let k = 0; k < 4; k++) added.push(tryAppend(dio, { streamId: 'd', role: 'user', content: 'degraded row ' + k, ts: 5000 + k }));
    dio.close();
    A.ok(added.every(Boolean), '1: the degraded boot appends (every segment proved its ids)');
    const got = added.filter(Boolean);
    A.ok(got.length && got.every(r => r.rowId > maxOf(oldIds)), '1: every rowId the degraded boot minted is above every old rowId (got ' + got.map(r => r.rowId).join(',') + ', old max ' + maxOf(oldIds) + ')');
    const landed = rowsOn(root).filter(r => r.streamId === 'd').map(r => r.seg);
    A.ok(landed.length === got.length && landed.every(n => n > maxOf(oldSegs)), '1: the new rows land in a segment numbered above every old one (' + landed.join(',') + ' vs ' + oldSegs.join(',') + ')');
    const after = snapshot(root);
    A.eq(oldSegs.map(n => after[SEG(n)]), oldSegs.map(n => before[SEG(n)]), '1: the old segment files are byte-identical');
    const hio = open(root, { segmentBytes: 700 });
    for (const r of got) {
      const back = hio.readById(r.rowId);
      A.ok(back && back.streamId === 'd' && back.content === r.content, '1: a healthy re-open serves degraded row ' + r.rowId + ' by readById (got ' + JSON.stringify(back && back.content) + ')');
    }
    const old = hio.readById(oldIds[0]);
    A.ok(old && old.streamId === 's' && /^row 0 /.test(old.content), '1: and the oldest row still by its own id');
    const next = hio.appendDurable({ streamId: 'd', role: 'user', content: 'after the degraded boot', ts: 9000 });
    A.ok(next.rowId > maxOf(got.map(r => r.rowId)), '1: the healthy re-open continues the ids monotonically (' + next.rowId + ')');
    hio.close();
  });

  // ---- 1b. mixed boots: healthy, healthy, degraded, healthy (the stranded tail is re-indexed) ----------------------
  leg('1b', () => {
    const root = freshRoot();
    const written = [];
    const write = (io, tag, n) => { for (let k = 0; k < n; k++) written.push(io.appendDurable({ streamId: 's', role: 'user', content: tag + ' ' + k, ts: 100 + written.length })); io.close(); };
    write(open(root), 'first boot', 3);
    write(open(root), 'second boot', 3);
    const dio = open(root, { fs: initFails(), onWarning: () => {} });
    for (let k = 0; k < 3; k++) { const r = tryAppend(dio, { streamId: 's', role: 'user', content: 'degraded boot ' + k, ts: 100 + written.length }); if (r) written.push(r); }
    dio.close();
    A.eq(written.length, 9, '1b: all three boots appended');
    const hio = open(root);
    const wrong = written.filter(r => { const b = hio.readById(r.rowId); return !b || b.content !== r.content; }).map(r => r.rowId + ':' + r.content);
    A.eq(wrong, [], '1b: readById serves every row of every boot with its own content');
    A.eq(hio.history('s', { limit: 50 }).map(r => r.content), written.map(r => r.content), '1b: history serves every row, the degraded boot\'s included, in order');
    A.eq(new Set(written.map(r => r.rowId)).size, written.length, '1b: no rowId was minted twice');
    hio.close();
  });

  // ---- 2. degraded init whose root cannot be listed: unsafe mode ---------------------------------------------------
  leg('2', () => {
    const root = freshRoot();
    const io = open(root);
    io.appendDurable({ streamId: 's', role: 'user', content: 'before', ts: 1 });
    io.close();
    const f = initFails();
    f.readdirSync = () => { const e = new Error('EACCES: simulated unlistable root'); e.code = 'EACCES'; throw e; };
    const warnings = [];
    const dio = open(root, { fs: f, onWarning: m => warnings.push(m) });
    const before = snapshot(root);
    A.eq(codeOf(() => dio.appendDurable({ streamId: 's', role: 'user', content: 'refused', ts: 2 })), 'TRANSCRIPT_DEGRADED_UNSAFE', '2: appendDurable throws TRANSCRIPT_DEGRADED_UNSAFE when the root cannot be listed');
    A.eq(snapshot(root), before, '2: the refused append writes no byte');
    A.ok(warnings.some(w => /could not be listed/.test(w)), '2: the warning says the root could not be listed');
    const store = makeTranscriptStore({ io: dio, clock: { now: () => 3 } });
    const kept = store.append({ streamId: 's', role: 'user', content: 'kept in RAM' });
    A.ok(kept && kept.content === 'kept in RAM' && kept.rowId === undefined, '2: a fail-open store.append keeps a RAM-only row without a rowId (got rowId ' + (kept && kept.rowId) + ')');
    dio.close();
  });

  // ---- 2b. the active segment unreadable (no manifest, its index absent): refused, then re-proven 30 s later --------
  function unreadableActive(name, setup) {
    const root = freshRoot();
    const io = open(root, { segmentBytes: 600 });
    fillSegments(io, root, 3);
    if (setup) setup(io);
    for (let k = 0; k < 2; k++) io.appendDurable({ streamId: 's', role: 'user', content: 'active row ' + k, ts: 3000 + k });
    io.close();
    const active = maxOf(segNumbers(root));
    fs.rmSync(path.join(root, 'manifest.json'));
    A.ok(!fs.existsSync(path.join(root, IDX(active))) && fs.existsSync(path.join(root, IDX(active - 1))), name + ' fixture: the active segment has no index file, the older ones do');
    return { root, active };
  }
  function brokenRead(fileName) {
    const ctl = { broken: true, reads: 0 };
    const f = Object.create(fs);
    f.readFileSync = (file, ...rest) => {
      if (ctl.broken && path.basename(String(file)) === fileName) { ctl.reads++; const e = new Error('EBUSY: simulated scanner lock'); e.code = 'EBUSY'; throw e; }
      return fs.readFileSync(file, ...rest);
    };
    return { f, ctl };
  }
  leg('2b', () => {
    const { root, active } = unreadableActive('2b');
    const onDisk = idsOn(root), oldSegs = segNumbers(root);
    const { f, ctl } = brokenRead(SEG(active));
    let t = 1000;
    const warnings = [];
    const io = open(root, { fs: f, segmentBytes: 600, now: () => t, onWarning: m => warnings.push(m) });
    const before = snapshot(root);
    A.eq(codeOf(() => io.appendDurable({ streamId: 's', role: 'user', content: 'refused', ts: 4000 })), 'TRANSCRIPT_DEGRADED_UNSAFE', '2b: appendDurable throws TRANSCRIPT_DEGRADED_UNSAFE while the active segment cannot be read');
    A.eq(snapshot(root), before, '2b: and no byte lands in any file');
    A.ok(unproven(warnings, active), '2b: the warning names the unproven segment ' + SEG(active));
    ctl.broken = false;
    t += 29999;
    A.eq(codeOf(() => io.appendDurable({ streamId: 's', role: 'user', content: 'still refused', ts: 4001 })), 'TRANSCRIPT_DEGRADED_UNSAFE', '2b: the proof is not re-run before 30 s');
    t += 1;
    const row = tryAppend(io, { streamId: 's', role: 'user', content: 'after the re-probe', ts: 4002 });
    io.close();
    A.ok(row && row.rowId > maxOf(onDisk), '2b: 30 s later an append lands with a rowId above every id on disk (' + (row && row.rowId) + ' vs ' + maxOf(onDisk) + ')');
    const landed = rowsOn(root).find(r => row && r.rowId === row.rowId);
    A.ok(landed && landed.seg > maxOf(oldSegs), '2b: in a new segment (' + (landed && landed.seg) + ')');
    A.eq(new Set(idsOn(root)).size, idsOn(root).length, '2b: no id on disk is duplicated');
  });

  // ---- 2c. the same, with the clock below the ids and a legacy row whose supplied rowId is above clock * 1000 --------
  leg('2c', () => {
    const SUPPLIED = 40000000;
    const { root, active } = unreadableActive('2c', io => io.appendDurable({ streamId: 's', role: 'user', content: 'legacy import', ts: 2000, rowId: SUPPLIED }));
    removeLease(root);
    const onDisk = idsOn(root);
    A.ok(maxOf(onDisk) > SUPPLIED, 'fixture: the active segment holds ids above the supplied ' + SUPPLIED);
    const { f, ctl } = brokenRead(SEG(active));
    let t = 5;   // clock * 1000 = 5000: far below the ids
    const io = open(root, { fs: f, segmentBytes: 600, now: () => t, onWarning: () => {} });
    const refused = codeOf(() => io.appendDurable({ streamId: 's', role: 'user', content: 'refused', ts: 4000 }));
    ctl.broken = false;
    t += 30000;   // 30005 * 1000 is still below the supplied id
    const row = tryAppend(io, { streamId: 's', role: 'user', content: 'after the re-probe', ts: 4001 });
    io.close();
    A.eq(refused, 'TRANSCRIPT_DEGRADED_UNSAFE', '2c: the unreadable active segment refuses appends');
    A.ok(row && row.rowId > maxOf(onDisk), '2c: no id is reused: the next id is above the supplied legacy id and its successors (' + (row && row.rowId) + ' vs ' + maxOf(onDisk) + ')');
    A.eq(new Set(idsOn(root)).size, idsOn(root).length, '2c: no id on disk is duplicated');
  });

  // ---- 2d. healthy path: a valid manifest, the active segment unreadable during init only --------------------------
  leg('2d', () => {
    const root = freshRoot();
    const io = open(root, { segmentBytes: 600 });
    fillSegments(io, root, 2);
    for (let k = 0; k < 2; k++) io.appendDurable({ streamId: 's', role: 'user', content: 'active row ' + k, ts: 3000 + k });
    io.close();
    const active = maxOf(segNumbers(root));
    const activeIds = rowsOn(root).filter(r => r.seg === active).map(r => r.rowId);
    A.ok(fs.existsSync(path.join(root, 'manifest.json')) && activeIds.length > 0, 'fixture: a valid manifest and a non-empty active segment');
    const { f, ctl } = brokenRead(SEG(active));
    let t = 0;
    const dio = open(root, { fs: f, segmentBytes: 600, now: () => t, onWarning: () => {} });
    ctl.broken = false;   // init is over: the file reads again
    const appended = [];
    for (const at of [0, 30000, 30001]) { t = at; const r = tryAppend(dio, { streamId: 's', role: 'user', content: 'after init ' + at, ts: 5000 + at }); if (r) appended.push(r); }
    dio.close();
    A.ok(appended.length > 0, '2d: appends resume once the segment proves its ids');
    A.eq(appended.filter(r => activeIds.indexOf(r.rowId) >= 0).map(r => r.rowId), [], '2d: no append reuses an active-segment id (active ids ' + activeIds.join(',') + ')');
  });

  // ---- 2e. an acknowledged row overwritten in place (valid manifest, the lease in place): never reissued ------------
  leg('2e', () => {
    const root = freshRoot();
    const io = open(root);
    const rows = [];
    for (let k = 0; k < 5; k++) rows.push(io.appendDurable({ streamId: 's', role: 'user', content: 'acknowledged ' + k, ts: 10 + k }));
    io.close();
    const N = rows[rows.length - 1].rowId;
    garble(path.join(root, SEG(1)), [4]);
    const again = open(root, { onWarning: () => {} });
    const next = tryAppend(again, { streamId: 's', role: 'user', content: 'after the damage', ts: 99 });
    A.ok(next && next.rowId > N, '2e: the next appended rowId is above the damaged row\'s id ' + N + ' (got ' + (next && next.rowId) + ')');
    const byN = again.readById(N);
    A.ok(!byN || byN.content !== 'after the damage', '2e: readById(' + N + ') never returns the new row');
    again.close();
  });

  // ---- 2f. control: an unterminated torn fragment at the end of the active segment never blocks appends ------------
  leg('2f', () => {
    const root = freshRoot();
    const io = open(root);
    for (let k = 0; k < 4; k++) io.appendDurable({ streamId: 's', role: 'user', content: 'row ' + k, ts: 10 + k });
    io.close();
    removeLease(root);
    fs.appendFileSync(path.join(root, SEG(1)), '{"streamId":"s","role":"assistant","content":"half of a ro');
    const max = maxOf(idsOn(root));
    const again = open(root, { onWarning: () => {} });
    A.ok(!again.status().unsafe, '2f: no unsafe mode for a crashed append\'s unterminated tail');
    const next = tryAppend(again, { streamId: 's', role: 'user', content: 'after the tear', ts: 99 });
    A.ok(next && next.rowId > max, '2f: the next id is above every parsable id (' + (next && next.rowId) + ' vs ' + max + ')');
    again.close();
  });

  // ---- 2g. no lease + a damaged trailing line: unsafe; the same with an unterminated fragment: healthy --------------
  leg('2g', () => {
    for (const shape of ['damaged line', 'unterminated fragment']) {
      const root = freshRoot();
      const io = open(root);
      const rows = [];
      for (let k = 0; k < 5; k++) rows.push(io.appendDurable({ streamId: 's', role: 'user', content: 'acknowledged ' + k, ts: 10 + k }));
      io.close();
      removeLease(root);
      if (shape === 'damaged line') garble(path.join(root, SEG(1)), [4]);
      else fs.appendFileSync(path.join(root, SEG(1)), '{"streamId":"s","con');
      const warnings = [];
      const again = open(root, { onWarning: m => warnings.push(m) });
      const code = codeOf(() => again.appendDurable({ streamId: 's', role: 'user', content: 'next', ts: 99 }));
      again.close();
      if (shape === 'damaged line') {
        A.eq(code, 'TRANSCRIPT_DEGRADED_UNSAFE', '2g: without the lease a newline-terminated damaged line refuses appends');
        A.ok(unproven(warnings, 1), '2g: the warning names ' + SEG(1));
      } else {
        A.eq(code, 'no throw', '2g: the same steps with an unterminated fragment instead are healthy');
      }
    }
  });

  // ---- 2h. no lease; segment-000001 holds 1..N and then 1..k beyond its meta bytes, no damaged line ----------------
  function degradedShape(damaged) {
    const root = freshRoot();
    let io = open(root);
    for (let k = 0; k < 6; k++) io.appendDurable({ streamId: 's', role: 'user', content: 'first life ' + k, ts: 10 + k });
    io.close();
    io = open(root); io.close();   // a boot persists segment-000001's meta at this size
    const N = maxOf(idsOn(root));
    if (damaged) fs.appendFileSync(path.join(root, SEG(1)), '{"streamId":"s","role":"user","content":"torn by a cra\n');
    for (let id = 1; id <= 3; id++) fs.appendFileSync(path.join(root, SEG(1)), lineFor(id, 's', 'trunk degraded boot ' + id, 50 + id));
    removeLease(root);
    return { root, N };
  }
  leg('2h', () => {
    const { root, N } = degradedShape(false);
    const warnings = [];
    const io = open(root, { onWarning: m => warnings.push(m) });
    A.ok(!io.status().unsafe, '2h: a damage-free segment holding a duplicate suffix is proven by its full parse (no unsafe mode)');
    const next = tryAppend(io, { streamId: 's', role: 'user', content: 'upgraded', ts: 99 });
    A.ok(next && next.rowId > N, '2h: the next appended rowId is above N=' + N + ' (got ' + (next && next.rowId) + ')');
    A.ok((io.status().idCollisions || []).some(c => c.a === 1 && c.b === 1), '2h: idCollisions names ' + SEG(1) + ' (' + JSON.stringify(io.status().idCollisions) + ')');
    A.ok(fs.existsSync(path.join(root, 'rowid-lease.json')), '2h: rowid-lease.json exists after that append');
    io.close();
  });

  // ---- 2i. the same shape with a newline-terminated damaged line between id N and the restarted 1 -------------------
  leg('2i', () => {
    const { root } = degradedShape(true);
    const warnings = [];
    const io = open(root, { onWarning: m => warnings.push(m) });
    A.eq(codeOf(() => io.appendDurable({ streamId: 's', role: 'user', content: 'refused', ts: 99 })), 'TRANSCRIPT_DEGRADED_UNSAFE', '2i: the damaged line refuses appends');
    A.ok(unproven(warnings, 1), '2i: the warning names ' + SEG(1));
    io.close();
    // and the meta this boot wrote for the segment is no proof on the next boot (it was built from the damaged bytes)
    const io2 = open(root, { onWarning: () => {} });
    A.eq(codeOf(() => io2.appendDurable({ streamId: 's', role: 'user', content: 'refused again', ts: 100 }), ), 'TRANSCRIPT_DEGRADED_UNSAFE', '2i: the next boot still refuses (its own rebuilt meta never stands as proof)');
    io2.close();
  });

  // ---- 2j. the hidden reset edge: ids 1,2,3 then 1,2 with the first three lines damaged; and the ascending shape ----
  leg('2j', () => {
    for (const shape of ['a', 'b']) {
      const root = freshRoot();
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 2, nextRowId: 1, activeSegment: 1, segments: [], legacy: [] }));
      const seg = path.join(root, SEG(1));
      if (shape === 'a') {
        fs.writeFileSync(seg, [1, 2, 3, 1, 2].map((id, i) => lineFor(id, 's', 'acknowledged ' + i, 10 + i)).join(''));
        garble(seg, [0, 1, 2]);
        A.eq(idsOn(root), [1, 2], 'fixture 2j (a): the survivors 1, 2 ascend');
      } else {
        fs.writeFileSync(seg, lineFor(1, 's', 'one', 10) + lineFor(2, 's', 'two', 11) + '{"streamId":"s","role":"user","con\n' + lineFor(3, 's', 'three', 12));
      }
      const warnings = [];
      const io = open(root, { onWarning: m => warnings.push(m) });
      const appended = tryAppend(io, { streamId: 's', role: 'user', content: 'next', ts: 99 });
      io.close();
      A.ok(!appended, '2j (' + shape + '): appendDurable throws TRANSCRIPT_DEGRADED_UNSAFE' + (appended ? ' (it minted ' + appended.rowId + ')' : ''));
      A.ok(unproven(warnings, 1), '2j (' + shape + '): the warning names ' + SEG(1));
      if (shape === 'a') A.ok(idsOn(root).indexOf(3) < 0, '2j (a): no id 3 is minted');
    }
  });

  // ---- 2k. complete lines cut away after acknowledgement: (a) the lease bounds them; (b) the Q37 residual (control) ---
  leg('2k', () => {
    for (const withLease of [true, false]) {
      const root = freshRoot();
      const io = open(root);
      const rows = [];
      for (let k = 0; k < 6; k++) rows.push(io.appendDurable({ streamId: 's', role: 'user', content: 'acknowledged ' + k, ts: 10 + k }));
      io.close();
      const N = rows[rows.length - 1].rowId;
      const seg = path.join(root, SEG(1));
      const keep = fs.readFileSync(seg, 'utf8').split('\n').slice(0, rows.length - 2).join('\n') + '\n';
      fs.writeFileSync(seg, keep);   // cut at the line boundary after row N-2
      if (!withLease) removeLease(root);
      const again = open(root, { onWarning: () => {} });
      const next = tryAppend(again, { streamId: 's', role: 'user', content: 'after the cut', ts: 99 });
      if (withLease) {
        A.ok(next && next.rowId > N, '2k (a): with rowid-lease.json in place the next rowId is above N=' + N + ' (got ' + (next && next.rowId) + ')');
      } else {
        A.ok(!again.status().unsafe, '2k (b) control: no unsafe mode');
        A.eq((again.status().idCollisions || []).length, 0, '2k (b) control: no audit entry');
        A.eq(next && next.rowId, N - 1, '2k (b) control, the Q37 residual: without the lease the next rowId is the parsed max + 1');
      }
      again.close();
    }
  });

  // ---- 3. the boot audit: overlapping ranges; and an in-segment duplicate plus a size mismatch ----------------------
  leg('3', () => {
    const root = freshRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, SEG(1)), [1, 2, 3, 4, 5].map(id => lineFor(id, 's', 'one ' + id, id)).join(''));
    fs.writeFileSync(path.join(root, SEG(2)), [3, 4, 5, 6, 7, 8].map(id => lineFor(id, 's', 'two ' + id, 10 + id)).join(''));
    const warnings = [];
    const io = open(root, { onWarning: m => warnings.push(m) });
    const c = io.status().idCollisions || [];
    A.ok(c.some(x => x.a === 1 && x.b === 2 && x.lo === 3 && x.hi === 5), '3: idCollisions names the overlapping segments 1 and 2, ids 3-5 (' + JSON.stringify(c) + ')');
    A.eq(warnings.length, 1, '3: with exactly one warning (' + warnings.join(' | ') + ')');
    io.close();

    const root2 = freshRoot();
    const w = open(root2, { segmentBytes: 600 });
    fillSegments(w, root2, 3);
    w.close();
    for (let id = 1; id <= 3; id++) fs.appendFileSync(path.join(root2, SEG(1)), lineFor(id, 's', 'reissued ' + id, 900 + id));
    const warnings2 = [];
    const io2 = open(root2, { segmentBytes: 600, onWarning: m => warnings2.push(m) });
    const c2 = io2.status().idCollisions || [];
    A.ok(c2.some(x => x.kind === 'duplicate' && x.a === 1 && x.b === 1 && x.lo === 1 && x.hi === 3), '3 extended: an in-segment duplicate in ' + SEG(1) + ' (a === b), ids 1-3 (' + JSON.stringify(c2) + ')');
    A.ok(c2.some(x => x.kind === 'size' && x.a === 1), '3 extended: and its size mismatch against the persisted meta');
    A.eq(warnings2.length, 1, '3 extended: one warning (' + warnings2.join(' | ') + ')');
    A.ok(!io2.status().unsafe, '3 extended: a damage-free duplicate never refuses appends');
    io2.close();
  });

  // ---- 4. buildEntry: additive, validated, byte-identical when absent ----------------------------------------------
  leg('4', () => {
    const redact = s => String(s).replace(/sk-[A-Za-z0-9]{6,}/g, '[REDACTED]');
    const store = makeTranscriptStore({ clock: { now: () => 7 }, redact });
    const plain = store.append({ streamId: 's', agentId: 'a', role: 'user', content: 'hello', sourceRunId: 'R1', taint: null });
    A.eq(JSON.stringify(plain), '{"streamId":"s","agentId":"a","role":"user","content":"hello","ts":7,"sourceRunId":"R1","taintKnown":true}', '4 control: with no additive field the row is byte-identical to the trunk shape');
    const ignored = store.append({ streamId: 's', agentId: 'a', role: 'assistant', content: 'x', turnId: 'short', kind: 'nonsense', directive: true, attachments: [{ path: '/etc/passwd', name: 'p' }], quotes: [], targets: [0, -1, 1.5], noteId: 'bad id!', line: 7 });
    A.eq(JSON.stringify(ignored), '{"streamId":"s","agentId":"a","role":"assistant","content":"x","ts":7}', '4: invalid values are dropped, never thrown (bad turnId, unknown kind, absolute attachment path, bad targets and noteId)');
    const full = store.append({ streamId: 's', agentId: 'a', role: 'user', content: 'expanded text of notes.txt', taint: null, turnId: T, kind: 'turn', directive: true,
      typed: 'see sk-ABCDEF123456 attached', attachments: [{ id: 'a1', name: 'notes.txt', path: '.attachments/notes.txt', mediaType: 'text/plain', kind: 'file', bytes: 'NEVER' }, { path: 'C:/abs/x.png' }],
      line: 'line1@dock2', quotes: ['s2', 's3'], quotesAt: [5, 6], targets: [3, 4, 3], noteId: 'note_1', carriedBy: 'run-9' });
    A.eq(Object.keys(full), ['streamId', 'agentId', 'role', 'content', 'ts', 'taintKnown', 'turnId', 'kind', 'directive', 'typed', 'attachments', 'line', 'quotes', 'quotesAt', 'targets', 'noteId', 'carriedBy'], '4: the new keys are appended after taintKnown, in order');
    A.eq(full.typed, 'see [REDACTED] attached', '4: typed is redacted like content');
    A.eq(full.attachments, [{ id: 'a1', name: 'notes.txt', path: '.attachments/notes.txt', mediaType: 'text/plain', kind: 'file' }], '4: an attachment ref keeps only its five bounded fields, and a ref outside .attachments/ is dropped');
    A.eq([full.quotes, full.quotesAt, full.targets], [['s2', 's3'], [5, 6], [3, 4]], '4: quotes with aligned quotesAt, and distinct targets');
    const same = store.append({ streamId: 's', role: 'user', content: 'typed words', typed: 'typed words', turnId: T });
    A.ok(!('typed' in same), '4: a typed equal to the stored content is not stored');
    const steer = store.append({ streamId: 's', role: 'user', content: 'steer note', kind: 'steer', turnId: T, directive: true, noteId: 'n1' });
    A.eq([steer.role, steer.kind, steer.noteId, 'directive' in steer], ['system', 'steer', 'n1', false], '4: a SYSTEM_KINDS kind forces role system (and a system row is never a directive)');
    const delivery = store.append({ streamId: 's', role: 'assistant', content: 'routine reply', kind: 'delivery' });
    A.eq([delivery.role, delivery.kind], ['assistant', 'delivery'], '4: delivery is not a system kind');
    A.ok(!('directive' in store.append({ streamId: 's', role: 'user', content: 'u', directive: true })), '4: directive needs a valid turnId');
    A.ok(!('directive' in store.append({ streamId: 's', role: 'assistant', content: 'r', directive: true, turnId: T })), '4: directive needs a user row');
    const ids33 = Array.from({ length: 33 }, (_, i) => 'stream' + i);
    const sat = store.append({ streamId: 's', role: 'tool', content: 'r', quotes: ids33, quotesAt: ids33.map((_, i) => 100 - i) });
    A.eq([sat.quotes, sat.quotesAt], [['*'], [68]], '4: 33 quote ids store the saturated stamp with the earliest read time');
    A.eq(store.append({ streamId: 's', role: 'tool', content: 'r', quotes: ['s2', '*'] }).quotes, ['*'], '4: the * marker saturates');
    const thirtyTwo = store.append({ streamId: 's', role: 'tool', content: 'r', quotes: ids33.slice(0, 32) });
    A.eq(thirtyTwo.quotes, ids33.slice(0, 32), '4: 32 distinct ids are kept as they are');
    const mis = store.append({ streamId: 's', role: 'tool', content: 'r', quotes: ['s2', 's3'], quotesAt: [5] });
    A.eq([mis.quotes, 'quotesAt' in mis], [['s2', 's3'], false], '4: a misaligned quotesAt is dropped');
    // appendNew / appendNewStrict: without kindOf the system skip is exactly as before; with it a tagged steer is a row
    const mem = makeTranscriptStore({ clock: { now: () => 8 } });
    const fence = { role: 'system', content: 'a fence' };
    const note = { role: 'system', content: '[steering] go left' };
    if (TurnKinds) TurnKinds.tag(note, 'steer', { noteId: 'n7' });
    A.eq(mem.appendNewStrict('s', 'a', [fence, note, { role: 'user', content: 'u' }], { sourceRunId: 'R' }), 1, '4 control: appendNewStrict without kindOf still skips system messages');
    const mem2 = makeTranscriptStore({ clock: { now: () => 8 } });
    const note2 = { role: 'system', content: '[steering] go right' };
    if (TurnKinds) TurnKinds.tag(note2, 'steer', { noteId: 'n8' });
    mem2.appendNewStrict('s', 'a', [{ role: 'system', content: 'fence' }, note2], { sourceRunId: 'R', turnId: T, kindOf: () => 'turn' });
    const sys = mem2.all().filter(r => r.role === 'system');
    A.eq(sys.map(r => [r.content, r.kind, r.noteId, r.turnId]), [['[steering] go right', 'steer', 'n8', T]], '4: with kindOf a system message tagged steer is written as a system row with its kind and noteId (an untagged fence still is not)');
    A.eq(JSON.stringify(note2), JSON.stringify({ role: 'system', content: '[steering] go right' }), '4: a tagged message\'s JSON is unchanged');
    A.eq(StoreModule.rowKeyOf && StoreModule.rowKeyOf({ streamId: 's', rowId: 12 }), 'r:s:12', '4: rowKeyOf is r:<streamId>:<rowId>');
    A.eq(StoreModule.rowKeyOf && StoreModule.rowKeyOf({ streamId: 's' }), '', '4: and empty for a row without a rowId');
  });

  // ---- 5. the in-memory io ---------------------------------------------------------------------------------------
  leg('5', () => {
    const make = History.makeMemoryTranscriptIo;
    A.eq(typeof make, 'function', '5: transcript-history exports makeMemoryTranscriptIo');
    if (typeof make !== 'function') return;
    const io = make({ clock: { now: () => 1 } });
    const a = io.appendDurable({ streamId: 's', role: 'user', content: 'a', ts: 1 });
    const b = io.appendDurable({ streamId: 's', role: 'user', content: 'b', ts: 2 });
    const c = io.appendDurable({ streamId: 't', role: 'user', content: 'c', ts: 3, rowId: 40 });
    const d = io.appendDurable({ streamId: 's', role: 'user', content: 'd', ts: 4 });
    A.eq([a.rowId, b.rowId, c.rowId, d.rowId], [1, 2, 40, 41], '5: monotone from 1; a supplied id is kept and advances the counter');
    A.eq(io.readById(40), { streamId: 't', role: 'user', content: 'c', ts: 3, rowId: 40 }, '5: readById serves the stored copy');
    A.eq([io.streamRows('s'), io.streamRows('t'), io.streamRows('u')], [3, 1, 0], '5: streamRows counts a stream\'s rows');
    A.eq(io.readRecent({ perStream: 2 }).map(r => r.rowId), [2, 40, 41], '5: readRecent keeps each stream\'s newest rows, in rowId order');
    a.content = 'mutated';
    A.eq(io.readById(1).content, 'a', '5: the caller\'s copy never mutates the store');
  });

  // ---- 6. findTurn -------------------------------------------------------------------------------------------------
  leg('6', () => {
    const NOW = 10000000000;
    const probe = makeTranscriptStore({ clock: { now: () => NOW } });
    A.eq(typeof probe.findTurn, 'function', '6: the store has findTurn');
    if (typeof probe.findTurn !== 'function' || typeof History.makeMemoryTranscriptIo !== 'function') return;
    const deleted = {};
    const s = makeTranscriptStore({ io: History.makeMemoryTranscriptIo(), clock: { now: () => NOW }, deletedAt: sid => deleted[sid] || 0, ramPerStream: 5000, ramMax: 20000 });
    const put = e => s.appendStrict(Object.assign({ agentId: 'a', ts: NOW - 5 * MINUTE }, e));
    const D = put({ streamId: 's', role: 'user', content: 'do the thing', turnId: T, directive: true, sourceRunId: 'R1', kind: 'turn' });
    put({ streamId: 's', role: 'assistant', content: 'done', turnId: T, sourceRunId: 'R1', kind: 'turn' });
    const f = s.findTurn('s', T, { turnAt: NOW });
    A.eq([f.state, f.directive && f.directive.rowId, f.directive && f.directive.content], ['found', D.rowId, 'do the thing'], '6: found, with the directive: true row of the turnId');
    A.eq(s.findTurn('other', T, { turnAt: NOW }).state, 'absent', '6: absent for another stream');
    A.eq(s.findTurn('s', 'bad').state, 'absent', '6: an invalid turnId is absent');
    // capture and repair rows carry the turnId and are user rows: never the directive
    const T2 = 'tCAPTUREfirst0000000002';
    const cap = put({ streamId: 's', role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE] ...', turnId: T2, sourceRunId: 'R2', kind: 'capture' });
    const D2 = put({ streamId: 's', role: 'user', content: 'watch the screen', turnId: T2, directive: true, sourceRunId: 'R2', kind: 'turn' });
    put({ streamId: 's', role: 'user', content: '[STRUCTURED RESULT REPAIR] fix it', turnId: T2, sourceRunId: 'R2', kind: 'station' });
    A.eq(s.findTurn('s', T2, { turnAt: NOW }).directive.rowId, D2.rowId, '6: the directive, not the lower capture row ' + cap.rowId);
    const T3 = 'tNODIRECTIVE00000000003';
    put({ streamId: 's', role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE] only', turnId: T3, sourceRunId: 'R3', kind: 'capture' });
    put({ streamId: 's', role: 'user', content: '[STRUCTURED RESULT REPAIR] only', turnId: T3, sourceRunId: 'R3', kind: 'station' });
    A.eq(s.findTurn('s', T3, { turnAt: NOW }).state, 'unknown', '6: T\'s capture and repair rows without a findable directive: unknown, never one of them');
    // a deleted session's directive is never found; a retracted one neither
    const T4 = 'tDELETED000000000000004';
    put({ streamId: 'gone', role: 'user', content: 'deleted words', turnId: T4, directive: true, sourceRunId: 'R4' });
    deleted.gone = NOW;
    A.eq(s.findTurn('gone', T4, { turnAt: NOW }).state, 'unknown', '6: a deletedAt tombstone hides the directive (unknown: its raw row still counts)');
    const T5 = 'tRETRACTED0000000000005';
    const D5 = put({ streamId: 's', role: 'user', content: 'retried away', turnId: T5, directive: true, sourceRunId: 'R5' });
    put({ streamId: 's', role: 'system', kind: 'retract', content: 'retract', targets: [D5.rowId], sourceRunId: 'R6' });
    A.ok(s.findTurn('s', T5, { turnAt: NOW }).state !== 'found', '6: a retract row\'s targets are excluded');
    // a directive outside the newest 1200 rows: through its run rows (rung 2) and through turnRowId (rung 3)
    const T6 = 'tLONGRUN000000000000006', T7 = 'tROWID00000000000000007';
    const D6 = put({ streamId: 'long', role: 'user', content: 'long run', turnId: T6, directive: true, sourceRunId: 'R7' });
    const D7 = put({ streamId: 'long', role: 'user', content: 'named by row', turnId: T7, directive: true, sourceRunId: 'R8' });
    for (let k = 0; k < 1300; k++) put({ streamId: 'long', role: k % 2 ? 'assistant' : 'user', content: 'filler ' + k, sourceRunId: 'F' + k });
    put({ streamId: 'long', role: 'assistant', content: 'the long run ends', turnId: T6, sourceRunId: 'R7' });
    const f6 = s.findTurn('long', T6, { turnAt: NOW });
    A.eq([f6.state, f6.directive && f6.directive.rowId], ['found', D6.rowId], '6: rung 2 finds a directive outside the 1200-row read through its run rows');
    const f7 = s.findTurn('long', T7, { turnAt: NOW, turnRowId: D7.rowId });
    A.eq([f7.state, f7.directive && f7.directive.rowId], ['found', D7.rowId], '6: rung 3 proves it by turnRowId');
    A.eq(s.findTurn('long', T7, { turnAt: NOW }).state, 'unknown', '6: without turnRowId, T7\'s raw row is in the whole-stream proof: unknown');
    A.eq(s.findTurn('long', T7, { turnAt: NOW, turnRowId: D6.rowId }).state, 'unknown', '6: a turnRowId naming another turn\'s directive proves nothing');
    A.eq(s.findTurn('s', 'tNOTURNAT00000000000009').state, 'unknown', '6: no turnAt: unknown');
    const ownId = TurnKinds ? TurnKinds.runTurnId('R1') : 'rR1xxxxxxx';
    A.eq(s.findTurn('s', ownId, { turnAt: NOW }).state, 'absent', '6: a supplied r+runId turnId takes the full ladder (absent here)');

    // rung 4 over the REAL segmented io (pinned store clock, small segments)
    const quick = Object.create(fs);
    quick.fsyncSync = () => {};   // thousands of rows: the write path is real, only the disk flush is skipped
    const writeStream = (root, sid, count, tsOf, extra) => {
      const w = open(root, { fs: quick, segmentBytes: 4096 });
      for (let k = 0; k < count; k++) w.appendDurable(Object.assign({ streamId: sid, agentId: 'a', role: k % 2 ? 'assistant' : 'user', content: 'r' + k, ts: tsOf(k) }, extra ? extra(k) : {}));
      w.close();
    };
    const spied = (root, opts) => {
      const io = open(root, Object.assign({ segmentBytes: 4096, onWarning: () => {} }, opts || {}));
      const calls = { history: 0, vouched: 0 };
      const real = io.history;
      io.history = (sid, o) => { calls.history++; if (o && o.vouch) calls.vouched++; return real(sid, o); };
      return { io, calls };
    };
    {   // a short stream RAM holds whole: absent, no io.history call
      const root = freshRoot();
      writeStream(root, 'short', 6, k => NOW - 20 * MINUTE + k);
      const { io, calls } = spied(root);
      const st = makeTranscriptStore({ io, clock: { now: () => NOW } });
      A.eq(st.findTurn('short', T, { turnAt: NOW }).state, 'absent', '6 rung 4 (a): a short stream RAM holds whole, without T: absent');
      A.eq(calls.history, 0, '6 rung 4 (a): and no io.history call is made');
      io.close();
    }
    {   // 6000 rows, all older than 10 minutes, and a fresh turn: absent
      const root = freshRoot();
      writeStream(root, 'big', 6000, k => NOW - 40 * MINUTE + k * 200);
      const { io, calls } = spied(root);
      const st = makeTranscriptStore({ io, clock: { now: () => NOW } });
      A.eq(st.findTurn('big', T, { turnAt: NOW }).state, 'absent', '6 rung 4 (b): a fresh turn on a 6000-row stream whose rows are all older than 10 minutes: absent');
      A.eq(calls.vouched, 1, '6 rung 4 (b): through one vouched read');
      io.close();
    }
    {   // 6000 rows written after `since`, no T among the newest 5000: unknown
      const root = freshRoot();
      writeStream(root, 'busy', 6000, k => NOW - 5 * MINUTE + k * 10);
      const { io } = spied(root);
      const st = makeTranscriptStore({ io, clock: { now: () => NOW } });
      A.eq(st.findTurn('busy', T, { turnAt: NOW }).state, 'unknown', '6 rung 4 (b): 6000 rows after since and no T among the newest 5000: unknown');
      io.close();
    }
    {   // 5000 raw rows after `since`, some tombstoned: still unknown (raw rows are counted)
      const root = freshRoot();
      writeStream(root, 'tomb', 5000, k => NOW - 5 * MINUTE + k * 10);
      const { io } = spied(root);
      const st = makeTranscriptStore({ io, clock: { now: () => NOW }, deletedAt: sid => (sid === 'tomb' ? NOW - 5 * MINUTE + 500 : 0) });
      A.eq(st.findTurn('tomb', T, { turnAt: NOW }).state, 'unknown', '6 rung 4 (b): 5000 raw rows after since, some tombstoned: still unknown');
      io.close();
    }
    {   // a degraded boot (streamRows -1): unknown, never the RAM fallback's absent
      const root = freshRoot();
      writeStream(root, 'deg', 8, k => NOW - 3 * MINUTE + k);
      const io = open(root, { fs: initFails(), onWarning: () => {} });
      const st = makeTranscriptStore({ io, clock: { now: () => NOW } });
      A.eq(io.streamRows('deg'), -1, 'fixture: the degraded io cannot count the stream');
      A.eq(st.findTurn('deg', T, { turnAt: NOW }).state, 'unknown', '6 rung 4: a degraded boot: unknown');
      io.close();
    }
    {   // an io.history that throws: unknown
      const root = freshRoot();
      writeStream(root, 'thr', 8, k => NOW - 3 * MINUTE + k);
      const io = open(root, { onWarning: () => {} });
      const real = io.history;
      io.history = (sid, o) => { if (o && o.vouch) throw new Error('EIO: simulated'); return real(sid, o); };
      const st = makeTranscriptStore({ io, clock: { now: () => NOW }, ramPerStream: 3 });
      A.eq(st.findTurn('thr', T, { turnAt: NOW }).state, 'unknown', '6 rung 4: an io.history that throws: unknown');
      io.close();
    }
    {   // an unreadable closed segment inside the window: unknown
      const root = freshRoot();
      writeStream(root, 'hole', 300, k => NOW - 3 * MINUTE + k);
      const closed = segNumbers(root)[1];
      const { f } = brokenRead(SEG(closed));
      const io = open(root, { fs: f, segmentBytes: 4096, onWarning: () => {} });
      const st = makeTranscriptStore({ io, clock: { now: () => NOW }, ramPerStream: 3 });
      A.eq(st.findTurn('hole', T, { turnAt: NOW }).state, 'unknown', '6 rung 4: an unreadable closed segment inside the window: unknown (a non-strict read skips it and would say absent)');
      io.close();
    }
    {   // a damaged line naming T: unknown; one naming another turn is tolerated
      const root = freshRoot();
      writeStream(root, 'dmg', 8, k => NOW - 3 * MINUTE + k);
      const active = maxOf(segNumbers(root));
      fs.appendFileSync(path.join(root, SEG(active)), '{"streamId":"dmg","turnId":"tOTHERturn000000000000","con\n');
      let io = open(root, { segmentBytes: 4096, onWarning: () => {} });
      let st = makeTranscriptStore({ io, clock: { now: () => NOW }, ramPerStream: 3 });
      A.eq(st.findTurn('dmg', T, { turnAt: NOW }).state, 'absent', '6 rung 4: a damaged line naming another turn is tolerated (absent)');
      io.close();
      fs.appendFileSync(path.join(root, SEG(active)), '{"streamId":"dmg","turnId":"' + T + '","con\n');
      io = open(root, { segmentBytes: 4096, onWarning: () => {} });
      st = makeTranscriptStore({ io, clock: { now: () => NOW }, ramPerStream: 3 });
      A.eq(st.findTurn('dmg', T, { turnAt: NOW }).state, 'unknown', '6 rung 4: a damaged line naming T: unknown');
      io.close();
    }
  });

  // ---- 6b. history({ vouch: { claim } }) ---------------------------------------------------------------------------
  leg('6b', () => {
    const NOW = 10000000000;
    const quick = Object.create(fs);
    quick.fsyncSync = () => {};
    const root = freshRoot();
    const w = open(root, { fs: quick, segmentBytes: 600 });
    for (let k = 0; k < 24; k++) w.appendDurable({ streamId: k % 3 ? 'v' : 'o', role: k % 2 ? 'assistant' : 'user', content: 'vouch row ' + k + ' ' + 'y'.repeat(40), sourceRunId: 'run' + (k % 2), ts: NOW - 60000 + k });
    w.close();
    const firstClosed = segNumbers(root)[0];
    // the reference: what history returned before (newest `limit` rows of the stream, oldest first, filters applied)
    const reference = (sid, o) => {
      const all = rowsOn(root).filter(r => r.streamId === sid && (!o.sourceRunId || r.sourceRunId === o.sourceRunId)).map(r => { const c = Object.assign({}, r); delete c.seg; return c; });
      return all.slice(-(o.limit || 400));
    };
    const io = open(root, { segmentBytes: 600, onWarning: () => {} });
    const asks = [['v', { limit: 5 }], ['v', { limit: 400 }], ['o', { limit: 3, sourceRunId: 'run0' }], ['none', {}]];
    A.eq(asks.map(([sid, o]) => io.history(sid, o)), asks.map(([sid, o]) => reference(sid, o)), '6b control: every history call without vouch returns what it always did');
    const vouched = io.history('v', { limit: 400, vouch: { claim: T } });
    A.eq(vouched, reference('v', { limit: 400 }), '6b: a vouched read returns rows exactly as history does');
    io.close();
    // a cached closed parse is reused: no re-read (an fs spy)
    const reads = [];
    const spy = Object.create(fs);
    spy.readFileSync = (file, ...rest) => { reads.push(path.basename(String(file))); return fs.readFileSync(file, ...rest); };
    const cio = open(root, { fs: spy, segmentBytes: 600, cacheBytes: 1 << 20, onWarning: () => {} });   // a budget that holds every closed parse
    cio.history('v', { limit: 400 });   // parses (and caches) the closed segments
    reads.length = 0;
    cio.history('v', { limit: 400, vouch: { claim: T } });
    A.eq(reads.filter(n => /\.jsonl$/.test(n)), [], '6b: the vouched read reuses the cached closed parses (read: ' + reads.join(',') + ')');
    cio.close();
    // damaged lines in a closed segment: tolerated unless they name the claim; never hidden by the slice cache
    fs.appendFileSync(path.join(root, SEG(firstClosed)), '{"streamId":"v","turnId":"' + T + '","con\n');
    const dio = open(root, { segmentBytes: 600, cacheBytes: 0, onWarning: () => {} });
    dio.history('v', { limit: 400 });   // fills the per-stream slice cache (no closed parse cache: cacheBytes 0)
    A.eq(codeOf(() => dio.history('v', { limit: 400, vouch: { claim: 'tSOMEOTHERturn0000000000' } })), 'no throw', '6b: a damaged line that does not name the claim is tolerated');
    A.ok(codeOf(() => dio.history('v', { limit: 400, vouch: { claim: T } })) !== 'no throw', '6b: a damaged line naming the claim throws (the slice cache never hides it)');
    dio.close();
    // degraded and unvouched views throw TRANSCRIPT_UNVOUCHED
    const gio = open(root, { fs: initFails(), onWarning: () => {} });
    A.eq(codeOf(() => gio.history('v', { vouch: { claim: T } })), 'TRANSCRIPT_UNVOUCHED', '6b: a degraded io throws TRANSCRIPT_UNVOUCHED');
    gio.close();
    const uroot = freshRoot();
    const uio = open(uroot, { onWarning: () => {} });
    uio.appendDurable({ streamId: 'u', role: 'user', content: 'one', ts: 1 });
    const seg = path.join(uroot, SEG(1));
    fs.renameSync(seg, seg + '.moved');
    fs.copyFileSync(seg + '.moved', seg);
    uio.appendDurable({ streamId: 'u', role: 'user', content: 'two', ts: 2 });   // the handle is no longer the path: unvouched
    A.eq(uio.streamRows('u'), -1, 'fixture: the io stopped vouching for the disk');
    A.eq(codeOf(() => uio.history('u', { vouch: { claim: T } })), 'TRANSCRIPT_UNVOUCHED', '6b: an unvouched io throws TRANSCRIPT_UNVOUCHED');
    uio.close();
  });

  // ---- 7. TurnKinds.quoteStamp; 7b. stationTime / clientTurnTime ------------------------------------------------------
  leg('7', () => {
    A.ok(!!TurnKinds, '7: TurnKinds is available');
    if (!TurnKinds) return;
    const entries = Array.from({ length: 32 }, (_, i) => ({ id: 's' + i, at: 100 + i }));
    A.eq(TurnKinds.quoteStamp(entries), { quotes: entries.map(e => e.id), quotesAt: entries.map(e => e.at) }, '7: up to 32 entries map 1:1');
    A.eq(TurnKinds.quoteStamp(entries.concat([{ id: 's32', at: 7 }])), { quotes: ['*'], quotesAt: [7] }, '7: 33 entries saturate to [*] with the earliest at');
    A.eq(TurnKinds.quoteStamp([{ id: 'a', at: 50 }, { id: '*', at: 9 }]), { quotes: ['*'], quotesAt: [9] }, '7: a * entry saturates');
    A.eq(TurnKinds.quoteStamp(['a', { id: 'b', at: 4 }, { id: 'a', at: 2 }]), { quotes: ['a', 'b'], quotesAt: [0, 4] }, '7: a bare string is {id, at: 0}; a repeated id keeps its earliest');
    A.eq(TurnKinds.quoteStamp([]), {}, '7: empty is {}');
    A.eq([TurnKinds.QUOTES_MAX, TurnKinds.isTurnId(T), TurnKinds.isTurnId('short'), TurnKinds.runTurnId('run-0001/x'), TurnKinds.phoneTurnId('run-0001'), TurnKinds.runTurnId('run-1'), TurnKinds.phoneTurnId('a'), TurnKinds.runTurnId(null)],
      [32, true, false, 'rrun-0001x', 'phrun-0001', '', '', ''], '7: the turnId grammar and the run mints (a mint shorter than 8 is no turnId: \'\')');
    A.eq([TurnKinds.ownMint('rrun-0001', 'run-0001'), TurnKinds.ownMint('phrun-0001', 'run-0001'), TurnKinds.ownMint('rrun-0002', 'run-0001'), TurnKinds.ownMint(T, 'run-0001')], [true, true, false, false], '7: ownMint is true only for this run\'s own mints');
    let n = 0;
    const id = TurnKinds.mintTurnId(() => ((n++ * 7) % 36) / 36);
    A.ok(/^t[0-9a-z]{24}$/.test(id) && TurnKinds.isTurnId(id), '7: mintTurnId gives t + 24 base36 chars (' + id + ')');
    A.eq(codeOf(() => TurnKinds.mintTurnId()), 'threw: TurnKinds.mintTurnId needs an rng() returning a number in [0,1)', '7: mintTurnId without an rng throws');
    A.ok(Object.isFrozen(TurnKinds.KINDS) && Object.isFrozen(TurnKinds.SYSTEM_KINDS) && TurnKinds.SYSTEM_KINDS.join() === 'steer,deliverable,retract,attachment' && TurnKinds.isKind('delivery') && TurnKinds.isKind('attachment') && !TurnKinds.isKind('nope'), '7: frozen kinds; delivery is a kind, not a system kind; attachment is a system kind (the record of one file a turn carried)');
    const m = TurnKinds.tag({ role: 'user', content: 'x' }, 'capture');
    A.eq([TurnKinds.tagOf(m), Object.keys(m), JSON.stringify(m), Object.keys(Object.assign({}, m))], [{ kind: 'capture' }, ['role', 'content'], '{"role":"user","content":"x"}', ['role', 'content']], '7: a tag is invisible to JSON, keys and spread');
  });
  leg('7b', () => {
    A.ok(!!TurnKinds, '7b: TurnKinds is available');
    if (!TurnKinds) return;
    const H = 60 * MINUTE, t0 = 1700000000000;
    A.eq(TurnKinds.stationTime(t0 + 24 * H, t0 + 24 * H + 30 * MINUTE, t0 + 30 * MINUTE), t0, '7b: stationTime subtracts the client\'s own elapsed time from the station now');
    A.eq([TurnKinds.stationTime(t0 + 1, t0, t0), TurnKinds.stationTime(t0, t0 + 8 * 24 * H, t0), TurnKinds.stationTime(t0 + 0.5, t0 + 10, t0), TurnKinds.stationTime(-1, 10, t0), TurnKinds.stationTime(t0, t0 + 7 * 24 * H, t0)],
      [undefined, undefined, undefined, undefined, t0 - 7 * 24 * H], '7b: clientNow < clientTs, more than 7 d, a non-integer or a negative value: undefined; exactly 7 d is used');
    A.eq(TurnKinds.clientTurnTime({ turnAt: t0 }, t0), {}, '7b: clientTurnTime({turnAt}) without clientNow is {}');
    A.eq(TurnKinds.clientTurnTime({ turnAt: t0, clientNow: t0 + 1000 }, 5000), { turnAt: 4000, clientClock: { clientNow: t0 + 1000, at: 5000 } }, '7b: clientTurnTime converts a pair');
  });
} catch (e) {
  A.ok(false, 'test body threw: ' + ((e && e.stack) || e));
} finally {
  fs.rmSync(BASE, { recursive: true, force: true });
}
A.report('transcript-row-identity.test');
