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
   A stale Git lock a killed checkpoint command left is cleared at the start of the next operation (clearStaleGitLocks). */
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
        // a POSIX path's leading '/' is an empty first part: match it too, or '/<checkpoint repo>' is left behind
        return parts.length ? text.replace(new RegExp('[\\\\/]*' + parts.join('[\\\\/]+'), 'gi'), label) : text;
      };
      line = hide(hide(hide(line, gitDirFor(aid, scope), '<checkpoint repo>'), workTreeFor(aid, scope), '<workspace>'), root, '<station>')
        .replace(/^(fatal|error):\s*/i, '');
      const head = 'Git ' + step + ' failed' + (r && typeof r.code === 'number' ? ' (exit ' + r.code + ')' : '');
      return (line ? head + ': ' + line : head).slice(0, 240);
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
        if ((await gitAt(fresh, ['add', '-A'], maintenanceTimeoutMs)).code !== 0) { cleanup(); return false; }
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
          saveIndex(aid, cp.record(cp.toIndex(others), {
            id: fullId, runId: meta && meta.runId || '', turn: meta && meta.turn || 0, parentId: null, label: 'baseline (re-init)', files: size.files, bytes: size.bytes,
            scopeId: (scope && scope.id) || '', workTree: scope && scope.id ? scope.workTree : '', gitCommit: sha
          }, { now: clock.now(), keep: keep }));
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
        const add = await git(aid, scope, ['add', '-A']);
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
            const dedup = { id: fullId, created: false, files: 0, bytes: 0, workTree: scope.id ? scope.workTree : '' };
            if (readIndexRaw(aid).status === 'unreadable' || cp.findById(await loadIndexResilient(aid), fullId)) return dedup;
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
          const prior = await loadIndexResilient(aid);
          const priorInScope = prior.snapshots.slice().reverse().find(function (s) {
            return String((s && s.scopeId) || '') === scope.id;
          });
          const index = cp.record(prior,
            { id: fullId, runId: meta.runId, turn: meta.turn, parentId: priorInScope ? priorInScope.id : null,
              label: label, files: size.files, bytes: size.bytes, scopeId: scope.id,
              workTree: scope.id ? scope.workTree : '', gitCommit: sha },
            { now: clock.now(), keep: keep });
          saveIndex(aid, index);
        } catch (e) { failNote('checkpoint.index.persist', e); }
        return { id: fullId, created: true, files: size.files, bytes: size.bytes, workTree: scope.id ? scope.workTree : '' };
      } catch (e) {                                                               // fail-open
        why.reason = 'the restore point could not be saved (' + String((e && e.code) || 'unexpected error').slice(0, 40) + ')';
        return null;
      }
    }

    /* restore — hard-reset the agent's work-tree to a snapshot (and remove files created since). Only restores a
       snapshotId that is RECORDED in this agent's index — never an arbitrary ref. Returns false on any failure.

       UNDO THE UNDO. `reset --hard` + `clean -fd` used to run with no snapshot of the CURRENT state: the
       Commander's own hand edits since the last agent snapshot, and any new untracked file, were destroyed and
       existed nowhere in the shadow history (audit probe 09-22: an edited v3 and a new draft-by-commander.txt,
       both gone). Before touching the tree, restore now commits the current work tree — tracked changes AND
       untracked non-ignored files, through the SAME `add -A` path every snapshot uses, so the same ignore rules
       apply — as its own labelled 'pre-restore' row in this agent's index (always a new row, even when nothing
       changed, so the undo point is explicit). Restoring THAT id brings the edits and the untracked files back.
       If the pre-restore snapshot cannot be taken AND proven in the index, the restore REFUSES and the tree is
       untouched: a rewind must never destroy state it cannot give back. Files the ignore rules exclude are
       neither snapshotted nor removed (`clean -fd` without -x), exactly as before.
         restoreDetailed(agentId, id) -> { ok, reason?, preRestoreId? }   restore(agentId, id) -> bool */
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
      const preWhy = {};
      const pre = await commitSnapshot(aid, scope,
        { runId: '', turn: 0, label: 'pre-restore (before rewinding to ' + String(sha).slice(0, 12) + ')' },
        { always: true }, preWhy);
      let preRecorded = false;
      try { preRecorded = !!(pre && pre.created && cp.findById(await loadIndexResilient(aid), pre.id)); }
      catch (e) { failNote('checkpoint.restore.preRestoreIndex', e); }
      // nothing touched: no undo point, no rewind. detail (additive) says which step failed, path-free.
      if (!preRecorded) return { ok: false, reason: 'pre_restore_failed', detail: preWhy.reason || (pre ? 'the undo point could not be added to the restore list' : 'the undo point could not be saved') };
      try {
        const reset = await git(aid, scope, ['reset', '--hard', '-q', sha]);
        if (reset.code !== 0) return { ok: false, reason: 'git_failed', preRestoreId: pre.id };
        const clean = await git(aid, scope, ['clean', '-fd', '-q']);             // drop files added after the snapshot
        if (clean.code !== 0) return { ok: false, reason: 'git_failed', preRestoreId: pre.id };
        return { ok: true, preRestoreId: pre.id };
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
