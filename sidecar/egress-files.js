/* sidecar/egress-files.js — the ONE reader for a file that LEAVES the station (run-paths lane, review S3 + round 2, 2026-10-28).

   channel.send's `files`, a routine delivery's attachments (its ATTACH lines and its generated images) and web_request's
   ${file:…} references all carry a file the agent names to somewhere outside the station. Each used to read through the
   per-agent jail alone, so in a project run the name a tool handed the model (fs.write report.md -> the project) was
   refused, missed, or swapped for a stale same-named file in the private workspace. Round 1 sent them through the run's
   path object at read scope instead, and that reached far past the run: every blessed root, a hand-off read grant,
   This Computer and Full Power reach, and .env / .git under Full Power, with a routine delivering them and no card.

   OWNER DECISION (2026-10-28, final). A file may leave the station only if its REAL path lies inside the producing
   run's own private workspace (paths.jail) or that run's own approved project root (paths.root). Nothing else the run
   could read is sendable: not another blessed root, a session root, a hand-off read grant, This Computer or Full Power.
   The credential / repository floor (.env, .git, ~/.ssh and the rest of pathtrust.js hardlineReason) applies to every
   spelling of the name, jail-relative ones included, whatever fullAccess, unrestrictedHost or Full Power say. A send
   never raises a path-trust prompt or card: the name is never handed to the run's own guard (which can ask); the
   containment is proven here by real path, and the root's approval is re-checked with the station guard in its
   strictest form (autonomous, no prompt, no grants, no posture). There is NO fallback to a same-named file in another
   folder, and no refusal quotes an absolute host path (shownName: the jail-relative form, else the file name).

   THE THREAT MODEL (owner decision, review round 6, 2026-10-29). These rules guard the TOOL paths a file leaves the
   station by (channel.send, a routine delivery, web_request's ${file:…}, browser.upload) and ACCIDENTAL leaks: a wrong
   name, a link nobody meant to send, a stale same-named file. They are NOT a defence against a hostile same-user shell.
   A run that holds an unsandboxed local shell already has the user's own file and network reach (it could read ~/.ssh
   and curl it out with no tool here involved), so a hostile same-user shell is OUT OF SCOPE for egress; the shell's own
   sandbox and consent govern it. The race hardening below exists so the tool paths never become the easy road out for
   such a process, and so a swap is caught and refused where it cheaply can be. It does not claim to stop that process,
   and nothing the station tells the user or the model may claim it does.

   ONE NAME, ONE FILE, THE BYTES THAT WERE PROVEN (review round 3). A hard link is the same file under a second name
   (`mklink /H notes.txt %USERPROFILE%\.ssh\id_ed25519` needs no admin), so a name proven inside the jail could carry
   any file on the volume: a file with more than one name never leaves. The open handle is checked against the proven
   path by inode AND volume (as bigints), and at most the proven size plus one byte is read, so a file that grew after
   the check is refused, never sent whole. The private workspace must BE its folder: a workspaces/<id> that is itself
   a link to another folder holds nothing sendable, and the refusal says how to fix it. That check lives HERE only, on
   what leaves (owner decision, review round 4 minor-2): on the station such a folder is trunk's, fs.* works in it.

   A STAGED COPY FOR THE BROWSER (review round 4, minor-1; HARDENED review round 5). browser.upload hands a website a
   PATH, and the browser opens it later, outside the verified handle. In round 4 the copy lived in the agent's OWN jail
   (<jail>/.upload-staging), so a concurrent same-run process (a shell.exec background child, a terminal) that knew that
   path could replace the staged file — or its folder — with a hard link or a junction to a secret between the checks
   and Chrome's read (scratchpad rr5r-stage-race.js: S1/S1s/S2/S2b/S3 leaked ~/.ssh/id_rsa). The staged copy now lives
   OUTSIDE every agent jail and every blessed project root, in a station-owned scratch root the run is never told about
   and never works in: os.tmpdir()/starnet-upload-staging-<station id> (the same os.tmpdir() the host already uses for
   its own station-owned browser-profile scratch), a per-agent subfolder under it, and a fresh crypto-random folder per
   copy holding one fresh file under the original name. The per-agent folder is locked owner-only (Windows icacls
   /inheritance:r /grant:r, else mode 0o700), fail-closed. The proven bytes are copied through the verified open handle;
   one name and size are checked after the write. Bounded: a file over STAGE_MAX_BYTES is refused. This is a station
   root, so neither fs.* (pathtrust: an outside path is a hard deny on the autonomous surface, and a path under the
   workspace parent that is not the agent's own is denied) nor the shell's absolute-path floor can reach it by a literal
   path. HONEST LIMIT (THE THREAT MODEL above): a shell with the user's rights can still COMPUTE the temp dir, and
   owner-only ACLs do not stop the SAME user. What the station does about it: (a) the copy is not in a folder the run
   is told about or works in; (b) the copy's sha256 is taken from the bytes written, and the copy is re-verified
   (realpath, plain file, nlink===1, dev/ino, size, a bounded streaming re-hash: verifyStaged) immediately before AND
   after the hand-off; (c) Chrome reads an uploaded file at FORM SUBMIT, a later separate action, not when it is
   selected (review round 6, scratchpad rr6-chrome-submit.js: an in-place overwrite and a hard-link swap made after the
   selection were sent at submit), so browser.js keeps every staged copy registered with that proof and re-verifies all
   of them before EVERY later browser action that can submit or read; on any change it clears the file input, drops
   the copy and refuses the action; (d) a copy whose page is gone (navigated away, tab or browser closed) is dropped.
   RESIDUAL RISK: a swap that lands in the window between that last pre-action check and Chrome's read (milliseconds)
   is still sent, and so is one made while a human holds the browser (STEP-IN, sign-in). FOLLOW-UP (not built): verify
   at the network boundary, with CDP Fetch interception of the request body refusing any multipart part whose sha256
   is not a proven one. The browser tools drop their copies when the run ends or their own browser closes (unstage),
   and the host sweeps any a crash left behind at boot (sweepUploadStaging). unstage/sweep never descend through a
   reparse point and prove the folder really lies inside the staging root before removing anything (review round 5
   MAJOR, dropStaged), and re-prove it immediately before each file is unlinked (review round 6 minor).

   THE STAGING ROOT MUST BE OURS (review round 6 MAJOR). On POSIX os.tmpdir() is shared (/tmp), so another user could
   create starnet-upload-staging-<id> first (or a link by that name), and the old recursive mkdir adopted it. The root
   is now created NON-recursively with mode 0o700. A root or per-agent folder that already exists is used only when it
   is a real directory, not a link and not reached through one, and (POSIX) owned by this user with no group/other
   write bit; anything else refuses the upload, fail closed. Windows' os.tmpdir() is per-user; the link and realpath
   checks hold there too (the owner check can be injected for a test: deps.stagingOwner).

   NOT DONE (owner decision, review round 4 minor-5): a hard link stays refused for egress even when it is a build
   output the agent made itself (a compiler or a package manager linking an artifact into place). With round 4's
   MAJOR-2 a routine's refused file is now named in the chat, so the refusal is visible and never silent.

   makeEgressReader({ fsp, pathMod, maxBytes, mimeFor, workspaces, guard, stagingRoot?, hardenStagingDir?, stagingOwner? }) -> {
     read(paths, name, { allowEmpty, probe, stage }?) a name through THIS path object's jail and root; probe: every
                                               check, no bytes read; stage: { dir, maxBytes? } every check, then the
                                               proven bytes copied into a fresh folder of `dir` (abs: the copy, staged:
                                               its folder, ino/dev/nlink/sha256: the copy's proof for re-verification)
     stageDirFor(agentId)                      the per-agent staging folder under the station staging root (what
                                               browser.upload passes as stage.dir); null when no root is known
     verifyStaged(absPath, { size, ino, dev, sha256? })
                                               re-prove a staged copy is unchanged (realpath, plain file, nlink===1,
                                               dev/ino, size, and with sha256 a bounded streaming re-hash through one
                                               open handle) -> { ok } | { ok:false, error }
     unstage(folder, name?)                    removes one staged copy's folder (never recursive, never through a link,
                                               only when it really lies inside the staging root; bounded to `name`)
     readFor(agentId, name, ctx?, projectRoot?, opts?)
                                               through the live run's ctx.paths (same agent), else a path object minted
                                               for a FINISHED run (its agent + its row's project root)
     fireReader(runs, ownAgentId, ownFolder)   (agentId, name, where?) -> readFor: each name through the ONE row of a
                                               routine fire that produced it
     shownName(paths, name), pathsFor(agentId, ctx?, projectRoot?)
   }  read/readFor -> { ok:true, buffer, name, mime, abs, shown, size, mtimeMs } | { ok:false, error, shown, notFound? }
   (never throw; abs is the real path, for the host only; a probe carries no buffer; notFound: the name is simply not
   there, so a routine's "MEDIA: N/A" stays its words, while every other refusal is said out loud: review round 4) */
