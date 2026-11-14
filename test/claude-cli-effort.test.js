/* node test/claude-cli-effort.test.js — WIRE THE CLAUDE-CLI EFFORT (cost audit W3.8, STARNET_CLI_EFFORT).

   The Claude sign-in route was built with no effort: a main run's `claude` child got no --effort and ran on the CLI's own
   default whatever the dial said. The switch has three values, and this file locks each:

   OFF (the default) IS TODAY, BYTE FOR BYTE. Every model x every per-request effort: the argv a child is started with, its
   env, what the adapter says it sent and the levels it lists are the ones the base commit produced (GOLDEN_OFF, recorded by
   running 57c741da7's own claude-cli.js over test/helpers/claude-cli-argv.js offMatrix), whatever effort the adapter was
   built with.
   PICKED sends the run's effort only when the host says the Commander picked it; ALL sends every run's effort. Both clamp
   through ONE resolver, sidecar/providers/effort-clamp.js, which the Anthropic adapter imports too (the CLI overlay: Haiku
   4.5 takes none, the 4.6 family has no xhigh, none and minimal become low). A chosen high or max is never lowered, and a
   request's own effort (self-talk, a background loop) wins in every mode.
   THE RECORD IS THE ARGV. On every path and in every mode, effortAsSent equals the child's --effort, or 'cli-default' when
   it got none.
   THE FACTORY CARRIES IT (the audit's finding: factory.js built this adapter with no effort). selectProvider hands the
   adapter the effort, the pick and the host's switch, checked on a real child (a fake `claude` that logs its argv).
   THE PAGE marks a pick only at a hand action that names an effort, and its dial lines follow the switch.

   Pure: fake children, no sidecar, no network, no model. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const A = require('./_assert.js');
const E = require('../sidecar/providers/effort-clamp.js');
const cli = require('../sidecar/providers/claude-cli.js');
const anthropic = require('../sidecar/providers/anthropic.js');
const registry = require('../sidecar/providers/registry.js');
const H = require('./helpers/claude-cli-argv.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
/* sha256 of JSON.stringify(offMatrix(...)) run on the base commit's own sidecar/providers/claude-cli.js (57c741da7): 155
   rows of argv, env, effortAsSent, reasoningEfforts and the catalog. Re-record only when the OFF behaviour changes on
   purpose for a reason outside this switch, and say so in that commit. */
const GOLDEN_OFF = 'bbb1b0024431df986843f0dfcf8d53cec0e60008eaeeafd010985b85fbb70324';
const ARGV_HEAD = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence'];

// one turn on a fresh adapter -> { argv, effort (the argv's --effort or null), env, sent (effortAsSent), p }
async function turn(adapterOpts, req, env) {
  const f = H.fakeCli();
  const p = cli.makeClaudeCliProvider(Object.assign({ spawn: f.spawn, fs: f.fs, bin: 'claude.exe', env: Object.assign({ PATH: '' }, env || {}), platform: 'linux', persist: false }, adapterOpts || {}));
  await H.collect(p, Object.assign({ messages: H.MESSAGES }, req));
  const argv = H.argvOf(f.spawns[0]);
  return { argv, effort: H.effortIn(argv), env: f.spawns[0].env, sent: p.effortAsSent(req.model, req.reasoningEffort), p, spawns: f.spawns };
}
const asSent = t => t.effort || 'cli-default';

