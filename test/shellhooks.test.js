/* node test/shellhooks.test.js — THE SHELL-HOOK BRIDGE.

   Turns a line of config into a handler on the hook spine, speaking the reference harness's wire protocol
   exactly so a Commander's existing hook scripts port unchanged. Uses REAL child processes (node -e) rather
   than a faked spawn, because the whole point of this module is the process boundary: stdin JSON in, stdout
   JSON out, no shell, bounded, and never fatal. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { makeHooks } = require('../sidecar/hooks.js');
const { makeShellHooks, _internals } = require('../sidecar/shellhooks.js');

const DIR = path.join(os.tmpdir(), 'starnet-shellhooks-' + process.pid);
const HOOKS = path.join(DIR, 'hooks.json');
const ALLOW = path.join(DIR, 'allow.json');
const NODE = JSON.stringify(process.execPath);

// A hook script written as `node -e "<program>"`, which is what a real one looks like from this module's side.
const script = (program) => NODE + ' -e ' + JSON.stringify(program);
const writeHooks = (hooks) => fsp.writeFile(HOOKS, JSON.stringify({ hooks }, null, 2), 'utf8');
const mk = (extra) => makeShellHooks(Object.assign({ spawn, fsp, pathMod: path, hooksFile: HOOKS, allowFile: ALLOW, cwd: DIR, timeoutMs: 8000 }, extra || {}));

(async () => {
  await fsp.mkdir(DIR, { recursive: true });
  try {
    // ---- 1. ARG SPLITTING WITHOUT A SHELL. The command never reaches a shell, so this is the only parser. ----
    {
      const s = _internals.splitArgs;
      A.eq(s('node guard.js'), ['node', 'guard.js'], 'plain words split');
      A.eq(s('node "my guard.js"'), ['node', 'my guard.js'], 'double quotes hold a space together');
      A.eq(s("node 'my guard.js'"), ['node', 'my guard.js'], 'single quotes too');
      A.eq(s('node a\\ b'), ['node', 'a b'], 'a backslash escapes a space outside quotes');
      A.eq(s('prettier --write ""'), ['prettier', '--write', ''], 'an explicitly empty argument survives');
      let threw = false;
      try { s('node "unterminated'); } catch (_) { threw = true; }
      A.ok(threw, 'an unbalanced quote is an ERROR — guessing at a half-quoted command is how you run something the Commander did not write');
      // The shell metacharacters are DATA here, never operators. This is the injection guarantee.
      A.eq(s('echo a;rm -rf /'), ['echo', 'a;rm', '-rf', '/'], 'a `;` is just a character in an argument — no shell, no second command');
      A.eq(s('echo $HOME'), ['echo', '$HOME'], 'no variable expansion happens');
    }

    // ---- 2. CONSENT: a configured hook does NOT run until it is explicitly allowed ----
    {
      await fsp.rm(ALLOW, { force: true });
      await writeHooks([{ event: 'pre_tool_call', command: script('console.log(JSON.stringify({decision:"block",reason:"nope"}))'), name: 'blocker' }]);
      const sh = mk();
      const spine = makeHooks();
      const r = await sh.install(spine);
      A.eq(r.installed.length, 0, 'an un-allowed hook is NOT installed');
      A.eq(r.pending.length, 1, 'it is reported as waiting on the Commander, not dropped silently');
      A.eq((await spine.invoke('pre_tool_call', {})).blocked, false, 'and it cannot block anything while pending');
      A.eq((await sh.listPending()).length, 1, 'listPending surfaces it for an approval affordance');
    }

    // ---- 3. ONCE ALLOWED IT RUNS, AND IT CAN BLOCK — the whole point of the feature ----
    {
      const sh = mk();
      const { hooks } = await sh.load();
      await sh.allow(hooks[0].event, hooks[0].command);
      const spine = makeHooks();
      const r = await sh.install(spine);
      A.eq(r.installed.length, 1, 'an allowed hook installs');
      const v = await spine.invoke('pre_tool_call', { tool_name: 'shell_exec', tool_input: { command: 'rm -rf /' } });
      A.eq(v.blocked, true, 'a real child process blocked a real tool call');
      A.eq(v.reason, 'nope', 'and its reason reached the spine');
    }

    // ---- 4. APPROVAL IS KEYED TO THE COMMAND, so editing an approved hook re-asks ----
    {
      await writeHooks([{ event: 'pre_tool_call', command: script('console.log(JSON.stringify({decision:"block",reason:"EDITED"}))'), name: 'blocker' }]);
      const sh = mk();
      const r = await sh.install(makeHooks());
      A.eq(r.installed.length, 0, 'changing the command of an allowed hook revokes its approval');
      A.eq(r.pending.length, 1, 'the edited hook is pending again — one character must not inherit trust');
    }

    // ---- 5. THE WIRE PROTOCOL a ported script depends on ----
    {
      await fsp.rm(ALLOW, { force: true });
      const echo = script('let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const p=JSON.parse(b);console.log(JSON.stringify({context:"saw "+p.hook_event_name+" "+p.tool_name+" "+p.tool_input.path+" sess="+p.session_id}))})');
      await writeHooks([{ event: 'pre_llm_call', command: echo, name: 'echo' }]);
      const sh = mk();
      const spine = makeHooks();
      await sh.install(spine, { accept: true });
      const v = await spine.invoke('pre_llm_call', { tool_name: 'fs_write', tool_input: { path: 'a.js' }, session_id: 's1' });
      A.eq(v.context, 'saw pre_llm_call fs_write a.js sess=s1', 'the full payload reaches the script on stdin and its context comes back');
      A.eq((await sh.listPending()).length, 0, 'accept:true is the headless escape hatch and it PERSISTS the approval');
    }

    // ---- 6. NEVER FATAL. A hook is the Commander's code and it will be broken sometimes. ----
    {
      const cases = [
        ['prints nothing at all', script('')],
        ['prints non-JSON', script('console.log("hello there")')],
        ['exits non-zero', script('process.exit(3)')],
        ['crashes', script('throw new Error("boom")')],
        ['does not exist', 'definitely-not-a-real-binary-xyz --go']
      ];
      for (const [label, cmd] of cases) {
        await fsp.rm(ALLOW, { force: true });
        await writeHooks([{ event: 'pre_tool_call', command: cmd, name: label }]);
        const spine = makeHooks();
        await mk({ onError: () => {} }).install(spine, { accept: true });
        const v = await spine.invoke('pre_tool_call', { tool_name: 't' });
        A.eq(v.blocked, false, 'a hook that ' + label + ' does not block the run');
      }
    }

    // ---- 7. A WEDGED HOOK CANNOT HANG THE STATION ----
    {
      await fsp.rm(ALLOW, { force: true });
      await writeHooks([{ event: 'pre_tool_call', command: script('setTimeout(()=>{},60000)'), name: 'wedged' }]);
      const spine = makeHooks();
      await mk({ timeoutMs: 300, onError: () => {} }).install(spine, { accept: true });
      const t0 = Date.now();
      const v = await spine.invoke('pre_tool_call', {});
      A.ok(Date.now() - t0 < 3000, 'the wedged child is killed at its timeout (' + (Date.now() - t0) + 'ms)');
      A.eq(v.blocked, false, 'and the run continues');
    }

    // ---- 7b. A KILLED HOOK IS WAITED FOR (bounded), AN EXITED ONE IS NOT ----
    // On Windows a just-killed child still holds its cwd for a moment; settling the instant kill() returns let the
    // caller's rm of that directory hit EBUSY. A fake child pins the timing: it exits a set lag after kill().
    {
      const { EventEmitter } = require('events');
      const fakeChild = (exitLag) => {
        const c = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
        c.stdin = Object.assign(new EventEmitter(), { end() {} });
        c.kill = () => { if (exitLag != null) setTimeout(() => { c.emit('exit', null, 'SIGTERM'); c.emit('close'); }, exitLag); };
        return c;
      };
      const run = (child, timeoutMs) => mk({ spawn: () => child, timeoutMs, onError: () => {} })._internals.runScript({ name: 'fake', command: 'fake' }, {});
      let t0 = Date.now();
      A.eq(await run(fakeChild(200), 50), null, 'a timed-out hook still settles null');
      let dt = Date.now() - t0;
      A.ok(dt >= 230, 'it settles only once the killed child has exited (' + dt + 'ms)');
      t0 = Date.now();
      await run(fakeChild(null), 50);
      dt = Date.now() - t0;
      A.ok(dt >= 500 && dt < 2000, 'a child that never exits is waited for 500ms at most (' + dt + 'ms)');
      // The close path is checked by ORDER, not by a wall-clock bound a RAM-starved gate box could overrun: it must
      // settle before a sentinel set just under the kill-settle wait fires.
      const quick = fakeChild(null);
      let sentinelFired = false;
      const sentinel = setTimeout(() => { sentinelFired = true; }, _internals.KILL_SETTLE_MS - 20);
      setTimeout(() => { quick.stdout.emit('data', Buffer.from('{"ok":1}')); quick.emit('exit', 0); quick.emit('close'); }, 20);
      A.eq(JSON.stringify(await run(quick, 5000)), '{"ok":1}', 'the ordinary close path returns the verdict');
      clearTimeout(sentinel);
      A.ok(!sentinelFired, 'and settles at once, with no kill wait (before the ' + (_internals.KILL_SETTLE_MS - 20) + 'ms sentinel)');

      // ---- 7c. THE SAME WAIT HOLDS THROUGH THE SPINE, which is how every production hook runs ----
      // The spine bounds each handler with its own timer, started before runScript. If that bound were the hook's
      // timeoutMs it would always win, invoke() would return null at once, and the caller would rm the cwd while
      // the killed child still held it. invoke() must not resolve before the killed child has exited.
      await fsp.rm(ALLOW, { force: true });
      await writeHooks([{ event: 'pre_tool_call', command: 'fake-hook', name: 'fake' }]);
      let exitedAt = 0;
      const slowDie = fakeChild(300);
      slowDie.once('exit', () => { exitedAt = Date.now(); });
      const spine = makeHooks();
      const sh = mk({ spawn: () => slowDie, timeoutMs: 50, onError: () => {} });
      await sh.install(spine, { accept: true });
      const vSpine = await spine.invoke('pre_tool_call', {});
      const resolvedAt = Date.now();
      A.eq(vSpine.blocked, false, 'a timed-out hook through the spine does not block');
      A.ok(exitedAt > 0 && exitedAt <= resolvedAt, 'spine.invoke() resolves only after the killed child has exited (exited ' + (exitedAt ? resolvedAt - exitedAt + 'ms before resolve' : 'never') + ')');
      A.ok(sh._internals.spineBoundMs > 50 + _internals.KILL_SETTLE_MS, 'the spine bound covers timeout + kill-settle (' + sh._internals.spineBoundMs + 'ms)');

      // ---- 7d. A SLOW spawn() DOES NOT HAND THE SPINE THE RACE ----
      // The spine's timer starts before runScript; if runScript armed its own timeout only after spawn() returned, a
      // spawn that blocked ~400ms (a RAM-starved box) pushed our kill + settle past the spine's backstop, and invoke()
      // returned while the killed child still held its cwd. The fake spawn blocks the thread for 400ms, then hands back
      // a child that takes 450ms to die after kill(): invoke() must still resolve only after that child has exited.
      await fsp.rm(ALLOW, { force: true });
      let slowExitAt = 0;
      const slowSpawnChild = fakeChild(450);
      slowSpawnChild.once('exit', () => { slowExitAt = Date.now(); });
      const slowSpawn = () => { const until = Date.now() + 400; while (Date.now() < until) { /* spawn() blocking under memory pressure */ } return slowSpawnChild; };
      const spine2 = makeHooks();
      await mk({ spawn: slowSpawn, timeoutMs: 50, onError: () => {}, clock: { now: () => Date.now() } }).install(spine2, { accept: true });
      const vSlow = await spine2.invoke('pre_tool_call', {});
      const slowResolvedAt = Date.now();
      A.eq(vSlow.blocked, false, 'a timed-out hook behind a slow spawn does not block');
      A.ok(slowExitAt > 0 && slowExitAt <= slowResolvedAt, 'spine.invoke() resolves only after the killed child has exited, even when spawn() took 400ms (exited ' + (slowExitAt ? slowResolvedAt - slowExitAt + 'ms before resolve' : 'never') + ')');
    }

    // ---- 8. ONE BAD ENTRY MUST NOT DISABLE THE REST OF THE FILE ----
    {
      await fsp.rm(ALLOW, { force: true });
      await writeHooks([
        { event: 'pre_tool_call' },                                   // no command
        { event: '', command: 'node x.js' },                          // no event
        { event: 'pre_tool_call', command: 'node "unbalanced' },      // unparseable
        { event: 'post_tool_call', command: script('') , name: 'good' }
      ]);
      const { hooks, errors } = await mk().load();
      A.eq(hooks.length, 1, 'the one valid hook survives three broken siblings');
      A.eq(hooks[0].name, 'good', 'and it is the right one');
      A.eq(errors.length, 3, 'every rejected entry is REPORTED, not silently dropped');
    }

    // ---- 9. an unknown event name is a reported registration failure, not a hook that never fires ----
    {
      await fsp.rm(ALLOW, { force: true });
      await writeHooks([{ event: 'on_whatever', command: script(''), name: 'ghost' }]);
      const r = await mk({ onError: () => {} }).install(makeHooks(), { accept: true });
      A.eq(r.installed.length, 0, 'a hook on a non-existent event is not installed');
      A.ok(r.errors.some(e => /on_whatever|cannot register/.test(e)), 'and the Commander is told why');
    }

    // ---- 9b. REVOKE — the other half of the gate ----
    {
      await fsp.rm(ALLOW, { force: true });
      const cmd = script('');
      await writeHooks([{ event: 'post_tool_call', command: cmd, name: 'revocable' }]);
      const sh = mk();
      await sh.install(makeHooks(), { accept: true });
      A.eq((await sh.listPending()).length, 0, 'approved -> not pending');

      A.eq(await sh.revoke('post_tool_call', cmd), true, 'revoke reports that it removed the approval');
      A.eq((await sh.listPending()).length, 1, 'the hook is pending again');
      const spine = makeHooks();
      A.eq((await sh.install(spine)).installed.length, 0, 'and a re-install leaves it CONFIGURED BUT INERT — revoking disarms, it does not delete the line');
      A.eq(spine.count('post_tool_call'), 0, 'nothing is registered on the spine for it');
      A.eq(await sh.revoke('post_tool_call', cmd), false, 'revoking what is already un-approved is an honest false');
      A.eq(await sh.revoke('pre_tool_call', 'never configured'), false, 'and so is revoking something that was never approved');
    }

    // ---- 9c. AUTHORING. Without create() the feature was unreachable: "make a hook" meant "find a folder
    //          and hand-write JSON". A hook TYPED INTO THE STATION is consented by the act of typing it. ----
    {
      await fsp.rm(ALLOW, { force: true });
      await fsp.rm(HOOKS, { force: true });
      const sh = mk();
      const cmd = script('');
      const made = await sh.create({ event: 'post_tool_call', command: cmd, name: 'formatter' });
      A.eq(made.ok, true, 'create() writes the hook');
      A.eq((await sh.listPending()).length, 0, 'and AUTO-APPROVES it — asking the author to approve their own keystrokes is theatre');
      const spine = makeHooks();
      A.eq((await sh.install(spine)).installed.length, 1, 'so it installs and runs immediately');

      A.eq((await sh.create({ event: 'post_tool_call', command: cmd, name: 'dupe' })).ok, false, 'the exact same hook cannot be added twice');
      A.eq((await sh.create({ event: 'post_tool_call', command: '' })).ok, false, 'a hook with no command is refused');
      A.eq((await sh.create({ event: 'post_tool_call', command: 'node "unbalanced' })).ok, false, 'an unparseable command is refused at the door, not at run time');

      // DELETE removes the LINE — the thing revoke deliberately does not do.
      A.eq(await sh.remove('post_tool_call', cmd), true, 'remove() reports the deletion');
      A.eq((await sh.load()).hooks.length, 0, 'the line is gone from hooks.json');
      A.eq(Object.keys(JSON.parse(await fsp.readFile(ALLOW, 'utf8'))).length, 0,
        'and its approval went with it — an orphan approval would be silently inherited by the next hook with that command');
      A.eq(await sh.remove('post_tool_call', cmd), false, 'deleting what is gone is an honest false');
    }

    // ---- 10. a missing hooks file is the ordinary case: no hooks, no errors, no noise ----
    {
      const sh = makeShellHooks({ spawn, fsp, pathMod: path, hooksFile: path.join(DIR, 'nope.json'), allowFile: ALLOW, cwd: DIR });
      const { hooks, errors } = await sh.load();
      A.eq(hooks.length, 0, 'no hooks file -> no hooks');
      A.eq(errors.length, 0, 'and no complaints — most stations will never write one');
    }
  } finally { await fsp.rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }

  A.report('shellhooks.test');
})().catch(async (e) => {
  try { await fsp.rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e2) { console.log('shellhooks.test: teardown rm failed: ' + (e2 && e2.code || e2)); }
  console.log('FAIL: shellhooks.test threw -- ' + (e && e.stack || e));
  process.exit(1);
});