'use strict';
const RunPaths = require('./run-paths.js');
const { hardlineReason } = require('./pathtrust.js');
const { note: failNote } = require('./failopen.js');
const FIRE_MTIME_SLACK_MS = 2000;   // a coarse-clock volume (FAT: 2 s) may stamp a file a fire just made a little early
const STAGE_DIR = '.upload-staging';             // LEGACY: round-4 per-agent subfolder name; staging now lives OUTSIDE the jail (defaultStagingRoot)
const STAGE_MAX_BYTES = 200 * 1024 * 1024;
const STAGE_CHUNK = 1024 * 1024;                 // the copy streams: a 200 MB upload never sits in memory
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// path helpers usable by the module-level dropStaged/sweep as well as the reader (same case-folding as pathtrust)
function mfold(P, s) { return (P.sep === '\\' ? String(s).toLowerCase() : String(s)); }
function minside(P, a, b) { const x = mfold(P, P.resolve(a)), y = mfold(P, P.resolve(b)); return x === y || x.indexOf(y + P.sep) === 0; }

/* THE STATION-OWNED STAGING ROOT (review round 5 BLOCKER): os.tmpdir()/starnet-upload-staging-<station id>, OUTSIDE
   every agent jail and every blessed project root — the host already stages its browser profiles under the same
   os.tmpdir(). The station id is a short stable hash of this station's workspaces root, so two stations sharing one
   os.tmpdir() never collide and the SAME station finds its own leftovers at boot (sweepUploadStaging). */
function defaultStagingRoot(P, workspaces, tmp) {
  const crypto = require('node:crypto');
  const id = crypto.createHash('sha256').update(String(workspaces == null ? '' : workspaces)).digest('hex').slice(0, 16);
  return P.join(tmp || require('node:os').tmpdir(), 'starnet-upload-staging-' + id);
}

