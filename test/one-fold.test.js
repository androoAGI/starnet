/* test/one-fold.test.js — every fold in a window draws ONE drawn chevron (old-UI review 10-26 #6).

   The review found folds still drawing the browser's own ▶: a fallback-font triangle (VT323 has no ▸), on another baseline
   than its label, beside folds that draw ＋/− or ▸/▾ of their own. On 10-30 every window and section was walked live on a
   seeded station for a summary still drawing the browser's disclosure marker: 23 kinds (dossier, YOU › SOURCES, QUEST LOG,
   AUTOMATE, APPS, SKILL MARKET, TOOLS, EXTENSIONS, the learned skills). After the rule below, the same walk finds 0.

   Locks: (1) the one-fold rule names every fold the walk found, hides the browser marker and draws a CSS chevron that turns
   when open; (2) folds with a marker of their own are not on it (no second marker); (3) the two labels that broke the
   casing read in sentence case like the rest. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const css = read('frontend/css/app.css');
const at = css.indexOf('/* ONE FOLD (old-UI review 10-26 #6).');
A.ok(at > 0, 'app.css carries the one-fold rule');
const block = css.slice(at, css.indexOf('[open] > summary::before { transform: rotate(45deg); }', at) + 60);
const list = /:is\(([\s\S]*?)\) > summary \{/.exec(block)[1];

for (const [what, sel] of [
  ['dossier › FINE-TUNE PERSONALITY', '#ag-persona-card details:not([class])'], ['dossier › More options', 'details.cf-access-more'],
  ['YOU › Sources', 'details.wh-source-settings'], ['QUEST LOG goal and progress folds', '.q-life-goal, .q-goal-starters, .q-goal-plan-editor, .q-goal-optional, .q-growth-history, .q-metric-editor'],
  ['AUTOMATE folds', '.sn-menu-options, .lp-adv, .lp-preview'], ['APPS and SKILL MARKET folds', '.cc-details, .cc-alternatives'],
  ['APPS › Use a personal access token instead', '#cc-list details:not(.cc-group)'], ['TOOLS › Inspect tools', '#ts-list details'],
  ['EXTENSIONS folds', 'details.ext-details'], ['learned skills (proposal, receipt)', '#sk-agent details']])
  A.ok(list.includes(sel), what + ' is on the one-fold rule');

A.ok(/> summary \{\s*list-style: none;[^}]*display: flex;/.test(block), 'the browser marker is gone (list-style none on a flex summary)');
A.ok(/> summary::-webkit-details-marker \{ display: none; \}/.test(block), 'and its WebKit twin');
A.ok(/> summary::before \{\s*content: '';[^}]*border-right: 1\.5px solid currentColor; border-bottom: 1\.5px solid currentColor; transform: rotate\(-45deg\);/.test(block), 'one chevron drawn in CSS (no glyph from another font)');
A.ok(/\[open\] > summary::before \{ transform: rotate\(45deg\); \}/.test(block), 'which turns when the fold opens');

// (2) a fold with a marker of its own never gets a second one
A.ok(!/\.(mc-adv|mc-add-fold|sk-fold|perm-fold|refit-toolgroup|ab-router|cf-group|mkt-orders|mkt-model-settings|wf-more)\b/.test(list.replace(/:not\(\.cc-group\)/, '')), 'no fold that draws its own marker (or none, by design) is on the list');
A.ok(/#cc-list details:not\(\.cc-group\)/.test(list), 'the APPS category groups keep their ＋/−');

// (3) one casing
const ui = read('frontend/app/stationui.js');
A.ok(/<summary>Fine-tune personality' \+ \(Personas\.hasTuning\(traits, a && a\.customVoice\) \? ' · customized' : ''\)/.test(ui), 'FINE-TUNE PERSONALITY reads "Fine-tune personality" like the folds around it');
A.ok(/<summary>Advanced — type a model id<\/summary>/.test(ui), '"advanced — type a model id" starts with a capital');

A.report('one-fold.test');
