/* node test/contextpack.test.js — the PURE recency-weighted CONTEXT PACK (NS-2).

   Locks the guarantees the propose step's magic depends on, all as deterministic transforms over injected inputs +
   a fake `now` (no Date.now — passes lint-determinism):
     · BOUNDS — total text ≤ maxChars; each section capped in item count; per-line length clamped.
     · EXCLUSIONS — internal streamIds (nightshift-/cron-/workshop-) never appear; out-of-window rows dropped.
     · DETERMINISM — same inputs → byte-identical output (twice).
     · REDACTION — a secret in a chat body never reaches the pack (redact injected, applied to first-lines).
     · EVIDENCE POOL — activityLines carries the real run/chat/goal/landed lines (the veto's extended pool) + is bounded. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const CP = require('../sidecar/contextpack.js');

const T = 1700000000000;              // fixed "now"
const DAY = 86400000;
const ago = (d) => T - d * DAY;
A.eq(CP.assemble({ runs: [{ title: 'INTERNAL recommendation reasoning', ts: T, internal: true, streamId: '' }] }, { now: T }).counts.runs, 0,
  'Internal recommendation generation must never become evidence of user work');

// a fake redact that strips a known secret shape (stands in for context.js's redact).
const redact = (s) => String(s == null ? '' : s).replace(/sk-secret-[A-Za-z0-9]+/g, '[redacted]');

function baseInputs(over) {
  return Object.assign({
    runs: [
      { title: 'Ship the StarNet beta', ts: ago(1), streamId: '' },            // user run (empty stream = default)
      { title: 'Refactor the belt router', ts: ago(2), streamId: 'ws-main' },  // user run (named workstream)
      { title: 'night-shift: Busywork', ts: ago(0), streamId: 'nightshift-abc' }, // INTERNAL — must be excluded
      { title: 'cron digest', ts: ago(0), streamId: 'cron-xyz' },              // INTERNAL — must be excluded
      { title: 'workshop build', ts: ago(0), streamId: 'workshop-1' },         // INTERNAL — must be excluded
      { title: 'Ancient task', ts: ago(30), streamId: '' }                     // OUT OF WINDOW (>7d) — dropped
    ],
    chats: [
      { role: 'user', content: 'help me automate release notes\nsecond line', ts: ago(1), streamId: '' },
      { role: 'assistant', content: 'sure', ts: ago(1), streamId: '' },        // not a user turn — dropped
      { role: 'user', content: 'internal beat prompt', ts: ago(0), streamId: 'nightshift-x' }, // internal — dropped
      { role: 'user', content: 'my key is sk-secret-ABC123 keep it safe', ts: ago(2), streamId: '' } // secret — redacted
    ],
    briefs: [
      { originalDirective: 'Audit the recommendation system\nFocus on evidence provenance and replay evaluation', ts: ago(1) }
    ],
    goal: { text: 'Launch to 100 users', done: 2, total: 5, next: 'write onboarding' },
    landed: [
      { title: 'Release checklist tool', verdict: 'kept', ts: ago(1) },
      { title: 'A rambling essay', verdict: 'discarded', ts: ago(2) }
    ],
    beliefs: { goals: ['ship the beta'], stack: ['node', 'canvas'] },
    learn: { 'advance-goal': { up: 3, down: 0 }, 'scout': { up: 0, down: 2 } },
    redact
  }, over || {});
}

/* ---------- exclusions: internal streams + out-of-window ---------- */
(function exclusions() {
  const pack = CP.assemble(baseInputs(), { now: T });
  const worked = (pack.sections.find(s => s.label === 'What they worked on recently') || {}).lines || [];
  A.ok(worked.some(l => /Ship the StarNet beta/.test(l)), 'a user run appears');
  A.ok(worked.some(l => /Refactor the belt router/.test(l)), 'a named-workstream user run appears');
  A.ok(!worked.some(l => /Busywork|cron digest|workshop build/.test(l)), 'internal-stream runs are excluded');
  A.ok(!worked.some(l => /Ancient task/.test(l)), 'out-of-window (>7d) run is excluded');
  // and the excluded ones are not in the evidence pool either:
  A.ok(!pack.activityLines.some(l => /Busywork|cron digest/.test(l)), 'internal runs are not in the evidence pool');
})();

/* ---------- redaction ---------- */
(function redaction() {
  const pack = CP.assemble(baseInputs(), { now: T });
  const all = pack.text + '\n' + pack.activityLines.join('\n');
  A.ok(all.indexOf('sk-secret-ABC123') < 0, 'the raw secret never reaches the pack');
  A.ok(all.indexOf('[redacted]') >= 0, 'the secret was redacted (backstop applied to chat first-lines)');
  // first-line only: the second line of the multi-line chat must not appear.
  A.ok(all.indexOf('second line') < 0, 'only the FIRST line of a chat is carried (not the whole body)');
})();

