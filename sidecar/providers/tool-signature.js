/* sidecar/providers/tool-signature.js — a tool's parameters as a compact signature (cost audit W2.2), and its exact inverse.

   WHY. On the Claude sign-in route the tools ride as text inside the CLI system prompt (claude-cli.js toolLines), each
   one as its whole JSON Schema: {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}. Most of
   those bytes are JSON punctuation and the words "type", "properties" and "required". A signature says the same thing:
   {path: string}.

   A RE-RENDERING, NEVER A TRIM. render() returns a signature only when parse() reads it back as the same schema: every
   field, type, enum value, required flag, default, limit and description. A schema that uses anything this notation
   cannot say exactly (anyOf, oneOf, allOf, not, $ref, const, patternProperties, additionalProperties, a tuple, a
   non-string enum, a keyword this file does not know) makes render() return null, and the caller sends that tool's JSON
   Schema as before. The whitelist is the safety: an unknown keyword is never dropped, it turns the compact form off for
   that tool. Byte-stable: the output is a pure function of the schema (its own key order kept, as JSON.stringify keeps it).

   THE NOTATION (one line per tool)
     {name: type, other?: type}       an object and its fields; "?" marks an optional field, every other one is required
     string number integer boolean null object array any
                                       a JSON Schema type; object / array = one with no fields / items declared; any = no type
     "a"|"b"                           a string enum (JSON string literals)
     string|null                       a type list
     T[]  ("a"|"b")[]  (string|null)[] an array of T; an item that is more than one word or object is parenthesized
     type<minimum=0,maximum=100>       JSON Schema limits, values as JSON
     type = value                      the default, as JSON
     type (slash-star) text (star-slash)   the description, verbatim, as a block comment

     render(schema) -> string | null          null = cannot be said exactly: send the JSON Schema
     why(schema)    -> '' | the reason render() returns null (tests, diagnostics)
     parse(text)    -> schema                 the inverse; throws on text render() could not have written
     canonical(schema) -> the schema with object keys sorted, `required` sorted and dropped when empty, and an empty
                          description dropped: the form two schemas are compared in
     LEGEND                                   the lines that tell the model how to read a signature

   Pure, no dependencies. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).toolSignature = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PRIMITIVES = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'];
  // JSON Schema limits a node may carry; each rides as <key=json>. Anything else that is not structural is unknown.
  const FACETS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format',
    'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'];
  const STRUCTURAL = ['type', 'description', 'default', 'enum', 'properties', 'required', 'items'];
  const KEY_RE = /^[A-Za-z_$][\w$-]*$/;
  const UNQUOTABLE = new RegExp('[\r\n\u2028\u2029]');   // a line break inside a description would split the tool's one line
  const NAME_RE = /^[a-z]+/;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  class Unsayable extends Error {}
  const no = why => { throw new Unsayable(why); };

  // a JSON value that survives JSON.stringify -> JSON.parse unchanged (a default, a limit)
  function jsonOf(v, what) {
    if (v === undefined) no(what + ' is undefined');
    let s;
    try { s = JSON.stringify(v); } catch (_) { no(what + ' is not JSON'); }
    if (typeof s !== 'string') no(what + ' is not JSON');
    if (JSON.stringify(JSON.parse(s)) !== s) no(what + ' does not survive JSON');
    return s;
  }

  // one schema node -> { core, tail, simple }: core = the type expression, tail = its limits, default and description,
  // simple = it can be an array's item without parentheses
  function node(s, at) {
    if (!isObj(s)) no(at + ' is not a schema object');
    for (const k of Object.keys(s)) if (STRUCTURAL.indexOf(k) < 0 && FACETS.indexOf(k) < 0) no(at + ' uses ' + k);
    let core, bare = false;
    const t = s.type;
    const structural = has(s, 'properties') || has(s, 'required') || has(s, 'items');
    if (has(s, 'enum')) {
      if (t !== 'string' || structural) no(at + ' has an enum that is not a plain string enum');
      if (!Array.isArray(s.enum) || !s.enum.length || s.enum.some(v => typeof v !== 'string')) no(at + ' has a non-string enum value');
      if (new Set(s.enum).size !== s.enum.length) no(at + ' repeats an enum value');
      if (FACETS.some(k => has(s, k))) no(at + ' has limits on an enum');
      core = s.enum.map(v => JSON.stringify(v)).join('|');
    } else if (Array.isArray(t)) {
      if (t.length < 2 || t.some(x => PRIMITIVES.indexOf(x) < 0) || new Set(t).size !== t.length) no(at + ' has a type list this notation cannot say');
      if (structural || FACETS.some(k => has(s, k))) no(at + ' has fields, items or limits on a type list');
      core = t.join('|');
    } else if (t === 'object') {
      if (has(s, 'items')) no(at + ' is an object with items');
      if (!has(s, 'properties')) {
        if (has(s, 'required')) no(at + ' requires fields it does not declare');
        core = 'object'; bare = true;
      } else {
        if (!isObj(s.properties)) no(at + ' has properties that are not an object');
        const req = has(s, 'required') ? s.required : [];
        if (!Array.isArray(req) || req.some(r => typeof r !== 'string' || !has(s.properties, r)) || new Set(req).size !== req.length) no(at + ' has a required list that does not match its fields');
        const fields = [];
        for (const k of Object.keys(s.properties)) {
          if (!KEY_RE.test(k) || k === '__proto__') no(at + ' has a field name this notation cannot say: ' + JSON.stringify(k));
          const f = node(s.properties[k], at + '.' + k);
          fields.push(k + (req.indexOf(k) >= 0 ? '' : '?') + ': ' + f.core + f.tail);
        }
        core = '{' + fields.join(', ') + '}'; bare = true;
      }
    } else if (t === 'array') {
      if (has(s, 'properties') || has(s, 'required')) no(at + ' is an array with fields');
      if (!has(s, 'items')) { core = 'array'; bare = true; }
      else {
        if (!isObj(s.items)) no(at + ' has items that are not one schema');
        const it = node(s.items, at + '[]');
        core = (it.simple ? it.core : '(' + it.core + it.tail + ')') + '[]'; bare = true;
      }
    } else if (typeof t === 'string') {
      if (PRIMITIVES.indexOf(t) < 0 || structural) no(at + ' has a type this notation cannot say');
      core = t; bare = true;
    } else {
      if (has(s, 'type') || structural || FACETS.some(k => has(s, k))) no(at + ' has no usable type');
      core = 'any'; bare = true;
    }
    let tail = '';
    const limits = Object.keys(s).filter(k => FACETS.indexOf(k) >= 0);
    if (limits.length) tail += '<' + limits.map(k => k + '=' + jsonOf(s[k], at + ' ' + k)).join(',') + '>';
    if (has(s, 'default')) tail += ' = ' + jsonOf(s.default, at + ' default');
    if (has(s, 'description')) {
      const d = s.description;
      if (typeof d !== 'string') no(at + ' has a description that is not text');
      if (d.indexOf('*/') >= 0 || UNQUOTABLE.test(d)) no(at + ' has a description this notation cannot quote');
      if (d) tail += ' /* ' + d + ' */';
    }
    return { core, tail, simple: bare && !tail };
  }

  // -> { text } or { why }: the signature, or the reason this schema keeps its JSON
  function attempt(schema) {
    try {
      if (!isObj(schema) || schema.type !== 'object' || !has(schema, 'properties')) return { why: 'parameters is not an object with declared fields' };
      const n = node(schema, 'parameters');
      const text = n.core + n.tail;
      // the proof travels with the output: what this text parses back to is the schema it was rendered from
      return same(canonical(parse(text)), canonical(schema)) ? { text } : { why: 'the signature does not read back as the schema' };
    } catch (e) {
      if (e instanceof Unsayable || e instanceof SyntaxError) return { why: e.message || 'unsayable' };
      throw e;
    }
  }
  function render(schema) { const r = attempt(schema); return typeof r.text === 'string' ? r.text : null; }
  function why(schema) { return attempt(schema).why || ''; }

  // ---- the inverse ---------------------------------------------------------------------------------------------------
  function parse(text) {
    const src = String(text);
    let i = 0;
    const fail = what => { throw new SyntaxError('tool signature: ' + what + ' at ' + i + ': ' + JSON.stringify(src.slice(Math.max(0, i - 20), i + 20))); };
    const eat = lit => { if (src.startsWith(lit, i)) { i += lit.length; return true; } return false; };
    const need = lit => { if (!eat(lit)) fail('expected ' + JSON.stringify(lit)); };
    // one JSON value starting at i: a string, or the longest run a balanced scan finds, handed to JSON.parse
    function json() {
      const from = i;
      if (src[i] === '"') {
        i++;
        while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
        if (src[i] !== '"') fail('unterminated string');
        i++;
      } else if (src[i] === '{' || src[i] === '[') {
        let depth = 0;
        for (; i < src.length; i++) {
          const c = src[i];
          if (c === '"') { i++; while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1; }
          else if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') { depth--; if (!depth) { i++; break; } }
        }
      } else {
        const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i));
        if (!m) fail('expected a JSON value');
        i += m[0].length;
      }
      try { return JSON.parse(src.slice(from, i)); } catch (_) { return fail('bad JSON value'); }
    }
    function fields() {
      const out = { type: 'object', properties: {} };
      const required = [];
      if (eat('}')) return out;
      for (;;) {
        const m = /^[A-Za-z_$][\w$-]*/.exec(src.slice(i));
        if (!m) fail('expected a field name');
        const key = m[0];
        i += key.length;
        if (has(out.properties, key)) fail('repeated field ' + key);
        const optional = eat('?');
        need(': ');
        out.properties[key] = nodeAt();
        if (!optional) required.push(key);
        if (eat('}')) break;
        need(', ');
      }
      if (required.length) out.required = required;
      return out;
    }
    function primary() {
      if (eat('{')) return fields();
      if (eat('(')) { const inner = nodeAt(); need(')'); return inner; }
      if (src[i] === '"') {
        const values = [json()];
        while (src[i] === '|' && src[i + 1] === '"') { i++; values.push(json()); }
        if (values.some(v => typeof v !== 'string')) fail('a non-string enum value');
        return { type: 'string', enum: values };
      }
      const names = [];
      for (;;) {
        const m = NAME_RE.exec(src.slice(i));
        if (!m) fail('expected a type');
        names.push(m[0]);
        i += m[0].length;
        if (!eat('|')) break;
      }
      if (names.length === 1) {
        if (names[0] === 'any') return {};
        if (PRIMITIVES.indexOf(names[0]) < 0) fail('unknown type ' + names[0]);
        return { type: names[0] };
      }
      if (names.some(n => PRIMITIVES.indexOf(n) < 0)) fail('unknown type in a type list');
      return { type: names };
    }
    function nodeAt() {
      let s = primary();
      while (eat('[]')) s = { type: 'array', items: s };
      if (eat('<')) {
        for (;;) {
          const m = /^[A-Za-z]+/.exec(src.slice(i));
          if (!m || FACETS.indexOf(m[0]) < 0) fail('unknown limit');
          i += m[0].length;
          need('=');
          if (has(s, m[0])) fail('repeated limit');
          s[m[0]] = json();
          if (eat('>')) break;
          need(',');
        }
      }
      if (eat(' = ')) s.default = json();
      if (eat(' /* ')) {
        const end = src.indexOf(' */', i);
        if (end < 0) fail('unterminated description');
        s.description = src.slice(i, end);
        i = end + 3;
      }
      return s;
    }
    const out = nodeAt();
    if (i !== src.length) fail('text after the signature');
    return out;
  }

  // the form two schemas are compared in (key order, an empty required list and an empty description say nothing)
  function canonical(s) {
    if (Array.isArray(s)) return s.map(canonical);
    if (!isObj(s)) return s;
    const out = {};
    for (const k of Object.keys(s).sort()) {
      if (k === 'required' && Array.isArray(s[k])) { if (s[k].length) out[k] = s[k].slice().sort(); continue; }
      if (k === 'description' && s[k] === '') continue;
      if (k === 'properties' && isObj(s[k])) {   // field names are data, not keywords: each value is a schema
        out[k] = {};
        for (const f of Object.keys(s[k]).sort()) out[k][f] = canonical(s[k][f]);
        continue;
      }
      // a default, a limit and an enum are values: kept as they are
      out[k] = (k === 'items') ? canonical(s[k]) : s[k];
    }
    return out;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // How the model is told to read a signature (claude-cli.js toolsPromptOf puts it above the tool list).
  const LEGEND = [
    'Each tool lists its parameters as a signature such as {path: string, limit?: integer, mode?: "fast"|"full"}:',
    '- A "?" after a name marks an optional parameter; every other parameter is required.',
    '- Types are string, number, integer, boolean, null, object, array and any; T[] is an array of T, {...} an object with those fields, and A|B either type.',
    '- Quoted values such as "fast"|"full" are the only values allowed. They are strings: write the one you pick raw, without the quotes.',
    '- <minimum=0,maxItems=8> after a type gives its limits, "= value" its default, and /* ... */ is the parameter\'s description.',
    '- A parameters line that starts with {"type": is that tool\'s JSON Schema, read the usual way.'
  ].join('\n');

  return { render, why, parse, canonical, same, LEGEND, FACETS };
});
