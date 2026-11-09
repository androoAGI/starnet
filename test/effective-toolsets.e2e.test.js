/* Live HTTP authority disclosure and persisted mode changes, without provider calls. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-effective-toolsets-', timeoutMs: 15000, env: { SKYNET_FULL_ACCESS: '0' } });
  try {
    fs.writeFileSync(path.join(fixture.workspace, 'agent.roster.json'), JSON.stringify({ version: 1, agents: [
      { agentId: 'ask', name: 'Ask agent', approvalMode: 'ask', executionProfile: 'trusted-project' },
      { agentId: 'full', name: 'Full agent', approvalMode: 'full', executionProfile: 'safe-cell' }
    ] }));
    await fixture.start();
    const get = async id => (await fixture.json('GET', '/api/toolsets?agent=' + id)).body;
    const cabinet = v => v.toolsets.find(t => t.id === 'cabinet');
    const before = await get('ask');
    A.eq(before.authority.unrestricted, false, 'live ASK has no ambient Full Access');
    A.eq(cabinet(before).available, true, 'trusted project grants cabinet without a placed prop');
    await fixture.json('POST', '/api/toolsets/cabinet', { enabled: false });
    A.eq(cabinet(await get('ask')).available, false, 'live ASK switch revokes grant');
    const full = await get('full');
    A.eq(full.authority.source, 'agent', 'per-agent Full Access source is real roster state');
    A.eq(cabinet(full).available, true, 'Full Access overrides saved off switch');
    A.eq(cabinet(full).consentGated, false, 'Full Access does not promise confirmation');
    await fixture.deskJson('POST', '/api/permissions/bypass', { on: true });   // FULL BYPASS on is confirmed at the desk (GHSA-2hpj #1)
    A.eq((await get('ask')).authority.source, 'station', 'master bypass updates effective disclosure live');
    await fixture.restart();
    A.eq((await get('ask')).authority.source, 'station', 'master bypass disclosure survives restart');
    await fixture.json('POST', '/api/permissions/bypass', { on: false });
    A.eq(cabinet(await get('ask')).available, false, 'revoking bypass restores persisted disabled switch');
    A.eq((await fixture.json('GET', '/api/toolsets?agent=missing')).status, 404, 'unknown selected agent fails honestly');
    A.eq((await fixture.request('/api/toolsets?agent=ask', { headers: { 'x-starnet-token': '' } })).status, 403, 'effective disclosure remains token protected');
  } finally { await fixture.dispose(); }
  A.report('effective-toolsets.e2e');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
