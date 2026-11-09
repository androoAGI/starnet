/* node test/config-permissions-import.e2e.test.js — permission import is durable across a real sidecar restart. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-perm-import-', timeoutMs: 15000 });
  const existing = 'path:C:/existing-project';
  try {
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({
      version: 1, allow: [existing], meta: { [existing]: { grantedAt: 1 } }
    }), 'utf8');
    await fixture.start();

    // security audit 2026-09-25: a path:<root> grant in an imported file is machine authority and is dropped.
    const envelope = { starnetExport: 1, sections: { permissions: { allow: ['cabinet:write', 'path:C:/imported-whole-drive'] } } };
    // an import that adds standing grants is an authority change: the page key alone is refused (GHSA-2hpj #1)...
    const unconfirmed = await fixture.json('POST', '/api/config/import', { envelope, only: ['permissions'] });
    A.eq([unconfirmed.status, unconfirmed.body && unconfirmed.body.code], [403, 'desk_confirm_required'], 'an import that adds grants asks at the desk first');
    A.eq((await fixture.json('GET', '/api/permissions')).body.grants, [existing], '...and nothing is granted before the desk says yes');
    // ...and goes through once the person at the station types the code it printed
    const imported = await fixture.deskJson('POST', '/api/config/import', { envelope, only: ['permissions'] });
    A.eq(imported.status, 200, 'permission-only config import succeeds');
    A.ok(imported.body.applied.includes('permissions'), 'response reports the permission section applied');
    A.ok((imported.body.notes || []).some(n => /skipped 1 project folder grant/.test(n)), 'the dropped folder grant is named in the import notes');

    const live = await fixture.json('GET', '/api/permissions');
    A.eq(live.body.grants, ['cabinet:write', existing].sort(), 'live authority contains the imported and existing grants');
    const disk = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'permissions.allow.json'), 'utf8'));
    A.ok(Array.isArray(disk.allow), 'permissions persist as a JSON array, never a serialized Set object');
    A.eq(disk.allow.slice().sort(), ['cabinet:write', existing].sort(), 'disk preserves the imported union');

    await fixture.restart();
    const restarted = await fixture.json('GET', '/api/permissions');
    A.eq(restarted.body.grants, ['cabinet:write', existing].sort(), 'both grants survive a real sidecar restart');

    const reset = await fixture.json('POST', '/api/config/reset', { section: 'permissions' });
    A.eq(reset.status, 200, 'permission reset succeeds only after the empty allowlist is durable');
    A.eq((await fixture.json('GET', '/api/permissions')).body.grants, [], 'successful reset clears live authority');
    const allowFile = path.join(fixture.workspace, 'permissions.allow.json');
    A.eq(JSON.parse(fs.readFileSync(allowFile + '.bak', 'utf8')).allow, [], 'permission reset sanitizes the recovery copy too');
    await fixture.stop();
    fs.writeFileSync(allowFile, '{torn', 'utf8');
    await fixture.start();
    A.eq((await fixture.json('GET', '/api/permissions')).body.grants, [], 'corrupt-primary recovery cannot resurrect a reset grant');

    A.eq((await fixture.deskJson('POST', '/api/permissions/grant', { key: 'cabinet:write' })).status, 200, 'grant can be recreated (confirmed at the desk) for individual revoke proof');
    A.eq((await fixture.json('POST', '/api/permissions/revoke', { key: 'cabinet:write' })).status, 200, 'individual permission revoke succeeds');
    A.eq(JSON.parse(fs.readFileSync(allowFile + '.bak', 'utf8')).allow, [], 'individual revoke sanitizes the recovery copy');
    await fixture.stop();
    fs.writeFileSync(allowFile, '{torn-again', 'utf8');
    await fixture.start();
    A.eq((await fixture.json('GET', '/api/permissions')).body.grants, [], 'corrupt-primary recovery cannot resurrect an individually revoked grant');
    await fixture.restart();
    A.eq((await fixture.json('GET', '/api/permissions')).body.grants, [], 'successful reset stays revoked after restart');
  } finally {
    await fixture.dispose();
  }
  A.report('config-permissions-import.e2e.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
