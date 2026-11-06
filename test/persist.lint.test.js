'use strict';
/* node test/persist.lint.test.js — no sidecar file writes, renames or copies a file directly where sidecar/persist
   should do it (INV-7, lane persist-module).

   THE HOLE THIS CLOSES (2026-11-03): the same write, read and quarantine code lived four times (durable-write.js,
   durable-store.js, savestore.js, channels/store.js) plus one-off writers in run-journal.js, deliverable-store.js and
   workspace-recovery.js, and each copy grew its own defect: a temp a failed rename left behind (bug 75558694), a
   quarantine that overwrote the first incident's bytes (e862d9ff), a locked file read as empty and then replaced
   (34c58f4f). The persist lane moved them onto one owner. This lint keeps a new copy from growing back.

   A SITE is a call of a writer, with comments stripped:
     - writeFileSync(, renameSync(, copyFileSync(, appendFileSync( on any receiver or bare, also through .call(,
       .apply( or .bind( (the names are fs's alone);
     - writeFile(, rename(, appendFile(, copyFile( on an fs-shaped receiver: fs (the callback API), fs.promises, fsp or
       any name ending in Fsp, fsPromises, promises, or require('fs' | 'node:fs' | 'fs/promises' | 'node:fs/promises');
       and the bare call of one of those names that the file destructures from such a receiver.
   Not counted, on purpose: a writer handed around as a value (const w = fs.writeFileSync; keep writers called where
   they are used), writes through an open fd or FileHandle (writeSync, handle.writeFile: the exclusive-create writers
   that own their protocol), and unlink/rm (removal is not a replace). Strings are code here: a child's -e script that
   writes counts.

   Laws, over every sidecar source file that test/helpers/source.js reads, except sidecar/persist/** (the owner):
     W1 a file's site count equals its BASELINE row (0 when it has no row): a new site fails and names persist as the
        way to write instead;
     W2 the five migrated stores stay at 0 and may never get a row;
     W3 no row is stale: every row names a file on disk, and a row above reality fails (lower it in the same commit);
     W4 the alternative the message names exists: persist exports writeAtomic, replaceJson, moveAside and preserve.
   The detector proves itself on fixtures below, and the comment stripper proves on every scanned file that it never
   eats code (the stripped text still compiles). */
const vm = require('node:vm');
const A = require('./_assert.js');
const { sidecarSourceFiles } = require('./helpers/source.js');

