/* sidecar/shellhooks.js — THE SHELL-HOOK BRIDGE: the Commander's own scripts, on the station's hook spine.

   This is the ambient half of sidecar/hooks.js. It turns a line of config —

       { "event": "pre_tool_call", "command": "node ./guards/no-force-push.js" }

   — into a handler registered on the spine, and speaks the reference harness's wire protocol EXACTLY, so a
   Commander who already has hook scripts written for that harness drops them in and they work:

     stdin  (JSON)  { hook_event_name, tool_name, tool_input, session_id, cwd, extra }
     stdout (JSON)  { "decision":"block", "reason":"…" }   ← Claude-Code shape
                    { "action":"block",  "message":"…" }   ← canonical shape
                    { "context": "…" }                     ← inject into the next model call
                    anything else / empty                  ← silent no-op

   THE PRIVILEGE BOUNDARY, stated loudly because it is the whole risk of this feature: a shell hook runs
   OUTSIDE the agent's workspace jail, at the STATION's privilege. It has to — its job is often to run the
   Commander's own toolchain on the Commander's own files. That is safe only because a hook is CONFIGURED by
   the Commander rather than authored by the agent, and it is why every (event, command) pair must be
   explicitly allowed before it ever runs. A hooks file can arrive by repo checkout, by config sync, by a
   restored backup — none of those are the Commander deciding, so none of them are consent.

   NO SHELL. The command is split into argv here and spawned with shell:false, so a hooks file can never be a
   shell-injection vector through a crafted command string. A Commander who genuinely wants a pipeline puts it
   in a script and points the hook at the script — the same trade the reference harness makes.

   makeShellHooks({ spawn, fsp, pathMod, hooksFile, allowFile, cwd, clock?, onError? })
     -> { load, install, allow, listPending, _internals } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).shellhooks = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_HOOKS = 32;              // a hooks file is hand-written; this is a runaway guard, not a product limit
  const MAX_STDOUT_BYTES = 64000;    // a hook answers with a small verdict; anything more is a misconfiguration
  const KILL_SETTLE_MS = 500;        // how long a timed-out, killed hook may take to actually exit before we settle anyway
  /* The spine's backstop bound sits this far past our own timeout + settle. It is WIDE on purpose: the spine starts
     its timer before runScript runs, so everything runScript spends before its own clock decides (spawn() itself,
     which on a RAM-starved box can block for hundreds of ms) eats into this slack. runScript measures its timeout
     from before spawn, so the slack only has to cover scheduling jitter, and 2s of it never depends on spawn speed. */
  const SPINE_SLACK_MS = 2000;
  const DEFAULT_TIMEOUT_MS = 5000;

  /* Split a command line into argv the way a POSIX shell would for the SIMPLE cases, and no further: double
     quotes, single quotes, and backslash escapes outside quotes. Deliberately does NOT understand pipes,
     redirects, globs, $VARS or backticks — those would need a shell, and running a shell is the thing this
     module exists to avoid. An unterminated quote is an ERROR, never a silent best-effort split: guessing at
     what a half-quoted command meant is how you execute something the Commander did not write. */
  function splitArgs(line) {
    const s = String(line == null ? '' : line);
    const out = [];
    let cur = '', quote = null, has = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === quote) { quote = null; continue; }
        if (quote === '"' && c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
        cur += c;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; has = true; continue; }
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
      if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
      cur += c;
    }
    if (quote) throw new Error('unbalanced quote in hook command: ' + s);
    if (cur || has) out.push(cur);
    return out;
  }

  // The allowlist key. Both halves matter: changing the COMMAND of an already-allowed hook must re-ask, or
  // editing one character of a trusted line would silently inherit its approval.
  const keyOf = (event, command) => String(event) + '\u0000' + String(command).trim();

  function makeShellHooks(deps) {
    deps = deps || {};
    const spawn = deps.spawn, fsp = deps.fsp, P = deps.pathMod;
    if (!spawn || !fsp || !P) throw new Error('shellhooks requires { spawn, fsp, pathMod }');
    const hooksFile = deps.hooksFile, allowFile = deps.allowFile;
    const cwd = deps.cwd || '.';
    const onError = (typeof deps.onError === 'function') ? deps.onError : (() => {});
    const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const spineBoundMs = timeoutMs + KILL_SETTLE_MS + SPINE_SLACK_MS;

    async function readJson(file, fallback) {
      if (!file) return fallback;
      try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return fallback; }
    }

    /* load() -> { hooks: [{event, command, name}], errors: [] }
       A malformed ENTRY is dropped with a reported reason rather than taking the whole file down: one typo in
       a five-hook file must not silently disable the other four. */
    async function load() {
      const raw = await readJson(hooksFile, null);
      const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.hooks) ? raw.hooks : []);
      const hooks = [], errors = [];
      for (const h of list.slice(0, MAX_HOOKS)) {
        const event = String((h && h.event) || '').trim();
        const command = String((h && h.command) || '').trim();
        if (!event || !command) { errors.push('a hook entry needs both `event` and `command`'); continue; }
        try { if (!splitArgs(command).length) { errors.push('empty command for ' + event); continue; } }
        catch (e) { errors.push((e && e.message) || 'bad command'); continue; }
        hooks.push({ event, command, name: String((h && h.name) || command.split(/\s+/)[0] || 'hook') });
      }
      if (list.length > MAX_HOOKS) errors.push('only the first ' + MAX_HOOKS + ' hooks are loaded (' + list.length + ' configured)');
      return { hooks, errors };
    }

    /* AUTHORING. A hook the Commander TYPES INTO THE STATION is already consented — they wrote it, here, on
       purpose. The allowlist exists for hooks that arrive by other means (a repo checkout, a config sync, a
       restored backup), which is a different act entirely. So create() approves what it writes; asking the
       author to then approve their own keystrokes would be theatre, and theatre is what teaches people to
       click yes without reading. */
    async function create(entry) {
      const event = String((entry && entry.event) || '').trim();
      const command = String((entry && entry.command) || '').trim();
      const name = String((entry && entry.name) || '').trim() || command.split(/\s+/)[0] || 'hook';
      if (!event || !command) return { ok: false, error: 'an event and a command are both required' };
      try { if (!splitArgs(command).length) return { ok: false, error: 'that command is empty' }; }
      catch (e) { return { ok: false, error: (e && e.message) || 'that command could not be parsed' }; }

      const raw = await readJson(hooksFile, null);
      const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.hooks) ? raw.hooks : []);
      if (list.length >= MAX_HOOKS) return { ok: false, error: 'this station already has the maximum of ' + MAX_HOOKS + ' hooks' };
      if (list.some(h => h && String(h.event) === event && String(h.command).trim() === command)) {
        return { ok: false, error: 'that exact hook already exists' };
      }
      list.push({ event, command, name });
      try { await fsp.writeFile(hooksFile, JSON.stringify({ hooks: list }, null, 2), 'utf8'); }
      catch (e) { return { ok: false, error: 'could not write the hooks file: ' + ((e && e.message) || e) }; }
      await allow(event, command);
      return { ok: true, event, command, name };
    }

    // Remove the LINE, not just the approval — this is the delete a revoke deliberately is not.
    async function remove(event, command) {
      const ev = String(event || '').trim(), cmd = String(command || '').trim();
      const raw = await readJson(hooksFile, null);
      const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.hooks) ? raw.hooks : []);
      const next = list.filter(h => !(h && String(h.event) === ev && String(h.command).trim() === cmd));
      if (next.length === list.length) return false;
      try { await fsp.writeFile(hooksFile, JSON.stringify({ hooks: next }, null, 2), 'utf8'); }
      catch (e) { onError({ hook: 'hooks-file', error: (e && e.message) || String(e) }); return false; }
      await revoke(ev, cmd);          // leave no orphan approval behind for a future hook to inherit
      return true;
    }

    const allowedSet = async () => new Set(Object.keys((await readJson(allowFile, {})) || {}));

    // Approve one (event, command) pair. Persisted, because re-asking every boot for a hook the Commander
    // already approved is the kind of nagging that trains people to approve without reading.
    async function allow(event, command) {
      const cur = (await readJson(allowFile, {})) || {};
      cur[keyOf(event, command)] = { event, command, allowedAt: deps.clock ? deps.clock.now() : 0 };
      try { await fsp.writeFile(allowFile, JSON.stringify(cur, null, 2), 'utf8'); return true; }
      catch (e) { onError({ hook: 'allowlist', error: (e && e.message) || String(e) }); return false; }
    }
    /* UN-APPROVE. A consent gate with no way back is not a gate, it is a one-way door — and the Commander
       who approved a hook in a hurry needs the same one click to take it back. Removing the entry is enough:
       install() only registers pairs present in the allowlist, so a revoke plus a re-install is a full stop. */
    async function revoke(event, command) {
      const cur = (await readJson(allowFile, {})) || {};
      const k = keyOf(event, command);
      if (!(k in cur)) return false;                    // already not allowed — honest false, not a fake success
      delete cur[k];
      try { await fsp.writeFile(allowFile, JSON.stringify(cur, null, 2), 'utf8'); return true; }
      catch (e) { onError({ hook: 'allowlist', error: (e && e.message) || String(e) }); return false; }
    }
    async function listPending() {
      const [{ hooks }, allowed] = [await load(), await allowedSet()];
      return hooks.filter(h => !allowed.has(keyOf(h.event, h.command)));
    }

    // Run one hook script. Never throws: every failure path resolves to null, which the spine reads as
    // "this handler had no opinion".
    function runScript(hook, payload) {
      return new Promise((resolve) => {
        let argv;
        try { argv = splitArgs(hook.command); } catch (e) { onError({ hook: hook.name, error: (e && e.message) }); return resolve(null); }
        const exe = argv[0];
        // The timeout is measured from HERE, before spawn(): a spawn that blocks for 400ms has spent 400ms of the
        // hook's budget, exactly as the spine's own timer (already running) sees it.
        const t0 = Date.now();
        let child;
        try {
          child = spawn(exe, argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) { onError({ hook: hook.name, error: 'spawn failed: ' + ((e && e.message) || e) }); return resolve(null); }

        let out = '', bytes = 0, done = false, exited = false;
        child.once('exit', () => { exited = true; });
        /* A KILLED child is not gone yet: on Windows it can keep its cwd (and the files under it) open for a moment
           after kill() returns, so a caller that removes the directory the instant we settle hits EBUSY. On the kill
           path only, settle when the child has exited, or after KILL_SETTLE_MS at most. A child that already exited
           (the ordinary close path) and a spawn error settle at once, exactly as before. */
        const finish = (v, killed) => {
          if (done) return; done = true; clearTimeout(timer);
          try { child.kill(); } catch (_) {}
          if (!killed || exited) return resolve(v);
          const bound = setTimeout(() => resolve(v), KILL_SETTLE_MS);
          child.once('exit', () => { clearTimeout(bound); resolve(v); });
        };
        const timer = setTimeout(() => { onError({ hook: hook.name, error: 'timeout after ' + timeoutMs + 'ms' }); finish(null, true); }, Math.max(0, timeoutMs - (Date.now() - t0)));

        try { child.stdout.on('data', (d) => { bytes += d.length; if (bytes <= MAX_STDOUT_BYTES) out += d.toString('utf8'); }); } catch (_) {}
        try { child.stderr.on('data', () => {}); } catch (_) {}          // stderr is the script's own logging, not our business
        child.on('error', (e) => { onError({ hook: hook.name, error: (e && e.message) || String(e) }); finish(null); });
        child.on('close', () => {
          // A non-JSON or empty stdout is a SILENT NO-OP, not an error: plenty of useful hooks (a formatter, a
          // logger) print nothing at all, and treating their silence as a failure would spam the Commander.
          const t = out.trim();
          if (!t) return finish(null);
          try { finish(JSON.parse(t)); } catch (_) { finish(null); }
        });

        try { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload)); } catch (_) { /* the close handler still settles us */ }
      });
    }

    /* install(hooks, { accept }) — register every ALLOWED hook on the spine.
       Returns what happened, so the host can tell the Commander which hooks are live and which are waiting on
       them, instead of failing silently in either direction. `accept: true` is the non-interactive escape
       hatch (a headless/CI station); it approves and persists, and it is the caller's decision to make. */
    async function install(hookSpine, opts) {
      opts = opts || {};
      const { hooks, errors } = await load();
      const allowed = await allowedSet();
      const installed = [], pending = [];
      for (const h of hooks) {
        const k = keyOf(h.event, h.command);
        if (!allowed.has(k)) {
          if (!opts.accept) { pending.push(h); continue; }
          await allow(h.event, h.command);
        }
        try {
          /* The spine bounds every handler with its OWN timer. If that bound equalled ours it would always fire first
             (it starts before runScript does), and invoke() would return while the killed child still held its cwd:
             the EBUSY this module's kill-settle wait exists to prevent. So the spine's bound covers our whole
             timeout + kill + settle path, and ours is the one that decides. */
          hookSpine.register(h.event, (payload) => runScript(h, payload), { name: h.name, timeoutMs: spineBoundMs });
          installed.push(h);
        } catch (e) { errors.push('cannot register ' + h.name + ' on ' + h.event + ': ' + ((e && e.message) || e)); }
      }
      return { installed, pending, errors };
    }

    return { load, install, allow, revoke, create, remove, listPending, _internals: { splitArgs, keyOf, runScript, spineBoundMs, KILL_SETTLE_MS } };
  }

  return { makeShellHooks, _internals: { splitArgs, keyOf, KILL_SETTLE_MS } };
});
