/* sidecar/providers/toolschema.js — make a tool's JSON Schema safe for a strict provider wire.

   WHY THIS EXISTS: built-in StarNet tools hand-write small, tame schemas, but an MCP connector's
   `inputSchema` is authored by a third-party server. The official MCP TypeScript SDK builds schemas
   with zod-to-json-schema, so a real connector routinely ships `$schema`, `additionalProperties`,
   `$ref`/`$defs`, `anyOf` null-unions and `default` — all of which flow through mcp/translate.js and
   tools/registry.js `wireFormat()` verbatim. Gemini's functionDeclarations accepts only an
   OpenAPI-3.0 Schema subset and answers an unknown field with a 400 on EVERY turn, so one connector
   could take out every Gemini run. Anthropic is lenient about extra keywords but rejects a
   null-union at the root of `input_schema`.

   Two exports, one shared normalizer:
     normalize(schema)  -> repair hostile-but-standard shapes; keeps every other keyword.
                           Semantics-preserving for a well-formed schema. Used on the Anthropic wire.
     forGemini(schema)  -> normalize(), then prune to Gemini's documented Schema field set.

   Both are PURE and never mutate the input — a registry tool def is shared across runs and providers,
   so mutating it would corrupt the next request on a different adapter.

   Wire-grammar helpers (2026-09-22, see the sections at the bottom): sanitizeKeys()/restoreArgumentKeys()
   (property names every wire accepts, and the model's args mapped back to the declared names), and
   forMoonshot()/isMoonshotRoute() (the Kimi dialect, applied only on Kimi/Moonshot routes).

   Repairs performed by normalize():
     - local `$ref` (#/$defs/…, #/definitions/…, #/components/schemas/…) inlined from the root doc
     - nullable unions collapsed: {anyOf:[X,{type:'null'}]} -> X + nullable:true   (the Pydantic/zod shape)
     - `oneOf` -> `anyOf`; single-member `allOf` inlined
     - array `type` (["string","null"]) -> one string type + nullable
     - `const: X` -> `enum: [X]`
     - `required` filtered to names that actually exist in `properties`
   Cycles and runaway depth resolve to a permissive string node rather than throwing — a malformed
   schema must degrade the ONE tool, never wedge the run. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).toolschema = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  // https://ai.google.dev/api/caching#Schema — the complete documented field set. Anything else
  // ("$schema", "additionalProperties", "$ref", "oneOf", "allOf", "const", "patternProperties",
  // "exclusiveMinimum", "multipleOf", "uniqueItems", "not", "if"/"then", "$defs", …) is an
  // "Unknown name" 400 from generativelanguage.googleapis.com.
  // `default` is documented but was a LATE addition to the subset, and a Gemini profile may carry a
  // custom baseUrl (proxy / older endpoint), so it is deliberately NOT on this list — the field is
  // advisory, never affects validation, and dropping it costs the model nothing a description can't say.
  const GEMINI_FIELDS = ['type', 'format', 'title', 'description', 'nullable', 'enum', 'items',
    'properties', 'required', 'propertyOrdering', 'example', 'anyOf',
    'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength',
    'minProperties', 'maxProperties', 'pattern'];

  const MAX_DEPTH = 24;                 // runaway/cyclic guard; real tool schemas nest <6
  const PERMISSIVE = { type: 'string' };  // what an unresolvable node degrades to

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* Walk a local JSON-Pointer ("#/$defs/Foo") from the root document. Returns undefined for a
     remote/absolute ref — we never fetch, so a remote $ref degrades instead of hanging a run. */
  function pointerLookup(rootDoc, ref) {
    const s = String(ref || '');
    if (s.charAt(0) !== '#') return undefined;
    const parts = s.slice(1).split('/').filter(Boolean);
    let node = rootDoc;
    for (const raw of parts) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');   // RFC 6901 unescaping
      if (!isPlainObject(node) || !(key in node)) return undefined;
      node = node[key];
    }
    return isPlainObject(node) ? node : undefined;
  }

  /* Collapse a union down to a single branch when the union exists only to allow null — by far the
     most common MCP/Pydantic shape ({"anyOf":[{"type":"string"},{"type":"null"}]}). A genuine
     multi-type union is left alone as `anyOf`, which Gemini does support. */
  function collapseNullUnion(list) {
    const branches = list.filter(isPlainObject);
    const nonNull = branches.filter(b => b.type !== 'null');
    if (nonNull.length === branches.length) return { branches: branches, nullable: false };
    return { branches: nonNull, nullable: true };
  }

  function walk(node, rootDoc, depth, refPath) {
    if (depth > MAX_DEPTH) return Object.assign({}, PERMISSIVE);
    if (!isPlainObject(node)) return Object.assign({}, PERMISSIVE);   // e.g. additionalProperties:"object"

    // ---- $ref: inline from the root document, guarding against a self-referential chain ----------
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (refPath.indexOf(ref) >= 0) return Object.assign({}, PERMISSIVE);   // cycle
      const target = pointerLookup(rootDoc, ref);
      if (!target) {
        const rest = Object.assign({}, node); delete rest.$ref;
        return Object.keys(rest).length ? walk(rest, rootDoc, depth + 1, refPath) : Object.assign({}, PERMISSIVE);
      }
      // Sibling keywords next to $ref (the `{"$ref":…, "default":null}` shape strict validators
      // reject) are merged onto the resolved target, with the target's own fields winning.
      const merged = Object.assign({}, node, target); delete merged.$ref;
      return walk(merged, rootDoc, depth + 1, refPath.concat([ref]));
    }

    const out = {};
    let nullable = node.nullable === true;

    for (const key of Object.keys(node)) {
      const val = node[key];
      switch (key) {
        case '$defs': case 'definitions':
          break;                                  // inlined at every use site; the bag itself is not a schema
        case 'nullable':
          break;                                  // folded in below so a union can also set it
        case 'const':
          out.enum = [val];                       // Gemini has no `const`; a 1-member enum is exact
          if (out.type === undefined && val !== null) out.type = typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string';
          break;
        case 'type':
          if (Array.isArray(val)) {               // ["string","null"] -> string + nullable
            const types = val.map(String).filter(t => t !== 'null');
            if (types.length !== val.length) nullable = true;
            out.type = types.length ? types[0] : 'string';
          } else if (val === 'null') {
            out.type = 'string'; nullable = true;
          } else if (val !== undefined) {
            out.type = val;
          }
          break;
        case 'properties': {
          if (!isPlainObject(val)) break;
          const props = {};
          for (const p of Object.keys(val)) props[p] = walk(val[p], rootDoc, depth + 1, refPath);
          out.properties = props;
          break;
        }
        case 'items':
          out.items = Array.isArray(val)
            ? walk(val[0], rootDoc, depth + 1, refPath)   // tuple typing has no Gemini equivalent
            : walk(val, rootDoc, depth + 1, refPath);
          break;
        case 'anyOf': case 'oneOf': {
          if (!Array.isArray(val) || !val.length) break;
          const c = collapseNullUnion(val);
          if (c.nullable) nullable = true;
          if (c.branches.length === 1) {                 // the nullable-optional case: inline the branch
            const only = walk(c.branches[0], rootDoc, depth + 1, refPath);
            for (const k of Object.keys(only)) if (out[k] === undefined) out[k] = only[k];
          } else if (c.branches.length) {
            out.anyOf = c.branches.map(b => walk(b, rootDoc, depth + 1, refPath));
          }
          break;
        }
        case 'allOf': {
          if (!Array.isArray(val) || !val.length) break;
          const merged = {};                              // shallow intersection is the honest approximation
          for (const m of val) if (isPlainObject(m)) Object.assign(merged, walk(m, rootDoc, depth + 1, refPath));
          for (const k of Object.keys(merged)) if (out[k] === undefined) out[k] = merged[k];
          break;
        }
        case 'additionalProperties':
          if (isPlainObject(val)) out.additionalProperties = walk(val, rootDoc, depth + 1, refPath);
          else if (val !== undefined) out.additionalProperties = val;   // normalize() keeps it; forGemini prunes it
          break;
        default:
          out[key] = val;
      }
    }

    if (nullable) out.nullable = true;
    // `required` naming a property that does not exist is an invalid schema some backends reject.
    if (Array.isArray(out.required)) {
      const known = isPlainObject(out.properties) ? out.properties : null;
      const kept = out.required.map(String).filter(r => !known || Object.prototype.hasOwnProperty.call(known, r));
      if (kept.length) out.required = kept; else delete out.required;
    }
    return out;
  }

  /* Repair hostile-but-standard constructs; every other keyword survives. */
  function normalize(schema) {
    if (!isPlainObject(schema)) return { type: 'object', properties: {} };
    return walk(schema, schema, 0, []);
  }

  function prune(node, depth) {
    if (!isPlainObject(node) || depth > MAX_DEPTH) return node;
    const out = {};
    for (const key of GEMINI_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const val = node[key];
      if (key === 'properties' && isPlainObject(val)) {
        const props = {};
        for (const p of Object.keys(val)) props[p] = prune(val[p], depth + 1);
        out.properties = props;
      } else if (key === 'items') {
        out.items = prune(val, depth + 1);
      } else if (key === 'anyOf' && Array.isArray(val)) {
        out.anyOf = val.map(b => prune(b, depth + 1));
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  /* normalize() + drop every field Gemini's Schema does not define. */
  function forGemini(schema) {
    const norm = normalize(schema);
    const out = prune(norm, 0);
    if (out.type === undefined && out.anyOf === undefined) out.type = 'object';
    return out;
  }

  /* Gemini rejects an OBJECT parameter schema whose `properties` is absent or empty
     ("should be non-empty for OBJECT type"), so a no-argument tool must omit `parameters`
     altogether rather than send `{type:'object',properties:{}}`. Both bridge-core's no-arg
     tools and plenty of MCP servers expose exactly that shape. */
  function isEmptyObjectSchema(schema) {
    if (!isPlainObject(schema)) return true;
    if (schema.type !== undefined && schema.type !== 'object') return false;
    if (Array.isArray(schema.anyOf) && schema.anyOf.length) return false;
    return !isPlainObject(schema.properties) || Object.keys(schema.properties).length === 0;
  }

  // Own-property write that stays correct for a key like "__proto__" (a plain `o[k] = v` would set the prototype).
  function setOwn(obj, key, val) { Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true }); }

  /* ---- PROPERTY-KEY GRAMMAR (2026-09-22, Hermes audit Step 2) ----------------------------------------------
     Anthropic (and Bedrock/Vertex fronting it) rejects a tool whose property key falls outside
     ^[a-zA-Z0-9_.-]{1,64}$ — and ONE bad key anywhere in the tools array 400s the whole request, every turn.
     MCP connectors ship keys like "account id", and normalize()/forGemini() kept them verbatim on every wire.

     sanitizeKeys(schema) renames only the offending keys. A key's new name depends only on its own
     `properties` dict (insertion order; bad characters -> '_'; clipped to 64; a numeric suffix on collision with
     a valid key or an earlier rename), so the reverse map is recomputed from the ORIGINAL schema when the
     model's arguments come back: restoreArgumentKeys() puts the declared names back before the loop validates
     and dispatches, and the tool never sees the wire alias. `required` / `propertyOrdering` follow the rename.
     A schema with no offending key returns by IDENTITY, so a well-formed tool's wire bytes never change. Same
     contract as the reference harness' schema_sanitizer. */
  const PROP_KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
  const PROP_KEY_BAD = /[^a-zA-Z0-9_.-]/g;
  const KEY_MAP_KEYS = ['properties', '$defs', 'definitions', 'patternProperties'];   // values are schemas
  const KEY_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];                  // lists of schemas
  const KEY_NODE_KEYS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'];

  function propertyRenames(props) {
    const renames = new Map();
    if (!isPlainObject(props)) return renames;
    const keys = Object.keys(props);
    const taken = new Set(keys.filter(k => PROP_KEY_RE.test(k)));
    for (const key of keys) {
      if (PROP_KEY_RE.test(key)) continue;
      const base = key.replace(PROP_KEY_BAD, '_').slice(0, 64) || 'param';
      let cand = base;
      for (let n = 2; taken.has(cand); n++) { const sfx = '_' + n; cand = base.slice(0, 64 - sfx.length) + sfx; }
      taken.add(cand);
      renames.set(key, cand);
    }
    return renames;
  }

  function sanitizeNode(node, depth) {
    if (depth > MAX_DEPTH) return node;
    if (Array.isArray(node)) {
      let changed = false;
      const arr = node.map(n => { const s = sanitizeNode(n, depth + 1); if (s !== n) changed = true; return s; });
      return changed ? arr : node;
    }
    if (!isPlainObject(node)) return node;
    const renames = propertyRenames(node.properties);
    let out = null;   // copy-on-write: untouched nodes keep their identity
    const put = (key, val) => { if (val === node[key]) return; if (!out) out = Object.assign({}, node); setOwn(out, key, val); };
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (KEY_MAP_KEYS.indexOf(key) >= 0 && isPlainObject(val)) {
        // patternProperties keys are regexes, not names — only `properties` keys are renamed
        const rn = key === 'properties' ? renames : null;
        let changed = false;
        const map = {};
        for (const p of Object.keys(val)) {
          const sub = sanitizeNode(val[p], depth + 1);
          const name = (rn && rn.get(p)) || p;
          if (sub !== val[p] || name !== p) changed = true;
          setOwn(map, name, sub);
        }
        if (changed) put(key, map);
      } else if ((key === 'required' || key === 'propertyOrdering') && Array.isArray(val) && renames.size) {
        put(key, val.map(r => (typeof r === 'string' && renames.get(r)) || r));
      } else if (KEY_LIST_KEYS.indexOf(key) >= 0 && Array.isArray(val)) {
        put(key, sanitizeNode(val, depth));
      } else if (KEY_NODE_KEYS.indexOf(key) >= 0 && (isPlainObject(val) || (key === 'items' && Array.isArray(val)))) {
        put(key, sanitizeNode(val, depth + 1));
      }
    }
    return out || node;
  }
  function sanitizeKeys(schema) { return sanitizeNode(schema, 0); }

  // Follow a local $ref chain in the ORIGINAL document (bounded; an unresolvable ref stays as it is).
  function deref(node, rootDoc) {
    let n = node;
    for (let guard = 0; isPlainObject(n) && typeof n.$ref === 'string' && guard < 8; guard++) {
      const target = pointerLookup(rootDoc, n.$ref);
      if (!target) break;
      n = target;
    }
    return n;
  }
  function restoreNode(schema, value, rootDoc, depth) {
    if (depth > MAX_DEPTH) return value;
    const node = deref(schema, rootDoc);
    if (!isPlainObject(node)) return value;
    if (Array.isArray(value)) {
      const items = node.items;
      if (!isPlainObject(items) && !Array.isArray(items)) return value;
      let changed = false;
      const arr = value.map((v, i) => {
        const sub = Array.isArray(items) ? items[i] : items;
        const r = sub ? restoreNode(sub, v, rootDoc, depth + 1) : v;
        if (r !== v) changed = true;
        return r;
      });
      return changed ? arr : value;
    }
    if (!isPlainObject(value)) return value;
    // The object's declared properties — its own plus every union/intersection branch's.
    const reverse = new Map();   // wire alias -> declared name
    const subs = new Map();      // declared name -> its schema
    (function collect(n, d) {
      n = deref(n, rootDoc);
      if (!isPlainObject(n) || d > 4) return;
      if (isPlainObject(n.properties)) {
        for (const [orig, safe] of propertyRenames(n.properties)) if (!reverse.has(safe)) reverse.set(safe, orig);
        for (const k of Object.keys(n.properties)) if (!subs.has(k)) subs.set(k, n.properties[k]);
      }
      for (const lk of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(n[lk])) for (const b of n[lk]) collect(b, d + 1);
    })(node, 0);
    // an alias that is ALSO a declared name in some branch is ambiguous: leave that key alone
    for (const alias of Array.from(reverse.keys())) if (subs.has(alias)) reverse.delete(alias);
    let changed = false;
    const out = {};
    for (const key of Object.keys(value)) {
      const declared = reverse.get(key);
      // never clobber: if the model ALSO sent the declared name itself, the alias stays as it came
      const name = (declared != null && !Object.prototype.hasOwnProperty.call(value, declared)) ? declared : key;
      const sub = subs.get(name);
      const v = sub ? restoreNode(sub, value[key], rootDoc, depth + 1) : value[key];
      if (name !== key || v !== value[key]) changed = true;
      setOwn(out, name, v);
    }
    return changed ? out : value;
  }
  /* Map the wire aliases in model-emitted args back to the names the tool declared. `schema` is the ORIGINAL
     (un-sanitized) parameters schema. Recurses into nested objects and array items; unknown keys pass through.
     Returns `args` by identity when nothing needed restoring. */
  function restoreArgumentKeys(schema, args) {
    if (!isPlainObject(schema)) return args;
    return restoreNode(schema, args, schema, 0);
  }

  /* Which tools need their arguments restored: tool name -> ORIGINAL parameters, or null when every advertised
     schema is already key-safe (the common case — adapters then stream exactly as before). */
  function argKeyPlan(tools) {
    if (!Array.isArray(tools) || !tools.length) return null;
    let plan = null;
    for (const t of tools) {
      const fn = t && t.function;
      const name = fn && typeof fn.name === 'string' ? fn.name.trim() : '';
      if (!name || !isPlainObject(fn.parameters)) continue;
      if (sanitizeKeys(fn.parameters) === fn.parameters) continue;
      (plan = plan || new Map()).set(name, fn.parameters);
    }
    return plan;
  }
  function restoreArgsText(schema, text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      // Malformed args pass through untouched: the loop's repair (sanitize.js) owns that, and its telemetry must
      // still see the damage. The aliases then reach validation as-is, which fails honestly rather than guessing.
      failNote('providers.toolschema.restore_args_unparsed', e);
      return text;
    }
    if (!isPlainObject(parsed)) return text;
    const restored = restoreArgumentKeys(schema, parsed);
    return restored === parsed ? text : JSON.stringify(restored);
  }
  /* The adapter-side half: wrap an adapter's HarnessEvent stream. For a tool in `plan`, its tool_args fragments
     are held and released as ONE chunk carrying the declared keys — at that call's tool_done, or before the
     stream's `done` for adapters whose wire has no per-call stop (Chat Completions), or at stream end. Every
     other event, and every other tool's args, passes through in order and unbuffered. */
  async function* restoreToolArgKeys(events, plan) {
    const held = new Map();   // harness tool index -> { name, text }
    function release(index) {
      const h = held.get(index);
      held.delete(index);
      if (!h || !h.text) return null;
      return { type: 'tool_args', index: index, chunk: restoreArgsText(plan.get(h.name), h.text) };
    }
    for await (const ev of events) {
      const type = ev && ev.type;
      if (type === 'tool_start' && plan.has(String(ev.name || '').trim())) {
        held.set(ev.index, { name: String(ev.name).trim(), text: '' });
      } else if (type === 'tool_args' && held.has(ev.index)) {
        held.get(ev.index).text += String(ev.chunk == null ? '' : ev.chunk);
        continue;
      } else if (type === 'tool_done' && held.has(ev.index)) {
        const r = release(ev.index);
        if (r) yield r;
      } else if (type === 'done' && held.size) {
        for (const idx of Array.from(held.keys())) { const r = release(idx); if (r) yield r; }
      }
      yield ev;
    }
    for (const idx of Array.from(held.keys())) { const r = release(idx); if (r) yield r; }
  }
  /* Wrap an adapter's raw stream only when some advertised tool had keys renamed; otherwise hand back the raw
     generator itself (no extra hop, byte-for-byte the old event stream). */
  function withRestoredArgKeys(rawStream, tools) {
    const plan = argKeyPlan(tools);
    return plan ? restoreToolArgKeys(rawStream, plan) : rawStream;
  }

  /* ---- MOONSHOT / KIMI DIALECT (2026-09-22, Hermes audit Step 2) ------------------------------------------
     Moonshot answers an off-dialect tool schema with HTTP 400 "tools.function.parameters is not a valid moonshot
     flavored json schema" — the whole request, every turn. Rules (ported from the reference harness'
     moonshot_schema.py, the evidence for each):
       1. every property schema carries a `type` (inferred: properties/required -> object, items -> array,
          enum -> its first value's type, else string; a bare if/then/else node is left untyped);
       2. under `anyOf` the parent carries no `type`; null branches are dropped (a lone survivor is inlined);
       3. an enum under a scalar type may not contain null or "" (an emptied enum is dropped);
       4. every object schema carries a `required` array, pruned to names that exist;
       5. the non-standard `nullable` keyword is rejected — so a dropped null is NOT re-expressed as nullable.
     Applied ONLY on routes identified as Kimi/Moonshot (isMoonshotRoute); every other wire is untouched. */
  const MOONSHOT_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions'];
  const MOONSHOT_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
  const MOONSHOT_NODE_KEYS = ['items', 'contains', 'not', 'additionalProperties', 'propertyNames', 'if', 'then', 'else'];
  const SCALAR_TYPES = { string: 1, integer: 1, number: 1, boolean: 1 };
  const emptyObjectSchema = () => ({ type: 'object', properties: {}, required: [] });

  function ensureRequired(node) {
    const props = node.properties;
    if (Array.isArray(node.required)) {
      if (isPlainObject(props)) node.required = node.required.filter(r => typeof r === 'string' && Object.prototype.hasOwnProperty.call(props, r));
    } else node.required = [];
    return node;
  }
  function fillMissingType(node) {
    const t = node.type;
    if (Array.isArray(t)) {
      const concrete = t.find(x => typeof x === 'string' && x && x !== 'null') || 'string';
      return Object.assign({}, node, { type: concrete });
    }
    if (t !== undefined && t !== null && t !== '') return node;
    let inferred;
    if ('properties' in node || 'required' in node || 'additionalProperties' in node) inferred = 'object';
    else if ('items' in node || 'prefixItems' in node) inferred = 'array';
    else if (Array.isArray(node.enum) && node.enum.length) {
      const s = node.enum[0];
      inferred = typeof s === 'boolean' ? 'boolean' : typeof s === 'number' ? (Number.isInteger(s) ? 'integer' : 'number') : 'string';
    } else if ('if' in node || 'then' in node || 'else' in node) return node;
    else inferred = 'string';
    return Object.assign({}, node, { type: inferred });
  }
  function moonshotNode(node, depth) {
    if (depth > MAX_DEPTH) return node;
    if (Array.isArray(node)) return node.map(n => moonshotNode(n, depth + 1));
    if (!isPlainObject(node)) return node;
    let out = {};
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (MOONSHOT_MAP_KEYS.indexOf(key) >= 0 && isPlainObject(val)) {
        const map = {};
        for (const k of Object.keys(val)) setOwn(map, k, moonshotNode(val[k], depth + 1));
        setOwn(out, key, map);
      } else if ((MOONSHOT_LIST_KEYS.indexOf(key) >= 0 && Array.isArray(val))
        || (MOONSHOT_NODE_KEYS.indexOf(key) >= 0 && (isPlainObject(val) || (key === 'items' && Array.isArray(val))))) {
        setOwn(out, key, moonshotNode(val, depth + 1));
      } else setOwn(out, key, val);
    }
    if (Array.isArray(out.anyOf)) {                                   // rule 2
      delete out.type;
      const nonNull = out.anyOf.filter(b => isPlainObject(b) && b.type !== 'null');
      if (!nonNull.length || nonNull.length === out.anyOf.length) return out;
      if (nonNull.length > 1) { out.anyOf = nonNull; return out; }
      const rest = Object.assign({}, out);
      delete rest.anyOf;
      out = Object.assign(rest, nonNull[0]);
    }
    delete out.nullable;                                              // rule 5
    if (out.$ref === undefined) out = fillMissingType(out);          // rule 1 ($ref takes its type from the target)
    if (Array.isArray(out.enum) && SCALAR_TYPES[out.type]) {          // rule 3
      const kept = out.enum.filter(v => v !== null && v !== '');
      if (kept.length) out.enum = kept; else delete out.enum;
    }
    if (out.type === 'object') ensureRequired(out);                   // rule 4
    return out;
  }
  function forMoonshot(schema) {
    if (!isPlainObject(schema)) return emptyObjectSchema();
    const repaired = moonshotNode(schema, 0);
    if (!isPlainObject(repaired)) return emptyObjectSchema();
    const out = Object.assign({}, repaired, { type: 'object' });     // the top level is always an object schema
    if (!('properties' in out)) out.properties = {};
    return ensureRequired(out);
  }
  /* A Kimi / Moonshot route: the model slug names it (bare, vendor-prefixed, or aggregator-prefixed —
     aggregators route these to Moonshot inference under their own base URL), or the endpoint is Moonshot's. */
  function isMoonshotModel(model) {
    const bare = String(model == null ? '' : model).trim().toLowerCase();
    if (!bare) return false;
    const tail = bare.slice(bare.lastIndexOf('/') + 1);
    if (tail === 'kimi' || tail.indexOf('kimi-') === 0) return true;
    if (tail === 'k3' || tail.indexOf('k3.') === 0 || tail.indexOf('k3-') === 0) return true;   // Kimi Coding Plan's K3 slugs
    return bare.indexOf('moonshot') >= 0 || bare.indexOf('/kimi') >= 0 || bare.indexOf('kimi') === 0;
  }
  function isMoonshotRoute(model, baseUrl) {
    if (isMoonshotModel(model)) return true;
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(baseUrl == null ? '' : baseUrl).trim());
    const host = m ? m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase() : '';
    return /(^|\.)(moonshot\.ai|moonshot\.cn|kimi\.com|kimi\.ai)$/.test(host);   // kimi.ai = the Global Kimi deployment (#70)
  }

  /* The advertised tool list for a wire that sends OpenAI-shape tools verbatim (Chat Completions): property keys
     made grammar-safe, plus the Moonshot pass on a Kimi route. Untouched tools keep their object identity and
     an untouched list returns by identity, so a well-formed catalog is byte-identical on the wire. */
  function wireTools(tools, opts) {
    if (!Array.isArray(tools) || !tools.length) return tools;
    const moonshot = !!(opts && opts.moonshot);
    let changed = false;
    const out = tools.map(t => {
      const fn = t && t.function;
      if (!fn || typeof fn !== 'object') return t;
      let params = fn.parameters;
      if (isPlainObject(params)) params = sanitizeKeys(params);
      if (moonshot) params = forMoonshot(params);
      if (params === fn.parameters) return t;
      changed = true;
      return Object.assign({}, t, { function: Object.assign({}, fn, { parameters: params }) });
    });
    return changed ? out : tools;
  }

  return { normalize, forGemini, isEmptyObjectSchema,
    sanitizeKeys, restoreArgumentKeys, argKeyPlan, restoreToolArgKeys, withRestoredArgKeys,
    forMoonshot, isMoonshotModel, isMoonshotRoute, wireTools,
    _internals: { pointerLookup, collapseNullUnion, prune, GEMINI_FIELDS, propertyRenames, PROP_KEY_RE, restoreArgsText } };
});