/* ---- the comment stripper: comments to spaces, newlines kept, every other character where it was ----
   A small lexer, not a regex: it steps over '...', "...", `...` (with ${ } nested inside) and regex literals before it
   looks for // or /*, so a // in a URL string or a /* in a regex cannot blank the code after it. A / opens a regex where
   an expression may start (after an operator, an opening bracket, or a keyword such as return); after a name, a
   number, ) or ] it is a division. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await']);
const isWord = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95;
function regexEnd(s, i) {
  let inClass = false;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s.charCodeAt(j);
    if (ch === 10) return -1;
    if (ch === 92) { j++; continue; }
    if (inClass) { if (ch === 93) inClass = false; continue; }
    if (ch === 91) inClass = true;
    else if (ch === 47) { j++; while (j < s.length && isWord(s.charCodeAt(j))) j++; return j; }
  }
  return -1;
}
function stringEnd(s, i, quote) {
  for (let j = i + 1; j < s.length; j++) {
    const ch = s.charCodeAt(j);
    if (ch === 92) { j++; continue; }
    if (ch === quote) return j + 1;
    if (ch === 10) return j;   // unterminated: stop at the line end rather than swallow the file
  }
  return s.length;
}
function decomment(src) {
  const s = String(src), n = s.length, out = [];
  let from = 0;
  const blank = (a, b) => { out.push(s.slice(from, a), s.slice(a, b).replace(/[^\n]/g, ' ')); from = b; };
  // what the last token was: 0 an operator or nothing (a / starts a regex), 1 a value (a / divides), 2 a word
  let i = 0, prev = 0, wordAt = 0, wordEnd = 0, depth = 0, inTemplate = false;
  const exprDepth = [];   // the { } depth at which each open ${ hands back to its template literal
  if (s.startsWith('#!')) { i = s.indexOf('\n'); if (i < 0) i = n; blank(0, i); }
  while (i < n) {
    if (inTemplate) {
      let j = i;
      while (j < n) { const ch = s.charCodeAt(j); if (ch === 96 || (ch === 36 && s.charCodeAt(j + 1) === 123)) break; j += ch === 92 ? 2 : 1; }
      if (j >= n) { i = n; break; }
      if (s.charCodeAt(j) === 96) { i = j + 1; inTemplate = false; prev = 1; continue; }
      i = j + 2; exprDepth.push(depth); depth++; inTemplate = false; prev = 0;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c === 47) {
      const d = s.charCodeAt(i + 1);
      if (d === 47) { let e = s.indexOf('\n', i); if (e < 0) e = n; blank(i, e); i = e; continue; }
      if (d === 42) { let e = s.indexOf('*/', i + 2); e = e < 0 ? n : e + 2; blank(i, e); i = e; continue; }
      if (prev === 0 || (prev === 2 && REGEX_AFTER_WORD.has(s.slice(wordAt, wordEnd)))) {
        const e = regexEnd(s, i);
        if (e > 0) { i = e; prev = 1; continue; }
      }
      i++; prev = 0; continue;
    }
    if (c === 39 || c === 34) { i = stringEnd(s, i, c); prev = 1; continue; }
    if (c === 96) { i++; inTemplate = true; continue; }
    if (isWord(c)) { let j = i + 1; while (j < n && isWord(s.charCodeAt(j))) j++; wordAt = i; wordEnd = j; i = j; prev = 2; continue; }
    i++;
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    if (c === 123) { depth++; prev = 0; continue; }
    if (c === 125) {
      if (exprDepth.length && exprDepth[exprDepth.length - 1] === depth - 1) { exprDepth.pop(); depth--; inTemplate = true; continue; }
      depth--; prev = 0; continue;
    }
    prev = (c === 41 || c === 93) ? 1 : 0;
  }
  out.push(s.slice(from));
  return out.join('');
}

/* ---- the detector ---- */
const SYNC_CALL = /(?<![\w$])(writeFileSync|renameSync|copyFileSync|appendFileSync)\s*(?:\.\s*(?:call|apply|bind)\s*)?\(/g;
const FS_RECEIVER = String.raw`(?:(?<![\w$])(?:fs|fsp|fsPromises|promises|[A-Za-z_$][\w$]*Fsp)|require\(\s*['"](?:node:)?fs(?:/promises)?['"]\s*\))(?:\s*\.\s*promises)?`;
const ASYNC_CALL = new RegExp(FS_RECEIVER + String.raw`\s*\.\s*(writeFile|rename|appendFile|copyFile)\s*(?:\.\s*(?:call|apply|bind)\s*)?\(`, 'g');
const DESTRUCTURE = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*` + FS_RECEIVER + String.raw`(?![\w$.])`, 'g');
const ASYNC_NAMES = new Set(['writeFile', 'rename', 'appendFile', 'copyFile']);
const SYNC_NAMES = new Set(['writeFileSync', 'renameSync', 'copyFileSync', 'appendFileSync']);
const escapeRe = s => s.replace(/[$]/g, '\\$');

// every site in one file's source: [{ line, what }]
function sites(src) {
  const code = decomment(src);
  const found = [];
  const at = (index, what) => found.push({ line: code.slice(0, index).split('\n').length, what });
  for (const m of code.matchAll(SYNC_CALL)) at(m.index, m[1]);
  for (const m of code.matchAll(ASYNC_CALL)) at(m.index, m[1]);
  const bound = new Map();   // a local name bound to a writer by destructuring -> the writer it is
  for (const m of code.matchAll(DESTRUCTURE)) {
    for (const part of m[1].split(',')) {
      const kv = /^\s*([\w$]+)\s*(?::\s*([\w$]+))?\s*(?:=[^,]*)?$/.exec(part);
      if (!kv) continue;
      const local = kv[2] || kv[1];
      if (ASYNC_NAMES.has(kv[1]) || (SYNC_NAMES.has(kv[1]) && local !== kv[1])) bound.set(local, kv[1]);
    }
  }
  for (const [local, writer] of bound) {
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])` + escapeRe(local) + String.raw`\s*\(`, 'g'))) at(m.index, writer);
  }
  return found.sort((a, b) => a.line - b.line);
}
const count = src => sites(src).length;

