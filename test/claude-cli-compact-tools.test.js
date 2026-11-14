/* node test/claude-cli-compact-tools.test.js — COMPACT CLAUDE-CLI TOOL TEXT (cost audit W2.2, STARNET_CLI_COMPACT_TOOLS).

   On the Claude sign-in route every tool rides as text in the CLI system prompt. With the switch on, a tool's parameters
   are a signature ({path: string, limit?: integer}) instead of its JSON Schema. This file locks the two halves:

   OFF (the default) IS TODAY'S TEXT, BYTE FOR BYTE. The tools section the adapter writes is the one the base commit
   wrote: checked against the base algorithm written out here, against a hash recorded from the base commit's own code
   (GOLDEN_OFF), and through the adapter's own system prompt file.

   ON IS A RE-RENDERING, NEVER A TRIM. For every tool the registry can project (tools/catalog.js, on every platform), the
   signature is parsed back and compared with the JSON Schema: no field, type, enum value, required flag, default, limit
   or description is lost, or the tool took the JSON fallback and its line is today's. A schema that uses anything the
   notation cannot say exactly (anyOf, oneOf, allOf, $ref, const, patternProperties, additionalProperties, ...) keeps its
   JSON. The call format the model is told to write does not change, and the section says how to read a signature.

   Pure: a fake CLI child, no sidecar, no network, no model. */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { makeClaudeCliProvider, _internals } = require('../sidecar/providers/claude-cli.js');
const Sig = require('../sidecar/providers/tool-signature.js');
const { buildCatalog } = require('../sidecar/tools/catalog.js');

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = s => Buffer.byteLength(s, 'utf8');
const clone = v => JSON.parse(JSON.stringify(v));

// ---- the base commit's rendering, written out (57c741da7 claude-cli.js toolLines + toolsPromptOf) ---------------------
const baseLine = fn => '- ' + String(fn.name).trim() + (fn.description ? ': ' + String(fn.description).trim() : '') +
  '\n  parameters: ' + JSON.stringify(fn.parameters || { type: 'object', properties: {} });
const CALL_FORMAT = [
  '# Tools',
  'You cannot execute anything yourself; StarNet runs tools for you. To call tools, end your reply with a block exactly like:',
  '<function_calls>',
  '<invoke name="TOOL_NAME">',
  '<parameter name="PARAM_NAME">value</parameter>',
  '</invoke>',
  '</function_calls>',
  'Rules:',
  '- Write a string value raw, with no quotes and no escaping: file contents go in exactly as they should be saved. Write numbers, booleans, arrays and objects as JSON.',
  '- Several <invoke> blocks inside one <function_calls> block run together. After </function_calls>, STOP and write nothing more: the results arrive in the next message as <tool_result> blocks, and anything written after the block is discarded.',
  '- Use only the tools listed below. Never write <tool_result> blocks yourself and never invent a result.',
  '- When no tool is needed, answer normally without any tool block.',
  ''
];
const baseSection = tools => CALL_FORMAT.concat(['Available tools:', tools.map(t => baseLine(t.function)).join('\n')]).join('\n');
const NO_TOOLS = '# Tools\nNo tools are available in this turn. Answer in plain prose only: never write tool-call markup (<tool_call>, <invoke>, <function_calls>) and never claim to have run anything.';

