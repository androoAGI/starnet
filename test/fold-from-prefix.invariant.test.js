/* node test/fold-from-prefix.invariant.test.js: THE FOLD FROM THE PREFIX'S TWO INVARIANTS (cost lane W2.7; STARNET_FOLD_FROM_PREFIX).

   A. OFF IS THE 0.15.2 CANDIDATE, BYTE FOR BYTE. The switch is off by default. A long run that folds (the real loop, the
      real Anthropic adapter, the real chunked summarizer, a recording upstream: test/helpers/fold-fixture.js) sends, with
      the switch unset or set to anything but on, the very bytes it sent before this lane: the digest below was taken with
      the 57c741da7 sources of the loop, the summarizer, the history-edit resolver and every provider file in place. The
      two cache stampers this lane touched (the Anthropic adapter's body, OpenRouter's applyCacheControl) are pinned the
      same way for a request that is not a fold.

   B. ON, THE FOLD READS THE RUN'S OWN PREFIX AND WRITES NOTHING (red on 57c741da7, where the option does not exist and the
      fold is chunked). The fold is ONE request; the run's previous request is, position for position, the start of it; no
      new cache entry is written; the tools, system prompt, thinking and effort are the run's own bytes and no tool choice
      is sent; the run finishes with every tool call it would have made, and none more.

   C. ONE READER. The switch is read once, in sidecar/index.js, through ENV() like every cost switch, and handed to the loop;
      only the words that turn the other cost switches on turn it on. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const provider = require('../sidecar/providers/provider.js');
const openrouter = require('../sidecar/providers/openrouter.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { runLong, sharedPrefix, digest, filler, fn, MODEL, NL } = require('./helpers/fold-fixture.js');

for (const name of ['SKYNET_ANTHROPIC_CACHE_TTL', 'SKYNET_ANTHROPIC_MAX_TOKENS', 'STARNET_STABLE_PREFIX', 'SKYNET_STABLE_PREFIX']) delete process.env[name];
// taken on 57c741da7 (the lane's base sources in place), with this same fixture
const BASE_RUN = 'f6641ad06177194bb38bfa2d0f7725709566fc1c2718c68626d021c61b7bf220';
const BASE_STAMPERS = 'e98bdca6bb7c29beb23eab2a3baa84171aeca5b80f22056fefbac8ebbd1751b6';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

(async () => {
  /* ---------- A. off is the base, byte for byte ---------- */
  for (const [label, value] of [['unset', undefined], ['false', false], ['the string "1" (only the host\'s own true turns it on)', '1'], ['0', 0]]) {
    const run = await runLong({ foldFromPrefix: value });
    A.eq([run.res.reason, run.folds.length >= 3 && run.folds.every(f => f.kind === 'chunk'), digest(run.up.posts)], ['done', true, BASE_RUN],
      'the switch ' + label + ': every request of a long run that folds is byte for byte what 57c741da7 sends (' + run.up.posts.length + ' requests)');
  }
  // the stampers, for a request that is not a fold
  const user = text => ({ role: 'user', content: text }), tool = (id, text) => ({ role: 'tool', tool_call_id: id, content: text });
  const call = id => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'noop', arguments: '{}' } }] });
  const convo = [{ role: 'system', content: 'You are a station agent. ' + filler('RULE', 600) }, user('audit every body')];
  for (let i = 1; i <= 6; i++) convo.push(call('c' + i), tool('c' + i, filler('BODY#' + i, 900)));
  const bodies = [];
  const anth = makeAnthropicProvider({ key: 'k', reasoningEffort: 'medium', fetch: async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    bodies.push(String(init.body));
    return new Response(['data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }), 'data: ' + JSON.stringify({ type: 'message_stop' }), ''].join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const tools = [fn('noop'), fn('fs_read', { path: { type: 'string' } })];
  for (const mode of ['', '1h', 'mixed']) {
    if (mode) process.env.SKYNET_ANTHROPIC_CACHE_TTL = mode; else delete process.env.SKYNET_ANTHROPIC_CACHE_TTL;
    for (const req of [{ model: MODEL, messages: convo, tools, stream: true, cacheSystemPrefix: 'You are a station agent.' }, { model: MODEL, messages: convo, tools, stream: true },
      { model: MODEL, messages: convo.slice(0, 2), stream: true, neverReread: true }]) for await (const ev of anth.stream(req)) void ev;
    const wire = model => provider.chatWireMessages(provider.chatRoleProjection(provider.prepareWireMessages(convo, 'chat'), model));
    for (const model of ['anthropic/claude-opus-5.5', 'openai/gpt-5.5']) for (const never of [false, true])
      bodies.push(JSON.stringify(openrouter.applyCacheControl(wire(model), model, 'You are a station agent.', never)));
  }
  delete process.env.SKYNET_ANTHROPIC_CACHE_TTL;
  const stampers = sha(bodies.join(NL));
  if (process.env.FOLD_PREFIX_PRINT_DIGESTS) console.log('[fold-from-prefix.invariant] stampers digest: ' + stampers + ' (' + bodies.length + ' bodies)');
  A.eq([bodies.length, stampers], [21, BASE_STAMPERS], 'the Anthropic body and OpenRouter\'s cache stamps of an ordinary request are byte for byte what 57c741da7 builds, on every cache tier');

  /* ---------- B. on, the fold reads the run's own prefix and writes nothing ---------- */
  const on = await runLong({ foldFromPrefix: true });
  const fold = on.folds[0], prev = on.runs.filter(p => fold && p.n < fold.n).at(-1);
  A.eq([on.res.reason, on.ran, on.folds.length, fold && fold.kind], ['done', 11, 1, 'prefix'], 'on: the run finishes its eleven tool calls, and its fold is ONE request from the run\'s own prefix');
  const shared = fold && prev ? sharedPrefix(prev.positions, fold.positions) : { whole: false, bytes: 0 };
  A.ok(shared.whole && fold && shared.bytes > 0.85 * fold.positions.reduce((n, p) => n + Buffer.byteLength(p.text), 0), 'on: the run\'s previous request is, position for position, the start of the fold request (more than 85% of its bytes)');
  A.eq([fold && fold.usage.cacheWrite, fold && fold.usage.cacheRead === (prev && prev.usage.total)], [0, true], 'on: it writes no cache entry, and reads everything the previous request sent');
  A.eq(fold && prev ? [JSON.stringify(fold.body.tools) === JSON.stringify(prev.body.tools), JSON.stringify(fold.body.system) === JSON.stringify(prev.body.system),
    JSON.stringify(fold.body.thinking) === JSON.stringify(prev.body.thinking), JSON.stringify(fold.body.output_config) === JSON.stringify(prev.body.output_config), 'tool_choice' in fold.body] : null,
    [true, true, true, true, false], 'on: tools, system, thinking and effort are the run\'s own bytes, and no tool choice is sent');

  /* ---------- C. one reader ---------- */
  const root = path.join(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8'), loop = fs.readFileSync(path.join(root, 'sidecar', 'loop.js'), 'utf8');
  const count = (text, needle) => text.split(needle).length - 1;
  A.eq(count(index, "ENV('FOLD_FROM_PREFIX')"), 1, 'index.js reads the switch once, through ENV()');
  const reader = index.match(/foldFromPrefix: (\/\^\(1\|true\|yes\|on\)\$\/i\.test\(String\(ENV\('FOLD_FROM_PREFIX'\) \|\| ''\)\.trim\(\)\)),/);
  A.ok(reader, 'and hands it to the loop as foldFromPrefix');
  // the other cost lanes' options sit between the two in the stacked tree (sign-in ageing, the replay ledger, native deferral)
  A.ok(/\n\s+batchedAgeing: [^\n]+\n(?:\s+[^\n]*\n){1,24}?\s+foldFromPrefix: /.test(index), 'in the loop\'s own options, with the batched-ageing switch');
  if (reader) {
    const read = value => new Function('ENV', 'return ' + reader[1])(() => value);
    A.eq(['1', 'true', 'on', 'YES', ' 1 '].map(read), [true, true, true, true, true], 'the words that turn the cost switches on turn it on');
    A.eq([undefined, '', '0', 'off', 'false', 'no', 'lean', '2'].map(read), [false, false, false, false, false, false, false, false], 'unset, blank, 0 and anything else leave it off');
  }
  A.eq(count(loop, 'o.foldFromPrefix === true'), 1, 'the loop reads the option in one place, and only the host\'s own true turns it on');
  const others = [];
  for (const dir of ['sidecar', 'sidecar/providers', 'frontend/app']) for (const name of fs.readdirSync(path.join(root, dir))) {
    if (!name.endsWith('.js') || (dir === 'sidecar' && name === 'index.js')) continue;
    if (/ENV\('FOLD_FROM_PREFIX'\)|process\.env[^\n]{0,40}FOLD_FROM_PREFIX/.test(fs.readFileSync(path.join(root, dir, name), 'utf8'))) others.push(dir + '/' + name);
  }
  A.eq(others, [], 'no other file reads the switch');
  A.report('fold-from-prefix.invariant');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; A.report('fold-from-prefix.invariant'); });
