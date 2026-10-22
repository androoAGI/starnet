/* sidecar/plugins.js — SCOPED PLUGINS: packaged, shareable JS that rides the hook spine.

   Shell hooks (sidecar/shellhooks.js) cover "run my script when X happens" and stop there — a hook cannot
   hold state between events, cannot ship as one installable unit, and pays a process spawn every single tool
   call. A plugin is the same idea packaged: a folder someone can publish, install, and enable, whose code
   lives in-process and can keep state across the events it subscribes to.

   SCOPED means SCOPED SURFACE, NOT SCOPED PRIVILEGE — and the difference is worth stating plainly rather than
   implied by a word. The only thing this loader HANDS a plugin is `on(event, handler)` against the hook spine:
   no registry, no station internals, no capability set, no provider keys. But it is ordinary in-process
   JavaScript, so nothing stops it requiring whatever Node exposes. Real isolation would need a worker or a VM
   boundary and a serialized bridge; this deliberately does not pretend to have one. What protects the station
   is the same thing that protects it from shell hooks: the code is INSTALLED BY the Commander, every plugin is
   inert until explicitly allowed, and the allowlist is keyed to the code's own hash so a silent edit re-asks.

   The reference harness loads its Python plugins BEFORE its shell hooks so plugin decisions win ties on a
   blocking event. That ordering is reproduced by the host (index.js loads plugins first), and it matters:
   the hook spine reports the FIRST block's reason, so load order decides who gets to explain a refusal.

   A plugin folder:
     <plugins>/<id>/plugin.json   { "name": "...", "version": "1.0.0", "description": "...", "main": "index.js" }
     <plugins>/<id>/index.js      module.exports = { register(api) { api.on('pre_tool_call', fn) } }

   makePluginLoader({ fsp, pathMod, dir, allowFile, requireModule, hash, guard?, clock?, onError })
     -> { discover, load, allow, listPending, _internals } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).plugins = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PLUGINS = 32;
  const MAX_SOURCE_BYTES = 2 << 20;    // a plugin we cannot even hash is a plugin we cannot gate
  // The approval digest covers the WHOLE folder (audit 2026-09-25 #17): a helper file require()d by an approved
  // main used to change freely without re-asking. Bounded so a folder we cannot hash is refused, never waved on.
  const MAX_TREE_FILES = 512;
  const MAX_TREE_BYTES = 16 << 20;
  const MAX_TREE_DEPTH = 12;
  const RECHECK_MS = 2000;             // exec-time re-verification is re-hashed at most this often per plugin
  const CODE_EXT = /\.(?:c|m)?js$/i;

  const idOk = (s) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(s || ''));

  /* SCREENS — a plugin's own windows (2026-09-29, plugin extensions phase 1). Each one is an HTML entry inside the
     plugin folder that the station opens in a real Agent OS window: a sandboxed frame under the station's own glass
     chrome (sidecar /plugin-ui/ route + frontend/app/pluginhost.js). The manifest only NAMES them; nothing here
     runs them. Validated hard because every field ends up in the page: the id keys a window, the title is
     rendered, the entry becomes a URL path.
       "screens": [{ "id": "main", "title": "PR RADAR", "entry": "ui/index.html", "size": "panel" | "wide" }] */
  const MAX_SCREENS = 8;
  const SCREEN_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
  /* relPathOk — THE path rule for every file a plugin names or an agent writes (manifest entries, served files,
     drafts). Relative, forward slashes, inside the folder — and nothing Windows would read as SOMETHING ELSE:
       ':'                an NTFS alternate data stream (`app.js:evil.js`) is invisible to readdir, so it would
                          escape the approval digest while still being readable, require()-able and copied
       trailing '.'/' '   Windows strips them, so `index.html.` IS index.html under a different name
       '~<digit>'         an 8.3 short name (PROGRA~1) aliases a real long name
       device names       CON, NUL, COM1… are devices on every folder, not files */
  const WIN_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(?:\..*)?$/i;
  function relPathOk(rel) {
    const r = String(rel || '');
    if (!r || r.length > 240 || r.indexOf('\\') >= 0 || r.indexOf(':') >= 0 || r.charAt(0) === '/') return false;
    return r.split('/').every(seg => seg && seg !== '.' && seg !== '..' && seg.charAt(0) !== '.' &&
      !/[\u0000-\u001f<>"|?*]/.test(seg) && !/[. ]$/.test(seg) && !/~\d/.test(seg) && !WIN_DEVICE.test(seg));
  }
  function parseScreens(manifest, fileSet) {
    const out = [], errors = [];
    const raw = manifest && manifest.screens;
    if (raw == null) return { screens: out, errors };
    if (!Array.isArray(raw)) return { screens: out, errors: ['`screens` must be a list'] };
    const seen = new Set();
    for (const s of raw.slice(0, MAX_SCREENS)) {
      const id = String((s && s.id) || '').trim();
      if (!SCREEN_ID.test(id)) { errors.push('screen id "' + id + '" must be letters, numbers, dash or underscore (max 32)'); continue; }
      if (seen.has(id)) { errors.push('screen id "' + id + '" is listed twice'); continue; }
      const entry = String((s && s.entry) || '').trim();
      if (!relPathOk(entry) || !/\.html?$/i.test(entry)) { errors.push('screen "' + id + '": `entry` must be an .html file inside the plugin folder'); continue; }
      if (fileSet && !fileSet.has(entry)) { errors.push('screen "' + id + '": ' + entry + ' does not exist in the plugin folder'); continue; }
      // plain text only: control characters stripped, capped to what a window title bar can hold
      const title = String((s && s.title) || id).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || id;
      const size = s && s.size === 'wide' ? 'wide' : 'panel';
      seen.add(id);
      out.push({ id, title, entry, size });
    }
    if (raw.length > MAX_SCREENS) errors.push('only the first ' + MAX_SCREENS + ' screens are used');
    return { screens: out, errors };
  }

  function makePluginLoader(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, dir = deps.dir;
    const requireModule = deps.requireModule;
    const hash = deps.hash;
    if (!fsp || !P || !dir || typeof requireModule !== 'function' || typeof hash !== 'function') {
      throw new Error('plugins requires { fsp, pathMod, dir, requireModule, hash }');
    }
    const guard = (deps.guard && typeof deps.guard.scanText === 'function') ? deps.guard : null;
    const onError = (typeof deps.onError === 'function') ? deps.onError : (() => {});
    const allowFile = deps.allowFile;

    const readJson = async (f, fb) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (_) { return fb; } };
    // Injected clock (determinism lint). WITHOUT one there is no rate limit: every handler call re-hashes — the
    // re-verification must never fail open for want of a clock.
    const now = (deps.clock && typeof deps.clock.now === 'function') ? () => Number(deps.clock.now()) || 0 : null;

    /* treeDigest(base) -> { digest, files: [{ rel, text }] } | { error }
       Every regular file under the plugin folder, walked with lstat and in sorted order, contributes
       "<relative path>\0<hash of its bytes>" to one digest. A symlink or junction anywhere in the folder (or the
       folder itself) is refused outright: following it would let approved code quietly become code from
       somewhere else, and hashing its target would approve a file the plugin does not own. */
    async function treeDigest(base) {
      let st;
      try { st = await fsp.lstat(base); } catch (e) { return { error: 'cannot read the plugin folder' }; }
      if (st.isSymbolicLink() || !st.isDirectory()) return { error: 'the plugin folder is a link, not a real folder' };
      const entries = [];
      let bytes = 0;
      async function walk(dirAbs, rel, depth) {
        if (depth > MAX_TREE_DEPTH) throw new Error('the plugin folder nests too deep to gate safely');
        const names = (await fsp.readdir(dirAbs)).sort();
        for (const name of names) {
          const abs = P.join(dirAbs, name);
          const r = rel ? rel + '/' + name : name;
          const l = await fsp.lstat(abs);
          if (l.isSymbolicLink()) throw new Error('contains a link (' + r + ') — plugin files must be real files inside the folder');
          if (l.isDirectory()) { await walk(abs, r, depth + 1); continue; }
          if (!l.isFile()) throw new Error('contains a non-file entry (' + r + ')');
          if (entries.length >= MAX_TREE_FILES) throw new Error('has too many files to gate safely');
          const buf = await fsp.readFile(abs);
          bytes += buf.length;
          if (bytes > MAX_TREE_BYTES) throw new Error('is too large to gate safely');
          entries.push({ rel: r, bin: buf.toString('latin1'), text: CODE_EXT.test(name) ? buf.toString('utf8') : null });
        }
      }
      try { await walk(base, '', 0); }
      catch (e) { return { error: (e && e.message) || String(e) }; }
      const digest = hash('starnet-plugin-tree-v1\n' + entries.map(e => e.rel + '\0' + hash(e.bin)).join('\n'));
      return { digest, files: entries.map(e => ({ rel: e.rel, text: e.text })) };
    }

    /* discover() -> { plugins, errors }
       A plugin is identified by its folder; a broken one is REPORTED and skipped rather than aborting the
       scan, because one bad plugin must not disable the others. */
    async function discover() {
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (_) { return { plugins: [], errors: [] }; }     // no plugins dir is the ordinary case, not an error
      const plugins = [], errors = [];
      const dirs = entries.filter(e => e && typeof e.isDirectory === 'function' && e.isDirectory()).slice(0, MAX_PLUGINS);
      for (const e of dirs) {
        const id = e.name;
        if (!idOk(id)) { errors.push('skipped plugin folder with an unusable name: ' + id); continue; }
        const r = await inspect(id);
        if (r.error) { errors.push(id + ': ' + r.error); continue; }
        for (const w of r.warnings) errors.push(id + ': ' + w);
        plugins.push(r.plugin);
      }
      if (entries.length > MAX_PLUGINS) errors.push('only the first ' + MAX_PLUGINS + ' plugin folders are considered');
      return { plugins, errors };
    }

    /* inspect(id) -> { plugin, warnings } | { error } — ONE plugin folder, read and hashed. discover() is this over
       every folder; the /plugin-ui/ file route uses it (through approvedRecord) to re-prove a single plugin. */
    async function inspect(id) {
      const base = P.join(dir, id);
      const manifest = await readJson(P.join(base, 'plugin.json'), null);
      if (!manifest || typeof manifest !== 'object') return { error: 'no readable plugin.json' };
      // A plugin may be UI-only: screens and no code for the station to load. `main` defaults to index.js only
      // when the manifest names no screens (the original, hook-only shape keeps working untouched).
      const uiOnly = manifest.main == null && Array.isArray(manifest.screens) && manifest.screens.length > 0;
      const main = uiOnly ? '' : String(manifest.main || 'index.js');
      if (main && (main.indexOf('..') >= 0 || P.isAbsolute(main))) return { error: '`main` must be a path inside the plugin folder' };
      const mainPath = main ? P.join(base, main) : null;
      let source = '';
      if (mainPath) {
        try { source = await fsp.readFile(mainPath, 'utf8'); }
        catch (_) { return { error: 'cannot read ' + main }; }
        if (source.length > MAX_SOURCE_BYTES) return { error: main + ' is too large to gate safely' };
      }
      // The DIGEST IS OF THE CODE, not of the folder name: approval must not survive an edit to anything that
      // can run. It covers EVERY file in the folder (main, the helpers it requires, the manifest, the UI pages),
      // so changing one character anywhere re-asks, exactly like a shell hook.
      const tree = await treeDigest(base);
      if (tree.error) return { error: tree.error };
      const mainRel = mainPath ? P.relative(base, mainPath).split(P.sep).join('/') : '';
      if (mainPath && !tree.files.some(f => f.rel === mainRel)) return { error: main + ' is not a real file inside the plugin folder' };
      const sc = parseScreens(manifest, new Set(tree.files.map(f => f.rel)));
      let findings = guard ? (mainPath ? (guard.scanText(main, source) || null) : []) : null;
      // helpers are code too: the approval prompt discloses what THEY appear to do as well (UI scripts included —
      // they run in a sandboxed frame, but the Commander is still saying yes to them)
      if (guard && Array.isArray(findings)) {
        for (const f of tree.files) {
          if (f.rel === mainRel || f.text == null) continue;
          const more = guard.scanText(f.rel, f.text);
          if (Array.isArray(more) && more.length) findings = findings.concat(more);
        }
      }
      return {
        warnings: sc.errors,
        plugin: {
          id, dir: base, main: mainPath, digest: tree.digest,
          name: String(manifest.name || id),
          version: String(manifest.version || '0'),
          description: String(manifest.description || ''),
          screens: sc.screens,
          findings
        }
      };
    }

    /* approvedRecord(id) -> plugin | null — the SERVING gate. A plugin's files are only ever served while the
       Commander's approval covers the exact bytes on disk: the allowlist digest must equal a fresh hash of the
       folder. Re-hashed at most every RECHECK_MS per plugin (a window's page pulls many assets at once); without
       an injected clock every call re-hashes — the check never fails open for want of a clock. */
    const serveCache = new Map();
    async function approvedRecord(id) {
      const pid = String(id || '');
      if (!idOk(pid)) return null;
      const a = (await allowedMap())[pid];
      if (!a || !a.digest) { serveCache.delete(pid); return null; }
      const c = serveCache.get(pid);
      if (c && now && c.rec.digest === a.digest) {
        const t = now();
        if (t - c.at < RECHECK_MS && t >= c.at) return c.rec;
      }
      const r = await inspect(pid);
      if (r.error || r.plugin.digest !== a.digest) { serveCache.delete(pid); return null; }
      serveCache.set(pid, { rec: r.plugin, at: now ? now() : 0 });
      return r.plugin;
    }

    /* SCAFFOLD. "Create a plugin" cannot mean "go make two files by hand in a folder you have to find" — that
       is the same authoring gap the hooks form closes. This writes a WORKING plugin, not an empty stub: it
       subscribes to a real event and does something observable, so the first thing the author sees is proof
       the socket works, and their job is to edit rather than to guess the shape from prose.
       Authored here = consented here, same as a hook typed into the form. */
    async function scaffold(spec) {
      const id = String((spec && spec.id) || '').trim();
      if (!idOk(id)) return { ok: false, error: 'use letters, numbers, dot, dash or underscore (max 64)' };
      const name = String((spec && spec.name) || '').trim() || id;
      const description = String((spec && spec.description) || '').trim() || 'A Agent OS plugin.';
      const base = P.join(dir, id);
      try { await fsp.stat(base); return { ok: false, error: 'a plugin folder named "' + id + '" already exists' }; }
      catch (_) { /* good — it does not exist yet */ }

      const source = [
        '/* ' + name + ' — a Agent OS plugin.',
        ' *',
        ' * register(api) runs once at station boot. api.on(event, handler) is the whole surface:',
        ' *   pre_tool_call    before a tool runs — return {decision:"block", reason:"…"} to stop it',
        ' *   post_tool_call   after it ran (observe only)',
        ' *   pre_llm_call     before a model call — return {context:"…"} to add a standing note',
        ' *   post_llm_call    after a model call (observe only)',
        ' *   on_session_start / on_session_end / on_pre_compress / on_memory_write',
        ' *',
        ' * Unlike a hook, a plugin stays loaded — so it can remember things between events.',
        ' */',
        "'use strict';",
        '',
        'module.exports = {',
        '  register(api) {',
        '    let toolCalls = 0;',
        '',
        '    api.on(\'post_tool_call\', (p) => {',
        '      toolCalls++;',
        '      console.log(\'[' + id + '] \' + p.tool_name + \' (\' + toolCalls + \' this run)\');',
        '    });',
        '',
        '    api.on(\'on_session_end\', () => {',
        '      console.log(\'[' + id + '] run finished after \' + toolCalls + \' tool calls\');',
        '      toolCalls = 0;',
        '    });',
        '  }',
        '};',
        ''
      ].join('\n');
      const manifest = JSON.stringify({ name, version: '1.0.0', description, main: 'index.js' }, null, 2) + '\n';
      // With a template (sidecar/plugin-template.js) the starter also carries a WINDOW built from the station kit;
      // without one (tests, older hosts) it is the hook-only starter above.
      let files = { 'plugin.json': manifest, 'index.js': source };
      if (typeof deps.template === 'function') {
        try { files = deps.template({ id, name, description }) || files; }
        catch (e) { onError({ plugin: id, error: 'the starter template failed, writing the hook-only starter: ' + ((e && e.message) || e) }); }
      }
      try {
        await fsp.mkdir(base, { recursive: true });
        for (const rel of Object.keys(files)) {
          if (!relPathOk(rel)) continue;
          const abs = P.join(base, ...rel.split('/'));
          await fsp.mkdir(P.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, files[rel], 'utf8');
        }
      } catch (e) { return { ok: false, error: 'could not create the plugin folder: ' + ((e && e.message) || e) }; }
      const tree = await treeDigest(base);
      if (tree.error) return { ok: false, error: 'created the plugin, but could not hash it: ' + tree.error };
      await allow(id, tree.digest);
      return { ok: true, id, name, dir: base };
    }

    /* DESTROY the folder. Deliberately separate from revoke, and deliberately NOT offered for a plugin the
       station did not write: deleting someone's source tree because they clicked the wrong row is the one
       mistake there is no undo for. The caller must pass the id it read back from discover(). */
    async function destroy(id) {
      const pid = String(id || '').trim();
      if (!idOk(pid)) return false;
      const base = P.join(dir, pid);
      try { await fsp.stat(base); } catch (_) { return false; }
      // its process must be GONE first — a running plugin holds its folder open on Windows (EBUSY)
      if (deps.runtime) await deps.runtime.stop(pid);
      try { await fsp.rm(base, { recursive: true, force: true }); }
      catch (e) { onError({ plugin: pid, error: (e && e.message) || String(e) }); return false; }
      await revoke(pid);
      return true;
    }

    const allowedMap = async () => (await readJson(allowFile, {})) || {};
    async function allow(id, digest) {
      const cur = await allowedMap();
      cur[String(id)] = { digest: String(digest), allowedAt: deps.clock ? deps.clock.now() : 0 };
      try { await fsp.writeFile(allowFile, JSON.stringify(cur, null, 2), 'utf8'); return true; }
      catch (e) { onError({ plugin: id, error: (e && e.message) || String(e) }); return false; }
    }
    // UN-APPROVE — the other half of the gate. Dropping the entry is enough: load() only registers a plugin
    // whose digest is in the allowlist, so a revoke plus a re-load leaves it installed but inert.
    async function revoke(id) {
      const cur = await allowedMap();
      if (!(String(id) in cur)) return false;
      delete cur[String(id)];
      try { await fsp.writeFile(allowFile, JSON.stringify(cur, null, 2), 'utf8'); return true; }
      catch (e) { onError({ plugin: id, error: (e && e.message) || String(e) }); return false; }
    }
    async function listPending() {
      const [{ plugins }, allowed] = [await discover(), await allowedMap()];
      return plugins.filter(p => !(allowed[p.id] && allowed[p.id].digest === p.digest));
    }

    /* load(hookSpine, { accept }) -> { loaded, pending, errors }
       The plugin's `register(api)` is called with a surface that is ONLY the hook spine. Anything it throws
       during registration costs that plugin and nothing else — a station must still boot with a broken
       plugin installed, or one bad third-party folder becomes an un-startable app. */
    async function load(hookSpine, opts) {
      opts = opts || {};
      const { plugins, errors } = await discover();
      const allowed = await allowedMap();
      const loaded = [], pending = [];
      const runtime = deps.runtime || null;
      // PROCESS MODE (phase 2): every approved plugin with code runs in its own process. A reload keeps a
      // running process whose code is unchanged (its in-memory state survives an unrelated hook edit); anything
      // no longer approved as it is on disk — revoked, deleted, edited — is stopped here, before it can run again.
      if (runtime) {
        const keep = new Set(plugins.filter(p => p.main && allowed[p.id] && allowed[p.id].digest === p.digest).map(p => p.id));
        for (const id of runtime.list()) if (!keep.has(id) || runtime.digestOf(id) !== (plugins.find(p => p.id === id) || {}).digest) runtime.stop(id);
      }
      for (const p of plugins) {
        const ok = allowed[p.id] && allowed[p.id].digest === p.digest;
        if (!ok) {
          if (!opts.accept) { pending.push(p); continue; }
          await allow(p.id, p.digest);
        }
        /* EXEC-TIME RE-VERIFICATION. Approval was checked against the folder as discover() saw it; a helper the
           plugin require()s lazily (or reads at event time) can still change after load. Every handler call
           re-verifies the folder digest (re-hashed at most every RECHECK_MS) and a drift disables the WHOLE
           plugin until the Commander approves the new code — it goes back to pending on the next listing. */
        let checkedAt = now ? now() : 0, disabled = false;
        const stillApproved = async () => {
          if (disabled) return false;
          if (now) {
            const t = now();
            if (t - checkedAt < RECHECK_MS && t >= checkedAt) return true;
            checkedAt = t;
          }
          const cur = await treeDigest(p.dir);
          if (cur.digest === p.digest) return true;
          disabled = true;
          if (runtime) runtime.stop(p.id);   // edited code must not keep running in its process either
          onError({ plugin: p.id, error: 'its files changed since approval (' + (cur.error || 'digest mismatch') + ') — disabled until re-approved' });
          return false;
        };
        // UI-only plugin: approved and live (its screens may open), with no code for the station to load.
        if (!p.main) { loaded.push(Object.assign({}, p, { subscribed: 0 })); continue; }
        if (runtime) {
          let s = runtime.digestOf(p.id) === p.digest ? runtime.surface(p.id) : null;
          if (!s) {
            const r = await runtime.start(p);
            if (!r || !r.ok) { errors.push(p.id + ': ' + ((r && r.error) || 'failed to start')); continue; }
            s = r;
          }
          for (const event of s.subs || []) {
            const ms = s.hookTimeouts && Number(s.hookTimeouts[event]) > 0 ? Number(s.hookTimeouts[event]) : undefined;
            hookSpine.register(event, async (payload) => ((await stillApproved()) ? runtime.hook(p.id, event, payload, ms) : null), { name: p.id, timeoutMs: ms });
          }
          loaded.push(Object.assign({}, p, {
            subscribed: (s.subs || []).length, process: true,
            tools: (s.tools || []).map(t => t.name), handlers: (s.handlers || []).slice(), jobs: s.jobs || 0
          }));
          continue;
        }
        let mod;
        try { mod = requireModule(p.main); }
        catch (e) { errors.push(p.id + ': failed to load — ' + ((e && e.message) || e)); continue; }
        const register = mod && (typeof mod.register === 'function' ? mod.register : (typeof mod === 'function' ? mod : null));
        if (!register) { errors.push(p.id + ': exports no register(api) function'); continue; }
        let subscribed = 0;
        // THE ENTIRE SURFACE. `on` is a thin wrapper so a plugin cannot reach the spine object itself and
        // clear() everyone else's handlers, and so every handler is attributed to its plugin by name in
        // telemetry and in a block reason.
        const api = {
          name: p.name,
          version: p.version,
          on(event, fn, meta) {
            if (typeof fn !== 'function') return () => {};
            const verified = async (payload) => ((await stillApproved()) ? fn(payload) : null);
            const off = hookSpine.register(event, verified, { name: p.id, timeoutMs: meta && meta.timeoutMs });
            subscribed++;
            return off;
          }
        };
        try { register(api); }
        catch (e) { errors.push(p.id + ': register() threw — ' + ((e && e.message) || e)); continue; }
        loaded.push(Object.assign({}, p, { subscribed }));
      }
      return { loaded, pending, errors };
    }

    return { discover, inspect, approvedRecord, load, allow, revoke, scaffold, destroy, listPending, _internals: { idOk, treeDigest } };
  }

  return { makePluginLoader, parseScreens, _internals: { idOk, relPathOk } };
});
