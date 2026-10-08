/* sidecar/update-preparation.js — fail-closed pre-installer mutation barrier + verified recovery point. */
'use strict';

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
  if (!fs || !path || !recovery || typeof recovery.capture !== 'function' || typeof writeDurable !== 'function') {
    throw new Error('update-preparation: fs, path, recovery, and writeDurable are required');
  }

  let frozen = false;
  let activeMutations = 0;
  let completedMutations = 0;
  let receipt = null;

  function isControl(url) {
    const bare = String(url || '').split('?')[0];
    return bare === '/api/update/prepare' || bare === '/api/update/cancel' || bare === '/api/update/status';
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

  function safeTarget(value) { return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'unknown'; }

  async function prepare(opts) {
    const o = opts || {};
    if (frozen && receipt) return { ok: true, frozen: true, receipt: receipt, reused: true };
    if (frozen) return { ok: false, frozen: true, code: 'UPDATE_PREPARATION_IN_PROGRESS' };
    frozen = true;   // the HTTP + new-run barrier: nothing NEW starts from here
    try {
      if (Number(liveRuns()) > 0) {
        if (!o.force) throw Object.assign(new Error('agent runs are still active'), { code: 'UPDATE_RUNS_ACTIVE' });
        // INSTALL ANYWAY: abort and DRAIN before freezing durable writes. An aborted run's finalizer books its spend
        // through the freezing writer; freezing first made that write throw and stranded the settlement receipt
        // across the upgrade ("Spend history is unavailable" on the next boot).
        abortRuns();
        const drained = await waitForQuiescence(o.timeoutMs);
        if (!drained) throw Object.assign(new Error('aborted agent runs did not finish before the update deadline'), { code: 'UPDATE_QUIESCENCE_TIMEOUT' });
      }
      onFreeze();
      const quiet = await waitForQuiescence(o.timeoutMs);
      if (!quiet) throw Object.assign(new Error('workspace did not become quiescent before the update deadline'), { code: 'UPDATE_QUIESCENCE_TIMEOUT' });

      const createdAt = Number(now());
      const id = String(createdAt) + '-' + String(newId()).replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 80);
      const dir = path.join(path.dirname(workspaceRoot), 'update-snapshots');
      const bundleFile = path.join(dir, 'pre-' + safeTarget(o.targetVersion) + '-' + id + '.starnet-backup.json');
      const bundle = recovery.capture({
        workspaceRoot: workspaceRoot,
        browserStore: o.browserStore && typeof o.browserStore === 'object' ? o.browserStore : {},
        now: createdAt,
        appVersion: appVersion(),
        lastCompletedMutation: 'http:' + completedMutations
      });
      const written = recovery.writeBundleAtomic({ bundle: bundle, file: bundleFile, allowIncomplete: true });
      const readBack = recovery.readBundle(bundleFile);
      const fingerprint = recovery.semanticFingerprint(readBack);
      if (readBack.manifestSha256 !== written.manifestSha256) throw new Error('snapshot manifest read-back mismatch');

      const receiptFile = bundleFile + '.receipt.json';
      const nextReceipt = {
        schema: 'starnet.update-preparation', version: 1, id: id,
        createdAt: createdAt, fromVersion: String(appVersion() || 'unknown'), targetVersion: String(o.targetVersion || ''),
        frozen: true, activeMutations: activeMutations, liveRuns: Number(liveRuns()),
        completedMutation: 'http:' + completedMutations,
        snapshot: { file: bundleFile, bytes: written.bytes, sha256: written.sha256, manifestSha256: written.manifestSha256 },
        semanticFingerprint: fingerprint,
        requirements: readBack.report && readBack.report.requirements || [],
        // entries the capture could not read (#91: vanished/locked/unresolvable) — the receipt never implies a byte-complete station
        unreadable: (readBack.report && Array.isArray(readBack.report.skipped) ? readBack.report.skipped : []).filter(s => /^unreadable: /.test(String(s && s.reason))),
        browserKeys: Array.isArray(readBack.browser) ? readBack.browser.length : 0
      };
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
      return { ok: true, frozen: true, receipt: nextReceipt };
    } catch (e) {
      frozen = false;
      receipt = null;
      try { onThaw(); } catch (_) {}
      return { ok: false, frozen: false, code: (e && e.code) || 'UPDATE_SNAPSHOT_FAILED', error: (e && e.message) || String(e) };
    }
  }

  function cancel() { frozen = false; receipt = null; try { onThaw(); } catch (_) {} return { ok: true, frozen: false }; }
  function status() { return { frozen: frozen, activeMutations: activeMutations, completedMutations: completedMutations, receipt: receipt }; }

  return { beginRequest: beginRequest, prepare: prepare, cancel: cancel, status: status, isFrozen: function () { return frozen; } };
}

module.exports = { makeUpdatePreparation: makeUpdatePreparation };
