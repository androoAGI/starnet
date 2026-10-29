/* sidecar/run-paths.js — ONE PATH DECISION PER RUN (run-paths lane, 2026-10-28).

   A relative path must name the same file for every tool in one run: fs.*, shell.exec, terminal.start, verify.run,
   the image / voice / Resolve media paths, browser.upload, and every receipt that names a file a tool produced (a
   parked output, a shell or terminal spill, a screenshot, a PDF, a download). Each of those used to make the
   decision itself, from ctx.projectRoot, the old projectCwd field or a private jail of its own, and each fix (#60, #77, #88,
   gauntlet G1 / 8c442112) patched one copy while the others drifted: a shell `cd` in one chat moved every other
   chat of the agent, terminal.start ignored a conversation's project, a screenshot or download named a path that
   fs.read then looked for in the project, and a loop never told its tools which folder it worked in.

   This module IS the decision. The host mints one object per run (index.js runOnce -> ctx.paths):

     root                     the host-minted project root, or null (a relative path then means the private workspace)
     jail                     the agent's private workspace (<workspaces>/<agentId>)
     workdir                  the run's configured routine/thread folder (handed to delegated workers), or null
     base()                   what a relative path means in this run: root, else jail
     resolve(rel, {scope,ctx})  -> { base, abs }  the containment proof, moved here from fs.js unchanged
     place(abs)               a receipt path for a produced file: resolve() maps it back to the same file
     placeJail(rel)           the same for a file a tool named relative to the private workspace
     shellCwd() / setShellCwd(cwd)   this RUN's shell working directory (validated by shell.js on every read)

   pathsFor(ctx, resolver, agentId) is how a tool gets it: the host-minted ctx.paths when there is one, otherwise one
   minted from the tool's own resolver and ctx.projectRoot (bare rigs, route helpers, tests), memoized per ctx object.
   It is the same code either way, so there is no second copy of the rule to drift.

   NOTHING HERE GRANTS ANYTHING. The root is host-minted (a tool argument can never choose it), every resolved target
   re-runs path trust exactly as before, the symlink/junction re-proof is unchanged, and place()/placeJail() only name
   a path this run could already open: an absolute path into the agent's own workspace is served by path trust today.
   A resolver built WITHOUT the trust guard never borrows the run's (fs.js keeps such a resolver on the legacy jail). */
'use strict';
const { note: failNote } = require('./failopen');
const { assertWorkspaceId } = require('./workspace-reserved.js');

const RUN_PATHS = Symbol.for('starnet.runPaths');

function safeAgentId(id) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id || '')) throw new Error('bad agentId');
  // An id equal to a station-owned directory (codex/, channels/, connectors/, plugins/ …) would make that
  // credential/code directory this agent's private jail — refuse it (sidecar/workspace-reserved.js).
  return assertWorkspaceId(id);
}

/* THE CONTAINMENT PROOF (moved verbatim from fs.js resolveInside, 2026-10-28). The only change is where the project
   root comes from: the caller passes it (the run's path object) instead of this code reading ctx.projectRoot. */