/* ---- the detector against fixtures (a lint whose detector is wrong locks the wrong thing) ---- */
const MUST_COUNT = [
  [1, "fs.writeFileSync(file, data);"],
  [1, "fs.writeFileSync (file, data);"],
  [1, "deps.fs.renameSync(tmp, file);"],
  [1, "F.renameSync(stage, finalDir);"],
  [1, "require('node:fs').appendFileSync(log, line);"],
  [1, "fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);"],
  [1, "fs.writeFileSync.call(fs, file, data);"],
  [1, "const put = fs.writeFileSync.bind(fs);"],
  [1, "await fsp.writeFile(abs, text, 'utf8');"],
  [1, "await fs.promises.rename(tmp, file);"],
  [1, "await shotFsp.writeFile(abs, buffer);"],
  [1, "await deps.fsp.copyFile(a, b);"],
  [1, "await require('fs/promises').appendFile(log, line);"],
  [1, "await require('node:fs').promises.writeFile(file, data);"],
  [1, "fs.writeFile(file, data, done);"],
  [1, "const { writeFile } = require('node:fs/promises');\nfunction save() { return writeFile(file, data); }"],
  [2, "const { writeFile: put, rename } = fsp;\nput(tmp, data); rename(tmp, file);"],
  [1, "const { writeFileSync: w } = require('fs');\nw(file, data);"],
  [1, "const { writeFileSync } = require('fs');\nwriteFileSync(file, data);"],
  [1, "spawn(process.execPath, ['-e', \"require('fs').writeFileSync(p, d)\"]);"],
  [1, "const u = 'http://host/'; fs.renameSync(a, b);"],
  [1, "const re = /\\/\\*/; fs.renameSync(a, b); const tail = '*/';"],
  [1, "const t = `${dir}/*.json`; fs.writeFileSync(t, d); const tail = '*/';"],
  [1, "const g = `${path.join(dir, `sub`)}//x`; fs.appendFileSync(g, d);"],
  [1, "return /https?:\\/\\//.test(u) && fs.copyFileSync(a, b);"],
  [1, "const half = total / 2; fs.renameSync(a, b); const r = x / y;"]
];
for (const [want, src] of MUST_COUNT) A.eq(count(src), want, 'the detector counts ' + want + ' site(s) in: ' + src);
const MUST_NOT = [
  "// fs.writeFileSync(file, data);",
  "/* fs.renameSync(tmp, file) */ const x = 1;",
  "/*\n * await fsp.writeFile(abs, text)\n */",
  "if (typeof fs.renameSync !== 'function') return;",
  "fs.readFileSync(file, 'utf8'); fs.unlinkSync(file); fs.mkdirSync(dir);",
  "fs.writeSync(fd, bytes, 0, n); fs.openSync(file, 'wx'); await handle.writeFile(bytes);",
  "await apps.rename(id, name); store.rename(a, b); await tabs.writeFile(x);",
  "fs.renameSyncLater(a, b); fs.writeFileSyncish(a);",
  "const writeFile = (a, b) => cache.set(a, b); writeFile(k, v);",
  "throw new Error('writeFileDurable: an injected fs with renameSync is required');",
  "const half = total / 2; // fs.renameSync(a, b)\nconst r = x / y;",
  "const u = `http://${host}/`; // fs.writeFileSync(a, b)"
];
for (const src of MUST_NOT) A.eq(count(src), 0, 'the detector counts nothing in: ' + src);
A.eq(sites("const a = 1;\n\nfs.writeFileSync(f, d);").map(s => s.line + ':' + s.what), ['3:writeFileSync'], 'a site carries its line');
A.eq(decomment("a(); // x\r\n/* y */ b();").length, "a(); // x\r\n/* y */ b();".length, 'the stripper keeps every offset');

