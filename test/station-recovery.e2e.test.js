/* node test/station-recovery.e2e.test.js — real sidecar, clean-profile recovery boot.

   Creates station state through both real HTTP mutation routes and real durable files, stops the source sidecar
   to establish the recovery barrier, restores into a second empty WORKSPACES root, then boots a fresh sidecar
   and proves the recovered APIs/files are authoritative. No provider credentials or external calls. */
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Recovery = require('../sidecar/station-recovery.js');
const Save = require('../frontend/app/save.js');

function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
function quietEnv() {
  return {
    SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_LOOP_ENABLED: '0', SKYNET_EDGE_TTS: '0',
    OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '',
    OPENAI_API_KEY: '', SKYNET_OPENAI_API_KEY: '', STARNET_OPENAI_API_KEY: '',
    STARNET_DEFAULT_MODEL: 'test/replay', SKYNET_DEFAULT_MODEL: 'test/replay'
  };
}

(async () => {
  const source = SidecarFixture.create({ prefix: 'starnet-recovery-source-', env: quietEnv(), timeoutMs: 15000 });
  const target = SidecarFixture.create({ prefix: 'starnet-recovery-target-', env: quietEnv(), timeoutMs: 15000 });
  let rollbackDir = null;
  try {
    const ws = source.workspace;
    const projectRoot = path.join(ws, 'agent', 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const saveDoc = { schema: 'starnet.save', version: Save.CURRENT, updatedAt: 1000, agent: { id: 'agent', name: 'NOVA', model: 'test/replay', provider: 'replay' }, station: { rooms: [{ id: 'command' }, { id: 'lab' }], props: [{ id: 'terminal', roomId: 'command' }] }, workstreams: [{ id: 'general', title: 'General', messages: [{ role: 'user', content: 'live recovery proof' }] }], activeId: 'general', generalId: 'general' };
    write(ws, 'agent.save.json', { version: 1, agentId: 'agent', updatedAt: 1000, savedAt: 1000, doc: saveDoc });
    write(ws, 'agent.roster.json', { version: 1, updatedAt: 1000, agents: [{ agentId: 'agent', name: 'NOVA', model: 'test/replay', provider: 'replay', system: 'recovery test' }] });
    write(ws, 'transcript.jsonl', JSON.stringify({ workstreamId: 'general', role: 'assistant', content: 'durable transcript', ts: 1 }) + '\n');
    write(ws, 'agent.todo.json', { items: [{ id: 'task-live', text: 'prove recovery', done: false }] });
    write(ws, '_station.quests.json', { version: 1, quests: [{ id: 'quest-live', title: 'Recovery', state: 'open' }] });
    write(ws, 'agent.deliverables.json', { version: 1, records: [{ id: 'deliverable-live', path: 'agent/project/result.md', state: 'kept' }] });
    write(ws, 'agent/project/result.md', '# live deliverable\n');
    write(ws, 'permissions.allow.json', { version: 1, allow: ['path:' + projectRoot], meta: { ['path:' + projectRoot]: { grantedAt: 1 } } });
    write(ws, 'projects.json', { version: 1, projects: [{ root: projectRoot, displayPath: projectRoot, grantedAt: 1, lastTouchedAt: 1, isGitRepo: false }] });
    write(ws, 'connectors/state.json', { version: 2, configs: [{ id: 'local-reference', transport: 'http', url: 'http://127.0.0.1:1/mcp', oauth: true }], oauth: { byId: { 'local-reference': { accessToken: 'SYNTHETIC_SECRET', refreshToken: 'SYNTHETIC_REFRESH' } }, clients: {} } });

    await source.start();
    const routine = await source.json('POST', '/api/cron', { name: 'Recovery routine', prompt: 'prepare a local status report', schedule: '0 9 * * 1-5', agentId: 'agent' });
    A.eq(routine.status, 200, 'source sidecar creates a real durable routine: ' + JSON.stringify(routine.body));
    const loop = await source.json('POST', '/api/loops', { name: 'Recovery loop', objective: 'continue recovery verification', agentId: 'agent' });
    A.eq(loop.status, 200, 'source sidecar creates a real durable loop: ' + JSON.stringify(loop.body));
    const grant = await source.json('POST', '/api/permissions/grant', { key: 'cabinet:write' });
    A.eq(grant.status, 200, 'source sidecar creates a portable standing capability grant');
    const memory = await source.json('POST', '/api/notebook/restore', { agent: 'agent', notes: [{ id: 'memory-live', title: 'Recovery memory', body: 'survive the machine loss', ts: 1 }] });
    A.eq(memory.status, 200, 'source sidecar creates real durable memory');
    const srcCron = await source.json('GET', '/api/cron');
    const srcLoops = await source.json('GET', '/api/loops');
    A.ok(Array.isArray(srcCron.body.jobs) && srcCron.body.jobs.some(x => x.name === 'Recovery routine'), 'source routine reads back live');
    A.ok(Array.isArray(srcLoops.body.loops) && srcLoops.body.loops.some(x => x.name === 'Recovery loop'), 'source loop reads back live');
    await source.stop();
    // the control for "the boot did not resume it" below: this same boot path DOES arm a loop that is still live on disk
    await source.start();
    const srcRebooted = await source.json('GET', '/api/loops');
    A.eq(srcRebooted.body.armed, true, 'a boot resumes a live loop by itself, which is what a restore must not leave behind');
    await source.stop();

    const browserStore = { 'starnet.save': JSON.stringify(saveDoc), 'starnet.station.v1': JSON.stringify({ selectedRoom: 'lab' }), 'starnet.byok.key': 'SYNTHETIC_BROWSER_SECRET' };
    const bundle = Recovery.capture({ workspaceRoot: ws, browserStore, now: 2000, appVersion: '0.9.0-e2e', lastCompletedMutation: 3 });
    A.eq(bundle.report.complete, true, 'live source produces a complete recovery bundle');
    A.ok(JSON.stringify(bundle).indexOf('SYNTHETIC_SECRET') < 0 && JSON.stringify(bundle).indexOf('SYNTHETIC_BROWSER_SECRET') < 0, 'live bundle excludes credential bytes');

    await target.dispose(); // release/remove the constructor's placeholder root; restore requires a clean target.
    const restoredRoot = target.workspace;
    // target.dispose removed its root and marks that fixture unusable; boot a fresh fixture pointed at the restored root.
    const restoredBrowser = {};
    const receipt = Recovery.restore({ bundle, targetRoot: restoredRoot, browserSink: restoredBrowser, nonce: 'e2e-clean' });
    A.eq(receipt.ok, true, 'bundle restores to the genuinely absent target root');
    A.eq(restoredBrowser['starnet.station.v1'], JSON.stringify({ selectedRoom: 'lab' }), 'browser-owned state is recovered');
    A.eq(restoredBrowser['starnet.byok.key'], undefined, 'browser credential is not recovered');

    const boot2 = SidecarFixture.create({ prefix: 'starnet-recovery-boot2-', env: quietEnv(), timeoutMs: 15000 });
    const unusedBoot2Root = boot2.workspace;
    fs.rmSync(unusedBoot2Root, { recursive: true, force: true });
    boot2.workspace = restoredRoot;
    try {
      await boot2.start();
      const save = await boot2.json('GET', '/api/save?agent=agent');
      const cron = await boot2.json('GET', '/api/cron');
      const loops = await boot2.json('GET', '/api/loops');
      const permissions = await boot2.json('GET', '/api/permissions');
      const projects = await boot2.json('GET', '/api/projects');
      const connectors = await boot2.json('GET', '/api/connectors');
      A.eq(save.status, 200, 'restored sidecar serves the durable save');
      A.eq(save.body.save.agent.name, 'NOVA', 'restored agent identity is authoritative');
      A.ok(save.body.save.station.rooms.some(x => x.id === 'lab') && save.body.save.station.props.some(x => x.id === 'terminal'), 'restored rooms and props are authoritative');
      A.ok(cron.body.jobs.some(x => x.name === 'Recovery routine'), 'restored routine is live after boot');
      const restoredLoop = loops.body.loops.find(x => x.name === 'Recovery loop');
      A.ok(restoredLoop, 'restored loop is listed after boot');
      A.eq(restoredLoop.enabled, false, 'and comes back disabled');
      A.eq(restoredLoop.state, 'paused', 'and paused, so a person can resume it');
      // index.js boot: "else armLoops()" arms the timer only when a live loop exists, so a real boot leaving it unset proves no resume
      A.eq(loops.body.armed, false, 'the boot did not resume it: no loop timer is armed');
      A.eq(loops.body.halted, false, 'and no station-wide halt was left behind');
      A.ok(!fs.existsSync(path.join(restoredRoot, 'loops.halt.json')), 'no halt file was written');
      A.ok(receipt.reauthentication.some(x => x.kind === 'loop' && x.id === loop.body.loop.id), 'and it is listed to turn on');
      A.ok(/GOAL LOOPS/.test(receipt.reauthentication.find(x => x.kind === 'loop').reason), 'under the name the window really has');
      A.ok(!permissions.body.grants.includes('cabinet:write'), 'an "always allow" does not come back live');
      A.ok(receipt.reauthentication.some(x => x.kind === 'approval' && x.id === 'cabinet:write'), 'and is listed to approve again');
      A.eq(cron.body.enabled, false, 'and the restored routine is switched off');
      A.ok(!permissions.body.grants.includes('path:' + projectRoot), 'machine-specific project authority is not silently transferred');
      A.ok(projects.body.projects.some(x => x.root === projectRoot && x.blessed === false), 'restored project reference is visible but truthfully revoked');
      A.ok(Array.isArray(connectors.body.connectors) && connectors.body.connectors.some(x => x.id === 'local-reference'), 'restored connector reference is listed');
      A.ok(receipt.reauthentication.some(x => x.kind === 'connector' && x.id === 'local-reference'), 'restore reports connector reauthentication');
      A.ok(receipt.reauthentication.some(x => x.kind === 'project-path' && x.id === projectRoot), 'restore reports project-path reauthorization');
      A.eq(fs.readFileSync(path.join(restoredRoot, 'agent', 'project', 'result.md'), 'utf8'), '# live deliverable\n', 'restored deliverable bytes survive the second sidecar boot');
    } finally {
      rollbackDir = boot2.workspace;
      await boot2.dispose();
    }
  } finally {
    await source.dispose();
    if (!target._disposed) await target.dispose();
    if (rollbackDir && fs.existsSync(rollbackDir)) fs.rmSync(rollbackDir, { recursive: true, force: true });
  }
  A.report('station-recovery.e2e.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
