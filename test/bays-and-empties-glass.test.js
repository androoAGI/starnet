/* test/bays-and-empties-glass.test.js — old-UI review 10-26 #7, #8, #11.

   #7  CONNECT › CONNECTED: "No API keys yet…" computed the station's error red (.mc-detail) — an empty list is not a fault.
   #8  RECIPES' START SESSION was a solid phosphor slab while the RECRUITMENT BAY's key was outlined; lowercase lead lines;
       a recipe line cut mid-sentence ("Get a day-by-day travel plan with .").
   #11 the PROJECTS empty state was ~10px, centred and dim, and "+ ADD blesses a folder" was internal jargon.
   Measured live on 10-30 after this change (purple, TEXT SIZE 90): START SESSION and ⏼ RECRUIT both rgba(ph,.16) on a
   phosphor edge, 8px radius, no shadow; the leads read "Launch a ready-made recipe — …" / "Recruit a new agent onto your
   crew — …"; the empty API KEYS line is dim 16px; PROJECTS reads "No projects yet" (16px) over a 14px line. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (src, sel) => { const m = new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(src); return m ? m[1] : ''; };
const app = strip(read('frontend/css/app.css')), pip = strip(read('frontend/css/pipglass.css'));

/* #7 */
const con = read('frontend/app/windows/connectors.js');
A.ok(/: '<div class="ky-empty">No API keys yet\. Pick an app in APPS, or add your own key below\. '/.test(con), 'the empty API KEYS line is its own calm class');
A.ok(!/<div class="mc-detail">No API keys yet/.test(con), 'never the alarm-red .mc-detail');
A.ok(/color: var\(--ph-dim\)/.test(rule(app, '.ky-empty')) && /font-size: 15px/.test(rule(app, '.ky-empty')), 'dim, readable words');

/* #8 */
const mkt = read('frontend/app/marketplace.js');
A.ok(/'Launch a ready-made recipe — ' \+ who/.test(mkt) && /'Recruit a new agent onto your crew — it gets its own session'/.test(mkt) && /'Choose a class for your agent'/.test(mkt) && /'Re-spec ' \+ who/.test(mkt), 'the bay leads read in sentence case');
A.ok(/<button class="mkt-cta-main mkt-do-launch">START SESSION<\/button>/.test(mkt) && /<button class="bb sm mkt-do-launch">START SESSION<\/button>/.test(mkt), 'START SESSION carries no ▸');
A.ok(/'">' \+ ctaLabel \+ '<\/button>'/.test(mkt), 'the recruit key ends on its words (no trailing ▸)');
const key = rule(pip, 'body.glass-demo:not(.hud-mode) .term :is(.mkt-cta-main, .mkt-recruit .mkt-cta-main)');
A.ok(/background: rgba\(var\(--ph-rgb\), \.16\)/.test(key) && /border: 1px solid var\(--ph\)/.test(key) && /border-radius: var\(--sn-r-key\)/.test(key) && /box-shadow: none/.test(key), 'both bays share the Workflow panel\'s lit glass key');
A.ok(/:is\(\.mkt-do-launch, \.mkt-do-save, \.mkt-do-recipe-save\):not\(\.armed\) \{[^}]*background: rgba\(var\(--ph-rgb\), \.16\) !important/.test(pip), 'and answers marketplace.css\'s solid !important fill, armed state untouched');
A.ok(pip.indexOf(':is(.mkt-do-launch, .mkt-do-save, .mkt-do-recipe-save)') < pip.indexOf('THE DASHBOARD PASS') || pip.indexOf('THE DASHBOARD PASS') < 0, 'that !important sits ahead of the dashboard pass (curved-dashboard law)');
A.ok(/-webkit-line-clamp: 2;/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .term .mkt-tag')), 'a recipe or class line keeps two lines');
A.ok(/font-size: 14px/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .term :is(.mkt-cta-sub, .mkt-recruit .mkt-cta-sub)')), 'the line under the key is 14px');

/* #11 */
const ui = read('frontend/app/app.js');
A.ok(/'<b>No projects yet<\/b>' \+\s*'<span>Press \+ to add a folder, or ask an agent to work in one\.<\/span><\/li>'/.test(ui), 'PROJECTS says it plainly');
A.ok(!/blesses a folder, or tell an agent/.test(ui), 'no "blesses" jargon');
A.ok(/<span class="pe-glyph" aria-hidden="true"><svg viewBox="0 0 16 16"/.test(ui), 'a drawn folder, not the ▦ symbol');
A.ok(/font-size: 16px/.test(rule(app, '.proj-empty-hero b')) && /font-size: 14px/.test(rule(app, '.proj-empty-hero span')), '16px title over a 14px line');
A.ok(!/text-shadow/.test(rule(app, '.proj-empty-hero .pe-glyph')), 'and no glow');

A.report('bays-and-empties-glass.test');
