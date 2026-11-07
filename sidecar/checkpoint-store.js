/* sidecar/checkpoint-store.js — the AMBIENT edge of the checkpoint rollback net (execution-spine Commit 1).

   The pure half (sidecar/checkpoint.js) owns the snapshot INDEX + rollback math; this file owns the actual
   content-addressed shadow store: a per-agent shadow GIT repo whose git-dir lives OUTSIDE the agent's fs jail
   (WORKSPACES/.checkpoints/<agentId>/git) with the agent's workspace (WORKSPACES/<agentId>) as its work-tree.
   `git add -A` + commit per snapshot gives content-addressing, dedup, and cheap restore for free with zero deps.
   Because the git-dir is a SIBLING of the jail (never inside WORKSPACES/<agentId>/), the agent's own fs.* and
   shell tools can neither read nor rewrite their own history.

   Every ambient dependency is INJECTED (fs, path, the git runner, the clock) so it is headless-testable with a
   real temp dir + real git + a fake clock; there is NO Date.now / Math.random / new Date() here (the snapshot id
   IS the git commit sha, content-derived, never minted), so it passes lint-determinism.js. core.autocrlf/safecrlf
   are forced off, and the shadow repo's own info/attributes turns off every conversion a .gitattributes in the work tree or
   the person's core.attributesFile asks for (pinAttributes), so an agent's files are stored and restored BYTE-EXACT (no
   line-ending mangling = no silent corruption; a row an older store wrote keeps the bytes it stored, and a rewind to one is refused where
   a conversion could have changed them: storedAsItIsRefusal). All git failures
   FAIL-OPEN (a snapshot/restore problem must never crash a run); the host decides whether a missing checkpoint should
   block a dangerous tool.

   makeCheckpointStore({ fs, pathMod, root, runGit, clock, keep?, scopeIdOf?, allowWorkTree?, maxRepoBytes?, maintenanceTimeoutMs? })
     -> { snapshot, restore, restoreDetailed, list, health, isValidId }
     runGit(args:string[], { cwd, timeoutMs? }) -> Promise<{ code:int|string, stdout, stderr }>   // resolves, never rejects
     snapshot(agentId, { runId, turn, label, workTree? }) -> Promise<{ id, created:bool, files, bytes } | null>   // null = NO restore point
     restore(agentId, snapshotId)              -> Promise<bool>   // only restores an id IN this agent's index
     restoreDetailed(agentId, snapshotId)      -> Promise<{ ok, reason?, detail?, preRestoreId?, links?, paths?, left? }>   // + the pre-restore undo id
     list(agentId)                             -> { version, snapshots }
     health(agentId)                           -> null | { ok, at, since, failures, lastFailure, roots }   // did each root's LAST snapshot attempt save one?
   A stale Git lock a killed checkpoint command left is cleared at the start of the next operation (clearStaleGitLocks).

   LINKS (lane checkpoint-links, review rounds 1-6). Git for Windows walks a junction as if it were a plain folder: `add -A`
   copied the files of a folder OUTSIDE the work tree into the shadow repo, a tracked folder swapped for a junction was
   re-read through it, and `reset --hard` then deleted (or wrote) the real files behind the link (probes A-F). Every
   capture now passes ONE boundary before Git reads the tree (prepareCapture): normal snapshots, restore's pre-restore
   capture and the size-ceiling re-init. It runs a bounded walk that never follows a link (scanTree), leaves every link
   out of Git's view (the shadow repo's info/exclude), drops what the shadow index still tracks at or below a link
   (`rm --cached`), and records the links on the result and the index row (`links`, `linksTotal`, sorted, so an unchanged
   tree dedups). Over its entry, depth or time budget the capture is skipped and health says why; it never hangs. The walk
   skips an EMBEDDED REPOSITORY (Git records it as a gitlink and never reads inside: nestedRepos) by a test STRICTER than
   Git's own (looksLikeRepo: it may enter a folder Git skips, a linked worktree or a `.git` link, never the reverse), so a
   cloned repo holding a link neither costs the budget nor makes Git refuse a link path below it. Restore's own check
   counts more folders as repositories than Git does (every folder holding a `.git` of any kind that the shadow index
   tracks no path below: review 6.2). restoreDetailed refuses, before anything is touched,
   when a path it would write or delete is a link or lies below one, or when the target holds a FILE where a folder with a
   link below it now is, at any depth, inside an ignored folder, an embedded repository or a real `.git` folder too, a
   `.git` that is itself a link counted (reset empties that folder through its links: replacedFolders) ('link_in_path',
   the link named). A rewind runs no `clean`, so `reset --hard` alone changes the tree (restoreDetailed, WHAT A REWIND
   REMOVES, states it in full): it deletes or replaces only files the pre-restore capture took (each in the undo row),
   removes the folders that leaves empty, and deletes an empty folder where the target holds a file. A link, a file no
   capture took (an ignored .env), an embedded repository and a `.git` are never deleted or replaced, whatever the
   target's .gitignore says. One at a path the target does not hold stays where it is (a `.git` link, or a link inside a
   plain `.git` folder, in a folder the target lacks too, never entered: a rewind that would delete a captured file in
   that folder is refused since undo review 2, repoOnPath, so the folder stays whole, holding its `.git`). One at a
   path the target holds or at a folder above one (an ignored `logs` file where it holds logs/, whatever the shadow index
   still tracks below that name: Git's ignore rules are asked alone, undo review 6), or at or below a folder the target
   holds as a FILE, refuses the rewind before anything is touched ('link_in_path'; 'uncaptured_in_path', round 6). So
   in a folder the walk did not enter (an ignored build/) a rewind deletes only captured files the target lacks, and
   the folder once that leaves it empty; where the target holds a FILE at or above it, the whole folder, only when all
   it holds is captured files and empty folders. A reset that left a file it was to delete (held open elsewhere) is an
   incomplete rewind, never ok.
   THE PROMISE (final review 2, undo reviews 1-12): a rewind is refused before anything is touched, with no undo row, or it
   completes and its preRestoreId restores every path and byte through restoreDetailed. Where the walk's own reading of
   what Git ignores, links or nests could differ from Git's, the rewind is REFUSED rather than Git modelled more closely:
   Git itself says which folders a plain rule of the work tree prunes (scanTree's opts.ignored: a folder Git reads is
   entered), and which folders holding a `.git` its index records or tracks paths below (nestedRepos, never from a
   listing the output limit cut off); a rewind that changes a .gitignore rule beyond one plain name, or that changes any
   rule beside a .gitignore holding a negation or a NUL byte, is refused (THE RULES A REWIND CHANGES, unfollowedRules);
   so is one that would write or delete below an embedded repository, whatever folders the reset makes on the way
   (repoOnPath), add or drop a gitlink at a folder holding files and no `.git` looksLikeRepo takes for a repository (a
   vendored clone, a linked worktree, a `.git` link: gitlinkOverFiles), record a gitlink where a FILE stands, at its
   path or at a folder above it (gitlinkOverFile), go to or from a tree that records a symbolic link (one a capture
   older than this lane took: symlinkRefusal) or a component of a Windows short name's shape, go where a tree or the work tree
   spells a name apart from another in a letter outside A-Z, which Git's fold reads as two and the file system or the walk's fold as one
   (namesReadApart, foldedTwoRefusal), go where a folder the checks list reads case apart (one WSL made, or one fsutil marked: Git reads two names
   in A-Z case apart as one there, and a .gitignore only by its exact name), unless the reset deletes all it holds, each spelled as it stands at
   every component, change what a folder holds that no name there can ask (one that holds nothing, or only names without a letter A-Z), unless
   the reset empties it or writes into an empty one its undo empties as written, below a folder its undo asks, leave a folder holding only
   names without such a letter where it held one with one, or the other way round, go by a spelling of a path that is not the disk's, or go where Git
   could leave part of a folder that no name would then ask, or stop partway, or while a file it deletes or writes over is in use, a program running
   from it among them (foldedTwoRefusal's CASE APART, WHAT GIT LEAVES and IN USE, undo reviews 9-12; two such names refuse every capture before its
   `add`, a rewind's too, so none stores or stages a file at its twin's length, wherever they stand but inside an embedded repository or a `.git`
   folder: prepareCapture), go to a row an older store wrote where a conversion could have changed its bytes (storedAsItIsRefusal),
   write or delete through a link (restoreLinkConflicts), or over what
   no capture took (restoreUncapturedConflicts: what Git's ignore rules exclude asked of the rules alone, never through
   an index that still tracks paths below a FILE's name, undo review 6, so such a file is refused or taken by name);
   and every listing and count its undo will need is taken before its commit, split under the output limit as the undo
   splits it (namesBothWays), the count exactly as the undo's walk will list (scanTree's afterReset: both walks skip the
   same repositories once those are refused) and the depth as its walk and its link check count it, or the rewind is
   refused. Deferred: wall time, and what another program opens after the checks (restore's THE UNDO ROW RESTORES THROUGH
   THIS API).
   SCOPE: the local shadow-git engine only. The SSH tar engine (environment.js createCheckpointRaw) states its own scope.
   RESIDUAL (out of scope, the run-paths threat model: containment guards tool paths and accidents, a hostile same-user
   shell is out): a folder swapped for a link in the moment between the walk and Git's own read of it is still followed
   (TOCTOU). Closing that needs a checkpoint-owned manifest and a native no-follow Windows adapter: Tier 2, lane
   "checkpoint-manifest", joined with the claims gap W2-link-junction-containment. */
