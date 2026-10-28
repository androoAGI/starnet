/* sidecar/prompt-scrub.js — the ONE resolver for secrets in text the station projects into a model prompt.

   WHY THIS EXISTS (context-key-redact, 2026-10-28). The Commander pastes a key into a directive once. The station
   stores that text raw (run titles, task briefs, interest evidence, thread specs, the dossier, goals, quests) and later
   projects it into OTHER runs' prompts: <commander_evidence> RECENT ACTIVITY lines quoted earlier directives with their
   raw vendor keys, and with the value the station holds in its key vault, right next to the redacted transcript form of
   the same turns. Every later run then sent the key to the model provider again.

   No single seam closes that, so three layers call this one module:
     L1 scrubStored(text) — every station projector of stored text (commander-context compose, contextpack.assemble,
        Interests.summary, Outcomes.fold, threads-store openThreads, the dossier/goal/focus/quest accessors in index.js)
        runs the RAW stored field through it BEFORE its first clip and before any suffix is appended. Order matters: once
        a slice/clip cuts a key, no later redact can match it (a cut AIza or ghp_ key, or a held shapeless key, leaves a
        fragment that fails every fixed-length shape and every exact value). It runs at READ time against the LIVE held
        list, so rows older builds already wrote raw are kept out too.
     L2 the persona system prompt, the per-run <run_context> body (and its kill-switch twin), the night-shift
        directives and every routine's upstream context go through scrubStored as whole texts (index.js), so a block
        added later cannot skip L1's rule.
     L3 guardRequest(provider) — the provider factory wraps every adapter it builds (attachRequestScrub), and each
        request is scrubbed of the CREDENTIALS the station holds (scrubRequest): message text, tool-call arguments and
        the cache prefix. Vendor SHAPES are left alone there on purpose: an unsaved key pasted in the live turn must stay
        readable for keys.save's starts_with hint.

   THE HELD LIST is the station's CREDENTIALS, registered by the host (setHeldSource): service keys (named), provider
   keys, channel/OAuth/connector tokens and passwords, and connector header/env entries that are credentials by name or
   by shape. It is deliberately NOT context.js's known-value list, which also sweeps every header/env string of a
   connector ('production', 'application/json', an email) for transcript redaction: matching those in prompts would
   mangle the Commander's own words. A saved SERVICE KEY is replaced by its name ('[INSTANTLY_API_KEY saved in API
   KEYS]', the form COMMS and keys.save use), so a routine or history that carried it still says which ${NAME} to use;
   any other credential becomes [redacted-secret].

   CUT POINTS — where a store's slice or a composer's clip leaves a key's head: the end of a line (trailing blanks
   ignored, an escaped \n in JSON text too), an ellipsis (… or ...), or a closing quote (" or \"). Two rules act there:
     VENDOR CUTS  a vendor-prefixed token (the full rules' own prefixes and body classes from context.js, the length
                  floor dropped) that ends at a cut point, is >= 12 chars, and whose body looks random (a digit, or
                  upper- and lower-case letters past its first char) — so 'pip install hf_transformers' or
                  'Write the sk-learn-tutorial' stay words.
     HELD HEADS   a >= 12-char proper prefix of a held credential that ends at a cut point, starting a token or right
                  after ':' / '=' / an escaped \n inside one ('Instantly:Rq…', 'KEY=Rq…').
   Both return the identical string when nothing matched, so a clean station's prompts keep their bytes (and their
   prompt cache).

   Pure: no clock, no IO. */
'use strict';
const context = require('./context.js');

const HEAD_MIN = 12;                 // a held head shorter than this is left alone (too likely to be ordinary text)
const CUT_MIN = 12;                  // a cut vendor token shorter than this (prefix + body) leaks too little to matter
const HELD_MIN = 8;                  // the same floor context.js uses for exact known values
const KEY = '[redacted-key]';
const SECRET = '[redacted-secret]';

/* ---------------- the held credentials ---------------- */
/* setHeldSource(fn) — fn() returns an iterable of entries: a string (a credential) or { value, as } (a credential that
   is replaced by `as`, e.g. a saved service key's '[NAME saved in API KEYS]'). Read on every scrub, like context.js's
   known-value source: a rotated or added key is covered by the very next call. The derived index is rebuilt only when
   the source hands back different entries (revision cache), and its identity IS the revision (guardRequest keys its
   per-adapter snapshot on it). */
let heldSource = null;
let heldCache = null;   // { flat: [value, as, value, as, …] as last read, H }
function setHeldSource(fn) { heldSource = typeof fn === 'function' ? fn : null; heldCache = null; }

