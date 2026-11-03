/* node test/diagnostics.test.js — the paste-ready bug-report assembler (sidecar/diagnostics.js, T3.9).

   THE HARD REQUIREMENT this test exists to enforce: no secret ever survives into the diagnostics block. We feed
   fake API keys, channel/OAuth tokens, a JWT, and prompt-shaped junk through EVERY free-text field and assert none
   of it appears in either the structured report OR the plain-text block. It uses the REAL production redact()
   (sidecar/context.js) so the test tracks the actual scrubber, not a stub. Also checks the truthful-telemetry
   contract: missing fields render as 'unknown'/omitted, never invented; and structured booleans stay shape-only. */
'use strict';
const A = require('./_assert.js');
const { makeDiagnostics } = require('../sidecar/diagnostics.js');
const { redact } = require('../sidecar/context.js');   // the real always-on secret scrubber

const diag = makeDiagnostics({ redact });
const liveOnly = diag.assemble({ runTable: { live: 3, legacy: 99, missing: ['obsolete-id'] } });
A.eq(liveOnly.report.runTable, { live: 3 }, 'diagnostics reports the one live-run authority without retired shadow counts');
A.ok(/^Live runs: {5}3 in the run table$/m.test(liveOnly.text), 'paste-ready diagnostics names the actual admitted count');
A.ok(!JSON.stringify(liveOnly).includes('obsolete-id') && !liveOnly.text.includes('older registries'), 'retired comparison facts never reappear as misleading telemetry');


const paid = diag.assemble({ version: { buildSha: 'a'.repeat(40), buildDirty: false }, paidAccount: {
  configured: true, fingerprint: '0123456789abcdef', link: 'saved', credential: 'file', auth: 'valid',
  balanceUsd: 22, observedAt: 1720000000000, capturedAt: 1720000000100, balance: 'funded',
  accountId: 'PRIVATE ACCOUNT', deviceToken: 'PRIVATE DEVICE TOKEN',
  transition: { state: 'pairing_saved', at: 1720000000000 }
} });
A.ok(paid.text.includes('funded · $22.00'), 'paid receipt includes the measured balance');
A.ok(paid.text.includes('0123456789abcdef'), 'support sees only a bounded account fingerprint');
A.ok(!JSON.stringify(paid).includes('PRIVATE'), 'account identity and credential never enter the report');
const unknownPaid = diag.assemble({ paidAccount: { balanceUsd: '0', credential: 'PRIVATE TOKEN', balance: 'PRIVATE PROMPT' } });
A.eq(unknownPaid.report.paidAccount.balanceUsd, null, 'a malformed balance is never fabricated zero');
A.eq(unknownPaid.report.paidAccount.balance, 'unknown', 'unknown balance classifications stay unknown');
A.ok(!JSON.stringify(unknownPaid).includes('PRIVATE'), 'enum fields cannot smuggle secrets or prompt text');

// ---- a battery of real-shaped secrets that must NEVER appear anywhere in the output ----
const SECRETS = [
  'sk-or-v1-abcdef0123456789abcdef0123456789',            // OpenRouter key
  'sk-ant-abcdef0123456789abcdef',                        // Anthropic key
  'sk-proj-abcdef0123456789abcdef0123456789',             // OpenAI project key
  '123456789:AAF-abcdefghijklmnopqrstuvwxyz0123456',      // Telegram bot token
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',           // GitHub token
  'xoxb-1234567890-abcdefghijklmnop',                     // Slack token
  'eyJhbGciOiJIUzI1Ni019.eyJzdWIiOiIxMjM0NTY3ODk019.abcDEFghiJKL',  // JWT
  'ya29.abcdefghijklmnopqrstuvwxyz0123456789'             // Google OAuth access token
];

// build a snapshot that stuffs every secret into the error tail (the one free-text channel) + into model/provider
// (which must be treated as slugs, but we prove even a poisoned one is scrubbed by the second backstop).
const poisoned = diag.assemble({
  version: { harness: '0.1.7', app: '0.1.7', node: 'v20.0.0' },
  platform: { os: 'win32', arch: 'x64', node: 'v20.0.0' },
  mode: 'desktop',
  provider: 'openrouter ' + SECRETS[0],       // a hostile value smuggled into a "slug" field
  model: 'anthropic/claude-sonnet-4.6 ' + SECRETS[1],
  keyPresent: true,
  agentCount: 3,
  uptimeMs: 8100000,                           // 2h 15m
  workspacePresent: true,
  lastRun: { runId: 'run-abc123', status: 'error', ts: 1720000000000 },
  errors: SECRETS.map((s, i) => ({ ts: 1720000000000 + i, message: 'run failed: Authorization: Bearer ' + s + ' -----BEGIN PRIVATE KEY-----' + s + '-----END PRIVATE KEY-----' }))
});

const blob = JSON.stringify(poisoned) + '\n' + poisoned.text;   // scan BOTH the structured report and the text block
for (const s of SECRETS) {
  A.ok(blob.indexOf(s) < 0, 'secret is fully scrubbed everywhere: ' + s.slice(0, 12) + '…');
}
A.ok(blob.indexOf('BEGIN PRIVATE KEY') < 0, 'private-key block never survives into diagnostics');
// a redaction marker SHOULD be present (proves the field wasn't just dropped silently — the error was recorded)
A.ok(/redacted/.test(poisoned.text), 'scrubbed errors leave a visible [redacted-…] marker, not a silent drop');

