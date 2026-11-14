/* node test/claude-cli-replay-ledger.test.js — THE CLAUDE CODE REPLAY LEDGER (cost lane W3.7, 2026-11-14).

   On the Claude sign-in route every new message of a conversation is a new run with a new `claude` child that is given
   the whole conversation again. The last run's first request ended with its ask carrying its host notes; today's history
   carries that ask bare, so the bytes differ at that block and the CLI, which caches a request up to its last block,
   reads only the system prompt and writes the whole conversation again on every message. With the switch on
   (STARNET_CLI_REPLAY_LEDGER=1 -> index.js cliReplayStream -> loop.js req.replay) the ledger
   (sidecar/providers/cli-replay-ledger.js) sends the history entries of the last run's first request again as they were
   sent, so the new request starts with the bytes that one ended on.

   A. OFF IS THE BASE, BYTE FOR BYTE. Without req.replay every child's argv, system prompt file and stdin are the bytes
      the base commit sent (test/fixtures/cli-replay-ledger-base.json: sha256 of each, recorded from the base's
      claude-cli.js), on the persistent path, the one-shot path and a tool-less chat turn; before and after the ledger
      has records.
   B. ON: A STABLE PREFIX. Across a 12-message chat on one stream, message N+1's first request starts with the exact
      bytes of message N's first request up to its end; the share of a request that is such a prefix is printed, off and
      on. The newest message's own entry is today's, byte for byte; no entry is added; past notes sit before the newest
      run's ids; the first request stays prose; the system prompt differs from OFF by one fixed sentence; the argv and
      every later turn of the run are OFF's bytes. Past notes are capped: over the cap the request is OFF's bytes.
   C. THE FALLBACKS. Another model, account, system prompt, tool list or effort; an edited history; a ledger that lost
      its records (a restart); a throw; a session deleted or a memory forgotten since the last message (the host's forget
      epoch); a record older than its cache entry; a note over the cap; an image; a request
      with no run-context note; a call nothing reads again: today's bytes. A retried message gets today's note, never the
      old one. A replacement child of the same run renders the history its run's first request did.
   D. THE BOUNDS: streams, lineages and bytes are capped, least recently used first; a record over the limit is not kept.
   E. TELEMETRY: a usage event says how the call was served and the usage receipt keeps it (child, replay…), with the
      switch off too (child only).
   F. THE SWITCH: read at one place (index.js cliReplayStream), '1' only; the loop puts req.replay on a request only
      when the host names a stream.

   Re-record the base fixture ONLY from the base's own claude-cli.js (put `git show <base>:sidecar/providers/claude-cli.js`
   in place, run `node test/claude-cli-replay-ledger.test.js --record <base sha>`, restore the lane's file).
   Hermetic: EventEmitter children stand in for `claude` (no process, no model). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const CLI = require('../sidecar/providers/claude-cli.js');
const { makeClaudeCliProvider } = CLI;
const Ledger = require('../sidecar/providers/cli-replay-ledger.js');
const { makeUsageReceipts } = require('../sidecar/usage-receipts.js');
const { counts: failCounts } = require('../sidecar/failopen.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { sidecarFunctionSource, readSidecarSource } = require('./helpers/source.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'cli-replay-ledger-base.json');
const RECORD = process.argv.indexOf('--record');

/* ---- the fake CLI: records each child's argv, its system prompt FILE and every stdin line as written ---- */
function makeRig(apiKeySource) {
  const spawns = [], files = {};
  let script = () => [];
  function spawn(file, args, opts) {
    const child = new EventEmitter();
    const pipe = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = pipe(); child.stderr = pipe();
    child.pid = 9100 + spawns.length; child.exitCode = null;
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    if (file === 'taskkill') {
      const target = spawns.find(r => String(r.child.pid) === args[1]);
      if (target) target.child.kill();
      setImmediate(() => exit(0));
      child.kill = () => exit(null);
      return child;
    }
    const at = args.indexOf('--system-prompt-file');
    const rec = { args: args.map((a, i) => (at >= 0 && i === at + 1 ? '<sysfile>' : a)), env: opts && opts.env, inputs: [], child, system: at >= 0 ? files[args[at + 1]] : null };
    spawns.push(rec);
    child.kill = () => exit(null);
    const out = l => { if (child.exitCode == null) child.stdout.emit('data', JSON.stringify(l) + '\n'); };
    const answer = line => {
      rec.inputs.push(String(line));
      const n = rec.inputs.length;
      setImmediate(() => { if (child.exitCode == null) for (const l of (script({ rec, n }) || [])) out(l); });
    };
    child.stdin = {
      on() {},
      write(line) { answer(line); return true; },
      end(line) { if (line) answer(line); setImmediate(() => setImmediate(() => exit(0))); }
    };
    return child;
  }
  const fsFake = { statSync() { return { isFile: () => true }; }, writeFileSync(p, d) { files[p] = String(d); }, unlinkSync() {} };
  const key = apiKeySource === undefined ? 'none' : apiKeySource;
  const init = () => ({ type: 'system', subtype: 'init', apiKeySource: key, tools: [] });
  const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  const result = text => ({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 } });
  return {
    spawns,
    adapter: extra => makeClaudeCliProvider(Object.assign({ spawn, fs: fsFake, bin: 'claude.exe', env: { PATH: '' }, platform: 'win32', persistEndGraceMs: 50 }, extra || {})),
    script(fn) { script = fn; },
    says: text => [init(), delta(text), result(text)],                                  // a reply that ends on its own
    guesses: text => [init(), delta(text), delta('\n\nThe file probably says hi.')]     // writes on past its block: the child is closed
  };
}
const invoke = (name, args) => '<function_calls>\n<invoke name="' + name + '">\n' + Object.keys(args || {}).map(k => '<parameter name="' + k + '">' + args[k] + '</parameter>\n').join('') + '</invoke>\n</function_calls>';
const fn = (name, description, properties) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: properties || {} } } });
const READ = fn('fs_read', 'read a file', { path: { type: 'string' } });
const WRITE = fn('fs_write', 'write a file', { path: { type: 'string' }, content: { type: 'string' } });

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

