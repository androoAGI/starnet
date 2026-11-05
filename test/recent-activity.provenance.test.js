'use strict';
/* Execute the actual host assembly and the actual RECENT ACTIVITY renderer, after interleaved internal runs
   have fallen outside the sixty-run display window. No content-head recognizer supplies authority. */
const A = require('./_assert.js');
const vm = require('node:vm');
const { sidecarFunctionSource } = require('./helpers/source.js');
const Store = require('../sidecar/transcriptstore.js');
const History = require('../sidecar/transcript-history.js');
const Learning = require('../sidecar/trusted-learning.js');
const contextpack = require('../sidecar/contextpack.js');
const CommanderContext = require('../sidecar/commander-context.js');
const Interests = require('../sidecar/interests.js');
const now = 100000, runRows = [], io = History.makeMemoryTranscriptIo();
const store = Store.makeTranscriptStore({ io, clock: { now: () => now }, runOf: id => runRows.find(row => row.runId === id), quotedMaterial: Learning.quotedMaterial });
function append(runId, streamId, content, internal) {
  runRows.push({ runId, streamId, agentId: 'agent', ownerDirective: !internal, internal, title: content, ts: now });
  return store.appendStrict({ sourceRunId: runId, streamId, agentId: 'agent', role: 'user', content, ts: now, taint: null,
    directive: true, kind: internal ? 'station' : 'turn' });
}
const directive = append('owner', 's', 'Please repair reconnect ordering', false);
A.eq(directive.taintKnown, true, 'fixture uses the real writer checked-clean stamp');
append('old-named-internal', 's', 'INTERNAL_NAMED_SENTINEL body whose title will fall outside the display window', true);
append('old-global-internal', 'global', 'INTERNAL_GLOBAL_SENTINEL arbitrary station text', true);
for (let i = 0; i < 75; i++) append('internal-' + i, i % 2 ? 's' : 'global', 'INTERNAL_LATER_' + i, true);
const brief = { id: 'tb_owner', originalRunId: 'owner', agentId: 'agent', streamId: 's', directiveRowId: directive.rowId,
  originalDirective: directive.content, completedAt: now, status: 'done' };
const sandbox = { Map, Set, Date: { now: () => now }, TrustedLearning: Learning, transcriptStore: store, runView: (name, r) => r, runStore: { all: () => runRows },
  taskBriefStore: { list: () => [brief] }, contextpack, nightshiftRecentRuns: () => runRows.slice(-60).concat([{ runId: 'unsourced', title: 'UNSOURCED_RUN_LABEL', ts: now }]),
  commanderGoals: { get: () => ({ text: 'UNSOURCED_GOAL_LABEL' }) }, autonomyLedger: { list: () => [] }, nightshiftBeliefMap: () => ({}),
  Recommendation: { preferenceTallies: () => ({}) }, nightshiftPreferenceWeights: () => ({}), stationTrackRecordLines: () => [],
  redact: text => text, threadsStore: { openThreads: () => [] }, personalizationStore: { read: () => ({ enabled: false }) },
  commanderDossier: { get: () => '' }, failNote(tag, error) { throw new Error(tag + ': ' + error.message); } };
vm.createContext(sandbox);
for (const name of ['evidenceRows', 'nightshiftContextPack', 'commanderEvidenceInputs']) vm.runInContext(sidecarFunctionSource(name), sandbox);
const pack = sandbox.nightshiftContextPack({});
const ownerIds = new Set(store.view('owner-evidence', null, {}).map(row => row.rowId));
A.ok(pack.activity.length > 0, 'the actual host activity path produces positive evidence');
A.eq(pack.activity.map(entry => entry.line), pack.activityLines, 'each authority line keeps its parallel source after caps and dedup');
A.ok(pack.activity.every(entry => entry.src && ownerIds.has(entry.src.rowId) && entry.src.streamId === 's' && entry.src.runId === 'owner'), 'all actual activity sources are proven original owner directives');
A.ok(!pack.activityLines.join('\n').includes('INTERNAL_'), 'internal calls stay absent after more than sixty intervening runs');
A.ok(!pack.activityLines.join('\n').includes('UNSOURCED_'), 'unsourced context labels never enter the authority-bearing pool');
A.ok(pack.sections.some(section => section.lines.some(line => line.includes('UNSOURCED_RUN_LABEL'))), 'general run label remains in its explicitly titled context section');
A.ok(pack.sections.some(section => section.lines.some(line => line.includes('UNSOURCED_GOAL_LABEL'))), 'general goal label remains in its explicitly titled context section');
const inputs = sandbox.commanderEvidenceInputs({});
const rendered = CommanderContext.compose(inputs);
A.ok(rendered.includes('RECENT ACTIVITY:') && rendered.includes('repair reconnect'), 'real commander evidence composition renders the proved activity');
A.ok(!rendered.split('\n').filter(line => line.includes('RECENT ACTIVITY:')).some(line => /INTERNAL_|UNSOURCED_/.test(line)), 'actual RECENT ACTIVITY renderer receives no internal or unsourced line');
A.eq(pack.trustedActivityLines, pack.activityLines, 'interests extraction receives the same proven line set');
A.eq(pack.trustedActivity, pack.activity, 'interests provenance stays aligned with those exact lines');
const extraction = Interests.buildDirective({ activityLines: pack.trustedActivityLines, knownTopics: [] });
A.ok(extraction.includes('repair reconnect') && !/INTERNAL_|UNSOURCED_/.test(extraction), 'actual interests extraction prompt is grounded only in the proven subset');
const assembly = sidecarFunctionSource('nightshiftContextPack');
A.ok(assembly.includes('rowId: m.rowId') && assembly.includes('sourceRunId: m.sourceRunId'), 'host passes durable chat provenance into the pure assembler');
A.ok(!require('node:fs').readFileSync(require.resolve('../sidecar/contextpack.js'), 'utf8').includes('const internalHeads'), 'head matching is not the proof authority');
for (let i = 0; i < 410; i++) append('noise-' + i, 's', 'later internal row ' + i, true);
const later = sandbox.evidenceRows({});
A.eq(later.ownerRecent.length, 0, 'activity bounds the latest four hundred raw candidates before owner filtering');
A.ok(later.transcript.some(row => row.rowId === directive.rowId), 'the separate disk brief proof still reaches the older directive');
A.report('recent-activity.provenance');