// ---- a fixed tool list: every shape the notation says, and two it cannot ------------------------------------------------
const tool = (name, description, parameters) => ({ type: 'function', function: Object.assign({ name }, description == null ? {} : { description }, parameters === undefined ? {} : { parameters }) });
const FIXED = [
  tool('fs_write', 'Write a file.', { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', description: 'Workspace-relative path.' }, content: { type: 'string' }, overwrite: { type: 'boolean', default: false } } }),
  tool('browser_intercept', 'Block resource kinds.', { type: 'object', required: ['kinds'], properties: { kinds: { type: 'array', items: { type: 'string', enum: ['image', 'media', 'font', 'stylesheet'] } } } }),
  tool('skill_list', 'List skills.', { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } }),
  tool('routine_create', 'Create a routine.', { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, repeatTimes: { type: ['integer', 'null'], description: 'null = forever.' },
    deliver: { type: 'string', enum: ['local', 'origin'], default: 'local', description: 'origin returns each result to this chat.' }, skills: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    steps: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, args: { type: ['object', 'string'] }, tags: { type: 'array', items: { type: 'string', maxLength: 40 } } } } } } }),
  tool('app_publish', 'Publish a value.', { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { description: 'any JSON value' }, meta: { type: 'object' }, rows: { type: 'array' }, look: {} } }),
  tool('no_params', 'Takes nothing.'),
  tool('code_run', 'Run code.', { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', minLength: 1 } } }),
  tool('mcp_search', 'An MCP tool.', { type: 'object', properties: { q: { anyOf: [{ type: 'string' }, { type: 'number' }] } } })
];
/* sha256 of the base commit's own output for FIXED, recorded by running 57c741da7's sidecar/providers/claude-cli.js
   (_internals.toolsPrompt(FIXED), and the system text of _internals.buildPrompt for the messages below). Re-record only
   when the OFF text changes on purpose for a reason outside this switch, and say so in that commit. */
const GOLDEN_OFF = {
  section: '3fdabd30b861eeb738dd48b73ec0f87e30d8646b0c6108ae2cf7648ec08998e2',
  system: 'cafe1991aef493fdf1f86eda0b1d2db8c122c627a065aaffc666e3703b51325e'
};
const MESSAGES = [{ role: 'system', content: 'You are the test agent.' }, { role: 'user', content: 'go' }];

// ---- A. OFF is the base text ------------------------------------------------------------------------------------------
{
  const off = _internals.toolsPrompt(FIXED);
  A.eq(off, baseSection(FIXED), 'OFF: the tools section is the base commit\'s, byte for byte (fixed list)');
  A.eq(sha(off), GOLDEN_OFF.section, 'OFF: and it hashes to what the base commit\'s own code wrote');
  A.eq(_internals.toolsPrompt(FIXED, false), off, 'OFF: compact=false is the same text');
  A.eq(sha(_internals.buildPrompt(MESSAGES, FIXED).system), GOLDEN_OFF.system, 'OFF: the whole system text hashes to what the base commit\'s own code wrote');
  A.eq(_internals.buildPrompt(MESSAGES, FIXED, undefined, undefined, undefined, false).system, _internals.buildPrompt(MESSAGES, FIXED).system, 'OFF: buildPrompt with compact=false is the same system text');
  A.eq(_internals.toolsPrompt([]), NO_TOOLS, 'OFF: a turn with no tools says so, as before');
  A.eq(_internals.toolsPrompt([], true), NO_TOOLS, 'ON: a turn with no tools says exactly the same (no legend for no list)');
}

// ---- every tool the registry can project, on every platform ------------------------------------------------------------
const catalog = [];
{
  const seen = new Set();
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const t of buildCatalog({ platform }).wireFormat()) {
      const key = JSON.stringify(t);
      if (!seen.has(key)) { seen.add(key); catalog.push(t); }
    }
  }
}
A.ok(catalog.length >= 120, 'fixture: the catalogue projects the station\'s tools (' + catalog.length + ' distinct across platforms)');
{
  const lines = _internals.toolLines(catalog);
  A.eq(lines.length, catalog.length, 'OFF: one line per tool');
  const diff = catalog.filter((t, i) => lines[i].line !== baseLine(t.function)).map(t => t.function.name);
  A.eq(diff, [], 'OFF: every catalogue tool\'s line is the base commit\'s, byte for byte');
  A.eq(_internals.toolsPrompt(catalog), baseSection(catalog), 'OFF: and so is the whole section');
}

