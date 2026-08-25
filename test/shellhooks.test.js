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
  /* RETRY THE TEARDOWN, DON'T JUST FORCE IT (2026-08-25, Windows). This file spawns REAL child
     processes with cwd: DIR — that is the point of the module under test — and on Windows a live
     process's working directory is LOCKED, so rmdir fails with EBUSY until the last child is fully
     gone. `force: true` does not cover that: it suppresses ENOENT, not EBUSY. Under load the children
     exit slower, the rm throws, and the throw escapes to the catch below — turning THE merge gate red
     on a test whose assertions all passed. Seen exactly once in a full run, and 0/12 in isolation,
     which is the signature of a load-dependent race rather than a broken test.
     maxRetries is Node's built-in answer, and it retries precisely the Windows codes at fault
     (EBUSY/EPERM/ENOTEMPTY/EMFILE/ENFILE). Error path only: when the dir is free it behaves as before. */
  } finally { await fsp.rm(DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }

  A.report('shellhooks.test');
})().catch(async (e) => {
  try { await fsp.rm(DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch (_) {}
  console.log('FAIL: shellhooks.test threw -- ' + (e && e.stack || e));
  process.exit(1);
});
