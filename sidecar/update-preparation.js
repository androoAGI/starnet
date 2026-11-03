/* sidecar/update-preparation.js — fail-closed pre-installer mutation barrier + verified recovery point (whenever there is
   station data to protect: see NOTHING TO PROTECT below). */
'use strict';
const { note: failNote } = require('./failopen.js');

/* A pre-update bundle is one JSON string (every payload base64 inside it); V8 caps a string at ~536.8M chars, which a
   station with ~400 MB of included files used to exceed, so the in-app update could never pass this step. The capture
   is bounded twice: 256 MiB of file contents, and the bundle's whole JSON text at station-recovery's BUNDLE_MAX_CHARS
   (each file row's framing is charged too, so a station of 500k small node_modules files fits as well). What does not
   fit is listed in the bundle (report.skipped: the largest 1000 by name, the rest per folder) and in the receipt
   (tooLarge). This only governs updates made FROM a build carrying it: 0.13.x prepares with its own, unbounded copy. */
const SNAPSHOT_BUDGET_BYTES = 256 * 1024 * 1024;

/* PRE-UPDATE RECOVERY POINTS ARE PRUNED (bug 31db37b0). Every INSTALL UPDATE attempt — retries and failed installs too —
   wrote another whole-station bundle into update-snapshots and nothing ever removed one (670 MB in 7 bundles on one
   station). After a verified prepare and once at boot, the newest KEEP_SNAPSHOTS bundles (+ their receipts) stay and
   the older ones go. Only `pre-*.starnet-backup.json` files this module wrote and their `.receipt.json` are ever touched;
   the bundle a prepare just verified (`protect`) is never removed. They are read-only (0o400), so each is made writable
   first. A file that cannot be removed is reported and left; pruning never fails the update. */
const KEEP_SNAPSHOTS = 3;
const SNAPSHOT_BUNDLE = /^pre-.+\.starnet-backup\.json$/i;

/* NOTHING TO PROTECT, NOTHING WRITTEN (the gh#123 family). Every build's onboarding gate reads a bundle in update-snapshots
   as a prior install, so an update prepared BEFORE onboarding (an empty workspace) trapped the next boot in Recovery Mode.
   The bundle is skipped only when there is nothing for it to recover, which takes BOTH: the workspace holds no station
   data (the host's holdsStationData(): no founded station, no save or roster, nothing the frozen fallback calls station
   state) AND the page's browser store holds no station-save journal (a starnet.save* key with a value: the page's own
   copy of a station the workspace may not have yet). Then no bundle and no receipt file are written, and the receipt
   lives in memory: { station: 'none', snapshot: null }. The barrier (freeze, drain, quiescence) is unchanged. A host
   that injects no holdsStationData, or a check that cannot answer, always captures. */
const SAVE_JOURNAL = /^(?:starnet|skynet)\.save(?:\.|$)/i;   // the window journals, their merge notes, the pre-migrate backup
function holdsSaveJournal(store) {
  return Object.keys(store).some(key => SAVE_JOURNAL.test(key) && store[key] != null && String(store[key]).length > 0);
}
function pruneSnapshots(o) {
  const fs = o.fs, path = o.path, dir = o.dir;
  const keep = Number.isFinite(o.keep) ? Math.max(1, o.keep) : KEEP_SNAPSHOTS;
  const key = f => path.resolve(f).toLowerCase();
  const protect = new Set((o.protect || []).filter(Boolean).map(key));
  const removed = [], errors = [];
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { return { removed, errors: e && e.code === 'ENOENT' ? errors : [{ file: dir, code: (e && e.code) || String(e) }] }; }
  const bundles = [];
  for (const name of names) {
    if (!SNAPSHOT_BUNDLE.test(name)) continue;
    const file = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(file); } catch (e) { errors.push({ file, code: (e && e.code) || String(e) }); }
    if (st && st.isFile()) bundles.push({ file, mtime: Number(st.mtimeMs) || 0, name });
  }
  // newest first; the name carries the prepare's clock, so it breaks an mtime tie
  bundles.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  let slots = keep - bundles.filter(b => protect.has(key(b.file))).length;
  for (const b of bundles) {
    if (protect.has(key(b.file))) continue;
    if (slots > 0) { slots--; continue; }
    // the receipt first: a bundle left without one is still found (and retried) next time; an orphan receipt never is
    let ok = true;
    for (const file of [b.file + '.receipt.json', b.file]) {
      if (!ok) break;
      try {
        if (!fs.existsSync(file)) continue;
        fs.chmodSync(file, 0o600);
        fs.unlinkSync(file);
        removed.push(file);
      } catch (e) { ok = false; errors.push({ file, code: (e && e.code) || String(e) }); }
    }
  }
  return { removed, errors };
}