/* ---- the conversation: sizes as the audit and this lane measured them (a user row ~350 chars, a reply ~1,200; a per-run
        note 2.4-3.0 KB on a fresh station, plus recall) ---- */
const WORDS = ['station', 'ledger', 'window', 'orbit', 'signal', 'cargo', 'relay', 'beacon', 'harbor', 'vector', 'copper', 'lantern'];
function filler(seed, chars) {
  let h = 0, out = '';
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  while (out.length < chars) { h = (h * 1103515245 + 12345) >>> 0; out += WORDS[h % WORDS.length] + ((h >>> 8) % 9 === 0 ? '.\n' : ' '); }
  return out.slice(0, chars).trim();
}
const STABLE = 'You are NOVA, the lead of this station.\n[HARNESS] ' + filler('harness', 3000);
const SYSTEM = STABLE + '\n\n[SERVICE KEYS] none stored.\n[TASK BRIEF] ' + filler('doctrine', 700);
const ask = n => 'Message ' + n + ': ' + filler('ask' + n, 330);
const answer = n => 'Answer ' + n + ': ' + filler('answer' + n, 1150);
const runContext = (n, chars) => '<run_context>\n## SAVED AGENT SKILLS\n' + filler('skills' + n, chars - 260) + '\n<task_brief id="tb_run-' + n + '" status="ready">\nORIGINAL REQUEST: '
  + ask(n).slice(0, 60) + '\n</task_brief>\n[RUNTIME]\nRun id: run-' + n + '\nToday is Saturday, November 14, 2026.\n</run_context>';
const recall = n => '<recalled-memory>\n- the Commander wants short tables (feedback after message ' + n + ')\n' + filler('recall' + n, 480) + '\n</recalled-memory>';
const crew = n => '<crew_call>\n[CREW CALL] message ' + n + ': do this one yourself.\n</crew_call>';

/* chat(o) -> runs[]: o.messages messages on one stream, each a new run on a FRESH adapter (as the factory builds one per
   run). A run with tools is two requests (a tool call, then the answer); without tools it is one. o.replay puts
   req.replay on every request, as the loop does when the host names the stream. o.perRun(n) overrides o for message n. */
async function chat(o) {
  const rig = makeRig(o.apiKeySource);
  const runs = [], history = [];
  let at = 1000000;
  for (let n = 1; n <= o.messages; n++) {
    const ov = Object.assign({}, o, o.perRun ? (o.perRun(n) || {}) : {});
    if (typeof ov.before === 'function') ov.before(n);
    if (n > 1) at += ov.gapMs != null ? ov.gapMs : 60000;
    const made = rig.adapter(Object.assign({}, ov.persist === false ? { persist: false } : {}, ov.ledger ? { replayLedger: ov.ledger } : {}, ov.configDir ? { configDir: ov.configDir } : {}));
    const p = typeof ov.wrap === 'function' ? ov.wrap(made) : made;
    const ac = new AbortController();
    const tools = ov.tools || [];
    const runId = 'run-' + n;
    const req = msgs => Object.assign({ model: ov.model || 'sonnet', tools, messages: msgs.slice(), runId, signal: ac.signal, cacheSystemPrefix: STABLE },
      ov.effort ? { reasoningEffort: ov.effort } : {}, ov.neverReread ? { neverReread: true } : {}, ov.replay ? { replay: { stream: ov.stream || 'ws_chat', at, epoch: ov.epoch || '0:0' } } : {});
    const hist = typeof ov.historyOf === 'function' ? ov.historyOf(history.slice()) : history;
    const askMsg = typeof ov.askOf === 'function' ? ov.askOf(n) : { role: 'user', content: ask(n) };
    const msgs = [{ role: 'system', content: ov.system || SYSTEM }].concat(hist, ov.noRunNote ? [] : [{ role: 'system', content: runContext(n, ov.noteChars || 2600) }],
      [{ role: 'system', content: recall(n) }, askMsg], n % 2 ? [{ role: 'system', content: crew(n) }] : []);
    const from = rig.spawns.length, events = [];
    rig.script(() => (ov.overrun ? rig.guesses : rig.says)(tools.length ? invoke('fs_read', { path: 'notes/' + n + '.md' }) : answer(n)));
    events.push(await collect(p, req(msgs)));
    let final = reply(events[0]);
    if (tools.length) {
      msgs.push(final, ...results(final, 'notes/' + n + '.md holds: ' + filler('file' + n, 500)));
      if (typeof ov.midRun === 'function') ov.midRun(msgs);
      rig.script(() => rig.says(answer(n)));
      events.push(await collect(p, req(msgs)));
      final = reply(events[1]);
    }
    made.release(runId);
    runs.push({ n, spawns: rig.spawns.slice(from), stats: made.persistStats(), events });
    history.push({ role: 'user', content: askMsg.content }, { role: 'assistant', content: final.content });
  }
  return runs;
}

// a run's FIRST request: the content blocks of the first stdin line of its first child
const blocksOf = run => JSON.parse(run.spawns[0].inputs[0]).message.content;
const ser = blocks => JSON.stringify(blocks);
const size = blocks => Buffer.byteLength(ser(blocks));
// does `cur` start with the exact bytes of `prev` up to its end (every block of prev, then more)?
const extendsPrev = (prev, cur) => ser(cur).startsWith(ser(prev).slice(0, -1) + ',');
const verdictOf = run => Object.keys(run.stats.replay || {}).join('+');
const cliOf = (run, turn) => { const u = run.events[turn || 0].find(e => e.type === 'usage'); return u ? u.cli : undefined; };
// the share of every later message's first request that is the last message's WHOLE first request (what the CLI's cache
// can give back: an entry exists only where a request ended)
function share(runs) {
  let stable = 0, total = 0;
  for (let i = 1; i < runs.length; i++) { const prev = blocksOf(runs[i - 1]), cur = blocksOf(runs[i]); total += size(cur); if (extendsPrev(prev, cur)) stable += size(prev); }
  return { stable, total, pct: total ? Math.round(1000 * stable / total) / 10 : 0 };
}