(async () => {
  // ---- A. ONE RESOLVER -------------------------------------------------------------------------------------------------
  {
    const a = read('sidecar/providers/anthropic.js'), c = read('sidecar/providers/claude-cli.js');
    A.ok(/require\('\.\/effort-clamp\.js'\)/.test(a) && /const \{ [^}]*\beffortsFor\b[^}]*\bclampEffort\b[^}]*\} = effortClamp;/.test(a), 'the Anthropic adapter imports its ladder and its clamp from effort-clamp.js');
    A.ok(!/function (?:clampEffort|effortsFor|normalizeEffort)\(/.test(a) && !/const (?:LEGACY_CLAUDE|NO_XHIGH_CLAUDE|ALWAYS_THINKING_CLAUDE|EFFORT_ORDER) = /.test(a), '...and no longer declares a copy of either');
    A.ok(/require\('\.\/effort-clamp\.js'\)/.test(c) && /effortClamp\.cliArgvEffort\(/.test(c) && !/claude-haiku-4-5'|NO_XHIGH|function clampEffort\(/.test(c), 'the CLI adapter asks the same module and keeps no table of its own');
    const wire = anthropic.makeAnthropicProvider({ fetch: () => { throw new Error('no network in this test'); }, key: 'k' });
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-7-sonnet', 'gpt-5'])
      A.eq(wire.reasoningEfforts(id), E.effortsFor(id), 'the Anthropic adapter lists ' + id + ' as the resolver does');
    A.eq([E.effortsFor('claude-opus-5-5'), E.effortsFor('claude-sonnet-4-6'), E.effortsFor('claude-haiku-4-5'), E.effortsFor('gpt-5')],
      [['low', 'medium', 'high', 'xhigh', 'max'], ['none', 'low', 'medium', 'high', 'max'], ['none', 'low', 'medium', 'high', 'xhigh', 'max'], ['none']], 'the ladder is the one the Anthropic adapter always had');
    A.eq([E.clampEffort('xhigh', E.effortsFor('claude-sonnet-4-6')), E.clampEffort('minimal', E.effortsFor('claude-opus-5-5')), E.clampEffort('none', E.effortsFor('claude-opus-5-5'))], ['max', 'low', 'low'], 'the clamp: nearest level, ties upward');
    A.eq([E.normalizeEffort('Extra High'), E.normalizeEffort('off'), E.normalizeEffort('banana'), E.effortRung('banana'), E.effortRung('constructor'), E.effortRung(' MAX ')], ['xhigh', 'none', 'medium', '', '', 'max'], 'a word that names no level is the dial\'s default, and never a level to the CLI');
  }

  // ---- B. THE CLI OVERLAY ----------------------------------------------------------------------------------------------
  {
    A.eq([E.cliEffortsFor('claude-opus-5-5'), E.cliEffortsFor('claude-sonnet-5-5'), E.cliEffortsFor('claude-haiku-5-5'), E.cliEffortsFor('claude-opus-4-8'), E.cliEffortsFor('claude-sonnet-4-6'), E.cliEffortsFor('claude-haiku-4-5-20251001'), E.cliEffortsFor('opusplan'), E.cliEffortsFor('')],
      [['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high', 'max'], [], [], []],
      'what --effort can carry: never none; no xhigh on the 4.6 family; nothing for Haiku 4.5 or an id that is not a Claude id');
    const table = (id) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'banana', ''].map(w => E.cliEffortFor(id, w));
    A.eq(table('claude-opus-5-5'), ['low', 'low', 'low', 'medium', 'high', 'xhigh', 'max', '', ''], 'Opus 5.5 (always thinks): none and minimal become low, the rest ride as they are');
    A.eq(table('claude-sonnet-5-5'), ['low', 'low', 'low', 'medium', 'high', 'xhigh', 'max', '', ''], 'Sonnet 5.5: the CLI has no off, so none becomes low too');
    A.eq(table('claude-sonnet-4-6'), ['low', 'low', 'low', 'medium', 'high', 'max', 'max', '', ''], 'the 4.6 family: xhigh becomes max');
    A.eq(table('claude-haiku-4-5-20251001'), ['', '', '', '', '', '', '', '', ''], 'Haiku 4.5: the flag is omitted at every level');
    // the locked law: a chosen high or max is never lowered
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-fable-5-2'])
      A.eq([E.cliEffortFor(id, 'high'), E.cliEffortFor(id, 'max')], ['high', 'max'], id + ': a chosen high or max is sent as chosen, never capped');
    A.eq(['picked', 'all', ' Picked ', 'ALL', 'off', '', '1', 'on', 'true', 'yes', undefined, null, 0, 1].map(E.cliMode),
      ['picked', 'all', 'picked', 'all', 'off', 'off', 'off', 'off', 'off', 'off', 'off', 'off', 'off', 'off'], 'the switch: only the words picked and all turn it on');
    const d = o => E.cliArgvEffort(Object.assign({ model: 'claude-opus-5-5' }, o));
    A.eq([d({ mode: 'off', built: 'high', picked: true }), d({ mode: 'off', perRequest: 'low', built: 'high', picked: true }), d({ mode: 'off', perRequest: 'minimal' }), d({ mode: 'off', perRequest: 'low', model: 'claude-haiku-4-5' })],
      ['', 'low', '', 'low'], 'off: only a request\'s own effort, as written, never clamped; the run\'s effort is not sent');
    A.eq([d({ mode: 'picked', built: 'high', picked: true }), d({ mode: 'picked', built: 'high', picked: false }), d({ mode: 'picked', built: 'high' }), d({ mode: 'picked', perRequest: 'low', built: 'high', picked: true }), d({ mode: 'picked', perRequest: 'low', built: 'high', picked: false })],
      ['high', '', '', 'low', 'low'], 'picked: the run\'s effort only when it was picked; a request\'s own effort wins either way');
    A.eq([d({ mode: 'all', built: 'high', picked: false }), d({ mode: 'all', built: 'high', picked: true }), d({ mode: 'all', perRequest: 'low', built: 'max' }), d({ mode: 'all' }), d({ mode: 'all', built: 'minimal' })],
      ['high', 'high', 'low', '', 'low'], 'all: the run\'s effort, picked or not; a request\'s own effort wins; nothing built, nothing sent');
    A.eq([E.cliListFor('off', 'claude-haiku-4-5'), E.cliListFor(undefined, 'opusplan'), E.cliListFor('picked', 'claude-haiku-4-5'), E.cliListFor('all', 'claude-sonnet-4-6')],
      [['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high', 'xhigh', 'max'], [], ['low', 'medium', 'high', 'max']], 'the published list: off, the flat list every model always had; on, the model\'s own');
  }

  // ---- C. OFF IS THE BASE COMMIT, BYTE FOR BYTE -------------------------------------------------------------------------
  for (const [label, opts] of [['nothing passed', {}], ["effortMode 'off', built high, picked", { effortMode: 'off', reasoningEffort: 'high', effortPicked: true }],
    ['a switch value that is not a mode, built max, picked', { effortMode: '1', reasoningEffort: 'max', effortPicked: true }], ['no mode, built xhigh', { reasoningEffort: 'xhigh' }]]) {
    const rows = await H.offMatrix(cli.makeClaudeCliProvider, opts);
    A.eq(sha(JSON.stringify(rows)), GOLDEN_OFF, 'OFF (' + label + '): every argv, env, effortAsSent, level list and catalog entry is the base commit\'s (' + rows.length + ' rows)');
    if (label === 'nothing passed') {
      const main = rows.filter(r => r.argv && r.effort == null);
      A.ok(main.length >= 20 && main.every(r => H.effortIn(r.argv) === null && (r.persistent || r.sent === 'cli-default')), 'OFF: a request with no effort of its own gets no --effort and says cli-default');
      A.ok(rows.filter(r => r.argv).every(r => r.envLevel === 'max'), 'OFF: a CLAUDE_CODE_EFFORT_LEVEL in the station\'s shell reaches every child, as before');
      A.eq(rows.find(r => r.argv && r.model === 'claude-opus-5-5' && r.effort == null && !r.persistent).argv, ARGV_HEAD.concat(['--model', 'claude-opus-5-5', '--system-prompt-file', '<system-prompt-file>']), 'OFF: the argv of a main run, spelled out');
    }
  }

  // ---- D. PICKED AND ALL: the argv, and the record that names it -----------------------------------------------------------
  {
    const cases = [
      // [label, adapter opts, request, the --effort expected (null = none)]
      ['picked: a picked high', { effortMode: 'picked', reasoningEffort: 'high', effortPicked: true }, { model: 'claude-opus-5-5' }, 'high'],
      ['picked: a picked max is never capped', { effortMode: 'picked', reasoningEffort: 'max', effortPicked: true }, { model: 'claude-sonnet-5-5' }, 'max'],
      ['picked: a picked low', { effortMode: 'picked', reasoningEffort: 'low', effortPicked: true }, { model: 'claude-opus-5-5' }, 'low'],
      ['picked: a picked medium', { effortMode: 'picked', reasoningEffort: 'medium', effortPicked: true }, { model: 'claude-opus-4-8' }, 'medium'],
      ['picked: /fast (minimal) becomes low', { effortMode: 'picked', reasoningEffort: 'minimal', effortPicked: true }, { model: 'claude-opus-5-5' }, 'low'],
      ['picked: off (none) becomes low', { effortMode: 'picked', reasoningEffort: 'none', effortPicked: true }, { model: 'claude-sonnet-5-5' }, 'low'],
      ['picked: xhigh on Sonnet 4.6 becomes max', { effortMode: 'picked', reasoningEffort: 'xhigh', effortPicked: true }, { model: 'claude-sonnet-4-6' }, 'max'],
      ['picked: Haiku 4.5 takes no effort', { effortMode: 'picked', reasoningEffort: 'high', effortPicked: true }, { model: 'claude-haiku-4-5-20251001' }, null],
      ['picked: the haiku alias is Haiku 5.5', { effortMode: 'picked', reasoningEffort: 'high', effortPicked: true }, { model: 'haiku' }, 'high'],
      ['picked: a [1m] id is its model', { effortMode: 'picked', reasoningEffort: 'xhigh', effortPicked: true }, { model: 'claude-opus-5-5[1m]' }, 'xhigh'],
      ['picked: an alias this station does not know gets no flag', { effortMode: 'picked', reasoningEffort: 'high', effortPicked: true }, { model: 'opusplan' }, null],
      ['picked: a class-applied high is NOT sent', { effortMode: 'picked', reasoningEffort: 'high', effortPicked: false }, { model: 'claude-opus-5-5' }, null],
      ['picked: an effort with no word on its origin is NOT sent', { effortMode: 'picked', reasoningEffort: 'max' }, { model: 'claude-opus-5-5' }, null],
      ['picked: self-talk keeps its own low under a picked max', { effortMode: 'picked', reasoningEffort: 'max', effortPicked: true }, { model: 'claude-opus-5-5', reasoningEffort: 'low' }, 'low'],
      ['picked: self-talk keeps its own low under a class high', { effortMode: 'picked', reasoningEffort: 'high', effortPicked: false }, { model: 'claude-opus-5-5', reasoningEffort: 'low' }, 'low'],
      ['picked: self-talk on Haiku 4.5 sends none', { effortMode: 'picked', reasoningEffort: 'high', effortPicked: true }, { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low' }, null],
      ['picked: nothing built, nothing sent', { effortMode: 'picked', effortPicked: true }, { model: 'claude-opus-5-5' }, null],
      ['all: a class-applied high is sent', { effortMode: 'all', reasoningEffort: 'high', effortPicked: false }, { model: 'claude-opus-5-5' }, 'high'],
      ['all: the default medium is sent', { effortMode: 'all', reasoningEffort: 'medium' }, { model: 'claude-opus-4-8' }, 'medium'],
      ['all: max is never capped', { effortMode: 'all', reasoningEffort: 'max' }, { model: 'claude-opus-5-5' }, 'max'],
      ['all: xhigh on Sonnet 4.6 becomes max', { effortMode: 'all', reasoningEffort: 'xhigh' }, { model: 'claude-sonnet-4-6' }, 'max'],
      ['all: Haiku 4.5 takes no effort', { effortMode: 'all', reasoningEffort: 'high' }, { model: 'claude-haiku-4-5-20251001' }, null],
      ['all: self-talk keeps its own low', { effortMode: 'all', reasoningEffort: 'max' }, { model: 'claude-opus-5-5', reasoningEffort: 'low' }, 'low'],
      ['all: a word that names no level sends none', { effortMode: 'all', reasoningEffort: 'banana' }, { model: 'claude-opus-5-5' }, null]
    ];
    for (const [label, opts, req, want] of cases) {
      const t = await turn(opts, req);
      A.eq(t.effort, want, label + ': the child\'s --effort');
      A.eq(t.sent, asSent(t), label + ': the record names exactly what the argv carried (' + JSON.stringify(t.effort) + ' -> ' + t.sent + ')');
      const rest = t.argv.filter((a, i) => !(a === '--effort' || t.argv[i - 1] === '--effort'));
      A.eq(rest, ARGV_HEAD.concat(req.model ? ['--model', req.model] : [], ['--system-prompt-file', '<system-prompt-file>']), label + ': nothing else in the argv moved');
      if (want) A.eq(t.argv.slice(t.argv.indexOf('--effort') - 2, t.argv.indexOf('--effort')), ['--model', req.model], label + ': --effort sits where it always sat, after --model');
    }
    // the persistent child (the agent loop's own path) carries the run's effort too, and its record agrees
    for (const [mode, picked, want] of [['picked', true, 'high'], ['picked', false, null], ['all', false, 'high'], ['off', true, null]]) {
      const f = H.fakeCli();
      const p = cli.makeClaudeCliProvider({ spawn: f.spawn, fs: f.fs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux', effortMode: mode, reasoningEffort: 'high', effortPicked: picked });
      const ac = new AbortController();
      await H.collect(p, { model: 'claude-opus-5-5', messages: H.MESSAGES, tools: H.TOOLS, runId: 'run-p', signal: ac.signal });
      A.eq(H.effortIn(H.argvOf(f.spawns[0])), want, mode + (picked ? ', picked' : ', not picked') + ': the persistent child\'s --effort');
      A.eq(p.effortAsSent('claude-opus-5-5'), want || 'cli-default', mode + (picked ? ', picked' : ', not picked') + ': and its record agrees');
      p.release('run-p'); ac.abort();
    }
    // the catalog, with the switch on: each model's own levels
    {
      const f = H.fakeCli();
      const p = cli.makeClaudeCliProvider({ spawn: f.spawn, fs: f.fs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux', effortMode: 'picked' });
      const cat = await p.listModels();
      const of = id => cat.find(m => m.id === id) || {};
      A.eq([of('claude-opus-5-5').reasoningEfforts, of('claude-sonnet-4-6').reasoningEfforts, of('haiku').reasoningEfforts, of('claude-haiku-4-5-20251001').reasoningEfforts],
        [['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high', 'max'], ['low', 'medium', 'high', 'xhigh', 'max'], []], 'on: the catalog publishes each model\'s own levels');
      A.eq([of('claude-haiku-4-5-20251001').supportsReasoning, of('claude-haiku-4-5-20251001').supported_parameters, of('claude-opus-5-5').supportsReasoning], [false, ['tools'], true], 'on: a model that takes no effort says it has no effort control');
      A.eq(cat.map(m => p.reasoningEfforts(m.id)), cat.map(m => m.reasoningEfforts), 'on: reasoningEfforts(id) and the catalog agree');
    }
  }

  // ---- E. THE CHILD'S ENV: with the switch on, the flag is what runs ---------------------------------------------------------
  {
    const env = { CLAUDE_CODE_EFFORT_LEVEL: 'max' };
    const sent = await turn({ effortMode: 'picked', reasoningEffort: 'low', effortPicked: true }, { model: 'claude-opus-5-5' }, env);
    A.eq([sent.effort, 'CLAUDE_CODE_EFFORT_LEVEL' in sent.env], ['low', false], 'on, a child given --effort: the shell\'s CLAUDE_CODE_EFFORT_LEVEL is not handed to it (the record says low; low is what runs)');
    const unsent = await turn({ effortMode: 'picked', reasoningEffort: 'high', effortPicked: false }, { model: 'claude-opus-5-5' }, env);
    A.eq([unsent.effort, unsent.env.CLAUDE_CODE_EFFORT_LEVEL], [null, 'max'], 'on, a child given no flag: the variable stays (that is the CLI\'s own default, as the user set it up)');
    const off = await turn({ reasoningEffort: 'high', effortPicked: true }, { model: 'claude-opus-5-5', reasoningEffort: 'low' }, env);
    A.eq([off.effort, off.env.CLAUDE_CODE_EFFORT_LEVEL], ['low', 'max'], 'off: the env is the one it always was, flag or not');
  }

  // ---- F. A CLI THAT DOES NOT KNOW --effort ----------------------------------------------------------------------------------
  {
    const refusing = () => H.fakeCli((rec) => rec.args.indexOf('--effort') >= 0
      ? { stderr: "error: unknown option '--effort'\n", exit: 1 }
      : { lines: [{ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] }, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
        { type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } }] });
    const f = refusing();
    const make = (extra) => cli.makeClaudeCliProvider(Object.assign({ spawn: f.spawn, fs: f.fs, bin: 'old-claude.exe', env: { PATH: '' }, platform: 'linux', persist: false }, extra));
    const p = make({ effortMode: 'all', reasoningEffort: 'high' });
    const req = { model: 'claude-opus-5-5', messages: H.MESSAGES };
    let err = null;
    try { await H.collect(p, req); } catch (e) { err = e; }
    A.ok(err && /before answering/.test(err.message) && /unknown option/.test(err.message), 'an old CLI: the first child fails and says why (' + (err && err.message.slice(0, 90)) + ')');
    const ev = await H.collect(p, req);   // the loop's retry
    A.eq([ev.filter(e => e.type === 'text').map(e => e.delta).join(''), H.effortIn(H.argvOf(f.spawns[1]))], ['ok', null], 'an old CLI: the retry is started without the flag and answers');
    A.eq(p.effortAsSent('claude-opus-5-5'), 'cli-default', 'an old CLI: the record says cli-default from then on');
    const p2 = make({ effortMode: 'picked', reasoningEffort: 'max', effortPicked: true });
    await H.collect(p2, req);
    A.eq([f.spawns.length, H.effortIn(H.argvOf(f.spawns[2]))], [3, null], 'an old CLI: the next adapter for the same binary does not try the flag again');
    // off is untouched by any of it: a request's own effort still rides, and its failure is not swallowed
    const p3 = make({});
    let offErr = null;
    try { await H.collect(p3, Object.assign({ reasoningEffort: 'low' }, req)); } catch (e) { offErr = e; }
    A.ok(offErr && H.effortIn(H.argvOf(f.spawns[3])) === 'low', 'off: nothing reads the note (a request\'s own effort still rides, as before)');
    // another binary is not affected, and an unrelated failure notes nothing
    const g = H.fakeCli(() => ({ stderr: 'error: something else broke\n', exit: 1 }));
    const q = cli.makeClaudeCliProvider({ spawn: g.spawn, fs: g.fs, bin: 'other-claude.exe', env: { PATH: '' }, platform: 'linux', persist: false, effortMode: 'all', reasoningEffort: 'high' });
    for (let i = 0; i < 2; i++) { try { await H.collect(q, req); } catch (_) { /* the failure under test */ } }
    A.eq(g.spawns.map(s => H.effortIn(H.argvOf(s))), ['high', 'high'], 'a failure that is not about --effort keeps the flag');
  }

  // ---- G. THE FACTORY CARRIES IT (on a real child: a fake `claude` that logs its argv) -------------------------------------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cli-effort-'));
    const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    const log = path.join(dir, 'argv.log');
    fs.writeFileSync(log, '');
    fs.writeFileSync(path.join(pkg, 'cli.js'), [
      "'use strict';", "const fs = require('fs');", 'const args = process.argv.slice(2);', "const out = o => process.stdout.write(JSON.stringify(o) + '\\n');",
      "if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai' }); process.exit(0); }",
      'process.stdin.resume();', "process.stdin.on('end', () => {", '  fs.appendFileSync(' + JSON.stringify(log) + ", JSON.stringify(args) + '\\n');",
      "  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });",
      "  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } });",
      "  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 2 } });", '});', ''].join('\n'));
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
    const keep = process.env.STARNET_CLAUDE_BIN;
    process.env.STARNET_CLAUDE_BIN = shim;
    const factory = require('../sidecar/providers/factory.js');
    let mode = 'off';
    const lastEffort = () => { const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); return H.effortIn(JSON.parse(lines[lines.length - 1])); };
    try {
      const run = async (opts, req) => {
        const p = factory.selectProvider(Object.assign({ provider: 'claude-cli' }, opts));
        await H.collect(p, Object.assign({ model: 'claude-sonnet-4-6', messages: H.MESSAGES }, req));
        return { argv: lastEffort(), sent: p.effortAsSent('claude-sonnet-4-6', req && req.reasoningEffort) };
      };
      // no switch attached at all (a host that never calls attachClaudeCli): exactly as before
      factory.attachClaudeCli(null);
      A.eq(await run({ reasoningEffort: 'high', effortPicked: true }), { argv: null, sent: 'cli-default' }, 'factory, nothing attached: a built effort is not sent');
      factory.attachClaudeCli({ effortMode: () => mode });
      for (const [m, opts, req, want] of [
        ['off', { reasoningEffort: 'high', effortPicked: true }, {}, null],
        ['off', { reasoningEffort: 'high', effortPicked: true }, { reasoningEffort: 'low' }, 'low'],
        ['picked', { reasoningEffort: 'xhigh', effortPicked: true }, {}, 'max'],
        ['picked', { reasoningEffort: 'xhigh' }, {}, null],
        ['picked', { reasoningEffort: 'xhigh', effortPicked: 'yes' }, {}, null],
        ['picked', { reasoningEffort: 'xhigh' }, { reasoningEffort: 'low' }, 'low'],
        ['all', { reasoningEffort: 'xhigh' }, {}, 'max'],
        ['all', {}, {}, null]]) {
        mode = m;
        const r = await run(opts, req);
        A.eq(r, { argv: want, sent: want || 'cli-default' }, 'factory, ' + m + ', ' + JSON.stringify(opts) + ' ' + JSON.stringify(req) + ': selectProvider puts the clamped effort in the child\'s argv, and the record names it');
      }
      // cross-adapter conformance: what selectProvider is handed is what goes out, clamped by the one resolver
      const wire = factory.selectProvider({ provider: 'anthropic', fetch: () => { throw new Error('no network in this test'); }, key: 'k', reasoningEffort: 'xhigh' });
      for (const id of ['claude-sonnet-4-6', 'claude-opus-5-5', 'claude-opus-4-8']) {
        const want = E.clampEffort('xhigh', E.effortsFor(id));
        A.eq(wire.effortAsSent(id), want, 'conformance, anthropic, ' + id + ': the built xhigh goes out as ' + want);
        mode = 'all';
        A.eq((await run({ reasoningEffort: 'xhigh' }, { model: id })).argv, E.cliEffortFor(id, 'xhigh'), 'conformance, claude-cli (all), ' + id + ': the same effort, the same clamp (' + want + ')');
      }
    } finally {
      factory.attachClaudeCli(null);
      if (keep === undefined) delete process.env.STARNET_CLAUDE_BIN; else process.env.STARNET_CLAUDE_BIN = keep;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a temp folder the OS reaps */ }
    }
  }

  // ---- H. THE HOST: one switch reader, one pick rule, the run sites ---------------------------------------------------------
  {
    const idx = read('sidecar/index.js');
    A.eq((idx.match(/ENV\('CLI_EFFORT'\)/g) || []).length, 1, 'the switch is read in one place (cliEffortMode, through ENV)');
    A.ok(/function cliEffortMode\(\) \{ return EffortClamp\.cliMode\(ENV\('CLI_EFFORT'\)\); \}/.test(idx) && /attachClaudeCli\(\{ compactTools: cliCompactTools, effortMode: cliEffortMode \}\);/.test(idx), '...and handed to the factory once');
    A.ok(!/CLI_EFFORT/.test(read('sidecar/providers/claude-cli.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')) && !/process\.env/.test(read('sidecar/providers/effort-clamp.js')), 'neither the adapter nor the resolver reads the environment for it');
    const pick = A.fnBody(idx, 'function effortPickedFor(agentId, asked, wire) {');
    A.ok(/row\.effortPicked === true && normalizeReasoningEffort\(row\.reasoningEffort\) === asked/.test(pick) && /wire\.followsStation/.test(pick), 'a pick is the marked roster row the effort rule read, at the effort the run resolved');
    A.eq((idx.match(/effortPickedFor\(/g) || []).length, 2, 'one pick rule, called once per run');
    const built = idx.match(/selectProvider\(\{[^}]*\beffortPicked\b[^}]*\}\)/g) || [];
    A.eq(built.length, 3, 'the run hands its pick to every claude-cli adapter it may run on (each sign-in, the primary included, and a provider fallback)');
    A.ok(/const effortPicked = cliEffortMode\(\) === EffortClamp\.CLI_PICKED && effortPickedFor\(agentId, reasoningEffort, runWire\);/.test(idx) && /if \(first\.id \|\| effortPicked\) \{ provider = onAccount\(first\);/.test(idx),
      'only the picked mode asks, and a picked effort rebuilds the primary sign-in\'s adapter with it (off and all build exactly as before)');
    A.ok(built.every(s => /reasoningEffort, effortPicked/.test(s)), '...together with the effort it belongs to');
    // the roster keeps the mark only when it is set
    A.ok(/\.\.\.\(\(a && a\.effortPicked === true && a\.reasoningEffort\) \? \{ effortPicked: true \} : \{\}\),/.test(idx) && /if \(a\.effortPicked === true && a\.reasoningEffort\) known\.effortPicked = true;/.test(idx), 'a roster row carries the mark only when set (every other row is byte-identical)');
    A.ok(/cliEffortMode\(\) !== EffortClamp\.CLI_OFF \? \{ cliEffort: cliEffortMode\(\) \} : \{\}/.test(idx), 'GET /api/providers says the switch only when it is on');
  }

  // ---- I. THE PAGE: a pick is marked only at a hand action that names an effort -----------------------------------------------
  {
    const app = read('frontend/app/app.js');
    const a = app.indexOf("  const TIER_MODELS_KEY = 'starnet.tierModels.v1';"), b = app.indexOf('  // a backend-valid, collision-free agentId for a summon', a);
    A.ok(a > 0 && b > a, 'fixture: the loadout section of app.js');
    const section = (cliEffort) => vm.compileFunction(app.slice(a, b) + '\nreturn { applyLoadout, noteEffortPick, effortPickOf, effortSourceOf };',
      ['localStorage', 'Harness', 'ModelDock', 'CrewDefaults', 'Specialties', 'stationDefaultWire', 'agent'])(
      { getItem: () => null, setItem: () => {} }, { crewDefaults: () => 'off', cliEffort: cliEffort === undefined ? undefined : () => cliEffort, getModel: () => '', getProv: () => '' },
      { catalogIds: () => null }, require('../frontend/app/crewdefaults.js'), { get: () => null }, () => ({ model: '', provider: '', effort: '' }), { id: 'agent', model: 'claude-opus-5-5', provider: 'claude-cli', reasoningEffort: 'medium' });
    const classHigh = { id: 'engineer', model: 'reasoning', reasoningEffort: 'high' }, noEffort = { id: 'scribe', model: 'balanced' };
    const summon = (S, spec, pin) => { const ag = { id: 'w1', model: 'claude-opus-5-5', provider: 'claude-cli', reasoningEffort: (pin && pin.effort) || 'medium' }; S.applyLoadout(ag, spec, pin || null); return ag; };
    for (const mode of ['picked', 'all']) {
      const S = section(mode);
      A.eq([summon(S, classHigh).reasoningEffort, 'effortPicked' in summon(S, classHigh)], ['high', false], mode + ': a class-applied effort is not a pick');
      A.eq('effortPicked' in summon(S, noEffort), false, mode + ': an effort copied from the Overseer at summon is not a pick');
      A.eq([summon(S, classHigh, { model: '', provider: '', effort: 'max' }).reasoningEffort, summon(S, classHigh, { model: '', provider: '', effort: 'max' }).effortPicked], ['max', true], mode + ': the summon card\'s own effort is a pick');
      A.eq('effortPicked' in summon(S, classHigh, { model: 'claude-sonnet-5-5', provider: 'claude-cli', effort: '' }), false, mode + ': a model picked on the card with effort auto is not a pick');
      A.eq([S.effortPickOf({ id: 'x', reasoningEffort: 'high', effortPicked: true }), S.effortPickOf({ id: 'x', reasoningEffort: 'high' }), S.effortPickOf({ id: 'x', reasoningEffort: null, effortPicked: true })], [{ effortPicked: true }, {}, {}], mode + ': the roster row carries the mark only when set');
      A.eq([S.effortSourceOf({ id: 'x', reasoningEffort: 'high', effortPicked: true }), S.effortSourceOf({ id: 'x', reasoningEffort: 'high', effortSource: 'class' })], [{ effortPicked: true }, {}], mode + ': what the roster push spreads (effortSourceOf) carries the pick mark, and no W3.3 marker while that switch is off');
      const ag = { id: 'x', reasoningEffort: 'high' };
      S.noteEffortPick(ag, true); const marked = ag.effortPicked; S.noteEffortPick(ag, false);
      A.eq([marked, 'effortPicked' in ag], [true, false], mode + ': the mark is set by a pick and dropped when the effort stops being one');
    }
    for (const off of ['off', undefined]) {
      const S = section(off);
      const ag = summon(S, classHigh, { model: '', provider: '', effort: 'max' });
      A.eq(['effortPicked' in ag, S.effortPickOf({ id: 'x', reasoningEffort: 'high', effortPicked: true }), S.effortSourceOf({ id: 'x', reasoningEffort: 'high', effortPicked: true })], [false, {}, {}], 'off (' + off + '): no mark is written and none is sent (the roster push is the one it always was)');
      const old = { id: 'x', reasoningEffort: 'high', effortPicked: true };
      S.noteEffortPick(old, true);
      A.eq('effortPicked' in old, false, 'off (' + off + '): a hand pick drops a mark an earlier on-period left (nobody vouches for it)');
    }
    // the three other hand actions, run from the page's own source with the station seams stubbed
    const world = (cliEffort, focus) => {
      const agents = new Map([['agent', { id: 'agent', name: 'NOVA', model: 'claude-opus-5-5', provider: 'claude-cli', reasoningEffort: 'medium' }],
        ['eng', { id: 'eng', name: 'ENG', model: 'claude-opus-5-5', provider: 'claude-cli', reasoningEffort: 'high', effortSource: 'class' }]]);
      const src = ['function noteEffortSource(', 'function cliEffortOn(', 'function noteEffortPick(', 'function setAgentModelPin(', 'function applyQuickModel('].map(h => A.fnBody(app, h)).join('\n');
      const fn = new Function('CTX', `
        const agents = CTX.agents; let agent = agents.get(CTX.focus);
        const Harness = { cliEffort: () => CTX.cliEffort, crewDefaults: () => 'off', setModel() {}, setProv() {}, setReasoningEffort() {}, getModel: () => agent.model, getProv: () => agent.provider, normalizeReasoningEffort: e => String(e || 'medium') };
        const CrewDefaults = { isOn: () => false };
        function crewDefaultsOn() { return false; }
        function normalizeProviderId(p) { return p; } function noteWirePin() {} function applyWire() {} function focusWire() { return {}; }
        function el() { return null; } function syncChannels() {} function pushRoster() {} function persist() {}
        function providerLabel(p) { return p; } function shortModelLabel(m) { return m; } function effortLabel(e) { return e; }
        ${src}
        return { setAgentModelPin, applyQuickModel };`);
      return Object.assign(fn({ agents, cliEffort, focus: focus || 'eng' }), { agents });
    };
    {
      const w = world('picked');
      w.applyQuickModel({ model: 'claude-sonnet-5-5', provider: 'claude-cli', effort: 'high', reason: 'model' });
      A.eq('effortPicked' in w.agents.get('eng'), false, 'a dock MODEL press that carries a class-applied high along does not make it a pick');
      w.applyQuickModel({ model: 'claude-sonnet-5-5', provider: 'claude-cli', effort: 'high', reason: 'effort' });
      A.eq(w.agents.get('eng').effortPicked, true, 'the dock EFFORT press is a pick, even at the level the class had written');
      w.applyQuickModel({ model: 'claude-opus-5-5', provider: 'claude-cli', effort: 'high', reason: 'model' });
      A.eq(w.agents.get('eng').effortPicked, true, 'a later model press that keeps the picked effort keeps the mark');
      w.applyQuickModel({ model: 'claude-sonnet-4-6', provider: 'claude-cli', effort: 'max', reason: 'catalog_reconcile' });
      A.eq('effortPicked' in w.agents.get('eng'), false, 'a catalog change that moved the effort to a level nobody picked drops the mark');
    }
    {
      const w = world('picked');
      w.setAgentModelPin('eng', 'claude-sonnet-5-5', 'claude-cli', 'high');
      A.eq('effortPicked' in w.agents.get('eng'), false, 'a pin saved with the effort the class had written keeps it a class effort');
      w.setAgentModelPin('eng', 'claude-sonnet-5-5', 'claude-cli', 'max');
      A.eq([w.agents.get('eng').reasoningEffort, w.agents.get('eng').effortPicked], ['max', true], 'a pin saved with ANOTHER effort is a pick');
      w.setAgentModelPin('eng', 'claude-opus-5-5', 'claude-cli', 'max');
      A.eq(w.agents.get('eng').effortPicked, true, 'a pin saved again with that effort keeps the mark');
      w.setAgentModelPin('eng', '', '', '');
      A.eq([w.agents.get('eng').reasoningEffort, 'effortPicked' in w.agents.get('eng')], [null, false], 'clearing the pin clears the effort and its mark');
    }
    {
      const w = world('off');
      w.applyQuickModel({ model: 'claude-sonnet-5-5', provider: 'claude-cli', effort: 'max', reason: 'effort' });
      w.setAgentModelPin('agent', 'claude-opus-5-5', 'claude-cli', 'max');
      A.eq(['effortPicked' in w.agents.get('eng'), 'effortPicked' in w.agents.get('agent')], [false, false], 'off: no hand action writes a mark');
    }
    A.ok(/noteEffortSource\(a, 'pin', true\); if \(storedAgent && storedAgent !== a\) noteEffortSource\(storedAgent, 'pin', true\);/.test(app), '/reasoning and /fast (applyConfig\'s effort patch) are picks');
    A.ok(/if \(pick !== undefined\) noteEffortPick\(a, pick\);/.test(A.fnBody(app, 'function noteEffortSource(')), 'the hand actions say it through the one function they already call (noteEffortSource\'s third argument)');
    A.ok(/function effortSourceOf\(a\) \{ return Object\.assign\(crewEffortSourceOf\(a\), effortPickOf\(a\)\); \}/.test(app) && /\.\.\.effortSourceOf\(a\) \}\)\);/.test(app) && /\.\.\.\(a\.effortPicked === true \? \{ effortPicked: true \} : \{\}\) \};/.test(app) && /s\.effortPicked === true\) a\.effortPicked = true;/.test(app),
      'the mark rides the roster push, the save and the restore');
    const h = read('frontend/app/harness.js');
    A.ok(/cliEffortMode = \(j && \(j\.cliEffort === 'picked' \|\| j\.cliEffort === 'all'\)\) \? j\.cliEffort : 'off';/.test(h) && /\bcrewDefaults, cliEffort, /.test(h), 'the page learns the switch from GET /api/providers');
    for (const f of ['app.js', 'harness.js', 'chat.js', 'provider-registry.js'])
      A.ok(read('frontend/app/' + f) === read('website/app/app/' + f), 'website/app/app/' + f + ' is the same file');
  }

  // ---- J. THE DIAL'S LINES FOLLOW THE SWITCH (COMMS and the terminal read one fact) ----------------------------------------
  {
    A.eq([registry.effortDialWiring('claude-cli', { cliEffort: 'picked' }), registry.effortDialWiring('claude-code', { cliEffort: 'all' }), registry.effortDialWiring('claude-cli', { cliEffort: 'off' }), registry.effortDialWiring('claude-cli', {}),
      registry.effortDialWiring('claude-cli'), registry.effortDialWiring('claude-cli', { cliEffort: 'yes' }), registry.effortDialWiring('openrouter', { cliEffort: 'all' }), registry.effortDialWiring('', { cliEffort: 'all' })],
      ['picked', 'all', '', '', '', '', '', ''], 'the registry: only the Claude sign-in route is wired by the switch, and only while it is on');
    A.eq(registry.effortDialReachesRuns('claude-cli'), false, 'the route\'s own fact is unchanged (off: the dial does not reach its runs)');
    const src = read('frontend/app/chat.js');
    const parts = ['function effortReachesModel(', 'function reasoningModelNote(', 'function reasoningLevelOf(', 'function reasoningCommand(', 'function fastCommand('].map(h => A.fnBody(src, h));
    const levels = /const REASONING_LEVELS = \[[^\]]*\];/.exec(src), aliases = /const MEDIUM_ALIASES = \[[^\]]*\];/.exec(src);
    const comms = (prov, effort, cliEffort) => {
      const lines = [], store = { effort };
      const sandbox = { lines, SK: { providers: { registry } },
        Harness: { getProv: () => prov, getModel: () => 'some-model', getReasoningEffort: () => store.effort, cliEffort: () => cliEffort,
          normalizeReasoningEffort: (raw) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].indexOf(raw) >= 0 ? raw : 'medium' },
        App: { applyConfig: (c) => { if (c && c.reasoningEffort) store.effort = c.reasoningEffort; } } };
      vm.createContext(sandbox);
      vm.runInContext([levels[0], aliases[0], 'function localLine(t) { lines.push(t); }'].concat(parts).join('\n') + '\nthis.fast = fastCommand; this.reasoning = reasoningCommand;', sandbox);
      return { fast: () => { sandbox.fast(); return lines[lines.length - 1]; }, reasoning: (x) => { sandbox.reasoning(x); return lines[lines.length - 1]; } };
    };
    const UNREACHED = ' Note: Claude Code runs your messages on its own default effort, so this setting does not change them.';
    const PICKED = ' Note: Claude Code is given an effort you set yourself; one that came from an agent\'s class runs on Claude Code\'s own default.';
    A.eq(comms('claude-cli', 'high', 'off').reasoning('low'), 'Reasoning effort: high → low (for claude-cli).' + UNREACHED, 'COMMS, off: the line it had');
    A.eq(comms('claude-cli', 'high', 'all').reasoning('low'), 'Reasoning effort: high → low (for claude-cli). Takes effect on your next message.', 'COMMS, all: the dial reaches the next message, and the line says so');
    A.eq(comms('claude-cli', 'high', 'all').fast(), 'Reasoning effort: high → minimal — quicker, cheaper replies. /reasoning high to put it back.', 'COMMS, all: /fast reads as on any other route');
    A.eq(comms('claude-cli', 'high', 'picked').reasoning('low'), 'Reasoning effort: high → low (for claude-cli). Takes effect on your next message.' + PICKED, 'COMMS, picked: the effort just set reaches the next message, and the note says which efforts do');
    A.eq(comms('claude-cli', 'high', 'picked').reasoning(''), 'Reasoning effort: high (for claude-cli). Set it with /reasoning none|minimal|low|medium|high|xhigh — lower answers faster and cheaper, higher thinks longer first.' + PICKED,
      'COMMS, picked: the status line does not claim a class effort is in force');
    A.eq(comms('openrouter', 'high', 'picked').reasoning('low'), 'Reasoning effort: high → low (for openrouter). Takes effect on your next message.', 'COMMS: another route is untouched by the switch');

    const dash = read('bin/lib/dashboard.js');
    const from = dash.indexOf('  const REASONING_LEVELS = '), fastAt = dash.indexOf('  function fastCommand(', from), to = dash.indexOf('\n  }\n', fastAt) + 4;
    A.ok(from > 0 && fastAt > from && to > fastAt, 'fixture: the dashboard declares its dial commands in one block');
    const terminal = async (provider, effort, cliEffort, run) => {
      const said = [];
      const agent = { id: 'agent', name: 'ADA', model: 'some-model', provider, reasoningEffort: effort, wireSource: 'agent' };
      const client = { request: (m, route) => Promise.resolve(route === '/api/providers' ? { ok: true, status: 200, json: cliEffort ? { providers: [], cliEffort } : { providers: [] } } : { ok: true, status: 200, json: { ok: true } }) };
      const api = new Function('model', 'ui', 'client', 'sayHere', 'unconfirmed', 'providerRegistry', dash.slice(from, to) + '\nreturn { setEffort, reasoningCommand, fastCommand };')(
        { state: { agents: new Map([['agent', agent]]) } }, { focus: 'agent' }, client, (cmd, lines) => said.push(lines.join(' ')), () => null, registry);
      await run(api);
      return said[said.length - 1];
    };
    A.eq(await terminal('claude-cli', 'high', '', t => t.reasoningCommand('low')), 'Reasoning effort: high → low for ADA.' + UNREACHED, 'terminal, off: the line it had');
    A.eq(await terminal('claude-cli', 'high', 'all', t => t.reasoningCommand('low')), 'Reasoning effort: high → low for ADA. Takes effect on your next message.', 'terminal, all: the dial reaches the next message');
    A.eq(await terminal('claude-cli', 'high', 'picked', t => t.fastCommand()), 'Reasoning effort: high → minimal for ADA. Takes effect on your next message. /reasoning high puts it back.' + PICKED, 'terminal, picked: /fast is a pick, and the note says which efforts reach a run');
    A.eq(await terminal('claude-cli', 'high', 'picked', t => t.reasoningCommand('')), 'Reasoning effort: high. Set it with /reasoning none|minimal|low|medium|high|xhigh — lower answers faster and cheaper, higher thinks longer first.' + PICKED, 'terminal, picked: the status line');
    A.eq(await terminal('openrouter', 'high', 'picked', t => t.reasoningCommand('low')), 'Reasoning effort: high → low for ADA. Takes effect on your next message.', 'terminal: another route is untouched by the switch');
  }

  A.report('claude-cli-effort.test');
})().catch(e => { console.error(e); process.exit(1); });
