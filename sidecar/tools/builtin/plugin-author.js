/* sidecar/tools/builtin/plugin-author.js — THE CREW BUILDS PLUGINS (plugin extensions phase 4, 2026-09-29).

   "Make me a dashboard for my Stripe numbers" → an agent writes a real plugin. The whole flow is INERT until the
   Commander approves it, which is what makes it safe to hand to any agent:
     · agents write only into a DRAFT folder (<workspaces>/plugin-drafts/<id>) — never into plugins/ (a reserved id
       their file tools cannot touch) and never into their own workspace jail;
     · a draft never runs: plugin.preview opens its window in a DRAFT window (sandboxed page, a throwaway in-memory
       store, no backend), and plugin.check only parses and compiles;
     · plugin.submit copies the draft into plugins/<id> behind a consent card — and even then it is only INSTALLED:
       it stays off until the Commander approves its exact code in ABILITIES → EXTENSIONS (the hash-locked gate every
       plugin goes through). An agent can never switch its own plugin on.

   makePluginAuthorTools({ fsp, path, draftsDir, pluginsDir, template, parseScreens, relPathOk, compile, preview,
                           afterInstall, now }) -> { register(registry), _internals } */
'use strict';

const ID_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_FILE = 512 * 1024;
const MAX_FILES = 64;
const MAX_TOTAL = 8 * 1024 * 1024;
const READ_MAX = 64 * 1024;
const TEXT_EXT = /\.(?:html?|css|m?js|cjs|json|md|txt|svg|csv)$/i;
// The how-to the agent needs at the moment it starts (the full recipe is the opt-in `plugin-author` library skill).
const GUIDE = [
  'HOW PLUGINS WORK (keep to this):',
  '- WINDOW (ui/*.html): the station kit is injected automatically. The page is transparent (the window glass is its background). Build with kit classes, not your own chrome: sn-stack · sn-row-flex · sn-grid · sn-panel · sn-card · sn-sect (▮ header strip) + sn-list/sn-item rows · sn-stats/sn-stat · sn-table · sn-badge · dot ok|warn|bad · sn-btn (.primary .danger .xs) · sn-input · sn-select · sn-tabs/sn-tab · sn-empty · sn-error. Colours only via var(--ph), rgba(var(--ph-rgb),.2), var(--ok)/--bad/--warn. No white backgrounds, no other fonts, no glows.',
  '- BRIDGE in the page: await starnet.ready; starnet.store.get/set(key, json) (durable, shared with the code); starnet.ui.toast(text); starnet.ui.setTitle(text); starnet.ui.openLink("https://…"); starnet.backend.call(name, args).',
  '- CODE (index.js, "main"; optional — delete both for a window-only plugin): register(api) { api.tool({ name, description, parameters, readOnly, run(args) }); api.handle(name, fn); api.every(ms, fn); api.store.get/set }. Secrets and non-CORS APIs belong here, never in the page.',
  '- Then plugin.check → plugin.preview (ask the Commander how it looks) → plugin.submit. Submitted means installed OFF: the Commander approves it in ABILITIES → EXTENSIONS. Never say it is on before that.'
].join('\n');

