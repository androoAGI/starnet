/* node test/apps.test.js — APPS: describe it, get it (2026-09-29).

   sidecar/apps.js + sidecar/tools/builtin/apps.js against real temp folders and the real plugin store:
     - create names a unique id from the name and writes the "building" page (escaped by the host's template);
     - the page files are bounded (paths, types, sizes, app.json is the station's) and a write moves the digest
       (a new URL, so the open window reloads) and tells the window;
     - publish stores the data plus the station's own _meta { updatedAt } (never writable by the crew) and tells the window;
     - schedule makes ONE routine (replacing any old one), "off" removes it, describe reports the routine's truth
       (a deleted routine reads `missing`, never a schedule that will not fire);
     - remove takes the routine and the data with it;
     - the tools: capability apps, impact none, no consent, every one granted to the computer — and check lints the look. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const vm = require('node:vm');
const crypto = require('crypto');
const { makeApps, slugify } = require('../sidecar/apps.js');
const { makeAppTools, toolNames } = require('../sidecar/tools/builtin/apps.js');
const { makePluginLoader, _internals } = require('../sidecar/plugins.js');
const { makePluginStore } = require('../sidecar/plugin-surface.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

const DIR = path.join(os.tmpdir(), 'starnet-apps-' + process.pid);
const loader = makePluginLoader({ fsp, pathMod: path, dir: path.join(DIR, 'plugins'), allowFile: path.join(DIR, 'allow.json'), requireModule: () => ({}), hash: (s) => crypto.createHash('sha256').update(String(s)).digest('hex'), onError() {} });
const mem = new Map();
const store = makePluginStore({ store: { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v), update: async (k, fn) => { const n = fn(mem.get(k)); if (n !== undefined) mem.set(k, n); } } });
let clock = 1000;
const jobs = new Map(); let jobSeq = 0; let armed = false;
const cron = {
  create: async (spec) => { const id = 'job' + (++jobSeq); jobs.set(id, Object.assign({ id, scheduleDisplay: 'every 24h', nextRunAt: '2027-01-01T09:00:00Z' }, spec)); return { ok: true, job: jobs.get(id) }; },
  remove: async (id) => { jobs.delete(id); },
  get: (id) => jobs.get(id) || null,
  armed: () => armed
};
const told = [];
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const apps = makeApps({
  fsp, path, dir: path.join(DIR, 'apps'), store, treeDigest: (d) => loader._internals.treeDigest(d), relPathOk: _internals.relPathOk,
  now: () => clock,
  template: ({ name, description }) => ({ 'index.html': '<title>' + esc(name) + '</title><p class="sn-hint">' + esc(description) + '</p>' }),
  cron, notify: { reload: (id, digest) => told.push(['reload', id, digest]), data: (id) => told.push(['data', id]) }
});
const tools = makeAppTools({ apps, now: () => Date.UTC(2026, 8, 29, 12), compile: (src, file) => { try { new vm.Script(src, { filename: file }); return ''; } catch (e) { return e.message; } } });
const run = (n, a) => tools.defs.find(d => d.name === n).run(a);
const throwsMsg = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };

(async () => {
  try {
    A.throws(() => makeApps({ fsp, path, dir: DIR }), 'apps without an injected clock is refused');
    // the crew finds app.create by searching "app": its description must keep OUTSIDE builds away (a Netlify site and
    // a React todo became StarNet apps on 10-02 before this line)
    const createDesc = tools.defs.find(d => d.name === 'app.create').description;
    A.ok(/INSIDE StarNet/.test(createDesc) && /NOT for anything meant to run, be published or be shipped outside StarNet/.test(createDesc) && /framework codebase/.test(createDesc) && /add-on for the Commander's own web browser/.test(createDesc), 'app.create says it is only for apps inside StarNet, never a site/project/script to ship elsewhere');
    // (sweep 2026-10-02) …without the words people SEARCH for those asks: tool_search matches description substrings and
    // shows only the first sentence, so "a website, a React project, a browser extension" made it reveal app.create as
    // the top hit for exactly "browser extension" / "host a site" / "react project"
    A.ok(!/\b(extensions?|websites?|react|host(ed|ing)?|desktop|site)\b/i.test(createDesc), 'app.create names none of the words a search for an outside build would match: ' + (createDesc.match(/\b(extensions?|websites?|react|host(ed|ing)?|desktop|site)\b/ig) || []).join(','));
    A.eq(slugify('AI News Brief!'), 'ai-news-brief', 'the id comes from the name');
    A.eq(slugify('***'), 'app', 'a name with no letters still gets an id');

    // ---- create ----
    const a = await apps.create({ name: 'AI News Brief', description: 'Top <b>AI</b> news\nevery 24h' });
    A.eq(a.id, 'ai-news-brief', 'create names the app from its name');
    A.eq(a.description, 'Top <b>AI</b> news every 24h', 'the description is one plain line');
    const b = await apps.create({ name: 'AI News Brief' });
    A.eq(b.id, 'ai-news-brief-2', 'a second app with the same name gets its own id');
    A.ok(/Top &lt;b&gt;AI&lt;\/b&gt;/.test(await apps.readFile(a.id, 'index.html')), 'the building page shows the description escaped');
    A.ok(/give the app a name/.test(await throwsMsg(() => apps.create({ name: '  ' }))), 'an app needs a name');
    A.ok(/there is no app/.test(await throwsMsg(() => apps.need('ghost'))), 'an unknown app is refused by name');
    A.ok(/app id/.test(await throwsMsg(() => apps.need('../x'))), 'an id that is not an app id is refused');

    // ---- the page ----
    const d0 = (await apps.record(a.id)).digest;
    told.length = 0;
    clock += 5000;
    await apps.writeFile(a.id, 'index.html', '<div class="sn-panel">hi</div><script>starnet.store.get("brief")</script>');
    const d1 = (await apps.record(a.id)).digest;
    A.ok(d0 && d1 && d0 !== d1, 'writing the page moves its digest (a new URL)');
    A.eq(told[0], ['reload', a.id, d1], 'a write tells the open window to reload onto the new digest');
    A.ok(/page file/.test(await throwsMsg(() => apps.writeFile(a.id, 'app.json', '{}'))), 'app.json is the station\'s, never the crew\'s');
    A.ok(/page file/.test(await throwsMsg(() => apps.writeFile(a.id, '../escape.html', 'x'))), 'a path outside the app is refused');
    A.ok(/page file/.test(await throwsMsg(() => apps.writeFile(a.id, 'index.html:evil', 'x'))), 'an NTFS stream path is refused');
    A.ok(/page file/.test(await throwsMsg(() => apps.writeFile(a.id, 'App.JSON', '{}'))), 'nor under another case (Windows would overwrite it)');
    A.ok(/page file/.test(await throwsMsg(() => apps.writeFile(a.id, 'a/b/c/d/e/deep.js', 'x'))), 'a path deeper than the file walk sees is refused (the size caps must see every file)');
    A.ok((await apps.describe(a.id)).builtAt === clock, 'the first page write marks the app built');
    const built0 = clock; clock += 7000;
    await apps.writeFile(a.id, 'index.html', '<div class="sn-panel">hi again</div>');
    const dChanged = await apps.describe(a.id);
    A.ok(dChanged.builtAt === built0 && dChanged.changedAt === clock, 'every later write moves changedAt (an automated redesign shows as "Updated"), builtAt stays the first');
    await apps.writeFile(a.id, 'big.js', '//' + 'x'.repeat(70 * 1024) + '\nvar tail = 1;');
    A.ok(/truncated/.test(await apps.readFile(a.id, 'big.js')) && /var tail = 1;$/.test(await apps.readWhole(a.id, 'big.js')), 'readFile shows 64 KB; readWhole (the check) reads it all');
    A.ok(/only text files/.test(await throwsMsg(() => apps.writeFile(a.id, 'run.exe', 'x'))), 'only text files');
    A.ok(/512 KB/.test(await throwsMsg(() => apps.writeFile(a.id, 'big.txt', 'x'.repeat(512 * 1024 + 1)))), 'a file is bounded');

    // ---- data ----
    told.length = 0;
    await apps.publish(a.id, 'brief', { date: '2026-09-29', items: [{ title: 'T', source: 'S' }] });
    A.eq((await apps.dataGet(a.id, 'brief')).items[0].title, 'T', 'publish stores the data the page reads');
    A.eq((await apps.dataGet(a.id, '_meta')).updatedAt, clock, 'the station stamps when it was updated');
    A.eq(await apps.dataKeys(a.id), ['brief'], 'the station\'s _meta is not listed as the app\'s data');
    A.eq(told, [['data', a.id]], 'publish tells the open window');
    await apps.publish(a.id, 'brief', JSON.stringify({ items: [{ title: 'S' }] }));
    A.eq((await apps.dataGet(a.id, 'brief')).items[0].title, 'S', 'JSON sent as text (models do this) is stored as the value the page reads');
    await apps.publish(a.id, 'note', '{ not json');
    A.eq(await apps.dataGet(a.id, 'note'), '{ not json', 'plain text stays text');
    A.ok(/kept by the station/.test(await throwsMsg(() => apps.publish(a.id, '_meta', { updatedAt: 9e12 }))), 'the crew cannot forge the updated time');
    A.ok(/store key/.test(await throwsMsg(() => apps.publish(a.id, 'bad key!', 1))), 'a bad key is refused');

    // ---- schedule ----
    const s = await apps.schedule(a.id, { every: 'every 24h', task: 'research today\'s AI news' });
    A.eq(s.jobId, 'job1', 'schedule makes a routine');
    A.eq(s.armed, false, 'and says honestly whether routines are on');
    const job = jobs.get('job1');
    A.ok(job.name === 'App: AI News Brief' && job.meta.appId === a.id && /app\.publish/.test(job.prompt) && /research today's AI news/.test(job.prompt), 'the routine runs the task and ends by publishing to this app');
    // a routine's reply is normally its delivery (CRON_ROUTINE_NOTE); an app's update delivers INTO the app
    A.ok(/THE APP IS THE DELIVERY/.test(job.prompt) && /never put the result in your reply instead/.test(job.prompt), 'the routine is told the app, not its reply, is the delivery');
    A.ok(/real date is in your \[RUNTIME\] block/.test(job.prompt) && !/FIRST call app\.read/.test(job.prompt), 'the routine points at the real date in its [RUNTIME] block (no tool call just to learn the date)');
    A.ok(/app\.write the whole new file/.test(job.prompt) && /app\.check/.test(job.prompt), 'an automated update may change the app ITSELF (rewrite + check the page), not only its data');
    A.eq((await apps.describe(a.id)).schedule.task, 'research today\'s AI news', 'describe gives the task back (the AUTO-UPDATE box shows the Commander\'s own words)');
    let desc = await apps.describe(a.id);
    A.ok(desc.schedule && desc.schedule.nextRunAt === null && desc.schedule.held === 'off' && desc.schedule.armed === false && desc.updatedAt === clock, 'describe withholds a disarmed fire and keeps the last update');
    A.eq(job.nextRunAt, '2027-01-01T09:00:00Z', 'withholding the clock does not change the stored schedule');
    armed = true;
    A.eq((await apps.describe(a.id)).schedule.nextFireAt, job.nextRunAt, 'arming restores the shared clock');
    cron.scheduler = () => ({ enabled: true, degraded: true });
    A.eq((await apps.describe(a.id)).schedule.nextFireAt, null, 'degraded storage holds an armed app routine');
    A.eq((await apps.describe(a.id)).schedule.held, 'degraded', 'app names the storage hold');
    delete cron.scheduler; armed = false;
    await apps.schedule(a.id, { every: 'every 6h', task: 'again' });
    A.ok(!jobs.has('job1') && jobs.has('job2'), 'rescheduling replaces the routine (never two)');
    A.ok(/task/.test(await throwsMsg(() => apps.schedule(a.id, { every: 'every 1h' }))), 'a schedule needs a task');
    A.ok(jobs.has('job2') && (await apps.describe(a.id)).schedule.jobId === 'job2', 'a refused schedule keeps the old routine (nothing is retired before the new one exists)');
    // the station hands back ANOTHER routine as a "duplicate" (its near-name guard): never adopted, never deleted
    jobs.set('foreign', { id: 'foreign', name: 'App: Tech News', meta: { appId: 'tech-news' } });
    const realCreate = cron.create;
    cron.create = async () => ({ ok: true, job: jobs.get('foreign') });
    A.ok(/another routine/.test(await throwsMsg(() => apps.schedule(a.id, { every: 'every 2h', task: 't' }))), 'a routine that is not this app\'s own new one is refused');
    A.ok(jobs.has('job2') && jobs.has('foreign') && (await apps.describe(a.id)).schedule.jobId === 'job2', 'and both the app\'s routine and the other one are untouched');
    cron.create = realCreate;
    // app.json pointed at someone else's routine (however it got there): deleting/rescheduling never removes it
    const metaFile = path.join(DIR, 'apps', a.id, 'app.json');
    const saved = await fsp.readFile(metaFile, 'utf8');
    await fsp.writeFile(metaFile, saved.replace('"job2"', '"foreign"'));
    await apps.schedule(a.id, { every: 'off' });
    A.ok(jobs.has('foreign'), 'an app never retires a routine that belongs to another app');
    await fsp.writeFile(metaFile, saved);
    jobs.delete('job2');
    desc = await apps.describe(a.id);
    A.ok(desc.schedule && desc.schedule.missing === true, 'a routine deleted elsewhere reads as missing, never as a live schedule');
    const off = await apps.schedule(a.id, { every: 'off' });
    A.ok(off.off && (await apps.describe(a.id)).schedule === null, '"off" clears the schedule');
    A.ok((await apps.schedule(a.id, { every: 'off' })).unchanged === true, '"off" when already off changes nothing (no write, no false "turned off")');
    // EDIT IN PLACE: with the station's cron.update the app's own routine is changed, never replaced (history, pause
    // and grants stay; a running update is not cancelled) — and any orphan routine of this app is retired
    told.length = 0;
    cron.update = async (jid, p) => { const j = jobs.get(jid); if (!j) return { ok: false, error: 'gone' }; Object.assign(j, { schedule: p.schedule, prompt: p.prompt, name: p.name }); return { ok: true, job: j }; };
    cron.ownedBy = (appId) => [...jobs.values()].filter((j) => j.meta && j.meta.appId === appId).map((j) => j.id);
    const s1 = await apps.schedule(a.id, { every: 'every 1h', task: 'one' });
    jobs.set('orphan', { id: 'orphan', name: 'App: AI News Brief', meta: { appId: a.id } });
    const s2 = await apps.schedule(a.id, { every: 'every 6h', task: 'two' });
    A.ok(s2.jobId === s1.jobId && jobs.get(s1.jobId).schedule === 'every 6h' && /two/.test(jobs.get(s1.jobId).prompt), 'a second SAVE edits the same routine in place');
    { let seenPatch = null; const upd = cron.update; cron.update = async (jid, p) => { seenPatch = p; return upd(jid, p); };
      await apps.schedule(a.id, { every: 'every 6h', task: 'crew task', byAgent: true });
      A.ok(seenPatch && seenPatch.byAgent === true && /as the crew set it up/.test(seenPatch.prompt) && !/Commander's own words/.test(seenPatch.prompt), 'QA 10-02: a crew edit reaches the station as the crew (its grants drop) and never claims to be the Commander\'s words');
      await apps.schedule(a.id, { every: 'every 6h', task: 'two' });
      A.ok(seenPatch && seenPatch.byAgent === false && /Commander's own words/.test(seenPatch.prompt), 'the Commander\'s own SAVE stays the Commander\'s words');
      // review 10-02: a crew edit that changes only HOW OFTEN keeps the exact prompt — no grant drop, no relabel
      const before = seenPatch.prompt;
      await apps.schedule(a.id, { every: 'every 12h', task: 'two', byAgent: true });
      A.ok(seenPatch && seenPatch.byAgent === false && seenPatch.prompt === before && seenPatch.schedule === 'every 12h', 'a crew schedule-only change keeps the prompt byte-for-byte (grants and the Commander\'s words stay)');
      cron.update = upd; }
    A.ok(!jobs.has('orphan'), 'an orphan routine of the same app (from a race) is retired');
    A.ok(told.every((t) => t[0] === 'data'), 'a schedule change refreshes the bar only — it never reloads the open app window');
    // racing writes are serialized: both land, one routine remains
    await Promise.all([apps.schedule(a.id, { every: 'every 2h', task: 'race a' }), apps.schedule(a.id, { every: 'every 3h', task: 'race b' })]);
    A.eq(cron.ownedBy(a.id).length, 1, 'two schedule changes at once leave exactly one routine');
    await apps.schedule(a.id, { every: 'off' });
    delete cron.update; delete cron.ownedBy;

    // ---- rename / list / remove ----
    await apps.rename(b.id, 'Market Pulse');
    A.eq((await apps.list()).map(x => x.name), ['AI News Brief', 'Market Pulse'], 'list shows every app by its name');
    await apps.schedule(b.id, { every: 'every 24h', task: 'x' });
    await apps.publish(b.id, 'k', 1);
    const bJob = [...jobs.keys()].pop();
    await apps.remove(b.id);
    A.ok(!jobs.has(bJob), 'deleting an app deletes its routine');
    A.eq((await store.op(b.id, 'keys')).value, [], 'and its data');
    A.eq((await apps.list()).map(x => x.id), ['ai-news-brief'], 'and the app');

    // ---- the tools ----
    A.eq(tools.defs.map(d => d.name), toolNames(), 'the tool list matches toolNames()');
    A.ok(tools.defs.every(d => d.capability === 'apps' && d.impact === 'none' && d.requiresConsent === false), 'app tools: capability apps, impact none, never ask');
    A.eq(tools.defs.filter(d => d.taintLocked === true).map(d => d.name), ['app.schedule'], 'only app.schedule is taint-locked: a run that read the web cannot rewrite what every later refresh obeys');
    A.ok(require('../sidecar/taint.js').allowedWhenTainted(tools.defs.find(d => d.name === 'app.publish')) === true && require('../sidecar/taint.js').allowedWhenTainted(tools.defs.find(d => d.name === 'app.schedule')) === false, 'a tainted run may still publish, but not schedule');
    A.ok(/not both/.test(await throwsMsg(() => run('app.read', { app: a.id, path: 'index.html', key: 'brief' }))), 'app.read with a path AND a key says so');
    const grants = CAP_REGISTRY.computer ? JSON.stringify(CAP_REGISTRY.computer) : JSON.stringify(CAP_REGISTRY);
    A.ok(toolNames().every(n => grants.includes(n)), 'every app tool is granted by the computer');
    const r = await run('app.read', { app: a.id });
    A.ok(/^Today is \w+day, September 29, 2026/.test(r.content), 'app.read opens with the station\'s real date');
    A.ok(/Data keys: brief/.test(r.content) && /HOW A STARNET APP WORKS/.test(r.content), 'app.read lists the data keys and carries the build guide');
    A.ok(/OK — no problems/.test((await run('app.check', { app: a.id })).content), 'a good page checks clean');
    await run('app.write', { app: a.id, path: 'index.html', content: '<body style="background:#fff"><script>fetch("https://x"); (</script></body>' });
    const c = (await run('app.check', { app: a.id })).content;
    A.ok(/PROBLEMS/.test(c) && /white background/.test(c) && /no kit classes/.test(c) && /network/.test(c), 'check reports a broken script and the look/network warnings');
    await run('app.write', { app: a.id, path: 'index.html', content: '<div class="sn-card"></div><script>const h = (u) => `<a href="${u}" onclick="starnet.ui.openLink(${JSON.stringify(u)})">x</a>`;</script>' });
    A.ok(/JSON\.stringify inside an onclick/.test((await run('app.check', { app: a.id })).content), 'check flags a URL quoted into an inline onclick (the bug that framed a news site)');
    const made = await run('app.create', { name: 'Reading List' });
    A.ok(/id: reading-list/.test(made.content), 'app.create (from chat) makes a new app');
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true }).catch(() => {});
  }
  A.report ? A.report('apps.test') : process.exit(0);
})();
