/* node test/workspace-reserved.test.js — an agent id must never turn a station-owned directory into its jail.

   The regression: agent jails are WORKSPACES/<agentId>/, and the station keeps credentials at undotted names
   under the same root (codex/tokens.json, channels/secrets.json, connectors/servicekeys.json, plugins/). A
   custom agent named "Codex" slugged to `codex`, so fs.read tokens.json handed that agent the ChatGPT OAuth
   tokens, and /api/file?agent=codex served them. Proven here against a REAL temp directory holding a canary. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Reserved = require('../sidecar/workspace-reserved.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { safeAgentId: envSafeAgentId } = require('../sidecar/environment.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const AgentId = require('../frontend/app/agentid.js');

const ROOT = path.join(os.tmpdir(), 'starnet-reserved-ws-' + process.pid);
const CANARY = 'canary-refresh-token-DO-NOT-LEAK-' + process.pid;

async function rejects(promise, msg, re) {
  try { await promise; A.ok(false, msg + ' — did NOT reject'); }
  catch (e) { A.ok(!re || re.test(String(e && e.message)), msg + ' (message: ' + (e && e.message) + ')'); }
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const d of ['codex', 'channels', 'connectors', 'plugins']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'codex', 'tokens.json'), JSON.stringify({ access_token: 'x', refresh_token: CANARY }));
  fs.writeFileSync(path.join(ROOT, 'channels', 'secrets.json'), JSON.stringify({ telegram: { token: CANARY } }));
  fs.writeFileSync(path.join(ROOT, 'connectors', 'servicekeys.json'), JSON.stringify([{ key: CANARY }]));

  // ---- the list itself ----
  for (const id of ['codex', 'CODEX', 'Codex', 'channels', 'connectors', 'plugins', 'grok', 'kimi', 'skill-packages', '_archive', 'transcript-history-v2', 'con', 'NUL', 'lpt1'])
    A.ok(Reserved.isReservedWorkspaceId(id), 'reserved: ' + id);
  for (const id of ['agent', 'coder', 'codex-2', 'researcher', 'channel', 'plugin-dev', 'console'])
    A.ok(!Reserved.isReservedWorkspaceId(id), 'ordinary id stays usable: ' + id);

  // ---- fs.* jail: the reserved agent can neither read nor write its "workspace" ----
  const { readTool, writeTool, listTool, _internals } = makeFsTools({ fsp, pathMod: path, root: ROOT, limits: { writeBytes: 4096, readReturn: 4000 } });
  await rejects(readTool.run({ path: 'tokens.json' }, { agentId: 'codex' }), 'fs.read as agent "codex" cannot reach codex/tokens.json', /bad agentId/);
  await rejects(readTool.run({ path: 'tokens.json' }, { agentId: 'CODEX' }), 'case variant "CODEX" is refused too (case-insensitive filesystems)', /bad agentId/);
  await rejects(readTool.run({ path: 'secrets.json' }, { agentId: 'channels' }), 'fs.read as agent "channels" cannot reach bot tokens', /bad agentId/);
  await rejects(readTool.run({ path: 'servicekeys.json' }, { agentId: 'connectors' }), 'fs.read as agent "connectors" cannot reach service keys', /bad agentId/);
  await rejects(listTool.run({ path: '.' }, { agentId: 'codex' }), 'fs.list as agent "codex" is refused', /bad agentId/);
  await rejects(writeTool.run({ path: 'evil.js', content: 'module.exports=1' }, { agentId: 'plugins' }), 'fs.write as agent "plugins" cannot plant plugin code', /bad agentId/);
  A.ok(!fs.existsSync(path.join(ROOT, 'plugins', 'evil.js')), 'nothing was written into plugins/');
  // /api/file uses this same resolveInside and answers 403 on /bad agentId/ — keep the message shape.
  await rejects(_internals.resolveInside('codex', 'tokens.json'), '/api/file resolver refuses agent=codex with a "bad agentId" message', /bad agentId/);
  // an ordinary agent still works end to end
  const w = await writeTool.run({ path: 'notes.md', content: 'hello' }, { agentId: 'codex-2' });
  A.ok(/Wrote notes\.md/.test(w.content), 'ordinary agent codex-2 still writes its own workspace');
  const r = await readTool.run({ path: 'notes.md' }, { agentId: 'codex-2' });
  A.ok(/hello/.test(r.content) && r.content.indexOf(CANARY) < 0, 'ordinary agent reads its own file, never the canary');

  // ---- execution environment (shell cwd + every backend's workspaceRoot go through this) ----
  A.throws(() => envSafeAgentId('codex'), 'environment.safeAgentId refuses codex');
  A.throws(() => envSafeAgentId('Connectors'), 'environment.safeAgentId refuses Connectors');
  A.eq(envSafeAgentId('coder'), 'coder', 'environment.safeAgentId keeps ordinary ids');

  // ---- path trust: an absolute path into WORKSPACES/codex is never "your own workspace" ----
  const pt = makePathTrust({ fsp, pathMod: path, roots: () => [], workspaceRoot: ROOT });
  await rejects(pt.guard(path.join(ROOT, 'codex', 'tokens.json'), { scope: 'read', agentId: 'codex', surface: 'interactive', fullAccess: true }),
    'pathtrust: agent "codex" + Full Access still cannot read WORKSPACES/codex/tokens.json', /another agent workspace/);
  fs.mkdirSync(path.join(ROOT, 'coder'), { recursive: true });
  const own = await pt.guard(path.join(ROOT, 'coder', 'x.md'), { scope: 'read', agentId: 'coder', surface: 'autonomous' });
  A.ok(own && own.abs, 'pathtrust: an ordinary agent still reaches its own workspace by absolute path');

  // ---- frontend allocator never mints a reserved id, and mirrors the sidecar list exactly ----
  A.eq(AgentId.alloc('Codex', new Set()), 'codex-2', 'a custom agent named "Codex" is allocated codex-2');
  A.eq(AgentId.alloc('channels', new Set()), 'channels-2', '"channels" is allocated channels-2');
  A.eq(AgentId.alloc('coder', new Set()), 'coder', 'ordinary class ids are unchanged');
  A.eq(AgentId.alloc('Skill Market', new Set()), 'skill-market-2', 'an agent named "Skill Market" never owns the market install folder (sweep 10-02)');
  A.ok(Reserved.RESERVED.has('skill-market') && /path\.join\(WORKSPACES, 'skill-market'\)/.test(readSidecarSource()),
    'the market install folder (WORKSPACES/skill-market) is a reserved station folder');
  A.eq(Array.from(AgentId.RESERVED).sort(), Array.from(Reserved.RESERVED).sort(), 'frontend RESERVED mirrors sidecar/workspace-reserved.js');
  for (const id of AgentId.RESERVED) A.ok(AgentId.RE.test(id) || /^_/.test(id), 'reserved id is expressible in the id grammar: ' + id);

  // ---- agent delete archives WORKSPACES/<id>: a reserved id is still deletable (the recovery path for an agent
  // named before the rule), but the station directory is NEVER moved into the archive ----
  {
    const src = readSidecarSource();
    const start = src.indexOf('async function handleAgentDelete');
    const body = src.slice(start, src.indexOf('ORPHANED-AUTOMATION CLEANUP', start));
    A.ok(/const reservedId = WorkspaceReserved\.isReservedWorkspaceId\(agentId\);/.test(body), 'agent delete classifies a reserved id');
    A.ok(/if \(!reservedId\) move\(path\.join\(WORKSPACES, agentId\), agentId\);/.test(body), 'a reserved id never archives WORKSPACES/<id> (the station directory stays put)');
    A.eq((body.match(/move\(path\.join\(WORKSPACES, agentId\), agentId\)/g) || []).length, 1, 'there is exactly one workspace-dir archive move, and it is guarded');
    let msg = '';
    try { Reserved.assertWorkspaceId('Grok'); } catch (e) { msg = String(e.message); }
    A.ok(/bad agentId/.test(msg) && /delete it and recruit it again/.test(msg) && /grok-2/.test(msg), 'the refusal tells the Commander how to recover the agent');
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  A.report('workspace-reserved.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
