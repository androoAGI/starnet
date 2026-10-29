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

   makeEgressReader({ fsp, pathMod, maxBytes, mimeFor, workspaces, guard }) -> {
     read(paths, name, { allowEmpty }?)        a name through THIS path object's jail and root
     readFor(agentId, name, ctx?, projectRoot?, opts?)
                                               through the live run's ctx.paths (same agent), else a path object minted
                                               for a FINISHED run (its agent + its row's project root)
     fireReader(runs, ownAgentId, ownFolder)   (agentId, name) -> readFor: each agent of a routine fire through ITS run
     shownName(paths, name), pathsFor(agentId, ctx?, projectRoot?)
   }  read/readFor -> { ok:true, buffer, name, mime, abs, shown } | { ok:false, error, shown }   (never throw; abs is the
   real path, for the host only) */
'use strict';
const RunPaths = require('./run-paths.js');
const { hardlineReason } = require('./pathtrust.js');

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

  // opts.allowEmpty: an empty file is a legal request part (web_request); a chat upload refuses it
  async function read(paths, name, opts) {
    const allowEmpty = !!(opts && opts.allowEmpty);
    const n = String(name == null ? '' : name).trim();
    const shown = shownName(paths, n);
    const no = error => ({ ok: false, error, shown });
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
      if (missing(e)) return no(q + ' is not in ' + where + (absolute(n) ? '' : ' (a relative path means ' + where + ' in this run)'));
      return no(q + ' cannot be read (' + ((e && e.code) || 'error') + ')');
    }
    if (hardlineReason(real, real)) return no(floored);
    // 4. CONTAINMENT by real path: this run's own private workspace, or this run's own project root. Nothing else.
    let inJail = false, inRoot = false;
    try {
      const jailReal = await realBase(paths.jail);
      inJail = !!jailReal && inside(real, jailReal);
      if (!inJail && paths.root) { const rootReal = await realBase(paths.root); inRoot = !!rootReal && inside(real, rootReal); }
    } catch (e) { return no(q + ' cannot be proven inside ' + reach + ' (' + ((e && e.code) || 'error') + ')'); }
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
    //    folder swapped for a link between the proof and the open is refused, never followed)
    let fh;
    try { fh = await fsp.open(real, 'r'); }
    catch (e) { return no(missing(e) ? q + ' is not in ' + where : q + ' cannot be read (' + ((e && e.code) || 'error') + ')'); }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return no(q + ' is not a file');
      if (st.size > maxBytes) return no(q + ' is ' + Math.round(st.size / (1024 * 1024)) + 'MB (limit ' + Math.round(maxBytes / (1024 * 1024)) + 'MB)');
      const again = await fsp.realpath(real);
      const now = await fsp.stat(again);
      if (fold(again) !== fold(real) || now.ino !== st.ino || now.dev !== st.dev) return no(q + ' changed while it was being read; nothing was sent');
      const buffer = await fh.readFile();
      if (!buffer.length && !allowEmpty) return no(q + ' is empty');
      return { ok: true, buffer, name: P.basename(real), mime: mimeFor(real), abs: real, shown };
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

  /* A routine fire's files: each agent's name is read through ITS run (the newest row of that agent in this fire, so
     its project root), the routine's own agent through the routine's folder when no row of it exists. No row's root is
     ever tried for another agent, and no second folder is probed for the same agent. runs: NEWEST first. */
  function fireReader(runs, ownAgentId, ownFolder) {
    const roots = new Map();
    for (const r of (Array.isArray(runs) ? runs : [])) if (r && r.agentId && !roots.has(String(r.agentId))) roots.set(String(r.agentId), String(r.projectRoot || ''));
    if (ownAgentId && !roots.has(String(ownAgentId))) roots.set(String(ownAgentId), ownFolder ? String(ownFolder) : '');
    return (aid, name) => readFor(aid, name, null, roots.get(String(aid)) || '');
  }

  return { read, readFor, fireReader, shownName, pathsFor };
}

module.exports = { makeEgressReader };
