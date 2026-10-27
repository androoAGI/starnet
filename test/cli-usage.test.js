'use strict';
/* node test/cli-usage.test.js — the terminal's /usage (bin/lib/usage.js). Locks what each connected provider says:
     1. a subscription's sign-ins one per line: what is LEFT of each window and when it resets, and when that was said; a
        sign-in no run has used: unknown; one the station is cooling: until when; one signed out: signed out
     2. a window whose reset has passed says so (the number it had is stale); a window with no number says its status
     3. Grok / Kimi: signed in, and that they do not say how much is left — no meter made up
     4. an API key: its rate buckets from the last response, else unknown (and that they are rate limits, not a balance);
        StarNet credits: the balance; Ollama: no limit; nothing connected: where to connect one
     5. the ledger's spend last */
const A = require('./_assert.js');
const connect = require('../bin/lib/connect.js');
const { usageLines, windowText } = require('../bin/lib/usage.js');

const NOW = new Date(2026, 9, 27, 13, 0, 0).getTime();
const at = (h, m, dayAdd) => new Date(2026, 9, 27 + (dayAdd || 0), h, m || 0, 0).getTime();
const facts = {
  configured: new Set(['codex', 'grok', 'openrouter', 'groq']),
  credits: { state: 'linked', balanceUsd: 12.4 },
  claude: { installed: true, loggedIn: true },
  ollama: true
};
const usage = {
  subscriptions: {
    'claude-cli': { primary: { windows: [{ id: 'five_hour', label: '5-hour', usedPct: 12, resetsAt: at(16), status: 'allowed' }, { id: 'seven_day', label: 'week', usedPct: 7, resetsAt: at(9, 0, 3), status: 'allowed' }], seenAt: NOW - 12 * 60000 } },
    codex: { primary: { windows: [{ id: 'primary', label: 'week', usedPct: 1, resetsAt: at(9, 10, 1), status: '' }], credits: { has: true, unlimited: false, balance: 7586.1 }, seenAt: NOW - 2 * 60000 } }
  },
  rate: [{ provider: 'openrouter', ageMs: 3 * 60000, buckets: { requests: { limit: 200, remaining: 199 }, tokens: { limit: null, remaining: null } } }]
};
const accounts = {
  'claude-cli': [{ account: '', label: 'account 1', loggedIn: true, coolingUntil: 0 }, { account: 'aa11bb22', label: 'account 2', loggedIn: true, coolingUntil: at(18, 10) }, { account: 'cc33dd44', label: 'account 3', loggedIn: true, coolingUntil: 0 }, { account: 'ee55ff66', label: 'account 4', loggedIn: false }],
  codex: [{ account: '', label: 'account 1', connected: true, coolingUntil: 0 }],
  grok: [{ account: '', label: 'account 1', connected: true, coolingUntil: 0 }]
};
const L = usageLines({ facts, usage, accounts, budget: { spentToday: 0.42, lifetime: 31.1 }, now: NOW });
const line = re => L.find(l => re.test(l)) || '';
const idx = re => L.findIndex(l => re.test(l));

/* 1 */
A.ok(/^CLAUDE CODE.* · 3 sign-ins$/.test(line(/^CLAUDE/)), 'a subscription: its name and how many sign-ins are live: ' + line(/^CLAUDE/));
A.eq(line(/account 1 {2}5-hour/), '  account 1  5-hour 88% left · resets 4:00 PM   week 93% left · resets Fri 9:00 AM   (as of 12 min ago)', 'each window: what is left and when it resets, and when that was said');
A.ok(/account 2 {2}hit its limit — the next sign-in takes the runs until 6:10 PM/.test(L[idx(/account 1 {2}5-hour/) + 1]), 'a sign-in the station cools: until when');
A.ok(/account 3 {2}unknown — no run on it yet/.test(L[idx(/account 1 {2}5-hour/) + 2]), 'a sign-in no run has used: unknown');
A.ok(/account 4 {2}signed out/.test(L[idx(/account 1 {2}5-hour/) + 3]), 'one signed out says so');
A.ok(/^ {2}account 1 {2}week 99% left · resets tomorrow 9:10 AM {3}credits 7586 {3}\(as of 2 min ago\)$/.test(line(/credits 7586/)), 'ChatGPT: its window and its credits: ' + line(/credits/));

/* 2 */
A.eq(windowText({ label: '5-hour', usedPct: 40, resetsAt: NOW - 1000 }, NOW), '5-hour reset since', 'a window whose reset has passed: its old number is not shown');
A.eq(windowText({ label: '5-hour', usedPct: null, resetsAt: at(16), status: 'allowed' }, NOW), '5-hour allowed · resets 4:00 PM', 'a window with no number says its status, no number made up');
A.eq(windowText({ label: 'week', usedPct: 100, resetsAt: at(16), status: 'rejected' }, NOW), 'week spent · resets 4:00 PM', 'a spent window says spent');

/* 3 */
A.ok(/^GROK.* · 1 sign-in — Grok does not say how much is left$/.test(line(/^GROK/)) && !/account 1/.test(L[idx(/^GROK/) + 1] || ''), 'Grok: signed in, and that it does not say — no meter line');

/* 4 */
A.ok(/^OPENROUTER · key saved — requests 199 of 200 left this window \(as of 3 min ago\)$/.test(line(/^OPENROUTER/)), 'an API key: its rate bucket from the last response: ' + line(/^OPENROUTER/));
A.ok(/^GROQ · key saved — unknown until a call says \(its rate limits, not a balance\)$/.test(line(/^GROQ/)), 'a key no call has used: unknown');
A.eq(line(/^STARNET/), 'STARNET MANAGED · $12.40 left', 'StarNet credits: the balance');
A.ok(/^OLLAMA.* · runs on this computer — no limit$/.test(line(/^OLLAMA/)), 'Ollama: no limit');
A.ok(!L.some(l => /^ANTHROPIC|^GEMINI|^KIMI/.test(l)), 'a provider not connected is not listed');
A.eq(usageLines({ facts: { configured: new Set(), credits: { state: 'absent' }, claude: { installed: false }, ollama: false }, usage, accounts: {}, now: NOW }), ['No provider is connected yet — /connect adds one.'], 'nothing connected: where to connect one');

/* 5 */
A.eq(L[L.length - 1], 'Spent today $0.42 · all time $31.10 — the station ledger (subscriptions not in dollars)', 'the ledger\'s spend last');
A.ok(connect.ordered().map(p => p.name).filter(n => L.some(l => l.indexOf(n) === 0)).length === 7, 'the providers in the app\'s order: ' + L.filter(l => !/^ /.test(l)).map(l => l.split(' · ')[0]).join(', '));

A.report('cli-usage.test');
