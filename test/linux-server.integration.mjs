// Opt-in integration check: run as ExecStartPre inside starnet-server.service.
// See docs/LINUX_SERVER.md. This needs real systemd filesystem/privilege isolation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

assert.equal(process.platform, 'linux');
assert.equal(os.userInfo().username, 'starnet');
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^NoNewPrivs:\s+1$/m);
assert.equal(process.umask(), 0o077);
assert.equal(process.env.HOME, '/var/lib/starnet');
assert.equal(fs.statSync('/var/lib/starnet').mode & 0o777, 0o700);
assert.throws(() => fs.readdirSync('/home'), error => error.code === 'EACCES');
assert.throws(() => fs.readdirSync('/root'), error => error.code === 'EACCES');

// Probe effects, not the unit's text. Remove an unexpected successful write before failing.
for (const root of ['/etc', '/opt/starnet-server']) {
  const file = path.join(root, 'starnet-write-probe-' + process.pid);
  let denied = false;
  try { fs.writeFileSync(file, 'synthetic deployment test', { flag: 'wx' }); }
  catch (error) {
    if (!['EACCES', 'EROFS'].includes(error.code)) throw error;
    denied = true;
  } finally { if (!denied) fs.rmSync(file, { force: true }); }
  assert.ok(denied, root + ' must not be writable');
}

const scratch = fs.mkdtempSync('/var/lib/starnet/deployment-test-');
try {
  assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);
  const git = (...args) => execFileSync('git', args, {
    cwd: scratch, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']
  });
  git('init', '--bare', 'origin.git');
  git('clone', path.join(scratch, 'origin.git'), 'agent-repo');
  const file = path.join(scratch, 'agent-repo', 'check.txt');
  fs.writeFileSync(file, 'synthetic Git work\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  git('-C', 'agent-repo', 'add', 'check.txt');
  git('-C', 'agent-repo', '-c', 'user.name=StarNet Deployment Test',
    '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Check isolated Git work');
  git('-C', 'agent-repo', 'push', 'origin', 'HEAD:refs/heads/check');
  assert.equal(git('--git-dir=origin.git', 'show', 'check:check.txt'), 'synthetic Git work\n');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
console.log('Linux server isolation and Git integration: PASS');
