'use strict';
/* INSPECT FULL REQUEST (customer report, 0.13.1): a consent card's argsSummary clips a long command or path at 80
   characters, so the Commander could not see what they approved. The sidecar now keeps the WHOLE redacted request on the
   pending prompt (GET /api/consent/args) and every card without its own payload view offers a disclosure that reads it.
   The live route round-trip is proven in test/consent-full-args.e2e.test.js; this file pins the pure pieces. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const backend = fs.readFileSync(require.resolve('../sidecar/index.js'), 'utf8');
const chat = fs.readFileSync(require.resolve('../frontend/app/chat.js'), 'utf8');
const group = fs.readFileSync(require.resolve('../frontend/app/group-chat.js'), 'utf8');
const groupSessions = fs.readFileSync(require.resolve('../sidecar/group-sessions.js'), 'utf8');
function extract(src, start, end) { const i = src.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return src.slice(i, src.indexOf(end, i)); }

const SECRET = 'sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXX';
const COMMAND = 'curl -sS -X POST https://api.example.test/v1/deploy/production/services/web-frontend -H "Authorization: Bearer ' + SECRET + '" -d @release-manifest.json';

function backendCtx() {
  const ctx = { redact: require('../sidecar/context.js').redact };
  vm.createContext(ctx); vm.runInContext(extract(backend, 'function consentSummary(call)', 'function throttleSearch'), ctx);
  return ctx;
}

test('the full request keeps every character of a long command, redacted the same way as the short summary', () => {
  const ctx = backendCtx();
  const call = { name: 'shell.exec', args: { command: COMMAND, cwd: '.' } };
  const short = ctx.consentSummary(call);
  // argsSummary is the WHOLE redacted request since the consent-full-args lane merged (its card shows one INSPECT panel)
  assert.ok(!short.includes(SECRET) && short.includes('-d @release-manifest.json'), 'the summary carries the whole request, redacted: ' + short);
  const full = ctx.consentArgsFull(call);
  assert.equal(full.truncated, false);
  assert.ok(!full.text.includes(SECRET) && /redacted/i.test(full.text), 'the secret never rides the full request: ' + full.text);
  assert.ok(full.text.includes('https://api.example.test/v1/deploy/production/services/web-frontend') && full.text.includes('-d @release-manifest.json'), 'every other character survives');
  assert.ok(full.text.length > 80);
});

test('a huge request is capped honestly, saying how much was not shown', () => {
  const ctx = backendCtx();
  const full = ctx.consentArgsFull({ name: 'shell.exec', args: { command: 'echo ' + 'y'.repeat(40000) } });
  assert.equal(full.truncated, true);
  assert.match(full.text, /… \d+ more characters not shown$/);
  assert.ok(full.text.length < 16100);
});

test('the full request lives only on the pending prompt, behind a token-gated GET that 404s once settled', () => {
  assert.match(backend, /\{ m: 'GET', qsplit: '\/api\/consent\/args', h: handleConsentArgs \}/);
  const route = extract(backend, 'function handleConsentArgs(req, res)', '\n}\n');
  assert.match(route, /pendingByRun\.get/);
  assert.match(route, /respondJson\(res, 404/);
  assert.match(backend, /argsSummary: consentSummary\(call\), argsFull: consentArgsFull\(call\), fresh:/);
  // never on the event: the permission.prompt row is still exactly the frozen five fields
  assert.match(backend, /const row = \{ promptId, agentId, tool: \(fields && fields\.tool\) \|\| 'tool', scope: \(fields && fields\.scope\) \|\| 'write', argsSummary: \(fields && fields\.argsSummary\) \|\| '' \};/);
  // group chat: the saved turn.approval never carries it; the in-memory pending entry does
  assert.match(groupSessions, /const \{ argsFull, \.\.\.fields \} = asked \|\| \{\};/);
  assert.match(groupSessions, /approvalArgs: async \(id, b\)/);
});

