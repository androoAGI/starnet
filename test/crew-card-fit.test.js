/* node test/crew-card-fit.test.js — a CREW card fits its rail (live walk 2026-10-14, 1440×900, default rail width).
   Found on the 0.13.5 candidate with STRATEGY working: the name line read "STRATEGY 2:" (the run clock cut off), the crew
   rail grew a horizontal scrollbar, an idle "Lv 1" broke onto two lines, and the hover DOSSIER key sat on top of "idle".
   The card's text column is ~85px wide at the default rail width: nothing is cut — a run clock that does not fit beside the
   name takes the line under it, "Lv N" shows only when it fits whole, only a name too long on its own ends in an ellipsis,
   and the DOSSIER key sits at the foot of the portrait well, off the status line.
   (Proven live on an isolated station by measurement — see the lane report; this pins the rules that do it.) */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const su = read('frontend/app/stationui.js');
A.ok(/'<div class="crew-name" style="color:' \+ esc\(a\.color\) \+ '"><span class="crew-nm">' \+ esc\(a\.name\) \+ '<\/span>'/.test(su), 'the crew name is its own element, so it can give way without taking the clock with it');

const css = read('frontend/css/crew-glass.css');
const rule = sel => { const i = css.indexOf(sel + ' {'); if (i < 0) return ''; return css.slice(i, css.indexOf('}', i) + 1); };
const nm = rule('body.glass-demo:not(.hud-mode) #crew .crew-name .crew-nm');
A.ok(/min-width:\s*0/.test(nm) && /overflow:\s*hidden/.test(nm) && /text-overflow:\s*ellipsis/.test(nm) && /white-space:\s*nowrap/.test(nm), 'a long name ellipsizes: ' + nm);
const fixed = rule('body.glass-demo:not(.hud-mode) #crew .crew-name :is(.crew-room, .crew-clock, .crew-id)');
A.ok(/flex:\s*none/.test(fixed) && /white-space:\s*nowrap/.test(fixed), 'the run clock and "Lv N" never shrink or break onto two lines: ' + fixed);
const line = rule('body.glass-demo:not(.hud-mode) #crew .crew-name');
A.ok(/min-width:\s*0/.test(line) && /flex-wrap:\s*wrap/.test(line) && /overflow:\s*hidden/.test(line) && /max-height:/.test(line), 'the name line is one line: what does not fit whole ("Lv N") waits on a hidden second line: ' + line);
A.ok(/body\.glass-demo:not\(\.hud-mode\) #crew \.crew-row\.has-clock \.crew-name \{[^}]*max-height:\s*none/.test(css), 'a run clock is never hidden: when it does not fit beside the name it takes the line under it, whole');
A.ok(/body\.glass-demo:not\(\.hud-mode\) #crew \.crew-main \{[^}]*min-width:\s*0/.test(css), 'the text column may shrink below its content (no sideways scroll on the rail)');
A.ok(!/\.crew-dossier/.test(css), 'the DOSSIER key is gone from the card (Andrew 10-26), so nothing sits on the portrait or the status line');
A.ok(!/\.crew-step \{ padding-right: 66px; \}/.test(css), 'the status line no longer reserves room for a key that is not there');

A.report('crew-card-fit.test');