// every fact a schema states, as flat strings: what "nothing was lost" is checked on
function facts(schema) {
  const out = [];
  (function walk(s, at) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    out.push(at + ' type=' + JSON.stringify(s.type === undefined ? null : s.type));
    if (typeof s.description === 'string' && s.description) out.push(at + ' description=' + s.description);
    if ('default' in s) out.push(at + ' default=' + JSON.stringify(s.default));
    for (const v of (Array.isArray(s.enum) ? s.enum : [])) out.push(at + ' enum=' + JSON.stringify(v));
    for (const k of Sig.FACETS) if (k in s) out.push(at + ' ' + k + '=' + JSON.stringify(s[k]));
    const req = Array.isArray(s.required) ? s.required : [];
    for (const k of Object.keys(s.properties || {})) {
      out.push(at + '.' + k + (req.indexOf(k) >= 0 ? ' required' : ' optional'));
      walk(s.properties[k], at + '.' + k);
    }
    if (s.items) walk(s.items, at + '[]');
  })(schema, '$');
  return out.sort();
}
const descriptions = schema => { const out = []; (function walk(s) { if (!s || typeof s !== 'object') return; if (Array.isArray(s)) return s.forEach(walk); if (typeof s.description === 'string' && s.description) out.push(s.description); for (const k of Object.keys(s.properties || {})) walk(s.properties[k]); walk(s.items); })(schema); return out; };
const paramsOf = line => line.slice(line.indexOf('\n  parameters: ') + '\n  parameters: '.length);

// ---- B. ON: parsed back, nothing lost -----------------------------------------------------------------------------------
function checkAll(list, label) {
  const off = _internals.toolLines(list), on = _internals.toolLines(list, true);
  let jsonBytes = 0, onBytes = 0;
  const fallbacks = [], lost = [];
  list.forEach((t, i) => {
    const fn = t.function;
    const schema = clone(fn.parameters || { type: 'object', properties: {} });
    const head = '- ' + fn.name + (fn.description ? ': ' + String(fn.description).trim() : '') + '\n  parameters: ';
    if (on[i].line.indexOf(head) !== 0) { lost.push(fn.name + ': the name or description changed'); return; }
    const text = paramsOf(on[i].line);
    jsonBytes += bytes(paramsOf(off[i].line)); onBytes += bytes(text);
    if (on[i].line === off[i].line) {   // the JSON fallback: today's line
      if (!Sig.why(schema)) lost.push(fn.name + ': kept its JSON though the notation can say it');
      fallbacks.push(fn.name);
      return;
    }
    let back = null;
    try { back = Sig.parse(text); } catch (e) { lost.push(fn.name + ': the signature does not parse (' + e.message + ')'); return; }
    if (!Sig.same(Sig.canonical(back), Sig.canonical(schema))) lost.push(fn.name + ': the signature reads back as another schema');
    const want = facts(schema), got = facts(back);
    for (const f of want) if (got.indexOf(f) < 0) lost.push(fn.name + ': lost ' + f);
    for (const f of got) if (want.indexOf(f) < 0) lost.push(fn.name + ': invented ' + f);
    for (const d of descriptions(schema)) if (text.indexOf('/* ' + d + ' */') < 0) lost.push(fn.name + ': a description is not verbatim: ' + d.slice(0, 60));
    if (bytes(text) >= bytes(paramsOf(off[i].line))) lost.push(fn.name + ': the signature is not shorter than its JSON');
  });
  A.eq(lost, [], label + ': every tool\'s signature reads back as its JSON Schema (fields, types, enum values, required flags, defaults, limits, descriptions), or the tool kept its JSON');
  return { jsonBytes, onBytes, fallbacks, off, on };
}
{
  const r = checkAll(catalog, 'ON, the catalogue');
  const lineBytes = lines => lines.reduce((n, l) => n + bytes(l.line) + 1, 0);
  console.log('[compact-tools] catalogue: ' + catalog.length + ' tools | parameters ' + r.jsonBytes + ' -> ' + r.onBytes + ' bytes (-' + (100 * (1 - r.onBytes / r.jsonBytes)).toFixed(1) + '%) | tool lines '
    + lineBytes(r.off) + ' -> ' + lineBytes(r.on) + ' bytes | kept their JSON: ' + (r.fallbacks.join(', ') || 'none'));
  A.ok(r.fallbacks.length <= catalog.length * 0.05, 'ON: nearly every station tool has a signature (' + r.fallbacks.length + ' of ' + catalog.length + ' keep their JSON: ' + r.fallbacks.join(', ') + ')');
  A.ok(r.onBytes <= r.jsonBytes * 0.7, 'ON: the catalogue\'s parameter text is at least 30% smaller (' + r.jsonBytes + ' -> ' + r.onBytes + ')');
  for (const name of r.fallbacks) A.ok(/additionalProperties/.test(Sig.why(clone(catalog.find(t => t.function.name === name).function.parameters))), 'ON: ' + name + ' keeps its JSON for a stated reason (' + Sig.why(clone(catalog.find(t => t.function.name === name).function.parameters)) + ')');
}