/* ---- the audited baseline, taken at d05241c24 (persist-module S3) with the persist migration on the branch ----
   Forward-slash paths relative to sidecar/; [sites, why]. Every file not listed must be at 0. Each row is one of:
   directory activation (a staged folder renamed live, with its rollback), bundle staging, an append-only journal or
   log, a lock protocol whose atomic rename IS the lock, an agent's own files in its jail, scratch handed to another
   program, or a lane that owns its writer and has not moved onto persist yet. Those last ones move in their own lane
   (lower the row in that commit); none is ever patched here. */
const BASELINE = {
  'apps.js': [3, "own writer (apps): app.json and the app's own files in its folder"],
  'attachments.js': [1, 'own writer (attachments): an exclusive-create upload temp, synced, renamed into place'],
  'backupfile.js': [1, 'own writer: an exclusive-create (wx) backup copy, never a replace'],
  'browser-install.js': [2, 'directory activation: the staged browser install renamed live, then its current-version pointer'],
  'checkpoint-store.js': [13, 'directory activation: the git-dir reinit swap and its rollback (6); the bundle fallback writer when durable-write cannot load (2); scratch handed to Git inside the shadow git-dir, rewritten before every capture and never read back as a store (lane checkpoint-links, 4): the NUL pathspec file, info/exclude, the attributes pin and its due marker; and the one info/exclude line ensureExclude appends for the workspace repo (turn identity C12: .attachments/), a Git ignore file derived from a constant that the link walk keeps on every rewrite and that holds no session data (batch 6 integration, +1)'],
  'cli-link.js': [1, "append-only: the CLI's PATH line appended to the user's shell profile"],
  'computer-control.js': [3, 'directory activation: an extracted helper swapped in, with its backup and rollback'],
  'connector-vault.js': [2, 'own writer (connector vault): the verified exclusive recovery copy of each credential file, and its restore'],
  'credits-link.js': [3, 'own writer (credits link), not on persist yet: the link record by temp + rename (0600), and its unlink tombstone'],
  'cron-lock.js': [1, 'lock protocol: the atomic rename is the stale-lock reclaim'],
  'environment.js': [6, 'own writer (environment), not on persist yet: the cwd state and file-list records by temp + rename'],
  'index.js': [5, 'own writers: the webhook-nonce prune by temp + rename (2), workshop and export copies inside agent jails (2), the archive move of a removed agent (1)'],
  'local-voice.js': [1, 'directory activation: the existing voice-cache root migration; no file replacement'],
  'logbound.js': [1, 'append-only log: a full log rotates to <file>.1'],
  'media-service.js': [2, 'own writer (voice cache): regenerable audio by temp + rename'],
  'native-stt.js': [1, 'scratch: the WAV handed to the speech-to-text engine'],
  'plugins.js': [3, 'own writer (plugins), not on persist yet: installed plugin files and the plugins-allowed list'],
  'procledger.js': [2, 'own writer (procledger), not on persist yet: the process ledger by temp + rename'],
  'provider-accounts.js': [1, "own writer (provider accounts): a new account folder's account.json (0600)"],
  'providers/claude-cli.js': [2, 'scratch: system-prompt files handed to the Claude CLI (0600)'],
  'providers/liveprices.js': [1, 'own writer (live prices), not on persist yet: the regenerable price cache'],
  'run-journal.js': [1, "append-only journal: the repair's replace with its in-place fallback (persist owns its evidence copy, quarantine and temps)"],
  'shellhooks.js': [4, 'own writer (shell hooks), not on persist yet: hooks.json and hooks-allowed'],
  'skills/market.js': [4, "directory activation: a market skill's signed files staged, then the directory swap and its restore"],
  'skills/package.js': [2, "bundle staging: a skill package's files unpacked inside its root"],
  'spotify/store.js': [2, 'own writer (spotify), not on persist yet: the token store by temp + rename (0600)'],
  'station-recovery.js': [4, 'bundle staging: recovery bundles written through exclusive fds and renamed into place, with the busy-rename retry'],
  'subagents.js': [2, 'the bundle fallback writer, used only when durable-write cannot load'],
  'tools/builtin/browser.js': [3, "agent jail: screenshots (2); the browser profile's clean-exit Preferences fix (1)"],
  'tools/builtin/fs.js': [4, "agent jail: the file tools' verified write, append, edit and patch"],
  'tools/builtin/image.js': [2, 'agent jail: a generated image staged exclusively and renamed into place'],
  'tools/builtin/plugin-author.js': [4, "agent jail: plugin authoring files and the staged plugin's activation rename"],
  'tools/builtin/resolve.js': [1, 'agent jail: a built Resolve timeline file'],
  'tools/builtin/voice.js': [1, 'agent jail: synthesized audio'],
  'userprops.js': [2, 'own writer (userprops), not on persist yet: the fallback writer when no writeDurable is injected'],
  'workspace-owner.js': [1, 'lock protocol: the atomic rename is the owner-lock reclaim'],
  'workspace-recovery.js': [9, 'generation protocol: stage copy, activation/rollback and failed-request renames (7), fresh/recovered migration seals (2)']
};
// the stores the persist lane moved onto persist: they never write directly again, and never get a row
const PINNED_ZERO = ['savestore.js', 'channels/store.js', 'durable-store.js', 'durable-write.js', 'deliverable-store.js'];
const ALTERNATIVE = 'route it through sidecar/persist: writeAtomic for an atomic replace, replaceJson for a JSON store with a last-known-good .bak, moveAside / preserve for a forensic copy';

