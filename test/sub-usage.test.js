'use strict';
/* node test/sub-usage.test.js — how much of each subscription sign-in is used, as the provider itself said it
   (sidecar/sub-usage.js, its Claude Code + ChatGPT seams, GET /api/usage/providers). Locks:
     1. Claude Code's rate_limit_event (the 10-27 live shape: unifiedWindows five_hour / seven_day, utilization 0–1) is
        kept per sign-in as "% used + reset"; an older CLI's single binding window is kept with NO number made up
     2. ChatGPT's x-codex-* headers: each window's % used, its length named, its reset; the credits; a header that is
        absent is unknown, never 0; every window carries its length in minutes (Claude's by id, ChatGPT's as said);
        the zero-valued phantom secondary slot is no window, live or loaded from an older file
     3. reading the headers changes nothing about the response; nothing at all said = no entry
     4. it survives a restart (the resilient JSON file), and nothing in that file is a credential
     5. the seams: the Claude Code provider hands each run's rate_limit_event to onRateLimit (and a reader that throws
        never breaks the run); the factory taps a ChatGPT adapter's fetch for the sign-in it was built for */
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { makeSubUsage } = require('../sidecar/sub-usage.js');

const LIVE = { status: 'allowed', resetsAt: 1793082000, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1793082000, status: 'allowed' }, seven_day: { utilization: 0.07, resetsAt: 1793631600, status: 'allowed' } } };
const hdr = o => { const m = new Map(Object.entries(o)); return { get: k => (m.has(k) ? m.get(k) : null) }; };
const CODEX = { 'x-codex-primary-used-percent': '1.0', 'x-codex-primary-window-minutes': '10080', 'x-codex-primary-reset-at': '1793601034',
  'x-codex-secondary-used-percent': '34', 'x-codex-secondary-window-minutes': '300', 'x-codex-secondary-reset-at': '1793090000',
  'x-codex-credits-has-credits': 'true', 'x-codex-credits-unlimited': 'false', 'x-codex-credits-balance': '7586.126' };

