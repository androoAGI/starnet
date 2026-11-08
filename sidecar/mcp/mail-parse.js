'use strict';
/* sidecar/mcp/mail-parse.js — a small, bounded RFC 5322 / MIME reader for mail fetched over IMAP.

   Enough to turn a raw message into what an agent needs: decoded headers (RFC 2047 encoded words), the readable
   text (the plain part, unless it is empty or the HTML part clearly says more: see pickText), and an attachment inventory (name, type, size —
   never the bytes). Tolerates truncated input (a capped fetch) and caps recursion depth and part count. */

const MAX_DEPTH = 8;
const MAX_PARTS = 200;

function decodeCharset(buf, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs, { fatal: false }).decode(buf); }
  catch (_) { return buf.toString('latin1'); }
}

function decodeQP(text) {
  const s = String(text).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else { const b = Buffer.from(c, 'latin1'); bytes.push(b[0]); }
  }
  return Buffer.from(bytes);
}

// RFC 2047: =?charset?B|Q?text?=  (adjacent encoded words separated only by whitespace are joined)
function decodeWords(value) {
  return String(value || '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, cs, enc, txt) => {
      try {
        const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : decodeQP(txt.replace(/_/g, ' '));
        return decodeCharset(buf, cs.replace(/\*.*$/, ''));
      } catch (_) { return all; }
    });
}

function splitHeaderBody(buf) {
  let i = buf.indexOf('\r\n\r\n'), skip = 4;
  const j = buf.indexOf('\n\n');
  if (i < 0 || (j >= 0 && j < i)) { i = j; skip = 2; }
  if (i < 0) return { head: headText(buf), body: Buffer.alloc(0) };
  return { head: headText(buf.slice(0, i)), body: buf.slice(i + skip) };
}
// Raw 8-bit header bytes are usually UTF-8 (RFC 6532); fall back to latin1 only when they are not valid UTF-8.
function headText(b) { const u = b.toString('utf8'); return u.includes('�') ? b.toString('latin1') : u; }

function parseHeaders(headText) {
  const out = [];
  const lines = String(headText).split(/\r?\n/);
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length) { out[out.length - 1].value += ' ' + line.trim(); continue; }
    const m = /^([^:\s]+):\s?(.*)$/.exec(line);
    if (m) out.push({ name: m[1].toLowerCase(), value: m[2] });
  }
  return out;
}
function header(headers, name) { const h = headers.find(x => x.name === name); return h ? h.value : ''; }

