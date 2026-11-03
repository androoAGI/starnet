/* node test/webkit-floor-syntax.test.js — every script the station page loads PARSES and BOOTS on the oldest web engine
   StarNet supports: the floor in scripts/lib/engine-floor.json (read through scripts/lib/engine-floor.mjs).

   On macOS the app window is the SYSTEM WebKit, which only updates with Safari / macOS (an Intel Mac on macOS 11-13 can
   sit on a Safari 15.x/16.x WebKit for years). A classic <script> carrying syntax that engine lacks is a SyntaxError
   for the WHOLE file: its global is never defined, every other script keeps running, and each caller's
   `typeof X === 'undefined'` guard turns the loss into a quiet "not loaded".

     2026-09-18 (qa/bugs/5308fc67): a regex lookbehind at app/chat.js:559 killed Chat on a customer Mac.
     2026-10-18 (#136, macOS Intel, 0.13.5): ONE lookbehind at app/workflowline.js:797 (suggestLineFor's "pressure-test is
       not QA" rule, in since 2026-09-29 / v0.13.0) killed WorkflowLine — SET UP RESEARCH STATION said "The workflow reader
       is not loaded", DIRECTOR's station.layout was REFUSED, the Workflow panel said "Unnamed line — CONNECT IT TO A LINE",
       and diagnostics said only "page errors: 1 uncaught error(s)". It was the only lookbehind left in the page.

   The class-wide ratchet, both halves from the one table (no rule is written here):
     - SYNTAX newer than the floor (the table's syntax features): banned outright, in code and strings (a `new RegExp`
       string throws where it runs). A match preceded by an odd run of backslashes is an escaped character — `\(?<=`
       matches a literal paren — and is not flagged; a named group `(?<name>` is older than the floor and never matched.
     - APIs newer than the floor (the table's api features): a missing API breaks one call, not a whole file, but at
       boot that call can still drop a module. Each use must sit inside a typeof (or `in`) check of the same API, or
       just below one (the same line or the two above). A flagged call is restructured behind a guard; there is no
       allowlist.
   Comments are blanked first (test/helpers/decomment.js), offsets kept. Lexical on purpose (the repo ships no JS parser
   and the gate must stay cheap); the real-engine half is the WebKit floor job (scripts/qa/webkit-floor-boot.mjs). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { decomment } = require('./helpers/decomment.js');

const ROOT = path.join(__dirname, '..');
const ENTRIES = ['frontend/index.html', 'frontend/agent-station-demo.html'];

(async () => {
  const floor = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'engine-floor.mjs')).href);
  const table = floor.readFloor();
  const RULES = floor.syntaxRules(table);
  const API = floor.apiRules(table);

  /* ---- the scanner ---- */
  function escapedAt(src, i) { let n = 0; while (i - n - 1 >= 0 && src[i - n - 1] === '\\') n++; return n % 2 === 1; }
  function lineAt(src, i) { return src.slice(0, i).split('\n').length; }
  function lineStart(src, line) { let at = 0; for (let l = 1; l < line && at >= 0; l++) at = src.indexOf('\n', at) + 1; return Math.max(0, at); }
  function scan(raw, file) {
    const src = decomment(raw), lines = raw.split('\n'), hits = [];
    const hit = (i, what) => { const line = lineAt(src, i); hits.push(file + ':' + line + ' — ' + what + ': ' + String(lines[line - 1] || '').trim().slice(0, 120)); };
    for (const r of RULES) {
      r.re.lastIndex = 0;
      for (let m; (m = r.re.exec(src));) if (!escapedAt(src, m.index)) hit(m.index, r.name);
    }
    for (const r of API) {
      const guards = [];
      r.guard.lastIndex = 0;
      for (let m; (m = r.guard.exec(src));) guards.push([m.index, m.index + m[0].length]);
      r.use.lastIndex = 0;
      for (let m; (m = r.use.exec(src));) {
        const i = m.index, from = lineStart(src, Math.max(1, lineAt(src, i) - 2));
        if (guards.some(([a, b]) => (i >= a && i < b) || (b <= i && a >= from))) continue;
        hit(i, r.name + ' without a typeof guard');
      }
    }
    return hits;
  }

  /* ---- 0. the scanner itself: it catches the reported constructs and nothing it should not ---- */
  A.ok(RULES.length >= 2 && API.length >= 20, 'the rules come from the table: ' + RULES.length + ' syntax, ' + API.length + ' api (newer than Safari ' + table.safari + ')');
  A.eq(scan("const re = /(?<!pressure.?)\\btest\\b/i;", 'x.js').length, 1, 'a lookbehind regex literal is flagged');
  A.eq(scan("new RegExp('(?<=a)b')", 'x.js').length, 1, 'a lookbehind in a RegExp string is flagged (it throws where it runs)');
  A.eq(scan('class K { static { init(); } }', 'x.js').length, 1, 'a class static block is flagged');
  A.eq(scan('const re = /\\(?<=/;', 'x.js').length, 0, 'an escaped paren `\\(?<=` is a literal "(", not a lookbehind');
  A.eq(scan('const re = /(?<year>\\d{4})/;', 'x.js').length, 0, 'a named capture group is not a lookbehind');
  A.eq(scan('const statics = { a: 1 }; x.static = 2;', 'x.js').length, 0, 'the word "static" alone is not a static block');
  A.eq(scan('// a lookbehind (?<= in a comment\n/* class K { static { } } */ x();', 'x.js').length, 0, 'a comment is not code');
  A.eq(scan('const s = AbortSignal.timeout(5000);', 'x.js').length, 1, 'an unguarded API newer than the floor is flagged (static)');
  A.eq(scan('const b = list.toSorted((a, c) => a - c);', 'x.js').length, 1, 'an unguarded API newer than the floor is flagged (member)');
  A.eq(scan('const cv = new OffscreenCanvas(1, 1);', 'x.js').length, 1, 'an unguarded API newer than the floor is flagged (global)');
  A.eq(scan("if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);", 'x.js').length, 0, 'a use behind its typeof guard on the line passes');
  A.eq(scan("const rendered = el => typeof el.checkVisibility !== 'function' || el.checkVisibility();", 'x.js').length, 0, 'a member use behind its typeof guard passes');
  A.eq(scan("if (typeof OffscreenCanvas !== 'undefined') {\n  cv = new OffscreenCanvas(w, h);\n}", 'x.js').length, 0, 'a guard on the line above passes');
  A.eq(scan("if (typeof OffscreenCanvas !== 'undefined') {\n  a();\n  b();\n  cv = new OffscreenCanvas(w, h);\n}", 'x.js').length, 1, 'a guard three lines up is too far: the call is restructured behind it');
  A.eq(scan("if (typeof Worker === 'undefined') return;\nconst s = AbortSignal.timeout(1);", 'x.js').length, 1, 'a guard of ANOTHER API guards nothing');
  A.eq(scan('// native AbortSignal.timeout, whose timer cannot be cleared\nU.timeoutSignal(ms);', 'x.js').length, 0, 'an API named in a comment is not a use');
  A.eq(scan("const id = crypto.randomUUID(); const o = Object.hasOwn(a, 'k'); x.at(-1);", 'x.js').length, 0, 'APIs AT the floor need no guard');

  /* ---- 1. every script the station page (and the website demo) loads ---- */
  const files = new Set();
  for (const entry of ENTRIES) {
    const html = fs.readFileSync(path.join(ROOT, entry), 'utf8');
    for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      const src = m[1].replace(/[?#].*$/, '');
      if (/^[a-z]+:\/\//i.test(src)) continue;   // never a remote script (none today)
      files.add(src.startsWith('/') ? src.replace(/^\/+/, '') : path.posix.join(path.posix.dirname(entry), src));
    }
  }
  A.ok(files.size > 200, 'the page loads its full module set (' + files.size + ' scripts)');
  A.ok(files.has('frontend/app/workflowline.js') && files.has('frontend/app/chat.js') && files.has('shared/specialties.js') && files.has('frontend/app/bootguard.js'), 'the reported modules and the boot guard are in the scanned set');

  const hits = [];
  for (const f of files) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) { A.ok(false, 'a page script exists on disk: ' + f); continue; }
    hits.push(...scan(fs.readFileSync(abs, 'utf8'), f));
  }
  A.eq(hits, [], 'no page script uses syntax newer than the floor (Safari ' + table.safari + '), or an API newer than it outside a typeof guard');

  A.report();
})().catch(e => { console.error(e); process.exit(1); });
