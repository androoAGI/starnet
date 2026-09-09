'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'frontend/css/readability.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const tokens = Object.fromEntries([...css.matchAll(/--sn-type-([a-z]+):\s*([\d.]+)px/g)].map(m => [m[1], Number(m[2])]));
// Keep the normal reading hierarchy bounded; making the whole app bigger is not this repair.
A.ok(tokens.meta >= 14 && tokens.meta <= 15, 'secondary text has a readable, compact floor');
A.ok(tokens.control >= 16 && tokens.control <= 17, 'control labels have normal reading size');
A.ok(tokens.prose >= 17 && tokens.prose <= 18, 'conversation prose remains readable without becoming a heading');
A.ok(tokens.title >= tokens.prose && tokens.title <= 20, 'agent names keep the agreed restrained upper bound');
A.ok(!/(?:^|[;{])\s*(?:zoom|transform|scale)\s*:/.test(css), 'readability never magnifies the cabinet or viewport');
A.ok(!/body\s*\*\s*\{/.test(css), 'no universal font override that would resize icons and artwork');
A.ok(!/\.(?:cmsg-copy|md-copy|gd-window-button)\b/.test(css), 'icon-only controls keep their explicit icon metrics');
A.ok(html.includes('href="css/readability.css"'), 'the shared frontend loads the reading scale outside the glass demo too');
A.ok(html.indexOf('css/readability.css') > html.indexOf('css/refit-kit.css'), 'legacy skins load before the reading scale');
for (const role of ['.crew-status','.ws-meta','#ws-kind-filter','.comms-agent-model','.model-dock-row-name','.con-rail-label','.cf-desc','.win-note','.refit-proptile-lbl','.set-bd-name']) {
  A.ok(css.includes(role), 'reading scale covers ' + role);
}
const station = fs.readFileSync(path.join(root, 'frontend/app/stationui.js'), 'utf8');
A.ok(/textScale:\s*0/.test(station), 'fresh users keep the existing automatic text-size preference');
A.ok(/document\.body\.style\.zoom\s*=\s*String\(tz\s*\/\s*100\)/.test(station), 'explicit saved text-size choices keep their existing meaning');
A.report('readability.test');
