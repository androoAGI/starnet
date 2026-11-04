/* node test/tool-description.platform-snapshot.test.js — TOOL DESCRIPTIONS TELL THE TRUTH ON EVERY PLATFORM (gh#128 family).

   A tool description is ONE string per machine: it rides the cached tool schema to every model that machine serves, so
   a platform word in it is a claim about the machine. #128 (shell.exec told Linux models to use PowerShell) was fixed
   for the shell alone; the family lived on in computer.use ("on the Windows desktop") and browser.test_navigate ("never
   reach Windows"), false on macOS and Linux. The family's invariant, over the wire text of EVERY tool the host declares
   (tools/catalog.js buildCatalog: the real factories), for win32, darwin, linux and a platform no one wrote words for:
     1. no tool description, precondition or schema string names ANOTHER platform's OS or shell;
     2. a description that differs between platforms differs ONLY by runtimeinfo.hostFacts' phrase, and every such
        tool is listed in PHRASED below (a new platform-varying description takes its words from that table, or this fails);
     3. shell.exec's refused-forms clause is the names in the floor's own rule table (shell.js FLOOR_RULES), each named
        form is refused by its own row, and the table answers exactly as the base's if-chain did (golden function);
     4. the win32 bytes of the three descriptions this rewired are the base's (golden), so the cached tool prefix and
        test/payload.budget.test.js do not move on Windows; and a factory built without a platform (index.js) describes
        this host.
   RED at 0b8441064 (safe-egress S4): buildCatalog ignores the platform, so the darwin and linux catalogues say "the
   Windows desktop" and "never reach Windows"; hostFacts and FLOOR_RULES do not exist. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Catalog = require('../sidecar/tools/catalog.js');
const RuntimeInfo = require('../sidecar/runtimeinfo.js');
const Shell = require('../sidecar/tools/builtin/shell.js');

const PLATFORMS = ['win32', 'darwin', 'linux', 'freebsd'];   // freebsd: a platform hostFacts has no row for (neutral words)
const hostFacts = typeof RuntimeInfo.hostFacts === 'function' ? RuntimeInfo.hostFacts : null;
A.ok(hostFacts, 'runtimeinfo.hostFacts exists: the one table of platform phrases a description may state');

// each platform's own words; a catalogue declared for one platform may name only its own
const OWN = {
  win32: [/\bWindows\b/, /\bWin32\b/, /\bcmd\.exe\b/i, /\bpower ?shell\b/i, /\bpwsh\b/i],
  darwin: [/\bmacOS\b/, /\bMac ?OS\b/, /\bOS X\b/],
  linux: [/\bLinux\b/],
  posix: [/\/bin\/(?:ba|z|da)?sh\b/]   // the POSIX hosts' shell: never on Windows
};
const OWNED_BY = { win32: ['win32'], darwin: ['darwin', 'posix'], linux: ['linux', 'posix'] };
const forbiddenOn = p => Object.keys(OWN).filter(k => (OWNED_BY[p] || ['posix']).indexOf(k) < 0)
  .reduce((all, k) => all.concat(OWN[k].map(re => ({ owner: k, re }))), []);

// the tools whose description states a platform fact, and the hostFacts key it states
const PHRASED = { 'computer.use': 'desktop', 'browser.test_navigate': 'desktopShort' };

// every string a tool puts on the wire: the description as sent (with any preconditions) and every schema string
function wireTexts(entry) {
  const out = [['description', String(entry.function.description || '')]];
  (function walk(node, where) {
    if (typeof node === 'string') { out.push([where, node]); return; }
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) walk(node[k], where + '.' + k);
  })(entry.function.parameters, 'schema');
  return out;
}
const catalogs = {};
for (const p of PLATFORMS) {
  try {
    const reg = Catalog.buildCatalog({ platform: p });
    catalogs[p] = new Map(reg.wireFormat().map(e => [e.function.name, wireTexts(e)]));
  } catch (e) { A.ok(false, 'buildCatalog({ platform: ' + p + ' }) builds: ' + e.message); catalogs[p] = new Map(); }
}
A.ok(catalogs.win32.size > 100, 'the catalogue declares the real tool surface (' + catalogs.win32.size + ' tools)');

// 1. no platform's catalogue names another platform's OS or shell
for (const p of PLATFORMS) {
  const hits = [];
  for (const [name, texts] of catalogs[p]) {
    for (const [where, s] of texts) for (const { owner, re } of forbiddenOn(p)) if (re.test(s)) hits.push(name + ' ' + where + ' names ' + owner + ' (' + s.match(re)[0] + ')');
  }
  A.eq(hits, [], p + ': no tool text names another platform\'s OS or shell');
}

// 2. a description varies by platform ONLY by its hostFacts phrase, and only for a PHRASED tool
const once = (s, part) => !!part && s.split(part).length === 2;
for (const p of PLATFORMS.slice(1)) {
  const diffs = [];
  let compared = 0;
  for (const [name, texts] of catalogs.win32) {
    const other = catalogs[p].get(name);
    if (!other) continue;   // which tools a platform declares is the factories' business; this test is about the words
    compared++;
    for (let i = 0; i < Math.max(texts.length, other.length); i++) {
      const a = texts[i] || ['missing', ''], b = other[i] || ['missing', ''];
      if (PHRASED[name] && a[0] === 'description' && b[0] === 'description') continue;   // checked below, against hostFacts
      if (a[1] !== b[1] || a[0] !== b[0]) diffs.push(name + ' ' + a[0] + ': ' + JSON.stringify(a[1]).slice(0, 120) + ' vs ' + JSON.stringify(b[1]).slice(0, 120));
    }
  }
  A.ok(compared > 100, 'win32 and ' + p + ' declare the same tools to compare (' + compared + ')');
  A.eq(diffs, [], 'win32 vs ' + p + ': no tool text varies by platform outside runtimeinfo.hostFacts (a platform-varying text takes its words from that table and is listed in PHRASED)');
}
for (const [name, key] of Object.entries(PHRASED)) {
  const templates = new Set();
  for (const p of PLATFORMS) {
    const texts = catalogs[p].get(name);
    if (!texts) { A.ok(false, name + ' is declared on ' + p); continue; }
    const desc = texts[0][1];
    const phrase = hostFacts ? hostFacts(p)[key] : null;
    A.ok(once(desc, phrase), name + ' on ' + p + ' states hostFacts(' + p + ').' + key + ' (' + JSON.stringify(phrase) + ') exactly once: ' + JSON.stringify(desc));
    templates.add(phrase ? desc.split(phrase).join('{' + key + '}') : desc);
  }
  A.eq(templates.size, 1, name + ': the description is the same words on every platform except the hostFacts phrase');
}
if (hostFacts) {
  A.ok(/^PHYSICAL mouse\/keyboard\/screen control on the macOS desktop\. /.test(catalogs.darwin.get('computer.use')[0][1]), 'darwin: computer.use controls the macOS desktop');
  A.ok(/so they never reach the desktop\.$/.test(catalogs.linux.get('browser.test_navigate')[0][1]), 'linux: browser.test_navigate locks never reach the desktop');
}

// 3. shell.exec's refused-forms clause is the floor's own table
const rules = Array.isArray(Shell.FLOOR_RULES) ? Shell.FLOOR_RULES : null;
A.ok(rules && rules.length > 0, 'shell.js exports the floor as one rule table (FLOOR_RULES)');
if (rules) {
  const named = rules.reduce((all, r) => all.concat(r.names), []);
  A.ok(named.length >= 2, 'the table names the forms the description states (' + named.length + ')');
  const clause = named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1];
  for (const p of PLATFORMS) {
    const desc = catalogs[p].get('shell.exec') ? catalogs[p].get('shell.exec')[0][1] : '';
    const m = /folder\. (.+?) paths in cmd, /.exec(desc);
    A.eq(m && m[1], clause, p + ': shell.exec names exactly the floor table\'s forms, in its order');
  }
  // a named form is a promise: its own row refuses a command written that way (the first matching row answers)
  const SAMPLE = { '`..`': 'cat ../notes.md', 'C:\\…': 'type C:\\notes.md', '\\…': 'type \\notes.md' };
  for (const r of rules) {
    A.ok(r.re instanceof RegExp && !r.re.global && !r.re.sticky && typeof r.why === 'string' && Object.isFrozen(r) && Object.isFrozen(r.names), 'a floor row is frozen { re (stateless), why, names }: ' + r.why);
    for (const n of r.names) {
      A.ok(Object.prototype.hasOwnProperty.call(SAMPLE, n), 'the named form ' + n + ' has a sample here (a new named row brings one)');
      if (SAMPLE[n]) A.eq(Shell.escapesWorkspace(SAMPLE[n]), r.why, 'the named form ' + n + ' is refused by its own row (' + SAMPLE[n] + ')');
    }
  }
}
// the table answers exactly as the base's if-chain (0b8441064 shell.js escapesWorkspace, verbatim): a pure move
function baseEscapesWorkspace(cmd) {
  if (/(^|[\s"'`=(])\.\.([\\/]|$)/.test(cmd)) return 'parent-directory (..) paths are not allowed — commands run inside your own workspace';
  if (/(^|[\s"'`=(])[A-Za-z]:[\\/]/.test(cmd)) return 'drive-absolute paths (C:\\…) are not allowed — use paths inside your workspace';
  if (/(^|[\s"'`=(])\\\\[^\s\\]/.test(cmd)) return 'UNC paths (\\\\server) are not allowed';
  if (/(^|[\s"'`=(])\\(?![\\])/.test(cmd)) return 'drive-root paths (\\…) are not allowed — use paths inside your workspace';
  if (/\.checkpoints|permissions\.allow|\.notebook\.json|channels[\\/]+secrets|codex[\\/]+tokens|ledger\.jsonl|cron\.jobs\.json/i.test(cmd)) return 'that path is a protected harness control file';
  return null;
}
const CORPUS = [
  '', 'ls -la', 'git log main..HEAD', 'git diff a...b', 'cat ../x', 'cd ..', 'cd ..\\up', 'type "..\\x"', "echo '../x'", 'x=../y', '(cd ../x)', '`cat ../x`', 'npm run ..', 'a..b/c',
  'type C:\\Windows\\win.ini', 'dir D:/data', 'echo c:\\x', 'node a:b', 'x="C:\\y"', 'scp host:/x .', 'http://example.com/a',
  'copy \\\\server\\share\\f .', 'dir \\\\?\\C:\\x', '\\\\srv', 'echo \\\\ x',
  'type \\Users\\me\\secret.txt', 'cd \\', 'dir \\Windows', 'echo "\\n"', "printf '\\n'", 'grep "\\.js" a.txt', 'echo a\\b',
  'robocopy src dst /S /E', 'type subdir\\file.txt', 'mkdir foo\\bar', 'ls /etc', 'cat /c/Users/x',
  'cat .checkpoints/x', 'type PERMISSIONS.ALLOW', 'cat channels\\\\secrets\\x', 'cat channels//secrets', 'cat codex/tokens/a', 'tail ledger.jsonl', 'cat cron.jobs.json', 'cat .notebook.json',
  'cat ../.checkpoints/x', 'type C:\\x\\ledger.jsonl', 'dir \\\\srv\\cron.jobs.json'
];
const shellTool = Shell.makeShellTool({ spawn: () => { throw new Error('never runs'); }, fs, pathMod: path, root: os.tmpdir(), bg: {} });
const drift = CORPUS.filter(c => Shell.escapesWorkspace(c) !== baseEscapesWorkspace(c) || shellTool._internals.escapesWorkspace(c) !== baseEscapesWorkspace(c));
A.eq(drift, [], 'escapesWorkspace answers every corpus command exactly as the base if-chain (' + CORPUS.length + ' commands, ' + CORPUS.filter(baseEscapesWorkspace).length + ' refused)');

// 4. the win32 bytes are the base's (golden, 0b8441064), and a factory built without a platform describes this host
const GOLDEN_WIN32 = {
  'computer.use': 'PHYSICAL mouse/keyboard/screen control on the Windows desktop. Available under host-minted Full Power or to a locally paired Telegram owner; restricted runs remain synthetic-only.',
  'browser.test_navigate': 'Open an agent-owned local dev URL (127.0.0.1/localhost/::1 only) in the HEADLESS CDP browser for UI/game testing. In normal runs serverId must name this agent\'s running shell background server. Physical pointer/keyboard locks are emulated inside the page, so they never reach Windows.',
  'shell.exec': 'Run a shell command in the current project folder when this session is project-scoped, otherwise in your private workspace; returns combined stdout/stderr + exit code. '
    + 'Tests, builds, git, scripts: anything you would type in a terminal. Write it for the shell on the [RUNTIME] Shell line. '
    + 'Your working directory PERSISTS across calls (a `cd` carries over); pass cwd to run from a specific existing folder. '
    + '`..`, C:\\… and \\… paths in cmd, and commands that would change the user\'s machine or screen, are refused '
    + 'in restricted modes; Full Power may run any host command the current OS user can run. '
    + 'timeoutMs: default 30s, max 10 min (timeout_ms works too). background:true returns a handle '
    + 'at once for long-running processes (dev servers): check shell.bg.status, read its log with '
    + 'shell.bg.read, answer its prompts with shell.bg.write, stop it with shell.bg.kill.'
};
for (const [name, golden] of Object.entries(GOLDEN_WIN32)) {
  const texts = catalogs.win32.get(name);
  A.eq(texts && texts[0][1], golden, 'win32 ' + name + ' description is byte-identical to the base (cached prefix, payload.budget)');
}
const hostDefault = new Map(Catalog.buildCatalog().wireFormat().map(e => [e.function.name, e.function.description]));
for (const name of Object.keys(GOLDEN_WIN32)) {
  A.eq(hostDefault.get(name), (catalogs[process.platform] || catalogs.freebsd).get(name)[0][1], 'buildCatalog() with no platform declares ' + name + ' for this host (' + process.platform + ')');
}
// the run's own registrations (index.js passes no platform) describe this host the same way
const runComputer = require('../sidecar/tools/builtin/computer.js').makeComputerTools({ allowPhysicalInput: false });
A.eq(runComputer.useTool.description, hostDefault.get('computer.use'), 'makeComputerTools without a platform describes this host\'s desktop');
const runBrowser = require('../sidecar/tools/builtin/browser.js').makeBrowserTools({ session: {} });
A.eq((runBrowser.tools.find(t => t.name === 'browser.test_navigate') || {}).description, hostDefault.get('browser.test_navigate'), 'makeBrowserTools without a platform describes this host');
A.eq(shellTool.execTool.description, hostDefault.get('shell.exec'), 'makeShellTool without a platform: the same shell.exec bytes');

A.report('tool-description.platform-snapshot');
