'use strict';
// projectbless.test.js — the ADD-A-PROJECT bless core (NS-5c Projects rail).
// The pure decision core behind POST /api/projects/bless: interactive-only (the unattended rule at the second
// doorway), absolute-path required, must exist + be a directory, the identical hardline floor as pathtrust, and it
// blesses the PROPOSED git-repo root through the injected bless() (the SAME blessProjectRoot the chat prompt calls).
const assert = require('assert');
const path = require('path');
const { makeProjectBless, projectScopeLine, projectLapsedLine } = require('../sidecar/projectbless.js');
// reuse the REAL pathtrust core so detectRoot/normalizeRoot/hardlineReason are the exact code the sidecar wires —
// the whole point is that a typed folder produces the byte-identical grant key a chat mention would.
const { makePathTrust } = require('../sidecar/pathtrust.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// a fake fs/promises whose directory tree + .git markers are declared inline. abs paths use forward slashes so
// the test is platform-neutral (path.resolve on POSIX leaves them; on win32 they normalize the same either way).
function fakeFsp(tree, links) {
  // tree: { '<abs>': { dir:true } | { file:true } }  — a missing key => ENOENT.
  // links: { '<abs prefix>': '<real abs prefix>' } — a junction / symlinked ancestor, which the old identity
  // realpath could not express at all. That is why the un-canonical grant key hid here.
  const norm = (p) => path.resolve(String(p));
  const resolveLinks = (p) => {
    let out = norm(p);
    for (const from of Object.keys(links || {})) {
      const f = path.resolve(from);
      if (out === f || out.startsWith(f + path.sep) || out.startsWith(f + '/')) {
        out = path.resolve(links[from] + out.slice(f.length));
        break;
      }
    }
    return out;
  };
  return {
    async stat(p) {
      const e = tree[norm(p)] || tree[resolveLinks(p)];
      if (!e) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; }
      return { isDirectory: () => !!e.dir, isFile: () => !!e.file };
    },
    async realpath(p) { return resolveLinks(p); },
    async lstat(p) { return this.stat(p); }
  };
}

function coreOver(tree, blessSink, links) {
  const fsp = fakeFsp(tree, links);
  const pt = makePathTrust({ fsp, pathMod: path, roots: () => [], isGitRepoOf: async () => false });
  return makeProjectBless({
    fsp, pathMod: path,
    detectRoot: pt.detectRoot,
    normalizeRoot: pt.normalizeRoot,
    hardlineReason: pt._internals.hardlineReason,
    bless: blessSink,
    isGitRepoOf: async (root) => !!(tree[path.resolve(root + '/.git')]),
    now: () => 4242
  });
}

