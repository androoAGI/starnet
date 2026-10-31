/* test/number-fields-glass.test.js — a number field is the glass field, not the retired CRT well (old-UI review 10-26 #4).

   The review found 13 pitch-black number fields (SETTINGS › SPENDING LIMITS, RUNTIME LIMITS, PERMISSIONS' idle minutes, the
   dossier's reflection cooldown): input[type=number].key-input kept a black gradient well with glowing digits — the look
   banned on 30 Sep — beside bright yellow boxed "environment default" tags and "— in USD" dash sub-labels. On 10-30 every
   window was walked live: no field computes a black well or a glowing digit, and the 18 number fields are glass wells.

   Locks: (1) the number field's rule is the Build Library field — recessed rgba(0,0,0,.18), 8px radius, a phosphor focus
   ring, no glow; (2) the source tag is plain words, not a box; (3) the limits' sub-labels join with the app's middle dot. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const css = read('frontend/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = sel => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css); return m ? m[1] : ''; };

const field = rule('input[type=number].key-input');
A.ok(/background: rgba\(0, 0, 0, \.18\)/.test(field), 'the field is a recessed glass well');
A.ok(!/#000|linear-gradient/.test(field), 'not the black gradient well');
A.ok(/border-radius: 8px/.test(field), '8px radius, like the Build Library field');
A.ok(/text-shadow: none/.test(field), 'digits do not glow');
const focus = rule('input[type=number].key-input:focus');
A.ok(/box-shadow: 0 0 0 2px rgba\(var\(--ph-rgb\), \.1\)/.test(focus) && !/0 0 12px/.test(focus), 'focus is a phosphor ring, not a glow');
A.ok(/opacity: \.55/.test(rule('input[type=number].key-input:disabled')), 'a field locked by the environment reads as locked');

const badge = rule('.src-badge');
A.ok(/border: 0; background: none;/.test(badge) && /font-size: 14px/.test(badge) && /text-transform: none/.test(badge), 'the source tag is plain 14px words, not a box');
A.ok(!/var\(--gold\)/.test(rule('.src-badge.src-env')), 'and "environment default" is not painted as a gold warning');

const ui = read('frontend/app/stationui.js');
A.ok(/Spending limits <span class="dim">· USD<\/span>/.test(ui) && /Runtime limits <span class="dim">· optional ceilings and timeouts<\/span>/.test(ui), 'the section sub-labels join with a middle dot');
A.ok(/' · locked by an environment variable'|> · locked by an environment variable</.test(ui) && /> · default</.test(ui) && /> · saved override</.test(ui), 'and so do the RUNTIME LIMITS field notes');
A.ok(!/— in USD|— optional ceilings|> — default<|> — saved override</.test(ui), 'no dash sub-labels left');

A.report('number-fields-glass.test');
