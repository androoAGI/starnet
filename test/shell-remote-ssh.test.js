/* node test/shell-remote-ssh.test.js — shell.exec on a REMOTE SSH agent (2026-10-19 live proof follow-up).
   Proves, through the real tool against a fake SSH environment:
     · the remote workspace is the clamp — an ASK-mode agent's absolute path outside it, ~, $HOME or a bare `cd` is
       refused (the live proof listed the remote user's whole Desktop), while in-workspace paths, device nodes,
       system programs and quoted sed/grep patterns still run;
     · Full Power on a remote agent (host-minted ctx.remoteHostFull) lifts that clamp ON THAT MACHINE;
     · a remote boundary (dropped connection / our own timeout) is an error that says the command STARTED and its
       outcome is unknown — never "the host KILLED it", which nothing over SSH can prove. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

const ROOT_REMOTE = '/home/u/ws';
const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-shell-ssh-'));
const marker = (cwd, ec) => '\n__SK_CWD__' + cwd + '__SK_EC__' + ec + '__SK_END__';
const calls = [];
let next = null;
const environment = {
  backendIdFor: () => 'ssh',
  describeAgent: () => ({ backend: 'ssh', remote: { configured: true, remoteRoot: ROOT_REMOTE } }),
  refusalFor: () => null,
  ensureWorkspace: () => mirror,
  workspaceRoot: () => mirror,
  getCwd: () => ROOT_REMOTE,
  rememberCwd: () => ROOT_REMOTE,
  execute: async (o) => {
    calls.push(o);
    const r = next || { out: 'ok' + marker(ROOT_REMOTE, 0), exitCode: 0, ms: 3 };
    next = null;
    return Object.assign({ fullOut: r.out }, r);
  }
};
const tool = makeShellTool({ spawn: () => { throw new Error('a remote agent never spawns locally'); }, fs, pathMod: path, root: mirror, redact: s => s, environment }).execTool;

async function outcome(cmd, ctx) {
  const before = calls.length;
  try { await tool.run({ cmd }, Object.assign({ agentId: 'nova' }, ctx || {})); return { ran: calls.length > before }; }
  catch (e) { return { ran: calls.length > before, error: String(e && e.message || e), summary: e && e.toolSummary }; }
}

(async () => {
  // ---- the remote folder is the clamp (ASK) ----
  for (const cmd of ['ls /c/Users/andro/Desktop', 'cat /etc/passwd', "cat '/etc/passwd'", 'cp x "/home/u/other/y"', 'ls /', 'cd ~ && ls', 'cat ~/.ssh/id_ed25519', 'echo $HOME', 'tar -cf ${HOME}/a.tar .', 'cd && ls', 'make --prefix=/usr/local']) {
    const r = await outcome(cmd);
    A.ok(!r.ran && /^refused: /.test(r.error || ''), 'ASK refuses an escape from the remote workspace: ' + cmd);
  }
  const abs = await outcome('ls /c/Users/andro/Desktop');
  A.ok(/outside this agent's workspace on the remote machine \(\/home\/u\/ws\)/.test(abs.error), 'the refusal names the remote workspace it must stay in');
  for (const cmd of ['ls /home/u/ws/src', 'cat notes.txt > /dev/null', '/usr/bin/env python3 run.py', "sed -e '/^#/d' conf.txt", "grep -rn '/api/users' .", 'curl -s https://example.com/a/b', 'git log --oneline HEAD~3', 'echo $PWD', 'npm test 2>/dev/stderr']) {
    const r = await outcome(cmd);
    A.ok(r.ran && !r.error, 'ASK still runs ordinary in-workspace work: ' + cmd);
  }
  // ---- Full Power on a remote agent lifts the clamp ON THAT MACHINE ----
  for (const cmd of ['cat /etc/hosts', 'ls ~', 'ls ../..']) {
    const r = await outcome(cmd, { remoteHostFull: true });
    A.ok(r.ran && !r.error, 'remote Full Power runs it on the remote machine: ' + cmd);
  }
  const forged = await outcome('cat /etc/hosts', { remoteHostFull: 'true' });
  A.ok(!forged.ran, 'only the host-minted boolean lifts the clamp');

  // ---- a remote boundary is "outcome unknown", never a kill ----
  next = { out: 'half way', exitCode: 255, ms: 9, remoteBoundary: 'foreground SSH transport exited 255 before the command finished (the connection ended, or the remote process was killed); the command STARTED on the remote machine and may still be running there or may already have finished — check the remote state before running it again' };
  const lost = await outcome("sh deploy.sh");
  A.ok(lost.ran && /^REMOTE OUTCOME UNKNOWN: /.test(lost.error) && /STARTED on the remote machine/.test(lost.error) && /half way/.test(lost.error), 'a dropped connection is an error that says the command started and its outcome is unknown');
  A.eq(lost.summary, 'connection lost · remote outcome unknown', 'the tool card summary names the unknown outcome');
  next = { out: 'still going', exitCode: -1, ms: 30000, timedOut: true, remoteBoundary: 'the command reached its timeout and StarNet closed the SSH connection before it finished; the command STARTED on the remote machine and may still be running there or may already have finished — check the remote state before running it again' };
  const slow = await outcome("sh long.sh");
  A.ok(/^REMOTE OUTCOME UNKNOWN: /.test(slow.error) && !/KILLED/.test(slow.error), 'a remote timeout never claims the host killed the process tree');
  A.eq(slow.summary, 'timeout · remote outcome unknown', 'timeout summary keeps the unknown remote outcome');

  fs.rmSync(mirror, { recursive: true, force: true });
  A.report('shell-remote-ssh.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
