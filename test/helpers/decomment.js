'use strict';
/* test/helpers/decomment.js — JavaScript comments to spaces, for the lexical lints (test/test-ports.lint.test.js, the
   web-engine floor ratchet in test/webkit-floor-syntax.test.js). Moved here unchanged from the ports lint so both read
   code the same way.

   Comments to spaces (newlines kept, so line numbers hold); every other character stays where it was. A small lexer,
   not a regex: it steps over '...', "...", `...` (with ${ } nested inside, templates within those too) and regex
   literals before it looks for // or /*, so a '/*' in a glob string, a // in a string or a regex, or a backtick
   holding either cannot blank the code after it. A / opens a regex where an expression may start (after an operator,
   an opening bracket, or a keyword such as return); after a name, a number, ) or ] it is a division. CRLF files
   strip like LF ones. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await']);
const WORD_CHAR = /[\w$]/;
function regexMayStart(prev) {
  if (!prev) return true;
  if (WORD_CHAR.test(prev[0])) return REGEX_AFTER_WORD.has(prev);
  return '(,=:[!&|?{};+-*%<>~^}'.indexOf(prev) >= 0;
}
function regexEnd(s, i) {
  let inClass = false;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\n') return -1;
    if (ch === '\\') { j++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') inClass = true;
    else if (ch === '/') { j++; while (j < s.length && /[a-z]/i.test(s[j])) j++; return j; }
  }
  return -1;
}
function stringEnd(s, i, quote) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === quote) return j + 1;
    if (s[j] === '\n') return j;   // unterminated: stop at the line end rather than swallow the file
  }
  return s.length;
}
function decomment(src) {
  const s = String(src), n = s.length;
  const blank = (a, b) => s.slice(a, b).replace(/[^\n]/g, ' ');
  let out = '', i = 0, prev = '', depth = 0, inTemplate = false;
  const exprDepth = [];   // the { } depth at which each open ${ … } hands back to its template literal
  if (s.startsWith('#!')) { i = s.indexOf('\n'); if (i < 0) i = n; out += blank(0, i); }
  while (i < n) {
    if (inTemplate) {
      let j = i;
      while (j < n && s[j] !== '`' && !(s[j] === '$' && s[j + 1] === '{')) j += s[j] === '\\' ? 2 : 1;
      if (j >= n) { out += s.slice(i); break; }
      if (s[j] === '`') { out += s.slice(i, j + 1); i = j + 1; inTemplate = false; prev = '`'; continue; }
      out += s.slice(i, j + 2); i = j + 2; exprDepth.push(depth); depth++; inTemplate = false; prev = '{';
      continue;
    }
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { let e = s.indexOf('\n', i); if (e < 0) e = n; out += blank(i, e); i = e; continue; }
    if (c === '/' && d === '*') { let e = s.indexOf('*/', i + 2); e = e < 0 ? n : e + 2; out += blank(i, e); i = e; continue; }
    if (c === '\'' || c === '"') { const e = stringEnd(s, i, c); out += s.slice(i, e); i = e; prev = c; continue; }
    if (c === '`') { out += c; i++; inTemplate = true; continue; }
    if (c === '/' && regexMayStart(prev)) {
      const e = regexEnd(s, i);
      if (e > 0) { out += s.slice(i, e); i = e; prev = 'a'; continue; }
    }
    if (WORD_CHAR.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(s[j])) j++;
      prev = s.slice(i, j); out += prev; i = j;
      continue;
    }
    out += c; i++;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (exprDepth.length && depth === exprDepth[exprDepth.length - 1]) { exprDepth.pop(); inTemplate = true; continue; }
    }
    prev = c;
  }
  return out;
}

module.exports = { decomment };
