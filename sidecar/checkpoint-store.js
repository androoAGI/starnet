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
   are forced off so an agent's files are stored and restored BYTE-EXACT (no line-ending mangling = no silent
   corruption). All git failures FAIL-OPEN (a snapshot/restore problem must never crash a run); the host decides
   whether a missing checkpoint should block a dangerous tool.

   makeCheckpointStore({ fs, pathMod, root, runGit, clock, keep?, scopeIdOf?, allowWorkTree?, maxRepoBytes?, maintenanceTimeoutMs? })
     -> { snapshot, restore, restoreDetailed, list, health, isValidId }
     runGit(args:string[], { cwd, timeoutMs? }) -> Promise<{ code:int|string, stdout, stderr }>   // resolves, never rejects
     snapshot(agentId, { runId, turn, label, workTree? }) -> Promise<{ id, created:bool, files, bytes } | null>   // null = NO restore point
     restore(agentId, snapshotId)              -> Promise<bool>   // only restores an id IN this agent's index
     restoreDetailed(agentId, snapshotId)      -> Promise<{ ok, reason?, detail?, preRestoreId? }>   // + the pre-restore undo id
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
   the link named). A rewind runs no `clean` (restoreDetailed states exactly what a rewind removes): every link, every
   folder the walk did not enter and every file no capture took stays where it is, whatever the target's .gitignore says.
   A `.git` link, or a link inside a plain `.git` folder, in a folder the target lacks stays too, never entered: reset
   deletes only the captured files there, so the folder stays, holding its `.git`. Where the target DOES hold the path of
   something no capture took (an ignored file, a clone, a `.git`), the rewind is refused too ('uncaptured_in_path', round 6),
   and a reset that left a file it was to delete (held open elsewhere) is an incomplete rewind, never ok.
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
  const SCAN_MAX_ENTRIES_DEFAULT = 250000;            // link walk: files + folders listed before a capture is skipped
  const SCAN_MAX_DEPTH_DEFAULT = 100;                 // link walk: folder nesting
  const SCAN_DEADLINE_MS_DEFAULT = 10 * 1000;         // link walk: wall time (the injected clock)
  const SCAN_CONCURRENCY = 8;                         // folders listed at once
  const LINKS_RECORDED_MAX = 32;                      // links named on a result / index row (linksTotal counts all)
  // a .gitignore line the walk may prune by: one plain name, optionally `/`-anchored or `**/`-prefixed, optionally `/`-ended
  const PLAIN_IGNORE_RE = /^(\*\*\/)?(\/)?([A-Za-z0-9._-]+)\/?$/;
  const EXCLUDE_HEADER = '# StarNet checkpoints: links (junctions, symbolic links, mount points) left out of restore points.\n'
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

    // the leading git args that pin the shadow git-dir + work-tree and force byte-exact, identity-stable commits.
    function base(aid, scope) {
      return ['--git-dir', gitDirFor(aid, scope), '--work-tree', workTreeFor(aid, scope),
        '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'gc.autoDetach=false',
        '-c', 'user.email=starnet@local', '-c', 'user.name=starnet'];
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
    const foldPath = (p) => (foldCase ? String(p).toLowerCase() : String(p));
    const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    const ancestorsOf = function (rel) {                // 'a/b/c' -> ['a', 'a/b']
      const out = [], s = String(rel);
      for (let i = s.indexOf('/'); i >= 0; i = s.indexOf('/', i + 1)) out.push(s.slice(0, i));
      return out;
    };
    const atOrBelow = function (rel, dirFolded) { const f = foldPath(rel); return f === dirFolded || f.indexOf(dirFolded + '/') === 0; };
    /* classifyEntry — what one listed entry is, decided from the LISTING, never by following it. On Windows a listing marks
       EVERY reparse point as a link (libuv's scandir reads FILE_ATTRIBUTE_REPARSE_POINT): that is the check that sees a
       volume mount point, which lstat (and so Node 22's isSymbolicLink() on a stat) reads as a plain folder. lstat then
       names it: a link (junction, directory or file symlink), a folder (a mount point, or another folder reparse point:
       left out too), or a plain FILE (a cloud placeholder or a deduplicated file: virtualized content with no other path
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
        catch (e) { return e && e.code === 'ENOENT' ? { kind: 'gone' } : { kind: 'link', linkKind: 'unreadable' }; }
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
       than Git does, never less. Names match case-sensitively, a subset of what Git (core.ignorecase on Windows) ignores.
       NEGATIONS: a `!` line can re-include a folder an ignore rule excluded, so every one is kept (negationMatcher) and a
       folder any of them could match is never pruned. Only the folder itself counts: Git cannot re-include a path below
       an excluded folder, so `!.vscode/settings.json` never stops `node_modules` from being pruned.
       Pruning only saves time: a path the shadow index tracks below a pruned folder is still checked link by link
       (prepareCapture, restoreLinkConflicts). */
    function parsePlainIgnores(text, base) {
      const list = [], negs = [];
      const src = String(text), body = src.charCodeAt(0) === 0xFEFF ? src.slice(1) : src;   // Git skips a UTF-8 BOM too
      for (const raw of body.split('\n')) {
        const line = raw.replace(/\r$/, '').replace(/ +$/, '');
        if (!line || line[0] === '#') continue;
        if (line[0] === '!') { negs.push(negationMatcher(line.slice(1), base)); continue; }
        const m = PLAIN_IGNORE_RE.exec(line);
        if (!m || (m[1] && m[2]) || m[3] === '.' || m[3] === '..') continue;
        list.push({ base: base, name: m[3], anchored: !!m[2] });
      }
      return { list: list, negs: negs };
    }
    /* negationMatcher — could this negation match the FOLDER (rel: its path from the work-tree root; name: its own name)?
       Over-answers yes, never no, when unsure: a bracket, an escape or a `**` matches everything. `*` and `?` match within
       one path segment, case-insensitively (Git's core.ignorecase can make `!Build` re-include `build`). A pattern with a
       `/` (or a leading `/`) is matched against the folder's path from the .gitignore's own folder; one without, against
       its name, at any depth. */
    function negationMatcher(pattern, base) {
      let p = String(pattern);
      const anchored = p[0] === '/';
      if (anchored) p = p.slice(1);
      p = p.replace(/\/+$/, '');
      if (!p || /[[\\]/.test(p) || p.indexOf('**') >= 0) return function () { return true; };
      const re = new RegExp('^' + p.split('').map(function (ch) {
        return ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|\]]/g, '\\$&');
      }).join('') + '$', 'i');
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
       gitlink and never reads inside it), and refuses (the capture is skipped, health says why) past scanLimits: entry
       count, folder depth, wall time. Its lists come back sorted, so an unchanged tree records the same links every time.
         -> { ok:true, links:[{ path, kind }], gitLinks:[rel], gitFolders:[rel], gitFiles:[rel], prunedDirs:[rel], nestedDirs:[rel],
              walkPath(p), linkOnPath(p), entryAt(p), gitHolders(p), linksBelow(rel), refusal() } | { ok:false, reason }
       gitLinks: the `.git` entries in the folders it listed (not inside an embedded repository) that are links themselves;
       gitFolders: the same for a `.git` that is a real folder, below the root (never listed by the walk: linksBelow);
       gitFiles: the same for a `.git` that is a plain file in a folder the walk entered (one looksLikeRepo does not take
       for a repository: a worktree's gitfile, one Git does not read as a gitfile, or one naming no repository).
       entryAt(p) is what stands at p, through the same listings: { kind, rel } ('file', 'dir', 'link' or 'git'; rel the
       on-disk spelling, case-folded where the file system folds case), or null when nothing does or a folder above it is
       not a plain folder. gitHolders(p) is the folders on p's chain (below the root, p itself when it is a folder) whose
       listing holds a `.git` of any kind, through the same listings.
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
       so there is nothing to leave out of its view. */
    async function scanTree(workTree, opts) {
      const nestedOf = opts && typeof opts.nested === 'function' ? opts.nested : null;
      const started = scanClock.now();
      const listings = new Map();                         // folder rel ('' = the root) -> { byName, byFold, hasGit }
      const links = [], linkSeen = new Set(), prunedDirs = [], nestedDirs = [], nestedSet = new Set();
      const gitLinks = [], gitLinkSeen = new Set();       // `.git` entries that are links: never content, never left out
      const gitFolders = [], gitFolderSeen = new Set();   // `.git` entries that are real folders, below the root
      const gitFiles = [], gitFileSeen = new Set();       // `.git` entries that are plain files, below the root
      let entries = 0, gitEntries = 0, refusal = '';      // gitEntries: listed inside a `.git` folder (linksBelow only)
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
          if (kinds[i].kind === 'git') hasGit = true;
          const v = { name: String(ents[i].name), kind: kinds[i].kind, linkKind: kinds[i].linkKind || '', gitFolder: !!kinds[i].gitFolder };
          byName.set(v.name, v);
          const fold = v.name.toLowerCase(), prev = byFold.get(fold);
          if (!prev || v.kind === 'link') byFold.set(fold, v);
        }
        const listing = { byName: byName, byFold: byFold, hasGit: hasGit };
        listings.set(rel, listing);
        if (!deferred && !inNested(rel) && !inGitFolder(rel)) record(rel, listing);
        return listing;
      }
      async function rulesIn(dir, listing) {
        const gi = listing.byName.get('.gitignore');
        if (!gi || gi.kind !== 'file') return dir.rules;   // a .gitignore that is a link: Git skips it too
        let text;
        try { text = await readText(pathMod.join(absOf(dir.rel), '.gitignore')); }
        catch (e) { failNote('checkpoint.links.gitignore', e); return { list: [], negs: [function () { return true; }] }; }   // unread: prune nothing below
        const own = parsePlainIgnores(text, dir.rel);
        if (!own.list.length && !own.negs.length) return dir.rules;
        return { list: dir.rules.list.concat(own.list), negs: dir.rules.negs.concat(own.negs) };
      }
      let level = [{ rel: '', depth: 0, rules: { list: [], negs: [] } }];
      while (level.length && !refusal) {
        const listed = [];
        for (let i = 0; i < level.length && !refusal; i += SCAN_CONCURRENCY) {
          await Promise.all(level.slice(i, i + SCAN_CONCURRENCY).map(async function (dir) {
            const listing = await listOne(dir.rel, true);
            if (listing) listed.push({ dir: dir, listing: listing, rules: await rulesIn(dir, listing) });
          }));
          overTime();
        }
        if (refusal) break;
        // EMBEDDED REPOSITORIES: the folders of this level that hold a `.git`, asked about in one go
        const asked = listed.filter(function (x) { return x.dir.rel && x.listing.hasGit; }).map(function (x) { return x.dir.rel; });
        const nested = new Set(asked.length && nestedOf ? ((await nestedOf(asked)) || []).map(foldPath) : []);
        if (overTime()) break;
        const next = [];
        for (const x of listed) {
          const dir = x.dir;
          if (nested.has(foldPath(dir.rel))) { nestedDirs.push(dir.rel); nestedSet.add(foldPath(dir.rel)); continue; }
          record(dir.rel, x.listing);
          for (const v of x.listing.byName.values()) {
            if (v.kind !== 'dir') continue;
            const childRel = dir.rel ? dir.rel + '/' + v.name : v.name;
            const rule = x.rules.list.find(function (r) { return r.name === v.name && (!r.anchored || r.base === dir.rel); });
            if (rule && !x.rules.negs.some(function (n) { return n(childRel, v.name); })) { prunedDirs.push(childRel); continue; }
            if (dir.depth + 1 > scanLimits.maxDepth) { refuse('its folders nest deeper than ' + scanLimits.maxDepth + ' levels'); break; }
            next.push({ rel: childRel, depth: dir.depth + 1, rules: x.rules });
          }
          if (refusal) break;
        }
        level = next;
      }
      if (refusal) return { ok: false, reason: refusal };
      links.sort(function (a, b) { return byText(a.path, b.path); });
      prunedDirs.sort(byText);
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
          const v = listing.byName.get(parts[i]) || listing.byFold.get(parts[i].toLowerCase());
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
          const v = listing.byName.get(parts[i]) || (foldCase ? listing.byFold.get(parts[i].toLowerCase()) : null);
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
          const v = listing.byName.get(parts[i]) || (foldCase ? listing.byFold.get(parts[i].toLowerCase()) : null);
          if (!v || v.kind !== 'dir') return out;
          rel = rel ? rel + '/' + v.name : v.name;
        }
        return out;
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
      return { ok: true, links: links, gitLinks: gitLinks, gitFolders: gitFolders, gitFiles: gitFiles, prunedDirs: prunedDirs,
        nestedDirs: nestedDirs, walkPath: walkPath, linkOnPath: linkOnPath, entryAt: entryAt, gitHolders: gitHolders, linksBelow: linksBelow, refusal: function () { return refusal; } };
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
    // a literal pathspec for a work-tree path; case-folded where the file system folds case
    const literalSpec = (rel, extra) => ':(' + (extra ? extra + ',' : '') + 'literal' + (foldCase ? ',icase' : '') + ')' + rel;
    /* listUnder — the paths `git <args>` (ls-files -z, optionally --with-tree=<sha>) lists at or below any of `prefixes`:
       literal pathspecs on the command line (case-folded where the file system folds case), or, past a command-line
       length, the whole listing filtered here by the same rule. -> string[] | null (Git failed or its output overflowed) */
    async function listUnder(runIn, args, prefixes) {
      const specs = prefixes.map(function (p) { return literalSpec(p); });
      const whole = specs.join(' ').length >= 6000;
      const r = await runIn(whole ? args : args.concat(['--'], specs));
      if (!r || r.code !== 0 || r.truncated) return null;
      const paths = String(r.stdout || '').split('\0').filter(Boolean);
      if (!whole) return paths;
      const fold = function (s) { return foldCase ? s.toLowerCase() : s; };
      const wanted = new Set(prefixes.map(fold));
      return paths.filter(function (p) {
        const f = fold(p);
        for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) if (wanted.has(f.slice(0, i))) return true;
        return wanted.has(f);
      });
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
       down to one path, which never overflows. Review 6.2 (round 6's two listings refused the rewind after a big deletion,
       and reported a completed rewind as failed). -> string[] | null (Git failed) */
    async function namesIn(runIn, args, tree) {
      const names = function (r) { return String(r.stdout || '').split('\0').filter(Boolean); };
      const whole = await runIn(args);
      if (whole && whole.code === 0 && !whole.truncated) return names(whole);
      if (!whole || !whole.truncated) return null;
      const out = [];
      const entries = async function (dir) {              // one folder's entries in `tree`, as full paths
        const r = await runIn(['ls-tree', '-z', '--name-only', dir ? tree + ':' + dir : tree]);
        return r && r.code === 0 && !r.truncated ? names(r).map(function (n) { return dir ? dir + '/' + n : n; }) : null;
      };
      const ask = async function (chunk) {                // -> false when Git failed
        const r = await runIn(args.concat(['--'], chunk.map(function (p) { return ':(literal)' + p; })));
        if (r && r.code === 0 && !r.truncated) { for (const n of names(r)) out.push(n); return true; }
        if (!r || !r.truncated) return false;
        if (chunk.length > 1) { const half = chunk.length >> 1; return (await ask(chunk.slice(0, half))) && ask(chunk.slice(half)); }
        return askAll(await entries(chunk[0]));           // one folder whose own listing overflows: per entry inside it
      };
      const askAll = async function (paths) {
        if (!paths || !paths.length) return false;
        for (let i = 0; i < paths.length;) {
          const chunk = [];
          for (let len = 0; i < paths.length && (!chunk.length || len < 6000); i++) { chunk.push(paths[i]); len += paths[i].length + 12; }
          if (!(await ask(chunk))) return false;
        }
        return true;
      };
      return (await askAll(await entries(''))) ? out : null;
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
       whose `.git` is a repository is recorded as one gitlink (looksLikeRepo). A Git failure names none: the walk enters
       them all, which costs budget, never a link. -> rel[] */
    async function nestedRepos(runIn, workTree, rels) {
      const want = new Map(rels.map(function (r) { return [foldPath(r), r]; }));
      const indexed = new Map();                          // folded rel -> 'gitlink' | 'tree'
      for (let i = 0; i < rels.length;) {
        const specs = [];
        for (let len = 0; i < rels.length && (!specs.length || len < 6000); i++) { specs.push(literalSpec(rels[i])); len += rels[i].length + 24; }
        const r = await runIn(['ls-files', '-z', '-s', '--'].concat(specs));
        if (!r || r.code !== 0 || r.truncated) return [];
        for (const rec of String(r.stdout || '').split('\0')) {
          const tab = rec.indexOf('\t');
          if (tab < 0) continue;
          const p = foldPath(rec.slice(tab + 1));
          if (want.has(p)) { if (rec.slice(0, 7) === '160000 ' && !indexed.has(p)) indexed.set(p, 'gitlink'); continue; }
          for (const a of ancestorsOf(p)) if (want.has(a)) indexed.set(a, 'tree');
        }
      }
      const out = [];
      for (const rel of rels) {
        const was = indexed.get(foldPath(rel));
        if (was === 'gitlink' || (!was && await looksLikeRepo(pathMod.join(workTree, rel, '.git')))) out.push(rel);
      }
      return out;
    }
    // the walk, with the shadow index at hand to name the embedded repositories
    const scanFor = (workTree, runIn) => scanTree(workTree, { nested: function (rels) { return nestedRepos(runIn, workTree, rels); } });
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
    // check-ignore takes -z only with --stdin (the runner gives Git no stdin) and no --literal-pathspecs; it matches each
    // name literally and prints it back one per line, C-quoted when it holds a quote, a backslash or a control character
    async function checkIgnored(runIn, names) {
      const ignored = new Set();
      for (let i = 0; i < names.length;) {
        const chunk = [];
        for (let len = 0; i < names.length && (!chunk.length || len + names[i].length < 6000); i++) { chunk.push(names[i]); len += names[i].length + 1; }
        const ci = await runIn(['-c', 'core.quotePath=false', 'check-ignore', '--'].concat(chunk));   // 0 some ignored, 1 none
        if (!ci || (ci.code !== 0 && ci.code !== 1)) return { ok: false, code: (ci && ci.code) != null ? ci.code : 'error' };
        for (const line of String(ci.stdout || '').split('\n')) if (line) ignored.add(line.replace(/\r$/, ''));
      }
      return { ok: true, ignored: ignored };
    }
    // a path as check-ignore is asked it (a leading `:` would read as pathspec magic: `./:…`)
    const ignoreAsked = (p) => (p[0] === ':' ? './' + p : p);
    // the shadow repo's info/exclude: one anchored pattern per link, rewritten before every capture and before restore asks
    // Git what it ignores (a link an earlier capture left out may be a plain folder now) -> null | why it could not be
    function writeLinkExcludes(gitDir, links) {
      if (links.some(function (l) { return /[\r\n]/.test(l.path); })) return 'a link\'s name holds a line break, so it cannot be left out';
      try {
        fs.mkdirSync(pathMod.join(gitDir, 'info'), { recursive: true });
        fs.writeFileSync(pathMod.join(gitDir, 'info', 'exclude'), EXCLUDE_HEADER + links.map(function (l) { return excludePattern(l.path) + '\n'; }).join(''));
        return null;
      } catch (e) { return 'the list of links to leave out could not be written (' + String((e && e.code) || 'error').slice(0, 24) + ')'; }
    }
    /* prepareCapture — THE one boundary every capture passes before Git reads the work tree (commitSnapshot for a snapshot
       and for restore's pre-restore capture; reinitFromCurrentTree for the size-ceiling baseline). With the walk's result:
       1. every path the shadow index tracks below a folder the walk pruned is checked link by link (a tracked file under a
          .gitignore'd folder is still refreshed by `add -A`, through whatever its folders now are);
       2. the links are written to <gitDir>/info/exclude (rewritten every time, so a link that went away is captured again)
          and every tracked path at or below one is dropped from the shadow index (`rm --cached -r`, literal pathspecs);
       3. `check-ignore` then says which links Git ignores now. info/exclude is the weakest ignore source: a .gitignore
          negation (`!src/`, an allowlist .gitignore) beats it and re-includes the link. Each link it did NOT keep out is
          left out by an exclude PATHSPEC on the `add` instead, which no ignore rule overrides; an ignored link is never
          named in one (`add` refuses a pathspec that names an ignored path). A link inside a folder the shadow index
          records as a GITLINK (an embedded repository whose `.git` went away, so the walk entered it) makes check-ignore,
          like `add`, die with 128: Git never reads inside a gitlink, so such links are dropped and the question asked again;
       4. returns the `add -A` the caller must run (`add(runIn)`) and the links left out of Git's view (`links`).
         -> { ok:true, links, add(runIn) } | { ok:false, reason } */
    async function prepareCapture(workTree, gitDir, runIn, scanIn) {
      const scan = scanIn || await scanFor(workTree, runIn);
      if (!scan.ok) return { ok: false, reason: 'restore point skipped: the folder could not be checked for links, because ' + scan.reason };
      const removals = new Set();
      if (scan.prunedDirs.length && fs.existsSync(pathMod.join(gitDir, 'index'))) {
        const tracked = await listUnder(runIn, ['ls-files', '-z'], scan.prunedDirs);
        if (!tracked) return { ok: false, reason: 'restore point skipped: the files it tracks below ignored folders could not be listed to check them for links' };
        for (const p of tracked) {
          const hit = await scan.linkOnPath(p);
          if (hit) removals.add(hit.spelled);
        }
        if (scan.refusal()) return { ok: false, reason: 'restore point skipped: the folder could not be checked for links, because ' + scan.refusal() };
      }
      let links = scan.links.slice().sort(function (a, b) { return byText(a.path, b.path); });
      for (const l of links) removals.add(l.path);
      const unwritten = writeLinkExcludes(gitDir, links);
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
      const unignored = links.filter(function (l) { return !ci.ignored.has(gitQuoted(ignoreAsked(l.path))); }).map(function (l) { return l.path; });
      const excludes = unignored.map(function (p) { return literalSpec(p, 'exclude'); });
      return {
        ok: true, links: links,
        add: function (runAdd) { return excludes.length ? gitWithPathspecs(runAdd, gitDir, ['add', '-A'], [':(top)'].concat(excludes)) : runAdd(['add', '-A']); }
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
    async function reinitFromCurrentTree(aid, scope, meta) {
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
        // add + commit re-hash the WHOLE current tree into the side repo: they get the maintenance bound, not 15 s.
        const gitAt = (dir, args, timeoutMs) => runGit(['--git-dir', dir, '--work-tree', workTreeFor(aid, scope),
          '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'gc.autoDetach=false',
          '-c', 'user.email=starnet@local', '-c', 'user.name=starnet'].concat(args),
          timeoutMs ? { cwd: workTreeFor(aid, scope), timeoutMs: timeoutMs } : { cwd: workTreeFor(aid, scope) });
        if ((await gitAt(fresh, ['init', '-q'])).code !== 0) { cleanup(); return false; }
        // the same LINK BOUNDARY as every snapshot (prepareCapture): the fresh baseline never reads through a link either
        const runFresh = function (args) { return gitAt(fresh, args, maintenanceTimeoutMs); };
        const capture = await prepareCapture(workTreeFor(aid, scope), fresh, runFresh);
        if (!capture.ok) { failNote('checkpoint.reinit.links', new Error(capture.reason)); cleanup(); return false; }
        if ((await capture.add(runFresh)).code !== 0) { cleanup(); return false; }
        const com = await gitAt(fresh, ['commit', '-q', '--allow-empty', '-m', 'baseline (repo re-init: size ceiling)'], maintenanceTimeoutMs);
        if (com.code !== 0) { cleanup(); return false; }
        const sha = (await gitAt(fresh, ['rev-parse', 'HEAD'])).stdout.trim();
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
    /* commitSnapshot — the one snapshot code path, on an already-resolved scope. opts.always: commit even when
       nothing changed (--allow-empty) so the index gets its OWN labelled row (restore's pre-restore undo point);
       Maintenance belongs to public snapshot(), so restore's internal pre-undo capture cannot drop its target.
       Fail-open: null on any git error, with why.reason (when a why object is passed) saying which step failed. */
    async function commitSnapshot(aid, scope, meta, opts, why) {
      meta = meta || {}; opts = opts || {}; why = why || {};
      const failed = function (step, r) { why.reason = gitFailure(step, r, aid, scope); return null; };
      try {
        fs.mkdirSync(workTreeFor(aid, scope), { recursive: true });
        fs.mkdirSync(gitDirFor(aid, scope), { recursive: true });
        // A Git command killed on an earlier operation (an add at its bound on a big first snapshot) left its lock.
        try { await clearStaleGitLocks(aid, gitDirFor(aid, scope)); } catch (e) { failNote('checkpoint.staleLock', e); }
        // init the shadow repo once (idempotent: re-running init on an existing repo is harmless).
        if (!fs.existsSync(pathMod.join(gitDirFor(aid, scope), 'HEAD'))) {
          const ini = await git(aid, scope, ['init', '-q']);
          if (ini.code !== 0) return failed('init', ini);
        }
        // THE LINK BOUNDARY: walk without following, leave every link out, drop what is tracked behind one (prepareCapture)
        const runHere = function (args) { return git(aid, scope, args); };
        const capture = await prepareCapture(workTreeFor(aid, scope), gitDirFor(aid, scope), runHere, opts.scan);
        if (!capture.ok) { why.reason = capture.reason; return null; }
        const add = await capture.add(runHere);
        if (add.code !== 0) return failed('add', add);
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
            if (headRow && sameLinks(headRow, capture.links)) return dedup;
            unrecordedHead = true;
          }
        }
        const label = meta.label != null ? String(meta.label) : 'snapshot';
        const commitArgs = ['commit', '-q', '-m', label];
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
       gone for good, undo or not (trunk d5024f5a did the same). So a file no capture took, at a path the target does not
       hold, stays where it is, whatever the target's .gitignore says, and so does every link, embedded repository, `.git`
       and empty folder there (where the target does hold it, such a file, repository or `.git` refuses the rewind: below,
       and an empty folder is deleted). Undoing such a rewind is
       itself a rewind, under the target's rules: when they do not ignore that file, the undo's own pre-restore capture
       takes it and its reset then deletes it (the undo target lacks it), so it is in that second undo row.
       NOTHING NO CAPTURE TOOK IS REPLACED OR DELETED (review round 6; trunk d5024f5a did both, with ok:true). Reset writes
       the target's paths whatever the index says of what stands there, so before even the pre-restore capture
       restoreUncapturedConflicts refuses a rewind that would overwrite or delete what no capture can take: a file Git
       ignores where the target holds a file (the person's newer, ignored .env) or a folder (an ignored `logs` file where
       the target holds logs/), a file inside an embedded repository (by a rule broader than Git's: any folder holding a
       `.git` of any kind, a linked worktree's gitfile or a `.git` link too, that the shadow index tracks no path below;
       review 6.2) or below a folder the shadow index records as a gitlink, and, in a folder the target holds as a FILE,
       any of those, an embedded repository or a `.git` (a clone's
       history and its uncommitted work) ('uncaptured_in_path', the path named; 'uncaptured_check_failed' when Git could
       not list what the check needs). Moving that path aside, then rewinding again, is the person's explicit choice.
       A REMOVAL RESET COULD NOT DO is an incomplete rewind: Git only warns when it cannot unlink a file (one another
       program holds open) and still exits 0, so after the reset leftByReset looks for each file it was to delete; one still
       there answers 'git_failed' with the undo row's id and the file named (detail), never ok.
       LINKS (lane checkpoint-links): before even the pre-restore capture, restoreLinkConflicts refuses a rewind that would
       write or delete through a link ('link_in_path', or 'link_check_failed' when the folder could not be checked).
         restoreDetailed(agentId, id) -> { ok, reason?, detail?, preRestoreId?, links?, paths? }   restore(agentId, id) -> bool */
    /* replacedFolders — which of the `asked` folders (folded rel -> the work tree's spelling) the target tree holds as a FILE
       (a blob or a symbolic link) at that very path (probe P8). `reset --hard` deletes such a folder before it writes the
       file, with every file below it and, on Git for Windows, everything behind a junction in it, a `.git` junction and
       one inside a real `.git` folder included (entry.c remove_subtree). exactEntries over `ls-files --with-tree`
       (case-folded where the file system folds case), then `ls-tree` says what the TARGET holds at each, as `--with-tree`
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
       walked through the walk's listings (`ls-files --with-tree` lists both, case-folded where the file system folds case).
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
      const paths = candidates.length ? await listUnder(runHere, ['ls-files', '-z', '--with-tree=' + sha], candidates) : [];
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
    /* restoreUncapturedConflicts — A REWIND NEVER REPLACES OR DELETES WHAT NO CAPTURE TOOK (restore's NOTHING NO CAPTURE
       TOOK). The pre-restore capture takes every tracked file and every untracked file Git does not ignore; what it cannot
       take is a file Git ignores, a file inside an embedded repository (Git records the folder as one gitlink) or below a
       folder the shadow index records as a gitlink, and a `.git`. An embedded repository is counted here more broadly than
       Git counts one, and so than the walk's looksLikeRepo: every folder holding a `.git` of any kind (a linked worktree's
       gitfile, a `.git` that is a link) that the shadow index tracks no path below (gitRepoAt, review 6.2). Reset only
       writes where the target differs from the work tree as the index sees it, so the paths asked are the target's own
       that the index lacks or the work tree holds as another type (`diff-index --diff-filter=DT <target>`, names only: as
       long as what the rewind changes, never the whole tree, and never one capped call: namesIn) and the folders above
       them, each looked up in the walk's own listings (scan.entryAt: never through a link, as restoreLinkConflicts proved
       none lies on these paths):
         a file at one of those paths or folders: refused when it is inside a repository (one the walk found, a gitlink the
           index records, or a folder holding a `.git` that the index tracks no path below, above it), or untracked and Git
           ignores it (check-ignore), a batch at a time;
         a folder where the target holds a FILE (reset deletes it with all it holds; a gitlink there is no file: Git leaves
           that folder alone): refused when it is, or is inside, a repository (the same three), holds one or a gitlink the
           index records, a `.git` folder or file, or anything Git ignores (ls-files -o -i, that folder's pathspec alone: no
           link lies below it, and an entry printed above it means the folder itself is ignored).
       Git's ignore rules are asked with the shadow repo's info/exclude rewritten for the links found now (writeLinkExcludes,
       as the capture right after does): a link an earlier capture left out may be a plain folder now, captured next.
         -> null | { ok:false, reason:'uncaptured_in_path' | 'uncaptured_check_failed', detail, paths? } */
    async function restoreUncapturedConflicts(aid, scope, sha, scan) {
      const failed = function (detail) { return { ok: false, reason: 'uncaptured_check_failed', detail: detail }; };
      const runHere = function (args) { return git(aid, scope, args); };
      const leaves = await namesIn(runHere, ['diff-index', '-z', '--no-renames', '--name-only', '--diff-filter=DT', sha], sha);
      if (!leaves) return failed('Git could not list what rewinding would write, to check what stands there');
      const above = new Map();                            // folded -> spelled: the target's folders above those paths
      for (const p of leaves) for (const a of ancestorsOf(p)) if (!above.has(foldPath(a))) above.set(foldPath(a), a);
      const files = [], dirs = [];                        // a file there now (at a path, or a folder) / a folder at a path
      for (const a of above.values()) { const at = await scan.entryAt(a); if (at && at.kind === 'file') files.push({ path: at.rel, folder: true }); }
      for (const p of leaves) {
        const at = await scan.entryAt(p);
        if (at && at.kind === 'file') files.push({ path: at.rel, leaf: p });
        else if (at && at.kind === 'dir') dirs.push({ path: at.rel, leaf: p });   // a link here: restoreLinkConflicts refused it
      }
      if (scan.refusal()) return failed('the folder could not be checked, because ' + scan.refusal());
      if (!files.length && !dirs.length) return null;
      const nested = new Map(scan.nestedDirs.map(function (n) { return [foldPath(n), n]; }));
      const hits = [];
      const hit = function (h) { if (hits.length < 8) hits.push(h); };
      let excluded = false;
      const excludeLinks = function () { if (excluded) return null; excluded = true; return writeLinkExcludes(gitDirFor(aid, scope), scan.links); };
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
        const ci = await checkIgnored(runHere, ask.map(function (f) { return ignoreAsked(f.path); }));
        if (!ci.ok) return failed('Git could not say which files it ignores (' + String(ci.code) + ')');
        for (const f of ask) if (ci.ignored.has(gitQuoted(ignoreAsked(f.path)))) hit(Object.assign({ ignored: true }, f));
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
        const recs = await runHere(['ls-files', '-z', '-s', '--'].concat(chunk.map(function (d) { return literalSpec(d); })));
        const linked = recs && recs.code === 0 && !recs.truncated ? await gitlinksAbove(runHere, chunk.map(function (d) { return { path: d }; })) : null;
        if (!linked) return failed('the files the checkpoint tracks could not be listed to check what rewinding would delete');
        const below = String(recs.stdout || '').split('\0').filter(function (rec) { return rec.slice(0, 7) === '160000 '; })
          .map(function (rec) { return rec.slice(rec.indexOf('\t') + 1); });
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
        const unwritten = excludeLinks();
        if (unwritten) return failed(unwritten);
        const r = await runHere(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory', '--'].concat(chunk.map(function (d) { return literalSpec(d); })));
        if (!r || r.code !== 0 || r.truncated) return failed('Git could not list what it ignores in a folder rewinding would replace');
        for (const raw of String(r.stdout || '').split('\0')) {
          const e = raw.replace(/\/$/, '');
          if (!e) continue;
          const d = chunk.find(function (x) { return atOrBelow(e, foldPath(x)); });
          const top = d ? '' : chunk.find(function (x) { return atOrBelow(x, foldPath(e)); });
          if (d) hit({ path: e, replaced: d, ignored: true });
          else if (top) hit({ path: top, replaced: top, ignored: true });
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
      const out = new Map(), named = Array.from(new Set(paths));
      for (let i = 0; i < named.length;) {
        const specs = [];
        for (let len = 0; i < named.length && (!specs.length || len < 6000); i++) { specs.push(':(literal)' + named[i]); len += named[i].length + 12; }
        const r = await runIn(['ls-tree', '-z', sha, '--'].concat(specs));
        if (!r || r.code !== 0 || r.truncated) return null;
        for (const rec of String(r.stdout || '').split('\0')) {
          const tab = rec.indexOf('\t');
          if (tab > 0) out.set(foldPath(rec.slice(tab + 1)), rec.slice(0, tab).split(' ')[1]);
        }
      }
      return out;
    }
    /* leftByReset — the files `reset --hard` was to delete and did not. Git only warns when it cannot unlink one (another
       program holds it open without delete sharing: a dev server's log, an open database, a running .exe) and still exits
       0. Each path the pre-restore capture took that the target lacks (diff-tree D, names only, never one capped call:
       namesIn, so a rewind past a big install is never reported failed after its reset ran) must be gone: lstat only,
       never through a link (the capture left every link out of Git's view). A folder there now is no file left behind
       (the target holds that folder, or it was a gitlink, whose folder Git never deletes), and neither is a file the index,
       which is the target's now, holds at that path case-folded (a case-only rename) or at a folder above it.
         -> { count, paths: [first 4] } | null (Git could not list them) */
    async function leftByReset(aid, scope, preSha, sha) {
      const due = await namesIn(function (args) { return git(aid, scope, args); },
        ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--diff-filter=D', preSha, sha], preSha);
      if (!due) return null;
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
      // the pre-restore capture's boundary. Refused here, nothing has been touched and no undo row was written.
      const scan = await scanFor(workTreeFor(aid, scope), function (args) { return git(aid, scope, args); });
      if (!scan.ok) return { ok: false, reason: 'link_check_failed', detail: 'the folder could not be checked for links, because ' + scan.reason };
      const conflict = await restoreLinkConflicts(aid, scope, sha, scan);
      if (conflict) return conflict;
      // NOTHING NO CAPTURE TOOK: refused here too, before anything is touched
      const uncaptured = await restoreUncapturedConflicts(aid, scope, sha, scan);
      if (uncaptured) return uncaptured;
      const preWhy = {};
      const pre = await commitSnapshot(aid, scope,
        { runId: '', turn: 0, label: 'pre-restore (before rewinding to ' + String(sha).slice(0, 12) + ')' },
        { always: true, scan: scan }, preWhy);
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
        const preSha = String(pre.id).slice(String(scope.prefix || '').length);
        const left = cp.isValidId(preSha) ? await leftByReset(aid, scope, preSha, sha) : null;
        if (!left) {
          return { ok: false, reason: 'git_failed', preRestoreId: pre.id,
            detail: 'the rewind ran, but Git could not list the files it was to remove, to check that they are gone' };
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

    return { snapshot: serialized(snapshot), restore: serialized(restore), restoreDetailed: serialized(restoreDetailed), list: list, listResilient: serialized(listResilient), rebuild: serialized(rebuildIndexFromGit), enforceSizeCeiling: serialized(enforceSizeCeiling), health: health, isValidId: cp.isValidId };
  }

  return { makeCheckpointStore: makeCheckpointStore };
});