// ---- C. the notation, on the fixed list -----------------------------------------------------------------------------------
{
  const r = checkAll(FIXED, 'ON, the fixed list');
  const p = name => paramsOf(r.on[FIXED.findIndex(t => t.function.name === name)].line);
  A.eq(p('fs_write'), '{path: string /* Workspace-relative path. */, content: string, overwrite?: boolean = false}', 'required and optional fields, a description verbatim, a default, in the schema\'s own order');
  A.eq(p('browser_intercept'), '{kinds: ("image"|"media"|"font"|"stylesheet")[]}', 'an array of enums is parenthesized: ("a"|"b")[], never "a"|"b"[]');
  A.eq(p('skill_list'), '{query?: string, offset?: integer<minimum=0>, limit?: integer<minimum=1,maximum=100> = 20}', 'limits ride as <key=value>, before the default');
  A.eq(p('routine_create'), '{prompt: string, repeatTimes?: integer|null /* null = forever. */, deliver?: "local"|"origin" = "local" /* origin returns each result to this chat. */, skills?: string[]<maxItems=8>, '
    + 'steps?: {name: string, args?: object|string, tags?: (string<maxLength=40>)[]}[]}', 'a type list, an enum with a default and a description, an array limit, an array of objects, an item with its own limit');
  A.eq(p('app_publish'), '{key: string, value: any /* any JSON value */, meta?: object, rows?: array, look?: any}', 'a field with no type is any; an object or array with nothing declared is the bare word');
  A.eq(p('no_params'), '{}', 'a tool with no parameters is {}');
  A.eq(r.fallbacks, ['code_run', 'mcp_search'], 'root additionalProperties:false and anyOf keep their JSON');
  A.eq(r.on[6].line, baseLine(FIXED[6].function), 'a tool that keeps its JSON has today\'s line, byte for byte');
  // byte-stable: a pure function of the schema
  A.eq(_internals.toolsPrompt(FIXED, true), _internals.toolsPrompt(clone(FIXED), true), 'ON: the same schemas give the same bytes (a fresh copy, a second call)');
  A.eq(Sig.render(clone(FIXED[3].function.parameters)), p('routine_create'), 'ON: the renderer itself is byte-stable');
  const reordered = clone(FIXED[0]); reordered.function.parameters.properties = { content: { type: 'string' }, path: { type: 'string', description: 'Workspace-relative path.' }, overwrite: { type: 'boolean', default: false } };
  A.eq(paramsOf(_internals.toolLines([reordered], true)[0].line), '{content: string, path: string /* Workspace-relative path. */, overwrite?: boolean = false}', 'ON: fields keep the order the schema declares them in (as JSON does)');
}

