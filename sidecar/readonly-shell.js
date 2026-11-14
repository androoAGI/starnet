'use strict';
/* readonly-shell.js — WHICH shell.exec CALLS ONLY LOOK (cost audit W3.12, 2026-11-14).

   The Task Brief gate (taskbrief-policy.js canMutate) holds a task's first consequential call until the model has settled
   its brief. shell.exec is scope 'execute', so `ls`, `dir`, `rg x` and `git status` were held like `rm -rf`: a model that
   looks around with the shell first paid a whole extra request for the held call, and settled its brief BEFORE it had
   looked (the doctrine says research first). This module answers one question for that gate and for nothing else:
   is this call certainly a look?

   IT IS AN ALLOWLIST. A call passes only when every part of it is on a list below; anything this file does not
   recognise is "not certainly read-only" and is held exactly as before. Nothing here is a list of bad things.

   WHAT A PASSING COMMAND IS: one program from COMMANDS, named bare and in lower case, then words that are either
   operands or flags on that program's own list. The whole line may use only the characters in SAFE, so it holds no
   pipe, redirect, separator, substitution, variable, glob, escape, comment, tab, newline or non-ASCII character. That
   is checked on the raw string, so the answer is the same whichever shell reads the line: cmd.exe on Windows, sh
   elsewhere (runtimeinfo.js shellLine). Where the two shells split words differently the line is held unless both
   splits pass:
     · quotes only wrap a whole word, and a quoted word never starts with `-` (echo aside: it only prints its words);
     · a single-quoted word with spaces (cmd.exe does not treat ' as a quote, so it becomes several words there) is
       held when any later piece starts with `-`;
     · a backslash only sits between path characters (never before a quote, a space or another backslash);
     · `~` only follows a letter or digit (HEAD~2), where no shell expands it.
   FLAGS: a flag passes only by name. A flag that takes a value takes it as the next word (never one that starts with
   `-`), as `--name=value`, or glued only when the value is digits (`-n5`); so a value this file expected and the program
   did not consume is still only an operand. No listed flag writes a file, runs a program or reaches the network:
   rg --pre / --search-zip / --hostname-bin, git -c / -C / --output / --ext-diff, find -exec / -delete / -fprint,
   tail -f are simply absent.

   THE CALL, not only the command: the arguments may be cmd and a timeout. A cwd, background:true or any argument the
   tool does not declare holds the call.

   WHAT THIS DOES NOT CLAIM. It reads the command, not the machine. A program of the same name planted in the working
   folder (cmd.exe looks there first), a repository whose own .git/config names a program for git to run (fsmonitor, an
   external diff, textconv), a config file a tool reads on its own, or a path that is a pipe or a device are outside what
   text can prove. None of that is new: the same command ran one request later, after brief_proceed, and every other
   protection (approval cards, the outside-content lock, the workspace fence, the hardline rules, remote rules) runs on it
   exactly as before. This file only answers the Task Brief gate.

   Pure: no fs, no env, no clock. Never throws. */

