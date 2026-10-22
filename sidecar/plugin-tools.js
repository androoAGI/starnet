/* sidecar/plugin-tools.js — a plugin's api.tool() definitions as tools the crew can call (phase 2, 2026-09-29).

   Same contract as an MCP connector tool (sidecar/mcp/translate.js), on purpose — one trust model for "code the
   Commander installed that the station cannot see inside":
     · capability 'plugin:<id>': granted only by that plugin's TERMINAL placed in the agent's room (object =
       capability; frontend worldmodel.bayObjects → { objectType: 'plugin', pluginId });
     · impact 'external-unknown' + requiresConsent: a watched run shows the Commander a per-call approval card, an
       unattended run is withheld, and taint revokes it — exactly like a connector;
     · the result is FENCED as external content. The plugin's code is approved, but what it returns (a PR title,
       an email subject, a web page) was written by whoever wrote that data.
   The description says who wrote it before it says what it does. */
'use strict';

const translate = require('./mcp/translate.js');
const fence = require('./tools/fence.js');
const { sanitizePart, translateSchema, clampResult, untrustedText, DESC_MAX } = translate._internals;
const NAME_MAX = 64;

function pluginToolName(pluginId, toolName) {
  const full = 'plugin__' + sanitizePart(pluginId) + '__' + sanitizePart(toolName);
  if (full.length <= NAME_MAX) return full;
  // deterministic and collision-resistant, like mcpToolName
  let h = 0x811c9dc5;
  for (let i = 0; i < full.length; i++) { h ^= full.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return full.slice(0, NAME_MAX - 7) + '_' + h.toString(36).padStart(6, '0').slice(-6);
}

function render(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
}

/* makePluginToolDefs({ pluginId, pluginName, tools, call }) -> [toolDef]
   `tools` is what the plugin registered ({ name, description, parameters, readOnly }); `call(name, args, ctx)` runs
   it in the plugin's process (plugin-runtime.callTool). */
function makePluginToolDefs(o) {
  const pluginId = String(o.pluginId || '');
  const label = untrustedText(o.pluginName || pluginId, 60) || pluginId;
  const capability = 'plugin:' + sanitizePart(pluginId);
  const out = [];
  for (const t of (o.tools || [])) {
    if (!t || !t.name) continue;
    const readOnly = t.readOnly === true;
    const desc = untrustedText(t.description, DESC_MAX) || ('A tool from the ' + label + ' plugin.');
    out.push({
      name: pluginToolName(pluginId, t.name),
      description: '[' + label + ' plugin tool; written by that plugin, not by Agent OS] ' + desc,
      schema: translateSchema(t.parameters),
      scope: readOnly ? 'read' : 'execute',
      readOnly,
      capability,
      impact: 'external-unknown',
      requiresConsent: true,
      network: true,
      timeoutMs: 0,
      run: async function (args, ctx) {
        let value;
        try { value = await o.call(t.name, args || {}, { agentId: ctx && ctx.agentId, runId: ctx && ctx.runId }, ctx && ctx.signal); }
        catch (e) {
          const msg = String((e && e.message) || e || 'the plugin tool failed');
          throw new Error(fence.fenceExternal(msg.slice(0, 4000), 'ERROR from the ' + label + ' plugin'));
        }
        const text = render(value);
        const clamped = clampResult(text);
        return {
          content: fence.fenceExternal(clamped.text || '(the tool returned nothing)', 'result from the ' + label + ' plugin'),
          fullContent: clamped.truncated ? fence.fenceExternal(text, 'result from the ' + label + ' plugin') : undefined,
          summary: 'plugin:' + pluginId + ' ' + t.name + (clamped.truncated ? ' (truncated)' : '')
        };
      }
    });
  }
  return out;
}

module.exports = { makePluginToolDefs, pluginToolName };
