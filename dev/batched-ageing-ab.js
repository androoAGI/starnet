/* node dev/batched-ageing-ab.js -- the W2.1 BATCHED AGEING A/B on REAL models. It spends real money: Andrew runs it,
   an agent never does (an agent may run --self-test, which spends nothing).

   WHAT IT ANSWERS: with STARNET_BATCHED_AGEING=1, does a long run stay as good as without it while costing less, on a
   real model with real prompt caching and preserved thinking? Both arms run the SAME long task on the SAME model
   through the REAL sidecar (hermetic SidecarFixture: temp profile, temp workspace); the switch is the only difference.

   ARMS   off: STARNET_BATCHED_AGEING unset (the stack)          on: STARNET_BATCHED_AGEING=1
          Each arm's system prompt opens with its own nonce, so the two arms never share a cached prefix. The arm
          order alternates task by task (off first, then on first, ...).
   TASKS  (the repo's existing long fixtures; AB_TASKS picks, default all three)
     chain-head     dev/compaction-live-proof.js's chain, 40 files of ~5 KB, one read per turn; each token sits in the
                    first lines of its file (inside an aged stub's kept head). success: the answer names all 40 tokens.
     chain-deep     the same chain with each token ~2 KB into its file (past the stub's kept head): an aged file's token
                    comes back only through its handle (or the source file). success: all 40 tokens. Re-reads = cost.
                    A stress case in BOTH arms: the loop's strategy guard refuses a long burst of read-only calls
                    (STRATEGY EXHAUSTED after 6 with no new evidence), and on Haiku 5.5 the run keeps its prompt under
                    the 100K price tier, so the stack's own micro tier stubs old results too (both seen in --self-test).
     probe-project  the cost audit's context-rig project (copies of 14 real sidecar modules): read each file, append its
                    function names to docs/MODULES.md, run the tests. success: every file has a section naming >= 90% of
                    the functions it declares, and the tests ran.
   METRICS per arm: success; model calls; batches (loop.historyEdit.aged notes); handle re-reads (fs.read of a .output/
     handle) and source re-reads (a path read again); thinking the harness stripped at a batch
     (loop.historyEdit.thinkingStripped) and thinking the API DROPPED (message_start input_transformations
     thinking_dropped, read by the proxy); provider-reported usage per call (uncached input, cache read, cache write
     5m/1h, output) and the weighted cost:
       input-eq = uncached + 1.25 x write(5m) + 2 x write(1h) + READ x cache read
         (READ: Opus 5.5 0.05, Fable 5.1 0.025, else 0.10; AB_READ_RATIO overrides; a write with no tier split = 5m)
       dollars  = input-eq x list input price + output x list output price  (sidecar/providers/prices.js; Haiku 5.5
         above 100K prompt tokens at its long-prompt rate, 5x)
     The failopen notes print the first 5 of a kind, then every 50th: a count above 5 is a lower bound.
   VERDICT (suggested, printed): per task, on vs off: success and score (tokens found, files documented) not lower,
     API-dropped thinking 0 in both arms, weighted cost lower. Handle re-reads are reported, never hidden. One run per
     arm: rerun before trusting a close call.

   SPEND: HARD CAP AB_CAP_USD (default 5; above 5 is refused). Every model call goes through a local forwarding proxy
   that, BEFORE forwarding, reserves the call's worst case (each prompt token written at the 1-hour rate, max_tokens out,
   all at the long-prompt rate) and refuses the call when spent + reserved would pass the cap; after the call it books
   the provider-reported usage at the same worst-case rates (a call that streamed but reported no usage is booked at
   its whole reserve). A refused call ends that arm; every later arm is reported "not run (cap)".

   KEY: ONLY from the environment variable STARNET_AGEING_AB_KEY (an Anthropic API key). It is read once and deleted
   from process.env before anything is spawned; the proxy sets it as x-api-key on each upstream request. The sidecar
   under test is given a placeholder key, so the real key never reaches the sidecar, its stores or its logs, and this
   script never prints, logs or writes it. No other variable, file or credential store is read for a key.

   usage (PowerShell, from the repo root):
     $env:STARNET_AGEING_AB_KEY = '<anthropic key>'; node dev/batched-ageing-ab.js
   options (env): AB_MODEL (default claude-haiku-5-5: the cheapest model that binds thinking), AB_TASKS
     (comma list), AB_EFFORT (default medium), AB_CAP_USD (<= 5), AB_READ_RATIO, AB_OUT (write the JSON report there)
   node dev/batched-ageing-ab.js --self-test   plumbing check against a LOCAL mock Anthropic upstream: no key, no
     network beyond 127.0.0.1, no spend. With AB_CAP_USD=0.001 it proves the cap refuses the first call. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { SidecarFixture } = require('../test/helpers/sidecar-fixture.js');
const prices = require('../sidecar/providers/prices.js');

const REPO = path.resolve(__dirname, '..');
const KEY_ENV = 'STARNET_AGEING_AB_KEY';
const SELF_TEST = process.argv.includes('--self-test');
const KEY = SELF_TEST ? '' : String(process.env[KEY_ENV] || '').trim();
delete process.env[KEY_ENV];   // read once; never inherited by a child process
const MODEL = String(process.env.AB_MODEL || 'claude-haiku-5-5').trim();
const EFFORT = String(process.env.AB_EFFORT || 'medium').trim();
const CAP = (process.env.AB_CAP_USD == null || process.env.AB_CAP_USD === '') ? 5 : Number(process.env.AB_CAP_USD);
const TASK_IDS = String(process.env.AB_TASKS || 'chain-head,chain-deep,probe-project').split(',').map(s => s.trim()).filter(Boolean);
const OUT = String(process.env.AB_OUT || '').trim();
const UPSTREAM = 'https://api.anthropic.com';
const CHAIN_FILES = 40;
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));

function refuse(msg) { console.error('[batched-ageing-ab] REFUSED: ' + msg); process.exit(2); }
if (!SELF_TEST && !KEY) refuse('no key in ' + KEY_ENV + ' (an Anthropic API key). No other variable, file or credential store is read.');
if (!(CAP > 0) || CAP > 5) refuse('AB_CAP_USD must be above 0 and at most 5.');
for (const t of TASK_IDS) if (!['chain-head', 'chain-deep', 'probe-project'].includes(t)) refuse('unknown task ' + t + ' (chain-head, chain-deep, probe-project)');

// ---- prices: the catalog the sidecar books with ----
const LIST = prices.priceOf('anthropic', MODEL);
if (!LIST || !(LIST.in > 0) || !(LIST.out > 0)) refuse('the price catalog has no list price for ' + MODEL + ': the cap could not be enforced.');
const TIER = prices.promptTierTokens(MODEL) || 0;   // prompt tokens above which the model bills its long-prompt rate
const TIER_FACTOR = TIER ? 5 : 1;                     // Haiku 5.5: $0.50/$2.50 above 100K vs $0.10/$0.50 (prices.js row)
const READ = process.env.AB_READ_RATIO ? Number(process.env.AB_READ_RATIO)
  : (/opus-5[-.]5/i.test(MODEL) ? 0.05 : /fable-5[-.]1/i.test(MODEL) ? 0.025 : 0.10);
const num = v => (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;

function countsOf(u) {
  const uncached = num(u.input_tokens), read = num(u.cache_read_input_tokens), write = num(u.cache_creation_input_tokens);
  const cc = (u.cache_creation && typeof u.cache_creation === 'object') ? u.cache_creation : null;
  const split = !!cc && num(cc.ephemeral_5m_input_tokens) + num(cc.ephemeral_1h_input_tokens) === write;
  return { uncached, read, write, w5: split ? num(cc.ephemeral_5m_input_tokens) : write, w1h: split ? num(cc.ephemeral_1h_input_tokens) : 0,
    splitReported: split, out: num(u.output_tokens), prompt: uncached + read + write };
}
function listCost(c) {
  const f = (TIER && c.prompt > TIER) ? TIER_FACTOR : 1;
  const inputEq = c.uncached + 1.25 * c.w5 + 2 * c.w1h + READ * c.read;
  return { inputEq, usd: (inputEq * LIST.in * f + c.out * LIST.out * f) / 1e6 };
}
// the cap's view: every write at the 1-hour rate, reads at >= 0.10, the long-prompt rate: never under the real bill
function capCost(c) { return ((c.uncached + 2 * c.write + Math.max(0.10, READ) * c.read) * LIST.in * TIER_FACTOR + c.out * LIST.out * TIER_FACTOR) / 1e6; }
function reserveOf(bodyChars, body) {
  const promptTokens = Math.ceil(bodyChars / 3);   // fewer characters per token than any real prompt: an over-estimate
  const maxOut = num(body && body.max_tokens) || 64000;
  return (promptTokens * 2 * LIST.in * TIER_FACTOR + maxOut * LIST.out * TIER_FACTOR) / 1e6;
}
function dropsOf(tx) { return Array.isArray(tx) ? tx.filter(t => t && t.type === 'thinking_dropped').length : 0; }
function parseCall(text) {
  let start = null, delta = null, drops = 0, stop = '';
  let whole = null; try { whole = JSON.parse(text); } catch (_) { whole = null; }
  if (whole && whole.usage) { start = whole.usage; drops = dropsOf(whole.input_transformations); stop = whole.stop_reason || ''; }
  else {
    for (const line of String(text || '').split('\n')) {
      const t = line.trim();
      if (t.indexOf('data:') !== 0) continue;
      let ev = null; try { ev = JSON.parse(t.slice(5)); } catch (_) { continue; }
      if (ev && ev.type === 'message_start' && ev.message) { start = ev.message.usage || null; drops += dropsOf(ev.message.input_transformations); }
      if (ev && ev.type === 'message_delta') { if (ev.usage) delta = Object.assign({}, delta || {}, ev.usage); if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; }
    }
  }
  const u = (start || delta) ? Object.assign({}, start || {}, delta || {}) : null;
  return { counts: u ? countsOf(u) : null, apiDroppedThinking: drops, stop };
}

// ---- the forwarding proxy: the key, the cap, the provider-reported usage ----
function startProxy(ledger, tag, upstreamBase) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!/^(host|content-length|connection|x-api-key|authorization|accept-encoding)$/i.test(k)) headers[k] = v;
    if (KEY) headers['x-api-key'] = KEY;
    const isCall = req.method === 'POST' && /\/v1\/messages(\?|$)/.test(req.url);
    let reserve = 0;
    if (isCall) {
      let j = null; try { j = JSON.parse(body.toString('utf8')); } catch (_) { j = null; }
      reserve = reserveOf(body.length, j);
      if (ledger.spent + ledger.reserved + reserve > CAP) {
        ledger.refused++; ledger.capHit = true;
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'A/B spend cap reached: this call was not sent' } }));
        return;
      }
      ledger.reserved += reserve;
    }
    let status = 0, text = '';
    try {
      const up = await fetch(upstreamBase + req.url, { method: req.method, headers, body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body });
      status = up.status;
      const h = {}; up.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) h[k] = v; });
      res.writeHead(up.status, h);
      if (up.body) {
        const reader = up.body.getReader(); const dec = new TextDecoder();
        for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(Buffer.from(value)); if (isCall) text += dec.decode(value, { stream: true }); }
      }
      res.end();
    } catch (_) {   // never echo the error: a fetch failure carries nothing worth the risk
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'A/B proxy: upstream unreachable' } })); }
      else res.end();
    } finally {
      if (isCall) {
        ledger.reserved -= reserve;
        const call = parseCall(text);
        const booked = call.counts ? capCost(call.counts) : (status === 200 ? reserve : 0);   // an error before generation bills nothing
        ledger.spent += booked;
        ledger.calls.push(Object.assign({ tag, status, capUsd: booked }, call));
      }
    }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(c => server.close(() => c())) })));
}

// ---- the tasks ----
const PROBE_SOURCES = ['sidecar/compaction-fidelity.js', 'sidecar/run-execution-state.js', 'sidecar/turn-window.js', 'sidecar/compaction-summarizer.js',
  'sidecar/budget.js', 'sidecar/turn-view.js', 'frontend/app/historyfit.js', 'sidecar/tools/builtin/todo.js', 'sidecar/earlier-conversation.js',
  'sidecar/growth-fold.js', 'sidecar/cost.js', 'sidecar/output-artifacts.js', 'sidecar/usage-receipts.js', 'sidecar/run-wire.js'];
const RUN_TESTS = "'use strict';\nconst fs = require('fs'); const path = require('path');\nconst files = fs.readdirSync(path.join(__dirname, 'src')).filter(f => f.endsWith('.js')).sort();\nlet n = 0;\nconsole.log('TAP version 13');\nfor (const f of files) { console.log('ok ' + (++n) + ' - src/' + f + ' is present'); }\nconsole.log('1..' + n);\n";
const tokenRe = /TOKEN-\d\d-[A-Z0-9]{6}/g;
const filler = (n) => { let s = ''; while (s.length < n) s += 'filler line for realism, nothing to note here. '; return s.slice(0, n); };
const declared = src => Array.from(new Set((String(src).match(/\bfunction\s+[A-Za-z0-9_$]+\s*\(/g) || []).map(s => s.replace(/^function\s+/, '').replace(/\s*\($/, ''))));

function chainTask(id, deep) {
  return {
    id,
    build(root) {
      const dir = path.join(root, 'chain');
      fs.mkdirSync(dir, { recursive: true });
      const names = [], tokens = [];
      for (let i = 1; i <= CHAIN_FILES; i++) names.push('node-' + crypto.randomBytes(3).toString('hex') + '.txt');
      for (let i = 1; i <= CHAIN_FILES; i++) {
        const tok = 'TOKEN-' + String(i).padStart(2, '0') + '-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
        tokens.push(tok);
        const next = i < CHAIN_FILES ? 'NEXT FILE TO READ: ' + names[i] : 'END OF CHAIN. You have now read all ' + CHAIN_FILES + ' files.';
        const lines = deep ? ['step ' + i + ' of ' + CHAIN_FILES, next, filler(2200), 'secret token: ' + tok, filler(2600), '']
          : ['step ' + i + ' of ' + CHAIN_FILES, next, 'secret token: ' + tok, filler(4800), ''];
        fs.writeFileSync(path.join(dir, names[i - 1]), lines.join('\n'));
      }
      fs.writeFileSync(path.join(dir, 'start.txt'), 'NEXT FILE TO READ: ' + names[0] + '\n');
      return {
        directive: 'AB TASK chain: In the folder chain read start.txt with the file read tool. It names the next file to read; each file names the one after it, and each carries one line "secret token: TOKEN-NN-XXXXXX". Follow the chain to the end (' + CHAIN_FILES + ' files). The file names are unknown until you read the previous file, so read them one at a time. Do not stop early. Write NO text between tool calls (no narration, no running notes) - just make the next read. Only when you reach END OF CHAIN, reply with the complete list of every token you read, one per line, in order. Nothing else.',
        grade(answer) {
          const seen = new Set(String(answer || '').match(tokenRe) || []);
          const found = tokens.filter(t => seen.has(t)).length;
          return { success: found === tokens.length, score: found / tokens.length, detail: found + '/' + tokens.length + ' tokens' };
        }
      };
    }
  };
}
const probeTask = {
  id: 'probe-project',
  build(root) {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    const files = [];
    for (const rel of PROBE_SOURCES) { const base = path.basename(rel); fs.copyFileSync(path.join(REPO, rel), path.join(proj, 'src', base)); files.push(base); }
    fs.writeFileSync(path.join(proj, 'run-tests.js'), RUN_TESTS);
    return {
      directive: 'AB TASK probe: The project in proj/ has these source files in proj/src. FILES: ' + files.join(', ') + '\nFor EACH file, in the order given: read it whole with the file read tool, then append to proj/docs/MODULES.md (use the append tool; the first append creates it) a section that starts with the line "## <file name>" followed by one line "- <name>" for every function the file declares with the `function` keyword (at any nesting level). One file at a time: read, then append, then the next file. When every file is done, run `node proj/run-tests.js` once and reply with one line: how many files you documented.',
      grade(answer, calls) {
        let doc = ''; try { doc = fs.readFileSync(path.join(proj, 'docs', 'MODULES.md'), 'utf8'); } catch (_) { doc = ''; }
        const sections = new Map();
        const parts = doc.split(/^## +/m).slice(1);
        for (const p of parts) { const nl = p.indexOf('\n'); sections.set(p.slice(0, nl < 0 ? p.length : nl).trim(), nl < 0 ? '' : p.slice(nl + 1)); }
        const rows = files.map(f => {
          const names = declared(fs.readFileSync(path.join(proj, 'src', f), 'utf8'));
          const body = sections.has(f) ? sections.get(f) : null;
          const listed = body == null ? 0 : names.filter(n => new RegExp('(^|[^A-Za-z0-9_$])' + n.replace(/\$/g, '\\$') + '([^A-Za-z0-9_$]|$)').test(body)).length;
          return { f, ok: body != null && (names.length === 0 || listed / names.length >= 0.9), cover: names.length ? listed / names.length : 1 };
        });
        const ran = calls.some(c => /shell[._]exec/.test(c.name));
        const good = rows.filter(r => r.ok).length;
        return { success: ran && good === rows.length, score: ran ? good / rows.length : 0, detail: good + '/' + rows.length + ' files >= 90% (min ' + Math.round(100 * Math.min(...rows.map(r => r.cover))) + '%), tests ' + (ran ? 'ran' : 'NOT run') };
      }
    };
  }
};
const TASKS = { 'chain-head': chainTask('chain-head', false), 'chain-deep': chainTask('chain-deep', true), 'probe-project': probeTask };

// ---- one arm ----
function hermeticEnv(arm) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_|AB_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', SKYNET_QUEST_REFRESH: '0',
    SKYNET_AUX_BUDGET: '0', STARNET_BATCHED_AGEING: arm === 'on' ? '1' : '' });
}
function noteCount(out, tag) {
  let n = 0;
  for (const l of out) { if (l.indexOf(tag) < 0) continue; const m = /\(x(\d+)\)/.exec(l); n = Math.max(n, m ? Number(m[1]) : n + 1); }
  return n;
}
function noteSum(out, tag, re) { let s = 0; for (const l of out) { if (l.indexOf(tag) < 0) continue; const m = re.exec(l); if (m) s += Number(m[1]); } return s; }

async function runArm(taskId, arm, ledger, upstreamBase) {
  if (ledger.capHit) return { task: taskId, arm, ran: false, why: 'not run (cap)' };
  const tag = taskId + '/' + arm;
  const proxy = await startProxy(ledger, tag, upstreamBase);
  const fixture = SidecarFixture.create({ prefix: 'ageing-ab-', timeoutMs: 60000, env: hermeticEnv(arm) });
  const root = path.join(fixture.workspace, 'ab');
  const nonce = crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();
  try {
    const task = TASKS[taskId].build(root);
    await fixture.start();
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'anthropic', baseUrl: proxy.base + '/v1', key: 'ab-placeholder-the-proxy-sets-the-real-key', model: MODEL, reasoningEffort: EFFORT,
      agentId: 'ab', isTask: true, placed: FLOOR, stationPlaced: FLOOR,
      system: 'AB-' + arm + '-' + nonce + ': you are the lead.', messages: [{ role: 'user', content: task.directive }] }) });
    if (r.status !== 200) return { task: taskId, arm, ran: false, why: 'run refused: HTTP ' + r.status };
    const raw = await r.text();
    const events = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    let answer = '';
    for (const ev of events) if (ev.name === 'agent.token') answer += (ev.payload && ev.payload.delta) || '';
    for (const ev of events) if (ev.payload && typeof ev.payload.text === 'string') answer += '\n' + ev.payload.text;
    const calls = events.filter(e => e.name === 'agent.tool_call').map(e => ({ name: String(e.payload && e.payload.name || ''), args: String(e.payload && e.payload.argsSummary || '') }));
    const pathOf = c => { const m = /"path"\s*:\s*"([^"]+)"/.exec(c.args); return m ? m[1] : ''; };
    const reads = calls.filter(c => /fs[._]read$/.test(c.name)).map(pathOf);
    const seen = new Set(); let sourceRereads = 0;
    for (const p of reads) { if (!p || /\.output\//.test(p)) continue; if (seen.has(p)) sourceRereads++; seen.add(p); }
    const out = String(fixture.output() || '').split(/\r?\n/);
    const mine = ledger.calls.filter(c => c.tag === tag);
    const sum = { calls: mine.length, uncached: 0, read: 0, write5m: 0, write1h: 0, out: 0, inputEq: 0, listUsd: 0, capUsd: 0, apiDroppedThinking: 0, noUsage: 0 };
    for (const c of mine) {
      sum.capUsd += c.capUsd; sum.apiDroppedThinking += c.apiDroppedThinking;
      if (!c.counts) { sum.noUsage++; continue; }
      const lc = listCost(c.counts);
      sum.uncached += c.counts.uncached; sum.read += c.counts.read; sum.write5m += c.counts.w5; sum.write1h += c.counts.w1h; sum.out += c.counts.out;
      sum.inputEq += lc.inputEq; sum.listUsd += lc.usd;
    }
    const end = (events.find(e => e.name === 'agent.run.end') || {}).payload || {};
    const grade = task.grade(answer, calls);
    return {
      task: taskId, arm, ran: true, ms: Date.now() - t0, reason: end.reason || null, turns: end.turns || null, sidecarBookedUsd: end.usd == null ? null : end.usd,
      success: grade.success, score: +grade.score.toFixed(3), detail: grade.detail,
      batches: noteCount(out, 'loop.historyEdit.aged'), folds: events.filter(e => e.name === 'agent.compact').length,
      handleRereads: reads.filter(p => /\.output\//.test(p)).length, sourceRereads,
      harnessStrippedThinkingTurns: noteSum(out, 'loop.historyEdit.thinkingStripped', /thinking of (\d+) earlier turn/),
      apiDroppedThinking: sum.apiDroppedThinking, sidecarSawDrops: noteSum(out, 'providers.anthropic.thinking_dropped', /dropped (\d+) replayed thinking/),
      parkFailures: noteCount(out, 'loop.historyEdit.park'), usage: sum, capRefused: ledger.capHit
    };
  } catch (e) {
    return { task: taskId, arm, ran: false, why: 'harness error: ' + String((e && e.message) || e).slice(0, 200) };
  } finally {
    await fixture.dispose();
    await proxy.close();
  }
}

// ---- --self-test: a LOCAL mock Anthropic upstream (no key, no network beyond 127.0.0.1, no spend) ----
function textOf(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map(b => (b && b.type === 'text') ? String(b.text || '') : (b && b.type === 'tool_result') ? textOf(b.content) : '').join('\n');
}
/* The mock "model" remembers what it has seen per arm (memo: tokens, appended files), as a model keeps its own notes:
   an aged stub (a result's head, or an argument's stub) is never mistaken for work not done. */