/* ---------- goal + landed + learn sections ---------- */
(function sections() {
  const pack = CP.assemble(baseInputs(), { now: T });
  const goalSec = pack.sections.find(s => s.label === 'Their current goal');
  A.ok(goalSec && /Launch to 100 users/.test(goalSec.lines[0]) && /2\/5 done/.test(goalSec.lines[0]) && /onboarding/.test(goalSec.lines[0]), 'goal line carries text + progress + next');
  const landedSec = pack.sections.find(s => s.label === 'Recent work they kept vs discarded');
  A.ok(landedSec && landedSec.lines.some(l => /Release checklist tool.*kept/.test(l)) && landedSec.lines.some(l => /rambling essay.*discarded/.test(l)), 'landed section marks kept vs discarded');
  const learnSec = pack.sections.find(s => s.label === 'What they tend to keep');
  A.ok(learnSec && /advance-goal/.test(learnSec.lines[0]) && /scout/.test(learnSec.lines[0]), 'learn line names up/down archetypes');
  // the goal + landed lines are in the evidence pool (candidates may ground on them):
  A.ok(pack.activityLines.some(l => /Launch to 100 users/.test(l)), 'goal line is in the evidence pool');
  A.ok(pack.activityLines.some(l => /Release checklist tool/.test(l)), 'a landed line is in the evidence pool');
  const briefSec = pack.sections.find(s => s.label === 'Completed task evidence');
  A.ok(briefSec && /evidence provenance and replay evaluation/.test(briefSec.lines[0]), 'completed briefs retain evidence beyond the first directive line');
  A.eq(pack.counts.briefs, 1, 'completed brief evidence is counted explicitly');
})();

/* ---------- determinism: same inputs → byte-identical ---------- */
(function determinism() {
  const a = CP.assemble(baseInputs(), { now: T });
  const b = CP.assemble(baseInputs(), { now: T });
  A.eq(a.text, b.text, 'text is deterministic');
  A.eq(a.activityLines.join('|'), b.activityLines.join('|'), 'evidence pool is deterministic');
  A.eq(JSON.stringify(a.counts), JSON.stringify(b.counts), 'counts are deterministic');
})();

/* ---------- bounds: char cap, item caps, line clamp ---------- */
(function bounds() {
  // a firehose: many runs + a giant title.
  const bigRuns = [];
  for (let i = 0; i < 50; i++) bigRuns.push({ title: 'Task number ' + i + ' ' + 'x'.repeat(400), ts: ago(1) - i, streamId: '' });
  const pack = CP.assemble(baseInputs({ runs: bigRuns }), { now: T, maxChars: 500 });
  A.ok(pack.text.length <= 500, 'total text respects maxChars (got ' + pack.text.length + ')');
  const worked = (pack.sections.find(s => s.label === 'What they worked on recently') || {}).lines || [];
  A.ok(worked.length <= CP.MAX_RUNS, 'run section capped to MAX_RUNS (' + worked.length + ')');
  A.ok(worked.every(l => l.length <= CP.LINE_MAX + 20), 'each run line is clamped near LINE_MAX');
  A.ok(pack.activityLines.length <= CP.ACTIVITY_POOL_MAX, 'evidence pool capped to ACTIVITY_POOL_MAX');
})();

/* ---------- empty night: honest empty pack ---------- */
(function empty() {
  const pack = CP.assemble({ runs: [], chats: [], goal: null, landed: [], beliefs: {}, learn: {} }, { now: T });
  A.eq(pack.text, '', 'a truly empty night yields empty text (nothing fabricated)');
  A.eq(pack.activityLines.length, 0, 'an empty night yields an empty evidence pool');
  A.eq(pack.counts.runs, 0, 'zero runs counted');
})();

/* ---------- isInternalStream unit ---------- */
A.eq(CP.isInternalStream('nightshift-abc'), true, 'nightshift- is internal');
A.eq(CP.isInternalStream('cron-1'), true, 'cron- is internal');
A.eq(CP.isInternalStream('workshop-9'), true, 'workshop- is internal');
A.eq(CP.isInternalStream(''), false, 'empty stream (default browser run) is NOT internal');
A.eq(CP.isInternalStream('ws-main'), false, 'a user workstream is NOT internal');

/* ---------- dayTag unit ---------- */
A.eq(CP.dayTag(T, T), 'today', 'same day → today');
A.eq(CP.dayTag(ago(1), T), 'yesterday', '1 day → yesterday');
A.eq(CP.dayTag(ago(3), T), '3d ago', '3 days → Nd ago');
A.eq(CP.dayTag(0, T), '', 'undated → empty tag');

