'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const ui = read('frontend/app/stationui.js');
const app = read('frontend/app/app.js');
const appCss = read('frontend/css/app.css');
const style = read('frontend/css/style.css');
const deliverables = read('frontend/app/deliverables.js');
const titlebar = read('frontend/app/titlebar.js');
const warroom = read('frontend/app/warroom.js');

A.ok(/max-height:\s*680px[\s\S]{0,500}#screen-game\.active[\s\S]{0,300}overflow-y:\s*auto/.test(appCss),
  'PL-01: short responsive layout owns a vertical reachability path');
A.ok(!/StationUI\.notify\(agent\.name \+ ' is online/.test(app),
  'PL-02: resume/reload does not mint another persistent online notification');
A.ok(/aria-label="Turn ' \+ \(s\.enabled \? 'off' : 'on'\) \+ ' ' \+ esc\(s\.name\)/.test(ui),
  'PL-04: each skill switch names its skill');
A.ok(/aria-label="Read instructions for ' \+ esc\(s\.name\)/.test(ui),
  'PL-04: each skill disclosure names its skill');
A.ok(/function setSearchContext\(/.test(ui) && /con-sec-nomatch\s*\{\s*display:\s*none/.test(appCss),
  'PL-07: settings search highlights a matching section and hides irrelevant headings');
A.ok(/aria-label="Dismiss ' \+ esc\(n\.txt\)/.test(ui),
  'PL-09: each notification dismiss action names its notification');
A.ok(/aria-pressed="' \+ \(s\.theme === t \? 'true' : 'false'\)/.test(ui) && /syncThemeSelection/.test(ui),
  'PL-10: theme buttons expose and update pressed state');
A.ok(/getBoundingClientRect\(\)[\s\S]{0,300}anchor/.test(ui) && /CASCADE_STEP/.test(ui),
  'PL-11: large consoles retain a visible offset from the window beneath');
A.ok(/class="deliverables-toolbar"/.test(deliverables) && /class="bb sm" id="dl-refresh"/.test(deliverables),
  'PL-12: Deliverables toolbar opts into themed controls');
A.ok(/previews open safely inside StarNet/i.test(deliverables) && !/opaque-origin sandbox/.test(deliverables),
  'PL-13: Deliverables introduction uses plain outcome language');
A.ok(/\.deliverables-toolbar/.test(style), 'PL-12: Deliverables toolbar has explicit themed layout');
A.ok(/controls\.setAttribute\('aria-hidden', 'true'\)/.test(titlebar) && /b\.tabIndex = -1/.test(titlebar),
  'PL-14: duplicate web titlebar controls are removed from installed AX/tab order');
A.ok(/\['active', 'IN PROGRESS \/ REVIEW'\]/.test(ui) && /running \+ ' RUNNING'/.test(ui) && /ready \+ ' READY TO REVIEW'/.test(ui),
  'PL-15: task-board aggregate distinguishes running from review-ready work');
A.ok(/e\.key === 'Escape'[\s\S]{0,180}cinema/.test(warroom),
  'PL-16: Escape exits Cinema without toggling it on');

A.report('poweruser-shell-repairs.test');