/* ---- A: what the base sends, as digests (tool-call ids carry a random per-adapter tag: it is masked) ---- */
const norm = s => String(s).replace(/call_cli_[0-9a-f]{8}_/g, 'call_cli_ID_');
const sha = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const digest = runs => runs.map(r => r.spawns.map(s => ({ args: sha(JSON.stringify(s.args)), system: sha(s.system == null ? '' : s.system), inputs: s.inputs.map(l => sha(norm(l))),
  bytes: Buffer.byteLength(s.system || '') + s.inputs.reduce((k, l) => k + Buffer.byteLength(norm(l)), 0) })));
const CASES = {
  'persistent child, 8 messages': () => chat({ messages: 8, tools: [READ] }),
  'one-shot turns (STARNET_CLAUDE_CLI_PERSIST=0), 4 messages': () => chat({ messages: 4, tools: [READ], persist: false }),
  'chat turns (no tools), 4 messages': () => chat({ messages: 4, tools: [] })
};

(async () => {
  if (RECORD >= 0) {
    const cases = {};
    for (const name of Object.keys(CASES)) cases[name] = digest(await CASES[name]());
    fs.writeFileSync(FIXTURE, JSON.stringify({
      about: 'sha256 of every claude child\'s argv, system prompt file and stdin lines for the conversations test/claude-cli-replay-ledger.test.js drives, as the BASE commit\'s sidecar/providers/claude-cli.js sends them (tool-call ids masked). The lane must send exactly these with the replay ledger off. Re-record only from the base\'s own claude-cli.js (see the test header).',
      recordedFrom: String(process.argv[RECORD + 1] || 'unknown'), cases }, null, 1) + '\n', 'utf8');
    console.log('recorded ' + Object.keys(cases).length + ' cases -> ' + path.relative(path.join(__dirname, '..'), FIXTURE));
    return;
  }
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const REPLAY = CLI._internals.replayLedger;
  A.ok(!!REPLAY && typeof REPLAY.plan === 'function', 'the adapter module keeps one replay ledger for every adapter the factory builds');
  if (REPLAY) REPLAY.clear();

  async function offIsBase(when) {
    for (const name of Object.keys(CASES)) {
      const got = digest(await CASES[name]()), want = golden.cases[name] || [];
      const diff = [];
      got.forEach((run, i) => run.forEach((s, j) => {
        const w = (want[i] || [])[j];
        if (!w) { diff.push('message ' + (i + 1) + ' child ' + j + ': not in the base'); return; }
        if (s.args !== w.args) diff.push('message ' + (i + 1) + ' child ' + j + ': argv');
        if (s.system !== w.system) diff.push('message ' + (i + 1) + ' child ' + j + ': system prompt file');
        s.inputs.forEach((h, k) => { if (h !== w.inputs[k]) diff.push('message ' + (i + 1) + ' child ' + j + ': stdin line ' + k); });
        if (s.bytes !== w.bytes) diff.push('message ' + (i + 1) + ' child ' + j + ': ' + s.bytes + ' bytes, base ' + w.bytes);
      }));
      A.eq(diff.slice(0, 6), [], 'A (' + when + '): OFF IS THE BASE, BYTE FOR BYTE - ' + name + ': every child\'s argv, system prompt file and stdin (base ' + golden.recordedFrom + ')');
      A.eq(JSON.stringify(got), JSON.stringify(want), 'A (' + when + '): ' + name + ': the same children and the same number of lines as the base');
    }
  }
  await offIsBase('before any record');
  A.eq(REPLAY && REPLAY.stats(), { streams: 0, lineages: 0, bytes: 0 }, 'A: a request without req.replay never touches the ledger');

  /* ---- B. ON: a 12-message chat on one stream ---- */
  {
    const off = await chat({ messages: 12, tools: [READ] });
    const on = await chat({ messages: 12, tools: [READ], replay: true });   // the module's own ledger, as in the app
    const offShare = share(off), onShare = share(on);
    const rewritten = s => s.total - s.stable;
    console.log('[replay-ledger] prefix-stable share of a message\'s first request (bytes that are the last message\'s whole first request), 12 messages: OFF '
      + offShare.pct + '% (' + offShare.stable + ' of ' + offShare.total + ' bytes) -> ON ' + onShare.pct + '% (' + onShare.stable + ' of ' + onShare.total + ' bytes); bytes outside that prefix: OFF '
      + rewritten(offShare) + ' -> ON ' + rewritten(onShare) + ' (' + Math.round(1000 * (1 - rewritten(onShare) / rewritten(offShare))) / 10 + '% fewer)');
    // the same bytes at the API's list weights (a cache read 0.1x; a write 2x on the 1-hour tier, 1.25x on the 5-minute tier). How a plan's
    // usage window weighs a cache write is not published: these are list-price proxies, never a measured plan saving.
    const weighed = (s, w) => Math.round(w * rewritten(s) + 0.1 * s.stable);
    console.log('[replay-ledger] at list weights: 1-hour tier OFF ' + weighed(offShare, 2) + ' -> ON ' + weighed(onShare, 2) + ' byte-equivalents (' + Math.round(1000 * (1 - weighed(onShare, 2) / weighed(offShare, 2))) / 10
      + '% fewer); 5-minute tier OFF ' + weighed(offShare, 1.25) + ' -> ON ' + weighed(onShare, 1.25) + ' (' + Math.round(1000 * (1 - weighed(onShare, 1.25) / weighed(offShare, 1.25))) / 10 + '% fewer)');
    A.eq(offShare.stable, 0, 'B: OFF, no message\'s first request starts with the last one (its ask is replayed without its notes): nothing past the system prompt is read');
    A.ok(onShare.pct >= 70, 'B: ON, most of every later request is the last request, byte for byte: ' + onShare.pct + '%');

    // the cap rule, from the bytes themselves: a message replays while the past notes it would carry fit the cap
    const newest = off.map(r => { const b = blocksOf(r); return b[b.length - 1].text; });          // message m's own entry, notes included
    const lastOff = blocksOf(off[off.length - 1]);
    const noteLen = m => newest[m].length - lastOff[2 * m].text.length;                            // its notes (m < 11: its bare entry is in the last request's history)
    const want = ['none'];
    let past = 0;
    for (let k = 1; k < on.length; k++) { past += noteLen(k - 1); if (past > Ledger.DEFAULTS.noteMax) { want.push('notes'); past = 0; } else want.push('hit'); }
    A.eq(on.map(verdictOf), want, 'B: every message after the first replays (hit) until the past notes pass the cap, then one message is today\'s bytes (notes)');
    A.ok(want.indexOf('notes') > 1 && want.lastIndexOf('hit') > want.indexOf('notes'), 'B: this chat crosses the cap once and replays again after it: ' + want.join(' '));

    const REPLAY_NOTE = CLI._internals.REPLAY_NOTE;
    A.ok(Buffer.byteLength(REPLAY_NOTE) > 100 && Buffer.byteLength(REPLAY_NOTE) <= 340, "B: the one sentence ON adds to the system prompt is " + Buffer.byteLength(REPLAY_NOTE) + " bytes (budget 340: a longer one is a review prompt)");
    const sys0 = on[0].spawns[0].system;
    for (let i = 0; i < on.length; i++) {
      const onB = blocksOf(on[i]), offB = blocksOf(off[i]), tag = 'B message ' + (i + 1) + ' (' + want[i] + '): ';
      if (want[i] === 'hit') {
        A.ok(extendsPrev(blocksOf(on[i - 1]), onB), tag + 'ITS FIRST REQUEST STARTS WITH THE EXACT BYTES OF MESSAGE ' + i + '\'S FIRST REQUEST, UP TO ITS END');
        const c = cliOf(on[i]);
        A.eq([c && c.start, c && c.replay, c && c.replayed, c && c.replayNotes > 0], ['first', 'hit', 2 * i - 1, true], tag + 'its usage event says a fresh child replayed every entry of the last request');
      } else A.eq(ser(onB), ser(offB), tag + 'its first request is OFF\'s, byte for byte (no past note at all)');
      A.eq(onB.length, offB.length, tag + 'no entry is added: as many blocks as OFF');
      A.ok(onB[onB.length - 1].text === offB[offB.length - 1].text, tag + 'THE NEWEST MESSAGE\'S OWN ENTRY (its run context, recall, crew call) IS TODAY\'S, BYTE FOR BYTE');
      const odd = [];
      for (let j = 0; j < onB.length - 1; j++) {
        const ok = j % 2 ? onB[j].text === offB[j].text : (onB[j].text === offB[j].text || onB[j].text === newest[j / 2]);
        if (!ok) odd.push(j);
      }
      A.eq(odd, [], tag + 'every earlier block is OFF\'s, or that message\'s own entry exactly as it was first sent');
      const all = onB.map(b => b.text).join('\n');
      const ids = []; for (let k = 1; k <= 12; k++) { const at = all.indexOf('Run id: run-' + k + '\n'); if (at >= 0) ids.push([k, at]); }
      A.ok(ids.length > 0 && ids[ids.length - 1][0] === i + 1 && ids.every((x, k) => !k || (x[0] > ids[k - 1][0] && x[1] > ids[k - 1][1])) && all.lastIndexOf('<run_context>') < ids[ids.length - 1][1],
        tag + 'PAST NOTES NEVER SIT AFTER THE NEWEST RUN\'S IDS: run ids rise through the request and the last is this run\'s (' + ids.map(x => x[0]).join(',') + ')');
      A.ok(!/<tool_result|<function_calls>/.test(all), tag + 'the first request is prose only, as OFF: no tool turn is replayed');
      A.eq(on[i].spawns.length, 1, tag + 'one child serves the run, as OFF');
      A.eq(on[i].spawns[0].args, off[i].spawns[0].args, tag + 'the argv is OFF\'s');
      A.ok(on[i].spawns[0].system === sys0 && sys0.replace(REPLAY_NOTE, '') === off[i].spawns[0].system && sys0.indexOf(REPLAY_NOTE) > 0 && sys0.indexOf(REPLAY_NOTE) < sys0.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'),
        tag + 'the system prompt is the same on every message of the stream: OFF\'s plus one fixed sentence in its cached part');
      A.eq(norm(on[i].spawns[0].inputs[1]), norm(off[i].spawns[0].inputs[1]), tag + 'the run\'s second turn (the tool result) is OFF\'s bytes');
      A.eq(cliOf(on[i], 1), { start: 'reuse' }, tag + 'that turn rides the live child (its usage event says reuse; no replay on a delta)');
    }
    A.eq(cliOf(off[3]), { start: 'first' }, 'B: OFF, a usage event still says how the call was served, and nothing about a replay');
    A.ok(REPLAY.stats().streams === 1 && REPLAY.stats().lineages === 1 && REPLAY.stats().bytes > 0, 'B: one stream, one lineage in the ledger: ' + JSON.stringify(REPLAY.stats()));
  }

  /* ---- C. the fallbacks: `on` rides its own ledger; `off` is the same conversation without req.replay ---- */
  async function pair(o) {
    const ledger = o.ledger || Ledger.makeReplayLedger(o.ledgerOpts);
    const off = await chat(Object.assign({}, o, { replay: false, ledger: null }));
    const on = await chat(Object.assign({ ledger }, o, { replay: true }));
    return { off, on, ledger };
  }
  const same = (a, b) => ser(blocksOf(a)) === ser(blocksOf(b));
  const from4 = extra => n => (n >= 4 ? extra : null);
  for (const [what, perRun, check] of [
    ['another model', from4({ model: 'opus' }), r => r.on[3].spawns[0].args.indexOf('opus') >= 0],
    ['another account (CLAUDE_CONFIG_DIR)', from4({ configDir: 'C:/accounts/second' }), r => r.on[3].spawns[0].env.CLAUDE_CONFIG_DIR === 'C:/accounts/second'],
    ['another system prompt', from4({ system: SYSTEM + '\n[SERVICE KEYS] one key was added.' }), r => r.on[3].spawns[0].system !== r.on[2].spawns[0].system],
    ['another tool list', from4({ tools: [READ, WRITE] }), r => r.on[3].spawns[0].system.indexOf('- fs_write:') > 0 && r.on[2].spawns[0].system.indexOf('- fs_write:') < 0],
    ['another effort', from4({ effort: 'high' }), r => r.on[3].spawns[0].args.indexOf('--effort') >= 0 && r.on[2].spawns[0].args.indexOf('--effort') < 0]
  ]) {
    const r = await pair({ messages: 5, tools: [READ], perRun });
    A.ok(check(r), 'C ' + what + ': the fourth message really runs on it');
    A.eq(r.on.map(verdictOf), ['none', 'hit', 'hit', 'none', 'hit'], 'C ' + what + ': that lineage has no record, so the message replays nothing; the next one replays from it');
    A.ok(same(r.on[3], r.off[3]), 'C ' + what + ': ITS FIRST REQUEST IS TODAY\'S BYTES (no stale entry is replayed)');
    A.ok(extendsPrev(blocksOf(r.on[3]), blocksOf(r.on[4])), 'C ' + what + ': and the message after it starts with that request');
  }
  {
    const edit = (h, at) => h.map((m, i) => (i === at ? Object.assign({}, m, { content: m.content + ' (edited)' }) : m));
    const first = await pair({ messages: 5, tools: [READ], perRun: n => (n === 5 ? { historyOf: h => edit(h, 0) } : null) });
    A.eq([verdictOf(first.on[4]), same(first.on[4], first.off[4])], ['history', true], 'C an edited first message: nothing is replayed, the request is today\'s bytes');
    const mid = await pair({ messages: 5, tools: [READ], perRun: n => (n === 5 ? { historyOf: h => edit(h, 4) } : null) });
    const onB = blocksOf(mid.on[4]), offB = blocksOf(mid.off[4]), prevB = blocksOf(mid.on[3]);
    A.eq([verdictOf(mid.on[4]), cliOf(mid.on[4]).replayed], ['part', 4], 'C an edited third message: the replay stops where the history differs');
    A.ok(ser(onB.slice(0, 4)) === ser(prevB.slice(0, 4)) && ser(onB.slice(4)) === ser(offB.slice(4)), 'C an edited third message: the entries before it go out as they were sent, the edited one and everything after it are today\'s');
    const slid = await pair({ messages: 5, tools: [READ], perRun: n => (n === 5 ? { historyOf: h => h.slice(2) } : null) });
    A.eq([verdictOf(slid.on[4]), same(slid.on[4], slid.off[4])], ['history', true], 'C a history window that slid: nothing is replayed, the request is today\'s bytes');
  }
  {
    const ledger = Ledger.makeReplayLedger();
    const r = await pair({ messages: 5, tools: [READ], ledger, perRun: n => (n === 4 ? { before: () => ledger.clear() } : null) });
    A.eq([r.on.map(verdictOf), same(r.on[3], r.off[3])], [['none', 'hit', 'hit', 'none', 'hit'], true], 'C a ledger that lost its records (a restart): the next message is today\'s bytes, and the ledger starts again from it');
  }
  {
    // a session deleted or a memory forgotten between two messages: the host's forget epoch moves
    const r = await pair({ messages: 5, tools: [READ], perRun: n => (n >= 4 ? { epoch: '1731600000000:1' } : null) });
    A.eq(r.on.map(verdictOf), ['none', 'hit', 'hit', 'forgotten', 'hit'], 'C a forget since the last message: the record made before it is dropped, the ledger starts again from this message');
    A.ok(same(r.on[3], r.off[3]), 'C a forget since the last message: THE REQUEST IS TODAY\'S BYTES - no earlier note (its recalled memories, its recent activity) comes back');
    A.ok(blocksOf(r.on[4]).slice(0, 6).every(b => !/Run id: run-[123]\n/.test(b.text)), 'C a forget: the next message replays only what was sent after it (no note of messages 1-3)');
  }
  {
    const before = failCounts()['claudecli.replay'] || 0;
    const r = await pair({ messages: 3, tools: [READ], ledger: { plan() { throw new Error('ledger fault'); }, setTtl() {} } });
    A.ok(r.on.every((run, i) => same(run, r.off[i])), 'C a throw inside the ledger: every request is today\'s bytes (fail open)');
    A.eq([(failCounts()['claudecli.replay'] || 0) - before, cliOf(r.on[1]).replay], [3, 'error'], 'C a throw inside the ledger: noted through failNote each time, and the usage event says error');
  }
  {
    const MIN = 60000;
    const sub = await pair({ messages: 6, tools: [READ], perRun: n => (n === 4 ? { gapMs: 50 * MIN } : n === 5 ? { gapMs: 55 * MIN } : null) });
    A.eq(sub.on.map(verdictOf), ['none', 'hit', 'hit', 'hit', 'expired', 'hit'], 'C a subscription sign-in (1-hour cache): a message 50 minutes later replays, one 55 minutes later does not');
    A.ok(same(sub.on[4], sub.off[4]), 'C a record older than its cache entry: the request is today\'s bytes (the past notes are not written again)');
    const key = await pair({ messages: 4, tools: [READ], apiKeySource: 'ANTHROPIC_API_KEY', perRun: n => (n === 3 ? { gapMs: 4 * MIN } : n === 4 ? { gapMs: 5 * MIN } : null) });
    A.eq([key.on.map(verdictOf), same(key.on[3], key.off[3])], [['none', 'hit', 'hit', 'expired'], true], 'C an API-key sign-in (5-minute cache): 4 minutes later replays, 5 minutes later is today\'s bytes');
  }
  {
    const r = await pair({ messages: 4, tools: [READ], noteChars: 30000 });
    A.eq(r.on.map(verdictOf), ['none', 'notes', 'notes', 'notes'], 'C a note that alone is over the cap never replays');
    A.ok(r.on.every((run, i) => same(run, r.off[i])), 'C a note over the cap: every request is today\'s bytes, the route behaves as it does today');
  }
  {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const withImage = n => ({ role: 'user', content: [{ type: 'text', text: ask(n) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] });
    const r = await pair({ messages: 5, tools: [READ], perRun: n => (n === 3 ? { askOf: withImage } : null) });
    const images = run => blocksOf(run).filter(b => b.type === 'image').length;
    A.eq(r.on.map(verdictOf), ['none', 'hit', 'hit', 'hit', 'hit'], 'C an image: the entries before it still replay');
    A.eq(r.on.map(images), r.off.map(images), 'C an image: it crosses the pipe exactly as OFF sends it');
    for (const i of [3, 4]) {
      const onB = blocksOf(r.on[i]), offB = blocksOf(r.off[i]);
      A.ok(cliOf(r.on[i]).replayed === 4 && onB.length === offB.length && ser(onB.slice(4)) === ser(offB.slice(4)), 'C an image (message ' + (i + 1) + '): the entry that carries it and everything after it are today\'s bytes; it is never recorded or swapped');
    }
  }
  {
    const r = await pair({ messages: 4, tools: [READ], perRun: n => (n === 4 ? { historyOf: h => h.slice(0, 4), askOf: () => ({ role: 'user', content: ask(3) }) } : null) });
    const onB = blocksOf(r.on[3]), last = onB[onB.length - 1].text;
    A.eq([verdictOf(r.on[3]), onB.length], ['part', 5], 'C a retried message (the same ask in a new run): the history before it replays');
    A.ok(last === blocksOf(r.off[3])[4].text && last.indexOf('Run id: run-4\n') > 0 && last.indexOf('run-3') < 0, 'C a retried message: IT CARRIES TODAY\'S NOTE, never the one the first attempt was sent with');
  }
  {
    const r = await pair({ messages: 3, tools: [READ], perRun: n => (n === 3 ? { noRunNote: true } : null) });
    A.eq([verdictOf(r.on[2]), same(r.on[2], r.off[2])], ['nonote', true], 'C a request with no run-context note: nothing is replayed (no past note may stand where the newest ids should)');
    const never = await pair({ messages: 3, tools: [], neverReread: true });
    A.ok(never.on.every((run, i) => same(run, never.off[i]) && run.spawns[0].system === never.off[i].spawns[0].system && !run.stats.replay), 'C a call nothing reads again (neverReread): the ledger is not asked, every byte is OFF\'s');
    A.eq(never.ledger.stats().streams, 0, 'C a call nothing reads again leaves no record');
  }
  {
    // a replacement child of the same run: the run's first child wrote past its call block and was closed
    const r = await pair({ messages: 4, tools: [READ], perRun: n => (n === 3 ? { overrun: true } : null) });
    const run = r.on[2];
    A.eq([run.spawns.length, run.stats.fresh.warm, run.stats.replay], [2, 1, { hit: 2 }], 'C a replacement child: the warm child takes the whole history, and the ledger is read again');
    const firstB = blocksOf(run), again = JSON.parse(run.spawns[1].inputs[0]).message.content;
    A.ok(extendsPrev(firstB, again), 'C a replacement child: ITS FIRST MESSAGE STARTS WITH THE RUN\'S FIRST REQUEST, byte for byte (the history is rendered the same way twice)');
    A.ok(/<tool_result/.test(again.map(b => b.text).join('\n')), 'C a replacement child: it then carries the run\'s tool turn, as OFF');
    A.eq(norm(run.spawns[1].inputs[0]).slice(ser(firstB).length + 60), norm(r.off[2].spawns[1].inputs[0]).slice(ser(blocksOf(r.off[2])).length + 60), 'C a replacement child: what follows the first request is OFF\'s bytes');
    A.eq(verdictOf(r.on[3]), 'hit', 'C a replacement child records nothing: the next message replays the run\'s FIRST request');
    A.ok(extendsPrev(firstB, blocksOf(r.on[3])) && !/<tool_result|<function_calls>/.test(blocksOf(r.on[3]).map(b => b.text).join('\n')), 'C the next message starts with that first request and stays prose: no tool turn is ever replayed');
  }
  {
    // the one-shot path (every turn its own child) and a conversation that alternates chat turns and task turns
    const one = await pair({ messages: 5, tools: [READ], persist: false });
    A.eq(one.on.map(run => run.stats.replay), [{ none: 1, hit: 1 }, { hit: 2 }, { hit: 2 }, { hit: 2 }, { hit: 2 }], 'C one-shot turns: both requests of a run read the ledger (the first one records, the second reads that same record)');
    A.ok(one.on.every((run, i) => !i || extendsPrev(blocksOf(one.on[i - 1]), blocksOf(run))), 'C one-shot turns: each message\'s first request starts with the last one');
    A.ok(one.on.every(run => extendsPrev(blocksOf(run), JSON.parse(run.spawns[1].inputs[0]).message.content)), 'C one-shot turns: a run\'s second request starts with its first (the history is rendered the same way twice)');
    A.eq(cliOf(one.on[2]), { start: 'oneshot', replay: 'hit', replayed: 3, replayNotes: cliOf(one.on[2]).replayNotes }, 'C one-shot turns: the usage event says oneshot and what was replayed');
    const mixed = await pair({ messages: 6, perRun: n => ({ tools: n % 2 ? [READ] : [] }) });
    A.eq(mixed.on.map(verdictOf), ['none', 'none', 'hit', 'hit', 'hit', 'hit'], 'C chat turns and task turns have different system prompts: each keeps its own lineage and replays from its own last request');
    A.eq(mixed.ledger.stats().lineages, 2, 'C two lineages for that one stream');
    A.ok(mixed.on.every((run, i) => { const a = blocksOf(run), b = blocksOf(mixed.off[i]); return a.length === b.length && a[a.length - 1].text === b[b.length - 1].text; }), 'C in every one of them the newest entry is today\'s and no entry is added');
  }

  /* ---- D. the bounds ---- */
  {
    const entriesOf = (k, pad) => {   // k earlier exchanges, then the newest message with its notes
      const list = [];
      for (let i = 0; i < k; i++) list.push({ text: '<user>\nask ' + i + ' ' + (pad || '') + '\n</user>', at: 2 * i }, { text: '<assistant>\nreply ' + i + '\n</assistant>', at: 2 * i + 1 });
      list.push({ text: '<user>\n<run_context>\nrun ' + k + '\n</run_context>\n\nask ' + k + ' ' + (pad || '') + '\n</user>', bare: '<user>\nask ' + k + ' ' + (pad || '') + '\n</user>', runNote: true, at: 2 * k });
      return list;
    };
    const L = Ledger.makeReplayLedger({ maxStreams: 3, maxLineages: 2, maxBytes: 4000 });
    for (const s of ['s1', 's2', 's3']) L.plan(entriesOf(0), { stream: s, lineage: 'a', runId: 'r1' });
    A.eq(L.stats().streams, 3, 'D: three streams fit');
    A.eq(L.plan(entriesOf(1), { stream: 's1', lineage: 'a', runId: 'r2' }).verdict, 'hit', 'D: s1 replays (and is now the most recently used)');
    L.plan(entriesOf(0), { stream: 's4', lineage: 'a', runId: 'r1' });
    A.eq([L.stats().streams, L.plan(entriesOf(1), { stream: 's2', lineage: 'a', runId: 'r2' }).verdict], [3, 'none'], 'D: a fourth stream drops the least recently used one (s2), which then has no record: today\'s bytes');
    A.eq(L.plan(entriesOf(2), { stream: 's1', lineage: 'a', runId: 'r3' }).verdict, 'hit', 'D: the stream that was used again was kept');
    L.plan(entriesOf(0), { stream: 's1', lineage: 'b', runId: 'r1' }); L.plan(entriesOf(0), { stream: 's1', lineage: 'c', runId: 'r1' });
    A.eq([L.plan(entriesOf(3), { stream: 's1', lineage: 'a', runId: 'r4' }).verdict, L.plan(entriesOf(1), { stream: 's1', lineage: 'c', runId: 'r2' }).verdict], ['none', 'hit'], 'D: a stream keeps two lineages; the least recently used one goes');
    const big = L.plan(entriesOf(0, 'x'.repeat(5000)), { stream: 'huge', lineage: 'a', runId: 'r1' });
    A.eq([big.record, big.entries.length, L.plan(entriesOf(1, 'x'.repeat(5000)), { stream: 'huge', lineage: 'a', runId: 'r2' }).verdict], [null, 1, 'none'], 'D: a record that alone is over the byte limit is not kept (the request is still served, as today)');
    for (let i = 0; i < 40; i++) { L.plan(entriesOf(i % 4, 'y'.repeat(300)), { stream: 'w' + (i % 7), lineage: 'l' + (i % 3), runId: 'r' + i }); if (L.stats().bytes > 4000 || L.stats().streams > 3) { A.ok(false, 'D: the ledger went over its bounds: ' + JSON.stringify(L.stats())); break; } }
    A.ok(L.stats().bytes <= 4000 && L.stats().streams <= 3, 'D: after 40 more requests on 7 streams the ledger is inside its bounds: ' + JSON.stringify(L.stats()));
    L.clear();
    A.eq(L.stats(), { streams: 0, lineages: 0, bytes: 0 }, 'D: clear() empties it and its byte count');
    // a note the cache cannot give back: the last request end among the replayed entries is too far behind this request's end
    const far = Ledger.makeReplayLedger();
    far.plan(entriesOf(1), { stream: 's', lineage: 'a', runId: 'r1' });
    const long = entriesOf(1).slice(0, 2).concat([{ text: '<user>\nask 1 \n</user>', at: 2 }]);
    for (let i = 0; i < 20; i++) long.push({ text: '<assistant>\nmore ' + i + '\n</assistant>', at: 3 + i });
    long.push(entriesOf(30)[60]);
    const res = far.plan(long, { stream: 's', lineage: 'a', runId: 'r2' });
    A.eq([res.verdict, res.entries === long], ['far', true], 'D: past notes more than the API\'s look-back behind the request\'s end are not replayed: today\'s entries, the same list');
    const fg = Ledger.makeReplayLedger();
    fg.plan(entriesOf(0), { stream: 'one', lineage: 'a', runId: 'r1', epoch: '5:0' }); fg.plan(entriesOf(0), { stream: 'two', lineage: 'a', runId: 'r1', epoch: '5:0' });
    const after = fg.plan(entriesOf(1), { stream: 'one', lineage: 'a', runId: 'r2', epoch: '5:1' });
    A.eq([after.verdict, after.entries.length, fg.stats().streams, fg.plan(entriesOf(1), { stream: 'two', lineage: 'a', runId: 'r2', epoch: '5:1' }).verdict], ['forgotten', 3, 1, 'none'],
      'D: a new forget epoch drops every record made under another one, on every stream, the moment a request shows it');
    A.eq(Ledger.DEFAULTS, { maxStreams: 24, maxLineages: 3, maxBytes: 8 * 1024 * 1024, noteMax: 24000, lookback: 18 }, 'D: the shipped bounds');
    const rec = far.plan(entriesOf(0), { stream: 't', lineage: 'a', runId: 'r1' }).record;
    far.setTtl(rec, -5); far.setTtl(null, 1000); far.setTtl(rec, 'x');
    A.eq(rec.ttlMs, Ledger.KEY_TTL_MS, 'D: a record lives the short tier until a sign-in says otherwise; a bad value changes nothing');
  }

  /* ---- E. telemetry: the usage receipt keeps how each call was served ---- */
  {
    const receipts = makeUsageReceipts({ clock: { now: () => 5 } });
    const wrap = p => receipts.wrap(p, { provider: 'claude-cli', account: '' });
    const ledger = Ledger.makeReplayLedger();
    await chat({ messages: 3, tools: [READ], replay: true, ledger, wrap, perRun: n => (n === 3 ? { midRun: msgs => { msgs[1] = Object.assign({}, msgs[1], { content: msgs[1].content + ' (edited mid-run)' }); } } : null) });
    const recs = receipts.records();
    A.eq(recs.map(r => [r.runId, r.child, r.replay || null, r.replayed || 0]), [['run-1', 'first', 'none', 0], ['run-1', 'reuse', null, 0], ['run-2', 'first', 'hit', 1], ['run-2', 'reuse', null, 0],
      ['run-3', 'first', 'hit', 3], ['run-3', 'history', 'history', 0]],
      'E: each call\'s receipt says how it was served: a fresh child and why, or the live one; and what the ledger did for a whole-transcript message');
    A.ok(recs[2].replayNotes > 2000 && recs[2].cacheRead === 20 && recs[2].cacheWrite === 5, 'E: ...beside that call\'s own cache read and cache write, and the past-note characters it replayed: ' + JSON.stringify(recs[2]));
    A.ok(!/Message 1|Answer 1|run_context/.test(JSON.stringify(recs)), 'E: identifiers and counts only: not a word of the prompt');
    receipts.clear();
    await chat({ messages: 2, tools: [READ], wrap });
    await chat({ messages: 1, tools: [], wrap });
    A.eq(receipts.records().map(r => [r.child, 'replay' in r, 'replayed' in r]), [['first', false, false], ['reuse', false, false], ['first', false, false], ['reuse', false, false], ['oneshot', false, false]],
      'E: with the ledger off the receipt still says why each child was fresh, and nothing about a replay');
  }

  /* ---- F. the switch ---- */
  {
    const src = sidecarFunctionSource('cliReplayStream');
    A.ok(src.length > 100 && src.length < 1200, 'F: index.js cliReplayStream is sliced whole (' + src.length + ' chars)');
    const make = value => new Function('ENV', src + '\nreturn cliReplayStream;')(suffix => (suffix === 'CLI_REPLAY_LEDGER' ? value : undefined));
    const run = { streamId: 'ws_1', agentId: 'agent', stablePrefix: true, internal: false, recovery: null, groupTools: null, granted: false, delegatedBy: '' };
    A.eq([undefined, '', '0', 'true', 'on', ' 1 ', '1'].map(v => make(v)(run)), ['', '', '', '', '', 'ws_1|agent', 'ws_1|agent'], 'F: STARNET_CLI_REPLAY_LEDGER is off unless it is 1 (unset, 0, anything else: no stream is named)');
    const on = make('1');
    A.eq([{ streamId: '' }, { stablePrefix: false }, { internal: true }, { recovery: {} }, { groupTools: [] }, { granted: true }, { delegatedBy: 'lead' }].map(x => on(Object.assign({}, run, x))), ['', '', '', '', '', '', ''],
      'F: on, only a conversation\'s own runs name a stream (not a streamless, STABLE_PREFIX=0, internal, recovery, group, granted or delegated run)');
    const all = readSidecarSource();
    const reads = all.match(/CLI_REPLAY_LEDGER/g) || [];
    const envReads = all.match(/ENV\('CLI_REPLAY_LEDGER'\)|process\.env\.(?:STARNET|SKYNET)_CLI_REPLAY_LEDGER|env\[['"](?:STARNET|SKYNET)_CLI_REPLAY_LEDGER/g) || [];
    A.eq(envReads, ['ENV(\'CLI_REPLAY_LEDGER\')'], 'F: the switch is read at one place, through ENV() (' + reads.length + ' mentions in the sidecar, one read)');
    A.ok(/cliReplayStream: cliReplayStream\(\{ streamId, agentId, stablePrefix, internal, recovery: o\.recovery, groupTools: o\.groupTools, granted: grantedRun, delegatedBy: o\.delegatedBy \}\)/.test(all), 'F: runOnceCore hands the loop that one answer');

    // the loop: req.replay only when the host names a stream
    const seen = [];
    const drive = async extra => {
      const replay = makeReplayProvider({ turns: [[{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]] });
      const provider = Object.assign({}, replay, { stream: req => { seen.push(req); return replay.stream(req); } });
      await runAgentLoop(Object.assign({ messages: [{ role: 'user', content: 'hello' }], provider, emit: makeEmitter(A.makeBus(), () => {}), cost: makeCostEngine({ priceOf: provider.priceOf }),
        model: 'replay/model', agentId: 'a', runId: 'run-f', tools: [], limits: { maxIters: 2, grace: false }, dispatch: async () => ({ content: '' }),
        capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, clock: { now: () => 4242 } }, extra));
    };
    await drive({});
    await drive({ cliReplayStream: '' });
    await drive({ cliReplayStream: 'ws_1|agent' });
    await drive({ cliReplayStream: 'ws_1|agent', cliReplayEpoch: () => '1731600000000:2' });
    await drive({ cliReplayStream: 'ws_1|agent', cliReplayEpoch: () => { throw new Error('tombstones unreadable'); } });
    A.eq(seen.map(r => ['replay' in r, r.replay || null]), [[false, null], [false, null], [true, { stream: 'ws_1|agent', at: 4242, epoch: '' }], [true, { stream: 'ws_1|agent', at: 4242, epoch: '1731600000000:2' }], [false, null]],
      'F: the loop puts req.replay (the stream, the request\'s time on its clock, the host\'s forget epoch) on a request only when the host names a stream; an epoch that cannot be read sends none (today\'s bytes)');
    const epochSrc = sidecarFunctionSource('cliReplayEpoch');
    A.ok(epochSrc.length > 40 && epochSrc.length < 400, 'F: index.js cliReplayEpoch is sliced whole (' + epochSrc.length + ' chars)');
    A.eq(new Function('sessionTombstones', 'cliReplayForgets', epochSrc + '\nreturn cliReplayEpoch;')({ latestAt: () => 1731600000000 }, 3)(), '1731600000000:3', 'F: the forget epoch is the newest session delete and the count of forgotten memories');
    A.ok(/const chanEmit = \(name, payload\) => \{ if \(name === 'memory\.forget'\) cliReplayForgets \+= 1;/.test(all), 'F: every memory.forget the station emits moves the epoch, whether or not the event validates');
    A.ok(/cliReplayStream: cliReplayStream\([^\n]*\),\n\s+cliReplayEpoch,\n/.test(all), 'F: runOnceCore hands the loop the epoch reader beside the stream');
  }

  await offIsBase('after the ledger held records');
  A.report('claude-cli-replay-ledger.test');
})().catch(e => { console.log('FAIL: claude-cli-replay-ledger.test threw -- ' + (e && e.stack || e)); process.exit(1); });