// Content-Type / Content-Disposition: value; k=v; k="v"; filename*=UTF-8''...
function parseParams(value) {
  const parts = String(value || '').split(';');
  const main = parts.shift().trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const m = /^\s*([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/.exec(p);
    if (!m) continue;
    let k = m[1].toLowerCase(), v = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : (m[3] || '').trim();
    if (/\*$/.test(k) || /\*\d+\*?$/.test(k)) {
      // RFC 2231 extended value: charset'lang'%XX-encoded (only the first segment carries the charset)
      const ext = /^([^']*)'[^']*'(.*)$/.exec(v);
      const pct = s => Buffer.from(s.replace(/%([0-9A-Fa-f]{2})|([\s\S])/g, (a, hex, ch) => hex ? String.fromCharCode(parseInt(hex, 16)) : ch), 'latin1');
      v = decodeCharset(pct(ext ? ext[2] : v), ext ? (ext[1] || 'utf-8') : 'utf-8');
      k = k.replace(/\*\d*\*?$/, '');
      params[k] = (params[k] && /\*\d/.test(m[1]) ? params[k] : '') + v;
    } else if (!(k in params)) params[k] = v;
  }
  return { value: main, params };
}

function decodeBody(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQP(buf.toString('latin1'));
  return buf;
}

/* ONE LINEAR PASS over the tags (sweep 2026-10-03). The regexes this replaces were QUADRATIC on hostile input: an HTML mail of
   240 KB of "<" took 18 s, and up to the 4 MiB read cap is over an hour — synchronous, so the whole sidecar (E-STOP, every run,
   every route) froze when an agent read one crafted email. Same text out: a <script>/<style>/<head> with its closing tag goes
   whole; one with no closing tag is just a tag; <br> and the end of a block are line breaks; any other tag is a space; "<>" and a
   "<" with no ">" after it stay text. A closing-tag search is remembered per name, so a run of opening tags never rescans.
   WHAT A NEWSLETTER SAYS (customer, 11-04..11-08: "some emails return almost nothing except links or footer text"): an
   <img>'s alt text is what the picture says, so it is kept (an image-only mail had no words at all without it); an HTML
   comment goes whole, so an Outlook-only <!--[if mso]> block no longer leaks a second copy or half a comment; the end of a
   table, list, quote or section is a line break. The comment-end search is remembered the same way, so it stays linear. */
function stripTags(src) {
  const s = String(src), lower = s.toLowerCase(), n = s.length, out = [], closeAt = Object.create(null);
  const findFrom = (needle, from) => {
    const c = closeAt[needle];
    if (c && (c.at < 0 || c.at >= from)) return c.at;
    const at = lower.indexOf(needle, from);
    closeAt[needle] = { at };
    return at;
  };
  const closeOf = (name, from) => findFrom('</' + name, from);
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const end = findFrom('-->', lt + 4);
      if (end >= 0) { out.push(' '); i = end + 3; continue; }
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) { out.push(s.slice(lt)); break; }
    if (gt === lt + 1) { out.push('<>'); i = gt + 1; continue; }
    const m = /^\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(s.slice(lt + 1, Math.min(gt, lt + 40)));
    const closing = !!(m && m[1]), name = m ? m[2].toLowerCase() : '';
    if (!closing && (name === 'script' || name === 'style' || name === 'head')) {
      const end = closeOf(name, gt + 1), endGt = end < 0 ? -1 : s.indexOf('>', end);
      if (endGt >= 0) { out.push(' '); i = endGt + 1; continue; }
    }
    if (!closing && name === 'img') {
      const alt = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(s.slice(lt, gt));
      const said = alt ? (alt[1] != null ? alt[1] : alt[2] != null ? alt[2] : alt[3]).trim() : '';
      out.push(said ? ' ' + said + ' ' : ' ');
      i = gt + 1;
      continue;
    }
    out.push(name === 'br' ? '\n' : (closing && /^(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article|header|footer|center)$/.test(name)) ? '\n' : ' ');
    i = gt + 1;
  }
  return out.join('');
}
// The named entities mail actually uses (typography, currency, accented letters, and the zero-width spacers newsletters pad
// their preview line with). Matched case-sensitively, as HTML does, except the five ASCII ones, which mail writes in any case.
const ENTITY = (() => {
  const t = { rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„', prime: '′', Prime: '″', mdash: '—', ndash: '–',
    minus: '−', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢',
    curren: '¤', deg: '°', times: '×', divide: '÷', plusmn: '±', micro: 'µ', para: '¶', sect: '§', dagger: '†', Dagger: '‡',
    laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', check: '✓',
    iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', ordf: 'ª', ordm: 'º',
    szlig: 'ß', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ', yuml: 'ÿ',
    ensp: ' ', emsp: ' ', thinsp: ' ', hairsp: ' ', numsp: ' ', puncsp: ' ', zwnj: '', zwj: '', shy: '', lrm: '', rlm: '',
    ZeroWidthSpace: '', NoBreak: '' };
  const marks = { acute: '́', grave: '̀', circ: '̂', uml: '̈', tilde: '̃', ring: '̊', cedil: '̧', slash: '̸' };
  for (const [mark, comb] of Object.entries(marks)) for (const base of 'aeiouyncAEIOUYNC') {
    const ch = (base + comb).normalize('NFC');
    if (ch.length === 1) t[base + mark] = ch;
  }
  t.oslash = 'ø'; t.Oslash = 'Ø';
  return t;
})();
const ENTITY_ANY_CASE = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(text) {
  return String(text).replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (all, dec, hex, name) => {
    if (name) {
      if (Object.prototype.hasOwnProperty.call(ENTITY, name)) return ENTITY[name];
      const lc = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITY_ANY_CASE, lc) ? ENTITY_ANY_CASE[lc] : all;
    }
    const cp = dec != null ? Number(dec) : parseInt(hex, 16);
    if (!(cp > 0 && cp <= 0x10FFFF) || (cp >= 0xD800 && cp <= 0xDFFF)) return ' ';
    return String.fromCodePoint(cp);
  });
}
function htmlToText(html) {
  return decodeEntities(stripTags(html))
    // the padding a newsletter puts after its preview line (zero-width joiners, soft hyphens, grapheme joiners) says nothing
    .replace(/[­͏᠎​-‏⁠﻿]/g, '').replace(/[  -   　]/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function splitMultipart(body, boundary) {
  const text = body.toString('latin1');
  const delim = '--' + boundary;
  const parts = [];
  let pos = text.indexOf(delim);
  if (pos < 0) return parts;
  for (;;) {
    let start = pos + delim.length;
    if (text.startsWith('--', start)) break;                  // closing delimiter
    const eol = text.indexOf('\n', start);
    if (eol < 0) break;
    start = eol + 1;
    const nextAt = text.indexOf('\n' + delim, start);
    const end = nextAt < 0 ? text.length : (text[nextAt - 1] === '\r' ? nextAt - 1 : nextAt);
    parts.push(body.slice(start, Math.max(start, end)));
    if (nextAt < 0 || parts.length >= MAX_PARTS) break;           // truncated input: keep what arrived
    pos = nextAt + 1;
  }
  return parts;
}

function walk(buf, state, depth) {
  if (depth > MAX_DEPTH || state.parts >= MAX_PARTS) return;
  state.parts++;
  const { head, body } = splitHeaderBody(buf);
  const headers = parseHeaders(head);
  const ct = parseParams(header(headers, 'content-type') || 'text/plain');
  const disp = parseParams(header(headers, 'content-disposition'));
  const filename = decodeWords(disp.params.filename || ct.params.name || '');
  if (/^multipart\//.test(ct.value) && ct.params.boundary) {
    for (const p of splitMultipart(body, ct.params.boundary)) walk(p, state, depth + 1);
    return;
  }
  if (ct.value === 'message/rfc822' && disp.value !== 'attachment') { walk(body, state, depth + 1); return; }
  const isText = /^text\/(plain|html)$/.test(ct.value);
  if (isText && disp.value !== 'attachment' && !filename) {
    const text = decodeCharset(decodeBody(body, header(headers, 'content-transfer-encoding')), ct.params.charset);
    (ct.value === 'text/plain' ? state.plain : state.html).push(text);
    return;
  }
  const decoded = decodeBody(body, header(headers, 'content-transfer-encoding'));
  state.attachments.push({ filename: filename || '(unnamed)', mimeType: ct.value, size: decoded.length });
}

/* WHICH PART IS THE MESSAGE. The plain part used to win whenever there was one, even an empty one. A newsletter's plain part is
   often a stub ("View this email in your browser: https://…", then the footer) or a cut-down summary, while the HTML part holds
   the message, so an agent read the stub, and textTruncated said false because nothing had been cut. The plain part still wins
   when it carries about as much as the HTML (every ordinary mail); the HTML wins when the plain part is empty, or when the HTML
   reads clearly more: at least half again as many letters and digits, and 150 more, not counting web addresses. A capped preview
   (preferPlain: the list's 6 KB slice can end inside the HTML's <style>) keeps the plain part whenever it has text. */
function substance(text) {
  return String(text || '').replace(/\b(?:https?:\/\/|mailto:|www\.)\S+/gi, ' ').replace(/[^\p{L}\p{N}]+/gu, '').length;
}
function pickText(plain, html, preferPlain) {
  if (!plain) return html ? 'text/html' : '';
  if (!html || preferPlain) return 'text/plain';
  const p = substance(plain), h = substance(html);
  return (h >= p * 1.5 && h - p >= 150) ? 'text/html' : 'text/plain';
}

/* parseMessage(buf, { maxText, preferPlain }) -> { headers: {from,to,cc,subject,date,messageId,replyTo}, text, textSource,
   textTruncated, attachments }. textSource names the part the text came from ('text/plain', 'text/html', or '' for none). */
function parseMessage(raw, opts) {
  const maxText = Math.max(200, Number(opts && opts.maxText) || 100000);
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  const { head } = splitHeaderBody(buf);
  const hs = parseHeaders(head);
  const state = { plain: [], html: [], attachments: [], parts: 0 };
  walk(buf, state, 0);
  const plain = state.plain.join('\n\n').replace(/\r\n/g, '\n').trim();
  const html = state.html.length ? htmlToText(state.html.join('\n')).replace(/\r\n/g, '\n').trim() : '';
  const textSource = pickText(plain, html, !!(opts && opts.preferPlain));
  let text = textSource === 'text/html' ? html : plain;
  const textTruncated = text.length > maxText;
  if (textTruncated) text = text.slice(0, maxText);
  const h = n => decodeWords(header(hs, n));
  return {
    headers: { from: h('from'), to: h('to'), cc: h('cc'), replyTo: h('reply-to'), subject: h('subject'), date: h('date'), messageId: h('message-id') },
    text, textSource, textTruncated, attachments: state.attachments.slice(0, 100)
  };
}

function snippetOf(text, n) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n || 200); }

module.exports = { parseMessage, parseHeaders, parseParams, decodeWords, decodeQP, htmlToText, snippetOf };