function makePluginAuthorTools(deps) {
  const { fsp, path: P, draftsDir, pluginsDir } = deps;
  const template = deps.template;
  const parseScreens = deps.parseScreens;
  const relPathOk = deps.relPathOk;
  const compile = typeof deps.compile === 'function' ? deps.compile : null;   // (source, filename) -> error text | ''
  const preview = typeof deps.preview === 'function' ? deps.preview : null;   // (id, screenId) -> { ok, error? }
  const afterInstall = typeof deps.afterInstall === 'function' ? deps.afterInstall : async () => {};
  // a RUNNING plugin must be stopped (and gone) before its folder is replaced — Windows holds it open otherwise
  const beforeReplace = typeof deps.beforeReplace === 'function' ? deps.beforeReplace : async () => {};
  if (typeof deps.now !== 'function') throw new Error('plugin author tools require an injected clock { now }');
  const now = deps.now;

  const idOf = (a) => { const id = String((a && a.id) || '').trim(); if (!ID_RX.test(id)) throw new Error('`id` is the plugin folder name: letters, numbers, dot, dash or underscore (max 64), starting with a letter or number'); return id; };
  const draftDir = (id) => P.join(draftsDir, id);
  const exists = async (p) => { try { await fsp.stat(p); return true; } catch (_) { return false; } };

  async function listFiles(base) {
    const out = [];
    async function walk(dir, rel, depth) {
      if (depth > 8) return;
      let names = [];
      try { names = (await fsp.readdir(dir)).sort(); } catch (_) { return; }
      for (const name of names) {
        const abs = P.join(dir, name), r = rel ? rel + '/' + name : name;
        const st = await fsp.lstat(abs);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) await walk(abs, r, depth + 1);
        else if (st.isFile()) out.push({ path: r, bytes: st.size });
      }
    }
    await walk(base, '', 0);
    return out;
  }
  // Copies the MAIN data of each ordinary file (readFile/writeFile, never copyFile): copyFile would carry NTFS
  // alternate streams along, and those are invisible to the approval digest.
  async function copyTree(from, to) {
    await fsp.mkdir(to, { recursive: true });
    for (const f of await listFiles(from)) {
      if (!relPathOk(f.path)) continue;
      const dst = P.join(to, ...f.path.split('/'));
      await fsp.mkdir(P.dirname(dst), { recursive: true });
      await fsp.writeFile(dst, await fsp.readFile(P.join(from, ...f.path.split('/'))));
    }
  }
  async function readManifest(base) {
    try { return JSON.parse(await fsp.readFile(P.join(base, 'plugin.json'), 'utf8')); } catch (e) { return { __error: (e && e.code === 'ENOENT') ? 'plugin.json is missing' : 'plugin.json is not valid JSON: ' + ((e && e.message) || e) }; }
  }

  /* check(id) -> { ok, problems[], warnings[], screens, main } — everything that can be proven WITHOUT running it. */
  async function check(id) {
    const base = draftDir(id);
    if (!(await exists(base))) return { ok: false, problems: ['there is no draft named "' + id + '" — start one with plugin.draft_start'], warnings: [] };
    const problems = [], warnings = [];
    const files = await listFiles(base);
    const fileSet = new Set(files.map(f => f.path));
    const m = await readManifest(base);
    if (m.__error) problems.push(m.__error);
    const manifest = m.__error ? {} : m;
    if (!m.__error && !manifest.name) warnings.push('plugin.json has no "name" — the Commander will see the folder id instead');
    const sc = parseScreens(manifest, fileSet);
    for (const e of sc.errors) problems.push('screens: ' + e);
    const uiOnly = manifest.main == null && sc.screens.length > 0;
    const main = uiOnly ? '' : String(manifest.main || 'index.js');
    if (main && !fileSet.has(main)) problems.push('"main" names ' + main + ', which does not exist' + (sc.screens.length ? ' (drop "main" for a window-only plugin)' : ''));
    if (!main && !sc.screens.length) problems.push('the plugin has neither code ("main") nor windows ("screens")');
    if (compile) {
      for (const f of files) {
        if (!/\.(?:c?js)$/i.test(f.path) || f.bytes > MAX_FILE) continue;
        const err = compile(await fsp.readFile(P.join(base, ...f.path.split('/')), 'utf8'), f.path);
        if (err) problems.push(f.path + ': ' + err);
      }
    }
    // THE LOOK CHECK — warnings, never blocks (full customization means the author has the last word)
    for (const s of sc.screens) {
      if (!fileSet.has(s.entry)) continue;
      const html = await fsp.readFile(P.join(base, ...s.entry.split('/')), 'utf8');
      const css = html + ' ' + (await Promise.all(files.filter(f => /\.css$/i.test(f.path)).map(f => fsp.readFile(P.join(base, ...f.path.split('/')), 'utf8')))).join(' ');
      if (/background(?:-color)?\s*:\s*(?:#fff\b|#ffffff\b|white\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i.test(css)) warnings.push(s.entry + ': a white background — the station look is the window\'s glass (leave the page transparent)');
      if (/font-family\s*:\s*(?![^;]*VT323)(?![^;]*var\(--sn-font\))[^;]*(?:arial|helvetica|inter|roboto|segoe|sans-serif)/i.test(css)) warnings.push(s.entry + ': a font other than the station\'s VT323 (use var(--sn-font), or leave font-family to the kit)');
      if (/(?:box|text)-shadow\s*:[^;]*\b0\s+0\s+\d{2,}px/i.test(css)) warnings.push(s.entry + ': a glow shadow — the station is matte (edges and light, no glows)');
      if (!/class="[^"]*\bsn-/.test(html)) warnings.push(s.entry + ': uses no kit classes (sn-*) — it will not look like the rest of the station');
    }
    const total = files.reduce((n, f) => n + f.bytes, 0);
    return { ok: problems.length === 0, problems, warnings, files: files.length, bytes: total, main: main || null, screens: sc.screens };
  }

  const tools = [
    {
      name: 'plugin.draft_start',
      description: 'Start a Agent OS plugin DRAFT (a plugin is the Commander\'s own app/dashboard/tool inside Agent OS: windows built from the station kit, plus optional code with crew tools). '
        + 'Starts from a working template (a window with a notes list + a KIT reference tab, and code with two example tools). To change an INSTALLED plugin use plugin.draft_from_installed instead. '
        + 'Drafts never run. Then edit with plugin.draft_write, check with plugin.check, show with plugin.preview, and install with plugin.submit.',
      schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', description: 'folder id, e.g. "pr-radar"' },
        name: { type: 'string', description: 'display name, e.g. "PR Radar"' },
        description: { type: 'string' },
        replace: { type: 'boolean', description: 'discard an existing draft with this id first' }
      } },
      run: async (a) => {
        const id = idOf(a);
        const base = draftDir(id);
        if (await exists(base)) {
          if (!a.replace) return { content: 'A draft named "' + id + '" already exists — keep editing it (plugin.draft_read lists its files), or pass replace:true to start over.', summary: 'draft exists' };
          await fsp.rm(base, { recursive: true, force: true });
        }
        const files = template({ id, name: String(a.name || id).slice(0, 60), description: String(a.description || '').slice(0, 300) });
        for (const rel of Object.keys(files)) {
          const dst = P.join(base, ...rel.split('/'));
          await fsp.mkdir(P.dirname(dst), { recursive: true });
          await fsp.writeFile(dst, files[rel], 'utf8');
        }
        const list = await listFiles(base);
        return {
          content: 'Draft "' + id + '" ready with ' + list.length + ' files: ' + list.map(f => f.path).join(', ') + '. Read them with plugin.draft_read before editing.\n'
            + GUIDE,
          summary: 'plugin draft ' + id
        };
      }
    },
    {
      name: 'plugin.draft_from_installed',
      description: 'Copy an INSTALLED plugin into a draft so you can change it (asks the Commander first: it reads that plugin\'s code). Then edit with plugin.draft_write and plugin.submit it — the installed plugin turns off until the Commander approves the new version.',
      schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', description: 'the installed plugin\'s folder id' },
        replace: { type: 'boolean', description: 'discard an existing draft with this id first' }
      } },
      run: async (a) => {
        const id = idOf(a);
        const src = P.join(pluginsDir, id);
        if (!(await exists(src))) throw new Error('no installed plugin named "' + id + '"');
        const base = draftDir(id);
        if (await exists(base)) {
          if (!a.replace) return { content: 'A draft named "' + id + '" already exists — keep editing it, or pass replace:true to copy the installed plugin over it.', summary: 'draft exists' };
          await fsp.rm(base, { recursive: true, force: true });
        }
        await copyTree(src, base);
        const list = await listFiles(base);
        return { content: 'Draft "' + id + '" ready with ' + list.length + ' files copied from the installed plugin: ' + list.map(f => f.path).join(', ') + '.\n' + GUIDE, summary: 'plugin draft from installed ' + id };
      }
    },
    {
      name: 'plugin.draft_read',
      description: 'List a plugin draft\'s files (no path), or read one file (path). Use before editing.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, path: { type: 'string', description: 'a file inside the draft, e.g. "ui/index.html"' } } },
      run: async (a) => {
        const id = idOf(a);
        const base = draftDir(id);
        if (!(await exists(base))) throw new Error('there is no draft named "' + id + '"');
        if (!a.path) {
          const list = await listFiles(base);
          return { content: list.map(f => f.path + '  (' + f.bytes + ' bytes)').join('\n') || '(empty)', summary: 'draft files ' + id };
        }
        const rel = String(a.path).replace(/^\.\//, '');
        if (!relPathOk(rel)) throw new Error('`path` must be a relative path inside the draft');
        const text = await fsp.readFile(P.join(base, ...rel.split('/')), 'utf8');
        return { content: text.length > READ_MAX ? text.slice(0, READ_MAX) + '\n…[truncated at 64 KB]' : text, summary: 'read ' + rel };
      }
    },
    {
      name: 'plugin.draft_write',
      description: 'Write (create or replace) one file in a plugin draft: plugin.json, index.js (code with api.tool / api.handle / api.on / api.every / api.store), or window files under ui/ (HTML/CSS/JS — the station kit and the `starnet` bridge are injected automatically; use sn-* classes). Whole-file writes.',
      schema: { type: 'object', required: ['id', 'path', 'content'], properties: {
        id: { type: 'string' }, path: { type: 'string', description: 'e.g. "ui/index.html"' }, content: { type: 'string', description: 'the COMPLETE file content' }
      } },
      run: async (a) => {
        const id = idOf(a);
        const base = draftDir(id);
        if (!(await exists(base))) throw new Error('there is no draft named "' + id + '" — start one with plugin.draft_start');
        const rel = String(a.path || '').replace(/^\.\//, '');
        if (!relPathOk(rel)) throw new Error('`path` must be a relative path inside the draft (no .., no absolute paths, no dot-folders)');
        if (!TEXT_EXT.test(rel)) throw new Error('only text files can be written: .html .css .js .mjs .json .md .txt .svg .csv');
        const content = String(a.content == null ? '' : a.content);
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE) throw new Error('a file may be at most 512 KB');
        const list = await listFiles(base);
        const existing = list.find(f => f.path === rel);
        if (!existing && list.length >= MAX_FILES) throw new Error('a draft may hold at most ' + MAX_FILES + ' files');
        const total = list.reduce((n, f) => n + (f.path === rel ? 0 : f.bytes), 0) + Buffer.byteLength(content, 'utf8');
        if (total > MAX_TOTAL) throw new Error('a draft may hold at most 8 MB');
        const dst = P.join(base, ...rel.split('/'));
        await fsp.mkdir(P.dirname(dst), { recursive: true });
        await fsp.writeFile(dst, content, 'utf8');
        return { content: (existing ? 'Replaced ' : 'Wrote ') + rel + ' (' + Buffer.byteLength(content, 'utf8') + ' bytes). Run plugin.check before previewing.', summary: 'wrote ' + rel };
      }
    },
    {
      name: 'plugin.check',
      description: 'Check a plugin draft without running it: the manifest, its windows, that every .js file compiles, and a look check against the station style (warnings only).',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async (a) => {
        const r = await check(idOf(a));
        const lines = [r.ok ? 'OK — no problems.' : 'PROBLEMS (fix before submitting):'].concat(r.problems.map(p => '- ' + p));
        if (r.warnings.length) lines.push('Look warnings:', ...r.warnings.map(w => '- ' + w));
        if (r.screens) lines.push('Windows: ' + (r.screens.map(s => s.id + ' → ' + s.entry).join(', ') || 'none') + ' · code: ' + (r.main || 'none'));
        return { content: lines.join('\n'), summary: r.ok ? 'plugin check ok' : 'plugin check: ' + r.problems.length + ' problem(s)' };
      }
    },
    {
      name: 'plugin.preview',
      description: 'Open a plugin draft\'s window on the Commander\'s screen as a DRAFT window, so they (and you, from their reply) can see it. The page runs sandboxed with no network, a throwaway store and no backend. Open it again after edits to show the new version.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, screen: { type: 'string', description: 'screen id (default: the first)' } } },
      run: async (a) => {
        const id = idOf(a);
        const r = await check(id);
        if (!r.screens || !r.screens.length) throw new Error('this draft has no windows to preview' + (r.problems.length ? ': ' + r.problems.join('; ') : ''));
        if (!preview) throw new Error('previews need the Agent OS window open');
        const out = await preview(id, a.screen ? String(a.screen) : r.screens[0].id);
        if (!out || !out.ok) throw new Error((out && out.error) || 'the station could not open the preview');
        return { content: 'The DRAFT window "' + (out.title || id) + '" is open on the Commander\'s screen. Ask them how it looks; edit and preview again as needed, then plugin.submit.', summary: 'previewed ' + id };
      }
    },
    {
      name: 'plugin.submit',
      description: 'Install a checked plugin draft into Agent OS. It is installed OFF: the Commander switches it on in ABILITIES → EXTENSIONS after reviewing its code (you cannot approve it). Replacing an installed plugin turns it off until they approve the new code.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async (a) => {
        const id = idOf(a);
        const r = await check(id);
        if (!r.ok) throw new Error('fix these first: ' + r.problems.join('; '));
        const dst = P.join(pluginsDir, id);
        const replacing = await exists(dst);
        if (replacing) await beforeReplace(id);
        // Stage beside, then swap: a half-copied plugin folder must never be what discovery sees.
        const staging = P.join(draftsDir, '.staging-' + id + '-' + now());
        await copyTree(draftDir(id), staging);
        await fsp.mkdir(pluginsDir, { recursive: true });
        if (replacing) await fsp.rm(dst, { recursive: true, force: true });
        await fsp.rename(staging, dst);
        await afterInstall(id);
        return {
          content: (replacing ? 'Replaced' : 'Installed') + ' the "' + id + '" plugin — it is OFF until the Commander approves it: ABILITIES → CREATE / ADVANCED → EXTENSIONS → APPROVE & ENABLE. '
            + 'Tell them that, and what it does. Once on, its window opens from EXTENSIONS' + (r.main ? ', and any tools reach agents through its PLUGIN TERMINAL (placed automatically in the lead\'s room)' : '') + '.',
          summary: (replacing ? 'replaced' : 'installed') + ' plugin ' + id + ' (awaiting approval)'
        };
      }
    }
  ];

  // Inert until approved (drafts never run; submit installs OFF), so none of this is a host-process effect.
  // submit alone asks first: it changes what is installed on the Commander's station.
  const ASKS = { 'plugin.submit': 1, 'plugin.draft_from_installed': 1 };
  const defs = tools.map(t => Object.assign({
    // submit is EXECUTE scope: the consent broker never lets a cached "Always" or an unattended run carry it —
    // installing (or replacing, which turns the old plugin off) is decided by a watching Commander every time
    scope: t.name === 'plugin.submit' ? 'execute' : (/draft_(?:start|write|from_installed)$/.test(t.name) ? 'write' : 'read'),
    readOnly: t.name === 'plugin.draft_read' || t.name === 'plugin.check',
    capability: 'pluginauthor',
    impact: 'none',
    requiresConsent: !!ASKS[t.name],
    // a cached "Always" never carries submit on ANY surface (the broker only refused it for unattended runs) — 2026-10-10
    freshConsent: t.name === 'plugin.submit',
    network: false
  }, t));

  return {
    register(registry) { for (const d of defs) registry.register(d); },
    defs,
    _internals: { check, listFiles }
  };
}

function toolNames() { return ['plugin.draft_start', 'plugin.draft_from_installed', 'plugin.draft_read', 'plugin.draft_write', 'plugin.check', 'plugin.preview', 'plugin.submit']; }

module.exports = { makePluginAuthorTools, toolNames };
