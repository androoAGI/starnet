/* node test/claude-cli-lifecycle.test.js — the Claude Code provider's turn ends and child lifecycle (review 2026-10-13).

   Locks the review items of the persistent-child lane and the stall report: a one-shot turn ends on its result line
   (not on the child's close, ~2 s later), a child that exits without closing its pipes is still released, the exit hook
   removes each live child's system-prompt file, a reply that wrote on past its block but ENDED books its result line's
   exact usage, a tagged failure with an empty result keeps its plain words, and the persistent path replays the REAL
   CLI's recorded stdout (2.1.284: thinking blocks, signatures, per-turn init, rate-limit events) and closes the child
   when the CLI compacts its own history. Mocked children only, except the exit-hook case, which runs a separate node
   process with a mocked child and a real temp file. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { makeClaudeCliProvider } = require('../sidecar/providers/claude-cli.js');

const init = source => ({ type: 'system', subtype: 'init', apiKeySource: source || 'none' });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const start = u => ({ type: 'stream_event', event: { type: 'message_start', message: { usage: u } } });
const USAGE = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20 };
const result = (text, cost, extra) => Object.assign({ type: 'result', subtype: 'success', result: text, usage: USAGE, total_cost_usd: cost, stop_reason: 'end_turn' }, extra || {});
const block = '<function_calls><invoke name="read"><parameter name="path">a</parameter></invoke></function_calls>';
const TOOLS = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const wait = ms => new Promise(r => setTimeout(r, ms));

// children: script(record, n) -> lines for the n-th stdin message (persistent) or for the one-shot prompt (n = 1).
// opts.exitOnly: the child emits 'exit' but never 'close' (a helper of its own still holds the pipes).
// opts.noExitOnEnd: a one-shot child that answers but does not exit by itself (a lingering CLI).
function rig(script, opts) {
  opts = opts || {};
  const children = [], removed = [], written = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    if (file === 'taskkill') {
      const target = children.find(c => String(c.child.pid) === args[1]);
      if (target) target.treeKilled = (target.treeKilled || 0) + 1;
      setImmediate(() => { if (target) target.exit(null); child.emit('close', 0); });
      return child;
    }
    const rec = { child, inputs: [], exited: false, closed: false, args };
    child.pid = 8100 + children.length; child.exitCode = null; child.signalCode = null;
    const pipe = () => Object.assign(new EventEmitter(), { setEncoding() {}, destroy() { this.destroyed = true; } });
    child.stdout = pipe(); child.stderr = pipe();
    rec.exit = code => {
      if (rec.exited) return;
      rec.exited = true; child.exitCode = code; child.signalCode = code === null ? 'SIGTERM' : null;
      child.emit('exit', code);
      if (!opts.exitOnly) { rec.closed = true; child.emit('close', code); }
    };
    rec.emit = l => { if (!rec.exited) child.stdout.emit('data', JSON.stringify(l) + '\n'); };
    child.kill = () => { rec.directKills = (rec.directKills || 0) + 1; rec.exit(null); return true; };
    const answer = n => setImmediate(() => { for (const l of script(rec, n) || []) rec.emit(l); if (rec.after) rec.after(); });
    child.stdin = Object.assign(new EventEmitter(), {
      write(text) { rec.inputs.push(JSON.parse(text)); answer(rec.inputs.length); return true; },
      end(text) {
        rec.ended = true;
        if (text) { rec.stdinText = text; answer(1); if (!opts.noExitOnEnd) rec.after = () => setTimeout(() => rec.exit(0), opts.exitDelayMs || 0); }
        else if (!opts.keepAliveOnEnd) setImmediate(() => rec.exit(0));
      }
    });
    children.push(rec);
    return child;
  };
  const provider = makeClaudeCliProvider(Object.assign({ spawn,
    fs: { statSync: () => ({ isFile: () => true }), writeFileSync: f => written.push(f), unlinkSync: f => removed.push(f) },
    bin: 'mock-cli', env: Object.assign({ PATH: '' }, opts.env || {}), platform: 'win32', persistEndGraceMs: 60, persistPipeDrainMs: 40, oneShotExitGraceMs: 80 }, opts.make || {}));
  const ac = new AbortController();
  const request = (messages, extra) => Object.assign({ model: 'sonnet', tools: TOOLS, messages, runId: 'life-run', signal: ac.signal }, extra || {});
  return { provider, ac, request, children, removed, written };
}
async function collect(p, req) { const events = []; let error; try { for await (const e of p.stream(req)) events.push(e); } catch (e) { error = e; } return { events, error }; }
function reply(events) {
  const calls = [];
  for (const e of events) {
    if (e.type === 'tool_start') calls[e.index] = { id: e.id, type: 'function', function: { name: e.name, arguments: '' } };
    if (e.type === 'tool_args') calls[e.index].function.arguments += e.chunk;
  }
  const r = { role: 'assistant', content: events.filter(e => e.type === 'text').map(e => e.delta).join('') };
  if (calls.length) r.tool_calls = calls;
  return r;
}
const msgs = () => [{ role: 'system', content: 'Lifecycle fixture' }, { role: 'user', content: 'Read a' }];

(async () => {
  // 1. THE RESULT LINE ENDS A ONE-SHOT TURN (stall report 2026-10-13). A lingering child that answered but never exits
  //    used to hold the turn until the idle watchdog threw the finished reply away; now the turn ends at `result`, and
  //    the child's tree is taken after the short exit grace.
  {
    const r = rig(() => [init('none'), start({ input_tokens: 3 }), delta('All done.'), result('All done.', 0)], { noExitOnEnd: true, make: { idleMs: 5000 } });
    const t0 = Date.now();
    const out = await collect(r.provider, r.request(msgs(), { tools: [] }));
    const ms = Date.now() - t0;
    A.ok(!out.error, 'one-shot: the turn succeeds (' + (out.error && out.error.message) + ')');
    A.eq(out.events.filter(e => e.type === 'done').map(e => e.finishReason), ['stop'], 'one-shot: exactly one done, from the result line');
    A.eq(out.events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'All done.', 'one-shot: the whole reply is delivered');
    A.ok(ms < 2000, 'one-shot: the turn ends on its result line, not on the child\'s exit (' + ms + ' ms)');
    A.eq(r.children[0].exited, false, 'one-shot: the child is not killed the instant it answered (it gets its exit grace)');
    await wait(200);
    A.eq(r.children[0].treeKilled, 1, 'one-shot: a child still alive after the grace has its tree taken');
    A.ok(r.removed.length >= 1, 'one-shot: the system-prompt file is removed');
  }
  // a one-shot child that exits by itself inside the grace is never killed
  {
    const r = rig(() => [init('none'), delta('ok'), result('ok', 0)], { exitDelayMs: 10 });
    const out = await collect(r.provider, r.request(msgs(), { tools: [] }));
    A.ok(!out.error, 'one-shot (prompt exit): the turn succeeds');
    await wait(200);
    A.ok(!r.children[0].treeKilled && !r.children[0].directKills, 'one-shot (prompt exit): a child that exits by itself is left alone');
  }

  // 2. EXIT WITHOUT CLOSE (review 2026-10-13): a persistent child whose root exits while a helper holds its pipes is
  //    released after the drain window — ownership ends and its prompt file goes.
  {
    let script = (rec, n) => n === 1 ? [init('none'), delta(block), result(block, 0)] : [];
    const r = rig((rec, n) => script(rec, n), { exitOnly: true });
    const first = await collect(r.provider, r.request(msgs()));
    A.ok(!first.error && r.provider.persistStats().reusable, 'exit-only: turn 1 parks the child');
    r.children[0].exit(1);   // the CLI root dies; 'close' never comes
    A.eq(r.provider.persistStats().live, true, 'exit-only: right after the exit the child is still owned (pipes may drain)');
    await wait(120);
    const st = r.provider.persistStats();
    A.eq([st.live, st.cleanupPending], [false, 0], 'exit-only: after the drain window the session is released');
    A.ok(r.children[0].child.stdout.destroyed && r.children[0].child.stderr.destroyed, 'exit-only: its pipes are let go');
    A.ok(r.removed.some(f => /starnet-claude-cli-.*-s1-/.test(f)), 'exit-only: its system-prompt file is removed');
  }

  // 3. A REPLY THAT WROTE ON AND THEN ENDED books its result line (review 2026-10-13): exact usage + this turn's cost
  //    share, not the stream estimate; the child is closed (it holds text StarNet never recorded) and a warm one waits.
  {
    const r = rig((rec, n) => n === 1 ? [init('ANTHROPIC_API_KEY'), start({ input_tokens: 9 }), delta(block + '\n<function_results>guess'), result(block + '\n<function_results>guess', 0.4)] : []);
    const out = await collect(r.provider, r.request(msgs()));
    const usage = out.events.filter(e => e.type === 'usage');
    A.eq(usage.length, 1, 'diverged: one usage snapshot');
    A.eq([usage[0].usage.prompt_tokens, usage[0].usage.completion_tokens, usage[0].usage.cost], [120, 5, 0.4], 'diverged: the result line\'s exact usage and billed cost');
    A.eq(out.events.filter(e => e.type === 'done').map(e => e.finishReason), ['tool_calls'], 'diverged: one done for the calls');
    const ds = r.provider.persistStats();
    A.eq([ds.lastClose && ds.lastClose.why, ds.lastClose && ds.lastClose.ended, ds.prewarmed], ['diverged', true, 1], 'diverged: the child that wrote on is closed and a warm one waits');
    r.provider.release('life-run');
  }

  // 4. A TAGGED FAILURE WITH AN EMPTY RESULT keeps its plain words (review 2026-10-13), on both paths
  for (const [tag, words, status] of [['rate_limit', 'rate limited', 429], ['authentication_failed', 'authentication failed', 401]]) {
    for (const persistent of [true, false]) {
      const r = rig(() => [init('none'), { type: 'assistant', error: tag }, result('', 0, { is_error: true, subtype: 'error_during_execution' })]);
      const out = await collect(r.provider, r.request(msgs(), persistent ? {} : { tools: [] }));
      const label = tag + (persistent ? ' (persistent)' : ' (one-shot)');
      A.eq(out.error && out.error.status, status, label + ': classified');
      A.ok(out.error && out.error.message.indexOf(words) >= 0 && out.error.message.indexOf('error_during_execution') < 0, label + ': plain words, no internal subtype — ' + (out.error && out.error.message));
      r.provider.release('life-run');
    }
  }
  {
    const r = rig(() => [init('none'), result('', 0, { is_error: true, subtype: 'error_max_turns' })]);
    const out = await collect(r.provider, r.request(msgs(), { tools: [] }));
    A.ok(out.error && /error_max_turns/.test(out.error.message), 'an untagged failure with an empty result still names its subtype');
  }

  // 5. THE REAL CLI's RECORDED STDOUT (2.1.284, test/fixtures/claude-cli-2.1.284-natural.json) through the persistent
  //    path: thinking + signature deltas, an assistant line per block, message_delta usage, rate_limit_event, init on
  //    every turn. Turn 1 asks for one fs_read and parks; turn 2 rides the SAME child with only the tool result.
  {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-cli-2.1.284-natural.json'), 'utf8'));
    const tools = [{ type: 'function', function: { name: 'fs_read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    const r = rig((rec, n) => (fixture.turns[n - 1] || { lines: [] }).lines);
    const messages = [{ role: 'system', content: 'Replay fixture' }, { role: 'user', content: 'Read the file notes.txt with the fs_read tool.' }];
    const t1 = await collect(r.provider, r.request(messages, { tools }));
    A.ok(!t1.error, 'replay: turn 1 succeeds (' + (t1.error && t1.error.message) + ')');
    const a1 = reply(t1.events);
    A.eq((a1.tool_calls || []).map(c => [c.function.name, JSON.parse(c.function.arguments).path]), [['fs_read', 'notes.txt']], 'replay: turn 1 parses the real call block');
    A.eq(t1.events.filter(e => e.type === 'done').map(e => e.finishReason), ['tool_calls'], 'replay: turn 1 ends with one tool_calls done');
    const u1 = t1.events.filter(e => e.type === 'usage');
    A.eq(u1.length, 1, 'replay: one usage snapshot');
    A.eq([u1[0].usage.prompt_tokens, u1[0].usage.completion_tokens, u1[0].usage.subscription], [778, 157, true], 'replay: the result line\'s exact usage, marked subscription');
    A.eq(r.provider.persistStats().reusable, true, 'replay: the child holds exactly what streamed — parked for reuse');
    messages.push(a1, { role: 'tool', tool_call_id: a1.tool_calls[0].id, content: 'hello' });
    const t2 = await collect(r.provider, r.request(messages, { tools }));
    A.ok(!t2.error, 'replay: turn 2 succeeds');
    A.eq(r.children.length, 1, 'replay: turn 2 rides the same child');
    const sent = r.children[0].inputs[1].message.content;
    A.eq(sent.length, 1, 'replay: turn 2 sends one block');
    A.ok(/^<tool_result id="[^"]+">\nhello\n<\/tool_result>$/.test(sent[0].text), 'replay: turn 2 sends only the tool result');
    A.eq((reply(t2.events).tool_calls || []).map(c => JSON.parse(c.function.arguments).path), ['a.txt', 'b.txt'], 'replay: turn 2 parses the real two-call block');
    r.provider.release('life-run');
  }

  // 6. THE CLI COMPACTING ITS OWN HISTORY (compact_boundary) means the child no longer holds StarNet's transcript: the
  //    turn is delivered, the child is closed, and the next turn starts a fresh child with the whole history.
  {
    const r = rig((rec, n) => n === 1 ? [init('none'), { type: 'system', subtype: 'compact_boundary' }, delta('Folded and done.'), result('Folded and done.', 0)] : [init('none'), delta('again'), result('again', 0)]);
    const messages = msgs();
    const t1 = await collect(r.provider, r.request(messages));
    A.ok(!t1.error && t1.events.some(e => e.type === 'done'), 'compact: the turn is still delivered');
    A.eq(r.provider.persistStats().reusable, false, 'compact: the child is not kept');
    messages.push(reply(t1.events), { role: 'user', content: 'and again' });
    await collect(r.provider, r.request(messages));
    A.eq(r.children.length, 2, 'compact: the next turn starts a fresh child');
    const fresh = r.children[1].inputs[0].message.content.map(x => x.text || '').join('|');
    A.ok(fresh.indexOf('<user>\nRead a\n</user>') >= 0 && fresh.indexOf('<assistant>\nFolded and done.\n</assistant>') >= 0, 'compact: the fresh child gets the whole history');
    r.provider.release('life-run');
  }

  // 8. AN IDLE TIMEOUT NEVER THROWS AWAY A FINISHED TURN (stall report 2026-10-13), on the persistent path. The child
  //    answered (its result line is already read off the pipe) while the consumer was still busy with an earlier event,
  //    and the idle watchdog fired in that gap: the finished reply was thrown as a timeout and the loop re-ran the turn.
  //    A turn that has its result line, or a complete call block, is delivered; only a turn with neither is a timeout.
  for (const persist of [true, false]) for (const shape of ['reply', 'calls']) {
    const label = (persist ? 'persistent' : 'one-shot') + ' ' + shape;
    const text = shape === 'reply' ? 'All done.' : block;
    const r = rig((rec, n) => n === 1 ? [init('none'), start({ input_tokens: 3 }), delta('Working. '), delta(text), result('Working. ' + text, 0)] : [],
      { noExitOnEnd: true, make: { idleMs: 40, persist } });
    const events = []; let error = null;
    try {
      for await (const e of r.provider.stream(r.request(msgs()))) { events.push(e); if (events.length === 1) await wait(150); }   // a consumer slower than the idle window
    } catch (e) { error = e; }
    A.ok(!error, 'idle after result (' + label + '): the finished turn is not thrown as a timeout (' + (error && error.message) + ')');
    A.eq(events.filter(e => e.type === 'done').length, 1, 'idle after result (' + label + '): exactly one done');
    if (shape === 'reply') A.eq(events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Working. All done.', 'idle after result (' + label + '): the whole reply is delivered');
    else A.eq(events.filter(e => e.type === 'tool_done').length, 1, 'idle after result (' + label + '): the complete call is delivered');
    A.eq(events.filter(e => e.type === 'usage').length, 1, 'idle after result (' + label + '): its usage is booked once');
    r.provider.release('life-run');
    await wait(120);   // a one-shot child's exit grace runs out inside this case
  }
  // ...and a turn the watchdog cut with NEITHER a result nor a complete call is still a timeout, on both paths
  for (const persist of [true, false]) {
    const r = rig((rec, n) => n === 1 ? [init('none'), delta('Thinking about it')] : [], { noExitOnEnd: true, make: { idleMs: 40, persist } });
    const out = await collect(r.provider, r.request(msgs()));
    A.ok(out.error && /idle timed out/.test(out.error.message), (persist ? 'persistent' : 'one-shot') + ': a silent unfinished turn is still an idle timeout (' + (out.error && out.error.message) + ')');
    r.provider.release('life-run');
  }

  // 7. THE EXIT HOOK REMOVES EACH LIVE CHILD's PROMPT FILE (review 2026-10-13). A separate node process parks a
  //    persistent child (mocked) whose system prompt is a REAL temp file, then exits without releasing it.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cli-exit-'));
    // The host script is CommonJS. Node reads the module type from the NEAREST package.json — and a temp root
    // under /tmp can inherit a STRAY package.json of an unrelated tool (this host had /tmp/package.json with
    // "type": "module"), which turned the host into an ES module: "require is not defined". Pin the type here.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'starnet-cli-exit-host', private: true, type: 'commonjs' }) + '\n', 'utf8');
    const host = path.join(dir, 'host.js');
    fs.writeFileSync(host, [
      "'use strict';",
      'const { EventEmitter } = require("node:events");',
      'const { makeClaudeCliProvider } = require(' + JSON.stringify(path.join(__dirname, '..', 'sidecar', 'providers', 'claude-cli.js')) + ');',
      'const block = ' + JSON.stringify(block) + ';',
      'const spawn = () => { const c = new EventEmitter(); const pipe = () => Object.assign(new EventEmitter(), { setEncoding() {} });',
      '  c.stdout = pipe(); c.stderr = pipe(); c.pid = 0; c.exitCode = null; c.signalCode = null; c.kill = () => { c.exitCode = 0; };',
      '  c.stdin = { on() {}, end() {}, write() { setImmediate(() => { for (const l of [{ type: "system", subtype: "init", apiKeySource: "none" },',
      '    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: block } } },',
      '    { type: "result", subtype: "success", result: block, usage: {}, total_cost_usd: 0 }]) c.stdout.emit("data", JSON.stringify(l) + "\\n"); }); return true; } };',
      '  return c; };',
      'const p = makeClaudeCliProvider({ spawn, bin: "mock-cli", env: { PATH: "" }, platform: "linux", persistEndGraceMs: 30 });',
      'const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }];',
      '(async () => {',
      '  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");',
      // a hard-killed process that once had this pid can have left a file with the same prefix: only this run's count
      '  const mine = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("starnet-claude-cli-" + process.pid + "-s"));',
      '  const before = new Set(mine());',
      '  for await (const e of p.stream({ model: "sonnet", tools, runId: "exit-run", messages: [{ role: "system", content: "EXIT_HOOK_PROMPT" }, { role: "user", content: "go" }] })) void e;',
      '  const files = mine().filter(f => !before.has(f));',
      '  console.log("PARKED " + JSON.stringify(files) + " " + p.persistStats().reusable);',
      '  process.exit(0);',
      '})();'
    ].join('\n'));
    const res = spawnSync(process.execPath, [host], { encoding: 'utf8', timeout: 30000 });
    const m = /PARKED (\[.*\]) (true|false)/.exec(res.stdout || '');
    A.ok(m && m[2] === 'true' && JSON.parse(m[1]).length === 1, 'exit hook: the child process parked one persistent child with one prompt file — ' + (res.stdout || '').trim() + ' ' + (res.stderr || '').trim().slice(0, 300));
    const left = m ? JSON.parse(m[1]).filter(f => fs.existsSync(path.join(os.tmpdir(), f))) : ['?'];
    A.eq(left, [], 'exit hook: a graceful sidecar exit leaves no system-prompt file behind');
    for (const f of left) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (e) { console.error('cleanup', e.message); } }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  A.report('claude-cli-lifecycle');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
