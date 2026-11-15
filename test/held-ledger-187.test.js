/* node test/held-ledger-187.test.js — HELD CALLS STAY UNDONE UNTIL THEY RUN (ops-1115 lane T3, #187).

   Red on 45e7ee302 (and on 8e09831f6): when the Task Brief gate HELD a call, any later ok result nulled the whole recovery
   ledger — brief_proceed's own ok included. A model that settled the brief and then said "Done." twice was never sent back:
   0 recovery notes, reason 'done', and the held fs_write never ran. A later failing turn also overwrote the held names, and
   the held list (per-run state) was lost when brief.ask ended the run on its question.

   Now:
     1. loop.js keeps a run-scoped held ledger keyed by the wire name (fs.write and fs_write are one tool): a held call stays
        pending until the SAME tool comes back not held. Each held note names the calls it is about; a later, different held
        call gets its own note (at most 3 per run).
     2. THE HOST ENDS A RUN incomplete_work ONLY WHEN IT CAN PROVE THE HELD WORK DID NOT HAPPEN (orchestrator ruling, wave 4):
        (a) a held note named every pending call; (b) they are still pending; (c) at the end the gate would no longer hold
        them (the host's o.briefGate.unlocked, the gate's own predicate; absent or unknown = no conversion); (d) since they
        were held, no call of a tool the gate governs (o.briefGate.governs) came back ok — that tool may have done the work.
        Otherwise the run ends exactly as at base: same reason, same reply text, nothing appended, no error event.
     3. taskbrief-store.js keeps the held tool NAMES (wire form, no args) on the brief across a question (heldCalls, additive,
        absent on older briefs); brief.ask persists them; proceed() clears them; brief.proceed names them back.

   The emulated gate below is the real TaskBriefPolicy.canMutate over a tool table, the way index.js briefHoldFor asks it.
   Hermetic: replay provider, a stub registry, a recording store stub, an in-memory disk. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { TaskIntent } = require('../frontend/app/fork.js');
const Policy = require('../sidecar/taskbrief-policy.js');
const StopReason = require('../sidecar/stop-reason.js');
const Friendly = require('../frontend/app/friendlyerror.js');
const { registerTaskBriefTools, noteHeldCall } = require('../sidecar/taskbrief-tools.js');
const { makeTaskBriefStore, normalizeBrief } = require('../sidecar/taskbrief-store.js');

const ANY = { type: 'object', properties: {} };
const toolDefs = (...names) => names.map(n => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } }));
const TOOLS = toolDefs('fs_write', 'fs_edit', 'fs_delete', 'fs_read', 'shell_exec', 'brief_proceed', 'brief_ask', 'brief_update');
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
const write = (id, name) => call(id, name || 'fs_write', { path: 'note.txt', content: 'note\n' });
const settle = (id) => call(id, 'brief_proceed', { objective: 'save the note' });
const say = (t) => [{ type: 'text', delta: t }, { type: 'done', finishReason: 'stop' }];

function registry() {
  const r = makeRegistry();
  for (const n of ['fs_write', 'fs.write', 'fs_edit', 'fs_delete']) r.register({ impact: 'none', name: n, schema: ANY, run: async (a) => 'wrote ' + (a.path || '') });
  r.register({ impact: 'none', name: 'fs_read', schema: ANY, run: async () => 'contents' });
  r.register({ impact: 'none', name: 'shell_exec', schema: ANY, run: async () => ({ content: 'ok\n[exit 0]', summary: 'exit 0 (5ms)' }) });
  r.register({ impact: 'none', name: 'brief_proceed', schema: ANY, run: async () => 'Task Brief settled.' });
  r.register({ impact: 'none', name: 'brief_ask', schema: ANY, run: async () => 'Waiting for the Commander.' });
  r.register({ impact: 'none', name: 'brief_update', schema: ANY, run: async () => 'Working understanding saved.' });
  return r;
}

/* THE EMULATED HOST GATE: the registry scope of each tool and the real TaskBriefPolicy.canMutate, as index.js briefHoldFor
   asks it. brief_* are the host's internal brief tools: never held, never governed. */
