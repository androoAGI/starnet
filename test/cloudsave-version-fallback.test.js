/* test/cloudsave-version-fallback.test.js — cloudsave.js's save-format ceiling when Save has not loaded (quick win 38, wave-1
   reliability cleanup, 10-26 audit).

   currentVersion() mirrors Save.CURRENT, and falls back to a literal only when save.js is not there yet (load order). That
   literal said 5 while save.js had moved to 6, so a page whose Save global was missing called every save this build wrote
   "from a newer StarNet": reconcile handed boot the update gate for the station it had just saved. The literal must equal
   save.js's CURRENT, and a save one version past it must still read as a newer build's. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Save = require('../frontend/app/save.js');
const src = fs.readFileSync(path.join(__dirname, '../frontend/app/cloudsave.js'), 'utf8');

// the real cloudsave.js with NO Save global (the load-order case the fallback exists for)
const context = { console, module: { exports: {} }, require: () => require('../frontend/app/cloudsavecore.js'), setTimeout, clearTimeout, AbortController };
vm.runInNewContext(src, context);
const cs = context.module.exports;
A.ok(typeof cs._isFutureSave === 'function', 'cloudsave exposes its forward-version check');

const doc = version => ({ schema: 'starnet.save', version, updatedAt: 1, agent: { id: 'agent' } });
A.eq(cs._isFutureSave(doc(Save.CURRENT)), false, 'a save at this build\'s own format (Save.CURRENT = ' + Save.CURRENT + ') is never "from a newer StarNet" when Save has not loaded');
A.eq(cs._isFutureSave(doc(Save.CURRENT - 1)), false, 'an older save is never a newer build\'s');
A.eq(cs._isFutureSave(doc(Save.CURRENT + 1)), true, 'a save one format past this build still reads as a newer build\'s');

// and with Save loaded, the ceiling is Save.CURRENT itself
const withSave = { console, module: { exports: {} }, require: () => require('../frontend/app/cloudsavecore.js'), setTimeout, clearTimeout, AbortController, Save: { CURRENT: Save.CURRENT } };
vm.runInNewContext(src, withSave);
A.eq(withSave.module.exports._isFutureSave(doc(Save.CURRENT)), false, 'with Save loaded the ceiling is Save.CURRENT');
A.eq(withSave.module.exports._isFutureSave(doc(Save.CURRENT + 1)), true, 'with Save loaded a newer format is refused');

A.report('cloudsave-version-fallback');
