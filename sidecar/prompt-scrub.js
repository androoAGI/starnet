/* sidecar/prompt-scrub.js — the ONE resolver for secrets in text the station projects into a model prompt.

   WHY THIS EXISTS (context-key-redact, 2026-10-28). The Commander pastes a key into a directive once. The station
   stores that text raw (run titles, task briefs, interest evidence, thread specs, the dossier) and later projects
   it into OTHER runs' prompts: <commander_evidence> RECENT ACTIVITY lines quoted earlier directives with their raw
   vendor keys, and with the value the station holds in its key vault, right next to the redacted transcript form of
   the same turns. Every later run then sent the key to the model provider again.

   No single seam closes that, so three layers call this one module:
     L1 scrubStored(text) — every station projector of stored text (commander-context compose, contextpack.assemble,
        Interests.summary, threads-store openThreads, the dossier/goal accessors) runs the RAW stored field through it
        BEFORE its first clip. Order matters: once a slice/clip cuts a key, no later redact can match it (a cut AIza or
        ghp_ key, or a held shapeless key, leaves a fragment that fails every fixed-length shape and every exact value).
        It runs at READ time against the LIVE held list, so rows older builds already wrote raw are kept out too.
     L2 the per-run <run_context> body goes through scrubStored as a whole (index.js runOnceCore), so a future per-run
        block cannot skip L1.
     L3 guardRequest(provider) — the provider factory wraps every adapter it builds (attachRequestScrub), and each
        request is scrubbed of the values the station HOLDS (scrubRequest): message text, tool-call arguments and the
        cache prefix. Vendor SHAPES are left alone there on purpose: an unsaved key pasted in the live turn must stay
        readable for keys.save's starts_with hint.

   scrubStored(text) = context.redact (vendor shapes + exact held values) + a vendor CUT TAIL (a vendor-prefixed token
   that ends the text, its length floor dropped) + held HEADS (a >= 12-char proper prefix of a held value sitting at a
   cut point: the end of the text, or right before … / ...). It returns the identical string when nothing matched, so
   a clean station's prompts keep their bytes (and their prompt cache).

   Pure: no clock, no IO. The held list is read from context.js (a module singleton, so it is the same source index.js
   registers with setKnownSecretSource). */
'use strict';
const context = require('./context.js');

const HEAD_MIN = 12;                 // a held head shorter than this is left alone (too likely to be ordinary text)
const CUT_MIN = 12;                  // a cut vendor token shorter than this (prefix + body) leaks too little to matter
const KEY = '[redacted-key]';
const SECRET = '[redacted-secret]';
const TAIL_SCAN = 400;               // a cut tail lives in the last few hundred chars; never regex a whole document

/* VENDOR CUT TAILS — the full rules' own prefixes and body classes (context.js SECRET_PATTERNS), with the length floor
   dropped to 4 body chars, at the END of the text only (optionally followed by an ellipsis): the place a store's
   slice(0, n) or a model's verbatim quote cuts a key. The lookbehind keeps hyphenated words ('task-…') whole. */
const CUT_TAIL_SOURCES = [
  ['sk-', '[A-Za-z0-9_\\-]'],                    // OpenRouter / Anthropic / OpenAI project / generic
  ['sk_(?:live|test)_', '[A-Za-z0-9]'],          // Stripe
  ['AIza', '[0-9A-Za-z_\\-]'],                   // Google API key
  ['ya29\\.', '[0-9A-Za-z_\\-]'],                // Google OAuth access token
  ['gh[pousr]_', '[A-Za-z0-9]'],                 // GitHub classic
  ['github_pat_', '[A-Za-z0-9_]'],               // GitHub fine-grained
  ['glpat-', '[A-Za-z0-9_\\-]'],                 // GitLab
  ['xox[abeprs]-', '[A-Za-z0-9-]'],              // Slack
  ['xapp-\\d-', '[A-Za-z0-9-]'],                 // Slack app-level
  ['syt_', '[A-Za-z0-9_]'],                      // Matrix
  ['gsk_', '[A-Za-z0-9]'],                       // Groq
  ['pplx-', '[A-Za-z0-9]'],                      // Perplexity
  ['ntn_', '[A-Za-z0-9]'],                       // Notion
  ['lin_api_', '[A-Za-z0-9]'],                   // Linear
  ['SG\\.', '[A-Za-z0-9_\\-.]'],                 // SendGrid
  ['whk_', '[A-Za-z0-9_\\-]'],                   // StarNet line-trigger webhook secret
  ['hf_', '[A-Za-z0-9]'],                        // HuggingFace
  ['xai-', '[A-Za-z0-9]'],                       // xAI
  ['eyJ', '[A-Za-z0-9_\\-.]'],                   // JWT
  ['(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)', '[0-9A-Z]'],   // AWS access key id
  ['\\d{8,10}:', '[A-Za-z0-9_\\-]', 8]          // Telegram bot token (8+: a compact 'yyyymmdd:hhmm' stays a time)
];
const CUT_TAILS = CUT_TAIL_SOURCES.map(([p, cls, min]) => new RegExp('(?<![A-Za-z0-9])(' + p + ')' + cls + '{' + (min || 4) + ',}(?:…|\\.{3})?\\s*$'));

