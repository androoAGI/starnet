'use strict';
/* node test/test-ports.lint.test.js — no test, dev harness or script picks its own TCP port; the OS does.

   THE HOLE THIS CLOSES (2026-10-28): 81 test files booted the sidecar on BASE + (process.pid % N).
   On the remote gate laptop Windows reserves 8883, 8884 and 8886 (and 5357, 50000-50059: see
   `netsh int ipv4 show excludedportrange protocol=tcp`). boot-security landed on 8884, the sidecar got EACCES, and
   the test waited out its 30 s boot timer, because it retried only on "already in use" — and its retry was port + 1,
   which from 8883 is reserved too. PID-derived ports also collide between parallel runs.

   Every port a test binds now comes from the OS: allocatePort() / allocatePorts(n) in test/helpers/ports.js
   (listen(0) on the loopback host), or a server's own listen(0). A boot that is refused retries on a fresh
   allocatePort(), on EACCES and EADDRNOTAVAIL as well as EADDRINUSE (ports.BIND_REFUSED).

   Laws, over every .js / .mjs / .cjs file under test/, dev/ and scripts/ with comments stripped (the allocation helper
   and this file excepted). Comments are stripped by a small lexer that steps over strings, template literals and
   regex literals, so a '/*' in a glob or a '//' in a string cannot hide the code after it:
     P1 no port is computed from process.pid (or ppid);
     P2 no port is a fixed base plus a random or clock-derived offset (Math.random(), crypto.randomInt(), Date.now() % N);
     P3 nothing binds a literal port in 1024..65535: .listen(<n>), a boot helper's first argument (boot(<n>, …) or a
        base plus an offset, boot(<n> + i, …)), the port key in the options of a boot / start / serve / listen / launch
        call, '--port', '<n>' / --port=<n>, SKYNET_…PORT / STARNET_…PORT set to <n> (any such name, a quoted key, an
        env assignment, String(<n>)), or any of those spelled with a name the file binds to such a literal;
     P4 no boot, listen or port name derives its port from another port (boot(port + 1, ...), listen(basePort + 3),
        cdpPort = port + 1000): the neighbour of a bindable port is not proven bindable;
     P5 a boot reads a refused bind with BIND_REFUSED, never /already in use/ alone: on EACCES or EADDRNOTAVAIL that
        boot waits out its timer instead of retrying (the boot-security hole above);
     P6 ports a caller needs at the same time come from one allocatePorts(n): allocatePort() twice in a row can hand
        back the same port, because the first probe has closed before the second asks.
   P3 holds in test/ only (SCOPES says why), and no comment may still promise the old "retries the next port".
   ALLOW names the few literals that must stay, each with its reason, and must stay short. The scanner proves itself
   on snippets first, and BIND_REFUSED is held to the sidecar's own refused-bind wording, so neither can go dead. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const ROOT = path.resolve(__dirname, '..');
/* Where each law holds. test/ binds nothing the OS did not hand it. dev/ and scripts/ are probes and harnesses a
   person runs by hand, one at a time, on an explicit default they print and accept an override for (a probe's CDP
   9360, closer's SKYNET_SHOT_PORT 8970, seed-deliverables' 8733): a fixed literal there is a documented default, so P3
   does not apply. A port from process.pid, a random or clock offset, another port, an "already in use"-only retry or
   two back-to-back allocatePort() calls is a guess wherever it is written, so P1, P2, P4, P5 and P6 hold everywhere. */
const SCOPES = [
  { dir: 'test', laws: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] },
  { dir: 'dev', laws: ['P1', 'P2', 'P4', 'P5', 'P6'] },
  { dir: 'scripts', laws: ['P1', 'P2', 'P4', 'P5', 'P6'] }
];
// the helper that implements allocation binds port 0 and re-checks a given port by design; this file names the patterns
const EXEMPT = new Set(['test/helpers/ports.js', 'test/test-ports.lint.test.js']);

/* A literal here is a known, explained exception: something that names a port without binding it. Each entry is a
   file, a law, and the exact text (or texts) that law matched there. Fix a binding test rather than listing it. */
