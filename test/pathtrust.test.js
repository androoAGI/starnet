/* node test/pathtrust.test.js — CONVERSATIONAL PATH TRUST (NS-5 Project Lens core).
   Security-critical: proven against a REAL temp filesystem so blessed-root containment, symlink escape,
   the protected-file floor, and — above all — the UNATTENDED RULE (an autonomous run can NEVER bless a
   new root) are exercised on the actual path/realpath semantics of the host. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makePathTrust } = require('../sidecar/pathtrust.js');

const ROOT = path.join(os.tmpdir(), 'starnet-pathtrust-' + process.pid);

async function rejects(promise, msg) { try { await promise; A.ok(false, msg + ' — did NOT reject'); } catch (e) { A.ok(true, msg); } }

// a fake blessed-roots + bless + touch harness backed by a plain Set (the sidecar derives roots from the
// `path:*` grants; here the Set stands in for that live derivation, so removing a member models a revoke).
function harness(opts) {
  opts = opts || {};
  const roots = new Set(opts.roots || []);
  const touched = [];
  let blessOk = opts.blessOk !== false;
  const blessed = [];
  const pt = makePathTrust({
    fsp, pathMod: path,
    roots: () => Array.from(roots),
    bless: async (rootReal, meta) => { if (!blessOk) return false; roots.add(rootReal); blessed.push({ rootReal, meta }); return true; },
    touch: (rootReal, abs, meta) => touched.push({ rootReal, abs, meta }),
    isGitRepoOf: async (r) => { try { await fsp.stat(path.join(r, '.git')); return true; } catch (_) { return false; } },
    now: () => 1700000000000
  });
  return { pt, roots, touched, blessed, setBlessOk(v) { blessOk = v; } };
}

// a prompt that records its calls and returns a scripted decision (or throws if it should NEVER be asked).
function scriptPrompt(decision) {
  const calls = [];
  const fn = async (proposedRoot, info) => { calls.push({ proposedRoot, info }); return decision; };
  fn.calls = calls;
  return fn;
}

(async () => {
  await fsp.mkdir(ROOT, { recursive: true });
  const proj = path.join(ROOT, 'project');
  await fsp.mkdir(path.join(proj, 'src'), { recursive: true });
  await fsp.writeFile(path.join(proj, 'src', 'main.js'), 'console.log(1)\n');
  await fsp.writeFile(path.join(proj, 'README.md'), '# hi\n');
  await fsp.mkdir(path.join(proj, '.git'), { recursive: true });          // makes `proj` a git-repo root
  await fsp.writeFile(path.join(proj, '.env'), 'SECRET=1\n');

  const fileAbs = path.join(proj, 'src', 'main.js');
  // A final symlink whose target does not exist must fail closed before a
  // blessed project can turn it into a protected workspace file.
  {
    const target = path.join(ROOT, 'forged-hooks-allowed.json');
    const link = path.join(proj, 'dangling-approval.json');
    let linked = false;
    try { await fsp.symlink(target, link, 'file'); linked = true; }
    catch (e) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) throw e; }
    if (linked) {
      const h = harness({ roots: [proj] });
      await rejects(h.pt.guard(link, { scope: 'write', surface: 'autonomous' }), 'pathtrust refuses a dangling final symlink');
      A.ok(!fs.existsSync(target), 'pathtrust created no outside target');
      await fsp.unlink(link);
    }
  }

  // ---- PRIVATE WORKSPACE FLOOR: station-global grants and Full Access cannot cross agent jails ----
  {
    const workspaces = path.join(ROOT, 'workspaces');
    const alpha = path.join(workspaces, 'alpha');
    const beta = path.join(workspaces, 'beta');
    const alphaPrivate = path.join(alpha, 'private.txt');
    await fsp.mkdir(alpha, { recursive: true });
    await fsp.mkdir(beta, { recursive: true });
    await fsp.writeFile(alphaPrivate, 'alpha only\n');
    const pt = makePathTrust({ fsp, pathMod: path, workspaceRoot: workspaces, roots: () => [alpha] });
    await rejects(pt.guard(alphaPrivate, { scope: 'read', surface: 'interactive', agentId: 'beta', fullAccess: true }),
      'beta cannot read alpha even when alpha has a station-global grant and Full Access is live');
    const own = await pt.guard(alphaPrivate, { scope: 'read', surface: 'autonomous', agentId: 'alpha' });
    A.ok(path.resolve(own.base).toLowerCase() === path.resolve(alpha).toLowerCase(),
      'alpha may still use an absolute path inside its own workspace');
    await rejects(pt.guard(alphaPrivate, { scope: 'read', surface: 'interactive', agentId: '../alpha' }),
      'an invalid agent id cannot manufacture ownership of a private workspace');
  }

  // ---- 1. UNATTENDED RULE: autonomous run (no prompt) referencing an un-blessed outside path = HARD DENY ----
  {
    const h = harness();
    const p = scriptPrompt('always');   // if this is ever called, the rule is broken
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'autonomous', prompt: p }),
      'autonomous run with no standing grant is DENIED for an outside path');
    A.eq(p.calls.length, 0, 'autonomous deny NEVER invokes the prompt (silence is not consent)');
    A.eq(h.roots.size, 0, 'autonomous run did not bless anything');
  }

  // ---- 2. interactive but NO prompt wired = fail-closed hard deny ----
  {
    const h = harness();
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: null }),
      'interactive run with no prompt channel fails closed');
  }

  // ---- 3. interactive + "always" → blesses the git-repo ROOT, records the grant, subsequent reads flow ----
  {
    const h = harness();
    const p = scriptPrompt('always');
    const r = await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p });
    A.eq(p.calls.length, 1, 'exactly ONE consent prompt for the first outside reference');
    A.ok(h.blessed.length === 1, 'bless was called once');
    // the PROPOSED root is the git repo root (walked up from src/), not the file's own dir
    A.ok(path.resolve(p.calls[0].proposedRoot).toLowerCase() === path.resolve(proj).toLowerCase(),
      'proposed root is the git-repo root, not the immediate directory');
    A.ok(h.blessed[0].meta.isGitRepo === true, 'bless carried isGitRepo:true for a .git-bearing root');
    A.ok(path.resolve(r.abs).toLowerCase() === path.resolve(fileAbs).toLowerCase(), 'guard returns the resolved absolute path');
    // a SUBSEQUENT reference under the now-blessed root flows with NO prompt
    const p2 = scriptPrompt('deny');   // must not be consulted
    const r2 = await h.pt.guard(path.join(proj, 'README.md'), { scope: 'read', surface: 'interactive', prompt: p2 });
    A.eq(p2.calls.length, 0, 'a second file under the blessed root does NOT re-prompt');
    A.ok(r2 && r2.base, 'second read resolved under the blessed root');
    A.ok(h.touched.length >= 2, 'each I/O under the blessed root bumps lastTouchedAt (touch called)');
    // and the SAME blessed root now serves an AUTONOMOUS run (the standing grant, not the surface, is what matters)
    const r3 = await h.pt.guard(fileAbs, { scope: 'read', surface: 'autonomous', prompt: null });
    A.ok(r3 && r3.base, 'once blessed, an autonomous run reads under the root with no prompt');
    // RECENCY IS THE USER'S (2026-10-05 audit item 4): the touch names WHO caused the I/O so the host bumps
    // lastTouchedAt only for user runs — the agent's own away work must not keep its folder tonight's focus.
    A.ok(h.touched.slice(0, -1).every(t => t.meta && t.meta.user === true), 'interactive I/O is reported as a USER touch');
    A.eq(h.touched[h.touched.length - 1].meta, { user: false }, 'autonomous I/O is reported as an AGENT touch');
    await h.pt.guard(fileAbs, { scope: 'read', surface: 'autonomous', prompt: null, userTouch: true });
    A.eq(h.touched[h.touched.length - 1].meta, { user: true }, 'a host-minted userTouch (owner-trusted DM) overrides the surface default');
    await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p2, userTouch: false });
    A.eq(h.touched[h.touched.length - 1].meta, { user: false }, 'an explicit userTouch:false is honored too');
  }
  // the host contract: index.js bumps projects recency ONLY on a user touch, and runPathTrust mints the flag from
  // the run's own surface / owner-trust bit (never from model state).
  {
    const src = readSidecarSource();
    A.ok(/touch: \(rootReal, abs, meta\) => \{ if \(!meta \|\| meta\.user !== true\) return;/.test(src), 'host touch ignores agent (non-user) touches');
    A.ok(/userTouch: surface === 'interactive' \|\| ownerTrusted,/.test(src), 'runPathTrust derives userTouch from surface/ownerTrusted');
  }

  // ---- Full Access: every non-hardline path flows without a card on watched and unattended surfaces ----
  {
    const h = harness();
    const never = scriptPrompt('deny');
    const watched = await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: never, fullAccess: true });
    A.ok(watched && watched.fullAccess === true, 'Full Access allows a new external project path');
    A.eq(never.calls.length, 0, 'Full Access never raises a path-trust card');
    const unattended = await h.pt.guard(fileAbs, { scope: 'read', surface: 'autonomous', prompt: null, fullAccess: true });
    A.ok(unattended && unattended.fullAccess === true, 'Full Access applies to unattended path access too');
    A.eq(h.roots.size, 0, 'live Full Access is not silently converted into a permanent path grant');
    await rejects(h.pt.guard(path.join(proj, '.env'), { scope: 'read', surface: 'autonomous', fullAccess: true }),
      'the protected-file floor still denies under Full Access');
  }

  // ---- 2026-10-10 THE CREDENTIAL FLOOR: THIS COMPUTER (Full Access) lets unattended runs read any non-hardline
  //      path with no card, so well-known credential stores are hardline: SSH/cloud/signing keys, saved logins,
  //      the OS credential store, browser profiles. Only Full Power (unrestrictedHost) reaches them. ----
  {
    const home = path.join(ROOT, 'home');
    const stores = [['.ssh', 'id_ed25519'], ['.aws', 'credentials'], ['.tauri', 'starnet-updater.key'], ['.codex', 'auth.json'],
      [path.join('AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default'), 'Login Data'],
      // security-storage-03: the Windows homes of the gcloud and GitHub CLI logins, and cargo's registry token
      [path.join('AppData', 'Roaming', 'gcloud'), 'credentials.db'], [path.join('AppData', 'Roaming', 'GitHub CLI'), 'hosts.yml'],
      ['.cargo', 'credentials.toml'], ['.cargo', 'credentials'], [path.join('.config', 'gh'), 'hosts.yml']];
    for (const [dir, file] of stores) { await fsp.mkdir(path.join(home, dir), { recursive: true }); await fsp.writeFile(path.join(home, dir, file), 'secret'); }
    await fsp.writeFile(path.join(home, '.git-credentials'), 'https://u:p@h');
    await fsp.writeFile(path.join(home, 'notes.ssh.txt'), 'not a key');
    const h = harness({ roots: [home] });
    for (const [dir, file] of stores) {
      await rejects(h.pt.guard(path.join(home, dir, file), { scope: 'read', surface: 'autonomous', fullAccess: true }),
        'credential floor: ' + dir + ' is denied to an unattended Full Access run even under a blessed root');
    }
    await rejects(h.pt.guard(path.join(home, '.git-credentials'), { scope: 'read', surface: 'interactive', prompt: scriptPrompt('always'), fullAccess: true }),
      'credential floor: saved git credentials are denied to a watched run too');
    const ok = await h.pt.guard(path.join(home, 'notes.ssh.txt'), { scope: 'read', surface: 'autonomous', fullAccess: true });
    A.ok(ok && ok.abs, 'a file merely NAMED like a credential store still reads (segment match, not substring)');
    let msg = '';
    try { await h.pt.guard(path.join(home, '.ssh', 'id_ed25519'), { scope: 'read', surface: 'autonomous', fullAccess: true }); } catch (e) { msg = e.message; }
    A.ok(/credential floor/.test(msg) && /Full Power/.test(msg), 'the refusal names the floor and the one switch that reaches it — got: ' + msg);
    const power = await h.pt.guard(path.join(home, '.ssh', 'id_ed25519'), { scope: 'read', surface: 'autonomous', unrestrictedHost: true });
    A.ok(power && power.unrestrictedHost === true, 'Full Power (the operator\'s explicit host-wide switch) still reaches it');
    // a symlink named innocently that points INTO a credential store is caught on its real target. Non-admin
    // Windows cannot create file symlinks, so the injected-fs case below proves the same rule on every host.
    const link = path.join(home, 'innocent.txt');
    let linked = false;
    try { await fsp.symlink(path.join(home, '.ssh', 'id_ed25519'), link, 'file'); linked = true; }
    catch (e) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) throw e; }
    if (linked) await rejects(h.pt.guard(link, { scope: 'read', surface: 'autonomous', fullAccess: true }), 'credential floor is re-proven on the symlink\'s real target');
    else console.log('SKIP: credential-floor real-symlink case — this host cannot create file symlinks (the injected-fs case below still proves the rule)');
  }
  {
    const PM = Object.assign({}, require('node:path').posix, { sep: '/' });
    const LINK = '/home/innocent.txt', KEY = '/home/.ssh/id_ed25519';
    const fspFake = {
      async realpath(p) { return p === LINK ? KEY : p; },
      async lstat(p) { if (p === LINK || p === KEY || p === '/home') return {}; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      async stat(p) { if (p === '/home') return { isDirectory: () => true }; throw new Error('ENOENT'); }
    };
    const pt = makePathTrust({ fsp: fspFake, pathMod: PM, roots: () => ['/home'] });
    let msg = '';
    try { await pt.guard(LINK, { scope: 'read', surface: 'autonomous', fullAccess: true }); } catch (e) { msg = e.message; }
    A.ok(/credential floor/.test(msg), 'credential floor is re-proven on the realpath (injected fs, runs on every host) — got: ' + msg);
    const ok = await pt.guard('/home/notes.txt', { scope: 'read', surface: 'autonomous', fullAccess: true });
    A.eq(ok.base, '/home', 'an ordinary file under the same root still reads');
  }

  // ---- security-storage-08: the browser-profile rule matches the browsers' real profile folders, not any folder
  //      that happens to be NAMED chromium or vivaldi (a Chromium checkout is an ordinary project). ----
  {
    const home = path.join(ROOT, 'home-browsers');
    const profiles = [
      [path.join('AppData', 'Local', 'Chromium', 'User Data', 'Default'), 'Cookies'],
      [path.join('AppData', 'Local', 'Google', 'Chrome SxS', 'User Data', 'Default'), 'Login Data'],
      [path.join('AppData', 'Local', 'Microsoft', 'Edge Beta', 'User Data', 'Default'), 'Cookies'],
      [path.join('AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default'), 'Cookies'],
      [path.join('AppData', 'Local', 'Vivaldi', 'User Data', 'Default'), 'Login Data'],
      [path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable'), 'Cookies'],
      [path.join('AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'x.default'), 'logins.json'],
      // Microsoft Store (MSIX) Firefox: the package virtualizes AppData as Packages/<pkg>/LocalCache/{Local,Roaming}
      [path.join('AppData', 'Local', 'Packages', 'Mozilla.Firefox_n80bbvh6b1yt2', 'LocalCache', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'x.default'), 'logins.json'],
      [path.join('.config', 'opera'), 'Cookies'], [path.join('.config', 'opera-developer'), 'Login Data'],
      [path.join('.config', 'chromium', 'Default'), 'Cookies'], [path.join('.config', 'vivaldi', 'Default'), 'Cookies'],
      [path.join('.config', 'google-chrome-beta', 'Default'), 'Cookies'], [path.join('.mozilla', 'firefox', 'x.default'), 'logins.json'],
      [path.join('snap', 'chromium', 'common', 'chromium', 'Default'), 'Cookies'],
      [path.join('.var', 'app', 'com.google.Chrome', 'config', 'google-chrome', 'Default'), 'Cookies'],
      [path.join('Library', 'Application Support', 'Chromium', 'Default'), 'Cookies'],
      [path.join('Library', 'Application Support', 'Vivaldi', 'Default'), 'Cookies'],
      [path.join('Library', 'Application Support', 'Google', 'Chrome', 'Default'), 'Cookies']];
    const projects = [[path.join('chromium', 'src', 'base'), 'a.cc'], [path.join('code', 'vivaldi'), 'readme.md'],
      [path.join('code', 'google', 'chrome-extension'), 'manifest.json'],
      // a .config child that merely STARTS with "opera" is not Opera's profile
      [path.join('.config', 'operator'), 'notes.md'], [path.join('code', 'app', '.config', 'operations'), 'x.json']];
    for (const [dir, file] of profiles.concat(projects)) { await fsp.mkdir(path.join(home, dir), { recursive: true }); await fsp.writeFile(path.join(home, dir, file), 'x'); }
    const h = harness({ roots: [home] });
    for (const [dir, file] of profiles) {
      await rejects(h.pt.guard(path.join(home, dir, file), { scope: 'read', surface: 'autonomous', fullAccess: true }),
        'credential floor: browser profile ' + dir + ' is denied to an unattended Full Access run');
    }
    for (const [dir, file] of projects) {
      let err = '';
      try { await h.pt.guard(path.join(home, dir, file), { scope: 'read', surface: 'autonomous', fullAccess: true }); } catch (e) { err = e.message; }
      A.eq(err, '', 'a project folder named like a browser (' + dir + ') is not a browser profile');
    }
  }

  // ---- Full Power: the whole local computer, including protected paths, with no project card ----
  {
    const h = harness();
    const never = scriptPrompt('deny');
    const protectedFile = await h.pt.guard(path.join(proj, '.env'), {
      scope: 'write', surface: 'autonomous', prompt: never, unrestrictedHost: true
    });
    A.ok(protectedFile && protectedFile.unrestrictedHost === true, 'Full Power reaches protected host paths');
    A.eq(never.calls.length, 0, 'Full Power never asks for a project-root exception');
    A.ok(path.resolve(protectedFile.abs).toLowerCase() === path.resolve(path.join(proj, '.env')).toLowerCase(),
      'Full Power preserves the exact host target for the fs tool');
  }

  // ---- 4. "once" allows THIS access but does NOT persist a root (next reference re-prompts) ----
  {
    const h = harness();
    const p = scriptPrompt('once');
    const r = await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p });
    A.ok(r && r.abs, '"once" allows the single access');
    A.eq(h.roots.size, 0, '"once" did NOT record a standing root');
    A.eq(h.blessed.length, 0, '"once" did not call bless');
    const p2 = scriptPrompt('deny');
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p2 }),
      'after a "once", the very next reference is asked again (and here denied)');
    A.eq(p2.calls.length, 1, '"once" left no standing grant → the next reference DID re-prompt');
  }

  /* ---- 4a. "session" is a legal consent word, never a silent deny (sweep/safecell 2026-10-20) ----
     POST /api/consent accepts once|session|always|full, and two real surfaces send "session" to a folder card: ACP's
     "Allow for the rest of this session" and a paired phone's "for this session". The guard knew only always/full/once,
     so "session" fell through to `access … was denied` while the answering surface was told it was applied. It now
     approves the access AND remembers the root for the rest of THIS run (the caller's sessionRoots) — never standing. */
  {
    const h = harness();
    const sessionRoots = new Set();
    const p = scriptPrompt('session');
    const r = await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p, sessionRoots });
    A.ok(r && r.abs, '"session" allows the access (it is not a silent deny)');
    A.eq(h.blessed.length, 0, '"session" records no standing grant');
    A.eq(sessionRoots.size, 1, '"session" remembers the root for this run');
    const quiet = scriptPrompt('deny');
    const again = await h.pt.guard(path.join(proj, 'README.md'), { scope: 'read', surface: 'interactive', prompt: quiet, sessionRoots });
    A.ok(again && again.abs, 'a second file under the same root in the same run flows');
    A.eq(quiet.calls.length, 0, 'and is not asked again in that run');
    const nextRun = scriptPrompt('deny');
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: nextRun, sessionRoots: new Set() }),
      'a new run (a new session) is asked again');
    A.eq(nextRun.calls.length, 1, 'the session grant did not outlive its run');
    await rejects(h.pt.guard(path.join(proj, '.env'), { scope: 'read', surface: 'interactive', prompt: quiet, sessionRoots }),
      'a session root never reaches past the protected-file floor');
  }

  /* ---- 4b. "full" is AT LEAST as strong as "always": it records the standing root and never re-prompts ----
     Regression for the live-caught 2026-07-27 loop: "full" fell through to the "once" branch, so a Commander
     clicking the card's STRONGEST button ("Full access") bought nothing and was asked again on the very next
     file touch in the same folder. Five reads = five identical cards. The grades must never invert. */
  {
    const h = harness();
    const p = scriptPrompt('full');
    const r = await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p });
    A.ok(r && r.abs, '"full" allows the access');
    A.eq(p.calls.length, 1, 'exactly ONE prompt for the first outside reference');
    A.eq(h.blessed.length, 1, '"full" RECORDED a standing root grant (it is not a one-time allow)');
    A.ok(h.blessed[0] && path.resolve(h.blessed[0].rootReal).toLowerCase() === path.resolve(proj).toLowerCase(),
      '"full" blessed the same git-repo root "always" would have');
    // every subsequent file in that folder must flow silently — this is the loop the user actually hit
    const p2 = scriptPrompt('deny');   // must not be consulted
    for (const f of ['README.md', 'src/main.js']) {
      const r2 = await h.pt.guard(path.join(proj, f), { scope: 'read', surface: 'interactive', prompt: p2 });
      A.ok(r2 && r2.base, 'subsequent read under the "full"-blessed root resolved');
    }
    A.eq(p2.calls.length, 0, 'after "full", NO further card is raised for that folder');
    // and the grant is a real, revocable standing root — same shape "always" produces
    A.eq(h.roots.size, 1, '"full" left exactly one revocable standing root behind');
  }

  // ---- 4c. a failed persist under "full" DENIES (fail-closed, exactly as "always" does) ----
  {
    const h = harness();
    h.setBlessOk(false);
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: scriptPrompt('full') }),
      '"full" that could not persist its grant is DENIED, never silently allowed');
    A.eq(h.roots.size, 0, 'a failed "full" bless recorded nothing');
  }

  // ---- 5. "no" (deny) throws and blesses nothing ----
  {
    const h = harness();
    const p = scriptPrompt('deny');
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p }), 'a denied prompt throws');
    A.eq(h.roots.size, 0, 'a denied prompt blesses nothing');
  }

  // ---- 6. REVOKE takes effect on the next run: dropping the root from the live set re-prompts/denies ----
  {
    const h = harness({ roots: [path.resolve(proj)] });
    // blessed → reads flow, no prompt
    const okp = scriptPrompt('deny');
    await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: okp });
    A.eq(okp.calls.length, 0, 'pre-revoke: blessed root reads with no prompt');
    // simulate the /api/permissions/revoke removing the standing grant
    h.roots.delete(path.resolve(proj));
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'autonomous', prompt: null }),
      'post-revoke: an autonomous run is denied again (grant is the authority, not history)');
  }

  // ---- 7. HARDLINES: .env / .git internals / NUL / UNC are denied EVEN under a blessed root ----
  {
    const h = harness({ roots: [path.resolve(proj)] });
    await rejects(h.pt.guard(path.join(proj, '.env'), { scope: 'read', surface: 'autonomous', prompt: null }),
      '.env is denied even inside a blessed root');
    await rejects(h.pt.guard(path.join(proj, '.git', 'config'), { scope: 'read', surface: 'autonomous', prompt: null }),
      '.git internals are denied even inside a blessed root');
    await rejects(h.pt.guard(path.join(proj, 'src', 'ma\0in.js'), { scope: 'read', surface: 'autonomous', prompt: null }),
      'a NUL byte in the path is illegal');
    await rejects(h.pt.guard('\\\\server\\share\\x', { scope: 'read', surface: 'interactive', prompt: scriptPrompt('always') }),
      'a UNC / network path is never blessable');
  }

  // ---- 8. SYMLINK ESCAPE: a link under a blessed root pointing OUT is denied (real target re-proven) ----
  {
    const outside = path.join(ROOT, 'outside-secret');
    try {
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'loot.txt'), 'nope');
      await fsp.symlink(outside, path.join(proj, 'escape'), 'dir');
      const h = harness({ roots: [path.resolve(proj)] });
      await rejects(h.pt.guard(path.join(proj, 'escape', 'loot.txt'), { scope: 'read', surface: 'autonomous', prompt: null }),
        'a symlink under a blessed root that escapes it is denied (realpath re-proof)');
    } catch (e) {
      A.ok(true, 'symlink escape regression skipped — this filesystem disallows symlinks');
    }
  }

  // ---- 9. non-git folder: proposed root falls back to the file's own directory ----
  {
    const loose = path.join(ROOT, 'loose');
    await fsp.mkdir(loose, { recursive: true });
    await fsp.writeFile(path.join(loose, 'note.txt'), 'x');
    const h = harness();
    const p = scriptPrompt('always');
    await h.pt.guard(path.join(loose, 'note.txt'), { scope: 'read', surface: 'interactive', prompt: p });
    A.ok(path.resolve(p.calls[0].proposedRoot).toLowerCase() === path.resolve(loose).toLowerCase(),
      'no .git anywhere up → proposed root is the file\'s own directory');
    A.ok(h.blessed[0].meta.isGitRepo === false, 'a non-git root is stamped isGitRepo:false');
  }

  // ---- 10. bless persistence failure = deny (fail-closed) ----
  {
    const h = harness({ blessOk: false });
    const p = scriptPrompt('always');
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p }),
      'if the standing grant cannot be persisted, the access is DENIED (fail-closed)');
    A.eq(h.roots.size, 0, 'a failed bless leaves no root');
  }

  /* ---- the protected-file floor is re-proven on the REAL target ----
     It only ever saw the raw/resolved STRINGS, so a symlink named innocently inside an ALREADY-blessed root
     (notes.txt -> /proj/.env) walked straight through it. Containment was re-proven on the realpath; the
     floor was not. Injected fs so the case runs on a host that cannot create symlinks. ---- */
  {
    const PP = require('node:path').posix;
    const PM = Object.assign({}, PP, { sep: '/' });
    const LINK = '/proj/notes.txt', ENV = '/proj/.env';
    const fspFake = {
      async realpath(p) { return p === LINK ? ENV : p; },
      async lstat(p) { if (p === LINK || p === ENV || p === '/proj') return {}; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      async stat(p) { if (p === '/proj') return { isDirectory: () => true }; throw new Error('ENOENT'); }
    };
    const pt = makePathTrust({ fsp: fspFake, pathMod: PM, roots: () => ['/proj'] });
    let blocked = false;
    try { await pt.guard(ENV, { scope: 'read', surface: 'interactive' }); } catch (e) { blocked = /protected-file floor/.test(e.message); }
    A.ok(blocked, 'the direct .env path is blocked (unchanged)');
    blocked = false;
    try { await pt.guard(LINK, { scope: 'read', surface: 'interactive' }); } catch (e) { blocked = /protected-file floor/.test(e.message); }
    A.ok(blocked, 'a symlink inside a blessed root that RESOLVES to .env is blocked too');
    // an ordinary file under the same blessed root still flows
    const ok = await pt.guard('/proj/src/a.js', { scope: 'read', surface: 'interactive' });
    A.eq(ok.base, '/proj', 'an ordinary in-root read is unaffected');
  }

  /* ---- "always" must actually stick when the root is reached through a symlinked ancestor ----
     The grant was stored as P.resolve(...) while lookup compares the realpath, so ~/code -> /mnt/data/code
     never matched again and the Commander was re-prompted on every call — consent fatigue on the one prompt
     that widens filesystem reach. ---- */
  {
    const PP = require('node:path').posix;
    const PM = Object.assign({}, PP, { sep: '/' });
    const SYM = '/home/me/code', REALROOT = '/mnt/data/code';
    const blessed = [];
    const fspFake = {
      async realpath(p) { return p.indexOf(SYM) === 0 ? REALROOT + p.slice(SYM.length) : p; },
      async lstat() { return {}; },
      async stat(p) { if (p === SYM || p === REALROOT) return { isDirectory: () => true }; throw new Error('ENOENT'); }
    };
    const pt = makePathTrust({ fsp: fspFake, pathMod: PM, roots: () => blessed.slice(),
      bless: async (r) => { blessed.push(r); return true; } });
    await pt.guard(SYM + '/src/a.js', { scope: 'read', surface: 'interactive', prompt: async () => 'always' });
    A.ok(blessed[0].indexOf(REALROOT) === 0, 'the grant is recorded under the CANONICAL (realpath) root');
    let asked = 0;
    const second = await pt.guard(SYM + '/src/b.js', { scope: 'read', surface: 'interactive', prompt: async () => { asked++; return 'always'; } });
    A.eq(asked, 0, 'a second file under the same root does NOT re-prompt');
    A.ok(second.base.indexOf(REALROOT) === 0, 'and resolves against the blessed canonical root');
  }

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  A.report('pathtrust.test');
})();
