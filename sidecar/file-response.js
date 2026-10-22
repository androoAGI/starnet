/* sidecar/file-response.js — shared file/download response policy. */
'use strict';

const path = require('node:path');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.opus': 'audio/ogg; codecs=opus'
});

const CHANNEL_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const ACTIVE_DELIVERABLE_EXTS = new Set(['.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.svg', '.xml', '.xsl', '.xslt', '.wasm']);

function mimeForPath(file) {
  const mime = MIME[path.extname(String(file || '')).toLowerCase()];
  return mime ? String(mime).split(';')[0].trim() : 'application/octet-stream';
}

function safeDownloadName(file) {
  return path.basename(file).replace(/[^A-Za-z0-9_.-]/g, '_') || 'download';
}

function isActiveDeliverable(file) {
  return ACTIVE_DELIVERABLE_EXTS.has(path.extname(file).toLowerCase());
}

// Parse one RFC 7233 byte range. Multi-range requests are deliberately unsupported because the media/file
// callers only need seeking and resumable single ranges.
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return { unsatisfiable: true };
  let start;
  let end;
  if (match[1] === '') {
    const count = parseInt(match[2], 10);
    if (!count) return { unsatisfiable: true };
    start = Math.max(0, size - count);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] === '' ? size - 1 : Math.min(parseInt(match[2], 10), size - 1);
  }
  if (!(start >= 0) || start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

/* THE READABLE DOCUMENT VIEW (live walk 10-14: OPEN on a worker's tagline.md landed on raw text in a white, unstyled
   browser tab). A deliverable is a thing to use (deliverable-open-not-read): in a browser — where the station cannot
   hand a file to the OS — a TEXT deliverable opens on a station-dark reading page instead. Every byte is escaped
   into one <pre>; the page carries no script and loads nothing (DOC_VIEW_CSP), so it is exactly as inert as the
   raw text it replaces. Pages (.html) keep the BROWSER window, media the lightbox/players, binaries the OS. */
const TEXT_DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.log', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.py', '.ts', '.tsx', '.jsx', '.css', '.scss', '.sh', '.ps1', '.bat', '.sql', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.cs', '.php']);
const DOC_VIEW_MAX_BYTES = 1024 * 1024;
const DOC_VIEW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
function isTextDocument(file) { return TEXT_DOC_EXTS.has(path.extname(String(file || '')).toLowerCase()); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* MARKDOWN, READ AS THE FINISHED DOCUMENT (review 10-14: the doc view showed "# Agent OS Launch Tagline" with its raw
   marks). ESCAPE FIRST, then a small block subset — headings, paragraphs (the author's line breaks kept), lists,
   quotes, rules, pipe tables, fenced code — and inline **bold**, *em*, `code`, ~~strike~~ and http(s) links. Every
   tag on the page is one this function writes; file text only ever lands escaped, so the page is as inert as <pre>. */
const MD_FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const MD_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const MD_BULLET = /^\s*[-*+]\s+(.*)$/;
const MD_NUMBER = /^\s*\d{1,9}[.)]\s+(.*)$/;
const MD_QUOTE = /^\s{0,3}>\s?(.*)$/;
const MD_TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
function mdInline(raw) {
  const codes = [];
  let s = escapeHtml(raw).replace(/`([^`]{1,500})`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = s.replace(/\[([^\]]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]{1,500}?)\*\*|__([^_]{1,500}?)__/g, (m, a, b) => '<strong>' + (a || b) + '</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]{0,500}?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\s][^_]{0,500}?)_(?![\w_])/g, '$1<em>$2</em>')
    .replace(/~~([^~]{1,500}?)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[Number(i)] + '</code>');
}
function mdCells(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}
function markdownHtml(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  // line k continues the paragraph: it is text and opens no block of its own
  const plain = k => { const l = lines[k]; return !!l.trim() && !MD_FENCE.test(l) && !MD_RULE.test(l) && !MD_HEADING.test(l) && !MD_BULLET.test(l)
    && !MD_NUMBER.test(l) && !MD_QUOTE.test(l) && !(/^\s*\|/.test(l) && MD_TABLE_SEP.test(lines[k + 1] || '')); };
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = MD_FENCE.exec(l);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !(MD_FENCE.test(lines[i]) && lines[i].trim().startsWith(fence[1].charAt(0).repeat(3)))) body.push(lines[i++]);
      i++;   // the closing fence (or the end of the file)
      out.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
      continue;
    }
    const h = MD_HEADING.exec(l);
    if (h) { out.push('<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
    if (MD_RULE.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*\|/.test(l) && MD_TABLE_SEP.test(lines[i + 1] || '')) {
      const head = mdCells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(mdCells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (MD_QUOTE.test(l)) {
      const q = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) q.push(MD_QUOTE.exec(lines[i++])[1]);
      out.push('<blockquote>' + markdownHtml(q.join('\n')) + '</blockquote>');
      continue;
    }
    if (MD_BULLET.test(l) || MD_NUMBER.test(l)) {
      const re = MD_BULLET.test(l) ? MD_BULLET : MD_NUMBER, tag = re === MD_BULLET ? 'ul' : 'ol';
      const items = [];
      while (i < lines.length && re.test(lines[i])) items.push('<li>' + mdInline(re.exec(lines[i++])[1]) + '</li>');
      out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || plain(i))) para.push(mdInline(lines[i++].trim()));
    out.push('<p>' + para.join('<br>') + '</p>');
  }
  return out.join('\n');
}
function isMarkdownDocument(file) { return /\.(md|markdown)$/i.test(String(file || '')); }
function documentViewHtml(name, text) {
  const title = escapeHtml(path.basename(String(name || 'document')));
  const md = isMarkdownDocument(name);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="referrer" content="no-referrer"><title>' + title + '</title><style>'
    + ':root{color-scheme:dark}html,body{margin:0;background:#0b0904;color:#ffd9a3}'
    + 'body{font:15px/1.65 ui-monospace,"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace}'
    + 'main{max-width:900px;margin:0 auto;padding:28px 22px 56px}'
    + 'header{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid #4a3410;padding-bottom:10px;margin-bottom:20px}'
    + 'header .name{margin:0;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#ffaa33;font-weight:600;word-break:break-all}'
    + 'header span{font-size:11px;letter-spacing:.12em;color:#b9791c;text-transform:uppercase;margin-left:auto}'
    + 'pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:#ffe6c2}'
    + '.doc{color:#ffe6c2;overflow-wrap:anywhere}.doc h1,.doc h2,.doc h3,.doc h4,.doc h5,.doc h6{color:#ffaa33;line-height:1.3;margin:1.4em 0 .5em}'
    + '.doc h1{font-size:24px}.doc h2{font-size:19px}.doc h3{font-size:16px}.doc h4,.doc h5,.doc h6{font-size:15px}.doc>:first-child{margin-top:0}'
    + '.doc p,.doc ul,.doc ol,.doc blockquote,.doc table,.doc pre{margin:0 0 1em}.doc ul,.doc ol{padding-left:1.6em}.doc li{margin:.2em 0}'
    + '.doc strong{color:#fff1dc}.doc a{color:#ffc266}.doc del{opacity:.7}'
    + '.doc code{background:#1d160a;border:1px solid #3a2a0e;border-radius:3px;padding:0 .3em}'
    + '.doc pre{background:#140f06;border:1px solid #3a2a0e;border-radius:6px;padding:12px 14px}.doc pre code{background:none;border:0;padding:0}'
    + '.doc blockquote{border-left:3px solid #b9791c;margin-left:0;padding-left:14px;color:#e6c08a}.doc hr{border:0;border-top:1px solid #4a3410;margin:1.6em 0}'
    + '.doc table{border-collapse:collapse}.doc th,.doc td{border:1px solid #4a3410;padding:4px 10px;text-align:left}.doc th{color:#ffaa33}'
    + '::selection{background:#ffaa33;color:#0b0904}'
    + '</style></head><body><main><header><div class="name">' + title + '</div><span>Agent OS · read-only</span></header>'
    + (md ? '<article class="doc">' + markdownHtml(text) + '</article>' : '<pre>' + escapeHtml(text) + '</pre>') + '</main></body></html>';
}

module.exports = { MIME, CHANNEL_UPLOAD_MAX_BYTES, mimeForPath, safeDownloadName, isActiveDeliverable, parseRange,
  isTextDocument, documentViewHtml, DOC_VIEW_CSP, DOC_VIEW_MAX_BYTES };
