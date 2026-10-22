/* sidecar/tools/builtin/apps.js — the crew's side of APPS (sidecar/apps.js).

   The Commander describes an app in their own words (a tracker, a timer, a dashboard, a game…); the lead builds it:
     app.create    a new app (the APPS window's NEW APP does this for the Commander; the tool is for "make me an app…" in chat)
     app.read      what an app is made of: its files, its data keys, its schedule — or one file / one data value
     app.write     write one page file (index.html …) — the open window reloads onto it at once
     app.check     compile its scripts and look-check it against the station style (never runs anything)
     app.publish   put data into the app (what its page shows) — scheduled refreshes end with this
     app.schedule  refresh it on a schedule ("every 24h", "0 8 * * *") with a task; "off" stops it
   All of it is inert until a page draws or a routine runs: the page is a network-less sandbox, and the scheduled
   task is an ordinary routine under the station's normal rules. So none of these ask first. */
'use strict';

const GUIDE = [
  'HOW A AGENT OS APP WORKS (keep to this):',
  '- A Agent OS app lives INSIDE Agent OS. If the Commander asked for something to host, ship or run elsewhere (a website for Netlify, a React project, a script, an extension), this was the wrong tool: build real files instead, and tell the Commander this empty app can be removed from APPS.',
  '- The app is ONE page: index.html (put CSS/JS inline or in style.css / app.js beside it). It opens in a Agent OS window.',
  '- IT IS THE COMMANDER\'S APP — it can be ANYTHING: a dashboard, a tracker, a calculator, a timer, a game, a canvas toy. If they describe a look, layout, colours, fonts, animation or behaviour, build EXACTLY that with your own CSS/JS/canvas/SVG — their wish beats the station style. Only when they did not say how it should look, make it native:',
  '- DEFAULT LOOK (no look asked for): the station kit is injected automatically — build with its classes so the app looks native: sn-stack · sn-row-flex · sn-grid · sn-panel · sn-card · sn-sect (▮ header strip) + sn-list/sn-item rows · sn-stats/sn-stat (<b>value</b><span>LABEL</span>) · sn-table · sn-badge · dot ok|warn|bad · sn-title · sn-label · sn-hint · sn-muted · sn-btn (.primary .xs) · sn-input · sn-select · sn-tabs/sn-tab.on · sn-empty · sn-loading · sn-error. Colours via var(--ph), rgba(var(--ph-rgb),.2), var(--ok) --bad --warn; the page background stays transparent (the window glass shows through).',
  '- INTERACTIVE apps keep the Commander\'s own input with starnet.store.set(key, value) / starnet.store.get(key) / starnet.store.delete(key) / starnet.store.keys() (JSON, saved on the station, survives reloads) — a tracker, a to-do, settings, a high score. Never localStorage (the sandbox has none).',
  '- Hard limits (the sandbox, not a style rule): the page has no network and loads nothing from the web (no CDN scripts, web fonts or remote images — inline everything, draw with CSS/SVG/canvas, images only as data: URIs); files are text.',
  '- TIME: your own sense of today\'s date is WRONG (it is your training era). app.read states the station\'s real date — anything current (news, prices, "today") is searched for THAT date, and every item you publish is from it.',
  '- The page has NO network: it never fetches anything. Its content is DATA you publish with app.publish(app, key, value) — any JSON (e.g. key "items": [{ title, detail, url }]).',
  '- In the page: const data = await starnet.store.get("items"); render it; and re-render when new data lands: starnet.onData(async () => { … }). Show an empty state (sn-empty) until the first data arrives, and a small "updated <time>" line (data._meta is kept by the station: await starnet.store.get("_meta") → { updatedAt }).',
  '- Links: a plain <a href="https://…"> opens in the Commander\'s browser (the station catches the click) — just link. Never put a URL inside an inline onclick="…" attribute (its quotes break the attribute); for a whole clickable row, wrap it in the <a>.',
  '- AUTOMATION: an app can update itself on any cadence ("every 15m", "every 1h", "0 8 * * *"). Each update is a crew run doing the `task` — publishing fresh data AND/OR changing the page itself (a new layout each week, a theme that follows the season). The Commander can also set or change this from AUTO-UPDATE under the app. Anything that must tick live (a clock, a timer, an animation) the page does itself in JS — never a run per second.',
  '- If it should update by itself (daily, hourly…), call app.schedule with `every` and the `task` each refresh performs (e.g. "gather what the crew finished this week and publish it with app.publish key items"). Schedule FIRST, before you search or read anything from the web; then do the first refresh yourself (do the task, app.publish) so the Commander sees real content immediately.',
  '- Build order: app.read → app.schedule (if it updates by itself — do this BEFORE any web research, or the station asks the Commander to approve it) → app.write index.html → app.check → research → app.publish real data. Tell the Commander in one or two sentences what the app does and when it refreshes.'
].join('\n');