// owner-only ACLs on the per-agent staging folder: Windows icacls (no shell, fail-closed), else mode 0o700.
function defaultHardenStagingDir(fsp, dir) {
  if (process.platform !== 'win32') return fsp.chmod(dir, 0o700);
  return new Promise((resolve, reject) => {
    let user = String(process.env.USERNAME || '').trim();
    if (!user) { try { user = require('node:os').userInfo().username; } catch (_) { user = ''; } }
    if (!user) return reject(new Error('no current user to grant staging ACLs to'));
    // through the guard: icacls never inherits station secrets (STARNET_/SKYNET_ keys stripped from its env)
    require('./child-env.js').guardChildProcess(require('node:child_process')).execFile('icacls', [dir, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F'],
      { windowsHide: true, timeout: 15000 }, (err) => err ? reject(err) : resolve());
  });
}

/* THE STAGING ROOT MUST BE OURS (review round 6 MAJOR; header). The owner a staging folder must have: POSIX, this
   process's uid (a folder another user made in the shared /tmp is theirs, and so is anything they put in it); Windows,
   none (os.tmpdir() is per-user and stat carries no owner; the link and realpath checks still hold). */
function defaultStagingOwner() {
  return process.platform !== 'win32' && typeof process.getuid === 'function' ? { uid: process.getuid() } : null;
}
// null when `d` is a staging folder this station may write into, else the reason it is not: it must be a real
// directory, not a link and not reached through one (its real path is its real parent's plus its own name), and with
// an owner to check, owned by that uid with no group/other write bit. Throws what lstat/realpath throw (ENOENT).
async function stagingDirProblem(fsp, P, d, owner) {
  const abs = P.resolve(d);
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink() || !st.isDirectory()) return 'is a link to somewhere else';
  const real = await fsp.realpath(abs);
  if (mfold(P, real) !== mfold(P, P.join(await fsp.realpath(P.dirname(abs)), P.basename(abs)))) return 'is a link to somewhere else';
  if (owner) {
    if (Number(st.uid) !== Number(owner.uid)) return 'belongs to another user';
    if (Number(st.mode) & 0o022) return 'is writable by other users';
  }
  return null;
}
function sweepRootOf(deps, P) {
  return deps.stagingRoot ? String(deps.stagingRoot) : (deps.workspaces ? defaultStagingRoot(P, deps.workspaces, deps.tmpdir) : null);
}
/* THE BOOT SWEEP, ONCE (review round 6 info). index.js runs it at HOST START whether it was started as `node
   sidecar/index.js` or require()d by a host (the sweep used to sit behind require.main === module, so a host that
   require()s index.js never swept). Guarded per staging root for the life of the process: a second call is a no-op,
   so a later caller can never sweep a live run's staged copies. -> what sweepUploadStaging removed, or 0 */
const sweptRoots = new Set();
function sweepUploadStagingOnce(deps) {
  const P = deps.pathMod || require('node:path');
  const root = sweepRootOf(deps, P);
  if (!root) return Promise.resolve(0);
  const key = mfold(P, P.resolve(root));
  if (sweptRoots.has(key)) return Promise.resolve(0);
  sweptRoots.add(key);
  return sweepUploadStaging(deps);
}

/* ONE staged copy's folder away (review round 5 MAJOR). A junction swapped in between lstat and readdir used to make
   readdir return a VICTIM folder's children, which were then unlinked (rr5r-stage-race.js S4). Now: a reparse point /
   symlink is unlinked as a link and NEVER descended into (a Windows directory junction is removed by unlink/rmdir of
   the link, never recursively); a folder is proven to really lie inside the staging root (realpath on the lstat-proven
   directory) before its entries are touched; the delete is bounded to the one known staged name where we have it, and
   the folder is RE-PROVEN unchanged after the readdir before anything is removed, so a mid-readdir swap is refused.
   RE-PROVEN BEFORE EACH UNLINK (review round 6 minor, scratchpad rr6-dropstaged-race.js A): with the name known, a
   junction swapped in AFTER the first proof made folder/<name> name the VICTIM's file of that name, and it was
   unlinked. The folder is now proven a real directory inside the root again immediately before every unlink; a folder
   that became a link is unlinked as a link and nothing in it is touched. RESIDUAL: a swap in the microseconds between
   that last proof and the unlink (Node has no unlinkat on a held directory handle).
   boundRoot: the staging root `folder` must really lie inside (and never be). knownName: the single staged file. */
async function dropStaged(fsp, P, folder, boundRoot, knownName) {
  // -> true while `folder` is still a real directory inside boundRoot; a folder that became a link is unlinked (as a link)
  const stillOurs = async () => {
    let s;
    try { s = await fsp.lstat(folder); } catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
    if (s.isSymbolicLink() || !s.isDirectory()) { await unlinkOne(fsp, folder); return false; }   // a reparse point: unlink the link, never enter
    return provenInside(fsp, P, folder, boundRoot);                                                 // not a per-copy folder inside the root: touch nothing
  };
  if (!(await stillOurs())) return;
  let names;
  if (knownName) names = [knownName];
  else {
    try { names = await fsp.readdir(folder); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    if (!(await stillOurs())) return;   // swapped DURING the readdir: its victim entries are never trusted
  }
  for (const name of names) {
    const p = P.join(folder, name);
    let s;
    try { s = await fsp.lstat(p); } catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }
    if (s.isDirectory() && !s.isSymbolicLink()) continue;   // a real subdirectory is not a staged file; leave it (rmdir then fails, caller notes it)
    if (!(await stillOurs())) return;                       // swapped since the proof: folder/<name> may now be a victim's file
    await unlinkOne(fsp, p);
  }
  // re-prove once more before removing the folder itself: a junction swapped in now is unlinked as a link, not entered
  if (!(await stillOurs())) return;
  await fsp.rmdir(folder);
}
// the lstat-proven directory `folder` really resolves inside boundRoot (and is not boundRoot itself). No boundRoot => refuse.
async function provenInside(fsp, P, folder, boundRoot) {
  if (!boundRoot) return false;
  let real, rootReal;
  try { real = await fsp.realpath(folder); rootReal = await fsp.realpath(boundRoot); }
  catch (e) { return false; }
  return mfold(P, real) !== mfold(P, rootReal) && minside(P, real, rootReal);
}
async function unlinkOne(fsp, p) {
  try { await fsp.unlink(p); }
  catch (e) {
    if (e && e.code === 'ENOENT') return;
    if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) { await fsp.rmdir(p); return; }   // a directory link on Windows
    throw e;
  }
}

