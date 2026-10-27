/* node test/google-relay-guard.test.js — restricted-tier Google data never rides the StarNet relay
   (sidecar/mcp/google-relay-guard.js + its index.js wiring). Offline + deterministic. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const google = require('../sidecar/mcp/google-client.js');
const { TOOLS, ENDPOINTS } = require('../sidecar/mcp/transport.google.js');
const { mcpToolName } = require('../sidecar/mcp/translate.js');
const { makeGoogleRelayGuard, WITHHELD } = require('../sidecar/mcp/google-relay-guard.js');

let configs = [
  { id: 'gmail', url: ENDPOINTS.gmail, transport: 'http' },
  { id: 'my-mail', url: ENDPOINTS.gmail, transport: 'http' },                     // custom id, same restricted endpoint
  { id: 'google-drive', url: ENDPOINTS['google-drive'], transport: 'http' },
  { id: 'google-calendar', url: ENDPOINTS['google-calendar'], transport: 'http' },  // sensitive: unaffected
  { id: 'gmail-send', url: ENDPOINTS['gmail-send'], transport: 'http' },            // sensitive: unaffected
  { id: 'notion', url: 'https://mcp.notion.com/mcp', transport: 'http' }
];
const guard = makeGoogleRelayGuard({ googleClient: google, tools: TOOLS, mcpToolName, configs: () => configs });

/* A. classification is by SAVED ENDPOINT, never by id */
A.eq([...guard.restrictedConnectors().keys()].sort(), ['gmail', 'google-drive', 'my-mail'], 'Gmail + Drive endpoints are restricted, whatever their id');
A.ok(guard.restrictedToolNames().has(mcpToolName('my-mail', 'read_message')), 'a custom-id Gmail connector\'s tools are restricted');
A.ok(!guard.restrictedToolNames().has(mcpToolName('google-calendar', 'list_events')), 'Calendar stays usable');
A.ok(!guard.restrictedToolNames().has(mcpToolName('gmail-send', 'send_email')), 'send-only Gmail stays usable');

/* B. LIVE: projection */
A.eq(guard.projectable('gmail', 'starnet'), false, 'StarNet Managed is not offered Gmail');
A.eq(guard.projectable('my-mail', 'starnet'), false, 'nor a custom-id Gmail');
A.eq(guard.projectable('google-drive', 'starnet'), false, 'nor whole-Drive');
A.eq(guard.projectable('google-calendar', 'starnet'), true, 'Calendar is fine on StarNet Managed');
A.eq(guard.projectable('notion', 'starnet'), true, 'non-Google connectors are untouched');
A.eq(guard.projectable('gmail', 'openrouter'), true, 'own-key providers keep Gmail');

/* C. REPLAY: only restricted tool results are withheld, by exact call id */
const gm = mcpToolName('gmail', 'read_message'), cal = mcpToolName('google-calendar', 'list_events');
const history = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'what did Ann say?' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: gm, arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: cal, arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'SECRET MAIL BODY' },
  { role: 'tool', tool_call_id: 'c2', content: 'calendar events' },
  { role: 'user', content: 'thanks' }
];
const frozen = JSON.stringify(history);
const out = guard.scrub(history);
A.eq(out.withheld, 1, 'exactly one restricted result withheld');
A.eq(out.messages[3].content, WITHHELD, 'the Gmail result is replaced with the notice');
A.eq(out.messages[4].content, 'calendar events', 'the Calendar result is kept');
A.eq(out.messages[3].tool_call_id, 'c1', 'the tool pair stays provider-valid');
A.ok(!JSON.stringify(out.messages).includes('SECRET MAIL BODY'), 'no restricted content survives in the outgoing copy');
A.eq(JSON.stringify(history), frozen, 'the caller\'s (local) history is never mutated');
A.eq(guard.scrub([{ role: 'user', content: 'hi' }]).withheld, 0, 'nothing to do is a no-op');