const ALLOW = [
  { file: 'test/cli.test.js', law: 'P3', match: "'--port', '9001",
    reason: 'parseArgs input for the CLI flag parser: the parsed value is asserted, nothing is bound or dialled' },
  { file: 'test/cli.test.js', law: 'P3', match: "STARNET_PORT: '4444",
    reason: 'a fake env object handed to parseArgs to prove the env fallback; nothing is bound' },
  { file: 'test/returnstore-recovery.test.js', law: 'P3', match: ['boot(3000,', 'boot(5000,', 'boot(6000,'],
    reason: 'boot(nowMs, loader) there starts the return store at a fake clock time; the number is a timestamp, not a port' },
  { file: 'test/voice-flow.test.js', law: 'P3', match: 'boot(48000)',
    reason: 'h.api.boot(sampleRate) starts the voice pipeline at 48 kHz; the number is an audio sample rate, not a port' }
];

const MIN_PORT = 1024, MAX_PORT = 65535;
const IDENT = '[A-Za-z_$][\\w$]*';
// a name that reads as a port: fooPort, port, portBase, PORT, CDP_PORT; not import, export, report, support, transport
const PORT_NAME = '\\b(?:[A-Za-z_$][\\w$]*(?:Port|_PORT)|port|PORT)[\\w$]*';
// a boot helper: boot(, bootSidecar(, bootWith(; never bootstrap(
const BOOT = '\\bboot(?:[A-Z][\\w$]*)?\\(';
// a call whose options object can carry the port it binds:
// boot…({ port: … }), startMock({ host, port: … }), launchChrome({ cdpPort: … })
const BINDS_OPTIONS = '(?:\\.listen|\\b(?:boot|start|serve|listen|launch)[\\w$]*)\\(\\s*\\{[^}]*?\\b(?:port|[a-z][\\w$]*Port)\\s*:\\s*';
// SKYNET_PORT, STARNET_PORT and every other SKYNET_…PORT / STARNET_…PORT, quoted or not, set with : or = (never ===)
const ENV_PORT = '\\b(?:SKYNET|STARNET)_\\w*PORT[\'"]?\\s*(?<![=!<>])[:=](?!=)\\s*(?:String\\(|Number\\()?\\s*';
// a name a boot helper's first argument may carry and still be a port: a port name, or a base (BASE, basePort, BOOT_BASE)
const PORTISH = new RegExp('^(?:' + PORT_NAME.slice(2) + ')$|^(?:base|BASE)(?:[A-Z_][\\w$]*)?$|(?:Base|_BASE)$');

/* Comments to spaces (newlines kept, so line numbers hold); every other character stays where it was. A small lexer,
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

function literalBindings(code) {
  const out = new Map();
  const re = new RegExp('\\b(?:const|let|var)\\s+(' + IDENT + ')\\s*=\\s*(\\d+)\\s*[;,\\n]', 'g');
  for (let m; (m = re.exec(code));) out.set(m[1], Number(m[2]));
  return out;
}

const inRange = n => Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
const RE = body => new RegExp(body, 'g');

/* literal: m[1] is a number, and the rule fires only for a port (1024..65535).
   named: m[1] is a name the file binds to such a number. portish: the name must also read as a port, because a boot
   helper's first argument is not always one (bootWithin(TIMEOUT_MS)). unless: the match itself says it is fine. */