// H = { values: [longest first], rep: Map(value -> placeholder), heads: Map(first 12 chars -> [values]), maxLen }
function buildHeld(flat) {
  const rep = new Map();
  for (let i = 0; i < flat.length; i += 2) {
    const v = typeof flat[i] === 'string' ? flat[i].trim() : '';
    if (v.length < HELD_MIN || v.indexOf('[redacted-') >= 0 || rep.has(v)) continue;
    rep.set(v, typeof flat[i + 1] === 'string' && flat[i + 1] ? flat[i + 1] : SECRET);
  }
  if (!rep.size) return null;
  const values = Array.from(rep.keys()).sort((a, b) => b.length - a.length);   // longest first: a key holding another is replaced whole
  const heads = new Map();
  for (const v of values) {
    if (v.length <= HEAD_MIN || /\s/.test(v)) continue;
    const h = v.slice(0, HEAD_MIN);
    const list = heads.get(h);
    if (list) list.push(v); else heads.set(h, [v]);
  }
  return Object.freeze({ values: Object.freeze(values), rep, heads });
}
function currentHeld() {
  if (!heldSource) return null;
  let raw;
  try { raw = heldSource(); } catch (_) { return null; }
  if (!raw || typeof raw[Symbol.iterator] !== 'function') return null;
  const flat = [];
  for (const e of raw) {
    if (typeof e === 'string') flat.push(e, null);
    else if (e && typeof e.value === 'string') flat.push(e.value, typeof e.as === 'string' ? e.as : null);
  }
  const c = heldCache;
  if (c && c.flat.length === flat.length) {
    let same = true;
    for (let i = 0; i < flat.length; i++) if (flat[i] !== c.flat[i]) { same = false; break; }
    if (same) return c.H;
  }
  const H = buildHeld(flat);
  heldCache = { flat, H };
  return H;
}
// a caller may pass a held snapshot (H), a plain array of values (tests, one-off checks), or nothing (the live list)
const heldOfArray = new WeakMap();
function asHeld(held) {
  if (held === undefined) return currentHeld();
  if (!held || typeof held !== 'object') return null;
  if (held.rep instanceof Map) return held;
  if (Array.isArray(held)) {
    let H = heldOfArray.get(held);
    if (H === undefined) {
      const flat = [];
      for (const e of held) if (typeof e === 'string') flat.push(e, null); else if (e && typeof e.value === 'string') flat.push(e.value, e.as || null);
      H = buildHeld(flat);
      heldOfArray.set(held, H);
    }
    return H;
  }
  return null;
}

function exactHeld(s, H) {
  for (let i = 0; i < H.values.length; i++) {
    const v = H.values[i];
    if (s.indexOf(v) >= 0) s = s.split(v).join(H.rep.get(v));
  }
  return s;
}

/* ---------------- cut points ---------------- */
function isCutAt(s, e) {
  if (e >= s.length) return true;
  const c = s.charCodeAt(e);
  if (c === 0x2026 || c === 34) return true;                                   // … or "
  if (c === 46 && s.charCodeAt(e + 1) === 46 && s.charCodeAt(e + 2) === 46) return true;   // ...
  if (c === 92) { const n = s[e + 1]; if (n === '"' || n === 'n' || n === 'r') return true; }   // \" \n \r (JSON text)
  let i = e;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i >= s.length || s[i] === '\n' || s[i] === '\r';
}

/* VENDOR CUTS — the full rules' prefixes and body classes (context.js SECRET_PATTERNS), floor dropped to 4 body chars.
   The boundary keeps hyphenated words whole ('task-…') yet still sees a key right after an escape in JSON / URL text
   (\nsk-…, %3Dsk-…). `digit` = this family's body must hold a digit (an all-caps AWS id is otherwise a word). */
