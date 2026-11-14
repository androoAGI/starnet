/* node dev/cli-replay-ledger-ab.js -- the W3.7 CLAUDE CODE REPLAY LEDGER A/B on the REAL `claude` CLI. It draws on the
   signed-in Claude plan (or bills the API key the CLI is signed in with): the owner or the integrator runs it, an agent
   never does (an agent may run --self-test, which uses a fake CLI and spends nothing).

   WHAT IT ANSWERS: with STARNET_CLI_REPLAY_LEDGER=1, does the real CLI READ the replayed conversation from its prompt
   cache on every message after the first, instead of writing it again? The hermetic tests prove the bytes (message N+1
   starts with message N's request); only the real CLI can prove the cache follows.

   ARMS   off: STARNET_CLI_REPLAY_LEDGER unset          on: STARNET_CLI_REPLAY_LEDGER=1
          Each arm is its own hermetic sidecar (SidecarFixture: temp workspace and profile) on the real CLI and its real
          sign-in. Each arm's system prompt opens with its own nonce, so the arms never share a cached prefix.
   TASK   AB_MESSAGES (default 6) short messages on ONE stream, each posted with the history the page would post (the
          real replies), as task turns (the persistent child, tools offered, AB_TASK=0 for tool-less chat turns). The asks
          need no tool. AB_MODEL (default haiku) names the model. A message that does not finish in AB_TIMEOUT_S
          (default 240) ends its arm.
   READS  each run's FIRST call from the arm's usage receipts (.usage/calls.jsonl): child, replay, replayed, cacheRead,
          cacheWrite, uncachedIn, out, and the weighted input (uncached + 2 x write + 0.1 x read: the 1-hour tier's list
          weights, a proxy; how a plan weighs a write is not published).
   PASS   on every message from the second: the on arm says replay hit, reads MORE from cache than the off arm and
          writes LESS. Anything else is printed as it is: a hit whose cacheRead stays at the system prompt's size means
          the CLI did not read the replay, and the switch must stay off.
   COST   about 2 x AB_MESSAGES model calls on AB_MODEL, each with StarNet's ~24k-token system prompt (first one written,
          the rest read). Nothing is pushed or stored outside the temp workspaces.

   --self-test  the same run against a fake CLI that models the prompt cache (an entry at each request's end, found
                again only by a request that starts with that request's blocks): proves this rig, spends nothing. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const { SidecarFixture } = require(path.join(ROOT, 'test', 'helpers', 'sidecar-fixture.js'));
const WM = require(path.join(ROOT, 'frontend', 'app', 'worldmodel.js'));

const SELF = process.argv.includes('--self-test');
const MESSAGES = Math.max(2, Math.min(24, Number(process.env.AB_MESSAGES) || 6));
const MODEL = String(process.env.AB_MODEL || 'haiku');
const TASK = String(process.env.AB_TASK || '1') !== '0';
const TIMEOUT_MS = (Number(process.env.AB_TIMEOUT_S) || 240) * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOPICS = ['tide tables', 'sourdough starters', 'bicycle gearing', 'star charts', 'tea grading', 'map projections', 'bird ringing', 'letterpress type'];
const askOf = i => 'Message ' + (i + 1) + '. In two plain sentences, say one true and commonly known thing about ' + TOPICS[i % TOPICS.length]
  + ', then end with the words "noted ' + (i + 1) + '". Do not use any tool and do not ask me anything.';

// the fake `claude` for --self-test: answers one line per stdin line and reports the usage a block-prefix cache would
const FAKE_CLI = [
  "'use strict';",
  "const fs = require('fs'), crypto = require('crypto');",
  "const args = process.argv.slice(2);",
  "const out = o => process.stdout.write(JSON.stringify(o) + '\\n');",
  "if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }",
  "if (args[0] === '--version' || args[0] === '-v') { process.stdout.write('2.1.300 (Claude Code)\\n'); process.exit(0); }",
  "const at = args.indexOf('--system-prompt-file');",
  "let system = '';",
  "try { system = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : ''; } catch (_) {}",
  "const sha = s => crypto.createHash('sha1').update(s).digest('hex');",
  "const file = process.env.FAKE_CACHE;",
  "let buf = '', said = false, held = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', d => {",
  "  buf += d; let nl;",
  "  while ((nl = buf.indexOf('\\n')) >= 0) {",
  "    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    let seen = {}; try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}",
  "    const blocks = JSON.parse(line).message.content.map(b => JSON.stringify(b));",
  "    const all = held + blocks.join('');",
  "    let read = seen[sha(system)] ? system.length : 0;",
  "    if (read) for (let k = blocks.length; k > 0; k--) { const pre = held + blocks.slice(0, k).join(''); if (seen[sha(system + pre)]) { read = system.length + pre.length; break; } }",
  "    seen[sha(system)] = 1; seen[sha(system + all)] = 1;",
  "    fs.writeFileSync(file, JSON.stringify(seen));",
  "    const reply = 'A fake but plain answer to this message. noted.';",
  "    held = all + JSON.stringify(reply);",
  "    if (!said) { said = true; out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] }); }",
  "    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });",
  "    out({ type: 'result', subtype: 'success', is_error: false, result: reply, stop_reason: 'end_turn', total_cost_usd: 0,",
  "      usage: { input_tokens: 3, cache_creation_input_tokens: Math.round((system.length + all.length - read) / 4), cache_read_input_tokens: Math.round(read / 4), output_tokens: 12 } });",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
  ""
].join('\n');

async function arm(name, extraEnv, scratch) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', SKYNET_QUEST_REFRESH: '0' });
  if (SELF) {
    const pkg = path.join(scratch, name, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
    const shim = path.join(scratch, name, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
    Object.assign(env, { STARNET_CLAUDE_BIN: shim, FAKE_CACHE: path.join(scratch, name, 'cache.json') });
  } else {
    // the real CLI and its real sign-in: the fixture points STARNET_CLAUDE_BIN at a missing file unless told otherwise
    Object.assign(env, { STARNET_CLAUDE_BIN: String(process.env.AB_CLAUDE_BIN || ''), HOME: os.homedir() });
  }
  const fixture = SidecarFixture.create({ prefix: 'starnet-cli-replay-ab-' + name + '-', timeoutMs: 120000, env: Object.assign(env, extraEnv) });
  const system = '[replay-ledger A/B ' + name + ' ' + crypto.randomBytes(6).toString('hex') + '] You are NOVA, the lead of a small station. Answer plainly and briefly.';
  const rows = [];
  try {
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', system, name: 'NOVA', provider: 'claude-cli', model: MODEL,
      role: 'orchestrator', approvalMode: 'ask', executionProfile: 'station-gear', workshop: false, skills: [], reasoningEffort: null }] });
    if (roster.status !== 200) throw new Error('roster refused: ' + roster.status);
    let signedIn = false;
    for (const until = Date.now() + 60000; Date.now() < until && !signedIn; await sleep(500)) {
      const st = await fixture.json('GET', '/api/auth/claude-cli/status');
      signedIn = !!(st.body && st.body.installed && st.body.loggedIn);
    }
    if (!signedIn) throw new Error('the claude CLI is not installed or not signed in (set AB_CLAUDE_BIN to its path if it is not on PATH)');
    const starter = [];
    for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
    const placed = starter.map(objectType => ({ objectType }));
    const receiptsFile = path.join(fixture.workspace, '.usage', 'calls.jsonl');
    const receipts = () => { try { return fs.readFileSync(receiptsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
    const history = [];
    for (let i = 0; i < MESSAGES; i++) {
      const body = { agentId: 'agent', isTask: TASK, placed, stationPlaced: placed, system, provider: 'claude-cli', model: MODEL, streamId: 'ws_replayab_' + name,
        messages: history.concat([{ role: 'user', content: askOf(i) }]) };
      let status = 0, raw = '';
      for (let k = 0; k < 120; k++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
        try {
          const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
          status = r.status; raw = await r.text();
        } catch (e) { status = -1; raw = String((e && e.message) || e); }
        clearTimeout(timer);
        if (!(status === 400 && /checking local sign-in/.test(raw))) break;
        await sleep(500);
      }
      const events = raw.split(/\r?\n/).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
      const runId = ((events.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId || '';
      const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
      const reply = events.filter(e => e.name === 'agent.token' && e.payload && typeof e.payload.delta === 'string').map(e => e.payload.delta).join('').trim();
      await sleep(SELF ? 300 : 1500);   // the receipt is appended as the call's stream closes
      const first = receipts().filter(r => r.runId === runId && (r.child === 'first' || r.child === 'oneshot'))[0] || {};
      rows.push({ arm: name, message: i + 1, end: status === 200 ? (end.reason || '?') : 'http ' + status, child: first.child || '-', replay: first.replay || '-', replayed: first.replayed || 0,
        cacheRead: first.cacheRead, cacheWrite: first.cacheWrite, uncachedIn: first.uncachedIn, out: first.out });
      if (status !== 200 || end.reason !== 'done' || !reply) { console.log('[' + name + '] message ' + (i + 1) + ' did not finish (' + (end.reason || status) + '): this arm stops here. ' + raw.slice(0, 300)); break; }
      history.push({ role: 'user', content: askOf(i) }, { role: 'assistant', content: reply });
    }
  } finally { await fixture.dispose(); }
  return rows;
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cli-replay-ab-'));
  console.log('replay-ledger A/B: ' + (SELF ? 'SELF-TEST (fake CLI, nothing is spent)' : 'REAL claude CLI, model ' + MODEL + ' (this draws on the signed-in plan)') + ', ' + MESSAGES + ' messages per arm, ' + (TASK ? 'task turns' : 'chat turns'));
  let off = [], on = [];
  try {
    off = await arm('off', {}, scratch);
    on = await arm('on', { STARNET_CLI_REPLAY_LEDGER: '1' }, scratch);
  } finally { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {} }
  const weighed = r => (Number(r.uncachedIn) || 0) + 2 * (Number(r.cacheWrite) || 0) + 0.1 * (Number(r.cacheRead) || 0);
  const pad = (v, n) => String(v == null ? '-' : v).padStart(n);
  console.log('\narm  msg  end        child    replay   replayed  cacheRead  cacheWrite  uncachedIn  weighted-in');
  for (const r of off.concat(on)) console.log(pad(r.arm, 3) + pad(r.message, 5) + '  ' + String(r.end).padEnd(10) + ' ' + String(r.child).padEnd(8) + ' ' + String(r.replay).padEnd(8) + pad(r.replayed, 9) + pad(r.cacheRead, 11) + pad(r.cacheWrite, 12) + pad(r.uncachedIn, 12) + pad(Math.round(weighed(r)), 13));
  const sum = rows => Math.round(rows.slice(1).reduce((k, r) => k + weighed(r), 0));
  const bad = [];
  if (off.length < MESSAGES || on.length < MESSAGES) bad.push('an arm did not finish every message');
  for (let i = 1; i < Math.min(off.length, on.length); i++) {
    const a = off[i], b = on[i];
    if (b.replay !== 'hit') bad.push('message ' + (i + 1) + ': the on arm did not replay (' + b.replay + ')');
    if (!(Number(b.cacheRead) > Number(a.cacheRead))) bad.push('message ' + (i + 1) + ': the on arm read no more from cache (' + b.cacheRead + ' vs ' + a.cacheRead + ')');
    if (!(Number(b.cacheWrite) < Number(a.cacheWrite))) bad.push('message ' + (i + 1) + ': the on arm wrote no less to cache (' + b.cacheWrite + ' vs ' + a.cacheWrite + ')');
  }
  console.log('\nweighted input, messages 2-' + MESSAGES + ' (uncached + 2 x cache write + 0.1 x cache read; list weights, a proxy): off ' + sum(off) + ' -> on ' + sum(on));
  console.log(bad.length ? 'VERDICT: NOT CONFIRMED\n - ' + bad.join('\n - ') : 'VERDICT: CONFIRMED - from the second message the on arm replays, reads more from cache and writes less than the off arm');
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('replay-ledger A/B failed: ' + ((e && e.stack) || e)); process.exit(1); });
