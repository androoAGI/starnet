/* node test/taskbrief.held-again.test.js — THE HELD CALL IS MADE AGAIN (#187, 2026-11-14).

   The Task Brief gate held [fs_write hello.py, shell_exec python hello.py] ("nothing ran"), qwen3:8b settled the brief with
   brief_proceed, got back only "Task Brief settled. Consequential tools are unlocked.", and answered "hello.py has been
   created and executed" with no file on disk (live wire capture, cand-0152 scratch station). The gate now records each call
   it holds and the settle names them. This pins the settle's reply and the gate's wiring in index.js. */
'use strict';
const A = require('./_assert.js');
const { registerTaskBriefTools, noteHeldCall } = require('../sidecar/taskbrief-tools.js');
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
