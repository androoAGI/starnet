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
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  const detect = A.fnBody(IDX, 'function detectCheckCommand(');
  const keyed = [...detect.matchAll(/has\('([^']+)'\)/g)].map(m => m[1].toLowerCase());
  A.ok(keyed.length >= 8, 'detectCheckCommand keys on files: ' + keyed.join(', '));
  for (const k of keyed) A.ok(_internals.STANDING_AUTORUN.indexOf(k) >= 0, 'the loop\'s derived check keys on ' + k + ': it is an auto-run file here');

  fs.rmSync(base, { recursive: true, force: true });
  A.report('taint-standing-files.test');
})().catch(e => { console.error(e); process.exit(1); });
