/* node test/chat-code-url-link.test.js — behavioral lock for chat.js reportInline() URL links.

   Bug (2026-10-02): an agent finished a game and wrote "open `http://localhost:8765`". The COMMS
   renderer's tokenizer matched the backtick code span FIRST, so the URL became inert code text —
   no link, the user had to copy-paste the address. `**http://x**` hit the same dead end through
   the bold branch. linkify() itself already trimmed the markers (chat-linkify.test.js); the newer
   reportInline() tokenizer never reached it.

   reportInline + its helpers are pure — extract them from source and exercise them for real. */
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
const reportInline = new Function('U', extract('escapeHtml') + '\n' + extract('linkify') + '\n' +
  extract('hostOf') + '\n' + extract('linkHostNote') + '\n' + extract('reportInline') + '\nreturn reportInline;')(escapeOwner);
function hrefOf(html) { const m = /href="([^"]*)"/.exec(html); return m && m[1]; }

// the observed live failure: a backticked server address must be a clickable link, still code-styled
let out = reportInline('To play: open `http://localhost:8765` (the server is up).');
A.eq(hrefOf(out), 'http://localhost:8765', 'backticked URL becomes a link');
A.ok(/<a [^>]*><code class="md-code">http:\/\/localhost:8765<\/code><\/a>/.test(out), 'link keeps the code styling inside it');

// bold-wrapped URL links too
out = reportInline('Server: **http://localhost:5295/play**');
A.eq(hrefOf(out), 'http://localhost:5295/play', 'bolded URL becomes a link');
A.ok(out.indexOf('<span class="md-b">') !== -1, 'bold styling kept');

// ordinary code spans stay plain code — no link
out = reportInline('run `npm start` or open `C:\\Users\\x\\index.html`');
A.eq(hrefOf(out), null, 'non-URL code spans are not links');

// a code span that merely CONTAINS a URL is a command, not a link
out = reportInline('try `curl http://localhost:8765/api`');
A.eq(hrefOf(out), null, 'code with a URL inside a command stays code');

// XSS invariant: quotes / markup inside a URL-looking code span never escape the attribute
out = reportInline('`http://x.test/"onmouseover="alert(1)`');
A.ok(out.indexOf('"onmouseover') === -1, 'a quote in a code span cannot break out of href');
out = reportInline('**<b>x</b> http://example.com**');
A.ok(out.indexOf('<b>') === -1 && out.indexOf('&lt;b&gt;') !== -1, 'bold text stays HTML-escaped');

// QA 2026-10-02: bold's inside is read again — code, [label](url) and bare links inside **…** render, never raw markers
{
  const b1 = reportInline('run **`npm run dev`** now');
  A.ok(b1.includes('<span class="md-b"><code class="md-code">npm run dev</code></span>') && !b1.includes('`'), 'a code span inside bold renders as code (no raw backticks): ' + b1);
  const b2 = reportInline('**[docs](https://x.com/a)**');
  A.ok(b2 === '<span class="md-b"><a href="https://x.com/a" target="_blank" rel="noopener noreferrer">docs</a></span>', 'a markdown link inside bold is one link with its label: ' + b2);
  const b3 = reportInline('**see https://x.com/a b**');
  A.ok(b3.includes('<span class="md-b">see <a href="https://x.com/a"'), 'a bare URL inside bold still links: ' + b3);
  const b4 = reportInline('**<img src=x onerror=alert(1)>**');
  A.ok(!b4.includes('<img') && b4.includes('&lt;img'), 'bold content stays escaped');
}
// QA 2026-10-02: a label that names a different host than its target shows where the link really goes
{
  const l1 = reportInline('[https://bank.com](https://evil.com/login)');
  A.ok(l1.includes('>https://bank.com</a> <span class="md-host">(evil.com)</span>'), 'a mismatched address label is followed by the real host: ' + l1);
  const l2 = reportInline('[github.com/foo](https://github.com/foo)');
  A.ok(!l2.includes('md-host'), 'a label on the same host gets no note');
  const l3 = reportInline('[the docs](https://evil.com)');
  A.ok(!l3.includes('md-host'), 'a plain-word label gets no note');
  const l4 = reportInline('[www.bank.com](https://bank.com)');
  A.ok(!l4.includes('md-host'), 'www. is the same host');
  // review 10-02: a version or a file name is not a host
  for (const label of ['v0.12.5', 'README.md', 'app.js', 'release-notes.txt']) {
    A.ok(!reportInline('[' + label + '](https://github.com/x/y)').includes('md-host'), '"' + label + '" gets no host note');
  }
  A.ok(reportInline('[docs.evil.io](https://github.com/x)').includes('(github.com)'), 'a real bare domain label still does');
  A.ok(reportInline('[https://README.md](https://github.com/x)').includes('(github.com)'), 'and so does anything written as an address');
}

A.report('chat-code-url-link.test');