// ---- D. what the notation cannot say exactly keeps its JSON -------------------------------------------------------------
{
  const obj = (properties, extra) => Object.assign({ type: 'object', properties }, extra || {});
  const CANNOT = {
    'anyOf': obj({ q: { anyOf: [{ type: 'string' }, { type: 'number' }] } }),
    'oneOf': obj({ q: { oneOf: [{ type: 'string' }, { type: 'null' }] } }),
    'allOf': obj({ q: { allOf: [{ type: 'string' }, { minLength: 2 }] } }),
    'not': obj({ q: { not: { type: 'string' } } }),
    '$ref': obj({ q: { $ref: '#/$defs/thing' } }, { $defs: { thing: { type: 'string' } } }),
    'a nested $ref': obj({ list: { type: 'array', items: { $ref: '#/definitions/row' } } }),
    'patternProperties': obj({ map: { type: 'object', patternProperties: { '^x-': { type: 'string' } } } }),
    'const': obj({ kind: { const: 'page' } }),
    'root additionalProperties:false': obj({ q: { type: 'string' } }, { additionalProperties: false }),
    'root additionalProperties:true': obj({ q: { type: 'string' } }, { additionalProperties: true }),
    'nested additionalProperties': obj({ headers: { type: 'object', additionalProperties: { type: 'string' } } }),
    'a tuple': obj({ pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } }),
    'prefixItems': obj({ pair: { type: 'array', prefixItems: [{ type: 'string' }] } }),
    'a non-string enum': obj({ n: { type: 'integer', enum: [1, 2, 3] } }),
    'an enum with no type': obj({ mode: { enum: ['a', 'b'] } }),
    'a mixed enum': obj({ mode: { type: ['string', 'null'], enum: ['a', null] } }),
    'a one-entry type list': obj({ q: { type: ['string'] } }),
    'nullable': obj({ q: { type: 'string', nullable: true } }),
    'title': obj({ q: { type: 'string', title: 'Query' } }),
    'examples': obj({ q: { type: 'string', examples: ['cats'] } }),
    'a root keyword it does not know': obj({ q: { type: 'string' } }, { $schema: 'http://json-schema.org/draft-07/schema#' }),
    'a field name with a space': obj({ 'my field': { type: 'string' } }),
    'a field name with a quote': obj({ 'a"b': { type: 'string' } }),
    'a description with a line break': obj({ q: { type: 'string', description: 'first line\nsecond line' } }),
    'a description that closes a comment': obj({ q: { type: 'string', description: 'use a */ here' } }),
    'a description that is not text': obj({ q: { type: 'string', description: 7 } }),
    'required naming an undeclared field': obj({ q: { type: 'string' } }, { required: ['q', 'ghost'] }),
    'properties with no type': { properties: { q: { type: 'string' } } },
    'a root that is not an object': { type: 'string' },
    'an object with no declared fields at the root': { type: 'object' },
    'a type it does not know': obj({ q: { type: 'date' } }),
    'if/then': obj({ q: { type: 'string' } }, { if: { required: ['q'] }, then: { required: ['q'] } }),
    'dependentRequired': obj({ a: { type: 'string' }, b: { type: 'string' } }, { dependentRequired: { a: ['b'] } })
  };
  for (const name of Object.keys(CANNOT)) {
    const t = tool('mcp_tool', 'An MCP tool.', CANNOT[name]);
    A.eq(Sig.render(clone(CANNOT[name])), null, 'cannot say ' + name + ': no signature');
    A.ok(!!Sig.why(clone(CANNOT[name])), 'cannot say ' + name + ': and the reason is stated');
    A.eq(_internals.toolLines([t], true)[0].line, baseLine(t.function), 'cannot say ' + name + ': the tool\'s line is today\'s JSON, byte for byte');
  }
  // one tool that cannot never changes its neighbours
  const mixed = [FIXED[0], tool('mcp_tool', 'An MCP tool.', CANNOT.anyOf), FIXED[1]];
  const on = _internals.toolLines(mixed, true);
  A.eq([on[0].line === baseLine(mixed[0].function), on[1].line === baseLine(mixed[1].function), on[2].line === baseLine(mixed[2].function)], [false, true, false], 'the fallback is per tool: its neighbours still get signatures');
  // text render() could not have written is refused by parse(), never guessed at
  for (const bad of ['{a: string', '{a: strng}', '{a: string} trailing', '{a: "x"|1}', '{a: string<maxWidth=1>}', '{a: string, a: number}', 'string|"a"'])
    A.throws(() => Sig.parse(bad), 'parse refuses ' + JSON.stringify(bad));
}

