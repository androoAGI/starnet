/* node test/chat-code-copy.test.js — fenced COMMS blocks are independently copyable.

   A message-level copy control already existed, but fenced code rendered as a bare .md-pre span. That made
   a response with several sections all-or-nothing: users had to drag-select a single code block manually.
   Lock the renderer, exact-block targeting, accessible control, and styled top-right affordance together. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'frontend/app/chat.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend/css/comms.css'), 'utf8');

function extract(name) {
  const m = new RegExp('(  function ' + name + '\\([\\s\\S]*?\\n  \\})').exec(src);
  A.ok(m, 'chat.js still defines ' + name + '()');
  return m[1];
}

const escSrc = /const HTML_ESC = \{[^}]*\};/.exec(src);
A.ok(escSrc, 'chat.js still defines HTML_ESC');
// eslint-disable-next-line no-new-func
const renderMarkdown = new Function(
  escSrc[0] + '\n' + extract('escapeHtml') + '\n' + extract('linkify') + '\n' +
  extract('mdInline') + '\n' + extract('reportInline') + '\n' + extract('renderFence') + '\n' + extract('renderMarkdown') +
  '\nreturn renderMarkdown;'
)();

const html = renderMarkdown('Before\n```js\nconst one = "<one>";\n```\nBetween\n```\nsecond();\n```\nAfter');
A.eq((html.match(/class="md-pre-wrap"/g) || []).length, 2, 'each fenced section gets its own wrapper');
A.eq((html.match(/class="md-copy"/g) || []).length, 2, 'each fenced section gets its own copy button');
A.eq((html.match(/aria-label="Copy code block"/g) || []).length, 2, 'each block copy control has an accessible name');
A.ok(/<span class="md-pre">const one = &quot;&lt;one&gt;&quot;;<\/span>/.test(html), 'code remains escaped inside its exact block');
A.ok(/<span class="md-pre">second\(\);<\/span>/.test(html), 'neighboring code stays in a separate exact block');
A.ok(!/>js<\/span>/.test(html), 'the fence language marker is not copied as code');

const clickBody = extract('init');
A.ok(/closest\('\.md-copy'\)/.test(clickBody), 'the delegated transcript handler recognizes block copy controls');
A.ok(/closest\('\.md-pre-wrap'\)[\s\S]*?querySelector\('\.md-pre'\)/.test(clickBody), 'a block button resolves text only inside its own wrapper');
A.ok(/copyText\(codeEl\.textContent \|\| ''\)/.test(clickBody), 'the clipboard receives the exact rendered code text');
A.ok(/showCopyResult\(codeBtn, ok\)/.test(clickBody), 'the block reports clipboard success or failure truthfully');

A.ok(/\.md-pre-wrap\s*\{[^}]*position:\s*relative/.test(css), 'the code wrapper anchors its control');
A.ok(/\.md-copy\s*\{[^}]*position:\s*absolute[^}]*top:\s*4px[^}]*right:\s*5px/.test(css), 'the copy button sits at the block top-right');
A.ok(/\.md-copy\.copy-failed/.test(css), 'clipboard failure has a visible state');


const report=renderMarkdown('# Result\n\n| Task | Status |\n|---|---|\n| Save | PASS |\n\n1. Inspect\n   - Keep receipt\n2. Retry\n\n> Incomplete\n\n[Evidence](https://example.com/evidence)');
A.ok(report.includes('<table'), 'report table is semantic');
A.ok(report.includes('<ol') && /<li>Inspect[\s\S]*<ul/.test(report), 'ordered list preserves nested bullet hierarchy');
A.ok(report.includes('<blockquote'), 'quote is semantic');
A.ok(report.includes('>Evidence</a>'), 'named link label is rendered');
const hostile=renderMarkdown('<img src=x onerror=alert(1)>\n[attack](javascript:alert(1))\n`<script>`');
A.ok(!/<img|<script|href="javascript:/.test(hostile), 'untrusted HTML and dangerous protocols stay inert');
A.report('chat-report-structure');
