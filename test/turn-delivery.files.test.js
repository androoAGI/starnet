'use strict';
/* node test/turn-delivery.files.test.js — a run's files are rows of their own, exact and openable (turn identity, commit 10).

   The class: ANY artifact list a run can hand TurnDelivery.fileRows. A seeded generator builds the lists through the real
   artifact collector from real tool observations (unicode and middle-dot names, dots, spaces, drive/UNC/absolute paths,
   '..', NUL, over 260 characters, names whose sanitized artifact ids collide, repeats, failed and unknown tools, mixed taint)
   and every family labels, by construction, the exact path it may publish (or none). For every sample the rows written must be
   exactly that eligible set: path byte for byte, media from TurnKinds.mediaKindOf, the writing agent's workspace, the host
   root or '', the run's ids, one row per exact (stream, run, path) across retry and restart. A proof or append failure is
   never a success, and no row is ever shortened, absolute or unrepresentable. Then the pieces around it: the store's field
   grammar, the collector's cut mark, mediaKindOf moved verbatim, the visibility matrix, and the page adapter.
   RED at 4152883a1: fileRows, TurnKinds.mediaKindOf, TurnMerge.deliverableOf and the store's deliverable field do not exist. */
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const Store = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo, makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const Delivery = require('../sidecar/turn-delivery.js');
const Kinds = require('../frontend/app/turnkinds.js');
const Merge = require('../frontend/app/turnmerge.js');
const { makeArtifactCollector } = require('../sidecar/artifacts.js');

const ROOT_DIR = path.join(__dirname, '..');
if (typeof Delivery.fileRows !== 'function' || typeof Kinds.mediaKindOf !== 'function' || typeof Merge.deliverableOf !== 'function' || typeof Kinds.deliverableFields !== 'function') {
  A.ok(false, 'the pure owners exist: TurnDelivery.fileRows, TurnKinds.mediaKindOf / deliverableFields, TurnMerge.deliverableOf');
  A.report('turn-delivery.files');
}

