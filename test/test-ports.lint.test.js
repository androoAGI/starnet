'use strict';
/* node test/test-ports.lint.test.js — no test picks its own TCP port; the OS does.

   THE HOLE THIS CLOSES (2026-10-28): 81 test files booted the sidecar on BASE + (process.pid % N).
   On the remote gate laptop Windows reserves 8883, 8884 and 8886 (and 5357, 50000-50059: see
   `netsh int ipv4 show excludedportrange protocol=tcp`). boot-security landed on 8884, the sidecar got EACCES, and
   the test waited out its 30 s boot timer, because it retried only on "already in use" — and its retry was port + 1,
   which from 8883 is reserved too. PID-derived ports also collide between parallel runs.

   Every port a test binds now comes from the OS: allocatePort() in test/helpers/ports.js (listen(0) on the loopback
   host), or a server's own listen(0). A boot that is refused retries on a fresh allocatePort(), on EACCES and
   EADDRNOTAVAIL as well as EADDRINUSE (ports.BIND_REFUSED).

   Laws, over every .js / .mjs / .cjs file under test/ with comments stripped (the allocation helper and this file
   excepted):
     P1 no port is computed from process.pid (or ppid);
     P2 no port is a fixed base plus Math.random();
     P3 nothing binds a literal port in 1024..65535: .listen(<n>), .listen({ port: <n> }), a boot helper's first
        argument, '--port', '<n>' / --port=<n>, SKYNET_PORT / STARNET_PORT set to <n>, or .listen / boot of a
        name the file binds to such a literal;
     P4 no boot, listen or port name derives its port from another port (boot(port + 1, ...), listen(basePort + 3),
        cdpPort = port + 1000): the neighbour of a bindable port is not proven bindable.
   ALLOW names the few literals that must stay, each with its reason, and must stay short. The scanner proves itself on
   snippets first, and BIND_REFUSED is held to the sidecar's own refused-listen wording, so neither can go dead. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIR = 'test';
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
    reason: 'boot(nowMs, loader) there starts the return store at a fake clock time; the number is a timestamp, not a port' }
];

const MIN_PORT = 1024, MAX_PORT = 65535;
const IDENT = '[A-Za-z_$][\\w$]*';

// blank out /* */ blocks (keeping newlines, so line numbers hold) and // line comments (keeping :// in URLs)
function decomment(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n').map(line => line.replace(/(^|[^:\\])\/\/.*$/, '$1')).join('\n');
}

function literalBindings(code) {
  const out = new Map();
  const re = new RegExp('\\b(?:const|let|var)\\s+(' + IDENT + ')\\s*=\\s*(\\d+)\\s*[;,\\n]', 'g');
  for (let m; (m = re.exec(code));) out.set(m[1], Number(m[2]));
  return out;
}

const inRange = n => Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;

