'use strict';

// The checkout must be LF on every platform, because the source-regex tests in this suite
// match hardcoded \n against files they read off disk. Git for Windows installs with
// core.autocrlf=true, so before .gitattributes existed a clean Windows clone landed a CRLF
// worktree and the merge gate died at test/checkpoint-default-on.test.js:12 with
// `TypeError: Cannot read properties of null (reading '0')` — a null regex match, reported
// as a crash rather than as "your checkout has the wrong line endings".
//
// CI runs test:fast on ubuntu-latest only, so nothing caught it. This step does, and it runs
// first in test/fast.list so the gate names the cause instead of crashing 55 steps later.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
assert.ok(
  /^\*\s+text=auto\s+eol=lf\s*$/m.test(attributes),
  '.gitattributes pins the worktree to LF (`* text=auto eol=lf`)'
);

// `git ls-files --eol` classifies each tracked file as i/<index> w/<worktree>; binaries come
// back as w/-text and are correctly ignored here.
const rows = execFileSync('git', ['ls-files', '--eol', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

assert.ok(rows.length > 0, 'tracked file inventory is non-empty');

const offenders = [];
const unparsed = [];
for (const row of rows) {
  // `i/<eol>  w/<eol>  attr/<attributes>\t<path>` — the attribute field is free text and holds
  // a SPACE as soon as .gitattributes sets more than one attribute (`text=auto eol=lf`), so
  // split on the last tab instead of pattern-matching across it. An unparseable row is
  // collected rather than skipped: silently dropping rows is how a guard like this rots green
  // (the first draft of this test did exactly that and passed against a CRLF file).
  const cut = row.lastIndexOf('\t');
  const m = cut < 0 ? null : /^i\/(\S+)\s+w\/(\S+)\s+attr\//.exec(row.slice(0, cut));
  if (!m) { unparsed.push(row); continue; }
  if (m[2] === 'crlf' || m[2] === 'mixed') offenders.push(row.slice(cut + 1) + ' (w/' + m[2] + ')');
}

assert.deepEqual(unparsed, [], 'every `git ls-files --eol` row parsed');

assert.deepEqual(
  offenders,
  [],
  'no tracked text file is checked out with CR. Re-normalize this clone:\n' +
    '        git rm --cached -r . && git reset --hard\n' +
    '      Offenders'
);

console.log('checkout-eol-integrity.test: OK (' + rows.length + ' tracked files, all LF or binary)');
