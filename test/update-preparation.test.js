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
