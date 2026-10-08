/* node test/gemini-wire-schema.test.js — two bugs a real Gemini run found (self-driving, 2026-10-08).
   1. Gemini refuses the WHOLE request when any declared array has no `items` ("…properties[shape].items: missing field",
      INVALID_ARGUMENT, through OpenRouter or direct). station.plan's `shape: {type:'array'}` was revealed by any station
      tool.search and every such Gemini run ended "Something went wrong". toolschema.arrayItems gives an item-less array
      `items: {}` on both wire paths (wireTools for OpenRouter/OpenAI-compatible, forGemini for the native provider),
      changes nothing else, and keeps object identity when nothing was missing.
   2. A model searches by the WIRE name it was shown ("station_control"); tool.search answered "no match" because the
      registry name is dotted. An underscored term now also searches as its dotted twin. */
'use strict';
const A = require('./_assert.js');
const ts = require('../sidecar/providers/toolschema.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');

(async () => {
  // ---- 1. arrays always carry items on the wire ----
  const plan = { type: 'object', properties: { shape: { type: 'array' }, rooms: { type: 'array', items: { type: 'object', properties: { tags: { type: 'array' } } } }, n: { type: ['array', 'null'] } } };
  const wire = ts.wireTools([{ type: 'function', function: { name: 'station_plan', parameters: plan } }])[0].function.parameters;
  A.eq(wire.properties.shape, { type: 'array', items: {} }, 'wireTools: an item-less array gets items {}');
  A.eq(wire.properties.rooms.items.properties.tags, { type: 'array', items: {} }, 'nested ones too');
  A.eq(wire.properties.n, { type: ['array', 'null'], items: {} }, 'and an array|null union');
  A.eq(plan.properties.shape, { type: 'array' }, 'the registry schema itself is never mutated');
  const gem = ts.forGemini(plan);
  A.ok(gem.properties.shape.items && gem.properties.rooms.items.properties.tags.items, 'forGemini (native provider) fills them the same way');
  const tools = [{ type: 'function', function: { name: 'a', parameters: { type: 'object', properties: { s: { type: 'string' }, l: { type: 'array', items: { type: 'string' } } } } } }];
  A.ok(ts.wireTools(tools) === tools, 'nothing missing → the very same tools array (no copy, no byte change)');
  A.eq(ts.arrayItems({ anyOf: [{ type: 'array' }, { type: 'string' }] }).anyOf[0], { type: 'array', items: {} }, 'inside anyOf too');

  const stationSrc = require('fs').readFileSync(require('path').join(__dirname, '../sidecar/tools/builtin/station.js'), 'utf8');
  A.ok(/shape: \{ type: 'array', items: \{\} \}/.test(stationSrc), 'station.plan declares what shape holds at the source');

  // ---- 2. tool.search finds a tool by its wire name ----
  const registry = makeRegistry();
  for (const name of ['station.control', 'station.power', 'web_search', 'shell.bg.status']) {
    registry.register({ name, capability: 'x', scope: 'read', requiresConsent: false, description: 'the ' + name + ' tool', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'ok' }) });
  }
  const search = makeToolSearchTool({ registry }).toolSearchTool;
  const ctx = { deferred: ['station.control', 'station.power', 'web_search', 'shell.bg.status'] };
  const r1 = await search.run({ query: 'station_control' }, ctx);
  A.ok(!/no match/i.test(r1.summary) && /station\.control/.test(r1.content), 'tool.search "station_control" finds station.control (' + r1.summary + ')');
  A.ok(!/station\.power/.test(r1.content.split('\n')[0] || ''), 'and leads with it, not its sibling');
  const r2 = await search.run({ query: 'shell_bg_status' }, ctx);
  A.ok(/shell\.bg\.status/.test(r2.content), 'a multi-dot name by its wire name');
  const r3 = await search.run({ query: 'web_search' }, ctx);
  A.ok(/web_search/.test(r3.content), 'a real underscored name still matches as written');
  A.report('gemini-wire-schema');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
