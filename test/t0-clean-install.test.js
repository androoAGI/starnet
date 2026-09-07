#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const script = path.join(ROOT, 'scripts', 't0-clean-install.mjs');

function run(args, env) {
  return spawnSync(process.execPath, [script].concat(args || []), {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || {})
  });
}

function proof(hash, bytes, overrides) {
  return Object.assign({
    schema: 'starnet.clean-install-proof.v1',
    generatedAt: new Date().toISOString(),
    sourceMachine: { os: 'Windows 11 Test VM' },
    machineKind: 'windows-sandbox',
    cleanMachine: true,
    installer: { sha256: hash, bytes },
    install: { succeeded: true, method: 'manual', installLocation: 'C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\Programs\\StarNet' },
    launch: {
      succeeded: true,
      observedWindowTitle: 'StarNet',
      exePath: 'C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\Programs\\StarNet\\skynet-desktop.exe',
      startupRoot: 'C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\Programs\\StarNet',
      workspaceRoot: 'C:\\Users\\WDAGUtilityAccount\\AppData\\Roaming\\ai.skynet.harness\\workspaces'
    },
    notes: []
  }, overrides || {});
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't0-clean-install-'));
try {
  const installer = path.join(tmp, 'StarNet_0.1.0_x64-setup.exe');
  fs.writeFileSync(installer, 'fake installer');
  const hash = crypto.createHash('sha256').update('fake installer').digest('hex');
  const bytes = fs.statSync(installer).size;
  const surfaceNone = JSON.stringify({ platform: 'win32', windowsSandboxAvailable: false, vmToolsAvailable: false, cleanSurfaceAvailable: false, note: 'mock no clean surface' });
  const surfaceYes = JSON.stringify({ platform: 'win32', windowsSandboxAvailable: true, vmToolsAvailable: false, cleanSurfaceAvailable: true, note: 'mock sandbox' });

  {
    const out = path.join(tmp, 'blocked-out');
    const res = run([], {
      STARNET_T0_INSTALLER_EXE: installer,
      STARNET_T0_CLEAN_INSTALL_DIR: out,
      STARNET_T0_CLEAN_INSTALL_LATEST_DIR: path.join(tmp, 'blocked-latest'),
      STARNET_T0_CLEAN_SURFACE_MOCK: surfaceNone
    });
    assert.equal(res.status, 2, res.stderr || res.stdout);
    const status = JSON.parse(fs.readFileSync(path.join(out, 't0-clean-install-status.json'), 'utf8'));
    assert.equal(status.cleanInstallProofReady, false);
    assert.equal(status.verdict, 'blocked');
    assert.equal(status.nextAction.id, 't0.2-clean-windows-surface');
  }

  {
    const evidence = path.join(tmp, 'proof.json');
    fs.writeFileSync(evidence, JSON.stringify(proof(hash, bytes), null, 2));
    const out = path.join(tmp, 'green-out');
    const res = run(['--evidence', evidence], {
      STARNET_T0_INSTALLER_EXE: installer,
      STARNET_T0_CLEAN_INSTALL_DIR: out,
      STARNET_T0_CLEAN_INSTALL_LATEST_DIR: path.join(tmp, 'green-latest'),
      STARNET_T0_CLEAN_SURFACE_MOCK: surfaceNone
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const status = JSON.parse(fs.readFileSync(path.join(out, 't0-clean-install-status.json'), 'utf8'));
    assert.equal(status.cleanInstallProofReady, true);
    assert.equal(status.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).version);
    assert.equal(status.installer.sha256, hash);
    // Exercise the real receipt consumer: the old writer said green but omitted the
    // version, so release-preflight continued to say the completed T0 was owed.
    const recognition = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {runPreflight} from './scripts/release-preflight.mjs';
      const receipt = ${JSON.stringify(status)};
      const io = {
        readText: p => p.endsWith('/t0-clean-install-status.json') ? JSON.stringify(receipt) : null,
        listDir: p => p === '.dogfood' ? ['t0-clean-install-test'] : [],
        exists: () => false, stat: () => null, exec: () => ({status: 1, stdout: '', stderr: 'fixture unavailable'}), now: () => Date.now()
      };
      const result = runPreflight({version: receipt.version, phase: 'post-bump'}, io);
      if (result.rows.find(r => r.id === 't0')?.status !== 'PASS') throw Error('validated T0 not recognized');
    `], {cwd: ROOT, encoding: 'utf8'});
    assert.equal(recognition.status, 0, recognition.stderr);
    assert.equal(status.verdict, 'green');
    assert.equal(status.nextAction, null);
  }

  {
    const evidence = path.join(tmp, 'bom-proof.json');
    fs.writeFileSync(evidence, '\ufeff' + JSON.stringify(proof(hash, bytes), null, 2), 'utf8');
    const out = path.join(tmp, 'bom-green-out');
    const res = run(['--evidence', evidence], {
      STARNET_T0_INSTALLER_EXE: installer,
      STARNET_T0_CLEAN_INSTALL_DIR: out,
      STARNET_T0_CLEAN_INSTALL_LATEST_DIR: path.join(tmp, 'bom-green-latest'),
      STARNET_T0_CLEAN_SURFACE_MOCK: surfaceNone
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const status = JSON.parse(fs.readFileSync(path.join(out, 't0-clean-install-status.json'), 'utf8'));
    assert.equal(status.cleanInstallProofReady, true);
    assert.equal(status.verdict, 'green');
    assert.equal(status.nextAction, null);
  }

  {
    const evidence = path.join(tmp, 'bad-proof.json');
    fs.writeFileSync(evidence, JSON.stringify(proof('00' + hash.slice(2), bytes), null, 2));
    const out = path.join(tmp, 'red-out');
    const res = run(['--evidence=' + evidence], {
      STARNET_T0_INSTALLER_EXE: installer,
      STARNET_T0_CLEAN_INSTALL_DIR: out,
      STARNET_T0_CLEAN_INSTALL_LATEST_DIR: path.join(tmp, 'red-latest'),
      STARNET_T0_CLEAN_SURFACE_MOCK: surfaceYes
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const status = JSON.parse(fs.readFileSync(path.join(out, 't0-clean-install-status.json'), 'utf8'));
    assert.equal(status.verdict, 'red');
    assert.equal(status.nextAction.id, 't0.3-matching-clean-machine-evidence');
  }

  {
    const evidence = path.join(tmp, 'smoke-proof.json');
    fs.writeFileSync(evidence, JSON.stringify(proof(hash, bytes, {
      install: { succeeded: true, method: 'manual', installLocation: 'C:\\Users\\andro\\AppData\\Local\\Programs\\StarNetT4UpdateSmoke-20260628-065002' },
      launch: {
        succeeded: true,
        observedWindowTitle: 'StarNet',
        exePath: 'C:\\Users\\andro\\AppData\\Local\\Programs\\StarNetT4UpdateSmoke-20260628-065002\\skynet-desktop.exe',
        startupRoot: 'C:\\Users\\andro\\AppData\\Local\\Programs\\StarNetT4UpdateSmoke-20260628-065002',
        workspaceRoot: 'C:\\Users\\andro\\AppData\\Local\\Programs\\StarNetT4UpdateSmoke-20260628-065002\\sidecar\\workspaces'
      }
    }), null, 2));
    const out = path.join(tmp, 'smoke-red-out');
    const res = run(['--evidence=' + evidence], {
      STARNET_T0_INSTALLER_EXE: installer,
      STARNET_T0_CLEAN_INSTALL_DIR: out,
      STARNET_T0_CLEAN_INSTALL_LATEST_DIR: path.join(tmp, 'smoke-red-latest'),
      STARNET_T0_CLEAN_SURFACE_MOCK: surfaceYes
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const status = JSON.parse(fs.readFileSync(path.join(out, 't0-clean-install-status.json'), 'utf8'));
    assert.equal(status.verdict, 'red');
    assert.match(status.failures.join('\n'), /smoke-test install path|installation directory/);
  }

  {
    const out = path.join(tmp, 'surface-out');
    const res = run([], {
      STARNET_T0_INSTALLER_EXE: installer,
      STARNET_T0_CLEAN_INSTALL_DIR: out,
      STARNET_T0_CLEAN_INSTALL_LATEST_DIR: path.join(tmp, 'surface-latest'),
      STARNET_T0_CLEAN_SURFACE_MOCK: surfaceYes
    });
    assert.equal(res.status, 2, res.stderr || res.stdout);
    const status = JSON.parse(fs.readFileSync(path.join(out, 't0-clean-install-status.json'), 'utf8'));
    assert.equal(status.verdict, 'blocked');
    assert.equal(status.nextAction.id, 't0.3-matching-clean-machine-evidence');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('t0-clean-install.test: OK (18 assertions)');
