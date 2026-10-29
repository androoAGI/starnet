/* sidecar/egress-files.js — the ONE reader for a file that LEAVES the station (run-paths lane, review S3, 2026-10-28).

   channel.send's `files`, a routine delivery's attachments and web_request's ${file:…} references all carry a file the
   agent names to somewhere outside the station. Each read it through the per-agent jail alone (fs.js resolveInside with
   no trust guard), while every other tool reads through the RUN's path object: so in a project run the name a tool
   handed the model (fs.write report.md, image_generate images/x.png -> project files; a screenshot, download or spill
   -> an absolute path into the private workspace) was refused, missed, or swapped for a stale same-named file in the
   private workspace, and a refused absolute receipt was quoted back into the chat.

   OWNER DECISION (2026-10-28): the name resolves through the PRODUCING run's path object, read scope — exactly what
   fs.read in that run would open. A run that can already read a file adds no reach by attaching it. Every containment
   check stays (resolve() re-runs path trust and the .env/.git floor on every target, and the symlink re-proof), there
   is NO fallback to a different same-named file in another folder, and a name that resolves nowhere is refused with a
   message that never quotes an absolute host path into a chat (shownName: the jail-relative form, else the file name).

   makeEgressReader({ fsp, pathMod, maxBytes, mimeFor, workspaces, guard }) -> {
     read(paths, name, { allowEmpty }?)        a name through THIS path object
     readFor(agentId, name, ctx?, projectRoot?, opts?)
                                               through the live run's ctx.paths (same agent), else a path object minted
                                               for a FINISHED run (its agent + its row's project root) under the
                                               unattended trust rule: guard(abs, { scope:'read', surface:'autonomous', agentId })
     fireReader(runs, ownAgentId, ownFolder)   (agentId, name) -> readFor: each agent of a routine fire through ITS run
     shownName(paths, name), pathsFor(agentId, ctx?, projectRoot?)
   }  read/readFor -> { ok:true, buffer, name, mime, abs, shown } | { ok:false, error, shown }   (never throw) */
'use strict';
const RunPaths = require('./run-paths.js');

function makeEgressReader(deps) {
  deps = deps || {};
  const fsp = deps.fsp, P = deps.pathMod || require('node:path');
  const maxBytes = Number(deps.maxBytes) > 0 ? Number(deps.maxBytes) : Infinity;
  const mimeFor = typeof deps.mimeFor === 'function' ? deps.mimeFor : () => '';
  const guard = typeof deps.guard === 'function' ? deps.guard : null;
  const absolute = s => P.win32.isAbsolute(s) || P.posix.isAbsolute(s) || /^[A-Za-z]:/.test(s);
  const fileName = s => String(s).split(/[\\/]/).filter(Boolean).pop() || 'file';

  // what a CHAT may be told about a name: a relative name as written, an absolute one inside the private workspace by
  // its jail-relative form, anything else only by its file name
  function shownName(paths, name) {
    const n = String(name == null ? '' : name).trim();
    if (!absolute(n)) return n;
    const rel = paths && typeof paths.unplaceJail === 'function' ? paths.unplaceJail(n) : null;
    return rel || fileName(n);
  }

  // opts.allowEmpty: an empty file is a legal request part (web_request); a chat upload refuses it
  async function read(paths, name, opts) {
    const allowEmpty = !!(opts && opts.allowEmpty);
    const n = String(name == null ? '' : name).trim();
    const shown = shownName(paths, n);
    if (!RunPaths.isRunPaths(paths)) return { ok: false, error: 'this run has no path object to resolve files with', shown };
    if (!n) return { ok: false, error: 'a file needs a path', shown };
    const where = paths.root ? 'this run\'s project folder' : 'your workspace';
    let abs;
    try { abs = (await paths.resolve(n, { scope: 'read' })).abs; }
    catch (e) { return { ok: false, error: (e && e.message) || 'that path cannot be read', shown }; }
    let st = null;
    try { st = await fsp.stat(abs); }
    catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { ok: false, error: '"' + shown + '" is not in ' + where + (absolute(n) ? '' : ' (a relative path means ' + where + ' in this run)'), shown };
      return { ok: false, error: (e && e.message) || 'stat failed', shown };
    }
    if (!st.isFile()) return { ok: false, error: 'not a file', shown };
    if (st.size > maxBytes) return { ok: false, error: 'file is ' + Math.round(st.size / (1024 * 1024)) + 'MB (limit ' + Math.round(maxBytes / (1024 * 1024)) + 'MB)', shown };
    let buffer;
    try { buffer = await fsp.readFile(abs); }
    catch (e) { return { ok: false, error: (e && e.message) || 'read failed', shown }; }
    if (!buffer.length && !allowEmpty) return { ok: false, error: 'file is empty', shown };
    return { ok: true, buffer, name: P.basename(abs), mime: mimeFor(abs), abs, shown };
  }

  // the PRODUCING run's path object: the live run's own (ctx.paths of this same agent), else one for a finished run
  function pathsFor(agentId, ctx, projectRoot) {
    const aid = String(agentId || '');
    if (ctx && RunPaths.isRunPaths(ctx.paths) && ctx.paths.agentId === aid) return ctx.paths;
    if (!deps.workspaces) throw new Error('egress reader has no workspaces root');
    const resolver = RunPaths.makeResolver({ fsp, pathMod: P, root: deps.workspaces,
      pathTrust: guard ? (abs) => guard(abs, { scope: 'read', surface: 'autonomous', agentId: aid }) : undefined });
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