const MAX_LEN = 400;
const MAX_WORDS = 40;
// every character a passing line may hold
const SAFE = /^[A-Za-z0-9 _.\/:=+\\~"'-]+$/;
const BACKSLASH_OK = /[A-Za-z0-9_.:-]\\[A-Za-z0-9_.-]/;
const DIGITS = /^[0-9]+$/;
const LONG_NAME = /^[a-z][a-z0-9-]*$/;

const no = why => ({ ok: false, why: why });
const yes = program => ({ ok: true, program: program });

/* words(cmd) -> [{ text, quoted }] | null. Space-separated; a quote opens only at the start of a word and closes only
   at its end. null = a shape this file does not read (held). */
function words(cmd) {
  const out = [];
  const n = cmd.length;
  let i = 0;
  while (i < n) {
    const ch = cmd[i];
    if (ch === ' ') { i++; continue; }
    if (ch === '"' || ch === '\'') {
      const end = cmd.indexOf(ch, i + 1);
      if (end < 0) return null;                                   // never closed
      if (end + 1 < n && cmd[end + 1] !== ' ') return null;       // glued to more text
      const text = cmd.slice(i + 1, end);
      if (text.indexOf('"') >= 0 || text.indexOf('\'') >= 0) return null;
      out.push({ text: text, quoted: ch });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < n && cmd[j] !== ' ') j++;
    const text = cmd.slice(i, j);
    if (text.indexOf('"') >= 0 || text.indexOf('\'') >= 0) return null;   // a quote inside a bare word
    out.push({ text: text, quoted: '' });
    i = j;
  }
  return out;
}

const spec = o => Object.freeze({
  bool: o.bool || '', val: o.val || '', num: o.num === true,
  long: new Set(o.long || []), opt: new Set(o.opt || []), longVal: new Set(o.longVal || []),
  min: o.min || 0, max: o.max == null ? Infinity : o.max, dd: o.dd === true
});

/* One row per program. bool: short flags without a value. val: short flags with a value. num: -<digits> is a count.
   long: --name. opt: --name or --name=value. longVal: --name=value or --name value. min/max: operands. dd: `--` allowed. */
const LS = spec({ bool: 'aAlhRrtSs1dFpgonikcuUxCmGHLqQbBNvXZ', num: true,
  long: ['all', 'almost-all', 'human-readable', 'recursive', 'reverse', 'directory', 'size', 'inode', 'numeric-uid-gid', 'no-group', 'group-directories-first', 'full-time', 'dereference', 'literal', 'si'],
  opt: ['color', 'classify'], longVal: ['sort', 'time', 'format', 'block-size', 'width'] });
const HEAD = spec({ bool: 'qv', val: 'nc', num: true, long: ['quiet', 'silent', 'verbose'], longVal: ['lines', 'bytes'], min: 1 });
const COMMANDS = Object.freeze({
  ls: LS,
  dir: LS,                       // cmd.exe: its /switches are operands here, and every one only lists
  pwd: spec({ bool: 'LP', long: ['logical', 'physical'], max: 0 }),
  cat: spec({ bool: 'AbeEnstTuv', long: ['number', 'number-nonblank', 'show-all', 'show-ends', 'show-tabs', 'show-nonprinting', 'squeeze-blank'], min: 1 }),
  type: spec({ bool: 'afptP', min: 1 }),
  head: HEAD,
  tail: HEAD,                    // no -f / -F / --follow / --retry / --pid: a look ends
  wc: spec({ bool: 'lwcmL', long: ['lines', 'words', 'bytes', 'chars', 'max-line-length'], min: 1 }),
  rg: spec({ bool: 'nNiSslcwxvFHIUuLaoqpPb', val: 'egtTABCmMdj', dd: true,
    long: ['files', 'hidden', 'no-ignore', 'no-ignore-vcs', 'no-ignore-parent', 'line-number', 'no-line-number', 'ignore-case', 'smart-case', 'case-sensitive',
      'files-with-matches', 'files-without-match', 'count', 'count-matches', 'word-regexp', 'line-regexp', 'invert-match', 'fixed-strings', 'with-filename',
      'no-filename', 'heading', 'no-heading', 'column', 'json', 'stats', 'text', 'follow', 'only-matching', 'quiet', 'pretty', 'trim', 'multiline', 'pcre2',
      'byte-offset', 'vimgrep', 'no-messages', 'type-list', 'unrestricted', 'no-config', 'one-file-system', 'glob-case-insensitive'],
    longVal: ['glob', 'iglob', 'type', 'type-not', 'max-count', 'max-depth', 'max-columns', 'max-filesize', 'after-context', 'before-context', 'context', 'regexp',
      'threads', 'sort', 'sortr', 'color', 'colors', 'encoding'] }),
  grep: spec({ bool: 'nirRlLcwxvEFGHhoqsIa', val: 'eABCm', num: true, dd: true, min: 1,
    long: ['line-number', 'ignore-case', 'no-ignore-case', 'recursive', 'dereference-recursive', 'files-with-matches', 'files-without-match', 'count', 'word-regexp',
      'line-regexp', 'invert-match', 'extended-regexp', 'fixed-strings', 'basic-regexp', 'with-filename', 'no-filename', 'only-matching', 'quiet', 'silent',
      'no-messages', 'text'],
    opt: ['color', 'colour'],
    longVal: ['regexp', 'after-context', 'before-context', 'context', 'max-count', 'include', 'exclude', 'exclude-dir', 'binary-files'] }),
  findstr: spec({ min: 1 }),     // its /switches are operands here, and every one only searches
  where: spec({ min: 1 }),
  which: spec({ bool: 'a', long: ['all'], min: 1 })
});

const GIT = Object.freeze({
  status: spec({ bool: 'sbvz', dd: true,
    long: ['short', 'branch', 'long', 'verbose', 'show-stash', 'ahead-behind', 'no-ahead-behind', 'renames', 'no-renames', 'no-column', 'null'],
    opt: ['porcelain', 'untracked-files', 'ignored', 'ignore-submodules'] }),
  log: spec({ bool: 'psi', val: 'n', num: true, dd: true,
    long: ['oneline', 'graph', 'all', 'no-decorate', 'shortstat', 'numstat', 'name-only', 'name-status', 'no-merges', 'merges', 'first-parent', 'reverse', 'follow',
      'abbrev-commit', 'no-abbrev-commit', 'patch', 'no-patch', 'no-color', 'summary', 'topo-order', 'date-order', 'no-ext-diff', 'no-textconv', 'full-diff'],
    opt: ['decorate', 'stat', 'color', 'abbrev', 'branches', 'tags', 'remotes', 'pretty'],
    longVal: ['max-count', 'skip', 'since', 'until', 'after', 'before', 'author', 'committer', 'grep', 'format', 'date', 'diff-filter', 'unified'] }),
  diff: spec({ bool: 'pswb', val: 'U', dd: true,
    long: ['cached', 'staged', 'shortstat', 'numstat', 'name-only', 'name-status', 'summary', 'no-color', 'ignore-all-space', 'ignore-space-change',
      'ignore-space-at-eol', 'ignore-blank-lines', 'no-ext-diff', 'no-textconv', 'no-renames', 'minimal', 'patience', 'histogram', 'check', 'quiet', 'exit-code',
      'compact-summary', 'patch', 'no-patch', 'raw', 'merge-base'],
    opt: ['stat', 'color', 'word-diff', 'abbrev', 'find-renames'],
    longVal: ['unified', 'diff-filter', 'diff-algorithm'] }),
  show: spec({ bool: 'ps', val: 'U', dd: true,
    long: ['oneline', 'shortstat', 'numstat', 'name-only', 'name-status', 'summary', 'no-color', 'no-patch', 'patch', 'abbrev-commit', 'no-abbrev-commit',
      'no-ext-diff', 'no-textconv', 'quiet', 'raw'],
    opt: ['stat', 'color', 'abbrev', 'decorate', 'pretty'],
    longVal: ['format', 'date', 'unified'] }),
  // listing only: no operand at all, so no word can be read as a branch to create, move or delete
  branch: spec({ bool: 'arv', long: ['list', 'all', 'remotes', 'verbose', 'show-current', 'no-color'], opt: ['color'], max: 0 }),
  'rev-parse': spec({ bool: 'q',
    long: ['show-toplevel', 'verify', 'git-dir', 'absolute-git-dir', 'git-common-dir', 'is-inside-work-tree', 'is-inside-git-dir', 'is-bare-repository', 'show-prefix',
      'show-cdup', 'symbolic-full-name', 'symbolic', 'quiet', 'all'],
    opt: ['abbrev-ref', 'short'] })
});

// find: tests and actions by name. No -exec, -execdir, -ok, -okdir, -delete, -fprint, -fprint0, -fprintf, -fls.
const FIND_BOOL = new Set(['-print', '-print0', '-empty', '-prune', '-xdev', '-depth', '-not', '-a', '-and', '-o', '-or', '-L', '-H', '-P', '-readable', '-writable', '-executable']);
const FIND_VAL = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-newer', '-user', '-group']);
const FIND_NUM = new Set(['-mtime', '-mmin', '-ctime', '-cmin', '-atime', '-amin', '-size']);
const FIND_NUM_VALUE = /^[+-]?[0-9]+[A-Za-z]?$/;

// the value a flag takes as its next word: there, unquoted or quoted, and never something a program could read as a flag
function valueAt(list, i) {
  const v = list[i];
  return !!v && v.text.charAt(0) !== '-';
}

function flagsOk(s, list) {
  let operands = 0, operandsOnly = false;
  for (let i = 0; i < list.length; i++) {
    const w = list[i], t = w.text;
    if (t.charAt(0) !== '-') { operands++; continue; }
    if (w.quoted) return 'a quoted word starts with -';
    if (operandsOnly) return 'a word after -- starts with -';
    if (t === '-') return 'a bare - (standard input)';
    if (t === '--') { if (!s.dd) return '-- is not read for this program'; operandsOnly = true; continue; }
    if (t.slice(0, 2) === '--') {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      if (!LONG_NAME.test(name)) return 'flag ' + t;
      if (eq >= 0) { if (s.opt.has(name) || s.longVal.has(name)) continue; return 'flag ' + t; }
      if (s.long.has(name) || s.opt.has(name)) continue;
      if (s.longVal.has(name)) { if (!valueAt(list, ++i)) return 'flag ' + t + ' has no plain value'; continue; }
      return 'flag ' + t;
    }
    if (DIGITS.test(t.slice(1))) { if (!s.num) return 'flag ' + t; continue; }
    for (let k = 1; k < t.length; k++) {
      const ch = t.charAt(k);
      if (s.bool.indexOf(ch) >= 0) continue;
      if (s.val.indexOf(ch) < 0) return 'flag -' + ch;
      const glued = t.slice(k + 1);
      if (glued) { if (!DIGITS.test(glued)) return 'flag ' + t + ' glues a value that is not a number'; }
      else if (!valueAt(list, ++i)) return 'flag ' + t + ' has no plain value';
      break;
    }
  }
  if (operands < s.min) return 'needs something to read';
  if (operands > s.max) return 'takes no operand';
  return '';
}

function findOk(list) {
  for (let i = 0; i < list.length; i++) {
    const w = list[i], t = w.text;
    if (t.charAt(0) !== '-') continue;
    if (w.quoted) return 'a quoted word starts with -';
    if (FIND_BOOL.has(t)) continue;
    if (FIND_VAL.has(t)) { if (!valueAt(list, ++i)) return 'test ' + t + ' has no plain value'; continue; }
    if (FIND_NUM.has(t)) { const v = list[++i]; if (!v || v.quoted || !FIND_NUM_VALUE.test(v.text)) return 'test ' + t + ' has no number'; continue; }
    return 'find ' + t;
  }
  return '';
}

/* readOnlyCommand(cmd) -> { ok: true, program } | { ok: false, why }. `why` is for tests and logs; the model never
   sees it (a held call gets the gate's usual words). */
function readOnlyCommand(cmd) {
  if (typeof cmd !== 'string') return no('not a string');
  if (!cmd || cmd.length > MAX_LEN) return no('empty or too long');
  if (!SAFE.test(cmd)) return no('a character outside the safe set');
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && !(i > 0 && i + 1 < cmd.length && BACKSLASH_OK.test(cmd.slice(i - 1, i + 2)))) return no('a backslash that is not inside a path');
    if (ch === '~' && !(i > 0 && /[A-Za-z0-9]/.test(cmd[i - 1]))) return no('a ~ a shell could expand');
  }
  const list = words(cmd);
  if (!list || !list.length || list.length > MAX_WORDS) return no('words this file does not read');
  for (const w of list) {
    // cmd.exe does not read ' as a quote: there the pieces are separate words, and none may look like a flag
    if (w.quoted === '\'' && w.text.split(' ').slice(1).some(p => p.charAt(0) === '-')) return no('a single-quoted word hides a flag from cmd.exe');
  }
  const head = list[0];
  if (head.quoted) return no('a quoted program name');
  const name = head.text;
  let rest = list.slice(1);
  if (name === 'echo') return yes('echo');   // prints its own words; nothing in SAFE lets it do more
  if (name === 'find') { const bad = findOk(rest); return bad ? no(bad) : yes('find'); }
  if (name === 'git') {
    if (rest.length && !rest[0].quoted && rest[0].text === '--no-pager') rest = rest.slice(1);
    const sub = rest[0];
    if (!sub || sub.quoted || !Object.prototype.hasOwnProperty.call(GIT, sub.text)) return no('git subcommand');
    const bad = flagsOk(GIT[sub.text], rest.slice(1));
    return bad ? no(bad) : yes('git ' + sub.text);
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, name)) return no('program not on the list');
  const bad = flagsOk(COMMANDS[name], rest);
  return bad ? no(bad) : yes(name);
}

/* readOnlyCall(args) -> boolean: the shell.exec CALL only looks. cmd and a timeout are the whole call; a cwd (it moves
   the run's working folder), background:true (it starts a process that stays) or an undeclared argument holds it. */
function readOnlyCall(args) {
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    for (const k of Object.keys(args)) {
      const v = args[k];
      if (k === 'cmd') continue;
      if (k === 'timeoutMs' || k === 'timeout_ms') { if (v == null || (typeof v === 'number' && Number.isFinite(v))) continue; return false; }
      if (k === 'background') { if (v === false || v == null) continue; return false; }
      if (k === 'cwd') { if (v == null) continue; return false; }
      return false;
    }
    return readOnlyCommand(args.cmd).ok === true;
  } catch (_) { return false; /* fail closed: held */ }
}

module.exports = { readOnlyCommand, readOnlyCall, COMMANDS: Object.freeze(Object.keys(COMMANDS).concat(['echo', 'find', 'git'])), GIT_SUBCOMMANDS: Object.freeze(Object.keys(GIT)),
  _internals: { words: words } };   // for the test that asks the real shell how it splits a passing line