/* A process stopped mid-write leaves <bundle>.tmp-<pid>-<nonce> beside where the bundle was going: a whole station in readable
   text, in Downloads, that nobody knows about. At boot the ones this feature names, and only those, go. A live writer's stays. */
const BACKUP_TEMP = /^starnet-recovery-[0-9-]+\.starnet-recovery\.json\.tmp-(\d+)-[A-Za-z0-9]+$/;
function sweepBackupTemps(o) {
  const fs = o.fs, path = o.path, dir = o.dir;
  const alive = typeof o.pidAlive === 'function' ? o.pidAlive : pid => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
  const removed = [], errors = [];
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return { removed, errors }; }
  for (const name of names) {
    const m = BACKUP_TEMP.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    const file = path.join(dir, name);
    try { fs.unlinkSync(file); removed.push(file); } catch (e) { errors.push({ file, code: (e && e.code) || String(e) }); }
  }
  return { removed, errors };
}

function makeUpdatePreparation(deps) {
  const d = deps || {};
  const fs = d.fs;
  const path = d.path;
  const recovery = d.recovery;
  const writeDurable = d.writeDurable;
  const workspaceRoot = path.resolve(String(d.workspaceRoot || ''));
  const now = typeof d.now === 'function' ? d.now : function () { return 0; };
  const newId = typeof d.newId === 'function' ? d.newId : function () { return String(now()); };
  const sleep = typeof d.sleep === 'function' ? d.sleep : function (ms) { return new Promise(resolve => setTimeout(resolve, ms)); };
  const liveRuns = typeof d.liveRuns === 'function' ? d.liveRuns : function () { return 0; };
  const abortRuns = typeof d.abortRuns === 'function' ? d.abortRuns : function () {};
  const appVersion = typeof d.appVersion === 'function' ? d.appVersion : function () { return 'unknown'; };
  const onFreeze = typeof d.onFreeze === 'function' ? d.onFreeze : function () {};
  const onThaw = typeof d.onThaw === 'function' ? d.onThaw : function () {};
  const holdsStationData = typeof d.holdsStationData === 'function' ? d.holdsStationData : function () { return true; };
  const snapshotBudget = Number.isFinite(d.snapshotBudgetBytes) && d.snapshotBudgetBytes >= 0 ? d.snapshotBudgetBytes : SNAPSHOT_BUDGET_BYTES;
  // the bundle's JSON-text limit: station-recovery's own default unless a test scales it down
  const snapshotBudgetChars = Number.isFinite(d.snapshotBudgetChars) && d.snapshotBudgetChars > 0 ? d.snapshotBudgetChars : undefined;
  const keepSnapshots = Number.isFinite(d.keepSnapshots) ? Math.max(1, d.keepSnapshots) : KEEP_SNAPSHOTS;
  const snapshotsDir = path.join(path.dirname(workspaceRoot), 'update-snapshots');
  if (!fs || !path || !recovery || typeof recovery.capture !== 'function' || typeof writeDurable !== 'function') {
    throw new Error('update-preparation: fs, path, recovery, and writeDurable are required');
  }

  let frozen = false;
  let activeMutations = 0;
  let completedMutations = 0;
  let receipt = null;
  let generation = 0;   // bumped by every prepare and every cancel: a prepare whose generation moved on was cancelled
  let backingUp = false;   // the barrier is up for a recovery bundle: it comes down by itself, unlike a prepare's

  function isControl(url) {
    const bare = String(url || '').split('?')[0];
    return bare === '/api/update/prepare' || bare === '/api/update/cancel' || bare === '/api/update/status' || bare === '/api/recovery/backup';
  }

  function beginRequest(method, url) {
    const verb = String(method || '').toUpperCase();
    if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS' || isControl(url)) return { ok: true, tracked: false, release: function () {} };
    if (frozen) return { ok: false, tracked: false, code: 'UPDATE_MUTATIONS_FROZEN' };
    activeMutations++;
    let released = false;
    return { ok: true, tracked: true, release: function () {
      if (released) return;
      released = true;
      activeMutations = Math.max(0, activeMutations - 1);
      completedMutations++;
    } };
  }

  async function waitForQuiescence(timeoutMs) {
    const deadline = now() + Math.max(250, Number(timeoutMs) || 5000);
    while (activeMutations > 0 || Number(liveRuns()) > 0) {
      if (now() >= deadline) return false;
      await sleep(25);
    }
    return true;
  }

  // { files, bytes, paths } of what the budget left out. The bundle lists the largest left-out files by name and folds
  // the rest into one row per folder ({ path: 'agent/webapp/**', files, bytes }); the receipt keeps the 200 largest rows
  const TOO_LARGE = String(recovery.BUDGET_SKIP_REASON || 'too large for the pre-update recovery point');
  function tooLargeSummary(bundle) {
    const rows = (bundle && bundle.report && Array.isArray(bundle.report.skipped) ? bundle.report.skipped : []).filter(s => s && s.reason === TOO_LARGE);
    rows.sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0));
    return {
      reason: TOO_LARGE, files: rows.reduce((n, s) => n + (Number(s.files) || 1), 0), bytes: rows.reduce((n, s) => n + (Number(s.bytes) || 0), 0),
      paths: rows.slice(0, 200).map(s => Number(s.files) > 0
        ? { path: String(s.path), bytes: Number(s.bytes) || 0, files: Number(s.files) }
        : { path: String(s.path), bytes: Number(s.bytes) || 0 })
    };
  }

  function safeTarget(value) { return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'unknown'; }
  // only a definite "no station data" skips the bundle; an unanswerable check captures
  function nothingToProtect(browserStore) {
    if (holdsSaveJournal(browserStore)) return false;
    try { return holdsStationData() === false; }
    catch (e) { return false; }
  }

  async function prepare(opts) {
    const o = opts || {};
    if (frozen && receipt) return { ok: true, frozen: true, receipt: receipt, reused: true };
    if (frozen) return { ok: false, frozen: true, code: 'UPDATE_PREPARATION_IN_PROGRESS' };
    frozen = true;   // the HTTP + new-run barrier: nothing NEW starts from here
    const gen = ++generation;
    const stillOurs = () => {
      if (gen !== generation) throw Object.assign(new Error('the update was cancelled'), { code: 'UPDATE_PREPARATION_CANCELLED' });
    };
    try {
      const live = Number(liveRuns());
      if (live > 0 && !o.force) throw Object.assign(new Error('agent runs are still active'), { code: 'UPDATE_RUNS_ACTIVE' });
      if (live > 0) abortRuns();   // INSTALL ANYWAY
      // DRAIN BEFORE FREEZE, on every path: a run's finalizer (aborted or not) and an in-flight mutation (a /v1 run is
      // only a mutation) book their spend through the freezing writer. Freezing first made that write throw and
      // stranded the settlement receipt across the upgrade ("Spend history is unavailable" on the next boot).
      const drained = await waitForQuiescence(o.timeoutMs);
      stillOurs();
      if (!drained) {
        throw Object.assign(new Error(live > 0 ? 'aborted agent runs did not finish before the update deadline'
          : 'workspace did not become quiescent before the update deadline'), { code: 'UPDATE_QUIESCENCE_TIMEOUT' });
      }
      onFreeze();
      const quiet = await waitForQuiescence(o.timeoutMs);
      stillOurs();
      if (!quiet) throw Object.assign(new Error('workspace did not become quiescent before the update deadline'), { code: 'UPDATE_QUIESCENCE_TIMEOUT' });

      const createdAt = Number(now());
      const id = String(createdAt) + '-' + String(newId()).replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 80);
      const browserStore = o.browserStore && typeof o.browserStore === 'object' ? o.browserStore : {};
      const receiptHead = () => ({
        schema: 'starnet.update-preparation', version: 1, id: id,
        createdAt: createdAt, fromVersion: String(appVersion() || 'unknown'), targetVersion: String(o.targetVersion || ''),
        frozen: true, activeMutations: activeMutations, liveRuns: Number(liveRuns()),
        completedMutation: 'http:' + completedMutations
      });
      // decided under the freeze, after the drain: nothing can found a station behind this check
      if (nothingToProtect(browserStore)) {
        receipt = Object.assign(receiptHead(), { station: 'none', snapshot: null });
        return { ok: true, frozen: true, receipt: receipt, pruned: 0 };
      }
      const dir = path.join(path.dirname(workspaceRoot), 'update-snapshots');
      const bundleFile = path.join(dir, 'pre-' + safeTarget(o.targetVersion) + '-' + id + '.starnet-backup.json');
      let bundle = recovery.capture({
        workspaceRoot: workspaceRoot,
        browserStore: browserStore,
        now: createdAt,
        appVersion: appVersion(),
        lastCompletedMutation: 'http:' + completedMutations,
        maxBytes: snapshotBudget,
        maxChars: snapshotBudgetChars
      });
      const written = recovery.writeBundleAtomic({ bundle: bundle, file: bundleFile, allowIncomplete: true });
      bundle = null;   // the read-back below holds a second whole copy: never keep both alive at once
      const readBack = recovery.readBundle(bundleFile);
      const fingerprint = recovery.semanticFingerprint(readBack);
      if (readBack.manifestSha256 !== written.manifestSha256) throw new Error('snapshot manifest read-back mismatch');

      const receiptFile = bundleFile + '.receipt.json';
      const nextReceipt = Object.assign(receiptHead(), {
        snapshot: { file: bundleFile, bytes: written.bytes, sha256: written.sha256, manifestSha256: written.manifestSha256 },
        semanticFingerprint: fingerprint,
        requirements: readBack.report && readBack.report.requirements || [],
        // entries the capture could not read (#91: vanished/locked/unresolvable) — the receipt never implies a byte-complete station
        unreadable: (readBack.report && Array.isArray(readBack.report.skipped) ? readBack.report.skipped : []).filter(s => /^unreadable: /.test(String(s && s.reason))),
        // files left out because the recovery point is one bounded JSON string (largest agent workspace files first)
        tooLarge: tooLargeSummary(readBack),
        browserKeys: Array.isArray(readBack.browser) ? readBack.browser.length : 0
      });
      writeDurable({ fs: fs, path: path }, receiptFile, JSON.stringify(nextReceipt, null, 2) + '\n');
      const receiptBack = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (!receiptBack || receiptBack.id !== id || receiptBack.snapshot.manifestSha256 !== written.manifestSha256) {
        throw new Error('update receipt read-back mismatch');
      }
      // Integrity hashes are authoritative; read-only mode adds a practical guard against accidental rewrites.
      try { fs.chmodSync(bundleFile, 0o400); } catch (_) {}   // owner-only: the bundle holds the whole station (0o444 was world-readable)
      try { fs.chmodSync(receiptFile, 0o400); } catch (_) {}
      nextReceipt.receiptFile = receiptFile;
      receipt = nextReceipt;
      // only now that this recovery point is verified on disk do the older ones go
      const pruned = pruneSnapshots({ fs: fs, path: path, dir: dir, keep: keepSnapshots, protect: [bundleFile] });
      return { ok: true, frozen: true, receipt: nextReceipt, pruned: pruned.removed.length };
    } catch (e) {
      // cancelled mid-drain: cancel() already thawed, and the barrier may now belong to a NEWER prepare — never touch it
      if (gen !== generation) return { ok: false, frozen: frozen, code: 'UPDATE_PREPARATION_CANCELLED', error: 'the update was cancelled' };
      frozen = false;
      receipt = null;
      try { onThaw(); } catch (_) {}
      return { ok: false, frozen: false, code: (e && e.code) || 'UPDATE_SNAPSHOT_FAILED', error: (e && e.message) || String(e) };
    }
  }

  /* THE RECOVERY BUNDLE A PERSON ASKS FOR (#119, SETTINGS > APP & BACKUP). The same barrier as an update (drain, freeze,
     capture, read back) with two differences: it always comes down again, and nothing is forced. A live run refuses it,
     because stopping someone's work is not what "back up" means. The credentials are excluded exactly as they are from
     a pre-update bundle. A locked connector store does not cost the person the rest of the station: it is left out and
     said so. Only the one-string cap applies, so a large agent workspace is listed as left out, not fatal.
     Never overwrites and never writes inside the station: the folder comes from the host, the name from here. */
  async function createBackup(opts) {
    const o = opts || {};
    if (frozen) return { ok: false, frozen: true, code: receipt ? 'UPDATE_PREPARED' : 'RECOVERY_BARRIER_BUSY', error: 'An update or another backup is using the station right now. Try again when it has finished.' };
    if (!o.dir) return { ok: false, frozen: false, code: 'BACKUP_NO_FOLDER', error: 'no folder to save the bundle into' };
    frozen = true;
    backingUp = true;
    const gen = ++generation;
    const stillOurs = () => {
      if (gen !== generation) throw Object.assign(new Error('the backup was cancelled'), { code: 'BACKUP_CANCELLED' });
    };
    let file = null, committed = false;
    // a failure after the file landed must not leave a whole station behind under a line saying nothing was written
    const unproven = () => {
      if (!committed) return {};
      try { fs.chmodSync(file, 0o600); } catch (e) { failNote('update-preparation.unproven-chmod', e); }
      try { fs.unlinkSync(file); return {}; } catch (_) { return { leftFile: file }; }
    };
    try {
      const live = Number(liveRuns());
      if (live > 0) throw Object.assign(new Error(live + (live === 1 ? ' agent run is' : ' agent runs are') + ' still working. Let them finish or stop them, then create the bundle.'), { code: 'BACKUP_RUNS_ACTIVE' });
      const drained = await waitForQuiescence(o.timeoutMs);
      stillOurs();
      if (!drained) throw Object.assign(new Error('the station did not become quiet in time. Try again in a moment.'), { code: 'BACKUP_QUIESCENCE_TIMEOUT' });
      onFreeze();
      const quiet = await waitForQuiescence(o.timeoutMs);
      stillOurs();
      if (!quiet) throw Object.assign(new Error('the station did not become quiet in time. Try again in a moment.'), { code: 'BACKUP_QUIESCENCE_TIMEOUT' });

      const dir = path.resolve(String(o.dir));
      const inside = path.relative(workspaceRoot, dir);
      if (inside === '' || (!path.isAbsolute(inside) && inside !== '..' && inside.indexOf('..' + path.sep) !== 0)) {
        throw Object.assign(new Error('a recovery bundle cannot be saved inside the station it backs up'), { code: 'BACKUP_FOLDER_INSIDE_STATION' });
      }
      const createdAt = Number(now());
      const base = 'starnet-recovery-' + new Date(createdAt).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
      for (let i = 1; i <= 99 && !file; i++) {
        const candidate = path.join(dir, base + (i === 1 ? '' : '-' + i) + '.starnet-recovery.json');
        if (!fs.existsSync(candidate)) file = candidate;
      }
      if (!file) throw Object.assign(new Error('too many bundles with the same name in ' + dir), { code: 'BACKUP_NAME_TAKEN' });
      let bundle = recovery.capture({
        workspaceRoot: workspaceRoot,
        browserStore: o.browserStore && typeof o.browserStore === 'object' ? o.browserStore : {},
        now: createdAt,
        appVersion: appVersion(),
        lastCompletedMutation: 'http:' + completedMutations,
        maxChars: snapshotBudgetChars || recovery.BUNDLE_MAX_CHARS,
        budgetReason: recovery.EXPLICIT_BUDGET_REASON,
        omitUnavailableCredentialStores: true
      });
      const written = recovery.writeBundleAtomic({ bundle: bundle, file: file, allowIncomplete: true, noOverwrite: true });
      committed = true;
      bundle = null;   // the read-back below holds a second whole copy: never keep both alive at once
      const readBack = recovery.readBundle(file);
      if (readBack.manifestSha256 !== written.manifestSha256) throw new Error('recovery bundle read-back mismatch');
      try { fs.chmodSync(file, 0o600); } catch (e) { failNote('update-preparation.bundle-chmod', e); }   // owner-only: it holds the whole station
      const report = readBack.report || {};
      const gaps = recovery.integrityGaps(report);
      return {
        ok: true, frozen: false, file: file, bytes: written.bytes, sha256: written.sha256, manifestSha256: written.manifestSha256,
        createdAt: createdAt, appVersion: readBack.appVersion, files: readBack.files.length, browserKeys: readBack.browser.length,
        complete: !!report.complete, requirements: recovery.trustedRequirements(readBack), integrity: recovery.bundleIntegrity(readBack),
        gate: recovery.restoreGate(readBack),
        gaps: gaps.slice(0, 200), gapsTotal: gaps.length,
        reauthentication: (report.reauthentication || []).slice(0, 200)
      };
    } catch (e) {
      if (gen !== generation) return Object.assign({ ok: false, frozen: frozen, code: 'BACKUP_CANCELLED', error: 'the backup was cancelled' }, unproven());
      return Object.assign({ ok: false, frozen: false, code: (e && e.code) || 'BACKUP_FAILED', error: (e && e.message) || String(e) }, unproven());
    } finally {
      backingUp = false;
      if (gen === generation) { frozen = false; try { onThaw(); } catch (e) { failNote('update-preparation.thaw', e); } }
    }
  }

  function cancel() { generation++; frozen = false; receipt = null; try { onThaw(); } catch (_) {} return { ok: true, frozen: false }; }
  function status() { return { frozen: frozen, activeMutations: activeMutations, completedMutations: completedMutations, receipt: receipt }; }

  // the boot-time pass (index.js): the live receipt's bundle, if any, is never a candidate
  function pruneOld() {
    return pruneSnapshots({ fs: fs, path: path, dir: snapshotsDir, keep: keepSnapshots, protect: receipt && receipt.snapshot ? [receipt.snapshot.file] : [] });
  }

  return { beginRequest: beginRequest, prepare: prepare, createBackup: createBackup, cancel: cancel, status: status, pruneSnapshots: pruneOld, isFrozen: function () { return frozen; }, isBackingUp: function () { return backingUp; } };
}

module.exports = { makeUpdatePreparation: makeUpdatePreparation, SNAPSHOT_BUDGET_BYTES: SNAPSHOT_BUDGET_BYTES, KEEP_SNAPSHOTS: KEEP_SNAPSHOTS, pruneSnapshots: pruneSnapshots, sweepBackupTemps: sweepBackupTemps };
