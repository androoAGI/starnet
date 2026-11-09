/* node test/roster-raise.http.test.js — WHAT THE ROSTER'S DESK QUESTION BROKE, MENDED (fix-sec2 review2, breakages 1 and 2).

   A roster push that widens an agent's execution profile or raises it to Full Access is confirmed at the desk (GHSA-2hpj #1,
   fix-sec2 review 7). Two legitimate flows broke with it:
     1. every NEW agent is born with the product's default profile, TRUSTED PROJECT (a summon, onboarding's Overseer, CLI
        awaken), and none of them asks for it, so each was cut to STATION GEAR and lost its terminal, files and connectors;
     2. choosing Full Access at onboarding failed even after the person confirmed it: the replay carried the desk proof
        header, the header (not the body) picked the combined question, the proof did not match it, and the yes was lost.
   Boots the real sidecar (hermetic SidecarFixture). Widening an agent the station already holds still asks; a push that
   asks nothing is still clamped, desk proof header or not. */
'use strict';
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-roster-raise-', timeoutMs: 20000,
    env: { OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '', SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: '' } });
  seedActiveStation(fixture.workspace);
  let stamp = 1000;
  const row = (id, extra) => Object.assign({ agentId: id, name: id.toUpperCase(), provider: 'openrouter', model: 'm', approvalMode: 'ask' }, extra || {});
  const push = (agents, extra) => fixture.json('POST', '/api/roster', Object.assign({ agents, updatedAt: ++stamp }, extra || {}));
  try {
    await fixture.start();

    // ---- 1. a new agent keeps the product's default profile without a question ----
    const born = await push([row('agent', { executionProfile: 'trusted-project' })]);
    A.eq(born.status, 200, 'a new agent with the default profile is taken');
    A.ok(!born.body.profileClamped, 'and its TRUSTED PROJECT profile is kept: ' + JSON.stringify(born.body));
    const again = await push([row('agent', { executionProfile: 'trusted-project' })]);
    A.ok(!again.body.profileClamped, 'the station holds it (the next push widens nothing)');

    // ---- widening an agent the station already holds still asks ----
    const narrow = await push([row('agent', { executionProfile: 'trusted-project' }), row('scout', { executionProfile: 'station-gear' })]);
    A.ok(!narrow.body.profileClamped, 'a new agent may start narrower');
    const widen = await push([row('agent', { executionProfile: 'trusted-project' }), row('scout', { executionProfile: 'trusted-project' })]);
    A.eq(widen.status, 200, 'a push that widens a held agent without asking is taken');
    A.eq(widen.body.profileClamped, ['scout'], 'but the held agent keeps its narrower profile');
    const thisComputer = await push([row('agent', { executionProfile: 'trusted-project' }), row('scout', { executionProfile: 'station-gear' }), row('nova', { executionProfile: 'this-computer' })]);
    A.eq(thisComputer.body.profileClamped, ['nova'], 'a new agent born wider than the default is clamped too');

    // ---- 2. onboarding's Full Access pick: one question, on the first request and on its replay ----
    const overseer = row('overseer', { approvalMode: 'full', executionProfile: 'this-computer' });
    const crew = () => [row('agent', { executionProfile: 'trusted-project' }), row('scout', { executionProfile: 'station-gear' }), overseer];
    const first = await push(crew(), { raise: ['overseer'] });
    A.eq(first.status, 403, 'raising the Overseer to Full Access asks at the desk');
    A.eq(first.body.code, 'desk_confirm_required', 'with the desk question');
    const words = String((first.body.deskConfirm || {}).summary || '');
    A.ok(/FULL ACCESS/.test(words) && /THIS COMPUTER/.test(words), 'one question names both the Full Access and the wider profile: ' + words.slice(0, 200));
    const yes = await fixture.deskJson('POST', '/api/roster', { agents: crew(), updatedAt: ++stamp, raise: ['overseer'] });
    A.eq(yes.status, 200, 'the confirmed replay is taken (its proof matches the question it answers)');
    A.ok(!yes.body.clamped && !(yes.body.profileClamped || []).includes('overseer'), 'and the Overseer keeps both: ' + JSON.stringify(yes.body));
    const held = await push(crew());
    A.ok(!held.body.clamped && !(held.body.profileClamped || []).includes('overseer'), 'the station holds Full Access and THIS COMPUTER for it');

    // ---- the proof header picks nothing: a push that asks nothing is clamped, header or not ----
    const stale = await fixture.json('POST', '/api/roster', { agents: crew().concat([row('ghost', { approvalMode: 'full' })]), updatedAt: ++stamp },
      { headers: { 'X-StarNet-Desk-Proof': 'dc_' + 'x'.repeat(24) } });
    A.eq(stale.status, 200, 'a push that asks for no raise is not turned into a desk question by a proof header');
    A.eq(stale.body.clamped, ['ghost'], 'its raise is kept ask-first');
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output (tail) ---\n' + String(fixture.output()).slice(-3000));
    process.exitCode = 1;
  } finally {
    await fixture.dispose();
  }
  A.report('roster-raise.http.test');
})().catch(e => { console.error(e); process.exit(1); });