function makeResolver(deps) {
  deps = deps || {};
  const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root, environment = deps.environment || null;
  // fsp is optional: a shell-side resolver only NAMES paths (root, jail, placement, cwd) and never resolves one
  if (!P || (!ROOT && !environment)) throw new Error('run-paths requires { pathMod, root } or { pathMod, environment }');
  const pathTrust = typeof deps.pathTrust === 'function' ? deps.pathTrust : null;

  async function workspaceRoot(agentId) {
    if (environment && typeof environment.ensureWorkspace === 'function') return environment.ensureWorkspace(safeAgentId(agentId || 'agent'));
    const dir = P.join(ROOT, safeAgentId(agentId || 'agent'));
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }
  // the same directory, named without creating it (a receipt never needs the folder to exist yet)
  function jailPath(agentId) {
    const aid = safeAgentId(agentId || 'agent');
    if (ROOT) return P.join(ROOT, aid);
    return typeof environment.workspaceRoot === 'function' ? environment.workspaceRoot(aid) : environment.ensureWorkspace(aid);
  }
  function pathInside(abs, base) {
    let a = P.resolve(abs), b = P.resolve(base);
    if (P.sep === '\\') { a = a.toLowerCase(); b = b.toLowerCase(); }
    return a === b || a.indexOf(b + P.sep) === 0;
  }
  async function realpathExisting(p) {
    try { return await fsp.realpath(p); }
    catch (e) { throw new Error('cannot resolve filesystem path (possibly a dangling symlink): ' + p + ': ' + ((e && e.message) || e)); }
  }
  async function deepestExisting(abs, base) {
    let cur = abs;
    for (;;) {
      try { await fsp.lstat(cur); return cur; }
      catch (e) {
        // ENOTDIR = a path THROUGH a file (docs/guide.md/inner) on macOS/Linux; Windows says ENOENT. Both mean "not
        // there": walk up to the real ancestor, so the caller's own missing-path answer runs (fs.search's "(no such path)").
        if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
        const parent = P.dirname(cur);
        if (!parent || parent === cur) return base;
        cur = parent;
      }
    }
  }
  async function checkpointResolvedRoot(base, opts) {
    const ctx = opts && opts.ctx;
    if (!ctx || typeof ctx.checkpointMutation !== 'function' || (opts && opts.scope) !== 'write') return;
    // a checkpoint is a safety net, never a gate on the write: it fails open, but never silently
    try { await ctx.checkpointMutation(base, 'fs mutation', { resolvedRoot: true }); } catch (e) { failNote('runpaths.checkpoint', e); }
  }
  // Resolve a path and PROVE it is reachable. A relative path in a host-validated project session is rooted
  // at that exact project, not at the agent's private deliverables workspace. It still passes through the
  // same path-trust guard as an absolute project path and gets a second symlink-containment proof, so a
  // model cannot manufacture the project root or escape it through a link. Unscoped relative paths retain the
  // historic per-agent jail. Absolute paths always use pathTrust. opts.scope ('read' | 'write') is threaded
  // to the guard so writes can stay consent-gated; opts.ctx is passed through.
  async function resolveFor(agentId, rel, opts) {
    opts = opts || {};
    if (!fsp) throw new Error('run-paths: this resolver names paths only; it has no filesystem to resolve with');
    rel = String(rel == null ? '' : rel);
    if (rel.indexOf('\0') >= 0) throw new Error('illegal path: ' + rel);
    // Absolute on EITHER platform: posix "/abs", win32 "C:\..." AND UNC "\\server\share" (host
    // P.isAbsolute alone misses UNC when running on Linux). Routed to path-trust when wired, else illegal.
    const isAbs = P.win32.isAbsolute(rel) || P.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel);
    if (isAbs) {
      if (!pathTrust) throw new Error('illegal path: ' + rel);
      const resolved = await pathTrust(rel, { scope: opts.scope === 'write' ? 'write' : 'read', agentId: agentId, ctx: opts.ctx });
      await checkpointResolvedRoot(resolved && resolved.base, opts);
      return resolved;
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(rel)) throw new Error('illegal path: ' + rel);
    const projectRoot = typeof opts.projectRoot === 'string' ? opts.projectRoot.trim() : '';
    if (projectRoot) {
      if (!pathTrust) throw new Error('project-relative path requires the project trust guard');
      const base = P.resolve(projectRoot);
      const abs = P.resolve(base, rel || '.');
      if (!pathInside(abs, base)) throw new Error('path escapes project root');
      // Selecting a relative base is not authority: re-run the station grant and protected-file floor for
      // every resolved target, just as an explicit absolute path would.
      await pathTrust(abs, { scope: opts.scope === 'write' ? 'write' : 'read', agentId: agentId, ctx: opts.ctx });
      const baseReal = await realpathExisting(base);
      const existing = await deepestExisting(abs, base);
      const existingReal = await realpathExisting(existing);
      if (!pathInside(existingReal, baseReal)) throw new Error('path escapes project root via symlink');
      await checkpointResolvedRoot(base, opts);
      return { base, abs };
    }
    const base = await workspaceRoot(agentId);
    const abs = P.resolve(base, rel || '.');
    if (!pathInside(abs, base)) throw new Error('path escapes workspace');
    const baseReal = await realpathExisting(base);
    const existing = await deepestExisting(abs, base);
    const existingReal = await realpathExisting(existing);
    if (!pathInside(existingReal, baseReal)) throw new Error('path escapes workspace via symlink');
    await checkpointResolvedRoot(base, opts);
    return { base, abs };
  }

  return { resolveFor, workspaceRoot, jailPath, pathInside, realpathExisting, deepestExisting, safeAgentId, pathMod: P, trusted: !!pathTrust };
}

function isRunPaths(p) { return !!(p && p[RUN_PATHS] === true); }
function rootOf(ctx) {
  if (!ctx) return '';
  if (isRunPaths(ctx.paths)) return ctx.paths.root || '';
  return typeof ctx.projectRoot === 'string' ? ctx.projectRoot.trim() : '';
}