const BOUND = '(?:(?<![A-Za-z0-9])|(?<=\\\\[nrt])|(?<=%[0-9A-Fa-f]{2}))';
const CUT_AHEAD = '(?=…|\\.{3}|"|\\\\["nr]|[ \\t]*$)';
const VENDOR_CUT_SOURCES = [
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
  ['(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)', '[0-9A-Z]', 4, true],   // AWS access key id
  ['\\d{8,10}:', '[A-Za-z0-9_\\-]', 8]          // Telegram bot token (8+: a compact 'yyyymmdd:hhmm' stays a time)
];
const VENDOR_CUTS = VENDOR_CUT_SOURCES.map(([p, cls, min, digit]) => ({
  re: new RegExp(BOUND + '(' + p + ')(' + cls + '{' + (min || 4) + ',})' + CUT_AHEAD, 'gm'),
  min: min || 4, digit: !!digit
}));
// a cut body that looks random, not like a word: a digit, or upper- AND lower-case letters past its first char
function randomish(body, digitOnly) {
  if (/[0-9]/.test(body)) return true;
  return !digitOnly && /[A-Z]/.test(body.slice(1)) && /[a-z]/.test(body);
}
const VENDOR_HINT = /sk[-_]|AIza|ya29|gh[pousr]_|github_pat_|glpat-|xox|xapp-|syt_|gsk_|pplx-|ntn_|lin_api_|SG\.|whk_|hf_|xai-|eyJ|A[KSGIRN][A-Z]A|\d{8}:/;
function vendorCuts(s) {
  if (!VENDOR_HINT.test(s)) return s;
  const hits = [];
  for (const v of VENDOR_CUTS) {
    v.re.lastIndex = 0;
    let m;
    while ((m = v.re.exec(s))) {
      let body = m[2];
      const dots = /\.{3,}$/.exec(body);           // a class holding '.' (SG., eyJ) swallowed the ellipsis: give it back
      if (dots) body = body.slice(0, dots.index);
      const len = m[1].length + body.length;
      if (body.length >= v.min && len >= CUT_MIN && randomish(body, v.digit)) hits.push([m.index, m.index + len]);
      if (m[0].length === 0) v.re.lastIndex++;
    }
  }
  if (!hits.length) return s;
  hits.sort((a, b) => b[0] - a[0]);
  let out = s, lastStart = Infinity;
  for (const [a, b] of hits) { if (b > lastStart) continue; out = out.slice(0, a) + KEY + out.slice(b); lastStart = a; }
  return out;
}

/* HELD HEADS at cut points. One pass over the text's tokens (never a walk-back per cut point: a long run of '...' was
   quadratic): in each token, the candidate starts are the token start and the char after ':', '=' or an escaped \n;
   the 12-char head map says which held values can start there, and the common prefix with each says where the head
   ends. A head that ends at a cut point, short of the whole value, is a cut key. */
const TOKEN = /[^\s"'`()<>[\]{},;|]+/g;
function heldHeads(s, H) {
  if (!H || !H.heads.size || s.length < HEAD_MIN) return s;
  const hits = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(s))) {
    const ts = m.index, te = ts + m[0].length;
    if (te - ts < HEAD_MIN) continue;
    for (let p = ts; te - p >= HEAD_MIN; p++) {
      if (p !== ts) {
        const prev = s[p - 1];
        if (prev !== ':' && prev !== '=' && !((prev === 'n' || prev === 'r' || prev === 't') && s[p - 2] === '\\')) continue;
      }
      const list = H.heads.get(s.substr(p, HEAD_MIN));
      if (!list) continue;
      let best = 0, as = SECRET;
      for (const v of list) {
        const max = Math.min(v.length - 1, te - p);
        let L = HEAD_MIN;
        while (L < max && s.charCodeAt(p + L) === v.charCodeAt(L)) L++;
        if (L > best && isCutAt(s, p + L)) { best = L; as = H.rep.get(v) || SECRET; }
      }
      if (best) { hits.push([p, p + best, as]); p += best - 1; }
    }
  }
  if (!hits.length) return s;
  let out = s;
  for (let i = hits.length - 1; i >= 0; i--) out = out.slice(0, hits[i][0]) + hits[i][2] + out.slice(hits[i][1]);
  return out;
}

/* ---------------- the three entry points ---------------- */
/* scrubStored(text, opts?) — L1/L2. For STORED text on its way into a prompt: every held credential (named where it is
   a saved service key), every vendor shape (context.js rules), vendor cuts and held heads at cut points. opts.whole =
   the text is known to be uncut (a directive before the store cuts it): no vendor-cut pass, which could only misfire
   there. A non-string comes back unchanged. */
function scrubStored(text, opts) {
  if (typeof text !== 'string' || !text) return text;
  const H = currentHeld();
  let out = H ? exactHeld(text, H) : text;
  out = context.redactWith(out, null);
  if (!(opts && opts.whole)) out = vendorCuts(out);
  if (H) out = heldHeads(out, H);
  return out === text ? text : out;
}

/* scrubHeld(text, held?) — L3's text rule: ONLY the credentials the station holds, whole or as a head at a cut point.
   Never a vendor shape: an unsaved key in the live turn stays readable for keys.save. `held` defaults to the live list. */
function scrubHeld(text, held) {
  if (typeof text !== 'string' || !text) return text;
  const H = asHeld(held);
  if (!H) return text;
  const out = heldHeads(exactHeld(text, H), H);
  return out === text ? text : out;
}

/* scrubDeep(value) — scrubStored over every string inside a plain JSON-like value (an evidence object a directive
   serializes). Copy-on-write: the SAME object comes back when nothing changed. */