/* At boot (nothing is uploading yet): every <stagingRoot>/<agent>/<folder> a crashed run left behind. Only real folders
   are walked; an agent folder or a per-copy folder that is a link is never entered, and dropStaged proves each per-copy
   folder really lies inside the staging root before removing it. deps: { fsp, pathMod, stagingRoot | workspaces, tmpdir? }
   -> count removed. */
async function sweepUploadStaging(deps) {
  const fsp = deps.fsp, P = deps.pathMod || require('node:path');
  const root = sweepRootOf(deps, P);
  if (!root) return 0;
  // a root that is not ours (a link, another user's folder: review round 6 MAJOR) is never walked
  let problem;
  try { problem = await stagingDirProblem(fsp, P, root, deps.stagingOwner !== undefined ? deps.stagingOwner : defaultStagingOwner()); }
  catch (e) { if (e && e.code === 'ENOENT') return 0; throw e; }
  if (problem) { console.warn('[browser.upload] boot sweep skipped: the upload staging root ' + root + ' ' + problem); return 0; }
  let agents, removed = 0;
  try { agents = await fsp.readdir(root, { withFileTypes: true }); }
  catch (e) { if (e && e.code === 'ENOENT') return 0; throw e; }
  for (const a of agents) {
    if (!a.isDirectory() || !AGENT_ID_RE.test(a.name)) continue;
    const dir = P.join(root, a.name);
    let st;
    try { st = await fsp.lstat(dir); } catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    for (const s of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      try { await dropStaged(fsp, P, P.join(dir, s.name), root); removed++; } catch (e) { failNote('egress.stage.sweep', e); }
    }
  }
  return removed;
}

