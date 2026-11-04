'use strict';
/* Every visibility cell runs through the production projection and real dispatch-final validator. */
const A = require('./_assert.js');
const crypto = require('node:crypto');
const K = require('../frontend/app/turnkinds.js');
let View = require('../sidecar/turn-view.js');
if (process.env.TURN_VIEW_CONTROL) {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
  const filename = require.resolve('../sidecar/turn-view.js'), m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(process.env.TURN_VIEW_CONTROL, 'utf8'), filename); View = m.exports;
}
let Store = require('../sidecar/transcriptstore.js');
if (process.env.TURN_DISPATCH_CONTROL) {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
  const filename = require.resolve('../sidecar/transcriptstore.js'), m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(process.env.TURN_DISPATCH_CONTROL, 'utf8'), filename); Store = m.exports;
}
const Learning = require('../sidecar/trusted-learning.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const owner = { runId: 'owner-run', ownerDirective: true, internal: false, agentId: 'agent', streamId: 's' };
const base = { rowId: 1, streamId: 's', sourceRunId: 'owner-run', agentId: 'agent', role: 'user', content: 'please write a summary', taintKnown: true, directive: true, kind: 'turn' };
const final = { rowId: 2, streamId: 's', sourceRunId: 'dispatch-run', agentId: 'agent', role: 'assistant', content: 'accepted answer',
  dispatchState: 'final', dispatchPrompt: 'accepted question', dispatchReason: 'done', textLength: 15, textSha256: hash('accepted answer') };
const dispatch = { runId: 'dispatch-run', reason: 'done', dispatchDelivery: { state: 'final', text: final.content, reason: 'done', textLength: final.textLength, textSha256: final.textSha256 } };
const runOf = id => id === 'owner-run' ? owner : id === 'dispatch-run' ? dispatch : id === 'interrupted-run' ? { reason: 'interrupted' } : null;
const common = { runOf, hash, rowTaint: Store.rowTaint, quotedMaterial: Learning.quotedMaterial,
  projectConversation: Store.projectConversation, isFinalDeliveryRow: row => Store.isFinalDeliveryRow(row, hash, (runOf(row.sourceRunId) || {}).dispatchDelivery) };
const opts = { streamId: 's', shape: 'prose', form: 'post', rows: true };
const make = extra => Object.assign({}, base, extra);
// Columns are model-replay, owner-evidence, recall, display, proof. Conditional cells get additional controls below.
const fixtures = [
  ['turn-user', make(), [1, 1, 1, 1, 1]],
  ['delegator', make({ from: 'parent' }), [1, 0, 1, 1, 1]],
  ['api', make({ kind: 'api' }), [1, 0, 1, 1, 1]],
  ['assistant', make({ role: 'assistant', directive: undefined, content: 'answer' }), [1, 0, 1, 1, 1]],
  ['tool', make({ role: 'tool', toolCallId: 'call', content: 'result' }), [0, 0, 1, 1, 1]],
  ['goal-step', make({ kind: 'goal-step' }), [1, 0, 1, 1, 1]],
  ['routine', make({ kind: 'routine' }), [1, 0, 1, 1, 1]],
  ['group', make({ kind: 'group' }), [0, 0, 0, 0, 1]],
  ['station', make({ kind: 'station' }), [0, 0, 0, 0, 1]],
  ['capture', make({ kind: 'capture' }), [0, 0, 0, 0, 1]],
  ['hop', make({ kind: 'hop', line: 'line@dock' }), [0, 0, 1, 1, 1]],
  ['steer', make({ kind: 'steer', role: 'system' }), [1, 1, 1, 1, 1]],
  ['deliverable', make({ kind: 'deliverable', role: 'system' }), [0, 0, 1, 1, 1]],
  ['attachment', make({ kind: 'attachment', role: 'system' }), [0, 0, 1, 0, 1]],
  ['delivery', make({ kind: 'delivery', role: 'assistant' }), [1, 0, 1, 1, 1]],
  ['observed', make({ kind: 'observed' }), [1, 0, 1, 1, 1]],
  ['carried', make({ carriedBy: 'run-carrier' }), [1, 0, 1, 1, 1]],
  ['dispatch-prompt', make({ sourceRunId: 'dispatch-run', dispatchState: 'pending', content: 'transport instruction' }), [1, 0, 1, 1, 1], { extra: [final] }],
  ['dispatch-final', final, [1, 0, 1, 1, 1]],
  ['dispatch-unaccepted', make({ sourceRunId: 'interrupted-run', dispatchState: 'pending' }), [0, 0, 0, 1, 1]],
  ['retract', make({ kind: 'retract', role: 'system', targets: [9], reason: 'undo' }), [0, 0, 0, 0, 1]],
  ['retract-target', make(), [0, 0, 0, 0, 1], { extra: [make({ rowId: 9, kind: 'retract', role: 'system', targets: [1], reason: 'undo' })] }],
  ['forgotten', make(), [0, 0, 0, 0, 1], { ctx: { forgotten: () => true } }],
  ['live', make(), [0, 0, 0, 0, 1], { ctx: { live: new Set(['owner-run']) } }],
  ['idless', make({ rowId: undefined }), [0, 0, 0, 0, 0]],
  ['local', make({ sys: true, kind: undefined }), [0, 0, 0, 1, 1]]
];
A.eq(fixtures.map(f => f[0]).sort(), Object.keys(K.MATRIX).sort(), 'one fixture for every matrix row');
for (const [name, row, expected, setup = {}] of fixtures) {
  for (let i = 0; i < K.VIEWS.length; i++) {
    const view = K.VIEWS[i], rows = View.project(view, [row, ...(setup.extra || [])], Object.assign({}, common, setup.ctx), opts);
    A.eq(rows.some(r => r.rowId === row.rowId && r.role === row.role), !!expected[i], name + '/' + view);
  }
}
const project = (name, rows, extraOpts, extraCtx) => View.project(name, rows, Object.assign({}, common, extraCtx), Object.assign({}, opts, extraOpts));
A.eq(project('model-replay', [make({ role: 'tool', toolCallId: 'call' })], { shape: 'pairs' }).length, 1, 'pairs matrix admits tool evidence before message-shape boundary');
A.eq(project('model-replay', [make({ kind: 'group' })], { group: true }).length, 1, 'group frame only inside group context');
A.eq(project('model-replay', [make({ kind: 'hop', line: 'line@dock' })], { line: 'line@dock' }).length, 1, 'hop replays for its own exact line');
A.eq(project('model-replay', [make({ kind: 'hop', line: 'line@dock' })], { line: 'other@dock' }).length, 0, 'entry or other line cannot replay stage history');
A.eq(project('recall', [make({ kind: 'routine' })], { streamId: 'other' }).length, 0, 'routine recall is scoped to its stream');
A.eq(project('display', [base], { liveDirective: true }, { live: new Set(['owner-run']) }).length, 1, 'explicit live-directive option exposes only a directive');
A.eq(project('display', [make({ role: 'assistant', directive: false })], { liveDirective: true }, { live: new Set(['owner-run']) }).length, 0, 'live-directive option never exposes a live answer');
const retry = make({ rowId: 9, kind: 'retract', role: 'system', targets: [1], reason: 'retry' });
A.eq(project('display', [base, retry]).map(r => r.rowId), [1], 'Q8 retry target stays visible by default');
A.eq(project('model-replay', [base, retry]), [], 'retry target never replays');
A.eq(project('display', [base, retry], { hideRetry: true }), [], 'explicit hide policy hides retry target');
A.throws(() => View.project('model-replay', [base], common, {}), 'model replay refuses an omitted shape');
const shaped = project('model-replay', [make({ typed: 'caption', attachments: [{ id: 'photo', path: '.attachments/photo.png' }] }), make({ rowId: 2, role: 'assistant', content: 'answer' })], { rows: false, form: 'pre' });
A.eq(shaped[0].content, 'caption', 'pre-expansion shape uses typed wording');
A.eq(shaped[0].attachments[0].id, 'photo', 'pre-expansion shape carries attachment refs');
A.eq(shaped[View.ROW_IDS], [{ streamId: 's', rowId: 1 }, { streamId: 's', rowId: 2 }], 'parallel row map records each emitted message');
A.ok(!JSON.stringify(shaped).includes('rowId') && !Object.keys(shaped).includes(String(View.ROW_IDS)), 'provider payload carries no identity metadata');
for (const shape of ['prose', 'pairs']) for (const form of ['pre', 'post']) {
  const prompt = make({ sourceRunId: 'dispatch-run', dispatchState: 'pending', content: 'transport frame', typed: 'STALE ORIGINAL CAPTION', attachments: [{ id: 'old', path: '.attachments/old.png' }] });
  const accepted = project('model-replay', [prompt, final], { rows: false, shape, form });
  A.eq(accepted.map(r => [r.role, r.content]), [['user', 'accepted question'], ['assistant', 'accepted answer']], 'accepted dispatch prompt wins typed wording in ' + shape + '/' + form);
  A.ok(!accepted[0].attachments, 'accepted dispatch prompt does not re-expand stale attachment refs in ' + shape + '/' + form);
}
const pendingPrompt = make({ sourceRunId: 'dispatch-run', dispatchState: 'pending', content: 'transport frame' });
A.eq(project('recall', [pendingPrompt, Object.assign({}, final, { textSha256: '0'.repeat(64) })]), [], 'corrupt final cannot lend acceptance to a recall prompt');
const absentCtx = { runOf: id => id === 'dispatch-run' ? Object.assign({}, dispatch, { deliveryPrompt: 'display-only fallback' }) : runOf(id) };
A.eq(project('recall', [pendingPrompt], {}, absentCtx), [], 'run-envelope final without its verified row cannot lend recall acceptance');
A.eq(project('display', [pendingPrompt], {}, absentCtx).map(r => r.content), ['display-only fallback'], 'legacy display-only prompt fallback remains without an acceptance mark');
for (const extra of [{ taintKnown: undefined }, { taint: 'external input' }, { from: 'delegate' }, { content: '> quoted owner words' }])
  A.eq(project('owner-evidence', [make(extra)]), [], 'owner evidence rejects missing/tainted/quoted/delegated proof ' + JSON.stringify(extra));
A.eq(project('owner-evidence', [base], {}, { runOf: () => null }), [], 'missing original run cannot supply owner proof');
A.report('turn-view.matrix');
