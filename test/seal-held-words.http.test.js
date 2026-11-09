/* node test/seal-held-words.http.test.js — WHILE THE SEAL IS HELD, SAY WHY (final review B3, 2026-11-08).

   A desktop station that cannot read its key over a workspace sealed with it keeps every authority file at its default
   and saves none ("held"). The review saw the wrong words there: POST /api/roster answered 500 "could not persist roster",
   a raise confirmed at the desk showed the native dialog and then failed the same way, and a granted script routine said
   "routine scripts require the unattended workbench grant". Now the roster answers 409 with the held reason before any
   dialog, and a script routine says it did not run because of that. Nothing is lost: the key's return brings it all back.

   The real sidecar as the desktop app runs it: keyed first, then with no key. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), os = require('os'), path = require('path');
const { station, cleanup } = require('./helpers/desk-station.js');
const { seedActiveStation } = require('./helpers/station.js');

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-held-'));
  seedActiveStation(ws);
  let st = null;
  try {
    st = await station(ws, {}, 'desktop');
    const ro = await st.call(st.API, 'POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Nova', approvalMode: 'ask', system: 'helpful' }] });
    A.eq(ro.status, 200, 'the keyed station saves a roster (sealed)');
    await st.stop(); st = null;

    // the next launch cannot read the key: the seal is held
    st = await station(ws, { STARNET_CONNECTOR_ENCRYPTION_KEY: '', SKYNET_CONNECTOR_ENCRYPTION_KEY: '' }, 'desktop');
    const p = await st.call(st.API, 'GET', '/api/permissions');
    const seal = (p.body && p.body.authoritySeal) || {};
    A.ok(seal.held === true || /held/.test(String(seal.mode || '')) || (seal.notices || []).some(n => /cannot save permission changes right now/.test(String(n.text || ''))), 'the station is held: ' + JSON.stringify(seal).slice(0, 300));
    const push = await st.call(st.API, 'POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Nova', approvalMode: 'ask', system: 'kinder' }] });
    A.eq(push.status, 409, 'final review B3: a roster push while held answers 409, not 500');
    A.ok(push.body && push.body.held === true && /cannot save permission changes right now/.test(String(push.body.error || '')), 'and says why: ' + JSON.stringify(push.body).slice(0, 300));
    const raise = await st.call(st.API, 'POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Nova', approvalMode: 'full', system: 'helpful' }], raise: ['agent'] });
    A.eq(raise.status, 409, 'final review B3: a raise while held is refused before any desk dialog');
    A.ok(!(raise.body && raise.body.deskConfirm), 'no confirmation is asked for a change that cannot be saved');
    const IDX = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
    const run = A.fnBody(IDX, 'async function executeCronScript(');
    A.ok(/if \(job && job\.script && authoritySeal\.held\)/.test(run) && run.indexOf('authoritySeal.held') < run.indexOf('cronScriptSpec(job)'), 'final review B3: a script routine says it did not run because the seal is held, before the grant check');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + (st ? '\n' + st.child.out().slice(-2000) : ''));
  } finally {
    if (st) await st.stop();
    cleanup(ws);
  }
  A.report('seal-held-words.http.test');
})();
