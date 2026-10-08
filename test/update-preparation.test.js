/* node test/update-preparation.test.js — fail-closed update barrier, verified snapshot, durable receipt. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Recovery = require('../sidecar/station-recovery.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeUpdatePreparation } = require('../sidecar/update-preparation.js');

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-update-prep-'));
  const workspace = path.join(sandbox, 'workspaces');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'agent.save.json'), JSON.stringify({ version: 5, updatedAt: 99, agent: { id: 'agent' } }));
  fs.writeFileSync(path.join(workspace, '.starnet-workspace-owner.json'), JSON.stringify({ version: 1, pid: 1, nonce: 'runtime-only' }));
  fs.mkdirSync(path.join(workspace, '.starnet-workspace-owner.json.generations'));
  fs.writeFileSync(path.join(workspace, '.starnet-workspace-owner.json.generations', '0.json'), '{}');
  let clock = 1000;
  let releaseOnSleep = null;
  let live = 0;
  let aborted = 0;
  let idSeq = 0;
  let durableFrozen = false;
  const prep = makeUpdatePreparation({
    fs, path, recovery: Recovery, writeDurable: writeFileDurable, workspaceRoot: workspace,
    now: () => clock, newId: () => 'receipt-' + (++idSeq), appVersion: () => '1.2.3',
    liveRuns: () => live, abortRuns: () => { aborted++; live = 0; },
    onFreeze: () => { durableFrozen = true; }, onThaw: () => { durableFrozen = false; },
    sleep: async () => { clock += 25; if (releaseOnSleep) { const fn = releaseOnSleep; releaseOnSleep = null; fn(); } }
  });

  try {
    const inFlight = prep.beginRequest('POST', '/api/save');
    A.eq(inFlight.ok, true, 'mutation starts before the barrier');
    releaseOnSleep = inFlight.release;
    const made = await prep.prepare({
      targetVersion: '1.3.0', browserStore: { 'starnet.save': JSON.stringify({ version: 5, updatedAt: 100 }) }
    });
    A.eq(made.ok, true, 'prepare waits for the in-flight mutation and succeeds');
    A.eq(made.receipt.activeMutations, 0, 'receipt proves there were no active HTTP mutations');
    A.eq(made.receipt.liveRuns, 0, 'receipt proves there were no live runs');
    A.eq(durableFrozen, true, 'background durable-write seam is frozen before capture');
    A.eq(made.receipt.fromVersion, '1.2.3', 'receipt binds the source build');
    A.eq(made.receipt.targetVersion, '1.3.0', 'receipt binds the requested target build');
    A.ok(fs.existsSync(made.receipt.snapshot.file), 'verified recovery bundle exists');
    A.ok(fs.existsSync(made.receipt.receiptFile), 'durable receipt exists beside it');

    const bundle = Recovery.readBundle(made.receipt.snapshot.file);
    A.eq(bundle.browser.length, 1, 'snapshot carries browser-owned StarNet state');
    A.eq(bundle.files.some(row => row.path === 'agent.save.json'), true, 'snapshot carries canonical workspace state');
    A.eq(bundle.files.some(row => row.path === '.starnet-workspace-owner.json'), false, 'runtime owner claim is excluded from recovery state');
    A.eq(bundle.files.some(row => row.path.startsWith('.starnet-workspace-owner.json.generations/')), false, 'runtime generations cannot strand restored profiles');
    A.eq(prep.beginRequest('POST', '/api/roster').code, 'UPDATE_MUTATIONS_FROZEN', 'new mutations fail closed after the receipt');
    A.eq(prep.beginRequest('GET', '/api/save?agent=agent').ok, true, 'read-only recovery access remains available');
    A.eq(prep.cancel().frozen, false, 'failed native install can unfreeze the live app');
    A.eq(durableFrozen, false, 'cancel thaws background durable writes');
    const afterCancel = prep.beginRequest('POST', '/api/roster');
    A.eq(afterCancel.ok, true, 'mutations resume only after explicit cancel');
    afterCancel.release();

    live = 2;
    const forced = await prep.prepare({ targetVersion: '1.3.0', force: true, browserStore: {} });
    A.eq(forced.ok, true, 'explicit force aborts live runs before snapshot');
    A.eq(aborted, 1, 'live runs were actually aborted');
    A.eq(forced.receipt.liveRuns, 0, 'forced receipt is still quiescent, never best-effort');

    // B10: INSTALL ANYWAY aborts and DRAINS before it freezes durable writes. An aborted run's finalizer books its
    // spend through the freezing writer (index.js writeFileDurable -> ledger settlement journal); freezing first
    // made that write throw, stranding the receipt across the upgrade -> "Spend history is unavailable" on next boot.
    {
      const events = [];
      let liveB = 2, frozenB = false, clockB = 2000, finalizer = null;
      const settlement = path.join(workspace, 'spend-pending', 'settlement-run-b10.json');
      const guardedWrite = (file, text) => {   // the same contract as index.js writeFileDurable
        if (frozenB) throw Object.assign(new Error('durable writes are frozen for update'), { code: 'UPDATE_MUTATIONS_FROZEN' });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileDurable({ fs, path }, file, text);
      };
      const prepB = makeUpdatePreparation({
        fs, path, recovery: Recovery, writeDurable: writeFileDurable, workspaceRoot: workspace,
        now: () => clockB, newId: () => 'b10', appVersion: () => '1.2.3', liveRuns: () => liveB,
        abortRuns: () => {
          events.push('abort');
          // the abort signal lands; the run's finalizer settles a tick later, then the registry drops it
          finalizer = () => {
            try { guardedWrite(settlement, JSON.stringify({ runId: 'run-b10', entry: { usd: 0.42 } })); events.push('settled'); }
            catch (e) { events.push('settle-failed:' + e.code); }
            liveB = 0;
          };
        },
        onFreeze: () => { events.push('freeze'); frozenB = true; }, onThaw: () => { events.push('thaw'); frozenB = false; },
        sleep: async () => { clockB += 25; if (finalizer) { const fn = finalizer; finalizer = null; fn(); } }
      });
      const forcedB = await prepB.prepare({ targetVersion: '1.3.0', force: true, browserStore: {} });
      A.eq(forcedB.ok, true, 'INSTALL ANYWAY still produces a verified recovery point');
      A.eq(events, ['abort', 'settled', 'freeze'], 'INSTALL ANYWAY: abort, let the aborted run settle its spend, THEN freeze durable writes');
      A.ok(fs.existsSync(settlement), 'the aborted run\'s spend settlement is on disk, not stranded');
      const snapB = Recovery.readBundle(forcedB.receipt.snapshot.file);
      A.eq(snapB.files.some(row => row.path === 'spend-pending/settlement-run-b10.json'), true, 'and it rides inside the pre-update recovery point');
      A.eq(forcedB.receipt.liveRuns, 0, 'the forced receipt is quiescent');
      A.eq(frozenB, true, 'durable writes are frozen once the recovery point exists');
      prepB.cancel();
      fs.rmSync(path.join(workspace, 'spend-pending'), { recursive: true, force: true });
    }

    // A run that ignores the abort never gets durable writes frozen under it: the bounded drain times out and the
    // station stays fully writable (no recovery point, no install).
    {
      const events = [];
      let clockC = 9000;
      const prepC = makeUpdatePreparation({
        fs, path, recovery: Recovery, writeDurable: writeFileDurable, workspaceRoot: workspace,
        now: () => clockC, newId: () => 'stuck', liveRuns: () => 1, abortRuns: () => { events.push('abort'); },
        onFreeze: () => { events.push('freeze'); }, onThaw: () => { events.push('thaw'); },
        sleep: async () => { clockC += 25; }
      });
      const stuck = await prepC.prepare({ targetVersion: '1.3.0', force: true, timeoutMs: 500, browserStore: {} });
      A.eq(stuck.ok, false, 'a run that never drains refuses the update');
      A.eq(stuck.code, 'UPDATE_QUIESCENCE_TIMEOUT', 'with the quiescence code');
      A.eq(events.includes('freeze'), false, 'durable writes were never frozen while the run was still live');
      A.eq(prepC.isFrozen(), false, 'the HTTP barrier is released');
      A.eq(prepC.beginRequest('POST', '/api/roster').ok, true, 'mutations work again');
      const refused = await makeUpdatePreparation({
        fs, path, recovery: Recovery, writeDurable: writeFileDurable, workspaceRoot: workspace,
        liveRuns: () => 1, abortRuns: () => { events.push('abort-unforced'); }, sleep: async () => {}
      }).prepare({ targetVersion: '1.3.0', browserStore: {} });
      A.eq(refused.code, 'UPDATE_RUNS_ACTIVE', 'without INSTALL ANYWAY live runs still refuse the update');
      A.eq(events.includes('abort-unforced'), false, 'and nothing is aborted');
    }

    A.report('update-preparation.test');
  } finally {
    try {
      const dir = path.join(sandbox, 'update-snapshots');
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        try { fs.chmodSync(path.join(dir, name), 0o666); } catch (_) {}
      }
    } catch (_) {}
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
