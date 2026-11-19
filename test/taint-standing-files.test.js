/* node test/taint-standing-files.test.js — A TAINTED RUN DOES NOT PLANT ORDERS OR AUTO-RUN FILES UNASKED (fix-sec2 review2 #8).

   A run that read outside content still writes its own workspace and the trusted projects with no card (review 5). Some
   files there are orders or code, though: an agent follows AGENTS.md, CLAUDE.md and .cursorrules as standing orders, and a
   loop's derived check, git hooks and editor tasks run package.json scripts, conftest.py, .husky/*, .envrc or
   .vscode/tasks.json with nobody watching. Locks:
     - a tainted write to one of them asks a watched run (one card naming the file, this one access, nothing recorded) and
       is refused to an unattended run, in its own workspace, in a trusted project and outside both;
     - Windows spellings of the same file (trailing dot, NTFS stream) are the same file;
     - an untainted write, a read, and a tainted write to an ordinary file are unchanged;
     - the instruction names cover everything projectbless loads, and the auto-run names cover every file the loop's
       derived check (detectCheckCommand) keys on. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makePathTrust, standingFileReason, _internals } = require('../sidecar/pathtrust.js');
const projectbless = require('../sidecar/projectbless.js');

(async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taint-standing-')));
  const workspaces = path.join(base, 'workspaces');
  const own = path.join(workspaces, 'nova');
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  for (const d of [own, project, home, path.join(project, '.husky'), path.join(project, '.vscode')]) fs.mkdirSync(d, { recursive: true });
  const blessed = [];
  const pt = makePathTrust({ fsp: fs.promises, pathMod: path, workspaceRoot: workspaces, roots: () => [project],
    bless: async r => { blessed.push(r); return true; }, now: () => 1 });
  const asked = [];
  const say = d => async (root, meta) => { asked.push(meta || {}); return d; };
  const g = (p, o) => pt.guard(p, Object.assign({ agentId: 'nova', surface: 'interactive', scope: 'write' }, o));
  const refused = async (p, o) => { try { await g(p, o); return ''; } catch (e) { return String(e.message || e); } };

  const standing = [path.join(project, 'AGENTS.md'), path.join(own, 'CLAUDE.md'), path.join(project, '.cursorrules'),
    path.join(project, 'package.json'), path.join(project, 'conftest.py'), path.join(project, '.husky', 'pre-commit'),
    path.join(project, '.envrc'), path.join(project, '.vscode', 'tasks.json'), path.join(project, 'Makefile'), path.join(home, 'agents.md')];
  for (const f of standing) {
    const name = path.relative(base, f);
    asked.length = 0;
    const ok = await g(f, { tainted: true, prompt: say('always') });
    A.ok(ok && asked.length === 1 && asked[0].path === f && /\(/.test(String(asked[0].standing || '')), name + ': a tainted write asks a watched run once, naming the file: ' + JSON.stringify(asked));
    A.ok(blessed.length === 0, name + ': and even ALWAYS records nothing');
    A.ok(/was denied/.test(await refused(f, { tainted: true, prompt: say('deny') })), name + ': a no is refused');
    A.ok(/read outside content/.test(await refused(f, { tainted: true, surface: 'autonomous' })), name + ': an unattended tainted write is refused');
    A.ok(/read outside content/.test(await refused(f, { tainted: () => { throw new Error('x'); }, surface: 'autonomous' })), name + ': a taint check that throws fails closed');
    asked.length = 0;
    const clean = await g(f, { tainted: false, fullAccess: f.indexOf(home) === 0, prompt: say('deny') });
    A.ok(clean && asked.length === 0, name + ': an untainted write is unchanged');
    const read = await g(f, { scope: 'read', tainted: true, prompt: say('once') });
    A.ok(!!read, name + ': a tainted read is unchanged');
  }

  // Windows spellings of the same file
  for (const alias of ['AGENTS.md.', 'AGENTS.md ', 'AGENTS.md::$DATA', 'agents.MD']) {
    A.ok(!!standingFileReason(path.join(project, alias)), 'the name "' + alias + '" is the instruction file');
  }
  // ordinary files keep flowing unasked in its own workspace and a trusted project
  asked.length = 0;
  for (const f of [path.join(project, 'src', 'app.js'), path.join(own, 'notes.md'), path.join(project, 'README.md'), path.join(project, 'agents.md.bak'),
    path.join(project, 'docs', 'tasks.json')]) {
    A.ok(!!(await g(f, { tainted: true, prompt: say('deny') })), path.relative(base, f) + ': an ordinary file still flows under taint');
  }
  A.eq(asked.length, 0, 'and nothing asked');
  // outside both: one card (the file's), not two
  asked.length = 0;
  await g(path.join(home, 'CLAUDE.md'), { tainted: true, unrestrictedHost: true, prompt: say('once') });
  A.eq(asked.length, 1, 'outside the workspace and the projects, the file\'s card is the only one');

  // the lists cover what loads as orders and what a loop's derived check keys on
  for (const spec of projectbless._internals.INSTRUCTION_FILES) {
    for (const n of spec.names) A.ok(_internals.STANDING_INSTRUCTIONS.indexOf(n.toLowerCase()) >= 0, 'projectbless loads ' + n + ': it is an instruction file here');
  }
  const IDX = require('./helpers/source.js').readSidecarIndex();
  const detect = A.fnBody(IDX, 'function detectCheckCommand(');
  const keyed = [...detect.matchAll(/has\('([^']+)'\)/g)].map(m => m[1].toLowerCase());
  A.ok(keyed.length >= 8, 'detectCheckCommand keys on files: ' + keyed.join(', '));
  for (const k of keyed) A.ok(_internals.STANDING_AUTORUN.indexOf(k) >= 0, 'the loop\'s derived check keys on ' + k + ': it is an auto-run file here');

  // review2 #12: a tainted write's card carries the exact file and what the run read, for orders files and any other file
  asked.length = 0;
  await g(path.join(project, 'AGENTS.md'), { tainted: () => 'web.fetch https://pages.example/notes', prompt: say('once') });
  await g(path.join(home, 'notes.txt'), { tainted: () => 'connector docs-search', unrestrictedHost: true, prompt: say('once') });
  A.ok(asked.length === 2 && asked.every(m => m.tainted === true), 'both tainted asks say they are tainted: ' + JSON.stringify(asked));
  A.eq(asked[0].path, path.join(project, 'AGENTS.md'), 'the orders file\'s card names the exact file');
  A.eq(asked[0].taintedBy, 'web.fetch https://pages.example/notes', 'and what the run read');
  A.eq(asked[1].path, path.join(home, 'notes.txt'), 'an ordinary tainted write outside names the exact file, not only its folder');
  A.eq(asked[1].taintedBy, 'connector docs-search', 'and what the run read');
  asked.length = 0;
  await g(path.join(home, 'plain.txt'), { scope: 'read', tainted: () => 'x', prompt: say('once') });
  A.ok(asked.length === 1 && asked[0].tainted !== true && !asked[0].taintedBy, 'a read\'s card is the ordinary folder card');
  const promptSrc = A.fnBody(IDX, 'function promptPathTrust(');
  A.ok(/file: String\(i\.path/.test(promptSrc) && /taintedBy: String\(i\.taintedBy/.test(promptSrc) && /argsSummary: String\(proposedRoot/.test(promptSrc),
    'the desk run\'s path card gets the file and the source; argsSummary stays the folder (an ALWAYS anchors to it)');
  A.ok(/if \(fields && fields\.file\) Object\.assign\(row, \{ file: fields\.file, taintedBy:/.test(IDX), 'the prompt row carries them to the page');
  A.ok(/tainted: \(\) => \(fullPowerNow\(\) && !untrustedEntryRun\) \? ''\s*: \(execution\.taintedBy\(\) \|\| \(typeof o\.connectorAuthority\?\.taintedBy === 'function' && o\.connectorAuthority\.taintedBy\(\)\) \|\| ''\)/.test(IDX),
    'the guard is handed the source itself (nothing on a Full Access agent\'s own job: FULL POWER NEVER ASKS, 2026-11-19)');
  // breakage 9 (review-sec2): that card is fresh, so the station applies any yes as once and the page offers once or deny
  A.ok(/i\.tainted === true \? \{ fresh: true \} : \{\}/.test(promptSrc), 'a tainted path card is asked fresh');
  A.ok(/if \(orig && fields && fields\.fresh\) orig\.freshConsent = true;/.test(IDX), 'so handleConsent turns ALWAYS, session and FULL into once (no Full Access is kept for one write)');
  A.ok(/if \(fields && fields\.fresh\) row\.fresh = true;/.test(IDX), 'and the prompt row tells the page');
  const CHAT = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  A.ok(/\} else if \(p\.tool === 'station\.power' \|\| p\.tool === 'plugin\.submit' \|\| p\.fresh === true(?: \|\| [^{\n]*)?\) \{/.test(CHAT), 'the page offers a fresh card only Approve once and Deny');
  A.ok(/ev\.fresh === true \? \{ fresh: true \} : \{\}/.test(CHAT) && /ev\.file \? \{ file: ev\.file, taintedBy:/.test(CHAT), 'and a card drawn again keeps both');
  A.eq(fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'app', 'chat.js'), 'utf8'), CHAT, 'chat.js is mirrored into website/app');
  A.ok(/if \(t === 'path\.trust' && ev\.file\) return 'change ' \+ ev\.file/.test(CHAT) && /this run read ' \+ \(ev\.taintedBy \|\| 'outside content'\)/.test(CHAT),
    'the card reads "change <file> ... (this run read <source> ...)"');

  /* final review #7: a granted routine script's digest covers its own bytes; what it loads beside it is guarded at the
     write. A tainted write of loadable code in the script's folder (any depth, anything under node_modules/__pycache__),
     or in a node_modules between it and its routine's folder, asks a watched run and is refused unattended. Data flows. */
  {
    const scripts = path.join(own, 'scripts');
    const reason = 'code beside routine "Daily" script, which runs with nobody watching';
    let folders = [{ dir: scripts, reason }, { dir: path.join(own, 'node_modules'), reason }];
    const gp = makePathTrust({ fsp: fs.promises, pathMod: path, workspaceRoot: workspaces, roots: () => [project],
      bless: async () => true, now: () => 1, guardedFolders: () => folders });
    const gg = (p, o) => gp.guard(p, Object.assign({ agentId: 'nova', surface: 'interactive', scope: 'write' }, o));
    const no = async (p, o) => { try { await gg(p, o); return ''; } catch (e) { return String(e.message || e); } };
    fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
    const code = [path.join(scripts, 'helper.js'), path.join(scripts, 'json.py'), path.join(scripts, 'lib', 'deep.mjs'), path.join(scripts, 'Helper.JS.'),
      path.join(scripts, 'node_modules', 'left-pad', 'lib', 'data.bin'), path.join(scripts, '__pycache__', 'helper.cpython-312.pyc'),
      path.join(own, 'node_modules', 'pkg', 'index.js'), path.join(scripts, 'lib.ps1')];
    for (const f of code) {
      const name = path.relative(base, f);
      asked.length = 0;
      const ok = await gg(f, { tainted: true, prompt: say('always') });
      A.ok(ok && asked.length === 1 && /routine "Daily"/.test(String(asked[0].standing || '')), '#7 ' + name + ': a tainted write asks a watched run, naming the routine');
      A.ok(/read outside content/.test(await no(f, { tainted: true, surface: 'autonomous' })), '#7 ' + name + ': an unattended tainted write is refused');
      asked.length = 0;
      A.ok(!!(await gg(f, { tainted: false, prompt: say('deny') })) && asked.length === 0, '#7 ' + name + ': an untainted write is unchanged');
    }
    asked.length = 0;
    for (const f of [path.join(scripts, 'report.md'), path.join(scripts, 'out.csv'), path.join(scripts, 'lib', 'notes.txt'), path.join(own, 'other', 'helper.js'), path.join(own, 'node_modules.txt')]) {
      A.ok(!!(await gg(f, { tainted: true, prompt: say('deny') })), '#7 ' + path.relative(base, f) + ': data beside the script, and code elsewhere, still flow');
    }
    A.eq(asked.length, 0, '#7: and nothing asked');
    folders = null;
    A.ok(!!(await gg(path.join(scripts, 'report.md'), { tainted: true, prompt: say('deny') })), '#7: no list guards nothing more');
    const IDXs = require('./helpers/source.js').readSidecarIndex();
    A.ok(/guardedFolders: \(\) => routineScriptFolders\(\)/.test(IDXs), '#7: the station hands pathtrust its granted scripts\' folders');
    const rsf = A.fnBody(IDXs, 'function routineScriptFolders(');
    A.ok(/unattendedGrants\.length/.test(rsf) && /path\.dirname\(abs\)/.test(rsf) && /'node_modules'/.test(rsf), '#7: the folder of each granted script, and the node_modules up to its routine\'s folder');
    A.ok(/asks before it writes code beside it/.test(IDXs) && !/only this file is checked/.test(IDXs), '#7: the desk words say what is checked');
  }

  fs.rmSync(base, { recursive: true, force: true });
  A.report('taint-standing-files.test');
})().catch(e => { console.error(e); process.exit(1); });
