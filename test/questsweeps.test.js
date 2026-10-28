/* node test/questsweeps.test.js — the PURE seam-matchers for the QUEST V2 mechanical contract sweeps
   (sidecar/questsweeps.js). Before this lane, only the run-end sweep had a caller and even it could never
   match (a run-contract key is fixed at mint, before any runId exists, and bindRun had ZERO callers) — so
   ONLY attest quests could ever complete. These tests drive each matcher against a REAL questStore (in-memory
   fs, injected clock) end-to-end through completeByContract, proving: each contract type minted → its real
   seam fires → the quest completes; a NON-matching key never completes; and scoping (own vs station-wide vs
   another agent's) holds at every seam. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const path = require('path');
const { makeQuestStore } = require('../sidecar/quest-store.js');
const { livePropKeys, learnedFactKeys, artifactQuestKeys, _internals } = require('../sidecar/questsweeps.js');

function memFs() {
  const files = new Map();
  return {
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); },
    renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); },
    mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
}
const writeDurable = ({ fs }, file, data) => { fs.writeFileSync(file, data); };
const fresh = () => makeQuestStore({ fs: memFs(), path, workspaces: '/ws', writeDurable });

(async () => {

  // ---- 1. RUN: admission never guesses which quest an unrelated run is doing ----
  {
    const idx = readSidecarSource();
    const sweeps = require('fs').readFileSync(path.join(__dirname, '..', 'sidecar', 'questsweeps.js'), 'utf8');
    A.ok(!/runBindIds\s*\(/.test(idx), 'run admission does not auto-bind every open run quest to an unrelated task');
    A.ok(!/function runBindIds\s*\(/.test(sweeps), 'the misleading bulk run selector no longer exists');
  }

  // ---- 2. PROP: resolved capability set (objectType / capId / tool / compute) proves a prop key live ----
  {
    const s = fresh();
    const byObj = await s.mint({ title: 'place a dish', contract: { type: 'prop', key: 'dish' }, agentId: 'hero' }, 1);
    const byCap = await s.mint({ title: 'web goes live', contract: { type: 'prop', key: 'Web' } }, 2);                 // station-wide, case-insensitive
    const byTool = await s.mint({ title: 'shell goes live', contract: { type: 'prop', key: 'shell.exec' } }, 3);
    const unmet = await s.mint({ title: 'workbench someday', contract: { type: 'prop', key: 'workbench' }, agentId: 'hero' }, 4);
    const theirs = await s.mint({ title: 'their dish', contract: { type: 'prop', key: 'dish' }, agentId: 'other' }, 5);

    const station = { agents: { hero: { id: 'hero', room: 'office' } }, rooms: { office: { id: 'office', objects: [{ instanceId: 'i1', objectType: 'computer' }, { instanceId: 'i2', objectType: 'dish' }] } } };
    const resolved = { hasCompute: true, grants: [{ capId: 'web', tool: 'web_search' }], tools: ['web_search', 'shell.exec'] };

    const keys = livePropKeys(s.openForAgent('hero'), 'hero', station, resolved);
    A.eq(keys.slice().sort(), ['Web', 'dish', 'shell.exec'].sort(), 'objectType, capId (case-insensitive) and tool-name prop keys all match; an unplaced capability does not');
    for (const k of keys) await s.completeByContract('prop', k, 200);
    A.eq(s.get(byObj.id).status, 'done', 'a prop quest keyed to a placed objectType completes');
    A.eq(s.get(byCap.id).status, 'done', 'a station-wide prop quest keyed to a live capId completes (original key preserved through normalization)');
    A.eq(s.get(byTool.id).status, 'done', 'a prop quest keyed to a live tool name completes');
    A.eq(s.get(unmet.id).status, 'open', 'a prop quest for a capability that is NOT live stays open');
    // NB: 'theirs' shares the live key 'dish' — completeByContract is a station-wide exact-key sweep by design
    // (the capability going live on the station satisfies every quest waiting on it), so it completes too.
    A.eq(s.get(theirs.id).status, 'done', 'the same proven key completes every quest waiting on it (station-level truth)');

    // junk inputs prove nothing
    A.eq(livePropKeys(s.openForAgent('hero'), 'hero', null, null), [], 'no station/resolved proves nothing');
  }

  // ---- 3. FACT: a committed memory record proves a fact key (id / exact / verbatim-substring, bounded) ----
  {
    const s = fresh();
    const exact = await s.mint({ title: 'tz', contract: { type: 'fact', key: 'Commander works in CET' }, agentId: 'hero' }, 1);
    const sub = await s.mint({ title: 'csv', contract: { type: 'fact', key: 'csv exports' } }, 2);                    // station-wide
    const byId = await s.mint({ title: 'by id', contract: { type: 'fact', key: 'm7' }, agentId: 'hero' }, 3);
    const miss = await s.mint({ title: 'never', contract: { type: 'fact', key: 'loves yaml' }, agentId: 'hero' }, 4);
    const tiny = await s.mint({ title: 'tiny', contract: { type: 'fact', key: 'a b' }, agentId: 'hero' }, 5);          // < MIN_FACT_KEY after norm — substring can never fire

    const rec = { id: 'm7', content: 'Commander works in CET and handles CSV   exports every Friday.' };
    const keys = learnedFactKeys(s.openForAgent('hero'), 'hero', rec);
    A.eq(keys.slice().sort(), ['Commander works in CET', 'csv exports', 'm7'].sort(), 'exact-content, normalized-substring and record-id fact keys match; unrelated + too-short keys do not');
    for (const k of keys) await s.completeByContract('fact', k, 300);
    A.eq(s.get(exact.id).status, 'done', 'a fact quest completes when the committed memory states it');
    A.eq(s.get(sub.id).status, 'done', 'a station-wide fact key appearing verbatim (normalized) in the record completes');
    A.eq(s.get(byId.id).status, 'done', 'a fact quest keyed to the committed record id completes');
    A.eq(s.get(miss.id).status, 'open', 'a fact the record does not cover stays open');
    A.eq(s.get(tiny.id).status, 'open', 'a below-minimum key never substring-matches (anti trivial-match)');
    A.ok(_internals.MIN_FACT_KEY >= 4, 'the substring floor is a real bound');
  }

  // ---- 4. ARTIFACT: candidate selection is scoped + keyed; the caller's exists-check decides completion ----
  {
    const s = fresh();
    const mine = await s.mint({ title: 'report file', contract: { type: 'artifact', key: 'workshop/r1/index.html' }, agentId: 'hero' }, 1);
    const shared = await s.mint({ title: 'shared file', contract: { type: 'artifact', key: 'notes.md' } }, 2);
    const theirs = await s.mint({ title: 'their file', contract: { type: 'artifact', key: 'secret.txt' }, agentId: 'other' }, 3);

    const cands = artifactQuestKeys(s.openForAgent('hero'), 'hero');
    A.eq(cands.map(c => c.key).sort(), ['notes.md', 'workshop/r1/index.html'].sort(), 'artifact candidates = the agent\'s own + station-wide open artifact quests (never another agent\'s)');

    // simulate the composition root: only the key whose file EXISTS in the jail completes (truthful telemetry)
    const existsOnDisk = k => k === 'workshop/r1/index.html';
    for (const c of cands) if (existsOnDisk(c.key)) await s.completeByContract('artifact', c.key, 400);
    A.eq(s.get(mine.id).status, 'done', 'an artifact quest completes when its file provably exists');
    A.eq(s.get(shared.id).status, 'open', 'an artifact whose file does not exist stays open');
    A.eq(s.get(theirs.id).status, 'open', 'another agent\'s artifact quest is not in this agent\'s sweep');
  }

  // ---- 5. defensiveness: junk quest lists never throw, attest/dismissed/done are never selected ----
  {
    const junk = [null, 'x', { id: 'q:1' }, { id: 'q:2', status: 'done', contract: { type: 'run', key: 'r' }, agentId: 'hero' },
      { id: 'q:3', status: 'open', contract: { type: 'attest', key: '' }, agentId: 'hero' }];
    A.eq(livePropKeys(junk, 'hero', {}, {}), [], 'livePropKeys: junk never matches');
    A.eq(learnedFactKeys(junk, 'hero', { id: 'm1', content: 'anything at all' }), [], 'learnedFactKeys: junk never matches');
    A.eq(artifactQuestKeys(junk, 'hero'), [], 'artifactQuestKeys: junk never selected');
  }

  A.report('questsweeps.test');
})();
