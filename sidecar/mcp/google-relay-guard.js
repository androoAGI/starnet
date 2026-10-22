'use strict';
/* sidecar/mcp/google-relay-guard.js — RESTRICTED-tier Google data never reaches a Agent OS-operated server.

   Google's security assessment (CASA) applies when restricted-scope data (Gmail read/compose, whole-Drive read)
   is stored on or transmitted through the DEVELOPER's servers. Agent OS is local-first: the one Agent OS-operated
   path model traffic can take is the Agent OS Managed provider ('starnet', the credits relay). This guard keeps
   restricted Google content off that path in both directions it could travel:

     • LIVE  — a run on Agent OS Managed is not offered restricted Google connector tools (projectable()).
     • REPLAY — every request streamed to Agent OS Managed (primary, fallback, auxiliary pass) has the results of
                earlier restricted Google tool calls replaced by a notice (guardProvider()). The agent's LOCAL
                transcript is untouched; only the outgoing copy is filtered.

   Classification is by the connector's SAVED ENDPOINT (google-client.js serviceOf), never its id, so a custom
   id pointing at the Gmail adapter is still restricted. Tool names come from the local adapter's own tool list
   (transport.google.js TOOLS) through the same wire-name function the registry uses — exact names, no prefix
   guessing. Sensitive-tier services (Calendar, Docs, Sheets, send-only Gmail) are not affected.

   MAILBOX ACCESS WITHOUT OAUTH (extraRestricted): the Gmail app-password connector (transport.gmail-imap.js) reads
   the same mail over IMAP. It never asks Google for an OAuth scope, but it is the same mailbox-read data, so it is
   classified exactly like restricted Gmail — by its saved endpoint, with its own exact tool list.

   Not covered (derived content, see docs/GOOGLE_REVIEW_BUILD.md): an assistant's own prose that restates a
   message, memory notes or files the agent wrote from Google content. */
const { note: failNote } = require('../failopen.js');
const WITHHELD = '[Withheld: this Gmail / Google Drive result stays on this computer and is never sent to Agent OS Managed. '
  + 'Switch this agent to your own model provider to work with it.]';

function makeGoogleRelayGuard({ googleClient, tools, mcpToolName, configs, extraRestricted }) {
  if (!googleClient || !tools || typeof mcpToolName !== 'function' || typeof configs !== 'function') {
    throw new Error('google-relay-guard requires { googleClient, tools, mcpToolName, configs }');
  }
  // [{ service, matches(cfg) -> bool, tools: [{ name }] }] — non-OAuth mailbox connectors held to the restricted rule.
  const extras = Array.isArray(extraRestricted) ? extraRestricted.filter(x => x && x.service && typeof x.matches === 'function') : [];
  function restrictedService(cfg) {
    for (const x of extras) { try { if (x.matches(cfg)) return x.service; } catch (e) { failNote('mcp.relayGuard.match', e); } }
    const svc = googleClient.serviceOf(cfg);
    return svc && googleClient.SERVICES[svc] && googleClient.SERVICES[svc].tier === 'restricted' ? svc : null;
  }
  function toolsOf(svc) {
    const x = extras.find(e => e.service === svc);
    return (x ? x.tools : tools[svc]) || [];
  }
  // connector id -> restricted service, from the live saved configs (read at call time, never cached).
  function restrictedConnectors() {
    const out = new Map();
    for (const cfg of (configs() || [])) {
      const svc = cfg && cfg.id && restrictedService(cfg);
      if (svc) out.set(String(cfg.id), svc);
    }
    return out;
  }
  function restrictedToolNames() {
    const names = new Set();
    for (const [id, svc] of restrictedConnectors()) for (const t of toolsOf(svc)) names.add(mcpToolName(id, t.name));
    return names;
  }
  // LIVE: may this room object's connector be projected into a run on this provider?
  function projectable(connectorId, providerId) {
    return providerId !== 'starnet' || !restrictedConnectors().has(String(connectorId || ''));
  }
  // REPLAY: the outgoing copy of a conversation with restricted Google tool results withheld.
  function scrub(messages) {
    if (!Array.isArray(messages)) return { messages, withheld: 0 };
    const names = restrictedToolNames();
    if (!names.size) return { messages, withheld: 0 };
    const callName = new Map();
    let withheld = 0;
    const out = messages.map(m => {
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) if (c && c.id) callName.set(c.id, c.function && c.function.name);
      }
      if (m && m.role === 'tool' && names.has(callName.get(m.tool_call_id))) {
        withheld++;
        return Object.assign({}, m, { content: WITHHELD });
      }
      return m;
    });
    return { messages: withheld ? out : messages, withheld };
  }
  // Wrap a provider so every request it streams is scrubbed. Own props are copied (callers may spread it).
  function guardProvider(provider) {
    if (!provider || typeof provider.stream !== 'function') return provider;
    return Object.assign({}, provider, {
      stream(req) {
        const scrubbed = req && Array.isArray(req.messages) ? Object.assign({}, req, { messages: scrub(req.messages).messages }) : req;
        return provider.stream(scrubbed);
      }
    });
  }
  return { restrictedConnectors, restrictedToolNames, projectable, scrub, guardProvider };
}

module.exports = { makeGoogleRelayGuard, WITHHELD };
