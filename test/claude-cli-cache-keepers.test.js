/* node test/claude-cli-cache-keepers.test.js — CACHE KEEPERS (cost audit lane W1.9, 2026-11-08).

   A. THE REPLACEMENT CHILD READS ITS SYSTEM PROMPT AFTER A REVEAL. A Claude Code run keeps one persistent `claude` child
      (providers/claude-cli.js PERSISTENT CHILD). A reveal (tool_search, or a starter's result bringing back its dormant
      follow-up controls, lane W1.3) is announced to the live child in that turn's message; the tool list in its system
      prompt stays as the run started it. When that child is then replaced (it wrote past its call block, an earlier
      message changed, a crash), the replacement was started on the CURRENT tool list: its first system block differed
      from the one the run's first child had cached, so its first request wrote the whole system prompt again (~23.5k
      tokens at the CLI's 2x one-hour rate; the audit measured the warm child reading 0 and writing 25,336). Now every
      replacement is started on the run-start tool list, byte for byte, and the tools revealed since are announced in its
      first message the way the live child was told. A withdrawn or changed run-start tool cannot be told by a note, so
      that child starts on the current list (never a tool that is no longer offered), and later replacements keep it.
   B. NO SCREENSHOT EVICTION INSIDE A LIVE CHILD. The loop ages old screen captures out of what it sends. On claude-cli
      each eviction changed an earlier message, so the live child was closed and the whole run transcript re-rendered
      and re-written at the CLI write rate: every capture after the second cost a fresh child. A provider that holds the
      conversation in a live child (holdsHistory) now gets every capture, as the child already holds them, and the
      loop's context meter measures that same view.
   C. STEPPED EVICTION ON HTTP ROUTES. Elsewhere captures age out in batches, a pure function of the capture count:
      the request prefix changes at a step only, never at every capture after the second.

   Hermetic: EventEmitter children stand in for `claude` (no process, no model), a replay provider for HTTP. */
'use strict';
const A = require('./_assert.js');
const { EventEmitter } = require('events');
const { makeClaudeCliProvider } = require('../sidecar/providers/claude-cli.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals: loopInternals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const Followups = require('../sidecar/capability/followups.js');

/* ---- the fake CLI: records each child's system prompt FILE (the bytes the CLI caches) and every stdin message ---- */
function rig(script, extra) {
  const spawns = [], files = {};
  let turn = 0;   // loop turns are sequential: one counter across every child of the run
  function spawn(file, args, opts) {
    const child = new EventEmitter();
    const pipe = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = pipe(); child.stderr = pipe();
    child.pid = 7100 + spawns.length; child.exitCode = null;
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    if (file === 'taskkill') {
      const target = spawns.find(r => String(r.child.pid) === args[1]);
      if (target) target.child.kill();
      setImmediate(() => exit(0));
      child.kill = () => exit(null);
      return child;
    }
    const at = args.indexOf('--system-prompt-file');
    const rec = { args, opts, inputs: [], child, system: at >= 0 ? files[args[at + 1]] : null };
    spawns.push(rec);
    child.kill = () => exit(null);
    const out = l => { if (child.exitCode == null) child.stdout.emit('data', JSON.stringify(l) + '\n'); };
    child.stdin = {
      on() {},
      write(line) {
        rec.inputs.push(JSON.parse(line));
        const n = rec.inputs.length, g = ++turn;
        setImmediate(() => { if (child.exitCode == null) for (const l of (script({ rec, n, g, index: spawns.indexOf(rec) }) || [])) out(l); });
        return true;
      },
      end() { setImmediate(() => exit(0)); }
    };
    return child;
  }
  const fs = { statSync() { return { isFile: () => true }; }, writeFileSync(p, d) { files[p] = String(d); }, unlinkSync() {} };
  const p = makeClaudeCliProvider(Object.assign({ spawn, fs, bin: 'claude.exe', env: { PATH: '' }, platform: 'win32', persistEndGraceMs: 50 }, extra || {}));
  return { p, spawns };
}
const init = () => ({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const result = text => ({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0,
  usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 } });
const invoke = (name, args) => '<function_calls>\n<invoke name="' + name + '">\n' + Object.keys(args || {}).map(k => '<parameter name="' + k + '">' + args[k] + '</parameter>\n').join('') + '</invoke>\n</function_calls>';
const says = text => [init(), delta(text), result(text)];                                  // a reply that ends on its own
const guesses = text => [init(), delta(text), delta('\n\nThe file probably says hi.')];     // writes on past its block: closed

const fn = (name, description, properties) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: properties || {} } } });
const READ = fn('fs_read', 'read a file', { path: { type: 'string' } });
const WRITE = fn('fs_write', 'write a file', { path: { type: 'string' }, content: { type: 'string' } });
const LIST = fn('fs_list', 'list a folder', { path: { type: 'string' } });
const lineOf = d => '- ' + d.function.name + ': ' + d.function.description + '\n  parameters: ' + JSON.stringify(d.function.parameters);
const noteOf = defs => '<system_note>\nMore tools are now available. Call them exactly like the tools listed in your instructions:\n' + defs.map(lineOf).join('\n') + '\n</system_note>';
const SYS = { role: 'system', content: 'You are the test agent.' };