function cutTail(s) {
  const from = s.length > TAIL_SCAN ? s.length - TAIL_SCAN : 0;
  const tail = from ? s.slice(from) : s;
  for (const re of CUT_TAILS) {
    const m = re.exec(tail);
    if (!m) continue;
    const token = m[0].replace(/(?:…|\.{3})?\s*$/, '');
    if (token.length < CUT_MIN) continue;
    const at = from + m.index;
    return s.slice(0, at) + KEY + s.slice(at + token.length);
  }
  return s;
}

/* KEYISH — which held values the HEAD rule and the request boundary (L3) act on. The held list over-collects every
   string under a connector's headers/env (secret-values.js allUnder), so it can hold 'application/json' or
   'production'. Exact-value redaction of stored text keeps context.redact's semantics (the same as the transcript),
   but a head match and a scrub of the live turn / system prompt are only done for values that look like a credential:
   12+ chars, no whitespace, not a URL, at least one letter and one digit. */
function keyish(v) {
  return typeof v === 'string' && v.length >= HEAD_MIN && !/\s/.test(v) && v.indexOf('://') < 0 && /[A-Za-z]/.test(v) && /[0-9]/.test(v);
}

// Derived per held-list REVISION (context.heldSecrets() returns the same frozen array until the held set changes). A
// WeakMap, not one slot: a provider's snapshot (L3) and the live list (L1) can be two revisions at once.
const derivedByList = new WeakMap();
const NONE = Object.freeze({ values: Object.freeze([]), heads: new Map() });
function derive(held) {
  if (!held || typeof held !== 'object') return NONE;
  const hit = derivedByList.get(held);
  if (hit) return hit;
  const values = [], heads = new Map();
  for (const v of held) {
    if (!keyish(v)) continue;
    values.push(v);
    const h = v.slice(0, HEAD_MIN);
    const list = heads.get(h);
    if (list) list.push(v); else heads.set(h, [v]);
  }
  const d = { values, heads };
  derivedByList.set(held, d);
  return d;
}

/* HELD HEADS at cut points. A cut point is the end of the text (trailing space ignored) or the start of a … / ... run.
   The token that ends there is checked from its start, and from right after any ':' or '=' inside it ('Instantly:Rq…',
   'KEY=Rq…'); a >= 12-char proper prefix of a held value there becomes [redacted-secret]. */