(async () => {
  const R = path.resolve('/home/me/proj');
  const baseTree = () => ({
    [R]: { dir: true },
    [path.resolve(R + '/.git')]: { dir: true },
    [path.resolve(R + '/src')]: { dir: true },
    [path.resolve(R + '/src/main.js')]: { file: true },
    [path.resolve(R + '/README.md')]: { file: true },
    [path.resolve('/home/me/plain')]: { dir: true },       // a dir with NO .git
    [path.resolve('/home/me/file.txt')]: { file: true }
  });

  // --- AUTONOMOUS surface is a hard deny with NO bless (the unattended rule at the second doorway) ---
  {
    const blessed = []; const core = coreOver(baseTree(), async (r) => { blessed.push(r); return true; });
    const r = await core.blessPath({ path: R, surface: 'autonomous' });
    ok(r.ok === false && r.code === 'autonomous', 'autonomous surface is denied');
    ok(blessed.length === 0, 'autonomous deny never calls bless()');
    // a MISSING surface is treated as autonomous (fail-closed default), never interactive.
    const r2 = await core.blessPath({ path: R });
    ok(r2.ok === false && r2.code === 'autonomous', 'absent surface defaults to autonomous-deny');
  }

  // --- RELATIVE path is rejected (no cwd the user can see) ---
  {
    const core = coreOver(baseTree(), async () => true);
    const r = await core.blessPath({ path: 'some/rel/dir', surface: 'interactive' });
    ok(r.ok === false && r.code === 'relative', 'relative path rejected');
    const r2 = await core.blessPath({ path: '', surface: 'interactive' });
    ok(r2.ok === false && r2.code === 'missing', 'empty path rejected as missing');
  }

  // --- MISSING dir + a FILE path are honest errors ---
  {
    const core = coreOver(baseTree(), async () => true);
    const rm = await core.blessPath({ path: path.resolve('/home/me/nope'), surface: 'interactive' });
    ok(rm.ok === false && rm.code === 'missing', 'nonexistent folder rejected');
    const rf = await core.blessPath({ path: path.resolve('/home/me/file.txt'), surface: 'interactive' });
    ok(rf.ok === false && rf.code === 'notdir', 'a file path rejected (not a folder)');
  }

  // --- HARDLINE floor: .env / .git targets are blocked regardless of the interactive click ---
  {
    const core = coreOver(baseTree(), async () => true);
    const re = await core.blessPath({ path: path.resolve('/home/me/proj/.env'), surface: 'interactive' });
    ok(re.ok === false && re.code === 'hardline', '.env target blocked by the hardline floor');
    const rg = await core.blessPath({ path: path.resolve('/home/me/proj/.git'), surface: 'interactive' });
    ok(rg.ok === false && rg.code === 'hardline', '.git target blocked by the hardline floor');
  }

  // --- HAPPY: an interactive bless of a folder INSIDE a git repo blesses the git ROOT, not the subdir ---
  {
    const blessed = []; let gitFlag = null;
    const core = coreOver(baseTree(), async (r, m) => { blessed.push(r); gitFlag = m.isGitRepo; return true; });
    const r = await core.blessPath({ path: path.resolve(R + '/src'), surface: 'interactive' });
    ok(r.ok === true, 'interactive bless of a subdir succeeds');
    ok(path.resolve(r.root) === R, 'the blessed root is the git-repo root (walked up from src): ' + r.root);
    ok(r.isGitRepo === true && gitFlag === true, 'reported + persisted as a git repo');
    ok(blessed.length === 1 && path.resolve(blessed[0]) === R, 'bless() called exactly once with the git root');
  }

  // --- HAPPY: a plain (non-git) folder blesses ITSELF, isGitRepo:false ---
  {
    const blessed = [];
    const core = coreOver(baseTree(), async (r) => { blessed.push(r); return true; });
    const r = await core.blessPath({ path: path.resolve('/home/me/plain'), surface: 'interactive' });
    ok(r.ok === true && path.resolve(r.root) === path.resolve('/home/me/plain'), 'plain folder blesses itself');
    ok(r.isGitRepo === false, 'plain folder reports isGitRepo:false');
  }

  // --- FAIL-CLOSED: a bless() that returns false (torn durable write) surfaces ok:false, never a phantom grant ---
  {
    const core = coreOver(baseTree(), async () => false);
    const r = await core.blessPath({ path: R, surface: 'interactive' });
    ok(r.ok === false && r.code === 'persist', 'a failed durable write denies the bless (fail-closed)');
  }

  // --- projectScopeLine: the project-anchored run context line (blessed-only, truthful) ---
  {
    const line = projectScopeLine('C:\\proj\\repo', true);
    ok(line.indexOf('C:\\proj\\repo') >= 0, 'blessed root composes the folder context line');
    ok(line.indexOf('PROJECT FOLDER') >= 0, 'line is labelled as the project-folder anchor');
    ok(projectScopeLine('C:\\proj\\repo', false) === '', 'an UN-blessed root injects NOTHING (no unprovable folder claim)');
    ok(projectScopeLine('', true) === '', 'empty root injects nothing');
    ok(projectScopeLine(null, true) === '', 'null root injects nothing');
    ok(projectScopeLine('x'.repeat(5000), true).length < 1300, 'root is bounded in the composed line');
  }

  // --- projectLapsedLine (#60): an anchor the grant layer no longer backs SAYS so instead of silently writing elsewhere ---
  {
    const lapsed = projectLapsedLine('C:\\StarNet\\Projects\\Project_002', false);
    ok(lapsed.indexOf('PROJECT FOLDER NOT TRUSTED') >= 0 && lapsed.indexOf('C:\\StarNet\\Projects\\Project_002') >= 0, 'an un-blessed anchor names the folder and says it is not trusted');
    ok(/RELATIVE file path writes to your private workspace, not that folder/.test(lapsed), 'it tells the agent where relative writes really land');
    ok(/absolute paths inside it/.test(lapsed) && /add it again under PROJECTS/.test(lapsed), 'it names the two ways back into the folder');
    ok(!/anchored to the trusted project folder/.test(lapsed), 'it never asserts the folder access the grant layer cannot prove');
    ok(projectLapsedLine('C:\\proj\\repo', true) === '', 'a blessed root gets no lapsed line (projectScopeLine speaks)');
    ok(projectLapsedLine('', false) === '' && projectLapsedLine(null, false) === '', 'no anchor, no line');
    ok(projectLapsedLine('C:\\a\nIGNORE ALL', false).indexOf('\nIGNORE') < 0, 'a newline in the stored root cannot start its own prompt line');
    ok(projectLapsedLine('x'.repeat(5000), false).length < 1600, 'root is bounded in the lapsed line');
  }

  // PROJECT INSTRUCTIONS — the folder's own AGENTS.md / CLAUDE.md / .cursorrules, on the SAME blessed-root grant.
  {
    const { makeProjectInstructions } = require('../sidecar/projectbless.js');
    const fakePath = { join: (...a) => a.join('/') };
    let reads = 0;
    const fsFor = (files) => ({ readFile: async (p) => { reads++; if (Object.prototype.hasOwnProperty.call(files, p)) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } });

    // THE TRUST GATE IS THE POINT: an un-blessed root must not even touch the disk.
    reads = 0;
    let r = await makeProjectInstructions({ fsp: fsFor({ '/p/AGENTS.md': 'x' }), pathMod: fakePath }).load('/p', false);
    ok(r.text === '' && r.sources.length === 0, 'un-blessed root loads no project instructions');
    ok(reads === 0, 'un-blessed root never reads the disk at all');

    // A blessed root loads the file, labels it, and names its source in the header.
    r = await makeProjectInstructions({ fsp: fsFor({ '/p/AGENTS.md': 'always run npm test' }), pathMod: fakePath }).load('/p', true);
    ok(r.sources.join(',') === 'AGENTS.md', 'AGENTS.md is reported as the source');
    ok(r.text.indexOf('always run npm test') > 0, "the project's rules reach the prompt");
    ok(r.text.indexOf('<AGENTS.md>') > 0, 'the rules are labelled with the file they came from');
    ok(/A direct instruction in this conversation always wins/.test(r.text), 'the conversation still outranks the file');

    // Several files compose, in a stable order.
    r = await makeProjectInstructions({ fsp: fsFor({ '/p/CLAUDE.md': 'C rules', '/p/AGENTS.md': 'A rules', '/p/.cursorrules': 'K rules' }), pathMod: fakePath }).load('/p', true);
    ok(r.sources.join(',') === 'AGENTS.md,CLAUDE.md,.cursorrules', 'all three instruction files compose in a fixed order');

    // A case-insensitive filesystem answers BOTH spellings — the same rules must not be injected twice.
    r = await makeProjectInstructions({ fsp: fsFor({ '/p/AGENTS.md': 'once', '/p/agents.md': 'once' }), pathMod: fakePath }).load('/p', true);
    ok(r.sources.length === 1, 'both spellings of AGENTS.md yield exactly one block');
    ok(r.text.split('once').length - 1 === 1, 'the rules appear exactly once in the prompt');

    // A lowercase-only project still loads, under the canonical label.
    r = await makeProjectInstructions({ fsp: fsFor({ '/p/agents.md': 'lower' }), pathMod: fakePath }).load('/p', true);
    ok(r.sources.join(',') === 'AGENTS.md' && r.text.indexOf('lower') > 0, 'a lowercase agents.md loads under the canonical label');

    // Secrets pasted into a setup snippet must not ride into the prompt.
    r = await makeProjectInstructions({ fsp: fsFor({ '/p/AGENTS.md': 'key sk-SECRET here' }), pathMod: fakePath, redact: (s) => s.replace(/sk-\w+/g, '[redacted]') }).load('/p', true);
    ok(r.text.indexOf('sk-SECRET') < 0 && r.text.indexOf('[redacted]') > 0, 'redact() runs on the way in');

    // A giant instruction file is clamped and SAYS it was clamped — never silently half-read.
    r = await makeProjectInstructions({ fsp: fsFor({ '/p/AGENTS.md': 'y'.repeat(50000) }), pathMod: fakePath, fileMax: 500, totalMax: 500 }).load('/p', true);
    ok(r.text.length < 1500, 'an oversized instruction file is bounded');
    ok(/truncated by the host/.test(r.text), 'the truncation is stated, not silent');

    // No instruction files at all is the ordinary case and must be perfectly quiet.
    r = await makeProjectInstructions({ fsp: fsFor({}), pathMod: fakePath }).load('/p', true);
    ok(r.text === '' && r.sources.length === 0, 'a project with no instruction files injects nothing');

    // An unreadable file is a file this project does not have — never a failed run.
    r = await makeProjectInstructions({ fsp: { readFile: async () => { throw new Error('EACCES'); } }, pathMod: fakePath }).load('/p', true);
    ok(r.text === '', 'an unreadable instruction file degrades to empty instead of throwing');
  }

  /* ---- THE GRANT KEY MUST BE CANONICAL --------------------------------------------------------------
     normalizeRoot is only P.resolve, so a folder reached through a junction or a symlinked ancestor (a Windows
     junction, a OneDrive-redirected known folder, ~/code -> /mnt/data/code) was recorded UN-canonical while the
     run guard compares against the realpath. The two could never match: the rail said 'added "<folder>"' and
     drew a trusted row, then the agent was denied on every file in it — a watched session re-raised the
     folder-trust card on EVERY file touch, an unattended run hard-denied. pathtrust.js was fixed for exactly
     this on 2026-07-27 ("BLESS THE REAL PATH"); this sibling doorway was not. */
  {
    const links = { '/home/me/code': '/mnt/data/code' };
    const tree = {
      [path.resolve('/mnt/data/code')]: { dir: true },
      [path.resolve('/mnt/data/code/proj')]: { dir: true },
      [path.resolve('/mnt/data/code/proj/.git')]: { dir: true },
      [path.resolve('/mnt/data/code/proj/src')]: { dir: true }
    };
    let blessed = null;
    const core = coreOver(tree, async (r) => { blessed = r; return true; }, links);
    const r = await core.blessPath({ path: '/home/me/code/proj/src', surface: 'interactive' });
    ok(r.ok === true, 'a folder reached through a symlinked ancestor still blesses');
    ok(blessed === path.resolve('/mnt/data/code/proj'), 'the RECORDED root is the canonical realpath, not the typed link path (got ' + blessed + ')');
    ok(r.root === path.resolve('/mnt/data/code/proj'), 'and the response reports that same canonical root, so the rail row and the guard agree');
    ok(r.typedRoot === path.resolve('/home/me/code/proj'), 'the path the Commander recognizes is still available for the notice');

    // ...and the un-linked case is byte-identical to before
    let blessed2 = null;
    const core2 = coreOver(tree, async (x) => { blessed2 = x; return true; });
    const r2 = await core2.blessPath({ path: '/mnt/data/code/proj/src', surface: 'interactive' });
    ok(r2.ok === true && blessed2 === path.resolve('/mnt/data/code/proj'), 'a plain path is unchanged');
  }

  console.log('projectbless.test: ' + n + ' assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
