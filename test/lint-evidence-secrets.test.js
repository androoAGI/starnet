#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const script = path.join(ROOT, 'scripts', 'lint-evidence-secrets.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-secret-lint-'));

try {
  fs.mkdirSync(path.join(tmp, 'clean'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'clean', 'phase5-status.json'), '{"model":"anthropic/test","usd":0.01}\n');
  fs.mkdirSync(path.join(tmp, 'clean', 'frozen-reference', '.git'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'clean', 'frozen-reference', 'upstream-fixture.txt'), 'key=sk-or-v1-upstreamfixture12345\n');
  {
    const res = spawnSync(process.execPath, [script, path.relative(ROOT, path.join(tmp, 'clean'))], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /OK/);
    assert.doesNotMatch(res.stdout + res.stderr, /upstream-fixture/, 'nested source checkouts are not treated as authored evidence');
  }

  fs.mkdirSync(path.join(tmp, 'dirty'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'dirty', 'phase5.log'), 'key=sk-or-v1-abc123456789xyz\n');
  {
    const res = spawnSync(process.execPath, [script, path.relative(ROOT, path.join(tmp, 'dirty'))], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(res.stderr, /openrouter-v1-key/);
    assert.doesNotMatch(res.stderr, /abc123456789xyz/, 'lint output redacts by omission');
    assert.doesNotMatch(res.stderr, /upstreamfixture12345/, 'upstream fixture text never leaks');
  }
  // QA scratch left behind by older runs (a Chrome profile-<n>, a mkdtemp workspace-XXXXXX) is not evidence and is not
  // walked; an evidence dir that merely starts with "workspace-" still is.
  fs.mkdirSync(path.join(tmp, 'scratch', 'profile-1761600000000', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'scratch', 'profile-1761600000000', 'Default', 'Prefs'), 'key=sk-or-v1-chromescratch12345\n');
  fs.mkdirSync(path.join(tmp, 'scratch', 'workspace-a1B2c3'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'scratch', 'workspace-a1B2c3', 'agent.secrets.json'), 'key=sk-or-v1-seedscratch123456\n');
  {
    const res = spawnSync(process.execPath, [script, path.relative(ROOT, path.join(tmp, 'scratch'))], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /OK/);
  }
  fs.mkdirSync(path.join(tmp, 'scratch', 'workspace-before-restart'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'scratch', 'workspace-before-restart', 'boot.log'), 'key=sk-or-v1-realevidence12345\n');
  fs.mkdirSync(path.join(tmp, 'scratch', 'profile-notes'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'scratch', 'profile-notes', 'run.log'), 'key=sk-or-v1-realevidence67890\n');
  {
    const res = spawnSync(process.execPath, [script, path.relative(ROOT, path.join(tmp, 'scratch'))], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(res.stderr, /workspace-before-restart/, 'evidence named like scratch is still scanned');
    assert.match(res.stderr, /profile-notes/, 'only profile-<digits> is a Chrome scratch profile');
    assert.doesNotMatch(res.stderr, /chromescratch|seedscratch|profile-1761600000000|workspace-a1B2c3/, 'scratch dirs are skipped');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('lint-evidence-secrets.test: OK (14 assertions)');