/* ---- mediaKindOf moved byte for byte from chat.js ---- */
const OLD_TABLE = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', m4a: 'audio', ogg: 'audio', wav: 'audio', flac: 'audio', opus: 'audio' };
const BASE = '4152883a1ae500d345a5a78e6a94d48f9aded867';
{
  for (const [ext, kind] of Object.entries(OLD_TABLE)) {
    A.eq(Kinds.mediaKindOf('out/clip.' + ext), kind, 'the old table row .' + ext);
    A.eq(Kinds.mediaKindOf('CLIP.' + ext.toUpperCase()), kind, 'the extension is case-folded: .' + ext);
    A.eq(Kinds.mediaKindOf('clip.' + ext + '?x=1'), kind, 'a query is cut before the extension: .' + ext);
  }
  A.eq([Kinds.mediaKindOf(''), Kinds.mediaKindOf(null), Kinds.mediaKindOf('noext'), Kinds.mediaKindOf('a.md'), Kinds.mediaKindOf('a.png.txt')], ['file', 'file', 'file', 'file', 'file'], 'unknown extensions are plain files');
  let git = null;
  try {
    cp.execFileSync('git', ['cat-file', '-e', BASE + '^{commit}'], { cwd: ROOT_DIR, stdio: 'ignore' });
    git = cp.execFileSync('git', ['show', BASE + ':frontend/app/chat.js'], { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch (_) { git = null; }
  if (git) {
    const table = /const MEDIA_KIND_BY_EXT = (\{[^}]+\});/.exec(git), fn = /  function mediaKindOf\(title\) \{\n[^}]+\n  \}/.exec(git);
    A.ok(!!table && !!fn, 'the old rule is readable out of git at the base commit');
    if (table && fn) {
      A.eq(new Function('return ' + table[1])(), OLD_TABLE, 'the embedded table is the base commit\'s table, entry for entry');
      A.eq('  ' + Kinds.mediaKindOf.toString(), fn[0], 'TurnKinds.mediaKindOf is the old function, byte for byte');
    }
  } else console.log('NOTE: base commit ' + BASE.slice(0, 9) + ' is not in this checkout; the verbatim check ran against the embedded table only');
  const chat = fs.readFileSync(path.join(ROOT_DIR, 'frontend/app/chat.js'), 'utf8');
  A.ok(chat.includes('function mediaKindOf(title) { return TurnKinds.mediaKindOf(title); }'), 'chat.js keeps a one-line delegate');
  A.ok(!chat.includes('MEDIA_KIND_BY_EXT'), 'chat.js holds no second copy of the table');
}

/* ---- the collector marks a cut record, and only a cut one ---- */
{
  const col = makeArtifactCollector();
  col.observe({ toolName: 'fs.write', args: { path: 'q'.repeat(257) + '.md', content: 'x' }, result: { ok: true } });   // exactly 260
  col.observe({ toolName: 'fs.write', args: { path: 'q'.repeat(258) + '.md', content: 'x' }, result: { ok: true } });   // 261
  col.observe({ toolName: 'fs.write', args: { path: 'short.md', content: 'hello' }, result: { ok: true } });
  const [exact, over, short] = col.list();
  A.eq([exact.path.length, 'cut' in exact], [260, false], 'a 260-character path is whole: no mark');
  A.eq([over.path.length, over.cut], [260, true], 'a 261-character path is cut to 260 and says so');
  A.eq(Object.keys(short), ['kind', 'path', 'bytes'], 'an ordinary record is byte-identical to before (no new key)');
  A.eq(Object.keys(makeArtifactCollector().list()), [], 'an empty ledger stays empty');
}

/* ---- the store's field grammar ---- */
const open = (io, redact, extra) => Store.makeTranscriptStore(Object.assign({ io, clock: { now: () => 20 }, redact: redact || (v => v.replace(/RAW_SECRET/g, '[redacted-key]')) }, extra));
const field = (over) => Object.assign({ path: 'report \u00b7 v2.md', media: 'file', workspace: 'agent', root: '', name: 'report', artifactId: 'file_report___v2.md' }, over);
const turnId = Kinds.runTurnId('run-00000001');
{
  const io = makeMemoryTranscriptIo(), store = open(io);
  const write = (e) => store.appendStrict(Object.assign({ streamId: 's', agentId: 'agent', role: 'system', kind: 'deliverable', content: 'saved report', sourceRunId: 'run-00000001', turnId }, e));
  const good = write({ deliverable: field() });
  A.eq(good.deliverable, field(), 'a deliverable row keeps its field verbatim (exact path, middle dot and all)');
  A.eq([good.role, good.kind], ['system', 'deliverable'], 'a file row is stored as a system row');
  A.eq(write({ role: 'assistant', deliverable: field() }).role, 'system', 'a writer cannot make a file row speak as the assistant');
  const redacted = write({ deliverable: field({ path: 'RAW_SECRET notes.md', name: 'RAW_SECRET notes.md' }) });
  A.eq([redacted.deliverable.path, redacted.deliverable.name], ['RAW_SECRET notes.md', '[redacted-key] notes.md'], 'only the display name is redacted; the path is an address and stays exact');
  A.eq(write({ kind: 'turn', role: 'assistant', deliverable: field() }).deliverable, undefined, 'any other kind drops the field');
  A.eq(Object.keys(write({ kind: 'turn', role: 'assistant', deliverable: field() })), Object.keys(write({ kind: 'turn', role: 'assistant' })), 'and the row is byte-identical to one without it');
  const bad = {
    'dotdot': field({ path: 'a/../b.md' }), 'leading dotdot': field({ path: '../b.md' }), 'rooted': field({ path: '/etc/passwd' }), 'unc': field({ path: '\\\\host\\share\\f.md' }),
    'drive': field({ path: 'C:\\x.md' }), 'drive-relative': field({ path: 'C:x.md' }), 'nul': field({ path: 'a\u0000b.md' }), 'too long': field({ path: 'q'.repeat(261) }),
    'empty': field({ path: '' }), 'directory': field({ path: 'out/' }), 'media': field({ media: 'document' }), 'workspace': field({ workspace: '../vex' }),
    'root unc': field({ root: '\\\\host\\share' }), 'root relative': field({ root: 'proj' }), 'root nul': field({ root: 'C:\\p\u0000q' }),
    'artifact id': field({ artifactId: 'x_report' }), 'artifact id chars': field({ artifactId: 'file_a b' }), 'not an object': 'report.md'
  };
  for (const [label, d] of Object.entries(bad)) A.eq(write({ deliverable: d }).deliverable, undefined, 'an invalid field is dropped whole, never repaired: ' + label);
  A.eq(write({ deliverable: field({ path: 'q'.repeat(260) }) }).deliverable.path.length, 260, 'a 260-character path is the longest address');
  A.eq(write({ deliverable: field({ root: 'C:\\Users\\me\\proj' }) }).deliverable.root, 'C:\\Users\\me\\proj', 'a project root is kept');
  A.eq(write({ deliverable: field({ name: 'one\ntwo\u0000three' }) }).deliverable.name, 'one two three', 'a name never carries a second line');
}

/* ---- the generator ---- */
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const WIN = 'C:\\Users\\me\\proj', POSIX = '/home/me/proj';
const PLAIN = ['report.md', 'notes/a.txt', 'out/img_01.png', 'clip.mp3', 'clip.mp4', 'data.json', 'No Ext', '.hidden', 'dir.with.dots/file.name.tar.gz', 'sub dir/with space.md', './dot-slash.md', 'UPPER.PNG', 'what#1.png'];
const UNICODE = ['report \u00b7 v2.md', 'a \u00b7 b.png', 'na\u00efve caf\u00e9.txt', '\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.md', 'party \ud83c\udf89.png', '\u03a9\u03a3.wav'];
const COLLIDE = ['a b.png', 'a_b.png', 'a\u00b7b.png', 'a-b.png'];   // the first three share the artifact id file_a_b.png
// each family -> { tool, path, expect } where expect is the exact path it may publish (or null), known by construction
const FAMILIES = [
  (rng) => { const p = pick(rng, PLAIN); return { tool: pick(rng, ['fs.write', 'fs.append', 'fs.edit', 'fs.patch']), path: p, expect: p }; },
  (rng) => { const p = pick(rng, UNICODE); return { tool: pick(rng, ['fs.write', 'fs.patch']), path: p, expect: p }; },
  (rng) => { const p = pick(rng, COLLIDE); return { tool: 'fs.write', path: p, expect: p }; },
  (rng) => { const p = 'gen/' + pick(rng, ['one', 'two', 'three']) + '.png'; return { tool: 'image_generate', path: p, expect: p }; },
  (rng) => ({ tool: 'fs.write', path: pick(rng, ['../escape.md', 'a/../b.md', '..\\x.md', 'sub\\..\\..\\y.md']), expect: null }),
  (rng) => ({ tool: 'fs.write', path: 'nul' + pick(rng, ['', '/']) + '\u0000.md', expect: null }),
  (rng) => ({ tool: 'fs.write', path: 'LONG-' + 'z'.repeat(256 + Math.floor(rng() * 80)) + '.md', expect: null }),    // 261..340: the collector cuts it
  () => ({ tool: 'fs.write', path: 'EDGE-' + 'e'.repeat(255), expect: 'EDGE-' + 'e'.repeat(255) }),                   // exactly 260: whole
  (rng) => ({ tool: 'fs.write', path: pick(rng, ['/etc/passwd', '\\\\host\\share\\f.txt', 'C:\\Windows\\x.txt', 'C:x.txt', '//server/s/x.md', '/tmp/out.png']), expect: null }),
  (rng) => ({ tool: 'fs.write', path: pick(rng, ['dir/', 'dir\\']), expect: null }),
  (rng) => ({ tool: pick(rng, ['fs.write', 'fs.append']), path: 'failed/' + pick(rng, PLAIN), failed: true, expect: null }),
  (rng) => ({ tool: pick(rng, ['web.search', 'shell.exec', 'fs.read', 'memory.write']), path: 'unknown/' + pick(rng, PLAIN), expect: null }),
  (rng, root) => root ? inside(rng, root) : { tool: 'fs.write', path: WIN + '\\src\\a.md', expect: null },
  (rng, root) => root ? outside(rng, root) : { tool: 'fs.write', path: POSIX + '/src/a.md', expect: null }
];
function inside(rng, root) {
  const rel = pick(rng, ['src/a.md', 'x.png', 'deep/er/b c.md', 'caf\u00e9/\u00b7.txt', 'clip.mp4']), win = /^[A-Za-z]:/.test(root);
  let abs = win ? root + '\\' + rel.replace(/\//g, '\\') : root + '/' + rel;
  if (win && rng() < 0.5) abs = abs.replace('C:', 'c:').replace('Users', 'USERS').replace(/proj/, 'PROJ').replace(/\\/g, '/');   // a Windows path is case-blind and takes either separator
  return { tool: 'fs.write', path: abs, expect: rel };
}
function outside(rng, root) {
  const win = /^[A-Za-z]:/.test(root), sep = win ? '\\' : '/';
  const abs = pick(rng, [root + '2' + sep + 'x.md', root + sep + '..' + sep + 'x.md', root + sep + 'sub' + sep + '..' + sep + 'x.md', root.replace('me', 'you') + sep + 'x.md', win ? 'D:' + root.slice(2) + sep + 'x.md' : root.toUpperCase() + '/x.md', root]);
  return { tool: 'fs.write', path: abs, expect: null };
}
function observe(col, item) {
  const ok = !item.failed, result = { ok };
  if (item.tool === 'fs.patch') return col.observe({ toolName: 'fs.patch', args: { patch: '*** Begin Patch\n*** Add File: ' + item.path + '\n+x\n*** End Patch' }, result: { ok: true, content: 'Applied patch: 1 files changed.' } });
  if (item.tool === 'image_generate') return col.observe({ toolName: 'image_generate', args: { prompt: 'p' }, result: { ok: true, summary: 'image \u2192 ' + item.path } });
  if (item.tool === 'fs.append') return col.observe({ toolName: 'fs.append', args: { path: item.path, content: 'more' }, result: { ok, content: 'Appended to p (+4 bytes, now 9).' } });
  return col.observe({ toolName: item.tool, args: { path: item.path, content: 'hello' }, result });
}
const sanitize = p => String(p).replace(/[^A-Za-z0-9_.-]/g, '_');
const shownMedia = p => { const m = Kinds.mediaKindOf(p); return Kinds.DELIVERABLE_MEDIA.indexOf(m) >= 0 ? m : 'file'; };
const SAMPLES = 120;
{
  let eligibleTotal = 0, skippedTotal = 0;
  for (let seed = 1; seed <= SAMPLES; seed++) {
    const rng = mulberry32(seed * 7919), root = pick(rng, ['', WIN, POSIX]), agentId = pick(rng, ['agent', 'vex-2', 'worker_3']);
    const items = [];
    for (let i = 0, n = 3 + Math.floor(rng() * 10); i < n; i++) items.push(pick(rng, FAMILIES)(rng, root));
    for (let i = 0, n = Math.floor(rng() * 3); i < n && items.length; i++) items.push(Object.assign({}, pick(rng, items)));   // repeats
    const col = makeArtifactCollector();
    for (const item of items) observe(col, item);
    const artifacts = col.list();
    const expected = [], kindOf = new Map();
    for (const item of items) if (item.expect !== null && !item.failed && !/^(web|shell|fs\.read|memory)/.test(item.tool) && !expected.includes(item.expect)) { expected.push(item.expect); kindOf.set(item.expect, item.tool === 'image_generate' ? 'image' : 'file'); }
    const taintMode = seed % 3, runId = 'run-' + String(seed).padStart(8, '0'), streamId = 'sess-' + seed;
    const input = Object.assign({ streamId, agentId, runId, root, artifacts }, taintMode === 1 ? { taint: null } : taintMode === 2 ? { taint: 'web page ' + seed } : null);
    const io = makeMemoryTranscriptIo(), store = open(io), where = 'seed ' + seed + ' (root ' + JSON.stringify(root) + ')';
    // a hidden run row and a reply of the same run must not disturb the proof of the files
    store.appendStrict({ streamId, agentId, role: 'assistant', content: 'the reply', sourceRunId: runId, turnId: Kinds.runTurnId(runId) });
    const first = Delivery.fileRows(store, input);
    const rows = store.view('proof', streamId, { complete: true }).filter(r => r.kind === 'deliverable');
    A.eq(rows.map(r => r.deliverable.path), expected, where + ': the rows written are exactly the eligible paths, byte for byte, in the run\'s order');
    A.eq(first.rows.map(r => r.path), expected, where + ': the return names the same set');
    A.eq(first.rows.map(r => r.rowId), rows.map(r => r.rowId), where + ': and the durable row ids');
    A.ok(first.rows.every(r => r.existed === false), where + ': a first call writes');
    eligibleTotal += rows.length;
    for (const row of rows) {
      const d = row.deliverable;
      A.ok(row.role === 'system' && row.kind === 'deliverable' && row.sourceRunId === runId && row.turnId === Kinds.runTurnId(runId) && row.agentId === agentId && row.streamId === streamId, where + ': the row\'s ids and speaker');
      A.eq([d.workspace, d.root, d.media], [agentId, root, shownMedia(d.path)], where + ': workspace is the writing agent, root the host root, media the extension rule: ' + d.path);
      A.eq(d.artifactId, (kindOf.get(d.path) === 'image' ? 'img_' : 'file_') + sanitize(d.path), where + ': the artifact id follows the live event rule');
      A.ok(d.path.length <= 260 && !/^[\\/]/.test(d.path) && !/^[A-Za-z]:/.test(d.path) && !/(^|[\\/])\.\.([\\/]|$)/.test(d.path) && !d.path.includes('\u0000'), where + ': never shortened, absolute or unrepresentable: ' + d.path.slice(0, 40));
      A.ok(row.content === (d.media === 'file' ? 'saved ' : 'made ') + d.name && !/[\r\n]/.test(row.content), where + ': one line of display prose');
      A.eq(taintMode === 0 ? [row.taint, row.taintKnown] : taintMode === 1 ? [row.taint, row.taintKnown] : [row.taint, row.taintKnown],
        taintMode === 0 ? [undefined, undefined] : taintMode === 1 ? [undefined, true] : ['web page ' + seed, true], where + ': taint is absent (unknown), an explicit null (clean) or the source\'s');
    }
    for (const a of artifacts) if (a.cut === true) {
      A.ok(first.skipped.some(s => s.why === 'cut'), where + ': a cut record is reported, not published');
      A.ok(rows.every(r => r.deliverable.path !== a.path), where + ': and its 260-character label is never a row');
    }
    for (const s of first.skipped) A.ok(typeof s.why === 'string' && s.why && typeof s.path === 'string' && s.path.length <= 300, where + ': every skip names a bounded path and a reason');
    skippedTotal += first.skipped.length;
    // retry and restart: the same rows come back, nothing new is written
    const before = io.streamRows(streamId);
    const again = Delivery.fileRows(store, input);
    A.eq(again.rows.map(r => r.rowId), first.rows.map(r => r.rowId), where + ': a retry returns the same row ids');
    A.ok(again.rows.every(r => r.existed === true), where + ': a retry writes nothing');
    A.eq(io.streamRows(streamId), before, where + ': the stream did not grow');
    const reopened = open(io), third = Delivery.fileRows(reopened, input);
    A.eq(third.rows.map(r => r.rowId), first.rows.map(r => r.rowId), where + ': a restart returns the same row ids');
    A.eq(io.streamRows(streamId), before, where + ': and the stream still did not grow');
    // another run, another stream: its own rows for the same paths
    if (expected.length) {
      const other = Delivery.fileRows(store, Object.assign({}, input, { runId: runId + '-b' }));
      A.ok(other.rows.every(r => r.existed === false) && other.rows.length === expected.length, where + ': a second run writing the same paths has rows of its own');
      const elsewhere = Delivery.fileRows(store, Object.assign({}, input, { streamId: streamId + '-x' }));
      A.ok(elsewhere.rows.every(r => r.existed === false), where + ': and so does another stream');
    }
  }
  A.ok(eligibleTotal > SAMPLES && skippedTotal > SAMPLES, 'the generator reaches both sides (' + eligibleTotal + ' rows written, ' + skippedTotal + ' skipped over ' + SAMPLES + ' lists)');
}

/* ---- exact families, one by one (the corners the generator relies on) ---- */
function fresh() { const io = makeMemoryTranscriptIo(); return { io, store: open(io) }; }
const RUN = { streamId: 'chat', agentId: 'agent', runId: 'run-00000001' };
const rec = (kind, p, extra) => Object.assign({ kind, path: p }, extra);
{
  const f = fresh(), out = Delivery.fileRows(f.store, Object.assign({ root: WIN, artifacts: [
    rec('file', WIN + '\\src\\a.md'), rec('file', WIN.toLowerCase() + '/Src/b.md'), rec('file', WIN + '2\\x.md'), rec('file', WIN + '\\..\\y.md'), rec('file', WIN), rec('file', WIN + '\\'),
    rec('file', '\\\\host\\share\\z.md'), rec('file', 'D:\\proj\\q.md'), rec('image', 'ok.png'), rec('message', undefined, { target: 'slack' }), rec('video', 'v.mp4'), { kind: 'file' }, null, 'junk'] }, RUN));
  A.eq(out.rows.map(r => r.path), ['src/a.md', 'Src/b.md', 'ok.png'], 'a Windows path is converted by whole segments, case-blind, with either separator; its tail keeps its own spelling');
  A.eq(out.skipped.map(s => s.why), ['outside-root', 'outside-root', 'outside-root', 'outside-root', 'outside-root', 'outside-root', 'unknown', 'empty', 'unknown', 'unknown'],
    'the rest are reported with a reason: a sibling folder that merely starts with the root, a dot-dot, the root itself, a trailing slash, UNC and another drive are all outside it; a video record, no path, null and junk are not files (a message record is not reported)');
}
{
  const f = fresh(), out = Delivery.fileRows(f.store, Object.assign({ root: POSIX, artifacts: [
    rec('file', POSIX + '/src/a.md'), rec('file', POSIX.toUpperCase() + '/b.md'), rec('file', POSIX + 'x/c.md'), rec('file', POSIX + '/./d.md')] }, RUN));
  A.eq(out.rows.map(r => r.path), ['src/a.md'], 'a POSIX root compares exactly: case, a longer sibling name and a dot segment are not inside it');
  const none = Delivery.fileRows(f.store, Object.assign({}, RUN, { runId: 'run-00000002', artifacts: [rec('file', '/abs/x.md'), rec('file', 'C:\\x.md')] }));
  A.eq([none.rows.length, none.skipped.map(s => s.why)], [0, ['absolute', 'drive']], 'with no root an absolute path is never converted');
}
{
  const f = fresh(), out = Delivery.fileRows(f.store, Object.assign({ artifacts: [rec('file', 'a.md', { cut: true }), rec('file', 'b.md', { failed: true }), rec('file', 'c.md', { ok: false }), rec('file', 'd.md', { error: 'boom' }), rec('file', 'e.md'), rec('image', 'e.md'), rec('image', 'f.png')] }, RUN));
  A.eq(out.rows.map(r => r.path), ['e.md', 'f.png'], 'a cut or failed record never becomes a row, and one exact path is one row whichever tool wrote it');
  A.eq(out.skipped.map(s => s.why), ['cut', 'failed', 'failed', 'failed'], 'with its reason');
  A.eq(f.store.view('proof', 'chat', { complete: true }).map(r => r.deliverable.artifactId), ['file_e.md', 'img_f.png'], 'the id prefix follows the artifact kind');
}
{
  const f = fresh(), names = Delivery.fileRows(f.store, Object.assign({ artifacts: [rec('file', 'out/main.md'), rec('file', 'out/side.md'), rec('file', 'RAW_SECRET.txt')], note: { title: 'The Q3 report', main: 'out/main.md' } }, RUN));
  A.eq(f.store.view('proof', 'chat', { complete: true }).map(r => [r.deliverable.name, r.content]), [['The Q3 report', 'saved The Q3 report'], ['side.md', 'saved side.md'], ['[redacted-key].txt', 'saved [redacted-key].txt']], 'the note names only the file it proves; every other row is named by its basename, redacted');
  A.eq(names.rows.map(r => r.path), ['out/main.md', 'out/side.md', 'RAW_SECRET.txt'], 'and no path is ever the note\'s or redacted');
  const g = fresh(), big = Array.from({ length: 60 }, (_, i) => rec('file', 'f' + i + '.md'));
  const cap = Delivery.fileRows(g.store, Object.assign({ artifacts: big }, RUN));
  A.eq([cap.rows.length, cap.skipped.filter(s => s.why === 'capacity').length], [50, 10], 'a run is bounded at the collector\'s 50 files, and says what it left out');
}

/* ---- failures are never successes ---- */
const thrown = fn => { try { fn(); return null; } catch (error) { return error; } };
{
  const f = fresh(), calls = [];
  const unreadable = Object.assign({}, f.store, { view(name, stream, opts) { calls.push([name, stream, opts]); throw new Error('proof unavailable'); } });
  A.ok(/proof unavailable/.test(thrown(() => Delivery.fileRows(unreadable, Object.assign({ artifacts: [rec('file', 'a.md')] }, RUN))).message), 'unvouched history never authorizes an append');
  A.eq(f.io.streamRows('chat'), 0, 'proof failure has no mutation');
  A.eq(calls, [['proof', 'chat', { sourceRunId: RUN.runId, complete: true }]], 'the writer proves the whole run-scoped stream before it writes');
  A.ok(!!thrown(() => Delivery.fileRows(Object.assign({}, f.store, { view: () => null }), Object.assign({ artifacts: [rec('file', 'a.md')] }, RUN))), 'a non-array proof is unknown, not empty');
  const spy = [], quiet = Object.assign({}, f.store, { view(...args) { spy.push(args); return f.store.view(...args); } });
  A.eq(Delivery.fileRows(quiet, Object.assign({ artifacts: [rec('message', undefined, { target: 'x' }), rec('file', '../no.md')] }, RUN)).rows, [], 'nothing eligible: nothing written');
  A.eq(spy.length, 0, 'and nothing to prove, so no stream read');
  for (const [label, patch] of [['stream', { streamId: '../other' }], ['agent', { agentId: 'a b' }], ['run', { runId: '' }], ['short run', { runId: 'r1' }], ['long run', { runId: 'r'.repeat(201) }], ['artifacts', { artifacts: 'a.md' }],
    ['root unc', { root: '\\\\h\\s' }], ['root relative', { root: 'proj' }], ['taint', { taint: 5 }], ['note', { note: 'x' }]]) {
    A.ok(!!thrown(() => Delivery.fileRows(f.store, Object.assign({ artifacts: [rec('file', 'a.md')] }, RUN, patch))), 'invalid input refuses before any write: ' + label);
  }
  A.eq(f.io.streamRows('chat'), 0, 'invalid input wrote nothing');
}
{
  const f = fresh(), real = f.io.appendDurable;
  f.io.appendDurable = () => { throw new Error('injected strict append failure'); };
  const error = thrown(() => Delivery.fileRows(f.store, Object.assign({ artifacts: [rec('file', 'a.md')] }, RUN)));
  A.ok(/strict append/.test(error.message) && error.rows.length === 0, 'a strict append failure propagates');
  A.eq(f.io.streamRows('chat'), 0, 'and leaves no durable row');
  f.io.appendDurable = real;
  A.eq(Delivery.fileRows(f.store, Object.assign({ artifacts: [rec('file', 'a.md')] }, RUN)).rows.length, 1, 'the next proved attempt recovers');
}
{
  // a strict append failure leaves a gap in memory that only the disk reader can prove past, so this leg is on the real store
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-files-partial-'));
  let io;
  try {
    io = makeSegmentedTranscriptIo({ fs, path, root: dir, segmentBytes: 4096, onWarning() {}, schedule() {} });
    const store = Store.makeTranscriptStore({ io, clock: { now: () => 20 } }), real = io.appendDurable;
    let n = 0;
    io.appendDurable = function (row) { if (++n === 2) throw new Error('second append fails'); return real.call(io, row); };
    const input = Object.assign({ artifacts: [rec('file', 'a.md'), rec('file', 'b.md'), rec('file', 'c.md')] }, RUN);
    const error = thrown(() => Delivery.fileRows(store, input));
    A.eq([error.message, error.rows.map(r => r.path)], ['second append fails', ['a.md']], 'a partial run reports what landed before the failure');
    io.appendDurable = real;
    const retry = Delivery.fileRows(store, input);
    A.eq(retry.rows.map(r => [r.path, r.existed]), [['a.md', true], ['b.md', false], ['c.md', false]], 'the retry writes only the rest');
    A.eq(store.view('proof', 'chat', { complete: true }).map(r => r.deliverable.path), ['a.md', 'b.md', 'c.md'], 'with no duplicate');
  } finally { if (io) io.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
{
  const f = fresh(), input = Object.assign({ artifacts: [rec('file', 'a.md'), rec('file', 'b.md')] }, RUN);
  const first = Delivery.fileRows(f.store, input);
  f.store.appendStrict({ streamId: 'chat', agentId: 'agent', role: 'system', kind: 'deliverable', content: 'saved a.md', sourceRunId: RUN.runId, turnId: Kinds.runTurnId(RUN.runId), deliverable: field({ path: 'a.md', name: 'a.md', artifactId: 'file_a.md' }) });
  const count = f.io.streamRows('chat');
  A.ok(!!thrown(() => Delivery.fileRows(f.store, input)), 'two rows for one exact path make the stream ambiguous');
  A.eq(f.io.streamRows('chat'), count, 'and it writes nothing more');
  const g = fresh(), one = Delivery.fileRows(g.store, Object.assign({ artifacts: [rec('file', 'a.md')] }, RUN));
  g.io.appendDurable({ streamId: 'other', agentId: 'agent', rowId: one.rows[0].rowId, role: 'assistant', content: 'collided identity', ts: 20 });
  const reopened = open(g.io);
  A.ok(!!thrown(() => Delivery.fileRows(reopened, Object.assign({ artifacts: [rec('file', 'a.md')] }, RUN))), 'a globally collided row id cannot claim a published file');
  const h = fresh(), wrote = Delivery.fileRows(h.store, Object.assign({ artifacts: [rec('file', 'a.md')], root: WIN }, RUN));
  A.ok(!!thrown(() => Delivery.fileRows(h.store, Object.assign({ artifacts: [rec('file', 'a.md')], root: '' }, RUN))), 'the same path under another root is a conflicting identity');
  A.ok(!!thrown(() => Delivery.fileRows(h.store, Object.assign({ artifacts: [rec('file', 'a.md')], root: WIN }, RUN, { agentId: 'vex' }))) || h.io.streamRows('chat') > 1, 'and another agent writing it cannot reuse the row');
  A.eq(wrote.rows.length, 1, 'fixture: the row was written');
  void first;
}
{
  const f = fresh(), input = Object.assign({ artifacts: [rec('file', 'a.md')] }, RUN), first = Delivery.fileRows(f.store, Object.assign({ taint: 'web page' }, input));
  A.ok(!!thrown(() => Delivery.fileRows(f.store, Object.assign({ taint: null }, input))), 'a retry cannot relabel a proven tainted file as clean');
  A.ok(!!thrown(() => Delivery.fileRows(f.store, Object.assign({ taint: 'another source' }, input))), 'or tainted by another source');
  A.eq(Delivery.fileRows(f.store, Object.assign({ taint: 'web page' }, input)).rows[0].rowId, first.rows[0].rowId, 'the same source is idempotent');
  A.eq(Delivery.fileRows(f.store, input).rows[0].rowId, first.rows[0].rowId, 'a retry that names no provenance only confirms the row');
  const g = fresh(), clean = Delivery.fileRows(g.store, Object.assign({ taint: null }, input));
  A.ok(!!thrown(() => Delivery.fileRows(g.store, Object.assign({ taint: 'new evidence' }, input))), 'nor can a clean row prove a tainted source');
  A.eq(g.store.view('proof', 'chat', { complete: true }).map(r => [r.taint, r.taintKnown]), [[undefined, true]], 'an explicit null is the existing known-clean stamp');
  void clean;
  const u = fresh();
  f.store.retract({ streamId: 'chat', rowIds: [first.rows[0].rowId], reason: 'undo' });
  const count = f.io.streamRows('chat');
  A.eq(Delivery.fileRows(f.store, input).rows.map(r => r.existed), [true], 'an undone file stays undone: the retry confirms the row and cannot resurrect it');
  A.eq(f.io.streamRows('chat'), count, 'and writes nothing');
  A.eq(f.store.view('display', 'chat', { limit: 20 }), [], 'the undone chip is not displayed');
  void u;
}

/* ---- visibility: shown, never replayed, never an owner's words ---- */
{
  const f = fresh(), reply = f.store.appendStrict({ streamId: 'chat', agentId: 'agent', role: 'assistant', content: 'Made your report.', sourceRunId: RUN.runId, turnId: Kinds.runTurnId(RUN.runId) });
  const out = Delivery.fileRows(f.store, Object.assign({ artifacts: [rec('file', 'private-dir/inner/report.md'), rec('image', 'pics/cover.png')] }, RUN));
  const ids = out.rows.map(r => r.rowId);
  A.eq(f.store.view('display', 'chat', { limit: 20 }).map(r => r.rowId), [reply.rowId].concat(ids), 'display shows the reply and each file chip, in order');
  A.eq(f.store.view('model-replay', 'chat', { limit: 20, shape: 'prose' }).map(m => m.content), ['Made your report.'], 'model replay holds the reply and not the files');
  A.eq(f.store.view('model-replay', 'chat', { limit: 20, shape: 'pairs' }).map(m => m.content), ['Made your report.'], 'in either shape');
  A.eq(f.store.view('owner-evidence', 'chat', { limit: 20 }).map(r => r.rowId), [], 'a file row is never owner evidence');
  const recall = f.store.view('recall', 'chat', { op: 'search', query: 'saved report' });
  A.ok(recall.some(r => r.rowId === ids[0]), 'recall finds the file by its display prose');
  A.ok(recall.every(r => !/private-dir|inner/.test(r.content)), 'and the prose never carries the path\'s folders');
  A.eq(Kinds.MATRIX.deliverable, { 'model-replay': false, 'owner-evidence': false, recall: true, display: true, proof: true }, 'the visibility matrix says exactly that');
  A.eq(Merge.windowRows(f.store.view('display', 'chat', { limit: 20 }), { window: 'legacy' }).map(r => r.rowId), [reply.rowId], 'and the page\'s rollback window drops the file rows too');
  A.eq(Merge.windowRows(f.store.view('display', 'chat', { limit: 20 }), { window: 'shadow' }).map(r => r.rowId), [reply.rowId], 'as does the shadow/id window');
}

/* ---- the one page adapter ---- */
{
  const f = fresh(), out = Delivery.fileRows(f.store, Object.assign({ root: POSIX, artifacts: [rec('file', 'src/\u00b7a.md'), rec('image', 'x.png')] }, RUN));
  const rows = f.store.view('display', 'chat', { limit: 20 });
  A.eq(rows.map(Merge.deliverableOf), [
    { title: 'src/\u00b7a.md', kind: 'file', runId: RUN.runId, t: 20, agentId: 'agent', root: POSIX, rowId: out.rows[0].rowId },
    { title: 'x.png', kind: 'image', runId: RUN.runId, t: 20, agentId: 'agent', root: POSIX, rowId: out.rows[1].rowId }], 'a canonical row becomes the page record: exact title, media kind, run, time, writing agent, root, row id');
  for (const not of [null, undefined, 5, 'x', {}, { kind: 'turn', role: 'assistant', content: 'saved a.md' }, { kind: 'deliverable', content: 'saved a.md' }, Object.assign({}, rows[0], { deliverable: field({ path: '../x' }) }), Object.assign({}, rows[0], { deliverable: null })]) {
    A.eq(Merge.deliverableOf(not), null, 'nothing else is a file row (and nothing is repaired): ' + String(JSON.stringify(not)).slice(0, 50));
  }
  const live = { title: 'src/\u00b7a.md', runId: RUN.runId }, same = Kinds.sameDeliverable;
  A.ok(same(live, Merge.deliverableOf(rows[0])), 'the live record of the same run and path is the same file');
  A.ok(!same(live, Object.assign({}, Merge.deliverableOf(rows[0]), { runId: 'other-run-0001' })), 'another run is another file');
  A.ok(!same({ title: 'a.md', runId: '' }, { title: 'a.md', runId: '' }), 'with no run there is nothing to match on');
  A.ok(!same(live, Object.assign({}, live, { title: 'src/a.md' })), 'a different path is a different file');
  A.ok(same({ title: POSIX + '/src/\u00b7a.md', runId: RUN.runId }, Merge.deliverableOf(rows[0])), 'an absolute live title is the converted row when it is root + path');
  A.ok(!same({ title: POSIX + 'x/src/\u00b7a.md', runId: RUN.runId }, Merge.deliverableOf(rows[0])), 'but not a sibling folder that merely starts with the root');
  A.ok(same({ title: 'C:\\Users\\Me\\Proj\\x.png', runId: 'r-1' }, { title: 'x.png', runId: 'r-1', root: 'c:/users/me/proj' }), 'a Windows root is case-blind and separator-blind');
}

/* ---- the same, on the real disk store: a cold complete proof, across a restart ---- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-files-proof-'));
  let io;
  try {
    const openDisk = () => { io = makeSegmentedTranscriptIo({ fs, path, root: dir, segmentBytes: 1024, onWarning() {}, schedule() {} }); return Store.makeTranscriptStore({ io, clock: { now: () => 20 }, limit: 1, ramPerStream: 1 }); };
    let store = openDisk();
    const input = Object.assign({ root: WIN, artifacts: [rec('file', 'report \u00b7 v2.md'), rec('file', WIN + '\\src\\b.md'), rec('image', 'a \u00b7 b.png'), rec('file', 'clip.mp3'), rec('file', 'clip.mp4')] }, RUN);
    const first = Delivery.fileRows(store, input);
    A.eq(first.rows.map(r => r.path), ['report \u00b7 v2.md', 'src/b.md', 'a \u00b7 b.png', 'clip.mp3', 'clip.mp4'], 'on disk: every exact path is written');
    for (let n = 0; n < 30; n++) store.appendStrict({ streamId: 'chat', agentId: 'agent', role: 'assistant', content: 'later ' + n + ' ' + 'x'.repeat(200) });
    io.close(); store = openDisk();
    A.eq(store.count(), 1, 'the restarted store holds only the newest row in memory');
    const again = Delivery.fileRows(store, input);
    A.eq(again.rows.map(r => [r.rowId, r.existed]), first.rows.map(r => [r.rowId, true]), 'a cold complete proof finds every file beyond the recent tail');
    const rows = store.view('proof', 'chat', { complete: true }).filter(r => r.kind === 'deliverable');
    A.eq(rows.map(r => [r.deliverable.path, r.deliverable.media, r.deliverable.root]), [['report \u00b7 v2.md', 'file', WIN], ['src/b.md', 'file', WIN], ['a \u00b7 b.png', 'image', WIN], ['clip.mp3', 'audio', WIN], ['clip.mp4', 'video', WIN]], 'the disk round trip keeps path, media and root exactly');
    const segments = fs.readdirSync(dir).filter(name => /^segment-.*\.jsonl$/.test(name)).sort();
    const file = path.join(dir, segments[0]), bytes = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('!'), bytes.subarray(1)]));
    const size = io.streamRows('chat');
    A.ok(!!thrown(() => Delivery.fileRows(store, Object.assign({}, input, { runId: 'run-00000009' }))), 'a damaged closed segment refuses instead of treating the run\'s files as absent');
    A.eq(io.streamRows('chat'), size, 'and appends nothing');
  } finally { if (io) io.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

A.report('turn-delivery.files');
