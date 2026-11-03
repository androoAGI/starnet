/* sidecar/channels/chunk.js — the ONE chunker: how a reply too long for one platform message is split.

   Moved out of channels/hub.js unchanged (channel-delivery-ledger, S1). A hub's reply is cut with it before it enters the
   delivery ledger (channels/hub-delivery.js), and every send outside a hub reply — a routine delivery, channel.send, the
   notifier, a nudge, a loop notice — splits its text with it (channels/outbound.js, S4: there is no other chunker). It
   cuts at the last newline or space past half the limit, and a ```
   block the cut lands inside is closed at the end of its chunk and re-opened at the top of the next.

     chunkTextParts(text, max) -> { raw, send }   both views of the split, aligned 1:1
     chunkText(text, max)      -> send            the chunks the wire takes

   Pure: no I/O, no clock. */
'use strict';

/* Re-open a fenced code block that a chunk boundary cut in half.

   A reply longer than the platform's limit is split into messages, and a ``` block straddling the cut left
   chunk 2 with an UNPAIRED opening fence: the formatter (which only converts what it can prove is balanced
   within its own string) correctly declines to make it code, so the second half of a script or a log lands as
   raw prose with a stray ``` in it. Close the block at the end of the chunk that opened it and re-open at the
   top of the next, so both halves render as code and neither carries a dangling marker.

   Counting is by LINES beginning with ```, which is what a fence actually is — a ``` inside a line of prose
   ("use ```js to fence it") is not a block delimiter and must not flip the state. The reserve below is why
   the split is given less room: the two markers we add have to fit under the same limit. */
const FENCE_RESERVE = 8;   // '\n```' opening + '```\n' closing, with slack
function reopenFences(chunks) {
  let open = false;
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    let c = chunks[i];
    if (open) c = '```\n' + c;                        // continue the block this chunk starts inside
    const fences = (c.match(/^[ \t]{0,3}```/gm) || []).length;
    if (fences % 2 === 1) { c = c.replace(/\s*$/, '') + '\n```'; open = true; }
    else open = false;
    out.push(c);
  }
  return out;
}

/* split text into <=max-length pieces, preferring to break at the last newline/space so words/lines stay
   whole. chunkTextParts returns BOTH views, aligned 1:1: `send` carries the fence-doctored chunks the wire
   wants (reopenFences injects synthetic ``` markers), `raw` the undecorated splits of the original text.
   A delivery keeps each part as it was cut and goes on from its next unsent part, so no undelivered remainder is ever
   joined and chunked again (done over decorated chunks, that left stray ``` lines on every retry). */
function chunkTextParts(text, max) {
  const s = String(text == null ? '' : text);
  // A non-positive `max` makes `end === i` below, so the loop pushes '' forever without advancing. No
  // caller passes one today (adapters default to 4096), but an unbounded loop is not a thing to leave
  // one bad config away.
  max = (typeof max === 'number' && isFinite(max) && max > 0) ? Math.floor(max) : 4096;
  if (s.length <= max) { const one = s.length ? [s] : []; return { raw: one, send: one }; }
  // Leave room for the fence markers reopenFences may add, but ONLY when there is a fence to worry about —
  // an ordinary long reply keeps the exact old boundaries.
  const fenced = /^[ \t]{0,3}```/m.test(s);
  const room = fenced ? Math.max(1, max - FENCE_RESERVE) : max;
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + room, s.length);
    if (end < s.length) {
      const slice = s.slice(i, end);
      const nl = slice.lastIndexOf('\n');
      const sp = slice.lastIndexOf(' ');
      const cut = nl > room * 0.5 ? nl : (sp > room * 0.5 ? sp : -1);
      if (cut > 0) end = i + cut + 1;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return { raw: out, send: fenced ? reopenFences(out) : out };
}
function chunkText(text, max) { return chunkTextParts(text, max).send; }

module.exports = { chunkTextParts, chunkText, reopenFences, FENCE_RESERVE };
