/* node test/chat-linkify.test.js — behavioral lock for chat.js linkify() URL trimming.

   Bug (2026-07-17): some models (Kimi K3 observed live) emit links wrapped in markdown bold —
   `**http://localhost:5295**`. linkify's URL regex is greedy over non-space chars and its
   trailing-trim set only covered sentence punctuation, so the closing `**` was baked into the
   href → `http://localhost:5295**` → dead link in a new tab. The fix adds markdown emphasis/
   code markers (`*`, backtick) to the trailing-trim set. GPT-style output (bare URLs) never
   hit this, which made it look like a per-model failure; it's a harness linkifier bug.

   chat.js is browser-flow and not node-loadable, but linkify + escapeHtml are pure and
   self-contained — extract them from source and exercise them for real. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');

function extract(name) {
  const m = new RegExp('(  function ' + name + '\\([\\s\\S]*?\\n  \\})').exec(src);
  A.ok(m, 'chat.js still defines ' + name + '()');
  return m[1];
}
const escapeOwner = require('../frontend/js/util.js');
A.ok(typeof escapeOwner.esc === 'function', 'the production escape owner is loaded');
// eslint-disable-next-line no-new-func
const linkify = new Function('U', extract('escapeHtml') + '\n' + extract('linkify') + '\nreturn linkify;')(escapeOwner);
function hrefOf(html) { const m = /href="([^"]*)"/.exec(html); return m && m[1]; }

// the observed live failure: bold-wrapped URL — the trailing ** must NOT ride into the href
let out = linkify('Fresh server is up:\n\n**http://localhost:5295**');
A.eq(hrefOf(out), 'http://localhost:5295', 'bold-wrapped URL: trailing ** trimmed from href');
A.ok(out.indexOf('http://localhost:5295**<') === -1, 'anchor text does not carry the ** either');

// backtick-wrapped URL (`http://x`) — same class of model markup
out = linkify('see `http://localhost:8787/api/models` for the catalog');
A.eq(hrefOf(out), 'http://localhost:8787/api/models', 'backtick-wrapped URL: trailing ` trimmed from href');

// sentence punctuation trim still holds (the original behavior)
out = linkify('go to https://example.com/docs, then report back.');
A.eq(hrefOf(out), 'https://example.com/docs', 'trailing sentence punctuation still trimmed');

// a bare URL is untouched
out = linkify('https://example.com/a_b*c/path');
A.eq(hrefOf(out), 'https://example.com/a_b*c/path', 'mid-URL * survives; only TRAILING markers trim');

// XSS invariant unchanged: surrounding text is escaped
out = linkify('<b>x</b> http://example.com');
A.ok(out.indexOf('&lt;b&gt;') !== -1 && out.indexOf('<b>') === -1, 'non-URL text stays HTML-escaped');

// QA 2026-10-02: a ')' that closes a '(' inside the URL belongs to it; an unbalanced one is sentence punctuation
A.eq(hrefOf(linkify('see https://en.wikipedia.org/wiki/Foo_(bar) for more')), 'https://en.wikipedia.org/wiki/Foo_(bar)', 'a balanced paren stays in the link (it was cut to …Foo_(bar, a 404)');
A.eq(hrefOf(linkify('(see https://example.com/a)')), 'https://example.com/a', 'a URL wrapped in parentheses still drops the closing one');
A.eq(hrefOf(linkify('read https://en.wikipedia.org/wiki/Foo_(bar).')), 'https://en.wikipedia.org/wiki/Foo_(bar)', 'a balanced paren then a full stop keeps the paren and drops the stop');
out = linkify('(https://en.wikipedia.org/wiki/Foo_(bar))');
A.eq(hrefOf(out), 'https://en.wikipedia.org/wiki/Foo_(bar)', 'nested: the inner pair is the URL\'s, the outer close is the sentence\'s');
A.ok(/<\/a>\)$/.test(out), 'and the outer close stays as text after the link');

A.report('chat-linkify.test');
