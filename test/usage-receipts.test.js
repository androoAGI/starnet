'use strict';
/* node test/usage-receipts.test.js — the usage receipts store itself (sidecar/usage-receipts.js, W1.1 cost audit 11-08).
   test/usage-receipts.invariant.test.js locks that every adapter streams through it; this locks what it keeps:
     1. one call, one receipt: done / stopped by its reader / thrown (an HTTP status, never error text); a stream that
        never produced an event never reached a provider (no receipt); wrapping twice never books twice
     2. the counts are cost.resolveUsage of the call's LAST usage event; none at all = usageMissing, never 0s
     3. the window reading rides only when it was seen during the call
     4. the file: one durable JSON line per call under .usage/, rolled to calls.jsonl.1 past maxBytes (bounded), read
        back oldest first, a torn line skipped; a write that fails is noted and the call goes on; no prompt or reply text
     5. windowShare: StarNet's own tokens per sign-in since each window opened — only that sign-in, only inside the
        window, never a percentage; receipts that begin after the window opened say so (since > from); none: since null
     6. minutesOf: a window's length as said, by id, or by label; unknown is null */
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeUsageReceipts, RECEIPTED, minutesOf } = require('../sidecar/usage-receipts.js');

const PROMPT = 'PROMPT-SECRET-words';
const REPLY = 'REPLY-SECRET-words';
const USAGE = { prompt_tokens: 1000, completion_tokens: 60, reasoning_tokens: 20, prompt_tokens_details: { cached_tokens: 700, cache_creation_tokens: 200 } };

function clockAt(t) { const c = { t, now: () => c.t }; return c; }
// a provider whose stream yields the given events (a function gets the clock to move time inside the call)
function fakeProvider(events) {
  return { id: 'fake', async *stream(req) { for (const ev of (typeof events === 'function' ? events(req) : events)) { if (ev instanceof Error) throw ev; yield ev; } } };
}
async function drain(p, req, stopAfter) {
  const seen = [];
  for await (const ev of p.stream(req)) { seen.push(ev); if (stopAfter && seen.length >= stopAfter) break; }
  return seen;
}
const REQ = { model: 'gpt-5.5', runId: 'run-1', messages: [{ role: 'user', content: PROMPT }] };

