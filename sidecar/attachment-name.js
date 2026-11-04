/* sidecar/attachment-name.js — THE ONE RULE FOR A SENDER-CHOSEN FILE NAME (AND MEDIA TYPE) THAT ANYTHING ECHOES
   (attachment-rows-and-taint, repair 2026-11-04).

   THE PROBLEM. A file name is text somebody else chose: whoever made or renamed the file, not the Commander. Since a run holds
   an attachment's taint only while its BYTES are re-sent, a file that sends none (a PDF, an archive, an old Office file) or a
   turn after the bytes have left is a clean run, and the name is then the one stretch of third-party text in front of the
   model: in the binary note, the header and the marker of the file, in the label of a turn sent with no words, in the
   '[attached: name]' of the earlier-conversation note and of recall. Every one of those used to clean the name its own way, or
   not at all, and two of them (the binary note and the label) did not clean it, so a name could end the bracket it sits in, add
   a line that reads as a system notice, close a frame the note is wrapped in, or hide text with a bidi control.

   THE RULE, in one place so no producer can keep its own copy:
     one line      every control character (C0, DEL, C1 including NEL), line and paragraph separator, and any run of
                   whitespace becomes one space
     no structure  square and angle brackets become a space: a name cannot end the bracket it sits in or open or close a tag
     nothing hidden format, private-use and lone-surrogate code points are dropped (zero-width, the bidi overrides and isolates,
                   the BOM, the invisible tag characters): a reader sees exactly what the model reads
     bounded       at most NAME_MAX code points (never a split surrogate pair); an empty result is 'file'
   The media type is not free text either: cleanMime keeps a plain 'type/subtype' token, else ''. Both are idempotent
   (clean(clean(x)) === clean(x)), which is what lets a test prove a producer only ever sees the cleaned form.

   What this does NOT do: it does not make a name harmless. One line of words is still words. What bounds the exposure of a
   name on a clean run is this rule, and what bounds a file's text is the taint lock. docs/DECISIONS.md records the choice.

   Pure: no clock, no I/O. */
'use strict';

const NAME_MAX = 120;
const DROPPED = /[\p{Cf}\p{Co}\p{Cs}]/gu;                       // hidden or private code points: gone, not a space
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}\[\]<>]+/gu;                 // controls, separators and brackets: a space
const MIME = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;

function cleanName(name, max) {
  const limit = Number.isSafeInteger(max) && max > 0 ? max : NAME_MAX;
  const text = String(name == null ? '' : name).replace(DROPPED, '').replace(BREAKS, ' ').replace(/\s+/g, ' ').trim();
  const cut = Array.from(text).slice(0, limit).join('').trim();
  return cut || 'file';
}

// 'image/png' -> 'image/png'; 'Text/Plain; charset=utf-8' -> 'text/plain'; anything that is not a plain token -> ''
function cleanMime(mime) {
  const essence = String(mime == null ? '' : mime).split(';')[0].trim().toLowerCase();
  return MIME.test(essence) ? essence : '';
}

module.exports = { NAME_MAX, cleanName, cleanMime };