'use strict';
(function (root, factory) {
  const cp = typeof require === 'function' ? require('./checkpoint.js') : (root.SK && root.SK.checkpoint);
  // durable single-file replace (fsync-before-rename); the injected-fs primitive degrades to writeFileSync+rename
  // for a test/in-memory fs without fsync, so it stays deterministic + testable.
  let dw = null;
  try { dw = typeof require === 'function' ? require('./durable-write.js') : (root.SK && root.SK.durableWrite); } catch (_) {}
  const api = factory(cp, dw && dw.writeFileDurable);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).checkpointStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cp, writeFileDurableInjected) {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  // fallback: if durable-write couldn't be loaded (browser bundle), do a plain atomic temp+rename.
  const writeFileDurable = typeof writeFileDurableInjected === 'function' ? writeFileDurableInjected
    : function (deps, file, data) { const f = deps.fs; const tmp = file + '.' + (typeof process !== 'undefined' ? process.pid : 'p') + '.tmp'; f.writeFileSync(tmp, data); f.renameSync(tmp, file); };

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;            // the notebook/fs-jail agentId grammar
  const SCOPE_RE = /^[a-f0-9]{16,64}$/;               // host-derived digest of one canonical project root
  const KEEP_DEFAULT = 50;                            // snapshots retained per agent (prune oldest beyond this)
  const MAX_REPO_BYTES_DEFAULT = 500 * 1024 * 1024;   // shadow-repo size ceiling (500MB) before a gc/re-init sweep
  const MAINTENANCE_GIT_TIMEOUT_MS = 120 * 1000;      // gc + the re-init add/commit: a big repo needs more than a snapshot's 15 s
  const MAINTENANCE_BACKOFF_MS = 30 * 60 * 1000;      // a pass that leaves the repo over the ceiling pauses automatic passes this long
  const FANOUT_RE = /^[0-9a-f]{2}$/;                  // objects/<2 hex>: loose objects, immutable once named
  const PACK_TEMP_RE = /^(tmp_|\.tmp-\d+-pack)/;      // pack-objects' tmp_pack_/tmp_idx_/tmp_rev_… and repack's .tmp-<pid>-pack-* outputs
  const LOOSE_TEMP_RE = /^tmp_obj_/;                  // a loose object still being written
  /* WHAT NO SNAPSHOT TAKES (turn identity commit 12, A17 iii): the agent's uploaded files (.attachments/) are the Commander's words from a chat,
     and a delete of that chat removes them from the workspace. `git add -A` would copy them into every shadow commit (kept for 50 snapshots,
     for an idle agent for ever), so the workspace repo's info/exclude names the directory: no new snapshot carries an attachment's bytes. */
  const EXCLUDE_LINES = ['.attachments/'];
  const SCAN_MAX_ENTRIES_DEFAULT = 250000;            // link walk: files + folders listed before a capture is skipped
  const SCAN_MAX_DEPTH_DEFAULT = 100;                 // link walk: folder nesting
  const SCAN_DEADLINE_MS_DEFAULT = 10 * 1000;         // link walk: wall time (the injected clock)
  const SCAN_CONCURRENCY = 8;                         // folders listed at once
  const LINKS_RECORDED_MAX = 32;                      // links named on a result / index row (linksTotal counts all)
  // a .gitignore line the walk may prune by: one plain name, optionally `/`-anchored or `**/`-prefixed, optionally `/`-ended
  // (a folder only)
  const PLAIN_IGNORE_RE = /^(\*\*\/)?(\/)?([A-Za-z0-9._-]+)(\/)?$/;
  const EXCLUDE_HEADER = '# StarNet checkpoints: links (junctions, symbolic links, mount points) left out of restore points,\n'
    + '# and, for a rewind\'s own capture, the folders only the restore point\'s .gitignore files exclude.\n'
    + '# Rewritten before every capture (sidecar/checkpoint-store.js prepareCapture).\n';

  function makeCheckpointStore(deps) {
    const d = deps || {};
    const fs = d.fs, pathMod = d.pathMod, root = d.root, runGit = d.runGit;
    const clock = d.clock || { now: function () { return 0; } };
    const scopeIdOf = typeof d.scopeIdOf === 'function' ? d.scopeIdOf : null;
    const allowWorkTree = typeof d.allowWorkTree === 'function' ? d.allowWorkTree : function () { return false; };
    const keep = d.keep != null ? d.keep : KEEP_DEFAULT;
    const maxRepoBytes = d.maxRepoBytes != null ? d.maxRepoBytes : MAX_REPO_BYTES_DEFAULT;
    // per-call bound for gc and the re-init add/commit (injectable so a test can kill a real gc mid-repack)
    const maintenanceTimeoutMs = d.maintenanceTimeoutMs > 0 ? d.maintenanceTimeoutMs : MAINTENANCE_GIT_TIMEOUT_MS;
    // the link walk's budget (injectable so a test can trip each bound on a small synthetic tree)
    const scanLimits = {
      maxEntries: d.scanMaxEntries > 0 ? d.scanMaxEntries : SCAN_MAX_ENTRIES_DEFAULT,
      maxDepth: d.scanMaxDepth > 0 ? d.scanMaxDepth : SCAN_MAX_DEPTH_DEFAULT,
      deadlineMs: d.scanDeadlineMs > 0 ? d.scanDeadlineMs : SCAN_DEADLINE_MS_DEFAULT
    };
    const scanClock = d.scanClock && typeof d.scanClock.now === 'function' ? d.scanClock : clock;
    if (!fs || !pathMod || !root || typeof runGit !== 'function') throw new Error('checkpoint-store: fs/pathMod/root/runGit are required');

    // All roots for one agent share index.json. Serialize whole operations, not individual Git calls,
    // so a restore, rebuild or size sweep cannot race a snapshot (or lose another root's index row).
    const pending = new Map();
    function serialized(fn) {
      return function (aid, ...args) {
        const key = String(aid || '');
        const previous = pending.get(key) || Promise.resolve();
        const result = previous.catch(function () {}).then(function () { return fn(aid, ...args); });
        const tail = result.catch(function () {});
        pending.set(key, tail);
        tail.then(function () { if (pending.get(key) === tail) pending.delete(key); });
        return result;
      };
    }

    const defaultWorkTreeFor = (aid) => pathMod.join(root, aid);
    const scopeBaseFor = (aid, scopeId) => scopeId
      ? pathMod.join(root, '.checkpoints', aid, 'roots', scopeId)
      : pathMod.join(root, '.checkpoints', aid);
    const gitDirFor = (aid, scope) => pathMod.join(scopeBaseFor(aid, scope && scope.id), 'git');
    const workTreeFor = (aid, scope) => (scope && scope.workTree) || defaultWorkTreeFor(aid);
    const indexFileFor = (aid) => pathMod.join(root, '.checkpoints', aid, 'index.json');
    const scopeFileFor = (aid, scopeId) => pathMod.join(scopeBaseFor(aid, scopeId), 'scope.json');

    function samePath(a, b) {
      let x = pathMod.resolve(String(a || '')), y = pathMod.resolve(String(b || ''));
      if (pathMod.sep === '\\') { x = x.toLowerCase(); y = y.toLowerCase(); }
      return x === y;
    }
    function canonicalWorkTree(p) {
      let out = pathMod.resolve(String(p || ''));
      try { if (typeof fs.realpathSync === 'function') out = fs.realpathSync(out); } catch (_) {}
      return out;
    }
    function externalScope(aid, requested, authorized) {
      if (!requested) return { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      const workTree = canonicalWorkTree(requested);
      if (samePath(workTree, defaultWorkTreeFor(aid))) return { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      if (!scopeIdOf || (authorized !== true && allowWorkTree(workTree, aid) !== true)) return null;
      const id = String(scopeIdOf(workTree) || '').toLowerCase();
      if (!SCOPE_RE.test(id)) return null;
      return { id: id, workTree: workTree, prefix: id + ':' };
    }
    function readScopeSaved(aid, scopeId) {
      if (!scopeId) return { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      if (!SCOPE_RE.test(String(scopeId || ''))) return null;
      try {
        const saved = JSON.parse(fs.readFileSync(scopeFileFor(aid, scopeId), 'utf8'));
        if (!saved || saved.scopeId !== scopeId || !saved.workTree) return null;
        const workTree = canonicalWorkTree(saved.workTree);
        if (!samePath(workTree, saved.workTree)) return null;
        return { id: scopeId, workTree: workTree, prefix: scopeId + ':' };
      } catch (_) { return null; }
    }
    function readScope(aid, scopeId) {
      const scope = readScopeSaved(aid, scopeId);
      return scope && allowWorkTree(scope.workTree, aid) === true ? scope : null;
    }
    function saveScope(aid, scope) {
      if (!scope || !scope.id) return true;
      const file = scopeFileFor(aid, scope.id);
      try {
        const prior = readScopeSaved(aid, scope.id);
        if (prior) return samePath(prior.workTree, scope.workTree);
        fs.mkdirSync(pathMod.dirname(file), { recursive: true });
        writeFileDurable({ fs: fs, path: pathMod }, file, JSON.stringify({ version: 1, scopeId: scope.id, workTree: scope.workTree }));
        return true;
      } catch (_) { return false; }
    }

    /* pinnedConfig — what the person's own Git config must not change in a shadow repo's calls: byte-exact (core.autocrlf,
       core.safecrlf; the rest of what converts is the shadow repo's info/attributes: pinAttributes), identity-stable commits, no
       background Git, and (undo review 7) the settings found to let a global config reach the person's files or hide them:
       submodule.recurse (with submodule.active, reset --hard ran in an embedded repository: its uncommitted edit gone, its
       .git moved into the shadow repo), core.ignoreStat and core.fsmonitor (a capture that does not look at a tracked file:
       the reset wrote the target over an edit no row held, ok:true) and core.hooksPath, a folder nothing ever makes (the person's
       hooks ran on the shadow repo's index and refs, one of them writing in the work tree); and (undo review 8) each hook the person's config
       names, which core.hooksPath does not reach, switched off by name (readPersonalConfig). */
    const personalConfig = new Map();                   // git-dir -> { off: ['-c', 'hook.<name>.enabled=false', ...], attributesFile: bool }: readPersonalConfig
    const pinnedConfig = (gitDir) => ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
      '-c', 'submodule.recurse=false', '-c', 'core.ignoreStat=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + pathMod.join(gitDir, 'no-hooks'),
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'gc.autoDetach=false',
      '-c', 'user.email=starnet@local', '-c', 'user.name=starnet'].concat((personalConfig.get(gitDir) || { off: [] }).off);
    // the leading git args that pin the shadow git-dir + work-tree, then pinnedConfig
    function base(aid, scope) {
      return ['--git-dir', gitDirFor(aid, scope), '--work-tree', workTreeFor(aid, scope)].concat(pinnedConfig(gitDirFor(aid, scope)));
    }
    // timeoutMs (optional): a per-call bound for the slow maintenance commands; a snapshot's own calls keep the runner default.
    const git = (aid, scope, args, timeoutMs) => runGit(base(aid, scope).concat(args),
      timeoutMs ? { cwd: workTreeFor(aid, scope), timeoutMs: timeoutMs } : { cwd: workTreeFor(aid, scope) });

    // read the index file into a tagged result so the caller can distinguish a genuinely-empty index (no
    // snapshots recorded) from a torn/corrupt one that should trigger a git-log rebuild.
    //   { status:'ok', index }   — parsed to a non-empty index
    //   { status:'empty' }       — parsed but zero snapshots (or a legitimately empty index)
    //   { status:'corrupt' }     — file present but unparseable / absent
    function readIndexRaw(aid) {
      let raw;
      try { raw = fs.readFileSync(indexFileFor(aid), 'utf8'); }
      catch (e) {
        // ENOENT alone means "no index" (recovery/rebuild allowed). Any OTHER errno is a TRANSIENT read
        // failure (AV/backup software holding the file, fd exhaustion) — the durable-store law: conflating
        // it with absent let the LOSSY git rebuild (runId/turn are not recoverable from git) overwrite a
        // perfectly good index the moment one read hiccuped, permanently killing rollback-by-run.
        return { status: (e && e.code === 'ENOENT') ? 'corrupt' : 'unreadable' };
      }
      if (raw == null || String(raw).length === 0) return { status: 'corrupt' };   // torn write
      let obj; try { obj = JSON.parse(raw); } catch (e) { return { status: 'corrupt' }; }
      const idx = cp.loadIndex(obj);
      return idx.snapshots.length ? { status: 'ok', index: idx } : { status: 'empty', index: idx };
    }
    // SYNC load: main index file, else its <file>.bak last-known-good, else empty. Never rebuilds (git is async).
    // Callers that CAN await use loadIndexResilient below to rebuild from the commit history when both are gone.
    function loadIndex(aid) {
      const m = readIndexRaw(aid);
      if (m.status === 'ok' || m.status === 'empty') return m.index;
      // main torn/corrupt/absent -> try the .bak snapshot.
      try {
        const braw = fs.readFileSync(indexFileFor(aid) + '.bak', 'utf8');
        if (braw && String(braw).length) { const b = cp.loadIndex(JSON.parse(braw)); if (b.snapshots.length) return b; }
      } catch (_) {}
      return cp.toIndex([]);                           // missing/corrupt + no .bak -> empty (fail-closed)
    }
    function saveIndex(aid, index) {                  // atomic + durable temp+rename with a .bak snapshot; throws on failure (the caller fail-opens)
      const f = indexFileFor(aid);
      fs.mkdirSync(pathMod.dirname(f), { recursive: true });
      // snapshot the current clean index to <file>.bak (durably) before overwriting, so a torn replace of the
      // index can be recovered from the prior committed copy. Best-effort — a .bak failure never blocks the save.
      try {
        const cur = fs.readFileSync(f, 'utf8');
        if (cur && String(cur).length) { try { JSON.parse(cur); writeFileDurable({ fs: fs, path: pathMod }, f + '.bak', cur); } catch (_) {} }
      } catch (_) {}
      writeFileDurable({ fs: fs, path: pathMod }, f, JSON.stringify(cp.toIndex(index.snapshots)));
    }

    /* ensureExclude(scope, gitDir) - the workspace repo (the agent's own folder: scope.id '') ignores EXCLUDE_LINES. A project root is the
       Commander's own folder and is left as it is. Written at init and again on the first open of an older repo (idempotent). -> true when it
       had to add a line (the repo may then still TRACK files from before: the caller untracks them). */
    function ensureExclude(scope, gitDir) {
      if (scope && scope.id) return false;
      const file = pathMod.join(gitDir, 'info', 'exclude');
      let cur = '';
      try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') failNote('checkpoint.exclude.read', e); }
      const have = new Set(cur.split(/\r?\n/).map(function (l) { return l.trim(); }));
      const add = EXCLUDE_LINES.filter(function (l) { return !have.has(l); });
      if (!add.length) return false;
      fs.mkdirSync(pathMod.dirname(file), { recursive: true });
      fs.writeFileSync(file, cur + (cur && !/\n$/.test(cur) ? '\n' : '') + add.join('\n') + '\n');
      return true;
    }

    // does this agent have a real shadow git repo on disk? (its commits are the ground truth for a rebuild.)
    function repoExists(aid, scope) {
      try { return fs.existsSync(pathMod.join(gitDirFor(aid, scope), 'HEAD')); } catch (_) { return false; }
    }
    function recordedScopes(aid) {
      const scopes = [{ id: '', workTree: defaultWorkTreeFor(aid), prefix: '' }];
      let names = [];
      try { names = fs.readdirSync(pathMod.join(root, '.checkpoints', aid, 'roots')); } catch (_) {}
      for (const name of names) {
        // Rebuilding the index reads only the station-owned shadow git + scope metadata. Keep revoked roots in
        // the list as unavailable restore points; do not erase their recoverable history just because authority
        // is currently absent. Actual restore still re-checks readScope() and fails closed.
        const scope = readScopeSaved(aid, String(name));
        if (scope) scopes.push(scope);
      }
      return scopes;
    }
    /* rebuildIndexFromGit — the shadow git COMMITS are the truth; the index.json is just a cache of them. When
       the index is empty/corrupt but the repo has commits, reconstruct the index by walking `git log`. The
       commit subject is what snapshot() wrote as `label`; runId/turn aren't recoverable from git, so they come
       back empty/0 (rollback-by-run degrades, but per-id restore + the list view are fully restored). Oldest-
       first so lineage (parentId defaults to the prior snapshot) threads correctly through cp.record. */
    async function rebuildIndexFromGit(aid) {
      const rows = [];
      for (const scope of recordedScopes(aid)) {
        if (!repoExists(aid, scope)) continue;
        // %H = full sha, %ct = committer unix seconds, %s = subject. Cross-root rows are sorted by timestamp
        // below, while parentId remains scoped to the prior commit in this exact root.
        const r = await git(aid, scope, ['log', '--reverse', '--format=%H%x09%ct%x09%s']);
        if (!r || r.code !== 0 || !r.stdout) continue;
        for (const line of r.stdout.split('\n')) rows.push({ line: line, scope: scope });
      }
      if (!rows.length) return cp.toIndex([]);
      const parsed = [];
      for (const row of rows) {
        const line = row.line;
        if (!line.trim()) continue;
        const tab1 = line.indexOf('\t'); if (tab1 < 0) continue;
        const tab2 = line.indexOf('\t', tab1 + 1);
        const sha = line.slice(0, tab1).trim();
        const ctSec = Number(line.slice(tab1 + 1, tab2 < 0 ? undefined : tab2).trim());
        const label = tab2 < 0 ? '' : line.slice(tab2 + 1);
        if (!cp.isValidId(sha)) continue;
        parsed.push({ sha: sha, ts: isFinite(ctSec) ? ctSec * 1000 : clock.now(), label: label, scope: row.scope });
      }
      parsed.sort(function (a, b) { return a.ts - b.ts; });
      let index = cp.toIndex([]);
      const heads = {};
      for (const row of parsed) {
        const fullId = row.scope.prefix + row.sha;
        try {
          index = cp.record(index, {
            id: fullId, runId: '', turn: 0, label: row.label, files: 0, bytes: 0,
            parentId: heads[row.scope.id] || null, scopeId: row.scope.id,
            workTree: row.scope.id ? row.scope.workTree : '', gitCommit: row.sha
          }, { now: row.ts, keep: keep });
          heads[row.scope.id] = fullId;
        } catch (_) { /* skip a record git surfaced that cp rejects */ }
      }
      return index;
    }
    /* loadIndexResilient — the ASYNC load: the sync index/.bak first, and if BOTH are gone/empty while the
       shadow repo still holds commits, rebuild the index from git and RE-PERSIST it so subsequent sync reads
       are fast again. Used by every await-capable caller (snapshot/restore/the list route). */
    async function loadIndexResilient(aid) {
      const m = readIndexRaw(aid);
      if (m.status === 'ok') return m.index;
      // TRANSIENT read failure: serve .bak/empty for THIS pass and never rebuild — the rebuild's
      // re-persist would overwrite the (still intact) index with the lossy git reconstruction.
      if (m.status === 'unreadable') return loadIndex(aid);
      // main empty/corrupt -> try .bak (sync), then git rebuild.
      const viaBak = loadIndex(aid);                   // consults main + .bak
      if (viaBak.snapshots.length) return viaBak;
      const rebuilt = await rebuildIndexFromGit(aid);
      if (rebuilt.snapshots.length) {
        try { saveIndex(aid, rebuilt); } catch (e) { failNote('checkpoint.index.persist', e); }
        try { console.warn('[checkpoint] rebuilt index for ' + aid + ' from ' + rebuilt.snapshots.length + ' shadow-git commits (index.json was empty/corrupt)'); } catch (_) {}
        return rebuilt;
      }
      return m.status === 'empty' ? m.index : cp.toIndex([]);
    }

    /* measure — best-effort size of the snapshot (cosmetic, for the event): tracked file count + summed bytes of the
       commit just recorded. Git answers both from the commit's tree in ONE child process (`ls-tree -r`, blob sizes from
       the object headers). It used to `ls-files` and then fs.statSync every tracked file one at a time on the sidecar's
       only thread — ~130 µs per stat on Windows, 0.9-2 s of frozen streams per snapshot on a mid-size project (perf
       review #9, the same stall repoBytes already left behind in #107). core.autocrlf is off and the shadow repo has
       no filters, so a blob's size IS the file's byte size at commit time. `--format` needs Git 2.36+; an older Git
       falls back to `-l` (same numbers, longer lines). A gitlink has no blob size and counts 0 bytes. */
    function sumTreeSizes(stdout, long) {
      let files = 0, bytes = 0;
      for (const entry of String(stdout || '').split('\0')) {
        if (!entry) continue;
        files++;
        const meta = long ? entry.slice(0, Math.max(0, entry.indexOf('\t'))) : entry;
        const size = Number(meta.trim().split(/\s+/).pop());
        if (isFinite(size) && size > 0) bytes += size;
      }
      return { files: files, bytes: bytes };
    }
    async function measure(aid, scope, commit) {
      const rev = cp.isValidId(commit) ? commit : 'HEAD';
      try {
        const r = await git(aid, scope, ['ls-tree', '-r', '-z', '--format=%(objectsize)', rev]);
        if (r.code === 0) return sumTreeSizes(r.stdout, false);
        const l = await git(aid, scope, ['ls-tree', '-r', '-z', '-l', rev]);
        if (l.code === 0) return sumTreeSizes(l.stdout, true);
        return { files: 0, bytes: 0 };
      } catch (e) { return { files: 0, bytes: 0 }; }
    }

    /* repoBytes — the shadow repo's on-disk size, measured ASYNC and incrementally (#107 residual). The old walk was
       synchronous and stat-ed every file on every snapshot; with gc.auto=0 loose objects are only packed past the
       ceiling, so it was an event-loop stall that grew with history. Loose objects (objects/<2 hex>/) are immutable
       once named: git writes a temp file and renames it into place, and a temp file a killed command left never grows
       again, because no checkpoint Git runs while this measures (it runs under the per-agent lock). So a fan-out
       directory whose file NAMES are unchanged since the last measure keeps its byte total without one stat per
       object. Everything else (packs, index, refs, the append-only reflogs, commit-graph) is small and is always
       re-statted. Best effort: an entry that vanished or cannot be read counts 0, and its directory is not memoized. */
    const fsp = fs.promises || null;
    const looseDirBytes = new Map();   // fan-out dir path -> { sig, bytes }
    function nameSignature(names) {    // order-independent: count + sum of FNV-1a hashes of the names
      let sum = 0;
      for (const n of names) {
        let h = 2166136261;
        for (let i = 0; i < n.length; i++) { h ^= n.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        sum = (sum + h) >>> 0;
      }
      return names.length + ':' + sum;
    }
    async function listDir(dir) { return fsp ? fsp.readdir(dir, { withFileTypes: true }) : fs.readdirSync(dir, { withFileTypes: true }); }
    async function fileSize(file) { return (fsp ? await fsp.stat(file) : fs.statSync(file)).size; }
    async function walkBytes(dir, objectsDir, looseDir) {
      let entries;
      try { entries = await listDir(dir); }
      catch (e) { looseDirBytes.delete(dir); return 0; }
      const files = [];
      let total = 0;
      for (const ent of entries) {
        if (!ent.isDirectory()) { files.push(ent.name); continue; }
        const sub = await walkBytes(pathMod.join(dir, ent.name), objectsDir, dir === objectsDir && FANOUT_RE.test(ent.name));
        total += sub;
      }
      const sig = looseDir ? nameSignature(files) : '';
      const memo = looseDir ? looseDirBytes.get(dir) : null;
      if (memo && memo.sig === sig) return total + memo.bytes;
      let bytes = 0, unreadable = 0;
      // concurrent stats: read each size first, THEN add (`bytes += await …` would read bytes before the await
      // and every concurrent callback would overwrite the others' sums)
      await Promise.all(files.map(async function (name) {
        let size = 0;
        try { size = await fileSize(pathMod.join(dir, name)); } catch (e) { unreadable++; }
        bytes += size;
      }));
      if (looseDir) {
        if (unreadable) looseDirBytes.delete(dir);
        else looseDirBytes.set(dir, { sig: sig, bytes: bytes });
      }
      return total + bytes;
    }
    const repoBytes = (gitDir) => walkBytes(gitDir, pathMod.join(gitDir, 'objects'), false);

    /* sweepGitTemporaries — remove what a killed or failed git leaves in the object store: pack-objects' tmp_pack_*,
       tmp_idx_* (and its other tmp_* outputs), repack's renamed .tmp-<pid>-pack-* files, and tmp_obj_* loose-object
       temps. It runs right after a gc attempt, inside the per-agent serialized() lock: every checkpoint Git command
       for this agent runs under that lock, gc.auto=0 / maintenance.auto=false start no background git, and a timeout
       or abort kills the whole process tree before the runner resolves, so no live git can own one of these names.
       A gc killed at its bound prunes nothing, which is how #107 piled a tmp_pack up every turn; a successful gc
       prunes tmp_* itself but never another process's .tmp-<pid>-pack-* (checked on git 2.54). Only those temp names
       are touched: pack-*.pack/.idx/.keep, loose objects, refs and the index never match. Best effort: a file that
       cannot be removed (EBUSY from AV/backup) is skipped and noted. */
    async function sweepGitTemporaries(gitDir) {
      const objectsDir = pathMod.join(gitDir, 'objects'), packDir = pathMod.join(objectsDir, 'pack');
      const listed = async function (dir) { try { return await listDir(dir); } catch (e) { return []; } };
      const victims = [];
      for (const ent of await listed(packDir)) if (ent.isFile() && PACK_TEMP_RE.test(ent.name)) victims.push(pathMod.join(packDir, ent.name));
      for (const ent of await listed(objectsDir)) {
        if (ent.isFile() && LOOSE_TEMP_RE.test(ent.name)) victims.push(pathMod.join(objectsDir, ent.name));
        else if (ent.isDirectory() && FANOUT_RE.test(ent.name)) {
          const sub = pathMod.join(objectsDir, ent.name);
          for (const f of await listed(sub)) if (f.isFile() && LOOSE_TEMP_RE.test(f.name)) victims.push(pathMod.join(sub, f.name));
        }
      }
      let removed = 0, skipped = 0;
      for (const file of victims) {
        try { if (fsp) await fsp.unlink(file); else fs.unlinkSync(file); removed++; }
        catch (e) { if (!(e && e.code === 'ENOENT')) { skipped++; failNote('checkpoint.gc.leftover', e); } }
      }
      return { removed: removed, skipped: skipped };
    }

    /* clearStaleGitLocks — remove the lock files a killed checkpoint Git command leaves in THIS store's shadow repo.
       A snapshot's `git add -A` killed at its bound (the first snapshot of a big workspace) leaves index.lock; Git
       then refuses every later add for that agent ("Unable to create index.lock: File exists"), so every later
       snapshot returned null and the undo net stayed silently dead until an over-ceiling re-init replaced the repo.
       A killed commit/reset leaves HEAD.lock, ORIG_HEAD.lock or refs/heads/<branch>.lock the same way; a killed gc
       leaves packed-refs.lock, the commit-graph locks, gc.pid, and (killed in its `reflog expire` step) logs/HEAD.lock or
       logs/refs/heads/<branch>.lock, which made every later gc fail until a re-init replaced the repo.
       Safe because it runs at the start of an operation INSIDE the per-agent serialized() section: every checkpoint
       Git command for this agent runs under that lock, gc.auto=0 / maintenance.auto=false start no background Git,
       a timed-out or aborted command's whole process tree is dead before the runner resolves, and one sidecar owns
       a WORKSPACES dir (a crashed predecessor's ledgered Git children are killed by the boot orphan sweep). So no
       live Git can own one of these files. Only the shadow git-dir under <root>/.checkpoints is ever looked at:
       the work tree may be the user's own project with its own .git, and that repo is never touched. Only FILES
       are removed (never a directory, never anything recursive), and only lock names and gc.pid. Noted once per
       sweep; a lock that cannot be removed (EBUSY from AV/backup) is skipped and noted, and the Git command after
       it then fails into health() instead of being reported as a restore point. */
    const LOCK_FILE_RE = /\.lock$/;
    function insideShadowStore(gitDir) {
      let dir = pathMod.resolve(String(gitDir || '')), store = pathMod.resolve(pathMod.join(root, '.checkpoints'));
      if (pathMod.sep === '\\') { dir = dir.toLowerCase(); store = store.toLowerCase(); }
      return dir.indexOf(store + pathMod.sep) === 0;
    }
    async function clearStaleGitLocks(aid, gitDir) {
      if (!insideShadowStore(gitDir)) return { removed: 0, skipped: 0 };
      const listed = async function (dir) { try { return await listDir(dir); } catch (e) { return []; } };
      const victims = [];
      const take = function (dir, ent, alsoGcPid) {
        if (ent.isFile() && (LOCK_FILE_RE.test(ent.name) || (alsoGcPid && ent.name === 'gc.pid'))) victims.push(pathMod.join(dir, ent.name));
      };
      const walk = async function (dir, depth) {   // refs/** and objects/info/**: small trees, bounded depth
        for (const ent of await listed(dir)) {
          if (ent.isDirectory()) { if (depth < 6) await walk(pathMod.join(dir, ent.name), depth + 1); }
          else take(dir, ent, false);
        }
      };
      for (const ent of await listed(gitDir)) take(gitDir, ent, true);   // index/HEAD/ORIG_HEAD/config/packed-refs.lock, gc.pid
      await walk(pathMod.join(gitDir, 'refs'), 0);                          // refs/heads/<branch>.lock
      await walk(pathMod.join(gitDir, 'logs'), 0);                          // logs/HEAD.lock, logs/refs/heads/<branch>.lock (a gc killed in reflog expire)
      await walk(pathMod.join(gitDir, 'objects', 'info'), 0);               // commit-graph.lock, commit-graphs/commit-graph-chain.lock
      const packDir = pathMod.join(gitDir, 'objects', 'pack');
      for (const ent of await listed(packDir)) take(packDir, ent, false);   // multi-pack-index.lock
      const removed = [];
      let skipped = 0;
      for (const file of victims) {
        try { if (fsp) await fsp.unlink(file); else fs.unlinkSync(file); removed.push(pathMod.relative(gitDir, file)); }
        catch (e) { if (!(e && e.code === 'ENOENT')) { skipped++; failNote('checkpoint.staleLock.remove', e); } }
      }
      if (removed.length) failNote('checkpoint.staleLock', new Error('removed ' + removed.length + ' stale Git lock file(s) an interrupted checkpoint command left in ' + aid + '\'s shadow repo: ' + removed.join(', ')));
      return { removed: removed.length, skipped: skipped };
    }

    /* HEALTH — whether the LAST snapshot attempt of each of this agent's ROOTS actually produced a restore point.
       snapshot() is fail-open (null, and the run goes on), so without this a dead net looked exactly like a working
       one: the RESTORE lane kept saying a point is saved before every command while none was. Kept per root because
       every root has its own shadow repo: a project root whose `add` fails every turn (an IDE holding one of its
       files) must not read as saving because the agent's own workspace saved a point in the same run. In memory, per
       process: null until the first attempt (unknown is never reported as ok).
         health(agentId) -> null | { ok, at, since, failures, lastFailure: { at, reason, kind, workTree, scopeId } | null,
                                     roots: [{ kind, workTree, scopeId, ok, at, since, failures, lastFailure: { at, reason } | null }] }
       ok = every root's latest attempt saved; since = the earliest start of a current failing streak (null while ok);
       failures = failed attempts since boot, all roots; lastFailure = the newest failure of a root that is failing now
       (while ok: the newest one on record). kind is 'workspace' (workTree '') or 'project' (workTree = its canonical
       root, the path its restore rows already show; scopeId '' when the root was never authorized). */
    const MAX_HEALTH_ROOTS = 32;   // per agent; only roots whose latest attempt SAVED are ever evicted (an alarm is never dropped)
    const healthByAgent = new Map();   // aid -> Map(rootKey -> record), least recently attempted first
    function healthRootFor(aid, scope, requested) {
      if (scope && !scope.id) return { key: '', kind: 'workspace', workTree: '', scopeId: '' };
      const workTree = scope ? scope.workTree : canonicalWorkTree(requested);
      const key = pathMod.sep === '\\' ? String(workTree).toLowerCase() : String(workTree);
      return { key: 'project\0' + key, kind: 'project', workTree: workTree, scopeId: scope ? scope.id : '' };
    }
    function recordHealth(aid, root, ok, reason) {
      let roots = healthByAgent.get(aid);
      if (!roots) { roots = new Map(); healthByAgent.set(aid, roots); }
      const prev = roots.get(root.key) || { ok: null, failures: 0, since: null, lastFailure: null };
      const at = clock.now();
      const rec = ok ? { ok: true, at: at, since: null, failures: prev.failures, lastFailure: prev.lastFailure }
        : { ok: false, at: at, since: prev.ok === false && prev.since != null ? prev.since : at,
          failures: prev.failures + 1, lastFailure: { at: at, reason: String(reason || 'the restore point could not be saved') } };
      rec.kind = root.kind; rec.workTree = root.workTree; rec.scopeId = root.scopeId;
      roots.delete(root.key); roots.set(root.key, rec);
      for (const [key, r] of roots) { if (roots.size <= MAX_HEALTH_ROOTS) break; if (r.ok === true) roots.delete(key); }
    }
    function health(agentId) {
      if (!AID_RE.test(String(agentId || ''))) return null;
      const roots = healthByAgent.get(String(agentId));
      if (!roots || !roots.size) return null;
      const all = Array.from(roots.values());
      const failing = all.filter(function (r) { return r.ok === false; });
      let lead = null, since = null, at = null, failures = 0;
      for (const r of (failing.length ? failing : all)) if (r.lastFailure && (!lead || r.lastFailure.at >= lead.lastFailure.at)) lead = r;
      for (const r of all) {
        failures += r.failures;
        if (at == null || r.at > at) at = r.at;
        if (r.ok === false && (since == null || r.since < since)) since = r.since;
      }
      const order = function (a, b) { return a.kind === b.kind ? (a.workTree < b.workTree ? -1 : a.workTree > b.workTree ? 1 : 0) : (a.kind === 'workspace' ? -1 : 1); };
      return { ok: !failing.length, at: at, since: since, failures: failures,
        lastFailure: lead ? { at: lead.lastFailure.at, reason: lead.lastFailure.reason, kind: lead.kind, workTree: lead.workTree, scopeId: lead.scopeId } : null,
        roots: all.slice().sort(order).map(function (r) {
          return { kind: r.kind, workTree: r.workTree, scopeId: r.scopeId, ok: r.ok, at: r.at, since: r.since, failures: r.failures,
            lastFailure: r.lastFailure ? { at: r.lastFailure.at, reason: r.lastFailure.reason } : null };
        }) };
    }
    // one short, path-free sentence for a failed Git step: the station's own directories never reach the UI.
    function gitFailure(step, r, aid, scope) {
      if (r && r.timedOut) return 'Git ' + step + ' timed out';
      if (r && r.aborted) return 'Git ' + step + ' was stopped';
      // Git's own error first: `add -A` in a workspace holding a cloned repo prints "warning: adding embedded git
      // repository" before the real fatal:/error: line. Then the first line that is not a hint or warning, then any line.
      const lines = String((r && r.stderr) || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      let line = lines.filter(function (s) { return /^(fatal|error):/i.test(s); })[0]
        || lines.filter(function (s) { return !/^(hint|warning):/i.test(s); })[0] || lines[0] || '';
      const hide = function (text, dir, label) {
        const parts = pathMod.resolve(String(dir || '')).split(/[\\/]+/).filter(Boolean)
          .map(function (p) { return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
        return parts.length ? text.replace(new RegExp(parts.join('[\\\\/]+'), 'gi'), label) : text;
      };
      line = hide(hide(hide(line, gitDirFor(aid, scope), '<checkpoint repo>'), workTreeFor(aid, scope), '<workspace>'), root, '<station>')
        .replace(/^(fatal|error):\s*/i, '');
      const head = 'Git ' + step + ' failed' + (r && typeof r.code === 'number' ? ' (exit ' + r.code + ')' : '');
      return (line ? head + ': ' + line : head).slice(0, 240);
    }

    /* ---- THE LINK BOUNDARY (the header's LINKS) ---- */
    const winPaths = pathMod.sep === '\\';
    // Windows and macOS match names case-insensitively: a tracked `Sub/f` is read through an on-disk `sub` link
    const foldCase = winPaths || (typeof process !== 'undefined' && process.platform === 'darwin');
    const lstatAsync = (p) => (fsp ? fsp.lstat(p) : Promise.resolve().then(function () { return fs.lstatSync(p); }));
    const statAsync = (p) => (fsp ? fsp.stat(p) : Promise.resolve().then(function () { return fs.statSync(p); }));
    const readText = (p) => (fsp ? fsp.readFile(p, 'utf8') : Promise.resolve().then(function () { return fs.readFileSync(p, 'utf8'); }));
    // libuv's UV_FS_O_EXLOCK, which Node does not name (Windows): an open that shares nothing, refused while another program has that file or
    // folder open, a file held without delete sharing, a working folder or a watched one among them (scanTree's heldBelow)
    const EXLOCK = 0x10000000;
    const openClosed = async (abs, flags) => {
      if (fsp) { const h = await fsp.open(abs, flags); await h.close(); } else fs.closeSync(fs.openSync(abs, flags));
    };
    // whether Git for Windows could not delete this file, or remove this folder once emptied: open elsewhere, or a read-only folder (its rmdir
    // never clears that attribute); one gone since its listing is not in use. A FILE a running program maps as its own image (an .exe, a .dll it
    // loaded) has no handle an open sees, and Git cannot delete it either: an open for writing that shares nothing is refused (undo review 12).
    // A read-only file is not asked so (Git clears that attribute itself, and the open would be refused for it), so one that is a program image
    // (it starts "MZ", as every image does) counts as in use, erring toward refusal
    async function inUse(abs, dir) {
      try { await openClosed(abs, EXLOCK); }
      catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }
      let mode;
      try { mode = (await lstatAsync(abs)).mode; }
      catch (e) { return !(e && e.code === 'ENOENT'); }
      if (dir) return (mode & 0o200) === 0;
      if ((mode & 0o200) === 0) {
        try {
          const head = Buffer.alloc(2);
          const h = fsp ? await fsp.open(abs, 'r') : null, fd = h ? null : fs.openSync(abs, 'r');
          try { if (h) await h.read(head, 0, 2, 0); else fs.readSync(fd, head, 0, 2, 0); }
          finally { if (h) await h.close(); else fs.closeSync(fd); }
          return head[0] === 0x4d && head[1] === 0x5a;
        } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }
      }
      try { await openClosed(abs, ((fs.constants && fs.constants.O_RDWR) || 2) | EXLOCK); }
      catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }
      return false;
    }
    /* THE FOLD. foldName is a name as the lookups below read it: toLowerCase, sigma in one form (toLowerCase writes capital sigma as
       final sigma at a name's end and small sigma elsewhere, and NTFS reads capital and small sigma as one wherever they stand: undo
       review 8). It reads as one each of the 973 pairs NTFS read as one on this volume (every letter with a case, BMP and supplementary, 2026-11-02),
       each in every position of a name, and more: 217 BMP pairs NTFS keeps apart (the Kelvin sign and k, the Angstrom sign and a-ring, final and small
       sigma). Those more cannot mislead a rewind, which refuses them (namesReadApart, foldedTwoRefusal); macOS's normalization is asked of the
       file system instead (scanTree's spelledApart). gitFold is what Git's own fold (core.ignorecase, pathspec icase) reads as one: A-Z alone. */
    const foldName = (p) => String(p).toLowerCase().replace(/\u03c2/g, '\u03c3');
    const foldPath = (p) => (foldCase ? foldName(p) : String(p));
    const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    const ancestorsOf = function (rel) {                // 'a/b/c' -> ['a', 'a/b']
      const out = [], s = String(rel);
      for (let i = s.indexOf('/'); i >= 0; i = s.indexOf('/', i + 1)) out.push(s.slice(0, i));
      return out;
    };
    const atOrBelow = function (rel, dirFolded) { const f = foldPath(rel); return f === dirFolded || f.indexOf(dirFolded + '/') === 0; };
    // is the folded path k, or a folder above it, in this set of folded paths?
    const atOrBelowAny = function (k, set) {
      if (!set.size) return false;
      if (set.has(k)) return true;
      for (let i = k.indexOf('/'); i >= 0; i = k.indexOf('/', i + 1)) if (set.has(k.slice(0, i))) return true;
      return false;
    };
    const gitFold = (p) => String(p).replace(/[A-Z]+/g, function (m) { return m.toLowerCase(); });
    const holdsNonAscii = (p) => /[^\x00-\x7f]/.test(String(p));
    // a name foldName reads as all ASCII though it is not: only the Kelvin sign in all of Unicode. No list of the names outside A-Z holds its twin, the
    // same name in a plain k, so no check that reads such lists can tell them apart (namesReadApart, foldedTwoRefusal)
    const readsAsAscii = (name) => holdsNonAscii(name) && !holdsNonAscii(foldName(name));
    // a path with a byte outside printable ASCII in any component (wildmatch reads bytes), and one with a tilde and a digit: as
    // glob pathspecs, so Git lists such names alone, whatever the size of the tree (namesReadApart)
    const UNFOLDED_SPECS = [':(glob)**/*[! -~]*', ':(glob)**/*[! -~]*/**'];
    const SHORT_SPECS = [':(glob)**/*~[0-9]*', ':(glob)**/*~[0-9]*/**'];
    // one path component of the shape of a name Windows generates for a long one: up to 8 characters ending in ~ and digits,
    // then at most a 3-character extension, in any case (NTFS finds it in any case too)
    const SHORT_NAME_RE = /^(?=[^.]{2,8}(?:\.|$))[^.]*~[0-9]+(?:\.[^.]{1,3})?$/;
    /* classifyEntry — what one listed entry is, decided from the LISTING, never by following it. On Windows a listing marks
       EVERY reparse point as a link (libuv's scandir reads FILE_ATTRIBUTE_REPARSE_POINT): that is the check that sees a
       volume mount point, which lstat (and so Node 22's isSymbolicLink() on a stat) reads as a plain folder. lstat then
       names it: a link (junction, directory or file symlink), a folder (a mount point, or another folder reparse point:
       left out too), nothing (a dangling mount point: a link, 'unreadable', never 'gone'; one deleted since the listing
       reads the same, erring toward refusal), or a plain FILE (a cloud placeholder or a deduplicated file: virtualized content with no other path
       behind it, read like any file, as Git reads it). POSIX: a symlink is a link; a folder on another device than the root's
       own folder is a mount (a bind mount of the SAME file system keeps its device and is not told apart: documented, not
       detected). A `.git` entry is never content; one that is itself a link (or, POSIX, a mount point) is marked so: Git
       never reads it, but `reset --hard` deletes through it when it empties the folder holding it (gitLinks, linksBelow).
       A `.git` that is a real folder is marked too (gitFolder): reset empties it with its folder, through any link in it. */
    async function classifyEntry(absDir, ent, rootDev) {
      const name = String(ent.name);
      if (name === '.git' || (winPaths && name.toLowerCase() === '.git')) {   // Git never reads it as content
        if (ent.isSymbolicLink()) return { kind: 'git', linkKind: 'git-link' };
        if (rootDev != null && ent.isDirectory()) {
          let st;
          try { st = await lstatAsync(pathMod.join(absDir, name)); }
          catch (e) { return e && e.code === 'ENOENT' ? { kind: 'gone' } : { kind: 'git', linkKind: 'git-link' }; }
          if (st.dev !== rootDev) return { kind: 'git', linkKind: 'git-link' };
        }
        return { kind: 'git', linkKind: '', gitFolder: !!ent.isDirectory() };
      }
      if (ent.isSymbolicLink()) {
        if (!winPaths) return { kind: 'link', linkKind: 'symlink' };
        let st;
        try { st = await lstatAsync(pathMod.join(absDir, name)); }
        // ENOENT too: libuv's lstat follows a reparse point it cannot read as a link (a mount point named by volume GUID),
        // so a dangling one reads as gone. A link, unreadable: left out, recorded, and refused on a rewind's path
        catch (_) { return { kind: 'link', linkKind: 'unreadable' }; }
        if (st.isSymbolicLink()) return { kind: 'link', linkKind: 'junction-or-symlink' };
        if (st.isDirectory()) return { kind: 'link', linkKind: 'mount-point' };
        return { kind: 'file' };
      }
      if (ent.isDirectory()) {
        if (rootDev == null) return { kind: 'dir' };
        let st;
        try { st = await lstatAsync(pathMod.join(absDir, name)); }
        catch (e) { return e && e.code === 'ENOENT' ? { kind: 'gone' } : { kind: 'link', linkKind: 'unreadable' }; }
        return st.dev !== rootDev ? { kind: 'link', linkKind: 'mount-point' } : { kind: 'dir' };
      }
      return { kind: 'file' };
    }
    /* parsePlainIgnores — the .gitignore lines the walk may PRUNE by: one plain name ([A-Za-z0-9._-]), bare, `/`-anchored or
       led by a double-star folder wildcard, with or without a trailing `/` (Git strips a trailing CR and unescaped
       trailing spaces the same way). Anything else (globs, paths, escapes) is simply not used, so the walk enters more
       than Git does, never less. Where the file system folds case a name matches in any case, as Git's core.ignorecase
       matches it there, and a folder only another case names is kept out as a target's rule keeps one (scanTree's
       pruneBy, keptOut).
       NEGATIONS: a `!` line can re-include a folder an ignore rule excluded, so every one is kept (negationMatcher) and a
       folder any of them could match is never pruned. Only the folder itself counts: Git cannot re-include a path below
       an excluded folder, so `!.vscode/settings.json` never stops `node_modules` from being pruned. The walk's reading
       of a rule is never the last word on a folder it prunes: Git is asked (scanTree's opts.ignored), and a folder Git
       reads is entered. dirOnly: a rule ending in `/` names folders only (a file it never names: keptFile).
       Pruning decides more than time. A path the shadow index tracks below a pruned folder is still checked link by link
       (prepareCapture, restoreLinkConflicts), but what a rewind's capture takes is decided by it: a folder (or a file) a
       rule of the target only names is kept out of that capture (keptOut), so its untracked files stay where they are,
       and one the walk enters is captured by what Git ignores now. A rewind that changes a rule the walk cannot read
       (a glob, a path), or changes any rule beside a negation, is refused (restore's THE RULES A REWIND CHANGES): its
       undo, under the other side's rules, could not keep in place what that rule ignores. */
    function parsePlainIgnores(text, base) {
      const list = [], negs = [];
      const src = String(text), body = src.charCodeAt(0) === 0xFEFF ? src.slice(1) : src;   // Git skips a UTF-8 BOM too
      for (const line of ruleLines(body)) {
        if (line[0] === '!') { negs.push(negationMatcher(line.slice(1), base)); continue; }
        const m = plainRule(line);
        if (m) list.push({ base: base, name: m[3], anchored: !!m[2], dirOnly: !!m[4] });
      }
      return { list: list, negs: negs, nul: body.indexOf('\0') >= 0 };
    }
    // a .gitignore's rules as Git reads them: one per line, a trailing CR and unescaped trailing spaces dropped, blank and
    // `#` lines skipped (text: a BOM already dropped)
    function ruleLines(text) {
      const out = [];
      for (const raw of String(text).split('\n')) {
        const line = raw.replace(/\r$/, '').replace(/(^|[^\\]) +$/, '$1');
        if (line && line[0] !== '#') out.push(line);
      }
      return out;
    }
    // one plain name (PLAIN_IGNORE_RE: m[2] anchored, m[3] the name, m[4] a folder only) | null
    function plainRule(line) {
      const m = PLAIN_IGNORE_RE.exec(String(line));
      return !m || (m[1] && m[2]) || m[3] === '.' || m[3] === '..' ? null : m;
    }
    /* pruneBy — would the walk prune the folder `name` (childRel) in dirRel by these rules ({ list, kept, negs }: rulesIn)?
       'own': a rule of the work tree names it as spelled, so Git ignores it; 'kept': only the target's rules name it, or a
       rule names it only in another case where the file system folds case, so Git is told to leave it out (keptOut); '':
       no rule names it, or a negation could re-include it. */
    function pruneBy(rules, dirRel, childRel, name) {
      const lower = String(name).toLowerCase();
      const at = function (r) { return !r.anchored || r.base === dirRel; };
      const exact = function (r) { return r.name === name && at(r); };
      const folded = function (r) { return (r.name === name || (foldCase && r.name.toLowerCase() === lower)) && at(r); };
      const by = rules.list.some(exact) ? 'own' : rules.kept.some(folded) || (foldCase && rules.list.some(folded)) ? 'kept' : '';
      return by && !rules.negs.some(function (n) { return n(childRel, name); }) ? by : '';
    }
    /* keptFile — is the FILE `name` (childRel) in dirRel one only the target's rules name (a rule for files and folders
       alike, `name` or `/name`, never `name/`), in any case where the file system folds case, that no negation could
       re-include? A rewind keeps it out of its capture as it keeps such a folder out (scanTree's keptOut), so it stays
       where it is, out of the undo row, as an ignored file does: its undo, under the target's rules, then leaves it too. */
    function keptFile(rules, dirRel, childRel, name) {
      if (!rules.kept.length) return false;
      const lower = String(name).toLowerCase();
      const named = rules.kept.some(function (r) {
        return !r.dirOnly && (r.name === name || (foldCase && r.name.toLowerCase() === lower)) && (!r.anchored || r.base === dirRel);
      });
      return named && !rules.negs.some(function (n) { return n(childRel, name); });
    }
    /* negationMatcher — could this negation match the FOLDER (rel: its path from the work-tree root; name: its own name)?
       Over-answers yes, never no: a single star and `?` match within one path segment, a bracket expression one character
       of it, an escaped character itself, and a double star anything, slashes and nothing included (Git's own leading,
       middle and trailing double-star forms match less), all case-insensitively (Git's core.ignorecase can make `!Build`
       re-include `build`). A bracket expression Git could read otherwise (a `[:class:]` inside, no closing `]`), an
       escaped `/`, a lone trailing `\` or a control character (Git reads a line up to a NUL) matches everything. A
       pattern with a `/` (or a leading `/`) is matched against the folder's path from the .gitignore's own folder; one
       without, against its name, at any depth. Before undo review 1 a bracket, an escape or a double star anywhere
       matched every folder, so github/gitignore's VisualStudio.gitignore (its double-star negation of a Packages build
       folder beside `node_modules/`) pruned nothing below it. Since undo review 2 a rewind that changes a rule beside any
       negation is refused, and Git itself has the last word on every folder the walk prunes (scanTree's opts.ignored). */
    function negationMatcher(pattern, base) {
      const always = function () { return true; };
      let p = String(pattern);
      const anchored = p[0] === '/';
      if (anchored) p = p.slice(1);
      p = p.replace(/\/+$/, '');
      // a NUL or another control character: Git reads a line as a C string (`!node_modules<NUL> x` is `!node_modules`),
      // so such a negation matches everything here (undo review 2)
      if (!p || /\\\//.test(p) || /[\x00-\x1f\x7f]/.test(p)) return always;
      let src = '';
      for (let i = 0; i < p.length;) {
        const ch = p[i];
        if (ch === '\\') {                                // an escaped character is itself
          if (i + 1 >= p.length) return always;
          src += p[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
          i += 2;
        } else if (ch === '*') {
          let j = i;
          while (p[j] === '*') j++;
          if (j - i < 2) src += '[^/]*';
          else if (p[j] === '/') { src += '(?:.*/)?'; j++; }   // `**/`: any folders, none too
          else src += '.*';
          i = j;
        } else if (ch === '?') { src += '[^/]'; i++; }
        else if (ch === '[') {                            // one character, never `/`, as wildmatch finds the end
          let j = i + 1;
          if (p[j] === '!' || p[j] === '^') j++;
          if (p[j] === ']') j++;
          while (j < p.length && p[j] !== ']') {
            if (p[j] === '[' && p[j + 1] === ':') return always;
            j += p[j] === '\\' ? 2 : 1;
          }
          if (j >= p.length) return always;
          src += '[^/]';
          i = j + 1;
        } else { src += ch.replace(/[.+^${}()|\]/]/g, '\\$&'); i++; }
      }
      const re = new RegExp('^' + src + '$', 'i');
      const pathy = anchored || p.indexOf('/') >= 0;
      return function (rel, name) {
        if (!pathy) return re.test(name);
        if (!base) return re.test(rel);
        return rel.indexOf(base + '/') === 0 ? re.test(rel.slice(base.length + 1)) : true;
      };
    }
    /* scanTree — the bounded walk of one work tree that NEVER follows a link: breadth-first, SCAN_CONCURRENCY folders listed
       at once, each entry classified by classifyEntry. It skips `.git`, the folders a plain .gitignore name excludes, and the
       EMBEDDED REPOSITORIES opts.nested(rels) names among the folders that hold a `.git` (nestedRepos: Git records one as a
       gitlink and never reads inside it; a folder it cannot answer for refuses the walk), and refuses (the capture is
       skipped, health says why) past scanLimits: entry count, folder depth, wall time. Its lists come back sorted, so an
       unchanged tree records the same links every time.
         -> { ok:true, links:[{ path, kind }], gitLinks:[rel], gitFolders:[rel], gitFiles:[rel], prunedDirs:[rel], keptOut:[rel], nestedDirs:[rel],
              walkPath(p), linkOnPath(p), entryAt(p), gitHolders(p), contents(rel), linksBelow(rel), spelledApart(p), aliasOn(p), prunedOnChain(p), afterReset(...),
              ignoreNotes(), foldedTwo(), attributeFiles(), count(), refusal() } | { ok:false, reason }
       count() is how many entries of the person's own files and folders it has listed so far, the walk's and on demand.
       GIT'S OWN ANSWER (opts.ignored, undo review 2): every folder a plain rule of the work tree prunes is asked of Git in
       one go once the walk is done (check-ignore, scanFor), and one Git does not ignore is entered after all: a negation
       in a `.GITIGNORE` (Git opens .gitignore where the file system folds case, and the walk reads every spelling now
       too), or one holding a NUL (Git's line ends there), re-included a node_modules the walk had pruned, so a junction in
       it was never left out of Git's view; the capture read through it and the reset deleted the files behind it, ok:true.
       ignoreNotes(): the .gitignore files the walk read that hold a negation or a NUL byte (restore's THE RULES A REWIND
       CHANGES).
       gitLinks: the `.git` entries in the folders it listed (not inside an embedded repository) that are links themselves;
       gitFolders: the same for a `.git` that is a real folder, below the root (never listed by the walk: linksBelow; off
       Windows a `.GIT` in another case is listed by the walk as content, and counted here, a folder, or in gitFiles, a
       file: listOne);
       gitFiles: the same for a `.git` that is a plain file in a folder the walk entered (one looksLikeRepo does not take
       for a repository: a worktree's gitfile, one Git does not read as a gitfile, or one naming no repository).
       entryAt(p) is what stands at p, through the same listings: { kind, rel } ('file', 'dir', 'link' or 'git'; rel the
       on-disk spelling, case-folded where the file system folds case), or null when nothing does or a folder above it is
       not a plain folder. gitHolders(p) is the folders on p's chain (below the root, p itself when it is a folder) whose
       listing holds a `.git` of any kind, through the same listings, up to the first folder of p that is not there.
       contents(rel) is what the folder rel holds, through the same listings: { count } (null when it is not there).
       walkPath(p) walks one '/'-path's folder chain through the listings (listing a folder the walk did not enter on
       demand, never through a link) and returns { link, spelled } for the first component that is a link (on-disk name / as
       `p` spelled it), or { dir } when every component is a plain folder (on-disk names), else null. A component that does
       not exist, or is a file, ends the chain: nothing there for Git to be led through. linkOnPath(p) is its link answer
       alone. linksBelow(rel) lists every folder at or below rel on demand, pruned or embedded alike, the inside of a
       real `.git` folder too (entry.c remove_subtree has no case for `.git`: it empties one through a junction such as a
       linked .git/hooks or a relocated .git/lfs), and returns the links in it, a `.git` that is itself a link included
       (null past the budget). What it lists inside a `.git` folder has an entry count of its own (the same maximum), so
       Git's own data never uses up the count of the person's files, and a refusal over it names that `.git` (r5). A link
       listed inside an embedded repository or inside a `.git` folder is never added to `links`: Git does not read there,
       so there is nothing to leave out of its view.
       opts.targetRules (a rewind's walk: targetIgnoreRules) maps a folder (folded) to the text of the TARGET's own .gitignore
       there, where it differs from the work tree's: its plain names prune too (final review 2). A folder only they prune
       is pruned and listed in keptOut, whatever the target holds in it (undo closure: walked where the target held a
       path there, the rewind never listed it whole as its undo, pruning it by the rewound .gitignore, then had to, and
       its undo took the untracked files a rule had kept out of the first capture and deleted them), and so is one a rule
       names only in another case where the file system folds case (undo review 1: `Node_modules` against node_modules,
       ignored by Git's core.ignorecase, was walked, and the undo took and deleted it). Git does not ignore a keptOut
       folder by the work tree's own rules, so the capture leaves it out by an info/exclude line (prepareCapture), a
       rewind's checks ask Git with that line written, and a file there the rewind writes over or deletes is taken by name
       (restore's forced capture, restoreUncapturedConflicts). Negations of both count, so a folder either could re-include
       is walked. A FILE only the target's rules name (a rule for files and folders alike) is kept out the same way
       (keptFile, listed in keptOut: undo review 2, the person's ignored .env that its undo took and deleted).
       prunedOnChain(p): p is a path the reset will write; the outermost folder on its chain that is not there now (the
       reset makes it) and that the walk would prune if it stood there (pruneBy, by the rules of the deepest folder it
       entered on the chain and the target's .gitignore texts in the folders made below it), or ''. An undo prunes such a
       folder (it stands there by then) and lists what the target and its row hold below it, as restore lists the walk's
       own pruned folders before its commit.
       afterReset(writes, removes, made, prunedMade, undoPaths): how many files and folders the undo of this rewind will
       list, its walk and its checks, on the tree the reset leaves: every entry of each folder its walk lists (each folder
       this walk listed that is still there, each folder the reset makes inside one it enters that no rule prunes), and of
       each folder its checks list on demand on the way to a path the target or the undo row holds below a folder it does
       not enter (undoPaths: restore's listUnder of those folders with the undo row staged). writes: the paths the reset
       writes, removes: the paths it deletes, made: the folders it makes, prunedMade: those a rule prunes. A folder the
       reset empties is gone (Git removes a folder once it has deleted all it held), and a folder no listing holds is
       listed now, on demand, so the count is exact as Git's reset goes: the undo's own count of the tree its reset leaves
       is the count its rewind took, never past the budget (undo review 2: a count that kept every folder the reset
       empties refused the undo of a completed rewind). It counts the folders this walk skipped as repositories as the
       undo's walk skips them: the undo's nestedRepos asks the target's index, and where that answers otherwise than this
       walk's index (a gitlink the reset adds or drops at a folder of files, a write or a deletion below a repository) the
       rewind is refused (gitlinkOverFiles, repoOnPath; undo review 3: a linked worktree the reset dropped the gitlink of
       was walked whole by the undo, and nestedRepos answered "none" from a listing cut off under the target's index).
       -> number | null (a folder could not be listed: refusal())
       spelledApart(p): the first entry on p's chain that foldName reads as one with p's component and Git's own fold does not,
       { have: on disk, want: as p spells it }, or a component outside ASCII no listing shows in either fold that the file system answers for all the same
       (macOS's normalization, say), { have: '', want } | null (namesReadApart: undo reviews 7, 8). foldedTwo(): the first two entries of one folder, of all it has
       listed so far, that foldName reads as one and Git's fold as two, or the first that reads as all ASCII { first, second: '' } | null (foldedTwoRefusal);
       caseTwins(): two entries of one folder that Git's own fold reads as one too (A-Z alone), which only a folder that reads case apart holds, the
       first two of the folder first in byte order of all the walk and the checks listed, outside an embedded repository and a `.git` folder: a capture
       of its own walk is skipped, a rewind refused (undo review 9) | null. One pair is kept for every folder listed, with no list to fill (undo review
       10: eight pairs at the top of a clone, listed before nestedRepos named it, filled a list of eight, and the person's pair past them was never seen).
       CASE APART (opts.probeCase, a rewind's walk: undo review 9). Every folder it lists, on demand too, is asked whether it reads case apart, as a folder
       WSL makes does (Windows' per-folder case sensitivity; fsutil marks one without administrator rights; a case-sensitive volume): one of its names
       with a letter A-Z, that letter in the other case, is not there. A folder that holds nothing, or only names with no letter A-Z, is not asked: no
       name there can ask it. Git (core.ignorecase) reads two such names as one and opens `.gitignore` by its exact name, so its reading of such a folder
       is not the walk's. caseRefusal(writes, removes, { rewrites, gitlinkUnder, gitlinkBack }) (writes: the paths the reset writes that the index lacks, removes:
       those it deletes, rewrites: those it writes over, each as the tree spells it; gitlinkUnder(rel), gitlinkBack(rel): whether the target, and the tree the
       capture staged, record a gitlink at or below rel, '' the whole tree) -> the first of these, of the folders outside an embedded repository and a `.git`
       folder, or null. A folder's entries CHANGE where the reset adds one, deletes one or turns one from a file into a folder or back: a file, a folder it makes
       or empties (Git removes a folder once it has deleted all it held), the empty folder of a gitlink it records or drops (Git makes one and removes it: undo
       review 10), a gitlink or a FILE written where a folder stands. A folder MUST GO where the reset empties it, or writes a FILE at it or above it, and the
       root where it leaves that holding nothing (undo review 11: Git can leave any of them, WHAT GIT LEAVES at foldedTwoRefusal). U is the folders that hold
       nothing which the reset writes into, those that hold no file where it writes, with each folder that holds only such: its undo empties or deletes every one, and no capture makes one again;
         { dir, why: 'letters' }: a folder whose entries change that holds something before the reset and after it, a name with a letter A-Z on one side
           only (its undo would ask it on the other side);
         { dir, why: 'partial', name, undo }: a folder that must go holding a name with no letter A-Z, unless that name is all it holds and is a file or a
           folder that goes too (Git leaving some of what it holds, its undo could not ask it); undo: such a folder its undo would have to remove, one the
           reset makes or fills from nothing;
         { dir, why: 'unasked' }: one whose entries change that holds something now and was not asked, unless the reset empties it (each name there holds no
           letter A-Z, so Git reaches it by its one spelling whatever the folder reads, and removes the folder) (undo review 10: CSD5, a FILE there the reset
           made a folder of, which took the folder's case, so the undo, writing that FILE back, could not empty it);
         { dir, why: 'empty', detail, at, whole }: one that holds nothing now, which the reset writes into, or one that holds no file, where it writes a FILE or a gitlink (at), unless
           the folder above the top of its chain in U holds besides them a name with a letter A-Z ('parent') and the target records no gitlink there ('gitlink';
           where a chain reaches the root, whole: anywhere in the target; 'unlisted': Git could not say). Its undo then empties the folder as it was written,
           whatever it reads, and the folder above it is one the undo asks on both sides (undo review 10: CSGE, a gitlink's empty folder in it, and EP, the
           folder above it holding only names with no letter A-Z besides it, each stranded the undo; undo review 11: another folder that holds nothing, which
           its undo empties too, counted as that name);
         { dir, why: 'made', detail }: a folder the reset makes, or fills from nothing, where the target records a gitlink ('gitlink'; 'unlisted': Git could
           not say): its undo would have to remove it, which 'standing' refuses;
         { dir: '', why: 'rootEmpty', name }: the reset leaves the root holding nothing and drops a gitlink, which its undo would write into a folder
           that holds nothing;
         { dir, why: 'apart', name, flipped }: a folder that reads case apart, unless the reset deletes every entry it holds, each spelled as it stands
           at every component of its path, and writes nothing at or below it, so Git removes it (an empty folder the rewind wrote into is one its undo
           empties so; undo review 10, NEST1: a folder respelled in another case since the last capture, deleted under the tree's spelling, was not
           there for Git to delete, and the rewind answered ok with it standing);
         { dir, why: 'spelled', want, back }: a path the reset deletes, writes or writes over that a tree spells otherwise than the disk at a component that
           stands (dir: as the disk spells it; want: as the tree does; back: the tree its capture staged), but a file it deletes first and a folder of files where
           it writes a FILE, which go whatever their spelling. The steering of undo review 10: no rewind goes by a spelling that is not the disk's;
         { dir, why: 'standing', detail }: a folder that must go where the tree its capture staged records a gitlink, or where the reset leaves the root holding
           nothing, anywhere in that tree ('gitlink'; 'unlisted': Git could not say): were it left standing, its undo would write that gitlink into a folder that holds nothing;
         { dir: '', why: 'twins', name, other }: two of the paths the reset writes spelling one name two ways Git reads as one;
         { dir, why: 'held', name }: a folder that reads case apart which the exception of 'apart' lets through, where a file or folder below it is in use;
         { dir, why: 'stops', name }: a folder where the reset writes a FILE, or a FILE it makes a folder of, where that, or a file
           or folder below it, is in use (Git stops there, the rest of the rewind not done);
         { dir, why: 'inuse', name, over }: a file the reset deletes, or writes over (over), that is in use (Git leaves the one, the rewind not complete, and
           stops at the other, its index unwritten: undo review 12).
       heldBelow(rel, own): the first file or folder at or below the folder rel (rel itself only with own) that another program has open or runs as its own
       image, or that is a read-only folder (inUse), asked of the file system (Windows' alone: POSIX deletes what is open, and no row has run on macOS) | ''. Each
       is asked as late as the checks go, so what another program opens after is not seen.
       attributeFiles(): the .gitattributes files of those folders (storedAsItIsRefusal). aliasOn(p): the first component of p of a
       Windows short name's shape that no listing shows and the file system answers for, its path as p spells it | ''. */
    async function scanTree(workTree, opts) {
      const nestedOf = opts && typeof opts.nested === 'function' ? opts.nested : null;
      const ignoredOf = opts && typeof opts.ignored === 'function' ? opts.ignored : null;
      const targetRules = opts && opts.targetRules instanceof Map ? opts.targetRules : null;
      const started = scanClock.now();
      const listings = new Map();                         // folder rel ('' = the root) -> { byName, byFold, hasGit, count }
      const rulesOf = new Map();                          // a folder the walk entered (folded) -> the rules its children are pruned by
      const walkListed = new Set();                       // the folders (folded) whose entries the walk itself counted
      const ignoreNotes = [];                             // the .gitignore files it read that hold a negation or a NUL byte
      const links = [], linkSeen = new Set(), prunedDirs = [], keptOut = [], nestedDirs = [], nestedSet = new Set();
      const gitLinks = [], gitLinkSeen = new Set();       // `.git` entries that are links: never content, never left out
      const gitFolders = [], gitFolderSeen = new Set();   // `.git` entries that are real folders, below the root
      const gitFiles = [], gitFileSeen = new Set();       // `.git` entries that are plain files, below the root
      let entries = 0, gitEntries = 0, refusal = '';      // gitEntries: listed inside a `.git` folder (linksBelow only)
      let foldedTwo = null;                               // the first two entries of one folder foldName reads as one and Git's fold as two, or one that reads as all ASCII
      const twins = new Map();                            // folder rel -> its first two entries Git's own fold reads as one (A-Z alone), { rel, first, second }
      const apart = [];                                   // a rewind's walk (opts.probeCase): the folders that read case apart, { rel, name, flipped }
      const askedDirs = new Set();                        // a rewind's walk: the folders (folded) whose case one of their names asked
      const probeCase = !!(opts && opts.probeCase) && foldCase;
      const attributeFiles = [];                          // the entries named .gitattributes it listed
      const refuse = function (why) { if (!refusal) refusal = why; };
      const overTime = function () {
        if (!refusal && scanClock.now() - started > scanLimits.deadlineMs) refuse('checking it took longer than ' + Math.round(scanLimits.deadlineMs / 1000) + ' s');
        return !!refusal;
      };
      const absOf = function (rel) { return rel ? pathMod.join(workTree, rel) : workTree; };
      const inNested = function (rel) {
        if (!nestedSet.size) return false;
        const f = foldPath(rel);
        for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) if (nestedSet.has(f.slice(0, i))) return true;
        return nestedSet.has(f);
      };
      const gitFolderOf = function (rel) {                // the `.git` folder rel is at or below, else '' (only linksBelow lists one)
        const parts = String(rel).split('/');
        const at = parts.findIndex(function (c) { return c === '.git' || (winPaths && c.toLowerCase() === '.git'); });
        return at < 0 ? '' : parts.slice(0, at + 1).join('/');
      };
      const inGitFolder = function (rel) { return !!gitFolderOf(rel); };
      let rootDev = null;
      if (!winPaths) {
        // stat, not lstat: Git reads a root that is itself a link (a workspace moved to a bigger disk and linked back)
        // through it, so the folder it names sets the device the children are compared with, not the link's file system
        try { rootDev = (await statAsync(workTree)).dev; }
        catch (e) { if (!(e && e.code === 'ENOENT')) return { ok: false, reason: 'the folder could not be read (' + String((e && e.code) || 'error').slice(0, 24) + ')' }; }
      }
      function record(rel, listing) {                     // the links one listed folder holds, each added to `links` once
        for (const v of listing.byName.values()) {
          const p = rel ? rel + '/' + v.name : v.name;
          if (v.kind === 'git' && v.linkKind && !gitLinkSeen.has(p)) { gitLinkSeen.add(p); gitLinks.push(p); }
          if (v.kind === 'git' && v.gitFolder && rel && !gitFolderSeen.has(p)) { gitFolderSeen.add(p); gitFolders.push(p); }
          if (v.kind === 'git' && !v.linkKind && !v.gitFolder && rel && !gitFileSeen.has(p)) { gitFileSeen.add(p); gitFiles.push(p); }
          if (v.gitNamed && rel && v.kind === 'dir' && !gitFolderSeen.has(p)) { gitFolderSeen.add(p); gitFolders.push(p); }   // a `.GIT`, off Windows
          if (v.gitNamed && rel && v.kind === 'file' && !gitFileSeen.has(p)) { gitFileSeen.add(p); gitFiles.push(p); }
          if (v.kind !== 'link') continue;
          if (!linkSeen.has(p)) { linkSeen.add(p); links.push({ path: p, kind: v.linkKind }); }
        }
      }
      // list one folder; its links are recorded at once (on demand), or by the walk once it knows the folder is not an
      // embedded repository (deferred)
      async function listOne(rel, deferred) {
        if (refusal) return null;
        let ents;
        try { ents = await listDir(absOf(rel)); }
        catch (e) {
          const code = e && e.code;
          if (code === 'ENOENT' || code === 'ENOTDIR') return null;   // gone since its parent was listed: nothing to follow
          if (code === 'EACCES' || code === 'EPERM') { failNote('checkpoint.links.unreadable', e); return null; }   // Git cannot enter it either
          refuse('a folder in it could not be listed (' + String(code || 'error').slice(0, 24) + ')');
          return null;
        }
        const gitFolder = gitFolderOf(rel);
        if (gitFolder) {                                  // Git's own data: counted apart from the person's files, and named
          gitEntries += ents.length;
          if (gitEntries > scanLimits.maxEntries) { refuse('the Git folders (.git) the rewind would delete hold more than ' + scanLimits.maxEntries + ' files and folders (counted up to "' + gitFolder + '")'); return null; }
        } else {
          entries += ents.length;
          if (entries > scanLimits.maxEntries) { refuse('it holds more than ' + scanLimits.maxEntries + ' files and folders'); return null; }
        }
        const dirAbs = absOf(rel);
        const kinds = await Promise.all(ents.map(function (ent) { return classifyEntry(dirAbs, ent, rootDev); }));
        const byName = new Map(), byFold = new Map();
        let hasGit = false;
        for (let i = 0; i < ents.length; i++) {
          if (kinds[i].kind === 'gone') continue;
          const name = String(ents[i].name);
          // wherever the file system folds case (macOS, a Linux work tree on a case-insensitive mount: WSL's /mnt/c, ext4
          // casefold, vfat/exFAT), Git skips a `.GIT` (core.ignorecase) and reads x/.git through it as the mark of an
          // embedded repository, whatever core.ignorecase says. classifyEntry folds that name on Windows only, so the walk
          // still enters it, but it counts as Git's here on every platform: the folder holds a `.git`. On a case-sensitive
          // volume Git refuses to add any `.GIT` path (verify_dotfile: add exits 128), so this only adds refusals there
          const gitNamed = kinds[i].kind !== 'git' && name.toLowerCase() === '.git';
          if (kinds[i].kind === 'git' || gitNamed) hasGit = true;
          const v = { name: name, kind: kinds[i].kind, linkKind: kinds[i].linkKind || '', gitFolder: !!kinds[i].gitFolder, gitNamed: gitNamed };
          byName.set(v.name, v);
          const fold = foldName(v.name), prev = byFold.get(fold), at = rel ? rel + '/' : '';
          if (!foldedTwo && readsAsAscii(v.name)) foldedTwo = { first: at + v.name, second: '' };
          if (!foldedTwo && prev && gitFold(prev.name) !== gitFold(v.name)) foldedTwo = { first: at + prev.name, second: at + v.name };
          // two names in A-Z case apart side by side, which only a folder that reads case apart holds and Git's own fold reads as one (undo review 9),
          // the first pair of every folder listed, inside an embedded repository too until the walk knows it is one (caseTwins)
          if (foldCase && prev && gitFold(prev.name) === gitFold(v.name) && !twins.has(rel)) twins.set(rel, { rel: rel, first: at + prev.name, second: at + v.name });
          if (!prev || v.kind === 'link') byFold.set(fold, v);
          if (fold === '.gitattributes' && v.kind === 'file') attributeFiles.push(at + v.name);
        }
        // CASE APART (undo review 9): one of its names with a letter A-Z, that letter in the other case, is not there, so this folder reads
        // case apart (Windows' per-folder case sensitivity, on every folder WSL makes and any fsutil marks; a case-sensitive volume)
        if (probeCase && !gitFolder) {
          for (const v of byName.values()) {
            if (!/[A-Za-z]/.test(v.name)) continue;
            const flipped = v.name.replace(/[A-Za-z]/, function (c) { return c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(); });
            if (byName.has(flipped)) continue;            // its twin, side by side (caseTwins): another name asks
            const there = await lstatAsync(pathMod.join(dirAbs, flipped)).then(function () { return true; }, function () { return false; });
            askedDirs.add(foldPath(rel));
            if (!there) apart.push({ rel: rel, name: (rel ? rel + '/' : '') + v.name, flipped: (rel ? rel + '/' : '') + flipped });
            break;
          }
        }
        const listing = { byName: byName, byFold: byFold, hasGit: hasGit, count: ents.length };
        listings.set(rel, listing);
        if (!deferred && !inNested(rel) && !inGitFolder(rel)) record(rel, listing);
        return listing;
      }
      // the rules a folder's children are pruned by: list (the work tree's own plain names), kept (the target's, a rewind's
      // walk only), negs (both). Every entry named .gitignore is read, in any case where the file system folds case: Git
      // opens `.gitignore` and gets the `.GITIGNORE` there (undo review 2: its negation re-included a folder the walk pruned
      // by the root's rule, and Git read through a junction in it). In a folder that reads case apart Git does not, so its
      // rules are not this walk's there, and a rewind whose checks list such a folder is refused unless its reset empties it,
      // each entry as it is spelled (CASE APART: caseRefusal, undo reviews 9 and 10). One that holds a negation or a NUL byte is noted (ignoreNotes: a rewind that
      // changes any .gitignore is refused beside one)
      async function rulesIn(dir, listing) {
        let rules = dir.rules;
        for (const gi of listing.byName.values()) {
          if (gi.name !== '.gitignore' && !(foldCase && gi.name.toLowerCase() === '.gitignore')) continue;
          if (gi.kind !== 'file') continue;               // a .gitignore that is a link: Git skips it too
          let text;
          try { text = await readText(pathMod.join(absOf(dir.rel), gi.name)); }
          catch (e) { failNote('checkpoint.links.gitignore', e); return { list: [], kept: [], negs: [function () { return true; }] }; }   // unread: prune nothing below
          const own = parsePlainIgnores(text, dir.rel);
          if (own.negs.length || own.nul) ignoreNotes.push({ path: dir.rel ? dir.rel + '/' + gi.name : gi.name, negation: own.negs.length > 0, nul: own.nul });
          if (own.list.length || own.negs.length) rules = { list: rules.list.concat(own.list), kept: rules.kept, negs: rules.negs.concat(own.negs) };
        }
        return withTarget(rules, dir.rel);
      }
      // the target's own .gitignore text in folder rel, if a rewind has one there, added as kept rules and negations
      function withTarget(rules, rel) {
        const theirs = targetRules ? targetRules.get(foldPath(rel)) : null;
        if (theirs == null) return rules;
        const t = parsePlainIgnores(theirs, rel);
        return t.list.length || t.negs.length ? { list: rules.list, kept: rules.kept.concat(t.list), negs: rules.negs.concat(t.negs) } : rules;
      }
      // the walk, breadth-first from `level`; a folder a plain rule of the work tree prunes waits in ownPruned for Git's
      // own answer (below)
      const ownPruned = [];
      async function walkFrom(level) {
        while (level.length && !refusal) {
          const listed = [];
          for (let i = 0; i < level.length && !refusal; i += SCAN_CONCURRENCY) {
            await Promise.all(level.slice(i, i + SCAN_CONCURRENCY).map(async function (dir) {
              const listing = await listOne(dir.rel, true);
              if (listing) { walkListed.add(foldPath(dir.rel)); listed.push({ dir: dir, listing: listing, rules: await rulesIn(dir, listing) }); }
            }));
            overTime();
          }
          if (refusal) break;
          // EMBEDDED REPOSITORIES: the folders of this level that hold a `.git`, asked about in one go; a folder Git could not
          // answer for refuses the walk (undo review 3: answered "none", the walk entered a clone another walk skipped)
          const asked = listed.filter(function (x) { return x.dir.rel && x.listing.hasGit; }).map(function (x) { return x.dir.rel; });
          const answer = asked.length && nestedOf ? await nestedOf(asked) : [];
          if (!answer) { refuse('Git could not say which of its folders are embedded repositories'); break; }
          const nested = new Set(answer.map(foldPath));
          if (overTime()) break;
          const next = [];
          const enter = function (c) {
            if (c.depth > scanLimits.maxDepth) { refuse('its folders nest deeper than ' + scanLimits.maxDepth + ' levels'); return false; }
            next.push(c);
            return true;
          };
          for (const x of listed) {
            const dir = x.dir;
            if (nested.has(foldPath(dir.rel))) { nestedDirs.push(dir.rel); nestedSet.add(foldPath(dir.rel)); continue; }
            record(dir.rel, x.listing);
            rulesOf.set(foldPath(dir.rel), x.rules);
            for (const v of x.listing.byName.values()) {
              const childRel = dir.rel ? dir.rel + '/' + v.name : v.name;
              // a FILE only the target's rules name is kept out of the capture like such a folder (undo review 2: its undo
              // took the person's ignored .env and its reset deleted it)
              if (v.kind === 'file') { if (keptFile(x.rules, dir.rel, childRel, v.name)) keptOut.push(childRel); continue; }
              if (v.kind !== 'dir') continue;
              const by = pruneBy(x.rules, dir.rel, childRel, v.name);
              if (by === 'own') { ownPruned.push({ rel: childRel, depth: dir.depth + 1, rules: x.rules }); continue; }
              if (by) {
                prunedDirs.push(childRel);
                keptOut.push(childRel);                     // no rule of the work tree names it as spelled: Git is told to leave it out
                continue;
              }
              if (!enter({ rel: childRel, depth: dir.depth + 1, rules: x.rules })) break;
            }
            if (refusal) break;
          }
          level = next;
        }
      }
      let start = [{ rel: '', depth: 0, rules: { list: [], kept: [], negs: [] } }];
      while (start.length && !refusal) {
        await walkFrom(start);
        start = [];
        const ask = ownPruned.splice(0);
        if (refusal || !ask.length) break;
        // GIT'S OWN ANSWER for every folder a plain rule of the work tree prunes, in one go (check-ignore, opts.ignored): one
        // Git does not ignore is entered, so no link in it is missed (undo review 2: a negation in a `.GITIGNORE`, or one
        // holding a NUL, re-included a node_modules the walk pruned; the capture read through a junction there and the
        // reset deleted through it). Without opts.ignored the walk goes by its own reading
        const ignored = ignoredOf ? await ignoredOf(ask.map(function (x) { return x.rel; })) : null;
        if (ignoredOf && !ignored) { refuse('Git could not say which folders it ignores'); break; }
        for (const x of ask) {
          if (!ignored || ignored.has(x.rel)) prunedDirs.push(x.rel);
          else if (x.depth > scanLimits.maxDepth) { refuse('its folders nest deeper than ' + scanLimits.maxDepth + ' levels'); break; }
          else start.push(x);
        }
      }
      if (refusal) return { ok: false, reason: refusal };
      links.sort(function (a, b) { return byText(a.path, b.path); });
      prunedDirs.sort(byText);
      keptOut.sort(byText);
      nestedDirs.sort(byText);
      gitLinks.sort(byText);
      gitFolders.sort(byText);
      gitFiles.sort(byText);
      // -> { link, spelled } (a component is a link) | { dir } (the whole path is a plain folder, on-disk names) | null
      async function walkPath(p) {
        const parts = String(p || '').split('/');
        let rel = '';
        for (let i = 0; i < parts.length; i++) {
          const listing = listings.get(rel) || await listOne(rel, false);
          if (!listing) return null;
          const v = listing.byName.get(parts[i]) || listing.byFold.get(foldName(parts[i]));
          if (!v) return null;
          const here = rel ? rel + '/' + v.name : v.name;
          if (v.kind === 'link') return { link: here, spelled: parts.slice(0, i + 1).join('/') };
          if (v.kind !== 'dir') return null;
          rel = here;
        }
        return { dir: rel };
      }
      async function linkOnPath(p) { const at = await walkPath(p); return at && at.link ? at : null; }
      async function entryAt(p) {
        const parts = String(p || '').split('/');
        let rel = '';
        for (let i = 0; i < parts.length; i++) {
          const listing = listings.get(rel) || await listOne(rel, false);
          if (!listing) return null;
          const v = listing.byName.get(parts[i]) || (foldCase ? listing.byFold.get(foldName(parts[i])) : null);
          if (!v) return null;
          const here = rel ? rel + '/' + v.name : v.name;
          if (i === parts.length - 1) return { kind: v.kind, rel: here };
          if (v.kind !== 'dir') return null;
          rel = here;
        }
        return null;
      }
      // the folders below the root on p's folder chain, p itself when it is a plain folder, whose listing holds a `.git`
      // entry of any kind (a folder, a file, a link), on-disk spelling, outermost first; walked like entryAt, never
      // through a link
      async function gitHolders(p) {
        const parts = String(p || '').split('/'), out = [];
        let rel = '';
        for (let i = 0; i <= parts.length; i++) {
          const listing = listings.get(rel) || await listOne(rel, false);
          if (!listing) return out;
          if (rel && listing.hasGit) out.push(rel);
          if (i === parts.length) return out;
          const v = listing.byName.get(parts[i]) || (foldCase ? listing.byFold.get(foldName(parts[i])) : null);
          if (!v || v.kind !== 'dir') return out;
          rel = rel ? rel + '/' + v.name : v.name;
        }
        return out;
      }
      // what the folder rel (on-disk spelling) holds now, through the same listings: { count } | null (none there)
      async function contents(rel) {
        const listing = listings.get(rel) || await listOne(rel, false);
        return listing ? { count: listing.byName.size } : null;
      }
      async function linksBelow(top) {
        const found = [];
        let level = [String(top)];
        for (let depth = 0; level.length && !refusal; depth++) {
          if (depth > scanLimits.maxDepth) { refuse('its folders nest deeper than ' + scanLimits.maxDepth + ' levels'); break; }
          const next = [];
          for (let i = 0; i < level.length && !refusal; i += SCAN_CONCURRENCY) {
            await Promise.all(level.slice(i, i + SCAN_CONCURRENCY).map(async function (rel) {
              const listing = listings.get(rel) || await listOne(rel, false);
              if (!listing) return;
              for (const v of listing.byName.values()) {
                const p = rel ? rel + '/' + v.name : v.name;
                if (v.kind === 'link' || (v.kind === 'git' && v.linkKind)) found.push(p);
                else if (v.kind === 'dir' || (v.kind === 'git' && v.gitFolder)) next.push(p);   // a real `.git` too
              }
            }));
            overTime();
          }
          level = next;
        }
        return refusal ? null : found.sort(byText);
      }
      // the header's spelledApart: through the walk's listings, never through a link, on demand only below a folder it did not
      // enter (restoreLinkConflicts has listed those for these paths, and afterReset counts them)
      async function spelledApart(p) {
        const parts = String(p || '').split('/');
        let rel = '';
        for (let i = 0; i < parts.length; i++) {
          const listing = listings.get(rel) || await listOne(rel, true);
          if (!listing) return null;
          const v = listing.byName.get(parts[i]) || listing.byFold.get(foldName(parts[i]));
          // no listing shows that name in either fold: one the file system answers for all the same it reads otherwise than here
          if (!v) return holdsNonAscii(parts[i]) && await lstatAsync(pathMod.join(absOf(rel), parts[i])).then(function () { return true; }, function () { return false; }) ? { have: '', want: parts.slice(0, i + 1).join('/') } : null;
          const here = rel ? rel + '/' + v.name : v.name;
          if (gitFold(v.name) !== gitFold(parts[i])) return { have: here, want: parts.slice(0, i + 1).join('/') };
          if (v.kind !== 'dir') return null;
          rel = here;
        }
        return null;
      }
      // the header's aliasOn
      async function aliasOn(p) {
        const parts = String(p || '').split('/');
        for (let i = 0; i < parts.length; i++) {
          if (!SHORT_NAME_RE.test(parts[i])) continue;
          const q = parts.slice(0, i + 1).join('/');
          if (await entryAt(q)) continue;
          if (await lstatAsync(pathMod.join(workTree, q)).then(function () { return true; }, function () { return false; })) return q;
        }
        return '';
      }
      // the outermost folder the reset makes on p's chain that the walk would prune (the header's prunedOnChain) | ''
      function prunedOnChain(p) {
        const parts = String(p || '').split('/');
        let rel = '', rules = rulesOf.get(''), made = false;
        if (!rules) return '';
        for (let i = 0; i < parts.length - 1; i++) {     // the folders above p: p itself is what the reset writes
          const name = parts[i], childRel = rel ? rel + '/' + name : name;
          if (!made) {
            const listing = listings.get(rel);
            const v = listing && (listing.byName.get(name) || (foldCase ? listing.byFold.get(foldName(name)) : null));
            if (v && v.kind === 'dir') {
              const here = rel ? rel + '/' + v.name : v.name, below = rulesOf.get(foldPath(here));
              if (!below) return '';                      // pruned or embedded: what it holds is listed with it
              rel = here; rules = below;
              continue;
            }
            if (v && v.kind !== 'file') return '';        // a link or a `.git` on the path: the checks refuse that rewind
            made = true;                                  // nothing there, or a file the reset replaces with the folder
          }
          if (pruneBy(rules, rel, childRel, name)) return childRel;
          rules = withTarget(rules, childRel);            // a folder made by the reset holds only the target's .gitignore
          rel = childRel;
        }
        return '';
      }
      // the header's afterReset
      async function afterReset(writes, removes, made, prunedMade, undoPaths) {
        const parentOf = function (p) { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : String(p).slice(0, i); };
        const added = new Map(), removed = new Map(), replaced = new Set();   // folded folder -> entries the reset adds | folded file -> on-disk rel
        const bump = function (dir) { const k = foldPath(dir); added.set(k, (added.get(k) || 0) + 1); };
        for (const r of removes) {
          const at = await entryAt(r);
          if (refusal) return null;
          if (at && at.kind === 'file') removed.set(foldPath(at.rel), at.rel);
        }
        for (const w of writes) {
          const at = await entryAt(w);
          if (refusal) return null;
          // a new entry; a file there now is written over, unless the reset deletes it first (a case-only rename)
          if (!at || (at.kind === 'file' && removed.has(foldPath(at.rel)))) bump(parentOf(w));
          else if (at.kind === 'dir') replaced.add(foldPath(at.rel));  // a folder the file replaces, with all it holds
        }
        const madeSet = new Set(made.map(foldPath));
        for (const m of made) bump(parentOf(m));
        // the folders the reset empties (Git removes a folder once it has deleted all it held): deepest first, a folder above
        // a deleted file that held something and holds nothing else now, nothing written into it
        const writeAbove = new Set();
        for (const w of writes) for (const a of ancestorsOf(w)) writeAbove.add(foldPath(a));
        const cand = new Map();
        for (const rel of removed.values()) for (const a of ancestorsOf(rel)) if (!cand.has(foldPath(a))) cand.set(foldPath(a), a);
        const emptied = new Set();
        for (const d of Array.from(cand.values()).sort(function (a, b) { return b.split('/').length - a.split('/').length; })) {
          const k = foldPath(d);
          if (writeAbove.has(k) || atOrBelowAny(k, replaced)) continue;
          const listing = listings.get(d) || await listOne(d, false);
          if (refusal) return null;
          if (!listing || !listing.byName.size) continue;
          let all = true;
          for (const v of listing.byName.values()) {
            const e = foldPath(d + '/' + v.name);
            if (!((v.kind === 'file' && removed.has(e)) || (v.kind === 'dir' && emptied.has(e)))) { all = false; break; }
          }
          if (all) emptied.add(k);
        }
        const gone = function (k) { return emptied.has(k) || atOrBelowAny(k, replaced); };
        // a folder's entries after the reset: its listing (none for a folder the reset makes), less what the reset deletes
        // in it, plus what it adds
        const countAfter = function (rel, listing) {
          let n = listing ? listing.count : 0;
          if (listing) {
            for (const v of listing.byName.values()) {
              const e = foldPath(rel ? rel + '/' + v.name : v.name);
              if ((v.kind === 'file' && removed.has(e)) || (v.kind === 'dir' && emptied.has(e))) n--;
            }
          }
          return n + (added.get(foldPath(rel)) || 0);
        };
        let total = 0;
        // the walk: every folder it listed that is still there, and every folder the reset makes inside one it enters that
        // no rule prunes
        for (const [rel, listing] of listings) {
          const k = foldPath(rel);
          if (walkListed.has(k) && !gone(k)) total += countAfter(rel, listing);
        }
        const prunedMadeSet = new Set(prunedMade.map(foldPath));
        const enteredAfter = function (rel) {
          for (let k = foldPath(rel); ; k = parentOf(k)) {
            if (!k || rulesOf.has(k)) return true;             // the root, or a folder the walk enters now (and its parents)
            if (!madeSet.has(k) || prunedMadeSet.has(k)) return false;
          }
        };
        for (const m of made) if (enteredAfter(m) && !atOrBelowAny(foldPath(m), prunedMadeSet)) total += countAfter(m, null);
        // the checks: every folder on the way to a path below one the walk does not enter (a pruned folder, one the reset makes
        // that a rule prunes, inside an embedded repository; a link is never followed), as it stands after the reset
        const roots = new Set(prunedDirs.concat(prunedMade).map(foldPath)), inside = new Set(nestedDirs.map(foldPath));
        const onDemand = new Set();
        for (const p of undoPaths) {
          for (const a of ancestorsOf(p)) {
            const k = foldPath(a);
            if (onDemand.has(k)) continue;
            onDemand.add(k);
            if (!atOrBelowAny(k, roots) && !(atOrBelowAny(k, inside) && !inside.has(k))) continue;
            if (gone(k)) continue;
            if (madeSet.has(k)) { total += countAfter(a, null); continue; }
            const at = await entryAt(a);
            if (refusal) return null;
            if (!at || at.kind !== 'dir') continue;          // nothing there, a file or a link: no folder to list
            const listing = listings.get(at.rel) || await listOne(at.rel, false);
            if (refusal) return null;
            if (listing) total += countAfter(at.rel, listing);
          }
        }
        return total;
      }
      // the header's caseRefusal
      async function caseRefusal(writes, removes, opts) {
        const gitlinkUnder = opts && typeof opts.gitlinkUnder === 'function' ? opts.gitlinkUnder : null;
        const gitlinkBack = opts && typeof opts.gitlinkBack === 'function' ? opts.gitlinkBack : null;
        const rewrites = (opts && opts.rewrites) || [];
        const lettered = function (n) { return /[A-Za-z]/.test(n); };
        const parentOf = function (p) { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : String(p).slice(0, i); };
        const childOf = function (rel, name) { return rel ? rel + '/' + name : name; };
        const outside = function (rel) { return !inNested(rel) && !inGitFolder(rel); };
        // what the reset deletes (folded path -> on-disk rel): files, and the empty folder of each gitlink it drops, which Git removes too; a
        // folder that stands where it deletes a gitlink, or writes a gitlink or a FILE, changes the entries of the folder above it (undo review 10);
        // respelled: the first path in play that a tree spells otherwise than the disk (SPELLED, below)
        const removed = new Map(), dropped = new Map(), changedBy = [];
        let respelled = null;
        for (const r of removes) {
          const at = await entryAt(r);
          if (refusal) return null;
          if (at && !respelled && at.rel !== String(r)) respelled = { have: at.rel, want: String(r), back: true };
          if (at && at.kind === 'file') removed.set(foldPath(at.rel), at.rel);
          else if (at && at.kind === 'dir') {
            const listing = listings.get(at.rel) || await listOne(at.rel, false);
            if (refusal) return null;
            if (listing && !listing.byName.size) dropped.set(foldPath(at.rel), at.rel);
            changedBy.push(parentOf(at.rel));
          }
        }
        const writeOn = new Set(), writeAt = new Set();     // folded: every write and the folders above it / every write
        for (const w of writes) { writeAt.add(foldPath(w)); writeOn.add(foldPath(w)); for (const a of ancestorsOf(w)) writeOn.add(foldPath(a)); }
        // whether anything but a folder stands at any depth below the folder rel: one that holds only folders that hold nothing no capture records either
        const holdsFile = async function (rel) {
          const listing = listings.get(rel) || await listOne(rel, false);
          if (!listing) return false;
          for (const v of listing.byName.values()) if (v.kind !== 'dir' || await holdsFile(childOf(rel, v.name))) return true;
          return false;
        };
        // the entries the reset adds to a folder that stands now (on-disk rel -> names): a write's first component no listing holds, or a file
        // there the reset deletes first (a case-only rename, or a FILE it makes a folder of); the folders it makes below that one (folded ->
        // { rel, names: what it will hold }); each folder that holds no file where it writes a FILE or a gitlink (folded -> rel); and, where Git stops
        // if it cannot (undo review 11: STOPS, below), each folder that holds one where it writes a FILE (swapDirs) and each FILE it makes a folder of (swapFiles)
        const added = new Map(), made = new Map(), atEmpty = new Map(), swapDirs = [], swapFiles = new Set();
        for (const w of writes) {
          const parts = String(w).split('/');
          let rel = '';
          for (let i = 0; i < parts.length; i++) {
            const listing = listings.get(rel) || await listOne(rel, false);
            if (refusal) return null;
            if (!listing) break;
            const v = listing.byName.get(parts[i]) || (foldCase ? listing.byFold.get(foldName(parts[i])) : null);
            const here = v ? childOf(rel, v.name) : '';
            if (!v || (v.kind === 'file' && removed.has(foldPath(here)))) {
              if (!added.has(rel)) added.set(rel, new Set());
              added.get(rel).add(parts[i]);
              if (v && i < parts.length - 1) swapFiles.add(here);
              for (let j = i; j < parts.length - 1; j++) {
                const m = childOf(rel, parts.slice(i, j + 1).join('/')), mk = foldPath(m);
                if (!made.has(mk)) made.set(mk, { rel: m, names: new Set() });
                made.get(mk).names.add(parts[j + 1]);
              }
              break;
            }
            const spelledSo = !respelled && v.name !== parts[i] ? { have: here, want: parts.slice(0, i + 1).join('/'), back: false } : null;
            if (v.kind === 'dir' && i === parts.length - 1) {   // a FILE, or a gitlink, where a folder stands
              changedBy.push(rel);
              const at = listings.get(here) || await listOne(here, false);
              if (refusal) return null;
              const files = at ? await holdsFile(here) : false;
              if (refusal) return null;
              if (files && outside(here)) { swapDirs.push(here); break; }   // a FILE: that folder goes, however it is spelled
              if (at && !files) atEmpty.set(foldPath(here), here);
              if (spelledSo) respelled = spelledSo;
              break;
            }
            if (spelledSo) respelled = spelledSo;
            if (v.kind !== 'dir') break;                    // written over in place
            rel = here;
          }
        }
        for (const p of rewrites) {
          if (respelled) break;
          const at = await entryAt(p);
          if (refusal) return null;
          if (at && at.rel !== String(p)) respelled = { have: at.rel, want: String(p), back: false };
        }
        // the folders the reset empties, deepest first (Git removes a folder once it has deleted all it held): as afterReset, and a gitlink's
        // empty folder it drops is gone too
        const cand = new Map();
        for (const rel of Array.from(removed.values()).concat(Array.from(dropped.values()))) for (const a of ancestorsOf(rel)) if (!cand.has(foldPath(a))) cand.set(foldPath(a), a);
        const emptied = new Set();
        const goneDir = function (e) { return emptied.has(e) || dropped.has(e); };
        for (const d of Array.from(cand.values()).sort(function (a, b) { return b.split('/').length - a.split('/').length; })) {
          const k = foldPath(d);
          if (writeOn.has(k)) continue;
          const listing = listings.get(d) || await listOne(d, false);
          if (refusal) return null;
          if (!listing || !listing.byName.size) continue;
          let all = true;
          for (const v of listing.byName.values()) {
            const e = foldPath(childOf(d, v.name));
            if (!((v.kind === 'file' && removed.has(e)) || (v.kind === 'dir' && goneDir(e)))) { all = false; break; }
          }
          if (all) emptied.add(k);
        }
        // and each folder where it writes a FILE, with every folder below it: entry.c's remove_subtree deletes what it holds before the FILE is written
        const swapped = new Map();                          // folded -> on-disk rel
        for (const level = swapDirs.slice(); level.length;) {
          const d = level.pop(), listing = listings.get(d) || await listOne(d, false);
          if (refusal) return null;
          swapped.set(foldPath(d), d);
          if (listing) for (const v of listing.byName.values()) if (v.kind === 'dir') level.push(childOf(d, v.name));
        }
        const mustGo = function (k) { return emptied.has(k) || swapped.has(k); };
        // the folders whose entries change (the header's caseRefusal), and the names one holds after the reset
        const changed = new Map();
        const change = function (rel) { if (!changed.has(foldPath(rel))) changed.set(foldPath(rel), rel); };
        for (const rel of added.keys()) change(rel);
        for (const rel of removed.values()) change(parentOf(rel));
        for (const k of emptied) change(parentOf(cand.get(k)));
        for (const rel of changedBy) change(rel);
        const afterOf = function (rel, listing) {
          const after = [];
          for (const v of listing.byName.values()) {
            const e = foldPath(childOf(rel, v.name));
            if (!((v.kind === 'file' && removed.has(e)) || (v.kind === 'dir' && goneDir(e)))) after.push(v.name);
          }
          for (const n of (added.get(rel) || [])) after.push(n);
          return after;
        };
        const checked = [];                                 // [k, rel, listing, after, gone]: each folder whose entries change, as it stands now
        for (const [k, rel] of changed) {
          if ((k && atOrBelowAny(k, writeAt)) || inNested(rel) || inGitFolder(rel)) continue;   // replaced by what the reset writes there, or never written
          const listing = listings.get(rel);
          if (!listing) return { dir: rel, why: 'unasked' };
          const after = afterOf(rel, listing);
          checked.push([k, rel, listing, after, emptied.has(k) || (!rel && !after.length)]);
        }
        // LETTERS: a folder that holds something before the reset and after it, a name with a letter A-Z on one side only
        for (const [, rel, listing, after, gone] of checked) {
          if (!gone && listing.byName.size && after.length && Array.from(listing.byName.keys()).some(lettered) !== after.some(lettered)) return { dir: rel, why: 'letters' };
        }
        // PARTIAL (undo review 11): a folder Git must remove (one the reset empties, one where it writes a FILE, or the root it leaves holding nothing)
        // that holds a name with no letter A-Z, unless that name is all it holds and is a file or a folder that goes too. Git leaves a file another
        // program holds open (it only warns: an incomplete rewind), and a folder that is another program's working folder or read-only, so such a
        // folder can stand holding what Git left, and its undo, writing the rest back beside it, could not ask it (UNASKED) or would find it
        // holding names with no letter on one side only (LETTERS), on every try
        const goingNow = checked.filter(function (c) { return c[4]; }).map(function (c) { return c[1]; }).concat(Array.from(swapped.values()));
        for (const rel of goingNow) {
          const listing = listings.get(rel);
          if (!listing || !listing.byName.size) continue;
          const names = Array.from(listing.byName.values()), odd = names.find(function (v) { return !lettered(v.name); });
          if (!odd || (names.length === 1 && (odd.kind === 'file' || (odd.kind === 'dir' && mustGo(foldPath(childOf(rel, odd.name))))))) continue;
          return { dir: rel, why: 'partial', name: childOf(rel, odd.name) };
        }
        // U (undo review 11): the folders that hold nothing which the reset writes into (EMPTY, below), those that hold no file where it writes a FILE or a gitlink (AT),
        // and each folder that holds only such: its undo empties or deletes every one of them, and Git removes the folders that leaves holding
        // nothing, so the folder above the top of each chain of them holds, after its undo, its names less those
        const uMember = new Map(), uHeld = new Map();       // folded -> on-disk rel: a folder of U the reset writes into or at / one holding only those
        for (const [k, rel, listing] of checked) if (!listing.byName.size) uMember.set(k, rel);
        for (const [k, rel] of atEmpty) if (outside(rel)) uMember.set(k, rel);
        const inU = function (k) { return uMember.has(k) || uHeld.has(k); };
        const ups = new Map();
        for (const rel of uMember.values()) if (rel) for (const a of [''].concat(ancestorsOf(rel))) ups.set(foldPath(a), a);
        for (let grew = true; grew;) {
          grew = false;
          for (const [kp, p] of ups) {
            const l = listings.get(p);
            if (inU(kp) || !l || !l.byName.size) continue;
            if (Array.from(l.byName.keys()).every(function (n) { return inU(foldPath(childOf(p, n))); })) { uHeld.set(kp, p); grew = true; }
          }
        }
        const topOf = function (rel) { let top = rel; while (top && inU(foldPath(parentOf(top)))) top = parentOf(top); return top; };   // '': up to the root
        // the folder above `top` when it holds besides its folders of U no name with a letter A-Z (its undo would leave it so), else null
        const unlettered = function (top) {
          const p = parentOf(top), up = listings.get(p);
          if (!up) return p;
          return Array.from(up.byName.keys()).some(function (n) { return lettered(n) && !inU(foldPath(childOf(p, n))); }) ? null : p;
        };
        const tAsk = [];                                    // { rel: as the target spells it, '' its whole tree; dir; why; at }: its gitlinks, asked below
        // UNASKED: one that holds something now and was not asked, unless the reset empties it; EMPTY: one that holds nothing now, which the reset
        // writes into, the folder above the top of its chain in U holding besides them a name with a letter A-Z; where that chain reaches the root,
        // the whole target counts as written there
        for (const [k, rel, listing, , gone] of checked) {
          if (listing.byName.size) { if (!gone && !askedDirs.has(k)) return { dir: rel, why: 'unasked' }; continue; }
          const top = topOf(rel), p = top ? unlettered(top) : null;
          if (p != null) return { dir: rel, why: 'empty', detail: 'parent', name: p };
          tAsk.push({ rel: top ? rel : '', dir: rel, why: 'empty' });
        }
        // AT (undo review 11): a folder that holds no file where the reset writes a FILE (Git removes the folder for it) or a gitlink (Git leaves it as
        // the gitlink's folder): its undo deletes the one and drops the other, Git removing that folder, and no capture made it again. So, as EMPTY: the
        // folder above the top of its chain in U holds besides them a name with a letter A-Z, and where that chain reaches the root the target
        // records no gitlink anywhere (its undo would leave the root holding nothing: ROOT LEFT EMPTY)
        for (const rel of atEmpty.values()) {
          if (!outside(rel)) continue;
          const top = topOf(rel), p = top ? unlettered(top) : null;
          if (p != null) return { dir: rel, why: 'empty', at: true, detail: 'parent', name: p };
          if (!top) tAsk.push({ rel: '', dir: rel, why: 'empty', at: true });
        }
        // ITS UNDO'S OWN (undo review 11): what that undo counts on Git removing, every folder the reset makes and every folder of U but those it writes
        // at, as PARTIAL and STANDING (below) ask it of that undo: no name with no letter A-Z there beside another, and no gitlink the target records there
        const undoGone = Array.from(made.values());
        for (const [k, rel] of uMember) if (!atEmpty.has(k)) undoGone.push({ rel: rel, names: added.get(rel) || [] });
        for (const rel of uHeld.values()) undoGone.push({ rel: rel, names: afterOf(rel, listings.get(rel)) });
        for (const g of undoGone) {
          const names = Array.from(g.names), odd = names.find(function (n) { return !lettered(n); });
          if (odd && names.length > 1) return { dir: g.rel, why: 'partial', undo: true, name: childOf(g.rel, odd) };
        }
        for (const m of made.values()) {
          const pk = foldPath(parentOf(m.rel));
          if (!made.has(pk) && !atOrBelowAny(foldPath(m.rel), uMember) && !atOrBelowAny(foldPath(m.rel), uHeld)) tAsk.push({ rel: m.rel, dir: m.rel, why: 'made' });
        }
        for (const rel of uHeld.values()) if (rel && !inU(foldPath(parentOf(rel)))) tAsk.push({ rel: rel, dir: rel, why: 'made' });
        // ROOT LEFT EMPTY: its undo writes into a folder that holds nothing, so the reset may drop no gitlink there (EMPTY, above)
        const rootListing = listings.get('');
        const rootLeftEmpty = !!(rootListing && rootListing.byName.size && !afterOf('', rootListing).length);
        if (dropped.size && rootLeftEmpty) return { dir: '', why: 'rootEmpty', name: Array.from(dropped.values())[0] };
        // CASE APART: a folder that reads case apart, unless the reset deletes every entry it holds, each spelled as it stands at every component
        // of its path, and writes nothing at or below it (so Git removes it: HELD, below, asks that it can)
        const dueExact = new Set(removes.map(String));
        const emptiedExactly = function (rel) {
          const k = foldPath(rel), listing = listings.get(rel);
          if ((rel ? writeOn.has(k) : writes.length > 0) || !listing || !listing.byName.size) return false;
          for (const v of listing.byName.values()) {
            const p = childOf(rel, v.name);
            if (v.kind === 'file' ? !dueExact.has(p) : (v.kind !== 'dir' || !emptiedExactly(p))) return false;
          }
          return true;
        };
        const exempt = [];
        for (const a of apart) {
          if (!outside(a.rel)) continue;                    // Git never reads there, and a rewind writes and deletes nothing there
          if (!emptiedExactly(a.rel)) return { dir: a.rel, why: 'apart', name: a.name, flipped: a.flipped };
          exempt.push(a.rel);
        }
        // SPELLED (undo review 11): every path the reset deletes or writes is spelled as the disk spells each component that stands, but a file it
        // deletes first (a case-only rename between the two trees). Git keeps the spelling a path first had (core.ignorecase), so a name renamed in
        // another case since stays so in every capture: its undo brought Src/x.txt back where src/x.txt stood, or, src left standing, was refused
        if (respelled) return { dir: respelled.have, why: 'spelled', want: respelled.want, back: respelled.back };
        // TWO SPELLINGS (undo review 11): no two of the paths the reset writes spell one name two ways Git reads as one, which no disk asks where it makes
        // that folder: it would write one through the other's spelling, which its undo would meet as SPELLED (what it deletes, SPELLED has asked)
        const spelledAs = new Map();
        for (const w of writes) {
          for (const q of ancestorsOf(w).concat([String(w)])) {
            const g = gitFold(q), first = spelledAs.get(g);
            if (first === undefined) spelledAs.set(g, q);
            else if (first !== q) return { dir: '', why: 'twins', name: first, other: q };
          }
        }
        // the target's gitlinks where EMPTY, AT and ITS UNDO'S OWN ask, one folder at a time; a listing the runner's limit cuts off is no answer
        for (const t of tAsk) {
          const linked = gitlinkUnder ? await gitlinkUnder(t.rel) : null;
          if (linked !== false) return { dir: t.dir, why: t.why, at: !!t.at, whole: !t.rel && !!t.dir, detail: linked ? 'gitlink' : 'unlisted' };
        }
        // STANDING (undo review 11): a folder Git must remove can stand (another program's working folder; a read-only folder, whose attribute Git
        // for Windows' rmdir never clears) holding nothing, and its undo writes into it all the reset deleted there, which EMPTY asks of that undo. So the
        // pre-restore tree's gitlinks, below each such folder no other holds, or all of it where the reset leaves the root holding nothing (its undo
        // writes into that root, as into a folder that holds nothing): what that undo's EMPTY will ask of Git
        const tops = [];
        for (const [k, rel] of cand) if (emptied.has(k) && outside(rel) && !mustGo(foldPath(parentOf(rel)))) tops.push(rel);
        for (const rel of swapped.values()) if (!mustGo(foldPath(parentOf(rel)))) tops.push(rel);
        for (const rel of rootLeftEmpty ? [''] : tops) {
          const linked = gitlinkBack ? await gitlinkBack(rel) : null;
          if (linked !== false) return { dir: rel, why: 'standing', detail: linked ? 'gitlink' : 'unlisted' };
        }
        // HELD (undo review 11): a folder that reads case apart which the reset empties exactly (CASE APART's exception) stands, reading so, where
        // Git leaves in it a file another program holds open or a folder that is another program's working folder or read-only, and its undo
        // writing into it is refused on every try. Each file and folder below it is asked, as late as the checks go (heldBelow)
        for (const rel of exempt) {
          if (exempt.some(function (o) { return o !== rel && (!o || atOrBelow(rel, foldPath(o))); })) continue;   // asked with the folder holding it
          const held = await heldBelow(rel, false);
          if (refusal) return null;
          if (held) return { dir: rel, why: 'held', name: held };
        }
        // STOPS (undo review 11): where the reset writes a FILE at a folder or makes a folder of a FILE, Git cannot go on if that folder or FILE, or
        // anything below it, will not go: unlike a deletion it only warns about, it stops there (remove_subtree, create_directories), every deletion
        // done and the writes after that path not, a state no check above was made for: a folder left holding only names with no letter A-Z, its
        // lettered name deleted and the one to come never written, whose undo was refused on every try. Asked the same way, as late as the checks go
        for (const rel of swapDirs.concat(Array.from(atEmpty.values()))) {
          if (!outside(rel)) continue;
          const held = await heldBelow(rel, true);
          if (refusal) return null;
          if (held) return { dir: rel, why: 'stops', name: held };
        }
        for (const rel of swapFiles) if (winPaths && await inUse(absOf(rel), false)) return { dir: rel, why: 'stops', name: rel };
        // IN USE (undo review 12): every file the reset deletes or writes over, asked the same way, as late as the checks go. Git only warns of a file it
        // cannot delete, the rewind left incomplete with that file standing, where the target's rules, now on disk, ignore it for its undo, which was
        // refused on every try; and it stops at a file it cannot write over, its index left as the capture staged it while the work tree holds the
        // target's, which no check of its undo was made for (a case-only rename the undo met as SPELLED, a folder of the target's it took for one no
        // capture took). So no such file may be in use: the rewind is refused until it is let go
        if (winPaths) {
          const asked = Array.from(removed.values()).map(function (rel) { return { rel: rel, over: false }; });
          for (const p of rewrites) {
            const at = await entryAt(p);
            if (refusal) return null;
            if (at && at.kind === 'file') asked.push({ rel: at.rel, over: true });
          }
          for (let i = 0; i < asked.length; i += 32) {
            const busy = await Promise.all(asked.slice(i, i + 32).map(function (f) { return inUse(absOf(f.rel), false).then(function (u) { return u ? f : null; }); }));
            const held = busy.find(Boolean);
            if (held) return { dir: held.rel, why: 'inuse', name: held.rel, over: held.over };
          }
        }
        return null;
      }
      // the header's heldBelow
      async function heldBelow(rel, own) {
        if (!winPaths) return '';                         // POSIX deletes what another program has open
        if (own && await inUse(absOf(rel), true)) return rel;
        const level = [rel];
        while (level.length) {
          const d = level.pop(), listing = listings.get(d) || await listOne(d, false);
          if (refusal) return '';
          if (!listing) return d || '.';
          for (const v of listing.byName.values()) {
            const p = d ? d + '/' + v.name : v.name;
            if (v.kind !== 'file' && v.kind !== 'dir') return p;   // the checks before it hold none such: no answer
            if (await inUse(absOf(p), v.kind === 'dir')) return p;
            if (v.kind === 'dir') level.push(p);
          }
        }
        return '';
      }
      return { ok: true, links: links, gitLinks: gitLinks, gitFolders: gitFolders, gitFiles: gitFiles, prunedDirs: prunedDirs,
        keptOut: keptOut, nestedDirs: nestedDirs, walkPath: walkPath, linkOnPath: linkOnPath, entryAt: entryAt, gitHolders: gitHolders, contents: contents, linksBelow: linksBelow,
        spelledApart: spelledApart, aliasOn: aliasOn, prunedOnChain: prunedOnChain, afterReset: afterReset, caseRefusal: caseRefusal, ignoreNotes: function () { return ignoreNotes.slice(); },
        foldedTwo: function () { return foldedTwo; }, attributeFiles: function () { return attributeFiles.slice(); },
        caseTwins: function () {
          let first = null;
          for (const t of twins.values()) if (!inNested(t.rel) && !inGitFolder(t.rel) && (!first || byText(t.rel, first.rel) < 0)) first = t;
          return first;
        },
        count: function () { return entries; }, refusal: function () { return refusal; } };
    }
    // a link's anchored, escaped info/exclude pattern (every wildcard, escape, comment/negation lead and space quoted)
    const excludePattern = (rel) => '/' + String(rel).replace(/[\\*?[\]!# ]/g, '\\$&');
    // a path as Git prints it with core.quotePath=false (quote.c quote_c_style): raw, unless it holds `"`, `\` or a control
    // character, then double-quoted with C escapes (\a \b \t \n \v \f \r, else three-digit octal)
    const C_ESCAPES = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r' };
    function gitQuoted(p) {
      const s = String(p);
      if (!/["\\\x00-\x1f\x7f]/.test(s)) return s;
      return '"' + s.replace(/["\\\x00-\x1f\x7f]/g, function (ch) {
        const c = ch.charCodeAt(0);
        if (ch === '"' || ch === '\\') return '\\' + ch;
        return '\\' + (C_ESCAPES[c] || ('00' + c.toString(8)).slice(-3));
      }) + '"';
    }
    // a literal pathspec for a work-tree path; case-folded where the file system folds case, by Git's own fold: A-Z alone
    // (a lookup of a name with another letter that has a case: listUnder, namesReadApart)
    const literalSpec = (rel, extra) => ':(' + (extra ? extra + ',' : '') + 'literal' + (foldCase ? ',icase' : '') + ')' + rel;
    /* listUnder — the paths the shadow index (and, given `sha`, that tree too: `ls-files -z --with-tree=<sha>`) holds at or
       below any of `prefixes`: literal pathspecs on the command line (case-folded where the file system folds case), or,
       past a command-line length, the whole listing filtered here by the same rule. NEVER ONE CAPPED CALL (final review
       2): a listing past the runner's output limit (a captured node_modules below a folder a .gitignore now prunes) is
       asked again of the index's own tree (write-tree) and of `sha`, each by treeUnder, and the two joined. The single
       call refused the undo of a completed rewind (link_check_failed) whose target's .gitignore pruned the folder holding
       every file the undo row brings back, and skipped every capture while such a folder was tracked.
       NAMES OUTSIDE A-Z (undo review 7): Git's fold misses a tracked Uebung/x.txt (U-umlaut) below the junction uebung (u-umlaut), which
       the file system reads as one with it, so a prefix holding a letter outside ASCII is answered from Git's list of the paths
       holding one (oddNames: as long as those names, never the whole tree), filtered here by foldPath, and fails past the limit.
       -> string[] | null (Git failed, one folder's own entry list passed the limit: namesIn's NOT COVERED, or the list of paths
          holding a letter outside ASCII did) */
    async function listUnder(runIn, prefixes, sha) {
      const unfolded = foldCase ? prefixes.filter(function (p) { return holdsNonAscii(p); }) : [];
      const plain = unfolded.length ? prefixes.filter(function (p) { return !holdsNonAscii(p); }) : prefixes;
      const found = plain.length ? await listFolded(runIn, plain, sha) : [];
      if (!unfolded.length || !found) return found;
      const names = await oddNames(runIn, UNFOLDED_SPECS, sha);
      if (!names) return null;
      const wanted = new Set(unfolded.map(foldPath)), seen = new Set(found);
      for (const p of names) if (!seen.has(p) && atOrBelowAny(foldPath(p), wanted)) { seen.add(p); found.push(p); }
      return found;
    }
    // the paths the shadow index (given `sha`, that tree too) holds that these glob pathspecs match -> string[] | null (Git failed,
    // or their names alone passed the output limit)
    async function oddNames(runIn, specs, sha) {
      const r = await runIn(['ls-files', '-z'].concat(sha ? ['--with-tree=' + sha] : [], ['--'], specs));
      return r && r.code === 0 && !r.truncated ? nulNames(r) : null;
    }
    async function listFolded(runIn, prefixes, sha) {
      const args = ['ls-files', '-z'].concat(sha ? ['--with-tree=' + sha] : []);
      const specs = prefixes.map(function (p) { return literalSpec(p); });
      const whole = specs.join(' ').length >= 6000;
      const r = await runIn(whole ? args : args.concat(['--'], specs));
      if (r && r.code === 0 && !r.truncated) {
        const paths = nulNames(r);
        if (!whole) return paths;
        const wanted = prefixes.map(foldPath);
        return paths.filter(function (p) { return wanted.some(function (w) { return atOrBelow(p, w); }); });
      }
      if (!r || !r.truncated) return null;
      const index = await indexTree(runIn);
      if (!index) return null;
      const out = [], seen = new Set();
      for (const t of sha && sha !== index ? [index, sha] : [index]) {
        const found = await treeUnder(runIn, t, prefixes, false);
        if (!found) return null;
        for (const p of found) if (!seen.has(p)) { seen.add(p); out.push(p); }
      }
      return out;
    }
    // the shadow index as a tree (write-tree: tree objects in the checkpoint's own store only) -> sha | null
    async function indexTree(runIn) {
      const wt = await runIn(['write-tree']);
      const sha = String((wt && wt.stdout) || '').trim();
      return wt && wt.code === 0 && cp.isValidId(sha) ? sha : null;
    }
    /* gitlinksAtOrBelow — the gitlinks the shadow index records at or below any of these folders, as it spells them:
       ls-files -s, or past the runner's output limit (a captured folder of 100k files the target holds as a FILE) the
       index's own tree by treeUnder's records, never one capped call (final review 2: the single call refused the undo
       of a completed rewind that had turned that file into the folder). -> string[] | null */
    async function gitlinksAtOrBelow(runIn, dirs) {
      const r = await runIn(['ls-files', '-z', '-s', '--'].concat(dirs.map(function (d) { return literalSpec(d); })));
      let recs = null;
      if (r && r.code === 0 && !r.truncated) recs = String(r.stdout || '').split('\0');
      else if (r && r.truncated) {
        const index = await indexTree(runIn);
        recs = index ? await treeUnder(runIn, index, dirs, true) : null;
      }
      if (!recs) return null;
      return recs.filter(function (rec) { return rec.slice(0, 7) === '160000 '; }).map(function (rec) { return rec.slice(rec.indexOf('\t') + 1); });
    }
    // run `git <args> <pathspecs>`: on the command line while short, else from a NUL-separated file in the shadow git-dir
    async function gitWithPathspecs(runIn, gitDir, args, specs) {
      if (specs.join(' ').length < 6000 && !specs.some(function (s) { return /[\r\n]/.test(s); })) return runIn(args.concat(['--'], specs));
      const file = pathMod.join(gitDir, 'starnet-capture.pathspec');
      fs.writeFileSync(file, specs.join('\0') + '\0');
      try { return await runIn(args.concat(['--pathspec-from-file=' + file, '--pathspec-file-nul'])); }
      finally { try { fs.unlinkSync(file); } catch (e) { failNote('checkpoint.links.pathspec', e); } }
    }
    // a pathspec that leaves out everything BELOW a path but not the path itself (a gitlink, matched as a folder, survives
    // it). Glob specials are quoted in brackets: Git for Windows reads a backslash in a pathspec as a folder separator.
    const belowSpec = (rel) => ':(exclude,glob' + (foldCase ? ',icase' : '') + ')'
      + String(rel).replace(/[*?[\\]/g, function (ch) { return ch === '\\' ? '[\\\\]' : '[' + ch + ']'; }) + '/**';
    /* exactEntries — the records `git <args>` (ls-files -z, with -s or --with-tree=<sha>) lists AT each of `paths`, never
       below one: per path depth (a shallower path's belowSpec would hide a deeper one), each path's literal pathspec plus its
       belowSpec, chunked under a command-line length. Callers still match each record's path exactly. -> string[] | null */
    async function exactEntries(runIn, args, paths) {
      const byDepth = new Map();
      for (const p of paths) { const k = String(p).split('/').length; if (!byDepth.has(k)) byDepth.set(k, []); byDepth.get(k).push(String(p)); }
      const out = [];
      for (const k of Array.from(byDepth.keys()).sort(function (a, b) { return a - b; })) {
        const group = byDepth.get(k);
        for (let i = 0; i < group.length;) {
          const specs = [];
          for (let len = 0; i < group.length && (!specs.length || len < 6000); i++) { specs.push(literalSpec(group[i]), belowSpec(group[i])); len += 2 * group[i].length + 48; }
          const r = await runIn(args.concat(['--'], specs));
          if (!r || r.code !== 0 || r.truncated) return null;
          for (const rec of String(r.stdout || '').split('\0')) if (rec) out.push(rec);
        }
      }
      return out;
    }
    /* namesIn — the paths a `-z --name-only` listing (`git <args>`: diff-index, diff-tree) prints, every one of them at or
       below an entry of the tree `tree`, never depending on one capped call. The runner cuts a call off at its output limit
       (checkpoint-git.js maxBytes, 8 MB: about 120k paths, a captured node_modules) and answers truncated, so a whole
       listing that overflows is asked again per entry of the tree's root (literal pathspecs, a command line at a time),
       a batch that still overflows in halves, and one folder that still does per entry inside it (ls-tree <tree>:<folder>),
       down to one path. Review 6.2 (round 6's two listings refused the rewind after a big deletion, and reported a
       completed rewind as failed). Every other listing a capture or a rewind takes of a whole folder splits the same way
       (splitAsker): listUnder and gitlinksAtOrBelow by treeUnder (final review 2). NOT COVERED: a folder whose own entry
       list (that ls-tree, names only) passes the limit, a flat folder of roughly 150k-250k long names at 8 MB: the listing
       answers null, never a partial list, and a rewind that brings back or removes so many files of that one folder that
       their names alone pass the limit, or that must check them for links, is refused before anything is touched, with no
       undo row (restoreUncapturedConflicts, removedByReset, restoreLinkConflicts; a capture is skipped, health says why;
       deferred, the lane test header). So is any rewind to or from a tree holding such a folder on a Git older than 2.36, or
       past about a million records in that tree: linkRecords then lists every record from the root down.
       -> string[] | null (Git failed, or one folder's own entries passed the output limit) */
    async function namesIn(runIn, args, tree) {
      const whole = await runIn(args);
      if (whole && whole.code === 0 && !whole.truncated) return nulNames(whole);
      if (!whole || !whole.truncated) return null;
      const split = splitAsker(runIn, args, tree, nulNames);
      const top = await split.entries('');
      return top && top.length && (await split.askAll(top)) ? split.out : null;
    }
    /* namesBothWays — namesIn of `git <args> <a> <b>`, a listing that prints the same names with the two trees trading places (diff-tree
       --diff-filter=M), split, past the output limit, on `a` and then on `b`: a rewind asks it from the tree its capture staged, and its undo
       from the target's, so a folder whose own entry list fits in the one and not in the other refuses the rewind, never its undo (undo
       review 12: split on the staged tree alone, the rewind went ahead and its undo was refused on every try). One call while it fits.
         -> string[] | null */
    async function namesBothWays(runIn, args, a, b) {
      const whole = await runIn(args.concat([a, b]));
      if (whole && whole.code === 0 && !whole.truncated) return nulNames(whole);
      if (!whole || !whole.truncated) return null;
      let out = null;
      for (const [x, y] of [[a, b], [b, a]]) {
        const split = splitAsker(runIn, args.concat([x, y]), x, nulNames);
        const top = await split.entries('');
        if (!(top && top.length && (await split.askAll(top)))) return null;
        if (!out) out = split.out;
      }
      return out;
    }
    function nulNames(r) { return String((r && r.stdout) || '').split('\0').filter(Boolean); }
    /* splitAsker — namesIn's split, on its own: `git <args> -- <literal paths>` asked a command line at a time, a batch that
       overflows in halves, and one path that still does per entry inside it (ls-tree <tree>:<folder>, names only), each
       answer parsed by parse(r) into out. askAll(paths) -> false when Git failed or one folder's own entries overflowed */
    function splitAsker(runIn, args, tree, parse) {
      const out = [];
      const entries = async function (dir) {              // one folder's entries in `tree`, as full paths | null
        const r = await runIn(['ls-tree', '-z', '--name-only', dir ? tree + ':' + dir : tree]);
        return r && r.code === 0 && !r.truncated ? nulNames(r).map(function (n) { return dir ? dir + '/' + n : n; }) : null;
      };
      const ask = async function (chunk) {
        const r = await runIn(args.concat(['--'], chunk.map(function (p) { return ':(literal)' + p; })));
        if (r && r.code === 0 && !r.truncated) { for (const n of parse(r)) out.push(n); return true; }
        if (!r || !r.truncated) return false;
        if (chunk.length > 1) { const half = chunk.length >> 1; return (await ask(chunk.slice(0, half))) && ask(chunk.slice(half)); }
        const inside = await entries(chunk[0]);           // one folder whose own listing overflows: per entry inside it
        return !!(inside && inside.length) && askAll(inside);
      };
      const askAll = async function (paths) {
        for (let i = 0; i < paths.length;) {
          const chunk = [];
          for (let len = 0; i < paths.length && (!chunk.length || len < 6000); i++) { chunk.push(paths[i]); len += paths[i].length + 12; }
          if (!(await ask(chunk))) return false;
        }
        return true;
      };
      return { out: out, entries: entries, askAll: askAll };
    }
    /* treeUnder — every path (records: every `ls-tree -r` record) the tree `tree` holds at or below one of `prefixes`,
       folded where the file system folds case (as a literal icase pathspec matches), never depending on one capped call
       and never on the entry list of a folder ABOVE a prefix: each prefix as the tree spells it (spellings) asked by its
       literal path as namesIn asks a path (a command line at a time, a batch that overflows in halves, one folder that
       still does per entry inside it). So what a listing needs depends on each prefix's own subtree alone: a listing of
       more prefixes, or of a folder above one, needs every folder entry list a listing of fewer does. Undo review 1:
       it went down from the root, one folder's whole entry list at a time, so an undo whose pruned folder lay below a
       flat root (or a flat folder above it) of long names was refused (link_check_failed), a listing its rewind never
       took: the undo pruned a folder the reset had made, or listed a link's folder the rewind had not.
       -> string[] | null (Git failed, or one folder's own entry list at or below a prefix passed the output limit:
          namesIn's NOT COVERED) */
    async function treeUnder(runIn, tree, prefixes, records) {
      const parse = records ? function (r) { return String(r.stdout || '').split('\0').filter(function (rec) { return rec.indexOf('\t') > 0; }); } : nulNames;
      const split = splitAsker(runIn, ['ls-tree', '-r', '-z'].concat(records ? [] : ['--name-only'], [tree]), tree, parse);
      const spelled = await spellings(runIn, tree, prefixes);
      return spelled && (await split.askAll(spelled)) ? split.out : null;
    }
    const emptyTreeLike = (tree) => (String(tree).length === 64 ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    /* spellings — these paths as `tree` spells them: each as given and, where the file system folds case, every other
       spelling of it the tree holds, found by Git's own matching (diff-tree from the empty tree, a literal icase pathspec
       per path and every spelling found so far excluded): each complete record names one more, so no folder's entry list
       is ever read, and the loop ends when Git prints nothing more. -> string[] | null (Git failed) */
    async function spellings(runIn, tree, paths) {
      const out = Array.from(new Set(paths.map(String)));
      if (!foldCase || !out.length) return out;
      const empty = emptyTreeLike(tree);
      const asked = out.slice(), spelled = new Set(out);
      for (let i = 0; i < asked.length;) {
        const chunk = [];
        for (let len = 0; i < asked.length && (!chunk.length || len < 4000); i++) { chunk.push(asked[i]); len += asked[i].length + 24; }
        const mine = out.filter(function (s) { return chunk.some(function (c) { return foldPath(s) === foldPath(c); }); });
        for (;;) {
          const r = await runIn(['diff-tree', '-r', '-z', '--ignore-submodules=none', '--no-renames', '--name-only', empty, tree, '--']
            .concat(chunk.map(function (c) { return ':(literal,icase)' + c; }), mine.map(function (s) { return ':(exclude,literal)' + s; })));
          if (!r || (r.code !== 0 && !r.truncated)) return null;
          const recs = String(r.stdout || '').split('\0');
          recs.pop();                                     // '' after the last NUL, or a record the output limit cut off
          let more = 0;
          for (const rec of recs) {
            for (const c of chunk) {
              if (!atOrBelow(rec, foldPath(c))) continue;
              const s = rec.split('/').slice(0, c.split('/').length).join('/');
              if (!spelled.has(s)) { spelled.add(s); out.push(s); mine.push(s); more++; }
            }
          }
          if (!r.truncated) break;
          if (!more) return null;                         // cut off before one complete record of a new spelling
        }
      }
      return out;
    }
    /* looksLikeRepo — is this `.git` (a folder, or a `gitdir:` file) a repository by a check STRICTER than Git's own
       is_git_directory: a real folder (never a link) holding a HEAD that names a ref or an object id, objects/ and refs/,
       and no commondir (a worktree's git-dir keeps those elsewhere). Where it says no, Git may still call it one: the walk
       then enters a folder Git skips, never the reverse, and restore's check takes it for one anyway (gitRepoAt). A
       `.git` FILE is read exactly as Git reads it (setup.c read_gitfile_gently): the literal prefix "gitdir: " (one
       space), then the WHOLE rest of the file, with only its trailing CR and LF bytes removed, as the path (never trimmed,
       never cut at a line break). Anything else is no gitfile to Git, which then reads the folder like any other, so the
       walk enters it too. A ref HEAD allows only Git's own spaces (space, tab, CR, LF) after "ref:". */
    async function looksLikeRepo(dotGit) {
      const quiet = async function (p) {
        try { return await lstatAsync(p); }
        catch (e) { if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) failNote('checkpoint.links.nested', e); return null; }
      };
      const small = async function (p) {
        const st = await quiet(p);
        if (!st || !st.isFile() || st.size > 4096) return null;
        try { return await readText(p); } catch (e) { failNote('checkpoint.links.nested', e); return null; }
      };
      let gitDir = dotGit, st = await quiet(dotGit);
      if (st && st.isFile()) {
        const text = (await small(dotGit)) || '';
        if (text.slice(0, 8) !== 'gitdir: ') return false;
        const named = text.slice(8).replace(/[\r\n]+$/, '');
        if (!named) return false;
        gitDir = pathMod.resolve(pathMod.dirname(dotGit), named);
        st = await quiet(gitDir);
      }
      if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
      const head = await small(pathMod.join(gitDir, 'HEAD'));
      if (head == null || !(/^ref:[ \t\r\n]*refs\//.test(head) || /^[0-9a-f]{40}(?:[0-9a-f]{24})?(?:\s|$)/.test(head))) return false;
      if (await quiet(pathMod.join(gitDir, 'commondir'))) return false;
      const objects = await quiet(pathMod.join(gitDir, 'objects')), refs = await quiet(pathMod.join(gitDir, 'refs'));
      return !!(objects && objects.isDirectory() && refs && refs.isDirectory());
    }
    /* nestedRepos — which of these folders (each holds a `.git`) Git treats as an EMBEDDED REPOSITORY and never reads inside,
       by its own rule (dir.c treat_directory): one the shadow index records as a gitlink is never entered; one it tracks
       files below is walked like any folder, `.git` or not (a `git init` in a folder already captured); an untracked one
       whose `.git` is a repository is recorded as one gitlink (looksLikeRepo). The answer depends on the index alone, never
       on the runner's output limit (undo review 3: a listing cut off there answered "none", so an undo whose index, the
       target's, tracked a long flat folder below one such folder walked a clone beside it that its rewind had skipped,
       past the count its rewind took, and was refused). A call cut off settles each folder one of its complete records
       answered (a gitlink, or a path below it), and asks the other folders again, in halves down to one; a folder whose
       own call is cut off before a complete record cannot be answered. -> rel[] | null (Git failed, or a folder could not
       be answered: the walk is refused) */
    async function nestedRepos(runIn, workTree, rels) {
      const want = new Map(rels.map(function (r) { return [foldPath(r), r]; }));
      const indexed = new Map();                          // folded rel -> 'gitlink' | 'tree'
      const ask = async function (chunk) {
        const r = await runIn(['ls-files', '-z', '-s', '--'].concat(chunk.map(function (c) { return literalSpec(c); })));
        if (!r || (r.code !== 0 && !r.truncated)) return false;
        const recs = String(r.stdout || '').split('\0');
        recs.pop();                                       // '' after the last NUL, or a record the output limit cut off
        for (const rec of recs) {
          const tab = rec.indexOf('\t');
          if (tab < 0) continue;
          const p = foldPath(rec.slice(tab + 1));
          if (want.has(p)) { if (rec.slice(0, 7) === '160000 ' && !indexed.has(p)) indexed.set(p, 'gitlink'); continue; }
          for (const a of ancestorsOf(p)) if (want.has(a)) indexed.set(a, 'tree');
        }
        if (!r.truncated) return true;
        const rest = chunk.filter(function (c) { return !indexed.has(foldPath(c)); });
        if (!rest.length) return true;
        if (chunk.length === 1) return false;            // one folder, cut off before a complete record of it
        if (rest.length === 1) return ask(rest);
        const half = rest.length >> 1;                    // the rest in halves: a few calls, never one per folder
        return (await ask(rest.slice(0, half))) && ask(rest.slice(half));
      };
      for (let i = 0; i < rels.length;) {
        const chunk = [];
        for (let len = 0; i < rels.length && (!chunk.length || len < 6000); i++) { chunk.push(rels[i]); len += rels[i].length + 24; }
        if (!(await ask(chunk))) return null;
      }
      const out = [];
      for (const rel of rels) {
        const was = indexed.get(foldPath(rel));
        if (was === 'gitlink' || (!was && await looksLikeRepo(pathMod.join(workTree, rel, '.git')))) out.push(rel);
      }
      return out;
    }
    // the walk, with the shadow index at hand to name the embedded repositories, Git to say which of the folders a plain
    // rule of the work tree prunes it ignores (scanTree's opts.ignored), and, for a rewind, the target's own .gitignore
    // texts (targetIgnoreRules) and the folders that read case apart (scanTree's CASE APART)
    const scanFor = (workTree, gitDir, runIn, targetRules, probeCase) => {
      let cleared = false;
      return scanTree(workTree, {
        nested: function (rels) { return nestedRepos(runIn, workTree, rels); },
        ignored: async function (rels) {
          // asked with no line in the shadow repo's info/exclude: a line an earlier capture wrote (a link, a folder a rewind
          // kept out) is no rule of the work tree. Every capture and check writes its own lines again before Git reads it
          if (!cleared) { if (writeLinkExcludes(gitDir, [], [])) return null; cleared = true; }
          let ask = rels, below = [];
          let ci = await checkIgnored(runIn, ask.map(ignoreAsked), true);
          if (!ci.ok && ci.code === 128) {                 // one below a gitlink (its `.git` gone): Git never reads inside it
            const gitlinks = await gitlinksAbove(runIn, rels.map(function (r) { return { path: r }; }));
            if (gitlinks && gitlinks.length) {
              below = rels.filter(function (r) { return gitlinks.some(function (g) { return atOrBelow(r, g); }); });
              ask = rels.filter(function (r) { return below.indexOf(r) < 0; });
              ci = ask.length ? await checkIgnored(runIn, ask.map(ignoreAsked), true) : { ok: true, ignored: new Set() };
            }
          }
          if (!ci.ok) return null;
          return new Set(below.concat(ask.filter(function (r) { return ci.ignored.has(gitQuoted(ignoreAsked(r))); })));
        },
        targetRules: targetRules || null, probeCase: !!probeCase });
    };
    /* targetIgnoreRules — the TARGET's own .gitignore texts where they differ from the work tree's (diff-index, one glob
       pathspec; a .gitignore the target lacks is skipped), by folder (folded), for a rewind's walk (scanTree's
       targetRules, final review 2). A rewind leaves in place what no capture took; when the person's .gitignore pruned a
       folder the target's does not (a node_modules listed only since), the rewind's undo, a rewind to a point whose
       .gitignore does, walked that folder from the work tree's rules alone: past the walk's budget the undo was refused,
       and within it the undo's capture took the whole folder and its reset deleted it. With them its walk prunes the
       folder and its capture leaves it out, so it stays where it is. EVERY ONE OF THEM is read (ignoreTexts), never a
       count past which they are dropped (undo closure: past 32 changed .gitignore files the walk pruned by the work tree's
       rules alone, so a rewind across 33 of them completed and its undo, walking the node_modules the undo row's
       .gitignore listed, was refused).
       Where the file system folds case a `.GITIGNORE` is one too, as Git reads it there (IGNORE_FILES; undo review 2: the
       undo row's node_modules rule in a root `.GITIGNORE` was never read, and the undo took and deleted 40 files). In a
       folder that reads case apart Git does not read it, and a rewind is refused there (scanTree's CASE APART, undo review 9).
         -> Map(folded folder -> text) | null (none differs) | false (Git could not list or read them: the rewind is
            refused, as its walk could not be shown to prune what the target's .gitignore files prune) */
    const IGNORE_FILES = ':(glob' + (foldCase ? ',icase' : '') + ')**/.gitignore';
    async function targetIgnoreRules(runIn, sha) {
      const r = await runIn(['diff-index', '-z', '--no-renames', '--name-only', sha, '--', IGNORE_FILES]);
      if (!r || r.code !== 0 || r.truncated) return false;
      return ignoreTexts(runIn, sha, nulNames(r));
    }
    /* ignoreTexts — the text of each of these .gitignore paths in `treeish` (one it lacks, or holds as a link, has none),
       by folder (folded; two spellings of one folder joined, so either's names prune and either's negations count), for
       targetIgnoreRules and for the undo's own read before a rewind's commit. Every line of every one, a command line of
       pathspecs at a time in one `git grep -a` ("<treeish>:<path>\0<line>\n" per line, every config that would change
       that shape set back), whatever Git's binary detection or attributes say: with -I (undo review 1) a NUL byte in a
       .gitignore, or a .gitattributes marking it binary or -diff, made grep skip it, so its rules read as absent while Git
       and the walk still applied them, and an undo walked and emptied the node_modules its row's .gitignore lists. A
       batch whose output passes the runner's limit is asked again in halves, and one file still past it by its bytes
       alone (cat-file blob: no per-line prefix), so only a single .gitignore past the limit (8 MB) answers false.
         -> Map(folded folder -> text) | null (none of them is held) | false (Git could not list or read them) */
    async function ignoreTexts(runIn, treeish, paths) {
      const texts = await ignoreFiles(runIn, treeish, paths);
      if (!texts) return texts === false ? false : null;
      const rules = new Map();
      for (const [p, text] of texts) {
        const k = foldPath(p.lastIndexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '');
        rules.set(k, rules.has(k) ? rules.get(k) + '\n' + (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text) : text);
      }
      return rules.size ? rules : null;
    }
    // ignoreTexts' read, by path as `treeish` spells it -> Map(path -> text) | null (no path asked) | false
    async function ignoreFiles(runIn, treeish, paths) {
      if (!paths.length) return null;
      const texts = new Map(), prefix = treeish + ':';
      const read = async function (chunk) {
        const g = await runIn(['-c', 'grep.lineNumber=false', '-c', 'grep.column=false', '-c', 'grep.fullName=true', '-c', 'color.grep=never',
          'grep', '-z', '-a', '-F', '--no-color', '--full-name', '-e', '', treeish, '--'].concat(chunk.map(function (p) { return ':(literal)' + p; })));
        if (g && g.code === 1 && !g.truncated) {           // no line at all, only where each file asked is empty or not there: a Git killed from outside answers 1 too
          if (String(g.stdout || '')) return false;
          const sizes = await runIn(['ls-tree', '-z', '-l', treeish, '--'].concat(chunk.map(function (p) { return ':(literal)' + p; })));
          if (!sizes || sizes.code !== 0 || sizes.truncated) return false;
          return nulNames(sizes).every(function (rec) { return rec.slice(0, rec.indexOf('\t')).trim().split(/\s+/)[3] === '0'; });
        }
        if (g && g.code === 0 && !g.truncated) {
          const out = String(g.stdout || '');
          for (let at = 0; at < out.length;) {
            const nul = out.indexOf('\0', at), nl = nul < 0 ? -1 : out.indexOf('\n', nul + 1);
            if (nul < 0 || nl < 0 || out.slice(at, at + prefix.length) !== prefix) return false;
            const p = out.slice(at + prefix.length, nul);
            texts.set(p, (texts.has(p) ? texts.get(p) : '') + out.slice(nul + 1, nl) + '\n');
            at = nl + 1;
          }
          return true;
        }
        if (!g || !g.truncated) return false;
        if (chunk.length > 1) { const half = chunk.length >> 1; return (await read(chunk.slice(0, half))) && read(chunk.slice(half)); }
        const one = await runIn(['cat-file', 'blob', treeish + ':' + chunk[0]]);   // a regular file: grep printed its lines
        if (!one || one.code !== 0 || one.truncated) return false;
        texts.set(chunk[0], String(one.stdout || ''));
        return true;
      };
      for (let i = 0; i < paths.length;) {
        const chunk = [];
        for (let len = 0; i < paths.length && (!chunk.length || len < 6000); i++) { chunk.push(paths[i]); len += paths[i].length + 12; }
        if (!(await read(chunk))) return false;
      }
      return texts;
    }
    /* unfollowedRules — why a rewind that changes these .gitignore files (paths: where the undo row, `mine`, and the target,
       `theirs`, differ; their texts by path) cannot keep what they ignore in place both ways, or '' when it can. THE RULES A
       REWIND CHANGES (undo review 2): its capture goes by the rules of the work tree, and its undo's by the target's, so a
       file or folder only one side ignores is kept out of the other's capture by an info/exclude line (scanTree's keptOut,
       keptFile), which only a plain name gives. So a rule the rewind adds or removes must be one plain name (node_modules,
       dist/, /build, the same led by a double star), and no .gitignore of either side, nor any the walk read, may hold
       a negation (it can re-include what such a line keeps out, or the reverse) or a NUL byte (Git reads a line up to
       it). Rules the rewind does not change ignore the same paths on both sides, a glob too, so neither capture takes
       what the other leaves */
    function unfollowedRules(paths, mine, theirs, notes) {
      const read = function (texts, p) {
        const t = String((texts && texts.get(p)) || '');
        return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t;
      };
      for (const n of notes) if (n.negation || n.nul) return '"' + n.path + '" holds ' + (n.nul ? 'a NUL byte' : 'a negation (a line starting with !)');
      for (const p of paths) {
        const a = read(mine, p), b = read(theirs, p);
        if (a.indexOf('\0') >= 0 || b.indexOf('\0') >= 0) return '"' + p + '" holds a NUL byte';
        const la = ruleLines(a), lb = ruleLines(b), sa = new Set(la), sb = new Set(lb);
        const neg = la.concat(lb).find(function (l) { return l[0] === '!'; });
        if (neg) return '"' + p + '" holds the negation "' + neg.slice(0, 80) + '"';
        const changed = la.filter(function (l) { return !sb.has(l); }).concat(lb.filter(function (l) { return !sa.has(l); }));
        const odd = changed.find(function (l) { return !plainRule(l); });
        if (odd) return 'rewinding changes the rule "' + odd.slice(0, 80) + '" in "' + p + '", which is not one plain name';
      }
      return '';
    }
    // the gitlinks the shadow index records at a folder ABOVE any of these links (folded paths) | null
    async function gitlinksAbove(runIn, list) {
      const above = new Map();
      for (const l of list) for (const a of ancestorsOf(l.path)) above.set(foldPath(a), a);
      if (!above.size) return [];
      const recs = await exactEntries(runIn, ['ls-files', '-z', '-s'], Array.from(above.values()));
      if (!recs) return null;
      const out = [];
      for (const rec of recs) {
        const tab = rec.indexOf('\t');
        if (tab > 0 && rec.slice(0, 7) === '160000 ' && above.has(foldPath(rec.slice(tab + 1)))) out.push(foldPath(rec.slice(tab + 1)));
      }
      return out;
    }
    // A COMPLETE ANSWER, NOT AN EXIT CODE (undo review 8). check-ignore's 1 is its own "none ignored", and a launch that failed
    // answers -1 (checkpoint-git.js, undo review 7). But a Git killed from outside (taskkill /F, process.kill) ends with exit code 1 and no
    // output, and no runner can tell that from its own: the person's ignored file read as ignored by nothing and was written over or deleted,
    // ok:true on both calls. So each name is asked with -v -n, which prints one line per name whatever it answers (below: ruleNegated), and fewer whole lines
    // than names is no answer (the runner's output limit: in halves, as ignoreFiles asks). grep's 1 and rev-parse's 1 are read the same way (ignoreFiles, pinAttributes).
    // check-ignore takes -z only with --stdin (the runner gives Git no stdin) and no --literal-pathspecs; it matches each
    // name literally and prints it back, C-quoted when it holds a quote, a backslash or a control character.
    // noIndex (--no-index): whether the RULES exclude the path, its type read off disk. Plain check-ignore names no path its
    // index tracks a path at or below: a folder holding a tracked file, which Git adds nothing new from either way, and a
    // FILE where the index still tracks paths below its name (a folder at the last capture), which `add -A` does leave
    // out when a rule names it (undo review 6: restoreUncapturedConflicts asks every untracked file by the rules alone)
    async function checkIgnored(runIn, names, noIndex) {
      const ignored = new Set();
      // null | { ok:false, code }
      const ask = async function (chunk) {
        const ci = await runIn(['-c', 'core.quotePath=false', 'check-ignore', '-v', '-n'].concat(noIndex ? ['--no-index'] : [], ['--'], chunk));
        if (ci && ci.truncated && chunk.length > 1) { const half = chunk.length >> 1; return (await ask(chunk.slice(0, half))) || ask(chunk.slice(half)); }
        if (!ci || (ci.code !== 0 && ci.code !== 1)) return { ok: false, code: (ci && ci.code) != null ? ci.code : 'error' };
        // what follows the last newline is '', or a line a kill cut off: it counts for nothing
        const lines = String(ci.stdout || '').split('\n').slice(0, -1).map(function (l) { return l.replace(/\r$/, ''); });
        if (lines.length !== chunk.length) return { ok: false, code: 'an answer for ' + lines.length + ' of ' + chunk.length + ' names' };
        for (const line of lines) {
          const tab = line.lastIndexOf('\t'), negated = tab > 0 ? ruleNegated(line.slice(0, tab)) : null;
          if (negated == null) return { ok: false, code: 'an answer it could not read' };
          if (!negated) ignored.add(line.slice(tab + 1));
        }
        return null;
      };
      for (let i = 0; i < names.length;) {
        const chunk = [];
        for (let len = 0; i < names.length && (!chunk.length || len + names[i].length < 6000); i++) { chunk.push(names[i]); len += names[i].length + 1; }
        const failed = await ask(chunk);
        if (failed) return failed;
      }
      return { ok: true, ignored: ignored };
    }
    // the part before the tab of a line of check-ignore -v -n: "::" (no rule), or "<source>:<line>:<pattern>", the source C-quoted when
    // it holds a quote, a backslash or a control character. -> whether no rule ignores the name: true | false | null (an unquoted source
    // holding that shape itself could hide which)
    function ruleNegated(rule) {
      if (rule === '::') return true;
      const quoted = /^"(?:[^"\\]|\\.)*":\d+:(!?)/.exec(rule);
      if (quoted) return !!quoted[1];
      const marks = rule.match(/:\d+:!?/g) || [];
      const negs = marks.filter(function (m) { return m[m.length - 1] === '!'; }).length;
      return !marks.length || (negs && negs < marks.length) ? null : negs > 0;
    }
    // a path as check-ignore is asked it (a leading `:` would read as pathspec magic: `./:…`)
    const ignoreAsked = (p) => (p[0] === ':' ? './' + p : p);
    // the shadow repo's info/exclude: one anchored pattern per link, and per folder a rewind keeps out (scanTree's keptOut),
    // rewritten before every capture and before restore asks Git what it ignores (a link an earlier capture left out may be
    // a plain folder now; a normal capture keeps no folder out) -> null | why it could not be
    function writeLinkExcludes(gitDir, links, keptOut) {
      const kept = keptOut || [];
      if (links.some(function (l) { return /[\r\n]/.test(l.path); })) return 'a link\'s name holds a line break, so it cannot be left out';
      if (kept.some(function (p) { return /[\r\n]/.test(p); })) return 'a folder\'s name holds a line break, so it cannot be left out';
      try {
        fs.mkdirSync(pathMod.join(gitDir, 'info'), { recursive: true });
        /* the lines EXCLUDE_LINES put there (ensureExclude: the workspace repo never takes an attachment) are not the walk's to rewrite away:
           they are kept as they stand on disk, ahead of the links */
        let base = '';
        try {
          const have = new Set(fs.readFileSync(pathMod.join(gitDir, 'info', 'exclude'), 'utf8').split(/\r?\n/).map(function (l) { return l.trim(); }));
          base = EXCLUDE_LINES.filter(function (l) { return have.has(l); }).map(function (l) { return l + '\n'; }).join('');
        } catch (e) { if (!e || e.code !== 'ENOENT') failNote('checkpoint.exclude.read', e); }
        fs.writeFileSync(pathMod.join(gitDir, 'info', 'exclude'), EXCLUDE_HEADER + base + links.map(function (l) { return excludePattern(l.path) + '\n'; }).join('')
          + kept.map(function (p) { return excludePattern(p) + '\n'; }).join(''));
        return null;
      } catch (e) { return 'the list of links to leave out could not be written (' + String((e && e.code) || 'error').slice(0, 24) + ')'; }
    }
    /* pinAttributes — THE BYTES (undo review 7). The shadow repo's own info/attributes, Git's highest precedence over a
       .gitattributes anywhere in the work tree and the person's core.attributesFile, turns every conversion off, so Git stores
       and writes the bytes as they are: `text=auto` or an `eol` rule changed every line ending of a rewound and of an undone
       file (a shell script came back with CRLF, mixed endings were in no row), `ident` a $Id$, a filter or a
       working-tree-encoding what the blob held, each ok:true on both calls. An index an older store wrote holds the converted blob for
       a file whose stat it trusts, and `add -A` would keep that blob in the undo row: so the first operation on such a repo reads the index
       from the last commit again (`read-tree`; nothing but the shadow index changes; on a repo with no commit yet, only where Git lists
       no ref at all, as a Git killed from outside answers rev-parse's 1 too: undo review 8) and only then writes the file.
       BEFORE ANYTHING READS THE INDEX (undo review 8: readyShadowRepo, at the start of a capture and of a rewind). Read after a rewind's
       checks, it dropped what only the older index held: an `add -A` whose commit never ran, the FILE logs, counted as captured by the
       checks, then out of the capture as ignored, and gone: ok:true on both calls.
       EVERY TRACKED FILE HASHED ONCE, UNDER ITS OWN BOUND (undo review 8). A read index has no stat data, so the next `add -A` and `diff-index` hash every
       tracked file, past one call's 15 s from about 36000 files at 100% CPU; a killed add saves nothing, so every capture and rewind failed from
       then on. So `update-index --refresh` hashes them with the maintenance bound (runLong) and saves the stat data; REREAD_DUE marks that it is still
       due, and a capture or rewind past that bound too is refused and tries again next time. It stores nothing: a tracked path below a link standing since is read to compare it, as
       Git reads a path, and the capture's boundary then drops that path. A row an older store wrote keeps the bytes it
       stored, so a rewind to one is refused where a conversion could have changed them (storedAsItIsRefusal).
         -> null | why it could not be */
    const ATTRIBUTES_PIN = '* -text -ident -filter !working-tree-encoding\n';
    const REREAD_DUE = 'starnet-reread-due';
    async function pinAttributes(gitDir, runIn, runLong) {
      const file = pathMod.join(gitDir, 'info', 'attributes'), due = pathMod.join(gitDir, REREAD_DUE);
      let have = null;
      try { have = fs.readFileSync(file, 'utf8'); }
      catch (e) { if (!(e && e.code === 'ENOENT')) failNote('checkpoint.attributes', e); }
      try {
        if (have !== ATTRIBUTES_PIN) {
          if (fs.existsSync(pathMod.join(gitDir, 'index'))) {
            const head = await runIn(['rev-parse', '--verify', '-q', 'HEAD']);
            let read = null;
            if (head && head.code === 0) read = await runIn(['read-tree', 'HEAD']);
            else if (head && head.code === 1) {             // no commit yet, or a Git killed from outside: only no ref at all says the first
              const refs = await runIn(['for-each-ref', '--count=1', '--format=%(refname)']);
              if (refs && refs.code === 0 && !String(refs.stdout || '').trim()) read = await runIn(['read-tree', '--empty']);
            }
            if (!read || read.code !== 0) return 'Git could not read the last restore point again, to store every file as it is';
            fs.writeFileSync(due, '');
          }
          fs.mkdirSync(pathMod.dirname(file), { recursive: true });
          fs.writeFileSync(file, ATTRIBUTES_PIN);
        }
        if (!fs.existsSync(due)) return null;
        const fresh = await runLong(['update-index', '-q', '--refresh']);
        if (!fresh || fresh.code !== 0) return 'Git could not read every tracked file again' + (fresh && fresh.timedOut ? ' within its time limit' : '') + ', to store each as it is';
        fs.unlinkSync(due);
        return null;
      } catch (e) { return 'the rule that stores every file as it is could not be written (' + String((e && e.code) || 'error').slice(0, 24) + ')'; }
    }
    /* readPersonalConfig — what of the person's own Git config no -c pins by name, asked once per operation, and before a new shadow
       repo's `init` (a name-only list of the keys that matter, so as long as they are; a -c of its own in the list keeps its answer from being
       Git's 1, none, which a Git killed from outside gives too).
       HOOKS IN CONFIG (undo review 8). Since Git 2.54 a hook can be named in config (hook.<name>.event, hook.<name>.command), and
       core.hooksPath does not reach those: one that wrote in the work tree ran on the shadow repo's init, commit and reset, and the undo
       answered git_failed. Each name gets -c hook.<name>.enabled=false on every later call of that repo (pinnedConfig), the empty
       name too ([hook ""], keys hook..event and hook..command: -c hook..enabled=false; undo review 9, which found it skipped). A name
       holding '=' cannot be said to -c, so such a repo captures nothing while it stands.
       attributesFile: core.attributesFile is set (storedAsItIsRefusal). -> null | why it could not be */
    async function readPersonalConfig(gitDir, runIn) {
      const r = await runIn(['-c', 'starnet.asked=true', 'config', '-z', '--name-only', '--get-regexp', '^hook[.]|^starnet[.]asked$|^core[.]attributesfile$']);
      if (!r || r.code !== 0 || r.truncated) return 'Git could not say which hooks the person\'s Git config names, to keep them off the restore points';
      const keys = nulNames(r), names = new Set();
      for (const key of keys) { const m = /^hook\.(.*)\.[^.]+$/.exec(key); if (m) names.add(m[1]); }   // [hook ""] too: hook..command (undo review 9)
      const off = [];
      for (const name of names) {
        if (name.indexOf('=') >= 0) return 'the hook "' + name.slice(0, 60) + '" in the person\'s Git config cannot be kept off the restore points, as its name holds "="';
        off.push('-c', 'hook.' + name + '.enabled=false');
      }
      personalConfig.set(gitDir, { off: off, attributesFile: keys.indexOf('core.attributesfile') >= 0 });
      return null;
    }
    // what a shadow repo needs before anything reads or writes its index -> null | why it could not be
    async function readyShadowRepo(gitDir, runIn, runLong) {
      return (await readPersonalConfig(gitDir, runIn)) || pinAttributes(gitDir, runIn, runLong);
    }
    // the body line of every commit this store writes since the bytes are pinned: a commit without it is a row an older store wrote (storedAsItIsRefusal)
    const STORED_AS_IT_IS = 'starnet: every file stored as it is';
    /* prepareCapture — THE one boundary every capture passes before Git reads the work tree (commitSnapshot for a snapshot
       and for restore's pre-restore capture; reinitFromCurrentTree for the size-ceiling baseline). With the walk's result:
       0. the person's hooks in config are switched off by name and the shadow repo's info/attributes turns every conversion off (readyShadowRepo: readPersonalConfig,
          pinAttributes; a rewind has done this before its checks);
       1. every path the shadow index tracks below a folder the walk pruned is checked link by link (a tracked file under a
          .gitignore'd folder is still refreshed by `add -A`, through whatever its folders now are);
       2. the links are written to <gitDir>/info/exclude (rewritten every time, so a link that went away is captured again)
          and every tracked path at or below one is dropped from the shadow index (`rm --cached -r`, literal pathspecs; a link
          whose path holds a letter outside ASCII by the paths listUnder names, as Git's fold misses another spelling: undo
          review 7), and so is a tracked path through a Windows short name no listing shows (scanTree's aliasOn: with a
          link or a pruned folder to reach through it, `add -A` would read through a name the walk never saw);
       3. `check-ignore` then says which links Git ignores now. info/exclude is the weakest ignore source: a .gitignore
          negation (`!src/`, an allowlist .gitignore) beats it and re-includes the link. Each link it did NOT keep out is
          left out by an exclude PATHSPEC on the `add` instead, which no ignore rule overrides; an ignored link is never
          named in one (`add` refuses a pathspec that names an ignored path). A link inside a folder the shadow index
          records as a GITLINK (an embedded repository whose `.git` went away, so the walk entered it) makes check-ignore,
          like `add`, die with 128: Git never reads inside a gitlink, so such links are dropped and the question asked again;
       4. a rewind's capture (its walk pruned by the target's .gitignore too: scanTree's keptOut) leaves each folder only
          the target's rules prune (or a rule names only in another case, where the file system folds case: any capture)
          out of Git's view by its own info/exclude line, an IGNORE rule, so Git still refreshes
          what it tracks there (checked link by link, as in 1) and adds nothing new from it; check-ignore must then say Git
          ignores each, or the capture is refused (a pathspec would leave a tracked file stale in the undo row);
       5. returns the `add -A` the caller must run (`add(runIn)`) and the links left out of Git's view (`links`); for a
          rewind's capture, `forced` (restoreUncapturedConflicts: files in such a folder that the rewind writes over or
          deletes and no rule of the work tree ignores, each on a path its checks walked) are then added by name (`add -f`).
       Two names Git reads as one, wherever the walk or the checks listed them, refuse every capture before its `add` (TWO
       NAMES GIT READS AS ONE, below): a rewind's with the rewind's own refusal (`refusal`).
         -> { ok:true, links, add(runIn) } | { ok:false, reason } | { ok:false, refusal } (a rewind's capture) */
    async function prepareCapture(workTree, gitDir, runIn, scanIn, forced, runLong) {
      // a rewind has done this before its checks (restoreDetailed)
      const unready = scanIn ? null : await readyShadowRepo(gitDir, runIn, runLong || runIn);
      if (unready) return { ok: false, reason: 'restore point skipped: ' + unready };
      const scan = scanIn || await scanFor(workTree, gitDir, runIn);
      if (!scan.ok) return { ok: false, reason: 'restore point skipped: the folder could not be checked for links, because ' + scan.reason };
      const removals = new Set(), indexed = fs.existsSync(pathMod.join(gitDir, 'index'));
      if (scan.prunedDirs.length && indexed) {
        const tracked = await listUnder(runIn, scan.prunedDirs);
        if (!tracked) return { ok: false, reason: 'restore point skipped: the files it tracks below ignored folders could not be listed to check them for links' };
        for (const p of tracked) {
          const hit = await scan.linkOnPath(p);
          if (hit) removals.add(hit.spelled);
        }
        if (scan.refusal()) return { ok: false, reason: 'restore point skipped: the folder could not be checked for links, because ' + scan.refusal() };
      }
      if (winPaths && indexed && (scan.links.length || scan.prunedDirs.length)) {
        const shortNamed = await oddNames(runIn, SHORT_SPECS);
        if (!shortNamed) return { ok: false, reason: 'restore point skipped: the files it tracks by a name like a Windows short name could not be listed to check them for links' };
        for (const p of shortNamed) {
          const q = await scan.aliasOn(p);
          if (q) removals.add(q);
        }
        if (scan.refusal()) return { ok: false, reason: 'restore point skipped: the folder could not be checked for links, because ' + scan.refusal() };
      }
      // TWO NAMES GIT READS AS ONE (undo review 9), side by side in a folder that reads case apart, in any folder the walk or the checks listed but
      // inside an embedded repository or a `.git` folder (one pair kept for each folder, no list to fill: undo review 10): `add -A` takes only one,
      // and Git for Windows' fscache gave it the other's length, so a capture stored the first bytes of the person's file. Every capture is refused
      // before its `add`, a rewind's too (undo review 12: refused after it, a rewind left those bytes staged with the twin's stat, and once the
      // person moved the file aside the next capture committed them, the twin's own bytes in no row). A capture of its own walk is skipped; a
      // rewind's answers the rewind's refusal (twinsRefusal), and every folder holding a file `add` reads was listed by now (the walk, the checks
      // before the capture, and step 1 above)
      const twins = scan.caseTwins();
      if (twins && scanIn) return { ok: false, refusal: twinsRefusal(twins) };
      if (twins) return { ok: false, reason: 'restore point skipped: "' + twins.first + '" and "' + twins.second + '" stand side by side in a folder that reads case apart, and Git reads them as one name, so a capture could store one of them as the other or not at all' };
      let links = scan.links.slice().sort(function (a, b) { return byText(a.path, b.path); });
      for (const l of links) removals.add(l.path);
      const unfoldedLinks = foldCase && indexed ? links.map(function (l) { return l.path; }).filter(function (p) { return holdsNonAscii(p); }) : [];
      if (unfoldedLinks.length) {
        const spelled = await listUnder(runIn, unfoldedLinks);
        if (!spelled) return { ok: false, reason: 'restore point skipped: the files it tracks below a link could not be listed to leave them out' };
        for (const p of spelled) removals.add(p);
      }
      let kept = (scan.keptOut || []).slice();
      const unwritten = writeLinkExcludes(gitDir, links, kept);
      if (unwritten) return { ok: false, reason: 'restore point skipped: ' + unwritten };
      if (removals.size) {
        const rm = await gitWithPathspecs(runIn, gitDir, ['rm', '--cached', '-r', '-f', '-q', '--ignore-unmatch'], Array.from(removals).map(function (p) { return literalSpec(p); }));
        if (!rm || rm.code !== 0) return { ok: false, reason: 'restore point skipped: Git could not drop what it tracked behind a link (' + String((rm && rm.code) != null ? rm.code : 'error') + ')' };
      }
      // each link is asked and matched in check-ignore's own spelling (ignoreAsked)
      let ci = await checkIgnored(runIn, links.map(function (l) { return ignoreAsked(l.path); }));
      if (!ci.ok && ci.code === 128) {
        const gitlinks = await gitlinksAbove(runIn, links);
        if (gitlinks && gitlinks.length) {
          links = links.filter(function (l) { return !gitlinks.some(function (g) { return atOrBelow(l.path, g); }); });
          ci = await checkIgnored(runIn, links.map(function (l) { return ignoreAsked(l.path); }));
        }
      }
      if (!ci.ok) return { ok: false, reason: 'restore point skipped: Git could not say which links it leaves out (' + String(ci.code) + ')' };
      if (kept.length) {
        let ck = await checkIgnored(runIn, kept.map(ignoreAsked), true);
        if (!ck.ok && ck.code === 128) {                  // one below a gitlink: Git never reads inside it anyway
          const gitlinks = await gitlinksAbove(runIn, kept.map(function (p) { return { path: p }; }));
          if (gitlinks && gitlinks.length) {
            kept = kept.filter(function (p) { return !gitlinks.some(function (g) { return atOrBelow(p, g); }); });
            ck = await checkIgnored(runIn, kept.map(ignoreAsked), true);
          }
        }
        if (!ck.ok) return { ok: false, reason: 'restore point skipped: Git could not say which folders it leaves out (' + String(ck.code) + ')' };
        const stillRead = kept.find(function (p) { return !ck.ignored.has(gitQuoted(ignoreAsked(p))); });
        if (stillRead != null) return { ok: false, reason: 'restore point skipped: Git would still read "' + stillRead + '", a folder the restore point ignores' };
      }
      const unignored = links.filter(function (l) { return !ci.ignored.has(gitQuoted(ignoreAsked(l.path))); }).map(function (l) { return l.path; });
      const excludes = unignored.map(function (p) { return literalSpec(p, 'exclude'); });
      return {
        ok: true, links: links,
        add: async function (runAdd) {
          const all = await (excludes.length ? gitWithPathspecs(runAdd, gitDir, ['add', '-A'], [':(top)'].concat(excludes)) : runAdd(['add', '-A']));
          if (!all || all.code !== 0 || !(forced && forced.length)) return all;
          return gitWithPathspecs(runAdd, gitDir, ['add', '-f'], forced.map(function (p) { return literalSpec(p); }));
        }
      };
    }
    // the links a capture left out, as a result / index row records them, sorted (additive; absent when there were none)
    function linkFields(links) {
      if (!links || !links.length) return {};
      const sorted = links.slice().sort(function (a, b) { return byText(a.path, b.path); });
      return { links: sorted.slice(0, LINKS_RECORDED_MAX).map(function (l) { return { path: l.path, kind: l.kind }; }), linksTotal: links.length };
    }
    // the same left-out links as a row, as a SET: a row recorded before links were sorted still dedups
    function sameLinks(row, links) {
      const want = linkFields(links), have = { links: (row && row.links) || [], linksTotal: (row && row.linksTotal) || 0 };
      const names = function (list) { return (list || []).map(function (l) { return l.path + '\0' + l.kind; }).sort(byText).join('\n'); };
      return (want.linksTotal || 0) === have.linksTotal && names(want.links) === names(have.links);
    }

    // gitDir -> clock ms before which snapshot() skips the automatic size pass (set when a pass ends over the ceiling)
    const maintenanceRetryAt = new Map();
    function maintenanceDue(gitDir) { const at = maintenanceRetryAt.get(gitDir); return !(at > clock.now()); }

    /* enforceSizeCeiling — bound the shadow repo's on-disk footprint. `git add -A` on every mutating turn writes
       a fresh blob per changed file; over months of 24/7 use the object store bloats even though only the last
       `keep` snapshots are reachable via the index (rollback older than that is already impossible). Strategy:
       1) `git gc --prune=now` — the cheap, LOSSLESS reclaim of loose/unreferenced objects (the dominant bloat
          from add churn + pruned blobs). Every indexed snapshot SHA stays intact + restorable.
       2) if it's STILL over ceiling after gc, RE-INIT from the current tree: the object store is unbounded only
          because deep history is retained, yet that history is unreachable via the index (>keep). Re-init makes a
          fresh single-commit repo of the current worktree, then RE-STAMPS the index to that one commit. This
          sacrifices the older in-index rollback points to keep disk bounded — a disclosed, honest tradeoff, taken
          ONLY past the ceiling. Fail-open: any git failure leaves the repo as-is (never crash a run).
       gc and the re-init add/commit get maintenanceTimeoutMs (120 s default), not the snapshot default, and every gc attempt
       is followed by sweepGitTemporaries. A pass that still ends over the ceiling (gc and re-init both failed, or the
       current tree alone is bigger than the ceiling) pauses snapshot()'s automatic passes for this git-dir for
       MAINTENANCE_BACKOFF_MS: re-running it on every mutating turn only restarted the same doomed gc, a stall inside
       the tool's time budget each time (#107 residual). An explicit enforceSizeCeiling() call always runs.
       Returns { swept, reinit, bytesBefore, bytesAfter, gcSucceeded, overLimit, leftoversRemoved } for tests/telemetry. */
    async function enforceSizeCeiling(aid, scope, meta) {
      if (!(maxRepoBytes > 0) || !repoExists(aid, scope)) return { swept: false, reinit: false };
      const gitDir = gitDirFor(aid, scope);
      const before = await repoBytes(gitDir);
      if (before <= maxRepoBytes) {
        maintenanceRetryAt.delete(gitDir);
        return { swept: false, reinit: false, bytesBefore: before, bytesAfter: before };
      }
      let gcSucceeded = false;
      // an explicit pass has read no config of the person's yet, and no hook of theirs runs on this repo either
      const unread = await readPersonalConfig(gitDir, function (args) { return git(aid, scope, args); });
      if (unread) { failNote('checkpoint.gc', new Error(unread)); return { swept: false, reinit: false, bytesBefore: before, bytesAfter: before }; }
      // a gc killed on an earlier pass leaves packed-refs.lock / commit-graph locks / gc.pid that would refuse this one
      try { await clearStaleGitLocks(aid, gitDir); } catch (e) { failNote('checkpoint.staleLock', e); }
      try {
        const gc = await git(aid, scope, ['gc', '--prune=now', '-q'], maintenanceTimeoutMs);
        gcSucceeded = !!gc && gc.code === 0;
        if (!gcSucceeded) failNote('checkpoint.gc', new Error('Git maintenance ' + (gc && gc.timedOut ? 'timed out' : 'failed') + '; checkpoint storage may remain over limit'));
      } catch (e) { failNote('checkpoint.gc', e); }
      let leftovers = null;
      try { leftovers = await sweepGitTemporaries(gitDir); }
      catch (e) { failNote('checkpoint.gc.leftover', e); }
      let after = await repoBytes(gitDir);
      let reinit = false;
      if (after > maxRepoBytes) {
        reinit = await reinitFromCurrentTree(aid, scope, meta);
        after = await repoBytes(gitDir);
      }
      const overLimit = after > maxRepoBytes;
      if (overLimit) {
        maintenanceRetryAt.set(gitDir, clock.now() + MAINTENANCE_BACKOFF_MS);
        failNote('checkpoint.sizeCeiling.backoff', new Error('shadow repo still over the size ceiling after maintenance (' + after + 'B); automatic passes paused for 30 min'));
      } else maintenanceRetryAt.delete(gitDir);
      try { console.warn('[checkpoint] shadow repo for ' + aid + ' over ceiling (' + before + 'B) -> ' + (reinit ? 're-init' : (gcSucceeded ? 'gc' : 'maintenance failed')) + ' -> ' + after + 'B' + (leftovers && leftovers.removed ? ' (' + leftovers.removed + ' temp file(s) removed)' : '') + (overLimit ? ' (still over: automatic passes paused 30 min)' : '')); } catch (_) {}
      return { swept: true, reinit: reinit, bytesBefore: before, bytesAfter: after, gcSucceeded: gcSucceeded, overLimit: overLimit, leftoversRemoved: leftovers ? leftovers.removed : 0 };
    }
    // wipe the shadow git-dir and re-create a single baseline commit of the CURRENT worktree, then re-stamp the
    // index to that one snapshot. Returns true on success. Fail-open (false) leaves the repo untouched on error.
    async function reinitFromCurrentTree(aid, scope, meta, label) {
      try {
        const gitDir = gitDirFor(aid, scope);
        /* BUILD THE REPLACEMENT FIRST, DESTROY SECOND. Deleting the history and only then running
           init/add/commit meant any failure — disk full (the very state that trips the ceiling), or a
           stale index.lock — returned false with the WHOLE shadow repo already gone while the index kept
           advertising snapshots whose objects no longer existed: every rewind point a silent lie, and
           readIndexRaw's 'ok' meant the git rebuild never ran to notice. The fresh baseline is now proven
           in a SIDE git-dir; the old repo is removed only after commit + rev-parse succeed, and the swap
           is two renames with a restore on failure. */
        const fresh = gitDir + '.reinit';
        const cleanup = () => { try { fs.rmSync(fresh, { recursive: true, force: true }); } catch (e) { failNote('checkpoint.reinit.cleanup', e); } };
        cleanup();
        fs.mkdirSync(fresh, { recursive: true });
        personalConfig.set(fresh, personalConfig.get(gitDir));   // enforceSizeCeiling read it: no hook of the person's on the fresh repo's init either
        // add + commit re-hash the WHOLE current tree into the side repo: they get the maintenance bound, not 15 s.
        const gitAt = (dir, args, timeoutMs) => runGit(['--git-dir', dir, '--work-tree', workTreeFor(aid, scope)].concat(pinnedConfig(dir), args),
          timeoutMs ? { cwd: workTreeFor(aid, scope), timeoutMs: timeoutMs } : { cwd: workTreeFor(aid, scope) });
        if ((await gitAt(fresh, ['init', '-q'])).code !== 0) { cleanup(); return false; }
        try { ensureExclude(scope, fresh); } catch (e) { failNote('checkpoint.exclude.write', e); cleanup(); return false; }   // the replacement never takes an attachment
        // the same LINK BOUNDARY as every snapshot (prepareCapture): the fresh baseline never reads through a link either
        const runFresh = function (args) { return gitAt(fresh, args, maintenanceTimeoutMs); };
        const capture = await prepareCapture(workTreeFor(aid, scope), fresh, runFresh);
        if (!capture.ok) { failNote('checkpoint.reinit.links', new Error(capture.reason)); cleanup(); return false; }
        if ((await capture.add(runFresh)).code !== 0) { cleanup(); return false; }
        const com = await gitAt(fresh, ['commit', '-q', '--allow-empty', '-m', label || 'baseline (repo re-init: size ceiling)', '-m', STORED_AS_IT_IS], maintenanceTimeoutMs);
        if (com.code !== 0) { cleanup(); return false; }
        const sha = (await gitAt(fresh, ['rev-parse', 'HEAD'])).stdout.trim();
        personalConfig.delete(fresh);
        if (!cp.isValidId(sha)) { cleanup(); return false; }
        // Keep both the old objects AND an atomically restorable index until the new index is durable.
        // Otherwise an index write failure leaves stale rows pointing at history already deleted.
        const existing = await loadIndexResilient(aid);
        if (readIndexRaw(aid).status === 'unreadable') { cleanup(); return false; }
        const indexBackup = indexFileFor(aid) + '.reinit-index';
        try { writeFileDurable({ fs: fs, path: pathMod }, indexBackup, JSON.stringify(existing)); }
        catch (e) { failNote('checkpoint.reinit.indexBackup', e); cleanup(); return false; }
        const old = gitDir + '.old';
        try { fs.rmSync(old, { recursive: true, force: true }); } catch (e) { failNote('checkpoint.reinit.old', e); }
        try { fs.renameSync(gitDir, old); } catch (_) { cleanup(); return false; }
        try { fs.renameSync(fresh, gitDir); }
        catch (_) {
          // failed swap: put the original history back — a restore failure here is the one truly bad exit
          try { fs.renameSync(old, gitDir); } catch (e) { failNote('checkpoint.reinit.restore', e); }
          cleanup(); return false;
        }
        try {
          const size = await measure(aid, scope, sha);
          const others = existing.snapshots.filter(function (s) { return String((s && s.scopeId) || '') !== String((scope && scope.id) || ''); });
          const fullId = (scope && scope.prefix || '') + sha;
          saveIndex(aid, cp.record(cp.toIndex(others), Object.assign({
            id: fullId, runId: meta && meta.runId || '', turn: meta && meta.turn || 0, parentId: null, label: 'baseline (re-init)', files: size.files, bytes: size.bytes,
            scopeId: (scope && scope.id) || '', workTree: scope && scope.id ? scope.workTree : '', gitCommit: sha
          }, linkFields(capture.links)), { now: clock.now(), keep: keep }));
        } catch (e) {
          failNote('checkpoint.index.persist', e);
          try {
            fs.renameSync(gitDir, fresh);
            fs.renameSync(old, gitDir);
            fs.renameSync(indexBackup, indexFileFor(aid));
            cleanup();
          } catch (rollbackError) { failNote('checkpoint.reinit.rollback', rollbackError); }
          return false;
        }
        try { fs.rmSync(old, { recursive: true, force: true }); } catch (e) { failNote('checkpoint.reinit.old', e); }
        try { fs.unlinkSync(indexBackup); } catch (e) { failNote('checkpoint.reinit.indexBackup', e); }
        return true;
      } catch (_) { return false; }
    }

    /* snapshot — capture the agent's CURRENT workspace state (taken BEFORE a mutating tool, so it is the
       pre-mutation rollback point). Deduped by content: if nothing changed since the last snapshot, no new
       commit is made and the existing head is returned (created:false). Fail-open: returns null on any git error. */
    async function snapshot(agentId, meta) {
      meta = meta || {};
      if (!AID_RE.test(String(agentId || ''))) return null;
      const aid = String(agentId);
      const why = {};
      const result = await takeSnapshot(aid, meta, why);
      // a dedup (created:false) is a real, restorable point too: the net is working (for THAT root)
      const root = why.root || healthRootFor(aid, { id: '' });
      if (result) recordHealth(aid, root, true);
      else recordHealth(aid, root, false, why.reason);
      return result;
    }
    async function takeSnapshot(aid, meta, why) {
      const scope = externalScope(aid, meta.workTree, meta.authorizedWorkTree === true);
      why.root = healthRootFor(aid, scope, meta.workTree);
      if (!scope) { why.reason = 'this project root is not authorized for restore points'; return null; }
      if (!saveScope(aid, scope)) { why.reason = 'the project root for this restore point could not be recorded'; return null; }
      const result = await commitSnapshot(aid, scope, meta, null, why);
      // Check even a dedup or failed add/commit: those were exactly the paths that left oversized
      // temporary pack data untouched forever. Restore's internal pre-undo snapshot never sweeps.
      // Skipped while a pass in the last MAINTENANCE_BACKOFF_MS left this repo over the ceiling: re-running it
      // every turn only restarted the same doomed gc (#107 residual). The first over-ceiling pass always runs.
      let maintenance;
      if (maintenanceDue(gitDirFor(aid, scope))) {
        try { maintenance = await enforceSizeCeiling(aid, scope, meta); }
        catch (e) { failNote('checkpoint.sizeCeiling', e); }
      }
      if (!result) return null;
      if (maintenance && maintenance.reinit) {
        // The sweep replaced history. Never hand the caller the now-deleted pre-sweep SHA.
        try {
          const head = (await git(aid, scope, ['rev-parse', 'HEAD'])).stdout.trim();
          const row = cp.findById(loadIndex(aid), scope.prefix + head);
          if (!cp.isValidId(head) || !row) { why.reason = 'the size sweep replaced the history and its new restore point could not be read back'; return null; }
          result.id = row.id; result.created = true; result.files = row.files; result.bytes = row.bytes;
        } catch (e) { failNote('checkpoint.sizeCeiling.head', e); why.reason = 'the size sweep replaced the history and its new restore point could not be read back'; return null; }
      }
      if (maintenance && maintenance.swept) result.maintenance = maintenance;
      // A commit that is not a recorded row is not a restore point: restore() refuses any id outside the index, so
      // handing it out would let a caller offer an undo that cannot happen (an index write failure, or a dedup head
      // the index never recorded). Read through the same resilient loader restore() uses.
      let recorded = false;
      try { recorded = !!cp.findById(await loadIndexResilient(aid), result.id); }
      catch (e) { failNote('checkpoint.index.verify', e); }
      if (!recorded) {
        why.reason = readIndexRaw(aid).status === 'unreadable' ? 'the restore list could not be read just now'
          : 'the restore point was saved in Git but could not be added to the restore list';
        return null;
      }
      return result;
    }
    const asItIsHead = new Map();                       // git-dir -> the head last read as saying so, so a run of unchanged snapshots asks once
    async function headSaysAsItIs(gitDir, runIn, head) {
      if (asItIsHead.get(gitDir) === head) return true;
      const says = await commitSaysAsItIs(runIn, head);
      if (says) asItIsHead.set(gitDir, head);
      return says === true;
    }
    // does this commit's message hold STORED_AS_IT_IS, as a line of its own? -> bool | null (Git could not read it)
    async function commitSaysAsItIs(runIn, sha) {
      const c = await runIn(['cat-file', '-p', sha]);
      if (!c || c.code !== 0 || c.truncated) return null;
      return String(c.stdout || '').split('\n').indexOf(STORED_AS_IT_IS) >= 0;
    }
    /* commitSnapshot — the one snapshot code path, on an already-resolved scope. opts.always: commit even when
       nothing changed (--allow-empty) so the index gets its OWN labelled row (restore's pre-restore undo point);
       Maintenance belongs to public snapshot(), so restore's internal pre-undo capture cannot drop its target.
       opts.forced: the files restore's capture takes by name (prepareCapture). opts.beforeCommit(tree) -> null | refusal:
       restore's checks of what its reset will remove and of what its undo will list, on the tree the capture staged,
       before any commit or row (a refusal is why.refusal, and the answer null; so is a refusal prepareCapture answers a
       rewind's capture before its `add`: twinsRefusal).
       Fail-open: null on any git error, with why.reason (when a why object is passed) saying which step failed. */
    async function commitSnapshot(aid, scope, meta, opts, why) {
      meta = meta || {}; opts = opts || {}; why = why || {};
      const failed = function (step, r) { why.reason = gitFailure(step, r, aid, scope); return null; };
      try {
        fs.mkdirSync(workTreeFor(aid, scope), { recursive: true });
        fs.mkdirSync(gitDirFor(aid, scope), { recursive: true });
        // A Git command killed on an earlier operation (an add at its bound on a big first snapshot) left its lock.
        try { await clearStaleGitLocks(aid, gitDirFor(aid, scope)); } catch (e) { failNote('checkpoint.staleLock', e); }
        // init the shadow repo once (idempotent: re-running init on an existing repo is harmless), no hook of the person's on it either.
        if (!fs.existsSync(pathMod.join(gitDirFor(aid, scope), 'HEAD'))) {
          const unread = await readPersonalConfig(gitDirFor(aid, scope), function (args) { return git(aid, scope, args); });
          if (unread) { why.reason = 'restore point skipped: ' + unread; return null; }
          const ini = await git(aid, scope, ['init', '-q']);
          if (ini.code !== 0) return failed('init', ini);
        }
        // the exclude comes before the add; a repo older than the rule may still TRACK attachments, so they leave the NEXT commit (what its history
        // already holds is forgetAttachments' to replace)
        let excluded = false;
        try { excluded = ensureExclude(scope, gitDirFor(aid, scope)); } catch (e) { failNote('checkpoint.exclude.write', e); }
        if (excluded) await git(aid, scope, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--'].concat(EXCLUDE_LINES.map(function (l) { return l.replace(/\/$/, ''); })));
        // THE LINK BOUNDARY: walk without following, leave every link out, drop what is tracked behind one (prepareCapture)
        const runHere = function (args) { return git(aid, scope, args); };
        const capture = await prepareCapture(workTreeFor(aid, scope), gitDirFor(aid, scope), runHere, opts.scan, opts.forced, function (args) { return git(aid, scope, args, maintenanceTimeoutMs); });
        if (!capture.ok) { if (capture.refusal) why.refusal = capture.refusal; else why.reason = capture.reason; return null; }
        const add = await capture.add(runHere);
        if (add.code !== 0) return failed('add', add);
        // opts.beforeCommit(tree) (restore's pre-restore capture): asked with the tree this commit will hold, before the
        // commit and its row; a refusal it answers is why.refusal, and nothing is committed or recorded
        if (opts.beforeCommit) {
          const wt = await git(aid, scope, ['write-tree']);
          const tree = String((wt && wt.stdout) || '').trim();
          if (wt.code !== 0 || !cp.isValidId(tree)) return failed('write-tree', wt);
          const refusal = await opts.beforeCommit(tree);
          if (refusal) { why.refusal = refusal; return null; }
        }
        const hasHead = (await git(aid, scope, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
        let unrecordedHead = false;
        if (hasHead && !opts.always) {
          const diff = await git(aid, scope, ['diff', '--cached', '--quiet', 'HEAD']);   // code 0 => nothing staged changed
          if (diff.code === 0) {
            const head = (await git(aid, scope, ['rev-parse', 'HEAD'])).stdout.trim();
            const fullId = scope.prefix + head;
            if (!(cp.isValidId(head) && cp.isValidId(fullId))) { why.reason = 'Git could not read the current restore point'; return null; }
            // Dedup only onto a RECORDED head: restore() refuses any id outside the index, so a head whose row was never
            // written (an index write failure) or was pruned is no restore point. Record a fresh commit of the same tree —
            // but never while the index is transiently UNREADABLE: recording then would rewrite it from .bak/empty.
            const dedup = Object.assign({ id: fullId, created: false, files: 0, bytes: 0, workTree: scope.id ? scope.workTree : '' }, linkFields(capture.links));
            if (readIndexRaw(aid).status === 'unreadable') return dedup;
            // ...and only while the head row names the same left-out links: a link that appeared (or went) with nothing
            // else changed is still a different restore point, recorded on its own row
            const headRow = cp.findById(await loadIndexResilient(aid), fullId);
            // ...and only onto a head that says it stores the bytes as they are: this tree was just read that way, so it gets a row that says so
            if (headRow && sameLinks(headRow, capture.links) && await headSaysAsItIs(gitDirFor(aid, scope), runHere, head)) return dedup;
            unrecordedHead = true;
          }
        }
        const label = meta.label != null ? String(meta.label) : 'snapshot';
        const commitArgs = ['commit', '-q', '-m', label, '-m', STORED_AS_IT_IS];
        if (!hasHead || opts.always || unrecordedHead) commitArgs.push('--allow-empty');   // baseline even for an empty workspace
        const com = await git(aid, scope, commitArgs);
        if (com.code !== 0) return failed('commit', com);
        const sha = (await git(aid, scope, ['rev-parse', 'HEAD'])).stdout.trim();
        if (!cp.isValidId(sha)) { why.reason = 'Git could not read the new restore point'; return null; }
        const fullId = scope.prefix + sha;
        if (!cp.isValidId(fullId)) { why.reason = 'Git could not read the new restore point'; return null; }
        const size = await measure(aid, scope, sha);
        try {
          /* THE RESILIENT LOADER, not the sync one. `loadIndex` reads only index.json + index.json.bak and returns
             an EMPTY index on failure — it deliberately never rebuilds, because git is async. snapshot() IS async,
             and it was the one await-capable caller still using the sync loader (the module's own docstring says
             loadIndexResilient is "used by every await-capable caller (snapshot/restore/the list route)").

             The cost of the shortcut: after a crash that lost index.json AND its .bak while the shadow repo
             survived, the very next mutating tool call recorded on top of an EMPTY index and persisted ONE entry.
             From then on readIndexRaw reports 'ok', so loadIndexResilient short-circuits and never reaches the
             git-log rebuild again — the rewind UI showed a single restore point and restore() refused every
             surviving commit, permanently. The header's law is "the shadow git COMMITS are the truth; index.json
             is just a cache of them", and this was the one writer that did not honour it. It also made the catch
             below false: a commit missing from a NON-empty index is not restorable via restore() at all. */
          /* ONE ROW PER COMMIT: with no index.json yet (an agent's FIRST snapshot), the resilient load rebuilds from git log,
             which already lists the commit just made, as a lossy row (no runId, no links) that findById returned first and
             that priorInScope made this row's own parent. Drop it; the row recorded below is the truthful one. */
          const prior = cp.toIndex((await loadIndexResilient(aid)).snapshots.filter(function (s) { return !(s && s.id === fullId); }));
          const priorInScope = prior.snapshots.slice().reverse().find(function (s) {
            return String((s && s.scopeId) || '') === scope.id;
          });
          const index = cp.record(prior,
            Object.assign({ id: fullId, runId: meta.runId, turn: meta.turn, parentId: priorInScope ? priorInScope.id : null,
              label: label, files: size.files, bytes: size.bytes, scopeId: scope.id,
              workTree: scope.id ? scope.workTree : '', gitCommit: sha }, linkFields(capture.links)),
            { now: clock.now(), keep: keep });
          saveIndex(aid, index);
        } catch (e) { failNote('checkpoint.index.persist', e); }
        return Object.assign({ id: fullId, created: true, files: size.files, bytes: size.bytes, workTree: scope.id ? scope.workTree : '' }, linkFields(capture.links));
      } catch (e) {                                                               // fail-open
        why.reason = 'the restore point could not be saved (' + String((e && e.code) || 'unexpected error').slice(0, 40) + ')';
        return null;
      }
    }

    /* restore — hard-reset the agent's work-tree to a snapshot (and remove the captured files created since). Only
       restores a snapshotId that is RECORDED in this agent's index — never an arbitrary ref. Returns false on any failure.

       UNDO THE UNDO. `reset --hard` + `clean -fd` used to run with no snapshot of the CURRENT state: the
       Commander's own hand edits since the last agent snapshot, and any new untracked file, were destroyed and
       existed nowhere in the shadow history (audit probe 09-22: an edited v3 and a new draft-by-commander.txt,
       both gone). Before touching the tree, restore now commits the current work tree — tracked changes AND
       untracked non-ignored files, through the SAME `add -A` path every snapshot uses, so the same ignore rules
       apply — as its own labelled 'pre-restore' row in this agent's index (always a new row, even when nothing
       changed, so the undo point is explicit). Restoring THAT id brings the edits and the untracked files back.
       If the pre-restore snapshot cannot be taken AND proven in the index, the restore REFUSES and the tree is
       untouched: a rewind must never destroy state it cannot give back.
       WHAT A REWIND REMOVES, exactly. Only `reset --hard` changes the tree. It deletes each file the pre-restore capture
       took that the target lacks (every one is in the undo row) and the folders that leaves empty, and writes each file
       the target holds over what stands at its path: a captured file (in the undo row), a captured file where the target
       holds a folder, or a folder the target holds as a FILE, with every file in it (each one captured: below) and the
       empty folders in it. Nothing else. A rewind runs NO `clean` (review round 5): after the pre-restore capture all
       `clean -fd` could still delete was a file no capture took, one the CURRENT ignore rules exclude (an ignored .env, a
       *.log, a folder only the current .gitignore lists), once reset had written a target .gitignore without that rule:
       gone for good, undo or not (trunk d5024f5a did the same). So a file no capture took stays where it is, whatever the
       target's .gitignore says, and so does every link, embedded repository and `.git`, and every empty folder, at a path
       the target does not hold. At a path it holds or a folder above one, or at or below a folder it holds as a file, each
       of them but an empty folder refuses the rewind (NOTHING NO CAPTURE TOOK, below; restoreLinkConflicts); an empty
       folder there is deleted. Undoing such a rewind is itself a rewind, under the target's rules, and A REWIND'S WALK
       AND CAPTURE GO BY THE TARGET'S OWN .gitignore TOO (final review 2: targetIgnoreRules, every changed one: scanTree's
       keptOut): a folder a plain name in the target's .gitignore excludes (the node_modules the undo row's .gitignore
       listed), or one a plain name of either side names only in another case where the file system folds case, is pruned
       by the walk and left out of the capture by an info/exclude line, so what no capture took there stays where it is,
       out of the new undo row, and the walk never counts it: before, past the walk's budget, the undo of such a rewind
       was refused (link_check_failed), and within it the undo's capture took the whole folder and its reset deleted it.
       So is one the target holds paths in (undo closure: walked and captured whole, the undo of a rewind that had kept a
       node_modules' untracked files out took them and deleted them, and the rewind never listed the folder its undo then
       pruned, and could not list). There a file the rewind writes over or deletes (the target holds that path, a folder
       at it, or a FILE at a folder above it) that no rule of the work tree ignores is taken by name (forced,
       restoreUncapturedConflicts), one a rule of the work tree ignores refuses the rewind (NOTHING NO CAPTURE TOOK), and
       everything else in it stays where it is, untouched, as an ignored file does. A FILE a plain name of the target
       names (an .env) is kept out like such a folder (scanTree's keptFile, undo review 2). Which rule ignores a file is
       asked of the rules alone, whatever the shadow index still tracks below its name (undo review 6: the FILE logs or
       dist/sub, where the last capture saw a folder, was neither taken by name nor refused, and the reset deleted it).
       THE RULES A REWIND CHANGES (undo review 2; unfollowedRules). The two sides keep each other's ignored files in place
       only by plain names: a file or folder only a glob or a path rule ignored (a *.log, an .env next to a negation) was
       taken by the undo's own capture and deleted by its reset, held in its own undo row only. So a rewind is refused,
       untouched, when the .gitignore files (every case spelling where the file system folds case: IGNORE_FILES) of the
       tree its capture staged and of the target differ by a rule that is not one plain name, or when they differ at all
       and a .gitignore of either side, or one the walk read, holds a negation or a NUL byte. The rules it does not change
       ignore the same paths on both sides, a glob too, so they never refuse it.
       THE UNDO ROW RESTORES THROUGH THIS API (final review 2, undo closure, undo reviews 1-12). Every listing a restore's checks
       take of a whole folder splits under the runner's output limit (namesIn from the tree's root entries down; listUnder
       and gitlinksAtOrBelow by treeUnder, which never reads the entry list of a folder above what it lists), and a flat
       folder whose own entry list passes it refuses a rewind before anything is touched. What the undo of a completed
       rewind needs of Git is taken before the rewind's commit, on the tree its capture staged (beforeCommit), and refuses
       it untouched when Git cannot give it: the undo's write list (removedByReset: the same paths of the same tree, asked
       the same way); its list of what its reset writes over (rewrites: split on the target's tree as the undo splits it, and
       on this one, namesBothWays: undo review 12); its read of the .gitignore files its row holds where they differ from the target's (ignoreTexts: the
       same blobs, read the same way); its link listing, what the target and the undo row hold at or below each link,
       pruned folder and embedded repository its walk will find: this walk's, which pruned by the rules of both sides, and
       the folders the reset makes that those rules prune (scanTree's prunedOnChain); its walk and its checks' listings,
       counted exactly on the tree the reset leaves (scanTree's afterReset: undo review 2, an estimate that kept every
       folder the reset empties refused the undo of a completed rewind that removed more than it wrote), against the entry
       budget, and the depth of every folder the reset writes into, a gitlink's own empty folder too, as the undo counts
       it: from the root where its walk goes, and from the folder its link check lists in full where it does not (a folder
       it prunes at or below a FILE the reset turns into a folder; undo review 1: a rewind to a point an older store or a
       bigger budget recorded wrote more than the walk allows, and its undo was refused; undo review 4: the same below
       such a folder, and one level down for a gitlink); its rules (THE RULES A REWIND CHANGES), its repositories
       (repoOnPath) and its gitlinks (gitlinkOverFiles, gitlinkOverFile), each the rewind's own check with the two trees
       trading places, so the undo's walk skips the repositories this walk skipped (undo review 3) and its check of what
       it deletes finds no gitlink where its row holds a file (undo review 4); and its links: neither tree records a
       symbolic link (symlinkRefusal), so its link check meets none its rewind made (undo review 5: a link an older
       capture recorded, made by the reset where Git makes links, refused the undo on every try); and its names (namesReadApart:
       the same pair of trees, and each name spelled one way on disk too, so the undo finds none spelled apart: undo review 7);
       and its folders' case (foldedTwoRefusal's CASE APART and WHAT GIT LEAVES, undo reviews 9-11: no folder the checks list reads case apart but one the reset
       empties, each entry spelled as it stands at every component, none of them in use; every folder whose entries the reset changes was asked here, or is one
       it empties that holds no name with no letter A-Z beside another, or holds nothing and is one its undo empties as it was written, below a folder that holds
       besides it, and besides every other such folder, a name with a letter A-Z, with no gitlink in it; no folder holds something on both sides of the reset with a
       name with a letter A-Z on one side only; no folder the reset must remove holds a gitlink's empty folder; and every path in play is spelled as the disk
       spells it. So every folder whose entries the undo changes, the reset having left it as these checks count, or having left a folder it was to remove
       standing, holding nothing or what Git could not delete, is one its walk can ask, one it empties or one that holds nothing below such a folder, and every
       folder there that reads case apart is one the undo empties as it was written, what it writes spelled as that folder stands); and no file the reset
       deletes or writes over is in use (IN USE, undo review 12: Git leaves the one and stops at the other, its index unwritten, which no check of the undo was
       made for), so the reset these checks counted is the reset Git does, as far as the file system answers before it.
       The undo's removal list is
       this rewind's own write list, and what it lists of a folder the reset turns a file into is part of that list too.
       Rows: test/checkpoint-store-capped.test.js, test/checkpoint-undo-closure.test.js, test/checkpoint-undo.test.js, test/checkpoint-undo-gitlinks.test.js,
       test/checkpoint-undo-reads.test.js, test/checkpoint-undo-older.test.js, test/checkpoint-undo-case.test.js, test/checkpoint-undo-folders.test.js and
       test/checkpoint-undo-held.test.js.
       What that does not cover (deferred: the lane test header): wall time, the walk's deadline, the runner's 15 s per Git call and the maintenance bound of the one
       hash of every tracked file on an older shadow repo (pinAttributes), which depend on the machine (an undo refused for it is pre_restore_failed or link_check_failed, untouched);
       and a reset Git stopped or left incomplete over what these checks could not see (a program that opens a file after them, one that maps a file as data with no
       handle open, a file whose permissions let it be written but not deleted, a Git killed from outside or past that 15 s), its undo row holding every byte and its undo refused,
       where the tree it left would be, until what the refusal names is moved aside.
       NOTHING NO CAPTURE TOOK IS REPLACED OR DELETED (review round 6; trunk d5024f5a did both, with ok:true). Reset writes
       the target's paths whatever the index says of what stands there, so before even the pre-restore capture
       restoreUncapturedConflicts refuses a rewind that would overwrite or delete what no capture can take: a file Git
       ignores where the target holds a file (the person's newer, ignored .env) or a folder (an ignored `logs` file where
       the target holds logs/), by its rules alone, also while the shadow index tracks logs/a.txt from a capture before
       the rule (undo review 6: deleted or written over, ok:true; trunk d5024f5a the same), a file inside an embedded
       repository (by a rule broader than Git's: any folder holding a `.git` of any kind, a linked worktree's gitfile or a
       `.git` link too, that the shadow index tracks no path below; review 6.2) or below a folder the shadow index
       records as a gitlink, and, in a folder the target holds as a FILE, any of those, an embedded repository or a
       `.git` (a clone's history and its uncommitted work) ('uncaptured_in_path', the path named;
       'uncaptured_check_failed' when Git could not list what the check needs, test/checkpoint-store.test.js row 4d).
       Moving that path aside, then rewinding again, is the person's explicit choice.
       A REMOVAL RESET COULD NOT DO is an incomplete rewind: Git only warns when it cannot unlink a file (one another
       program holds open, or runs from) and still exits 0, so a rewind that would delete or write over a file in use is
       refused before its commit (foldedTwoRefusal's IN USE, undo review 12: test/checkpoint-undo-held hl1, hl2, hpc; and
       hw1, hg1, hg2, a file written over, where Git exits 128 with its index unwritten), and after the reset leftByReset
       looks for each file it was to delete: one a program opened after the checks, still there, answers 'git_failed' with
       the undo row's id and the file named (detail), never ok, and that undo row restores every path and byte where the
       checks that rest on Git removing a folder let the rewind go (test/checkpoint-undo-held hpc, hp7, hp8, the hold taken
       just before the reset): a folder whose undo that would strand is refused first (WHAT GIT LEAVES, at foldedTwoRefusal).
       What it was to delete is listed before the pre-restore commit (removedByReset): a rewind Git cannot list it for is
       refused, untouched ('uncaptured_check_failed', no undo row), never run with a deletion it could not check afterwards.
       A reset that stops partway (exit code not 0) answers 'git_failed' with the undo row's id too; what can stop it is
       asked before the commit (scanTree's STOPS and IN USE).
       LINKS (lane checkpoint-links): before even the pre-restore capture, restoreLinkConflicts refuses a rewind that would
       write or delete through a link ('link_in_path', or 'link_check_failed' when the folder could not be checked).
       NAMES GIT AND THE FILE SYSTEM READ APART: before its commit, namesReadApart and foldedTwoRefusal refuse a rewind where a letter outside A-Z,
       or a Windows short name's shape, would let Git reach a path by a name no lookup here reads as it, and one where a folder reads case apart,
       or changes where no name can ask whether it does (foldedTwoRefusal's CASE APART) ('uncaptured_check_failed').
       A ROW AN OLDER STORE WROTE: before anything is touched, storedAsItIsRefusal refuses a rewind to one where a conversion could have changed its bytes ('uncaptured_check_failed').
         restoreDetailed(agentId, id) -> { ok, reason?, detail?, preRestoreId?, links?, paths?, left? }   restore(agentId, id) -> bool
       links: the links named (a refusal), or left where they were (ok); paths: what no capture took in the way
       ('uncaptured_in_path'); left: up to 4 files reset was to delete and could not (an incomplete rewind, 'git_failed'). */
    /* replacedFolders — which of the `asked` folders (folded rel -> the work tree's spelling) the target tree holds as a FILE
       (a blob or a symbolic link) at that very path (probe P8). `reset --hard` deletes such a folder before it writes the
       file, with every file below it and, on Git for Windows, everything behind a junction in it, a `.git` junction and
       one inside a real `.git` folder included (entry.c remove_subtree). exactEntries over `ls-files --with-tree`
       (case-folded where the file system folds case, by Git's fold: a FILE spelled apart from the folder in a letter outside A-Z is
       namesReadApart's to refuse), then `ls-tree` says what the TARGET holds at each, as `--with-tree`
       also lists the index. A gitlink there is not one: Git leaves the folder of a gitlink alone. -> [folded rel] | null */
    async function replacedFolders(runIn, sha, asked) {
      if (!asked.size) return [];
      const recs = await exactEntries(runIn, ['ls-files', '-z', '--with-tree=' + sha], Array.from(asked.values()));
      if (!recs) return null;
      const named = Array.from(new Set(recs.filter(function (p) { return asked.has(foldPath(p)); })));
      const out = [];
      for (let i = 0; i < named.length;) {
        const specs = [];
        for (let len = 0; i < named.length && (!specs.length || len < 6000); i++) { specs.push(':(literal)' + named[i]); len += named[i].length + 12; }
        const r = await runIn(['ls-tree', '-z', sha, '--'].concat(specs));
        if (!r || r.code !== 0 || r.truncated) return null;
        for (const rec of String(r.stdout || '').split('\0')) {
          const tab = rec.indexOf('\t');
          if (tab > 0 && rec.slice(0, tab).split(' ')[1] === 'blob') out.push(foldPath(rec.slice(tab + 1)));
        }
      }
      return out;
    }
    /* restoreLinkConflicts — RESTORE NEVER WRITES OR DELETES THROUGH A LINK. `reset --hard` writes every path of the target
       tree and deletes every tracked path the target lacks; through a link either lands outside the work tree (probes C',
       E, F: an npm-link rewind emptied the linked ../mylib and reported ok). Every path of the target tree and every path
       the shadow index tracks now, at or below a link the walk found, a folder it pruned or an embedded repository, is
       walked through the walk's listings (`ls-files --with-tree` lists both, case-folded where the file system folds case,
       by the walk's fold where the link's path holds a letter outside ASCII; listUnder, never one capped call).
       One that is a link, or lies below one, refuses the WHOLE rewind before anything is touched and names the link and the
       file: Git's reset is all or nothing, so the refused file is the refused restore. Then a folder the target holds as a
       file (replacedFolders) refuses it too when a link lies anywhere below that folder. The folders asked: every folder
       above a link, a `.git` link or a real `.git` folder the walk found, every folder it did not enter and those above it,
       and every listed path that is a plain folder now (one inside a folder the walk did not enter: r3, build/sub under an
       ignored build/, proj/sub in an embedded repository). The links counted: the ones the walk found, its `.git` links
       (Git never reads one, so it is never in `links`) and, for a folder at, above or inside one the walk did not enter,
       and for every real `.git` folder at or below it, every link in it, listed now in full (scan.linksBelow, within the
       walk's budget, a `.git` interior with an entry count of its own; it enters a real `.git` as remove_subtree does: r4,
       a clone's linked .git/hooks, a .git/lfs junction).
       A link no restored path passes through stays where it is: the pre-restore capture leaves it out of Git's view
       (prepareCapture), so `reset` never tracks it, and a rewind runs no `clean`. */
    async function restoreLinkConflicts(aid, scope, sha, scan) {
      const unwalked = scan.prunedDirs.concat(scan.nestedDirs);
      const candidates = scan.links.map(function (l) { return l.path; }).concat(unwalked);
      // the walk listed every folder Git can enter, none holds a link, and no folder below the root holds a real `.git`
      if (!candidates.length && !scan.gitLinks.length && !scan.gitFolders.length) return null;
      const failed = function (detail) { return { ok: false, reason: 'link_check_failed', detail: detail }; };
      const runHere = function (args) { return git(aid, scope, args); };
      const paths = candidates.length ? await listUnder(runHere, candidates, sha) : [];
      if (!paths) return failed('the files of the restore point could not be listed to check them for links');
      const hits = [], folders = [];
      for (const p of paths) {
        const at = await scan.walkPath(p);
        if (at && at.link) { hits.push({ path: p, link: at.link }); if (hits.length >= 8) break; }
        else if (at && at.dir) folders.push(at.dir);   // a listed file that is a plain folder now
      }
      if (scan.refusal()) return failed('the folder could not be checked for links, because ' + scan.refusal());
      if (!hits.length) {
        const asked = new Map();                            // folded rel -> the work tree's spelling
        const ask = function (rel) { const f = foldPath(rel); if (!asked.has(f)) asked.set(f, rel); };
        for (const l of scan.links) ancestorsOf(l.path).forEach(ask);
        for (const g of scan.gitLinks) ancestorsOf(g).forEach(ask);
        const gitFolders = scan.gitFolders.slice();       // the walk's, plus any walkPath's on-demand listings above found
        for (const g of gitFolders) ancestorsOf(g).forEach(ask);
        for (const u of unwalked) { ancestorsOf(u).forEach(ask); ask(u); }
        folders.forEach(ask);
        const replaced = await replacedFolders(runHere, sha, asked);
        if (!replaced) return failed('the files of the restore point could not be listed to check the folders it replaces with a file');
        const keys = new Set();
        const hit = function (at, link) {
          const k = foldPath(at) + '\0' + foldPath(link);
          if (hits.length < 8 && !keys.has(k)) { keys.add(k); hits.push({ path: at, link: link, folder: true }); }
        };
        const strictlyInside = function (dir) { return unwalked.some(function (u) { return dir.indexOf(foldPath(u) + '/') === 0; }); };
        for (const dir of replaced) {
          if (hits.length >= 8) break;
          const at = asked.get(dir) || dir;                 // the folder as the work tree spells it (`dir` is case-folded)
          for (const l of scan.links) if (atOrBelow(l.path, dir)) hit(at, l.path);
          for (const g of scan.gitLinks) if (atOrBelow(g, dir)) hit(at, g);
          // a folder inside one the walk did not enter is listed in full itself; one at or above such folders, each of them,
          // and each real `.git` folder at or below it that no such folder holds
          const tops = strictlyInside(dir) ? [at] : unwalked.filter(function (u) { return atOrBelow(u, dir); })
            .concat(gitFolders.filter(function (g) { return atOrBelow(g, dir) && !strictlyInside(foldPath(g)); }));
          for (const top of tops) {
            if (hits.length >= 8) break;
            const found = await scan.linksBelow(top);
            if (!found) return failed('the folder could not be checked for links, because ' + scan.refusal());
            for (const f of found) hit(at, f);
          }
        }
      }
      if (!hits.length) return null;
      const first = hits[0];
      return { ok: false, reason: 'link_in_path', links: hits.map(function (h) { return { path: h.path, link: h.link }; }),
        detail: first.folder
          ? '"' + first.link + '" is a link (a junction, symbolic link or mount point) inside the folder "' + first.path
            + '", which the restore point holds as a file: rewinding would delete that folder, through the link. Nothing was changed; remove or rename that link, then rewind again'
          : '"' + first.link + '" is a link (a junction, symbolic link or mount point), and rewinding would write or delete "'
            + first.path + '" through it. Nothing was changed; remove or rename that link, then rewind again' };
    }
    /* repoOnPath — NOTHING IS WRITTEN OR DELETED BELOW A REPOSITORY (undo reviews 2-3). Reset wrote the target's Y/a.txt into
       a clone the shadow index held as a gitlink (nothing stood at that path, so no check refused it), the index then
       tracked plain files below Y, and the undo walked the clone as a plain folder, took its working files (an uncommitted
       edit, a new file) and deleted them with its reset, ok:true; past the walk's budget the undo was refused instead
       (2d1c2fb9 the same). Undo review 3: a write was checked only where its own folder stood on disk, so the target's
       Y/sub/a.txt, with no sub/ in the clone, went in the same way (the clone a gitlink or never captured, at lib/Y, or a
       folder whose `.git` is a link to a repository), and its undo was refused (2d1c2fb9: the undo deleted the clone's
       files). Git's own reading decides, on the two trees, for every path the reset writes or deletes, whatever folders it
       makes on the way: refused, before the commit, when the reset
         writes a path below a folder the staged tree (the index now: the capture just staged it) records as a gitlink (an
           embedded repository, or one whose `.git` went away: `add -A` keeps that gitlink and never takes the files in it)
           or the walk found embedded, or below a folder holding a `.git` of any kind (the walk's gitHolders, on disk, up to
           the first folder of the path that is not there) that the staged tree holds no folder at;
         deletes a path below a folder the target records as a gitlink, or below a folder holding a `.git` that the target
           holds no folder at.
       The undo's writes are the rewind's deletions and its deletions the rewind's writes, on the same folders, the staged
       tree and the target trading places, so the undo of a rewind that passed passes this check too. A file the reset
       changes in place is neither (the index tracks it: Git reads that folder as a plain one, and the undo row holds the
       file). A gitlink the reset itself adds or drops is gitlinkOverFiles' to check.
         -> { path, repo, verb } | null | false (Git failed, or a folder could not be listed) */
    async function repoOnPath(runIn, scan, tree, sha, writes, removes) {
      const nested = new Set(scan.nestedDirs.map(foldPath));
      // folded parent folder -> one path below it, whether or not that folder is there now: a write into a folder the
      // reset makes is checked too (undo review 3: the target's Y/sub/a.txt, Y/sub absent in a clone at Y, was skipped,
      // written into the clone, and its undo was refused)
      const byParent = function (paths) {
        const out = new Map();
        for (const p of paths) {
          const i = String(p).lastIndexOf('/'), k = i > 0 ? foldPath(p.slice(0, i)) : '';
          if (k && !out.has(k)) out.set(k, String(p));
        }
        return out;
      };
      const holders = async function (byDir) {           // a folder holding a `.git` on disk (spelled) -> a path below it
        const out = new Map();
        for (const p of byDir.values()) {
          for (const h of await scan.gitHolders(p.slice(0, p.lastIndexOf('/')))) if (!out.has(h)) out.set(h, p);
          if (scan.refusal()) return null;
        }
        return out;
      };
      const w = byParent(writes);
      if (w.size) {
        const linked = await gitlinksAbove(runIn, Array.from(w.values()).map(function (p) { return { path: p }; }));
        if (!linked) return false;
        const gl = new Set(linked);
        for (const p of w.values()) {
          const repo = ancestorsOf(p).find(function (a) { return gl.has(foldPath(a)) || nested.has(foldPath(a)); });
          if (repo) return { path: p, repo: repo, verb: 'write' };
        }
        const hw = await holders(w);
        const kinds = hw && hw.size ? await targetKinds(runIn, tree, Array.from(hw.keys())) : new Map();
        if (!hw || !kinds) return false;
        for (const [h, p] of hw) if (kinds.get(foldPath(h)) !== 'tree') return { path: p, repo: h, verb: 'write' };
      }
      const r = byParent(removes);
      if (r.size) {
        const above = new Set();
        for (const p of r.values()) for (const a of ancestorsOf(p)) above.add(foldPath(a));
        const hr = await holders(r);
        if (!hr) return false;
        // a folder the reset turns into a gitlink is one of its writes (the target's path the index lacks)
        const asked = Array.from(hr.keys()).concat(writes.filter(function (p) { return above.has(foldPath(p)); }));
        const kinds = asked.length ? await targetKinds(runIn, sha, asked) : new Map();
        if (!kinds) return false;
        for (const p of r.values()) {
          const repo = ancestorsOf(p).find(function (a) { return kinds.get(foldPath(a)) === 'commit'; });
          if (repo) return { path: p, repo: repo, verb: 'delete' };
        }
        for (const [h, p] of hr) if (kinds.get(foldPath(h)) !== 'tree') return { path: p, repo: h, verb: 'delete' };
      }
      return null;
    }
    function repoRefusal(at) {
      return { ok: false, reason: 'uncaptured_in_path', paths: [{ path: at.path, folder: at.repo }],
        detail: '"' + at.repo + '" is an embedded Git repository (it holds a .git, or Git records it as one), and rewinding would '
          + at.verb + ' "' + at.path + '" inside it, which its undo could not give back as it is. Nothing was changed; move "'
          + at.repo + '" aside, then rewind again' };
    }
    /* gitlinkOverFiles — A GITLINK THE RESET ADDS OR DROPS OVER A FOLDER OF FILES (undo review 3). Git records an embedded
       repository as one gitlink and never reads inside it: no capture takes its files and no reset writes or deletes them,
       while Git reads the folder as a repository on both sides. A reset that drops a gitlink (the staged tree records one,
       the target nothing) or adds one (the target records one where the staged tree holds nothing: an ignored folder) leaves
       the folder as it is, and its undo, under the other index, reads that folder again:
         a clone the person vendored (its .git deleted: `add -A` keeps the gitlink and takes none of its files) was a plain
           folder to the undo, whose capture took its files and whose reset would have deleted them (2d1c2fb9 did, ok:true;
           repoOnPath refused that undo, the rewind's preRestoreId stranded);
         a linked worktree, or a folder whose `.git` is a link to a repository (one gitlink to `add -A`, a plain folder to
           looksLikeRepo), was skipped by the rewind's walk only because its index named the gitlink, so the undo's walk
           entered it whole, past the count its rewind took (afterReset): link_check_failed, stranded (2d1c2fb9 the same).
       So a rewind is refused, before its commit, when its reset adds or drops a gitlink at a folder that holds anything and
       no `.git` looksLikeRepo takes for a repository. One that is empty or not there goes ahead, and so does a clone:
       looksLikeRepo is stricter than Git, so Git records it as one gitlink on both sides, and both walks skip it (where a
       FILE stands, at that path or above it, the gitlink is refused instead: gitlinkOverFile). Erring toward refusal: a
       worktree or an ignored folder of files that would have round-tripped is refused too (the lane test header's
       DEFERRED).
         -> { path, adds } | null | false (Git failed, or a folder could not be listed) */
    async function gitlinkOverFiles(runIn, scan, workTree, tree, sha, writes, removes) {
      // the paths the reset drops from the staged tree, then those it adds from the target: each that is a folder now
      for (const [paths, treeish, adds] of [[removes, tree, false], [writes, sha, true]]) {
        const dirs = new Map();                           // folded path -> { spelled: as that tree spells it, rel: on disk }
        for (const p of paths) {
          const at = await scan.entryAt(p);
          if (scan.refusal()) return false;
          if (at && at.kind === 'dir' && !dirs.has(foldPath(p))) dirs.set(foldPath(p), { spelled: String(p), rel: at.rel });
        }
        if (!dirs.size) continue;
        const kinds = await targetKinds(runIn, treeish, Array.from(dirs.values()).map(function (d) { return d.spelled; }));
        if (!kinds) return false;
        for (const [k, d] of dirs) {
          if (kinds.get(k) !== 'commit') continue;
          // a clone first, with no listing: the undo asks the same of the same folder, and lists none the rewind's count
          // (afterReset) left out
          if (await looksLikeRepo(pathMod.join(workTree, d.rel, '.git'))) continue;
          const held = await scan.contents(d.rel);
          if (scan.refusal()) return false;
          if (held && held.count) return { path: d.rel, adds: adds };
        }
      }
      return null;
    }
    function gitlinkRefusal(at) {
      return { ok: false, reason: 'uncaptured_in_path', paths: [{ path: at.path, folder: at.path }],
        detail: at.adds
          ? '"' + at.path + '" holds files but no repository the checkpoint can read (its .git is gone, is a link, or is a linked worktree\'s), and rewinding would record it as an embedded Git repository (a gitlink), which its undo could not give back as it is. Nothing was changed; move "'
            + at.path + '" aside, then rewind again'
          : '"' + at.path + '" is recorded as an embedded Git repository (a gitlink) but holds no repository the checkpoint can read (its .git is gone, is a link, or is a linked worktree\'s), and rewinding would drop that record and leave its files a plain folder, which its undo could not give back as it is. Nothing was changed; move "'
            + at.path + '" aside, then rewind again' };
    }
    /* gitlinkOverFile — NOR IS A GITLINK RECORDED WHERE A FILE STANDS (undo review 4). The target records an embedded
       repository at a path where a FILE stands now (a clone the person deleted and wrote a file in its place), or below a
       folder the reset makes over a FILE (the target's v/ holding a clone at v/sub, where the file v is now). Git writes
       the gitlink as an empty folder, so the rewind went ahead, ok:true. Its undo, a rewind to the row that holds the
       file, must delete that folder again, and its own check of what that deletes (restoreUncapturedConflicts: a gitlink
       its index, the target's, records at or below a folder its row holds as a FILE counts as an embedded repository)
       refused it on every try (uncaptured_in_path): the file and the edits since the last capture were left in the undo
       row only (2d1c2fb9 the same; trunk d5024f5a had no such check and undid it). So the rewind is refused here, before
       its commit, as that check with the two trees trading places, on what restoreUncapturedConflicts found where the
       reset writes (the walk's listings, case-folded where the file system folds case): the target's record at each path
       it writes where a FILE stands (fileLeaves), and at or below each folder it makes over a FILE (fileDirs: the records
       the undo's gitlinksAtOrBelow lists of the same tree). Both by treeUnder: a batch that passes the runner's output
       limit is asked in halves, down to one path, and no folder's entry list above them is read (undo review 1's R2), so
       the rewind never needs a listing its undo would not take. A gitlink where nothing stands goes ahead (its undo
       deletes the empty folder, as Git drops a gitlink), and one at a folder is gitlinkOverFiles' to check.
         -> { path: the gitlink, file: the file's on-disk path } | null | false (Git could not list them) */
    async function gitlinkOverFile(runIn, sha, fileLeaves, fileDirs) {
      if (!fileLeaves.length && !fileDirs.length) return null;
      const recs = await treeUnder(runIn, sha, fileLeaves.map(function (l) { return l.leaf; }).concat(fileDirs.map(function (d) { return d.dir; })), true);
      if (!recs) return false;
      for (const rec of recs) {
        if (rec.slice(0, 7) !== '160000 ') continue;
        const p = rec.slice(rec.indexOf('\t') + 1), f = foldPath(p);
        const at = fileLeaves.find(function (l) { return foldPath(l.leaf) === f; })
          || fileDirs.find(function (d) { return f.indexOf(foldPath(d.dir) + '/') === 0; });
        if (at) return { path: p, file: at.file };
      }
      return null;
    }
    function gitlinkFileRefusal(at) {
      const same = foldPath(at.path) === foldPath(at.file);
      return { ok: false, reason: 'uncaptured_in_path', paths: [{ path: at.path, folder: at.file }],
        detail: '"' + at.file + '" is a file now, and the restore point records an embedded Git repository (a gitlink) '
          + (same ? 'at that path: rewinding would replace the file with that repository\'s empty folder'
            : 'at "' + at.path + '", inside the folder it holds there: rewinding would replace the file with that folder')
          + ', which its undo could not turn back into the file. Nothing was changed; move "' + at.file + '" aside, then rewind again' };
    }
    /* restoreUncapturedConflicts — A REWIND NEVER REPLACES OR DELETES WHAT NO CAPTURE TOOK (restore's NOTHING NO CAPTURE
       TOOK). The pre-restore capture takes every tracked file and every untracked file Git does not ignore; what it cannot
       take is a file Git ignores, a file inside an embedded repository (Git records the folder as one gitlink) or below a
       folder the shadow index records as a gitlink, and a `.git`. An embedded repository is counted here more broadly than
       Git counts one, and so than the walk's looksLikeRepo: every folder holding a `.git` of any kind (a linked worktree's
       gitfile, a `.git` that is a link) that the shadow index tracks no path below (gitRepoAt, review 6.2). Reset only
       writes where the target differs from the work tree as the index sees it, so the paths asked are the target's own
       that the index lacks or the work tree holds as another type (`diff-index --diff-filter=DT <target>`, names only, and
       --ignore-submodules=none: a `.gitmodules` `ignore = all`, a work-tree file, hid a gitlink from it and from every check
       built on it, undo review 7: the person's FILE deleted where the target records one, ok:true; as
       long as what the rewind changes, never the whole tree, and never one capped call: namesIn, which answers null, a
       refusal, only when one folder's own entry list passes the runner's output limit) and the folders above
       them, each looked up in the walk's own listings (scan.entryAt: never through a link, as restoreLinkConflicts proved
       none lies on these paths):
         a file at one of those paths or folders: refused when it is inside a repository (one the walk found, a gitlink the
           index records, or a folder holding a `.git` that the index tracks no path below, above it), or untracked and Git
           ignores it, a batch at a time. Git's rules alone answer that (check-ignore --no-index, here and below): plain
           check-ignore names nothing the index tracks a path below, so a FILE where the last capture saw a folder (logs,
           the index still tracking logs/a.txt) was neither refused nor taken by name, and reset deleted it or wrote over
           it, ok:true, its undo ok:true without it (undo review 6: through the person's own rule, trunk d5024f5a the same;
           through a rule only the target holds, since 8808d408's keptOut and c8e20497's keptFile);
         a folder where the target holds a FILE (reset deletes it with all it holds; a gitlink there is no file: Git leaves
           that folder alone): refused when it is, or is inside, a repository (the same three), holds one or a gitlink the
           index records, a `.git` folder or file, or any file Git ignores (ls-files -o -i, that folder's pathspec alone: no
           link lies below it). It is asked with --directory first, so an ignored folder is named once, and then for every
           file without it: while the shadow index holds the folder's own path as a FILE (the last capture saw a file
           there), Git prints nothing for that folder with --directory (undo review 1: reset then deleted a folder of files
           no capture took, ok:true, through the person's own rule and through a folder only the target's .gitignore lists).
       Git's ignore rules are asked with the shadow repo's info/exclude rewritten for the links found now (writeLinkExcludes,
       as the capture right after does): a link an earlier capture left out may be a plain folder now, captured next. A
       file that only the lines for the folders the target's rules alone prune (scanTree's keptOut) make Git ignore is
       asked again without them: one no rule of the work tree ignores goes into `found.forced`, which the capture takes by
       name (prepareCapture), never refused and never left behind for reset to overwrite or delete, at a path the target
       holds and inside a folder it holds as a FILE alike. A listing of such a folder that the runner's output limit cut
       off before a file that refuses the rewind leaves files unnamed, so it is a check that failed.
       found.leaves: the write list, for restore's own listings before its commit (scanTree's prunedOnChain); found.madeDirs:
       the folders above it the reset makes (nothing stands there, or a file it replaces), for the undo's own count
       (scanTree's afterReset); found.fileDirs: those of them where a FILE stands now ({ dir: the target's spelling, file:
       on disk }), the folders its undo will find where its row holds a file and delete again, and found.fileLeaves the
       paths it writes where a FILE stands now ({ leaf, file }): gitlinkOverFile, and the depth its undo's link check lists
       below such a folder.
         -> null | { ok:false, reason:'uncaptured_in_path' | 'uncaptured_check_failed', detail, paths? } */
    async function restoreUncapturedConflicts(aid, scope, sha, scan, found) {
      const forced = found && found.forced;
      const failed = function (detail) { return { ok: false, reason: 'uncaptured_check_failed', detail: detail }; };
      const runHere = function (args) { return git(aid, scope, args); };
      const leaves = await namesIn(runHere, ['diff-index', '-z', '--ignore-submodules=none', '--no-renames', '--name-only', '--diff-filter=DT', sha], sha);
      if (!leaves) return failed('Git could not list what rewinding would write, to check what stands there');
      if (found) found.leaves = leaves;
      const above = new Map();                          // folded -> spelled: the target's folders above those paths
      for (const p of leaves) for (const a of ancestorsOf(p)) if (!above.has(foldPath(a))) above.set(foldPath(a), a);
      const files = [], dirs = [];                        // a file there now (at a path, or a folder) / a folder at a path
      for (const a of above.values()) {
        const at = await scan.entryAt(a);
        if (at && at.kind === 'file') files.push({ path: at.rel, folder: true });
        if (found && (!at || at.kind === 'file')) found.madeDirs.push(a);   // a folder the reset makes (nothing there, or a file it replaces)
        if (found && at && at.kind === 'file') found.fileDirs.push({ dir: a, file: at.rel });   // ...over a FILE, its undo's to delete again
      }
      for (const p of leaves) {
        const at = await scan.entryAt(p);
        if (at && at.kind === 'file') files.push({ path: at.rel, leaf: p });
        else if (at && at.kind === 'dir') dirs.push({ path: at.rel, leaf: p });   // a link here: restoreLinkConflicts refused it, in any spelling (listUnder)
        if (found && at && at.kind === 'file') found.fileLeaves.push({ leaf: p, file: at.rel });
      }
      if (scan.refusal()) return failed('the folder could not be checked, because ' + scan.refusal());
      if (!files.length && !dirs.length) return null;
      const nested = new Map(scan.nestedDirs.map(function (n) { return [foldPath(n), n]; }));
      const hits = [];
      const hit = function (h) { if (hits.length < 8) hits.push(h); };
      let excluded = false;
      const excludeLinks = function () { if (excluded) return null; excluded = true; return writeLinkExcludes(gitDirFor(aid, scope), scan.links, scan.keptOut); };
      const keptOut = (scan.keptOut || []).map(foldPath);
      const inKeptOut = function (p) { return keptOut.some(function (k) { return atOrBelow(p, k); }); };
      // a repository the walk found, or a gitlink the index records, at a folder above `rel` (gitlinks: folded) -> spelled | ''
      const repoAbove = function (rel, gitlinks) {
        for (const a of ancestorsOf(rel)) if (nested.has(foldPath(a)) || gitlinks.has(foldPath(a))) return a;
        return '';
      };
      // GIT'S OWN RULE, which looksLikeRepo is stricter than (review 6.2): Git (dir.c treat_directory) reads a folder the
      // shadow index tracks a path below as a plain folder, and any other folder whose `.git` is_nonbare_repository_dir
      // accepts (a linked worktree's gitfile, whose git-dir has a commondir; a `.git` that is a link to a repository) as an
      // embedded repository, recorded as one gitlink: no capture takes a file in it. So every folder holding a `.git` of
      // any kind that the index tracks no path below (none at or below a link: the capture drops those first) counts as a
      // repository here, whatever its `.git` holds, erring toward refusal.
      const linkSet = new Set(scan.links.map(function (l) { return foldPath(l.path); }));
      const underLink = function (p) { const f = foldPath(p); return linkSet.has(f) || ancestorsOf(f).some(function (a) { return linkSet.has(a); }); };
      const plainToGit = new Map();                       // folded folder -> whether the index tracks a path below it
      // -> the outermost such folder at or above `rel` (rel itself when it is a folder), spelled | '' | null (Git failed)
      const gitRepoAt = async function (rel) {
        for (const holder of await scan.gitHolders(rel)) {
          const k = foldPath(holder);
          if (!plainToGit.has(k)) {
            const r = await runHere(['ls-files', '-z', '--', literalSpec(holder)]);
            if (!r || (r.code !== 0 && !r.truncated)) return null;
            const recs = String(r.stdout || '').split('\0');
            recs.pop();                                   // '' after the last NUL, or a record the output limit cut off
            const below = recs.some(function (p) { return foldPath(p).indexOf(k + '/') === 0 && !underLink(p); });
            if (!below && r.truncated) return null;
            plainToGit.set(k, below);
          }
          if (!plainToGit.get(k)) return holder;
        }
        return '';
      };
      for (let i = 0; i < files.length && hits.length < 8; i += 256) {   // a reinstalled node_modules: stop at the named few
        const batch = files.slice(i, i + 256);
        const recs = await exactEntries(runHere, ['ls-files', '-z', '-s'], batch.map(function (f) { return f.path; }));
        const linked = recs ? await gitlinksAbove(runHere, batch) : null;
        if (!recs || !linked) return failed('the files the checkpoint tracks could not be listed to check what rewinding would replace');
        const tracked = new Set(recs.map(function (rec) { return foldPath(rec.slice(rec.indexOf('\t') + 1)); }));
        const gitlinks = new Set(linked), ask = [];
        for (const f of batch) {
          const repo = repoAbove(f.path, gitlinks) || await gitRepoAt(f.path);
          if (repo == null) return failed('the files the checkpoint tracks could not be listed to check what rewinding would replace');
          if (repo) hit(Object.assign({ repo: repo }, f));
          else if (!tracked.has(foldPath(f.path))) ask.push(f);
        }
        if (!ask.length || hits.length >= 8) continue;
        const unwritten = excludeLinks();
        if (unwritten) return failed(unwritten);
        const ci = await checkIgnored(runHere, ask.map(function (f) { return ignoreAsked(f.path); }), true);
        if (!ci.ok) return failed('Git could not say which files it ignores (' + String(ci.code) + ')');
        // one in a folder only the target's .gitignore lists (keptOut, left out of the capture by info/exclude) that no
        // rule of the work tree ignores is the capture's to take by name (forced): asked again without those lines
        const ignored = ask.filter(function (f) { return ci.ignored.has(gitQuoted(ignoreAsked(f.path))); });
        const kept = ignored.filter(function (f) { return inKeptOut(f.path); });
        let own = null;
        if (kept.length) {
          const bare = writeLinkExcludes(gitDirFor(aid, scope), scan.links, []);
          excluded = false;                               // the next check that needs the keptOut lines writes them again
          if (bare) return failed(bare);
          own = await checkIgnored(runHere, kept.map(function (f) { return ignoreAsked(f.path); }), true);
          if (!own.ok) return failed('Git could not say which files it ignores (' + String(own.code) + ')');
        }
        for (const f of ignored) {
          if (own && inKeptOut(f.path) && !own.ignored.has(gitQuoted(ignoreAsked(f.path)))) { if (forced) forced.push(f.path); }
          else hit(Object.assign({ ignored: true }, f));
        }
      }
      // what the target holds at each path named so far: a file, or a gitlink (no file: Git makes or leaves a folder there)
      const kinds = await targetKinds(runHere, sha, dirs.map(function (d) { return d.leaf; })
        .concat(hits.filter(function (h) { return h.leaf; }).map(function (h) { return h.leaf; })));
      if (!kinds) return failed('the files of the restore point could not be listed to check what rewinding would replace');
      for (const h of hits) if (h.leaf && kinds.get(foldPath(h.leaf)) === 'commit') h.folder = true;
      const replaced = dirs.filter(function (d) { return kinds.get(foldPath(d.leaf)) === 'blob'; }).map(function (d) { return d.path; });
      const ask = [];
      for (let i = 0; i < replaced.length && hits.length < 8;) {
        const chunk = [];
        for (let len = 0; i < replaced.length && (!chunk.length || len < 6000); i++) { chunk.push(replaced[i]); len += replaced[i].length + 24; }
        const below = await gitlinksAtOrBelow(runHere, chunk);
        const linked = below ? await gitlinksAbove(runHere, chunk.map(function (d) { return { path: d }; })) : null;
        if (!linked) return failed('the files the checkpoint tracks could not be listed to check what rewinding would delete');
        const gitlinks = new Set(linked);
        for (const d of chunk) {
          const df = foldPath(d), inside = function (list) { return list.find(function (x) { return atOrBelow(x, df); }); };
          const repo = nested.get(df) || repoAbove(d, gitlinks) || inside(scan.nestedDirs.concat(below)) || await gitRepoAt(d);
          if (repo == null) return failed('the files the checkpoint tracks could not be listed to check what rewinding would delete');
          const data = repo ? '' : inside(scan.gitFolders.concat(scan.gitFiles));
          if (repo) hit({ path: atOrBelow(repo, df) ? repo : d, replaced: d, repo: repo });
          else if (data) hit({ path: data, replaced: d, gitData: true });
          else ask.push(d);
        }
      }
      for (let i = 0; i < ask.length && hits.length < 8;) {
        const chunk = [];
        for (let len = 0; i < ask.length && (!chunk.length || len < 6000); i++) { chunk.push(ask[i]); len += ask[i].length + 24; }
        const specs = chunk.map(function (d) { return literalSpec(d); });
        const unwritten = excludeLinks();
        if (unwritten) return failed(unwritten);
        // with --directory first, so an ignored folder is named once (an entry printed above a folder: the folder itself
        // is ignored); what only the lines of the target's own folders ignore (keptOut) is the capture's to take, below
        const r = await runHere(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory', '--'].concat(specs));
        if (!r || r.code !== 0 || r.truncated) return failed('Git could not list what it ignores in a folder rewinding would replace');
        for (const raw of String(r.stdout || '').split('\0')) {
          const e = raw.replace(/\/$/, '');
          if (!e || inKeptOut(e)) continue;
          const d = chunk.find(function (x) { return atOrBelow(e, foldPath(x)); });
          const top = d ? '' : chunk.find(function (x) { return atOrBelow(x, foldPath(e)); });
          if (d) hit({ path: e, replaced: d, ignored: true });
          else if (top) hit({ path: top, replaced: top, ignored: true });
        }
        if (hits.length) break;
        // then every file it ignores there, never --directory (the header: Git printed nothing above for a folder whose own
        // path the shadow index holds as a FILE); a folder name printed (an ignored embedded repository) is no file to take
        const every = await runHere(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--'].concat(specs));
        if (!every || (every.code !== 0 && !every.truncated)) return failed('Git could not list what it ignores in a folder rewinding would replace');
        const recs = String(every.stdout || '').split('\0');
        recs.pop();                                       // '' after the last NUL, or a record the output limit cut off
        const take = [];
        for (const e of recs) {
          const d = e && chunk.find(function (x) { return atOrBelow(e.replace(/\/$/, ''), foldPath(x)); });
          if (!d) continue;
          if (!/\/$/.test(e) && inKeptOut(e)) take.push({ path: e, replaced: d });
          else hit({ path: e.replace(/\/$/, ''), replaced: d, ignored: true });
        }
        if (hits.length) break;
        if (every.truncated) return failed('Git could not list every file it ignores in a folder rewinding would replace');
        if (!take.length) continue;
        const bare = writeLinkExcludes(gitDirFor(aid, scope), scan.links, []);
        excluded = false;                                 // the next check that needs the keptOut lines writes them again
        if (bare) return failed(bare);
        const own = await checkIgnored(runHere, take.map(function (f) { return ignoreAsked(f.path); }), true);
        if (!own.ok) return failed('Git could not say which files it ignores (' + String(own.code) + ')');
        for (const f of take) {
          if (own.ignored.has(gitQuoted(ignoreAsked(f.path)))) hit(Object.assign({ ignored: true }, f));
          else if (forced) forced.push(f.path);
        }
      }
      if (!hits.length && scan.refusal()) return failed('the folder could not be checked, because ' + scan.refusal());   // gitHolders listed past the budget
      if (!hits.length) return null;
      const first = hits[0];
      const why = first.repo ? (foldPath(first.repo) === foldPath(first.path) ? 'it is an embedded Git repository' : 'it is inside the embedded repository "' + first.repo + '"')
        : first.gitData ? 'it is Git\'s own data' : 'Git ignores it';
      const where = !first.replaced
        ? 'and the restore point holds a ' + (first.folder ? 'folder' : 'file') + ' at that path: rewinding would ' + (first.folder ? 'delete' : 'replace') + ' it'
        : foldPath(first.replaced) === foldPath(first.path) ? 'and the restore point holds a file at that path: rewinding would delete that folder with all it holds'
          : 'inside the folder "' + first.replaced + '", which the restore point holds as a file: rewinding would delete that folder with it';
      return { ok: false, reason: 'uncaptured_in_path',
        paths: hits.map(function (h) { return h.replaced ? { path: h.path, folder: h.replaced } : { path: h.path }; }),
        detail: '"' + first.path + '" as it is now is in no restore point (' + why + '), ' + where + '. Nothing was changed; move it aside, then rewind again' };
    }
    // the kind of entry ('blob', 'commit' for a gitlink, 'tree') the target holds at each of these paths, spelled as the
    // target spells them (ls-tree, literal pathspecs, chunked) -> Map(folded path -> kind) | null
    async function targetKinds(runIn, sha, paths) {
      const exact = await entryKinds(runIn, sha, paths);
      if (!exact) return null;
      const out = new Map();
      for (const [p, kind] of exact) out.set(foldPath(p), kind);
      return out;
    }
    // the same, keyed by the tree's own spelling -> Map(path -> kind) | null
    async function entryKinds(runIn, tree, paths) {
      const out = new Map(), named = Array.from(new Set(paths));
      for (let i = 0; i < named.length;) {
        const specs = [];
        for (let len = 0; i < named.length && (!specs.length || len < 6000); i++) { specs.push(':(literal)' + named[i]); len += named[i].length + 12; }
        const r = await runIn(['ls-tree', '-z', tree, '--'].concat(specs));
        if (!r || r.code !== 0 || r.truncated) return null;
        for (const rec of String(r.stdout || '').split('\0')) {
          const tab = rec.indexOf('\t');
          if (tab > 0) out.set(rec.slice(tab + 1), rec.slice(0, tab).split(' ')[1]);
        }
      }
      return out;
    }
    // whether the tree records a gitlink (mode 160000) at or below rel, as the tree spells rel ('' its whole tree): `ls-tree -r`, a literal
    // pathspec, each record's mode alone where Git knows --format (2.36), else every record (scanTree's caseRefusal, EMPTY: undo review 10).
    // One listing, never split: past the runner's output limit (about a million modes at 8 MB) it is no answer, and that rewind is refused.
    // modes: what linkRecords saw of this tree's modes; where every one of them was listed and none is a gitlink, no listing below says
    // otherwise, so none is taken (undo review 11)
    //   -> bool | null (Git failed, or the listing was cut off: no answer)
    async function recordsGitlinkUnder(runIn, tree, rel, modesSeen) {
      if (modesSeen && modesSeen.gitlinks === false) return false;
      const spec = rel ? ['--', ':(literal)' + rel] : [];
      const modes = await runIn(['ls-tree', '-r', '-z', '--format=%(objectmode)', tree].concat(spec));
      if (modes && modes.code === 0 && !modes.truncated) return String(modes.stdout || '').split('\0').indexOf('160000') >= 0;
      const recs = await runIn(['ls-tree', '-r', '-z', tree].concat(spec));
      if (!recs || recs.code !== 0 || recs.truncated) return null;
      return String(recs.stdout || '').split('\0').some(function (rec) { return rec.slice(0, 7) === '160000 '; });
    }
    /* linkRecords — the paths the tree `tree` records as a SYMBOLIC LINK (mode 120000), as it spells them: none, or at least
       one of them (undo review 5). This lane's captures record no link the walk finds (prepareCapture leaves those out), but
       a capture before it (trunk d5024f5a's `add -A`) could record one, and where Git writes a link as a plain file
       (core.symlinks false, Windows' usual) the shadow index keeps that record for the plain file standing there, so every
       capture after it records it too.
       First every record's mode alone (`ls-tree -r --format=%(objectmode)`: seven bytes an entry, about a million entries
       under the runner's 8 MB), the usual answer, none; where it shows one, the same with each path, to name it; where
       that listing is cut off before one, or Git is older than 2.36 (no --format), every record of the tree, from its
       root's entries down (treeUnder: a command line at a time, a batch past the limit in halves). A listing cut off is
       never read as "none". So on such a Git, or past about a million records, a rewind to or from a tree holding a folder
       whose own entry list passes the limit is refused (link_check_failed), whether or not it touches that folder.
       seen.gitlinks: whether that first listing, whole, holds a gitlink (mode 160000), null when it was cut off or failed
       (recordsGitlinkUnder).
         -> string[] | null (Git failed, or one folder's own entry list passed the output limit: namesIn's NOT COVERED) */
    async function linkRecords(runIn, tree, seen) {
      const modes = await runIn(['ls-tree', '-r', '-z', '--format=%(objectmode)', tree]);
      const whole = !!(modes && modes.code === 0 && !modes.truncated), each = whole ? String(modes.stdout || '').split('\0') : null;
      if (seen) seen.gitlinks = whole ? each.indexOf('160000') >= 0 : null;
      if (whole && each.indexOf('120000') < 0) return [];
      const named = await runIn(['ls-tree', '-r', '-z', '--format=%(objectmode)%x09%(path)', tree]);
      if (named && (named.code === 0 || named.truncated)) {
        const recs = String(named.stdout || '').split('\0');
        recs.pop();                                       // '' after the last NUL, or a record the output limit cut off
        const found = recs.filter(function (rec) { return rec.slice(0, 7) === '120000\t'; }).map(function (rec) { return rec.slice(7); });
        if (found.length || (named.code === 0 && !named.truncated)) return found;
      }
      const top = await runIn(['ls-tree', '-z', '--name-only', tree]);
      if (!top || top.code !== 0 || top.truncated) return null;
      const all = await treeUnder(runIn, tree, nulNames(top), true);
      if (!all) return null;
      return all.filter(function (rec) { return rec.slice(0, 7) === '120000 '; }).map(function (rec) { return rec.slice(rec.indexOf('\t') + 1); });
    }
    /* symlinkRefusal — A REWIND RUNS ONLY BETWEEN TREES THAT RECORD NO SYMBOLIC LINK (undo review 5). Where Git makes links
       (core.symlinks, POSIX's default) `reset --hard` writes a link the target records as a real symbolic link, and no
       check of the rewind looked at what the target records: it completed, and its undo's link check
       (restoreLinkConflicts) took the new link for one of the person's own, at a path its index (the target's) holds, and
       refused on every try (link_in_path): the files the link replaced and the edits since the last capture were left in
       the undo row only (2d1c2fb9 the same; trunk d5024f5a, with no link check, undid it). Refusing only where the reset
       writes such a record is not enough: whether Git writes it as a link, and whether a capture keeps the record for a
       plain file, turn on core.symlinks, which a person can change between a rewind and its undo (turned on, the undo's
       capture records that plain file as a file, and its own check, the target's link where it writes, refuses it). So
       a rewind is refused, before its commit, when the target records a link anywhere (ahead), or the tree its capture
       staged does (the undo row: an older capture's record kept for a plain file); its undo, between the same two trees,
       then meets none, whatever Git makes of a link. Erring toward refusal: where Git writes links as plain files many
       would round-trip (the lane test header's DEFERRED). */
    function symlinkRefusal(paths, ahead) {
      const p = paths[0];
      return { ok: false, reason: 'link_in_path', links: paths.slice(0, 8).map(function (x) { return { path: x, link: x }; }),
        detail: ahead
          ? '"' + p + '" is a symbolic link in the restore point (a capture older than the checkpoint\'s link check recorded it): rewinding to it could make that link, which its undo would take for a link of your own and refuse to remove. Nothing was changed; a rewind to a restore point that records a symbolic link is refused'
          : '"' + p + '" is recorded as a symbolic link in the files rewinding would save as its undo (a capture older than the checkpoint\'s link check recorded it, and the file there now keeps that record): its undo could make that link, which a later rewind would take for a link of your own. Nothing was changed; move "'
            + p + '" aside, then rewind again' };
    }
    /* removedByReset — what `reset --hard` will delete: each path the pre-restore capture's tree holds that the target
       lacks, and each it holds as another type (diff-tree DT, names only, --ignore-submodules=none as the write list asks,
       never one capped call: namesIn, so a rewind
       past a big install is not refused). That is also the undo's own write list (its diff-index DT, the same paths of the
       same tree asked the same way), so a rewind whose undo could not list what it writes is refused here instead.
       Listed BEFORE the pre-restore commit (commitSnapshot's beforeCommit), so when Git cannot give it, a flat folder
       whose own entry list passes the runner's output limit among them (namesIn's NOT COVERED), the rewind is refused with
       nothing touched and no undo row. Listed only after the reset (review minors R6-12), that answer came once the
       folder was deleted, and every restore of the undo row, or of any row holding the folder, was refused the same way
       (its write list overflowed in that folder too): the folder then lived only in the shadow repo. A path reset changes
       the type of is no file left behind once the index, the target's then, holds it (leftByReset).
         -> string[] | null */
    async function removedByReset(aid, scope, tree, sha) {
      return namesIn(function (args) { return git(aid, scope, args); },
        ['diff-tree', '-r', '-z', '--ignore-submodules=none', '--no-renames', '--name-only', '--diff-filter=DT', tree, sha], tree);
    }
    /* leftByReset — the files `reset --hard` was to delete and did not. Git only warns when it cannot unlink one (another
       program holds it open without delete sharing: a dev server's log, an open database, a running .exe) and still exits
       0. Each path of `due` (removedByReset, listed before the reset) must be gone: lstat only,
       never through a link (the capture left every link out of Git's view). A folder there now is no file left behind
       (the target holds that folder, or it was a gitlink, whose folder Git never deletes), and neither is a file the index,
       which is the target's now, holds at that path case-folded (a case-only rename) or at a folder above it.
         -> { count, paths: [first 4] } | null (Git could not list what the index holds at a file still there) */
    async function leftByReset(aid, scope, due) {
      const workTree = workTreeFor(aid, scope), still = [];
      for (let i = 0; i < due.length; i += 32) {
        const found = await Promise.all(due.slice(i, i + 32).map(async function (p) {
          try { return (await lstatAsync(pathMod.join(workTree, p))).isDirectory() ? '' : p; }
          catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? '' : p; }   // unreadable is not shown to be gone
        }));
        for (const p of found) if (p) still.push(p);
      }
      if (!still.length) return { count: 0, paths: [] };
      const asked = new Set(still);
      for (const p of still) for (const a of ancestorsOf(p)) asked.add(a);
      const recs = await exactEntries(function (args) { return git(aid, scope, args); }, ['ls-files', '-z', '-s'], Array.from(asked));
      if (!recs) return null;
      const held = new Set(recs.map(function (rec) { return foldPath(rec.slice(rec.indexOf('\t') + 1)); }));
      const left = still.filter(function (p) { return !held.has(foldPath(p)) && !ancestorsOf(p).some(function (a) { return held.has(foldPath(a)); }); });
      return { count: left.length, paths: left.slice(0, 4) };
    }
    /* namesReadApart — NAMES GIT AND THE FILE SYSTEM READ APART (undo review 7): refused before the commit, so no rewind goes ahead
       on what a lookup by Git's fold or by the walk's answered for another spelling. Asked once, of what the two trees hold (the staged
       index with `--with-tree`, the same pair its undo asks of, so what passes here passes there) and of what stands on disk:
       a path holding a letter outside ASCII. Git's fold (A-Z alone) and the file system's (NTFS's on this volume: THE FOLD, above: none onto an
       ASCII letter) differ only there. The lookups by Git's
       fold missed a tracked Uebung/x.txt (U-umlaut) at a junction uebung (u-umlaut): a rewind and its undo wrote and deleted
       through it, ok:true, and replaced a folder holding a junction with a FILE in the other case, emptying the junction's
       target (ab10c33a the same; trunk d5024f5a, with no link check, lost more, in ASCII too). A respelled file answered
       git_failed from both calls, every byte in place (since efe05441, status only; trunk d5024f5a answered ok). Refused: two spellings of one name in the two trees (a capture of a folder respelled so keeps the index's and adds
       the disk's; the reset writes one file twice), and a name the disk spells another way than a tree (scanTree's
       spelledApart). So the undo meets each name in the one spelling, whatever the reset leaves. Moving it aside and capturing
       again clears the index. Two names the fold alone reads as one, NTFS two, are refused the same way, so a rewind never leaves two such names
       standing for its undo to refuse (foldedTwoRefusal). A NAME THE FOLD READS AS ALL ASCII (readsAsAscii, the Kelvin sign) has no such list to meet its twin in: with T holding
       k and the undo row its Kelvin twin, the rewind went ahead and its undo was refused on every try, its row holding the only copy (2caa2665 the same). So a rewind to or
       from a tree that records one is refused, whatever stands there.
       WINDOWS SHORT NAMES (where the file system is Windows'). A long name has a second one, LINKED~1, which a path spelled that
       way reaches, while the walk's listings and Git know the long name alone: T's LINKED~1/x.txt was written through a
       junction, T's LONGNA~1.TXT over an ignored file. Asking the file system what such a name reaches now is no answer: the undo
       row's literal LONGNA~1.TXT is deleted by the reset, the target's long name takes that short name, and the undo's check would
       refuse its own row on every try (and leftByReset found the literal name still there). So a rewind to or from a tree
       that records any component of that shape (SHORT_NAME_RE) is refused, whatever stands there now: neither way ever writes
       through one. A literal folder of that name is refused too (the lane test header's DEFERRED).
       Git's list holds such names alone, so it is as long as they are; past the runner's output limit the rewind is refused
       (at 8 MB, about 100k such paths; the lane test header's DEFERRED).
         -> null | { ok:false, reason:'uncaptured_check_failed', detail } */
    async function namesReadApart(runIn, scan, sha) {
      if (!foldCase) return null;
      const refused = function (detail) { return { ok: false, reason: 'uncaptured_check_failed', detail: detail }; };
      const oneName = function (a, b) {
        return refused('"' + (a || b) + '" and ' + (a ? '"' + b + '"' : 'what the file system reads under that name') + ' are spelled apart in a letter outside A-Z, which Git reads as two names and the file system may read as one, so rewinding could write or delete through the other spelling, which its undo could not give back as it is. Nothing was changed; move "'
          + (a || b) + '" aside, then rewind again');
      };
      const names = await oddNames(runIn, winPaths ? UNFOLDED_SPECS.concat(SHORT_SPECS) : UNFOLDED_SPECS, sha);
      if (!names) return refused('Git could not list the names holding a letter outside A-Z' + (winPaths ? ' or spelled like a Windows short name' : '') + ', to check how the file system reads them. Nothing was changed');
      const spelled = new Map();                          // folded path -> the spelling seen first
      for (const p of names) {
        for (const q of ancestorsOf(p).concat([p])) {
          if (winPaths && SHORT_NAME_RE.test(q.slice(q.lastIndexOf('/') + 1))) {
            return refused('"' + q + '" is spelled like a Windows short name, the second name Windows gives a long-named file or folder, so Git could write or delete through it whatever it names now, which an undo could not give back. Nothing was changed; a rewind to or from a restore point holding such a name is refused. If it stands in your folder, rename it, then rewind again');
          }
          if (!holdsNonAscii(q)) continue;
          if (readsAsAscii(q.slice(q.lastIndexOf('/') + 1))) {
            return refused('"' + q + '" holds a letter outside A-Z that the checks of a rewind read as a plain one (the Kelvin sign, as k), so rewinding could write or delete under the other spelling, which its undo could not give back as it is. Nothing was changed; a rewind to or from a restore point holding such a name is refused. If it stands in your folder, rename it, then rewind again');
          }
          const k = foldPath(q), first = spelled.get(k);
          if (first === undefined) spelled.set(k, q);
          else if (first !== q && gitFold(first) !== gitFold(q)) return oneName(first, q);
        }
      }
      for (const p of names) {
        if (!holdsNonAscii(p)) continue;
        const at = await scan.spelledApart(p);
        if (scan.refusal()) return refused('the folder could not be checked, because ' + scan.refusal());
        if (at) return oneName(at.have, at.want);
      }
      return null;
    }
    /* foldedTwoRefusal — the other half of THE FOLD (above): two entries of one folder foldName reads as one and Git's fold as two. The file
       system holds both, so it reads them apart, and every map here keeps one spelling per fold: T's FILE in the Angstrom sign, beside a folder
       a-ring, replaced a folder of that spelling holding a junction, whose target it emptied, ok:true (undo review 8). And an entry that reads as all ASCII (readsAsAscii): T's
       k/x.txt, with the ignored folder in the Kelvin sign standing, went ahead through a lookup that read the one as the other, and its undo, the two side by side, was
       refused on every try. Asked last of a rewind's checks, when every listing they took is in, those its undo will take among them
       (scanTree's afterReset); what a tree holds was asked of namesReadApart, so a rewind that passes never makes such a pair for its undo to meet.
       CASE APART (undo reviews 9, 10). In a folder that reads case apart (a folder WSL made, or one fsutil marked) Git's core.ignorecase reads two names in
       A-Z case apart as one and it opens `.gitignore` by its exact name, while the walk read a `.GITIGNORE` there as Git's: the target's kept the
       person's untracked cs/build out of the capture, the undo's walk entered it, and the undo's reset deleted it, ok:true on both calls (since
       c8e20497). Beside a captured cs/a.txt the person's cs/A.txt was in no row, and its bytes were stored at the twin's length (Git for Windows'
       fscache), each rewind ok:true. Such twins refuse a rewind as any pair does, before its capture's `add` (and skip a capture: prepareCapture), wherever the walk and the checks
       listed them but inside an embedded repository or a `.git` folder (undo review 10: past eight pairs at the top of a clone no pair was seen), and so
       do, in scanTree's caseRefusal: every such folder the checks list, unless the reset deletes all it holds, each spelled as it stands at every
       component, and writes nothing at or below it (undo review 10: a folder respelled since the last capture held what the reset was to delete there,
       and the rewind answered ok with it standing); a folder whose entries the reset changes that holds only names with no letter A-Z, which no name can
       ask, unless the reset empties it (undo review 10: a FILE there the reset made a folder of took that folder's case, and its undo, writing the FILE
       back, could not empty it); a folder that holds nothing, which the reset writes into, unless its undo empties it as it was written and asks the
       folder above it on both sides (undo review 10: a gitlink's empty folder in it, or the folder above holding besides it only names with no letter
       A-Z, stranded the undo); a reset that leaves the root holding nothing and drops a gitlink; and a rewind that leaves a folder holding only names
       with no letter A-Z where it held one with one, or the other way round: its undo would ask that folder on the other side.
       WHAT GIT LEAVES (undo review 11). Git leaves a file another program holds open (it warns, and leftByReset answers git_failed with the undo row) and a
       folder that is another program's working folder or read-only (Git for Windows' rmdir clears no attribute; the rewind answers ok, that folder standing
       empty); no capture records an empty folder, so its undo deletes or drops what a reset wrote where one stood, and no folder comes back; and Git keeps the
       spelling a path first had. Each rule above that rests on Git removing a folder, or on a tree spelling a name as the disk does, refused the undo of a rewind
       that completed, or of one left incomplete, on every try: a folder the reset emptied, left holding some of its names, which no name asked or which held a
       letter on one side only (UNASKED, LETTERS), or, reading case apart, any (CASE APART's exception); left holding nothing, for its undo to write into through
       another spelling or with a gitlink's empty folder (EMPTY); an empty folder where the reset wrote a FILE or a gitlink, or two empty folders it wrote into
       beside names with no letter, whose undo left the folder above holding only those (LETTERS, ROOT LEFT EMPTY); and a rewind Git stopped partway: where it
       writes a FILE at a folder or makes a folder of a FILE and cannot, it does not warn but stops (entry.c remove_subtree, create_directories), every deletion done
       and the writes after that path not, so a folder lost its lettered name and never got the one to come. So, in scanTree's caseRefusal: PARTIAL and STANDING, on
       every folder that must go; AT and U, on every folder that holds no file; ITS UNDO'S OWN, every folder the reset makes or fills from nothing asked as its undo
       asks it, so each rule refuses the rewind that would make its undo meet it; SPELLED and TWO SPELLINGS, so every path in play has one spelling, the disk's;
       and HELD and STOPS, where a folder that reads case apart must go, or where Git would stop, asked of the file system as late as the checks go: a program that
       opens one of them after that is not seen (the lane test header's DEFERRED). IN USE (undo review 12): Git leaves a file it cannot delete and stops at one it
       cannot write over, its index unwritten, and the undo of either, the hold gone, met a file the target's rules ignore, or a spelling its index did not hold,
       on every try; so every file the reset deletes or writes over is asked the same way, a program running from it too (inUse). Twins found before the capture
       refuse it before its `add` (prepareCapture); those only these checks list, here. writes: the paths the reset writes that the index lacks (found.leaves); removes:
       those it deletes (removedByReset); rewrites: those it writes over; gitlinkUnder(rel) and gitlinkBack(rel): whether the target, and the tree the capture
       staged (its undo's target), record a gitlink at or below rel ('' the whole tree), null when Git could not say.
         -> null | { ok:false, reason:'uncaptured_check_failed' | 'link_check_failed', detail } */
    // two names Git reads as one, side by side (scanTree's caseTwins): a rewind's refusal, before its capture's `add` (prepareCapture) or after it
    // where only a listing of these checks found them (foldedTwoRefusal)
    function twinsRefusal(twins) {
      return { ok: false, reason: 'uncaptured_check_failed', detail: '"' + twins.first + '" and "' + twins.second + '" stand side by side in a folder that reads case apart, and Git reads them as one name, so it could take, write or delete one of them as the other, which its undo could not give back as it is. Nothing was changed; move one of them aside, then rewind again' };
    }
    async function foldedTwoRefusal(scan, writes, removes, rewrites, gitlinkUnder, gitlinkBack) {
      if (!foldCase) return null;
      const twins = scan.caseTwins();
      if (twins) return twinsRefusal(twins);
      const two = scan.foldedTwo();
      if (two) {
        return { ok: false, reason: 'uncaptured_check_failed', detail: two.second
          ? '"' + two.first + '" and "' + two.second + '" stand side by side, spelled apart in a letter outside A-Z that the checks of a rewind read as one name, so they could not tell which one Git would write or delete. Nothing was changed; move one of them aside, then rewind again'
          : '"' + two.first + '" holds a letter outside A-Z that the checks of a rewind read as a plain one (the Kelvin sign, as k), so they could not tell it from the same name in a plain k. Nothing was changed; move it aside, then rewind again' };
      }
      const cs = await scan.caseRefusal(writes, removes, { rewrites: rewrites, gitlinkUnder: gitlinkUnder, gitlinkBack: gitlinkBack });
      if (scan.refusal()) return { ok: false, reason: 'link_check_failed', detail: 'the folder could not be checked, because ' + scan.refusal() };
      if (!cs) return null;
      const dir = cs.dir || '.';
      const unasked = 'so the checks could not ask whether it reads names in another case apart (a case-sensitive folder, as WSL makes one and fsutil marks one)';
      const refused = function (detail) { return { ok: false, reason: 'uncaptured_check_failed', detail: detail }; };
      const leftBy = '(a file another program holds open, another program\'s working folder, a read-only folder)';
      if (cs.why === 'unasked') {
        return refused('"' + dir + '" holds only names with no letter A-Z, ' + unasked + ', and rewinding would add, delete or replace a name there, which its undo could not ask either. Nothing was changed; move what it holds aside, then rewind again');
      }
      if (cs.why === 'partial') {
        return refused(cs.undo
          ? '"' + cs.name + '" has no letter A-Z in its name, and rewinding would leave it beside another name in "' + dir + '", a folder it makes or fills where it holds nothing, which its undo would empty: were Git to leave something in that folder then ' + leftBy + ', the undo of that undo, writing the rest back beside it, could not ask whether the folder reads names in another case apart, so that undo is refused as this rewind is refused such a folder. Nothing was changed; a rewind that makes such a folder is refused so'
          : '"' + cs.name + '" has no letter A-Z in its name, and rewinding would empty "' + dir + '", which holds it: were Git to leave something in that folder ' + leftBy + ', its undo, writing the rest back beside it, could not ask whether the folder reads names in another case apart (a case-sensitive folder, as WSL makes one and fsutil marks one), and would be refused on every try. Nothing was changed; move what it holds aside, then rewind again');
      }
      if (cs.why === 'spelled') {
        return refused('"' + dir + '" is spelled "' + cs.want + '" in ' + (cs.back ? 'what rewinding would save as its undo' : 'the restore point') + ', and Git goes by that spelling, so its undo could not give it back as it stands. Nothing was changed; rename it as "' + cs.want + '", or move it aside, then rewind again');
      }
      if (cs.why === 'standing') {
        return refused(cs.detail === 'gitlink'
          ? 'rewinding would remove "' + dir + '", where what it would save as its undo records an embedded repository (a gitlink): were Git to leave that folder standing (another program\'s working folder, or a read-only one), holding nothing, its undo would write that repository into it, which it refuses. Nothing was changed; remove the repository\'s empty folder there, then rewind again'
          : 'Git could not list what the files rewinding would remove' + (cs.dir ? ' from "' + dir + '"' : '') + ' hold, to check them for an embedded repository its undo could write into a folder that holds nothing. Nothing was changed');
      }
      if (cs.why === 'made') {
        return refused(cs.detail === 'unlisted'
          ? 'Git could not list what the restore point holds in "' + dir + '", a folder rewinding would make or fill, to check it for an embedded repository. Nothing was changed'
          : '"' + dir + '", a folder rewinding would make or fill where it holds nothing, would hold an embedded repository\'s empty folder (a gitlink in the restore point), and its undo, emptying that folder, is refused as this rewind is refused such a folder: were Git to leave it standing, the undo of that undo would record the repository in a folder that holds nothing. Nothing was changed; a rewind that makes such a folder is refused so');
      }
      if (cs.why === 'twins') {
        return refused('"' + cs.name + '" and "' + cs.other + '" are one name to Git, spelled two ways in what rewinding would write, so its undo could not delete them as they are spelled. Nothing was changed');
      }
      if (cs.why === 'held') {
        return refused('"' + cs.name + '" is in use (open in another program, a program running from it, another program\'s working folder, or read-only), in "' + dir + '", a folder that reads names in another case apart that rewinding would empty: Git could not remove it, and that folder would stand, reading so, for its undo to refuse on every try. Nothing was changed; close it in that program, or clear its read-only attribute, then rewind again');
      }
      if (cs.why === 'stops') {
        return refused('"' + cs.name + '" is in use (open in another program, a program running from it, another program\'s working folder, or read-only), and rewinding would replace ' + (cs.name === dir ? 'it' : '"' + dir + '", which holds it,') + ' with what the restore point holds there: Git could not, and would stop there with the rest of the rewind not done, for its undo to refuse. Nothing was changed; close it in that program, or clear its read-only attribute, then rewind again');
      }
      if (cs.why === 'inuse') {
        return refused('"' + cs.name + '" is in use (open in another program, a program running from it, or a read-only program file), and rewinding would ' + (cs.over
          ? 'write over it: Git could not, and would stop there with the rest of the rewind not done'
          : 'delete it: Git could not, and would leave it there with the rewind not complete') + ', which its undo may not give back as it is. Nothing was changed; close it in that program, or clear its read-only attribute, then rewind again');
      }
      if (cs.why === 'empty' && cs.detail === 'unlisted') {
        return refused(cs.at
          ? 'Git could not list what the restore point holds, to check it for an embedded repository its undo would drop where "' + dir + '", a folder that holds no file, stands. Nothing was changed'
          : 'Git could not list what the restore point holds in "' + dir + '", a folder that holds nothing, to check it for an embedded repository. Nothing was changed');
      }
      if (cs.why === 'empty' && cs.at) {
        const how = cs.detail === 'parent' ? ' while the folder above it, "' + (cs.name || '.') + '", holds no other name with a letter A-Z'
          : ' while every folder above it holds nothing else, and the restore point records an embedded repository (a gitlink) its undo would drop there';
        return refused('"' + dir + '" holds no file, ' + unasked + ', and rewinding would write a file or an embedded repository where it stands' + how + ', which its undo, deleting what it wrote there, could not give back as it is. Nothing was changed; remove that folder, then rewind again');
      }
      if (cs.why === 'empty') {
        const how = cs.detail === 'parent' ? 'while the folder above it, "' + (cs.name || '.') + '", holds no other name with a letter A-Z'
          : cs.whole ? 'while every folder above it holds nothing else, and the restore point records an embedded repository (a gitlink) that its undo would drop there, leaving the root holding nothing'
            : 'an embedded repository\'s empty folder (a gitlink in the restore point)';
        return refused('"' + dir + '" holds nothing, ' + unasked + ', and rewinding would write into it ' + how + ', which its undo could not give back as it is. Nothing was changed; '
          + (cs.dir ? 'remove that empty folder, then rewind again' : 'a rewind into a folder that holds nothing is refused so'));
      }
      if (cs.why === 'rootEmpty') {
        return { ok: false, reason: 'uncaptured_check_failed', detail: 'rewinding would leave the folder holding nothing and drop the embedded repository "' + cs.name + '" (a gitlink), and its undo, recording that repository in a folder that holds nothing, could not ask whether that folder reads names in another case apart. Nothing was changed; a rewind that leaves the folder holding nothing is refused so' };
      }
      return { ok: false, reason: 'uncaptured_check_failed', detail: cs.why === 'apart'
        ? '"' + dir + '" reads names in another case apart ("' + cs.name + '" is there and "' + cs.flipped + '" is not: a case-sensitive folder, as WSL makes one and fsutil marks one), and Git reads two such names as one and a .gitignore only by its exact name there, so rewinding could miss, write or delete a file there that its undo could not give back as it is. Nothing was changed; make that folder case-insensitive again (fsutil.exe file setCaseSensitiveInfo "<folder>" disable) or move it aside, then rewind again'
        : '"' + dir + '" holds names with no letter A-Z on one side of this rewind and a name with one on the other, so the checks could not ask whether it reads names in another case apart, which its undo would ask. Nothing was changed; move what it holds aside, then rewind again' };
    }
    /* storedAsItIsRefusal — A ROW AN OLDER STORE WROTE (undo review 8). The pin (pinAttributes) stops every conversion on the way out as well
       as on the way in. A row captured before it, under a .gitattributes or the person's attributes file, holds the converted blob, and only
       the conversion gave the person's bytes back: rewound through the pin, a Git LFS file came back as its pointer text, a CRLF file with
       LF, a UTF-16 file as UTF-8, ok:true. So every commit since says so in its message (STORED_AS_IT_IS), and a rewind to one that does
       not is refused where a conversion could have changed what it stored: a .gitattributes it holds, or one the walk or the link check listed on disk (an
       ignored one is in no tree; a tracked file's folders are all listed by then), with a line that names text, eol, crlf, ident, filter or working-tree-encoding, any value, not unset by
       - or !; core.attributesFile set; such a line in the file Git reads when it is not, or in the system's own. One with none of those holds what was on disk,
       or what a rule gone since made of it, which no store could turn back.
       Erring toward refusal: a row whose rule changed nothing is refused too (the lane test header's DEFERRED).
         -> null | { ok:false, reason:'uncaptured_check_failed', detail } */
    const ATTRIBUTE_FILES = ':(glob' + (foldCase ? ',icase' : '') + ')**/.gitattributes';
    const CONVERSION_RE = /^(?:text|eol|crlf|ident|filter|working-tree-encoding)(?:=.*)?$/;
    function convertingLine(text) {
      for (const raw of String(text).split('\n')) {
        const words = raw.trim().split(/\s+/);
        if (words[0] && words[0][0] !== '#' && words.slice(1).some(function (w) { return CONVERSION_RE.test(w); })) return raw.trim();
      }
      return '';
    }
    // the attributes file Git reads when core.attributesFile is not set, wherever it can be ($XDG_CONFIG_HOME/git/attributes, or under $HOME)
    function defaultAttributesFiles() {
      const e = (typeof process !== 'undefined' && process.env) || {};
      const homes = [e.HOME, e.HOMEDRIVE && e.HOMEPATH ? e.HOMEDRIVE + e.HOMEPATH : '', e.USERPROFILE].filter(Boolean);
      const dirs = e.XDG_CONFIG_HOME ? [e.XDG_CONFIG_HOME] : homes.map(function (h) { return pathMod.join(h, '.config'); });
      return dirs.map(function (d) { return pathMod.join(d, 'git', 'attributes'); });
    }
    async function storedAsItIsRefusal(gitDir, runIn, workTree, sha, scan) {
      const failed = { ok: false, reason: 'uncaptured_check_failed', detail: 'Git could not read what the restore point says of its bytes, to check it. Nothing was changed' };
      const says = await commitSaysAsItIs(runIn, sha);
      if (says == null) return failed;
      if (says) return null;
      const refused = function (what) {
        return { ok: false, reason: 'uncaptured_check_failed', detail: 'this restore point is older than the checkpoint\'s byte-exact storage, and ' + what + ', so it may hold converted bytes (a Git LFS pointer, other line endings) that a rewind could not turn back into yours. Nothing was changed; restore points taken since go ahead' };
      };
      const cfg = personalConfig.get(gitDir);
      if (!cfg) return failed;
      if (cfg.attributesFile) return refused('your Git config sets core.attributesFile');
      // where Git says its system-wide file is; 129: a Git older than 2.42, which knows no such name and cannot say (the lane test header's DEFERRED)
      const sys = await runIn(['var', 'GIT_ATTR_SYSTEM']);
      if (!sys || (sys.code !== 0 && sys.code !== 129)) return failed;
      for (const file of (sys.code === 0 ? [String(sys.stdout || '').trim()] : []).concat(defaultAttributesFiles())) {
        let text = '';
        try { text = await readText(file); }
        catch (e) { if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) { failNote('checkpoint.attributes', e); return failed; } }
        if (convertingLine(text)) return refused('your Git reads an attributes file of its own that asks it to convert files');
      }
      const listed = await runIn(['diff-tree', '-r', '-z', '--no-renames', '--name-only', emptyTreeLike(sha), sha, '--', ATTRIBUTE_FILES]);
      if (!listed || listed.code !== 0 || listed.truncated) return failed;
      const held = await ignoreFiles(runIn, sha, nulNames(listed));
      if (held === false) return failed;
      if (held) for (const [p, text] of held) if (convertingLine(text)) return refused('its "' + p + '" asks Git to convert files');
      for (const p of scan.attributeFiles()) {
        let text;
        try { text = await readText(pathMod.join(workTree, p)); }
        catch (e) { failNote('checkpoint.attributes', e); return failed; }
        if (convertingLine(text)) return refused('"' + p + '" in your folder asks Git to convert files');
      }
      return null;
    }
    async function restoreDetailed(agentId, snapshotId) {
      if (!AID_RE.test(String(agentId || '')) || !cp.isValidId(String(snapshotId || ''))) return { ok: false, reason: 'invalid' };
      const aid = String(agentId), fullId = String(snapshotId);
      // resilient load: if index.json was wiped but the commit still exists, a git-log rebuild re-admits it so
      // a rollback target survives an index loss (the commits are the truth).
      const record = cp.findById(await loadIndexResilient(aid), fullId);
      if (!record) return { ok: false, reason: 'unknown' };                       // refuse an id we didn't record
      const scope = record.scopeId ? readScope(aid, String(record.scopeId))
        : { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      if (!scope) return { ok: false, reason: 'unavailable' };                    // revoked/missing/mismatched project root
      const sha = record.gitCommit || fullId;
      if (!cp.isValidId(String(sha || ''))) return { ok: false, reason: 'invalid' };
      if (scope.id && fullId !== scope.prefix + sha) return { ok: false, reason: 'invalid' };   // root identity is part of the id
      // LINKS ON THE DESTINATION: one walk, checked against every path the rewind would write or delete, then reused by
      // the pre-restore capture's boundary. Refused here, nothing has been touched and no undo row was written. It prunes
      // by the target's own .gitignore too (targetIgnoreRules; WHAT A REWIND REMOVES, below)
      const runScan = function (args) { return git(aid, scope, args); };
      // before anything reads the shadow index: the first capture on a shadow repo an older store wrote reads the index again, and a
      // check that read the old one counted what only that held as captured (undo review 8: the person's ignored FILE deleted, ok:true)
      const gitDir = gitDirFor(aid, scope);
      if (repoExists(aid, scope)) {
        try { await clearStaleGitLocks(aid, gitDir); } catch (e) { failNote('checkpoint.staleLock', e); }
        const unready = await readyShadowRepo(gitDir, runScan, function (args) { return git(aid, scope, args, maintenanceTimeoutMs); });
        if (unready) return { ok: false, reason: 'pre_restore_failed', detail: 'restore point skipped: ' + unready };
      }
      const theirRules = await targetIgnoreRules(runScan, sha);
      if (theirRules === false) return { ok: false, reason: 'link_check_failed', detail: 'the .gitignore files of the restore point could not be read, to check the folder by them' };
      const scan = await scanFor(workTreeFor(aid, scope), gitDirFor(aid, scope), runScan, theirRules, true);
      if (!scan.ok) return { ok: false, reason: 'link_check_failed', detail: 'the folder could not be checked for links, because ' + scan.reason };
      const conflict = await restoreLinkConflicts(aid, scope, sha, scan);
      if (conflict) return conflict;
      // A ROW AN OLDER STORE WROTE, after the link check: it has listed every folder above a path the index or the target holds
      const older = await storedAsItIsRefusal(gitDir, runScan, workTreeFor(aid, scope), sha, scan);
      if (older) return older;
      // NOTHING NO CAPTURE TOOK: refused here too, before anything is touched; found.forced: the files in a folder only the
      // target's .gitignore lists that the rewind writes over or deletes, which the capture takes by name; found.leaves:
      // what it writes, found.madeDirs the folders it makes, found.fileDirs those it makes over a FILE, found.fileLeaves
      // what it writes where a FILE stands
      const found = { forced: [], leaves: [], madeDirs: [], fileDirs: [], fileLeaves: [] };
      const uncaptured = await restoreUncapturedConflicts(aid, scope, sha, scan, found);
      if (uncaptured) return uncaptured;
      // the folders the reset makes that the undo will prune (scanTree's prunedOnChain), outermost, once each
      const made = new Map(), onChain = new Map();
      for (const p of found.leaves) {
        const dir = p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '';
        if (!dir) continue;
        if (!onChain.has(dir)) onChain.set(dir, scan.prunedOnChain(p));
        const f = onChain.get(dir);
        if (f && !made.has(foldPath(f))) made.set(foldPath(f), f);
      }
      // WHAT RESET WILL REMOVE, and what the undo will need of Git, taken on the tree the pre-restore capture staged, before
      // its commit: refused here, nothing has been touched and no undo row was written (THE UNDO ROW RESTORES THROUGH THIS
      // API, above)
      let due = null;
      const preWhy = {}, aheadModes = {}, backModes = {};
      const runHere = function (args) { return git(aid, scope, args); };
      const pre = await commitSnapshot(aid, scope,
        { runId: '', turn: 0, label: 'pre-restore (before rewinding to ' + String(sha).slice(0, 12) + ')' },
        { always: true, scan: scan, forced: found.forced, beforeCommit: async function (tree) {
          // NAMES GIT AND THE FILE SYSTEM READ APART (namesReadApart): this tree, the target and the work tree spell each one way
          const apart = await namesReadApart(runHere, scan, sha);
          if (apart) return apart;
          due = await removedByReset(aid, scope, tree, sha);
          if (!due) return { ok: false, reason: 'uncaptured_check_failed', detail: 'Git could not list what rewinding would remove, to check afterwards that it is gone' };
          // NOR DOES EITHER WAY MAKE A SYMBOLIC LINK (symlinkRefusal): neither the target nor this tree, its undo's target,
          // may record one
          const linkAhead = await linkRecords(runHere, sha, aheadModes);
          if (!linkAhead) return { ok: false, reason: 'link_check_failed', detail: 'the files of the restore point could not be listed to check them for symbolic links' };
          if (linkAhead.length) return symlinkRefusal(linkAhead, true);
          const linkBack = await linkRecords(runHere, tree, backModes);
          if (!linkBack) return { ok: false, reason: 'link_check_failed', detail: 'the files its undo would bring back could not be listed to check them for symbolic links' };
          if (linkBack.length) return symlinkRefusal(linkBack, false);
          // NOTHING IS WRITTEN OR DELETED BELOW A REPOSITORY (repoOnPath: Git's own reading, on this tree and the target)
          const inRepo = await repoOnPath(runHere, scan, tree, sha, found.leaves, due);
          if (inRepo === false) return { ok: false, reason: 'uncaptured_check_failed', detail: 'the files the checkpoint tracks could not be listed to check for an embedded repository on what rewinding would write or remove' + (scan.refusal() ? ', because ' + scan.refusal() : '') };
          if (inRepo) return repoRefusal(inRepo);
          // NOR IS A GITLINK ADDED OR DROPPED OVER A FOLDER OF FILES (gitlinkOverFiles: the undo would read that folder
          // otherwise, take its files or walk it whole)
          const turned = await gitlinkOverFiles(runHere, scan, workTreeFor(aid, scope), tree, sha, found.leaves, due);
          if (turned === false) return { ok: false, reason: 'uncaptured_check_failed', detail: 'the files the checkpoint tracks could not be listed to check the embedded repositories rewinding would add or drop' + (scan.refusal() ? ', because ' + scan.refusal() : '') };
          if (turned) return gitlinkRefusal(turned);
          // NOR IS ONE RECORDED WHERE A FILE STANDS, at its path or above it (gitlinkOverFile: its undo would have to delete
          // that folder again, and its own check refuses that)
          const overFile = await gitlinkOverFile(runHere, sha, found.fileLeaves, found.fileDirs);
          if (overFile === false) return { ok: false, reason: 'uncaptured_check_failed', detail: 'the files of the restore point could not be listed to check the embedded repositories rewinding would record where a file stands' };
          if (overFile) return gitlinkFileRefusal(overFile);
          // THE RULES THE REWIND CHANGES, read the same way its undo reads them (its targetIgnoreRules: the .gitignore files
          // of this very tree that differ from the target's), each in any case where the file system folds case: refused
          // unless they keep what they ignore in place both ways (unfollowedRules)
          const ignores = await runHere(['diff-tree', '-r', '-z', '--no-renames', '--name-only', tree, sha, '--', IGNORE_FILES]);
          const changed = ignores && ignores.code === 0 && !ignores.truncated ? nulNames(ignores) : null;
          const mine = changed ? await ignoreFiles(runHere, tree, changed) : false;
          const theirs = changed && mine !== false ? await ignoreFiles(runHere, sha, changed) : false;
          if (mine === false || theirs === false) return { ok: false, reason: 'link_check_failed', detail: 'the .gitignore files its undo would bring back could not be read, to check the folder by them' };
          const unfollowed = changed.length ? unfollowedRules(changed, mine, theirs, scan.ignoreNotes()) : '';
          if (unfollowed) {
            return { ok: false, reason: 'uncaptured_check_failed', detail: 'the rewind would change .gitignore rules beyond plain names: '
              + unfollowed + '. Its undo could not keep in place what those rules ignore, so nothing was changed. A rewind that changes no '
              + '.gitignore goes ahead, and so does one that changes only plain names in it (node_modules, dist/, /build) while no '
              + '.gitignore holds a negation or a NUL byte' };
          }
          // THE UNDO'S OWN LINK LISTING: what its index (the target) and its row (this tree) hold at or below each link,
          // pruned folder and embedded repository its walk will find (restoreLinkConflicts): this walk's, which pruned by
          // the rules of both sides, and the folders the reset makes that those rules prune. With this tree staged the
          // listing is of the same pair of trees, and a listing of more prefixes needs every folder entry list one of
          // fewer does (treeUnder), so a folder whose own entry list passes the runner's output limit refuses the rewind
          // here, untouched, instead of its undo
          const unwalked = scan.links.map(function (l) { return l.path; }).concat(scan.prunedDirs, scan.nestedDirs, Array.from(made.values()));
          const undoPaths = unwalked.length ? await listUnder(runHere, unwalked, sha) : [];
          if (!undoPaths) return { ok: false, reason: 'link_check_failed', detail: 'the files its undo would bring back could not be listed to check them for links' };
          // THE UNDO'S OWN COUNT of the tree the reset leaves, its walk's and its checks' (scanTree's afterReset): exact, so
          // the count an undo takes for its own undo is the one its rewind took, never past the budget (undo review 2: an
          // estimate that kept every folder the reset empties refused the undo of a completed rewind)
          const undoCount = await scan.afterReset(found.leaves, due, found.madeDirs, Array.from(made.values()), undoPaths);
          if (undoCount == null) return { ok: false, reason: 'link_check_failed', detail: 'the folder could not be checked for links, because ' + scan.refusal() };
          if (undoCount > scanLimits.maxEntries) {
            return { ok: false, reason: 'link_check_failed', detail: 'its undo would have to check more than ' + scanLimits.maxEntries + ' files and folders (' + undoCount + ')' };
          }
          // THE DEPTH its undo will meet: the deepest folder each write needs (its parent; for a gitlink its own, the empty
          // folder Git makes there), as the undo counts it. From the root where its walk goes; from the folder its link
          // check lists in full where it does not (scan.linksBelow, that folder level 0): a folder it prunes at or below a
          // FILE the reset turns into a folder, or that FILE's folder when it lies inside one it prunes (restoreLinkConflicts'
          // replaced folders; undo review 4: a rewind that made a pruned gen/ over the file gen, its folders six deep, and a
          // gitlink made one level past the depth, completed, and their undo was refused). Below any other folder the undo
          // does not enter, it lists only the paths of the two trees (listUnder), whatever their depth. A gitlink below
          // such a FILE was refused above (gitlinkOverFile), so only a write its walk enters, at the depth's edge, is
          // asked what it is (treeUnder's records)
          const unwalkedNow = scan.links.map(function (l) { return foldPath(l.path); }).concat(scan.prunedDirs.map(foldPath), scan.nestedDirs.map(foldPath), Array.from(made.keys()));
          const fileDirs = found.fileDirs.map(function (d) { return foldPath(d.dir); });
          const unwalkedAt = function (f) { return unwalkedNow.find(function (x) { return atOrBelow(f, x); }); };
          const tooDeep = function (p) {
            const f = foldPath(p), depth = f.split('/').length - 1;
            const u = unwalkedAt(f);
            if (u == null) return depth > scanLimits.maxDepth;
            const d = fileDirs.find(function (x) { return f.indexOf(x + '/') === 0; });
            if (d == null) return false;
            const top = d.length > u.length ? d : u;      // both on p's chain: the FILE's folder inside u, else u
            return depth - top.split('/').length > scanLimits.maxDepth;
          };
          const edge = found.leaves.filter(function (p) { return p.split('/').length === scanLimits.maxDepth + 1 && unwalkedAt(foldPath(p)) == null; });
          const edgeRecs = edge.length ? await treeUnder(runHere, sha, edge, true) : [];
          if (!edgeRecs) return { ok: false, reason: 'link_check_failed', detail: 'the files of the restore point could not be listed to check how deep its undo would walk' };
          const deep = found.leaves.find(tooDeep) || edgeRecs.find(function (rec) { return rec.slice(0, 7) === '160000 ' && rec.slice(rec.indexOf('\t') + 1).split('/').length === scanLimits.maxDepth + 1; });
          if (deep) return { ok: false, reason: 'link_check_failed', detail: 'its undo would have to check folders nested deeper than ' + scanLimits.maxDepth + ' levels' };
          // what the reset writes over (found.leaves holds only what the index lacks), asked where the file system folds case: scanTree's SPELLED and
          // IN USE, split on both trees as its undo splits it on the target's (namesBothWays); the target's gitlinks where the rewind writes into a
          // folder that holds nothing, and the staged tree's where it empties one (its undo's)
          const rewrites = foldCase ? await namesBothWays(runHere, ['diff-tree', '-r', '-z', '--ignore-submodules=none', '--no-renames', '--name-only', '--diff-filter=M'], tree, sha) : [];
          if (!rewrites) return { ok: false, reason: 'uncaptured_check_failed', detail: 'Git could not list what rewinding would write over, to check how the folder spells it' };
          return foldedTwoRefusal(scan, found.leaves, due, rewrites, function (rel) { return recordsGitlinkUnder(runHere, sha, rel, aheadModes); },
            function (rel) { return recordsGitlinkUnder(runHere, tree, rel, backModes); });
        } }, preWhy);
      if (preWhy.refusal) return preWhy.refusal;
      let preRecorded = false;
      try { preRecorded = !!(pre && pre.created && cp.findById(await loadIndexResilient(aid), pre.id)); }
      catch (e) { failNote('checkpoint.restore.preRestoreIndex', e); }
      // nothing touched: no undo point, no rewind. detail (additive) says which step failed, path-free.
      if (!preRecorded) return { ok: false, reason: 'pre_restore_failed', detail: preWhy.reason || (pre ? 'the undo point could not be added to the restore list' : 'the undo point could not be saved') };
      try {
        const reset = await git(aid, scope, ['reset', '--hard', '-q', sha]);
        if (reset.code !== 0) return { ok: false, reason: 'git_failed', preRestoreId: pre.id };
        // no `clean`: all it could still delete is a file no capture took (WHAT A REWIND REMOVES, above)
        // A REMOVAL RESET COULD NOT DO: a file it was to delete and only warned about is an incomplete rewind, never ok
        const left = due ? await leftByReset(aid, scope, due) : null;
        if (!left) {
          return { ok: false, reason: 'git_failed', preRestoreId: pre.id,
            detail: 'the rewind ran, but Git could not check that the files it was to remove are gone' };
        }
        if (left.count) {
          return { ok: false, reason: 'git_failed', preRestoreId: pre.id, left: left.paths,
            detail: '"' + left.paths[0] + '"' + (left.count > 1 ? ' and ' + (left.count - 1) + ' more file' + (left.count > 2 ? 's' : '') : '')
              + ', which the restore point lacks, could not be removed: is it open in another program?' };
        }
        return Object.assign({ ok: true, preRestoreId: pre.id }, linkFields(scan.links));   // + the links left where they were
      } catch (e) { failNote('checkpoint.restore.git', e); return { ok: false, reason: 'git_failed', preRestoreId: pre.id }; }
    }
    async function restore(agentId, snapshotId) { return (await restoreDetailed(agentId, snapshotId)).ok === true; }

    function withAvailability(aid, index) {
      return cp.toIndex((index && index.snapshots || []).map(function (s) {
        return Object.assign({}, s, { restoreAvailable: !s.scopeId || !!readScope(aid, String(s.scopeId)) });
      }));
    }
    function list(agentId) {
      if (!AID_RE.test(String(agentId || ''))) return cp.toIndex([]);
      const aid = String(agentId);
      return withAvailability(aid, loadIndex(aid));
    }
    // async list that rebuilds from the shadow git commits when the index.json is empty/corrupt but the repo
    // has history — so the "rewind" UI repopulates after an index loss. The route awaits this.
    async function listResilient(agentId) {
      if (!AID_RE.test(String(agentId || ''))) return cp.toIndex([]);
      const aid = String(agentId);
      return withAvailability(aid, await loadIndexResilient(aid));
    }

    /* forgetAttachments(agentId, relPaths) - a deleted chat's attachment files were removed from the workspace; a shadow commit made BEFORE the
       exclude rule may still hold their bytes. When the agent's workspace history holds any of the paths, the repo is replaced by one baseline of
       the current tree (reinitFromCurrentTree: built first, swapped second, the same path the size ceiling takes), so its older rollback points
       are lost - the forget receipt says so. -> { held, reinit }. Idempotent: a repo that holds none is left alone. */
    async function forgetAttachments(agentId, relPaths) {
      if (!AID_RE.test(String(agentId || ''))) return { held: false, reinit: false };
      const aid = String(agentId), scope = { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      const paths = (Array.isArray(relPaths) ? relPaths : []).map(function (p) { return String(p || '').replace(/\\/g, '/'); })
        .filter(function (p) { return p.indexOf('.attachments/') === 0 && p.indexOf('..') < 0 && p.indexOf('\0') < 0; });
      if (!paths.length || !repoExists(aid, scope)) return { held: false, reinit: false };
      // one search per batch: about 600 uploads on one command line pass Windows' limit (spawn ENAMETOOLONG), and a pass that fails here fails again at every retry, so the ledger never settles
      let held = false;
      for (let i = 0; i < paths.length && !held;) {
        const batch = [];
        for (let len = 0; i < paths.length && (!batch.length || len < 6000); i++) { batch.push(paths[i]); len += paths[i].length + 1; }
        const log = await git(aid, scope, ['log', '--all', '-1', '--format=%H', '--'].concat(batch));
        if (!log || log.code !== 0) throw new Error('checkpoint: the shadow history of ' + aid + ' could not be searched');
        held = !!String(log.stdout || '').trim();
      }
      if (!held) return { held: false, reinit: false };
      const reinit = await reinitFromCurrentTree(aid, scope, {}, 'baseline (repo re-init: a deleted session\'s attachment)');
      if (!reinit) throw new Error('checkpoint: the shadow history of ' + aid + ' holds a deleted session\'s attachment and could not be replaced');
      return { held: true, reinit: true };
    }

    return { snapshot: serialized(snapshot), restore: serialized(restore), restoreDetailed: serialized(restoreDetailed), list: list, listResilient: serialized(listResilient), rebuild: serialized(rebuildIndexFromGit), enforceSizeCeiling: serialized(enforceSizeCeiling), forgetAttachments: serialized(forgetAttachments), health: health, isValidId: cp.isValidId };
  }

  return { makeCheckpointStore: makeCheckpointStore };
});
