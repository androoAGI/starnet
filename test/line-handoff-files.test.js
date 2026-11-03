/* Line work products over the real file tools, producer locator and path trust. Only runOnce's model/transport is
   replaced: each stage writes/reads real temporary files through the production fs tools. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const RunPaths = require('../sidecar/run-paths.js');
const { makeLineRunner, profiles } = require('../sidecar/routing/line-runner.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeStepTest } = require('../sidecar/routing/steptest.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeHandoffRunner } = require('../sidecar/routing/handoff-runner.js');
const { mergeFiles, productOf } = require('../sidecar/routing/work-product.js');
const P = require('../frontend/app/pipeline.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-line-files-'));
const workspaces = path.join(ROOT, 'workspaces');
async function denied(p, message) { try { await p; A.ok(false, message); } catch (_) { A.ok(true, message); } }

async function main() {
  for (const agent of ['writer', 'reviewer', 'final', 'stranger']) await fsp.mkdir(path.join(workspaces, agent), { recursive: true });
  const trust = makePathTrust({ fsp, pathMod: path, roots: () => [], workspaceRoot: workspaces });
  const toolsFor = (agentId, reads) => makeFsTools({ fsp, pathMod: path, root: workspaces,
    pathTrust: (abs, o) => trust.guard(abs, { scope: o.scope, surface: 'autonomous', agentId, readGrants: reads || [] }) });
  const ctx = agentId => ({ agentId, emit: () => {} });
  const folder = path.join(workspaces, 'writer', 'produced');
  await fsp.mkdir(folder);
  const named = path.join(folder, 'notes.md');
  await toolsFor('writer').writeTool.run({ path: 'produced/notes.md', content: 'the produced notes' }, ctx('writer'));
  const proved = await RunPaths.locateProduced({ fsp, pathMod: path, jail: path.join(workspaces, 'writer'), list: [{ path: 'produced/notes.md' }] });
  const granted = proved[0] && proved[0].abs;
  A.eq(granted, await fsp.realpath(named), 'the locator grants the producer file canonical path');
  const reader = toolsFor('reviewer', [granted]);
  const read = await reader.readTool.run({ path: granted }, ctx('reviewer'));
  A.ok(read.content.includes('the produced notes'), 'a later stage reads the exact produced file through real fs.read');
  await denied(toolsFor('reviewer').readTool.run({ path: granted }, ctx('reviewer')), 'a different job without the grant cannot read it');
  await denied(reader.writeTool.run({ path: granted, content: 'overwrite' }, ctx('reviewer')), 'handoff never grants a write to the producer file');
  await fsp.writeFile(path.join(folder, 'unrelated.md'), 'not produced by this job');
  await denied(reader.readTool.run({ path: path.join(folder, 'unrelated.md') }, ctx('reviewer')), 'a grant does not cover a sibling file');
  await denied(trust.guard(folder, { scope: 'read', surface: 'autonomous', agentId: 'reviewer', readGrants: [await fsp.realpath(folder)] }), 'a directory cannot become a handed file');
  const excluded = await RunPaths.locateProduced({ fsp, pathMod: path, jail: path.join(workspaces, 'writer'), list: [
    { path: 'produced' }, { path: '../stranger/private.md' }, { path: '//server/share/secret' }, { path: 'missing.md' }] });
  A.eq(excluded, [], 'folders, escapes, network paths and missing files are never produced-file grants');
  const project = path.join(ROOT, 'project'); await fsp.mkdir(project);
  await fsp.writeFile(path.join(project, 'same.md'), 'project copy');
  await fsp.writeFile(path.join(workspaces, 'writer', 'same.md'), 'stale private copy');
  const projectFile = await RunPaths.locateProduced({ fsp, pathMod: path, projectRoot: project, jail: path.join(workspaces, 'writer'), list: [{ path: 'same.md' }] });
  A.eq(projectFile.map(f => f.abs), [await fsp.realpath(path.join(project, 'same.md'))], 'a produced relative name uses its run project, never a stale private copy');
  await fsp.writeFile(path.join(workspaces, 'stranger', 'notes.md'), 'unrelated private work');
  A.eq(await RunPaths.locateProduced({ fsp, pathMod: path, jail: path.join(workspaces, 'writer'), list: [{ path: path.join(workspaces, 'stranger', 'notes.md') }] }), [], 'an absolute artifact outside the producer roots never grants another agent file');
  await fsp.rename(folder, folder + '-saved');
  await fsp.symlink(path.join(workspaces, 'stranger'), folder, process.platform === 'win32' ? 'junction' : 'dir');
  await denied(reader.readTool.run({ path: granted }, ctx('reviewer')), 'replacing a granted file parent with a junction cannot redirect the grant to another private file');
  await fsp.unlink(folder);
  await denied(reader.readTool.run({ path: granted }, ctx('reviewer')), 'a deleted producer file grants nothing');
  if (process.env.LJR_GUARD_ONLY === '1') return;

  A.eq(P.handoffPrompt('job', 'writer', 'draft', 1, '', '', false, []), P.handoffPrompt('job', 'writer', 'draft', 1, '', '', false), 'empty file ledger preserves every prompt byte');
  A.ok(P.handoffPrompt('job', 'writer', 'draft', 1, '', '', false, ['C:/proved.md']).includes('FILES THE UPSTREAM STAGE MADE (you can read these exact paths):\n- C:/proved.md'), 'the handoff names exact readable files');
  const many = Array.from({ length: 70 }, (_, i) => '/file-' + i);
  A.eq(mergeFiles(many.slice(0, 40), many.slice(20)), many.slice(0, 64), 'ledger keeps upstream-first distinct paths, capped at64');
  let parseCalls = 0;
  A.eq(productOf({ text: 'VERDICT: revise', verdict: 'approved', draft: 'original draft' }, { getVerdict: () => { parseCalls++; return 'revise'; } }).verdict, 'approved', 'a producer verdict is carried, never re-read from later framing');
  A.eq(parseCalls, 0, 'a carried verdict is not parsed a second time');
  const floor = { props: [
    { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
    ...['writer', 'reviewer', 'final'].map((agentId, i) => ({ id: 'b' + i, t: 'bay', x: 4 + i * 3, y: 0, w: 1, h: 1, agentId })),
    { id: 'o', t: 'outbox', x: 13, y: 0, w: 1, h: 1 }], belts: [1, 2, 3, 5, 6, 8, 9, 11, 12].map(x => ({ x, y: 0, dir: 'E' })) };
  const plan = P.compileRoutingPlan(floor), router = makeRouter();
  A.ok(router.setPlan(plan).ok, 'the file proof walks a real compiled three-stage line');
  const lineId = P.lineOf(plan, 'writer');
  const config = () => ({ key: 'test', model: 'test', configured: true });
  const kinds = {
    channel: profiles.channel({ config }), schedule: profiles.schedule({ config, system: () => '', station: () => null }),
    manual: profiles.manual({ config, system: () => '', station: () => null }),
    steptest: profiles.steptest({ config, brief: () => '', dockSystem: () => '', station: () => null, emit: () => {} })
  };
  let seq = 0;
  for (const [name, profile] of Object.entries(kinds)) {
    const rows = new Map(), calls = [], seen = [];
    const locate = (agentId, list, where) => RunPaths.locateProduced({ fsp, pathMod: path, list, limit: 64,
      jail: path.join(workspaces, agentId), projectRoot: where.projectRoot });
    const runOnce = async o => {
      calls.push(o);
      const tools = toolsFor(o.agentId, o.handoffReads), stage = ctx(o.agentId);
      if (o.agentId !== 'writer') {
        for (const file of o.handoffReads || []) seen.push((await tools.readTool.run({ path: file }, stage)).content);
        A.ok((o.messages[0].content || '').includes('FILES THE UPSTREAM STAGE MADE'), name + ': downstream prompt carries its readable file paths');
      }
      const file = o.agentId + '-' + name + '.md';
      await tools.writeTool.run({ path: file, content: name + ':' + o.agentId }, stage);
      const row = { runId: o.runId, agentId: o.agentId, reason: 'done', outcome: 'succeeded', artifacts: [{ kind: 'file', path: file }] };
      rows.set(o.runId, row); o.emit('agent.run.end', row);
      return Object.assign({ text: 'finished ' + o.agentId }, row);
    };
    const chain = makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
      entryDockOf: a => router.entryDockOf(a), lineOfAgent: (a, d) => router.lineOfAgent(a, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d), now: () => 1, newId: () => String(++seq) });
    const newRunner = () => makeLineRunner({ chain, runOnce, runRow: id => rows.get(id), handoffFiles: locate, newId: () => String(++seq), now: () => 1 });
    const runner = newRunner();
    const entry = await runner.hopRunner(profile)({ agentId: 'writer', entry: true, text: 'make notes', draft: 'make notes', lineId });
    A.ok(entry.files && entry.files.length === 1 && entry.endReason === 'done' && entry.outcome === 'succeeded' && entry.draft === 'make notes', name + ': producer returns a complete work product');
    const line = await runner.runLineJob({ seed: Object.assign({}, entry, { agentId: 'writer', lineId, originalText: 'make notes' }), profile });
    A.ok(!line.stopped && line.outboxId === 'o', name + ': real file handoff finishes the compiled line');
    A.eq(calls.slice(1).map(c => (c.handoffReads || []).length), [1, 2], name + ': stages inherit only this job ledger, upstream first');
    A.ok(seen.filter(x => x.includes(name + ':writer')).length === 2 && seen.some(x => x.includes(name + ':reviewer')), name + ': stage two and three actually read upstream bytes');
    A.eq((line.files || []).length, 3, name + ': final ledger includes all three producers');
    const second = await runner.hopRunner(profile)({ agentId: 'writer', entry: true, text: 'a second job', lineId });
    A.eq(calls[calls.length - 1].handoffReads || [], [], name + ': a second job inherits no previous job read grants');
    A.ok(second.runId !== entry.runId, name + ': each job starts its own producing run');
    if (name === 'steptest' && process.env.LJR_CORE_ONLY !== '1') {
      let disk = [];
      const stepRig = lineRunner => makeStepTest({ lineRunner, runDock: lineRunner.hopRunner(profile), now: () => 1, newId: () => 'step-' + (++seq),
        store: { load: () => JSON.parse(JSON.stringify(disk)), save: v => { disk = JSON.parse(JSON.stringify(v)); } },
        plan: { get: () => router.getPlan(), step: (a, c) => router.chainStep(a, c), peek: (a, c) => router.chainPeek(a, c),
          stepDock: (d, c) => router.chainStepDock(d, c), peekDock: (d, c) => router.chainPeekDock(d, c),
          entryDock: (line, text) => router.resolveDock({ lineId: line, text }), lineOf: (a, d) => router.lineOfAgent(a, d),
          shipsToOutbox: (a, d) => router.chainShipsToOutbox(a, d), lineLimits: line => router.lineLimits(line) } });
      calls.length = 0; seen.length = 0;
      let step = stepRig(newRunner());
      const started = step.start({ line: lineId, text: 'produce files through a paused test', pause: 'every' });
      A.ok(started.ok, 'real step-through starts the file-producing line');
      await step.settled(started.session.id);
      A.eq(step.get(started.session.id).session.state, 'paused', 'the first producer is saved at pause');
      step = stepRig(newRunner());   // new in-memory runner and step engine over the saved session
      for (let i = 0; i < 3; i++) { step.continue(started.session.id, {}); await step.settled(started.session.id); }
      A.eq(step.get(started.session.id).session.state, 'done', 'step-through resumes its persisted file ledger through the OUTBOX');
      A.eq(calls.map(c => (c.handoffReads || []).length), [0, 1, 2], 'pause/restart preserves exactly the producer file grants');
      A.ok(seen.some(x => x.includes('steptest:writer')) && seen.some(x => x.includes('steptest:reviewer')), 'resumed stages read the saved producer bytes');
    }
  }
  if (process.env.LJR_CORE_ONLY === '1') return;
  // Three SEND TO lines: B does not rewrite A's file, yet C must still receive that job's inherited file.
  const sendFloor = { props: [], belts: [] };
  for (const [i, agentId] of ['writer', 'reviewer', 'final'].entries()) {
    sendFloor.props.push({ id: 'si' + i, t: 'intake', x: 0, y: i * 4, w: 1, h: 1 },
      { id: 'sb' + i, t: 'bay', x: 4, y: i * 4, w: 1, h: 1, agentId },
      Object.assign({ id: 'so' + i, t: 'outbox', x: 7, y: i * 4, w: 1, h: 1 }, i < 2 ? { sendTo: 'si' + (i + 1) } : {}));
    sendFloor.belts.push(...[1, 2, 3, 5, 6].map(x => ({ x, y: i * 4, dir: 'E' })));
  }
  const sendPlan = P.compileRoutingPlan(sendFloor), sendRouter = makeRouter();
  A.ok(sendRouter.setPlan(sendPlan).ok && Object.keys(sendPlan.sendTo || {}).length === 2, 'real compiled SEND TO fixture has A to B to C');
  const sentFile = path.join(workspaces, 'writer', 'send-notes.md');
  await toolsFor('writer').writeTool.run({ path: 'send-notes.md', content: 'the first line made these notes' }, ctx('writer'));
  const sendRows = new Map(), received = [], hubs = [];
  const locate = (agentId, list, where) => RunPaths.locateProduced({ fsp, pathMod: path, list, limit: 64,
    jail: path.join(workspaces, agentId), projectRoot: where.projectRoot });
  let handoff = null;
  const sendChain = makeChainRunner({ nextAgent: (a, c) => sendRouter.chainNext(a, c), stepDock: (d, c) => sendRouter.chainStepDock(d, c),
    entryDockOf: a => sendRouter.entryDockOf(a), lineOfAgent: (a, d) => sendRouter.lineOfAgent(a, d), lastStage: (a, d) => sendRouter.chainShipsToOutbox(a, d),
    onShipped: r => handoff.onShipped(r), now: () => 10, newId: () => String(++seq) });
  const sendRun = async o => {
    const files = o.handoffReads || [];
    A.eq(files, [sentFile], o.agentId + ': SEND TO entry receives the exact original file');
    for (const file of files) received.push({ agent: o.agentId, text: (await toolsFor(o.agentId, files).readTool.run({ path: file }, ctx(o.agentId))).content });
    const row = { runId: o.runId, streamId: o.streamId, agentId: o.agentId, reason: 'done', outcome: 'succeeded', startedAt: 10, artifacts: [] };
    sendRows.set(o.runId, row); o.emit('agent.run.end', row);
    return Object.assign({ text: 'used the upstream notes' }, row);
  };
  const sendRunner = makeLineRunner({ chain: sendChain, runOnce: sendRun, runRow: id => sendRows.get(id), handoffFiles: locate, now: () => 10, newId: () => String(++seq) });
  handoff = makeHandoffRunner({ plan: () => sendPlan, lineRunner: sendRunner, handoffFiles: locate,
    runsFor: stream => [...sendRows.values()].filter(r => r.streamId === stream), now: () => 10, newId: () => 'sender' + (++seq),
    makeHub: hooks => {
      const turns = new Map();
      const hub = makeChannelHub(Object.assign({}, hooks, { channel: 'sendto', ownerSurface: true, bindChats: false, textBatchWaitMs: 0,
        runOnce: sendRun, lineRunner: sendRunner, now: () => 10, newId: () => String(++seq),
        store: { loadHistory: a => turns.get(a) || [], appendTurn: (a, role, content) => { const v = turns.get(a) || []; v.push({ role, content }); turns.set(a, v); }, getChatRecord: () => null },
        secrets: config, resolveEntryRunConfig: config, resolveRunConfig: config, classify: () => true,
        resolveAgent: c => hooks.onRouted(sendRouter.resolveDock(Object.assign({}, c, { lineId: hooks.lineId() }))),
        lineOriginFor: (a, d) => sendRouter.lineOriginFor(a, d), send: async (chatId, text) => { hooks.send(text); return { ok: true }; } }));
      hubs.push(hub); return hub;
    } });
  sendRows.set('source', { runId: 'source', streamId: 'source-chat', agentId: 'writer', reason: 'done', outcome: 'succeeded', startedAt: 1,
    artifacts: [{ kind: 'file', path: 'send-notes.md' }] });
  A.ok(handoff.onShipped({ lineId: P.lineOf(sendPlan, 'writer'), dockId: 'sb0', outboxId: 'so0', agentId: 'writer', streamId: 'source-chat', since: 1,
    text: 'use these notes', originalText: 'make a report' }).ok, 'source job enters SEND TO');
  for (let i = 0; i < 1000 && handoff.status().lines.some(l => l.running || l.queued); i++) await new Promise(r => setTimeout(r, 5));
  A.eq(received.map(r => r.agent), ['reviewer', 'final'], 'both later lines read the original file, even though the middle line made no file');
  A.ok(received.length === 2 && received.every(r => r.text.includes('the first line made these notes')), 'SEND TO target entries read real source bytes');
  for (const hub of hubs) hub.close();
}
main().catch(e => A.ok(false, String(e && e.stack || e))).finally(async () => {
  const owned = path.resolve(ROOT), temp = path.resolve(os.tmpdir()) + path.sep;
  if (!owned.startsWith(temp) || !path.basename(owned).startsWith('starnet-line-files-')) throw new Error('unexpected fixture cleanup target');
  await fsp.rm(owned, { recursive: true, force: true });
  A.report('line-handoff-files.test');
});
