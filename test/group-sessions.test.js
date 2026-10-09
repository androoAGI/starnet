'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGroupSessions } = require('../sidecar/group-sessions.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-unit-'));
let sequence = 0, execute, api;
const seen = [];
const deps = { fs, path, root, now: () => ++sequence, id: () => 'id' + (++sequence), log: m => console.error(m),
  roster: () => [{ id: 'agent', name: 'Lead' }, { id: 'research', name: 'Researcher' }, { id: 'engineer', name: 'Engineer' }],
  execute: async o => { seen.push(o); o.emit('agent.run.start', { runId: o.runId }); return execute(o); },
  readFile: async () => ({ name: 'result.md', content: 'aGVsbG8=', bytes: 5, hash: 'hash' }),
  decodeFile: f => ({ text: Buffer.from(f.content, 'base64').toString(), hash: f.hash }), uploadFile: (name, content) => ({ name, content, hash: 'hash' }) };
const finish = content => ({ reason: 'done', messages: [{ role: 'assistant', content }] });
async function waitFor(fn) { for (let n = 0; n < 100; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); }
(async () => {
  try {
    api = makeGroupSessions(deps); await api.ready;
    execute = async () => finish('Hello');
    const g = await api.create({ members: ['agent', 'research', 'engineer'] });
    await Promise.all([api.send(g.id, { key: 'once', text: '@Researcher hello' }), api.send(g.id, { key: 'once', text: '@Researcher hello' })]);
    await api.idle(g.id);
    assert.equal(seen.length, 1); assert.equal(seen[0].t.agentId, 'research');
    let state = await api.get(g.id);
    assert.equal(state.messages.filter(m => m.author === 'user').length, 1);
    await api.send(g.id, { key: 'reply', text: 'explain', replyTo: state.messages.at(-1).id }); await api.idle(g.id);
    assert.equal(seen.at(-1).t.agentId, 'research');
    assert.match(seen.at(-1).ctx.messages[0].content, /Hello/);
    await assert.rejects(api.send(g.id, { key: 'bad', text: '@Missing do it' }), /Unknown/);
    await api.send(g.id, { key: 'quote', text: 'Discuss `@Missing`' }); await api.idle(g.id);
    assert.equal(seen.at(-1).t.agentId, 'agent');
    state = await api.get(g.id);
    await assert.rejects(api.configure(g.id, { revision: 0, members: ['agent'] }), /changed/);
    const rev = state.revision;
    await api.configure(g.id, { revision: rev, instructions: 'Cite evidence' });
    // A -> B -> A is legal; cap stops an endlessly repeated handoff.
    execute = async o => {
      const tool = o.tools.find(t => t.name === 'group.handoff');
      const target = o.t.agentId === 'agent' ? 'engineer' : 'agent';
      const result = await tool.run({ agentId: target, request: 'Review and revise step ' + seen.length });
      assert.ok(!result.isError); return finish('Review handed off');
    };
    const start = seen.length;
    await api.send(g.id, { key: 'chain', text: 'Review this' }); await api.idle(g.id);
    assert.equal(seen.length - start, 6);
    state = await api.get(g.id); assert.equal(state.turns.at(-1).state, 'held');
    assert.deepEqual(seen.slice(start, start + 3).map(o => o.t.agentId), ['agent', 'engineer', 'agent']);
    execute = async o => {
      if (o.t.agentId === 'engineer') {
        await o.tools.find(t => t.name === 'group.publish').run({ path: 'result.md' });
      }
      return finish('done');
    };
    await api.control(g.id, { action: 'continue' }); await api.idle(g.id);
    state = await api.get(g.id); assert.equal(state.artifacts.length, 0); // held turn was lead
    await api.send(g.id, { key: 'publish', text: '@engineer share' }); await api.idle(g.id);
    state = await api.get(g.id); assert.equal(state.artifacts.length, 1); assert.equal(state.artifacts[0].content, undefined);
    assert.equal((await api.file(g.id, state.artifacts[0].id)).content, 'aGVsbG8=');
    // Independent participants share a cutoff, excluding newly generated peer answers.
    execute = async o => finish('NEW_OPINION_' + o.t.agentId);
    const independentStart = seen.length;
    await api.send(g.id, { key: 'independent', text: 'Opinions?', all: true, independent: true, summarize: true }); await api.idle(g.id);
    assert.equal(seen.length - independentStart, 4);
    for (const o of seen.slice(independentStart, independentStart + 3)) assert.doesNotMatch(o.ctx.messages[0].content, /NEW_OPINION/);
    assert.match(seen.at(-1).ctx.messages[0].content, /NEW_OPINION/);
    // Interrupt cancels queued old work and sends the correction after abort acknowledgement.
    execute = o => new Promise(resolve => o.signal.addEventListener('abort', () => resolve(finish('partial')), { once: true }));
    await api.send(g.id, { key: 'slow', text: 'Old instruction', all: true });
    await waitFor(async () => (await api.get(g.id)).turns.some(t => t.state === 'running'));
    execute = async () => finish('New instruction accepted');
    await api.send(g.id, { key: 'correction', text: 'Use the new instruction', interrupt: true }); await api.idle(g.id);
    state = await api.get(g.id);
    const old = state.messages.find(m => m.key === 'slow');
    assert.ok(state.turns.filter(t => t.origin === old.id).every(t => t.state === 'stopped'));
    assert.equal(state.turns.at(-1).state, 'completed');
    // Approval is explicit, scoped to the right group and cleared when answered.
    execute = async o => { assert.equal(await o.prompt({ tool: 'fs.write', argsSummary: 'test', argsFull: { text: '{ "path": "the whole request" }', truncated: false } }), 'once'); return finish('approved'); };
    await api.send(g.id, { key: 'approval', text: 'write' });
    await waitFor(async () => (await api.get(g.id)).turns.at(-1).approval);
    state = await api.get(g.id);
    // INSPECT FULL REQUEST: the whole request is served from memory while the approval waits, and never saved on the turn
    assert.equal(state.turns.at(-1).approval.argsFull, undefined);
    assert.deepEqual(await api.approvalArgs(g.id, { promptId: state.turns.at(-1).approval.promptId }), { tool: 'fs.write', args: '{ "path": "the whole request" }', truncated: false });
    await assert.rejects(api.approvalArgs('wrong', { promptId: state.turns.at(-1).approval.promptId }), /no longer waiting/);
    await assert.rejects(api.answer('wrong', { promptId: state.turns.at(-1).approval.promptId, decision: 'once' }), /no longer/);
    await api.answer(g.id, { promptId: state.turns.at(-1).approval.promptId, decision: 'once' }); await api.idle(g.id);
    await assert.rejects(api.approvalArgs(g.id, { promptId: state.turns.at(-1).approval.promptId }), e => e.status === 404 && /no longer waiting/.test(e.message));
    // Recovery retains pending work but never dispatches on boot.
    await api.control(g.id, { action: 'pause' });
    await api.send(g.id, { key: 'queued', text: 'Pending' }); await api.idle(g.id);
    api.close(); api = makeGroupSessions(deps); await api.ready;
    state = await api.get(g.id); assert.equal(state.paused, true); assert.equal(state.turns.at(-1).state, 'queued');
    const branched = await api.fork(g.id, {}); assert.equal(branched.turns.length, 0); assert.ok(branched.messages.length); assert.equal(branched.artifacts.length, 1);
    await api.control(g.id, { action: 'save-group' }); assert.equal((await api.list()).templates.length, 1);
    // A single agent cannot start two group turns at once; stopping frees the lease.
    const one = await api.create({ members: ['agent'] }), two = await api.create({ members: ['agent'] });
    let unblock;
    execute = o => new Promise(resolve => { unblock = () => resolve(finish('finished')); o.signal.addEventListener('abort', () => resolve(finish('aborted')), { once: true }); });
    await api.send(one.id, { key: 'one', text: 'First' });
    await waitFor(async () => (await api.get(one.id)).turns[0]?.state === 'running');
    const seenBefore = seen.length;
    await api.send(two.id, { key: 'two', text: 'Second' });
    await waitFor(async () => (await api.get(two.id)).turns[0]?.reason?.startsWith('Waiting'));
    assert.equal(seen.length, seenBefore);
    execute = async () => finish('second'); unblock();
    await api.idle(one.id); await api.idle(two.id);
    assert.equal((await api.get(two.id)).turns[0].state, 'completed');
    // E-STOP pauses pending turns as well as aborting the live provider request.
    execute = o => new Promise(resolve => o.signal.addEventListener('abort', () => resolve(finish('stopped')), { once: true }));
    await api.send(one.id, { key: 'halt', text: 'Long work' });
    await waitFor(async () => (await api.get(one.id)).turns.at(-1).state === 'running');
    await api.send(one.id, { key: 'after', text: 'Queued work' });
    await api.halt(); await api.idle(one.id);
    const halted = await api.get(one.id);
    assert.equal(halted.paused, true); assert.equal(halted.turns.at(-1).state, 'queued'); assert.equal(halted.turns.at(-2).state, 'stopped');
    // Deleting a group with pending work is durable and cannot resurrect on restart.
    await api.control(one.id, { action: 'delete' });
    await assert.rejects(api.get(one.id), /not found/);
    api = makeGroupSessions(deps); await api.ready;
    await assert.rejects(api.get(one.id), /not found/);
    // (sweep 2026-10-02) DELETE MEANS GONE: the stored tombstone keeps none of the conversation (messages, turns,
    // artifacts with file contents) — they used to stay in group-sessions.json forever
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'group-sessions.json'), 'utf8'));
    const tomb = (stored.groups || (stored.value && stored.value.groups) || {})[one.id];
    assert.ok(tomb && tomb.deleted === true, 'the deleted group is a tombstone');
    assert.deepEqual([tomb.messages.length, tomb.turns.length, tomb.artifacts.length, tomb.instructions], [0, 0, 0, ''], 'and holds no messages, turns, artifacts or instructions');
    assert.ok(!JSON.stringify(tomb).includes('Long work'), 'none of its text survives');
    // Explicit invitation is idempotent and never fires a run.
    const invited = await api.create({ members: ['agent'] });
    const beforeInvite = seen.length;
    await Promise.all([api.invite(invited.id, { agentId: 'research' }), api.invite(invited.id, { agentId: 'research' })]);
    assert.deepEqual((await api.get(invited.id)).members, ['agent', 'research']); assert.equal(seen.length, beforeInvite);
    await assert.rejects(api.invite(invited.id, { agentId: 'missing' }), /roster/);
    // Judgment question remains on refresh and duplicate answers resume exactly once.
    execute = async o => { const answer = await o.askCommander({ question: 'Which format?', options: ['Short', 'Detailed'] }); return finish('Answer: ' + answer.text); };
    await api.send(invited.id, { key: 'question', text: 'Choose a format' });
    await waitFor(async () => (await api.get(invited.id)).questions?.length);
    let q = (await api.get(invited.id)).questions[0];
    assert.equal((await api.get(invited.id)).turns[0].state, 'waiting for answer');
    await Promise.all([api.answerQuestion(invited.id, { questionId: q.id, text: 'Short' }), api.answerQuestion(invited.id, { questionId: q.id, text: 'Short' })]);
    await api.idle(invited.id);
    assert.equal((await api.get(invited.id)).messages.filter(m => m.questionId === q.id).length, 1);
    await assert.rejects(api.answerQuestion(invited.id, { questionId: q.id, text: 'Detailed' }), /already answered/);
    // Restart preserves the outstanding question and resumes with a fresh, attributed continuation.
    await api.send(invited.id, { key: 'restart-question', text: 'Choose again' });
    await waitFor(async () => (await api.get(invited.id)).questions?.some(q => q.state === 'pending'));
    q = (await api.get(invited.id)).questions.at(-1);
    api.close(); await api.idle(invited.id);
    api = makeGroupSessions(deps); await api.ready;
    assert.equal((await api.get(invited.id)).questions.at(-1).state, 'pending');
    execute = async o => finish('Continued: ' + o.t.request);
    await api.answerQuestion(invited.id, { questionId: q.id, text: 'Detailed' }); await api.idle(invited.id);
    assert.match((await api.get(invited.id)).messages.at(-1).content, /Detailed/);
    // A tool timeout can end the execution while its durable question remains open.
    execute = async o => {
      o.askCommander({ question: 'Timed-out question?', options: ['Continue', 'Cancel'] }).catch(() => {});
      await waitFor(async () => (await api.get(invited.id)).questions.some(q => q.question === 'Timed-out question?'));
      return finish('Waiting');
    };
    await api.send(invited.id, { key: 'timeout-question', text: 'Ask and wait' }); await api.idle(invited.id);
    q = (await api.get(invited.id)).questions.at(-1);
    execute = async o => finish('Recovered timeout: ' + o.t.request);
    await api.answerQuestion(invited.id, { questionId: q.id, text: 'Continue' }); await api.idle(invited.id);
    assert.match((await api.get(invited.id)).messages.at(-1).content, /Recovered timeout/);
    // Stop cancels the question and queued work atomically; late answers cannot restart it.
    execute = async o => { await o.askCommander({ question: 'Wait?', options: ['Yes', 'No'] }); return finish('stopped'); };
    await api.send(invited.id, { key: 'stop-question', text: 'Ask' });
    await waitFor(async () => (await api.get(invited.id)).questions.some(q => q.state === 'pending'));
    q = (await api.get(invited.id)).questions.at(-1);
    await api.send(invited.id, { key: 'question-queued', text: 'Queued' });
    await api.control(invited.id, { action: 'stop-all' }); await api.idle(invited.id);
    assert.equal((await api.get(invited.id)).questions.at(-1).state, 'canceled');
    assert.ok((await api.get(invited.id)).turns.slice(-2).every(t => t.state === 'stopped'));
    await assert.rejects(api.answerQuestion(invited.id, { questionId: q.id, text: 'Yes' }), /no longer/);
    // Repeated identical requests pause; legitimate unique review steps above still complete to the cap.
    const repeat = await api.create({ members: ['agent', 'engineer'] });
    execute = async o => { await o.tools.find(t => t.name === 'group.handoff').run({ agentId: o.t.agentId === 'agent' ? 'engineer' : 'agent', request: 'Same request' }); return finish('No new result'); };
    await api.send(repeat.id, { key: 'repeat', text: 'Review' }); await api.idle(repeat.id);
    assert.match((await api.get(repeat.id)).turns.at(-1).reason, /Repeated request/);
    // Recover an abandoned queued handoff once, without duplicating the original run.
    api.close();
    let clock = 10000, broken = true;
    api = makeGroupSessions({ ...deps, now: () => clock, stallMs: 100, sweepMs: 1000000,
      isBusy: id => { if (id === 'engineer' && broken) { broken = false; throw new Error('injected scheduler interruption'); } return false; } }); await api.ready;
    const recover = await api.create({ members: ['agent', 'engineer'] });
    execute = async o => { if (!o.t.recoveryOf) await o.tools.find(t => t.name === 'group.handoff').run({ agentId: 'engineer', request: 'Inspect this' }); return finish('Checked'); };
    await api.send(recover.id, { key: 'recover', text: 'Review' }); await api.idle(recover.id);
    clock += 200; await api.sweep(); await api.idle(recover.id); await api.sweep();
    assert.equal((await api.get(recover.id)).turns.filter(t => t.recoveryOf).length, 1);
    assert.equal((await api.get(recover.id)).turns.find(t => t.agentId === 'engineer').state, 'held');
    // Quiet running work is flagged, never nudged/replayed; a real token clears the flag.
    const quiet = await api.create({ members: ['agent'] }); let running, release;
    execute = o => { running = o; return new Promise(r => { release = () => r(finish('Finished')); }); };
    await api.send(quiet.id, { key: 'quiet', text: 'Work' }); await waitFor(() => !!release);
    clock += 200; await api.sweep(); assert.equal((await api.get(quiet.id)).turns[0].quiet, true);
    assert.equal((await api.get(quiet.id)).turns.length, 1);
    running.emit('agent.token', { runId: running.runId, delta: 'progress' }); await api.sweep();
    assert.equal((await api.get(quiet.id)).turns[0].quiet, false); release(); await api.idle(quiet.id);
    console.log('group-sessions: routing, idempotency, context, revision cycles, cap, artifacts, independent opinions, interruption, approvals, restart and branches PASS');
  } finally { api?.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
