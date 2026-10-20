/* node test/plugins.test.js — SCOPED PLUGINS on the hook spine.

   Shell hooks cover "run my script when X happens" and stop there: they hold no state between events, ship as
   a config line rather than an installable unit, and pay a process spawn on every tool call. A plugin is the
   same idea packaged. These assertions pin the surface a plugin is handed (only the spine), the consent gate
   (keyed to the CODE's hash, so an edit re-asks), and the isolation that actually matters here — one broken
   third-party folder must never stop the station booting.

   Uses real folders and a real require, because "does this actually load" is the whole question. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('node:crypto');
const { makeHooks } = require('../sidecar/hooks.js');
const { makePluginLoader } = require('../sidecar/plugins.js');

const DIR = path.join(os.tmpdir(), 'starnet-plugins-' + process.pid);
const PLUGINS = path.join(DIR, 'plugins');
const ALLOW = path.join(DIR, 'plugins-allowed.json');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const mk = (extra) => makePluginLoader(Object.assign({
  fsp, pathMod: path, dir: PLUGINS, allowFile: ALLOW,
  requireModule: (p) => { delete require.cache[require.resolve(p)]; return require(p); },
  hash: sha, clock: { now: () => 1 }, onError: () => {}
}, extra || {}));

async function writePlugin(id, source, manifest) {
  const base = path.join(PLUGINS, id);
  await fsp.mkdir(base, { recursive: true });
  await fsp.writeFile(path.join(base, 'plugin.json'), JSON.stringify(Object.assign({ name: id, version: '1.0.0' }, manifest || {})), 'utf8');
  await fsp.writeFile(path.join(base, (manifest && manifest.main) || 'index.js'), source, 'utf8');
  return source;
}

(async () => {
  await fsp.mkdir(PLUGINS, { recursive: true });
  // A plugin is CommonJS (module.exports / require). Node reads the module type from the NEAREST package.json —
  // and a temp root under /tmp can inherit a STRAY package.json of an unrelated tool (this host had
  // /tmp/package.json with "type": "module"), which turned every plugin into an ES module: "module is not
  // defined" and not a single plugin loaded. The plugin root pins its own type.
  await fsp.writeFile(path.join(DIR, 'package.json'), JSON.stringify({ name: 'starnet-plugins', private: true, type: 'commonjs' }) + '\n', 'utf8');
  try {
    // ---- 1. A PLUGIN SUBSCRIBES TO THE SPINE AND ITS HANDLER ACTUALLY FIRES ----
    {
      await writePlugin('auditor', `
        module.exports = { register(api) {
          api.on('post_tool_call', (p) => { global.__auditLog = (global.__auditLog||[]).concat(p.tool_name); });
        } };
      `);
      const spine = makeHooks();
      const r = await mk().load(spine, { accept: true });
      A.eq(r.loaded.length, 1, 'the plugin loads');
      A.eq(r.loaded[0].subscribed, 1, 'and its subscription is counted');
      global.__auditLog = [];
      await spine.invoke('post_tool_call', { tool_name: 'fs_write' });
      A.eq(global.__auditLog.join(','), 'fs_write', 'the handler fires with the real payload');
    }

    // ---- 2. STATE ACROSS EVENTS — the thing a shell hook fundamentally cannot do ----
    {
      await fsp.rm(ALLOW, { force: true });
      await fsp.rm(path.join(PLUGINS, 'auditor'), { recursive: true, force: true });
      await writePlugin('counter', `
        module.exports = { register(api) {
          let n = 0;                                  // lives across events — the whole reason plugins exist
          api.on('pre_tool_call', () => { n++; return n > 2 ? { decision: 'block', reason: 'rate limit: ' + n } : null; });
        } };
      `);
      const spine = makeHooks();
      await mk().load(spine, { accept: true });
      A.eq((await spine.invoke('pre_tool_call', {})).blocked, false, 'first call passes');
      A.eq((await spine.invoke('pre_tool_call', {})).blocked, false, 'second passes');
      const third = await spine.invoke('pre_tool_call', {});
      A.eq(third.blocked, true, 'the third is blocked by state the plugin kept between events');
      A.eq(third.reason, 'rate limit: 3', 'and its reason carries that state');
      A.eq(third.by, 'counter', 'the block is attributed to the plugin id, not to an anonymous handler');
    }

    // ---- 3. CONSENT IS KEYED TO THE CODE, so a silent edit re-asks ----
    {
      await fsp.rm(ALLOW, { force: true });
      const spine1 = makeHooks();
      let r = await mk().load(spine1);
      A.eq(r.loaded.length, 0, 'an unapproved plugin does NOT load');
      A.eq(r.pending.length, 1, 'it is reported as pending, not dropped silently');
      A.eq(spine1.count('pre_tool_call'), 0, 'and it registered nothing');

      const { plugins } = await mk().discover();
      await mk().allow(plugins[0].id, plugins[0].digest);
      A.eq((await mk().load(makeHooks())).loaded.length, 1, 'once approved it loads');

      // Edit the CODE — approval must not survive it.
      await writePlugin('counter', 'module.exports = { register(api) { api.on("pre_tool_call", () => ({ decision: "block", reason: "SNEAKY" })); } };');
      r = await mk().load(makeHooks());
      A.eq(r.loaded.length, 0, 'an edited plugin is NOT loaded on its old approval');
      A.eq(r.pending.length, 1, 'it goes back to pending — the digest is of the code that actually runs');
      A.eq((await mk().listPending()).length, 1, 'listPending surfaces it for an approval affordance');
    }

    // ---- 4. THE SURFACE IS ONLY THE SPINE ----
    {
      await fsp.rm(ALLOW, { force: true });
      await fsp.rm(path.join(PLUGINS, 'counter'), { recursive: true, force: true });
      await writePlugin('nosy', `
        module.exports = { register(api) {
          global.__apiKeys = Object.keys(api).sort().join(',');
          global.__spineReachable = typeof api.clear === 'function' || typeof api.invoke === 'function' || !!api.spine;
        } };
      `);
      await mk().load(makeHooks(), { accept: true });
      A.eq(global.__apiKeys, 'name,on,version', 'a plugin is handed exactly on/name/version — no registry, no internals, no keys');
      A.eq(global.__spineReachable, false, 'and it cannot reach the spine object itself to clear() everyone else');
    }

    // ---- 5. ONE BROKEN PLUGIN MUST NEVER STOP THE STATION BOOTING ----
    {
      await fsp.rm(ALLOW, { force: true });
      await fsp.rm(path.join(PLUGINS, 'nosy'), { recursive: true, force: true });
      await writePlugin('throws-at-load', 'throw new Error("boom at require");');
      await writePlugin('throws-at-register', 'module.exports = { register() { throw new Error("boom at register"); } };');
      await writePlugin('no-register', 'module.exports = { nope: true };');
      await writePlugin('good', 'module.exports = { register(api) { api.on("post_tool_call", () => {}); } };');
      const spine = makeHooks();
      const r = await mk().load(spine, { accept: true });
      A.eq(r.loaded.length, 1, 'the healthy plugin still loads alongside three broken ones');
      A.eq(r.loaded[0].id, 'good', 'and it is the right one');
      A.eq(r.errors.length, 3, 'each failure is REPORTED rather than swallowed');
      A.ok(r.errors.some(e => /throws-at-load/.test(e)), 'a require-time throw is named');
      A.ok(r.errors.some(e => /register\(\) threw/.test(e)), 'a register-time throw is named');
      A.ok(r.errors.some(e => /exports no register/.test(e)), 'a plugin with no register() is named');
    }

    // ---- 6. MALFORMED FOLDERS are skipped with a reason, never loaded ----
    {
      await fsp.mkdir(path.join(PLUGINS, 'no-manifest'), { recursive: true });
      await fsp.writeFile(path.join(PLUGINS, 'no-manifest', 'index.js'), 'module.exports={register(){}}', 'utf8');
      const bad = path.join(PLUGINS, 'escaper');
      await fsp.mkdir(bad, { recursive: true });
      await fsp.writeFile(path.join(bad, 'plugin.json'), JSON.stringify({ name: 'escaper', main: '../../../evil.js' }), 'utf8');
      const { plugins, errors } = await mk().discover();
      A.eq(plugins.some(p => p.id === 'no-manifest'), false, 'a folder with no plugin.json is not a plugin');
      A.eq(plugins.some(p => p.id === 'escaper'), false, 'a manifest whose `main` escapes the plugin folder is refused');
      A.ok(errors.some(e => /escaper/.test(e) && /inside the plugin folder/.test(e)), 'and the refusal says why');
    }

    // ---- 7. THE GUARD DISCLOSES, it does not silently decide ----
    {
      await fsp.rm(ALLOW, { force: true });
      await writePlugin('scanned', 'module.exports={register(){}}');
      const seen = [];
      const { plugins } = await mk({ guard: { scanText: (f, src) => { seen.push(f); return { level: 'caution', hits: ['example'] }; } } }).discover();
      const p = plugins.find(x => x.id === 'scanned');
      A.eq(seen.indexOf('index.js') >= 0, true, 'the guard is run over the plugin source at discovery');
      A.eq(p.findings.level, 'caution', 'and its findings ride the record, so the approval prompt can SHOW what is being approved');
      // Deliberately: findings do not auto-reject. The guard is disclosure at the consent moment, not a
      // boundary — the same philosophy the skills guard already documents.
      const r = await mk({ guard: { scanText: () => ({ level: 'caution' }) } }).load(makeHooks(), { accept: true });
      A.ok(r.loaded.some(x => x.id === 'scanned'), 'a flagged plugin still loads once explicitly approved');
    }

    // ---- 8. NO PLUGINS DIR is the ordinary case: no plugins, no errors, no noise ----
    {
      const loader = makePluginLoader({ fsp, pathMod: path, dir: path.join(DIR, 'nope'), allowFile: ALLOW, requireModule: require, hash: sha });
      const { plugins, errors } = await loader.discover();
      A.eq(plugins.length, 0, 'no plugins directory -> no plugins');
      A.eq(errors.length, 0, 'and no complaints — most stations will never install one');
      A.eq((await loader.load(makeHooks())).loaded.length, 0, 'load() is a clean no-op');
    }
    // ---- 9. REVOKE — a consent gate with no way back is a one-way door, not a gate ----
    {
      await fsp.rm(ALLOW, { force: true });
      for (const stale of ['throws-at-load', 'throws-at-register', 'no-register', 'good', 'scanned', 'no-manifest', 'escaper']) {
        await fsp.rm(path.join(PLUGINS, stale), { recursive: true, force: true });
      }
      await writePlugin('revocable', 'module.exports = { register(api) { api.on("post_tool_call", () => {}); } };');
      const loader = mk();
      await loader.load(makeHooks(), { accept: true });
      A.eq((await loader.listPending()).some(x => x.id === 'revocable'), false, 'approved -> not pending');

      A.eq(await loader.revoke('revocable'), true, 'revoke reports that it removed the approval');
      A.eq((await loader.listPending()).some(x => x.id === 'revocable'), true, 'the plugin is pending again');
      const after = await loader.load(makeHooks());
      A.eq(after.loaded.some(x => x.id === 'revocable'), false, 'and a re-load leaves it INSTALLED BUT INERT — revoking disarms, it does not uninstall');
      A.eq(await loader.revoke('revocable'), false, 'revoking what is already un-approved is an honest false, not a cheerful success');
      A.eq(await loader.revoke('never-existed'), false, 'and so is revoking something that was never there');
    }
    // ---- 10. SCAFFOLD. "Create a plugin" cannot mean "hand-make two files in a folder you must find first". ----
    {
      await fsp.rm(ALLOW, { force: true });
      await fsp.rm(path.join(PLUGINS, 'revocable'), { recursive: true, force: true });
      const loader = mk();
      const made = await loader.scaffold({ id: 'auditor', name: 'Auditor', description: 'counts tool calls' });
      A.eq(made.ok, true, 'scaffold() creates the plugin');

      // It must arrive WORKING, not as an empty stub — the first thing an author sees should be proof the
      // socket works, so their job is to edit rather than to guess the shape from prose.
      const src = await fsp.readFile(path.join(PLUGINS, 'auditor', 'index.js'), 'utf8');
      A.ok(/module\.exports\s*=\s*\{[\s\S]*register\(api\)/.test(src), 'the scaffold exports a real register(api)');
      A.ok(/api\.on\(/.test(src), 'and actually subscribes to an event');
      const man = JSON.parse(await fsp.readFile(path.join(PLUGINS, 'auditor', 'plugin.json'), 'utf8'));
      A.eq(man.name, 'Auditor', 'the manifest carries the given name');

      const spine = makeHooks();
      const loaded = await loader.load(spine);
      A.ok(loaded.loaded.some(x => x.id === 'auditor'), 'it is AUTO-APPROVED and loads with no second step');
      A.ok(spine.count('post_tool_call') > 0, 'and its handler is really on the spine');

      A.eq((await loader.scaffold({ id: 'auditor' })).ok, false, 'the same id cannot be scaffolded twice');
      A.eq((await loader.scaffold({ id: 'has spaces' })).ok, false, 'an unusable id is refused');
      A.eq((await loader.scaffold({ id: '../escape' })).ok, false, 'and so is one that would escape the plugins folder');

      // DESTROY removes the folder — the one action here with no undo.
      A.eq(await loader.destroy('auditor'), true, 'destroy() reports the deletion');
      let gone = false;
      try { await fsp.stat(path.join(PLUGINS, 'auditor')); } catch (_) { gone = true; }
      A.eq(gone, true, 'the folder is really gone from disk');
      A.eq(Object.keys(JSON.parse(await fsp.readFile(ALLOW, 'utf8'))).length, 0, 'and it left no orphan approval behind');
      A.eq(await loader.destroy('auditor'), false, 'destroying what is gone is an honest false');
    }

    // ---- HELPER FILES ARE PART OF WHAT WAS APPROVED (audit 2026-09-25 #17) ----
    {
      await fsp.rm(ALLOW, { force: true });
      for (const d of await fsp.readdir(PLUGINS)) await fsp.rm(path.join(PLUGINS, d), { recursive: true, force: true });
      const base = path.join(PLUGINS, 'helpered');
      await writePlugin('helpered', `
        module.exports = { register(api) {
          api.on('post_tool_call', () => { global.__helperSays = require('./lib/helper.js')(); });
        } };
      `);
      await fsp.mkdir(path.join(base, 'lib'), { recursive: true });
      const helperFile = path.join(base, 'lib', 'helper.js');
      await fsp.writeFile(helperFile, "module.exports = () => 'approved-helper';", 'utf8');
      let t = 1000;
      const clock = { now: () => t };
      const reqFresh = (p) => { for (const k of Object.keys(require.cache)) if (k.indexOf(base) === 0) delete require.cache[k]; return require(p); };
      const loader = mk({ clock, requireModule: reqFresh });
      const d0 = (await loader.discover()).plugins[0];
      await loader.allow(d0.id, d0.digest);

      // a changed helper (main untouched) goes back to pending at the next load
      await fsp.writeFile(helperFile, "module.exports = () => 'TAMPERED';", 'utf8');
      const d1 = (await loader.discover()).plugins[0];
      A.ok(d1.digest !== d0.digest, 'editing a helper file changes the approval digest (main is unchanged)');
      let r = await loader.load(makeHooks());
      A.eq(r.loaded.length, 0, 'a plugin whose helper changed does not load on its old approval');
      A.eq(r.pending.map(p => p.id), ['helpered'], 'it is pending re-approval');
      // a new file dropped into the folder also re-asks
      await fsp.writeFile(helperFile, "module.exports = () => 'approved-helper';", 'utf8');
      A.eq((await loader.discover()).plugins[0].digest, d0.digest, 'restoring the helper restores the approved digest');
      await fsp.writeFile(path.join(base, 'extra.js'), '1', 'utf8');
      A.eq((await loader.listPending()).length, 1, 'an added file re-asks too');
      await fsp.rm(path.join(base, 'extra.js'));

      // exec-time: a helper changed AFTER load is caught before the handler runs, and disables the plugin
      const errs = [];
      const loader2 = mk({ clock, requireModule: reqFresh, onError: (e) => errs.push(e) });
      const spine = makeHooks();
      r = await loader2.load(spine);
      A.eq(r.loaded.length, 1, 'the approved plugin loads');
      global.__helperSays = null;
      await spine.invoke('post_tool_call', { tool_name: 'x' });
      A.eq(global.__helperSays, 'approved-helper', 'its handler runs the approved helper');
      await fsp.writeFile(helperFile, "module.exports = () => 'TAMPERED';", 'utf8');
      t += 5000;   // past the re-hash window
      global.__helperSays = null;
      await spine.invoke('post_tool_call', { tool_name: 'x' });
      A.eq(global.__helperSays, null, 'after a helper edit the handler does NOT run the changed code');
      A.ok(errs.some(e => e.plugin === 'helpered' && /changed since approval/.test(e.error)), 'the drift is reported by name');
      await fsp.writeFile(helperFile, "module.exports = () => 'approved-helper';", 'utf8');
      t += 5000;
      await spine.invoke('post_tool_call', { tool_name: 'x' });
      A.eq(global.__helperSays, null, 'a disabled plugin stays off until it is re-approved and re-loaded');

      // no injected clock => no rate limit: a drift is caught on the VERY NEXT call (never fails open for want of a clock)
      {
        const errs3 = [];
        const loader3 = mk({ clock: undefined, requireModule: reqFresh, onError: (e) => errs3.push(e) });
        const spine3 = makeHooks();
        const r3 = await loader3.load(spine3);
        A.eq(r3.loaded.length, 1, 'clockless loader: the approved plugin loads');
        global.__helperSays = null;
        await spine3.invoke('post_tool_call', { tool_name: 'x' });
        A.eq(global.__helperSays, 'approved-helper', 'clockless loader: the approved helper runs');
        await fsp.writeFile(helperFile, "module.exports = () => 'TAMPERED';", 'utf8');
        global.__helperSays = null;
        await spine3.invoke('post_tool_call', { tool_name: 'x' });
        A.eq(global.__helperSays, null, 'clockless loader: a helper edit is caught on the next call with no time passing');
        await fsp.writeFile(helperFile, "module.exports = () => 'approved-helper';", 'utf8');
      }

      // guard findings cover helpers, not only main
      const seen = [];
      await mk({ guard: { scanText: (f) => { seen.push(f); return []; } } }).discover();
      A.ok(seen.indexOf('lib/helper.js') >= 0, 'the guard scans helper files for the approval prompt');

      // a link inside the folder is refused (it would approve code the plugin does not own)
      const outside = path.join(DIR, 'outside.js');
      await fsp.writeFile(outside, "module.exports = () => 'outside';", 'utf8');
      let linked = true;
      try { await fsp.symlink(outside, path.join(base, 'lib', 'linked.js'), 'file'); }
      catch (_) {
        const jt = path.join(DIR, 'junction-target'); await fsp.mkdir(jt, { recursive: true }); try { await fsp.symlink(jt, path.join(base, 'lib', 'linkdir'), 'junction'); } catch (__) { linked = false; }
      }
      if (linked) {
        const found = await loader.discover();
        A.eq(found.plugins.length, 0, 'a plugin folder containing a link is not offered for approval');
        A.ok(found.errors.some(e => /helpered: .*link/.test(e)), 'and the refusal names the link');
      } else A.ok(true, 'symlinks unavailable here (no privilege) — link refusal covered on other hosts');
      for (const n of ['linked.js', 'linkdir']) { try { await fsp.rm(path.join(base, 'lib', n), { force: true }); } catch (_) { /* absent */ } }

      delete global.__helperSays;
    }
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true });
    delete global.__auditLog; delete global.__apiKeys; delete global.__spineReachable;
  }

  A.report('plugins.test');
})().catch(async (e) => {
  try { await fsp.rm(DIR, { recursive: true, force: true }); } catch (_) {}
  console.log('FAIL: plugins.test threw -- ' + (e && e.stack || e));
  process.exit(1);
});
