/* node test/qa-bugs-fixed-in-tree.test.js — no OPEN bug record is already fixed by a commit on this tree.

   WHY (reliability wave 1, quick win 37, 2026-10-27): the 10-26 audit found ten qa/bugs records still 'open' whose
   fix had landed weeks earlier, several of them named by their own fix commit ("Bug 31db37b0.", "(bug 97743dff)").
   A register that over-reports open defects sends lanes to rebuild fixes that already shipped, and nothing re-read
   it: test/qa-bugs-register.test.js checks that each record parses, never whether its status is still true.

   THE LAW: a fix commit on this tree (subject `fix…`, `security…` or `perf…`) that names a record as `bug <fingerprint>`
   means that record is closed with its sha (`node scripts/qa/bugs.mjs --set <fp> --status fixed --fix <sha>
   --verdict "…"`) in the same branch. A commit that only partly fixes a record is acknowledged by naming its sha in
   the record (Evidence, Notes or Verdict) and saying what is left; the record then stays open. A checkout without
   git history (a tarball, a shallow CI clone) checks nothing and says so. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('./_assert.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = new Set(['open', 'claimed']);

// commits: [{ sha, subject, body }]; records: Map(fp -> { status, text }) -> [{ fp, sha, subject }] unacknowledged
function openButFixed(commits, records) {
  const out = [];
  for (const c of commits) {
    if (!/^(?:fix|security|perf)\b/i.test(c.subject || '')) continue;
    const named = new Set();
    for (const m of ((c.subject || '') + '\n' + (c.body || '')).matchAll(/\bbugs? ([0-9a-f]{8})\b/gi)) named.add(m[1].toLowerCase());
    for (const fp of named) {
      const r = records.get(fp);
      if (!r || !ACTIVE.has(r.status)) continue;
      const short = String(c.sha).slice(0, 7).toLowerCase();
      if (r.text.toLowerCase().indexOf(short) >= 0) continue;   // the record names this commit: an acknowledged partial fix
      out.push({ fp, sha: c.sha, subject: c.subject });
    }
  }
  return out;
}

// ---- the rule itself, on a synthetic history ----
{
  const records = new Map([
    ['aaaa1111', { status: 'open', text: 'status: open' }],
    ['bbbb2222', { status: 'fixed', text: 'status: fixed\nfix: 1234567' }],
    ['cccc3333', { status: 'open', text: 'status: open\n## Notes\n`7654321abc` relabels the line; the class itself is still open.' }],
    ['dddd4444', { status: 'claimed', text: 'status: claimed' }]
  ]);
  const commits = [
    { sha: '1111111aa', subject: 'fix(update): prune old snapshots', body: 'Bug aaaa1111.' },
    { sha: '1234567aa', subject: 'fix(x): y (bug bbbb2222)', body: '' },
    { sha: '7654321abc', subject: 'fix(retry): relabel', body: 'bug cccc3333' },
    { sha: '2222222aa', subject: 'qa(bugs): file dddd4444 and bug aaaa1111', body: '' },
    { sha: '3333333aa', subject: 'Security(save): bound it', body: 'Bugs dddd4444' }
  ];
  const got = openButFixed(commits, records).map(h => h.fp + '@' + h.sha.slice(0, 7)).sort();
  A.eq(got, ['aaaa1111@1111111', 'dddd4444@3333333'], 'flags an open or claimed record a fix commit names; never a fixed record, an acknowledged partial fix, or a commit that only files the bug');
}

// ---- the real register against this tree's history ----
const log = spawnSync('git', ['log', '--format=%H%x01%s%x01%b%x02', 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
if (log.status !== 0 || !String(log.stdout).trim()) {
  console.log('qa-bugs-fixed-in-tree: no git history here — the register is not checked against commits');
} else {
  const commits = String(log.stdout).split('\x02').map(s => s.replace(/^\s+/, '')).filter(Boolean).map(s => { const [sha, subject, body] = s.split('\x01'); return { sha, subject, body }; });
  const records = new Map();
  const dir = path.join(ROOT, 'qa', 'bugs');
  for (const f of fs.readdirSync(dir)) {
    const m = /^([0-9a-f]{8})-.*\.md$/.exec(f);
    if (!m) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    records.set(m[1], { status: ((/^status:\s*(\S+)/m.exec(text) || [])[1] || '').toLowerCase(), text });
  }
  A.ok(commits.length > 0 && records.size > 100, 'read the history (' + commits.length + ' commits) and the register (' + records.size + ' records)');
  const stale = openButFixed(commits, records);
  for (const s of stale) A.ok(false, 'qa/bugs/' + s.fp + ' is still ' + records.get(s.fp).status + ' but ' + s.sha.slice(0, 9) + ' ("' + s.subject + '") says it fixes it: close it with that sha, or name the sha in the record and say what is left');
  A.ok(!stale.length, 'no open record is already fixed by a commit on this tree');
}

A.report('qa-bugs-fixed-in-tree.test');