(async () => {
  /* 1 + 2 — memory mode (no file) */
  const clock = clockAt(1000);
  const r = makeUsageReceipts({ clock });
  const p = r.wrap(fakeProvider(() => { clock.t += 250; return [{ type: 'text', delta: REPLY }, { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 1 } }, { type: 'usage', usage: USAGE }, { type: 'done', stopReason: 'end' }]; }), { provider: 'codex', account: '' });
  A.ok(p[RECEIPTED] === true, 'wrap marks the adapter it hands back');
  A.ok(r.wrap(p, { provider: 'codex', account: '' }) === p, 'wrapping a wrapped adapter hands back the same one (never two receipts per call)');
  const seen = await drain(p, REQ);
  A.eq(seen.map(e => e.type), ['text', 'usage', 'usage', 'done'], 'the call streams exactly what the adapter said');
  const recs = r.records();
  A.eq(recs.length, 1, 'one call, one receipt');
  A.eq([recs[0].provider, recs[0].account, recs[0].model, recs[0].runId, recs[0].at, recs[0].ms, recs[0].end],
    ['codex', 'primary', 'gpt-5.5', 'run-1', 1250, 250, 'done'], '...who, which sign-in, which model, which run, when, how long, how it ended');
  A.eq([recs[0].uncachedIn, recs[0].cacheRead, recs[0].cacheWrite, recs[0].out, recs[0].reasoning], [100, 700, 200, 60, 20],
    '...the LAST usage event (cumulative), split uncached / cache read / cache write / out / reasoning');
  A.ok(!JSON.stringify(recs).includes('SECRET'), '...and not a word of the prompt or the reply');

  r.clear();
  await drain(r.wrap(fakeProvider([{ type: 'text', delta: 'a' }, { type: 'text', delta: 'b' }, { type: 'usage', usage: USAGE }, { type: 'done' }]), { provider: 'openrouter' }), REQ, 1);
  A.eq(r.records().map(x => [x.end, x.usageMissing]), [['stopped', true]], 'a reader that stops after the first event: one receipt, stopped, counts unknown (never 0s)');
  r.clear();
  const refusal = Object.assign(new Error('429 ' + PROMPT), { status: 429 });
  let threw = null;
  try { await drain(r.wrap(fakeProvider([refusal]), { provider: 'anthropic' }), REQ); } catch (e) { threw = e; }
  A.ok(threw === refusal, 'a refusal still reaches the caller unchanged');
  A.eq(r.records().map(x => [x.end, x.status, x.usageMissing, 'uncachedIn' in x]), [['error', 429, true, false]], '...booked as error with its HTTP status, no counts');
  A.ok(!JSON.stringify(r.records()).includes('SECRET'), '...and never the error text');
  r.clear();
  await drain(r.wrap(fakeProvider([]), { provider: 'openai' }), REQ);
  A.eq(r.records().length, 0, 'a stream that produced nothing and never threw never reached a provider: no receipt');
  r.clear();
  await drain(r.wrap(fakeProvider([{ type: 'usage', usage: USAGE }, { type: 'done' }]), { provider: 'openai' }), { model: 'm\u0000\nodel-' + 'x'.repeat(400) });
  A.eq([r.records()[0].model.length, /[\u0000- ]/.test(r.records()[0].model), 'runId' in r.records()[0]], [200, false, false], 'a model name is printable and bounded; no run id = no runId key');

  /* 3 — the window reading */
  r.clear();
  const wclock = clockAt(50000);
  const reading = { seenAt: 49000, windows: [{ id: 'five_hour', label: '5-hour', usedPct: 30, resetsAt: 90000000, status: 'allowed', minutes: 300 }] };
  const rr = makeUsageReceipts({ clock: wclock, readings: { get: (pid, acct) => (pid === 'claude-cli' && acct === 'primary' ? reading : null) } });
  const cli = rr.wrap(fakeProvider([{ type: 'usage', usage: USAGE }, { type: 'done' }]), { provider: 'claude-cli', account: 'primary' });
  await drain(cli, REQ);
  A.ok(!('window' in rr.records()[0]), 'a reading seen BEFORE the call began is not what this call saw: no window on the receipt');
  const live = rr.wrap(fakeProvider(() => { wclock.t += 100; reading.seenAt = wclock.t; reading.windows[0].usedPct = 31; return [{ type: 'usage', usage: USAGE }, { type: 'done' }]; }), { provider: 'claude-cli', account: '' });
  await drain(live, REQ);
  A.eq(rr.records()[1].window, { seenAt: 50100, windows: [{ id: 'five_hour', usedPct: 31, resetsAt: 90000000, minutes: 300, status: 'allowed' }] }, 'a reading said during the call rides on its receipt (the % as the provider said it)');
  const broken = makeUsageReceipts({ clock: wclock, readings: { get: () => { throw new Error('reader broke'); } }, note: () => {} });
  await drain(broken.wrap(fakeProvider([{ type: 'usage', usage: USAGE }, { type: 'done' }]), { provider: 'codex' }), REQ);
  A.eq(broken.records().length, 1, 'a readings store that throws never costs the receipt');

  /* 4 — the file */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-receipts-'));
  const file = path.join(dir, '.usage', 'calls.jsonl');
  const fclock = clockAt(1000);
  const notes = [];
  const fr = makeUsageReceipts({ file, clock: fclock, maxBytes: 1200, note: (k) => notes.push(k) });
  const one = () => fr.wrap(fakeProvider(() => { fclock.t += 10; return [{ type: 'text', delta: REPLY }, { type: 'usage', usage: USAGE }, { type: 'done' }]; }), { provider: 'codex', account: 'acct-9' });
  await drain(one(), REQ);
  A.ok(fs.existsSync(file), 'the first receipt creates WORKSPACES/.usage/calls.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  A.eq([lines.length, JSON.parse(lines[0]).account, JSON.parse(lines[0]).cacheWrite], [1, 'acct-9', 200], '...one JSON line per call, as written');
  for (let i = 0; i < 29; i++) await drain(one(), REQ);
  A.ok(fs.existsSync(file + '.1'), 'past maxBytes the file rolls to calls.jsonl.1');
  const sizes = [fs.statSync(file).size, fs.statSync(file + '.1').size];
  const row = lines[0].length + 1;
  A.ok(sizes[0] <= 1200 + row && sizes[1] <= 1200 + row, 'each segment stays within maxBytes plus the row that rolled it (disk bounded): ' + sizes.join(', '));
  const back = fr.records();
  A.ok(back.length >= 3 && back.length < 30, 'read back: what the two segments still hold (older rolls are gone): ' + back.length + ' of 30');
  A.ok(back.every((x, i) => i === 0 || x.at > back[i - 1].at), '...oldest first');
  A.eq(back[back.length - 1].at, fclock.t, '...ending with the newest call');
  fs.appendFileSync(file, '{"v":1,"at":99,"torn');
  await drain(one(), REQ);
  const afterTorn = fr.records();
  A.ok(afterTorn.every(x => x.at !== 99) && afterTorn[afterTorn.length - 1].at === fclock.t, 'a torn line is skipped and the next receipt still lands whole');
  A.ok(!/SECRET/.test(fs.readFileSync(file, 'utf8') + (fs.existsSync(file + '.1') ? fs.readFileSync(file + '.1', 'utf8') : '')), 'the files hold counts and ids, not a word of prompt or reply');
  A.eq(notes, [], 'nothing went wrong on the way');

  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file, not a directory');
  const failing = [];
  const bad = makeUsageReceipts({ file: path.join(blocker, 'calls.jsonl'), clock: fclock, note: (k) => failing.push(k) });
  const out = await drain(bad.wrap(fakeProvider([{ type: 'text', delta: 'x' }, { type: 'usage', usage: USAGE }, { type: 'done' }]), { provider: 'codex' }), REQ);
  A.eq([out.length, failing.length > 0], [3, true], 'a receipt that cannot be written is noted, and the call streams on untouched');

  /* 5 — windowShare */
  const H = 3600000;
  const T = 100 * 24 * H;   // "now"
  const sclock = clockAt(T);
  const share = makeUsageReceipts({ clock: sclock });
  const book = async (at, pid, acct, usage) => { sclock.t = at; await drain(share.wrap(fakeProvider([{ type: 'usage', usage }, { type: 'done' }]), { provider: pid, account: acct }), REQ); };
  const u = (inTok, cached, write, outTok) => ({ prompt_tokens: inTok, completion_tokens: outTok, reasoning_tokens: 5, prompt_tokens_details: { cached_tokens: cached, cache_creation_tokens: write } });
  await book(T - 4 * H, 'claude-cli', 'primary', u(1000, 900, 0, 10));     // before the 5-hour window opened
  await book(T - 2 * H, 'claude-cli', 'primary', u(2000, 1500, 300, 40));  // inside
  await book(T - 1 * H, 'claude-cli', 'primary', u(3000, 2000, 0, 60));    // inside
  await book(T - 1 * H, 'claude-cli', 'other', u(5000, 0, 0, 50));         // another sign-in
  await book(T - 1 * H, 'codex', 'primary', u(7000, 0, 0, 70));            // another provider
  sclock.t = T - 30 * 60000;
  await drain(share.wrap(fakeProvider([Object.assign(new Error('x'), { status: 500 })]), { provider: 'claude-cli', account: '' }), REQ).catch(() => {});   // no usage: never counted
  const subs = {
    'claude-cli': {
      primary: { seenAt: T, windows: [
        { id: 'five_hour', label: '5-hour', usedPct: 40, resetsAt: T + 2 * H, minutes: 300 },          // opened T-3h
        { id: 'seven_day', label: 'week', usedPct: 10, resetsAt: T + 24 * H, minutes: 10080 },         // opened 6 days ago
        { id: 'gone', label: '5-hour', usedPct: 99, resetsAt: T - 1, minutes: 300 },                    // reset since
        { id: 'mystery', label: 'mystery', usedPct: 5, resetsAt: T + H, minutes: null }] },            // length unknown
      fresh: { seenAt: T, windows: [{ id: 'five_hour', label: '5-hour', usedPct: 1, resetsAt: T + 4 * H, minutes: 300 }] } } };
  const s = share.windowShare(subs, T);
  const five = s['claude-cli'].primary.five_hour;
  A.eq([five.from, five.tokens, five.cacheRead, five.calls, five.since], [T - 3 * H, 2000 + 40 + 3000 + 60, 3500, 2, T - 3 * H],
    'the 5-hour window: only this sign-in\'s calls since it opened (uncached + cache read + cache write + out), cache re-reads apart');
  const week = s['claude-cli'].primary.seven_day;
  A.eq([week.from, week.tokens, week.calls, week.since], [T + 24 * H - 10080 * 60000, 1000 + 10 + 5100, 3, T - 4 * H],
    'the week opened before the first receipt: the tokens are a floor, and since says when the receipts began');
  A.eq(Object.keys(s['claude-cli'].primary).sort(), ['five_hour', 'seven_day'], 'a window that has reset since, or whose length is unknown, has no share (no start to count from)');
  A.eq([s['claude-cli'].fresh.five_hour.tokens, s['claude-cli'].fresh.five_hour.calls, s['claude-cli'].fresh.five_hour.since], [0, 0, T - H], 'a sign-in with no calls while receipts were kept: a true zero, counted from the window\'s opening');
  A.ok(!/pct|percent/i.test(JSON.stringify(s)), 'never a percentage: the window\'s % is the provider\'s word for every client on that sign-in');
  A.eq(makeUsageReceipts({ clock: sclock }).windowShare(subs, T)['claude-cli'].primary.five_hour.since, null, 'no receipt at all: since is null (the reader says none recorded yet, not 0)');
  A.eq(share.windowShare(null, T), {}, 'no subscriptions: no share');

  const fileShare = makeUsageReceipts({ file: path.join(dir, 'share', 'calls.jsonl'), clock: sclock });
  sclock.t = T - H;
  await drain(fileShare.wrap(fakeProvider([{ type: 'usage', usage: u(100, 50, 10, 5) }, { type: 'done' }]), { provider: 'codex', account: '' }), REQ);
  A.eq(fileShare.windowShare({ codex: { primary: { windows: [{ id: 'primary', label: '5-hour', resetsAt: T + H, minutes: 300 }] } } }, T).codex.primary.primary.tokens, 105, 'the share reads the receipts file back (the route\'s path)');

  /* 6 — minutesOf */
  A.eq([minutesOf({ minutes: 45 }), minutesOf({ id: 'seven_day_opus' }), minutesOf({ label: '5-hour' }), minutesOf({ label: 'week' }), minutesOf({ label: '3-day' }), minutesOf({ label: '2-hour' }),
    minutesOf({ id: 'secondary', label: '0-minute', minutes: 0 }), minutesOf({ label: 'primary' }), minutesOf(null)],
    [45, 10080, 300, 10080, 4320, 120, null, null, null], 'a window\'s length: as said, by id, by label; a 0-minute or unnamed one is unknown');

  fs.rmSync(dir, { recursive: true, force: true });
  A.report('usage-receipts.test');
})().catch(e => { console.error(e); process.exit(1); });
