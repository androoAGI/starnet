'use strict';
/* Live sidecar regressions for connector credential binding and portable backup safety. All credentials are
   synthetic canaries and all MCP servers are loopback-only. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

async function mockServer(kind, redirectTo) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ authorization: req.headers.authorization || '', apiKey: req.headers['x-api-key'] || '', method: req.method });
    if (kind === 'redirect') { res.writeHead(307, { Location: redirectTo() }); return res.end(); }
    let msg = {}; try { msg = JSON.parse(body); } catch (_) {}
    if (msg.id == null) { res.writeHead(202); return res.end(); }
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: kind, version: '1' } }
      : { tools: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, server, url: 'http://127.0.0.1:' + server.address().port + '/mcp' };
}

(async () => {
  const replacement = await mockServer('replacement');
  const original = await mockServer('original');
  const redirect = await mockServer('redirect', () => replacement.url);
  const fixture = SidecarFixture.create({ prefix: 'starnet-connector-security-', timeoutMs: 15000 });
  const bearer = 'AUDIT_FAKE_BEARER', apiKey = 'AUDIT_FAKE_HEADER';
  try {
    fs.writeFileSync(path.join(fixture.workspace, 'agent.roster.json'), JSON.stringify({ version: 1, agents: [
      { agentId: 'safe', name: 'Safe', system: '', approvalMode: 'ask', executionProfile: 'safe-cell' }
    ] }));
    await fixture.start();
    let r = await fixture.json('POST', '/api/connectors', {
      id: 'retarget', transport: 'http', url: original.url, token: bearer, headers: { 'X-Api-Key': apiKey }
    });
    A.eq(r.status, 200, 'credentialed source connector configures');
    const beforeImport = replacement.calls.length;
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: {
      connectors: [{ id: 'retarget', transport: 'http', url: replacement.url, enabled: true }]
    } } });
    A.eq(r.status, 200, 'old-format connector import succeeds');
    A.ok(replacement.calls.length > beforeImport, 'import reconciles the replacement endpoint immediately');
    A.ok(replacement.calls.slice(beforeImport).every(c => !c.authorization && !c.apiKey), 'imported replacement endpoint receives no prior credentials');

    // The ordinary edit route obeys the same service-binding rule.
    await fixture.json('POST', '/api/connectors', {
      id: 'edit-retarget', transport: 'http', url: original.url, token: bearer, headers: { 'X-Api-Key': apiKey }
    });
    const beforeEdit = replacement.calls.length;
    r = await fixture.json('POST', '/api/connectors', { id: 'edit-retarget', transport: 'http', url: replacement.url });
    A.eq(r.status, 200, 'ordinary endpoint edit succeeds');
    A.ok(replacement.calls.slice(beforeEdit).every(c => !c.authorization && !c.apiKey), 'ordinary endpoint edit does not carry prior credentials');

    const beforeRedirect = replacement.calls.length;
    r = await fixture.json('POST', '/api/connectors', {
      id: 'redirect', transport: 'http', url: redirect.url, headers: { 'X-Api-Key': apiKey }
    });
    A.eq(r.status, 200, 'redirecting connector configuration is durably saved');
    A.eq(r.body.connected, false, 'redirecting connector is not reported connected');
    A.ok(/redirect refused/.test(r.body.error), 'redirect refusal is surfaced: ' + JSON.stringify(r.body));
    A.eq(replacement.calls.length, beforeRedirect, 'redirect destination receives no request');

    await fixture.json('POST', '/api/connectors', { id: 'disabled', transport: 'http', url: original.url, enabled: false });
    await fixture.json('POST', '/api/connectors', { id: 'oauth', transport: 'http', url: 'https://example.invalid/mcp', oauth: true, enabled: false });
    await fixture.json('POST', '/api/connectors', {
      id: 'stdio-secret', transport: 'stdio', command: 'node', agentId: 'safe', enabled: false,
      cwd: 'C:/audit',
      args: ['server.js', '--pwd=PWD_SECRET', '-H', 'Authorization: Bearer HEADER_ARG_SECRET', '{"access":"JSON_ARG_SECRET"}'],
      env: { ACCESS: 'ENV_SECRET', MODE: 'audit' }
    });
    const exported = await fixture.json('POST', '/api/config/export', { only: ['connectors'] });
    A.eq(exported.status, 200, 'connector backup exports');
    const bytes = JSON.stringify(exported.body);
    for (const secret of ['PWD_SECRET', 'HEADER_ARG_SECRET', 'JSON_ARG_SECRET']) A.eq(bytes.includes(secret), false, 'opaque stdio argument secret is absent from live export: ' + secret);
    A.eq(bytes.includes('ENV_SECRET'), false, 'stdio environment secret is absent from live export');
    const stdioRow = exported.body.sections.connectors.find(c => c.id === 'stdio-secret');
    A.ok(stdioRow.args.every(x => x === '<redacted>'), 'live export carries only positional argument markers');
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: { connectors: [stdioRow] } } });
    A.eq(r.status, 200, 'same-station stdio backup reimports');
    A.eq(r.body.secretsNeeded.some(x => x.id === 'stdio-secret'), false, 'matching local stdio secrets resolve without a false re-entry claim');
    const stateFile = require('node:path').join(fixture.workspace, 'connectors', 'state.json');
    let diskStdio = JSON.parse(require('node:fs').readFileSync(stateFile, 'utf8')).configs.find(c => c.id === 'stdio-secret');
    A.eq(diskStdio.args, ['server.js', '--pwd=PWD_SECRET', '-H', 'Authorization: Bearer HEADER_ARG_SECRET', '{"access":"JSON_ARG_SECRET"}'], 'same execution identity retains protected local argv');
    A.eq(diskStdio.env, { ACCESS: 'ENV_SECRET', MODE: 'audit' }, 'same execution identity retains protected local environment');
    await fixture.json('POST', '/api/connectors', { id: 'stdio-edit', transport: 'stdio', command: 'node', agentId: 'safe', enabled: false,
      args: ['trusted.js'], env: { ACCESS: 'EDIT_ENV_SECRET' } });
    r = await fixture.json('POST', '/api/connectors', { id: 'stdio-edit', transport: 'stdio', enabled: false, args: ['different.js'] });
    A.eq(r.status, 200, 'ordinary stdio argv edit saves');
    const diskEdit = JSON.parse(fs.readFileSync(stateFile, 'utf8')).configs.find(c => c.id === 'stdio-edit');
    A.eq(diskEdit.env, {}, 'ordinary argv edit cannot silently inherit the prior program environment');

    // Changing even one visible argv value breaks the retention boundary for the entire stdio execution config.
    const changedProgram = Object.assign({}, stdioRow, {
      args: ['-e', 'process.stdout.write(process.env.ACCESS)', 'x', 'y', 'z'],
      redactedFields: ['env:ACCESS', 'env:MODE'], missingFields: [], enabled: true
    });
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: { connectors: [changedProgram] } } });
    A.eq(r.status, 200, 'changed-program import is recorded as incomplete');
    diskStdio = JSON.parse(fs.readFileSync(stateFile, 'utf8')).configs.find(c => c.id === 'stdio-secret');
    A.eq(diskStdio.enabled, false, 'changed argv cannot activate while asking to retain old environment values');
    A.eq(diskStdio.env, {}, 'changed argv receives none of the protected local environment');
    A.ok(diskStdio.missingFields.includes('env:ACCESS'), 'changed argv persists the exact unresolved environment requirement');

    const portableRow = Object.assign({}, stdioRow, { id: 'stdio-portable', enabled: true });
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: { connectors: [portableRow] } } });
    A.eq(r.status, 200, 'portable stdio backup imports as an incomplete row');
    diskStdio = JSON.parse(require('node:fs').readFileSync(stateFile, 'utf8')).configs.find(c => c.id === 'stdio-portable');
    A.eq(diskStdio.enabled, false, 'portable stdio row stays disabled until opaque values are re-entered');
    A.eq(diskStdio.args, [], 'redaction placeholders are never persisted as executable arguments');
    A.eq(diskStdio.env, {}, 'redacted environment values are never fabricated');
    A.ok(diskStdio.missingFields.includes('args:0') && diskStdio.missingFields.includes('env:ACCESS'), 'missing requirements are durable connector state');
    A.ok(r.body.secretsNeeded.some(x => x.id === 'stdio-portable' && x.fields.includes('args:0') && x.fields.includes('env:ACCESS')), 'portable import names the exact missing fields');
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: { connectors: [portableRow] } } });
    A.ok(r.body.secretsNeeded.some(x => x.id === 'stdio-portable' && x.fields.includes('args:0')), 're-import cannot erase an unresolved requirement');
    r = await fixture.json('POST', '/api/connectors', { id: 'stdio-portable', transport: 'stdio', enabled: true });
    A.eq(r.status, 200, 'Enable request for an incomplete connector returns saved state');
    A.eq(r.body.incomplete, true, 'Enable response tells the UI the connector is incomplete');
    A.eq(r.body.status.enabled, false, 'Enable cannot bypass persisted missing fields');

    const forty = Array.from({ length: 40 }, (_, i) => 'value-' + i);
    r = await fixture.json('POST', '/api/connectors', { id: 'stdio-forty', transport: 'stdio', command: 'node', agentId: 'safe', enabled: false, args: forty });
    A.eq(r.status, 200, '40-argument connector saves through the edit route');
    const fortyBackup = await fixture.json('POST', '/api/config/export', { only: ['connectors'] });
    const fortyRow = fortyBackup.body.sections.connectors.find(c => c.id === 'stdio-forty');
    A.eq(fortyRow.args.length, 40, 'export preserves all 40 supported argument positions');
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: { connectors: [fortyRow] } } });
    A.eq(r.status, 200, '40-argument same-station backup imports');
    const diskForty = JSON.parse(fs.readFileSync(stateFile, 'utf8')).configs.find(c => c.id === 'stdio-forty');
    A.eq(diskForty.args, forty, 'all 40 arguments round-trip without truncation');

    const budgetBefore = (await fixture.json('POST', '/api/config/export', { only: ['budget'] })).body.sections.budget;
    const oversized = { id: 'oversized', transport: 'stdio', command: 'node', args: Array(129).fill('x') };
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: { budget: { perRun: 9876 }, connectors: [oversized] } } });
    A.eq(r.status, 400, 'oversized import is rejected');
    A.ok(/128/.test(r.body.error), 'oversized import reports the supported argument limit');
    const budgetAfter = (await fixture.json('POST', '/api/config/export', { only: ['budget'] })).body.sections.budget;
    A.eq(budgetAfter, budgetBefore, 'whole-envelope validation occurs before an earlier section can mutate');
    r = await fixture.json('POST', '/api/connectors', oversized);
    A.eq(r.status, 400, 'ordinary connector edit rejects oversized argv too');
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: {
      budget: { perRun: 8765 }, connectors: [{ id: 'unsafe-owner', transport: 'stdio', command: 'node', agentId: 'missing', enabled: true }]
    } } });
    A.eq(r.status, 400, 'enabled stdio import applies the same Safe Cell ownership rule as edit');
    A.eq((await fixture.json('POST', '/api/config/export', { only: ['budget'] })).body.sections.budget, budgetBefore, 'semantic connector validation also precedes all section writes');
    const rows = exported.body.sections.connectors.filter(c => ['disabled', 'oauth'].includes(c.id));
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: { connectors: rows } } });
    A.eq(r.status, 200, 'connector backup reimports');
    let list = await fixture.json('GET', '/api/connectors');
    let disabled = list.body.connectors.find(c => c.id === 'disabled');
    let oauth = list.body.connectors.find(c => c.id === 'oauth');
    A.eq(disabled.enabled, false, 'disabled connector remains disabled after import');
    A.eq(oauth.enabled, false, 'disabled OAuth connector remains disabled after import');
    A.eq(oauth.oauth, true, 'custom OAuth mode remains present after import');
    r = await fixture.json('POST', '/api/connectors', { id: 'oauth', transport: 'http', url: 'https://example.invalid/mcp', oauth: false, token: 'MANUAL_TOKEN', enabled: false });
    A.eq(r.status, 200, 'ordinary edit can leave OAuth mode');
    A.eq(r.body.status.oauth, false, 'runtime status drops the OAuth provider immediately');
    A.eq(r.body.status.hasToken, true, 'runtime status reports the replacement manual credential');
    await fixture.restart();
    list = await fixture.json('GET', '/api/connectors');
    disabled = list.body.connectors.find(c => c.id === 'disabled');
    oauth = list.body.connectors.find(c => c.id === 'oauth');
    A.eq(disabled.enabled, false, 'disabled state survives restart');
    A.eq(oauth.oauth, false, 'manual authentication mode survives restart after leaving OAuth');
    A.eq(oauth.hasToken, true, 'manual credential remains configured after restart');
    const portableAfterRestart = list.body.connectors.find(c => c.id === 'stdio-portable');
    A.eq(portableAfterRestart.enabled, false, 'incomplete connector remains disabled after restart');
    A.ok(portableAfterRestart.missingFields.includes('args:0'), 'restart keeps the missing-field requirement visible');
    r = await fixture.json('POST', '/api/connectors', { id: 'stdio-portable', transport: 'stdio', enabled: false,
      args: ['server.js', '--pwd=NEW', '-H', 'Authorization: Bearer NEW', '{"access":"NEW"}'],
      env: { ACCESS: 'NEW_ACCESS', MODE: 'audit' } });
    A.eq(r.status, 200, 'edit accepts explicit replacements for every missing field');
    A.eq(r.body.incomplete, false, 'complete re-entry clears the incomplete state');
    A.eq(r.body.missingFields, [], 'complete re-entry clears every durable requirement');

    // A connector-store failure must leave connector truth unchanged and report which earlier section did commit.
    const beforeFault = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const preload = path.join(__dirname, 'fixtures', 'connector-state-write-fail-preload.cjs').replace(/\\/g, '/');
    await fixture.restart({ NODE_OPTIONS: '--require=' + JSON.stringify(preload), STARNET_TEST_FAIL_CONNECTOR_STATE: '1' });
    r = await fixture.json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: {
      budget: { perRun: 4321 }, connectors: [{ id: 'write-fail', transport: 'http', url: original.url, enabled: false }]
    } } });
    A.eq(r.status, 500, 'connector write failure is returned as a failed import');
    A.eq(r.body.applied, ['budget'], 'failure response names the section already applied before the failed store');
    const afterFault = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    A.eq(afterFault, beforeFault, 'failed connector write leaves durable connector state unchanged');
    list = await fixture.json('GET', '/api/connectors');
    A.eq(list.body.connectors.some(c => c.id === 'write-fail'), false, 'failed connector write is not adopted into live state');
  } finally {
    await fixture.dispose();
    for (const mock of [original, replacement, redirect]) {
      try { mock.server.closeAllConnections(); } catch (_) {}
      await new Promise(resolve => mock.server.close(resolve));
    }
  }
  A.report('connector-security.e2e.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
