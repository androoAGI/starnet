/* node test/retired-grant-notice.http.test.js — A RETIRED "ALWAYS" IS SAID ON THE PAGE, ONCE (final review B4, 2026-11-08).

   GHSA-2hpj #4 retired the older ALWAYS on a command card (workbench:execute: every command, forever). People who had it
   only saw the cards come back; the station said why in its console alone. Now the first launch that finds it says so on
   the Permissions page (a seal notice of kind info), and saves the file without the row, so the next launch says nothing.
   Every other grant in the file is kept.

   The real sidecar as the desktop app runs it, on a workspace from before (its first keyed boot is the upgrade). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), os = require('os'), path = require('path');
const { station, cleanup } = require('./helpers/desk-station.js');
const { seedActiveStation } = require('./helpers/station.js');

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-grant-'));
  seedActiveStation(ws);
  const file = path.join(ws, 'permissions.allow.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, allow: ['workbench:execute', 'fs.write:workspace'], meta: { 'workbench:execute': { grantedAt: 1 }, 'fs.write:workspace': { grantedAt: 2 } } }));
  let st = null;
  const retiredNotice = body => ((body && body.authoritySeal && body.authoritySeal.notices) || []).find(n => n && n.kind === 'info' && /always allow" for every command was retired/.test(String(n.text || '')));
  try {
    st = await station(ws, {}, 'desktop');
    const p = await st.call(st.API, 'GET', '/api/permissions');
    const n = retiredNotice(p.body);
    A.ok(!!n, 'final review B4: the Permissions page is told the older ALWAYS for commands was retired: ' + JSON.stringify((p.body && p.body.authoritySeal && p.body.authoritySeal.notices) || []).slice(0, 400));
    A.ok(n && /each command now asks you again/.test(n.text), 'and what that means');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    A.ok(Array.isArray(onDisk.allow) && onDisk.allow.indexOf('workbench:execute') < 0, 'the file is saved without the retired row');
    A.ok(onDisk.allow.indexOf('fs.write:workspace') >= 0 && onDisk.meta && onDisk.meta['fs.write:workspace'], 'every other grant (and its provenance) is kept');
    A.ok(!(onDisk.meta && onDisk.meta['workbench:execute']), 'and the retired row\'s provenance goes with it');
    await st.stop(); st = null;

    st = await station(ws, {}, 'desktop');
    const p2 = await st.call(st.API, 'GET', '/api/permissions');
    A.ok(!retiredNotice(p2.body), 'final review B4: the next launch says nothing more');
    const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
    A.ok(/\(n\.kind === 'migrated' \|\| n\.kind === 'info'\) \? 'info' : 'warn'/.test(app), 'the page shows it as news, not a warning');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + (st ? '\n' + st.child.out().slice(-2000) : ''));
  } finally {
    if (st) await st.stop();
    cleanup(ws);
  }
  A.report('retired-grant-notice.http.test');
})();