function makeEgressReader(deps) {
  deps = deps || {};
  const fsp = deps.fsp, P = deps.pathMod || require('node:path');
  const maxBytes = Number(deps.maxBytes) > 0 ? Number(deps.maxBytes) : Infinity;
  const mimeFor = typeof deps.mimeFor === 'function' ? deps.mimeFor : () => '';
  const guard = typeof deps.guard === 'function' ? deps.guard : null;
  const absolute = s => P.win32.isAbsolute(s) || P.posix.isAbsolute(s) || /^[A-Za-z]:/.test(s);
  const fileName = s => String(s).split(/[\\/]/).filter(Boolean).pop() || 'file';
  const fold = s => (P.sep === '\\' ? String(s).toLowerCase() : String(s));
  const inside = (a, b) => { const x = fold(P.resolve(a)), y = fold(P.resolve(b)); return x === y || x.indexOf(y + P.sep) === 0; };
  const missing = e => !!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'));
  const unc = s => /^[\\/]{2}/.test(String(s || ''));
  // the station-owned staging root (OUTSIDE every jail and project root), its per-agent folders, and the owner-only lock
  const stagingRoot = deps.stagingRoot ? String(deps.stagingRoot) : (deps.workspaces ? defaultStagingRoot(P, deps.workspaces, deps.tmpdir) : null);
  const hardenDir = typeof deps.hardenStagingDir === 'function' ? deps.hardenStagingDir : (dir => defaultHardenStagingDir(fsp, dir));
  const hardened = new Set();   // per-agent staging folders already locked owner-only this process (icacls once per folder)
  const stagingOwner = deps.stagingOwner !== undefined ? deps.stagingOwner : defaultStagingOwner();
  function stageDirFor(agentId) {
    const aid = String(agentId == null ? '' : agentId);
    if (!stagingRoot || !AGENT_ID_RE.test(aid)) return null;
    return P.join(stagingRoot, aid);
  }

  // what a CHAT may be told about a name: a relative name as written, an absolute one inside the private workspace by
  // its jail-relative form, anything else only by its file name
  function shownName(paths, name) {
    const n = String(name == null ? '' : name).trim();
    if (!absolute(n)) return n;
    const rel = paths && typeof paths.unplaceJail === 'function' ? paths.unplaceJail(n) : null;
    return rel || fileName(n);
  }

  // the base's real path, or null when it does not exist (nothing can be inside a folder that is not there)
  async function realBase(dir) {
    if (!dir) return null;
    try { return await fsp.realpath(dir); }
    catch (e) { if (missing(e)) return null; throw e; }
  }
  // the private workspace IS its folder: its real path is its real parent's real path plus its own name. A
  // workspaces/<id> that is a junction to another folder (the home folder) is not this agent's workspace.
  async function ownFolder(dir, dirReal) {
    const d = P.resolve(dir);
    return fold(dirReal) === fold(P.join(await fsp.realpath(P.dirname(d)), P.basename(d)));
  }

  // write all of buf[0, n) to a handle (a short write is continued, never dropped)
  async function writeAll(out, buf, n) {
    let off = 0;
    while (off < n) { const w = await out.write(buf, off, n - off); off += w.bytesWritten; if (!w.bytesWritten) throw new Error('short write'); }
  }
  // THE STAGING ROOT AND THE PER-AGENT FOLDER, PROVEN OURS (review round 6 MAJOR): each is created non-recursively
  // with mode 0o700, and one that already exists must pass stagingDirProblem. dir must be a direct child of the root.
  // -> null | the chat-facing reason (fail closed; the host path goes to the console only)
  async function ensureStagingDir(dir) {
    const refuse = (what, why) => {
      console.warn('[browser.upload] staging refused: ' + what + ' ' + why);
      return 'cannot be staged for the browser: the upload staging folder ' + why + ', so nothing was uploaded';
    };
    if (!stagingRoot || fold(P.dirname(P.resolve(dir))) !== fold(P.resolve(stagingRoot))) return refuse(dir, 'is not this station\'s staging folder');
    for (const d of [stagingRoot, dir]) {
      try { await fsp.mkdir(d, { mode: 0o700 }); }
      catch (e) { if (!(e && e.code === 'EEXIST')) throw e; }
      const problem = await stagingDirProblem(fsp, P, d, stagingOwner);
      if (problem) return refuse(d, problem);
    }
    return null;
  }
  // stage mode: the proven bytes, through the verified handle, into a fresh folder of the per-agent staging folder,
  // hashed (sha256) from the very bytes written. The per-agent folder is locked owner-only once per process
  // (fail-closed). -> { ok, path, dir, ino, dev, nlink, sha256 }
  async function stageCopy(fh, size, name, dir) {
    let sub = null;
    try {
      const refused = await ensureStagingDir(dir);
      if (refused) return { ok: false, error: refused };
      const dirReal = await fsp.realpath(dir);
      // owner-only ACLs on the (proven-real) per-agent staging folder, once per folder; a failure refuses the upload
      // (fail closed — never stage into a folder we could not lock to this user)
      if (!hardened.has(fold(dirReal))) {
        try { await hardenDir(dir); }
        catch (e) { return { ok: false, error: 'could not be staged for the browser: the upload staging folder could not be locked to you (' + ((e && e.code) || (e && e.message) || 'error') + ')' }; }
        hardened.add(fold(dirReal));
      }
      sub = P.join(dir, require('node:crypto').randomBytes(12).toString('hex'));
      await fsp.mkdir(sub);
      const dest = P.join(sub, name);
      const out = await fsp.open(dest, 'wx', 0o600);
      const hash = require('node:crypto').createHash('sha256');
      let got = 0;
      try {
        const buf = Buffer.alloc(Math.max(1, Math.min(STAGE_CHUNK, size + 1)));
        while (got <= size) {
          const r = await fh.read(buf, 0, Math.min(buf.length, size + 1 - got), got);
          if (!r.bytesRead) break;
          await writeAll(out, buf, r.bytesRead);
          hash.update(buf.subarray(0, r.bytesRead));
          got += r.bytesRead;
        }
      } finally { await out.close(); }
      if (got !== size) { await dropStaged(fsp, P, sub, stagingRoot, name); return { ok: false, error: 'changed while it was being read; nothing was uploaded' }; }
      // the copy has one name, its proven size, and sits where it was written
      const cst = await fsp.lstat(dest, { bigint: true });
      const again = await fsp.realpath(dest);
      if (!cst.isFile() || cst.nlink !== 1n || Number(cst.size) !== size || fold(again) !== fold(P.join(dirReal, P.basename(sub), name))) {
        await dropStaged(fsp, P, sub, stagingRoot, name);
        return { ok: false, error: 'could not be staged for the browser; nothing was uploaded' };
      }
      // the copy's proof (dev/ino, one name, size, the sha256 of the bytes written), so the hand-off and every later
      // browser action can re-prove it is still this exact file holding these exact bytes
      return { ok: true, path: again, dir: sub, ino: cst.ino, dev: cst.dev, nlink: 1, sha256: hash.digest('hex') };
    } catch (e) {
      if (sub) { try { await dropStaged(fsp, P, sub, stagingRoot, name); } catch (e2) { failNote('egress.stage.drop', e2); } }
      return { ok: false, error: 'could not be staged for the browser (' + ((e && e.code) || 'error') + ')' };
    }
  }

  // re-prove a staged copy is unchanged: a plain file, one name, the same dev/ino, the same size, whose realpath is
  // still itself (a folder or file swapped for a link/junction changes the realpath or dev/ino), and with
  // expected.sha256 (review round 6 BLOCKER) the same bytes: an in-place overwrite to the same size with its mtime put
  // back keeps every identity above, so the bytes are re-hashed through ONE open handle whose identity is checked
  // against the path's, reading at most size + 1 bytes (bounded: an upload is at most STAGE_MAX_BYTES), and the path
  // is re-checked after the read. -> { ok } | { ok:false, error }
  async function verifyStaged(absPath, expected) {
    expected = expected || {};
    const fail = error => ({ ok: false, error });
    const same = (st) => {
      if (st.nlink !== 1n) return 'the staged upload gained another name on disk';
      if (expected.size != null && Number(st.size) !== Number(expected.size)) return 'the staged upload changed size';
      if (expected.ino != null && st.ino !== expected.ino) return 'the staged upload was replaced';
      if (expected.dev != null && st.dev !== expected.dev) return 'the staged upload moved to another volume';
      return null;
    };
    try {
      const st = await fsp.lstat(absPath, { bigint: true });
      if (st.isSymbolicLink() || !st.isFile()) return fail('the staged upload is no longer a plain file');
      const off = same(st);
      if (off) return fail(off);
      const real = await fsp.realpath(absPath);
      if (fold(real) !== fold(P.resolve(absPath))) return fail('the staged upload path now resolves elsewhere');
      if (typeof expected.sha256 !== 'string' || !expected.sha256) return { ok: true };
      const size = Number(st.size);
      const fh = await fsp.open(real, 'r');
      try {
        const hst = await fh.stat({ bigint: true });
        if (!hst.isFile() || hst.ino !== st.ino || hst.dev !== st.dev) return fail('the staged upload was replaced');
        const hash = require('node:crypto').createHash('sha256');
        const buf = Buffer.alloc(Math.max(1, Math.min(STAGE_CHUNK, size + 1)));
        let got = 0;
        while (got <= size) {
          const r = await fh.read(buf, 0, Math.min(buf.length, size + 1 - got), got);
          if (!r.bytesRead) break;
          hash.update(buf.subarray(0, r.bytesRead));
          got += r.bytesRead;
        }
        if (got !== size) return fail('the staged upload changed size');
        if (hash.digest('hex') !== expected.sha256) return fail('the staged upload\'s bytes changed');
      } finally { await fh.close(); }
      const after = await fsp.lstat(absPath, { bigint: true });
      const moved = after.isSymbolicLink() || !after.isFile() ? 'the staged upload is no longer a plain file' : same(after);
      return moved ? fail(moved) : { ok: true };
    } catch (e) { return fail('the staged upload could not be re-verified (' + ((e && e.code) || 'error') + ')'); }
  }

  // the chat-facing reason a file on a network share is refused, naming no server; the detail goes to the console
  async function shareRefusal(paths, q, real) {
    let jailReal = null;
    try { jailReal = unc(paths.jail) ? paths.jail : await realBase(paths.jail); }
    catch (e) { console.warn('[egress] could not resolve the workspace folder of ' + q + ': ' + ((e && e.code) || (e && e.message) || e)); }
    const where = unc(jailReal) ? 'this station\'s workspaces live on a network share (\\\\server\\…)'
      : paths.root && unc(paths.root) ? 'this run\'s project folder is on a network share (\\\\server\\…)'
        : 'its real path is on a network share (\\\\server\\…)';
    console.warn('[egress] ' + q + ' refused: its real path ' + real + ' is on a network share' + (unc(jailReal) ? ' (the workspace folder is ' + jailReal + ')' : ''));
    return q + ' cannot be sent: ' + where + ', and files on network shares never leave the station';
  }

  // opts.allowEmpty: an empty file is a legal request part (web_request); a chat upload refuses it.
  // opts.probe: run every check and return the proven real path without reading a byte
  // opts.stage: { dir, maxBytes? } run every check, then copy the proven bytes into a fresh folder of dir (browser.upload)
  async function read(paths, name, opts) {
    const allowEmpty = !!(opts && opts.allowEmpty), probe = !!(opts && opts.probe);
    const stage = opts && opts.stage && typeof opts.stage.dir === 'string' && opts.stage.dir ? opts.stage : null;
    const n = String(name == null ? '' : name).trim();
    const shown = shownName(paths, n);
    const no = error => ({ ok: false, error, shown });
    const gone = error => ({ ok: false, error, shown, notFound: true });   // nothing by that name: not a refusal
    if (!RunPaths.isRunPaths(paths)) return no('this run has no path object to resolve files with');
    if (!n) return no('a file needs a path');
    const q = '"' + shown + '"';
    const where = paths.root ? 'this run\'s project folder' : 'your workspace';
    const reach = paths.root ? 'this run\'s project folder or your workspace' : 'your workspace';
    const floored = q + ' is a protected file (credentials or repository internals) and never leaves the station';
    if (n.indexOf('\0') >= 0) return no(q + ' is not a legal path');
    if (/^[\\/]{2}/.test(n)) return no(q + ' is a network path; only a file in ' + reach + ' can be sent');
    if (/^[A-Za-z]:(?![\\/])/.test(n)) return no(q + ' is drive-relative; name it relative to ' + where + ' or by its full path');
    // 1. the name -> ONE absolute path, no I/O: a relative name means this run's base (its root, else its jail) and never
    //    climbs out of it; an absolute one is taken as written and must prove itself below like any other
    let abs;
    if (absolute(n)) abs = P.resolve(n);
    else if (/(^|[\\/])\.\.([\\/]|$)/.test(n)) return no(q + ' climbs out of ' + where + ' (..); only a file in ' + reach + ' can be sent');
    else abs = P.resolve(paths.base(), n);
    // 2. THE FLOOR on the name as written and as resolved (NTFS stream and 8.3 spellings are caught again on the real path)
    if (hardlineReason(n, abs)) return no(floored);
    // 3. the REAL file, and the floor again on it (a link named notes.txt -> .env carries no `.env` in its name)
    let real;
    try { real = await fsp.realpath(abs); }
    catch (e) {
      if (missing(e)) return gone(q + ' is not in ' + where + (absolute(n) ? '' : ' (a relative path means ' + where + ' in this run)'));
      return no(q + ' cannot be read (' + ((e && e.code) || 'error') + ')');
    }
    // A NETWORK SHARE (review round 4, minor-6): the floor refuses every UNC path, so a file on a share never leaves,
    // but "a protected file" was the wrong reason when the station's workspaces (or the project) live on a NAS. Still
    // refused; the chat is told the true reason with the shown name only, and the share's path goes to the console.
    if (unc(real)) return no(await shareRefusal(paths, q, real));
    if (hardlineReason(real, real)) return no(floored);
    // 4. CONTAINMENT by real path: this run's own private workspace, or this run's own project root. Nothing else.
    let inJail = false, inRoot = false, inLinkedJail = false;
    try {
      const jailReal = await realBase(paths.jail);
      if (jailReal && inside(real, jailReal)) {
        if (await ownFolder(paths.jail, jailReal)) inJail = true;
        else inLinkedJail = true;
      }
      if (!inJail && paths.root) { const rootReal = await realBase(paths.root); inRoot = !!rootReal && inside(real, rootReal); }
    } catch (e) { return no(q + ' cannot be proven inside ' + reach + ' (' + ((e && e.code) || 'error') + ')'); }
    if (!inJail && !inRoot && inLinkedJail) return no(q + ' cannot be sent: this agent\'s workspace folder is a link to somewhere else, so files in it never leave the station; move the folder back or unlink it');
    if (!inJail && !inRoot) return no(q + ' is outside ' + reach + '; only a file there can be sent');
    // 5. A PROJECT FILE ONLY WHILE ITS FOLDER IS STILL APPROVED: the station guard in its strictest form. No prompt (a
    //    send never raises a card), no hand-off grants or session roots, no This Computer / Full Power posture, so only a
    //    standing grant passes it (a revoke mid-run stops the send). The private workspace needs no grant: step 4 proved it.
    if (inRoot) {
      if (!guard) return no(q + ' cannot be sent: this host cannot prove the project folder is still approved');
      try { await guard(real, { scope: 'read', surface: 'autonomous', prompt: null, agentId: paths.agentId, readGrants: [], sessionRoots: null, fullAccess: false, unrestrictedHost: false, userTouch: false }); }
      catch (e) { return no(q + ' cannot be sent: this run\'s project folder is no longer approved'); }
    }
    // 6. read WHAT WAS PROVEN: open the real path, then check the open handle is still that file at that real path (a
    //    folder swapped for a link between the proof and the open is refused, never followed). Inode and volume are
    //    compared as bigints: a 64-bit NTFS file index does not fit a double.
    let fh;
    try { fh = await fsp.open(real, 'r'); }
    catch (e) { return missing(e) ? gone(q + ' is not in ' + where) : no(q + ' cannot be read (' + ((e && e.code) || 'error') + ')'); }
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile()) return no(q + ' is not a file');
      // ONE NAME ONLY: every check above proved a NAME, and a hard link is this same file under another name anywhere on
      // the volume (~/.ssh, another root) that nothing here can see. A file with more than one name never leaves.
      const linked = q + ' has other names on this disk (a hard link), so it never leaves the station';
      if (st.nlink > 1n) return no(linked);
      const size = Number(st.size);
      if (size > maxBytes) return no(q + ' is ' + Math.round(size / (1024 * 1024)) + 'MB (limit ' + Math.round(maxBytes / (1024 * 1024)) + 'MB)');
      const again = await fsp.realpath(real);
      const now = await fsp.stat(again, { bigint: true });
      if (fold(again) !== fold(real) || now.ino !== st.ino || now.dev !== st.dev) return no(q + ' changed while it was being read; nothing was sent');
      if (now.nlink > 1n) return no(linked);
      const mtimeMs = Number(st.mtimeMs);
      if (probe) {
        if (!size && !allowEmpty) return no(q + ' is empty');
        return { ok: true, name: P.basename(real), mime: mimeFor(real), abs: real, shown, size, mtimeMs };
      }
      if (stage) {
        if (!size && !allowEmpty) return no(q + ' is empty');
        const cap = Number(stage.maxBytes) > 0 ? Number(stage.maxBytes) : STAGE_MAX_BYTES;
        const sized = (n) => (n >= 1024 * 1024 ? Math.round(n / (1024 * 1024)) + ' MB' : n + ' bytes');
        if (size > cap) return no(q + ' is ' + sized(size) + '; a browser upload takes at most ' + sized(cap));
        const copy = await stageCopy(fh, size, P.basename(real), stage.dir);
        if (!copy.ok) return no(q + ' ' + copy.error);
        return { ok: true, name: P.basename(real), mime: mimeFor(real), abs: copy.path, staged: copy.dir, ino: copy.ino, dev: copy.dev, nlink: copy.nlink, sha256: copy.sha256, shown, size, mtimeMs };
      }
      // at most the proven size plus one byte, through this handle (readFile would stat again): an extra byte means the
      // file grew after the check and a short read that it shrank; either way it is not the file that was proven
      const buf = Buffer.alloc(size + 1);
      let got = 0;
      while (got < buf.length) {
        const r = await fh.read(buf, got, buf.length - got, got);
        if (!r.bytesRead) break;
        got += r.bytesRead;
      }
      if (got !== size) return no(q + ' changed while it was being read; nothing was sent');
      const buffer = buf.subarray(0, size);
      if (!buffer.length && !allowEmpty) return no(q + ' is empty');
      return { ok: true, buffer, name: P.basename(real), mime: mimeFor(real), abs: real, shown, size, mtimeMs };
    } catch (e) {
      return no(q + ' cannot be read (' + ((e && e.code) || 'error') + ')');
    } finally {
      await fh.close();
    }
  }

  // the PRODUCING run's path object: the live run's own (ctx.paths of this same agent), else one for a finished run.
  // read() takes only its agent, jail and root from it; its resolver never runs for a send.
  function pathsFor(agentId, ctx, projectRoot) {
    const aid = String(agentId || '');
    if (ctx && RunPaths.isRunPaths(ctx.paths) && ctx.paths.agentId === aid) return ctx.paths;
    if (!deps.workspaces) throw new Error('egress reader has no workspaces root');
    const resolver = RunPaths.makeResolver({ fsp, pathMod: P, root: deps.workspaces,
      pathTrust: guard ? (abs) => guard(abs, { scope: 'read', surface: 'autonomous', prompt: null, agentId: aid }) : undefined });
    return RunPaths.makeRunPaths(resolver, { agentId: aid, projectRoot: projectRoot || '' });
  }

  async function readFor(agentId, name, ctx, projectRoot, opts) {
    let paths;
    try { paths = pathsFor(agentId, ctx, projectRoot); }
    catch (e) { return { ok: false, error: (e && e.message) || 'no workspace for that agent', shown: absolute(String(name || '')) ? fileName(name) : String(name || '') }; }
    return read(paths, name, opts);
  }

  /* A routine fire's files (review round 2). A name is read through the ONE row of this fire that produced it, never
     by trying every agent's folder newest first (a stale same-named file in another agent's private workspace used to
     win):
       - a pick that carries its row (a generated image: where.root, with that row's agent) reads through that row;
       - else the NEWEST row whose artifact ledger names the file (relative to that row's base, or by absolute path);
       - else the one file the fire's bases hold under that name (each row's agent + root; the routine's own agent
         through its folder when no row of it exists). Two DIFFERENT files under one name are refused, never guessed,
         and so is a file written before the fire's first row began (review round 3): a same-named file an earlier run
         left in another row's folder is not this fire's, even when it is the only one. That age rule is for ANOTHER
         agent's folder only (review round 4, MAJOR-2): the routine's own agent's workspace and project hold files it
         keeps (a weekly report another process made, the project's budget, a file copied in with its old mtime kept),
         and they send as they are.
     A refusal outranks a "not found" from another folder, so the answer says why a file that is there did not go.
     runs: NEWEST first. -> (agentId, name, where?) => readFor's answer */
  function fireReader(runs, ownAgentId, ownFolder) {
    const rows = (Array.isArray(runs) ? runs : []).filter(r => r && typeof r === 'object' && r.agentId);
    const bases = [];
    const addBase = (agentId, root) => { if (!bases.some(b => b.agentId === agentId && b.root === root)) bases.push({ agentId, root }); };
    for (const r of rows) addBase(String(r.agentId), String(r.projectRoot || ''));
    if (ownAgentId && !rows.some(r => String(r.agentId) === String(ownAgentId))) addBase(String(ownAgentId), ownFolder ? String(ownFolder) : '');
    const jailOf = aid => (deps.workspaces && /^[A-Za-z0-9_-]{1,40}$/.test(aid) ? P.join(deps.workspaces, aid) : '');
    const at = (name, r) => RunPaths.producedPath(name, { projectRoot: String(r.projectRoot || ''), jail: jailOf(String(r.agentId)) }).path;
    const same = (a, b) => fold(P.resolve(a)) === fold(P.resolve(b));
    // the fire began when its first row did (rows without a start time bound nothing)
    const starts = rows.map(r => Number(r.startedAt)).filter(n => Number.isFinite(n) && n > 0);
    const since = starts.length ? Math.min.apply(null, starts) - FIRE_MTIME_SLACK_MS : 0;
    function producerOf(name) {
      for (const r of rows) {
        const want = at(name, r);
        if (!want) continue;
        for (const a of (Array.isArray(r.artifacts) ? r.artifacts : [])) {
          const made = a && typeof a.path === 'string' && a.path.trim() ? at(a.path, r) : null;
          if (made && same(made, want)) return { agentId: String(r.agentId), root: String(r.projectRoot || '') };
        }
      }
      return null;
    }
    return async (aid, name, where) => {
      if (where && typeof where.root === 'string') return readFor(aid, name, null, where.root);
      const made = producerOf(name);
      if (made) return readFor(made.agentId, name, null, made.root);
      let first = null, stale = null;
      const hits = [];
      for (const b of bases) {
        const got = await readFor(b.agentId, name, null, b.root);
        if (!got.ok) { if (!first || (first.notFound && !got.notFound)) first = got; continue; }
        if (since && b.agentId !== String(ownAgentId) && !(got.mtimeMs >= since)) { stale = stale || got; continue; }
        if (!hits.some(h => same(h.abs, got.abs))) hits.push(got);
      }
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        const shown = hits[0].shown;
        return { ok: false, error: '"' + shown + '" names a different file in more than one folder this routine worked in, so none was sent; name it by its folder', shown };
      }
      if (stale) return { ok: false, error: '"' + stale.shown + '" is older than this routine fire, so it is not a file the fire made; nothing was sent', shown: stale.shown };
      const shown = absolute(String(name || '')) ? fileName(name) : String(name || '');
      return first || { ok: false, error: 'this routine fire has no run to read "' + shown + '" through', shown, notFound: true };
    };
  }

  return {
    read, readFor, fireReader, shownName, pathsFor, stageDirFor, verifyStaged, stagingRoot,
    unstage: (folder, name) => dropStaged(fsp, P, folder, stagingRoot, name)
  };
}

module.exports = { makeEgressReader, sweepUploadStaging, sweepUploadStagingOnce, defaultStagingRoot, STAGE_DIR, STAGE_MAX_BYTES };
