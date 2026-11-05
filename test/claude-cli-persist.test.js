/* node test/claude-cli-persist.test.js — the Claude Code provider keeps ONE `claude` child per run (2026-10-12).

   Before: every model turn spawned a fresh `claude -p` and re-sent the whole history as one text block (CLI start-up
   on every turn; a block that grows never hits the previous turn's prompt cache). Now an agent-loop turn rides one
   persistent `--input-format stream-json` child and sends only what StarNet added since the last turn — and falls back
   to a fresh child with the full history whenever what the child holds is not provably StarNet's history.
   A fake CLI stands in for `claude` (no real process is spawned); it speaks the stream-json protocol the real CLI
   2.1.284 was observed to speak (scratchpad cli-persist/exp-*.log): one `result` line per user line, usage per turn,
   total_cost_usd as a running total, exit when stdin closes. */
'use strict';
const A = require('./_assert.js');
const { EventEmitter } = require('events');
const { makeClaudeCliProvider, _internals } = require('../sidecar/providers/claude-cli.js');
const provider = require('../sidecar/providers/provider.js');

function fakeCli(script) {
  const spawns = [];
  function spawn(file, args, opts) {
    const child = new EventEmitter();
    const pipe = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = pipe(); child.stderr = pipe();
    child.pid = 7000 + spawns.length; child.exitCode = null;
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    if (file === 'taskkill') {
      const target = spawns.find(r => String(r.child.pid) === args[1]);
      // treeKilledOpen: taskkill /T reached the child while it was alive with stdin still open (it walks a LIVE tree)
      if (target) { target.treeKilled = true; target.treeKilledOpen = target.child.exitCode == null && !target.ended; target.child.kill(); }
      setImmediate(() => exit(0));
      child.kill = () => exit(null);
      return child;
    }
    const rec = { file, args, opts, inputs: [], killed: false, treeKilled: false, ended: false, child };
    spawns.push(rec);
    child.kill = () => { rec.killed = true; exit(null); };
    const emit = l => { if (child.exitCode == null) child.stdout.emit('data', (typeof l === 'string' ? l : JSON.stringify(l)) + '\n'); };
    const answer = (n, msg) => setImmediate(() => {
      if (child.exitCode != null) return;
      const s = script(rec, n, msg) || {};
      for (const l of s.lines || []) emit(l);
      if (s.crash != null) { if (s.stderr) child.stderr.emit('data', s.stderr); exit(s.crash); }
    });
    child.stdin = {
      on() {},
      write(line) { const msg = JSON.parse(line); rec.inputs.push(msg); answer(rec.inputs.length, msg); return true; },
      // one-shot (kill switch off): the whole prompt arrives on stdin, then the child answers once and exits
      end(text) {
        rec.ended = true;
        if (text) { rec.stdinText = text; const s = script(rec, 1, { text }) || {}; setImmediate(() => { for (const l of s.lines || []) emit(l); exit(0); }); }
        else setImmediate(() => exit(0));
      }
    };
    return child;
  }
  return { spawn, spawns };
}
const fakeFs = { statSync() { return { isFile: () => true }; }, writeFileSync() {}, unlinkSync() {} };
const make = (script, extra) => {
  const f = fakeCli(script);
  const p = makeClaudeCliProvider(Object.assign({ spawn: f.spawn, fs: fakeFs, bin: 'claude.exe', env: { PATH: '' }, platform: 'win32', persistEndGraceMs: 200 }, extra || {}));
  return { p, spawns: f.spawns };
};
const init = src => ({ type: 'system', subtype: 'init', apiKeySource: src || 'none', tools: [] });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const start = usage => ({ type: 'stream_event', event: { type: 'message_start', message: { usage } } });
const result = (text, extra) => Object.assign({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0,
  usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 } }, extra || {});
