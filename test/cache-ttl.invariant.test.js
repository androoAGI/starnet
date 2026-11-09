'use strict';
/* node test/cache-ttl.invariant.test.js — ONE CACHE-TTL RESOLVER (W1.13 cache TTL plumbing, cost audit 2026-11-08).

   Prompt caching has two write tiers (claude-api skill, shared/prompt-caching.md): cache_control {type:'ephemeral'} is the
   5-minute tier and {type:'ephemeral', ttl:'1h'} the 1-hour tier (:123-124); a write bills 1.25x input on the first and 2x
   on the second (:144); a 1-hour entry must come before any 5-minute one (:172); and usage.cache_creation splits
   cache_creation_input_tokens into ephemeral_5m_input_tokens and ephemeral_1h_input_tokens (:208).

   StarNet asked for one tier and priced one rate: a write the API split across both tiers was booked entirely at the
   rate SKYNET_ANTHROPIC_CACHE_TTL implied, the switch was read in two files (anthropic.js and prices.js, each once at
   load), and the OpenRouter stamper (which the managed route uses too) ignored it. This test locks the family closed:
     A. a mixed-TTL usage prices PER BUCKET on every route that reports the split (the native adapter, Claude Code), and
        the per-call usage receipt (W1.1) carries the two buckets; a route that does not report a split (OpenRouter, the
        managed route) never gets one invented, and an inconsistent split is not trusted;
     B. the kill switch (SKYNET_ANTHROPIC_CACHE_TTL=5m, and the default it equals) reproduces the pre-lane wire bodies byte
        for byte on every Claude route (test/fixtures/cache-ttl-golden.json, recorded from the base);
     C. '1h' puts every anchor on the 1-hour tier on EVERY Claude route; 'mixed' (the 1-hour stable anchors W3.6 turns on)
        changes cache markers only, keeps the 4-marker limit and the long-before-short order, puts the tool catalogue, the
        system prompt and the end of history (the last block before the newest <run_context> note) on the 1-hour tier and
        the newest messages on the 5-minute tier, and never stamps a never-reread request or a non-Claude model;
     D. one resolver: only sidecar/providers/cache-ttl.js reads the switch, and no other production file writes a
        cache_control object of its own.
   RED on 550c311ba: the anthropic adapter drops usage.cache_creation, receipts have no buckets, every write prices at
   one rate, '1h' leaves OpenRouter and the managed route on 5 minutes, 'mixed' does not exist, and two files read the
   switch.

   RE-RECORD the golden only when a commit changes a Claude wire body ON PURPOSE for a reason outside the cache TTL, and
   say so in that commit:  node test/cache-ttl.invariant.test.js --update */
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { decomment } = require('./helpers/decomment.js');