/* D. provider wrapper filters every streamed request, and only the request */
let seen = null;
const base = { id: 'starnet', priceOf: () => 1, async *stream(req) { seen = req; yield { type: 'text', delta: 'ok' }; } };
const wrapped = guard.guardProvider(base);
A.eq(wrapped.priceOf(), 1, 'other provider methods pass through');
(async () => {
  for await (const _ of wrapped.stream({ model: 'm', messages: history, tools: [] })) { /* drain */ }
  A.ok(seen && !JSON.stringify(seen.messages).includes('SECRET MAIL BODY'), 'the relay receives the scrubbed copy');
  A.eq(seen.model, 'm', 'the rest of the request is untouched');
  A.eq(JSON.stringify(history), frozen, 'the loop\'s own messages are untouched');
  // live config changes apply to the next request (nothing cached)
  configs = configs.filter(c => c.id !== 'gmail' && c.id !== 'my-mail');
  A.eq(guard.scrub(history).withheld, 0, 'removing Gmail stops withholding its (now unknown) tool names');

  /* E. wiring: index.js routes EVERY provider build through the guard, and filters connector projection */
  const src = readSidecarSource();
  A.ok(/selectProvider: selectProviderRaw,/.test(src), 'the factory import is the raw builder');
  A.ok(/normalizeProvider\(opts\.provider\) === 'starnet' \? googleRelayGuard\(\)\.guardProvider\(built\) : built/.test(src), 'StarNet Managed providers are wrapped');
  A.eq((src.match(/selectProviderRaw\(/g) || []).length, 1, 'nothing else builds a provider around the guard');
  A.ok(/toolDefsForObjects\(projectableObjects\)/.test(src) && /googleRelayGuard\(\)\.projectable\(/.test(src), 'connector projection consults the guard');

  /* F. Gmail via APP PASSWORD (IMAP, no OAuth) is the same mailbox data: restricted by its saved endpoint */
  const imapGmail = require('../sidecar/mcp/transport.gmail-imap.js');
  const extra = [{ service: imapGmail.ID, matches: c => imapGmail.productForUrl(String(c.url || '')) === imapGmail.ID, tools: imapGmail.TOOLS }];
  const apConfigs = [
    { id: 'gmail-app-password', url: imapGmail.ENDPOINT, transport: 'http', token: 'me@example.com:abcdefghijklmnop' },
    { id: 'work-mail', url: imapGmail.ENDPOINT, transport: 'http' },                                     // custom id, same endpoint
    { id: 'lookalike', url: 'https://imap.gmail.com/', transport: 'http' }                                 // not the adapter
  ];
  const apGuard = makeGoogleRelayGuard({ googleClient: google, tools: TOOLS, mcpToolName, configs: () => apConfigs, extraRestricted: extra });
  A.eq([...apGuard.restrictedConnectors().keys()].sort(), ['gmail-app-password', 'work-mail'], 'app-password Gmail is restricted by endpoint, whatever its id');
  A.eq(apGuard.projectable('gmail-app-password', 'starnet'), false, 'StarNet Managed is not offered app-password Gmail');
  A.eq(apGuard.projectable('work-mail', 'starnet'), false, 'nor a custom-id copy');
  A.eq(apGuard.projectable('gmail-app-password', 'openrouter'), true, 'own-key providers keep it');
  for (const t of imapGmail.TOOLS) A.ok(apGuard.restrictedToolNames().has(mcpToolName('gmail-app-password', t.name)), 'restricted tool: ' + t.name);
  const apRead = mcpToolName('gmail-app-password', 'read_message');
  const apOut = apGuard.scrub([
    { role: 'assistant', content: '', tool_calls: [{ id: 'm1', type: 'function', function: { name: apRead, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'm1', content: 'IMAP SECRET BODY' }
  ]);
  A.ok(apOut.withheld === 1 && !JSON.stringify(apOut.messages).includes('IMAP SECRET BODY'), 'an app-password Gmail result is withheld from the relay copy');
  const noExtra = makeGoogleRelayGuard({ googleClient: google, tools: TOOLS, mcpToolName, configs: () => apConfigs });
  A.eq(noExtra.projectable('gmail-app-password', 'starnet'), true, 'control: without extraRestricted the guard would NOT cover it (so the wiring is load-bearing)');
  A.ok(/extraRestricted: \[\{ service: gmailImapTransport\.ID, matches: cfg => .*gmailImapTransport\.productForUrl\(/.test(src), 'index.js wires the app-password connector into the guard');
  A.ok(/gmailImapTransport\.passwordOf/.test(src), 'index.js lists the bare app password as a known secret for redaction');
  A.report('google-relay-guard.test');
})().catch(e => { console.error(e); process.exit(1); });
