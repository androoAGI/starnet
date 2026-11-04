/* node test/workflow-stage-truth.test.js — two facts a line stage's own model cannot be trusted to state.
   #81: a stage reported "saved to project/reports/x.md" with the file in its private workspace. The tool receipts and the
   system line already told the MODEL; the person only had its prose. A folderless stage's run now ends with a host note
   built from what its tools really wrote, delivered as live reply text (agent.token), before the run ends. It names files
   jail-relative, and the next bay never reads it.
   #28: an owner's Telegram DM holds team.dispatch, and a first bay was told to delegate to the bays the line runs anyway.
   Zero network. The line's own route from a bot is proved by test/channels.telegram.botchain.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const { workflowPrivateFilesNote: note, withoutHostNotes, lineStageTeam } = require('../sidecar/projectbless.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');

const WS = path.join(path.sep, 'ws', 'head');
const base = { workspaceDir: WS, pathMod: path };
(async () => {
  // ---- #81: the reporter's case
  const n = note(Object.assign({ hasFolder: false, artifacts: [{ kind: 'file', path: 'project/reports/q3.md', bytes: 9 }] }, base));
  A.ok(n.includes('project/reports/q3.md'), 'the note names the file: ' + n);
  A.ok(!n.includes(WS) && !n.includes(path.sep + 'ws'), 'by its jail-relative form, never a host path: ' + n);
  const inside = note(Object.assign({ hasFolder: false, artifacts: [{ kind: 'file', path: path.join(WS, 'made', 'a.md') }] }, base));
  A.ok(inside.includes(path.join('made', 'a.md')) && !inside.includes(WS), 'an absolute path inside the jail is shown from the jail: ' + inside);
  const noJail = note({ hasFolder: false, pathMod: path, artifacts: [{ kind: 'file', path: path.join(WS, 'a.md') }] });
  A.eq(noJail, '', 'with no known jail (a Docker or SSH path means nothing here), an absolute path is never printed');
  A.ok(/private workspace, not a project folder/.test(n) && /later steps and SEND TO recipient/.test(n) && /WORKING FOLDER/.test(n), 'says who can read handed files and how to keep them in a project: ' + n);
  A.eq(note(Object.assign({ hasFolder: true, artifacts: [{ kind: 'file', path: 'project/reports/q3.md' }] }, base)), '', 'a line with a working folder: a relative path IS the project');
  const abs = path.resolve(path.sep, 'trusted', 'reports', 'q3.md');
  A.eq(note(Object.assign({ hasFolder: false, artifacts: [{ kind: 'file', path: abs }] }, base)), '', 'an absolute path the tool accepted is its own proven location');
  A.eq(note(Object.assign({ hasFolder: false, artifacts: [{ kind: 'file', path: 'C:\\trusted\\q3.md' }] }, base)), '', 'a Windows absolute path too, on any platform');
  A.eq(note(Object.assign({ hasFolder: false, artifacts: [{ kind: 'message', target: 'slack' }] }, base)), '', 'a message is not a file');
  A.eq(note(Object.assign({ hasFolder: false, artifacts: [] }, base)), '', 'no files, no note');
  A.ok(/and 2 more/.test(note(Object.assign({ hasFolder: false, artifacts: Array.from({ length: 7 }, (_, i) => ({ kind: 'file', path: 'f' + i })) }, base))), 'a long list stays short');

  // the note reaches every reply reader, once, before the run ends; a broken note never breaks a run
  for (const [closingNote, expected] of [[() => 'NOTE', 1], [() => '', 0], [null, 0], [() => { throw new Error('boom'); }, 0]]) {
    const seen = [];
    const provider = { async *stream() { yield { type: 'text', delta: 'saved to project/reports/q3.md' }; yield { type: 'usage', usage: { cost: 0 } }; yield { type: 'done', finishReason: 'stop' }; } };
    const out = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit: (name, p) => seen.push({ name, p }), cost: makeCostEngine(), model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 2 }, closingNote });
    A.eq(out.reason, 'done', 'the run ends done');
    const at = seen.findIndex(e => e.name === 'agent.token' && /NOTE/.test(e.p.delta));
    A.eq(seen.filter(e => e.name === 'agent.token' && /NOTE/.test(e.p.delta)).length, expected, 'the note appears ' + expected + ' time(s)');
    if (expected) A.ok(at < seen.findIndex(e => e.name === 'agent.run.end'), 'before agent.run.end, so a channel reply carries it');
  }

  // the next bay never reads the note; the person does
  const handed = 'the work\n\n' + note(Object.assign({ hasFolder: false, artifacts: [{ kind: 'file', path: 'x.md' }] }, base)) + '\n';
  A.eq(withoutHostNotes(handed).trim(), 'the work', 'the note comes off');
  A.eq(withoutHostNotes('plain work\nsecond line'), 'plain work\nsecond line', 'other text is untouched');
  A.eq(withoutHostNotes('[StarNet] something the model wrote'), '[StarNet] something the model wrote', 'only that sentence');
  {
    const calls = [], noteText = note(Object.assign({ hasFolder: false, artifacts: [{ kind: 'file', path: 'bay1/x.md' }] }, base));
    const say = () => {};
    const runner = makeChainRunner({ nextAgent: a => (a === 'one' ? 'two' : a === 'two' ? 'three' : null), emit: say });
    const out = await runner.advance({ agentId: 'one', text: 'bay one work\n\n' + noteText + '\n', originalText: 'ask', lineId: 'L1',
      runAgent: async c => { calls.push(c.text); return { text: c.agentId === 'two' ? 'bay two work\n\n' + noteText + '\n' : 'bay three work\n\n' + noteText + '\n', usd: 0 }; } });
    A.ok(calls.length === 2, 'the fixture line ran two hops: ' + calls.length);
    A.ok(calls.every(t => !t.includes('private workspace')), 'no hop\'s prompt carries a host note: ' + calls.join(' | ').slice(0, 300));
    A.ok(calls[0].includes('bay one work') && calls[1].includes('bay two work'), 'the work itself is handed on');
    A.ok(String(out.text).includes('private workspace'), 'and the last bay\'s reply keeps its note for the person');
  }

  // ---- #28, over a fake of the router's reads: three bays, chloe -> olivier -> margot, and dual on L1 only by a second dock
  {
    const docks = { chloe: ['d1'], olivier: ['d2'], margot: ['d3'], dual: ['other', 'd4'], bystander: ['far'] };
    const lineOf = { d1: 'L1', d2: 'L1', d3: 'L1', d4: 'L1', other: 'L2', far: 'L3', solo: 'L4' };
    const router = {
      docksOf: id => docks[id] || [],
      lineOfDock: d => lineOf[d] || null,
      chainPeek: (id, ctx) => { router.asked.push(ctx); return (id === 'margot' || id === 'solo') ? null : { agentId: 'next' }; },
      asked: []
    };
    const stage = lineStageTeam(router, { lineId: 'L1', agentId: 'chloe', dockId: 'd1' });
    A.eq(['olivier', 'margot', 'dual', 'bystander', 'chloe'].map(stage.leaves), [true, true, true, false, false], 'a stage with a next bay leaves the line out, a multi-bay agent on its second line too, and nobody else');
    A.ok(/next bay automatically/.test(stage.note) && /team\.dispatch/.test(stage.note), 'and it is told why: ' + stage.note);
    A.eq(router.asked[0], { lineId: 'L1', tag: 'general', dockId: 'd1' }, 'the question is about this bay, on this line');
    for (const [why, o] of [['the last bay', { lineId: 'L1', agentId: 'margot' }], ['a one-bay line', { lineId: 'L4', agentId: 'solo' }], ['a terminal routine or a direct order (capLine null)', { lineId: null, agentId: 'chloe' }]]) {
      const s = lineStageTeam(router, o);
      A.eq([s.note, s.leaves('olivier')], ['', false], why + ' hears nothing about a next bay and keeps its team');
    }
    A.eq(lineStageTeam({ chainPeek() { throw new Error('plan gone'); } }, { lineId: 'L1', agentId: 'chloe' }).note, '', 'a plan that cannot be read changes nothing');
  }

  // ---- host wiring, source-locked (runOnceCore cannot run here)
  const idx = require('./helpers/source').readSidecarSource();
  A.ok(/const capLine = \(o\.cronJobId && o\.runsLine !== true\) \? null : workflowLine;/.test(idx), 'a terminal routine is not line work');
  A.ok(/const stageTeam = lineStageTeam\(observe, \{ lineId: capLine, agentId, dockId: o\.dockId \}\);/.test(idx), 'runOnce asks about capLine, so a terminal routine keeps its team');
  A.ok(/teamNote \+= stageTeam\.note;/.test(idx) && /if \(aid === agentId \|\| stageTeam\.leaves\(aid\)\) continue;/.test(idx), 'and uses both answers');
  A.ok(/teamNote \+= \(stageTeam\.note && !lines\.length\) \? '[^']*no one else to delegate to[^']*' : summonLine;/.test(idx), 'an empty stage team is not told to summon and dispatch');
  const chainSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'sidecar', 'routing', 'chain.js'), 'utf8');
  A.eq((chainSource.match(/text: withoutHostNotes\(turn\)/g) || []).length, 2, 'both of the chain\'s hop calls strip the note');
  A.ok(/closingNote: \(workflowLine && !internal\) \? \(\) => workflowPrivateFilesNote\(\{ hasFolder: !!\(o\.workdir \|\| o\.projectRoot\), artifacts: execution\.artifactList\(\)/.test(idx), 'runOnce closes a workflow stage with the note');
  A.report('workflow-stage-truth.test');
})().catch(e => { console.log('FAIL: workflow-stage-truth.test threw -- ' + (e && e.stack || e)); process.exit(1); });