// the station's real date, in words — a model assumes its training-era date, so every app turn is told it
// the SAME line every run's [RUNTIME] block carries (sidecar/runtimeinfo.js) — one wording, one place
function todayLine(now) {
  if (typeof now !== 'function') return '';
  const line = require('../../runtimeinfo.js').todayLine(now());
  return line ? line + '\n' : '';
}

function makeAppTools(deps) {
  const apps = deps.apps;
  const defs = [
    {
      name: 'app.create',
      description: 'Create a new Agent OS app: a dashboard or tool that lives INSIDE Agent OS, in its own Agent OS window, from a name and a one-line description. Returns its id and how to build it. '
        // the exclusions name no search words (tool_search matches description substrings, and the hit line shows only the
        // first sentence): listed as "a website, a React project, a browser extension…", they made tool_search REVEAL
        // app.create as the top hit for exactly those asks (sweep 2026-10-02). Same meaning, no trigger words.
        + 'NOT for anything meant to run, be published or be shipped outside Agent OS (something to put online, a framework codebase, a standalone program, an add-on for the Commander\'s own web browser, a phone or computer program): build those as real files with the file tools.',
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string', description: 'what it should do, in the Commander\'s words' } } },
      scope: 'write',
      run: async (a) => {
        const made = await apps.create({ name: a.name, description: a.description });
        return { content: 'Created the app "' + made.name + '" (id: ' + made.id + '). Its window shows a "building" page until you write index.html.\n' + GUIDE, summary: 'app created ' + made.id };
      }
    },
    {
      name: 'app.read',
      description: 'See what a Agent OS app is made of: with only `app`, its description, files, data keys and schedule (plus the build guide); with `path`, one file; with `key`, one published data value.',
      schema: { type: 'object', required: ['app'], properties: { app: { type: 'string' }, path: { type: 'string' }, key: { type: 'string' } } },
      scope: 'read', readOnly: true,
      run: async (a) => {
        const { id, meta } = await apps.need(a.app);
        if (a.path && a.key) throw new Error('give `path` (a file) or `key` (a data value), not both');
        if (a.path) return { content: await apps.readFile(id, a.path), summary: 'read ' + a.path };
        if (a.key) return { content: JSON.stringify(await apps.dataGet(id, a.key), null, 2) || 'null', summary: 'data ' + a.key };
        const files = await apps.listFiles(id);
        const keys = await apps.dataKeys(id);
        const d = await apps.describe(id);
        return {
          content: todayLine(deps.now) + 'App "' + meta.name + '" (id: ' + id + ')\nDescription: ' + (meta.description || '—') +
            '\nFiles: ' + files.map(f => f.path + ' (' + f.bytes + ' B)').join(', ') +
            '\nData keys: ' + (keys.join(', ') || 'none yet') +
            '\nSchedule: ' + (d.schedule && d.schedule.missing ? 'its routine was removed — call app.schedule again to restore it' : d.schedule ? (d.schedule.display + ' — task: ' + (meta.schedule && meta.schedule.task) + (d.schedule.armed === false ? ' (routines are switched OFF on this station — it will not fire until the Commander turns them on)' : '')) : 'none') +
            '\n\n' + GUIDE,
          summary: 'app ' + id
        };
      }
    },
    {
      name: 'app.write',
      description: 'Write one file of a Agent OS app (the whole file). index.html is the app. The open window reloads onto the new version immediately.',
      schema: { type: 'object', required: ['app', 'path', 'content'], properties: { app: { type: 'string' }, path: { type: 'string', description: 'e.g. index.html' }, content: { type: 'string', description: 'the COMPLETE file' } } },
      scope: 'write',
      run: async (a) => {
        const { id } = await apps.need(a.app);
        const r = await apps.writeFile(id, a.path, a.content);
        return { content: 'Wrote ' + r.path + ' (' + r.bytes + ' bytes); the app window reloaded. Run app.check.', summary: 'app wrote ' + r.path };
      }
    },
    {
      name: 'app.check',
      description: 'Check a Agent OS app without running it: every script compiles, and a look check against the station style (warnings).',
      schema: { type: 'object', required: ['app'], properties: { app: { type: 'string' } } },
      scope: 'read', readOnly: true,
      run: async (a) => {
        const { id } = await apps.need(a.app);
        const files = await apps.listFiles(id);
        const problems = [], warnings = [];
        if (!files.some(f => f.path === 'index.html')) problems.push('index.html is missing — that is the app');
        for (const f of files) {
          if (!/\.(?:html?|js)$/i.test(f.path)) continue;
          const text = await (apps.readWhole || apps.readFile)(id, f.path);
          // inline scripts only (a real src= attribute, not data-src=); a module script is skipped on its own, not the whole file
          const scripts = /\.js$/i.test(f.path) ? [text] : Array.from(text.matchAll(/<script\b([^>]{0,400})>([\s\S]*?)<\/script>/gi)).filter(m => !/(?:^|\s)src\s*=/i.test(m[1]) && !/type\s*=\s*["']?module/i.test(m[1])).map(m => m[2]);
          for (const src of scripts) {
            if (/^\s*(?:import|export)\s/m.test(src)) continue;
            const err = deps.compile ? deps.compile(src, f.path) : '';
            if (err) problems.push(f.path + ': ' + err);
          }
          if (/\.html?$/i.test(f.path)) {
            if (/background(?:-color)?\s*:\s*(?:#fff\b|#ffffff\b|white\b)/i.test(text)) warnings.push(f.path + ': a white background — fine if the Commander asked for that look; otherwise leave the page transparent');
            if (!/class="[^"]*\bsn-/.test(text)) warnings.push(f.path + ': no kit classes (sn-*) — fine for a custom look the Commander asked for; otherwise it will not look like Agent OS');
            if (/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)=["']https?:/i.test(text) || /@import\s+(?:url\()?["']?https?:/i.test(text) || /\blocalStorage\b|\bsessionStorage\b/.test(text)) warnings.push(f.path + ': loads something from the web or uses localStorage — neither works in an app (no network, no browser storage); inline it, and keep data with starnet.store');
            if (/\bfetch\s*\(|XMLHttpRequest|new WebSocket/.test(text)) warnings.push(f.path + ': the page tries to use the network — it has none; publish data with app.publish instead');
            if (/onclick\s*=\s*"[^"]*\$\{\s*JSON\.stringify/i.test(text)) warnings.push(f.path + ': JSON.stringify inside an onclick="…" attribute — its quotes end the attribute and the handler never runs; use a plain <a href> (the station opens links) or addEventListener');
          }
        }
        return { content: (problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'OK — no problems.') + (warnings.length ? '\nLook warnings:\n- ' + warnings.join('\n- ') : ''), summary: problems.length ? 'app check: ' + problems.length + ' problem(s)' : 'app check ok' };
      }
    },
    {
      name: 'app.publish',
      description: 'Put data into a Agent OS app — what its page shows (any JSON under a key the page reads). The open window updates immediately. Scheduled refreshes end with this.',
      schema: { type: 'object', required: ['app', 'key', 'value'], properties: { app: { type: 'string' }, key: { type: 'string', description: 'the key the page reads, e.g. "items"' }, value: { description: 'any JSON value' } } },
      scope: 'write',
      run: async (a) => {
        const { id } = await apps.need(a.app);
        await apps.publish(id, a.key, a.value);
        return { content: 'Published "' + a.key + '" to the app; its window is showing it now.', summary: 'app published ' + a.key };
      }
    },
    {
      name: 'app.schedule',
      // it PERSISTS the task every later refresh obeys: a run that has read the web may not rewrite it unasked
      // (the same laundering team.configure is locked against). Schedule BEFORE researching and nothing asks.
      taintLocked: true,
      description: 'Make a Agent OS app refresh itself: `every` ("every 24h", "every 6h", "0 8 * * *" for 8:00 daily) and the `task` each refresh performs (it must end by publishing with app.publish). every "off" stops it.',
      schema: { type: 'object', required: ['app', 'every'], properties: { app: { type: 'string' }, every: { type: 'string' }, task: { type: 'string' } } },
      scope: 'write',
      run: async (a) => {
        const { id } = await apps.need(a.app);
        const r = await apps.schedule(id, { every: a.every, task: a.task, byAgent: true });   // a crew edit: a changed task drops the routine's unattended grants
        if (r.off) return { content: 'The app no longer refreshes on a schedule.', summary: 'app schedule off' };
        return {
          content: 'Scheduled: ' + r.display + '.' + (r.armed === false ? ' NOTE: routines are switched OFF on this station, so it will not fire until the Commander turns them on — the app window offers a TURN ON button. Do the first refresh yourself now.' : ' Do the first refresh yourself now so the app has content.'),
          summary: 'app scheduled ' + r.display
        };
      }
    }
  ];
  const tools = defs.map(d => Object.assign({ capability: 'apps', impact: 'none', requiresConsent: false, network: false, readOnly: false }, d));
  return { register(registry) { for (const t of tools) registry.register(t); }, defs: tools, GUIDE };
}

function toolNames() { return ['app.create', 'app.read', 'app.write', 'app.check', 'app.publish', 'app.schedule']; }
module.exports = { makeAppTools, toolNames, GUIDE, todayLine };
