/* node test/update-snapshot-framing.test.js — the pre-update recovery point's JSON TEXT is bounded, not just its bytes.

   A recovery bundle is one JSON string and V8 caps a string at ~536.8M chars. The first budget (update-snapshot-budget)
   counted only file CONTENTS (256 MiB = ~358M base64 chars), but every file row also costs ~330 chars of JSON framing
   (path, sha256, categories, indentation) and every left-out row ~200: a station of ~540k small node_modules files, or
   ~150k included + ~665k left out, still overflowed the cap with every byte inside the budget, and the update stopped
   at 'Pre-update recovery point failed' exactly as before. capture() now charges every row's exact text against
   maxChars, folds the left-out list past SKIP_ROWS_LISTED rows into one row per folder, and does the same for the rows
   the walk itself produces (symlinks, policy skips). The station here is in memory (an injected fs), scaled down:
   maxChars 2M instead of BUNDLE_MAX_CHARS, so 9000 small files reach the same limit 500k would. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { constants: bufferConstants } = require('node:buffer');
const R = require('../sidecar/station-recovery.js');
const Prep = require('../sidecar/update-preparation.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');

const REASON = 'too large for the pre-update recovery point';
const SYMLINK = 'link not followed: it points inside the station or at nothing';
const LISTED = R.SKIP_ROWS_LISTED;

// ---- an in-memory station: just the fs calls capture() makes
function memFs(root) {
  const files = new Map(), dirs = new Map(), links = new Set(), busy = new Set();
  const key = p => path.resolve(p).toLowerCase();
  function addDir(abs) {
    const k = key(abs);
    if (dirs.has(k)) return;
    dirs.set(k, new Set());
    const parent = path.dirname(abs);
    if (key(parent) !== k && key(abs) !== key(root)) { addDir(parent); dirs.get(key(parent)).add(path.basename(abs)); }
  }
  addDir(root);
  function put(rel, data, kind) {
    const abs = path.join(root, ...rel.split('/'));
    addDir(path.dirname(abs));
    dirs.get(key(path.dirname(abs))).add(path.basename(abs));
    files.set(key(abs), Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    if (kind === 'link') links.add(key(abs));
    if (kind === 'busy') busy.add(key(abs));
  }
  const nope = (code, p) => Object.assign(new Error(code + ': ' + p), { code });
  const stat = abs => {
    const k = key(abs);
    if (dirs.has(k)) return { isDirectory: () => true, isSymbolicLink: () => false, size: 0 };
    if (files.has(k)) return { isDirectory: () => false, isSymbolicLink: () => links.has(k), size: files.get(k).length };
    throw nope('ENOENT', abs);
  };
  return {
    put,
    fs: {
      existsSync: abs => dirs.has(key(abs)) || files.has(key(abs)),
      statSync: stat,
      lstatSync: stat,
      readdirSync: abs => { const d = dirs.get(key(abs)); if (!d) throw nope('ENOENT', abs); return Array.from(d); },
      readFileSync: abs => {
        const k = key(abs);
        if (busy.has(k)) throw nope('EBUSY', abs);
        if (!files.has(k)) throw nope(dirs.has(k) ? 'EISDIR' : 'ENOENT', abs);
        return Buffer.from(files.get(k));
      }
    }
  };
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-snapshot-framing-'));
const ws = path.join(sandbox, 'workspaces');
fs.mkdirSync(ws, { recursive: true });
const mem = memFs(ws);
const TINY = 6000, BIGN = 3000, LINKS = 2500;
mem.put('agent.roster.json', JSON.stringify({ version: 1, agents: [{ agentId: 'agent' }, { agentId: 'coder' }] }));
mem.put('agent.save.json', JSON.stringify({ version: 1, agentId: 'agent', updatedAt: 1, doc: { agent: { id: 'agent' } } }));
mem.put('coder.save.json', JSON.stringify({ version: 1, agentId: 'coder', updatedAt: 1, doc: { agent: { id: 'coder' } } }));
mem.put('transcript.jsonl', JSON.stringify({ role: 'user', content: 'keep me' }) + '\n');
// a sanitized store: re-printed (larger than on disk) and carrying redactions + reauthentication rows
mem.put('connectors/servicekeys.json', JSON.stringify({ version: 1, keys: [{ id: 'openai', key: 'sk-FRAMING-SECRET' }, { id: 'brave', key: 'BSA-FRAMING-SECRET' }] }));
// coding agents' node_modules: thousands of small files, thousands of larger ones, a .bin full of symlinks
for (let i = 0; i < TINY; i++) mem.put('coder/webapp-' + (i % 7) + '/node_modules/@scope/package-' + i + '/dist/index.min.js', Buffer.alloc(100, 97));
for (let i = 0; i < BIGN; i++) mem.put('coder/webapp-' + (i % 7) + '/node_modules/@scope/package-' + i + '/dist/bundle.full.js', Buffer.alloc(5000, 98));
for (let i = 0; i < LINKS; i++) mem.put('coder/webapp-' + (i % 7) + '/node_modules/.bin/tool-' + i, 'link', 'link');
// a torn station store whose last-known-good .bak is bigger than the whole byte budget: left out, with no "promoted" claim. It sits at the top level: an agent's own state.json and its .bak are that agent's files, and ride as they are
mem.put('station-state.json', '');
mem.put('station-state.json.bak', JSON.stringify({ pad: 'z'.repeat(1536 * 1024) }));
// a locked file: its 'unreadable' receipt rides, the file does not
mem.put('coder/locked.txt', 'locked', 'busy');
const CANDIDATES = 4 + 1 + TINY + BIGN + 2;   // saves/roster/transcript + the sanitized store + node_modules + state.json + locked.txt

const maxBytes = 1024 * 1024;
const maxChars = 2000000;

(async () => {
  try {
    // ---- 1. the whole bundle text stays under maxChars, though every small file's BYTES would fit
    const b = R.capture({ workspaceRoot: ws, fs: mem.fs, now: 1, maxBytes, maxChars, browserStore: { 'starnet.save': JSON.stringify({ version: 5 }) } });
    const text = JSON.stringify(b, null, 2) + '\n';
    A.ok(text.length <= maxChars, 'the bundle text (' + text.length + ' chars) stays within maxChars ' + maxChars);
    A.ok(text.length >= maxChars * 0.6, 'and the limit is used, not wasted on a loose estimate (' + text.length + ' chars)');
    const fileBytes = b.files.reduce((n, f) => n + f.bytes, 0);
    A.ok(fileBytes < maxBytes / 2, 'it was the TEXT that ran out, not the byte budget (' + fileBytes + ' bytes of files)');
    const has = rel => b.files.some(f => f.path === rel);
    for (const rel of ['agent.save.json', 'coder.save.json', 'agent.roster.json', 'transcript.jsonl', 'connectors/servicekeys.json']) A.ok(has(rel), rel + ' rides first');
    A.ok(b.files.length > 500 && b.files.length < CANDIDATES - 1000, 'some small node_modules files ride, thousands do not (' + b.files.length + ' files)');
    const keys = b.files.find(f => f.path === 'connectors/servicekeys.json');
    A.ok(keys && keys.redactedFields.length === 2 && Buffer.from(keys.data, 'base64').toString().indexOf('FRAMING-SECRET') < 0, 'the sanitized store rides redacted');
    A.ok(b.report.reauthentication.some(r => r.kind === 'service-key' && r.id === 'openai'), 'with its reauthentication rows');

    // ---- 2. the left-out list is bounded: the largest SKIP_ROWS_LISTED by name, the rest one row per folder
    const out = b.report.skipped.filter(s => s.reason === REASON);
    const listed = out.filter(s => !(Number(s.files) > 0));
    const folded = out.filter(s => Number(s.files) > 0);
    A.eq(listed.length, LISTED, 'exactly SKIP_ROWS_LISTED left-out files are listed by name');
    A.ok(folded.length > 0 && folded.length <= 8, 'the rest fold into one row per folder (' + folded.length + ' rows)');
    A.ok(folded.every(s => /\/\*\*$/.test(s.path) && s.bytes > 0), 'a folded row names its folder and carries its bytes');
    const leftOut = out.reduce((n, s) => n + (Number(s.files) || 1), 0);
    A.eq(leftOut + b.files.length + 1, CANDIDATES, 'every file is either in the bundle, left out (counted), or unreadable');
    const minListed = Math.min(...listed.map(s => s.bytes));
    A.ok(folded.every(s => s.bytes / s.files <= minListed), 'the files listed by name are the largest ones');
    const state = out.find(s => s.path === 'station-state.json');
    A.ok(state && state.bytes > maxBytes, 'the torn store whose .bak is over the budget is left out with the .bak\'s size');
    A.eq(b.report.skipped.some(s => s.path === 'station-state.json.bak' && /^promoted/.test(s.reason)), false, 'and no row claims its .bak was captured');
    A.ok(b.report.skipped.some(s => s.path === 'coder/locked.txt' && s.reason === 'unreadable: EBUSY'), 'the locked file keeps its unreadable receipt');

    // ---- 3. the walk's own rows (a .bin full of symlinks) are bounded the same way
    const links = b.report.skipped.filter(s => s.reason === SYMLINK);
    A.ok(links.length <= LISTED + 8, 'symlink rows are bounded (' + links.length + ' rows for ' + LINKS + ' links)');
    A.eq(links.reduce((n, s) => n + (Number(s.files) || 1), 0), LINKS, 'and still account for every link');

    // ---- 4. it validates, writes and reads back verified
    A.eq(R.validate(b).ok, true, 'the bounded bundle validates');
    const file = path.join(sandbox, 'out', 'framing.starnet-backup.json');
    const written = R.writeBundleAtomic({ bundle: b, file, allowIncomplete: true });
    A.ok(written.bytes <= maxChars, 'the file written is within the limit (' + written.bytes + ' bytes, all ASCII)');
    A.eq(R.readBundle(file).manifestSha256, written.manifestSha256, 'and reads back verified');

    // ---- 5. an explicit export (no budget) is unchanged: every file, every row by name
    const full = R.capture({ workspaceRoot: ws, fs: mem.fs, now: 1 });
    A.eq(full.files.length, CANDIDATES - 1, 'without a budget every readable file is exported');
    A.eq(full.report.skipped.filter(s => s.reason === SYMLINK).length, LINKS, 'and every symlink is listed by name');
    A.eq(full.report.skipped.some(s => s.reason === REASON || Number(s.files) > 0), false, 'nothing is left out or folded');
    A.ok(full.report.skipped.some(s => s.path === 'station-state.json.bak' && /^promoted/.test(s.reason)), 'and the torn store is promoted from its .bak as before');

    // ---- 6. prepare hands its text limit through and the receipt counts folded rows as files
    let clock = 9000;
    const memRecovery = Object.assign({}, R, { capture: opts => R.capture(Object.assign({}, opts, { fs: mem.fs })) });
    const prep = Prep.makeUpdatePreparation({
      fs, path, recovery: memRecovery, writeDurable: writeFileDurable, workspaceRoot: ws,
      now: () => clock, newId: () => 'framing', appVersion: () => '0.14.0', snapshotBudgetBytes: maxBytes, snapshotBudgetChars: maxChars,
      sleep: async () => { clock += 25; }
    });
    const made = await prep.prepare({ targetVersion: '0.14.1', browserStore: {} });
    A.eq(made.ok, true, 'a station of many small files gets its verified recovery point');
    A.ok(made.receipt && made.receipt.snapshot.bytes <= maxChars, 'within the text limit (' + (made.receipt && made.receipt.snapshot.bytes) + ')');
    const tl = made.receipt && made.receipt.tooLarge;
    A.ok(tl && tl.files > LISTED, 'the receipt counts every left-out file, folded ones included (' + (tl && tl.files) + ')');
    A.ok(tl && tl.paths.length <= 200 && tl.paths.some(p => p.files > 0), 'and lists the largest rows, a folded one with its file count');
    prep.cancel();

    // ---- 7. the real default leaves headroom under V8's string cap
    A.ok(R.BUNDLE_MAX_CHARS + 32 * 1024 * 1024 < bufferConstants.MAX_STRING_LENGTH, 'BUNDLE_MAX_CHARS (' + R.BUNDLE_MAX_CHARS + ') stays well under MAX_STRING_LENGTH ' + bufferConstants.MAX_STRING_LENGTH);
    let seen = null;
    const spy = Object.assign({}, memRecovery, { capture: opts => { seen = opts; return memRecovery.capture(opts); } });
    const prepDefault = Prep.makeUpdatePreparation({
      fs, path, recovery: spy, writeDurable: writeFileDurable, workspaceRoot: ws,
      now: () => clock, newId: () => 'framing-default', sleep: async () => { clock += 25; }
    });
    const madeDefault = await prepDefault.prepare({ targetVersion: '0.14.1', browserStore: {} });
    A.eq(madeDefault.ok, true, 'prepare with the defaults succeeds');
    A.eq(seen && seen.maxChars, undefined, 'and leaves the text limit to station-recovery\'s default');
    prepDefault.cancel();

    A.report('update-snapshot-framing.test');
  } finally {
    const dir = path.join(sandbox, 'update-snapshots');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      try { fs.chmodSync(path.join(dir, name), 0o666); } catch (e) { console.log('chmod ' + name + ': ' + e.code); }
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
