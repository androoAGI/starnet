/* test/widgets-trophies-small-glass.test.js — old-UI review 10-26 #9, #10, #12.

   #9  the WIDGETS picker wore the first glass pass: a 5px shell, 2-3px keys about 25px tall, 14px labels. Measured live on
       10-30 after this change: 12px shell, blur 18, 8px keys (7px tabs), nothing under 15px. It still opens beside its rail;
       docking it is a structural change that waits for Andrew's yes.
   #10 TROPHY CASE cards were square (2px) bright-gold frames with a fallback-font ★, gold 11px names and 10/13/2026 dates.
       Now the glass card, gold only on the drawn star and the tag line, 16px names, dates as "Oct 13".
   #12 the model picker's "STATION DEFAULT · …" line was 11px. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const pip = strip(read('frontend/css/pipglass.css'));
const rule = (src, sel) => { const m = new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(src); return m ? m[1] : ''; };

/* #9 */
A.ok(/border-radius: 12px; backdrop-filter: blur\(18px\)/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .wg-library')), 'the picker is the current glass sheet: 12px shell, blur 18');
const key = rule(pip, 'body.glass-demo:not(.hud-mode) .wg-library :is(.wg-studio-button, .wg-library-action)');
A.ok(/min-height: 34px/.test(key) && /border-radius: 8px/.test(key) && /font-size: 15px/.test(key), 'its keys are 8px, about 34px tall, 15px labels');
A.ok(/min-height: 32px; border-radius: 7px; font-size: 15px/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .wg-library-filters button')), 'and so are its tabs');
A.ok(/border-radius: 10px/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .wg-library :is(.wg-app-row, .wg-library-card, .wg-detail-reading)')), 'its cards are 10px');

/* #10 */
const tro = read('frontend/app/windows/trophies.js');
A.ok(/registerWindow\('trophies', 'TROPHY CASE', buildTrophies, \{ className: 'trophies-win' \}\)/.test(tro), 'the TROPHY CASE window carries its own class (QUEST LOG cards share .gx-tro)');
A.ok(/<span class="gl" aria-hidden="true">' \+ STAR \+ '<\/span>/.test(tro) && /const STAR = '<svg viewBox="0 0 16 16"/.test(tro), 'the star is drawn, not the ★ glyph');
A.ok(!/&#9733;|&#9670;|&#9656;/.test(tro), 'no ★ ◆ ▸ entities left');
A.ok(/return d\.toLocaleDateString\('en-US', o\)/.test(tro) && /month: 'short', day: 'numeric'/.test(tro), 'dates read "Oct 13", the year only when it is not this one');
const card = rule(pip, 'body.glass-demo:not(.hud-mode) .term.trophies-win .gx-tro');
A.ok(/border: 1px solid rgba\(var\(--ph-rgb\), \.2\)/.test(card) && /border-radius: var\(--sn-r-card\)/.test(card), 'the card is the glass card, not a gold frame');
A.ok(/color: var\(--gold\)/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .term.trophies-win .gx-tro .gl')) && /color: var\(--gold\)/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .term.trophies-win .gx-tro .gx-tag')), 'gold only on the star and the tag line');
A.ok(/font-size: 16px/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .term.trophies-win .gx-tro .nm')) && /color: var\(--ph-bright\)/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .term.trophies-win .gx-tro .nm')), 'names are 16px in the bright phosphor');
A.ok(/flex: 1 1 0/.test(rule(pip, 'body.glass-demo:not(.hud-mode) .term.trophies-win .gx-tro .tro-hd .nm')), 'a long name wraps beside its star');

/* #12 */
A.ok(/font-size: 14px/.test(rule(strip(read('frontend/css/glass-comms.css')), 'body.glass-demo #model-dock .model-dock-scope')), 'the model picker\'s scope line is 14px');

A.report('widgets-trophies-small-glass.test');