(async () => {
  /* 1 */
  const u = makeSubUsage({ clock: { now: () => 5000 } });
  u.observeClaude('', LIVE);
  A.eq(u.get('claude-cli', 'primary').windows, [
    { id: 'five_hour', label: '5-hour', usedPct: 12, resetsAt: 1793082000000, status: 'allowed', minutes: 300 },
    { id: 'seven_day', label: 'week', usedPct: 7, resetsAt: 1793631600000, status: 'allowed', minutes: 10080 }], 'Claude Code: each window\'s % used, reset and length, on account 1');
  A.eq([u.get('claude-cli', 'primary').seenAt, u.get('claude-cli', 'primary').overage.status], [5000, 'rejected'], '...when it was said, and the overage state as said');
  u.observeClaude('abc123ef', { status: 'allowed', resetsAt: 1793082000, rateLimitType: 'five_hour' });
  A.eq(u.get('claude-cli', 'abc123ef').windows, [{ id: 'five_hour', label: '5-hour', usedPct: null, resetsAt: 1793082000000, status: 'allowed', minutes: 300 }], 'an older CLI (one window, no utilization): kept, with no number made up');
  u.observeClaude('abc123ef', { status: 'allowed', resetsAt: 1793082000, rateLimitType: 'mystery_window' });
  A.eq(u.get('claude-cli', 'abc123ef').windows[0].minutes, null, 'a window id with no known length: its length is unknown (null), never guessed');
  A.eq(u.get('claude-cli', 'primary').windows.length, 2, '...and each sign-in keeps its own');
  u.observeClaude('', {});
  u.observeClaude('', null);
  A.eq(u.get('claude-cli', 'primary').windows[0].usedPct, 12, 'a line that says nothing changes nothing');

  /* 2 */
  u.observeHeaders('codex', '', hdr(CODEX));
  const cx = u.get('codex', 'primary');
  A.eq(cx.windows.map(w => [w.label, w.usedPct, w.resetsAt]), [['week', 1, 1793601034000], ['5-hour', 34, 1793090000000]], 'ChatGPT: each window named by its length, % used, reset');
  A.eq(cx.credits, { has: true, unlimited: false, balance: 7586.126 }, '...and the credits as said');
  u.observeHeaders('codex', 'acct2', hdr({ 'x-codex-primary-used-percent': '50', 'x-codex-primary-window-minutes': '300' }));
  A.eq([u.get('codex', 'acct2').windows.length, u.get('codex', 'acct2').windows[0].resetsAt, u.get('codex', 'acct2').credits], [1, null, undefined], 'an absent header is unknown — no secondary window, no reset, no credits made up');
  A.eq(cx.windows.map(w => w.minutes), [10080, 300], '...and each window carries the length ChatGPT said (where it opened = reset minus length)');

  /* 2b — THE PHANTOM WINDOW (cost audit 11-08): a one-window ChatGPT account still gets zero-valued secondary headers
     (0% used, 0-minute length, reset 0 s away). Codex's own client reads that as no window; so does this store. */
  u.observeHeaders('codex', 'onewin', hdr({ 'x-codex-primary-used-percent': '3', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-after-seconds': '600',
    'x-codex-secondary-used-percent': '0', 'x-codex-secondary-window-minutes': '0', 'x-codex-secondary-reset-after-seconds': '0' }));
  A.eq(u.get('codex', 'onewin').windows.map(w => [w.id, w.label, w.usedPct, w.minutes, w.resetsAt]), [['primary', '5-hour', 3, 300, 5000 + 600000]], 'the zero-valued secondary slot is no window: no "0-minute" window that resets the moment it is seen');
  u.observeHeaders('codex', 'fresh', hdr({ 'x-codex-primary-used-percent': '0', 'x-codex-primary-window-minutes': '10080', 'x-codex-primary-reset-after-seconds': '604800' }));
  A.eq(u.get('codex', 'fresh').windows.map(w => [w.label, w.usedPct, w.minutes]), [['week', 0, 10080]], 'a real window at 0% used (a length, a reset ahead) is still a window: only the all-zero slot is dropped');
  u.observeHeaders('codex', 'nothing', hdr({ 'x-codex-primary-used-percent': '0', 'x-codex-primary-window-minutes': '0', 'x-codex-primary-reset-after-seconds': '0' }));
  A.eq(u.get('codex', 'nothing'), null, 'a response whose only slot is the phantom: no entry at all (the reader says unknown)');

  /* 3 */
  const body = { ok: true };
  const res = { ok: true, status: 200, headers: hdr(CODEX), body };
  const wrapped = u.wrapFetch('codex', 'acct3', async () => res);
  A.ok((await wrapped('https://chatgpt.com/backend-api/codex/responses')) === res, 'reading the headers hands back the very same response');
  A.ok(!!u.get('codex', 'acct3'), '...and records them for that sign-in');
  const quiet = makeSubUsage({});
  await quiet.wrapFetch('openrouter', '', async () => ({ ok: true, headers: hdr({ 'x-ratelimit-remaining': '5' }) }))();
  A.eq(quiet.snapshot(), {}, 'a provider that does not say its windows has no entry (the reader says unknown)');
  const bad = quiet.wrapFetch('codex', '', async () => ({ ok: true, get headers() { throw new Error('boom'); } }));
  A.ok(!!(await bad()), 'headers that throw never fail the call');

  /* 4 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-usage-'));
  const file = path.join(dir, '.usage', 'subscriptions.json');
  const p1 = makeSubUsage({ file, saveMs: 10 });
  p1.observeClaude('', LIVE);
  p1.observeHeaders('codex', '', hdr(CODEX));
  p1.flush();
  const p2 = makeSubUsage({ file });
  A.eq(p2.snapshot(), p1.snapshot(), 'after a restart it still says what the providers last said');
  A.ok(!/token|bearer|sk-|refresh|access/i.test(fs.readFileSync(file, 'utf8')), 'the file holds numbers and times, no credential');
  const p3 = makeSubUsage({ file, saveMs: 20 });
  p3.observeHeaders('codex', 'later', hdr(CODEX));
  await new Promise(r => setTimeout(r, 80));
  A.ok(!!makeSubUsage({ file }).get('codex', 'later'), 'a new observation is written on its own within moments (no shutdown needed)');
  // a file saved before the phantom rule: its "0-minute" window goes on load; an entry that held only that goes too
  const old = path.join(dir, '.usage', 'old.json');
  fs.writeFileSync(old, JSON.stringify({ v: 1, providers: { codex: {
    primary: { seenAt: 4000, windows: [{ id: 'primary', label: 'week', usedPct: 9, resetsAt: 1793601034000, status: '' }, { id: 'secondary', label: '0-minute', usedPct: 0, resetsAt: 4000, status: '' }] },
    ghost: { seenAt: 4000, windows: [{ id: 'secondary', label: '0-minute', usedPct: 0, resetsAt: 4000, status: '' }] } } } }));
  const loaded = makeSubUsage({ file: old });
  A.eq(loaded.get('codex', 'primary').windows.map(w => w.label), ['week'], 'a saved 0-minute window is dropped on load; the real window beside it stays');
  A.eq(loaded.get('codex', 'ghost'), null, '...and a saved entry that held only the phantom is no entry');
  fs.rmSync(dir, { recursive: true, force: true });

  /* 5 */
  const { makeClaudeCliProvider } = require('../sidecar/providers/claude-cli.js');
  function fakeSpawn(lines) {
    return function spawn(file, args) {
      const child = new EventEmitter();
      const stream = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
      child.stdout = stream(); child.stderr = stream(); child.pid = 4243; child.exitCode = null;
      const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
      const run = () => { for (const l of lines) child.stdout.emit('data', JSON.stringify(l) + '\n'); exit(0); };
      child.stdin = { on() {}, end() { setImmediate(run); } };
      child.kill = () => exit(null);
      if (args.indexOf('auth') >= 0) setImmediate(run);
      return child;
    };
  }
  const run = [{ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] }, { type: 'rate_limit_event', rate_limit_info: LIVE },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }];
  const fakeFs = { statSync() { return { isFile: () => true }; }, writeFileSync() {}, unlinkSync() {} };
  const seen = [];
  const cp = makeClaudeCliProvider({ spawn: fakeSpawn(run), fs: fakeFs, bin: 'claude.exe', env: { PATH: '', STARNET_CLAUDE_CLI_PERSIST: '0' }, platform: 'linux', onRateLimit: i => seen.push(i) });
  const out = []; for await (const e of cp.stream({ model: 'sonnet', messages: [{ role: 'user', content: 'x' }] })) out.push(e);
  A.ok(seen.length === 1 && seen[0].unifiedWindows.five_hour.utilization === 0.12, 'the Claude Code provider hands the run\'s rate_limit_event to onRateLimit');
  A.ok(out.some(e => e.type === 'text' && e.delta === 'ok'), '...and the run streams as usual');
  const cp2 = makeClaudeCliProvider({ spawn: fakeSpawn(run), fs: fakeFs, bin: 'claude.exe', env: { PATH: '', STARNET_CLAUDE_CLI_PERSIST: '0' }, platform: 'linux', onRateLimit: () => { throw new Error('reader broke'); } });
  const out2 = []; for await (const e of cp2.stream({ model: 'sonnet', messages: [{ role: 'user', content: 'x' }] })) out2.push(e);
  A.ok(out2.some(e => e.type === 'text' && e.delta === 'ok'), 'a reader that throws never breaks the run');

  const factory = require('../sidecar/providers/factory.js');
  const fu = makeSubUsage({});
  factory.attachSubUsage(fu);
  const calls = [];
  const fakeFetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, headers: hdr(CODEX), json: async () => ({ models: [] }), text: async () => '{"models":[]}' }; };
  const prov = factory.selectProvider({ provider: 'codex', fetch: fakeFetch, token: 'not-a-real-token', usageAccount: 'deadbeef01' });
  try { await prov.listModels(); } catch (_) { /* the shape of the list does not matter here: the call went out */ }
  A.ok(calls.length >= 1 && !!fu.get('codex', 'deadbeef01'), 'the factory taps a ChatGPT adapter\'s fetch, for the sign-in it was built for: ' + JSON.stringify(Object.keys(fu.snapshot().codex || {})));
  factory.attachSubUsage(null);

  A.report('sub-usage.test');
})().catch(e => { console.error(e); process.exit(1); });