// ---- truthful telemetry: honest fields pass through; missing fields are omitted/unknown, never invented ----
A.ok(poisoned.text.indexOf('App version:   0.1.7') >= 0, 'app version is surfaced verbatim');
A.ok(poisoned.text.indexOf('Mode:          desktop') >= 0, 'desktop-vs-browser mode is surfaced');
A.ok(poisoned.text.indexOf('Credential:    configured') >= 0, 'key PRESENCE is surfaced as a boolean, not the key');
A.ok(poisoned.text.indexOf('Workspace dir: present') >= 0, 'workspace presence is a boolean');
A.ok(poisoned.text.indexOf('run-abc123 — error') >= 0, 'last run id + status are surfaced');
A.ok(poisoned.text.indexOf('2h 15m') >= 0, 'uptime renders as a human duration');
A.eq(poisoned.report.keyPresent, true, 'keyPresent stays a strict boolean');
A.eq(poisoned.report.workspacePresent, true, 'workspacePresent stays a strict boolean');

// an EMPTY snapshot never fabricates values — everything degrades to unknown/none, and nothing throws.
const empty = diag.assemble({});
A.ok(empty.text.indexOf('App version:   unknown') >= 0, 'missing version -> unknown, not invented');
A.ok(empty.text.indexOf('Mode:          unknown') >= 0, 'missing mode -> unknown');
A.ok(empty.text.indexOf('Provider:      unknown') >= 0, 'missing provider -> unknown');
A.ok(empty.text.indexOf('Last run:      none yet') >= 0, 'no run yet is stated honestly');
A.ok(empty.text.indexOf('(none recorded)') >= 0, 'no errors is stated honestly (tail persists across restarts)');
A.eq(empty.report.keyPresent, false, 'absent credential -> false, never a guessed true');
A.eq(empty.report.workspacePresent, false, 'absent workspace flag -> false');

// a completely garbage input must not throw (the endpoint wraps this, but the assembler is defensive too).
A.notThrows(() => diag.assemble(null), 'null snapshot does not throw');
A.notThrows(() => diag.assemble({ errors: 'not-an-array', lastRun: 42, uptimeMs: 'x' }), 'malformed fields do not throw');

// the block advertises its own safety (a small honesty cue for the user pasting it).
A.ok(/no keys, tokens, or message content/.test(poisoned.text), 'block states it contains no secrets');

// ---- SWALLOWED ERRORS (2026-08-21): fail-open pressure is a VISIBLE number, and the section FIRES ----
// reject into a tagged swallow, then assert the assembler reports it (the close-zombie law: a seam that swallows
// 100% of the time for weeks must show up in the bug report as a count, not vanish behind console.warn).
(async () => {
  const failopen = require('../sidecar/failopen.js');
  failopen.resetForTests(); failopen.setClock(Date.now);
  A.ok(diag.assemble({ swallowed: failopen.summary() }).text.indexOf('(none since boot)') >= 0
    && diag.assemble({ swallowed: failopen.summary() }).report.swallowed.present === true, 'a readable EMPTY tally renders "(none since boot)"');
  A.ok(diag.assemble({}).text.indexOf('Swallowed errors') >= 0 && diag.assemble({}).text.indexOf('(unknown — tally not readable)') >= 0,
    'a MISSING tally says unknown — never a reassuring zero');
  A.eq(diag.assemble({}).report.swallowed.present, false, 'report.swallowed.present is false when the tally was not passed');

  await Promise.reject(new Error('aux pass died ' + SECRETS[0])).catch(failopen.swallow('aux.test.envelope'));
  await Promise.reject(new Error('again')).catch(failopen.swallow('aux.test.envelope'));
  await Promise.reject(new Error('once')).catch(failopen.swallow('maint.test.loop'));
  const fired = diag.assemble({ swallowed: failopen.summary() });
  const row = fired.report.swallowed.tags.find(t => t.tag === 'aux.test.envelope');
  A.ok(!!row && row.count === 2, 'the rejected-into tag is reported with its exact count (the envelope provably fired)');
  A.ok(row && Number.isFinite(row.firstAt) && Number.isFinite(row.lastAt) && row.lastAt >= row.firstAt, 'first/last-seen timestamps ride along');
  A.eq(fired.report.swallowed.total, 3, 'total sums every tag');
  A.eq(fired.report.swallowed.tags[0].tag, 'aux.test.envelope', 'loudest seam leads');
  A.ok(/aux\.test\.envelope ×2/.test(fired.text), 'the paste-ready block lists the tag with its count');
  A.ok(/total 3 across 2 tags/.test(fired.text), 'the block states total + tag count');
  A.ok(JSON.stringify(fired).indexOf(SECRETS[0]) < 0, 'error MESSAGES never ride into the swallowed section (counts only)');
  // snapshot semantics: mutating what the endpoint saw cannot blind the trace
  const snap = failopen.summary(); snap.tags.length = 0; snap.total = 0;
  A.eq(failopen.summary().total, 3, 'summary() is a fresh snapshot — mutating it does not clear the real tally');
  // bounded: a tag explosion is capped and flagged, never an unbounded report
  for (let i = 0; i < 40; i++) failopen.swallow('flood.' + i)(new Error('x'));
  const flooded = diag.assemble({ swallowed: failopen.summary() });
  A.ok(flooded.report.swallowed.tags.length <= 24 && flooded.report.swallowed.truncated === true, 'tag rows are bounded and truncation is stated');
  A.ok(flooded.text.indexOf('more tags not shown') >= 0, 'the block says when rows were cut');
  failopen.resetForTests();

  A.report('diagnostics');
})();