const SCOPE = { fs_write: 'write', fs_edit: 'write', fs_delete: 'write', shell_exec: 'execute', fs_read: 'read' };
const key = n => String(n == null ? '' : n).replace(/\./g, '_');
const toolOf = n => SCOPE[key(n)] ? { name: key(n), scope: SCOPE[key(n)] } : null;
function emulatedGate() {
  const brief = { status: 'ready' };
  return {
    brief,
    holds: (c) => { const t = toolOf(c.name); return !!t && !Policy.canMutate(brief, t, c).ok; },
    // what the host wires as o.briefGate: the gate's own predicate, asked now (unlocked) and for an unsettled brief (governs)
    briefGate: {
      unlocked: (names) => names.every(n => { const t = toolOf(n); return !!t && Policy.canMutate(brief, t, { name: n, args: {} }).ok; }),
      governs: (c) => { const t = toolOf(c.name); return !!t && !Policy.canMutate({ status: 'ready' }, t, c).ok; }
    }
  };
}
// a gate stub that says "unlocked" whatever the brief, for the fixed-hold cases
const OPEN_GATE = { unlocked: () => true, governs: (c) => { const t = toolOf(c.name); return !!t && t.scope !== 'read'; } };

// opts.gate: true = the emulated gate holds and is wired as o.briefGate; an object = that briefGate with fixed holds.
// opts.held / opts.fail / opts.deny: call ids held / failing / declined regardless of the gate
async function run(turns, opts) {
  opts = opts || {};
  const bus = A.makeBus();
  const log = A.collectBus(bus, ['agent.run.error', 'agent.token']);
  const emit = makeEmitter(bus, () => {});
  const provider = makeReplayProvider({ turns });
  const messages = [{ role: 'user', content: 'save a note to note.txt' }];
  const reg = registry();
  const gate = opts.gate === true ? emulatedGate() : null;
  const held = new Set(opts.held || []), fail = new Set(opts.fail || []), deny = new Set(opts.deny || []);
  const dispatch = async (c, ctx) => {
    if (held.has(c.id) || (gate && gate.holds(c))) return Object.assign({}, HELD);
    if (fail.has(c.id)) return Object.assign({}, FAILED);
    if (deny.has(c.id)) return Object.assign({}, DENIED);
    const r = await reg.dispatch(c, ctx);
    if (gate && key(c.name) === 'brief_proceed') gate.brief.status = 'executing';
    return r;
  };
  const loopOpts = {
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: opts.tools || TOOLS,
    limits: Object.assign({ maxIters: 14, grace: false }, opts.limits || {}),
    dispatch,
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }
  };
  if (gate) loopOpts.briefGate = gate.briefGate;
  else if (opts.gate && typeof opts.gate === 'object') loopOpts.briefGate = opts.gate;
  const res = await runAgentLoop(loopOpts);
  const tagged = (tag) => messages.filter(m => m.role === 'system' && String(m.content).indexOf('<' + tag + '>') === 0);
  const errors = log.filter(e => e.name === 'agent.run.error' || (e.payload && e.payload.failureCode));
  const incomplete = errors.filter(e => e.payload && e.payload.failureCode === 'incomplete_work');
  const deltas = log.filter(e => e.payload && typeof e.payload.delta === 'string').map(e => e.payload.delta).join('');
  const lastAssistant = messages.filter(m => m.role === 'assistant').slice(-1)[0];
  return { res, messages, fr: tagged('failure_recovery'), incomplete, deltas, last: lastAssistant ? String(lastAssistant.content || '') : '', calls: provider.callCount() };
}
const ended = (r) => r.res.reason + (r.incomplete.length ? '/incomplete_work' : '');
// "exactly as at base": the reason, the model's own reply text with nothing appended, no incomplete_work error
function asBase(r, text, label) {
  A.eq(ended(r), 'done', label + ': ends done, as at base');
  A.eq(r.last, text, label + ': the reply is the model\'s own text, nothing appended');
  A.ok(!/Work is incomplete/.test(r.deltas) && !/Work is incomplete/.test(String(r.res.text || '')), label + ': no incomplete line streamed or kept');
}

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
  // ===== (i) settled, nothing consequential ran afterwards, the model claims done: incomplete_work, plainly explained =====
  {
    const r = await run([write('w1'), settle('p1'), say('Done.'), say('Done.')], { gate: true });
    A.eq(r.fr.length, 1, '(i) a held call that never ran still buys its one held note after brief_proceed succeeds (base: 0)');
    A.ok(r.fr.length === 1 && /\bfs_write\b/.test(String(r.fr[0].content)), '(i) the note names the held fs_write');
    A.eq(ended(r), 'error/incomplete_work', '(i) the second "Done." ends the run error / incomplete_work, never done (base: done)');
    A.ok(r.incomplete.length === 1 && r.incomplete[0].payload.transient === false, '(i) the error is not transient');
    A.eq(r.calls, 4, '(i) four model calls: held write, settle, noted answer, ended answer');
    const msg = r.incomplete.length ? String(r.incomplete[0].payload.message) : '';
    // what COMMS (coded path) and a channel (hub.js explainStop) lead with: the explainer row, never the raw line or the
    // continuation guard's cause
    const ch = StopReason.explainStop(msg), cm = Friendly.friendlyError(msg, null, { engineAlive: true, code: 'incomplete_work' });
    A.ok(!!ch && ch.kind === 'incomplete_work', '(i) the channel line is explained, not sent raw: ' + msg);
    A.eq(cm.userMessage, ch && ch.text, '(i) COMMS leads with the same plain sentence as the channel');
    const plain = ch ? ch.text : '';
    A.ok(/fs_write never ran/.test(plain), '(i) the explainer says what happened: ' + plain);
    A.ok(/changed nothing/.test(plain), '(i) ...that the call changed nothing');
    A.ok(/Say "continue"/.test(plain), '(i) ...and what to do next');
    A.ok(!/kept saying what it would do next|gate/.test(plain), '(i) ...never the continuation guard\'s cause, never "gate" jargon');
  }
  // (i') the host did not wire its gate predicate (o.briefGate absent): the loop cannot prove the work is undone -> base end
  {
    const r = await run([write('w1'), settle('p1'), say('Done.'), say('Done.')], { held: ['w1'] });
    A.eq(r.fr.length, 1, '(i\') no briefGate: the held note is still sent');
    asBase(r, 'Done.', '(i\') no briefGate wired');
  }

  // ===== (ii) settled, and the model makes the held call again: a clean done =====
  {
    const a = await run([write('w1'), settle('p1'), write('w2'), say('Done.')], { gate: true });
    A.eq([a.fr.length, ended(a)], [0, 'done'], '(ii) held, settled, fs_write made again: no note, ends done');
    const b = await run([write('w1'), batch(['p1', 'brief_proceed', { objective: 'x' }], ['w2', 'fs_write', { path: 'note.txt', content: 'note\n' }]), say('Done.')], { gate: true });
    A.eq([b.fr.length, ended(b)], [0, 'done'], '(ii) settle and the same call in one response: no note, ends done');
    const c = await run([write('w1'), settle('p1'), say('Done.'), write('w2'), say('Done: note.txt is saved.')], { gate: true });
    A.eq([c.fr.length, ended(c)], [1, 'done'], '(ii) after the held note the model makes the call: ends done');
  }

  // ===== (iii) brief UNSETTLED, the model stops to ask the Commander in prose: the base outcome, the question delivered =====
  {
    const Q = 'Should the note go in note.txt or in notes/today.txt?';
    const r = await run([write('w1'), say(Q), say(Q)], { gate: true });
    A.eq(r.fr.length, 1, '(iii) the held note is sent once, as at base');
    asBase(r, Q, '(iii) unsettled brief, prose question');
    // ...and the plain "nothing ran" exit the held note itself offers, while the brief is still unsettled
    const N = 'I did not save the note: fs_write did not run because the brief is not settled yet.';
    const n = await run([write('w1'), say('Done.'), say(N)], { gate: true });
    asBase(n, N, '(iii) unsettled brief, the model says plainly that nothing ran');
    // the same with fixed holds and no gate wired (the shape REF can run): green on base code as well
    const b = await run([write('w1'), say(Q), say(Q)], { held: ['w1'] });
    asBase(b, Q, '(iii) fixed hold, no gate wired');
  }

  // ===== (iv) settled, and the work is done with a DIFFERENT consequential tool: the host cannot prove it undone (P1) =====
  {
    const T = 'Done: I used fs_edit instead of fs_write; note.txt is saved.';
    const e = await run([write('w1'), settle('p1'), call('e1', 'fs_edit', { path: 'note.txt' }), say('Done.'), say(T)], { gate: true });
    asBase(e, T, '(iv) fs_edit after the held fs_write');
    const S = 'Done: I wrote note.txt with the shell.';
    const s = await run([write('w1'), settle('p1'), call('x1', 'shell_exec', { cmd: 'echo note > note.txt' }), say('Done.'), say(S)], { gate: true });
    asBase(s, S, '(iv) shell_exec after the held fs_write');
    // a READ after the settle is not the work: it does not stop the end
    const rd = await run([write('w1'), settle('p1'), call('r1', 'fs_read', { path: 'note.txt' }), say('Done.'), say('Done.')], { gate: true });
    A.eq(ended(rd), 'error/incomplete_work', '(iv) a read the gate does not govern is not the held work: still incomplete_work');
    // a governs() that throws, or an unlocked() that throws, proves nothing: base end
    const boom = () => { throw new Error('host predicate down'); };
    const g1 = await run([write('w1'), settle('p1'), say('Done.'), say('Done.')], { held: ['w1'], gate: { unlocked: boom, governs: OPEN_GATE.governs } });
    asBase(g1, 'Done.', '(iv) unlocked() throws');
    const g2 = await run([write('w1'), settle('p1'), call('r1', 'fs_read', {}), say('Done.'), say('Done.')], { held: ['w1'], gate: { unlocked: () => true, governs: boom } });
    asBase(g2, 'Done.', '(iv) governs() throws');
    const g3 = await run([write('w1'), settle('p1'), say('Done.'), say('Done.')], { held: ['w1'], gate: { unlocked: () => null, governs: OPEN_GATE.governs } });
    asBase(g3, 'Done.', '(iv) unlocked() unknown (not true)');
  }

  // ===== (v) a re-make under the dotted alias clears the held name (P3) =====
  {
    const v = await run([write('w1'), settle('p1'), write('w2', 'fs.write'), say('Done.'), say('Done.')], { gate: true });
    A.eq([v.fr.length, ended(v)], [0, 'done'], '(v) fs.write made after fs_write was held: the same tool, cleared, ends done');
    const v2 = await run([write('w1', 'fs.write'), settle('p1'), write('w2'), say('Done.')], { gate: true });
    A.eq([v2.fr.length, ended(v2)], [0, 'done'], '(v) and the other way round');
  }

  // ===== (vi) a later, DIFFERENT held call gets its own note (P4); at most 3 held notes per run =====
  {
    const r = await run([write('w1'), say('Done.'), settle('p1'), write('w2'), call('x1', 'shell_exec', { cmd: 'python a.py' }), say('Done.'), say('Done.')], { held: ['w1', 'x1'] });
    A.eq(r.fr.length, 2, '(vi) the second held call (shell_exec) gets its own note');
    A.ok(r.fr.length === 2 && /\bshell_exec\b/.test(String(r.fr[1].content)), '(vi) the second note names shell_exec');
    const same = await run([write('w1'), say('Done.'), write('w2'), say('Done.'), say('Done.')], { held: ['w1', 'w2'] });
    A.eq(same.fr.length, 1, '(vi) the SAME held call made and held again gets no second note');
    const many = await run([write('w1'), say('Done.'), call('e1', 'fs_edit', {}), say('Done.'), call('x1', 'shell_exec', {}), say('Done.'),
      call('d1', 'fs_delete', {}), say('Done.'), say('Done.')], { held: ['w1', 'e1', 'x1', 'd1'] });
    A.eq(many.fr.length, 3, '(vi) four different held calls: at most 3 held notes');
    // a pending name no note named never ends the run incomplete_work, even with the gate open
    const unnamed = await run([write('w1'), say('Done.'), call('e1', 'fs_edit', {}), say('Done.'), call('x1', 'shell_exec', {}), say('Done.'),
      call('d1', 'fs_delete', {}), say('Done.'), say('Done.')], { held: ['w1', 'e1', 'x1', 'd1'], gate: OPEN_GATE });
    asBase(unnamed, 'Done.', '(vi) fs_delete was never named by a note');
  }

  // ===== LIVENESS =====
  {
    // the failed-name ladder keeps today's rule: a failed fs_write then an ok shell_exec disarms it
    const b = await run([write('w1'), call('x1', 'shell_exec', { cmd: 'echo ok' }), say('Done.')], { fail: ['w1'] });
    A.eq([b.fr.length, ended(b)], [0, 'done'], 'L1 a failure followed by any ok call still disarms (loop.failure-recovery first case)');

    // an ok brief_ask, brief_proceed or brief_update never clears a held name
    for (const ctl of ['brief_ask', 'brief_proceed', 'brief_update']) {
      const c = await run([write('w1'), call('k1', ctl, {}), say('Done.'), say('Done.')], { held: ['w1'], gate: OPEN_GATE });
      A.eq([c.fr.length, ended(c)], [1, 'error/incomplete_work'], 'L2 an ok ' + ctl + ' never clears the held fs_write');
    }
    // ...while the brief is unsettled (only asked or updated) the end never converts: base outcome
    for (const ctl of ['brief_ask', 'brief_update']) {
      const c = await run([write('w1'), call('k1', ctl, {}), say('Done.'), say('Done.')], { gate: true });
      A.eq([c.fr.length, ended(c)], [1, 'done'], 'L2 ' + ctl + ' alone leaves the brief unsettled: noted, then the base end');
    }

    // a reply that ends on a choice marker is a question to the Commander: it ends normally
    const d = await run([write('w1'), settle('p1'), say('Done.'), say('Which wording do you want?\nTASK_QUESTION: Which wording? || short | long')], { gate: true });
    A.eq([d.fr.length, d.res.reason, d.incomplete.length], [1, 'done', 0], 'L3 a choice-marker reply is exempt and ends normally');

    // a run with no tools offered is exempt (nothing could re-make the call)
    const e = await run([write('w1'), say('Done.'), say('Done.')], { held: ['w1'], tools: [], gate: OPEN_GATE });
    A.eq(e.incomplete.length, 0, 'L4 a tool-less run never ends incomplete_work: ' + e.res.reason);

    // the grace turn (contracted tool-free) is exempt
    const f = await run([write('w1'), settle('p1'), say('Done.')], { gate: true, limits: { maxIters: 2, grace: true } });
    A.eq(f.incomplete.length, 0, 'L5 a grace turn never ends incomplete_work: ' + f.res.reason);

    // a later failing turn MERGES with the earlier held names: after the failure is recovered (a read), the held note names
    // fs_write, and the end names it — not the failed read
    const g = await run([write('w1'), settle('p1'), call('r1', 'fs_read', { path: 'config.yaml' }), call('r2', 'fs_read', { path: 'config.yml' }), say('Done.'), say('Done.')], { gate: true, fail: ['r1'] });
    A.eq(ended(g), 'error/incomplete_work', 'L6 the held name survives a failing turn and the read that recovered it (base: done)');
    const gm = g.incomplete.length ? String(g.incomplete[0].payload.message) : '';
    A.ok(/\bfs_write\b/.test(gm) && !/\bfs_read\b/.test(gm), 'L6 the end names the held fs_write, not the failed read: ' + gm);
    // a mixed failed+held note names only the failure (pinned by loop-truth.invariant B3/B4): it never counts as naming
    // the held call, so a run whose failure stands ends as at base
    const gx = await run([write('w1'), settle('p1'), call('r1', 'fs_read', { path: 'config.yaml' }), say('Done.'), say('Done.'), say('It is unreadable.')], { gate: true, fail: ['r1'] });
    A.eq(gx.fr.length, 2, 'L6 the failed-call ladder keeps its two notes');
    asBase(gx, 'It is unreadable.', 'L6 the mixed notes never named fs_write');

    // disabled recovery (limits.failureRecovery === false) disables the held note and so the end too
    const h = await run([write('w1'), settle('p1'), say('Done.')], { gate: true, limits: { failureRecovery: false } });
    A.eq([h.fr.length, ended(h)], [0, 'done'], 'L7 failureRecovery:false: no note and no incomplete end (unchanged)');

    // held, settled, then the Commander DECLINES the same call when it is made again: the decision settles it
    const j = await run([write('w1'), batch(['p1', 'brief_proceed', { objective: 'x' }], ['w2', 'fs_write', { path: 'note.txt', content: 'note\n' }]), say('You declined the write; nothing was saved.')], { gate: true, deny: ['w2'] });
    A.eq([j.fr.length, ended(j)], [0, 'done'], 'L8 a declined re-made call is the Commander\'s decision: ends done');

    // held, then the same tool is made again and FAILS: it ran, so the failed ladder owns it and the end never says "never ran"
    const k = await run([write('w1'), batch(['p1', 'brief_proceed', { objective: 'x' }], ['w2', 'fs_write', { path: 'note.txt', content: 'note\n' }]), say('Done.'), say('Done.'), say('It is read-only.')], { gate: true, fail: ['w2'] });
    A.eq([k.fr.length, ended(k)], [2, 'done'], 'L9 a re-made call that failed keeps today\'s two-note ladder and its end');

    // a run with nothing held is untouched
    const i = await run([settle('p0'), write('w1'), say('Done.')], { gate: true });
    A.eq([i.fr.length, ended(i)], [0, 'done'], 'L10 nothing held (the call ran): no note, ends done');
  }

  // ===== THE STORE HALF: held names survive a question, by name only, in the loop's key =====
  {
    // brief.ask on the end-run path persists the held names (wire names, no args, at most 6)
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
    A.eq(asked.control && asked.control.final, true, 'S1 brief.ask still ends the run on its question');
    A.eq(recorded.length, 1, 'S1 brief.ask persists the held names once');
    const names = recorded.length ? recorded[0].names : [];
    A.eq(names, ['fs_write'], 'S1 one name per tool, in the wire form the loop keys on (fs.write = fs_write), no args: ' + JSON.stringify(names));
    A.eq(recorded.length && recorded[0].id, 'tb_1', 'S1 on the brief that asked');

    // nothing held: noteHeld is never called
    const rec2 = [], tools2 = {};
    registerTaskBriefTools({ register: t => { tools2[t.name] = t; } }, Object.assign({}, stub, { noteHeld: async (id, n) => { rec2.push(n); } }), { brief: { id: 'tb_2', status: 'ready', questions: [] } }, { now: () => 1 });
    await tools2['brief.ask'].run(material());
    A.eq(rec2.length, 0, 'S1 nothing held: nothing persisted');

    // a fresh run whose brief carries heldCalls: brief.proceed names them (no args), without repeating in-run rows
    const t3 = {};
    const st3 = { brief: { id: 'tb_3', status: 'ready', heldCalls: ['fs_write', 'shell_exec'] } };
    registerTaskBriefTools({ register: t => { t3[t.name] = t; } }, { proceed: async (id, b) => Object.assign({}, b, { id, status: 'executing' }) }, st3, { now: () => 1 });
    const p3 = await t3['brief.proceed'].run({ objective: 'write and run hello.py' });
    const rows3 = p3.content.split('\n').filter(l => l.indexOf('- ') === 0);
    A.eq(rows3, ['- fs_write', '- shell_exec'], 'S2 the persisted held names are named back by the settle');
    A.eq(p3.summary, 'task brief settled', 'S2 the chip summary is unchanged');
    const t4 = {};
    const st4 = { brief: { id: 'tb_4', status: 'ready', heldCalls: ['fs.write', 'shell_exec'] } };
    registerTaskBriefTools({ register: t => { t4[t.name] = t; } }, { proceed: async (id, b) => Object.assign({}, b, { id, status: 'executing' }) }, st4, { now: () => 1 });
    noteHeldCall(st4, { name: 'fs.write', args: { path: 'hello.py' } });
    const rows4 = (await t4['brief.proceed'].run({ objective: 'write and run hello.py' })).content.split('\n').filter(l => l.indexOf('- ') === 0);
    A.eq(rows4.length, 2, 'S2 an in-run held row and the persisted name of the same tool (dotted or not) are listed once: ' + JSON.stringify(rows4));
    A.ok(rows4[0].indexOf('- fs_write {') === 0 && rows4[1] === '- shell_exec', 'S2 the in-run row keeps its args; the other persisted name follows');

    // a real round trip through makeTaskBriefStore: kept through normalizeBrief and a restart, cleared by proceed()
    const disk = fakeDisk();
    const mk = () => makeTaskBriefStore({ fs: disk, path, workspaces: '/ws', writeDurable });
    const store = mk();
    await store.prepare({ id: 'tb_5', key: 'stream:5', text: 'Save a note' }, 100);
    A.eq(typeof store.noteHeld, 'function', 'S3 the store exposes noteHeld');
    if (typeof store.noteHeld === 'function') {
      await store.noteHeld('tb_5', ['fs_write', 'shell_exec', 'fs.write']);
      const restarted = mk();
      A.eq(restarted.active('stream:5').heldCalls, ['fs_write', 'shell_exec'], 'S3 the names survive a restart, deduped by the loop\'s key');
      const settled = await restarted.proceed('tb_5', { objective: 'save the note' }, 120);
      A.ok(settled && !('heldCalls' in settled), 'S3 proceed() clears them');
      A.ok(!('heldCalls' in mk().active('stream:5')), 'S3 ...on disk too');
    }

    // normalizeBrief: an older brief without the field normalises byte-identically; junk is bounded
    const old = { id: 'tb_old', key: 'stream:old', originalDirective: 'x', status: 'executing', createdAt: 5 };
    const n0 = normalizeBrief(old);
    A.ok(!('heldCalls' in n0), 'S4 a v0.15.0 brief gains no heldCalls key');
    A.eq(JSON.stringify(normalizeBrief(JSON.parse(JSON.stringify(n0)))), JSON.stringify(n0), 'S4 and re-normalises byte-identically');
    const junk = normalizeBrief(Object.assign({}, old, { heldCalls: [1, null, {}, 'a'.repeat(200), 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }));
    A.ok(Array.isArray(junk.heldCalls) && junk.heldCalls.length <= 6 && junk.heldCalls.every(s => typeof s === 'string' && s.length <= 80 && s), 'S4 strings only, at most 6, each at most 80: ' + JSON.stringify(junk.heldCalls));
    A.ok(!('heldCalls' in normalizeBrief(Object.assign({}, old, { heldCalls: 'fs_write' }))), 'S4 a non-array is dropped');
    A.eq(normalizeBrief(Object.assign({}, old, { heldCalls: ['fs.write', 'fs_write'] })).heldCalls, ['fs_write'], 'S4 kept in the loop\'s key: fs.write and fs_write are one name');

    // partial store stubs without noteHeld (the clarify / settle-first / answer-hold rigs) do not throw
    const t5 = {};
    const st5 = { brief: { id: 'tb_6', status: 'ready', questions: [] } };
    registerTaskBriefTools({ register: t => { t5[t.name] = t; } }, { askMany: stub.askMany }, st5, { now: () => 1 });
    noteHeldCall(st5, { name: 'fs.write', args: { path: 'x' } });
    let threw = null;
    try { await t5['brief.ask'].run(material()); } catch (e2) { threw = e2; }
    A.eq(threw, null, 'S5 a store without noteHeld never makes brief.ask throw');
    // a store whose noteHeld rejects never breaks the question either (fail-open, traced)
    const t6 = {};
    const st6 = { brief: { id: 'tb_7', status: 'ready', questions: [] } };
    registerTaskBriefTools({ register: t => { t6[t.name] = t; } }, { askMany: stub.askMany, noteHeld: async () => { throw new Error('disk full'); } }, st6, { now: () => 1 });
    noteHeldCall(st6, { name: 'fs.write', args: { path: 'x' } });
    let threw6 = null, out6 = null;
    try { out6 = await t6['brief.ask'].run(material()); } catch (e3) { threw6 = e3; }
    A.ok(!threw6 && out6 && out6.control && out6.control.final === true, 'S5 a failing noteHeld still asks the question');
  }

  A.report('held-ledger-187');
})().catch(e => { console.error(e); process.exit(1); });