// USER-STUDY LOOP — the station's own reason-only calls are not the Commander's activity: the internal run is
// excluded AND its directive row (which the transcript files as a 'user' line on the Commander's stream) drops too.
{
  const selfTalk = 'INTERNAL — GOAL DECOMPOSITION. Do not run any tools. Reason only, then reply in the exact format below.';
  const p = CP.assemble({
    runs: [{ title: selfTalk.slice(0, 120), ts: ago(0), streamId: 'ws-main', internal: true }, { title: 'Draft the launch post', ts: ago(0), streamId: 'ws-main' }],
    chats: [{ role: 'user', content: selfTalk + '\nYour Commander has this goal: …', ts: ago(0), streamId: 'ws-main' },
            { role: 'user', content: 'Can you draft the launch post for Friday?', ts: ago(0), streamId: 'ws-main' }]
  }, { now: T });
  A.ok(!p.activityLines.some(l => /GOAL DECOMPOSITION/.test(l)), 'an internal call never reads as the Commander\'s recent work or asks');
  A.ok(p.activityLines.some(l => /Draft the launch post/.test(l)) && p.activityLines.some(l => /launch post for Friday/.test(l)), 'the Commander\'s own runs and asks on the same stream are kept');
}
// Exercise the real host projection, then the real pure pack: a source regex cannot prove that private
// provenance survives filtering or that a completed brief actually belongs to a clean owner's directive.
{
  const src = readSidecarSource();
  const fn = A.fnBody(src, 'function nightshiftContextPack(evidence)');
  A.ok(fn.startsWith('function nightshiftContextPack(evidence)') && fn.length < 10000 && /return pack;\s*}$/.test(fn),
    'extract exactly the host context-pack function, not neighbouring code');
  // the one-snapshot-per-turn helper the pack reads the transcript + run history through (perf 10-19)
  const rowsFn = A.fnBody(src, 'function evidenceRows(ev)');
  A.ok(rowsFn.startsWith('function evidenceRows(ev)') && rowsFn.length < 600, 'extract exactly the host evidence snapshot helper');
  // the recent-run projection is its own host function (shared with the readiness count): run the REAL one too
  const recentFn = A.fnBody(src, 'function nightshiftRecentRuns()');
  A.ok(recentFn.startsWith('function nightshiftRecentRuns()') && recentFn.length < 2000, 'extract exactly the host recent-run projection');
  const countFn = A.fnBody(src, 'function nightshiftUserRunCount()');
  A.ok(countFn.startsWith('function nightshiftUserRunCount()') && countFn.length < 1000, 'extract exactly the host readiness count');
  const vm = require('vm');
  const TrustedLearning = require('../sidecar/trusted-learning.js');
  function host(input) {
    input = input || {};
    const projections = [];
    const requested = {};
    // Fixture run records are separate from the recent title window. Tests can override them to
    // represent an absent/mismatched/internal source without altering the row's own clean stamp.
    const originRuns = input.originRuns || (input.chats || []).filter(m => m && m.sourceRunId).map(m =>
      (input.runs || []).find(r => r && r.runId === m.sourceRunId) ||
      { runId: m.sourceRunId, agentId: m.agentId, streamId: m.streamId, internal: false, ownerDirective: true });
    const pack = vm.runInNewContext(recentFn + '\n' + rowsFn + '\n(' + fn + ')()', {
      Date: { now: () => T },
      personalizationStore: { read: () => ({ enabled: input.enabled !== false }) },
      TrustedLearning,
      runStore: {
        list: (agentId, opts) => { requested.runs = { agentId, opts }; return input.runs || []; },
        all: () => { requested.allRuns = (requested.allRuns || 0) + 1; return originRuns; }
      },
      transcriptStore: { all: () => input.chats || [] },
      taskBriefStore: { list: opts => { requested.briefs = opts; return input.briefs || []; } },
      commanderGoals: { get: () => null },
      autonomyLedger: { list: () => [] },
      nightshiftBeliefMap: () => ({}),
      Recommendation: { preferenceTallies: () => ({}) },
      nightshiftPreferenceWeights: () => ({}),
      stationTrackRecordLines: () => [],
      threadsStore: { openThreads: () => [] },
      redact,
      // the host's deleted-session test (session-tombstones.js via index.js sessionRunForgotten): nothing deleted by default
      sessionRunForgotten: input.forgotten || (() => false),
      contextpack: { assemble: (data, opts) => { projections.push(data); return CP.assemble(data, opts); } }
    });
    return { pack, projected: projections[0], trustedProjected: projections[1], projectionCount: projections.length, requested };
  }
  const owner = (content, over) => Object.assign({
    agentId: 'owner-agent', streamId: 'ws-main', sourceRunId: 'owner-original', role: 'user', content, taintKnown: true, ts: T
  }, over || {});
  const brief = (originalDirective, over) => Object.assign({
    id: 'tb_owner-original', originalRunId: 'owner-original', agentId: 'owner-agent', streamId: 'ws-main', originalDirective, completedAt: T
  }, over || {});

  const selfTalk = 'INTERNAL GOAL DECOMPOSITION fixture for the station';
  const taintedSelfTalk = 'INTERNAL TAINTED STATION PLANNING fixture';
  const quotedSelfTalk = 'INTERNAL QUOTED STATION PLANNING fixture';
  const clean = owner('Owner release plan on a mixed-trust stream');
  const multiline = owner('Owner next task\nKeep the verification command');
  const result = host({
    runs: [
      null,
      { title: 'Legacy clean run remains useful', ts: T, streamId: 'ws-main' },
      { title: 'Explicit clean run remains useful', ts: T, streamId: 'ws-main', taintedBy: null },
      { title: 'Tainted run sentinel', ts: T, streamId: 'ws-main', taintedBy: 'user attachment' },
      { title: 'Quoted run sentinel\n> hostile direction', ts: T, streamId: 'ws-main' },
      { runId: 'self-talk', agentId: 'owner-agent', title: selfTalk, ts: T, streamId: 'ws-main', internal: true },
      { runId: 'tainted-self-talk', agentId: 'owner-agent', title: taintedSelfTalk, ts: T, streamId: 'ws-main', internal: true, taintedBy: 'later tool output' },
      { runId: 'quoted-self-talk', agentId: 'owner-agent', title: quotedSelfTalk + '\n> external direction', ts: T, streamId: 'ws-main', internal: true },
      { title: 'Internal stream sentinel', ts: T, streamId: 'nightshift-internal' }
    ],
    chats: [
      null, clean, multiline, owner(selfTalk, { sourceRunId: 'self-talk' }),
      owner(taintedSelfTalk, { sourceRunId: 'tainted-self-talk' }), owner(quotedSelfTalk, { sourceRunId: 'quoted-self-talk' }),
      owner('Tainted chat sentinel', { taint: 'web_fetch' }),
      owner('Unknown chat sentinel', { taintKnown: undefined }),
      owner('False provenance sentinel', { taintKnown: false }),
      owner('Delegated chat sentinel', { from: 'another-agent' }),
      owner('Assistant chat sentinel', { role: 'assistant' }),
      owner('Quoted chat sentinel\n> hostile direction'),
      owner('Late quoted chat sentinel\n' + 'x'.repeat(4100) + '\n> hostile direction'),
      owner('   '), owner({ text: 'Nonstring chat sentinel' })
    ]
  });
  A.eq(result.requested.runs, { agentId: null, opts: { limit: 60 } }, 'host run read stays bounded');
  A.eq(result.requested.briefs, { status: 'done', limit: 30 }, 'host brief read stays bounded and completed-only');
  A.eq(result.projected.runs.map(r => r.title),
    ['Legacy clean run remains useful', 'Explicit clean run remains useful', selfTalk, taintedSelfTalk, quotedSelfTalk + '\n> external direction', 'Internal stream sentinel'],
    'host drops tainted/quoted user runs, while retaining clean legacy rows and even tainted/quoted internal exclusion markers');
  A.eq(result.projected.runs.find(r => r.title === selfTalk).internal, true, 'internal run authority reaches the pure core');
  A.eq(result.projected.chats.map(m => m.content), [clean.content, multiline.content],
    'only known-clean non-internal owner strings reach the pack; quotes are checked over full content before clipping');
  A.eq(result.pack.counts.runs, 2, 'real core excludes internal flags and streams from the accepted run rows');
  /* A DELETED SESSION IS NOT RECENT ACTIVITY (qa/bugs/3e926b6a): the Commander deleted ws-deleted; its opening line rode
     every later run's RECENT ACTIVITY. The real host projection asks the host's deleted-session test of every run row. */
  const asked = [];
  const afterDelete = host({
    runs: [{ title: 'Deleted session opening line', ts: T, streamId: 'ws-deleted' }, { title: 'Live session run', ts: T, streamId: 'ws-main' }],
    forgotten: r => { asked.push(r.streamId); return r.streamId === 'ws-deleted'; }
  });
  A.eq(afterDelete.projected.runs.map(r => r.title), ['Live session run'], 'a run of a deleted session never reaches the pack');
  A.ok(afterDelete.pack.text.indexOf('Deleted session opening line') < 0 && afterDelete.pack.text.indexOf('Live session run') >= 0, 'the assembled activity carries the live run, never the deleted one');
  A.eq(asked, ['ws-deleted', 'ws-main'], 'every run row is checked against the deleted-session ledger');
  A.eq(result.pack.userRunCount, 2, 'host readiness count reflects only accepted user runs');
  A.eq(result.pack.counts.chats, 2, 'real core excludes internal self-talk while preserving owner asks on the same stream');
  const surfaced = result.pack.text + '\n' + result.pack.activityLines.join('\n');
  A.ok(surfaced.includes(clean.content) && surfaced.includes('Owner next task'),
    'one tainted row does not suppress clean owner activity elsewhere in its stream');
  A.ok(!/sentinel|INTERNAL (?:GOAL DECOMPOSITION|TAINTED STATION|QUOTED STATION)/.test(surfaced), 'rejected and internal content never enters the prompt or evidence pool');

  A.eq(result.projectionCount, 2, 'host separately assembles general activity and trusted learning activity');
  A.ok(result.trustedProjected.runs.length === 3 && result.trustedProjected.runs.every(r => r.internal),
    'trusted assembly retains internal runs only as negative markers for self-talk');
  A.eq(result.trustedProjected.chats.map(m => m.content), result.projected.chats.map(m => m.content),
    'both projections receive the same proven owner chats');
  const trustedText = result.pack.trustedActivityLines.join('\n');
  A.ok(trustedText.includes(clean.content) && trustedText.includes('Owner next task'),
    'clean owner requests remain available to topic learning');
  A.ok(!/Legacy clean run|Explicit clean run|sentinel|INTERNAL (?:GOAL DECOMPOSITION|TAINTED STATION|QUOTED STATION)/.test(trustedText),
    'legacy ordinary run titles, tainted rows and internal self-talk cannot become trusted topic evidence');

  const oldInternalText = 'Old station-only planning outside the recent run window';
  const oldInternal = { runId: 'old-internal', agentId: 'owner-agent', streamId: 'ws-main', internal: true, title: oldInternalText };
  const recentTitles = Array.from({ length: 60 }, (_, i) => ({
    runId: 'recent-' + i, agentId: 'owner-agent', streamId: 'ws-main', title: 'Recent task ' + i, ts: T - i
  }));
  const oldInternalChat = owner(oldInternalText, { sourceRunId: oldInternal.runId });
  const oldInternalBrief = brief(oldInternalText, { originalRunId: oldInternal.runId });
  const windowEdge = host({ runs: recentTitles, originRuns: [...recentTitles, oldInternal],
    chats: [oldInternalChat], briefs: [oldInternalBrief] });
  A.ok(windowEdge.requested.allRuns > 0, 'provenance uses complete run metadata independently of the 60-title window');
  A.eq(windowEdge.projected.chats.length, 0, 'a known-clean internal directive is withheld after its title falls outside the recent window');
  A.eq(windowEdge.projected.briefs.length, 0, 'an internal original run cannot authorize a completed brief');
  A.eq(windowEdge.pack.trustedActivityLines, [], 'old internal self-talk never mints trusted topic activity');

  const originProof = { runId: 'owner-original', agentId: 'owner-agent', streamId: 'ws-main', internal: false, ownerDirective: true };
  for (const [label, origins] of [
    ['missing source run metadata', []],
    ['internal source run metadata', [{ ...originProof, internal: true }]],
    ['unknown internal status on source run', [{ ...originProof, internal: undefined }]],
    ['delegated parent source run', [{ ...originProof, parentRunId: 'lead-run' }]],
    ['delegated worker source run', [{ ...originProof, delegatedBy: 'lead-agent' }]],
    ['scheduled source run', [{ ...originProof, cronJobId: 'schedule-job' }]],
    ['recovery source run', [{ ...originProof, recoveryOf: 'interrupted-run' }]],
    ['another agent owns the source run', [{ ...originProof, agentId: 'other-agent' }]],
    ['another stream owns the source run', [{ ...originProof, streamId: 'other-stream' }]],
    // (2026-10-12) a channel group guest's run looks like the owner's by surface/stream; only the host stamp tells them apart
    ['a channel group guest (no owner-directive stamp) gave the source run', [{ ...originProof, ownerDirective: undefined, surface: 'interactive' }]]
  ]) {
    const rejected = host({ chats: [clean], briefs: [brief(clean.content)], originRuns: origins });
    A.eq(rejected.projected.chats.length, 0, label + ': no owner chat');
    A.eq(rejected.projected.briefs.length, 0, label + ': no owned brief');
    A.eq(rejected.pack.trustedActivityLines, [], label + ': no trusted topic evidence');
  }
  const oldOwnerOrigin = { ...oldInternal, internal: false, ownerDirective: true };
  const oldOwnerStillProven = host({ runs: recentTitles, originRuns: [...recentTitles, oldOwnerOrigin],
    chats: [oldInternalChat], briefs: [oldInternalBrief] });
  A.eq(oldOwnerStillProven.projected.chats.length, 1, 'a genuine owner source outside the title window remains eligible');
  A.eq(oldOwnerStillProven.projected.briefs.length, 1, 'full-history owner proof still authorizes its exact original brief');

  const richBriefText = 'Owner requests release notes\nVerify the release number';
  const trustedBrief = host({ chats: [owner(richBriefText)], briefs: [brief(richBriefText)] });
  A.eq(trustedBrief.trustedProjected.briefs.length, 1, 'the trusted assembly retains an occurrence-proven owner brief');
  A.ok(trustedBrief.pack.trustedActivityLines.some(line => line.includes('Verify the release number')),
    'trusted brief evidence retains verified original directive detail beyond the chat opening');
  A.eq(host({ runs: [{ title: 'Legacy ordinary task title', ts: T }] }).pack.trustedActivityLines, [],
    'legacy run titles alone never supply trusted topic-learning activity');

  for (const enabled of [true, false]) {
    const alwaysFiltered = host({
      enabled,
      runs: [{ title: 'TAINTED MODE RUN', ts: T, taintedBy: 'web_fetch' }],
      chats: [clean, owner('TAINTED MODE CHAT', { taint: 'web_fetch' })],
      briefs: [brief('TAINTED MODE CHAT')]
    });
    A.eq(alwaysFiltered.projected.runs.length, 0, 'tainted runs remain excluded with personalization enabled=' + enabled);
    A.eq(alwaysFiltered.projected.chats.map(m => m.content), [clean.content], 'owner provenance filtering remains active with personalization enabled=' + enabled);
    A.eq(alwaysFiltered.projected.briefs.length, 0, 'unsupported briefs remain excluded with personalization enabled=' + enabled);

    // The general Commander evidence reader must consume this filtered host pack in either preference mode.
    // No raw run/transcript stores are provided here: a private bypass cannot satisfy the activity assertion.
    const evidenceFn = A.fnBody(src, 'function commanderEvidenceInputs(evidence)');
    A.ok(evidenceFn.length < 4000 && /return \{ dossier:/.test(evidenceFn), 'extract the shared Commander evidence reader');
    let packReads = 0;
    const evidence = vm.runInNewContext('(' + evidenceFn + ')()', {
      Date: { now: () => T },
      personalizationStore: { read: () => ({ enabled }) },
      nightshiftContextPack: () => { packReads++; return result.pack; },
      threadsStore: { openThreads: () => [] },
      Interests: { summary: () => [] }, interestsState: {},
      scoutState: { context: {} }, commanderGoals: { get: () => null },
      recommendationLedger: { summary: () => null },
      stationTrackRecordLines: () => [], commanderDossier: { get: () => ({}) }
    });
    A.eq(packReads, 1, 'general evidence reads the shared filtered host pack with personalization enabled=' + enabled);
    A.eq(evidence.activity, result.pack.activityLines.slice(0, 8), 'general evidence preserves filtered activity with personalization enabled=' + enabled);
  }

  const ordered = host({ chats: Array.from({ length: 9 }, (_, i) => owner('Ordered owner request ' + i, { ts: T - (8 - i) })) });
  const orderedLines = ordered.pack.sections.find(section => section.label === 'What they asked recently').lines;
  A.eq(orderedLines.length, CP.MAX_CHATS, 'host-proven owner asks still respect the pure core item cap');
  A.eq(orderedLines.map(line => Number(line.match(/request (\d+)/)[1])), [8, 7, 6, 5, 4, 3],
    'eligible asks are ordered newest-first before the section cap');

  const poisonCrowd = host({
    chats: [owner('Older clean owner ask survives', { ts: ago(1) }),
      ...Array.from({ length: CP.MAX_CHATS + 3 }, (_, i) => owner('Newer tainted ask ' + i, { ts: T - i, taint: 'attachment' }))],
    runs: [
      { title: 'Duplicate task title', ts: T, streamId: 'ws-main', taintedBy: 'attachment' },
      { title: 'Duplicate task title', ts: ago(1), streamId: 'ws-main' }
    ]
  });
  A.eq(poisonCrowd.pack.sections.find(section => section.label === 'What they asked recently').lines,
    ['"Older clean owner ask survives" (yesterday)'], 'newest tainted asks beyond the item cap cannot evict an older clean owner ask');
  A.eq(poisonCrowd.pack.sections.find(section => section.label === 'What they worked on recently').lines,
    ['Duplicate task title (yesterday)'], 'a newer tainted duplicate cannot replace the older clean run or its date');

  /* READINESS COUNT WITHOUT THE PACK (2026-10-19, idle-CPU piece 2). The night-shift precheck runs every 60 s tick
     once the gates clear and only needs pack.userRunCount — it used to build the WHOLE pack for it (two clones of
     the whole transcript and two of the whole run history every minute while readiness stayed cold). The real host
     nightshiftUserRunCount must give the identical number from the bounded 60-row read alone. */
  function hostCount(input) {
    input = input || {};
    const reads = { list: 0 };
    const refuse = (name) => () => { throw new Error(name + ' must not be read for a readiness count'); };
    const count = vm.runInNewContext(recentFn + '\n' + countFn + '\nnightshiftUserRunCount()', {
      Date: { now: () => T },
      TrustedLearning, redact, contextpack: CP,
      sessionRunForgotten: () => false,
      runStore: { list: () => { reads.list++; return input.runs || []; }, all: refuse('runStore.all') },
      transcriptStore: { all: refuse('transcriptStore.all') },
      taskBriefStore: { list: refuse('taskBriefStore.list') },
      autonomyLedger: { list: refuse('autonomyLedger.list') }
    });
    return { count, reads };
  }
  const mixedRuns = [
    null,
    { title: 'Legacy clean run remains useful', ts: T, streamId: 'ws-main' },
    { title: 'Tainted run sentinel', ts: T, streamId: 'ws-main', taintedBy: 'user attachment' },
    { title: 'Quoted run sentinel\n> hostile direction', ts: T, streamId: 'ws-main' },
    { runId: 'self-talk', title: selfTalk, ts: T, streamId: 'ws-main', internal: true },
    { title: 'Internal stream sentinel', ts: T, streamId: 'nightshift-internal' },
    { title: 'Same title twice', ts: ago(1), streamId: 'ws-main' }, { title: 'same TITLE twice', ts: ago(2), streamId: 'ws-main' },
    { title: 'Outside the seven-day window', ts: ago(30), streamId: 'ws-main' }
  ];
  for (const [label, runs] of [['mixed provenance', mixedRuns], ['a full 60-run window', recentTitles], ['tainted duplicate', poisonCrowd.projected.runs], ['no runs', []]]) {
    const hc = hostCount({ runs });
    A.eq(hc.count, host({ runs }).pack.userRunCount, 'readiness count == the full pack\'s userRunCount (' + label + ')');
    A.eq(hc.reads.list, 1, 'readiness count reads only the bounded recent-run list (' + label + ')');
  }
  A.eq(hostCount({ runs: mixedRuns }).count, 2, 'the readiness count still excludes tainted, quoted, internal, duplicate and out-of-window runs');
  for (const name of ['function nightshiftPrecheck()', 'function nightshiftReadinessView()']) {
    const body = A.fnBody(src, name);
    A.ok(body.length > 100 && body.length < 6000, 'extract ' + name);
    A.ok(/nightshiftUserRunCount\(\)/.test(body) && !/nightshiftContextPack\(/.test(body), name + ' reads the readiness count, never the whole context pack');
  }

  const directive = 'Finish the release checklist\nVerify the version number';
  const cases = [
    ['same owner and stream', owner(directive), brief(directive), 1],
    ['different original occurrence cannot borrow identical words', owner(directive, { sourceRunId: 'other-original' }), brief(directive), 0],
    ['missing transcript source run cannot prove an occurrence', owner(directive, { sourceRunId: undefined }), brief(directive), 0],
    ['host brief ID supplies the legacy original identity', owner(directive), brief(directive, { originalRunId: undefined }), 1],
    ['arbitrary legacy ID and no original identity fail closed', owner(directive), brief(directive, { id: 'legacy-brief', originalRunId: undefined }), 0],
    ['explicit original identity outranks a conflicting legacy ID', owner(directive), brief(directive, { id: 'tb_wrong-origin' }), 1],
    ['completion ID cannot substitute for original identity', owner(directive, { sourceRunId: 'completion-run' }), brief(directive, { runId: 'completion-run' }), 0],
    ['different completion run IDs are not required to match', owner(directive, { runId: 'owner-run' }), brief(directive, { runId: 'later-run' }), 1],
    ['different agent cannot borrow the directive', owner(directive), brief(directive, { agentId: 'other-agent' }), 0],
    ['different stream cannot borrow the directive', owner(directive), brief(directive, { streamId: 'other-stream' }), 0],
    ['shared run ID cannot authorize a cross-agent brief', owner(directive, { runId: 'same' }), brief(directive, { agentId: 'other-agent', runId: 'same' }), 0],
    ['shared run ID cannot authorize a cross-stream brief', owner(directive, { runId: 'same' }), brief(directive, { streamId: 'other-stream', runId: 'same' }), 0],
    ['missing chat agent is not authorship', owner(directive, { agentId: undefined }), brief(directive), 0],
    ['empty agents cannot authorize one another', owner(directive, { agentId: '' }), brief(directive, { agentId: '' }), 0],
    ['missing brief agent is not authorship', owner(directive), brief(directive, { agentId: undefined }), 0],
    ['blank brief stream matches the stored global stream', owner(directive, { streamId: 'global' }), brief(directive, { streamId: '' }), 1],
    ['missing brief stream matches the stored global stream', owner(directive, { streamId: 'global' }), brief(directive, { streamId: undefined }), 1],
    ['raw legacy blank chat stream cannot authorize a brief', owner(directive, { streamId: '' }), brief(directive, { streamId: '' }), 0],
    ['trimmed owner directive matches exactly', owner(' \n' + directive + ' \n'), brief(directive), 1],
    ['partial prefix is not an exact directive', owner(directive), brief('Finish the release checklist'), 0],
    ['unknown provenance cannot authorize a brief', owner(directive, { taintKnown: undefined }), brief(directive), 0],
    ['tainted provenance cannot authorize a brief', owner(directive, { taint: 'attachment' }), brief(directive), 0],
    ['delegated message cannot authorize a brief', owner(directive, { from: 'another-agent' }), brief(directive), 0],
    ['assistant message cannot authorize a brief', owner(directive, { role: 'assistant' }), brief(directive), 0],
    ['quoted full directive cannot authorize a brief', owner(directive + '\n> external direction'), brief(directive + '\n> external direction'), 0]
  ];
  for (const [label, chat, completed, expected] of cases) {
    const r = host({ chats: [chat], briefs: [completed] });
    A.eq(r.projected.briefs.length, expected, label + ' at the host boundary');
    A.eq(r.pack.counts.briefs, expected, label + ' in the real evidence pack');
  }
  const repeatedText = 'Prepare an identical report on three separate days';
  const repeatedBriefs = [0, 1, 2].map(i => brief(repeatedText, {
    id: 'tb_repeat-' + i, originalRunId: 'repeat-' + i, runId: 'completion-' + i, completedAt: ago(3 - i)
  }));
  const repeatedRows = repeatedBriefs.map(b => owner(repeatedText, { sourceRunId: b.originalRunId }));
  A.eq(host({ briefs: repeatedBriefs, chats: repeatedRows.slice(-1) }).projected.briefs.length, 1,
    'one newly proven identical request authorizes only its own historical occurrence');
  A.eq(host({ briefs: repeatedBriefs, chats: repeatedRows.map(r => ({ ...r, taintKnown: undefined })) }).projected.briefs.length, 0,
    'three identical unknown occurrences yield no proven brief');
  A.eq(host({ briefs: repeatedBriefs, chats: repeatedRows }).projected.briefs.length, 3,
    'independent clean original rows prove all three identical occurrences');
  A.eq(host({ briefs: [repeatedBriefs[0], { ...repeatedBriefs[0], id: 'duplicate-brief', runId: 'another-completion' }], chats: repeatedRows }).projected.briefs.length, 1,
    'duplicate briefs with different finishing IDs count one original occurrence');
  A.eq(host({ briefs: repeatedBriefs.map(b => ({ ...b, runId: 'repeat-2' })), chats: repeatedRows.slice(-1) }).projected.briefs.length, 1,
    'rewritten completion IDs cannot launder earlier identical occurrences');

  const longDirective = 'Long direct owner request ' + 'x'.repeat(4500);
  const clipped = longDirective.trim().slice(0, 4000);
  A.eq(host({ chats: [owner(' \n' + longDirective)], briefs: [brief(clipped)] }).projected.briefs.length, 1,
    'brief comparison uses the stored trim-then-4000-character directive');
  A.eq(host({ chats: [owner(longDirective + '\n> external late direction')], briefs: [brief(clipped)] }).projected.briefs.length, 0,
    'a quote after character 4000 invalidates the whole source before a matching brief prefix can launder it');

  const oldOwner = owner('Older owner directive outside the bounded source window', { sourceRunId: 'old-original' });
  const newestOwner = owner('Newest owner directive inside the bounded source window');
  const history = [oldOwner, ...Array.from({ length: 400 }, (_, i) => owner('Unknown padding ' + i, { taintKnown: undefined })), newestOwner];
  const bounded = host({ chats: history, briefs: [brief(oldOwner.content, { id: 'tb_old-original', originalRunId: 'old-original' }), brief(newestOwner.content)] });
  A.eq(bounded.projected.chats.map(m => m.content), [newestOwner.content], 'take the last 400 source rows before filtering, without searching unbounded clean history');
  // (2026-10-12) A completed brief exists to carry work older than the chat tail: its proof is its own original row,
  // looked up by run id, so 400 newer rows no longer evict a still-held clean original (this used to pin the eviction).
  A.eq(bounded.projected.briefs.map(b => b.originalDirective), [oldOwner.content, newestOwner.content], 'a brief older than the chat tail keeps its clean original-row proof');
  const oldUnknown = host({ chats: [{ ...oldOwner, taintKnown: undefined }, ...history.slice(1)], briefs: [brief(oldOwner.content, { id: 'tb_old-original', originalRunId: 'old-original' }), brief(newestOwner.content)] });
  A.eq(oldUnknown.projected.briefs.map(b => b.originalDirective), [newestOwner.content], 'an old original without a clean stamp still proves nothing');
}

setTimeout(() => A.report('contextpack.test'), 30);
