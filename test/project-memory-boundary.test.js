'use strict';
// Behavioral controls for the notebook's promised project boundary. No provider or sidecar required.
const assert = require('node:assert/strict');
const { makeNotebookTools } = require('../sidecar/tools/builtin/notebook.js');
const { rank, renderRecall, compactionMemoryBlock } = require('../sidecar/context.js');

const rootA = 'C:\\Work\\Alpha', rootB = 'C:/Work/Beta';
const ctxA = { agentId: 'agent', streamId: 'alpha-first', runId: 'save-a', projectRoot: rootA };
const ctxB = { agentId: 'agent', streamId: 'beta-first', runId: 'save-b', projectRoot: rootB };
const againA = { ...ctxA, streamId: 'alpha-later', runId: 'later-a', projectRoot: 'c:/work/alpha/' };
const unscoped = { agentId: 'agent', streamId: ctxA.streamId, runId: 'no-project' };
const fact = 'The deployment database is in Frankfurt';
const requirement = 'Approved card design uses square blue panels with white labels';
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(initial = [], ranked = true) {
  const data = new Map([['notebook:agent', clone(initial)]]);
  let writes = 0, now = 1000;
  const receipts = [], events = [];
  const store = {
    get: key => data.get(key),
    async update(key, mutate) {
      const next = mutate(data.get(key));
      if (next !== undefined) { data.set(key, next); writes++; }
    }
  };
  const tools = makeNotebookTools({ store, clock: { now: () => ++now },
    ...(ranked ? { rank } : {}), onSaved: (...args) => receipts.push(args) });
  const context = ctx => ({ ...ctx, emit: (name, payload) => events.push({ name, payload }) });
  return {
    rows: () => data.get('notebook:agent'),
    snapshot: () => JSON.stringify({ rows: data.get('notebook:agent'), writes, receipts, events }),
    write: (args, ctx) => tools.writeTool.run(args, context(ctx)),
    read: (args, ctx) => tools.readTool.run(args, context(ctx)),
    feedback: (args, ctx) => tools.feedbackTool.run(args, context(ctx)),
    receipts, events
  };
}

function note(id, body, extra = {}) {
  return { id, title: 'Deployment', body, kind: 'note', scope: 'stream',
    streamId: ctxA.streamId, projectRoot: rootA, createdAt: 1, pinned: false, trust: 0, ...extra };
}