// hermetic: no operator switch from the shell reaches the adapters, prices or this file's own expectations
for (const k of Object.keys(process.env)) if (/^(SKYNET|STARNET)_/.test(k)) delete process.env[k];

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'cache-ttl-golden.json');
const HELPER = path.join(__dirname, 'helpers', 'cache-ttl-bodies.js');
const factory = require('../sidecar/providers/factory.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const receipts = require('../sidecar/usage-receipts.js');
const claudeCli = require('../sidecar/providers/claude-cli.js');

/* the bodies each Claude stamper sends under one switch value: a fresh child process per value */
function bodiesUnder(env) {
  const childEnv = {};
  for (const k of Object.keys(process.env)) if (!/^(SKYNET|STARNET)_/.test(k)) childEnv[k] = process.env[k];
  Object.assign(childEnv, env || {});
  const r = spawnSync(process.execPath, [HELPER], { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const m = String(r.stdout || '').match(/@@BODIES@@([\s\S]*)@@END@@/);
  if (r.status !== 0 || !m) throw new Error('body capture failed (' + JSON.stringify(env) + ', exit ' + r.status + '): ' + String(r.stderr || r.error || '').slice(0, 2000));
  return JSON.parse(m[1]);
}

if (process.argv.includes('--update')) {
  const bodies = bodiesUnder({ SKYNET_ANTHROPIC_CACHE_TTL: '5m' });
  let sha = 'unknown';
  try { sha = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) { /* not a git tree */ }
  fs.writeFileSync(GOLDEN, JSON.stringify({
    about: 'The exact request bodies every Claude cache stamper sends with SKYNET_ANTHROPIC_CACHE_TTL=5m (the kill switch, and the default). Read by test/cache-ttl.invariant.test.js; re-record (--update) only when a Claude wire body changes on purpose for a reason outside the cache TTL, and say so in that commit.',
    recordedAt: sha,
    bodies
  }, null, 1) + '\n');
  console.log('cache-ttl golden re-recorded at ' + sha + ': ' + Object.keys(bodies).length + ' bodies -> ' + path.relative(ROOT, GOLDEN));
  process.exit(0);
}

const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-12;
const sse = parts => parts.map(p => 'data: ' + JSON.stringify(p)).join('\n\n') + '\n\n';
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
const lastUsage = evs => { const u = evs.filter(e => e && e.type === 'usage').pop(); return u ? u.usage : null; };
const pick = (o, keys) => keys.map(k => (o && k in o) ? o[k] : '(absent)');
const BUCKETS = ['cacheWrite', 'cacheWrite5m', 'cacheWrite1h'];
function fakeFetch(body) {
  return async (url, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method !== 'POST') return new Response(JSON.stringify({ data: [], models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}
const anthropicReply = startUsage => sse([
  { type: 'message_start', message: { id: 'msg_ttl', usage: startUsage } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
  { type: 'message_stop' }]);

/* every cache_control marker of a body, in the order the API renders the prompt (tools -> system -> messages) */
function markers(body) {
  const out = [];
  const add = (at, m, b, cc) => out.push({ at, m, b, ttl: cc && cc.ttl === '1h' ? '1h' : (cc && cc.ttl == null ? '5m' : String(cc && cc.ttl)) });
  (body.tools || []).forEach((t, i) => { if (t && t.cache_control) add('stable', -1, i, t.cache_control); });
  if (Array.isArray(body.system)) body.system.forEach((s, i) => { if (s && s.cache_control) add('stable', -1, i, s.cache_control); });
  let leading = true;
  (body.messages || []).forEach((msg, m) => {
    if (!msg || msg.role !== 'system') leading = false;
    if (Array.isArray(msg && msg.content)) msg.content.forEach((blk, b) => { if (blk && blk.cache_control) add(leading ? 'stable' : 'message', m, b, blk.cache_control); });
  });
  return out;
}
// a body without its cache markers. On a chat wire a stamped message's string content becomes ONE text part (the
// stamper's only way to carry a marker); that part without its marker is the same content, so it reads back as the string
const strip = (s, chat) => {
  const b = JSON.parse(s, (k, v) => (k === 'cache_control' ? undefined : v));
  if (chat) for (const m of (b.messages || [])) {
    const c = m && m.content;
    if (Array.isArray(c) && c.length === 1 && c[0] && c[0].type === 'text' && Object.keys(c[0]).length === 2) m.content = c[0].text;
  }
  return JSON.stringify(b);
};
const swapTo1h = s => s.split('"cache_control":{"type":"ephemeral"}').join('"cache_control":{"type":"ephemeral","ttl":"1h"}');
const RUN_CONTEXT = '<run_context>';
const headText = c => typeof c === 'string' ? c : (Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '');
const CACHEABLE = { text: 1, image: 1, tool_use: 1, tool_result: 1, document: 1 };
/* where the fixed end-of-history anchor belongs: the nearest cacheable block before the newest <run_context> note
   (null when nothing but the system prompt precedes it, or there is no note) */
function fixedSpot(body, anthropic) {
  const msgs = body.messages || [];
  if (anthropic) {
    let at = null;
    msgs.forEach((msg, m) => (Array.isArray(msg.content) ? msg.content : []).forEach((blk, b) => {
      if (blk && blk.type === 'text' && typeof blk.text === 'string' && blk.text.indexOf(RUN_CONTEXT) === 0) at = { m, b };
    }));
    if (!at) return null;
    for (let m = at.m, b = at.b - 1; m >= 0; m--, b = m >= 0 ? msgs[m].content.length - 1 : -1) {
      for (; b >= 0; b--) { const blk = msgs[m].content[b]; if (blk && (!blk.type || CACHEABLE[blk.type])) return { m, b }; }
    }
    return null;
  }
  let note = -1, lead = -1;
  msgs.forEach((msg, m) => {
    if (msg && msg.role === 'system' && lead === m - 1) lead = m;
    if (msg && msg.role !== 'system' && headText(msg.content).indexOf(RUN_CONTEXT) === 0) note = m;
  });
  for (let m = note - 1; m > lead; m--) {
    const c = msgs[m] && msgs[m].content;
    if (!msgs[m] || msgs[m].role === 'system') continue;
    if (typeof c === 'string' ? c.trim() : (Array.isArray(c) && c.length && c[c.length - 1] && c[c.length - 1].type === 'text' && String(c[c.length - 1].text || '').trim())) return { m, b: typeof c === 'string' ? 0 : c.length - 1 };
  }
  return null;
}

const FAKE_CLI = `'use strict';
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000, output_tokens: 157,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 } } });
});
process.stdin.resume();
`;

(async () => {
  /* A. a mixed-TTL usage prices per bucket, and the receipt carries the buckets */
  const sink = receipts.makeUsageReceipts({ clock: { now: () => Date.now() } });
  factory.attachUsageReceipts(sink);
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-ttl-cli-'));
  try {
    // claude-sonnet-5-5 lists at $2 / $10 per million (prices.js); reads 0.1x, 5-minute writes 1.25x, 1-hour writes 2x
    const MODEL = 'claude-sonnet-5-5';
    const MIXED = { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000,
      cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 }, output_tokens: 1 };
    const perBucket = (100 + 4000 * 0.10 + 400 * 1.25 + 600 * 2.00) * 2 / 1e6 + 50 * 10 / 1e6;   // $0.0049
    const oneRate5m = (100 + 4000 * 0.10 + 1000 * 1.25) * 2 / 1e6 + 50 * 10 / 1e6;               // $0.0040, the pre-lane booking
    const oneRate1h = (100 + 4000 * 0.10 + 1000 * 2.00) * 2 / 1e6 + 50 * 10 / 1e6;               // $0.0055

    const callAnthropic = async startUsage => {
      sink.clear();
      const p = factory.selectProvider({ provider: 'anthropic', key: 'k', fetch: fakeFetch(anthropicReply(startUsage)) });
      const evs = await collect(p, { model: MODEL, messages: [{ role: 'user', content: 'hi' }], preStreamRetries: 0 });
      const usage = lastUsage(evs);
      return { usage, receipt: sink.records()[0] || null, usd: usage ? makeCostEngine({ priceOf: p.priceOf }).reconcile(usage, MODEL).usd : NaN };
    };

    const mixed = await callAnthropic(MIXED);
    A.eq(mixed.usage && mixed.usage.prompt_tokens_details && mixed.usage.prompt_tokens_details.cache_creation, { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
      'anthropic: the usage event carries the API\'s own cache_creation split (prompt-caching.md:208)');
    A.ok(near(mixed.usd, perBucket), 'anthropic: a mixed-TTL write prices per bucket — 400 at 1.25x + 600 at 2x = $' + perBucket.toFixed(6) + ' (got $' + mixed.usd + '; one rate booked $' + oneRate5m.toFixed(6) + ')');
    A.eq(pick(mixed.receipt, BUCKETS), [1000, 400, 600], 'anthropic: the call\'s usage receipt carries both buckets beside the aggregate write');

    const bare = await callAnthropic(Object.assign({}, MIXED, { cache_creation: undefined }));
    A.ok(near(bare.usd, oneRate5m), 'anthropic, no split reported, default switch: priced exactly as before ($' + oneRate5m.toFixed(6) + ', got $' + bare.usd + ')');
    A.eq(pick(bare.receipt, BUCKETS), [1000, '(absent)', '(absent)'], 'anthropic, no split reported: the receipt names no bucket (never invented)');

    const torn = await callAnthropic(Object.assign({}, MIXED, { cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 300 } }));
    A.ok(near(torn.usd, oneRate5m), 'anthropic, a split that does not add up to its own aggregate is not trusted: priced at the aggregate rate (got $' + torn.usd + ')');
    A.eq(pick(torn.receipt, BUCKETS), [1000, '(absent)', '(absent)'], 'anthropic, an inconsistent split: no buckets on the receipt');

    const allShort = await callAnthropic(Object.assign({}, MIXED, { cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } }));
    A.eq(allShort.usd, bare.usd, 'anthropic: an all-5-minute split books the very same dollars as today (float for float)');

    process.env.SKYNET_ANTHROPIC_CACHE_TTL = 'mixed';
    try {
      const mixedBare = await callAnthropic(Object.assign({}, MIXED, { cache_creation: undefined }));
      A.ok(near(mixedBare.usd, oneRate1h), 'mixed switch, no split reported: the aggregate prices at the dearest tier the request asked for (2x), never under ($' + oneRate1h.toFixed(6) + ', got $' + mixedBare.usd + ')');
      const mixedSplit = await callAnthropic(MIXED);
      A.ok(near(mixedSplit.usd, perBucket), 'mixed switch, split reported: per bucket, whatever the switch says (got $' + mixedSplit.usd + ')');
    } finally { delete process.env.SKYNET_ANTHROPIC_CACHE_TTL; }

    // Claude Code: its result line carries the same split (test/fixtures/claude-cli-2.1.284-natural.json)
    const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
    const shim = path.join(fakeRoot, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
    process.env.STARNET_CLAUDE_BIN = shim;
    process.env.STARNET_CLAUDE_CLI_PERSIST = '0';
    sink.clear();
    const cli = factory.selectProvider({ provider: 'claude-cli', clock: { now: () => Date.now() } });
    let cliError = null;
    try { await collect(cli, { model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { cliError = e; }
    A.ok(!cliError, 'claude-cli: the fake CLI call streams: ' + (cliError && cliError.message));
    A.eq(pick(sink.records()[0], BUCKETS), [500, 100, 400], 'claude-cli: the receipt carries the CLI\'s own split');
    const cliUsage = { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000, output_tokens: 157, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 } };
    const cliWant = ((10 + 9000 * 0.10 + 100 * 1.25 + 400 * 2.00) * 2 + 157 * 10) / 1e6;
    const cliGot = claudeCli._internals.estimateUsd(cliUsage, 'sonnet');
    A.ok(near(cliGot, cliWant), 'claude-cli: a stopped API-key turn is estimated per bucket ($' + cliWant.toFixed(6) + ', got $' + cliGot + ')');

    // OpenRouter reports one aggregate write (cache_write_tokens) and its billed cost: no split is invented
    sink.clear();
    const orUsage = { prompt_tokens: 2000, completion_tokens: 70, total_tokens: 2070, cost: 0.001, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 400 } };
    const or = factory.selectProvider({ provider: 'openrouter', key: 'k', fetch: fakeFetch(sse([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: orUsage }]) + 'data: [DONE]\n\n') });
    const orEvs = await collect(or, { model: 'anthropic/claude-sonnet-5.5', messages: [{ role: 'user', content: 'hi' }], preStreamRetries: 0 });
    A.eq(pick(sink.records()[0], BUCKETS), [400, '(absent)', '(absent)'], 'openrouter: one aggregate write, no bucket invented');
    A.eq(makeCostEngine({ priceOf: or.priceOf }).reconcile(lastUsage(orEvs), 'anthropic/claude-sonnet-5.5').usd, 0.001, 'openrouter: the billed cost stands');
  } finally {
    factory.attachUsageReceipts(null);
    delete process.env.STARNET_CLAUDE_BIN;
    delete process.env.STARNET_CLAUDE_CLI_PERSIST;
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }

  /* B. the kill switch reproduces the pre-lane bodies byte for byte */
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).bodies;
  const keys = Object.keys(golden);
  A.ok(keys.length >= 30, 'the golden holds every route x case (' + keys.length + ' bodies)');
  for (const [label, env] of [['default (switch unset)', {}], ['kill switch 5m', { SKYNET_ANTHROPIC_CACHE_TTL: '5m' }], ['an unknown value', { SKYNET_ANTHROPIC_CACHE_TTL: '30m' }]]) {
    const got = bodiesUnder(env);
    A.eq(Object.keys(got), keys, label + ': the same routes and cases');
    const changed = keys.filter(k => got[k] !== golden[k]);
    A.eq(changed, [], label + ': every Claude wire body is byte-identical to the pre-lane body');
  }

  /* C. '1h' on every Claude route; 'mixed' moves markers only, in the documented order */
  const oneHour = bodiesUnder({ SKYNET_ANTHROPIC_CACHE_TTL: '1h' });
  A.eq(keys.filter(k => oneHour[k] !== swapTo1h(golden[k])), [], '1h: every anchor of every Claude route (anthropic, openrouter, managed) on the 1-hour tier, nothing else changed');

  const mixed = bodiesUnder({ SKYNET_ANTHROPIC_CACHE_TTL: 'mixed' });
  for (const k of keys) {
    const route = k.split('/')[0];
    const body = JSON.parse(mixed[k]);
    const mk = markers(body);
    A.eq(strip(mixed[k], route !== 'anthropic'), strip(golden[k], route !== 'anthropic'), k + ': mixed changes cache markers only');
    if (route === 'openrouter-gpt' || /never-reread$/.test(k)) { A.eq(mk.length, 0, k + ': never stamped'); continue; }
    A.ok(mk.length <= 4, k + ': at most 4 markers (prompt-caching.md:127), got ' + mk.length);
    const firstShort = mk.findIndex(x => x.ttl !== '1h');
    A.ok(firstShort < 0 || mk.slice(firstShort).every(x => x.ttl !== '1h'), k + ': every 1-hour marker before every 5-minute marker (prompt-caching.md:172): ' + mk.map(x => x.at + ':' + x.ttl).join(' '));
    const stable = mk.filter(x => x.at === 'stable');
    A.eq(stable.map(x => [x.m, x.b]), markers(JSON.parse(golden[k])).filter(x => x.at === 'stable').map(x => [x.m, x.b]), k + ': the tool catalogue and system prompt anchors sit where they always did');
    A.ok(stable.every(x => x.ttl === '1h'), k + ': ...on the 1-hour tier');
    const spot = fixedSpot(JSON.parse(golden[k]), route === 'anthropic');
    const longMsgs = mk.filter(x => x.at === 'message' && x.ttl === '1h');
    A.eq(longMsgs.map(x => [x.m, x.b]), spot ? [[spot.m, spot.b]] : [], k + ': ' + (spot ? 'the end of history (the last block before the <run_context> note) anchors on the 1-hour tier' : 'no history before a note: no 1-hour message anchor'));
    const msgMarks = mk.filter(x => x.at === 'message');
    A.ok(msgMarks.length > 0 && msgMarks[msgMarks.length - 1].ttl === '5m' && msgMarks[msgMarks.length - 1].m === body.messages.length - 1, k + ': the newest message keeps a 5-minute anchor');
  }
  const mixedOff = bodiesUnder({ SKYNET_ANTHROPIC_CACHE_TTL: 'mixed', SKYNET_ANTHROPIC_CACHE: '0' });
  A.eq(keys.filter(k => k.startsWith('anthropic/') && markers(JSON.parse(mixedOff[k])).length), [], 'SKYNET_ANTHROPIC_CACHE=0 still drops every anthropic anchor under mixed');

  /* D. one resolver */
  const files = [];
  const walk = rel => {
    let ents = [];
    try { ents = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const r = rel + '/' + e.name;
      if (e.isDirectory()) walk(r); else if (/\.(c|m)?js$/.test(e.name)) files.push(r);
    }
  };
  for (const top of ['sidecar', 'bin', 'shared']) walk(top);
  const readers = [], literals = [];
  for (const rel of files) {
    const src = decomment(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (src.indexOf('SKYNET_ANTHROPIC_CACHE_TTL') >= 0) readers.push(rel);
    if (rel !== 'sidecar/providers/cache-ttl.js' && /cache_control['"]?\s*:\s*\{/.test(src)) literals.push(rel);
  }
  A.eq(readers, ['sidecar/providers/cache-ttl.js'], 'only the resolver reads SKYNET_ANTHROPIC_CACHE_TTL');
  A.eq(literals, [], 'no production file outside the resolver writes a cache_control object of its own');

  A.report('cache-ttl.invariant.test');
})().catch(e => { console.log('FAIL: cache-ttl.invariant.test threw - ' + ((e && e.stack) || e)); process.exit(1); });
