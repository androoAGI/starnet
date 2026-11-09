/* node test/routine-drive.http.test.js — A ROUTINE'S GRANTS HOLD ONLY ON THE MODEL THE DESK SAID YES TO (final review #2, 2026-11-08).

   The review's live repro: the Commander gives a routine the terminal grant at the desk; the key GET / serves (what any same-user
   script holds) switches the routine to a model on an endpoint it controls; Run Now, and the swapped-in model ran a shell command
   with nobody watching. The same through the agent's model (a routine that follows its agent) and through a same-user edit of
   cron.jobs.json's model under a still-valid seal.

   The real sidecar, as the desktop app runs it (keyed seal, the shell's IPC yes), with two fake models: the one the desk confirmed
   (it writes a LEGIT marker through the terminal, which proves the grant still works) and an attacker's (it writes a PWNED marker).
   Also: a routine sealed before this change (the first form of the seal record) keeps its grants, and that older form cannot be
   replayed once the station has resealed. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { station, model, findFile, cleanup, sleep, KEYHEX } = require('./helpers/desk-station.js');
const { seedActiveStation } = require('./helpers/station.js');
const S = require('../sidecar/authority-seal.js');

const SEAL_KEY = crypto.createHmac('sha256', Buffer.from(KEYHEX, 'hex')).update('starnet.derive\n' + S.LABEL).digest();
const partMac = (k, g, value) => crypto.createHmac('sha256', SEAL_KEY).update('v1\ncron.jobs.json#' + k + '\ng' + g + '\n' + S.canonical(value)).digest('hex');
const marker = (b) => { const u = (b.messages || []).filter(m => m && m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n'); const m = /MARK=([A-Z0-9_]+)/.exec(u); return m ? m[1] : 'NOMARK'; };

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-drive-'));
  seedActiveStation(ws);
  const legit = await model('test/model', (b, turns) => turns === 0 ? { name: 'shell_exec', args: { cmd: 'echo ok> LEGIT_' + marker(b) + '.txt' } } : { text: 'done' });
  const evil = await model('evil/model', (b, turns) => turns === 0 ? { name: 'shell_exec', args: { cmd: 'echo pwned> PWNED_' + marker(b) + '.txt' } } : { text: 'done' });
  const env = { SKYNET_OPENROUTER_BASE: legit.base, STARNET_OPENROUTER_BASE: legit.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-legit', STARNET_OPENROUTER_KEY: 'sk-or-v1-legit',
    SKYNET_DEFAULT_MODEL: 'test/model', CUSTOM_OPENAI_BASE_URL: evil.base };
  const waitFor = async (name, ms) => { for (let i = 0; i < (ms || 6000) / 250; i++) { const f = findFile(ws, name); if (f) return f; await sleep(250); } return null; };
  const cronFile = path.join(ws, 'cron.jobs.json');
  const readCron = () => JSON.parse(fs.readFileSync(cronFile, 'utf8'));
  let st = null;
  try {
    st = await station(ws, env, 'desktop');
    A.ok(st.CLIENT && st.CLIENT !== st.API, 'the station serves a client key that is not the page token');

    // 1. the desk's yes, and the grant really works on the model it was given for (no false drop)
    const mk = (name, extra) => st.viaDesk('POST', '/api/cron', Object.assign({ name, prompt: 'Tidy up. MARK=' + name.toUpperCase(), schedule: 'every 6h', agentId: 'agent', unattendedGrants: ['workbench'] }, extra || {}));
    const r1 = await mk('one', { model: 'test/model', provider: 'openrouter' });
    A.eq(r1.status, 200, 'the Commander creates a granted routine at the desk');
    const j1 = r1.body.job;
    A.ok(/^d1:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{32}$/.test(String(j1.grantDrive)), 'the station records the model, endpoint, instructions and skills the desk said yes to (' + j1.grantDrive + ')');
    await st.call(st.CLIENT, 'POST', '/api/cron/run', { id: j1.id });
    A.ok(await waitFor('LEGIT_ONE.txt'), 'Run Now on the confirmed model uses the terminal grant (the legit marker is written)');

    // 2. the client key switches the routine's model and provider: the grant goes
    const sw = await st.call(st.CLIENT, 'POST', '/api/cron/update', { id: j1.id, patch: { provider: 'custom', model: 'evil/model' } });
    A.eq(sw.status, 200, 'the client key may still change the model');
    A.eq(sw.body.job.unattendedGrants, [], '#2: a new model or provider drops the routine\'s grants');
    A.eq(sw.body.grantsDropped, ['workbench'], '#2: and says which');
    await st.call(st.CLIENT, 'POST', '/api/cron/run', { id: j1.id });
    await sleep(2500);
    A.eq(findFile(ws, 'PWNED_ONE.txt'), null, '#2: the swapped-in model does not run the terminal unattended');

    // 3. a routine that follows its agent: the client key re-points the agent's model, the routine untouched
    const r2 = await mk('two');
    A.eq(r2.status, 200, 'a granted routine that follows its agent');
    const j2 = r2.body.job;
    const ros = await st.call(st.CLIENT, 'POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Overseer', model: 'evil/model', provider: 'custom', system: 'You are the Overseer.' }] });
    A.eq(ros.status, 200, 'the client key pushes a new model for the (ask-first) agent');
    const run2 = await st.call(st.CLIENT, 'POST', '/api/cron/run', { id: j2.id });
    await sleep(2500);
    A.ok(evil.seen.some(b => marker(b) === 'TWO'), 'the routine now runs on the agent\'s new model');
    A.eq(findFile(ws, 'PWNED_TWO.txt'), null, '#2: but without its grants: the model its grants were given for is not the one running it');
    A.ok(/without its unattended grants/.test(JSON.stringify(run2.body)) || /without its unattended grants/.test(st.child.out()), '#2: and it says why');
    await st.call(st.API, 'POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Overseer', model: 'test/model', provider: 'openrouter', system: 'You are the Overseer.' }] });

    // 4. a fallback to another model is not taken by a granted routine (the station's chain is page-key settable)
    // (covered by reading: runOnceCore keeps only same-model credential rotations for a run with grants)

    // 5. a same-user edit of the model in cron.jobs.json, under the seal
    const r3 = await mk('three', { model: 'test/model', provider: 'openrouter' });
    A.eq(r3.status, 200, 'a third granted routine');
    const j3 = r3.body.job;
    await st.stop();
    let disk = readCron();
    disk.jobs = disk.jobs.map(j => j.id === j3.id ? Object.assign({}, j, { model: 'evil/model', provider: 'custom' }) : j);
    fs.writeFileSync(cronFile, JSON.stringify(disk));
    try { fs.rmSync(cronFile + '.bak', { force: true }); } catch (_) { /* none */ }
    st = await station(ws, env, 'desktop');
    const after = (await st.call(st.API, 'GET', '/api/cron')).body;
    const row3 = (after.jobs || []).find(j => j.id === j3.id);
    A.eq(row3 && row3.unattendedGrants, [], '#2: a model edited in the file outside StarNet no longer verifies: the routine loses its grants');
    await st.call(st.CLIENT, 'POST', '/api/cron/run', { id: j3.id });
    await sleep(2500);
    A.eq(findFile(ws, 'PWNED_THREE.txt'), null, '#2: and the edited model never runs the terminal unattended');

    // 6. a routine sealed in the FIRST form (before the model was sealed) keeps its grants; that form is not replayable after
    const r4 = await mk('four', { model: 'test/model', provider: 'openrouter' });
    const j4 = r4.body.job;
    await st.stop();
    disk = readCron();
    const rec = disk.__seals;
    A.eq(rec && rec.p, 2, 'the record says which form its parts take');
    const legacyPart = j => ({ grants: j.unattendedGrants.map(String), agentId: j.agentId == null ? null : String(j.agentId), prompt: j.prompt == null ? null : String(j.prompt),
      script: j.script == null ? null : j.script, workdir: j.workdir == null ? null : String(j.workdir), noAgent: j.noAgent === true,
      enabledToolsets: Array.isArray(j.enabledToolsets) ? j.enabledToolsets : null, skills: Array.isArray(j.skills) ? j.skills : null,
      contextFrom: Array.isArray(j.contextFrom) ? j.contextFrom : null, runsLine: j.runsLine === true, scriptDigest: typeof j.scriptDigest === 'string' ? j.scriptDigest : null });
    const legacyJobs = disk.jobs.map(j => { const x = Object.assign({}, j); delete x.grantDrive; return x; });
    const macs = {};
    for (const j of legacyJobs) if (Array.isArray(j.unattendedGrants) && j.unattendedGrants.length) macs['grant:' + j.id] = partMac('grant:' + j.id, rec.g, legacyPart(j));
    const legacy = { jobs: legacyJobs, version: disk.version, __seals: { v: 1, g: rec.g, macs } };
    fs.writeFileSync(cronFile, JSON.stringify(legacy));
    try { fs.rmSync(cronFile + '.bak', { force: true }); } catch (_) { /* none */ }
    st = await station(ws, env, 'desktop');
    const back = (await st.call(st.API, 'GET', '/api/cron')).body;
    const row4 = (back.jobs || []).find(j => j.id === j4.id);
    A.eq(row4 && row4.unattendedGrants, ['workbench'], 'a routine sealed in the first form keeps its grants after the upgrade');
    A.ok(row4 && /^d1:[0-9a-f]{32}:-:[0-9a-f]{32}$/.test(String(row4.grantDrive)), 'and is stamped once with the model it runs on, its agent instructions and its skills (' + (row4 && row4.grantDrive) + ')');
    await st.call(st.CLIENT, 'POST', '/api/cron/run', { id: j4.id });
    A.ok(await waitFor('LEGIT_FOUR.txt'), 'and its grant still works on that model');
    await st.stop();
    A.eq(readCron().__seals.p, 2, 'the station resealed it in the new form');
    // the replay: the first-form record put back, with the model changed (the first form did not bind it)
    fs.writeFileSync(cronFile, JSON.stringify(Object.assign({}, legacy, { jobs: legacy.jobs.map(j => j.id === j4.id ? Object.assign({}, j, { model: 'evil/model', provider: 'custom' }) : j) })));
    try { fs.rmSync(cronFile + '.bak', { force: true }); } catch (_) { /* none */ }
    st = await station(ws, env, 'desktop');
    const replay = (await st.call(st.API, 'GET', '/api/cron')).body;
    const row4b = (replay.jobs || []).find(j => j.id === j4.id);
    A.eq(row4b && row4b.unattendedGrants, [], '#2: the first-form record cannot be replayed once the station resealed (its floor moved)');
    await st.call(st.CLIENT, 'POST', '/api/cron/run', { id: j4.id });
    await sleep(2500);
    A.eq(findFile(ws, 'PWNED_FOUR.txt'), null, '#2: and the replayed model never runs the terminal unattended');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + (st ? '\n' + st.child.out().slice(-2000) : ''));
  } finally {
    if (st) await st.stop();
    await legit.close(); await evil.close();
    cleanup(ws);
  }
  A.report('routine-drive.http.test');
})();