(async () => {
  // Legacy and explicit project shapes must agree, regardless of pin or relevance mode.
  for (const scope of ['stream', 'project']) for (const pinned of [false, true]) {
    const row = note('note_1', fact, { scope, pinned });
    const before = JSON.stringify(row);
    for (const projectRoot of [rootB, undefined, 'C:/Work/Alpha-other']) {
      for (const query of ['Frankfurt deployment', '']) for (const floor of [true, false]) {
        assert.deepEqual(rank([row], query, { projectRoot, streamId: ctxA.streamId, floor }), [],
          'foreign and unscoped reads cannot use matching text, pins, or a reused stream id to cross the boundary');
      }
      assert.doesNotMatch(renderRecall(rank([row], 'Frankfurt', { projectRoot })).text, /Frankfurt/);
      assert.equal(compactionMemoryBlock([row], 'Frankfurt', { projectRoot, streamId: ctxA.streamId }), '');
    }
    assert.deepEqual(rank([row], 'Frankfurt', againA).map(n => n.id), ['note_1']);
    assert.deepEqual(rank([row], 'Frankfurt', { ...againA, floor: false }).map(n => n.id), ['note_1']);
    assert.match(compactionMemoryBlock([row], 'Frankfurt', againA), /Frankfurt/);
    assert.equal(JSON.stringify(row), before, 'legacy compatibility never rewrites the stored record');
    const posix = { ...row, projectRoot: '/work/Alpha' };
    assert.equal(rank([posix], 'Frankfurt', { projectRoot: '/work/alpha' }).length, 0);
    assert.equal(rank([posix], 'Frankfurt', { projectRoot: '/work/Alpha/' }).length, 1);
  }

  // Exercise real writes: the same requirement belongs independently to both projects.
  for (const pinned of [false, true]) {
    const f = fixture();
    const args = { title: 'Approved card design', body: requirement, scope: 'stream', pinned };
    assert.match((await f.write(args, ctxA)).content, /Saved note.*Scope: this project/);
    assert.match((await f.write(args, ctxB)).content, /Saved note.*Scope: this project/);
    assert.deepEqual(f.rows().map(n => n.id), ['note_1', 'note_2']);
    assert.deepEqual(f.rows().map(n => n.projectRoot), [rootA, rootB]);
    assert.deepEqual(f.receipts.map(r => r[2].projectRoot), [rootA, rootB]);
    assert.deepEqual(rank(f.rows(), requirement, againA).map(n => n.id), ['note_1']);
    assert.deepEqual(rank(f.rows(), requirement, ctxB).map(n => n.id), ['note_2']);
    if (pinned) assert.deepEqual(rank(f.rows(), 'Make another one', againA).map(n => n.id), ['note_1'],
      'a real saved requirement survives a short follow-up in another conversation of its own project');
    const before = f.snapshot();
    assert.match((await f.write(args, againA)).content, /Not saved.*already remember/);
    assert.equal(f.snapshot(), before, 'same-project duplicate makes no write, receipt or event');
    assert.match((await f.write({ ...args, scope: 'global' }, ctxB)).content, /Scope: every conversation/);
    assert.equal(f.rows().length, 3, 'a project-only belief cannot substitute for an explicitly global save');
  }

  // Archived text and similar-note suggestions must use the same boundary as the new write.
  {
    const old = note('note_8', 'Database relocated to Oslo', { history: [{ body: fact, replacedAt: 2 }] });
    const f = fixture([old]);
    assert.match((await f.write({ title: 'Deployment', body: fact, distinct: true }, ctxB)).content, /^Saved note/);
    assert.equal(f.rows()[1].id, 'note_9', 'ids still come from the entire notebook');
    assert.deepEqual(f.rows()[0], old);
    const before = f.snapshot();
    assert.match((await f.write({ title: 'Deployment', body: fact, distinct: true }, againA)).content, /Not saved/);
    assert.equal(f.snapshot(), before, 'same-project archived text still cannot be resurrected by distinct');
    const pref = note('note_1', 'User prefers tabs', { title: 'Preference', content: 'User prefers tabs' });
    const foreign = fixture([pref]);
    const result = await foreign.write({ title: 'Preference', body: 'User prefers spaces' }, ctxB);
    assert.match(result.content, /^Saved note/);
    assert.doesNotMatch(result.content, /note_1|prefers tabs|Similar notes/);
    const local = fixture([pref]);
    // inside its own project the same subject is retired at write time (memory-truth-1027); across the boundary, never
    assert.match((await local.write({ title: 'Preference', body: 'User prefers spaces' }, againA)).content, /same subject[\s\S]*note_1/);
  }

  // List-all, singleton and multi-match reads must agree with or without an injected ranker.
  for (const ranked of [false, true]) for (const scope of ['stream', 'project']) for (const pinned of [false, true]) {
    const foreign = note('note_1', fact, { scope, pinned });
    const f = fixture([foreign], ranked);
    const before = f.snapshot();
    for (const ctx of [ctxB, unscoped]) for (const args of [{}, { query: 'Frankfurt' }, { query: 'Deployment' }]) {
      const result = await f.read(args, ctx);
      assert.doesNotMatch(result.content, /note_1|deployment database|Frankfurt.*saved/);
      assert.equal(result.summary, '0 notes');
      if (!args.query) assert.match(result.content, /No notes are available in this project/);
    }
    assert.match((await f.read({ query: 'Frankfurt' }, againA)).content, /note_1.*Frankfurt/);
    assert.equal(f.snapshot(), before, 'scoped reads neither migrate nor mutate existing stored records');
    const local = note('note_2', 'Deployment database is in Berlin', { projectRoot: rootB });
    const global = note('note_3', 'Deployment requires a backup', { scope: 'global', projectRoot: null, streamId: null });
    const mixed = fixture([foreign, local, global], ranked);
    const result = await mixed.read({ query: 'Deployment' }, ctxB);
    assert.doesNotMatch(result.content, /note_1|Frankfurt/);
    assert.match(result.content, /note_2/);
    assert.match(result.content, /note_3/);
    assert.match(result.content, /2 of 2 entries in memory/);
    assert.equal((await mixed.read({}, { ...ctxB, agentId: 'other' })).summary, '0 notes');
  }

  // A known foreign id and exact body must not authorize correction, even with a new scope.
  for (const scope of ['stream', 'project']) for (const pinned of [false, true]) {
    const f = fixture([note('note_1', fact, { scope, pinned })]);
    const before = f.snapshot();
    for (const ctx of [ctxB, unscoped]) for (const change of [{}, { scope: 'global' }, { scope: 'stream' }]) {
      await assert.rejects(f.write({ title: 'Deployment', body: 'The database is in Berlin',
        replaceId: 'note_1', previousBody: fact, ...change }, ctx), /no such memory in this project/);
      assert.equal(f.snapshot(), before, 'refused foreign correction changes no rows, history, receipt or event');
    }
    const revised = 'The deployment database is now in Berlin';
    await f.write({ title: 'Deployment', body: revised, replaceId: 'note_1', previousBody: fact }, againA);
    assert.equal(f.rows()[0].body, revised);
    assert.equal(f.rows()[0].history[0].body, fact);
    assert.equal(f.rows()[0].projectRoot, rootA);
    const corrected = f.snapshot();
    await assert.rejects(f.write({ title: 'Deployment', body: fact, replaceId: 'note_1', previousBody: fact }, againA), /changed since/);
    assert.equal(f.snapshot(), corrected);
  }

  // Same-run folding must neither delete a foreign copy nor import its pin.
  {
    const revised = 'Deployment database uses Berlin';
    const prior = note('note_1', fact);
    const copy = note('note_2', revised, { sourceRunId: againA.runId, projectRoot: rootB, pinned: true });
    const f = fixture([prior, copy]);
    await f.write({ title: 'Deployment', body: revised, replaceId: 'note_1', previousBody: fact }, againA);
    assert.equal(f.rows().length, 2);
    assert.equal(f.rows()[0].pinned, false);
    assert.deepEqual(f.rows()[1], copy);
    const local = fixture([prior, { ...copy, projectRoot: 'c:/work/alpha/' }]);
    assert.match((await local.write({ title: 'Deployment', body: revised, replaceId: 'note_1', previousBody: fact }, againA)).content, /Folded note_2/);
    assert.equal(local.rows().length, 1);
    assert.equal(local.rows()[0].pinned, true);
    assert.equal(local.rows()[0].history[0].body, fact);
    // Compare against the final boundary AFTER an explicit scope change.
    const widened = fixture([prior, { ...copy, projectRoot: rootA }]);
    await widened.write({ title: 'Deployment', body: revised, replaceId: 'note_1', previousBody: fact, scope: 'global' }, againA);
    assert.equal(widened.rows().length, 2);
    assert.equal(widened.rows()[0].scope, 'global');
    assert.equal(widened.rows()[0].pinned, false);
    assert.equal(widened.rows()[1].projectRoot, rootA);
  }

  // Feedback uses the same accessible candidate set for both id and substring lookup.
  {
    const foreign = note('note_1', fact);
    const f = fixture([foreign]);
    const before = f.snapshot();
    await assert.rejects(f.feedback({ rating: 'helpful', id: 'note_1' }, ctxB), /no memory has id/);
    await assert.rejects(f.feedback({ rating: 'helpful', match: 'Frankfurt' }, ctxB), /no memory matches/);
    assert.equal(f.snapshot(), before);
    await f.feedback({ rating: 'helpful', id: 'note_1' }, againA);
    assert.ok(f.rows()[0].trust > 0);
    const mixed = fixture([foreign, note('note_2', fact, { projectRoot: rootB })]);
    await mixed.feedback({ rating: 'helpful', match: 'Frankfurt' }, ctxB);
    assert.equal(mixed.rows()[0].trust, 0);
    assert.ok(mixed.rows()[1].trust > 0, 'foreign matching text cannot make local feedback ambiguous');
  }

  // Existing non-project behavior: explicit global/agent metadata, old shapes, and unanchored streams.
  {
    const rows = [
      note('note_1', fact, { scope: 'global', projectRoot: rootA, streamId: null }),
      note('note_2', 'Deployment database uses Lisbon', { scope: 'agent', projectRoot: rootA, streamId: null }),
      note('note_3', 'Deployment database uses Dublin', { projectRoot: null }),
      { id: 'note_4', title: 'Deployment legacy', body: 'Deployment database uses Paris', ts: 1 }
    ];
    assert.equal(rank(rows, 'Deployment database', ctxB).length, 4);
    const f = fixture(rows);
    for (const id of rows.map(n => n.id)) assert.ok((await f.read({}, ctxB)).content.includes('[' + id + ']'));
    const unanchored = fixture();
    const first = { agentId: 'agent', streamId: 'one', runId: 'one' };
    const second = { ...first, streamId: 'two', runId: 'two' };
    await unanchored.write({ title: 'Deployment', body: fact }, first);
    assert.equal(rank(unanchored.rows(), 'Frankfurt', second).length, 1);
    assert.match((await unanchored.write({ title: 'Deployment', body: fact }, second)).content, /Not saved/);
    await unanchored.write({ title: 'Deployment', body: 'Deployment uses Berlin', replaceId: 'note_1', previousBody: fact }, second);
    assert.equal(unanchored.rows()[0].history[0].body, fact);
    const folded = fixture([
      note('note_1', fact, { projectRoot: null }),
      note('note_2', 'Deployment uses Berlin', { scope: 'global', projectRoot: null, streamId: null,
        sourceRunId: second.runId, pinned: true })
    ]);
    await folded.write({ title: 'Deployment', body: 'Deployment uses Berlin', replaceId: 'note_1', previousBody: fact }, second);
    assert.equal(folded.rows().length, 1);
    assert.equal(folded.rows()[0].scope, 'global', 'existing unanchored stream/global folding is preserved');
    assert.equal(folded.rows()[0].pinned, true);
    const explicitGlobal = fixture();
    await explicitGlobal.write({ title: 'Replies', body: 'User prefers concise replies', scope: 'global', pinned: true }, ctxA);
    assert.match(renderRecall(rank(explicitGlobal.rows(), 'Continue', ctxB)).text, /concise replies/);
    // The pre-existing pin rule for incidental-root global/agent records is outside this repair.
    for (const scope of ['global', 'agent']) {
      const incidental = note('incidental', fact, { scope, pinned: true });
      assert.equal(rank([incidental], 'Frankfurt', ctxB).length, 0);
      assert.equal(rank([incidental], 'Frankfurt', againA).length, 1);
      assert.equal(rank([incidental], 'Frankfurt', { ...ctxB, floor: false }).length, 1);
      assert.match((await fixture([incidental]).read({}, ctxB)).content, /Frankfurt/);
    }
  }
  console.log('project-memory-boundary.test: PASS (project isolation, dedup, read, correction, folding, feedback, compatibility)');
})().catch(error => { console.error(error); process.exitCode = 1; });
