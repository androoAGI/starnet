/* sidecar/pathtrust.js — CONVERSATIONAL PATH TRUST (NS-5 Project Lens core).

   The fs.* tools are jailed to <workspaces>/<agentId>/ (fs.js resolveInside). This module is the ONE
   sanctioned way an fs tool call may reach a path OUTSIDE that jail: it resolves the referenced absolute
   path against a per-station set of BLESSED PROJECT ROOTS and, when the path is not yet under any blessed
   root, mediates a SINGLE consent decision ("work in <root>? always / once / no"). "always" records a
   standing PATH grant (dangerKey `path:<normalized-real-root>`) that the sidecar persists fail-closed and
   the existing /api/permissions surface lists + revokes. Reads flow once a root is blessed; writes stay
   consent-gated by the normal broker scope rules (this module only clears the path boundary, never the
   write-scope boundary).

   HARDLINES that no bless can cross (generalized from fs.js's jail + index.js hardlineFloor):
     • .env / .git internals anywhere in the path            (secret + repo-plumbing floor)
     • NUL bytes, UNC / network paths (\\server\share, //h)  (illegal / off-host)
     • symlink escape: the REAL (realpath-resolved) target must stay inside the blessed root's REAL path,
       re-proven on every access — a symlink planted under a blessed root cannot walk back out.

   THE UNATTENDED RULE (enforced here, not optional): only an INTERACTIVE run with a live prompt() may
   bless a NEW root. An autonomous run (surface !== 'interactive', or no prompt wired) that references an
   un-blessed outside path is a HARD DENY with NO prompt — silence is never consent, and a headless/cron
   run can never widen its own reach.

   makePathTrust({ fsp, pathMod, roots, bless, touch, isGitRepoOf, workspaceRoot, now, maxWalk }) -> { guard, detectRoot, normalizeRoot }
     fsp        : node:fs/promises (injected) — realpath / stat only, never writes.
     pathMod    : node:path (injected).
     roots      : () => [normalizedRealRoot...]  — the LIVE blessed set (index.js derives it from the
                  `path:*` grants, so a revoke takes effect on the very next call with no restart).
     bless      : async (rootReal, { isGitRepo, now }) => bool  — persist the standing grant + upsert the
                  known-projects store (persist-before-commit in index.js); false ⇒ deny (never committed).
     touch      : (rootReal, absPath, meta) => void  — bump lastTouchedAt on I/O under a known root (best-effort).
                  meta.user === true iff a USER-caused run did the I/O (guard o.userTouch, default: surface ===
                  'interactive'). The host bumps recency ONLY for user touches: the agent's own away work must
                  never keep its folder "most recently worked in" (the self-reinforcing night-focus loop, 2026-10-05).
     isGitRepoOf: async (rootReal) => bool  — light metadata for the store (has a .git entry).
     workspaceRoot: absolute parent of the private per-agent workspaces; standing grants and Full Access do
                  not override ownership beneath this root.
     now        : injected clock.
     maxWalk    : ancestor-walk cap for git-root detection (default 40).

   guard(absPath, { scope, surface, prompt, agentId }) -> { base, abs }   // throws on any deny
     scope   : 'read' | 'write' (write only reaches here AFTER the broker's own scope consent).
     surface : 'interactive' | 'autonomous'.
     prompt  : async (proposedRoot, { path, scope }) => 'always'|'once'|'full'|'deny'|...  (null ⇒ autonomous).

   Pure decision core over injected node deps (matches fs.js / permgrants.js). No env, no wall-clock. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).pathtrust = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makePathTrust(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod;
    if (!fsp || !P) throw new Error('pathtrust requires { fsp, pathMod }');
    const rootsFn = typeof deps.roots === 'function' ? deps.roots : (() => []);
    const bless = typeof deps.bless === 'function' ? deps.bless : null;
    const touch = typeof deps.touch === 'function' ? deps.touch : (() => {});
    const isGitRepoOf = typeof deps.isGitRepoOf === 'function' ? deps.isGitRepoOf : (async () => false);
    const workspaceRoot = deps.workspaceRoot ? P.resolve(String(deps.workspaceRoot)) : '';
    const now = typeof deps.now === 'function' ? deps.now : (() => null);
    const MAX_WALK = Number(deps.maxWalk) > 0 ? Number(deps.maxWalk) : 40;
    const isReservedWorkspaceId = typeof deps.isReservedWorkspaceId === 'function' ? deps.isReservedWorkspaceId
      : (typeof require === 'function' ? require('./workspace-reserved.js').isReservedWorkspaceId : (() => false));

    const winish = P.sep === '\\';
    function pathInside(abs, base) {
      let a = P.resolve(abs), b = P.resolve(base);
      if (winish) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a === b || a.indexOf(b + P.sep) === 0;
    }
    async function realpathOrSelf(p) {
      try { return await fsp.realpath(p); }
      catch (e) { throw new Error('cannot resolve filesystem path (possibly a dangling symlink): ' + p + ': ' + ((e && e.message) || e)); }
    }
    // realpath the DEEPEST existing ancestor of a (possibly not-yet-created) absolute path, so a symlink
    // anywhere along the real chain is resolved before the containment test (symlink-escape re-proof).
    async function realpathDeepest(abs) {
      let cur = P.resolve(abs);
      for (;;) {
        try { await fsp.lstat(cur); }
        catch (e) {
          if (!e || e.code !== 'ENOENT') throw e;
          const parent = P.dirname(cur);
          if (!parent || parent === cur) throw new Error('cannot resolve filesystem path: ' + abs);
          cur = parent;
          continue;
        }
        return realpathOrSelf(cur);
      }
    }

    // stable key for a root: realpath (canonical) — index.js stores this same string as `path:<root>`, so
    // the grant key, the projects-store key, and this comparison are ONE string. Case is left as realpath
    // returns it; pathInside is case-insensitive on win32, so any residual case difference still matches.
    function normalizeRoot(abs) { return P.resolve(String(abs == null ? '' : abs)); }

    // the unconditional floor — throws a reason if the path is illegal or protected regardless of any grant.
    function hardlineReason(rawAbs, resolvedAbs) {
      if (rawAbs.indexOf('\0') >= 0) return 'illegal path (NUL): ' + rawAbs;
      // UNC / network path — off-host, never blessable. Check the RAW string (P.resolve can mangle it).
      if (/^[\\/]{2}/.test(rawAbs)) return 'network paths (UNC) are not permitted: ' + rawAbs;
      const probe = resolvedAbs || rawAbs;
      if (/(^|[\\/])\.env(\.|$)/i.test(probe)) return 'reading ' + probe + ' is blocked by the protected-file floor (.env)';
      if (/(^|[\\/])\.git([\\/]|$)/i.test(probe)) return 'reading ' + probe + ' is blocked by the protected-file floor (.git)';
      return null;
    }

    // propose the project root to bless for a referenced path: the nearest ancestor that is a git repo
    // (natural project boundary), else the directory containing the file. Bounded ancestor walk.
    async function detectRoot(absPath) {
      const abs = P.resolve(absPath);
      let dir = P.dirname(abs);
      try { const st = await fsp.stat(abs); if (st.isDirectory()) dir = abs; } catch (_) {}
      let cur = dir;
      for (let i = 0; i < MAX_WALK; i++) {
        try { await fsp.stat(P.join(cur, '.git')); return cur; } catch (_) {}
        const parent = P.dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
      }
      return dir;
    }

    async function guard(absPath, o) {
      o = o || {};
      const scope = o.scope === 'write' ? 'write' : 'read';
      const surface = o.surface === 'interactive' ? 'interactive' : 'autonomous';
      const prompt = typeof o.prompt === 'function' ? o.prompt : null;
      const fullAccess = o.fullAccess === true;
      const unrestrictedHost = o.unrestrictedHost === true;
      // WHO caused this I/O, for recency metadata only (never an authority input): an explicit host-minted flag wins,
      // otherwise a watched interactive run is the user's and everything else is the agent's.
      const userTouch = (o.userTouch === true || o.userTouch === false) ? o.userTouch : surface === 'interactive';

      const raw = String(absPath == null ? '' : absPath);
      const norm = P.resolve(raw);
      // NUL and UNC are not local filesystem targets StarNet can pass to Node safely. Full Power removes
      // policy restrictions, not path syntax validity or the distinction between this computer and a share.
      if (raw.indexOf('\0') >= 0) throw new Error('illegal path (NUL): ' + raw);
      if (/^[\\/]{2}/.test(raw)) throw new Error('network paths (UNC) are not local computer paths: ' + raw);
      // Host-wide Full Power intentionally bypasses project blessings, protected-file policy, cross-agent
      // workspace ownership and symlink containment. The OS remains the authority on whether the path exists
      // and whether this user can read or write it.
      if (unrestrictedHost) {
        return { base: (P.parse(norm).root || P.dirname(norm)), abs: norm, unrestrictedHost: true };
      }
      const hr = hardlineReason(raw, norm);
      if (hr) throw new Error(hr);

      // REAL target (symlinks along the existing chain resolved) — the value every containment test uses.
      const real = await realpathDeepest(norm);
      /* AND THE FLOOR IS RE-PROVEN ON IT. The hardline above only ever saw the RAW and RESOLVED strings, so a
         symlink named innocently (notes.txt -> /proj/.env) sailed through: the name carries no `.env`, the
         real target does. Containment was already re-proven against `real`; the protected-file floor was not,
         which made a one-line symlink inside an ALREADY-blessed root a complete bypass of the .env/.git floor.
         Same function, same rules, now applied to what will actually be opened. */
      const rhr = hardlineReason(real, real);
      if (rhr) throw new Error(rhr + ' (reached via ' + norm + ')');

      // Agent workspaces are private jails, not station-global projects. A stale or accidentally-created
      // path:<WORKSPACES/alpha> grant must never let beta cross that boundary, and Full Access must not turn
      // the station's internal workspace tree into shared storage. Absolute paths into the caller's own
      // workspace remain usable; everything else under the workspace parent is denied before standing grants.
      if (workspaceRoot) {
        const workspaceReal = await realpathOrSelf(workspaceRoot);
        if (pathInside(real, workspaceReal)) {
          const agentId = String(o.agentId == null ? '' : o.agentId);
          // A station-owned directory (codex/, channels/, connectors/, plugins/ …) is never an agent's own
          // workspace, even for an agent whose id collides with it — those fall through to the deny below.
          if (/^[A-Za-z0-9_-]{1,40}$/.test(agentId) && !isReservedWorkspaceId(agentId)) {
            const ownReal = await realpathOrSelf(P.join(workspaceRoot, agentId));
            if (pathInside(real, ownReal)) return { base: ownReal, abs: norm };
          }
          throw new Error('path is inside another agent workspace and cannot be shared by a project grant: ' + norm);
        }
      }

      // 1. already under a blessed root? reads flow; the write-scope boundary is the broker's job upstream.
      for (const R of rootsFn()) {
        if (!R) continue;
        if (pathInside(real, R)) { touch(R, norm, { user: userTouch }); return { base: R, abs: norm }; }
      }

      // 2. not blessed. In ASK mode only a watched, prompt-wired run may approve a new root. Full Access is
      // already the operator's authority for every non-hardline path, so it must never manufacture a prompt.
      if (!fullAccess && (surface !== 'interactive' || !prompt))
        throw new Error('path is outside the agent workspace and no project root grant covers it: ' + norm +
          ' — an autonomous run cannot bless a new folder; grant it from a watched session first.');

      // 3. Resolve and re-prove the proposed project boundary before either Full Access or a live answer proceeds.
      const proposed = normalizeRoot(await detectRoot(norm));
      const phr = hardlineReason(proposed, proposed);
      if (phr) throw new Error(phr);
      const proposedReal = await realpathOrSelf(proposed);
      // the referenced target must actually live under the proposed root's REAL path (symlink re-proof).
      if (!pathInside(real, proposedReal))
        throw new Error('path escapes the proposed project root via symlink: ' + norm);

      // Full Access is live and revocable, so do not silently convert it into a permanent path grant. While the
      // posture remains full every access flows here without asking; revoking it restores the ordinary path card.
      if (fullAccess) return { base: proposedReal, abs: norm, fullAccess: true };

      /* BLESS THE REAL PATH. The header calls the grant key "realpath (canonical)", but normalizeRoot is only
         P.resolve — so a root reached through a symlinked ancestor (~/code -> /mnt/data/code, the ordinary
         way people arrange a dev box) was STORED un-canonical while step 1 above compares against the
         realpath. The two could never match, so "always" silently did nothing and the Commander was asked to
         bless the same folder on every single call — consent fatigue that trains people to click through the
         one prompt that widens the agent's filesystem reach. The PROMPT still names the path the Commander
         recognizes; only the recorded key is canonical. */
      const decision = await prompt(proposed, { path: norm, scope: scope });
      /* "always" AND "full" both RECORD the standing root grant. "full" used to fall through to the one-time
         branch below on the reasoning that "a directory bless is never a side effect of a blanket capability
         grant" — which is still true and still enforced, because this module does not interpret the agent's
         global approval posture. But that reasoning was applied to the wrong value: `decision` here is not leaked state,
         it is the Commander's DIRECT answer to a card that names THIS folder. Treating their strongest answer
         as weaker than "Always" meant clicking "Full access" recorded nothing, so the very next file touch in
         the same folder asked again — live-caught 2026-07-27: five reads in one project folder raised five
         identical cards while the user clicked "Full access" on every one. The strongest button was the only
         one that bought nothing. Same law the connector gate learned the same week: a card that offers a grade
         must have somewhere to WRITE it, or it is a lying card that trains click-through. */
      if (decision === 'always' || decision === 'full') {
        if (!bless) throw new Error('path trust is not wired to persist a grant — denied');
        const isGit = await isGitRepoOf(proposedReal);
        const ok = await bless(proposedReal, { isGitRepo: isGit, now: now() });
        if (!ok) throw new Error('could not persist project trust — denied: ' + proposed);
        touch(proposedReal, norm, { user: userTouch });
        return { base: proposedReal, abs: norm };
      }
      // "once": allow THIS access only, without persisting a root — the next access asks again, as promised.
      if (decision === 'once') return { base: proposedReal, abs: norm };
      throw new Error('access to ' + norm + ' was denied');
    }

    return { guard, detectRoot, normalizeRoot, _internals: { pathInside, realpathDeepest, hardlineReason } };
  }

  return { makePathTrust };
});