/* The per-run object. o: { agentId, projectRoot, workdir }. `resolver` is makeResolver's result. */
function makeRunPaths(resolver, o) {
  o = o || {};
  if (!resolver || typeof resolver.resolveFor !== 'function') throw new Error('makeRunPaths requires a resolver');
  const P = resolver.pathMod;
  const agentId = safeAgentId(o.agentId || 'agent');
  const root = typeof o.projectRoot === 'string' && o.projectRoot.trim() ? o.projectRoot.trim() : null;
  const workdir = typeof o.workdir === 'string' && o.workdir.trim() ? o.workdir.trim() : null;
  const jail = resolver.jailPath(agentId);
  let shellCwd = null;   // a `cd` is remembered for THIS run only: another chat, routine or worker never inherits it
  const absolute = s => P.win32.isAbsolute(s) || P.posix.isAbsolute(s) || /^[A-Za-z]:/.test(s);
  const paths = {
    agentId, root, workdir, jail,
    base: () => root || jail,
    resolve: (rel, opts) => resolver.resolveFor(agentId, rel, Object.assign({}, opts || {}, { projectRoot: root || '' })),
    // A file this run produced, named so THIS run's resolve() reaches it again: relative to the base when it lies
    // inside it, otherwise its absolute path (path trust serves the agent's own workspace by absolute path).
    place: (abs) => {
      const a = P.resolve(String(abs == null ? '' : abs));
      const b = P.resolve(root || jail);
      if (resolver.pathInside(a, b)) return P.relative(b, a).split(P.sep).join('/') || '.';
      return a;
    },
    // A host-made name relative to the private workspace (.output/x, shots/x, downloads/x). Unscoped it already
    // resolves where it is read, so it is returned byte-for-byte; in a project run it becomes the absolute path.
    placeJail: (rel) => {
      const r = String(rel == null ? '' : rel);
      if (!root || !r || absolute(r) || /(^|[\\/])\.\.([\\/]|$)/.test(r)) return r;
      return P.join(jail, r);
    },
    // a jail name's DURABLE spelling, for text that outlives this run (a channel's stored turn): the absolute path in
    // the private workspace, which every run of this agent opens whatever folder it works in. `..`/absolute: unchanged.
    jailFile: (rel) => {
      const r = String(rel == null ? '' : rel);
      if (!r || absolute(r) || /(^|[\\/])\.\.([\\/]|$)/.test(r)) return r;
      return P.join(jail, r);
    },
    // placeJail's inverse, for a name that LEAVES the station (a chat note, a delivery line): the jail-relative form
    // ('shots/x.png') of a path inside the private workspace, else null. A chat is never told an absolute host path.
    unplaceJail: (abs) => {
      const s = String(abs == null ? '' : abs);
      if (!s || !absolute(s)) return null;
      const a = P.resolve(s);
      if (!resolver.pathInside(a, jail)) return null;
      return P.relative(P.resolve(jail), a).split(P.sep).join('/') || '.';
    },
    shellCwd: () => shellCwd,
    setShellCwd: (cwd) => { shellCwd = cwd ? String(cwd) : null; return shellCwd; }
  };
  Object.defineProperty(paths, RUN_PATHS, { value: true });
  return Object.freeze(paths);
}

/* How a tool reaches the run's path object: ctx.paths (host-minted) when present. Without it (a bare rig, a route
   helper, a test) one is minted from the tool's own resolver and ctx.projectRoot, and kept per resolver under the
   scope key the shell always used (the agent unscoped, the agent + run id in a project), so such a rig keeps its `cd`
   across calls exactly as before. Production runs never take this branch: runOnce mints ctx.paths. */
const minted = new WeakMap();   // resolver -> Map(scopeKey -> paths)
const MINTED_MAX = 256;         // a long-lived resolver (a process-wide tool) stays bounded
function pathsFor(ctx, resolver, agentId) {
  const aid = safeAgentId(agentId || (ctx && ctx.agentId) || 'agent');
  if (ctx && isRunPaths(ctx.paths)) {
    // fail closed: one run, one agent — a ctx whose paths belong to another agent never resolves for this one
    if (ctx.paths.agentId !== aid) throw new Error('run paths belong to agent ' + ctx.paths.agentId + ', not ' + aid);
    return ctx.paths;
  }
  const root = rootOf(ctx);
  const key = root ? aid + '\0project:' + String((ctx && ctx.runId) || root) + '\0' + root : aid;
  let memo = minted.get(resolver);
  if (!memo) { memo = new Map(); minted.set(resolver, memo); }
  const hit = memo.get(key);
  if (hit) return hit;
  const p = makeRunPaths(resolver, { agentId: aid, projectRoot: root, workdir: ctx && typeof ctx.workdir === 'string' ? ctx.workdir : null });
  if (memo.size >= MINTED_MAX) memo.delete(memo.keys().next().value);
  memo.set(key, p);
  return p;
}

module.exports = { makeResolver, makeRunPaths, pathsFor, isRunPaths, rootOf, safeAgentId };