const TOKEN_STOP = /[\s"'`()<>[\]{},;|]/;
function scrubHeads(s, heads) {
  if (!heads || !heads.size || s.length < HEAD_MIN) return s;
  const cuts = [];
  let end = s.length;
  while (end > 0 && /\s/.test(s[end - 1])) end--;
  cuts.push(end);
  for (let i = s.indexOf('…'); i >= 0; i = s.indexOf('…', i + 1)) cuts.push(i);
  for (let i = s.indexOf('...'); i >= 0; i = s.indexOf('...', i + 3)) cuts.push(i);
  if (cuts.length > 1) cuts.sort((a, b) => b - a);   // right to left: a splice never moves a cut still to visit
  let out = s;
  for (const c of cuts) {
    let t0 = c;
    while (t0 > 0 && !TOKEN_STOP.test(out[t0 - 1])) t0--;
    if (c - t0 < HEAD_MIN) continue;
    for (let p = t0; c - p >= HEAD_MIN; p++) {
      if (p !== t0 && out[p - 1] !== ':' && out[p - 1] !== '=') continue;
      const frag = out.slice(p, c);
      const list = heads.get(frag.slice(0, HEAD_MIN));
      if (!list || !list.some(v => v.length > frag.length && v.indexOf(frag) === 0)) continue;
      out = out.slice(0, p) + SECRET + out.slice(c);
      break;
    }
  }
  return out;
}

function exactHeld(s, values) {
  for (let i = 0; i < values.length; i++) if (s.indexOf(values[i]) >= 0) s = s.split(values[i]).join(SECRET);
  return s;
}

/* scrubStored(text) — L1/L2. For STORED text on its way into a prompt: vendor shapes and every held value (context
   redact), a cut vendor tail, held heads at cut points. A non-string comes back unchanged. */
function scrubStored(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = context.redact(text);
  out = cutTail(out);
  const held = context.heldSecrets();
  if (held) out = scrubHeads(out, derive(held).heads);
  return out === text ? text : out;
}

/* scrubHeld(text, held?) — L3's text rule: ONLY the (keyish) values the station holds, whole or as a head at a cut
   point. Never a vendor shape: an unsaved key in the live turn stays readable for keys.save. `held` defaults to the
   live list. */
function scrubHeld(text, held) {
  if (typeof text !== 'string' || !text) return text;
  const d = derive(held === undefined ? context.heldSecrets() : held);
  if (!d.values.length) return text;
  let out = exactHeld(text, d.values);
  out = scrubHeads(out, d.heads);
  return out === text ? text : out;
}

// thinking / reasoning parts are signed or replayed verbatim by their provider: never rewritten
const SKIP_PART = new Set(['thinking', 'redacted_thinking', 'reasoning', 'image_url', 'image', 'input_image']);
function scrubMessage(m, held, memo) {
  if (!m || typeof m !== 'object') return m;
  if (memo && memo.has(m)) return memo.get(m);
  let out = m;
  if (typeof m.content === 'string') {
    const c = scrubHeld(m.content, held);
    if (c !== m.content) out = Object.assign({}, m, { content: c });
  } else if (Array.isArray(m.content)) {
    let parts = null;
    for (let i = 0; i < m.content.length; i++) {
      const p = m.content[i];
      if (!p || typeof p !== 'object' || typeof p.text !== 'string' || SKIP_PART.has(p.type)) continue;
      const t = scrubHeld(p.text, held);
      if (t === p.text) continue;
      if (!parts) parts = m.content.slice();
      parts[i] = Object.assign({}, p, { text: t });
    }
    if (parts) out = Object.assign({}, m, { content: parts });
  }
  if (Array.isArray(m.tool_calls)) {
    let calls = null;
    for (let i = 0; i < m.tool_calls.length; i++) {
      const tc = m.tool_calls[i];
      const fn = tc && tc.function;
      if (!fn || typeof fn.arguments !== 'string') continue;
      const a = scrubHeld(fn.arguments, held);
      if (a === fn.arguments) continue;
      if (!calls) calls = m.tool_calls.slice();
      calls[i] = Object.assign({}, tc, { function: Object.assign({}, fn, { arguments: a }) });
    }
    if (calls) out = Object.assign(out === m ? Object.assign({}, m) : out, { tool_calls: calls });
  }
  if (memo) memo.set(m, out);
  return out;
}

/* scrubRequest(req, held, memo?) — L3. Copy-on-write over messages[*].content (a string or text parts), the
   assistant tool_calls' arguments, and cacheSystemPrefix (the same function, so a prefix still prefixes its system
   message). tools, reasoning/thinking, images, roles, order and every other field are untouched. Returns the SAME
   object when nothing changed. `memo` (a WeakMap) keeps a long run from re-scanning its history every turn. */
function scrubRequest(req, held, memo) {
  if (!req || typeof req !== 'object' || !held || !derive(held).values.length) return req;
  let msgs = req.messages, changed = false;
  if (Array.isArray(msgs)) {
    let copy = null;
    for (let i = 0; i < msgs.length; i++) {
      const s = scrubMessage(msgs[i], held, memo);
      if (s === msgs[i]) continue;
      if (!copy) copy = msgs.slice();
      copy[i] = s;
    }
    if (copy) { msgs = copy; changed = true; }
  }
  let prefix = req.cacheSystemPrefix;
  if (typeof prefix === 'string' && prefix) {
    const p = scrubHeld(prefix, held);
    if (p !== prefix) { prefix = p; changed = true; }
  }
  if (!changed) return req;
  const out = Object.assign({}, req, { messages: msgs });
  if ('cacheSystemPrefix' in req) out.cacheSystemPrefix = prefix;
  return out;
}

/* guardRequest(provider) — what the factory attaches (attachRequestScrub). The held list is SNAPSHOT at this
   adapter's first request and kept for its life (one run, or one aux pass): rewriting an earlier message mid-run would
   move the prompt-cache prefix and break Anthropic's preserved-thinking bindings. A value saved mid-run is gone from
   every later run's requests. Do not "improve" this to re-read the held list per request. */
function guardRequest(provider) {
  if (!provider || typeof provider.stream !== 'function') return provider;
  let held, taken = false;
  const memo = new WeakMap();
  const inner = provider.stream;
  return Object.assign({}, provider, {
    stream(req) {
      if (!taken) { taken = true; try { held = context.heldSecrets(); } catch (_) { held = null; } }
      return inner.call(provider, scrubRequest(req, held, memo));
    }
  });
}

module.exports = { scrubStored, scrubHeld, scrubRequest, guardRequest, keyish, HEAD_MIN, CUT_MIN };