async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
function reply(evs) {   // the reply as loop.js records it
  const calls = {};
  for (const e of evs) {
    if (e.type === 'tool_start') calls[e.index] = { id: e.id, type: 'function', function: { name: e.name, arguments: '' } };
    else if (e.type === 'tool_args') calls[e.index].function.arguments += e.chunk;
  }
  const m = { role: 'assistant', content: evs.filter(e => e.type === 'text').map(e => e.delta).join('') };
  const tc = Object.keys(calls).sort((a, b) => a - b).map(k => calls[k]);
  if (tc.length) m.tool_calls = tc;
  return m;
}
const results = (m, body) => m.tool_calls.map(c => ({ role: 'tool', tool_call_id: c.id, content: body }));
const blocksOf = msg => (msg && msg.message ? msg.message.content : []);
const lastText = msg => { const b = blocksOf(msg).filter(x => x.type === 'text'); return b.length ? b[b.length - 1].text : ''; };
const toolsBlock = sys => String(sys || '').slice(String(sys || '').indexOf('# Tools'), String(sys || '').indexOf('# Conversation'));

(async () => {
  // ---- A1. DONE MEANS: a reveal is announced to the live child; that child then writes past its block and is
  //          replaced by a WARM child. The warm child starts on the run-start system prompt, byte for byte. ----
  {
    const { p, spawns } = rig(({ index, n }) => {
      if (index === 0) return n === 1 ? says(invoke('fs_read', { path: 'a.txt' })) : guesses(invoke('fs_read', { path: 'b.txt' }));
      return n === 1 ? says(invoke('fs_write', { path: 'out.txt', content: 'hello' })) : says('Done.');
    });
    const ac = new AbortController();
    const req = (msgs, tools) => ({ model: 'sonnet', tools, messages: msgs.slice(), runId: 'run-a1', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt and b.txt, then write out.txt.' }];
    const r1 = reply(await collect(p, req(msgs, [READ]))); msgs.push(r1, ...results(r1, 'alpha (tool_search found fs_write)'));
    const r2 = reply(await collect(p, req(msgs, [READ, WRITE]))); msgs.push(r2, ...results(r2, 'beta'));
    A.eq(lastText(spawns[0].inputs[1]), noteOf([WRITE]), 'A1: the live child is told about the revealed tool in the turn that reveals it');
    A.eq(p.persistStats().closed.overrun, 1, 'A1: the child that wrote past its block is closed');
    const t3 = await collect(p, req(msgs, [READ, WRITE]));
    A.eq([spawns.length, p.persistStats().fresh.warm], [2, 1], 'A1: the next turn rides the WARM replacement');
    A.ok(spawns[0].system && spawns[0].system.length > 100, 'A1: the run-start child was given a real system prompt file');
    A.ok(spawns[1].system === spawns[0].system,
      'A1: THE WARM CHILD\'S SYSTEM PROMPT IS THE RUN-START ONE, BYTE FOR BYTE (its first request reads it from cache); tools block now ' + JSON.stringify(toolsBlock(spawns[1].system).slice(-120)));
    A.ok(toolsBlock(spawns[1].system).indexOf('- fs_write:') < 0, 'A1: the revealed tool is not in the replacement\'s system prompt');
    A.eq(lastText(spawns[1].inputs[0]), noteOf([WRITE]), 'A1: it is announced at the end of the replacement\'s first message instead');
    A.ok(blocksOf(spawns[1].inputs[0])[0].text.startsWith('<user>\nRead a.txt and b.txt'), 'A1: which still opens with the whole history');
    const call = t3.find(e => e.type === 'tool_start');
    A.eq([call && call.name, JSON.parse(t3.filter(e => e.type === 'tool_args').map(e => e.chunk).join('') || '{}')], ['fs_write', { path: 'out.txt', content: 'hello' }],
      'A1: the revealed tool is callable on the replacement');
    p.release('run-a1');
  }

  // ---- A2. THE REVEAL LANDS AFTER THE WARM CHILD STARTED (the overrun turn's own result revealed it): the warm child
  //          still fits, so it is used, not thrown away for a third child on a new system prompt. ----
  {
    const { p, spawns } = rig(({ index, n }) => (index === 0 && n === 1 ? guesses(invoke('fs_read', { path: 'a.txt' })) : says('Done.')));
    const ac = new AbortController();
    const req = (msgs, tools) => ({ model: 'sonnet', tools, messages: msgs.slice(), runId: 'run-a2', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt.' }];
    const r1 = reply(await collect(p, req(msgs, [READ]))); msgs.push(r1, ...results(r1, 'alpha'));
    A.eq(p.persistStats().prewarmed, 1, 'A2: a warm replacement is started while the loop runs the tool');
    await collect(p, req(msgs, [READ, WRITE]));
    const used = spawns.filter(s => s.inputs.length).pop();
    A.eq([spawns.length, p.persistStats().fresh.warm, p.persistStats().closed.warm_unused], [2, 1, undefined],
      'A2: the warm child is used after a reveal it did not see (it used to be closed unused and a third child started)');
    A.ok(used && used.system === spawns[0].system, 'A2: the child that answers has the run-start system prompt, byte for byte');
    A.eq(lastText(used && used.inputs[0]), noteOf([WRITE]), 'A2: and is told about the revealed tool in its first message');
    p.release('run-a2');
  }

  // ---- A3. A FRESH (not warm) REPLACEMENT after a reveal: an earlier message changed, so the child holds the wrong
  //          history. The fresh child keeps the run-start system prompt too. ----
  {
    const { p, spawns } = rig(({ index, n }) => (index === 0 ? says(invoke('fs_read', { path: n === 1 ? 'a.txt' : 'b.txt' })) : says('Done.')));
    const ac = new AbortController();
    const req = (msgs, tools) => ({ model: 'sonnet', tools, messages: msgs.slice(), runId: 'run-a3', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r1 = reply(await collect(p, req(msgs, [READ]))); msgs.push(r1, ...results(r1, 'alpha'));
    const r2 = reply(await collect(p, req(msgs, [READ, WRITE]))); msgs.push(r2, ...results(r2, 'beta'));
    msgs[3] = Object.assign({}, msgs[3], { content: '[older tool result cleared to save context]' });
    await collect(p, req(msgs, [READ, WRITE]));
    A.eq([spawns.length, p.persistStats().fresh.history], [2, 1], 'A3: an edited earlier message starts a fresh child');
    A.ok(spawns[1].system === spawns[0].system, 'A3: the fresh child\'s system prompt is the run-start one, byte for byte');
    A.eq(lastText(spawns[1].inputs[0]), noteOf([WRITE]), 'A3: the revealed tool is announced at the end of its first message');
    p.release('run-a3');
  }

  // ---- A4. HONESTY: a run-start tool withdrawn (or changed) cannot be told by a note. That child starts on the current
  //          list, never naming a tool that is no longer offered, and the run's later replacements keep ITS prompt. ----
  {
    const { p, spawns } = rig(({ index, n }) => {
      if (index === 0) return says(invoke('fs_read', { path: 'a.txt' }));
      if (index === 1) return says(invoke('fs_read', { path: n === 1 ? 'b.txt' : 'c.txt' }));
      return says('Done.');
    });
    const ac = new AbortController();
    const req = (msgs, tools) => ({ model: 'sonnet', tools, messages: msgs.slice(), runId: 'run-a4', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a, b and c.' }];
    const r1 = reply(await collect(p, req(msgs, [READ, WRITE]))); msgs.push(r1, ...results(r1, 'alpha'));
    const r2 = reply(await collect(p, req(msgs, [READ]))); msgs.push(r2, ...results(r2, 'beta'));
    A.eq([spawns.length, p.persistStats().fresh.tools], [2, 1], 'A4: a withdrawn tool starts a fresh child');
    A.ok(toolsBlock(spawns[1].system).indexOf('- fs_write:') < 0 && toolsBlock(spawns[1].system).indexOf('- fs_read:') >= 0,
      'A4: its system prompt lists only what is still offered (never the withdrawn tool)');
    A.ok(blocksOf(spawns[1].inputs[0]).every(b => !/More tools are now available/.test(b.text || '')), 'A4: and no note announces anything');
    const r3 = reply(await collect(p, req(msgs, [READ, LIST]))); msgs.push(r3, ...results(r3, 'gamma'));
    A.eq(lastText(spawns[1].inputs[1]), noteOf([LIST]), 'A4: a later reveal is announced to that child');
    msgs[3] = Object.assign({}, msgs[3], { content: '[older tool result cleared to save context]' });
    await collect(p, req(msgs, [READ, LIST]));
    A.eq(spawns.length, 3, 'A4: an edited earlier message starts a third child');
    A.ok(spawns[2].system === spawns[1].system && spawns[2].system !== spawns[0].system,
      'A4: the third child keeps the prompt of the child that replaced the withdrawn tool, byte for byte');
    A.eq(lastText(spawns[2].inputs[0]), noteOf([LIST]), 'A4: and is told about the later reveal');
    p.release('run-a4');
  }

  // ---- A5. THE REAL LOOP, A W1.3 STARTER: terminal.start's result reveals its dormant controls (capability/followups.js);
  //          the live child is told, then writes past its block; the warm replacement keeps the run-start prompt and
  //          the revealed control it was asked for still runs. ----
  {
    const wire = n => n.replace(/\./g, '_');
    const controls = Followups.revealFor('terminal');
    const START = fn('terminal_start', 'Start a terminal session.', { command: { type: 'string' } });
    const CONTROL_DEFS = controls.map(n => fn(wire(n), 'Terminal control ' + n + '.', { id: { type: 'string' } }));
    const reg = makeRegistry(), ran = [];
    reg.register({ impact: 'none', name: 'terminal_start', schema: START.function.parameters,
      run: async a => { ran.push('terminal_start'); return { content: 'terminal t1 started: ' + a.command, summary: 'started', control: { revealTools: controls.slice() } }; } });
    for (const d of CONTROL_DEFS) reg.register({ impact: 'none', name: d.function.name, schema: d.function.parameters, run: async () => { ran.push(d.function.name); return 'running'; } });
    const { p, spawns } = rig(({ g }) => {
      if (g === 1) return says(invoke('terminal_start', { command: 'npm run dev' }));
      if (g === 2) return guesses(invoke('terminal_status', { id: 't1' }));
      return says('The dev server is running.');
    });
    const ac = new AbortController();
    const res = await runAgentLoop({
      messages: [SYS, { role: 'user', content: 'Start the dev server and check it.' }], provider: p, emit: makeEmitter(A.makeBus(), () => {}),
      cost: makeCostEngine({ priceOf: () => null }), model: 'sonnet', agentId: 'a', runId: 'run-a5', tools: [START], deferredTools: CONTROL_DEFS,
      limits: { maxIters: 6, grace: false }, signal: ac.signal, dispatch: (c, ctx) => reg.dispatch(c, ctx),
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', signal: ac.signal }, clock: { now: () => 0 }
    });
    A.eq([res.reason, ran], ['done', ['terminal_start', 'terminal_status']], 'A5: the loop started the terminal, then ran the control it revealed: ' + res.reason);
    A.eq(lastText(spawns[0].inputs[1]), noteOf(CONTROL_DEFS), 'A5: the live child was told about every revealed control');
    A.eq([spawns.length, p.persistStats().fresh.warm], [2, 1], 'A5: the turn after the overrun rode the warm replacement');
    A.ok(spawns[1] && spawns[1].system === spawns[0].system, 'A5: the warm child\'s system prompt is the run-start one, byte for byte');
    A.eq(lastText(spawns[1] && spawns[1].inputs[0]), noteOf(CONTROL_DEFS), 'A5: and its first message announces the revealed controls');
  }

  // ---- B. NO SCREENSHOT EVICTION INSIDE A LIVE CHILD (real loop): five captures ride ONE child, and the context
  //         meter measures the captures the child really holds. ----
  {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const SHOT = fn('screen_capture', 'Capture the screen.', {});
    const reg = makeRegistry();
    let shots = 0;
    reg.register({ impact: 'none', name: 'screen_capture', schema: SHOT.function.parameters,
      run: async () => { shots++; return { content: 'Captured screen ' + shots, summary: 'shot', images: [{ mime: 'image/png', data: PNG.slice(0, -4) + 'AAA' + String.fromCharCode(64 + shots) + '==' }] }; } });
    const { p, spawns } = rig(({ g }) => says(g <= 5 ? invoke('screen_capture', {}) : 'Seen all five.'));
    const seen = [];
    const imagesIn = msgs => msgs.reduce((k, m) => k + (Array.isArray(m.content) ? m.content.filter(x => x && x.type === 'image_url').length : 0), 0);
    const context = { estimateMessages: msgs => { seen.push(imagesIn(msgs)); return 1000; }, shouldCompact: () => false, thresholdTokens: () => 0 };
    const ac = new AbortController();
    const res = await runAgentLoop({
      messages: [SYS, { role: 'user', content: 'Watch the screen.' }], provider: p, emit: makeEmitter(A.makeBus(), () => {}),
      cost: makeCostEngine({ priceOf: () => null }), model: 'sonnet', agentId: 'a', runId: 'run-b', tools: [SHOT], toolImages: true, context,
      limits: { maxIters: 10, grace: false }, signal: ac.signal, dispatch: (c, ctx) => reg.dispatch(c, ctx),
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', signal: ac.signal }, clock: { now: () => 0 }
    });
    A.eq([res.reason, shots], ['done', 5], 'B: the run took five captures and finished: ' + res.reason);
    A.eq([spawns.length, p.persistStats().fresh.history], [1, undefined], 'B: ONE child for the whole run: no capture forced a fresh one');
    const sentImages = spawns.reduce((k, s) => k + s.inputs.reduce((j, msg) => j + blocksOf(msg).filter(b => b.type === 'image').length, 0), 0);
    A.eq(sentImages, 5, 'B: each capture crossed the pipe once, as an image block');
    A.eq(Math.max.apply(null, seen.concat([0])), 5, 'B: the context meter counted all five captures the child holds');
  }

  // ---- C. STEPPED EVICTION ON HTTP ROUTES: twelve captures, keep 2. The view changes an earlier capture only at a step,
  //         never more than keep + step captures ride as pixels, and the view is a pure function of the capture count. ----
  {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const N = 12;
    const turns = [];
    for (let i = 0; i < N; i++) turns.push([{ type: 'tool_start', index: 0, id: 's' + i, name: 'browser_screenshot' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }]);
    turns.push([{ type: 'text', delta: 'done looking' }, { type: 'done', finishReason: 'stop' }]);
    const replay = makeReplayProvider({ turns });
    const requests = [];
    const provider = Object.assign({}, replay, { stream: req => { requests.push(req.messages.slice()); return replay.stream(req); } });
    const reg = makeRegistry();
    let k = 0;
    reg.register({ impact: 'none', name: 'browser_screenshot', schema: { type: 'object', properties: {} },
      run: async () => { k++; return { content: 'Screenshot ' + k, summary: 'shot', images: [{ mime: 'image/png', data: PNG.slice(0, -4) + 'AAA' + String.fromCharCode(64 + k) + '==' }] }; } });
    const messages = [{ role: 'user', content: 'look at the page' }];
    const res = await runAgentLoop({ messages, provider, emit: makeEmitter(A.makeBus(), () => {}), cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], limits: { maxIters: 20, grace: false },
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, toolImages: true });
    A.eq([res.reason, requests.length], ['done', N + 1], 'C: the run completes (' + N + ' capture turns + the answer)');
    const pixels = msgs => msgs.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(x => x && x.type === 'image_url')).length;
    const rewrites = [];   // requests whose view replaced a capture the previous request sent as pixels
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1];
      if (prev.some((m, j) => Array.isArray(m.content) && m.content.some(x => x && x.type === 'image_url') && typeof requests[i][j].content === 'string')) rewrites.push(i);
    }
    A.eq(rewrites, [7, 12], 'C: earlier captures leave the view in two steps (at captures 7 and 12), not at every capture after the second');
    A.ok(requests.every(r => pixels(r) <= 6), 'C: no request carries more than keep + step = 6 captures as pixels (max ' + Math.max.apply(null, requests.map(pixels)) + ')');
    A.eq(pixels(requests[N]), 2, 'C: right after a step only the newest keep = 2 stay as pixels');
    const ph = requests[N].filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.indexOf('[earlier screen capture removed from view') === 0);
    A.ok(ph.length === 10 && ph.every(m => /Only the most recent screen captures stay visible as pixels/.test(m.content)), 'C: the placeholders say what is true between steps');
    A.eq(requests[N - 1].filter(m => typeof m.content === 'string' && m.content.indexOf('[earlier screen capture removed') === 0)[0].content, ph[0].content, 'C: an evicted capture\'s placeholder is byte-stable');
    const again = loopInternals.evictStaleScreenshots(JSON.parse(JSON.stringify(messages.slice(0, -1))), 2, null, 4);
    A.eq(again.map(m => typeof m.content === 'string' && /removed from view/.test(m.content)), requests[N].map(m => typeof m.content === 'string' && /removed from view/.test(m.content)),
      'C: a recovered copy of the same messages evicts exactly the same captures (a pure function of the capture count)');
  }

  A.report('claude-cli-cache-keepers.test');
})().catch(e => { console.log('FAIL: claude-cli-cache-keepers.test threw -- ' + (e && e.stack || e)); process.exit(1); });
