'use strict';
/* node test/turn-run-order.lint.test.js — runOnceCore takes a turn in ONE order, and reads nothing before it is declared
   (turn identity, commit 4; DESIGN §12.1 and §13 #8; A2-SP-05, A2-ROOT-01, A2-SP-06). A ratchet, not a close's proof.

     1. ORDER — every anchor of test/helpers/run-order.js (up to this commit) appears exactly once in runOnceCore, in order.
     2. LEXICAL DEPENDENCY — for every identifier read EAGERLY in the argument list of reuseByTurn, capture, apply,
        TurnKinds.ofRun, makeRunTranscript and TurnDirective.install( (an arrow or function body in the list is
        skipped: it runs later), a top-level const/let of that name in runOnceCore must come before the call. So #9b's
        `const kinds` follows `internal` and `trigger` and precedes makeRunTranscript and the directive install, both ways. The
        check's own negative fixtures (runOnceCore with #9b moved below makeRunTranscript; with `const trigger` moved
        below #9b) must fail it: a check that passes them guards nothing (the pinned design checked three calls only).
     3. ONE WORDING — the §4.4 consumers read TurnDirective.wording( / typedText( / packet( of the one capture, and no
        latestUserText(result.messages) (the post-loop messages: a screen-capture turn, a repair prompt) remains.
     4. NULL-SAFE — no `directive.<member>` read anywhere in runOnceCore: a null capture reaches only null-safe readers. */
const A = require('./_assert.js');
const { sidecarTopLevelFunction } = require('./helpers/source');
const { upTo, UPTO } = require('./helpers/run-order.js');

const core = sidecarTopLevelFunction('runOnceCore');
A.ok(core.length > 100000 && core.indexOf('async function runOnceCore(') === 0, 'fixture: runOnceCore is sliced (' + core.length + ' chars)');

// ---------------- 1. order ----------------
function orderProblems(src) {
  const out = [];
  let last = -1, lastAnchor = '(start)';
  for (const e of upTo(UPTO)) {
    const at = src.indexOf(e.anchor);
    if (at < 0) { out.push('missing ' + e.anchor); continue; }
    if (src.indexOf(e.anchor, at + 1) >= 0) out.push('twice ' + e.anchor);
    if (at < last) out.push(e.anchor + ' before ' + lastAnchor);
    last = at; lastAnchor = e.anchor;
  }
  return out;
}
A.ok(upTo(UPTO).some(e => e.anchor === 'const kinds = TurnKinds.ofRun(') && upTo(UPTO).some(e => e.anchor === 'const runTranscript = makeRunTranscript('), 'the anchor list holds #9b and makeRunTranscript');
A.ok(upTo(UPTO).some(e => e.anchor === 'turnWindow.apply('), 'commit8 requires pre-expansion window assembly in the shared order');
A.eq(orderProblems(core), [], 'runOnceCore\'s anchors appear once each, in run-order.js order');

