/* node test/learned-prefix.e2e.test.js — the LEARNED Commander blocks ride AFTER the cache prefix, on the wire.

   The browser ends each persona with the Commander dossier and (while style confidence is low) the fork directive.
   Both change as the station learns, and flip at app launch while the browser hydrates — and inside the cached
   system prefix each change re-billed the whole ~35k-token stable prefix as a cold write. This boots the REAL
   sidecar against a mock upstream and proves, for the anthropic and openrouter adapters, that the stable system
   block is byte-identical across a dossier change + the fork gate flipping, while the learned text still reaches
   the model right after it; that a stale sidecar dossier copy changes nothing; that STARNET_LEARNED_AFTER_PREFIX=0
   restores the old placement; and, through a fake Claude Code CLI, that the part before the CLI's dynamic boundary
   is identical across the same two runs with the learned text after the boundary. TASK turns carry chat.js's
   space-glued task hint (read from chat.js), and their stable block / pre-boundary hash must not change between
   dossier+fork, dossier only and nothing learned (anthropic + claude-cli). Zero real network, zero spend. */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Fork = require('../frontend/app/fork.js');
const Dossier = require('../frontend/app/dossier.js');
const { DOSSIER_HEAD } = require('../sidecar/learned-blocks.js');

const text = content => typeof content === 'string' ? content : (content || []).map(p => p.text || '').join('');
const IDENT = 'LEARNED_PREFIX_IDENTITY: You are a careful station agent. Preserve all required checks.';
const FORK = Fork.directive();
const FORK_HEAD = 'MID-TASK PREFERENCE FORK';
const block = (beliefs) => {
  const d = Dossier.fresh();
  beliefs.forEach(([dim, t], i) => Dossier.upsert(d, dim, { text: t }, i + 1));
  return Dossier.composeBlock(d, {});
};
const D1 = block([['stack', 'TypeScript'], ['goals', 'Ship Phase A']]);
const D2 = block([['stack', 'TypeScript'], ['goals', 'Ship Phase A'], ['style', 'terse bullet summaries']]);
const D3 = block([['stack', 'Rust'], ['people', 'the platform team']]);
const BASE_ENV = { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_QUEST_REFRESH: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '' };
const count = (s, needle) => s.split(needle).length - 1;
// the task hint chat.js appends on task turns, read from its source so a wording change is caught here
const HINT = (() => {
  const m = /\(isTask \? '((?:[^'\\]|\\.)*)' : ''\)/.exec(fs.readFileSync(path.resolve(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8'));
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
})();

const FAKE_CLI = String.raw`'use strict';
const fs = require('fs'), crypto = require('crypto');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
if (args[0] === 'auth') {
  if (args[1] === 'status') out({ loggedIn: true, authMethod: 'claude.ai', email: 'fake@example.test', subscriptionType: 'max' });
  process.exit(0);
}
/* one-shot (STARNET_CLAUDE_CLI_PERSIST=0) closes stdin after its one message; the default PERSISTENT child keeps
   stdin open and sends one stream-json line per turn, so answer each line as it arrives. The system prompt is
   fixed for the child's life: log it once per spawn. */
const at = args.indexOf('--system-prompt-file');
const sys = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : '';
if (sys.indexOf('LEARNED_PREFIX_IDENTITY') >= 0) {
  const cut = sys.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
  const pre = cut >= 0 ? sys.slice(0, cut) : sys;
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ boundary: cut >= 0, preSha: crypto.createHash('sha256').update(pre).digest('hex'), pre, post: cut >= 0 ? sys.slice(cut) : '' }) + '\n');
}
let input = '', inited = false;
const answer = () => {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] }); }
  const usage = { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 };
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'acknowledged' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'acknowledged', stop_reason: 'end_turn', usage, total_cost_usd: 0 });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  input += d;
  let nl;
  while ((nl = input.indexOf('\n')) >= 0) { const line = input.slice(0, nl); input = input.slice(nl + 1); if (line.trim()) answer(); }
});
process.stdin.on('end', () => { if (input.trim()) answer(); process.exit(0); });
`;

function makeFakeClaude(root) {
  const pkg = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
  const shim = path.join(root, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
  return shim;
}

async function post(fx, p, body) {
  return fetch(fx.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fx.token, Origin: fx.baseUrl }, body: JSON.stringify(body) });
}
async function pushDossier(fx, b) {
  const r = await post(fx, '/api/dossier', { block: b });
  A.eq(r.status, 200, 'POST /api/dossier accepted');
  await r.text();
}
async function run(fx, req, label) {
  const r = await post(fx, '/api/run', Object.assign({ agentId: 'agent', isTask: true, placed: [], messages: [{ role: 'user', content: 'Please acknowledge this request.' }] }, req));
  A.eq(r.status, 200, label + ': /api/run streams');
  const events = (await r.text()).trim().split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  A.eq(end && end.payload && end.payload.reason, 'done', label + ': run finished');
}