const block = path => '<function_calls>\n<invoke name="fs_read">\n<parameter name="path">' + path + '</parameter>\n</invoke>\n</function_calls>';
// a model that asks for a file, then (once it has a result) answers: it ends its own reply right after the block
const reader = (rec, n) => {
  const text = n === 1 ? 'Reading.\n\n' + block('a.txt') : (n === 2 ? block('b.txt') : 'Both files read.');
  return { lines: [init(), start({ input_tokens: 3 }), delta(text), result(text)] };
};
const TOOLS = [{ type: 'function', function: { name: 'fs_read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const SYS = { role: 'system', content: 'You are the test agent.' };

async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
// the reply as loop.js records it (assistantTurn): the streamed text + the calls in index order
function reply(evs) {
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
const textIn = msg => (msg.message ? msg.message.content : []).filter(b => b.type === 'text').map(b => b.text).join('');
const tick = ms => new Promise(r => setTimeout(r, ms || 0));

(async () => {
  // 1. REUSE + DELTA-ONLY: three loop turns ride ONE child; the 2nd and 3rd send only the new tool results.
  {
    const { p, spawns } = make(reader);
    const ac = new AbortController();
    const req = msgs => ({ model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-1', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const t1 = await collect(p, req(msgs));
    A.eq(t1.filter(e => e.type === 'tool_start').map(e => e.name), ['fs_read'], 'turn 1 asks for a tool');
    A.eq(t1.find(e => e.type === 'done').finishReason, 'tool_calls', 'turn 1 ends as tool_calls');
    const r1 = reply(t1); msgs.push(r1, ...results(r1, 'alpha'));
    const t2 = await collect(p, req(msgs));
    const r2 = reply(t2); msgs.push(r2, ...results(r2, 'beta'));
    const t3 = await collect(p, req(msgs));
    A.eq(t3.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Both files read.', 'turn 3 answers');
    A.eq(spawns.length, 1, 'three turns, ONE claude child (it used to be three)');
    const args = spawns[0].args;
    A.ok(args.join(' ').includes('--input-format stream-json') && args.indexOf('--no-session-persistence') >= 0, 'the child reads stream-json and still keeps no session file');
    A.eq(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', ''], 'every CLI tool stays off');
    A.ok(args.indexOf('--strict-mcp-config') >= 0 && args[args.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}' && args.indexOf('--disable-slash-commands') >= 0 &&
      args[args.indexOf('--setting-sources') + 1] === '', 'the same isolation flags as a one-shot turn');
    A.eq(spawns[0].opts.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'auto-memory stays off');
    A.eq(spawns[0].opts.env.DISABLE_PROMPT_CACHING, undefined, 'the persistent child keeps the prompt cache (its next turns read it back)');
    const ins = spawns[0].inputs.map(textIn);
    A.eq(ins.length, 3, 'one user line per turn');
    A.eq(spawns[0].inputs[0].message.content, [{ type: 'text', text: '<user>\nRead a.txt and b.txt.\n</user>' }], 'turn 1 sends the opening request as one tagged block (the PROMPT CACHE blocks)');
    A.eq(spawns[0].inputs[1].message.content, [{ type: 'text', text: '<tool_result id="' + r1.tool_calls[0].id + '">\nalpha\n</tool_result>' }], 'turn 2 sends ONLY the new tool result, one block');
    A.ok(!ins[2].includes('Read a.txt') && !ins[2].includes('alpha') && ins[2].includes('beta'), 'turn 3 sends only what turn 2 added');
    A.eq(p.persistStats().reused, 2, 'stats: two turns reused the child');
    A.ok(!spawns[0].killed && spawns[0].child.exitCode == null, 'the child is parked between turns, not killed');
    p.release('other-run');
    A.ok(spawns[0].child.exitCode == null, 'release() for another run leaves this child alone');
    p.release('run-1');
    A.ok(spawns[0].treeKilled, 'release() at run end kills the child\'s process tree');
    await tick(5);   // the taskkill attempt finishes
    A.ok(spawns[0].treeKilledOpen && spawns[0].ended, 'the tree is killed BEFORE stdin closes (EOF would let the CLI exit first and orphan its helpers), then stdin closes');
    A.eq(p.persistStats().live, false, 'no child is left after the run');
  }

  // 2. FALLBACK ON A HISTORY MISMATCH: an edited earlier message (compaction), an edited reply (a call the loop
  //    dropped), and a model switch each close the child and start a fresh one from the WHOLE history.
  {
    const { p, spawns } = make(reader);
    const ac = new AbortController();
    const req = (msgs, model) => ({ model: model || 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-2', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r1 = reply(await collect(p, req(msgs))); msgs.push(r1, ...results(r1, 'alpha'));
    const r2 = reply(await collect(p, req(msgs))); msgs.push(r2, ...results(r2, 'beta'));
    A.eq(spawns.length, 1, 'turn 2 rode the child');
    // micro-compaction cleared the oldest tool result in place
    msgs[3] = Object.assign({}, msgs[3], { content: '[older tool result cleared to save context]' });
    await collect(p, req(msgs));
    A.eq(spawns.length, 2, 'an edited earlier message starts a fresh child');
    A.ok(spawns[0].treeKilled, 'the stale child is killed (tree)');
    const fresh = textIn(spawns[1].inputs[0]);
    A.ok(fresh.startsWith('<user>\nRead a.txt and b.txt.') && fresh.includes('cleared to save context') && !fresh.includes('alpha') &&
      fresh.includes('beta') && fresh.includes('<invoke name="fs_read">'), 'the fresh child gets the whole (edited) history');
    A.eq(spawns[1].inputs[0].message.content, _internals.buildPrompt(msgs, TOOLS).blocks, '... in exactly the blocks a one-shot turn sends (one per entry)');
    A.eq(p.persistStats().fresh.history, 1, 'stats name the reason: history');
    // a fold that adds a leading summary note changes the system prompt the child was started with
    await collect(p, req([SYS, { role: 'system', content: '<conversation_summary>asked for two files</conversation_summary>' }, { role: 'user', content: 'and now?' }]));
    A.eq([spawns.length, p.persistStats().fresh.system], [3, 1], 'a summary folded into the system prompt starts a fresh child (reason: system)');

    // the loop recorded the reply without its call (a duplicate-check stop) and moved on
    const p2 = make(reader);
    const m2 = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const rr = reply(await collect(p2.p, req(m2)));
    m2.push({ role: 'assistant', content: rr.content }, { role: 'system', content: '<note>no call this time</note>' });
    await collect(p2.p, req(m2));
    A.eq([p2.spawns.length, p2.p.persistStats().fresh.reply], [2, 1], 'a reply the loop edited is not what the child holds: fresh child');

    // a model switch mid-run
    const p3 = make(reader);
    const m3 = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r3 = reply(await collect(p3.p, req(m3))); m3.push(r3, ...results(r3, 'alpha'));
    await collect(p3.p, req(m3, 'opus'));
    A.eq([p3.spawns.length, p3.p.persistStats().fresh.model], [2, 1], 'a model switch starts a fresh child');
    A.eq(p3.spawns[1].args[p3.spawns[1].args.indexOf('--model') + 1], 'opus', 'on the new model');

    // steering / a system note appended after the results is NOT a mismatch: it rides the delta
    const p4 = make(reader);
    const m4 = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r4 = reply(await collect(p4.p, req(m4))); m4.push(r4, ...results(r4, 'alpha'), { role: 'system', content: '<steering_note>also check c.txt</steering_note>' });
    await collect(p4.p, req(m4));
    const sent = textIn(p4.spawns[0].inputs[1]);
    A.ok(p4.spawns.length === 1 && sent.includes('<tool_result') && sent.includes('<system_note>\n<steering_note>also check c.txt</steering_note>\n</system_note>'),
      'a steering note appended after the results rides the same child');
  }

  // 3. A REPLY THAT RUNS ON PAST ITS BLOCK: the child's history now holds the guess, so it is closed (never reused).
  {
    const { p, spawns } = make((rec, n) => {
      if (spawns.indexOf(rec) > 0 || n > 1) return { lines: [init(), delta('done'), result('done')] };   // only the first child guesses
      const text = block('a.txt') + '\n\n<function_results>made up</function_results>';
      return { lines: [init(), delta(block('a.txt')), delta('\n\n<function_results>made up</function_results>'), result(text)] };
    });
    const ac = new AbortController();
    const req = msgs => ({ model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-3', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt.' }];
    const t1 = await collect(p, req(msgs));
    A.eq(t1.filter(e => e.type === 'tool_start').length, 1, 'the call still runs');
    A.ok(!t1.some(e => e.type === 'text' && /made up/.test(e.delta)), 'the guess never reaches the loop');
    A.ok(spawns[0].treeKilled, 'the child that kept the guess is killed at once');
    A.eq(p.persistStats().closed.overrun, 1, 'stats: closed for overrun');
    A.ok(spawns.length === 2 && spawns[1].inputs.length === 0 && spawns[1].child.exitCode == null && p.persistStats().prewarmed === 1,
      'a WARM replacement is started at once, idle while the loop runs the tool');
    A.eq(spawns[1].args.filter(a => !/starnet-claude-cli-/.test(a)), spawns[0].args.filter(a => !/starnet-claude-cli-/.test(a)), 'with the same flags (its own system prompt file)');
    const r1 = reply(t1); msgs.push(r1, ...results(r1, 'real contents'));
    await collect(p, req(msgs));
    A.ok(spawns.length === 2 && textIn(spawns[1].inputs[0]).startsWith('<user>\nRead a.txt.') && textIn(spawns[1].inputs[0]).includes('real contents'), 'the next turn starts on the warm child, from StarNet\'s whole history');
    A.eq(p.persistStats().fresh.warm, 1, 'stats: the warm child was used');
    p.release('run-3');
    A.ok(spawns[1].treeKilled, 'run end kills it like any child');
    // a warm child the next turn does not fit (a model switch) is closed unused, and a fitting one is started
    const wu = make(rec => (wu.spawns.indexOf(rec) > 0 ? { lines: [init(), delta('ok'), result('ok')] } : { lines: [init(), delta(block('a.txt') + ' guess'), result(block('a.txt') + ' guess')] }));
    const wm = [SYS, { role: 'user', content: 'Read a.txt.' }];
    const wr = reply(await collect(wu.p, req(wm))); wm.push(wr, ...results(wr, 'alpha'));
    await collect(wu.p, Object.assign(req(wm), { model: 'opus' }));
    A.ok(wu.spawns.length === 3 && wu.spawns[1].treeKilled && wu.spawns[1].inputs.length === 0 && wu.p.persistStats().closed.warm_unused === 1,
      'a warm child the next turn does not fit is closed unused');

    // the block arrives in the SAME delta as text past it: the stop delta's rest counts too
    const same = make(rec => ({ lines: [init(), delta(block('a.txt') + '\nThe file says hi.'), result(block('a.txt') + '\nThe file says hi.')] }));
    await collect(same.p, req([SYS, { role: 'user', content: 'Read a.txt.' }]));
    A.ok(same.spawns[0].treeKilled, 'text past the block inside the stopping delta also closes the child');

    // whitespace after the block, then the model's own end: in sync, kept
    const ws = make(rec => ({ lines: [init(), delta(block('a.txt')), delta('\n'), result(block('a.txt') + '\n')] }));
    await collect(ws.p, req([SYS, { role: 'user', content: 'Read a.txt.' }]));
    A.ok(!ws.spawns[0].killed && ws.p.persistStats().live, 'trailing whitespace before the natural end keeps the child');

    // the model goes quiet after its block and never ends: closed after the grace window, the turn still completes
    const quiet = make(rec => ({ lines: [init(), delta(block('a.txt'))] }));
    const qt = await collect(quiet.p, req([SYS, { role: 'user', content: 'Read a.txt.' }]));
    A.ok(qt.some(e => e.type === 'done' && e.finishReason === 'tool_calls') && quiet.spawns[0].treeKilled && quiet.p.persistStats().closed.no_end === 1,
      'a reply that never ends is closed after the grace window; the turn still hands over its call');
    A.eq(qt.filter(e => e.type === 'usage').map(e => e.usage.subscription), [true], 'its estimated usage is still ONE subscription booking');
  }

  // 4. STOP: mid-turn (no events, child killed) and between turns (a parked child dies with the run signal).
  {
    const { p, spawns } = make((rec, n) => (n === 1 ? { lines: [init()] } : {}));   // turn 1 hangs
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const evs = await collect(p, { model: 'sonnet', tools: TOOLS, messages: [SYS, { role: 'user', content: 'x' }], runId: 'run-4', signal: ac.signal });
    A.eq(evs.length, 0, 'a cancelled turn emits nothing');
    A.ok(spawns[0].treeKilled, 'Stop mid-turn kills the child tree');

    const parked = make(reader);
    const ac2 = new AbortController();
    await collect(parked.p, { model: 'sonnet', tools: TOOLS, messages: [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }], runId: 'run-4b', signal: ac2.signal });
    A.ok(parked.spawns[0].child.exitCode == null, 'parked while the loop runs the tool');
    ac2.abort();
    A.ok(parked.spawns[0].treeKilled && parked.p.persistStats().closed.stop === 1, 'Stop between turns kills the parked child');
    const after = await collect(parked.p, { model: 'sonnet', tools: TOOLS, messages: [SYS, { role: 'user', content: 'x' }], runId: 'run-4b', signal: ac2.signal });
    A.eq([after.length, parked.spawns.length], [0, 1], 'a request on a stopped run spawns nothing');
  }

  // 5. THE CHILD CRASHES MID-TURN: the turn fails loudly (the loop retries it), and the retry starts a fresh child.
  {
    const { p, spawns } = make((rec, n) => {
      if (spawns.indexOf(rec) === 0 && n === 2) return { lines: [init(), delta('Thinking about'), ], crash: 3, stderr: 'segfault in child' };
      return reader(rec, spawns.indexOf(rec) === 0 ? n : 2);
    });
    const ac = new AbortController();
    const req = msgs => ({ model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-5', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r1 = reply(await collect(p, req(msgs))); msgs.push(r1, ...results(r1, 'alpha'));
    let err = null;
    try { await collect(p, req(msgs)); } catch (e) { err = e; }
    A.ok(err && /exited with code 3/.test(err.message) && /segfault/.test(err.message), 'a crash mid-turn throws with the exit code and stderr: ' + (err && err.message));
    const retry = await collect(p, req(msgs));   // the loop's retry ladder re-sends the same turn
    A.ok(retry.some(e => e.type === 'tool_start') && spawns.length === 2, 'the retry runs on a fresh child');
    A.ok(textIn(spawns[1].inputs[0]).includes('<tool_result id="' + r1.tool_calls[0].id + '">\nalpha'), 'which gets the whole history, results included');
  }

  // 6. COST: an API-key sign-in's result line carries a RUNNING total; each turn books only its own share.
  {
    let total = 0;
    const { p } = make((rec, n) => {
      total += n === 1 ? 0.25 : 0.1;
      const text = n === 1 ? block('a.txt') : 'ok';
      return { lines: [init('ANTHROPIC_API_KEY'), delta(text), result(text, { total_cost_usd: total })] };
    });
    const ac = new AbortController();
    const req = msgs => ({ model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-6', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt.' }];
    const t1 = await collect(p, req(msgs));
    const r1 = reply(t1); msgs.push(r1, ...results(r1, 'alpha'));
    const t2 = await collect(p, req(msgs));
    A.eq([t1.find(e => e.type === 'usage').usage.cost, Math.round(t2.find(e => e.type === 'usage').usage.cost * 1000) / 1000], [0.25, 0.1], 'turn 2 books $0.10, not the running $0.35');
    A.eq(t1.find(e => e.type === 'usage').usage.completion_tokens, 7, 'a call turn that ended on its own books its real result usage');
    A.eq([t1, t2].map(t => t.find(e => e.type === 'usage').usage.subscription), [undefined, undefined], 'an API-key turn is never marked subscription');
    const sub = make(reader);
    const su = await collect(sub.p, req([SYS, { role: 'user', content: 'Read a.txt.' }]));
    A.eq(su.find(e => e.type === 'usage').usage.cost, 0, 'a subscription turn still books $0');
  }

  // 7. A SIDE CALL (no tools: a summary, a vision call, a wire test) never touches the parked child.
  {
    const { p, spawns } = make((rec, n, msg) => (msg && msg.text != null ? { lines: [init(), result('summary')] } : reader(rec, n)));
    const ac = new AbortController();
    const msgs = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r1 = reply(await collect(p, { model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-7', signal: ac.signal }));
    const side = await collect(p, { model: 'sonnet', messages: [{ role: 'system', content: 'Summarize.' }, { role: 'user', content: 'stuff' }], runId: 'run-7', signal: ac.signal });
    A.ok(side.some(e => e.type === 'text' && e.delta === 'summary') && spawns.length === 2 && spawns[1].ended && spawns[0].child.exitCode == null, 'the side call ran its own one-shot child; the parked one lives');
    msgs.push(r1, ...results(r1, 'alpha'));
    await collect(p, { model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-7', signal: ac.signal });
    A.eq([spawns.length, spawns[0].inputs.length], [2, 2], 'the next loop turn still rides the original child');
    p.release('run-7');
  }

  // 8. IDLE: a parked child that nobody uses again is closed after STARNET_CLAUDE_CLI_PERSIST_IDLE_MS.
  {
    const { p, spawns } = make(reader, { env: { PATH: '', STARNET_CLAUDE_CLI_PERSIST_IDLE_MS: '30' } });
    await collect(p, { model: 'sonnet', tools: TOOLS, messages: [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }], runId: 'run-8', signal: new AbortController().signal });
    await tick(80);
    A.ok(spawns[0].treeKilled && p.persistStats().closed.idle === 1, 'the idle timeout closes a parked child');
  }

  // 9. KILL SWITCH: STARNET_CLAUDE_CLI_PERSIST=0 is today's behaviour, one `claude -p` per turn with the whole history.
  {
    const { p, spawns } = make((rec, n, msg) => {
      const text = /alpha/.test(msg.text || '') ? 'done' : block('a.txt');
      return { lines: [init(), delta(text), result(text)] };
    }, { env: { PATH: '', STARNET_CLAUDE_CLI_PERSIST: '0' } });
    const ac = new AbortController();
    const msgs = [SYS, { role: 'user', content: 'Read a.txt.' }];
    const r1 = reply(await collect(p, { model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-9', signal: ac.signal }));
    msgs.push(r1, ...results(r1, 'alpha'));
    await collect(p, { model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-9', signal: ac.signal });
    A.eq(spawns.length, 2, 'kill switch off: a fresh child per turn');
    A.ok(spawns.every(s => s.args.join(' ').includes('--input-format stream-json') && s.inputs.length === 0 && s.ended), 'each one gets ONE stream-json message on stdin, then stdin ends');
    A.eq(JSON.parse(spawns[1].stdinText).message.content, _internals.buildPrompt(msgs, TOOLS).blocks, 'and gets the whole history, one block per entry (the base PROMPT CACHE path)');
    A.eq(p.persistStats().enabled, false, 'stats say persistence is off');
  }

  // 11. TOOL REVEALS (live 10-12: tool_search restarted the child twice in a 5-turn run). A revealed tool is ADDED to
  //     the request's tools; the child keeps going and the new tool is announced in that turn's message. A tool that is
  //     withdrawn or changed is not something a note can fix: fresh child.
  {
    const WRITE = { type: 'function', function: { name: 'fs_write', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } };
    const { p, spawns } = make(reader);
    const ac = new AbortController();
    const req = (msgs, tools) => ({ model: 'sonnet', tools, messages: msgs.slice(), runId: 'run-11', signal: ac.signal });
    const msgs = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r1 = reply(await collect(p, req(msgs, TOOLS))); msgs.push(r1, ...results(r1, 'found fs_write'));
    const t2 = await collect(p, req(msgs, TOOLS.concat([WRITE])));
    A.eq(spawns.length, 1, 'a revealed tool keeps the child');
    const sent = textIn(spawns[0].inputs[1]);
    A.ok(sent.startsWith('<tool_result') && sent.includes('found fs_write') && /<system_note>\nMore tools are now available[^]*\n- fs_write: write a file\n  parameters: \{"type":"object"/.test(sent) && !sent.includes('- fs_read'),
      'the turn that reveals it announces ONLY the new tool, after the results: ' + JSON.stringify(sent.slice(0, 300)));
    A.eq(p.persistStats().announced, 1, 'stats: one tool announced');
    const r2 = reply(t2); msgs.push(r2, ...results(r2, 'beta'));
    await collect(p, req(msgs, TOOLS.concat([WRITE])));
    A.ok(spawns.length === 1 && !textIn(spawns[0].inputs[2]).includes('More tools'), 'an announced tool is not announced again');

    const w = make(reader);
    const m2 = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const rr = reply(await collect(w.p, req(m2, TOOLS.concat([WRITE])))); m2.push(rr, ...results(rr, 'alpha'));
    await collect(w.p, req(m2, TOOLS));
    A.eq([w.spawns.length, w.p.persistStats().fresh.tools], [2, 1], 'a withdrawn tool starts a fresh child');
    const c = make(reader);
    const m3 = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r3 = reply(await collect(c.p, req(m3, TOOLS))); m3.push(r3, ...results(r3, 'alpha'));
    await collect(c.p, req(m3, [{ type: 'function', function: Object.assign({}, TOOLS[0].function, { description: 'read a file (now with limits)' }) }]));
    A.eq([c.spawns.length, c.p.persistStats().fresh.tools], [2, 1], 'a changed tool description starts a fresh child');
    const fresh = c.spawns[1].args[c.spawns[1].args.indexOf('--system-prompt-file') + 1];
    A.ok(typeof fresh === 'string' && fresh.length > 0, 'the fresh child is started with its own (new) system prompt file');
  }

  // 12. A delta that carries a picture (a screen capture handed back after a tool result) sends it as a real image block.
  {
    const { p, spawns } = make(reader);
    const ac = new AbortController();
    const msgs = [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }];
    const r1 = reply(await collect(p, { model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-12', signal: ac.signal }));
    msgs.push(r1, ...results(r1, 'alpha'), { role: 'user', content: [{ type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] });
    await collect(p, { model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-12', signal: ac.signal });
    const c = spawns[0].inputs[1].message.content;
    A.ok(spawns.length === 1 && c[0].type === 'text' && c[0].text.startsWith('<tool_result') && !c.some(b => b.text && b.text.includes('Read a.txt')), 'the delta starts with the new tool result');
    A.eq(c[1], { type: 'text', text: '<user>\n[BEGIN EXTERNAL SCREEN CAPTURE]\n[image 1 — attached below]\n</user>' }, 'the capture is its own entry, naming where the picture sat');
    A.eq(c.slice(2), [{ type: 'text', text: 'Image 1:' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }], 'and the picture rides as an image block right after it, on the same child');
    p.release('run-12');
  }

  // 13. THE MERGED BASE (cache-cap + lean-prompt, 2026-10-12): a fresh child starts from the per-entry PROMPT CACHE blocks
  //     (a first message's run-context note joins its user entry, never the system prompt), each later turn sends only
  //     the new entries in the same blocks (parallel results share one), and every turn's usage says `subscription`.
  {
    const files = {};
    const fsRec = { statSync() { return { isFile: () => true }; }, writeFileSync(f, d) { files[f] = String(d); }, unlinkSync() {} };
    const both = '<function_calls>\n' + ['a.txt', 'b.txt'].map(f => '<invoke name="fs_read">\n<parameter name="path">' + f + '</parameter>\n</invoke>').join('\n') + '\n</function_calls>';
    const parallel = (rec, n) => {
      const text = n === 1 ? both : (n === 2 ? block('c.txt') : 'All read.');
      return { lines: [init(), start({ input_tokens: 3 }), delta(text), result(text)] };
    };
    const { p, spawns } = make(parallel, { fs: fsRec });
    const ac = new AbortController();
    const prefix = 'You are the test agent.';
    const sys = { role: 'system', content: prefix + '\n\nFINISH THE JOB.' };
    const note = provider.runContextNote('[RUNTIME]\nRun id: run-13');
    const recall = '<recalled-memory>\n• prefers bullets\n</recalled-memory>';
    const req = msgs => ({ model: 'sonnet', tools: TOOLS, messages: msgs.slice(), runId: 'run-13', signal: ac.signal, cacheSystemPrefix: prefix });
    const msgs = [sys, { role: 'system', content: note }, { role: 'system', content: recall }, { role: 'user', content: 'Read a, b and c.' }];
    const t1 = await collect(p, req(msgs));
    A.eq(spawns[0].inputs[0].message.content, _internals.buildPrompt(msgs, TOOLS, prefix).blocks, 'a fresh child gets exactly the one-shot blocks');
    A.eq(spawns[0].inputs[0].message.content, [{ type: 'text', text: '<user>\n' + note + '\n\n' + recall + '\n\nRead a, b and c.\n</user>' }], 'first message: the run-context note and recall lead the user entry (one block)');
    const sysText = files[spawns[0].args[spawns[0].args.indexOf('--system-prompt-file') + 1]] || '';
    A.ok(sysText.indexOf('run-13') < 0 && sysText.indexOf('<run_context>') < 0 && sysText.indexOf('<recalled-memory>') < 0, 'the per-run note never enters the child\'s system prompt');
    A.ok(/^You are the test agent\.\n\n# Tools[^]*\n\n# Conversation\nThe first user message holds the conversation so far[^]*\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nFINISH THE JOB\.$/.test(sysText),
      'system: stable prefix, tools, the persistent transcript note, then the boundary and the per-run text: ' + JSON.stringify(sysText.slice(-160)));
    A.eq(sysText.replace(/# Conversation\n[^\n]*/, ''), _internals.buildPrompt(msgs, TOOLS, prefix).system.replace(/# Conversation\n[^\n]*/, ''), 'the rest of the system prompt is the one-shot one, byte for byte');
    const r1 = reply(t1);
    A.eq(r1.tool_calls.length, 2, 'turn 1 asks for two reads at once');
    msgs.push(r1, ...results(r1, 'alpha'));
    const t2 = await collect(p, req(msgs));
    A.eq(spawns.length, 1, 'turn 2 rides the same child');
    A.eq(spawns[0].inputs[1].message.content.map(b => b.text), ['<tool_result id="' + r1.tool_calls[0].id + '">\nalpha\n</tool_result>\n<tool_result id="' + r1.tool_calls[1].id + '">\nalpha\n</tool_result>'],
      'turn 2: both parallel results in ONE block, nothing after them');
    const r2 = reply(t2); msgs.push(r2, ...results(r2, 'gamma'), { role: 'system', content: '<steering_note>be brief</steering_note>' });
    const t3 = await collect(p, req(msgs));
    A.eq(spawns[0].inputs[2].message.content, _internals.buildPrompt(msgs, TOOLS, prefix).blocks.slice(-2), 'turn 3: exactly the last two one-shot blocks (the result, the note), sent alone');
    A.ok(!JSON.stringify(spawns[0].inputs).includes('Continue as the assistant'), 'no per-turn instruction ever follows the newest entry');
    [t1, t2, t3].forEach((t, i) => A.eq(t.filter(e => e.type === 'usage').map(e => e.usage.subscription), [true], 'turn ' + (i + 1) + ': ONE usage, marked subscription (the loop\'s maxSubscriptionTokens counts it)'));
    p.release('run-13');
  }

  // 14. DIAGNOSTICS: STARNET_CLAUDE_CLI_PERSIST_LOG=1 also prints each turn's usage (what the prompt cache read vs wrote),
  //     on either path — the live proof's per-turn cache numbers. Off by default: nothing is printed.
  {
    const lines = [], log = console.log;
    console.log = (...a) => { const s = a.join(' '); if (/\[claude-cli persist\]/.test(s)) lines.push(s); else log(...a); };
    try {
      for (const env of [{ PATH: '', STARNET_CLAUDE_CLI_PERSIST_LOG: '1' }, { PATH: '', STARNET_CLAUDE_CLI_PERSIST_LOG: '1', STARNET_CLAUDE_CLI_PERSIST: '0' }, { PATH: '' }]) {
        const { p } = make(reader, { env });
        await collect(p, { model: 'sonnet', tools: TOOLS, messages: [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }], runId: 'run-14', signal: new AbortController().signal });
        p.release('run-14');
      }
    } finally { console.log = log; }
    const usage = lines.filter(l => / usage /.test(l));
    A.eq(usage, ['[claude-cli persist] usage persistent: in=35 cache_read=20 cache_write=5 out=7 subscription', '[claude-cli persist] usage one-shot: in=3 cache_read=0 cache_write=0 out=30 subscription'],
      'one usage line per turn on each path when asked (a one-shot call turn is cut at its block: the stream\'s own numbers), none by default');
  }

  // 10. THE REAL LOOP drives the adapter (no hand-built replies): the reply loop.js records is exactly the one the child
  //     holds, so the next turn rides the same child, and the run's end releases it (loop.js end() -> release()).
  {
    const { makeEmitter } = require('../shared/emitter.js');
    const { makeCostEngine } = require('../sidecar/cost.js');
    const { runAgentLoop } = require('../sidecar/loop.js');
    const { makeRegistry } = require('../sidecar/tools/registry.js');
    const { p, spawns } = make(reader);
    const reg = makeRegistry();
    const read = [];
    reg.register({ name: 'fs_read', schema: TOOLS[0].function.parameters, run: async (a) => { read.push(a.path); return 'contents of ' + a.path; } });
    const ac = new AbortController();
    const res = await runAgentLoop({
      messages: [SYS, { role: 'user', content: 'Read a.txt and b.txt.' }], provider: p, emit: makeEmitter(A.makeBus(), () => {}),
      cost: makeCostEngine({ priceOf: () => null }), model: 'sonnet', agentId: 'a', runId: 'run-10', tools: TOOLS,
      limits: { maxIters: 6, grace: false }, signal: ac.signal, dispatch: (c, ctx) => reg.dispatch(c, ctx),
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', signal: ac.signal }, clock: { now: () => 0 }
    });
    A.eq([res.reason, read], ['done', ['a.txt', 'b.txt']], 'the loop ran both reads and finished: ' + res.reason);
    A.eq(spawns.length, 1, 'three loop turns rode ONE child: the loop recorded each reply exactly as the child holds it');
    A.eq(p.persistStats().reused, 2, 'turns 2 and 3 were deltas');
    A.ok(textIn(spawns[0].inputs[1]).startsWith('<tool_result id="call_cli_') && textIn(spawns[0].inputs[1]).includes('contents of a.txt') &&
      !textIn(spawns[0].inputs[1]).includes('Read a.txt'), 'turn 2 sent only the tool result the loop produced');
    A.ok(spawns[0].treeKilled && p.persistStats().closed.run_end === 1, 'the run\'s end released the child (loop.js end -> release)');
  }

  A.report('claude-cli-persist.test');
})().catch(e => { console.log('FAIL: claude-cli-persist.test threw -- ' + (e && e.stack || e)); process.exit(1); });