// ---------------- 2. lexical dependency ----------------
// the index of the bracket closing the one opened at `open`, skipping strings, template literals and comments
function closeOf(text, open) {
  const o = text[open], c = o === '(' ? ')' : (o === '{' ? '}' : ']');
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (ch === '/' && nx === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { for (i++; i < text.length; i++) { if (text[i] === '\\') { i++; continue; } if (text[i] === ch) break; } continue; }
    if (ch === o) depth++;
    else if (ch === c) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// strings and comments blanked (same length), so identifiers inside them are never read
function blank(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '/') { const nl = text.indexOf('\n', i); const e = nl < 0 ? text.length : nl; out += ' '.repeat(e - i); i = e - 1; continue; }
    if (ch === '/' && nx === '*') { const e0 = text.indexOf('*/', i + 2); const e = e0 < 0 ? text.length : e0 + 2; out += ' '.repeat(e - i); i = e - 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { let j = i + 1; for (; j < text.length; j++) { if (text[j] === '\\') { j++; continue; } if (text[j] === ch) break; } out += '""' + ' '.repeat(Math.max(0, j - i - 1)); i = j; continue; }
    out += ch;
  }
  return out;
}
// the argument text with every arrow/function body (and its parameters) removed: those run later, not at the call
function eagerPart(args) {
  let s = args;
  for (let guard = 0; guard < 200; guard++) {
    const fn = /\bfunction\b[^(]*\(/.exec(s);
    const arrow = s.indexOf('=>');
    if (fn && (arrow < 0 || fn.index < arrow)) {
      const p = closeOf(s, fn.index + fn[0].length - 1); const b = p < 0 ? -1 : s.indexOf('{', p);
      const e = b < 0 ? -1 : closeOf(s, b);
      s = s.slice(0, fn.index) + ' ' + (e < 0 ? '' : s.slice(e + 1));
      continue;
    }
    if (arrow < 0) break;
    // the parameters: `(a, b) =>` or `a =>`
    let ps = arrow - 1; while (ps >= 0 && /\s/.test(s[ps])) ps--;
    if (s[ps] === ')') { let d = 0; for (; ps >= 0; ps--) { if (s[ps] === ')') d++; else if (s[ps] === '(') { d--; if (d === 0) break; } } }
    else { while (ps > 0 && /[\w$]/.test(s[ps - 1])) ps--; }
    if (ps > 5 && /async\s*$/.test(s.slice(ps - 6, ps))) ps = s.slice(0, ps).search(/async\s*$/);
    // the body: a block, or an expression up to the next ',' / ')' / '}' / ']' at its own depth
    let bs = arrow + 2; while (bs < s.length && /\s/.test(s[bs])) bs++;
    let be;
    if (s[bs] === '{') be = closeOf(s, bs) + 1;
    else { let d = 0; for (be = bs; be < s.length; be++) { const ch = s[be]; if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) { if (d === 0) break; d--; } else if (ch === ',' && d === 0) break; } }
    s = s.slice(0, ps) + ' ' + s.slice(be);
  }
  return s;
}
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'void', 'new', 'await', 'async', 'function', 'return', 'this', 'in', 'of', 'instanceof', 'String', 'Number', 'Boolean', 'Object', 'Array', 'Date', 'Math', 'JSON']);
function eagerReads(args) {
  const s = eagerPart(blank(args));
  const out = new Set();
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\b(?!\s*:(?!:))/g;
  let m;
  while ((m = re.exec(s))) if (!KEYWORDS.has(m[1])) out.add(m[1]);
  return Array.from(out);
}
// runOnceCore's own top-level declarations (two-space indent): name -> offset
function topLevelDecls(src) {
  const out = new Map();
  const re = /\n  (?:const|let) (?:\{([^}=]*)\}|([A-Za-z_$][\w$]*))/g;
  let m;
  while ((m = re.exec(src))) {
    const names = m[1] ? m[1].split(',').map(x => x.split(':').pop().trim()).filter(Boolean) : [m[2]];
    for (const n of names) if (!out.has(n)) out.set(n, m.index + 1);
  }
  return out;
}
const CALLS = ['TurnDirective.reuseByTurn(', 'TurnDirective.capture(', 'turnWindow.apply(', 'TurnKinds.ofRun(', 'makeRunTranscript(', 'TurnDirective.install('];
function depProblems(src) {
  const decls = topLevelDecls(src);
  const out = [];
  for (const call of CALLS) {
    const at = src.indexOf(call);
    if (at < 0) continue;
    const open = at + call.length - 1;
    const close = closeOf(src, open);
    if (close < 0) { out.push(call + ' argument list unclosed'); continue; }
    for (const name of eagerReads(src.slice(open + 1, close))) {
      const d = decls.get(name);
      if (d !== undefined && d > at) out.push(call + ' reads `' + name + '` before its declaration');
    }
  }
  return out;
}
// the scanner against fixtures
A.eq(eagerReads('o, { internal, trigger }').sort(), ['internal', 'o', 'trigger'], 'eager reads: plain and shorthand identifiers');
A.eq(eagerReads("transcriptStore, { streamId: o.streamId, rekey: t => { runStartExtra.turnId = t; }, later: () => kinds, f: function (x) { return trigger; } }").sort(), ['o', 'transcriptStore'], 'arrow and function bodies (and their params) are skipped; object keys are not reads; members are not reads');
A.eq(eagerReads("{ hold: keySaveOffered ? () => !keySavedThisRun : null, line: kinds.line, s: 'internal' }").sort(), ['keySaveOffered', 'kinds'], 'a ternary arrow is skipped, a member\'s object is read, a string is not');
A.ok(topLevelDecls('\n  const internal = 1;\n    const nested = 2;\n  let { a, b: c } = x;').has('c') && !topLevelDecls('\n    const nested = 2;').has('nested'), 'top-level declarations only (two-space indent), destructuring included');
A.eq(depProblems(core), [], 'the real runOnceCore reads every eagerly used identifier after its declaration');
A.ok(eagerReads(core.slice(core.indexOf('TurnKinds.ofRun(') + 16, closeOf(core, core.indexOf('TurnKinds.ofRun(') + 15))).sort().join(',') === 'internal,o,trigger', 'fixture: #9b reads o, internal and trigger');
A.ok(eagerReads(core.slice(core.indexOf('makeRunTranscript(') + 18, closeOf(core, core.indexOf('makeRunTranscript(') + 17))).includes('kinds'), 'fixture: makeRunTranscript reads kinds');