const RULES = [
  { law: 'P1', what: 'a port computed from process.pid',
    re: /\bprocess\.p?pid\s*(?:[%*]|&(?!&))|(?:[%*]|(?<!&)&)\s*process\.p?pid\b|\b\d{4,5}\s*\+[\s(]*process\.p?pid\b/g },
  { law: 'P2', what: 'a port picked from a fixed range with a random or clock-derived offset',
    re: /\b\d{4,5}\s*\+[\s(]*(?:Math\.(?:floor|round|trunc)\(\s*)?[\s(]*Math\.random\(\)|Math\.random\(\)\s*\*\s*\d+\s*\)?\s*(?:\|\s*0\s*\)?\s*)?\+\s*\d{4,5}\b/g },
  { law: 'P2', what: 'a port picked from a fixed range with a random or clock-derived offset',
    re: /\b\d{4,5}\s*\+[\s(]*(?:crypto\.)?randomInt\(|\brandomInt\(\s*\d{4,5}\s*,\s*\d{4,5}\s*\)|\b\d{4,5}\s*\+[\s(]*Date\.now\(\)\s*%/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /\.listen\(\s*(?:Number\(\s*)?(\d+)\b/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: RE(BINDS_OPTIONS + '(\\d+)\\b') },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: RE(BOOT + '\\s*(\\d+)\\s*[-+,)]') },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /['"]--port['"]\s*,\s*['"]?(\d+)\b/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /--port=(\d+)\b/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: RE(ENV_PORT + '[\'"]?(\\d+)\\b') },
  { law: 'P3', what: 'a name bound to a literal port, then bound', named: true,
    re: RE('\\.listen\\(\\s*(' + IDENT + ')\\s*[-+,)]') },
  { law: 'P3', what: 'a name bound to a literal port, then bound', named: true, portish: true,
    re: RE(BOOT + '\\s*(' + IDENT + ')\\s*[-+,)]') },
  { law: 'P3', what: 'a name bound to a literal port, then bound', named: true,
    re: RE(BINDS_OPTIONS + '(' + IDENT + ')\\s*[-+,}]') },
  { law: 'P3', what: 'a name bound to a literal port, then bound', named: true,
    re: RE(ENV_PORT + '(' + IDENT + ')\\s*[-+,)}]') },
  { law: 'P4', what: 'a port derived from another port',
    re: RE('(?:\\.listen\\(|' + BOOT + ')\\s*(?:' + IDENT + '\\.)?' + PORT_NAME + '\\s*[+-]\\s*\\d+') },
  { law: 'P4', what: 'a port derived from another port',
    re: RE(BINDS_OPTIONS + '(?:' + IDENT + '\\.)?' + PORT_NAME + '\\s*[+-]\\s*\\d+') },
  { law: 'P4', what: 'a port derived from another port',
    re: RE(ENV_PORT + '(?:' + IDENT + '\\.)?' + PORT_NAME + '\\s*[+-]\\s*\\d+') },
  { law: 'P4', what: 'a port derived from another port',
    re: RE(PORT_NAME + '\\s*(?<![=!<>])=(?!=)\\s*(?:' + IDENT + '\\.)?' + PORT_NAME + '\\s*[+-]\\s*\\d+') },
  { law: 'P5', what: 'a refused bind read only as "already in use" (EACCES and EADDRNOTAVAIL then wait out the boot timer)',
    re: /\/(?![*/])[^/\n]*already in use[^/\n]*\/[gimsuy]*\.test\(|\.(?:includes|indexOf)\(\s*['"][^'"\n]*already in use/g,
    unless: m => /EACCES|elevated/.test(m[0]) },
  { law: 'P6', what: 'two ports drawn one after the other (the first probe has closed, so the OS can hand out the same port twice)',
    re: RE('\\bawait\\s+allocatePort\\(\\)\\s*,\\s*' + IDENT + '\\s*=\\s*await\\s+allocatePort\\(\\)' +
      '|\\[\\s*(?:await\\s+)?allocatePort\\(\\)\\s*,\\s*(?:await\\s+)?allocatePort\\(\\)') }
];

// every violation in one file's source: [{ law, what, line, text }]
function scan(src) {
  const code = decomment(src);
  const named = literalBindings(code);
  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let m; (m = rule.re.exec(code));) {
      if (rule.literal && !inRange(Number(m[1]))) continue;
      if (rule.named && !(named.has(m[1]) && inRange(named.get(m[1])))) continue;
      if (rule.portish && !PORTISH.test(m[1])) continue;
      if (rule.unless && rule.unless(m)) continue;
      const line = code.slice(0, m.index).split('\n').length;
      found.push({ law: rule.law, what: rule.what, line, text: m[0].replace(/\s+/g, ' ').trim() });
    }
  }
  return found;
}

function walk(rel, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = rel + '/' + entry.name;
    if (entry.isDirectory()) walk(child, out);
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(child);
  }
  return out;
}

// ---- the lexer blanks comments and nothing else ----
{
  const keep = [
    "const glob = 'test/*.js';\nserver.listen(8899);\nconst tail = '*/';",                 // a /* in a string
    'const re = /\\/\\*/;\nserver.listen(8899);\nconst tail = "*/";',                      // a /* in a regex literal
    "const s = 'a // b'; server.listen(8899);",                                             // a // in a string
    'const g = `${path.join(dir, `sub`)}/*.js`;\nserver.listen(8899);\nconst tail = "*/";', // a /* in a nested template
    "const u = `http://${host}:${port}/`; server.listen(8899);"                             // a // in a template
  ];
  for (const src of keep) A.ok(/server\.listen\(8899\)/.test(decomment(src)), 'decomment keeps the code after: ' + src);
  const crlf = 'const a = 1; // boot(8880 + (process.pid % 40))\r\n/* server.listen(8899) */ const b = x / 2 / y;\r\n';
  const out = decomment(crlf);
  A.ok(!/boot|listen/.test(out) && /const b = x \/ 2 \/ y;/.test(out), 'decomment blanks // and /* */ in a CRLF file and keeps a division: ' + JSON.stringify(out));
  A.eq(out.length, crlf.length, 'decomment keeps every offset');
  A.eq(decomment('#!/usr/bin/env node\nlisten(1);').split('\n')[1], 'listen(1);', 'a hashbang is blanked and the code after it kept');
}

// ---- the scanner sees what it must, and nothing it must not (so it cannot quietly go dead) ----
const MUST_FLAG = [
  ['P1', "const booted = await boot(8880 + (process.pid % 40), ws, 20);"],
  ['P1', "const port = 9000 + (process.pid & 63);"],
  ['P1', "const port = 8800 + process.pid * 7 % 100;"],
  ['P1', "let port = Number(opts.port || (19200 + (process.pid % 600)));"],
  ['P2', "const b = await boot(18990 + Math.floor(Math.random() * 400), ws, 6);"],
  ['P2', "const port = 9000 + ((Math.random() * 400) | 0);"],
  ['P2', "const port = 9000 + crypto.randomInt(400);"],
  ['P2', "const port = 8800 + (Date.now() % 100);"],
  ['P2', "const port = srv.address().port, cdpPort = 9600 + Math.floor(Math.random() * 300);"],
  ['P3', "server.listen(8899, '127.0.0.1', done);"],
  ['P3', "srv.listen({ host: HOST, port: 9100 });"],
  ['P3', "const PORT = 9333;\nserver.listen(PORT, HOST);"],
  ['P3', "const { child } = await boot(8884, env, 20);"],
  ['P3', "const { child } = await boot(9000 + n, env, 20);"],
  ['P3', "const BASE = 9100;\nawait boot(BASE + i, env, 20);"],
  ['P3', "const child = bootSeededSidecar({ port: 9100, scratchDir });"],
  ['P3', "const mock = await startMock({ host: HOST, port: 9100 });"],
  ['P3', "launchChrome({ cdpPort: 9222 });"],
  ['P3', "const PORT = 9002;\nserver.listen({ host: HOST, port: PORT });"],
  ['P3', "spawn(process.execPath, [CLI, '--port', '9001']);"],
  ['P3', "spawn(process.execPath, [CLI, '--port=9001']);"],
  ['P3', "env: { STARNET_PORT: '8787' }"],
  ['P3', "env: Object.assign({}, process.env, { 'STARNET_PORT': '8902' })"],
  ['P3', "process.env.STARNET_PORT = String(8904);"],
  ['P3', "env.SKYNET_PORT = '8903';"],
  ['P3', "env: { STARNET_REMOTE_PORT: '8797', STARNET_REMOTE_LAN: '1' }"],
  ['P3', "env: { SKYNET_PORT: String(9000 + i) }"],
  ['P3', "const PORT = 9001;\nenv: { SKYNET_PORT: String(PORT) }"],
  ['P3', "const glob = 'test/*.js';\nserver.listen(8899);\nconst tail = '*/';"],
  ['P3', "const s = 'a // b'; server.listen(8899);"],
  ['P4', "if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1));"],
  ['P4', "booted = await boot(booted.port + 1, ws, 20);"],
  ['P4', "srv.listen(basePort + 2, HOST);"],
  ['P4', "env: { SKYNET_PORT: String(port + 1) }"],
  ['P4', "let port3 = b2.port + 1;"],
  ['P4', "const port = await allocatePort(), cdpPort = port + 1000;"],
  ['P4', "const port = Number(process.env.WIDGET_PROOF_PORT || 9190), fixturePort = port + 1;"],
  ['P5', "if (!settled && /already in use/i.test(out)) { settled = true; reject(new Error('port taken')); }"],
  ['P5', "if (out.includes('already in use')) retry();"],
  ['P6', "const port = await allocatePort(), cdpPort = await allocatePort();"],
  ['P6', "const [port, cdpPort] = await Promise.all([allocatePort(), allocatePort()]);"]
];
const MUST_PASS = [
  "const { child, port } = await boot(await allocatePort(), env, 20);",
  "if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));",
  "server.listen(0, '127.0.0.1', () => resolve(server.address().port));",
  "relay.listen(port, '127.0.0.1');",
  "const PORT = 8787;\nA.eq(auth.isAllowedApiOrigin('http://127.0.0.1:' + PORT, PORT), true);",
  "// boot(8880 + (process.pid % 40), ws, 20) was the old way\n/* server.listen(8899) */",
  "// boot(8880 + (process.pid % 40), ws, 20) was the old way\r\nconst x = 1;\r\n",
  "server.listen(80);",
  "const tag = 'run-' + process.pid;",
  "if (cur && cur.pid === process.pid && cur.host === os.hostname()) fs.unlinkSync(LOCK_FILE);",
  "A.ok(seen.port === port + 1, 'a comparison is not a pick');",
  "if (env.STARNET_PORT === '8787') skip();",
  "const cdpPort = await allocatePort();",
  "const [port, cdpPort] = await allocatePorts(2);",
  "const importEnd = importStart + 2;",
  "const reportIdx = reportStart + 1;",
  "bootstrap(reportIndex + 1);",
  "await bootstrapFor(3000, opts);",
  "const TIMEOUT_MS = 5000;\nawait bootWithin(TIMEOUT_MS);",
  "if (!settled && BIND_REFUSED.test(out)) retry();",
  "if (/already in use|listen EACCES/.test(out)) retry();",
  "throw new Error('port ' + port + ' is already in use: another station is probably there');"
];
for (const [law, snippet] of MUST_FLAG) {
  const hits = scan(snippet);
  A.ok(hits.some(h => h.law === law), 'scanner flags ' + law + ': ' + snippet + ' (got ' + JSON.stringify(hits) + ')');
}
for (const snippet of MUST_PASS) A.eq(scan(snippet), [], 'scanner passes: ' + snippet);

// ---- the tree ----
const lawsFor = rel => (SCOPES.find(s => rel.startsWith(s.dir + '/')) || { laws: [] }).laws;
const files = [].concat(...SCOPES.map(s => walk(s.dir, []))).filter(rel => !EXEMPT.has(rel)).sort();
A.ok(files.length > 1000, 'the scan finds the test files (' + files.length + ')');
for (const s of SCOPES) A.ok(files.filter(rel => rel.startsWith(s.dir + '/')).length > 20, 'the scan reaches ' + s.dir + '/');
for (const rel of EXEMPT) A.ok(fs.existsSync(path.join(ROOT, rel)), 'EXEMPT ' + rel + ' exists (drop the entry when the file goes)');

// a comment that still promises the old "next port" retry teaches the next reader to write port + 1 again
const STALE_RETRY = /\bretr(?:y|ies) (?:on )?the next port\b/i;
A.ok(STALE_RETRY.test('// spawn the real sidecar. Retries the next port on EADDRINUSE.') &&
  !STALE_RETRY.test('// Retries a refused bind (BIND_REFUSED) on a fresh allocatePort().'), 'the stale-retry wording check is live');

const used = new Set();
const violations = [];
for (const rel of files) {
  const laws = lawsFor(rel);
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const stale = STALE_RETRY.exec(source);
  if (stale) violations.push(rel + ':' + source.slice(0, stale.index).split('\n').length + ' a comment still promises a ' +
    'port + 1 retry: ' + stale[0] + ' (say: retries a refused bind (BIND_REFUSED) on a fresh allocatePort())');
  for (const hit of scan(source)) {
    if (laws.indexOf(hit.law) < 0) continue;
    const allowed = ALLOW.findIndex(a => a.file === rel && a.law === hit.law && [].concat(a.match).some(t => hit.text.indexOf(t) >= 0));
    if (allowed >= 0) { used.add(allowed); continue; }
    violations.push(rel + ':' + hit.line + ' ' + hit.law + ' ' + hit.what + ': ' + hit.text);
  }
}
if (violations.length) {
  console.log('test-ports: ' + violations.length + ' site(s) pick their own port. Use `await allocatePort()` (or ' +
    '`await allocatePorts(n)` for several at once) from test/helpers/ports.js, or listen(0), and retry a refused boot ' +
    '(BIND_REFUSED) on a fresh allocatePort(), never port + 1:');
  for (const v of violations) console.log('  ' + v);
}
A.eq(violations.length, 0, 'every port a test binds comes from the OS (' + violations.length + ' site(s) pick their own)');

// ---- the retry trigger: a refused bind is recognised however the OS refused it, and nothing else is ----
// The sidecar's own words for a refused listen (server.on('error') in sidecar/index.js, and the degraded holding
// listener's error handler), read from the source so a reworded message breaks this lock instead of silently turning
// a retry back into a 30 s boot timeout.
const { BIND_REFUSED, allocatePorts } = require('./helpers/ports.js');
const { readSidecarSource } = require('./helpers/source.js');
const sidecarSource = readSidecarSource();
const sidecarLines = [];
for (let m, re = /console\.error\('(✗ Port )' \+ PORT \+ '([^']+)'\)/g; (m = re.exec(sidecarSource));) sidecarLines.push(m[1] + '8884' + m[2]);
A.ok(sidecarLines.some(l => /already in use/.test(l)) && sidecarLines.some(l => /elevated privileges/.test(l)),
  'the sidecar still words both refused listens, in use and EACCES (' + JSON.stringify(sidecarLines) + ')');
const holdLines = [];
for (let m, re = /console\.error\('([^']*could not bind :)' \+ PORT \+ '( \()' \+ String\(e && e\.code \|\| e\) \+ '(\)[^']*)'\)/g;
  (m = re.exec(sidecarSource));) holdLines.push(m[1] + '8884' + m[2] + 'EACCES' + m[3]);
A.ok(holdLines.length === 1 && / \(EACCES\) — exiting 73$/.test(holdLines[0]),
  'the sidecar still words the degraded holding listener\'s refused bind, with its error code (' + JSON.stringify(holdLines) + ')');
for (const line of sidecarLines.concat(holdLines, [
  'Error: listen EADDRINUSE: address already in use 127.0.0.1:8884',   // node's raw errors, as a mock server prints them
  'Error: listen EACCES: permission denied 127.0.0.1:8884',
  '✗ sidecar listen error: Error: listen EADDRNOTAVAIL: address not available 192.0.2.1:8884',
  '✗ degraded holding listener could not bind :8884 (EADDRINUSE) — exiting 73'
])) A.ok(BIND_REFUSED.test(line), 'BIND_REFUSED retries on: ' + line);
for (const line of [
  '[backup] write failed: permission denied for C:\\ws\\agent',          // sidecar/backupfile.js: a disk error
  "EACCES: permission denied, open 'C:\\ws\\agent\\agent.save.json'",
  'Error: connect EADDRNOTAVAIL 0.0.0.0:9 - Local (0.0.0.0:0)',            // an outgoing call, not our listen
  'provider error: permission denied https://api.example.com:443/v1/chat/completions',
  'fetch failed: connect EACCES 10.0.0.1:443'
]) A.ok(!BIND_REFUSED.test(line), 'BIND_REFUSED does not read as a refused port of ours: ' + line);

A.ok(ALLOW.length <= 4, 'ALLOW stays short (' + ALLOW.length + ')');
ALLOW.forEach((a, i) => {
  A.ok(String(a.reason || '').length > 30, 'ALLOW ' + a.file + ' ' + a.match + ' says why');
  A.ok(used.has(i), 'ALLOW ' + a.file + ' ' + a.match + ' still matches a site (drop the entry when the literal goes)');
});

// ---- allocatePorts(n): n distinct ports at once, every one bindable when it is handed out ----
(async () => {
  const net = require('node:net');
  const ports = await allocatePorts(16);
  A.eq(ports.length, 16, 'allocatePorts(16) hands back 16 ports');
  A.eq(new Set(ports).size, 16, 'allocatePorts never hands back the same port twice in one call (' + ports.join(',') + ')');
  A.ok(ports.every(p => Number.isInteger(p) && p > 0 && p <= MAX_PORT), 'every allocated port is a real port');
  const held = [];
  try {
    for (const port of ports) {
      const server = net.createServer();
      held.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    }
    A.ok(true, 'every port allocatePorts handed back binds, all at once');
  } catch (error) {
    A.ok(false, 'a port allocatePorts handed back did not bind: ' + (error && error.message));
  } finally {
    await Promise.all(held.map(server => new Promise(resolve => server.close(() => resolve()))));
  }
  A.eq(await allocatePorts(0), [], 'allocatePorts(0) is an empty list');
  let refused = false;
  try { await allocatePorts(-1); } catch (_) { refused = true; }
  A.ok(refused, 'allocatePorts refuses a count that is not a whole number');
  A.report('test-ports.lint.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
