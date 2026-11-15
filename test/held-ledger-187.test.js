/* node test/held-ledger-187.test.js — HELD CALLS STAY UNDONE UNTIL THEY RUN (ops-1115 lane T3, #187).

   Red on 45e7ee302 (and on 8e09831f6): when the Task Brief gate HELD a call, any later ok result nulled the whole recovery
   ledger — brief_proceed's own ok included. A model that settled the brief and then said "Done." twice was never sent back:
   0 recovery notes, reason 'done', and the held fs_write never ran. A later failing turn also overwrote the held names, and
   the held list (per-run state) was lost when brief.ask ended the run on its question.

   Now:
     1. loop.js keeps a run-scoped held ledger: a held call stays pending until a success of the SAME tool. After its one
        held note, a model that ends again while held work is still pending ends 'error' / incomplete_work, exactly as the
        continuation guard does. Choice-marker replies, grace turns and tool-less runs are exempt.
     2. taskbrief-store.js keeps the held tool NAMES (no args) on the brief across a question (heldCalls, additive,
        absent on older briefs); brief.ask persists them; proceed() clears them; brief.proceed names them back.

   Hermetic: replay provider, a stub registry, a recording store stub, an in-memory disk. Asserts tags and result fields. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { TaskIntent } = require('../frontend/app/fork.js');
const { registerTaskBriefTools, noteHeldCall } = require('../sidecar/taskbrief-tools.js');
const { makeTaskBriefStore, normalizeBrief } = require('../sidecar/taskbrief-store.js');

const ANY = { type: 'object', properties: {} };
const toolDefs = (...names) => names.map(n => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } }));
const TOOLS = toolDefs('fs_write', 'fs_read', 'shell_exec', 'brief_proceed', 'brief_ask', 'brief_update');
// the exact shape index.js briefHoldFor returns for a held call (loop-truth.invariant uses the same)
const HELD = { ok: false, isError: true, content: TaskIntent.GATE_HELD_LEAD + ' Settle the Task Brief with brief_proceed, or ask the one material question with brief_ask, before consequential work, then make this same call again.', summary: TaskIntent.GATE_HELD, quietRepair: true };
const FAILED = { ok: false, isError: true, content: 'EACCES: permission denied, open note.txt', summary: 'error' };
const DENIED = { ok: false, isError: true, content: 'The Commander declined this call. Do NOT retry it.', summary: 'denied' };

const call = (id, name, args) => [{ type: 'tool_start', index: 0, id, name }, { type: 'tool_args', index: 0, chunk: JSON.stringify(args || {}) }, { type: 'done', finishReason: 'tool_calls' }];
const batch = (...cs) => {
  const out = [];
  cs.forEach(([id, name, args], i) => { out.push({ type: 'tool_start', index: i, id, name }, { type: 'tool_args', index: i, chunk: JSON.stringify(args || {}) }); });
  out.push({ type: 'done', finishReason: 'tool_calls' });
  return out;
};
const write = (id) => call(id, 'fs_write', { path: 'note.txt', content: 'note\n' });
const say = (t) => [{ type: 'text', delta: t }, { type: 'done', finishReason: 'stop' }];

function registry() {
  const r = makeRegistry();
  r.register({ impact: 'none', name: 'fs_write', schema: ANY, run: async (a) => 'wrote ' + a.path });
  r.register({ impact: 'none', name: 'fs_read', schema: ANY, run: async () => 'contents' });
  r.register({ impact: 'none', name: 'shell_exec', schema: ANY, run: async () => ({ content: 'ok\n[exit 0]', summary: 'exit 0 (5ms)' }) });
  r.register({ impact: 'none', name: 'brief_proceed', schema: ANY, run: async () => 'Task Brief settled.' });
  r.register({ impact: 'none', name: 'brief_ask', schema: ANY, run: async () => 'Waiting for the Commander.' });
  r.register({ impact: 'none', name: 'brief_update', schema: ANY, run: async () => 'Working understanding saved.' });
  return r;
}
// opts.held / opts.fail: call ids the gate holds / that fail as a real tool error
async function run(turns, opts) {
  opts = opts || {};
  const bus = A.makeBus();
  const log = A.collectBus(bus, ['agent.run.error']);
  const emit = makeEmitter(bus, () => {});
  const provider = makeReplayProvider({ turns });
  const messages = [{ role: 'user', content: 'save a note to note.txt' }];
  const reg = registry();
  const held = new Set(opts.held || []), fail = new Set(opts.fail || []), deny = new Set(opts.deny || []);
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: opts.tools || TOOLS,
    limits: Object.assign({ maxIters: 12, grace: false }, opts.limits || {}),
    dispatch: (c, ctx) => held.has(c.id) ? Promise.resolve(Object.assign({}, HELD))
      : fail.has(c.id) ? Promise.resolve(Object.assign({}, FAILED))
      : deny.has(c.id) ? Promise.resolve(Object.assign({}, DENIED)) : reg.dispatch(c, ctx),
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }
  });
  const tagged = (tag) => messages.filter(m => m.role === 'system' && String(m.content).indexOf('<' + tag + '>') === 0);
  const incomplete = log.filter(e => e.payload && e.payload.failureCode === 'incomplete_work');
  return { res, messages, fr: tagged('failure_recovery'), incomplete, calls: provider.callCount() };
}
const ended = (r) => r.res.reason + (r.incomplete.length ? '/incomplete_work' : '');

function fakeDisk() {
  const files = new Map();
  return {
    readFileSync(f) { if (!files.has(f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(f); },
    writeFileSync(f, d) { files.set(f, d); }, renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    existsSync(f) { return files.has(f); }, mkdirSync() {}, unlinkSync(f) { files.delete(f); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}, _files: files
  };
}
const writeDurable = ({ fs }, file, data) => fs.writeFileSync(file, data);
const material = () => ({ dimension: 'audience', question: 'who is this note for?', options: ['me', 'the team'], recommended: 'me', reason: 'It changes the wording.', discoverable: false });

(async () => {
  // ===== 1. RED: held, settled, "Done." twice -> one held note, then the run ends incomplete_work =====
  {
    const r = await run([write('w1'), call('p1', 'brief_proceed', { objective: 'save the note' }), say('Done.'), say('Done.')], { held: ['w1'] });
    A.eq(r.fr.length, 1, '1 a held call that never ran still buys its one held note after brief_proceed succeeds (base: 0)');
    A.ok(r.fr.length === 1 && /\bfs_write\b/.test(String(r.fr[0].content)), '1 the note names the held fs_write');
    A.eq(r.res.reason, 'error', '1 the second "Done." ends the run as an error, never done (base: done)');
    A.eq(r.incomplete.length, 1, '1 agent.run.error carries failureCode incomplete_work');
    A.ok(r.incomplete.length === 1 && r.incomplete[0].payload.transient === false, '1 the error is not transient');
    A.eq(r.calls, 4, '1 four model calls: held write, settle, noted answer, ended answer');
  }

  // ===== 2. LIVENESS =====
  {
    // 2a. held, then the same tool succeeds: the held name is cleared, no note, done
    const a = await run([write('w1'), batch(['p1', 'brief_proceed', { objective: 'x' }], ['w2', 'fs_write', { path: 'note.txt', content: 'note\n' }]), say('Done.')], { held: ['w1'] });
    A.eq([a.fr.length, ended(a)], [0, 'done'], '2a held, then fs_write succeeds: no note, ends done');

    // 2b. the failed-name ladder keeps today's rule: a failed fs_write then an ok shell_exec disarms it
    const b = await run([write('w1'), call('x1', 'shell_exec', { cmd: 'echo ok' }), say('Done.')], { fail: ['w1'] });
    A.eq([b.fr.length, ended(b)], [0, 'done'], '2b a failure followed by any ok call still disarms (loop.failure-recovery first case)');

    // 2c. an ok brief_ask, brief_proceed or brief_update never clears a held name
    for (const ctl of ['brief_ask', 'brief_proceed', 'brief_update']) {
      const c = await run([write('w1'), call('k1', ctl, {}), say('Done.'), say('Done.')], { held: ['w1'] });
      A.eq([c.fr.length, ended(c)], [1, 'error/incomplete_work'], '2c an ok ' + ctl + ' never clears the held fs_write');
    }
    const c3 = await run([write('w1'), batch(['k1', 'brief_ask', {}], ['k2', 'brief_update', {}], ['k3', 'brief_proceed', {}]), say('Done.'), say('Done.')], { held: ['w1'] });
    A.eq(ended(c3), 'error/incomplete_work', '2c all three brief controls in one batch never clear it either');

    // 2d. a reply that ends on a choice marker is a question to the Commander: it ends normally
    const d = await run([write('w1'), call('p1', 'brief_proceed', {}), say('Done.'), say('Which wording do you want?\nTASK_QUESTION: Which wording? || short | long')], { held: ['w1'] });
    A.eq([d.fr.length, d.res.reason, d.incomplete.length], [1, 'done', 0], '2d a choice-marker reply is exempt and ends normally');

    // 2e. a run with no tools offered is exempt (nothing could re-make the call)
    const e = await run([write('w1'), say('Done.'), say('Done.')], { held: ['w1'], tools: [] });
    A.eq(e.incomplete.length, 0, '2e a tool-less run never ends incomplete_work: ' + e.res.reason);

    // 2f. the grace turn (contracted tool-free) is exempt
    const f = await run([write('w1'), call('p1', 'brief_proceed', {}), say('Done.')], { held: ['w1'], limits: { maxIters: 2, grace: true } });
    A.eq(f.incomplete.length, 0, '2f a grace turn never ends incomplete_work: ' + f.res.reason);

    // 2g. a later failing turn MERGES with the earlier held names; the failed ladder runs first (two notes), then the end
    const g = await run([write('w1'), call('r1', 'fs_read', { path: 'config.yaml' }), say('Done.'), say('Done.'), say('Done.'), say('Done.')], { held: ['w1'], fail: ['r1'] });
    // (the mixed note's wording is pinned by loop-truth.invariant B3/B4: it names the failure; the end names the held call)
    A.eq(g.fr.length, 2, '2g the failed-call ladder keeps its two notes');
    A.eq(ended(g), 'error/incomplete_work', '2g once the ladder is spent, held work still pending ends incomplete_work (base: done, the held name was overwritten)');
    const gm = g.incomplete.length ? String(g.incomplete[0].payload.message) : '';
    A.ok(/\bfs_write\b/.test(gm) && !/\bfs_read\b/.test(gm), '2g the end names the held fs_write, merged across the failing turn, and not the failed read: ' + gm);

    // 2h. disabled recovery (limits.failureRecovery === false) disables the held note and so the end too
    const h = await run([write('w1'), call('p1', 'brief_proceed', {}), say('Done.')], { held: ['w1'], limits: { failureRecovery: false } });
    A.eq([h.fr.length, ended(h)], [0, 'done'], '2h failureRecovery:false: no note and no incomplete end (unchanged)');

    // 2j. held, settled, then the Commander DECLINES the same call when it is made again: the decision settles it (the
    // brief-readonly-shell DENY scenario): no held note, no incomplete end
    const j = await run([write('w1'), batch(['p1', 'brief_proceed', { objective: 'x' }], ['w2', 'fs_write', { path: 'note.txt', content: 'note\n' }]), say('You declined the write; nothing was saved.')], { held: ['w1'], deny: ['w2'] });
    A.eq([j.fr.length, ended(j)], [0, 'done'], '2j a declined re-made call is the Commander\'s decision: ends done');

    // 2k. held, then the same tool is made again and FAILS: it ran, so the failed ladder owns it and the end never says
    // "never ran"
    const k = await run([write('w1'), batch(['p1', 'brief_proceed', { objective: 'x' }], ['w2', 'fs_write', { path: 'note.txt', content: 'note\n' }]), say('Done.'), say('Done.'), say('It is read-only.')], { held: ['w1'], fail: ['w2'] });
    A.eq([k.fr.length, ended(k)], [2, 'done'], '2k a re-made call that failed keeps today\'s two-note ladder and its end');

    // 2i. a run with nothing held is untouched
    const i = await run([write('w1'), say('Done.')]);
    A.eq([i.fr.length, ended(i)], [0, 'done'], '2i nothing held: no note, ends done');
  }

  // ===== 3. THE STORE HALF: held names survive a question, by name only =====
  {
    // 3a. brief.ask on the end-run path persists the held names (wire names, no args, at most 6)
    const tools = {}, recorded = [];
    const reg = { register: t => { tools[t.name] = t; } };
    const state = { brief: { id: 'tb_1', status: 'ready', questions: [] } };
    const stub = {
      askMany: async (id) => ({ id, status: 'clarifying', questions: [{ id: id + '_q1', text: 'who is this note for?', options: ['me', 'the team'] }] }),
      noteHeld: async (id, names) => { recorded.push({ id, names: names.slice() }); return null; }
    };
    registerTaskBriefTools(reg, stub, state, { now: () => 1 });
    for (let k = 0; k < 9; k++) noteHeldCall(state, { name: 'fs.write', args: { path: 'f' + k, content: 'x' } });
    noteHeldCall(state, { name: 'shell.exec', args: { cmd: 'python hello.py' } });
    const asked = await tools['brief.ask'].run(material());
    A.eq(asked.control && asked.control.final, true, '3a brief.ask still ends the run on its question');
    A.eq(recorded.length, 1, '3a brief.ask persists the held names once');
    const names = recorded.length ? recorded[0].names : [];
    A.ok(names.length >= 1 && names.length <= 6, '3a at most 6 names: ' + JSON.stringify(names));
    A.ok(names.every(n => /^[a-z_]+$/.test(n)), '3a names only, wire form, no args: ' + JSON.stringify(names));
    A.eq(recorded.length && recorded[0].id, 'tb_1', '3a on the brief that asked');

    // 3a'. nothing held: noteHeld is never called
    const rec2 = [], tools2 = {};
    registerTaskBriefTools({ register: t => { tools2[t.name] = t; } }, Object.assign({}, stub, { noteHeld: async (id, n) => { rec2.push(n); } }), { brief: { id: 'tb_2', status: 'ready', questions: [] } }, { now: () => 1 });
    await tools2['brief.ask'].run(material());
    A.eq(rec2.length, 0, '3a nothing held: nothing persisted');

    // 3b. a fresh run whose brief carries heldCalls: brief.proceed names them (no args), without repeating in-run rows
    const t3 = {};
    const st3 = { brief: { id: 'tb_3', status: 'ready', heldCalls: ['fs_write', 'shell_exec'] } };
    registerTaskBriefTools({ register: t => { t3[t.name] = t; } }, { proceed: async (id, b) => Object.assign({}, b, { id, status: 'executing' }) }, st3, { now: () => 1 });
    const p3 = await t3['brief.proceed'].run({ objective: 'write and run hello.py' });
    const rows3 = p3.content.split('\n').filter(l => l.indexOf('- ') === 0);
    A.eq(rows3, ['- fs_write', '- shell_exec'], '3b the persisted held names are named back by the settle');
    A.eq(p3.summary, 'task brief settled', '3b the chip summary is unchanged');
    const t4 = {};
    const st4 = { brief: { id: 'tb_4', status: 'ready', heldCalls: ['fs_write', 'shell_exec'] } };
    registerTaskBriefTools({ register: t => { t4[t.name] = t; } }, { proceed: async (id, b) => Object.assign({}, b, { id, status: 'executing' }) }, st4, { now: () => 1 });
    noteHeldCall(st4, { name: 'fs.write', args: { path: 'hello.py' } });
    const rows4 = (await t4['brief.proceed'].run({ objective: 'write and run hello.py' })).content.split('\n').filter(l => l.indexOf('- ') === 0);
    A.eq(rows4.length, 2, '3b an in-run held row and the persisted name of the same tool are listed once: ' + JSON.stringify(rows4));
    A.ok(rows4[0].indexOf('- fs_write {') === 0 && rows4[1] === '- shell_exec', '3b the in-run row keeps its args; the other persisted name follows');

    // 3c. a real round trip through makeTaskBriefStore: kept through normalizeBrief and a restart, cleared by proceed()
    const disk = fakeDisk();
    const mk = () => makeTaskBriefStore({ fs: disk, path, workspaces: '/ws', writeDurable });
    const store = mk();
    await store.prepare({ id: 'tb_5', key: 'stream:5', text: 'Save a note' }, 100);
    A.eq(typeof store.noteHeld, 'function', '3c the store exposes noteHeld');
    if (typeof store.noteHeld === 'function') {
      await store.noteHeld('tb_5', ['fs_write', 'shell_exec', 'fs_write']);
      const restarted = mk();
      A.eq(restarted.active('stream:5').heldCalls, ['fs_write', 'shell_exec'], '3c the names survive a restart, deduped');
      const settled = await restarted.proceed('tb_5', { objective: 'save the note' }, 120);
      A.ok(settled && !('heldCalls' in settled), '3c proceed() clears them');
      A.ok(!('heldCalls' in mk().active('stream:5')), '3c ...on disk too');
    }

    // 3d. normalizeBrief: an older brief without the field normalises byte-identically; junk is bounded
    const old = { id: 'tb_old', key: 'stream:old', originalDirective: 'x', status: 'executing', createdAt: 5 };
    const n0 = normalizeBrief(old);
    A.ok(!('heldCalls' in n0), '3d a v0.15.0 brief gains no heldCalls key');
    A.eq(JSON.stringify(normalizeBrief(JSON.parse(JSON.stringify(n0)))), JSON.stringify(n0), '3d and re-normalises byte-identically');
    const junk = normalizeBrief(Object.assign({}, old, { heldCalls: [1, null, {}, 'a'.repeat(200), 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }));
    A.ok(Array.isArray(junk.heldCalls) && junk.heldCalls.length <= 6 && junk.heldCalls.every(s => typeof s === 'string' && s.length <= 80 && s), '3d strings only, at most 6, each at most 80: ' + JSON.stringify(junk.heldCalls));
    A.ok(!('heldCalls' in normalizeBrief(Object.assign({}, old, { heldCalls: 'fs_write' }))), '3d a non-array is dropped');

    // 3e. partial store stubs without noteHeld (the clarify / settle-first / answer-hold rigs) do not throw
    const t5 = {};
    const st5 = { brief: { id: 'tb_6', status: 'ready', questions: [] } };
    registerTaskBriefTools({ register: t => { t5[t.name] = t; } }, { askMany: stub.askMany }, st5, { now: () => 1 });
    noteHeldCall(st5, { name: 'fs.write', args: { path: 'x' } });
    let threw = null;
    try { await t5['brief.ask'].run(material()); } catch (e2) { threw = e2; }
    A.eq(threw, null, '3e a store without noteHeld never makes brief.ask throw');
    // a store whose noteHeld rejects never breaks the question either (fail-open, traced)
    const t6 = {};
    const st6 = { brief: { id: 'tb_7', status: 'ready', questions: [] } };
    registerTaskBriefTools({ register: t => { t6[t.name] = t; } }, { askMany: stub.askMany, noteHeld: async () => { throw new Error('disk full'); } }, st6, { now: () => 1 });
    noteHeldCall(st6, { name: 'fs.write', args: { path: 'x' } });
    let threw6 = null, out6 = null;
    try { out6 = await t6['brief.ask'].run(material()); } catch (e3) { threw6 = e3; }
    A.ok(!threw6 && out6 && out6.control && out6.control.final === true, '3e a failing noteHeld still asks the question');
  }

  A.report('held-ledger-187');
})().catch(e => { console.error(e); process.exit(1); });