// the negative fixtures: each must FAIL the dependency check
const kindsLine = (core.match(/\n  const kinds = TurnKinds\.ofRun\([^\n]*/) || [''])[0];
A.ok(kindsLine.length > 20, 'fixture: #9b\'s line is found');
const mkAt = core.indexOf('  const runTranscript = makeRunTranscript(');
const mkEnd = core.indexOf('\n', closeOf(core, core.indexOf('(', mkAt)));
const movedKinds = core.replace(kindsLine, '').replace(core.slice(mkAt, mkEnd), core.slice(mkAt, mkEnd) + kindsLine);
A.ok(movedKinds !== core && movedKinds.indexOf(kindsLine) > movedKinds.indexOf('const runTranscript = makeRunTranscript('), 'fixture: #9b moved below makeRunTranscript');
A.ok(depProblems(movedKinds).some(p => p === 'makeRunTranscript( reads `kinds` before its declaration'), 'the check FAILS #9b moved below makeRunTranscript (kinds read in its TDZ): ' + JSON.stringify(depProblems(movedKinds)));
const triggerLine = (core.match(/\n  const trigger = [^\n]*/) || [''])[0];
A.ok(triggerLine.length > 10, 'fixture: `const trigger` is found');
const movedTrigger = core.replace(triggerLine, '').replace(kindsLine, kindsLine + triggerLine);
A.ok(depProblems(movedTrigger).some(p => p === 'TurnKinds.ofRun( reads `trigger` before its declaration'), 'the check FAILS `const trigger` moved below #9b: ' + JSON.stringify(depProblems(movedTrigger)));

// ---------------- 3. one wording ----------------
A.eq((core.match(/latestUserText\(result\.messages\)/g) || []).length, 0, 'no latestUserText(result.messages) remains in runOnceCore (never the post-loop messages)');
const READERS = [
  [/const latestUser = TurnDirective\.wording\(directive\);/, 'the task brief text (and its gate) read the one wording'],
  [/latestText: TurnDirective\.typedText\(directive\)/, 'KeyTools.ownerRun reads the typed words only'],
  [/handoff: !!o\.lineHop \|\| !!\(Pipeline\.isHandoff && Pipeline\.isHandoff\(TurnDirective\.typedText\(directive\)\)\)/, 'learning\'s hand-off reads the host flag, then the typed words'],
  [/const studyDirective = TurnDirective\.wording\(directive\);/, 'the study pass reads the one wording, no fallback'],
  [/directive: TurnDirective\.packet\(directive, \{ redact, keys: liveServiceKeys\(\), row: runTranscript\.directiveRow\(\) \|\| retryDirective \}\)/, 'the verdict packet carries the safe wording and the directive row'],
  [/TurnDirective\.runTitle\(o\.syntheticTrigger \? String\(o\.sessionPrompt \|\| ''\) : TurnDirective\.title\(directive, runDirective\), liveServiceKeys\(\)\)/, 'the run title reads the capture (runDirective only for a null capture)']
];
for (const [re, what] of READERS) A.ok(re.test(core), what);

// ---------------- 4. null-safe ----------------
const members = core.match(/(?<![\w$.])directive\??\.[A-Za-z_$]/g) || [];
A.eq(members, [], 'no directive.<member> read in runOnceCore (a null capture reaches only null-safe readers)');
A.eq((core.match(/const directive = TurnDirective\.capture\(/g) || []).length, 1, 'one capture');

A.report('turn-run-order.lint');
