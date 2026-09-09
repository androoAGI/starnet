'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { clampTerminalSize } = require('../frontend/app/stationui.js');

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const consoleLimits = { minWidth: 560, minHeight: 360, maxWidth: 1200, maxHeight: 840 };
const smallLimits = { minWidth: 320, minHeight: 220, maxWidth: 960, maxHeight: 760 };

A.eq(clampTerminalSize({ width: 900, height: 640 }, consoleLimits, desktop), { width: 900, height: 640 }, 'in-range console size is unchanged');
A.eq(clampTerminalSize({ width: 100, height: 100 }, consoleLimits, desktop), { width: 560, height: 360 }, 'desktop console clamps to its usable minimum');
A.eq(clampTerminalSize({ width: 5000, height: 5000 }, consoleLimits, desktop), { width: 1200, height: 840 }, 'desktop console clamps to its per-window maximum');
A.eq(clampTerminalSize({ width: 1060, height: 720 }, consoleLimits, phone), { width: 374, height: 720 }, 'phone viewport temporarily wins over desktop width minimums');
A.eq(clampTerminalSize({ width: 1, height: 1 }, smallLimits, phone), { width: 320, height: 220 }, 'small window keeps its smaller usable minimum on phone');
A.eq(clampTerminalSize({ width: 'bad', height: null }, smallLimits, desktop), { width: 320, height: 220 }, 'malformed persisted size fails closed to usable minimums');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
A.ok(/termSize/.test(src) && /store\.termSize\s*=\s*termSize/.test(src), 'dimensions persist beside positions');
A.ok(/className\s*=\s*'term-resize'|mkEl\('button',\s*'term-resize'/.test(src), 'every terminal gets one shared resize affordance');
A.ok(/pointerdown/.test(src) && /pointermove/.test(src) && /pointerup/.test(src), 'resize supports pointer, touch, and pen through pointer events');
A.ok(/pointercancel/.test(src), 'an interrupted pointer resize still commits a reachable final size');
A.ok(/ArrowLeft/.test(src) && /ArrowRight/.test(src) && /ArrowUp/.test(src) && /ArrowDown/.test(src), 'resize affordance supports all keyboard arrow directions');
A.ok(/aria-label[^\n]+Resize/.test(src), 'resize affordance has an explicit accessible name');
// Inspect the function's ordering, not a fixed character budget consumed by comments and presentation hooks.
const fitBody = src.slice(src.indexOf('  function fitTermInViewport('), src.indexOf('  function visibleCount('));
A.ok(fitBody.indexOf('resizeTermTo(') >= 0 && fitBody.indexOf('resizeTermTo(') < fitBody.indexOf('visibleTerminalRect(')
  && /function\s+resizeTermTo[\s\S]{0,400}clampTerminalSize/.test(src), 'viewport repair clamps dimensions before position');
A.ok(/minWidth/.test(src) && /maxWidth/.test(src) && /minHeight/.test(src) && /maxHeight/.test(src), 'per-window min/max dimensions are explicit');
A.ok(/termSize\[key\]\s*=\s*\{\s*width:\s*next\.width,\s*height:\s*next\.height\s*\}/.test(src), 'pointermove updates the live size map before viewport repair can consult it');
A.ok(/const p = termPos\[key\][\s\S]{0,450}w\.style\.animation = 'none'[\s\S]{0,180}w\.style\.transform = 'none'/.test(src), 'persisted coordinates suppress centered entrance keyframes before restoring the rectangle');

A.report('terminal-resize.test');