const RULES = [
  { law: 'P1', what: 'a port computed from process.pid', re: /\bprocess\.p?pid\s*[%&]|[%&]\s*process\.p?pid\b/g },
  { law: 'P2', what: 'a port picked from a fixed range with Math.random()',
    re: /\b\d{4,5}\s*\+\s*(?:Math\.(?:floor|round|trunc)\(\s*)?Math\.random\(\)|Math\.random\(\)\s*\*\s*\d+\s*\)?\s*\+\s*\d{4,5}\b/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /\.listen\(\s*(\d+)\b/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /\.listen\(\s*\{[^}]*?\bport\s*:\s*(\d+)\b/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /\bboot\w*\(\s*(\d+)\s*,/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /['"]--port['"]\s*,\s*['"]?(\d+)\b/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /--port=(\d+)\b/g },
  { law: 'P3', what: 'a fixed literal port that is bound', literal: true, re: /\b(?:SKYNET|STARNET)_PORT\s*[:=]\s*['"]?(\d+)\b/g },
  { law: 'P3', what: 'a name bound to a literal port, then bound', named: true,
    re: new RegExp('(?:\\.listen|\\bboot\\w*)\\(\\s*(' + IDENT + ')\\s*[,)]', 'g') },
  { law: 'P4', what: 'a port derived from another port',
    re: new RegExp('(?:\\.listen|\\bboot\\w*)\\(\\s*(?:' + IDENT + '\\.)?[\\w$]*[Pp]ort[\\w$]*\\s*[+-]\\s*\\d+', 'g') },
  { law: 'P4', what: 'a port derived from another port',
    re: /\b(?:SKYNET|STARNET)_PORT\s*:\s*String\(\s*(?:[\w$]+\.)?[\w$]*[Pp]ort[\w$]*\s*[+-]\s*\d+/g },
  { law: 'P4', what: 'a port derived from another port',
    re: /\b[\w$]*[Pp]ort[\w$]*\s*(?<![=!<>])=(?!=)\s*(?:[\w$]+\.)?[\w$]*[Pp]ort[\w$]*\s*[+-]\s*\d+/g }
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

// ---- the scanner sees what it must, and nothing it must not (so it cannot quietly go dead) ----
const MUST_FLAG = [
  ['P1', "const booted = await boot(8880 + (process.pid % 40), ws, 20);"],
  ['P1', "const port = 9000 + (process.pid & 63);"],
  ['P2', "const b = await boot(18990 + Math.floor(Math.random() * 400), ws, 6);"],
  ['P3', "server.listen(8899, '127.0.0.1', done);"],
  ['P3', "srv.listen({ host: HOST, port: 9100 });"],
  ['P3', "const PORT = 9333;\nserver.listen(PORT, HOST);"],
  ['P3', "const { child } = await boot(8884, env, 20);"],
  ['P3', "spawn(process.execPath, [CLI, '--port', '9001']);"],
  ['P3', "spawn(process.execPath, [CLI, '--port=9001']);"],
  ['P3', "env: { STARNET_PORT: '8787' }"],
  ['P4', "if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1));"],
  ['P4', "booted = await boot(booted.port + 1, ws, 20);"],
  ['P4', "srv.listen(basePort + 2, HOST);"],
  ['P4', "env: { SKYNET_PORT: String(port + 1) }"],
  ['P4', "let port3 = b2.port + 1;"],
  ['P4', "const port = await allocatePort(), cdpPort = port + 1000;"]
];
const MUST_PASS = [
  "const { child, port } = await boot(await allocatePort(), env, 20);",
  "if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));",
  "server.listen(0, '127.0.0.1', () => resolve(server.address().port));",
  "relay.listen(port, '127.0.0.1');",
  "const PORT = 8787;\nA.eq(auth.isAllowedApiOrigin('http://127.0.0.1:' + PORT, PORT), true);",
  "// boot(8880 + (process.pid % 40), ws, 20) was the old way\n/* server.listen(8899) */",
  "server.listen(80);",
  "const tag = 'run-' + process.pid;",
  "A.ok(seen.port === port + 1, 'a comparison is not a pick');",
  "const cdpPort = await allocatePort();"
];
for (const [law, snippet] of MUST_FLAG) {
  const hits = scan(snippet);
  A.ok(hits.some(h => h.law === law), 'scanner flags ' + law + ': ' + snippet + ' (got ' + JSON.stringify(hits) + ')');
}
for (const snippet of MUST_PASS) A.eq(scan(snippet), [], 'scanner passes: ' + snippet);

// ---- the tree ----
const files = walk(SCAN_DIR, []).filter(rel => !EXEMPT.has(rel)).sort();
A.ok(files.length > 1000, 'the scan finds the test files (' + files.length + ')');
for (const rel of EXEMPT) A.ok(fs.existsSync(path.join(ROOT, rel)), 'EXEMPT ' + rel + ' exists (drop the entry when the file goes)');

const used = new Set();
const violations = [];
for (const rel of files) {
  for (const hit of scan(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
    const allowed = ALLOW.findIndex(a => a.file === rel && a.law === hit.law && [].concat(a.match).some(t => hit.text.indexOf(t) >= 0));
    if (allowed >= 0) { used.add(allowed); continue; }
    violations.push(rel + ':' + hit.line + ' ' + hit.law + ' ' + hit.what + ': ' + hit.text);
  }
}
if (violations.length) {
  console.log('test-ports: ' + violations.length + ' site(s) pick their own port. Use `await allocatePort()` from ' +
    'test/helpers/ports.js (or listen(0)), and retry a refused boot on a fresh allocatePort(), never port + 1:');
  for (const v of violations) console.log('  ' + v);
}
A.eq(violations.length, 0, 'every port a test binds comes from the OS (' + violations.length + ' site(s) pick their own)');

// ---- the retry trigger: a refused boot is recognised however the OS refused it ----
// The sidecar's own words for a refused listen (server.on('error') in sidecar/index.js), read from the source so a
// reworded message breaks this lock instead of silently turning a retry back into a 30 s boot timeout.
const { BIND_REFUSED } = require('./helpers/ports.js');
const { readSidecarSource } = require('./helpers/source.js');
const sidecarLines = [];
for (let m, re = /console\.error\('(✗ Port )' \+ PORT \+ '([^']+)'\)/g; (m = re.exec(readSidecarSource()));) sidecarLines.push(m[1] + '8884' + m[2]);
A.ok(sidecarLines.some(l => /already in use/.test(l)) && sidecarLines.some(l => /elevated privileges/.test(l)),
  'the sidecar still words both refused listens, in use and EACCES (' + JSON.stringify(sidecarLines) + ')');
for (const line of sidecarLines.concat([
  'Error: listen EADDRINUSE: address already in use 127.0.0.1:8884',   // node's raw errors, as a mock server prints them
  'Error: listen EACCES: permission denied 127.0.0.1:8884',
  '✗ sidecar listen error: Error: listen EADDRNOTAVAIL: address not available 192.0.2.1:8884'
])) A.ok(BIND_REFUSED.test(line), 'BIND_REFUSED retries on: ' + line);
A.ok(!BIND_REFUSED.test('[backup] write failed: permission denied for C:\\ws\\agent'),
  'BIND_REFUSED does not read an unrelated disk error (sidecar/backupfile.js wording) as a refused port');

A.ok(ALLOW.length <= 4, 'ALLOW stays short (' + ALLOW.length + ')');
ALLOW.forEach((a, i) => {
  A.ok(String(a.reason || '').length > 30, 'ALLOW ' + a.file + ' ' + a.match + ' says why');
  A.ok(used.has(i), 'ALLOW ' + a.file + ' ' + a.match + ' still matches a site (drop the entry when the literal goes)');
});

A.report('test-ports.lint.test');
