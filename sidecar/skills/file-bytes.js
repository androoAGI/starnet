/* sidecar/skills/file-bytes.js - THE canonical-bytes boundary for skill files (gh#145, bug a36d1b00, 2026-10-28).

   A skill file is BYTES. It travels as a JSON entry { path, encoding, content } (the skill log, a package manifest, a
   tool argument) and as a file on disk (the package mirror, the Skill Market folder), and every hop used to decode or
   encode it on its own: the diverged mirror wrote a base64 entry's text to disk (a line of base64 where
   references/setup.md belonged), readSupportFiles read that text back as "text", digests hashed the encoding instead
   of the bytes (the same file approved as base64 asked again as text), and the write path ran a log redactor over
   code. Every crossing now goes through this module, once in each direction:

     bytesOf(file)          decode ONCE: a Buffer `bytes`, a base64 entry, or text ('utf8' or no encoding) -> Buffer
     toEntry(path, bytes)   encode ONCE: the one stored form. Bytes that are exact UTF-8 are stored as that text
                            ('utf8'); anything else as base64. Same bytes in, same entry out, whatever they came as.
     textOf(x)              the exact UTF-8 text of these bytes, or null (a lossless round trip is the test, so a BOM,
                            CRLF and every code point survive)
     readableText(x)        textOf without NUL: what a person or a model may be shown as text (a NUL never appears
                            in a text file; a blob holding one is binary, even when it decodes)
     contentKey(file)       the bytes as a digest reads them: their exact text, else BINARY_KEY + their canonical
                            base64. An entry stored as base64 and the same bytes stored as text give the SAME key, and a
                            binary file never keys like a text file holding its base64.
     sameBytes(a, b), byteLength(file)

   Never throws on a malformed entry: bad base64 decodes to what Node makes of it, exactly as before; the package
   format (package-format.js) stays the strict validator for a manifest that claims a digest. */
'use strict';

function str(v) { return v == null ? '' : String(v); }
function isBuffer(v) { return typeof Buffer !== 'undefined' && Buffer.isBuffer(v); }

function bytesOf(file) {
  if (file == null) return Buffer.alloc(0);
  if (isBuffer(file)) return Buffer.from(file);
  if (typeof file === 'string') return Buffer.from(file, 'utf8');
  if (isBuffer(file.bytes)) return Buffer.from(file.bytes);   // `bytes` is also a byte COUNT on manifests: only a Buffer is content
  if (str(file.encoding).toLowerCase() === 'base64') return Buffer.from(str(file.content), 'base64');
  return Buffer.from(str(file.content), 'utf8');
}
function textOf(x) {
  const b = isBuffer(x) ? x : bytesOf(x);
  const t = b.toString('utf8');
  return Buffer.from(t, 'utf8').equals(b) ? t : null;
}
function readableText(x) {
  const t = textOf(x);
  return t != null && t.indexOf('\u0000') < 0 ? t : null;
}
function toEntry(path, bytes, extra) {
  const b = isBuffer(bytes) ? bytes : bytesOf(bytes);
  const t = textOf(b);
  const out = { path: str(path), encoding: t == null ? 'base64' : 'utf8', content: t == null ? b.toString('base64') : t };
  if (extra && typeof extra === 'object') for (const k of Object.keys(extra)) if (!(k in out)) out[k] = extra[k];
  return out;
}
function canonical(file, extra) {
  return toEntry(file && file.path, bytesOf(file), extra);
}
/* A lone low surrogate. textOf only returns text that round-trips through UTF-8 and a lone surrogate never does, so no
   text file's key can start with it. A text file keys exactly as before (its approvals stay put); a binary file's key
   moved, and the store re-stamps it at load like any other moved digest (skillstore settleLoaded, gate.restampApprovals). */
const BINARY_KEY = '\uDFFF';
function contentKey(file) {
  const b = bytesOf(file);
  const t = textOf(b);
  return t == null ? BINARY_KEY + b.toString('base64') : t;
}
function sameBytes(a, b) { return bytesOf(a).equals(bytesOf(b)); }
function byteLength(file) {
  if (file && !isBuffer(file) && typeof file === 'object' && str(file.encoding).toLowerCase() !== 'base64' && !isBuffer(file.bytes)) return Buffer.byteLength(str(file.content), 'utf8');
  return bytesOf(file).length;
}

module.exports = { bytesOf, textOf, readableText, toEntry, canonical, contentKey, sameBytes, byteLength, BINARY_KEY };
