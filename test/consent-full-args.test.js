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
  assert.ok(short.length <= 80 && short.endsWith('…'), 'the short lock-screen summary is unchanged: ' + short);
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

test('every consent card without its own payload view offers INSPECT FULL REQUEST, read on first open', async () => {
  const perm = extract(chat, 'function permissionRow(p, ws)', 'const btns = document.createElement');
  assert.match(perm, /\} else if \(p\.tool !== 'path\.trust' && !\/\^browser\[\._\]login\/\.test\(String\(p\.tool \|\| ''\)\) && p\.promptId\) \{[^\n]*\n\s*r\.body\.appendChild\(fullRequestDisclosure\(/);
  assert.match(group, /t\.approval\.tool !== 'path\.trust' && !\/\^browser\[\._\]login\/\.test/, 'a sign-in hand-off (no arguments) gets no disclosure in group chat either');
  assert.match(perm, /Harness\.consentArgs\(/);
  assert.match(group, /Chat\.consentDisclosure\(\(\) => api\(\{ op: 'approvalArgs'/);
  // run the real disclosure against a tiny DOM: closed = no read; first open = one read into a selectable <pre> + copy key
  const els = [];
  const mk = (tag) => { const el = { tag, children: [], attrs: {}, hidden: false, textContent: '', listeners: {}, className: '',
    appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { this.listeners[k] = f; } }; els.push(el); return el; };
  const ctx = { document: { createElement: mk }, copyText: async () => true, setTimeout: () => 0, Promise };
  vm.createContext(ctx); vm.runInContext(extract(chat, 'function fullRequestDisclosure(load)', '  function permissionRow(p, ws)'), ctx);
  let reads = 0;
  const d = ctx.fullRequestDisclosure(async () => { reads++; return { ok: true, tool: 'shell.exec', args: '{\n  "command": "' + COMMAND.replace(SECRET, '[REDACTED]') + '"\n}', truncated: false }; });
  const summary = d.children[0], pre = d.children[1], copy = d.children[2];
  assert.equal(summary.textContent, 'INSPECT FULL REQUEST (secrets redacted)');
  assert.equal(pre.tag, 'pre'); assert.equal(copy.hidden, true);
  d.open = false; d.listeners.toggle(); await new Promise(r => setImmediate(r));
  assert.equal(reads, 0, 'nothing is read until the Commander opens it');
  d.open = true; d.listeners.toggle(); await new Promise(r => setImmediate(r));
  assert.equal(reads, 1); assert.ok(pre.textContent.includes('-d @release-manifest.json')); assert.equal(copy.hidden, false);
  d.listeners.toggle(); await new Promise(r => setImmediate(r));
  assert.equal(reads, 1, 'read once');
  // an answered prompt says so truthfully instead of showing stale text
  const gone = ctx.fullRequestDisclosure(async () => ({ ok: false, gone: true, error: 'gone' }));
  gone.open = true; gone.listeners.toggle(); await new Promise(r => setImmediate(r));
  assert.match(gone.children[1].textContent, /already answered or expired/);
  assert.equal(gone.children[2].hidden, true);
  // a LIVE prompt with no arguments (review finding) is never called answered
  const bare = ctx.fullRequestDisclosure(async () => ({ ok: true, tool: '', args: '', truncated: false, noDetails: true }));
  bare.open = true; bare.listeners.toggle(); await new Promise(r => setImmediate(r));
  assert.ok(!/already answered/.test(bare.children[1].textContent) && /no details beyond/.test(bare.children[1].textContent), 'a still-waiting prompt without arguments says so: ' + bare.children[1].textContent);
  assert.equal(bare.children[2].hidden, true);
  assert.match(backend, /if \(finish && !full\) return respondJson\(res, 200, \{ ok: true, tool: '', args: '', truncated: false, noDetails: true \}\);/, 'the route answers a live argument-less prompt with noDetails, never the 404 "answered"');
});
