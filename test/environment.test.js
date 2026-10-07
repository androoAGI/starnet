/* node test/environment.test.js - execution backend boundary.

   No real Docker/process dependency: fake child handles prove the manager's
   contract deterministically while keeping test:fast hermetic.
*/
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { makeEnvironmentManager } = require('../sidecar/environment.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

function makeFakeSpawn() {
  const calls = [];
  function spawn(file, argsOrOpts, maybeOpts) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { writes: [], ended: false, write: function (value) { this.writes.push(String(value)); }, end: function () { this.ended = true; } };
    child.pid = 4242 + calls.length;
    child.killed = false;
    child.kill = function () { child.killed = true; };
    const call = {
      file,
      args: Array.isArray(argsOrOpts) ? argsOrOpts.slice() : null,
      opts: Array.isArray(argsOrOpts) ? (maybeOpts || {}) : (argsOrOpts || {}),
      child
    };
    calls.push(call);
    const next = spawn.queue.length ? spawn.queue.shift() : { out: 'ok\n', code: 0 };
    setImmediate(function () {
      if (next.out) child.stdout.emit('data', Buffer.from(next.out));
      child.emit('close', next.code);
    });
    return child;
  }
  spawn.calls = calls;
  spawn.queue = [];
  spawn.setNext = function (out, code) { spawn.queue.push({ out: out, code: code == null ? 0 : code }); };
  return spawn;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-env-'));
  let now = 0;
  const clock = { now: () => now };

  try {
    // ---- local backend: old host-shell behavior remains behind the new seam ----
    {
      const spawn = makeFakeSpawn();
      const bgCalls = [];
      const bg = {
        start: (o) => { bgCalls.push(o); return { ok: true, bgId: 'bg_1' }; },
        status: () => [],
        kill: () => ({ ok: true })
      };
      const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root, bg, clock,
        env: { PATH: 'safe-path', SKYNET_API_TOKEN: 'api-secret', STARNET_IPC_TOKEN: 'ipc-secret', OPENAI_API_KEY: 'provider-secret', TELEGRAM_BOT_TOKEN: 'channel-secret', STARNET_COMPUTER_DRIVER: '1', NODE_OPTIONS: '--require evil.js' },
        config: { backend: 'local' } });
      A.eq(env.backendId, 'local', 'local backend selected');
      await env.execute({ agentId: 'a1', cmd: 'echo ok', timeoutMs: 1000 });
      A.eq(spawn.calls[0].file, 'echo ok', 'local executes command through shell string');
      A.eq(spawn.calls[0].opts.shell, true, 'local uses shell:true');
      A.eq(spawn.calls[0].opts.cwd, path.join(root, 'a1'), 'local cwd is the per-agent workspace');
      A.eq(spawn.calls[0].opts.env.PATH, 'safe-path', 'safe build environment survives');
      A.ok(!('SKYNET_API_TOKEN' in spawn.calls[0].opts.env) && !('STARNET_IPC_TOKEN' in spawn.calls[0].opts.env), 'sidecar API/IPC tokens never reach task children');
      A.ok(!('OPENAI_API_KEY' in spawn.calls[0].opts.env) && !('TELEGRAM_BOT_TOKEN' in spawn.calls[0].opts.env), 'provider/channel secrets never reach task children');
      A.ok(!('NODE_OPTIONS' in spawn.calls[0].opts.env), 'ambient execution hooks never reach task children');
      A.eq(spawn.calls[0].opts.env.STARNET_COMPUTER_DRIVER, '0', 'physical-input disable is pinned in task children');
      A.eq(spawn.calls[0].opts.env.STARNET_BROWSER_HEADLESS, '1', 'headless browser mode is pinned in task children');
      A.eq(spawn.calls[0].opts.env.STARNET_USER_CONTROL_MODE, 'preserve', 'user-control preservation mode is pinned');
      fs.mkdirSync(path.join(root, 'a1', 'sub'), { recursive: true });
      env.rememberCwd('a1', path.join(root, 'a1', 'sub'));
      A.eq(env.getCwd('a1'), path.join(root, 'a1', 'sub'), 'local persists in-jail cwd');
      env.rememberCwd('a1', path.join(root, 'outside'));
      A.eq(env.getCwd('a1'), path.join(root, 'a1', 'sub'), 'local refuses out-of-jail cwd persistence');
      env.startBackground({ agentId: 'a1', cmd: 'npm run dev' });
      A.eq(bgCalls[0].cwd, path.join(root, 'a1', 'sub'), 'background local inherits backend cwd');
      A.eq(bgCalls[0].env.STARNET_COMPUTER_DRIVER, '0', 'background processes receive the same safety pins');
      A.ok(!('SKYNET_API_TOKEN' in bgCalls[0].env), 'background processes receive no sidecar token');
    }

    // ---- docker backend: creates and reuses one hardened per-agent environment ----
    {
      const spawn = makeFakeSpawn();
      const bgCalls = [];
      const bg = {
        start: (o) => { bgCalls.push(o); return { ok: true, bgId: 'bg_docker' }; },
        status: () => [], read: () => ({ ok: true }), write: () => ({ ok: true }), closeStdin: () => ({ ok: true }), kill: () => ({ ok: true }), killAll: () => 0
      };
      const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root, clock, bg, config: {
        backend: 'docker',
        dockerBin: 'dockerx',
        dockerImage: 'starnet-node:test',
        dockerNetwork: 'none',
        dockerCpus: '2',
        dockerMemory: '1g',
        dockerExtraArgs: ['--hostname', 'starnet-test']
      } });
      spawn.setNext('missing\n', 1);       // inspect: first use has no container
      spawn.setNext('container-id\n', 0);  // create
      spawn.setNext('container-name\n', 0);// start
      spawn.setNext('starnet-ready', 0);   // startup probe
      spawn.setNext('/workspace\n', 0);    // command
      await env.execute({ agentId: 'a2', cmd: 'pwd', timeoutMs: 1000 });
      const c = spawn.calls.find(x => x.args && x.args[0] === 'create');
      A.eq(c.file, 'dockerx', 'docker backend invokes configured docker binary');
      A.ok(c.args.indexOf('create') >= 0 && c.args.indexOf('--rm') < 0, 'docker creates a durable named container');
      A.ok(c.args.indexOf('--name') >= 0 && /^starnet-[a-f0-9]{8}-[a-f0-9]{8}-a2$/.test(c.args[c.args.indexOf('--name') + 1]), 'container identity is deterministic and scoped to workspace plus agent');
      A.ok(c.args.indexOf('ai.starnet.managed=1') >= 0 && c.args.indexOf('ai.starnet.agent=a2') >= 0, 'container carries ownership labels');
      A.ok(c.args.indexOf('--cap-drop') >= 0 && c.args.indexOf('ALL') >= 0, 'docker drops capabilities');
      A.ok(c.args.indexOf('no-new-privileges') >= 0, 'docker enables no-new-privileges');
      A.ok(c.args.indexOf('--network') >= 0 && c.args[c.args.indexOf('--network') + 1] === 'none', 'docker network policy is configurable');
      A.ok(c.args.indexOf('--hostname') >= 0 && c.args[c.args.indexOf('--hostname') + 1] === 'starnet-test', 'docker extra args pass through as a JSON list');
      A.ok(c.args.indexOf('--volume') >= 0 && /a2:\/workspace$/.test(c.args[c.args.indexOf('--volume') + 1].replace(/\\/g, '/')), 'docker bind-mounts the agent workspace');
      A.ok(c.args.indexOf('--workdir') >= 0 && c.args[c.args.indexOf('--workdir') + 1] === '/workspace', 'docker starts in container workspace');
      A.ok(c.args.indexOf('starnet-node:test') >= 0, 'docker image is configurable');
      const exec = spawn.calls.find(x => x.args && x.args[0] === 'exec' && x.args[x.args.length - 1] === 'pwd');
      A.ok(exec && exec.args.indexOf(c.args[c.args.indexOf('--name') + 1]) >= 0, 'command executes inside the named container');
      A.eq(env.describe().persistence.restartReuse, true, 'descriptor truthfully advertises restart reuse');
      A.eq(env.supports.persistentSession, true, 'backend capability advertises persistent sessions');
      spawn.setNext('installed\n', 0);
      await env.execute({ agentId: 'a2', cmd: 'touch /usr/local/bin/example-package', timeoutMs: 1000 });
      spawn.setNext('found\n', 0);
      await env.execute({ agentId: 'a2', cmd: 'test -e /usr/local/bin/example-package', timeoutMs: 1000 });
      const taskExecs = spawn.calls.filter(x => x.args && x.args[0] === 'exec' && x.args[x.args.length - 1].indexOf('starnet-ready') < 0);
      const taskNames = taskExecs.map(x => x.args[x.args.indexOf('--workdir') + 2]);
      A.ok(taskNames.every(x => x === taskNames[0]), 'successive commands target the same writable container layer');
      A.eq(spawn.calls.filter(x => x.args && x.args[0] === 'create').length, 1, 'successive commands do not recreate the container');
      env.rememberCwd('a2', '/workspace/src');
      A.eq(env.getCwd('a2'), '/workspace/src', 'docker persists container cwd');
      env.rememberCwd('a2', '/etc');
      A.eq(env.getCwd('a2'), '/workspace/src', 'docker refuses out-of-workspace cwd persistence');

      // A fresh manager (sidecar restart) recovers cwd from host-owned state and reuses the labeled container.
      const spawn2 = makeFakeSpawn();
      const label = c.args.find(x => /^ai\.starnet\.workspace=/.test(x)).split('=')[1];
      spawn2.setNext('true\t' + label + '\ta2\n', 0);
      spawn2.setNext('starnet-ready', 0);
      spawn2.setNext('still-here\n', 0);
      const restarted = makeEnvironmentManager({ spawn: spawn2, fs, pathMod: path, root, clock, bg, config: {
        backend: 'docker', dockerBin: 'dockerx', dockerImage: 'starnet-node:test'
      } });
      A.eq(restarted.getCwd('a2'), '/workspace/src', 'container cwd survives sidecar reconstruction');
      await restarted.execute({ agentId: 'a2', cmd: 'printf still-here', timeoutMs: 1000 });
      A.ok(!spawn2.calls.some(x => x.args && x.args[0] === 'create'), 'restart path discovers rather than recreates an owned container');

      spawn.setNext('bg-ready\n', 0);
      const bgResult = await env.startBackground({ agentId: 'a2', cmd: 'node server.js' });
      A.eq(bgResult.bgId, 'bg_docker', 'docker background start uses the shared process manager');
      A.eq(bgCalls[0].file, 'dockerx', 'background child uses argv-form docker exec');
      A.eq(bgCalls[0].args[0], 'exec', 'background process executes inside the persistent container');

      // A local stdio MCP server uses the same owned container, but exact argv rather than sh -lc.
      const mcpChild = env.spawnStdio({ agentId: 'a2', command: 'node', args: ['server.js', '--mode', 'stdio'], cwd: '/workspace/src', env: { SERVICE_TOKEN: 'connector-secret' } });
      A.ok(!!mcpChild, 'isolated stdio spawn returns the docker client child');
      const mcp = spawn.calls[spawn.calls.length - 1];
      A.eq(mcp.file, 'dockerx', 'stdio MCP starts through the configured Docker broker');
      A.eq(mcp.args[0], 'exec', 'stdio MCP is a docker exec child');
      A.eq(mcp.args.indexOf('sh'), -1, 'stdio MCP never inserts a shell');
      A.eq(mcp.args.indexOf('-lc'), -1, 'stdio MCP never inserts a shell command string');
      A.eq(mcp.args[mcp.args.indexOf(c.args[c.args.indexOf('--name') + 1]) + 1], 'node', 'allowlisted command is exact argv after the owned container id');
      A.ok(mcp.args.indexOf('SERVICE_TOKEN') >= 0 && mcp.args.indexOf('connector-secret') < 0, 'connector secret travels by env name, never argv');
      A.eq(mcp.opts.env.SERVICE_TOKEN, 'connector-secret', 'docker client env carries the explicit connector secret');
      A.eq(mcp.opts.env.STARNET_COMPUTER_DRIVER, '0', 'isolated MCP inherits the physical-input hard floor');
      A.eq(mcp.opts.shell, false, 'docker stdio broker explicitly disables shell parsing');
      A.throws(() => env.spawnStdio({ agentId: 'a2', command: 'node', cwd: '/etc' }), 'stdio MCP cwd cannot escape the mounted workspace');

      // Idle cleanup is stop-only and refuses an MCP child that still owns the cell.
      const activeChild = env.spawnStdio({ agentId: 'a2', command: 'node', args: ['active-server.js'] });
      const activeRefusal = await env.cleanupAgent('a2', { remove: false, onlyIfIdle: true });
      A.ok(activeRefusal.refused && /active/.test(activeRefusal.reason), 'idle cleanup refuses an active owned cell');
      activeChild.emit('close', 0);
      await new Promise(resolve => setImmediate(resolve));
      now = 120000;
      spawn.setNext('true\t' + label + '\ta2\n', 0);
      spawn.setNext('stop-failed\n', 1);
      const failedSweep = await env.cleanupIdle(['a2'], { idleMs: 60000, now });
      A.ok(failedSweep.skipped.some(x => x.agentId === 'a2'), 'a failed idle stop is isolated and reported as skipped');
      A.eq(env.describe().persistence.readyAgents, 1, 'a failed idle stop preserves live ownership state for retry');
      spawn.setNext('true\t' + label + '\ta2\n', 0);
      spawn.setNext('stopped\n', 0);
      const swept = await env.cleanupIdle(['a2'], { idleMs: 60000, now });
      A.eq(swept.stopped[0], 'a2', 'idle sweep stops a proven inactive owned cell');
      const stop = spawn.calls.filter(x => x.args && x.args[0] === 'stop').pop();
      A.ok(stop && stop.args.indexOf(c.args[c.args.indexOf('--name') + 1]) >= 0, 'idle sweep targets the deterministic owned container');
      A.ok(!spawn.calls.some(x => x.args && x.args[0] === 'rm' && x.args.indexOf('--force') >= 0), 'idle sweep never deletes a container');
      A.eq(env.describe().idleCleanup.deletesContainers, false, 'descriptor exposes stop-only cleanup truth');

      spawn.setNext('false\t' + label + '\ta2\n', 0);
      spawn.setNext(c.args[c.args.indexOf('--name') + 1] + '\n', 0);
      const cleaned = await env.cleanupAgent('a2');
      A.ok(cleaned.ok && cleaned.removed, 'explicit cleanup removes the owned persistent environment');
      const rm = spawn.calls.filter(x => x.args && x.args[0] === 'rm').pop();
      A.ok(rm.args.indexOf('--force') >= 0 && rm.args.indexOf(c.args[c.args.indexOf('--name') + 1]) >= 0, 'cleanup targets only the deterministic agent container');
      spawn.setNext('true\twrong-workspace\ta2\n', 0);
      let collisionRefused = false; try { await env.cleanupAgent('a2'); } catch (e) { collisionRefused = /collision/.test(String(e.message)); }
      A.ok(collisionRefused, 'cleanup refuses a same-name container without the exact workspace ownership label');
    }

    // ---- SSH backend: strict owner configuration + push/run/pull for a non-bind workspace ----
    {
      const spawn = makeFakeSpawn();
      const target = { configured: true, host: 'buildbox', user: 'andrew', port: 2222, remoteRoot: '/srv/starnet/a4' };
      const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root, clock,
        env: { PATH: 'safe-path', OPENAI_API_KEY: 'ambient-secret' },
        serviceEnv: () => ({ REMOTE_API_KEY: 'explicit-service-secret' }),
        sshConfig: () => target,
        config: { backend: 'ssh', sshBin: 'sshx', scpBin: 'scpx', sshConnectTimeoutSeconds: 7 } });
      A.eq(env.backendId, 'ssh', 'SSH backend selected');
      A.eq(env.supports.hostWorkspace, false, 'SSH truthfully reports no bind-mounted host workspace');
      A.eq(env.supports.workspaceSync, true, 'SSH advertises explicit workspace synchronization');
      A.eq(env.supports.checkpoints, true, 'SSH advertises checkpoints only with verified remote archive and restore support');
      const conflicts = env._backend._internals.syncConflicts;
      A.eq(conflicts(null, { 'same.txt': 'local' }, { 'same.txt': 'remote' }), ['same.txt'], 'first sync refuses an ambiguous two-sided file instead of choosing a winner');
      A.eq(conflicts({ 'same.txt': 'base' }, { 'same.txt': 'local' }, { 'same.txt': 'remote' }), ['same.txt'], 'later sync detects two-sided divergence from its proven baseline');
      A.eq(conflicts({ 'same.txt': 'base' }, { 'same.txt': 'local' }, { 'same.txt': 'base' }), [], 'a one-sided change remains synchronizable');
      const lostIdentity = env._backend._internals.parseJobLine('STARNET_JOB\tsshbg_deadbeef\t700\tlost\t\n', 'job');
      A.ok(lostIdentity.lost && !lostIdentity.running, 'a reused/missing remote pid identity is LOST, never reported running');
      spawn.setNext('starnet-ssh-ready', 0);
      const readyOne = env.ensureReady('a4');
      const readyTwo = env.ensureReady('a4');
      await Promise.all([readyOne, readyTwo]);
      A.eq(spawn.calls.length, 1, 'same-agent SSH operations serialize and concurrent readiness probes reuse one result');
      const probe = spawn.calls[0];
      A.eq(probe.file, 'sshx', 'SSH probe uses the configured client');
      A.eq(probe.opts.shell, false, 'SSH client never runs through a local shell');
      A.ok(probe.args.indexOf('BatchMode=yes') >= 0 && probe.args.indexOf('StrictHostKeyChecking=yes') >= 0, 'SSH is batch-only and fail-closed on unknown host keys');
      A.ok(probe.args.indexOf('andrew@buildbox') >= 0 && probe.args.indexOf('2222') >= 0, 'SSH target uses validated user, host and port argv');
      A.ok(probe.child.stdin.writes.join('').indexOf("mkdir -p '/srv/starnet/a4'") >= 0, 'remote readiness creates only the configured workspace');

      env.rememberCwd('a4', '/srv/starnet/a4/src');
      A.eq(env.getCwd('a4'), '/srv/starnet/a4/src', 'SSH remembers only an in-remote-root cwd');
      env.rememberCwd('a4', '/etc');
      A.eq(env.getCwd('a4'), '/srv/starnet/a4/src', 'SSH refuses a cwd outside the configured remote root');

      spawn.setNext('push-ok', 0);
      spawn.setNext('STARNET_CHECKPOINT\tsshcp_aaaaaaaa\t' + 'a'.repeat(64) + '\t1024\n', 0);
      spawn.setNext('remote-ok', 0);
      spawn.setNext('starnet-sync-safe', 0);
      spawn.setNext('pull-ok', 0);
      const result = await env.execute({ agentId: 'a4', cmd: 'echo remote', timeoutMs: 2000, surface: 'interactive' });
      A.eq(result.out.trim(), 'remote-ok', 'SSH returns the real remote command result');
      A.eq(result.remoteCheckpointId, 'sshcp_aaaaaaaa', 'foreground execution exposes the exact pre-command remote checkpoint');
      const scpCalls = spawn.calls.filter(x => x.file === 'scpx');
      A.eq(scpCalls.length, 2, 'remote command performs one push and one pull');
      A.ok(scpCalls[0].args.indexOf('a4/.') >= 0 && scpCalls[0].args.some(x => /andrew@buildbox:\/srv\/starnet\/a4\/$/.test(x)), 'push copies the local agent workspace to the exact remote root');
      A.ok(scpCalls[1].args.some(x => /andrew@buildbox:\/srv\/starnet\/a4\/\.$/.test(x)) && scpCalls[1].args.indexOf('a4') >= 0, 'pull returns remote outputs to the local agent workspace');
      A.ok(scpCalls.every(x => x.args.indexOf('StrictHostKeyChecking=yes') >= 0 && x.opts.shell === false), 'file sync keeps the same strict host-key and no-local-shell boundary');
      const remoteCall = spawn.calls.find(x => x.file === 'sshx' && x.child.stdin.writes.join('').indexOf('echo remote') >= 0);
      const remoteScript = remoteCall.child.stdin.writes.join('');
      A.ok(remoteScript.indexOf('echo remote') >= 0 && remoteScript.indexOf("cd '/srv/starnet/a4/src'") >= 0, 'remote command runs inside the clamped cwd through stdin');
      A.ok(remoteScript.indexOf("REMOTE_API_KEY='explicit-service-secret'") >= 0, 'explicit service key reaches the remote shell through stdin');
      A.ok(remoteCall.args.join(' ').indexOf('explicit-service-secret') < 0, 'service key never appears in SSH argv');
      A.ok(remoteScript.indexOf("STARNET_COMPUTER_DRIVER='0'") >= 0, 'remote shell receives the physical-input hard floor');
      A.eq(env.describe('a4').sync.state, 'ready', 'descriptor reports the proven sync state');

      spawn.setNext('STARNET_CHECKPOINT\tsshcp_aaaaaaaa\t' + 'a'.repeat(64) + '\t1024\t123\n', 0);
      const remotePoints = await env.listCheckpoints('a4');
      A.eq(remotePoints[0].id, 'sshcp_aaaaaaaa', 'remote checkpoint list returns only verified archive identities');
      spawn.setNext('starnet-checkpoint-restored', 0);
      spawn.setNext('starnet-sync-safe', 0);
      spawn.setNext('pull-ok', 0);
      A.eq(await env.restoreCheckpoint('a4', 'sshcp_aaaaaaaa'), true, 'remote rewind verifies the archive then refreshes the local mirror');

      const linkPath = path.join(root, 'a4', 'escape-link');
      fs.symlinkSync(root, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      let localLinkRefused = false; try { await env.syncWorkspace('a4', { direction: 'push' }); } catch (e) { localLinkRefused = /symbolic links/.test(String(e.message)); }
      A.ok(localLinkRefused, 'workspace push refuses a local symlink before scp can follow it');
      fs.unlinkSync(linkPath);
      spawn.setNext('starnet-sync-symlink', 96);
      let remoteLinkRefused = false; try { await env.syncWorkspace('a4', { direction: 'pull' }); } catch (e) { remoteLinkRefused = /remote tree/.test(String(e.message)); }
      A.ok(remoteLinkRefused, 'workspace pull refuses a remote tree whose symlink boundary cannot be proven');

      const restartedCwd = makeEnvironmentManager({ spawn: makeFakeSpawn(), fs, pathMod: path, root, clock,
        sshConfig: () => target, config: { backend: 'ssh', sshBin: 'sshx', scpBin: 'scpx' } });
      A.eq(restartedCwd.getCwd('a4'), '/srv/starnet/a4/src', 'SSH cwd survives sidecar restart through read-back-verified host state');
      A.eq(restartedCwd.supports.persistentSession, true, 'SSH advertises restart continuity only after cwd and remote jobs are persistent');

      const rejectedFs = Object.create(fs);
      rejectedFs.renameSync = function (from, to) {
        if (/a5\.json$/.test(String(to))) throw new Error('simulated SSH cwd replace failure');
        return fs.renameSync(from, to);
      };
      const rejectedCwd = makeEnvironmentManager({ spawn: makeFakeSpawn(), fs: rejectedFs, pathMod: path, root, clock,
        sshConfig: () => target, config: { backend: 'ssh', sshBin: 'sshx', scpBin: 'scpx' } });
      let cwdWriteRejected = false;
      try { rejectedCwd.rememberCwd('a5', '/srv/starnet/a4/rejected'); } catch (e) { cwdWriteRejected = /replace failure/.test(String(e && e.message)); }
      A.ok(cwdWriteRejected, 'SSH cwd update reports a rejected durable replace');
      A.eq(rejectedCwd.getCwd('a5'), '/srv/starnet/a4', 'a rejected SSH cwd update does not survive in memory');

      spawn.setNext('push-ok', 0);
      spawn.setNext('STARNET_JOB\tsshbg_aaaaaaaa\t700\trunning\t\n', 0);
      const bg = await env.startBackground({ agentId: 'a4', cmd: 'node server.js', cwd: '/srv/starnet/a4/src' });
      A.ok(bg.ok && bg.reattachable && bg.bgId === 'sshbg_aaaaaaaa', 'SSH background start returns a reattachable remote identity');
      const bgStart = spawn.calls.find(x => x.file === 'sshx' && /base64 -d/.test(x.child.stdin.writes.join('')));
      A.ok(bgStart && /\.starnet\/jobs\//.test(bgStart.child.stdin.writes.join('')) && /\/identity/.test(bgStart.child.stdin.writes.join('')), 'remote job metadata includes a process-identity proof under the configured remote workspace');
      const spawnRestart = makeFakeSpawn();
      spawnRestart.setNext('STARNET_JOB\tsshbg_aaaaaaaa\t700\trunning\t\nSTARNET_TAIL\nlistening\n', 0);
      const reattached = makeEnvironmentManager({ spawn: spawnRestart, fs, pathMod: path, root, clock,
        sshConfig: () => target, config: { backend: 'ssh', sshBin: 'sshx', scpBin: 'scpx' } });
      const liveJob = await reattached.statusBackground('a4', 'sshbg_aaaaaaaa');
      A.ok(liveJob && liveJob.running && /listening/.test(liveJob.tail), 'fresh sidecar reattaches to the remote pid and output tail');

      spawn.setNext('push-ok', 0);
      spawn.setNext('STARNET_CHECKPOINT\tsshcp_bbbbbbbb\t' + 'b'.repeat(64) + '\t1024\n', 0);
      spawn.setNext('ssh: Connection reset by peer', 255);
      spawn.setNext('ssh: connect refused', 255);
      let disconnectError = '';
      try { await env.execute({ agentId: 'a4', cmd: 'long-running-command', timeoutMs: 2000 }); } catch (e) { disconnectError = String(e && e.message || e); }
      A.ok(/foreground SSH transport exited 255/.test(disconnectError) && /workspace recovery failed/.test(disconnectError), 'foreground disconnect reports the exact unconfirmed process and recovery boundary');
      A.eq(env.describe('a4').availability.state, 'unavailable', 'transport loss invalidates cached remote readiness');

      const missing = makeEnvironmentManager({ spawn: makeFakeSpawn(), fs, pathMod: path, root, clock, sshConfig: () => null, config: { backend: 'ssh' } });
      let refused = false; try { await missing.ensureReady('missing'); } catch (e) { refused = /not configured/.test(String(e.message)); }
      A.ok(refused, 'SSH refuses execution without an owner-configured target');

      // E-STOP / Quit on a station with no SSH target: nothing to reap, resolved 0 — never a rejection
      // ("SSH target is not configured for agent" landed in customers' diagnostics as an unhandledRejection)
      const missingSpawn = makeFakeSpawn();
      const missingReap = makeEnvironmentManager({ spawn: missingSpawn, fs, pathMod: path, root, clock, sshConfig: () => null, config: { backend: 'ssh' } });
      A.eq(await missingReap.killAllBackground(), 0, 'station-wide SSH reap with no configured target resolves 0');
      A.eq(await missingReap.killAllBackground('missing'), 0, 'per-agent SSH reap for an unconfigured agent resolves 0 (no remote root = no jobs)');
      A.eq(missingSpawn.calls.length, 0, 'an unconfigured reap never spawns ssh');
    }

    // ---- SSH station-wide reap reaches EVERY agent with a configured target, not a fallback "agent" id ----
    {
      const spawn = makeFakeSpawn();
      const targets = {
        a1: { configured: true, host: 'box1', user: 'u', port: 22, remoteRoot: '/srv/one' },
        a2: { configured: true, host: 'box2', user: 'u', port: 22, remoteRoot: '/srv/two' }
      };
      const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root, clock,
        sshConfig: id => targets[id] || null, sshAgentIds: () => ['a1', 'a2', 'ghost'],
        config: { backend: 'ssh', sshBin: 'sshx', scpBin: 'scpx' } });
      spawn.setNext('STARNET_KILLED\t2\n', 0);
      spawn.setNext('STARNET_KILLED\t2\n', 0);
      A.eq(await env.killAllBackground(), 4, 'station-wide reap sums the kills under every configured agent');
      const scripts = spawn.calls.map(c => c.child.stdin.writes.join(''));
      A.eq(spawn.calls.length, 2, 'one ssh reap per configured agent; the unconfigured roster id spawns nothing');
      A.ok(scripts.some(s => s.indexOf("'/srv/one/.starnet/jobs'") >= 0) && scripts.some(s => s.indexOf("'/srv/two/.starnet/jobs'") >= 0), 'each reap runs under that agent\'s own remote root');

      spawn.setNext('STARNET_KILLED\t1\n', 0);
      A.eq(await env.killAllBackground('a1'), 1, 'a per-agent reap still targets only that agent');
      A.ok(spawn.calls[2].child.stdin.writes.join('').indexOf('/srv/one/') >= 0 && spawn.calls.length === 3, 'per-agent reap ran once, on a1');

      // one unreachable host must not reject the station-wide reap (it is fire-and-forget at E-STOP)
      let calls = 0;
      const flaky = makeEnvironmentManager({ fs, pathMod: path, root, clock,
        spawn: function (file, args, opts) { calls++; if (args.indexOf('box2') >= 0 || args.some(a => /box2/.test(String(a)))) throw new Error('spawn ssh ENOENT'); return spawn(file, args, opts); },
        sshConfig: id => targets[id] || null, sshAgentIds: () => ['a1', 'a2'],
        config: { backend: 'ssh', sshBin: 'sshx', scpBin: 'scpx' } });
      spawn.setNext('STARNET_KILLED\t3\n', 0);
      let flakyErr = null, flakyN = null;
      try { flakyN = await flaky.killAllBackground(); } catch (e) { flakyErr = e; }
      A.eq(flakyErr, null, 'a transport failure on one host never rejects the station-wide reap');
      A.eq(flakyN, 3, 'the reachable host is still reaped and counted; the failed one counts 0');
      A.eq(calls, 2, 'both configured hosts were attempted');
    }

    // ---- unavailable Docker is reported as checked failure, never as a ready Safe Cell ----
    {
      const missing = makeEnvironmentManager({
        spawn: () => { throw new Error('spawn docker ENOENT'); }, fs, pathMod: path, root, clock,
        config: { backend: 'docker', dockerBin: 'missing-docker' }
      });
      A.eq(missing.describe().availability.state, 'unknown', 'availability is unknown before the first real probe');
      let refused = false;
      try { await missing.ensureReady('missing'); } catch (_) { refused = true; }
      A.ok(refused, 'missing Docker refuses environment readiness');
      A.eq(missing.describe().availability.state, 'unavailable', 'failed probe is exposed truthfully');
      A.eq(missing.describe().availability.checked, true, 'descriptor distinguishes checked failure from unknown');
    }

    // ---- shell tool: Docker-like environments get POSIX cwd markers, never Windows %CD% markers ----
    {
      let remembered = '';
      const calls = [];
      const fakeEnv = {
        backendId: 'docker',
        ensureWorkspace: (aid) => path.join(root, aid),
        getCwd: () => '/workspace',
        rememberCwd: (_aid, cwd) => { remembered = cwd; },
        execute: (o) => {
          calls.push(o);
          return Promise.resolve({
            out: 'hello\n__SK_CWD__/workspace/app__SK_EC__7__SK_END__',
            exitCode: 0,
            ms: 0,
            truncated: false,
            timedOut: false,
            aborted: false
          });
        }
      };
      const shell = makeShellTool({ environment: fakeEnv, clock, platform: 'win32' }).execTool;
      const r = await shell.run({ cmd: 'cd app; exit 7' }, { agentId: 'a3' });
      A.ok(calls[0].cmd.indexOf('printf "\\n__SK_CWD__%s__SK_EC__%s__SK_END__"') >= 0, 'docker backend uses POSIX marker command');
      A.ok(calls[0].cmd.indexOf('%CD%') < 0, 'docker backend does not inherit Windows marker syntax from host');
      A.eq(remembered, '/workspace/app', 'shell persists container cwd through environment');
      A.ok(/\[exit 7/.test(r.content), 'shell reports marker exit code from environment output');
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  /* ---- the child-env scrub must catch the GLUED secret spellings people actually have ----
     The `_` boundary meant STRIPE_APIKEY / GITHUB_PAT / FOO_ACCESSTOKEN never matched and rode straight
     into every task child's env. StarNet's own KEYS vars always end in _API_KEY, which is why our fixtures
     never showed it. ---- */
  {
    const { sanitizeChildEnv: scrub } = require('../sidecar/environment.js');
    A.eq(typeof scrub, 'function', 'sanitizeChildEnv is reachable (a silently-skipped scrub test is worse than none)');
    {
      const out = scrub({
        OPENAI_API_KEY: 'a', STRIPE_APIKEY: 'b', GITHUB_PAT: 'c', FOO_ACCESSTOKEN: 'd',
        ANTHROPIC_APIKEY: 'e', DB_PASSWORD: 'f',
        PATH: '/usr/bin', PATHEXT: '.EXE', UPDATE_PATH: 'x', LANG: 'en', HOME: '/h'
      });
      for (const k of ['OPENAI_API_KEY', 'STRIPE_APIKEY', 'GITHUB_PAT', 'FOO_ACCESSTOKEN', 'ANTHROPIC_APIKEY', 'DB_PASSWORD'])
        A.eq(out[k], undefined, 'secret-shaped ' + k + ' never reaches a task child');
      for (const k of ['PATH', 'PATHEXT', 'UPDATE_PATH', 'LANG', 'HOME'])
        A.ok(out[k] != null, 'ordinary ' + k + ' still survives (PAT is boundary-anchored, PATH is not a secret)');
    }
  }

  // ---- a multi-byte UTF-8 char split across two 'data' chunks decodes cleanly (no U+FFFD) ----
  // Each Buffer chunk used to be stringified in isolation, so any non-ASCII output crossing a 64KB pipe
  // boundary reached the model as replacement characters — and the corruption persisted downstream.
  {
    const spawn = makeFakeSpawn();
    const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root, bg: { start: () => ({ ok: true }), status: () => [], kill: () => ({ ok: true }) }, clock,
      env: { PATH: 'safe-path' }, config: { backend: 'local' } });
    const before = spawn.calls.length;
    const p = env.execute({ agentId: 'a1', cmd: 'echo check', timeoutMs: 1000 });
    const child = spawn.calls[before].child;
    const check = Buffer.from('✓ passed', 'utf8');      // '✓' is 3 bytes — split it mid-sequence
    child.stdout.emit('data', check.slice(0, 1));
    child.stdout.emit('data', check.slice(1));
    const r = await p;
    A.ok(r.out.indexOf('✓ passed') >= 0, 'the split character reassembles across the chunk boundary');
    A.eq(r.out.indexOf('�'), -1, 'no replacement character reaches the model');
  }

  A.report('environment.test');
})().catch(e => { console.log('FAIL: environment.test threw - ' + (e && e.stack || e)); process.exit(1); });