function scrubDeep(x, depth) {
  depth = depth || 0;
  if (typeof x === 'string') return scrubStored(x);
  if (!x || typeof x !== 'object' || depth > 8) return x;
  if (Array.isArray(x)) {
    let copy = null;
    for (let i = 0; i < x.length; i++) { const v = scrubDeep(x[i], depth + 1); if (v !== x[i]) { if (!copy) copy = x.slice(); copy[i] = v; } }
    return copy || x;
  }
  let copy = null;
  for (const k of Object.keys(x)) {
    if (k === '__proto__') continue;
    const v = scrubDeep(x[k], depth + 1);
    if (v !== x[k]) { if (!copy) copy = Object.assign({}, x); copy[k] = v; }
  }
  return copy || x;
}

// thinking / reasoning parts are signed or replayed verbatim by their provider: never rewritten
const SKIP_PART = new Set(['thinking', 'redacted_thinking', 'reasoning', 'image_url', 'image', 'input_image']);
/* The memo keeps a long run from re-scanning its history every loop turn, but a loop can rewrite a message IN PLACE
   (loop.js collapseContinuation, the interruption notes): an entry is reused only while the message still holds the
   very content and tool-call arguments it was computed from. */
function memoFresh(m, e) {
  if (m.content !== e.c || m.tool_calls !== e.tc) return false;
  if (e.texts) { if (m.content.length !== e.texts.length) return false; for (let i = 0; i < e.texts.length; i++) { const p = m.content[i]; if ((p && p.text) !== e.texts[i]) return false; } }
  if (e.args) { if (m.tool_calls.length !== e.args.length) return false; for (let i = 0; i < e.args.length; i++) { const tc = m.tool_calls[i]; if ((tc && tc.function && tc.function.arguments) !== e.args[i]) return false; } }
  return true;
}
function scrubMessage(m, H, memo) {
  if (!m || typeof m !== 'object') return m;
  if (memo) { const e = memo.get(m); if (e && memoFresh(m, e)) return e.out; }
  let out = m;
  if (typeof m.content === 'string') {
    const c = scrubHeld(m.content, H);
    if (c !== m.content) out = Object.assign({}, m, { content: c });
  } else if (Array.isArray(m.content)) {
    let parts = null;
    for (let i = 0; i < m.content.length; i++) {
      const p = m.content[i];
      if (!p || typeof p !== 'object' || typeof p.text !== 'string' || SKIP_PART.has(p.type)) continue;
      const t = scrubHeld(p.text, H);
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
      const a = scrubHeld(fn.arguments, H);
      if (a === fn.arguments) continue;
      if (!calls) calls = m.tool_calls.slice();
      calls[i] = Object.assign({}, tc, { function: Object.assign({}, fn, { arguments: a }) });
    }
    if (calls) out = Object.assign(out === m ? Object.assign({}, m) : out, { tool_calls: calls });
  }
  if (memo) memo.set(m, {
    c: m.content, tc: m.tool_calls, out,
    texts: Array.isArray(m.content) ? m.content.map(p => p && p.text) : null,
    args: Array.isArray(m.tool_calls) ? m.tool_calls.map(tc => tc && tc.function && tc.function.arguments) : null
  });
  return out;
}

/* scrubRequest(req, held, memo?) — L3. Copy-on-write over messages[*].content (a string or text parts), the
   assistant tool_calls' arguments, and cacheSystemPrefix (the same function, so a prefix still prefixes its system
   message). tools, reasoning/thinking, images, roles, order and every other field are untouched. Returns the SAME
   object when nothing changed. `memo` (a WeakMap) keeps a long run from re-scanning its history every turn. */
function scrubRequest(req, held, memo) {
  const H = asHeld(held === undefined ? null : held);
  if (!req || typeof req !== 'object' || !H) return req;
  let msgs = req.messages, changed = false;
  if (Array.isArray(msgs)) {
    let copy = null;
    for (let i = 0; i < msgs.length; i++) {
      const s = scrubMessage(msgs[i], H, memo);
      if (s === msgs[i]) continue;
      if (!copy) copy = msgs.slice();
      copy[i] = s;
    }
    if (copy) { msgs = copy; changed = true; }
  }
  let prefix = req.cacheSystemPrefix;
  if (typeof prefix === 'string' && prefix) {
    const p = scrubHeld(prefix, H);
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
   every later run's requests — and from the run's own post-run aux passes, which re-guard the run's adapter (a fresh
   snapshot) before they resend its messages. Do not "improve" this to re-read the held list per request. */
function guardRequest(provider) {
  if (!provider || typeof provider.stream !== 'function') return provider;
  let held = null, taken = false;
  const memo = new WeakMap();
  const inner = provider.stream;
  return Object.assign({}, provider, {
    stream(req) {
      if (!taken) { taken = true; try { held = currentHeld(); } catch (_) { held = null; } }
      return inner.call(provider, scrubRequest(req, held, memo));
    }
  });
}

module.exports = { setHeldSource, currentHeld, scrubStored, scrubHeld, scrubDeep, scrubRequest, guardRequest, HEAD_MIN, CUT_MIN, HELD_MIN };
