'use strict';
/* configexport.test.js — pure-engine tests for the STATION BACKUP module (P1-7): buildExport / parseImport +
   the secret-redaction law. No IO — the module is dependency-free (index.js wires the live stores). Proves:
     - the envelope is schema-versioned (starnetExport: 1) so future imports can migrate;
     - a full round-trip (build -> parse) preserves the non-secret config;
     - SECRETS NEVER travel: connector tokens/headers/url-auth are redacted to a configured-marker only;
     - import is forward-tolerant (unknown sections dropped, newer schema accepted with a note) + fail-soft
       (a malformed section is skipped, never a throw), and validated (budget clamps, chain capped/cleaned). */
const assert = require('assert');
const C = require('../sidecar/configexport.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ---- schema + shape ----
eq(C.SCHEMA, 1, 'schema version is 1');
ok(Array.isArray(C.SECTIONS) && C.SECTIONS.indexOf('budget') >= 0, 'SECTIONS enumerates the known sections');

// ---- buildExport: only present sections are emitted; the version marker + app are stamped ----
const env = C.buildExport({
  settings: { theme: 'green', sound: false },
  budget: { perRun: 2, perDay: 40 },
  fallback: ['a/one', 'b/two'],
  autonomy: { initiative: 'wait', reach: 'sandbox' },
  roster: [{ agentId: 'lead', name: 'Lead', model: 'x/y', provider: 'openrouter', role: 'boss', system: 'SECRET PROMPT' }],
  dossier: 'the commander block',
  permissions: ['fs.write:workspace', 'shell.exec:*'],
  connectors: [{
    id: 'gh', transport: 'http', url: 'https://mcp.example/api?token=SEKRET#FRAGMENT_SECRET',
    headers: { Authorization: 'Bearer abc', 'X-Foo': 'ok' }, hasToken: true,
    enabled: false, oauth: true, label: 'GitHub'
  }, {
    id: 'stdio-sec', transport: 'stdio', command: 'node',
    args: ['server.js', '--api-token=ARG_SECRET', '--password', 'NEXT_SECRET', 'https://safe.example/mcp?access_token=URL_SECRET&view=ok',
      '--pwd=SHORT_SECRET', '-H', 'Authorization: Bearer HEADER_ARG_SECRET', '{"access":"JSON_ARG_SECRET"}'],
    env: { ACCESS: 'ENV_SECRET_WITH_INNOCENT_NAME' }, agentId: 'lead', cwd: 'C:/work', enabled: false
  }, {
    id: 'bad-url', transport: 'http', url: 'https://bad host/mcp?opaque=MALFORMED_URL_SECRET'
  }],
  notifyPrefs: { runComplete: true, sound: false }
}, { now: 123, app: 'StarNet' });

eq(env.starnetExport, 1, 'envelope carries the starnetExport:1 version pivot');
eq(env.exportedAt, 123, 'exportedAt stamped from injected clock');
eq(env.app, 'StarNet', 'app name stamped');
eq(env.sections.budget.perRun, 2, 'budget section carried');
eq(env.sections.fallback.models.length, 2, 'fallback chain carried as {models}');
eq(env.sections.dossier.block, 'the commander block', 'dossier carried');
eq(env.sections.permissions.allow.length, 2, 'permission grants carried');

// roster carries metadata only — NO raw system prompt, just a hasSystem marker
eq(env.sections.roster[0].model, 'x/y', 'roster model carried');
eq(env.sections.roster[0].hasSystem, true, 'roster notes hasSystem without leaking the prompt');
ok(JSON.stringify(env).indexOf('SECRET PROMPT') < 0, 'the raw system prompt is NEVER exported');

// ---- SECURITY LAW: connector secrets are redacted, configured-marker kept ----
const c = env.sections.connectors[0];
eq(c.id, 'gh', 'connector id kept');
ok(!('token' in (c.headers || {})), 'no token key leaks into exported headers');
eq(c.headers.Authorization, undefined, 'Authorization header value redacted');
eq(c.headers['X-Foo'], undefined, 'all custom header values are excluded because arbitrary names can carry credentials');
eq(c.configured, true, 'connector marked configured (so import can prompt re-entry)');
ok(c.redactedFields.indexOf('header:Authorization') >= 0, 'Authorization listed as a redacted field');
ok(c.redactedFields.indexOf('header:X-Foo') >= 0, 'even a custom header name is listed for re-entry');
ok(c.redactedFields.indexOf('url:auth') >= 0, 'the token-bearing url is flagged url:auth');
ok(c.redactedFields.indexOf('token') >= 0, 'a bearer token marker is retained without its value');
eq(c.url, 'https://mcp.example/api', 'the url is stripped of its token query');
eq(c.enabled, false, 'disabled state is exported');
eq(c.oauth, true, 'OAuth mode is exported');
const stdio = env.sections.connectors[1];
eq(stdio.agentId, 'lead', 'Safe Cell owner is exported');
eq(stdio.cwd, 'C:/work', 'stdio working directory is exported');
eq(stdio.enabled, false, 'disabled stdio connector stays disabled in the export');
eq(stdio.env.ACCESS, undefined, 'stdio environment values are excluded regardless of variable name');
ok(stdio.redactedFields.indexOf('env:ACCESS') >= 0, 'excluded environment variable is named for re-entry');
ok(stdio.args.length === 9 && stdio.args.every(x => x === '<redacted>'), 'every opaque stdio argument is replaced by a positional marker');
ok(stdio.redactedFields.filter(x => x.indexOf('args:') === 0).length === 9, 'every argument position is listed for local restoration or re-entry');
const exportBytes = JSON.stringify(env);
for (const secret of ['SEKRET', 'FRAGMENT_SECRET', 'Bearer abc', 'ARG_SECRET', 'NEXT_SECRET', 'URL_SECRET', 'SHORT_SECRET', 'HEADER_ARG_SECRET', 'JSON_ARG_SECRET', 'ENV_SECRET_WITH_INNOCENT_NAME', 'MALFORMED_URL_SECRET']) {
  ok(exportBytes.indexOf(secret) < 0, 'connector secret excluded: ' + secret);
}
eq(env.sections.connectors[2].url, '<redacted>', 'an invalid URL is excluded because its auth material cannot be parsed safely');

// ---- round-trip: parseImport recovers the non-secret config ----
const p = C.parseImport(env);
ok(p.ok, 'parseImport accepts the envelope we built');
eq(p.schema, 1, 'parsed schema is 1');
eq(p.sections.budget.perRun, 2, 'budget round-trips');
eq(p.sections.fallback.models.length, 2, 'fallback round-trips');
eq(p.sections.roster[0].model, 'x/y', 'roster metadata round-trips');
eq(p.sections.permissions.allow.length, 2, 'permissions round-trip');
ok(Array.isArray(p.secretsNeeded) && p.secretsNeeded.length === 3, 'all redacted connectors surface re-enter-your-key prompts');
eq(p.secretsNeeded[0].id, 'gh', 'the secretsNeeded prompt names the connector');
eq(p.sections.connectors[0].enabled, false, 'disabled state round-trips');
eq(p.sections.connectors[0].oauth, true, 'OAuth mode round-trips');
eq(p.sections.connectors[1].agentId, 'lead', 'Safe Cell owner round-trips');
eq(p.sections.connectors[1].cwd, 'C:/work', 'working directory round-trips');

const fortyArgs = Array.from({ length: 40 }, (_, i) => 'arg-' + i);
const fortyExport = C.buildExport({ connectors: [{ id: 'forty', transport: 'stdio', command: 'node', args: fortyArgs }] });
eq(fortyExport.sections.connectors[0].args.length, 40, 'supported argv is exported without the former 32-entry truncation');
eq(C.parseImport(fortyExport).sections.connectors[0].args.length, 40, 'supported argv is imported without truncation');
assert.throws(() => C.buildExport({ connectors: [{ id: 'too-many', transport: 'stdio', command: 'node', args: Array(129).fill('x') }] }), /128/, 'oversized argv fails export explicitly'); n++;
eq(C.parseImport({ starnetExport: 1, sections: { connectors: [{ id: 'too-many', transport: 'stdio', command: 'node', args: Array(129).fill('x') }] } }).ok, false, 'oversized argv is rejected before import');
eq(C.parseImport({ starnetExport: 1, sections: { connectors: [{ id: 'bad-http', transport: 'http', url: 'file:///tmp/x' }] } }).ok, false, 'import applies the edit route HTTP URL rule');
eq(C.parseImport({ starnetExport: 1, sections: { connectors: [{ id: 'bad-marker', transport: 'stdio', command: 'node', redactedFields: ['args:999'] }] } }).ok, false, 'out-of-range redaction markers are rejected');
eq(C.parseImport({ starnetExport: 1, sections: { connectors: [
  { id: 'duplicate', transport: 'http', url: 'https://one.example/mcp' },
  { id: 'duplicate', transport: 'http', url: 'https://two.example/mcp' }
] } }).ok, false, 'duplicate connector ids are rejected before mutation');

// Old schema-1 exports omitted operational fields. Their absence must survive parsing so the live importer can
// preserve an existing row or choose a disabled default for a new connector instead of activating it.
const legacyConnector = C.parseImport({ starnetExport: 1, sections: { connectors: [{ id: 'old', transport: 'http', url: 'https://old.example/mcp' }] } }).sections.connectors[0];
eq(Object.prototype.hasOwnProperty.call(legacyConnector, 'enabled'), false, 'legacy missing enabled remains distinguishable from enabled=true');
eq(Object.prototype.hasOwnProperty.call(legacyConnector, 'oauth'), false, 'legacy missing oauth remains distinguishable from oauth=false');

// ---- validation: budget clamps out junk; fallback is cleaned + capped at 8 ----
const badBudget = C.parseImport({ starnetExport: 1, sections: { budget: { perRun: -5, perDay: 'oops', global: 10 } } });
eq(badBudget.sections.budget.perRun, undefined, 'a negative budget value is dropped');
eq(badBudget.sections.budget.perDay, undefined, 'a non-numeric budget value is dropped');
eq(badBudget.sections.budget.global, 10, 'a valid budget value survives');

const bigChain = C.parseImport({ starnetExport: 1, sections: { fallback: { models: Array.from({ length: 20 }, (_, i) => 'm/' + i) } } });
eq(bigChain.sections.fallback.models.length, 8, 'the fallback chain is capped at 8 on import');

// ---- forward-tolerance: unknown sections dropped (noted), newer schema accepted with a note ----
const fwd = C.parseImport({ starnetExport: 99, sections: { budget: { perRun: 1 }, futureThing: { x: 1 } } });
ok(fwd.ok, 'a newer-schema file still imports what we understand');
ok(fwd.notes.some(x => /newer StarNet/.test(x)), 'a newer schema is noted');
ok(fwd.notes.some(x => /futureThing/.test(x)), 'an unknown section is noted, not fatal');
eq(fwd.sections.futureThing, undefined, 'the unknown section is not applied');
eq(fwd.sections.budget.perRun, 1, 'the known section still applies alongside the unknown one');

// ---- fail-soft + hard guards ----
eq(C.parseImport({}).ok, false, 'a file with no version marker is rejected');
eq(C.parseImport(null).ok, false, 'null is rejected, not thrown');
eq(C.parseImport({ starnetExport: 1, sections: { budget: 'not an object' } }).ok, true, 'a malformed section does not fail the whole import');


// ---- security audit 2026-09-25: an imported file cannot bless folders (path:<root> grants are machine authority) ----
{
  const hostile = C.parseImport({ starnetExport: 1, sections: { permissions: { allow: ['fs.write:workspace', 'path:C:\\', 'PATH:/', 'path:/home/victim'] } } });
  ok(hostile.ok, 'an import carrying path grants still parses');
  eq(JSON.stringify(hostile.sections.permissions.allow), JSON.stringify(['fs.write:workspace']), 'every path:<root> grant is dropped; capability grants survive');
  ok(hostile.notes.some(x => /skipped 3 project folder grants/.test(x)), 'the skipped folder grants are named in the import notes');
}

// ---- the SUBSCRIPTION usage limits ride the budget section as budget.tokens (2026-10-11) ----
{
  const env = C.buildExport({ budget: { perDay: 25, tokens: { perDayTokens: 15000, perRunTokens: 40000 } } }, { now: 1 });
  eq(JSON.stringify(env.sections.budget.tokens), JSON.stringify({ perDayTokens: 15000, perRunTokens: 40000 }), 'export carries the token limits inside budget');
  const back = C.parseImport(JSON.parse(JSON.stringify(env)));
  eq(JSON.stringify(back.sections.budget), JSON.stringify({ perDay: 25, tokens: { perDayTokens: 15000, perRunTokens: 40000 } }), 'and they round-trip');
  const junk = C.parseImport({ starnetExport: 1, sections: { budget: { perRun: 1, tokens: { perDayTokens: -1, perRunTokens: 1.5, other: 9 } } } });
  eq(JSON.stringify(junk.sections.budget.tokens), JSON.stringify({}), 'junk token limits are dropped (whole numbers >= 0 only)');
  eq(C.parseImport({ starnetExport: 1, sections: { budget: { perRun: 1 } } }).sections.budget.tokens, undefined, 'an older backup without tokens parses as before');
  const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  ok(/budget: Object\.assign\(\{\}, budgetOverrides, Object\.keys\(tokenOverrides\)\.length \? \{ tokens: Object\.assign\(\{\}, tokenOverrides\) \} : \{\}\)/.test(idx), 'the host exports the saved token limits');
  ok(/tokenOverrides = budgetCaps\.cleanTokenOverrides\(\(sec\.budget && sec\.budget\.tokens\) \|\| \{\}\); saveTokenOverrides\(\); applyTokenCaps\(\);/.test(idx), 'import applies them through their durable store');
  ok(/case 'budget': budgetOverrides = \{\}; saveBudgetOverrides\(\); applyBudgetCaps\(\); tokenOverrides = \{\}; saveTokenOverrides\(\); applyTokenCaps\(\); break;/.test(idx), 'reset of the budget section clears them too');
}

console.log('configexport.test.js OK —', n, 'assertions');
