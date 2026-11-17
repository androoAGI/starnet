/* node test/taskbrief.held-again.test.js — THE HELD CALL IS MADE AGAIN (#187, 2026-11-14).

   The Task Brief gate held [fs_write hello.py, shell_exec python hello.py] ("nothing ran"), qwen3:8b settled the brief with
   brief_proceed, got back only "Task Brief settled. Consequential tools are unlocked.", and answered "hello.py has been
   created and executed" with no file on disk (live wire capture, cand-0152 scratch station). The gate now records each call
   it holds and the settle names them. This pins the settle's reply and the gate's wiring in index.js.

   THE NOTE STATES FACTS AND DOES NOT ORDER PAST THE PERSON'S ANSWER (ops-1115 lane T3s, attack A4-F1). Red on 8ca33b1a6:
   a write was held, the agent asked "Should I replace the existing note file?", the person answered "No, keep it", and the
   settle's reply still said the held call "must be made again now" (after a "No" on the live card with the call's
   arguments; after a "No" in a later run by name). The order stays only where NO answer came between the hold and the
   settle (the #187 case above). A call held BEFORE an answer is stated as a fact (held, did not run) and is owed only if
   the task as it now stands still calls for it. The cases below run the real brief tools over the real brief store. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { registerTaskBriefTools, noteHeldCall } = require('../sidecar/taskbrief-tools.js');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');
const H = require('./helpers/source.js');

const BASE = 'Task Brief settled. Consequential tools are unlocked.';
function rig() {
  const tools = {};
  const registry = { register: t => { tools[t.name] = t; } };
  const state = { brief: { id: 'tb_1', status: 'clarifying' } };
  const store = { proceed: async (id, brief) => Object.assign({}, state.brief, brief, { status: 'executing' }) };
  registerTaskBriefTools(registry, store, state, { now: () => 1 });
  return { state, proceed: args => tools['brief.proceed'].run(args || { objective: 'write and run hello.py' }) };
}

(async () => {
  // ---- the #187 case: two held calls are named back, in order, by their wire names ----
  {
    const r = rig();
    noteHeldCall(r.state, { name: 'fs.write', args: { path: 'hello.py', content: "print('hello world')" } });
    noteHeldCall(r.state, { name: 'shell.exec', args: { cmd: 'python hello.py' } });
    const out = await r.proceed();
    A.ok(out.content.indexOf(BASE) === 0, 'the settle still opens with the unlocked line');
    A.ok(/Nothing has run yet: the calls the brief held must be made again now/.test(out.content), 'it says nothing ran and the calls must be made again');
    const a = out.content.indexOf('- fs_write {"path":"hello.py"'), b = out.content.indexOf('- shell_exec {"cmd":"python hello.py"}');
    A.ok(a > 0 && b > a, 'both held calls are named with their args, wire names, in the order they were held');
    A.eq(out.summary, 'task brief settled', 'the chip summary is unchanged');
    // the settle clears them: a second settle (a later brief) never repeats work already handed back
    const again = await r.proceed();
    A.eq(again.content, BASE, 'the list is cleared by the settle');
  }
  // ---- nothing held: the reply is byte-identical to before (the channel e2e pins it) ----
  {
    const r = rig();
    A.eq((await r.proceed()).content, BASE, 'no held call: the old reply exactly');
  }
  // ---- one call: singular wording; a repeated identical hold is listed once ----
  {
    const r = rig();
    noteHeldCall(r.state, { name: 'shell.exec', args: { cmd: 'wc -l hello.py' } });
    noteHeldCall(r.state, { name: 'shell.exec', args: { cmd: 'wc -l hello.py' } });
    const out = (await r.proceed()).content;
    A.ok(/the call the brief held must be made again/.test(out), 'singular for one call');
    A.eq(out.split('- shell_exec').length - 1, 1, 'an identical hold is listed once');
  }
  // ---- bounded: 6 calls, 300 chars of args each; junk never throws ----
  {
    const r = rig();
    for (let i = 0; i < 10; i++) noteHeldCall(r.state, { name: 'fs.write', args: { path: 'f' + i, content: 'x'.repeat(2000) } });
    noteHeldCall(r.state, null); noteHeldCall(r.state, { args: {} }); noteHeldCall(null, { name: 'fs.write' });
    const cyclic = {}; cyclic.self = cyclic;
    const r2 = rig(); noteHeldCall(r2.state, { name: 'fs.write', args: cyclic });
    A.ok((await r2.proceed()).content.indexOf('- fs_write {}') > 0, 'args that cannot be serialized read as {}');
    const out = (await r.proceed()).content;
    A.eq(out.split('\n- ').length - 1, 6, 'at most 6 held calls are named');
    A.ok(out.split('\n').every(l => l.length < 340), 'each row is capped');
  }
  // ==== THE NOTE AFTER AN ANSWER (lane T3s): the real brief tools over the real brief store, one "run" per rig.run() ====
  {
    const ORDER = /must be made again|Nothing has run yet/;
    // the fact, then the condition; never an order
    const OWED_ONE = 'It is still owed, once, only if the task as it now stands, including what the Commander has answered since, still calls for it: then make it now, in this same turn, before you report any result. Otherwise it is not owed and stays not run.';
    const OWED_MANY = 'Each is still owed, once, only if the task as it now stands, including what the Commander has answered since, still calls for it: then make it now, in this same turn, before you report any result. Otherwise it is not owed and stays not run.';
    const ASK = { dimension: 'safety', question: 'Should I replace the existing note file?', options: ['Yes, replace it', 'No, keep it'], recommended: 'No, keep it', reason: 'replacing it loses the old note', discoverable: false };
    const SETTLE = { objective: 'do what the Commander decided' };
    const WRITE = { name: 'fs.write', args: { path: 'note.txt', content: 'NEW' } }, SHELL = { name: 'shell.exec', args: { cmd: 'python note.py' } };
    const WRITE_ROW = '- fs_write {"path":"note.txt","content":"NEW"}';
    const disk = new Map();
    const fakeFs = {
      readFileSync(f) { if (!disk.has(f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return disk.get(f); },
      writeFileSync(f, d) { disk.set(f, d); }, renameSync(a, b) { disk.set(b, disk.get(a)); disk.delete(a); },
      existsSync(f) { return disk.has(f); }, mkdirSync() {}, unlinkSync(f) { disk.delete(f); }, openSync() { return 1; }, fsyncSync() {}, closeSync() {}
    };
    const store = makeTaskBriefStore({ fs: fakeFs, path, workspaces: '/ws', writeDurable: ({ fs }, file, data) => fs.writeFileSync(file, data) });
    let clock = 100;
    // one run of the host: prepare() routes the person's words onto the brief of this conversation (a new task, or the
    // answer to its open question), then the run gets its own per-run state and its own brief tools, as index.js does
    async function startRun(key, words, live) {
      const brief = await store.prepare({ id: 'tb_' + key, key: 'stream:' + key, text: words }, ++clock);
      const state = { brief }, tools = {};
      registerTaskBriefTools({ register: t => { tools[t.name] = t; } }, store, state,
        Object.assign({ now: () => ++clock }, live ? { askCommander: async () => ({ answered: true, text: live }) } : {}));
      return { state, hold: c => noteHeldCall(state, c), ask: () => tools['brief.ask'].run(ASK), settle: async () => (await tools['brief.proceed'].run(SETTLE)).content };
    }

    // ---- V4: "No" on the LIVE card, in the same run. The held call is a fact, not an order (red on 8ca33b1a6) ----
    {
      const r = await startRun('v4', 'Replace the note file with new content', 'No, keep it');
      r.hold(WRITE);
      const asked = await r.ask();
      A.ok(/The Commander answered "No, keep it"/.test(asked.content), 'V4 rig: the live card answered in this run');
      const out = await r.settle();
      A.ok(out.indexOf(BASE) === 0, 'V4: the settle still opens with the unlocked line');
      A.ok(!ORDER.test(out), 'V4: after a "No" on the live card the settle does NOT order the held call: ' + JSON.stringify(out));
      A.eq(out, BASE + '\nThis call was held by the brief before the Commander answered your question, and did not run:\n' + WRITE_ROW + '\n' + OWED_ONE,
        'V4: it states the fact (held before the answer, did not run), with the call\'s own args, and that it is owed only if the task still calls for it');
    }
    // ---- the question path: the question ended the run, the "No" comes in a LATER run (red on 8ca33b1a6) ----
    for (const [key, answer] of [['no', 'No, keep it. Do not write anything.'], ['changed', 'Actually just tell me what 2 plus 2 is.'], ['yes', 'Yes, replace it']]) {
      const r1 = await startRun(key, 'Replace the note file with new content');
      r1.hold(WRITE);
      const asked = await r1.ask();
      A.eq(asked.control && asked.control.final, true, key + ' rig: with nobody at the card the question ends the run');
      A.eq(store.active('stream:' + key).heldCalls, ['fs_write'], key + ' rig: the held name is kept on the brief across the question');
      const r2 = await startRun(key, answer);
      A.eq(r2.state.brief.id, 'tb_' + key, key + ' rig: the reply is the answer on the same brief');
      const out = await r2.settle();
      A.ok(!ORDER.test(out), key + ': the settle after the answer does NOT order the call the brief held before the question: ' + JSON.stringify(out));
      A.eq(out, BASE + '\nThis call was held by the brief before your question to the Commander, and did not run:\n- fs_write\n' + OWED_ONE,
        key + ': it says the call was held before the question and did not run (so a "yes" still hears it has not run), owed only if the task still calls for it');
      A.ok(!('heldCalls' in store.active('stream:' + key)), key + ': the settle still clears the kept names');
      A.eq(await r2.settle().catch(e => 'refused: ' + e.message), BASE, key + ': a second settle never repeats them');
    }
    // ---- two calls held before the question: plural, both named, one condition ----
    {
      const r1 = await startRun('two', 'Replace the note file and run it');
      r1.hold(WRITE); r1.hold(SHELL);
      await r1.ask();
      const out = await (await startRun('two', 'No, keep it')).settle();
      A.eq(out, BASE + '\nThese calls were held by the brief before your question to the Commander, and did not run:\n- fs_write\n- shell_exec\n' + OWED_MANY, 'two held calls: plural wording, no order');
    }
    // ---- CONTROLS: where NO answer came between the hold and the settle, the #187 words stay (green on 8ca33b1a6 too) ----
    {
      // the answer run makes the held call again FIRST (held again, after the answer), then settles: named once, as an order
      const a1 = await startRun('made', 'Replace the note file with new content');
      a1.hold(WRITE); await a1.ask();
      const a2 = await startRun('made', 'Yes, replace it');
      a2.hold(WRITE);
      A.eq(await a2.settle(), BASE + '\nNothing has run yet: the call the brief held must be made again now, in this same turn, before you report any result:\n' + WRITE_ROW,
        'made-again control: a call held AFTER the answer keeps the #187 words, and its kept name is not listed twice');
      // the live card says yes and the model makes the call again before it settles: the hold is after the answer
      const b = await startRun('live-yes', 'Replace the note file with new content', 'Yes, replace it');
      b.hold(WRITE); await b.ask(); b.hold(WRITE);
      A.eq(await b.settle(), BASE + '\nNothing has run yet: the call the brief held must be made again now, in this same turn, before you report any result:\n' + WRITE_ROW,
        'live-yes control: the same call held again after the live answer keeps the #187 words, listed once');
      // a question answered BEFORE the hold (an earlier run's answer) is not an answer between the hold and the settle
      const c1 = await startRun('asked-first', 'Replace the note file with new content');
      await c1.ask();
      const c2 = await startRun('asked-first', 'Yes, replace it');
      c2.hold(WRITE);
      A.ok(/^Task Brief settled\. Consequential tools are unlocked\.\nNothing has run yet: the call the brief held must be made again now/.test(await c2.settle()),
        'asked-first control: an answer given before the hold changes nothing');
    }
    // ---- MIXED: one call held after the answer (still an order), one kept from before the question (a fact) ----
    {
      const r1 = await startRun('mixed', 'Replace the note file and run it');
      r1.hold(WRITE); r1.hold(SHELL); await r1.ask();
      const r2 = await startRun('mixed', 'Yes, replace it, but do not run it');
      r2.hold(WRITE);
      A.eq(await r2.settle(), BASE + '\nNothing has run yet: the call the brief held must be made again now, in this same turn, before you report any result:\n' + WRITE_ROW
        + '\nThis call was held by the brief before your question to the Commander, and did not run:\n- shell_exec\n' + OWED_ONE,
        'mixed: the call the model made after the answer is ordered; the one it did not make again is a fact with its condition');
      // ...and in ONE run: a call held before the live answer and a different call held after it
      const l = await startRun('mixed-live', 'Replace the note file and run it', 'Yes, but do not run it');
      l.hold(SHELL); await l.ask(); l.hold(WRITE);
      A.eq(await l.settle(), BASE + '\nNothing has run yet: the call the brief held must be made again now, in this same turn, before you report any result:\n' + WRITE_ROW
        + '\nThis call was held by the brief before the Commander answered your question, and did not run:\n- shell_exec {"cmd":"python note.py"}\n' + OWED_ONE,
        'mixed, one run: held after the live answer = ordered; held before it = a fact with its condition');
    }
  }
  // ---- the gate records what it holds: index.js briefHoldFor calls noteHeldCall on the held path only ----
  {
    const src = H.readSidecarIndex();
    A.ok(/const \{ registerTaskBriefTools, noteHeldCall \} = require\('\.\/taskbrief-tools\.js'\)/.test(src), 'index.js imports noteHeldCall');
    const fn = /const briefHoldFor = \(c, liveTool\) => \{[\s\S]*?\n  \};/.exec(src);
    A.ok(fn, 'briefHoldFor is found');
    const body = fn ? fn[0] : '';
    const note = body.indexOf('if (!gate.ok) noteHeldCall(taskBriefState, c);'), hold = body.indexOf('if (!gate.ok) return { ok: false');
    A.ok(note > 0 && hold > note, 'a held call is recorded right before the hold returns');
    A.ok(note > body.indexOf('looksOnly('), 'a read-only shell look that is let through is never recorded');
  }
  A.report('taskbrief.held-again');
})().catch(e => { console.error(e); process.exit(1); });