/* ---- the scan ---- */
const files = sidecarSourceFiles().filter(f => !f.rel.startsWith('sidecar/persist/'));
A.ok(files.length > 300, 'the scanner sees the sidecar tree (' + files.length + ' files outside sidecar/persist)');
A.ok(files.some(f => f.rel === 'sidecar/index.js'), 'the scan includes sidecar/index.js');
const seen = {};
let over = 0, unparsed = 0;
for (const f of files) {
  const rel = f.rel.slice('sidecar/'.length);
  try { new vm.Script('(function () {\n' + decomment(f.text) + '\n})', { filename: f.rel }); }
  catch (e) { unparsed++; A.ok(false, 'the stripped text of ' + f.rel + ' still compiles (the stripper ate code): ' + e.message); }
  const found = sites(f.text);
  seen[rel] = found.length;
  const allowed = BASELINE[rel] ? BASELINE[rel][0] : 0;
  if (found.length > allowed) {
    over++;
    A.ok(false, f.rel + ' has ' + found.length + ' direct write site(s), its baseline allows ' + allowed + ' (' +
      found.map(s => s.line + ':' + s.what).join(', ') + '). Do not raise the row: ' + ALTERNATIVE + '.');
  }
}
A.eq(unparsed, 0, 'W0: the comment stripper never eats code (every stripped file still compiles)');
A.eq(over, 0, 'W1: no sidecar file outside sidecar/persist has more direct write sites than its audited row');

for (const rel of PINNED_ZERO) {
  A.ok(rel in seen, 'W2: the migrated store is on disk: sidecar/' + rel);
  A.eq(seen[rel], 0, 'W2: sidecar/' + rel + ' writes only through sidecar/persist');
  A.ok(!(rel in BASELINE), 'W2: the migrated store has no baseline row: sidecar/' + rel);
}

let stale = 0;
for (const rel of Object.keys(BASELINE)) {
  const [n, why] = BASELINE[rel];
  A.ok(Number.isInteger(n) && n > 0 && typeof why === 'string' && why.length >= 16, 'every row has a count and a reason: ' + rel);
  if (!(rel in seen)) { stale++; A.ok(false, 'W3: baseline row names a file on disk: sidecar/' + rel + ' (moved or deleted? prune the row)'); continue; }
  if (seen[rel] < n) { stale++; A.ok(false, 'W3: sidecar/' + rel + ' baseline ' + n + ' > actual ' + seen[rel] + ': lower the row in the same commit'); }
}
A.eq(stale, 0, 'W3: every baseline row equals its on-disk count (no slack to spend)');

let persist = null;
A.notThrows(() => { persist = require('../sidecar/persist/index.js'); }, 'W4: sidecar/persist loads');
for (const fn of ['writeAtomic', 'replaceJson', 'moveAside', 'preserve']) {
  A.eq(persist ? typeof persist[fn] : 'no module', 'function', 'W4: sidecar/persist exports ' + fn + ', the alternative the message names');
}

A.report('persist lint');