// ---- E. the call format the model is told to write, and how it is told to read a signature -------------------------------
{
  const off = _internals.toolsPrompt(FIXED), on = _internals.toolsPrompt(FIXED, true);
  const head = CALL_FORMAT.join('\n') + '\n';
  A.ok(off.indexOf(head) === 0 && on.indexOf(head) === 0, 'ON: the call format and its rules (<function_calls>, <invoke>, raw strings, JSON for the rest) are the same lines, in the same place');
  A.eq(on, head + Sig.LEGEND + '\n\nAvailable tools:\n' + _internals.toolLines(FIXED, true).map(t => t.line).join('\n'), 'ON: the only other change is the legend, between the rules and the list');
  A.eq(off.indexOf(Sig.LEGEND), -1, 'OFF: no legend');
  for (const [what, re] of [['what ? means', /"\?" after a name marks an optional parameter; every other parameter is required/], ['that quoted values are raw strings', /They are strings: write the one you pick raw, without the quotes/],
    ['arrays and objects', /T\[\] is an array of T, \{\.\.\.\} an object with those fields/], ['limits, defaults and descriptions', /<minimum=0,maxItems=8> after a type gives its limits, "= value" its default, and \/\* \.\.\. \*\/ is the parameter's description/],
    ['that a JSON Schema line can still appear', /A parameters line that starts with \{"type": is that tool's JSON Schema/]])
    A.ok(re.test(Sig.LEGEND), 'the legend says ' + what);
  // the legend's own example is a signature the parser reads
  const example = /such as (\{[^}]*\}):/.exec(Sig.LEGEND);
  A.ok(example && Sig.same(Sig.canonical(Sig.parse(example[1])), Sig.canonical({ type: 'object', required: ['path'], properties: { path: { type: 'string' }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['fast', 'full'] } } })),
    'the legend\'s example is itself a valid signature');
}

// ---- F. through the adapter: the system prompt file, and a tool reveal ---------------------------------------------------
function fakeCli(script) {
  const spawns = [], files = [];
  function spawn(file, args) {
    const child = new EventEmitter();
    const pipe = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = pipe(); child.stderr = pipe(); child.pid = 9000 + spawns.length; child.exitCode = null;
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    child.kill = () => exit(null);
    if (file === 'taskkill') { setImmediate(() => exit(0)); return child; }
    const rec = { args, inputs: [] }; spawns.push(rec);
    const emit = l => { if (child.exitCode == null) child.stdout.emit('data', JSON.stringify(l) + '\n'); };
    const answer = n => setImmediate(() => { if (child.exitCode == null) for (const l of script(n)) emit(l); });
    child.stdin = { on() {}, write(line) { rec.inputs.push(JSON.parse(line)); answer(rec.inputs.length); return true; },
      end(text) { if (text) { rec.inputs.push(JSON.parse(text)); setImmediate(() => { for (const l of script(1)) emit(l); exit(0); }); } else setImmediate(() => exit(0)); } };
    return child;
  }
  const fs = { statSync() { return { isFile: () => true }; }, writeFileSync(p, text) { files.push(String(text)); }, unlinkSync() {} };
  return { spawn, spawns, files, fs };
}
const init = { type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] };
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const result = text => ({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } });
const collect = async (p, req) => { const out = []; for await (const e of p.stream(req)) out.push(e); return out; };
const inputText = msg => (msg.message ? msg.message.content : []).filter(b => b.type === 'text').map(b => b.text).join('');

(async () => {
  // one-shot: the file the CLI is handed
  const fileFor = async extra => {
    const f = fakeCli(() => [init, delta('ok'), result('ok')]);
    const p = makeClaudeCliProvider(Object.assign({ spawn: f.spawn, fs: f.fs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux', persist: false }, extra || {}));
    await collect(p, { model: 'claude-sonnet-5-5', messages: MESSAGES, tools: FIXED });
    A.eq(f.files.length, 1, 'fixture: one system prompt file was written');
    return { file: f.files[0], args: f.spawns[0].args.filter(a => !/starnet-claude-cli-/.test(a)) };
  };
  const unset = await fileFor(), off = await fileFor({ compactTools: false }), on = await fileFor({ compactTools: true });
  A.eq(sha(unset.file), GOLDEN_OFF.system, 'adapter, switch unset: the system prompt file is the base commit\'s, byte for byte');
  A.eq(off.file, unset.file, 'adapter, switch off: the same file');
  A.eq(on.args, unset.args, 'adapter, switch on: the CLI is started with the same arguments');
  A.eq(on.file, unset.file.replace(baseSection(FIXED), _internals.toolsPrompt(FIXED, true)), 'adapter, switch on: only the tools section differs');
  A.ok(bytes(on.file) < bytes(unset.file), 'adapter, switch on: the file is smaller (' + bytes(unset.file) + ' -> ' + bytes(on.file) + ' bytes; the legend is ' + bytes(Sig.LEGEND) + ' of them)');
  for (const truthy of ['1', 1, 'true', {}]) A.eq((await fileFor({ compactTools: truthy })).file, unset.file, 'adapter: only compactTools === true turns it on (' + JSON.stringify(truthy) + ' does not)');

  // a call is read with the real schema, whatever the text said: a string stays raw, a number parses
  {
    const call = '<function_calls>\n<invoke name="skill_list">\n<parameter name="query">"quoted" text</parameter>\n<parameter name="limit">5</parameter>\n</invoke>\n</function_calls>';
    const f = fakeCli(() => [init, delta(call), result(call)]);
    const p = makeClaudeCliProvider({ spawn: f.spawn, fs: f.fs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux', persist: false, compactTools: true });
    const ev = await collect(p, { model: 'claude-sonnet-5-5', messages: MESSAGES, tools: FIXED });
    A.eq(JSON.parse(ev.filter(e => e.type === 'tool_args').map(e => e.chunk).join('')), { query: '"quoted" text', limit: 5 }, 'ON: arguments are still coerced from the real schema (a string raw, an integer as a number)');
  }

  // the persistent child: a tool revealed mid-run is announced in the same form the child's list is in
  for (const compact of [false, true]) {
    const call = '<function_calls>\n<invoke name="fs_write">\n<parameter name="path">a.txt</parameter>\n<parameter name="content">x</parameter>\n</invoke>\n</function_calls>';
    const f = fakeCli(n => n === 1 ? [init, delta(call), result(call)] : [delta('done'), result('done')]);
    const p = makeClaudeCliProvider({ spawn: f.spawn, fs: f.fs, bin: 'claude.exe', env: { PATH: '' }, platform: 'win32', persistEndGraceMs: 200, compactTools: compact });
    const ac = new AbortController();
    const first = [FIXED[0]], grown = [FIXED[0], FIXED[2]];
    const t1 = await collect(p, { model: 'sonnet', tools: first, messages: MESSAGES.slice(), runId: 'run-reveal', signal: ac.signal });
    const id = (t1.find(e => e.type === 'tool_start') || {}).id;
    const msgs = MESSAGES.concat([{ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'fs_write', arguments: t1.filter(e => e.type === 'tool_args').map(e => e.chunk).join('') } }] },
      { role: 'tool', tool_call_id: id, content: 'written' }]);
    await collect(p, { model: 'sonnet', tools: grown, messages: msgs, runId: 'run-reveal', signal: ac.signal });
    const label = compact ? 'ON' : 'OFF';
    A.eq(f.spawns.length, 1, label + ', persistent child: a reveal rides the live child');
    A.ok(f.files[0].indexOf(_internals.toolsPrompt(first, compact)) >= 0, label + ', persistent child: its system prompt lists the run-start tools in this form');
    A.ok(inputText(f.spawns[0].inputs[1]).indexOf('More tools are now available. Call them exactly like the tools listed in your instructions:\n' + _internals.toolLines([FIXED[2]], compact)[0].line) >= 0,
      label + ', persistent child: the revealed tool is announced in the same form');
    p.release('run-reveal'); ac.abort();
  }

  A.report('claude-cli-compact-tools.test');
})().catch(e => { console.error(e); process.exit(1); });