(async () => {
  A.ok(/^ If this needs real work/.test(HINT), 'chat.js task hint extracted from source');
  const bodies = [];
  const upstream = http.createServer(async (req, res) => {
    req.setEncoding('utf8');
    let raw = ''; for await (const part of req) raw += part;
    if (!raw) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const system = body.system ? text(body.system) : body.messages.filter(m => m.role === 'system').map(m => text(m.content)).join('\n\n');
    if (system.includes('LEARNED_PREFIX_IDENTITY')) bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.system) res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"acknowledged"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n');
    else res.end('data: {"choices":[{"delta":{"content":"acknowledged"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const parts = body => body.system || body.messages[0].content;
  const wireText = body => (body.system ? text(body.system) : '') + '\n' + body.messages.map(m => text(m.content)).join('\n');
  const wire = provider => ({ provider, baseUrl, key: 'fixture-key', model: provider === 'anthropic' ? 'claude-test' : 'anthropic/claude-test', reasoningEffort: 'low' });
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-learnedcli-'));
  const cliLog = path.join(fakeRoot, 'calls.jsonl');
  fs.writeFileSync(cliLog, '');
  const fixture = new SidecarFixture({ env: Object.assign({}, BASE_ENV, { STARNET_CLAUDE_BIN: makeFakeClaude(fakeRoot), FAKE_CLAUDE_LOG: cliLog }) });
  const legacy = new SidecarFixture({ env: Object.assign({}, BASE_ENV, { STARNET_LEARNED_AFTER_PREFIX: '0' }) });
  try {
    await fixture.start();
    for (const provider of ['anthropic', 'openrouter']) {
      bodies.length = 0;
      await pushDossier(fixture, D1);
      await run(fixture, Object.assign(wire(provider), { streamId: 'learned-' + provider, system: IDENT + '\n\n' + D1 + '\n\n' + FORK }), provider + ' run 1');
      await pushDossier(fixture, D2);
      await run(fixture, Object.assign(wire(provider), { streamId: 'learned-' + provider, system: IDENT + '\n\n' + D2 }), provider + ' run 2');
      // stale: the persona carries a dossier the sidecar copy does not match
      await run(fixture, Object.assign(wire(provider), { streamId: 'learned-' + provider, system: IDENT + '\n\n' + D3 + '\n\n' + FORK }), provider + ' stale run');
      A.eq(bodies.length, 3, provider + ': one foreground inference per run');
      if (bodies.length !== 3) continue;
      const [a, b, c] = bodies.map(parts);
      A.ok(Array.isArray(a) && a.length === 2 && Array.isArray(b) && b.length === 2 && Array.isArray(c) && c.length === 2, provider + ': split stable + volatile system blocks');
      if (!Array.isArray(a) || !Array.isArray(b) || !Array.isArray(c)) continue;
      A.eq(a[0], b[0], provider + ': stable system block identical across a dossier change and the fork gate flipping');
      A.eq(a[0], c[0], provider + ': a stale sidecar dossier copy leaves the stable block identical too');
      A.ok(a[0].text.indexOf(IDENT) === 0, provider + ': the persona still opens the stable block');
      A.ok(a[0].text.length > 10000 && a[0].text.length > a[1].text.length, provider + ': the full stable prefix is still cached');
      for (const p of [a, b, c]) {
        A.ok(p[0].text.indexOf(DOSSIER_HEAD) < 0 && p[0].text.indexOf(FORK_HEAD) < 0, provider + ': no learned block inside the stable prefix');
        A.ok((p[0].text + p[1].text).indexOf('Run id:') < 0, provider + ': runtime identity rides the <run_context> note, not the system prompt');
      }
      A.ok(a[1].text.indexOf('\n\n' + D1 + '\n\n' + FORK) === 0, provider + ': run 1 learned blocks lead the volatile block, in order');
      A.ok(b[1].text.indexOf('\n\n' + D2) === 0 && b[1].text.indexOf(FORK_HEAD) < 0, provider + ': run 2 carries the new dossier and no fork');
      A.ok(c[1].text.indexOf('\n\n' + D3 + '\n\n' + FORK) === 0, provider + ': stale run still delivers the persona\'s own dossier');
      // everything the model reads: the system blocks plus every message (the evidence pack rides the <run_context> note)
      const [wa, wb, wc] = bodies.map(wireText);
      for (const [w, label] of [[wa, 'run 1'], [wb, 'run 2']]) {
        A.eq(count(w, DOSSIER_HEAD), 1, provider + ' ' + label + ': the dossier reaches the model exactly once (no duplicate evidence copy)');
      }
      // stale: the evidence pack still sees the ORIGINAL persona, so it adds the sidecar's (different) copy in its own
      // <commander_context> wrapper exactly as before — untouched, and never mistaken for a learned paragraph.
      A.eq(count(wc, '<commander_context provenance="commander-dossier">\n' + D2 + '\n</commander_context>'), 1, provider + ': stale run keeps the evidence copy in its wrapper');
      A.eq(count(wc, DOSSIER_HEAD), 2, provider + ': stale run carries the persona dossier + the wrapped evidence copy, nothing more');
    }

    // claude-cli: the part before the CLI's dynamic boundary is identical across the two runs
    await pushDossier(fixture, D1);
    await run(fixture, { provider: 'claude-cli', model: 'sonnet', streamId: 'learned-cli', system: IDENT + '\n\n' + D1 + '\n\n' + FORK }, 'claude-cli run 1');
    await pushDossier(fixture, D2);
    await run(fixture, { provider: 'claude-cli', model: 'sonnet', streamId: 'learned-cli', system: IDENT + '\n\n' + D2 }, 'claude-cli run 2');
    const calls = fs.readFileSync(cliLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    A.eq(calls.length, 2, 'claude-cli: one CLI spawn per run');
    if (calls.length === 2) {
      A.ok(calls[0].boundary && calls[1].boundary, 'claude-cli: both prompts carry the dynamic boundary');
      A.eq(calls[0].preSha, calls[1].preSha, 'claude-cli: the cached part before the boundary is byte-identical');
      A.ok(calls[0].pre.indexOf(DOSSIER_HEAD) < 0 && calls[0].pre.indexOf(FORK_HEAD) < 0, 'claude-cli: no learned block before the boundary');
      A.ok(calls[0].post.indexOf(D1) >= 0 && calls[0].post.indexOf(FORK) >= 0, 'claude-cli: run 1 learned blocks after the boundary');
      A.ok(calls[1].post.indexOf(D2) >= 0 && calls[1].post.indexOf(FORK_HEAD) < 0, 'claude-cli: run 2 dossier after the boundary, no fork');
    }

    /* TASK TURNS: chat.js glues its task hint straight onto the persona (no blank line), so the last learned block
       is not closed by a paragraph break. The stable block must still be identical across the persona states the
       launch hydration and the fork gate flip between: dossier+fork, dossier only, nothing learned yet. */
    await pushDossier(fixture, D1);
    const TASK_STATES = [['dossier+fork', '\n\n' + D1 + '\n\n' + FORK], ['dossier', '\n\n' + D1], ['none', '']];
    for (const provider of ['anthropic', 'claude-cli']) {
      bodies.length = 0;
      const before = fs.readFileSync(cliLog, 'utf8').split('\n').filter(Boolean).length;
      for (const [state, blocks] of TASK_STATES) {
        const req = provider === 'claude-cli' ? { provider, model: 'sonnet' } : wire(provider);
        await run(fixture, Object.assign(req, { streamId: 'learned-task-' + provider, system: IDENT + blocks + HINT }), provider + ' task turn (' + state + ')');
      }
      if (provider === 'anthropic') {
        A.eq(bodies.length, 3, 'anthropic task turns: one inference each');
        if (bodies.length === 3) {
          const ps = bodies.map(parts);
          A.eq(ps[0][0], ps[1][0], 'anthropic task turn: stable block identical, dossier+fork vs dossier only');
          A.eq(ps[0][0], ps[2][0], 'anthropic task turn: stable block identical, dossier+fork vs nothing learned');
          A.ok(ps[0][0].text.indexOf(IDENT + HINT) === 0, 'anthropic task turn: the task hint stays in the stable block, right after the identity');
          A.ok(ps[0][1].text.indexOf('\n\n' + D1 + '\n\n' + FORK) === 0 && ps[1][1].text.indexOf('\n\n' + D1) === 0, 'anthropic task turn: learned blocks lead the volatile block');
        }
      } else {
        const calls2 = fs.readFileSync(cliLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(before);
        A.eq(calls2.length, 3, 'claude-cli task turns: one spawn each');
        if (calls2.length === 3) {
          A.ok(calls2.every(c => c.boundary), 'claude-cli task turns: dynamic boundary present');
          A.eq(calls2.map(c => c.preSha), [calls2[0].preSha, calls2[0].preSha, calls2[0].preSha], 'claude-cli task turns: pre-boundary hash identical across all three persona states');
          A.ok(calls2[0].pre.indexOf(IDENT + HINT) >= 0 && calls2[0].pre.indexOf(DOSSIER_HEAD) < 0, 'claude-cli task turn: hint before the boundary, dossier not');
          A.ok(calls2[0].post.indexOf(D1 + '\n\n' + FORK) >= 0, 'claude-cli task turn: learned blocks after the boundary');
        }
      }
    }

    // kill switch: STARNET_LEARNED_AFTER_PREFIX=0 restores the old placement (dossier inside the stable block)
    await legacy.start();
    bodies.length = 0;
    await pushDossier(legacy, D1);
    await run(legacy, Object.assign(wire('anthropic'), { streamId: 'legacy', system: IDENT + '\n\n' + D1 + '\n\n' + FORK }), 'kill-switch run');
    A.eq(bodies.length, 1, 'kill switch: one inference');
    if (bodies.length === 1) {
      const p = parts(bodies[0]);
      A.ok(p[0].text.indexOf(IDENT + '\n\n' + D1 + '\n\n' + FORK) === 0, 'kill switch: the persona rides the stable block verbatim (old behaviour)');
    }
  } finally {
    await fixture.dispose();
    await legacy.dispose();
    await new Promise(resolve => upstream.close(resolve));
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('learned-prefix.e2e.test');
})().catch(e => { console.log('FAIL: learned-prefix.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
