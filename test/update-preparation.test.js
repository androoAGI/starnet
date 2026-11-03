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

    // DRAIN BEFORE FREEZE on EVERY path, not only INSTALL ANYWAY: an in-flight mutation the run registry never sees (a /v1
    // run is tracked only as a mutation) books its spend through the freezing writer too. Freezing first made that write
    // throw — the plain INSTALL UPDATE path stranded the receipt exactly like the forced one did.
    {
      const events = [];
      let frozenD = false, clockD = 3000, pending = null;
      const settlement = path.join(workspace, 'spend-pending', 'settlement-v1.json');
      const prepD = makeUpdatePreparation({
        fs, path, recovery: Recovery, writeDurable: writeFileDurable, workspaceRoot: workspace,
        now: () => clockD, newId: () => 'v1', liveRuns: () => 0,
        onFreeze: () => { events.push('freeze'); frozenD = true; }, onThaw: () => { frozenD = false; },
        sleep: async () => { clockD += 25; if (pending) { const fn = pending; pending = null; fn(); } }
      });
      const v1 = prepD.beginRequest('POST', '/v1/chat/completions');
      pending = () => {
        try {
          if (frozenD) throw Object.assign(new Error('durable writes are frozen for update'), { code: 'UPDATE_MUTATIONS_FROZEN' });
          fs.mkdirSync(path.dirname(settlement), { recursive: true });
          writeFileDurable({ fs, path }, settlement, JSON.stringify({ runId: 'chatcmpl-1', entry: { usd: 0.07 } }));
          events.push('settled');
        } catch (e) { events.push('settle-failed:' + e.code); }
        v1.release();
      };
      const madeD = await prepD.prepare({ targetVersion: '1.3.0', browserStore: {} });
      A.eq(madeD.ok, true, 'a plain install with an in-flight /v1 run still gets its recovery point');
      A.eq(events, ['settled', 'freeze'], 'the in-flight mutation books its spend BEFORE durable writes freeze');
      A.eq(Recovery.readBundle(madeD.receipt.snapshot.file).files.some(row => row.path === 'spend-pending/settlement-v1.json'), true, 'and its settlement rides inside the recovery point');
      prepD.cancel();
      fs.rmSync(path.join(workspace, 'spend-pending'), { recursive: true, force: true });
    }

    // CANCEL WINS OVER AN IN-FLIGHT PREPARE: a cancel during the drain used to be undone when the drain finished
    // (durable writes frozen + a receipt minted under a released HTTP barrier). A stale prepare also never touches
    // the barrier of a NEWER prepare started after the cancel.
    {
      let clockE = 7000, tick = 0, liveE = 1, frozenE = false, second = null;
      const prepE = makeUpdatePreparation({
        fs, path, recovery: Recovery, writeDurable: writeFileDurable, workspaceRoot: workspace,
        now: () => clockE, newId: () => 'cancel-' + tick, liveRuns: () => liveE, abortRuns: () => {},
        onFreeze: () => { frozenE = true; }, onThaw: () => { frozenE = false; },
        sleep: async () => {
          clockE += 25; tick++;
          if (tick === 2) prepE.cancel();
          if (tick === 3) second = prepE.prepare({ targetVersion: '1.3.0', force: true, browserStore: {} });
          if (tick === 6) liveE = 0;
        }
      });
      const first = await prepE.prepare({ targetVersion: '1.3.0', force: true, browserStore: {} });
      A.eq(first.ok, false, 'a prepare cancelled mid-drain does not finish');
      A.eq(first.code, 'UPDATE_PREPARATION_CANCELLED', 'it says it was cancelled');
      const madeE = await second;
      A.eq(madeE && madeE.ok, true, 'the prepare started after the cancel completes on its own');
      A.eq(prepE.isFrozen(), true, 'the stale prepare never released the newer barrier');
      A.eq(frozenE, true, 'durable writes are frozen once, by the live prepare');
      A.eq(prepE.status().receipt && prepE.status().receipt.id, madeE && madeE.receipt.id, "the receipt is the live prepare's");
      prepE.cancel();
      let clockF = 8000, tickF = 0, frozenF = false;
      const prepF = makeUpdatePreparation({
        fs, path, recovery: Recovery, writeDurable: writeFileDurable, workspaceRoot: workspace,
        now: () => clockF, newId: () => 'cancel-f', liveRuns: () => (tickF < 4 ? 1 : 0), abortRuns: () => {},
        onFreeze: () => { frozenF = true; }, onThaw: () => { frozenF = false; },
        sleep: async () => { clockF += 25; tickF++; if (tickF === 2) prepF.cancel(); }
      });
      const lone = await prepF.prepare({ targetVersion: '1.3.0', force: true, browserStore: {} });
      A.eq(lone.code, 'UPDATE_PREPARATION_CANCELLED', 'a lone cancelled prepare reports the cancel');
      A.eq(frozenF, false, 'durable writes stay open after the cancel');
      A.eq(prepF.isFrozen(), false, 'the HTTP barrier stays released');
      A.eq(prepF.status().receipt, null, 'and no receipt is minted');
    }

    // NOTHING TO PROTECT, NOTHING WRITTEN (the gh#123 family: a bundle in update-snapshots reads as a prior install to every
    // build's gate). Only a definite "no station data" with no station-save journal in the page skips the bundle; a journal,
    // station data, a host that injects no check, or a check that cannot answer always captures.
    {
      const listing = () => { const dir = path.join(sandbox, 'update-snapshots'); return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; };
      let clockG = 12000, n = 0, frozenG = false;
      const make = holds => makeUpdatePreparation({
        fs, path, recovery: Recovery, writeDurable: writeFileDurable, workspaceRoot: workspace,
        now: () => clockG, newId: () => 'nothing-' + (++n), appVersion: () => '1.2.3', liveRuns: () => 0,
        onFreeze: () => { frozenG = true; }, onThaw: () => { frozenG = false; }, sleep: async () => { clockG += 25; },
        holdsStationData: holds
      });
      const before = listing();
      const none = make(() => false);
      const skipped = await none.prepare({ targetVersion: '1.3.0', browserStore: { 'starnet.byok.model': 'test/model', 'starnet.save': '', 'starnet.saved-views': '{}' } });
      A.eq([skipped.ok, skipped.frozen, skipped.receipt.station, skipped.receipt.snapshot], [true, true, 'none', null], 'no station data and no journal (an empty journal key holds none, and a key that only starts alike is none): an in-memory receipt, station none, no snapshot');
      A.eq([skipped.receipt.fromVersion, skipped.receipt.targetVersion, skipped.receipt.receiptFile], ['1.2.3', '1.3.0', undefined], 'the receipt still binds both builds, and names no receipt file');
      A.eq(listing(), before, 'nothing is written to update-snapshots');
      A.eq([frozenG, none.isFrozen(), none.status().receipt.station], [true, true, 'none'], 'under the same barrier as a captured prepare');
      A.eq(none.beginRequest('POST', '/api/save').code, 'UPDATE_MUTATIONS_FROZEN', 'so nothing can found a station behind the receipt');
      A.eq(none.pruneSnapshots().removed.length, 0, 'and the boot prune has no snapshot of it to protect or remove');
      none.cancel();
      for (const [label, holds, store] of [
        ['a station-save journal in the page', () => false, { 'starnet.save.w.tab-2': '{"agent":{"id":"agent"}}' }],
        ['a journal under the pre-rename name', () => false, { 'skynet.save': '{"agent":{"id":"agent"}}' }],
        ['station data on disk', () => true, {}],
        ['a host that injects no check', undefined, {}],
        ['a check that cannot answer', () => { throw new Error('fixture: unreadable'); }, {}]
      ]) {
        const prep = make(holds);
        const made = await prep.prepare({ targetVersion: '1.3.0', browserStore: store });
        A.ok(made.ok === true && !!made.receipt.snapshot && fs.existsSync(made.receipt.snapshot.file) && made.receipt.station === undefined, label + ': a verified recovery bundle is written');
        prep.cancel();
      }
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