const hasToken = s => /TOKEN-\d\d-[A-Z0-9]{6}/.test(s);
function mockPolicy(body, memo) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const results = [], uses = [];
  let userText = '';
  for (const m of msgs) {
    if (typeof m.content === 'string') { if (m.role === 'user') userText += '\n' + m.content; continue; }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'tool_result') results.push({ id: b.tool_use_id, text: textOf(b.content) });
      else if (b.type === 'tool_use') uses.push({ id: b.id, name: b.name, input: b.input || {} });
      else if (b.type === 'text' && m.role === 'user') userText += '\n' + String(b.text || '');
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools.map(t => t && t.name).filter(Boolean) : [];
  const tool = (re, fb) => tools.find(n => re.test(n)) || fb;
  const READ_T = tool(/^fs[._]read$/, 'fs_read'), APPEND_T = tool(/^fs[._]append$/, 'fs_append'), EXEC_T = tool(/^shell[._]exec$/, 'shell_exec');
  const call = (name, input) => ({ tool: { name, input } });
  const say = text => ({ text });
  const readPaths = new Set(uses.filter(u => u.name === READ_T).map(u => String(u.input.path || '')));
  if (/AB TASK chain/.test(userText)) {
    const dir = (/In the folder (\S+) read start\.txt/.exec(userText) || [])[1] || 'chain';
    if (!results.length) return call(READ_T, { path: dir + '/start.txt' });
    const last = results[results.length - 1].text;
    const next = /NEXT FILE TO READ: (\S+)/.exec(last);
    if (next && !readPaths.has(dir + '/' + next[1])) return call(READ_T, { path: dir + '/' + next[1] });
    const all = results.map(r => r.text).join('\n');
    const total = Number((/read all (\d+) files/.exec(all) || [])[1]) || CHAIN_FILES;
    for (const t of all.match(tokenRe) || []) memo.tokens.add(t);
    if (memo.tokens.size < total) {
      for (const r of results) {   // an aged result whose token left with its body: read it back through its handle
        if (hasToken(r.text)) continue;
        const h = /read it with fs\.read (\{"path":"[^"]+"\})/.exec(r.text);
        let p = null; try { p = h ? JSON.parse(h[1]).path : null; } catch (_) { p = null; }
        if (p && !readPaths.has(p)) return call(READ_T, { path: p });
      }
    }
    return say(Array.from(memo.tokens).sort().join('\n'));
  }
  if (/AB TASK probe/.test(userText)) {
    const files = ((/FILES: ([^\n]+)/.exec(userText) || [])[1] || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const f of files) {
      const p = 'proj/src/' + f;
      const u = uses.filter(x => x.name === READ_T && x.input.path === p).pop();
      if (!u) return call(READ_T, { path: p });
      if (!memo.appended.has(f)) {
        const r = results.find(x => x.id === u.id);
        memo.appended.add(f);
        return call(APPEND_T, { path: 'proj/docs/MODULES.md', content: '## ' + f + '\n' + declared(r ? r.text : '').map(n => '- ' + n).join('\n') + '\n\n' });
      }
    }
    if (!uses.some(x => x.name === EXEC_T)) return call(EXEC_T, { cmd: 'node proj/run-tests.js' });
    return say('Documented ' + files.length + ' files.');
  }
  return say('OK.');
}
function startMockAnthropic() {
  const prevByArm = new Map(), memoByArm = new Map();
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET' && /\/v1\/models/.test(req.url)) {
      const row = { type: 'model', id: MODEL, display_name: MODEL, created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 64000 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(/\/v1\/models\/./.test(req.url) ? row : { data: [row], has_more: false, first_id: MODEL, last_id: MODEL }));
    }
    if (req.method !== 'POST' || !/\/v1\/messages(\?|$)/.test(req.url)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"mock"}}'); }
    let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
    const sys = textOf(body.system);
    const armKey = (/AB-(?:on|off)-[0-9a-f]+/.exec(sys) || ['aux'])[0];
    if (!memoByArm.has(armKey)) memoByArm.set(armKey, { tokens: new Set(), appended: new Set() });
    const reply = mockPolicy(body, memoByArm.get(armKey));
    if (process.env.AB_MOCK_DUMP) { try { fs.writeFileSync(path.join(process.env.AB_MOCK_DUMP, armKey + '.last.json'), JSON.stringify({ body, reply }, null, 1)); } catch (_) {} }
    // the cache model: the message prefix shared with this arm's previous call is a read, the rest a 5-minute write
    const segs = [JSON.stringify(body.system || '') + JSON.stringify(body.tools || [])].concat((body.messages || []).map(m => JSON.stringify(m)));
    const prev = prevByArm.get(armKey) || [];
    let k = 0, readChars = 0;
    while (k < segs.length && k < prev.length && segs[k] === prev[k]) { readChars += segs[k].length; k++; }
    prevByArm.set(armKey, segs);
    const total = segs.reduce((a, s) => a + s.length, 0);
    const read = Math.round(readChars / 3.6), write = Math.max(0, Math.round((total - readChars) / 3.6) - 3);
    const usage = { input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 };
    seq++;
    const blocks = [];
    if (reply.text) blocks.push({ type: 'text', text: reply.text });
    if (reply.tool) blocks.push({ type: 'tool_use', id: 'toolu_mock_' + seq, name: reply.tool.name, input: reply.tool.input });
    const stop = reply.tool ? 'tool_use' : 'end_turn';
    if (body.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_mock_' + seq, type: 'message', role: 'assistant', model: MODEL, content: blocks, stop_reason: stop, usage: Object.assign({}, usage, { output_tokens: 40 }) }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = ev => res.write('event: ' + ev.type + '\ndata: ' + JSON.stringify(ev) + '\n\n');
    send({ type: 'message_start', message: { id: 'msg_mock_' + seq, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage } });
    blocks.forEach((b, i) => {
      if (b.type === 'text') {
        send({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
      } else {
        send({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        send({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      send({ type: 'content_block_stop', index: i });
    });
    send({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 40 } });
    send({ type: 'message_stop' });
    res.end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(c => server.close(() => c())) })));
}

// ---- the A/B ----
(async () => {
  const mock = SELF_TEST ? await startMockAnthropic() : null;
  const upstream = mock ? mock.base : UPSTREAM;
  const ledger = { spent: 0, reserved: 0, refused: 0, capHit: false, calls: [] };
  const rows = [];
  console.log('[batched-ageing-ab] ' + (SELF_TEST ? 'SELF-TEST (local mock upstream, no spend)' : 'REAL MODEL A/B') + ': model ' + MODEL + ', effort ' + EFFORT + ', tasks ' + TASK_IDS.join(',') + ', hard cap $' + CAP);
  try {
    for (let i = 0; i < TASK_IDS.length; i++) {
      const order = i % 2 === 0 ? ['off', 'on'] : ['on', 'off'];
      for (const arm of order) {
        const row = await runArm(TASK_IDS[i], arm, ledger, upstream);
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  } finally { if (mock) await mock.close(); }
  const verdicts = TASK_IDS.map(t => {
    const off = rows.find(r => r.task === t && r.arm === 'off'), on = rows.find(r => r.task === t && r.arm === 'on');
    if (!off || !on || !off.ran || !on.ran) return { task: t, verdict: 'INCOMPLETE', off: off && off.why, on: on && on.why };
    const cost = (on.usage.listUsd - off.usage.listUsd) / (off.usage.listUsd || 1);
    const eq = (on.usage.inputEq - off.usage.inputEq) / (off.usage.inputEq || 1);
    const pass = (on.success || !off.success) && on.score >= off.score && on.apiDroppedThinking === 0 && off.apiDroppedThinking === 0 && on.usage.listUsd < off.usage.listUsd;
    return { task: t, verdict: pass ? 'PASS' : 'FAIL', successOff: off.success, successOn: on.success, scoreOff: off.score, scoreOn: on.score, costDeltaPct: +(cost * 100).toFixed(1), inputEqDeltaPct: +(eq * 100).toFixed(1),
      batchesOn: on.batches, handleRereadsOn: on.handleRereads, sourceRereadsOff: off.sourceRereads, sourceRereadsOn: on.sourceRereads,
      apiDroppedThinking: [off.apiDroppedThinking, on.apiDroppedThinking], harnessStrippedTurnsOn: on.harnessStrippedThinkingTurns };
  });
  const summary = { model: MODEL, effort: EFFORT, readRatio: READ, capUsd: CAP, spentAtCapRatesUsd: +ledger.spent.toFixed(4), refusedCalls: ledger.refused, verdicts };
  console.log(JSON.stringify(summary, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1));
  if (SELF_TEST) {
    const problems = [];
    if (ledger.spent > CAP + 1e-9) problems.push('booked ' + ledger.spent + ' above the cap ' + CAP);
    if (CAP < 0.01) {   // cap mode: the first call must be refused, nothing may run past it
      if (ledger.refused < 1) problems.push('cap mode: no call was refused');
      if (ledger.calls.length) problems.push('cap mode: ' + ledger.calls.length + ' call(s) went out');
    } else {
      // chain-deep's success is the loop's to decide (its strategy guard refuses a long burst of re-reads, in both arms):
      // the self-test checks the plumbing, never a policy outcome
      for (const r of rows) if (!r.ran || r.reason !== 'done' || (r.task !== 'chain-deep' && !r.success)) problems.push(r.task + '/' + r.arm + ': ' + (r.why || (r.reason + ', ' + r.detail)));
      for (const r of rows.filter(x => x.ran && x.arm === 'off')) if (r.batches) problems.push(r.task + '/off aged ' + r.batches + ' batch(es) with the switch off');
      for (const r of rows.filter(x => x.ran && x.arm === 'on')) if (!r.batches) problems.push(r.task + '/on never aged');
      for (const r of rows.filter(x => x.ran)) if (!r.usage.calls || r.usage.noUsage) problems.push(r.task + '/' + r.arm + ': ' + r.usage.calls + ' call(s), ' + r.usage.noUsage + ' without usage');
      const deepOn = rows.find(x => x.task === 'chain-deep' && x.arm === 'on');
      if (deepOn && deepOn.ran && !deepOn.handleRereads) problems.push('chain-deep/on: the mock never re-read a handle');
    }
    console.log(problems.length ? 'SELF-TEST FAILED: ' + problems.join(' | ') : 'SELF-TEST OK');
    process.exitCode = problems.length ? 1 : 0;
  }
})().catch(e => { console.error('[batched-ageing-ab] crashed: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
