/* node test/interests.provenance.test.js - A LEARNED INTEREST NAMES THE ROW IT WAS LEARNED FROM (turn identity commit 12, qa/bugs/31042fab).

   31042fab: after the Commander deleted a session, "what they keep asking about" still carried a topic and a verbatim quote from it into the
   scout's prompts, because the interests histogram kept {q, at} and nothing said where q came from. Now a TRUSTED quote carries
   src = { streamId, runId, rowId }, read off the context pack's parallel activity[].src (the pack's activityLines strings are unchanged), and
   the registry purges, refuses and proves by it. On the real contextpack, transcript store and interests (all present on trunk), through the
   host's own nightshiftContextPack:

     (a) every persisted trusted quote carries src, and its rowId is an owner-evidence row;
     (b) after the source stream is deleted (the ledger's tombstone, then the registry's forget) a RESTARTED state holds no topic from it,
         and a state whose source rows are missing from disk hides its topics through the host's live proof;
     (c) a topic with no live source row is never rendered as a TOPIC line;
     (d) control: the legacy-only fixture (the persisted shape before trusted topics) stays absent from the trusted summary;
     (e) the write-time gate: a fold whose quote came from a session deleted while the pass ran adds nothing;
     (f) the one-time proof: sourceless trusted quotes take the owner row that contains them, and a quote no owner row contains is
         QUARANTINED - kept, read by nobody, restorable. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { sidecarFunctionSource } = require('./helpers/source.js');
const Store = require('../sidecar/transcriptstore.js');
const History = require('../sidecar/transcript-history.js');
const Learning = require('../sidecar/trusted-learning.js');
const contextpack = require('../sidecar/contextpack.js');
const Interests = require('../sidecar/interests.js');
const SessionTombstones = require('../sidecar/session-tombstones.js');
const ForgetRegistry = require('../sidecar/forget-registry.js');
const { wireForgetRegistry } = require('../sidecar/forget-wiring.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-interests-prov-'));
  try {
    const T = 100000;
    let ledgerClock = 200000;
    const ledger = SessionTombstones.makeSessionTombstones({ fs, path, file: path.join(dir, 'session-tombstones.json'), now: () => ledgerClock });
    ledger.observe([], []);   // the first read (adopted, empty): every delete after this is a real one
    const runRows = [];
    const io = History.makeMemoryTranscriptIo();
    const store = Store.makeTranscriptStore({ io, clock: { now: () => T }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt(),
      runOf: id => runRows.find(row => row.runId === id), quotedMaterial: Learning.quotedMaterial });
    const append = (runId, streamId, content, internal) => {
      runRows.push({ runId, streamId, agentId: 'agent', ownerDirective: !internal, internal, title: content, ts: T });
      return store.appendStrict({ sourceRunId: runId, streamId, agentId: 'agent', role: 'user', content, ts: T, taint: null, directive: true, kind: internal ? 'station' : 'turn' });
    };
    const rowQuokka = append('run_a', 'sA', 'Please compare the quokka habitat surveys', false);
    const rowPlatypus = append('run_b', 'sB', 'Draft the platypus launch plan for Friday', false);
    append('run_i', 'sB', 'INTERNAL goal decomposition for the station', true);

    // ---- the host's own pack assembly (index.js nightshiftContextPack), over this store ----
    const sandbox = { Map, Set, Date: { now: () => T }, TrustedLearning: Learning, transcriptStore: store, runView: (name, r) => r, runStore: { all: () => runRows },
      taskBriefStore: { list: () => [] }, contextpack, nightshiftRecentRuns: () => runRows.slice(),
      commanderGoals: { get: () => null }, autonomyLedger: { list: () => [] }, nightshiftBeliefMap: () => ({}),
      Recommendation: { preferenceTallies: () => ({}) }, nightshiftPreferenceWeights: () => ({}), stationTrackRecordLines: () => [],
      redact: text => text, threadsStore: { openThreads: () => [] }, personalizationStore: { read: () => ({ enabled: true }) },
      commanderDossier: { get: () => '' }, failNote(tag, error) { throw new Error(tag + ': ' + error.message); } };
    vm.createContext(sandbox);
    for (const name of ['evidenceRows', 'nightshiftContextPack']) vm.runInContext(sidecarFunctionSource(name), sandbox);
    const pack = sandbox.nightshiftContextPack({});
    const ownerIds = new Set(store.view('owner-evidence', null, {}).map(row => row.rowId));
    A.ok(pack.activity.length === 2 && pack.activity.every(a => a.src && ownerIds.has(a.src.rowId)), 'the pack names the owner row of each activity line: ' + JSON.stringify(pack.activity.map(a => a.src)));

    // ---- the registry over a real ledger and this store, with the interests wired as index.js wires them ----
    let state = Interests.fresh(T);
    const persisted = [];
    const registry = ForgetRegistry.make({ deletedAt: id => ledger.deletedAt(id), freshDeletedAt: id => ledger.freshAt(id), latestDeleteAt: () => ledger.latestAt(),
      rowVerdict: (streamId, rowId) => { const v = store.forgetVerdicts(streamId, [rowId]); return v.has(rowId) ? v.get(rowId) : null; },
      runForgotten: () => false, note: (tag, e) => { throw new Error(tag + ': ' + (e && e.message)); } });
    wireForgetRegistry(registry, { now: () => ledgerClock, notebookStore: () => null, threadsStore: () => null, memoryAgentIds: () => [], personalization: () => ({ markForgotten: async () => {} }),
      interests: { get: () => state, set: s => { state = s; }, persist: () => persisted.push(JSON.stringify(state)) } });
    registry.seal();
    const admit = src => registry.admit({ streamId: src.streamId, rowId: src.rowId });

    const reply = 'TOPIC: quokka habitat | EVIDENCE: compare the quokka habitat surveys\nTOPIC: platypus launch | EVIDENCE: Draft the platypus launch plan';
    const cands = Interests.parse(reply, { activityLines: pack.trustedActivityLines, requireExactEvidence: true });
    A.eq(cands.map(c => c.slug), ['quokka-habitat', 'platypus-launch'], 'the extraction reply parses against the proven lines');
    state = Interests.fold(state, cands, { now: T, trustedActivity: true, activityLines: pack.trustedActivityLines, activity: pack.activity, admit });

    // ---- (a) every persisted trusted quote carries its source ----
    const onDisk = JSON.parse(JSON.stringify(state));
    const trustedEv = Object.values(onDisk.trustedTopics).flatMap(t => t.ev);
    A.eq(trustedEv.length, 2, 'both trusted topics keep their quote');
    A.ok(trustedEv.every(e => e.src && ownerIds.has(e.src.rowId) && typeof e.src.streamId === 'string' && typeof e.src.runId === 'string'), '(a) every persisted trusted quote has src { streamId, runId, rowId } and the rowId is an owner-evidence row: ' + JSON.stringify(trustedEv));
    const quokka = onDisk.trustedTopics['quokka-habitat'].ev[0];
    A.eq([quokka.src.streamId, quokka.src.runId, quokka.src.rowId], ['sA', 'run_a', rowQuokka.rowId], 'the quote is sourced from the row it was quoted from, not just any row');
    A.ok(Object.values(onDisk.topics).flatMap(t => t.ev).every(e => e.src === undefined), 'the legacy histogram carries no source (it is never read as grounding)');
    const clean = Interests.normalize(onDisk, T);
    A.eq(Interests.summary(clean, { now: T, trustedOnly: true }).map(r => r.topic).sort(), ['platypus-launch', 'quokka-habitat'], 'before any delete both topics are read');

    // a quote read back whole: what a source with a bad shape does to a quote
    A.eq(Interests.cleanSrc({ streamId: 'bad id', runId: 'r', rowId: 1 }), null, 'a source with a bad stream id is no source');
    A.eq(Interests.cleanSrc({ streamId: 's', runId: 'r', rowId: 0 }), null, '...nor one with no row');

    // ---- (c) a topic with no live source row is never rendered (the host's live proof) ----
    const aliveRows = new Set([rowQuokka.rowId, rowPlatypus.rowId]);
    const live = src => !!src && aliveRows.has(src.rowId);
    aliveRows.delete(rowQuokka.rowId);
    A.eq(Interests.summary(clean, { now: T, trustedOnly: true, live }).map(r => r.topic), ['platypus-launch'], '(b/c) a topic whose only source row is missing from disk is not summarised');
    A.ok(!/quokka/i.test(Interests.topicsBlock(clean, { now: T, trustedOnly: true, live })) && /platypus/.test(Interests.topicsBlock(clean, { now: T, trustedOnly: true, live })), '(c) ...nor rendered as a TOPIC line, while the live one still is');
    A.ok(Interests.warm(clean, T, { trustedOnly: true, live }), 'warmth counts the live topic');
    aliveRows.delete(rowPlatypus.rowId);
    A.ok(!Interests.warm(clean, T, { trustedOnly: true, live }) && Interests.topicsBlock(clean, { now: T, trustedOnly: true, live }) === '', 'with no source row alive nothing is warm and nothing is rendered');
    const nullLive = Interests.summary(clean, { now: T, trustedOnly: true, live: () => { throw new Error('ledger'); } });
    A.eq(nullLive, [], 'a live proof that throws is no proof (fail closed)');

    // ---- (b) the source stream is deleted: the ledger, then the registry's forget; a RESTARTED state ----
    ledgerClock = 300000;
    A.eq(ledger.observe(['sA']), ['sA'], 'the Commander deletes the session');
    const scope = SessionTombstones.deletedScope(ledger.unpurged(), runRows);
    // this test wires only the interests state: it runs that entry (the full pass over every store is forget-stores and the e2e)
    const removedQuotes = await registry.entry('interests').forget(scope);
    A.eq(removedQuotes, 1, 'the interests entry removed the one quote the deleted session wrote');
    A.ok(persisted.length === 2 && persisted[0] === persisted[1], 'and persisted the purged state twice (the store keeps the value it replaced as its .bak, so the second write makes the purged copy the .bak too)');
    const restarted = Interests.normalize(JSON.parse(persisted[persisted.length - 1]), T);
    A.eq(Interests.summary(restarted, { now: T, trustedOnly: true }).map(r => r.topic), ['platypus-launch'], '(b) the restarted state holds no topic from the deleted session');
    A.ok(!/quokka/i.test(JSON.stringify(restarted.trustedTopics)) && !/quokka/i.test(Interests.topicsBlock(restarted, { now: T, trustedOnly: true })), '...and its quote and label are in no trusted block');
    A.eq(await registry.entry('interests').forget(scope), 0, 'the purge is idempotent');
    A.ok(/platypus/.test(JSON.stringify(restarted.trustedTopics)), 'the other session\'s topic is untouched');

    // ---- (e) the write-time gate: a pass that started before the delete folds nothing from it ----
    state = Interests.fresh(T);
    const late = Interests.fold(state, cands, { now: T + 10, trustedActivity: true, activityLines: pack.trustedActivityLines, activity: pack.activity, admit });
    A.eq(Object.keys(late.trustedTopics), ['platypus-launch'], '(e) a quote whose session was deleted while the pass ran is refused by the registry; the other topic is folded');
    A.eq(Object.keys(late.topics).sort(), ['platypus-launch', 'quokka-habitat'], '...the legacy histogram is not the trusted one and keeps its own');

    // ---- (d) control: the legacy-only persisted shape stays absent from the trusted summary ----
    const legacyOnly = Interests.normalize({ topics: { 'stock-research': { label: 'stock research', w: 3, n: 3, lastAt: T, ev: [{ q: 'NVDA earnings', at: T }] } } }, T);
    A.eq(Interests.summary(legacyOnly, { now: T, trustedOnly: true }), [], '(d) a legacy-only state is never read as a trusted interest');
    A.eq(Interests.topicsBlock(legacyOnly, { now: T, trustedOnly: true }), '', '...nor rendered');

    // ---- (f) the one-time proof of sourceless trusted quotes ----
    const sourceless = Interests.normalize({ topics: {}, trustedTopics: {
      'platypus-launch': { label: 'platypus launch', w: 1, n: 1, lastAt: T, ev: [{ q: 'draft the platypus launch plan', at: T }] },
      'orphan-topic': { label: 'orphan topic', w: 1, n: 1, lastAt: T, ev: [{ q: 'a quote no owner row contains', at: T }] } } }, T);
    A.eq(Interests.summary(sourceless, { now: T, trustedOnly: true }).length, 2, 'before the proof both sourceless topics are read as before (the pure reader changes nothing by itself)');
    const flat = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
    const owners = store.view('owner-evidence', null, {}).map(r => ({ text: flat(r.content), src: { streamId: r.streamId, runId: r.sourceRunId, rowId: r.rowId } }));
    const proved = Interests.reprove(sourceless, q => { const hit = owners.find(r => r.text.includes(flat(q))); return hit ? hit.src : null; }, { now: T });
    A.eq(proved.trustedTopics['platypus-launch'].ev[0].src.rowId, rowPlatypus.rowId, '(f) a sourceless quote takes the owner row that contains it');
    A.ok(!proved.trustedTopics['orphan-topic'] && proved.quarantined['orphan-topic'].ev[0].q === 'a quote no owner row contains', '...one that no owner row contains is quarantined with its text kept');
    A.eq(Interests.summary(proved, { now: T, trustedOnly: true }).map(r => r.topic), ['platypus-launch'], '...and read by nobody');
    A.ok(proved.reprovedAt > 0, 'the pass is stamped, so it runs once');
    const roundTrip = Interests.normalize(JSON.parse(JSON.stringify(proved)), T);
    A.ok(roundTrip.quarantined && roundTrip.quarantined['orphan-topic'], 'the quarantine survives a restart (it is on disk)');
    const back = Interests.unquarantine(roundTrip, 'orphan-topic');
    A.ok(back.trustedTopics['orphan-topic'] && !back.quarantined, 'unquarantine puts the topic back: nothing was deleted');
    const purgedQuarantine = Interests.purge(Interests.normalize({ topics: {}, trustedTopics: {}, quarantined: { 'held-topic': { label: 'held topic', w: 1, n: 1, lastAt: T, ev: [{ q: 'q', at: T, src: { streamId: 'sA', runId: 'run_a', rowId: 7 } }] } } }, T), src => src.streamId === 'sA');
    A.ok(purgedQuarantine.removed === 1 && !purgedQuarantine.state.quarantined, 'a quarantined quote that does name a deleted session is purged with it');
    A.ok(Interests.reprove(Interests.fresh(T), () => null, { now: T }).reprovedAt > 0, 'a state with no trusted evidence is stamped too');

    A.report('interests.provenance');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
