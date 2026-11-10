'use strict';
/* test/helpers/anthropic-cache-sim.js — THE ANTHROPIC PROMPT CACHE AS DOCUMENTED, for pricing a run's REAL wire bodies
   (what the adapter handed fetch) without a paid call. W2.1 batched ageing's invariant prices both arms with it, and the
   A/B runner's --self-test mock reports its usage.

   The rules, from the claude-api skill (shared/prompt-caching.md):
     · the prompt renders tools -> system -> messages, and a cache entry is the prefix up to and including a block that
       carried cache_control on an earlier request: "Reads can only land on positions where a previous request wrote a
       breakpoint" (:204);
     · "Each breakpoint walks backward at most 20 positions to find a prior cache entry. On the Claude API a run of
       consecutive tool_use blocks counts as one position, and so does a run of consecutive tool_result blocks" (:246);
     · "Writes bill only the delta past the highest cache hit" (:198): a request reads up to its furthest hit, writes
       from there to its last breakpoint (each stretch at the tier of the breakpoint that closes it: ttl '1h' bills 2x the
       input price, the 5-minute default 1.25x, :144) and pays the plain input price for what follows its last
       breakpoint.
   Not modelled: expiry (entries never expire here; a live run's requests are seconds apart, and an expiry could only add
   writes), the per-model minimum cacheable prefix, and server-side thinking stripping. Sizes are characters of each
   position's JSON with cache_control removed (about 3.6 to a token).

   makeCache() -> { request(body) -> usage, entries }
     usage: { read, write5m, write1h, uncached, total, hit (the position read up to, -1 none), positions, breakpoints }
   inputEq(usage, read) -> uncached + 1.25 x write5m + 2 x write1h + read x read: the input bill in fresh-input units */
const crypto = require('crypto');

const LOOKBACK = 20;
const strip = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));
const ccOf = b => (b && typeof b === 'object' && b.cache_control && typeof b.cache_control === 'object') ? b.cache_control : null;

// the prompt as positions, in render order: { text (what the position renders), chars, cc (the breakpoint it carries) }
function positionsOf(body) {
  const out = [];
  const push = (text, cc) => out.push({ text, chars: text.length, cc: cc || null });
  for (const t of (Array.isArray(body.tools) ? body.tools : [])) push('tool:' + JSON.stringify(strip(t)), ccOf(t));
  if (typeof body.system === 'string') { if (body.system) push('system:' + body.system, null); }
  else if (Array.isArray(body.system)) for (const b of body.system) push('system:' + JSON.stringify(strip(b)), ccOf(b));
  for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
    let run = null;   // the tool_use or tool_result run being collapsed into one position
    for (const b of blocks) {
      const type = b && b.type;
      const text = m.role + ':' + JSON.stringify(strip(b));
      if (run && (type === 'tool_use' || type === 'tool_result') && run.type === type) {
        run.pos.text += '\u0000' + text; run.pos.chars += text.length;
        if (ccOf(b)) run.pos.cc = ccOf(b);
        continue;
      }
      push(text, ccOf(b));
      run = (type === 'tool_use' || type === 'tool_result') ? { type, pos: out[out.length - 1] } : null;
    }
  }
  // each position's key: the hash of the whole prefix up to and including it
  let acc = '';
  for (const p of out) { acc = crypto.createHash('sha1').update(acc + '\u0001' + p.text).digest('hex'); p.key = acc; }
  return out;
}

function makeCache() {
  const entries = new Set();
  function request(body) {
    const P = positionsOf(body || {});
    const bps = [];
    P.forEach((p, i) => { if (p.cc) bps.push(i); });
    let hit = -1;
    for (const b of bps) {
      for (let q = b; q >= 0 && q >= b - LOOKBACK; q--) if (entries.has(P[q].key)) { if (q > hit) hit = q; break; }
    }
    const last = bps.length ? bps[bps.length - 1] : -1;
    const u = { read: 0, write5m: 0, write1h: 0, uncached: 0, total: 0, hit, positions: P.length, breakpoints: bps.length };
    let k = 0;   // the next breakpoint at or after position i (the one that closes its stretch)
    for (let i = 0; i < P.length; i++) {
      const c = P[i].chars;
      u.total += c;
      if (i <= hit) { u.read += c; continue; }
      if (i > last) { u.uncached += c; continue; }
      while (bps[k] < i) k++;
      const cc = P[bps[k]].cc;
      if (cc && cc.ttl === '1h') u.write1h += c; else u.write5m += c;
    }
    for (const b of bps) entries.add(P[b].key);
    return u;
  }
  return { request, entries };
}
const inputEq = (u, read) => u.uncached + 1.25 * u.write5m + 2 * u.write1h + read * u.read;
// the bill of a whole run of wire bodies: { inputEq, read, write5m, write1h, uncached, total, perRequest }
function priceRun(bodies, read) {
  const cache = makeCache();
  const sum = { inputEq: 0, read: 0, write5m: 0, write1h: 0, uncached: 0, total: 0, perRequest: [] };
  for (const b of bodies) {
    const u = cache.request(b);
    sum.perRequest.push(u);
    for (const k of ['read', 'write5m', 'write1h', 'uncached', 'total']) sum[k] += u[k];
    sum.inputEq += inputEq(u, read);
  }
  return sum;
}

module.exports = { makeCache, priceRun, inputEq, positionsOf, LOOKBACK };
